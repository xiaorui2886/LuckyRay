//! Linux/WebKitGTK focus integration for the embedded LSH child webview.
//! This does not start the host or bypass its runtime admission checks.

use gtk::prelude::*;
use tauri::Emitter;

pub(crate) fn install_focus_dismissal(
    child: &tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), &'static str> {
    child
        .with_webview(move |platform| {
            let native = platform.inner();
            native.connect_has_focus_notify(move |widget| {
                if widget.has_focus() {
                    // This is a fixed UI wake-up; no page data or IPC
                    // authority is sent to the embedded web content.
                    let _ = app.emit_to("main", "luckyray:lsh-content-outside", ());
                }
            });
        })
        .map_err(|_| "dsh-native-surface-unavailable")
}
