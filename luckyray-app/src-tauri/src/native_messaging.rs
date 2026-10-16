use crate::local_transport::{
    canonical_extension_origin, configured_extension_origins, load_native_credential,
    verify_native_proof, LOCAL_TRANSPORT_PROTOCOL_VERSION, NATIVE_HOST_PROTOCOL_VERSION,
};
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_NATIVE_REQUEST_BYTES: usize = 64 * 1024;
const MAX_NATIVE_RESPONSE_BYTES: usize = 1024 * 1024;
const LOCAL_PORT_START: u16 = 37418;
const LOCAL_PORT_END: u16 = 37467;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRequest {
    #[serde(rename = "type")]
    request_type: String,
    protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBootstrapConfig {
    pub protocol_version: u32,
    pub base_url: String,
    pub actual_port: u16,
    pub credential: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeError {
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeEnvelope<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<NativeError>,
}

fn app_data_dir() -> PathBuf {
    PathBuf::from(env::var("APPDATA").unwrap_or_default()).join("com.luckyray.desktop")
}

fn random_nonce() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn error(code: &str, message: &str) -> String {
    serde_json::to_string(&NativeEnvelope::<Value> {
        ok: false,
        data: None,
        error: Some(NativeError {
            code: code.to_string(),
            message: message.to_string(),
        }),
    })
    .unwrap_or_else(|_| {
        r#"{"ok":false,"error":{"code":"host-failed","message":"Native host failed"}}"#.to_string()
    })
}

fn parse_data(response: reqwest::blocking::Response) -> Result<Value, String> {
    let status = response.status();
    let payload: Value = response
        .json()
        .map_err(|_| "protocol-incompatible".to_string())?;
    if !status.is_success() || payload.get("ok") != Some(&Value::Bool(true)) {
        return Err(payload
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("bootstrap-failed")
            .to_string());
    }
    payload
        .get("data")
        .cloned()
        .ok_or_else(|| "protocol-incompatible".to_string())
}

fn bootstrap_with_ports(
    app_data: &Path,
    caller_origin: &str,
    ports: impl IntoIterator<Item = u16>,
) -> Result<NativeBootstrapConfig, String> {
    let origin =
        canonical_extension_origin(caller_origin).ok_or_else(|| "host-forbidden".to_string())?;
    if !configured_extension_origins()?.contains(&origin) {
        return Err("host-forbidden".to_string());
    }
    let native_credential = load_native_credential(app_data)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_millis(180))
        .timeout(Duration::from_millis(700))
        .build()
        .map_err(|_| "host-failed".to_string())?;

    for port in ports {
        let client_nonce = random_nonce();
        let proof_url = format!("http://127.0.0.1:{port}/api/v1/native/proof");
        let proof_response = match client
            .post(&proof_url)
            .header("Content-Type", "application/json")
            .json(&json!({"clientNonce": client_nonce}))
            .send()
        {
            Ok(response) => response,
            Err(_) => continue,
        };
        let proof_data = match parse_data(proof_response) {
            Ok(data) => data,
            Err(_) => continue,
        };
        let actual_port = proof_data
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok());
        let returned_nonce = proof_data.get("clientNonce").and_then(Value::as_str);
        let server_nonce = proof_data.get("serverNonce").and_then(Value::as_str);
        let proof = proof_data.get("proof").and_then(Value::as_str);
        if actual_port != Some(port)
            || returned_nonce != Some(client_nonce.as_str())
            || proof_data.get("protocolVersion").and_then(Value::as_u64)
                != Some(LOCAL_TRANSPORT_PROTOCOL_VERSION as u64)
            || !server_nonce.is_some_and(|value| value.len() == 64)
            || !proof.is_some_and(|value| value.len() == 64)
            || !verify_native_proof(
                &native_credential,
                port,
                &client_nonce,
                server_nonce.unwrap_or_default(),
                proof.unwrap_or_default(),
            )
        {
            continue;
        }

        let bootstrap_url = format!("http://127.0.0.1:{port}/api/v1/native/bootstrap");
        let data = client
            .post(&bootstrap_url)
            .header("Authorization", format!("Bearer {native_credential}"))
            .header("Content-Type", "application/json")
            .json(&json!({"extensionOrigin": origin}))
            .send()
            .map_err(|_| "app-unavailable".to_string())
            .and_then(parse_data)?;
        let config: NativeBootstrapConfig =
            serde_json::from_value(data).map_err(|_| "protocol-incompatible".to_string())?;
        if config.protocol_version != LOCAL_TRANSPORT_PROTOCOL_VERSION
            || config.actual_port != port
            || config.base_url != format!("http://127.0.0.1:{port}")
            || config.credential.len() != 64
        {
            return Err("protocol-incompatible".to_string());
        }
        return Ok(config);
    }
    Err("app-unavailable".to_string())
}

