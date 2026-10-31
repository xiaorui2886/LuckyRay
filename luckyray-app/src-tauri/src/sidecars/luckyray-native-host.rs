fn main() {
    let args: Vec<String> = std::env::args().collect();
    #[cfg(target_os = "linux")]
    if args.get(1).map(String::as_str) == Some("--install-linux-manifest") {
        if args.len() != 3 {
            eprintln!("LuckyRay native host: expected one browser name");
            std::process::exit(2);
        }
        match luckyray_app_lib::native_messaging::install_linux_host(&args[2]) {
            Ok(outcome) => println!("{outcome}"),
            Err(error) => {
                eprintln!("LuckyRay native host: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(target_os = "linux")]
    if args.get(1).map(String::as_str) == Some("--install-manifest") {
        eprintln!("LuckyRay native host: use --install-linux-manifest with a supported browser");
        std::process::exit(2);
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
