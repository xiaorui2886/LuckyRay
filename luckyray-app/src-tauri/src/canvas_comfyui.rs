//! Local ComfyUI preparation only. Never submits prompts, uploads or workflows.
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{path::Path, time::Duration};

const KEY: &str = "canvasComfyui.baseUrl.v1";
const DEFAULT: &str = "http://127.0.0.1:8188";
const INVALID: &str = "comfyui-local-address-invalid";
const UNAVAILABLE: &str = "comfyui-settings-unavailable";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config { pub base_url: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionResult {
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
/// Deliberately loopback-only in this foundation. No DNS lookup, redirects,
/// auth material, query parameters, or implicit remote/LAN server support.
pub(crate) fn validated_base(input: &str) -> Result<String, &'static str> {
    let raw = input.trim();
    if raw.is_empty() || raw.len() > 2048 || raw.chars().any(char::is_control) || raw.contains('\\') { return Err(INVALID); }
    let mut url = reqwest::Url::parse(raw).map_err(|_| INVALID)?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err(INVALID); }
    // Inspect original spelling too: URL parsers accept alternate numeric IPs.
    let authority = raw.split_once("://").ok_or(INVALID)?.1.split('/').next().ok_or(INVALID)?;
    let literal = if authority.starts_with('[') { authority.split(']').next().map(|s| format!("{s}]")) }
        else { authority.split(':').next().map(str::to_owned) }.ok_or(INVALID)?;
    if !matches!(literal.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]") { return Err(INVALID); }
    if url.host_str() == Some("localhost") { url.set_host(Some("127.0.0.1")).map_err(|_| INVALID)?; }
    if !matches!(url.host_str(), Some("127.0.0.1" | "[::1]")) || url.port() == Some(0) { return Err(INVALID); }
    // ComfyUI lives at the server root in this version, not arbitrary routes.
    if url.path() != "/" && !url.path().is_empty() { return Err(INVALID); }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
fn open(path: &Path) -> Result<Connection, &'static str> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|_| UNAVAILABLE)?;
    conn.busy_timeout(Duration::from_secs(3)).map_err(|_| UNAVAILABLE)?;
    Ok(conn)
}
pub(crate) fn get(path: &Path) -> Result<Config, &'static str> {
    let conn = open(path)?;
    let saved: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| r.get(0)).optional().map_err(|_| UNAVAILABLE)?;
    Ok(Config { base_url: validated_base(saved.as_deref().unwrap_or(DEFAULT))? })
}
pub(crate) fn set(path: &Path, input: &str) -> Result<Config, &'static str> {
    let base_url = validated_base(input)?;
    let conn = open(path)?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [KEY, &base_url]).map_err(|_| UNAVAILABLE)?;
    Ok(Config { base_url })
}
fn failed(error: &'static str) -> ConnectionResult {
    ConnectionResult { reachable: false, version: None, error: Some(error.into()) }
}
fn inspect(value: &Value) -> ConnectionResult {
    // A generic server returning JSON/HTTP 200 is not proof of ComfyUI.
    let Some(system) = value.get("system").and_then(Value::as_object) else { return failed("comfyui-unexpected-response"); };
    if !value.get("devices").is_some_and(Value::is_array)
        || !system.get("python_version").is_some_and(Value::is_string) { return failed("comfyui-unexpected-response"); }
    let version = system.get("comfyui_version").and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 80 && !v.chars().any(char::is_control)).map(str::to_owned);
    ConnectionResult { reachable: true, version, error: None }
}
pub(crate) async fn test(input: &str) -> Result<ConnectionResult, &'static str> {
    let base = validated_base(input)?;
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(8)).build().map_err(|_| UNAVAILABLE)?;
    let response = match client.get(format!("{base}/system_stats")).send().await {
        Ok(response) => response,
        Err(error) => return Ok(failed(if error.is_timeout() { "comfyui-timeout" } else { "comfyui-unreachable" })),
    };
    if !response.status().is_success() { return Ok(failed("comfyui-http-error")); }
    let body = match crate::read_ai_response_body_bounded(response, 64 * 1024, "comfyui-unexpected-response").await {
        Ok(body) => body,
        Err(_) => return Ok(failed("comfyui-unexpected-response")),
    };
    Ok(match serde_json::from_str::<Value>(&body) { Ok(value) => inspect(&value), Err(_) => failed("comfyui-unexpected-response") })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comfyui_accepts_only_explicit_loopback_root() {
        assert_eq!(validated_base("http://localhost:8188/"), Ok(DEFAULT.into()));
        assert_eq!(validated_base("http://[::1]:8188"), Ok("http://[::1]:8188".into()));
        for input in ["http://127.1:8188", "http://2130706433", "http://0x7f000001", "http://192.168.1.3:8188", "https://example.com", "http://localhost.evil", "http://u:p@localhost:8188", "http://127.0.0.1:8188?token=x", "http://127.0.0.1:8188/#x", "http://127.0.0.1:8188/prompt", "file:///tmp", "http://127.0.0.1:0"] {
            assert!(validated_base(input).is_err(), "{input}");
        }
    }
    #[test]
    fn comfyui_recognizes_stats_without_exposing_device_details() {
        let result = inspect(&serde_json::json!({"system":{"python_version":"3.12", "comfyui_version":"0.3.1", "argv":["secret"]},"devices":[{"name":"private"}]}));
        assert!(result.reachable);
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("private") && !json.contains("secret"));
        assert!(!inspect(&serde_json::json!({"ok":true})).reachable);
        assert!(!inspect(&serde_json::json!({"system":{},"devices":[]})).reachable);
    }
    #[test]
    fn comfyui_settings_roundtrip_keeps_other_settings() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let conn = Connection::open(tmp.path()).unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('other','keep');").unwrap();
        assert_eq!(get(tmp.path()).unwrap().base_url, DEFAULT);
        set(tmp.path(), "http://localhost:9000").unwrap();
        assert_eq!(get(tmp.path()).unwrap().base_url, "http://127.0.0.1:9000");
        assert!(set(tmp.path(), "https://example.com").is_err());
        assert_eq!(get(tmp.path()).unwrap().base_url, "http://127.0.0.1:9000");
        assert_eq!(conn.query_row("SELECT value FROM settings WHERE key='other'", [], |r| r.get::<_,String>(0)).unwrap(), "keep");
    }
}
