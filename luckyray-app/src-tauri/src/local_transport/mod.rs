use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
mod materials_grants;
pub(crate) use materials_grants::MaterialsGrant;

const AUTH_FILE_NAME: &str = "local-transport-auth-v1.json";
const AUTH_FILE_VERSION: u32 = 2;
const MAX_REQUEST_LINE_BYTES: usize = 4 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const DEFAULT_BODY_LIMIT: usize = 1024 * 1024;
const LARGE_JSON_BODY_LIMIT: usize = 4 * 1024 * 1024;
// A recording request is base64 JSON: the transport Vec, serde string and decoded
// media can coexist. Keep one recording in flight and cap its encoded body so the
// practical peak remains bounded instead of multiplying 192 MiB per connection.
const RECORDING_BODY_LIMIT: usize = 96 * 1024 * 1024;
const MAX_ACTIVE_BODY_BYTES_DEFAULT: usize = 128 * 1024 * 1024;
const MAX_RECORDING_REQUESTS_DEFAULT: usize = 1;
const MAX_CONNECTIONS_DEFAULT: usize = 16;
const PROOF_NONCE_BYTES: usize = 32;
pub(crate) const LOCAL_TRANSPORT_PROTOCOL_VERSION: u32 = 1;
pub(crate) const NATIVE_HOST_PROTOCOL_VERSION: u32 = 1;
pub(crate) const NATIVE_HOST_NAME: &str = "com.luckyray.desktop";
pub(crate) const EDGE_DEV_EXTENSION_ORIGIN: &str =
    "chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid";

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityTier {
    Read,
    Write,
    Dangerous,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTransportClientConfig {
    pub base_url: String,
    pub credential: String,
    pub protocol_version: u32,
}

#[derive(Clone, Debug)]
pub struct AdapterResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Clone)]
pub struct VerifiedTransportPrincipal {
    digest: [u8; 32],
    material_binding: Option<MaterialPrincipalBinding>,
}
#[derive(Clone)]
struct MaterialPrincipalBinding {
    auth: Arc<Mutex<AuthState>>,
    materials_grant_id: Option<String>,
    extension_origin: Option<String>,
    credential_digest: [u8; 32],
    granted_tier: CapabilityTier,
}
pub(crate) struct MaterialPrincipalAdmission<'a> {
    _auth: std::sync::MutexGuard<'a, AuthState>,
}

impl std::fmt::Debug for VerifiedTransportPrincipal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("VerifiedTransportPrincipal(sha256)")
    }
}

impl VerifiedTransportPrincipal {
    fn from_authenticated_request(
        origin: Option<&str>,
        required: CapabilityTier,
        granted: CapabilityTier,
    ) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"luckyray-local-transport-principal:v1\0");
        match origin.and_then(canonical_extension_origin) {
            Some(extension_origin) => {
                hasher.update(b"extension\0");
                hasher.update(extension_origin.as_bytes());
            }
            None => {
                hasher.update(b"native\0");
                hasher.update(origin.unwrap_or("no-origin").as_bytes());
            }
        }
        hasher.update(b"\0required:");
        hasher.update(capability_tier_label(required).as_bytes());
        hasher.update(b"\0granted:");
        hasher.update(capability_tier_label(granted).as_bytes());
        Self {
            digest: hasher.finalize().into(),
            material_binding: None,
        }
    }

    // This narrow adapter reuses the authenticated request's existing authority.
    // No raw credential, active UI library or caller-supplied grant is retained.
    pub(crate) fn material_admission(&self) -> crate::materials::MaterialResult<MaterialPrincipalAdmission<'_>> {
        let denied = || crate::materials::MaterialError::new("consumer-library-denied", "素材消费者身份已失效");
        let binding = self.material_binding.as_ref().ok_or_else(denied)?;
        let state = binding.auth.lock().map_err(|_| denied())?;
        let credential = if let Some(id) = binding.materials_grant_id.as_deref() {
            state.materials_credential(id)
        } else { match binding.extension_origin.as_deref() {
            Some(origin) => state.extension_credential(origin),
            None => state.native_credential(),
        }}.map_err(|_| denied())?;
        let digest: [u8; 32] = Sha256::digest(credential.as_bytes()).into();
        if !constant_time_eq(&digest, &binding.credential_digest) { return Err(denied()); }
        Ok(MaterialPrincipalAdmission { _auth: state })
    }
    pub(crate) fn material_authorization(&self, catalog: &crate::materials::MaterialCatalog)
        -> crate::materials::MaterialResult<crate::materials::consumer::ConsumerAuthorization> {
        let current = self.material_admission()?;
        let binding = self.material_binding.as_ref().expect("admission validated binding");
        if let Some(id) = binding.materials_grant_id.as_deref() {
            let grant = current._auth.materials_grants.iter().find(|g| g.id == id)
                .expect("admission validated grant");
            let mut scoped = crate::materials::consumer::ConsumerAuthorization::default();
            scoped.libraries.insert(grant.library_id.clone(), crate::materials::consumer::ConsumerPermissions {
                read: true, import: true, organize: false, files: false,
            });
            return Ok(scoped);
        }
        let mut authorization = crate::materials::consumer::ConsumerAuthorization {
            enumerate: true, ..Default::default()
        };
        if binding.granted_tier >= CapabilityTier::Dangerous {
            for library in catalog.list_libraries(true)? {
                if library.visible {
                    authorization.libraries.insert(library.id, crate::materials::consumer::ConsumerPermissions {
                        read: true, organize: true, import: true, files: false,
                    });
                }
            }
        }
        Ok(authorization)
    }

    pub(crate) fn material_delivery_response(&self, response: AdapterResponse) -> AdapterResponse {
        // The domain may already have committed. A failed delivery check is not
        // one of the six definite pre-write refusals, even for a cached receipt.
        match self.material_admission() {
            Ok(_delivery) => response,
            Err(_) => AdapterResponse {
                status: 403,
                body: json!({"code":"consumer-delivery-denied","writeOutcome":"unknown",
                    "message":"请求权限已失效，请核对操作结果"}).to_string(),
            },
        }
    }

    // Stable across GET/read and POST/dangerous request tiers, but bound to
    // the actual instance credential and extension identity, never a body ID.
    pub(crate) fn media_owner_key(&self) -> crate::materials::MaterialResult<String> {
        let _current = self.material_admission()?;
        let binding = self.material_binding.as_ref().expect("validated material binding");
        let mut hash = Sha256::new();
        hash.update(b"luckyray-media-owner:v1\0");
        hash.update(binding.extension_origin.as_deref().unwrap_or("native").as_bytes());
        hash.update(binding.credential_digest);
        Ok(format!("{:x}", hash.finalize()))
    }

    pub(crate) fn tool_context(&self) -> crate::tools::ToolCallContext {
        crate::tools::ToolCallContext::local_transport_verified(self.digest)
    }

    pub(crate) fn capture_request_key(&self, request_id: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"luckyray-note-capture:v1\0");
        hasher.update(self.digest);
        hasher.update(request_id.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    #[cfg(test)]
    pub(crate) fn capture_test_principal() -> Self {
        Self::from_authenticated_request(None, CapabilityTier::Dangerous, CapabilityTier::Dangerous)
    }
}

fn capability_tier_label(tier: CapabilityTier) -> &'static str {
    match tier {
        CapabilityTier::Read => "read",
        CapabilityTier::Write => "write",
        CapabilityTier::Dangerous => "dangerous",
    }
}

pub trait TransportAdapter: Send + Sync + 'static {
    fn dispatch(&self, method: &str, path: &str, body: Option<&str>) -> AdapterResponse;
    fn dispatch_verified(
        &self,
        _principal: &VerifiedTransportPrincipal,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> AdapterResponse {
        self.dispatch(method, path, body)
    }
    fn collect(&self, body: &Value) -> Result<Value, String>;
}

#[derive(Clone)]
pub struct ServerConfig {
    pub app_data_dir: PathBuf,
    pub ports: Vec<u16>,
    pub max_connections: usize,
    pub max_active_body_bytes: usize,
    pub max_recording_requests: usize,
    pub read_timeout: Duration,
    pub write_timeout: Duration,
    pub trusted_origins: BTreeSet<String>,
    pub extension_origins: BTreeSet<String>,
    pub granted_tier: CapabilityTier,
}

impl ServerConfig {
    pub fn production(app_data_dir: PathBuf) -> Self {
        let trusted_origins = [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        Self {
            app_data_dir,
            ports: (37418..=37467).collect(),
            max_connections: MAX_CONNECTIONS_DEFAULT,
            max_active_body_bytes: MAX_ACTIVE_BODY_BYTES_DEFAULT,
            max_recording_requests: MAX_RECORDING_REQUESTS_DEFAULT,
            read_timeout: Duration::from_secs(5),
            write_timeout: Duration::from_secs(10),
            trusted_origins,
            extension_origins: configured_extension_origins().unwrap_or_default(),
            granted_tier: CapabilityTier::Dangerous,
        }
    }

    #[cfg(test)]
    pub(crate) fn test(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            ports: vec![0],
            max_connections: 2,
            max_active_body_bytes: MAX_ACTIVE_BODY_BYTES_DEFAULT,
            max_recording_requests: MAX_RECORDING_REQUESTS_DEFAULT,
            read_timeout: Duration::from_millis(180),
            write_timeout: Duration::from_millis(500),
            trusted_origins: ["http://tauri.localhost".to_string()].into_iter().collect(),
            extension_origins: [EDGE_DEV_EXTENSION_ORIGIN.to_string()]
                .into_iter()
                .collect(),
            granted_tier: CapabilityTier::Dangerous,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct PersistedAuth {
    version: u32,
    master_secret: String,
    approved_origins: BTreeSet<String>,
}

struct AuthState {
    path: PathBuf,
    persisted: PersistedAuth,
    materials_grants: Vec<MaterialsGrant>,
    materials_grants_error: Option<String>,
}

impl AuthState {
    fn load_or_create(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir)
            .map_err(|_| "local transport credential directory is unavailable".to_string())?;
        let path = app_data_dir.join(AUTH_FILE_NAME);
        if path.exists() {
            let bytes = fs::read(&path)
                .map_err(|_| "local transport credential file is unreadable".to_string())?;
            let persisted: PersistedAuth = serde_json::from_slice(&bytes)
                .map_err(|_| "local transport credential file is invalid".to_string())?;
            if persisted.version != AUTH_FILE_VERSION
                || !is_strict_secret(&persisted.master_secret)
                || persisted.approved_origins.iter().any(|origin| {
                    canonical_extension_origin(origin).as_deref() != Some(origin.as_str())
                })
            {
                return Err("local transport credential file is invalid".to_string());
            }
            let mut state = Self { path, persisted, materials_grants: Vec::new(), materials_grants_error: None };
            state.initialize_materials_grants();
            return Ok(state);
        }

        let persisted = PersistedAuth {
            version: AUTH_FILE_VERSION,
            master_secret: random_hex(32),
            approved_origins: BTreeSet::new(),
        };
        let mut state = Self { path, persisted, materials_grants: Vec::new(), materials_grants_error: None };
        state.initialize_materials_grants();
        state.persist()?;
        Ok(state)
    }

    fn persist(&self) -> Result<(), String> {
        persist_auth_record(&self.path, &self.persisted)
    }

    fn approve_origin(&mut self, origin: &str) -> Result<(), String> {
        if self.persisted.approved_origins.insert(origin.to_string()) {
            if let Err(error) = self.persist() {
                self.persisted.approved_origins.remove(origin);
                return Err(error);
            }
        }
        Ok(())
    }

    fn revoke_origin(&mut self, origin: &str) -> Result<(), String> {
        if self.persisted.approved_origins.remove(origin) {
            if let Err(error) = self.persist() {
                self.persisted.approved_origins.insert(origin.to_string());
                return Err(error);
            }
        }
        Ok(())
    }

    fn rotate_master(&mut self) -> Result<(), String> {
        let previous = std::mem::replace(&mut self.persisted.master_secret, random_hex(32));
        if let Err(error) = self.persist() {
            self.persisted.master_secret = previous;
            return Err(error);
        }
        Ok(())
    }

    fn native_credential(&self) -> Result<String, String> {
        derive_credential(&self.persisted.master_secret, "native\0v1")
    }

    fn extension_credential(&self, origin: &str) -> Result<String, String> {
        if !self.persisted.approved_origins.contains(origin) {
            return Err("extension origin is not approved".to_string());
        }
        derive_credential(
            &self.persisted.master_secret,
            &format!("extension\0{origin}\0v1"),
        )
    }

    fn matching_extension_origin(&self, presented: &str) -> Result<Option<String>, String> {
        let mut matched = None;
        for origin in &self.persisted.approved_origins {
            let expected = self.extension_credential(origin)?;
            if presented.len() == expected.len()
                && constant_time_eq(presented.as_bytes(), expected.as_bytes())
            {
                if matched.is_some() {
                    return Err("extension credential is ambiguous".to_string());
                }
                matched = Some(origin.clone());
            }
        }
        Ok(matched)
    }
}

fn persist_auth_record(path: &Path, record: &impl Serialize) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "local transport credential path is invalid".to_string())?;
        let bytes = serde_json::to_vec_pretty(record)
            .map_err(|_| "local transport credential serialization failed".to_string())?;
        let mut nonce = [0u8; 8];
        OsRng.fill_bytes(&mut nonce);
        let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let filename = path.file_name().and_then(|v| v.to_str()).ok_or("invalid auth record path")?;
        let write_path = parent.join(format!(".{filename}.tmp-{suffix}"));
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&write_path)
            .map_err(|_| "local transport credential write failed".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "local transport credential write failed".to_string())?;
        fs::rename(&write_path, path)
            .map_err(|_| "local transport credential install failed".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
}

pub(crate) fn load_native_credential(app_data_dir: &Path) -> Result<String, String> {
    let path = app_data_dir.join(AUTH_FILE_NAME);
    if !path.is_file() {
        return Err("app-unavailable".to_string());
    }
    AuthState::load_or_create(app_data_dir)?.native_credential()
}

pub(crate) fn configured_extension_origins() -> Result<BTreeSet<String>, String> {
    let configured = option_env!("LUCKYRAY_EXTENSION_ORIGINS").unwrap_or_default();
    if configured.trim().is_empty() {
        if cfg!(debug_assertions) {
            return Ok([EDGE_DEV_EXTENSION_ORIGIN.to_string()]
                .into_iter()
                .collect());
        }
        return Err("production extension origins are not configured".to_string());
    }
    let origins: BTreeSet<String> = configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            canonical_extension_origin(value)
                .ok_or_else(|| "extension origin configuration is invalid".to_string())
        })
        .collect::<Result<_, _>>()?;
    if origins.is_empty() {
        return Err("extension origin configuration is empty".to_string());
    }
    Ok(origins)
}

fn random_hex(byte_count: usize) -> String {
    let mut bytes = vec![0u8; byte_count];
    OsRng.fill_bytes(&mut bytes);
    encode_hex(&bytes)
}

fn is_strict_secret(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 || !value.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err("credential is invalid".to_string());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text =
                std::str::from_utf8(pair).map_err(|_| "credential is invalid".to_string())?;
            u8::from_str_radix(text, 16).map_err(|_| "credential is invalid".to_string())
        })
        .collect()
}

fn derive_credential(master_secret: &str, context: &str) -> Result<String, String> {
    let key = decode_hex(master_secret)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key)
        .map_err(|_| "credential derivation failed".to_string())?;
    mac.update(b"luckyray-local-transport-credential-v1\0");
    mac.update(context.as_bytes());
    Ok(encode_hex(&mac.finalize().into_bytes()))
}

fn proof_message(origin: &str, port: u16, client_nonce: &str, server_nonce: &str) -> String {
    format!(
        "luckyray-local-transport-proof-v1\nprotocol:1\norigin:{origin}\nport:{port}\nclientNonce:{client_nonce}\nserverNonce:{server_nonce}"
    )
}

fn create_proof(
    credential: &str,
    origin: &str,
    port: u16,
    client_nonce: &str,
    server_nonce: &str,
) -> Result<String, String> {
    let key = decode_hex(credential)?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&key).map_err(|_| "proof generation failed".to_string())?;
    mac.update(proof_message(origin, port, client_nonce, server_nonce).as_bytes());
    Ok(encode_hex(&mac.finalize().into_bytes()))
}

