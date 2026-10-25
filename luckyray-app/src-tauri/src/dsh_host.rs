#[path = "dsh_update_remote_policy.rs"]
mod update_remote_policy;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(crate) const UPDATE_ADAPTER_PROTOCOL: u64 = 1;
// The pinned authenticated carrier announces readiness only after both the
// official loader and its one-way authenticated login URL relay have settled.
pub(crate) const UPDATE_LOGIN_RELAY_READY_PROTOCOL: u64 = 1;
const PROTOCOL: u64 = UPDATE_ADAPTER_PROTOCOL;
const MAX_FRAME_BYTES: usize = 3 * 1024 * 1024;
const MAX_CANVAS_AGENT_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_CANVAS_AGENT_ENCODED_BYTES: usize = ((MAX_CANVAS_AGENT_JSON_BYTES + 2) / 3) * 4;
const MAX_EXPIRED_CANVAS_REQUESTS: usize = 8;
const MAX_RESOURCE_RESULT_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESOURCE_RESULT_ENCODED_BYTES: usize = 12 * 1024 * 1024;
const MAX_OPEN_INTENT_BYTES: usize = 280 * 1024;
const MAX_OPEN_INTENT_ENCODED_BYTES: usize = 376 * 1024;
const MAX_OPEN_INTENT_LOCAL_RESOURCES: usize = 64;
const MAX_OPEN_INTENT_LOCAL_PATH_BYTES: usize = 4 * 1024;
const MAX_OPEN_INTENT_IMAGE_ATTACHMENTS: usize = 20;
const MAX_OPEN_INTENT_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_OPEN_INTENT_FILE_BYTES: u64 = 200 * 1024 * 1024;
const RESOURCE_RESULT_CHUNK_BYTES: usize = 180 * 1024;
const MAX_HOST_SCRIPT_BYTES: usize = 128 * 1024;
const HOST_SCRIPT_SHA256: &str =
    "3ce4fbf4abaf4e5cbbd5b4f03c5992dee165fa0a58eeea4aa93e4ce985ead31b";
const HOST_COMPAT_SCRIPT: &str = "luckyray-dsh-plugin-compat.mjs";
const HOST_COMPAT_SCRIPT_SHA256: &str =
    "667322ba0a798db057bcf5152a5fcf0b7664b57d0041045beaa011fd296e40d1";

/// The compatibility authority module is pinned exactly like the wrapper
/// itself: a tampered or corrupted file fails closed before any host runs.
fn verify_host_compat_script(host_script: &Path) -> Result<(), ()> {
    let compat_script = host_script.parent().ok_or(())?.join(HOST_COMPAT_SCRIPT);
    if !safe_regular_file(&compat_script) {
        return Err(());
    }
    if hash_normalized_host_script(&compat_script)? != HOST_COMPAT_SCRIPT_SHA256 {
        return Err(());
    }
    Ok(())
}
const SURFACE_PLUGIN_SHA256: &str =
    "c61767ce9c54abfde8360e0a39d178e5930319ef4f31e81b538b8eef6657ce86";
const CANVAS_AGENT_SHA256: &str =
    "f5e0f7fb74ed3cff53de5f35a7a26775edc87b5db121e937e1f58faa33b27050";
const PROVIDER_EXPORT_SHA256: &str =
    "ec8eb5f6a939a8555d0b7341b27bc34131ba75a27ecf0317e788fecfc32d11c3";
const RESOURCE_PLUGIN_SHA256: &str =
    "ebfe3fd055b16c084be728edc4bd2449284007cf12b7ef744dc83f2342ed8648";
const CARRIER_PACKAGE_SHA256: &str =
    "b8a78c0ca95db66305caa9a57db32129bc9e15336ad0c7a436199781e644a4e3";
const RESOURCE_PACKAGE_SHA256: &str =
    "cdaba2444fffffe3ec68b1ec3cc3fdef96df52f567c965e9ef54893c4ce8f139";
const RESOURCE_MANIFEST_SHA256: &str =
    "18a656f8518ba9423793df96ca09116f95d8b80bf4125b91a5cbdfe0f52bd5e4";
const SURFACE_PATCH_SHA256: &str =
    "f4737070bffdb6ed3c332b4130b1b6442211ec3ad6179fd65c56ade268bc6d39";
const SURFACE_STATE_PACKAGE_SHA256: &str =
    "c3336a0c3dd50b9f0d1d01f7455abc684df1de1bc6a12a08d659a85fb0246e01";
const SURFACE_STATE_CLIENT_SHA256: &str =
    "ca72af88d8cb7e2886111e3a970e4265c4660594e9a2d1eb2a111105a113d3ca";
const LIGHTSEEK_UI_PACKAGE_SHA256: &str =
    "bb3a22eb538eb2807cc12f3e7a09d341af9739f6f51e5effaadbcb49090518a9";
const LIGHTSEEK_UI_CLIENT_SHA256: &str =
    "d32daa2219406438c582aab4d703ede17b4576049ea0d0e9dded69831a6ee81d";
const LIGHTSEEK_UI_BACKGROUND_SHA256: &str =
    "c9a7c10921c97717d99a8630ec3ba39436a8557d723a64c12bffc996a96fd97a";
const PROBE_TIMEOUT: Duration = Duration::from_secs(75);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const RESTART_BACKOFF: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_secs(1),
    Duration::from_secs(4),
];

fn final_teardown_verdict(host_settled: bool, whole_job_settled: Option<bool>) -> bool {
    whole_job_settled.unwrap_or(host_settled)
}

