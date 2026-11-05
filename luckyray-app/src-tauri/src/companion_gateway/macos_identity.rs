//! macOS Companion identity storage in the user's selected login Keychain.
//!
//! A Keychain entry is created once and never overwritten or deleted by this
//! store. If a database install is interrupted or its metadata does not match,
//! retain the existing item and require recovery instead of rotating the TLS
//! identity or invalidating paired devices.
use super::{GatewayError, ProtectedIdentityStore};
use crate::macos_fs::Directory;
use core_foundation::array::CFArray;
use core_foundation::base::{CFTypeRef, TCFType, ToVoid};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef, CFMutableDictionary};
use core_foundation::string::{CFString, CFStringRef};
use security_framework::item::{ItemAddOptions, ItemAddValue, ItemClass, Location};
use security_framework::os::macos::keychain::SecKeychain;
use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::Arc;
use zeroize::Zeroizing;

#[path = "macos_keychain_policy.rs"]
mod query_policy;

#[cfg(test)]
#[path = "macos_identity_record_tests.rs"]
mod record_tests;

// Public Security.framework query constants. CSSM layouts stay in the small
// public-SDK C bridge, rather than duplicating their ABI in Rust.
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecClass: CFStringRef;
    static kSecClassGenericPassword: CFStringRef;
    static kSecAttrService: CFStringRef;
    static kSecAttrAccount: CFStringRef;
    static kSecMatchSearchList: CFStringRef;
    static kSecMatchLimit: CFStringRef;
    static kSecMatchLimitAll: CFStringRef;
    static kSecReturnRef: CFStringRef;
    static kSecReturnAttributes: CFStringRef;
    static kSecReturnData: CFStringRef;
}
unsafe extern "C" {
    fn lr_macos_keychain_select(keychain: CFTypeRef, query: CFDictionaryRef, guard: *mut *mut c_void) -> i32;
    fn lr_macos_keychain_read(guard: *mut c_void, data: *mut *mut u8, length: *mut u32) -> i32;
    fn lr_macos_keychain_release(guard: *mut c_void);
    fn lr_macos_keychain_free_data(data: *mut u8, length: u32);
}

const SERVICE: &str = "com.luckyray.companion.identity.v1";
const MAX_IDENTITY: usize = 128 * 1024;
// errSecItemNotFound: Security.framework's distinct, non-secret status.
const ITEM_NOT_FOUND: i32 = -25300;
const DUPLICATE_ITEM: i32 = -25299;
const INVALID_ITEM: i32 = -25304;

fn unavailable() -> GatewayError {
    GatewayError::new("companion-secret-unavailable", "The macOS Keychain identity is unavailable")
}
fn recovery() -> GatewayError {
    GatewayError::new("companion-secret-recovery-required", "Companion identity requires recovery; existing identity and pairing data were retained")
}
fn invalid_profile() -> GatewayError {
    GatewayError::new("companion-secret-path-invalid", "The Companion application data directory is unavailable or unsafe")
}

