use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const CREDENTIAL: &str = "PRIVATE-FIXTURE-CREDENTIAL-SENTINEL";
static SERVER_LOCK: Mutex<()> = Mutex::new(());

fn invoke(root: &TempDir, args: &[&str], input: Option<&[u8]>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-cli-fixture"))
        .args(args)
        .current_dir(root.path())
        .env("APPDATA", root.path().join("PRIVATE-PATH-SENTINEL"))
        .env_remove("LUCKYRAY_APP_PROFILE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        // Oversized input may be rejected before every byte is consumed.
        let _ = child.stdin.take().unwrap().write_all(input);
    } else {
        drop(child.stdin.take());
    }
    child.wait_with_output().unwrap()
}

fn result(output: &Output, exit: i32) -> Value {
    assert_eq!(
        output.status.code(),
        Some(exit),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    if exit == 0 {
        assert!(output.stderr.is_empty());
        serde_json::from_slice(&output.stdout).unwrap()
    } else {
        assert!(output.stdout.is_empty());
        let value: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(value["ok"], false);
        let rendered = String::from_utf8_lossy(&output.stderr);
        for secret in [
            CREDENTIAL,
            "PRIVATE-PATH-SENTINEL",
            "PRIVATE-ERROR-SENTINEL",
        ] {
            assert!(!rendered.contains(secret));
        }
        value
    }
}

#[derive(Clone)]
struct Response {
    status: u16,
    data: Value,
}
impl Response {
    fn ok(data: Value) -> Self {
        Self {
            status: 200,
            data: json!({"ok":true,"data":data}),
        }
    }
}

struct Server {
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<(String, String, Value)>>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Server {
    fn start(root: &TempDir, health: Response, definitions: Response, proof_valid: bool) -> Self {
        let app_data = root
            .path()
            .join("PRIVATE-PATH-SENTINEL/com.luckyray.desktop");
        fs::create_dir_all(&app_data).unwrap();
        fs::write(app_data.join("fixture-native-credential"), CREDENTIAL).unwrap();
        let listener = (37418..=37467)
            .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
            .expect("an isolated test port is available");
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let thread_stop = stop.clone();
        let captures = requests.clone();
        let worker = thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("fixture listener: {error}"),
                };
                let (head, body) = read_request(&mut stream);
                let path = head
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .to_string();
                captures
                    .lock()
                    .unwrap()
                    .push((path.clone(), head.clone(), body.clone()));
                let response = match path.as_str() {
                    "/api/v1/native/proof" => {
                        assert!(!head.to_ascii_lowercase().contains("authorization:"));
                        Response::ok(json!({"protocolVersion":1,"port":port,
                            "clientNonce":body["clientNonce"],"serverNonce":"c".repeat(64),
                            "proof":if proof_valid { "f".repeat(64) } else { "0".repeat(64) }}))
                    }
                    "/api/v1/health" => health.clone(),
                    "/api/v1/tools/list" => definitions.clone(),
                    "/api/v1/tools/run" => Response::ok(json!({"toolId":body["toolId"],
                        "result":{"received":body["input"]},"requestId":body["requestId"]})),
                    _ => panic!("unexpected route: {path}"),
                };
                if path != "/api/v1/native/proof" {
                    assert!(
                        head.contains(CREDENTIAL),
                        "only proven server gets credential"
                    );
                }
                let bytes = serde_json::to_vec(&response.data).unwrap();
                write!(stream, "HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status, bytes.len()).unwrap();
                stream.write_all(&bytes).unwrap();
            }
        });
        Self {
            stop,
            requests,
            worker: Some(worker),
        }
    }

    fn paths(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|(path, _, _)| path.clone())
            .collect()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn read_request(stream: &mut TcpStream) -> (String, Value) {
    // Winsock accepted sockets inherit the listener's nonblocking mode.
    // The fixture's bounded parser deliberately performs blocking reads.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        assert!(Instant::now() < deadline);
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                let body = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap()
                };
                return (head, body);
            }
        }
    }
}

fn health() -> Response {
    Response::ok(
        json!({"service":"luckyray-local-transport","protocolVersion":1,
        "controlPlane":"local-transport","private":CREDENTIAL}),
    )
}
fn registry() -> Response {
    Response::ok(json!([
        {"id":"materials.search","version":1,"risk":"read",
         "inputSchema":{"type":"object","properties":{"query":{"type":"string"}}},
         "outputSchema":{"type":"object"},"availability":{"available":true}},
        {"id":"knowledge.create","version":1,"risk":"write",
         "inputSchema":{"type":"object"},"availability":{"available":false,
         "code":"knowledge-vault-required","reason":"Open or create a Vault"}},
        {"id":"materials.library_taxonomy","version":2,"risk":"read",
         "inputSchema":{"type":"object"},"availability":{"available":true}}
    ]))
}