pub(crate) fn native_proof_message(port: u16, client_nonce: &str, server_nonce: &str) -> String {
    format!(
        "luckyray-local-transport-native-proof-v1\nprotocol:1\nport:{port}\nclientNonce:{client_nonce}\nserverNonce:{server_nonce}"
    )
}

fn create_native_proof(
    credential: &str,
    port: u16,
    client_nonce: &str,
    server_nonce: &str,
) -> Result<String, String> {
    let key = decode_hex(credential)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key)
        .map_err(|_| "native proof generation failed".to_string())?;
    mac.update(native_proof_message(port, client_nonce, server_nonce).as_bytes());
    Ok(encode_hex(&mac.finalize().into_bytes()))
}

pub(crate) fn verify_native_proof(
    credential: &str,
    port: u16,
    client_nonce: &str,
    server_nonce: &str,
    proof: &str,
) -> bool {
    create_native_proof(credential, port, client_nonce, server_nonce)
        .is_ok_and(|expected| constant_time_eq(expected.as_bytes(), proof.as_bytes()))
}

pub struct LocalTransportHandle {
    port: u16,
    auth: Arc<Mutex<AuthState>>,
    shutdown: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    #[cfg(test)]
    resources: Arc<BodyResources>,
}

impl LocalTransportHandle {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn client_config(&self) -> LocalTransportClientConfig {
        let credential = self
            .auth
            .lock()
            .ok()
            .and_then(|state| state.native_credential().ok())
            .unwrap_or_default();
        LocalTransportClientConfig {
            base_url: self.base_url(),
            credential,
            protocol_version: 1,
        }
    }

    pub fn revoke_extension_origin(&self, origin: &str) -> Result<(), String> {
        let origin = canonical_extension_origin(origin)
            .ok_or_else(|| "extension origin is invalid".to_string())?;
        self.auth
            .lock()
            .map_err(|_| "local transport credential lock failed".to_string())?
            .revoke_origin(&origin)
    }

    pub fn rotate_credentials(&self) -> Result<(), String> {
        self.auth
            .lock()
            .map_err(|_| "local transport credential lock failed".to_string())?
            .rotate_master()
    }

    #[cfg(test)]
    fn max_observed_body_bytes_for_test(&self) -> usize {
        self.resources
            .max_observed_body_bytes
            .load(Ordering::Acquire)
    }
}

impl Drop for LocalTransportHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port));
        if let Some(thread) = self.thread.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = thread.join();
        }
    }
}

pub fn start_server(
    config: ServerConfig,
    adapter: Arc<dyn TransportAdapter>,
) -> Result<LocalTransportHandle, String> {
    let auth = Arc::new(Mutex::new(AuthState::load_or_create(&config.app_data_dir)?));
    let mut listener = None;
    let mut last_error = None;
    for port in &config.ports {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, *port)) {
            Ok(value) => {
                listener = Some(value);
                break;
            }
            Err(error) => last_error = Some(error.kind()),
        }
    }
    let listener = listener.ok_or_else(|| {
        format!(
            "local transport could not bind a loopback port ({:?})",
            last_error.unwrap_or(ErrorKind::AddrInUse)
        )
    })?;
    let local_addr = listener
        .local_addr()
        .map_err(|_| "local transport could not determine its port".to_string())?;
    if local_addr.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        return Err("local transport refused a non-loopback listener".to_string());
    }
    listener
        .set_nonblocking(true)
        .map_err(|_| "local transport listener configuration failed".to_string())?;

    let port = local_addr.port();
    let shutdown = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicUsize::new(0));
    let resources = Arc::new(BodyResources::new(
        config.max_active_body_bytes,
        config.max_recording_requests,
    ));
    let server_instance_nonce = random_hex(PROOF_NONCE_BYTES);
    let thread_resources = resources.clone();
    let thread_server_instance_nonce = server_instance_nonce.clone();
    let handle_auth = auth.clone();
    let thread_shutdown = shutdown.clone();
    let thread_config = config.clone();
    let server_thread = thread::Builder::new()
        .name("luckyray-local-transport".to_string())
        .spawn(move || {
            while !thread_shutdown.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, peer)) => {
                        if !peer.ip().is_loopback() {
                            continue;
                        }
                        let accepted = active
                            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                                (count < thread_config.max_connections).then_some(count + 1)
                            })
                            .is_ok();
                        if !accepted {
                            let request_id = next_request_id();
                            let response = error_response(
                                503,
                                "transport-overloaded",
                                "Local transport is busy",
                                &request_id,
                                false,
                                None,
                                None,
                            );
                            let _ = stream.write_all(response.as_bytes());
                            continue;
                        }
                        let worker_active = active.clone();
                        let worker_auth = auth.clone();
                        let worker_adapter = adapter.clone();
                        let worker_config = thread_config.clone();
                        let worker_resources = thread_resources.clone();
                        let worker_server_instance_nonce = thread_server_instance_nonce.clone();
                        thread::spawn(move || {
                            let _guard = ActiveConnectionGuard(worker_active);
                            // Windows accept inherits the listener's nonblocking
                            // mode. This worker uses bounded blocking reads: a gap
                            // between browser upload chunks is not a timeout.
                            // SO_RCVTIMEO alone does not clear nonblocking mode.
                            if stream.set_nonblocking(false).is_err()
                                || stream.set_read_timeout(Some(worker_config.read_timeout)).is_err()
                                || stream.set_write_timeout(Some(worker_config.write_timeout)).is_err()
                            {
                                return;
                            }
                            handle_connection(
                                &mut stream,
                                port,
                                &worker_config,
                                &worker_auth,
                                worker_adapter.as_ref(),
                                &worker_resources,
                                &worker_server_instance_nonce,
                            );
                        });
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(8));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(20)),
                }
            }
        })
        .map_err(|_| "local transport listener thread failed".to_string())?;

    Ok(LocalTransportHandle {
        port,
        auth: handle_auth,
        shutdown,
        thread: Mutex::new(Some(server_thread)),
        #[cfg(test)]
        resources,
    })
}

struct ActiveConnectionGuard(Arc<AtomicUsize>);

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct BodyResources {
    active_body_bytes: AtomicUsize,
    active_recordings: AtomicUsize,
    max_body_bytes: usize,
    max_recordings: usize,
    max_observed_body_bytes: AtomicUsize,
}

impl BodyResources {
    fn new(max_body_bytes: usize, max_recordings: usize) -> Self {
        Self {
            active_body_bytes: AtomicUsize::new(0),
            active_recordings: AtomicUsize::new(0),
            max_body_bytes,
            max_recordings,
            max_observed_body_bytes: AtomicUsize::new(0),
        }
    }

    fn try_acquire(
        self: &Arc<Self>,
        body_bytes: usize,
        recording: bool,
    ) -> Result<BodyPermit, TransportFailure> {
        if recording
            && self
                .active_recordings
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    (current < self.max_recordings).then_some(current + 1)
                })
                .is_err()
        {
            return Err(TransportFailure::new(
                503,
                "recording-busy",
                "Another recording is being processed",
            ));
        }
        let acquired =
            self.active_body_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    current
                        .checked_add(body_bytes)
                        .filter(|next| *next <= self.max_body_bytes)
                });
        let previous = match acquired {
            Ok(previous) => previous,
            Err(_) => {
                if recording {
                    self.active_recordings.fetch_sub(1, Ordering::AcqRel);
                }
                return Err(TransportFailure::new(
                    503,
                    "body-budget-exhausted",
                    "Local transport body budget is exhausted",
                ));
            }
        };
        let active = previous + body_bytes;
        let _ = self.max_observed_body_bytes.fetch_update(
            Ordering::AcqRel,
            Ordering::Acquire,
            |observed| (active > observed).then_some(active),
        );
        Ok(BodyPermit {
            resources: self.clone(),
            body_bytes,
            recording,
        })
    }
}

struct BodyPermit {
    resources: Arc<BodyResources>,
    body_bytes: usize,
    recording: bool,
}

impl Drop for BodyPermit {
    fn drop(&mut self) {
        self.resources
            .active_body_bytes
            .fetch_sub(self.body_bytes, Ordering::AcqRel);
        if self.recording {
            self.resources
                .active_recordings
                .fetch_sub(1, Ordering::AcqRel);
        }
    }
}

#[derive(Clone, Copy)]
enum RouteKind {
    Health,
    Capabilities,
    NativeProof,
    MaterialsProof,
    NativeBootstrap,
    ExtensionBootstrap,
    Proof,
    Collect,
    Adapter,
}

#[derive(Clone)]
struct Route {
    kind: RouteKind,
    tier: CapabilityTier,
    max_body: usize,
    adapter_path: String,
    versioned: bool,
}

