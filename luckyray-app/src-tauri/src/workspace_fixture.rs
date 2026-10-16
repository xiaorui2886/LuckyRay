//! Debug-only two-system-window verification on exclusively created synthetic data.
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, Mutex,atomic::{AtomicBool,AtomicI32,AtomicUsize,Ordering}},io::Write,time::Instant};
use tauri::Manager;

pub(crate) struct Fixture {
    pub root: PathBuf,
    reports: Mutex<Vec<Value>>,
    finished: AtomicBool,
    legacy_probe_calls: AtomicUsize,
    exit_code: Arc<AtomicI32>,
    started: Instant,
}

const REQUIRED: &[&str] = &["scopeIsolation","sameRelativePathDifferentVault","opaqueAttachmentRead","attachmentRangeRead","attachmentCrossWindowDenied","attachmentForgedScopeDenied","attachmentSelfExpansionDenied","attachmentStaleTokenDenied","attachmentRecoveryBaselinePreserved","childAssetCspBlocked","childNavigationPinned","childPopupDenied","scopedGlobalSwitchDenied","recoveredScopeKeepsCapturedIdentity","recoveryCannotRetargetRoot","productionLegacyCommandsDenied","guardedLegacyProbeNotExecuted","multiTabRetainedUndo","explicitViewScope","unboundDenied","crossWindowDragHandshake","dragTargetSplit","dragReplayDenied","writerCommitted","staleRejected","mainBindingIdentityDenied","dirtyCloseDenied","reopenedWindowKeepsLatestDocument","restoredStableWindowIdentity","closeFlushedDraft","allWindowQuitBarrier","cancelledQuitUnfreezes","mergeIntoMountedMain","mergeSourceClosedAfterAck","staleMergeDenied","complete"];
const RUST_ASSERTIONS: &[&str] = &["scopeIsolation", "sameRelativePathDifferentVault", "scopedGlobalSwitchDenied", "recoveredScopeKeepsCapturedIdentity", "recoveryCannotRetargetRoot"];
const MAIN_ASSERTIONS: &[&str] = &["guardedLegacyProbeNotExecuted", "mainBindingIdentityDenied", "closeFlushedDraft", "allWindowQuitBarrier", "cancelledQuitUnfreezes", "mergeIntoMountedMain", "mergeSourceClosedAfterAck", "staleMergeDenied", "complete"];

fn assertion_present(reports: &[Value], key: &str) -> bool {
    reports.iter().any(|entry| {
        let owner = entry["window"].as_str().unwrap_or("");
        let correct_owner = if RUST_ASSERTIONS.contains(&key) { owner == "rust" }
            else if MAIN_ASSERTIONS.contains(&key) { owner == "main" }
            else { owner.starts_with("workspace-") };
        correct_owner && entry["report"][key] == Value::Bool(true)
    })
}
fn complete_reports(reports: &[Value]) -> bool {
    let readers = reports.iter().filter(|entry| entry["report"]["listenersReady"] == Value::Bool(true))
        .filter_map(|entry| entry["window"].as_str()).filter(|label| label.starts_with("workspace-"))
        .collect::<std::collections::HashSet<_>>();
    !reports.iter().any(|entry| entry["report"].get("error").is_some())
        && REQUIRED.iter().all(|key| assertion_present(reports, key))
        && readers.len() >= 2
        && readers.iter().all(|label| ["productionLegacyCommandsDenied", "opaqueAttachmentRead", "attachmentRangeRead", "attachmentForgedScopeDenied", "editorMounted"].iter().all(|key|
            reports.iter().any(|entry| entry["window"].as_str() == Some(*label) && entry["report"][*key] == Value::Bool(true))))
}

fn fixture_mode_allowed(identifier: &str, state_present: bool) -> bool {
    identifier == "com.luckyray.workspace.fixture" && state_present
}
fn child_report_allowed(registered: bool, report: &Value) -> bool {
    registered && report.is_object() && !RUST_ASSERTIONS.iter().chain(MAIN_ASSERTIONS).any(|key| report.get(*key).is_some())
}

// The only child entry is the existing scoped dispatcher. There is no exception
// in the production command guard and no client-supplied source/window identity.
pub(crate) fn report_child(app: &tauri::AppHandle, caller: &tauri::Webview, report: Value) -> Result<Value, String> {
    if !fixture_mode_allowed(&app.config().identifier, app.try_state::<Fixture>().is_some()) {
        return Err("workspace-fixture-inactive".into());
    }
    let registered = caller.label() != "main" && app.state::<crate::workspace_windows::WorkspaceWindows>().session(caller.label()).is_ok();
    if !child_report_allowed(registered, &report) { return Err("workspace-fixture-child-report-denied".into()); }
    record_report(app, caller.label(), report)?;
    Ok(json!({"accepted":true}))
}