#[test]
fn local_help_version_and_fixed_handshakes_do_not_need_a_running_app() {
    let root = TempDir::new().unwrap();
    for args in [
        vec!["--help"],
        vec!["-h"],
        vec!["help"],
        vec!["tools", "--help"],
        vec!["tools", "run", "--help"],
        vec!["doctor", "--help"],
    ] {
        let output = invoke(&root, &args, None);
        assert_eq!(output.status.code(), Some(0));
        assert!(output.stderr.is_empty());
        let text = String::from_utf8(output.stdout).unwrap();
        for command in [
            "tools describe",
            "status",
            "doctor",
            "--stdin",
            "Exit codes",
        ] {
            assert!(text.contains(command));
        }
    }
    for args in [
        vec!["--help", "--json"],
        vec!["--json", "tools", "run", "--help"],
        vec!["tools", "run", "--help", "--json"],
    ] {
        let data = result(&invoke(&root, &args, None), 0);
        assert_eq!(data["exitCodes"]["connection"], 3);
    }
    for arg in ["--version", "-V", "version"] {
        let output = invoke(&root, &[arg], None);
        assert_eq!(output.status.code(), Some(0));
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "luckyray-cli 1.9.8\n"
        );
    }
    assert_eq!(
        result(&invoke(&root, &["--version", "--json"], None), 0)["version"],
        "1.9.8"
    );
    assert_eq!(
        result(&invoke(&root, &["protocol", "identity"], None), 0)["protocol"],
        "luckyray-cli-contract-v1"
    );
    fs::write(root.path().join("package.json"), r#"{"name":"fixture"}"#).unwrap();
    assert_eq!(
        result(&invoke(&root, &["verify", "workspace-manifest"], None), 0)["status"],
        "passed"
    );
}

#[test]
fn invalid_arguments_are_redacted_usage_errors_before_connection() {
    let root = TempDir::new().unwrap();
    for args in [
        vec![],
        vec!["unknown"],
        vec!["--help", "--extra"],
        vec!["tools", "list", "--extra"],
        vec!["--json", "tools", "list", "--json"],
        vec!["status", "--repair"],
        vec!["tools", "describe"],
        vec!["tools", "describe", "PRIVATE-PATH-SENTINEL"],
        vec!["tools", "run", "materials.search"],
        vec![
            "tools",
            "run",
            "materials.search",
            "--input",
            "PRIVATE-ERROR-SENTINEL",
        ],
        vec!["tools", "run", "materials.search", "--input", "--json"],
        vec![
            "tools",
            "run",
            "materials.search",
            "--input",
            "{}",
            "--stdin",
        ],
        vec!["tools", "run", "materials.search", "--stdin", "--stdin"],
        vec![
            "tools",
            "run",
            "materials.search",
            "--input",
            "{}",
            "--request-id",
            "bad id",
        ],
        vec!["verify", "workspace-manifest", "--json"],
    ] {
        let data = result(&invoke(&root, &args, None), 2);
        assert_eq!(data["error"]["code"], "cli-usage-invalid");
    }
    let oversized = vec![b'x'; 1024 * 1024 + 1];
    result(
        &invoke(
            &root,
            &["tools", "run", "materials.search", "--stdin"],
            Some(&oversized),
        ),
        2,
    );
}

#[test]
fn offline_commands_preserve_connection_error_contract() {
    let root = TempDir::new().unwrap();
    for args in [
        vec!["tools", "list"],
        vec!["tools", "describe", "materials.search"],
        vec!["status"],
        vec!["doctor", "--json"],
    ] {
        assert_eq!(
            result(&invoke(&root, &args, None), 3)["error"]["code"],
            "app-unavailable"
        );
    }
}

#[test]
fn development_profile_uses_its_own_credential_and_never_falls_back() {
    let _guard = SERVER_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let server = Server::start(&root, health(), registry(), true);
    let profile_root = root.path().join("PRIVATE-PATH-SENTINEL");
    fs::rename(
        profile_root.join("com.luckyray.desktop"),
        profile_root.join("com.luckyray.desktop.dev"),
    ).unwrap();
    let invoke_profile = |profile: &str| {
        Command::new(env!("CARGO_BIN_EXE_luckyray-cli-fixture"))
            .args(["status"])
            .env("APPDATA", &profile_root)
            .env("LUCKYRAY_APP_PROFILE", profile)
            .output().unwrap()
    };
    assert_eq!(result(&invoke_profile("development"), 0)["serverVerified"], true);
    assert_eq!(result(&invoke_profile("production"), 3)["error"]["code"], "app-unavailable");
    let count = server.requests.lock().unwrap().len();
    assert_eq!(result(&invoke_profile("arbitrary-profile"), 3)["error"]["code"], "runtime-profile-invalid");
    assert_eq!(server.requests.lock().unwrap().len(), count);
}