fn strip_query(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MediaTransferRoute {
    Probe,
    Collection,
    Status,
    Cancel,
}

fn media_transfer_route(path: &str) -> Option<MediaTransferRoute> {
    let path = strip_query(path);
    if path == "/api/media/probes" {
        return Some(MediaTransferRoute::Probe);
    }
    if path == "/api/media/transfers" {
        return Some(MediaTransferRoute::Collection);
    }
    let tail = path.strip_prefix("/api/media/transfers/")?;
    if tail.is_empty() {
        return None;
    }
    if let Some(transfer_id) = tail.strip_suffix("/cancel") {
        return (!transfer_id.is_empty() && !transfer_id.contains('/'))
            .then_some(MediaTransferRoute::Cancel);
    }
    (!tail.contains('/')).then_some(MediaTransferRoute::Status)
}

fn known_path(path: &str) -> bool {
    let path = strip_query(path);
    matches!(
        path,
        "/api/extension/appearance"
            | "/api/folders"
            | "/api/notes/recent"
            | "/api/notes/search"
            | "/api/notes"
            | "/api/notes/attach-material"
            | "/api/notes/capture"
            | "/api/notes/capture-target"
            | "/api/assets/import-image"
            | "/api/assets/import-media"
            | "/api/library-mcp/knowledge/search"
            | "/api/library-mcp/knowledge/read"
            | "/api/library-mcp/knowledge/import-markdown"
            | "/api/assets/import-file"
            | "/api/material-libraries"
            | "/api/material-libraries/taxonomy"
            | "/api/material-libraries/query"
            | "/api/material-libraries/detail"
            | "/api/material-libraries/import-bytes"
            | "/api/material-libraries/capture-receipt"
            | "/api/material-libraries/media-receipt"
            | "/api/notes/current"
            | "/api/knowledge/documents"
            | "/api/knowledge/documents/recent"
            | "/api/knowledge/documents/search"
            | "/api/knowledge/read"
            | "/api/knowledge/current"
            | "/api/knowledge/append"
            | "/api/knowledge/insert"
            | "/api/knowledge/replace"
            | "/api/knowledge/insert-current"
            | "/api/collection/failures"
            | "/api/collection/items"
            | "/api/collection"
            | "/api/video/detect-candidates"
            | "/api/video/record/save"
            | "/api/capability/list"
            | "/api/capability/toggle"
            | "/api/capability/run"
            | "/api/tools/list"
            | "/api/tools/run"
    ) || media_transfer_route(path).is_some()
        || (path.starts_with("/api/notes/")
            && (path.ends_with("/append") || path.ends_with("/insert-at-cursor")))
        || path == "/collect"
}

fn route_for(method: &str, raw_path: &str) -> Result<Route, u16> {
    let versioned = raw_path.starts_with("/api/v1/") || raw_path == "/api/v1";
    let adapter_path = if versioned {
        raw_path.replacen("/api/v1", "/api", 1)
    } else {
        raw_path.to_string()
    };
    let path = strip_query(&adapter_path);
    if (crate::materials::consumer_transport::handles(path) || path == "/api/material-libraries/media-receipt") && path != adapter_path {
        return Err(400);
    }
    if versioned && method == "GET" && path == "/api/health" {
        return Ok(Route {
            kind: RouteKind::Health,
            tier: CapabilityTier::Read,
            max_body: 0,
            adapter_path,
            versioned,
        });
    }
    if versioned && method == "GET" && path == "/api/capabilities" {
        return Ok(Route {
            kind: RouteKind::Capabilities,
            tier: CapabilityTier::Read,
            max_body: 0,
            adapter_path,
            versioned,
        });
    }
    if versioned && method == "POST" && path == "/api/materials/proof" {
        return Ok(Route { kind: RouteKind::MaterialsProof, tier: CapabilityTier::Read,
            max_body: 1024, adapter_path, versioned });
    }
    if versioned && method == "POST" && path == "/api/native/proof" {
        return Ok(Route {
            kind: RouteKind::NativeProof,
            tier: CapabilityTier::Read,
            max_body: 1024,
            adapter_path,
            versioned,
        });
    }
    if versioned && method == "POST" && path == "/api/native/bootstrap" {
        return Ok(Route {
            kind: RouteKind::NativeBootstrap,
            tier: CapabilityTier::Dangerous,
            max_body: 1024,
            adapter_path,
            versioned,
        });
    }
    if versioned && path == "/api/extension/bootstrap" {
        if method != "POST" {
            return Err(405);
        }
        return Ok(Route {
            kind: RouteKind::ExtensionBootstrap,
            tier: CapabilityTier::Read,
            max_body: 1024,
            adapter_path,
            versioned,
        });
    }
    if versioned && method == "POST" && path == "/api/proof" {
        return Ok(Route {
            kind: RouteKind::Proof,
            tier: CapabilityTier::Read,
            max_body: 1024,
            adapter_path,
            versioned,
        });
    }
    if (path == "/collect" || path == "/api/collection") && method == "POST" {
        return Ok(Route {
            kind: RouteKind::Collect,
            tier: CapabilityTier::Write,
            max_body: LARGE_JSON_BODY_LIMIT,
            adapter_path,
            versioned,
        });
    }

    if let Some(route) = media_transfer_route(path) {
        let (allowed_method, tier, max_body) = match route {
            MediaTransferRoute::Probe => ("POST", CapabilityTier::Dangerous, DEFAULT_BODY_LIMIT),
            MediaTransferRoute::Collection => {
                ("POST", CapabilityTier::Dangerous, DEFAULT_BODY_LIMIT)
            }
            MediaTransferRoute::Status => ("GET", CapabilityTier::Read, 0),
            MediaTransferRoute::Cancel => ("POST", CapabilityTier::Dangerous, 0),
        };
        if method != allowed_method {
            return Err(405);
        }
        return Ok(Route {
            kind: RouteKind::Adapter,
            tier,
            max_body,
            adapter_path,
            versioned,
        });
    }

    let (allowed_method, tier, max_body) = match path {
        "/api/material-libraries" => ("GET", CapabilityTier::Read, 0),
        "/api/material-libraries/taxonomy" | "/api/material-libraries/query" | "/api/material-libraries/detail" =>
            ("POST", CapabilityTier::Dangerous, DEFAULT_BODY_LIMIT),
        "/api/material-libraries/media-receipt" => ("POST", CapabilityTier::Dangerous, 4096),
        "/api/material-libraries/import-bytes" => ("POST", CapabilityTier::Dangerous, 18 * 1024 * 1024),
        // The same principal tier as import-bytes preserves receipt ownership.
        // This POST is an identity-only read and cannot carry a PNG payload.
        "/api/material-libraries/capture-receipt" => ("POST", CapabilityTier::Dangerous, 1024),
        "/api/folders" if method == "GET" => ("GET", CapabilityTier::Read, 0),
        "/api/folders" => ("POST", CapabilityTier::Write, DEFAULT_BODY_LIMIT),
        "/api/extension/appearance"
        | "/api/notes/recent"
        | "/api/notes/current"
        | "/api/knowledge/documents/recent"
        | "/api/knowledge/current"
        | "/api/collection/items"
        | "/api/capability/list"
        | "/api/tools/list" => ("GET", CapabilityTier::Read, 0),
        "/api/knowledge/documents" if method == "GET" => ("GET", CapabilityTier::Read, 0),
        "/api/notes/search" => ("GET", CapabilityTier::Read, 0),
        "/api/notes" => ("POST", CapabilityTier::Dangerous, LARGE_JSON_BODY_LIMIT),
        "/api/notes/attach-material" => ("POST", CapabilityTier::Dangerous, DEFAULT_BODY_LIMIT),
        "/api/notes/capture" => ("POST", CapabilityTier::Dangerous, LARGE_JSON_BODY_LIMIT),
        "/api/notes/capture-target" => ("POST", CapabilityTier::Read, DEFAULT_BODY_LIMIT),
        "/api/knowledge/documents/search" => ("POST", CapabilityTier::Read, DEFAULT_BODY_LIMIT),
        "/api/knowledge/read" => ("POST", CapabilityTier::Read, DEFAULT_BODY_LIMIT),
        "/api/knowledge/documents"
        | "/api/knowledge/append"
        | "/api/knowledge/insert"
        | "/api/knowledge/replace"
        | "/api/knowledge/insert-current" => {
            ("POST", CapabilityTier::Dangerous, LARGE_JSON_BODY_LIMIT)
        }
        "/api/assets/import-image" | "/api/assets/import-media" => {
            ("POST", CapabilityTier::Dangerous, LARGE_JSON_BODY_LIMIT)
        }
        "/api/library-mcp/knowledge/search" | "/api/library-mcp/knowledge/read" | "/api/library-mcp/knowledge/import-markdown" => ("POST", CapabilityTier::Dangerous, DEFAULT_BODY_LIMIT),
        "/api/assets/import-file" => ("POST", CapabilityTier::Dangerous, DEFAULT_BODY_LIMIT),
        "/api/video/detect-candidates" => ("POST", CapabilityTier::Write, LARGE_JSON_BODY_LIMIT),
        "/api/video/record/save" => ("POST", CapabilityTier::Dangerous, RECORDING_BODY_LIMIT),
        "/api/capability/toggle" | "/api/capability/run" => {
            ("POST", CapabilityTier::Dangerous, LARGE_JSON_BODY_LIMIT)
        }
        "/api/tools/run" => ("POST", CapabilityTier::Dangerous, DEFAULT_BODY_LIMIT),
        "/api/collection/failures" if method == "GET" => ("GET", CapabilityTier::Read, 0),
        "/api/collection/failures" => ("POST", CapabilityTier::Write, LARGE_JSON_BODY_LIMIT),
        _ if path.starts_with("/api/notes/")
            && (path.ends_with("/append") || path.ends_with("/insert-at-cursor")) =>
        {
            ("POST", CapabilityTier::Dangerous, LARGE_JSON_BODY_LIMIT)
        }
        _ => {
            let normalized = if versioned {
                raw_path.replacen("/api/v1", "/api", 1)
            } else {
                raw_path.to_string()
            };
            return if known_path(&normalized) {
                Err(405)
            } else {
                Err(404)
            };
        }
    };
    if method != allowed_method {
        return Err(405);
    }
    Ok(Route {
        kind: RouteKind::Adapter,
        tier,
        max_body,
        adapter_path,
        versioned,
    })
}

#[derive(Debug)]
struct ParsedHead {
    method: String,
    path: String,
    version: String,
    headers: HashMap<String, String>,
    buffered_body: Vec<u8>,
}

fn read_head(stream: &mut TcpStream) -> Result<ParsedHead, TransportFailure> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let header_end;
    loop {
        let count = stream
            .read(&mut chunk)
            .map_err(|error| match error.kind() {
                ErrorKind::WouldBlock | ErrorKind::TimedOut => {
                    TransportFailure::new(408, "request-timeout", "Request timed out")
                }
                _ => TransportFailure::new(400, "request-read-failed", "Request could not be read"),
            })?;
        if count == 0 {
            return Err(TransportFailure::new(
                400,
                "incomplete-headers",
                "Request headers are incomplete",
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = position + 4;
            break;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(TransportFailure::new(
                431,
                "headers-too-large",
                "Request headers are too large",
            ));
        }
    }
    if header_end > MAX_HEADER_BYTES {
        return Err(TransportFailure::new(
            431,
            "headers-too-large",
            "Request headers are too large",
        ));
    }
    let head = std::str::from_utf8(&bytes[..header_end]).map_err(|_| {
        TransportFailure::new(400, "invalid-headers", "Request headers are invalid")
    })?;
    let mut lines = head[..head.len() - 4].split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    if request_line.len() > MAX_REQUEST_LINE_BYTES {
        return Err(TransportFailure::new(
            414,
            "request-line-too-large",
            "Request target is too large",
        ));
    }
    let parts: Vec<&str> = request_line.split_ascii_whitespace().collect();
    if parts.len() != 3 || !parts[2].starts_with("HTTP/1.") {
        return Err(TransportFailure::new(
            400,
            "invalid-request-line",
            "Request line is invalid",
        ));
    }
    let mut headers = HashMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or_else(|| {
            TransportFailure::new(400, "invalid-header", "Request header is invalid")
        })?;
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() || headers.contains_key(&name) {
            return Err(TransportFailure::new(
                400,
                "duplicate-header",
                "Duplicate request header is not supported",
            ));
        }
        headers.insert(name, value.trim().to_string());
    }
    Ok(ParsedHead {
        method: parts[0].to_ascii_uppercase(),
        path: parts[1].to_string(),
        version: parts[2].to_string(),
        headers,
        buffered_body: bytes[header_end..].to_vec(),
    })
}

#[derive(Debug)]
struct TransportFailure {
    status: u16,
    code: &'static str,
    message: &'static str,
    origin: Option<String>,
    legacy: bool,
    details: Option<Value>,
}

impl TransportFailure {
    fn new(status: u16, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
            origin: None,
            legacy: false,
            details: None,
        }
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

fn handle_connection(
    stream: &mut TcpStream,
    port: u16,
    config: &ServerConfig,
    auth: &Arc<Mutex<AuthState>>,
    adapter: &dyn TransportAdapter,
    resources: &Arc<BodyResources>,
    server_instance_nonce: &str,
) {
    let request_id = next_request_id();
    let result = process_connection(
        stream,
        port,
        config,
        auth,
        adapter,
        resources,
        server_instance_nonce,
        &request_id,
    );
    if let Err(failure) = result {
        let response = error_response(
            failure.status,
            failure.code,
            failure.message,
            &request_id,
            failure.legacy,
            failure.origin.as_deref(),
            failure.details.as_ref(),
        );
        let _ = stream.write_all(response.as_bytes());
    }
}

fn process_connection(
    stream: &mut TcpStream,
    port: u16,
    config: &ServerConfig,
    auth: &Arc<Mutex<AuthState>>,
    adapter: &dyn TransportAdapter,
    resources: &Arc<BodyResources>,
    server_instance_nonce: &str,
    request_id: &str,
) -> Result<(), TransportFailure> {
    let mut head = read_head(stream)?;
    let response_origin = head.headers.get("origin").cloned();
    let legacy_response = !head.path.starts_with("/api/v1/");
    let outcome = (|| {
        if head.version != "HTTP/1.1" {
            return Err(TransportFailure::new(
                505,
                "http-version-unsupported",
                "HTTP/1.1 is required",
            ));
        }
        validate_host(head.headers.get("host"), port)?;
        let origin = head.headers.get("origin").map(String::as_str);

        if head.method == "OPTIONS" {
            return handle_preflight(stream, &head, config, auth, origin, request_id);
        }

        let route = route_for(&head.method, &head.path).map_err(|status| {
            match status {
                400 => TransportFailure::new(400, "query-unsupported", "This route does not accept a query"),
                405 => TransportFailure::new(405, "method-not-allowed", "Method is not allowed"),
                _ => TransportFailure::new(404, "route-not-found", "Route was not found"),
            }
        })?;

        validate_origin(origin, config, auth, &route)?;
        let verified_principal = if !matches!(
            route.kind,
            RouteKind::Health
                | RouteKind::NativeProof
                | RouteKind::MaterialsProof
                | RouteKind::ExtensionBootstrap
                | RouteKind::Proof
        ) {
            Some(authenticate(
                &head.headers,
                origin,
                config,
                auth,
                route.tier,
            )?)
        } else {
            None
        };

        if head.headers.contains_key("transfer-encoding") {
            return Err(TransportFailure::new(
                400,
                "transfer-encoding-unsupported",
                "Transfer-Encoding is not supported",
            ));
        }
        let content_length = parse_content_length(&head.headers, &head.method, route.max_body)?;
        if content_length > 0 || matches!(route.kind, RouteKind::ExtensionBootstrap) {
            let content_type = head.headers.get("content-type").map(String::as_str);
            if !content_type.is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            }) {
                return Err(TransportFailure::new(
                    415,
                    "content-type-unsupported",
                    "Content-Type must be application/json",
                ));
            }
        }
        let is_recording = strip_query(&route.adapter_path) == "/api/video/record/save";
        let _body_permit = resources.try_acquire(content_length, is_recording)?;
        let body = read_body(stream, &mut head.buffered_body, content_length)?;
        let body_text = if body.is_empty() {
            None
        } else {
            Some(std::str::from_utf8(&body).map_err(|_| {
                TransportFailure::new(400, "invalid-utf8", "Request body must be UTF-8")
            })?)
        };

        if let Some(principal) = verified_principal.as_ref() {
            principal.check_materials_route(&head.method, &head.path, body_text)?;
        }
        let (status, payload, legacy) = match route.kind {
            RouteKind::MaterialsProof => {
                if origin.is_some() { return Err(TransportFailure::new(403,
                    "native-origin-forbidden", "Materials proof does not accept an Origin header")); }
                let payload = auth.lock().map_err(|_| TransportFailure::new(500,
                    "auth-state-unavailable", "Authentication is unavailable"))?
                    .materials_proof(body_text.unwrap_or("{}"), port, server_instance_nonce)?;
                (200, payload, false)
            }
            RouteKind::Health => (
                200,
                json!({
                    "service": "luckyray-local-transport",
                    "protocolVersion": LOCAL_TRANSPORT_PROTOCOL_VERSION,
                    "controlPlane": "local-transport",
                    "extensionBootstrap": true,
                    "nativeMessagingOptional": true,
                }),
                false,
            ),
            RouteKind::Capabilities => (200, capabilities_payload(), false),
            RouteKind::NativeProof => {
                if origin.is_some() {
                    return Err(TransportFailure::new(
                        403,
                        "native-origin-forbidden",
                        "Native proof does not accept an Origin header",
                    ));
                }
                let parsed: Value =
                    serde_json::from_str(body_text.unwrap_or("{}")).map_err(|_| {
                        TransportFailure::new(400, "invalid-json", "Request JSON is invalid")
                    })?;
                let client_nonce = parsed
                    .get("clientNonce")
                    .and_then(Value::as_str)
                    .filter(|value| is_strict_secret(value))
                    .ok_or_else(|| {
                        TransportFailure::new(400, "proof-nonce-invalid", "Proof nonce is invalid")
                    })?;
                let credential = auth
                    .lock()
                    .map_err(|_| {
                        TransportFailure::new(
                            500,
                            "auth-state-unavailable",
                            "Authentication is unavailable",
                        )
                    })?
                    .native_credential()
                    .map_err(|_| {
                        TransportFailure::new(
                            500,
                            "proof-unavailable",
                            "Server proof is unavailable",
                        )
                    })?;
                let proof =
                    create_native_proof(&credential, port, client_nonce, server_instance_nonce)
                        .map_err(|_| {
                            TransportFailure::new(
                                500,
                                "proof-unavailable",
                                "Server proof is unavailable",
                            )
                        })?;
                (
                    200,
                    json!({
                        "protocolVersion": LOCAL_TRANSPORT_PROTOCOL_VERSION,
                        "port": port,
                        "clientNonce": client_nonce,
                        "serverNonce": server_instance_nonce,
                        "proof": proof,
                    }),
                    false,
                )
            }
            RouteKind::NativeBootstrap => {
                if origin.is_some() {
                    return Err(TransportFailure::new(
                        403,
                        "native-origin-forbidden",
                        "Native bootstrap does not accept an Origin header",
                    ));
                }
                let parsed: Value =
                    serde_json::from_str(body_text.unwrap_or("{}")).map_err(|_| {
                        TransportFailure::new(400, "invalid-json", "Request JSON is invalid")
                    })?;
                let requested = parsed
                    .get("extensionOrigin")
                    .and_then(Value::as_str)
                    .and_then(canonical_extension_origin)
                    .ok_or_else(|| {
                        TransportFailure::new(
                            403,
                            "extension-origin-forbidden",
                            "Extension origin is not allowed",
                        )
                    })?;
                if !config.extension_origins.contains(&requested) {
                    return Err(TransportFailure::new(
                        403,
                        "extension-origin-forbidden",
                        "Extension origin is not allowed",
                    ));
                }
                let credential = {
                    let mut state = auth.lock().map_err(|_| {
                        TransportFailure::new(
                            500,
                            "auth-state-unavailable",
                            "Authentication is unavailable",
                        )
                    })?;
                    state.approve_origin(&requested).map_err(|_| {
                        TransportFailure::new(
                            500,
                            "auth-state-unavailable",
                            "Authentication is unavailable",
                        )
                    })?;
                    state.extension_credential(&requested).map_err(|_| {
                        TransportFailure::new(
                            500,
                            "auth-state-unavailable",
                            "Authentication is unavailable",
                        )
                    })?
                };
                (
                    200,
                    json!({
                        "protocolVersion": LOCAL_TRANSPORT_PROTOCOL_VERSION,
                        "baseUrl": format!("http://127.0.0.1:{port}"),
                        "actualPort": port,
                        "credential": credential,
                    }),
                    false,
                )
            }
            RouteKind::ExtensionBootstrap => {
                let raw_origin = origin.ok_or_else(|| {
                    TransportFailure::new(
                        403,
                        "origin-required",
                        "Extension bootstrap requires an extension origin",
                    )
                })?;
                let requested = canonical_extension_origin(raw_origin).ok_or_else(|| {
                    TransportFailure::new(
                        403,
                        "extension-origin-forbidden",
                        "Extension origin is not allowed",
                    )
                })?;
                if !config.extension_origins.contains(&requested) {
                    return Err(TransportFailure::new(
                        403,
                        "extension-origin-forbidden",
                        "Extension origin is not allowed",
                    ));
                }
                let parsed: Value =
                    serde_json::from_str(body_text.unwrap_or("{}")).map_err(|_| {
                        TransportFailure::new(400, "invalid-json", "Request JSON is invalid")
                    })?;
                if !parsed.is_object() {
                    return Err(TransportFailure::new(
                        400,
                        "invalid-json",
                        "Request JSON must be an object",
                    ));
                }
                let credential = {
                    let mut state = auth.lock().map_err(|_| {
                        TransportFailure::new(
                            500,
                            "auth-state-unavailable",
                            "Authentication is unavailable",
                        )
                    })?;
                    state.approve_origin(&requested).map_err(|_| {
                        TransportFailure::new(
                            500,
                            "auth-state-unavailable",
                            "Authentication is unavailable",
                        )
                    })?;
                    state.extension_credential(&requested).map_err(|_| {
                        TransportFailure::new(
                            500,
                            "auth-state-unavailable",
                            "Authentication is unavailable",
                        )
                    })?
                };
                (
                    200,
                    json!({
                        "protocolVersion": LOCAL_TRANSPORT_PROTOCOL_VERSION,
                        "baseUrl": format!("http://127.0.0.1:{port}"),
                        "actualPort": port,
                        "credential": credential,
                    }),
                    false,
                )
            }
            RouteKind::Proof => {
                let raw_origin = origin.ok_or_else(|| {
                    TransportFailure::new(
                        403,
                        "origin-required",
                        "Server proof requires an extension origin",
                    )
                })?;
                let origin = canonical_extension_origin(raw_origin).ok_or_else(|| {
                    TransportFailure::new(403, "origin-not-allowed", "Origin is not allowed")
                })?;
                let parsed: Value =
                    serde_json::from_str(body_text.unwrap_or("{}")).map_err(|_| {
                        TransportFailure::new(400, "invalid-json", "Request JSON is invalid")
                    })?;
                let client_nonce = parsed
                    .get("clientNonce")
                    .and_then(Value::as_str)
                    .filter(|value| is_strict_secret(value))
                    .ok_or_else(|| {
                        TransportFailure::new(400, "proof-nonce-invalid", "Proof nonce is invalid")
                    })?;
                let credential = auth
                    .lock()
                    .map_err(|_| {
                        TransportFailure::new(
                            500,
                            "auth-state-unavailable",
                            "Authentication is unavailable",
                        )
                    })?
                    .extension_credential(&origin)
                    .map_err(|_| {
                        TransportFailure::new(
                            403,
                            "extension-bootstrap-required",
                            "Extension bootstrap is required",
                        )
                    })?;
                let proof = create_proof(
                    &credential,
                    &origin,
                    port,
                    client_nonce,
                    server_instance_nonce,
                )
                .map_err(|_| {
                    TransportFailure::new(500, "proof-unavailable", "Server proof is unavailable")
                })?;
                (
                    200,
                    json!({
                        "protocolVersion": 1,
                        "port": port,
                        "clientNonce": client_nonce,
                        "serverNonce": server_instance_nonce,
                        "proof": proof,
                    }),
                    false,
                )
            }
            RouteKind::Collect => {
                let parsed: Value =
                    serde_json::from_str(body_text.unwrap_or("")).map_err(|_| {
                        TransportFailure::new(400, "invalid-json", "Request JSON is invalid")
                    })?;
                let payload = adapter.collect(&parsed).map_err(|_| {
                    TransportFailure::new(500, "adapter-failed", "Local operation failed")
                })?;
                (200, payload, !route.versioned)
            }
            RouteKind::Adapter => {
                if body_text.is_some() {
                    let _: Value = serde_json::from_str(body_text.unwrap_or("")).map_err(|_| {
                        TransportFailure::new(400, "invalid-json", "Request JSON is invalid")
                    })?;
                }
                let principal = verified_principal.as_ref().ok_or_else(|| {
                    TransportFailure::new(
                        401,
                        "authentication-required",
                        "Authentication is required",
                    )
                })?;
                let response = adapter.dispatch_verified(
                    principal,
                    &head.method,
                    &route.adapter_path,
                    body_text,
                );
                if response.status >= 400 {
                    let safe_details = safe_adapter_failure_details(&response.body);
                    let (code, message) = if route.adapter_path == "/api/assets/import-file" {
                        safe_import_file_failure(&response.body)
                    } else {
                        None
                    }
                    .unwrap_or_else(|| {
                        (
                            safe_adapter_failure_code(&response.body)
                                .unwrap_or("adapter-request-failed"),
                            "Local operation failed",
                        )
                    });
                    let failure = TransportFailure::new(response.status, code, message);
                    return Err(match safe_details {
                        Some(details) => failure.with_details(details),
                        None => failure,
                    });
                }
                let payload = serde_json::from_str(&response.body)
                    .unwrap_or_else(|_| Value::String(response.body));
                (response.status, payload, !route.versioned)
            }
        };

        let body = if legacy {
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
        } else {
            json!({"ok": true, "data": payload, "requestId": request_id}).to_string()
        };
        let response = success_response(status, &body, request_id, origin);
        stream
            .write_all(response.as_bytes())
            .map_err(|_| TransportFailure::new(500, "response-write-failed", "Response failed"))?;
        Ok(())
    })();
    outcome.map_err(|mut failure: TransportFailure| {
        failure.origin = if matches!(
            failure.code,
            "origin-not-allowed" | "extension-origin-forbidden" | "host-not-allowed"
        ) {
            None
        } else {
            response_origin
        };
        failure.legacy = legacy_response;
        failure
    })
}

