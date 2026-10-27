//! Trusted optional native package, deliberately separate from script extensions.
//! The compiled catalog pins an immutable archive. No arbitrary executable URLs.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub platform: String,
    pub artifact_url: Option<String>,
    pub artifact_sha256: Option<String>,
    pub inventory_sha256: Option<String>,
    #[serde(default)]
    pub previous_inventories: Vec<PreviousInventory>,
    pub download_bytes: Option<u64>,
    pub max_unpacked_bytes: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviousInventory {
    pub version: String,
    pub inventory_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Inventory {
    pub schema_version: u32,
    pub version: String,
    pub files: Vec<PayloadFile>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PayloadFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn catalog() -> Result<Catalog, String> {
    serde_json::from_str(include_str!("../community-mcp/catalog.json"))
        .map_err(|_| "plugin-catalog-invalid".into())
}
pub(crate) fn available(c: &Catalog) -> bool {
    c.schema_version == 1
        && c.id == "luckyray.official.web-mcp"
        && c.platform == "windows-x86_64"
        && (debug_archive().is_some_and(|p| p.is_file())
            || c.artifact_url.as_deref().is_some_and(|s| {
                s.starts_with("https://github.com/")
                    && s.contains("/releases/download/")
                    && !s.contains("/latest/")
            }))
        && c.inventory_sha256.as_deref().is_some_and(valid_hash)
        && c.artifact_sha256.as_deref().is_some_and(valid_hash)
        && c.download_bytes
            .is_some_and(|n| n > 0 && n <= 256 * 1024 * 1024)
}
fn debug_archive() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("community-mcp/candidate.zip"))
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub(crate) fn safe_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("plugin-path-invalid".into());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        match path.components().next() {
            Some(Component::Prefix(p))
                if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
            _ => return Err("plugin-path-invalid".into()),
        }
    }
    for parent in path.ancestors() {
        match fs::symlink_metadata(parent) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("plugin-linked-path".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("plugin-linked-path".into());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("plugin-path-unavailable".into()),
        }
    }
    Ok(())
}
fn member_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 240
        && !s.contains('\\')
        && !s.contains(':')
        && !s.chars().any(char::is_control)
        && s.split('/').all(|p| {
            let stem = p.split('.').next().unwrap_or("").to_ascii_uppercase();
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.ends_with('.')
                && !p.ends_with(' ')
                && !p.contains(['<', '>', '"', '|', '?', '*'])
                && !matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                )
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
}
pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    safe_path(path)?;
    match fs::metadata(path) {
        Ok(m) if m.is_file() && m.len() <= 1024 * 1024 => {
            serde_json::from_slice(&fs::read(path).map_err(|_| "plugin-state-unavailable")?)
                .map(Some)
                .map_err(|_| "plugin-state-invalid".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => Err("plugin-state-invalid".into()),
    }
}
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    safe_path(path)?;
    let temp = path.with_extension(format!("tmp-{}", format!("{:016x}", rand::random::<u64>())));
    let bytes = serde_json::to_vec(value).map_err(|_| "plugin-state-invalid")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "plugin-state-save-failed")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "plugin-state-save-failed")?;
    fs::rename(&temp, path).map_err(|_| "plugin-state-save-failed".into())
}
pub(crate) fn verify(root: &Path, version: &str) -> Result<(), String> {
    safe_path(root)?;
    let c = catalog()?;
    let inventory_path = root.join("inventory.json");
    safe_path(&inventory_path)?;
    if fs::metadata(&inventory_path)
        .map_err(|_| "plugin-inventory-missing")?
        .len()
        > 1024 * 1024
    {
        return Err("plugin-inventory-invalid".into());
    }
    // Old installed payloads remain verifiable for safe uninstall after a
    // desktop update. Only hashes compiled into this catalog are trusted.
    let expected_inventory = if c.version == version {
        c.inventory_sha256.as_deref()
    } else {
        c.previous_inventories.iter().find(|p| p.version == version)
            .map(|p| p.inventory_sha256.as_str())
    };
    if expected_inventory.is_none()
        || expected_inventory
            != Some(
                hash(&fs::read(&inventory_path).map_err(|_| "plugin-inventory-missing")?).as_str(),
            )
    {
        return Err("plugin-inventory-integrity-failed".into());
    }
    let inventory: Inventory = read_json(&inventory_path)?.ok_or("plugin-inventory-missing")?;
    if inventory.schema_version != 1 || inventory.version != version || inventory.files.len() > 128
    {
        return Err("plugin-inventory-invalid".into());
    }
    for f in &inventory.files {
        if !member_name(&f.path) || !valid_hash(&f.sha256) {
            return Err("plugin-inventory-invalid".into());
        }
        let path = root.join(&f.path);
        safe_path(&path)?;
        if fs::metadata(&path)
            .map_err(|_| "plugin-file-missing")?
            .len()
            != f.bytes
        {
            return Err("plugin-integrity-mismatch".into());
        }
        let bytes = fs::read(&path).map_err(|_| "plugin-file-missing")?;
        if bytes.len() as u64 != f.bytes || hash(&bytes) != f.sha256 {
            return Err("plugin-integrity-mismatch".into());
        }
    }
    for name in [
        "node.exe",
        "tunnel-client-runtime-cloudflared.exe",
        "cloudflared.exe",
        "packages/community-mcp/src/server.mjs",
        "packages/materials-mcp/src/transport.mjs",
        "LICENSES.txt",
    ] {
        if !inventory.files.iter().any(|f| f.path == name) {
            return Err("plugin-payload-incomplete".into());
        }
    }
    Ok(())
}
pub(crate) fn install(root: &Path) -> Result<PathBuf, String> {
    install_from_catalog(root, &catalog()?, debug_archive())
}
fn install_from_catalog(root: &Path, c: &Catalog, local_archive: Option<PathBuf>) -> Result<PathBuf, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("plugin-platform-unsupported".into());
    }
    if !available(c) {
        return Err("plugin-package-unpublished".into());
    }
    if c.version.is_empty()
        || !c
            .version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err("plugin-catalog-invalid".into());
    }
    safe_path(root)?;
    fs::create_dir_all(root).map_err(|_| "plugin-directory-failed")?;
    let final_dir = root.join(&c.version);
    if final_dir.exists() {
        verify(&final_dir, &c.version)?;
        return Ok(final_dir);
    }
    let bytes = if let Some(local) = local_archive.filter(|p| p.is_file()) {
        safe_path(&local)?;
        if fs::metadata(&local)
            .map_err(|_| "plugin-download-failed")?
            .len()
            != c.download_bytes.unwrap()
        {
            return Err("plugin-download-integrity-failed".into());
        }
        fs::read(&local).map_err(|_| "plugin-download-failed")?
    } else {
        crate::assets_import_file::download_with_limits(
            c.artifact_url
                .as_deref()
                .ok_or("plugin-package-unpublished")?,
            &crate::assets_import_file::DownloadLimits {
                max_bytes: c.download_bytes.unwrap(),
                total_timeout: Duration::from_secs(180),
                max_redirects: 4,
            },
        )
        .map_err(|_| "plugin-download-failed")?
    };
    install_bytes(root, c, bytes)
}

