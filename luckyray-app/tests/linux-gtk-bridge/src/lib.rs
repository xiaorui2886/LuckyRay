//! Compile and exercise the real GTK drag module without bundling an app.

#[path = "../../../src-tauri/src/material_drag.rs"]
mod material_drag;

#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/auto_launch_linux.rs"]
mod auto_launch_linux;

#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/linux_fs.rs"]
mod linux_fs;
#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/linux_app_data.rs"]
mod linux_app_data;

#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/linux_credential_admission.rs"]
mod linux_credential_admission;

#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/linux_directory.rs"]
mod linux_directory;

#[cfg(all(test, target_os = "linux"))]
mod linux_directory_handler_test;

#[path = "../../../src-tauri/src/dsh_native_surface_linux.rs"]
mod dsh_native_surface_linux;

#[cfg(target_os = "linux")]
#[path = "../../../src-tauri/src/native_messaging_linux.rs"]
mod native_messaging_linux;