fn monitor_restart_allowed(teardown_settled: bool, launched_with_probe: bool) -> bool {
    // Never replace an unconfirmed owned tree, and never promote a
    // recovery-only control channel into a full composition probe.
    teardown_settled && launched_with_probe
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn take_mutex_value<T>(slot: &Mutex<Option<T>>) -> Option<T> {
    slot.lock().unwrap().take()
}

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DshHostAction {
    Probe,
    ExplicitRetry,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchFailure {
    ShutdownCancelled,
    RuntimeSealInvalid,
    HostFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DshHostStage {
    Initializing,
    Unavailable,
    BundledVerified,
    Starting,
    ProcessAlive,
    ProtocolAuthenticated,
    SessionReady,
    ExactTurnAccepted,
    ProbeCompleted,
    RestartWaiting,
    ShuttingDown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshHostStatusView {
    pub(crate) stage: DshHostStage,
    pub(crate) latest_probe_passed: bool,
    pub(crate) host_reusable: bool,
    pub(crate) can_probe: bool,
    pub(crate) can_retry: bool,
    pub(crate) shutting_down: bool,
    pub(crate) retry_attempt: u8,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) message: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshNativeSurfaceStatusView {
    pub(crate) ready: bool,
    pub(crate) stage: DshNativeSurfaceStage,
    pub(crate) cold_jit_ms: Option<u64>,
    pub(crate) carrier_bind_ms: Option<u64>,
    pub(crate) outer_host_rss_mb: Option<u64>,
    pub(crate) lucky_ray_process_handle_count: Option<u32>,
    pub(crate) owned_direct_process_count: u8,
    pub(crate) message: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DshNativeSurfaceStage {
    Closed,
    CarrierReady,
    WebviewCreated,
    ClientReady,
    SessionOpen,
    Unavailable,
}

pub(crate) struct DshNativeSurfaceBootstrap {
    pub(crate) host_generation: u64,
    pub(crate) carrier_generation: u64,
    pub(crate) port: u16,
    pub(crate) bootstrap_path: String,
    pub(crate) bootstrap_ref: String,
    pub(crate) host_rss_mb: u64,
    pub(crate) owned_process_count: u8,
}

/// One device-scoped, single-use remote bootstrap minted by the carrier. The
/// reference binds device + gateway generation + carrier generation and never
/// outlives the carrier binding it was minted for.
pub(crate) struct DshRemoteSessionBootstrap {
    pub(crate) reference: String,
    pub(crate) expires_at_ms: u64,
    pub(crate) bootstrap_path: String,
    pub(crate) carrier_generation: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DshModelSyncProjection {
    pub(crate) outcome: String,
    pub(crate) default_source_identity: Option<String>,
    #[serde(default)]
    pub(crate) providers: Vec<DshProviderSyncDescriptor>,
    #[serde(default)]
    pub(crate) secrets: Vec<DshProviderSyncSecret>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DshProviderSyncDescriptor {
    pub(crate) source_identity: String,
    pub(crate) source: String,
    pub(crate) provider: String,
    pub(crate) profile_id: String,
    pub(crate) display_name: String,
    pub(crate) settings_ns: String,
    pub(crate) settings_path: Vec<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) wire_protocol: Option<String>,
    pub(crate) credential_ref: Option<String>,
    pub(crate) portable: bool,
    pub(crate) syncable: bool,
    pub(crate) reason: String,
    pub(crate) models: Vec<DshProviderSyncModel>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DshProviderSyncModel {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) input: Vec<String>,
    pub(crate) input_state: String,
    pub(crate) tool_calls: String,
    pub(crate) max_output_tokens: Option<u32>,
    pub(crate) context_window_tokens: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DshProviderSyncSecret {
    pub(crate) source_identity: String,
    pub(crate) value: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DshOpenIntentLocalResource {
    kind: String,
    asset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_id: Option<String>,
    canonical_path: String,
    delivery: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DshOpenIntent {
    intent_id: String,
    local_resources: Vec<DshOpenIntentLocalResource>,
    source: String,
    text: String,
}

impl DshOpenIntent {
    pub(crate) fn validate_material_context(&self, base: &crate::materials::MaterialCatalog) -> Result<(), String> {
        for resource in &self.local_resources {
            // Notes retain their existing authorized document/Vault projection contract.
            // Every ordinary material transfer is resolved again from its frozen Catalog identity.
            if resource.library_id.is_none() && self.source == "notes" { continue; }
            let catalog = match &resource.library_id {
                Some(id) => base.for_library(id).map_err(|e| e.message)?,
                None => base.clone(),
            };
            let paths = catalog.resolve_open_in_lightseek_paths(&[resource.asset_id.clone()]).map_err(|e|e.message)?;
            if paths.len() != 1 || paths[0] != Path::new(&resource.canonical_path) {return Err("dsh-open-intent-resource-context-mismatch".into());}
        }
        Ok(())
    }
    fn contains_local_path(value: &str) -> bool {
        let lower = value.to_ascii_lowercase();
        if lower.contains("file:///") || value.contains("\\\\") {
            return true;
        }
        let bytes = value.as_bytes();
        for index in 0..bytes.len().saturating_sub(2) {
            if bytes[index].is_ascii_alphabetic()
                && bytes[index + 1] == b':'
                && matches!(bytes[index + 2], b'\\' | b'/')
                && (index == 0 || !bytes[index - 1].is_ascii_alphanumeric())
            {
                return true;
            }
        }
        let bytes = value.as_bytes();
        bytes.iter().enumerate().any(|(index, byte)| {
            if *byte != b'/' || bytes.get(index + 1).is_none_or(|next| *next == b'/') {
                return false;
            }
            index == 0
                || !bytes[index - 1].is_ascii_alphanumeric()
                    && !matches!(bytes[index - 1], b':' | b'/' | b'\\')
        })
    }

    fn encode(self) -> Result<String, String> {
        let id = self.intent_id.as_bytes();
        let valid_id = id.len() >= 43
            && id.len() <= 64
            && self.intent_id.starts_with("intent-")
            && id
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
        let valid_source = matches!(
            self.source.as_str(),
            "materials" | "notes" | "collection" | "graph" | "search"
        );
        let valid_text = self.text.trim() == self.text
            && self.text.len() <= 12 * 1024
            && !self
                .text
                .chars()
                .any(|value| value.is_control() && value != '\n' && value != '\t')
            && !Self::contains_local_path(&self.text);
        let image_attachment_count = self
            .local_resources
            .iter()
            .filter(|resource| resource.delivery == "image-attachment")
            .count();
        let valid_local_resources = self.local_resources.len() <= MAX_OPEN_INTENT_LOCAL_RESOURCES
            && image_attachment_count <= MAX_OPEN_INTENT_IMAGE_ATTACHMENTS
            && (self.local_resources.is_empty()
                || matches!(self.source.as_str(), "materials" | "notes" | "collection"))
            && self.local_resources.iter().all(|resource| {
                let path = Path::new(&resource.canonical_path);
                let image_attachment = resource.delivery == "image-attachment";
                let path_reference = resource.delivery == "path-reference";
                let file_attachment = resource.delivery == "file-attachment";
                let image_extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| {
                        matches!(
                            value.to_ascii_lowercase().as_str(),
                            "png" | "jpg" | "jpeg" | "webp" | "gif"
                        )
                    });
                resource.kind == "material"
                    && (path_reference
                        || file_attachment
                            && matches!(self.source.as_str(), "materials" | "notes")
                            && path.metadata().is_ok_and(|metadata| {
                                metadata.is_file() && metadata.len() <= MAX_OPEN_INTENT_FILE_BYTES
                            })
                        || image_attachment
                            && matches!(self.source.as_str(), "materials" | "notes")
                            && image_extension
                            && path.metadata().is_ok_and(|metadata| {
                                metadata.is_file()
                                    && metadata.len() > 0
                                    && metadata.len() <= MAX_OPEN_INTENT_IMAGE_BYTES
                            }))
                    && resource.library_id.as_ref().is_none_or(|id| !id.is_empty() && id.len()<=256 && id.trim()==id && !id.chars().any(char::is_control))
                    && !resource.asset_id.is_empty()
                    && resource.asset_id.len() <= 256
                    && resource.asset_id.trim() == resource.asset_id
                    && !resource.asset_id.chars().any(char::is_control)
                    && !resource.canonical_path.is_empty()
                    && resource.canonical_path.len() <= MAX_OPEN_INTENT_LOCAL_PATH_BYTES
                    && resource.canonical_path.trim() == resource.canonical_path
                    && !resource.canonical_path.chars().any(char::is_control)
                    && path.is_absolute()
                    && path.is_file()
                    && path.canonicalize().is_ok_and(|canonical| canonical == path)
            });
        let has_payload = !self.text.is_empty() || !self.local_resources.is_empty();
        if !valid_id || !valid_source || !valid_text || !valid_local_resources || !has_payload {
            return Err("dsh-open-intent-invalid".to_owned());
        }
        let bytes = serde_json::to_vec(&self).map_err(|_| "dsh-open-intent-invalid".to_owned())?;
        if bytes.is_empty() || bytes.len() > MAX_OPEN_INTENT_BYTES {
            return Err("dsh-open-intent-invalid".to_owned());
        }
        let encoded = URL_SAFE_NO_PAD.encode(bytes);
        if encoded.len() > MAX_OPEN_INTENT_ENCODED_BYTES {
            return Err("dsh-open-intent-invalid".to_owned());
        }
        Ok(encoded)
    }
}

impl DshHostStatusView {
    fn unavailable(message: &'static str) -> Self {
        Self {
            stage: DshHostStage::Unavailable,
            latest_probe_passed: false,
            host_reusable: false,
            can_probe: false,
            can_retry: false,
            shutting_down: false,
            retry_attempt: 0,
            duration_ms: None,
            message,
        }
    }
}

#[derive(Debug)]
struct RuntimeDescriptor {
    runtime_identity: crate::dsh_runtime_seal::RuntimeIdentityLease,
    update_store: Option<Arc<crate::dsh_engine_update::UpdateStore>>,
    root: PathBuf,
    dynamic_candidate: Option<crate::dsh_engine_update::Candidate>,
    dynamic_pending_health: bool,
    host_script: PathBuf,
    state_root: PathBuf,
    surface_state_root: PathBuf,
    surface_assets: [PathBuf; 13],
    surface_patch: PathBuf,
    surface_patch_sha256: String,
    surface_module_files: [PathBuf; 12],
    surface_module_sha256: [String; 12],
}

/// Holds stable leases for the lifetime of one Host generation use; the
/// fields are deliberately unread because dropping them releases the locks.
struct RuntimeUseLease {
    #[allow(dead_code)]
    host_script: crate::dsh_runtime_seal::StableFileLease,
    #[allow(dead_code)]
    surface_assets: Vec<crate::dsh_runtime_seal::StableFileLease>,
    #[allow(dead_code)]
    surface_patch: crate::dsh_runtime_seal::StableFileLease,
    #[allow(dead_code)]
    surface_module_files: Vec<crate::dsh_runtime_seal::StableFileLease>,
}

impl RuntimeDescriptor {
    fn resolve(resource_dir: &Path, app_data_dir: &Path) -> Result<Self, ()> {
        // Tauri may surface the development resource directory using a
        // Windows verbatim prefix (`\\?\C:\...`). The runtime seal opens the
        // same trusted files through Win32 APIs that reject that spelling in
        // part of the stable-handle path. Normalize only this Tauri-owned root
        // before joining fixed descendants; all existing identity, reparse,
        // hard-link and digest checks still run on the resulting paths.
        let resource_dir = normalize_windows_verbatim_path(resource_dir)?;
        // A previously activated engine is selected only through its signed
        // marker and critical launch identity. Invalid active state fails closed: an
        // older bundled engine must not read data the newer one may have
        // migrated or written before a crash.
        // The original first-run path creates these directories. Do so before
        // opening the update namespace; a fresh installation has no AppData
        // directory yet. This creates no session/config file or host writer.
        let (state_root, surface_state_root) = prepare_dsh_state_roots(app_data_dir)?;
        let update_store = Arc::new(crate::dsh_engine_update::UpdateStore::open(app_data_dir)
            .map_err(|_| ())?);
        if let Err(error) = update_store.complete_pending_switch(app_data_dir) {
            // Persist the redacted failure category so the settings surface
            // can name the stage instead of reporting a generic dead host.
            crate::dsh_engine_update::record_switch_error(app_data_dir, &error);
            return Err(());
        }
        let active = update_store.load_active().map_err(|_| ())?;
        let (root, dynamic_candidate, dynamic_pending_health) = match active {
            Some(installed) => (installed.root, Some(installed.candidate), installed.pending_health),
            None => {
                #[cfg(feature = "issue189-frozen-old-fixture")]
                let bundled = resource_dir.join("deepseek-harness-issue189-old");
                #[cfg(not(feature = "issue189-frozen-old-fixture"))]
                let bundled = resource_dir.join("deepseek-harness");
                (bundled, None, false)
            },
        };
        let host_dir = resource_dir.join("dsh-host");
        Self::from_verified_root_with_candidate(
            root,
            dynamic_candidate,
            dynamic_pending_health,
            Some(update_store),
            host_dir.join("luckyray-dsh-host.mjs"),
            state_root,
            surface_state_root,
            [
                host_dir.join("luckyray-dsh-authenticated-webserver/index.mjs"),
                host_dir.join("luckyray-dsh-resource-tools/index.mjs"),
                host_dir.join("luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json"),
                host_dir.join("luckyray-dsh-native-surface.patch.yml"),
                host_dir.join("luckyray-dsh-native-surface-state/package.json"),
                host_dir.join("luckyray-dsh-native-surface-state/client.js"),
                host_dir.join("luckyray-dsh-lightseek-ui/package.json"),
                host_dir.join("luckyray-dsh-lightseek-ui/client.js"),
                host_dir.join("luckyray-dsh-lightseek-ui/lightseek-cosmic-home.webp"),
                host_dir
                    .join("luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs"),
                host_dir.join("luckyray-dsh-authenticated-webserver/package.json"),
                host_dir.join("luckyray-dsh-resource-tools/package.json"),
                host_dir.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs"),
            ],
        )
    }

    fn from_verified_root(
        root: PathBuf,
        host_script: PathBuf,
        state_root: PathBuf,
        surface_state_root: PathBuf,
        surface_assets: [PathBuf; 13],
    ) -> Result<Self, ()> {
        Self::from_verified_root_with_candidate(
            root, None, false, None, host_script, state_root, surface_state_root, surface_assets,
        )
    }

    fn from_verified_root_with_candidate(
        root: PathBuf,
        dynamic_candidate: Option<crate::dsh_engine_update::Candidate>,
        dynamic_pending_health: bool,
        update_store: Option<Arc<crate::dsh_engine_update::UpdateStore>>,
        host_script: PathBuf,
        state_root: PathBuf,
        surface_state_root: PathBuf,
        surface_assets: [PathBuf; 13],
    ) -> Result<Self, ()> {
        if !root.is_absolute()
            || !state_root.is_absolute()
            || !surface_state_root.is_absolute()
            || !safe_regular_file(&host_script)
            || !safe_directory(&state_root)
            || !safe_directory(&surface_state_root)
        {
            return Err(());
        }
        if hash_normalized_host_script(&host_script)? != HOST_SCRIPT_SHA256 {
            return Err(());
        }
        verify_host_compat_script(&host_script)?;
        verify_surface_assets(&surface_assets)?;
        let (surface_patch, surface_patch_sha256) =
            materialize_surface_patch(&surface_state_root, &surface_assets)?;
        let (surface_module_files, surface_module_sha256) =
            materialize_surface_modules(&surface_state_root, &surface_assets)?;
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let control = crate::dsh_runtime_seal::RuntimeSealControl::new(&cancelled);
        let runtime_identity = match &dynamic_candidate {
            Some(candidate) => crate::dsh_runtime_seal::RuntimeIdentityLease::acquire_identity(
                &root, &crate::dsh_engine_update::runtime_launch_identity(candidate), &control),
            None => crate::dsh_runtime_seal::RuntimeIdentityLease::acquire(&root, &control),
        }.map_err(|_| ())?;
        Ok(Self {
            runtime_identity,
            update_store,
            root,
            dynamic_candidate,
            dynamic_pending_health,
            host_script,
            state_root,
            surface_state_root,
            surface_assets,
            surface_patch,
            surface_patch_sha256,
            surface_module_files,
            surface_module_sha256,
        })
    }

    fn acquire_use_lease(
        &self,
        control: &crate::dsh_runtime_seal::RuntimeSealControl<'_>,
    ) -> Result<RuntimeUseLease, crate::dsh_runtime_seal::RuntimeSealError> {
        let host_script = crate::dsh_runtime_seal::acquire_stable_file(&self.host_script)
            .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?;
        if hash_normalized_host_script(&self.host_script)
            .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?
            != HOST_SCRIPT_SHA256
        {
            return Err(crate::dsh_runtime_seal::RuntimeSealError::Invalid);
        }
        verify_host_compat_script(&self.host_script)
            .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?;
        verify_surface_assets(&self.surface_assets)
            .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?;
        let mut surface_assets = Vec::with_capacity(self.surface_assets.len());
        for path in &self.surface_assets {
            surface_assets.push(
                crate::dsh_runtime_seal::acquire_stable_file(path)
                    .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?,
            );
        }
        let surface_patch =
            acquire_verified_surface_patch(&self.surface_patch, &self.surface_patch_sha256)?;
        let mut surface_module_files = Vec::with_capacity(self.surface_module_files.len());
        for (path, digest) in self
            .surface_module_files
            .iter()
            .zip(self.surface_module_sha256.iter())
        {
            surface_module_files.push(acquire_verified_exact_file(path, digest)?);
        }
        self.runtime_identity.revalidate(control)?;
        Ok(RuntimeUseLease {
            host_script,
            surface_assets,
            surface_patch,
            surface_module_files,
        })
    }
}

fn normalize_windows_verbatim_path(path: &Path) -> Result<PathBuf, ()> {
    let text = path.to_str().ok_or(())?;
    #[cfg(windows)]
    let normalized = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    };
    #[cfg(not(windows))]
    let normalized = path.to_path_buf();
    if normalized.is_absolute() {
        Ok(normalized)
    } else {
        Err(())
    }
}

fn acquire_verified_surface_patch(
    path: &Path,
    expected_sha256: &str,
) -> Result<crate::dsh_runtime_seal::StableFileLease, crate::dsh_runtime_seal::RuntimeSealError> {
    let lease = crate::dsh_runtime_seal::acquire_stable_file(path)
        .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?;
    if hash_normalized_host_script(path)
        .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?
        != expected_sha256
    {
        return Err(crate::dsh_runtime_seal::RuntimeSealError::Invalid);
    }
    lease
        .revalidate()
        .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?;
    Ok(lease)
}

fn verify_surface_assets(paths: &[PathBuf; 13]) -> Result<(), ()> {
    let expected = [
        SURFACE_PLUGIN_SHA256,
        RESOURCE_PLUGIN_SHA256,
        RESOURCE_MANIFEST_SHA256,
        SURFACE_PATCH_SHA256,
        SURFACE_STATE_PACKAGE_SHA256,
        SURFACE_STATE_CLIENT_SHA256,
        LIGHTSEEK_UI_PACKAGE_SHA256,
        LIGHTSEEK_UI_CLIENT_SHA256,
        LIGHTSEEK_UI_BACKGROUND_SHA256,
        PROVIDER_EXPORT_SHA256,
        CARRIER_PACKAGE_SHA256,
        RESOURCE_PACKAGE_SHA256,
        CANVAS_AGENT_SHA256,
    ];
    for (index, (path, digest)) in paths.iter().zip(expected).enumerate() {
        let actual = if index == 8 {
            exact_file_sha256(path)?
        } else {
            hash_normalized_host_script(path)?
        };
        if !safe_regular_file(path) || actual != digest {
            return Err(());
        }
    }
    Ok(())
}

fn file_url(path: &Path) -> Result<String, ()> {
    // Standards-based conversion at the url crate boundary. Windows
    // canonicalize() may return verbatim forms that hand-rolled encoding
    // previously serialized into invalid URLs (`file://///%3F/C:/...`),
    // which Node's ESM loader rejects with ERR_INVALID_FILE_URL_PATH.
    // Normalize the verbatim prefixes away, then let `url` own all escaping.
    let text = path.to_str().ok_or(())?;
    if text.contains(['\r', '\n', '"']) {
        return Err(());
    }
    let normalized = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        text.to_owned()
    };
    let normalized_path = std::path::Path::new(&normalized);
    if !normalized_path.is_absolute() {
        return Err(());
    }
    url::Url::from_file_path(normalized_path)
        .map(|url| url.to_string())
        .map_err(|_| ())
}

fn exact_file_sha256(path: &Path) -> Result<String, ()> {
    let bytes = std::fs::read(path).map_err(|_| ())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn acquire_verified_exact_file(
    path: &Path,
    expected_sha256: &str,
) -> Result<crate::dsh_runtime_seal::StableFileLease, crate::dsh_runtime_seal::RuntimeSealError> {
    let lease = crate::dsh_runtime_seal::acquire_stable_file(path)
        .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?;
    if exact_file_sha256(path).map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?
        != expected_sha256
    {
        return Err(crate::dsh_runtime_seal::RuntimeSealError::Invalid);
    }
    lease
        .revalidate()
        .map_err(|_| crate::dsh_runtime_seal::RuntimeSealError::Invalid)?;
    Ok(lease)
}

fn materialize_surface_patch(root: &Path, assets: &[PathBuf; 13]) -> Result<(PathBuf, String), ()> {
    let template = std::fs::read_to_string(&assets[3])
        .map_err(|_| ())?
        .replace("\r\n", "\n");
    if template.contains('\r') {
        return Err(());
    }
    // 0.1.5 resolves plugin entries by package name from profiles/node_modules;
    // the template carries the final @luckyray names and needs no rendering.
    let rendered = template;
    if rendered.contains("__LUCKYRAY") || rendered.contains("!!js") || rendered.len() > 64 * 1024 {
        return Err(());
    }
    let target = root.join("luckyray-dsh-native-surface.generated.patch.yml");
    let expected_digest = format!("{:x}", Sha256::digest(rendered.as_bytes()));
    let temporary = root.join(".luckyray-dsh-native-surface.generated.patch.tmp");
    let _ = std::fs::remove_file(&temporary);
    {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| ())?;
        file.write_all(rendered.as_bytes()).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
    }
    if target.exists() {
        let existing = std::fs::read(&target).map_err(|_| ())?;
        if existing == rendered.as_bytes() {
            std::fs::remove_file(&temporary).map_err(|_| ())?;
            return Ok((target, expected_digest));
        }
        std::fs::remove_file(&target).map_err(|_| ())?;
    }
    std::fs::rename(&temporary, &target).map_err(|_| ())?;
    if !safe_regular_file(&target) || std::fs::read(&target).map_err(|_| ())? != rendered.as_bytes()
    {
        return Err(());
    }
    Ok((target, expected_digest))
}

fn materialize_surface_modules(
    root: &Path,
    assets: &[PathBuf; 13],
) -> Result<([PathBuf; 12], [String; 12]), ()> {
    // Every carrier plugin is a real @luckyray package under
    // profiles/node_modules: the 0.1.5 loader resolves plugin entries by
    // package name and no longer loads file URL entries.
    let packages = [
        ("dsh-authenticated-webserver", "package.json", 10usize),
        ("dsh-authenticated-webserver", "index.mjs", 0usize),
        (
            "dsh-authenticated-webserver",
            "luckyray-dsh-provider-export.mjs",
            9usize,
        ),
        ("dsh-resource-tools", "package.json", 11usize),
        ("dsh-resource-tools", "index.mjs", 1usize),
        (
            "dsh-resource-tools",
            "luckyray-dsh-resource-tools.json",
            2usize,
        ),
        ("dsh-native-surface-state", "package.json", 4usize),
        ("dsh-native-surface-state", "client.js", 5usize),
        ("dsh-lightseek-ui", "package.json", 6usize),
        ("dsh-lightseek-ui", "client.js", 7usize),
        ("dsh-lightseek-ui", "lightseek-cosmic-home.webp", 8usize),
        ("dsh-authenticated-webserver", "luckyray-dsh-canvas-agent.mjs", 12usize),
    ];
    let mut targets: [PathBuf; 12] = std::array::from_fn(|_| PathBuf::new());
    for (index, (package, file, _)) in packages.iter().enumerate() {
        let directory = root
            .join("profiles")
            .join("node_modules")
            .join("@luckyray")
            .join(package);
        std::fs::create_dir_all(&directory).map_err(|_| ())?;
        if !safe_directory(&directory) {
            return Err(());
        }
        targets[index] = directory.join(file);
    }
    let mut digests: [String; 12] = std::array::from_fn(|_| String::new());
    for index in 0..targets.len() {
        let source = std::fs::read(&assets[packages[index].2]).map_err(|_| ())?;
        let max_bytes = if packages[index].1.ends_with(".webp") {
            600 * 1024
        } else {
            256 * 1024
        };
        if source.is_empty() || source.len() > max_bytes {
            return Err(());
        }
        let target = &targets[index];
        let temporary = target.with_extension(format!("luckyray-tmp-{}", std::process::id()));
        let _ = std::fs::remove_file(&temporary);
        {
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|_| ())?;
            file.write_all(&source).map_err(|_| ())?;
            file.sync_all().map_err(|_| ())?;
        }
        if target.exists() {
            if safe_regular_file(target) && std::fs::read(target).map_err(|_| ())? == source {
                std::fs::remove_file(&temporary).map_err(|_| ())?;
            } else {
                std::fs::remove_file(target).map_err(|_| ())?;
                std::fs::rename(&temporary, target).map_err(|_| ())?;
            }
        } else {
            std::fs::rename(&temporary, target).map_err(|_| ())?;
        }
        if !safe_regular_file(target) || std::fs::read(target).map_err(|_| ())? != source {
            return Err(());
        }
        digests[index] = format!("{:x}", Sha256::digest(&source));
    }
    Ok((targets, digests))
}

fn prepare_dsh_state_roots(app_data_dir: &Path) -> Result<(PathBuf, PathBuf), ()> {
    if !app_data_dir.is_absolute() {
        return Err(());
    }
    let harness_root = app_data_dir.join("deepseek-harness");
    let native_state = harness_root.join("native-state");
    // This is a persistent user-data namespace, not the installed DSH version.
    // Keep it across runtime upgrades; official DSH owns format migration.
    let root = native_state.join("rc8-v1");
    let surface_root = native_state.join("rc8-native-surface-v1");
    std::fs::create_dir_all(&root).map_err(|_| ())?;
    std::fs::create_dir_all(&surface_root).map_err(|_| ())?;
    // Packaged Windows processes may transparently virtualize descendants of
    // AppData\Roaming into the package LocalCache. In that case the logical
    // app-data anchor and its freshly opened children canonicalize to
    // different prefixes even though no reparse point is involved. Validate
    // every writable namespace component before canonicalization, then bind
    // both state roots to the exact resolved native-state parent.
    if !safe_directory(app_data_dir)
        || !safe_directory(&harness_root)
        || !safe_directory(&native_state)
        || !safe_directory(&root)
        || !safe_directory(&surface_root)
    {
        return Err(());
    }
    let canonical_harness_root = std::fs::canonicalize(&harness_root).map_err(|_| ())?;
    let canonical_root = std::fs::canonicalize(&root).map_err(|_| ())?;
    let canonical_surface = std::fs::canonicalize(&surface_root).map_err(|_| ())?;
    let canonical_native_state = std::fs::canonicalize(&native_state).map_err(|_| ())?;
    if canonical_native_state.parent() != Some(canonical_harness_root.as_path())
        || canonical_root.parent() != Some(canonical_native_state.as_path())
        || canonical_surface.parent() != Some(canonical_native_state.as_path())
        || canonical_root == canonical_surface
    {
        return Err(());
    }
    // `canonicalize` is necessary to bind both writable state roots to the
    // same physical namespace, but on Windows it commonly returns `\\?\`
    // spelling. DSH's Node profile/module loader does not resolve its
    // provider graph equivalently from that spelling: the exact native
    // probe then ends with NO_ADAPTER even though all signed packages exist.
    // Strip only the Win32 verbatim prefix after the sibling/identity checks;
    // the returned paths still name the same verified physical directories.
    Ok((
        normalize_windows_verbatim_path(&canonical_root)?,
        normalize_windows_verbatim_path(&canonical_surface)?,
    ))
}

fn safe_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| {
            metadata.is_dir() && !metadata.file_type().is_symlink() && !is_reparse(&metadata)
        })
        .unwrap_or(false)
}

fn safe_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && !is_reparse(&metadata)
                && crate::dsh_runtime_seal::acquire_stable_file(path).is_ok()
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(_metadata: &std::fs::Metadata) -> bool {
    true
}

fn hash_normalized_host_script(path: &Path) -> Result<String, ()> {
    let bytes = std::fs::read(path).map_err(|_| ())?;
    if bytes.len() > MAX_HOST_SCRIPT_BYTES {
        return Err(());
    }
    let source = std::str::from_utf8(&bytes).map_err(|_| ())?;
    let normalized = source.replace("\r\n", "\n");
    if normalized.contains('\r') {
        return Err(());
    }
    let mut digest = Sha256::new();
    digest.update(normalized.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn canvas_agent_id(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_str).map(|id| {
        !id.is_empty() && id.len() <= 160
            && id.as_bytes()[0].is_ascii_alphanumeric()
            && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
    }).unwrap_or(false)
}

fn canvas_agent_fields(value: &serde_json::Value, allowed: &[&str], required: &[&str]) -> bool {
    value.as_object().map(|o| o.keys().all(|k| allowed.contains(&k.as_str())) && required.iter().all(|k| o.contains_key(*k))).unwrap_or(false)
}
fn canvas_agent_text(value: Option<&serde_json::Value>, max: usize, empty: bool) -> bool {
    value.and_then(serde_json::Value::as_str).map(|v| v.chars().count() <= max && (empty || !v.trim().is_empty())
        && !v.chars().any(|c| c == '\u{7f}' || (c < ' ' && !['\n','\r','\t'].contains(&c)))).unwrap_or(false)
}
fn canvas_agent_count(value: Option<&serde_json::Value>, max: u64) -> bool {
    value.and_then(serde_json::Value::as_u64).map(|v| v <= max).unwrap_or(false)
}
fn canvas_agent_revision(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_str).map(|s|s.len()==16 && s.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).unwrap_or(false)
}
fn canvas_agent_context_valid(c: &serde_json::Value, canvas_id: &str, images: bool) -> bool {
    let keys = ["version","canvasId","canvasName","nodes","connections","generation"];
    if !canvas_agent_fields(c,&["version","canvasId","canvasName","nodes","connections","generation","snapshotRevision"],&keys)
        || c.get("snapshotRevision").map(|v|!canvas_agent_revision(Some(v))).unwrap_or(false) || c.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || c.get("canvasId").and_then(serde_json::Value::as_str) != Some(canvas_id) || !canvas_agent_text(c.get("canvasName"),256,true) { return false; }
    let Some(nodes) = c.get("nodes").and_then(serde_json::Value::as_array) else { return false; };
    if nodes.len() > 256 { return false; }
    let mut ids=std::collections::HashSet::new(); let mut text_bytes=0usize; let mut image_bytes=0usize; let mut image_count=0usize;
    for n in nodes {
        let required=["id","title","kind","text","editable","revision"];
        let allowed=if images { vec!["id","title","kind","text","editable","revision","layout","imageUnavailable","image"] } else { vec!["id","title","kind","text","editable","revision","layout","imageUnavailable"] };
        if !canvas_agent_fields(n,&allowed,&required) || !canvas_agent_id(n.get("id")) || !ids.insert(n.get("id").and_then(serde_json::Value::as_str).unwrap_or(""))
            || !canvas_agent_text(n.get("title"),256,true) || !canvas_agent_text(n.get("text"),24000,true)
            || !matches!(n.get("kind").and_then(serde_json::Value::as_str),Some("text"|"image"|"video"|"note"|"group"))
            || !n.get("editable").map(serde_json::Value::is_boolean).unwrap_or(false)
            || !n.get("revision").and_then(serde_json::Value::as_str).map(|r|r.len()==16 && r.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))).unwrap_or(false)
            || n.get("layout").map(|l|!canvas_agent_fields(l,&["x","y","parentId"],&["x","y"]) || !["x","y"].iter().all(|k|l.get(*k).and_then(serde_json::Value::as_f64).map(|n|n.is_finite()&&n.abs()<=1e7).unwrap_or(false)) || l.get("parentId").map(|id|!canvas_agent_id(Some(id))).unwrap_or(false)).unwrap_or(false)
            || n.get("imageUnavailable").map(|v|!v.is_boolean()).unwrap_or(false) { return false; }
        text_bytes += n.get("text").and_then(serde_json::Value::as_str).unwrap_or("").len();
        if let Some(image)=n.get("image") {
            if !matches!(n.get("kind").and_then(serde_json::Value::as_str),Some("image"|"video")) || !canvas_agent_fields(image,&["mimeType","data"],&["mimeType","data"]) || !matches!(image.get("mimeType").and_then(serde_json::Value::as_str),Some("image/jpeg"|"image/png")) { return false; }
            let Some(data)=image.get("data").and_then(serde_json::Value::as_str) else { return false; };
            let Ok(bytes)=base64::engine::general_purpose::STANDARD.decode(data) else { return false; };
            if bytes.is_empty() || bytes.len()>128*1024 || base64::engine::general_purpose::STANDARD.encode(&bytes)!=data { return false; } image_bytes+=bytes.len(); image_count+=1;
        }
    }
    if text_bytes>256*1024 || image_bytes>1024*1024 || image_count>8 { return false; }
    if !c.get("connections").and_then(serde_json::Value::as_array).map(|edges|edges.len()<=2048 && edges.iter().all(|e|canvas_agent_fields(e,&["source","target"],&["source","target"])
        && e.get("source")!=e.get("target") && e.get("source").and_then(serde_json::Value::as_str).map(|v|ids.contains(v)).unwrap_or(false) && e.get("target").and_then(serde_json::Value::as_str).map(|v|ids.contains(v)).unwrap_or(false))).unwrap_or(false) { return false; }
    let Some(g)=c.get("generation") else {return false;};
    if !canvas_agent_fields(g,&["imageModels","videoModels","imageReady","videoReady","imageOptions","videoOptions"],&["imageModels","videoModels","imageReady","videoReady"])
        || !["imageReady","videoReady"].iter().all(|k|g.get(*k).map(serde_json::Value::is_boolean).unwrap_or(false))
        || !["imageModels","videoModels"].iter().all(|k|g.get(*k).and_then(serde_json::Value::as_array).map(|a|a.len()<=32 && a.iter().all(|v|canvas_agent_text(Some(v),160,false))).unwrap_or(false)) { return false; }
    ["imageOptions","videoOptions"].iter().all(|k|g.get(*k).map(|o|canvas_agent_fields(o,&["aspects","resolutions","qualities","durations"],&["aspects","resolutions","qualities","durations"])
        && ["aspects","resolutions","qualities"].iter().all(|k|o.get(*k).and_then(serde_json::Value::as_array).map(|a|a.len()<=32 && a.iter().all(|v|canvas_agent_text(Some(v),160,false))).unwrap_or(false))
        && o.get("durations").and_then(serde_json::Value::as_array).map(|a|a.len()<=32 && a.iter().all(|v|v.as_f64().map(|n|n.is_finite()&&n>0.0).unwrap_or(false))).unwrap_or(false)).unwrap_or(true))
}
fn canvas_agent_plan_valid(p: &serde_json::Value, canvas_id: &str, run_id: Option<&serde_json::Value>) -> bool {
    let keys=["version","id","canvasId","runId","title","summary","steps"];
    serde_json::to_vec(p).map(|bytes|bytes.len()<=256*1024).unwrap_or(false) && canvas_agent_fields(p,&keys,&keys) && p.get("version").and_then(serde_json::Value::as_u64)==Some(1) && canvas_agent_id(p.get("id"))
        && p.get("canvasId").and_then(serde_json::Value::as_str)==Some(canvas_id) && p.get("runId")==run_id && canvas_agent_id(p.get("runId"))
        && canvas_agent_text(p.get("title"),160,true) && canvas_agent_text(p.get("summary"),2000,true)
        && p.get("steps").and_then(serde_json::Value::as_array).map(|steps|!steps.is_empty() && steps.len()<=64 && steps.iter().all(|step|
            canvas_agent_fields(step,&["id","kind","title","content","references","targetNodeId","settings"],&["id","kind","title","content","references"])
            && canvas_agent_id(step.get("id")) && matches!(step.get("kind").and_then(serde_json::Value::as_str),Some("text"|"image"|"video"))
            && canvas_agent_text(step.get("title"),160,true) && canvas_agent_text(step.get("content"),16000,true)
            && step.get("references").and_then(serde_json::Value::as_array).map(|a|a.len()<=256 && a.iter().all(|v|canvas_agent_id(Some(v)))).unwrap_or(false)
            && step.get("targetNodeId").map(|v|canvas_agent_id(Some(v))).unwrap_or(true)
            && step.get("settings").map(|v|canvas_agent_fields(v,&["aspect","resolution","quality","duration"],&[]) && v.as_object().unwrap().iter().all(|(k,v)|if k=="duration" {v.is_number()} else {canvas_agent_text(Some(v),160,false)})).unwrap_or(true))).unwrap_or(false)
}
fn canvas_agent_execution_valid(e: &serde_json::Value) -> bool { canvas_agent_execution_state_valid(e,false) }
fn canvas_agent_execution_state_valid(e: &serde_json::Value, snapshot: bool) -> bool {
    canvas_agent_fields(e,if snapshot {&["mode","allowGeneration","maxMediaJobs","reservedMediaJobs"]} else {&["mode","allowGeneration","maxMediaJobs"]},&["mode","allowGeneration","maxMediaJobs"])
        && matches!(e.get("mode").and_then(serde_json::Value::as_str),Some("plan"|"autonomous")) && e.get("allowGeneration").map(serde_json::Value::is_boolean).unwrap_or(false)
        && canvas_agent_count(e.get("maxMediaJobs"),1000) && e.get("reservedMediaJobs").map(|v|canvas_agent_count(Some(v),e.get("maxMediaJobs").and_then(serde_json::Value::as_u64).unwrap_or(0))).unwrap_or(true) && (e.get("allowGeneration").and_then(serde_json::Value::as_bool)==Some(false)
            || e.get("mode").and_then(serde_json::Value::as_str)==Some("autonomous") && e.get("maxMediaJobs").and_then(serde_json::Value::as_u64).unwrap_or(0)>0)
}

// R11 fixed canvas creation schemas, mirrored by the TS and authenticated JS contracts.
const CANVAS_CREATION_SCHEMAS_JSON: &str = r###"{"read":{"type":"object","properties":{"scope":{"enum":["overview","referencePacks","templates","storyboards","shots","review","directions","delivery","scriptText"]},"objectId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"offset":{"type":"integer","minimum":0,"maximum":1000000},"expectedRevision":{"type":"string","maxLength":16,"minLength":16,"pattern":"^[a-f0-9]{16}$"}},"required":["scope"],"additionalProperties":false,"minProperties":0},"edit":{"type":"object","properties":{"expectedRevision":{"type":"string","maxLength":16,"minLength":16,"pattern":"^[a-f0-9]{16}$"},"operation":{"oneOf":[{"type":"object","properties":{"op":{"const":"referencePack.create"},"name":{"type":"string","maxLength":60,"minLength":1},"packKind":{"enum":["character","product","style"]},"nodeIds":{"type":"array","items":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"minItems":1,"maxItems":256,"uniqueItems":true}},"required":["op","name","packKind","nodeIds"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"referencePack.update"},"packId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"name":{"type":"string","maxLength":60,"minLength":1},"packKind":{"enum":["character","product","style"]},"nodeIds":{"type":"array","items":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"minItems":1,"maxItems":256,"uniqueItems":true}},"required":["op","packId"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"referencePack.unmark"},"packId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"}},"required":["op","packId"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"referencePack.apply"},"packId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"targetId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"}},"required":["op","packId","targetId"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"template.instantiate"},"templateId":{"enum":["builtin-0","builtin-1","builtin-2","builtin-3"]}},"required":["op","templateId"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"storyboard.create"},"name":{"type":"string","maxLength":60,"minLength":1},"nodeIds":{"type":"array","items":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"minItems":0,"maxItems":64,"uniqueItems":true}},"required":["op","name"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"storyboard.rename"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"name":{"type":"string","maxLength":60,"minLength":1}},"required":["op","boardId","name"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"storyboard.unmark"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"}},"required":["op","boardId"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"storyboard.importScript"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"sourceText":{"type":"string","maxLength":100000,"minLength":1}},"required":["op","boardId","sourceText"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"shot.add"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"kind":{"enum":["image","video"]},"fields":{"type":"object","properties":{"title":{"type":"string","maxLength":100,"minLength":0},"description":{"type":"string","maxLength":4000,"minLength":0},"action":{"type":"string","maxLength":2000,"minLength":0},"dialogue":{"type":"string","maxLength":2000,"minLength":0},"lighting":{"type":"string","maxLength":2000,"minLength":0},"sound":{"type":"string","maxLength":2000,"minLength":0},"cameraMovement":{"type":"string","maxLength":2000,"minLength":0},"durationSeconds":{"type":"number","minimum":0.1,"maximum":3600},"framing":{"enum":["wide","full","medium","close","detail"]}},"required":[],"additionalProperties":false,"minProperties":1}},"required":["op","boardId","kind","fields"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"shot.update"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"shotId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"fields":{"type":"object","properties":{"title":{"type":"string","maxLength":100,"minLength":0},"description":{"type":"string","maxLength":4000,"minLength":0},"action":{"type":"string","maxLength":2000,"minLength":0},"dialogue":{"type":"string","maxLength":2000,"minLength":0},"lighting":{"type":"string","maxLength":2000,"minLength":0},"sound":{"type":"string","maxLength":2000,"minLength":0},"cameraMovement":{"type":"string","maxLength":2000,"minLength":0},"durationSeconds":{"type":"number","minimum":0.1,"maximum":3600},"framing":{"enum":["wide","full","medium","close","detail"]}},"required":[],"additionalProperties":false,"minProperties":1},"prompt":{"type":"string","maxLength":16000,"minLength":0}},"required":["op","boardId","shotId","fields"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"shot.duplicate"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"shotId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"}},"required":["op","boardId","shotId"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"shot.detach"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"shotId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"}},"required":["op","boardId","shotId"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"shot.clearChoice"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"shotId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"}},"required":["op","boardId","shotId"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"shot.reorder"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"shotIds":{"type":"array","items":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"minItems":1,"maxItems":64,"uniqueItems":true}},"required":["op","boardId","shotIds"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"shot.adopt"},"boardId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"shotId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"candidateIndex":{"type":"integer","minimum":0,"maximum":99999}},"required":["op","boardId","shotId","candidateIndex"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"generator.recipe"},"nodeId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"recipe":{"oneOf":[{"type":"null"},{"type":"object","properties":{"version":{"const":1},"id":{"const":"story-grid"},"options":{"type":"object","properties":{"grid":{"enum":["2x2","3x3","5x5"]}},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"version":{"const":1},"id":{"const":"blocking-board"},"options":{"type":"object","properties":{"grid":{"enum":["2x2","3x3","5x5"]}},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"version":{"const":1},"id":{"const":"multi-angle"},"options":{"type":"object","properties":{},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"version":{"const":1},"id":{"const":"character-sheet"},"options":{"type":"object","properties":{},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"version":{"const":1},"id":{"const":"scene-sheet"},"options":{"type":"object","properties":{},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"version":{"const":1},"id":{"const":"product-sheet"},"options":{"type":"object","properties":{},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"version":{"const":1},"id":{"const":"time-shift"},"options":{"type":"object","properties":{"direction":{"enum":["before","after"]},"seconds":{"enum":[3,5]}},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"version":{"const":1},"id":{"const":"relight"},"options":{"type":"object","properties":{"lighting":{"enum":["soft-daylight","golden-hour","neon-night","studio"]}},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"version":{"const":1},"id":{"const":"cinematic-grade"},"options":{"type":"object","properties":{"tone":{"enum":["natural-film","warm-vintage","cool-suspense","black-white"]}},"required":[],"additionalProperties":false,"minProperties":0}},"required":["version","id","options"],"additionalProperties":false,"minProperties":0}]}},"required":["op","nodeId","recipe"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"generator.cinematography"},"nodeId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"settings":{"type":"object","properties":{"version":{"const":1},"enabled":{"type":"boolean"},"camera":{"enum":["auto","sony-venice","arri-alexa-35","arri-alexa-65","red-v-raptor","panavision-dxl2","arricam-lt","arriflex-435","imax"]},"lens":{"enum":["auto","zeiss-ultra-prime","cooke-sf-1.8x","canon-k35","cooke-s4","cooke-panchro","arri-signature","helios","panavision","hawk"]},"focalLength":{"enum":["auto","8","14","24","35","50","75","125"]},"aperture":{"enum":["auto","1.4","4","11"]},"framing":{"enum":["auto","extreme-wide","wide","full","medium","close-up","extreme-close-up"]},"angle":{"enum":["auto","eye-level","low","high","overhead","dutch"]},"movement":{"enum":["auto","static","pan","tilt","dolly-in","dolly-out","tracking","orbit","handheld"]}},"required":["version","enabled","camera","lens","focalLength","aperture","framing","angle","movement"],"additionalProperties":false,"minProperties":0}},"required":["op","nodeId","settings"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"reference.role"},"sourceId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"targetId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"role":{"enum":["generic","reference","promptContext","firstFrame","lastFrame","videoReference"]}},"required":["op","sourceId","targetId","role"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"reference.order"},"targetId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"sourceIds":{"type":"array","items":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"minItems":1,"maxItems":256,"uniqueItems":true}},"required":["op","targetId","sourceIds"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"review.prefer"},"historyId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"mediaIndex":{"type":"integer","minimum":0,"maximum":99999},"preferred":{"type":"boolean"}},"required":["op","historyId","mediaIndex","preferred"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"review.restore"},"historyId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"mediaIndex":{"type":"integer","minimum":0,"maximum":99999}},"required":["op","historyId","mediaIndex"],"additionalProperties":false,"minProperties":0},{"type":"object","properties":{"op":{"const":"review.continue"},"historyId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"mediaIndex":{"type":"integer","minimum":0,"maximum":99999}},"required":["op","historyId","mediaIndex"],"additionalProperties":false,"minProperties":0}]}},"required":["expectedRevision","operation"],"additionalProperties":false,"minProperties":0},"open":{"type":"object","properties":{"expectedRevision":{"type":"string","maxLength":16,"minLength":16,"pattern":"^[a-f0-9]{16}$"},"panel":{"enum":["imageTools","delivery","templateImport","templateExport","storyboardExport"]},"nodeIds":{"type":"array","items":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"minItems":0,"maxItems":256,"uniqueItems":true},"objectId":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"imageIndex":{"type":"integer","minimum":0,"maximum":63},"imageEdit":{"type":"object","properties":{"turns":{"type":"integer","minimum":0,"maximum":3},"flipX":{"type":"boolean"},"flipY":{"type":"boolean"},"crop":{"type":"object","properties":{"x":{"type":"number","minimum":0,"maximum":1},"y":{"type":"number","minimum":0,"maximum":1},"width":{"type":"number","minimum":1e-06,"maximum":1},"height":{"type":"number","minimum":1e-06,"maximum":1}},"required":["x","y","width","height"],"additionalProperties":false,"minProperties":0},"width":{"type":"integer","minimum":1,"maximum":8192},"height":{"type":"integer","minimum":1,"maximum":8192}},"required":["turns","flipX","flipY","crop","width","height"],"additionalProperties":false,"minProperties":0}},"required":["expectedRevision","panel"],"additionalProperties":false,"minProperties":0},"result":{"type":"object","properties":{"version":{"const":1},"revision":{"type":"string","maxLength":16,"minLength":16,"pattern":"^[a-f0-9]{16}$"},"scope":{"enum":["overview","referencePacks","templates","storyboards","shots","review","directions","delivery","scriptText"]},"offset":{"type":"integer","minimum":0,"maximum":1000000},"total":{"type":"integer","minimum":0,"maximum":1000000},"nextOffset":{"type":"integer","minimum":0,"maximum":1000000},"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string","maxLength":160,"minLength":1},"kind":{"type":"string","maxLength":80,"minLength":1},"title":{"type":"string","maxLength":240,"minLength":0},"description":{"type":"string","maxLength":16000,"minLength":0},"memberIds":{"type":"array","items":{"type":"string","maxLength":160,"minLength":0,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"},"minItems":0,"maxItems":256,"uniqueItems":true},"fields":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string","maxLength":80,"minLength":1},"value":{"type":"string","maxLength":4000,"minLength":0}},"required":["name","value"],"additionalProperties":false,"minProperties":0},"minItems":0,"maxItems":64,"uniqueItems":true}},"required":["id","kind","title","description"],"additionalProperties":false,"minProperties":0},"minItems":0,"maxItems":32,"uniqueItems":true},"completion":{"enum":["read","applied","awaiting-user","applied-unconfirmed"]},"notice":{"type":"string","maxLength":4000,"minLength":0}},"required":["version","revision","scope","offset","total","items","completion"],"additionalProperties":false,"minProperties":0}}"###;
fn canvas_creation_schema_match(value: &serde_json::Value, schema: &serde_json::Value) -> bool {
    if let Some(options)=schema.get("oneOf").and_then(serde_json::Value::as_array) { return options.iter().filter(|s|canvas_creation_schema_match(value,s)).count()==1; }
    if schema.get("const").map(|expected|expected!=value).unwrap_or(false) {return false;}
    if schema.get("enum").and_then(serde_json::Value::as_array).map(|values|!values.contains(value)).unwrap_or(false) {return false;}
    let Some(kind)=schema.get("type").and_then(serde_json::Value::as_str) else{return true;};
    let number=|key:&str|schema.get(key).and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    match kind {
        "null"=>value.is_null(),
        "boolean"=>value.is_boolean(),
        "string"=>value.as_str().map(|v| {
            let len=v.encode_utf16().count();
            len>=number("minLength") as usize && len<=number("maxLength") as usize
            && !v.chars().any(|c| matches!(c as u32,0..=8|11|12|14..=31|127))
            && schema.get("pattern").and_then(serde_json::Value::as_str).map(|p|match p {
                "^[a-f0-9]{16}$"=>canvas_agent_revision(Some(value)),
                "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$"=>canvas_agent_id(Some(value)),
                _=>false,
            }).unwrap_or(true)
        }).unwrap_or(false),
        "number"|"integer"=>value.as_f64().map(|v|v.is_finite() && v>=number("minimum") && v<=number("maximum") && (kind!="integer"||(v.fract()==0.0 && v.abs()<=9007199254740991.0))).unwrap_or(false),
        "array"=>value.as_array().map(|values| {
            let unique=values.iter().map(|v|v.to_string()).collect::<std::collections::HashSet<_>>();
            values.len()>=number("minItems") as usize && values.len()<=number("maxItems") as usize
                && (schema.get("uniqueItems").and_then(serde_json::Value::as_bool)!=Some(true)||unique.len()==values.len())
                && schema.get("items").map(|item|values.iter().all(|v|canvas_creation_schema_match(v,item))).unwrap_or(false)
        }).unwrap_or(false),
        "object"=>value.as_object().map(|obj| {
            obj.len()>=number("minProperties") as usize
                && schema.get("required").and_then(serde_json::Value::as_array).map(|req|req.iter().all(|k|k.as_str().map(|k|obj.contains_key(k)).unwrap_or(false))).unwrap_or(false)
                && obj.iter().all(|(k,v)|schema.get("properties").and_then(|p|p.get(k)).map(|s|canvas_creation_schema_match(v,s)).unwrap_or(false))
        }).unwrap_or(false),
        _=>false,
    }
}
fn canvas_creation_valid(value: &serde_json::Value, kind:&str) -> bool {
    static SCHEMAS:std::sync::OnceLock<serde_json::Value>=std::sync::OnceLock::new();
    let schemas=SCHEMAS.get_or_init(||serde_json::from_str(CANVAS_CREATION_SCHEMAS_JSON).expect("fixed canvas creation schema"));
    if !schemas.get(kind).map(|s|canvas_creation_schema_match(value,s)).unwrap_or(false)
        || !serde_json::to_vec(value).map(|v|v.len()<=if kind=="result" {128*1024}else{256*1024}).unwrap_or(false) {return false;}
    if kind=="read" && value.get("scope").and_then(serde_json::Value::as_str)==Some("scriptText") && value.get("objectId").is_none() {return false;}
    if kind=="read" && value.get("offset").and_then(serde_json::Value::as_u64).unwrap_or(0)>0 && value.get("expectedRevision").is_none() {return false;}
    if kind=="edit" && value.get("operation").and_then(|o|o.get("op")).and_then(serde_json::Value::as_str)==Some("referencePack.update")
        && value.get("operation").and_then(serde_json::Value::as_object).map(|o|o.len()<3).unwrap_or(true) {return false;}
    if kind=="open" && value.get("imageIndex").is_some() && value.get("panel").and_then(serde_json::Value::as_str)!=Some("imageTools") {return false;}
    if kind=="open" {if let Some(edit)=value.get("imageEdit") {
        let n=|o:&serde_json::Value,k:&str|o.get(k).and_then(serde_json::Value::as_f64).unwrap_or(f64::INFINITY);
        let crop=&edit["crop"];
        if value.get("panel").and_then(serde_json::Value::as_str)!=Some("imageTools") || n(edit,"width")*n(edit,"height")>32000000.0 || n(crop,"x")+n(crop,"width")>1.000001 || n(crop,"y")+n(crop,"height")>1.000001 {return false;}
    }}
    if kind=="result" {
        let offset=value["offset"].as_u64().unwrap_or(0);let total=value["total"].as_u64().unwrap_or(0);
        if offset>total || value.get("nextOffset").and_then(serde_json::Value::as_u64).map(|next|next<=offset||next>=total).unwrap_or(false){return false;}
    }
    true
}
fn canvas_creation_action_valid(a:&serde_json::Value)->bool {
    let (kind,field)=match a.get("kind").and_then(serde_json::Value::as_str) {
        Some("readCreation")=>("read","creationQuery"),Some("editCreation")=>("edit","creationEdit"),Some("openCreation")=>("open","creationOpen"),
        _=>return ["creationQuery","creationEdit","creationOpen"].iter().all(|k|a.get(*k).is_none()),
    };
    ["plan","generate","operations","nodeIds","offset","expectedRevision"].iter().all(|k|a.get(*k).is_none()) && a.get("context").is_some()
        && (kind=="read" || a.get("execution").and_then(|e|e.get("mode")).and_then(serde_json::Value::as_str)==Some("autonomous"))
        && ["creationQuery","creationEdit","creationOpen"].iter().all(|k|if *k==field {a.get(*k).map(|v|canvas_creation_valid(v,kind)).unwrap_or(false)}else{a.get(*k).is_none()})
}
fn canvas_agent_action_result_valid(r: &serde_json::Value, canvas_id: &str) -> bool {
    canvas_agent_fields(r,&["status","summary","context","generatedJobs","nodes","creation"],&["status","summary","generatedJobs"])
        && matches!(r.get("status").and_then(serde_json::Value::as_str),Some("completed"|"failed"|"cancelled")) && canvas_agent_text(r.get("summary"),8000,true) && canvas_agent_count(r.get("generatedJobs"),1000)
        && r.get("creation").map(|v|canvas_creation_valid(v,"result") && r.get("status").and_then(serde_json::Value::as_str)==Some(if v.get("completion").and_then(serde_json::Value::as_str)==Some("applied-unconfirmed") {"failed"}else{"completed"})).unwrap_or(true)
        && r.get("context").map(|v|canvas_agent_context_valid(v,canvas_id,true)).unwrap_or(true)
        && r.get("nodes").map(|v|v.as_array().map(|a|a.len()<=256 && a.iter().all(|n|canvas_agent_fields(n,&["id","status","summary"],&["id","status"]) && canvas_agent_id(n.get("id"))
            && matches!(n.get("status").and_then(serde_json::Value::as_str),Some("completed"|"failed"|"cancelled")) && n.get("summary").map(|v|canvas_agent_text(Some(v),4000,true)).unwrap_or(true))).unwrap_or(false)).unwrap_or(true)
}

/// Single-purpose authenticated canvas command; never an arbitrary runtime proxy.
fn encode_canvas_agent_request(request: &serde_json::Value) -> Result<String, String> {
    let invalid=||"canvas-agent-invalid-request".to_owned();
    let object=request.as_object().ok_or_else(invalid)?;
    if !canvas_agent_id(object.get("canvasId")) {return Err(invalid());}
    let canvas_id=object.get("canvasId").and_then(serde_json::Value::as_str).ok_or_else(invalid)?;
    let valid=match object.get("op").and_then(serde_json::Value::as_str) {
        Some("status"|"models"|"history")=>canvas_agent_fields(request,&["op","canvasId"],&["op","canvasId"]),
        Some("cancel")=>canvas_agent_fields(request,&["op","canvasId","runId"],&["op","canvasId","runId"]) && canvas_agent_id(object.get("runId")),
        Some("newConversation")=>canvas_agent_fields(request,&["op","canvasId","requestId","expectedConversationId"],&["op","canvasId","requestId","expectedConversationId"]) && canvas_agent_id(object.get("requestId")) && canvas_agent_id(object.get("expectedConversationId")),
        Some("resumeConversation")=>canvas_agent_fields(request,&["op","canvasId","requestId","expectedConversationId","conversationId"],&["op","canvasId","requestId","expectedConversationId","conversationId"]) && ["requestId","expectedConversationId","conversationId"].iter().all(|k|canvas_agent_id(object.get(*k))),
        Some("actionResult")=>canvas_agent_fields(request,&["op","canvasId","runId","actionId","result"],&["op","canvasId","runId","actionId","result"]) && canvas_agent_id(object.get("runId")) && canvas_agent_id(object.get("actionId")) && object.get("result").map(|v|canvas_agent_action_result_valid(v,canvas_id)).unwrap_or(false),
        Some("start")=>canvas_agent_fields(request,&["op","canvasId","conversationId","requestId","prompt","context","modelSelection","execution"],&["op","canvasId","conversationId","requestId","prompt","context"])
            && canvas_agent_id(object.get("requestId")) && canvas_agent_id(object.get("conversationId")) && canvas_agent_text(object.get("prompt"),48000,false)
            && object.get("context").map(|v|canvas_agent_context_valid(v,canvas_id,true)).unwrap_or(false)
            && object.get("execution").map(canvas_agent_execution_valid).unwrap_or(true)
            && object.get("modelSelection").map(|v|canvas_agent_fields(v,&["provider","model","reasoningEffort"],&["provider","model"]) && v.as_object().unwrap().values().all(|v|canvas_agent_text(Some(v),160,false))).unwrap_or(true),
        _=>false,
    };
    if !valid {return Err(invalid());}
    let bytes=serde_json::to_vec(request).map_err(|_|invalid())?;
    if bytes.len()>MAX_CANVAS_AGENT_JSON_BYTES {return Err(invalid());}
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn canvas_agent_reasoning_valid(value: &serde_json::Value) -> bool {
    let text = |v: Option<&serde_json::Value>, max: usize| v.and_then(serde_json::Value::as_str)
        .map(|s| !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)).unwrap_or(false);
    value.as_object().map(|r| r.keys().all(|k| ["efforts", "defaultEffort"].contains(&k.as_str()))
        && r.get("efforts").and_then(serde_json::Value::as_array).map(|efforts| !efforts.is_empty() && efforts.len() <= 32
            && efforts.iter().all(|e| e.as_object().map(|e| e.keys().all(|k| ["id", "name", "description"].contains(&k.as_str()))
                && text(e.get("id"),160) && text(e.get("name"),160) && e.get("description").map(|v| text(Some(v),640)).unwrap_or(true)).unwrap_or(false))
            && efforts.iter().filter_map(|e| e.get("id").and_then(serde_json::Value::as_str)).collect::<std::collections::HashSet<_>>().len() == efforts.len()
            && r.get("defaultEffort").map(|d| efforts.iter().any(|e| e.get("id") == Some(d))).unwrap_or(true)
        ).unwrap_or(false)).unwrap_or(false)
}

fn canvas_agent_models_valid(value: &serde_json::Value) -> bool {
    let text = |value: Option<&serde_json::Value>, max: usize| value.and_then(serde_json::Value::as_str)
        .map(|text| !text.trim().is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)).unwrap_or(false);
    let selection = |value: &serde_json::Value| value.as_object().map(|item|
        item.keys().all(|key| ["provider", "model", "reasoningEffort"].contains(&key.as_str()))
        && text(item.get("provider"), 160) && text(item.get("model"), 160)
        && item.get("reasoningEffort").map(|v| text(Some(v), 160)).unwrap_or(true)).unwrap_or(false);
    value.as_object().map(|models| models.len() == 3
        && models.keys().all(|key| ["available", "defaultModel", "currentModel"].contains(&key.as_str()))
        && ["defaultModel", "currentModel"].iter().all(|key| models.get(*key).map(|v| v.is_null() || selection(v)).unwrap_or(false))
        && models.get("available").and_then(serde_json::Value::as_array).map(|items| items.len() <= 256 && items.iter().all(|item|
            item.as_object().map(|item| (item.len() == 4 || item.len() == 5)
                && item.keys().all(|key| ["provider", "model", "label", "inputModalities", "reasoning"].contains(&key.as_str()))
                && item.get("reasoning").map(canvas_agent_reasoning_valid).unwrap_or(true)
                && text(item.get("provider"), 160) && text(item.get("model"), 160) && text(item.get("label"), 323)
                && item.get("inputModalities").and_then(serde_json::Value::as_array).map(|items| items.len() <= 2
                    && items.iter().all(|v| matches!(v.as_str(), Some("text" | "image")))).unwrap_or(false)
            ).unwrap_or(false)
        )).unwrap_or(false)
    ).unwrap_or(false)
}

fn canvas_agent_activity_valid(value: &serde_json::Value) -> bool {
    let time = |value: Option<&serde_json::Value>| value.and_then(serde_json::Value::as_u64).filter(|n| *n <= 9_007_199_254_740_991);
    value.as_array().map(|items| items.len() <= 24 && items.iter().all(|entry| entry.as_object().map(|entry| {
        entry.keys().all(|key| ["id", "kind", "label", "status", "startedAt", "endedAt"].contains(&key.as_str()))
        && canvas_agent_id(entry.get("id"))
        && matches!(entry.get("kind").and_then(serde_json::Value::as_str), Some("phase" | "tool"))
        && matches!(entry.get("label").and_then(serde_json::Value::as_str), Some("preparing" | "resolving-model" | "opening-session" | "waiting-model" | "reading-context" | "proposing-plan" | "finalizing" | "stopping"))
        && matches!(entry.get("status").and_then(serde_json::Value::as_str), Some("running" | "completed" | "failed"))
        && time(entry.get("startedAt")).is_some()
        && entry.get("endedAt").map(|end| time(Some(end)).zip(time(entry.get("startedAt"))).map(|(end, start)| end >= start).unwrap_or(false)).unwrap_or(true)
    }).unwrap_or(false))).unwrap_or(false)
}

