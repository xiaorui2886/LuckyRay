//! Linux-only consent controls. Remote content and secondary app views cannot
//! resolve requests or receive the consent-management snapshot.
use crate::local_transport::{linux_browser_authorization::Snapshot, LocalTransportHandle};
use tauri::Manager;

fn trusted_document(label: &str, url: &tauri::Url, development_origin: Option<&str>) -> bool {
    if label != "main" || !url.username().is_empty() || url.password().is_some() { return false; }
    let packaged = url.port().is_none() && match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")) => true,
        _ => false,
    };
    packaged || development_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin)
}

fn require_main(caller: &tauri::Webview) -> Result<(), String> {
    let url = caller.url().map_err(|_| "browser-connection-untrusted-caller")?;
    let config = caller.app_handle().config();
    let development_origin = if cfg!(debug_assertions) {
        config.build.dev_url.as_ref().filter(|url| matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
            .map(|url| url.origin().ascii_serialization())
    } else { None };
    if trusted_document(caller.label(), &url, development_origin.as_deref()) { Ok(()) }
    else { Err("browser-connection-untrusted-caller".into()) }
}

#[tauri::command]
pub(crate) fn linux_browser_connection_status(
    caller: tauri::Webview, transport: tauri::State<'_, LocalTransportHandle>,
) -> Result<Snapshot, String> {
    require_main(&caller)?;
    transport.linux_browser_snapshot()
}

#[tauri::command]
pub(crate) fn linux_browser_connection_decide(
    caller: tauri::Webview, request_id: String, decision: String,
    transport: tauri::State<'_, LocalTransportHandle>,
) -> Result<Snapshot, String> {
    require_main(&caller)?;
    transport.linux_decide_browser_request(&request_id, &decision)
}

#[tauri::command]
pub(crate) fn linux_browser_connection_revoke(
    caller: tauri::Webview, origin: String, grant_id: String,
    transport: tauri::State<'_, LocalTransportHandle>,
) -> Result<Snapshot, String> {
    require_main(&caller)?;
    transport.linux_revoke_browser_connection(&origin, &grant_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_browser_connection_requires_main_and_the_owned_document_origin() {
        for value in ["tauri://localhost/", "http://tauri.localhost/", "https://tauri.localhost/index.html"] {
            assert!(trusted_document("main", &value.parse().unwrap(), None));
            assert!(!trusted_document("notes-editor", &value.parse().unwrap(), None));
        }
        for value in ["https://example.test/", "http://tauri.localhost:1420/", "tauri://foreign/", "http://user@tauri.localhost/"] {
            assert!(!trusted_document("main", &value.parse().unwrap(), None));
        }
        assert!(trusted_document("main", &"http://localhost:1420/settings".parse().unwrap(), Some("http://localhost:1420")));
        assert!(!trusted_document("main", &"http://localhost:1421/".parse().unwrap(), Some("http://localhost:1420")));
    }
}
