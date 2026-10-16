//! Public stable-channel manifest. The document itself never authorizes execution.
use super::verification::{admit_version, official_artifact};
use serde::Deserialize;
pub(crate) const MANIFEST: &str =
    "https://github.com/xiaorui2886/LuckyRay/releases/latest/download/latest.json";
pub(crate) const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Deserialize)]
pub(crate) struct Candidate {
    pub version: String,
    pub url: String,
    pub signature: String,
}
/// Both startup installation and an explicit immediate restart require the
/// currently published release to still identify the exact verified bytes.
pub(crate) fn confirm_release(
    expected: &Candidate,
    fresh: Result<Option<Candidate>, &'static str>,
) -> Result<(), &'static str> {
    let current = fresh?.ok_or("update-release-no-longer-available")?;
    if current.version != expected.version || current.url != expected.url
        || current.signature != expected.signature {
        return Err("update-release-changed");
    }
    Ok(())
}
#[derive(Deserialize)]
struct Platform {
    url: String,
    signature: String,
}
#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: std::collections::BTreeMap<String, Platform>,
}
pub(crate) fn parse(bytes: &[u8], installed: &str) -> Result<Option<Candidate>, &'static str> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("update-manifest-too-large");
    }
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| "update-manifest-invalid")?;
    let current = super::verification::stable_version(installed)?;
    let version = super::verification::stable_version(&manifest.version)?;
    if version <= current {
        return Ok(None);
    }
    admit_version(installed, &manifest.version)?;
    let platform = manifest
        .platforms
        .get("windows-x86_64-nsis")
        .ok_or("update-platform-unavailable")?;
    official_artifact(&manifest.version, &platform.url)?;
    if platform.signature.is_empty() || platform.signature.len() > 16384 {
        return Err("update-signature-invalid");
    }
    Ok(Some(Candidate {
        version: manifest.version,
        url: platform.url.clone(),
        signature: platform.signature.clone(),
    }))
}
pub(crate) async fn fetch(
    url: &str,
    limit: usize,
    timeout: std::time::Duration,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(u64, Option<u64>) -> Result<(), &'static str>,
) -> Result<Vec<u8>, &'static str> {
    let admitted = |u: &reqwest::Url| {
        u.scheme() == "https"
            && u.port_or_known_default() == Some(443)
            && u.username().is_empty()
            && u.password().is_none()
            && matches!(
                u.host_str(),
                Some(
                    "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            )
    };
    if !admitted(&reqwest::Url::parse(url).map_err(|_| "update-url-invalid")?) {
        return Err("update-url-invalid");
    }
    let network = async {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("update-redirect-limit");
                }
                let u = attempt.url();
                let host = u.host_str().unwrap_or("");
                if u.scheme() != "https"
                    || u.port_or_known_default() != Some(443)
                    || !u.username().is_empty()
                    || u.password().is_some()
                    || !(host == "github.com"
                        || host == "release-assets.githubusercontent.com"
                        || host == "objects.githubusercontent.com")
                {
                    return attempt.error("update-redirect-denied");
                }
                attempt.follow()
            }))
            .build()
            .map_err(|_| "update-network-failed")?;
        let mut response = client
            .get(url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|_| "update-network-failed")?;
        let total = response.content_length();
        if total.is_some_and(|n| n > limit as u64) {
            return Err("update-download-too-large");
        }
        progress(0, total)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "update-network-failed")?
        {
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|size| size > limit)
            {
                return Err("update-download-too-large");
            }
            progress(chunk.len() as u64, total)?;
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() || total.is_some_and(|n| n != bytes.len() as u64) {
            return Err("update-download-length-mismatch");
        }
        Ok(bytes)
    };
    let cancellation = async {
        loop {
            if cancelled() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    };
    match futures_util::future::select(Box::pin(network), Box::pin(cancellation)).await {
        futures_util::future::Either::Left((result, _)) => result,
        futures_util::future::Either::Right(_) => Err("update-cancelled"),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn planned_release_requires_a_fresh_exact_match() {
        let expected = Candidate { version: "2.0.0".into(), url: "https://github.com/xiaorui2886/LuckyRay/releases/download/v2.0.0/LuckyRay_2.0.0_x64-setup.exe".into(), signature: "verified-original".into() };
        assert_eq!(confirm_release(&expected, Err("update-network-failed")), Err("update-network-failed"));
        assert_eq!(confirm_release(&expected, Ok(None)), Err("update-release-no-longer-available"));
        for changed in [
            Candidate { version: "2.0.1".into(), ..expected.clone() },
            Candidate { url: "https://github.com/xiaorui2886/LuckyRay/releases/download/v2.0.0/other.exe".into(), ..expected.clone() },
            Candidate { signature: "replacement-signature".into(), ..expected.clone() },
        ] {
            assert_eq!(confirm_release(&expected, Ok(Some(changed))), Err("update-release-changed"));
        }
        assert_eq!(confirm_release(&expected, Ok(Some(expected.clone()))), Ok(()));
    }
    fn fixture(version: &str, url: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"version":version,"platforms":{"windows-x86_64-nsis":{"url":url,"signature":"fixture"}}})).unwrap()
    }
    #[test]
    fn exact_stable_channel() {
        let url="https://github.com/xiaorui2886/LuckyRay/releases/download/v2.0.0/LuckyRay_2.0.0_x64-setup.exe";
        assert!(parse(&fixture("2.0.0", url), "1.0.0").unwrap().is_some());
        assert!(parse(&fixture("2.0.0", url), "2.0.0").unwrap().is_none());
        assert!(parse(&fixture("2.0.0", url), "3.0.0").unwrap().is_none());
        assert!(parse(&fixture("2.0.0-rc.1", url), "1.0.0").is_err());
        assert!(parse(&fixture("2.0.0", "https://example.com/app.exe"), "1.0.0").is_err());
    }
    #[test]
    fn malformed_or_wrong_platform_never_available() {
        for bytes in [
            b"not json".to_vec(),
            br#"{"version":"2.0.0","platforms":{}}"#.to_vec(),
            vec![b' '; MAX_MANIFEST_BYTES + 1],
        ] {
            assert!(parse(&bytes, "1.0.0").is_err());
        }
    }
}