fn install_bytes(root: &Path, c: &Catalog, bytes: Vec<u8>) -> Result<PathBuf, String> {
    if Some(bytes.len() as u64) != c.download_bytes || Some(hash(&bytes)) != c.artifact_sha256 {
        return Err("plugin-download-integrity-failed".into());
    }
    safe_path(root)?;
    fs::create_dir_all(root).map_err(|_| "plugin-directory-failed")?;
    let final_dir = root.join(&c.version);
    let stage = root.join(format!(
        ".staging-{}",
        format!("{:016x}", rand::random::<u64>())
    ));
    fs::create_dir(&stage).map_err(|_| "plugin-directory-failed")?;
    let extracted = (|| -> Result<(), String> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|_| "plugin-archive-invalid")?;
        if archive.len() == 0 || archive.len() > 129 {
            return Err("plugin-archive-invalid".into());
        }
        let mut names = std::collections::BTreeSet::new();
        let mut total = 0u64;
        for i in 0..archive.len() {
            let member = archive.by_index(i).map_err(|_| "plugin-archive-invalid")?;
            let name = member.name().to_owned();
            if !member_name(&name)
                || !names.insert(name.to_ascii_lowercase())
                || member.is_dir()
                || member
                    .unix_mode()
                    .is_some_and(|m| m & 0o170000 != 0 && m & 0o170000 != 0o100000)
            {
                return Err("plugin-archive-invalid".into());
            }
            total = total
                .checked_add(member.size())
                .ok_or("plugin-archive-too-large")?;
            if total > c.max_unpacked_bytes {
                return Err("plugin-archive-too-large".into());
            }
            let path = stage.join(&name);
            fs::create_dir_all(path.parent().ok_or("plugin-path-invalid")?)
                .map_err(|_| "plugin-directory-failed")?;
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| "plugin-file-save-failed")?;
            let expected = member.size();
            let copied = std::io::copy(&mut member.take(expected + 1), &mut out)
                .map_err(|_| "plugin-file-save-failed")?;
            if copied != expected {
                return Err("plugin-archive-invalid".into());
            }
            out.sync_all().map_err(|_| "plugin-file-save-failed")?;
        }
        verify(&stage, &c.version)?;
        let inv: Inventory =
            read_json(&stage.join("inventory.json"))?.ok_or("plugin-inventory-missing")?;
        if names.len() != inv.files.len() + 1 {
            return Err("plugin-archive-extra-files".into());
        }
        Ok(())
    })();
    if let Err(e) = extracted {
        let _ = fs::remove_dir_all(&stage);
        return Err(e);
    }
    fs::rename(&stage, &final_dir).map_err(|_| "plugin-install-commit-failed")?;
    Ok(final_dir)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    #[ignore = "Downloads the fixed public package anonymously; bounded distribution acceptance only"]
    fn public_distribution_download_install_and_bad_hash_refusal() {
        let c = catalog().unwrap();
        assert!(c.artifact_url.as_deref().unwrap().contains("/releases/download/mcp-v0.1.3/"));
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("公开下载 中文安装");
        // None is exactly the release source selection: no private debug ZIP.
        let installed = install_from_catalog(&root, &c, None).unwrap();
        verify(&installed, &c.version).unwrap();
        assert_eq!(install_from_catalog(&root, &c, None).unwrap(), installed);
        let bytes = crate::assets_import_file::download_with_limits(
            c.artifact_url.as_deref().unwrap(),
            &crate::assets_import_file::DownloadLimits {
                max_bytes: c.download_bytes.unwrap(),
                total_timeout: Duration::from_secs(180), max_redirects: 4,
            },
        ).unwrap();
        assert_eq!(bytes.len() as u64, c.download_bytes.unwrap());
        assert_eq!(hash(&bytes), c.artifact_sha256.as_deref().unwrap());
        let rejected = temp.path().join("bad-hash");
        let mut wrong = catalog().unwrap();
        wrong.artifact_sha256 = Some("0".repeat(64));
        assert_eq!(install_bytes(&rejected, &wrong, bytes.clone()).unwrap_err(), "plugin-download-integrity-failed");
        assert!(!rejected.exists());
        wrong = catalog().unwrap();
        wrong.download_bytes = Some(bytes.len() as u64 + 1);
        assert_eq!(install_bytes(&rejected, &wrong, bytes).unwrap_err(), "plugin-download-integrity-failed");
        assert!(!rejected.exists());
    }
    #[test]
    #[cfg(windows)]
    fn installer_rejects_tampering_then_accepts_exact_candidate() {
        let archive = debug_archive().unwrap();
        let bytes = fs::read(archive).expect("verified debug candidate.zip");
        let c = catalog().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("中文 插件");
        let mut damaged = bytes.clone();
        let mid = damaged.len() / 2;
        damaged[mid] ^= 1;
        assert_eq!(install_bytes(&root, &c, damaged).unwrap_err(), "plugin-download-integrity-failed");
        assert!(!root.exists(), "bad bytes must not create a staged installation");
        let installed = install_bytes(&root, &c, bytes).unwrap();
        verify(&installed, &c.version).unwrap();
        // An already-installed package is never silently replaced with new bytes.
        assert_eq!(install(&root).unwrap(), installed);
        fs::write(installed.join("packages/community-mcp/src/server.mjs"), b"tampered").unwrap();
        assert_eq!(install(&root).unwrap_err(), "plugin-integrity-mismatch");
    }
    #[test]
    fn archive_paths_cannot_escape() {
        for p in [
            "../x", "a/../b", "/x", "a\\b", "C:x", "a//b", "a.", "a ", "NUL.txt", "a/COM1",
            "CONOUT$", "a?.js",
        ] {
            assert!(!member_name(p), "{p}");
        }
        assert!(member_name("packages/community-mcp/src/server.mjs"));
    }
    #[test]
    #[ignore = "Requires an extracted, verified private candidate package"]
    fn candidate_payload_is_pinned_and_local_inventory_cannot_reauthorize_it() {
        let root = PathBuf::from(std::env::var("LUCKYRAY_MCP_TEST_PAYLOAD").expect("candidate fixture path"));
        let c = catalog().unwrap();
        verify(&root, &c.version).unwrap();
        if let Ok(previous) = std::env::var("LUCKYRAY_MCP_TEST_PREVIOUS_PAYLOAD") {
            let previous = PathBuf::from(previous);
            verify(&previous, "0.1.0-candidate.1").unwrap();
            assert!(verify(&previous, "untrusted-version").is_err());
            assert!(verify(&previous, &c.version).is_err());
        }
        let fake = std::env::temp_dir().join(format!("lr-mcp-forged-{:016x}", rand::random::<u64>()));
        fs::create_dir(&fake).unwrap();
        fs::write(fake.join("inventory.json"), br#"{"schemaVersion":1,"version":"0.1.0-candidate.1","files":[]}"#).unwrap();
        assert!(verify(&fake, &c.version).is_err());
        fs::remove_dir_all(fake).unwrap();
    }
    #[test]
    fn unpublished_catalog_cannot_execute() {
        let mut c = catalog().unwrap();
        c.artifact_url = None;
        c.artifact_sha256 = None;
        assert!(!available(&c));
    }
}
