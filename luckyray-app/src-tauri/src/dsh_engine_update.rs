//! Admission for independently distributed DSH runtimes. The desktop updater
//! cannot authorize engine code: it installs the Electron application, not a
//! LuckyRay-compatible runtime closure. Public discovery never authorizes code;
//! artifact download requires a signature and a verified host contract.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::signature::{UnparsedPublicKey, ED25519};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_ENVELOPE_BYTES: usize = 96 * 1024;
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 1024 * 1024 * 1024;
const PLATFORM: &str = "windows-x86_64";
const CHANNEL: &str = "preview";

mod coordinator;
mod transaction;
mod upstream;
mod assembly;
mod compatibility;
#[path = "dsh_update_metadata_policy.rs"]
mod metadata_policy;
pub(crate) use coordinator::{DshEngineUpdater, EngineUpdateStatus};
pub(crate) use transaction::UpdateStore;

/// Redacted stage timings are useful on slow disks without reading user data.
pub(crate) struct StageTiming {
    stage: &'static str,
    started: std::time::Instant,
}
impl StageTiming {
    pub(crate) fn new(stage: &'static str) -> Self { Self { stage, started: std::time::Instant::now() } }
}
impl Drop for StageTiming {
    fn drop(&mut self) {
        eprintln!("dsh-stage {} duration_ms={}", self.stage, self.started.elapsed().as_millis());
    }
}

pub(crate) const SWITCH_ERROR_FILE: &str = "last-switch-error.json";

/// Minimal, redacted record of a failed startup switch completion: only the
/// failure stage and error category are stored, never paths or profile data.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchErrorRecord {
    pub(crate) schema: u8,
    pub(crate) stage: String,
    pub(crate) error_category: String,
    pub(crate) recorded_at_unix: u64,
}

fn switch_error_category(error: &transaction::StoreError) -> &'static str {
    match error {
        transaction::StoreError::Invalid => "invalid",
        transaction::StoreError::Io => "io",
        transaction::StoreError::RecoveryRequired => "recovery-required",
    }
}

/// Best effort: a failed switch must not silently kill host construction
/// again. The category alone lets the settings surface name the failing
/// stage without persisting any user path or content.
pub(crate) fn record_switch_error(app_data: &Path, error: &transaction::StoreError) {
    let record = SwitchErrorRecord {
        schema: 1,
        stage: "complete-pending-switch".to_owned(),
        error_category: switch_error_category(error).to_owned(),
        recorded_at_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
    };
    let Ok(bytes) = serde_json::to_vec(&record) else { return };
    let root = app_data.join("dsh-engine-updates");
    if fs::create_dir_all(&root).is_err() {
        return;
    }
    let temp = root.join(format!(".switch-error-{:032x}.tmp", rand::random::<u128>()));
    if fs::write(&temp, &bytes)
        .and_then(|()| fs::rename(&temp, root.join(SWITCH_ERROR_FILE)))
        .is_err()
    {
        let _ = fs::remove_file(&temp);
    }
}

pub(crate) fn read_switch_error(app_data: &Path) -> Option<SwitchErrorRecord> {
    let raw = fs::read(app_data.join("dsh-engine-updates").join(SWITCH_ERROR_FILE)).ok()?;
    let record: SwitchErrorRecord = serde_json::from_slice(&raw).ok()?;
    (record.schema == 1).then_some(record)
}

pub(crate) fn clear_switch_error(app_data: &Path) {
    let _ = fs::remove_file(app_data.join("dsh-engine-updates").join(SWITCH_ERROR_FILE));
}

#[derive(Clone, Debug)]
pub(crate) struct TrustedSource {
    pub(crate) feed_url: String,
    pub(crate) public_key: [u8; 32],
    pub(crate) trust_class: &'static str,
}

/// The key is compiled into the desktop build; the client never accepts a
/// key from AppData, a catalog response, or a user-editable setting.
pub(crate) fn trusted_source_for_this_build() -> Result<TrustedSource, AdmissionError> {
    let trust_class = env!("LUCKYRAY_DSH_UPDATE_TRUST_CLASS");
    if trust_class == "unconfigured" {
        return Err(AdmissionError::Unconfigured);
    }
    let feed_url = option_env!("LUCKYRAY_DSH_UPDATE_FEED")
        .ok_or(AdmissionError::Unconfigured)?
        .to_owned();
    let parsed = reqwest::Url::parse(&feed_url).map_err(|_| AdmissionError::Unconfigured)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(AdmissionError::Unconfigured);
    }
    let encoded_key =
        option_env!("LUCKYRAY_DSH_UPDATE_PUBLIC_KEY").ok_or(AdmissionError::Unconfigured)?;
    let raw = URL_SAFE_NO_PAD
        .decode(encoded_key)
        .map_err(|_| AdmissionError::Unconfigured)?;
    let public_key: [u8; 32] = raw.try_into().map_err(|_| AdmissionError::Unconfigured)?;
    if trust_class == "production" && feed_url != metadata_policy::FEED {
        return Err(AdmissionError::Unconfigured);
    }
    Ok(TrustedSource {
        feed_url,
        public_key,
        trust_class,
    })
}

fn update_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, ()> {
    let mut builder = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(timeout_secs));
    // Only an isolated development build can embed a loopback CA. Release
    // builds reject this environment variable in build.rs and always use the
    // ordinary system trust roots; certificate validation is never disabled.
    if env!("LUCKYRAY_DSH_UPDATE_TRUST_CLASS") == "development" {
        if let Some(encoded) = option_env!("LUCKYRAY_DSH_UPDATE_DEV_CA_B64") {
            let pem = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| ())?;
            let certificate = reqwest::Certificate::from_pem(&pem).map_err(|_| ())?;
            builder = builder.add_root_certificate(certificate);
        }
    }
    builder.build().map_err(|_| ())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CatalogError {
    Unconfigured,
    Network,
    Untrusted,
    NotAnUpgrade,
    RequiresHost,
    LegacyContract,
    NoCandidate,
    UpgradePath,
    UpstreamIdentity,
}

/// Read one bounded HTTPS catalog from the pinned build source, with no
/// redirects and no fallback to npm/GitHub latest. The signature is checked
/// before any candidate URL is trusted or downloaded.
pub(crate) fn check_catalog(
    current_version: &str,
    now_unix: i64,
) -> Result<AdmittedCandidate, CatalogError> {
    let source = trusted_source_for_this_build().map_err(|_| CatalogError::Unconfigured)?;
    let client = update_client(15).map_err(|_| CatalogError::Network)?;
    check_catalog_with_source(&source, &client, current_version, now_unix)
}

fn check_catalog_with_source(source: &TrustedSource, client: &reqwest::blocking::Client,
    current_version: &str, now_unix: i64) -> Result<AdmittedCandidate, CatalogError> {
    let response = client
        .get(&source.feed_url)
        .send()
        .map_err(|_| CatalogError::Network)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(CatalogError::NoCandidate);
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_ENVELOPE_BYTES as u64)
    {
        return Err(CatalogError::Network);
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_ENVELOPE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| CatalogError::Network)?;
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(CatalogError::Untrusted);
    }
    // Authenticate catalog before using its cross-origin identity. The
    // development fixture retains its existing single-origin semantics.
    let catalog = verify_signed_candidate(&bytes, Some(&source.public_key), Some(&source.feed_url),
        env!("CARGO_PKG_VERSION"), true, env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"),
        env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"))
        .map_err(catalog_admission_error)?;
    if source.trust_class != "development" {
        if catalog.assembly.is_none() && catalog.upstream.is_none() { return Err(CatalogError::UpstreamIdentity); }
        if catalog.assembly.is_none() { upstream::resolve_asset(&catalog).map_err(|error| match error {
            upstream::DiscoveryError::Network => CatalogError::Network,
            upstream::DiscoveryError::Identity => CatalogError::UpstreamIdentity,
        })?; }
    }
    admit_with_source(&source, &bytes, current_version, now_unix).map_err(catalog_admission_error)
}

fn admit_with_source(source: &TrustedSource, bytes: &[u8], current_version: &str,
    now_unix: i64) -> Result<AdmittedCandidate, AdmissionError> {
    admit_with_contract(bytes, Some(&source.public_key), Some(&source.feed_url), current_version,
        env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"), env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"), now_unix)
        .map(|candidate| AdmittedCandidate { candidate, signed_envelope: bytes.to_vec() })
}

