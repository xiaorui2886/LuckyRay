//! Nonshipping, offscreen composition proof. Own HWNDs and fresh WebView data only.
//! No user profile, application activation, user input injection or screen capture.
//! PrintWindow targets only the HWND created below, never another application.
use sha2::{Digest, Sha256};
#[path = "../../../src-tauri/src/material_native_video/mpv.rs"]
mod player;
mod production_ui;
use std::{
    ffi::{c_void, CStr, CString},
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};
use webview2_com::{
    CoreWebView2EnvironmentOptions, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, ExecuteScriptCompletedHandler,
    Microsoft::Web::WebView2::Win32::*,
};
use windows::{
    core::*,
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        Storage::Xps::*,
        System::{Com::*, LibraryLoader::*},
        UI::WindowsAndMessaging::*,
    },
};

// Assigned below from the separately verified upstream artifact, not an argument.
const VERIFIED_DLL_SHA: &str = "6938419e82922251619c274c20b33186e70ad2408bb16b30f490433e8c1cbb17";
type Handle = *mut c_void;
type Create = unsafe extern "C" fn() -> Handle;
type SetOption = unsafe extern "C" fn(Handle, *const i8, *const i8) -> i32;
type Init = unsafe extern "C" fn(Handle) -> i32;
type Command = unsafe extern "C" fn(Handle, *const *const i8) -> i32;
type GetString = unsafe extern "C" fn(Handle, *const i8) -> *mut i8;
type Free = unsafe extern "C" fn(*mut c_void);
type Destroy = unsafe extern "C" fn(Handle);

