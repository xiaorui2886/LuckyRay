//! A permanent, initially hidden WS_CHILD host inside Main. Tauri 2.11.2
//! cannot create its direct child WebviewBuilder hidden. A bare native child
//! window supplies the hidden ancestor without reparenting or another browser.
//! Compiled only for the explicitly enabled Windows preview feature.

use tauri::Manager;
use windows::Win32::Foundation::{POINT, RECT};
use windows::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClientRect, GetTopWindow, GetWindowLongW, IsWindowVisible,
    SetWindowPos, GA_PARENT, GWL_STYLE, HWND_TOP, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, WS_CHILD, WS_VISIBLE,
};

pub(super) const LABEL: &str = "dsh-native-surface-container";
const FAILURE: &str = "dsh-native-surface-container-unavailable";

fn on_main<T: Send + 'static>(
    main: &tauri::Window,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    super::run_dsh_native_surface_on_main(main, FAILURE, action)
}

fn validate_parent(main: &tauri::Window, container: &tauri::Window) -> Result<(), String> {
    if main.label() != "main" || container.label() != LABEL {
        return Err("main-surface-untrusted-caller".to_owned());
    }
    let main_hwnd = main.hwnd().map_err(|_| FAILURE.to_owned())?;
    let hwnd = container.hwnd().map_err(|_| FAILURE.to_owned())?;
    // GA_PARENT distinguishes a real child from an owned top-level window.
    let correct = unsafe {
        GetAncestor(hwnd, GA_PARENT) == main_hwnd
            && (GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CHILD.0) != 0
    };
    if correct { Ok(()) } else { Err(FAILURE.to_owned()) }
}

fn verify_hidden(container: &tauri::Window) -> Result<(), String> {
    let hwnd = container.hwnd().map_err(|_| FAILURE.to_owned())?;
    // Check the own bit as well: a hidden Main alone must not mask an armed
    // child that could unexpectedly appear when Main is restored.
    let hidden = unsafe {
        (GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_VISIBLE.0) == 0
            && !IsWindowVisible(hwnd).as_bool()
    };
    if hidden { Ok(()) } else { Err(FAILURE.to_owned()) }
}

fn layout(
    main: &tauri::Window,
    container: &tauri::Window,
    webview: Option<&tauri::Webview>,
    position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>,
) -> Result<tauri::PhysicalSize<u32>, String> {
    validate_parent(main, container)?;
    let scale = main.scale_factor().map_err(|_| FAILURE.to_owned())?;
    let viewport = main.inner_size().map_err(|_| FAILURE.to_owned())?.to_logical(scale);
    let (position, size) = super::checked_surface_bounds(super::DshNativeSurfaceBounds {
        x: position.x, y: position.y, width: size.width, height: size.height,
    }, viewport)?;
    // Use Main's current DPI, not whichever monitor Tao chose while creating
    // the hidden child at (0,0). Child positions are Main-client relative.
    let physical_position = position.to_physical::<i32>(scale);
    let physical_size = size.to_physical::<u32>(scale);
    container.set_position(physical_position).map_err(|_| FAILURE.to_owned())?;
    container.set_size(physical_size).map_err(|_| FAILURE.to_owned())?;
    if let Some(webview) = webview {
        if webview.window().label() != LABEL { return Err(FAILURE.to_owned()); }
        webview.set_bounds(tauri::Rect {
            position: tauri::PhysicalPosition::new(0, 0).into(),
            size: physical_size.into(),
        }).map_err(|_| FAILURE.to_owned())?;
        // The setter acknowledges dispatch, not WRY's native result. Read
        // the actual child HWND bounds back on this same UI-thread turn.
        let child_position = webview.position().map_err(|_| FAILURE.to_owned())?;
        let child_size = webview.size().map_err(|_| FAILURE.to_owned())?;
        if child_position.x.abs() > 1 || child_position.y.abs() > 1
            || (i64::from(child_size.width) - i64::from(physical_size.width)).abs() > 1
            || (i64::from(child_size.height) - i64::from(physical_size.height)).abs() > 1
        {
            return Err(FAILURE.to_owned());
        }
    }
    // Read back native geometry on the owning UI thread. outer_position()
    // would be screen-relative and is unsuitable for this child comparison.
    let hwnd = container.hwnd().map_err(|_| FAILURE.to_owned())?;
    let main_hwnd = main.hwnd().map_err(|_| FAILURE.to_owned())?;
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        GetClientRect(hwnd, &mut rect).map_err(|_| FAILURE.to_owned())?;
        if !ClientToScreen(hwnd, &mut origin).as_bool()
            || !ScreenToClient(main_hwnd, &mut origin).as_bool()
            || (origin.x - physical_position.x).abs() > 1
            || (origin.y - physical_position.y).abs() > 1
            || (rect.right - rect.left - physical_size.width as i32).abs() > 1
            || (rect.bottom - rect.top - physical_size.height as i32).abs() > 1
        {
            return Err(FAILURE.to_owned());
        }
    }
    Ok(physical_size)
}

