//! V3 (T50) Linux native player: the same worker, requests, errors and reply
//! shapes as `windows_player.rs`. Differences are only in the surface:
//! a GTK overlay layer fed by mpv's software render API instead of a child HWND,
//! and the WebKit background made transparent instead of WebView2's.
//! Production stays unavailable until V4 pins an LGPL libmpv: `Player::load`
//! refuses with `native-video-runtime-unpinned` before anything is loaded.
use super::{
    linux_mpv::{self, Licensed, Player},
    linux_overlay::{self, Rgba, SharedRef},
    linux_surface::{placement, Placement},
    Bounds, Control, Range, Request,
};
use base64::Engine;
use gtk::prelude::*;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

type Reply = Result<serde_json::Value, String>;
struct Envelope {
    caller: tauri::Webview,
    app: tauri::AppHandle,
    request: Request,
    reply: mpsc::Sender<Reply>,
}
struct Worker {
    sender: mpsc::SyncSender<Envelope>,
    stopped: mpsc::Receiver<()>,
}
static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();
static STOPPING: AtomicBool = AtomicBool::new(false);

/// Same UI marshalling as Windows: run on the WebView's UI thread, 2 s timeout,
/// late results dropped on the UI thread.
fn ui<T: Send + 'static>(
    caller: &tauri::Webview,
    f: impl FnOnce(gtk::Widget) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let pending = cancelled.clone();
    caller
        .with_webview(move |wv| {
            if !pending.load(Ordering::Acquire) {
                let _ = tx.send(f(wv.inner().upcast::<gtk::Widget>()));
            }
        })
        .map_err(|_| "native-video-window-unavailable")?;
    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result,
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            Err("native-video-window-unavailable".into())
        }
    }
}

struct Surface {
    caller: tauri::Webview,
    shared: SharedRef,
    preview: bool,
    background: Option<Rgba>,
}
impl Surface {
    fn create(caller: &tauri::Webview, preview: bool) -> Result<Self, String> {
        let shared: SharedRef = Default::default();
        if preview {
            // Windows' preview surface is never shown; Linux needs no layer.
            return Ok(Self { caller: caller.clone(), shared, preview, background: None });
        }
        let attach = shared.clone();
        let background = ui(caller, move |web| {
            linux_overlay::install(&web)?;
            let original = linux_overlay::background(&web);
            linux_overlay::set_background(&web, Rgba { red: 0., green: 0., blue: 0., alpha: 0. });
            linux_overlay::attach(Some(attach));
            Ok(original)
        })?;
        Ok(Self { caller: caller.clone(), shared, preview, background: Some(background) })
    }
    fn bounds(&self, bounds: Bounds) -> Result<(), String> {
        let b = bounds.validate()?;
        let shared = self.shared.clone();
        ui(&self.caller, move |web| {
            let alloc = web.allocation();
            let rect = match placement(b, alloc.width(), alloc.height())? {
                Placement::Hidden => None,
                Placement::Shown { x, y, width, height } => Some((x, y, width, height)),
            };
            let mut s = shared.lock().map_err(|_| "native-video-window-closed")?;
            if s.rect != rect {
                s.frame = None;
            }
            s.rect = rect;
            drop(s);
            linux_overlay::queue_draw();
            Ok(())
        })
    }
}
impl Drop for Surface {
    fn drop(&mut self) {
        if self.preview {
            return;
        }
        let background = self.background;
        let _ = self.caller.with_webview(move |wv| {
            linux_overlay::attach(None);
            if let Some(rgba) = background {
                linux_overlay::set_background(&wv.inner().upcast::<gtk::Widget>(), rgba);
            }
        });
    }
}

