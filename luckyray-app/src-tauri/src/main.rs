// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(debug_assertions, feature = "workspace-runtime-fixture"))]
    if std::env::args().nth(1).as_deref() == Some("--workspace-runtime-fixture") {
        return luckyray_app_lib::run_workspace_fixture();
    }
    if std::env::args().nth(1).as_deref() == Some("--workspace-runtime-fixture") {
        eprintln!("workspace fixture unavailable; refusing normal profile startup");
        std::process::exit(2);
    }
    #[cfg(all(debug_assertions, windows, feature = "browser-host-runtime"))]
    if std::env::args().nth(1).as_deref() == Some("--dsh-tauri-startup-benchmark") {
        return luckyray_app_lib::run_dsh_startup_benchmark();
    }
    if std::env::args().nth(1).as_deref() == Some("--dsh-tauri-startup-benchmark") {
        eprintln!("dsh-startup-benchmark-unavailable");
        std::process::exit(2); // Never fall through into a real user profile.
    }
    if std::env::args().nth(1).as_deref() == Some("--extension-worker") {
        return luckyray_app_lib::run_extension_worker();
    }
    #[cfg(all(debug_assertions,feature="extension-runtime-fixture"))]
    if std::env::args().nth(1).as_deref() == Some("--extension-domain-fixture") {
        return luckyray_app_lib::run_extension_domain_fixture();
    }
    #[cfg(all(debug_assertions,feature="extension-runtime-fixture"))]
    if std::env::args().nth(1).as_deref() == Some("--extension-webview-fixture") {
        return luckyray_app_lib::run_extension_webview_fixture();
    }
    #[cfg(all(debug_assertions,feature="extension-runtime-fixture"))]
    if std::env::args().nth(1).as_deref() == Some("--extension-community-fixture") {
        return luckyray_app_lib::run_extension_community_fixture();
    }
    // A fixture flag on a build without the fixture entry points must never fall
    // through into the normal application (which would open the real profile).
    if matches!(
        std::env::args().nth(1).as_deref(),
        Some("--extension-domain-fixture" | "--extension-webview-fixture" | "--extension-community-fixture")
    ) {
        eprintln!("luckyray-extension-fixture-unavailable: fixture entry points exist only in debug builds compiled with the extension-runtime-fixture feature; refusing to start the normal application");
        std::process::exit(2);
    }
    luckyray_app_lib::run()
}
