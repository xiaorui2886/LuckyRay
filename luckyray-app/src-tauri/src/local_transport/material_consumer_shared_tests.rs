//! Shared production-adapter checks. Every profile, credential and library is
//! temporary; these tests do not start Tauri or touch the running main profile.
use super::*;
use crate::{backend::BackendServices, LegacyLocalTransportAdapter};
use crate::materials::consumer_transport;

struct Fixture {
    _root: tempfile::TempDir,
    backend: Arc<BackendServices>,
    auth: Arc<Mutex<AuthState>>,
    config: ServerConfig,
    target: String,
    other: String,
}

impl Fixture {
    fn new() -> Self {
        Self::with_media_loopback(false)
    }
    fn with_media_loopback(loopback: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let backend = BackendServices::initialize(root.path()).unwrap();
        let backend = Arc::new(if loopback { backend.with_loopback_media_for_test() } else { backend });
        let catalog = backend.material_catalog();
        let target_root = root.path().join("target-library");
        let other_root = root.path().join("other-library");
        fs::create_dir(&target_root).unwrap();
        fs::create_dir(&other_root).unwrap();
        let target = catalog.create_library("Capture target", &target_root, "managed").unwrap().id;
        let other = catalog.create_library("Other target", &other_root, "managed").unwrap().id;
        let auth = Arc::new(Mutex::new(AuthState::load_or_create(root.path()).unwrap()));
        let config = ServerConfig::test(root.path().to_owned());
        Self { _root: root, backend, auth, config, target, other }
    }

    fn principal(&self, origin: Option<&str>) -> VerifiedTransportPrincipal {
        let credential = match origin {
            Some(value) => self.auth.lock().unwrap().extension_credential(value).unwrap(),
            None => self.auth.lock().unwrap().native_credential().unwrap(),
        };
        let headers = HashMap::from([("authorization".into(), format!("Bearer {credential}"))]);
        authenticate(&headers, origin, &self.config, &self.auth, CapabilityTier::Dangerous)
            .unwrap_or_else(|_| panic!("synthetic credential must authenticate"))
    }

    fn input(&self, request_id: &str) -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/materialLibraryConsumer.v1.json")).unwrap();
        let mut input = fixture["importRequest"].clone();
        input["libraryId"] = json!(self.target);
        input["requestId"] = json!(request_id);
        input.as_object_mut().unwrap().remove("targetFolderId");
        input
    }
}

#[path = "ordinary_media_shared_tests.rs"]
mod ordinary_media;

fn tcp(handle: &LocalTransportHandle, method: &str, path: &str, payload: Option<&Value>) -> (u16, Value) {
    let config = handle.client_config();
    let body = payload.map(Value::to_string).unwrap_or_default();
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, handle.port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        handle.port, config.credential, body.len()).unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = String::new();
    if let Err(error) = stream.read_to_string(&mut response) {
        assert_eq!(error.kind(), ErrorKind::ConnectionReset);
    }
    let status = response.lines().next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    let value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
    (status, value)
}

#[test]
fn material_consumer_shared_routes_are_explicit_bounded_and_aliases_preserve_tier() {
    for prefix in ["/api", "/api/v1"] {
        let root = format!("{prefix}/material-libraries");
        let route = route_for("GET", &root).unwrap();
        assert_eq!(route.tier, CapabilityTier::Read);
        assert_eq!(route.max_body, 0);
        for suffix in ["taxonomy", "query", "detail", "import-bytes"] {
            let path = format!("{root}/{suffix}");
            let route = route_for("POST", &path).unwrap();
            assert_eq!(route.tier, CapabilityTier::Dangerous);
            assert_eq!(route.max_body, if suffix == "import-bytes" { 18 * 1024 * 1024 } else { DEFAULT_BODY_LIMIT });
            assert_eq!(route_for("GET", &path).err(), Some(405));
            assert_eq!(route_for("POST", &format!("{path}?library=other")).err(), Some(400));
        }
        assert_eq!(route_for("GET", &format!("{root}/files")).err(), Some(404));
        let receipt = route_for("POST", &format!("{root}/capture-receipt")).unwrap();
        assert_eq!(receipt.tier, CapabilityTier::Dangerous);
        assert_eq!(receipt.max_body, 1024);
        assert_eq!(route_for("GET", &format!("{root}/capture-receipt")).err(), Some(405));
        assert_eq!(route_for("POST", &format!("{root}/capture-receipt?requestId=other")).err(), Some(400));
    }
    let caps = capabilities_payload();
    assert_eq!(caps["namespaces"]["materials"]["libraryConsumer"]["consumerVersion"], 1);
    assert_eq!(caps["namespaces"]["materials"]["libraryConsumer"]["files"], false);
}

