use super::{mpv::Player, Bounds, Control, Range, Request};
use base64::Engine;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Controller2, COREWEBVIEW2_COLOR};
use windows::{
    core::{w, Interface},
    Win32::{
        Foundation::{HWND, RECT},
        UI::WindowsAndMessaging::*,
    },
};

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

// UI-owned HWND; all create/move/destroy work is dispatched to its WebView thread.
// Player is dropped BEFORE Surface, so its child is gone before the parent.
struct Surface {
    caller: tauri::Webview,
    hwnd: usize,
    background: COREWEBVIEW2_COLOR,
}
fn ui<T: Send + 'static>(
    caller: &tauri::Webview,
    f: impl FnOnce(tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let pending = cancelled.clone();
    // Resource-producing closures return RAII values: a late result is dropped
    // on the UI thread if the receiver timed out, never leaving an orphan HWND.
    caller
        .with_webview(move |wv| {
            if !pending.load(Ordering::Acquire) {
                let _ = tx.send(f(wv));
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
impl Surface {
    fn create(caller: &tauri::Webview, preview: bool) -> Result<Self, String> {
        let parent = caller
            .window()
            .hwnd()
            .map_err(|_| "native-video-parent-unavailable")?
            .0 as usize;
        let owner = caller.clone();
        ui(caller, move |wv| unsafe {
            let controller: ICoreWebView2Controller2 = wv.controller().cast()
                .map_err(|_| "native-video-composition-unavailable")?;
            let mut background = COREWEBVIEW2_COLOR::default();
            controller.DefaultBackgroundColor(&mut background)
                .map_err(|_| "native-video-composition-unavailable")?;
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE,
                w!("STATIC"),
                None,
                // The WebView is ABOVE this surface. WS_CLIPSIBLINGS would
                // prevent D3D painting beneath that transparent sibling.
                WS_CHILD | WS_DISABLED | WS_CLIPCHILDREN | WINDOW_STYLE(0x4),
                0,
                0,
                1,
                1,
                Some(HWND(parent as _)),
                None,
                None,
                None,
            )
            .map_err(|_| "native-video-surface-create-failed")?;
            if !preview && controller.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 }).is_err() {
                let _ = DestroyWindow(hwnd);
                return Err("native-video-composition-unavailable".into());
            }
            let surface = Self { caller: owner, hwnd: hwnd.0 as usize, background };
            SetWindowPos(
                hwnd,
                Some(HWND_BOTTOM),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            ).map_err(|_| "native-video-composition-unavailable")?;
            Ok(surface)
        })
    }
    fn bounds(&self, bounds: Bounds) -> Result<(), String> {
        let b = bounds.validate()?;
        let handle = self.hwnd;
        ui(&self.caller, move |_| unsafe {
            let hwnd = HWND(handle as _);
            let parent = GetParent(hwnd).map_err(|_| "native-video-window-closed")?;
            let mut rect = RECT::default();
            GetClientRect(parent, &mut rect).map_err(|_| "native-video-window-closed")?;
            if b.x >= rect.right || b.y >= rect.bottom || b.x + b.width <= 0 || b.y + b.height <= 0 {
                let _ = ShowWindow(hwnd, SW_HIDE);
                return Ok(());
            }
            let exclude: Vec<_> = b
                .exclude
                .iter()
                .map(|r| (r.x, r.y, r.width, r.height))
                .collect();
            super::surface_region::position(hwnd, b.x, b.y, b.width, b.height, &exclude)
        })
    }
}
impl Drop for Surface {
    fn drop(&mut self) {
        let hwnd = self.hwnd;
        let background = self.background;
        let _ = self.caller.with_webview(move |wv| unsafe {
            let _ = DestroyWindow(HWND(hwnd as _));
            if let Ok(controller) = wv.controller().cast::<ICoreWebView2Controller2>() {
                let _ = controller.SetDefaultBackgroundColor(background);
            }
        });
    }
}
struct Active {
    player: Player,
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
        self.player
            .set_loop(self.range.filter(|r| r.looping).map(|r| (r.start, r.end)))
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
    fn tick(&mut self) -> Result<(), String> {
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
fn dll_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .resource_dir()
        .map_err(|_| "native-video-resources-unavailable")?
        .join("native-video/libmpv-2.dll"))
}
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
    // Keep source identity stable during playback, without changing its contents.
    use std::os::windows::fs::OpenOptionsExt;
    let source = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .map_err(|_| "native-video-source-unavailable")?;
    catalog
        .native_video_source(&asset, &revision)
        .map_err(crate::encode_material_catalog_command_error)?;
    let surface = Surface::create(caller, preview)?;
    let player = Player::load(&dll_path(app)?)?;
    if preview { player.initialize_preview(surface.hwnd)?; }
    else { player.initialize(surface.hwnd, false)?; }
    player.volume(0.7, preview)?;
    player.open_local(&path)?;
    let start = Instant::now();
    while !player.snapshot().configured {
        if start.elapsed() > Duration::from_secs(10) {
            return Err("native-video-open-timeout".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Frontend submits the clipped viewport after mounting its opaque controls.
    Ok(Active {
        player,
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
    })
}
fn execute(active: &mut Option<Active>, e: &Envelope) -> Reply {
    // Deserialized request is moved below; this helper only answers snapshots.
    let s = active
        .as_ref()
        .ok_or("native-video-session-closed")?
        .player
        .snapshot();
    let _ = e;
    Ok(
        serde_json::json!({"time":s.time,"duration":s.duration,"width":s.width,"height":s.height,"paused":s.paused,"seeking":s.seeking,"ended":s.ended,"configured":s.configured,"avsync":s.avsync,"hwdec":s.hwdec}),
    )
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
                execute(&mut active, &e)
            } else {
                Err("native-video-session-closed".into())
            };
            let _ = e.reply.send(result);
            continue;
        }
        let result = (|| match e.request {
            Request::Open {
                session,
                library_id,
                asset_id,
                revision,
                bounds,
                preview,
            } => {
                retire(&mut active);
                active = Some(open(
                    &e.caller, &e.app, session, library_id, asset_id, revision, bounds, preview,
                )?);
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
                        // Size-limited on-demand frame; never pauses or writes media.
                        let frame = a.player.preview_frame()?;
                        if frame.width > 512 || frame.height > 512 {
                            return Err("native-video-preview-size-invalid".into());
                        }
                        let image = image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba)
                            .ok_or("native-video-frame-invalid")?;
                        let rgb = image::DynamicImage::ImageRgba8(image).into_rgb8();
                        let mut jpeg = Vec::new();
                        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 82)
                            .encode_image(&rgb).map_err(|_| "native-video-frame-encode-failed")?;
                        if jpeg.len() > 1024 * 1024 { return Err("native-video-frame-too-large".into()); }
                        Ok(serde_json::json!({"time":frame.time,"src":format!("data:image/jpeg;base64,{}",base64::engine::general_purpose::STANDARD.encode(jpeg))}))
                    }
                    Request::Capture { .. } => {
                        a.verify()?;
                        a.player.pause(true)?;
                        let start = Instant::now();
                        while a.player.snapshot().seeking {
                            if start.elapsed() > Duration::from_secs(3) {
                                return Err("native-video-seek-timeout".into());
                            }
                            std::thread::sleep(Duration::from_millis(8));
                        }
                        let frame = a.player.capture()?;
                        let mut png = std::io::Cursor::new(Vec::new());
                        image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba)
                            .ok_or("native-video-frame-invalid")?
                            .write_to(&mut png, image::ImageFormat::Png)
                            .map_err(|_| "native-video-frame-encode-failed")?;
                        if png.get_ref().len() > 32 * 1024 * 1024 {
                            return Err("native-video-frame-too-large".into());
                        }
                        a.verify()?;
                        Ok(
                            serde_json::json!({"time":frame.time,"png":base64::engine::general_purpose::STANDARD.encode(png.into_inner())}),
                        )
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
fn retire(active: &mut Option<Active>) {
    if let Some(old) = active.take() {
        let caller = old.surface.caller.clone();
        drop(old);
        // Surface::drop queued HWND destruction. Drain
        // that UI queue before opening another player or acknowledging shutdown.
        let _ = ui(&caller, |_| Ok(()));
    }
}
pub(super) fn request(caller: tauri::Webview, app: tauri::AppHandle, request: Request) -> Reply {
    if STOPPING.load(Ordering::Acquire) {
        return Err("native-video-shutting-down".into());
    }
    if matches!(request, Request::Capability) {
        return Ok(serde_json::json!({"available":dll_path(&app)?.is_file(),"composition":"webview-alpha-v1","cardFrames":true}));
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
            *slot = Some(Worker {
                sender: tx,
                stopped,
            });
        }
        slot.as_ref().unwrap().sender.clone()
    };
    let (reply, rx) = mpsc::channel();
    tx.try_send(Envelope {
        caller,
        app,
        request,
        reply,
    })
    .map_err(|_| "native-video-busy")?;
    rx.recv()
        .map_err(|_| "native-video-worker-closed".to_string())?
}
pub(super) fn shutdown() {
    STOPPING.store(true, Ordering::Release);
    let worker = WORKER.get().and_then(|slot| slot.lock().ok()?.take());
    if let Some(worker) = worker {
        drop(worker.sender);
        if worker
            .stopped
            .recv_timeout(Duration::from_secs(15))
            .is_err()
        {
            eprintln!("[native-video] shutdown drain deadline reached");
        }
    }
}