// Import-file uses a nested error envelope. Keep its classification without
// relaying download errors that can contain private paths or signed URLs.
// This allowlist applies only to that route; other adapters retain their contract.
fn safe_import_file_failure(body: &str) -> Option<(&'static str, &'static str)> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    match value.get("error")?.get("code")?.as_str()? {
        "invalid-param" => Some((
            "invalid-param",
            "File import parameters are invalid; check the public URL, filename, type and folder",
        )),
        "import-failed" => Some((
            "import-failed",
            "File import failed; check source availability, the 64 MiB limit and local storage. No success receipt was issued",
        )),
        _ => None,
    }
}

fn safe_adapter_failure_code(body: &str) -> Option<&'static str> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let code = value.get("code")?.as_str()?;
    match code {
        "knowledge-vault-required" => Some("knowledge-vault-required"),
        "knowledge-not-found" => Some("knowledge-not-found"),
        "knowledge-revision-conflict" => Some("knowledge-revision-conflict"),
        "knowledge-offset-conflict" => Some("knowledge-offset-conflict"),
        "knowledge-current-context-required" => Some("knowledge-current-context-required"),
        "knowledge-current-context-conflict" => Some("knowledge-current-context-conflict"),
        "knowledge-current-context-changed" => Some("knowledge-current-context-changed"),
        "knowledge-target-not-current" => Some("knowledge-target-not-current"),
        "knowledge-source-inactive" => Some("knowledge-source-inactive"),
        "note-material-not-found" => Some("note-material-not-found"),
        "note-material-input-invalid" => Some("note-material-input-invalid"),
        "note-material-asset-invalid" => Some("note-material-asset-invalid"),
        "note-material-target-invalid" => Some("note-material-target-invalid"),
        "note-material-title-invalid" => Some("note-material-title-invalid"),
        "note-material-source-invalid" => Some("note-material-source-invalid"),
        "consumer-library-denied" => Some("consumer-library-denied"),
        "consumer-folder-denied" => Some("consumer-folder-denied"),
        "consumer-tag-denied" => Some("consumer-tag-denied"),
        "consumer-input-invalid" => Some("consumer-input-invalid"),
        "consumer-capture-too-large" => Some("consumer-capture-too-large"),
        "consumer-capture-busy" => Some("consumer-capture-busy"),
        "consumer-delivery-denied" => Some("consumer-delivery-denied"),
        "consumer-asset-not-found" => Some("consumer-asset-not-found"),
        "material-library-scope" => Some("material-library-scope"),
        "library-unavailable" => Some("library-unavailable"),
        "library-offline" => Some("library-offline"),
        "library-invalid" => Some("library-invalid"),
        "capture-commit-uncertain" => Some("capture-commit-uncertain"),
        "capture-commit-partial" => Some("capture-commit-partial"),
        "capture-receipt-unavailable" => Some("capture-receipt-unavailable"),
        "knowledge-vault-changed" => Some("knowledge-vault-changed"),
        "knowledge-vault-mismatch" => Some("knowledge-vault-mismatch"),
        "knowledge-vault-not-current" => Some("knowledge-vault-not-current"),
        "knowledge-name-conflict" => Some("knowledge-name-conflict"),
        "knowledge-parent-missing" => Some("knowledge-parent-missing"),
        "knowledge-document-not-found" => Some("knowledge-document-not-found"),
        "knowledge-invalid-document-ref" => Some("knowledge-invalid-document-ref"),
        "knowledge-path-outside-vault" => Some("knowledge-path-outside-vault"),
        "knowledge-path-reparse-forbidden" => Some("knowledge-path-reparse-forbidden"),
        "knowledge-path-not-markdown" => Some("knowledge-path-not-markdown"),
        "knowledge-invalid-request" => Some("knowledge-invalid-request"),
        "import-outcome-unknown" => Some("import-outcome-unknown"),
        "note-name-exists" => Some("note-name-exists"),
        "imported-note-changed" => Some("imported-note-changed"),
        "markdown-file-required" => Some("markdown-file-required"),
        "markdown-download-failed" => Some("markdown-download-failed"),
        "markdown-utf8-required" => Some("markdown-utf8-required"),
        "note-response-too-large" => Some("note-response-too-large"),
        "knowledge-write-failed" => Some("knowledge-write-failed"),
        "knowledge-read-failed" => Some("knowledge-read-failed"),
        "tool-not-found" => Some("tool-not-found"),
        "tool-unavailable" => Some("tool-unavailable"),
        "tool-input-invalid" => Some("tool-input-invalid"),
        "tool-input-too-large" => Some("tool-input-too-large"),
        "tool-output-too-large" => Some("tool-output-too-large"),
        "tool-risk-denied" => Some("tool-risk-denied"),
        "tool-timeout" => Some("tool-timeout"),
        "tool-request-capacity" => Some("tool-request-capacity"),
        "request-id-conflict" => Some("request-id-conflict"),
        "capability-disabled" => Some("capability-disabled"),
        "capability-unavailable" => Some("capability-unavailable"),
        "capability-not-found" => Some("capability-not-found"),
        "media-input-invalid" => Some("media-input-invalid"),
        "media-transfer-not-found" => Some("media-transfer-not-found"),
        "media-cancel-too-late" => Some("media-cancel-too-late"),
        "media-capacity" => Some("media-capacity"),
        "media-staging-unavailable" => Some("media-staging-unavailable"),
        "media-serialization-failed" => Some("media-serialization-failed"),
        _ => None,
    }
}

#[cfg(test)]
mod material_consumer_shared_tests;

fn safe_adapter_failure_details(body: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let mut details = serde_json::Map::new();
    if value.get("writeOutcome").and_then(Value::as_str) == Some("unknown") {
        details.insert("writeOutcome".into(), Value::String("unknown".into()));
    }
    if let Some(reason) = value
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| {
            matches!(
                *reason,
                "media_blocked"
                    | "unsupported_format"
                    | "drm_protected"
                    | "too_small"
                    | "http_error"
                    | "network"
                    | "param"
                    | "unknown"
            )
        })
    {
        details.insert("reason".into(), Value::String(reason.to_string()));
    }
    if let Some(category) = value
        .get("category")
        .and_then(Value::as_str)
        .filter(|category| {
            matches!(
                *category,
                "timeout" | "connect" | "redirect" | "request" | "body" | "other" | "http-status"
            )
        })
    {
        details.insert("category".into(), Value::String(category.to_string()));
    }
    if let Some(source) = value
        .get("source")
        .and_then(Value::as_str)
        .filter(|source| {
            matches!(
                *source,
                "hover" | "context-menu" | "popup" | "drag" | "unknown"
            )
        })
    {
        details.insert("source".into(), Value::String(source.to_string()));
    }
    if let Some(fingerprint) =
        value
            .get("fingerprint")
            .and_then(Value::as_str)
            .filter(|fingerprint| {
                fingerprint.len() == 12
                    && fingerprint
                        .chars()
                        .all(|character| character.is_ascii_hexdigit())
            })
    {
        details.insert(
            "fingerprint".into(),
            Value::String(fingerprint.to_ascii_lowercase()),
        );
    }
    if let Some(client_request_id) =
        value
            .get("clientRequestId")
            .and_then(Value::as_str)
            .filter(|request_id| {
                !request_id.is_empty()
                    && request_id.len() <= 96
                    && request_id.chars().all(|character| {
                        character.is_ascii_alphanumeric() || "_.:-".contains(character)
                    })
            })
    {
        details.insert(
            "clientRequestId".into(),
            Value::String(client_request_id.to_string()),
        );
    }
    (!details.is_empty()).then_some(Value::Object(details))
}

fn validate_host(host: Option<&String>, port: u16) -> Result<(), TransportFailure> {
    let expected_ip = format!("127.0.0.1:{port}");
    let expected_name = format!("localhost:{port}");
    match host.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) if value == expected_ip || value == expected_name => Ok(()),
        _ => Err(TransportFailure::new(
            400,
            "host-not-allowed",
            "Host is not allowed",
        )),
    }
}

pub(crate) fn canonical_extension_origin(origin: &str) -> Option<String> {
    let origin = origin.strip_suffix('/').unwrap_or(origin);
    if origin != origin.to_ascii_lowercase() {
        return None;
    }
    let suffix = origin
        .strip_prefix("chrome-extension://")
        .or_else(|| origin.strip_prefix("moz-extension://"));
    suffix
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
        .map(|_| origin.to_string())
}

fn is_extension_origin(origin: &str) -> bool {
    canonical_extension_origin(origin).is_some()
}

fn validate_origin(
    origin: Option<&str>,
    config: &ServerConfig,
    auth: &Arc<Mutex<AuthState>>,
    route: &Route,
) -> Result<(), TransportFailure> {
    let Some(origin) = origin else {
        return if matches!(route.kind, RouteKind::ExtensionBootstrap) {
            Err(TransportFailure::new(
                403,
                "origin-required",
                "Extension bootstrap requires an extension origin",
            ))
        } else {
            Ok(())
        };
    };
    if matches!(route.kind, RouteKind::ExtensionBootstrap) {
        let canonical = canonical_extension_origin(origin).ok_or_else(|| {
            TransportFailure::new(
                403,
                "extension-origin-forbidden",
                "Extension origin is not allowed",
            )
        })?;
        return if config.extension_origins.contains(&canonical) {
            Ok(())
        } else {
            Err(TransportFailure::new(
                403,
                "extension-origin-forbidden",
                "Extension origin is not allowed",
            ))
        };
    }
    if config.trusted_origins.contains(origin) {
        return Ok(());
    }
    if is_extension_origin(origin) {
        if matches!(route.kind, RouteKind::Health) {
            return Ok(());
        }
        let approved = auth
            .lock()
            .ok()
            .is_some_and(|state| state.persisted.approved_origins.contains(origin));
        if approved {
            return Ok(());
        }
        return Err(TransportFailure::new(
            403,
            "extension-bootstrap-required",
            "Extension bootstrap is required",
        ));
    }
    Err(TransportFailure::new(
        403,
        "origin-not-allowed",
        "Origin is not allowed",
    ))
}

fn authenticate(
    headers: &HashMap<String, String>,
    origin: Option<&str>,
    config: &ServerConfig,
    auth: &Arc<Mutex<AuthState>>,
    required: CapabilityTier,
) -> Result<VerifiedTransportPrincipal, TransportFailure> {
    if config.granted_tier < required {
        return Err(TransportFailure::new(
            403,
            "capability-tier-denied",
            "Capability tier is not granted",
        ));
    }
    let presented = headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !is_strict_secret(presented) {
        return Err(TransportFailure::new(
            401,
            "authentication-required",
            "Authentication is required",
        ));
    }
    let state = auth.lock().map_err(|_| {
        TransportFailure::new(
            500,
            "auth-state-unavailable",
            "Authentication is unavailable",
        )
    })?;
    let authentication_failed =
        || TransportFailure::new(401, "authentication-required", "Authentication is required");
    let materials_grant_id = if origin.is_none() { state.matching_materials_grant(presented) } else { None };
    let verified_origin = if materials_grant_id.is_some() { None } else { match origin {
        Some(origin) if is_extension_origin(origin) => {
            let canonical = canonical_extension_origin(origin).ok_or_else(authentication_failed)?;
            let expected = state
                .extension_credential(&canonical)
                .map_err(|_| authentication_failed())?;
            if presented.len() != expected.len()
                || !constant_time_eq(presented.as_bytes(), expected.as_bytes())
            {
                return Err(authentication_failed());
            }
            Some(canonical)
        }
        Some(origin) => {
            let expected = state
                .native_credential()
                .map_err(|_| authentication_failed())?;
            if presented.len() != expected.len()
                || !constant_time_eq(presented.as_bytes(), expected.as_bytes())
            {
                return Err(authentication_failed());
            }
            Some(origin.to_string())
        }
        None => {
            let native = state
                .native_credential()
                .map_err(|_| authentication_failed())?;
            if presented.len() == native.len()
                && constant_time_eq(presented.as_bytes(), native.as_bytes())
            {
                None
            } else {
                state
                    .matching_extension_origin(presented)
                    .map_err(|_| authentication_failed())?
                    .ok_or_else(authentication_failed)
                    .map(Some)?
            }
        }
    }};
    let mut principal = VerifiedTransportPrincipal::from_authenticated_request(
        verified_origin.as_deref(), required, config.granted_tier,
    );
    principal.material_binding = Some(MaterialPrincipalBinding {
        auth: Arc::clone(auth),
        materials_grant_id,
        extension_origin: verified_origin.filter(|origin| is_extension_origin(origin)),
        credential_digest: Sha256::digest(presented.as_bytes()).into(),
        granted_tier: config.granted_tier,
    });
    Ok(principal)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn parse_content_length(
    headers: &HashMap<String, String>,
    method: &str,
    max_body: usize,
) -> Result<usize, TransportFailure> {
    let value = headers.get("content-length");
    if method == "POST" && value.is_none() {
        return Err(TransportFailure::new(
            411,
            "content-length-required",
            "Content-Length is required",
        ));
    }
    let length = match value {
        Some(value) if value.is_empty() || !value.as_bytes().iter().all(u8::is_ascii_digit) => {
            return Err(TransportFailure::new(
                400,
                "content-length-invalid",
                "Content-Length is invalid",
            ));
        }
        Some(value) => value.parse::<usize>().map_err(|_| {
            TransportFailure::new(400, "content-length-invalid", "Content-Length is invalid")
        })?,
        None => 0,
    };
    if length > max_body {
        return Err(TransportFailure::new(
            413,
            "body-too-large",
            "Request body is too large",
        ));
    }
    if method == "GET" && length > 0 {
        return Err(TransportFailure::new(
            400,
            "unexpected-body",
            "GET requests cannot include a body",
        ));
    }
    Ok(length)
}

fn read_body(
    stream: &mut TcpStream,
    buffered: &mut Vec<u8>,
    content_length: usize,
) -> Result<Vec<u8>, TransportFailure> {
    if buffered.len() > content_length {
        buffered.truncate(content_length);
    }
    let mut body = Vec::with_capacity(content_length);
    body.extend_from_slice(buffered);
    let mut chunk = [0u8; 8192];
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let chunk_len = chunk.len();
        let count = stream
            .read(&mut chunk[..remaining.min(chunk_len)])
            .map_err(|error| match error.kind() {
                ErrorKind::WouldBlock | ErrorKind::TimedOut => {
                    TransportFailure::new(408, "body-timeout", "Request body timed out")
                }
                _ => {
                    TransportFailure::new(400, "body-read-failed", "Request body could not be read")
                }
            })?;
        if count == 0 {
            return Err(TransportFailure::new(
                400,
                "incomplete-body",
                "Request body is incomplete",
            ));
        }
        body.extend_from_slice(&chunk[..count]);
    }
    Ok(body)
}