// Field order is drop order: the player (and its render context) is destroyed
// before the surface restores the WebView, like Windows.
struct Active {
    player: Player,
    licensed: Licensed,
    preview: bool,
    surface: Surface,
    session: String,
    catalog: crate::materials::MaterialCatalog,
    asset: String,
    revision: String,
    path: PathBuf,
    _source: std::fs::File,
    range: Option<Range>,
    heartbeat: Instant,
    source_check: Instant,
}
impl Active {
    fn verify(&self) -> Result<(), String> {
        let path = self
            .catalog
            .native_video_source(&self.asset, &self.revision)
            .map_err(crate::encode_material_catalog_command_error)?;
        if path != self.path {
            return Err("native-video-source-changed".into());
        }
        Ok(())
    }
    fn loop_mode(&self) -> Result<(), String> {
        self.player.set_loop(self.range.filter(|r| r.looping).map(|r| (r.start, r.end)))
    }
    fn control(&mut self, c: Control) -> Reply {
        match c {
            Control::Play { range } => {
                let s = self.player.snapshot();
                self.range = range.map(|r| r.validate(s.duration)).transpose()?;
                self.loop_mode()?;
                if let Some(r) = self.range {
                    if s.time < r.start || s.time >= r.end {
                        self.player.seek(r.start)?;
                    }
                } else if s.ended {
                    self.player.seek(0.)?;
                }
                self.player.pause(false)?;
            }
            Control::Pause => self.player.pause(true)?,
            Control::Seek { seconds } => {
                let d = self.player.snapshot().duration;
                if !seconds.is_finite() || seconds < 0. || seconds > d {
                    return Err("native-video-time-invalid".into());
                }
                self.range = None;
                self.loop_mode()?;
                self.player.seek(seconds)?;
            }
            Control::Volume { value, muted } => self.player.volume(value, muted)?,
            Control::Loop { enabled } => {
                if let Some(r) = &mut self.range {
                    r.looping = enabled;
                }
                self.loop_mode()?;
            }
            Control::ClearRange => {
                self.range = None;
                self.loop_mode()?;
            }
        }
        Ok(serde_json::json!({"ok":true}))
    }
    /// Frame pump: render the pending frame at the placed size (preview frames
    /// are consumed so the decoder never stalls) and ask GTK to redraw.
    fn pump(&mut self) -> Result<(), String> {
        let surface = self.player.software_surface(&self.licensed)?;
        if !surface.frame_pending() {
            return Ok(());
        }
        let rect = self.surface.shared.lock().map_err(|_| "native-video-window-closed")?.rect;
        match rect {
            Some((_, _, w, h)) if !self.preview => {
                let pixels = surface.render(w, h)?;
                self.surface.shared.lock().map_err(|_| "native-video-window-closed")?.frame = Some((w, h, pixels));
                linux_overlay::request_redraw();
            }
            _ => {
                surface.render(16, 16)?;
            }
        }
        Ok(())
    }
    fn tick(&mut self) -> Result<(), String> {
        self.pump()?;
        if let Some(r) = self.range.filter(|r| !r.looping) {
            let s = self.player.snapshot();
            if !s.paused && !s.seeking && s.time >= r.end {
                self.player.pause(true)?;
                self.player.seek(r.end)?;
                self.range = None;
            }
        }
        if self.source_check.elapsed() > Duration::from_secs(2) {
            self.verify()?;
            self.source_check = Instant::now();
        }
        Ok(())
    }
}
fn library_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .resource_dir()
        .map_err(|_| "native-video-resources-unavailable")?
        .join(linux_mpv::LIBRARY_RELATIVE))
}
#[allow(clippy::too_many_arguments)]
fn open(
    caller: &tauri::Webview,
    app: &tauri::AppHandle,
    session: String,
    library: String,
    asset: String,
    revision: String,
    bounds: Bounds,
    preview: bool,
) -> Result<Active, String> {
    bounds.validate()?;
    if session.len() != 36 || !session.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("native-video-session-invalid".into());
    }
    let catalog = crate::material_catalog_in_library(app, caller, Some(&library))?;
    let path = catalog
        .native_video_source(&asset, &revision)
        .map_err(crate::encode_material_catalog_command_error)?;
    // Hold the source open (inode identity) for the session; Linux has no
    // deny-write share mode, so the 2 s catalog re-verification is the guard.
    let source = std::fs::File::open(&path).map_err(|_| "native-video-source-unavailable")?;
    catalog
        .native_video_source(&asset, &revision)
        .map_err(crate::encode_material_catalog_command_error)?;
    // Verify and load before touching the UI: an unpinned/unverified runtime
    // never makes the WebView transparent.
    let player = Player::load(&library_path(app)?, linux_mpv::production_pin()?)?;
    let licensed = if preview { player.initialize_render_preview()? } else { player.initialize_render()? };
    player.software_surface(&licensed)?;
    let surface = Surface::create(caller, preview)?;
    player.volume(0.7, preview)?;
    player.open_local(&path)?;
    let mut active = Active {
        player,
        licensed,
        preview,
        surface,
        session,
        catalog,
        asset,
        revision,
        path,
        _source: source,
        range: None,
        heartbeat: Instant::now(),
        source_check: Instant::now(),
    };
    let start = Instant::now();
    while !active.player.snapshot().configured {
        if start.elapsed() > Duration::from_secs(10) {
            return Err("native-video-open-timeout".into());
        }
        active.pump()?;
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(active)
}
fn snapshot_json(s: &linux_mpv::Snapshot) -> serde_json::Value {
    serde_json::json!({"time":s.time,"duration":s.duration,"width":s.width,"height":s.height,"paused":s.paused,"seeking":s.seeking,"ended":s.ended,"configured":s.configured,"avsync":s.avsync,"hwdec":s.hwdec})
}
fn worker(rx: mpsc::Receiver<Envelope>) {
    let mut active: Option<Active> = None;
    loop {
        if STOPPING.load(Ordering::Acquire) {
            break;
        }
        let e = match rx.recv_timeout(Duration::from_millis(8)) {
            Ok(e) => e,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if active.as_mut().is_some_and(|a| {
                    a.heartbeat.elapsed() > Duration::from_secs(15) || a.tick().is_err()
                }) {
                    retire(&mut active);
                }
                continue;
            }
        };
        if let Request::Snapshot { session } = &e.request {
            let result = if let Some(a) = active.as_mut().filter(|a| &a.session == session) {
                a.heartbeat = Instant::now();
                Ok(snapshot_json(&a.player.snapshot()))
            } else {
                Err("native-video-session-closed".into())
            };
            let _ = e.reply.send(result);
            continue;
        }
        let result = (|| match e.request {
            Request::Open { session, library_id, asset_id, revision, bounds, preview } => {
                retire(&mut active);
                active = Some(open(&e.caller, &e.app, session, library_id, asset_id, revision, bounds, preview)?);
                Ok(serde_json::json!({"ok":true}))
            }
            Request::Close { session } => {
                if active.as_ref().is_some_and(|a| a.session == session) {
                    retire(&mut active);
                }
                Ok(serde_json::json!({"ok":true}))
            }
            request => {
                let session = match &request {
                    Request::Control { session, .. }
                    | Request::Bounds { session, .. }
                    | Request::PreviewFrame { session }
                    | Request::Capture { session } => session,
                    _ => return Err("native-video-request-invalid".into()),
                };
                let a = active
                    .as_mut()
                    .filter(|a| &a.session == session)
                    .ok_or("native-video-session-closed")?;
                a.heartbeat = Instant::now();
                match request {
                    Request::Control { action, .. } => a.control(action),
                    Request::Bounds { bounds, .. } => {
                        if a.preview { return Err("native-video-preview-has-no-surface".into()); }
                        a.surface.bounds(bounds)?;
                        Ok(serde_json::json!({"ok":true}))
                    }
                    Request::PreviewFrame { .. } => {
                        if !a.preview { return Err("native-video-preview-required".into()); }
                        let frame = a.player.preview_frame()?;
                        preview_jpeg(frame)
                    }
                    Request::Capture { .. } => {
                        a.verify()?;
                        a.player.pause(true)?;
                        let start = Instant::now();
                        while a.player.snapshot().seeking {
                            if start.elapsed() > Duration::from_secs(3) {
                                return Err("native-video-seek-timeout".into());
                            }
                            a.pump()?;
                            std::thread::sleep(Duration::from_millis(8));
                        }
                        let frame = a.player.capture()?;
                        let reply = capture_png(frame)?;
                        a.verify()?;
                        Ok(reply)
                    }
                    _ => Err("native-video-request-invalid".into()),
                }
            }
        })();
        let _ = e.reply.send(result);
        if let Some(a) = active.as_mut() {
            if a.tick().is_err() {
                retire(&mut active);
            }
        }
    }
    retire(&mut active);
}
/// Windows PreviewFrame reply: `{time, src: data:image/jpeg;base64,...}`.
fn preview_jpeg(frame: linux_mpv::Frame) -> Reply {
    if frame.width > 512 || frame.height > 512 {
        return Err("native-video-preview-size-invalid".into());
    }
    let image = image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba)
        .ok_or("native-video-frame-invalid")?;
    let rgb = image::DynamicImage::ImageRgba8(image).into_rgb8();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 82)
        .encode_image(&rgb)
        .map_err(|_| "native-video-frame-encode-failed")?;
    if jpeg.len() > 1024 * 1024 {
        return Err("native-video-frame-too-large".into());
    }
    Ok(serde_json::json!({"time":frame.time,"src":format!("data:image/jpeg;base64,{}",base64::engine::general_purpose::STANDARD.encode(jpeg))}))
}
/// Windows Capture reply: `{time, png: base64}`.
fn capture_png(frame: linux_mpv::Frame) -> Reply {
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba)
        .ok_or("native-video-frame-invalid")?
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| "native-video-frame-encode-failed")?;
    if png.get_ref().len() > 32 * 1024 * 1024 {
        return Err("native-video-frame-too-large".into());
    }
    Ok(serde_json::json!({"time":frame.time,"png":base64::engine::general_purpose::STANDARD.encode(png.into_inner())}))
}
fn retire(active: &mut Option<Active>) {
    if let Some(old) = active.take() {
        let caller = old.surface.caller.clone();
        drop(old);
        // Drain the UI queue (layer detach + background restore) first.
        let _ = ui(&caller, |_| Ok(()));
    }
}
pub(super) fn request(caller: tauri::Webview, app: tauri::AppHandle, request: Request) -> Reply {
    if STOPPING.load(Ordering::Acquire) {
        return Err("native-video-shutting-down".into());
    }
    if matches!(request, Request::Capability) {
        return Err("native-video-request-invalid".into());
    }
    let tx = {
        let mut slot = WORKER
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "native-video-worker-unavailable")?;
        if STOPPING.load(Ordering::Acquire) {
            return Err("native-video-shutting-down".into());
        }
        if slot.is_none() {
            let (tx, rx) = mpsc::sync_channel(32);
            let (done, stopped) = mpsc::channel();
            std::thread::Builder::new()
                .name("material-native-video".into())
                .spawn(move || {
                    worker(rx);
                    let _ = done.send(());
                })
                .map_err(|_| "native-video-worker-unavailable")?;
            *slot = Some(Worker { sender: tx, stopped });
        }
        slot.as_ref().unwrap().sender.clone()
    };
    let (reply, rx) = mpsc::channel();
    tx.try_send(Envelope { caller, app, request, reply })
        .map_err(|_| "native-video-busy")?;
    rx.recv().map_err(|_| "native-video-worker-closed".to_string())?
}
pub(super) fn shutdown() {
    STOPPING.store(true, Ordering::Release);
    let worker = WORKER.get().and_then(|slot| slot.lock().ok()?.take());
    if let Some(worker) = worker {
        drop(worker.sender);
        if worker.stopped.recv_timeout(Duration::from_secs(15)).is_err() {
            eprintln!("[native-video] shutdown drain deadline reached");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_keep_the_windows_shapes() {
        let frame = linux_mpv::Frame { time: 1.5, width: 4, height: 2, rgba: vec![200; 32] };
        let v = preview_jpeg(frame).expect("jpeg");
        assert_eq!(v["time"], 1.5);
        assert!(v["src"].as_str().unwrap().starts_with("data:image/jpeg;base64,"));
        let big = linux_mpv::Frame { time: 0., width: 513, height: 2, rgba: vec![0; 513 * 2 * 4] };
        assert_eq!(preview_jpeg(big).unwrap_err(), "native-video-preview-size-invalid");
        let bad = linux_mpv::Frame { time: 0., width: 4, height: 2, rgba: vec![0; 3] };
        assert_eq!(preview_jpeg(bad).unwrap_err(), "native-video-frame-invalid");
        let frame = linux_mpv::Frame { time: 2., width: 4, height: 2, rgba: vec![9; 32] };
        let v = capture_png(frame).expect("png");
        let png = base64::engine::general_purpose::STANDARD.decode(v["png"].as_str().unwrap()).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        let s = linux_mpv::Snapshot { time: 1., duration: 2., width: 3, height: 4, paused: true, seeking: false, ended: false, configured: true, avsync: None, hwdec: "no".into() };
        let keys: Vec<_> = snapshot_json(&s).as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["avsync", "configured", "duration", "ended", "height", "hwdec", "paused", "seeking", "time", "width"]);
    }
}