#[test]
fn discovery_and_diagnostics_use_the_live_registry_and_only_read_routes() {
    let _guard = SERVER_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let server = Server::start(&root, health(), registry(), true);
    let listed = result(&invoke(&root, &["tools", "list"], None), 0);
    assert_eq!(listed.as_array().unwrap().len(), 3);
    let described = result(
        &invoke(
            &root,
            &["tools", "describe", "materials.library_taxonomy", "--json"],
            None,
        ),
        0,
    );
    assert_eq!(described["version"], 2);
    assert_eq!(described["inputSchema"]["type"], "object");
    let unavailable = result(
        &invoke(&root, &["tools", "describe", "knowledge.create"], None),
        0,
    );
    assert_eq!(unavailable["availability"]["available"], false);
    assert_eq!(
        result(
            &invoke(&root, &["tools", "describe", "not.in.registry"], None),
            4
        )["error"]["code"],
        "tool-not-found"
    );
    let status = result(&invoke(&root, &["status"], None), 0);
    assert_eq!(
        status,
        json!({"ok":true,"status":"ready","service":"luckyray-local-transport",
        "protocolVersion":1,"serverVerified":true})
    );
    let doctor = result(&invoke(&root, &["--json", "doctor"], None), 0);
    assert_eq!(doctor["toolCount"], 3);
    assert_eq!(doctor["availableToolCount"], 2);
    assert_eq!(
        doctor["unavailableTools"],
        json!([{"id":"knowledge.create","code":"knowledge-vault-required"}])
    );
    assert!(!doctor.to_string().contains(CREDENTIAL));
    assert!(!server
        .paths()
        .iter()
        .any(|path| path == "/api/v1/tools/run"));
}

#[test]
fn legacy_run_and_json_flags_preserve_request_identity_and_input() {
    let _guard = SERVER_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let server = Server::start(&root, health(), registry(), true);
    for args in [
        vec![
            "tools",
            "run",
            "knowledge.set_tags",
            "--input",
            "{\"query\":\"needle\"}",
            "--request-id",
            "case:1",
        ],
        vec![
            "--json",
            "tools",
            "run",
            "materials.search",
            "--stdin",
            "--request-id",
            "case:1",
        ],
        vec![
            "tools",
            "run",
            "materials.search",
            "--stdin",
            "--request-id",
            "case:1",
            "--json",
        ],
    ] {
        let data = result(&invoke(&root, &args, Some(br#"{"query":"needle"}"#)), 0);
        assert_eq!(data["requestId"], "case:1");
        assert_eq!(
            data["result"]["received"],
            json!({"query":"needle","requestId":"case:1"})
        );
    }
    assert_eq!(
        server
            .paths()
            .iter()
            .filter(|path| *path == "/api/v1/tools/run")
            .count(),
        3
    );
}

#[test]
fn invalid_proof_health_registry_and_authentication_fail_closed() {
    let _guard = SERVER_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    {
        let server = Server::start(&root, health(), registry(), false);
        assert_eq!(
            result(&invoke(&root, &["doctor"], None), 3)["error"]["code"],
            "server-verification-failed"
        );
        assert_eq!(server.paths(), vec!["/api/v1/native/proof"]);
    }
    for (health_value, definitions, args, code, exit) in [
        (
            Response::ok(
                json!({"service":"unexpected","protocolVersion":1,"controlPlane":"local-transport"}),
            ),
            registry(),
            vec!["status"],
            "protocol-incompatible",
            3,
        ),
        (
            health(),
            Response::ok(json!({"tools":[]})),
            vec!["doctor"],
            "protocol-incompatible",
            3,
        ),
        (
            health(),
            Response::ok(
                json!([{"id":"bad.native","availability":{"available":false,"code":"PRIVATE-ERROR-SENTINEL /path"}}]),
            ),
            vec!["doctor"],
            "protocol-incompatible",
            3,
        ),
        (
            health(),
            Response::ok(json!([{"id":"same.tool"},{"id":"same.tool"}])),
            vec!["tools", "describe", "same.tool"],
            "protocol-incompatible",
            3,
        ),
        (
            health(),
            Response {
                status: 401,
                data: json!({"ok":false,"error":{"code":"PRIVATE-ERROR-SENTINEL"}}),
            },
            vec!["doctor"],
            "authentication-failed",
            3,
        ),
        (
            health(),
            Response {
                status: 503,
                data: json!({"ok":false,"error":{"code":"tool-unavailable","message":"PRIVATE-ERROR-SENTINEL"}}),
            },
            vec!["tools", "describe", "materials.search"],
            "tool-unavailable",
            4,
        ),
    ] {
        let _server = Server::start(&root, health_value, definitions, true);
        assert_eq!(
            result(&invoke(&root, &args, None), exit)["error"]["code"],
            code
        );
    }
}
