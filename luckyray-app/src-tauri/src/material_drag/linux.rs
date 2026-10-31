//! GTK external file drag for the Linux desktop.
//! URI conversion uses GLib so spaces, Unicode, percent signs and fragments
//! are escaped as file URIs instead of interpolating raw paths.

use gtk::glib::SignalHandlerId;
use gtk::prelude::*;
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

static ACTIVE: AtomicBool = AtomicBool::new(false);

fn file_uris(paths: &[PathBuf]) -> Result<Vec<String>, gtk::glib::Error> {
    paths.iter()
        .map(|path| gtk::glib::filename_to_uri(path, None).map(|value| value.to_string()))
        .collect()
}

fn report_start_failure(app: &tauri::AppHandle, label: &str) {
    ACTIVE.store(false, Ordering::Release);
    let _ = app.emit_to(label, "material-external-drag-failed", "material-external-drag-unavailable");
    let _ = app.emit_to(label, "material-external-drag-ended", ());
}

fn finish(
    window: &gtk::ApplicationWindow,
    handlers: &Rc<RefCell<Vec<SignalHandlerId>>>,
    app: &tauri::AppHandle,
    label: &str,
    failed: bool,
) {
    if !ACTIVE.swap(false, Ordering::AcqRel) {
        return;
    }
    let ids = std::mem::take(&mut *handlers.borrow_mut());
    for id in ids {
        window.disconnect(id);
    }
    window.drag_source_unset();
    if failed {
        let _ = app.emit_to(label, "material-external-drag-failed", "material-external-drag-unavailable");
    }
    let _ = app.emit_to(label, "material-external-drag-ended", ());
}

pub(super) fn begin_file_drag(
    window: tauri::Window,
    paths: Vec<PathBuf>,
    preview_png: Option<String>,
) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 64 {
        return Err("material-external-drag-invalid-selection".to_owned());
    }
    if paths.iter().any(|path| !path.is_absolute() || !path.is_file()) {
        return Err("material-external-drag-file-unavailable".to_owned());
    }
    if ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("material-external-drag-in-progress".to_owned());
    }
    let icon = super::validated_cover(preview_png.as_deref())
        .unwrap_or_else(|| include_bytes!("../../icons/128x128.png").to_vec());
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let drag_window = window.clone();
    let scheduled = window.run_on_main_thread(move || {
        let gtk_window = match drag_window.gtk_window() {
            Ok(value) => value,
            Err(_) => {
                report_start_failure(&app, &label);
                return;
            }
        };
        let Ok(uris) = file_uris(&paths) else {
            report_start_failure(&app, &label);
            return;
        };
        let handlers = Rc::new(RefCell::new(Vec::<SignalHandlerId>::new()));
        gtk_window.drag_source_set(
            gtk::gdk::ModifierType::BUTTON1_MASK,
            &[],
            gtk::gdk::DragAction::COPY,
        );
        gtk_window.drag_source_add_uri_targets();
        handlers.borrow_mut().push(gtk_window.connect_drag_data_get(move |_, _, selection, _, _| {
            let values: Vec<&str> = uris.iter().map(String::as_str).collect();
            selection.set_uris(&values);
        }));
        {
            let callback_handlers = Rc::clone(&handlers);
            let app = app.clone();
            let label = label.clone();
            let id = gtk_window.connect_drag_end(move |widget, _| {
                finish(widget, &callback_handlers, &app, &label, false);
            });
            handlers.borrow_mut().push(id);
        }
        {
            let callback_handlers = Rc::clone(&handlers);
            let app = app.clone();
            let label = label.clone();
            let id = gtk_window.connect_destroy(move |widget| {
                finish(widget, &callback_handlers, &app, &label, false);
            });
            handlers.borrow_mut().push(id);
        }
        let Some(targets) = gtk_window.drag_source_get_target_list() else {
            finish(&gtk_window, &handlers, &app, &label, true);
            return;
        };
        let Some(context) = gtk_window.drag_begin_with_coordinates(
            &targets,
            gtk::gdk::DragAction::COPY,
            1,
            None,
            -1,
            -1,
        ) else {
            finish(&gtk_window, &handlers, &app, &label, true);
            return;
        };
        let loader = gtk::gdk_pixbuf::PixbufLoader::new();
        if loader.write(&icon).is_ok() && loader.close().is_ok() {
            if let Some(pixbuf) = loader.pixbuf() {
                context.drag_set_icon_pixbuf(&pixbuf, 0, 0);
            }
        }
    });
    if scheduled.is_err() {
        ACTIVE.store(false, Ordering::Release);
        return Err("material-external-drag-unavailable".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn glib_encodes_paths_without_changing_the_selected_file() {
        let path = std::path::Path::new("/tmp/中文 space/#%?.png");
        let uri = super::file_uris(&[path.to_owned()]).unwrap().remove(0);
        assert!(uri.contains("%20") && uri.contains("%23") && uri.contains("%25") && uri.contains("%3F"));
        let (decoded, _) = gtk::glib::filename_from_uri(&uri).unwrap();
        assert_eq!(decoded, path);
    }
}