#[test]
fn material_consumer_shared_digest_only_principal_cannot_acquire_material_authority() {
    let fixture = Fixture::new();
    let principal = VerifiedTransportPrincipal::capture_test_principal();
    assert!(principal.material_admission().is_err());
    assert!(principal.material_authorization(&fixture.backend.material_catalog()).is_err());
    let response = LegacyLocalTransportAdapter::new(fixture.backend)
        .dispatch("GET", "/api/material-libraries", None);
    assert_eq!(response.status, 401);
}

#[test]
fn material_consumer_shared_native_rotation_before_write_is_definite_zero_write() {
    let fixture = Fixture::new();
    let principal = fixture.principal(None);
    let authorization = principal.material_authorization(&fixture.backend.material_catalog()).unwrap();
    let input = fixture.input("rotation-prewrite").to_string();
    let response = consumer_transport::route(&fixture.backend, &principal, authorization,
        "POST", "/api/material-libraries/import-bytes", Some(&input), |_| {
            fixture.auth.lock().unwrap().rotate_master().unwrap();
            principal.material_admission()
        }).unwrap();
    assert_eq!(response.status, 403);
    assert_eq!(serde_json::from_str::<Value>(&response.body).unwrap()["code"], "consumer-library-denied");
    assert!(fixture.backend.material_catalog().for_library(&fixture.target).unwrap()
        .list_assets(&Default::default()).unwrap().is_empty());
}

#[test]
fn material_consumer_shared_extension_revocation_invalidates_existing_clones() {
    let fixture = Fixture::new();
    fixture.auth.lock().unwrap().approve_origin(EDGE_DEV_EXTENSION_ORIGIN).unwrap();
    let principal = fixture.principal(Some(EDGE_DEV_EXTENSION_ORIGIN));
    let cloned = principal.clone();
    fixture.auth.lock().unwrap().revoke_origin(EDGE_DEV_EXTENSION_ORIGIN).unwrap();
    assert!(principal.material_admission().is_err());
    assert!(cloned.material_admission().is_err());
}

#[test]
fn material_consumer_shared_admission_holds_actual_auth_transition_lock() {
    let fixture = Fixture::new();
    let principal = fixture.principal(None);
    let guard = principal.material_admission().unwrap();
    assert!(fixture.auth.try_lock().is_err());
    drop(guard);
    fixture.auth.lock().unwrap().rotate_master().unwrap();
    assert!(principal.material_admission().is_err());
}

