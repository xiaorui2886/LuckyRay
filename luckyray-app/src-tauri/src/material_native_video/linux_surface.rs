//! V3 (T49) Linux surface geometry: the pure twin of Windows `bounds()` +
//! `surface_region::position`. The GTK overlay (see T49 design) applies the
//! result; this module decides it, so both platforms answer identically.
use super::Bounds;

#[derive(Debug, PartialEq, Eq)]
pub enum Placement {
    /// Windows: `ShowWindow(SW_HIDE)` when the card is fully outside the client area.
    Hidden,
    /// Full card geometry (the parent clips it; video is never rescaled).
    Shown { x: i32, y: i32, width: i32, height: i32 },
}

pub fn placement(bounds: Bounds, client_width: i32, client_height: i32) -> Result<Placement, String> {
    let b = bounds.validate()?;
    if b.x >= client_width || b.y >= client_height || b.x + b.width <= 0 || b.y + b.height <= 0 {
        return Ok(Placement::Hidden);
    }
    // Windows refuses punched-out regions: controls are composited by the
    // alpha WebView above the picture, never cut out of the video.
    if !b.exclude.is_empty() {
        return Err("native-video-composition-requires-alpha-ui".into());
    }
    Ok(Placement::Shown { x: b.x, y: b.y, width: b.width, height: b.height })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::material_native_video::Exclusion;
    fn b(x: i32, y: i32, w: i32, h: i32) -> Bounds {
        Bounds { x, y, width: w, height: h, exclude: vec![] }
    }
    #[test]
    fn placement_matches_the_windows_surface_rules() {
        assert_eq!(placement(b(10, 20, 300, 200), 800, 600), Ok(Placement::Shown { x: 10, y: 20, width: 300, height: 200 }));
        // Partly scrolled out keeps the full geometry.
        assert_eq!(placement(b(-50, -10, 300, 200), 800, 600), Ok(Placement::Shown { x: -50, y: -10, width: 300, height: 200 }));
        for off in [b(800, 0, 10, 10), b(0, 600, 10, 10), b(-10, 0, 10, 10), b(0, -10, 10, 10)] {
            assert_eq!(placement(off, 800, 600), Ok(Placement::Hidden));
        }
        assert_eq!(placement(b(0, 0, 0, 10), 800, 600).unwrap_err(), "native-video-bounds-invalid");
        let mut cut = b(0, 0, 100, 100);
        cut.exclude.push(Exclusion { x: 0, y: 0, width: 10, height: 10 });
        assert_eq!(placement(cut, 800, 600).unwrap_err(), "native-video-composition-requires-alpha-ui");
        let mut bad = b(0, 0, 100, 100);
        bad.exclude.push(Exclusion { x: 95, y: 0, width: 10, height: 10 });
        assert_eq!(placement(bad, 800, 600).unwrap_err(), "native-video-region-invalid");
    }
}