fn catalog_admission_error(error: AdmissionError) -> CatalogError {
    match error {
        AdmissionError::Unconfigured => CatalogError::Unconfigured,
        AdmissionError::NotAnUpgrade => CatalogError::NotAnUpgrade,
        AdmissionError::RequiresHost => CatalogError::RequiresHost,
        AdmissionError::LegacyContract => CatalogError::LegacyContract,
        AdmissionError::NotFromCurrent => CatalogError::UpgradePath,
        _ => CatalogError::Untrusted,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedEnvelope {
    payload: String,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Candidate {
    pub(crate) schema: u8,
    pub(crate) channel: String,
    pub(crate) runtime_package: String,
    pub(crate) issued_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) host_version: String,
    pub(crate) adapter_fingerprint: String,
    pub(crate) platform: String,
    pub(crate) from_versions: Vec<String>,
    pub(crate) version: String,
    pub(crate) node_sha256: String,
    pub(crate) entry_sha256: String,
    pub(crate) artifact_url: String,
    pub(crate) artifact_sha256: String,
    pub(crate) artifact_bytes: u64,
    pub(crate) closure_sha256: String,
    pub(crate) closure_file_count: u32,
    pub(crate) data_compatibility: String,
    pub(crate) resource_gate_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) compatibility: Option<compatibility::Compatibility>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) upstream: Option<upstream::OfficialAssetIdentity>,
    /// The artifact fields bind the bounded metadata description, not a ZIP.
    /// Absent keeps existing signed installed/ZIP envelopes unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) assembly: Option<assembly::FrozenAssemblyIdentity>,
}

/// Only a verified catalog can construct this token. Download and staging
/// must not accept a caller-assembled Candidate or editable local JSON.
pub(crate) struct AdmittedCandidate {
    candidate: Candidate,
    signed_envelope: Vec<u8>,
}

impl AdmittedCandidate {
    pub(crate) fn version(&self) -> &str {
        &self.candidate.version
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AdmissionError {
    Unconfigured,
    InvalidSignature,
    InvalidManifest,
    Expired,
    WrongChannel,
    WrongPlatform,
    RequiresHost,
    LegacyContract,
    NotAnUpgrade,
    NotFromCurrent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactError {
    Invalid,
    Io,
    WorkerPending,
}

fn artifact_path(root: &Path, name: &str) -> Result<PathBuf, ArtifactError> {
    if name.is_empty()
        || name.len() > 1024
        || !name.is_ascii()
        || name.contains('\\')
        || name.contains(':')
        || name.bytes().any(|b| b < 0x20 || b == 0x7f)
    {
        return Err(ArtifactError::Invalid);
    }
    let mut path = root.to_path_buf();
    for component in name.trim_end_matches('/').split('/') {
        let stem = component.split('.').next().unwrap_or("");
        let reserved = matches!(
            stem.to_ascii_uppercase().as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        );
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with('.')
            || component.ends_with(' ')
            || reserved
            || component
                .chars()
                .any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return Err(ArtifactError::Invalid);
        }
        path.push(component);
    }
    Ok(path)
}

fn digest_file(path: &Path) -> Result<String, ArtifactError> {
    let mut file = File::open(path).map_err(|_| ArtifactError::Io)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| ArtifactError::Io)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn verify_package_identity(root: &Path, candidate: &Candidate) -> Result<(), ArtifactError> {
    let package = root.join("host/node_modules/@deepseek-ai/dsh/package.json");
    let metadata = safe_runtime_entry(&package)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(ArtifactError::Invalid);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(package).map_err(|_| ArtifactError::Io)?)
            .map_err(|_| ArtifactError::Invalid)?;
    if value.get("name").and_then(|v| v.as_str()) != Some(candidate.runtime_package.as_str())
        || value.get("version").and_then(|v| v.as_str()) != Some(candidate.version.as_str())
    {
        return Err(ArtifactError::Invalid);
    }
    Ok(())
}

/// Download only a previously signed HTTPS URL. Legacy sources cannot redirect;
/// exact official assets may redirect only to the public asset host allowlist.
pub(crate) fn download_artifact(
    admitted: &AdmittedCandidate,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), ArtifactError> {
    download_artifact_with_progress(admitted, output, cancel, &mut |_, _| {})
}

pub(crate) fn download_artifact_with_progress(
    admitted: &AdmittedCandidate,
    output: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), ArtifactError> {
    if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
    tauri::async_runtime::block_on(async {
        download_artifact_async(admitted, output, cancel, progress).await
    })
}

async fn download_artifact_async(
    admitted: &AdmittedCandidate,
    output: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), ArtifactError> {
    let client = artifact_client()?;
    download_artifact_with_client(&client, admitted, output, cancel, progress).await
}

async fn download_artifact_with_client(client: &reqwest::Client, admitted: &AdmittedCandidate,
    output: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<(), ArtifactError> {
    let candidate = &admitted.candidate;
    upstream::require_resolved(candidate, &client, cancel).await?;
    download_exact_async(&client, &candidate.artifact_url, candidate.artifact_bytes,
        &candidate.artifact_sha256, candidate.upstream.is_some(), output, cancel, progress).await
}

fn artifact_client() -> Result<reqwest::Client, ArtifactError> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(30));
    if env!("LUCKYRAY_DSH_UPDATE_TRUST_CLASS") == "development" {
        if let Some(encoded) = option_env!("LUCKYRAY_DSH_UPDATE_DEV_CA_B64") {
            let pem = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| ArtifactError::Io)?;
            builder = builder.add_root_certificate(reqwest::Certificate::from_pem(&pem).map_err(|_| ArtifactError::Io)?);
        }
    }
    builder.build().map_err(|_| ArtifactError::Io)
}

/// Shared bounded/cancellable byte acquisition. Assembly callers can only
/// supply a fixed bootstrap URL or a validated frozen npm input; no redirects.
async fn download_exact_async(
    client: &reqwest::Client, initial_url: &str, expected_bytes: u64, expected_sha256: &str,
    official_asset_redirects: bool, output: &Path, cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), ArtifactError> {
    if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
    let mut url = reqwest::Url::parse(initial_url).map_err(|_| ArtifactError::Invalid)?;
    let mut redirects = 0;
    let mut response = loop {
        // This client never has any Authorization/cookies. Redirects are
        // manual and only admitted official Release assets may use them.
        let send = client.get(url.clone()).send();
        tokio::pin!(send);
        let response = loop {
            tokio::select! {
                result = &mut send => break result.map_err(|_| ArtifactError::Io)?,
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                    if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
                }
            }
        };
        if !response.status().is_redirection() { break response; }
        if !official_asset_redirects || redirects >= 3 { return Err(ArtifactError::Invalid); }
        let location = response.headers().get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok()).ok_or(ArtifactError::Invalid)?;
        let next = url.join(location).map_err(|_| ArtifactError::Invalid)?;
        if !upstream::redirect_allowed(&next) { return Err(ArtifactError::Invalid); }
        url = next;
        redirects += 1;
    };
    if !response.status().is_success() {
        return Err(ArtifactError::Invalid);
    }
    if response
        .content_length()
        .is_some_and(|len| len != expected_bytes)
    {
        return Err(ArtifactError::Invalid);
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|_| ArtifactError::Io)?;
    let mut digest = Sha256::new();
    let mut count = 0u64;
    progress(0, expected_bytes);
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(ArtifactError::Io);
        }
        let chunk = tokio::select! {
            result = response.chunk() => result.map_err(|_| ArtifactError::Io)?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
                continue;
            }
        };
        let Some(chunk) = chunk else { break; };
        let size = chunk.len();
        count = count
            .checked_add(size as u64)
            .ok_or(ArtifactError::Invalid)?;
        if count > expected_bytes {
            return Err(ArtifactError::Invalid);
        }
        digest.update(&chunk);
        file.write_all(&chunk)
            .map_err(|_| ArtifactError::Io)?;
        progress(count, expected_bytes);
    }
    file.sync_all().map_err(|_| ArtifactError::Io)?;
    if cancel.load(Ordering::Acquire) {
        return Err(ArtifactError::Io);
    }
    if count != expected_bytes
        || format!("{:x}", digest.finalize()) != expected_sha256
    {
        return Err(ArtifactError::Invalid);
    }
    Ok(())
}

/// Materialize one signed, link-free runtime closure in a *new* private
/// directory. The closure hash covers every regular file and forbids extras.
fn extract_verified_artifact(
    candidate: &Candidate,
    archive_path: &Path,
    destination: &Path,
) -> Result<(), ArtifactError> {
    extract_verified_artifact_with_progress(candidate, archive_path, destination,
        &AtomicBool::new(false), &mut |_, _| {})
}

