//! Desktop-owned Companion Gateway foundation.
//!
//! This authority is deliberately independent from the local transport and DSH.
//! It owns one opt-in TLS listener, one DPAPI-protected Desktop identity, pairing
//! verifier material in the existing Backend database, and an empty authenticated
//! WSS event shell. Authenticated content lives in the narrow content adapter.

mod scopes;
mod diagnostics;
pub(crate) mod endpoint_recovery;
pub(crate) use endpoint_recovery::BindFailure;
#[cfg(test)]
mod scope_tests;
pub(crate) mod content;
pub(crate) mod services;
pub(crate) mod trust_policy;
use trust_policy::AuthorizationMode;

use crate::backend::BackendServices;
#[cfg(feature = "browser-host-runtime")]
use crate::dsh_host::DshHostService;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use qrcode::{types::Color as QrColor, QrCode};
use rand::{rngs::OsRng, RngCore};
use rcgen::generate_simple_self_signed;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ServerConfig as TlsServerConfig, ServerConnection, StreamOwned};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

const PROTOCOL_VERSION: u32 = 1;
const PROTECTED_IDENTITY_FILE: &str = "companion-gateway-identity-v1.dpapi";
const PROTECTED_IDENTITY_VERSION: u32 = 1;
const LISTENER_SETTING_KEY: &str = "companion.gateway.listener.v1";
const MAX_HTTP_HEAD_BYTES: usize = 16 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 16 * 1024;
const MAX_HTTP_REQUEST_DURATION: Duration = Duration::from_secs(5);
const MAX_DEVICE_LABEL_BYTES: usize = 80;
const WEBSOCKET_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const STOP_WAIT: Duration = Duration::from_secs(5);
const LOCAL_TRANSPORT_PORT_START: u16 = 37418;
const LOCAL_TRANSPORT_PORT_END: u16 = 37467;
const DEFAULT_AUDIT_ROWS: usize = 24;
const MAX_AUDIT_ROWS: usize = 50;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_failure: Option<BindFailure>,
}

impl GatewayError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            bind_failure: None,
        }
    }
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for GatewayError {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum GatewayStatus {
    Disabled {
        desktop_instance_id: String,
        certificate_fingerprint: String,
    },
    Running {
        desktop_instance_id: String,
        certificate_fingerprint: String,
        bind_address: String,
        port: u16,
        generation: u64,
        firewall: &'static str,
    },
    Stopping {
        desktop_instance_id: String,
        certificate_fingerprint: String,
        generation: u64,
    },
    RecoveryRequired {
        code: &'static str,
    },
    ResumeFailed {
        bind_address: Option<String>,
        port: Option<u16>,
        code: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        bind_failure: Option<BindFailure>,
    },
}

#[derive(PartialEq, Eq)]
pub(crate) struct PairingEnvelope {
    pub pairing_id: String,
    pub endpoint: String,
    pub desktop_instance_id: String,
    pub certificate_fingerprint: String,
    pub secret: String,
    pub expires_at: String,
    pub protocol_version: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingPresentation {
    pub pairing_id: String,
    pub v: u32,
    pub name: String,
    pub instance: String,
    pub ip: String,
    pub port: u16,
    pub secret: String,
    pub fp: String,
    pub expires_at: String,
    pub qr_size: u16,
    pub qr_path: String,
}

impl Drop for PairingPresentation {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

#[derive(Serialize)]
struct CanonicalQrEnvelope<'a> {
    v: u32,
    name: &'a str,
    instance: &'a str,
    ip: &'a str,
    port: u16,
    secret: &'a str,
    fp: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanIpv4Interface {
    pub interface_id: String,
    pub name: String,
    pub address: String,
    pub prefix_length: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecurityAuditEntry {
    pub action: String,
    pub device_id: Option<String>,
    pub occurred_at: String,
    pub result: String,
}

impl Drop for PairingEnvelope {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairedDevice {
    pub device_id: String,
    pub label: String,
    pub created_at: String,
    pub last_authenticated_at: Option<String>,
    pub revoked_at: Option<String>,
    pub connected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RevokeOutcome {
    Revoked,
    AlreadyRevoked,
    NotFound,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevokeAuthorityResult {
    pub outcome: RevokeOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevokeDeviceResult {
    pub device_id: String,
    pub gateway: RevokeAuthorityResult,
    pub lightseek: Option<RevokeAuthorityResult>,
}

#[derive(Clone)]
struct IdentityMaterial {
    instance_id: String,
    certificate_der: Vec<u8>,
    private_key_der: Zeroizing<Vec<u8>>,
    verifier_key: Zeroizing<Vec<u8>>,
    fingerprint: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProtectedIdentityDocument {
    version: u32,
    instance_id: String,
    certificate_der: String,
    private_key_der: String,
    verifier_key: String,
}

impl Drop for ProtectedIdentityDocument {
    fn drop(&mut self) {
        self.private_key_der.zeroize();
        self.verifier_key.zeroize();
    }
}

trait ProtectedIdentityStore: Send + Sync {
    fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, GatewayError>;
    fn store(&self, plaintext: &[u8]) -> Result<(), GatewayError>;
    fn remove(&self) -> Result<(), GatewayError>;
}

struct DpapiIdentityStore {
    path: PathBuf,
}

impl DpapiIdentityStore {
    fn new(app_data_dir: &Path) -> Self {
        Self {
            path: app_data_dir.join(PROTECTED_IDENTITY_FILE),
        }
    }
}

impl ProtectedIdentityStore for DpapiIdentityStore {
    fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, GatewayError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let protected = fs::read(&self.path).map_err(|_| {
            GatewayError::new(
                "companion-secret-unreadable",
                "Companion protected identity is unreadable",
            )
        })?;
        let plaintext = dpapi_unprotect(&protected)?;
        Ok(Some(Zeroizing::new(plaintext)))
    }

    fn store(&self, plaintext: &[u8]) -> Result<(), GatewayError> {
        let parent = self.path.parent().ok_or_else(|| {
            GatewayError::new(
                "companion-secret-path-invalid",
                "Companion protected identity path is invalid",
            )
        })?;
        fs::create_dir_all(parent).map_err(|_| {
            GatewayError::new(
                "companion-secret-directory-unavailable",
                "Companion protected identity directory is unavailable",
            )
        })?;
        let mut protected = Zeroizing::new(dpapi_protect(plaintext)?);
        let temporary = parent.join(format!(".{PROTECTED_IDENTITY_FILE}.tmp-{}", random_hex(8)));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        let mut file = options.open(&temporary).map_err(|_| {
            GatewayError::new(
                "companion-secret-write-failed",
                "Companion protected identity write failed",
            )
        })?;
        let result = file.write_all(&protected).and_then(|_| file.sync_all());
        protected.zeroize();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(GatewayError::new(
                "companion-secret-write-failed",
                "Companion protected identity write failed",
            ));
        }
        fs::rename(&temporary, &self.path).map_err(|_| {
            let _ = fs::remove_file(&temporary);
            GatewayError::new(
                "companion-secret-install-failed",
                "Companion protected identity install failed",
            )
        })
    }

    fn remove(&self) -> Result<(), GatewayError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err(GatewayError::new(
                "companion-secret-remove-failed",
                "Companion protected identity rollback failed",
            )),
        }
    }
}

#[cfg(windows)]
fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, GatewayError> {
    use windows::core::w;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len().try_into().map_err(|_| {
            GatewayError::new(
                "companion-secret-too-large",
                "Companion identity is too large",
            )
        })?,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            w!("LuckyRay Companion Gateway"),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| {
            GatewayError::new(
                "companion-secret-protect-failed",
                "Windows could not protect the Companion identity",
            )
        })?;
        let output_bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let bytes = output_bytes.to_vec();
        output_bytes.zeroize();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(bytes)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(protected: &[u8]) -> Result<Vec<u8>, GatewayError> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len().try_into().map_err(|_| {
            GatewayError::new(
                "companion-secret-too-large",
                "Companion identity is too large",
            )
        })?,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| {
            GatewayError::new(
                "companion-secret-recovery-required",
                "Companion protected identity is missing or corrupt",
            )
        })?;
        let plaintext = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let bytes = plaintext.to_vec();
        plaintext.zeroize();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi_protect(_plaintext: &[u8]) -> Result<Vec<u8>, GatewayError> {
    Err(GatewayError::new(
        "companion-secret-platform-unsupported",
        "The Companion Gateway foundation currently requires Windows DPAPI",
    ))
}

#[cfg(not(windows))]
fn dpapi_unprotect(_protected: &[u8]) -> Result<Vec<u8>, GatewayError> {
    Err(GatewayError::new(
        "companion-secret-platform-unsupported",
        "The Companion Gateway foundation currently requires Windows DPAPI",
    ))
}

fn open_connection(path: &Path) -> Result<Connection, GatewayError> {
    let connection = Connection::open(path).map_err(|_| {
        GatewayError::new(
            "companion-database-unavailable",
            "Companion metadata database is unavailable",
        )
    })?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| {
            GatewayError::new(
                "companion-database-unavailable",
                "Companion metadata database is unavailable",
            )
        })?;
    Ok(connection)
}

#[derive(Clone)]
struct IdentityMetadata {
    instance_id: String,
    certificate_der: Vec<u8>,
    fingerprint: String,
}

fn read_identity_metadata(db_path: &Path) -> Result<Option<IdentityMetadata>, GatewayError> {
    open_connection(db_path)?
        .query_row(
            "SELECT desktop_instance_id,certificate_der,certificate_fingerprint\r\n             FROM companion_identity WHERE singleton=1",
            [],
            |row| {
                Ok(IdentityMetadata {
                    instance_id: row.get(0)?,
                    certificate_der: row.get(1)?,
                    fingerprint: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|_| {
            GatewayError::new(
                "companion-database-unavailable",
                "Companion identity metadata is unavailable",
            )
        })
}

fn install_identity_metadata(
    db_path: &Path,
    identity: &IdentityMaterial,
) -> Result<(), GatewayError> {
    open_connection(db_path)?
        .execute(
            "INSERT INTO companion_identity(\r\n                singleton,desktop_instance_id,certificate_der,certificate_fingerprint,created_at\r\n             ) VALUES (1,?1,?2,?3,?4)",
            params![
                identity.instance_id,
                identity.certificate_der,
                identity.fingerprint,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|_| {
            GatewayError::new(
                "companion-identity-install-failed",
                "Companion identity metadata could not be installed",
            )
        })?;
    Ok(())
}

fn generate_identity() -> Result<IdentityMaterial, GatewayError> {
    let certified = generate_simple_self_signed(vec!["luckyray-companion.local".to_owned()])
        .map_err(|_| {
            GatewayError::new(
                "companion-certificate-generation-failed",
                "Companion certificate generation failed",
            )
        })?;
    let certificate_der = certified.cert.der().to_vec();
    let private_key_der = Zeroizing::new(certified.key_pair.serialize_der());
    let verifier_key = Zeroizing::new(random_bytes(32));
    let fingerprint = sha256_hex(&certificate_der);
    Ok(IdentityMaterial {
        instance_id: format!("desktop-{}", random_hex(16)),
        certificate_der,
        private_key_der,
        verifier_key,
        fingerprint,
    })
}

fn serialize_identity(identity: &IdentityMaterial) -> Result<Zeroizing<Vec<u8>>, GatewayError> {
    let document = ProtectedIdentityDocument {
        version: PROTECTED_IDENTITY_VERSION,
        instance_id: identity.instance_id.clone(),
        certificate_der: BASE64.encode(&identity.certificate_der),
        private_key_der: BASE64.encode(identity.private_key_der.as_slice()),
        verifier_key: BASE64.encode(identity.verifier_key.as_slice()),
    };
    serde_json::to_vec(&document)
        .map(Zeroizing::new)
        .map_err(|_| {
            GatewayError::new(
                "companion-secret-serialization-failed",
                "Companion protected identity serialization failed",
            )
        })
}

fn deserialize_identity(bytes: &[u8]) -> Result<IdentityMaterial, GatewayError> {
    let document: ProtectedIdentityDocument = serde_json::from_slice(bytes).map_err(|_| {
        GatewayError::new(
            "companion-secret-recovery-required",
            "Companion protected identity is missing or corrupt",
        )
    })?;
    if document.version != PROTECTED_IDENTITY_VERSION {
        return Err(GatewayError::new(
            "companion-secret-recovery-required",
            "Companion protected identity version is unsupported",
        ));
    }
    let certificate_der = BASE64.decode(&document.certificate_der).map_err(|_| {
        GatewayError::new(
            "companion-secret-recovery-required",
            "Companion protected identity certificate is invalid",
        )
    })?;
    let private_key_der =
        Zeroizing::new(BASE64.decode(&document.private_key_der).map_err(|_| {
            GatewayError::new(
                "companion-secret-recovery-required",
                "Companion protected identity key is invalid",
            )
        })?);
    let verifier_key = Zeroizing::new(BASE64.decode(&document.verifier_key).map_err(|_| {
        GatewayError::new(
            "companion-secret-recovery-required",
            "Companion protected verifier key is invalid",
        )
    })?);
    if private_key_der.is_empty() || verifier_key.len() != 32 {
        return Err(GatewayError::new(
            "companion-secret-recovery-required",
            "Companion protected identity is invalid",
        ));
    }
    Ok(IdentityMaterial {
        fingerprint: sha256_hex(&certificate_der),
        instance_id: document.instance_id.clone(),
        certificate_der,
        private_key_der,
        verifier_key,
    })
}

fn load_or_create_identity(
    db_path: &Path,
    store: &dyn ProtectedIdentityStore,
) -> Result<IdentityMaterial, GatewayError> {
    let metadata = read_identity_metadata(db_path)?;
    let protected = store.load()?;
    match (metadata, protected) {
        (None, None) => {
            let identity = generate_identity()?;
            let serialized = serialize_identity(&identity)?;
            store.store(&serialized)?;
            if let Err(error) = install_identity_metadata(db_path, &identity) {
                let _ = store.remove();
                return Err(error);
            }
            Ok(identity)
        }
        (Some(metadata), Some(protected)) => {
            let identity = deserialize_identity(&protected)?;
            if identity.instance_id != metadata.instance_id
                || identity.certificate_der != metadata.certificate_der
                || identity.fingerprint != metadata.fingerprint
            {
                return Err(GatewayError::new(
                    "companion-secret-recovery-required",
                    "Companion protected identity does not match paired-device metadata",
                ));
            }
            Ok(identity)
        }
        _ => Err(GatewayError::new(
            "companion-secret-recovery-required",
            "Companion protected identity and metadata are incomplete",
        )),
    }
}

#[derive(Clone)]
struct GatewayPolicy {
    pairing_ttl: Duration,
    pairing_attempts: u8,
    issue_window: Duration,
    issue_limit: usize,
    device_limit: usize,
    connection_limit: usize,
    lsh_tunnel_limit: usize,
    request_deadline: Duration,
    heartbeat_interval: Duration,
    failure_audit_window: Duration,
    failure_audit_limit: usize,
    authenticated_request_window: Duration,
    authenticated_request_limit: usize,
    #[cfg(test)]
    stop_gate: Option<Arc<TestTransitionGate>>,
    #[cfg(test)]
    event_auth_gate: Option<Arc<TestTransitionGate>>,
    #[cfg(test)]
    relay_body_hold_gate: Option<Arc<TestRelayBodyGate>>,
    #[cfg(test)]
    lsh_mint_hold_gate: Option<Arc<TestOneShotGate>>,
    #[cfg(test)]
    lsh_relay_admission_gate: Option<Arc<TestOneShotGate>>,
    #[cfg(test)]
    services_after_auth_gate: Option<Arc<TestOneShotGate>>,
    #[cfg(test)]
    services_before_material_commit_gate: Option<Arc<TestOneShotGate>>,
    #[cfg(test)]
    relay_body_budget_limit: usize,
}

impl Default for GatewayPolicy {
    fn default() -> Self {
        Self {
            pairing_ttl: Duration::from_secs(120),
            pairing_attempts: 5,
            issue_window: Duration::from_secs(60),
            issue_limit: 3,
            device_limit: 16,
            connection_limit: 64,
            lsh_tunnel_limit: 8,
            request_deadline: MAX_HTTP_REQUEST_DURATION,
            heartbeat_interval: Duration::from_secs(15),
            failure_audit_window: Duration::from_secs(60),
            failure_audit_limit: 64,
            authenticated_request_window: Duration::from_secs(60),
            authenticated_request_limit: 60,
            #[cfg(test)]
            stop_gate: None,
            #[cfg(test)]
            event_auth_gate: None,
            #[cfg(test)]
            relay_body_hold_gate: None,
            #[cfg(test)]
            lsh_mint_hold_gate: None,
            #[cfg(test)]
            lsh_relay_admission_gate: None,
            #[cfg(test)]
            services_after_auth_gate: None,
            #[cfg(test)]
            services_before_material_commit_gate: None,
            #[cfg(test)]
            relay_body_budget_limit: REMOTE_RELAY_BODY_BUDGET,
        }
    }
}

#[cfg(test)]
struct TestTransitionGate {
    entered: std::sync::Barrier,
    release: std::sync::Barrier,
    used: AtomicBool,
}

#[cfg(test)]
impl TestTransitionGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: std::sync::Barrier::new(2),
            release: std::sync::Barrier::new(2),
            used: AtomicBool::new(false),
        })
    }

    fn pause(&self) {
        if self.used.swap(true, Ordering::SeqCst) {
            return;
        }
        self.entered.wait();
        self.release.wait();
    }
}

#[cfg(test)]
struct TestRelayBodyGate {
    entered: AtomicBool,
    release: AtomicBool,
}

#[cfg(test)]
impl TestRelayBodyGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: AtomicBool::new(false),
            release: AtomicBool::new(false),
        })
    }

    fn pause_once(&self) {
        if self.entered.swap(true, Ordering::SeqCst) {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.release.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(self.release.load(Ordering::SeqCst), "relay body fixture was not released");
    }
}

#[cfg(test)]
struct TestOneShotGate {
    armed: AtomicBool,
    entered: AtomicBool,
    release: AtomicBool,
}

#[cfg(test)]
impl TestOneShotGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            armed: AtomicBool::new(false),
            entered: AtomicBool::new(false),
            release: AtomicBool::new(false),
        })
    }

    fn pause_if_armed(&self) {
        if !self.armed.swap(false, Ordering::SeqCst) {
            return;
        }
        self.entered.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.release.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(self.release.load(Ordering::SeqCst), "one-shot fixture was not released");
    }
}

struct PairingTicket {
    authorization_mode: AuthorizationMode,
    id: String,
    digest: [u8; 32],
    expires_at: Instant,
    attempts_remaining: u8,
    generation: u64,
}

#[derive(Default)]
struct PairingBook {
    active: Option<PairingTicket>,
    issued_at: VecDeque<Instant>,
    consumed: VecDeque<[u8; 32]>,
}

impl PairingBook {
    fn issue(
        &mut self,
        policy: &GatewayPolicy,
        generation: u64,
    ) -> Result<(Zeroizing<String>, String), GatewayError> {
        let now = Instant::now();
        while self
            .issued_at
            .front()
            .is_some_and(|at| now.duration_since(*at) >= policy.issue_window)
        {
            self.issued_at.pop_front();
        }
        if self.issued_at.len() >= policy.issue_limit {
            return Err(GatewayError::new(
                "pairing-rate-limited",
                "Pairing issuance is temporarily rate limited",
            ));
        }
        if self
            .active
            .as_ref()
            .is_some_and(|ticket| ticket.expires_at > now)
        {
            return Err(GatewayError::new(
                "pairing-already-active",
                "A pairing bootstrap is already active",
            ));
        }
        let secret = Zeroizing::new(random_hex(32));
        let digest: [u8; 32] = Sha256::digest(secret.as_bytes()).into();
        let expires_at_text = (chrono::Utc::now()
            + chrono::Duration::from_std(policy.pairing_ttl).unwrap_or_default())
        .to_rfc3339();
        self.active = Some(PairingTicket {
            authorization_mode: AuthorizationMode::Manual,
            id: random_hex(16),
            digest,
            expires_at: now + policy.pairing_ttl,
            attempts_remaining: policy.pairing_attempts,
            generation,
        });
        self.issued_at.push_back(now);
        Ok((secret, expires_at_text))
    }

    fn consume(&mut self, presented: &str, generation: u64) -> Result<AuthorizationMode, GatewayError> {
        let digest: [u8; 32] = Sha256::digest(presented.as_bytes()).into();
        if self
            .consumed
            .iter()
            .any(|used| constant_time_eq(used, &digest))
        {
            return Err(GatewayError::new(
                "pairing-replayed",
                "The pairing bootstrap has already been consumed",
            ));
        }
        let now = Instant::now();
        let ticket = self.active.as_mut().ok_or_else(|| {
            GatewayError::new("pairing-required", "No pairing bootstrap is active")
        })?;
        if ticket.expires_at <= now {
            self.active = None;
            return Err(GatewayError::new(
                "pairing-expired",
                "The pairing bootstrap has expired",
            ));
        }
        if ticket.generation != generation {
            self.active = None;
            return Err(GatewayError::new(
                "pairing-generation-retired",
                "The pairing bootstrap belongs to a retired listener generation",
            ));
        }
        if !constant_time_eq(&ticket.digest, &digest) {
            ticket.attempts_remaining = ticket.attempts_remaining.saturating_sub(1);
            if ticket.attempts_remaining == 0 {
                self.active = None;
                return Err(GatewayError::new(
                    "pairing-attempt-limit",
                    "The pairing attempt limit was reached",
                ));
            }
            return Err(GatewayError::new(
                "pairing-secret-invalid",
                "The pairing secret is invalid",
            ));
        }
        let ticket = self.active.take().expect("active pairing ticket");
        self.consumed.push_back(ticket.digest);
        while self.consumed.len() > 32 {
            self.consumed.pop_front();
        }
        Ok(ticket.authorization_mode)
    }

    fn cancel_active(&mut self) {
        self.active = None;
    }

    fn cancel_matching(&mut self, pairing_id: &str) -> bool {
        if self
            .active
            .as_ref()
            .is_some_and(|ticket| ticket.id == pairing_id)
        {
            self.cancel_active();
            true
        } else {
            false
        }
    }
}

struct FailureAuditBudget {
    window_started: Instant,
    detailed_rows: usize,
    summary_persisted: bool,
}

impl Default for FailureAuditBudget {
    fn default() -> Self {
        Self {
            window_started: Instant::now(),
            detailed_rows: 0,
            summary_persisted: false,
        }
    }
}

enum FailureAuditDecision {
    Detail,
    Summary,
    Suppress,
}

impl FailureAuditBudget {
    fn next(&mut self, policy: &GatewayPolicy) -> FailureAuditDecision {
        let now = Instant::now();
        if now.duration_since(self.window_started) >= policy.failure_audit_window {
            self.window_started = now;
            self.detailed_rows = 0;
            self.summary_persisted = false;
        }
        if self.detailed_rows < policy.failure_audit_limit {
            self.detailed_rows += 1;
            return FailureAuditDecision::Detail;
        }
        if !self.summary_persisted {
            self.summary_persisted = true;
            return FailureAuditDecision::Summary;
        }
        FailureAuditDecision::Suppress
    }
}

struct AuthenticatedRequestWindow {
    started_at: Instant,
    accepted: usize,
}

#[derive(Default)]
struct AuthenticatedRequestBudget {
    devices: HashMap<String, AuthenticatedRequestWindow>,
}

impl AuthenticatedRequestBudget {
    fn admit(&mut self, policy: &GatewayPolicy, device_id: &str) -> Result<(), GatewayError> {
        self.admit_limit(policy,device_id,policy.authenticated_request_limit)
    }

    fn admit_limit(&mut self, policy: &GatewayPolicy, device_id: &str, limit: usize) -> Result<(), GatewayError> {
        let now = Instant::now();
        let window =
            self.devices
                .entry(device_id.to_owned())
                .or_insert(AuthenticatedRequestWindow {
                    started_at: now,
                    accepted: 0,
                });
        if now.duration_since(window.started_at) >= policy.authenticated_request_window {
            window.started_at = now;
            window.accepted = 0;
        }
        if window.accepted >= limit {
            diagnostics::rate_limited(policy.authenticated_request_window.saturating_sub(now.duration_since(window.started_at)));
            return Err(GatewayError::new(
                "AUTH_RATE_LIMITED",
                "Authenticated Companion requests are temporarily rate limited",
            ));
        }
        window.accepted += 1;
        Ok(())
    }

    fn remove(&mut self, device_id: &str) {
        self.devices.remove(device_id);
        self.devices.remove(&format!("content:{device_id}"));
    }
}

struct ConnectionRecord {
    socket: TcpStream,
    upstream: Option<TcpStream>,
    device_id: Option<String>,
    remote_relay: bool,
    retired: bool,
}

impl ConnectionRecord {
    fn retire(&mut self) {
        self.retired = true;
        let _ = self.socket.shutdown(Shutdown::Both);
        if let Some(upstream) = self.upstream.as_ref() {
            let _ = upstream.shutdown(Shutdown::Both);
        }
    }
}

#[derive(Default)]
struct ConnectionRegistry {
    next_id: u64,
    entries: HashMap<u64, ConnectionRecord>,
}

impl ConnectionRegistry {
    fn register(&mut self, stream: &TcpStream, limit: usize) -> io::Result<u64> {
        if self.entries.len() >= limit {
            return Err(io::Error::other("companion connection limit reached"));
        }
        self.next_id = self.next_id.saturating_add(1);
        let id = self.next_id;
        self.entries.insert(
            id,
            ConnectionRecord {
                socket: stream.try_clone()?,
                upstream: None,
                device_id: None,
                remote_relay: false,
                retired: false,
            },
        );
        Ok(id)
    }

    fn attach_device(&mut self, id: u64, device_id: &str) {
        if let Some(record) = self.entries.get_mut(&id) {
            record.device_id = Some(device_id.to_owned());
        }
    }

    fn mark_remote_relay(&mut self, id: u64) -> bool {
        if let Some(record) = self.entries.get_mut(&id) {
            if record.retired {
                return false;
            }
            record.remote_relay = true;
            return true;
        }
        false
    }

    fn attach_remote_upstream(&mut self, id: u64, upstream: &TcpStream) -> io::Result<bool> {
        match self.entries.get_mut(&id) {
            Some(record) if record.remote_relay && !record.retired => {
                record.upstream = Some(upstream.try_clone()?);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn unregister(&mut self, id: u64) {
        self.entries.remove(&id);
    }

    fn shutdown_all(&mut self) {
        for record in self.entries.values_mut() {
            record.retire();
        }
    }

    fn shutdown_device(&mut self, device_id: &str) {
        for record in self.entries.values_mut() {
            if record.device_id.as_deref() == Some(device_id) {
                record.retire();
            }
        }
    }

    /// Targeted remote-surface reclaim: kill every open remote-surface relay.
    /// Browser relays are not attributable to a device (their only credential
    /// is the carrier's remote session cookie), so revocation reclaims them
    /// all; the carrier simultaneously invalidates the per-device sessions, so
    /// non-revoked devices reconnect transparently on their next request.
    fn shutdown_remote_relays(&mut self) -> usize {
        let mut dropped = 0;
        for record in self.entries.values_mut() {
            if record.remote_relay {
                record.retire();
                dropped += 1;
            }
        }
        dropped
    }

    fn connected_devices(&self) -> BTreeSet<String> {
        self.entries
            .values()
            .filter_map(|record| record.device_id.clone())
            .collect()
    }
}

struct RunningListener {
    address: SocketAddr,
    generation: u64,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl RunningListener {
    fn is_alive(&self) -> bool {
        !self.stop.load(Ordering::SeqCst) && self.join.as_ref().is_some_and(|join| !join.is_finished())
    }
}

#[derive(Default)]
struct LifecycleState {
    running: Option<RunningListener>,
    stopping_generation: Option<u64>,
    resume_config: Option<ListenerConfig>,
    resume_error: Option<GatewayError>,
}

struct PendingPresentation {
    sender: std::sync::mpsc::Sender<bool>,
    claimed: bool,
    device_id: String,
    deadline: std::time::Instant,
}

struct ControlTransitionGuard<'a> {
    _guard: std::sync::MutexGuard<'a, ()>,
    pending_controls: &'a AtomicUsize,
}

impl Drop for ControlTransitionGuard<'_> {
    fn drop(&mut self) {
        self.pending_controls.fetch_sub(1, Ordering::SeqCst);
    }
}

// Local opt-in only. Identity and credentials keep their existing authorities;
// no pairing material is stored with this listener preference.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListenerConfig {
    bind_address: String,
    port: u16,
}

fn load_listener_config(path: &Path) -> Result<Option<ListenerConfig>, GatewayError> {
    let value: Option<String> = open_connection(path)?
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [LISTENER_SETTING_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| listener_config_error())?;
    let Some(value) = value else { return Ok(None) };
    let config: ListenerConfig =
        serde_json::from_str(&value).map_err(|_| listener_config_error())?;
    if config.port == 0 {
        return Err(listener_config_error());
    }
    validate_bind_selection(&config.bind_address, config.port)?;
    Ok(Some(config))
}

fn store_listener_config(path: &Path, config: Option<&ListenerConfig>) -> Result<(), GatewayError> {
    let connection = open_connection(path)?;
    if let Some(config) = config {
        let value = serde_json::to_string(config).map_err(|_| listener_config_error())?;
        connection.execute(
            "INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![LISTENER_SETTING_KEY, value],
        ).map_err(|_| listener_config_error())?;
    } else {
        connection
            .execute("DELETE FROM settings WHERE key=?1", [LISTENER_SETTING_KEY])
            .map_err(|_| listener_config_error())?;
    }
    Ok(())
}

fn listener_config_error() -> GatewayError {
    GatewayError::new(
        "gateway-listener-config-unavailable",
        "Saved Companion listener configuration is unavailable",
    )
}

#[derive(Clone, Copy)]
struct BindSelection {
    address: Ipv4Addr,
    port: u16,
}

/// The ONE remote origin the carrier's remote authority accepts. Paired
/// clients must resolve this hostname to the Desktop's LAN address (the
/// pairing QR fingerprint pins the TLS certificate for it).
pub(crate) const LSH_REMOTE_ADVERTISED_HOST: &str = "luckyray-companion.local";
const REMOTE_RELAY_TICK: Duration = Duration::from_millis(25);
const REMOTE_RELAY_TICK_SLEEP: Duration = Duration::from_millis(20);
const REMOTE_RELAY_IDLE: Duration = Duration::from_secs(600);
const REMOTE_RELAY_BODY_CAP: usize = 16 * 1024 * 1024;
const REMOTE_RELAY_BODY_BUDGET: usize = 128 * 1024 * 1024;

/// Owns one relayed body's share of the shared budget for the buffer's WHOLE
/// lifetime: dropped when the connection finishes with the request (relay
/// exit or any /v1 response path), never while the buffer is still held.
struct RelayBodyCharge<'a> {
    budget: &'a AtomicUsize,
    declared: usize,
}

impl Drop for RelayBodyCharge<'_> {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.declared, Ordering::AcqRel);
    }
}

#[derive(Clone)]
pub(crate) struct CompanionGateway {
    backend: Arc<BackendServices>,
    request_material_catalog: Option<crate::materials::MaterialCatalog>,
    request_knowledge: Option<crate::knowledge::KnowledgeService>,
    request_material_scope: Option<String>,
    request_vault_scope: Option<String>,
    identity: Result<Arc<IdentityMaterial>, GatewayError>,
    transition: Arc<Mutex<()>>,
    pending_controls: Arc<AtomicUsize>,
    pairing: Arc<Mutex<PairingBook>>,
    lifecycle: Arc<Mutex<LifecycleState>>,
    connections: Arc<Mutex<ConnectionRegistry>>,
    failure_audit: Arc<Mutex<FailureAuditBudget>>,
    authenticated_requests: Arc<Mutex<AuthenticatedRequestBudget>>,
    policy: GatewayPolicy,
    generation: Arc<AtomicU64>,
    content_state: Arc<Mutex<content::notes::ContentState>>,
    /// Optional DSH host handle: the LSH remote surface target. Set once both
    /// services exist; absence simply means the remote surface is unavailable.
    /// Shared cap over relayed (pre-auth) request bodies currently buffered
    /// across ALL connections: bounds the eager per-request allocation the
    /// HTTP parser performs before any credential exists.
    relay_body_budget: Arc<AtomicUsize>,
    lsh_remote_host: Arc<Mutex<Option<Arc<DshHostService>>>>,
    presentation_sink: Arc<Mutex<Option<Arc<dyn Fn(Value) -> bool + Send + Sync>>>>,
    presentation_pending: Arc<Mutex<HashMap<String, PendingPresentation>>>,
    #[cfg(test)]
    lsh_remote_target_override: Arc<Mutex<Option<u16>>>,
}

impl CompanionGateway {
    fn material_catalog(&self) -> crate::materials::MaterialCatalog {
        self.request_material_catalog.clone().unwrap_or_else(|| self.backend.material_catalog())
    }

    fn knowledge(&self) -> crate::knowledge::KnowledgeService {
        self.request_knowledge.clone().unwrap_or_else(|| self.backend.knowledge())
    }

    pub(crate) fn material_scope_id(&self) -> Option<&str> {
        self.request_material_scope.as_deref()
    }

    pub(crate) fn initialize(backend: Arc<BackendServices>) -> Arc<Self> {
        let store = DpapiIdentityStore::new(backend.app_data_dir());
        Self::initialize_with_store(backend, Arc::new(store), GatewayPolicy::default())
    }