// Fixed vocabulary only: no error messages, paths, references or secret data.
// Production builds do not print these diagnostics.
#[cfg(test)]
fn diagnostic(marker: &'static str) { eprintln!("{marker}"); }
#[cfg(not(test))]
fn diagnostic(_: &'static str) {}

fn status_diagnostic(phase: &'static str, status: i32) {
    diagnostic(phase);
    diagnostic(match status {
        -50 => "macos-keychain-status-param",
        -25291 => "macos-keychain-status-unavailable",
        -25292 => "macos-keychain-status-read-only",
        -25293 => "macos-keychain-status-auth-failed",
        -25294 => "macos-keychain-status-no-keychain",
        -25295 => "macos-keychain-status-invalid-keychain",
        -25299 => "macos-keychain-status-duplicate",
        -25300 => "macos-keychain-status-not-found",
        -25307 => "macos-keychain-status-no-default",
        -25308 => "macos-keychain-status-interaction-not-allowed",
        -25315 => "macos-keychain-status-interaction-required",
        -34018 => "macos-keychain-status-missing-entitlement",
        _ => "macos-keychain-status-other",
    });
}

/// Hash the validated application-data path so profiles do not share identities,
/// while avoiding a private user path in the visible Keychain account name.
fn account_for(app_data: &Path) -> Result<String, GatewayError> {
    let directory = Directory::open_owned(app_data, false).map_err(|_| { diagnostic("macos-keychain-profile-open-failed"); invalid_profile() })?;
    directory.current().map_err(|_| { diagnostic("macos-keychain-profile-current-failed"); invalid_profile() })?;
    let mut digest = Sha256::new();
    digest.update(b"luckyray-companion-keychain-account-v1\0");
    digest.update(app_data.as_os_str().as_bytes());
    Ok(format!("profile-{:x}", digest.finalize()))
}

// A non-secret, create-only profile marker survives loss of both the SQLite
// identity row and the Keychain item. It never contains identity or pairing
// material, and is never removed by startup or an unlock retry.
const IDENTITY_HISTORY_FILE: &str = "companion-gateway-identity-v1.initialized";
const IDENTITY_HISTORY_CONTENT: &[u8] = b"luckyray-companion-identity-v1\n";

pub(super) struct IdentityHistory(Directory);
impl IdentityHistory {
    pub(super) fn open(db_path: &Path) -> Result<Self, GatewayError> {
        let parent = db_path.parent().ok_or_else(invalid_profile)?;
        let directory = Directory::open_owned(parent, false).map_err(|_| invalid_profile())?;
        directory.current().map_err(|_| invalid_profile())?;
        Ok(Self(directory))
    }

    pub(super) fn exists(&self) -> Result<bool, GatewayError> {
        match self.0.read_owned(std::ffi::OsStr::new(IDENTITY_HISTORY_FILE)).map_err(|_| recovery())? {
            None => Ok(false),
            Some((bytes, _)) if bytes == IDENTITY_HISTORY_CONTENT => Ok(true),
            Some(_) => Err(recovery()),
        }
    }

    pub(super) fn remember_existing(&self) -> Result<(), GatewayError> {
        if self.exists()? { return Ok(()); }
        match self.0.create(std::ffi::OsStr::new(IDENTITY_HISTORY_FILE), IDENTITY_HISTORY_CONTENT) {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Another loader may have recorded the same history. A corrupt
                // or substituted marker remains a recovery error.
                if self.exists()? { Ok(()) } else { Err(recovery()) }
            }
            Err(_) => Err(recovery()),
        }
    }
}

struct SecretBuffer(Zeroizing<Vec<u8>>);
impl AsRef<[u8]> for SecretBuffer {
    fn as_ref(&self) -> &[u8] { self.0.as_slice() }
}

fn apply_return_options(query: &mut CFMutableDictionary, kind: query_policy::QueryKind) {
    unsafe {
        if kind.limit_all() { query.add(&kSecMatchLimit.to_void(), &kSecMatchLimitAll.to_void()); }
        if kind.returns_item_reference() {
            query.add(&kSecReturnRef.to_void(), &CFBoolean::true_value().to_void());
            query.add(&kSecReturnAttributes.to_void(), &CFBoolean::true_value().to_void());
        }
        if kind.returns_data() { query.add(&kSecReturnData.to_void(), &CFBoolean::true_value().to_void()); }
    }
}

fn references_query(account: &str, keychain: &SecKeychain) -> CFDictionary {
    let mut query = CFMutableDictionary::from_CFType_pairs(&[]);
    unsafe {
        query.add(&kSecClass.to_void(), &kSecClassGenericPassword.to_void());
        query.add(&kSecAttrService.to_void(), &CFString::new(SERVICE).to_void());
        query.add(&kSecAttrAccount.to_void(), &CFString::new(account).to_void());
        let search_list = CFArray::from_CFTypes(std::slice::from_ref(keychain));
        query.add(&kSecMatchSearchList.to_void(), &search_list.as_CFType().to_void());
    }
    apply_return_options(&mut query, query_policy::QueryKind::References);
    query.to_immutable()
}

struct RecordGuard(NonNull<c_void>);
impl Drop for RecordGuard {
    fn drop(&mut self) { unsafe { lr_macos_keychain_release(self.0.as_ptr()) }; }
}
impl RecordGuard {
    fn select(account: &str, keychain: &SecKeychain) -> Result<Option<Self>, GatewayError> {
        let query = references_query(account, keychain);
        let mut raw = std::ptr::null_mut();
        let status = unsafe { lr_macos_keychain_select(keychain.as_CFTypeRef(), query.as_concrete_TypeRef(), &mut raw) };
        let guard = NonNull::new(raw).map(Self);
        if status == ITEM_NOT_FOUND { return Ok(None); }
        if status != 0 {
            status_diagnostic("macos-keychain-record-select-failed", status);
            if status == DUPLICATE_ITEM { diagnostic("macos-keychain-ambiguous-result"); }
            return Err(if matches!(status, DUPLICATE_ITEM | INVALID_ITEM) { recovery() } else { unavailable() });
        }
        guard.map(Some).ok_or_else(|| { diagnostic("macos-keychain-record-invalid"); recovery() })
    }
}
struct ProtectedData { data: *mut u8, length: u32 }
impl Drop for ProtectedData {
    fn drop(&mut self) { unsafe { lr_macos_keychain_free_data(self.data, self.length) }; }
}

struct SystemQuery<'a> { account: &'a str, keychain: &'a SecKeychain }
impl query_policy::QueryBackend for SystemQuery<'_> {
    type Reference = RecordGuard;
    type Secret = Zeroizing<Vec<u8>>;
    type Error = GatewayError;

    fn references(&self) -> Result<Option<Vec<RecordGuard>>, GatewayError> {
        // One metadata query binds the returned item and its borrowed UID. The
        // bridge retains that item for the complete protected read window.
        RecordGuard::select(self.account, self.keychain).map(|guard| guard.map(|guard| vec![guard]))
    }

    fn secret(&self, reference: &RecordGuard) -> Result<Zeroizing<Vec<u8>>, GatewayError> {
        #[cfg(test)]
        AFTER_KEYCHAIN_SELECTION.with(|slot| { if let Some(hook) = slot.borrow_mut().take() { hook(); } });
        let mut content = ProtectedData { data: std::ptr::null_mut(), length: 0 };
        let status = unsafe { lr_macos_keychain_read(reference.0.as_ptr(), &mut content.data, &mut content.length) };
        if status != 0 {
            status_diagnostic("macos-keychain-record-read-failed", status);
            return Err(if matches!(status, ITEM_NOT_FOUND | INVALID_ITEM) { recovery() } else { unavailable() });
        }
        if content.data.is_null() || content.length == 0 || content.length as usize > MAX_IDENTITY {
            diagnostic("macos-keychain-record-invalid"); return Err(recovery());
        }
        // The bridge only hands out data after its original UID and database
        // handle checks complete; its allocation is wiped when this scope ends.
        let bytes = unsafe { std::slice::from_raw_parts(content.data, content.length as usize) };
        Ok(Zeroizing::new(bytes.to_vec()))
    }
}

