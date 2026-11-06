//! Decode/seek/reopen proof using the production libmpv wrapper and owned HWNDs.
//! This is NOT acceptance of the material-library or canvas UI.
#[path = "../../../../src-tauri/src/material_native_video/mpv.rs"]
mod mpv;
use std::{path::Path, time::{Duration, Instant}};
use sha2::{Digest, Sha256};
use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
fn wait_for(mut check: impl FnMut() -> bool) {
    let start = Instant::now();
    while !check() {
        assert!(start.elapsed() < Duration::from_secs(15), "decoder condition timed out");
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(args.len() >= 3);
    for (index, name) in args[2..].iter().enumerate() {
        // FFmpeg frame hashes independently confirm that the reviewed R3 WebM
        // fixture is 25 identical blue frames without audio (RGBA 0,0,254,255).
        // Keep motion mandatory for the real H3/H.264 samples; this explicit
        // fixture mode checks its independently decoded content and playback time.
        let static_blue = name.starts_with("silent-static-blue::");
        let (name, expected_audio) = name.strip_prefix("silent-static-blue::")
            .or_else(|| name.strip_prefix("silent::"))
            .map_or((name.as_str(), true), |path| (path, false));
        let source = Path::new(name);
        let before = Sha256::digest(std::fs::read(source).unwrap());
        for preview in [false, true] {
            unsafe {
                let host = CreateWindowExW(WS_EX_NOACTIVATE, w!("STATIC"), None, WS_POPUP,
                    -20000, -20000, 640, 360, None, None, None, None).unwrap();
                let player = mpv::Player::load(Path::new(&args[1])).unwrap();
                if preview { player.initialize_preview(host.0 as usize).unwrap(); }
                else { player.initialize(host.0 as usize, false).unwrap(); player.volume(0.2, false).unwrap(); }
                player.open_local(source).unwrap();
                wait_for(|| player.snapshot().configured && player.snapshot().duration > 0.);
                let duration = player.snapshot().duration;
                player.pause(false).unwrap();
                wait_for(|| player.snapshot().time > 0.15);
                let mut frames = std::collections::HashSet::new();
                for _ in 0..10 {
                    let frame = player.preview_frame().unwrap();
                    assert!(frame.width > 0 && frame.height > 0);
                    if static_blue {
                        // Production card previews intentionally scale to 512px.
                        let edge = if preview { 512 } else { 64 };
                        assert_eq!((frame.width, frame.height), (edge, edge));
                        assert!(frame.rgba.chunks_exact(4).all(|p| p[0] < 20 && p[1] < 20 && p[2] > 200 && p[3] == 255), "known WebM blue fixture must decode as blue, not black");
                    }
                    frames.insert(format!("{:x}", Sha256::digest(&frame.rgba)));
                    std::thread::sleep(Duration::from_millis(60));
                }
                if static_blue { assert_eq!(frames.len(), 1, "reviewed static fixture must remain static"); }
                else { assert!(frames.len() > 1, "video frames must change"); }
                let audio_output = player.property("current-ao");
                let audio_rate = player.property("audio-out-params/samplerate");
                if !preview && expected_audio {
                    assert_eq!(audio_output, "wasapi", "real Windows audio output required");
                    assert!(audio_rate.parse::<u32>().unwrap_or(0) > 0, "decoded audio required");
                    assert_eq!(player.property("mute"), "no");
                }
                player.pause(true).unwrap();
                player.seek(duration * 0.5).unwrap();
                wait_for(|| !player.snapshot().seeking && (player.snapshot().time - duration * 0.5).abs() < 0.2);
                player.capture().unwrap();
                let codec = player.property("video-codec");
                let hwdec = player.snapshot().hwdec;
                player.open_local(source).unwrap();
                wait_for(|| player.snapshot().configured && player.snapshot().time < 0.1);
                player.pause(false).unwrap();
                wait_for(|| player.snapshot().time > 0.15);
                drop(player);
                DestroyWindow(host).unwrap();
                assert_eq!(before, Sha256::digest(std::fs::read(source).unwrap()));
                println!("{}", serde_json::json!({"sample":index,"mode":if preview {"card-preview"}else{"native-view"},"codec":codec,"hwdec":hwdec,"duration":duration,"distinctFrames":frames.len(),"expectedStaticBlue":static_blue,"expectedAudio":expected_audio,"audioOutput":audio_output,"audioSampleRate":audio_rate,"seek":true,"reopen":true,"sourceUnchanged":true,"uiAcceptance":false,"audibleConfirmation":false}));
            }
        }
    }
}
