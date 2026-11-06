//! Own offscreen window + production React UI. No existing app/profile/input.
use super::*;
use serde_json::{json, Value};
use base64::Engine;
#[path = "../../../src-tauri/src/material_native_video/surface_region.rs"]
mod surface_region;

struct Bridge {
    player: Option<player::Player>,
    session: String,
    surface: OwnedWindow,
    dll: std::path::PathBuf,
    source: std::path::PathBuf,
}
impl Bridge {
    unsafe fn request(&mut self, command: &str, r: &Value) -> std::result::Result<Value, String> {
        if command == "material_video_preview_command" {
            return Ok(
                json!({"width":640,"height":360,"duration":8,"sourceRevision":"owned-revision"}),
            );
        }
        if command == "material_library_command" {
            return Ok(json!({"sourceRevision":"owned-revision","marks":[]}));
        }
        match r["op"].as_str().unwrap_or("") {
            "capability" => return Ok(json!({"available":true,"composition":"webview-alpha-v1","cardFrames":true})),
            "open" => {
                self.player = None;
                self.session = r["session"].as_str().unwrap().to_owned();
                let p = player::Player::load(&self.dll)?;
                if r["preview"] == true { p.initialize_preview(self.surface.0 .0 as usize)?; }
                else { p.initialize(self.surface.0 .0 as usize, true)?; }
                p.open_local(&self.source)?;
                let deadline = Instant::now() + Duration::from_secs(8);
                while !p.snapshot().configured {
                    if Instant::now() > deadline {
                        return Err("native open timeout".into());
                    }
                    pump(15);
                }
                self.player = Some(p);
                return Ok(json!({"ok":true}));
            }
            "close" => {
                if r["session"] == self.session {
                    self.player = None;
                    let _ = ShowWindow(self.surface.0, SW_HIDE);
                }
                return Ok(json!({"ok":true}));
            }
            _ => {}
        }
        let p = self.player.as_ref().ok_or("session closed")?;
        if r["session"] != self.session {
            return Err("wrong session".into());
        }
        match r["op"].as_str().unwrap_or("") {
            "previewFrame" => {
                let frame = p.preview_frame()?;
                assert!(frame.width <= 512 && frame.height <= 512);
                let rgb = image::DynamicImage::ImageRgba8(image::RgbaImage::from_raw(frame.width,frame.height,frame.rgba).unwrap()).into_rgb8();
                let mut jpeg=Vec::new();
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg,82).encode_image(&rgb).unwrap();
                return Ok(json!({"time":frame.time,"src":format!("data:image/jpeg;base64,{}",base64::engine::general_purpose::STANDARD.encode(jpeg))}));
            }
            "snapshot" => {
                let s = p.snapshot();
                return Ok(
                    json!({"time":s.time,"duration":s.duration,"width":s.width,"height":s.height,"paused":s.paused,"seeking":s.seeking,"ended":s.ended,"configured":s.configured}),
                );
            }
            "bounds" => {
                let b = &r["bounds"];
                let exclude: Vec<_> = b["exclude"]
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .map(|r| {
                                (
                                    r["x"].as_i64().unwrap() as i32,
                                    r["y"].as_i64().unwrap() as i32,
                                    r["width"].as_i64().unwrap() as i32,
                                    r["height"].as_i64().unwrap() as i32,
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                surface_region::position(
                    self.surface.0,
                    b["x"].as_i64().unwrap() as i32,
                    b["y"].as_i64().unwrap() as i32,
                    b["width"].as_i64().unwrap() as i32,
                    b["height"].as_i64().unwrap() as i32,
                    &exclude,
                )
                .map_err(|e| e.to_string())?;
            }
            "control" => {
                let a = &r["action"];
                match a["op"].as_str().unwrap_or("") {
                    "pause" => p.pause(true)?,
                    "play" => p.pause(false)?,
                    "seek" => p.seek(a["seconds"].as_f64().unwrap())?,
                    "volume" => p.volume(a["value"].as_f64().unwrap(), true)?, // this proof is always muted
                    "clearRange" => p.set_loop(None)?,
                    _ => return Err("unsupported proof control".into()),
                }
            }
            _ => return Err("unsupported proof request".into()),
        }
        Ok(json!({"ok":true}))
    }
    unsafe fn tick(&mut self, view: &ICoreWebView2) {
        pump(20);
        let batch = script(view, "window.nativePending?.splice(0) ?? []");
        let requests: Vec<Value> = serde_json::from_str(&batch).expect("own UI bridge array");
        for item in requests {
            let reply = self.request(item["command"].as_str().unwrap(), &item["request"]);
            let (result, error) = match reply {
                Ok(v) => (v, Value::Null),
                Err(e) => { eprintln!("PROOF_IPC_ERROR {}: {e}", item["request"]); (Value::Null, json!(e)) },
            };
            script(
                view,
                &format!("window.nativeReply({},{},{})", item["id"], result, error),
            );
        }
    }
}
pub fn run() -> Result<()> {
    unsafe {
        let args: Vec<_> = std::env::args_os().skip(2).collect();
        assert_eq!(args.len(), 3, "DLL HTML synthetic video");
        let source = std::fs::canonicalize(&args[2]).unwrap();
        let before = Sha256::digest(std::fs::read(&source).unwrap());
        let data = std::env::temp_dir().join(format!(
            "luckyray-production-ui-proof-{}",
            std::process::id()
        ));
        assert!(!data.exists());
        std::fs::create_dir(&data).unwrap();
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let instance: HINSTANCE = GetModuleHandleW(None)?.into();
        let class = w!("LuckyRayProductionUiProof");
        RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance,
            lpszClassName: class,
            ..Default::default()
        });
        let window = OwnedWindow(CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            class,
            w!("owned production UI proof"),
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
        let surface = OwnedWindow(CreateWindowExW(
            WS_EX_NOACTIVATE,
            w!("STATIC"),
            None,
            WS_CHILD | WS_DISABLED | WS_CLIPCHILDREN | WINDOW_STYLE(0x4),
            0,
            0,
            1,
            1,
            Some(window.0),
            None,
            None,
            None,
        )?);
        let (tx, rx) = mpsc::channel();
        let folder = HSTRING::from(data.as_os_str());
        let options: ICoreWebView2EnvironmentOptions =
            CoreWebView2EnvironmentOptions::default().into();
        options.SetAdditionalBrowserArguments(w!("--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows"))?;
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |h| {
                CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &folder, &options, &h)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |hr, e| {
                hr?;
                tx.send(e.unwrap()).unwrap();
                Ok(())
            }),
        )
        .unwrap();
        let env = rx.recv().unwrap();
        let (tx, rx) = mpsc::channel();
        let parent = window.0;
        CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |h| {
                env.CreateCoreWebView2Controller(parent, &h)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |hr, c| {
                hr?;
                tx.send(c.unwrap()).unwrap();
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
        controller
            .cast::<ICoreWebView2Controller2>()?
            .SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 0,
                R: 0,
                G: 0,
                B: 0,
            })?;
        let view = controller.CoreWebView2()?;
        let html = std::fs::canonicalize(&args[1]).unwrap();
        let folder = HSTRING::from(html.parent().unwrap().as_os_str());
        view.cast::<ICoreWebView2_3>()?
            .SetVirtualHostNameToFolderMapping(
                w!("native-proof.invalid"),
                &folder,
                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS,
            )?;
        view.Navigate(w!("https://native-proof.invalid/ui.html"))?;
        controller.SetIsVisible(true)?;
        let mut bridge = Bridge {
            player: None,
            session: String::new(),
            surface,
            dll: args[0].clone().into(),
            source,
        };
        let scrub_only = std::env::args().nth(1).as_deref() == Some("--scrub-ui");
        let hover_only = std::env::args().nth(1).as_deref() == Some("--hover-ui");
        let loaded_deadline = Instant::now() + Duration::from_secs(8);
        while script(&view, "typeof window.showFilm === 'function'") != "true" {
            bridge.tick(&view);
            assert!(Instant::now() < loaded_deadline, "test document did not load");
        }
        for mode in if hover_only { vec!["hover"] } else if scrub_only { vec!["film"] } else { vec!["ordinary", "film"] } {
            if mode == "hover" { script(&view, "window.showHover()"); }
            if mode == "film" {
                script(&view, "window.showFilm()");
            }
            let deadline = Instant::now() + Duration::from_secs(12);
            loop {
                bridge.tick(&view);
                let ready = script(
                    &view,
                    if mode == "hover" {
                        "Boolean(window.hoverReady)"
                    } else if mode == "ordinary" {
                        "Boolean(document.querySelector('.native-video-inline.ready'))"
                    } else {
                        "Boolean(document.querySelector('.material-film-native'))"
                    },
                );
                if ready == "true" {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "production {mode} failed to mount: {}",
                    script(&view, "document.body.innerText")
                );
            }
            for _ in 0..8 {
                bridge.tick(&view);
            }
            if scrub_only {
                // Synthetic events target only our own offscreen test document;
                // native input, user focus, Main and profiles are untouched.
                script(&view, "(()=>{const e=document.querySelector('.material-film-seek');e.setPointerCapture=()=>{};e.releasePointerCapture=()=>{};window.dragTo=(kind,f)=>{const r=e.getBoundingClientRect();e.dispatchEvent(new PointerEvent(kind,{bubbles:true,pointerId:17,button:0,clientX:r.x+r.width*f,clientY:r.y+r.height/2}))};window.dragTo('pointerdown',.2)})()");
                for batch in 0..12 {
                    script(&view, "for(let i=0;i<50;i++)window.dragTo('pointermove',i%2?.8:.2)");
                    for _ in 0..3 { bridge.tick(&view); }
                    assert!(!script(&view, "document.body.innerText").contains("queue-full"), "scrub batch {batch} overflow");
                }
                script(&view, "window.dragTo('pointerup',.5)");
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    bridge.tick(&view);
                    let s = bridge.player.as_ref().unwrap().snapshot();
                    if !s.seeking && (s.time - s.duration * 0.5).abs() < 0.15 { break; }
                    assert!(Instant::now() < deadline, "final scrub position did not settle: {s:?}");
                }
                for paused in [false, true, false, true] {
                    script(&view, "document.querySelector('.material-film-seek').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))");
                    let deadline = Instant::now() + Duration::from_secs(4);
                    loop {
                        bridge.tick(&view);
                        let actual = bridge.player.as_ref().unwrap().snapshot().paused;
                        let label = if paused { "播放" } else { "暂停" };
                        if actual == paused && script(&view, &format!("Boolean(document.querySelector('button[aria-label=\"{label}\"]'))")) == "true" { break; }
                        assert!(Instant::now() < deadline, "play button disagrees with decoder after Space");
                    }
                }
                assert!(!script(&view, "document.body.innerText").contains("session-closed"));
                println!("NATIVE_SCRUB_UI_PASS moves=600 finalPosition=halfDuration spaceToggles=4 stateMatchesDecoder=true ownOffscreenOnly=true actor=engineeringBridge");
                continue;
            }
            bridge.player.as_ref().unwrap().pause(true).unwrap();
            bridge.player.as_ref().unwrap().seek(2.).unwrap();
            for _ in 0..12 {
                bridge.tick(&view);
            }
            // Sample inside the actual production viewport, not the host-window
            // center (ordinary preview leaves a footer and can be letterboxed).
            let points:Vec<usize>=serde_json::from_str(&script(&view,"(()=>{const r=document.querySelector('.native-video-inline-picture,.material-film-native,.native-video-hover').getBoundingClientRect();const x=Math.round(r.x+r.width*.5),y=Math.round(r.y+r.height*.35),ox=Math.round(r.x+12),oy=Math.round(r.y+12);Object.assign(document.querySelector('.proof-overlay').style,{left:ox+'px',top:oy+'px',width:'24px',height:'24px'});return [x,y,ox+8,oy+8]})()" )).unwrap();
            for _ in 0..5 {
                bridge.tick(&view);
            }
            let pixels = sample_at(
                window.0,
                (points[0], points[1]),
                (points[2] - 6, points[3] - 6),
            )?;
            let picture = pixels.0.iter().any(|v| *v > 45);
            let overlay = pixels.1[0] > 160 && pixels.1[1] < 80 && pixels.1[2] < 80;
            assert!(
                picture && overlay,
                "production {mode} composition pixels {pixels:?}"
            );
            println!("PRODUCTION_{mode}_COMPOSITION_PASS nativePicture=true overlayAboveVideo=true pixels={pixels:?} ownOffscreenWindow=true originalProfile=false nativeIpc=engineeringBridge");
            // A visible frame + opaque red control was insufficient evidence in
            // the old proof. Measure alpha blending and fractional rounded-edge
            // coverage over the SAME paused native frame in the production UI.
            let ax = points[0].saturating_sub(12);
            let ay = points[1].saturating_sub(12);
            script(&view, &format!("(()=>{{const b=document.querySelector('.proof-overlay');b.dataset.saved=b.style.cssText;b.textContent='';Object.assign(b.style,{{display:'none',left:'{ax}px',top:'{ay}px',width:'24px',height:'24px',padding:'0',borderRadius:'10px',background:'rgba(255,0,0,.5)'}})}})()"));
            pump(100);
            let offsets = [(12,12),(0,0),(0,7),(1,5),(2,4),(3,3),(4,2),(5,1),(7,0)];
            let mut baseline = Vec::new();
            for (dx,dy) in offsets { baseline.push(sample_at(window.0,(ax+dx,ay+dy),(ax+dx,ay+dy))?.0); }
            script(&view,"document.querySelector('.proof-overlay').style.display='block';true");
            pump(180);
            let mut edge_samples = 0;
            for (i,(dx,dy)) in offsets.iter().enumerate() {
                let actual=sample_at(window.0,(ax+dx,ay+dy),(ax+dx,ay+dy))?.0;
                let base=baseline[i];
                println!("PRODUCTION_ALPHA_PIXEL mode={mode} offset={dx},{dy} base={base:?} actual={actual:?}");
                if i==0 {
                    let expected=[128+base[0]/2,base[1]/2,base[2]/2];
                    assert!(actual.iter().zip(expected).all(|(a,b)|a.abs_diff(b)<=4),"{mode} transparent center actual={actual:?} expected={expected:?}");
                } else if i==1 {
                    assert!(actual.iter().zip(base).all(|(a,b)|a.abs_diff(b)<=4),"{mode} corner has a solid cutout");
                } else {
                    let alpha = if base[1]>30 {1.-f64::from(actual[1])/f64::from(base[1])}
                        else if base[2]>30 {1.-f64::from(actual[2])/f64::from(base[2])}
                        else {(f64::from(actual[0])-f64::from(base[0]))/(255.-f64::from(base[0]))};
                    if alpha>0.02 && alpha<0.48 { edge_samples+=1; }
                }
            }
            assert!(edge_samples>=2,"{mode} rounded native overlay lacks fractional antialias coverage");
            println!("PRODUCTION_{mode}_TRUE_ALPHA_PASS roundedEdgeSamples={edge_samples} transparentCenterMeasured=true noBlackCorner=true");
            script(&view,"(()=>{const b=document.querySelector('.proof-overlay');b.style.cssText=b.dataset.saved})()");
            if mode == "hover" {
                // Resume after this proof's pixel-sampling pause (not a UI action).
                bridge.player.as_ref().unwrap().pause(false).unwrap();
                script(&view, "window.showHover(.6,1)");
                let deadline = Instant::now() + Duration::from_secs(6);
                loop {
                    bridge.tick(&view);
                    let s=bridge.player.as_ref().unwrap().snapshot();
                    if !s.paused && !s.seeking && s.time>=4.8 { break; }
                    assert!(Instant::now()<deadline,"hover seek did not resume playback");
                }
                script(&view, "window.dispatchEvent(new Event('luckyray:material-viewer-opening'))");
                for _ in 0..12 { bridge.tick(&view); }
                assert!(bridge.player.is_none(),"hover decoder survived viewer opening");
                println!("NATIVE_HOVER_UI_PASS realDecode=true seekAndPlay=true decoderReleasedBeforeViewer=true ownOffscreenOnly=true");
                continue;
            }
            // Real native presentation under repeated production layout changes.
            // No global root masking, even while sibling WebView repaints.
            for step in 0..12 {
                script(
                    &view,
                    if mode == "film" {
                        "document.querySelector('[aria-label=\"切换时间线样式\"]').click(); document.body.style.setProperty('--proof-churn',String(Math.random())); true"
                    } else {
                        "document.querySelector('.material-viewer-react').style.height=(parseInt(document.querySelector('.material-viewer-react').style.height||'300')===300?'320px':'300px'); true"
                    },
                );
                for _ in 0..5 {
                    bridge.tick(&view);
                }
                assert_eq!(
                    script(&view, "document.getElementById('root').style.clipPath"),
                    "\"\"",
                    "app root clipped during churn"
                );
                let point:Vec<usize>=serde_json::from_str(&script(&view,"(()=>{const r=document.querySelector('.native-video-inline-picture,.material-film-stage').getBoundingClientRect();return [Math.round(r.x+r.width*.5),Math.round(r.y+r.height*.4)]})()" )).unwrap();
                let pixel = sample_at(window.0, (point[0], point[1]), (point[0], point[1]))?.0;
                assert!(
                    pixel.iter().any(|c| *c > 45),
                    "{mode} frame lost at resize {step}: {pixel:?}"
                );
            }
            println!("PRODUCTION_{mode}_CHURN_PASS cycles=12 nativePictureRetained=true appRootUnclipped=true");
        }
        script(&view, "window.closeViewer()");
        for _ in 0..12 {
            bridge.tick(&view);
        }
        assert!(
            bridge.player.is_none(),
            "production unmount did not close native session"
        );
        assert!(
            GetModuleHandleW(w!("libmpv-2.dll")).is_err(),
            "native library leaked"
        );
        assert_eq!(
            before,
            Sha256::digest(std::fs::read(&bridge.source).unwrap())
        );
        assert_eq!(script(&view,"document.getElementById('root').style.backgroundImage"),"\"\"","root background not restored");
        assert_eq!(script(&view,"document.querySelector('.materials-layout').style.opacity"),"\"\"","retained library remained hidden");
        controller.Close()?;
        println!(
            "PRODUCTION_UI_CLEANUP_PASS sessionClosed=true dllUnloaded=true sourceUnmodified=true"
        );
        Ok(())
    }
}
