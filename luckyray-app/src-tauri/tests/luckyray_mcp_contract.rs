use hmac::{Hmac, Mac};
use rmcp::{model::CallToolRequestParams, transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Value};
use sha2::Sha256;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(label: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "luckyray-mcp-contract-{label}-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn remove_temp_dir_after_child_exit(path: &std::path::Path) {
    const ATTEMPTS: usize = 40;
    for attempt in 0..ATTEMPTS {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt + 1 < ATTEMPTS => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => panic!(
                "temporary MCP executable remained locked: {:?}",
                error.kind()
            ),
        }
    }
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn native_credential(master_secret: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&decode_hex(master_secret)).unwrap();
    mac.update(b"luckyray-local-transport-credential-v1\0");
    mac.update(b"native\0v1");
    encode_hex(&mac.finalize().into_bytes())
}

fn native_proof(credential: &str, port: u16, client_nonce: &str, server_nonce: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&decode_hex(credential)).unwrap();
    mac.update(
        format!(
            "luckyray-local-transport-native-proof-v1\nprotocol:1\nport:{port}\nclientNonce:{client_nonce}\nserverNonce:{server_nonce}"
        )
        .as_bytes(),
    );
    encode_hex(&mac.finalize().into_bytes())
}

fn read_http_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut content_length = None;
    loop {
        let read = stream.read(&mut buffer).unwrap();
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if content_length.is_none() {
            if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                content_length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                });
            }
        }
        if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            if bytes.len() >= header_end + 4 + content_length.unwrap_or(0) {
                break;
            }
        }
    }
    bytes
}

