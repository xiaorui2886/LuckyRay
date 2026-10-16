//! Native picture BELOW the alpha-composited WebView. Only viewport clipping;
//! never punch controls out of video. Shared with the real offscreen proof.
use windows::Win32::{Foundation::HWND, Graphics::Gdi::*, UI::WindowsAndMessaging::*};

pub unsafe fn position(
    hwnd: HWND,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    exclude: &[(i32, i32, i32, i32)],
) -> Result<(), String> {
    let region = CreateRectRgn(0, 0, width, height);
    if region.is_invalid() {
        return Err("native-video-region-create-failed".into());
    }
    if !exclude.is_empty() {
        let _ = DeleteObject(region.into());
        return Err("native-video-composition-requires-alpha-ui".into());
    }
    // Successful SetWindowRgn transfers ownership to Windows.
    if SetWindowRgn(hwnd, Some(region), true) == 0 {
        let _ = DeleteObject(region.into());
        return Err("native-video-region-set-failed".into());
    }
    SetWindowPos(
        hwnd,
        Some(HWND_BOTTOM),
        x,
        y,
        width,
        height,
        SWP_NOACTIVATE | SWP_SHOWWINDOW,
    )
    .map_err(|_| "native-video-resize-failed".into())
}
