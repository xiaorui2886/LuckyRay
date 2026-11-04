//! T51 live check (CI only) of the reproducible LGPL Linux media bundle built
//! by `luckyray-app/tools/linux-media-bundle/build.sh`. Deliberately outside the
//! `material_native_video::linux_` test filter of the media-player step: it only
//! runs in the media-lgpl-bundle step, against the downloaded CI artifact, with
//! the production pin compiled in from the bundle manifest (`bundle.py pins`).
//! There is no test-only override here: the token comes from `initialize_render`.
use super::linux_mpv::{self, Player, LIBRARY_RELATIVE};
use std::path::PathBuf;

fn live_env(name: &str) -> PathBuf {
    let value = PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")));
    assert!(value.is_absolute(), "{name} must be absolute");
    value
}

#[test]
#[ignore = "needs LUCKYRAY_LIVE_LGPL_BUNDLE, LUCKYRAY_LIVE_LGPL_CLIP and the bundle's compile-time pin"]
fn live_lgpl_bundle_libmpv_passes_the_real_license_gate_and_renders() {
    let _native = super::native_media_test_lock();
    let bundle = live_env("LUCKYRAY_LIVE_LGPL_BUNDLE");
    let clip = live_env("LUCKYRAY_LIVE_LGPL_CLIP");
    let pin = linux_mpv::production_pin().expect("the bundle pin must be compiled in");
    // The production capability check: pin + verified load + headless gate.
    linux_mpv::verify_bundled(&bundle).expect("bundled LGPL libmpv verifies like production");
    let player = Player::load(&bundle.join(LIBRARY_RELATIVE), pin).expect("verified load");
    let licensed = player.initialize_render().expect("the real -Dgpl=false gate must pass");
    assert!(player.property("mpv-configuration").contains("-Dgpl=false"));
    assert!(player.property("mpv-version").starts_with("mpv "));
    let surface = player.software_surface(&licensed).expect("software surface");
    player.open_local(&clip).expect("open synthetic clip");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut lit = 0usize;
    while std::time::Instant::now() < deadline && lit == 0 {
        if surface.frame_pending() {
            let frame = surface.render(64, 48).expect("render");
            lit = frame.chunks(4).filter(|p| p[0] | p[1] | p[2] != 0).count();
        } else {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    assert!(lit > 64 * 48 / 4, "a real testsrc frame must light most pixels, got {lit}");
}