fn canvas_agent_graph_operations_valid(operations: &serde_json::Value) -> bool {
    operations.as_array().map(|ops|!ops.is_empty() && ops.len()<=64 && ops.iter().all(|o|match o.get("op").and_then(serde_json::Value::as_str) {
        Some("move")=>canvas_agent_fields(o,&["op","nodeId","x","y"],&["op","nodeId","x","y"]) && canvas_agent_id(o.get("nodeId")) && ["x","y"].iter().all(|k|o.get(*k).and_then(serde_json::Value::as_f64).map(|n|n.is_finite()&&n.abs()<=1_000_000.0).unwrap_or(false)),
        Some("connect"|"disconnect")=>canvas_agent_fields(o,&["op","source","target"],&["op","source","target"]) && canvas_agent_id(o.get("source")) && canvas_agent_id(o.get("target")) && o.get("source")!=o.get("target"),
        Some("arrange")=>canvas_agent_fields(o,&["op","nodeIds","layout"],&["op","nodeIds","layout"]) && matches!(o.get("layout").and_then(serde_json::Value::as_str),Some("grid"|"horizontal"|"vertical")) && o.get("nodeIds").and_then(serde_json::Value::as_array).map(|ids|!ids.is_empty() && ids.len()<=256 && ids.iter().all(|id|canvas_agent_id(Some(id))) && ids.iter().filter_map(serde_json::Value::as_str).collect::<std::collections::HashSet<_>>().len()==ids.len()).unwrap_or(false),
        _=>false,
    })).unwrap_or(false)
}
fn canvas_agent_reasoning_timing_valid(v: &serde_json::Value, active: bool) -> bool {
    let fields = if active { &["reasoningStartedAt","reasoningEndedAt","reasoningDurationMs","reasoningActiveStartedAt"][..] } else { &["reasoningStartedAt","reasoningEndedAt","reasoningDurationMs"][..] };
    fields.iter().all(|k|v.get(*k).map(|x|canvas_agent_count(Some(x),9_007_199_254_740_991)).unwrap_or(true))
        && (!fields.iter().skip(1).any(|k|v.get(*k).is_some()) || v.get("reasoningStartedAt").is_some())
        && ["reasoningEndedAt","reasoningActiveStartedAt"].iter().all(|k|v.get(*k).map(|x|x.as_u64()>=v.get("reasoningStartedAt").and_then(serde_json::Value::as_u64)).unwrap_or(true))
}
fn canvas_agent_error_detail_valid(snapshot: &serde_json::Value) -> bool {
    let Some(detail) = snapshot.get("errorDetail") else { return true; };
    if snapshot.get("status").and_then(serde_json::Value::as_str) != Some("failed")
        || snapshot.get("error").and_then(serde_json::Value::as_str).is_none()
        || !canvas_agent_fields(detail, &["message"], &["message"]) { return false; }
    detail.get("message").and_then(serde_json::Value::as_str).map(|message| {
        !message.trim().is_empty() && message.len() <= 2000
            && !message.chars().any(|c| (c.is_control() && c != '\n' && c != '\t')
                || matches!(c, '\u{061c}' | '\u{200e}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    }).unwrap_or(false)
}
fn canvas_agent_extensions_valid(v: &serde_json::Value, canvas_id: &str) -> bool {
    if !canvas_agent_error_detail_valid(v) { return false; }
    let time=|v:Option<&serde_json::Value>|canvas_agent_count(v,9_007_199_254_740_991);
    if v.get("error").map(|v|!v.as_str().map(|s|s.starts_with("canvas-agent-") && s.bytes().all(|b|b.is_ascii_lowercase()||b==b'-')).unwrap_or(false)).unwrap_or(false) || v.get("model").map(|v|!canvas_agent_text(Some(v),160,false)).unwrap_or(false) {return false;}
    if v.get("updatedAt").map(|v|!time(Some(v))).unwrap_or(false) || v.get("execution").map(|e|!canvas_agent_execution_state_valid(e,true)).unwrap_or(false) {return false;}
    if v.get("context").map(|c|!canvas_agent_context_valid(c,canvas_id,false)).unwrap_or(false)
        || v.get("plan").map(|p|!canvas_agent_plan_valid(p,canvas_id,v.get("runId"))).unwrap_or(false) {return false;}
    if let Some(s)=v.get("stream") {
        if !canvas_agent_fields(s,&["attemptId","text","status","reasoning","reasoningText","turnId","startedAt","reasoningStartedAt","reasoningEndedAt","reasoningDurationMs","reasoningActiveStartedAt"],&["attemptId","text","status","reasoning"])
            || !canvas_agent_reasoning_timing_valid(s,true)
            || s.get("turnId").map(|id|!canvas_agent_id(Some(id)) || Some(id)!=v.get("runId")).unwrap_or(false)
            || s.get("startedAt").map(|v|!time(Some(v))).unwrap_or(false)
            || !canvas_agent_id(s.get("attemptId")) || !canvas_agent_text(s.get("text"),256000,true)
            || !matches!(s.get("status").and_then(serde_json::Value::as_str),Some("streaming"|"settled"|"interrupted"))
            || !s.get("reasoning").map(serde_json::Value::is_boolean).unwrap_or(false)
            || s.get("reasoningText").map(|v|!canvas_agent_text(Some(v),256000,true)).unwrap_or(false) {return false;}
    }
    if let Some(p)=v.get("progress") {
        if !p.as_array().map(|a|a.len()<=64 && a.iter().all(|p|canvas_agent_fields(p,&["id","summary","createdAt"],&["id","summary","createdAt"])
            && canvas_agent_id(p.get("id")) && canvas_agent_text(p.get("summary"),4000,true) && time(p.get("createdAt")))).unwrap_or(false) {return false;}
    }
    if let Some(t)=v.get("tools") {
        if !t.as_array().map(|a|a.len()<=128 && a.iter().all(|t|canvas_agent_fields(t,&["callId","name","status","startedAt","endedAt","summary","turnId","eventSeq","displayTitle","displayTitleEn"],&["callId","name","status","startedAt"])
            && ["displayTitle","displayTitleEn"].iter().all(|k|t.get(*k).map(|x|canvas_agent_text(Some(x),240,true)).unwrap_or(true))
            && t.get("eventSeq").map(|v|time(Some(v))).unwrap_or(true) && t.get("turnId").map(|v|canvas_agent_id(Some(v))).unwrap_or(true) && canvas_agent_id(t.get("callId")) && canvas_agent_text(t.get("name"),160,false)
            && matches!(t.get("status").and_then(serde_json::Value::as_str),Some("running"|"completed"|"failed")) && time(t.get("startedAt"))
            && t.get("endedAt").map(|end|time(Some(end)) && end.as_u64()>=t.get("startedAt").and_then(serde_json::Value::as_u64)).unwrap_or(true)
            && t.get("summary").map(|v|canvas_agent_text(Some(v),4000,true)).unwrap_or(true))).unwrap_or(false) {return false;}
    }
    if let Some(c)=v.get("conversations") {
        if !c.as_array().map(|a|a.len()<=256 && a.iter().all(|c|canvas_agent_fields(c,&["conversationId","sessionId","title","updatedAt","messageCount"],&["conversationId","sessionId","title","updatedAt","messageCount"])
            && canvas_agent_id(c.get("conversationId")) && c.get("sessionId").map(|s|s.is_null()||canvas_agent_id(Some(s))).unwrap_or(false)
            && canvas_agent_text(c.get("title"),200,true) && time(c.get("updatedAt")) && time(c.get("messageCount")))).unwrap_or(false) {return false;}
    }
    if let Some(a)=v.get("pendingAction") {
        if v.get("status").and_then(serde_json::Value::as_str)!=Some("running") || !canvas_agent_fields(a,&["actionId","runId","kind","nodeIds","offset","plan","operations","context","generate","execution","expectedRevision","creationQuery","creationEdit","creationOpen"],&["actionId","runId","kind"])
            || a.get("expectedRevision").map(|v|!canvas_agent_revision(Some(v))).unwrap_or(false)
            || !canvas_agent_id(a.get("actionId")) || !canvas_agent_id(a.get("runId")) || a.get("runId")!=v.get("runId")
            || !matches!(a.get("kind").and_then(serde_json::Value::as_str),Some("readContext"|"applyPlan"|"editGraph"|"readCreation"|"editCreation"|"openCreation")) || !canvas_creation_action_valid(a)
            || a.get("nodeIds").map(|v|!v.as_array().map(|a|a.len()<=256 && a.iter().all(|id|canvas_agent_id(Some(id)))).unwrap_or(false)).unwrap_or(false)
            || a.get("offset").map(|v|!canvas_agent_count(Some(v),1000000)).unwrap_or(false)
            || a.get("context").map(|v|!canvas_agent_context_valid(v,canvas_id,false)).unwrap_or(false)
            || a.get("generate").map(|v|!v.is_boolean()).unwrap_or(false)
            || a.get("execution").map(|v|!canvas_agent_execution_state_valid(v,true)).unwrap_or(false) {return false;}
        if a.get("kind").and_then(serde_json::Value::as_str)==Some("applyPlan") {
            if a.get("operations").is_some() || !a.get("plan").map(|p|canvas_agent_plan_valid(p,canvas_id,a.get("runId"))).unwrap_or(false) || a.get("context").is_none() || a.get("execution").and_then(|e|e.get("mode")).and_then(serde_json::Value::as_str)!=Some("autonomous")
                || (a.get("generate").and_then(serde_json::Value::as_bool)==Some(true) && a.get("execution").and_then(|e|e.get("allowGeneration")).and_then(serde_json::Value::as_bool)!=Some(true)) {return false;}
        } else if a.get("kind").and_then(serde_json::Value::as_str)==Some("editGraph") {
            if !a.get("operations").map(canvas_agent_graph_operations_valid).unwrap_or(false) || a.get("plan").is_some() || a.get("context").is_none() || a.get("generate").and_then(serde_json::Value::as_bool)==Some(true) || a.get("execution").and_then(|e|e.get("mode")).and_then(serde_json::Value::as_str)!=Some("autonomous") {return false;}
        } else if a.get("plan").is_some() || a.get("operations").is_some() || a.get("generate").and_then(serde_json::Value::as_bool)==Some(true) {return false;}
    }
    true
}

fn decode_canvas_agent_snapshot(encoded: &str, canvas_id: &str) -> Result<serde_json::Value, String> {
    let invalid = || "canvas-agent-invalid-response".to_owned();
    if encoded.is_empty() || encoded.len() > MAX_CANVAS_AGENT_ENCODED_BYTES { return Err(invalid()); }
    let bytes = URL_SAFE_NO_PAD.decode(encoded.as_bytes()).map_err(|_| invalid())?;
    if bytes.len() > MAX_CANVAS_AGENT_JSON_BYTES || URL_SAFE_NO_PAD.encode(&bytes) != encoded { return Err(invalid()); }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let object = value.as_object().ok_or_else(invalid)?;
    let allowed = ["canvasId", "conversationId", "activity", "sessionId", "runId", "requestId", "status", "messages", "context", "plan", "error", "errorDetail", "model", "models", "pendingAction", "conversations", "stream", "progress", "tools", "updatedAt", "execution"];
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || !canvas_agent_id(object.get("conversationId"))
        || object.get("activity").map(|activity| !canvas_agent_activity_valid(activity)).unwrap_or(false)
        || object.get("requestId").map(|id| !canvas_agent_id(Some(id))).unwrap_or(false)
        || value.get("canvasId").and_then(serde_json::Value::as_str) != Some(canvas_id)
        || !matches!(value.get("status").and_then(serde_json::Value::as_str), Some("idle" | "running" | "completed" | "failed" | "cancelled"))
        || !object.get("sessionId").map(|id| id.is_null() || canvas_agent_id(Some(id))).unwrap_or(false)
        || !object.get("runId").map(|id| id.is_null() || canvas_agent_id(Some(id))).unwrap_or(false)
    { return Err(invalid()); }
    if object.get("models").map(|models| !canvas_agent_models_valid(models)).unwrap_or(false) { return Err(invalid()); }
    let messages = value.get("messages").and_then(serde_json::Value::as_array).ok_or_else(invalid)?;
    if messages.len() > 128 || messages.iter().any(|message| {
        message.as_object().map(|message| !message.keys().all(|k| ["role","text","reasoningText","turnId","messageId","attemptId","createdAt","eventSeq","reasoningStartedAt","reasoningEndedAt","reasoningDurationMs"].contains(&k.as_str()))
            || !canvas_agent_reasoning_timing_valid(&serde_json::Value::Object(message.clone()),false)
            || !matches!(message.get("role").and_then(serde_json::Value::as_str), Some("user" | "assistant"))
            || ["turnId","messageId","attemptId"].iter().any(|key|message.get(*key).map(|v|!canvas_agent_id(Some(v))).unwrap_or(false))
            || message.get("eventSeq").map(|v|!canvas_agent_count(Some(v),9_007_199_254_740_991)).unwrap_or(false)
            || message.get("createdAt").map(|v|!canvas_agent_count(Some(v),9_007_199_254_740_991)).unwrap_or(false)
            || !canvas_agent_text(message.get("text"),256000,true)
            || message.get("reasoningText").map(|v|!canvas_agent_text(Some(v),256000,true)).unwrap_or(false)).unwrap_or(true)
    }) { return Err(invalid()); }
    if !canvas_agent_extensions_valid(&value,canvas_id) {return Err(invalid());}

    Ok(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ChildFrame {
    #[serde(rename = "type")]
    kind: String,
    protocol: u64,
    generation: u64,
    seq: u64,
    request_id: Option<String>,
    carrier_generation: Option<u64>,
    stage: Option<String>,
    outcome: Option<String>,
    duration_ms: Option<u64>,
    reason: Option<String>,
    port: Option<u16>,
    bootstrap_path: Option<String>,
    bootstrap_ref: Option<String>,
    payload: Option<String>,
    rss_bytes: Option<u64>,
    owned_process_count: Option<u8>,
    mac: String,
}

#[derive(Default)]
struct ExpiredCanvasRequests {
    ids: VecDeque<String>,
}

impl ExpiredCanvasRequests {
    fn has_capacity(&self) -> bool { self.ids.len() < MAX_EXPIRED_CANVAS_REQUESTS }

    fn record(&mut self, request_id: String) -> Result<(), ()> {
        if self.ids.contains(&request_id) { return Ok(()); }
        // Never evict an old ID: its delayed authenticated ACK might still
        // arrive. Stop admitting new canvas requests when this ledger is full.
        if !self.has_capacity() { return Err(()); }
        self.ids.push_back(request_id);
        Ok(())
    }

    fn consume(&mut self, frame: &ChildFrame) -> bool {
        if frame.kind != "canvas-agent-result" { return false; }
        let Some(request_id) = frame.request_id.as_ref() else { return false; };
        let Some(index) = self.ids.iter().position(|expired| expired == request_id) else { return false; };
        self.ids.remove(index);
        true
    }
}

#[derive(Debug, PartialEq, Eq)]
enum HostFrameReadError { TimedOut, Unavailable }

fn read_authenticated_host_frame(
    frames: &mpsc::Receiver<Result<ChildFrame, ()>>,
    expired_canvas: &mut ExpiredCanvasRequests,
    timeout: Duration,
) -> Result<ChildFrame, HostFrameReadError> {
    let deadline = Instant::now().checked_add(timeout).ok_or(HostFrameReadError::Unavailable)?;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err(HostFrameReadError::TimedOut); }
        let frame = frames.recv_timeout(remaining).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => HostFrameReadError::TimedOut,
            mpsc::RecvTimeoutError::Disconnected => HostFrameReadError::Unavailable,
        })?.map_err(|_| HostFrameReadError::Unavailable)?;
        // This receiver is fed only after frame_reader verifies the exact
        // generation, sequence and MAC. Skip only a known expired canvas ACK,
        // once, without extending this operation's original read deadline.
        if expired_canvas.consume(&frame) { continue; }
        return Ok(frame);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceRequestEnvelope {
    #[serde(rename = "type")]
    kind: String,
    payload: serde_json::Value,
}

fn canonical_mac(
    challenge: &[u8; 32],
    direction: &str,
    protocol: u64,
    generation: u64,
    seq: u64,
    kind: &str,
    request_id: Option<&str>,
    stage: Option<&str>,
    outcome: Option<&str>,
    duration_ms: Option<u64>,
    reason: Option<&str>,
    port: Option<u16>,
    bootstrap_path: Option<&str>,
    bootstrap_ref: Option<&str>,
    payload: Option<&str>,
    rss_bytes: Option<u64>,
    owned_process_count: Option<u8>,
    carrier_generation: Option<u64>,
) -> String {
    let fields = [
        protocol.to_string(),
        generation.to_string(),
        direction.to_owned(),
        seq.to_string(),
        kind.to_owned(),
        request_id.unwrap_or_default().to_owned(),
        carrier_generation
            .map(|value| value.to_string())
            .unwrap_or_default(),
        stage.unwrap_or_default().to_owned(),
        outcome.unwrap_or_default().to_owned(),
        duration_ms
            .map(|value| value.to_string())
            .unwrap_or_default(),
        reason.unwrap_or_default().to_owned(),
        port.map(|value| value.to_string()).unwrap_or_default(),
        bootstrap_path.unwrap_or_default().to_owned(),
        bootstrap_ref.unwrap_or_default().to_owned(),
        payload.unwrap_or_default().to_owned(),
        rss_bytes.map(|value| value.to_string()).unwrap_or_default(),
        owned_process_count
            .map(|value| value.to_string())
            .unwrap_or_default(),
    ];
    let mut mac = HmacSha256::new_from_slice(challenge).expect("fixed HMAC key length");
    mac.update(fields.join("\0").as_bytes());
    encode_hex(&mac.finalize().into_bytes())
}

fn verify_canonical_mac(
    challenge: &[u8; 32],
    direction: &str,
    protocol: u64,
    generation: u64,
    seq: u64,
    kind: &str,
    request_id: Option<&str>,
    stage: Option<&str>,
    outcome: Option<&str>,
    duration_ms: Option<u64>,
    reason: Option<&str>,
    port: Option<u16>,
    bootstrap_path: Option<&str>,
    bootstrap_ref: Option<&str>,
    payload: Option<&str>,
    rss_bytes: Option<u64>,
    owned_process_count: Option<u8>,
    carrier_generation: Option<u64>,
    received: &str,
) -> bool {
    let Some(received) = decode_hex_32(received) else {
        return false;
    };
    let fields = [
        protocol.to_string(),
        generation.to_string(),
        direction.to_owned(),
        seq.to_string(),
        kind.to_owned(),
        request_id.unwrap_or_default().to_owned(),
        carrier_generation
            .map(|value| value.to_string())
            .unwrap_or_default(),
        stage.unwrap_or_default().to_owned(),
        outcome.unwrap_or_default().to_owned(),
        duration_ms
            .map(|value| value.to_string())
            .unwrap_or_default(),
        reason.unwrap_or_default().to_owned(),
        port.map(|value| value.to_string()).unwrap_or_default(),
        bootstrap_path.unwrap_or_default().to_owned(),
        bootstrap_ref.unwrap_or_default().to_owned(),
        payload.unwrap_or_default().to_owned(),
        rss_bytes.map(|value| value.to_string()).unwrap_or_default(),
        owned_process_count
            .map(|value| value.to_string())
            .unwrap_or_default(),
    ];
    let mut mac = HmacSha256::new_from_slice(challenge).expect("fixed HMAC key length");
    mac.update(fields.join("\0").as_bytes());
    mac.verify_slice(&received).is_ok()
}

fn decode_hex_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let mut output = [0u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (decode_hex_nibble(chunk[0])? << 4) | decode_hex_nibble(chunk[1])?;
    }
    Some(output)
}

fn decode_hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn challenge_hex(challenge: &[u8; 32]) -> String {
    encode_hex(challenge)
}

fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn strict_line_reader(
    stdout: File,
    challenge: [u8; 32],
    generation: u64,
    service: Weak<DshHostService>,
    #[cfg(all(windows, feature = "browser-host-runtime"))] parent: Arc<Mutex<ParentChannel>>,
) -> (mpsc::Receiver<Result<ChildFrame, ()>>, JoinHandle<()>) {
    let (sender, receiver) = mpsc::sync_channel(16);
    let join = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut inbound_seq = 0u64;
        loop {
            let mut line = Vec::new();
            let read = reader
                .by_ref()
                .take((MAX_FRAME_BYTES + 1) as u64)
                .read_until(b'\n', &mut line);
            match read {
                Ok(0) => break,
                Ok(_) => match decode_host_line(line).and_then(|value| {
                    let frame: ChildFrame = serde_json::from_str(&value).map_err(|_| ())?;
                    if frame.protocol != PROTOCOL
                        || frame.generation != generation
                        || frame.seq != inbound_seq + 1
                        || !verify_canonical_mac(
                            &challenge,
                            "child",
                            frame.protocol,
                            frame.generation,
                            frame.seq,
                            &frame.kind,
                            frame.request_id.as_deref(),
                            frame.stage.as_deref(),
                            frame.outcome.as_deref(),
                            frame.duration_ms,
                            frame.reason.as_deref(),
                            frame.port,
                            frame.bootstrap_path.as_deref(),
                            frame.bootstrap_ref.as_deref(),
                            frame.payload.as_deref(),
                            frame.rss_bytes,
                            frame.owned_process_count,
                            frame.carrier_generation,
                            &frame.mac,
                        )
                    {
                        return Err(());
                    }
                    inbound_seq = frame.seq;
                    Ok(frame)
                }) {
                    Ok(frame) => {
                        if frame.kind == "resource-request" {
                            let valid_shape = frame.request_id.as_deref().is_some_and(|value| {
                                !value.is_empty()
                                    && value.len() <= 64
                                    && value.bytes().all(|byte| {
                                        byte.is_ascii_lowercase()
                                            || byte.is_ascii_digit()
                                            || byte == b'-'
                                    })
                            }) && frame
                                .payload
                                .as_deref()
                                .is_some_and(|value| value.len() <= 350 * 1024)
                                && frame.carrier_generation.is_none()
                                && frame.stage.is_none()
                                && frame.outcome.is_none()
                                && frame.duration_ms.is_none()
                                && frame.reason.is_none()
                                && frame.port.is_none()
                                && frame.bootstrap_path.is_none()
                                && frame.bootstrap_ref.is_none()
                                && frame.rss_bytes.is_none()
                                && frame.owned_process_count.is_none();
                            if !valid_shape {
                                let _ = sender.send(Err(()));
                                break;
                            }
                            let Some(service) = service.upgrade() else {
                                let _ = sender.send(Err(()));
                                break;
                            };
                            let response = service.execute_resource_payload(
                                generation,
                                frame.payload.as_deref().unwrap_or_default(),
                            );
                            let write = parent.lock().map_err(|_| ()).and_then(|mut channel| {
                                channel.write_resource_result(
                                    frame.request_id.as_deref().ok_or(())?,
                                    &response,
                                )
                            });
                            if write.is_err() {
                                let _ = sender.send(Err(()));
                                break;
                            }
                            continue;
                        }
                        if frame.kind == "surface-failed" {
                            if frame.request_id.is_some()
                                || frame.outcome.is_some()
                                || frame.duration_ms.is_some()
                                || frame.carrier_generation.is_some()
                                || frame.stage.is_some()
                                || frame.port.is_some()
                                || frame.bootstrap_path.is_some()
                                || frame.bootstrap_ref.is_some()
                                || frame.payload.is_some()
                                || frame.rss_bytes.is_some()
                                || frame.owned_process_count.is_some()
                            {
                                let _ = sender.send(Err(()));
                                break;
                            }
                            let reason = frame
                                .reason
                                .filter(|value| {
                                    value.len() <= 64
                                        && value
                                            .chars()
                                            .all(|c| c.is_ascii_alphanumeric() || c == '-')
                                })
                                .unwrap_or_else(|| "surface-lost".to_owned());
                            if let Some(service) = service.upgrade() {
                                service.publish_surface_failure_for(generation, &reason);
                            }
                            continue;
                        }
                        if frame.kind == "surface-stage" {
                            let stage = match frame.stage.as_deref() {
                                Some("client-ready") => DshNativeSurfaceStage::ClientReady,
                                Some("session-open") => DshNativeSurfaceStage::SessionOpen,
                                _ => {
                                    let _ = sender.send(Err(()));
                                    break;
                                }
                            };
                            let Some(carrier_generation) = frame.carrier_generation else {
                                let _ = sender.send(Err(()));
                                break;
                            };
                            if frame.request_id.is_some()
                                || frame.outcome.is_some()
                                || frame.duration_ms.is_some()
                                || frame.reason.is_some()
                                || frame.port.is_some()
                                || frame.bootstrap_path.is_some()
                                || frame.bootstrap_ref.is_some()
                                || frame.payload.is_some()
                                || frame.rss_bytes.is_some()
                                || frame.owned_process_count.is_some()
                            {
                                let _ = sender.send(Err(()));
                                break;
                            }
                            if let Some(service) = service.upgrade() {
                                service.publish_surface_stage_for(
                                    generation,
                                    carrier_generation,
                                    stage,
                                );
                            }
                            continue;
                        }
                        if sender.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = sender.send(Err(()));
                        break;
                    }
                },
                Err(_) => {
                    let _ = sender.send(Err(()));
                    break;
                }
            }
        }
    });
    (receiver, join)
}

fn decode_host_line(mut line: Vec<u8>) -> Result<String, ()> {
    if line.len() > MAX_FRAME_BYTES || line.last() != Some(&b'\n') {
        return Err(());
    }
    line.pop();
    String::from_utf8(line).map_err(|_| ())
}

fn stderr_drain(mut stderr: File) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut observed = 0usize;
        let mut buffer = [0u8; 4096];
        while let Ok(read) = stderr.read(&mut buffer) {
            if read == 0 {
                break;
            }
            observed = observed.saturating_add(read).min(256 * 1024 + 1);
            buffer[..read].fill(0);
        }
        std::hint::black_box(observed);
    })
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
struct ParentChannel {
    stdin: File,
    challenge: [u8; 32],
    generation: u64,
    outbound_seq: u64,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl ParentChannel {
    fn write(
        &mut self,
        kind: &str,
        request_id: Option<&str>,
        payload: Option<&str>,
    ) -> Result<(), ()> {
        self.outbound_seq = self.outbound_seq.checked_add(1).ok_or(())?;
        let mac = canonical_mac(
            &self.challenge,
            "parent",
            PROTOCOL,
            self.generation,
            self.outbound_seq,
            kind,
            request_id,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            payload,
            None,
            None,
            None,
        );
        let mut value = serde_json::json!({
            "type": kind,
            "protocol": PROTOCOL,
            "generation": self.generation,
            "seq": self.outbound_seq,
            "mac": mac,
        });
        let object = value.as_object_mut().ok_or(())?;
        if let Some(request_id) = request_id {
            object.insert("requestId".to_owned(), serde_json::json!(request_id));
        }
        if let Some(payload) = payload {
            object.insert("payload".to_owned(), serde_json::json!(payload));
        }
        let mut encoded = serde_json::to_vec(&value).map_err(|_| ())?;
        encoded.push(b'\n');
        if encoded.len() > MAX_FRAME_BYTES {
            return Err(());
        }
        self.stdin.write_all(&encoded).map_err(|_| ())?;
        self.stdin.flush().map_err(|_| ())
    }

    fn write_resource_result(&mut self, request_id: &str, payload: &str) -> Result<(), ()> {
        if payload.is_empty()
            || payload.len() > MAX_RESOURCE_RESULT_ENCODED_BYTES
            || !payload.is_ascii()
        {
            return Err(());
        }
        let mut offset = 0usize;
        while offset < payload.len() {
            let end = offset
                .saturating_add(RESOURCE_RESULT_CHUNK_BYTES)
                .min(payload.len());
            let kind = if end == payload.len() {
                "resource-result"
            } else {
                "resource-result-chunk"
            };
            self.write(kind, Some(request_id), payload.get(offset..end))?;
            offset = end;
        }
        Ok(())
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
struct HostHandle {
    process: Arc<crate::owned_process::OwnedProcess>,
    job: Arc<crate::owned_process::OwnedJob>,
    parent: Arc<Mutex<ParentChannel>>,
    frames: mpsc::Receiver<Result<ChildFrame, ()>>,
    stdout_join: Option<JoinHandle<()>>,
    stderr_join: Option<JoinHandle<()>>,
    generation: u64,
    probe_index: u64,
    surface_index: u64,
    model_sync_index: u64,
    open_intent_index: u64,
    remote_index: u64,
    canvas_agent_index: u64,
    expired_canvas_requests: ExpiredCanvasRequests,
    surface_binding_generation: u64,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl HostHandle {
    fn process_id(&self) -> Option<u32> { Some(self.process.process_id()).filter(|pid| *pid != 0) }
    fn diagnostic_only(&self, generation: u64) -> bool {
        self.generation == generation && self.probe_index > 0
            && self.surface_index == 0 && self.model_sync_index == 0
            && self.open_intent_index == 0 && self.remote_index == 0 && self.canvas_agent_index == 0
            && self.surface_binding_generation == 0 && self.is_running()
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    fn write(&mut self, kind: &str, request_id: Option<&str>) -> Result<(), ()> {
        self.parent
            .lock()
            .map_err(|_| ())?
            .write(kind, request_id, None)
    }

    fn write_with_payload(
        &mut self,
        kind: &str,
        request_id: Option<&str>,
        payload: Option<&str>,
    ) -> Result<(), ()> {
        self.parent
            .lock()
            .map_err(|_| ())?
            .write(kind, request_id, payload)
    }

    fn read(&mut self, timeout: Duration) -> Result<ChildFrame, ()> {
        read_authenticated_host_frame(&self.frames, &mut self.expired_canvas_requests, timeout)
            .map_err(|_| ())
    }

    fn validate_host(&mut self) -> bool {
        if !self.is_running() || self.write("ping", None).is_err() {
            return false;
        }
        self.read(Duration::from_secs(2))
            .map(|frame| {
                frame.kind == "pong" && frame.stage.as_deref() == Some("protocol-authenticated")
            })
            .unwrap_or(false)
    }

    fn begin_native_probe(&mut self) -> Result<String, ()> {
        self.probe_index = self.probe_index.checked_add(1).ok_or(())?;
        let request_id = format!("native-probe-{}-{}", self.generation, self.probe_index);
        self.write("probe", Some(&request_id))?;
        Ok(request_id)
    }

    fn expect_probe_stage(
        &mut self,
        request_id: &str,
        stage: &str,
        timeout: Duration,
    ) -> Result<(), ()> {
        let frame = self.read(timeout)?;
        if frame.kind != "probe-stage"
            || frame.request_id.as_deref() != Some(request_id)
            || frame.stage.as_deref() != Some(stage)
        {
            return Err(());
        }
        Ok(())
    }

    fn expect_probe_completed(&mut self, request_id: &str) -> Result<(), ()> {
        let completed = self.read(Duration::from_secs(5))?;
        if completed.kind != "probe-result"
            || completed.request_id.as_deref() != Some(request_id)
            || completed.stage.as_deref() != Some("probe-completed")
            || completed.outcome.as_deref() != Some("accepted")
        {
            return Err(());
        }
        Ok(())
    }

    fn open_surface(&mut self) -> Result<DshNativeSurfaceBootstrap, String> {
        self.surface_index = self
            .surface_index
            .checked_add(1)
            .ok_or_else(|| "dsh-surface-index".to_owned())?;
        let request_id = format!("surface-open-{}-{}", self.generation, self.surface_index);
        self.write("surface-open", Some(&request_id))
            .map_err(|_| "dsh-surface-write".to_owned())?;
        let frame = self
            .read(Duration::from_secs(75))
            .map_err(|_| "dsh-surface-read".to_owned())?;
        if frame.kind != "surface-result" || frame.request_id.as_deref() != Some(&request_id) {
            return Err("dsh-surface-frame".to_owned());
        }
        if frame.stage.as_deref() == Some("surface-failed") {
            // Structure-level failure classification from the wrapper. The
            // classified reason keeps the plugin attribution; an unconfirmed
            // reclamation (outcome) escalates to whole-tree recovery while
            // preserving that attribution for the recovery UI.
            let classified = frame
                .reason
                .filter(|value| {
                    value.len() <= 96
                        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                })
                .unwrap_or_else(|| "surface-failed".to_owned());
            let unconfirmed = frame
                .outcome
                .as_deref()
                .map(|value| value.contains("reclaim-unconfirmed"))
                .unwrap_or(false);
            if unconfirmed {
                return Err(format!(
                    "dsh-surface-failed:{classified}-dsh-surface-tree-unconfirmed"
                ));
            }
            return Err(format!("dsh-surface-failed:{classified}"));
        }
        if frame.stage.as_deref() != Some("surface-ready")
            || frame.outcome.as_deref() != Some("accepted")
        {
            return Err("dsh-native-surface-unavailable".to_owned());
        }
        let port = frame
            .port
            .filter(|port| *port > 0)
            .ok_or_else(|| "dsh-surface-port".to_owned())?;
        let bootstrap_path = frame
            .bootstrap_path
            .filter(|path| path == "/_luckyray/bootstrap")
            .ok_or_else(|| "dsh-surface-bootstrap-path".to_owned())?;
        let bootstrap_ref = frame
            .bootstrap_ref
            .filter(|value| value.len() == 64 && value.as_bytes().iter().all(u8::is_ascii_hexdigit))
            .ok_or_else(|| "dsh-surface-bootstrap-ref".to_owned())?;
        let host_rss_mb = frame
            .rss_bytes
            .filter(|value| *value > 0)
            .map(|value| value / (1024 * 1024))
            .ok_or_else(|| "dsh-surface-rss".to_owned())?;
        let owned_process_count = frame
            .owned_process_count
            .filter(|value| *value == 2)
            .ok_or_else(|| "dsh-surface-process-count".to_owned())?;
        let carrier_generation = frame
            .carrier_generation
            .filter(|value| *value > 0)
            .ok_or_else(|| "dsh-surface-carrier".to_owned())?;
        self.surface_binding_generation = carrier_generation;
        Ok(DshNativeSurfaceBootstrap {
            host_generation: self.generation,
            carrier_generation,
            port,
            bootstrap_path,
            bootstrap_ref,
            host_rss_mb,
            owned_process_count,
        })
    }

    /// One bounded host-frame request into the wrapper's compatibility
    /// authority (status / check / apply). Payload is base64url JSON, matching
    /// the existing authenticated frame envelope.
    fn compat_request(
        &mut self,
        kind: &str,
        payload: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let request_id = format!("compat-{kind}-{}-{}", self.generation, self.surface_index);
        let encoded = payload.map(|value| {
            serde_json::to_vec(value)
                .map_err(|_| "dsh-compat-encode".to_owned())
                .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        });
        let encoded = match encoded {
            Some(result) => Some(result?),
            None => None,
        };
        self.write_with_payload(kind, Some(&request_id), encoded.as_deref())
            .map_err(|_| "dsh-compat-write".to_owned())?;
        let expected = format!("{kind}-result");
        let frame = self
            .read(Duration::from_secs(150))
            .map_err(|_| "dsh-compat-read".to_owned())?;
        if frame.kind != expected || frame.request_id.as_deref() != Some(request_id.as_str()) {
            return Err("dsh-compat-frame".to_owned());
        }
        let payload = frame
            .payload
            .ok_or_else(|| "dsh-compat-payload".to_owned())?;
        let bytes = URL_SAFE_NO_PAD
            .decode(payload.as_bytes())
            .map_err(|_| "dsh-compat-decode".to_owned())?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err("dsh-compat-size".to_owned());
        }
        serde_json::from_slice(&bytes).map_err(|_| "dsh-compat-json".to_owned())
    }

    /// One bounded, payload-carrying remote-surface request into the wrapper
    /// (authority set / session mint / session drop). Payload is base64url
    /// JSON; the reply payload decodes the same way.
    fn remote_request(
        &mut self,
        kind: &str,
        payload: &serde_json::Value,
        expected: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        self.remote_index = self
            .remote_index
            .checked_add(1)
            .ok_or_else(|| "dsh-remote-index".to_owned())?;
        let request_id = format!("remote-{kind}-{}-{}", self.generation, self.remote_index);
        let encoded = serde_json::to_vec(payload)
            .map_err(|_| "dsh-remote-encode".to_owned())
            .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))?;
        self.write_with_payload(kind, Some(&request_id), Some(&encoded))
            .map_err(|_| "dsh-remote-write".to_owned())?;
        let frame = self
            .read(timeout)
            .map_err(|_| "dsh-remote-read".to_owned())?;
        if frame.kind != expected || frame.request_id.as_deref() != Some(&request_id) {
            return Err("dsh-remote-frame".to_owned());
        }
        let payload = frame
            .payload
            .ok_or_else(|| "dsh-remote-payload".to_owned())?;
        let bytes = URL_SAFE_NO_PAD
            .decode(payload.as_bytes())
            .map_err(|_| "dsh-remote-decode".to_owned())?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err("dsh-remote-size".to_owned());
        }
        serde_json::from_slice(&bytes).map_err(|_| "dsh-remote-json".to_owned())
    }

    fn canvas_agent_dispatch(&mut self, payload: &str, canvas_id: &str) -> Result<serde_json::Value, String> {
        if !self.expired_canvas_requests.has_capacity() { return Err("canvas-agent-unavailable".to_owned()); }
        self.canvas_agent_index = self.canvas_agent_index.checked_add(1)
            .ok_or_else(|| "canvas-agent-unavailable".to_owned())?;
        let request_id = format!("canvas-agent-{}-{}", self.generation, self.canvas_agent_index);
        self.write_with_payload("canvas-agent", Some(&request_id), Some(payload))
            .map_err(|_| "canvas-agent-unavailable".to_owned())?;
        let frame = match read_authenticated_host_frame(
            &self.frames, &mut self.expired_canvas_requests, Duration::from_secs(6),
        ) {
            Ok(frame) => frame,
            Err(HostFrameReadError::TimedOut) => {
                self.expired_canvas_requests.record(request_id)
                    .map_err(|_| "canvas-agent-unavailable".to_owned())?;
                return Err("canvas-agent-unavailable".to_owned());
            },
            Err(HostFrameReadError::Unavailable) => return Err("canvas-agent-unavailable".to_owned()),
        };
        if frame.kind != "canvas-agent-result" || frame.request_id.as_deref() != Some(request_id.as_str())
            || frame.carrier_generation.is_some() || frame.stage.is_some() || frame.duration_ms.is_some()
            || frame.port.is_some() || frame.bootstrap_path.is_some() || frame.bootstrap_ref.is_some()
            || frame.rss_bytes.is_some() || frame.owned_process_count.is_some()
        { return Err("canvas-agent-invalid-response".to_owned()); }
        if frame.outcome.as_deref() == Some("rejected") && frame.payload.is_none() {
            return Err(match frame.reason.as_deref() {
                Some(reason @ ("canvas-agent-invalid-request" | "canvas-agent-invalid-response" | "canvas-agent-request-failed" | "canvas-agent-unavailable" | "canvas-agent-transport-busy" | "canvas-agent-busy" | "canvas-agent-capacity" | "canvas-agent-conversation-conflict" | "canvas-agent-request-conflict" | "canvas-agent-request-already-used" | "canvas-agent-run-conflict" | "canvas-agent-storage-unavailable" | "canvas-agent-model-unavailable" | "canvas-agent-runtime-unavailable" | "canvas-agent-cancelled" | "canvas-agent-disposed" | "canvas-agent-host-paused")) => reason,
                _ => "canvas-agent-unavailable",
            }.to_owned());
        }
        if frame.outcome.as_deref() != Some("accepted") || frame.reason.is_some() {
            return Err("canvas-agent-invalid-response".to_owned());
        }
        decode_canvas_agent_snapshot(frame.payload.as_deref()
            .ok_or_else(|| "canvas-agent-invalid-response".to_owned())?, canvas_id)
    }

    fn update_request(&mut self, kind: &str, id: &str) -> Result<serde_json::Value, &'static str> {
        self.remote_request(kind, &serde_json::json!({ "id": id }),
            &format!("{kind}-result"), Duration::from_secs(35))
            .map_err(|_| "update-lsh-control-unavailable")
    }

