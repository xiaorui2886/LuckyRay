//! Debug-only engineering entry: real Tauri/Wry native child and official
//! composer ACK. No AppShell mock, global backend, updater trust, phone,
//! user profile, model request, screen activation or UI clicks.
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;
use crate::dsh_host::{DshHostService, DshHostAction, DshNativeSurfaceStage};

fn draft_ack(host: &Arc<DshHostService>) -> Result<u128, String> {
    let nonce = format!("{:032x}", rand::random::<u128>());
    let id = format!("intent-{}-{}-{}-{}-{}", &nonce[..8], &nonce[8..12],
        &nonce[12..16], &nonce[16..20], &nonce[20..]);
    let started = Instant::now();
    host.stage_open_intent(serde_json::from_value(serde_json::json!({
        "intentId": id, "source": "search", "localResources": [],
        "text": "Synthetic startup timing draft. Never send this draft."
    })).map_err(|_| "benchmark-intent-invalid")?)?;
    loop {
        match host.open_intent_status(&id)?.as_str() {
            "applied" => return Ok(started.elapsed().as_millis()),
            "pending" if started.elapsed() < Duration::from_secs(30) =>
                std::thread::sleep(Duration::from_millis(25)),
            _ => return Err("benchmark-composer-ack-failed".into()),
        }
    }
}

fn sample(caller: &tauri::Webview, host: &Arc<DshHostService>, descriptor_ms: u128, index: u8) -> Result<(), String> {
    let started = Instant::now();
    let probe = host.probe(DshHostAction::Probe)?;
    if !probe.latest_probe_passed { return Err("benchmark-probe-failed".into()); }
    let probe_ms = started.elapsed().as_millis();
    let started = Instant::now();
    let (_, bootstrap) = host.open_native_surface()?;
    let carrier_ms = started.elapsed().as_millis();
    if host.surface_status().ready { return Err("benchmark-early-ready".into()); }
    let started = Instant::now();
    crate::create_dsh_native_surface_child(caller, tauri::LogicalPosition::new(220., 60.),
        tauri::LogicalSize::new(1220., 840.), &bootstrap)?;
    host.publish_surface_stage_for(bootstrap.host_generation, bootstrap.carrier_generation, DshNativeSurfaceStage::WebviewCreated);
    loop {
        let status = host.surface_status();
        if status.ready { break; }
        if status.stage == DshNativeSurfaceStage::Unavailable || started.elapsed() >= Duration::from_secs(90) {
            return Err("benchmark-client-not-ready".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let web_client_ms = started.elapsed().as_millis();
    let composer_ack_ms = draft_ack(host)?;
    let child = caller.app_handle().get_webview(crate::DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
        .ok_or("benchmark-child-missing")?;
    // Real route-away/return is visual-only. Keep the same owned host/child.
    child.hide().map_err(|_| "benchmark-hide-failed")?;
    std::thread::sleep(Duration::from_millis(250));
    let started = Instant::now();
    child.show().map_err(|_| "benchmark-show-failed")?;
    let warm_show_ms = started.elapsed().as_millis();
    let warm_composer_ack_ms = draft_ack(host)?;
    let compatibility = host.plugin_compat_check(false)?;
    if compatibility.get("checked") != Some(&serde_json::json!(true)) {
        return Err("benchmark-plugins-unchecked".into());
    }
    crate::retire_dsh_native_surface_child(caller)?;
    host.close_native_surface()?;
    println!("{}", serde_json::json!({ "outcome":"REAL_TAURI_NATIVE_CHILD_COMPOSER_TIMING", "sample":index,
        "descriptorMs":descriptor_ms, "probeMs":probe_ms, "carrierMs":carrier_ms,
        "webClientMs":web_client_ms, "composerDraftAckMs":composer_ack_ms,
        "warmShowMs":warm_show_ms, "warmComposerDraftAckMs":warm_composer_ack_ms,
        "modelSent":false, "appShellMeasured":false, "visibleWindow":false }));
    Ok(())
}

pub(super) fn run() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 { eprintln!("benchmark-explicit-resources-required"); std::process::exit(2); }
    let resources = PathBuf::from(&args[2]);
    if !resources.is_absolute() || !resources.is_dir() { eprintln!("benchmark-resources-invalid"); std::process::exit(2); }
    // Always a new generated identity. No AppData/profile override is accepted.
    let root = std::env::temp_dir().join(format!("luckyray-dsh-tauri-benchmark-{:032x}", rand::random::<u128>()));
    std::fs::create_dir(&root).expect("new benchmark identity");
    let profile = root.join("synthetic-app-data");
    std::fs::create_dir(&profile).expect("new synthetic data");
    println!("DSH_TAURI_BENCHMARK_SYNTHETIC_ROOT {}", root.display());
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.luckyray.benchmark-{:032x}", rand::random::<u128>());
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    let failed_result = Arc::new(AtomicBool::new(false));
    let failure_slot = failed_result.clone();
    let app = tauri::Builder::default().setup(move |app| {
        let window = tauri::WindowBuilder::new(app, "main").inner_size(1440., 900.).visible(false).build()?;
        let caller = window.add_child(tauri::webview::WebviewBuilder::new("main",
            tauri::WebviewUrl::External("about:blank".parse().unwrap())).data_directory(root.join("webview-data")),
            tauri::LogicalPosition::new(0., 0.), tauri::LogicalSize::new(1440., 900.))?;
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            let mut failed = false;
            for index in 1..=3 {
                let started = Instant::now();
                let host = DshHostService::production(&resources, &profile);
                let descriptor_ms = started.elapsed().as_millis();
                let result = sample(&caller, &host, descriptor_ms, index);
                // Same production graceful shutdown and whole-Job verdict.
                let settled = host.shutdown();
                println!("DSH_TAURI_BENCHMARK_SHUTDOWN sample={index} settled={settled}");
                if result.is_err() || !settled {
                    // Known errors only; never print carrier references/config.
                    let category = result.err().filter(|value| value.len() <= 96 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
                        .unwrap_or_else(|| "benchmark-unclassified-failure".into());
                    eprintln!("DSH_TAURI_BENCHMARK_FAILED sample={index} category={category}");
                    failed = true; break;
                }
            }
            failure_slot.store(failed, Ordering::Release);
            handle.exit(if failed { 1 } else { 0 });
        });
        Ok(())
    }).build(context).expect("benchmark Tauri build");
    app.run(|_, _| {});
    if failed_result.load(Ordering::Acquire) { std::process::exit(1); }
}
