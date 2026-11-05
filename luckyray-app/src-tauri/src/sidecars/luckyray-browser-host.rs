//! Shared Personal Browser and isolated read-only Agent Browser host entrypoint.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../browser_host_poc/mod.rs"]
#[allow(dead_code)]
mod browser_host;

/// Descriptor-based file checks the Linux Agent Browser engine launch uses.
#[cfg(target_os = "linux")]
#[path = "../linux_fs.rs"]
#[allow(dead_code)]
mod linux_fs;

fn main() {
    std::process::exit(browser_host::run_production());
}
