use crate::local_transport::{
    load_native_credential, verify_native_proof, LOCAL_TRANSPORT_PROTOCOL_VERSION,
};
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const LOCAL_PORT_START: u16 = 37418;
const LOCAL_PORT_END: u16 = 37467;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const DISCOVERY_DEADLINE: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolClientError {
    code: String,
    message: &'static str,
    status: Option<u16>,
}

impl ToolClientError {
    fn new(code: impl Into<String>, message: &'static str) -> Self {
        Self {
            code: code.into(),
            message,
            status: None,
        }
    }

    fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &'static str {
        self.message
    }

    pub fn status(&self) -> Option<u16> {
        self.status
    }
}

impl std::fmt::Display for ToolClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for ToolClientError {}

pub struct ToolClient {
    client: Client,
    base_url: String,
    credential: String,
}

impl ToolClient {
    pub fn connect() -> Result<Self, ToolClientError> {
        let app_data = production_app_data_dir()?;
        Self::connect_to_ports(&app_data, LOCAL_PORT_START..=LOCAL_PORT_END)
    }

    #[cfg(test)]
    pub(crate) fn connect_with(
        app_data: &Path,
        ports: impl IntoIterator<Item = u16>,
    ) -> Result<Self, ToolClientError> {
        Self::connect_to_ports(app_data, ports)
    }

    fn connect_to_ports(
        app_data: &Path,
        ports: impl IntoIterator<Item = u16>,
    ) -> Result<Self, ToolClientError> {
        let credential = load_native_credential(app_data).map_err(|code| match code.as_str() {
            "app-unavailable" => ToolClientError::new("app-unavailable", "Open LuckyRay"),
            _ => ToolClientError::new(
                "authentication-unavailable",
                "LuckyRay authentication is unavailable",
            ),
        })?;
        let discovery = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_millis(180))
            .timeout(Duration::from_millis(700))
            .build()
            .map_err(|_| ToolClientError::new("client-unavailable", "CLI client failed"))?;
        let deadline = Instant::now() + DISCOVERY_DEADLINE;
        let mut saw_protocol = false;
        let mut saw_invalid_proof = false;