fn write_http_json(stream: &mut std::net::TcpStream, status: u16, value: &Value) {
    let body = value.to_string();
    write!(
        stream,
        "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    stream.flush().unwrap();
}

fn test_tool_definitions() -> Value {
    let definition = |id: &str, risk: &str| {
        json!({
            "id":id,"version":1,"title":id,"description":"MCP integration tool",
            "risk":risk,
            "inputSchema":{"type":"object","additionalProperties":true},
            "outputSchema":{"type":"object","additionalProperties":true},
            "availability":{"available":true},
            "idempotency":if risk == "read" {"read-only"} else {"request-id-single-flight"},
            "maxInputBytes":524288,"maxOutputBytes":524288
        })
    };
    json!([
        definition("capability.run", "dangerous"),
        definition("knowledge.append", "write"),
        definition("knowledge.create", "write"),
        definition("knowledge.read", "read"),
        definition("knowledge.search", "read"),
        definition("knowledge.set_tags", "write"),
        definition("materials.search", "read")
    ])
}

struct ToolHttpFixture {
    app_data_root: std::path::PathBuf,
    vault_root: std::path::PathBuf,
    stop: Arc<AtomicBool>,
    request_ids: Arc<Mutex<Vec<String>>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl ToolHttpFixture {
    fn start(label: &str) -> Self {
        let app_data_root = temp_dir(&format!("{label}-appdata-root"));
        let app_data = app_data_root.join("com.luckyray.desktop");
        let vault_root = temp_dir(&format!("{label}-vault"));
        std::fs::create_dir_all(&app_data).unwrap();
        let master_secret = "31".repeat(32);
        std::fs::write(
            app_data.join("local-transport-auth-v1.json"),
            serde_json::to_vec(&json!({
                "version":2,"masterSecret":master_secret,"approvedOrigins":[]
            }))
            .unwrap(),
        )
        .unwrap();
        let credential = native_credential(&master_secret);
        let listener = (37418..=37467)
            .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
            .expect("an isolated production discovery port should be free");
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let request_ids = Arc::new(Mutex::new(Vec::new()));
        let thread_stop = stop.clone();
        let thread_ids = request_ids.clone();
        let thread_vault = vault_root.clone();
        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture listener failed: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                let request = read_http_request(&mut stream);
                let header_end = request
                    .windows(4)
                    .position(|part| part == b"\r\n\r\n")
                    .unwrap();
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let first_line = headers.lines().next().unwrap_or_default();
                let body = serde_json::from_slice::<Value>(&request[header_end + 4..])
                    .unwrap_or(Value::Null);
                if first_line.starts_with("POST /api/v1/native/proof ") {
                    let client_nonce = body["clientNonce"].as_str().unwrap();
                    let server_nonce = "42".repeat(32);
                    let proof = native_proof(&credential, port, client_nonce, &server_nonce);
                    write_http_json(
                        &mut stream,
                        200,
                        &json!({"ok":true,"data":{
                            "protocolVersion":1,"port":port,"clientNonce":client_nonce,
                            "serverNonce":server_nonce,"proof":proof
                        }}),
                    );
                    continue;
                }
                let authorized = headers.lines().any(|line| {
                    let Some((name, value)) = line.split_once(':') else {
                        return false;
                    };
                    name.eq_ignore_ascii_case("authorization")
                        && value.trim() == format!("Bearer {credential}")
                });
                if !authorized {
                    write_http_json(
                        &mut stream,
                        401,
                        &json!({"ok":false,"error":{"code":"authentication-failed"}}),
                    );
                    continue;
                }
                if first_line.starts_with("GET /api/v1/tools/list ") {
                    write_http_json(
                        &mut stream,
                        200,
                        &json!({"ok":true,"data":test_tool_definitions()}),
                    );
                    continue;
                }
                if first_line.starts_with("POST /api/v1/tools/run ") {
                    let tool_id = body["toolId"].as_str().unwrap_or_default();
                    let input = &body["input"];
                    if let Some(request_id) = body["requestId"].as_str() {
                        thread_ids.lock().unwrap().push(request_id.to_string());
                    }
                    if input.get("expectedVaultId").and_then(Value::as_str) == Some("missing-vault")
                    {
                        write_http_json(
                            &mut stream,
                            409,
                            &json!({"ok":false,"error":{"code":"knowledge-vault-required"}}),
                        );
                        continue;
                    }
                    let result = match tool_id {
                        "knowledge.read" => {
                            let Some(relative_path) = input
                                .pointer("/documentRef/relativePath")
                                .and_then(Value::as_str)
                            else {
                                write_http_json(
                                    &mut stream,
                                    400,
                                    &json!({"ok":false,"error":{"code":"tool-input-invalid"}}),
                                );
                                continue;
                            };
                            let content = std::fs::read_to_string(thread_vault.join(relative_path))
                                .unwrap_or_default();
                            let size = content.len();
                            json!({"documentRef":{"vaultId":"vault-official-child","relativePath":relative_path},
                                "kdoc":"kdoc-child","revision":"11".repeat(32),"content":content,
                                "title":"Existing","modifiedAt":"2026-07-16T00:00:00Z","size":size})
                        }
                        "knowledge.create" => {
                            let relative_path = input["relativePath"].as_str().unwrap();
                            std::fs::write(
                                thread_vault.join(relative_path),
                                input["content"].as_str().unwrap(),
                            )
                            .unwrap();
                            json!({"documentRef":{"vaultId":"vault-official-child","relativePath":relative_path},
                                "kdoc":"kdoc-child-created","revision":"22".repeat(32),"indexStale":false})
                        }
                        "knowledge.append" => {
                            let relative_path = input
                                .pointer("/documentRef/relativePath")
                                .and_then(Value::as_str)
                                .unwrap();
                            let mut file = std::fs::OpenOptions::new()
                                .append(true)
                                .open(thread_vault.join(relative_path))
                                .unwrap();
                            file.write_all(input["content"].as_str().unwrap().as_bytes())
                                .unwrap();
                            json!({"documentRef":{"vaultId":"vault-official-child","relativePath":relative_path},
                                "kdoc":"kdoc-child-created","revision":"33".repeat(32),"indexStale":false})
                        }
                        _ => json!({}),
                    };
                    write_http_json(
                        &mut stream,
                        200,
                        &json!({"ok":true,"data":{
                            "toolId":tool_id,"version":1,"result":result,"requestId":body["requestId"]
                        }}),
                    );
                    continue;
                }
                write_http_json(
                    &mut stream,
                    404,
                    &json!({"ok":false,"error":{"code":"not-found"}}),
                );
            }
        });
        Self {
            app_data_root,
            vault_root,
            stop,
            request_ids,
            handle: Some(handle),
        }
    }

    fn replace_auth_master(&self, master_secret: &str) {
        let app_data = self.app_data_root.join("com.luckyray.desktop");
        std::fs::write(
            app_data.join("local-transport-auth-v1.json"),
            serde_json::to_vec(&json!({
                "version":2,"masterSecret":master_secret,"approvedOrigins":[]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ToolHttpFixture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[test]
fn mcp_binary_prints_a_safe_json_config_from_its_actual_unicode_path() {
    let temp = temp_dir("print-config-json");
    let binary_dir = temp.join("Lucky Ray 配置");
    std::fs::create_dir_all(&binary_dir).unwrap();
    let copied_binary = binary_dir.join("luckyray-mcp.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_luckyray-mcp"), &copied_binary).unwrap();
    let codex_home = temp.join("codex-home");
    std::fs::create_dir_all(&codex_home).unwrap();
    let existing_config = codex_home.join("config.toml");
    std::fs::write(&existing_config, "sentinel = 'unchanged'\n").unwrap();

    let output = Command::new(&copied_binary)
        .args(["--print-config", "json"])
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{:?}", output.stderr);
    assert!(output.stderr.is_empty());
    let config: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        config["mcpServers"]["luckyray"]["command"],
        copied_binary.to_string_lossy().as_ref()
    );
    assert_eq!(config["mcpServers"]["luckyray"]["args"], json!([]));
    assert_eq!(
        std::fs::read_to_string(existing_config).unwrap(),
        "sentinel = 'unchanged'\n"
    );
    let wire = String::from_utf8(output.stdout).unwrap();
    for forbidden in [
        "credential",
        "masterSecret",
        "APPDATA",
        "CODEX_HOME",
        "Authorization",
        "127.0.0.1",
    ] {
        assert!(!wire.contains(forbidden), "config leaked {forbidden}");
    }
    remove_temp_dir_after_child_exit(&temp);
}

#[test]
fn mcp_binary_prints_parseable_codex_toml_and_rejects_invalid_args() {
    let binary = env!("CARGO_BIN_EXE_luckyray-mcp");
    let output = Command::new(binary)
        .args(["--print-config", "codex"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{:?}", output.stderr);
    assert!(output.stderr.is_empty());
    let config: toml::Value = toml::from_str(std::str::from_utf8(&output.stdout).unwrap()).unwrap();
    let server = &config["mcp_servers"]["luckyray"];
    assert_eq!(server["command"].as_str(), Some(binary));
    assert_eq!(server["args"].as_array().unwrap().len(), 0);
    assert_eq!(
        server["default_tools_approval_mode"].as_str(),
        Some("writes")
    );

    for args in [
        vec!["--print-config"],
        vec!["--print-config", "codex", "json"],
        vec!["--print-config", "unknown"],
        vec!["--unknown", "PRIVATE-ARG-SENTINEL"],
    ] {
        let invalid = Command::new(binary)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(invalid.status.code(), Some(2));
        assert!(invalid.stdout.is_empty());
        let stderr = String::from_utf8(invalid.stderr).unwrap();
        assert_eq!(
            stderr,
            "usage: luckyray-mcp [--print-config <codex|json>]\n"
        );
        assert!(!stderr.contains("PRIVATE-ARG-SENTINEL"));
    }
}

#[test]
fn mcp_binary_supports_the_2025_11_25_initialize_contract() {
    let offline_root = temp_dir("raw-client-offline");
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-mcp"))
        .env("APPDATA", offline_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("MCP process should start");
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name":"luckyray-contract","version":"1"}
        }
    });
    writeln!(child.stdin.as_mut().unwrap(), "{request}").unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["result"]["protocolVersion"], "2025-11-25");
    writeln!(
        child.stdin.as_mut().unwrap(),
        "{}",
        serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )
    .unwrap();
    writeln!(
        child.stdin.as_mut().unwrap(),
        "{}",
        serde_json::json!({
            "jsonrpc":"2.0","id":"offline-list","method":"tools/list","params":{}
        })
    )
    .unwrap();
    child.stdin.as_mut().unwrap().flush().unwrap();
    line.clear();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["error"]["data"]["code"], "app-unavailable");
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn official_rmcp_client_spawns_the_binary_and_calls_list_read_create_and_append() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut fixture = ToolHttpFixture::start("official-client-online");
        std::fs::write(fixture.vault_root.join("Existing.md"), "# Existing\n").unwrap();
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_luckyray-mcp"));
        command.env("APPDATA", &fixture.app_data_root);
        let transport = TokioChildProcess::new(command).unwrap();
        let client = ().serve(transport).await.unwrap();
        assert_eq!(
            client.peer_info().unwrap().protocol_version.to_string(),
            "2025-11-25"
        );
        let listed = client.list_tools(Default::default()).await.unwrap();
        assert_eq!(listed.tools.len(), 7);
        let annotations = listed
            .tools
            .iter()
            .map(|tool| (tool.name.to_string(), tool.annotations.clone().unwrap()))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(annotations["knowledge.read"].idempotent_hint, Some(true));
        assert_eq!(annotations["knowledge.create"].idempotent_hint, Some(false));
        assert_eq!(annotations["knowledge.append"].idempotent_hint, Some(false));

        let read = client
            .call_tool(CallToolRequestParams::new("knowledge.read").with_arguments(
                json!({"documentRef":{"vaultId":"vault-official-child","relativePath":"Existing.md"}})
                    .as_object().unwrap().clone(),
            ))
            .await
            .unwrap();
        assert_eq!(read.is_error, Some(false));
        assert_eq!(read.structured_content.as_ref().unwrap()["content"], "# Existing\n");

        let created = client
            .call_tool(CallToolRequestParams::new("knowledge.create").with_arguments(
                json!({"expectedVaultId":"vault-official-child","relativePath":"Created.md","content":"# Created\n"})
                    .as_object().unwrap().clone(),
            ))
            .await
            .unwrap();
        assert_eq!(created.is_error, Some(false));
        let appended = client
            .call_tool(CallToolRequestParams::new("knowledge.append").with_arguments(
                json!({"expectedVaultId":"vault-official-child","documentRef":{"vaultId":"vault-official-child","relativePath":"Created.md"},
                    "expectedRevision":"22".repeat(32),"content":"Appended\n"})
                    .as_object().unwrap().clone(),
            ))
            .await
            .unwrap();
        assert_eq!(appended.is_error, Some(false));
        assert_eq!(
            std::fs::read_to_string(fixture.vault_root.join("Created.md")).unwrap(),
            "# Created\nAppended\n"
        );

        let invalid = client
            .call_tool(CallToolRequestParams::new("knowledge.read"))
            .await
            .unwrap();
        assert_eq!(invalid.is_error, Some(true));
        assert!(invalid.structured_content.is_none());
        let no_vault = client
            .call_tool(CallToolRequestParams::new("knowledge.create").with_arguments(
                json!({"expectedVaultId":"missing-vault","relativePath":"No.md","content":"PRIVATE-NO-VAULT"})
                    .as_object().unwrap().clone(),
            ))
            .await
            .unwrap();
        assert_eq!(no_vault.is_error, Some(true));
        assert!(no_vault.structured_content.is_none());
        let no_vault_wire = serde_json::to_string(&no_vault).unwrap();
        assert!(!no_vault_wire.contains("PRIVATE-NO-VAULT"));
        let backend_request_ids = fixture.request_ids.lock().unwrap().clone();
        assert!(backend_request_ids.len() >= 3);
        assert_eq!(
            backend_request_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            backend_request_ids.len(),
            "different official-client JSON-RPC calls must not share a backend requestId"
        );

        fixture.replace_auth_master(&"55".repeat(32));
        let auth_failed = client
            .call_tool(CallToolRequestParams::new("knowledge.read").with_arguments(
                json!({"documentRef":{"vaultId":"vault-official-child","relativePath":"Existing.md"}})
                    .as_object().unwrap().clone(),
            ))
            .await
            .unwrap();
        assert_eq!(auth_failed.is_error, Some(true));
        assert!(auth_failed.structured_content.is_none());
        fixture.shutdown();
        let unavailable = client
            .call_tool(CallToolRequestParams::new("knowledge.read").with_arguments(
                json!({"documentRef":{"vaultId":"vault-official-child","relativePath":"Existing.md"}})
                    .as_object().unwrap().clone(),
            ))
            .await
            .unwrap();
        assert_eq!(unavailable.is_error, Some(true));
        assert!(unavailable.structured_content.is_none());
        client.cancel().await.unwrap();
    });
}