    fn close_surface(&mut self) -> Result<(), ()> {
        self.surface_index = self.surface_index.checked_add(1).ok_or(())?;
        let request_id = format!("surface-close-{}-{}", self.generation, self.surface_index);
        self.write("surface-close", Some(&request_id))?;
        let frame = self.read(Duration::from_secs(5))?;
        if frame.kind != "surface-result"
            || frame.request_id.as_deref() != Some(&request_id)
            || frame.stage.as_deref() != Some("surface-closed")
            || frame.outcome.as_deref() != Some("accepted")
            || frame.carrier_generation != Some(self.surface_binding_generation)
        {
            return Err(());
        }
        self.surface_binding_generation = 0;
        Ok(())
    }

    fn sync_lightseek_model(&mut self) -> Result<DshModelSyncProjection, ()> {
        self.model_sync_index = self.model_sync_index.checked_add(1).ok_or(())?;
        let request_id = format!("model-sync-{}-{}", self.generation, self.model_sync_index);
        self.write("model-sync", Some(&request_id))?;
        let frame = self.read(Duration::from_secs(10))?;
        if frame.kind != "model-sync-result"
            || frame.request_id.as_deref() != Some(&request_id)
            || frame.carrier_generation.is_some()
            || frame.stage.is_some()
            || frame.outcome.is_some()
            || frame.duration_ms.is_some()
            || frame.reason.is_some()
            || frame.port.is_some()
            || frame.bootstrap_path.is_some()
            || frame.bootstrap_ref.is_some()
            || frame.rss_bytes.is_some()
            || frame.owned_process_count.is_some()
        {
            return Err(());
        }
        let encoded = frame.payload.ok_or(())?;
        if encoded.is_empty() || encoded.len() > 352 * 1024 || !encoded.is_ascii() {
            return Err(());
        }
        let decoded = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| ())?;
        if decoded.is_empty() || decoded.len() > 256 * 1024 {
            return Err(());
        }
        let projection: DshModelSyncProjection =
            serde_json::from_slice(&decoded).map_err(|_| ())?;
        let bounded = |value: &str, max: usize| {
            !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
        };
        match projection.outcome.as_str() {
            "ready" => {
                if projection.providers.len() > 64 || projection.secrets.len() > 64 {
                    return Err(());
                }
                let mut source_identities = Vec::new();
                let mut total_models = 0_usize;
                for provider in &projection.providers {
                    if !bounded(&provider.source_identity, 256)
                        || !bounded(&provider.source, 96)
                        || !bounded(&provider.provider, 128)
                        || !bounded(&provider.profile_id, 128)
                        || !bounded(&provider.display_name, 256)
                        || !bounded(&provider.settings_ns, 128)
                        || provider.settings_path.len() > 8
                        || provider
                            .settings_path
                            .iter()
                            .any(|value| !bounded(value, 128))
                        || !bounded(&provider.reason, 64)
                        || source_identities.contains(&provider.source_identity)
                        || provider.models.len() > 256
                    {
                        return Err(());
                    }
                    source_identities.push(provider.source_identity.clone());
                    total_models = total_models.checked_add(provider.models.len()).ok_or(())?;
                    if total_models > 1024 {
                        return Err(());
                    }
                    if provider.syncable
                        && (!provider.portable
                            || provider
                                .endpoint
                                .as_deref()
                                .is_none_or(|value| !bounded(value, 2048))
                            || provider
                                .wire_protocol
                                .as_deref()
                                .is_none_or(|value| !bounded(value, 128))
                            || provider
                                .credential_ref
                                .as_deref()
                                .is_none_or(|value| !bounded(value, 256))
                            || provider.reason != "ready"
                            || provider.models.is_empty())
                    {
                        return Err(());
                    }
                    for model in &provider.models {
                        if !bounded(&model.id, 256)
                            || !bounded(&model.name, 256)
                            || !matches!(model.input_state.as_str(), "declared" | "unknown")
                            || model.input_state == "unknown" && !model.input.is_empty()
                            || model.input.len() > 2
                            || model
                                .input
                                .iter()
                                .any(|value| !matches!(value.as_str(), "text" | "image"))
                            || !matches!(
                                model.tool_calls.as_str(),
                                "supported" | "unsupported" | "unknown"
                            )
                        {
                            return Err(());
                        }
                    }
                }
                let mut secret_sources = Vec::new();
                for secret in &projection.secrets {
                    if !bounded(&secret.source_identity, 256)
                        || !bounded(&secret.value, 8192)
                        || secret_sources.contains(&secret.source_identity)
                        || !projection.providers.iter().any(|provider| {
                            provider.source_identity == secret.source_identity && provider.syncable
                        })
                    {
                        return Err(());
                    }
                    secret_sources.push(secret.source_identity.clone());
                }
                if projection.providers.iter().any(|provider| {
                    provider.syncable && !secret_sources.contains(&provider.source_identity)
                }) || projection
                    .default_source_identity
                    .as_deref()
                    .is_some_and(|source| {
                        !projection
                            .providers
                            .iter()
                            .any(|provider| provider.source_identity == source && provider.syncable)
                    })
                {
                    return Err(());
                }
            }
            "stale" | "unavailable" => {
                if projection.default_source_identity.is_some()
                    || !projection.providers.is_empty()
                    || !projection.secrets.is_empty()
                {
                    return Err(());
                }
            }
            _ => return Err(()),
        }
        Ok(projection)
    }

    fn stage_open_intent(&mut self, payload: &str) -> Result<(), ()> {
        if self.surface_binding_generation == 0
            || payload.is_empty()
            || payload.len() > MAX_OPEN_INTENT_ENCODED_BYTES
        {
            return Err(());
        }
        self.open_intent_index = self.open_intent_index.checked_add(1).ok_or(())?;
        let request_id = format!("open-intent-{}-{}", self.generation, self.open_intent_index);
        self.parent.lock().map_err(|_| ())?.write(
            "open-intent",
            Some(&request_id),
            Some(payload),
        )?;
        let frame = self.read(Duration::from_secs(5))?;
        if frame.kind != "open-intent-result"
            || frame.request_id.as_deref() != Some(&request_id)
            || frame.carrier_generation.is_some()
            || frame.stage.is_some()
            || frame.outcome.is_some()
            || frame.duration_ms.is_some()
            || frame.reason.is_some()
            || frame.port.is_some()
            || frame.bootstrap_path.is_some()
            || frame.bootstrap_ref.is_some()
            || frame.payload.is_some()
            || frame.rss_bytes.is_some()
            || frame.owned_process_count.is_some()
        {
            return Err(());
        }
        Ok(())
    }

    fn open_intent_status(&mut self, intent_id: &str) -> Result<String, ()> {
        if self.surface_binding_generation == 0
            || intent_id.len() > 64
            || !intent_id.starts_with("intent-")
        {
            return Err(());
        }
        self.open_intent_index = self.open_intent_index.checked_add(1).ok_or(())?;
        let request_id = format!("open-intent-status-{}-{}", self.generation, self.open_intent_index);
        self.write_with_payload("open-intent-status", Some(&request_id), Some(intent_id))?;
        let frame = self.read(Duration::from_secs(5))?;
        if frame.kind != "open-intent-status-result"
            || frame.request_id.as_deref() != Some(&request_id)
            || frame.carrier_generation.is_some()
            || frame.stage.is_some()
            || frame.outcome.is_some()
            || frame.duration_ms.is_some()
            || frame.reason.is_some()
            || frame.port.is_some()
            || frame.bootstrap_path.is_some()
            || frame.bootstrap_ref.is_some()
            || frame.rss_bytes.is_some()
            || frame.owned_process_count.is_some()
        {
            return Err(());
        }
        match frame.payload.as_deref() {
            Some("pending" | "applied" | "unavailable") => Ok(frame.payload.unwrap()),
            _ => Err(()),
        }
    }

    fn shutdown(mut self) -> bool {
        let _ = self.write("shutdown", None);
        let acknowledged = self
            .read(SHUTDOWN_TIMEOUT)
            .map(|frame| {
                frame.kind == "shutdown-ack" && frame.stage.as_deref() == Some("shutting-down")
            })
            .unwrap_or(false);
        let graceful_process_exit = acknowledged && self.process.wait_for(SHUTDOWN_TIMEOUT);
        if !graceful_process_exit {
            self.job.terminate();
            self.process.terminate();
        }
        let tree_quiescent = self.job.terminate_and_wait(SHUTDOWN_TIMEOUT);
        let process_quiescent = self.process.wait_for(SHUTDOWN_TIMEOUT);
        // A full reader channel can block its producer in `send`. Drop the
        // receiver before joining, and never let a broken pipe keep normal
        // application exit (and its update marker) on an unbounded join.
        let (_tx, empty) = mpsc::channel();
        drop(std::mem::replace(&mut self.frames, empty));
        let readers_quiescent = self.stdout_join.take().is_none_or(|join| bounded_reader_join(join))
            && self.stderr_join.take().is_none_or(|join| bounded_reader_join(join));
        tree_quiescent && process_quiescent && readers_quiescent
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl Drop for HostHandle {
    fn drop(&mut self) {
        self.job.terminate();
        self.process.terminate();
        let (_tx, empty) = mpsc::channel();
        drop(std::mem::replace(&mut self.frames, empty));
        if let Some(join) = self.stdout_join.take() { let _ = bounded_reader_join(join); }
        if let Some(join) = self.stderr_join.take() { let _ = bounded_reader_join(join); }
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn bounded_reader_join(join: JoinHandle<()>) -> bool {
    let deadline = Instant::now() + Duration::from_secs(1);
    while !join.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    join.is_finished() && join.join().is_ok()
}

#[cfg(not(all(windows, feature = "browser-host-runtime")))]
struct HostHandle;

#[cfg(not(all(windows, feature = "browser-host-runtime")))]
impl HostHandle {
    fn process_id(&self) -> Option<u32> { None }
    fn update_request(&mut self, _kind: &str, _id: &str) -> Result<serde_json::Value, &'static str> {
        Err("update-lsh-control-unavailable")
    }
    fn diagnostic_only(&self, _generation: u64) -> bool { false }

    fn is_running(&self) -> bool {
        false
    }

    fn generation(&self) -> u64 {
        0
    }

    fn shutdown(self) -> bool {
        true
    }
}

pub(crate) struct DshHostService {
    initialization_finished: AtomicBool,
    initialization_gate: Mutex<()>,
    initialization_ready: Condvar,
    status: Mutex<DshHostStatusView>,
    host: Mutex<Option<HostHandle>>,
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    active_job: Mutex<Option<Arc<crate::owned_process::OwnedJob>>>,
    compat_auto_attempted: AtomicBool,
    surface_compat_mode: AtomicBool,
    last_teardown_settled: AtomicBool,
    generation: AtomicU64,
    shutting_down: AtomicBool,
    start_admission: Mutex<()>,
    operation: Mutex<()>,
    surface_lease: Mutex<Option<RuntimeUseLease>>,
    surface_preheat_ms: Mutex<Option<u64>>,
    surface_status: Mutex<DshNativeSurfaceStatusView>,
    surface_host_generation: AtomicU64,
    surface_binding_generation: AtomicU64,
    surface_port: AtomicU16,
    /// Remote-surface desired authority (advertised companion origin host).
    /// Remembered across surface bindings; pushed to the wrapper/carrier on
    /// set and after every successful surface open.
    desired_remote_authority: Mutex<Option<String>>,
    desired_remote_gateway_generation: AtomicU64,
    remote_authority_active: AtomicBool,
    resource_broker: Mutex<Option<crate::dsh_resource_broker::DshResourceBroker>>,
    #[cfg(test)]
    pre_use_hook: Mutex<Option<Arc<dyn Fn(&Path) -> Result<(), ()> + Send + Sync>>>,
    #[cfg(test)]
    acquisition_progress_hook:
        Mutex<Option<Arc<dyn Fn(crate::dsh_runtime_seal::RuntimeSealProgress) + Send + Sync>>>,
    #[cfg(test)]
    pre_admission_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    post_admission_hook: Mutex<Option<Arc<dyn Fn(u64) + Send + Sync>>>,
    #[cfg(test)]
    spawn_attempts: AtomicU64,
    #[cfg(test)]
    surface_control_failure: AtomicBool,
    #[cfg(test)]
    remote_drop_failure: AtomicBool,
    #[cfg(test)]
    remote_authority_failure: AtomicBool,
    // Rust drops fields in declaration order. Keep critical runtime pins after
    // the owned host/job and surface lease, including implicit Arc teardown.
    descriptor: OnceLock<RuntimeDescriptor>,
}

fn validate_action(
    stage: DshHostStage,
    action: DshHostAction,
    descriptor_available: bool,
) -> Result<(), String> {
    if !descriptor_available {
        return Err("dsh-host-unavailable".to_owned());
    }
    let allowed = match action {
        DshHostAction::Probe => matches!(
            stage,
            DshHostStage::BundledVerified | DshHostStage::ProbeCompleted
        ),
        DshHostAction::ExplicitRetry => stage == DshHostStage::Unavailable,
    };
    if !allowed {
        return Err("dsh-host-action-not-allowed".to_owned());
    }
    Ok(())
}

fn compat_apply_succeeded(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let unquarantinable_empty = object
        .get("unquarantinable")
        .and_then(|value| value.as_array())
        .map(|items| items.is_empty())
        .unwrap_or_else(|| !object.contains_key("unquarantinable"));
    object.get("applied") == Some(&serde_json::json!(true))
        && object.get("failed") != Some(&serde_json::json!(true))
        && object.get("checked") != Some(&serde_json::json!(false))
        && unquarantinable_empty
}

impl DshHostService {
    pub(crate) fn production(resource_dir: &Path, app_data_dir: &Path) -> Arc<Self> {
        let descriptor = RuntimeDescriptor::resolve(resource_dir, app_data_dir).ok();
        Self::new(descriptor, true)
    }

    /// Ordinary startup checks a bounded critical identity. An explicitly armed
    /// update still admits the full closure off Tauri's setup/UI thread; commands that need
    /// the result wait on their own blocking workers instead.
    pub(crate) fn production_background(resource_dir: &Path, app_data_dir: &Path) -> Arc<Self> {
        let service = Self::new(None, false);
        let owned = Arc::clone(&service);
        let resource_dir = resource_dir.to_path_buf();
        let app_data_dir = app_data_dir.to_path_buf();
        thread::spawn(move || {
            let descriptor = std::panic::catch_unwind(|| {
                RuntimeDescriptor::resolve(&resource_dir, &app_data_dir).ok()
            })
            .ok()
            .flatten();
            let _gate = owned.initialization_gate.lock().unwrap();
            if !owned.shutting_down.load(Ordering::Acquire) {
                if let Some(descriptor) = descriptor {
                    let _ = owned.descriptor.set(descriptor);
                    owned.publish(DshHostStage::BundledVerified, 0, None);
                } else {
                    owned.publish(DshHostStage::Unavailable, 0, None);
                }
            }
            owned.initialization_finished.store(true, Ordering::Release);
            owned.initialization_ready.notify_all();
        });
        service
    }

    fn new(descriptor: Option<RuntimeDescriptor>, initialization_finished: bool) -> Arc<Self> {
        let descriptor_cell = OnceLock::new();
        if let Some(descriptor) = descriptor {
            let _ = descriptor_cell.set(descriptor);
        }
        let status = if descriptor_cell.get().is_some() {
            DshHostStatusView {
                stage: DshHostStage::BundledVerified,
                latest_probe_passed: false,
                host_reusable: false,
                can_probe: true,
                can_retry: false,
                shutting_down: false,
                retry_attempt: 0,
                duration_ms: None,
                message: "DeepSeek Harness 已验证，可进行诊断。",
            }
        } else {
            DshHostStatusView::unavailable("DeepSeek Harness 运行组件暂不可用。")
        };
        Arc::new(Self {
            descriptor: descriptor_cell,
            initialization_finished: AtomicBool::new(initialization_finished),
            initialization_gate: Mutex::new(()),
            initialization_ready: Condvar::new(),
            status: Mutex::new(status),
            host: Mutex::new(None),
            #[cfg(all(windows, feature = "browser-host-runtime"))]
            active_job: Mutex::new(None),
            compat_auto_attempted: AtomicBool::new(false),
            surface_compat_mode: AtomicBool::new(false),
            last_teardown_settled: AtomicBool::new(true),
            generation: AtomicU64::new(0),
            shutting_down: AtomicBool::new(false),
            start_admission: Mutex::new(()),
            operation: Mutex::new(()),
            surface_lease: Mutex::new(None),
            surface_preheat_ms: Mutex::new(None),
            surface_status: Mutex::new(DshNativeSurfaceStatusView {
                ready: false,
                stage: DshNativeSurfaceStage::Closed,
                cold_jit_ms: None,
                carrier_bind_ms: None,
                outer_host_rss_mb: None,
                lucky_ray_process_handle_count: current_process_handle_count(),
                owned_direct_process_count: 0,
                message: "官方 DeepSeek Harness 界面未启动。",
            }),
            surface_host_generation: AtomicU64::new(0),
            surface_port: AtomicU16::new(0),
            desired_remote_authority: Mutex::new(None),
            desired_remote_gateway_generation: AtomicU64::new(0),
            remote_authority_active: AtomicBool::new(false),
            surface_binding_generation: AtomicU64::new(0),
            resource_broker: Mutex::new(None),
            #[cfg(test)]
            pre_use_hook: Mutex::new(None),
            #[cfg(test)]
            acquisition_progress_hook: Mutex::new(None),
            #[cfg(test)]
            pre_admission_hook: Mutex::new(None),
            #[cfg(test)]
            post_admission_hook: Mutex::new(None),
            #[cfg(test)]
            spawn_attempts: AtomicU64::new(0),
            #[cfg(test)]
            surface_control_failure: AtomicBool::new(false),
            #[cfg(test)]
            remote_drop_failure: AtomicBool::new(false),
            #[cfg(test)]
            remote_authority_failure: AtomicBool::new(false),
        })
    }

    pub(crate) fn status(&self) -> DshHostStatusView {
        let mut status = self.status.lock().unwrap().clone();
        if !self.initialization_finished.load(Ordering::Acquire)
            && !self.shutting_down.load(Ordering::Acquire) {
            status.stage = DshHostStage::Initializing;
            status.latest_probe_passed = false;
            status.host_reusable = false;
            // Probe waits on its blocking worker for exact descriptor admission.
            status.can_probe = true;
            status.can_retry = false;
            status.message = "正在核验 DeepSeek Harness 运行资源；尚未就绪。";
        }
        status
    }

    pub(crate) fn wait_initialized(&self) {
        let mut gate = self.initialization_gate.lock().unwrap();
        while !self.initialization_finished.load(Ordering::Acquire)
            && !self.shutting_down.load(Ordering::Acquire)
        {
            gate = self.initialization_ready.wait(gate).unwrap();
        }
    }

    pub(crate) fn engine_update_context(&self)
        -> Option<(Arc<crate::dsh_engine_update::UpdateStore>, String, bool)> {
        let descriptor = self.descriptor.get()?;
        let store = Arc::clone(descriptor.update_store.as_ref()?);
        let pending_health = store.selected_pending_health(descriptor.dynamic_candidate.as_ref())?;
        let version = descriptor.dynamic_candidate.as_ref()
            .map(|candidate| candidate.version.clone())
            .or_else(crate::dsh_runtime_seal::bundled_runtime_version)?;
        Some((store, version, pending_health))
    }

    /// Reserve the cold, never-started DSH generation for an app-owned update
    /// restart. A live official surface may hold drafts or background work;
    /// until a full quiescence protocol exists, that case fails closed.
    pub(crate) fn begin_cold_update_restart(&self) -> bool {
        let _admission = self.start_admission.lock().unwrap();
        if self.shutting_down.load(Ordering::Acquire)
            || self.status().stage != DshHostStage::BundledVerified
            || self.surface_status().stage != DshNativeSurfaceStage::Closed
            || self.host.lock().unwrap().is_some()
            || !self.last_teardown_settled.load(Ordering::Acquire) {
            return false;
        }
        self.shutting_down.store(true, Ordering::Release);
        true
    }

    /// Hold startup admission and ask a warm official runtime to reserve its
    /// idle Agents and confirm durable Session writes. Surface visibility and
    /// session-open labels are never task/save authority.
    pub(crate) fn reserve_desktop_update_restart(self: &Arc<Self>) -> Result<DesktopUpdateReservation, &'static str> {
        let _operation = self.operation.try_lock().map_err(|_| "update-lsh-preparing")?;
        let _admission = self.start_admission.lock().unwrap();
        if self.shutting_down.load(Ordering::Acquire)
            || !self.last_teardown_settled.load(Ordering::Acquire)
            || !update_remote_policy::permits_update_reservation(
                self.desired_remote_authority.lock().unwrap().is_some(),
                self.surface_binding_generation.load(Ordering::Acquire) != 0,
                self.remote_authority_active.load(Ordering::Acquire),
            ) {
            return Err("update-lsh-not-quiescent");
        }
        let generation = self.generation.load(Ordering::Acquire);
        let stage = self.status().stage;
        let surface = self.surface_status().stage;
        let mut host = self.host.lock().unwrap();
        let safe = self.surface_host_generation.load(Ordering::Acquire) == 0
            && self.surface_binding_generation.load(Ordering::Acquire) == 0
            && match (stage, host.as_ref()) {
            (DshHostStage::BundledVerified, None) => surface == DshNativeSurfaceStage::Closed,
            (DshHostStage::ProbeCompleted, Some(host)) => {
                // The initial empty teardown publishes Unavailable before probing.
                // Neither that label nor Closed is sufficient without history.
                matches!(surface, DshNativeSurfaceStage::Closed | DshNativeSurfaceStage::Unavailable)
                    && host.diagnostic_only(generation)
            }
            _ => false,
        };
        let warm = self.surface_host_generation.load(Ordering::Acquire) == generation
            && self.surface_binding_generation.load(Ordering::Acquire) > 0
            && matches!(surface, DshNativeSurfaceStage::ClientReady | DshNativeSurfaceStage::SessionOpen)
            && host.as_ref().is_some_and(|host| host.generation() == generation && host.is_running());
        if !safe && !warm { return Err("update-lsh-not-quiescent"); }
        let host_generation = host.as_ref().map(HostHandle::generation);
        self.shutting_down.store(true, Ordering::Release);
        let mut nonce = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let id = format!("desktop-update-{}-{}-{}", generation,
            self.surface_binding_generation.load(Ordering::Acquire), encode_hex(&nonce));
        let mut reservation = DesktopUpdateReservation {
            service: Arc::clone(self), generation, host_generation, stage,
            warm_id: warm.then_some(id.clone()), surface_process_id: None, stopped: false,
        };
        if warm {
            let result = host.as_mut().ok_or("update-lsh-state-unavailable")?.update_request("update-prepare", &id);
            let result = match result {
                Ok(value) => value,
                Err(code) => {
                    // Drop locks before reservation rollback re-enters admission.
                    drop(host); drop(_admission); return Err(code);
                }
            };
            if result.get("ready").and_then(|v| v.as_bool()) != Some(true)
                || result.get("saved").and_then(|v| v.as_bool()) != Some(true)
                || result.get("sessionCount").and_then(|v| v.as_u64()).is_none() {
                let code = update_lsh_failure(result.get("reason").and_then(|v| v.as_str()));
                drop(host); drop(_admission); return Err(code);
            }
            reservation.surface_process_id = result.get("carrierProcessId").and_then(|v| v.as_u64())
                .and_then(|value| u32::try_from(value).ok()).filter(|pid| *pid > 0);
            if reservation.surface_process_id.is_none() {
                drop(host); drop(_admission); return Err("update-lsh-identity-changed");
            }
            eprintln!("[dsh-update-exit] lsh held generation={generation} sessions={} saved=true",
                result.get("sessionCount").and_then(|v| v.as_u64()).unwrap());
        }
        Ok(reservation)
    }

    pub(crate) fn surface_status(&self) -> DshNativeSurfaceStatusView {
        self.surface_status.lock().unwrap().clone()
    }

    pub(crate) fn install_resource_broker(
        &self,
        broker: crate::dsh_resource_broker::DshResourceBroker,
    ) {
        let mut installed = self.resource_broker.lock().unwrap();
        assert!(installed.is_none(), "DSH resource broker already installed");
        *installed = Some(broker);
    }

    fn execute_resource_payload(&self, generation: u64, encoded: &str) -> String {
        let response = (|| {
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| "dsh-resource-frame-invalid")?;
            if bytes.len() > 256 * 1024 {
                return Err("dsh-resource-frame-invalid");
            }
            let request: ResourceRequestEnvelope =
                serde_json::from_slice(&bytes).map_err(|_| "dsh-resource-frame-invalid")?;
            let broker = self
                .resource_broker
                .lock()
                .map_err(|_| "dsh-resource-broker-unavailable")?
                .clone()
                .ok_or("dsh-resource-broker-unavailable")?;
            match request.kind.as_str() {
                "policy" => {
                    let policy = serde_json::from_value(request.payload)
                        .map_err(|_| "dsh-resource-frame-invalid")?;
                    broker
                        .sync_policy(generation, policy)
                        .map_err(|error| error.code)
                }
                "call" => {
                    let call = serde_json::from_value(request.payload)
                        .map_err(|_| "dsh-resource-frame-invalid")?;
                    broker.execute(generation, call).map_err(|error| error.code)
                }
                _ => Err("dsh-resource-frame-invalid"),
            }
        })();
        let mut value = match response {
            Ok(value) => serde_json::json!({ "ok": true, "value": value }),
            Err(code) => serde_json::json!({ "ok": false, "code": code }),
        };
        let mut bytes = serde_json::to_vec(&value).unwrap_or_else(|_| {
            br#"{"ok":false,"code":"dsh-resource-broker-unavailable"}"#.to_vec()
        });
        if bytes.len() > MAX_RESOURCE_RESULT_JSON_BYTES {
            value = serde_json::json!({ "ok": false, "code": "dsh-resource-result-too-large" });
            bytes = serde_json::to_vec(&value).unwrap_or_else(|_| {
                br#"{"ok":false,"code":"dsh-resource-broker-unavailable"}"#.to_vec()
            });
        }
        URL_SAFE_NO_PAD.encode(bytes)
    }

    pub(crate) fn open_native_surface(
        &self,
    ) -> Result<(DshNativeSurfaceStatusView, DshNativeSurfaceBootstrap), String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "dsh-host-action-busy".to_owned())?;
        self.open_native_surface_locked()
    }

    pub(crate) fn native_surface_binding(&self) -> Option<(u64, u64)> {
        let host = self.surface_host_generation.load(Ordering::Acquire);
        let carrier = self.surface_binding_generation.load(Ordering::Acquire);
        self.native_surface_binding_matches(host, carrier).then_some((host, carrier))
    }

    pub(crate) fn native_surface_binding_matches(&self, host: u64, carrier: u64) -> bool {
        host != 0 && carrier != 0 && !self.shutting_down.load(Ordering::Acquire)
            && self.surface_host_generation.load(Ordering::Acquire) == host
            && self.surface_binding_generation.load(Ordering::Acquire) == carrier
    }

    fn open_native_surface_locked(
        &self,
    ) -> Result<(DshNativeSurfaceStatusView, DshNativeSurfaceBootstrap), String> {
        // A caller can pass its first check just before update admission wins.
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        if self.status().stage != DshHostStage::ProbeCompleted {
            return Err("dsh-native-surface-not-ready".to_owned());
        }
        let descriptor = self
            .descriptor
            .get()
            .ok_or_else(|| "dsh-host-unavailable".to_owned())?;
        let existing_lease = self.surface_lease.lock().unwrap().take();
        let (lease, cold_jit_ms) = if let Some(lease) = existing_lease {
            (lease, self.surface_preheat_ms.lock().unwrap().take())
        } else {
            let jit_started = Instant::now();
            let lease = self
                .acquire_runtime_use(descriptor)
                .map_err(|_| "dsh-host-unavailable".to_owned())?;
            (
                lease,
                Some(jit_started.elapsed().as_millis().min(u64::MAX as u128) as u64),
            )
        };
        let started = Instant::now();
        let bootstrap_result = {
            let mut host_guard = self.host.lock().unwrap();
            match host_guard.as_mut() {
                Some(host) => {
                    if host.validate_host() {
                        host.open_surface()
                    } else {
                        Err("dsh-host-unavailable".to_owned())
                    }
                }
                None => Err("dsh-host-unavailable".to_owned()),
            }
        };
        let bootstrap = match bootstrap_result {
            Ok(bootstrap) => bootstrap,
            Err(error) => {
                // One explicitly labelled compatibility retry per service
                // lifetime: a plugin-classified start failure quarantines
                // non-passing third-party bundles and respawns in place (the
                // wrapper survives a failed open; the guard patch applies at
                // every spawn). A second failure stops — recovery then needs
                // the outer host UI, never another silent attempt.
                // An unconfirmed tree must escalate to whole-host recovery
                // FIRST; an in-place auto retry would spawn a second tree
                // while the first is still unaccounted for.
                if !self.compat_auto_attempted.swap(true, Ordering::AcqRel)
                    && error.starts_with("dsh-surface-failed:plugin")
                    && !error.contains("tree-unconfirmed")
                {
                    let retried = {
                        let mut host_guard = self.host.lock().unwrap();
                        match host_guard.as_mut() {
                            Some(host) => {
                                if !host.validate_host() {
                                    Err("dsh-host-unavailable".to_owned())
                                } else {
                                    host.compat_request(
                                        "compat-apply",
                                        Some(&serde_json::json!({ "kind": "auto" })),
                                    )
                                    .and_then(|applied| {
                                        if compat_apply_succeeded(&applied) {
                                            host.open_surface()
                                        } else {
                                            Err("dsh-plugin-compat-apply-failed".to_owned())
                                        }
                                    })
                                }
                            }
                            None => Err("dsh-host-unavailable".to_owned()),
                        }
                    };
                    match retried {
                        Ok(bootstrap) => {
                            self.surface_compat_mode.store(true, Ordering::Release);
                            bootstrap
                        }
                        Err(retry_error) => return self.fail_surface_or_generation(&retry_error),
                    }
                } else {
                    return self.fail_surface_or_generation(&error);
                }
            }
        };
        self.surface_host_generation
            .store(bootstrap.host_generation, Ordering::Release);
        self.surface_binding_generation
            .store(bootstrap.carrier_generation, Ordering::Release);
        let status = DshNativeSurfaceStatusView {
            ready: false,
            stage: DshNativeSurfaceStage::CarrierReady,
            cold_jit_ms,
            carrier_bind_ms: Some(started.elapsed().as_millis().min(u64::MAX as u128) as u64),
            outer_host_rss_mb: Some(bootstrap.host_rss_mb),
            lucky_ray_process_handle_count: current_process_handle_count(),
            owned_direct_process_count: bootstrap.owned_process_count,
            message: if self.surface_compat_mode.load(Ordering::Acquire) {
                "LightSeek 正以兼容模式运行：存在待处理的扩展兼容问题，部分扩展已被暂停。"
            } else {
                "官方 DeepSeek Harness 载体已连接，正在等待界面与原生会话就绪。"
            },
        };
        self.surface_port.store(bootstrap.port, Ordering::Release);
        {
            // Publish the ACK against the same desired authority that was sent.
            // Otherwise a stale open ACK can overwrite a later failed clear.
            let _admission = self.start_admission.lock().unwrap();
            if self.shutting_down.load(Ordering::Acquire) {
                return Err("dsh-host-shutting-down".to_owned());
            }
            let remote_pushed = self.push_remote_authority_locked(bootstrap.carrier_generation);
            self.remote_authority_active.store(remote_pushed, Ordering::Release);
        }
        *self.surface_lease.lock().unwrap() = Some(lease);
        *self.surface_status.lock().unwrap() = status.clone();
        Ok((status, bootstrap))
    }

    /// Push the desired remote authority to the freshly opened binding. A
    /// failure leaves the remote capability reported as inactive; the surface
    /// itself is unaffected.
    fn push_remote_authority_locked(
        &self,
        carrier_generation: u64,
    ) -> bool {
        #[cfg(test)]
        if self.remote_authority_failure.swap(false, Ordering::AcqRel) {
            return false;
        }
        let gateway_generation =
            self.desired_remote_gateway_generation.load(Ordering::Acquire);
        let payload = match self.desired_remote_authority.lock().unwrap().clone() {
            Some(host) => serde_json::json!({
                "host": host,
                "origin": format!("https://{host}"),
                "gatewayGeneration": gateway_generation,
            }),
            None => serde_json::json!({ "gatewayGeneration": gateway_generation }),
        };
        let push = {
            let mut host_guard = self.host.lock().unwrap();
            match host_guard.as_mut() {
                Some(host) if host.surface_binding_generation == carrier_generation => host
                    .remote_request(
                        "remote-authority-set",
                        &payload,
                        "remote-authority-set-result",
                        Duration::from_secs(5),
                    ),
                _ => Err("dsh-host-unavailable".to_owned()),
            }
        };
        matches!(push, Ok(value) if value.get("applied") == Some(&serde_json::json!(true)))
    }

    /// Desktop-owned truth for the advertised remote origin (or its absence).
    /// The desired value survives surface rebinds; the LIVE flag only turns on
    /// once a binding actually carries it.
    pub(crate) fn set_remote_surface_authority(
        &self,
        host: Option<String>,
        gateway_generation: u64,
    ) -> Result<(), String> {
        // Serialize changing the desired authority with update admission. A
        // setter which passed an earlier external check cannot advertise a new
        // origin after the update reserved an acknowledged, cleared carrier.
        let _admission = self.start_admission.lock().unwrap();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        self.desired_remote_gateway_generation
            .store(gateway_generation, Ordering::Release);
        if let Some(value) = &host {
            let invalid = || "lsh-remote-authority-invalid".to_owned();
            let (name, port) = value.rsplit_once(':').ok_or_else(invalid)?;
            let port: u16 = port.parse().map_err(|_| invalid())?;
            if port == 0
                || value.len() > 254
                || name.is_empty()
                || name.len() > 253
                || name.eq_ignore_ascii_case("localhost")
                || name.parse::<std::net::IpAddr>().is_ok()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
                || name.starts_with('-')
                || name.ends_with('-')
            {
                return Err(invalid());
            }
        }
        *self.desired_remote_authority.lock().unwrap() = host;
        // Live push when a surface is already bound; otherwise the next
        // successful surface open pushes it.
        let binding = self.surface_binding_generation.load(Ordering::Acquire);
        if binding == 0 {
            self.remote_authority_active.store(false, Ordering::Release);
            return Ok(());
        }
        let pushed = self.push_remote_authority_locked(binding);
        self.remote_authority_active.store(pushed, Ordering::Release);
        if !pushed {
            return Err("lsh-remote-authority-push-failed".to_owned());
        }
        Ok(())
    }

    pub(crate) fn remote_surface_available(&self) -> bool {
        self.surface_binding_generation.load(Ordering::Acquire) != 0
            && self.remote_authority_active.load(Ordering::Acquire)
    }

    /// The Desktop-owned loopback tunnel target for granted devices. The port
    /// never appears in any status view or log; it exists only for the in-process
    /// companion gateway to dial the carrier.
    pub(crate) fn remote_surface_target(&self) -> Option<(u16, u64)> {
        if !self.remote_surface_available() {
            return None;
        }
        let port = self.surface_port.load(Ordering::Acquire);
        if port == 0 {
            return None;
        }
        Some((port, self.surface_binding_generation.load(Ordering::Acquire)))
    }

    /// Mint one device-scoped, single-use remote bootstrap. Requires a live
    /// binding that actually carries the remote authority.
    pub(crate) fn mint_remote_session(
        &self,
        device_id: &str,
        gateway_generation: u64,
    ) -> Result<DshRemoteSessionBootstrap, String> {
        let _admission = self.start_admission.lock().unwrap();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        if !self.remote_surface_available() {
            return Err("lsh-remote-unavailable".to_owned());
        }
        let binding = self.surface_binding_generation.load(Ordering::Acquire);
        let payload = serde_json::json!({
            "deviceId": device_id,
            "gatewayGeneration": gateway_generation,
        });
        let result = {
            let mut host_guard = self.host.lock().unwrap();
            match host_guard.as_mut() {
                Some(host) if host.surface_binding_generation == binding => host.remote_request(
                    "remote-session-mint",
                    &payload,
                    "remote-session-mint-result",
                    Duration::from_secs(10),
                ),
                _ => Err("dsh-host-unavailable".to_owned()),
            }
        }?;
        if result.get("outcome") != Some(&serde_json::json!("accepted")) {
            return Err("lsh-remote-unavailable".to_owned());
        }
        let reference = result
            .get("ref")
            .and_then(|value| value.as_str())
            .filter(|value| value.len() == 64 && value.as_bytes().iter().all(u8::is_ascii_hexdigit))
            .ok_or_else(|| "lsh-remote-ref".to_owned())?
            .to_owned();
        let expires_at_ms = result
            .get("expiresAtMs")
            .and_then(|value| value.as_u64())
            .ok_or_else(|| "lsh-remote-expiry".to_owned())?;
        let bootstrap_path = result
            .get("bootstrapPath")
            .and_then(|value| value.as_str())
            .filter(|value| *value == "/_luckyray/remote/bootstrap")
            .ok_or_else(|| "lsh-remote-bootstrap-path".to_owned())?
            .to_owned();
        Ok(DshRemoteSessionBootstrap {
            reference,
            expires_at_ms,
            bootstrap_path,
            carrier_generation: binding,
        })
    }

    /// Drop one device's remote sessions. A lost or malformed acknowledgement
    /// must not leave browser cookies usable: re-push the existing authority,
    /// which clears every carrier-side session/ref, or disable the relay until
    /// a later successful authority push clears them.
    pub(crate) fn drop_remote_sessions(&self, device_id: &str) -> Result<(), String> {
        // A late single-device ACK must not overwrite a newer failed clear
        // and falsely authorize a desktop update. Keep the entire revoke/rekey
        // operation in the same ordering as authority setters and reservations.
        let _admission = self.start_admission.lock().unwrap();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        if !self.remote_surface_available() {
            return Ok(());
        }
        self.remote_authority_active.store(false, Ordering::Release);
        let payload = serde_json::json!({ "deviceId": device_id });
        #[cfg(test)]
        let injected_failure = self.remote_drop_failure.swap(false, Ordering::AcqRel);
        #[cfg(not(test))]
        let injected_failure = false;
        let dropped = if injected_failure {
            Err("lsh-remote-drop-not-applied".to_owned())
        } else {
            let mut host_guard = self.host.lock().unwrap();
            match host_guard.as_mut() {
                Some(host) => host.remote_request(
                    "remote-session-drop",
                    &payload,
                    "remote-session-drop-result",
                    Duration::from_secs(5),
                ),
                None => Err("dsh-host-unavailable".to_owned()),
            }
        };
        if matches!(dropped, Ok(ref value) if value.get("dropped").and_then(|v| v.as_str()) == Some("applied")) {
            self.remote_authority_active.store(true, Ordering::Release);
            return Ok(());
        }
        let binding = self.surface_binding_generation.load(Ordering::Acquire);
        let rekeyed = binding != 0 && self.push_remote_authority_locked(binding);
        self.remote_authority_active.store(rekeyed, Ordering::Release);
        if rekeyed { Ok(()) } else { Err("lsh-remote-revoke-unconfirmed".to_owned()) }
    }

    pub(crate) fn restart_native_surface_with<RetireNative, CreateNative>(
        self: &Arc<Self>,
        retire_native_child: RetireNative,
        create_native_child: CreateNative,
    ) -> Result<DshNativeSurfaceStatusView, String>
    where
        RetireNative: FnOnce() -> Result<(), String>,
        CreateNative: FnOnce(&DshNativeSurfaceBootstrap) -> Result<(), String>,
    {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "dsh-host-action-busy".to_owned())?;
        if self.status().stage != DshHostStage::ProbeCompleted
            || self.host.lock().unwrap().is_none()
            || self.shutting_down.load(Ordering::Acquire)
        {
            return Err("dsh-native-surface-not-ready".to_owned());
        }
        if let Err(error) = retire_native_child() {
            let _ = self.terminate_current_checked();
            self.publish(DshHostStage::Unavailable, 0, None);
            return Err(error);
        }
        self.publish(DshHostStage::RestartWaiting, 0, None);
        if !self.terminate_current_checked() {
            self.publish(DshHostStage::Unavailable, 0, None);
            return Err("dsh-native-surface-restart-unsettled".to_owned());
        }
        let descriptor = self
            .descriptor
            .get()
            .ok_or_else(|| "dsh-host-unavailable".to_owned())?;
        if self.launch_and_probe(descriptor, 0).is_err() {
            let _ = self.terminate_current_checked();
            self.publish(DshHostStage::Unavailable, 0, None);
            return Err("dsh-native-surface-unavailable".to_owned());
        }
        let (_status, bootstrap) = self.open_native_surface_locked()?;
        if let Err(error) = create_native_child(&bootstrap) {
            let _ = self.terminate_current_checked();
            self.publish(DshHostStage::Unavailable, 0, None);
            return Err(error);
        }
        self.publish_surface_stage_for(
            bootstrap.host_generation,
            bootstrap.carrier_generation,
            DshNativeSurfaceStage::WebviewCreated,
        );
        Ok(self.surface_status())
    }

    pub(crate) fn publish_surface_stage_for(
        &self,
        host_generation: u64,
        carrier_generation: u64,
        stage: DshNativeSurfaceStage,
    ) {
        if host_generation == 0
            || carrier_generation == 0
            || self.surface_host_generation.load(Ordering::Acquire) != host_generation
            || self.surface_binding_generation.load(Ordering::Acquire) != carrier_generation
        {
            return;
        }
        let mut status = self.surface_status.lock().unwrap();
        if matches!(
            status.stage,
            DshNativeSurfaceStage::Unavailable | DshNativeSurfaceStage::Closed
        ) {
            return;
        }
        let rank = |value| match value {
            DshNativeSurfaceStage::Closed | DshNativeSurfaceStage::Unavailable => 0,
            DshNativeSurfaceStage::CarrierReady => 1,
            DshNativeSurfaceStage::WebviewCreated => 2,
            DshNativeSurfaceStage::ClientReady => 3,
            DshNativeSurfaceStage::SessionOpen => 4,
        };
        // A session closing is a factual downgrade of session state only; it
        // never revokes the official client readiness that renders the UI.
        let downgrade = status.stage == DshNativeSurfaceStage::SessionOpen
            && stage == DshNativeSurfaceStage::ClientReady;
        if !downgrade && rank(stage) <= rank(status.stage) {
            return;
        }
        status.stage = stage;
        status.ready = matches!(
            stage,
            DshNativeSurfaceStage::ClientReady | DshNativeSurfaceStage::SessionOpen
        );
        status.message = match stage {
            DshNativeSurfaceStage::CarrierReady => "官方 DeepSeek Harness 载体已连接。",
            DshNativeSurfaceStage::WebviewCreated => "官方 DeepSeek Harness 界面已创建。",
            DshNativeSurfaceStage::ClientReady => "官方 DeepSeek Harness 客户端已就绪。",
            DshNativeSurfaceStage::SessionOpen => "官方 DeepSeek Harness 会话已打开。",
            DshNativeSurfaceStage::Closed => "官方 DeepSeek Harness 界面已关闭。",
            DshNativeSurfaceStage::Unavailable => "官方 DeepSeek Harness 界面暂不可用。",
        };
    }

    pub(crate) fn close_native_surface(&self) -> Result<DshNativeSurfaceStatusView, String> {
        let _operation = self.operation.lock().unwrap();
        #[cfg(test)]
        let injected_failure = self.surface_control_failure.swap(false, Ordering::AcqRel);
        #[cfg(not(test))]
        let injected_failure = false;
        let settlement = if injected_failure {
            Err(())
        } else {
            let mut host_guard = self.host.lock().unwrap();
            if let Some(host) = host_guard.as_mut() {
                host.close_surface().map(|_| true)
            } else {
                Ok(false)
            }
        };
        let host_alive = match settlement {
            Ok(host_alive) => host_alive,
            Err(()) => return self.fail_surface_generation("dsh-native-surface-close-unsettled"),
        };
        self.surface_host_generation.store(0, Ordering::Release);
        self.remote_authority_active.store(false, Ordering::Release);
        self.surface_port.store(0, Ordering::Release);
        self.surface_binding_generation.store(0, Ordering::Release);
        let status = DshNativeSurfaceStatusView {
            ready: false,
            stage: DshNativeSurfaceStage::Closed,
            cold_jit_ms: None,
            carrier_bind_ms: None,
            outer_host_rss_mb: None,
            lucky_ray_process_handle_count: current_process_handle_count(),
            owned_direct_process_count: if host_alive { 2 } else { 0 },
            message: "官方 DeepSeek Harness 界面已关闭。",
        };
        *self.surface_status.lock().unwrap() = status.clone();
        Ok(status)
    }

    pub(crate) fn sync_lightseek_model(&self) -> Result<DshModelSyncProjection, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "dsh-host-action-busy".to_owned())?;
        if !matches!(
            self.surface_status().stage,
            DshNativeSurfaceStage::ClientReady | DshNativeSurfaceStage::SessionOpen
        ) {
            return Err("lightseek-model-sync-not-ready".to_owned());
        }
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        let result = {
            let mut host = self.host.lock().unwrap();
            match host.as_mut() {
                Some(host) => {
                    if host.validate_host() {
                        host.sync_lightseek_model()
                    } else {
                        Err(())
                    }
                }
                _ => Err(()),
            }
        };
        #[cfg(not(all(windows, feature = "browser-host-runtime")))]
        let result: Result<DshModelSyncProjection, ()> = Err(());
        result.or_else(|_| self.fail_surface_generation("lightseek-model-sync-unavailable"))
    }

    pub(crate) fn stage_open_intent(&self, intent: DshOpenIntent) -> Result<(), String> {
        let payload = intent.encode()?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "dsh-host-action-busy".to_owned())?;
        if !matches!(
            self.surface_status().stage,
            DshNativeSurfaceStage::ClientReady | DshNativeSurfaceStage::SessionOpen
        ) {
            return Err("dsh-open-intent-not-ready".to_owned());
        }
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        let result = {
            let mut host = self.host.lock().unwrap();
            match host.as_mut() {
                Some(host) => {
                    if host.validate_host() {
                        host.stage_open_intent(&payload)
                    } else {
                        Err(())
                    }
                }
                _ => Err(()),
            }
        };
        #[cfg(not(all(windows, feature = "browser-host-runtime")))]
        let result: Result<(), ()> = Err(());
        result.or_else(|_| self.fail_surface_generation("dsh-open-intent-unavailable"))
    }

    /// Join the existing official carrier. Never open a window, start a second
    /// host, or hold the host operation mutex for the duration of a model run.
    pub(crate) fn canvas_agent_dispatch(&self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        let payload = encode_canvas_agent_request(&request)?;
        if self.shutting_down.load(Ordering::Acquire) { return Err("canvas-agent-unavailable".to_owned()); }
        let _operation = self.operation.try_lock().map_err(|_| "canvas-agent-transport-busy".to_owned())?;
        if self.shutting_down.load(Ordering::Acquire) { return Err("canvas-agent-unavailable".to_owned()); }
        if !matches!(self.surface_status().stage,
            DshNativeSurfaceStage::ClientReady | DshNativeSurfaceStage::SessionOpen)
        { return Err("canvas-agent-not-ready".to_owned()); }
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        {
            let canvas_id = request.get("canvasId").and_then(serde_json::Value::as_str)
                .ok_or_else(|| "canvas-agent-invalid-request".to_owned())?;
            let mut host = self.host.lock().map_err(|_| "canvas-agent-unavailable".to_owned())?;
            let host = host.as_mut().filter(|host| host.is_running())
                .ok_or_else(|| "canvas-agent-unavailable".to_owned())?;
            // Application errors are returned here, never escalated through
            // fail_surface_generation (which would kill unrelated LSH work).
            host.canvas_agent_dispatch(&payload, canvas_id)
        }
        #[cfg(not(all(windows, feature = "browser-host-runtime")))]
        { let _ = payload; Err("canvas-agent-unavailable".to_owned()) }
    }

    pub(crate) fn open_intent_status(&self, intent_id: &str) -> Result<String, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        let _operation = self.operation.try_lock().map_err(|_| "dsh-host-action-busy".to_owned())?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        let result = {
            let mut host = self.host.lock().unwrap();
            match host.as_mut() {
                Some(host) => {
                    if host.validate_host() {
                        host.open_intent_status(intent_id)
                    } else {
                        Err(())
                    }
                }
                _ => Err(()),
            }
        };
        #[cfg(not(all(windows, feature = "browser-host-runtime")))]
        let result: Result<String, ()> = Err(());
        result.or_else(|_| self.fail_surface_generation("dsh-open-intent-status-unavailable"))
    }

    fn fail_surface_generation<T>(&self, error: &str) -> Result<T, String> {
        self.terminate_current();
        self.publish(DshHostStage::Unavailable, 0, None);
        Err(error.to_owned())
    }

    /// Surface-layer failure: the DSH web boot failed in a verifiable way,
    /// but the wrapper host tree is alive and can still serve compatibility
    /// recovery actions. Publish the unavailable surface WITHOUT tearing the
    /// host down, so the outer recovery panel keeps its data path.
    fn fail_surface_or_generation<T>(&self, error: &str) -> Result<T, String> {
        // An unconfirmed descendant tree is beyond the wrapper's reach: the
        // only correct reclamation is to terminate THIS whole host job (the
        // OS-attached job covers every descendant) and rebuild the control
        // channel on the next probe/open. Never silently retry in place.
        if error.contains("tree-unconfirmed") {
            return self.fail_surface_generation(error);
        }
        if error.starts_with("dsh-surface-failed:") {
            self.remote_authority_active.store(false, Ordering::Release);
        self.surface_port.store(0, Ordering::Release);
        self.surface_binding_generation.store(0, Ordering::Release);
            self.surface_compat_mode.store(false, Ordering::Release);
            let mut status = self.surface_status.lock().unwrap();
            status.ready = false;
            status.stage = DshNativeSurfaceStage::Unavailable;
            status.message = "AI 助手界面启动失败；可从恢复面板检查扩展、以兼容模式重启或重试。";
            return Err(error.to_owned());
        }
        self.fail_surface_generation(error)
    }

    pub(crate) fn invalidate_native_surface_generation(&self, error: &str) -> String {
        let _operation = self.operation.lock().unwrap();
        self.fail_surface_generation::<()>(error).unwrap_err()
    }

    pub(crate) fn reclaim_failed_native_surface_with(
        &self,
        retire_native: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        // Share lifecycle admission with open/restart: an old renderer status
        // must never retire a healthy replacement while that action settles.
        let _operation = self.operation.try_lock()
            .map_err(|_| "dsh-host-action-busy".to_owned())?;
        if self.surface_status().stage != DshNativeSurfaceStage::Unavailable {
            return Ok(());
        }
        retire_native()
    }

    /// Watchdog-reported surface loss (post-ready freeze): the surface is
    /// down even though the open call succeeded earlier. Surface status goes
    /// unavailable with the verifiable reason; the host tree itself stays
    /// runnable so the outer recovery UI can still drive compat actions.
    pub(crate) fn publish_surface_failure_for(&self, host_generation: u64, reason: &str) {
        if host_generation == 0
            || self.surface_host_generation.load(Ordering::Acquire) != host_generation
        {
            return;
        }
        let mut status = self.surface_status.lock().unwrap();
        status.ready = false;
        status.stage = DshNativeSurfaceStage::Unavailable;
        status.message = "AI 助手界面启动后失去响应，可从恢复面板以兼容模式重启或重新检查扩展。";
    }

    fn plugin_compat_request(
        self: &Arc<Self>,
        kind: &str,
        payload: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "dsh-host-action-busy".to_owned())?;
        self.plugin_compat_request_locked(kind, payload)
    }

    fn plugin_compat_request_locked(
        self: &Arc<Self>,
        kind: &str,
        payload: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        {
            let mut host_guard = self.host.lock().unwrap();
            if let Some(host) = host_guard.as_mut() {
                if host.validate_host() {
                    return host.compat_request(kind, payload);
                }
            }
        }
        // The control channel is gone (whole-tree recovery tore it down) or
        // wedged. Recovery requests PREPARE a trusted host first: confirm the
        // previous teardown settled, rebuild through the normal admission and
        // probe path, then run the request on the fresh channel. The plain
        // broken composition never spawns during this preparation.
        self.prepare_host_for_recovery_locked()?;
        let mut host_guard = self.host.lock().unwrap();
        let host = host_guard
            .as_mut()
            .ok_or_else(|| "dsh-host-unavailable".to_owned())?;
        if !host.validate_host() {
            return Err("dsh-host-unavailable".to_owned());
        }
        host.compat_request(kind, payload)
    }

    /// Bounded, single-flight preparation of a trusted control channel after
    /// a whole-tree teardown: consume the cleanup result (a failed teardown
    /// refuses the rebuild — never spawn a second tree over an unaccounted
    /// one), rebuild via the existing retry/probe authority, and leave the
    /// recovery intent (state + guard files) untouched.
    fn prepare_host_for_recovery_locked(self: &Arc<Self>) -> Result<(), String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        // A stale/invalid host is still owned by this service. Reclaim it
        // while the operation lock is held, consume the real Job verdict,
        // and only then make ExplicitRetry admissible.
        if self.host.lock().unwrap().is_some() {
            let settled = self.terminate_current_checked();
            self.publish(DshHostStage::Unavailable, 0, None);
            if !settled {
                return Err("dsh-host-cleanup-unconfirmed".to_owned());
            }
        }
        // Confirm the previous teardown settled before rebuilding.
        if !self.cleanup_settled() {
            return Err("dsh-host-cleanup-unconfirmed".to_owned());
        }
        if self.status().stage != DshHostStage::Unavailable {
            // A dead host can be observed before its monitor publishes the
            // terminal stage. We already own the operation lock, so publish
            // that transition here instead of racing the monitor.
            self.publish(DshHostStage::Unavailable, 0, None);
        }
        let descriptor = self
            .descriptor
            .get()
            .ok_or_else(|| "dsh-host-unavailable".to_owned())?;
        // Recovery only needs the authenticated wrapper control plane. A full
        // probe here would start the same still-unquarantined plugin
        // composition that just failed, making the compat action unreachable.
        // Keep the public stage unavailable so the renderer's subsequent
        // explicit retry performs the ordinary guarded probe.
        if self
            .launch_authenticated_host(descriptor, 0, false)
            .is_err()
        {
            let _ = self.terminate_current_checked();
            self.publish(DshHostStage::Unavailable, 0, None);
            return Err("dsh-host-unavailable".to_owned());
        }
        self.publish(DshHostStage::Unavailable, 0, None);
        Ok(())
    }

    /// Whether the last teardown verifiably settled: a live host/job means
    /// nothing is pending; both gone means the terminate_and_wait confirm
    /// path already ran (fail_surface_generation consumed its result before
    /// publishing Unavailable — an unconfirmed teardown keeps the job handle
    /// out of "settled" via the generation monitor).
    fn cleanup_settled(&self) -> bool {
        let host_alive = self
            .host
            .lock()
            .unwrap()
            .as_ref()
            .map(|host| host.is_running())
            .unwrap_or(false);
        if host_alive {
            return true;
        }
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        {
            if let Some(job) = self.active_job.lock().unwrap().as_ref() {
                // A still-present job is settled only when it verifiably
                // drained.
                return job.settled();
            }
        }
        // Both handles are gone: the teardown's own recorded verdict is the
        // authority (a dropped handle alone proves nothing about drain).
        self.last_teardown_settled.load(Ordering::Acquire)
    }

    pub(crate) fn plugin_compat_status(self: &Arc<Self>) -> Result<serde_json::Value, String> {
        let mut status = self.plugin_compat_request("compat-status", None)?;
        if let Some(object) = status.as_object_mut() {
            object.insert(
                "compatMode".to_owned(),
                serde_json::json!(self.surface_compat_mode.load(Ordering::Acquire)),
            );
        }
        Ok(status)
    }

    pub(crate) fn plugin_compat_check(
        self: &Arc<Self>,
        baseline: bool,
    ) -> Result<serde_json::Value, String> {
        self.plugin_compat_request(
            "compat-check",
            Some(&serde_json::json!({ "baseline": baseline })),
        )
    }

    /// UI-driven quarantine actions. Free-form strings never reach the frame:
    /// kinds, entry ids and reasons are validated here first.
    pub(crate) fn plugin_compat_apply(
        self: &Arc<Self>,
        action: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let object = action
            .as_object()
            .ok_or_else(|| "dsh-compat-action-invalid".to_owned())?;
        let kind = object
            .get("kind")
            .and_then(|value| value.as_str())
            .filter(|value| {
                ["normal", "compatible", "auto", "quarantine", "restore"].contains(value)
            })
            .ok_or_else(|| "dsh-compat-action-invalid".to_owned())?;
        let mut validated = serde_json::Map::new();
        validated.insert("kind".to_owned(), serde_json::json!(kind));
        if kind == "quarantine" {
            let entry_ids = object
                .get("entryIds")
                .and_then(|value| value.as_array())
                .ok_or_else(|| "dsh-compat-action-invalid".to_owned())?;
            let mut clean = Vec::new();
            for entry in entry_ids.iter().take(32) {
                let id = entry
                    .as_str()
                    .filter(|id| {
                        id.len() <= 128
                            && id
                                .chars()
                                .next()
                                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                            && id
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
                    })
                    .ok_or_else(|| "dsh-compat-action-invalid".to_owned())?;
                clean.push(serde_json::json!(id));
            }
            validated.insert("entryIds".to_owned(), serde_json::json!(clean));
            if let Some(reason) = object.get("reason").and_then(|value| value.as_str()) {
                if reason.len() <= 128 && reason.chars().all(|c| c.is_ascii_graphic() || c == ' ') {
                    validated.insert("reason".to_owned(), serde_json::json!(reason));
                }
            }
        }
        if kind == "restore" {
            let id = object
                .get("entryId")
                .and_then(|value| value.as_str())
                .filter(|id| {
                    id.len() <= 128
                        && id
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                        && id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
                })
                .ok_or_else(|| "dsh-compat-action-invalid".to_owned())?;
            validated.insert("entryId".to_owned(), serde_json::json!(id));
        }
        self.plugin_compat_request("compat-apply", Some(&serde_json::Value::Object(validated)))
    }

    #[cfg(test)]
    pub(crate) fn inject_surface_control_failure_for_test(&self) {
        self.surface_control_failure.store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn inject_remote_drop_failure_for_test(&self) {
        self.remote_drop_failure.store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn inject_remote_authority_failure_for_test(&self) {
        self.remote_authority_failure.store(true, Ordering::Release);
    }

    fn publish(&self, stage: DshHostStage, retry_attempt: u8, duration_ms: Option<u64>) {
        let (latest_probe_passed, host_reusable, message) = match stage {
            DshHostStage::Initializing => (false, false, "正在核验 DeepSeek Harness 运行资源；尚未就绪。"),
            DshHostStage::ProbeCompleted => (
                true,
                true,
                "最近一次 DeepSeek Harness 诊断已通过；再次诊断会新建运行会话。",
            ),
            DshHostStage::BundledVerified => {
                (false, false, "DeepSeek Harness 已验证，可进行诊断。")
            }
            DshHostStage::Starting => (false, false, "正在校验并启动 DeepSeek Harness。"),
            DshHostStage::ProcessAlive => {
                (false, false, "DeepSeek Harness 进程已启动，正在验证协议。")
            }
            DshHostStage::ProtocolAuthenticated => (false, false, "私有诊断通道已验证。"),
            DshHostStage::SessionReady => (false, false, "诊断会话已就绪。"),
            DshHostStage::ExactTurnAccepted => (false, false, "诊断任务已由运行时接受。"),
            DshHostStage::RestartWaiting => {
                (false, false, "DeepSeek Harness 已退出，正在安全重试。")
            }
            DshHostStage::ShuttingDown => (false, false, "正在关闭 DeepSeek Harness。"),
            DshHostStage::Unavailable => (false, false, "DeepSeek Harness 诊断暂不可用。"),
        };
        *self.status.lock().unwrap() = DshHostStatusView {
            stage,
            latest_probe_passed,
            host_reusable,
            can_probe: self.descriptor.get().is_some()
                && matches!(
                    stage,
                    DshHostStage::BundledVerified | DshHostStage::ProbeCompleted
                ),
            can_retry: self.descriptor.get().is_some() && stage == DshHostStage::Unavailable,
            shutting_down: stage == DshHostStage::ShuttingDown,
            retry_attempt,
            duration_ms,
            message,
        };
    }

    pub(crate) fn probe(
        self: &Arc<Self>,
        action: DshHostAction,
    ) -> Result<DshHostStatusView, String> {
        self.wait_initialized();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "dsh-host-action-busy".to_owned())?;
        self.probe_locked(action)
    }

    fn probe_locked(self: &Arc<Self>, action: DshHostAction) -> Result<DshHostStatusView, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("dsh-host-shutting-down".to_owned());
        }
        let stage = self.status().stage;
        validate_action(stage, action, self.descriptor.get().is_some())?;

        if action == DshHostAction::Probe && stage == DshHostStage::ProbeCompleted {
            let mut current = self.host.lock().unwrap().take();
            if let Some(mut host) = current.take() {
                if host.validate_host() {
                    let descriptor = self
                        .descriptor
                        .get()
                        .ok_or_else(|| "dsh-host-unavailable".to_owned())?;
                    let use_lease = match self.acquire_runtime_use(descriptor) {
                        Ok(lease) => lease,
                        Err(LaunchFailure::RuntimeSealInvalid) => {
                            host.shutdown();
                            self.terminate_current();
                            self.publish(DshHostStage::Unavailable, 0, None);
                            return Err("dsh-host-unavailable".to_owned());
                        }
                        Err(LaunchFailure::ShutdownCancelled) => {
                            host.shutdown();
                            self.terminate_current();
                            return Err("dsh-host-shutting-down".to_owned());
                        }
                        Err(LaunchFailure::HostFailed) => {
                            host.shutdown();
                            self.terminate_current();
                            self.publish(DshHostStage::Unavailable, 0, None);
                            return Err("dsh-host-unavailable".to_owned());
                        }
                    };
                    if self.shutting_down.load(Ordering::Acquire) {
                        drop(use_lease);
                        host.shutdown();
                        self.terminate_current();
                        return Err("dsh-host-shutting-down".to_owned());
                    }
                    let started = Instant::now();
                    self.publish(DshHostStage::Starting, 0, None);
                    let probe_result = self.run_probe_on_host(&mut host, 0, started);
                    drop(use_lease);
                    match probe_result {
                        Ok(status) => {
                            *self.host.lock().unwrap() = Some(host);
                            return Ok(status);
                        }
                        Err(()) => {
                            host.shutdown();
                        }
                    }
                } else {
                    host.shutdown();
                }
            }
        }
        if !self.terminate_current_checked() {
            self.publish(DshHostStage::Unavailable, 0, None);
            return Err("dsh-host-cleanup-unconfirmed".to_owned());
        }
        let descriptor = self
            .descriptor
            .get()
            .ok_or_else(|| "dsh-host-unavailable".to_owned())?;
        let attempts = RESTART_BACKOFF.len() + 1;
        for attempt in 0..attempts {
            if self.shutting_down.load(Ordering::Acquire) {
                return Err("dsh-host-shutting-down".to_owned());
            }
            if attempt > 0 {
                self.publish(DshHostStage::RestartWaiting, attempt as u8, None);
                thread::sleep(RESTART_BACKOFF[attempt - 1]);
                if self.shutting_down.load(Ordering::Acquire) {
                    return Err("dsh-host-shutting-down".to_owned());
                }
            }
            match self.launch_and_probe(descriptor, attempt as u8) {
                Ok(status) => return Ok(status),
                Err(LaunchFailure::RuntimeSealInvalid) => {
                    self.terminate_current();
                    self.publish(DshHostStage::Unavailable, attempt as u8, None);
                    return Err("dsh-host-unavailable".to_owned());
                }
                Err(LaunchFailure::ShutdownCancelled) => {
                    self.terminate_current();
                    return Err("dsh-host-shutting-down".to_owned());
                }
                Err(LaunchFailure::HostFailed) => {
                    if !self.terminate_current_checked() {
                        self.publish(DshHostStage::Unavailable, attempt as u8, None);
                        return Err("dsh-host-cleanup-unconfirmed".to_owned());
                    }
                }
            }
        }
        self.publish(DshHostStage::Unavailable, (attempts - 1) as u8, None);
        Err("dsh-host-unavailable".to_owned())
    }

    fn acquire_runtime_use(
        &self,
        descriptor: &RuntimeDescriptor,
    ) -> Result<RuntimeUseLease, LaunchFailure> {
        #[cfg(test)]
        let progress_hook = self.acquisition_progress_hook.lock().unwrap().clone();
        #[cfg(test)]
        let progress = |phase| {
            if let Some(hook) = progress_hook.as_ref() {
                hook(phase);
            }
        };
        #[cfg(test)]
        let control = crate::dsh_runtime_seal::RuntimeSealControl::with_observer(
            &self.shutting_down,
            &progress,
        );
        #[cfg(not(test))]
        let control = crate::dsh_runtime_seal::RuntimeSealControl::new(&self.shutting_down);
        let lease = descriptor
            .acquire_use_lease(&control)
            .map_err(|error| match error {
                crate::dsh_runtime_seal::RuntimeSealError::Cancelled => {
                    LaunchFailure::ShutdownCancelled
                }
                crate::dsh_runtime_seal::RuntimeSealError::Invalid => {
                    LaunchFailure::RuntimeSealInvalid
                }
            })?;
        #[cfg(test)]
        if let Some(hook) = self.pre_use_hook.lock().unwrap().take() {
            hook(&descriptor.root).map_err(|_| LaunchFailure::RuntimeSealInvalid)?;
        }
        Ok(lease)
    }

    fn reserve_generation(&self) -> Result<u64, LaunchFailure> {
        // This is the sole shutdown-vs-start admission linearization point.
        // The long runtime seal and process creation deliberately stay outside
        // this gate; `operation` owns the reserved-generation -> Job handoff.
        let _admission = self.start_admission.lock().unwrap();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(LaunchFailure::ShutdownCancelled);
        }
        // Every launch path shares this admission check. `operation` keeps
        // ownership stable until the new Job is installed; no retained host
        // or unconfirmed old tree may be overwritten by a new generation.
        let has_host = self.host.lock().unwrap().is_some();
        if has_host || !self.cleanup_settled() {
            return Err(LaunchFailure::HostFailed);
        }
        Ok(self.generation.fetch_add(1, Ordering::AcqRel) + 1)
    }

    /// The exact Host producer sequence a fresh/background probe consumes,
    /// each stage exactly once: session-ready -> turn-accepted, followed by
    /// the single probe-completed result. Waiting for any stage twice would
    /// consume the next producer frame and block ProbeCompleted.
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    const PROBE_STAGE_SEQUENCE: &[(&str, Duration)] = &[
        ("session-ready", PROBE_TIMEOUT),
        ("turn-accepted", Duration::from_secs(5)),
    ];

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    fn run_probe_on_host(
        &self,
        host: &mut HostHandle,
        retry_attempt: u8,
        started: Instant,
    ) -> Result<DshHostStatusView, ()> {
        let request_id = host.begin_native_probe()?;
        for (stage, timeout) in Self::PROBE_STAGE_SEQUENCE {
            host.expect_probe_stage(&request_id, stage, *timeout)?;
            self.publish(
                match *stage {
                    "session-ready" => DshHostStage::SessionReady,
                    _ => DshHostStage::ExactTurnAccepted,
                },
                retry_attempt,
                None,
            );
        }
        host.expect_probe_completed(&request_id)?;
        let duration = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(());
        }
        self.publish(DshHostStage::ProbeCompleted, retry_attempt, Some(duration));
        Ok(self.status())
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    fn launch_and_probe(
        self: &Arc<Self>,
        descriptor: &RuntimeDescriptor,
        retry_attempt: u8,
    ) -> Result<DshHostStatusView, LaunchFailure> {
        self.launch_authenticated_host(descriptor, retry_attempt, true)
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    fn launch_authenticated_host(
        self: &Arc<Self>,
        descriptor: &RuntimeDescriptor,
        retry_attempt: u8,
        run_probe: bool,
    ) -> Result<DshHostStatusView, LaunchFailure> {
        let jit_started = Instant::now();
        // Fixed host assets and the retained critical runtime identity are
        // checked on a worker. Publish Starting before admission so observers
        // can distinguish an in-progress launch from an unavailable host.
        self.publish(DshHostStage::Starting, retry_attempt, None);
        let use_lease = self.acquire_runtime_use(descriptor)?;
        let jit_ms = jit_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        #[cfg(test)]
        if let Some(hook) = self.pre_admission_hook.lock().unwrap().take() {
            hook();
        }
        let generation = self.reserve_generation()?;
        #[cfg(test)]
        if let Some(hook) = self.post_admission_hook.lock().unwrap().take() {
            hook(generation);
        }
        let started = Instant::now();
        let script_name = descriptor
            .host_script
            .file_name()
            .ok_or(LaunchFailure::HostFailed)?
            .to_os_string();
        let environment = minimal_environment(
            &descriptor.root,
            &descriptor.state_root,
            &descriptor.surface_state_root,
            &descriptor.surface_patch,
        )
        .map_err(|_| LaunchFailure::HostFailed)?;
        #[cfg(test)]
        self.spawn_attempts.fetch_add(1, Ordering::AcqRel);
        let node_path = descriptor.root.join("node").join("node.exe");
        let spawned = crate::owned_process::spawn_in_owned_job(
            &node_path,
            &[script_name],
            descriptor
                .host_script
                .parent()
                .ok_or(LaunchFailure::HostFailed)?,
            environment,
            false,
        )
        .map_err(|_| LaunchFailure::HostFailed)?;
        let process = Arc::new(spawned.process);
        let job = Arc::new(spawned.job);
        *self.active_job.lock().unwrap() = Some(job.clone());
        if self.shutting_down.load(Ordering::Acquire) {
            job.terminate();
            process.terminate();
            return Err(LaunchFailure::HostFailed);
        }
        let mut challenge = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut challenge);
        let parent = Arc::new(Mutex::new(ParentChannel {
            stdin: spawned.stdin,
            challenge,
            generation,
            outbound_seq: 0,
        }));
        let (frames, stdout_join) = strict_line_reader(
            spawned.stdout,
            challenge,
            generation,
            Arc::downgrade(self),
            parent.clone(),
        );
        let stderr_join = stderr_drain(spawned.stderr);
        let mut host = HostHandle {
            process: process.clone(),
            job,
            parent,
            frames,
            stdout_join: Some(stdout_join),
            stderr_join: Some(stderr_join),
            generation,
            probe_index: 0,
            surface_index: 0,
            model_sync_index: 0,
            open_intent_index: 0,
            remote_index: 0,
            canvas_agent_index: 0,
            expired_canvas_requests: ExpiredCanvasRequests::default(),
            surface_binding_generation: 0,
        };
        self.publish(DshHostStage::ProcessAlive, retry_attempt, None);
        let bootstrap = serde_json::json!({
            "type": "bootstrap", "protocol": PROTOCOL, "generation": generation,
            "challenge": challenge_hex(&challenge)
        });
        let mut encoded = serde_json::to_vec(&bootstrap).map_err(|_| LaunchFailure::HostFailed)?;
        encoded.push(b'\n');
        {
            let mut parent = host.parent.lock().map_err(|_| LaunchFailure::HostFailed)?;
            parent
                .stdin
                .write_all(&encoded)
                .map_err(|_| LaunchFailure::HostFailed)?;
            parent
                .stdin
                .flush()
                .map_err(|_| LaunchFailure::HostFailed)?;
        }
        let hello = host
            .read(Duration::from_secs(5))
            .map_err(|_| LaunchFailure::HostFailed)?;
        if hello.kind != "hello" || hello.stage.as_deref() != Some("protocol-authenticated") {
            return Err(LaunchFailure::HostFailed);
        }
        self.publish(DshHostStage::ProtocolAuthenticated, retry_attempt, None);
        let status = if run_probe {
            self.run_probe_on_host(&mut host, retry_attempt, started)
                .map_err(|_| LaunchFailure::HostFailed)?
        } else {
            self.status()
        };
        *self.surface_lease.lock().unwrap() = Some(use_lease);
        *self.surface_preheat_ms.lock().unwrap() = Some(jit_ms);
        *self.host.lock().unwrap() = Some(host);
        self.monitor_generation(generation, process, run_probe);
        Ok(status)
    }

    #[cfg(not(all(windows, feature = "browser-host-runtime")))]
    fn launch_and_probe(
        self: &Arc<Self>,
        _descriptor: &RuntimeDescriptor,
        _retry_attempt: u8,
    ) -> Result<DshHostStatusView, LaunchFailure> {
        Err(LaunchFailure::HostFailed)
    }

    #[cfg(not(all(windows, feature = "browser-host-runtime")))]
    fn launch_authenticated_host(
        self: &Arc<Self>,
        _descriptor: &RuntimeDescriptor,
        _retry_attempt: u8,
        _run_probe: bool,
    ) -> Result<DshHostStatusView, LaunchFailure> {
        Err(LaunchFailure::HostFailed)
    }

    fn terminate_current_checked(&self) -> bool {
        let settled = self.terminate_current_inner();
        self.last_teardown_settled.store(settled, Ordering::Release);
        settled
    }

    fn terminate_current_inner(&self) -> bool {
        self.surface_host_generation.store(0, Ordering::Release);
        self.remote_authority_active.store(false, Ordering::Release);
        self.surface_port.store(0, Ordering::Release);
        self.surface_binding_generation.store(0, Ordering::Release);
        self.surface_lease.lock().unwrap().take();
        self.surface_preheat_ms.lock().unwrap().take();
        *self.surface_status.lock().unwrap() = DshNativeSurfaceStatusView {
            ready: false,
            stage: DshNativeSurfaceStage::Unavailable,
            cold_jit_ms: None,
            carrier_bind_ms: None,
            outer_host_rss_mb: None,
            lucky_ray_process_handle_count: current_process_handle_count(),
            owned_direct_process_count: 0,
            message: "DeepSeek Harness Host 已重置；旧界面权限已失效。",
        };
        // An empty sweep is not new evidence that a previously unconfirmed
        // tree drained. Only an owned host/Job can supply a fresh verdict.
        let mut settled = self.last_teardown_settled.load(Ordering::Acquire);
        if let Some(host) = self.host.lock().unwrap().take() {
            if let Some(broker) = self.resource_broker.lock().unwrap().as_ref() {
                broker.retire_generation(host.generation());
            }
            settled = host.shutdown();
        }
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        // Take through a helper so the MutexGuard is guaranteed to be dropped
        // before the body may re-lock the slot to retain an unsettled Job.
        if let Some(job) = take_mutex_value(&self.active_job) {
            // The host shutdown path and this service-level sweep share the
            // same Job. The LATER whole-Job verdict is authoritative: the
            // first bounded wait may time out while the second confirms that
            // every descendant drained. Keeping the earlier `false` with
            // boolean-AND permanently blocked direct compatibility recovery
            // even after the owned tree was verifiably empty.
            let job_settled = job.terminate_and_wait(SHUTDOWN_TIMEOUT);
            settled = final_teardown_verdict(settled, Some(job_settled));
            if !job_settled {
                // Preserve the authority handle so a later recovery request
                // can re-check/reclaim the same tree instead of losing proof
                // by dropping the last Job reference.
                *self.active_job.lock().unwrap() = Some(job);
            }
        }
        settled
    }

    fn terminate_current(&self) {
        let _ = self.terminate_current_checked();
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    fn monitor_generation(
        self: &Arc<Self>,
        generation: u64,
        process: Arc<crate::owned_process::OwnedProcess>,
        launched_with_probe: bool,
    ) {
        let service = Arc::downgrade(self);
        thread::spawn(move || {
            let _ = process.wait_for(Duration::from_millis(u32::MAX as u64));
            let Some(service) = service.upgrade() else {
                return;
            };
            if service.shutting_down.load(Ordering::Acquire) {
                return;
            }
            let _operation = service.operation.lock().unwrap();
            if service.shutting_down.load(Ordering::Acquire) {
                return;
            }
            let current = service
                .host
                .lock()
                .unwrap()
                .as_ref()
                .map(|host| host.generation == generation)
                .unwrap_or(false);
            if !current {
                return;
            }
            let teardown_settled = service.terminate_current_checked();
            if !monitor_restart_allowed(teardown_settled, launched_with_probe) {
                // An unconfirmed Job remains retained by terminate_current;
                // a control-only generation intentionally has no autonomous
                // restart path. Both cases require an explicit recovery
                // action before another process tree may be admitted.
                service.publish(DshHostStage::Unavailable, 0, None);
                return;
            }
            let Some(descriptor) = service.descriptor.get() else {
                service.publish(DshHostStage::Unavailable, 0, None);
                return;
            };
            for (index, delay) in RESTART_BACKOFF.iter().enumerate() {
                if service.shutting_down.load(Ordering::Acquire) {
                    return;
                }
                service.publish(DshHostStage::RestartWaiting, (index + 1) as u8, None);
                thread::sleep(*delay);
                if service.shutting_down.load(Ordering::Acquire) {
                    return;
                }
                if service
                    .launch_and_probe(descriptor, (index + 1) as u8)
                    .is_ok()
                {
                    return;
                }
                if !service.terminate_current_checked() {
                    service.publish(DshHostStage::Unavailable, (index + 1) as u8, None);
                    return;
                }
            }
            service.publish(DshHostStage::Unavailable, 3, None);
        });
    }

    pub(crate) fn shutdown(&self) -> bool {
        {
            // Once this transition wins, no later generation can be reserved.
            let _admission = self.start_admission.lock().unwrap();
            self.shutting_down.store(true, Ordering::Release);
            // Publish under the same gate as reservation rollback; a real
            // shutdown must never be mistaken for an abandoned reservation.
            self.publish(DshHostStage::ShuttingDown, 0, None);
        }
        self.initialization_ready.notify_all();
        let first = self.terminate_current_checked();
        let _operation = self.operation.lock().unwrap();
        let second = self.terminate_current_checked();
        self.publish(DshHostStage::Unavailable, 0, None);
        first && second
    }
}

