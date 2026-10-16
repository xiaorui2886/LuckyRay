#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../browser_host_poc/mod.rs"]
#[allow(dead_code)]
mod browser_host_poc;

fn main() {
    std::process::exit(browser_host_poc::run());
}
