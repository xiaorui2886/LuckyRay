//! Artifact authenticity and signed version binding, independent of renderer/installer.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use semver::Version;

pub(crate) const MAX_PACKAGE_BYTES: usize = 1024 * 1024 * 1024;
pub(crate) fn stable_version(value: &str) -> Result<Version, &'static str> {
    let version = Version::parse(value).map_err(|_| "update-version-invalid")?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != value {
        return Err("update-version-invalid");
    }
    Ok(version)
}
pub(crate) fn admit_version(installed: &str, candidate: &str) -> Result<(), &'static str> {
    let current = Version::parse(installed).map_err(|_| "update-installed-version-invalid")?;
    if stable_version(candidate)? <= current {
        return Err("update-version-not-newer");
    }
    Ok(())
}
pub(crate) fn official_artifact(version: &str, url: &str) -> Result<(), &'static str> {
    stable_version(version)?;
    let expected=format!("https://github.com/xiaorui2886/LuckyRay/releases/download/v{version}/LuckyRay_{version}_x64-setup.exe");
    if url != expected {
        return Err("update-artifact-url-invalid");
    }
    Ok(())
}
fn decode(value: &str) -> Result<String, &'static str> {
    if value.len() > 16384 {
        return Err("update-signature-invalid");
    }
    let bytes = STANDARD
        .decode(value.trim())
        .map_err(|_| "update-signature-invalid")?;
    String::from_utf8(bytes).map_err(|_| "update-signature-invalid")
}
pub(crate) fn verify_package(
    bytes: &[u8],
    signature: &str,
    public_key: &str,
    version: &str,
) -> Result<(), &'static str> {
    stable_version(version)?;
    if bytes.is_empty() || bytes.len() > MAX_PACKAGE_BYTES {
        return Err("update-package-size-invalid");
    }
    let key = PublicKey::decode(&decode(public_key)?).map_err(|_| "update-trust-invalid")?;
    let signature =
        Signature::decode(&decode(signature)?).map_err(|_| "update-signature-invalid")?;
    // The library checks both the artifact and the global signature covering
    // the trusted comment. Never read version metadata as trusted beforehand.
    key.verify(bytes, &signature, true)
        .map_err(|_| "update-signature-invalid")?;
    let fields: Vec<_> = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|p| p.strip_prefix("file:"))
        .collect();
    if fields.len() != 1 {
        return Err("update-signed-version-invalid");
    }
    // Official Tauri CLI 2.11.2 signs timestamp + file in the trusted comment.
    // Binding the complete canonical filename binds version and platform without a custom signer.
    if fields[0] != format!("LuckyRay_{version}_x64-setup.exe") {
        return Err("update-signed-version-mismatch");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_downgrade_equal_and_preview() {
        for v in ["1.0.0", "0.9.0", "1.1.0-rc.1", "01.2.3", "1.2.3+build"] {
            assert!(admit_version("1.0.0", v).is_err());
        }
        assert!(admit_version("1.0.0", "1.0.1").is_ok());
    }
    #[test]
    fn canonical_official_asset_only() {
        let good="https://github.com/xiaorui2886/LuckyRay/releases/download/v1.0.1/LuckyRay_1.0.1_x64-setup.exe";
        assert!(official_artifact("1.0.1", good).is_ok());
        for bad in [
            format!("{good}?token=x"),
            good.replace("https:", "http:"),
            good.replace("LuckyRay/releases", "another/releases"),
            good.replace("x64", "arm64"),
            good.replace("github.com", "github.com.evil.example"),
        ] {
            assert!(official_artifact("1.0.1", &bad).is_err());
        }
    }
    #[test]
    fn absent_or_malformed_trust_never_verifies() {
        assert!(verify_package(b"exe", "", "", "1.0.1").is_err());
        assert!(verify_package(b"", "AAAA", "AAAA", "1.0.1").is_err());
        assert!(verify_package(b"exe", &"A".repeat(16385), "AAAA", "1.0.1").is_err());
    }
}