    fn initialize_with_store(
        backend: Arc<BackendServices>,
        store: Arc<dyn ProtectedIdentityStore>,
        policy: GatewayPolicy,
    ) -> Arc<Self> {
        let identity = load_or_create_identity(backend.db_path(), store.as_ref()).map(Arc::new);
        let gateway = Arc::new(Self {
            backend,
            request_material_catalog: None,
            request_knowledge: None,
            request_material_scope: None,
            request_vault_scope: None,
            identity,
            transition: Arc::new(Mutex::new(())),
            pending_controls: Arc::new(AtomicUsize::new(0)),
            pairing: Arc::new(Mutex::new(PairingBook::default())),
            lifecycle: Arc::new(Mutex::new(LifecycleState::default())),
            connections: Arc::new(Mutex::new(ConnectionRegistry::default())),
            failure_audit: Arc::new(Mutex::new(FailureAuditBudget::default())),
            authenticated_requests: Arc::new(Mutex::new(AuthenticatedRequestBudget::default())),
            policy,
            generation: Arc::new(AtomicU64::new(0)),
            content_state: Arc::new(Mutex::new(content::notes::ContentState::default())),
            relay_body_budget: Arc::new(AtomicUsize::new(0)),
            lsh_remote_host: Arc::new(Mutex::new(None)),
            presentation_sink: Arc::new(Mutex::new(None)),
            presentation_pending: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(test)]
            lsh_remote_target_override: Arc::new(Mutex::new(None)),
        });
        gateway.restore_enabled_listener();
        gateway
    }

    fn restore_enabled_listener(self: &Arc<Self>) {
        // A missing or damaged protected identity never creates a new listener.
        if self.identity.is_err() {
            return;
        }
        let result = load_listener_config(self.backend.db_path()).and_then(|config| {
            self.lifecycle
                .lock()
                .expect("companion lifecycle mutex")
                .resume_config = config.clone();
            if let Some(config) = config {
                self.start_exclusive(&config.bind_address, Some(config.port))?;
            }
            Ok(())
        });
        if let Err(error) = result {
            self.lifecycle
                .lock()
                .expect("companion lifecycle mutex")
                .resume_error = Some(error);
        }
    }

    fn identity(&self) -> Result<Arc<IdentityMaterial>, GatewayError> {
        self.identity.clone()
    }

    pub(crate) fn status(&self) -> GatewayStatus {
        let identity = match self.identity() {
            Ok(identity) => identity,
            Err(error) => return GatewayStatus::RecoveryRequired { code: error.code },
        };
        let lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
        if let Some(generation) = lifecycle.stopping_generation {
            return GatewayStatus::Stopping {
                desktop_instance_id: identity.instance_id.clone(),
                certificate_fingerprint: identity.fingerprint.clone(),
                generation,
            };
        }
        if let Some(running) = lifecycle.running.as_ref() {
            if !running.is_alive() {
                return GatewayStatus::ResumeFailed {
                    bind_address: Some(running.address.ip().to_string()), port: Some(running.address.port()),
                    code: "gateway-listener-unavailable",
                    bind_failure: None,
                };
            }
            GatewayStatus::Running {
                desktop_instance_id: identity.instance_id.clone(),
                certificate_fingerprint: identity.fingerprint.clone(),
                bind_address: running.address.ip().to_string(),
                port: running.address.port(),
                generation: running.generation,
                firewall: "manual-permission-required",
            }
        } else if let Some(error) = &lifecycle.resume_error {
            GatewayStatus::ResumeFailed {
                bind_address: lifecycle
                    .resume_config
                    .as_ref()
                    .map(|config| config.bind_address.clone()),
                port: lifecycle.resume_config.as_ref().map(|config| config.port),
                code: error.code,
                bind_failure: error.bind_failure.clone(),
            }
        } else {
            GatewayStatus::Disabled {
                desktop_instance_id: identity.instance_id.clone(),
                certificate_fingerprint: identity.fingerprint.clone(),
            }
        }
    }

    pub(crate) fn start(
        self: &Arc<Self>,
        bind_address: &str,
        port: Option<u16>,
    ) -> Result<GatewayStatus, GatewayError> {
        let _transition = self.try_transition()?;
        self.start_recording_failure(bind_address, port)
    }

    fn start_recording_failure(
        self: &Arc<Self>,
        bind_address: &str,
        port: Option<u16>,
    ) -> Result<GatewayStatus, GatewayError> {
        // A listener task that exited cannot remain a healthy/idempotent start.
        // Retire its generation before retrying the saved, explicitly selected endpoint.
        let exited = self.lifecycle.lock().expect("companion lifecycle mutex")
            .running.as_ref().is_some_and(|running| !running.is_alive());
        if exited { self.stop_exclusive()?; }
        let result = self.start_exclusive(bind_address, port);
        if let Ok(status) = &result {
            // PRODUCTION WIRING (R1): a live listener advertises the remote
            // authority for its OWN generation through the real control
            // protocol. A failed push leaves the remote surface honestly
            // unavailable (capability truth), never a broken listener.
            if let GatewayStatus::Running {
                port: running_port,
                generation,
                ..
            } = status
            {
                let _ = self.sync_lsh_remote_authority(Some(*generation), Some(*running_port));
            }
        }
        if let Err(error) = &result {
            let mut lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
            if lifecycle.resume_config.is_some() && lifecycle.running.is_none() {
                lifecycle.resume_error = Some(error.clone());
            }
        }
        result
    }

    fn start_exclusive(
        self: &Arc<Self>,
        bind_address: &str,
        port: Option<u16>,
    ) -> Result<GatewayStatus, GatewayError> {
        let identity = self.identity()?;
        let mut lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
        // No port in the management API means resume the user's saved endpoint,
        // never silently allocate another port for already paired phones.
        let port = match (&lifecycle.resume_config, port) {
            (Some(config), None) if config.bind_address == bind_address => config.port,
            (Some(_), None) => {
                return Err(GatewayError::new(
                    "gateway-resume-address-mismatch",
                    "Stop the saved listener before choosing another interface",
                ))
            }
            (None, _) if lifecycle.resume_error.is_some() => return Err(listener_config_error()),
            (_, port) => port.unwrap_or(0),
        };
        let selection = validate_bind_selection(bind_address, port)?;
        if lifecycle.stopping_generation.is_some() {
            return Err(GatewayError::new(
                "gateway-transition-in-progress",
                "Companion Gateway is still retiring its previous listener",
            ));
        }
        if let Some(running) = lifecycle.running.as_ref() {
            if running.address.ip() == IpAddr::V4(selection.address)
                && (selection.port == 0 || running.address.port() == selection.port)
            {
                return Ok(self.status_from_running(&identity, running));
            }
            return Err(GatewayError::new(
                "gateway-already-running",
                "Companion Gateway is already running on another address",
            ));
        }
        if !self
            .connections
            .lock()
            .expect("companion connections mutex")
            .entries
            .is_empty()
        {
            return Err(GatewayError::new(
                "gateway-stop-incomplete",
                "Retired Companion connections must stop before a listener can start",
            ));
        }
        let listener = endpoint_recovery::bind_selected_endpoint(selection)?;
        listener.set_nonblocking(true).map_err(|_| {
            GatewayError::new(
                "gateway-listener-unavailable",
                "Companion listener could not be configured",
            )
        })?;
        let address = listener.local_addr().map_err(|_| {
            GatewayError::new(
                "gateway-listener-unavailable",
                "Companion listener address is unavailable",
            )
        })?;
        if (LOCAL_TRANSPORT_PORT_START..=LOCAL_TRANSPORT_PORT_END).contains(&address.port()) {
            return Err(GatewayError::new(
                "gateway-local-transport-port-reserved",
                "The selected port is reserved for LuckyRay local transport",
            ));
        }
        let tls = Arc::new(build_tls_server_config(&identity)?);
        let config = ListenerConfig {
            bind_address: address.ip().to_string(),
            port: address.port(),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let gateway = Arc::clone(self);
        let stop_for_thread = Arc::clone(&stop);
        // Spawn before persisting a replacement endpoint, but do not accept
        // connections until its durable opt-in has committed. A spawn/store
        // failure retains the previous endpoint and cannot advertise success.
        let (commit, committed) = std::sync::mpsc::sync_channel::<()>(0);
        let join = thread::Builder::new()
            .name("luckyray-companion-gateway".to_owned())
            .spawn(move || {
                if committed.recv().is_ok() {
                    gateway.accept_loop(listener, tls, stop_for_thread, generation);
                }
            })
            .map_err(|_| {
                GatewayError::new(
                    "gateway-listener-unavailable",
                    "Companion listener task could not start",
                )
            })?;
        if let Err(error) = store_listener_config(self.backend.db_path(), Some(&config)) {
            drop(commit);
            let _ = join.join();
            return Err(error);
        }
        lifecycle.resume_config = Some(config);
        lifecycle.running = Some(RunningListener {
            address,
            generation,
            stop,
            join: Some(join),
        });
        lifecycle.resume_error = None;
        // The receiver is the owned worker above; it cannot exit before this
        // channel is settled. Sending starts its existing accept-loop authority.
        let _ = commit.send(());
        Ok(self.status_from_running(
            &identity,
            lifecycle.running.as_ref().expect("running listener"),
        ))
    }

    fn status_from_running(
        &self,
        identity: &IdentityMaterial,
        running: &RunningListener,
    ) -> GatewayStatus {
        GatewayStatus::Running {
            desktop_instance_id: identity.instance_id.clone(),
            certificate_fingerprint: identity.fingerprint.clone(),
            bind_address: running.address.ip().to_string(),
            port: running.address.port(),
            generation: running.generation,
            firewall: "manual-permission-required",
        }
    }

    pub(crate) fn stop(&self) -> Result<GatewayStatus, GatewayError> {
        let _transition = self.control_transition()?;
        // Explicit Stop opts out; app shutdown and Restart only retire sockets.
        // If opt-out cannot be saved, fail without changing the listener or
        // tickets. The UI can report the still-running state and retry Stop.
        store_listener_config(self.backend.db_path(), None)?;
        self.retire_presentation_offers(None);
        {
            let mut lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
            lifecycle.resume_config = None;
            lifecycle.resume_error = None;
        }
        self.stop_exclusive()
    }

    fn stop_exclusive(&self) -> Result<GatewayStatus, GatewayError> {
        let running = {
            let mut lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
            if lifecycle.stopping_generation.is_some() {
                return Err(GatewayError::new(
                    "gateway-transition-in-progress",
                    "Companion Gateway is already stopping",
                ));
            }
            self.pairing
                .lock()
                .expect("companion pairing mutex")
                .cancel_active();
            let running = lifecycle.running.take();
            lifecycle.stopping_generation = running.as_ref().map(|value| value.generation);
            running
        };
        if let Some(mut running) = running {
            #[cfg(test)]
            if let Some(gate) = self.policy.stop_gate.as_ref() {
                gate.pause();
            }
            running.stop.store(true, Ordering::SeqCst);
            self.connections
                .lock()
                .expect("companion connections mutex")
                .shutdown_all();
            let _ = TcpStream::connect_timeout(&running.address, Duration::from_millis(100));
            if let Some(join) = running.join.take() {
                let deadline = Instant::now() + STOP_WAIT;
                while !join.is_finished() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                if !join.is_finished() || join.join().is_err() {
                    self.lifecycle.lock().expect("companion lifecycle mutex").stopping_generation = None;
                    return Err(GatewayError::new("gateway-stop-timeout", "Companion listener did not stop in time"));
                }
            }
            let deadline = Instant::now() + STOP_WAIT;
            while !self
                .connections
                .lock()
                .expect("companion connections mutex")
                .entries
                .is_empty()
                && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(10));
            }
            let connections_remain = !self
                .connections
                .lock()
                .expect("companion connections mutex")
                .entries
                .is_empty();
            self.lifecycle
                .lock()
                .expect("companion lifecycle mutex")
                .stopping_generation = None;
            if connections_remain {
                return Err(GatewayError::new(
                    "gateway-stop-timeout",
                    "Companion connections did not stop in time",
                ));
            }
            // R4: a stopped gateway generation must invalidate every remote
            // session minted for it — even when DSH stays alive and the next
            // start reuses the port.
            if let Some(host) = self.lsh_remote_host() {
                // The clear frame makes the carrier destroy ALL remote
                // sessions of this gateway generation (cookies + WS).
                let _ = host.set_remote_surface_authority(None, running.generation);
            }
        }
        Ok(self.status())
    }

    pub(crate) fn restart(
        self: &Arc<Self>,
        bind_address: &str,
        port: Option<u16>,
    ) -> Result<GatewayStatus, GatewayError> {
        let _transition = self.control_transition()?;
        self.retire_presentation_offers(None);
        self.stop_exclusive()?;
        self.start_recording_failure(bind_address, port)
    }

    pub(crate) fn shutdown(&self) -> bool {
        let _transition = self
            .transition
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.stop_exclusive().is_ok()
    }

    fn try_transition(&self) -> Result<std::sync::MutexGuard<'_, ()>, GatewayError> {
        if self.pending_controls.load(Ordering::SeqCst) != 0 {
            diagnostics::reason(diagnostics::Reason::ControlPending);
            return Err(GatewayError::new(
                "gateway-transition-in-progress",
                "A Companion Gateway control operation is pending",
            ));
        }
        match self.transition.try_lock() {
            Ok(guard) if self.pending_controls.load(Ordering::SeqCst) == 0 => Ok(guard),
            Ok(_guard) => { diagnostics::reason(diagnostics::Reason::ControlPending); Err(GatewayError::new(
                "gateway-transition-in-progress",
                "A Companion Gateway control operation is pending",
            )) },
            Err(TryLockError::WouldBlock) => { diagnostics::reason(diagnostics::Reason::TransitionBusy); Err(GatewayError::new(
                "gateway-transition-in-progress",
                "A Companion Gateway lifecycle transition is already in progress",
            )) },
            Err(TryLockError::Poisoned(_)) => { diagnostics::reason(diagnostics::Reason::TransitionUnavailable); Err(GatewayError::new(
                "gateway-transition-unavailable",
                "Companion Gateway lifecycle authority is unavailable",
            )) },
        }
    }

    pub(crate) fn issue_pairing(&self) -> Result<PairingEnvelope, GatewayError> {
        self.issue_pairing_authorized(AuthorizationMode::Manual)
    }

    fn issue_pairing_authorized(&self, authorization_mode: AuthorizationMode) -> Result<PairingEnvelope, GatewayError> {
        let identity = self.identity()?;
        let lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
        if lifecycle.stopping_generation.is_some() {
            return Err(GatewayError::new(
                "gateway-transition-in-progress",
                "Companion Gateway is stopping",
            ));
        }
        let running = lifecycle.running.as_ref().ok_or_else(|| {
            GatewayError::new(
                "gateway-not-running",
                "Companion Gateway must be started before pairing",
            )
        })?;
        if !running.is_alive() {
            return Err(GatewayError::new("gateway-listener-unavailable", "The listener must be retried before pairing"));
        }
        let mut pairing = self.pairing.lock().expect("companion pairing mutex");
        let (secret, expires_at) = pairing.issue(&self.policy, running.generation)?;
        pairing.active.as_mut().expect("issued pairing ticket").authorization_mode = authorization_mode;
        if let Err(error) = append_audit(self.backend.db_path(), "pairing-issued", None, "issued") {
            pairing.cancel_active();
            return Err(error);
        }
        Ok(PairingEnvelope {
            pairing_id: pairing
                .active
                .as_ref()
                .expect("issued pairing ticket")
                .id
                .clone(),
            endpoint: format!(
                "https://{}:{}",
                running.address.ip(),
                running.address.port()
            ),
            desktop_instance_id: identity.instance_id.clone(),
            certificate_fingerprint: identity.fingerprint.clone(),
            secret: secret.to_string(),
            expires_at,
            protocol_version: PROTOCOL_VERSION,
        })
    }

    pub(crate) fn issue_pairing_presentation(
        &self,
        replace_existing: bool,
    ) -> Result<PairingPresentation, GatewayError> {
        self.issue_pairing_presentation_authorized(replace_existing, AuthorizationMode::Manual)
    }

    fn issue_pairing_presentation_authorized(&self, replace_existing: bool, authorization_mode: AuthorizationMode) -> Result<PairingPresentation, GatewayError> {
        let _transition = self.try_transition()?;
        if replace_existing {
            self.pairing
                .lock()
                .expect("companion pairing mutex")
                .cancel_active();
        }
        let envelope = self.issue_pairing_authorized(authorization_mode)?;
        let pairing_id = envelope.pairing_id.clone();
        let result = build_pairing_presentation(envelope);
        if result.is_err() {
            self.cancel_pairing(&pairing_id);
        }
        result
    }

    pub(crate) fn cancel_pairing(&self, pairing_id: &str) -> bool {
        self.pairing
            .lock()
            .expect("companion pairing mutex")
            .cancel_matching(pairing_id)
    }

    pub(crate) fn list_devices(&self) -> Result<Vec<PairedDevice>, GatewayError> {
        let connection = open_connection(self.backend.db_path())?;
        let mut statement = connection
            .prepare(
                "SELECT device_id,label,created_at,last_authenticated_at,revoked_at\r\n                 FROM companion_device ORDER BY created_at,device_id",
            )
            .map_err(|_| {
                GatewayError::new(
                    "companion-database-unavailable",
                    "Paired devices are unavailable",
                )
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok(PairedDevice {
                    device_id: row.get(0)?,
                    label: row.get(1)?,
                    created_at: row.get(2)?,
                    last_authenticated_at: row.get(3)?,
                    revoked_at: row.get(4)?,
                    connected: false,
                })
            })
            .map_err(|_| {
                GatewayError::new(
                    "companion-database-unavailable",
                    "Paired devices are unavailable",
                )
            })?;
        let mut devices = rows.collect::<Result<Vec<_>, _>>().map_err(|_| {
            GatewayError::new(
                "companion-database-unavailable",
                "Paired devices are unavailable",
            )
        })?;
        drop(statement);
        drop(connection);
        let connected = self
            .connections
            .lock()
            .expect("companion connections mutex")
            .connected_devices();
        for device in &mut devices {
            device.connected = device.revoked_at.is_none() && connected.contains(&device.device_id);
        }
        Ok(devices)
    }

    pub(crate) fn list_security_audit(
        &self,
        requested_limit: Option<usize>,
    ) -> Result<Vec<SecurityAuditEntry>, GatewayError> {
        let limit = requested_limit
            .unwrap_or(DEFAULT_AUDIT_ROWS)
            .clamp(1, MAX_AUDIT_ROWS);
        let connection = open_connection(self.backend.db_path())?;
        let mut statement = connection
            .prepare(
                "SELECT action,device_id,occurred_at,result\r\n                 FROM companion_security_audit ORDER BY id DESC LIMIT ?1",
            )
            .map_err(|_| {
                GatewayError::new(
                    "companion-audit-unavailable",
                    "Companion security audit is unavailable",
                )
            })?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok(SecurityAuditEntry {
                    action: row.get(0)?,
                    device_id: row.get(1)?,
                    occurred_at: row.get(2)?,
                    result: row.get(3)?,
                })
            })
            .map_err(|_| {
                GatewayError::new(
                    "companion-audit-unavailable",
                    "Companion security audit is unavailable",
                )
            })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|_| {
            GatewayError::new(
                "companion-audit-unavailable",
                "Companion security audit is unavailable",
            )
        })
    }

    pub(crate) fn revoke_device(
        &self,
        device_id: &str,
    ) -> Result<RevokeDeviceResult, GatewayError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = open_connection(self.backend.db_path())?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| {
                GatewayError::new(
                    "companion-database-unavailable",
                    "Paired device revoke could not start",
                )
            })?;
        let current: Option<Option<String>> = transaction
            .query_row(
                "SELECT revoked_at FROM companion_device WHERE device_id=?1",
                [device_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| {
                GatewayError::new(
                    "companion-database-unavailable",
                    "Paired device state is unavailable",
                )
            })?;
        let outcome = match current {
            None => RevokeOutcome::NotFound,
            Some(Some(_)) => RevokeOutcome::AlreadyRevoked,
            Some(None) => {
                transaction
                    .execute(
                        "UPDATE companion_device SET revoked_at=?2 WHERE device_id=?1",
                        params![device_id, now],
                    )
                    .map_err(|_| {
                        GatewayError::new(
                            "companion-database-unavailable",
                            "Paired device revoke failed",
                        )
                    })?;
                transaction
                    .execute(
                        "INSERT INTO companion_security_audit(action,device_id,occurred_at,result)\r\n                         VALUES ('device-revoked',?1,?2,'revoked')",
                        params![device_id, now],
                    )
                    .map_err(|_| {
                        GatewayError::new(
                            "companion-audit-unavailable",
                            "Companion security audit is unavailable",
                        )
                    })?;
                RevokeOutcome::Revoked
            }
        };
        transaction.commit().map_err(|_| {
            GatewayError::new(
                "companion-database-unavailable",
                "Paired device revoke could not commit",
            )
        })?;
        if outcome == RevokeOutcome::Revoked {
            self.authenticated_requests
                .lock()
                .expect("companion authenticated request mutex")
                .remove(device_id);
            self.connections
                .lock()
                .expect("companion connections mutex")
                .shutdown_device(device_id);
        }
        Ok(RevokeDeviceResult {
            device_id: device_id.to_owned(),
            gateway: RevokeAuthorityResult { outcome },
            lightseek: None,
        })
    }

    fn accept_loop(
        self: Arc<Self>,
        listener: TcpListener,
        tls: Arc<TlsServerConfig>,
        stop: Arc<AtomicBool>,
        generation: u64,
    ) {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    if stop.load(Ordering::SeqCst) {
                        let _ = stream.shutdown(Shutdown::Both);
                        break;
                    }
                    if stream.set_nonblocking(true).is_err() {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    let connection_id = match self
                        .connections
                        .lock()
                        .expect("companion connections mutex")
                        .register(&stream, self.policy.connection_limit)
                    {
                        Ok(id) => id,
                        Err(_) => continue,
                    };
                    let gateway = Arc::clone(&self);
                    let tls = Arc::clone(&tls);
                    let stop = Arc::clone(&stop);
                    let spawned = thread::Builder::new()
                        .name("luckyray-companion-connection".to_owned())
                        .spawn(move || {
                            gateway.handle_connection(stream, tls, stop, generation, connection_id);
                            gateway
                                .connections
                                .lock()
                                .expect("companion connections mutex")
                                .unregister(connection_id);
                        });
                    if spawned.is_err() {
                        self.connections
                            .lock()
                            .expect("companion connections mutex")
                            .unregister(connection_id);
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        // An unexpected accept failure retires this generation immediately.
        // Status must not report listening and issue QR codes for a dead task.
        if !stop.swap(true, Ordering::SeqCst) {
            self.connections.lock().expect("companion connections mutex").shutdown_all();
        }
    }

    fn handle_connection(
        &self,
        stream: TcpStream,
        tls: Arc<TlsServerConfig>,
        stop: Arc<AtomicBool>,
        generation: u64,
        connection_id: u64,
    ) {
        let server = match ServerConnection::new(tls) {
            Ok(server) => server,
            Err(_) => return,
        };
        let mut tls = StreamOwned::new(server, stream);
        // R2-3: the shared budget owns the body buffer's WHOLE lifetime. The
        // charge is released only when the connection finishes with the
        // request (guard drop at end of handle_connection) — never right
        // after the parse, while the buffer is still held by a live relay.
        let _request_diagnostics = diagnostics::begin();
        let mut relay_body_added: Option<usize> = None;
        let request = read_http_request_with_body_policy(
            &mut tls,
            Instant::now() + self.policy.request_deadline,
            |head| {
                if services::is_service_route(&head.path) || content::is_content_route(&head.path) {
                    diagnostics::enable(head.headers.get("x-luckyray-request-id").map(String::as_str));
                    diagnostics::stage(diagnostics::Stage::Authenticate);
                }
                if services::is_service_route(&head.path) && matches!(head.method.as_str(), "POST" | "PATCH" | "DELETE" | "PUT") {
                    self.authenticate_event_request(head, connection_id)?;
                    Ok(4 * 1024 * 1024 + 4096)
                } else if content::is_content_route(&head.path) && matches!(head.method.as_str(), "POST" | "PATCH" | "DELETE" | "PUT") {
                    self.authenticate_event_request(head, connection_id)?;
                    Ok(5 * 1024 * 1024)
                } else if !head.path.starts_with("/v1/") {
                    // Remote-surface browser requests (R2): bounded body for
                    // DSH API uploads; relayed, not interpreted. The per-request
                    // cap is charged against a SHARED pre-auth budget so many
                    // header-only connections cannot force unbounded eager
                    // allocation; the charge remains held through the relay.
                    let declared: usize = head
                        .headers
                        .get("content-length")
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0);
                    if declared > REMOTE_RELAY_BODY_CAP {
                        return Err(GatewayError::new(
                            "gateway-request-too-large",
                            "Companion request body is too large",
                        ));
                    }
                    let previous = self.relay_body_budget.fetch_add(declared, Ordering::AcqRel);
                    #[cfg(test)]
                    let budget_limit = self.policy.relay_body_budget_limit;
                    #[cfg(not(test))]
                    let budget_limit = REMOTE_RELAY_BODY_BUDGET;
                    if previous + declared > budget_limit {
                        self.relay_body_budget.fetch_sub(declared, Ordering::AcqRel);
                        return Err(GatewayError::new(
                            "gateway-request-too-large",
                            "The relayed body budget is exhausted",
                        ));
                    }
                    relay_body_added = Some(declared);
                    Ok(REMOTE_RELAY_BODY_CAP.max(declared))
                } else { Ok(MAX_HTTP_BODY_BYTES) }
            },
        );
        let _relay_body_guard = relay_body_added.map(|declared| RelayBodyCharge {
            budget: &self.relay_body_budget,
            declared,
        });
        let _ = tls.sock.set_nonblocking(false);
        let _ = tls.sock.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = tls.sock.set_write_timeout(Some(Duration::from_secs(3)));
        let mut request = match request {
            Ok(request) => request,
            Err(error) => {
                let status = if matches!(error.code, "PAIRING_REQUIRED" | "AUTH_REVOKED" | "AUTH_RATE_LIMITED") { authentication_http_status(&error) } else {400};
                let _ = write_error(&mut tls, status, &error);
                return;
            }
        };
        if content::is_content_route(&request.path) {
            match self.authenticate_event_request(&request, connection_id) {
                Ok(_) => { let _ = content::serve(self, &request, &mut tls, &stop); }
                Err(error) => { let _ = write_error(&mut tls, authentication_http_status(&error), &error); }
            }
            return;
        }
        if services::is_service_route(&request.path) {
            match self.authenticate_event_request(&request, connection_id) {
                Ok(device) => {
                    if request.path == "/v1/services/events/stream" && request.method == "GET" {
                        diagnostics::stage(diagnostics::Stage::Scope);
                        let scoped = match self.scope_for_request(&request) {
                            Ok(scoped) => scoped,
                            Err((status, code)) => { let _ = write_json(&mut tls, status, &json!({"code":code})); return; }
                        };
                        if !is_websocket_upgrade(&request) {
                            let _ = write_json(&mut tls, 400, &json!({"code":"INPUT_INVALID"}));
                        } else if let Err((status, code)) = services::event_authorized(&scoped, &device) {
                            let _ = write_json(&mut tls, status, &json!({"code":code}));
                        } else if websocket_accept(&mut tls, &request).is_ok() {
                            services::event_stream(&scoped, &mut tls, &stop, &device, generation);
                        }
                    } else {
                        let _ = services::serve(self, &request, &mut tls, &device, generation);
                    }
                }
                Err(error) => { let _ = write_error(&mut tls, authentication_http_status(&error), &error); }
            }
            return;
        }
        if !request.path.starts_with("/v1/") {
            // Remote-surface browser request: standard transparent relay.
            self.handle_remote_relay(&request, tls, connection_id, &stop);
            return;
        }
        if request.path.contains('?') {
            let _ = write_error(
                &mut tls,
                400,
                &GatewayError::new(
                    "gateway-url-query-rejected",
                    "Companion credentials and pairing data are not accepted in URLs",
                ),
            );
            return;
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v1/hello") => {
                let _ = write_json(&mut tls, 200, &self.hello_payload());
            }
            ("POST", "/v1/pair") => {
                let result = self.exchange_pairing(&request.body, generation);
                request.body.zeroize();
                match result {
                    Ok(value) => {
                        let _ = write_json(&mut tls, 200, &value);
                    }
                    Err(error) => {
                        let response_error = match self.record_security_failure(
                            "pairing-failed",
                            None,
                            error.code,
                        ) {
                            Ok(()) => error,
                            Err(audit_error) => audit_error,
                        };
                        let _ = write_error(
                            &mut tls,
                            pairing_http_status(&response_error),
                            &response_error,
                        );
                    }
                }
            }
            ("GET", "/v1/session") => match self.authenticate_request(&request) {
                Ok(device) => {
                    let _ = write_json(
                        &mut tls,
                        200,
                        &json!({
                            "ok": true,
                            "protocolVersion": PROTOCOL_VERSION,
                            "deviceId": device.device_id,
                            "deviceLabel": device.label,
                        }),
                    );
                }
                Err(error) => {
                    let _ = write_error(&mut tls, authentication_http_status(&error), &error);
                }
            },
            ("GET", "/v1/events") => {
                if !is_websocket_upgrade(&request) {
                    let _ = write_error(
                        &mut tls,
                        400,
                        &GatewayError::new(
                            "gateway-websocket-upgrade-required",
                            "The event shell requires a WebSocket upgrade",
                        ),
                    );
                    return;
                }
                match self.authenticate_event_request(&request, connection_id) {
                    Ok(device) => {
                        if let Err(error) = append_audit(
                            self.backend.db_path(),
                            "event-connected",
                            Some(&device.device_id),
                            "connected",
                        ) {
                            let _ = write_error(&mut tls, 503, &error);
                            return;
                        }
                        if websocket_accept(&mut tls, &request).is_err() {
                            let _ = append_audit(
                                self.backend.db_path(),
                                "event-disconnected",
                                Some(&device.device_id),
                                "handshake-failed",
                            );
                            return;
                        }
                        websocket_heartbeat_loop(
                            &mut tls,
                            &stop,
                            self.policy.heartbeat_interval,
                            generation,
                        );
                        let _ = append_audit(
                            self.backend.db_path(),
                            "event-disconnected",
                            Some(&device.device_id),
                            "disconnected",
                        );
                    }
                    Err(error) => {
                        let _ = write_error(&mut tls, authentication_http_status(&error), &error);
                    }
                }
            }
            ("GET", "/v1/lsh/remote/state") => match self.authenticate_request(&request) {
                Ok(device) => {
                    let granted = self
                        .lsh_remote_granted(&device.device_id)
                        .unwrap_or(false);
                    // Runtime truth is the DSH host's live flag AND the
                    // gateway listener being up (an auto-restored listener
                    // without a pushed authority reports unavailable because
                    // the host-side flag is only set by a successful push).
                    let listener_live = {
                        let lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
                        lifecycle.running.is_some()
                    };
                    let runtime_available = listener_live
                        && self
                            .lsh_remote_host()
                            .map(|host| host.remote_surface_available())
                            .unwrap_or(false);
                    let _ = write_json(
                        &mut tls,
                        200,
                        &json!({
                            "granted": granted,
                            "runtimeAvailable": runtime_available,
                        }),
                    );
                }
                Err(error) => {
                    let _ = write_error(&mut tls, authentication_http_status(&error), &error);
                }
            },
            ("POST", "/v1/lsh/remote/session") => match self.authenticate_request(&request) {
                Ok(device) => match self.open_lsh_remote_session(&device.device_id) {
                    Ok(value) => {
                        let _ = write_json(&mut tls, 200, &value);
                    }
                    Err(error) => {
                        let _ = write_error(&mut tls, lsh_remote_status(&error), &error);
                    }
                },
                Err(error) => {
                    let _ = write_error(&mut tls, authentication_http_status(&error), &error);
                }
            },
            _ => {
                let _ = write_error(
                    &mut tls,
                    404,
                    &GatewayError::new(
                        "gateway-route-not-found",
                        "The Companion foundation route does not exist",
                    ),
                );
            }
        }
    }

    /// PRODUCTION WIRING (R1): advertise/clear the remote authority for the
    /// CURRENT gateway generation through the real control protocol. Called on
    /// listener start (advertise with the bound port), listener stop (clear),
    /// and revocation paths.
    fn sync_lsh_remote_authority(
        &self,
        generation: Option<u64>,
        port: Option<u16>,
    ) -> Result<(), String> {
        let Some(host) = self.lsh_remote_host() else {
            return Err("lsh-remote-unavailable".to_owned());
        };
        let gateway_generation = generation.unwrap_or(0);
        let advertised = port
            .map(|port| format!("{LSH_REMOTE_ADVERTISED_HOST}:{port}"));
        host.set_remote_surface_authority(advertised, gateway_generation)
    }

    fn lsh_remote_host(&self) -> Option<Arc<DshHostService>> {
        self.lsh_remote_host
            .lock()
            .expect("companion lsh remote mutex")
            .clone()
    }

    fn lsh_remote_relay_target(&self) -> Option<(u16, u64)> {
        #[cfg(test)]
        if let Some(port) = *self.lsh_remote_target_override.lock().expect("companion lsh remote mutex") {
            return Some((port, 0));
        }
        self.lsh_remote_host()?.remote_surface_target()
    }

    /// Wired once from lib.rs after both services exist.
    pub(crate) fn lsh_remote_granted_pub(&self, device_id: &str) -> Result<bool, GatewayError> {
        self.lsh_remote_granted(device_id)
    }

    /// Wired once from lib.rs after both services exist. If a listener was
    /// auto-restored BEFORE this attach (restore_enabled_listener runs in the
    /// constructor, when the DSH host does not exist yet), its remote
    /// authority is synced NOW for the live generation — an auto-restored
    /// listener must not silently stay without one.
    pub(crate) fn attach_presentation_sink(&self, sink: Arc<dyn Fn(Value) -> bool + Send + Sync>) {
        *self.presentation_sink.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sink);
    }

    // UI controls may wait for the bounded presentation handoff, but HTTP
    // workers must remain try-only: Stop joins those workers after acquiring
    // this gate, so letting a worker wait here would deadlock the shutdown.
    fn control_transition(&self) -> Result<ControlTransitionGuard<'_>, GatewayError> {
        self.pending_controls.fetch_add(1, Ordering::SeqCst);
        // Existing SQLite operations can wait up to five seconds. A claimed
        // presentation can spend two seconds awaiting the renderer and then
        // hit that busy timeout while settling its durable receipt.
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            match self.transition.try_lock() {
                Ok(guard) => return Ok(ControlTransitionGuard {
                    _guard: guard, pending_controls: &self.pending_controls,
                }),
                Err(TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(TryLockError::WouldBlock) => {
                    self.pending_controls.fetch_sub(1, Ordering::SeqCst);
                    return Err(GatewayError::new("gateway-transition-in-progress",
                        "A Companion Gateway lifecycle transition is already in progress"));
                }
                Err(TryLockError::Poisoned(_)) => {
                    self.pending_controls.fetch_sub(1, Ordering::SeqCst);
                    return Err(GatewayError::new("gateway-transition-unavailable",
                        "Companion Gateway lifecycle authority is unavailable"));
                }
            }
        }
    }

    fn acknowledge_presentation(&self, request_id: &str, accepted: bool) -> Result<(), GatewayError> {
        let mut offers = self.presentation_pending.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(claimed) = offers.get(request_id)
            .filter(|offer| std::time::Instant::now() >= offer.deadline)
            .map(|offer| offer.claimed) {
            // Keep a claimed offer until its worker classifies the outcome.
            // Removing it here would turn a lost/late ACK into a deletable
            // "unclaimed" opId and permit a duplicate navigation on retry.
            if !claimed { offers.remove(request_id); }
            return Err(GatewayError::new("presentation-request-expired", "Presentation request expired"));
        }
        let offer = offers.get(request_id)
            .ok_or_else(|| GatewayError::new("presentation-request-expired", "Presentation request expired"))?;
        if !offer.claimed {
            return Err(GatewayError::new("presentation-request-unclaimed", "Presentation request was not claimed by the main window"));
        }
        let pending = offers.remove(request_id).expect("claimed presentation offer");
        let _ = pending.sender.send(accepted);
        Ok(())
    }

    fn claim_presentation(&self, request_id: &str) -> Result<u64, GatewayError> {
        let mut pending = self.presentation_pending.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(claimed) = pending.get(request_id)
            .filter(|offer| std::time::Instant::now() >= offer.deadline)
            .map(|offer| offer.claimed) {
            if !claimed { pending.remove(request_id); }
            return Err(GatewayError::new("presentation-request-expired", "Presentation request expired"));
        }
        let offer = pending.get_mut(request_id)
            .ok_or_else(|| GatewayError::new("presentation-request-expired", "Presentation request expired"))?;
        if offer.claimed {
            return Err(GatewayError::new("presentation-request-claimed", "Presentation request already claimed"));
        }
        offer.claimed = true;
        Ok(offer.deadline.saturating_duration_since(std::time::Instant::now()).as_millis() as u64)
    }

    fn retire_presentation_offers(&self, device_id: Option<&str>) {
        let mut pending = self.presentation_pending.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let ids = pending.iter().filter(|(_, offer)|
            device_id.is_none_or(|id| offer.device_id == id))
            .map(|(id, _)| id.clone()).collect::<Vec<_>>();
        for id in ids {
            if let Some(offer) = pending.remove(&id) {
                let _ = offer.sender.send(false);
            }
        }
    }

    pub(crate) fn attach_lsh_remote_host(&self, host: Arc<DshHostService>) {
        *self
            .lsh_remote_host
            .lock()
            .expect("companion lsh remote mutex") = Some(host);
        let live = {
            let lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
            lifecycle
                .running
                .as_ref()
                .map(|running| (running.generation, running.address.port()))
        };
        if let Some((generation, port)) = live {
            let _ = self.sync_lsh_remote_authority(Some(generation), Some(port));
        }
    }

    fn lsh_remote_granted(&self, device_id: &str) -> Result<bool, GatewayError> {
        let connection = open_connection(self.backend.db_path()).map_err(|_| {
            GatewayError::new("companion-database-unavailable", "Device state is unavailable")
        })?;
        trust_policy::lsh_granted(&connection, device_id)
            .map_err(|_| GatewayError::new("companion-database-unavailable", "Device policy is unavailable"))
    }

    /// Explicit, device-scoped LSH remote permission. Granting NEVER touches
    /// pairing; revoking tears down live remote sessions immediately but keeps
    /// the device paired for its existing material/notes grants.
    pub(crate) fn set_lsh_remote_grant(
        &self,
        device_id: &str,
        granted: bool,
    ) -> Result<(), GatewayError> {
        let _transition = self.transition.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = open_connection(self.backend.db_path()).map_err(|_| {
            GatewayError::new("companion-database-unavailable", "Device state is unavailable")
        })?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GatewayError::new("companion-database-unavailable", "Permission transaction unavailable"))?;
        let changed = transaction
            .execute(
                "UPDATE companion_device SET lsh_remote_surface_granted_at = ?1 WHERE device_id = ?2 AND revoked_at IS NULL",
                params![if granted { Some(now) } else { None }, device_id],
            )
            .map_err(|_| {
                GatewayError::new("companion-database-unavailable", "Device state is unavailable")
            })?;
        if changed == 0 {
            return Err(GatewayError::new(
                "companion-device-unknown",
                "The paired device does not exist",
            ));
        }
        trust_policy::set_override(&transaction, device_id, "lsh.remote", "lsh", granted)
            .map_err(|_| GatewayError::new("companion-database-unavailable", "Permission override failed"))?;
        transaction.execute("UPDATE companion_device SET services_permission_revision=services_permission_revision+1 WHERE device_id=?1", [device_id])
            .map_err(|_| GatewayError::new("companion-database-unavailable", "Permission revision failed"))?;
        transaction.commit().map_err(|_| GatewayError::new("companion-database-unavailable", "Permission commit failed"))?;
        self.retire_presentation_offers(Some(device_id));
        let _ = append_audit(
            self.backend.db_path(),
            if granted { "lsh-remote-granted" } else { "lsh-remote-revoked" },
            Some(device_id),
            "lsh-remote-permission",
        );
        if !granted {
            // Immediate reclamation: open remote relays die here; the
            // carrier-side browser sessions (cookies + upgrade sockets) die
            // with them via the control channel.
            self.connections
                .lock()
                .expect("companion connections mutex")
                .shutdown_remote_relays();
            let drop_result = self.lsh_remote_host().map(|host| host.drop_remote_sessions(device_id));
            self.connections.lock().expect("companion connections mutex").shutdown_remote_relays();
            if let Some(result) = drop_result {
                result.map_err(|_| GatewayError::new(
                    "lsh-remote-revoke-unconfirmed",
                    "The remote session could not be confirmed revoked; the remote surface is unavailable",
                ))?;
            }
        }
        Ok(())
    }

    /// Full device revoke also reclaims any live remote-surface state.
    pub(crate) fn revoke_device_with_lsh(&self, device_id: &str) -> Result<RevokeDeviceResult, GatewayError> {
        // A control waits only for the bounded in-flight handoff. A missing
        // renderer ACK cannot keep the paired credential alive indefinitely.
        let _transition = self.control_transition()?;
        let result = self.revoke_device(device_id)?;
        self.retire_presentation_offers(Some(device_id));
        // Relays are unattributed (browser connections carry no device
        // credential), so revocation reclaims them all; the carrier-side
        // session drop for THIS device invalidates its cookies immediately.
        self.connections
            .lock()
            .expect("companion connections mutex")
            .shutdown_remote_relays();
        let drop_result = self.lsh_remote_host().map(|host| host.drop_remote_sessions(device_id));
        self.connections.lock().expect("companion connections mutex").shutdown_remote_relays();
        if let Some(result) = drop_result {
            result.map_err(|_| GatewayError::new(
                "lsh-remote-revoke-unconfirmed",
                "The remote session could not be confirmed revoked; the remote surface is unavailable",
            ))?;
        }
        Ok(result)
    }

    /// Mint a device-scoped single-use remote bootstrap for a granted device
    /// against the LIVE listener generation and the LIVE carrier binding.
    fn open_lsh_remote_session(&self, device_id: &str) -> Result<Value, GatewayError> {
        // HTTP workers must not wait on Stop while Stop waits for those same
        // workers to retire. A busy lifecycle is a retryable 503 instead.
        let _transition = self.try_transition()?;
        if !self.lsh_remote_granted(device_id)? {
            return Err(GatewayError::new(
                "lsh-remote-not-granted",
                "This device has not been granted the LSH remote surface",
            ));
        }
        #[cfg(test)]
        if let Some(gate) = self.policy.lsh_mint_hold_gate.as_ref() {
            gate.pause_if_armed();
        }
        let (bind_port, generation) = {
            let lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
            match lifecycle.running.as_ref() {
                Some(running) => (running.address.port(), running.generation),
                None => {
                    return Err(GatewayError::new(
                        "lsh-remote-unavailable",
                        "The Companion Gateway is not running",
                    ))
                }
            }
        };
        let host = self.lsh_remote_host().ok_or_else(|| {
            GatewayError::new("lsh-remote-unavailable", "The LSH runtime is unavailable")
        })?;
        let bootstrap = host.mint_remote_session(device_id, generation).map_err(|_| {
            GatewayError::new(
                "lsh-remote-unavailable",
                "The LSH remote surface is not available",
            )
        })?;
        Ok(json!({
            "bootstrapPath": bootstrap.bootstrap_path,
            "ref": bootstrap.reference,
            "expiresAtMs": bootstrap.expires_at_ms,
            "carrierGeneration": bootstrap.carrier_generation,
            "origin": format!("https://{}:{}", LSH_REMOTE_ADVERTISED_HOST, bind_port),
            "gatewayGeneration": generation,
        }))
    }

    /// Raw byte tunnel for one granted device connection. The gateway parses
    /// ONLY this request head; every following byte is forwarded verbatim to
    /// the Desktop-owned loopback carrier, which enforces the full remote
    /// authority fence (Host/Origin/cookie) per request.
    /// STANDARD BROWSER RELAY (R2/R3): every request whose path is outside
    /// the Companion `/v1/*` API is a remote-surface browser request. It is
    /// forwarded VERBATIM (original Host/Origin/Cookie/Sec-Fetch headers, its
    /// body, and any WebSocket upgrade) to the Desktop-owned loopback
    /// carrier, whose remote authority fence authenticates it per request.
    /// The relay never fabricates credentials and never buffers responses:
    /// both directions stream with a short tick so server push (chat
    /// streaming, WS frames) is delivered while the phone stays silent.
    fn handle_remote_relay(
        &self,
        request: &HttpRequest,
        mut tls: StreamOwned<ServerConnection, TcpStream>,
        connection_id: u64,
        stop: &Arc<AtomicBool>,
    ) {
        // Enter the revoke-visible set before taking a carrier target.
        let registered = self.connections
            .lock()
            .expect("companion connections mutex")
            .mark_remote_relay(connection_id);
        if !registered {
            self.finish_remote_relay(&mut None, connection_id);
            return;
        }
        // Test-only pause after the body is parsed and charged, before the
        // relay can finish. This proves concurrent requests cannot reuse a
        // buffer's budget while that buffer is still live.
        #[cfg(test)]
        if let Some(gate) = self.policy.relay_body_hold_gate.as_ref() {
            gate.pause_once();
        }
        let carrier_target = match self.lsh_remote_relay_target() {
            Some(target) => target,
            None => {
                let _ = write_error(
                    &mut tls,
                    503,
                    &GatewayError::new(
                        "lsh-remote-unavailable",
                        "The LSH remote surface is not available",
                    ),
                );
                self.finish_remote_relay(&mut None, connection_id);
                return;
            }
        };
        #[cfg(test)]
        if let Some(gate) = self.policy.lsh_relay_admission_gate.as_ref() {
            gate.pause_if_armed();
        }
        if self.lsh_remote_relay_target() != Some(carrier_target) {
            self.finish_remote_relay(&mut None, connection_id);
            return;
        }
        // Rebuild the request head verbatim from the parsed fields. Header
        // order is normalized (semantically irrelevant); values are exact.
        let mut head = format!("{} {} HTTP/1.1\r\n", request.method, request.path);
        for (name, value) in &request.headers {
            if name == "content-length" {
                // Replaced below by exactly ONE content-length derived from
                // the buffered body: llhttp rejects duplicates even when the
                // values are identical.
                continue;
            }
            head.push_str(name);
            head.push_str(": ");
            head.push_str(value);
            head.push_str("\r\n");
        }
        head.push_str(&format!("content-length: {}\r\n", request.body.len()));
        head.push_str("\r\n");
        let mut upstream = match TcpStream::connect(("127.0.0.1", carrier_target.0)) {
            Ok(upstream) => upstream,
            Err(_) => {
                let _ = write_error(
                    &mut tls,
                    502,
                    &GatewayError::new(
                        "lsh-remote-unavailable",
                        "The LSH remote surface is not reachable",
                    ),
                );
                self.finish_remote_relay(&mut None, connection_id);
                return;
            }
        };
        // The registry owns a clone of the upstream as well as the client.
        // Revoke can now retire a paused relay even after loopback connect;
        // a late attach after retirement is refused before any bytes go out.
        let attached = self.connections
            .lock()
            .expect("companion connections mutex")
            .attach_remote_upstream(connection_id, &upstream)
            .unwrap_or(false);
        if !attached || self.lsh_remote_relay_target() != Some(carrier_target) {
            self.finish_remote_relay(&mut Some(upstream), connection_id);
            return;
        }
        let _ = upstream.set_read_timeout(Some(REMOTE_RELAY_TICK));
        let _ = upstream.set_write_timeout(Some(Duration::from_secs(30)));
        let _ = tls.sock.set_read_timeout(Some(REMOTE_RELAY_TICK));
        let _ = tls.sock.set_write_timeout(Some(Duration::from_secs(30)));
        let upstream_write_result: Result<(), io::Error> = (|| {
            upstream.write_all(head.as_bytes())?;
            if !request.body.is_empty() {
                upstream.write_all(&request.body)?;
            }
            Ok(())
        })();
        if upstream_write_result.is_err() {
            self.finish_remote_relay(&mut Some(upstream), connection_id);
            return;
        }
        // Full-duplex tick loop: BOTH directions are drained every pass, so a
        // silent phone never delays carrier-to-client push beyond one tick,
        // and a large client upload streams without extra buffering.
        let mut last_activity = Instant::now();
        let mut client_buffer = [0u8; 16 * 1024];
        let mut upstream_buffer = [0u8; 16 * 1024];
        'relay: loop {
            if stop.load(Ordering::Acquire) || self.lsh_remote_relay_target() != Some(carrier_target) {
                break;
            }
            let mut active = false;
            'client_drain: loop {
                match tls.read(&mut client_buffer) {
                    Ok(0) => break 'relay,
                    Ok(read) => {
                        active = true;
                        last_activity = Instant::now();
                        if upstream.write_all(&client_buffer[..read]).is_err() {
                            break 'relay;
                        }
                        if read < client_buffer.len() {
                            break 'client_drain;
                        }
                    }
                    Err(ref error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            || error.kind() == io::ErrorKind::TimedOut =>
                    {
                        break 'client_drain;
                    }
                    Err(_) => break 'relay,
                }
            }
            'upstream_drain: loop {
                match upstream.read(&mut upstream_buffer) {
                    Ok(0) => break 'relay,
                    Ok(read) => {
                        active = true;
                        last_activity = Instant::now();
                        if tls.write_all(&upstream_buffer[..read]).is_err() {
                            break 'relay;
                        }
                        let _ = tls.flush();
                        if read < upstream_buffer.len() {
                            break 'upstream_drain;
                        }
                    }
                    Err(ref error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            || error.kind() == io::ErrorKind::TimedOut =>
                    {
                        break 'upstream_drain;
                    }
                    Err(_) => break 'relay,
                }
            }
            if !active {
                if last_activity.elapsed() > REMOTE_RELAY_IDLE {
                    break;
                }
                thread::sleep(REMOTE_RELAY_TICK_SLEEP);
            }
        }
        let _ = upstream.shutdown(Shutdown::Both);
        self.connections
            .lock()
            .expect("companion connections mutex")
            .unregister(connection_id);
    }

    /// Release the registry slot (the upstream, when present, is torn down
    /// by the caller via shutdown).
    fn finish_remote_relay(&self, upstream: &mut Option<TcpStream>, connection_id: u64) {
        if let Some(upstream) = upstream.as_ref() {
            let _ = upstream.shutdown(Shutdown::Both);
        }
        self.connections
            .lock()
            .expect("companion connections mutex")
            .unregister(connection_id);
    }
    fn hello_payload(&self) -> Value {
        match self.identity() {
            Ok(identity) => json!({
                "instanceId": identity.instance_id,
                "displayName": "LuckyRay Desktop",
                "platform": "windows",
                "appVersion": env!("CARGO_PKG_VERSION"),
                "protocolVersion": PROTOCOL_VERSION,
                "certificateFingerprint": identity.fingerprint,
                "capabilities": {
                    "pairing": true,
                    "authenticatedEvents": true,
                    "deviceRevocation": true,
                    "lshRemoteSurface": true,
                    "runs": false,
                }
            }),
            Err(error) => json!({
                "protocolVersion": PROTOCOL_VERSION,
                "recovery": {"required": true, "code": error.code}
            }),
        }
    }

    fn exchange_pairing(&self, body: &[u8], generation: u64) -> Result<Value, GatewayError> {
        let identity = self.identity()?;
        let mut request: PairRequest = serde_json::from_slice(body).map_err(|_| {
            GatewayError::new("pairing-request-invalid", "The pairing request is invalid")
        })?;
        let result = (|| {
            let lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
            if lifecycle.stopping_generation.is_some()
                || lifecycle
                    .running
                    .as_ref()
                    .map_or(true, |running| running.generation != generation)
            {
                return Err(GatewayError::new(
                    "pairing-generation-retired",
                    "The pairing bootstrap belongs to a retired listener generation",
                ));
            }
            let mut pairing = self.pairing.lock().expect("companion pairing mutex");
            if request.fingerprint != identity.fingerprint {
                return Err(GatewayError::new(
                    "pairing-fingerprint-mismatch",
                    "The pairing fingerprint does not match this Desktop",
                ));
            }
            let label = validate_device_label(&request.device_label)?;
            let active_count: i64 = open_connection(self.backend.db_path())?
                .query_row(
                    "SELECT COUNT(*) FROM companion_device WHERE revoked_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| {
                    GatewayError::new(
                        "companion-database-unavailable",
                        "Paired device count is unavailable",
                    )
                })?;
            if active_count >= self.policy.device_limit as i64 {
                return Err(GatewayError::new(
                    "pairing-device-limit",
                    "The paired device limit has been reached",
                ));
            }
            let authorization_mode = pairing.consume(&request.secret, generation)?;
            let device_id = format!("device-{}", random_hex(16));
            let device_secret = Zeroizing::new(random_hex(32));
            let verifier = credential_verifier(
                identity.verifier_key.as_slice(),
                &device_id,
                device_secret.as_bytes(),
            )?;
            let now = chrono::Utc::now().to_rfc3339();
            let mut connection = open_connection(self.backend.db_path())?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| {
                    GatewayError::new(
                        "companion-database-unavailable",
                        "Pairing transaction could not start",
                    )
                })?;
            transaction
                .execute(
                    "INSERT INTO companion_device(\r\n                        device_id,label,credential_verifier,created_at,last_authenticated_at,revoked_at\r\n                     ) VALUES (?1,?2,?3,?4,NULL,NULL)",
                    params![device_id, label, verifier.to_vec(), now],
                )
                .map_err(|_| {
                    GatewayError::new(
                        "companion-database-unavailable",
                        "Paired device could not be stored",
                    )
                })?;
            trust_policy::set_mode(&transaction, &device_id, authorization_mode)
                .map_err(|_| GatewayError::new("companion-database-unavailable", "Pairing policy could not be stored"))?;
            transaction
                .execute(
                    "INSERT INTO companion_security_audit(action,device_id,occurred_at,result)\r\n                     VALUES ('pairing-completed',?1,?2,'paired')",
                    params![device_id, now],
                )
                .map_err(|_| {
                    GatewayError::new(
                        "companion-audit-unavailable",
                        "Companion security audit is unavailable",
                    )
                })?;
            transaction.commit().map_err(|_| {
                GatewayError::new(
                    "companion-database-unavailable",
                    "Pairing transaction could not commit",
                )
            })?;
            Ok(json!({
                "deviceId": device_id,
                "credential": format!("{device_id}.{}", device_secret.as_str()),
                "protocolVersion": PROTOCOL_VERSION,
            }))
        })();
        request.secret.zeroize();
        result
    }

    fn authenticate_request(&self, request: &HttpRequest) -> Result<PairedDevice, GatewayError> {
        let presented = request
            .headers
            .get("authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.is_empty());
        let Some(presented) = presented else {
            let error = GatewayError::new("PAIRING_REQUIRED", "Device authentication is required");
            self.record_security_failure("authentication-failed", None, error.code)?;
            return Err(error);
        };
        match self.verify_credential_for_content(presented, content::is_content_route(&request.path)) {
            Ok(device) => Ok(device),
            Err(error) => {
                let device_id = presented
                    .split_once('.')
                    .map(|(id, _)| id)
                    .filter(|id| valid_public_id(id, "device-"));
                self.record_security_failure("authentication-failed", device_id, error.code)?;
                Err(error)
            }
        }
    }

    fn authenticate_event_request(
        &self,
        request: &HttpRequest,
        connection_id: u64,
    ) -> Result<PairedDevice, GatewayError> {
        if let Some(device_id) = presented_device_id(request) {
            self.connections
                .lock()
                .expect("companion connections mutex")
                .attach_device(connection_id, device_id);
        }
        #[cfg(test)]
        if let Some(gate) = self.policy.event_auth_gate.as_ref() {
            gate.pause();
        }
        self.authenticate_request(request)
    }

    fn record_security_failure(
        &self,
        action: &str,
        device_id: Option<&str>,
        result: &str,
    ) -> Result<(), GatewayError> {
        let decision = self
            .failure_audit
            .lock()
            .expect("companion failure audit mutex")
            .next(&self.policy);
        match decision {
            FailureAuditDecision::Detail => {
                append_audit(self.backend.db_path(), action, device_id, result)
            }
            FailureAuditDecision::Summary => append_audit(
                self.backend.db_path(),
                "security-failure-rate-limited",
                None,
                "rate-limited",
            ),
            FailureAuditDecision::Suppress => Ok(()),
        }
    }

    fn verify_credential(&self, presented: &str) -> Result<PairedDevice, GatewayError> {
        self.verify_credential_for_content(presented,false)
    }

    fn verify_credential_for_content(&self, presented: &str, content: bool) -> Result<PairedDevice, GatewayError> {
        let identity = self.identity()?;
        let (device_id, secret) = presented.split_once('.').ok_or_else(|| {
            GatewayError::new("PAIRING_REQUIRED", "Device authentication is invalid")
        })?;
        if !valid_public_id(device_id, "device-") || secret.len() != 64 {
            return Err(GatewayError::new(
                "PAIRING_REQUIRED",
                "Device authentication is invalid",
            ));
        }
        let connection = open_connection(self.backend.db_path())?;
        let row: Option<(String, Vec<u8>, String, Option<String>, Option<String>)> = connection
            .query_row(
                "SELECT label,credential_verifier,created_at,last_authenticated_at,revoked_at\r\n                 FROM companion_device WHERE device_id=?1",
                [device_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| {
                GatewayError::new(
                    "companion-database-unavailable",
                    "Paired device state is unavailable",
                )
            })?;
        let Some((label, verifier, created_at, _, revoked_at)) = row else {
            return Err(GatewayError::new(
                "PAIRING_REQUIRED",
                "Device authentication is invalid",
            ));
        };
        if revoked_at.is_some() {
            return Err(GatewayError::new(
                "AUTH_REVOKED",
                "The paired device credential has been revoked",
            ));
        }
        let expected = credential_verifier(
            identity.verifier_key.as_slice(),
            device_id,
            secret.as_bytes(),
        )?;
        if !constant_time_eq(&verifier, &expected) {
            return Err(GatewayError::new(
                "PAIRING_REQUIRED",
                "Device authentication is invalid",
            ));
        }
        {
            let mut budget=self.authenticated_requests.lock().expect("companion authenticated request mutex");
            if content {
                budget.admit_limit(&self.policy,&format!("content:{device_id}"),self.policy.authenticated_request_limit.saturating_mul(20))?;
            } else {budget.admit(&self.policy,device_id)?;}
        }
        let authenticated_at = chrono::Utc::now().to_rfc3339();
        connection
            .execute(
                "UPDATE companion_device SET last_authenticated_at=?2 WHERE device_id=?1",
                params![device_id, authenticated_at],
            )
            .map_err(|_| {
                GatewayError::new(
                    "companion-database-unavailable",
                    "Paired device authentication could not be recorded",
                )
            })?;
        Ok(PairedDevice {
            device_id: device_id.to_owned(),
            label,
            created_at,
            last_authenticated_at: Some(authenticated_at),
            revoked_at: None,
            connected: false,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PairRequest {
    secret: String,
    fingerprint: String,
    #[serde(default = "default_device_label")]
    device_label: String,
}

impl Drop for PairRequest {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

fn default_device_label() -> String {
    "LuckyRay Mobile".to_owned()
}

#[derive(Default)]
pub(crate) struct HttpRequest {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: HashMap<String, String>,
    pub(crate) body: Vec<u8>,
}

impl Drop for HttpRequest {
    fn drop(&mut self) {
        for value in self.headers.values_mut() {
            value.zeroize();
        }
        self.body.zeroize();
    }
}

fn presented_device_id(request: &HttpRequest) -> Option<&str> {
    request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .and_then(|value| value.split_once('.').map(|(device_id, _)| device_id))
        .filter(|device_id| valid_public_id(device_id, "device-"))
}

#[cfg(test)]
fn read_http_request(stream: &mut impl Read) -> Result<HttpRequest, GatewayError> {
    read_http_request_with_deadline(stream, Instant::now() + MAX_HTTP_REQUEST_DURATION)
}

struct RequestDeadlineReader<'a, R: Read + ?Sized> {
    inner: &'a mut R,
    deadline: Instant,
}

impl<R: Read + ?Sized> Read for RequestDeadlineReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            if Instant::now() >= self.deadline {
                return Err(io::Error::new(
                    ErrorKind::TimedOut,
                    "Companion request deadline elapsed",
                ));
            }
            match self.inner.read(buffer) {
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) =>
                {
                    thread::sleep(Duration::from_millis(5));
                }
                result => return result,
            }
        }
    }
}

fn read_http_request_with_deadline(
    stream: &mut impl Read,
    deadline: Instant,
) -> Result<HttpRequest, GatewayError> {
    read_http_request_with_body_policy(stream, deadline, |_| Ok(MAX_HTTP_BODY_BYTES))
}

fn read_http_request_with_body_policy(
    stream: &mut impl Read,
    deadline: Instant,
    authorize: impl FnOnce(&HttpRequest) -> Result<usize, GatewayError>,
) -> Result<HttpRequest, GatewayError> {
    let mut stream = RequestDeadlineReader {
        inner: stream,
        deadline,
    };
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HTTP_HEAD_BYTES {
            return Err(GatewayError::new(
                "gateway-request-too-large",
                "Companion request headers are too large",
            ));
        }
        stream.read_exact(&mut byte).map_err(request_read_error)?;
        head.push(byte[0]);
    }
    let text = std::str::from_utf8(&head).map_err(|_| {
        GatewayError::new(
            "gateway-request-invalid",
            "Companion request headers are invalid",
        )
    })?;
    let mut lines = text[..text.len() - 4].split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    let remote_browser_path = !path.starts_with("/v1/");
    if parts.next().is_some()
        || !(matches!(method, "GET" | "POST")
            || ((content::is_content_route(path) || services::is_service_route(path)) && matches!(method, "PATCH" | "DELETE" | "PUT"))
            || (remote_browser_path && matches!(method, "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS")))
        || !path.starts_with('/')
        || version != "HTTP/1.1"
    {
        return Err(GatewayError::new(
            "gateway-request-invalid",
            "Companion request line is invalid",
        ));
    }
    let mut headers = HashMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or_else(|| {
            GatewayError::new(
                "gateway-request-invalid",
                "Companion request header is invalid",
            )
        })?;
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() || headers.insert(name, value.trim().to_owned()).is_some() {
            return Err(GatewayError::new(
                "gateway-request-invalid",
                "Companion request has duplicate or empty headers",
            ));
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err(GatewayError::new("gateway-request-invalid", "Transfer encoding is unsupported"));
    }
    let content_length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| {
            GatewayError::new(
                "gateway-request-invalid",
                "Companion content length is invalid",
            )
        })?
        .unwrap_or(0);
    let mut request = HttpRequest {method: method.to_owned(), path: path.to_owned(), headers, body: Vec::new()};
    let limit = authorize(&request)?;
    if content_length > limit {
        return Err(GatewayError::new(
            "gateway-request-too-large",
            "Companion request body is too large",
        ));
    }
    request.body = vec![0u8; content_length];
    stream.read_exact(&mut request.body).map_err(request_read_error)?;
    Ok(request)
}