fn handle_preflight(
    stream: &mut TcpStream,
    head: &ParsedHead,
    config: &ServerConfig,
    auth: &Arc<Mutex<AuthState>>,
    origin: Option<&str>,
    request_id: &str,
) -> Result<(), TransportFailure> {
    let requested_method = head
        .headers
        .get("access-control-request-method")
        .map(|value| value.to_ascii_uppercase())
        .ok_or_else(|| {
            TransportFailure::new(
                400,
                "preflight-method-required",
                "Preflight method is required",
            )
        })?;
    let route = route_for(&requested_method, &head.path).map_err(|status| {
        if status == 405 {
            TransportFailure::new(405, "method-not-allowed", "Method is not allowed")
        } else {
            TransportFailure::new(404, "route-not-found", "Route was not found")
        }
    })?;
    validate_origin(origin, config, auth, &route)?;
    let headers = cors_headers(origin);
    let response = format!(
        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\nX-Request-Id: {request_id}\r\n{headers}\r\n"
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|_| TransportFailure::new(500, "response-write-failed", "Response failed"))?;
    Ok(())
}

fn capabilities_payload() -> Value {
    json!({
        "protocolVersion": 1,
        "namespaces": {
            "collection": {"available": true, "tiers": ["read", "write"]},
            "materials": {"mediaImport":{"version":1,"available":true,"explicitLibrary":true,"receiptLookupVersion":1,"maxOriginalImageBytes":33554432},"available": true, "tiers": ["read", "dangerous"], "sourcePage": {"available": true, "version": 1}, "libraryConsumer": {
                "available": true, "consumerVersion": 1, "explicitLibrary": true, "legacyDefaultFixed": true,
                "operations": ["libraries", "taxonomy", "query", "detail", "importBytes"], "files": false,
                "mimeTypes": ["image/png", "text/markdown", "text/plain"],
                "maxBytes": 12582912, "maxPixels": 40000000, "maxSide": 32767
            }},
            "knowledge": {
                "available": true,
                "tiers": ["read", "dangerous"],
                "documentTruth": "vault",
                "source": "vault",
                "dbNoteMode": false
            },
            "notes": {"available": true, "tiers": ["read", "dangerous"], "legacyAliasFor": "knowledge"},
            "capabilities": {"available": true, "tiers": ["read", "dangerous"]},
            "tools": {"available": true, "tiers": ["read", "dangerous"], "version": 1},
            "canvas": {"available": false, "status": "reserved"}
        }
    })
}

fn next_request_id() -> String {
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("lr-{nanos:x}-{sequence:x}")
}

fn cors_headers(origin: Option<&str>) -> String {
    let mut headers = String::from(
        "Vary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type, X-LuckyRay-Source\r\nAccess-Control-Max-Age: 600\r\n",
    );
    if let Some(origin) = origin {
        headers.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\n"));
    }
    headers
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        505 => "HTTP Version Not Supported",
        _ => "Error",
    }
}

fn success_response(status: u16, body: &str, request_id: &str, origin: Option<&str>) -> String {
    format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Request-Id: {request_id}\r\n{}\r\n{body}",
        status_reason(status),
        body.len(),
        cors_headers(origin)
    )
}