        for port in ports {
            if Instant::now() >= deadline {
                break;
            }
            let client_nonce = random_nonce();
            let response = match discovery
                .post(format!("http://127.0.0.1:{port}/api/v1/native/proof"))
                .header("Content-Type", "application/json")
                .json(&json!({"clientNonce":client_nonce}))
                .send()
            {
                Ok(response) => response,
                Err(_) => continue,
            };
            let status = response.status().as_u16();
            let payload = match read_json_response(response) {
                Ok(value) => value,
                Err(_) => {
                    saw_protocol = true;
                    continue;
                }
            };
            if status != 200 || payload.get("ok") != Some(&Value::Bool(true)) {
                saw_protocol = true;
                continue;
            }
            let Some(data) = payload.get("data") else {
                saw_protocol = true;
                continue;
            };
            let protocol = data.get("protocolVersion").and_then(Value::as_u64);
            let actual_port = data
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok());
            let returned_nonce = data.get("clientNonce").and_then(Value::as_str);
            let server_nonce = data.get("serverNonce").and_then(Value::as_str);
            let proof = data.get("proof").and_then(Value::as_str);
            if protocol != Some(LOCAL_TRANSPORT_PROTOCOL_VERSION as u64) {
                saw_protocol = true;
                continue;
            }
            if actual_port != Some(port)
                || returned_nonce != Some(client_nonce.as_str())
                || !server_nonce.is_some_and(is_strict_hex_secret)
                || !proof.is_some_and(is_strict_hex_secret)
                || !verify_native_proof(
                    &credential,
                    port,
                    &client_nonce,
                    server_nonce.unwrap_or_default(),
                    proof.unwrap_or_default(),
                )
            {
                saw_invalid_proof = true;
                continue;
            }
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_millis(500))
                .timeout(Duration::from_secs(35))
                .build()
                .map_err(|_| ToolClientError::new("client-unavailable", "CLI client failed"))?;
            return Ok(Self {
                client,
                base_url: format!("http://127.0.0.1:{port}"),
                credential,
            });
        }

        if saw_invalid_proof {
            Err(ToolClientError::new(
                "server-verification-failed",
                "LuckyRay server verification failed",
            ))
        } else if saw_protocol {
            Err(ToolClientError::new(
                "protocol-incompatible",
                "Update LuckyRay or the CLI",
            ))
        } else {
            Err(ToolClientError::new("app-unavailable", "Open LuckyRay"))
        }
    }

    pub fn list_tools(&self) -> Result<Value, ToolClientError> {
        self.authorized_request("GET", "/api/v1/tools/list", None)
    }

    pub fn run_tool(
        &self,
        tool_id: &str,
        mut input: Value,
        request_id: Option<&str>,
    ) -> Result<Value, ToolClientError> {
        if let (Some(request_id), Some(object)) = (request_id, input.as_object_mut()) {
            object
                .entry("requestId".to_string())
                .or_insert_with(|| Value::String(request_id.to_string()));
        }
        let body = json!({
            "toolId": tool_id,
            "input": input,
            "requestId": request_id,
        });
        self.authorized_request("POST", "/api/v1/tools/run", Some(body))
    }

    fn authorized_request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ToolClientError> {
        let body_bytes = body
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| ToolClientError::new("tool-input-invalid", "Tool input is invalid"))?;
        if body_bytes
            .as_ref()
            .is_some_and(|bytes| bytes.len() > MAX_REQUEST_BYTES)
        {
            return Err(ToolClientError::new(
                "tool-input-too-large",
                "Tool input is too large",
            ));
        }
        let url = format!("{}{path}", self.base_url);
        let mut request = match method {
            "GET" => self.client.get(url),
            "POST" => self.client.post(url),
            _ => {
                return Err(ToolClientError::new(
                    "client-request-invalid",
                    "CLI request is invalid",
                ))
            }
        }
        .header("Authorization", format!("Bearer {}", self.credential))
        .header("Connection", "close");
        if let Some(bytes) = body_bytes {
            request = request
                .header("Content-Type", "application/json")
                .body(bytes);
        }
        let response = request
            .send()
            .map_err(|_| ToolClientError::new("transport-failed", "LuckyRay request failed"))?;
        let status = response.status().as_u16();
        let payload = read_json_response(response)?;
        if status == 401 || status == 403 {
            return Err(ToolClientError::new(
                "authentication-failed",
                "LuckyRay authentication failed",
            )
            .with_status(status));
        }
        if payload.get("ok") != Some(&Value::Bool(true)) || !(200..300).contains(&status) {
            let code = payload
                .pointer("/error/code")
                .and_then(Value::as_str)
                .filter(|value| is_safe_code(value))
                .unwrap_or("tool-request-failed");
            return Err(ToolClientError::new(code, safe_server_message(code)).with_status(status));
        }
        payload.get("data").cloned().ok_or_else(|| {
            ToolClientError::new("protocol-incompatible", "Update LuckyRay or the CLI")
        })
    }
}

fn production_app_data_dir() -> Result<PathBuf, ToolClientError> {
    let root = env::var_os("APPDATA")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolClientError::new("app-unavailable", "Open LuckyRay"))?;
    Ok(PathBuf::from(root).join("com.luckyray.desktop"))
}

fn random_nonce() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_strict_hex_secret(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_safe_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn safe_server_message(code: &str) -> &'static str {
    match code {
        "tool-not-found" => "Tool does not exist",
        "tool-unavailable" => "Tool is unavailable",
        "tool-input-invalid" => "Tool input is invalid",
        "tool-input-too-large" => "Tool input is too large",
        "request-id-conflict" => "requestId conflicts with an earlier request",
        "knowledge-vault-required" => "Open or create a Vault",
        "knowledge-vault-not-current" | "knowledge-vault-changed" => {
            "The requested Vault is not current"
        }
        "knowledge-revision-conflict" => "Knowledge document revision changed",
        "knowledge-name-conflict" => "Knowledge document already exists",
        "tool-request-capacity" => "Tool request capacity is exhausted",
        _ => "LuckyRay tool request failed",
    }
}