#[test]
fn material_consumer_shared_tcp_real_png_explicit_library_replay_and_metadata() {
    let fixture = Fixture::new();
    let catalog = fixture.backend.material_catalog();
    catalog.select_library(&fixture.other).unwrap();
    let handle = start_server(fixture.config.clone(),
        Arc::new(LegacyLocalTransportAdapter::new(Arc::clone(&fixture.backend)))).unwrap();
    let (status, libraries) = tcp(&handle, "GET", "/api/v1/material-libraries", None);
    assert_eq!(status, 200);
    assert_eq!(libraries["data"]["consumerVersion"], 1);
    assert!(!libraries.to_string().contains("rootPath"));
    let mut input = fixture.input("tcp-png-once");
    input["newFolderName"] = json!("网页截图");
    let (status, first) = tcp(&handle, "POST", "/api/v1/material-libraries/import-bytes", Some(&input));
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["data"]["libraryId"], fixture.target);
    assert_eq!(first["data"]["asset"]["kind"], "image");
    assert_eq!(first["data"]["asset"]["storageMode"], "managed");
    let (status, replay) = tcp(&handle, "POST", "/api/material-libraries/import-bytes", Some(&input));
    assert_eq!(status, 200);
    // The legacy alias intentionally returns the raw payload; v1 wraps it in data.
    assert_eq!(first["data"], replay);
    let target = catalog.for_library(&fixture.target).unwrap();
    assert_eq!(target.list_assets(&Default::default()).unwrap().len(), 1);
    assert!(catalog.for_library(&fixture.other).unwrap().list_assets(&Default::default()).unwrap().is_empty());
    assert!(catalog.list_assets(&Default::default()).unwrap().is_empty());
    assert_eq!(catalog.library_state().unwrap().1, fixture.other);
    let read = json!({"libraryId":fixture.target,"requestId":"tcp-query"});
    let (status, listed) = tcp(&handle, "POST", "/api/v1/material-libraries/query", Some(&read));
    assert_eq!(status, 200, "{listed}");
    assert_eq!(listed["data"]["items"].as_array().unwrap().len(), 1);
    assert!(!listed.to_string().contains("managedPath"));
    let detail = json!({"libraryId":fixture.target,"requestId":"tcp-detail","assetId":first["data"]["assetId"]});
    assert_eq!(tcp(&handle, "POST", "/api/v1/material-libraries/detail", Some(&detail)).0, 200);
    let (status, query_error) = tcp(&handle, "POST", "/api/v1/material-libraries/query?ignored=true", Some(&read));
    assert_eq!(status, 400);
    assert_eq!(query_error["error"]["code"], "query-unsupported");
    input["name"] = json!("changed.png");
    let (status, conflict) = tcp(&handle, "POST", "/api/v1/material-libraries/import-bytes", Some(&input));
    assert_eq!(status, 409);
    assert_eq!(conflict["error"]["code"], "request-id-conflict");
    assert_eq!(target.list_assets(&Default::default()).unwrap().len(), 1);
}

fn synthetic_browser_sized_png() -> Vec<u8> {
    use image::ImageEncoder;
    let (width, height) = (3828u32, 1911u32);
    let mut pixels = vec![246u8; (width * height * 3) as usize];
    let mut noise = 0x426u32;
    // Deterministic synthetic screen-sized PNG: a noisy top band and a solid
    // remainder yield >4MiB without copying a user's screenshot or profile.
    for byte in &mut pixels[..(width * 400 * 3) as usize] {
        noise ^= noise << 13;
        noise ^= noise >> 17;
        noise ^= noise << 5;
        *byte = noise as u8;
    }
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&pixels, width, height, image::ExtendedColorType::Rgb8).unwrap();
    assert!(png.len() > 4 * 1024 * 1024 && png.len() < crate::materials::consumer::MAX_CAPTURE_BYTES);
    png
}

