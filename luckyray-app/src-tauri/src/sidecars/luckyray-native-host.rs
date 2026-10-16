fn main() {
    let args: Vec<String> = std::env::args().collect();
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
