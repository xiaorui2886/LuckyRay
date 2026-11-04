//! V3 (T50) GTK video layer: a `GtkOverlay` whose base child is a
//! `GtkDrawingArea` and whose overlay child is the WebKitWebView, the Linux twin
//! of the Windows child HWND placed below the alpha WebView. UI thread only.
//! The layer draws nothing unless a player has attached a frame, so the window
//! looks unchanged while no player is open.
use gtk::{cairo, glib, prelude::*};
use std::{cell::RefCell, sync::{Arc, Mutex}};

pub const OVERLAY_NAME: &str = "luckyray-native-video-overlay";

/// Written by the worker, read by the draw handler.
#[derive(Default)]
pub struct Shared {
    /// Windows-equivalent placement in WebView client pixels; `None` = hidden.
    pub rect: Option<(i32, i32, i32, i32)>,
    /// `bgr0` (cairo RGB24 on little endian), tightly packed, at `rect` size.
    pub frame: Option<(i32, i32, Vec<u8>)>,
}
pub type SharedRef = Arc<Mutex<Shared>>;

struct Layer {
    area: gtk::DrawingArea,
    current: std::rc::Rc<RefCell<Option<SharedRef>>>,
}
thread_local! {
    static LAYER: RefCell<Option<Layer>> = const { RefCell::new(None) };
}

fn draw(current: &RefCell<Option<SharedRef>>, cr: &cairo::Context) {
    let Some(shared) = current.borrow().clone() else { return };
    let Ok(state) = shared.lock() else { return };
    let (Some((x, y, w, h)), Some((fw, fh, pixels))) = (state.rect, state.frame.as_ref()) else { return };
    if (*fw, *fh) != (w, h) || pixels.len() != (w as usize) * (h as usize) * 4 {
        return;
    }
    let Ok(surface) = cairo::ImageSurface::create_for_data(pixels.clone(), cairo::Format::Rgb24, w, h, w * 4) else {
        return;
    };
    if cr.set_source_surface(&surface, f64::from(x), f64::from(y)).is_ok() {
        cr.rectangle(f64::from(x), f64::from(y), f64::from(w), f64::from(h));
        let _ = cr.fill();
    }
}

/// Install the layer once below `web` (idempotent). `web`'s parent must be a
/// `GtkBox` (wry's layout) or our own overlay.
pub fn install(web: &gtk::Widget) -> Result<(), String> {
    if LAYER.with(|l| l.borrow().is_some()) {
        let ours = web.parent().is_some_and(|p| p.widget_name() == OVERLAY_NAME);
        return if ours { Ok(()) } else { Err("native-video-composition-unavailable".into()) };
    }
    let parent = web
        .parent()
        .and_then(|p| p.downcast::<gtk::Box>().ok())
        .ok_or("native-video-composition-unavailable")?;
    let position = parent
        .children()
        .iter()
        .position(|c| c == web)
        .ok_or("native-video-composition-unavailable")? as i32;
    let (expand, fill, padding, pack) = parent.query_child_packing(web);
    let overlay = gtk::Overlay::new();
    overlay.set_widget_name(OVERLAY_NAME);
    let area = gtk::DrawingArea::new();
    // No event mask: input always lands on the WebView (= WS_DISABLED child).
    area.set_can_focus(false);
    let current: std::rc::Rc<RefCell<Option<SharedRef>>> = Default::default();
    let reader = current.clone();
    area.connect_draw(move |_, cr| {
        draw(&reader, cr);
        glib::Propagation::Proceed
    });
    let keep = web.clone();
    parent.remove(&keep);
    overlay.add(&area);
    overlay.add_overlay(&keep);
    overlay.set_overlay_pass_through(&keep, false);
    parent.pack_start(&overlay, expand, fill, padding);
    parent.set_child_packing(&overlay, expand, fill, padding, pack);
    parent.reorder_child(&overlay, position);
    overlay.show_all();
    LAYER.with(|l| *l.borrow_mut() = Some(Layer { area, current }));
    Ok(())
}

/// Attach (Some) or detach (None) the active player's frame state.
pub fn attach(shared: Option<SharedRef>) {
    LAYER.with(|l| {
        if let Some(layer) = l.borrow().as_ref() {
            *layer.current.borrow_mut() = shared;
            layer.area.queue_draw();
        }
    });
}

