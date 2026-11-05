//! Mac folder transactions. A durable, authenticated intent precedes the
//! one-shot scoped worker's GO. Inspection never resumes an unknown mutation:
//! it reports where the recorded directory is, or leaves it for manual review.
//! Empty-folder deletion retains the same directory object for explicit undo.
use super::{error, safe_relative_directory, safe_relative_path, KnowledgeError, KnowledgeService};
use crate::macos_fs::{require_empty_acl, Directory};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

const MAGIC: u32 = 0x4c52464d;
const STORE: &str = "folder-operations";
const RETAINED: &str = "folder-retained";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderMutationResult {
    pub operation_id: String,
    pub state: String,
    pub operation: String,
    pub old_relative_path: String,
    pub new_relative_path: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderRecoveryItem {
    #[serde(flatten)]
    pub result: FolderMutationResult,
    pub can_restore: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Object {
    device: u64,
    inode: u64,
    birth_seconds: i64,
    birth_nanos: i64,
}
impl Object {
    fn of(directory: &Directory) -> io::Result<Self> {
        let metadata = directory.identity_file()?.metadata()?;
        let birth = metadata.created()?.duration_since(UNIX_EPOCH).map_err(|_| invalid())?;
        Ok(Self {
            device: metadata.dev(), inode: metadata.ino(),
            birth_seconds: i64::try_from(birth.as_secs()).map_err(|_| invalid())?,
            birth_nanos: birth.subsec_nanos().into(),
        })
    }
    fn write(self, bytes: &mut Vec<u8>) {
        bytes.extend_from_slice(&self.device.to_le_bytes());
        bytes.extend_from_slice(&self.inode.to_le_bytes());
        bytes.extend_from_slice(&self.birth_seconds.to_le_bytes());
        bytes.extend_from_slice(&self.birth_nanos.to_le_bytes());
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u32,
    id: String,
    operation: String,
    source: String,
    destination: String,
    root: Object,
    source_parent: Object,
    target_parent: Object,
    object: Object,
    #[serde(default)]
    restores: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedIntent { intent: Intent, mac: String }

// A read-only UI observation, not an authorization token. The source epoch and
// active Vault still authorize the operation; this prevents a confirmation
// dialog from silently switching to a newly-created object at the same name.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection { path: String, root: Object, parent: Object, object: Object }

fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "folder-object-conflict") }
fn unavailable() -> KnowledgeError {
    error("knowledge-folder-unavailable", "Folder objects or recovery records changed; existing data has been preserved")
}
fn path_string(path: &Path) -> io::Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(invalid)
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn relative(value: &str, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty()) && !value.starts_with('/') && !value.contains(['\\', '\0'])
        && (value.is_empty() || value.split('/').all(|p| !p.is_empty() && p != "." && p != ".."))
}
fn folder_name(value: &str) -> Result<&str, KnowledgeError> {
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if value.is_empty() || value != value.trim() || value.len() > 240 || value.ends_with('.')
        || value.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        || matches!(value, "." | "..") || value.eq_ignore_ascii_case(".luckyray") || reserved {
        return Err(error("knowledge-path-invalid", "Folder name is invalid"));
    }
    Ok(value)
}

struct Store {
    root: Directory,
    directory: Directory,
    key: [u8; 32],
}
impl Store {
    fn open(root: &Path, app_data: &Path, create: bool) -> io::Result<Self> {
        let root = Directory::open(root, false, false)?;
        let metadata = root.child(OsStr::new(".luckyray"), false)?;
        let directory = metadata.child(OsStr::new(STORE), create)?;
        let file = directory.identity_file()?;
        let mode = file.metadata()?;
        if mode.uid() != unsafe { libc::geteuid() } || mode.mode() & 0o777 != 0o700 {
            return Err(invalid());
        }
        require_empty_acl(&file)?;
        // A missing store is an empty history. A missing key beside an existing
        // store is unavailable history, not an empty list or a reset authority.
        let key = super::macos_recovery_key::load(app_data, create).map_err(|_| invalid())?;
        Ok(Self { root, directory, key })
    }
    fn save(&self, intent: &Intent) -> io::Result<()> {
        let encoded = serde_json::to_vec(intent).map_err(|_| invalid())?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| invalid())?;
        mac.update(b"luckyray-macos-folder-intent-v1\0"); mac.update(&encoded);
        let record = SignedIntent { intent: intent.clone(), mac: STANDARD.encode(mac.finalize().into_bytes()) };
        let bytes = serde_json::to_vec(&record).map_err(|_| invalid())?;
        self.root.current()?;
        self.directory.create(OsStr::new(&format!("{}.json", intent.id)), &bytes)?;
        self.root.current()
    }
    fn read(&self, id: &str) -> io::Result<Intent> {
        if !valid_id(id) { return Err(invalid()); }
        self.root.current()?;
        let (bytes, _) = self.directory.read_owned(OsStr::new(&format!("{id}.json")))?.ok_or_else(invalid)?;
        let record: SignedIntent = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let encoded = serde_json::to_vec(&record.intent).map_err(|_| invalid())?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| invalid())?;
        mac.update(b"luckyray-macos-folder-intent-v1\0"); mac.update(&encoded);
        mac.verify_slice(&STANDARD.decode(record.mac).map_err(|_| invalid())?).map_err(|_| invalid())?;
        let intent = record.intent;
        if intent.version != 1 || intent.id != id || Object::of(&self.root)? != intent.root
            || !matches!(intent.operation.as_str(), "rename" | "move" | "delete" | "restore")
            || !relative(&intent.source, false) || !relative(&intent.destination, false)
            || intent.restores.as_ref().is_some_and(|id| !valid_id(id)) {
            return Err(invalid());
        }
        self.root.current()?;
        Ok(intent)
    }
    fn lock(&self, id: &str) -> io::Result<File> {
        self.root.current()?;
        self.directory.lock(OsStr::new(&format!("{id}.lock")))
    }
    fn ids(&self) -> io::Result<Vec<String>> {
        self.root.current()?;
        let mut ids = self.directory.entries()?.into_iter().filter_map(|p| {
            let name = p.to_str()?;
            let id = name.strip_suffix(".json")?;
            valid_id(id).then(|| id.to_owned())
        }).collect::<Vec<_>>();
        if ids.len() > 4096 { return Err(invalid()); }
        ids.sort(); Ok(ids)
    }
}

