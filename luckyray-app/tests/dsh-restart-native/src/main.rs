// Nonshipping UI check. No LuckyRay backend, updater, library, credentials,
// LSH runtime or application profile is linked into this test application.
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("isolated dialog check failed");
}