pub fn queue_draw() {
    LAYER.with(|l| {
        if let Some(layer) = l.borrow().as_ref() {
            layer.area.queue_draw();
        }
    });
}

/// Ask the UI thread to redraw; callable from the worker.
pub fn request_redraw() {
    glib::MainContext::default().invoke(queue_draw);
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub red: f64,
    pub green: f64,
    pub blue: f64,
    pub alpha: f64,
}
extern "C" {
    fn webkit_web_view_get_background_color(view: *mut gtk::ffi::GtkWidget, rgba: *mut Rgba);
    fn webkit_web_view_set_background_color(view: *mut gtk::ffi::GtkWidget, rgba: *const Rgba);
}
/// `web` MUST be a WebKitWebView (the caller passes `PlatformWebview::inner`).
pub fn background(web: &gtk::Widget) -> Rgba {
    use glib::translate::ToGlibPtr;
    let mut rgba = Rgba { red: 1., green: 1., blue: 1., alpha: 1. };
    unsafe { webkit_web_view_get_background_color(web.to_glib_none().0, &mut rgba) };
    rgba
}
pub fn set_background(web: &gtk::Widget, rgba: Rgba) {
    use glib::translate::ToGlibPtr;
    unsafe { webkit_web_view_set_background_color(web.to_glib_none().0, &rgba) };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real GTK under an X server (CI: Xvfb). A Label stands in for the
    /// WebView so no web process is needed; the layer, packing, z-order and
    /// draw path are the production code.
    #[test]
    #[ignore]
    fn live_gtk_layer_draws_frames_below_the_web_widget_and_nothing_when_detached() {
        gtk::init().expect("gtk under an X server");
        let window = gtk::OffscreenWindow::new();
        let vbox = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let menu = gtk::Label::new(Some("menu"));
        let web = gtk::Label::new(None);
        vbox.pack_start(&menu, false, false, 0);
        vbox.pack_start(&web, true, true, 0);
        window.add(&vbox);
        window.set_default_size(120, 100);
        window.show_all();
        let web: gtk::Widget = web.upcast();
        install(&web).expect("install");
        install(&web).expect("idempotent");
        let overlay = web.parent().expect("parent");
        assert_eq!(overlay.widget_name(), OVERLAY_NAME);
        assert_eq!(vbox.children().iter().position(|c| *c == overlay), Some(1), "keeps the original slot");
        let overlay: gtk::Overlay = overlay.downcast().expect("overlay");
        assert_eq!(overlay.children().len(), 2, "drawing area + web widget");
        assert!(!overlay.is_overlay_pass_through(&web), "input stays on the web widget");
        let shared: SharedRef = Default::default();
        let (w, h) = (20, 10);
        let mut px = Vec::new();
        for _ in 0..w * h {
            px.extend_from_slice(&[0, 0, 255, 0]); // bgr0 red
        }
        {
            let mut s = shared.lock().unwrap();
            s.rect = Some((30, 20, w, h));
            s.frame = Some((w, h, px));
        }
        attach(Some(shared.clone()));
        let sample = |x: i32, y: i32| {
            // Let the frame clock run the queued redraw.
            let until = std::time::Instant::now() + std::time::Duration::from_millis(300);
            while std::time::Instant::now() < until {
                while gtk::events_pending() {
                    gtk::main_iteration();
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let pixbuf = window.pixbuf().expect("pixbuf");
            let alloc = overlay.allocation();
            let (x, y) = (alloc.x() + x, alloc.y() + y);
            let bytes = pixbuf.read_pixel_bytes();
            let at = (y * pixbuf.rowstride() + x * pixbuf.n_channels()) as usize;
            (bytes[at], bytes[at + 1], bytes[at + 2])
        };
        assert_eq!(sample(35, 25), (255, 0, 0), "frame drawn at its rect");
        assert_ne!(sample(5, 5), (255, 0, 0), "nothing outside the rect");
        shared.lock().unwrap().rect = None;
        queue_draw();
        assert_ne!(sample(35, 25), (255, 0, 0), "hidden placement draws nothing");
        shared.lock().unwrap().rect = Some((30, 20, w, h));
        attach(None);
        assert_ne!(sample(35, 25), (255, 0, 0), "detached player draws nothing");
    }
}
