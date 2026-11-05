//! One compile-gated, fixed scenario in the real main/LSH WebViews. No supplied
//! script, arbitrary target, personal profile or model credential is accepted.
use super::{macos_shutdown::ShutdownFacts, DshHostStage, DshNativeSurfaceStage};
use crate::macos_fs::Directory;
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

const REJECT: &str = "macos-lsh-surface-flow-result-invalid";
static ACTIVE: OnceLock<Arc<FlowState>> = OnceLock::new();

#[derive(Default)]
struct Facts {
    binding: Option<(u64, u64)>,
    attached: bool,
    hidden: bool,
    shown: bool,
    binding_preserved: bool,
    authenticated_parent: bool,
    process_image: bool,
    official_saved_stop: bool,
    shutdown: Option<ShutdownFacts>,
    progress: u8,
    backend_step: Option<&'static str>,
    quit_blocker: Option<&'static str>,
}
struct FlowState {
    directory: Directory,
    facts: Mutex<Facts>,
    injected: AtomicBool,
    cancelled: AtomicBool,
    ui_recorded: AtomicBool,
    quit_recorded: AtomicBool,
}

fn active_state() -> Result<Option<FlowState>, &'static str> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().and_then(|a| a.to_str()) != Some("--macos-lsh-surface-flow") {
        return Ok(None);
    }
    let reject = "macos-lsh-surface-flow-context-invalid";
    if args.len() != 2
        || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || std::env::var("GITHUB_REPOSITORY").as_deref() != Ok("xiaorui2886/LuckyRay")
        || std::env::var_os("DEEPSEEK_API_KEY").is_some()
    {
        return Err(reject);
    }
    let sha = std::env::var("GITHUB_SHA").map_err(|_| reject)?;
    if sha.len() != 40
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(reject);
    }
    let temp = std::fs::canonicalize(std::env::var_os("RUNNER_TEMP").ok_or(reject)?)
        .map_err(|_| reject)?;
    let app = temp.join("luckyray-macos-internal/luckyray-app");
    let root = PathBuf::from(&args[1]);
    let nonce = root
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix("lsh-surface-flow-"))
        .ok_or(reject)?;
    if root.parent() != Some(app.join("src-tauri/target").as_path())
        || nonce.len() != 36 || !nonce.bytes().all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || std::env::current_dir().map_err(|_| reject)? != app
        || std::env::current_exe().map_err(|_| reject)? != app.join("src-tauri/target/aarch64-apple-darwin/release/bundle/macos/LuckyRay.app/Contents/MacOS/luckyray-app")
    { return Err(reject); }
    let directory = Directory::open(&root, false, true).map_err(|_| reject)?;
    let home = root.join("profile");
    if std::env::var_os("HOME").as_deref() != Some(home.as_os_str()) {
        return Err(reject);
    }
    Directory::open(&home, false, true).map_err(|_| reject)?;
    // Refuse stale fixtures and dangling links as well as existing content.
    for path in [
        root.join("ui-result.json"),
        root.join("quit-result.json"),
        root.join("ui-result.json.pending"),
        root.join("quit-result.json.pending"),
        home.join("Library/Application Support/com.luckyray.desktop"),
    ] {
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(reject),
        }
    }
    Ok(Some(FlowState {
        directory,
        facts: Mutex::new(Facts::default()),
        injected: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        ui_recorded: AtomicBool::new(false),
        quit_recorded: AtomicBool::new(false),
    }))
}

pub(crate) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let state = match active_state() {
        Ok(Some(state)) => Arc::new(state),
        Ok(None) => return builder,
        Err(code) => {
            eprintln!("{code}");
            std::process::exit(2);
        }
    };
    if ACTIVE.set(state.clone()).is_err() {
        std::process::exit(2);
    }
    builder.manage(state).on_page_load(|webview, page| {
        if webview.label() != "main"
            || !matches!(page.event(), tauri::webview::PageLoadEvent::Finished)
            || page.url().scheme() != "tauri"
            || page.url().host_str() != Some("localhost")
        {
            return;
        }
        let Some(state) = ACTIVE.get() else {
            return;
        };
        if state.injected.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = webview.app_handle().clone();
        let control = state.clone();
        // Loss of the disposable worker only cancels. Cleanup retains Rust's
        // authenticated parent and WNOWAIT/group handles; it cannot pass.
        std::thread::spawn(move || {
            let _ = std::io::stdin().read(&mut [0u8; 1]);
            control.cancelled.store(true, Ordering::Release);
            if let Some(host) = crate::DSH_HOST_SERVICE.get() {
                let _ = host.cancel_and_shutdown();
            }
            app.exit(3);
        });
        if webview
            .eval(include_str!("macos_surface_flow_driver.js"))
            .is_err()
        {
            eprintln!("macos-lsh-surface-flow-driver-unavailable");
        }
    })
}