#[test]
fn material_consumer_shared_tcp_browser_sized_png_is_saved_once() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture = Fixture::new();
    let png = synthetic_browser_sized_png();
    let mut input = fixture.input("synthetic-browser-sized-png");
    input["name"] = json!("Synthetic visible screenshot.png");
    input["bytesBase64"] = json!(STANDARD.encode(&png));
    input["sourcePageUrl"] = json!("https://page.test/capture");
    input["sourcePageTitle"] = json!("Synthetic visible screenshot");
    input["sourcePageKind"] = json!("capture-page");
    let catalog = fixture.backend.material_catalog();
    catalog.select_library(&fixture.other).unwrap();
    let handle = start_server(fixture.config.clone(),
        Arc::new(LegacyLocalTransportAdapter::new(Arc::clone(&fixture.backend)))).unwrap();
    let started = std::time::Instant::now();
    let (status, response) = tcp(&handle, "POST", "/api/material-libraries/import-bytes", Some(&input));
    eprintln!("synthetic PNG bytes={} requestBytes={} saveMs={} status={status}",
        png.len(), input.to_string().len(), started.elapsed().as_millis());
    assert_eq!(status, 200, "real PNG/TCP/Catalog save failed: {response}");
    assert_eq!(response["requestId"], input["requestId"]);
    assert_eq!(response["libraryId"], fixture.target);
    let target = catalog.for_library(&fixture.target).unwrap();
    let assets = target.list_assets(&Default::default()).unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(std::fs::read(assets[0].library_path.as_ref().unwrap()).unwrap(), png);
    assert!(catalog.list_assets(&Default::default()).unwrap().is_empty());
    assert!(catalog.for_library(&fixture.other).unwrap().list_assets(&Default::default()).unwrap().is_empty());
    let (status, replay) = tcp(&handle, "POST", "/api/material-libraries/import-bytes", Some(&input));
    assert_eq!(status, 200, "{replay}");
    assert_eq!(response, replay);
    assert_eq!(target.list_assets(&Default::default()).unwrap().len(), 1);
    assert_eq!(catalog.library_state().unwrap().1, fixture.other);
}

fn node_capture_scenario(scenario: &str, stage: &str, asset_count: usize) -> Value {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::process::{Command, Stdio};
    let fixture = Fixture::new();
    let png = synthetic_browser_sized_png();
    let catalog = fixture.backend.material_catalog();
    catalog.select_library(&fixture.other).unwrap();
    let mut config = fixture.config.clone();
    // Match the ordinary host's I/O deadlines; fixture port/profile remain
    // private to this test. No Main credential, browser, or profile is used.
    config.read_timeout = Duration::from_secs(5);
    config.write_timeout = Duration::from_secs(10);
    config.max_connections = MAX_CONNECTIONS_DEFAULT;
    if scenario == "chromium" {
        // Only this temporary host accepts the manifest's production public ID;
        // no ordinary profile, credential or running desktop is contacted.
        config.extension_origins.insert("chrome-extension://kjibmbcoioanaejehhfopjhdpnbkodla".into());
    }
    let handle = start_server(config,
        Arc::new(LegacyLocalTransportAdapter::new(Arc::clone(&fixture.backend)))).unwrap();
    let input = json!({
        "port": handle.port,
        "origin": EDGE_DEV_EXTENSION_ORIGIN,
        "libraryId": fixture.target,
        "pngBase64": STANDARD.encode(&png),
        "scenario": scenario,
    });
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(if scenario == "chromium" { "../tests/lib/capture-chromium-native-harness.mjs" }
            else { "../tests/lib/capture-native-host-harness.mjs" });
    let mut child = Command::new("node").arg(script)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().expect("Node.js is required for the real JS/native capture-chain test");
    child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    let report: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("capture harness did not return bounded JSON: {}", String::from_utf8_lossy(&output.stderr)));
    eprintln!("real JS/native capture-chain: {report}");
    assert!(output.status.success(), "{report}");
    assert_eq!(report["stage"], stage, "{report}");
    assert_eq!(report["businessWrites"], asset_count);
    assert_eq!(report["pendingCount"], 0);
    let target = catalog.for_library(&fixture.target).unwrap();
    let assets = target.list_assets(&Default::default()).unwrap();
    assert_eq!(assets.len(), asset_count);
    if asset_count != 0 {
        assert_eq!(std::fs::read(assets[0].library_path.as_ref().unwrap()).unwrap(), png);
    }
    assert!(catalog.list_assets(&Default::default()).unwrap().is_empty());
    assert!(catalog.for_library(&fixture.other).unwrap().list_assets(&Default::default()).unwrap().is_empty());
    assert_eq!(catalog.library_state().unwrap().1, fixture.other);
    report
}