pub(crate) struct DesktopUpdateReservation {
    service: Arc<DshHostService>,
    generation: u64,
    host_generation: Option<u64>,
    stage: DshHostStage,
    warm_id: Option<String>,
    surface_process_id: Option<u32>,
    stopped: bool,
}
fn update_lsh_failure(reason: Option<&str>) -> &'static str {
    match reason {
        Some("update-lsh-task-active") => "update-lsh-task-active",
        Some("update-lsh-schedule-active") => "update-lsh-schedule-active",
        Some("update-lsh-draft-pending") => "update-lsh-draft-pending",
        Some("update-lsh-composition-pending") => "update-lsh-composition-pending",
        Some("update-lsh-save-failed") => "update-lsh-save-failed",
        Some("update-lsh-save-timeout") => "update-lsh-save-timeout",
        Some("update-lsh-client-timeout") => "update-lsh-client-timeout",
        Some("update-lsh-exit-timeout") => "update-lsh-exit-timeout",
        Some("update-lsh-control-timeout") => "update-lsh-control-timeout",
        Some("update-lsh-identity-changed") => "update-lsh-identity-changed",
        Some("update-lsh-content-changed") => "update-lsh-content-changed",
        Some("update-lsh-preparing") => "update-lsh-preparing",
        _ => "update-lsh-state-unavailable",
    }
}
impl DesktopUpdateReservation {
    /// Only the owned handle from this still-reserved diagnostic generation.
    pub(crate) fn reserved_processes(&self) -> Option<(u32, Option<u32>)> {
        let host = self.service.host.lock().ok()?;
        let host = host.as_ref()?;
        (self.service.shutting_down.load(Ordering::Acquire)
            && self.service.generation.load(Ordering::Acquire) == self.generation
            && self.service.status().stage == self.stage
            && (host.diagnostic_only(self.generation) || self.warm_id.is_some()))
            .then(|| host.process_id().map(|pid| (pid, self.surface_process_id))).flatten()
    }