pub(crate) fn observe_hidden() {
    if let Some(state) = ACTIVE.get() {
        if let Ok(mut facts) = state.facts.lock() {
            if facts.attached {
                facts.hidden = true;
            }
        }
    }
}
pub(crate) fn observe_shown() {
    if let Some(state) = ACTIVE.get() {
        if let Ok(mut facts) = state.facts.lock() {
            if facts.hidden {
                facts.shown = true;
            }
        }
    }
}
pub(crate) fn observe_saved_stop() {
    if let Some(state) = ACTIVE.get() {
        if let Ok(mut facts) = state.facts.lock() {
            facts.official_saved_stop = true;
            facts.backend_step = Some("official-saved-stop");
        }
    }
}
pub(super) fn observe_shutdown(generation: u64, shutdown: ShutdownFacts) {
    if let Some(state) = ACTIVE.get() {
        if let Ok(mut facts) = state.facts.lock() {
            if facts.binding.is_some_and(|binding| binding.0 == generation) {
                facts.shutdown = Some(shutdown);
                facts.backend_step = Some("normal-shutdown");
            }
        }
    }
}
fn shutdown_json(facts: ShutdownFacts) -> Value {
    json!({"writeCompleted":facts.write_completed,"acknowledged":facts.acknowledged,
        "rootExitedBeforeCleanup":facts.root_exited_before_cleanup,"rootSucceeded":facts.root_succeeded,
        "groupSettledBeforeCleanup":facts.group_settled_before_cleanup,"forcedCleanup":facts.forced_cleanup,
        "groupSettledAfterCleanup":facts.group_settled_after_cleanup,"rootExitedAfterCleanup":facts.root_exited_after_cleanup,
        "stdoutClosed":facts.stdout_closed,"stderrClosed":facts.stderr_closed,"groupState":facts.group_state})
}
fn record(facts: &Facts, state: &FlowState, stage: &str, passed: bool, quit_saved: bool) -> Value {
    json!({"schemaVersion":1,"mode":"macos-lsh-surface-flow","status":if passed {"passed"} else {"failed"},
        "stage":stage,"surfaceAttached":facts.attached,"surfaceHidden":facts.hidden,"surfaceReshown":facts.shown,
        "bindingPreserved":facts.binding_preserved,"authenticatedParent":facts.authenticated_parent,
        "processImageMatched":facts.process_image,"officialSavedStop":facts.official_saved_stop,"editorsSaved":quit_saved,
        "normalHostShutdown":facts.shutdown.is_some_and(|s| s.normal()),
        "ownedGroupSettled":facts.shutdown.is_some_and(|s| s.settled()),"shutdown":facts.shutdown.map(shutdown_json),
        "backendStep":facts.backend_step.unwrap_or("not-started"),"quitBlocker":facts.quit_blocker.unwrap_or("not-run"),
        "cancelled":state.cancelled.load(Ordering::Acquire),"interaction":"application-dom-automation",
        "modelAccount":"not-configured","systemPointerInput":"not-run"})
}
fn write(state: &FlowState, name: &str, value: &Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(value).map_err(|_| REJECT)?;
    // New immutable records have no displaced content/permissions to preserve.
    // Sync a private O_EXCL file, then publish with no-follow/excl rename:
    // readers see complete 0600 bytes, never an in-progress write or the notes
    // transaction's intentional 000 permission-restoration window.
    let pending = format!("{name}.pending");
    let held = state
        .directory
        .create(OsStr::new(&pending), &bytes)
        .map_err(|_| REJECT)?;
    let object = held.metadata().map_err(|_| REJECT)?;
    let before = state
        .directory
        .entry_info(OsStr::new(&pending))
        .map_err(|_| REJECT)?;
    if !object.is_file()
        || object.nlink() != 1
        || (before.device, before.inode) != (object.dev(), object.ino())
    {
        return Err(REJECT);
    }
    state
        .directory
        .rename(OsStr::new(&pending), OsStr::new(name), false)
        .map_err(|_| REJECT)?;
    let after = state
        .directory
        .read_owned(OsStr::new(name))
        .map_err(|_| REJECT)?
        .ok_or(REJECT)?;
    if after.0 != bytes
        || (after.1.device, after.1.inode) != (object.dev(), object.ino())
        || held.metadata().map_err(|_| REJECT)?.nlink() != 1
    {
        return Err(REJECT);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Observation {
    step: String,
    failed: bool,
}

#[tauri::command]
pub(crate) async fn macos_lsh_surface_flow_report(
    caller: tauri::Webview,
    report: Observation,
) -> Result<(), String> {
    crate::require_main_caller(&caller)?;
    let state = ACTIVE.get().cloned().ok_or(REJECT)?;
    if !["choose-mode", "mode-shell", "mode-route", "mode-wait", "mode-choices", "mode-dismiss", "open", "attached", "hidden", "reshown"].contains(&report.step.as_str()) {
        return Err(REJECT.into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), &'static str> {
        if state.cancelled.load(Ordering::Acquire) || state.ui_recorded.load(Ordering::Acquire) {
            return Err(REJECT);
        }
        if report.failed {
            if state.ui_recorded.swap(true, Ordering::AcqRel) {
                return Err(REJECT);
            }
            let facts = state.facts.lock().map_err(|_| REJECT)?;
            return write(
                &state,
                "ui-result.json",
                &record(&facts, &state, &report.step, false, false),
            );
        }
        let host = crate::DSH_HOST_SERVICE.get().ok_or(REJECT)?;
        state.facts.lock().map_err(|_| REJECT)?.backend_step = Some("client-ready");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let ready = host.surface_status();
            let observed = match report.step.as_str() {
                "hidden" => state.facts.lock().map_err(|_| REJECT)?.hidden,
                "reshown" => state.facts.lock().map_err(|_| REJECT)?.shown,
                "attached" => true,
                _ => return Err(REJECT),
            };
            if observed
                && ready.ready
                && matches!(
                    ready.stage,
                    DshNativeSurfaceStage::ClientReady | DshNativeSurfaceStage::SessionOpen
                )
            {
                break;
            }
            if Instant::now() >= deadline || state.cancelled.load(Ordering::Acquire) {
                return Err(REJECT);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let binding = host.native_surface_binding().ok_or(REJECT)?;
        state.facts.lock().map_err(|_| REJECT)?.backend_step = Some("child-origin");
        let child = caller
            .app_handle()
            .get_webview(crate::DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
            .ok_or(REJECT)?;
        let url = child.url().map_err(|_| REJECT)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port() != Some(host.surface_port.load(Ordering::Acquire))
        {
            return Err(REJECT);
        }
        if report.step == "attached" {
            if host.status().stage != DshHostStage::ProbeCompleted
                || !host.status().latest_probe_passed
            {
                return Err(REJECT);
            }
            let mut held = host.host.lock().map_err(|_| REJECT)?;
            let held = held.as_mut().ok_or(REJECT)?;
            state.facts.lock().map_err(|_| REJECT)?.backend_step = Some("node-image");
            crate::dsh_runtime_seal::verify_macos_node_process(&held.process)
                .map_err(|_| REJECT)?;
            {
                let mut facts = state.facts.lock().map_err(|_| REJECT)?;
                facts.process_image = true;
                facts.backend_step = Some("parent-ping");
            }
            if held.generation != binding.0 || !held.validate_host() {
                return Err(REJECT);
            }
        }
        let mut facts = state.facts.lock().map_err(|_| REJECT)?;
        facts.backend_step = Some("binding-retained");
        match (facts.progress, report.step.as_str()) {
            (0, "attached") => {
                facts.binding = Some(binding);
                facts.attached = true;
                facts.authenticated_parent = true;
                facts.process_image = true;
                facts.progress = 1;
            }
            (1, "hidden") if facts.hidden && facts.binding == Some(binding) => facts.progress = 2,
            (2, "reshown") if facts.shown && facts.binding == Some(binding) => {
                facts.binding_preserved = true;
                facts.progress = 3;
                if state.ui_recorded.swap(true, Ordering::AcqRel) {
                    return Err(REJECT);
                }
                write(
                    &state,
                    "ui-result.json",
                    &record(&facts, &state, "reshown", true, false),
                )?;
            }
            _ => return Err(REJECT),
        }
        Ok(())
    })
    .await
    .map_err(|_| REJECT.to_owned())?
    .map_err(str::to_owned)
}

// Called only after the unchanged editor barrier and product continuation.
// The worker separately requires an actual exit 0 and no signal/forced cleanup.
pub(crate) fn finish_quit(result: Result<(), &'static str>, restart: bool) -> bool {
    let Some(state) = ACTIVE.get() else {
        return true;
    };
    if state.quit_recorded.swap(true, Ordering::AcqRel) {
        return false;
    }
    let Ok(mut facts) = state.facts.lock() else {
        return false;
    };
    // Only public fixed codes survive. Never serialize an error message/path.
    facts.quit_blocker = Some(match result {
        Ok(()) => "none",
        Err(
            code @ ("update-lsh-task-active"
            | "update-lsh-schedule-active"
            | "update-lsh-draft-pending"
            | "update-lsh-composition-pending"
            | "update-lsh-save-failed"
            | "update-lsh-save-timeout"
            | "update-lsh-client-timeout"
            | "update-lsh-exit-timeout"
            | "update-lsh-control-timeout"
            | "update-lsh-identity-changed"
            | "update-lsh-content-changed"
            | "update-lsh-preparing"
            | "update-lsh-state-unavailable"
            | "update-lsh-not-quiescent"
            | "update-editors-not-saved"
            | "update-service-drain-incomplete"),
        ) => code,
        Err(code @ ("macos-quit-stop-unconfirmed" | "macos-quit-cleanup-pending" | "macos-quit-recovered"
            | "update-generation-active" | "update-task-state-unavailable" | "update-gateway-preparing")) => code,
        Err(_) => "other-blocker",
    });
    let saved = result.is_ok();
    let passed = saved
        && !restart
        && !state.cancelled.load(Ordering::Acquire)
        && facts.progress == 3
        && facts.binding_preserved
        && facts.official_saved_stop
        && facts.shutdown.is_some_and(|s| s.normal());
    write(
        state,
        "quit-result.json",
        &record(&facts, state, "normal-quit", passed, saved),
    )
    .is_ok()
        && passed
}