#[test]
fn material_consumer_shared_node_capture_chain_saves_real_png() {
    let report = node_capture_scenario("normal", "saved", 1);
    assert_eq!(report["receiptReads"], 0);
}

#[test]
fn material_consumer_shared_chromium_saves_real_large_png() {
    node_capture_scenario("chromium", "saved", 1);
}

#[test]
fn material_consumer_shared_node_preflight_failure_is_not_a_pending_save() {
    let report = node_capture_scenario("preflight-failure", "failed", 0);
    assert_eq!(report["notCommitted"], true);
    assert_eq!(report["receiptReads"], 0);
}

#[test]
fn material_consumer_shared_node_lost_response_reads_real_receipt_without_reimport() {
    let report = node_capture_scenario("lost-response", "saved", 1);
    assert_eq!(report["receiptReads"], 1);
}

#[test]
fn material_consumer_shared_receipt_lookup_is_read_only_scoped_and_missing_is_unknown() {
    let fixture = Fixture::new();
    let principal = fixture.principal(None);
    let adapter = LegacyLocalTransportAdapter::new(Arc::clone(&fixture.backend));
    let import_path = "/api/material-libraries/import-bytes";
    let lookup_path = "/api/material-libraries/capture-receipt";
    let input = fixture.input("lookup-once");
    let imported = adapter.dispatch_verified(&principal, "POST", import_path, Some(&input.to_string()));
    assert_eq!(imported.status, 200);
    let target = json!({"libraryId":fixture.target,"requestId":"lookup-once"});
    let lookup = adapter.dispatch_verified(&principal, "POST", lookup_path, Some(&target.to_string()));
    let value: Value = serde_json::from_str(&lookup.body).unwrap();
    assert_eq!(lookup.status, 200);
    assert_eq!(value["state"], "completed");
    assert_eq!(value["receipt"], serde_json::from_str::<Value>(&imported.body).unwrap());
    for (library, request) in [(&fixture.target, "lookup-missing"), (&fixture.other, "lookup-once")] {
        let query = json!({"libraryId":library,"requestId":request});
        let read = adapter.dispatch_verified(&principal, "POST", lookup_path, Some(&query.to_string()));
        let value: Value = serde_json::from_str(&read.body).unwrap();
        assert_eq!(read.status, 200);
        assert_eq!(value["state"], "unknown");
        assert!(value["receipt"].is_null());
    }
    fixture.auth.lock().unwrap().approve_origin(EDGE_DEV_EXTENSION_ORIGIN).unwrap();
    let other_principal = fixture.principal(Some(EDGE_DEV_EXTENSION_ORIGIN));
    let other = adapter.dispatch_verified(&other_principal, "POST", lookup_path, Some(&target.to_string()));
    assert_eq!(serde_json::from_str::<Value>(&other.body).unwrap()["state"], "unknown");
    let invalid = json!({"libraryId":fixture.target,"requestId":"lookup-once","bytesBase64":"NOT_ALLOWED"});
    assert_eq!(adapter.dispatch_verified(&principal, "POST", lookup_path, Some(&invalid.to_string())).status, 400);
    fixture.backend.material_catalog().set_library_visible(&fixture.target, false).unwrap();
    assert_ne!(adapter.dispatch_verified(&principal, "POST", lookup_path, Some(&target.to_string())).status, 200);
    fixture.backend.material_catalog().set_library_visible(&fixture.target, true).unwrap();
    fixture.auth.lock().unwrap().revoke_origin(EDGE_DEV_EXTENSION_ORIGIN).unwrap();
    assert_eq!(adapter.dispatch_verified(&other_principal, "POST", lookup_path, Some(&target.to_string())).status, 403);
    let key = principal.capture_request_key(&format!("{import_path}:lookup-once"));
    std::fs::write(fixture.backend.app_data_dir().join("note-capture-receipts").join(format!("{key}.result")), b"damaged JSON").unwrap();
    let damaged = adapter.dispatch_verified(&principal, "POST", lookup_path, Some(&target.to_string()));
    assert_eq!(serde_json::from_str::<Value>(&damaged.body).unwrap()["state"], "unknown");
    assert_eq!(fixture.backend.material_catalog().for_library(&fixture.target).unwrap().list_assets(&Default::default()).unwrap().len(), 1);
    assert!(fixture.backend.material_catalog().for_library(&fixture.other).unwrap().list_assets(&Default::default()).unwrap().is_empty());
}

