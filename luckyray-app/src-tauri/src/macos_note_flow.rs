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
const FOLDER_NOTE: &[u8] = b"# FolderNote\n\nSynthetic folder child.\n\n![fixture](attachments/folder-flow.png)\n";
const FOLDER_MARKER: &str = "Unsaved folder draft preserved.";
const IMAGE: &str = "a4307dbf28c24f349374a7d97bcb4e3856b1cf505f9d8f203c490b60200a976d";
const MARKER: &str = "Saved by the native note flow.";
const FILES: [&str; 6] = [
    "Moved/Synthetic.md",
    "Delete.md",
    "Delete-recovered.md",
    "attachments/note-flow.png",
    "Destination/Renamed/FolderNote.md",
    "Destination/Renamed/attachments/folder-flow.png",
];
const STEPS: [&str; 16] = [
    "setup", "import", "preview", "save", "move", "delete", "conflict", "recover",
    "folder-dirty", "folder-rename", "folder-move", "folder-delete", "folder-restore", "graph", "reopen", "quit",
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
// Fixed synthetic UI classifications; a stage identifies the action being
// attempted, not proof that the preceding click reached the application.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveUiObservation {
    stage: String,
    synthetic_row_has_box: bool,
    move_action_has_box: bool,
    move_target_has_box: bool,
    moved_chevron_has_box: bool,
    moved_chevron_open: bool,
    original_row_has_box: bool,
    moved_row_has_box: bool,
    #[serde(default)]
    selection_click_called: bool,
    #[serde(default)]
    selection_click_returned: bool,
    #[serde(default)]
    selection_ready_event: bool,
    #[serde(default)]
    destination_row_active: bool,
    #[serde(default)]
    destination_host_visible: bool,
}
impl MoveUiObservation {
    fn valid(&self) -> bool {
        ["context-menu", "move-menu", "destination", "checkpoint", "open-folder", "select-moved", "preview-moved",
            "rename-menu", "rename-input", "rename-checkpoint", "restore-menu", "restore-input", "restore-checkpoint"]
            .contains(&self.stage.as_str())
            && (!self.moved_chevron_open || self.moved_chevron_has_box)
            && (!self.selection_click_returned || self.selection_click_called)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveNativeObservation {
    checkpoint_passed: bool,
    source_missing_verified: bool,
    destination_read_verified: bool,
    saved_marker_verified: bool,
    rewritten_link_verified: bool,
    attachment_hash_verified: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveObservation {
    ui: MoveUiObservation,
    native: MoveNativeObservation,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteUiObservation {
    stage: String,
    delete_row_has_box: bool,
    delete_action_has_box: bool,
    confirm_has_box: bool,
}
impl DeleteUiObservation {
    fn valid(&self) -> bool {
        ["context-menu", "delete-menu", "confirm", "checkpoint", "tree-update"]
            .contains(&self.stage.as_str())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteNativeObservation {
    checkpoint_passed: bool,
    source_missing_verified: bool,
    retained_original_verified: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteObservation {
    ui: DeleteUiObservation,
    native: DeleteNativeObservation,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportUiObservation {
    stage: String,
    root_has_box: bool,
    synthetic_row_has_box: bool,
    delete_row_has_box: bool,
    transfer_created: bool,
    files_added: bool,
    drop_dispatched: bool,
    drop_default_prevented: bool,
}
impl ImportUiObservation {
    fn valid(&self) -> bool {
        ["close-settings", "construct-transfer", "populate-transfer", "dispatch-drop", "wait-tree", "checkpoint"]
            .contains(&self.stage.as_str())
            && (!self.files_added || self.transfer_created)
            && (!self.drop_dispatched || self.files_added)
            && (!self.drop_default_prevented || self.drop_dispatched)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportNativeObservation {
    checkpoint_passed: bool,
    synthetic_content_verified: bool,
    delete_content_verified: bool,
    attachment_hash_verified: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportObservation {
    ui: ImportUiObservation,
    native: ImportNativeObservation,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryUiObservation {
    stage: String,
    selection_click_called: bool,
    selection_click_returned: bool,
    selection_ready_event: bool,
    recovered_row_has_box: bool,
    recovered_row_active: bool,
    recovered_host_visible: bool,
    source_control_has_box: bool,
    source_textarea_has_box: bool,
    recovered_content_verified: bool,
}
impl RecoveryUiObservation {
    fn valid(&self) -> bool {
        ["destination", "copy", "copy-status", "checkpoint", "close-recovery", "refresh-open", "refresh-action", "refresh-close",
            "select-recovered", "source-control", "recovered-content", "open-moved", "preview-moved"]
            .contains(&self.stage.as_str())
            && (!self.selection_click_returned || self.selection_click_called)
            && (!self.recovered_row_active || self.recovered_row_has_box)
            && (!self.recovered_content_verified || self.source_textarea_has_box)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryNativeObservation {
    checkpoint_passed: bool,
    recovered_copy_verified: bool,
    foreign_original_verified: bool,
    retained_original_verified: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryObservation {
    ui: RecoveryUiObservation,
    native: RecoveryNativeObservation,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FolderUiObservation {
    stage: String,
    product_stage: String,
    failure: String,
    unsaved: bool,
    save_pending: bool,
    operation_pending: bool,
    rename_action_present: bool,
    rename_input_present: bool,
    rename_value_correct: bool,
    source_folder_present: bool,
    renamed_folder_present: bool,
    moved_folder_present: bool,
    source_host_visible: bool,
    renamed_host_visible: bool,
    moved_host_visible: bool,
    renamed_row_active: bool,
    moved_row_active: bool,
    draft_marker_visible: bool,
    preview_decoded: bool,
    recovery_panel_present: bool,
    restore_enabled: bool,
    graph_pane_present: bool,
    graph_search_new_path: bool,
}
impl FolderUiObservation {
    fn valid(&self) -> bool {
        ["not-entered", "dirty-open", "dirty-input", "dirty-menu", "dirty-veto", "dirty-checkpoint", "save-request", "save-checkpoint", "save-idle",
            "rename-menu", "rename-input", "rename-submit", "rename-checkpoint", "rename-open", "rename-host", "rename-source-retired",
            "move-menu", "move-destination", "move-checkpoint", "move-open", "move-host", "move-source-retired", "attachment-preview",
            "delete-menu", "delete-confirm", "delete-checkpoint", "delete-tree", "restore-panel", "restore-refresh", "restore-action", "restore-checkpoint", "restore-tree",
            "graph-open", "graph-canvas", "graph-search", "graph-select", "graph-checkpoint", "return-note", "reopen-note", "reopen-marker", "reopen-folder", "reopen-checkpoint"]
            .contains(&self.stage.as_str())
            && ["idle", "preparing", "ready", "running", "completed", "interrupted", "blocked-draft", "unknown"].contains(&self.product_stage.as_str())
            && ["wait-timeout", "checkpoint-context", "stale-source-host", "stale-moved-host", "draft-not-preserved", "reopen-draft-missing", "graph-stale-path", "other"].contains(&self.failure.as_str())
            && (!self.rename_value_correct || self.rename_input_present)
            && (!self.graph_search_new_path || self.graph_pane_present)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FolderNativeObservation {
    checkpoint_count: usize,
    source_directory_original: bool,
    renamed_directory_original: bool,
    moved_directory_original: bool,
    source_note_matches_saved: bool,
    renamed_note_matches_saved: bool,
    moved_note_matches_saved: bool,
    source_image_original: bool,
    renamed_image_original: bool,
    moved_image_original: bool,
    empty_directory_original: bool,
    empty_directory_missing: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FolderObservation {
    ui: FolderUiObservation,
    native: FolderNativeObservation,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    move_observation: Option<MoveObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delete_observation: Option<DeleteObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    import_observation: Option<ImportObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_observation: Option<RecoveryObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folder_observation: Option<FolderObservation>,
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
    moved_baseline: Option<Bound>,
    rename_seen: bool,
    rename_roundtrip: bool,
    original_delete: Option<Bound>,
    foreign_delete: Option<Bound>,
    folder_note: Option<Bound>,
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
    initial_folder_note: Option<Bound>,
    initial_folder_image: Option<Bound>,
    initial_folder_identity: Option<(u64, u64)>,
    empty_folder_identity: (u64, u64),
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
    #[serde(default)]
    move_observation: Option<MoveUiObservation>,
    #[serde(default)]
    delete_observation: Option<DeleteUiObservation>,
    #[serde(default)]
    import_observation: Option<ImportUiObservation>,
    #[serde(default)]
    recovery_observation: Option<RecoveryUiObservation>,
    #[serde(default)]
    folder_observation: Option<FolderUiObservation>,
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
pub(crate) fn missing(directory: &Directory, path: &str) -> bool {
    let mut parts = path.split('/').collect::<Vec<_>>();
    let Some(name) = parts.pop() else { return false; };
    let mut parent = None;
    for part in parts {
        parent = match parent.as_ref().unwrap_or(directory).child(OsStr::new(part), false) {
            Ok(child) => Some(child),
            Err(_) => return false,
        };
    }
    let parent = parent.as_ref().unwrap_or(directory);
    matches!(parent.entry_info(OsStr::new(name)),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        && parent.current().is_ok() && directory.current().is_ok()
}
fn same_object(a: &Bound, b: &Bound) -> bool {
    a.device == b.device && a.inode == b.inode && a.hash == b.hash && a.bytes == b.bytes
}
fn folder(directory: &Directory, path: &str) -> Result<Directory, String> {
    let mut current = directory.try_clone().map_err(|_| reject())?;
    for part in path.split('/') {
        current = current.child(OsStr::new(part), false).map_err(|_| reject())?;
    }
    current.current().map_err(|_| reject())?;
    Ok(current)
}
fn folder_identity(directory: &Directory, path: &str) -> Result<(u64, u64), String> {
    let current = folder(directory, path)?;
    let metadata = current.identity_file().and_then(|file| file.metadata()).map_err(|_| reject())?;
    current.current().map_err(|_| reject())?;
    Ok((metadata.dev(), metadata.ino()))
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
    fn note_files(&self, progress: &Progress) -> Result<Vec<Bound>, String> {
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
            .take(4)
            .map(|name| read(&self.vault, name).map(|(_, bound)| bound))
            .collect()
    }
    fn final_files(&self, progress: &Progress) -> Result<Vec<Bound>, String> {
        let mut files = self.note_files(progress)?;
        let moved = read(&self.vault, FILES[4])?.1;
        let image = read(&self.vault, FILES[5])?.1;
        if !progress.folder_note.as_ref().is_some_and(|base| same_object(base, &moved))
            || !self.initial_folder_image.as_ref().is_some_and(|base| same_object(base, &image))
            || self.initial_folder_identity != Some(folder_identity(&self.vault, "Destination/Renamed")?)
            || !missing(&self.vault, "Folder") || !missing(&self.vault, "Renamed")
            || folder_identity(&self.vault, "FolderEmpty")? != self.empty_folder_identity
            || !folder(&self.vault, "FolderEmpty")?.entries().map_err(|_| reject())?.is_empty()
        {
            return Err(reject());
        }
        files.push(moved);
        files.push(image);
        Ok(files)
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
        if !missing(&self.vault, "Folder") || !missing(&self.vault, "Renamed")
            || !folder(&self.vault, "FolderEmpty")?.entries().map_err(|_| reject())?.is_empty()
        {
            return Err(reject());
        }
        Ok(now)
    }
    fn graph_paths(&self) -> Result<(), String> {
        let snapshot = crate::knowledge_service().map_err(|_| reject())?
            .refresh_index().map_err(|_| reject())?;
        if snapshot.vault_id != ID
            || !snapshot.documents.iter().any(|document| document.relative_path == FILES[4])
            || snapshot.documents.iter().any(|document| document.relative_path.starts_with("Folder/")
                || document.relative_path.starts_with("Renamed/"))
        {
            return Err(reject());
        }
        Ok(())
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
            || record.step != "graph"
            || record.ui_flags != [true; 15]
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
    let (initial_folder_note, initial_folder_image, initial_folder_identity) = if phase == "exercise" {
        let original = read(&vault, "Folder/FolderNote.md")?;
        let image = read(&vault, "Folder/attachments/folder-flow.png")?.1;
        if original.0 != FOLDER_NOTE
            || image.hash != IMAGE
            || !folder(&vault, "FolderEmpty")?.entries().map_err(|_| reject())?.is_empty()
        {
            return Err(reject());
        }
        (Some(original.1), Some(image), Some(folder_identity(&vault, "Folder")?))
    } else { (None, None, None) };
    let empty_folder_identity = folder_identity(&vault, "FolderEmpty")?;
    let state = Arc::new(FlowState {
        root,
        vault,
        source,
        source_path: path.join("source"),
        home,
        phase,
        expected,
        initial_folder_note,
        initial_folder_image,
        initial_folder_identity,
        empty_folder_identity,
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
            Ok(state.verify_expected().is_ok() && state.graph_paths().is_ok())
        } else {
            Err(reject())
        };
    }
    let mut progress = state.progress.lock().map_err(|_| reject())?;
    if stage == "renamed" {
        if progress.stage != 3 || progress.rename_roundtrip || !missing(&state.vault, FILES[0]) {
            return Ok(false);
        }
        let valid = read(&state.vault, "Moved/Renamed.md").is_ok_and(|(_, bound)|
            progress.moved_baseline.as_ref().is_some_and(|base| bound.hash == base.hash && bound.bytes == base.bytes))
            && read(&state.vault, FILES[3]).is_ok_and(|(_, bound)| bound.hash == IMAGE);
        if valid { progress.rename_seen = true; }
        return Ok(valid);
    }
    if stage == "rename-restored" {
        if progress.stage != 3 || !progress.rename_seen || !missing(&state.vault, "Moved/Renamed.md") {
            return Ok(false);
        }
        let valid = state.moved().is_ok() && read(&state.vault, FILES[0]).is_ok_and(|(_, bound)|
            progress.moved_baseline.as_ref().is_some_and(|base| bound.hash == base.hash && bound.bytes == base.bytes));
        if valid { progress.rename_roundtrip = true; }
        return Ok(valid);
    }
    let order = [
        "imported",
        "saved",
        "moved",
        "deleted",
        "install-conflict",
        "conflict-observed",
        "recovered",
        "folder-dirty-blocked",
        "folder-saved",
        "folder-renamed",
        "folder-moved",
        "folder-deleted",
        "folder-restored",
        "graph-ready",
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
            2 => {
                state.moved()?;
                progress.moved_baseline = Some(read(&state.vault, FILES[0])?.1);
            }
            3 => {
                if !progress.rename_roundtrip { return Err(reject()); }
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
                state.note_files(&progress)?;
            }
            7 => {
                if read(&state.vault, "Folder/FolderNote.md")?.1
                    != *state.initial_folder_note.as_ref().ok_or_else(reject)?
                    || state.initial_folder_identity != Some(folder_identity(&state.vault, "Folder")?)
                    || !missing(&state.vault, "Renamed")
                {
                    return Err(reject());
                }
            }
            8 => {
                let (bytes, bound) = read(&state.vault, "Folder/FolderNote.md")?;
                if !bytes.starts_with(FOLDER_NOTE)
                    || !std::str::from_utf8(&bytes).map_err(|_| reject())?.contains(FOLDER_MARKER)
                {
                    return Err(reject());
                }
                progress.folder_note = Some(bound);
            }
            9 => {
                let moved = read(&state.vault, "Renamed/FolderNote.md")?.1;
                if !missing(&state.vault, "Folder")
                    || state.initial_folder_identity != Some(folder_identity(&state.vault, "Renamed")?)
                    || !progress.folder_note.as_ref().is_some_and(|base| same_object(base, &moved))
                {
                    return Err(reject());
                }
            }
            10 => {
                let moved = read(&state.vault, FILES[4])?.1;
                if !missing(&state.vault, "Renamed")
                    || state.initial_folder_identity != Some(folder_identity(&state.vault, "Destination/Renamed")?)
                    || !progress.folder_note.as_ref().is_some_and(|base| same_object(base, &moved))
                {
                    return Err(reject());
                }
            }
            11 => {
                if !missing(&state.vault, "FolderEmpty") { return Err(reject()); }
            }
            12 => {
                if folder_identity(&state.vault, "FolderEmpty")? != state.empty_folder_identity
                    || !folder(&state.vault, "FolderEmpty")?.entries().map_err(|_| reject())?.is_empty() {
                    return Err(reject());
                }
            }
            13 => {
                state.final_files(&progress)?;
                state.graph_paths()?;
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
        || report.ui_flags.len() != if state.phase == "exercise" { 15 } else { 6 }
        || report.preview_observation.as_ref().is_some_and(|value| !value.valid())
        || report.preview_observation.is_some() && (report.passed || report.step != "preview")
        || report.move_observation.as_ref().is_some_and(|value| !value.valid())
        || report.move_observation.is_some() && (report.passed || report.step != "move" || state.phase != "exercise")
        || report.delete_observation.as_ref().is_some_and(|value| !value.valid())
        || report.delete_observation.is_some() && (report.passed || report.step != "delete" || state.phase != "exercise")
        || report.import_observation.as_ref().is_some_and(|value| !value.valid())
        || report.import_observation.is_some() && (report.passed || report.step != "import" || state.phase != "exercise")
        || report.recovery_observation.as_ref().is_some_and(|value| !value.valid())
        || report.recovery_observation.is_some() && (report.passed || report.step != "recover" || state.phase != "exercise")
        || report.folder_observation.as_ref().is_some_and(|value| !value.valid())
        || report.folder_observation.is_some() && (report.passed || !report.step.starts_with("folder-") && !["graph", "reopen"].contains(&report.step.as_str()))
        || state.recorded.swap(true, Ordering::AcqRel)
    {
        return Err(reject());
    }
    let mut progress = state.progress.lock().map_err(|_| reject())?;
    // Reads are confined to the same fixed fixture and use the existing
    // no-follow, identity-checked helpers. False means "not verified".
    let move_observation = report.move_observation.map(|ui| {
        let destination = read(&state.vault, FILES[0]).ok();
        let text = destination.as_ref().and_then(|(bytes, _)| std::str::from_utf8(bytes).ok());
        MoveObservation {
            ui,
            native: MoveNativeObservation {
                checkpoint_passed: progress.stage >= 3,
                source_missing_verified: missing(&state.vault, "Synthetic.md"),
                destination_read_verified: destination.is_some(),
                saved_marker_verified: text.is_some_and(|value| value.contains(MARKER)),
                rewritten_link_verified: text.is_some_and(|value| value.contains("../attachments/note-flow.png")),
                attachment_hash_verified: read(&state.vault, FILES[3]).is_ok_and(|(_, bound)| bound.hash == IMAGE),
            },
        }
    });
    let delete_observation = report.delete_observation.map(|ui| DeleteObservation {
        ui,
        native: DeleteNativeObservation {
            checkpoint_passed: progress.stage >= 4,
            source_missing_verified: missing(&state.vault, "Delete.md"),
            retained_original_verified: progress.original_delete.as_ref().is_some_and(|original| state.retained(original).is_ok()),
        },
    });
    let import_observation = report.import_observation.map(|ui| ImportObservation {
        ui,
        native: ImportNativeObservation {
            checkpoint_passed: progress.stage >= 1,
            synthetic_content_verified: read(&state.vault, "Synthetic.md").is_ok_and(|(bytes, _)|
                std::str::from_utf8(&bytes).is_ok_and(|value| value.contains("note-flow.png"))),
            delete_content_verified: read(&state.vault, "Delete.md").is_ok_and(|(bytes, _)| bytes == B),
            attachment_hash_verified: read(&state.vault, FILES[3]).is_ok_and(|(_, bound)| bound.hash == IMAGE),
        },
    });
    let recovery_observation = report.recovery_observation.map(|ui| RecoveryObservation {
        ui,
        native: RecoveryNativeObservation {
            checkpoint_passed: progress.stage >= 7,
            recovered_copy_verified: read(&state.vault, FILES[2]).is_ok_and(|(bytes, _)| bytes == B),
            foreign_original_verified: read(&state.vault, FILES[1]).is_ok_and(|(bytes, bound)|
                bytes == B && progress.foreign_delete.as_ref().is_some_and(|expected| &bound == expected)),
            retained_original_verified: progress.original_delete.as_ref().is_some_and(|original| state.retained(original).is_ok()),
        },
    });
    let folder_observation = report.folder_observation.map(|ui| {
        let original_directory = |path| folder_identity(&state.vault, path).ok()
            .is_some_and(|identity| Some(identity) == state.initial_folder_identity);
        let saved_note = |path| read(&state.vault, path).ok().is_some_and(|(_, current)|
            progress.folder_note.as_ref().or_else(|| state.expected.get(4)).is_some_and(|base| same_object(base, &current)));
        let original_image = |path| read(&state.vault, path).ok().is_some_and(|(_, current)|
            state.initial_folder_image.as_ref().or_else(|| state.expected.get(5)).is_some_and(|base| same_object(base, &current)));
        FolderObservation { ui, native: FolderNativeObservation {
            checkpoint_count: progress.stage,
            source_directory_original: original_directory("Folder"),
            renamed_directory_original: original_directory("Renamed"),
            moved_directory_original: original_directory("Destination/Renamed"),
            source_note_matches_saved: saved_note("Folder/FolderNote.md"),
            renamed_note_matches_saved: saved_note("Renamed/FolderNote.md"),
            moved_note_matches_saved: saved_note(FILES[4]),
            source_image_original: original_image("Folder/attachments/folder-flow.png"),
            renamed_image_original: original_image("Renamed/attachments/folder-flow.png"),
            moved_image_original: original_image(FILES[5]),
            empty_directory_original: folder_identity(&state.vault, "FolderEmpty").ok() == Some(state.empty_folder_identity),
            empty_directory_missing: missing(&state.vault, "FolderEmpty"),
        } }
    });
    let files = if state.phase == "exercise" {
        if progress.stage == 14 {
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
                "graph"
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
        move_observation,
        delete_observation,
        import_observation,
        recovery_observation,
        folder_observation,
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