fn window_snapshot(app: &tauri::AppHandle) -> Vec<Value> {
    // Manager-owned labels need no UI round trip. Geometry getters can block
    // the watchdog if the WebView/UI stalls, even outside the report mutex.
    let windows = app.webview_windows().into_keys().map(|label| json!({"label":label})).collect::<Vec<_>>();
    windows
}

fn result_snapshot(fixture: &Fixture, windows: Vec<Value>, reports: &[Value], status: &str, code: Option<i32>) -> Value {
    let mut stages = serde_json::Map::new();
    for entry in reports {
        if let (Some(label), Some(stage)) = (entry["window"].as_str(), entry["report"].get("stage")) {
            stages.insert(label.into(), json!({"stage":stage,"elapsedMs":entry["elapsedMs"]}));
        }
    }
    let missing = REQUIRED.iter().filter(|key| !assertion_present(reports, key)).collect::<Vec<_>>();
    let mut result = json!({"schemaVersion":2,"actualNative":true,"status":status,"complete":status=="passed","exitCode":code,
        "windows":windows,"reports":reports,"lastStageByWindow":stages,"missingAssertions":missing,
        "pid":std::process::id(),"elapsedMs":fixture.started.elapsed().as_millis() as u64});
    if let Some(error) = reports.iter().find_map(|entry| entry["report"].get("error")) { result["error"] = error.clone(); }
    result
}

fn record_report(app: &tauri::AppHandle, label: &str, report: Value) -> Result<Value, String> {
    // Keep even manager queries outside the report lock. The UI page-load hook
    // also records diagnostics; no geometry/visibility getter belongs here.
    let windows = window_snapshot(app);
    let fixture = app.state::<Fixture>();
    let mut reports = fixture.reports.lock().map_err(|_| "fixture-lock")?;
    if fixture.finished.load(Ordering::SeqCst) { return Err("fixture-already-finished".into()); }
    let completed = label == "main" && report["complete"] == Value::Bool(true);
    let mut failure = report.get("error").is_some();
    if !report.is_null() { reports.push(json!({"window":label,"elapsedMs":fixture.started.elapsed().as_millis() as u64,"report":report})); }
    if completed && !complete_reports(&reports) {
        reports.push(json!({"window":"rust","report":{"error":"fixture-required-assertions-incomplete","stage":"completion-validation"}}));
        failure = true;
    }
    let timeout = label == "watchdog";
    let code = if timeout { Some(124) } else if failure { Some(1) } else if completed { Some(0) } else { None };
    let status = if timeout { "timed_out" } else if failure { "failed" } else if completed { "passed" } else { "running" };
    let result = result_snapshot(&fixture, windows, &reports, status, code);
    if let Err(error) = write_report(&fixture, &result) {
        fixture.exit_code.store(2, Ordering::SeqCst);
        fixture.finished.store(true, Ordering::SeqCst);
        drop(reports);
        eprintln!("workspace fixture report persistence failed: {error}");
        app.exit(2);
        return Err(error);
    }
    if let Some(code) = code {
        fixture.exit_code.store(code, Ordering::SeqCst);
        fixture.finished.store(true, Ordering::SeqCst);
        drop(reports);
        app.exit(code);
    }
    Ok(result)
}

fn write_report(fixture:&Fixture,result:&Value)->Result<(),String>{
    let bytes=serde_json::to_vec_pretty(result).map_err(|error|error.to_string())?;
    let mut file=std::fs::File::create(fixture.root.join("result.json")).map_err(|error|error.to_string())?;
    file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|error|error.to_string())
}

#[tauri::command]
fn workspace_fixture_legacy_probe(app: tauri::AppHandle) -> usize {
    // Intentionally unguarded legacy-shaped command: only the production outer
    // policy must prevent children from reaching this harmless side effect.
    app.state::<Fixture>().legacy_probe_calls.fetch_add(1, Ordering::SeqCst) + 1
}

#[tauri::command]
async fn workspace_fixture_quit_probe(app:tauri::AppHandle,caller:tauri::Webview)->Result<bool,String>{
    if caller.label()!="main"{return Err("fixture-main-only".into());}
    tauri::async_runtime::spawn_blocking(move||{
        let saved=crate::workspace_windows::prepare_application_quit(&app);
        crate::workspace_windows::finish_quit_probe(&app);saved
    }).await.map_err(|error|error.to_string())
}

#[tauri::command]
fn workspace_fixture_report(app: tauri::AppHandle, caller: tauri::Webview, report: Value) -> Result<Value, String> {
    if caller.label() != "main" { return Err("fixture-main-only".into()); }
    record_report(&app, caller.label(), report)
}

