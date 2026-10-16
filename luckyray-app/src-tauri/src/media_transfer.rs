use crate::materials::{
    MaterialCatalog, MaterialChange, MaterialFolderInput,
    MaterialImportOptions, MaterialResult, MaterialStagedFileInput,
};
use crate::web_tools::{SafeHttpBody, SafeHttpClient, WebToolError};
use reqwest::header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
#[cfg(all(windows, feature = "browser-host-runtime"))]
use std::collections::HashSet;
#[cfg(all(windows, feature = "browser-host-runtime"))]
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_ACTIVE_CAP: usize = 3;
const DEFAULT_TERMINAL_CAP: usize = 128;
const DEFAULT_TERMINAL_TTL: Duration = Duration::from_secs(10 * 60);
const DEFAULT_PROBE_CAP: usize = 32;
const DEFAULT_PROBE_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30 * 60);
const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_REDIRECT_CAP: usize = 5;
const DEFAULT_SEGMENT_CAP: usize = 10_000;
const DEFAULT_DURATION_CAP_SECS: f64 = 6.0 * 60.0 * 60.0;
const MAX_PLAYLIST_BYTES: u64 = 1024 * 1024;
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_SITE_AUTH_COOKIES: usize = 128;
const MAX_SITE_AUTH_BYTES: usize = 64 * 1024;
const MAX_RESOLVER_PROBE_BYTES: u64 = 64 * 1024;
#[cfg(all(windows, feature = "browser-host-runtime"))]
const MAX_RESOLVER_STATUS_BYTES: u64 = 128;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaSiteCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub expires: i64,
    pub secure: bool,
    pub http_only: bool,
}

