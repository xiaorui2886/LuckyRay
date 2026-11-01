//! Linux/WebKitGTK placement and focus for the admitted LSH child webview.
//! Tauri's GTK Box packs sibling webviews vertically and ignores set_bounds;
//! a native overlay keeps Main full-size and positions the child explicitly.

use gtk::prelude::*;
use tauri::Emitter;

pub(crate) fn install_focus_dismissal(
    child: &tauri::Webview,
    app: tauri::AppHandle,
    position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>,
) -> Result<(), &'static str> {
    dispatch(child, move |native| {
            let parent = native.parent().and_then(|widget| widget.downcast::<gtk::Box>().ok())
                .ok_or("dsh-native-surface-unavailable")?;
            let overlay = match parent.children().into_iter().find_map(|widget| {
                widget.downcast::<gtk::Overlay>().ok().filter(|overlay| overlay.widget_name() == OVERLAY_NAME)
            }) {
                Some(overlay) => overlay,
                None => {
                    let mut main = parent.children().into_iter()
                        .filter(|widget| widget != &native && widget.type_() == native.type_());
                    let main = main.next().filter(|_| main.next().is_none())
                        .ok_or("dsh-native-surface-unavailable")?;
                    let overlay = gtk::Overlay::new();
                    overlay.set_widget_name(OVERLAY_NAME);
                    parent.remove(&main);
                    overlay.add(&main);
                    parent.pack_start(&overlay, true, true, 0);
                    overlay
                }
            };
            parent.remove(&native);
            overlay.add_overlay(&native);
            overlay.set_overlay_pass_through(&native, false);
            place(&native, position, size)?;
            native.connect_has_focus_notify(move |widget| {
                if widget.has_focus() {
                    // This is a fixed UI wake-up; no page data or IPC
                    // authority is sent to the embedded web content.
                    let _ = app.emit_to("main", "luckyray:lsh-content-outside", ());
                }
            });
            overlay.show_all();
            Ok(())
        })
}

const OVERLAY_NAME: &str = "luckyray-lsh-native-overlay";

// Call from a command's blocking worker. A queued GTK mutation is not yet an
// acknowledgement; hold the lifecycle operation until Main returns its result.
fn dispatch(child: &tauri::Webview,
    action: impl FnOnce(gtk::Widget) -> Result<(), &'static str> + Send + 'static,
) -> Result<(), &'static str> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    use std::sync::atomic::{AtomicU8, Ordering};
    let phase = std::sync::Arc::new(AtomicU8::new(0));
    let scheduled = phase.clone();
    child.with_webview(move |platform| {
        if scheduled.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            let _ = send.send(action(platform.inner().upcast::<gtk::Widget>()));
        }
    }).map_err(|_| "dsh-native-surface-unavailable")?;
    match receive.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(result) => result,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            if phase.compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                Err("dsh-native-surface-unavailable")
            } else {
                receive.recv().map_err(|_| "dsh-native-surface-unavailable")?
            }
        }
        Err(_) => Err("dsh-native-surface-unavailable"),
    }
}

fn place(native: &gtk::Widget, position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>) -> Result<(), &'static str> {
    let values = [position.x, position.y, size.width, size.height];
    if values.iter().any(|value| !value.is_finite() || *value < 0.0 || *value > i32::MAX as f64)
        || size.width < 1.0 || size.height < 1.0 { return Err("dsh-native-surface-bounds-invalid"); }
    native.set_halign(gtk::Align::Start);
    native.set_valign(gtk::Align::Start);
    native.set_margin_start(position.x.round() as i32);
    native.set_margin_top(position.y.round() as i32);
    native.set_size_request(size.width.round() as i32, size.height.round() as i32);
    Ok(())
}

pub(crate) fn set_bounds(child: &tauri::Webview, position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>) -> Result<(), &'static str> {
    dispatch(child, move |native| {
        let overlay = native.parent().and_then(|widget| widget.downcast::<gtk::Overlay>().ok())
            .filter(|overlay| overlay.widget_name() == OVERLAY_NAME)
            .ok_or("dsh-native-surface-unavailable")?;
        let _ = overlay;
        place(&native, position, size)
    })
}
