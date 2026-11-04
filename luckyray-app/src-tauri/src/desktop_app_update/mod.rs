//! Application updates are separate from DSH engine updates.
//! Scheduling never quits. Immediate restart must pass the shared save/task barrier.
mod feed;
#[cfg(windows)]
pub(crate) mod installer;
#[cfg(windows)]
mod ownership;
mod policy;
mod store;
mod verification;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(crate) use windows::{
    __cmd__desktop_application_update, __tauri_command_name_desktop_application_update,
    desktop_application_update, initialize, scheduled_exit_guard_required, report_scheduled_quit_blocked,
};
#[cfg(target_os = "linux")]
pub(crate) mod appimage;
#[cfg(not(windows))]
pub(crate) fn scheduled_exit_guard_required(_app: &tauri::AppHandle) -> Result<bool, &'static str> { Ok(false) }
#[cfg(not(windows))]
pub(crate) fn report_scheduled_quit_blocked(_app: &tauri::AppHandle, _code: &'static str) {}
#[cfg(not(windows))]
#[tauri::command]
pub(crate) async fn desktop_application_update(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("update-action-unavailable".into());
    }
    // Linux slice S3: a previously scheduled verified package may be installed
    // into the running AppImage (verified with the Linux release identity,
    // atomically replaced, then started). Without one, the build stays
    // notice-only: `install` without a scheduled
    // package returns `update-download-required`; `status` reports `disabled`;
    // a deb install returns `update-deb-notice-only` before anything is read.
    // Linux slice S4: the renderer asks which asset this install takes.
    // Anything but a validated AppImage target is a deb (notice-only) install.
    #[cfg(target_os = "linux")]
    if action == "format" {
        return Ok(serde_json::json!({"format": appimage::install_format()}));
    }
    #[cfg(target_os = "linux")]
    if action == "install" {
        use tauri::Manager;
        // A deb install (or an invalid AppImage target) never self-replaces and
        // never consumes a scheduled intent: refuse before touching the store.
        let target = appimage::resolve_target().map_err(|_| "update-deb-notice-only".to_owned())?;
        let app = window.app_handle().clone();
        let store = store::Store::new(
            app.path()
                .app_data_dir()
                .map_err(|_| "update-app-data-unavailable".to_owned())?
                .join("desktop-update"),
        );
        return tauri::async_runtime::spawn_blocking(move || {
            let intent = store
                .take_intent()
                .map_err(|_| "update-action-unavailable".to_owned())?
                .ok_or("update-download-required".to_owned())?;
            let installed = app.package_info().version.to_string();
            intent
                .validate(&installed, &verification::LINUX_PROFILE)
                .map_err(|message| message.to_owned())?;
            let bytes = store.package().map_err(|message| message.to_owned())?;
            let trust: serde_json::Value = serde_json::from_str(include_str!("trust.json"))
                .map_err(|_| "update-trust-invalid".to_owned())?;
            let public_key = trust["publicKey"]
                .as_str()
                .ok_or("update-trust-invalid".to_owned())?;
            appimage::verify(&bytes, &intent.signature, public_key, &intent.version)
                .map_err(|message| message.to_owned())?;
            appimage::replace_target(&bytes, &target).map_err(|message| message.to_owned())?;
            appimage::restart(&target).map_err(|message| message.to_owned())?;
            Ok(
                serde_json::json!({"revision":1,"phase":"installing","version":intent.version,
                "downloadedBytes":bytes.len(),"totalBytes":bytes.len(),"errorCode":null,
                "canCheck":false,"canDownload":false,"canCancel":false,"canInstall":false}),
            )
        })
        .await
        .map_err(|_| "update-action-unavailable".to_owned())?;
    }
    if action != "status" {
        return Err("update-action-unavailable".into());
    }
    Ok(
        serde_json::json!({"revision":0,"phase":"disabled","version":null,"downloadedBytes":0,"totalBytes":null,
        "errorCode":null,"canCheck":false,"canDownload":false,"canCancel":false,"canInstall":false}),
    )
}