struct Mpv {
    module: HMODULE,
    handle: Handle,
    option: SetOption,
    init: Init,
    command: Command,
    get: GetString,
    free: Free,
    destroy: Destroy,
}
impl Mpv {
    unsafe fn open(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).expect("read exact local proof DLL");
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            VERIFIED_DLL_SHA,
            "unverified proof DLL"
        );
        let module = LoadLibraryExW(
            &HSTRING::from(path.as_os_str()),
            None,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )?;
        macro_rules! symbol {
            ($name:literal, $kind:ty) => {
                std::mem::transmute::<unsafe extern "system" fn() -> isize, $kind>(
                    GetProcAddress(module, PCSTR(concat!($name, "\0").as_ptr())).expect($name),
                )
            };
        }
        let create = symbol!("mpv_create", Create);
        let result = Self {
            module,
            handle: create(),
            option: symbol!("mpv_set_option_string", SetOption),
            init: symbol!("mpv_initialize", Init),
            command: symbol!("mpv_command", Command),
            get: symbol!("mpv_get_property_string", GetString),
            free: symbol!("mpv_free", Free),
            destroy: symbol!("mpv_terminate_destroy", Destroy),
        };
        assert!(!result.handle.is_null());
        Ok(result)
    }
    fn option(&self, key: &str, value: &str) {
        let k = CString::new(key).unwrap();
        let v = CString::new(value).unwrap();
        assert!(
            unsafe { (self.option)(self.handle, k.as_ptr(), v.as_ptr()) } >= 0,
            "option {key}"
        );
    }
    fn command(&self, args: &[&str]) {
        let args: Vec<_> = args.iter().map(|s| CString::new(*s).unwrap()).collect();
        let mut ptrs: Vec<_> = args.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        assert!(
            unsafe { (self.command)(self.handle, ptrs.as_ptr()) } >= 0,
            "mpv command"
        );
    }
    fn get(&self, key: &str) -> String {
        let key = CString::new(key).unwrap();
        unsafe {
            let p = (self.get)(self.handle, key.as_ptr());
            if p.is_null() {
                return String::new();
            }
            let s = CStr::from_ptr(p).to_string_lossy().into_owned();
            (self.free)(p.cast());
            s
        }
    }
}
impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe {
            (self.destroy)(self.handle);
            let _ = FreeLibrary(self.module);
        }
    }
}
struct OwnedWindow(HWND);
impl Drop for OwnedWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}
unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}
fn pump(ms: u64) {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
unsafe fn children(parent: HWND) -> Vec<HWND> {
    let mut out = Vec::new();
    let mut child = GetWindow(parent, GW_CHILD).unwrap_or_default();
    while !child.is_invalid() {
        let mut name = [0u16; 256];
        let n = GetClassNameW(child, &mut name);
        println!(
            "OWN_CHILD {:?} {}",
            child,
            String::from_utf16_lossy(&name[..n as usize])
        );
        out.push(child);
        child = GetWindow(child, GW_HWNDNEXT).unwrap_or_default();
    }
    out
}
fn script(view: &ICoreWebView2, text: &str) -> String {
    let (tx, rx) = mpsc::channel();
    let view = view.clone();
    let text = HSTRING::from(text);
    ExecuteScriptCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| {
            unsafe { view.ExecuteScript(&text, &handler) }
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |hr, result| {
            hr?;
            tx.send(result).unwrap();
            Ok(())
        }),
    )
    .unwrap();
    rx.recv().unwrap()
}
unsafe fn sample(hwnd: HWND) -> Result<([u8; 3], [u8; 3])> {
    sample_at(hwnd, (320, 180), (40, 40))
}
unsafe fn sample_at(
    hwnd: HWND,
    picture: (usize, usize),
    overlay: (usize, usize),
) -> Result<([u8; 3], [u8; 3])> {
    let dc = GetDC(Some(hwnd));
    let mem = CreateCompatibleDC(Some(dc));
    let bitmap = CreateCompatibleBitmap(dc, 640, 360);
    let old = SelectObject(mem, bitmap.into());
    let ok = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(2)).as_bool();
    let mut pixels = vec![0u8; 640 * 360 * 4];
    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = 640;
    info.bmiHeader.biHeight = -360;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;
    SelectObject(mem, old);
    let lines = GetDIBits(
        mem,
        bitmap,
        0,
        360,
        Some(pixels.as_mut_ptr().cast()),
        &mut info,
        DIB_RGB_COLORS,
    );
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteDC(mem);
    ReleaseDC(Some(hwnd), dc);
    assert!(ok && lines == 360, "own fixture PrintWindow failed");
    if let Some(path) = std::env::var_os("LUCKYRAY_OWN_PROOF_BITMAP") {
        let mut bmp = Vec::new();
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(54u32 + pixels.len() as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&640i32.to_le_bytes());
        bmp.extend_from_slice(&(-360i32).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&32u16.to_le_bytes());
        bmp.extend_from_slice(&[0; 24]);
        bmp.extend_from_slice(&pixels);
        std::fs::write(path, bmp).unwrap();
    }
    let pixel = |x: usize, y: usize| {
        let p = (y * 640 + x) * 4;
        [pixels[p + 2], pixels[p + 1], pixels[p]]
    };
    Ok((pixel(picture.0, picture.1), pixel(overlay.0, overlay.1)))
}
fn run() -> Result<()> {
    unsafe {
        let dll = std::env::args_os()
            .nth(1)
            .expect("verified DLL path required");
        let root = std::env::temp_dir().join(format!(
            "luckyray-native-media-proof-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        std::fs::create_dir(&root).expect("new isolated proof directory");
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let class = w!("LuckyRayOwnedMediaCompositionProof");
        let instance: HINSTANCE = GetModuleHandleW(None)?.into();
        assert_ne!(
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: instance,
                lpszClassName: class,
                ..Default::default()
            }),
            0
        );
        let window = OwnedWindow(CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            class,
            w!("offscreen native proof"),
            WS_POPUP | WS_VISIBLE,
            -20000,
            -20000,
            640,
            360,
            None,
            None,
            Some(instance),
            None,
        )?);
        let mpv = Mpv::open(Path::new(&dll))?;
        for (k, v) in [
            ("config", "no"),
            ("load-scripts", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("audio", "no"),
            ("terminal", "no"),
            ("vo", "gpu-next"),
            ("gpu-api", "d3d11"),
            ("hwdec", "auto-safe"),
            ("keep-open", "yes"),
        ] {
            mpv.option(k, v);
        }
        mpv.option("wid", &format!("{}", window.0 .0 as usize));
        assert!((mpv.init)(mpv.handle) >= 0);
        let config = mpv.get("mpv-configuration");
        assert!(
            config.contains("gpl=false"),
            "proof build missing LGPL configuration: {config}"
        );
        println!("MPV_CONFIGURATION {config}");
        mpv.command(&["loadfile", "av://lavfi:color=c=blue:s=640x360:r=30:d=20"]);
        pump(1800);
        println!(
            "NATIVE_ONLY {:?} width={} pos={}",
            sample(window.0)?,
            mpv.get("width"),
            mpv.get("time-pos")
        );
        let before_web = children(window.0);
        let (tx, rx) = mpsc::channel();
        let folder = HSTRING::from(root.as_os_str());
        let options: ICoreWebView2EnvironmentOptions =
            CoreWebView2EnvironmentOptions::default().into();
        options.SetAdditionalBrowserArguments(w!("--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows"))?;
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                CreateCoreWebView2EnvironmentWithOptions(
                    PCWSTR::null(),
                    &folder,
                    &options,
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |hr, env| {
                hr?;
                tx.send(env.unwrap()).unwrap();
                Ok(())
            }),
        )
        .unwrap();
        let env = rx.recv().unwrap();
        let (tx, rx) = mpsc::channel();
        let e = env.clone();
        let hwnd = window.0;
        CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                e.CreateCoreWebView2Controller(hwnd, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |hr, controller| {
                hr?;
                tx.send(controller.unwrap()).unwrap();
                Ok(())
            }),
        )
        .unwrap();
        let controller = rx.recv().unwrap();
        controller.SetBounds(RECT {
            left: 0,
            top: 0,
            right: 640,
            bottom: 360,
        })?;
        let c2: ICoreWebView2Controller2 = controller.cast()?;
        c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
            A: 0,
            R: 0,
            G: 0,
            B: 0,
        })?;
        let webview = controller.CoreWebView2()?;
        let settings = webview.Settings()?;
        settings.SetAreDevToolsEnabled(false)?;
        settings.SetIsStatusBarEnabled(false)?;
        webview.NavigateToString(w!("<!doctype html><meta http-equiv='Content-Security-Policy' content=\"default-src 'none';style-src 'unsafe-inline'\"><style>html,body{margin:0;background:transparent}button{position:absolute;left:16px;top:16px;width:100px;height:70px;border:0;background:#ff0000;color:white}</style><button>Overlay</button>"))?;
        controller.SetIsVisible(true)?;
        pump(1500);
        for child in children(window.0)
            .iter()
            .filter(|child| !before_web.contains(child))
        {
            SetWindowPos(
                *child,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )?;
        }
        pump(400);
        let composed = sample(window.0)?;
        println!(
            "NATIVE_WEBVIEW_COMPOSITION {:?} width={} pos={}",
            composed,
            mpv.get("width"),
            mpv.get("time-pos")
        );
        let blue = composed.0[2] > 180 && composed.0[0] < 60;
        let red = composed.1[0] > 180 && composed.1[2] < 60;
        // Pixel proof, not merely an opaque overlay over a visible video. Compare
        // the SAME rounded translucent CSS over native blue and DOM blue.
        script(&webview, "document.body.insertAdjacentHTML('beforeend', '<div id=alpha-native style=\"position:absolute;left:150px;top:80px;width:100px;height:100px;background:rgba(255,0,0,.5);border-radius:20px\"></div><div id=alpha-dom style=\"position:absolute;left:350px;top:80px;width:100px;height:100px;background:blue\"><div style=\"width:100%;height:100%;background:rgba(255,0,0,.5);border-radius:20px\"></div></div>');true");
        pump(400);
        let mut antialiased = 0;
        for (dx,dy) in [(50,50),(0,0),(1,12),(2,10),(3,8),(4,7),(5,6),(6,5),(7,4),(8,3),(10,2),(12,1)] {
            let (native,dom) = sample_at(window.0,(150+dx,80+dy),(350+dx,80+dy))?;
            println!("ALPHA_PIXEL offset={dx},{dy} native={native:?} dom={dom:?}");
            assert!(native.iter().zip(dom).all(|(a,b)| a.abs_diff(b) <= 4), "native alpha differs from DOM compositor");
            if native[0] > 4 && native[0] < 120 { antialiased += 1; }
        }
        assert!(antialiased > 0, "rounded edge has no fractional coverage");
        println!("TRUE_ALPHA_ROUNDED_EDGE_PASS edgeSamples={antialiased}");
        script(&webview,"document.getElementById('alpha-native').remove();document.getElementById('alpha-dom').remove();true");
        assert_eq!(
            script(
                &webview,
                "document.querySelector('button').focus(); document.activeElement.tagName"
            ),
            "\"BUTTON\""
        );
        assert_eq!(script(&webview,"document.body.addEventListener('keydown',e=>{if(e.key===' '){e.preventDefault();window.spaceHandled=true}});document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));window.spaceHandled"),"true");
        assert_eq!(
            script(
                &webview,
                "document.querySelector('button').style.display='none';'closed'"
            ),
            "\"closed\""
        );
        pump(150);
        assert!(
            sample(window.0)?.1[2] > 180,
            "closed overlay reveals native video"
        );
        SetWindowPos(
            window.0,
            None,
            0,
            0,
            960,
            540,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOZORDER,
        )?;
        controller.SetBounds(RECT {
            left: 0,
            top: 0,
            right: 960,
            bottom: 540,
        })?;
        script(
            &webview,
            "document.querySelector('button').style.display='block';window.innerWidth",
        );
        pump(250);
        assert!(
            sample(window.0)?.1[0] > 180,
            "overlay survives native viewport resize"
        );
        println!("OWN_WEBVIEW_DOM_FOCUS_SPACE_AND_VIEWPORT_RESIZE_PASS (synthetic DOM event; not user keyboard/fullscreen UAT)");
        mpv.command(&["set", "pause", "yes"]);
        pump(100);
        let paused = mpv.get("time-pos");
        pump(150);
        assert_eq!(mpv.get("time-pos"), paused);
        let mpv_children = before_web;
        controller.Close()?;
        drop(webview);
        drop(controller);
        drop(env);
        drop(mpv);
        pump(300);
        assert!(
            mpv_children
                .iter()
                .all(|hwnd| !IsWindow(Some(*hwnd)).as_bool()),
            "native child survives mpv destroy"
        );
        assert!(
            GetModuleHandleW(w!("libmpv-2.dll")).is_err(),
            "native DLL still loaded"
        );
        println!("COMPOSITION_PIXELS_PASS={} nativeBlue={} overlayRed={} nativeAndWebviewClosed=true profile=synthetic-only",blue&&red,blue,red);
        if !blue || !red {
            return Err(Error::new(E_FAIL, "native/webview composition unproven"));
        }
        let files: Vec<_> = std::env::args_os().skip(2).collect();
        assert!(files.len() <= 4, "bounded proof only");
        for (index, file) in files.iter().enumerate() {
            let source_hash =
                Sha256::digest(std::fs::read(file).expect("source read before proof"));
            let player = player::Player::load(Path::new(&dll)).expect("verified native runtime");
            player
                .initialize(window.0 .0 as usize, true)
                .expect("native initialization");
            player.open_local(Path::new(file)).expect("local source");
            let deadline = Instant::now() + Duration::from_secs(10);
            while !player.snapshot().configured {
                assert!(Instant::now() < deadline, "native video readiness timeout");
                pump(25);
            }
            player.volume(0.7, true).unwrap();
            player.seek(2.).unwrap();
            pump(350);
            let first = player
                .capture()
                .expect("first exact native displayed frame");
            let first_hash = format!("{:x}", Sha256::digest(&first.rgba));
            player.pause(false).unwrap();
            let start = player.snapshot().time;
            let mut max_av = 0f64;
            let mut av_samples = 0;
            for _ in 0..20 {
                pump(50);
                if let Some(v) = player.snapshot().avsync {
                    max_av = max_av.max(v.abs());
                    av_samples += 1;
                }
            }
            assert!(
                player.snapshot().time > start + 0.5,
                "video playback did not progress"
            );
            player.pause(true).unwrap();
            pump(100);
            let stable = player.snapshot().time;
            pump(100);
            assert_eq!(stable, player.snapshot().time, "pause failed");
            player.seek(4.).unwrap();
            pump(350);
            let second = player
                .capture()
                .expect("second exact native displayed frame");
            assert_ne!(
                first_hash,
                format!("{:x}", Sha256::digest(&second.rgba)),
                "different timestamps returned one frozen frame"
            );
            player.set_loop(Some((1., 1.6))).unwrap();
            player.seek(1.).unwrap();
            pump(200);
            player.pause(false).unwrap();
            let mut returns = 0;
            let mut previous = 0.;
            for _ in 0..32 {
                pump(50);
                let state = player.snapshot();
                if state.time + 0.15 < previous {
                    returns += 1;
                }
                previous = state.time;
                assert!(state.time < 1.85, "native loop escaped selected range");
            }
            assert!(returns >= 1, "native A/B loop did not return");
            player.pause(true).unwrap();
            player.set_loop(None).unwrap();
            player.seek(3.).unwrap();
            pump(250);
            player.pause(false).unwrap();
            pump(350);
            assert!(
                player.snapshot().time > 3.1,
                "loop release retained old range"
            );
            player.pause(true).unwrap();
            let final_state = player.snapshot();
            assert_eq!(
                source_hash,
                Sha256::digest(std::fs::read(file).expect("source read after proof")),
                "original source changed"
            );
            println!("NATIVE_PLAYER_FILE_PASS index={index} frame={}x{} firstTime={} secondTime={} decodedFramesDiffer=true playbackPauseSeek=true loopReturns={returns} loopRelease=true avSamples={av_samples} maxAbsAvSync={max_av:.6} hwdec={} duration={} finalSize={}x{} eof={} sourceUnmodified=true",first.width,first.height,first.time,second.time,final_state.hwdec,final_state.duration,final_state.width,final_state.height,final_state.ended);
            drop(player);
            pump(150);
            assert!(
                GetModuleHandleW(w!("libmpv-2.dll")).is_err(),
                "native DLL still loaded after player close"
            );
        }
        Ok(())
    }
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--runtime-load-benchmark") {
        let dll = std::env::args_os().nth(2).expect("exact local DLL");
        for round in 0..3 {
            let start = Instant::now();
            let p = player::Player::load(Path::new(&dll)).expect("verified player");
            let loaded = start.elapsed();
            drop(p);
            println!("RUNTIME_LOAD round={round} loadMs={} withDestroyMs={}", loaded.as_millis(), start.elapsed().as_millis());
            assert!(unsafe { GetModuleHandleW(w!("libmpv-2.dll")) }.is_err());
        }
        assert!(std::fs::OpenOptions::new().write(true).open(&dll).is_err(), "cached verification must retain a no-write pin");
        let temp = std::env::temp_dir().join(format!("luckyray-runtime-negative-{}",std::process::id()));
        std::fs::create_dir(&temp).unwrap();
        let fake = temp.join("libmpv-2.dll");
        let f = std::fs::File::create(&fake).unwrap();
        f.set_len(player::DLL_SIZE).unwrap();drop(f);
        assert!(matches!(player::Player::load(&fake),Err(e) if e=="native-video-runtime-hash-invalid"), "a different same-size file must never reuse verification");
        std::fs::remove_file(&fake).unwrap();std::fs::remove_dir(&temp).unwrap();
        println!("RUNTIME_PIN_PASS writesDenied=true sameSizeDifferentFileRejected=true DLLUnloadedBetweenPlayers=true");
        return;
    }
    if matches!(std::env::args().nth(1).as_deref(), Some("--production-ui" | "--scrub-ui" | "--hover-ui")) {
        if let Err(e) = production_ui::run() {
            eprintln!("PRODUCTION_UI_PROOF_FAILED {e}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(e) = run() {
        eprintln!("NATIVE_MEDIA_PROOF_FAILED {e}");
        std::process::exit(1);
    }
}