#[cfg(test)]
std::thread_local! {
    static AFTER_KEYCHAIN_SELECTION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}

pub(super) struct MacIdentityStore {
    account: Result<String, GatewayError>,
    keychain: Result<SecKeychain, GatewayError>,
}
impl MacIdentityStore {
    pub(super) fn new(app_data: &Path) -> Self {
        Self {
            account: account_for(app_data),
            keychain: SecKeychain::default().map_err(|error| { status_diagnostic("macos-keychain-default-failed", error.code()); unavailable() }),
        }
    }
    fn destination(&self) -> Result<(&str, &SecKeychain), GatewayError> {
        Ok((self.account.as_ref().map_err(Clone::clone)?.as_str(), self.keychain.as_ref().map_err(Clone::clone)?))
    }
    #[cfg(test)]
    fn for_test(app_data: &Path, keychain: SecKeychain) -> Self {
        Self { account: account_for(app_data), keychain: Ok(keychain) }
    }
}
impl ProtectedIdentityStore for MacIdentityStore {
    fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, GatewayError> {
        let (account, keychain) = self.destination()?;
        match query_policy::read(&SystemQuery { account, keychain }) {
            Ok(value) => Ok(value),
            Err(query_policy::ReadError::Ambiguous) => { diagnostic("macos-keychain-ambiguous-result"); Err(recovery()) },
            Err(query_policy::ReadError::Backend(error)) => Err(error),
        }
    }