pub(crate) fn extract_verified_artifact_with_progress(
    candidate: &Candidate,
    archive_path: &Path,
    destination: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), ArtifactError> {
    if digest_file(archive_path)? != candidate.artifact_sha256
        || fs::metadata(archive_path)
            .map_err(|_| ArtifactError::Io)?
            .len()
            != candidate.artifact_bytes
        || destination.exists()
    {
        return Err(ArtifactError::Invalid);
    }
    fs::create_dir(destination).map_err(|_| ArtifactError::Io)?;
    let file = File::open(archive_path).map_err(|_| ArtifactError::Io)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| ArtifactError::Invalid)?;
    if archive.len() == 0 || archive.len() > 30_100 {
        return Err(ArtifactError::Invalid);
    }
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    let mut closure = Vec::new();
    progress(0, candidate.closure_file_count as u64);
    for index in 0..archive.len() {
        if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
        let mut entry = archive
            .by_index(index)
            .map_err(|_| ArtifactError::Invalid)?;
        let name = entry.name().to_owned();
        let path = artifact_path(destination, &name)?;
        // NTFS names are case-insensitive by default. A signed archive must
        // have one unambiguous spelling, including explicit directory rows.
        if !seen.insert(name.trim_end_matches('/').to_ascii_lowercase()) {
            return Err(ArtifactError::Invalid);
        }
        let unix_type = entry.unix_mode().unwrap_or(0) & 0o170000;
        if unix_type != 0 && unix_type != 0o100000 && unix_type != 0o040000 {
            return Err(ArtifactError::Invalid);
        }
        if entry.is_dir() {
            if unix_type == 0o100000 {
                return Err(ArtifactError::Invalid);
            }
            fs::create_dir_all(&path).map_err(|_| ArtifactError::Io)?;
            continue;
        }
        if unix_type == 0o040000 || entry.size() > MAX_ARTIFACT_BYTES {
            return Err(ArtifactError::Invalid);
        }
        total = total
            .checked_add(entry.size())
            .ok_or(ArtifactError::Invalid)?;
        if total > MAX_ARTIFACT_BYTES {
            return Err(ArtifactError::Invalid);
        }
        let parent = path.parent().ok_or(ArtifactError::Invalid)?;
        fs::create_dir_all(parent).map_err(|_| ArtifactError::Io)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| ArtifactError::Io)?;
        let mut digest = Sha256::new();
        let mut written = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
            let count = entry
                .read(&mut buffer)
                .map_err(|_| ArtifactError::Invalid)?;
            if count == 0 {
                break;
            }
            written = written
                .checked_add(count as u64)
                .ok_or(ArtifactError::Invalid)?;
            if written > entry.size() {
                return Err(ArtifactError::Invalid);
            }
            digest.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|_| ArtifactError::Io)?;
        }
        output.sync_all().map_err(|_| ArtifactError::Io)?;
        if written != entry.size() {
            return Err(ArtifactError::Invalid);
        }
        closure.push((name, written, format!("{:x}", digest.finalize())));
        progress(closure.len() as u64, candidate.closure_file_count as u64);
    }
    if closure.len() != candidate.closure_file_count as usize {
        return Err(ArtifactError::Invalid);
    }
    closure.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (name, size, sha) in &closure {
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update(size.to_string().as_bytes());
        digest.update([0]);
        digest.update(sha.as_bytes());
        digest.update(b"\n");
    }
    if format!("{:x}", digest.finalize()) != candidate.closure_sha256
        || digest_file(&destination.join("node/node.exe"))? != candidate.node_sha256
        || digest_file(&destination.join("host/node_modules/@deepseek-ai/dsh/lib/bin.js"))?
            != candidate.entry_sha256
    {
        return Err(ArtifactError::Invalid);
    }
    verify_package_identity(destination, candidate)?;
    Ok(())
}

fn safe_runtime_entry(path: &Path) -> Result<fs::Metadata, ArtifactError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ArtifactError::Io)?;
    if metadata.file_type().is_symlink() {
        return Err(ArtifactError::Invalid);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(ArtifactError::Invalid);
        }
    }
    Ok(metadata)
}

/// Bounded installed-layout check. The signed envelope and compatibility are
/// checked by the caller; critical bytes are checked/pinned by the descriptor.
/// Package name/version is a consistency check, NOT a content-authenticity proof.
fn verify_runtime_layout(candidate: &Candidate, root: &Path) -> Result<(), ArtifactError> {
    for relative in ["", "node", "host", "host/node_modules",
        "host/node_modules/@deepseek-ai", "host/node_modules/@deepseek-ai/dsh",
        "host/node_modules/@deepseek-ai/dsh/lib"] {
        let path = if relative.is_empty() { root.to_path_buf() } else { artifact_path(root, relative)? };
        if !safe_runtime_entry(&path)?.is_dir() { return Err(ArtifactError::Invalid); }
    }
    for relative in ["node/node.exe", "host/node_modules/@deepseek-ai/dsh/lib/bin.js"] {
        if !safe_runtime_entry(&artifact_path(root, relative)?)?.is_file() {
            return Err(ArtifactError::Invalid);
        }
    }
    verify_package_identity(root, candidate)
}

pub(crate) fn runtime_launch_identity(candidate: &Candidate) -> crate::dsh_runtime_seal::RuntimeIdentity {
    crate::dsh_runtime_seal::RuntimeIdentity {
        executable: "node/node.exe".into(),
        entry_point: "host/node_modules/@deepseek-ai/dsh/lib/bin.js".into(),
        node_exe_sha256: candidate.node_sha256.clone(),
        entry_sha256: candidate.entry_sha256.clone(),
        package_version: candidate.version.clone(),
    }
}

/// Full signed closure admission belongs to install/activation, not ordinary
/// startup. It detects missing, extra or modified dependencies at that boundary.
fn verify_runtime_closure(
    candidate: &Candidate,
    root: &Path,
) -> Result<Vec<(PathBuf, String)>, ArtifactError> {
    verify_runtime_closure_with_progress(candidate, root, &AtomicBool::new(false), &mut |_, _| {})
}