#[test]
fn material_consumer_shared_tcp_read_tier_enumeration_never_authorizes_import() {
    let fixture = Fixture::new();
    let mut config = fixture.config.clone();
    config.granted_tier = CapabilityTier::Read;
    let handle = start_server(config,
        Arc::new(LegacyLocalTransportAdapter::new(Arc::clone(&fixture.backend)))).unwrap();
    let (status, listed) = tcp(&handle, "GET", "/api/v1/material-libraries", None);
    assert_eq!(status, 200);
    for library in listed["data"]["libraries"].as_array().unwrap() {
        for permission in ["read", "organize", "import", "files"] {
            assert_eq!(library["capabilities"][permission], false);
        }
    }
    let (status, denied) = tcp(&handle, "POST", "/api/v1/material-libraries/import-bytes", Some(&fixture.input("read-tier")));
    assert_eq!(status, 403);
    assert_eq!(denied["error"]["code"], "capability-tier-denied");
    let lookup = json!({"libraryId":fixture.target,"requestId":"read-tier"});
    assert_eq!(tcp(&handle, "POST", "/api/v1/material-libraries/capture-receipt", Some(&lookup)).0, 403);
}

#[test]
fn material_consumer_shared_postcommit_delivery_revoke_keeps_receipt_unknown_and_replay_safe() {
    let fixture = Fixture::new();
    let principal = fixture.principal(None);
    let authorization = principal.material_authorization(&fixture.backend.material_catalog()).unwrap();
    let input = fixture.input("late-delivery-once").to_string();
    let committed = consumer_transport::route(&fixture.backend, &principal, authorization,
        "POST", "/api/material-libraries/import-bytes", Some(&input), |_| principal.material_admission()).unwrap();
    assert_eq!(committed.status, 200);
    let saved_body = committed.body.clone();
    fixture.auth.lock().unwrap().rotate_master().unwrap();
    let denied = principal.material_delivery_response(committed);
    assert_eq!(denied.status, 403);
    let body: Value = serde_json::from_str(&denied.body).unwrap();
    assert_eq!(body["code"], "consumer-delivery-denied");
    assert_eq!(body["writeOutcome"], "unknown");
    assert!(body.get("assetId").is_none());
    let reauthenticated = fixture.principal(None);
    let replay = LegacyLocalTransportAdapter::new(Arc::clone(&fixture.backend))
        .dispatch_verified(&reauthenticated, "POST", "/api/material-libraries/import-bytes", Some(&input));
    assert_eq!(replay.status, 200);
    assert_eq!(replay.body, saved_body);
    assert_eq!(fixture.backend.material_catalog().for_library(&fixture.target).unwrap()
        .list_assets(&Default::default()).unwrap().len(), 1);
}

