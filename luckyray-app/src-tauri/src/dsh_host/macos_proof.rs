//! Explicit native CI proof through the real bundled DSH service. No model
//! account, GUI, browser registration, arbitrary path or supplied JS is used.
use super::*;
use crate::macos_fs::Directory;

// The disposable worker owns stdin. Any byte or loss of that parent asks for
// cancellation, never for new work or authority. Keep cleanup in Rust so the
// retained WNOWAIT/group handles, not a numerical process search, own it.
struct Cancellation {
    requested: AtomicBool,
    service: Mutex<Option<Arc<DshHostService>>>,
}
impl Cancellation {
    fn start() -> Arc<Self> {
        let state = Arc::new(Self {
            requested: AtomicBool::new(false),
            service: Mutex::new(None),
        });
        let control = state.clone();
        thread::spawn(move || {
            let mut byte = [0u8; 1];
            let _ = std::io::stdin().read(&mut byte);
            control.requested.store(true, Ordering::Release);
            let service = control.service.lock().ok().and_then(|slot| slot.clone());
            if let Some(service) = service {
                let _ = service.cancel_and_shutdown();
            }
        });
        state
    }
    fn check(&self) -> Result<(), ()> {
        if self.requested.load(Ordering::Acquire) {
            Err(())
        } else {
            Ok(())
        }
    }
    fn register(&self, service: Arc<DshHostService>) -> Result<(), ()> {
        *self.service.lock().map_err(|_| ())? = Some(service);
        self.check()
    }
}

pub(crate) fn run() -> bool {
    let mut report = serde_json::json!({"schemaVersion":1,"mode":"macos-lsh-native-proof",
        "status":"failed","stage":"context","launchStep":"not-started","installedManifest":false,"realProbeCompleted":false,
        "processImageMatched":false,"authenticatedParentPing":false,"normalHostShutdown":false,
        "ownedGroupSettled":false,"shutdown":null,"cancelled":false,"guiInteraction":"not-run","modelAccount":"not-configured"});
    let mut service = None;
    let mut normal = None;
    let mut shutdown_facts = None;
    let mut cancellation = None;
    let result = (|| -> Result<(), ()> {
        if std::env::args().len() != 2
            || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
            || std::env::var("GITHUB_REPOSITORY").as_deref() != Ok("xiaorui2886/LuckyRay")
            || std::env::var_os("DEEPSEEK_API_KEY").is_some()
        {
            return Err(());
        }
        let sha = std::env::var("GITHUB_SHA").map_err(|_| ())?;
        if sha.len() != 40
            || !sha
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(());
        }
        let temp =
            std::fs::canonicalize(std::env::var_os("RUNNER_TEMP").ok_or(())?).map_err(|_| ())?;
        let app = temp.join("luckyray-macos-internal/luckyray-app");
        let executable = std::env::current_exe().map_err(|_| ())?;
        if executable != app.join("src-tauri/target/aarch64-apple-darwin/release/bundle/macos/LuckyRay.app/Contents/MacOS/luckyray-app") {
            return Err(());
        }
        let control = Cancellation::start();
        cancellation = Some(control.clone());
        control.check()?;
        let resources =
            crate::macos_lsh_resource_path::resource_directory(&executable).map_err(|_| ())?;
        report["stage"] = "installed-resources".into();
        installation::verify_installation(&resources).map_err(|_| ())?;
        report["installedManifest"] = true.into();
        control.check()?;
        let target = app.join("src-tauri/target");
        Directory::open_trusted(&target).map_err(|_| ())?;
        let mut nonce = [0; 32];
        rand::thread_rng().fill_bytes(&mut nonce);
        let profile = target.join(format!("lsh-proof-{}", challenge_hex(&nonce)));
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&profile)
            .map_err(|_| ())?;
        Directory::open(&profile, false, true).map_err(|_| ())?;
        report["stage"] = "initialize".into();
        let active = DshHostService::production(&resources, &profile);
        service = Some(active.clone());
        control.register(active.clone())?;
        if active.descriptor.get().is_none() {
            return Err(());
        }
        report["stage"] = "real-dsh-probe".into();
        let status = active.probe(DshHostAction::Probe).map_err(|_| ())?;
        if status.stage != DshHostStage::ProbeCompleted || !status.latest_probe_passed {
            return Err(());
        }
        report["realProbeCompleted"] = true.into();
        control.check()?;
        report["stage"] = "authenticated-parent".into();
        let mut slot = active.host.lock().map_err(|_| ())?;
        let host = slot.as_mut().ok_or(())?;
        crate::dsh_runtime_seal::verify_macos_node_process(&host.process)?;
        report["processImageMatched"] = true.into();
        if !host.validate_host() {
            return Err(());
        }
        report["authenticatedParentPing"] = true.into();
        normal = Some(host.normal_shutdown.clone());
        shutdown_facts = Some(host.shutdown_facts.clone());
        drop(slot);
        report["stage"] = "normal-shutdown".into();
        Ok(())
    })();
    if let Some(active) = &service {
        if let Ok(step) = active.macos_launch_step.lock() {
            report["launchStep"] = (*step).into();
        }
    }
    // Every created generation gets a bounded cleanup path, including failures.
    let settled = service.as_ref().is_some_and(|service| service.shutdown());
    let normal = normal.is_some_and(|value| value.load(Ordering::Acquire));
    if let Some(facts) = shutdown_facts.and_then(|slot| slot.lock().ok().and_then(|slot| *slot)) {
        report["shutdown"] = serde_json::json!({
            "writeCompleted":facts.write_completed,"acknowledged":facts.acknowledged,
            "rootExitedBeforeCleanup":facts.root_exited_before_cleanup,"rootSucceeded":facts.root_succeeded,
            "groupSettledBeforeCleanup":facts.group_settled_before_cleanup,"forcedCleanup":facts.forced_cleanup,
            "groupSettledAfterCleanup":facts.group_settled_after_cleanup,"rootExitedAfterCleanup":facts.root_exited_after_cleanup,
            "stdoutClosed":facts.stdout_closed,"stderrClosed":facts.stderr_closed,"groupState":facts.group_state,
        });
    }
    report["ownedGroupSettled"] = settled.into();
    report["normalHostShutdown"] = normal.into();
    let cancelled = cancellation.is_some_and(|state| state.requested.load(Ordering::Acquire));
    report["cancelled"] = cancelled.into();
    let passed = result.is_ok() && settled && normal && !cancelled;
    if cancelled {
        report["stage"] = "cancelled".into();
    }
    if passed {
        report["status"] = "passed".into();
        report["stage"] = "complete".into();
    }
    println!("{report}");
    passed
}
