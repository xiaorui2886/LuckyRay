//! Exact public metadata namespace; upstream artifact policies stay separate.
pub const FEED: &str = "https://raw.githubusercontent.com/xiaorui2886/luckyray-update-metadata/main/catalog/preview/windows-x86_64.json";
const DESCRIPTORS: &str = "https://raw.githubusercontent.com/xiaorui2886/luckyray-update-metadata/main/descriptors/";

pub fn descriptor_url_matches(url: &str, sha256: &str) -> bool {
    sha256.len() == 64 && sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && url == format!("{DESCRIPTORS}{sha256}.json")
}

/// Parse source-reviewed public trust only. Tests exercise approved inputs in
/// memory, never writing a test root into production configuration.
pub fn reviewed_production_key(config: &serde_json::Value, environment: &[&str]) -> Result<Option<String>, &'static str> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};
    let object = config.as_object().ok_or("source-config-object")?;
    let fields: std::collections::BTreeSet<_> = object.keys().map(String::as_str).collect();
    if fields != ["schema", "state", "feedUrl", "publicKey", "fingerprintSha256", "centralReview"].into_iter().collect()
        || config["schema"].as_u64() != Some(1) || config["feedUrl"].as_str() != Some(FEED) {
        return Err("source-config-shape");
    }
    match config["state"].as_str() {
        Some("pending-root-review") => {
            if !config["publicKey"].is_null() || !config["fingerprintSha256"].is_null() || !config["centralReview"].is_null()
                || environment.iter().any(|name| matches!(*name, "LUCKYRAY_DSH_UPDATE_FEED" | "LUCKYRAY_DSH_UPDATE_PUBLIC_KEY")) {
                return Err("pending-source-cannot-authorize-root");
            }
            Ok(None)
        }
        Some("approved-production") => {
            if !environment.is_empty() { return Err("production-source-cannot-mix-environment-trust"); }
            let key = config["publicKey"].as_str().ok_or("source-public-key")?;
            let raw = URL_SAFE_NO_PAD.decode(key).map_err(|_| "source-public-key")?;
            if raw.len() != 32 || URL_SAFE_NO_PAD.encode(&raw) != key
                || config["fingerprintSha256"].as_str() != Some(format!("{:x}", Sha256::digest(&raw)).as_str()) {
                return Err("source-public-key-fingerprint");
            }
            let review = config["centralReview"].as_str().ok_or("source-review")?;
            let number = review.strip_prefix("https://github.com/xiaorui2886/LuckyRay/blob/main/docs/development/lsh-trust.md#review-").ok_or("source-review")?;
            if number.is_empty() || number.len() > 20 || !number.bytes().all(|c| c.is_ascii_digit()) { return Err("source-review"); }
            Ok(Some(key.to_owned()))
        }
        _ => Err("source-state"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_namespace_is_exact_and_content_addressed() {
        let hash = "a".repeat(64);
        let good = format!("{DESCRIPTORS}{hash}.json");
        assert!(descriptor_url_matches(&good, &hash));
        for wrong in [good.replace("/xiaorui2886/", "/other/"), good.replace("/main/", "/develop/"),
            good.replace("luckyray-update-metadata", "luckyray-app"), format!("{good}?token=x"),
            format!("{good}#x"), good.replace("https:", "http:"), good.replace("/descriptors/", "/descriptors/../"),
            good.replace("raw.githubusercontent.com", "raw.githubusercontent.com.evil.example"),
            good.replace("https://", "https://user:pass@"), good.replace("/main/", "/%6dain/")] {
            assert!(!descriptor_url_matches(&wrong, &hash));
        }
        assert!(!descriptor_url_matches(&good, &"b".repeat(64)));
        assert!(!descriptor_url_matches(&good, &"A".repeat(64)));
    }

    #[test]
    fn pending_source_never_invents_a_production_root() {
        let mut config = serde_json::json!({"schema":1,"state":"pending-root-review","feedUrl":FEED,
            "publicKey":null,"fingerprintSha256":null,"centralReview":null});
        assert_eq!(reviewed_production_key(&config, &[]), Ok(None));
        assert_eq!(reviewed_production_key(&config, &["LUCKYRAY_DEV_DSH_UPDATE_FEED"]), Ok(None));
        assert!(reviewed_production_key(&config, &["LUCKYRAY_DSH_UPDATE_FEED"]).is_err());
        config["publicKey"] = "not-a-reviewed-key".into();
        assert!(reviewed_production_key(&config, &[]).is_err());
    }

    #[test]
    fn approved_source_requires_exact_public_root_review_and_no_overrides() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        use sha2::{Digest, Sha256};
        // Parser input only: no private key, persisted config or compiled trust.
        let raw = [7_u8; 32];
        let config = serde_json::json!({"schema":1,"state":"approved-production","feedUrl":FEED,
            "publicKey":URL_SAFE_NO_PAD.encode(raw),"fingerprintSha256":format!("{:x}",Sha256::digest(raw)),
            "centralReview":"https://github.com/xiaorui2886/LuckyRay/blob/main/docs/development/lsh-trust.md#review-20261016"});
        assert_eq!(reviewed_production_key(&config, &[]), Ok(config["publicKey"].as_str().map(str::to_owned)));
        for name in ["LUCKYRAY_DSH_UPDATE_FEED", "LUCKYRAY_DSH_UPDATE_PUBLIC_KEY", "LUCKYRAY_DEV_DSH_UPDATE_FEED",
            "LUCKYRAY_DEV_DSH_UPDATE_PUBLIC_KEY", "LUCKYRAY_DEV_DSH_UPDATE_CA_PEM"] {
            assert!(reviewed_production_key(&config, &[name]).is_err());
        }
        for (field, wrong) in [("schema",serde_json::json!(2)), ("state",serde_json::json!("ready")),
            ("publicKey",serde_json::json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB")),
            ("fingerprintSha256",serde_json::json!("0".repeat(64))), ("feedUrl",serde_json::json!(FEED.replace("/main/", "/other/"))),
            ("centralReview",serde_json::json!("https://github.com/other/repo/issues/195#issuecomment-123")),
            ("centralReview",serde_json::json!("https://github.com/xiaorui2886/LuckyRay/blob/main/docs/development/lsh-trust.md#review-20261016?x=y")),
            ("extra",serde_json::json!("ignored"))] {
            let mut changed = config.clone(); changed[field] = wrong;
            assert!(reviewed_production_key(&changed, &[]).is_err(), "{field}");
        }
    }
}