fn request_read_error(error: io::Error) -> GatewayError {
    if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
        GatewayError::new(
            "gateway-request-timeout",
            "Companion request exceeded its total read deadline",
        )
    } else {
        GatewayError::new(
            "gateway-request-unreadable",
            "Companion request is unreadable",
        )
    }
}

fn write_json(stream: &mut impl Write, status: u16, value: &Value) -> io::Result<()> {
    let body =
        Zeroizing::new(serde_json::to_vec(value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec()));
    let reason = match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        410 => "Gone",
        413 => "Content Too Large",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let diagnostic_headers = diagnostics::response_headers(status);
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n{diagnostic_headers}\r\n",
        body.len()
    )?;
    stream.write_all(&body)?;
    stream.flush()
}

fn lsh_remote_status(error: &GatewayError) -> u16 {
    match error.code {
        "lsh-remote-not-granted" => 403,
        "lsh-remote-tunnel-limit" => 429,
        _ => 503,
    }
}

fn authentication_http_status(error: &GatewayError) -> u16 {
    match error.code {
        "PAIRING_REQUIRED" | "AUTH_REVOKED" => 401,
        "AUTH_RATE_LIMITED" => 429,
        _ => 503,
    }
}

fn pairing_http_status(error: &GatewayError) -> u16 {
    match error.code {
        "pairing-expired" | "pairing-generation-retired" => 410,
        "pairing-replayed" | "pairing-device-limit" => 409,
        "pairing-attempt-limit" | "pairing-rate-limited" => 429,
        "pairing-request-invalid"
        | "pairing-device-label-invalid"
        | "pairing-fingerprint-mismatch"
        | "pairing-required"
        | "pairing-secret-invalid" => 401,
        _ => 503,
    }
}

fn write_error(stream: &mut impl Write, status: u16, error: &GatewayError) -> io::Result<()> {
    write_json(
        stream,
        status,
        &json!({"ok": false, "code": error.code, "message": error.message}),
    )
}

fn is_websocket_upgrade(request: &HttpRequest) -> bool {
    request
        .headers
        .get("upgrade")
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        && request.headers.get("connection").is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
        })
        && request
            .headers
            .get("sec-websocket-version")
            .map(String::as_str)
            == Some("13")
        && request
            .headers
            .get("sec-websocket-key")
            .is_some_and(|value| {
                BASE64
                    .decode(value)
                    .is_ok_and(|decoded| decoded.len() == 16)
            })
}

fn websocket_accept(stream: &mut impl Write, request: &HttpRequest) -> io::Result<()> {
    let key = request
        .headers
        .get("sec-websocket-key")
        .expect("validated WebSocket key");
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(WEBSOCKET_GUID);
    let accept = BASE64.encode(hasher.finalize());
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    )?;
    stream.flush()
}

fn websocket_heartbeat_loop(
    stream: &mut StreamOwned<ServerConnection, TcpStream>,
    stop: &AtomicBool,
    heartbeat_interval: Duration,
    generation: u64,
) {
    let _ = stream
        .sock
        .set_read_timeout(Some(Duration::from_millis(100)));
    let mut next_heartbeat = Instant::now();
    let heartbeat_payload = generation.to_be_bytes();
    let mut awaiting_pong = false;
    while !stop.load(Ordering::SeqCst) {
        if Instant::now() >= next_heartbeat {
            if awaiting_pong {
                let _ = write_ws_frame(stream, 0x8, &1002u16.to_be_bytes());
                break;
            }
            if write_ws_frame(stream, 0x9, &heartbeat_payload).is_err() {
                break;
            }
            awaiting_pong = true;
            next_heartbeat = Instant::now() + heartbeat_interval;
        }
        match read_ws_frame(stream) {
            Ok(Some((0x8, payload))) => {
                let _ = write_ws_frame(stream, 0x8, &payload);
                break;
            }
            Ok(Some((0x9, payload))) => {
                if write_ws_frame(stream, 0xA, &payload).is_err() {
                    break;
                }
            }
            Ok(Some((0xA, payload))) if payload == heartbeat_payload => {
                awaiting_pong = false;
            }
            Ok(Some((0xA, _))) => {
                let _ = write_ws_frame(stream, 0x8, &1002u16.to_be_bytes());
                break;
            }
            Ok(None) => {}
            Ok(Some((_opcode, _))) => {
                let _ = write_ws_frame(stream, 0x8, &1003u16.to_be_bytes());
                break;
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
    }
}

fn write_ws_frame(stream: &mut impl Write, opcode: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() > 125 {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "control frame too large",
        ));
    }
    stream.write_all(&[0x80 | (opcode & 0x0f), payload.len() as u8])?;
    stream.write_all(payload)?;
    stream.flush()
}

fn read_ws_frame(stream: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut header = [0u8; 2];
    stream.read_exact(&mut header)?;
    if header[0] & 0x80 == 0 || header[1] & 0x80 == 0 {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "fragmented or unmasked client frame",
        ));
    }
    let opcode = header[0] & 0x0f;
    let length = (header[1] & 0x7f) as usize;
    if length > 125 {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "oversized foundation frame",
        ));
    }
    let mut mask = [0u8; 4];
    stream.read_exact(&mut mask)?;
    let mut payload = vec![0u8; length];
    stream.read_exact(&mut payload)?;
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    Ok(Some((opcode, payload)))
}

fn build_tls_server_config(identity: &IdentityMaterial) -> Result<TlsServerConfig, GatewayError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let certificate = CertificateDer::from(identity.certificate_der.clone());
    let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        identity.private_key_der.as_slice().to_vec(),
    ));
    TlsServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![certificate], private_key)
        .map_err(|_| {
            GatewayError::new(
                "companion-certificate-invalid",
                "Companion TLS identity is invalid",
            )
        })
}

fn build_pairing_presentation(
    mut envelope: PairingEnvelope,
) -> Result<PairingPresentation, GatewayError> {
    let socket: SocketAddr = envelope
        .endpoint
        .strip_prefix("https://")
        .ok_or_else(|| {
            GatewayError::new(
                "pairing-envelope-invalid",
                "The local pairing endpoint is invalid",
            )
        })?
        .parse()
        .map_err(|_| {
            GatewayError::new(
                "pairing-envelope-invalid",
                "The local pairing endpoint is invalid",
            )
        })?;
    let ip = match socket.ip() {
        IpAddr::V4(address) if is_private_or_loopback(address) => address.to_string(),
        _ => {
            return Err(GatewayError::new(
                "pairing-envelope-invalid",
                "The local pairing endpoint is not an approved IPv4 address",
            ))
        }
    };
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(GatewayError::new(
            "pairing-envelope-invalid",
            "The local pairing envelope version is unsupported",
        ));
    }
    let payload = serialize_canonical_pairing_payload(
        "LuckyRay Desktop",
        &envelope.desktop_instance_id,
        &ip,
        socket.port(),
        &envelope.secret,
        &envelope.certificate_fingerprint,
    )?;
    let code = QrCode::new(payload.as_bytes()).map_err(|_| {
        GatewayError::new(
            "pairing-qr-unavailable",
            "The local pairing code could not be generated",
        )
    })?;
    let qr_size = u16::try_from(code.width()).map_err(|_| {
        GatewayError::new(
            "pairing-qr-unavailable",
            "The local pairing code is too large",
        )
    })?;
    let mut qr_path = String::with_capacity(code.width() * code.width() * 7);
    for y in 0..code.width() {
        for x in 0..code.width() {
            if code[(x, y)] == QrColor::Dark {
                let _ = write!(qr_path, "M{x} {y}h1v1h-1z");
            }
        }
    }
    Ok(PairingPresentation {
        pairing_id: envelope.pairing_id.clone(),
        v: PROTOCOL_VERSION,
        name: "LuckyRay Desktop".to_owned(),
        instance: envelope.desktop_instance_id.clone(),
        ip,
        port: socket.port(),
        secret: std::mem::take(&mut envelope.secret),
        fp: envelope.certificate_fingerprint.clone(),
        expires_at: envelope.expires_at.clone(),
        qr_size,
        qr_path,
    })
}

fn serialize_canonical_pairing_payload(
    name: &str,
    instance: &str,
    ip: &str,
    port: u16,
    secret: &str,
    fp: &str,
) -> Result<Zeroizing<String>, GatewayError> {
    let canonical = CanonicalQrEnvelope {
        v: PROTOCOL_VERSION,
        name,
        instance,
        ip,
        port,
        secret,
        fp,
    };
    serde_json::to_string(&canonical)
        .map(Zeroizing::new)
        .map_err(|_| {
            GatewayError::new(
                "pairing-envelope-invalid",
                "The local pairing envelope could not be encoded",
            )
        })
}