    pub(crate) fn stop_surface(&mut self) -> Result<(), &'static str> {
        let Some(id) = self.warm_id.as_deref() else { return Ok(()); };
        let mut host = self.service.host.lock().map_err(|_| "update-lsh-state-unavailable")?;
        let host = host.as_mut().ok_or("update-lsh-state-unavailable")?;
        if host.generation() != self.generation { return Err("update-lsh-identity-changed"); }
        let result = host.update_request("update-stop", id)?;
        if result.get("stopped").and_then(|v| v.as_bool()) != Some(true)
            || result.get("saved").and_then(|v| v.as_bool()) != Some(true) {
            return Err(update_lsh_failure(result.get("reason").and_then(|v| v.as_str())));
        }
        self.stopped = true;
        eprintln!("[dsh-update-exit] lsh official saved=true stopped=true generation={} exit=0", self.generation);
        Ok(())
    }
}
impl Drop for DesktopUpdateReservation {
    fn drop(&mut self) {
        let service = &self.service;
        let _admission = service.start_admission.lock().unwrap_or_else(|e| e.into_inner());
        // Restore admission only for this unchanged lifecycle, never a real
        // shutdown, failed teardown or replacement generation.
        let same_host = service.host.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
            .map(HostHandle::generation) == self.host_generation;
        if service.generation.load(Ordering::Acquire) == self.generation
            && service.status().stage == self.stage
            && same_host {
            if !self.stopped {
                if let Some(id) = self.warm_id.as_deref() {
                    if let Some(host) = service.host.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                        let _ = host.update_request("update-cancel", id);
                    }
                }
            }
            service.shutting_down.store(false, Ordering::Release);
        }
    }
}

#[cfg(windows)]
fn current_process_handle_count() -> Option<u32> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn GetProcessHandleCount(process: *mut std::ffi::c_void, count: *mut u32) -> i32;
    }
    let mut count = 0u32;
    (unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) } != 0).then_some(count)
}