fn handle_request(app_data: &Path, caller_origin: &str, bytes: &[u8]) -> String {
    let request: NativeRequest = match serde_json::from_slice(bytes) {
        Ok(request) => request,
        Err(_) => return error("invalid-request", "Native request is invalid"),
    };
    if request.request_type != "bootstrap"
        || request.protocol_version != NATIVE_HOST_PROTOCOL_VERSION
    {
        return error(
            "protocol-incompatible",
            "LuckyRay and the extension must be updated",
        );
    }
    match bootstrap_with_ports(app_data, caller_origin, LOCAL_PORT_START..=LOCAL_PORT_END) {
        Ok(config) => serde_json::to_string(&NativeEnvelope {
            ok: true,
            data: Some(config),
            error: None,
        })
        .unwrap_or_else(|_| error("host-failed", "Native host failed")),
        Err(code) => {
            let message = match code.as_str() {
                "app-unavailable" => "Open LuckyRay and try again",
                "host-forbidden" => "This extension is not allowed",
                "protocol-incompatible" => "LuckyRay and the extension must be updated",
                _ => "LuckyRay native host failed",
            };
            error(&code, message)
        }
    }
}

fn read_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut length = [0u8; 4];
    match reader.read(&mut length[..1]) {
        Ok(0) => return Ok(None),
        Ok(1) => {}
        Ok(_) => unreachable!(),
        Err(_) => return Err("native-read-failed".to_string()),
    }
    reader
        .read_exact(&mut length[1..])
        .map_err(|_| "native-message-incomplete".to_string())?;
    let length = u32::from_ne_bytes(length) as usize;
    if length == 0 || length > MAX_NATIVE_REQUEST_BYTES {
        return Err("native-message-too-large".to_string());
    }
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .map_err(|_| "native-message-incomplete".to_string())?;
    Ok(Some(body))
}

fn write_frame(writer: &mut impl Write, payload: &[u8]) -> Result<(), String> {
    if payload.len() > MAX_NATIVE_RESPONSE_BYTES {
        return Err("native-response-too-large".to_string());
    }
    writer
        .write_all(&(payload.len() as u32).to_ne_bytes())
        .and_then(|_| writer.write_all(payload))
        .and_then(|_| writer.flush())
        .map_err(|_| "native-write-failed".to_string())
}