pub fn run() {
    let mut context = tauri::generate_context!();
    assert_eq!(context.config().identifier, "com.luckyray.workspace.fixture", "fixture configuration required");
    context.config_mut().app.windows.clear();
    let root = std::env::temp_dir().join(format!("luckyray-workspace-fixture-{:032x}", rand::random::<u128>()));
    std::fs::create_dir(&root).expect("exclusive fixture directory");
    let backend = Arc::new(crate::backend::BackendServices::initialize(&root).unwrap());
    let vault = root.join("vault");
    std::fs::create_dir_all(vault.join(".luckyray")).unwrap();
    let registration = crate::knowledge::KnowledgeVaultRegistration {
        id:"workspace-test-vault".into(),name:"Workspace synthetic fixture".into(),root_path:vault.to_string_lossy().into(),
        mode:"vault-bound".into(),created_at:"2026-10-04T00:00:00Z".into(),last_opened_at:"2026-10-04T00:00:00Z".into(),schema_version:1,link_update_policy:Default::default(),
    };
    std::fs::write(vault.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
    std::fs::write(vault.join("shared.md"), "# 双窗口测试\n\n初始正文\n\n![[fixture-picture.png]]\n").unwrap();
    // Synthetic 1x1 PNG only; no real user paths or profile are touched.
    use base64::Engine;
    let picture = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV0AAAAASUVORK5CYII=").unwrap();
    std::fs::write(vault.join("fixture-picture.png"), picture).unwrap();
    std::fs::write(vault.join("fixture-secret.png"), b"synthetic-not-authorized").unwrap();
    std::fs::write(vault.join("second.md"), "# 第二个标签\n\n独立内容\n").unwrap();
    backend.knowledge().register_current_vault(&registration).unwrap();
    // Scope is captured before changing Main's active library. Equal paths in
    // another Vault must not retarget a previously opened workspace document.
    let scoped = backend.knowledge().capture_workspace_scope(&registration.id).unwrap();
    let other = root.join("vault-b");
    std::fs::create_dir_all(other.join(".luckyray")).unwrap();
    let mut registration_b = registration.clone();
    registration_b.id = "workspace-test-vault-b".into();
    registration_b.root_path = other.to_string_lossy().into();
    std::fs::write(other.join(".luckyray/vault.json"), serde_json::to_vec(&registration_b).unwrap()).unwrap();
    std::fs::write(other.join("shared.md"), "不同库原文").unwrap();
    backend.knowledge().register_current_vault(&registration_b).unwrap();
    let saved_scope=scoped.workspace_recovery_record().unwrap();
    let recovered_scope=backend.knowledge().restore_workspace_scope(&saved_scope).unwrap();
    assert_eq!(recovered_scope.current_vault_id().unwrap(),registration.id);
    assert_eq!(backend.knowledge().current_vault_id().unwrap(),registration_b.id);
    let mut forged_record=serde_json::to_value(&saved_scope).unwrap();
    forged_record["registration"]["rootPath"]=serde_json::json!(other.to_string_lossy());
    let forged_record:crate::knowledge::WorkspaceScopeRecord=serde_json::from_value(forged_record).unwrap();
    assert!(backend.knowledge().restore_workspace_scope(&forged_record).is_err());
    let reference=crate::knowledge::KnowledgeDocumentRef{vault_id:registration.id.clone(),relative_path:"shared.md".into()};
    let before=scoped.read_document(&reference).unwrap();
    scoped.replace_document(&crate::knowledge::KnowledgeWriteInput{document_ref:reference.clone(),content:before.content.clone(),expected_revision:Some(before.revision)}).unwrap();
    assert_eq!(std::fs::read_to_string(other.join("shared.md")).unwrap(),"不同库原文");
    assert!(scoped.read_document(&crate::knowledge::KnowledgeDocumentRef{vault_id:registration_b.id.clone(),relative_path:"shared.md".into()}).is_err());
    assert!(scoped.register_current_vault(&registration_b).is_err());
    backend.knowledge().register_current_vault(&registration).unwrap();
    assert!(crate::BACKEND_SERVICES.set(backend).is_ok());
    println!("WORKSPACE_FIXTURE_ROOT={}", root.display());
    let webview_dir = root.join("webview-main");
    let exit_code = Arc::new(AtomicI32::new(125));
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("workspace-attachment", |context, request, responder| {
            let app = context.app_handle().clone();
            let label = context.webview_label().to_owned();
            tauri::async_runtime::spawn_blocking(move || responder.respond(crate::workspace_attachments::serve(&app, &label, request)));
        })
        .manage(Fixture { root, exit_code:exit_code.clone(), started:Instant::now(), finished:AtomicBool::new(false), legacy_probe_calls:AtomicUsize::new(0), reports: Mutex::new(vec![json!({"window":"rust","report":{"scopeIsolation":true,"sameRelativePathDifferentVault":true,"scopedGlobalSwitchDenied":true,"recoveredScopeKeepsCapturedIdentity":true,"recoveryCannotRetargetRoot":true}})]) })
        .manage(crate::workspace_windows::WorkspaceWindows::default())
        .invoke_handler({
            let guarded = crate::workspace_command_policy::guard(tauri::generate_handler![
                crate::workspace_windows::workspace_window_command,
                crate::knowledge_read_document,
                workspace_fixture_report,
                workspace_fixture_legacy_probe,
                workspace_fixture_quit_probe
            ]);
            move |invoke: tauri::ipc::Invoke| guarded(invoke)
        })
        .on_page_load(|webview, payload| {
            // Native load evidence is available even when the JS module fails.
            let report = json!({"nativeLoad":format!("{:?}",payload.event()),"url":payload.url().as_str()});
            let _ = record_report(webview.app_handle(), webview.label(), report);
        })
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("tests/fixtures/workspace-native.html".into()))
                .title("LuckyRay Workspace · isolated test").inner_size(900.,650.).data_directory(webview_dir).build()?;
            let handle=app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(100));
                if !handle.state::<Fixture>().finished.load(Ordering::SeqCst) {
                    let _ = record_report(&handle, "watchdog", json!({"error":"fixture-timeout","stage":"watchdog"}));
                }
                // This isolated synthetic process has a hard deadline. A hung
                // UI might never service AppHandle::exit's event-loop request.
                let code = handle.state::<Fixture>().exit_code.load(Ordering::SeqCst);
                std::process::exit(if code == 0 { 124 } else { code });
            });
            Ok(())
        })
        .build(context).expect("workspace native fixture");
    let runtime_code = app.run_return(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) && !handle.state::<Fixture>().finished.load(Ordering::SeqCst) {
            let _ = record_report(handle, "rust", json!({"error":"fixture-exited-before-completion","stage":"exit-requested"}));
        }
    });
    let code = exit_code.load(Ordering::SeqCst);
    // Never turn an interrupted/incomplete run into shell success. Runtime
    // failure also wins over a previously successful assertion aggregate.
    std::process::exit(if code == 0 { runtime_code } else { code });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_fixture_requires_isolated_identity_and_managed_state() {
        assert!(fixture_mode_allowed("com.luckyray.workspace.fixture", true));
        assert!(!fixture_mode_allowed("com.luckyray.workspace.fixture", false));
        assert!(!fixture_mode_allowed("com.luckyray.app", true));
        assert!(!fixture_mode_allowed("com.luckyray.app", false));
    }

    #[test]
    fn workspace_fixture_unknown_child_and_aggregate_claims_are_denied() {
        assert!(child_report_allowed(true, &json!({"stage":"bootstrap"})));
        assert!(!child_report_allowed(false, &json!({"stage":"bootstrap"})));
        assert!(!child_report_allowed(true, &Value::Null));
        for key in RUST_ASSERTIONS.iter().chain(MAIN_ASSERTIONS) {
            assert!(!child_report_allowed(true, &json!({(*key):true})), "{key}");
            assert!(!child_report_allowed(true, &json!({(*key):false})), "{key}");
        }
    }

    fn successful_reports() -> Vec<Value> {
        let mut reports = REQUIRED.iter().map(|key| {
            let label = if RUST_ASSERTIONS.contains(key) { "rust" }
                else if MAIN_ASSERTIONS.contains(key) { "main" } else { "workspace-a" };
            json!({"window":label,"report":{(*key):true}})
        }).collect::<Vec<_>>();
        for label in ["workspace-a", "workspace-b"] {
            reports.push(json!({"window":label,"report":{"listenersReady":true,"editorMounted":true,"productionLegacyCommandsDenied":true,"opaqueAttachmentRead":true,"attachmentRangeRead":true,"attachmentForgedScopeDenied":true}}));
        }
        reports
    }

    #[test]
    fn workspace_fixture_completion_requires_provenance_both_readers_and_no_errors() {
        let reports = successful_reports();
        assert!(complete_reports(&reports));
        let mut errored = reports.clone();
        errored.push(json!({"window":"workspace-b","report":{"error":"children readiness timeout"}}));
        assert!(!complete_reports(&errored));
        let mut forged = reports.clone();
        for entry in &mut forged { if entry["window"] == "rust" { entry["window"] = json!("workspace-a"); } }
        assert!(!complete_reports(&forged));
        let only_one = reports.iter().filter(|entry| entry["window"] != "workspace-b").cloned().collect::<Vec<_>>();
        assert!(!complete_reports(&only_one));
        let missing = reports.iter().filter(|entry| entry["report"].get("writerCommitted").is_none()).cloned().collect::<Vec<_>>();
        assert!(!complete_reports(&missing));
        let baseline_only = reports.iter().filter(|entry| entry["window"] == "rust").cloned().collect::<Vec<_>>();
        assert!(!complete_reports(&baseline_only));
    }
}