#[cfg(not(windows))]
fn current_process_handle_count() -> Option<u32> {
    None
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn project_deepseek_search_credential(
    environment: &mut Vec<(OsString, OsString)>,
    value: Option<OsString>,
) {
    if let Some(secret) = value.filter(|secret| !secret.is_empty()) {
        environment.push((OsString::from("DEEPSEEK_API_KEY"), secret));
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn minimal_environment(
    runtime_root: &Path,
    state_root: &Path,
    surface_state_root: &Path,
    surface_patch: &Path,
) -> Result<Vec<(OsString, OsString)>, ()> {
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let system_root_path = PathBuf::from(&system_root);
    let system_path = std::env::join_paths([
        system_root_path
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0"),
        system_root_path.join("System32"),
        system_root_path.clone(),
    ])
    .map_err(|_| ())?;
    let temp = std::env::temp_dir();
    let mut environment = vec![
        (OsString::from("SystemRoot"), system_root.clone()),
        (OsString::from("WINDIR"), system_root),
        (OsString::from("PATH"), system_path),
        (OsString::from("TEMP"), temp.as_os_str().to_os_string()),
        (OsString::from("TMP"), temp.as_os_str().to_os_string()),
        (
            OsString::from("LUCKYRAY_DSH_RUNTIME_ROOT"),
            runtime_root.as_os_str().to_os_string(),
        ),
        (
            OsString::from("LUCKYRAY_DSH_STATE_ROOT"),
            state_root.as_os_str().to_os_string(),
        ),
        (
            OsString::from("LUCKYRAY_DSH_NATIVE_SURFACE_HOME"),
            surface_state_root.as_os_str().to_os_string(),
        ),
        (
            OsString::from("LUCKYRAY_DSH_NATIVE_SURFACE_PATCH"),
            surface_patch.as_os_str().to_os_string(),
        ),
    ];
    project_deepseek_search_credential(&mut environment, std::env::var_os("DEEPSEEK_API_KEY"));
    Ok(environment)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn desktop_update_reservation_is_single_flight_and_failure_restores_admission() {
        let service = DshHostService::new(None, true);
        service.publish(DshHostStage::BundledVerified, 0, None);
        let held_operation = service.operation.lock().unwrap();
        assert!(service.reserve_desktop_update_restart().is_err());
        drop(held_operation);
        let first = service.reserve_desktop_update_restart().expect("cold reservation");
        assert!(service.reserve_desktop_update_restart().is_err());
        assert!(matches!(service.reserve_generation(), Err(LaunchFailure::ShutdownCancelled)));
        drop(first); // installer preparation failed, before service drain
        assert!(!service.shutting_down.load(Ordering::Acquire));
        let retry = service.reserve_desktop_update_restart().expect("retry after failure");
        assert!(service.shutdown());
        drop(retry);
        assert!(service.shutting_down.load(Ordering::Acquire), "real shutdown must not reopen admission");
        assert!(service.reserve_desktop_update_restart().is_err());
    }

    #[test]
    fn desktop_update_reservation_distinguishes_clear_ack_from_configured_origin() {
        let service = DshHostService::new(None, true);
        service.publish(DshHostStage::BundledVerified, 0, None);
        service.remote_authority_active.store(true, Ordering::Release);
        let reservation = service.reserve_desktop_update_restart()
            .expect("a successful clear ACK is not an active remote origin");
        assert!(service.set_remote_surface_authority(Some("phone.example:443".into()), 1).is_err(),
            "authority cannot be added after update admission");
        drop(reservation);
        *service.desired_remote_authority.lock().unwrap() = Some("phone.example:443".into());
        for ack in [false, true] {
            service.remote_authority_active.store(ack, Ordering::Release);
            assert!(service.reserve_desktop_update_restart().is_err(),
                "configured origins remain blocked even if synchronization failed");
        }
    }

    #[test]
    fn desktop_update_reservation_does_not_undo_a_replacement_generation() {
        let service = DshHostService::new(None, true);
        service.publish(DshHostStage::BundledVerified, 0, None);
        let reserved = service.reserve_desktop_update_restart().unwrap();
        service.generation.fetch_add(1, Ordering::AcqRel);
        drop(reserved);
        assert!(service.shutting_down.load(Ordering::Acquire));
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the verified bundled runtime; uses temporary synthetic state only"]
    fn desktop_update_reservation_accepts_only_unused_completed_probe() {
        let root = PathBuf::from(std::env::var_os("DSH_TEST_RUNTIME_ROOT").unwrap());
        let data = tempfile::tempdir().unwrap();
        let service = bundled_service_for_settings_integration(root, data.path());
        assert_eq!(service.probe(DshHostAction::Probe).unwrap().stage, DshHostStage::ProbeCompleted);
        let generation = service.generation.load(Ordering::Acquire);
        let reserved = service.reserve_desktop_update_restart();
        let accepted = reserved.is_ok();
        if accepted {
            assert!(service.reserve_desktop_update_restart().is_err());
            assert!(matches!(service.open_native_surface(), Err(error) if error == "dsh-host-shutting-down"));
            // Also cover an opener which passed its first check before reservation.
            assert!(matches!(service.open_native_surface_locked(), Err(error) if error == "dsh-host-shutting-down"));
        }
        drop(reserved);
        assert!(!service.shutting_down.load(Ordering::Acquire));
        assert_eq!(service.generation.load(Ordering::Acquire), generation);
        assert!(service.host.lock().unwrap().as_ref().unwrap().is_running());
        // Each existing request history independently disqualifies the host.
        for field in 0..4 {
            {
                let mut slot = service.host.lock().unwrap();
                let host = slot.as_mut().unwrap();
                host.surface_index = u64::from(field == 0);
                host.model_sync_index = u64::from(field == 1);
                host.open_intent_index = u64::from(field == 2);
                host.remote_index = u64::from(field == 3);
            }
            assert!(service.reserve_desktop_update_restart().is_err(), "history field {field}");
            assert!(!service.shutting_down.load(Ordering::Acquire));
        }
        assert!(service.shutdown());
        assert!(accepted, "a completed diagnostic-only preload must not block desktop update");
    }

    #[test]
    fn hidden_preload_binding_fails_closed_on_replacement_retirement_and_shutdown() {
        let service = DshHostService::new(None, false);
        assert_eq!(service.native_surface_binding(), None);
        service.surface_host_generation.store(7, Ordering::Release);
        service.surface_binding_generation.store(11, Ordering::Release);
        assert_eq!(service.native_surface_binding(), Some((7, 11)));
        assert!(service.native_surface_binding_matches(7, 11));
        assert!(!service.native_surface_binding_matches(6, 11));
        assert!(!service.native_surface_binding_matches(7, 10));
        service.surface_binding_generation.store(12, Ordering::Release);
        assert!(!service.native_surface_binding_matches(7, 11));
        assert_eq!(service.native_surface_binding(), Some((7, 12)));
        service.surface_host_generation.store(0, Ordering::Release);
        assert_eq!(service.native_surface_binding(), None);
        service.surface_host_generation.store(8, Ordering::Release);
        service.shutting_down.store(true, Ordering::Release);
        assert_eq!(service.native_surface_binding(), None);
        assert!(!service.native_surface_binding_matches(8, 12));
    }

    #[test]
    fn pending_initialization_is_not_reported_as_failed_or_ready() {
        let service = DshHostService::new(None, false);
        assert_eq!(service.status().stage, DshHostStage::Initializing);
        assert!(service.status().can_probe, "readiness may queue behind worker admission");
        assert!(!service.status().latest_probe_passed);
        assert!(!service.status().host_reusable);
        assert!(validate_action(DshHostStage::Initializing, DshHostAction::Probe, false).is_err());
        service.initialization_finished.store(true, Ordering::Release);
        assert_eq!(service.status().stage, DshHostStage::Unavailable);
        assert!(!service.status().can_probe);
        service.shutdown();
    }

    #[test]
    fn queued_initialization_probe_waits_and_rejects_failed_admission() {
        let service = DshHostService::new(None, false);
        let worker = Arc::clone(&service);
        let (sender, receiver) = mpsc::channel();
        let join = thread::spawn(move || sender.send(worker.probe(DshHostAction::Probe)).unwrap());
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err(), "pending admission must not settle as ready or failed");
        assert_eq!(service.status().stage, DshHostStage::Initializing);
        {
            let _gate = service.initialization_gate.lock().unwrap();
            service.initialization_finished.store(true, Ordering::Release);
            service.initialization_ready.notify_all();
        }
        assert_eq!(receiver.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err(), "dsh-host-unavailable");
        join.join().unwrap();
        assert_eq!(service.spawn_attempts.load(Ordering::Acquire), 0);
        assert_eq!(service.status().stage, DshHostStage::Unavailable);
        service.shutdown();
    }

    /// Three fresh outer-host processes over one synthetic identity. Carrier
    /// ready is deliberately not reported as browser/composer readiness.
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "explicit real frozen runtime performance trial; temporary synthetic state only"]
    fn frozen_runtime_startup_phase_baseline() {
        let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug");
        let data = tempfile::tempdir().unwrap();
        for sample in 1..=3 {
            let started = Instant::now();
            let service = DshHostService::production(&resource, data.path());
            let descriptor_ms = started.elapsed().as_millis();
            assert_eq!(service.status().stage, DshHostStage::BundledVerified);
            let started = Instant::now();
            service.probe(DshHostAction::Probe).expect("local fixed-response probe, not a model request");
            let probe_ms = started.elapsed().as_millis();
            let lease_ms = *service.surface_preheat_ms.lock().unwrap();
            let started = Instant::now();
            let (cold, _) = service.open_native_surface().expect("official cold carrier");
            let carrier_ms = started.elapsed().as_millis();
            assert_eq!(cold.stage, DshNativeSurfaceStage::CarrierReady);
            assert!(!cold.ready, "HTTP carrier is not browser/composer readiness");
            let started = Instant::now();
            let check = service.plugin_compat_check(false).expect("production plugin gate");
            assert_eq!(check.get("checked"), Some(&serde_json::json!(true)));
            let plugin_check_ms = started.elapsed().as_millis();
            service.close_native_surface().expect("Level-1 close retains owned host");
            let started = Instant::now();
            let (_, _) = service.open_native_surface().expect("warm carrier binding");
            let warm_ms = started.elapsed().as_millis();
            println!("LSH_PERF {}", serde_json::json!({
                "sample":sample,"runtime":"0.1.7-rc.2","identity":"synthetic-shared",
                "firstProfilePreparation":sample == 1,"descriptorMs":descriptor_ms,
                "runtimeUseLeaseMs":lease_ms,"authenticatedProbeTotalMs":probe_ms,
                "carrierOpenWithPluginGateMs":carrier_ms,"explicitPluginCheckMs":plugin_check_ms,
                "sameProcessRebindMs":warm_ms,"browserComposerMeasured":false,
            }));
            assert!(service.shutdown(), "owned-job shutdown must be confirmed");
            assert!(service.host.lock().unwrap().is_none());
            assert!(service.active_job.lock().unwrap().is_none());
        }
    }

    /// Diagnostic for an already installed, signed development candidate. It
    /// reads the test profile's active marker/runtime but writes only into a
    /// new temporary state directory, never the user's profile or sessions.
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires DSH_TEST_DYNAMIC_APP_DATA and a matching development trust build"]
    fn installed_dynamic_runtime_authenticates_in_isolated_state() {
        use base64::Engine as _;
        let app_data = PathBuf::from(
            std::env::var_os("DSH_TEST_DYNAMIC_APP_DATA").expect("isolated test profile required"),
        );
        let active: serde_json::Value = serde_json::from_slice(
            &std::fs::read(app_data.join("dsh-engine-updates/active.json")).unwrap(),
        ).unwrap();
        let sha = active["artifactSha256"].as_str().unwrap();
        let envelope = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(active["signedEnvelope"].as_str().unwrap()).unwrap();
        // This is diagnostic parsing of an active marker admitted by the
        // earlier test build, not a production update-admission path. The
        // source fingerprint changes when this test is added, so the new test
        // binary cannot re-admit the prior build's signed envelope.
        let signed: serde_json::Value = serde_json::from_slice(&envelope).unwrap();
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(signed["payload"].as_str().unwrap()).unwrap();
        let candidate: crate::dsh_engine_update::Candidate =
            serde_json::from_slice(&payload).unwrap();
        assert_eq!(candidate.artifact_sha256, sha);
        let root = app_data.join("dsh-engine-updates/versions").join(sha);
        let temp = tempfile::tempdir().unwrap();
        let state_root = std::env::var_os("DSH_TEST_DYNAMIC_HEADLESS_STATE")
            .map(PathBuf::from)
            .unwrap_or_else(|| temp.path().join("native-state"));
        let surface_state_root = std::env::var_os("DSH_TEST_DYNAMIC_SURFACE_STATE")
            .map(PathBuf::from)
            .unwrap_or_else(|| temp.path().join("surface-state"));
        assert!(surface_state_root.starts_with(std::env::temp_dir()),
            "dynamic surface fixture must be an isolated temporary clone");
        assert!(state_root.starts_with(std::env::temp_dir()),
            "dynamic headless fixture must be an isolated temporary clone");
        std::fs::create_dir_all(&state_root).unwrap();
        std::fs::create_dir_all(&surface_state_root).unwrap();
        // Match production's resolved-then-normalized state spelling rather
        // than using the caller's already-normal test path by accident.
        let state_root = normalize_windows_verbatim_path(
            &std::fs::canonicalize(&state_root).unwrap(),
        ).unwrap();
        let surface_state_root = normalize_windows_verbatim_path(
            &std::fs::canonicalize(&surface_state_root).unwrap(),
        ).unwrap();
        let host_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dsh-host");
        let started = Instant::now();
        let descriptor = RuntimeDescriptor::from_verified_root_with_candidate(
            root, Some(candidate), true, None,
            host_dir.join("luckyray-dsh-host.mjs"), state_root, surface_state_root,
            [
                host_dir.join("luckyray-dsh-authenticated-webserver/index.mjs"),
                host_dir.join("luckyray-dsh-resource-tools/index.mjs"),
                host_dir.join("luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json"),
                host_dir.join("luckyray-dsh-native-surface.patch.yml"),
                host_dir.join("luckyray-dsh-native-surface-state/package.json"),
                host_dir.join("luckyray-dsh-native-surface-state/client.js"),
                host_dir.join("luckyray-dsh-lightseek-ui/package.json"),
                host_dir.join("luckyray-dsh-lightseek-ui/client.js"),
                host_dir.join("luckyray-dsh-lightseek-ui/lightseek-cosmic-home.webp"),
                host_dir.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs"),
                host_dir.join("luckyray-dsh-authenticated-webserver/package.json"),
                host_dir.join("luckyray-dsh-resource-tools/package.json"),
                host_dir.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs"),
            ],
        ).expect("host descriptor");
        eprintln!("dynamic descriptor ms={}", started.elapsed().as_millis());
        let service = DshHostService::production(temp.path(), temp.path());
        assert!(service.descriptor.set(descriptor).is_ok());
        service.publish(DshHostStage::BundledVerified, 0, None);
        let started = Instant::now();
        let lease = service.acquire_runtime_use(service.descriptor.get().unwrap());
        eprintln!("dynamic lease ms={} outcome={:?}", started.elapsed().as_millis(), lease.as_ref().map(|_| ()));
        drop(lease.expect("critical runtime identity lease"));
        let started = Instant::now();
        let launched = service.launch_authenticated_host(service.descriptor.get().unwrap(), 0, true);
        eprintln!("dynamic host launch ms={} outcome={:?}", started.elapsed().as_millis(), launched.as_ref().map(|s| s.stage));
        launched.expect("authenticated dynamic host launch");
        let started = Instant::now();
        let opened = service.open_native_surface();
        eprintln!("dynamic surface open ms={} outcome={:?}", started.elapsed().as_millis(),
            opened.as_ref().map(|_| ()).map_err(|error| error.split(':').next()));
        opened.expect("dynamic native surface open");
        service.shutdown();
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn stalled_reader_join_is_bounded_and_never_confirms_shutdown() {
        let (release, held) = mpsc::channel::<()>();
        let join = thread::spawn(move || { let _ = held.recv(); });
        let started = Instant::now();
        assert!(!bounded_reader_join(join));
        assert!(started.elapsed() < Duration::from_secs(3));
        let _ = release.send(());
    }

    #[test]
    fn later_whole_job_teardown_verdict_is_authoritative() {
        assert!(final_teardown_verdict(false, Some(true)));
        assert!(!final_teardown_verdict(true, Some(false)));
        assert!(!final_teardown_verdict(false, None));
        assert!(final_teardown_verdict(true, None));
    }

    #[test]
    fn monitor_restart_requires_settled_teardown_and_a_probe_generation() {
        assert!(monitor_restart_allowed(true, true));
        assert!(!monitor_restart_allowed(false, true));
        assert!(!monitor_restart_allowed(true, false));
        assert!(!monitor_restart_allowed(false, false));
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn taking_mutex_value_releases_guard_before_reinsert() {
        let slot = Mutex::new(Some(7_u8));
        let value = take_mutex_value(&slot).expect("fixture should be present");

        *slot.lock().unwrap() = Some(value);

        assert_eq!(*slot.lock().unwrap(), Some(7));
    }


    /// Crate-visible wrapper so integration tests in other modules (e.g. the
    /// companion gateway full-chain test) can build a REAL runtime-backed
    /// service from the same verified fixtures.
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    pub(crate) fn real_service_for_integration(host_script: PathBuf) -> Arc<DshHostService> {
        real_service(host_script)
    }

    /// Ephemeral signed-data proof only. Uses the production descriptor,
    /// whole-closure leases, local probe and owned host, without a trust-root
    /// override or bundled-baseline impersonation.
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    pub(crate) fn qualified_service_for_integration(root: PathBuf, candidate: crate::dsh_engine_update::Candidate,
        app_data: &Path) -> Arc<DshHostService> {
        integration_service_with_store(root, Some(candidate), app_data, None)
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    pub(crate) fn bundled_service_for_settings_integration(root: PathBuf, app_data: &Path) -> Arc<DshHostService> {
        assert!(app_data.starts_with(std::env::temp_dir()));
        let store = Arc::new(crate::dsh_engine_update::UpdateStore::open(app_data).unwrap());
        integration_service_with_store(root, None, app_data, Some(store))
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    fn integration_service_with_store(root: PathBuf, candidate: Option<crate::dsh_engine_update::Candidate>,
        app_data: &Path, store: Option<Arc<crate::dsh_engine_update::UpdateStore>>) -> Arc<DshHostService> {
        assert!(app_data.starts_with(std::env::temp_dir()));
        let (state, surface) = prepare_dsh_state_roots(app_data).unwrap();
        let host_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dsh-host");
        let descriptor = RuntimeDescriptor::from_verified_root_with_candidate(root, candidate, false, store,
            host_dir.join("luckyray-dsh-host.mjs"), state, surface, [
                host_dir.join("luckyray-dsh-authenticated-webserver/index.mjs"),
                host_dir.join("luckyray-dsh-resource-tools/index.mjs"),
                host_dir.join("luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json"),
                host_dir.join("luckyray-dsh-native-surface.patch.yml"),
                host_dir.join("luckyray-dsh-native-surface-state/package.json"),
                host_dir.join("luckyray-dsh-native-surface-state/client.js"),
                host_dir.join("luckyray-dsh-lightseek-ui/package.json"),
                host_dir.join("luckyray-dsh-lightseek-ui/client.js"),
                host_dir.join("luckyray-dsh-lightseek-ui/lightseek-cosmic-home.webp"),
                host_dir.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs"),
                host_dir.join("luckyray-dsh-authenticated-webserver/package.json"),
                host_dir.join("luckyray-dsh-resource-tools/package.json"),
                host_dir.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs"),
            ]).unwrap();
        service_from_test_descriptor(descriptor)
    }

    /// Test-only direct launch mirroring launch_admission_retains: brings the
    /// runtime to the state open_native_surface requires.
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    pub(crate) fn launch_authenticated_host_for_test(service: &Arc<DshHostService>) {
        let _operation = service.operation.lock().unwrap();
        service
            .launch_authenticated_host(service.descriptor.get().unwrap(), 0, false)
            .expect("launch authenticated host");
        // publish ProbeCompleted the way a successful probe would
        service.publish(crate::dsh_host::DshHostStage::ProbeCompleted, 1, None);
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    fn real_service(host_script: PathBuf) -> Arc<DshHostService> {
        let root = PathBuf::from(
            std::env::var_os("DSH_TEST_RUNTIME_ROOT")
                .expect("DSH_TEST_RUNTIME_ROOT must point to the verified DSH-0 runtime"),
        );
        let state_root = PathBuf::from(
            std::env::var_os("DSH_TEST_STATE_ROOT")
                .expect("DSH_TEST_STATE_ROOT must point to the compatible native state fixture"),
        );
        std::fs::create_dir_all(&state_root).unwrap();
        let surface_state_root = state_root.with_file_name("rc8-native-surface-v1");
        std::fs::create_dir_all(&surface_state_root).unwrap();
        let host_dir = host_script.parent().unwrap().to_path_buf();
        let descriptor = RuntimeDescriptor::from_verified_root(
            root,
            host_script,
            state_root,
            surface_state_root,
            [
                host_dir.join("luckyray-dsh-authenticated-webserver/index.mjs"),
                host_dir.join("luckyray-dsh-resource-tools/index.mjs"),
                host_dir.join("luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json"),
                host_dir.join("luckyray-dsh-native-surface.patch.yml"),
                host_dir.join("luckyray-dsh-native-surface-state/package.json"),
                host_dir.join("luckyray-dsh-native-surface-state/client.js"),
                host_dir.join("luckyray-dsh-lightseek-ui/package.json"),
                host_dir.join("luckyray-dsh-lightseek-ui/client.js"),
                host_dir.join("luckyray-dsh-lightseek-ui/lightseek-cosmic-home.webp"),
                host_dir
                    .join("luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs"),
                host_dir.join("luckyray-dsh-authenticated-webserver/package.json"),
                host_dir.join("luckyray-dsh-resource-tools/package.json"),
                host_dir.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs"),
            ],
        )
        .unwrap();
        service_from_test_descriptor(descriptor)
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    fn service_from_test_descriptor(descriptor: RuntimeDescriptor) -> Arc<DshHostService> {
        Arc::new(DshHostService {
            descriptor: OnceLock::from(descriptor),
            initialization_finished: AtomicBool::new(true),
            initialization_gate: Mutex::new(()),
            initialization_ready: Condvar::new(),
            status: Mutex::new(DshHostStatusView {
                stage: DshHostStage::BundledVerified,
                latest_probe_passed: false,
                host_reusable: false,
                can_probe: true,
                can_retry: false,
                shutting_down: false,
                retry_attempt: 0,
                duration_ms: None,
                message: "DeepSeek Harness 已验证，可进行诊断。",
            }),
            host: Mutex::new(None),
            active_job: Mutex::new(None),
            compat_auto_attempted: AtomicBool::new(false),
            surface_compat_mode: AtomicBool::new(false),
            last_teardown_settled: AtomicBool::new(true),
            generation: AtomicU64::new(0),
            shutting_down: AtomicBool::new(false),
            start_admission: Mutex::new(()),
            operation: Mutex::new(()),
            surface_lease: Mutex::new(None),
            surface_preheat_ms: Mutex::new(None),
            surface_status: Mutex::new(DshNativeSurfaceStatusView {
                ready: false,
                stage: DshNativeSurfaceStage::Closed,
                cold_jit_ms: None,
                carrier_bind_ms: None,
                outer_host_rss_mb: None,
                lucky_ray_process_handle_count: None,
                owned_direct_process_count: 0,
                message: "官方 DeepSeek Harness 界面未启动。",
            }),
            surface_host_generation: AtomicU64::new(0),
            surface_port: AtomicU16::new(0),
            desired_remote_authority: Mutex::new(None),
            desired_remote_gateway_generation: AtomicU64::new(0),
            remote_authority_active: AtomicBool::new(false),
            surface_binding_generation: AtomicU64::new(0),
            resource_broker: Mutex::new(None),
            pre_use_hook: Mutex::new(None),
            acquisition_progress_hook: Mutex::new(None),
            pre_admission_hook: Mutex::new(None),
            post_admission_hook: Mutex::new(None),
            spawn_attempts: AtomicU64::new(0),
            surface_control_failure: AtomicBool::new(false),
            remote_drop_failure: AtomicBool::new(false),
            remote_authority_failure: AtomicBool::new(false),
        })
    }

    #[cfg(windows)]
    fn process_handle_count() -> u32 {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
            fn GetProcessHandleCount(process: *mut std::ffi::c_void, count: *mut u32) -> i32;
        }
        let mut count = 0u32;
        assert_ne!(
            unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) },
            0
        );
        count
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn outer_host_projects_only_the_deterministic_windows_system_path() {
        let environment = minimal_environment(
            Path::new(r"D:\runtime"),
            Path::new(r"D:\state"),
            Path::new(r"D:\surface"),
            Path::new(r"D:\surface.patch.yml"),
        )
        .unwrap();
        let actual = environment
            .iter()
            .find_map(|(name, value)| (name == "PATH").then_some(value))
            .expect("the outer Host must carry the system-only PATH");
        let system_root = PathBuf::from(
            std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows")),
        );
        assert_eq!(
            std::env::split_paths(actual).collect::<Vec<_>>(),
            vec![
                system_root
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0"),
                system_root.join("System32"),
                system_root,
            ]
        );
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn outer_host_projects_only_a_nonempty_official_search_credential() {
        let mut environment = Vec::new();
        project_deepseek_search_credential(
            &mut environment,
            Some(OsString::from("epoch225-fixture-secret")),
        );
        assert_eq!(
            environment,
            vec![(
                OsString::from("DEEPSEEK_API_KEY"),
                OsString::from("epoch225-fixture-secret")
            )]
        );

        environment.clear();
        project_deepseek_search_credential(&mut environment, Some(OsString::new()));
        project_deepseek_search_credential(&mut environment, None);
        assert!(environment.is_empty());
    }

    #[test]
    fn public_status_never_contains_private_process_or_transport_fields() {
        let status = serde_json::to_value(DshHostStatusView::unavailable("暂不可用")).unwrap();
        let object = status.as_object().unwrap();
        for forbidden in [
            "path",
            "pid",
            "handle",
            "argv",
            "env",
            "challenge",
            "generation",
            "sessionId",
            "prompt",
            "provider",
            "rawError",
        ] {
            assert!(!object.contains_key(forbidden));
        }
        let surface = serde_json::to_value(DshNativeSurfaceStatusView {
            ready: true,
            stage: DshNativeSurfaceStage::SessionOpen,
            cold_jit_ms: Some(1),
            carrier_bind_ms: Some(2),
            outer_host_rss_mb: Some(3),
            lucky_ray_process_handle_count: Some(4),
            owned_direct_process_count: 2,
            message: "ready",
        })
        .unwrap();
        let surface = surface.as_object().unwrap();
        for forbidden in [
            "enabled",
            "port",
            "url",
            "origin",
            "cookie",
            "bootstrapRef",
            "generation",
        ] {
            assert!(!surface.contains_key(forbidden));
        }
    }

    #[test]
    fn launch_admission_preserves_unconfirmed_cleanup_across_empty_sweeps() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-admission-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let service = DshHostService::production(&root, &root.join("app-data"));
        service
            .last_teardown_settled
            .store(false, Ordering::Release);
        assert!(!service.terminate_current_checked());
        assert!(matches!(
            service.reserve_generation(),
            Err(LaunchFailure::HostFailed)
        ));
        assert_eq!(service.generation.load(Ordering::Acquire), 0);
        assert_eq!(service.spawn_attempts.load(Ordering::Acquire), 0);
        // A confirmed cleanup permits admission; shutdown still takes priority.
        service.last_teardown_settled.store(true, Ordering::Release);
        assert_eq!(service.reserve_generation().unwrap(), 1);
        service.shutting_down.store(true, Ordering::Release);
        assert!(matches!(
            service.reserve_generation(),
            Err(LaunchFailure::ShutdownCancelled)
        ));
    }

    #[test]
    fn missing_or_unverified_bundle_is_unavailable_and_cannot_probe() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-missing-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let app_data = root.join("app-data");
        std::fs::create_dir_all(&app_data).unwrap();
        let service = DshHostService::production(&root, &app_data);
        let status = service.status();
        assert_eq!(status.stage, DshHostStage::Unavailable);
        assert!(!status.latest_probe_passed);
        assert!(!status.can_probe);
        assert!(!status.can_retry);
        assert!(service.probe(DshHostAction::Probe).is_err());
    }

    #[test]
    fn surface_cleanup_levels_do_not_publish_stale_ready_authority() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-surface-levels-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let app_data = root.join("app-data");
        std::fs::create_dir_all(&app_data).unwrap();
        let service = DshHostService::production(&root, &app_data);
        let host_stage = service.status().stage;
        *service.surface_status.lock().unwrap() = DshNativeSurfaceStatusView {
            ready: true,
            stage: DshNativeSurfaceStage::SessionOpen,
            cold_jit_ms: Some(1),
            carrier_bind_ms: Some(1),
            outer_host_rss_mb: Some(1),
            lucky_ray_process_handle_count: Some(1),
            owned_direct_process_count: 2,
            message: "ready",
        };
        let closed_without_host = service.close_native_surface().unwrap();
        assert!(!closed_without_host.ready);
        assert_eq!(closed_without_host.owned_direct_process_count, 0);
        assert_eq!(
            service.status().stage,
            host_stage,
            "Level-1 close does not rewrite Host truth"
        );
        *service.surface_status.lock().unwrap() = DshNativeSurfaceStatusView {
            ready: true,
            stage: DshNativeSurfaceStage::SessionOpen,
            cold_jit_ms: Some(1),
            carrier_bind_ms: Some(1),
            outer_host_rss_mb: Some(1),
            lucky_ray_process_handle_count: Some(1),
            owned_direct_process_count: 2,
            message: "ready",
        };
        service.terminate_current();
        assert!(
            !service.surface_status().ready,
            "Level-2 reset revokes the generation projection"
        );
        assert_eq!(service.surface_status().owned_direct_process_count, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_level_one_surface_settlement_escalates_to_level_two_and_preserves_error() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-surface-settlement-fault-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let app_data = root.join("app-data");
        std::fs::create_dir_all(&app_data).unwrap();
        let service = DshHostService::production(&root, &app_data);
        *service.surface_status.lock().unwrap() = DshNativeSurfaceStatusView {
            ready: true,
            stage: DshNativeSurfaceStage::SessionOpen,
            cold_jit_ms: Some(1),
            carrier_bind_ms: Some(1),
            outer_host_rss_mb: Some(1),
            lucky_ray_process_handle_count: Some(1),
            owned_direct_process_count: 2,
            message: "ready",
        };
        service.inject_surface_control_failure_for_test();

        assert_eq!(
            service.close_native_surface().unwrap_err(),
            "dsh-native-surface-close-unsettled"
        );
        assert_eq!(service.status().stage, DshHostStage::Unavailable);
        assert_eq!(service.generation.load(Ordering::Acquire), 0);
        assert_eq!(
            service.surface_status().stage,
            DshNativeSurfaceStage::Unavailable
        );
        assert!(!service.surface_status().ready);
        assert_eq!(service.surface_status().owned_direct_process_count, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_surface_readiness_is_monotonic_for_one_exact_host_and_carrier_binding() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-surface-binding-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let app_data = root.join("app-data");
        std::fs::create_dir_all(&app_data).unwrap();
        let service = DshHostService::production(&root, &app_data);
        service.surface_host_generation.store(7, Ordering::Release);
        service
            .surface_binding_generation
            .store(11, Ordering::Release);
        *service.surface_status.lock().unwrap() = DshNativeSurfaceStatusView {
            ready: false,
            stage: DshNativeSurfaceStage::CarrierReady,
            cold_jit_ms: Some(1),
            carrier_bind_ms: Some(1),
            outer_host_rss_mb: Some(1),
            lucky_ray_process_handle_count: Some(1),
            owned_direct_process_count: 2,
            message: "carrier",
        };

        service.publish_surface_stage_for(6, 11, DshNativeSurfaceStage::ClientReady);
        service.publish_surface_stage_for(7, 10, DshNativeSurfaceStage::ClientReady);
        assert_eq!(
            service.surface_status().stage,
            DshNativeSurfaceStage::CarrierReady
        );
        assert!(!service.surface_status().ready);

        service.publish_surface_stage_for(7, 11, DshNativeSurfaceStage::ClientReady);
        assert_eq!(
            service.surface_status().stage,
            DshNativeSurfaceStage::ClientReady
        );
        assert!(
            service.surface_status().ready,
            "official client readiness makes the surface usable without a session"
        );

        service.publish_surface_stage_for(7, 11, DshNativeSurfaceStage::SessionOpen);
        assert_eq!(
            service.surface_status().stage,
            DshNativeSurfaceStage::SessionOpen
        );
        assert!(service.surface_status().ready);

        service.publish_surface_stage_for(7, 11, DshNativeSurfaceStage::ClientReady);
        assert_eq!(
            service.surface_status().stage,
            DshNativeSurfaceStage::ClientReady,
            "a closed session downgrades the session fact but not client readiness"
        );
        assert!(service.surface_status().ready);

        service.publish_surface_stage_for(7, 11, DshNativeSurfaceStage::SessionOpen);
        service.publish_surface_stage_for(6, 11, DshNativeSurfaceStage::CarrierReady);
        assert!(
            service.surface_status().ready,
            "stale Host publication cannot revoke the current binding"
        );
        service.publish_surface_stage_for(7, 11, DshNativeSurfaceStage::WebviewCreated);
        assert_eq!(
            service.surface_status().stage,
            DshNativeSurfaceStage::SessionOpen,
            "lower official-state facts never regress the published surface stage"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    fn tracked_surface_assets() -> [PathBuf; 13] {
        let host = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dsh-host");
        [
            host.join("luckyray-dsh-authenticated-webserver/index.mjs"),
            host.join("luckyray-dsh-resource-tools/index.mjs"),
            host.join("luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json"),
            host.join("luckyray-dsh-native-surface.patch.yml"),
            host.join("luckyray-dsh-native-surface-state/package.json"),
            host.join("luckyray-dsh-native-surface-state/client.js"),
            host.join("luckyray-dsh-lightseek-ui/package.json"),
            host.join("luckyray-dsh-lightseek-ui/client.js"),
            host.join("luckyray-dsh-lightseek-ui/lightseek-cosmic-home.webp"),
            host.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs"),
            host.join("luckyray-dsh-authenticated-webserver/package.json"),
            host.join("luckyray-dsh-resource-tools/package.json"),
            host.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs"),
        ]
    }

    fn canvas_timeout_test_frame(kind: &str, request_id: Option<&str>) -> ChildFrame {
        serde_json::from_value(serde_json::json!({
            "type": kind, "protocol": PROTOCOL, "generation": 1, "seq": 1,
            "requestId": request_id, "mac": "a".repeat(64),
        })).unwrap()
    }

    #[test]
    fn expired_canvas_ack_is_removed_once_without_swallowing_other_frames() {
        let (sender, receiver) = mpsc::channel();
        let mut expired = ExpiredCanvasRequests::default();
        expired.record("canvas-agent-1-1".to_owned()).unwrap();
        assert!(sender.send(Ok(canvas_timeout_test_frame("pong", Some("canvas-agent-1-1")))).is_ok());
        assert!(sender.send(Ok(canvas_timeout_test_frame("canvas-agent-result", Some("canvas-agent-1-2")))).is_ok());
        assert!(sender.send(Ok(canvas_timeout_test_frame("canvas-agent-result", Some("canvas-agent-1-1")))).is_ok());
        assert!(sender.send(Ok(canvas_timeout_test_frame("pong", None))).is_ok());
        assert_eq!(read_authenticated_host_frame(&receiver, &mut expired, Duration::from_secs(1)).unwrap().kind, "pong");
        assert_eq!(expired.ids.len(), 1, "same request ID on a different frame kind is not discarded");
        assert_eq!(read_authenticated_host_frame(&receiver, &mut expired, Duration::from_secs(1)).unwrap().request_id.as_deref(), Some("canvas-agent-1-2"));
        assert_eq!(read_authenticated_host_frame(&receiver, &mut expired, Duration::from_secs(1)).unwrap().kind, "pong");
        assert!(expired.ids.is_empty());
        assert!(sender.send(Ok(canvas_timeout_test_frame("canvas-agent-result", Some("canvas-agent-1-1")))).is_ok());
        assert_eq!(read_authenticated_host_frame(&receiver, &mut expired, Duration::from_secs(1)).unwrap().kind, "canvas-agent-result", "a duplicate is unknown after its exact expired ID was consumed");
    }

    #[test]
    fn expired_canvas_ledger_is_bounded_without_evicting_pending_ids_or_hiding_errors() {
        let mut expired = ExpiredCanvasRequests::default();
        for index in 0..MAX_EXPIRED_CANVAS_REQUESTS {
            expired.record(format!("canvas-agent-1-{index}")).unwrap();
        }
        assert!(!expired.has_capacity());
        assert!(expired.record("canvas-agent-1-extra".to_owned()).is_err());
        assert_eq!(expired.ids.front().map(String::as_str), Some("canvas-agent-1-0"));
        let (sender, receiver) = mpsc::channel();
        assert!(sender.send(Err(())).is_ok());
        assert!(matches!(read_authenticated_host_frame(&receiver, &mut expired, Duration::from_secs(1)), Err(HostFrameReadError::Unavailable)));
        assert_eq!(expired.ids.len(), MAX_EXPIRED_CANVAS_REQUESTS);
        drop(sender);
        assert!(matches!(read_authenticated_host_frame(&receiver, &mut expired, Duration::from_secs(1)), Err(HostFrameReadError::Unavailable)));
    }

    #[test]
    fn skipped_expired_canvas_acks_do_not_extend_the_original_read_deadline() {
        let (sender, receiver) = mpsc::channel();
        let mut expired = ExpiredCanvasRequests::default();
        for index in 0..4 { expired.record(format!("canvas-agent-1-{index}")).unwrap(); }
        let producer = thread::spawn(move || {
            for index in 0..4 {
                thread::sleep(Duration::from_millis(30));
                let _ = sender.send(Ok(canvas_timeout_test_frame("canvas-agent-result", Some(&format!("canvas-agent-1-{index}")))));
            }
            let _ = sender.send(Ok(canvas_timeout_test_frame("pong", None)));
        });
        let result = read_authenticated_host_frame(&receiver, &mut expired, Duration::from_millis(90));
        assert!(matches!(result, Err(HostFrameReadError::TimedOut)), "late expired ACKs must not reset the operation's timeout");
        producer.join().unwrap();
    }

    #[test]
    fn canvas_agent_request_is_bounded_to_known_operations() {
        let status = serde_json::json!({"op": "status", "canvasId": "canvas-1"});
        let encoded = encode_canvas_agent_request(&status).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap(), status);
        for invalid in [
            serde_json::json!({"op": "shell", "canvasId": "canvas-1"}),
            serde_json::json!({"op": "status", "canvasId": "../../other"}),
            serde_json::json!({"op": "status", "canvasId": "canvas-1", "url": "https://example.com"}),
            serde_json::json!({"op": "cancel", "canvasId": "canvas-1", "runId": ""}),
        ] { assert!(encode_canvas_agent_request(&invalid).is_err()); }
        let mut request = serde_json::json!({"op": "start", "canvasId": "canvas-1", "conversationId": "conversation-test", "requestId": "request-1", "prompt": "Create a plan",
            "context": {"version": 1, "canvasId": "canvas-1", "canvasName":"Canvas", "nodes": [], "connections": [], "generation": {"imageModels":[],"videoModels":[],"imageReady":false,"videoReady":false}}});
        assert!(encode_canvas_agent_request(&request).is_ok());
        request["prompt"] = serde_json::Value::String("x".repeat(48001));
        assert!(encode_canvas_agent_request(&request).is_err());
        request["prompt"] = serde_json::json!("valid");
        request["context"]["canvasId"] = serde_json::json!("canvas-2");
        assert!(encode_canvas_agent_request(&request).is_err());
        request["context"]["canvasId"] = serde_json::json!("canvas-1");
        request["context"]["nodes"] = serde_json::json!([{"text": "x".repeat(MAX_CANVAS_AGENT_JSON_BYTES)}]);
        assert!(encode_canvas_agent_request(&request).is_err());
    }

    #[test]
    fn canvas_agent_snapshot_rejects_cross_canvas_extra_authority_and_size() {
        let mut snapshot = serde_json::json!({"canvasId": "canvas-1", "conversationId": "conversation-test", "sessionId": null, "runId": null, "status": "idle", "messages": []});
        let encode = |value: &serde_json::Value| URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap());
        assert_eq!(decode_canvas_agent_snapshot(&encode(&snapshot), "canvas-1").unwrap(), snapshot);
        assert!(decode_canvas_agent_snapshot(&encode(&snapshot), "canvas-2").is_err());
        snapshot["credential"] = serde_json::json!("must-not-cross");
        assert!(decode_canvas_agent_snapshot(&encode(&snapshot), "canvas-1").is_err());
        assert!(decode_canvas_agent_snapshot(&"a".repeat(MAX_CANVAS_AGENT_ENCODED_BYTES + 1), "canvas-1").is_err());
        assert!(decode_canvas_agent_snapshot("_w", "canvas-1").is_err());
    }

    #[test]
    fn canvas_agent_error_detail_is_bounded_and_failure_scoped() {
        let valid = serde_json::json!({"canvasId":"canvas-1","conversationId":"conversation-test","sessionId":null,"runId":null,"status":"failed","messages":[],"error":"canvas-agent-model-failed","errorDetail":{"message":"模型未找到，请检查所选模型。"}});
        let encode = |value: &serde_json::Value| URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap());
        assert_eq!(decode_canvas_agent_snapshot(&encode(&valid),"canvas-1").unwrap(),valid);
        for detail in [serde_json::json!(null), serde_json::json!({}), serde_json::json!({"message":" "}), serde_json::json!({"message":"bad\u{0000}text"}), serde_json::json!({"message":"bad\u{0085}text"}), serde_json::json!({"message":"bad\u{202e}text"}), serde_json::json!({"message":"x","raw":"forbidden"}), serde_json::json!({"message":"x".repeat(2001)}), serde_json::json!({"message":"界".repeat(667)})] {
            let mut value=valid.clone(); value["errorDetail"]=detail;
            assert!(decode_canvas_agent_snapshot(&encode(&value),"canvas-1").is_err());
        }
        for status in ["idle","running","completed","cancelled"] {
            let mut value=valid.clone(); value["status"]=serde_json::json!(status);
            assert!(decode_canvas_agent_snapshot(&encode(&value),"canvas-1").is_err());
        }
        let mut missing=valid.clone(); missing.as_object_mut().unwrap().remove("error");
        assert!(decode_canvas_agent_snapshot(&encode(&missing),"canvas-1").is_err());
        let mut legacy=valid.clone(); legacy.as_object_mut().unwrap().remove("errorDetail");
        assert!(decode_canvas_agent_snapshot(&encode(&legacy),"canvas-1").is_ok());
    }

    #[test]
    fn canvas_agent_conversation_and_activity_contract_is_bounded() {
        let mut rotation = serde_json::json!({"op":"newConversation","canvasId":"canvas-1","requestId":"rotate-1","expectedConversationId":"conversation-1"});
        assert!(encode_canvas_agent_request(&rotation).is_ok());
        rotation["sessionId"] = serde_json::json!("must-not-select-engine-session");
        assert!(encode_canvas_agent_request(&rotation).is_err());
        let mut activity = serde_json::json!([{"id":"activity-1","kind":"phase","label":"waiting-model","status":"running","startedAt":1}]);
        assert!(canvas_agent_activity_valid(&activity));
        activity[0]["endedAt"] = serde_json::json!(0);
        assert!(!canvas_agent_activity_valid(&activity));
        activity[0]["endedAt"] = serde_json::json!(2);
        activity[0]["label"] = serde_json::json!("raw-provider-secret");
        assert!(!canvas_agent_activity_valid(&activity));
        assert!(!canvas_agent_activity_valid(&serde_json::json!(vec![serde_json::json!({}); 25])));
    }

    #[test]
    fn canvas_agent_model_contract_is_exact_and_rejects_private_fields() {
        assert!(encode_canvas_agent_request(&serde_json::json!({"op":"models","canvasId":"canvas-1"})).is_ok());
        let mut models = serde_json::json!({"available":[{"provider":"lsh","model":"chosen","label":"LSH chosen","inputModalities":["text"]}],"defaultModel":{"provider":"lsh","model":"default"},"currentModel":null});
        assert!(canvas_agent_models_valid(&models));
        models["available"][0]["reasoning"] = serde_json::json!({"efforts":[{"id":"high","name":"High"}],"defaultEffort":"high"});
        assert!(canvas_agent_models_valid(&models));
        models["available"][0]["reasoning"]["defaultEffort"] = serde_json::json!("unsupported");
        assert!(!canvas_agent_models_valid(&models));
        models["available"][0]["reasoning"]["defaultEffort"] = serde_json::json!("high");
        models["available"][0]["apiKey"] = serde_json::json!("must-not-cross");
        assert!(!canvas_agent_models_valid(&models));
        let mut request = serde_json::json!({"op":"start","canvasId":"canvas-1","conversationId":"conversation-test","requestId":"request-1","prompt":"Plan","context":{"version":1,"canvasId":"canvas-1","canvasName":"Canvas","nodes":[],"connections":[],"generation":{"imageModels":[],"videoModels":[],"imageReady":false,"videoReady":false}},"modelSelection":{"provider":"lsh","model":"chosen"}});
        assert!(encode_canvas_agent_request(&request).is_ok());
        request["modelSelection"]["reasoningEffort"] = serde_json::json!("high");
        assert!(encode_canvas_agent_request(&request).is_ok());
        request["modelSelection"]["reasoningEffort"] = serde_json::json!(42);
        assert!(encode_canvas_agent_request(&request).is_err());
        request["modelSelection"]["reasoningEffort"] = serde_json::json!("high");
        request["modelSelection"]["apiKey"] = serde_json::json!("must-not-cross");
        assert!(encode_canvas_agent_request(&request).is_err());
    }

    #[test]
    fn canvas_agent_r5_history_execution_and_stream_contract() {
        let context=serde_json::json!({"version":1,"canvasId":"canvas-1","canvasName":"Canvas","nodes":[],"connections":[],"generation":{"imageModels":[],"videoModels":[],"imageReady":false,"videoReady":false}});
        let execution=serde_json::json!({"mode":"autonomous","allowGeneration":false,"maxMediaJobs":0});
        let start=serde_json::json!({"op":"start","canvasId":"canvas-1","conversationId":"conversation-1","requestId":"request-1","prompt":"Create a scene","context":context,"execution":execution});
        assert!(encode_canvas_agent_request(&start).is_ok());
        let mut invalid=start.clone(); invalid["execution"]["allowGeneration"]=serde_json::json!(true);
        assert!(encode_canvas_agent_request(&invalid).is_err());
        assert!(encode_canvas_agent_request(&serde_json::json!({"op":"history","canvasId":"canvas-1"})).is_ok());
        assert!(encode_canvas_agent_request(&serde_json::json!({"op":"resumeConversation","canvasId":"canvas-1","requestId":"resume-1","expectedConversationId":"conversation-1","conversationId":"conversation-2"})).is_ok());
        let mut result=serde_json::json!({"op":"actionResult","canvasId":"canvas-1","runId":"run-1","actionId":"action-1","result":{"status":"completed","summary":"Created scene","generatedJobs":0,"context":context}});
        assert!(encode_canvas_agent_request(&result).is_ok()); result["result"]["context"]["canvasId"]=serde_json::json!("foreign");
        assert!(encode_canvas_agent_request(&result).is_err());
        let mut snapshot=serde_json::json!({"canvasId":"canvas-1","conversationId":"conversation-1","sessionId":"session-1","runId":"run-1","status":"running","messages":[{"role":"assistant","text":"Answer","reasoningText":"Provider-visible reasoning"}],"stream":{"attemptId":"attempt-1","text":"Output","status":"streaming","reasoning":true,"reasoningText":"Visible reasoning"},"execution":{"mode":"autonomous","allowGeneration":false,"maxMediaJobs":0,"reservedMediaJobs":0},"updatedAt":1,"pendingAction":{"actionId":"action-1","runId":"run-1","kind":"readContext","offset":256}});
        let encode=|v:&serde_json::Value|URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap());
        assert!(decode_canvas_agent_snapshot(&encode(&snapshot),"canvas-1").is_ok());
        snapshot["pendingAction"]["runId"]=serde_json::json!("foreign");
        assert!(decode_canvas_agent_snapshot(&encode(&snapshot),"canvas-1").is_err());
    }

    #[test]
    fn canvas_agent_r11_creation_schemas_reject_paths_and_wrong_authority() {
        let good=serde_json::json!({"expectedRevision":"0123456789abcdef","operation":{"op":"storyboard.create","name":"Scene"}});
        assert!(canvas_creation_valid(&good,"edit"));
        assert!(!canvas_creation_valid(&serde_json::json!({"scope":"scriptText"}),"read"));
        assert!(canvas_creation_valid(&serde_json::json!({"scope":"scriptText","objectId":"board-1"}),"read"));
        let mut bad=good.clone();bad["operation"]["path"]=serde_json::json!("C:/private");assert!(!canvas_creation_valid(&bad,"edit"));
        assert!(!canvas_creation_valid(&serde_json::json!({"scope":"shots","offset":32}),"read"));
        assert!(canvas_creation_valid(&serde_json::json!({"scope":"shots","offset":32,"expectedRevision":"0123456789abcdef"}),"read"));
        assert!(!canvas_creation_valid(&serde_json::json!({"panel":"delivery","imageIndex":0}),"open"));
        assert!(!canvas_creation_valid(&serde_json::json!({"expectedRevision":"0123456789abcdef","panel":"imageTools","imageIndex":64}),"open"));
    }
    #[test]
    fn canvas_agent_r11_creation_snapshot_and_receipt_round_trip() {
        let context=serde_json::json!({"version":1,"canvasId":"canvas-1","canvasName":"Canvas","nodes":[],"connections":[],"generation":{"imageModels":[],"videoModels":[],"imageReady":false,"videoReady":false}});
        let mut snapshot=serde_json::json!({"canvasId":"canvas-1","conversationId":"conversation-1","sessionId":null,"runId":"run-1","status":"running","messages":[],"pendingAction":{"actionId":"action-1","runId":"run-1","kind":"editCreation","context":context,"execution":{"mode":"autonomous","allowGeneration":false,"maxMediaJobs":0},"creationEdit":{"expectedRevision":"0123456789abcdef","operation":{"op":"storyboard.create","name":"Scene"}}}});
        let encode=|v:&serde_json::Value|URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap());
        assert!(decode_canvas_agent_snapshot(&encode(&snapshot),"canvas-1").is_ok());
        snapshot["pendingAction"]["generate"]=serde_json::json!(false);assert!(decode_canvas_agent_snapshot(&encode(&snapshot),"canvas-1").is_err());
        snapshot["pendingAction"].as_object_mut().unwrap().remove("generate");snapshot["pendingAction"]["execution"]["mode"]=serde_json::json!("plan");assert!(decode_canvas_agent_snapshot(&encode(&snapshot),"canvas-1").is_err());
        let mut reply=serde_json::json!({"op":"actionResult","canvasId":"canvas-1","runId":"run-1","actionId":"action-1","result":{"status":"completed","summary":"Actual result","generatedJobs":0,"creation":{"version":1,"revision":"0123456789abcdef","scope":"overview","offset":0,"total":0,"items":[],"completion":"applied"}}});
        assert!(encode_canvas_agent_request(&reply).is_ok());reply["result"]["creation"]["path"]=serde_json::json!("private");assert!(encode_canvas_agent_request(&reply).is_err());
    }
    #[test]
    fn canvas_agent_r11_creation_unicode_and_transform_bounds() {
        let edit=serde_json::json!({"expectedRevision":"0123456789abcdef","panel":"imageTools","imageIndex":0,"imageEdit":{"turns":1,"flipX":false,"flipY":false,"crop":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},"width":100,"height":200}});
        assert!(canvas_creation_valid(&edit,"open"));
        let mut bad=edit.clone();bad["imageEdit"]["width"]=serde_json::json!(8192);bad["imageEdit"]["height"]=serde_json::json!(8192);assert!(!canvas_creation_valid(&bad,"open"));
        let mut bad=edit.clone();bad["imageEdit"]["crop"]["x"]=serde_json::json!(0.5);assert!(!canvas_creation_valid(&bad,"open"));
        let long=serde_json::json!({"expectedRevision":"0123456789abcdef","operation":{"op":"storyboard.create","name":"😀".repeat(31)}});assert!(!canvas_creation_valid(&long,"edit"));
    }

    #[test]
    fn canvas_agent_r7_reasoning_timing_and_tool_title_contract() {
        let snapshot=serde_json::json!({"canvasId":"canvas-1","conversationId":"conversation-1","sessionId":null,"runId":"run-1","status":"running",
            "messages":[{"role":"assistant","text":"Answer","reasoningText":"Public","reasoningStartedAt":100,"reasoningEndedAt":800,"reasoningDurationMs":500}],
            "stream":{"attemptId":"attempt-1","text":"","status":"streaming","reasoning":true,"reasoningStartedAt":900,"reasoningDurationMs":100,"reasoningActiveStartedAt":1100},
            "tools":[{"callId":"call-1","name":"canvas_apply_plan","status":"completed","startedAt":1,"endedAt":3,"displayTitle":"编辑节点","displayTitleEn":"Edit node"}]});
        let encode=|v:&serde_json::Value|URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap());
        assert!(decode_canvas_agent_snapshot(&encode(&snapshot),"canvas-1").is_ok());
        let mut bad=snapshot.clone();bad["messages"][0]["reasoningEndedAt"]=serde_json::json!(50);
        assert!(decode_canvas_agent_snapshot(&encode(&bad),"canvas-1").is_err());
        let mut bad=snapshot.clone();bad["stream"]["reasoningActiveStartedAt"]=serde_json::json!(-1);
        assert!(decode_canvas_agent_snapshot(&encode(&bad),"canvas-1").is_err());
        let mut bad=snapshot.clone();bad["tools"][0]["displayTitle"]=serde_json::json!("x".repeat(241));
        assert!(decode_canvas_agent_snapshot(&encode(&bad),"canvas-1").is_err());
        let mut legacy=snapshot.clone();legacy["messages"]=serde_json::json!([{"role":"assistant","text":"Old answer"}]);legacy.as_object_mut().unwrap().remove("stream");legacy.as_object_mut().unwrap().remove("tools");
        assert!(decode_canvas_agent_snapshot(&encode(&legacy),"canvas-1").is_ok());
    }

    #[test]
    fn canvas_agent_r6_turn_identity_and_context_revision_contract() {
        let mut snapshot=serde_json::json!({"canvasId":"canvas-1","conversationId":"conversation-1","sessionId":"session-1","runId":"run-2","status":"running",
            "messages":[{"role":"assistant","text":"Answer","turnId":"run-1","messageId":"message-1","attemptId":"attempt-1","createdAt":1,"eventSeq":2}],
            "stream":{"attemptId":"attempt-2","turnId":"run-2","startedAt":5,"text":"Output","status":"streaming","reasoning":false},
            "tools":[{"callId":"call-1","turnId":"run-1","name":"canvas_read_context","status":"completed","startedAt":1,"endedAt":3,"eventSeq":3}],
            "context":{"version":1,"canvasId":"canvas-1","canvasName":"Canvas","snapshotRevision":"0123456789abcdef","nodes":[],"connections":[],"generation":{"imageModels":[],"videoModels":[],"imageReady":false,"videoReady":false}},
            "pendingAction":{"actionId":"action-2","runId":"run-2","kind":"readContext","offset":256,"expectedRevision":"0123456789abcdef"}});
        let encode=|v:&serde_json::Value|URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap());
        assert!(decode_canvas_agent_snapshot(&encode(&snapshot),"canvas-1").is_ok());
        for key in ["turnId","messageId","attemptId"] {
            let mut bad=snapshot.clone(); bad["messages"][0][key]=serde_json::json!("../private");
            assert!(decode_canvas_agent_snapshot(&encode(&bad),"canvas-1").is_err());
        }
        for array in ["messages","tools"] {
            let mut bad=snapshot.clone(); bad[array][0]["eventSeq"]=serde_json::json!(-1);
            assert!(decode_canvas_agent_snapshot(&encode(&bad),"canvas-1").is_err());
        }
        for path in ["context","pendingAction"] {
            let mut bad=snapshot.clone(); bad[path][if path=="context" {"snapshotRevision"} else {"expectedRevision"}]=serde_json::json!("BAD");
            assert!(decode_canvas_agent_snapshot(&encode(&bad),"canvas-1").is_err());
        }
        let mut bad=snapshot.clone(); bad["messages"][0]["hiddenChain"]=serde_json::json!("private");
        assert!(decode_canvas_agent_snapshot(&encode(&bad),"canvas-1").is_err());
        snapshot["stream"]["turnId"]=serde_json::json!("run-other");
        assert!(decode_canvas_agent_snapshot(&encode(&snapshot),"canvas-1").is_err());
    }

    #[test]
    fn tracked_surface_assets_match_the_backend_identity_contract() {
        verify_surface_assets(&tracked_surface_assets()).unwrap();
    }

    #[test]
    fn open_intent_is_bounded_to_safe_text_and_known_producers_before_transport() {
        let encoded = DshOpenIntent {
            intent_id: "intent-00000001-0000-4000-8000-000000000000".to_owned(),
            local_resources: Vec::new(),
            source: "notes".to_owned(),
            text: "请整理这段内容\n保留换行".to_owned(),
        }
        .encode()
        .unwrap();
        let decoded = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(value["source"], "notes");
        assert_eq!(value["text"], "请整理这段内容\n保留换行");
        assert_eq!(value["localResources"], serde_json::json!([]));

        let fixture_root =
            std::env::temp_dir().join(format!("luckyray-open-intent-path-{}", std::process::id()));
        std::fs::create_dir_all(&fixture_root).unwrap();
        let fixture_path = fixture_root.join("中文 素材 #1 (`版`).png");
        std::fs::write(&fixture_path, b"\x89PNG\r\n\x1a\n").unwrap();
        let canonical_path = fixture_path.canonicalize().unwrap();
        let typed = DshOpenIntent {
            intent_id: "intent-00000005-0000-4000-8000-000000000000".to_owned(),
            local_resources: vec![DshOpenIntentLocalResource {
                library_id: None,
                kind: "material".to_owned(),
                asset_id: "asset-1".to_owned(),
                canonical_path: canonical_path.to_string_lossy().into_owned(),
                delivery: "path-reference".to_owned(),
            }],
            source: "materials".to_owned(),
            text: String::new(),
        }
        .encode()
        .unwrap();
        let typed_value: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(typed).unwrap()).unwrap();
        assert_eq!(typed_value["localResources"][0]["assetId"], "asset-1");
        assert_eq!(typed_value["text"], "");
        assert_eq!(
            typed_value["localResources"][0]["delivery"],
            "path-reference"
        );
        assert_eq!(
            typed_value["localResources"][0]["canonicalPath"],
            canonical_path.to_string_lossy().as_ref()
        );
        let attachment = DshOpenIntent {
            intent_id: "intent-00000006-0000-4000-8000-000000000000".to_owned(),
            local_resources: vec![DshOpenIntentLocalResource {
                library_id: None,
                kind: "material".to_owned(),
                asset_id: "asset-image".to_owned(),
                canonical_path: canonical_path.to_string_lossy().into_owned(),
                delivery: "image-attachment".to_owned(),
            }],
            source: "notes".to_owned(),
            text: String::new(),
        }
        .encode()
        .unwrap();
        let attachment_value: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(attachment).unwrap()).unwrap();
        assert_eq!(
            attachment_value["localResources"][0]["delivery"],
            "image-attachment"
        );
        let collection_attachment = DshOpenIntent {
            intent_id: "intent-00000007-0000-4000-8000-000000000000".to_owned(),
            local_resources: vec![DshOpenIntentLocalResource {
                library_id: None,
                kind: "material".to_owned(),
                asset_id: "asset-image".to_owned(),
                canonical_path: canonical_path.to_string_lossy().into_owned(),
                delivery: "image-attachment".to_owned(),
            }],
            source: "collection".to_owned(),
            text: "请分析收集项。".to_owned(),
        };
        assert_eq!(
            collection_attachment.encode().unwrap_err(),
            "dsh-open-intent-invalid"
        );
        let file_path = fixture_root.join("中文 文档.md");
        std::fs::write(&file_path, "# 文件附件\n完整正文🙂\n").unwrap();
        let file_intent = || DshOpenIntent {
            intent_id: "intent-00000008-0000-4000-8000-000000000000".to_owned(),
            source: "notes".to_owned(),
            text: String::new(),
            local_resources: vec![DshOpenIntentLocalResource {
                library_id: None,
                kind: "material".to_owned(),
                asset_id: "note-file".to_owned(),
                canonical_path: file_path.canonicalize().unwrap().to_string_lossy().into_owned(),
                delivery: "file-attachment".to_owned(),
            }],
        };
        assert!(file_intent().encode().is_ok());
        let mut collection_file = file_intent();
        collection_file.source = "collection".to_owned();
        assert_eq!(collection_file.encode().unwrap_err(), "dsh-open-intent-invalid");
        let mut directory_file = file_intent();
        directory_file.local_resources[0].canonical_path = fixture_root.canonicalize().unwrap().to_string_lossy().into_owned();
        assert_eq!(directory_file.encode().unwrap_err(), "dsh-open-intent-invalid");
        std::fs::remove_dir_all(&fixture_root).unwrap();

        for invalid in [
            DshOpenIntent {
                intent_id: "intent-00000001-0000-4000-8000-000000000000".to_owned(),
                local_resources: Vec::new(),
                source: "unknown".to_owned(),
                text: "valid".to_owned(),
            },
            DshOpenIntent {
                intent_id: "bad".to_owned(),
                local_resources: Vec::new(),
                source: "notes".to_owned(),
                text: "valid".to_owned(),
            },
            DshOpenIntent {
                intent_id: "intent-00000002-0000-4000-8000-000000000000".to_owned(),
                local_resources: Vec::new(),
                source: "notes".to_owned(),
                text: "bad\0text".to_owned(),
            },
            DshOpenIntent {
                intent_id: "intent-00000003-0000-4000-8000-000000000000".to_owned(),
                local_resources: Vec::new(),
                source: "materials".to_owned(),
                text: "素材路径：C:\\Users\\Example\\secret.png".to_owned(),
            },
            DshOpenIntent {
                intent_id: "intent-00000004-0000-4000-8000-000000000000".to_owned(),
                local_resources: Vec::new(),
                source: "notes".to_owned(),
                text: "请读取 /data/private/note.md".to_owned(),
            },
        ] {
            assert_eq!(invalid.encode().unwrap_err(), "dsh-open-intent-invalid");
        }
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn parent_resource_result_writer_chunks_without_weakening_frame_authentication() {
        use std::io::{Read as _, Seek as _, SeekFrom};

        let file = tempfile::tempfile().unwrap();
        let mut reader = file.try_clone().unwrap();
        let challenge = [0x5au8; 32];
        let mut channel = ParentChannel {
            stdin: file,
            challenge,
            generation: 17,
            outbound_seq: 0,
        };
        let payload = "a".repeat(500 * 1024);
        channel
            .write_resource_result("resource-large", &payload)
            .unwrap();
        reader.seek(SeekFrom::Start(0)).unwrap();
        let mut encoded = String::new();
        reader.read_to_string(&mut encoded).unwrap();
        let lines = encoded.lines().collect::<Vec<_>>();
        assert!(lines.len() > 1);
        let mut rebuilt = String::new();
        for (index, line) in lines.iter().enumerate() {
            assert!(line.len() + 1 <= MAX_FRAME_BYTES);
            let frame: serde_json::Value = serde_json::from_str(line).unwrap();
            let kind = frame["type"].as_str().unwrap();
            assert_eq!(frame["seq"].as_u64(), Some((index + 1) as u64));
            assert_eq!(frame["requestId"], "resource-large");
            assert_eq!(
                kind,
                if index + 1 == lines.len() {
                    "resource-result"
                } else {
                    "resource-result-chunk"
                }
            );
            let expected = canonical_mac(
                &challenge,
                "parent",
                PROTOCOL,
                17,
                (index + 1) as u64,
                kind,
                Some("resource-large"),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                frame["payload"].as_str(),
                None,
                None,
                None,
            );
            assert_eq!(frame["mac"], expected);
            rebuilt.push_str(frame["payload"].as_str().unwrap());
        }
        assert_eq!(rebuilt, payload);
    }

    #[cfg(windows)]
    #[test]
    fn file_url_converts_drive_and_verbatim_drive_paths_without_artifacts() {
        assert_eq!(
            file_url(Path::new(r"C:\dsh-host\carrier.mjs")).unwrap(),
            "file:///C:/dsh-host/carrier.mjs"
        );
        let verbatim = file_url(Path::new(r"\\?\C:\dsh-host\carrier.mjs")).unwrap();
        assert_eq!(verbatim, "file:///C:/dsh-host/carrier.mjs");
        assert!(
            !verbatim.contains('?') && !verbatim.contains("%3F") && !verbatim.contains("%3f"),
            "verbatim prefix must not survive as a literal or encoded artifact: {verbatim}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn runtime_resource_root_normalizes_verbatim_drive_and_unc_paths() {
        assert_eq!(
            normalize_windows_verbatim_path(Path::new(r"\\?\C:\luckyray\resources")).unwrap(),
            PathBuf::from(r"C:\luckyray\resources")
        );
        assert_eq!(
            normalize_windows_verbatim_path(Path::new(r"\\?\UNC\server\share\resources")).unwrap(),
            PathBuf::from(r"\\server\share\resources")
        );
    }

    #[cfg(windows)]
    #[test]
    fn file_url_escaping_is_owned_by_the_url_implementation() {
        let url = file_url(Path::new(r"C:\path with spaces#tag%50.mjs")).unwrap();
        assert!(url.starts_with("file:///C:/"), "{url}");
        assert!(url.contains("%20"), "space percent-encoded: {url}");
        assert!(
            url.contains("%23"),
            "fragment separator percent-encoded: {url}"
        );
        assert!(url.contains("%25"), "percent sign percent-encoded: {url}");
        let unicode = file_url(Path::new("C:\\目录\\插件.mjs")).unwrap();
        assert!(
            unicode.contains("%E7%9B%AE") && unicode.contains("%E6%8F%92"),
            "non-ASCII path content is UTF-8 percent-encoded: {unicode}"
        );
        assert!(!unicode.contains('目'));
    }

    #[cfg(windows)]
    #[test]
    fn file_url_maps_verbatim_unc_to_a_standards_valid_unc_url() {
        let url = file_url(Path::new(r"\\?\UNC\server\share\carrier.mjs")).unwrap();
        assert!(
            url.starts_with("file://server/share/"),
            "verbatim UNC normalizes to a standards UNC file URL: {url}"
        );
    }

    #[test]
    fn file_url_rejects_relative_and_unsafe_input() {
        assert!(file_url(Path::new("relative/carrier.mjs")).is_err());
        assert!(file_url(Path::new("..\\escape")).is_err());
        assert!(file_url(Path::new("C:\\carrier\"\r\n.mjs")).is_err());
    }

    #[test]
    fn automatic_compat_retry_requires_an_unambiguous_success_result() {
        assert!(compat_apply_succeeded(&serde_json::json!({
            "applied": true,
            "unquarantinable": []
        })));
        for rejected in [
            serde_json::json!({ "applied": false }),
            serde_json::json!({ "applied": true, "failed": true }),
            serde_json::json!({ "applied": true, "checked": false }),
            serde_json::json!({ "applied": true, "unquarantinable": ["broken-plugin"] }),
            serde_json::json!({ "applied": true, "unquarantinable": "malformed" }),
            serde_json::json!({}),
        ] {
            assert!(!compat_apply_succeeded(&rejected), "must reject {rejected}");
        }
    }

    #[test]
    fn native_surface_state_is_an_exact_sibling_and_never_nested_in_legacy_state() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-surface-roots-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let (legacy, surface) = prepare_dsh_state_roots(&root).unwrap();
        assert_eq!(legacy.file_name().unwrap(), "rc8-v1");
        assert_eq!(surface.file_name().unwrap(), "rc8-native-surface-v1");
        assert_eq!(legacy.parent(), surface.parent());
        assert!(!surface.starts_with(&legacy));
        assert!(!legacy.starts_with(&surface));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn app_data_state_roots_follow_the_os_resolved_namespace() {
        let app_data = PathBuf::from(std::env::var_os("APPDATA").unwrap()).join(format!(
            "luckyray-dsh-state-virtualization-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&app_data).unwrap();

        let (legacy, surface) = prepare_dsh_state_roots(&app_data).unwrap();
        assert_eq!(legacy.parent(), surface.parent());
        assert_eq!(legacy.file_name().unwrap(), "rc8-v1");
        assert_eq!(surface.file_name().unwrap(), "rc8-native-surface-v1");
        assert!(!legacy.to_string_lossy().starts_with(r"\\?\"));
        assert!(!surface.to_string_lossy().starts_with(r"\\?\"));

        let _ = std::fs::remove_dir_all(app_data);
    }

    #[test]
    fn background_runtime_admission_releases_setup_before_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let service = DshHostService::production_background(temp.path(), temp.path());
        assert!(started.elapsed() < Duration::from_secs(1));
        service.wait_initialized();
        assert!(service.initialization_finished.load(Ordering::Acquire));
        assert_eq!(service.status().stage, DshHostStage::Unavailable);
        assert!(!service.status().can_probe);
        service.shutdown();
    }

    #[test]
    fn generated_surface_patch_is_digest_bound_before_stable_use() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-surface-patch-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let (path, digest) = materialize_surface_patch(&root, &tracked_surface_assets()).unwrap();
        let lease = acquire_verified_surface_patch(&path, &digest).unwrap();
        lease.revalidate().unwrap();
        drop(lease);
        std::fs::write(&path, b"- id: hostile-replacement\n").unwrap();
        assert!(acquire_verified_surface_patch(&path, &digest).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn generated_surface_patch_stable_lease_blocks_same_path_write_and_delete() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-surface-patch-lease-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let (path, digest) = materialize_surface_patch(&root, &tracked_surface_assets()).unwrap();
        let lease = acquire_verified_surface_patch(&path, &digest).unwrap();
        assert!(std::fs::write(&path, b"hostile").is_err());
        assert!(std::fs::remove_file(&path).is_err());
        lease.revalidate().unwrap();
        drop(lease);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn materialized_surface_modules_are_exact() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-surface-state-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let assets = tracked_surface_assets();
        let (paths, _digests) = materialize_surface_modules(&root, &assets).unwrap();
        // Carrier and resource packages now precede the two client modules.
        let source_indices = [10, 0, 9, 11, 1, 2, 4, 5, 6, 7, 8, 12];
        assert_eq!(paths.len(), source_indices.len());
        for (path, source_index) in paths.iter().zip(source_indices) {
            assert_eq!(
                std::fs::read(path).unwrap(),
                std::fs::read(&assets[source_index]).unwrap()
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn compat_request_after_whole_tree_teardown_prepares_a_trusted_host_and_keeps_recovery_intent()
    {
        // User sequence under test (Rust layer): a whole-tree teardown left
        // self.host empty (fail_surface_generation consumed it); the user
        // clicks "start in compatibility mode" DIRECTLY. The request must
        // prepare a trusted authenticated control host without launching the
        // still-unquarantined surface composition and run — no plain retry is
        // needed first, and the guard state must not resurrect any plugin.
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        service.probe(DshHostAction::Probe).unwrap();
        // Simulate the whole-tree recovery path: teardown consumed the host.
        let descriptor = service.descriptor.get().unwrap();
        let original_state_root = descriptor.state_root.clone();
        let original_surface_root = descriptor.surface_state_root.clone();
        let continuity_marker = original_surface_root.join(".compat-continuity-fixture");
        std::fs::write(&continuity_marker, b"existing-surface-data").unwrap();
        assert!(
            service.terminate_current_checked(),
            "the old Job must drain before recovery"
        );
        service.publish(DshHostStage::Unavailable, 0, None);
        assert!(
            service.host.lock().unwrap().is_none(),
            "fixture: teardown left no host"
        );
        // DIRECT compat request with no plain retry in between.
        let status = service.plugin_compat_status();
        assert!(
            status.is_ok(),
            "direct compat after teardown must rebuild a trusted host: {:?}",
            status.err()
        );
        // The rebuilt host stays alive for the subsequent recovery actions.
        assert!(service
            .host
            .lock()
            .unwrap()
            .as_ref()
            .map(|h| h.is_running())
            .unwrap_or(false));
        assert_eq!(
            service.status().stage,
            DshHostStage::Unavailable,
            "the control-only host must leave the ordinary guarded retry admissible"
        );
        // And a second direct request (the apply) works on the same channel.
        let apply = service.plugin_compat_apply(&serde_json::json!({ "kind": "compatible" }));
        assert!(apply.is_ok());
        let descriptor = service.descriptor.get().unwrap();
        assert_eq!(descriptor.state_root, original_state_root);
        assert_eq!(descriptor.surface_state_root, original_surface_root);
        assert_eq!(
            std::fs::read(&continuity_marker).unwrap(),
            b"existing-surface-data"
        );
        std::fs::remove_file(continuity_marker).unwrap();
        service.shutdown();
    }

    #[test]
    fn stale_failed_surface_reclaim_never_retires_a_healthy_or_busy_replacement() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-stale-reclaim-{}-{}", std::process::id(), rand::random::<u64>()
        ));
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let service = DshHostService::production(&root, &data);
        service.surface_status.lock().unwrap().stage = DshNativeSurfaceStage::ClientReady;
        service.reclaim_failed_native_surface_with(|| panic!("healthy replacement must survive")).unwrap();
        service.surface_status.lock().unwrap().stage = DshNativeSurfaceStage::Unavailable;
        let operation = service.operation.lock().unwrap();
        assert_eq!(service.reclaim_failed_native_surface_with(|| panic!("busy replacement must survive")).unwrap_err(), "dsh-host-action-busy");
        drop(operation);
        let called = std::cell::Cell::new(false);
        service.reclaim_failed_native_surface_with(|| {
            assert!(service.operation.try_lock().is_err(), "retirement stays inside lifecycle admission");
            called.set(true);
            Ok(())
        }).unwrap();
        assert!(called.get());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn compat_control_channel_does_not_probe_the_broken_surface_composition() {
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        service.publish(DshHostStage::Unavailable, 0, None);
        let before = service.spawn_attempts.load(Ordering::Acquire);

        let status = service.plugin_compat_status();

        assert!(
            status.is_ok(),
            "a broken surface composition must not block the compat control channel: {:?}",
            status.err()
        );
        assert_eq!(
            service.spawn_attempts.load(Ordering::Acquire),
            before + 1,
            "recovery should start exactly one authenticated wrapper"
        );
        assert_eq!(service.status().stage, DshHostStage::Unavailable);
        assert!(service
            .host
            .lock()
            .unwrap()
            .as_ref()
            .map(|host| host.is_running())
            .unwrap_or(false));

        service
            .active_job
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .terminate();
        // Wait for the monitor to actually reclaim this generation. Merely
        // taking `operation` can win the race before the monitor acquires it.
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let reclaimed = {
                let _operation = service.operation.lock().unwrap();
                service.host.lock().unwrap().is_none()
                    && service.active_job.lock().unwrap().is_none()
            };
            if reclaimed {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "monitor did not reclaim its generation"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(service.status().stage, DshHostStage::Unavailable);
        assert_eq!(
            service.spawn_attempts.load(Ordering::Acquire),
            before + 1,
            "an exited recovery-only wrapper must not start the broken composition"
        );
        assert!(service.host.lock().unwrap().is_none());
        service.shutdown();
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn compat_recovery_refuses_to_spawn_when_the_previous_teardown_was_unconfirmed() {
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        service.publish(DshHostStage::Unavailable, 0, None);
        service
            .last_teardown_settled
            .store(false, Ordering::Release);
        let before = service.spawn_attempts.load(Ordering::Acquire);
        assert_eq!(
            service.plugin_compat_status().unwrap_err(),
            "dsh-host-cleanup-unconfirmed"
        );
        assert_eq!(
            service.probe(DshHostAction::ExplicitRetry).unwrap_err(),
            "dsh-host-cleanup-unconfirmed"
        );
        assert_eq!(
            service.spawn_attempts.load(Ordering::Acquire),
            before,
            "an unconfirmed tree must block any replacement spawn"
        );
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn launch_admission_retains_a_live_job_without_a_host_slot() {
        let host_script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dsh-host/luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        let _operation = service.operation.lock().unwrap();
        service
            .launch_authenticated_host(service.descriptor.get().unwrap(), 0, false)
            .unwrap();
        let host = service.host.lock().unwrap().take().unwrap();
        let job = service.active_job.lock().unwrap().as_ref().unwrap().clone();
        let before = service.spawn_attempts.load(Ordering::Acquire);
        let generation = service.generation.load(Ordering::Acquire);
        assert!(!job.settled());
        assert!(matches!(
            service.reserve_generation(),
            Err(LaunchFailure::HostFailed)
        ));
        assert_eq!(service.generation.load(Ordering::Acquire), generation);
        assert_eq!(service.spawn_attempts.load(Ordering::Acquire), before);
        assert!(Arc::ptr_eq(
            service.active_job.lock().unwrap().as_ref().unwrap(),
            &job
        ));
        *service.host.lock().unwrap() = Some(host);
        assert!(service.terminate_current_checked());
        assert!(job.settled());
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn rust_to_outer_host_warm_reopen_reuses_generation_owned_verified_lease() {
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        let observations = Arc::new(AtomicU64::new(0));
        let observed = observations.clone();
        *service.acquisition_progress_hook.lock().unwrap() = Some(Arc::new(move |_| {
            observed.fetch_add(1, Ordering::AcqRel);
        }));
        service.probe(DshHostAction::Probe).unwrap();
        assert!(observations.load(Ordering::Acquire) > 0);
        observations.store(0, Ordering::Release);
        let (_, first) = service.open_native_surface().unwrap();
        assert_eq!(observations.load(Ordering::Acquire), 0);
        service.close_native_surface().unwrap();
        observations.store(0, Ordering::Release);
        let (_, warm) = service.open_native_surface().unwrap();
        assert_eq!(warm.port, first.port);
        assert_ne!(warm.bootstrap_ref, first.bootstrap_ref);
        assert_eq!(observations.load(Ordering::Acquire), 0);
        service.close_native_surface().unwrap();
        service.shutdown();
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    fn fresh_probe_consumes_the_exact_producer_stage_sequence_once() {
        let sequence = DshHostService::PROBE_STAGE_SEQUENCE;
        assert_eq!(sequence.len(), 2);
        assert_eq!(sequence[0].0, "session-ready");
        assert_eq!(sequence[1].0, "turn-accepted");
        let mut seen = std::collections::BTreeSet::new();
        for (stage, _) in sequence {
            assert!(
                seen.insert(*stage),
                "duplicate probe stage expectation would consume the next producer frame: {stage}"
            );
        }
    }

    #[test]
    fn canonical_transport_mac_binds_generation_sequence_and_stage() {
        let challenge = [7u8; 32];
        let first = canonical_mac(
            &challenge,
            "child",
            1,
            2,
            3,
            "probe-stage",
            Some("native-probe"),
            Some("turn-accepted"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let stale = canonical_mac(
            &challenge,
            "child",
            1,
            1,
            3,
            "probe-stage",
            Some("native-probe"),
            Some("turn-accepted"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_ne!(first, stale);
        assert!(verify_canonical_mac(
            &challenge,
            "child",
            1,
            2,
            3,
            "probe-stage",
            Some("native-probe"),
            Some("turn-accepted"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            &first,
        ));
        for malformed in ["", &"0".repeat(62), &"0".repeat(66), &"g".repeat(64)] {
            assert!(!verify_canonical_mac(
                &challenge,
                "child",
                1,
                2,
                3,
                "probe-stage",
                Some("native-probe"),
                Some("turn-accepted"),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                malformed,
            ));
        }
    }

    #[test]
    fn backend_action_matrix_is_fail_closed_and_retry_is_unavailable_only() {
        assert!(validate_action(DshHostStage::BundledVerified, DshHostAction::Probe, true).is_ok());
        assert!(validate_action(DshHostStage::ProbeCompleted, DshHostAction::Probe, true).is_ok());
        assert!(validate_action(
            DshHostStage::Unavailable,
            DshHostAction::ExplicitRetry,
            true
        )
        .is_ok());
        for stage in [
            DshHostStage::Starting,
            DshHostStage::ProcessAlive,
            DshHostStage::ProtocolAuthenticated,
            DshHostStage::SessionReady,
            DshHostStage::ExactTurnAccepted,
            DshHostStage::RestartWaiting,
            DshHostStage::ShuttingDown,
            DshHostStage::Unavailable,
        ] {
            assert!(validate_action(stage, DshHostAction::Probe, true).is_err());
        }
        for stage in [
            DshHostStage::BundledVerified,
            DshHostStage::Starting,
            DshHostStage::ProcessAlive,
            DshHostStage::ProtocolAuthenticated,
            DshHostStage::SessionReady,
            DshHostStage::ExactTurnAccepted,
            DshHostStage::ProbeCompleted,
            DshHostStage::RestartWaiting,
            DshHostStage::ShuttingDown,
        ] {
            assert!(validate_action(stage, DshHostAction::ExplicitRetry, true).is_err());
        }
        assert!(
            validate_action(DshHostStage::BundledVerified, DshHostAction::Probe, false).is_err()
        );
    }

    #[test]
    fn inherited_carrier_rejects_non_utf8_oversize_and_unterminated_frames() {
        assert!(decode_host_line(vec![0xff, b'\n']).is_err());
        assert!(decode_host_line(vec![b'a'; MAX_FRAME_BYTES + 1]).is_err());
        assert!(decode_host_line(b"{}".to_vec()).is_err());
        assert_eq!(decode_host_line(b"{}\n".to_vec()).unwrap(), "{}");
    }

    #[test]
    fn host_script_identity_is_checkout_eol_stable_and_rejects_unbound_bytes() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        assert_eq!(
            hash_normalized_host_script(&source).unwrap(),
            HOST_SCRIPT_SHA256
        );
        let compat_source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-plugin-compat.mjs");
        assert_eq!(
            hash_normalized_host_script(&compat_source).unwrap(),
            HOST_COMPAT_SCRIPT_SHA256,
            "the compatibility module pin must move with every edit"
        );
        let resource_source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-resource-tools")
            .join("index.mjs");
        assert_eq!(
            hash_normalized_host_script(&resource_source).unwrap(),
            RESOURCE_PLUGIN_SHA256,
            "the resource module pin must move with every edit"
        );

        let bytes = std::fs::read(&source).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        let normalized = text.replace("\r\n", "\n");
        let temp = std::env::temp_dir().join(format!(
            "luckyray-dsh-host-eol-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::write(&temp, normalized.replace('\n', "\r\n")).unwrap();
        assert_eq!(
            hash_normalized_host_script(&temp).unwrap(),
            HOST_SCRIPT_SHA256
        );
        std::fs::write(&temp, format!("{normalized}\n// unbound mutation\n")).unwrap();
        assert_ne!(
            hash_normalized_host_script(&temp).unwrap(),
            HOST_SCRIPT_SHA256
        );
        let resource_text = std::fs::read_to_string(&resource_source)
            .unwrap()
            .replace("\r\n", "\n");
        std::fs::write(&temp, resource_text.replace('\n', "\r\n")).unwrap();
        assert_eq!(
            hash_normalized_host_script(&temp).unwrap(),
            RESOURCE_PLUGIN_SHA256
        );
        std::fs::write(&temp, format!("{resource_text}\n// unbound mutation\n")).unwrap();
        assert_ne!(
            hash_normalized_host_script(&temp).unwrap(),
            RESOURCE_PLUGIN_SHA256
        );
        let _ = std::fs::remove_file(temp);
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn real_host_acceptance_is_single_flight_and_each_probe_has_fresh_native_evidence() {
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        let left = service.clone();
        let right = service.clone();
        let first = thread::spawn(move || left.probe(DshHostAction::Probe).unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.operation.try_lock().is_ok() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let second = thread::spawn(move || right.probe(DshHostAction::Probe));
        assert_eq!(first.join().unwrap().stage, DshHostStage::ProbeCompleted);
        assert_eq!(second.join().unwrap().unwrap_err(), "dsh-host-action-busy");
        assert_eq!(
            service.probe(DshHostAction::Probe).unwrap().stage,
            DshHostStage::ProbeCompleted
        );
        assert_eq!(service.generation.load(Ordering::Acquire), 1);
        assert!(service.host.lock().unwrap().as_ref().unwrap().is_running());
        service.shutdown();
        assert_eq!(service.status().stage, DshHostStage::Unavailable);
        assert!(service.host.lock().unwrap().is_none());
        assert!(service.active_job.lock().unwrap().is_none());
        assert!(service.probe(DshHostAction::Probe).is_err());
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn crash_restart_and_explicit_retry_each_use_a_new_generation() {
        // Keep the complete, digest-bound host asset directory. Copying only
        // the entry script creates an incomplete descriptor before the
        // crash/retry behavior under test is ever reached.
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        assert_eq!(
            service.probe(DshHostAction::Probe).unwrap().stage,
            DshHostStage::ProbeCompleted
        );
        service
            .active_job
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .terminate();
        // A restart revalidates the pinned critical identity before the native
        // probe timeout begins. Keep the test budget explicit for both phases;
        // it is not a production retry or liveness deadline.
        let deadline = Instant::now() + PROBE_TIMEOUT + Duration::from_secs(120);
        while (service.status().stage != DshHostStage::ProbeCompleted
            || service.generation.load(Ordering::Acquire) < 2)
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(service.status().stage, DshHostStage::ProbeCompleted);
        assert_eq!(service.generation.load(Ordering::Acquire), 2);
        // The monitor publishes the terminal probe state before dropping the
        // single-operation guard. Cross that synchronization boundary before
        // simulating an explicit retry; do not race a visible status update.
        drop(service.operation.lock().unwrap());

        service.terminate_current();
        service.publish(DshHostStage::Unavailable, 3, None);
        assert_eq!(
            service.probe(DshHostAction::ExplicitRetry).unwrap().stage,
            DshHostStage::ProbeCompleted
        );
        assert_eq!(service.generation.load(Ordering::Acquire), 3);
        service.shutdown();
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn shutdown_during_probe_rejects_new_work_and_leaves_no_owned_process() {
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        let worker = service.clone();
        let probe = thread::spawn(move || worker.probe(DshHostAction::Probe));
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.status().stage == DshHostStage::BundledVerified && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        service.shutdown();
        assert!(probe.join().unwrap().is_err());
        assert_eq!(service.status().stage, DshHostStage::Unavailable);
        assert!(service.host.lock().unwrap().is_none());
        assert!(service.active_job.lock().unwrap().is_none());
        assert!(service.probe(DshHostAction::ExplicitRetry).is_err());
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn admitted_generation_is_job_contained_until_post_generation_shutdown_returns() {
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        let rendezvous = Arc::new(std::sync::Barrier::new(2));
        let hook_rendezvous = rendezvous.clone();
        let (admitted_tx, admitted_rx) = mpsc::sync_channel(1);
        *service.post_admission_hook.lock().unwrap() = Some(Arc::new(move |generation| {
            let _ = admitted_tx.send(generation);
            hook_rendezvous.wait();
        }));

        let probe_service = service.clone();
        let probe = thread::spawn(move || probe_service.probe(DshHostAction::Probe));
        assert_eq!(
            admitted_rx
                .recv_timeout(Duration::from_secs(90))
                .expect("probe must reserve one generation before CreateProcess"),
            1
        );

        let (shutdown_tx, shutdown_rx) = mpsc::sync_channel(1);
        let shutdown_service = service.clone();
        let shutdown = thread::spawn(move || {
            shutdown_service.shutdown();
            let _ = shutdown_tx.send(());
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while !service.shutting_down.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(service.shutting_down.load(Ordering::Acquire));
        rendezvous.wait();
        shutdown_rx
            .recv_timeout(Duration::from_secs(8))
            .expect("post-generation shutdown must await the creation-time Job handoff");
        shutdown.join().unwrap();
        assert!(probe.join().unwrap().is_err());
        assert_eq!(service.generation.load(Ordering::Acquire), 1);
        assert_eq!(service.spawn_attempts.load(Ordering::Acquire), 1);
        assert!(service.host.lock().unwrap().is_none());
        assert!(service.active_job.lock().unwrap().is_none());
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "requires the exact verified DSH runtime fixture"]
    fn proactive_surface_restart_is_single_flight_fail_closed_and_retryable() {
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host")
            .join("luckyray-dsh-host.mjs");
        let service = real_service(host_script);
        // A visible terminal stage can precede the old monitor releasing its
        // single-operation guard. Model a later user Retry, not a scheduler
        // race; only the exact transient busy result may wait, and only within
        // this test budget. All production admission/recovery assertions stay.
        let retry_after_monitor = || {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match service.probe(DshHostAction::ExplicitRetry) {
                    Ok(_) => break,
                    Err(error) if error == "dsh-host-action-busy" => {
                        assert!(Instant::now() < deadline, "old monitor failed to settle");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("settled explicit retry failed: {error}"),
                }
            }
        };
        service.probe(DshHostAction::Probe).unwrap();
        let (_, first_bootstrap) = service.open_native_surface().unwrap();
        let initial_generation = service.generation.load(Ordering::Acquire);
        let initial_process = service
            .host
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .process
            .clone();
        let state_root = service.descriptor.get().unwrap().state_root.clone();
        let surface_state_root = service
            .descriptor
            .get()
            .unwrap()
            .surface_state_root
            .clone();

        let rendezvous = Arc::new(std::sync::Barrier::new(2));
        let retire_rendezvous = rendezvous.clone();
        let restart_service = service.clone();
        let restart = thread::spawn(move || {
            restart_service.restart_native_surface_with(
                move || {
                    retire_rendezvous.wait();
                    retire_rendezvous.wait();
                    Ok(())
                },
                |_| Ok(()),
            )
        });
        rendezvous.wait();
        assert_eq!(
            service
                .restart_native_surface_with(|| Ok(()), |_| Ok(()))
                .unwrap_err(),
            "dsh-host-action-busy"
        );
        rendezvous.wait();
        let restarted = restart.join().unwrap().unwrap();
        assert_eq!(restarted.stage, DshNativeSurfaceStage::WebviewCreated);
        assert_eq!(
            service.generation.load(Ordering::Acquire),
            initial_generation + 1
        );
        assert!(!initial_process.is_running());
        assert!(service.host.lock().unwrap().as_ref().unwrap().is_running());
        assert!(service.active_job.lock().unwrap().is_some());
        assert_eq!(service.descriptor.get().unwrap().state_root, state_root);
        assert_eq!(
            service.descriptor.get().unwrap().surface_state_root,
            surface_state_root
        );

        let current_surface = service.surface_status();
        service.publish_surface_stage_for(
            first_bootstrap.host_generation,
            first_bootstrap.carrier_generation,
            DshNativeSurfaceStage::ClientReady,
        );
        assert_eq!(service.surface_status().stage, current_surface.stage);

        let close_failure_generation = service.generation.load(Ordering::Acquire);
        let close_failure_process = service
            .host
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .process
            .clone();
        assert_eq!(
            service
                .restart_native_surface_with(
                    || Err("dsh-native-surface-close-unsettled".to_owned()),
                    |_| panic!("a failed close must not create a replacement child"),
                )
                .unwrap_err(),
            "dsh-native-surface-close-unsettled"
        );
        assert_eq!(
            service.generation.load(Ordering::Acquire),
            close_failure_generation
        );
        assert!(!close_failure_process.is_running());
        assert!(service.host.lock().unwrap().is_none());
        assert!(service.active_job.lock().unwrap().is_none());

        // Cross the old monitor's operation boundary before simulating a
        // later user Retry; the generation fence makes the monitor a no-op.
        drop(service.operation.lock().unwrap());
        retry_after_monitor();
        service.open_native_surface().unwrap();
        assert_eq!(
            service.generation.load(Ordering::Acquire),
            close_failure_generation + 1
        );

        let startup_failure_generation = service.generation.load(Ordering::Acquire);
        let startup_failure_process = service
            .host
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .process
            .clone();
        *service.pre_use_hook.lock().unwrap() = Some(Arc::new(|_| Err(())));
        assert_eq!(
            service
                .restart_native_surface_with(
                    || Ok(()),
                    |_| panic!("a failed Host start must not create a replacement child"),
                )
                .unwrap_err(),
            "dsh-native-surface-unavailable"
        );
        assert_eq!(
            service.generation.load(Ordering::Acquire),
            startup_failure_generation
        );
        assert!(!startup_failure_process.is_running());
        assert!(service.host.lock().unwrap().is_none());
        assert!(service.active_job.lock().unwrap().is_none());

        drop(service.operation.lock().unwrap());
        retry_after_monitor();
        let (_, recovered) = service.open_native_surface().unwrap();
        assert_eq!(
            service.generation.load(Ordering::Acquire),
            startup_failure_generation + 1
        );
        assert_eq!(
            recovered.host_generation,
            service.generation.load(Ordering::Acquire)
        );
        assert!(service.host.lock().unwrap().as_ref().unwrap().is_running());
        assert!(service.active_job.lock().unwrap().is_some());
        service.shutdown();
        assert!(service.host.lock().unwrap().is_none());
        assert!(service.active_job.lock().unwrap().is_none());
    }
}
