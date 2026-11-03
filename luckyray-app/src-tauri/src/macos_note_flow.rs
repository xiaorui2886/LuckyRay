//! Fixed synthetic UI proof. No caller-supplied pathname, script or contents.
//! Production notes mutations still run through their ordinary UI commands.
use crate::macos_fs::{digest, Directory};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

const ID: &str = "synthetic-macos-notes-flow";
const A: &[u8] = b"# Synthetic\n\nSynthetic note.\n\n![fixture](attachments/note-flow.png)\n";
const B: &[u8] = b"# Delete\n\nSynthetic delete.\n";
const IMAGE: &str = "a4307dbf28c24f349374a7d97bcb4e3856b1cf505f9d8f203c490b60200a976d";
const MARKER: &str = "Saved by the native note flow.";
const FILES: [&str; 4] = [
    "Moved/Synthetic.md",
    "Delete.md",
    "Delete-recovered.md",
    "attachments/note-flow.png",
];
const STEPS: [&str; 10] = [
    "setup", "import", "preview", "save", "move", "delete", "conflict", "recover", "reopen", "quit",
];
static ACTIVE: OnceLock<Arc<FlowState>> = OnceLock::new();
fn reject() -> String {
    "macos-note-flow-context-invalid".into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bound {
    path: String,
    device: String,
    inode: String,
    hash: String,
    bytes: usize,
}
// Only fixed classifications from the synthetic preview, never paths, URLs,
// document contents or unbounded error messages.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewInteraction {
    selection_ready_event: bool,
    target_host_matched: bool,
    click_called: bool,
    click_returned: bool,
    click_event_observed: bool,
    preview_observed_visible: bool,
}
impl PreviewInteraction {
    fn valid(&self) -> bool {
        (!self.target_host_matched || self.selection_ready_event)
            && (!self.click_called || self.target_host_matched)
            && (!self.preview_observed_visible || self.target_host_matched)
            && (!self.click_returned || self.click_called)
            && (!self.click_event_observed || self.click_called)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewObservation {
    action: String,
    synthetic_row_active: bool,
    control_present: bool,
    control_visible: bool,
    preview_present: bool,
    preview_visible: bool,
    missing_asset: bool,
    media_state: String,
    image_present: bool,
    image_visible: bool,
    image_complete: bool,
    width: u32,
    height: u32,
    uri_kind: String,
    resolution: String,
    fixture_decode: String,
    reconstructed_uri_kind: String,
    reconstructed_asset_decode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interaction: Option<PreviewInteraction>,
}
impl PreviewObservation {
    fn valid(&self) -> bool {
        ["not-entered", "already-visible", "toggle-requested"].contains(&self.action.as_str())
            && ["missing", "loading", "error", "unavailable", "other", "no-status"].contains(&self.media_state.as_str())
            && ["missing", "asset", "asset-localhost", "workspace-attachment", "blob", "data", "other"].contains(&self.uri_kind.as_str())
            && ["resolved-fixture", "resolved-other", "missing", "ambiguous", "other", "error", "timeout"].contains(&self.resolution.as_str())
            && ["passed", "wrong-size", "unsupported", "error", "timeout"].contains(&self.fixture_decode.as_str())
            && ["missing", "asset", "asset-localhost", "workspace-attachment", "blob", "data", "other"].contains(&self.reconstructed_uri_kind.as_str())
            && ["not-run", "passed", "wrong-size", "unsupported", "unexpected-uri", "error", "timeout"].contains(&self.reconstructed_asset_decode.as_str())
            && self.width <= 32768 && self.height <= 32768
            && (!self.control_visible || self.control_present)
            && (!self.preview_visible || self.preview_present)
            && (self.image_present || (!self.image_visible && !self.image_complete && self.width == 0 && self.height == 0 && self.uri_kind == "missing"))
            && (!self.image_present || self.uri_kind != "missing")
            && self.interaction.as_ref().is_none_or(PreviewInteraction::valid)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u8,
    mode: String,
    phase: String,
    status: String,
    step: String,
    ui_flags: Vec<bool>,
    backend_verified: bool,
    files: Vec<Bound>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview_observation: Option<PreviewObservation>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Quit {
    phase: String,
    normal_saved_quit: bool,
}
#[derive(Default)]
struct Progress {
    stage: usize,
    original_delete: Option<Bound>,
    foreign_delete: Option<Bound>,
    passed: bool,
}
pub(crate) struct FlowState {
    root: Directory,
    vault: Directory,
    source: Directory,
    source_path: PathBuf,
    home: PathBuf,
    phase: String,
    expected: Vec<Bound>,
    progress: Mutex<Progress>,
    recorded: AtomicBool,
    quit: AtomicBool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Observation {
    phase: String,
    step: String,
    passed: bool,
    ui_flags: Vec<bool>,
    #[serde(default)]
    preview_observation: Option<PreviewObservation>,
}

fn read(directory: &Directory, path: &str) -> Result<(Vec<u8>, Bound), String> {
    let mut parts = path.split('/').collect::<Vec<_>>();
    let name = parts.pop().ok_or_else(reject)?;
    let mut parent = None;
    for part in parts {
        parent = Some(
            parent
                .as_ref()
                .unwrap_or(directory)
                .child(OsStr::new(part), false)
                .map_err(|_| reject())?,
        );
    }
    let (bytes, v) = parent
        .as_ref()
        .unwrap_or(directory)
        .read(OsStr::new(name))
        .map_err(|_| reject())?
        .ok_or_else(reject)?;
    directory.current().map_err(|_| reject())?;
    let bound = Bound {
        path: path.into(),
        device: v.device.to_string(),
        inode: v.inode.to_string(),
        hash: v.hash,
        bytes: bytes.len(),
    };
    Ok((bytes, bound))
}
fn missing(directory: &Directory, name: &str) -> bool {
    matches!(directory.entry_info(OsStr::new(name)),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        && directory.current().is_ok()
}
fn same_object(a: &Bound, b: &Bound) -> bool {
    a.device == b.device && a.inode == b.inode && a.hash == b.hash && a.bytes == b.bytes
}
impl FlowState {
    fn sources(&self) -> Result<(), String> {
        if read(&self.source, "Synthetic.md")?.0 != A
            || read(&self.source, "Delete.md")?.0 != B
            || read(&self.source, "attachments/note-flow.png")?.1.hash != IMAGE
        {
            return Err(reject());
        }
        Ok(())
    }
    fn retained(&self, original: &Bound) -> Result<(), String> {
        for entry in self.vault.entries().map_err(|_| reject())? {
            let Some(name) = entry
                .to_str()
                .filter(|n| n.starts_with(".lrk-remove-") && n.ends_with(".backup"))
            else {
                continue;
            };
            if let Ok((_, bound)) = read(&self.vault, name) {
                if same_object(original, &bound) {
                    return Ok(());
                }
            }
        }
        Err(reject())
    }
    fn moved(&self) -> Result<(), String> {
        if !missing(&self.vault, "Synthetic.md") {
            return Err(reject());
        }
        let bytes = read(&self.vault, FILES[0])?.0;
        let text = std::str::from_utf8(&bytes).map_err(|_| reject())?;
        if !text.contains(MARKER)
            || !text.contains("../attachments/note-flow.png")
            || read(&self.vault, FILES[3])?.1.hash != IMAGE
        {
            return Err(reject());
        }
        Ok(())
    }
    fn final_files(&self, progress: &Progress) -> Result<Vec<Bound>, String> {
        self.sources()?;
        self.moved()?;
        let original = progress.original_delete.as_ref().ok_or_else(reject)?;
        let foreign = progress.foreign_delete.as_ref().ok_or_else(reject)?;
        self.retained(original)?;
        let current = read(&self.vault, FILES[1])?;
        let copy = read(&self.vault, FILES[2])?;
        if &current.1 != foreign
            || current.0 != B
            || copy.0 != B
            || same_object(&copy.1, foreign)
            || same_object(&copy.1, original)
        {
            return Err(reject());
        }
        FILES
            .iter()
            .map(|name| read(&self.vault, name).map(|(_, bound)| bound))
            .collect()
    }
    fn verify_expected(&self) -> Result<Vec<Bound>, String> {
        self.sources()?;
        self.moved()?;
        if self.expected.len() != FILES.len() {
            return Err(reject());
        }
        let now = FILES
            .iter()
            .map(|name| read(&self.vault, name).map(|(_, bound)| bound))
            .collect::<Result<Vec<_>, _>>()?;
        if now != self.expected {
            return Err(reject());
        }
        Ok(now)
    }
}
fn active_state() -> Result<Option<Arc<FlowState>>, String> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.first().and_then(|s| s.to_str()) != Some("--macos-note-flow") {
        return Ok(None);
    }
    if args.len() != 3
        || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || std::env::var("GITHUB_REPOSITORY").as_deref() != Ok("xiaorui2886/LuckyRay")
    {
        return Err(reject());
    }
    let phase = args[1]
        .to_str()
        .filter(|s| ["exercise", "reopen"].contains(s))
        .ok_or_else(reject)?
        .to_owned();
    let sha = std::env::var("GITHUB_SHA").map_err(|_| reject())?;
    if sha.len() != 40
        || !sha
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(reject());
    }
    let temp = PathBuf::from(std::env::var_os("RUNNER_TEMP").ok_or_else(reject)?);
    let app = temp.join("luckyray-macos-internal/luckyray-app");
    let path = PathBuf::from(&args[2]);
    let suffix = path
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix("notes-flow-"))
        .ok_or_else(reject)?;
    if !temp.is_absolute()
        || path.parent() != Some(app.join("src-tauri/target").as_path())
        || suffix.len() != 36
        || !suffix
            .bytes()
            .all(|c| c == b'-' || c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || std::env::current_dir().map_err(|_| reject())? != app
    {
        return Err(reject());
    }
    let home = path.join("profile");
    if std::env::var_os("HOME").as_deref() != Some(home.as_os_str()) {
        return Err(reject());
    }
    let root = Directory::open(&path, false, true).map_err(|_| reject())?;
    Directory::open(&home, false, true).map_err(|_| reject())?;
    let vault = root
        .child(OsStr::new("vault"), false)
        .map_err(|_| reject())?;
    let source = root
        .child(OsStr::new("source"), false)
        .map_err(|_| reject())?;
    let registration = read(&vault, ".luckyray/vault.json")?.0;
    let registration: crate::knowledge::KnowledgeVaultRegistration =
        serde_json::from_slice(&registration).map_err(|_| reject())?;
    if registration.id != ID
        || registration.name != "Synthetic notes flow"
        || Path::new(&registration.root_path) != path.join("vault")
    {
        return Err(reject());
    }
    let mut expected = Vec::new();
    if phase == "reopen" {
        let record: Record = serde_json::from_slice(&read(&root, "exercise-result.json")?.0)
            .map_err(|_| reject())?;
        let quit: Quit =
            serde_json::from_slice(&read(&root, "exercise-quit.json")?.0).map_err(|_| reject())?;
        if record.schema_version != 1
            || record.mode != "macos-note-flow"
            || record.phase != "exercise"
            || record.status != "passed"
            || record.step != "recover"
            || record.ui_flags != [true; 7]
            || !record.backend_verified
            || quit.phase != "exercise"
            || !quit.normal_saved_quit
            || record
                .files
                .iter()
                .map(|b| b.path.as_str())
                .collect::<Vec<_>>()
                != FILES
        {
            return Err(reject());
        }
        expected = record.files;
    } else if !missing(&root, "exercise-result.json")
        || !missing(&vault, "Synthetic.md")
        || !missing(&vault, "Delete.md")
    {
        return Err(reject());
    }
    let state = Arc::new(FlowState {
        root,
        vault,
        source,
        source_path: path.join("source"),
        home,
        phase,
        expected,
        progress: Mutex::new(Progress::default()),
        recorded: AtomicBool::new(false),
        quit: AtomicBool::new(false),
    });
    state.sources()?;
    if state.phase == "reopen" {
        state.verify_expected()?;
    }
    Ok(Some(state))
}
pub(crate) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let state = match active_state() {
        Ok(Some(s)) => s,
        Ok(None) => return builder,
        Err(_) => {
            eprintln!("macos-note-flow-context-invalid");
            std::process::exit(2);
        }
    };
    if ACTIVE.set(state.clone()).is_err() {
        std::process::exit(2);
    }
    let injected = AtomicBool::new(false);
    builder.manage(state).on_page_load(move |webview,page| {
        if webview.label()!="main" || !matches!(page.event(),tauri::webview::PageLoadEvent::Finished)
            || page.url().scheme()!="tauri" || page.url().host_str()!=Some("localhost") || injected.swap(true,Ordering::AcqRel) {return;}
        let Some(state)=ACTIVE.get() else {return};
        let app=webview.app_handle().clone();
        std::thread::spawn(move || {
            let mut byte=[0u8;1];
            // Parent cancellation/EOF uses the real saved-quit path. The
            // observer records cancellation as failure even if cleanup succeeds.
            if std::io::stdin().read(&mut byte).ok()!=Some(1) || byte[0]==b'C' {
                crate::request_normal_quit(app,false);
            }
        });
        let config=serde_json::json!({"phase":state.phase,"sourcePaths":[state.source_path.join("Synthetic.md"),state.source_path.join("Delete.md")]});
        let script=format!("({})({});",include_str!("macos_note_flow_driver.js"),config);
        if webview.eval(&script).is_err() {eprintln!("macos-note-flow-driver-unavailable");}
    })
}
fn caller(window: &tauri::WebviewWindow, state: &FlowState) -> Result<(), String> {
    let url = window.url().map_err(|_| reject())?;
    let expected = state
        .home
        .join("Library/Application Support/com.luckyray.desktop");
    if window.label() != "main"
        || url.scheme() != "tauri"
        || url.host_str() != Some("localhost")
        || window.path().app_data_dir().map_err(|_| reject())? != expected
        || crate::backend_services()
            .map_err(|_| reject())?
            .app_data_dir()
            != expected.as_path()
        || crate::knowledge_service()
            .map_err(|_| reject())?
            .current_vault_id()
            .map_err(|_| reject())?
            != ID
        || crate::knowledge_service()
            .map_err(|_| reject())?
            .attachment_handling_policy(ID)
            .map_err(|_| reject())?
            != "copy"
    {
        return Err(reject());
    }
    state.root.current().map_err(|_| reject())?;
    state.vault.current().map_err(|_| reject())?;
    state.sources()
}
#[tauri::command]
pub(crate) fn macos_note_flow_checkpoint(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<FlowState>>,
    stage: String,
) -> Result<bool, String> {
    caller(&window, &state)?;
    if state.recorded.load(Ordering::Acquire) {
        return Err(reject());
    }
    if state.phase == "reopen" {
        return if stage == "reopened" {
            Ok(state.verify_expected().is_ok())
        } else {
            Err(reject())
        };
    }
    let mut progress = state.progress.lock().map_err(|_| reject())?;
    let order = [
        "imported",
        "saved",
        "moved",
        "deleted",
        "install-conflict",
        "conflict-observed",
        "recovered",
    ];
    let index = order.iter().position(|s| *s == stage).ok_or_else(reject)?;
    if index < progress.stage {
        return Ok(true);
    }
    if index != progress.stage {
        return Err(reject());
    }
    let result = (|| -> Result<(), String> {
        match index {
            0 => {
                let a = read(&state.vault, "Synthetic.md")?.0;
                let b = read(&state.vault, "Delete.md")?;
                if !std::str::from_utf8(&a)
                    .map_err(|_| reject())?
                    .contains("note-flow.png")
                    || b.0 != B
                    || read(&state.vault, FILES[3])?.1.hash != IMAGE
                {
                    return Err(reject());
                }
                progress.original_delete = Some(b.1);
            }
            1 => {
                if !std::str::from_utf8(&read(&state.vault, "Synthetic.md")?.0)
                    .map_err(|_| reject())?
                    .contains(MARKER)
                {
                    return Err(reject());
                }
            }
            2 => state.moved()?,
            3 => {
                if !missing(&state.vault, "Delete.md") {
                    return Err(reject());
                }
                state.retained(progress.original_delete.as_ref().ok_or_else(reject)?)?;
            }
            4 => {
                let original = progress.original_delete.as_ref().ok_or_else(reject)?;
                state.retained(original)?;
                if !missing(&state.vault, "Delete.md") {
                    return Err(reject());
                }
                // Single fixed foreign publication, not a retryable product operation.
                // O_EXCL/nofollow; never replace an existing object on failure.
                let file = state
                    .vault
                    .create(OsStr::new("Delete.md"), B)
                    .map_err(|_| reject())?;
                let foreign = read(&state.vault, "Delete.md")?.1;
                let meta = file.metadata().map_err(|_| reject())?;
                if foreign.device != meta.dev().to_string()
                    || foreign.inode != meta.ino().to_string()
                    || same_object(original, &foreign)
                {
                    return Err(reject());
                }
                progress.foreign_delete = Some(foreign);
            }
            5 => {
                let snapshot = crate::knowledge_service()
                    .map_err(|_| reject())?
                    .note_recovery_snapshot(ID, false)
                    .map_err(|_| reject())?;
                if !snapshot.records.iter().any(|r| {
                    r.original_path == "Delete.md"
                        && !r.can_restore
                        && r.versions
                            .iter()
                            .any(|v| v.slot == "retained" && v.revision == digest(B))
                }) {
                    return Err(reject());
                }
                if &read(&state.vault, "Delete.md")?.1
                    != progress.foreign_delete.as_ref().ok_or_else(reject)?
                {
                    return Err(reject());
                }
            }
            6 => {
                state.final_files(&progress)?;
            }
            _ => return Err(reject()),
        }
        Ok(())
    })();
    if result.is_err() {
        return if index == 4 {
            Err("macos-note-flow-conflict-unconfirmed".into())
        } else {
            Ok(false)
        };
    }
    progress.stage += 1;
    Ok(true)
}
#[tauri::command]
pub(crate) fn macos_note_flow_report(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<FlowState>>,
    report: Observation,
) -> Result<(), String> {
    caller(&window, &state)?;
    if report.phase != state.phase
        || !STEPS.contains(&report.step.as_str())
        || report.ui_flags.len() != if state.phase == "exercise" { 7 } else { 3 }
        || report.preview_observation.as_ref().is_some_and(|value| !value.valid())
        || report.preview_observation.is_some() && (report.passed || report.step != "preview")
        || state.recorded.swap(true, Ordering::AcqRel)
    {
        return Err(reject());
    }
    let mut progress = state.progress.lock().map_err(|_| reject())?;
    let files = if state.phase == "exercise" {
        if progress.stage == 7 {
            state.final_files(&progress).ok()
        } else {
            None
        }
    } else {
        state.verify_expected().ok()
    };
    let backend_verified = files.is_some();
    let passed = report.passed
        && report.ui_flags.iter().all(|b| *b)
        && backend_verified
        && report.step
            == if state.phase == "exercise" {
                "recover"
            } else {
                "reopen"
            };
    let record = Record {
        schema_version: 1,
        mode: "macos-note-flow".into(),
        phase: state.phase.clone(),
        status: if passed { "passed" } else { "failed" }.into(),
        step: report.step,
        ui_flags: report.ui_flags,
        backend_verified,
        files: files.unwrap_or_default(),
        preview_observation: report.preview_observation,
    };
    let bytes = serde_json::to_vec(&record).map_err(|_| reject())?;
    state
        .root
        .create(OsStr::new(&format!("{}-result.json", state.phase)), &bytes)
        .map_err(|_| reject())?;
    progress.passed = passed;
    Ok(())
}
pub(crate) fn finish_quit(result: Result<(), &'static str>, restart: bool) -> bool {
    let Some(state) = ACTIVE.get() else {
        return true;
    };
    if state.quit.swap(true, Ordering::AcqRel) {
        return false;
    }
    let normal = result.is_ok()
        && !restart
        && crate::NORMAL_QUIT_COMPLETED.load(Ordering::Acquire)
        && state.progress.lock().is_ok_and(|p| p.passed);
    let record = Quit {
        phase: state.phase.clone(),
        normal_saved_quit: normal,
    };
    serde_json::to_vec(&record)
        .ok()
        .and_then(|bytes| {
            state
                .root
                .create(OsStr::new(&format!("{}-quit.json", state.phase)), &bytes)
                .ok()
        })
        .is_some()
        && normal
}
