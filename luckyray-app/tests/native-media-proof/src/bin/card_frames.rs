//! Own hidden HWND only; no user screen, profile or input.
#[path = "../../../../src-tauri/src/material_native_video/mpv.rs"]
mod mpv;
use std::{path::Path, time::{Instant, Duration}};
use sha2::{Digest, Sha256};
use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let source = Path::new(&args[2]);
    let before = Sha256::digest(std::fs::read(source).unwrap());
    unsafe {
        let host = CreateWindowExW(WS_EX_NOACTIVATE, w!("STATIC"), None, WS_POPUP,
            -20000, -20000, 1, 1, None, None, None, None).unwrap();
        let player = mpv::Player::load(Path::new(&args[1])).unwrap();
        player.initialize_preview(host.0 as usize).unwrap();
        player.open_local(source).unwrap();
        let start = Instant::now();
        while !player.snapshot().configured {
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(10));
        }
        player.pause(false).unwrap();
        let mut hashes = std::collections::HashSet::new();
        let mut elapsed = Vec::new();
        for i in 0..45 {
            if i == 15 { player.seek(40.).unwrap(); }
            let t = Instant::now();
            let frame = player.preview_frame().unwrap();
            elapsed.push(t.elapsed().as_millis());
            assert!(frame.width <= 512 && frame.height <= 512, "frame {}x{}, state {:?}",frame.width,frame.height,player.snapshot());
            hashes.insert(format!("{:x}", Sha256::digest(&frame.rgba)));
            assert!(!player.snapshot().paused, "frame transfer must not pause decoder");
            std::thread::sleep(Duration::from_millis(67));
        }
        assert!(hashes.len() > 3);
        drop(player); DestroyWindow(host).unwrap();
        assert_eq!(before, Sha256::digest(std::fs::read(source).unwrap()));
        println!("CARD_FRAMES_PASS frames=45 distinct={} max_read_ms={} mean_read_ms={} source_unchanged=true", hashes.len(), elapsed.iter().max().unwrap(),elapsed.iter().sum::<u128>()/45);
    }
}