fn error_response(
    status: u16,
    code: &str,
    message: &str,
    request_id: &str,
    legacy: bool,
    origin: Option<&str>,
    details: Option<&Value>,
) -> String {
    let body = if legacy {
        let mut body = json!({"error": message, "code": code, "requestId": request_id});
        if let Some(details) = details.and_then(Value::as_object) {
            // Commit uncertainty must survive both final wire envelopes. Only
            // this bounded marker is allowed; never copy arbitrary raw details.
            if details.get("writeOutcome").and_then(Value::as_str) == Some("unknown") {
                body["writeOutcome"] = json!("unknown");
            }
            for key in [
                "reason",
                "category",
                "source",
                "fingerprint",
                "clientRequestId",
            ] {
                if let Some(value) = details.get(key) {
                    body[key] = value.clone();
                }
            }
        }
        body.to_string()
    } else {
        json!({
            "ok": false,
            "error": {"code": code, "message": message, "details": details.cloned().unwrap_or(Value::Null)},
            "requestId": request_id,
        })
        .to_string()
    };
    success_response(status, &body, request_id, origin)
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("materials_mcp_tests.rs");
    use crate::knowledge::{KnowledgeService, KnowledgeVaultRegistration};
    use crate::{backend::BackendServices, LegacyLocalTransportAdapter};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Barrier, Condvar};

    #[test]
    fn media_transfer_routes_are_method_scoped_and_require_the_expected_capability_tier() {
        let probe = route_for("POST", "/api/media/probes").unwrap();
        assert_eq!(probe.tier, CapabilityTier::Dangerous);
        assert_eq!(probe.max_body, DEFAULT_BODY_LIMIT);

        let start = route_for("POST", "/api/media/transfers").unwrap();
        assert_eq!(start.tier, CapabilityTier::Dangerous);
        assert_eq!(start.max_body, DEFAULT_BODY_LIMIT);

        let status = route_for("GET", "/api/media/transfers/media-abc123").unwrap();
        assert_eq!(status.tier, CapabilityTier::Read);
        assert_eq!(status.max_body, 0);

        let cancel = route_for("POST", "/api/media/transfers/media-abc123/cancel").unwrap();
        assert_eq!(cancel.tier, CapabilityTier::Dangerous);
        assert_eq!(cancel.max_body, 0);

        assert!(matches!(route_for("GET", "/api/media/transfers"), Err(405)));
        assert!(matches!(route_for("GET", "/api/media/probes"), Err(405)));
        assert!(matches!(
            route_for("POST", "/api/media/transfers/media-abc123"),
            Err(405)
        ));
        assert!(matches!(
            route_for("GET", "/api/media/transfers/media-abc123/cancel"),
            Err(405)
        ));
        assert!(matches!(
            route_for("GET", "/api/media/transfers/media-abc123/extra"),
            Err(404)
        ));
    }

    #[test]
    fn media_transfer_adapter_errors_keep_only_allowlisted_safe_codes() {
        for code in [
            "media-input-invalid",
            "media-transfer-not-found",
            "media-cancel-too-late",
            "media-capacity",
            "media-staging-unavailable",
        ] {
            let body = serde_json::json!({
                "code": code,
                "message": "fixed safe message",
                "url": "https://private.test/path?token=PRIVATE"
            })
            .to_string();
            assert_eq!(safe_adapter_failure_code(&body), Some(code));
            assert_eq!(safe_adapter_failure_details(&body), None);
        }
        assert_eq!(
            safe_adapter_failure_code(
                r#"{"code":"media-private-path","message":"C:\\Users\\private"}"#
            ),
            None
        );
    }

    #[test]
    fn note_material_adapter_errors_preserve_safe_target_conflicts() {
        for code in [
            "knowledge-current-context-changed",
            "knowledge-target-not-current",
            "knowledge-source-inactive",
            "note-material-not-found",
            "note-material-source-invalid",
            "note-material-target-invalid",
            "note-material-input-invalid",
            "note-material-asset-invalid",
            "note-material-title-invalid",
            "capture-commit-uncertain",
            "capture-commit-partial",
            "capture-receipt-unavailable",
        ] {
            let body = serde_json::json!({"code": code, "message": "private-path"}).to_string();
            assert_eq!(safe_adapter_failure_code(&body), Some(code));
            assert_eq!(safe_adapter_failure_details(&body), None);
        }
        assert_eq!(
            safe_adapter_failure_code(r#"{"code":"note-material-private-path"}"#),
            None
        );
    }

    #[test]
    fn queued_media_transfer_uses_the_http_accepted_status_line() {
        let response = success_response(202, r#"{"state":"queued"}"#, "request-1", None);
        assert!(response.starts_with("HTTP/1.1 202 Accepted\r\n"));
    }

    #[derive(Default)]
    struct MockAdapter {
        calls: AtomicUsize,
    }

    struct BlockingAdapter {
        entered: Arc<Barrier>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    struct FirstBlockingAdapter {
        block_first: AtomicBool,
        entered: Arc<Barrier>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    struct FailureAdapter;

    struct KnowledgeAdapter {
        service: KnowledgeService,
    }

    impl TransportAdapter for KnowledgeAdapter {
        fn dispatch(&self, method: &str, path: &str, body: Option<&str>) -> AdapterResponse {
            let response = self.service.dispatch_http(method, path, body);
            AdapterResponse {
                status: response.status,
                body: response.body,
            }
        }

        fn collect(&self, _body: &Value) -> Result<Value, String> {
            unreachable!()
        }
    }

    impl TransportAdapter for FailureAdapter {
        fn dispatch(&self, _method: &str, _path: &str, _body: Option<&str>) -> AdapterResponse {
            AdapterResponse {
                status: 500,
                body: r#"{"error":"C:\\Users\\private\\file.webm?token=secret","reason":"network","category":"connect","source":"hover","fingerprint":"A1B2C3D4E5F6","clientRequestId":"extension-action-1"}"#.to_string(),
            }
        }

        fn collect(&self, _body: &Value) -> Result<Value, String> {
            Err("C:\\Users\\private\\luckyray.db".to_string())
        }
    }

    impl TransportAdapter for BlockingAdapter {
        fn dispatch(&self, _method: &str, _path: &str, _body: Option<&str>) -> AdapterResponse {
            self.entered.wait();
            let (lock, condition) = &*self.release;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = condition.wait(released).unwrap();
            }
            AdapterResponse {
                status: 200,
                body: r#"{"ok":true}"#.to_string(),
            }
        }

        fn collect(&self, _body: &Value) -> Result<Value, String> {
            unreachable!()
        }
    }

    impl TransportAdapter for FirstBlockingAdapter {
        fn dispatch(&self, _method: &str, _path: &str, _body: Option<&str>) -> AdapterResponse {
            if self.block_first.swap(false, Ordering::AcqRel) {
                self.entered.wait();
                let (lock, condition) = &*self.release;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = condition.wait(released).unwrap();
                }
            }
            AdapterResponse {
                status: 200,
                body: r#"{"ok":true}"#.to_string(),
            }
        }

        fn collect(&self, _body: &Value) -> Result<Value, String> {
            unreachable!()
        }
    }

    impl TransportAdapter for MockAdapter {
        fn dispatch(&self, method: &str, path: &str, body: Option<&str>) -> AdapterResponse {
            self.calls.fetch_add(1, Ordering::SeqCst);
            AdapterResponse {
                status: 200,
                body: json!({"method": method, "path": path, "body": body}).to_string(),
            }
        }

        fn collect(&self, body: &Value) -> Result<Value, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"ok": true, "id": "fixture", "received": body}))
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "luckyray-local-transport-{label}-{}-{}",
            std::process::id(),
            REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn start_test_server_with(
        label: &str,
        configure: impl FnOnce(&mut ServerConfig),
        _legacy_approver: impl Fn(&str, CapabilityTier, &str, u16) -> bool + Send + Sync + 'static,
    ) -> (LocalTransportHandle, Arc<MockAdapter>, PathBuf) {
        let dir = temp_dir(label);
        let mut config = ServerConfig::test(dir.clone());
        configure(&mut config);
        let adapter = Arc::new(MockAdapter::default());
        let handle = start_server(config, adapter.clone()).unwrap();
        (handle, adapter, dir)
    }

    fn request(port: u16, raw: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let mut response = String::new();
        if let Err(error) = stream.read_to_string(&mut response) {
            assert_eq!(error.kind(), ErrorKind::ConnectionReset);
        }
        response
    }

    fn authorized_request(
        handle: &LocalTransportHandle,
        method: &str,
        path: &str,
        body: Option<&str>,
        origin: Option<&str>,
    ) -> String {
        let config = handle.client_config();
        let credential = origin
            .filter(|value| is_extension_origin(value))
            .and_then(|value| {
                handle
                    .auth
                    .lock()
                    .ok()
                    .and_then(|state| state.extension_credential(value).ok())
            })
            .unwrap_or(config.credential);
        let body = body.unwrap_or("");
        let origin = origin
            .map(|value| format!("Origin: {value}\r\n"))
            .unwrap_or_default();
        request(
            handle.port,
            &format!(
                "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{origin}Authorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                handle.port,
                credential,
                body.len()
            ),
        )
    }

    fn status(response: &str) -> u16 {
        response
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap()
    }

    fn body(response: &str) -> Value {
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap_or("{}")).unwrap()
    }

    #[test]
    fn knowledge_routes_use_the_production_service_over_real_tcp() {
        let app_data = temp_dir("knowledge-tcp-app");
        let vault_root = temp_dir("knowledge-tcp-vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "vault-transport".to_string(),
            name: "Transport".to_string(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let service = KnowledgeService::initialize(&app_data).unwrap();
        service.register_current_vault(&vault).unwrap();
        let handle = start_server(
            ServerConfig::test(app_data),
            Arc::new(KnowledgeAdapter { service }),
        )
        .unwrap();

        let created = authorized_request(
            &handle,
            "POST",
            "/api/v1/knowledge/documents",
            Some(r#"{"title":"TCP note","content":"from transport"}"#),
            None,
        );
        assert_eq!(status(&created), 200);
        let created_body = body(&created);
        assert_eq!(created_body["ok"], true);
        assert_eq!(
            created_body["data"]["documentRef"]["vaultId"],
            "vault-transport"
        );

        let listed = authorized_request(&handle, "GET", "/api/v1/knowledge/documents", None, None);
        assert_eq!(status(&listed), 200);
        assert_eq!(body(&listed)["data"].as_array().unwrap().len(), 1);
        assert_eq!(
            fs::read_to_string(vault_root.join("TCP note.md")).unwrap(),
            "from transport"
        );
    }

    #[test]
    fn note_capture_tcp_replay_is_authenticated_and_does_not_duplicate_writes() {
        let app_data = temp_dir("note-capture-tcp-app");
        let vault_root = temp_dir("note-capture-tcp-vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "vault-capture-tcp".into(),
            name: "Capture TCP".into(),
            root_path: vault_root.to_string_lossy().into(),
            mode: "vault-bound".into(),
            created_at: "2026-09-08T00:00:00Z".into(),
            last_opened_at: "2026-09-08T00:00:00Z".into(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_root.join(".luckyray/vault.json"),
            serde_json::to_vec(&vault).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        backend.knowledge().register_current_vault(&vault).unwrap();
        backend.knowledge().activate_ui_source(&vault.id).unwrap();
        let image_path = app_data.join("download.png");
        fs::write(&image_path, b"tcp capture image bytes").unwrap();
        let asset = backend
            .material_catalog()
            .import_paths(
                &[image_path],
                &crate::materials::MaterialImportOptions::default(),
            )
            .unwrap()
            .value
            .assets[0]
            .clone();
        let handle = start_server(
            ServerConfig::test(app_data),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();
        let prepared = authorized_request(
            &handle,
            "POST",
            "/api/v1/notes/capture-target",
            Some(r#"{"target":"new"}"#),
            None,
        );
        assert_eq!(status(&prepared), 200);
        let mut input = json!({
            "requestId":"tcp-capture-once", "target":"new", "title":"TCP attachment",
            "assetId":asset.id, "binding":body(&prepared)["data"],
        });
        let serialized = input.to_string();
        let first = authorized_request(
            &handle,
            "POST",
            "/api/v1/notes/attach-material",
            Some(&serialized),
            None,
        );
        assert_eq!(status(&first), 200, "{}", first);
        let replay = authorized_request(
            &handle,
            "POST",
            "/api/v1/notes/attach-material",
            Some(&serialized),
            None,
        );
        assert_eq!(status(&replay), 200);
        assert_eq!(body(&replay)["data"], body(&first)["data"]);
        let note = fs::read_to_string(vault_root.join("TCP attachment.md")).unwrap();
        assert_eq!(
            note,
            body(&first)["data"]["attachment"]["markdown"]
                .as_str()
                .unwrap()
        );
        input["title"] = json!("Conflict title");
        let conflict = authorized_request(
            &handle,
            "POST",
            "/api/v1/notes/attach-material",
            Some(&input.to_string()),
            None,
        );
        assert_eq!(status(&conflict), 409);
        assert_eq!(body(&conflict)["error"]["code"], "request-id-conflict");
        assert!(!vault_root.join("Conflict title.md").exists());
        let unauthenticated = request(handle.port, &format!(
                "POST /api/v1/notes/attach-material HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                handle.port, serialized.len(), serialized,
            ));
        assert_eq!(status(&unauthenticated), 401);
        let note_id = body(&first)["data"]["noteId"].clone();
        let target = json!({"target":"existing", "noteId":note_id}).to_string();
        let prepared_text = authorized_request(
            &handle,
            "POST",
            "/api/v1/notes/capture-target",
            Some(&target),
            None,
        );
        assert_eq!(status(&prepared_text), 200);
        let text_input = json!({
            "requestId":"tcp-text-once", "target":"existing", "noteId":note_id,
            "content":"Captured text", "binding":body(&prepared_text)["data"],
        })
        .to_string();
        let text_first = authorized_request(
            &handle,
            "POST",
            "/api/v1/notes/capture",
            Some(&text_input),
            None,
        );
        assert_eq!(status(&text_first), 200, "{}", text_first);
        let text_replay = authorized_request(
            &handle,
            "POST",
            "/api/v1/notes/capture",
            Some(&text_input),
            None,
        );
        assert_eq!(body(&text_first)["data"], body(&text_replay)["data"]);
        assert_eq!(
            fs::read_to_string(vault_root.join("TCP attachment.md")).unwrap(),
            format!("{note}\n\nCaptured text")
        );

        let video_input = json!({"requestId":"tcp-video-once", "url":"file:///not-a-network-request.mp4", "fileName":"test.mp4"}).to_string();
        let video_first = authorized_request(
            &handle,
            "POST",
            "/api/v1/media/transfers",
            Some(&video_input),
            None,
        );
        assert_eq!(status(&video_first), 202);
        let video_replay = authorized_request(
            &handle,
            "POST",
            "/api/v1/media/transfers",
            Some(&video_input),
            None,
        );
        assert_eq!(status(&video_replay), 202);
        assert_eq!(
            body(&video_first)["data"]["transferId"],
            body(&video_replay)["data"]["transferId"]
        );
    }

    #[test]
    fn knowledge_tcp_errors_keep_stable_codes_without_sensitive_details() {
        let app_data = temp_dir("knowledge-tcp-no-vault");
        let service = KnowledgeService::initialize(&app_data).unwrap();
        let handle = start_server(
            ServerConfig::test(app_data),
            Arc::new(KnowledgeAdapter { service }),
        )
        .unwrap();
        let response =
            authorized_request(&handle, "GET", "/api/v1/knowledge/documents", None, None);
        assert_eq!(status(&response), 404);
        let payload = body(&response);
        assert_eq!(payload["ok"], false);
        assert_eq!(payload["error"]["code"], "knowledge-vault-required");
        assert!(!response.contains(std::env::temp_dir().to_string_lossy().as_ref()));
    }

    #[test]
    fn production_legacy_notes_adapter_writes_vault_without_touching_db_notes() {
        let app_data = temp_dir("knowledge-production-adapter-app");
        let vault_root = temp_dir("knowledge-production-adapter-vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "vault-production-adapter".to_string(),
            name: "Production Adapter".to_string(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        backend.knowledge().register_current_vault(&vault).unwrap();
        let connection = rusqlite::Connection::open(backend.db_path()).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('note','note_search','note_link','note_asset_embed','note_ai')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);
        let handle = start_server(
            ServerConfig::test(app_data),
            Arc::new(LegacyLocalTransportAdapter::new(backend.clone())),
        )
        .unwrap();
        let response = authorized_request(
            &handle,
            "POST",
            "/api/v1/notes",
            Some(r#"{"title":"Vault only","content":"not in sqlite"}"#),
            None,
        );
        assert_eq!(status(&response), 200);
        assert_eq!(
            fs::read_to_string(vault_root.join("Vault only.md")).unwrap(),
            "not in sqlite"
        );
        let connection = rusqlite::Connection::open_with_flags(
            backend.db_path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('note','note_search','note_link','note_asset_embed','note_ai')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn production_tool_registry_is_exposed_over_authenticated_tcp() {
        let app_data = temp_dir("tool-registry-red-app");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let handle = start_server(
            ServerConfig::test(app_data),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();

        let response = authorized_request(&handle, "GET", "/api/v1/tools/list", None, None);
        assert_eq!(status(&response), 200);
        let payload = body(&response);
        let ids = payload["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["id"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![
                "capability.run",
                "knowledge.append",
                "knowledge.create",
                "knowledge.read",
                "knowledge.search",
                "knowledge.set_tags",
                "materials.search",
            ]
        );
    }

    #[test]
    fn production_tool_run_uses_registry_after_transport_security_gates() {
        let app_data = temp_dir("tool-registry-run-app");
        let vault_root = temp_dir("tool-registry-run-vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "vault-tool-run".to_string(),
            name: "Tool Run".to_string(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        backend.knowledge().register_current_vault(&vault).unwrap();
        backend
            .knowledge()
            .create_document(&crate::knowledge::KnowledgeCreateInput {
                title: "TCP tool.md".to_string(),
                parent_relative_path: None,
                content: "TCP-TOOL-TOKEN".to_string(),
            })
            .unwrap();
        let handle = start_server(
            ServerConfig::test(app_data),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();

        let run_body = json!({
            "toolId":"knowledge.search",
            "input":{"query":"TCP-TOOL-TOKEN","limit":5}
        })
        .to_string();
        let run = authorized_request(&handle, "POST", "/api/v1/tools/run", Some(&run_body), None);
        assert_eq!(status(&run), 200);
        assert_eq!(body(&run)["data"]["toolId"], "knowledge.search");
        assert_eq!(
            body(&run)["data"]["result"]["documents"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let unknown_field = json!({
            "toolId":"knowledge.search",
            "input":{"query":"x"},
            "unexpected":true
        })
        .to_string();
        let invalid = authorized_request(
            &handle,
            "POST",
            "/api/v1/tools/run",
            Some(&unknown_field),
            None,
        );
        assert_eq!(status(&invalid), 400);
        assert_eq!(body(&invalid)["error"]["code"], "tool-input-invalid");

        let unauthenticated = request(
            handle.port,
            &format!(
                "GET /api/v1/tools/list HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                handle.port
            ),
        );
        assert_eq!(status(&unauthenticated), 401);

        let credential = handle.client_config().credential;
        let evil_origin = request(
            handle.port,
            &format!(
                "GET /api/v1/tools/list HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://evil.example\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n",
                handle.port
            ),
        );
        assert_eq!(status(&evil_origin), 403);
    }

    #[test]
    fn tool_request_ids_are_isolated_by_authenticated_extension_origin() {
        let app_data = temp_dir("tool-principal-origin-app");
        let vault_root = temp_dir("tool-principal-origin-vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "vault-tool-principal-origin".to_string(),
            name: "Tool principal origin".to_string(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        backend.knowledge().register_current_vault(&vault).unwrap();
        let origin_a = "chrome-extension://aaaaaaaaaaaaaaaa";
        let origin_b = "chrome-extension://bbbbbbbbbbbbbbbb";
        let mut config = ServerConfig::test(app_data);
        config
            .extension_origins
            .extend([origin_a.to_string(), origin_b.to_string()]);
        let handle =
            start_server(config, Arc::new(LegacyLocalTransportAdapter::new(backend))).unwrap();
        let bootstrap_a = bootstrap_extension(&handle, origin_a);
        let bootstrap_b = bootstrap_extension(&handle, origin_b);
        let credential_a = body(&bootstrap_a)["data"]["credential"]
            .as_str()
            .unwrap()
            .to_string();
        let credential_b = body(&bootstrap_b)["data"]["credential"]
            .as_str()
            .unwrap()
            .to_string();
        let request_body = json!({
            "toolId":"knowledge.create",
            "input":{
                "expectedVaultId":vault.id,
                "relativePath":"Origin scoped.md",
                "content":"origin scoped",
                "requestId":"same-origin-request"
            }
        })
        .to_string();
        let post = |origin: &str, credential: &str| {
            request(
                handle.port,
                &format!(
                    "POST /api/v1/tools/run HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {origin}\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{request_body}",
                    handle.port,
                    request_body.len()
                ),
            )
        };
        let first = post(origin_a, &credential_a);
        assert_eq!(status(&first), 200);
        let other_principal = post(origin_b, &credential_b);
        assert_eq!(status(&other_principal), 409);
        assert_eq!(
            body(&other_principal)["error"]["code"],
            "knowledge-name-conflict"
        );
        let native_principal = authorized_request(
            &handle,
            "POST",
            "/api/v1/tools/run",
            Some(&request_body),
            None,
        );
        assert_eq!(status(&native_principal), 409);
        assert_eq!(
            body(&native_principal)["error"]["code"],
            "knowledge-name-conflict"
        );
        let replay = post(origin_a, &credential_a);
        assert_eq!(status(&replay), 200);
        assert_eq!(body(&first)["data"], body(&replay)["data"]);
        assert_eq!(fs::read_dir(vault_root).unwrap().count(), 2);
    }

    #[test]
    fn production_capability_routes_use_vault_knowledge_over_authenticated_tcp() {
        let app_data = temp_dir("knowledge-capability-adapter-app");
        let vault_root = temp_dir("knowledge-capability-adapter-vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "vault-capability-adapter".to_string(),
            name: "Capability Adapter".to_string(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        backend.knowledge().register_current_vault(&vault).unwrap();
        let source = backend
            .knowledge()
            .create_document(&crate::knowledge::KnowledgeCreateInput {
                title: "Capability source".to_string(),
                parent_relative_path: None,
                content: "TCP-CAPABILITY search token".to_string(),
            })
            .unwrap();
        let handle = start_server(
            ServerConfig::test(app_data),
            Arc::new(LegacyLocalTransportAdapter::new(backend.clone())),
        )
        .unwrap();

        let listed = authorized_request(&handle, "GET", "/api/capability/list", None, None);
        assert_eq!(status(&listed), 200);
        let listed_body = body(&listed);
        for (id, expected_enabled) in [
            ("skill.summary", true),
            ("skill.search_intent", true),
            ("wf.web_to_note", true),
            ("wf.note_to_summary", false),
        ] {
            let capability = listed_body["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == id)
                .unwrap();
            assert_eq!(capability["available"], true);
            assert_eq!(capability["enabled"], expected_enabled);
            assert_ne!(capability["status"], "unavailable");
        }

        let search_request = json!({
            "id": "skill_search_intent",
            "input": { "text": "TCP-CAPABILITY", "params": { "scope": "notes", "limit": 2 } }
        })
        .to_string();
        let searched = authorized_request(
            &handle,
            "POST",
            "/api/capability/run",
            Some(&search_request),
            None,
        );
        assert_eq!(status(&searched), 200);
        let searched_body = body(&searched);
        assert_eq!(searched_body["ok"], true);
        assert_eq!(searched_body["id"], "skill.search_intent");
        assert_eq!(
            searched_body["result"]["documents"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            searched_body["result"]["documents"][0]["revision"],
            source.revision
        );

        let disabled = json!({
            "id": "wf.note_to_summary",
            "input": { "documentRef": source.summary.document_ref }
        })
        .to_string();
        let disabled_response = authorized_request(
            &handle,
            "POST",
            "/api/capability/run",
            Some(&disabled),
            None,
        );
        assert_eq!(body(&disabled_response)["code"], "capability-disabled");

        let connection = rusqlite::Connection::open_with_flags(
            backend.db_path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('note','note_search','note_link','note_asset_embed','note_ai')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    fn bootstrap_extension(handle: &LocalTransportHandle, origin: &str) -> String {
        let request_body = json!({"extensionOrigin": origin}).to_string();
        request(
            handle.port,
            &format!(
                "POST /api/v1/native/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{request_body}",
                handle.port,
                handle.client_config().credential,
                request_body.len()
            ),
        )
    }

    fn direct_extension_bootstrap(
        handle: &LocalTransportHandle,
        origin: Option<&str>,
        host: Option<&str>,
        content_type: Option<&str>,
    ) -> String {
        let request_body = "{}";
        let origin = origin
            .map(|value| format!("Origin: {value}\r\n"))
            .unwrap_or_default();
        let content_type = content_type
            .map(|value| format!("Content-Type: {value}\r\n"))
            .unwrap_or_default();
        request(
            handle.port,
            &format!(
                "POST /api/v1/extension/bootstrap HTTP/1.1\r\nHost: {}\r\n{origin}{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n{request_body}",
                host.unwrap_or(&format!("127.0.0.1:{}", handle.port)),
                request_body.len()
            ),
        )
    }

    fn extension_request(
        handle: &LocalTransportHandle,
        origin: &str,
        credential: &str,
        path: &str,
    ) -> String {
        request(
            handle.port,
            &format!(
                "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {origin}\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n",
                handle.port
            ),
        )
    }

    fn request_proof(handle: &LocalTransportHandle, origin: &str, client_nonce: &str) -> String {
        let request_body = json!({"clientNonce": client_nonce}).to_string();
        request(
            handle.port,
            &format!(
                "POST /api/v1/proof HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{request_body}",
                handle.port,
                request_body.len()
            ),
        )
    }

    #[test]
    fn health_is_versioned_and_does_not_leak_token() {
        let (server, _, dir) = start_test_server_with(
            "health",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let response = request(
            server.port,
            &format!(
                "GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&response), 200);
        assert_eq!(body(&response)["ok"], true);
        assert!(body(&response)["requestId"]
            .as_str()
            .unwrap()
            .starts_with("lr-"));
        assert!(!response.contains(&server.client_config().credential));
        assert!(!response.contains(&server.auth.lock().unwrap().persisted.master_secret));
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn extension_bootstrap_is_exact_origin_bound_and_unlocks_proof_and_reads() {
        let (server, adapter, dir) = start_test_server_with(
            "extension-bootstrap",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );

        let response = direct_extension_bootstrap(
            &server,
            Some(EDGE_DEV_EXTENSION_ORIGIN),
            None,
            Some("application/json"),
        );
        assert_eq!(status(&response), 200);
        assert!(response.contains(&format!(
            "Access-Control-Allow-Origin: {EDGE_DEV_EXTENSION_ORIGIN}"
        )));
        assert!(!response.contains("Access-Control-Allow-Origin: *"));
        let payload = body(&response);
        let credential = payload["data"]["credential"].as_str().unwrap();
        assert!(is_strict_secret(credential));
        assert_ne!(credential, server.client_config().credential);
        assert!(!response.contains(&server.auth.lock().unwrap().persisted.master_secret));
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);

        assert_eq!(
            status(&request_proof(
                &server,
                EDGE_DEV_EXTENSION_ORIGIN,
                &"a".repeat(64)
            )),
            200
        );
        assert_eq!(
            status(&extension_request(
                &server,
                EDGE_DEV_EXTENSION_ORIGIN,
                credential,
                "/api/v1/folders"
            )),
            200
        );
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);

        let wrong_origin = extension_request(
            &server,
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            credential,
            "/api/v1/folders",
        );
        assert_eq!(status(&wrong_origin), 403);
        let no_origin = request(
            server.port,
            &format!(
                "GET /api/v1/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&no_origin), 200);
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 2);

        let no_origin = direct_extension_bootstrap(&server, None, None, Some("application/json"));
        assert_eq!(status(&no_origin), 403);
        assert!(!no_origin.contains("Access-Control-Allow-Origin"));
        let evil_origin = direct_extension_bootstrap(
            &server,
            Some("https://evil.example"),
            None,
            Some("application/json"),
        );
        assert_eq!(status(&evil_origin), 403);
        assert!(!evil_origin.contains("Access-Control-Allow-Origin"));
        let wrong_extension = direct_extension_bootstrap(
            &server,
            Some("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            None,
            Some("application/json"),
        );
        assert_eq!(status(&wrong_extension), 403);
        assert!(!wrong_extension.contains("Access-Control-Allow-Origin"));

        for invalid in [direct_extension_bootstrap(
            &server,
            Some(EDGE_DEV_EXTENSION_ORIGIN),
            Some("attacker.example"),
            Some("application/json"),
        )] {
            assert!(matches!(status(&invalid), 400 | 403));
        }
        assert_eq!(
            status(&direct_extension_bootstrap(
                &server,
                Some(EDGE_DEV_EXTENSION_ORIGIN),
                None,
                None,
            )),
            415
        );
        let empty_without_type = request(
            server.port,
            &format!(
                "POST /api/v1/extension/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {EDGE_DEV_EXTENSION_ORIGIN}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&empty_without_type), 415);
        let oversized = request(
            server.port,
            &format!(
                "POST /api/v1/extension/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {EDGE_DEV_EXTENSION_ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: 1025\r\nConnection: close\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&oversized), 413);
        let get = request(
            server.port,
            &format!(
                "GET /api/v1/extension/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {EDGE_DEV_EXTENSION_ORIGIN}\r\nConnection: close\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&get), 405);

        let preflight = request(
            server.port,
            &format!(
                "OPTIONS /api/v1/extension/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {EDGE_DEV_EXTENSION_ORIGIN}\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type\r\nConnection: close\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&preflight), 204);
        assert!(preflight.contains(&format!(
            "Access-Control-Allow-Origin: {EDGE_DEV_EXTENSION_ORIGIN}"
        )));
        assert!(!preflight.contains("Access-Control-Allow-Origin: *"));

        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn native_bootstrap_requires_native_auth_exact_allowlist_and_manual_pair_routes_are_gone() {
        let (server, _, dir) = start_test_server_with(
            "native-bootstrap-gate",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let valid_body = json!({"extensionOrigin": EDGE_DEV_EXTENSION_ORIGIN}).to_string();
        let unauthenticated = request(
            server.port,
            &format!(
                "POST /api/v1/native/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{valid_body}",
                server.port,
                valid_body.len()
            ),
        );
        assert_eq!(status(&unauthenticated), 401);

        let unknown_body =
            json!({"extensionOrigin": "chrome-extension://aaaaaaaaaaaaaaaa"}).to_string();
        let unknown = authorized_request(
            &server,
            "POST",
            "/api/v1/native/bootstrap",
            Some(&unknown_body),
            None,
        );
        assert_eq!(status(&unknown), 403);
        assert_eq!(
            body(&unknown)["error"]["code"],
            "extension-origin-forbidden"
        );

        let web_origin = authorized_request(
            &server,
            "POST",
            "/api/v1/native/bootstrap",
            Some(&valid_body),
            Some("http://tauri.localhost"),
        );
        assert_eq!(status(&web_origin), 403);
        assert_eq!(
            body(&web_origin)["error"]["code"],
            "native-origin-forbidden"
        );

        for path in ["/api/v1/pair", "/api/v1/pair/complete"] {
            let response = request(
                server.port,
                &format!(
                    "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}",
                    server.port
                ),
            );
            assert_eq!(status(&response), 404);
        }
        assert_eq!(
            status(&bootstrap_extension(&server, EDGE_DEV_EXTENSION_ORIGIN)),
            200
        );
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn host_origin_and_auth_are_enforced() {
        let (server, adapter, dir) = start_test_server_with(
            "security",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let wrong_host = request(
            server.port,
            "GET /api/folders HTTP/1.1\r\nHost: attacker.example\r\n\r\n",
        );
        assert_eq!(status(&wrong_host), 400);
        assert_eq!(body(&wrong_host)["code"], "host-not-allowed");

        let missing_token = request(
            server.port,
            &format!(
                "GET /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&missing_token), 401);
        assert_eq!(body(&missing_token)["code"], "authentication-required");

        let query_token = request(
            server.port,
            &format!(
                "GET /api/v1/folders?token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                server.client_config().credential,
                server.port
            ),
        );
        assert_eq!(status(&query_token), 401);
        assert_eq!(
            body(&query_token)["error"]["code"],
            "authentication-required"
        );
        assert!(!query_token.contains(&server.client_config().credential));

        let malicious = authorized_request(
            &server,
            "GET",
            "/api/folders",
            None,
            Some("https://evil.example"),
        );
        assert_eq!(status(&malicious), 403);
        assert!(!malicious.contains("Access-Control-Allow-Origin"));
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
        let wrong_token = request(
            server.port,
            &format!(
                "GET /api/v1/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\n\r\n",
                server.port,
                "00".repeat(32)
            ),
        );
        assert_eq!(status(&wrong_token), 401);
        assert_eq!(
            body(&wrong_token)["error"]["code"],
            "authentication-required"
        );
        assert!(!wrong_token.contains(&server.client_config().credential));

        let no_origin = authorized_request(&server, "GET", "/api/v1/folders", None, None);
        assert_eq!(status(&no_origin), 200);
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn native_bootstrap_migrates_legacy_fixture_without_anonymous_writes() {
        let (server, adapter, dir) = start_test_server_with(
            "native-bootstrap",
            |config| {
                config
                    .extension_origins
                    .insert("chrome-extension://abcdefghijklmnop".to_string());
            },
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let origin = "chrome-extension://abcdefghijklmnop";
        let denied = request(
            server.port,
            &format!(
                "POST /collect HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}",
                server.port
            ),
        );
        assert_eq!(status(&denied), 403);
        assert_eq!(body(&denied)["code"], "extension-bootstrap-required");

        let bootstrap = bootstrap_extension(&server, origin);
        assert_eq!(status(&bootstrap), 200);
        let extension_credential = server
            .auth
            .lock()
            .unwrap()
            .extension_credential(origin)
            .unwrap();
        assert_eq!(body(&bootstrap)["data"]["credential"], extension_credential);
        assert!(!bootstrap.contains(&server.client_config().credential));

        let proof_nonce = "78".repeat(32);
        let proof_before_restart = request_proof(&server, origin, &proof_nonce);
        let proof_before_restart_body = body(&proof_before_restart);

        let legacy = authorized_request(
            &server,
            "POST",
            "/collect",
            Some(r#"{"type":"text","content":"fixture"}"#),
            Some(origin),
        );
        assert_eq!(status(&legacy), 200);
        assert_eq!(body(&legacy)["id"], "fixture");
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
        assert!(legacy.contains(&format!("Access-Control-Allow-Origin: {origin}")));
        assert!(!legacy.contains("Access-Control-Allow-Origin: *"));
        let native_credential = server.client_config().credential;
        drop(server);

        let mut restart_config = ServerConfig::test(dir.clone());
        restart_config.extension_origins.insert(origin.to_string());
        let restarted = start_server(restart_config, adapter.clone()).unwrap();
        assert_eq!(restarted.client_config().credential, native_credential);
        let proof_after_restart = request_proof(&restarted, origin, &proof_nonce);
        let proof_after_restart_body = body(&proof_after_restart);
        assert_ne!(
            proof_before_restart_body["data"]["serverNonce"],
            proof_after_restart_body["data"]["serverNonce"]
        );
        assert_ne!(
            proof_before_restart_body["data"]["proof"],
            proof_after_restart_body["data"]["proof"]
        );
        let after_restart =
            authorized_request(&restarted, "GET", "/api/folders", None, Some(origin));
        assert_eq!(status(&after_restart), 200);
        drop(restarted);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn appearance_is_read_only_and_requires_existing_authentication() {
        let (server, adapter, dir) = start_test_server_with(
            "appearance", |_| {}, |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let unauthenticated = request(server.port, &format!(
            "GET /api/v1/extension/appearance HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", server.port,
        ));
        assert_eq!(status(&unauthenticated), 401);
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
        let response = authorized_request(&server, "GET", "/api/v1/extension/appearance", None, Some("http://tauri.localhost"));
        assert_eq!(status(&response), 200);
        assert_eq!(body(&response)["data"]["path"], "/api/extension/appearance");
        assert_eq!(status(&authorized_request(&server, "POST", "/api/v1/extension/appearance", Some("{}"), None)), 405);
        let health = request(server.port, &format!("GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", server.port));
        assert!(!body(&health).to_string().contains("accent"));
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn v1_alias_and_capabilities_use_stable_envelope() {
        let (server, _, dir) = start_test_server_with(
            "v1",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let response = authorized_request(
            &server,
            "GET",
            "/api/v1/folders",
            None,
            Some("http://tauri.localhost"),
        );
        assert_eq!(status(&response), 200);
        assert_eq!(body(&response)["ok"], true);
        assert_eq!(body(&response)["data"]["path"], "/api/folders");
        let capabilities = authorized_request(
            &server,
            "GET",
            "/api/v1/capabilities",
            None,
            Some("http://tauri.localhost"),
        );
        assert_eq!(
            body(&capabilities)["data"]["namespaces"]["canvas"]["status"],
            "reserved"
        );
        assert_eq!(
            body(&capabilities)["data"]["namespaces"]["canvas"]["available"],
            false
        );
        assert_eq!(
            body(&capabilities)["data"]["namespaces"]["knowledge"]["dbNoteMode"],
            false
        );
        assert_eq!(
            body(&capabilities)["data"]["namespaces"]["knowledge"]["source"],
            "vault"
        );
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preflight_is_exact_and_malicious_origin_is_rejected() {
        let (server, _, dir) = start_test_server_with(
            "cors",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        assert_eq!(
            status(&bootstrap_extension(&server, EDGE_DEV_EXTENSION_ORIGIN)),
            200
        );
        let allowed = request(
            server.port,
            &format!(
                "OPTIONS /api/v1/proof HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {}\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: authorization,content-type\r\n\r\n",
                server.port,
                EDGE_DEV_EXTENSION_ORIGIN
            ),
        );
        assert_eq!(status(&allowed), 204);
        assert!(allowed.contains(&format!(
            "Access-Control-Allow-Origin: {EDGE_DEV_EXTENSION_ORIGIN}"
        )));
        assert!(allowed.contains("Vary: Origin"));
        let denied = request(
            server.port,
            &format!(
                "OPTIONS /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://evil.example\r\nAccess-Control-Request-Method: GET\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&denied), 403);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parser_rejects_method_content_type_json_and_unknown_routes() {
        let (server, adapter, dir) = start_test_server_with(
            "parser",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let method = authorized_request(&server, "PUT", "/api/folders", None, None);
        assert_eq!(status(&method), 405);
        let unknown = authorized_request(&server, "GET", "/api/unknown", None, None);
        assert_eq!(status(&unknown), 404);
        let invalid_json = authorized_request(&server, "POST", "/api/folders", Some("{"), None);
        assert_eq!(status(&invalid_json), 400);
        assert_eq!(body(&invalid_json)["code"], "invalid-json");
        let no_content_type = request(
            server.port,
            &format!(
                "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Length: 2\r\n\r\n{{}}",
                server.port, server.client_config().credential
            ),
        );
        assert_eq!(status(&no_content_type), 415);
        let missing_length = request(
            server.port,
            &format!(
                "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\n\r\n",
                server.port, server.client_config().credential
            ),
        );
        assert_eq!(status(&missing_length), 411);
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn adapter_errors_are_sanitized_while_safe_legacy_reason_is_preserved() {
        let dir = temp_dir("sanitized-errors");
        let server =
            start_server(ServerConfig::test(dir.clone()), Arc::new(FailureAdapter)).unwrap();
        let legacy =
            authorized_request(&server, "POST", "/api/video/record/save", Some("{}"), None);
        assert_eq!(status(&legacy), 500);
        assert_eq!(body(&legacy)["reason"], "network");
        assert_eq!(body(&legacy)["category"], "connect");
        assert_eq!(body(&legacy)["source"], "hover");
        assert_eq!(body(&legacy)["fingerprint"], "a1b2c3d4e5f6");
        assert_eq!(body(&legacy)["clientRequestId"], "extension-action-1");
        assert_eq!(body(&legacy)["error"], "Local operation failed");
        assert!(!legacy.contains("Users"));
        assert!(!legacy.contains("secret"));

        let versioned = authorized_request(
            &server,
            "POST",
            "/api/v1/video/record/save",
            Some("{}"),
            None,
        );
        assert_eq!(body(&versioned)["error"]["details"]["reason"], "network");
        assert_eq!(body(&versioned)["error"]["details"]["category"], "connect");
        assert_eq!(body(&versioned)["error"]["details"]["source"], "hover");
        assert_eq!(
            body(&versioned)["error"]["details"]["fingerprint"],
            "a1b2c3d4e5f6"
        );
        assert!(!versioned.contains("private"));
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn import_file_errors_keep_safe_classification_over_real_tcp_without_leaking_raw_message() {
        struct ImportFailureAdapter;
        impl TransportAdapter for ImportFailureAdapter {
            fn dispatch(&self, _method: &str, _path: &str, body: Option<&str>) -> AdapterResponse {
                let requested: Value = serde_json::from_str(body.unwrap()).unwrap();
                let code = requested["fixtureCode"].as_str().unwrap();
                let status = if code == "invalid-param" { 400 } else { 500 };
                let (_, body) = crate::assets_import_file::error_response_parts(
                    status, code, "C:\\Users\\private\\file https://example.test/raw?token=secret",
                );
                AdapterResponse { status, body }
            }
            fn collect(&self, _body: &Value) -> Result<Value, String> { unreachable!() }
        }
        let dir = temp_dir("import-file-safe-errors");
        let server = start_server(ServerConfig::test(dir.clone()), Arc::new(ImportFailureAdapter)).unwrap();
        for (requested, expected, status_code) in [
            ("invalid-param", "invalid-param", 400),
            ("import-failed", "import-failed", 500),
            ("private-error-secret", "adapter-request-failed", 500),
        ] {
            for (route, versioned) in [("/api/v1/assets/import-file", true), ("/api/assets/import-file", false)] {
                let wire = authorized_request(&server, "POST", route, Some(&json!({"fixtureCode": requested}).to_string()), None);
                assert_eq!(status(&wire), status_code);
                let response = body(&wire);
                let actual = if versioned { &response["error"]["code"] } else { &response["code"] };
                assert_eq!(actual, expected);
                let message = if versioned { &response["error"]["message"] } else { &response["error"] };
                if requested == "invalid-param" {
                    assert!(message.as_str().unwrap().contains("File import parameters are invalid"));
                } else if requested == "import-failed" {
                    assert!(message.as_str().unwrap().contains("64 MiB"));
                }
                assert!(!wire.contains("Users") && !wire.contains("private") && !wire.contains("secret") && !wire.contains("example.test"));
            }
        }
        for (route, versioned) in [("/api/v1/folders", true), ("/api/folders", false)] {
            let wire = authorized_request(&server, "POST", route, Some(r#"{"fixtureCode":"invalid-param"}"#), None);
            assert_eq!(status(&wire), 400);
            let response = body(&wire);
            let code = if versioned { &response["error"]["code"] } else { &response["code"] };
            assert_eq!(code, "adapter-request-failed", "nested import codes must not widen another route's allowlist");
            assert!(!wire.contains("secret") && !wire.contains("Users"));
        }
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn oversized_and_incomplete_requests_fail_before_dispatch() {
        let (server, adapter, dir) = start_test_server_with(
            "limits",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let oversized = request(
            server.port,
            &format!(
                "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                server.port,
                server.client_config().credential,
                DEFAULT_BODY_LIMIT + 1
            ),
        );
        assert_eq!(status(&oversized), 413);
        let incomplete = request(
            server.port,
            &format!(
                "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{{}}",
                server.port, server.client_config().credential
            ),
        );
        assert_eq!(status(&incomplete), 400);
        assert_eq!(body(&incomplete)["code"], "incomplete-body");
        let chunked = request(
            server.port,
            &format!(
                "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
                server.port, server.client_config().credential
            ),
        );
        assert_eq!(status(&chunked), 400);
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn request_line_headers_and_content_length_are_bounded_before_allocation() {
        let (server, adapter, dir) = start_test_server_with(
            "head-limits",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let long_path = format!("/api/{}", "a".repeat(MAX_REQUEST_LINE_BYTES + 32));
        let request_line = request(
            server.port,
            &format!(
                "GET {long_path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&request_line), 414);

        let huge_header = request(
            server.port,
            &format!(
                "GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Fill: {}\r\n\r\n",
                server.port,
                "x".repeat(MAX_HEADER_BYTES + 1)
            ),
        );
        assert_eq!(status(&huge_header), 431);

        let negative = request(
            server.port,
            &format!(
                "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: -1\r\n\r\n",
                server.port, server.client_config().credential
            ),
        );
        assert_eq!(status(&negative), 400);
        assert_eq!(body(&negative)["code"], "content-length-invalid");
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    struct MaterialHttpFixtureAdapter {
        catalog: Arc<crate::materials::MaterialCatalog>,
    }

    impl TransportAdapter for MaterialHttpFixtureAdapter {
        fn dispatch(&self, _method: &str, path: &str, body: Option<&str>) -> AdapterResponse {
            assert_eq!(strip_query(path), "/api/assets/import-media");
            let input: Value = serde_json::from_str(body.unwrap()).unwrap();
            assert_eq!(input["mediaType"], "image");
            assert_eq!(input["url"], "https://example.test/hovered.png");
            assert_eq!(input["requestId"], "extension-action-1");
            let content = input["content"].as_str().unwrap().as_bytes().to_vec();
            let source_page = match (
                input["sourcePageUrl"].as_str(), input["sourcePageKind"].as_str(),
            ) {
                (Some(url), Some(kind)) => Some(
                    crate::materials::MaterialSourcePageInput::from_parts(url, kind, None).unwrap(),
                ),
                _ => None,
            };
            let imported = crate::materials::import_downloaded_material_with_source(
                &self.catalog,
                crate::materials::MaterialBytesInput {
                    name: "transport-fixture.png".to_string(),
                    original_path: input["url"].as_str().unwrap().to_string(),
                    mime_type: "image/png".to_string(),
                    description: None,
                    bytes: content,
                },
                &crate::materials::MaterialImportOptions {
                    folder_id: input["targetFolderId"].as_str().map(str::to_string),
                    ..Default::default()
                },
                source_page.as_ref(),
            )
            .unwrap();
            AdapterResponse {
                status: 200,
                body: crate::materials::canonical_import_response(&imported).to_string(),
            }
        }

        fn collect(&self, _body: &Value) -> Result<Value, String> {
            unreachable!()
        }
    }

    #[test]
    fn real_loopback_material_http_adapter_preserves_import_duplicate_and_noop() {
        let catalog = Arc::new(crate::materials::MaterialCatalog::new_for_test());
        let root = catalog.app_data_dir().to_path_buf();
        let folder = catalog
            .create_folder(crate::materials::MaterialFolderInput {
                parent_id: None,
                name: "Browser imports".to_string(),
            })
            .unwrap()
            .value;
        let version_before = catalog.read_change().unwrap().version;
        let config = ServerConfig::test(root.join("transport-auth"));
        let server = start_server(
            config,
            Arc::new(MaterialHttpFixtureAdapter {
                catalog: catalog.clone(),
            }),
        )
        .unwrap();
        let fixture = serde_json::json!({
            "mediaType": "image",
            "url": "https://example.test/hovered.png",
            "targetFolderId": &folder.id,
            "requestId": "extension-action-1",
            "sourcePageUrl": "https://example.test/works/alpha?work=42#slide-3",
            "sourcePageKind": "work-page",
            "content": "same-http-adapter-bytes",
        })
        .to_string();
        let first = authorized_request(
            &server,
            "POST",
            "/api/v1/assets/import-media",
            Some(&fixture),
            None,
        );
        // Import, source-page and metadata triggers may each advance the
        // counter. The transport contract is that duplicate delivery is a noop.
        let version_after_first = catalog.read_change().unwrap().version;
        assert!(version_after_first > version_before);
        let duplicate = authorized_request(
            &server,
            "POST",
            "/api/v1/assets/import-media",
            Some(&fixture),
            None,
        );
        assert_eq!(status(&first), 200);
        assert_eq!(body(&first)["data"]["disposition"], "imported");
        assert!(body(&first)["data"]["asset"]["id"].as_str().is_some());
        assert_eq!(body(&first)["data"]["changed"], true);
        assert_eq!(body(&first)["data"]["asset"]["folderId"], folder.id);
        assert_eq!(body(&duplicate)["data"]["disposition"], "duplicate");
        let asset_id = body(&first)["data"]["asset"]["id"].as_str().unwrap().to_string();
        let reopened = crate::materials::MaterialCatalog::new(
            catalog.db_path().to_path_buf(), catalog.app_data_dir().to_path_buf(),
        );
        let page = reopened.get_source_page(&asset_id).unwrap().unwrap();
        assert_eq!(page.page_url, "https://example.test/works/alpha?work=42#slide-3");
        assert_eq!(page.page_kind, "work-page");
        assert_eq!(
            body(&duplicate)["data"]["asset"]["id"],
            body(&first)["data"]["asset"]["id"]
        );
        assert_eq!(body(&duplicate)["data"]["changed"], false);
        assert_eq!(
            catalog
                .list_assets(&crate::materials::MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(catalog.read_change().unwrap().version, version_after_first);
        drop(server);
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn segmented_request_waits_for_header_and_body_without_early_timeout() {
        let (server, adapter, dir) = start_test_server_with(
            "segmented-upload", |config| config.read_timeout = Duration::from_secs(2),
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let credential = server.client_config().credential;
        let payload = r#"{"text":"split upload"}"#;
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        // Header and body both cross network scheduling gaps, unlike a single
        // prebuffered write. This is the minimal Windows browser failure seam.
        stream.write_all(b"POST /api/notes HTTP/1.1\r\n").unwrap();
        thread::sleep(Duration::from_millis(70));
        write!(stream, "Host: 127.0.0.1:{}\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{{", server.port, payload.len()).unwrap();
        thread::sleep(Duration::from_millis(70));
        stream.write_all(&payload.as_bytes()[1..]).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert_eq!(status(&response), 200, "{response}");
        assert_eq!(body(&response)["body"], payload);
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn incomplete_body_times_out_and_concurrency_is_bounded() {
        let dir = temp_dir("concurrency");
        let mut config = ServerConfig::test(dir.clone());
        config.max_connections = 1;
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let adapter = Arc::new(BlockingAdapter {
            entered: entered.clone(),
            release: release.clone(),
        });
        let server = start_server(config, adapter).unwrap();
        let client = server.client_config();
        let port = server.port;
        let blocked_request = thread::spawn(move || {
            request(
                port,
                &format!(
                    "GET /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\n\r\n",
                    client.credential
                ),
            )
        });
        entered.wait();
        let overloaded = request(
            server.port,
            &format!(
                "GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&overloaded), 503);

        let (lock, condition) = &*release;
        *lock.lock().unwrap() = true;
        condition.notify_all();
        assert_eq!(status(&blocked_request.join().unwrap()), 200);
        drop(server);
        fs::remove_dir_all(dir).unwrap();

        let (timeout_server, _, timeout_dir) = start_test_server_with(
            "timeout",
            |config| config.read_timeout = Duration::from_millis(120),
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let mut held = TcpStream::connect((Ipv4Addr::LOCALHOST, timeout_server.port)).unwrap();
        held.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let began = std::time::Instant::now();
        let mut timeout_response = String::new();
        held.read_to_string(&mut timeout_response).unwrap();
        assert_eq!(status(&timeout_response), 408);
        assert!(began.elapsed() >= Duration::from_millis(80), "a scheduling gap must not become an immediate timeout");
        assert!(began.elapsed() < Duration::from_secs(2), "the real read deadline must remain bounded");
        drop(timeout_server);
        fs::remove_dir_all(timeout_dir).unwrap();
    }

    #[test]
    fn capability_tier_is_default_deny_for_dangerous_route() {
        let (server, adapter, dir) = start_test_server_with(
            "tier",
            |config| {
                config.granted_tier = CapabilityTier::Read;
            },
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let denied = authorized_request(
            &server,
            "POST",
            "/api/assets/import-media",
            Some(r#"{"url":"https://example.test/a.png"}"#),
            None,
        );
        assert_eq!(status(&denied), 403);
        assert_eq!(body(&denied)["code"], "capability-tier-denied");
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn credential_file_is_stable_and_invalid_file_fails_closed() {
        let dir = temp_dir("credentials");
        let first = AuthState::load_or_create(&dir).unwrap();
        let master_secret = first.persisted.master_secret.clone();
        drop(first);
        let second = AuthState::load_or_create(&dir).unwrap();
        assert_eq!(second.persisted.master_secret, master_secret);
        assert!(!fs::read_to_string(dir.join(AUTH_FILE_NAME))
            .unwrap()
            .contains("query"));
        fs::write(
            dir.join(AUTH_FILE_NAME),
            format!(
                r#"{{"version":1,"token":"{}","approvedOrigins":[]}}"#,
                "ab".repeat(32)
            ),
        )
        .unwrap();
        assert!(AuthState::load_or_create(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn listener_shutdown_releases_port_and_exhausted_port_set_is_diagnostic() {
        let (server, _, dir) = start_test_server_with(
            "shutdown",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let released_port = server.port;
        drop(server);
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, released_port)).is_ok());
        fs::remove_dir_all(dir).unwrap();

        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let blocked_dir = temp_dir("occupied");
        let mut config = ServerConfig::test(blocked_dir.clone());
        config.ports = vec![port];
        let error = start_server(config, Arc::new(MockAdapter::default()))
            .err()
            .expect("occupied port set must fail");
        assert!(error.contains("could not bind a loopback port"));
        drop(occupied);
        fs::remove_dir_all(blocked_dir).unwrap();
    }

    #[test]
    fn ambiguous_transfer_encoding_and_non_decimal_content_lengths_are_rejected() {
        let (server, _, dir) = start_test_server_with(
            "strict-framing",
            |_| {},
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let credential = server.client_config().credential;
        for raw_headers in [
            "Transfer-Encoding: identity\r\nContent-Length: 2",
            "Transfer-Encoding: chunked\r\nContent-Length: 2",
            "Content-Length: +1",
            "Content-Length: 1,1",
            "Content-Length: \u{ff11}",
        ] {
            let response = request(
                server.port,
                &format!(
                    "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\n{raw_headers}\r\nConnection: close\r\n\r\n{{}}",
                    server.port
                ),
            );
            assert_eq!(status(&response), 400, "{raw_headers}: {response}");
        }
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn body_budget_and_recording_slot_are_aggregate_and_release_after_handler() {
        let dir = temp_dir("body-budget");
        let mut config = ServerConfig::test(dir.clone());
        config.max_connections = 4;
        config.max_active_body_bytes = 10;
        config.max_recording_requests = 1;
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let adapter = Arc::new(FirstBlockingAdapter {
            block_first: AtomicBool::new(true),
            entered: entered.clone(),
            release: release.clone(),
        });
        let server = start_server(config, adapter).unwrap();
        let port = server.port;
        let credential = server.client_config().credential;
        let first_credential = credential.clone();
        let first = thread::spawn(move || {
            request(
                port,
                &format!(
                    "POST /api/video/record/save HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {first_credential}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}"
                ),
            )
        });
        entered.wait();

        let second_recording = request(
            server.port,
            &format!(
                "POST /api/video/record/save HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&second_recording), 503);
        assert_eq!(body(&second_recording)["code"], "recording-busy");

        let over_budget = request(
            server.port,
            &format!(
                "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: 9\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&over_budget), 503);
        assert_eq!(body(&over_budget)["code"], "body-budget-exhausted");
        assert!(server.max_observed_body_bytes_for_test() <= 10);

        let (lock, condition) = &*release;
        *lock.lock().unwrap() = true;
        condition.notify_all();
        assert_eq!(status(&first.join().unwrap()), 200);

        let after_release =
            authorized_request(&server, "POST", "/api/video/record/save", Some("{}"), None);
        assert_eq!(status(&after_release), 200);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unauthenticated_large_body_is_rejected_before_body_budget_or_read() {
        let (server, _, dir) = start_test_server_with(
            "auth-before-budget",
            |config| config.max_active_body_bytes = 8,
            |_: &str, _: CapabilityTier, _: &str, _: u16| true,
        );
        let response = request(
            server.port,
            &format!(
                "POST /api/video/record/save HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                server.port,
                "00".repeat(32),
                RECORDING_BODY_LIMIT
            ),
        );
        assert_eq!(status(&response), 401);
        assert_eq!(server.max_observed_body_bytes_for_test(), 0);

        let credential = server.client_config().credential;
        let mut timed_out = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port)).unwrap();
        timed_out
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        timed_out
            .write_all(
                format!(
                    "POST /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n",
                    server.port
                )
                .as_bytes(),
            )
            .unwrap();
        let mut timeout_response = String::new();
        timed_out.read_to_string(&mut timeout_response).unwrap();
        assert_eq!(status(&timeout_response), 408);
        let after_timeout = authorized_request(&server, "POST", "/api/folders", Some("{}"), None);
        assert_eq!(status(&after_timeout), 200);
        assert_eq!(server.max_observed_body_bytes_for_test(), 2);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn proof_and_bearer_are_bound_to_exact_extension_origin_and_native_is_separate() {
        let (server, adapter, dir) = start_test_server_with(
            "origin-credentials",
            |config| {
                config.extension_origins.extend([
                    "chrome-extension://aaaaaaaaaaaaaaaa".to_string(),
                    "chrome-extension://bbbbbbbbbbbbbbbb".to_string(),
                ]);
            },
            |_: &str, _, _: &str, _: u16| true,
        );
        let origin_a = "chrome-extension://aaaaaaaaaaaaaaaa";
        let origin_b = "chrome-extension://bbbbbbbbbbbbbbbb";
        let bootstrap_a = bootstrap_extension(&server, origin_a);
        let bootstrap_b = bootstrap_extension(&server, origin_b);
        assert_eq!(status(&bootstrap_a), 200);
        assert_eq!(status(&bootstrap_b), 200);
        let credential_a = body(&bootstrap_a)["data"]["credential"]
            .as_str()
            .unwrap()
            .to_string();
        let credential_b = body(&bootstrap_b)["data"]["credential"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(credential_a, credential_b);
        assert_ne!(credential_a, server.client_config().credential);

        assert_eq!(
            status(&extension_request(
                &server,
                origin_a,
                &credential_a,
                "/api/folders"
            )),
            200
        );
        assert_eq!(
            status(&extension_request(
                &server,
                origin_b,
                &credential_a,
                "/api/folders"
            )),
            401
        );
        let no_origin = request(
            server.port,
            &format!(
                "GET /api/folders HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {credential_a}\r\n\r\n",
                server.port
            ),
        );
        assert_eq!(status(&no_origin), 200);

        let client_nonce = "34".repeat(PROOF_NONCE_BYTES);
        let proof_response = request_proof(&server, origin_a, &client_nonce);
        assert_eq!(status(&proof_response), 200);
        let proof_data = &body(&proof_response)["data"];
        assert_eq!(proof_data["clientNonce"], client_nonce);
        let expected = create_proof(
            &credential_a,
            origin_a,
            server.port,
            &client_nonce,
            proof_data["serverNonce"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(proof_data["proof"], expected);
        assert!(!proof_response.contains(&credential_a));
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 2);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }
}