#[test]
fn material_consumer_shared_failure_projection_preserves_only_bounded_unknown_marker() {
    for code in ["consumer-library-denied", "consumer-folder-denied", "consumer-tag-denied",
        "consumer-input-invalid", "consumer-capture-too-large", "consumer-capture-busy", "consumer-delivery-denied"] {
        let body = json!({"code":code,"writeOutcome":"unknown","message":"secret path",
            "raw":"do not project","assetId":"private"}).to_string();
        assert_eq!(safe_adapter_failure_code(&body), Some(code));
        assert_eq!(safe_adapter_failure_details(&body), Some(json!({"writeOutcome":"unknown"})));
    }
    assert!(safe_adapter_failure_details(r#"{"writeOutcome":"definitely-not-written"}"#).is_none());
}

#[test]
fn material_consumer_shared_final_error_response_keeps_only_exact_unknown() {
    for legacy in [true, false] {
        for code in ["consumer-library-denied", "consumer-folder-denied", "consumer-tag-denied",
            "consumer-input-invalid", "consumer-capture-too-large", "consumer-capture-busy",
            "consumer-delivery-denied", "note-material-title-invalid"] {
            let raw = json!({"code":code,"writeOutcome":"unknown","raw":"private-payload",
                "assetId":"private-asset","path":"private-path"}).to_string();
            let details = safe_adapter_failure_details(&raw).unwrap();
            let response = error_response(400, code, "Local operation failed", "wire-request",
                legacy, None, Some(&details));
            let body: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
            let projected = if legacy { &body } else { &body["error"]["details"] };
            assert_eq!(projected["writeOutcome"], "unknown", "legacy={legacy} code={code}");
            assert!(!response.contains("private-"), "Raw details must not escape the final envelope");
        }
        for value in [json!("definitely-not-written"), json!(true), json!({"secret":"private-payload"})] {
            let response = error_response(400, "consumer-input-invalid", "Local operation failed", "wire-request",
                legacy, None, Some(&json!({"writeOutcome":value})));
            // Legacy is also defensive at the serializer, not only at the adapter helper.
            if legacy { assert!(!response.contains("writeOutcome")); }
        }
    }
}

struct FailureProjectionAdapter;
impl TransportAdapter for FailureProjectionAdapter {
    fn collect(&self, _body: &Value) -> Result<Value, String> {
        Err("fixture-collect-not-used".into())
    }
    fn dispatch(&self, _method: &str, _path: &str, body: Option<&str>) -> AdapterResponse {
        let input: Value = serde_json::from_str(body.unwrap()).unwrap();
        AdapterResponse { status: input["status"].as_u64().unwrap() as u16,
            body: input["failure"].to_string() }
    }
}

#[test]
fn material_consumer_shared_final_error_tcp_aliases_and_v1_keep_unknown() {
    let root = tempfile::tempdir().unwrap();
    let handle = start_server(ServerConfig::test(root.path().to_owned()), Arc::new(FailureProjectionAdapter)).unwrap();
    // This adapter supplies controlled refusals; actual TCP authentication,
    // adapter projection and final serialization are production code. No writes.
    for (code, status) in [("consumer-library-denied", 403), ("consumer-folder-denied", 403),
        ("consumer-tag-denied", 403), ("consumer-input-invalid", 400),
        ("consumer-capture-too-large", 413), ("consumer-capture-busy", 429),
        ("consumer-delivery-denied", 403), ("note-material-title-invalid", 400)] {
        let path = if code.starts_with("note-") { "/notes/capture" }
            else { "/material-libraries/import-bytes" };
        for prefix in ["/api", "/api/v1"] {
            let input = json!({"status":status,"failure":{"code":code,"writeOutcome":"unknown",
                "raw":"private-payload","assetId":"private-asset","path":"private-path"}});
            let (actual_status, body) = tcp(&handle, "POST", &format!("{prefix}{path}"), Some(&input));
            assert_eq!(actual_status, status, "{prefix} {code} {body}");
            let projected = if prefix == "/api" { &body } else { &body["error"]["details"] };
            assert_eq!(projected["writeOutcome"], "unknown", "{prefix} {code} {body}");
            assert!(!body.to_string().contains("private-"));
            // An exact first-attempt prewrite refusal still has no unknown marker.
            let input = json!({"status":status,"failure":{"code":code}});
            let (actual_status, body) = tcp(&handle, "POST", &format!("{prefix}{path}"), Some(&input));
            assert_eq!(actual_status, status);
            assert!(!body.to_string().contains("writeOutcome"));
        }
    }
}
