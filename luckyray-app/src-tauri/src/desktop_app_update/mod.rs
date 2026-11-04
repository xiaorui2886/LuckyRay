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
// Linux: the native AppImage pipeline (check/download/verify/schedule/install,
// same state machine as Windows). A deb or invalid AppImage target reports
// `disabled` and stays notice-only.
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub(crate) use linux::{
    __cmd__desktop_application_update, __tauri_command_name_desktop_application_update,
    desktop_application_update, initialize, scheduled_exit_guard_required, report_scheduled_quit_blocked,
};
#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn scheduled_exit_guard_required(_app: &tauri::AppHandle) -> Result<bool, &'static str> { Ok(false) }
#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn report_scheduled_quit_blocked(_app: &tauri::AppHandle, _code: &'static str) {}
#[cfg(not(any(windows, target_os = "linux")))]
#[tauri::command]
pub(crate) async fn desktop_application_update(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" || action != "status" {
        return Err("update-action-unavailable".into());
    }
    Ok(
        serde_json::json!({"revision":0,"phase":"disabled","version":null,"downloadedBytes":0,"totalBytes":null,
        "errorCode":null,"canCheck":false,"canDownload":false,"canCancel":false,"canInstall":false}),
    )
}
