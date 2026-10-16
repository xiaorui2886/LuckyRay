use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const PRIVATE_RELEASE_CHANNEL: &str = "private-release-v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalReleaseOrigins {
    pub origins: Vec<String>,
    pub config_sha256: String,
    pub manifest_public_key_sha256: String,
    pub extension_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginSource {
    CanonicalPrivateRelease,
    ExplicitOverride,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectiveReleaseOrigins {
    pub origins: Vec<String>,
    pub source: OriginSource,
    pub origin_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseOriginsConfig {
    #[serde(rename = "schemaVersion")]
    schema_version: u64,
    channel: String,
    origins: Vec<String>,
    #[serde(rename = "publicKeySha256")]
    public_key_sha256: String,
}

#[derive(Deserialize)]
struct ExtensionManifestPublicKey {
    key: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_lower_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn chromium_extension_id(subject_public_key_info: &[u8]) -> String {
    const ALPHABET: &[u8; 16] = b"abcdefghijklmnop";
    let digest = Sha256::digest(subject_public_key_info);
    let mut id = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        id.push(ALPHABET[(byte >> 4) as usize] as char);
        id.push(ALPHABET[(byte & 0x0f) as usize] as char);
    }
    id
}

fn canonical_extension_origin(value: &str) -> Result<String, String> {
    if value.trim() != value || value != value.to_ascii_lowercase() {
        return Err("release-extension-origin-invalid".to_string());
    }
    let origin = value.strip_suffix('/').unwrap_or(value);
    let id = origin
        .strip_prefix("chrome-extension://")
        .ok_or_else(|| "release-extension-origin-invalid".to_string())?;
    if id.len() != 32 || !id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)) {
        return Err("release-extension-origin-invalid".to_string());
    }
    Ok(origin.to_string())
}

pub fn canonicalize_extension_origins(value: &str) -> Result<Vec<String>, String> {
    if value.is_empty() {
        return Err("release-extension-origin-empty".to_string());
    }
    let mut origins = value
        .split(',')
        .map(canonical_extension_origin)
        .collect::<Result<Vec<_>, _>>()?;
    origins.sort();
    if origins.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("release-extension-origin-duplicate".to_string());
    }
    Ok(origins)
}

fn config_origins(items: &[String]) -> Result<Vec<String>, String> {
    if items.is_empty() {
        return Err("release-extension-origin-empty".to_string());
    }
    let raw = items.iter().map(String::as_str).collect::<Vec<_>>();
    let joined = raw.join(",");
    let canonical = canonicalize_extension_origins(&joined)?;
    if raw
        .iter()
        .zip(canonical.iter())
        .any(|(raw, canonical)| *raw != canonical)
        || raw.len() != canonical.len()
    {
        return Err("release-extension-origins-noncanonical".to_string());
    }
    Ok(canonical)
}

fn manifest_public_key(manifest_path: &Path) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(manifest_path)
        .map_err(|_| "release-extension-manifest-unavailable".to_string())?;
    let manifest: ExtensionManifestPublicKey = serde_json::from_slice(&bytes)
        .map_err(|_| "release-extension-manifest-invalid".to_string())?;
    let decoded = STANDARD
        .decode(&manifest.key)
        .map_err(|_| "release-extension-manifest-key-invalid".to_string())?;
    if decoded.len() < 128 || STANDARD.encode(&decoded) != manifest.key {
        return Err("release-extension-manifest-key-invalid".to_string());
    }
    Ok(decoded)
}

pub fn load_canonical_release_origins(
    config_path: &Path,
    manifest_path: &Path,
) -> Result<CanonicalReleaseOrigins, String> {
    let raw = std::fs::read(config_path)
        .map_err(|_| "release-extension-origins-config-unavailable".to_string())?;
    let config: ReleaseOriginsConfig = serde_json::from_slice(&raw)
        .map_err(|_| "release-extension-origins-config-invalid".to_string())?;
    if config.schema_version != 1 || config.channel != PRIVATE_RELEASE_CHANNEL {
        return Err("release-extension-origins-schema-invalid".to_string());
    }
    if !is_lower_hex(&config.public_key_sha256) {
        return Err("release-extension-origins-schema-invalid".to_string());
    }
    let origins = config_origins(&config.origins)?;
    let public_key = manifest_public_key(manifest_path)?;
    let manifest_public_key_sha256 = sha256_hex(&public_key);
    if config.public_key_sha256 != manifest_public_key_sha256 {
        return Err("release-extension-origins-manifest-mismatch".to_string());
    }
    let extension_id = chromium_extension_id(&public_key);
    let expected_origin = format!("chrome-extension://{extension_id}");
    if origins.as_slice() != [expected_origin] {
        return Err("release-extension-origins-manifest-mismatch".to_string());
    }
    Ok(CanonicalReleaseOrigins {
        origins,
        config_sha256: sha256_hex(&raw),
        manifest_public_key_sha256,
        extension_id,
    })
}

pub fn resolve_release_origins(
    canonical: &CanonicalReleaseOrigins,
    explicit_override: Option<&str>,
) -> Result<EffectiveReleaseOrigins, String> {
    let (origins, source) = match explicit_override {
        Some(value) => (
            canonicalize_extension_origins(value)?,
            OriginSource::ExplicitOverride,
        ),
        None => (
            canonical.origins.clone(),
            OriginSource::CanonicalPrivateRelease,
        ),
    };
    let mut fingerprint_input = Vec::new();
    for origin in &origins {
        fingerprint_input.extend_from_slice(origin.as_bytes());
        fingerprint_input.push(0);
    }
    Ok(EffectiveReleaseOrigins {
        origins,
        source,
        origin_fingerprint: sha256_hex(&fingerprint_input),
    })
}
