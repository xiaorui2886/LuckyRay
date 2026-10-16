use crate::extension_packages_store::{Request, State};
use crate::extension_runtime::manage;
use tauri::Manager;

#[tauri::command]
pub(crate) async fn manage_extension_packages(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    request: String,
) -> Result<State, String> {
    // LSH adds a native child webview to the main window. WebviewWindow's
    // command extractor rejects that multi-webview window before this body
    // runs. Authorize the invoking webview, not its shared parent window.
    if caller.label() != "main" {
        return Err("extension-host-window-required".into());
    }
    if request.len() > 140_000 {
        return Err("extension-package-too-large".into());
    }
    let request: Request =
        serde_json::from_str(&request).map_err(|_| "extension-invalid-request")?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "extension-storage-unavailable")?;
    tauri::async_runtime::spawn_blocking(move || manage(&root, env!("CARGO_PKG_VERSION"), request))
        .await
        .map_err(|_| "extension-worker-failed")?
}