pub(super) fn create_hidden(
    main: &tauri::Window,
    builder: tauri::webview::WebviewBuilder<tauri::Wry>,
    position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>,
) -> Result<(), String> {
    if main.label() != "main" { return Err("main-surface-untrusted-caller".to_owned()); }
    let container = if let Some(existing) = main.app_handle().get_window(LABEL) {
        existing
    } else {
        // parent_raw is WS_CHILD. parent()/owner() would make a top-level.
        tauri::window::WindowBuilder::new(main.app_handle(), LABEL)
            .parent_raw(main.hwnd().map_err(|_| FAILURE.to_owned())?)
            .visible(false)
            .focused(false)
            .decorations(false)
            // An undecorated WS_CHILD still gets WS_SIZEBOX when resizable.
            // Keep its client origin exactly at the validated mount origin.
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .shadow(false)
            .skip_taskbar(true)
            .position(0.0, 0.0)
            .inner_size(size.width, size.height)
            .build().map_err(|_| FAILURE.to_owned())?
    };
    let main_owned = main.clone();
    let container_owned = container.clone();
    let physical_size = on_main(main, move || {
        validate_parent(&main_owned, &container_owned)?;
        container_owned.hide().map_err(|_| FAILURE.to_owned())?;
        verify_hidden(&container_owned)?;
        layout(&main_owned, &container_owned, None, position, size)
    })?;
    // Run creation from the command's blocking worker, never a synchronous
    // UI callback. The hidden ancestor exists before ANY WebView is created.
    container.add_child(builder.focused(false), tauri::PhysicalPosition::new(0, 0), physical_size)
        .map_err(|_| FAILURE.to_owned())?;
    let main_owned = main.clone();
    on_main(main, move || {
        validate_parent(&main_owned, &container)?;
        verify_hidden(&container)
    })
}

pub(super) fn set_bounds(
    main: &tauri::Window,
    webview: &tauri::Webview,
    position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>,
) -> Result<(), String> {
    let container = main.app_handle().get_window(LABEL).ok_or_else(|| FAILURE.to_owned())?;
    let main_owned = main.clone();
    let webview = webview.clone();
    on_main(main, move || layout(&main_owned, &container, Some(&webview), position, size).map(|_| ()))
}

pub(super) fn hide(main: &tauri::Window) -> Result<(), String> {
    let Some(container) = main.app_handle().get_window(LABEL) else { return Ok(()); };
    let main_owned = main.clone();
    on_main(main, move || {
        validate_parent(&main_owned, &container)?;
        container.hide().map_err(|_| FAILURE.to_owned())?;
        verify_hidden(&container)
    })
}

pub(super) fn visible_for_intent(
    main: &tauri::Window,
    webview: &tauri::Webview,
) -> Result<bool, String> {
    let Some(container) = main.app_handle().get_window(LABEL) else { return Ok(false); };
    if webview.window().label() != LABEL { return Ok(false); }
    let main_owned = main.clone();
    on_main(main, move || {
        validate_parent(&main_owned, &container)?;
        let hwnd = container.hwnd().map_err(|_| FAILURE.to_owned())?;
        Ok(unsafe { IsWindowVisible(hwnd).as_bool() })
    })
}

pub(super) fn show(
    main: &tauri::Window,
    webview: &tauri::Webview,
    position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>,
) -> Result<(), String> {
    let container = main.app_handle().get_window(LABEL).ok_or_else(|| FAILURE.to_owned())?;
    let main_owned = main.clone();
    let webview = webview.clone();
    on_main(main, move || {
        validate_parent(&main_owned, &container)?;
        container.hide().map_err(|_| FAILURE.to_owned())?;
        verify_hidden(&container)?;
        layout(&main_owned, &container, Some(&webview), position, size)?;
        let hwnd = container.hwnd().map_err(|_| FAILURE.to_owned())?;
        let parent = main_owned.hwnd().map_err(|_| FAILURE.to_owned())?;
        // A new WS_CHILD starts below existing siblings. Raise only within
        // Main; this is not TOPMOST and never changes focus or cached state.
        unsafe {
            SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
                .map_err(|_| FAILURE.to_owned())?;
        }
        // Child controllers are never hidden separately: the fixed native
        // ancestor is the one visibility authority, keeping hidden boot live.
        container.show().map_err(|_| FAILURE.to_owned())?;
        let visible_and_top = unsafe {
            (GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_VISIBLE.0) != 0
                && GetTopWindow(Some(parent)).ok() == Some(hwnd)
        };
        if !visible_and_top {
            let _ = container.hide();
            return Err(FAILURE.to_owned());
        }
        Ok(())
    })
}