unsafe extern "C" { fn luckyray_macos_folder_helper_main() -> libc::c_int; }
pub(crate) fn run_folder_helper() -> i32 { unsafe { luckyray_macos_folder_helper_main() } }

struct Worker { child: Child, input: Option<ChildStdin>, output: ChildStdout, finished: bool }
#[derive(Debug)]
struct Response { phase: u32, code: i32, flags: u32 }
impl Worker {
    fn start(root: &Path, intent: &Intent, lock: &File) -> io::Result<Self> {
        #[cfg(test)]
        let mut command = Command::new(env!("LUCKYRAY_MACOS_FOLDER_HELPER"));
        #[cfg(not(test))]
        let mut command = {
            let mut value = Command::new(std::env::current_exe()?);
            value.arg("--macos-folder-helper"); value
        };
        // The child shares the flock open-file description. A restarted app
        // cannot inspect/restore this operation until both processes release it.
        let lock_fd = lock.as_raw_fd();
        unsafe { command.pre_exec(move || {
            if libc::dup2(lock_fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }); }
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let input = child.stdin.take().ok_or_else(invalid)?;
        let output = child.stdout.take().ok_or_else(invalid)?;
        let mut worker = Self { child, input: Some(input), output, finished: false };
        let from = Path::new(&intent.source);
        let to = Path::new(&intent.destination);
        let mode = if from.parent() == to.parent() { 1_u32 } else { 2_u32 };
        let mut bytes = Vec::new();
        for value in [MAGIC, 1, mode, if intent.operation == "delete" { 1 } else { 0 }] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for object in [intent.root, intent.object, intent.source_parent, intent.target_parent] { object.write(&mut bytes); }
        for value in [path_string(root)?, intent.source.clone(), path_string(to.parent().unwrap_or(Path::new("")))?,
            to.file_name().and_then(OsStr::to_str).ok_or_else(invalid)?.to_owned()] {
            if value.len() >= 4096 { return Err(invalid()); }
            bytes.extend_from_slice(&(value.len() as u32).to_le_bytes()); bytes.extend_from_slice(value.as_bytes());
        }
        worker.input.as_mut().ok_or_else(invalid)?.write_all(&bytes)?;
        let ready = worker.response()?;
        if ready.phase != 2 || ready.code != 0 { return Err(invalid()); }
        Ok(worker)
    }
    fn response(&mut self) -> io::Result<Response> {
        let mut bytes = [0_u8; 16];
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut offset = 0;
        while offset < bytes.len() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { return Err(io::ErrorKind::TimedOut.into()); }
            let mut poll = libc::pollfd { fd: self.output.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            let status = unsafe { libc::poll(&mut poll, 1, remaining.as_millis().min(i32::MAX as u128) as i32) };
            if status == 0 { return Err(io::ErrorKind::TimedOut.into()); }
            if status < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted { continue; }
                return Err(error);
            }
            let count = self.output.read(&mut bytes[offset..])?;
            if count == 0 { return Err(io::ErrorKind::UnexpectedEof.into()); }
            offset += count;
        }
        let values = bytes.chunks_exact(4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>();
        if values[0] != MAGIC { return Err(invalid()); }
        Ok(Response { phase: values[1], code: values[2] as i32, flags: values[3] })
    }
    fn go(&mut self) -> io::Result<Response> {
        self.input.as_mut().ok_or_else(invalid)?.write_all(b"G")?;
        self.input.take();
        let response = self.response()?;
        let exit = self.child.wait()?; self.finished = true;
        if !exit.success() || response.phase != 3 { return Err(invalid()); }
        Ok(response)
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        if !self.finished { self.input.take(); let _ = self.child.kill(); let _ = self.child.wait(); }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Position { Source, Destination, Unknown }
fn object_at(root: &Path, relative: &str) -> io::Result<Object> {
    Object::of(&Directory::open(&root.join(relative), false, false)?)
}
fn position(root: &Path, intent: &Intent) -> Position {
    let source_parent = Path::new(&intent.source).parent().unwrap_or(Path::new(""));
    let target_parent = Path::new(&intent.destination).parent().unwrap_or(Path::new(""));
    if object_at(root, "").ok() != Some(intent.root)
        || object_at(root, source_parent.to_str().unwrap_or("!")).ok() != Some(intent.source_parent)
        || object_at(root, target_parent.to_str().unwrap_or("!")).ok() != Some(intent.target_parent) {
        return Position::Unknown;
    }
    let source = object_at(root, &intent.source).ok();
    let destination = object_at(root, &intent.destination).ok();
    match (source == Some(intent.object), destination == Some(intent.object)) {
        (true, false) => Position::Source,
        (false, true) => Position::Destination,
        (true, true) if source_parent == target_parent => {
            // Case-only rename on a case-insensitive volume: both lookups find
            // the object, but readdir exposes which spelling was committed.
            let entries = Directory::open(&root.join(source_parent), false, false).and_then(|dir| dir.entries());
            let Ok(entries) = entries else { return Position::Unknown; };
            let named = |path: &str| {
                let expected = Path::new(path).file_name().and_then(OsStr::to_str).unwrap_or("").nfc().collect::<String>();
                entries.iter().any(|entry| entry.to_str().is_some_and(|value| value.nfc().collect::<String>() == expected))
            };
            match (named(&intent.source), named(&intent.destination)) {
                (true, false) => Position::Source,
                (false, true) => Position::Destination,
                _ => Position::Unknown,
            }
        }
        _ => Position::Unknown,
    }
}
fn result(intent: &Intent, state: &str, message: Option<&str>) -> FolderMutationResult {
    FolderMutationResult {
        operation_id: intent.id.clone(), state: state.into(), operation: intent.operation.clone(),
        old_relative_path: intent.source.clone(),
        new_relative_path: (intent.operation != "delete").then(|| intent.destination.clone()),
        message: message.map(str::to_owned),
    }
}
fn can_restore(root: &Path, intent: &Intent) -> bool {
    let source_parent = Path::new(&intent.source).parent().unwrap_or(Path::new(""));
    let target_parent = Path::new(&intent.destination).parent().unwrap_or(Path::new(""));
    let original_available = matches!(std::fs::symlink_metadata(root.join(&intent.source)), Err(e) if e.kind() == io::ErrorKind::NotFound)
        || (source_parent == target_parent && object_at(root, &intent.source).ok() == Some(intent.object));
    if intent.operation == "restore" || position(root, intent) != Position::Destination || !original_available { return false; }
    object_at(root, source_parent.to_str().unwrap_or("!")).ok() == Some(intent.source_parent)
        && object_at(root, target_parent.to_str().unwrap_or("!")).ok() == Some(intent.target_parent)
}

fn completed_successors(intents: &[Intent], positions: &[Position]) -> Vec<bool> {
    let mut followed = vec![false; intents.len()];
    let mut queue = positions.iter().enumerate().filter_map(|(index, position)|
        (*position == Position::Destination).then_some(index)).collect::<Vec<_>>();
    while let Some(next_index) = queue.pop() {
        let next = &intents[next_index];
        for (index, current) in intents.iter().enumerate() {
            if followed[index] || positions[index] == Position::Destination || index == next_index { continue; }
            if next.root == current.root && next.object == current.object
                && next.source == current.destination && next.source_parent == current.target_parent {
                followed[index] = true; queue.push(index);
            }
        }
    }
    followed
}

fn retained_has_content(root: &Path, intent: &Intent) -> bool {
    intent.operation == "delete" && Directory::open(&root.join(&intent.destination), false, false)
        .and_then(|directory| directory.entries()).map_or(true, |entries| !entries.is_empty())
}

#[cfg(test)]
std::thread_local! {
    static AFTER_READY: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
    static INTERRUPT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}
fn execute(root: &Path, store: &Store, intent: &Intent) -> Result<FolderMutationResult, KnowledgeError> {
    let lock = store.lock(&intent.id).map_err(|_| unavailable())?;
    let mut worker = Worker::start(root, intent, &lock).map_err(|_| error(
        "knowledge-folder-helper-unavailable", "The scoped Mac folder worker is unavailable or the selected objects changed; no folder move was started"))?;
    store.save(intent).map_err(|_| unavailable())?;
    #[cfg(test)]
    if let Some(hook) = AFTER_READY.with(|slot| slot.borrow_mut().take()) { hook(); }
    #[cfg(test)]
    let interrupt = INTERRUPT.with(|slot| slot.replace(0));
    #[cfg(test)]
    if interrupt == 1 {
        return Ok(result(intent, "recovery-required", Some("Folder operation was interrupted before execution; inspect recovery before retrying")));
    }
    let response = worker.go();
    #[cfg(test)]
    if interrupt == 2 {
        return Ok(result(intent, "recovery-required", Some("Folder operation was interrupted after execution; inspect its durable intent")));
    }
    let at = position(root, intent);
    let message = "Folder operation requires review; the original directory and recovery record have been preserved";
    match response {
        Ok(response) if response.code == 0 && response.flags & 2 != 0
            && response.flags & 4 == 0 && at == Position::Destination
            && !retained_has_content(root, intent) => {
            Ok(result(intent, "completed", None))
        }
        Ok(response) if at == Position::Source && response.code != 0 => {
            Ok(result(intent, "unchanged", Some(if response.flags & 4 != 0 {
                "The folder is no longer empty; it was not removed"
            } else { "The selected objects or destination changed; the original folder remains at its source path" })))
        }
        _ => Ok(result(intent, "recovery-required", Some(message))),
    }
}

impl KnowledgeService {
    pub(crate) fn prepare_folder_from_ui(&self, source_epoch: u64, relative_path: &str) -> Result<String, KnowledgeError> {
        let _source = self.lock_active_ui_source(source_epoch, None)?;
        let _guard = self.mutation_lock.lock().map_err(|_| unavailable())?;
        let vault = self.current_vault_unlocked()?;
        let relative = safe_relative_path(relative_path, false)?;
        let path = path_string(&relative).map_err(|_| unavailable())?;
        let parent = relative.parent().unwrap_or(Path::new("")).to_str().ok_or_else(unavailable)?;
        let selection = Selection { path: path.clone(), root: object_at(&vault.root, "").map_err(|_| unavailable())?,
            parent: object_at(&vault.root, parent).map_err(|_| unavailable())?,
            object: object_at(&vault.root, &path).map_err(|_| unavailable())? };
        Ok(STANDARD.encode(serde_json::to_vec(&selection).map_err(|_| unavailable())?))
    }

    pub(crate) fn mutate_folder_from_ui(
        &self, source_epoch: u64, relative_path: &str, expected_selection: &str,
        operation: &str, new_name: Option<&str>, target_parent: Option<&str>,
    ) -> Result<FolderMutationResult, KnowledgeError> {
        let source = self.lock_active_ui_source(source_epoch, None)?;
        let source_relative = safe_relative_path(relative_path, false)?;
        let source_text = path_string(&source_relative).map_err(|_| unavailable())?;
        if source._state.dirty_paths.iter().any(|p| p == &source_text || p.starts_with(&format!("{source_text}/"))) {
            return Err(error("knowledge-desktop-draft-busy", "Save or discard unsaved notes in this folder before changing it"));
        }
        let guard = self.mutation_lock.lock().map_err(|_| unavailable())?;
        let vault = self.current_vault_unlocked()?;
        let root = Directory::open(&vault.root, false, false).map_err(|_| unavailable())?;
        let selected = Directory::open(&vault.root.join(&source_relative), false, false).map_err(|_| unavailable())?;
        let parent_relative = source_relative.parent().unwrap_or(Path::new(""));
        let parent = Directory::open(&vault.root.join(parent_relative), false, false).map_err(|_| unavailable())?;
        if expected_selection.len() > 8192 { return Err(unavailable()); }
        let selection: Selection = serde_json::from_slice(&STANDARD.decode(expected_selection).map_err(|_| unavailable())?)
            .map_err(|_| unavailable())?;
        if selection.path != source_text || selection.root != Object::of(&root).map_err(|_| unavailable())?
            || selection.parent != Object::of(&parent).map_err(|_| unavailable())?
            || selection.object != Object::of(&selected).map_err(|_| unavailable())? {
            return Err(error("knowledge-folder-selection-changed", "The selected folder or Vault changed while the action was being confirmed; no folder move was started"));
        }
        let id = format!("{:032x}", rand::random::<u128>());
        let destination = match operation {
            "rename" => parent_relative.join(folder_name(new_name.ok_or_else(|| error("knowledge-path-invalid", "A new folder name is required"))?)?),
            "move" => safe_relative_directory(target_parent)?.join(source_relative.file_name().ok_or_else(unavailable)?),
            "delete" => {
                if !selected.entries().map_err(|_| unavailable())?.is_empty() {
                    return Err(error("knowledge-folder-not-empty", "Only an empty folder can be removed"));
                }
                // No rmdir/unlink follows this preparation, including errors.
                let metadata = root.child(OsStr::new(".luckyray"), false).map_err(|_| unavailable())?;
                let retained = metadata.child(OsStr::new(RETAINED), true).map_err(|_| unavailable())?;
                retained.child(OsStr::new(&id), true).map_err(|_| unavailable())?;
                Path::new(".luckyray").join(RETAINED).join(&id).join(source_relative.file_name().ok_or_else(unavailable)?)
            }
            _ => return Err(error("knowledge-folder-operation-invalid", "Folder operation is invalid")),
        };
        if destination == source_relative { return Err(error("knowledge-folder-no-change", "The folder already has that location and name")); }
        if destination.starts_with(&source_relative) {
            return Err(error("knowledge-folder-own-subtree", "A folder cannot be moved into itself or one of its descendants"));
        }
        let target_relative = destination.parent().ok_or_else(unavailable)?;
        let target = Directory::open(&vault.root.join(target_relative), false, false).map_err(|_| unavailable())?;
        let object = Object::of(&selected).map_err(|_| unavailable())?;
        let root_object = Object::of(&root).map_err(|_| unavailable())?;
        let target_object = Object::of(&target).map_err(|_| unavailable())?;
        if object.device != root_object.device || target_object.device != root_object.device {
            return Err(error("knowledge-folder-cross-volume", "Folder changes require the same filesystem volume"));
        }
        let intent = Intent {
            version: 1, id, operation: operation.into(), source: source_text,
            destination: path_string(&destination).map_err(|_| unavailable())?, root: root_object,
            source_parent: Object::of(&parent).map_err(|_| unavailable())?, target_parent: target_object,
            object, restores: None,
        };
        let store = Store::open(&vault.root, &self.app_data_dir, true).map_err(|_| unavailable())?;
        root.current().map_err(|_| unavailable())?;
        let result = execute(&vault.root, &store, &intent)?;
        self.invalidate_folder_result(&result);
        drop(guard); drop(source);
        if result.state == "completed" { self.notify_companion_committed(&vault.registration.id, vec![intent.source, intent.destination]); }
        Ok(result)
    }

    pub(crate) fn invalidate_folder_result(&self, result: &FolderMutationResult) {
        if result.state == "unchanged" { return; }
        let _ = self.index.invalidate();
        self.attachment_inventory.invalidate();
        if let Ok(mut context) = self.current_context.lock() { context.context = None; }
    }

    pub(crate) fn list_folder_recoveries_from_ui(&self, source_epoch: u64) -> Result<Vec<FolderRecoveryItem>, KnowledgeError> {
        let _source = self.lock_active_ui_source(source_epoch, None)?;
        let _guard = self.mutation_lock.lock().map_err(|_| unavailable())?;
        let vault = self.current_vault_unlocked()?;
        let store = match Store::open(&vault.root, &self.app_data_dir, false) {
            Ok(store) => store,
            Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(unavailable()),
        };
        let intents = store.ids().map_err(|_| unavailable())?.iter()
            .map(|id| store.read(id)).collect::<io::Result<Vec<_>>>().map_err(|_| unavailable())?;
        let positions = intents.iter().map(|intent| {
            match store.lock(&intent.id) {
                Ok(_lock) => position(&vault.root, intent),
                Err(_) => Position::Unknown,
            }
        }).collect::<Vec<_>>();
        let followed = completed_successors(&intents, &positions);
        let mut items = Vec::new();
        for (index, intent) in intents.iter().enumerate() {
            let lock = store.lock(&intent.id);
            let followed = lock.is_ok() && followed[index];
            let (state, message) = if lock.is_err() {
                ("recovery-required", Some("A folder worker still owns this operation; inspect again after it finishes"))
            } else if followed {
                ("completed", Some("A later recorded folder operation moved this same directory again; use the latest operation for recovery"))
            } else {
                match position(&vault.root, intent) {
                    Position::Source => ("unchanged", Some("The recorded directory is at its original path")),
                    Position::Destination if retained_has_content(&vault.root, intent) =>
                        ("recovery-required", Some("The retained folder contains data added during or after removal; the data was preserved and the folder can be restored")),
                    Position::Destination => ("completed", None),
                    Position::Unknown => ("recovery-required", Some("The recorded directory or its parents moved; no automatic recovery is authorized")),
                }
            };
            let can_restore = lock.is_ok() && !followed && can_restore(&vault.root, intent);
            items.push(FolderRecoveryItem { result: result(intent, state, message), can_restore });
        }
        Ok(items)
    }

    pub(crate) fn restore_folder_from_ui(&self, source_epoch: u64, operation_id: &str) -> Result<FolderMutationResult, KnowledgeError> {
        let source = self.lock_active_ui_source(source_epoch, None)?;
        let guard = self.mutation_lock.lock().map_err(|_| unavailable())?;
        let vault = self.current_vault_unlocked()?;
        let store = Store::open(&vault.root, &self.app_data_dir, false).map_err(|_| unavailable())?;
        let original = store.read(operation_id).map_err(|_| unavailable())?;
        let old_lock = store.lock(operation_id).map_err(|_| unavailable())?;
        if !can_restore(&vault.root, &original) {
            return Err(error("knowledge-folder-restore-conflict", "The original path is occupied or a recorded folder object changed; no folder was replaced"));
        }
        if source._state.dirty_paths.iter().any(|p| [&original.source, &original.destination]
            .iter().any(|base| p == *base || p.starts_with(&format!("{base}/")))) {
            return Err(error("knowledge-desktop-draft-busy", "Save or discard affected notes before restoring this folder"));
        }
        let intent = Intent {
            version: 1, id: format!("{:032x}", rand::random::<u128>()), operation: "restore".into(),
            source: original.destination, destination: original.source, root: original.root,
            source_parent: original.target_parent, target_parent: original.source_parent,
            object: original.object, restores: Some(original.id),
        };
        let result = execute(&vault.root, &store, &intent)?;
        self.invalidate_folder_result(&result);
        drop(old_lock); drop(guard); drop(source);
        if result.state == "completed" { self.notify_companion_committed(&vault.registration.id, vec![intent.source, intent.destination]); }
        Ok(result)
    }
}

#[cfg(test)]
#[path = "macos_folder_mutation_tests.rs"]
mod tests;