fn normalize_lan_interfaces(
    candidates: impl IntoIterator<Item = (String, Ipv4Addr, u8, bool)>,
) -> Vec<LanIpv4Interface> {
    let mut seen = BTreeSet::new();
    let mut rows = candidates
        .into_iter()
        .filter(|(_, address, prefix_length, is_up)| {
            *is_up && *prefix_length <= 32 && is_private_lan(*address)
        })
        .filter_map(|(name, address, prefix_length, _)| {
            if !seen.insert(address) {
                return None;
            }
            Some(LanIpv4Interface {
                interface_id: address.to_string(),
                name: name.trim().chars().take(96).collect::<String>(),
                address: address.to_string(),
                prefix_length,
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.address.cmp(&right.address))
    });
    rows
}

#[cfg(windows)]
fn list_lan_ipv4_interfaces() -> Result<Vec<LanIpv4Interface>, GatewayError> {
    use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_SKIP_MULTICAST;
    let mut size = 15 * 1024u32;
    for _ in 0..3 {
        let words =
            (size as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
        let mut buffer = vec![0usize; words];
        let first = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let result =
            unsafe { GetAdaptersAddresses(AF_INET.0.into(), flags, None, Some(first), &mut size) };
        if result == ERROR_BUFFER_OVERFLOW.0 {
            continue;
        }
        if result != ERROR_SUCCESS.0 {
            return Err(GatewayError::new(
                "gateway-interface-enumeration-failed",
                "Windows could not enumerate private LAN interfaces",
            ));
        }
        let mut candidates = Vec::new();
        let mut adapter = first;
        while !adapter.is_null() {
            let is_up = unsafe { (*adapter).OperStatus == IfOperStatusUp };
            let name = unsafe { (*adapter).FriendlyName.to_string() }
                .unwrap_or_else(|_| "局域网接口".to_owned());
            let mut unicast = unsafe { (*adapter).FirstUnicastAddress };
            while !unicast.is_null() {
                let socket = unsafe { (*unicast).Address.lpSockaddr };
                if !socket.is_null() && unsafe { (*socket).sa_family } == AF_INET {
                    let address = unsafe { &*(socket.cast::<SOCKADDR_IN>()) };
                    let octets = unsafe { address.sin_addr.S_un.S_un_b };
                    candidates.push((
                        name.clone(),
                        Ipv4Addr::new(octets.s_b1, octets.s_b2, octets.s_b3, octets.s_b4),
                        unsafe { (*unicast).OnLinkPrefixLength },
                        is_up,
                    ));
                }
                unicast = unsafe { (*unicast).Next };
            }
            adapter = unsafe { (*adapter).Next };
        }
        return Ok(normalize_lan_interfaces(candidates));
    }
    Err(GatewayError::new(
        "gateway-interface-enumeration-failed",
        "Windows private LAN interface enumeration did not stabilize",
    ))
}

#[cfg(not(windows))]
fn list_lan_ipv4_interfaces() -> Result<Vec<LanIpv4Interface>, GatewayError> {
    Ok(Vec::new())
}

fn validate_management_bind_address(
    requested: &str,
    interfaces: &[LanIpv4Interface],
) -> Result<String, GatewayError> {
    let address: Ipv4Addr = requested.parse().map_err(|_| {
        GatewayError::new(
            "gateway-bind-address-invalid",
            "Select an enumerated private LAN IPv4 interface",
        )
    })?;
    if !is_private_lan(address) {
        return Err(GatewayError::new(
            "gateway-bind-address-not-private",
            "Companion Gateway management accepts only an enumerated private LAN IPv4",
        ));
    }
    let canonical = address.to_string();
    if !interfaces.iter().any(|item| item.address == canonical) {
        return Err(GatewayError::new(
            "gateway-bind-address-unavailable",
            "The selected private LAN interface is no longer available",
        ));
    }
    Ok(canonical)
}

fn validate_bind_selection(address: &str, port: u16) -> Result<BindSelection, GatewayError> {
    let address: Ipv4Addr = address.parse().map_err(|_| {
        GatewayError::new(
            "gateway-bind-address-invalid",
            "Select an explicit private LAN IPv4 or loopback address",
        )
    })?;
    if !is_private_or_loopback(address) {
        return Err(GatewayError::new(
            "gateway-bind-address-not-private",
            "Companion Gateway binds only an explicit private LAN IPv4 or loopback address",
        ));
    }
    if (LOCAL_TRANSPORT_PORT_START..=LOCAL_TRANSPORT_PORT_END).contains(&port) {
        return Err(GatewayError::new(
            "gateway-local-transport-port-reserved",
            "The selected port is reserved for LuckyRay local transport",
        ));
    }
    Ok(BindSelection { address, port })
}

fn is_private_or_loopback(address: Ipv4Addr) -> bool {
    address.is_loopback()
        || address.octets()[0] == 10
        || (address.octets()[0] == 172 && (16..=31).contains(&address.octets()[1]))
        || (address.octets()[0] == 192 && address.octets()[1] == 168)
}

fn is_private_lan(address: Ipv4Addr) -> bool {
    !address.is_loopback()
        && (address.octets()[0] == 10
            || (address.octets()[0] == 172 && (16..=31).contains(&address.octets()[1]))
            || (address.octets()[0] == 192 && address.octets()[1] == 168))
}

fn classify_bind_error(error: io::Error) -> GatewayError {
    let os_code = error.raw_os_error();
    let kind = error.kind();
    let mut result = match kind {
        ErrorKind::AddrInUse => GatewayError::new(
            "gateway-bind-conflict",
            "The selected Companion address and port are already in use",
        ),
        ErrorKind::PermissionDenied => GatewayError::new(
            "gateway-bind-access-denied",
            "Windows denied binding this address/port; excluded ports or system policy may apply. This does not establish a firewall cause",
        ),
        ErrorKind::AddrNotAvailable => GatewayError::new(
            "gateway-bind-address-unavailable",
            "The selected interface address is no longer available",
        ),
        _ => GatewayError::new(
            "gateway-listener-unavailable",
            "The Companion listener could not bind to the selected address",
        ),
    };
    result.bind_failure = Some(BindFailure::new(kind, os_code, 1));
    result
}

fn validate_device_label(label: &str) -> Result<String, GatewayError> {
    let label = label.trim();
    if label.is_empty()
        || label.len() > MAX_DEVICE_LABEL_BYTES
        || label.chars().any(char::is_control)
    {
        return Err(GatewayError::new(
            "pairing-device-label-invalid",
            "The paired device label is invalid",
        ));
    }
    Ok(label.to_owned())
}

fn credential_verifier(
    key: &[u8],
    device_id: &str,
    secret: &[u8],
) -> Result<[u8; 32], GatewayError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| {
        GatewayError::new(
            "companion-secret-recovery-required",
            "Companion verifier authority is invalid",
        )
    })?;
    mac.update(b"luckyray-companion-device:v1\0");
    mac.update(device_id.as_bytes());
    mac.update(b"\0");
    mac.update(secret);
    Ok(mac.finalize().into_bytes().into())
}

fn append_audit(
    db_path: &Path,
    action: &str,
    device_id: Option<&str>,
    result: &str,
) -> Result<(), GatewayError> {
    if !valid_audit_token(action) || !valid_audit_token(result) {
        return Err(GatewayError::new(
            "companion-audit-invalid",
            "Companion security audit metadata is invalid",
        ));
    }
    open_connection(db_path)?
        .execute(
            "INSERT INTO companion_security_audit(action,device_id,occurred_at,result)\r\n             VALUES (?1,?2,?3,?4)",
            params![action, device_id, chrono::Utc::now().to_rfc3339(), result],
        )
        .map_err(|_| {
            GatewayError::new(
                "companion-audit-unavailable",
                "Companion security audit is unavailable",
            )
        })?;
    Ok(())
}

fn valid_audit_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_alphabetic() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
}

fn valid_public_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() == prefix.len() + 32
        && value[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
}