pub(crate) fn verify_runtime_closure_with_progress(
    candidate: &Candidate,
    root: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Vec<(PathBuf, String)>, ArtifactError> {
    let _timing = StageTiming::new("full-closure-admission");
    scan_runtime_closure(candidate, root, cancel, progress)
}

fn scan_runtime_closure(
    candidate: &Candidate,
    root: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Vec<(PathBuf, String)>, ArtifactError> {
    if !safe_runtime_entry(root)?.is_dir() {
        return Err(ArtifactError::Invalid);
    }
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut total = 0u64;
    progress(0, candidate.closure_file_count as u64);
    while let Some(directory) = pending.pop() {
        if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
        for item in fs::read_dir(&directory).map_err(|_| ArtifactError::Io)? {
            if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
            let item = item.map_err(|_| ArtifactError::Io)?;
            let path = item.path();
            let metadata = safe_runtime_entry(&path)?;
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                // A signed file must not alias another writable object by a
                // hard link. The stable handle also closes the per-file
                // replace/write race during this digest pass.
                #[cfg(windows)]
                let _lease = crate::dsh_runtime_seal::acquire_stable_file(&path)
                    .map_err(|_| ArtifactError::Invalid)?;
                total = total
                    .checked_add(metadata.len())
                    .ok_or(ArtifactError::Invalid)?;
                if total > MAX_ARTIFACT_BYTES || files.len() >= 30_000 {
                    return Err(ArtifactError::Invalid);
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| ArtifactError::Invalid)?;
                let name = relative
                    .to_str()
                    .ok_or(ArtifactError::Invalid)?
                    .replace('\\', "/");
                artifact_path(root, &name)?;
                files.push((name, path, metadata.len(), digest_file(&item.path())?));
                progress(files.len() as u64, candidate.closure_file_count as u64);
            } else {
                return Err(ArtifactError::Invalid);
            }
        }
    }
    if files.len() != candidate.closure_file_count as usize {
        return Err(ArtifactError::Invalid);
    }
    files.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (name, _, size, sha) in &files {
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update(size.to_string().as_bytes());
        digest.update([0]);
        digest.update(sha.as_bytes());
        digest.update(b"\n");
    }
    if format!("{:x}", digest.finalize()) != candidate.closure_sha256
        || files
            .iter()
            .find(|(name, _, _, _)| name == "node/node.exe")
            .map(|(_, _, _, sha)| sha.as_str())
            != Some(candidate.node_sha256.as_str())
        || files
            .iter()
            .find(|(name, _, _, _)| name == "host/node_modules/@deepseek-ai/dsh/lib/bin.js")
            .map(|(_, _, _, sha)| sha.as_str())
            != Some(candidate.entry_sha256.as_str())
    {
        return Err(ArtifactError::Invalid);
    }
    verify_package_identity(root, candidate)?;
    Ok(files
        .into_iter()
        .map(|(_, path, _, sha)| (path, sha))
        .collect())
}

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn validate_candidate(candidate: &Candidate) -> Result<(), AdmissionError> {
    if !matches!((candidate.schema, candidate.compatibility.is_some()), (1, false) | (2, true))
        || candidate.runtime_package != "@deepseek-ai/dsh"
        || candidate.issued_at < 0
        || candidate.expires_at <= candidate.issued_at
        || candidate.expires_at - candidate.issued_at > 30 * 24 * 60 * 60
        || candidate.from_versions.is_empty()
        || candidate.from_versions.len() > 16
        || candidate.closure_file_count == 0
        || candidate.closure_file_count > 30_000
        || candidate.artifact_bytes == 0
        || candidate.artifact_bytes > MAX_ARTIFACT_BYTES
        || !hex64(&candidate.adapter_fingerprint)
        || !hex64(&candidate.node_sha256)
        || !hex64(&candidate.entry_sha256)
        || !hex64(&candidate.artifact_sha256)
        || !hex64(&candidate.closure_sha256)
        || !hex64(&candidate.resource_gate_sha256)
        // The current host has no independently verified profile migration.
        // A newer data layout requires a new LuckyRay host, never a guessed
        // rollback or a replay of an old profile snapshot.
        || candidate.data_compatibility != "no-migration"
    {
        return Err(AdmissionError::InvalidManifest);
    }
    let artifact = reqwest::Url::parse(&candidate.artifact_url)
        .map_err(|_| AdmissionError::InvalidManifest)?;
    if artifact.scheme() != "https"
        || artifact.username() != ""
        || artifact.password().is_some()
        || artifact.fragment().is_some()
        || artifact.query().is_some()
        || artifact.host_str().is_none()
    {
        return Err(AdmissionError::InvalidManifest);
    }
    Version::parse(&candidate.version).map_err(|_| AdmissionError::InvalidManifest)?;
    Version::parse(&candidate.host_version).map_err(|_| AdmissionError::InvalidManifest)?;
    if let Some(contract) = &candidate.compatibility {
        contract.validate()?;
        // The host used to qualify this package must itself be in the declared
        // range. Its fingerprints are audit evidence, never runtime authority.
        let qualified = Version::parse(&candidate.host_version).unwrap();
        if qualified < Version::parse(&contract.minimum_host_version).unwrap()
            || qualified >= Version::parse(&contract.maximum_host_version_exclusive).unwrap()
            || !qualified.pre.is_empty() || !qualified.build.is_empty()
        { return Err(AdmissionError::InvalidManifest); }
    }
    if candidate.assembly.is_some() { assembly::validate_candidate_input(candidate)?; }
    let mut seen = HashSet::new();
    for version in &candidate.from_versions {
        Version::parse(version).map_err(|_| AdmissionError::InvalidManifest)?;
        if !seen.insert(version) {
            return Err(AdmissionError::InvalidManifest);
        }
    }
    Ok(())
}

/// Verify the raw signed payload before parsing or using any candidate URL.
/// The release key and exact feed come only from this desktop build.
pub(crate) fn admit_for_this_build(
    envelope_bytes: &[u8],
    current_version: &str,
    now_unix: i64,
) -> Result<AdmittedCandidate, AdmissionError> {
    admit_with_source(&trusted_source_for_this_build()?, envelope_bytes, current_version, now_unix)
}

/// Re-open a previously activated signed runtime after its catalog validity
/// window ends. Expiration only blocks *new admission*; it must not strand a
/// healthy installed engine or silently fall back to an older data reader.
fn verify_installed_for_this_build(envelope_bytes: &[u8]) -> Result<Candidate, AdmissionError> {
    let source = trusted_source_for_this_build()?;
    let bundled = crate::dsh_runtime_seal::bundled_runtime_version()
        .ok_or(AdmissionError::InvalidManifest)?;
    verify_installed_with_contract(
        envelope_bytes,
        &source.public_key,
        &source.feed_url,
        env!("CARGO_PKG_VERSION"),
        &bundled,
        env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"),
        env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"),
    )
}


fn verify_installed_with_contract(
    envelope_bytes: &[u8],
    public_key: &[u8],
    feed_url: &str,
    current_host_version: &str,
    bundled_version: &str,
    adapter_fingerprint: &str,
    resource_gate_sha256: &str,
) -> Result<Candidate, AdmissionError> {
    let candidate = verify_signed_candidate(
        envelope_bytes,
        Some(public_key),
        Some(feed_url),
        current_host_version,
        false,
        adapter_fingerprint,
        resource_gate_sha256,
    )?;
    // Equality is safe: the signed installed closure remains the exact code
    // that may already have written this profile. A newer bundled engine
    // cannot silently replace it without a separately admitted migration.
    if Version::parse(&candidate.version).map_err(|_| AdmissionError::InvalidManifest)?
        < Version::parse(bundled_version).map_err(|_| AdmissionError::InvalidManifest)?
    {
        return Err(AdmissionError::NotAnUpgrade);
    }
    Ok(candidate)
}

fn verify_signed_candidate(
    envelope_bytes: &[u8],
    public_key: Option<&[u8]>,
    feed_url: Option<&str>,
    current_host_version: &str,
    exact_host_version: bool,
    adapter_fingerprint: &str,
    resource_gate_sha256: &str,
) -> Result<Candidate, AdmissionError> {
    let public_key = public_key.ok_or(AdmissionError::Unconfigured)?;
    let feed_url = feed_url.ok_or(AdmissionError::Unconfigured)?;
    if public_key.len() != 32
        || envelope_bytes.is_empty()
        || envelope_bytes.len() > MAX_ENVELOPE_BYTES
    {
        return Err(AdmissionError::InvalidManifest);
    }
    let feed = reqwest::Url::parse(feed_url).map_err(|_| AdmissionError::InvalidManifest)?;
    if feed.scheme() != "https"
        || feed.host_str().is_none()
        || feed.fragment().is_some()
        || feed.username() != ""
        || feed.password().is_some()
    {
        return Err(AdmissionError::InvalidManifest);
    }
    let envelope: SignedEnvelope =
        serde_json::from_slice(envelope_bytes).map_err(|_| AdmissionError::InvalidManifest)?;
    let payload = URL_SAFE_NO_PAD
        .decode(envelope.payload)
        .map_err(|_| AdmissionError::InvalidManifest)?;
    let signature = URL_SAFE_NO_PAD
        .decode(envelope.signature)
        .map_err(|_| AdmissionError::InvalidManifest)?;
    if payload.is_empty() || payload.len() > MAX_PAYLOAD_BYTES || signature.len() != 64 {
        return Err(AdmissionError::InvalidManifest);
    }
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(&payload, &signature)
        .map_err(|_| AdmissionError::InvalidSignature)?;
    let candidate: Candidate =
        serde_json::from_slice(&payload).map_err(|_| AdmissionError::InvalidManifest)?;
    validate_candidate(&candidate)?;
    let artifact = reqwest::Url::parse(&candidate.artifact_url)
        .map_err(|_| AdmissionError::InvalidManifest)?;
    if candidate.upstream.is_some() {
        upstream::validate_asset(&candidate).map_err(|_| AdmissionError::InvalidManifest)?;
    } else if artifact.origin() != feed.origin() {
        return Err(AdmissionError::InvalidManifest);
    }
    // raw.githubusercontent.com hosts many unrelated repositories. Same
    // origin is insufficient for the production metadata namespace.
    if feed_url == metadata_policy::FEED
        && (candidate.assembly.is_none() || !metadata_policy::descriptor_url_matches(&candidate.artifact_url, &candidate.artifact_sha256)) {
        return Err(AdmissionError::InvalidManifest);
    }
    if candidate.channel != CHANNEL {
        return Err(AdmissionError::WrongChannel);
    }
    if candidate.platform != PLATFORM {
        return Err(AdmissionError::WrongPlatform);
    }
    let signed_host = Version::parse(&candidate.host_version)
        .map_err(|_| AdmissionError::InvalidManifest)?;
    let current_host = Version::parse(current_host_version)
        .map_err(|_| AdmissionError::InvalidManifest)?;
    if let Some(contract) = &candidate.compatibility {
        contract.admit(current_host_version)?;
    } else {
        // Previously signed schema1 payloads keep their exact original
        // restrictions, including installed-runtime non-exact host semantics.
        if (exact_host_version && signed_host != current_host)
            || (!exact_host_version && signed_host > current_host)
            || candidate.adapter_fingerprint != adapter_fingerprint
            || candidate.resource_gate_sha256 != resource_gate_sha256
        {
            return Err(AdmissionError::LegacyContract);
        }
    }
    Ok(candidate)
}

fn admit_with_contract(
    envelope_bytes: &[u8],
    public_key: Option<&[u8]>,
    feed_url: Option<&str>,
    current_version: &str,
    adapter_fingerprint: &str,
    resource_gate_sha256: &str,
    now_unix: i64,
) -> Result<Candidate, AdmissionError> {
    let candidate = verify_signed_candidate(
        envelope_bytes,
        public_key,
        feed_url,
        env!("CARGO_PKG_VERSION"),
        true,
        adapter_fingerprint,
        resource_gate_sha256,
    )?;
    if candidate.issued_at > now_unix + 300 || candidate.expires_at <= now_unix {
        return Err(AdmissionError::Expired);
    }
    let current = Version::parse(current_version).map_err(|_| AdmissionError::InvalidManifest)?;
    let target = Version::parse(&candidate.version).map_err(|_| AdmissionError::InvalidManifest)?;
    if target <= current {
        return Err(AdmissionError::NotAnUpgrade);
    }
    if !candidate
        .from_versions
        .iter()
        .any(|version| version == current_version)
    {
        return Err(AdmissionError::NotFromCurrent);
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn fixture() -> (Vec<u8>, Vec<u8>) {
        fixture_with(|_| {})
    }

    #[test]
    #[cfg(all(windows, target_arch = "x86_64", feature = "browser-host-runtime"))]
    fn semantic_contract_admits_unrelated_source_changes_and_host_patch_versions() {
        let (bytes, key) = fixture_with(|candidate| {
            candidate.schema = 2;
            candidate.compatibility = Some(compatibility::fixture());
        });
        for host in ["1.9.4", "1.9.9", "1.99.0"] {
            let verified = verify_signed_candidate(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
                host, true, &"0".repeat(64), &"9".repeat(64)).unwrap();
            assert_eq!(verified.schema, 2);
        }
        assert!(admit_with_contract(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
            "0.1.7-rc.1", &"0".repeat(64), &"9".repeat(64), 500).is_ok());
    }

    #[test]
    fn semantic_contract_rejects_real_interfaces_capabilities_and_range_mismatches() {
        for change in ["adapter", "resource", "capability"] {
            let (bytes, key) = fixture_with(|candidate| {
                candidate.schema = 2;
                let mut contract = compatibility::fixture();
                match change {
                    "adapter" => contract.adapter_protocol = 2,
                    "resource" => contract.resource_protocol = 2,
                    _ => contract.required_capabilities.push("unimplemented-capability-v1".into()),
                }
                candidate.compatibility = Some(contract);
            });
            assert_eq!(admit_with_contract(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
                "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500), Err(AdmissionError::RequiresHost));
        }
        let (bytes, key) = fixture_with(|candidate| {
            candidate.schema = 2; candidate.compatibility = Some(compatibility::fixture());
        });
        for host in ["1.9.3", "2.0.0", "1.9.5-beta.1", "1.9.4+unknown"] {
            assert_eq!(verify_signed_candidate(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
                host, true, &"a".repeat(64), &"f".repeat(64)), Err(AdmissionError::RequiresHost));
        }
    }

    #[test]
    fn manifest_transition_never_reinterprets_legacy_constraints() {
        let (legacy, key) = fixture();
        assert!(verify_signed_candidate(&legacy, Some(&key), Some("https://updates.example.test/feed.json"),
            env!("CARGO_PKG_VERSION"), true, &"a".repeat(64), &"f".repeat(64)).is_ok());
        assert_eq!(verify_signed_candidate(&legacy, Some(&key), Some("https://updates.example.test/feed.json"),
            "1.9.9", true, &"a".repeat(64), &"f".repeat(64)), Err(AdmissionError::LegacyContract));
        assert_eq!(verify_signed_candidate(&legacy, Some(&key), Some("https://updates.example.test/feed.json"),
            env!("CARGO_PKG_VERSION"), true, &"0".repeat(64), &"f".repeat(64)), Err(AdmissionError::LegacyContract));
        for change in ["missing", "legacy-extra", "duplicate"] {
            let (bytes, key) = fixture_with(|candidate| {
                if change != "legacy-extra" { candidate.schema = 2; }
                if change != "missing" { candidate.compatibility = Some(compatibility::fixture()); }
                if change == "duplicate" {
                    candidate.compatibility.as_mut().unwrap().required_capabilities.push("resource-intents-v1".into());
                }
            });
            assert_eq!(admit_with_contract(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
                "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500), Err(AdmissionError::InvalidManifest));
        }
    }

    #[test]
    #[cfg(all(windows, target_arch = "x86_64", feature = "browser-host-runtime"))]
    fn semantic_contract_keeps_signature_upgrade_path_and_installed_reopen_guards() {
        let (bytes, key) = fixture_with(|candidate| {
            candidate.schema = 2; candidate.compatibility = Some(compatibility::fixture());
        });
        assert_eq!(admit_with_contract(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
            "0.1.5-rc.2", &"a".repeat(64), &"f".repeat(64), 500), Err(AdmissionError::NotFromCurrent));
        let mut tampered: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let mut payload: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(tampered["payload"].as_str().unwrap()).unwrap()).unwrap();
        payload["artifactSha256"] = serde_json::json!("0".repeat(64));
        tampered["payload"] = serde_json::json!(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap()));
        assert_eq!(admit_with_contract(&serde_json::to_vec(&tampered).unwrap(), Some(&key), Some("https://updates.example.test/feed.json"),
            "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500), Err(AdmissionError::InvalidSignature));
        assert_eq!(admit_with_contract(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
            "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 1001), Err(AdmissionError::Expired));
        assert!(verify_installed_with_contract(&bytes, &key, "https://updates.example.test/feed.json", "1.9.9",
            "0.1.7-rc.2", &"0".repeat(64), &"9".repeat(64)).is_ok());
        assert_eq!(verify_installed_with_contract(&bytes, &key, "https://updates.example.test/feed.json", "2.0.0",
            "0.1.7-rc.2", &"0".repeat(64), &"9".repeat(64)), Err(AdmissionError::RequiresHost));
        assert_eq!(catalog_admission_error(AdmissionError::NotFromCurrent), CatalogError::UpgradePath);
        assert_eq!(catalog_admission_error(AdmissionError::LegacyContract), CatalogError::LegacyContract);
        assert_eq!(catalog_admission_error(AdmissionError::InvalidSignature), CatalogError::Untrusted);
    }

    #[test]
    #[cfg(not(all(windows, target_arch = "x86_64", feature = "browser-host-runtime")))]
    fn declaration_cannot_enable_an_absent_native_host_implementation() {
        let (bytes, key) = fixture_with(|candidate| {
            candidate.schema = 2; candidate.compatibility = Some(compatibility::fixture());
        });
        assert_eq!(admit_with_contract(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
            "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500), Err(AdmissionError::RequiresHost));
    }

    /// Run explicitly with DSH_DEV_FEED_DIR set to the isolated output of
    /// scripts/dsh-engine-update-dev-feed.mjs. This uses the actual frozen
    /// rc.2/Node closure, not a renamed synthetic higher engine version.
    #[test]
    #[ignore = "requires the frozen 0.1.7-rc.2 Windows release archive"]
    fn frozen_signed_development_archive_reopens_exact_closure() {
        let directory = std::path::PathBuf::from(std::env::var("DSH_DEV_FEED_DIR").unwrap());
        let envelope = std::fs::read(directory.join("feed.json")).unwrap();
        let public = URL_SAFE_NO_PAD.decode(
            std::fs::read_to_string(directory.join("dev-public-key.txt")).unwrap().trim()
        ).unwrap();
        let candidate = admit_with_contract(
            &envelope, Some(&public), Some("https://127.0.0.1:38491/feed.json"),
            "0.1.5-rc.2", env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"),
            env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64,
        ).unwrap();
        assert_eq!(candidate.version, "0.1.7-rc.2");
        let scratch = tempfile::tempdir().unwrap();
        let destination = scratch.path().join("candidate");
        extract_verified_artifact(
            &candidate, &directory.join("dsh-0.1.7-rc.2-win-x64.zip"), &destination,
        ).unwrap();
        let identities = verify_runtime_closure(&candidate, &destination).unwrap();
        assert_eq!(identities.len(), candidate.closure_file_count as usize);
        let command = std::process::Command::new(destination.join("node/node.exe"))
            .arg(destination.join("host/node_modules/@deepseek-ai/dsh/lib/bin.js"))
            .arg("--version").output().unwrap();
        assert!(command.status.success());
        assert_eq!(String::from_utf8_lossy(&command.stdout).trim(), "0.1.7-rc.2");
    }

    #[test]
    #[ignore = "requires isolated loopback HTTPS feed and debug-only pinned CA"]
    fn frozen_development_https_feed_checks_signature_and_downloads_exact_archive() {
        assert_eq!(env!("LUCKYRAY_DSH_UPDATE_TRUST_CLASS"), "development");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        let admitted = check_catalog("0.1.5-rc.2", now).unwrap();
        assert_eq!(admitted.version(), "0.1.7-rc.2");
        let scratch = tempfile::tempdir().unwrap();
        let cancelled = AtomicBool::new(false);
        let cancelled_archive = scratch.path().join("cancelled.zip");
        let started = std::time::Instant::now();
        assert!(download_artifact_with_progress(&admitted, &cancelled_archive, &cancelled,
            &mut |done, _| {
                if done > 0 { cancelled.store(true, Ordering::Release); }
            }).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(30),
            "an in-flight HTTPS download cancellation must not wait for the whole archive");
        let archive = scratch.path().join("artifact.zip");
        download_artifact(&admitted, &archive, &AtomicBool::new(false)).unwrap();
        assert_eq!(digest_file(&archive).unwrap(), admitted.candidate.artifact_sha256);
    }

    fn fixture_with(change: impl FnOnce(&mut Candidate)) -> (Vec<u8>, Vec<u8>) {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let mut candidate = Candidate {
            schema: 1,
            channel: CHANNEL.into(),
            runtime_package: "@deepseek-ai/dsh".into(),
            issued_at: 100,
            expires_at: 1000,
            host_version: env!("CARGO_PKG_VERSION").into(),
            adapter_fingerprint: "a".repeat(64),
            platform: PLATFORM.into(),
            from_versions: vec!["0.1.7-rc.1".into()],
            version: "0.1.7-rc.2".into(),
            node_sha256: "b".repeat(64),
            entry_sha256: "c".repeat(64),
            artifact_url: "https://updates.example.test/dsh/rc2.zip".into(),
            artifact_sha256: "d".repeat(64),
            artifact_bytes: 100,
            closure_sha256: "e".repeat(64),
            closure_file_count: 1,
            data_compatibility: "no-migration".into(),
            upstream: None,
            assembly: None,
            resource_gate_sha256: "f".repeat(64),
            compatibility: None,
        };
        change(&mut candidate);
        let payload = serde_json::to_vec(&candidate).unwrap();
        let envelope = serde_json::json!({
            "payload": URL_SAFE_NO_PAD.encode(&payload),
            "signature": URL_SAFE_NO_PAD.encode(pair.sign(&payload).as_ref()),
        });
        (
            serde_json::to_vec(&envelope).unwrap(),
            pair.public_key().as_ref().to_vec(),
        )
    }

    fn frozen_assembly_fixture(candidate: &mut Candidate) {
        candidate.assembly = Some(assembly::FrozenAssemblyIdentity {
            schema: 1, kind: "official-npm-frozen-win-x64-v1".into(), toolset: None,
        });
        candidate.node_sha256 = "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362".into();
        candidate.entry_sha256 = "935e95d05f4dc70a8a013eea59da80028946b5c139e45c6351dcaf2810ca00a1".into();
        candidate.closure_file_count = 25_659;
        candidate.artifact_url = "https://updates.example.test/inputs/0.1.7-rc.2.json".into();
    }

    #[test]
    fn signed_frozen_assembly_still_requires_exact_contract_and_bounded_identity() {
        let (bytes, key) = fixture_with(frozen_assembly_fixture);
        let admit = |bytes: &[u8], key: &[u8]| admit_with_contract(bytes, Some(key),
            Some("https://updates.example.test/feed.json"), "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500);
        assert!(admit(&bytes, &key).is_ok());
        let mut tampered = bytes.clone();
        tampered[10] ^= 1;
        assert!(admit(&tampered, &key).is_err());
        for change in 0..10 {
            let (bytes, key) = fixture_with(|candidate| {
                frozen_assembly_fixture(candidate);
                match change {
                    0 => candidate.assembly.as_mut().unwrap().schema = 2,
                    1 => candidate.assembly.as_mut().unwrap().kind = "run-catalog-command".into(),
                    2 => candidate.version = "0.2.0-rc.1".into(),
                    3 => candidate.node_sha256 = "0".repeat(64),
                    4 => candidate.entry_sha256 = "0".repeat(64),
                    5 => candidate.closure_file_count -= 1,
                    6 => candidate.artifact_bytes = 2 * 1024 * 1024 + 1,
                    7 => candidate.artifact_url = "https://third-party.test/inputs.json".into(),
                    8 => candidate.adapter_fingerprint = "0".repeat(64),
                    _ => candidate.data_compatibility = "rollback-old-profile".into(),
                }
            });
            assert!(admit(&bytes, &key).is_err(), "changed frozen contract {change}");
        }
    }

    #[test]
    fn qualified_versions_are_signed_data_but_tools_and_host_remain_fixed() {
        for version in ["0.1.5-rc.2", "0.1.7-rc.2"] {
            let (bytes, key) = fixture_with(|candidate| {
                frozen_assembly_fixture(candidate);
                candidate.assembly = Some(assembly::FrozenAssemblyIdentity { schema: 2,
                    kind: "official-npm-qualified-win-x64-v2".into(), toolset: Some("node22.19.0-pnpm11.7.0-policy1".into()) });
                candidate.version = version.into(); candidate.from_versions = vec!["0.1.1-rc.2".into()];
                candidate.entry_sha256 = "1".repeat(64); candidate.closure_file_count = 24_563;
            });
            assert!(admit_with_contract(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
                "0.1.1-rc.2", &"a".repeat(64), &"f".repeat(64), 500).is_ok());
            assert!(admit_with_contract(&bytes, None, Some("https://updates.example.test/feed.json"),
                "0.1.1-rc.2", &"a".repeat(64), &"f".repeat(64), 500).is_err());
        }
        for unknown_node in [false, true] {
            let (bytes, key) = fixture_with(|candidate| {
                frozen_assembly_fixture(candidate);
                candidate.assembly = Some(assembly::FrozenAssemblyIdentity { schema: 2,
                    kind: "official-npm-qualified-win-x64-v2".into(),
                    toolset: Some(if unknown_node { "node22.19.0-pnpm11.7.0-policy1" } else { "unknown-tools" }.into()) });
                if unknown_node { candidate.node_sha256 = "0".repeat(64); }
            });
            assert_eq!(admit_with_contract(&bytes, Some(&key), Some("https://updates.example.test/feed.json"),
                "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500), Err(AdmissionError::RequiresHost));
        }
    }

    #[test]
    fn pre_cancelled_exact_download_never_creates_an_output_or_sends_a_request() {
        let scratch = tempfile::tempdir().unwrap();
        let output = scratch.path().join("never-created");
        let client = artifact_client().unwrap();
        // Invalid/offline URL proves cancellation precedes URL parsing/send.
        assert_eq!(tauri::async_runtime::block_on(download_exact_async(&client, "not-a-url", 1,
            &"a".repeat(64), false, &output, &AtomicBool::new(true), &mut |_, _| panic!("no progress"))),
            Err(ArtifactError::Io));
        assert!(!output.exists());
    }

    #[test]
    #[ignore = "anonymous official HTTPS input fault checks; newly generated test store only"]
    fn official_exact_input_download_rejects_faults_and_cleans_only_own_partial() {
        let scratch = tempfile::tempdir().unwrap();
        let store = transaction::UpdateStore::open(scratch.path()).unwrap();
        let client = artifact_client().unwrap();
        let url = "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz";
        let hash = "5f2da7272d9485abc223e681075809a8d929697c5232ee445718e1b7e066bff8";
        let cancel = AtomicBool::new(false);
        for fault in ["wrong-size", "wrong-hash", "missing", "in-flight-cancel", "valid"] {
            cancel.store(false, Ordering::Release);
            let output = store.new_download_path().unwrap();
            let selected_url = if fault == "missing" {
                "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz.not-an-artifact"
            } else { url };
            let result = tauri::async_runtime::block_on(download_exact_async(&client, selected_url,
                if fault == "wrong-size" { 23334 } else { 23335 },
                if fault == "wrong-hash" { "0000000000000000000000000000000000000000000000000000000000000000" } else { hash },
                false, &output, &cancel, &mut |done, _| {
                    if fault == "in-flight-cancel" && done > 0 { cancel.store(true, Ordering::Release); }
                }));
            match fault {
                "valid" => { result.unwrap(); assert_eq!(digest_file(&output).unwrap(), hash); },
                "in-flight-cancel" => assert_eq!(result, Err(ArtifactError::Io)),
                _ => assert_eq!(result, Err(ArtifactError::Invalid)),
            }
            println!("OFFICIAL_EXACT_INPUT_FAULT_CHECK {fault} accepted={}", fault == "valid");
            assert!(!store.pending_switch());
        }
        // This exact updater API cleans its generated partial/success download
        // only; no runtime activation, user profile or backup is involved.
        store.new_download_path().unwrap();
        assert_eq!(fs::read_dir(scratch.path().join("dsh-engine-updates/downloads")).unwrap().count(), 0);
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "actual official network, frozen input record and sealed baseline; isolated new test identity only"]
    fn native_official_assembly_cancels_then_retries_and_reopens_same_verified_stage() {
        let description = PathBuf::from(std::env::var_os("DSH_OFFICIAL_INPUTS_RECORD").unwrap());
        let baseline = PathBuf::from(std::env::var_os("DSH_TEST_BASELINE_ROOT").unwrap());
        assert!(description.is_absolute() && baseline.is_absolute());
        let mut pending = vec![baseline.clone()];
        let mut files = Vec::new();
        while let Some(directory) = pending.pop() {
            for item in fs::read_dir(directory).unwrap() {
                let path = item.unwrap().path();
                let meta = safe_runtime_entry(&path).unwrap();
                if meta.is_dir() { pending.push(path); }
                else {
                    assert!(meta.is_file());
                    files.push((path.strip_prefix(&baseline).unwrap().to_str().unwrap().replace('\\', "/"),
                        meta.len(), digest_file(&path).unwrap()));
                }
            }
        }
        files.sort_unstable();
        let mut closure = Sha256::new();
        for (name, size, sha) in &files {
            closure.update(name.as_bytes()); closure.update([0]);
            closure.update(size.to_string().as_bytes()); closure.update([0]);
            closure.update(sha.as_bytes()); closure.update(b"\n");
        }
        assert_eq!(files.len(), 25_659);
        let closure = format!("{:x}", closure.finalize());
        let (envelope, key) = fixture_with(|candidate| {
            frozen_assembly_fixture(candidate);
            candidate.artifact_sha256 = digest_file(&description).unwrap();
            candidate.artifact_bytes = fs::metadata(&description).unwrap().len();
            candidate.closure_sha256 = closure.clone();
        });
        let candidate = admit_with_contract(&envelope, Some(&key), Some("https://updates.example.test/feed.json"),
            "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500).unwrap();
        verify_runtime_closure(&candidate, &baseline).unwrap();
        // Test key is solely an isolated admission fixture, never a compiled
        // production root. Execution/download/worker/seal paths are real.
        let admitted = AdmittedCandidate { candidate, signed_envelope: envelope };
        let readmitted = || AdmittedCandidate { candidate: admitted.candidate.clone(), signed_envelope: admitted.signed_envelope.clone() };
        let scratch = tempfile::Builder::new().prefix("luckyray-native-official-assembly-").tempdir().unwrap();
        fs::write(scratch.path().join("synthetic-profile-sentinel"), b"new-profile-not-a-user-profile").unwrap();
        let store = transaction::UpdateStore::open(scratch.path()).unwrap();
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let mut cancelled_worker = false;
        let mut cancelled_phases = BTreeSet::new();
        let result = store.prepare_from_archive_with_progress(readmitted(), &description, &cancel,
            &mut |phase, done, _| {
                if cancelled_phases.insert(phase) { println!("NATIVE_CANCEL_PHASE {phase}"); }
                if phase == "assemble" && done == 0 { cancelled_worker = true; cancel.store(true, Ordering::Release); }
            });
        if let Err(error) = &result { println!("NATIVE_CANCEL_RESULT {error:?}"); }
        assert!(cancelled_worker, "must reach an actual owned assembly worker before cancelling");
        assert!(matches!(result, Err(transaction::StoreError::Io)));
        assert_eq!(fs::read_dir(scratch.path().join("dsh-engine-updates/versions")).unwrap().count(), 0,
            "cancel must drain its Job before cleaning only generated workspace/stage");
        assert!(!store.pending_switch());
        println!("NATIVE_ASSEMBLY_CANCEL_OK elapsedMs={}", started.elapsed().as_millis());
        cancel.store(false, Ordering::Release);
        let started = std::time::Instant::now();
        let mut phases = BTreeSet::new();
        let prepared = store.prepare_from_archive_with_progress(readmitted(), &description, &cancel,
            &mut |phase, done, _| {
                if phases.insert(phase) { println!("NATIVE_ASSEMBLY_PHASE {phase}"); }
                if phase == "assemble" { println!("NATIVE_ASSEMBLY_STEP {done}"); }
            }).unwrap();
        assert_eq!(verify_runtime_closure(&admitted.candidate, &prepared.root).unwrap().len(), 25_659);
        assert!(phases.is_superset(&BTreeSet::from(["bootstrap", "inputs", "assemble", "verify"])));
        assert!(!store.pending_switch(), "assembly is not activation");
        let reopened = store.prepare_from_archive_with_progress(readmitted(), &description, &cancel,
            &mut |phase, _, _| assert_eq!(phase, "verify", "already verified stage must not reinstall")).unwrap();
        assert_eq!(reopened.root, prepared.root);
        assert_eq!(fs::read(scratch.path().join("synthetic-profile-sentinel")).unwrap(), b"new-profile-not-a-user-profile");
        assert_eq!(fs::read_dir(scratch.path().join("dsh-engine-updates/versions")).unwrap().count(), 1);
        let record = serde_json::json!({ "outcome": "NATIVE_OFFICIAL_ASSEMBLY_RETRY_REOPEN",
            "root": prepared.root, "files": 25658, "elapsedMs": started.elapsed().as_millis(),
            "closureSha256": closure, "artifactSha256": admitted.candidate.artifact_sha256,
            "activated": false, "profileUntouched": true, "trust": "test-key-not-production" });
        fs::write(scratch.path().join("native-assembly-result.json"), serde_json::to_vec_pretty(&record).unwrap()).unwrap();
        // Retain only this new owned proof identity for subsequent seal/host
        // measurement. No user AppData/environment switch or GUI is involved.
        println!("{}", record);
        println!("NATIVE_ASSEMBLY_PROOF_RETAINED {}", scratch.keep().display());
    }

    #[test]
    fn signed_official_identity_allows_only_the_exact_release_asset() {
        let official = |candidate: &mut Candidate| {
            candidate.upstream = Some(upstream::OfficialAssetIdentity {
                repository: "deepseek-ai/deepseek-harness".into(),
                tag: "dsh-v0.1.7-rc.2".into(), release_id: 10, asset_id: 20,
                name: "runtime-win-x64.zip".into(),
            });
            candidate.artifact_url = "https://github.com/deepseek-ai/deepseek-harness/releases/download/dsh-v0.1.7-rc.2/runtime-win-x64.zip".into();
        };
        let (bytes, key) = fixture_with(official);
        assert!(admit_with_contract(&bytes, Some(&key), Some("https://catalog.example.test/feed.json"),
            "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500).is_ok());
        // Synthetic unit identity is not a claim that this asset exists.
        for mutation in 0..5 {
            let (bytes, key) = fixture_with(|candidate| {
                official(candidate);
                match mutation {
                    0 => candidate.upstream.as_mut().unwrap().repository = "third-party/desktop".into(),
                    1 => candidate.upstream.as_mut().unwrap().tag = "dsh-v0.2.0-rc.1".into(),
                    2 => candidate.upstream.as_mut().unwrap().asset_id = 0,
                    3 => candidate.artifact_url.push_str("?token=forbidden"),
                    _ => candidate.upstream.as_mut().unwrap().name = "cli.tgz".into(),
                }
            });
            assert_eq!(admit_with_contract(&bytes, Some(&key), Some("https://catalog.example.test/feed.json"),
                "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500), Err(AdmissionError::InvalidManifest));
        }
        let (bytes, key) = fixture();
        assert_eq!(admit_with_contract(&bytes, Some(&key), Some("https://catalog.example.test/feed.json"),
            "0.1.7-rc.1", &"a".repeat(64), &"f".repeat(64), 500), Err(AdmissionError::InvalidManifest));
    }

    #[test]
    fn signed_upgrade_is_admitted_only_for_the_exact_host() {
        let (bytes, key) = fixture();
        let result = admit_with_contract(
            &bytes,
            Some(&key),
            Some("https://updates.example.test/feed.json"),
            "0.1.7-rc.1",
            &"a".repeat(64),
            &"f".repeat(64),
            500,
        )
        .unwrap();
        assert_eq!(result.version, "0.1.7-rc.2");
        assert_eq!(
            admit_with_contract(
                &bytes,
                Some(&key),
                Some("https://updates.example.test/feed.json"),
                "0.1.7-rc.1",
                &"0".repeat(64),
                &"f".repeat(64),
                500
            ),
            Err(AdmissionError::LegacyContract)
        );
        assert_eq!(
            admit_with_contract(
                &bytes,
                Some(&key),
                Some("https://updates.example.test/feed.json"),
                "0.1.7-rc.1",
                &"a".repeat(64),
                &"0".repeat(64),
                500
            ),
            Err(AdmissionError::LegacyContract)
        );
    }

    #[test]
    fn installed_engine_survives_a_compatible_later_host_but_not_a_new_candidate_gate() {
        let (bytes, key) = fixture_with(|candidate| candidate.host_version = "1.9.2".into());
        let source = "https://updates.example.test/feed.json";
        assert_eq!(
            verify_installed_with_contract(
                &bytes, &key, source, "1.9.4", "0.1.7-rc.2",
                &"a".repeat(64), &"f".repeat(64),
            ).unwrap().version,
            "0.1.7-rc.2"
        );
        assert_eq!(
            admit_with_contract(&bytes, Some(&key), Some(source), "0.1.7-rc.1",
                &"a".repeat(64), &"f".repeat(64), 500),
            Err(AdmissionError::LegacyContract),
            "a new candidate remains bound to its exact issuing host"
        );
        assert_eq!(
            verify_installed_with_contract(&bytes, &key, source, "1.9.4", "0.1.7-rc.2",
                &"0".repeat(64), &"f".repeat(64)),
            Err(AdmissionError::LegacyContract)
        );
        assert_eq!(
            verify_installed_with_contract(&bytes, &key, source, "1.9.4", "0.1.7-rc.3",
                &"a".repeat(64), &"f".repeat(64)),
            Err(AdmissionError::NotAnUpgrade)
        );
    }

    #[test]
    fn altered_or_expired_catalog_never_authorizes_download() {
        let (bytes, key) = fixture();
        let mut tampered: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        tampered["payload"] = serde_json::json!(URL_SAFE_NO_PAD.encode(b"{}"));
        assert_eq!(
            admit_with_contract(
                &serde_json::to_vec(&tampered).unwrap(),
                Some(&key),
                Some("https://updates.example.test/feed.json"),
                "0.1.7-rc.1",
                &"a".repeat(64),
                &"f".repeat(64),
                500
            ),
            Err(AdmissionError::InvalidSignature)
        );
        assert_eq!(
            admit_with_contract(
                &bytes,
                Some(&key),
                Some("https://updates.example.test/feed.json"),
                "0.1.7-rc.1",
                &"a".repeat(64),
                &"f".repeat(64),
                1001
            ),
            Err(AdmissionError::Expired)
        );
        assert_eq!(
            admit_with_contract(
                &bytes,
                None,
                Some("https://updates.example.test/feed.json"),
                "0.1.7-rc.1",
                &"a".repeat(64),
                &"f".repeat(64),
                500
            ),
            Err(AdmissionError::Unconfigured)
        );
    }

    #[test]
    fn signed_but_incompatible_candidate_is_not_admitted() {
        for (change, expected) in [
            ("platform", AdmissionError::WrongPlatform),
            ("channel", AdmissionError::WrongChannel),
            ("package", AdmissionError::InvalidManifest),
            ("migration", AdmissionError::InvalidManifest),
        ] {
            let (bytes, key) = fixture_with(|candidate| match change {
                "platform" => candidate.platform = "linux-x86_64".into(),
                "channel" => candidate.channel = "stable".into(),
                "package" => candidate.runtime_package = "foreign-package".into(),
                "migration" => candidate.data_compatibility = "unknown-migration".into(),
                _ => unreachable!(),
            });
            assert_eq!(
                admit_with_contract(
                    &bytes,
                    Some(&key),
                    Some("https://updates.example.test/feed.json"),
                    "0.1.7-rc.1",
                    &"a".repeat(64),
                    &"f".repeat(64),
                    500,
                ),
                Err(expected),
                "{change}"
            );
        }
    }

    #[test]
    fn exact_artifact_closure_is_extracted_and_escape_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("runtime.zip");
        let entries = [
            (
                "host/node_modules/@deepseek-ai/dsh/lib/bin.js",
                b"synthetic entry".as_slice(),
            ),
            (
                "host/node_modules/@deepseek-ai/dsh/package.json",
                br#"{"name":"@deepseek-ai/dsh","version":"0.1.7-rc.2"}"#.as_slice(),
            ),
            ("node/node.exe", b"synthetic node".as_slice()),
        ];
        let mut writer = zip::ZipWriter::new(File::create(&archive_path).unwrap());
        for (name, bytes) in &entries {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        let mut closure = Sha256::new();
        for (name, bytes) in &entries {
            closure.update(name.as_bytes());
            closure.update([0]);
            closure.update(bytes.len().to_string().as_bytes());
            closure.update([0]);
            closure.update(format!("{:x}", Sha256::digest(bytes)).as_bytes());
            closure.update(b"\n");
        }
        let candidate = Candidate {
            schema: 1,
            channel: CHANNEL.into(),
            runtime_package: "@deepseek-ai/dsh".into(),
            issued_at: 100,
            expires_at: 1000,
            host_version: env!("CARGO_PKG_VERSION").into(),
            adapter_fingerprint: "a".repeat(64),
            platform: PLATFORM.into(),
            from_versions: vec!["0.1.7-rc.1".into()],
            version: "0.1.7-rc.2".into(),
            node_sha256: format!("{:x}", Sha256::digest(entries[2].1)),
            entry_sha256: format!("{:x}", Sha256::digest(entries[0].1)),
            artifact_url: "https://updates.example.test/dsh/rc2.zip".into(),
            artifact_sha256: digest_file(&archive_path).unwrap(),
            artifact_bytes: fs::metadata(&archive_path).unwrap().len(),
            closure_sha256: format!("{:x}", closure.finalize()),
            closure_file_count: 3,
            data_compatibility: "no-migration".into(),
            resource_gate_sha256: "f".repeat(64),
            compatibility: None,
            upstream: None,
            assembly: None,
        };
        let store = UpdateStore::open(temp.path()).unwrap();
        let cancel = AtomicBool::new(false);
        let interrupted = store.prepare_from_archive_with_progress(
            AdmittedCandidate { candidate: candidate.clone(), signed_envelope: vec![] },
            &archive_path, &cancel,
            &mut |stage, done, _| {
                if stage == "extract" && done == 1 { cancel.store(true, Ordering::Release); }
            },
        );
        assert!(interrupted.is_err());
        assert_eq!(fs::read_dir(temp.path().join("dsh-engine-updates/versions")).unwrap().count(), 0,
            "a cancelled extraction must clean only its generated stage");
        let destination = temp.path().join("verified-runtime");
        extract_verified_artifact(&candidate, &archive_path, &destination).unwrap();
        assert_eq!(
            fs::read(destination.join(entries[0].0)).unwrap(),
            entries[0].1
        );
        assert_eq!(
            verify_runtime_closure(&candidate, &destination)
                .unwrap()
                .len(),
            3
        );
        let unexpected = destination.join("unexpected-package.js");
        fs::write(&unexpected, b"new file").unwrap();
        assert!(verify_runtime_closure(&candidate, &destination).is_err());
        fs::remove_file(unexpected).unwrap();
        fs::write(destination.join(entries[0].0), b"changed entry").unwrap();
        assert_eq!(
            verify_runtime_closure(&candidate, &destination),
            Err(ArtifactError::Invalid)
        );

        let unsafe_archive = temp.path().join("escape.zip");
        let mut writer = zip::ZipWriter::new(File::create(&unsafe_archive).unwrap());
        writer
            .start_file("../escape", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"bad").unwrap();
        writer.finish().unwrap();
        let mut unsafe_candidate = candidate.clone();
        unsafe_candidate.artifact_sha256 = digest_file(&unsafe_archive).unwrap();
        unsafe_candidate.artifact_bytes = fs::metadata(&unsafe_archive).unwrap().len();
        assert_eq!(
            extract_verified_artifact(
                &unsafe_candidate,
                &unsafe_archive,
                &temp.path().join("escaped-runtime")
            ),
            Err(ArtifactError::Invalid)
        );
        assert!(!temp.path().join("escape").exists());
    }

    #[test]
    fn switch_error_record_is_redacted_round_trippable_and_clearable() {
        let temp = tempfile::tempdir().unwrap();
        record_switch_error(temp.path(), &transaction::StoreError::Io);
        let record = read_switch_error(temp.path()).expect("recorded");
        assert_eq!(record.schema, 1);
        assert_eq!(record.stage, "complete-pending-switch");
        assert_eq!(record.error_category, "io");
        let raw = fs::read(temp.path().join("dsh-engine-updates").join(SWITCH_ERROR_FILE)).unwrap();
        let text = String::from_utf8(raw).unwrap();
        assert!(!text.contains(temp.path().to_string_lossy().as_ref()), "no local paths");
        assert!(!text.contains("users"), "no user paths");
        clear_switch_error(temp.path());
        assert!(read_switch_error(temp.path()).is_none());
    }
}
