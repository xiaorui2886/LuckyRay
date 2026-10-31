//! Compile and exercise the real GTK drag module without bundling an app.

#[path = "../../../src-tauri/src/material_drag.rs"]
mod material_drag;

#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/auto_launch_linux.rs"]
mod auto_launch_linux;

#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/linux_credential_admission.rs"]
mod linux_credential_admission;

#[path = "../../../src-tauri/src/dsh_native_surface_linux.rs"]
mod dsh_native_surface_linux;

#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/native_messaging_linux.rs"]
mod native_messaging_linux;