impl fmt::Debug for MediaSiteCookie {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaSiteCookie")
            .field("name", &self.name)
            .field("value", &"<redacted>")
            .field("domain", &self.domain)
            .field("path", &self.path)
            .field("expires", &self.expires)
            .field("secure", &self.secure)
            .field("http_only", &self.http_only)
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaSiteAuth {
    pub cookies: Vec<MediaSiteCookie>,
    #[serde(default)]
    pub user_agent: String,
    #[serde(default)]
    pub referer: String,
}

impl fmt::Debug for MediaSiteAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaSiteAuth")
            .field("cookie_count", &self.cookies.len())
            .field("user_agent_present", &!self.user_agent.is_empty())
            .field("referer_present", &!self.referer.is_empty())
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaTransferRequest {
    pub url: String,
    #[serde(default)]
    pub audio_url: Option<String>,
    pub file_name: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub source_page_url: Option<String>,
    #[serde(default)]
    pub target_folder_id: Option<String>,
    #[serde(default)]
    pub new_folder_name: Option<String>,
    #[serde(default)]
    pub parent_folder_id: Option<String>,
    #[serde(default)]
    pub site_auth: Option<MediaSiteAuth>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaProbeRequest {
    pub url: String,
    #[serde(default)]
    pub source_page_url: Option<String>,
    #[serde(default)]
    pub site_auth: Option<MediaSiteAuth>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaFormatOption {
    pub format_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub extension: String,
    pub video_codec: String,
    pub audio_codec: String,
    pub estimated_bytes: u64,
    pub bitrate: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaProbeSnapshot {
    pub probe_id: String,
    pub formats: Vec<MediaFormatOption>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaTransferState {
    Queued,
    Running,
    Importing,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaTransferSnapshot {
    pub transfer_id: String,
    pub state: MediaTransferState,
    pub bytes_received: u64,
    pub total_bytes: Option<u64>,
    pub file_name: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_kind: Option<String>,
    pub skipped_duplicate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub library_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub receipt: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaTransferError {
    pub code: String,
    pub message: String,
}

impl MediaTransferError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for MediaTransferError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MediaTransferError {}

pub(crate) type MediaTransferResult<T> = Result<T, MediaTransferError>;

#[derive(Clone)]
pub(crate) struct MediaTransferService {
    inner: Arc<MediaTransferInner>,
}

struct MediaTransferInner {
    staging_dir: PathBuf,
    http: SafeHttpClient,
    resolver: Option<Arc<dyn MediaResolver>>,
    limits: MediaTransferLimits,
    catalog: MaterialCatalog,
    catalog_change_sink: CatalogChangeSink,
    jobs: Mutex<HashMap<String, MediaTransferJob>>,
    probes: Mutex<HashMap<String, MediaProbeRecord>>,
}

type CatalogChangeSink = Arc<dyn Fn(&Option<MaterialChange>) + Send + Sync>;

#[derive(Clone)]
struct MediaTransferLimits {
    active_cap: usize,
    terminal_cap: usize,
    terminal_ttl: Duration,
    max_bytes: u64,
    deadline: Duration,
    redirect_cap: usize,
    segment_cap: usize,
    duration_cap_secs: f64,
    io_timeout: Duration,
}

pub(crate) struct MediaTransferDestination {
    pub library_id: String,
    pub request_id: String,
    pub owner_key: String,
    pub commit: Arc<dyn Fn(MaterialStagedFileInput, Option<&crate::materials::MaterialSourcePageInput>)
        -> crate::materials::MaterialResult<(crate::materials::ResolvedMaterialImport, serde_json::Value)> + Send + Sync>,
}

struct MediaTransferJob {
    owner_key: Option<String>,
    snapshot: MediaTransferSnapshot,
    cancel: Arc<AtomicBool>,
    updated_at: Instant,
}

struct MediaProbeRecord {
    binding: String,
    formats: HashMap<String, String>,
    created_at: Instant,
}

#[derive(Clone)]
struct ResolvedMediaFormat {
    selector: String,
    label: String,
    width: u32,
    height: u32,
    fps: u32,
    extension: String,
    video_codec: String,
    audio_codec: String,
    estimated_bytes: u64,
    bitrate: u64,
}

struct TransferOutput {
    size_bytes: u64,
    sha256: String,
    mime_type: String,
    source: String,
}

trait MediaResolver: Send + Sync {
    fn probe(
        &self,
        _request: &MediaProbeRequest,
        _scratch_dir: &Path,
        _limits: &MediaTransferLimits,
    ) -> MediaTransferResult<Vec<ResolvedMediaFormat>> {
        Err(resolver_unavailable())
    }

    fn transfer(
        &self,
        request: &MediaTransferRequest,
        format_selector: Option<&str>,
        staged_path: &Path,
        cancel: &AtomicBool,
        limits: &MediaTransferLimits,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> MediaTransferResult<TransferOutput>;
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
struct ExternalMediaResolver {
    executable: PathBuf,
    root: PathBuf,
    runner_name: OsString,
    wheel_path: PathBuf,
    ejs_wheel_path: PathBuf,
    ffmpeg_dir: PathBuf,
    deno_path: PathBuf,
    allow_loopback: bool,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl ExternalMediaResolver {
    #[cfg(test)]
    fn for_test(executable: PathBuf, root: PathBuf, runner_name: impl Into<OsString>) -> Self {
        Self {
            executable,
            wheel_path: root.join("fixture.whl"),
            ejs_wheel_path: root.join("fixture-ejs.whl"),
            ffmpeg_dir: root.clone(),
            deno_path: root.join("fixture-deno.exe"),
            root,
            runner_name: runner_name.into(),
            allow_loopback: true,
        }
    }

    fn app_owned(resource_dir: &Path) -> MediaTransferResult<Option<Self>> {
        let Some(expected_manifest_sha) = option_env!("LUCKYRAY_MEDIA_ENGINE_MANIFEST_SHA256")
        else {
            return Ok(None);
        };
        let root = resource_dir.join("media-engine");
        let manifest_path = root.join("runtime-manifest.json");
        if !root.is_dir() || !manifest_path.is_file() {
            return Ok(None);
        }
        let manifest_bytes = std::fs::read(&manifest_path).map_err(|_| resolver_unavailable())?;
        if manifest_bytes.len() > 4 * 1024 * 1024
            || format!("{:x}", Sha256::digest(&manifest_bytes)) != expected_manifest_sha
        {
            return Err(resolver_unavailable());
        }
        let manifest: MediaEngineRuntimeManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|_| resolver_unavailable())?;
        if manifest.schema_version != 1
            || manifest.files.is_empty()
            || manifest.files.len() > 512
            || manifest.python_version != "3.11.8"
            || manifest.yt_dlp_version != "2026.7.4"
            || manifest.source_manifest_sha256.len() != 64
            || !manifest
                .source_manifest_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(resolver_unavailable());
        }
        let canonical_root = root.canonicalize().map_err(|_| resolver_unavailable())?;
        let mut declared = HashSet::new();
        for entry in &manifest.files {
            let path = safe_runtime_path(&canonical_root, &entry.path)?;
            if !declared.insert(entry.path.clone()) {
                return Err(resolver_unavailable());
            }
            let metadata = std::fs::symlink_metadata(&path).map_err(|_| resolver_unavailable())?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() != entry.size
                || sha256_file(&path)? != entry.sha256
            {
                return Err(resolver_unavailable());
            }
        }
        let actual = enumerate_runtime_files(&canonical_root)?;
        if actual != declared {
            return Err(resolver_unavailable());
        }
        let runner = safe_runtime_path(&canonical_root, "runner.py")?;
        let executable = safe_runtime_path(&canonical_root, &manifest.python)?;
        let wheel_path = safe_runtime_path(&canonical_root, &manifest.yt_dlp_wheel)?;
        let ejs_wheel_path = safe_runtime_path(&canonical_root, &manifest.yt_dlp_ejs_wheel)?;
        let ffmpeg = safe_runtime_path(&canonical_root, &manifest.ffmpeg)?;
        let deno_path = safe_runtime_path(&canonical_root, &manifest.deno)?;
        if !executable.is_file()
            || !runner.is_file()
            || !wheel_path.is_file()
            || !ejs_wheel_path.is_file()
            || !ffmpeg.is_file()
            || !deno_path.is_file()
        {
            return Err(resolver_unavailable());
        }
        Ok(Some(Self {
            executable,
            root: canonical_root,
            runner_name: OsString::from("runner.py"),
            wheel_path,
            ejs_wheel_path,
            ffmpeg_dir: ffmpeg
                .parent()
                .ok_or_else(resolver_unavailable)?
                .to_path_buf(),
            deno_path,
            allow_loopback: false,
        }))
    }
}

/// Reuse the shipped media-engine inventory/manifest authority for local video.
/// This never falls back to PATH, a downloaded executable or a developer tool.
#[cfg(all(windows, feature = "browser-host-runtime"))]
pub(crate) fn verified_local_video_tools(resource_dir: &Path) -> Result<PathBuf, String> {
    ExternalMediaResolver::app_owned(resource_dir).map_err(|e|e.message)?
        .map(|runtime|runtime.ffmpeg_dir).ok_or_else(||"native-video-tools-unavailable".into())
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaEngineRuntimeManifest {
    schema_version: u32,
    source_manifest_sha256: String,
    python_version: String,
    python: String,
    yt_dlp_version: String,
    yt_dlp_wheel: String,
    yt_dlp_ejs_wheel: String,
    deno: String,
    ffmpeg: String,
    files: Vec<MediaEngineRuntimeFile>,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaEngineRuntimeFile {
    path: String,
    size: u64,
    sha256: String,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolverProbeOutput {
    formats: Vec<ResolverProbeFormat>,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolverProbeFormat {
    selector: String,
    label: String,
    width: u32,
    height: u32,
    fps: u32,
    extension: String,
    video_codec: String,
    audio_codec: String,
    estimated_bytes: u64,
    bitrate: u64,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl MediaResolver for ExternalMediaResolver {
    fn probe(
        &self,
        request: &MediaProbeRequest,
        scratch_dir: &Path,
        limits: &MediaTransferLimits,
    ) -> MediaTransferResult<Vec<ResolvedMediaFormat>> {
        validate_probe_request(request)?;
        let transfer_request = probe_as_transfer_request(request);
        let target = resolver_target_url(&transfer_request, self.allow_loopback)?;
        let deadline = Instant::now()
            .checked_add(limits.deadline.min(Duration::from_secs(60)))
            .ok_or_else(resolver_failed)?;
        let runtime_temp = scratch_dir.join(format!(".probe-{}", unique_transfer_id()));
        std::fs::create_dir(&runtime_temp).map_err(|_| resolver_failed())?;
        let output = runtime_temp.join("unused-output");
        let cookie_file = write_site_cookie_file(&runtime_temp, request.site_auth.as_ref())?;
        let mut environment = resolver_environment(
            &runtime_temp,
            &output,
            &self.wheel_path,
            &self.ejs_wheel_path,
            &self.ffmpeg_dir,
            &self.deno_path,
        )?;
        if self.allow_loopback {
            environment.push((
                OsString::from("LUCKYRAY_MEDIA_ALLOW_LOOPBACK_TEST"),
                OsString::from("1"),
            ));
        }
        if let Some(cookie_file) = cookie_file.as_ref() {
            environment.push((
                OsString::from("LUCKYRAY_MEDIA_COOKIE_FILE"),
                cookie_file.as_os_str().to_os_string(),
            ));
        }
        let arguments = vec![OsString::from("-I"), self.runner_name.clone()];
        let mut child = match crate::owned_process::spawn_in_owned_job(
            &self.executable,
            &arguments,
            &self.root,
            environment,
            false,
        ) {
            Ok(child) => child,
            Err(_) => {
                let _ = std::fs::remove_dir_all(&runtime_temp);
                return Err(resolver_unavailable());
            }
        };
        let user_agent = request
            .site_auth
            .as_ref()
            .map(|auth| auth.user_agent.as_str())
            .unwrap_or("");
        let referer = request
            .site_auth
            .as_ref()
            .map(|auth| auth.referer.as_str())
            .unwrap_or("");
        let request_body = serde_json::to_vec(&serde_json::json!({
            "operation": "probe",
            "url": target.as_str(),
            "maxBytes": limits.max_bytes,
            "deadlineSeconds": 60_u64.min(limits.deadline.as_secs()).max(1),
            "userAgent": user_agent,
            "referer": referer,
        }))
        .map_err(|_| resolver_failed())?;
        if request_body.len() > 16 * 1024
            || child.stdin.write_all(&request_body).is_err()
            || child.stdin.flush().is_err()
        {
            child.job.terminate();
            child.process.terminate();
            let _ = child.process.wait_for(Duration::from_secs(2));
            let _ = std::fs::remove_dir_all(&runtime_temp);
            return Err(resolver_failed());
        }
        drop(child.stdin);
        let stdout = std::thread::spawn(move || {
            let reader = child.stdout;
            let mut bytes = Vec::new();
            let _ = Read::take(reader, MAX_RESOLVER_PROBE_BYTES + 1).read_to_end(&mut bytes);
            bytes
        });
        let stderr = std::thread::spawn(move || {
            let mut reader = child.stderr;
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        while child.process.is_running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        if child.process.is_running() {
            child.job.terminate();
            child.process.terminate();
        } else {
            child.job.terminate();
        }
        let _ = child.process.wait_for(Duration::from_secs(2));
        let stdout_bytes = stdout.join().unwrap_or_default();
        let _ = stderr.join();
        let _ = std::fs::remove_dir_all(&runtime_temp);
        if stdout_bytes.len() > MAX_RESOLVER_PROBE_BYTES as usize {
            return Err(resolver_failed());
        }
        if let Some(error) = resolver_status_error(&stdout_bytes) {
            return Err(error);
        }
        let output: ResolverProbeOutput =
            serde_json::from_slice(&stdout_bytes).map_err(|_| resolver_failed())?;
        if output.formats.is_empty() || output.formats.len() > 16 {
            return Err(resolver_failed());
        }
        output
            .formats
            .into_iter()
            .map(validate_resolver_probe_format)
            .collect()
    }

    fn transfer(
        &self,
        request: &MediaTransferRequest,
        format_selector: Option<&str>,
        staged_path: &Path,
        cancel: &AtomicBool,
        limits: &MediaTransferLimits,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> MediaTransferResult<TransferOutput> {
        let target = resolver_target_url(request, self.allow_loopback)?;
        let deadline = Instant::now()
            .checked_add(limits.deadline)
            .ok_or_else(resolver_failed)?;
        ensure_active(cancel, deadline)?;
        if staged_path.exists() {
            std::fs::remove_file(staged_path).map_err(|_| staging_write_failed())?;
        }
        let output = staged_path
            .canonicalize()
            .or_else(|_| {
                let parent = staged_path.parent().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing parent")
                })?;
                Ok::<PathBuf, std::io::Error>(parent.canonicalize()?.join(
                    staged_path.file_name().ok_or_else(|| {
                        std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing name")
                    })?,
                ))
            })
            .map_err(|_| staging_write_failed())?;
        let temp = output
            .parent()
            .ok_or_else(staging_write_failed)?
            .to_path_buf();
        let runtime_temp = temp.join(format!(
            ".runtime-{}",
            output
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("media")
                .replace(|character: char| !character.is_ascii_alphanumeric(), "_")
        ));
        std::fs::create_dir(&runtime_temp).map_err(|_| staging_write_failed())?;
        let cookie_file = write_site_cookie_file(&runtime_temp, request.site_auth.as_ref())?;
        let mut environment = resolver_environment(
            &runtime_temp,
            &output,
            &self.wheel_path,
            &self.ejs_wheel_path,
            &self.ffmpeg_dir,
            &self.deno_path,
        )?;
        if let Some(cookie_file) = cookie_file.as_ref() {
            environment.push((
                OsString::from("LUCKYRAY_MEDIA_COOKIE_FILE"),
                cookie_file.as_os_str().to_os_string(),
            ));
        }
        let arguments = vec![OsString::from("-I"), self.runner_name.clone()];
        let spawned = crate::owned_process::spawn_in_owned_job(
            &self.executable,
            &arguments,
            &self.root,
            environment,
            false,
        );
        let mut child = match spawned {
            Ok(child) => child,
            Err(_) => {
                let _ = std::fs::remove_dir_all(&runtime_temp);
                return Err(resolver_unavailable());
            }
        };
        let user_agent = request
            .site_auth
            .as_ref()
            .map(|auth| auth.user_agent.as_str())
            .unwrap_or("");
        let referer = request
            .site_auth
            .as_ref()
            .map(|auth| auth.referer.as_str())
            .unwrap_or("");
        let request_body = serde_json::to_vec(&serde_json::json!({
            "operation": "download",
            "url": target.as_str(),
            "audioUrl": request.audio_url.as_deref(),
            "formatSelector": format_selector,
            "maxBytes": limits.max_bytes,
            "deadlineSeconds": limits.deadline.as_secs().max(1),
            "userAgent": user_agent,
            "referer": referer,
        }))
        .map_err(|_| resolver_failed())?;
        if request_body.len() > 16 * 1024 {
            child.job.terminate();
            child.process.terminate();
            let _ = child.process.wait_for(Duration::from_secs(2));
            let _ = std::fs::remove_dir_all(&runtime_temp);
            return Err(resolver_failed());
        }
        if child
            .stdin
            .write_all(&request_body)
            .and_then(|_| child.stdin.flush())
            .is_err()
        {
            child.job.terminate();
            child.process.terminate();
            let _ = child.process.wait_for(Duration::from_secs(2));
            let _ = std::fs::remove_dir_all(&runtime_temp);
            return Err(resolver_failed());
        }
        drop(child.stdin);
        let stdout = std::thread::spawn(move || {
            let reader = child.stdout;
            let mut bytes = Vec::new();
            let _ = Read::take(reader, MAX_RESOLVER_STATUS_BYTES + 1).read_to_end(&mut bytes);
            bytes
        });
        let stderr = std::thread::spawn(move || {
            let mut reader = child.stderr;
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        let terminal = loop {
            match ensure_active(cancel, deadline) {
                Ok(()) if child.process.is_running() => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Ok(()) => break Ok(()),
                Err(error) => break Err(error),
            }
        };
        if terminal.is_err() || child.process.is_running() {
            child.job.terminate();
            child.process.terminate();
        } else {
            // A successful resolver must not leave helper descendants behind.
            child.job.terminate();
            let _ = child.process.wait_for(Duration::from_secs(2));
        }
        let stdout_bytes = stdout.join().unwrap_or_default();
        let _ = stderr.join();
        let _ = std::fs::remove_dir_all(&runtime_temp);
        terminal?;
        ensure_active(cancel, deadline)?;
        if !output.is_file() {
            if let Some(error) = resolver_status_error(&stdout_bytes) {
                return Err(error);
            }
        }
        let (size_bytes, sha256, mime_type) = verify_resolved_output(&output, limits.max_bytes)?;
        progress(size_bytes, Some(size_bytes));
        let source = safe_source_projection(request.source_page_url.as_deref(), &target)?;
        Ok(TransferOutput {
            size_bytes,
            sha256,
            mime_type,
            source,
        })
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn write_site_cookie_file(
    temp: &Path,
    auth: Option<&MediaSiteAuth>,
) -> MediaTransferResult<Option<PathBuf>> {
    let Some(auth) = auth else {
        return Ok(None);
    };
    if auth.cookies.is_empty() {
        return Ok(None);
    }
    let path = temp.join("site-cookies.txt");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| staging_write_failed())?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(b"# Netscape HTTP Cookie File\n")
        .map_err(|_| staging_write_failed())?;
    for cookie in &auth.cookies {
        let domain = if cookie.http_only {
            format!("#HttpOnly_{}", cookie.domain)
        } else {
            cookie.domain.clone()
        };
        let include_subdomains = if cookie.domain.starts_with('.') {
            "TRUE"
        } else {
            "FALSE"
        };
        let secure = if cookie.secure { "TRUE" } else { "FALSE" };
        writeln!(
            writer,
            "{domain}\t{include_subdomains}\t{}\t{secure}\t{}\t{}\t{}",
            cookie.path, cookie.expires, cookie.name, cookie.value
        )
        .map_err(|_| staging_write_failed())?;
    }
    writer.flush().map_err(|_| staging_write_failed())?;
    Ok(Some(path))
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn resolver_environment(
    temp: &Path,
    output: &Path,
    wheel: &Path,
    ejs_wheel: &Path,
    ffmpeg_dir: &Path,
    deno: &Path,
) -> MediaTransferResult<Vec<(OsString, OsString)>> {
    let mut environment = Vec::new();
    let deno_cache = temp.join("deno-cache");
    std::fs::create_dir(&deno_cache).map_err(|_| staging_write_failed())?;
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            environment.push((OsString::from(key), value));
        }
    }
    for (key, value) in [
        ("TEMP", temp.as_os_str()),
        ("TMP", temp.as_os_str()),
        ("HOME", temp.as_os_str()),
        ("USERPROFILE", temp.as_os_str()),
        ("LOCALAPPDATA", temp.as_os_str()),
        ("APPDATA", temp.as_os_str()),
        ("DENO_DIR", deno_cache.as_os_str()),
        ("LUCKYRAY_MEDIA_OUTPUT", output.as_os_str()),
        ("LUCKYRAY_MEDIA_WHEEL", wheel.as_os_str()),
        ("LUCKYRAY_MEDIA_EJS_WHEEL", ejs_wheel.as_os_str()),
        ("LUCKYRAY_MEDIA_FFMPEG_DIR", ffmpeg_dir.as_os_str()),
        ("LUCKYRAY_MEDIA_DENO", deno.as_os_str()),
        ("PYTHONNOUSERSITE", OsStr::new("1")),
        ("PYTHONDONTWRITEBYTECODE", OsStr::new("1")),
    ] {
        environment.push((OsString::from(key), value.to_os_string()));
    }
    Ok(environment)
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn safe_runtime_path(root: &Path, relative: &str) -> MediaTransferResult<PathBuf> {
    if relative.is_empty()
        || relative.len() > 260
        || relative.contains('\\')
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(resolver_unavailable());
    }
    let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    let canonical = path.canonicalize().map_err(|_| resolver_unavailable())?;
    if !canonical.starts_with(root) {
        return Err(resolver_unavailable());
    }
    Ok(canonical)
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn enumerate_runtime_files(root: &Path) -> MediaTransferResult<HashSet<String>> {
    let mut files = HashSet::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|_| resolver_unavailable())? {
            let entry = entry.map_err(|_| resolver_unavailable())?;
            let metadata =
                std::fs::symlink_metadata(entry.path()).map_err(|_| resolver_unavailable())?;
            if metadata.file_type().is_symlink() {
                return Err(resolver_unavailable());
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| resolver_unavailable())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative != "runtime-manifest.json" {
                    files.insert(relative);
                }
            } else {
                return Err(resolver_unavailable());
            }
        }
    }
    Ok(files)
}

fn sha256_file(path: &Path) -> MediaTransferResult<String> {
    let mut file = File::open(path).map_err(|_| resolver_unavailable())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; READ_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(|_| resolver_unavailable())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn resolver_target_url(
    request: &MediaTransferRequest,
    allow_loopback: bool,
) -> MediaTransferResult<Url> {
    let request_url = Url::parse(&request.url).map_err(|_| resolver_unsupported())?;
    if request.audio_url.is_some() && validate_track_pair(request) {
        return Ok(request_url);
    }
    let request_host = normalized_host(&request_url).unwrap_or_default();
    let source_url = request
        .source_page_url
        .as_deref()
        .and_then(|raw| Url::parse(raw).ok());
    let supported = [
        "youtube.com",
        "youtu.be",
        "bilibili.com",
        "b23.tv",
        "x.com",
        "twitter.com",
        "pinterest.com",
        "pinimg.com",
    ];
    // A supported request URL is the extension's exact, validated video page (or
    // a concrete pinimg media URL). Never replace it with a surrounding feed.
    // CDN URLs outside the supported set still fall back to their source page so
    // yt-dlp receives the extractor context instead of an expiring media URL.
    let prefer_request_url = is_supported_host(&request_host, &supported)
        || (allow_loopback && matches!(request_host.as_str(), "127.0.0.1" | "::1"));
    let url = if prefer_request_url {
        request_url
    } else {
        source_url.unwrap_or(request_url)
    };
    let host = normalized_host(&url).ok_or_else(resolver_unsupported)?;
    let site_allowed = is_supported_host(&host, &supported);
    let loopback_allowed = allow_loopback && matches!(host.as_str(), "127.0.0.1" | "::1");
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || (!site_allowed && !loopback_allowed)
    {
        return Err(resolver_unsupported());
    }
    Ok(url)
}

fn normalized_host(url: &Url) -> Option<String> {
    url.host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
}

fn is_supported_host(host: &str, suffixes: &[&str]) -> bool {
    suffixes
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

fn verify_resolved_output(
    path: &Path,
    max_bytes: u64,
) -> MediaTransferResult<(u64, String, String)> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| resolver_failed())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max_bytes {
        return Err(if metadata.len() > max_bytes {
            too_large()
        } else {
            resolver_failed()
        });
    }
    let mut file = File::open(path).map_err(|_| resolver_failed())?;
    let mut hasher = Sha256::new();
    let mut prefix = Vec::with_capacity(512);
    let mut bytes = 0u64;
    let mut buffer = [0u8; READ_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(|_| resolver_failed())?;
        if read == 0 {
            break;
        }
        bytes = bytes.checked_add(read as u64).ok_or_else(too_large)?;
        if bytes > max_bytes {
            return Err(too_large());
        }
        hasher.update(&buffer[..read]);
        if prefix.len() < 512 {
            let take = (512 - prefix.len()).min(read);
            prefix.extend_from_slice(&buffer[..take]);
        }
    }
    let mime_type = detect_media_container(&prefix)?.to_owned();
    validate_complete_media(&mut file, bytes, &mime_type)?;
    Ok((bytes, format!("{:x}", hasher.finalize()), mime_type))
}

fn validate_complete_media(
    file: &mut File,
    size_bytes: u64,
    mime_type: &str,
) -> MediaTransferResult<()> {
    if mime_type != "video/mp4" {
        return Ok(());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| invalid_container())?;
    let mut position = 0u64;
    let mut has_media_data = false;
    while position < size_bytes {
        let remaining = size_bytes
            .checked_sub(position)
            .ok_or_else(invalid_container)?;
        if remaining < 8 {
            return Err(invalid_container());
        }
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|_| invalid_container())?;
        let declared = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let mut header_bytes = 8u64;
        let box_bytes = match declared {
            0 => remaining,
            1 => {
                let mut extended = [0u8; 8];
                file.read_exact(&mut extended)
                    .map_err(|_| invalid_container())?;
                header_bytes = 16;
                u64::from_be_bytes(extended)
            }
            value => value,
        };
        if box_bytes < header_bytes || box_bytes > remaining {
            return Err(invalid_container());
        }
        if &header[4..8] == b"mdat" && box_bytes > header_bytes {
            has_media_data = true;
        }
        position = position
            .checked_add(box_bytes)
            .ok_or_else(invalid_container)?;
        file.seek(SeekFrom::Start(position))
            .map_err(|_| invalid_container())?;
    }
    if has_media_data {
        Ok(())
    } else {
        Err(invalid_container())
    }
}

fn resolver_unavailable() -> MediaTransferError {
    MediaTransferError::new(
        "media-resolver-unavailable",
        "The media resolver is unavailable",
    )
}

fn resolver_unsupported() -> MediaTransferError {
    MediaTransferError::new(
        "media-resolver-unsupported",
        "This site is not supported by the media resolver",
    )
}

fn resolver_failed() -> MediaTransferError {
    MediaTransferError::new("media-resolver-failed", "Media resolution failed")
}

fn probe_expired() -> MediaTransferError {
    MediaTransferError::new(
        "media-probe-expired",
        "The media format selection has expired",
    )
}

fn probe_as_transfer_request(request: &MediaProbeRequest) -> MediaTransferRequest {
    MediaTransferRequest {
        url: request.url.clone(),
        audio_url: None,
        file_name: "probe.mp4".to_owned(),
        mime_type: None,
        source_page_url: request.source_page_url.clone(),
        target_folder_id: None,
        new_folder_name: None,
        parent_folder_id: None,
        site_auth: request.site_auth.clone(),
    }
}

fn validate_probe_request(request: &MediaProbeRequest) -> MediaTransferResult<()> {
    validate_request(&probe_as_transfer_request(request))
}

fn probe_binding(request: &MediaProbeRequest) -> MediaTransferResult<String> {
    validate_probe_request(request)?;
    let bytes = serde_json::to_vec(request).map_err(|_| resolver_failed())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn validate_resolver_probe_format(
    value: ResolverProbeFormat,
) -> MediaTransferResult<ResolvedMediaFormat> {
    let safe_text = |text: &str, max: usize| {
        !text.is_empty()
            && text.len() <= max
            && text.chars().all(|character| !character.is_control())
    };
    if !safe_text(&value.selector, 256)
        || !value.selector.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-' | b'/')
        })
        || !safe_text(&value.label, 128)
        || !safe_text(&value.extension, 8)
        || !safe_text(&value.video_codec, 48)
        || !safe_text(&value.audio_codec, 48)
        || value.width > 16_384
        || value.height == 0
        || value.height > 16_384
        || value.fps > 1_000
        || value.estimated_bytes > DEFAULT_MAX_BYTES
        || value.bitrate > 1_000_000_000
    {
        return Err(resolver_failed());
    }
    Ok(ResolvedMediaFormat {
        selector: value.selector,
        label: value.label,
        width: value.width,
        height: value.height,
        fps: value.fps,
        extension: value.extension,
        video_codec: value.video_codec,
        audio_codec: value.audio_codec,
        estimated_bytes: value.estimated_bytes,
        bitrate: value.bitrate,
    })
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn resolver_status_error(bytes: &[u8]) -> Option<MediaTransferError> {
    if bytes.len() > MAX_RESOLVER_STATUS_BYTES as usize {
        return None;
    }
    let status = std::str::from_utf8(bytes).ok()?.trim();
    let (code, message) = match status {
        "luckyray-media-status-v1:authentication-required" => (
            "media-authentication-required",
            "The media site requires authentication",
        ),
        "luckyray-media-status-v1:site-blocked" => (
            "media-site-blocked",
            "The media site rejected automated retrieval",
        ),
        "luckyray-media-status-v1:region-restricted" => (
            "media-region-restricted",
            "The media is unavailable in this region",
        ),
        "luckyray-media-status-v1:drm-protected" => {
            ("media-drm-protected", "The media is DRM protected")
        }
        "luckyray-media-status-v1:no-formats" => (
            "media-no-formats",
            "The media site exposed no downloadable formats",
        ),
        _ => return None,
    };
    Some(MediaTransferError::new(code, message))
}

struct OutputSink {
    writer: BufWriter<File>,
    path: PathBuf,
    hasher: Sha256,
    bytes: u64,
    max_bytes: u64,
    keep: bool,
    prefix: Vec<u8>,
}

impl MediaTransferService {
    pub(crate) fn new(
        app_data_dir: impl AsRef<Path>,
        catalog: MaterialCatalog,
    ) -> MediaTransferResult<Self> {
        let limits = MediaTransferLimits::production();
        Self::with_parts(
            app_data_dir.as_ref().join("media-transfer-staging"),
            SafeHttpClient::production(limits.io_timeout),
            None,
            limits,
            catalog,
            Arc::new(crate::emit_catalog_change_global),
        )
    }

    pub(crate) fn with_app_owned_resolver(&self, _resource_dir: &Path) -> Self {
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        if let Ok(Some(resolver)) = ExternalMediaResolver::app_owned(_resource_dir) {
            if let Ok(service) = Self::with_parts(
                self.inner.staging_dir.clone(),
                self.inner.http.clone(),
                Some(Arc::new(resolver)),
                self.inner.limits.clone(),
                self.inner.catalog.clone(),
                Arc::clone(&self.inner.catalog_change_sink),
            ) {
                return service;
            }
        }
        self.clone()
    }

    #[cfg(test)]
    pub(crate) fn with_loopback_http_for_test(&self) -> Self {
        Self::with_parts(self.inner.staging_dir.clone(),
            SafeHttpClient::loopback_for_test(self.inner.limits.io_timeout), None,
            self.inner.limits.clone(), self.inner.catalog.clone(), Arc::new(|_| {})).unwrap()
    }

    #[cfg(test)]
    fn new_for_test(
        app_data_dir: impl AsRef<Path>,
        catalog: MaterialCatalog,
        limits: MediaTransferLimits,
    ) -> Self {
        Self::new_for_test_with_change_sink(app_data_dir, catalog, limits, Arc::new(|_| {}))
    }

    #[cfg(test)]
    fn new_for_test_with_change_sink(
        app_data_dir: impl AsRef<Path>,
        catalog: MaterialCatalog,
        limits: MediaTransferLimits,
        catalog_change_sink: CatalogChangeSink,
    ) -> Self {
        Self::with_parts(
            app_data_dir.as_ref().join("media-transfer-staging"),
            SafeHttpClient::loopback_for_test(limits.io_timeout),
            None,
            limits,
            catalog,
            catalog_change_sink,
        )
        .unwrap()
    }

    #[cfg(test)]
    fn new_for_test_with_resolver(
        app_data_dir: impl AsRef<Path>,
        catalog: MaterialCatalog,
        limits: MediaTransferLimits,
        resolver: Arc<dyn MediaResolver>,
    ) -> Self {
        Self::with_parts(
            app_data_dir.as_ref().join("media-transfer-staging"),
            SafeHttpClient::loopback_for_test(limits.io_timeout),
            Some(resolver),
            limits,
            catalog,
            Arc::new(|_| {}),
        )
        .unwrap()
    }

    fn with_parts(
        staging_dir: PathBuf,
        http: SafeHttpClient,
        resolver: Option<Arc<dyn MediaResolver>>,
        limits: MediaTransferLimits,
        catalog: MaterialCatalog,
        catalog_change_sink: CatalogChangeSink,
    ) -> MediaTransferResult<Self> {
        let staging_dir = crate::materials::resolve_media_staging_root(&staging_dir).map_err(|_| {
            MediaTransferError::new("media-staging-unavailable", "Media staging is unavailable")
        })?;
        Ok(Self {
            inner: Arc::new(MediaTransferInner {
                staging_dir,
                http,
                resolver,
                limits,
                catalog,
                catalog_change_sink,
                jobs: Mutex::new(HashMap::new()),
                probes: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub(crate) fn probe(
        &self,
        request: MediaProbeRequest,
    ) -> MediaTransferResult<MediaProbeSnapshot> {
        validate_probe_request(&request)?;
        let resolver = self
            .inner
            .resolver
            .as_deref()
            .ok_or_else(resolver_unavailable)?;
        let resolved = resolver.probe(&request, &self.inner.staging_dir, &self.inner.limits)?;
        if resolved.is_empty() || resolved.len() > 16 {
            return Err(resolver_failed());
        }
        let probe_id = unique_probe_id();
        let mut formats = HashMap::new();
        let mut public = Vec::with_capacity(resolved.len());
        for format in resolved {
            let format_id = unique_format_id();
            if formats.insert(format_id.clone(), format.selector).is_some() {
                return Err(resolver_failed());
            }
            public.push(MediaFormatOption {
                format_id,
                label: format.label,
                width: format.width,
                height: format.height,
                fps: format.fps,
                extension: format.extension,
                video_codec: format.video_codec,
                audio_codec: format.audio_codec,
                estimated_bytes: format.estimated_bytes,
                bitrate: format.bitrate,
            });
        }
        let mut probes = self.inner.probes.lock().map_err(|_| capacity_error())?;
        prune_probes(&mut probes);
        if probes.len() >= DEFAULT_PROBE_CAP {
            return Err(capacity_error());
        }
        probes.insert(
            probe_id.clone(),
            MediaProbeRecord {
                binding: probe_binding(&request)?,
                formats,
                created_at: Instant::now(),
            },
        );
        Ok(MediaProbeSnapshot {
            probe_id,
            formats: public,
        })
    }

    #[cfg(test)]
    pub(crate) fn start(
        &self,
        request: MediaTransferRequest,
    ) -> MediaTransferResult<MediaTransferSnapshot> {
        self.start_selected(request, None, None)
    }

    pub(crate) fn start_selected(
        &self,
        request: MediaTransferRequest,
        probe_id: Option<&str>,
        format_id: Option<&str>,
    ) -> MediaTransferResult<MediaTransferSnapshot> {
        self.start_selected_with_source(request, probe_id, format_id, None)
    }

    pub(crate) fn start_selected_with_source(
        &self,
        request: MediaTransferRequest,
        probe_id: Option<&str>,
        format_id: Option<&str>,
        source_page: Option<crate::materials::MaterialSourcePageInput>,
    ) -> MediaTransferResult<MediaTransferSnapshot> {
        self.start_selected_with_destination(request, probe_id, format_id, source_page, None)
    }

    pub(crate) fn start_selected_with_destination(
        &self, request: MediaTransferRequest, probe_id: Option<&str>, format_id: Option<&str>,
        source_page: Option<crate::materials::MaterialSourcePageInput>,
        destination: Option<MediaTransferDestination>,
    ) -> MediaTransferResult<MediaTransferSnapshot> {
        validate_request(&request)?;
        let format_selector = match (probe_id, format_id) {
            (None, None) => None,
            (Some(probe_id), Some(format_id)) => {
                let probe_request = MediaProbeRequest {
                    url: request.url.clone(),
                    source_page_url: request.source_page_url.clone(),
                    site_auth: request.site_auth.clone(),
                };
                let binding = probe_binding(&probe_request)?;
                let mut probes = self.inner.probes.lock().map_err(|_| capacity_error())?;
                prune_probes(&mut probes);
                let probe = probes.get(probe_id).ok_or_else(probe_expired)?;
                if probe.binding != binding {
                    return Err(probe_expired());
                }
                Some(
                    probe
                        .formats
                        .get(format_id)
                        .cloned()
                        .ok_or_else(probe_expired)?,
                )
            }
            _ => {
                return Err(MediaTransferError::new(
                    "media-input-invalid",
                    "Media transfer input is invalid",
                ))
            }
        };
        let transfer_id = unique_transfer_id();
        let file_name = safe_file_name(&request.file_name);
        let snapshot = MediaTransferSnapshot {
            transfer_id: transfer_id.clone(),
            state: MediaTransferState::Queued,
            bytes_received: 0,
            total_bytes: None,
            file_name: file_name.clone(),
            mime_type: request.mime_type.clone().unwrap_or_default(),
            asset_id: None,
            asset_name: None,
            asset_kind: None,
            skipped_duplicate: false,
            error_code: None,
            library_id: destination.as_ref().map(|d| d.library_id.clone()),
            request_id: destination.as_ref().map(|d| d.request_id.clone()),
            receipt: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.inner.jobs.lock().map_err(|_| capacity_error())?;
            prune_jobs(&mut jobs, &self.inner.limits);
            let active = jobs
                .values()
                .filter(|job| !is_terminal(job.snapshot.state))
                .count();
            if active >= self.inner.limits.active_cap {
                return Err(capacity_error());
            }
            jobs.insert(
                transfer_id.clone(),
                MediaTransferJob {
                    owner_key: destination.as_ref().map(|d| d.owner_key.clone()),
                    snapshot: snapshot.clone(),
                    cancel: Arc::clone(&cancel),
                    updated_at: Instant::now(),
                },
            );
        }

        let service = self.clone();
        std::thread::spawn(move || {
            service.update_snapshot(&transfer_id, |snapshot| {
                snapshot.state = MediaTransferState::Running;
            });
            let staged_path = service
                .inner
                .staging_dir
                .join(format!("{transfer_id}.part"));
            let result = run_transfer(
                &service.inner.http,
                service.inner.resolver.as_deref(),
                &request,
                format_selector.as_deref(),
                &staged_path,
                &cancel,
                &service.inner.limits,
                |received, total| {
                    service.update_snapshot(&transfer_id, |snapshot| {
                        snapshot.bytes_received = received;
                        snapshot.total_bytes = total;
                    });
                },
            );
            match result {
                Ok(output) => {
                    if !service.begin_import(&transfer_id, &cancel, &output) {
                        let _ = std::fs::remove_file(staged_path);
                        return;
                    }
                    let staged = MaterialStagedFileInput {
                        path: staged_path.clone(), name: file_name_for_mime(&file_name, &output.mime_type),
                        original_source: output.source, mime_type: output.mime_type, description: None,
                        expected_size_bytes: output.size_bytes, expected_sha256: output.sha256,
                    };
                    let imported = if let Some(destination) = &destination {
                        (destination.commit)(staged, source_page.as_ref()).map(|(asset, receipt)| (asset, Some(receipt)))
                    } else {
                        resolve_import_folder(&service.inner.catalog, &request, &service.inner.catalog_change_sink)
                            .and_then(|folder_id| crate::materials::import_staged_download_with_source(
                                &service.inner.catalog, staged,
                                &MaterialImportOptions { folder_id, ..Default::default() }, source_page.as_ref()))
                            .map(|asset| (asset, None))
                    };
                    if imported.is_err() { let _ = std::fs::remove_file(&staged_path); }
                    let catalog_change = imported
                        .as_ref()
                        .ok()
                        .and_then(|(outcome, _)| outcome.change.clone());
                    let mut jobs = match service.inner.jobs.lock() {
                        Ok(jobs) => jobs,
                        Err(_) => return,
                    };
                    let Some(job) = jobs.get_mut(&transfer_id) else {
                        return;
                    };
                    job.updated_at = Instant::now();
                    match imported {
                        Ok((imported, receipt)) => {
                            job.snapshot.receipt = receipt;
                            job.snapshot.state = MediaTransferState::Completed;
                            job.snapshot.asset_id = Some(imported.asset.id);
                            job.snapshot.asset_name = Some(imported.asset.name);
                            job.snapshot.asset_kind = Some(imported.asset.kind);
                            job.snapshot.skipped_duplicate = imported.skipped_duplicate;
                        }
                        Err(error) => {
                            job.snapshot.state = MediaTransferState::Failed;
                            job.snapshot.error_code = Some(error.code);
                        }
                    }
                    prune_jobs(&mut jobs, &service.inner.limits);
                    drop(jobs);
                    if catalog_change.is_some() {
                        (service.inner.catalog_change_sink)(&catalog_change);
                    }
                }
                Err(error) => {
                    let _ = std::fs::remove_file(staged_path);
                    let mut jobs = match service.inner.jobs.lock() {
                        Ok(jobs) => jobs,
                        Err(_) => return,
                    };
                    let Some(job) = jobs.get_mut(&transfer_id) else {
                        return;
                    };
                    job.updated_at = Instant::now();
                    let cancelled =
                        cancel.load(Ordering::Acquire) || error.code == "media-cancelled";
                    job.snapshot.state = if cancelled {
                        MediaTransferState::Cancelled
                    } else {
                        MediaTransferState::Failed
                    };
                    job.snapshot.error_code = Some(if cancelled {
                        "media-cancelled".to_owned()
                    } else {
                        error.code
                    });
                    prune_jobs(&mut jobs, &service.inner.limits);
                }
            }
        });
        Ok(snapshot)
    }

    pub(crate) fn destination_scope(&self, transfer_id: &str) -> MediaTransferResult<Option<(String, String, String)>> {
        validate_transfer_id(transfer_id)?;
        let jobs = self.inner.jobs.lock().map_err(|_| capacity_error())?;
        let job = jobs.get(transfer_id).ok_or_else(not_found)?;
        Ok(job.owner_key.as_ref().and_then(|owner| Some((job.snapshot.library_id.clone()?,
            job.snapshot.request_id.clone()?, owner.clone()))))
    }

    pub(crate) fn status(&self, transfer_id: &str) -> MediaTransferResult<MediaTransferSnapshot> {
        validate_transfer_id(transfer_id)?;
        let mut jobs = self.inner.jobs.lock().map_err(|_| capacity_error())?;
        prune_jobs(&mut jobs, &self.inner.limits);
        jobs.get(transfer_id)
            .map(|job| job.snapshot.clone())
            .ok_or_else(not_found)
    }

    pub(crate) fn cancel(&self, transfer_id: &str) -> MediaTransferResult<MediaTransferSnapshot> {
        validate_transfer_id(transfer_id)?;
        let mut jobs = self.inner.jobs.lock().map_err(|_| capacity_error())?;
        prune_jobs(&mut jobs, &self.inner.limits);
        let job = jobs.get_mut(transfer_id).ok_or_else(not_found)?;
        if matches!(
            job.snapshot.state,
            MediaTransferState::Queued | MediaTransferState::Running
        ) {
            job.cancel.store(true, Ordering::Release);
            job.snapshot.state = MediaTransferState::Cancelling;
            job.updated_at = Instant::now();
        } else if job.snapshot.state == MediaTransferState::Importing {
            return Err(MediaTransferError::new(
                "media-cancel-too-late",
                "Media transfer is already importing",
            ));
        }
        Ok(job.snapshot.clone())
    }

    fn begin_import(
        &self,
        transfer_id: &str,
        cancel: &AtomicBool,
        output: &TransferOutput,
    ) -> bool {
        let Ok(mut jobs) = self.inner.jobs.lock() else {
            return false;
        };
        let Some(job) = jobs.get_mut(transfer_id) else {
            return false;
        };
        job.updated_at = Instant::now();
        if cancel.load(Ordering::Acquire) {
            job.snapshot.state = MediaTransferState::Cancelled;
            job.snapshot.error_code = Some("media-cancelled".to_owned());
            return false;
        }
        job.snapshot.state = MediaTransferState::Importing;
        job.snapshot.bytes_received = output.size_bytes;
        job.snapshot.total_bytes = Some(output.size_bytes);
        job.snapshot.mime_type = output.mime_type.clone();
        true
    }

    fn update_snapshot(&self, transfer_id: &str, update: impl FnOnce(&mut MediaTransferSnapshot)) {
        if let Ok(mut jobs) = self.inner.jobs.lock() {
            if let Some(job) = jobs.get_mut(transfer_id) {
                update(&mut job.snapshot);
                job.updated_at = Instant::now();
            }
        }
    }
}

impl MediaTransferLimits {
    fn production() -> Self {
        Self {
            active_cap: DEFAULT_ACTIVE_CAP,
            terminal_cap: DEFAULT_TERMINAL_CAP,
            terminal_ttl: DEFAULT_TERMINAL_TTL,
            max_bytes: DEFAULT_MAX_BYTES,
            deadline: DEFAULT_DEADLINE,
            redirect_cap: DEFAULT_REDIRECT_CAP,
            segment_cap: DEFAULT_SEGMENT_CAP,
            duration_cap_secs: DEFAULT_DURATION_CAP_SECS,
            io_timeout: DEFAULT_IO_TIMEOUT,
        }
    }
}

fn resolve_import_folder(
    catalog: &MaterialCatalog,
    request: &MediaTransferRequest,
    catalog_change_sink: &CatalogChangeSink,
) -> MaterialResult<Option<String>> {
    let Some(name) = request.new_folder_name.as_deref() else {
        return Ok(request.target_folder_id.clone());
    };
    let created = catalog.create_folder(MaterialFolderInput {
        parent_id: request.parent_folder_id.clone(),
        name: name.to_owned(),
    })?;
    catalog_change_sink(&created.change);
    Ok(Some(created.value.id))
}

impl OutputSink {
    fn create(path: &Path, max_bytes: u64) -> MediaTransferResult<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| {
                MediaTransferError::new("media-staging-unavailable", "Media staging is unavailable")
            })?;
        Ok(Self {
            writer: BufWriter::new(file),
            path: path.to_path_buf(),
            hasher: Sha256::new(),
            bytes: 0,
            max_bytes,
            keep: false,
            prefix: Vec::with_capacity(512),
        })
    }

    fn append_response(
        &mut self,
        mut response: SafeHttpBody,
        cancel: &AtomicBool,
        deadline: Instant,
        total_hint: Option<u64>,
        progress: &mut impl FnMut(u64, Option<u64>),
    ) -> MediaTransferResult<()> {
        ensure_success_and_identity(&response)?;
        if let Some(length) = content_length(&response)? {
            let projected = self.bytes.checked_add(length).ok_or_else(too_large)?;
            if projected > self.max_bytes {
                return Err(too_large());
            }
        }
        let mut buffer = [0u8; READ_BUFFER_BYTES];
        loop {
            ensure_active(cancel, deadline)?;
            let read = response.read(&mut buffer).map_err(|_| network_failed())?;
            if read == 0 {
                break;
            }
            let next = self.bytes.checked_add(read as u64).ok_or_else(too_large)?;
            if next > self.max_bytes {
                return Err(too_large());
            }
            self.writer
                .write_all(&buffer[..read])
                .map_err(|_| staging_write_failed())?;
            self.hasher.update(&buffer[..read]);
            if self.prefix.len() < 512 {
                let take = (512 - self.prefix.len()).min(read);
                self.prefix.extend_from_slice(&buffer[..take]);
            }
            self.bytes = next;
            progress(self.bytes, total_hint);
        }
        Ok(())
    }

    fn finish(mut self) -> MediaTransferResult<(u64, String, String)> {
        self.writer.flush().map_err(|_| staging_write_failed())?;
        self.writer
            .get_ref()
            .sync_all()
            .map_err(|_| staging_write_failed())?;
        let mime_type = detect_media_container(&self.prefix)?;
        validate_complete_media(self.writer.get_mut(), self.bytes, mime_type)?;
        self.keep = true;
        Ok((
            self.bytes,
            format!("{:x}", self.hasher.clone().finalize()),
            mime_type.to_owned(),
        ))
    }
}

impl Drop for OutputSink {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn run_transfer(
    http: &SafeHttpClient,
    resolver: Option<&dyn MediaResolver>,
    request: &MediaTransferRequest,
    format_selector: Option<&str>,
    staged_path: &Path,
    cancel: &AtomicBool,
    limits: &MediaTransferLimits,
    mut progress: impl FnMut(u64, Option<u64>),
) -> MediaTransferResult<TransferOutput> {
    if request.audio_url.is_some() || format_selector.is_some() {
        return resolver.ok_or_else(resolver_unavailable)?.transfer(
            request,
            format_selector,
            staged_path,
            cancel,
            limits,
            &mut progress,
        );
    }
    match run_direct_transfer(http, request, staged_path, cancel, limits, &mut progress) {
        Err(error)
            if matches!(
                error.code.as_str(),
                "media-needs-recording"
                    | "media-hls-unsupported"
                    | "media-hls-live-unsupported"
                    | "media-http-unavailable"
                    | "media-network-failed"
                    | "media-container-invalid"
            ) && resolver.is_some() =>
        {
            let fallback = resolver.unwrap().transfer(
                request,
                format_selector,
                staged_path,
                cancel,
                limits,
                &mut progress,
            );
            match fallback {
                // An unsupported fallback did not inspect this source, so it
                // cannot explain away the direct request's network failure.
                Err(fallback_error)
                    if fallback_error.code == "media-resolver-unsupported"
                        && matches!(
                            error.code.as_str(),
                            "media-http-unavailable" | "media-network-failed"
                        ) =>
                {
                    Err(error)
                }
                result => result,
            }
        }
        result => result,
    }
}

fn run_direct_transfer(
    http: &SafeHttpClient,
    request: &MediaTransferRequest,
    staged_path: &Path,
    cancel: &AtomicBool,
    limits: &MediaTransferLimits,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> MediaTransferResult<TransferOutput> {
    let deadline = Instant::now()
        .checked_add(limits.deadline)
        .ok_or_else(network_failed)?;
    ensure_active(cancel, deadline)?;
    let initial = http
        .get(
            &request.url,
            deadline,
            limits.redirect_cap,
            "video/*,application/vnd.apple.mpegurl,application/x-mpegURL,application/dash+xml,application/octet-stream;q=0.8",
        )
        .map_err(map_web_error)?;
    ensure_success_and_identity(&initial.response)?;
    let content_type = response_content_type(&initial.response);
    if is_dash(&initial.final_url, &content_type) {
        return Err(needs_recording());
    }
    let source = safe_source_projection(request.source_page_url.as_deref(), &initial.final_url)?;
    if is_hls(&initial.final_url, &content_type) {
        let master_text = read_small_text(initial.response, cancel, deadline)?;
        let (playlist_url, playlist_text) = match parse_master_playlist(&master_text)? {
            Some(reference) => {
                ensure_active(cancel, deadline)?;
                let response = http
                    .get_relative(
                        &initial.final_url,
                        &reference,
                        deadline,
                        limits.redirect_cap,
                        "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain",
                    )
                    .map_err(map_web_error)?;
                ensure_success_and_identity(&response.response)?;
                let final_url = response.final_url;
                let text = read_small_text(response.response, cancel, deadline)?;
                (final_url, text)
            }
            None => (initial.final_url, master_text),
        };
        let playlist = parse_media_playlist(&playlist_text, limits)?;
        let mut sink = OutputSink::create(staged_path, limits.max_bytes)?;
        if let Some(map) = playlist.init {
            ensure_active(cancel, deadline)?;
            let response = http
                .get_relative(
                    &playlist_url,
                    &map,
                    deadline,
                    limits.redirect_cap,
                    "video/mp4,application/octet-stream",
                )
                .map_err(map_web_error)?;
            sink.append_response(response.response, cancel, deadline, None, progress)?;
        }
        for segment in playlist.segments {
            ensure_active(cancel, deadline)?;
            let response = http
                .get_relative(
                    &playlist_url,
                    &segment,
                    deadline,
                    limits.redirect_cap,
                    "video/*,application/octet-stream",
                )
                .map_err(map_web_error)?;
            sink.append_response(response.response, cancel, deadline, None, progress)?;
        }
        ensure_active(cancel, deadline)?;
        let (size_bytes, sha256, detected_mime) = sink.finish()?;
        return Ok(TransferOutput {
            size_bytes,
            sha256,
            mime_type: detected_mime,
            source,
        });
    }

    let total = content_length(&initial.response)?;
    if total.is_some_and(|length| length > limits.max_bytes) {
        return Err(too_large());
    }
    let mut sink = OutputSink::create(staged_path, limits.max_bytes)?;
    sink.append_response(initial.response, cancel, deadline, total, progress)?;
    ensure_active(cancel, deadline)?;
    let (size_bytes, sha256, detected_mime) = sink.finish()?;
    Ok(TransferOutput {
        size_bytes,
        sha256,
        mime_type: detected_mime,
        source,
    })
}

struct MediaPlaylist {
    init: Option<String>,
    segments: Vec<String>,
}

fn parse_master_playlist(body: &str) -> MediaTransferResult<Option<String>> {
    require_m3u_header(body)?;
    let lines = normalized_playlist_lines(body)?;
    if lines.iter().any(|line| {
        line.starts_with("#EXT-X-KEY:")
            || line.starts_with("#EXT-X-SESSION-KEY:")
            || line.starts_with("#EXT-X-BYTERANGE:")
            || line.starts_with("#EXT-X-DISCONTINUITY")
    }) {
        return Err(unsupported_hls());
    }
    let mut best: Option<(u64, String)> = None;
    let mut pending_bandwidth = None;
    for line in lines {
        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            if attributes
                .split(',')
                .any(|part| part.trim_start().starts_with("AUDIO="))
            {
                return Err(unsupported_hls());
            }
            pending_bandwidth = Some(parse_bandwidth(attributes)?);
        } else if !line.starts_with('#') && !line.is_empty() {
            if let Some(bandwidth) = pending_bandwidth.take() {
                validate_playlist_reference(line)?;
                if best
                    .as_ref()
                    .is_none_or(|(current, _)| bandwidth > *current)
                {
                    best = Some((bandwidth, line.to_owned()));
                }
            }
        }
    }
    Ok(best.map(|(_, reference)| reference))
}

fn parse_media_playlist(
    body: &str,
    limits: &MediaTransferLimits,
) -> MediaTransferResult<MediaPlaylist> {
    require_m3u_header(body)?;
    let lines = normalized_playlist_lines(body)?;
    if lines
        .iter()
        .any(|line| line.starts_with("#EXT-X-STREAM-INF:"))
    {
        return Err(unsupported_hls());
    }
    let forbidden = [
        "#EXT-X-KEY:",
        "#EXT-X-SESSION-KEY:",
        "#EXT-X-BYTERANGE:",
        "#EXT-X-DISCONTINUITY",
    ];
    if lines
        .iter()
        .any(|line| forbidden.iter().any(|prefix| line.starts_with(prefix)))
    {
        return Err(unsupported_hls());
    }
    if !lines.iter().any(|line| *line == "#EXT-X-ENDLIST") {
        return Err(MediaTransferError::new(
            "media-hls-live-unsupported",
            "Live HLS requires recording",
        ));
    }
    let mut duration = 0.0f64;
    let mut init = None;
    let mut segments = Vec::new();
    let mut segment_duration_pending = false;
    for line in lines {
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            if segment_duration_pending {
                return Err(unsupported_hls());
            }
            let seconds = value
                .split(',')
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.0)
                .ok_or_else(unsupported_hls)?;
            duration += seconds;
            if duration > limits.duration_cap_secs {
                return Err(MediaTransferError::new(
                    "media-duration-limit",
                    "Media duration exceeds the configured limit",
                ));
            }
            segment_duration_pending = true;
        } else if let Some(attributes) = line.strip_prefix("#EXT-X-MAP:") {
            if init.is_some() || attributes.contains("BYTERANGE=") {
                return Err(unsupported_hls());
            }
            let uri = quoted_attribute(attributes, "URI").ok_or_else(unsupported_hls)?;
            validate_playlist_reference(&uri)?;
            init = Some(uri);
        } else if !line.starts_with('#') && !line.is_empty() {
            if !segment_duration_pending {
                return Err(unsupported_hls());
            }
            validate_playlist_reference(line)?;
            segments.push(line.to_owned());
            segment_duration_pending = false;
            if segments.len() > limits.segment_cap {
                return Err(MediaTransferError::new(
                    "media-segment-limit",
                    "Media segment count exceeds the configured limit",
                ));
            }
        }
    }
    if segment_duration_pending
        || segments.is_empty()
        || (init.is_none()
            && segments.iter().any(|segment| {
                Url::parse(segment)
                    .ok()
                    .and_then(|url| url.path_segments()?.next_back().map(str::to_owned))
                    .unwrap_or_else(|| segment.split('?').next().unwrap_or(segment).to_owned())
                    .to_ascii_lowercase()
                    .ends_with(".m4s")
            }))
    {
        return Err(unsupported_hls());
    }
    Ok(MediaPlaylist { init, segments })
}

fn normalized_playlist_lines(body: &str) -> MediaTransferResult<Vec<&str>> {
    if body.len() as u64 > MAX_PLAYLIST_BYTES || body.chars().any(|character| character == '\0') {
        return Err(unsupported_hls());
    }
    Ok(body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect())
}

fn require_m3u_header(body: &str) -> MediaTransferResult<()> {
    if body
        .trim_start_matches('\u{feff}')
        .lines()
        .next()
        .map(str::trim)
        == Some("#EXTM3U")
    {
        Ok(())
    } else {
        Err(unsupported_hls())
    }
}

fn parse_bandwidth(attributes: &str) -> MediaTransferResult<u64> {
    attributes
        .split(',')
        .find_map(|attribute| attribute.trim().strip_prefix("BANDWIDTH="))
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .ok_or_else(unsupported_hls)
}

fn quoted_attribute(attributes: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let rest = attributes
        .split(',')
        .find_map(|part| part.trim().strip_prefix(&needle))?;
    let end = rest.find('"')?;
    (end + 1 == rest.len()).then(|| rest[..end].to_owned())
}

fn validate_playlist_reference(value: &str) -> MediaTransferResult<()> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\\')
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        Err(unsupported_hls())
    } else {
        Ok(())
    }
}

fn read_small_text(
    mut response: SafeHttpBody,
    cancel: &AtomicBool,
    deadline: Instant,
) -> MediaTransferResult<String> {
    ensure_success_and_identity(&response)?;
    if content_length(&response)?.is_some_and(|length| length > MAX_PLAYLIST_BYTES) {
        return Err(unsupported_hls());
    }
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        ensure_active(cancel, deadline)?;
        let read = response.read(&mut buffer).map_err(|_| network_failed())?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) > MAX_PLAYLIST_BYTES as usize {
            return Err(unsupported_hls());
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    String::from_utf8(bytes).map_err(|_| unsupported_hls())
}

fn ensure_success_and_identity(response: &SafeHttpBody) -> MediaTransferResult<()> {
    if !response.status().is_success() {
        return Err(MediaTransferError::new(
            "media-http-unavailable",
            "Media source is unavailable",
        ));
    }
    if response
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(MediaTransferError::new(
            "media-encoding-unsupported",
            "Encoded media responses are unsupported",
        ));
    }
    Ok(())
}

fn content_length(response: &SafeHttpBody) -> MediaTransferResult<Option<u64>> {
    response
        .headers()
        .get(CONTENT_LENGTH)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| {
                    MediaTransferError::new(
                        "media-invalid-response",
                        "Media response metadata is invalid",
                    )
                })
        })
        .transpose()
}

fn response_content_type(response: &SafeHttpBody) -> String {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| safe_mime_type(value))
        .unwrap_or("application/octet-stream")
        .to_ascii_lowercase()
}

fn safe_mime_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 127
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'+' | b'.' | b'-'))
        && value.contains('/')
}

fn safe_source_projection(
    source_page_url: Option<&str>,
    fallback: &Url,
) -> MediaTransferResult<String> {
    let source = match source_page_url {
        Some(raw) => Url::parse(raw).map_err(|_| invalid_source())?,
        None => fallback.clone(),
    };
    project_url_origin(&source)
}

fn project_url_origin(url: &Url) -> MediaTransferResult<String> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.as_str().len() > 4096
    {
        return Err(invalid_source());
    }
    Ok(url.origin().ascii_serialization())
}

fn invalid_source() -> MediaTransferError {
    MediaTransferError::new("media-source-invalid", "Media source metadata is invalid")
}

fn detect_media_container(prefix: &[u8]) -> MediaTransferResult<&'static str> {
    if prefix.len() >= 12 && &prefix[4..8] == b"ftyp" {
        return Ok("video/mp4");
    }
    if prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Ok("video/webm");
    }
    if prefix.starts_with(b"OggS") {
        return Ok("application/ogg");
    }
    if prefix.len() >= 12 && prefix.starts_with(b"RIFF") && &prefix[8..12] == b"AVI " {
        return Ok("video/x-msvideo");
    }
    if prefix.len() >= 12 && prefix.starts_with(b"RIFF") && &prefix[8..12] == b"WAVE" {
        return Ok("audio/wav");
    }
    if prefix.starts_with(b"ID3")
        || (prefix.len() >= 2 && prefix[0] == 0xff && prefix[1] & 0xe0 == 0xe0)
    {
        return Ok("audio/mpeg");
    }
    if prefix.len() >= 189 && prefix[0] == 0x47 && prefix[188] == 0x47 {
        return Ok("video/mp2t");
    }
    Err(invalid_container())
}

fn invalid_container() -> MediaTransferError {
    MediaTransferError::new(
        "media-container-invalid",
        "Downloaded content is not a supported media container",
    )
}

fn is_hls(url: &Url, content_type: &str) -> bool {
    matches!(
        content_type,
        "application/vnd.apple.mpegurl" | "application/x-mpegurl" | "audio/mpegurl"
    ) || url.path().to_ascii_lowercase().ends_with(".m3u8")
}

fn is_dash(url: &Url, content_type: &str) -> bool {
    content_type == "application/dash+xml" || url.path().to_ascii_lowercase().ends_with(".mpd")
}

fn validate_site_auth(request: &MediaTransferRequest) -> bool {
    let Some(auth) = request.site_auth.as_ref() else {
        return true;
    };
    let has_browser_headers = !auth.user_agent.is_empty() || !auth.referer.is_empty();
    if auth.cookies.len() > MAX_SITE_AUTH_COOKIES
        || (auth.cookies.is_empty() && !has_browser_headers)
    {
        return false;
    }
    let request_host = Url::parse(&request.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
    let source_host = request
        .source_page_url
        .as_deref()
        .and_then(|value| Url::parse(value).ok())
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
    let site_host = source_host.or(request_host).unwrap_or_default();
    let allowed_domains: &[&str] = if is_supported_host(&site_host, &["youtube.com", "youtu.be"]) {
        &["youtube.com"]
    } else if is_supported_host(&site_host, &["bilibili.com", "b23.tv"]) {
        &["bilibili.com"]
    } else if is_supported_host(&site_host, &["x.com", "twitter.com"]) {
        &["x.com", "twitter.com"]
    } else if is_supported_host(&site_host, &["pinterest.com", "pinimg.com"]) {
        &["pinterest.com"]
    } else {
        return false;
    };
    if has_browser_headers {
        let exact_source = request.source_page_url.as_deref().unwrap_or_default();
        if auth.user_agent.is_empty()
            || auth.user_agent.len() > 512
            || auth
                .user_agent
                .chars()
                .any(|character| character.is_control())
            || auth.referer != exact_source
            || auth.referer.len() > 2048
        {
            return false;
        }
        let Ok(referer) = Url::parse(&auth.referer) else {
            return false;
        };
        let referer_host = normalized_host(&referer).unwrap_or_default();
        if referer.scheme() != "https"
            || !referer.username().is_empty()
            || referer.password().is_some()
            || !allowed_domains.iter().any(|allowed| {
                referer_host == *allowed || referer_host.ends_with(&format!(".{allowed}"))
            })
        {
            return false;
        }
    }
    let mut total_bytes = 0usize;
    for cookie in &auth.cookies {
        let domain = cookie
            .domain
            .trim()
            .trim_start_matches('.')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let scalar_bytes = cookie
            .name
            .len()
            .checked_add(cookie.value.len())
            .and_then(|value| value.checked_add(cookie.domain.len()))
            .and_then(|value| value.checked_add(cookie.path.len()));
        total_bytes = match scalar_bytes.and_then(|value| total_bytes.checked_add(value)) {
            Some(value) if value <= MAX_SITE_AUTH_BYTES => value,
            _ => return false,
        };
        if cookie.name.is_empty()
            || cookie.name.len() > 256
            || cookie.value.len() > 4096
            || domain.is_empty()
            || domain.len() > 253
            || cookie.path.is_empty()
            || cookie.path.len() > 1024
            || !cookie.path.starts_with('/')
            || cookie.expires < 0
            || [&cookie.name, &cookie.value, &cookie.domain, &cookie.path]
                .into_iter()
                .any(|value| {
                    value
                        .chars()
                        .any(|character| character.is_control() || character == '\t')
                })
            || !allowed_domains
                .iter()
                .any(|allowed| domain == *allowed || domain.ends_with(&format!(".{allowed}")))
        {
            return false;
        }
    }
    true
}

fn validate_track_pair(request: &MediaTransferRequest) -> bool {
    let Some(raw_audio) = request.audio_url.as_deref() else {
        return true;
    };
    if raw_audio.is_empty()
        || raw_audio.len() > 4096
        || raw_audio.chars().any(char::is_control)
        || raw_audio == request.url
    {
        return false;
    }
    let Ok(video) = Url::parse(&request.url) else {
        return false;
    };
    let Ok(audio) = Url::parse(raw_audio) else {
        return false;
    };
    let Some(source) = request
        .source_page_url
        .as_deref()
        .and_then(|value| Url::parse(value).ok())
    else {
        return false;
    };
    if [&video, &audio, &source].into_iter().any(|url| {
        url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
    }) {
        return false;
    }
    let video_host = normalized_host(&video).unwrap_or_default();
    let audio_host = normalized_host(&audio).unwrap_or_default();
    let source_host = normalized_host(&source).unwrap_or_default();
    let tracks_match = |suffixes: &[&str]| {
        is_supported_host(&video_host, suffixes) && is_supported_host(&audio_host, suffixes)
    };
    if is_supported_host(&source_host, &["youtube.com", "youtu.be"]) {
        tracks_match(&["googlevideo.com"])
    } else if is_supported_host(&source_host, &["bilibili.com", "b23.tv"]) {
        tracks_match(&["bilivideo.com", "bilivideo.cn", "hdslb.com"])
    } else if is_supported_host(&source_host, &["x.com", "twitter.com"]) {
        tracks_match(&["twimg.com"])
    } else if is_supported_host(&source_host, &["pinterest.com"]) {
        tracks_match(&["pinimg.com"])
    } else {
        false
    }
}

fn validate_request(request: &MediaTransferRequest) -> MediaTransferResult<()> {
    let invalid_id = |value: &str| {
        value.is_empty()
            || value.len() > 160
            || value.chars().any(|character| character.is_control())
    };
    if request.url.is_empty()
        || request.url.len() > 4096
        || request.url.chars().any(|character| character.is_control())
        || !validate_track_pair(request)
        || request.file_name.trim().is_empty()
        || request.file_name.len() > 255
        || request
            .mime_type
            .as_deref()
            .is_some_and(|value| !safe_mime_type(value))
        || request.source_page_url.as_deref().is_some_and(|value| {
            Url::parse(value)
                .ok()
                .and_then(|url| project_url_origin(&url).ok())
                .is_none()
        })
        || request.target_folder_id.as_deref().is_some_and(invalid_id)
        || request.parent_folder_id.as_deref().is_some_and(invalid_id)
        || request.new_folder_name.as_deref().is_some_and(|value| {
            value.trim().is_empty()
                || value.len() > 160
                || value.chars().any(|character| character.is_control())
        })
        || (request.new_folder_name.is_none() && request.parent_folder_id.is_some())
        || (request.new_folder_name.is_some() && request.target_folder_id.is_some())
        || !validate_site_auth(request)
    {
        return Err(MediaTransferError::new(
            "media-input-invalid",
            "Media transfer input is invalid",
        ));
    }
    Ok(())
}

fn safe_file_name(value: &str) -> String {
    let projected = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>();
    let trimmed = projected.trim().trim_matches('.');
    if trimmed.is_empty() {
        "video.bin".to_owned()
    } else {
        trimmed.chars().take(180).collect()
    }
}

fn file_name_for_mime(file_name: &str, mime_type: &str) -> String {
    let extension = match mime_type {
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/mp2t" => "ts",
        "video/ogg" | "audio/ogg" => "ogv",
        "video/x-msvideo" => "avi",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" => "mp3",
        _ => return file_name.to_owned(),
    };
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("video");
    format!("{stem}.{extension}")
}

fn ensure_active(cancel: &AtomicBool, deadline: Instant) -> MediaTransferResult<()> {
    if cancel.load(Ordering::Acquire) {
        Err(MediaTransferError::new(
            "media-cancelled",
            "Media transfer was cancelled",
        ))
    } else if Instant::now() >= deadline {
        Err(MediaTransferError::new(
            "media-deadline-exceeded",
            "Media transfer exceeded its deadline",
        ))
    } else {
        Ok(())
    }
}

fn map_web_error(error: WebToolError) -> MediaTransferError {
    let code = match error.code {
        "web-network-denied" | "web-redirect-denied" => "media-network-denied",
        _ => "media-network-failed",
    };
    MediaTransferError::new(code, "Media network request failed")
}

fn network_failed() -> MediaTransferError {
    MediaTransferError::new("media-network-failed", "Media network request failed")
}

fn too_large() -> MediaTransferError {
    MediaTransferError::new(
        "media-size-limit",
        "Media exceeds the configured size limit",
    )
}

fn staging_write_failed() -> MediaTransferError {
    MediaTransferError::new("media-staging-write-failed", "Media staging write failed")
}

fn unsupported_hls() -> MediaTransferError {
    MediaTransferError::new(
        "media-hls-unsupported",
        "This HLS presentation is not supported for direct download",
    )
}

fn needs_recording() -> MediaTransferError {
    MediaTransferError::new(
        "media-needs-recording",
        "This media source requires a recording workflow",
    )
}

fn capacity_error() -> MediaTransferError {
    MediaTransferError::new("media-capacity", "Media transfer capacity is unavailable")
}

fn not_found() -> MediaTransferError {
    MediaTransferError::new("media-transfer-not-found", "Media transfer was not found")
}

fn validate_transfer_id(value: &str) -> MediaTransferResult<()> {
    if value.starts_with("media-")
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err(not_found())
    }
}

fn unique_transfer_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let random = rand::random::<u64>();
    format!("media-{nanos:x}-{random:016x}")
}

fn unique_probe_id() -> String {
    format!(
        "probe-{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    )
}

fn unique_format_id() -> String {
    format!(
        "format-{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    )
}

fn prune_probes(probes: &mut HashMap<String, MediaProbeRecord>) {
    let now = Instant::now();
    probes.retain(|_, probe| now.saturating_duration_since(probe.created_at) < DEFAULT_PROBE_TTL);
}

fn is_terminal(state: MediaTransferState) -> bool {
    matches!(
        state,
        MediaTransferState::Completed | MediaTransferState::Cancelled | MediaTransferState::Failed
    )
}

fn prune_jobs(jobs: &mut HashMap<String, MediaTransferJob>, limits: &MediaTransferLimits) {
    let now = Instant::now();
    let expired = jobs
        .iter()
        .filter(|(_, job)| {
            is_terminal(job.snapshot.state)
                && now.saturating_duration_since(job.updated_at) >= limits.terminal_ttl
        })
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(job) = jobs.remove(&id) {
            cleanup_job(job);
        }
    }
    let mut terminal = jobs
        .iter()
        .filter(|(_, job)| is_terminal(job.snapshot.state))
        .map(|(id, job)| (id.clone(), job.updated_at))
        .collect::<Vec<_>>();
    terminal.sort_by_key(|(_, updated_at)| *updated_at);
    let remove_count = terminal.len().saturating_sub(limits.terminal_cap);
    for (id, _) in terminal.into_iter().take(remove_count) {
        if let Some(job) = jobs.remove(&id) {
            cleanup_job(job);
        }
    }
}

fn cleanup_job(_job: MediaTransferJob) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Barrier;

    struct FixtureResolver;

    struct RejectedFixtureResolver(&'static str);

    impl MediaResolver for RejectedFixtureResolver {
        fn transfer(
            &self,
            _request: &MediaTransferRequest,
            _format_selector: Option<&str>,
            _staged_path: &Path,
            _cancel: &AtomicBool,
            _limits: &MediaTransferLimits,
            _progress: &mut dyn FnMut(u64, Option<u64>),
        ) -> MediaTransferResult<TransferOutput> {
            Err(MediaTransferError::new(self.0, "Fixture resolver rejection"))
        }
    }

    struct CatalogFixtureResolver {
        selected: Arc<Mutex<Option<String>>>,
    }

    fn fixture_mp4(payload: &[u8]) -> Vec<u8> {
        let box_size = u32::try_from(8usize.saturating_add(payload.len())).unwrap();
        let mut body = b"\0\0\0\x18ftypisom\0\0\0\0isommp42".to_vec();
        body.extend_from_slice(&box_size.to_be_bytes());
        body.extend_from_slice(b"mdat");
        body.extend_from_slice(payload);
        body
    }

    impl MediaResolver for FixtureResolver {
        fn transfer(
            &self,
            _request: &MediaTransferRequest,
            _format_selector: Option<&str>,
            staged_path: &Path,
            _cancel: &AtomicBool,
            _limits: &MediaTransferLimits,
            progress: &mut dyn FnMut(u64, Option<u64>),
        ) -> MediaTransferResult<TransferOutput> {
            let body = fixture_mp4(b"resolved");
            std::fs::write(staged_path, &body).unwrap();
            progress(body.len() as u64, Some(body.len() as u64));
            Ok(TransferOutput {
                size_bytes: body.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&body)),
                mime_type: "video/mp4".into(),
                source: "https://resolver.example".into(),
            })
        }
    }