fn read_json_response(response: Response) -> Result<Value, ToolClientError> {
    let mut bytes = Vec::new();
    response
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ToolClientError::new("transport-failed", "LuckyRay request failed"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(ToolClientError::new(
            "response-too-large",
            "LuckyRay response is too large",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ToolClientError::new("protocol-incompatible", "Update LuckyRay or the CLI"))
}

#[cfg(test)]
mod tests {
    use super::ToolClient;
    use crate::knowledge::KnowledgeVaultRegistration;
    use crate::local_transport::native_proof_message;
    use crate::tool_cli::run_with_connector;
    use crate::{
        backend::BackendServices,
        local_transport::{start_server, ServerConfig},
        LegacyLocalTransportAdapter,
    };
    use hmac::{Hmac, Mac};
    use serde_json::{json, Value};
    use sha2::Sha256;
    use std::fs;
    use std::io::{Cursor, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "luckyray-cli-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn register_vault(
        backend: &BackendServices,
        id: &str,
        root: &std::path::Path,
    ) -> KnowledgeVaultRegistration {
        fs::create_dir_all(root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: id.to_string(),
            name: id.to_string(),
            root_path: root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-16T00:00:00Z".to_string(),
            last_opened_at: "2026-07-16T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        backend.knowledge().register_current_vault(&vault).unwrap();
        vault
    }

    fn spawn_invalid_proof_server(
        protocol_version: u64,
    ) -> (u16, Arc<Mutex<Vec<u8>>>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let thread_captured = captured.clone();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                let count = stream.read(&mut chunk).unwrap_or(0);
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                let header_end = request.windows(4).position(|part| part == b"\r\n\r\n");
                if let Some(header_end) = header_end {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            *thread_captured.lock().unwrap() = request.clone();
            let body_start = request
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .unwrap()
                + 4;
            let body: serde_json::Value = serde_json::from_slice(&request[body_start..]).unwrap();
            let nonce = body["clientNonce"].as_str().unwrap();
            let response_body = json!({
                "ok":true,
                "data":{
                    "protocolVersion":protocol_version,
                    "port":port,
                    "clientNonce":nonce,
                    "serverNonce":"a".repeat(64),
                    "proof":"b".repeat(64)
                }
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
            stream.flush().unwrap();
        });
        (port, captured, handle)
    }

    fn spawn_redirecting_proof_server(
        status: u16,
    ) -> (u16, Arc<AtomicUsize>, Vec<thread::JoinHandle<()>>) {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let target_port = target.local_addr().unwrap().port();
        let target_hits = Arc::new(AtomicUsize::new(0));
        let hits = target_hits.clone();
        let target_handle = thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                match target.accept() {
                    Ok((mut stream, _)) => {
                        hits.fetch_add(1, Ordering::SeqCst);
                        let mut request = [0u8; 4096];
                        let _ = stream.read(&mut request);
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(error) => panic!("redirect target accept failed: {error}"),
                }
            }
        });

        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        source.set_nonblocking(true).unwrap();
        let source_port = source.local_addr().unwrap().port();
        let source_ready = Arc::new(Barrier::new(2));
        let thread_ready = source_ready.clone();
        let source_handle = thread::spawn(move || {
            thread_ready.wait();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                match source.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0u8; 4096];
                        let _ = stream.read(&mut request);
                        write!(
                            stream,
                            "HTTP/1.1 {status} Redirect\r\nLocation: http://127.0.0.1:{target_port}/redirect-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .unwrap();
                        stream.flush().unwrap();
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(error) => panic!("redirect source accept failed: {error}"),
                }
            }
        });
        source_ready.wait();
        (source_port, target_hits, vec![source_handle, target_handle])
    }

    fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let count = stream.read(&mut chunk).unwrap_or(0);
            if count == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..count]);
            let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        request
    }

    fn hex_decode(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|chunk| {
                let text = std::str::from_utf8(chunk).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }

    fn native_proof(credential: &str, port: u16, client_nonce: &str, server_nonce: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&hex_decode(credential)).unwrap();
        mac.update(native_proof_message(port, client_nonce, server_nonce).as_bytes());
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn spawn_authenticated_redirect_server(
        credential: String,
        status: u16,
    ) -> (
        u16,
        Arc<AtomicUsize>,
        Arc<Mutex<Vec<u8>>>,
        Arc<Mutex<Vec<u8>>>,
        Vec<thread::JoinHandle<()>>,
    ) {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let target_port = target.local_addr().unwrap().port();
        let target_hits = Arc::new(AtomicUsize::new(0));
        let target_request = Arc::new(Mutex::new(Vec::new()));
        let hits = target_hits.clone();
        let target_capture = target_request.clone();
        let target_handle = thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                match target.accept() {
                    Ok((mut stream, _)) => {
                        hits.fetch_add(1, Ordering::SeqCst);
                        *target_capture.lock().unwrap() = read_http_request(&mut stream);
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(error) => panic!("authenticated redirect target failed: {error}"),
                }
            }
        });

        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_port = source.local_addr().unwrap().port();
        let protected_request = Arc::new(Mutex::new(Vec::new()));
        let protected_capture = protected_request.clone();
        let source_handle = thread::spawn(move || {
            let (mut proof_stream, _) = source.accept().unwrap();
            let proof_request = read_http_request(&mut proof_stream);
            let body_start = proof_request
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .unwrap()
                + 4;
            let body: Value = serde_json::from_slice(&proof_request[body_start..]).unwrap();
            let client_nonce = body["clientNonce"].as_str().unwrap();
            let server_nonce = "c".repeat(64);
            let proof = native_proof(&credential, source_port, client_nonce, &server_nonce);
            let proof_body = json!({
                "ok":true,
                "data":{
                    "protocolVersion":1,
                    "port":source_port,
                    "clientNonce":client_nonce,
                    "serverNonce":server_nonce,
                    "proof":proof
                }
            })
            .to_string();
            write!(
                proof_stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                proof_body.len(),
                proof_body
            )
            .unwrap();
            proof_stream.flush().unwrap();

            let (mut tool_stream, _) = source.accept().unwrap();
            *protected_capture.lock().unwrap() = read_http_request(&mut tool_stream);
            let error_body = json!({
                "ok":false,
                "error":{"code":"redirect-refused"}
            })
            .to_string();
            write!(
                tool_stream,
                "HTTP/1.1 {status} Redirect\r\nLocation: http://127.0.0.1:{target_port}/redirect-target?PRIVATE-LOCATION-SENTINEL\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                error_body.len(),
                error_body
            )
            .unwrap();
            tool_stream.flush().unwrap();
        });
        (
            source_port,
            target_hits,
            target_request,
            protected_request,
            vec![source_handle, target_handle],
        )
    }

    fn spawn_proxy_recorder() -> (
        String,
        Arc<AtomicUsize>,
        Arc<Mutex<Vec<u8>>>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let captured = Arc::new(Mutex::new(Vec::new()));
        let thread_hits = hits.clone();
        let thread_captured = captured.clone();
        let handle = thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
            while std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        thread_hits.fetch_add(1, Ordering::SeqCst);
                        let request = read_http_request(&mut stream);
                        thread_captured.lock().unwrap().extend(request);
                        let _ = stream.write_all(
                            b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(error) => panic!("proxy recorder failed: {error}"),
                }
            }
        });
        (proxy_url, hits, captured, handle)
    }

    #[test]
    fn client_lists_the_production_registry_after_native_proof() {
        let app_data = temp_dir("list");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let server = start_server(
            ServerConfig::test(app_data.clone()),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();

        let port = server
            .client_config()
            .base_url
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let client = ToolClient::connect_with(&app_data, [port]).unwrap();
        let definitions = client.list_tools().unwrap();
        let ids = definitions
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["id"].as_str())
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
    fn fake_first_port_receives_only_anonymous_proof_before_real_tool_request() {
        let app_data = temp_dir("fake-first");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let server = start_server(
            ServerConfig::test(app_data.clone()),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();
        let real_port = server
            .client_config()
            .base_url
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let (fake_port, captured, handle) = spawn_invalid_proof_server(1);

        let client = ToolClient::connect_with(&app_data, [fake_port, real_port]).unwrap();
        assert!(client.list_tools().unwrap().is_array());
        handle.join().unwrap();

        let request = String::from_utf8_lossy(&captured.lock().unwrap()).to_ascii_lowercase();
        assert!(request.starts_with("post /api/v1/native/proof "));
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("/api/v1/tools/"));
        assert!(!request.contains("private-tool-input"));
    }

    #[test]
    fn proof_redirects_never_reach_the_redirect_target() {
        let app_data = temp_dir("proof-redirect");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let _server = start_server(
            ServerConfig::test(app_data.clone()),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();
        for status in [302, 307, 308] {
            let (source_port, target_hits, handles) = spawn_redirecting_proof_server(status);
            let error = ToolClient::connect_with(&app_data, [source_port])
                .err()
                .unwrap();
            for handle in handles {
                handle.join().unwrap();
            }
            assert_eq!(error.code(), "protocol-incompatible");
            assert_eq!(target_hits.load(Ordering::SeqCst), 0, "status {status}");
        }
    }

    #[test]
    fn authenticated_redirects_never_forward_authorization_or_tool_payload() {
        let app_data = temp_dir("authenticated-redirect");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let _server = start_server(
            ServerConfig::test(app_data.clone()),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();
        let credential = super::load_native_credential(&app_data).unwrap();
        let sentinel = "PRIVATE-TOOL-INPUT-SENTINEL";
        for status in [307, 308] {
            let (source_port, target_hits, target_request, protected_request, handles) =
                spawn_authenticated_redirect_server(credential.clone(), status);
            let client = ToolClient::connect_with(&app_data, [source_port]).unwrap();
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let exit = run_with_connector(
                vec![
                    "tools".to_string(),
                    "run".to_string(),
                    "knowledge.search".to_string(),
                    "--input".to_string(),
                    json!({"query":sentinel,"limit":1}).to_string(),
                ],
                Cursor::new(Vec::<u8>::new()),
                &mut stdout,
                &mut stderr,
                || Ok(client),
            );
            for handle in handles {
                handle.join().unwrap();
            }

            let source = String::from_utf8_lossy(&protected_request.lock().unwrap()).to_string();
            assert!(source
                .to_ascii_lowercase()
                .contains("authorization: bearer "));
            assert!(source.contains(sentinel));
            assert_eq!(target_hits.load(Ordering::SeqCst), 0, "status {status}");
            assert!(target_request.lock().unwrap().is_empty());
            assert_eq!(exit, 4);
            assert!(stdout.is_empty());
            let error: Value = serde_json::from_slice(&stderr).unwrap();
            assert_eq!(error["error"]["code"], "redirect-refused");
            let safe_error = String::from_utf8(stderr).unwrap();
            assert!(!safe_error.contains(sentinel));
            assert!(!safe_error.contains("PRIVATE-LOCATION-SENTINEL"));
            assert!(!safe_error.contains(&credential));
        }
    }

    #[test]
    fn spawned_cli_uses_production_proof_and_auth_without_system_proxy() {
        let proxy_names = [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ];
        let parent_proxy_before = proxy_names.map(std::env::var_os);
        let app_data_parent = temp_dir("spawned-cli-parent");
        let app_data = app_data_parent.join("com.luckyray.desktop");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let mut server_config = ServerConfig::test(app_data.clone());
        server_config.ports = (super::LOCAL_PORT_START..=super::LOCAL_PORT_END).collect();
        let _server = start_server(
            server_config,
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();
        let credential = super::load_native_credential(&app_data).unwrap();
        let (proxy_url, proxy_hits, proxy_request, proxy_handle) = spawn_proxy_recorder();
        let cli = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join("luckyray-cli.exe");
        assert!(cli.is_file(), "cargo must build the production CLI binary");

        let output = Command::new(cli)
            .args(["tools", "list"])
            .env("APPDATA", &app_data_parent)
            .env("HTTP_PROXY", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env("ALL_PROXY", &proxy_url)
            .env("http_proxy", &proxy_url)
            .env("https_proxy", &proxy_url)
            .env("all_proxy", &proxy_url)
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .output()
            .unwrap();
        proxy_handle.join().unwrap();

        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());
        let definitions: Value = serde_json::from_slice(&output.stdout).unwrap();
        let ids = definitions
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|definition| definition["id"].as_str())
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
        assert_eq!(proxy_hits.load(Ordering::SeqCst), 0);
        assert!(proxy_request.lock().unwrap().is_empty());
        let output_text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!output_text.contains(&credential));
        assert!(!output_text.contains(&proxy_url));
        assert_eq!(parent_proxy_before, proxy_names.map(std::env::var_os));
    }

    #[test]
    fn incompatible_protocol_and_rotated_auth_fail_with_stable_safe_codes() {
        let app_data = temp_dir("protocol-auth");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let server = start_server(
            ServerConfig::test(app_data.clone()),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();
        let real_port = server
            .client_config()
            .base_url
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let (old_port, _captured, handle) = spawn_invalid_proof_server(99);
        let incompatible = ToolClient::connect_with(&app_data, [old_port])
            .err()
            .unwrap();
        handle.join().unwrap();
        assert_eq!(incompatible.code(), "protocol-incompatible");

        let client = ToolClient::connect_with(&app_data, [real_port]).unwrap();
        let old_credential = super::load_native_credential(&app_data).unwrap();
        server.rotate_credentials().unwrap();
        let auth = client.list_tools().unwrap_err();
        assert_eq!(auth.code(), "authentication-failed");
        assert!(!format!("{auth:?}").contains(&old_credential));
    }

    #[test]
    fn cached_write_is_rejected_after_vault_switch_and_reused_after_switch_back() {
        let app_data = temp_dir("vault-switch-app");
        let vault_a_root = temp_dir("vault-switch-a");
        let vault_b_root = temp_dir("vault-switch-b");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let vault_a = register_vault(&backend, "vault-client-a", &vault_a_root);
        let server = start_server(
            ServerConfig::test(app_data.clone()),
            Arc::new(LegacyLocalTransportAdapter::new(backend.clone())),
        )
        .unwrap();
        let port = server
            .client_config()
            .base_url
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let input = json!({
            "expectedVaultId":vault_a.id,
            "relativePath":"Replay.md",
            "content":"created once",
            "requestId":"cli-vault-replay"
        });
        let first = ToolClient::connect_with(&app_data, [port])
            .unwrap()
            .run_tool("knowledge.create", input.clone(), Some("cli-vault-replay"))
            .unwrap();

        let _vault_b = register_vault(&backend, "vault-client-b", &vault_b_root);
        let switched = ToolClient::connect_with(&app_data, [port])
            .unwrap()
            .run_tool("knowledge.create", input.clone(), Some("cli-vault-replay"))
            .unwrap_err();
        assert_eq!(switched.code(), "knowledge-vault-not-current");
        assert!(!vault_b_root.join("Replay.md").exists());

        backend
            .knowledge()
            .register_current_vault(&vault_a)
            .unwrap();
        let replay = ToolClient::connect_with(&app_data, [port])
            .unwrap()
            .run_tool("knowledge.create", input, Some("cli-vault-replay"))
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(
            fs::read_to_string(vault_a_root.join("Replay.md")).unwrap(),
            "created once"
        );
    }
}