    fn store(&self, plaintext: &[u8]) -> Result<(), GatewayError> {
        if plaintext.is_empty() || plaintext.len() > MAX_IDENTITY { return Err(recovery()); }
        let (account, keychain) = self.destination()?;
        // from_arc keeps our copy in a zeroizing allocation; Keychain's own
        // internal buffers and OS storage are managed by macOS.
        let data = CFData::from_arc(Arc::new(SecretBuffer(Zeroizing::new(plaintext.to_vec()))));
        let mut add = ItemAddOptions::new(ItemAddValue::Data { class: ItemClass::generic_password(), data });
        add.set_service(SERVICE).set_account_name(account).set_location(Location::FileKeychain(keychain.clone()));
        // SecItemAdd is create-only. In particular, never use the framework's
        // set_generic_password helper, which updates an existing entry.
        add.add().map_err(|error| {
            if error.code() == DUPLICATE_ITEM { recovery() } else {
                status_diagnostic("macos-keychain-add-failed", error.code());
                unavailable()
            }
        })
    }

    fn remove(&self) -> Result<(), GatewayError> {
        // A query by account cannot prove the item has not been replaced since
        // store(). On a half-installed database leave it intact for recovery.
        Err(recovery())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_gateway::{self, CompanionGateway, GatewayPolicy, HttpRequest};
    use security_framework::os::macos::keychain::CreateOptions;
    use std::collections::HashMap;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    pub(super) fn isolated_keychain() -> (tempfile::TempDir, PathBuf, SecKeychain) {
        let temp = tempfile::tempdir().unwrap_or_else(|_| panic!("macos-keychain-fixture-unavailable"));
        let root = temp.path().canonicalize().unwrap_or_else(|_| panic!("macos-keychain-fixture-unavailable"));
        let app = root.join("app");
        fs::create_dir(&app).unwrap_or_else(|_| panic!("macos-keychain-fixture-unavailable"));
        let mut options = CreateOptions::new();
        options.password("synthetic-test-only").prompt_user(false);
        let mut keychain = options.create(root.join("fixture.keychain"))
            .unwrap_or_else(|_| panic!("macos-keychain-fixture-unavailable"));
        keychain.unlock(Some("synthetic-test-only")).unwrap_or_else(|_| panic!("macos-keychain-fixture-unavailable"));
        (temp, app, keychain)
    }
    fn database(path: &Path) {
        let db = rusqlite::Connection::open(path).unwrap();
        db.execute_batch("CREATE TABLE companion_identity(singleton INTEGER PRIMARY KEY,desktop_instance_id TEXT NOT NULL,certificate_der BLOB NOT NULL,certificate_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL)").unwrap();
    }

    fn report_identity_error(error: &GatewayError) {
        diagnostic(match error.code {
            "companion-secret-unavailable" => "macos-keychain-identity-unavailable",
            "companion-secret-path-invalid" => "macos-keychain-identity-path-invalid",
            "companion-secret-recovery-required" => "macos-keychain-identity-recovery",
            "companion-database-unavailable" => "macos-keychain-identity-database",
            "companion-certificate-generation-failed" => "macos-keychain-identity-certificate",
            "companion-secret-serialization-failed" => "macos-keychain-identity-serialization",
            _ => "macos-keychain-identity-other",
        });
    }
    fn expect_identity<T>(result: Result<T, GatewayError>) -> T {
        match result {
            Ok(value) => value,
            Err(error) => { report_identity_error(&error); panic!("macos-keychain-identity-failed") },
        }
    }
    fn expect_recovery<T>(result: Result<T, GatewayError>) {
        match result {
            Err(error) if error.code == "companion-secret-recovery-required" => (),
            Err(error) => { report_identity_error(&error); panic!("macos-keychain-identity-failed") },
            Ok(_) => panic!("macos-keychain-identity-unexpected-success"),
        }
    }

    #[test]
    fn macos_keychain_identity_restart_and_pairing_with_real_store() {
        let (_temp, app, keychain) = isolated_keychain();
        let backend = Arc::new(crate::backend::BackendServices::initialize(&app).unwrap());
        let store = MacIdentityStore::for_test(&app, keychain.clone());
        let gateway = CompanionGateway::initialize_with_store(backend.clone(), Arc::new(store), GatewayPolicy::default());
        let first = expect_identity(gateway.identity()).instance_id.clone();
        gateway.start("127.0.0.1", Some(0)).unwrap();
        let generation = gateway.lifecycle.lock().unwrap().running.as_ref().unwrap().generation;
        let envelope = gateway.issue_pairing().unwrap();
        let body = serde_json::to_vec(&serde_json::json!({"secret":envelope.secret,
            "fingerprint":envelope.certificate_fingerprint,"deviceLabel":"Synthetic Keychain test"})).unwrap();
        let paired = gateway.exchange_pairing(&body, generation).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let expected_device = paired["deviceId"].as_str().unwrap().to_owned();
        gateway.stop().unwrap();
        drop(gateway);
        let resumed = CompanionGateway::initialize_with_store(backend, Arc::new(MacIdentityStore::for_test(&app, keychain)), GatewayPolicy::default());
        assert_eq!(expect_identity(resumed.identity()).instance_id, first);
        let request = HttpRequest { method: "GET".into(), path: "/v1/capabilities".into(),
            headers: HashMap::from([("authorization".into(), format!("Bearer {credential}"))]), body: Vec::new() };
        assert_eq!(resumed.authenticate_request(&request).unwrap().device_id, expected_device);
    }

    #[test]
    fn macos_keychain_gateway_private_lan_tls_roundtrip() {
        use std::io::{Read, Write};
        use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
        use std::time::Duration;
        use rustls::pki_types::{CertificateDer, ServerName};
        use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};

        // This is a real system interface; a runner without one must report
        // an unverified LAN test, not substitute loopback or claim success.
        let interfaces = companion_gateway::macos_lan::enumerate().unwrap();
        let interface = interfaces.first().unwrap_or_else(|| panic!("macos-lan-fixture-no-private-interface"));
        let address = companion_gateway::macos_lan::management_address(&interface.address)
            .unwrap_or_else(|_| panic!("macos-lan-interface-changed"));
        let ip: Ipv4Addr = address.parse().unwrap();
        let (_temp, app, keychain) = isolated_keychain();
        let backend = Arc::new(crate::backend::BackendServices::initialize(&app).unwrap());
        let store = MacIdentityStore::for_test(&app, keychain);
        let gateway = CompanionGateway::initialize_with_store(backend, Arc::new(store), GatewayPolicy::default());
        struct ShutdownOnDrop(Arc<CompanionGateway>);
        impl Drop for ShutdownOnDrop {
            fn drop(&mut self) { let _ = self.0.shutdown(); }
        }
        let _cleanup = ShutdownOnDrop(Arc::clone(&gateway));
        let status = gateway.start(&address, None).unwrap_or_else(|_| panic!("macos-lan-gateway-start-failed"));
        let (bound, port) = match status {
            companion_gateway::GatewayStatus::Running { bind_address, port, .. } => (bind_address, port),
            _ => panic!("macos-lan-gateway-start-failed"),
        };
        assert_eq!(bound, address);
        assert_ne!(port, 0);

        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from(gateway.identity().unwrap().certificate_der.clone())).unwrap();
        let config = Arc::new(ClientConfig::builder().with_root_certificates(roots).with_no_client_auth());
        let client = ClientConnection::new(config, ServerName::try_from("luckyray-companion.local").unwrap()).unwrap();
        let timeout = Duration::from_secs(3);
        let socket = TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V4(ip), port), timeout)
            .unwrap_or_else(|_| panic!("macos-lan-tls-connect-failed"));
        socket.set_read_timeout(Some(timeout)).unwrap();
        socket.set_write_timeout(Some(timeout)).unwrap();
        let mut tls = StreamOwned::new(client, socket);
        tls.write_all(b"GET /v1/hello HTTP/1.1\r\nHost: luckyray-companion.local\r\n\r\n")
            .and_then(|_| tls.flush()).unwrap_or_else(|_| panic!("macos-lan-tls-connect-failed"));
        let mut headers = Vec::new();
        let mut byte = [0u8; 1];
        while !headers.ends_with(b"\r\n\r\n") && headers.len() < 4096 {
            tls.read_exact(&mut byte).unwrap_or_else(|_| panic!("macos-lan-tls-connect-failed"));
            headers.push(byte[0]);
        }
        assert!(headers.starts_with(b"HTTP/1.1 200"));
        assert!(headers.ends_with(b"\r\n\r\n"));
        drop(tls);
        gateway.stop().unwrap();
    }

    #[test]
    fn macos_keychain_identity_never_overwrites_or_removes_on_failure() {
        let (_temp, app, keychain) = isolated_keychain();
        let path = app.join("identity.sqlite"); database(&path);
        let store = MacIdentityStore::for_test(&app, keychain);
        let first = expect_identity(companion_gateway::load_or_create_identity(&path, &store));
        let before = store.load().unwrap().unwrap();
        assert_eq!(store.store(b"unrelated replacement").unwrap_err().code, "companion-secret-recovery-required");
        assert!(store.remove().is_err());
        assert_eq!(store.load().unwrap().unwrap().as_slice(), before.as_slice());
        // A mismatched database must never rotate or replace the Keychain item.
        rusqlite::Connection::open(&path).unwrap().execute("UPDATE companion_identity SET desktop_instance_id='desktop-incorrect'", []).unwrap();
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        assert_eq!(store.load().unwrap().unwrap().as_slice(), before.as_slice());
        assert_ne!(first.instance_id, "desktop-incorrect");
    }

    #[test]
    fn macos_keychain_identity_rejects_missing_corrupt_and_linked_scope() {
        let (_temp, app, keychain) = isolated_keychain();
        let path = app.join("identity.sqlite"); database(&path);
        let store = MacIdentityStore::for_test(&app, keychain.clone());
        // Existing metadata and a missing secret is an error, never regeneration.
        rusqlite::Connection::open(&path).unwrap().execute("INSERT INTO companion_identity VALUES(1,'desktop-missing',X'01','fingerprint','now')", []).unwrap();
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        assert!(store.load().unwrap().is_none());
        // A corrupt Keychain entry is preserved and cannot be replaced by retry.
        store.store(b"not valid identity json").unwrap();
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        assert_eq!(store.load().unwrap().unwrap().as_slice(), b"not valid identity json");
        let alias = app.with_file_name("app-alias"); symlink(&app, &alias).unwrap();
        let linked = MacIdentityStore::for_test(&alias, keychain);
        assert!(linked.load().is_err());
    }

    #[test]
    fn macos_keychain_identity_database_install_failure_preserves_item() {
        let (_temp, app, keychain) = isolated_keychain();
        let path = app.join("identity.sqlite"); database(&path);
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TRIGGER fail_identity_insert BEFORE INSERT ON companion_identity BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
        let store = MacIdentityStore::for_test(&app, keychain);
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        let retained = store.load().unwrap().unwrap();
        db.execute_batch("DROP TRIGGER fail_identity_insert").unwrap();
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        assert_eq!(store.load().unwrap().unwrap().as_slice(), retained.as_slice());
    }

    #[test]
    fn macos_keychain_concurrent_first_install_retains_one_identity() {
        let (_temp, app, keychain) = isolated_keychain();
        let path = app.join("identity.sqlite"); database(&path);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let store = MacIdentityStore::for_test(&app, keychain.clone());
            let db = path.clone(); let ready = barrier.clone();
            workers.push(std::thread::spawn(move || {
                ready.wait();
                companion_gateway::load_or_create_identity(&db, &store).map(|identity| identity.instance_id)
            }));
        }
        let outcomes: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
        for error in outcomes.iter().filter_map(|result| result.as_ref().err()) { report_identity_error(error); }
        assert!(outcomes.iter().any(Result::is_ok));
        let store = MacIdentityStore::for_test(&app, keychain);
        let recovered = expect_identity(companion_gateway::load_or_create_identity(&path, &store));
        assert!(outcomes.iter().filter_map(|outcome| outcome.as_ref().ok()).all(|id| id == &recovered.instance_id));
    }


    struct EmptyIdentityStore(std::sync::atomic::AtomicUsize);
    impl EmptyIdentityStore {
        fn new() -> Self { Self(std::sync::atomic::AtomicUsize::new(0)) }
        fn writes(&self) -> usize { self.0.load(std::sync::atomic::Ordering::SeqCst) }
    }
    impl ProtectedIdentityStore for EmptyIdentityStore {
        fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, GatewayError> { Ok(None) }
        fn store(&self, _: &[u8]) -> Result<(), GatewayError> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(unavailable())
        }
        fn remove(&self) -> Result<(), GatewayError> { panic!("identity recovery must not delete a secret") }
    }
    fn empty_profile() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().canonicalize().unwrap().join("app");
        fs::create_dir(&app).unwrap();
        let path = app.join("identity.sqlite"); database(&path);
        (temp, app, path)
    }

    #[test]
    fn macos_identity_history_blocks_double_loss_and_database_replacement() {
        let (_temp, app, keychain) = isolated_keychain();
        let path = app.join("identity.sqlite"); database(&path);
        let store = MacIdentityStore::for_test(&app, keychain.clone());
        expect_identity(companion_gateway::load_or_create_identity(&path, &store));
        let account = account_for(&app).unwrap();
        let (_password, item) = keychain.find_generic_password(SERVICE, &account).unwrap();
        item.delete(); // Simulate loss only inside the isolated synthetic Keychain.
        assert!(store.load().unwrap().is_none());
        // A fresh SQLite file at the same profile path must not appear to be a
        // new installation after its previous identity has disappeared.
        fs::remove_file(&path).unwrap(); database(&path);
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        assert!(store.load().unwrap().is_none());
        assert!(companion_gateway::read_identity_metadata(&path).unwrap().is_none());
        assert_eq!(fs::read(app.join(IDENTITY_HISTORY_FILE)).unwrap(), IDENTITY_HISTORY_CONTENT);
    }

    #[test]
    fn macos_identity_history_blocks_legacy_pairing_audit_and_listener_evidence() {
        for evidence in [
            "CREATE TABLE companion_device(id TEXT); INSERT INTO companion_device VALUES('revoked-synthetic-device')",
            "CREATE TABLE companion_security_audit(id INTEGER); INSERT INTO companion_security_audit VALUES(1)",
            "CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES('companion.gateway.listener.v1','synthetic')",
        ] {
            let (_temp, app, path) = empty_profile();
            rusqlite::Connection::open(&path).unwrap().execute_batch(evidence).unwrap();
            let store = EmptyIdentityStore::new();
            expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
            assert_eq!(store.writes(), 0);
            assert!(companion_gateway::read_identity_metadata(&path).unwrap().is_none());
            // Preserve evidence independently before a subsequent DB loss.
            assert_eq!(fs::read(app.join(IDENTITY_HISTORY_FILE)).unwrap(), IDENTITY_HISTORY_CONTENT);
            fs::remove_file(&path).unwrap(); database(&path);
            expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
            assert_eq!(store.writes(), 0);
        }
    }

    #[test]
    fn macos_identity_history_rejects_corrupt_or_linked_marker() {
        let (_temp, app, path) = empty_profile();
        let store = EmptyIdentityStore::new();
        let marker = app.join(IDENTITY_HISTORY_FILE);
        fs::write(&marker, b"invalid-marker").unwrap();
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        assert_eq!(fs::read(&marker).unwrap(), b"invalid-marker");
        fs::remove_file(&marker).unwrap();
        let target = app.with_file_name("outside-marker");
        fs::write(&target, IDENTITY_HISTORY_CONTENT).unwrap();
        symlink(&target, &marker).unwrap();
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        assert_eq!(fs::read_link(&marker).unwrap(), target);
        assert_eq!(fs::read(&target).unwrap(), IDENTITY_HISTORY_CONTENT);
        assert_eq!(store.writes(), 0);
    }

    #[test]
    fn macos_identity_history_does_not_mark_a_rejected_first_write() {
        let (_temp, app, keychain) = isolated_keychain();
        let path = app.join("identity.sqlite"); database(&path);
        let rejected = EmptyIdentityStore::new();
        let error = companion_gateway::load_or_create_identity(&path, &rejected).err().unwrap();
        assert_eq!(error.code, "companion-secret-unavailable");
        assert_eq!(rejected.writes(), 1);
        assert!(companion_gateway::read_identity_metadata(&path).unwrap().is_none());
        assert!(!app.join(IDENTITY_HISTORY_FILE).exists());
        // A subsequent startup with access restored remains a genuine first
        // install; it records history only after the real Keychain add works.
        let restored = MacIdentityStore::for_test(&app, keychain);
        let first = expect_identity(companion_gateway::load_or_create_identity(&path, &restored));
        let restarted = expect_identity(companion_gateway::load_or_create_identity(&path, &restored));
        assert_eq!(first.instance_id, restarted.instance_id);
        assert_eq!(first.fingerprint, restarted.fingerprint);
        assert_eq!(fs::read(app.join(IDENTITY_HISTORY_FILE)).unwrap(), IDENTITY_HISTORY_CONTENT);
    }

    #[test]
    fn macos_identity_history_write_failure_preserves_complete_identity() {
        let (_temp, app, keychain) = isolated_keychain();
        let path = app.join("identity.sqlite"); database(&path);
        let inner = MacIdentityStore::for_test(&app, keychain);
        struct MarkerFailureAfterStore<'a> {
            inner: &'a MacIdentityStore,
            marker: PathBuf,
        }
        impl ProtectedIdentityStore for MarkerFailureAfterStore<'_> {
            fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, GatewayError> { self.inner.load() }
            fn store(&self, bytes: &[u8]) -> Result<(), GatewayError> {
                self.inner.store(bytes)?;
                // A competing invalid marker models a post-Keychain marker
                // failure without altering the application data directory.
                fs::write(&self.marker, b"synthetic-conflicting-marker").unwrap();
                Ok(())
            }
            fn remove(&self) -> Result<(), GatewayError> { panic!("history failure must not delete a secret") }
        }
        let marker = app.join(IDENTITY_HISTORY_FILE);
        let store = MarkerFailureAfterStore { inner: &inner, marker: marker.clone() };
        expect_recovery(companion_gateway::load_or_create_identity(&path, &store));
        let metadata = companion_gateway::read_identity_metadata(&path).unwrap().unwrap();
        let protected = inner.load().unwrap().unwrap();
        let identity = companion_gateway::deserialize_identity(&protected).unwrap();
        assert_eq!(metadata.instance_id, identity.instance_id);
        assert_eq!(metadata.certificate_der, identity.certificate_der);
        assert_eq!(metadata.fingerprint, identity.fingerprint);
        assert_eq!(fs::read(&marker).unwrap(), b"synthetic-conflicting-marker");
    }

    #[test]
    fn macos_keychain_query_dictionaries_follow_password_contract() {
        let (_temp, app, keychain) = isolated_keychain();
        let account = account_for(&app).unwrap();
        let references = references_query(&account, &keychain);
        unsafe {
            assert!(references.contains_key(&kSecReturnRef.to_void()));
            assert!(references.contains_key(&kSecReturnAttributes.to_void()));
            assert!(references.contains_key(&kSecMatchLimit.to_void()));
            assert!(references.contains_key(&kSecMatchSearchList.to_void()));
            assert!(!references.contains_key(&kSecReturnData.to_void()));
        }
        // Protected bytes use CopyContent on one retained item, never an
        // all-matches password-data query. Keep the two-stage policy explicit.
        let secret = query_policy::QueryKind::Secret;
        assert!(secret.returns_data() && !secret.limit_all() && !secret.returns_item_reference());
    }

    #[test]
    fn macos_keychain_replaced_item_is_not_adopted_by_persistent_reference() {
        let (_temp, app, keychain) = isolated_keychain();
        let store = MacIdentityStore::for_test(&app, keychain.clone());
        store.store(b"same synthetic identity").unwrap();
        let account = account_for(&app).unwrap();
        let replacement_keychain = keychain.clone();
        AFTER_KEYCHAIN_SELECTION.with(|slot| *slot.borrow_mut() = Some(Box::new(move || {
            diagnostic("macos-keychain-swap-hook-entered");
            let (_password, item) = replacement_keychain.find_generic_password(SERVICE, &account).unwrap();
            item.delete(); // The fixture keychain and this item are synthetic and isolated.
            let missing = replacement_keychain.find_generic_password(SERVICE, &account)
                .err().unwrap_or_else(|| panic!("macos-keychain-swap-delete-unconfirmed"));
            if missing.code() != ITEM_NOT_FOUND {
                status_diagnostic("macos-keychain-swap-delete-unconfirmed", missing.code());
            }
            assert_eq!(missing.code(), ITEM_NOT_FOUND);
            diagnostic("macos-keychain-swap-deletion-confirmed");
            replacement_keychain.add_generic_password(SERVICE, &account, b"same synthetic identity").unwrap();
            diagnostic("macos-keychain-swap-replacement-stored");
        })));
        // Observe this one call without logging its data or performing a
        // second read before the original rejection assertion is evaluated.
        let result = store.load();
        match &result {
            Ok(Some(_)) => diagnostic("macos-keychain-swap-returned-data"),
            Ok(None) => diagnostic("macos-keychain-swap-returned-missing"),
            Err(error) => {
                diagnostic("macos-keychain-swap-returned-error");
                report_identity_error(error);
            }
        }
        // An unrelated initial lookup failure must not make this race test
        // pass without ever executing its replacement hook.
        assert!(AFTER_KEYCHAIN_SELECTION.with(|slot| slot.borrow().is_none()),
            "macos-keychain-swap-hook-not-completed");
        assert!(result.is_err());
        assert_eq!(store.load().unwrap().unwrap().as_slice(), b"same synthetic identity");
    }


}