    impl MediaResolver for CatalogFixtureResolver {
        fn probe(
            &self,
            _request: &MediaProbeRequest,
            _scratch_dir: &Path,
            _limits: &MediaTransferLimits,
        ) -> MediaTransferResult<Vec<ResolvedMediaFormat>> {
            Ok(vec![ResolvedMediaFormat {
                selector: "137+bestaudio/137".into(),
                label: "1080p · MP4 · 合并音频".into(),
                width: 1920,
                height: 1080,
                fps: 30,
                extension: "mp4".into(),
                video_codec: "avc1".into(),
                audio_codec: "merge".into(),
                estimated_bytes: 42_000_000,
                bitrate: 4_000_000,
            }])
        }

        fn transfer(
            &self,
            _request: &MediaTransferRequest,
            format_selector: Option<&str>,
            staged_path: &Path,
            _cancel: &AtomicBool,
            _limits: &MediaTransferLimits,
            progress: &mut dyn FnMut(u64, Option<u64>),
        ) -> MediaTransferResult<TransferOutput> {
            *self.selected.lock().unwrap() = format_selector.map(str::to_owned);
            let body = fixture_mp4(b"selected-format");
            std::fs::write(staged_path, &body).unwrap();
            progress(body.len() as u64, Some(body.len() as u64));
            Ok(TransferOutput {
                size_bytes: body.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&body)),
                mime_type: "video/mp4".into(),
                source: "https://resolver.example".into(),
            })
        }
    }

    fn test_limits() -> MediaTransferLimits {
        MediaTransferLimits {
            active_cap: 2,
            terminal_cap: 8,
            terminal_ttl: Duration::from_secs(30),
            max_bytes: 1024 * 1024,
            deadline: Duration::from_secs(3),
            redirect_cap: 2,
            segment_cap: 8,
            duration_cap_secs: 60.0,
            io_timeout: Duration::from_millis(200),
        }
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(unique_transfer_id());
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn mp4_initialization_segment_without_media_data_is_not_importable() {
        let root = temp_root();
        let path = root.join("init-only.mp4");
        std::fs::write(&path, b"\0\0\0\x18ftypisom\0\0\0\0isommp42\0\0\0\x08moov").unwrap();

        let error = verify_resolved_output(&path, 1024).unwrap_err();
        assert_eq!(error.code, "media-container-invalid");

        std::fs::remove_dir_all(root).unwrap();
    }

    fn fixture_service(
        root: &Path,
        limits: MediaTransferLimits,
    ) -> (MediaTransferService, MaterialCatalog) {
        let catalog = MaterialCatalog::new_for_test_at(root);
        (
            MediaTransferService::new_for_test(root, catalog.clone(), limits),
            catalog,
        )
    }

    fn wait_terminal(service: &MediaTransferService, id: &str) -> MediaTransferSnapshot {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = service.status(id).unwrap();
            if is_terminal(snapshot.state) {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "transfer did not terminate");
            std::thread::yield_now();
        }
    }

    #[test]
    fn public_format_catalog_uses_opaque_ids_and_binds_the_selected_format() {
        let root = temp_root();
        let catalog = MaterialCatalog::new_for_test_at(&root);
        let selected = Arc::new(Mutex::new(None));
        let service = MediaTransferService::new_for_test_with_resolver(
            &root,
            catalog,
            test_limits(),
            Arc::new(CatalogFixtureResolver {
                selected: Arc::clone(&selected),
            }),
        );
        let probe_request = MediaProbeRequest {
            url: "https://video.example/watch/private-path?token=PRIVATE".into(),
            source_page_url: Some("https://video.example/watch/private-path?token=PRIVATE".into()),
            site_auth: None,
        };
        let probed = service.probe(probe_request.clone()).unwrap();
        assert!(probed.probe_id.starts_with("probe-"));
        assert_eq!(probed.formats.len(), 1);
        assert!(probed.formats[0].format_id.starts_with("format-"));
        let public = serde_json::to_string(&probed).unwrap();
        assert!(!public.contains("137+bestaudio"));
        assert!(!public.contains("PRIVATE"));
        assert!(!public.contains("video.example"));

        let request = MediaTransferRequest {
            url: probe_request.url,
            audio_url: None,
            file_name: "selected.mp4".into(),
            mime_type: None,
            source_page_url: probe_request.source_page_url,
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: None,
        };
        let started = service
            .start_selected(
                request,
                Some(&probed.probe_id),
                Some(&probed.formats[0].format_id),
            )
            .unwrap();
        let terminal = wait_terminal(&service, &started.transfer_id);
        assert_eq!(terminal.state, MediaTransferState::Completed);
        assert_eq!(
            selected.lock().unwrap().as_deref(),
            Some("137+bestaudio/137")
        );

        let stale = MediaTransferRequest {
            url: "https://video.example/watch/other".into(),
            audio_url: None,
            file_name: "stale.mp4".into(),
            mime_type: None,
            source_page_url: Some("https://video.example/watch/other".into()),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: None,
        };
        let error = service
            .start_selected(
                stale,
                Some(&probed.probe_id),
                Some(&probed.formats[0].format_id),
            )
            .unwrap_err();
        assert_eq!(error.code, "media-probe-expired");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn app_owned_resolver_probe_projects_the_real_runner_catalog() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{address}");
            let body = format!(
                "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n{base}/private-360.m3u8?token=PRIVATE\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\n{base}/private-720.m3u8?token=PRIVATE\n"
            );
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut served = 0;
            while Instant::now() < deadline && served < 2 {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
                        let mut request = [0u8; 2048];
                        let read = socket.read(&mut request).unwrap();
                        let is_head = request[..read].starts_with(b"HEAD ");
                        write!(
                            socket,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len(),
                        )
                        .unwrap();
                        if !is_head {
                            socket.write_all(body.as_bytes()).unwrap();
                        }
                        served += 1;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("fixture server failed: {error}"),
                }
            }
        });
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let media_root = manifest_dir.join("media-engine").canonicalize().unwrap();
        let manifest: MediaEngineRuntimeManifest = serde_json::from_slice(
            &std::fs::read(media_root.join("runtime-manifest.json")).unwrap(),
        )
        .unwrap();
        let resolver = ExternalMediaResolver {
            executable: media_root.join(manifest.python),
            runner_name: OsString::from("runner.py"),
            wheel_path: media_root.join(manifest.yt_dlp_wheel),
            ejs_wheel_path: media_root.join(manifest.yt_dlp_ejs_wheel),
            ffmpeg_dir: media_root
                .join(manifest.ffmpeg)
                .parent()
                .unwrap()
                .to_path_buf(),
            deno_path: media_root.join(manifest.deno),
            root: media_root,
            allow_loopback: true,
        };
        let scratch = temp_root();
        let mut probe_limits = test_limits();
        probe_limits.deadline = Duration::from_secs(30);
        let formats = resolver
            .probe(
                &MediaProbeRequest {
                    url: format!("http://{address}/master.m3u8"),
                    source_page_url: Some(format!("http://{address}/watch")),
                    site_auth: None,
                },
                &scratch,
                &probe_limits,
            )
            .unwrap();
        assert_eq!(
            formats
                .iter()
                .map(|format| format.height)
                .collect::<Vec<_>>(),
            [720, 360]
        );
        let safe = formats
            .iter()
            .map(|format| format.label.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!safe.contains("PRIVATE"));
        assert!(!safe.contains("127.0.0.1"));
        server.join().unwrap();
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn public_hls_parser_selects_highest_variant_and_accepts_fmp4_vod() {
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh/index.m3u8\n";
        assert_eq!(
            parse_master_playlist(master).unwrap().as_deref(),
            Some("high/index.m3u8")
        );
        let media = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\na.m4s\n#EXTINF:3.0,\nb.m4s\n#EXT-X-ENDLIST\n";
        let parsed = parse_media_playlist(media, &test_limits()).unwrap();
        assert_eq!(parsed.init.as_deref(), Some("init.mp4"));
        assert_eq!(parsed.segments, ["a.m4s", "b.m4s"]);
    }

    #[test]
    fn public_hls_parser_rejects_live_encrypted_byterange_and_discontinuity() {
        for body in [
            "#EXTM3U\n#EXTINF:2,\na.ts\n",
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n",
            "#EXTM3U\n#EXT-X-BYTERANGE:20@0\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n",
            "#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST\n",
        ] {
            assert!(parse_media_playlist(body, &test_limits()).is_err());
        }
    }

    #[test]
    fn verified_container_controls_the_imported_file_extension() {
        assert_eq!(
            file_name_for_mime("captured.mp4", "video/mp2t"),
            "captured.ts"
        );
        assert_eq!(file_name_for_mime("signed", "video/webm"), "signed.webm");
        assert_eq!(
            file_name_for_mime("clip.custom", "application/octet-stream"),
            "clip.custom"
        );
    }

    #[test]
    fn public_direct_transfer_imports_before_completion_without_url_projection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            let body = fixture_mp4(b"fixture");
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(&body).unwrap();
        });
        let root = temp_root();
        let (service, catalog) = fixture_service(&root, test_limits());
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/private/path?token=secret"),
                audio_url: None,
                file_name: "clip.mp4".into(),
                mime_type: None,
                source_page_url: Some(format!("http://{address}/private/page?token=source-secret")),
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let completed = wait_terminal(&service, &started.transfer_id);
        assert_eq!(
            completed.state,
            MediaTransferState::Completed,
            "{completed:?}"
        );
        let json = serde_json::to_string(&completed).unwrap();
        assert!(!json.contains("secret") && !json.contains("private"));
        let assets = catalog
            .list_assets(&crate::materials::MaterialFilter::default())
            .unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].original_path, format!("http://{address}"));
        assert_eq!(
            std::fs::read(assets[0].library_path.as_ref().unwrap()).unwrap(),
            fixture_mp4(b"fixture")
        );
        server.join().unwrap();
    }

    #[test]
    fn committed_import_is_terminal_before_a_slow_catalog_notification() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            let body = fixture_mp4(b"fixture");
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(&body).unwrap();
        });
        let root = temp_root();
        let catalog = MaterialCatalog::new_for_test_at(&root);
        let notification_entered = Arc::new(Barrier::new(2));
        let notification_release = Arc::new(Barrier::new(2));
        let entered_for_sink = Arc::clone(&notification_entered);
        let release_for_sink = Arc::clone(&notification_release);
        let service = MediaTransferService::new_for_test_with_change_sink(
            &root,
            catalog,
            test_limits(),
            Arc::new(move |_| {
                entered_for_sink.wait();
                release_for_sink.wait();
            }),
        );
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/clip.mp4"),
                audio_url: None,
                file_name: "clip.mp4".into(),
                mime_type: Some("video/mp4".into()),
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();

        notification_entered.wait();
        let committed = service.status(&started.transfer_id).unwrap();
        notification_release.wait();
        server.join().unwrap();

        assert_eq!(committed.state, MediaTransferState::Completed);
        assert!(committed.asset_id.is_some());
    }

    #[test]
    fn public_direct_transfer_rejects_non_media_body_even_with_video_content_type() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello-video")
                .unwrap();
        });
        let root = temp_root();
        let (service, catalog) = fixture_service(&root, test_limits());
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/fake.mp4"),
                audio_url: None,
                file_name: "fake.mp4".into(),
                mime_type: Some("video/mp4".into()),
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let failed = wait_terminal(&service, &started.transfer_id);
        assert_eq!(failed.state, MediaTransferState::Failed);
        assert_eq!(
            failed.error_code.as_deref(),
            Some("media-container-invalid")
        );
        assert!(catalog
            .list_assets(&crate::materials::MaterialFilter::default())
            .unwrap()
            .is_empty());
        assert!(std::fs::read_dir(root.join("media-transfer-staging"))
            .unwrap()
            .next()
            .is_none());
        server.join().unwrap();
    }

    #[test]
    fn public_direct_transfer_rejects_oversize_content_length_before_body_streaming() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let root = temp_root();
        let (service, catalog) = fixture_service(&root, test_limits());
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/large.mp4"),
                audio_url: None,
                file_name: "large.mp4".into(),
                mime_type: None,
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let failed = wait_terminal(&service, &started.transfer_id);
        assert_eq!(failed.error_code.as_deref(), Some("media-size-limit"));
        assert!(catalog
            .list_assets(&crate::materials::MaterialFilter::default())
            .unwrap()
            .is_empty());
        server.join().unwrap();
    }

    #[test]
    fn public_hls_download_selects_highest_relative_variant_and_concatenates_fmp4() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..5 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0u8; 2048];
                let read = socket.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap();
                let (content_type, body): (&str, Vec<u8>) = match path {
                    "/master.m3u8" => (
                        "application/vnd.apple.mpegurl",
                        b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh/index.m3u8\n".to_vec(),
                    ),
                    "/high/index.m3u8" => (
                        "application/vnd.apple.mpegurl",
                        b"#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\na.m4s\n#EXTINF:2,\nb.m4s\n#EXT-X-ENDLIST\n".to_vec(),
                    ),
                    "/high/init.mp4" => (
                        "video/mp4",
                        b"\0\0\0\x18ftypisom\0\0\0\0isommp42".to_vec(),
                    ),
                    "/high/a.m4s" => ("video/mp4", fixture_mp4(b"segment-a")[24..].to_vec()),
                    "/high/b.m4s" => ("video/mp4", fixture_mp4(b"segment-b")[24..].to_vec()),
                    unexpected => panic!("unexpected HLS path: {unexpected}"),
                };
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        let root = temp_root();
        let (service, catalog) = fixture_service(&root, test_limits());
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/master.m3u8"),
                audio_url: None,
                file_name: "captured.mp4".into(),
                mime_type: None,
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let completed = wait_terminal(&service, &started.transfer_id);
        assert_eq!(completed.state, MediaTransferState::Completed);
        assert_eq!(completed.mime_type, "video/mp4");
        let asset = catalog
            .list_assets(&crate::materials::MaterialFilter::default())
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(
            std::fs::read(asset.library_path.unwrap()).unwrap(),
            [
                b"\0\0\0\x18ftypisom\0\0\0\0isommp42".as_slice(),
                fixture_mp4(b"segment-a")[24..].as_ref(),
                fixture_mp4(b"segment-b")[24..].as_ref(),
            ]
            .concat()
        );
        server.join().unwrap();
    }

    #[test]
    fn public_cancel_interrupts_stream_and_removes_partial_file() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let server_barrier = Arc::clone(&barrier);
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nConnection: close\r\n\r\nfirst",
                )
                .unwrap();
            socket.flush().unwrap();
            server_barrier.wait();
            let _ = socket.write_all(b"second");
        });
        let root = temp_root();
        let (service, _) = fixture_service(&root, test_limits());
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/video"),
                audio_url: None,
                file_name: "clip.mp4".into(),
                mime_type: None,
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while service.status(&started.transfer_id).unwrap().bytes_received == 0 {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        service.cancel(&started.transfer_id).unwrap();
        barrier.wait();
        let cancelled = wait_terminal(&service, &started.transfer_id);
        assert_eq!(cancelled.state, MediaTransferState::Cancelled);
        assert!(std::fs::read_dir(root.join("media-transfer-staging"))
            .unwrap()
            .next()
            .is_none());
        server.join().unwrap();
    }

    #[test]
    fn public_cancel_of_stalled_body_converges_within_the_io_bound() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let headers_sent = Arc::new(Barrier::new(2));
        let server_headers_sent = Arc::clone(&headers_sent);
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 24\r\nConnection: close\r\n\r\n")
                .unwrap();
            socket.flush().unwrap();
            server_headers_sent.wait();
            std::thread::sleep(Duration::from_secs(1));
        });
        let root = temp_root();
        let (service, _) = fixture_service(&root, test_limits());
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/stalled.mp4"),
                audio_url: None,
                file_name: "stalled.mp4".into(),
                mime_type: None,
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        headers_sent.wait();
        let cancelled_at = Instant::now();
        service.cancel(&started.transfer_id).unwrap();
        let cancelled = wait_terminal(&service, &started.transfer_id);
        assert_eq!(cancelled.state, MediaTransferState::Cancelled);
        assert_eq!(cancelled.error_code.as_deref(), Some("media-cancelled"));
        assert!(
            cancelled_at.elapsed() < Duration::from_millis(800),
            "stalled read ignored the bounded media I/O timeout"
        );
        assert!(std::fs::read_dir(root.join("media-transfer-staging"))
            .unwrap()
            .next()
            .is_none());
        server.join().unwrap();
    }

    #[test]
    fn importing_cancel_is_typed_too_late_and_does_not_change_state() {
        let root = temp_root();
        let (service, _) = fixture_service(&root, test_limits());
        let transfer_id = "media-importing-test".to_owned();
        service.inner.jobs.lock().unwrap().insert(
            transfer_id.clone(),
            MediaTransferJob {
                owner_key: None,
                snapshot: MediaTransferSnapshot {
                    transfer_id: transfer_id.clone(),
                    state: MediaTransferState::Importing,
                    bytes_received: 24,
                    total_bytes: Some(24),
                    file_name: "clip.mp4".into(),
                    mime_type: "video/mp4".into(),
                    asset_id: None,
                    asset_name: None,
                    asset_kind: None,
                    skipped_duplicate: false,
                    error_code: None,
                    library_id: None,
                    request_id: None,
                    receipt: None,
                },
                cancel: Arc::new(AtomicBool::new(false)),
                updated_at: Instant::now(),
            },
        );

        let error = service.cancel(&transfer_id).unwrap_err();
        assert_eq!(error.code, "media-cancel-too-late");
        assert_eq!(
            service.status(&transfer_id).unwrap().state,
            MediaTransferState::Importing
        );
        assert!(!service
            .inner
            .jobs
            .lock()
            .unwrap()
            .get(&transfer_id)
            .unwrap()
            .cancel
            .load(Ordering::Acquire));
    }

    #[test]
    fn public_new_folder_transfer_creates_real_catalog_folder_and_publishes_changes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            let body = fixture_mp4(b"fixture");
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(&body).unwrap();
        });
        let root = temp_root();
        let catalog = MaterialCatalog::new_for_test_at(&root);
        let parent = catalog
            .create_folder(MaterialFolderInput {
                parent_id: None,
                name: "Parent".into(),
            })
            .unwrap()
            .value;
        let observed = Arc::new(Mutex::new(Vec::<MaterialChange>::new()));
        let observed_sink = Arc::clone(&observed);
        let service = MediaTransferService::new_for_test_with_change_sink(
            &root,
            catalog.clone(),
            test_limits(),
            Arc::new(move |change| {
                if let Some(change) = change {
                    observed_sink.lock().unwrap().push(change.clone());
                }
            }),
        );
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/video.mp4"),
                audio_url: None,
                file_name: "video.mp4".into(),
                mime_type: None,
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: Some("Downloaded Videos".into()),
                parent_folder_id: Some(parent.id.clone()),
                site_auth: None,
            })
            .unwrap();
        let completed = wait_terminal(&service, &started.transfer_id);
        assert_eq!(completed.state, MediaTransferState::Completed);

        let folders = catalog.list_folders().unwrap();
        let created = folders
            .iter()
            .find(|folder| folder.id == parent.id)
            .unwrap()
            .children
            .iter()
            .find(|folder| folder.name == "Downloaded Videos")
            .unwrap();
        let asset = catalog
            .list_assets(&crate::materials::MaterialFilter::default())
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(asset.folder_id.as_deref(), Some(created.id.as_str()));
        let changes = observed.lock().unwrap();
        assert!(changes.iter().any(|change| change.folders_changed));
        assert!(changes
            .iter()
            .any(|change| change.affected_ids.iter().any(|id| id == &asset.id)));
        server.join().unwrap();
    }

    #[test]
    fn public_complex_manifest_uses_resolver_and_imports_one_verified_asset() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: 6\r\nConnection: close\r\n\r\n<MPD/>")
                .unwrap();
        });
        let root = temp_root();
        let catalog = MaterialCatalog::new_for_test_at(&root);
        let service = MediaTransferService::new_for_test_with_resolver(
            &root,
            catalog.clone(),
            test_limits(),
            Arc::new(FixtureResolver),
        );
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/manifest.mpd"),
                audio_url: None,
                file_name: "clip.mp4".into(),
                mime_type: None,
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let completed = wait_terminal(&service, &started.transfer_id);
        assert_eq!(completed.state, MediaTransferState::Completed);
        assert_eq!(completed.mime_type, "video/mp4");
        let assets = catalog
            .list_assets(&crate::materials::MaterialFilter::default())
            .unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(
            std::fs::read(assets[0].library_path.as_ref().unwrap()).unwrap(),
            fixture_mp4(b"resolved")
        );
        server.join().unwrap();
    }

    fn failed_direct_transfer_with_resolver(
        response: Option<&'static [u8]>,
        resolver_code: &'static str,
    ) -> MediaTransferSnapshot {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            if let Some(response) = response {
                socket.write_all(response).unwrap();
            }
        });
        let root = temp_root();
        let catalog = MaterialCatalog::new_for_test_at(&root);
        let service = MediaTransferService::new_for_test_with_resolver(
            &root,
            catalog.clone(),
            test_limits(),
            Arc::new(RejectedFixtureResolver(resolver_code)),
        );
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/direct-video.mp4"),
                audio_url: None,
                file_name: "video.mp4".into(),
                mime_type: Some("video/mp4".into()),
                source_page_url: Some("https://video.example/watch".into()),
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let terminal = wait_terminal(&service, &started.transfer_id);
        assert_eq!(terminal.state, MediaTransferState::Failed);
        assert!(terminal.asset_id.is_none());
        assert!(catalog
            .list_assets(&crate::materials::MaterialFilter::default())
            .unwrap()
            .is_empty());
        server.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
        terminal
    }

    #[test]
    fn unsupported_resolver_preserves_direct_http_and_network_failures() {
        let http_failure = failed_direct_transfer_with_resolver(
            Some(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
            "media-resolver-unsupported",
        );
        assert_eq!(
            http_failure.error_code.as_deref(),
            Some("media-http-unavailable")
        );

        let network_failure =
            failed_direct_transfer_with_resolver(None, "media-resolver-unsupported");
        assert_eq!(
            network_failure.error_code.as_deref(),
            Some("media-network-failed")
        );
    }

    #[test]
    fn resolver_diagnostics_remain_actionable_after_a_direct_network_failure() {
        for code in [
            "media-auth-required",
            "media-drm-protected",
            "media-resolver-unavailable",
            "media-resolver-failed",
        ] {
            let terminal = failed_direct_transfer_with_resolver(None, code);
            assert_eq!(terminal.error_code.as_deref(), Some(code));
        }
    }

    #[test]
    fn rejected_site_media_source_falls_back_to_the_bound_page_resolver() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let root = temp_root();
        let catalog = MaterialCatalog::new_for_test_at(&root);
        let service = MediaTransferService::new_for_test_with_resolver(
            &root,
            catalog,
            test_limits(),
            Arc::new(FixtureResolver),
        );
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/signed-video.mp4"),
                audio_url: None,
                file_name: "video.mp4".into(),
                mime_type: Some("video/mp4".into()),
                source_page_url: Some("https://www.bilibili.com/video/BV1fixture".into()),
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();

        let completed = wait_terminal(&service, &started.transfer_id);
        assert_eq!(
            completed.state,
            MediaTransferState::Completed,
            "{completed:?}"
        );

        server.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn resolver_keeps_exact_supported_video_pages_and_uses_source_for_cdn_media() {
        let pinterest = MediaTransferRequest {
            url: "https://v1.pinimg.com/videos/720w/example.mp4".into(),
            audio_url: None,
            file_name: "pin.mp4".into(),
            mime_type: Some("video/mp4".into()),
            source_page_url: Some("https://www.pinterest.com/feed".into()),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: None,
        };
        assert_eq!(
            resolver_target_url(&pinterest, false).unwrap().as_str(),
            "https://v1.pinimg.com/videos/720w/example.mp4"
        );

        let youtube = MediaTransferRequest {
            url: "https://rr.example.googlevideo.com/videoplayback".into(),
            audio_url: None,
            file_name: "youtube.mp4".into(),
            mime_type: Some("video/mp4".into()),
            source_page_url: Some("https://www.youtube.com/watch?v=fixture".into()),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: None,
        };
        assert_eq!(
            resolver_target_url(&youtube, false).unwrap().as_str(),
            "https://www.youtube.com/watch?v=fixture"
        );

        let x_status = MediaTransferRequest {
            url: "https://x.com/example/status/1234567890".into(),
            audio_url: None,
            file_name: "x.mp4".into(),
            mime_type: None,
            source_page_url: Some("https://x.com/home".into()),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: None,
        };
        assert_eq!(
            resolver_target_url(&x_status, false).unwrap().as_str(),
            "https://x.com/example/status/1234567890"
        );
    }

    #[test]
    fn site_authorization_accepts_only_bounded_cookies_for_the_selected_site() {
        let authorized = MediaTransferRequest {
            url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            audio_url: None,
            file_name: "bilibili.mp4".into(),
            mime_type: None,
            source_page_url: Some("https://www.bilibili.com/video/BV1xx411c7mD".into()),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: Some(MediaSiteAuth {
                cookies: vec![MediaSiteCookie {
                    name: "SESSDATA".into(),
                    value: "fixture-session".into(),
                    domain: ".bilibili.com".into(),
                    path: "/".into(),
                    expires: 2_000_000_000,
                    secure: true,
                    http_only: true,
                }],
                user_agent: String::new(),
                referer: String::new(),
            }),
        };
        assert!(validate_request(&authorized).is_ok());

        let mut wrong_site = authorized.clone();
        wrong_site.site_auth.as_mut().unwrap().cookies[0].domain = ".youtube.com".into();
        assert_eq!(
            validate_request(&wrong_site).unwrap_err().code,
            "media-input-invalid"
        );
    }

    #[test]
    fn site_authorization_accepts_only_bounded_browser_headers_for_the_exact_source_site() {
        let request: MediaTransferRequest = serde_json::from_value(serde_json::json!({
            "url": "https://www.bilibili.com/video/BV1xx411c7mD",
            "fileName": "bili.mp4",
            "sourcePageUrl": "https://www.bilibili.com/video/BV1xx411c7mD",
            "siteAuth": {
                "cookies": [{
                    "name": "SESSDATA", "value": "fixture-session", "domain": ".bilibili.com",
                    "path": "/", "expires": 2_000_000_000_i64, "secure": true, "httpOnly": true
                }],
                "userAgent": "Mozilla/5.0 Edg/126",
                "referer": "https://www.bilibili.com/video/BV1xx411c7mD"
            }
        }))
        .unwrap();
        assert!(validate_site_auth(&request), "{:?}", request.site_auth);
        validate_request(&request).unwrap();

        let mut public_headers_only = request.clone();
        public_headers_only
            .site_auth
            .as_mut()
            .unwrap()
            .cookies
            .clear();
        assert!(validate_site_auth(&public_headers_only));

        let mut empty = public_headers_only.clone();
        empty.site_auth.as_mut().unwrap().user_agent.clear();
        empty.site_auth.as_mut().unwrap().referer.clear();
        assert!(!validate_site_auth(&empty));

        let mut wrong_site = request.clone();
        wrong_site.site_auth.as_mut().unwrap().referer = "https://attacker.test/watch".into();
        assert_eq!(
            validate_request(&wrong_site).unwrap_err().code,
            "media-input-invalid"
        );

        let mut control = request;
        control.site_auth.as_mut().unwrap().user_agent = "Mozilla/5.0\r\nInjected: yes".into();
        assert_eq!(
            validate_request(&control).unwrap_err().code,
            "media-input-invalid"
        );
    }

    #[test]
    fn a_bounded_track_pair_is_accepted_only_for_the_exact_supported_source_site() {
        let request: MediaTransferRequest = serde_json::from_value(serde_json::json!({
            "url": "https://v.example.bilivideo.com/video-high.m4s",
            "audioUrl": "https://a.example.bilivideo.com/audio-high.m4s",
            "fileName": "Bilibili pair.mp4",
            "sourcePageUrl": "https://www.bilibili.com/video/BV1xx411c7mD",
            "siteAuth": {
                "cookies": [],
                "userAgent": "Mozilla/5.0 Edg/126",
                "referer": "https://www.bilibili.com/video/BV1xx411c7mD"
            }
        }))
        .unwrap();
        validate_request(&request).unwrap();

        let mut wrong_source = request.clone();
        wrong_source.source_page_url = Some("https://www.youtube.com/watch?v=fixture123".into());
        assert_eq!(
            validate_request(&wrong_source).unwrap_err().code,
            "media-input-invalid"
        );
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn external_resolver_receives_site_cookies_only_through_an_ephemeral_file() {
        let root = temp_root();
        let engine_root = root.join("engine");
        std::fs::create_dir_all(&engine_root).unwrap();
        std::fs::write(
            engine_root.join("cookie_fixture.py"),
            concat!(
                "import json, os, sys\n",
                "request = json.loads(sys.stdin.read())\n",
                "assert request['userAgent'] == 'Mozilla/5.0 Edg/126'\n",
                "assert request['referer'] == 'https://www.bilibili.com/video/BV1xx411c7mD'\n",
                "cookie_path = os.environ.get('LUCKYRAY_MEDIA_COOKIE_FILE', '')\n",
                "assert cookie_path and os.path.isfile(cookie_path)\n",
                "with open(cookie_path, 'r', encoding='utf-8') as stream:\n",
                "    content = stream.read()\n",
                "assert 'SESSDATA' in content and 'fixture-session' in content\n",
                "with open(os.environ['LUCKYRAY_MEDIA_OUTPUT'], 'wb') as stream:\n",
                "    stream.write(b'\\x00\\x00\\x00\\x18ftypisom\\x00\\x00\\x00\\x00isommp42\\x00\\x00\\x00\\x12mdatauthorized')\n",
            ),
        )
        .unwrap();
        let python = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("media-engine")
            .join("python.exe");
        let resolver = ExternalMediaResolver::for_test(python, engine_root, "cookie_fixture.py");
        let output = root.join("authorized.part");
        let request = MediaTransferRequest {
            url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            audio_url: None,
            file_name: "authorized.mp4".into(),
            mime_type: None,
            source_page_url: Some("https://www.bilibili.com/video/BV1xx411c7mD".into()),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: Some(MediaSiteAuth {
                cookies: vec![MediaSiteCookie {
                    name: "SESSDATA".into(),
                    value: "fixture-session".into(),
                    domain: ".bilibili.com".into(),
                    path: "/".into(),
                    expires: 2_000_000_000,
                    secure: true,
                    http_only: true,
                }],
                user_agent: "Mozilla/5.0 Edg/126".into(),
                referer: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            }),
        };
        let mut progress = |_: u64, _: Option<u64>| {};
        let result = resolver.transfer(
            &request,
            None,
            &output,
            &AtomicBool::new(false),
            &test_limits(),
            &mut progress,
        );
        assert!(result.is_ok(), "authorized resolver failed");
        assert!(output.is_file());
        assert!(!root.join("media-cookies.txt").exists());
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn external_resolver_hands_a_validated_track_pair_to_the_app_owned_runner() {
        let root = temp_root();
        let engine_root = root.join("engine");
        std::fs::create_dir_all(&engine_root).unwrap();
        std::fs::write(
            engine_root.join("pair_fixture.py"),
            concat!(
                "import json, os, sys\n",
                "request = json.loads(sys.stdin.read())\n",
                "assert request['url'] == 'https://v.example.bilivideo.com/video-high.m4s'\n",
                "assert request['audioUrl'] == 'https://a.example.bilivideo.com/audio-high.m4s'\n",
                "assert request['referer'] == 'https://www.bilibili.com/video/BV1xx411c7mD'\n",
                "assert all('bilivideo' not in value for value in sys.argv)\n",
                "with open(os.environ['LUCKYRAY_MEDIA_OUTPUT'], 'wb') as stream:\n",
                "    stream.write(b'\\x00\\x00\\x00\\x18ftypisom\\x00\\x00\\x00\\x00isommp42\\x00\\x00\\x00\\x12mdatauthorized')\n",
            ),
        )
        .unwrap();
        let python = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("media-engine")
            .join("python.exe");
        let resolver = ExternalMediaResolver::for_test(python, engine_root, "pair_fixture.py");
        let output = root.join("pair.part");
        let request = MediaTransferRequest {
            url: "https://v.example.bilivideo.com/video-high.m4s".into(),
            audio_url: Some("https://a.example.bilivideo.com/audio-high.m4s".into()),
            file_name: "Bilibili pair.mp4".into(),
            mime_type: Some("video/mp4".into()),
            source_page_url: Some("https://www.bilibili.com/video/BV1xx411c7mD".into()),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: Some(MediaSiteAuth {
                cookies: vec![],
                user_agent: "Mozilla/5.0 Edg/126".into(),
                referer: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            }),
        };
        let mut progress = |_: u64, _: Option<u64>| {};
        let result = resolver.transfer(
            &request,
            None,
            &output,
            &AtomicBool::new(false),
            &test_limits(),
            &mut progress,
        );
        assert!(result.is_ok(), "track-pair resolver failed");
        assert!(output.is_file());
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn external_resolver_projects_only_a_fixed_child_failure_code() {
        let root = temp_root();
        let engine_root = root.join("engine");
        std::fs::create_dir_all(&engine_root).unwrap();
        std::fs::write(
            engine_root.join("failure_fixture.py"),
            concat!(
                "import sys\n",
                "sys.stdout.write('luckyray-media-status-v1:authentication-required\\n')\n",
                "sys.stderr.write('PRIVATE raw provider body C:\\\\Users\\\\secret\\n')\n",
                "raise SystemExit(70)\n",
            ),
        )
        .unwrap();
        let python = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("media-engine")
            .join("python.exe");
        let resolver = ExternalMediaResolver::for_test(python, engine_root, "failure_fixture.py");
        let request = MediaTransferRequest {
            url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            audio_url: None,
            file_name: "failure.mp4".into(),
            mime_type: None,
            source_page_url: Some("https://www.bilibili.com/video/BV1xx411c7mD".into()),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            site_auth: None,
        };
        let mut progress = |_: u64, _: Option<u64>| {};
        let error = match resolver.transfer(
            &request,
            None,
            &root.join("failed.part"),
            &AtomicBool::new(false),
            &test_limits(),
            &mut progress,
        ) {
            Ok(_) => panic!("resolver failure fixture unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code, "media-authentication-required");
        assert!(!format!("{error:?}").contains("PRIVATE"));
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn public_external_resolver_receives_target_on_stdin_and_imports_verified_output() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: 6\r\nConnection: close\r\n\r\n<MPD/>")
                .unwrap();
        });
        let root = temp_root();
        let engine_root = root.join("engine");
        std::fs::create_dir_all(&engine_root).unwrap();
        std::fs::write(
            engine_root.join("fixture.py"),
            concat!(
                "import json, os, sys\n",
                "request = json.loads(sys.stdin.read())\n",
                "assert request['url'].startswith('http://127.0.0.1:')\n",
                "with open(os.environ['LUCKYRAY_MEDIA_OUTPUT'], 'wb') as stream:\n",
                "    stream.write(b'\\x00\\x00\\x00\\x18ftypisom\\x00\\x00\\x00\\x00isommp42\\x00\\x00\\x00\\x10mdatexternal')\n",
            ),
        )
        .unwrap();
        let python = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("media-engine")
            .join("python.exe");
        assert!(python.is_file(), "app-owned test Python is missing");
        let resolver = ExternalMediaResolver::for_test(python, engine_root, "fixture.py");
        let catalog = MaterialCatalog::new_for_test_at(&root);
        let service = MediaTransferService::new_for_test_with_resolver(
            &root,
            catalog.clone(),
            test_limits(),
            Arc::new(resolver),
        );
        let started = service
            .start(MediaTransferRequest {
                url: format!("http://{address}/manifest.mpd?token=PRIVATE"),
                audio_url: None,
                file_name: "external.mp4".into(),
                mime_type: None,
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let completed = wait_terminal(&service, &started.transfer_id);
        assert_eq!(completed.state, MediaTransferState::Completed);
        let json = serde_json::to_string(&completed).unwrap();
        assert!(!json.contains("PRIVATE") && !json.contains("127.0.0.1"));
        assert_eq!(
            std::fs::read(
                catalog
                    .list_assets(&crate::materials::MaterialFilter::default())
                    .unwrap()[0]
                    .library_path
                    .as_ref()
                    .unwrap()
            )
            .unwrap(),
            fixture_mp4(b"external")
        );
        server.join().unwrap();
    }
}
