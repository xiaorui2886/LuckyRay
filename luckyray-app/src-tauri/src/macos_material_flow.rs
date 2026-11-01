//! Fixed, compile-gated UI scenario in a disposable project runner. It cannot
//! select arbitrary files, execute supplied JavaScript or open a real profile.
use crate::macos_fs::{digest, Directory};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const SOURCE: &str = "macos-material-flow.png";
const SHA256: &str = "a4307dbf28c24f349374a7d97bcb4e3856b1cf505f9d8f203c490b60200a976d";
const STEPS: &[&str] = &[
    "choose-mode",
    "import",
    "import-card",
    "thumbnail",
    "preview",
    "reopen-mode",
    "reopen-card",
    "reopen-thumbnail",
    "reopen-preview",
    "backend-check",
];

const IMPORT_ERROR_CODES: &[&str] = &[
    "database-error",
    "database-missing",
    "invalid-storage-mode",
    "invalid-folder",
    "create-library-failed",
    "copy-failed",
    "source-missing",
    "source-read-failed",
    "source-changed",
    "managed-destination-conflict",
    "managed-path-reparse",
    "managed-path-unavailable",
    "managed-path-untrusted",
    "managed-root-record-invalid",
    "managed-root-register-conflict",
    "managed-root-register-failed",
    "managed-root-unavailable",
    "managed-root-untrusted",
    "material-library-scope",
    "physical-path-owned",
    "physical-path-reparse",
    "physical-path-unavailable",
    "physical-path-untrusted",
    "physical-content-mismatch",
    "physical-content-unverified",
    "physical-identity-mismatch",
    "material-hash-invalid",
    "staged-file-changed",
    "staged-file-missing",
    "staged-file-read-failed",
    "staged-file-too-large",
    "staged-file-untrusted",
    "staging-unavailable",
    "change-not-published",
    "other-code",
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeImportObservation {
    status: String,
    calls: u8,
    imported_count: u8,
    failed_count: u8,
    skipped_duplicate_count: u8,
    error_codes: Vec<String>,
    os_error: Option<u8>,
}

impl NativeImportObservation {
    fn initial(status: &str) -> Self {
        Self {
            status: status.into(),
            calls: 0,
            imported_count: 0,
            failed_count: 0,
            skipped_duplicate_count: 0,
            error_codes: Vec::new(),
            os_error: None,
        }
    }
}

struct ImportProbe {
    source: PathBuf,
    // The actual ID stays in the private fixture record, never the public report.
    observation: Mutex<(NativeImportObservation, Option<String>)>,
}
static IMPORT_PROBE: OnceLock<ImportProbe> = OnceLock::new();

// Compiled only by this disposable macOS scenario. Observe the unchanged real
// importer once; never retry it, change its arguments/results or perform IO here.
pub(crate) fn observe_import(
    paths: &[PathBuf],
    operation: impl FnOnce() -> crate::materials::MaterialResult<
        crate::materials::CatalogOutcome<crate::materials::MaterialImportResult>,
    >,
) -> crate::materials::MaterialResult<
    crate::materials::CatalogOutcome<crate::materials::MaterialImportResult>,
> {
    let probe = IMPORT_PROBE
        .get()
        .filter(|probe| paths == [probe.source.clone()]);
    if let Some(probe) = probe {
        if let Ok(mut entry) = probe.observation.lock() {
            entry.0.calls = entry.0.calls.saturating_add(1).min(2);
            entry.0.status = if entry.0.calls > 1 {
                "multiple-calls"
            } else {
                "running"
            }
            .into();
            entry.0.imported_count = 0;
            entry.0.failed_count = 0;
            entry.0.skipped_duplicate_count = 0;
            entry.0.error_codes.clear();
            entry.0.os_error = None;
            entry.1 = None;
        }
    }
    let result = operation();
    if let Some(probe) = probe {
        if let Ok(mut entry) = probe.observation.lock() {
            let safe_code = |code: &str| {
                if IMPORT_ERROR_CODES.contains(&code) {
                    code
                } else {
                    "other-code"
                }
                .to_owned()
            };
            // MaterialError::io appends this std::io suffix. Only its bounded
            // numeric errno survives, never the error's message or pathname.
            let os_error = |message: &str| {
                message
                    .strip_suffix(')')
                    .and_then(|text| text.rsplit_once("(os error "))
                    .and_then(|(_, number)| number.parse::<u8>().ok())
            };
            match &result {
                Ok(outcome) => {
                    entry.0.status = "returned".into();
                    entry.0.imported_count = outcome.value.imported_count.min(2) as u8;
                    entry.0.failed_count = outcome.value.failed_count.min(2) as u8;
                    entry.0.skipped_duplicate_count =
                        outcome.value.skipped_duplicate_count.min(2) as u8;
                    entry.0.error_codes = outcome
                        .value
                        .failed_items
                        .iter()
                        .take(1)
                        .map(|item| safe_code(&item.code))
                        .collect();
                    entry.0.os_error = outcome
                        .value
                        .failed_items
                        .first()
                        .and_then(|item| os_error(&item.error));
                    entry.1 = (outcome.value.assets.len() == 1)
                        .then(|| outcome.value.assets[0].id.clone());
                }
                Err(error) => {
                    entry.0.status = "error".into();
                    entry.0.error_codes = vec![safe_code(&error.code)];
                    entry.0.os_error = os_error(&error.message);
                }
            }
            if entry.0.calls > 1 {
                entry.0.status = "multiple-calls".into();
            }
        }
    }
    result
}

fn import_observation() -> (NativeImportObservation, Option<String>) {
    IMPORT_PROBE
        .get()
        .and_then(|probe| probe.observation.lock().ok().map(|entry| entry.clone()))
        .unwrap_or_else(|| (NativeImportObservation::initial("unavailable"), None))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageObservation {
    present: bool,
    complete: bool,
    width: u32,
    height: u32,
    visible: bool,
    uri_kind: String,
}
impl ImageObservation {
    fn valid(&self) -> bool {
        self.width <= 32768
            && self.height <= 32768
            && matches!(
                self.uri_kind.as_str(),
                "missing" | "asset" | "asset-localhost" | "other"
            )
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DomObservation {
    import_dispatched: bool,
    workspace_target: String,
    bridge_installed: bool,
    database_state: String,
    card_count: u8,
    dialog_present: bool,
    thumbnail: ImageObservation,
    preview: ImageObservation,
}
impl DomObservation {
    fn valid(&self) -> bool {
        self.card_count <= 2
            && matches!(self.workspace_target.as_str(), "scoped" | "unscoped")
            && matches!(
                self.database_state.as_str(),
                "unknown" | "pending" | "ready" | "failed"
            )
            && self.thumbnail.valid()
            && self.preview.valid()
    }
}

pub(crate) struct FlowState {
    directory: Directory,
    home: PathBuf,
    source: PathBuf,
    phase: String,
    expected_id: Option<String>,
    injected: AtomicBool,
    recorded: AtomicBool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Observation {
    phase: String,
    status: String,
    step: String,
    asset_id: Option<String>,
    mode_saved: bool,
    preview_decoded: bool,
    dom: DomObservation,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema: u8,
    phase: String,
    status: String,
    step: String,
    asset_id: Option<String>,
    mode_saved: bool,
    preview_decoded: bool,
    backend_record_verified: bool,
    managed_copy_verified: bool,
    source_unchanged: bool,
    fixture_sha256: String,
    dom: DomObservation,
    native_import: NativeImportObservation,
}

fn active_state() -> Result<Option<FlowState>, &'static str> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().and_then(|a| a.to_str()) != Some("--macos-material-flow") {
        return Ok(None);
    }
    let reject = "macos-material-flow-context-invalid";
    if args.len() != 3
        || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || std::env::var("GITHUB_REPOSITORY").as_deref() != Ok("xiaorui2886/LuckyRay")
    {
        return Err(reject);
    }
    let phase = args[1]
        .to_str()
        .filter(|p| matches!(*p, "import" | "reopen"))
        .ok_or(reject)?
        .to_owned();
    let sha = std::env::var("GITHUB_SHA").map_err(|_| reject)?;
    if sha.len() != 40
        || !sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(reject);
    }
    let temp = PathBuf::from(std::env::var_os("RUNNER_TEMP").ok_or(reject)?);
    let app = temp.join("luckyray-macos-internal/luckyray-app");
    let root = PathBuf::from(&args[2]);
    let prefix = root
        .file_name()
        .and_then(|p| p.to_str())
        .and_then(|p| p.strip_prefix("materials-flow-"))
        .ok_or(reject)?;
    if !temp.is_absolute()
        || root.parent() != Some(app.join("src-tauri/target").as_path())
        || prefix.len() != 36
        || !prefix
            .bytes()
            .all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || std::env::current_dir().map_err(|_| reject)? != app
    {
        return Err(reject);
    }
    let directory = Directory::open(&root, false, true).map_err(|_| reject)?;
    let home = root.join("profile");
    if std::env::var_os("HOME").as_deref() != Some(home.as_os_str()) {
        return Err(reject);
    }
    Directory::open(&home, false, true).map_err(|_| reject)?;
    let source = root.join(SOURCE);
    let (bytes, _) = directory
        .read_owned(OsStr::new(SOURCE))
        .map_err(|_| reject)?
        .ok_or(reject)?;
    if bytes.len() != 119 || digest(&bytes) != SHA256 {
        return Err(reject);
    }
    let import = directory
        .read_owned(OsStr::new("import-result.json"))
        .map_err(|_| reject)?;
    let expected_id = if phase == "reopen" {
        let bytes = import.ok_or(reject)?.0;
        if bytes.len() > 8192 {
            return Err(reject);
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| reject)?;
        if record.schema != 1
            || record.phase != "import"
            || record.status != "passed"
            || record.step != "preview"
            || record.fixture_sha256 != SHA256
            || !record.mode_saved
            || !record.preview_decoded
            || !record.backend_record_verified
            || !record.managed_copy_verified
            || !record.source_unchanged
        {
            return Err(reject);
        }
        Some(record.asset_id.ok_or(reject)?)
    } else {
        if import.is_some()
            || home
                .join("Library/Application Support/com.luckyray.desktop")
                .exists()
        {
            return Err(reject);
        }
        None
    };
    Ok(Some(FlowState {
        directory,
        home,
        source,
        phase,
        expected_id,
        injected: AtomicBool::new(false),
        recorded: AtomicBool::new(false),
    }))
}

pub(crate) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let state = match active_state() {
        Ok(Some(state)) => state,
        Ok(None) => return builder,
        Err(code) => {
            eprintln!("{code}");
            std::process::exit(2);
        }
    };
    let _ = IMPORT_PROBE.set(ImportProbe {
        source: state.source.clone(),
        observation: Mutex::new((NativeImportObservation::initial("not-observed"), None)),
    });
    builder.manage(state).on_page_load(|webview, page| {
        if webview.label() != "main" || !matches!(page.event(), tauri::webview::PageLoadEvent::Finished)
            || page.url().scheme() != "tauri" || page.url().host_str() != Some("localhost") { return; }
        let Some(state) = webview.try_state::<FlowState>() else { return; };
        if state.injected.swap(true, Ordering::AcqRel) { return; }
        let config = serde_json::json!({ "phase": state.phase, "sourcePath": state.source, "assetId": state.expected_id });
        let script = format!("({})({});", include_str!("macos_material_flow_driver.js"), config);
        if webview.eval(&script).is_err() { eprintln!("macos-material-flow-driver-unavailable"); }
    })
}

fn verify_asset(window: &tauri::WebviewWindow, state: &FlowState, id: &str) -> Result<(), ()> {
    let expected = state
        .home
        .join("Library/Application Support/com.luckyray.desktop");
    if window.path().app_data_dir().map_err(|_| ())? != expected {
        return Err(());
    }
    let backend = crate::backend_services().map_err(|_| ())?;
    if backend.app_data_dir() != expected.as_path() {
        return Err(());
    }
    let catalog = backend.material_catalog();
    let assets = catalog.get_assets(&[id.to_owned()]).map_err(|_| ())?;
    let asset = assets.first().filter(|_| assets.len() == 1).ok_or(())?;
    if asset.kind != "image"
        || asset.storage_mode != "managed"
        || asset.content_hash.as_deref() != Some(SHA256)
        || Path::new(&asset.original_path) != state.source.as_path()
        || asset.size_bytes != Some(119)
    {
        return Err(());
    }
    let path = Path::new(asset.library_path.as_deref().ok_or(())?);
    if !path.starts_with(&expected) || path == state.source.as_path() {
        return Err(());
    }
    let parent = Directory::open_owned(path.parent().ok_or(())?, false).map_err(|_| ())?;
    let (bytes, _) = parent
        .read_config(path.file_name().ok_or(())?)
        .map_err(|_| ())?
        .ok_or(())?;
    if bytes.len() != 119 || digest(&bytes) != SHA256 {
        return Err(());
    }
    let (source, _) = state
        .directory
        .read_owned(OsStr::new(SOURCE))
        .map_err(|_| ())?
        .ok_or(())?;
    if source.len() != 119 || digest(&source) != SHA256 {
        return Err(());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn macos_material_flow_report(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FlowState>,
    report: Observation,
) -> Result<(), String> {
    let reject = || "macos-material-flow-report-invalid".to_string();
    let url = window.url().map_err(|_| reject())?;
    if window.label() != "main"
        || url.scheme() != "tauri"
        || url.host_str() != Some("localhost")
        || report.phase != state.phase
        || !matches!(report.status.as_str(), "passed" | "failed")
        || !STEPS.contains(&report.step.as_str())
        || !report.dom.valid()
    {
        return Err(reject());
    }
    if let Some(id) = &report.asset_id {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(reject());
        }
    }
    let expected_step = if state.phase == "import" {
        "preview"
    } else {
        "reopen-preview"
    };
    let (native_import, imported_id) = import_observation();
    // Inspect the actual returned fixture ID even if the UI card/image timed
    // out. Backend evidence never substitutes for rendered-UI success.
    let backend_verified = report
        .asset_id
        .as_ref()
        .or(imported_id.as_ref())
        .is_some_and(|id| {
            state
                .expected_id
                .as_ref()
                .is_none_or(|expected| id == expected)
                && verify_asset(&window, &state, id).is_ok()
        });
    let passed = report.status == "passed"
        && report.step == expected_step
        && report.mode_saved
        && report.preview_decoded
        && report.asset_id.is_some()
        && backend_verified;
    let record = Record {
        schema: 1,
        phase: state.phase.clone(),
        status: if passed { "passed" } else { "failed" }.into(),
        step: if report.status == "passed" && !backend_verified {
            "backend-check".into()
        } else {
            report.step
        },
        asset_id: report.asset_id,
        mode_saved: report.mode_saved,
        preview_decoded: report.preview_decoded,
        backend_record_verified: backend_verified,
        managed_copy_verified: backend_verified,
        source_unchanged: backend_verified,
        fixture_sha256: SHA256.into(),
        dom: report.dom,
        native_import,
    };
    if state.recorded.swap(true, Ordering::AcqRel) {
        return Err(reject());
    }
    let bytes = serde_json::to_vec(&record).map_err(|_| reject())?;
    state
        .directory
        .create(OsStr::new(&format!("{}-result.json", state.phase)), &bytes)
        .map_err(|_| reject())?;
    Ok(())
}
