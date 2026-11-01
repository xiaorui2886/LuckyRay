fn main() {
    let args: Vec<String> = std::env::args().collect();
    #[cfg(target_os = "macos")]
    if args.get(1).map(String::as_str) == Some("--print-macos-manifest-paths") {
        match luckyray_app_lib::native_messaging::macos_browser_manifest_paths()
            .and_then(|paths| serde_json::to_string(&paths).map_err(|_| "native-path-invalid".to_owned()))
        {
            Ok(paths) => println!("{paths}"),
            Err(error) => { eprintln!("LuckyRay native host: {error}"); std::process::exit(1); }
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("--install-manifest") {
        let Some(path) = args.get(2) else {
            eprintln!("LuckyRay native host: manifest path is required");
            std::process::exit(2);
        };
        let binary = std::env::current_exe().unwrap_or_default();
        if let Err(error) = luckyray_app_lib::native_messaging::write_host_manifest(
            std::path::Path::new(path),
            &binary,
        ) {
            eprintln!("LuckyRay native host: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = luckyray_app_lib::native_messaging::run() {
        eprintln!("LuckyRay native host: {error}");
        std::process::exit(1);
    }
}