#[cfg(windows)]
fn set_binary_stdio() -> Result<(), String> {
    unsafe extern "C" {
        fn _setmode(file_descriptor: i32, mode: i32) -> i32;
    }
    const O_BINARY: i32 = 0x8000;
    unsafe {
        if _setmode(0, O_BINARY) == -1 || _setmode(1, O_BINARY) == -1 {
            return Err("native-stdio-mode-failed".to_string());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_binary_stdio() -> Result<(), String> {
    Ok(())
}

pub fn run() -> Result<(), String> {
    set_binary_stdio()?;
    let caller = env::args()
        .nth(1)
        .ok_or_else(|| "host-forbidden".to_string())?;
    let origin = canonical_extension_origin(&caller).ok_or_else(|| "host-forbidden".to_string())?;
    if !configured_extension_origins()?.contains(&origin) {
        return Err("host-forbidden".to_string());
    }
    let app_data = app_data_dir();
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    // The browser control plane uses sendNativeMessage: one process, one request,
    // one response. Return immediately after flushing so Chrome can settle the call.
    let Some(message) = read_frame(&mut input)? else {
        return Ok(());
    };
    let response = handle_request(&app_data, &origin, &message);
    write_frame(&mut output, response.as_bytes())?;
    Ok(())
}

pub fn write_host_manifest(path: &Path, binary_path: &Path) -> Result<(), String> {
    let allowed_origins: Vec<String> = configured_extension_origins()?
        .into_iter()
        .map(|origin| format!("{origin}/"))
        .collect();
    let manifest = json!({
        "name": crate::local_transport::NATIVE_HOST_NAME,
        "description": "LuckyRay browser bridge",
        "path": binary_path,
        "type": "stdio",
        "allowed_origins": allowed_origins,
    });
    let parent = path
        .parent()
        .ok_or_else(|| "native host manifest path is invalid".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "native host manifest directory is unavailable".to_string())?;
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|_| "native host manifest serialization failed".to_string())?,
    )
    .map_err(|_| "native host manifest write failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_transport::{
        start_server, AdapterResponse, ServerConfig, TransportAdapter, EDGE_DEV_EXTENSION_ORIGIN,
    };
    use std::io::Cursor;
    use std::net::{Ipv4Addr, TcpListener};
    use std::sync::{Arc, Mutex};
    use std::thread;

    struct NoopAdapter;

    impl TransportAdapter for NoopAdapter {
        fn dispatch(&self, _method: &str, _path: &str, _body: Option<&str>) -> AdapterResponse {
            AdapterResponse {
                status: 200,
                body: "{}".to_string(),
            }
        }

        fn collect(&self, _body: &Value) -> Result<Value, String> {
            Ok(json!({"id": "native-fixture"}))
        }
    }

    fn test_dir(label: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "luckyray-native-messaging-{label}-{}-{}",
            std::process::id(),
            random_nonce()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn framing_rejects_oversize_incomplete_and_body_origin_spoof() {
        assert_eq!(
            read_frame(&mut Cursor::new(vec![1u8])).unwrap_err(),
            "native-message-incomplete"
        );
        let mut oversized = Cursor::new(((MAX_NATIVE_REQUEST_BYTES + 1) as u32).to_ne_bytes());
        assert_eq!(
            read_frame(&mut oversized).unwrap_err(),
            "native-message-too-large"
        );

        let mut incomplete = Vec::new();
        incomplete.extend_from_slice(&8u32.to_ne_bytes());
        incomplete.extend_from_slice(b"{}");
        assert_eq!(
            read_frame(&mut Cursor::new(incomplete)).unwrap_err(),
            "native-message-incomplete"
        );

        let response = handle_request(
            Path::new("missing"),
            EDGE_DEV_EXTENSION_ORIGIN,
            br#"{"type":"bootstrap","protocolVersion":1,"origin":"chrome-extension://attacker"}"#,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap()["error"]["code"],
            "invalid-request"
        );

        let forbidden = handle_request(
            Path::new("missing"),
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            br#"{"type":"bootstrap","protocolVersion":1}"#,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&forbidden).unwrap()["error"]["code"],
            "host-forbidden"
        );
    }

    #[test]
    fn framing_round_trips_one_utf8_json_message_without_stdout_text() {
        let payload = br#"{"ok":true,"data":{"message":"LuckyRay"}}"#;
        let mut framed = Vec::new();
        write_frame(&mut framed, payload).unwrap();
        assert_eq!(&framed[..4], &(payload.len() as u32).to_ne_bytes());
        assert_eq!(&framed[4..], payload);
    }

    #[test]
    fn host_manifest_has_exact_origin_stdio_type_and_absolute_binary_path() {
        let dir = test_dir("manifest");
        let manifest_path = dir.join("com.luckyray.desktop.json");
        let binary_path = dir.join("luckyray-native-host.exe");
        write_host_manifest(&manifest_path, &binary_path).unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        assert_eq!(manifest["name"], "com.luckyray.desktop");
        assert_eq!(manifest["type"], "stdio");
        assert_eq!(manifest["path"], binary_path.to_string_lossy().as_ref());
        assert_eq!(
            manifest["allowed_origins"],
            json!([format!("{EDGE_DEV_EXTENSION_ORIGIN}/")])
        );
        assert!(!manifest.to_string().contains('*'));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fake_loopback_gets_only_anonymous_proof_before_real_native_bootstrap() {
        let app_data = test_dir("fake-first");
        let mut config = ServerConfig::test(app_data.clone());
        config.ports = vec![0];
        let real = start_server(config, Arc::new(NoopAdapter)).unwrap();
        let real_port = real
            .client_config()
            .base_url
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();

        let fake = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let fake_port = fake.local_addr().unwrap().port();
        let captured = Arc::new(Mutex::new(String::new()));
        let captured_thread = captured.clone();
        let fake_thread = thread::spawn(move || {
            let (mut stream, _) = fake.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                let count = stream.read(&mut chunk).unwrap_or(0);
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            *captured_thread.lock().unwrap() = String::from_utf8_lossy(&bytes).into_owned();
            let body = json!({"ok":true,"data":{"protocolVersion":1,"port":fake_port,"clientNonce":"00","serverNonce":"00","proof":"00"}}).to_string();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes());
        });

        let result =
            bootstrap_with_ports(&app_data, EDGE_DEV_EXTENSION_ORIGIN, [fake_port, real_port])
                .unwrap();
        fake_thread.join().unwrap();
        let fake_request = captured.lock().unwrap().clone();
        assert!(fake_request.starts_with("POST /api/v1/native/proof "));
        assert!(!fake_request.contains("Authorization"));
        assert!(!fake_request.contains("extensionOrigin"));
        assert_eq!(result.actual_port, real_port);
        assert_eq!(result.base_url, format!("http://127.0.0.1:{real_port}"));
        assert_eq!(result.credential.len(), 64);
        drop(real);
        std::fs::remove_dir_all(app_data).unwrap();
    }
}