fn random_bytes(length: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; length];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn random_hex(bytes: usize) -> String {
    random_bytes(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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

#[tauri::command]
pub(crate) fn companion_gateway_status(
    caller: tauri::Webview,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<GatewayStatus, GatewayError> {
    require_main_caller(&caller)?;
    Ok(gateway.status())
}

#[tauri::command]
pub(crate) fn companion_gateway_start(
    caller: tauri::Webview,
    bind_address: String,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<GatewayStatus, GatewayError> {
    require_main_caller(&caller)?;
    let interfaces = list_lan_ipv4_interfaces()?;
    let bind_address = validate_management_bind_address(&bind_address, &interfaces)?;
    gateway.inner().start(&bind_address, None)
}

#[tauri::command]
pub(crate) fn companion_gateway_stop(
    caller: tauri::Webview,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<GatewayStatus, GatewayError> {
    require_main_caller(&caller)?;
    gateway.stop()
}

#[tauri::command]
pub(crate) fn companion_gateway_restart(
    caller: tauri::Webview,
    bind_address: String,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<GatewayStatus, GatewayError> {
    require_main_caller(&caller)?;
    let interfaces = list_lan_ipv4_interfaces()?;
    let bind_address = validate_management_bind_address(&bind_address, &interfaces)?;
    gateway.inner().restart(&bind_address, None)
}

#[tauri::command]
pub(crate) fn companion_gateway_issue_pairing(
    caller: tauri::Webview,
    replace_existing: Option<bool>,
    authorization_mode: Option<AuthorizationMode>,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<PairingPresentation, GatewayError> {
    require_main_caller(&caller)?;
    gateway.issue_pairing_presentation_authorized(replace_existing.unwrap_or(false), authorization_mode.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn companion_gateway_set_authorization_mode(
    caller: tauri::Webview,
    device_id: String,
    authorization_mode: AuthorizationMode,
    expected_permission_revision: u64,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<(), GatewayError> {
    require_main_caller(&caller)?;
    gateway.set_authorization_mode(&device_id, authorization_mode, expected_permission_revision)
}

#[tauri::command]
pub(crate) fn companion_gateway_cancel_pairing(
    caller: tauri::Webview,
    pairing_id: String,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<bool, GatewayError> {
    require_main_caller(&caller)?;
    Ok(gateway.cancel_pairing(&pairing_id))
}

#[tauri::command]
pub(crate) fn companion_gateway_list_interfaces(
    caller: tauri::Webview,
) -> Result<Vec<LanIpv4Interface>, GatewayError> {
    require_main_caller(&caller)?;
    list_lan_ipv4_interfaces()
}

#[tauri::command]
pub(crate) fn companion_gateway_list_devices(
    caller: tauri::Webview,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<Vec<PairedDevice>, GatewayError> {
    require_main_caller(&caller)?;
    gateway.list_devices()
}

#[tauri::command]
pub(crate) fn companion_gateway_list_audit(
    caller: tauri::Webview,
    limit: Option<usize>,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<Vec<SecurityAuditEntry>, GatewayError> {
    require_main_caller(&caller)?;
    gateway.list_security_audit(limit)
}

#[tauri::command]
pub(crate) fn companion_gateway_revoke_device(
    caller: tauri::Webview,
    device_id: String,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<RevokeDeviceResult, GatewayError> {
    require_main_caller(&caller)?;
    gateway.revoke_device_with_lsh(&device_id)
}

/// Explicit device-scoped LSH remote surface permission (default OFF).
#[tauri::command]
pub(crate) fn companion_gateway_lsh_remote_set_grant(
    caller: tauri::Webview,
    device_id: String,
    granted: bool,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<(), GatewayError> {
    require_main_caller(&caller)?;
    gateway.set_lsh_remote_grant(&device_id, granted)
}

/// Desktop-side LSH remote surface posture for the management panel: the
/// runtime availability is live truth, never inferred from the grant.
#[tauri::command]
pub(crate) fn companion_gateway_lsh_remote_state(
    caller: tauri::Webview,
    device_id: String,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<serde_json::Value, GatewayError> {
    require_main_caller(&caller)?;
    let granted = gateway.lsh_remote_granted_pub(&device_id)?;
    let runtime_available = gateway
        .lsh_remote_host()
        .map(|host| host.remote_surface_available())
        .unwrap_or(false);
    Ok(serde_json::json!({
        "granted": granted,
        "runtimeAvailable": runtime_available,
    }))
}

fn write_ws_text_frame(stream: &mut impl Write, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
    if payload.len() > 1024 { return Err(io::Error::new(ErrorKind::InvalidInput, "hint too large")); }
    stream.write_all(&[0x81])?;
    if payload.len() <= 125 {
        stream.write_all(&[payload.len() as u8])?;
    } else {
        stream.write_all(&[126])?;
        stream.write_all(&(payload.len() as u16).to_be_bytes())?;
    }
    stream.write_all(&payload)?;
    stream.flush()
}

#[tauri::command]
pub(crate) fn companion_gateway_service_grants(
    caller: tauri::Webview,
    device_id: String,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<serde_json::Value, GatewayError> {
    require_main_caller(&caller)?;
    gateway.service_grant_state(&device_id)
}

#[tauri::command]
pub(crate) fn companion_gateway_service_set_grant(
    caller: tauri::Webview,
    device_id: String,
    grant_class: String,
    scope_kind: String,
    scope_id: String,
    enabled: bool,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<(), GatewayError> {
    require_main_caller(&caller)?;
    gateway.set_service_grant(&device_id, &grant_class, &scope_kind, &scope_id, enabled)
}

#[tauri::command]
pub(crate) fn companion_gateway_service_set_grants(
    caller: tauri::Webview,
    device_id: String,
    changes: Vec<services::ServiceGrantChange>,
    expected_permission_revision: u64,
    expected_current_vault_id: Option<String>,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<(), GatewayError> {
    require_main_caller(&caller)?;
    gateway.set_service_grants(&device_id, &changes, expected_permission_revision, expected_current_vault_id.as_deref())
}

#[tauri::command]
pub(crate) fn companion_gateway_presentation_claim(
    caller: tauri::Webview,
    request_id: String,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<u64, GatewayError> {
    require_main_caller(&caller)?;
    if request_id.len() != 32 || !request_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GatewayError::new("presentation-request-invalid", "Invalid presentation request"));
    }
    gateway.claim_presentation(&request_id)
}

#[tauri::command]
pub(crate) fn companion_gateway_presentation_ack(
    caller: tauri::Webview,
    request_id: String,
    accepted: bool,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<(), GatewayError> {
    require_main_caller(&caller)?;
    if request_id.len() != 32 || !request_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GatewayError::new("presentation-request-invalid", "Invalid presentation request"));
    }
    gateway.acknowledge_presentation(&request_id, accepted)
}

fn require_main_caller(caller: &tauri::Webview) -> Result<(), GatewayError> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err(GatewayError::new(
            "gateway-caller-untrusted",
            "Companion Gateway management is restricted to the main app surface",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::ServerName;
    use rustls::{ClientConfig, ClientConnection, RootCertStore};
    use std::io::{BufRead, Cursor};

    impl CompanionGateway {
        /// Existing regression suites cover previously paired phones. Construct
        /// that pre-policy database state explicitly; production pairing always
        /// records the desktop's Manual or Trusted consent.
        fn exchange_legacy_pairing_fixture(&self, body: &[u8], generation: u64) -> Result<Value, GatewayError> {
            let paired = self.exchange_pairing(body, generation)?;
            open_connection(self.backend.db_path())?.execute("DELETE FROM companion_phone_policy WHERE device_id=?1", [paired["deviceId"].as_str().unwrap()])
                .map_err(|_| GatewayError::new("companion-database-unavailable", "Legacy fixture setup failed"))?;
            Ok(paired)
        }
    }

    #[test]
    fn desktop_pairing_choice_is_ticket_bound_and_old_phone_conversion_is_explicit() {
        let (_root, backend, _store, gateway) = gateway_fixture("explicit-trust-policy", GatewayPolicy::default());
        gateway.start("127.0.0.1", Some(0)).unwrap();
        let exchange = |mode| {
            let ticket = gateway.issue_pairing_authorized(mode).unwrap();
            let body = serde_json::to_vec(&json!({"secret":ticket.secret,"fingerprint":ticket.certificate_fingerprint,"deviceLabel":"Consent test"})).unwrap();
            gateway.exchange_pairing(&body, running_generation(&gateway)).unwrap()["deviceId"].as_str().unwrap().to_owned()
        };
        let manual = exchange(AuthorizationMode::Manual);
        let db = open_connection(backend.db_path()).unwrap();
        assert!(trust_policy::has_policy(&db,&manual).unwrap());
        assert!(!trust_policy::granted(&db,&manual,"content.read","catalog","").unwrap());
        assert!(!gateway.lsh_remote_granted(&manual).unwrap());
        let trusted = exchange(AuthorizationMode::Trusted);
        assert!(trust_policy::granted(&db,&trusted,"content.read","vault","future-saved-vault").unwrap());
        assert!(gateway.lsh_remote_granted(&trusted).unwrap());
        assert!(gateway.set_authorization_mode(&manual, AuthorizationMode::Trusted, 999).is_err());
        assert!(!gateway.lsh_remote_granted(&manual).unwrap());
        gateway.set_authorization_mode(&manual,AuthorizationMode::Trusted,0).unwrap();
        assert!(gateway.lsh_remote_granted(&manual).unwrap());
        gateway.set_lsh_remote_grant(&manual,false).unwrap();
        let revision = gateway.service_grant_state(&manual).unwrap()["permissionRevision"].as_u64().unwrap();
        gateway.set_authorization_mode(&manual,AuthorizationMode::Manual,revision).unwrap();
        gateway.set_authorization_mode(&manual,AuthorizationMode::Trusted,revision+1).unwrap();
        assert!(!gateway.lsh_remote_granted(&manual).unwrap());
        let injected = json!({"secret":"x","fingerprint":"x","authorizationMode":"trusted"});
        assert!(serde_json::from_value::<PairRequest>(injected).is_err());
        assert!(gateway.shutdown());
    }

    #[derive(Default)]
    struct MemoryIdentityStore {
        value: Mutex<Option<Vec<u8>>>,
    }

    impl ProtectedIdentityStore for MemoryIdentityStore {
        fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, GatewayError> {
            Ok(self.value.lock().unwrap().clone().map(Zeroizing::new))
        }

        fn store(&self, plaintext: &[u8]) -> Result<(), GatewayError> {
            *self.value.lock().unwrap() = Some(plaintext.to_vec());
            Ok(())
        }

        fn remove(&self) -> Result<(), GatewayError> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    fn fixture_root(label: &str) -> tempfile::TempDir {
        let base = std::env::var_os("LUCKYRAY_TEST_TEMP_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&base).unwrap();
        tempfile::Builder::new()
            .prefix(&format!("epoch-267-{label}-"))
            .tempdir_in(base)
            .unwrap()
    }

    fn gateway_fixture(
        label: &str,
        policy: GatewayPolicy,
    ) -> (
        tempfile::TempDir,
        Arc<BackendServices>,
        Arc<MemoryIdentityStore>,
        Arc<CompanionGateway>,
    ) {
        let root = fixture_root(label);
        let backend = Arc::new(BackendServices::initialize(root.path()).unwrap());
        let store = Arc::new(MemoryIdentityStore::default());
        let gateway =
            CompanionGateway::initialize_with_store(Arc::clone(&backend), store.clone(), policy);
        (root, backend, store, gateway)
    }

    fn bearer_request(credential: &str) -> HttpRequest {
        HttpRequest {
            method: "GET".to_owned(),
            path: "/v1/session".to_owned(),
            headers: HashMap::from([("authorization".to_owned(), format!("Bearer {credential}"))]),
            body: Vec::new(),
        }
    }

    fn running_generation(gateway: &CompanionGateway) -> u64 {
        match gateway.status() {
            GatewayStatus::Running { generation, .. } => generation,
            status => panic!("expected running gateway, got {status:?}"),
        }
    }

    fn pinned_client(
        gateway: &CompanionGateway,
        port: u16,
    ) -> StreamOwned<ClientConnection, TcpStream> {
        let identity = gateway.identity().unwrap();
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(identity.certificate_der.clone()))
            .unwrap();
        let config = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let client = ClientConnection::new(
            config,
            ServerName::try_from("luckyray-companion.local").unwrap(),
        )
        .unwrap();
        let socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        StreamOwned::new(client, socket)
    }

    fn pinned_http_response(gateway: &CompanionGateway, port: u16, request: &str) -> String {
        let mut tls = pinned_client(gateway, port);
        tls.write_all(request.as_bytes()).unwrap();
        tls.flush().unwrap();
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            tls.read_exact(&mut byte).unwrap();
            response.push(byte[0]);
        }
        let header_text = String::from_utf8(response.clone()).unwrap();
        let content_length = header_text
            .lines()
            .find_map(|line| {
                line.strip_prefix("Content-Length: ")
                    .and_then(|value| value.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        let mut body = vec![0u8; content_length];
        tls.read_exact(&mut body).unwrap();
        response.extend_from_slice(&body);
        String::from_utf8(response).unwrap()
    }

    #[test]
    fn identity_is_stable_disabled_by_default_and_missing_secret_requires_recovery() {
        let (_root, backend, store, first) = gateway_fixture("identity", GatewayPolicy::default());
        let first_identity = first.identity().unwrap();
        assert!(matches!(first.status(), GatewayStatus::Disabled { .. }));
        let restarted = CompanionGateway::initialize_with_store(
            Arc::clone(&backend),
            store.clone(),
            GatewayPolicy::default(),
        );
        let restarted_identity = restarted.identity().unwrap();
        assert_eq!(first_identity.instance_id, restarted_identity.instance_id);
        assert_eq!(first_identity.fingerprint, restarted_identity.fingerprint);

        *store.value.lock().unwrap() = None;
        let recovery =
            CompanionGateway::initialize_with_store(backend, store, GatewayPolicy::default());
        assert_eq!(
            recovery.status(),
            GatewayStatus::RecoveryRequired {
                code: "companion-secret-recovery-required"
            }
        );
    }

    #[test]
    fn pairing_bootstrap_is_single_use_expiring_attempt_bounded_and_rate_limited() {
        let mut policy = GatewayPolicy::default();
        policy.pairing_attempts = 2;
        policy.issue_limit = 4;
        let mut book = PairingBook::default();
        let (first, _) = book.issue(&policy, 1).unwrap();
        assert_eq!(
            book.consume("wrong-one", 1).unwrap_err().code,
            "pairing-secret-invalid"
        );
        assert_eq!(
            book.consume("wrong-two", 1).unwrap_err().code,
            "pairing-attempt-limit"
        );

        let (consumed, _) = book.issue(&policy, 1).unwrap();
        book.consume(&consumed, 1).unwrap();
        let (_replacement, _) = book.issue(&policy, 2).unwrap();
        assert_eq!(
            book.consume(&consumed, 2).unwrap_err().code,
            "pairing-replayed"
        );
        book.cancel_active();

        policy.pairing_ttl = Duration::from_millis(1);
        let (expired, _) = book.issue(&policy, 2).unwrap();
        thread::sleep(Duration::from_millis(5));
        assert_eq!(
            book.consume(&expired, 2).unwrap_err().code,
            "pairing-expired"
        );

        let mut limited_policy = GatewayPolicy::default();
        limited_policy.issue_limit = 1;
        let mut limited = PairingBook::default();
        let _ = limited.issue(&limited_policy, 1).unwrap();
        limited.cancel_active();
        assert_eq!(
            limited.issue(&limited_policy, 1).unwrap_err().code,
            "pairing-rate-limited"
        );
        drop(first);
    }

    fn stage_log(stage: &str, detail: &str) {
        // Phase marker for live triage: no secrets, flushed immediately so
        // `cargo test -- --nocapture` shows progress without waiting for the
        // process to end.
        eprintln!("[FULLCHAIN] {stage}: {detail}");
    }

    #[test]
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[ignore = "requires the exact verified DSH runtime fixture (DSH_TEST_RUNTIME_ROOT/DSH_TEST_STATE_ROOT)"]
    fn lsh_remote_full_chain_real_tls_real_runtime_real_ws() {
        // FULL CHAIN: real Companion TLS listener + real pairing + real
        // grant + REAL DSH runtime (verified fixture) + real control
        // frames + real carrier + real official surface + a STANDARD
        // WebSocket client reaching OPEN. Nothing is mocked upstream.
        // env::set_var races with parallel readers; the isolated runner must
        // supply both fixture roots before entering this process.
        std::env::var_os("DSH_TEST_RUNTIME_ROOT").expect("verified DSH fixture required");
        std::env::var_os("DSH_TEST_STATE_ROOT").expect("isolated DSH state fixture required");
        stage_log("boot", "constructing real DSH host service");
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dsh-host/luckyray-dsh-host.mjs");
        let host = crate::dsh_host::tests::real_service_for_integration(host_script);
        stage_log("boot", "launching authenticated host (cold official runtime)");
        // Same direct-launch path the dsh_host tests use (probe also works,
        // but launch is the precise precondition for open_native_surface).
        crate::dsh_host::tests::launch_authenticated_host_for_test(&host);
        stage_log("boot", "authenticated host launched");

        let (_root, backend, store, gateway) =
            gateway_fixture("lsh-fullchain", GatewayPolicy::default());
        let started = gateway.start("127.0.0.1", Some(0)).unwrap();
        let gateway_port = match &started {
            GatewayStatus::Running { port, .. } => *port,
            status => panic!("unexpected status: {status:?}"),
        };
        stage_log("attach", "attaching DSH host to the running gateway");
        gateway.attach_lsh_remote_host(host.clone());
        stage_log("surface", "opening native surface (binding + carrier)");
        let (status_view, _bootstrap) = host.open_native_surface().expect("open surface");
        stage_log("surface", "carrier ready");
        assert!(matches!(status_view.stage, crate::dsh_host::DshNativeSurfaceStage::CarrierReady));
        // The gateway listener pushed the authority at start; verify truth.
        assert!(host.remote_surface_available(), "authority must be live after start+open");

        // Pair through the same authenticated TLS entry that a device uses.
        let envelope = gateway.issue_pairing().unwrap();
        let pair_body = json!({
            "secret": envelope.secret.clone(),
            "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "D full chain phone"
        }).to_string();
        let pair_response = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "POST /v1/pair HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{pair_body}",
                pair_body.len(),
            ),
            10_000,
        );
        assert!(pair_response.starts_with("HTTP/1.1 200"), "pairing over TLS failed");
        let paired: Value = serde_json::from_str(pair_response.split_once("\r\n\r\n").expect("pair response body").1)
            .expect("pair response JSON");
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        let credential = paired["credential"].as_str().expect("device credential").to_owned();
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();

        // Mint via the real device-authenticated TLS endpoint, not a direct
        // in-process call that bypasses its routing and bearer policy.
        stage_log("mint", "requesting authenticated device bootstrap over TLS");
        let session_response = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "POST /v1/lsh/remote/session HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(session_response.starts_with("HTTP/1.1 200"), "authenticated session mint failed");
        let session: Value = serde_json::from_str(session_response.split_once("\r\n\r\n").expect("session response body").1)
            .expect("session response JSON");
        stage_log("mint", "ref issued");
        let bootstrap_ref = session["ref"].as_str().unwrap().to_owned();
        let bootstrap_path = session["bootstrapPath"].as_str().unwrap().to_owned();
        assert_eq!(bootstrap_path, "/_luckyray/remote/bootstrap");

        // Standard browser navigation through the REAL TLS entry.
        stage_log("bootstrap", "GET /_luckyray/remote/bootstrap over real TLS");
        let bootstrap = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET {bootstrap_path}?ref={bootstrap_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nConnection: close\r\n\r\n"
            ),
            20_000,
        );
        assert!(bootstrap.starts_with("HTTP/1.1 302"), "bootstrap failed");
        let cookie_line = bootstrap
            .lines()
            .find(|line| line.to_lowercase().starts_with("set-cookie:"))
            .expect("remote session cookie");
        let remote_cookie = cookie_line
            .split_once(':')
            .unwrap()
            .1
            .trim()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        assert!(remote_cookie.starts_with("luckyray_dsh_remote_g"), "remote cookie is missing");
        assert!(!bootstrap.contains("token="), "launch token must never appear in a URL");

        // Official index through the same cookie.
        stage_log("index", "GET / with the minted remote cookie");
        let index = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET / HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nCookie: {remote_cookie}\r\nConnection: close\r\n\r\n"
            ),
            20_000,
        );
        assert!(index.starts_with("HTTP/1.1 200"), "remote index failed");
        assert!(index.contains("__DSH_BOOT__") || index.contains("<html"), "official index served");

        stage_log("ws", "opening a pinned standard WebSocket client");
        // Python's websockets client performs the RFC6455 handshake, validates
        // the test certificate against the advertised hostname, and exchanges
        // a real masked PING / PONG frame. Only this fixture needs Python.
        // Secret material travels through stdin, never argv or logs.
        struct WsFixtureChild(std::process::Child);
        impl Drop for WsFixtureChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/lsh_remote_standard_ws_client.py");
        let mut ws_child = WsFixtureChild(
            std::process::Command::new("python")
                .arg("-u")
                .arg(script)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("launch standard WS fixture client"),
        );
        let fixture_input = json!({
            "port": gateway_port,
            "certificateDer": BASE64.encode(&gateway.identity().unwrap().certificate_der),
            "cookie": remote_cookie,
        }).to_string();
        ws_child.0.stdin.take().unwrap().write_all(format!("{fixture_input}\n").as_bytes()).unwrap();
        let stdout = ws_child.0.stdout.take().expect("WS fixture stdout");
        let (ws_tx, ws_rx) = std::sync::mpsc::channel();
        let _reader = thread::spawn(move || {
            for line in io::BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => { let _ = ws_tx.send(line); }
                    Err(_) => break,
                }
            }
        });
        assert_eq!(ws_rx.recv_timeout(Duration::from_secs(35)).expect("WS OPEN timeout"), "OPEN");
        assert_eq!(ws_rx.recv_timeout(Duration::from_secs(12)).expect("WS PONG timeout"), "PONG");
        stage_log("ws", "standard client OPEN and PING/PONG verified");

        // Revoke while the standard client's socket is still open.
        stage_log("revoke", "closing grant with WS still open");
        thread::sleep(Duration::from_millis(300));
        gateway.set_lsh_remote_grant(&device_id, false).unwrap();
        assert_eq!(ws_rx.recv_timeout(Duration::from_secs(10)).expect("WS close timeout"), "CLOSED");
        assert!(ws_child.0.wait().expect("WS child exit").success(), "standard WS fixture failed");

        // The SAME (previously valid) cookie must now be refused by the carrier fence.
        let refused = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET / HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nCookie: {remote_cookie}\r\nConnection: close\r\n\r\n"
            ),
            5_000,
        );
        assert!(refused.starts_with("HTTP/1.1 403"), "stale cookie survived revoke");

        stage_log("restart", "minting a fresh valid session before restart");
        // The revoked cookie above is already invalid and cannot prove that
        // restart invalidates an ACTIVE session. Establish a new one first.
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();
        let pre_restart_response = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "POST /v1/lsh/remote/session HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(pre_restart_response.starts_with("HTTP/1.1 200"), "pre-restart mint failed");
        let pre_restart_session: Value = serde_json::from_str(pre_restart_response.split_once("\r\n\r\n").expect("pre-restart body").1)
            .expect("pre-restart JSON");
        let pre_restart_ref = pre_restart_session["ref"].as_str().expect("pre-restart ref");
        let pre_restart_bootstrap = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET /_luckyray/remote/bootstrap?ref={pre_restart_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(pre_restart_bootstrap.starts_with("HTTP/1.1 302"), "pre-restart bootstrap failed");
        let pre_restart_cookie = pre_restart_bootstrap.lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .expect("pre-restart cookie")
            .split_once(':').unwrap().1.trim().split(';').next().unwrap().to_owned();
        let valid_before_restart = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET / HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nCookie: {pre_restart_cookie}\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(valid_before_restart.starts_with("HTTP/1.1 200"), "pre-restart cookie was not valid");
        // Keep a second, unconsumed ref pending across the restart. The ref
        // above was single-use and cannot prove generation retirement.
        let pending_response = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "POST /v1/lsh/remote/session HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(pending_response.starts_with("HTTP/1.1 200"), "pending ref mint failed");
        let pending_session: Value = serde_json::from_str(pending_response.split_once("\r\n\r\n").expect("pending ref body").1)
            .expect("pending ref JSON");
        let pending_ref = pending_session["ref"].as_str().expect("pending ref");

        stage_log("restart", "stopping and restarting the gateway on the same port (DSH alive)");
        gateway.stop().unwrap();
        let restarted = gateway.start("127.0.0.1", Some(gateway_port)).unwrap();
        match &restarted {
            GatewayStatus::Running { port, .. } => assert_eq!(*port, gateway_port),
            status => panic!("unexpected restart status: {status:?}"),
        }
        let after_restart = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET / HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nCookie: {pre_restart_cookie}\r\nConnection: close\r\n\r\n"
            ),
            5_000,
        );
        assert!(after_restart.starts_with("HTTP/1.1 403"), "previously valid cookie must not survive a gateway restart");
        let stale_ref = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET /_luckyray/remote/bootstrap?ref={pending_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nConnection: close\r\n\r\n"
            ),
            5_000,
        );
        assert!(stale_ref.starts_with("HTTP/1.1 403"), "unconsumed old-generation ref survived restart");

        let mint_after_restart = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "POST /v1/lsh/remote/session HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(mint_after_restart.starts_with("HTTP/1.1 200"), "new session must mint after restart");
        let new_session: Value = serde_json::from_str(mint_after_restart.split_once("\r\n\r\n").expect("new session body").1)
            .expect("new session JSON");
        let new_ref = new_session["ref"].as_str().expect("new session ref");
        let new_bootstrap = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET /_luckyray/remote/bootstrap?ref={new_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(new_bootstrap.starts_with("HTTP/1.1 302"), "new bootstrap must work after restart");

        // Production boot order: the saved listener auto-restores before the
        // DSH host is attached. The attach must push the restored authority.
        stage_log("restore", "reconstructing the saved listener, then attaching DSH");
        gateway.shutdown();
        drop(gateway);
        let restored = CompanionGateway::initialize_with_store(backend, store, GatewayPolicy::default());
        assert!(matches!(restored.status(), GatewayStatus::Running { port, .. } if port == gateway_port));
        restored.attach_lsh_remote_host(host.clone());
        let restored_state = tls_roundtrip(
            &restored,
            gateway_port,
            &format!(
                "GET /v1/lsh/remote/state HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(restored_state.starts_with("HTTP/1.1 200"), "restored listener's device auth failed");
        let state: Value = serde_json::from_str(restored_state.split_once("\r\n\r\n").expect("restored state body").1)
            .expect("restored state JSON");
        assert_eq!(state["granted"], true);
        assert_eq!(state["runtimeAvailable"], true, "attach must push restored authority");
        let restored_session = tls_roundtrip(
            &restored,
            gateway_port,
            &format!(
                "POST /v1/lsh/remote/session HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            10_000,
        );
        assert!(restored_session.starts_with("HTTP/1.1 200"), "restored listener cannot mint a session");

        stage_log("cleanup", "stopping restored gateway");
        restored.stop().unwrap();
        stage_log("cleanup", "done");
    }

    #[test]
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[ignore = "requires the verified DSH runtime and isolated DSH_TEST_STATE_ROOT"]
    fn lsh_remote_revoke_fails_closed_when_live_carrier_does_not_apply_drop() {
        std::env::var_os("DSH_TEST_RUNTIME_ROOT").expect("verified DSH fixture required");
        std::env::var_os("DSH_TEST_STATE_ROOT").expect("isolated DSH state fixture required");
        let host_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dsh-host/luckyray-dsh-host.mjs");
        let host = crate::dsh_host::tests::real_service_for_integration(host_script);
        crate::dsh_host::tests::launch_authenticated_host_for_test(&host);
        let mint_gate = TestOneShotGate::new();
        let relay_gate = TestOneShotGate::new();
        let mut policy = GatewayPolicy::default();
        policy.lsh_mint_hold_gate = Some(Arc::clone(&mint_gate));
        policy.lsh_relay_admission_gate = Some(Arc::clone(&relay_gate));
        let (_root, _backend, _store, gateway) =
            gateway_fixture("lsh-drop-fault", policy);
        let (port, generation) = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, generation, .. } => (port, generation),
            status => panic!("unexpected status: {status:?}"),
        };
        gateway.attach_lsh_remote_host(host.clone());
        host.open_native_surface().expect("open real carrier");
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({
                "secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "D drop fault phone"
            })).unwrap(),
            generation,
        ).unwrap();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();
        let valid = gateway.open_lsh_remote_session(&device_id).unwrap();
        let valid_ref = valid["ref"].as_str().unwrap();
        let bootstrap = tls_roundtrip(
            &gateway,
            port,
            &format!("GET /_luckyray/remote/bootstrap?ref={valid_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nConnection: close\r\n\r\n"),
            10_000,
        );
        assert!(bootstrap.starts_with("HTTP/1.1 302"), "valid bootstrap failed");
        let cookie = bootstrap.lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .expect("remote cookie")
            .split_once(':').unwrap().1.trim().split(';').next().unwrap().to_owned();
        let pending = gateway.open_lsh_remote_session(&device_id).unwrap();
        let pending_ref = pending["ref"].as_str().unwrap();
        let index_request = format!("GET / HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n");
        assert!(tls_roundtrip(&gateway, port, &index_request, 10_000).starts_with("HTTP/1.1 200"));

        // The carrier remains alive; this fault discards only the per-device
        // remote-session-drop control action. A new TLS connection must not
        // be able to reuse the old browser cookie or an unconsumed ref.
        host.inject_remote_drop_failure_for_test();
        gateway.set_lsh_remote_grant(&device_id, false).unwrap();
        assert!(tls_roundtrip(&gateway, port, &index_request, 5_000).starts_with("HTTP/1.1 403"),
            "old cookie remained usable after a failed carrier drop");
        let old_ws_request = format!("GET /api/remote.mux HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nCookie: {cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://luckyray-companion.local:{port}\r\n\r\n");
        let old_ws_response = tls_roundtrip(&gateway, port, &old_ws_request, 5_000);
        assert!(old_ws_response.is_empty() || old_ws_response.starts_with("HTTP/1.1 403"),
            "old cookie WS response after revoke: {}", old_ws_response.lines().next().unwrap_or("<empty>"));
        let old_ref_request = format!("GET /_luckyray/remote/bootstrap?ref={pending_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nConnection: close\r\n\r\n");
        assert!(tls_roundtrip(&gateway, port, &old_ref_request, 5_000).starts_with("HTTP/1.1 403"),
            "pending ref remained usable after a failed carrier drop");

        // If the safety re-key also fails, the Desktop relay stays closed.
        // A later successful authority push must erase (not revive) the old
        // cookie and pending reference before admitting any remote traffic.
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();
        let fresh = gateway.open_lsh_remote_session(&device_id).unwrap();
        let fresh_ref = fresh["ref"].as_str().unwrap();
        let fresh_bootstrap = tls_roundtrip(&gateway, port,
            &format!("GET /_luckyray/remote/bootstrap?ref={fresh_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nConnection: close\r\n\r\n"), 10_000);
        assert!(fresh_bootstrap.starts_with("HTTP/1.1 302"));
        let fresh_cookie = fresh_bootstrap.lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .unwrap().split_once(':').unwrap().1.trim().split(';').next().unwrap().to_owned();
        let fresh_index = format!("GET / HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nCookie: {fresh_cookie}\r\nConnection: close\r\n\r\n");
        let pending_again = gateway.open_lsh_remote_session(&device_id).unwrap();
        let pending_again_ref = pending_again["ref"].as_str().unwrap();
        // Pause after target acquisition but before registry admission. The
        // old ordering lets both revoke scans miss this live request.
        relay_gate.armed.store(true, Ordering::SeqCst);
        let stalled_gateway = Arc::clone(&gateway);
        let stalled_index = fresh_index.clone();
        let stalled = thread::spawn(move || tls_roundtrip(&stalled_gateway, port, &stalled_index, 5_000));
        let relay_deadline = Instant::now() + Duration::from_secs(5);
        while !relay_gate.entered.load(Ordering::SeqCst) && Instant::now() < relay_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(relay_gate.entered.load(Ordering::SeqCst), "relay did not reach admission boundary");
        host.inject_remote_drop_failure_for_test();
        host.inject_remote_authority_failure_for_test();
        assert_eq!(gateway.set_lsh_remote_grant(&device_id, false).unwrap_err().code,
            "lsh-remote-revoke-unconfirmed");
        relay_gate.release.store(true, Ordering::SeqCst);
        let stalled_result = stalled.join().unwrap();
        assert!(!stalled_result.starts_with("HTTP/1.1 200"),
            "pre-admitted request forwarded an old cookie after failed revoke");
        assert!(!gateway.lsh_remote_granted_pub(&device_id).unwrap());
        assert!(tls_roundtrip(&gateway, port, &fresh_index, 5_000).starts_with("HTTP/1.1 503"));
        gateway.sync_lsh_remote_authority(Some(generation), Some(port)).unwrap();
        assert!(tls_roundtrip(&gateway, port, &fresh_index, 5_000).starts_with("HTTP/1.1 403"));
        let pending_again_request = format!("GET /_luckyray/remote/bootstrap?ref={pending_again_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nConnection: close\r\n\r\n");
        assert!(tls_roundtrip(&gateway, port, &pending_again_request, 5_000).starts_with("HTTP/1.1 403"));

        // Card interleaving (b): registered, paused before any upstream
        // bytes, revoke SUCCEEDS (drop applied at the carrier). The retired
        // record must keep the paused request from ever emitting: neither a
        // 200 nor any carrier-visible write may happen after release.
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();
        gateway.sync_lsh_remote_authority(Some(generation), Some(port)).unwrap();
        let live_cookie = {
            let rebootstrap = gateway.open_lsh_remote_session(&device_id).unwrap();
            let rebootstrap_ref = rebootstrap["ref"].as_str().unwrap();
            tls_roundtrip(
                &gateway,
                port,
                &format!("GET /_luckyray/remote/bootstrap?ref={rebootstrap_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nConnection: close\r\n\r\n"),
                5_000,
            )
            .lines()
            .find(|line| line.to_lowercase().starts_with("set-cookie:"))
            .and_then(|line| line.split_once(':').map(|(_, rest)| rest.trim().split(';').next().unwrap().to_owned()))
            .expect("live cookie for interleaving (b)")
        };
        // Re-arm the one-shot gate: reset the consumed flags first, or the
        // wait loop passes instantly and the worker never actually pauses
        // (which would only prove an unpaused request may complete).
        relay_gate.entered.store(false, Ordering::SeqCst);
        relay_gate.release.store(false, Ordering::SeqCst);
        relay_gate.armed.store(true, Ordering::SeqCst);
        let retired_gateway = Arc::clone(&gateway);
        let retired_index = format!("GET / HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nCookie: {live_cookie}\r\nConnection: close\r\n\r\n");
        let retired_request = thread::spawn(move || tls_roundtrip(&retired_gateway, port, &retired_index, 5_000));
        let retired_deadline = Instant::now() + Duration::from_secs(5);
        while !relay_gate.entered.load(Ordering::SeqCst) && Instant::now() < retired_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(relay_gate.entered.load(Ordering::SeqCst), "interleaving (b) request did not reach the admission boundary");
        gateway.set_lsh_remote_grant(&device_id, false).unwrap();
        relay_gate.release.store(true, Ordering::SeqCst);
        let retired_result = retired_request.join().unwrap();
        assert!(!retired_result.starts_with("HTTP/1.1 200"),
            "retired pre-upstream request still forwarded after a successful revoke: {}",
            retired_result.lines().next().unwrap_or("<empty>"));
        assert!(tls_roundtrip(&gateway, port, &fresh_index, 5_000).starts_with("HTTP/1.1 403"));

        // Deterministically pause issuance after the grant read. Revocation
        // must serialize with that issuance, then invalidate its ref.
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();
        mint_gate.armed.store(true, Ordering::SeqCst);
        let mint_gateway = Arc::clone(&gateway);
        let mint_device = device_id.clone();
        let mint_join = thread::spawn(move || mint_gateway.open_lsh_remote_session(&mint_device));
        let entered_deadline = Instant::now() + Duration::from_secs(5);
        while !mint_gate.entered.load(Ordering::SeqCst) && Instant::now() < entered_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(mint_gate.entered.load(Ordering::SeqCst), "mint did not reach grant-to-carrier boundary");
        let revoke_gateway = Arc::clone(&gateway);
        let revoke_device = device_id.clone();
        let revoke_started = Arc::new(AtomicBool::new(false));
        let started = Arc::clone(&revoke_started);
        let revoke_join = thread::spawn(move || {
            started.store(true, Ordering::SeqCst);
            revoke_gateway.set_lsh_remote_grant(&revoke_device, false)
        });
        let started_deadline = Instant::now() + Duration::from_secs(5);
        while !revoke_started.load(Ordering::SeqCst) && Instant::now() < started_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(revoke_started.load(Ordering::SeqCst));
        thread::sleep(Duration::from_millis(500));
        assert!(gateway.lsh_remote_granted_pub(&device_id).unwrap(),
            "revoke overtook a carrier mint already in progress");
        mint_gate.release.store(true, Ordering::SeqCst);
        let raced_ref = mint_join.join().unwrap().unwrap()["ref"].as_str().unwrap().to_owned();
        revoke_join.join().unwrap().unwrap();
        let raced_request = format!("GET /_luckyray/remote/bootstrap?ref={raced_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nConnection: close\r\n\r\n");
        assert!(tls_roundtrip(&gateway, port, &raced_request, 5_000).starts_with("HTTP/1.1 403"),
            "a late mint revived a ref after revocation");
        let paired_session = tls_roundtrip(
            &gateway,
            port,
            &format!("GET /v1/session HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n"),
            5_000,
        );
        assert!(paired_session.starts_with("HTTP/1.1 200"), "other Companion rights changed");

        // Full device revoke uses the same carrier fail-closed path.
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();
        let before_full_revoke = gateway.open_lsh_remote_session(&device_id).unwrap();
        let before_full_revoke_ref = before_full_revoke["ref"].as_str().unwrap();
        let before_full_revoke_bootstrap = tls_roundtrip(&gateway, port,
            &format!("GET /_luckyray/remote/bootstrap?ref={before_full_revoke_ref} HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nConnection: close\r\n\r\n"), 10_000);
        assert!(before_full_revoke_bootstrap.starts_with("HTTP/1.1 302"));
        let before_full_revoke_cookie = before_full_revoke_bootstrap.lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .unwrap().split_once(':').unwrap().1.trim().split(';').next().unwrap();
        host.inject_remote_drop_failure_for_test();
        gateway.revoke_device_with_lsh(&device_id).unwrap();
        let revoked_index = format!("GET / HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nCookie: {before_full_revoke_cookie}\r\nConnection: close\r\n\r\n");
        assert!(tls_roundtrip(&gateway, port, &revoked_index, 5_000).starts_with("HTTP/1.1 403"));
        gateway.stop().unwrap();
    }

    #[test]
    fn lsh_remote_grant_is_device_scoped_default_off_and_revocable() {
        let (_root, _backend, _store, gateway) =
            gateway_fixture("lsh-remote-grant", GatewayPolicy::default());
        let first = gateway.start("127.0.0.1", Some(0)).unwrap();
        let generation = match first {
            GatewayStatus::Running { generation, .. } => generation,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": envelope.secret.clone(),
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "D LSH remote phone"
                }))
                .unwrap(),
                generation,
            )
            .unwrap();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();

        // Default OFF: pairing alone never grants the LSH remote surface.
        assert!(!gateway.lsh_remote_granted_pub(&device_id).unwrap());

        // Explicit grant, then readback through the same store.
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();
        assert!(gateway.lsh_remote_granted_pub(&device_id).unwrap());

        // Unknown devices are rejected, not silently granted.
        assert!(gateway.set_lsh_remote_grant(&format!("device-{}", "f".repeat(32)), true).is_err());

        // Revoking the permission keeps the device paired.
        gateway.set_lsh_remote_grant(&device_id, false).unwrap();
        assert!(!gateway.lsh_remote_granted_pub(&device_id).unwrap());
        let devices = gateway.list_devices().unwrap();
        assert!(devices.iter().any(|device| device.device_id == device_id && device.revoked_at.is_none()));

        // An audit trail exists for both transitions.
        let audit = gateway.list_security_audit(Some(16)).unwrap();
        assert!(audit.iter().any(|entry| entry.action == "lsh-remote-granted" && entry.device_id.as_deref() == Some(&device_id)));
        assert!(audit.iter().any(|entry| entry.action == "lsh-remote-revoked" && entry.device_id.as_deref() == Some(&device_id)));
    }

    /// A real TLS client whose certificate fingerprint is PINNED to the
    /// pairing presentation value (the same trust model as the phone).
    #[derive(Debug)]
    struct FingerprintPin {
        expected: String,
    }

    impl rustls::client::danger::ServerCertVerifier for FingerprintPin {
        fn verify_server_cert(
            &self,
            end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            let digest = sha2::Sha256::digest(end_entity.as_ref());
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            if hex == self.expected {
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::General("certificate fingerprint mismatch".to_owned()))
            }
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            vec![rustls::SignatureScheme::RSA_PKCS1_SHA256, rustls::SignatureScheme::ECDSA_NISTP256_SHA256]
        }
    }

    fn pinned_tls_client(gateway: &CompanionGateway, port: u16) -> StreamOwned<ClientConnection, TcpStream> {
        pinned_tls_client_with_timeout(gateway, port, Duration::from_secs(5))
    }

    fn pinned_tls_client_with_timeout(
        gateway: &CompanionGateway,
        port: u16,
        read_timeout: Duration,
    ) -> StreamOwned<ClientConnection, TcpStream> {
        let fingerprint = match gateway.status() {
            GatewayStatus::Running { certificate_fingerprint, .. } => certificate_fingerprint,
            status => panic!("unexpected status: {status:?}"),
        };
        let config = Arc::new(
            ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(FingerprintPin { expected: fingerprint }))
                .with_no_client_auth(),
        );
        let client = ClientConnection::new(
            config,
            ServerName::try_from("luckyray-companion.local").unwrap(),
        )
        .unwrap();
        let socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        socket.set_read_timeout(Some(read_timeout)).unwrap();
        socket.set_write_timeout(Some(Duration::from_secs(30))).unwrap();
        StreamOwned::new(client, socket)
    }

    /// Minimal upstream standing in for the carrier's remote branch. Scripted
    /// per-connection responses; records what it received for assertions.
    fn mock_carrier_upstream(gateway_port: u16) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_thread = Arc::clone(&received);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return; };
                let _ = stream.set_read_timeout(Some(Duration::from_millis(40)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                loop {
                    match stream.read(&mut byte) {
                        Ok(1) => {
                            head.push(byte[0]);
                            if head.ends_with(b"\r\n\r\n") {
                                break;
                            }
                        }
                        _ => break,
                    }
                    if head.len() > 32 * 1024 {
                        break;
                    }
                }
                let head_text = String::from_utf8_lossy(&head).to_string();
                let host_ok = head_text.to_lowercase().contains(&format!("host: luckyray-companion.local:{gateway_port}"));
                // Drain the declared body so POST round-trips carry it fully.
                let declared: usize = head_text
                    .to_lowercase()
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:")?.trim().parse().ok())
                    .unwrap_or(0);
                let mut body_bytes = vec![0u8; declared];
                if declared > 0 {
                    stream.read_exact(&mut body_bytes).ok();
                }
                {
                    let cl_count = head_text
                        .lines()
                        .filter(|line| line.to_lowercase().starts_with("content-length:"))
                        .count();
                    let mut log = received_for_thread.lock().unwrap();
                    log.push(format!(
                        "{}|host_ok={host_ok}|cl={cl_count}|body={}",
                        head_text.lines().next().unwrap_or_default(),
                        String::from_utf8_lossy(&body_bytes)
                    ));
                }
                let is_bootstrap = head_text.contains("/_luckyray/remote/bootstrap");
                let has_cookie = head_text.to_lowercase().contains("cookie:");
                if is_bootstrap {
                    let _ = stream.write_all(
                        b"HTTP/1.1 302 Found\r\nlocation: /\r\nset-cookie: luckyray_dsh_remote_g1=fixturevalue; HttpOnly; Secure; SameSite=Strict; Path=/\r\nconnection: close\r\n\r\n",
                    );
                    let _ = stream.flush();
                    continue;
                }
                let is_upgrade = head_text.to_lowercase().contains("upgrade: websocket");
                if is_upgrade {
                    let _ = stream.write_all(
                        b"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
                    );
                    let _ = stream.flush();
                    // SERVER PUSH while the phone stays silent: three frames,
                    // one per second, then close.
                    for round in 0..3 {
                        thread::sleep(Duration::from_millis(1000));
                        let frame = format!("push-{round}");
                        let mask = [0u8; 4];
                        let mut frame_bytes = vec![0x81u8];
                        frame_bytes.push(0x80 | frame.len() as u8);
                        frame_bytes.extend_from_slice(&mask);
                        frame_bytes.extend(frame.bytes().map(|b| b ^ 0));
                        let _ = stream.write_all(&frame_bytes);
                        let _ = stream.flush();
                    }
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                if head_text.contains("/api/conversations") {
                    let body_text = String::from_utf8_lossy(&body_bytes).to_string();
                    let echoed = format!("{{\"echoed\":\"{}\"}}", body_text.replace("\"", "'"));
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            echoed.len(),
                            echoed
                        )
                        .as_bytes(),
                    );
                } else if has_cookie {
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 21\r\nconnection: close\r\n\r\n<html>remote-index</html>",
                    );
                } else {
                    let _ = stream.write_all(
                        b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    );
                }
                let _ = stream.flush();
            }
        });
        (port, received)
    }

    fn tls_roundtrip(
        gateway: &CompanionGateway,
        port: u16,
        request: &str,
        read_budget_ms: u64,
    ) -> String {
        let timeout = Duration::from_millis(read_budget_ms.clamp(1, 120_000));
        let mut tls = pinned_tls_client_with_timeout(gateway, port, timeout);
        tls.write_all(request.as_bytes()).unwrap();
        let _ = tls.flush();
        let deadline = Instant::now() + Duration::from_millis(read_budget_ms);
        let mut response = String::new();
        let mut buffer = [0u8; 4096];
        while Instant::now() < deadline {
            match tls.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => response.push_str(&String::from_utf8_lossy(&buffer[..read])),
                Err(ref error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::TimedOut =>
                {
                    // keep polling until the budget is spent
                }
                Err(_) => break,
            }
        }
        response
    }

    #[test]
    fn parsed_relay_body_keeps_shared_budget_until_relay_exits() {
        // A tiny test-only limit exercises the same production reservation and
        // Drop path without allocating 128 MiB of fixture request bodies.
        let gate = TestRelayBodyGate::new();
        let mut policy = GatewayPolicy::default();
        policy.relay_body_budget_limit = 1024;
        policy.relay_body_hold_gate = Some(Arc::clone(&gate));
        let (_root, _backend, _store, gateway) = gateway_fixture("relay-body-held", policy);
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let (upstream_port, _log) = mock_carrier_upstream(port);
        *gateway.lsh_remote_target_override.lock().unwrap() = Some(upstream_port);
        let request = || {
            let body = "x".repeat(600);
            format!(
                "POST /api/conversations HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            )
        };
        let first_gateway = Arc::clone(&gateway);
        let first_request = request();
        let first = thread::spawn(move || tls_roundtrip(&first_gateway, port, &first_request, 15_000));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !gate.entered.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(gate.entered.load(Ordering::SeqCst), "first body never reached the live relay");
        assert_eq!(gateway.relay_body_budget.load(Ordering::SeqCst), 600);
        let rejected = tls_roundtrip(&gateway, port, &request(), 5_000);
        assert!(rejected.starts_with("HTTP/1.1 400"), "concurrent body reused held budget");
        assert_eq!(gateway.relay_body_budget.load(Ordering::SeqCst), 600);
        gate.release.store(true, Ordering::SeqCst);
        assert!(first.join().unwrap().starts_with("HTTP/1.1 200"), "first relay did not finish");
        assert_eq!(gateway.relay_body_budget.load(Ordering::SeqCst), 0, "relay exit did not return budget");
        assert!(tls_roundtrip(&gateway, port, &request(), 5_000).starts_with("HTTP/1.1 200"), "returned budget was not reusable");
        gateway.stop().unwrap();
    }

    #[test]
    fn lsh_remote_surface_is_reachable_through_the_real_companion_tls_entry() {
        let (_root, _backend, _store, gateway) =
            gateway_fixture("lsh-remote-tls-entry", GatewayPolicy::default());
        let started = gateway.start("127.0.0.1", Some(0)).unwrap();
        let (gateway_port, generation) = match &started {
            GatewayStatus::Running { port, generation, .. } => (*port, *generation),
            status => panic!("unexpected status: {status:?}"),
        };

        // The mock upstream stands in for the carrier's remote branch.
        let (upstream_port, upstream_log) = mock_carrier_upstream(gateway_port);
        *gateway
            .lsh_remote_target_override
            .lock()
            .expect("companion lsh remote mutex") = Some(upstream_port);

        // Pair through the REAL control path and grant the device.
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": envelope.secret.clone(),
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "D TLS entry phone"
                }))
                .unwrap(),
                generation,
            )
            .unwrap();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        gateway.set_lsh_remote_grant(&device_id, true).unwrap();

        // --- 1) bootstrap through the REAL TLS entry: standard browser
        // request semantics (query string, set-cookie passthrough).
        let bootstrap = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET /_luckyray/remote/bootstrap?ref={} HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nConnection: close\r\n\r\n",
                "a".repeat(64)
            ),
            3000,
        );
        assert!(bootstrap.starts_with("HTTP/1.1 302"), "bootstrap relay: {bootstrap}");
        assert!(bootstrap.to_lowercase().contains("set-cookie: luckyray_dsh_remote_g1="), "remote session cookie must pass through: {bootstrap}");

        // --- 2) index request with the session cookie: proxied with the
        // original Host/Origin/cookie semantics intact.
        let index = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "GET / HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nCookie: luckyray_dsh_remote_g1=fixturevalue\r\nConnection: close\r\n\r\n"
            ),
            3000,
        );
        assert!(index.starts_with("HTTP/1.1 200"), "index relay: {index}");
        assert!(index.contains("remote-index"), "upstream body must stream back: {index}");

        // --- 2.5) POST with a body: pins the duplicate-content-length bug
        // class. The relayed head must carry EXACTLY ONE content-length (the
        // relay replaces the client's header with the buffered body length);
        // a duplicate is rejected by llhttp, so the byte-count assertion is
        // the meaningful check — the raw-TCP mock cannot exercise llhttp.
        let post = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!(
                "POST /api/conversations HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nCookie: luckyray_dsh_remote_g1=fixturevalue\r\nContent-Type: application/json\r\nContent-Length: 23\r\nConnection: close\r\n\r\n{{\"text\":\"remote-write\"}}"
            ),
            3000,
        );
        assert!(post.starts_with("HTTP/1.1 200"), "POST relay round-trip: {post}");
        assert!(post.contains("echoed"), "mock must confirm the forwarded body: {post}");
        {
            let log = upstream_log.lock().unwrap();
            let post_entry = log
                .iter()
                .find(|entry| entry.contains("POST /api/conversations"))
                .expect("POST must be relayed");
            assert!(post_entry.contains("cl=1"), "relayed POST head must carry exactly one content-length: {post_entry}");
            assert!(post_entry.contains("body={\"text\":\"remote-write\"}"), "the declared body must reach the upstream intact: {post_entry}");
        }

        // --- 3) WebSocket upgrade: the mock pushes three frames while the
        // client stays SILENT — full-duplex server push through the relay.
        let mut ws_client = pinned_tls_client(&gateway, gateway_port);
        ws_client
            .write_all(
                format!(
                    "GET /api/remote.mux HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://luckyray-companion.local:{gateway_port}\r\n\r\n"
                )
                .as_bytes(),
            )
            .unwrap();
        let _ = ws_client.flush();
        // Read the 101 then the pushed frames, with a generous deadline.
        ws_client
            .sock
            .set_read_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut ws_response = String::new();
        let mut buffer = [0u8; 4096];
        while Instant::now() < deadline && !ws_response.contains("push-2") {
            match ws_client.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => ws_response.push_str(&String::from_utf8_lossy(&buffer[..read])),
                Err(ref error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::TimedOut =>
                {
                    continue;
                }
                Err(_) => break,
            }
        }
        assert!(ws_response.contains("101"), "WS upgrade must pass through: {ws_response}");
        assert!(
            ws_response.contains("push-0") && ws_response.contains("push-1") && ws_response.contains("push-2"),
            "server push must stream while the client is silent: {ws_response}"
        );
        drop(ws_client);

        // --- 4) revocation reclaims open relays: the next relayed request is
        // refused after the grant is switched off.
        gateway.set_lsh_remote_grant(&device_id, false).unwrap();
        let refused = tls_roundtrip(
            &gateway,
            gateway_port,
            &format!("GET / HTTP/1.1\r\nHost: luckyray-companion.local:{gateway_port}\r\nConnection: close\r\n\r\n"),
            1500,
        );
        // The relay target override still points at the mock, but the mock
        // denies cookie-less relayed requests; the relay itself stays alive.
        assert!(
            refused.starts_with("HTTP/1.1 403") || refused.starts_with("HTTP/1.1 503"),
            "post-revocation relays must be refused by the fence: {refused}"
        );

        // --- 5) the upstream saw the browser's OWN Host header (no rewrite at
        // the entry; the carrier fence validates the real origin).
        let log = upstream_log.lock().unwrap();
        assert!(log.iter().all(|entry| entry.contains("host_ok=true")), "every relayed request must carry the advertised origin verbatim: {log:?}");
        assert!(log.len() >= 3, "bootstrap, index, and upgrade must all have been relayed: {log:?}");

        gateway.stop().unwrap();
    }

    #[test]
    fn gateway_lifecycle_pair_auth_list_revoke_and_audit_are_bounded() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("lifecycle", GatewayPolicy::default());
        let first = gateway.start("127.0.0.1", Some(0)).unwrap();
        let (port, generation) = match first {
            GatewayStatus::Running {
                port, generation, ..
            } => (port, generation),
            status => panic!("unexpected status: {status:?}"),
        };
        let idempotent = gateway.start("127.0.0.1", Some(port)).unwrap();
        assert!(matches!(
            idempotent,
            GatewayStatus::Running {
                generation: current,
                ..
            } if current == generation
        ));

        let envelope = gateway.issue_pairing().unwrap();
        let pairing_secret = envelope.secret.clone();
        assert_eq!(
            gateway
                .exchange_legacy_pairing_fixture(
                    &serde_json::to_vec(&json!({
                        "secret": pairing_secret.clone(),
                        "fingerprint": "0".repeat(64),
                        "deviceLabel": "D fixture phone"
                    }))
                    .unwrap(),
                    generation,
                )
                .unwrap_err()
                .code,
            "pairing-fingerprint-mismatch"
        );
        let paired = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": pairing_secret.clone(),
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "D fixture phone"
                }))
                .unwrap(),
                generation,
            )
            .unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        assert!(!credential.is_empty());
        assert_eq!(
            gateway
                .authenticate_request(&bearer_request(&credential))
                .unwrap()
                .device_id,
            device_id
        );
        assert_eq!(gateway.list_devices().unwrap().len(), 1);

        let connection = Connection::open(backend.db_path()).unwrap();
        let verifier: Vec<u8> = connection
            .query_row(
                "SELECT credential_verifier FROM companion_device WHERE device_id=?1",
                [&device_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(verifier.len(), 32);
        assert_ne!(verifier, credential.as_bytes());
        let audit_text = connection
            .prepare(
                "SELECT action || ':' || COALESCE(device_id,'') || ':' || result\r\n                 FROM companion_security_audit ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");
        assert!(!audit_text.contains(&credential));
        assert!(!audit_text.contains(&pairing_secret));
        drop(connection);

        let unpaired = pinned_http_response(
            &gateway,
            port,
            "GET /v1/session HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer invalid\r\n\r\n",
        );
        assert!(unpaired.starts_with("HTTP/1.1 401"));
        assert!(unpaired.contains("PAIRING_REQUIRED"));
        let query_rejected = pinned_http_response(
            &gateway,
            port,
            "GET /v1/session?token=forbidden HTTP/1.1\r\nHost: luckyray-companion.local\r\n\r\n",
        );
        assert!(query_rejected.starts_with("HTTP/1.1 400"));
        assert!(query_rejected.contains("gateway-url-query-rejected"));

        assert_eq!(
            gateway.revoke_device(&device_id).unwrap().gateway.outcome,
            RevokeOutcome::Revoked
        );
        assert_eq!(
            gateway
                .authenticate_request(&bearer_request(&credential))
                .unwrap_err()
                .code,
            "AUTH_REVOKED"
        );
        assert_eq!(
            gateway.revoke_device(&device_id).unwrap().gateway.outcome,
            RevokeOutcome::AlreadyRevoked
        );
        let audit_connection = Connection::open(backend.db_path()).unwrap();
        let actions = audit_connection
            .prepare("SELECT action FROM companion_security_audit ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<std::collections::HashSet<_>, _>>()
            .unwrap();
        for action in [
            "pairing-issued",
            "pairing-completed",
            "authentication-failed",
            "device-revoked",
        ] {
            assert!(actions.contains(action), "missing audit action {action}");
        }

        assert!(matches!(
            gateway.stop().unwrap(),
            GatewayStatus::Disabled { .. }
        ));
        let restarted = gateway.restart("127.0.0.1", Some(0)).unwrap();
        assert!(matches!(
            restarted,
            GatewayStatus::Running {
                generation: next,
                ..
            } if next == generation + 1
        ));
        gateway.stop().unwrap();
    }

    #[test]
    fn scoped_pairing_cancel_retires_only_the_matching_unconsumed_ticket() {
        let (_root, _backend, _store, gateway) =
            gateway_fixture("pair-cancel", GatewayPolicy::default());
        gateway.start("127.0.0.1", None).unwrap();
        let exchange = |presentation: &PairingPresentation| {
            gateway.exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": presentation.secret,
                    "fingerprint": presentation.fp,
                    "deviceLabel": "Cancel fixture"
                }))
                .unwrap(),
                running_generation(&gateway),
            )
        };
        let first = gateway.issue_pairing_presentation(false).unwrap();
        assert!(gateway.cancel_pairing(&first.pairing_id));
        assert_eq!(exchange(&first).unwrap_err().code, "pairing-required");
        // Closing then reopening works immediately, within the existing rate limit.
        let second = gateway.issue_pairing_presentation(false).unwrap();
        assert!(!gateway.cancel_pairing(&first.pairing_id));
        assert!(exchange(&second).is_ok());
        let third = gateway.issue_pairing_presentation(false).unwrap();
        assert!(!gateway.cancel_pairing(&second.pairing_id));
        assert!(!gateway.cancel_pairing("unknown-ticket"));
        assert!(exchange(&third).is_ok());
        assert_eq!(gateway.list_devices().unwrap().len(), 2);
        gateway.stop().unwrap();
    }

    #[test]
    fn app_shutdown_restores_the_same_listener_and_paired_tls_session() {
        let (_root, backend, store, gateway) =
            gateway_fixture("listener-resume", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            _ => panic!("listener did not start"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": envelope.secret,
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "Resume fixture"
                }))
                .unwrap(),
                running_generation(&gateway),
            )
            .unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let identity = gateway.identity().unwrap();
        let connect_events = |service: &CompanionGateway| {
            let mut tls = pinned_client(service, port);
            write!(tls, "GET /v1/events HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
            tls.flush().unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                tls.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            assert!(head.starts_with(b"HTTP/1.1 101"));
            let mut ping = [0u8; 10];
            tls.read_exact(&mut ping).unwrap();
            assert_eq!(ping[0], 0x89);
            tls
        };
        let previous_events = connect_events(&gateway);
        // Restart while an authenticated WSS socket is still open, as on Mobile.
        gateway.shutdown();
        drop(gateway);

        let reopened =
            CompanionGateway::initialize_with_store(backend, store, GatewayPolicy::default());
        assert!(
            matches!(reopened.status(), GatewayStatus::Running { port: actual, .. } if actual == port)
        );
        assert_eq!(
            reopened.identity().unwrap().instance_id,
            identity.instance_id
        );
        assert_eq!(
            reopened.identity().unwrap().fingerprint,
            identity.fingerprint
        );
        let response = pinned_http_response(&reopened, port, &format!(
            "GET /v1/session HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\n\r\n"
        ));
        assert!(response.starts_with("HTTP/1.1 200"));
        let resumed_events = connect_events(&reopened);
        drop(previous_events);
        drop(resumed_events);
        reopened.stop().unwrap();
    }

    #[test]
    fn listener_is_not_reported_running_when_opt_in_cannot_be_saved() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("config-write-failure", GatewayPolicy::default());
        let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        open_connection(backend.db_path())
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_listener_setting BEFORE INSERT ON settings\r\n             WHEN NEW.key='companion.gateway.listener.v1'\r\n             BEGIN SELECT RAISE(ABORT,'fixture read-only setting'); END;",
            )
            .unwrap();
        assert_eq!(
            gateway.start("127.0.0.1", Some(port)).unwrap_err().code,
            "gateway-listener-config-unavailable"
        );
        assert!(matches!(gateway.status(), GatewayStatus::Disabled { .. }));
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
    }

    #[test]
    fn rejected_stop_keeps_listener_connection_and_ticket_until_persisted_retry() {
        let (_root, backend, store, gateway) =
            gateway_fixture("stop-config-rejected", GatewayPolicy::default());
        let running = gateway.start("127.0.0.1", None).unwrap();
        let port = match running {
            GatewayStatus::Running { port, .. } => port,
            _ => panic!("listener did not start"),
        };
        let generation = running_generation(&gateway);
        let exchange = |envelope: &PairingEnvelope| {
            gateway.exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": envelope.secret,
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "Stop fixture"
                }))
                .unwrap(),
                generation,
            )
        };
        let paired = exchange(&gateway.issue_pairing().unwrap()).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let mut events = pinned_client(&gateway, port);
        write!(events, "GET /v1/events HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
        events.flush().unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            events.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
        assert!(head.starts_with(b"HTTP/1.1 101"));
        let mut ping = [0u8; 10];
        events.read_exact(&mut ping).unwrap();
        assert_eq!(ping[0], 0x89);
        let pending = gateway.issue_pairing().unwrap();
        let connection = open_connection(backend.db_path()).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_listener_stop BEFORE DELETE ON settings\r\n             WHEN OLD.key='companion.gateway.listener.v1'\r\n             BEGIN SELECT RAISE(ABORT,'fixture read-only setting'); END;",
            )
            .unwrap();

        assert_eq!(
            gateway.stop().unwrap_err().code,
            "gateway-listener-config-unavailable"
        );
        assert_eq!(gateway.status(), running);
        assert!(gateway
            .list_devices()
            .unwrap()
            .iter()
            .any(|device| device.connected));
        // A fresh control exchange proves the existing socket survived Stop.
        events
            .write_all(&[0x89, 0x81, 1, 2, 3, 4, 0x42 ^ 1])
            .unwrap();
        events.flush().unwrap();
        let mut pong = [0u8; 3];
        events.read_exact(&mut pong).unwrap();
        assert_eq!(pong, [0x8A, 1, 0x42]);
        assert!(
            exchange(&pending).is_ok(),
            "failed Stop must not silently cancel the pending ticket"
        );
        let next_ticket = gateway.issue_pairing().unwrap();

        connection
            .execute_batch("DROP TRIGGER reject_listener_stop")
            .unwrap();
        assert!(matches!(
            gateway.stop().unwrap(),
            GatewayStatus::Disabled { .. }
        ));
        assert!(matches!(events.read(&mut byte), Ok(0) | Err(_)));
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
        assert!(!gateway.cancel_pairing(&next_ticket.pairing_id));
        drop(events);
        let reopened =
            CompanionGateway::initialize_with_store(backend, store, GatewayPolicy::default());
        assert!(matches!(reopened.status(), GatewayStatus::Disabled { .. }));
    }

    #[test]
    fn saved_listener_conflict_is_visible_and_retry_never_changes_port() {
        let (_root, backend, store, gateway) =
            gateway_fixture("resume-conflict", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", None).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            _ => panic!("listener did not start"),
        };
        gateway.shutdown();
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
        let reopened = CompanionGateway::initialize_with_store(
            Arc::clone(&backend),
            store.clone(),
            GatewayPolicy::default(),
        );
        match reopened.status() {
            GatewayStatus::ResumeFailed { bind_address, port: actual, code, bind_failure: Some(details) } => {
                assert_eq!(bind_address.as_deref(), Some("127.0.0.1"));
                assert_eq!(actual, Some(port));
                assert_eq!(code, "gateway-bind-conflict");
                let value = serde_json::to_value(details).unwrap();
                assert_eq!(value["stage"], "bind");
                assert_eq!(value["kind"], "address-in-use");
                assert_eq!(value["attempts"], 1);
            }
            status => panic!("unexpected conflict status: {status:?}"),
        }
        assert_eq!(
            reopened.start("127.0.0.1", None).unwrap_err().code,
            "gateway-bind-conflict"
        );
        assert_eq!(
            reopened.start("127.0.0.2", None).unwrap_err().code,
            "gateway-resume-address-mismatch"
        );
        drop(occupied);
        assert!(
            matches!(reopened.start("127.0.0.1", None).unwrap(), GatewayStatus::Running { port: actual, .. } if actual == port)
        );
        assert!(
            matches!(reopened.restart("127.0.0.1", None).unwrap(), GatewayStatus::Running { port: actual, .. } if actual == port)
        );
        reopened.stop().unwrap();
        let disabled =
            CompanionGateway::initialize_with_store(backend, store, GatewayPolicy::default());
        assert!(matches!(disabled.status(), GatewayStatus::Disabled { .. }));
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
    }

    #[test]
    fn explicit_endpoint_recovery_preserves_pairing_authority_and_stable_reopen() {
        let (_root, backend, store, gateway) = gateway_fixture("endpoint-recovery", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() { GatewayStatus::Running { port, .. } => port, _ => unreachable!() };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint, "deviceLabel": "Synthetic recovery"
        })).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let identity = (gateway.identity().unwrap().instance_id.clone(), gateway.identity().unwrap().fingerprint.clone());
        let original_devices = serde_json::to_value(gateway.list_devices().unwrap()).unwrap();
        gateway.shutdown();
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
        let reopened = CompanionGateway::initialize_with_store(Arc::clone(&backend), store.clone(), GatewayPolicy::default());
        assert_eq!(reopened.recover_endpoint("127.0.0.1", port, false).unwrap_err().code, "gateway-recovery-confirmation-required");
        assert_eq!(reopened.recover_endpoint("127.0.0.1", port.wrapping_add(1), true).unwrap_err().code, "gateway-recovery-state-changed");
        assert_eq!(load_listener_config(backend.db_path()).unwrap().unwrap().port, port);
        let new_port = match reopened.recover_endpoint("127.0.0.1", port, true).unwrap() { GatewayStatus::Running { port, bind_address, .. } => { assert_eq!(bind_address, "127.0.0.1"); port }, _ => unreachable!() };
        assert_ne!(new_port, port);
        assert!(occupied.local_addr().is_ok());
        assert_eq!(serde_json::to_value(reopened.list_devices().unwrap()).unwrap(), original_devices);
        assert!(reopened.verify_credential(credential).is_ok());
        let presentation = serde_json::to_value(reopened.endpoint_recovery_presentation().unwrap()).unwrap();
        let payload = presentation["envelope"].as_object().unwrap();
        assert_eq!(payload.len(), 5);
        assert_eq!(payload["schema"], 1); assert_eq!(payload["kind"], "luckyray.endpoint-recovery");
        assert_eq!(payload["baseUrl"], format!("https://127.0.0.1:{new_port}"));
        assert_eq!(payload["desktopInstanceId"], identity.0); assert_eq!(payload["certificateFingerprint"], identity.1);
        assert!(presentation["qrPath"].as_str().unwrap().starts_with('M'));
        let hello = pinned_http_response(&reopened, new_port, "GET /v1/hello HTTP/1.1\r\nHost: luckyray-companion.local\r\n\r\n");
        assert!(hello.starts_with("HTTP/1.1 200"));
        let session = pinned_http_response(&reopened, new_port, &format!("GET /v1/session HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\n\r\n"));
        assert!(session.starts_with("HTTP/1.1 200"));
        assert_eq!(reopened.recover_endpoint("127.0.0.1", port, true).unwrap_err().code, "gateway-recovery-state-changed");
        reopened.shutdown();
        let final_open = CompanionGateway::initialize_with_store(backend, store, GatewayPolicy::default());
        assert!(matches!(final_open.status(), GatewayStatus::Running { port: actual, .. } if actual == new_port));
        assert_eq!(final_open.identity().unwrap().instance_id, identity.0);
        assert_eq!(final_open.identity().unwrap().fingerprint, identity.1);
        assert!(final_open.verify_credential(credential).is_ok());
        final_open.stop().unwrap();
        assert!(final_open.endpoint_recovery_presentation().is_err());
    }

    #[test]
    fn failed_endpoint_persistence_keeps_original_opt_in_and_no_listener() {
        let (_root, backend, store, gateway) = gateway_fixture("endpoint-store-failure", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() { GatewayStatus::Running { port, .. } => port, _ => unreachable!() };
        gateway.shutdown();
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
        let reopened = CompanionGateway::initialize_with_store(Arc::clone(&backend), store, GatewayPolicy::default());
        let connection = open_connection(backend.db_path()).unwrap();
        connection.execute_batch(&format!("CREATE TRIGGER reject_endpoint_change BEFORE INSERT ON settings WHEN NEW.key='{LISTENER_SETTING_KEY}' BEGIN SELECT RAISE(ABORT,'synthetic'); END;")).unwrap();
        assert_eq!(reopened.recover_endpoint("127.0.0.1", port, true).unwrap_err().code, "gateway-listener-config-unavailable");
        assert_eq!(load_listener_config(backend.db_path()).unwrap().unwrap().port, port);
        assert!(reopened.lifecycle.lock().unwrap().running.is_none());
        assert!(occupied.local_addr().is_ok());
        connection.execute_batch("DROP TRIGGER reject_endpoint_change").unwrap();
        drop(occupied);
        assert!(matches!(reopened.start("127.0.0.1", None).unwrap(), GatewayStatus::Running { port: actual, .. } if actual == port));
        reopened.stop().unwrap();
    }

    #[test]
    fn malformed_saved_listener_requires_explicit_stop_before_new_opt_in() {
        let (_root, backend, store, gateway) =
            gateway_fixture("resume-invalid", GatewayPolicy::default());
        for value in [
            r#"{"bindAddress":"127.0.0.1","port":0}"#,
            r#"{"bindAddress":"8.8.8.8","port":48080}"#,
            r#"{"bindAddress":"127.0.0.1","port":37418}"#,
            "invalid",
        ] {
            open_connection(backend.db_path())
                .unwrap()
                .execute(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES (?1,?2)",
                    params![LISTENER_SETTING_KEY, value],
                )
                .unwrap();
            let reopened = CompanionGateway::initialize_with_store(
                Arc::clone(&backend),
                store.clone(),
                GatewayPolicy::default(),
            );
            assert!(matches!(
                reopened.status(),
                GatewayStatus::ResumeFailed { .. }
            ));
            assert!(reopened.start("127.0.0.1", None).is_err());
            reopened.stop().unwrap();
            assert!(matches!(reopened.status(), GatewayStatus::Disabled { .. }));
        }
        gateway.start("127.0.0.1", None).unwrap();
        gateway.stop().unwrap();
    }

    #[test]
    fn clean_service_reopen_preserves_identity_device_metadata_and_credential_authority() {
        let (_root, backend, store, gateway) =
            gateway_fixture("service-reopen", GatewayPolicy::default());
        gateway.start("127.0.0.1", Some(0)).unwrap();
        let generation = running_generation(&gateway);
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": envelope.secret,
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "Reopen fixture"
                }))
                .unwrap(),
                generation,
            )
            .unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let instance_id = gateway.identity().unwrap().instance_id.clone();
        gateway.stop().unwrap();
        drop(gateway);

        let reopened =
            CompanionGateway::initialize_with_store(backend, store, GatewayPolicy::default());
        assert_eq!(reopened.identity().unwrap().instance_id, instance_id);
        assert_eq!(reopened.list_devices().unwrap().len(), 1);
        assert!(reopened.verify_credential(&credential).is_ok());
        assert!(matches!(reopened.status(), GatewayStatus::Disabled { .. }));
    }

    #[test]
    fn concurrent_start_is_single_flight_and_stop_releases_the_only_listener() {
        let (_root, _backend, _store, gateway) =
            gateway_fixture("concurrent-start", GatewayPolicy::default());
        let barrier = Arc::new(std::sync::Barrier::new(5));
        let mut workers = Vec::new();
        for _ in 0..4 {
            let gateway = Arc::clone(&gateway);
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                barrier.wait();
                gateway.start("127.0.0.1", Some(0))
            }));
        }
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert!(results.iter().all(|result| {
            result.is_ok() || result.as_ref().unwrap_err().code == "gateway-transition-in-progress"
        }));
        let running = results
            .into_iter()
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        assert!(!running.is_empty());
        let addresses = running
            .iter()
            .map(|status| match status {
                GatewayStatus::Running {
                    port, generation, ..
                } => (*port, *generation),
                status => panic!("unexpected status: {status:?}"),
            })
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(addresses.len(), 1);
        let port = addresses.iter().next().unwrap().0;
        assert!(matches!(
            gateway.start("127.0.0.1", Some(port)).unwrap(),
            GatewayStatus::Running { port: current, .. } if current == port
        ));
        gateway.stop().unwrap();
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
    }

    #[test]
    fn slow_first_request_hits_one_total_deadline_and_releases_its_connection_slot() {
        let mut policy = GatewayPolicy::default();
        policy.connection_limit = 1;
        policy.request_deadline = Duration::from_millis(100);
        let (_root, _backend, _store, gateway) = gateway_fixture("request-deadline", policy);
        let status = gateway.start("127.0.0.1", Some(0)).unwrap();
        let port = match status {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };

        let started_at = Instant::now();
        let mut slow = pinned_client(&gateway, port);
        slow.write_all(b"G").unwrap();
        slow.flush().unwrap();
        let release_deadline = Instant::now() + Duration::from_secs(1);
        while !gateway.connections.lock().unwrap().entries.is_empty()
            && Instant::now() < release_deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(gateway.connections.lock().unwrap().entries.is_empty());
        assert!(started_at.elapsed() < Duration::from_secs(1));

        let healthy = pinned_http_response(
            &gateway,
            port,
            "GET /v1/hello HTTP/1.1\r\nHost: luckyray-companion.local\r\n\r\n",
        );
        assert!(healthy.starts_with("HTTP/1.1 200"));
        gateway.stop().unwrap();
    }

    #[test]
    fn lsh_remote_session_rejects_during_stop_without_holding_its_connection_open() {
        let gate = TestTransitionGate::new();
        let mut policy = GatewayPolicy::default();
        policy.stop_gate = Some(Arc::clone(&gate));
        let (_root, _backend, _store, gateway) = gateway_fixture("lsh-session-stop", policy);
        let (port, generation) = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, generation, .. } => (port, generation),
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({
                "secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "D stop boundary phone"
            })).unwrap(),
            generation,
        ).unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        gateway.set_lsh_remote_grant(device_id, true).unwrap();
        // Create the pinned TLS connection while the listener still reports
        // Running; the request itself is sent only after Stop owns transition.
        let mut tls = pinned_tls_client_with_timeout(&gateway, port, Duration::from_secs(3));

        let stopping_gateway = Arc::clone(&gateway);
        let stopping = thread::spawn(move || stopping_gateway.stop());
        gate.entered.wait();
        let (tx, rx) = std::sync::mpsc::channel();
        let requesting = thread::spawn(move || {
            let request = format!("POST /v1/lsh/remote/session HTTP/1.1\r\nHost: luckyray-companion.local:{port}\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = tls.write_all(request.as_bytes());
            let _ = tls.flush();
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut response = String::new();
            let mut buffer = [0u8; 4096];
            while Instant::now() < deadline {
                match tls.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => response.push_str(&String::from_utf8_lossy(&buffer[..read])),
                    Err(ref error) if error.kind() == io::ErrorKind::TimedOut || error.kind() == io::ErrorKind::WouldBlock => continue,
                    Err(_) => break,
                }
            }
            let _ = tx.send(response);
        });
        let prompt_response = rx.recv_timeout(Duration::from_secs(2));
        gate.release.wait();
        let stopped = stopping.join().unwrap();
        requesting.join().unwrap();
        assert!(prompt_response.is_ok(), "session waited on stop-owned transition lock");
        let response = prompt_response.unwrap();
        assert!(response.starts_with("HTTP/1.1 503") && response.contains("gateway-transition-in-progress"),
            "stopping listener did not fail the session promptly: {}", response.lines().next().unwrap_or("<empty>"));
        assert!(matches!(stopped, Ok(GatewayStatus::Disabled { .. })),
            "listener did not stop cleanly after session rejection");
    }

    #[test]
    fn stop_is_generation_linearized_and_retires_the_active_pairing_ticket() {
        let gate = TestTransitionGate::new();
        let mut policy = GatewayPolicy::default();
        policy.stop_gate = Some(Arc::clone(&gate));
        let (_root, _backend, _store, gateway) = gateway_fixture("stop-fence", policy);
        let running = gateway.start("127.0.0.1", Some(0)).unwrap();
        let (old_port, old_generation) = match running {
            GatewayStatus::Running {
                port, generation, ..
            } => (port, generation),
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let stale_secret = envelope.secret.clone();
        let fingerprint = envelope.certificate_fingerprint.clone();

        let stopping_gateway = Arc::clone(&gateway);
        let stopping = thread::spawn(move || stopping_gateway.stop());
        gate.entered.wait();
        assert!(matches!(
            gateway.status(),
            GatewayStatus::Stopping {
                generation,
                ..
            } if generation == old_generation
        ));
        assert_eq!(
            gateway.start("127.0.0.1", Some(0)).unwrap_err().code,
            "gateway-transition-in-progress"
        );
        assert_eq!(
            gateway.stop().unwrap_err().code,
            "gateway-transition-in-progress"
        );
        assert!(gateway.pairing.lock().unwrap().active.is_none());
        gate.release.wait();
        assert!(matches!(
            stopping.join().unwrap().unwrap(),
            GatewayStatus::Disabled { .. }
        ));
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, old_port)).is_err());

        let restarted = gateway.start("127.0.0.1", Some(0)).unwrap();
        assert!(matches!(
            restarted,
            GatewayStatus::Running {
                generation,
                ..
            } if generation == old_generation + 1
        ));
        let stale_request = serde_json::to_vec(&json!({
            "secret": stale_secret,
            "fingerprint": fingerprint,
            "deviceLabel": "Retired fixture"
        }))
        .unwrap();
        assert_eq!(
            gateway
                .exchange_legacy_pairing_fixture(&stale_request, old_generation)
                .unwrap_err()
                .code,
            "pairing-generation-retired"
        );
        gateway.stop().unwrap();
    }

    #[test]
    fn restart_owns_the_transition_across_stop_and_start() {
        let gate = TestTransitionGate::new();
        let mut policy = GatewayPolicy::default();
        policy.stop_gate = Some(Arc::clone(&gate));
        let (_root, _backend, _store, gateway) = gateway_fixture("restart-fence", policy);
        let old_status = gateway.start("127.0.0.1", Some(0)).unwrap();
        let (old_port, old_generation) = match old_status {
            GatewayStatus::Running {
                port, generation, ..
            } => (port, generation),
            status => panic!("unexpected status: {status:?}"),
        };
        let target_probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let target_port = target_probe.local_addr().unwrap().port();
        drop(target_probe);

        let restarting_gateway = Arc::clone(&gateway);
        let restarting =
            thread::spawn(move || restarting_gateway.restart("127.0.0.1", Some(target_port)));
        gate.entered.wait();
        for error in [
            gateway.start("127.0.0.1", Some(0)).unwrap_err(),
            gateway.stop().unwrap_err(),
            gateway.restart("127.0.0.1", Some(0)).unwrap_err(),
        ] {
            assert_eq!(error.code, "gateway-transition-in-progress");
        }
        gate.release.wait();

        let restarted = restarting.join().unwrap().unwrap();
        let (new_port, new_generation) = match restarted {
            GatewayStatus::Running {
                port, generation, ..
            } => (port, generation),
            status => panic!("unexpected status: {status:?}"),
        };
        assert_eq!(new_generation, old_generation + 1);
        assert_eq!(new_port, target_port);
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, old_port)).is_err());
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, new_port)).is_ok());
        gateway.stop().unwrap();
    }

    #[test]
    fn stale_retired_connections_fail_closed_before_a_new_listener_starts() {
        let (_root, _backend, _store, gateway) =
            gateway_fixture("stale-connection", GatewayPolicy::default());
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address).unwrap();
        let (server, _) = listener.accept().unwrap();
        let connection_id = gateway
            .connections
            .lock()
            .unwrap()
            .register(&server, gateway.policy.connection_limit)
            .unwrap();
        assert_eq!(
            gateway.start("127.0.0.1", Some(0)).unwrap_err().code,
            "gateway-stop-incomplete"
        );
        gateway
            .connections
            .lock()
            .unwrap()
            .unregister(connection_id);
        drop(client);
        drop(server);
        gateway.start("127.0.0.1", Some(0)).unwrap();
        gateway.stop().unwrap();
    }

    #[test]
    fn device_limit_fails_before_consuming_the_next_pairing_secret() {
        let mut policy = GatewayPolicy::default();
        policy.device_limit = 1;
        policy.issue_limit = 4;
        let (_root, _backend, _store, gateway) = gateway_fixture("device-limit", policy);
        gateway.start("127.0.0.1", Some(0)).unwrap();
        let generation = running_generation(&gateway);

        let first = gateway.issue_pairing().unwrap();
        let first_pair = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": first.secret,
                    "fingerprint": first.certificate_fingerprint,
                    "deviceLabel": "First fixture"
                }))
                .unwrap(),
                generation,
            )
            .unwrap();
        let second = gateway.issue_pairing().unwrap();
        let second_request = serde_json::to_vec(&json!({
            "secret": second.secret,
            "fingerprint": second.certificate_fingerprint,
            "deviceLabel": "Second fixture"
        }))
        .unwrap();
        assert_eq!(
            gateway
                .exchange_legacy_pairing_fixture(&second_request, generation)
                .unwrap_err()
                .code,
            "pairing-device-limit"
        );
        gateway
            .revoke_device(first_pair["deviceId"].as_str().unwrap())
            .unwrap();
        assert!(gateway
            .exchange_legacy_pairing_fixture(&second_request, generation)
            .is_ok());
        gateway.stop().unwrap();
    }

    #[test]
    fn event_candidate_is_device_bound_before_revoke_can_race_authentication() {
        let gate = TestTransitionGate::new();
        let mut policy = GatewayPolicy::default();
        policy.event_auth_gate = Some(Arc::clone(&gate));
        let (_root, _backend, _store, gateway) = gateway_fixture("event-revoke-race", policy);
        gateway.start("127.0.0.1", Some(0)).unwrap();
        let generation = running_generation(&gateway);
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": envelope.secret.as_str(),
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "Race fixture"
                }))
                .unwrap(),
                generation,
            )
            .unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(address).unwrap();
        let (server, _) = listener.accept().unwrap();
        let connection_id = gateway
            .connections
            .lock()
            .unwrap()
            .register(&server, gateway.policy.connection_limit)
            .unwrap();
        let authenticating_gateway = Arc::clone(&gateway);
        let authenticating = thread::spawn(move || {
            authenticating_gateway
                .authenticate_event_request(&bearer_request(&credential), connection_id)
        });
        gate.entered.wait();
        assert_eq!(
            gateway
                .connections
                .lock()
                .unwrap()
                .entries
                .get(&connection_id)
                .and_then(|record| record.device_id.as_deref()),
            Some(device_id.as_str())
        );
        assert_eq!(
            gateway.revoke_device(&device_id).unwrap().gateway.outcome,
            RevokeOutcome::Revoked
        );
        gate.release.wait();
        assert_eq!(
            authenticating.join().unwrap().unwrap_err().code,
            "AUTH_REVOKED"
        );
        client
            .set_read_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        let mut byte = [0u8; 1];
        assert!(matches!(client.read(&mut byte), Ok(0) | Err(_)));
        gateway
            .connections
            .lock()
            .unwrap()
            .unregister(connection_id);
        drop(server);
        gateway.stop().unwrap();
    }

    #[test]
    fn invalid_lan_requests_have_a_bounded_append_only_audit_budget() {
        let mut policy = GatewayPolicy::default();
        policy.failure_audit_limit = 3;
        policy.failure_audit_window = Duration::from_secs(60);
        let (_root, backend, _store, gateway) = gateway_fixture("audit-budget", policy);
        let status = gateway.start("127.0.0.1", Some(0)).unwrap();
        let port = match status {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        for index in 0..12 {
            let response = if index % 2 == 0 {
                pinned_http_response(
                    &gateway,
                    port,
                    "POST /v1/pair HTTP/1.1\r\nHost: luckyray-companion.local\r\nContent-Length: 2\r\n\r\n{}",
                )
            } else {
                pinned_http_response(
                    &gateway,
                    port,
                    "GET /v1/session HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer invalid\r\n\r\n",
                )
            };
            assert!(response.starts_with("HTTP/1.1 401"));
        }
        let connection = Connection::open(backend.db_path()).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM companion_security_audit", [], |row| {
                    row.get::<_, i64>(0)
                },)
                .unwrap(),
            4
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM companion_security_audit\r\n                     WHERE action='security-failure-rate-limited'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        drop(connection);

        gateway.failure_audit.lock().unwrap().window_started =
            Instant::now() - gateway.policy.failure_audit_window;
        let recovered = pinned_http_response(
            &gateway,
            port,
            "GET /v1/session HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer invalid\r\n\r\n",
        );
        assert!(recovered.starts_with("HTTP/1.1 401"));
        assert_eq!(
            Connection::open(backend.db_path())
                .unwrap()
                .query_row("SELECT COUNT(*) FROM companion_security_audit", [], |row| {
                    row.get::<_, i64>(0)
                },)
                .unwrap(),
            5
        );
        gateway.stop().unwrap();
    }

    #[test]
    fn successful_authentication_has_a_per_device_database_write_budget() {
        let mut policy = GatewayPolicy::default();
        policy.authenticated_request_limit = 2;
        policy.authenticated_request_window = Duration::from_secs(60);
        let (_root, backend, _store, gateway) = gateway_fixture("auth-budget", policy);
        gateway.start("127.0.0.1", Some(0)).unwrap();
        let generation = running_generation(&gateway);
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": envelope.secret.as_str(),
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "Budget fixture"
                }))
                .unwrap(),
                generation,
            )
            .unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();

        let connection = Connection::open(backend.db_path()).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE auth_update_fixture(total INTEGER NOT NULL);\r\n                 INSERT INTO auth_update_fixture(total) VALUES (0);\r\n                 CREATE TRIGGER auth_update_fixture_count\r\n                 AFTER UPDATE OF last_authenticated_at ON companion_device\r\n                 BEGIN\r\n                    UPDATE auth_update_fixture SET total=total+1;\r\n                 END;",
            )
            .unwrap();
        drop(connection);

        for _ in 0..2 {
            gateway
                .authenticate_request(&bearer_request(&credential))
                .unwrap();
        }
        let limited = gateway
            .authenticate_request(&bearer_request(&credential))
            .unwrap_err();
        assert_eq!(limited.code, "AUTH_RATE_LIMITED");
        assert_eq!(authentication_http_status(&limited), 429);
        assert_eq!(
            Connection::open(backend.db_path())
                .unwrap()
                .query_row("SELECT total FROM auth_update_fixture", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            2
        );

        gateway
            .authenticated_requests
            .lock()
            .unwrap()
            .devices
            .get_mut(&device_id)
            .unwrap()
            .started_at = Instant::now() - gateway.policy.authenticated_request_window;
        gateway
            .authenticate_request(&bearer_request(&credential))
            .unwrap();
        assert_eq!(
            Connection::open(backend.db_path())
                .unwrap()
                .query_row("SELECT total FROM auth_update_fixture", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            3
        );
        gateway.stop().unwrap();
    }

    #[test]
    fn bind_selection_is_explicit_private_and_reports_conflict_or_manual_permission() {
        for address in ["127.0.0.1", "10.1.2.3", "172.16.1.2", "192.168.1.4"] {
            assert_eq!(validate_bind_selection(address, 0).unwrap().port, 0);
        }
        for address in ["0.0.0.0", "8.8.8.8", "224.0.0.1", "::1"] {
            assert!(validate_bind_selection(address, 0).is_err(), "{address}");
        }
        for port in [LOCAL_TRANSPORT_PORT_START, LOCAL_TRANSPORT_PORT_END] {
            let error = match validate_bind_selection("127.0.0.1", port) {
                Ok(_) => panic!("reserved local-transport port {port} was accepted"),
                Err(error) => error,
            };
            assert_eq!(error.code, "gateway-local-transport-port-reserved");
        }
        assert_eq!(
            classify_bind_error(io::Error::new(ErrorKind::PermissionDenied, "fixture")).code,
            "gateway-bind-access-denied"
        );

        let (_root, _backend, _store, gateway) =
            gateway_fixture("bind-conflict", GatewayPolicy::default());
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert_eq!(
            gateway.start("127.0.0.1", Some(port)).unwrap_err().code,
            "gateway-bind-conflict"
        );
    }

    #[test]
    fn pinned_tls_authenticated_wss_shell_upgrades_and_emits_only_heartbeat() {
        let mut policy = GatewayPolicy::default();
        policy.heartbeat_interval = Duration::from_millis(250);
        let (_root, backend, _store, gateway) = gateway_fixture("wss", policy);
        let status = gateway.start("127.0.0.1", Some(0)).unwrap();
        let (port, generation) = match status {
            GatewayStatus::Running {
                port, generation, ..
            } => (port, generation),
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway
            .exchange_legacy_pairing_fixture(
                &serde_json::to_vec(&json!({
                    "secret": envelope.secret,
                    "fingerprint": envelope.certificate_fingerprint,
                    "deviceLabel": "Pinned TLS fixture"
                }))
                .unwrap(),
                generation,
            )
            .unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let identity = gateway.identity().unwrap();
        assert_eq!(identity.fingerprint, sha256_hex(&identity.certificate_der));

        let wrong_identity = generate_identity().unwrap();
        let mut wrong_roots = RootCertStore::empty();
        wrong_roots
            .add(CertificateDer::from(wrong_identity.certificate_der))
            .unwrap();
        let wrong_config = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(wrong_roots)
                .with_no_client_auth(),
        );
        let wrong_client = ClientConnection::new(
            wrong_config,
            ServerName::try_from("luckyray-companion.local").unwrap(),
        )
        .unwrap();
        let wrong_socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        let mut wrong_tls = StreamOwned::new(wrong_client, wrong_socket);
        let wrong_result = wrong_tls
            .write_all(b"GET /v1/hello HTTP/1.1\r\nHost: luckyray-companion.local\r\n\r\n")
            .and_then(|_| wrong_tls.flush());
        assert!(
            wrong_result.is_err(),
            "an unpinned certificate must be rejected"
        );

        let mut tls = pinned_client(&gateway, port);
        write!(
            tls,
            "GET /v1/events HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        )
        .unwrap();
        tls.flush().unwrap();
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            tls.read_exact(&mut byte).unwrap();
            response.push(byte[0]);
        }
        assert!(String::from_utf8(response)
            .unwrap()
            .starts_with("HTTP/1.1 101"));
        let mut heartbeat = [0u8; 10];
        tls.read_exact(&mut heartbeat).unwrap();
        assert_eq!(heartbeat[0], 0x89);
        assert_eq!(heartbeat[1], 8);
        let mask = [0x31, 0x42, 0x53, 0x64];
        let mut pong = vec![0x8A, 0x88];
        pong.extend_from_slice(&mask);
        pong.extend(
            heartbeat[2..]
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        tls.write_all(&pong).unwrap();
        tls.flush().unwrap();

        assert_eq!(
            gateway.revoke_device(device_id).unwrap().gateway.outcome,
            RevokeOutcome::Revoked
        );
        tls.sock
            .set_read_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut closed = false;
        let mut byte = [0u8; 1];
        while Instant::now() < deadline {
            match tls.read(&mut byte) {
                Ok(0) | Err(_) => {
                    closed = true;
                    break;
                }
                Ok(_) => {}
            }
        }
        assert!(
            closed,
            "revocation must close the authenticated WSS session"
        );
        drop(tls);
        let reconnect = pinned_http_response(
            &gateway,
            port,
            &format!(
                "GET /v1/events HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
            ),
        );
        assert!(reconnect.starts_with("HTTP/1.1 401"));
        assert!(reconnect.contains("AUTH_REVOKED"));
        gateway.stop().unwrap();
        let audit_connection = Connection::open(backend.db_path()).unwrap();
        let audit_actions = audit_connection
            .prepare("SELECT action FROM companion_security_audit ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<std::collections::HashSet<_>, _>>()
            .unwrap();
        for action in ["event-connected", "event-disconnected", "device-revoked"] {
            assert!(
                audit_actions.contains(action),
                "missing WSS audit action {action}"
            );
        }
    }

    #[test]
    fn pairing_presentation_is_exact_v1_local_qr_and_reissue_retires_the_old_secret() {
        let (_root, _backend, _store, gateway) =
            gateway_fixture("pairing-presentation", GatewayPolicy::default());
        gateway.start("127.0.0.1", Some(0)).unwrap();

        let first = gateway.issue_pairing_presentation(false).unwrap();
        let first_secret = first.secret.clone();
        assert_eq!(first.v, 1);
        assert_eq!(first.name, "LuckyRay Desktop");
        assert_eq!(first.ip, "127.0.0.1");
        assert!(first.port > 0);
        assert_eq!(first.fp.len(), 64);
        assert!(first.qr_size > 0);
        assert!(first.qr_path.starts_with('M'));
        assert!(!first.qr_path.contains(&first.secret));

        let canonical = serialize_canonical_pairing_payload(
            &first.name,
            &first.instance,
            &first.ip,
            first.port,
            &first.secret,
            &first.fp,
        )
        .unwrap();
        let exact: Value = serde_json::from_str(&canonical).unwrap();
        assert_eq!(
            exact
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>(),
            ["v", "name", "instance", "ip", "port", "secret", "fp"]
                .into_iter()
                .collect::<BTreeSet<_>>()
        );
        assert_eq!(exact.as_object().unwrap().len(), 7);
        assert_eq!(exact["v"], 1);
        assert_eq!(exact["secret"], first.secret);

        assert_eq!(
            gateway
                .issue_pairing_presentation(false)
                .err()
                .unwrap()
                .code,
            "pairing-already-active"
        );
        let replacement = gateway.issue_pairing_presentation(true).unwrap();
        assert_ne!(replacement.secret, first_secret);
        assert_eq!(replacement.instance, first.instance);
        gateway.stop().unwrap();
    }

    #[test]
    fn interface_projection_is_private_up_deduplicated_and_stable() {
        let interfaces = normalize_lan_interfaces([
            ("Wi-Fi".to_owned(), Ipv4Addr::new(192, 168, 1, 20), 24, true),
            (
                "duplicate".to_owned(),
                Ipv4Addr::new(192, 168, 1, 20),
                24,
                true,
            ),
            ("Ethernet".to_owned(), Ipv4Addr::new(10, 1, 2, 3), 16, true),
            ("VPN".to_owned(), Ipv4Addr::new(172, 20, 1, 8), 20, true),
            ("public".to_owned(), Ipv4Addr::new(8, 8, 8, 8), 24, true),
            ("loopback".to_owned(), Ipv4Addr::LOCALHOST, 8, true),
            ("down".to_owned(), Ipv4Addr::new(192, 168, 1, 21), 24, false),
            (
                "bad-prefix".to_owned(),
                Ipv4Addr::new(192, 168, 1, 22),
                33,
                true,
            ),
        ]);
        assert_eq!(interfaces.len(), 3);
        assert_eq!(
            interfaces
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["Ethernet", "VPN", "Wi-Fi"]
        );
        assert!(interfaces
            .iter()
            .all(|item| is_private_lan(item.address.parse().unwrap())));

        assert_eq!(
            validate_management_bind_address("192.168.1.20", &interfaces).unwrap(),
            "192.168.1.20"
        );
        for rejected in ["127.0.0.1", "0.0.0.0", "8.8.8.8", "192.168.1.99"] {
            assert!(validate_management_bind_address(rejected, &interfaces).is_err());
        }
    }

    #[test]
    fn pairing_and_authentication_http_errors_remain_finite_and_distinguishable() {
        for (code, status) in [
            ("pairing-secret-invalid", 401),
            ("pairing-expired", 410),
            ("pairing-generation-retired", 410),
            ("pairing-replayed", 409),
            ("pairing-device-limit", 409),
            ("pairing-rate-limited", 429),
        ] {
            assert_eq!(
                pairing_http_status(&GatewayError::new(code, "fixture")),
                status
            );
        }
        assert_eq!(
            authentication_http_status(&GatewayError::new("AUTH_REVOKED", "fixture")),
            401
        );
        assert_eq!(
            authentication_http_status(&GatewayError::new("AUTH_RATE_LIMITED", "fixture")),
            429
        );
    }

    #[test]
    fn management_projection_has_camel_case_fields_and_bounded_secret_free_audit() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("management-projection", GatewayPolicy::default());
        let status = serde_json::to_value(gateway.status()).unwrap();
        assert_eq!(status["state"], "disabled");
        assert!(status.get("desktopInstanceId").is_some());
        assert!(status.get("certificateFingerprint").is_some());
        assert!(status.get("desktop_instance_id").is_none());

        for index in 0..64 {
            append_audit(
                backend.db_path(),
                "fixture-security-event",
                None,
                if index % 2 == 0 {
                    "accepted"
                } else {
                    "rejected"
                },
            )
            .unwrap();
        }
        let rows = gateway.list_security_audit(Some(usize::MAX)).unwrap();
        assert_eq!(rows.len(), MAX_AUDIT_ROWS);
        let encoded = serde_json::to_string(&rows).unwrap();
        for forbidden in ["secret", "credential", "token"] {
            assert!(!encoded.to_lowercase().contains(forbidden));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_interface_enumeration_never_projects_wildcard_public_or_loopback() {
        let interfaces = list_lan_ipv4_interfaces().unwrap();
        let mut unique = BTreeSet::new();
        for interface in interfaces {
            let address: Ipv4Addr = interface.address.parse().unwrap();
            assert!(is_private_lan(address));
            assert_ne!(address, Ipv4Addr::UNSPECIFIED);
            assert!(unique.insert(address));
            assert!(interface.prefix_length <= 32);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_dpapi_round_trip_is_not_plaintext() {
        let plaintext = b"bounded-companion-secret-fixture";
        let protected = dpapi_protect(plaintext).unwrap();
        assert_ne!(protected, plaintext);
        assert_eq!(dpapi_unprotect(&protected).unwrap(), plaintext);
    }

    #[test]
    fn request_and_websocket_framing_reject_duplicate_auth_and_business_payloads() {
        let duplicate = b"GET /v1/session HTTP/1.1\r\nAuthorization: Bearer one\r\nauthorization: Bearer two\r\n\r\n";
        let duplicate_error = match read_http_request(&mut Cursor::new(duplicate)) {
            Ok(_) => panic!("duplicate authorization headers were accepted"),
            Err(error) => error,
        };
        assert_eq!(duplicate_error.code, "gateway-request-invalid");

        let mut request = HttpRequest::default();
        request.headers = HashMap::from([
            ("upgrade".to_owned(), "websocket".to_owned()),
            ("connection".to_owned(), "keep-alive, Upgrade".to_owned()),
            ("sec-websocket-version".to_owned(), "13".to_owned()),
            (
                "sec-websocket-key".to_owned(),
                "dGhlIHNhbXBsZSBub25jZQ==".to_owned(),
            ),
        ]);
        assert!(is_websocket_upgrade(&request));
        request
            .headers
            .insert("sec-websocket-key".to_owned(), "too-short".to_owned());
        assert!(!is_websocket_upgrade(&request));
        request.headers.insert(
            "sec-websocket-key".to_owned(),
            "dGhlIHNhbXBsZSBub25jZQ==".to_owned(),
        );
        let mut accepted = Vec::new();
        websocket_accept(&mut accepted, &request).unwrap();
        assert!(String::from_utf8(accepted)
            .unwrap()
            .contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));

        let mask = [4u8, 3, 2, 1];
        let payload = b"forbidden-business-payload";
        let mut frame = vec![0x81, 0x80 | payload.len() as u8];
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        let (opcode, decoded) = read_ws_frame(&mut Cursor::new(frame)).unwrap().unwrap();
        assert_eq!(opcode, 0x1);
        assert_eq!(decoded, payload);
        let mut close = Vec::new();
        write_ws_frame(&mut close, 0x8, &1003u16.to_be_bytes()).unwrap();
        assert_eq!(close, [0x88, 0x02, 0x03, 0xEB]);
    }

    fn pinned_http_response_allow_close(gateway: &CompanionGateway, port: u16, request: &str) -> String {
        let mut tls = pinned_client(gateway, port);
        let _ = tls.write_all(request.as_bytes());
        let _ = tls.flush();
        let mut response = Vec::new();
        let _ = tls.read_to_end(&mut response);
        String::from_utf8_lossy(&response).into_owned()
    }

    #[test]
    fn desktop_phone_batch_is_atomic_exact_scoped_and_survives_restart_switchback() {
        let (root, backend, store, gateway) = gateway_fixture("phone-batch-scope", GatewayPolicy::default());
        let registration = |id: &str| {
            let path = root.path().join(id);
            std::fs::create_dir_all(path.join(".luckyray")).unwrap();
            let value = crate::knowledge::KnowledgeVaultRegistration {
                id: id.into(), name: id.into(), root_path: path.to_string_lossy().into(), mode: "vault-bound".into(),
                created_at: "2026-10-07T00:00:00Z".into(), last_opened_at: "2026-10-07T00:00:00Z".into(),
                schema_version: 1, link_update_policy: Default::default(),
            };
            std::fs::write(path.join(".luckyray/vault.json"), serde_json::to_vec(&value).unwrap()).unwrap();
            value
        };
        let a = registration("vault-a"); let b = registration("vault-b");
        backend.knowledge().register_current_vault(&a).unwrap();
        let a_scope = content::current_vault_for_service(&gateway).unwrap().0;
        gateway.start("127.0.0.1", Some(0)).unwrap();
        let pair = |service: &Arc<CompanionGateway>| {
            let envelope = service.issue_pairing().unwrap();
            service.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
                "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint, "deviceLabel": "Scope test phone",
            })).unwrap(), running_generation(service)).unwrap()["deviceId"].as_str().unwrap().to_owned()
        };
        let device = pair(&gateway);
        let change = |class: &str, kind: &str, id: &str, enabled| services::ServiceGrantChange {
            grant_class: class.into(), scope_kind: kind.into(), scope_id: id.into(), enabled,
        };
        let selected = vec![change("content.read", "catalog", "", true), change("content.read", "vault", &a_scope, true)];
        gateway.set_service_grants(&device, &selected, 0, Some(&a_scope)).unwrap();
        let allowed = gateway.service_grant_state(&device).unwrap();
        assert_eq!(allowed["permissionRevision"], 1);
        assert_eq!(allowed["grants"].as_array().unwrap().len(), 2);
        assert!(gateway.set_service_grants(&device, &selected, 0, Some(&a_scope)).is_err(), "stale dialog revision");
        assert_eq!(gateway.service_grant_state(&device).unwrap()["grants"], allowed["grants"]);
        backend.knowledge().register_current_vault(&b).unwrap();
        let b_scope = content::current_vault_for_service(&gateway).unwrap().0;
        assert_ne!(a_scope, b_scope);
        assert_eq!(gateway.service_grant_state(&device).unwrap()["grants"], allowed["grants"]);
        assert!(gateway.set_service_grants(&device, &[change("content.write", "vault", &a_scope, true)], 1, Some(&a_scope)).is_err());
        backend.knowledge().register_current_vault(&a).unwrap();
        assert_eq!(content::current_vault_for_service(&gateway).unwrap().0, a_scope);
        assert_eq!(gateway.service_grant_state(&device).unwrap()["grants"], allowed["grants"]);
        assert!(gateway.shutdown()); drop(gateway);
        let reopened = CompanionGateway::initialize_with_store(backend.clone(), store, GatewayPolicy::default());
        assert_eq!(reopened.service_grant_state(&device).unwrap()["grants"], allowed["grants"]);
        // A later statement fails: the earlier successful insert rolls back too.
        let db = Connection::open(backend.db_path()).unwrap();
        db.execute_batch("CREATE TRIGGER phone_reject_second BEFORE INSERT ON companion_service_grant WHEN NEW.grant_class='desktop.open' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(reopened.set_service_grants(&device, &[
            change("ingest.write", "catalog", "", true), change("desktop.open", "catalog", "", true),
        ], 1, Some(&a_scope)).is_err());
        assert_eq!(reopened.service_grant_state(&device).unwrap()["grants"], allowed["grants"]);
        assert_eq!(reopened.service_grant_state(&device).unwrap()["permissionRevision"], 1);
        db.execute_batch("DROP TRIGGER phone_reject_second;").unwrap();
        // Old-vault rights can be revoked while another vault is active.
        backend.knowledge().register_current_vault(&b).unwrap();
        reopened.set_service_grants(&device, &[change("content.read", "vault", &a_scope, false)], 1, Some(&b_scope)).unwrap();
        assert_eq!(reopened.service_grant_state(&device).unwrap()["grants"].as_array().unwrap().len(), 1);
        reopened.revoke_device_with_lsh(&device).unwrap();
        assert!(reopened.service_grant_state(&device).is_err());
        assert!(reopened.set_service_grants(&device, &selected, 2, Some(&b_scope)).is_err());
        let new_device = pair(&reopened);
        assert_ne!(new_device, device);
        assert!(reopened.service_grant_state(&new_device).unwrap()["grants"].as_array().unwrap().is_empty(), "forget/re-pair cannot inherit rights");
        reopened.stop().unwrap();
    }

    #[test]
    fn desktop_phone_exited_listener_is_not_ready_and_retry_preserves_saved_endpoint() {
        let (_root, _backend, _store, gateway) = gateway_fixture("phone-listener-exited", GatewayPolicy::default());
        let before = gateway.start("127.0.0.1", Some(0)).unwrap();
        let (port, generation) = match before { GatewayStatus::Running { port, generation, .. } => (port, generation), _ => unreachable!() };
        // Simulate the accept worker retiring without a user Stop command.
        gateway.lifecycle.lock().unwrap().running.as_ref().unwrap().stop.store(true, Ordering::SeqCst);
        assert!(matches!(gateway.status(), GatewayStatus::ResumeFailed { code: "gateway-listener-unavailable", .. }));
        assert_eq!(gateway.issue_pairing().err().unwrap().code, "gateway-listener-unavailable");
        let retried = gateway.start("127.0.0.1", None).unwrap();
        assert!(matches!(retried, GatewayStatus::Running { port: restored, generation: next, .. } if restored == port && next > generation));
        gateway.stop().unwrap();
    }

    #[test]
    fn scoped_diagnostics_cross_the_real_pinned_tls_boundary() {
        let (_root, backend, _store, gateway) = gateway_fixture("scope-diagnostics-tls", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            _ => panic!("fixture listener unavailable"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Synthetic protocol fixture"
        })).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let scope = backend.material_catalog().library_state().unwrap().1;
        let send = |path: &str, scope: Option<&str>, authenticated: bool| {
            let authorization = if authenticated { format!("Authorization: Bearer {credential}\r\n") } else { String::new() };
            let scope_header = scope.map(|id| format!("X-LuckyRay-Material-Library: {id}\r\n")).unwrap_or_default();
            pinned_http_response(&gateway, port, &format!("GET {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\n{authorization}{scope_header}X-LuckyRay-Request-Id: synthetic-scope-1\r\nConnection: close\r\n\r\n"))
        };
        let catalog = send("/v1/services", Some(&scope), true);
        assert!(catalog.starts_with("HTTP/1.1 200"));
        assert!(catalog.contains("X-LuckyRay-Scope-Protocol: 1\r\n"));
        assert!(catalog.contains("X-LuckyRay-Request-Id: synthetic-scope-1\r\n"));
        assert!(catalog.contains("X-LuckyRay-Stage: response-commit\r\n"));
        assert!(catalog.contains("Server-Timing: companion;dur="));
        let body: Value = serde_json::from_str(catalog.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["reusableProofVersion"], 1);
        assert!(!send("/v1/services", None, true).contains("X-LuckyRay-Scope-Protocol:"));
        let invalid = send("/v1/services", Some("bad/path"), true);
        assert!(invalid.starts_with("HTTP/1.1 400"));
        assert!(invalid.contains("X-LuckyRay-Stage: scope-resolve\r\n"));
        assert!(!invalid.contains("X-LuckyRay-Scope-Protocol:"));
        let unauthenticated = send("/v1/services", Some(&scope), false);
        assert!(unauthenticated.starts_with("HTTP/1.1 401"));
        assert!(!unauthenticated.contains("X-LuckyRay-Scope-Protocol:"));
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        let allowed = send("/v1/services/materials/changes", Some(&scope), true);
        assert!(allowed.starts_with("HTTP/1.1 200"));
        assert!(allowed.contains("X-LuckyRay-Scope-Protocol: 1\r\n"));
        gateway.set_service_grant(device_id, "content.read", "catalog", "", false).unwrap();
        let denied = send("/v1/services/materials/changes", Some(&scope), true);
        assert!(denied.starts_with("HTTP/1.1 403"));
        assert!(!denied.contains("X-LuckyRay-Scope-Protocol:"));
        gateway.stop().unwrap();
    }

    #[test]
    fn services_grants_and_material_cursor_are_device_scoped() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-grant-cursor", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({
                "secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "Services fixture"
            })).unwrap(), running_generation(&gateway),
        ).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let get = |path: &str| pinned_http_response(&gateway, port,
            &format!("GET {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n"));

        let initial = get("/v1/services");
        assert!(initial.starts_with("HTTP/1.1 200"));
        let initial_body: Value = serde_json::from_str(initial.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(initial_body["operations"]["materials.changes"]["state"], "notGranted");
        assert!(get("/v1/services/materials/changes").starts_with("HTTP/1.1 403"));
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();

        let connection = Connection::open(backend.db_path()).unwrap();
        // A change for a no-longer-live object still needs a durable known owner.
        connection.execute(
            "INSERT INTO material_library_asset_history(asset_id,library_id)
             SELECT 'fixture-asset',legacy_id FROM material_library_state WHERE singleton=1", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
             VALUES('materials','','fixture-asset','r1','created',0,'now')", [],
        ).unwrap();
        let first = get("/v1/services/materials/changes?after=m:0&limit=1");
        assert!(first.starts_with("HTTP/1.1 200"), "{first}");
        let first_body: Value = serde_json::from_str(first.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(first_body["items"][0]["assetId"], "fixture-asset");
        let cursor = first_body["nextCursor"].as_str().unwrap().to_owned();
        connection.execute(
            "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                thumbnail_url,description,imported_at,updated_at)
             VALUES('fixture-asset','Current','C:/synthetic.jpg','linked','image','image/jpeg',1,
                '','','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')", [],
        ).unwrap();
        let detail = get("/v1/services/materials/assets/fixture-asset");
        let detail_body: Value = serde_json::from_str(detail.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let changed = get(&format!("/v1/services/materials/changes?after={cursor}"));
        let changed_body: Value = serde_json::from_str(changed.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(changed_body["items"][0]["revision"], detail_body["revision"]);

        gateway.set_service_grant(device_id, "content.read", "catalog", "", false).unwrap();
        assert!(get("/v1/services/materials/changes").starts_with("HTTP/1.1 403"));
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        let stale = get(&format!("/v1/services/materials/changes?after={cursor}"));
        assert!(stale.starts_with("HTTP/1.1 410"), "{stale}");
        gateway.stop().unwrap();
    }

    #[test]
    fn services_source_page_precision_survives_tls_detail_and_ingest() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-source-precision", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({"secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "Source precision fixture"})).unwrap(),
            running_generation(&gateway),
        ).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        gateway.set_service_grant(device_id, "ingest.write", "catalog", "", true).unwrap();
        let send = |method: &str, path: &str, body: &str| pinned_http_response(&gateway, port,
            &format!("{method} {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
        let connection = Connection::open(backend.db_path()).unwrap();
        connection.execute(
            "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                thumbnail_url,description,imported_at,updated_at)
             VALUES('source-work','Work','C:/synthetic.jpg','linked','image','image/jpeg',1,
                '','','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO asset_source_page(asset_id,page_url,page_kind,title)
             VALUES('source-work','https://example.test/#/work/42','work-page','Work')", [],
        ).unwrap();
        let detail = send("GET", "/v1/services/materials/assets/source-work", "");
        assert!(detail.starts_with("HTTP/1.1 200"), "{detail}");
        let body: Value = serde_json::from_str(detail.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["source"]["pageKind"], "work-page");
        assert_eq!(body["source"]["pageUrl"], "https://example.test/#/work/42");

        for (op, page_url, page_kind) in [
            ("capture", "https://example.test/search?topic=art#slide-3", "capture-page"),
            ("work", "https://example.test/#/work/43", "work-page"),
            ("legacy", "https://example.test/search?topic=art", "capture-page"),
        ] {
            let text = format!("source-{op}");
            let mut source = json!({"captureKind":"web","pageUrl":page_url});
            if op != "legacy" { source["pageKind"] = json!(page_kind); }
            let manifest = json!({"opId":format!("source-{op}"),"kind":"text",
                "target":{"domain":"materials"},"name":format!("{op}.txt"),
                "mimeType":"text/plain","sizeBytes":text.len(),
                "sha256":format!("{:x}", Sha256::digest(text.as_bytes())),
                "text":text,"source":source}).to_string();
            let started = send("POST", "/v1/services/ingest/jobs", &manifest);
            assert!(started.starts_with("HTTP/1.1 201"), "{started}");
            let job: Value = serde_json::from_str(started.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            let completed = send("POST", &format!("/v1/services/ingest/jobs/{}/complete",
                job["jobId"].as_str().unwrap()), "");
            assert!(completed.starts_with("HTTP/1.1 200"), "{completed}");
            let receipt: Value = serde_json::from_str(completed.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            let asset_id = receipt["receipt"]["assetId"].as_str().unwrap();
            let stored = backend.material_catalog().get_source_page(asset_id).unwrap().unwrap();
            assert_eq!(stored.page_kind, page_kind);
            assert_eq!(stored.page_url, page_url);
        }
        let origin_text = "source-origin";
        let origin_manifest = json!({"opId":"source-origin","kind":"text",
            "target":{"domain":"materials"},"name":"origin.txt",
            "mimeType":"text/plain","sizeBytes":origin_text.len(),
            "sha256":format!("{:x}", Sha256::digest(origin_text.as_bytes())),
            "text":origin_text,"source":{"captureKind":"web","siteOrigin":"https://example.test"}}).to_string();
        let origin_started = send("POST", "/v1/services/ingest/jobs", &origin_manifest);
        assert!(origin_started.starts_with("HTTP/1.1 201"), "{origin_started}");
        let origin_job: Value = serde_json::from_str(origin_started.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let origin_completed = send("POST", &format!("/v1/services/ingest/jobs/{}/complete",
            origin_job["jobId"].as_str().unwrap()), "");
        assert!(origin_completed.starts_with("HTTP/1.1 200"), "{origin_completed}");
        let origin_receipt: Value = serde_json::from_str(origin_completed.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let origin_asset = origin_receipt["receipt"]["assetId"].as_str().unwrap();
        let origin_stored = backend.material_catalog().get_source_page(origin_asset).unwrap().unwrap();
        assert_eq!(origin_stored.page_kind, "capture-page");
        assert_eq!(origin_stored.page_url, "https://example.test/");
        let unsafe_text = "secret-source";
        for page_url in ["https://example.test/#token=secret", "https://example.test/work?access_token=secret"] {
            let manifest = json!({"opId":format!("unsafe-{}", page_url.len()),"kind":"text",
                "target":{"domain":"materials"},"name":"unsafe.txt",
                "mimeType":"text/plain","sizeBytes":unsafe_text.len(),
                "sha256":format!("{:x}", Sha256::digest(unsafe_text.as_bytes())),
                "text":unsafe_text,"source":{"captureKind":"web", "pageKind":"work-page", "pageUrl":page_url}}).to_string();
            assert!(send("POST", "/v1/services/ingest/jobs", &manifest)
                .starts_with("HTTP/1.1 400"));
        }
        gateway.stop().unwrap();
    }

    #[test]
    fn services_old_complete_cannot_commit_after_full_device_revoke() {
        let gate = TestOneShotGate::new();
        let mut policy = GatewayPolicy::default();
        policy.services_after_auth_gate = Some(Arc::clone(&gate));
        let (_root, backend, _store, gateway) = gateway_fixture("services-revoke-complete", policy);
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Services revoked fixture"})).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        gateway.set_service_grant(&device_id, "ingest.write", "catalog", "", true).unwrap();
        let text = "revoke-complete-fixture";
        let manifest = json!({"opId":"revoke-complete","kind":"text",
            "target":{"domain":"materials"},"name":"revoke.txt","mimeType":"text/plain",
            "sizeBytes":text.len(),"sha256":format!("{:x}", Sha256::digest(text.as_bytes())),
            "text":text}).to_string();
        let begin = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/ingest/jobs HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len()));
        assert!(begin.starts_with("HTTP/1.1 201"), "{begin}");
        let job: Value = serde_json::from_str(begin.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let prior_text = "committed-before-revoke";
        let prior_manifest = json!({"opId":"prior-revoke","kind":"text",
            "target":{"domain":"materials"},"name":"prior.txt","mimeType":"text/plain",
            "sizeBytes":prior_text.len(),"sha256":format!("{:x}", Sha256::digest(prior_text.as_bytes())),
            "text":prior_text}).to_string();
        let prior_begin = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/ingest/jobs HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{prior_manifest}", prior_manifest.len()));
        assert!(prior_begin.starts_with("HTTP/1.1 201"), "{prior_begin}");
        let prior_job: Value = serde_json::from_str(prior_begin.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let prior_complete = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/ingest/jobs/{}/complete HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            prior_job["jobId"].as_str().unwrap()));
        assert!(prior_complete.starts_with("HTTP/1.1 200"), "{prior_complete}");
        let request = format!("POST /v1/services/ingest/jobs/{}/complete HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            job["jobId"].as_str().unwrap());
        gate.armed.store(true, Ordering::SeqCst);
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move ||
            pinned_http_response_allow_close(&worker_gateway, port, &request));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !gate.entered.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(gate.entered.load(Ordering::SeqCst), "complete did not reach after-auth gate");
        gateway.revoke_device_with_lsh(&device_id).unwrap();
        gate.release.store(true, Ordering::SeqCst);
        let _ = worker.join().unwrap();
        let count: i64 = Connection::open(backend.db_path()).unwrap().query_row(
            "SELECT COUNT(*) FROM asset WHERE name='revoke.txt'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "retired request committed a material after full revoke");
        let prior_count: i64 = Connection::open(backend.db_path()).unwrap().query_row(
            "SELECT COUNT(*) FROM asset WHERE name='prior.txt'", [], |row| row.get(0)).unwrap();
        assert_eq!(prior_count, 1, "revoke must not erase a pre-revoke committed result");
        gateway.stop().unwrap();
    }

    #[test]
    fn services_old_begin_does_not_deadlock_stop_or_write_after_stop() {
        let gate = TestOneShotGate::new();
        let stop_gate = TestTransitionGate::new();
        let mut policy = GatewayPolicy::default();
        policy.services_after_auth_gate = Some(Arc::clone(&gate));
        policy.stop_gate = Some(Arc::clone(&stop_gate));
        let (_root, backend, _store, gateway) = gateway_fixture("services-stop-begin", policy);
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Services stop fixture"})).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        gateway.set_service_grant(&device_id, "ingest.write", "catalog", "", true).unwrap();
        let text = "stop-begin-fixture";
        let manifest = json!({"opId":"stop-begin","kind":"text",
            "target":{"domain":"materials"},"name":"stop.txt","mimeType":"text/plain",
            "sizeBytes":text.len(),"sha256":format!("{:x}", Sha256::digest(text.as_bytes())),
            "text":text}).to_string();
        let request = format!("POST /v1/services/ingest/jobs HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len());
        gate.armed.store(true, Ordering::SeqCst);
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move ||
            pinned_http_response_allow_close(&worker_gateway, port, &request));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !gate.entered.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(gate.entered.load(Ordering::SeqCst), "begin did not reach after-auth gate");
        let stopping_gateway = Arc::clone(&gateway);
        let stopping = thread::spawn(move || stopping_gateway.stop());
        stop_gate.entered.wait();
        gate.release.store(true, Ordering::SeqCst);
        let _ = worker.join().unwrap();
        stop_gate.release.wait();
        assert!(matches!(stopping.join().unwrap(), Ok(GatewayStatus::Disabled { .. })),
            "Stop waited for a worker blocked on its lifecycle lock");
        let count: i64 = Connection::open(backend.db_path()).unwrap().query_row(
            "SELECT COUNT(*) FROM companion_service_upload WHERE op_id='stop-begin'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "retired begin created a staging job");
    }

    #[test]
    fn services_old_begin_does_not_revive_after_grant_toggle() {
        let gate = TestOneShotGate::new();
        let mut policy = GatewayPolicy::default();
        policy.services_after_auth_gate = Some(Arc::clone(&gate));
        let (_root, backend, _store, gateway) = gateway_fixture("services-grant-epoch", policy);
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Services grant epoch fixture"})).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        gateway.set_service_grant(&device_id, "ingest.write", "catalog", "", true).unwrap();
        let text = "grant-epoch-fixture";
        let manifest = json!({"opId":"grant-epoch","kind":"text",
            "target":{"domain":"materials"},"name":"epoch.txt","mimeType":"text/plain",
            "sizeBytes":text.len(),"sha256":format!("{:x}", Sha256::digest(text.as_bytes())),
            "text":text}).to_string();
        let request = format!("POST /v1/services/ingest/jobs HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len());
        gate.armed.store(true, Ordering::SeqCst);
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move || pinned_http_response_allow_close(&worker_gateway, port, &request));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !gate.entered.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(gate.entered.load(Ordering::SeqCst), "old request did not capture admission revision");
        gateway.set_service_grant(&device_id, "ingest.write", "catalog", "", false).unwrap();
        gateway.set_service_grant(&device_id, "ingest.write", "catalog", "", true).unwrap();
        gate.release.store(true, Ordering::SeqCst);
        let response = worker.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 403"), "old request revived after regrant: {response}");
        let count: i64 = Connection::open(backend.db_path()).unwrap().query_row(
            "SELECT COUNT(*) FROM companion_service_upload WHERE op_id='grant-epoch'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        gateway.stop().unwrap();
    }

    #[test]
    fn services_material_commit_rechecks_revoke_after_streaming_hash() {
        let gate = TestOneShotGate::new();
        let mut policy = GatewayPolicy::default();
        policy.services_before_material_commit_gate = Some(Arc::clone(&gate));
        let (_root, backend, _store, gateway) = gateway_fixture("services-commit-revoke", policy);
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Services commit fixture"})).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        gateway.set_service_grant(&device_id, "ingest.write", "catalog", "", true).unwrap();
        let text = "commit-revoke-fixture";
        let manifest = json!({"opId":"commit-revoke","kind":"text",
            "target":{"domain":"materials"},"name":"commit-revoke.txt","mimeType":"text/plain",
            "sizeBytes":text.len(),"sha256":format!("{:x}", Sha256::digest(text.as_bytes())),
            "text":text}).to_string();
        let begin = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/ingest/jobs HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len()));
        assert!(begin.starts_with("HTTP/1.1 201"), "{begin}");
        let job: Value = serde_json::from_str(begin.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let request = format!("POST /v1/services/ingest/jobs/{}/complete HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            job["jobId"].as_str().unwrap());
        gate.armed.store(true, Ordering::SeqCst);
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move ||
            pinned_http_response_allow_close(&worker_gateway, port, &request));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !gate.entered.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(gate.entered.load(Ordering::SeqCst), "material import did not reach post-hash boundary");
        gateway.revoke_device_with_lsh(&device_id).unwrap();
        gate.release.store(true, Ordering::SeqCst);
        let _ = worker.join().unwrap();
        let connection = Connection::open(backend.db_path()).unwrap();
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM asset WHERE name='commit-revoke.txt'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "post-revoke import reached the managed catalog");
        let stage: String = connection.query_row(
            "SELECT stage FROM companion_service_upload WHERE op_id='commit-revoke'", [], |row| row.get(0)).unwrap();
        assert_eq!(stage, "committing", "retired commit must not publish a receipt");
        assert!(backend.app_data_dir().join("media-transfer-staging")
            .join(format!("service-{}.part", job["jobId"].as_str().unwrap())).is_file(),
            "retired commit must retain verified staging for authorized recovery");
        let retired_deadline = Instant::now() + Duration::from_secs(2);
        while !gateway.connections.lock().unwrap().entries.is_empty() && Instant::now() < retired_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(gateway.connections.lock().unwrap().entries.is_empty(), "retired worker did not exit");
        gateway.stop().unwrap();
    }

    #[test]
    fn services_old_complete_cannot_cross_restart_generation() {
        let commit_gate = TestOneShotGate::new();
        let stop_gate = TestTransitionGate::new();
        let mut policy = GatewayPolicy::default();
        policy.services_before_material_commit_gate = Some(Arc::clone(&commit_gate));
        policy.stop_gate = Some(Arc::clone(&stop_gate));
        let (_root, backend, _store, gateway) = gateway_fixture("services-complete-restart", policy);
        let (port, old_generation) = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, generation, .. } => (port, generation),
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Services restart fixture"})).unwrap(), old_generation).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        gateway.set_service_grant(&device_id, "ingest.write", "catalog", "", true).unwrap();
        let text = "restart-complete-fixture";
        let manifest = json!({"opId":"restart-complete","kind":"text",
            "target":{"domain":"materials"},"name":"restart.txt","mimeType":"text/plain",
            "sizeBytes":text.len(),"sha256":format!("{:x}", Sha256::digest(text.as_bytes())),
            "text":text}).to_string();
        let begin = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/ingest/jobs HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len()));
        assert!(begin.starts_with("HTTP/1.1 201"), "{begin}");
        let job: Value = serde_json::from_str(begin.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let request = format!("POST /v1/services/ingest/jobs/{}/complete HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            job["jobId"].as_str().unwrap());
        commit_gate.armed.store(true, Ordering::SeqCst);
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move ||
            pinned_http_response_allow_close(&worker_gateway, port, &request));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !commit_gate.entered.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(commit_gate.entered.load(Ordering::SeqCst), "complete did not reach post-hash boundary");
        let restarting_gateway = Arc::clone(&gateway);
        let restarting = thread::spawn(move || restarting_gateway.restart("127.0.0.1", Some(0)));
        stop_gate.entered.wait();
        commit_gate.release.store(true, Ordering::SeqCst);
        let _ = worker.join().unwrap();
        stop_gate.release.wait();
        let new_generation = match restarting.join().unwrap().unwrap() {
            GatewayStatus::Running { generation, .. } => generation,
            status => panic!("restart did not restore listener: {status:?}"),
        };
        assert!(new_generation > old_generation);
        let count: i64 = Connection::open(backend.db_path()).unwrap().query_row(
            "SELECT COUNT(*) FROM asset WHERE name='restart.txt'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "old-generation complete committed after Restart");
        gateway.stop().unwrap();
    }

    #[test]
    fn services_claimed_presentation_without_ack_allows_stop_and_revoke() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-presentation-fence", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Presentation fence fixture",
        })).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        let unclaimed_id = random_hex(16);
        let (unclaimed_sender, unclaimed_receiver) = std::sync::mpsc::channel();
        gateway.presentation_pending.lock().unwrap().insert(unclaimed_id.clone(),
            PendingPresentation { sender: unclaimed_sender, claimed: false,
                device_id: device_id.clone(),
                deadline: std::time::Instant::now() + Duration::from_secs(30) });
        assert_eq!(gateway.acknowledge_presentation(&unclaimed_id, false).unwrap_err().code,
            "presentation-request-unclaimed");
        gateway.claim_presentation(&unclaimed_id).unwrap();
        gateway.acknowledge_presentation(&unclaimed_id, false).unwrap();
        assert!(!unclaimed_receiver.recv_timeout(Duration::from_secs(1)).unwrap());
        let late_id = random_hex(16);
        let (late_sender, _late_receiver) = std::sync::mpsc::channel();
        gateway.presentation_pending.lock().unwrap().insert(late_id.clone(),
            PendingPresentation { sender: late_sender, claimed: true,
                device_id: device_id.clone(), deadline: std::time::Instant::now() });
        assert_eq!(gateway.acknowledge_presentation(&late_id, true).unwrap_err().code,
            "presentation-request-expired");
        assert_eq!(gateway.claim_presentation(&late_id).unwrap_err().code,
            "presentation-request-expired");
        assert!(gateway.presentation_pending.lock().unwrap().get(&late_id).unwrap().claimed,
            "late ACK/claim must not erase a claimed offer before worker classification");
        gateway.presentation_pending.lock().unwrap().remove(&late_id);
        Connection::open(backend.db_path()).unwrap().execute(
            "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                thumbnail_url,description,imported_at,updated_at)
             VALUES('presentation-fixture','Fixture','C:/not-real.jpg','linked','image','image/jpeg',1,
                '','','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')", [],
        ).unwrap();
        gateway.set_service_grant(&device_id, "content.read", "catalog", "", true).unwrap();
        gateway.set_service_grant(&device_id, "desktop.open", "catalog", "", true).unwrap();
        let (unclaimed_tx, unclaimed_rx) = std::sync::mpsc::channel();
        gateway.attach_presentation_sink(Arc::new(move |offer| {
            unclaimed_tx.send(offer["requestId"].as_str().unwrap().to_owned()).unwrap();
            true
        }));
        let unclaimed_body = json!({"opId":"presentation-unclaimed-timeout","target":{
            "domain":"materials","assetId":"presentation-fixture"}}).to_string();
        let unclaimed_request = format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{unclaimed_body}", unclaimed_body.len());
        let unclaimed_gateway = Arc::clone(&gateway);
        let unclaimed_worker = thread::spawn(move || pinned_http_response(&unclaimed_gateway, port, &unclaimed_request));
        let expired_id = unclaimed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(unclaimed_worker.join().unwrap().starts_with("HTTP/1.1 409"));
        assert_eq!(gateway.claim_presentation(&expired_id).unwrap_err().code,
            "presentation-request-expired");
        let reject_gateway = Arc::clone(&gateway);
        gateway.attach_presentation_sink(Arc::new(move |offer| {
            let id = offer["requestId"].as_str().unwrap();
            reject_gateway.claim_presentation(id).unwrap();
            reject_gateway.acknowledge_presentation(id, false).unwrap();
            true
        }));
        let rejected_body = json!({"opId":"presentation-rejected","target":{
            "domain":"materials","assetId":"presentation-fixture"}}).to_string();
        let rejected_request = format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{rejected_body}", rejected_body.len());
        let rejected = pinned_http_response(&gateway, port, &rejected_request);
        assert!(rejected.starts_with("HTTP/1.1 409"), "{rejected}");
        assert!(pinned_http_response(&gateway, port, &rejected_request)
            .starts_with("HTTP/1.1 410"), "rejected opId may have partially navigated");
        let (claim_tx, claim_rx) = std::sync::mpsc::channel();
        let claim_gateway = Arc::clone(&gateway);
        gateway.attach_presentation_sink(Arc::new(move |offer| {
            let request_id = offer["requestId"].as_str().unwrap().to_owned();
            claim_gateway.claim_presentation(&request_id).unwrap();
            claim_tx.send(request_id).unwrap();
            true
        }));
        let body = json!({"opId":"presentation-fence","target":{
            "domain":"materials","assetId":"presentation-fixture"}}).to_string();
        let request = format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        );
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move || pinned_http_response_allow_close(&worker_gateway, port, &request));
        let request_id = claim_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let stop_started = std::time::Instant::now();
        let stopping_gateway = Arc::clone(&gateway);
        let stopping = thread::spawn(move || stopping_gateway.stop());
        let intent_deadline = std::time::Instant::now() + Duration::from_secs(1);
        while gateway.pending_controls.load(Ordering::SeqCst) == 0
            && std::time::Instant::now() < intent_deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(gateway.pending_controls.load(Ordering::SeqCst) > 0,
            "Stop did not publish control intent before waiting");
        assert_eq!(gateway.try_transition().unwrap_err().code,
            "gateway-transition-in-progress");
        let competing_body = json!({"opId":"presentation-competing-with-stop","target":{
            "domain":"materials","assetId":"presentation-fixture"}}).to_string();
        let competing = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{competing_body}", competing_body.len()));
        assert!(competing.starts_with("HTTP/1.1 503"), "{competing}");
        stopping.join().unwrap().unwrap();
        assert!(stop_started.elapsed() < Duration::from_secs(5), "Stop waited on a missing UI ACK");
        let _ = worker.join().unwrap();
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err(),
            "Stop left the old LAN listener alive");
        assert_eq!(gateway.acknowledge_presentation(&request_id, true).unwrap_err().code,
            "presentation-request-expired");
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let body = json!({"opId":"presentation-fence-after-restart","target":{
            "domain":"materials","assetId":"presentation-fixture"}}).to_string();
        let request = format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        );
        let replay_request = request.clone();
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move || pinned_http_response(&worker_gateway, port, &request));
        let second_id = claim_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(gateway.acknowledge_presentation(&request_id, true).unwrap_err().code,
            "presentation-request-expired");
        let response = worker.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let receipt: Value = serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(receipt["state"], "handoffStarted");
        assert_eq!(pinned_http_response(&gateway, port, &replay_request), response,
            "a lost ACK retry must replay without a second navigation offer");
        assert!(claim_rx.try_recv().is_err(), "same opId emitted a second offer");
        gateway.set_service_grant(&device_id, "desktop.open", "catalog", "", false).unwrap();
        let denied_body = json!({"opId":"presentation-after-grant-revoke","target":{
            "domain":"materials","assetId":"presentation-fixture"}}).to_string();
        let denied = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{denied_body}", denied_body.len()));
        assert!(denied.starts_with("HTTP/1.1 403"), "{denied}");
        gateway.revoke_device_with_lsh(&device_id).unwrap();
        let old_tls = pinned_http_response(&gateway, port, &format!(
            "GET /v1/services HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n"));
        assert!(old_tls.starts_with("HTTP/1.1 401"), "{old_tls}");
        let old_write = pinned_http_response(&gateway, port, &format!(
            "PATCH /v1/services/materials/assets/presentation-fixture HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"));
        assert!(old_write.starts_with("HTTP/1.1 401"), "{old_write}");
        assert_eq!(gateway.acknowledge_presentation(&second_id, true).unwrap_err().code,
            "presentation-request-expired");
        gateway.stop().unwrap();
    }

    #[test]
    fn services_presentation_receipt_failure_keeps_op_id_reserved() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-presentation-receipt-failure", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Presentation receipt failure fixture"})).unwrap(),
            running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        Connection::open(backend.db_path()).unwrap().execute(
            "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                thumbnail_url,description,imported_at,updated_at)
             VALUES('receipt-fixture','Fixture','C:/not-real.jpg','linked','image','image/jpeg',1,
                '','','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')", [],
        ).unwrap();
        gateway.set_service_grant(&device_id, "content.read", "catalog", "", true).unwrap();
        gateway.set_service_grant(&device_id, "desktop.open", "catalog", "", true).unwrap();
        Connection::open(backend.db_path()).unwrap().execute_batch(
            "CREATE TRIGGER receipt_busy_fail BEFORE UPDATE OF stage
             ON companion_service_operation
             WHEN NEW.op_id='receipt-busy' AND NEW.stage='committed'
             BEGIN SELECT RAISE(FAIL, 'receipt unavailable'); END",
        ).unwrap();
        let (claim_tx, claim_rx) = std::sync::mpsc::channel();
        let offers = Arc::new(AtomicUsize::new(0));
        let offer_count = Arc::clone(&offers);
        let claim_gateway = Arc::clone(&gateway);
        gateway.attach_presentation_sink(Arc::new(move |offer| {
            offer_count.fetch_add(1, Ordering::SeqCst);
            let id = offer["requestId"].as_str().unwrap();
            claim_gateway.claim_presentation(id).unwrap();
            claim_tx.send(()).unwrap();
            true
        }));
        let body = json!({"opId":"receipt-busy","target":{
            "domain":"materials","assetId":"receipt-fixture"}}).to_string();
        let request = format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let worker_gateway = Arc::clone(&gateway);
        let worker_request = request.clone();
        let worker = thread::spawn(move || pinned_http_response_allow_close(&worker_gateway, port, &worker_request));
        claim_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let response = worker.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 503"), "{response}");
        gateway.stop().unwrap();
        let stage: String = Connection::open(backend.db_path()).unwrap().query_row(
            "SELECT stage FROM companion_service_operation WHERE device_id=?1
             AND operation_id='presentation.open' AND op_id='receipt-busy'",
            [&device_id], |row| row.get(0)).unwrap();
        assert_eq!(stage, "pending", "failed settlement must retain the opId fence");
        let new_port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let replay = pinned_http_response(&gateway, new_port, &request);
        assert!(replay.starts_with("HTTP/1.1 410"), "{replay}");
        assert_eq!(offers.load(Ordering::SeqCst), 1, "receipt failure re-offered the same opId");
        gateway.stop().unwrap();
    }

    #[test]
    fn services_material_write_receipt_replay_and_revision_conflict() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-material-write", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({"secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "Material write fixture"})).unwrap(),
            running_generation(&gateway),
        ).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let connection = Connection::open(backend.db_path()).unwrap();
        connection.execute(
            "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                thumbnail_url,description,imported_at,updated_at)
             VALUES('fixture-asset','Before','C:/fixture-not-real.jpg','linked','image',
                'image/jpeg',12,'','', '2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')", [],
        ).unwrap();
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        let send = |method: &str, body: &str| pinned_http_response(&gateway, port,
            &format!("{method} /v1/services/materials/assets/fixture-asset HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
        let detail = send("GET", "");
        assert!(detail.starts_with("HTTP/1.1 200"), "{detail}");
        let body: Value = serde_json::from_str(detail.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let revision = body["revision"].as_str().unwrap();
        let presented = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = Arc::clone(&presented);
        let ack_gateway = Arc::clone(&gateway);
        gateway.attach_presentation_sink(Arc::new(move |target| {
            let request_id = target["requestId"].as_str().unwrap().to_owned();
            captured.lock().unwrap().push(target);
            ack_gateway.claim_presentation(&request_id).unwrap();
            ack_gateway.acknowledge_presentation(&request_id, true).unwrap();
            true
        }));
        let open_body = json!({"opId":"open-one","target":{"domain":"materials",
            "assetId":"fixture-asset"}}).to_string();
        let open = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{open_body}", open_body.len()));
        assert!(open.starts_with("HTTP/1.1 403"));
        gateway.set_service_grant(device_id, "desktop.open", "catalog", "", true).unwrap();
        let present = || pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/presentation/open HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{open_body}", open_body.len()));
        let open = present();
        assert!(open.starts_with("HTTP/1.1 200"), "{open}");
        assert_eq!(present(), open);
        assert_eq!(presented.lock().unwrap().len(), 1);
        let patch = json!({"opId":"rename-one","expectedRevision":revision,"name":"After"}).to_string();
        assert!(send("PATCH", &patch).starts_with("HTTP/1.1 403"));
        gateway.set_service_grant(device_id, "content.write", "catalog", "", true).unwrap();
        let updated = send("PATCH", &patch);
        assert!(updated.starts_with("HTTP/1.1 200"), "{updated}");
        assert!(send("POST", "").starts_with("HTTP/1.1 405 Method Not Allowed"));
        assert_eq!(send("PATCH", &patch), updated);
        let updated_body: Value = serde_json::from_str(updated.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(updated_body["disposition"], "updated");
        let reused = json!({"opId":"rename-one","expectedRevision":revision,"name":"Different"}).to_string();
        assert!(send("PATCH", &reused).contains("OP_ID_REUSED"));
        let stale = json!({"opId":"rename-two","expectedRevision":revision,"name":"Stale"}).to_string();
        assert!(send("PATCH", &stale).contains("REVISION_CONFLICT"));
        let remove = json!({"opId":"remove-one","expectedRevision":updated_body["revision"],
            "mode":"removeRecord"}).to_string();
        let removed = send("DELETE", &remove);
        assert!(removed.starts_with("HTTP/1.1 200"), "{removed}");
        assert_eq!(send("DELETE", &remove), removed);
        assert!(send("GET", "").starts_with("HTTP/1.1 404"));
        gateway.stop().unwrap();
    }

    #[test]
    fn services_search_snapshot_survives_live_catalog_change() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-search", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({"secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "Search fixture"})).unwrap(),
            running_generation(&gateway),
        ).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let mut connection = Connection::open(backend.db_path()).unwrap();
        for (id, name) in [("blue-one", "Blue One"), ("blue-two", "Blue Two")] {
            connection.execute(
                "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                    thumbnail_url,description,imported_at,updated_at)
                 VALUES(?1,?2,'C:/fixture-not-real.jpg','linked','image','image/jpeg',12,'','',
                    '2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')",
                params![id, name],
            ).unwrap();
        }
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        let get = |path: &str| pinned_http_response(&gateway, port,
            &format!("GET {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n"));
        let first = get("/v1/services/search?q=Blue&domains=materials&limit=1");
        assert!(first.starts_with("HTTP/1.1 200"), "{first}");
        let first_body: Value = serde_json::from_str(first.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let cursor = first_body["nextCursor"].as_str().expect("second search page");
        let other_envelope = gateway.issue_pairing().unwrap();
        let other_paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({"secret": other_envelope.secret,
                "fingerprint": other_envelope.certificate_fingerprint,
                "deviceLabel": "Second search fixture"})).unwrap(),
            running_generation(&gateway)).unwrap();
        let other_id = other_paired["deviceId"].as_str().unwrap();
        let other_credential = other_paired["credential"].as_str().unwrap();
        gateway.set_service_grant(other_id, "content.read", "catalog", "", true).unwrap();
        let other_cursor_response = pinned_http_response(&gateway, port,
            &format!("GET /v1/services/search?q=Blue&domains=materials&limit=1&cursor={cursor} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {other_credential}\r\nConnection: close\r\n\r\n"));
        assert!(other_cursor_response.starts_with("HTTP/1.1 410"), "{other_cursor_response}");
        let other_fresh = pinned_http_response(&gateway, port,
            &format!("GET /v1/services/search?q=Blue&domains=materials&limit=1 HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {other_credential}\r\nConnection: close\r\n\r\n"));
        assert!(other_fresh.starts_with("HTTP/1.1 200"), "{other_fresh}");
        connection.execute("UPDATE asset SET name='Changed' WHERE id='blue-two'", []).unwrap();
        let retried = get("/v1/services/search?q=Blue&domains=materials&limit=1");
        let retried_body: Value = serde_json::from_str(retried.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(retried_body["nextCursor"], cursor,
            "same-query retry must reuse the live immutable snapshot despite catalog edits");
        let second = get(&format!("/v1/services/search?q=Blue&domains=materials&limit=1&cursor={cursor}"));
        assert!(second.starts_with("HTTP/1.1 200"), "{second}");
        let second_body: Value = serde_json::from_str(second.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(second_body["items"][0]["domain"], "materials");
        assert!(second_body["items"][0]["title"].as_str().unwrap().starts_with("Blue"));
        connection.execute("UPDATE companion_service_search_snapshot SET expires_at=0", []).unwrap();
        assert!(get(&format!("/v1/services/search?q=Blue&domains=materials&limit=1&cursor={cursor}"))
            .starts_with("HTTP/1.1 410"));
        for _ in 0..6 {
            let complete = get("/v1/services/search?q=One&domains=materials&limit=1");
            assert!(complete.starts_with("HTTP/1.1 200"), "{complete}");
            assert!(get("/v1/services/search?q=NoSuchMaterial&domains=materials&limit=1")
                .starts_with("HTTP/1.1 200"));
        }
        let active_snapshots: i64 = connection.query_row(
            "SELECT COUNT(*) FROM companion_service_search_snapshot WHERE expires_at>?1",
            [chrono::Utc::now().timestamp()], |row| row.get(0),
        ).unwrap();
        assert_eq!(active_snapshots, 0, "complete/empty searches must not consume a cursor lease");
        {
            let transaction = connection.transaction().unwrap();
            {
                let mut insert = transaction.prepare(
                    "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                        thumbnail_url,description,imported_at,updated_at)
                     VALUES(?1,?2,'C:/fixture-not-real.jpg','linked','image','image/jpeg',12,'','',
                        '2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')").unwrap();
                for index in 0..=5000 {
                    insert.execute(params![format!("wide-{index}"), format!("Wide {index}")]).unwrap();
                }
            }
            transaction.commit().unwrap();
        }
        let over_limit = get("/v1/services/search?q=Wide&domains=materials&limit=50");
        assert!(over_limit.starts_with("HTTP/1.1 400") && over_limit.contains("INPUT_INVALID"),
            "over-5000 query must fail rather than expose a partial snapshot: {over_limit}");
        gateway.set_service_grant(device_id, "content.read", "catalog", "", false).unwrap();
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        assert!(get(&format!("/v1/services/search?q=Blue&domains=materials&limit=1&cursor={cursor}"))
            .starts_with("HTTP/1.1 410"));
        gateway.stop().unwrap();
    }

    #[test]
    fn services_search_five_complete_paginated_rounds_release_snapshot_leases() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-search-complete-rounds", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({"secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "Search completion fixture"})).unwrap(),
            running_generation(&gateway),
        ).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let connection = Connection::open(backend.db_path()).unwrap();
        for (id, name) in [("cycle-one", "Cycle One"), ("cycle-two", "Cycle Two")] {
            connection.execute(
                "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                    thumbnail_url,description,imported_at,updated_at)
                 VALUES(?1,?2,'C:/fixture-not-real.jpg','linked','image','image/jpeg',12,'','',
                    '2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')",
                params![id, name],
            ).unwrap();
        }
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        let get = |path: &str| pinned_http_response(&gateway, port,
            &format!("GET {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n"));
        let mut completed_cursors = Vec::new();
        for round in 0..5 {
            let first = get("/v1/services/search?q=Cycle&domains=materials&limit=1");
            assert!(first.starts_with("HTTP/1.1 200"), "round {round}: {first}");
            let body: Value = serde_json::from_str(first.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            let cursor = body["nextCursor"].as_str().expect("second page cursor").to_owned();
            let second = get(&format!("/v1/services/search?q=Cycle&domains=materials&limit=1&cursor={cursor}"));
            assert!(second.starts_with("HTTP/1.1 200"), "round {round}: {second}");
            let body: Value = serde_json::from_str(second.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert!(body["nextCursor"].is_null(), "round {round}: {second}");
            completed_cursors.push(cursor);
        }
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM companion_service_search_snapshot WHERE expires_at>?1",
            [chrono::Utc::now().timestamp()], |row| row.get(0)).unwrap();
        assert_eq!(active, 0, "completed pagination must not retain an active lease");
        for cursor in completed_cursors {
            assert!(get(&format!("/v1/services/search?q=Cycle&domains=materials&limit=1&cursor={cursor}"))
                .starts_with("HTTP/1.1 410"), "retired cursor must not silently restart");
        }
        gateway.stop().unwrap();
    }

    #[test]
    fn services_search_retry_and_replacement_reuse_bounded_leases() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-search-replacement", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let pair = |label: &str| {
            let envelope = gateway.issue_pairing().unwrap();
            gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
                "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": label})).unwrap(), running_generation(&gateway)).unwrap()
        };
        let first_device = pair("Search replacement device");
        let first_id = first_device["deviceId"].as_str().unwrap();
        let first_credential = first_device["credential"].as_str().unwrap();
        let second_device = pair("Search isolation device");
        let second_id = second_device["deviceId"].as_str().unwrap();
        let second_credential = second_device["credential"].as_str().unwrap();
        let connection = Connection::open(backend.db_path()).unwrap();
        for group in ["Alpha", "Bravo", "Charlie", "Delta", "Echo"] {
            for number in 0..3 {
                connection.execute(
                    "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                        thumbnail_url,description,imported_at,updated_at)
                     VALUES(?1,?2,'C:/fixture-not-real.jpg','linked','image','image/jpeg',12,'','',
                        '2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')",
                    params![format!("{group}-{number}"), format!("{group} {number}")],
                ).unwrap();
            }
        }
        for id in [first_id, second_id] {
            gateway.set_service_grant(id, "content.read", "catalog", "", true).unwrap();
        }
        let get = |credential: &str, path: &str| pinned_http_response(&gateway, port,
            &format!("GET {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n"));
        let first = get(first_credential, "/v1/services/search?q=Alpha&domains=materials&limit=1");
        let alpha_cursor = serde_json::from_str::<Value>(first.split("\r\n\r\n").nth(1).unwrap())
            .unwrap()["nextCursor"].as_str().unwrap().to_owned();
        let retry = get(first_credential, "/v1/services/search?q=Alpha&domains=materials&limit=1");
        assert_eq!(retry, first, "same query retry must reuse the immutable snapshot");
        let isolated = get(second_credential, "/v1/services/search?q=Alpha&domains=materials&limit=1");
        let isolated_cursor = serde_json::from_str::<Value>(isolated.split("\r\n\r\n").nth(1).unwrap())
            .unwrap()["nextCursor"].as_str().unwrap().to_owned();
        let mut surviving = Vec::new();
        for group in ["Bravo", "Charlie", "Delta", "Echo"] {
            let response = get(first_credential,
                &format!("/v1/services/search?q={group}&domains=materials&limit=1"));
            assert!(response.starts_with("HTTP/1.1 200"), "{group}: {response}");
            let cursor = serde_json::from_str::<Value>(response.split("\r\n\r\n").nth(1).unwrap())
                .unwrap()["nextCursor"].as_str().unwrap().to_owned();
            surviving.push((group, cursor));
            let own: i64 = connection.query_row(
                "SELECT COUNT(*) FROM companion_service_search_snapshot WHERE device_id=?1 AND expires_at>?2",
                params![first_id, chrono::Utc::now().timestamp()], |row| row.get(0)).unwrap();
            assert!(own <= 4, "replacement exceeded the per-device snapshot cap");
        }
        assert!(get(first_credential, &format!(
            "/v1/services/search?q=Alpha&domains=materials&limit=1&cursor={alpha_cursor}"))
            .starts_with("HTTP/1.1 410"), "replaced cursor must fail explicitly");
        for (group, cursor) in surviving {
            let page = get(first_credential, &format!(
                "/v1/services/search?q={group}&domains=materials&limit=1&cursor={cursor}"));
            assert!(page.starts_with("HTTP/1.1 200"),
                "still-live same-device concurrent cursor was evicted: {page}");
        }
        assert!(get(second_credential, &format!(
            "/v1/services/search?q=Alpha&domains=materials&limit=1&cursor={isolated_cursor}"))
            .starts_with("HTTP/1.1 200"), "one device must not evict another device's cursor");
        let mut connection = Connection::open(backend.db_path()).unwrap();
        let transaction = connection.transaction().unwrap();
        {
            let mut insert = transaction.prepare(
                "INSERT INTO asset(id,name,original_path,storage_mode,kind,mime_type,size_bytes,
                    thumbnail_url,description,imported_at,updated_at)
                 VALUES(?1,?2,'C:/fixture-not-real.jpg','linked','image','image/jpeg',12,'',?3,
                    '2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')").unwrap();
            let description = "x".repeat(4000);
            for number in 0..1100 {
                insert.execute(params![format!("heavy-{number}"), format!("Heavy {number}"), description]).unwrap();
            }
        }
        transaction.commit().unwrap();
        let oversized = get(first_credential, "/v1/services/search?q=Heavy&domains=materials&limit=1");
        assert!(oversized.starts_with("HTTP/1.1 429") && oversized.contains("RATE_LIMITED"),
            "single oversized snapshot bypassed byte cap: {}", &oversized[..oversized.len().min(300)]);
        gateway.stop().unwrap();
    }

    #[test]
    fn services_material_ingest_chunk_retry_and_durable_receipt() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-ingest", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({"secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "Ingest fixture"})).unwrap(),
            running_generation(&gateway),
        ).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        gateway.set_service_grant(device_id, "ingest.write", "catalog", "", true).unwrap();
        let send = |method: &str, path: &str, body: &str, extra: &str| pinned_http_response(&gateway, port,
            &format!("{method} {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}", body.len()));
        let bytes = "fixture-binary-content";
        let digest = format!("{:x}", Sha256::digest(bytes.as_bytes()));
        let begin = json!({"opId":"ingest-one","kind":"file","target":{"domain":"materials"},
            "name":"sample.bin","mimeType":"application/octet-stream","sizeBytes":bytes.len(),
            "sha256":digest}).to_string();
        let started = send("POST", "/v1/services/ingest/jobs", &begin, "Content-Type: application/json\r\n");
        assert!(started.starts_with("HTTP/1.1 201"), "{started}");
        let job: Value = serde_json::from_str(started.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let id = job["jobId"].as_str().unwrap();
        let retry_begin = send("POST", "/v1/services/ingest/jobs", &begin, "Content-Type: application/json\r\n");
        assert!(retry_begin.starts_with("HTTP/1.1 200"), "{retry_begin}");
        assert_eq!(retry_begin.split("\r\n\r\n").nth(1), started.split("\r\n\r\n").nth(1));
        let path = format!("/v1/services/ingest/jobs/{id}/chunks");
        let half = &bytes[..10];
        let headers = format!("X-Chunk-Offset: 0\r\nX-Chunk-SHA256: {:x}\r\n", Sha256::digest(half.as_bytes()));
        let first = send("PUT", &path, half, &headers);
        assert!(first.starts_with("HTTP/1.1 200"), "{first}");
        assert!(send("PUT", &path, half, &headers).starts_with("HTTP/1.1 200"));
        let rest = &bytes[10..];
        let headers = format!("X-Chunk-Offset: 10\r\nX-Chunk-SHA256: {:x}\r\n", Sha256::digest(rest.as_bytes()));
        assert!(send("PUT", &path, rest, &headers).starts_with("HTTP/1.1 200"));
        let complete_path = format!("/v1/services/ingest/jobs/{id}/complete");
        let complete = send("POST", &complete_path, "", "");
        assert!(complete.starts_with("HTTP/1.1 200"), "{complete}");
        assert_eq!(send("POST", &complete_path, "", ""), complete);
        let receipt: Value = serde_json::from_str(complete.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(receipt["state"], "completed");
        assert_eq!(receipt["receipt"]["domain"], "materials");
        assert!(send("POST", &format!("/v1/services/ingest/jobs/{id}/cancel"), "", "")
            .contains("OP_ID_REUSED"));
        assert!(send("PUT", &path, half, &headers).contains("OP_ID_REUSED"));
        assert!(send("DELETE", &complete_path, "", "")
            .starts_with("HTTP/1.1 405 Method Not Allowed"));
        assert!(send("GET", &format!("/v1/services/ingest/jobs/{id}"), "", "")
            .starts_with("HTTP/1.1 200"));
        // Recreate the crash window after catalog commit and staging cleanup,
        // but before the service receipt update. Recovery must not duplicate.
        let connection = Connection::open(backend.db_path()).unwrap();
        connection.execute("UPDATE companion_service_upload SET stage='committing',receipt=NULL WHERE job_id=?1", [id]).unwrap();
        let recovered = send("POST", &complete_path, "", "");
        assert!(recovered.starts_with("HTTP/1.1 200"), "{recovered}");
        let recovered_receipt: Value = serde_json::from_str(recovered.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(recovered_receipt["receipt"]["assetId"], receipt["receipt"]["assetId"]);
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM asset WHERE content_hash=?1", [&digest], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        // A recovering commit still owns one of the two upload slots.
        connection.execute("UPDATE companion_service_upload SET stage='committing' WHERE job_id=?1", [id]).unwrap();
        let second = begin.replace("ingest-one", "ingest-two");
        assert!(send("POST", "/v1/services/ingest/jobs", &second, "Content-Type: application/json\r\n")
            .starts_with("HTTP/1.1 201"));
        let third = begin.replace("ingest-one", "ingest-three");
        assert!(send("POST", "/v1/services/ingest/jobs", &third, "Content-Type: application/json\r\n")
            .contains("RATE_LIMITED"));
        gateway.stop().unwrap();
    }

    #[test]
    fn services_knowledge_complete_cannot_write_after_grant_retirement() {
        let gate = TestOneShotGate::new();
        let mut policy = GatewayPolicy::default();
        policy.services_after_auth_gate = Some(Arc::clone(&gate));
        let (root, backend, _store, gateway) = gateway_fixture("services-knowledge-revoke", policy);
        let vault_root = root.path().join("vault");
        std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let registration = crate::knowledge::KnowledgeVaultRegistration {
            id: "fixture-vault".into(), name: "Fixture Vault".into(),
            root_path: vault_root.to_string_lossy().into(), mode: "vault-bound".into(),
            created_at: "2026-09-23T00:00:00Z".into(), last_opened_at: "2026-09-23T00:00:00Z".into(),
            schema_version: 1, link_update_policy: Default::default(),
        };
        std::fs::write(vault_root.join(".luckyray/vault.json"),
            serde_json::to_vec(&registration).unwrap()).unwrap();
        backend.knowledge().register_current_vault(&registration).unwrap();
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret": envelope.secret, "fingerprint": envelope.certificate_fingerprint,
            "deviceLabel": "Knowledge revoke fixture",
        })).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device_id = paired["deviceId"].as_str().unwrap().to_owned();
        let vault_id = content::current_vault_for_service(&gateway).unwrap().0;
        gateway.set_service_grant(&device_id, "ingest.write", "vault", &vault_id, true).unwrap();
        let note = "knowledge-revoke-fixture";
        let body = json!({"opId":"knowledge-retire","kind":"text",
            "target":{"domain":"knowledge","vaultId":vault_id.clone(),"parentRelativePath":""},
            "name":"Retired Note","mimeType":"text/plain","sizeBytes":note.len(),
            "sha256":format!("{:x}", Sha256::digest(note.as_bytes())),"text":note}).to_string();
        let begin = pinned_http_response(&gateway, port, &format!(
            "POST /v1/services/ingest/jobs HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
        assert!(begin.starts_with("HTTP/1.1 201"), "{begin}");
        let job: Value = serde_json::from_str(begin.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let request = format!(
            "POST /v1/services/ingest/jobs/{}/complete HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            job["jobId"].as_str().unwrap());
        gate.armed.store(true, Ordering::SeqCst);
        let worker_gateway = Arc::clone(&gateway);
        let worker = thread::spawn(move ||
            pinned_http_response_allow_close(&worker_gateway, port, &request));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !gate.entered.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(gate.entered.load(Ordering::SeqCst));
        gateway.set_service_grant(&device_id, "ingest.write", "vault", &vault_id, false).unwrap();
        gate.release.store(true, Ordering::SeqCst);
        let _ = worker.join().unwrap();
        assert!(!vault_root.join("Retired Note.md").exists(),
            "retired request wrote a note into the vault");
        gateway.stop().unwrap();
    }

    #[test]
    fn services_knowledge_text_ingest_uses_registered_vault_authority() {
        let (root, backend, _store, gateway) =
            gateway_fixture("services-knowledge-ingest", GatewayPolicy::default());
        let vault_root = root.path().join("vault");
        std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let registration = crate::knowledge::KnowledgeVaultRegistration {
            id: "fixture-vault".into(), name: "Fixture Vault".into(),
            root_path: vault_root.to_string_lossy().into(), mode: "vault-bound".into(),
            created_at: "2026-09-23T00:00:00Z".into(), last_opened_at: "2026-09-23T00:00:00Z".into(),
            schema_version: 1, link_update_policy: Default::default(),
        };
        std::fs::write(vault_root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        backend.knowledge().register_current_vault(&registration).unwrap();
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({"secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "Knowledge ingest fixture"})).unwrap(),
            running_generation(&gateway),
        ).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let vault_id = content::current_vault_for_service(&gateway).unwrap().0;
        gateway.set_service_grant(device_id, "ingest.write", "vault", &vault_id, true).unwrap();
        let send = |method: &str, path: &str, body: &str| pinned_http_response(&gateway, port,
            &format!("{method} {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
        let text = "A remote note from the synthetic test\n![attachment](./image.png)";
        let begin = json!({"opId":"knowledge-one","kind":"text",
            "target":{"domain":"knowledge","vaultId":vault_id.clone(),"parentRelativePath":""},
            "name":"Remote Note","mimeType":"text/plain","sizeBytes":text.len(),
            "sha256":format!("{:x}", Sha256::digest(text.as_bytes())),"text":text}).to_string();
        let started = send("POST", "/v1/services/ingest/jobs", &begin);
        assert!(started.starts_with("HTTP/1.1 201"), "{started}");
        let job: Value = serde_json::from_str(started.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let path = format!("/v1/services/ingest/jobs/{}/complete", job["jobId"].as_str().unwrap());
        let completed = send("POST", &path, "");
        assert!(completed.starts_with("HTTP/1.1 200"), "{completed}");
        let receipt: Value = serde_json::from_str(completed.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(receipt["receipt"]["domain"], "knowledge");
        assert!(receipt["receipt"]["noteId"].as_str().unwrap().starts_with("kn-"));
        assert_eq!(send("POST", &path, ""), completed);

        std::fs::create_dir(vault_root.join("Moved")).unwrap();
        gateway.set_service_grant(device_id, "content.write", "vault", &vault_id, true).unwrap();
        let move_path = format!("/v1/services/knowledge/notes/{}/move",
            receipt["receipt"]["noteId"].as_str().unwrap());
        let move_body = json!({"opId":"move-one","vaultId":vault_id.clone(),
            "expectedRevision":receipt["receipt"]["revision"],
            "parentRelativePath":"Moved"}).to_string();
        let moved = send("PATCH", &move_path, &move_body);
        assert!(moved.starts_with("HTTP/1.1 200"), "{moved}");
        assert_eq!(send("PATCH", &move_path, &move_body), moved);
        let moved_body: Value = serde_json::from_str(moved.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(moved_body["parentRelativePath"], "Moved");
        assert!(std::fs::read_to_string(vault_root.join("Moved/Remote Note.md"))
            .unwrap().contains("../image.png"));
        // Simulate a crash after the physical move but before the service
        // receipt and Content V1 identity remap were made durable.
        let connection = Connection::open(backend.db_path()).unwrap();
        let stable_id = receipt["receipt"]["noteId"].as_str().unwrap();
        let file_revision: String = connection.query_row(
            "SELECT file_revision FROM companion_content_note WHERE vault_key=?1 AND note_id=?2",
            params![vault_id, stable_id], |row| row.get(0),
        ).unwrap();
        connection.execute(
            "UPDATE companion_content_note SET path='Remote Note.md' WHERE vault_key=?1 AND note_id=?2",
            params![vault_id, stable_id],
        ).unwrap();
        connection.execute(
            "UPDATE companion_service_operation SET stage='pending',receipt=?1
             WHERE operation_id='knowledge.move' AND op_id='move-one'",
            [json!({"plannedPath":"Moved/Remote Note.md", "beforePath":"Remote Note.md",
                "beforeFileRevision":format!("{:x}", Sha256::digest(text.as_bytes())),
                "expectedAfterFileRevision":file_revision,"registrationId":registration.id}).to_string()],
        ).unwrap();
        std::fs::copy(vault_root.join("Moved/Remote Note.md"), vault_root.join("Remote Note.md")).unwrap();
        let unsafe_retry = send("PATCH", &move_path, &move_body);
        assert!(unsafe_retry.starts_with("HTTP/1.1 503"), "{unsafe_retry}");
        let pending_stage: String = connection.query_row(
            "SELECT stage FROM companion_service_operation WHERE operation_id='knowledge.move' AND op_id='move-one'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(pending_stage, "pending");
        std::fs::remove_file(vault_root.join("Remote Note.md")).unwrap();
        let reconciled_before_retry = send("GET", &format!("/v1/notes?vault={vault_id}"), "");
        assert!(reconciled_before_retry.starts_with("HTTP/1.1 200"));
        let recovered_move = send("PATCH", &move_path, &move_body);
        assert!(recovered_move.starts_with("HTTP/1.1 200"), "{recovered_move}");
        let recovered_body: Value = serde_json::from_str(recovered_move.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(recovered_body["noteId"], stable_id);

        // The Services note ID is stable `kn-*`, whereas NotesPage navigates
        // by its current path-derived `kdoc-*` ID. The server bridge must
        // supply that UI identity only after the authorized note read.
        gateway.set_service_grant(device_id, "content.read", "vault", &vault_id, true).unwrap();
        gateway.set_service_grant(device_id, "desktop.open", "vault", &vault_id, true).unwrap();
        let offered = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = Arc::clone(&offered);
        let ack_gateway = Arc::clone(&gateway);
        gateway.attach_presentation_sink(Arc::new(move |offer| {
            ack_gateway.claim_presentation(offer["requestId"].as_str().unwrap()).unwrap();
            ack_gateway.acknowledge_presentation(offer["requestId"].as_str().unwrap(), true).unwrap();
            captured.lock().unwrap().push(offer);
            true
        }));
        let open = json!({"opId":"open-moved-note","target":{"domain":"knowledge",
            "vaultId":vault_id.clone(),"noteId":receipt["receipt"]["noteId"]}}).to_string();
        let response = send("POST", "/v1/services/presentation/open", &open);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let navigation_id = offered.lock().unwrap()[0]["navigationId"].as_str().unwrap().to_owned();
        let document_ref = crate::knowledge::KnowledgeService::parse_document_id(&navigation_id).unwrap();
        assert_eq!(document_ref.vault_id, registration.id);
        assert!(document_ref.relative_path.starts_with("Moved/"));

        let binary = "fixture-note-attachment";
        let begin = json!({"opId":"knowledge-binary","kind":"file",
            "target":{"domain":"knowledge","vaultId":vault_id,"parentRelativePath":""},
            "name":"Remote Attachment.bin","mimeType":"application/octet-stream",
            "sizeBytes":binary.len(),"sha256":format!("{:x}", Sha256::digest(binary.as_bytes()))}).to_string();
        let started = send("POST", "/v1/services/ingest/jobs", &begin);
        assert!(started.starts_with("HTTP/1.1 201"), "{started}");
        let job: Value = serde_json::from_str(started.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let id = job["jobId"].as_str().unwrap();
        let chunk = pinned_http_response(&gateway, port, &format!(
            "PUT /v1/services/ingest/jobs/{id}/chunks HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nX-Chunk-Offset: 0\r\nX-Chunk-SHA256: {:x}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{binary}",
            Sha256::digest(binary.as_bytes()), binary.len()));
        assert!(chunk.starts_with("HTTP/1.1 200"), "{chunk}");
        let path = format!("/v1/services/ingest/jobs/{id}/complete");
        let completed = send("POST", &path, "");
        assert!(completed.starts_with("HTTP/1.1 200"), "{completed}");
        let receipt: Value = serde_json::from_str(completed.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(receipt["receipt"]["domain"], "knowledge");
        assert_eq!(send("POST", &path, ""), completed);
        gateway.stop().unwrap();
    }

    #[test]
    fn shared_knowledge_https_discovery_seven_routes_and_current_grants() {
        let (root, backend, _store, gateway) = gateway_fixture("shared-knowledge-seven", GatewayPolicy::default());
        let vault_root = root.path().join("vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        fs::create_dir_all(vault_root.join("Empty")).unwrap();
        let registration = crate::knowledge::KnowledgeVaultRegistration {
            id: "shared-vault".into(), name: "Synthetic shared Vault".into(),
            root_path: vault_root.to_string_lossy().into(), mode: "vault-bound".into(),
            created_at: "2026-09-30T00:00:00Z".into(), last_opened_at: "2026-09-30T00:00:00Z".into(),
            schema_version: 1, link_update_policy: Default::default(),
        };
        fs::write(vault_root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        backend.knowledge().register_current_vault(&registration).unwrap();
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port, status => panic!("{status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret":envelope.secret,"fingerprint":envelope.certificate_fingerprint,"deviceLabel":"Shared synthetic fixture"
        })).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device = paired["deviceId"].as_str().unwrap();
        let vault = content::current_vault_for_service(&gateway).unwrap().0;
        let send = |method: &str, path: &str, body: &str| {
            let response = pinned_http_response(&gateway, port, &format!(
                "{method} {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
            let status = response.lines().next().unwrap().split_whitespace().nth(1).unwrap().parse::<u16>().unwrap();
            let payload: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
            (status, payload)
        };
        let discovered = send("GET", "/v1/services", "");
        assert_eq!(discovered.0, 200);
        assert_eq!(discovered.1["bundleRevision"], "2026-10-23.scopes-1");
        assert_eq!(discovered.1["operations"]["knowledge.editingOpen"]["state"], "notGranted");
        for grant in ["content.read", "content.write"] {
            gateway.set_service_grant(device, grant, "vault", &vault, true).unwrap();
        }
        let discovered = send("GET", "/v1/services", "").1;
        for id in ["createUnique", "editing", "editingOpen", "editingSet", "directories", "relations"] {
            assert_eq!(discovered["operations"][format!("knowledge.{id}")]["state"], "implemented", "{id}");
        }
        assert_eq!(discovered["operations"]["knowledge.materialReferences"]["state"], "notGranted");
        let reverse = format!("/v1/services/knowledge/materials/nonexistent-asset/references?vault={vault}");
        assert_eq!(send("GET", &reverse, "").0, 403, "Vault read alone cannot expose Catalog bindings");
        gateway.set_service_grant(device, "content.read", "catalog", "", true).unwrap();
        assert_eq!(send("GET", "/v1/services", "").1["operations"]["knowledge.materialReferences"]["state"], "implemented");
        assert_eq!(send("GET", &reverse, "").0, 404, "Authorized unknown asset is not fabricated success");

        let payload = json!({"opId":"shared-unique","noteId":"kn-shared-target","vaultId":vault,
            "kind":"create","title":"Shared target","content":"target body","expectedRevision":""});
        let created = send("POST", "/v1/services/knowledge/notes", &payload.to_string());
        assert_eq!(created.0, 200, "{created:?}");
        assert_eq!(created.1["document"]["relativePath"], "Shared target.md");
        assert_eq!(send("POST", "/v1/services/knowledge/notes", &payload.to_string()), created);
        let mut changed = payload.clone(); changed["expectedRevision"] = Value::Null;
        assert_eq!(send("POST", "/v1/services/knowledge/notes", &changed.to_string()).0, 409);
        let second = json!({"opId":"shared-second","noteId":"kn-shared-source","vaultId":vault,
            "kind":"create","title":"Shared target","content":"[[Shared target]]\n","expectedRevision":""});
        let collision = send("POST", "/v1/services/knowledge/notes", &second.to_string());
        assert_eq!(collision.0, 200);
        assert_eq!(collision.1["document"]["relativePath"], "Shared target（副本）.md");
        let path = "/v1/services/knowledge/notes/kn-shared-target/editing";
        let opened = send("POST", path, &json!({"vaultId":vault}).to_string());
        assert_eq!(opened.0, 200);
        assert_eq!(opened.1["generation"], 0); assert_eq!(opened.1["editing"], false);
        let lease = json!({"vaultId":vault,"sessionId":opened.1["sessionId"],"generation":1,"editing":true});
        assert_eq!(send("PUT", path, &lease.to_string()).0, 200);
        let editing = send("GET", &format!("{path}?vault={vault}"), "");
        assert_eq!(editing.0, 200); assert_eq!(editing.1["mobileEditing"], false);
        let mut release = lease.clone(); release["generation"] = json!(2); release["editing"] = json!(false);
        assert_eq!(send("PUT", path, &release.to_string()).0, 200);
        release["generation"] = json!(3); release["editing"] = json!(true);
        assert_eq!(send("PUT", path, &release.to_string()), (410, json!({"code":"CURSOR_TOO_OLD"})));
        let directories = format!("/v1/services/knowledge/vaults/{vault}/directories?limit=1");
        assert_eq!(send("GET", &directories, "").1["items"][0]["parentRelativePath"], "");
        assert_eq!(send("POST", &directories, "{}").0, 405);
        let relations = send("GET", &format!("/v1/services/knowledge/notes/kn-shared-source/relations?vault={vault}"), "");
        assert_eq!(relations.0, 200);
        assert!(relations.1["items"].as_array().unwrap().iter().any(|item| item["kind"] == "wikiLink" && item["status"] == "resolved"));
        assert_eq!(send("GET", &format!("/v1/notes/kn-shared-target?vault={vault}"), "").0, 200, "Content route remains compatible");
        gateway.set_service_grant(device, "content.write", "vault", &vault, false).unwrap();
        assert_eq!(send("POST", "/v1/services/knowledge/notes", &payload.to_string()).0, 403);
        gateway.set_service_grant(device, "content.write", "vault", &vault, true).unwrap();
        assert_eq!(send("POST", "/v1/services/knowledge/notes", &payload.to_string()), created, "Regrant replays original receipt without creating again");
        gateway.stop().unwrap();
    }

    #[test]
    fn services_event_hints_are_typed_and_revocation_closes_scope() {
        let (_root, backend, _store, gateway) =
            gateway_fixture("services-events", GatewayPolicy::default());
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port,
            status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(
            &serde_json::to_vec(&json!({"secret": envelope.secret,
                "fingerprint": envelope.certificate_fingerprint,
                "deviceLabel": "Events fixture"})).unwrap(),
            running_generation(&gateway),
        ).unwrap();
        let credential = paired["credential"].as_str().unwrap();
        let device_id = paired["deviceId"].as_str().unwrap();
        let request = format!("GET /v1/services/events/stream HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {credential}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
        assert!(pinned_http_response(&gateway, port, &request).starts_with("HTTP/1.1 403"));
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        // Import through the real catalog so the scoped history owns this hint.
        backend.material_catalog().import_bytes(vec![crate::materials::MaterialBytesInput {
            name: "event-fixture.txt".into(), original_path: "https://example.test/event".into(),
            mime_type: "text/plain".into(), bytes: b"synthetic event".to_vec(), description: None,
        }], &crate::materials::MaterialImportOptions::default()).unwrap();
        let mut tls = pinned_client(&gateway, port);
        tls.write_all(request.as_bytes()).unwrap();
        tls.flush().unwrap();
        let mut response = Vec::new();
        let mut one = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            tls.read_exact(&mut one).unwrap();
            response.push(one[0]);
        }
        assert!(String::from_utf8(response).unwrap().starts_with("HTTP/1.1 101"));
        let read_frame = |tls: &mut StreamOwned<ClientConnection, TcpStream>| -> (u8, Value) {
            loop {
                let mut header = [0u8; 2];
                tls.read_exact(&mut header).unwrap();
                let length = if header[1] == 126 {
                    let mut extended = [0u8; 2]; tls.read_exact(&mut extended).unwrap();
                    u16::from_be_bytes(extended) as usize
                } else { header[1] as usize };
                let mut body = vec![0u8; length]; tls.read_exact(&mut body).unwrap();
                if header[0] & 0xf == 1 {
                    return (1, serde_json::from_slice(&body).unwrap());
                }
                assert_eq!(header[0] & 0xf, 9, "unexpected event frame");
            }
        };
        let (_, material) = read_frame(&mut tls);
        assert_eq!(material["kind"], "materialChanged");
        assert!(material["cursor"].as_str().unwrap().starts_with("m:"));
        gateway.set_service_grant(device_id, "content.read", "catalog", "", false).unwrap();
        let (_, changed) = read_frame(&mut tls);
        assert_eq!(changed["kind"], "servicesChanged");
        gateway.stop().unwrap();
    }
}
