use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_SEARCH_QUERY_BYTES: usize = 1024;
const MAX_SEARCH_RESULTS: usize = 50;
const MAX_SEARCH_ENTRIES: usize = 2_000;
const MAX_SEARCH_DEPTH: usize = 8;
/// The controlled R8 verifier may inspect one conventional project manifest,
/// but it never receives arbitrary project paths or manifest content.
const MAX_PROJECT_MANIFEST_BYTES: usize = 64 * 1024;

/// Maximum bytes of a text file an Agent may create or produce by patching.
const MAX_WRITE_CONTENT_BYTES: usize = 24 * 1024;
/// Maximum characters of a write-target relative path.
const MAX_WRITE_PATH_CHARS: usize = 512;
/// Maximum patch edits per request.
const MAX_PATCH_EDITS: usize = 64;
/// Maximum changed lines shown by a Backend-built diff preview.
const MAX_DIFF_LINES: usize = 400;
/// Maximum bytes of a complete new-file preview or serialized diff.
const MAX_PREVIEW_BYTES: usize = 24 * 1024;
/// A single approved Workspace change set stays intentionally small. Every
/// file must have a complete Backend-built preview; the limits below keep one
/// confirmation comprehensible and prevent a model from turning a proposal
/// into an unbounded batch writer.
pub(crate) const MAX_CHANGE_SET_FILES: usize = 8;
pub(crate) const MAX_CHANGE_SET_PREVIEW_BYTES: usize = 24 * 1024;
pub(crate) const MAX_CHANGE_SET_CHANGED_LINES: usize = 1_200;
/// Short lifetime of a run-bound file reference.
const WORKSPACE_FILE_REFERENCE_TTL: Duration = Duration::from_secs(600);
/// Short lifetime of a renderer management snapshot reference.
const WORKSPACE_MANAGEMENT_REFERENCE_TTL: Duration = Duration::from_secs(300);
/// Short lifetime of a Backend-owned native folder selection. The renderer
/// receives only the opaque reference and a safe display label.
const WORKSPACE_FOLDER_SELECTION_TTL: Duration = Duration::from_secs(180);
const MAX_WORKSPACE_FOLDER_SELECTIONS: usize = 32;
/// Case-insensitive path segments an Agent write may never target.
const WRITE_DENY_SEGMENTS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "runtime",
    "recovery",
    "build",
    "target",
    "dist",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
];
/// Case-insensitive exact file names an Agent write may never target.
const SENSITIVE_FILE_NAMES: &[&str] = &[".env", ".npmrc", ".pypirc", ".netrc"];
/// Case-insensitive extensions that look like credentials, keys, or tokens.
const SENSITIVE_EXTENSIONS: &[&str] = &[
    "pem", "key", "crt", "cer", "cert", "pfx", "p12", "der", "token", "p8", "jks", "keystore",
];
/// Hidden temporary/backup suffixes an Agent write may never target.
const SENSITIVE_TEMP_SUFFIXES: &[&str] = &[
    ".tmp", ".bak", ".backup", ".journal", ".old", ".orig", ".swp", ".lock", ".part",
];

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceGrantView {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) root_name: String,
    pub(crate) enabled: bool,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

/// A frozen "safe display name -> grant" mapping bound to one Agent run.
/// This is Backend-only state; it deliberately does not implement Serialize.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceAliasView {
    pub(crate) grant_id: String,
    pub(crate) name: String,
}

/// The only workspace-alias projection that may enter a model observation.
/// It contains no grant id, root path, canonical identity, or database field.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceAliasObservation {
    pub(crate) name: String,
}

impl WorkspaceAliasView {
    pub(crate) fn observation(&self) -> WorkspaceAliasObservation {
        WorkspaceAliasObservation {
            name: self.name.clone(),
        }
    }
}

/// Newline convention of a qualified text file. Mixed newlines never qualify.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NewlineStyle {
    Lf,
    CrLf,
}

/// Private Backend-only binding behind a run-bound opaque fileRef. It holds
/// grant, relative path, root/file identity, digest, BOM/newline format, the
/// issuing run's principal/conversation authority, and a short TTL. It never
/// implements Serialize and can never enter a model observation, approval
/// preview, run JSON, event, or renderer DTO.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceFileBinding {
    pub(crate) grant_id: String,
    pub(crate) workspace_name: String,
    pub(crate) relative_path: String,
    /// Stable filesystem identity of the specific granted root. This is a
    /// Backend-only handle identity, never a canonical-path hash.
    pub(crate) root_digest: String,
    /// Stable filesystem identity of the exact file observed for this ref.
    /// A same-content replacement is still rejected at commit time.
    pub(crate) file_identity: String,
    pub(crate) file_digest: String,
    pub(crate) size_bytes: u64,
    pub(crate) has_bom: bool,
    pub(crate) newline: NewlineStyle,
    pub(crate) principal: [u8; 32],
    pub(crate) conversation_id: String,
    expires_at: Instant,
}

/// Backend-only authorization behind a server-injected create request id.
/// Unlike a model-provided alias, it freezes the real grant, its filesystem
/// root identity, exact target, content digest, and issuing run authority
/// before an Approval card exists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceCreateBinding {
    pub(crate) grant_id: String,
    pub(crate) workspace_name: String,
    pub(crate) relative_path: String,
    pub(crate) root_digest: String,
    pub(crate) content_digest: String,
    pub(crate) principal: [u8; 32],
    pub(crate) conversation_id: String,
    expires_at: Instant,
}

/// Per-run map of opaque fileRef tokens. Dies with the run; a fresh run binds
/// nothing, so cross-run references fail closed.
#[derive(Debug)]
pub(crate) struct WorkspaceFileBindings {
    entries: Mutex<HashMap<String, WorkspaceFileBinding>>,
    create_entries: Mutex<HashMap<String, WorkspaceCreateBinding>>,
    change_set_entries: Mutex<HashMap<String, WorkspaceChangeSetBinding>>,
}

impl Default for WorkspaceFileBindings {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            create_entries: Mutex::new(HashMap::new()),
            change_set_entries: Mutex::new(HashMap::new()),
        }
    }
}

impl PartialEq for WorkspaceFileBindings {
    fn eq(&self, other: &Self) -> bool {
        let left = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let right = other
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *left != *right {
            return false;
        }
        let left = self
            .create_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let right = other
            .create_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *left != *right {
            return false;
        }
        let left = self
            .change_set_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let right = other
            .change_set_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *left == *right
    }
}

impl WorkspaceFileBindings {
    pub(crate) fn bind(&self, binding: WorkspaceFileBinding) -> String {
        let reference = format!("file-ref-{}", random_id());
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(reference.clone(), binding);
        reference
    }

    /// Resolve without consuming. A reference may be resolved repeatedly
    /// during preparation; consumption happens only once after a committed
    /// write so a stale reference can never drive a second mutation.
    pub(crate) fn resolve(&self, reference: &str) -> Result<WorkspaceFileBinding, WorkspaceError> {
        let binding = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(reference)
            .cloned()
            .ok_or_else(workspace_file_ref_invalid)?;
        if Instant::now() >= binding.expires_at {
            return Err(workspace_file_ref_expired());
        }
        Ok(binding)
    }

    /// One-shot consumption; the reference is removed before it is returned.
    pub(crate) fn consume(&self, reference: &str) -> Result<WorkspaceFileBinding, WorkspaceError> {
        let binding = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(reference)
            .ok_or_else(workspace_file_ref_invalid)?;
        if Instant::now() >= binding.expires_at {
            return Err(workspace_file_ref_expired());
        }
        Ok(binding)
    }

    pub(crate) fn bind_create(&self, request_id: &str, binding: WorkspaceCreateBinding) {
        self.create_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(request_id.to_owned(), binding);
    }

    pub(crate) fn resolve_create(
        &self,
        request_id: &str,
    ) -> Result<WorkspaceCreateBinding, WorkspaceError> {
        let binding = self
            .create_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(request_id)
            .cloned()
            .ok_or_else(workspace_file_ref_invalid)?;
        if Instant::now() >= binding.expires_at {
            return Err(workspace_file_ref_expired());
        }
        Ok(binding)
    }

    pub(crate) fn consume_create(
        &self,
        request_id: &str,
    ) -> Result<WorkspaceCreateBinding, WorkspaceError> {
        let binding = self
            .create_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(request_id)
            .ok_or_else(workspace_file_ref_invalid)?;
        if Instant::now() >= binding.expires_at {
            return Err(workspace_file_ref_expired());
        }
        Ok(binding)
    }

    /// A change-set binding is a Backend-owned, one-shot authority that holds
    /// every exact item the user saw in the preview. The public request id is
    /// only a lookup key; it never carries grant, root, digest, or file
    /// authority itself.
    pub(crate) fn bind_change_set(&self, request_id: &str, binding: WorkspaceChangeSetBinding) {
        self.change_set_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(request_id.to_owned(), binding);
    }

    pub(crate) fn resolve_change_set(
        &self,
        request_id: &str,
    ) -> Result<WorkspaceChangeSetBinding, WorkspaceError> {
        let binding = self
            .change_set_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(request_id)
            .cloned()
            .ok_or_else(workspace_file_ref_invalid)?;
        if Instant::now() >= binding.expires_at {
            return Err(workspace_file_ref_expired());
        }
        Ok(binding)
    }

    pub(crate) fn consume_change_set(
        &self,
        request_id: &str,
    ) -> Result<WorkspaceChangeSetBinding, WorkspaceError> {
        let binding = self
            .change_set_entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(request_id)
            .ok_or_else(workspace_file_ref_invalid)?;
        if Instant::now() >= binding.expires_at {
            return Err(workspace_file_ref_expired());
        }
        Ok(binding)
    }

    /// Exact opaque refs issued to this run. They are deliberately exposed
    /// only to the Backend output guard, never to a model/UI projection.
    pub(crate) fn redaction_tokens(&self) -> Vec<String> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect()
    }
}

/// Backend-only private locator stored in the durable artifact ledger for a
/// workspace write. It is never serialized into any public projection; only
/// startup reconciliation reads it back and only through this module.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct WorkspaceWriteLocator {
    pub(crate) grant_id: String,
    pub(crate) relative_path: String,
    /// Registered filesystem identity, not an alias or canonical path hash.
    #[serde(default)]
    pub(crate) root_digest: String,
}

/// Private per-file locator embedded in one durable change-set receipt. The
/// model/renderer only receive product labels and opaque open tokens; this
/// record remains a Backend reconciliation detail.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct WorkspaceChangeSetLocatorItem {
    pub(crate) operation: String,
    pub(crate) locator: WorkspaceWriteLocator,
    #[serde(default)]
    pub(crate) expected_digest: Option<String>,
    pub(crate) planned_digest: String,
    pub(crate) open_token: String,
}

/// Backend-only durable locator for a journaled sequential change set. It is
/// intentionally one receipt: it lets startup determine each target's real
/// state without replaying a single write.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct WorkspaceChangeSetLocator {
    pub(crate) version: u32,
    pub(crate) items: Vec<WorkspaceChangeSetLocatorItem>,
}

#[cfg(windows)]
const WORKSPACE_WRITE_JOURNAL_VERSION: u32 = 2;

/// Durable same-directory transaction record for a handle-locked patch. The
/// record contains only private filenames and digests; it is never part of a
/// model/UI/artifact projection. Startup reconciliation uses it to restore a
/// pre-commit target or confirm the one committed target without replaying.
#[cfg(windows)]
#[derive(Debug, Serialize, Deserialize)]
struct WorkspaceWriteJournal {
    version: u32,
    target_file_name: String,
    backup_file_name: String,
    temp_file_name: String,
    original_digest: String,
    next_digest: String,
    #[serde(default)]
    original_file_identity: String,
    #[serde(default)]
    next_file_identity: String,
}

#[cfg(windows)]
struct PreparedWorkspacePatch {
    temp: PathBuf,
    backup: PathBuf,
    journal: PathBuf,
    original_digest: String,
    next_digest: String,
    original_file_identity: String,
    next_file_identity: String,
}

#[cfg(test)]
type AfterWorkspaceTargetRenamedHook = Arc<dyn Fn(&Path, &Path, &Path) + Send + Sync>;

#[cfg(windows)]
impl PreparedWorkspacePatch {
    fn cleanup_before_commit(&self) {
        let _ = remove_workspace_transaction_file(&self.temp);
        let _ = remove_workspace_transaction_file(&self.journal);
    }
}

/// One Backend-validated patch edit. Offsets are UTF-16 code-unit indices
/// into the qualified file content exactly as it was read.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct PatchEdit {
    pub(crate) start_utf16: usize,
    pub(crate) end_utf16: usize,
    pub(crate) replacement: String,
}

/// Backend-only outcome for a workspace commit. The distinction is durable:
/// only `KnownNotWritten` may discard a prepared receipt; a mutation that
/// crossed target->backup but cannot prove either commit or rollback is
/// `UnknownAfterMutation` and must retain its private journal/locator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceCommitDisposition {
    Committed,
    KnownNotWritten,
    UnknownAfterMutation,
}

/// A failed patch commit retains the actual write disposition separately from
/// its safe error code. Callers must not infer the durable truth from a string
/// such as `workspace-file-changed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceCommitFailure {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) disposition: WorkspaceCommitDisposition,
}

impl WorkspaceCommitFailure {
    fn unknown_after_mutation(error: WorkspaceError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            disposition: WorkspaceCommitDisposition::UnknownAfterMutation,
        }
    }
}

impl From<WorkspaceError> for WorkspaceCommitFailure {
    fn from(error: WorkspaceError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            disposition: WorkspaceCommitDisposition::KnownNotWritten,
        }
    }
}

/// Backend-only write outcome; the model observation is a separate DTO that
/// never carries digests or identities.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceWriteOutcome {
    pub(crate) content_digest: String,
    pub(crate) size_bytes: u64,
    pub(crate) disposition: WorkspaceCommitDisposition,
}

/// The only model-facing projection of a committed workspace write.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWriteObservation {
    pub(crate) ok: bool,
    pub(crate) workspace: String,
    pub(crate) relative_path: String,
    pub(crate) size_bytes: u64,
}

impl WorkspaceWriteOutcome {
    pub(crate) fn observation(
        &self,
        workspace: &str,
        relative_path: &str,
    ) -> WorkspaceWriteObservation {
        WorkspaceWriteObservation {
            ok: true,
            workspace: workspace.to_owned(),
            relative_path: relative_path.to_owned(),
            size_bytes: self.size_bytes,
        }
    }
}

/// Complete new-file preview built before any Approval exists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreateFilePreview {
    pub(crate) planned_digest: String,
    pub(crate) size_bytes: u64,
    pub(crate) content: String,
    pub(crate) root_digest: String,
}

/// Backend-built full diff preview with the planned final digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PatchTextPreview {
    pub(crate) diff: String,
    pub(crate) planned_digest: String,
    pub(crate) final_size_bytes: u64,
}

/// One fully validated item behind a change-set approval. It carries the
/// private binding and the exact model input that was previewed, so approval
/// cannot be reused with a substituted target or edit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceChangeSetItem {
    Create {
        binding: WorkspaceCreateBinding,
        content: String,
        planned_digest: String,
        open_token: String,
    },
    Patch {
        binding: WorkspaceFileBinding,
        edits: Vec<PatchEdit>,
        planned_digest: String,
        open_token: String,
    },
}

impl WorkspaceChangeSetItem {
    pub(crate) fn operation(&self) -> &'static str {
        match self {
            Self::Create { .. } => "create",
            Self::Patch { .. } => "patch",
        }
    }

    pub(crate) fn workspace_name(&self) -> &str {
        match self {
            Self::Create { binding, .. } => &binding.workspace_name,
            Self::Patch { binding, .. } => &binding.workspace_name,
        }
    }

    pub(crate) fn relative_path(&self) -> &str {
        match self {
            Self::Create { binding, .. } => &binding.relative_path,
            Self::Patch { binding, .. } => &binding.relative_path,
        }
    }

    pub(crate) fn grant_id(&self) -> &str {
        match self {
            Self::Create { binding, .. } => &binding.grant_id,
            Self::Patch { binding, .. } => &binding.grant_id,
        }
    }

    pub(crate) fn root_digest(&self) -> &str {
        match self {
            Self::Create { binding, .. } => &binding.root_digest,
            Self::Patch { binding, .. } => &binding.root_digest,
        }
    }

    pub(crate) fn planned_digest(&self) -> &str {
        match self {
            Self::Create { planned_digest, .. } | Self::Patch { planned_digest, .. } => {
                planned_digest
            }
        }
    }

    pub(crate) fn expected_digest(&self) -> Option<&str> {
        match self {
            Self::Create { .. } => None,
            Self::Patch { binding, .. } => Some(&binding.file_digest),
        }
    }

    pub(crate) fn open_token(&self) -> &str {
        match self {
            Self::Create { open_token, .. } | Self::Patch { open_token, .. } => open_token,
        }
    }

    fn principal(&self) -> [u8; 32] {
        match self {
            Self::Create { binding, .. } => binding.principal,
            Self::Patch { binding, .. } => binding.principal,
        }
    }

    fn conversation_id(&self) -> &str {
        match self {
            Self::Create { binding, .. } => &binding.conversation_id,
            Self::Patch { binding, .. } => &binding.conversation_id,
        }
    }

    pub(crate) fn durable_locator(&self) -> WorkspaceChangeSetLocatorItem {
        WorkspaceChangeSetLocatorItem {
            operation: self.operation().to_owned(),
            locator: WorkspaceWriteLocator {
                grant_id: self.grant_id().to_owned(),
                relative_path: self.relative_path().to_owned(),
                root_digest: self.root_digest().to_owned(),
            },
            expected_digest: self.expected_digest().map(str::to_owned),
            planned_digest: self.planned_digest().to_owned(),
            open_token: self.open_token().to_owned(),
        }
    }
}

/// The per-run, one-shot binding behind one multi-file proposal. Its principal
/// and conversation fields are deliberately checked again by ToolRegistry
/// before a permit is consumed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceChangeSetBinding {
    pub(crate) items: Vec<WorkspaceChangeSetItem>,
    pub(crate) principal: [u8; 32],
    pub(crate) conversation_id: String,
    pub(crate) operation_digest: String,
    expires_at: Instant,
}

impl WorkspaceChangeSetBinding {
    pub(crate) fn new(items: Vec<WorkspaceChangeSetItem>) -> Result<Self, WorkspaceError> {
        if items.len() < 2 || items.len() > MAX_CHANGE_SET_FILES {
            return Err(WorkspaceError::new(
                "workspace-change-set-invalid",
                "Workspace change set must contain a bounded number of files",
            ));
        }
        let principal = items[0].principal();
        let conversation_id = items[0].conversation_id().to_owned();
        if items
            .iter()
            .any(|item| item.principal() != principal || item.conversation_id() != conversation_id)
        {
            return Err(workspace_file_ref_invalid());
        }
        let canonical = items
            .iter()
            .map(|item| {
                format!(
                    "{}\n{}\n{}\n{}\n{}",
                    item.operation(),
                    item.grant_id(),
                    item.relative_path(),
                    item.expected_digest().unwrap_or(""),
                    item.planned_digest(),
                )
            })
            .collect::<Vec<_>>()
            .join("\n---\n");
        Ok(Self {
            items,
            principal,
            conversation_id,
            operation_digest: sha256_hex(canonical.as_bytes()),
            expires_at: Instant::now() + WORKSPACE_FILE_REFERENCE_TTL,
        })
    }

    pub(crate) fn durable_locator(&self) -> WorkspaceChangeSetLocator {
        WorkspaceChangeSetLocator {
            version: 1,
            items: self
                .items
                .iter()
                .map(WorkspaceChangeSetItem::durable_locator)
                .collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceChangeSetItemOutcome {
    pub(crate) workspace_name: String,
    pub(crate) relative_path: String,
    pub(crate) operation: &'static str,
    pub(crate) open_token: String,
    pub(crate) disposition: WorkspaceCommitDisposition,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceChangeSetOutcome {
    pub(crate) items: Vec<WorkspaceChangeSetItemOutcome>,
}

impl WorkspaceChangeSetOutcome {
    pub(crate) fn fully_committed(&self) -> bool {
        self.items
            .iter()
            .all(|item| item.disposition == WorkspaceCommitDisposition::Committed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceChangeSetReconciliation {
    Committed,
    NotCommitted,
    Partial,
    Uncertain,
}

/// Renderer-facing grant management view. `management_ref` is a short-lived
/// opaque capability issued by the Backend for the current management
/// snapshot; the real grant id, root, and DB fields never leave the Backend.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceGrantManagementView {
    pub(crate) management_ref: String,
    pub(crate) label: String,
    pub(crate) root_name: String,
    pub(crate) enabled: bool,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFolderSelectionView {
    pub(crate) management_ref: String,
    pub(crate) label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceFolderSelectionAction {
    AddGrant,
    #[cfg(test)]
    ProjectFolder,
}

#[derive(Clone, Debug)]
struct WorkspaceFolderSelectionBinding {
    root: PathBuf,
    root_identity: String,
    caller_label: String,
    action: WorkspaceFolderSelectionAction,
    label: String,
    expires_at: Instant,
}

#[derive(Debug)]
struct WorkspaceFolderSelections {
    ttl: Duration,
    entries: Mutex<HashMap<String, WorkspaceFolderSelectionBinding>>,
}

impl Default for WorkspaceFolderSelections {
    fn default() -> Self {
        Self::new(WORKSPACE_FOLDER_SELECTION_TTL)
    }
}

impl WorkspaceFolderSelections {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn issue(
        &self,
        root: &Path,
        caller_label: &str,
        action: WorkspaceFolderSelectionAction,
    ) -> Result<WorkspaceFolderSelectionView, WorkspaceError> {
        let canonical = fs::canonicalize(root).map_err(|_| workspace_selection_unavailable())?;
        let metadata =
            fs::symlink_metadata(&canonical).map_err(|_| workspace_selection_unavailable())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(WorkspaceError::new(
                "workspace-selection-reparse-denied",
                "Selected folder is not a safe local directory",
            ));
        }
        let guard = filesystem_directory_identity_guard(&canonical)
            .map_err(|_| workspace_selection_unavailable())?;
        let label = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("授权工作区")
            .chars()
            .take(80)
            .collect::<String>();
        let management_ref = format!("wsg-selection-ref-{}", random_id());
        let now = Instant::now();
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|_, binding| now < binding.expires_at);
        if entries.len() >= MAX_WORKSPACE_FOLDER_SELECTIONS {
            let oldest = entries
                .iter()
                .min_by_key(|(_, binding)| binding.expires_at)
                .map(|(reference, _)| reference.clone());
            if let Some(oldest) = oldest {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            management_ref.clone(),
            WorkspaceFolderSelectionBinding {
                root: canonical,
                root_identity: guard.identity().to_owned(),
                caller_label: caller_label.to_owned(),
                action,
                label: label.clone(),
                expires_at: now + self.ttl,
            },
        );
        Ok(WorkspaceFolderSelectionView {
            management_ref,
            label,
        })
    }

    fn consume(
        &self,
        reference: &str,
        caller_label: &str,
        action: WorkspaceFolderSelectionAction,
    ) -> Result<WorkspaceFolderSelectionBinding, WorkspaceError> {
        let binding = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(reference)
            .ok_or_else(workspace_selection_reference_invalid)?;
        if binding.caller_label != caller_label || binding.action != action {
            return Err(workspace_selection_reference_invalid());
        }
        if Instant::now() >= binding.expires_at {
            return Err(WorkspaceError::new(
                "workspace-selection-reference-expired",
                "Folder selection has expired",
            ));
        }
        Ok(binding)
    }
}

#[derive(Clone, Debug)]
struct WorkspaceManagementBinding {
    grant_id: String,
    expires_at: Instant,
}

#[derive(Debug)]
pub(crate) struct WorkspaceManagementBindings {
    ttl: Duration,
    entries: Mutex<HashMap<String, WorkspaceManagementBinding>>,
}

impl Default for WorkspaceManagementBindings {
    fn default() -> Self {
        Self {
            ttl: WORKSPACE_MANAGEMENT_REFERENCE_TTL,
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl WorkspaceManagementBindings {
    /// One management response is one snapshot. Replacing it atomically makes
    /// every reference from the previous snapshot stale.
    pub(crate) fn project_snapshot(
        &self,
        grants: &[WorkspaceGrantView],
    ) -> Vec<WorkspaceGrantManagementView> {
        let now = Instant::now();
        let mut bindings = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        bindings.clear();
        grants
            .iter()
            .map(|grant| {
                let management_ref = format!("wsg-ui-ref-{}", random_id());
                bindings.insert(
                    management_ref.clone(),
                    WorkspaceManagementBinding {
                        grant_id: grant.id.clone(),
                        expires_at: now + self.ttl,
                    },
                );
                WorkspaceGrantManagementView {
                    management_ref,
                    label: grant.label.clone(),
                    root_name: grant.root_name.clone(),
                    enabled: grant.enabled,
                    created_at: grant.created_at.clone(),
                    updated_at: grant.updated_at.clone(),
                }
            })
            .collect()
    }

    /// One-shot consumption returning the internal grant id for a single
    /// Backend command. Stale, forged, and expired references fail closed.
    pub(crate) fn consume(&self, reference: &str) -> Result<String, WorkspaceError> {
        let binding = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(reference)
            .ok_or_else(|| {
                WorkspaceError::new(
                    "workspace-management-reference-invalid",
                    "Workspace management reference is invalid or stale",
                )
            })?;
        if Instant::now() >= binding.expires_at {
            return Err(WorkspaceError::new(
                "workspace-management-reference-expired",
                "Workspace management snapshot has expired",
            ));
        }
        Ok(binding.grant_id)
    }
}

/// Build a stable alias list from the current enabled grant set. Duplicate
/// labels receive deterministic numeric suffixes so the model never has to
/// guess an internal id.
pub(crate) fn build_workspace_aliases(grants: &[WorkspaceGrantView]) -> Vec<WorkspaceAliasView> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    grants
        .iter()
        .filter(|grant| grant.enabled)
        .map(|grant| {
            let base = grant.label.clone();
            let count = counts.entry(base.clone()).or_insert(0);
            let name = if *count == 0 {
                base.clone()
            } else {
                let next = *count + 1;
                format!("{base} ({next})")
            };
            *count += 1;
            WorkspaceAliasView {
                grant_id: grant.id.clone(),
                name,
            }
        })
        .collect()
}

/// Internal workspace service result. The grant id is required for Backend
/// bookkeeping but must never be serialized as a model observation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceSearchHit {
    pub(crate) grant_id: String,
    pub(crate) relative_path: String,
    pub(crate) name: String,
    pub(crate) snippet: String,
    pub(crate) size_bytes: u64,
    /// True only for bounded UTF-8/text extensions accepted by workspace.read.
    pub(crate) readable_text: bool,
    /// All returned regular files remain eligible for an approval-bound import.
    pub(crate) importable_material: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchObservation {
    pub(crate) workspace: String,
    pub(crate) relative_path: String,
    pub(crate) name: String,
    pub(crate) snippet: String,
    pub(crate) size_bytes: u64,
    pub(crate) readable_text: bool,
    pub(crate) importable_material: bool,
}

impl WorkspaceSearchHit {
    pub(crate) fn observation(&self, workspace: &str) -> WorkspaceSearchObservation {
        WorkspaceSearchObservation {
            workspace: workspace.to_owned(),
            relative_path: self.relative_path.clone(),
            name: self.name.clone(),
            snippet: self.snippet.clone(),
            size_bytes: self.size_bytes,
            readable_text: self.readable_text,
            importable_material: self.importable_material,
        }
    }
}

/// Internal workspace service result. The grant id and content digest stay
/// Backend-only; the model receives only the useful read result fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceReadResult {
    pub(crate) grant_id: String,
    pub(crate) relative_path: String,
    pub(crate) content: String,
    pub(crate) size_bytes: u64,
    pub(crate) truncated: bool,
    pub(crate) content_digest: String,
    pub(crate) root_digest: String,
    pub(crate) file_identity: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceReadObservation {
    pub(crate) workspace: String,
    pub(crate) relative_path: String,
    pub(crate) content: String,
    pub(crate) size_bytes: u64,
    pub(crate) truncated: bool,
    /// Run-bound opaque token issued only for a qualified, complete,
    /// untruncated UTF-8 text read. It can be used once as the fileRef of
    /// workspace.patch_text and is never a durable identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) file_ref: Option<String>,
}

impl WorkspaceReadResult {
    pub(crate) fn observation(
        &self,
        workspace: &str,
        file_ref: Option<String>,
    ) -> WorkspaceReadObservation {
        WorkspaceReadObservation {
            workspace: workspace.to_owned(),
            relative_path: self.relative_path.clone(),
            content: self.content.clone(),
            size_bytes: self.size_bytes,
            truncated: self.truncated,
            file_ref,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl WorkspaceError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkspaceError {}

#[derive(Clone)]
pub(crate) struct WorkspaceGrantService {
    db_path: PathBuf,
    management_bindings: Arc<WorkspaceManagementBindings>,
    folder_selections: Arc<WorkspaceFolderSelections>,
    #[cfg(test)]
    after_final_validation: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
    #[cfg(test)]
    after_target_renamed: Arc<Mutex<Option<AfterWorkspaceTargetRenamedHook>>>,
}

impl WorkspaceGrantService {
    pub(crate) fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
            management_bindings: Arc::new(WorkspaceManagementBindings::default()),
            folder_selections: Arc::new(WorkspaceFolderSelections::default()),
            #[cfg(test)]
            after_final_validation: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            after_target_renamed: Arc::new(Mutex::new(None)),
        }
    }

    /// Construct with a shared management-reference store so the Backend keeps
    /// one snapshot across cloned service instances.
    pub(crate) fn new_with_management(
        db_path: impl Into<PathBuf>,
        management_bindings: Arc<WorkspaceManagementBindings>,
    ) -> Self {
        Self {
            db_path: db_path.into(),
            management_bindings,
            folder_selections: Arc::new(WorkspaceFolderSelections::default()),
            #[cfg(test)]
            after_final_validation: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            after_target_renamed: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_after_final_validation_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self
            .after_final_validation
            .lock()
            .expect("workspace test hook lock") = Some(hook);
    }

    #[cfg(test)]
    fn invoke_after_final_validation_hook(&self) {
        if let Some(hook) = self
            .after_final_validation
            .lock()
            .expect("workspace test hook lock")
            .take()
        {
            hook();
        }
    }

    #[cfg(test)]
    pub(crate) fn set_after_target_renamed_hook(&self, hook: AfterWorkspaceTargetRenamedHook) {
        *self
            .after_target_renamed
            .lock()
            .expect("workspace test hook lock") = Some(hook);
    }

    #[cfg(test)]
    fn take_after_target_renamed_hook(&self) -> Option<AfterWorkspaceTargetRenamedHook> {
        self.after_target_renamed
            .lock()
            .expect("workspace test hook lock")
            .take()
    }

    pub(crate) fn management_snapshot(
        &self,
        grants: &[WorkspaceGrantView],
    ) -> Vec<WorkspaceGrantManagementView> {
        self.management_bindings.project_snapshot(grants)
    }

    pub(crate) fn consume_management_ref(&self, reference: &str) -> Result<String, WorkspaceError> {
        self.management_bindings.consume(reference)
    }

    pub(crate) fn issue_add_folder_selection(
        &self,
        root: &Path,
        caller_label: &str,
    ) -> Result<WorkspaceFolderSelectionView, WorkspaceError> {
        self.folder_selections
            .issue(root, caller_label, WorkspaceFolderSelectionAction::AddGrant)
    }

    pub(crate) fn add_from_folder_selection(
        &self,
        reference: &str,
        caller_label: &str,
    ) -> Result<WorkspaceGrantView, WorkspaceError> {
        let binding = self.folder_selections.consume(
            reference,
            caller_label,
            WorkspaceFolderSelectionAction::AddGrant,
        )?;
        let guard = filesystem_directory_identity_guard(&binding.root)
            .map_err(|_| workspace_selection_changed())?;
        if guard.identity() != binding.root_identity {
            return Err(workspace_selection_changed());
        }
        // Keep the no-delete directory handle alive through canonicalization,
        // identity revalidation, and the grant insert. A same-path replacement
        // cannot race this final admission window on Windows.
        self.insert_validated_grant(&binding.root, &binding.label, guard.identity())
    }

    pub(crate) fn list(&self) -> Result<Vec<WorkspaceGrantView>, WorkspaceError> {
        let connection = self.open_read()?;
        let mut statement = connection
            .prepare(
                "SELECT id, label, root_name, enabled, created_at, updated_at
                 FROM agent_workspace_grant ORDER BY label COLLATE NOCASE, id",
            )
            .map_err(|_| workspace_database_error())?;
        let rows = statement
            .query_map([], |row| {
                Ok(WorkspaceGrantView {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    root_name: row.get(2)?,
                    enabled: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|_| workspace_database_error())?;
        let mut grants = Vec::new();
        for row in rows {
            grants.push(row.map_err(|_| workspace_database_error())?);
        }
        Ok(grants)
    }

    pub(crate) fn has_enabled_grants(&self) -> Result<bool, WorkspaceError> {
        let connection = self.open_read()?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_workspace_grant WHERE enabled = 1)",
                [],
                |row| row.get::<_, i64>(0).map(|value| value != 0),
            )
            .map_err(|_| workspace_database_error())
    }

    /// Validate a project-management grant while the caller already owns its
    /// Immediate write transaction. This closes the update/remove TOCTOU:
    /// the database row, enabled bit, and current filesystem identity are
    /// checked before the project binding is changed.
    pub(crate) fn validate_enabled_grant_in_transaction(
        &self,
        connection: &Connection,
        grant_id: &str,
    ) -> Result<WorkspaceGrantView, WorkspaceError> {
        validate_public_id(grant_id)?;
        let (
            id,
            label,
            root_name,
            enabled,
            created_at,
            updated_at,
            canonical_root,
            registered_identity,
        ) = connection
            .query_row(
                "SELECT id,label,root_name,enabled,created_at,updated_at,
                            canonical_root,root_digest
                     FROM agent_workspace_grant WHERE id=?1",
                [grant_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)? != 0,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| workspace_database_error())?
            .ok_or_else(|| {
                WorkspaceError::new(
                    "workspace-grant-not-found",
                    "Workspace grant is disabled or unavailable",
                )
            })?;
        if !enabled {
            return Err(WorkspaceError::new(
                "workspace-grant-not-found",
                "Workspace grant is disabled or unavailable",
            ));
        }
        let root = PathBuf::from(canonical_root);
        let canonical = fs::canonicalize(&root).map_err(|_| {
            WorkspaceError::new(
                "workspace-grant-unavailable",
                "Workspace grant root is unavailable",
            )
        })?;
        if canonical != root {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            ));
        }
        let metadata = fs::symlink_metadata(&canonical).map_err(|_| workspace_read_error())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(WorkspaceError::new(
                "workspace-grant-reparse-denied",
                "Workspace grant root is no longer safe",
            ));
        }
        let actual_identity = workspace_path_identity(&canonical, true)?;
        let updated_at = if registered_identity == actual_identity {
            updated_at
        } else if registered_identity == legacy_root_path_digest(&canonical) {
            let now = chrono::Utc::now().to_rfc3339();
            let changed = connection
                .execute(
                    "UPDATE agent_workspace_grant SET root_digest=?2,updated_at=?3
                     WHERE id=?1 AND enabled=1 AND root_digest=?4",
                    params![grant_id, actual_identity, now, registered_identity],
                )
                .map_err(|_| workspace_database_error())?;
            if changed != 1 {
                return Err(WorkspaceError::new(
                    "workspace-grant-changed",
                    "Workspace grant identity changed",
                ));
            }
            now
        } else {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            ));
        };
        Ok(WorkspaceGrantView {
            id,
            label,
            root_name,
            enabled,
            created_at,
            updated_at,
        })
    }

    /// Freeze a stable "safe display name -> grant" map at run start. The
    /// model never sees grant ids or absolute paths, only these aliases.
    pub(crate) fn build_aliases(&self) -> Result<Vec<WorkspaceAliasView>, WorkspaceError> {
        let grants = self.list()?;
        Ok(build_workspace_aliases(&grants))
    }

    /// Freeze the safe alias -> grant map for one Backend-owned project
    /// binding. The current grant and filesystem identity are revalidated
    /// before the alias is issued; a stale, disabled, removed, or replaced
    /// workspace therefore fails closed before run admission.
    pub(crate) fn build_aliases_for_grant(
        &self,
        grant_id: &str,
    ) -> Result<Vec<WorkspaceAliasView>, WorkspaceError> {
        self.resolve_grant(grant_id)?;
        let grant = self.view(grant_id)?;
        if !grant.enabled {
            return Err(WorkspaceError::new(
                "workspace-grant-not-found",
                "Workspace grant is disabled or unavailable",
            ));
        }
        Ok(vec![WorkspaceAliasView {
            grant_id: grant.id,
            name: grant.label,
        }])
    }

    pub(crate) fn add(
        &self,
        root: &Path,
        label: &str,
    ) -> Result<WorkspaceGrantView, WorkspaceError> {
        if !root.is_absolute() {
            return Err(WorkspaceError::new(
                "workspace-grant-invalid",
                "Workspace grant root must be selected by the application",
            ));
        }
        let canonical = fs::canonicalize(root).map_err(|_| {
            WorkspaceError::new(
                "workspace-grant-unavailable",
                "Selected workspace root is unavailable",
            )
        })?;
        let metadata = fs::metadata(&canonical).map_err(|_| {
            WorkspaceError::new(
                "workspace-grant-unavailable",
                "Selected workspace root is unavailable",
            )
        })?;
        if !metadata.is_dir()
            || is_reparse_point(&fs::symlink_metadata(&canonical).map_err(|_| {
                WorkspaceError::new(
                    "workspace-grant-unavailable",
                    "Selected workspace root is unavailable",
                )
            })?)
        {
            return Err(WorkspaceError::new(
                "workspace-grant-reparse-denied",
                "Reparse-point workspace roots are not supported",
            ));
        }
        let guard = filesystem_directory_identity_guard(&canonical)?;
        self.insert_validated_grant(&canonical, label, guard.identity())
    }

    fn insert_validated_grant(
        &self,
        canonical: &Path,
        label: &str,
        root_digest: &str,
    ) -> Result<WorkspaceGrantView, WorkspaceError> {
        let label = label.trim();
        if label.is_empty() || label.chars().count() > 80 {
            return Err(WorkspaceError::new(
                "workspace-grant-invalid",
                "Workspace label is invalid",
            ));
        }
        let root_name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Workspace")
            .chars()
            .take(80)
            .collect::<String>();
        // This is deliberately a filesystem handle identity rather than a
        // hash of the canonical string. Replacing a granted folder at the
        // same path must require a fresh user grant.
        let id = format!("wsg-{}", random_id());
        let now = chrono::Utc::now().to_rfc3339();
        let connection = self.open_write()?;
        connection
            .execute(
                "INSERT INTO agent_workspace_grant(
                    id, label, canonical_root, root_name, root_digest,
                    enabled, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
                params![
                    id,
                    label,
                    canonical.to_string_lossy(),
                    root_name,
                    root_digest,
                    now
                ],
            )
            .map_err(|_| workspace_database_error())?;
        self.view(&id)
    }

    pub(crate) fn set_enabled(
        &self,
        grant_id: &str,
        enabled: bool,
    ) -> Result<WorkspaceGrantView, WorkspaceError> {
        validate_public_id(grant_id)?;
        let connection = self.open_write()?;
        let changed = connection
            .execute(
                "UPDATE agent_workspace_grant SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
                params![
                    grant_id,
                    i64::from(enabled),
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|_| workspace_database_error())?;
        if changed != 1 {
            return Err(WorkspaceError::new(
                "workspace-grant-not-found",
                "Workspace grant no longer exists",
            ));
        }
        self.view(grant_id)
    }

    pub(crate) fn remove(&self, grant_id: &str) -> Result<(), WorkspaceError> {
        validate_public_id(grant_id)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| workspace_database_error())?;
        let project_bound: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_project WHERE primary_workspace_grant_id=?1
                 )",
                [grant_id],
                |row| row.get(0),
            )
            .map_err(|_| workspace_database_error())?;
        if project_bound {
            return Err(WorkspaceError::new(
                "workspace-grant-project-bound",
                "Workspace grant is bound to a project",
            ));
        }
        let changed = transaction
            .execute(
                "DELETE FROM agent_workspace_grant WHERE id = ?1",
                [grant_id],
            )
            .map_err(|_| workspace_database_error())?;
        if changed != 1 {
            return Err(WorkspaceError::new(
                "workspace-grant-not-found",
                "Workspace grant no longer exists",
            ));
        }
        transaction.commit().map_err(|_| workspace_database_error())
    }

    pub(crate) fn search(
        &self,
        grant_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<WorkspaceSearchHit>, WorkspaceError> {
        if query.trim().is_empty() || query.as_bytes().len() > MAX_SEARCH_QUERY_BYTES {
            return Err(WorkspaceError::new(
                "workspace-query-invalid",
                "Workspace query must be non-empty and bounded",
            ));
        }
        let grant = self.resolve_grant(grant_id)?;
        let query_lower = query.to_lowercase();
        let limit = limit.clamp(1, MAX_SEARCH_RESULTS);
        let mut queue = VecDeque::from([(grant.root.clone(), 0usize)]);
        let mut visited = 0usize;
        let mut hits = Vec::new();
        while let Some((directory, depth)) = queue.pop_front() {
            if depth > MAX_SEARCH_DEPTH || visited >= MAX_SEARCH_ENTRIES || hits.len() >= limit {
                break;
            }
            let mut entries = fs::read_dir(&directory)
                .map_err(|_| workspace_read_error())?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                if visited >= MAX_SEARCH_ENTRIES || hits.len() >= limit {
                    break;
                }
                visited += 1;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(|_| workspace_read_error())?;
                if is_reparse_point(&metadata) || metadata.file_type().is_symlink() {
                    continue;
                }
                if metadata.is_dir() {
                    if depth < MAX_SEARCH_DEPTH {
                        queue.push_back((path, depth + 1));
                    }
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                let relative = safe_relative_string(&grant.root, &path)?;
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_owned();
                let readable_text = is_safe_text_file(&path);
                let mut snippet = String::new();
                let name_matches = name.to_lowercase().contains(&query_lower);
                if readable_text && metadata.len() <= MAX_READ_BYTES as u64 {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Some(position) = content.to_lowercase().find(&query_lower) {
                            snippet = bounded_snippet(&content, position, query_lower.len());
                        }
                    }
                }
                if name_matches || !snippet.is_empty() {
                    hits.push(WorkspaceSearchHit {
                        grant_id: grant_id.to_owned(),
                        relative_path: relative,
                        name,
                        snippet,
                        size_bytes: metadata.len(),
                        readable_text,
                        importable_material: true,
                    });
                }
            }
        }
        Ok(hits)
    }

    pub(crate) fn read(
        &self,
        grant_id: &str,
        relative_path: &str,
    ) -> Result<WorkspaceReadResult, WorkspaceError> {
        let resolved = self.resolve_file(grant_id, relative_path, true)?;
        let mut file = open_workspace_file_no_follow(&resolved.path, false)?;
        let opened_metadata = file.metadata().map_err(|_| workspace_read_error())?;
        let file_identity = workspace_file_identity(&file, &resolved.path)?;
        let current_path = fs::canonicalize(&resolved.path).map_err(|_| workspace_read_error())?;
        let current_metadata =
            fs::symlink_metadata(&resolved.path).map_err(|_| workspace_read_error())?;
        if current_path != resolved.path
            || !opened_metadata.is_file()
            || !current_metadata.is_file()
            || current_metadata.file_type().is_symlink()
            || is_reparse_point(&current_metadata)
        {
            return Err(WorkspaceError::new(
                "workspace-reparse-denied",
                "Workspace file identity changed before it could be read",
            ));
        }
        let mut visible = Vec::with_capacity(
            usize::try_from(opened_metadata.len())
                .unwrap_or(MAX_READ_BYTES)
                .min(MAX_READ_BYTES),
        );
        let mut hasher = Sha256::new();
        let mut contains_nul = false;
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|_| workspace_read_error())?;
            if read == 0 {
                break;
            }
            contains_nul |= buffer[..read].contains(&0);
            hasher.update(&buffer[..read]);
            let remaining = MAX_READ_BYTES.saturating_sub(visible.len());
            if remaining > 0 {
                visible.extend_from_slice(&buffer[..read.min(remaining)]);
            }
        }
        if contains_nul {
            return Err(WorkspaceError::new(
                "workspace-file-type-denied",
                "Only bounded text files can be read",
            ));
        }
        let size_bytes = opened_metadata.len();
        let truncated = size_bytes > MAX_READ_BYTES as u64;
        let content = match String::from_utf8(visible) {
            Ok(content) => content,
            Err(error)
                if truncated
                    && error.utf8_error().error_len().is_none()
                    && error.utf8_error().valid_up_to() + 4 >= MAX_READ_BYTES =>
            {
                let valid_up_to = error.utf8_error().valid_up_to();
                String::from_utf8(error.into_bytes()[..valid_up_to].to_vec())
                    .map_err(|_| workspace_read_error())?
            }
            Err(_) => {
                return Err(WorkspaceError::new(
                    "workspace-file-type-denied",
                    "Only UTF-8 text files can be read",
                ))
            }
        };
        Ok(WorkspaceReadResult {
            grant_id: grant_id.to_owned(),
            relative_path: resolved.relative,
            content,
            size_bytes,
            truncated,
            content_digest: format!("{:x}", hasher.finalize()),
            root_digest: checked_workspace_root_identity(&resolved.root, &resolved.root_digest)?,
            file_identity,
        })
    }

    pub(crate) fn resolve_for_import(
        &self,
        grant_id: &str,
        relative_path: &str,
    ) -> Result<PathBuf, WorkspaceError> {
        Ok(self.resolve_file(grant_id, relative_path, false)?.path)
    }

    /// Bind exactly one conventional manifest directly below an enabled
    /// workspace root for the fixed LuckyRay project-check recipe.  This is
    /// deliberately not a general file discovery API: callers cannot pass a
    /// path, executable, script, or command line.  The manifest's root/file
    /// identities and digest are revalidated immediately before the owned
    /// helper process starts.
    pub(crate) fn project_manifest_binding(
        &self,
        grant_id: &str,
    ) -> Result<WorkspaceProjectManifestBinding, WorkspaceError> {
        let grant = self.resolve_grant(grant_id)?;
        for manifest_name in ["package.json", "Cargo.toml", "pyproject.toml"] {
            let candidate = grant.root.join(manifest_name);
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(workspace_read_error()),
            };
            assert_no_reparse_components(&grant.root, &candidate)?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || is_reparse_point(&metadata)
                || metadata.len() > MAX_PROJECT_MANIFEST_BYTES as u64
            {
                return Err(WorkspaceError::new(
                    "workspace-project-manifest-invalid",
                    "Project manifest is not a bounded regular UTF-8 file",
                ));
            }
            let file = open_workspace_file_no_follow(&candidate, false)?;
            let opened = file.metadata().map_err(|_| workspace_read_error())?;
            if !opened.is_file() || opened.len() > MAX_PROJECT_MANIFEST_BYTES as u64 {
                return Err(WorkspaceError::new(
                    "workspace-project-manifest-invalid",
                    "Project manifest is not a bounded regular UTF-8 file",
                ));
            }
            let manifest_identity = workspace_file_identity(&file, &candidate)?;
            let mut bytes = Vec::with_capacity(opened.len() as usize);
            file.take((MAX_PROJECT_MANIFEST_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| workspace_read_error())?;
            if bytes.len() > MAX_PROJECT_MANIFEST_BYTES
                || bytes.contains(&0)
                || std::str::from_utf8(&bytes).is_err()
            {
                return Err(WorkspaceError::new(
                    "workspace-project-manifest-invalid",
                    "Project manifest is not a bounded UTF-8 text file",
                ));
            }
            let root_digest = checked_workspace_root_identity(&grant.root, &grant.root_digest)?;
            return Ok(WorkspaceProjectManifestBinding {
                root: grant.root,
                root_digest,
                manifest_name: manifest_name.to_owned(),
                manifest_digest: sha256_hex(&bytes),
                manifest_identity,
            });
        }
        Err(WorkspaceError::new(
            "workspace-project-manifest-missing",
            "No supported project manifest is available in this authorized workspace",
        ))
    }

    pub(crate) fn scope_digest(&self) -> Result<String, WorkspaceError> {
        let connection = self.open_read()?;
        let mut statement = connection
            .prepare(
                "SELECT id, root_digest FROM agent_workspace_grant
                 WHERE enabled = 1 ORDER BY id",
            )
            .map_err(|_| workspace_database_error())?;
        let rows = statement
            .query_map([], |row| {
                Ok(format!(
                    "{}:{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?
                ))
            })
            .map_err(|_| workspace_database_error())?;
        let mut values = Vec::new();
        for row in rows {
            values.push(row.map_err(|_| workspace_database_error())?);
        }
        Ok(format!(
            "{:x}",
            Sha256::digest(values.join("\n").as_bytes())
        ))
    }

    /// Return a digest for exactly one project-bound grant after checking its
    /// current filesystem handle identity. The digest is Backend-only and is
    /// used solely to freeze the run scope snapshot.
    pub(crate) fn scope_digest_for_grant(&self, grant_id: &str) -> Result<String, WorkspaceError> {
        let grant = self.resolve_grant(grant_id)?;
        Ok(format!(
            "{:x}",
            Sha256::digest(format!("{grant_id}:{}", grant.root_digest).as_bytes())
        ))
    }

    /// Read the current file bytes and return (content, digest, size) with the
    /// same identity/reparse/type guarantees as `read`. Used by patch preview
    /// and startup reconciliation; never truncates and never follows links.
    pub(crate) fn read_qualified(
        &self,
        grant_id: &str,
        relative_path: &str,
    ) -> Result<QualifiedWorkspaceText, WorkspaceError> {
        let resolved = self.resolve_file(grant_id, relative_path, true)?;
        let mut file = open_workspace_file_no_follow(&resolved.path, false)?;
        let file_identity = workspace_file_identity(&file, &resolved.path)?;
        let metadata = file.metadata().map_err(|_| workspace_read_error())?;
        if !metadata.is_file() {
            return Err(workspace_file_type_denied());
        }
        let mut bytes = Vec::with_capacity(
            usize::try_from(metadata.len())
                .unwrap_or(MAX_READ_BYTES)
                .min(MAX_READ_BYTES),
        );
        file.read_to_end(&mut bytes)
            .map_err(|_| workspace_read_error())?;
        if bytes.contains(&0) {
            return Err(workspace_file_type_denied());
        }
        Ok(QualifiedWorkspaceText {
            content: bytes,
            root_digest: checked_workspace_root_identity(&resolved.root, &resolved.root_digest)?,
            file_identity,
        })
    }

    /// Validate a write target path and full new-file content without writing.
    /// This runs before an Approval card exists so unsafe targets never reach
    /// a user decision.
    pub(crate) fn create_text_preview(
        &self,
        grant_id: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<CreateFilePreview, WorkspaceError> {
        validate_write_target(relative_path)?;
        validate_new_content(content)?;
        // Authorize the grant and confirm its root identity before the
        // Approval is created; the write re-validates everything in lock.
        let grant = self.resolve_grant(grant_id)?;
        // Pre-check the path shape and the target's absence outside the lock
        // so an existing target is a typed rejection before any approval
        // card. The commit re-checks no-overwrite atomically under the lock.
        assert_no_reparse_components(&grant.root, &grant.root.join(relative_path))?;
        if fs::symlink_metadata(&grant.root.join(relative_path)).is_ok() {
            return Err(workspace_file_exists());
        }
        Ok(CreateFilePreview {
            planned_digest: sha256_hex(content.as_bytes()),
            size_bytes: content.len() as u64,
            content: content.to_owned(),
            root_digest: grant.root_digest,
        })
    }

    /// Build the Backend-computed full diff for an approved-eligible patch.
    /// Reads the current file outside the target lock (no mutation happens),
    /// verifies the CAS digest, validates every UTF-16 offset, applies the
    /// edits, and produces the complete diff. Any violation fails closed.
    pub(crate) fn patch_text_preview(
        &self,
        binding: &WorkspaceFileBinding,
        edits: &[PatchEdit],
    ) -> Result<PatchTextPreview, WorkspaceError> {
        validate_edits(edits)?;
        let qualified = self.read_qualified(&binding.grant_id, &binding.relative_path)?;
        if qualified.root_digest != binding.root_digest
            || qualified.file_identity != binding.file_identity
        {
            return Err(workspace_file_changed());
        }
        let current = String::from_utf8(qualified.content.clone())
            .map_err(|_| workspace_file_type_denied())?;
        if current.as_bytes().len() > MAX_WRITE_CONTENT_BYTES {
            return Err(workspace_file_changed());
        }
        if !current.starts_with('\u{feff}') != !binding.has_bom
            || newline_style(&current) != Some(binding.newline)
        {
            return Err(workspace_file_changed());
        }
        if sha256_hex(qualified.content.as_slice()) != binding.file_digest {
            return Err(workspace_file_changed());
        }
        let (after, _changed_lines) = apply_utf16_edits(&current, edits)?;
        if after.len() > MAX_WRITE_CONTENT_BYTES {
            return Err(workspace_preview_too_large());
        }
        let diff = build_text_diff(&current, &after);
        let changed_lines = diff.lines().count();
        if changed_lines > MAX_DIFF_LINES {
            return Err(workspace_diff_too_large());
        }
        if diff.len() > MAX_PREVIEW_BYTES {
            return Err(workspace_preview_too_large());
        }
        Ok(PatchTextPreview {
            diff,
            planned_digest: sha256_hex(after.as_bytes()),
            final_size_bytes: after.len() as u64,
        })
    }

    /// Commit a new file under the per-target lock: re-canonicalize, reparse
    /// and containment-check every component, require an existing safe parent,
    /// require the target to be absent, then atomically create with a
    /// same-directory verified temporary and a no-clobber move.
    pub(crate) fn commit_create_text(
        &self,
        binding: &WorkspaceCreateBinding,
        content: &str,
    ) -> Result<WorkspaceWriteOutcome, WorkspaceError> {
        let grant = self.resolve_grant(&binding.grant_id)?;
        let target = grant.root.join(&binding.relative_path);
        let lock = workspace_mutation_lock(&self.db_path, &target)?;
        let _guard = lock.lock().map_err(|_| workspace_write_failed())?;
        self.commit_create_text_locked(binding, content)
    }

    /// Same implementation as `commit_create_text`, but entered while the
    /// caller holds this exact target's mutation lock. Change sets acquire all
    /// their locks in a stable order before calling this helper so a second
    /// in-process Agent cannot interleave its own preflight/commit sequence.
    fn commit_create_text_locked(
        &self,
        binding: &WorkspaceCreateBinding,
        content: &str,
    ) -> Result<WorkspaceWriteOutcome, WorkspaceError> {
        validate_write_target(&binding.relative_path)?;
        validate_new_content(content)?;
        if sha256_hex(content.as_bytes()) != binding.content_digest {
            return Err(workspace_file_ref_invalid());
        }
        let grant = self.resolve_grant(&binding.grant_id)?;
        if grant.root_digest != binding.root_digest {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            ));
        }
        let grant = self.resolve_grant(&binding.grant_id)?;
        if grant.root_digest != binding.root_digest {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            ));
        }
        let target = grant.root.join(&binding.relative_path);
        #[cfg(windows)]
        let _path_guards = lock_workspace_parent(&grant.root, &binding.root_digest, &target)?;
        #[cfg(not(windows))]
        assert_no_reparse_components(&grant.root, &target)?;
        let parent = target.parent().ok_or_else(workspace_path_invalid)?;
        let parent_metadata =
            fs::symlink_metadata(parent).map_err(|_| workspace_parent_missing())?;
        if !parent_metadata.is_dir()
            || parent_metadata.file_type().is_symlink()
            || is_reparse_point(&parent_metadata)
        {
            return Err(if parent_metadata.is_dir() {
                WorkspaceError::new(
                    "workspace-reparse-denied",
                    "Workspace parent crosses a reparse point",
                )
            } else {
                workspace_parent_missing()
            });
        }
        if !parent.starts_with(&grant.root) {
            return Err(workspace_containment_denied());
        }
        if fs::symlink_metadata(&target).is_ok() {
            return Err(workspace_file_exists());
        }
        #[cfg(test)]
        self.invoke_after_final_validation_hook();
        atomic_create_no_replace(&target, content.as_bytes())?;
        Ok(WorkspaceWriteOutcome {
            content_digest: sha256_hex(content.as_bytes()),
            size_bytes: content.len() as u64,
            disposition: WorkspaceCommitDisposition::Committed,
        })
    }

    /// Commit a CAS patch under the per-target lock. The file identity,
    /// reparse/containment, digest, BOM and newline are re-verified, edits are
    /// reapplied to the current content, and the result is atomically
    /// replaced. External edits or concurrent Agent writes produce exactly one
    /// winner; every loser receives a typed conflict and never overwrites.
    pub(crate) fn commit_patch_text(
        &self,
        binding: &WorkspaceFileBinding,
        edits: &[PatchEdit],
    ) -> Result<WorkspaceWriteOutcome, WorkspaceCommitFailure> {
        let grant = self.resolve_grant(&binding.grant_id)?;
        if grant.root_digest != binding.root_digest {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            )
            .into());
        }
        let target = grant.root.join(&binding.relative_path);
        let lock = workspace_mutation_lock(&self.db_path, &target)?;
        let _guard = lock.lock().map_err(|_| workspace_write_failed())?;
        self.commit_patch_text_locked(binding, edits)
    }

    /// Same implementation as `commit_patch_text`, but entered while this
    /// target's mutation lock is already held by the caller.
    fn commit_patch_text_locked(
        &self,
        binding: &WorkspaceFileBinding,
        edits: &[PatchEdit],
    ) -> Result<WorkspaceWriteOutcome, WorkspaceCommitFailure> {
        validate_edits(edits)?;
        let grant = self.resolve_grant(&binding.grant_id)?;
        if grant.root_digest != binding.root_digest {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            )
            .into());
        }
        let grant = self.resolve_grant(&binding.grant_id)?;
        if grant.root_digest != binding.root_digest {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            )
            .into());
        }
        let target = grant.root.join(&binding.relative_path);
        #[cfg(windows)]
        let _path_guards = lock_workspace_parent(&grant.root, &binding.root_digest, &target)?;
        #[cfg(not(windows))]
        assert_no_reparse_components(&grant.root, &target)?;
        #[cfg(windows)]
        let mut target_file =
            open_workspace_file_no_follow(&target, true).map_err(|_| workspace_file_not_found())?;
        #[cfg(windows)]
        if workspace_file_identity(&target_file, &target)? != binding.file_identity {
            return Err(workspace_file_changed().into());
        }
        #[cfg(windows)]
        let current_bytes = {
            target_file
                .seek(SeekFrom::Start(0))
                .map_err(|_| workspace_read_error())?;
            let mut bytes = Vec::new();
            target_file
                .read_to_end(&mut bytes)
                .map_err(|_| workspace_read_error())?;
            if bytes.contains(&0) {
                return Err(workspace_file_type_denied().into());
            }
            bytes
        };
        #[cfg(not(windows))]
        let current_bytes = read_file_bytes(&target)?;
        let current =
            String::from_utf8(current_bytes.clone()).map_err(|_| workspace_file_type_denied())?;
        if current.as_bytes().len() > MAX_WRITE_CONTENT_BYTES {
            return Err(workspace_file_changed().into());
        }
        if !current.starts_with('\u{feff}') != !binding.has_bom
            || newline_style(&current) != Some(binding.newline)
        {
            return Err(workspace_file_changed().into());
        }
        if sha256_hex(&current_bytes) != binding.file_digest {
            return Err(workspace_file_changed().into());
        }
        let (after, _changed_lines) = apply_utf16_edits(&current, edits)?;
        if after.len() > MAX_WRITE_CONTENT_BYTES {
            return Err(workspace_preview_too_large().into());
        }
        #[cfg(windows)]
        {
            let prepared = prepare_workspace_patch(
                &target,
                &current_bytes,
                after.as_bytes(),
                &binding.file_identity,
            )?;
            #[cfg(test)]
            self.invoke_after_final_validation_hook();
            #[cfg(test)]
            let after_target_renamed = self.take_after_target_renamed_hook();
            #[cfg(test)]
            commit_prepared_workspace_patch(&target, target_file, prepared, after_target_renamed)?;
            #[cfg(not(test))]
            commit_prepared_workspace_patch(&target, target_file, prepared)?;
        }
        #[cfg(not(windows))]
        atomic_replace_file(&target, after.as_bytes())?;
        Ok(WorkspaceWriteOutcome {
            content_digest: sha256_hex(after.as_bytes()),
            size_bytes: after.len() as u64,
            disposition: WorkspaceCommitDisposition::Committed,
        })
    }

    /// Commit one small, previously previewed change set. This does not claim
    /// a filesystem transaction: all targets are first locked in a stable
    /// order and preflighted, then files commit sequentially. Once the first
    /// mutation lands, a later failure or Stop returns an explicit partial
    /// outcome; an unknown post-mutation result remains durable-uncertain and
    /// is never replayed.
    pub(crate) fn commit_change_set(
        &self,
        binding: &WorkspaceChangeSetBinding,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<WorkspaceChangeSetOutcome, WorkspaceCommitFailure> {
        if binding.items.len() < 2 || binding.items.len() > MAX_CHANGE_SET_FILES {
            return Err(workspace_change_set_invalid().into());
        }

        let mut keyed_locks = Vec::<(String, Arc<Mutex<()>>)>::new();
        for item in &binding.items {
            let grant = self.resolve_grant(item.grant_id())?;
            if grant.root_digest != item.root_digest() {
                return Err(WorkspaceError::new(
                    "workspace-grant-changed",
                    "Workspace grant identity changed",
                )
                .into());
            }
            let target = grant.root.join(item.relative_path());
            let key = target.to_string_lossy().to_ascii_lowercase();
            let lock = workspace_mutation_lock(&self.db_path, &target)?;
            keyed_locks.push((key, lock));
        }
        keyed_locks.sort_by(|left, right| left.0.cmp(&right.0));
        if keyed_locks.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return Err(workspace_change_set_invalid().into());
        }
        let _guards = keyed_locks
            .iter()
            .map(|(_, lock)| lock.lock().map_err(|_| workspace_write_failed()))
            .collect::<Result<Vec<_>, _>>()?;

        // Preflight every bound target while every in-process target lock is
        // held. A failure here is proven write0: the commit loop has not run.
        for item in &binding.items {
            match item {
                WorkspaceChangeSetItem::Create {
                    binding,
                    content,
                    planned_digest,
                    ..
                } => {
                    let preview = self.create_text_preview(
                        &binding.grant_id,
                        &binding.relative_path,
                        content,
                    )?;
                    if preview.planned_digest != *planned_digest {
                        return Err(workspace_file_ref_invalid().into());
                    }
                }
                WorkspaceChangeSetItem::Patch {
                    binding,
                    edits,
                    planned_digest,
                    ..
                } => {
                    let preview = self.patch_text_preview(binding, edits)?;
                    if preview.planned_digest != *planned_digest {
                        return Err(workspace_file_ref_invalid().into());
                    }
                }
            }
        }
        if cancelled() {
            return Err(workspace_change_set_stopped().into());
        }

        let mut outcomes = Vec::with_capacity(binding.items.len());
        for (index, item) in binding.items.iter().enumerate() {
            if cancelled() {
                for pending in binding.items.iter().skip(index) {
                    outcomes.push(change_set_item_outcome(
                        pending,
                        WorkspaceCommitDisposition::KnownNotWritten,
                    ));
                }
                if outcomes
                    .iter()
                    .any(|outcome| outcome.disposition == WorkspaceCommitDisposition::Committed)
                {
                    return Ok(WorkspaceChangeSetOutcome { items: outcomes });
                }
                return Err(workspace_change_set_stopped().into());
            }
            let result = match item {
                WorkspaceChangeSetItem::Create {
                    binding, content, ..
                } => self
                    .commit_create_text_locked(binding, content)
                    .map_err(Into::into),
                WorkspaceChangeSetItem::Patch { binding, edits, .. } => {
                    self.commit_patch_text_locked(binding, edits)
                }
            };
            match result {
                Ok(result) => {
                    if result.content_digest != item.planned_digest() {
                        return Err(WorkspaceCommitFailure::unknown_after_mutation(
                            workspace_write_uncertain(),
                        ));
                    }
                    outcomes.push(change_set_item_outcome(
                        item,
                        WorkspaceCommitDisposition::Committed,
                    ));
                }
                Err(error)
                    if error.disposition == WorkspaceCommitDisposition::UnknownAfterMutation =>
                {
                    // The locator/journal will be retained by the caller. Do
                    // not manufacture a partial-success artifact while any
                    // target's state cannot be proven.
                    return Err(error);
                }
                Err(error) => {
                    outcomes.push(change_set_item_outcome(
                        item,
                        WorkspaceCommitDisposition::KnownNotWritten,
                    ));
                    for pending in binding.items.iter().skip(index + 1) {
                        outcomes.push(change_set_item_outcome(
                            pending,
                            WorkspaceCommitDisposition::KnownNotWritten,
                        ));
                    }
                    if outcomes
                        .iter()
                        .any(|outcome| outcome.disposition == WorkspaceCommitDisposition::Committed)
                    {
                        return Ok(WorkspaceChangeSetOutcome { items: outcomes });
                    }
                    return Err(error);
                }
            }
        }
        Ok(WorkspaceChangeSetOutcome { items: outcomes })
    }

    /// Reconcile a durable change-set locator without replaying a file write.
    /// Each target is evaluated independently after its Windows journal (if
    /// any) has recovered to a provable state.
    pub(crate) fn reconcile_change_set(
        &self,
        locator: &WorkspaceChangeSetLocator,
    ) -> Result<WorkspaceChangeSetReconciliation, WorkspaceError> {
        if locator.version != 1
            || locator.items.len() < 2
            || locator.items.len() > MAX_CHANGE_SET_FILES
        {
            return Err(workspace_change_set_invalid());
        }
        let mut committed = 0usize;
        let mut not_committed = 0usize;
        for item in &locator.items {
            if !matches!(item.operation.as_str(), "create" | "patch")
                || item.planned_digest.len() != 64
                || item.open_token.is_empty()
                || item.open_token.len() > 96
            {
                return Err(workspace_change_set_invalid());
            }
            let current = self.reconcile_digest(&item.locator)?;
            if current.as_deref() == Some(item.planned_digest.as_str()) {
                committed += 1;
                continue;
            }
            let known_not_written = match item.operation.as_str() {
                "create" => current.is_none(),
                "patch" => current.as_deref() == item.expected_digest.as_deref(),
                _ => false,
            };
            if known_not_written {
                not_committed += 1;
                continue;
            }
            return Ok(WorkspaceChangeSetReconciliation::Uncertain);
        }
        Ok(match (committed, not_committed) {
            (0, _) => WorkspaceChangeSetReconciliation::NotCommitted,
            (_, 0) => WorkspaceChangeSetReconciliation::Committed,
            _ => WorkspaceChangeSetReconciliation::Partial,
        })
    }

    /// Safe read used only by startup artifact reconciliation: resolve the
    /// grant, enforce identity/reparse/containment, and return the current
    /// file digest or None when the file is absent or unsafe to read.
    pub(crate) fn reconcile_digest(
        &self,
        locator: &WorkspaceWriteLocator,
    ) -> Result<Option<String>, WorkspaceError> {
        let grant = self.resolve_grant(&locator.grant_id)?;
        if locator.root_digest.is_empty() || grant.root_digest != locator.root_digest {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            ));
        }
        let target = grant.root.join(&locator.relative_path);
        #[cfg(windows)]
        {
            let _path_guards = lock_workspace_parent(&grant.root, &locator.root_digest, &target)?;
            recover_workspace_patch(&target)?;
        }
        let qualified = match self.read_qualified(&locator.grant_id, &locator.relative_path) {
            Ok(qualified) => qualified,
            Err(error)
                if matches!(
                    error.code,
                    "workspace-file-not-found"
                        | "workspace-grant-not-found"
                        | "workspace-grant-unavailable"
                        | "workspace-grant-changed"
                        | "workspace-grant-reparse-denied"
                        | "workspace-file-type-denied"
                        | "workspace-read-failed"
                        | "workspace-reparse-denied"
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        Ok(Some(sha256_hex(&qualified.content)))
    }

    /// Resolve the physical target of a committed workspace artifact with the
    /// same identity/root-digest/lock/recover checks as `reconcile_digest`.
    /// Used only by the Backend open seam; the returned path never leaves the
    /// Backend. The caller must additionally verify the planned digest before
    /// opening anything.
    pub(crate) fn resolve_committed_target(
        &self,
        locator: &WorkspaceWriteLocator,
    ) -> Result<PathBuf, WorkspaceError> {
        let grant = self.resolve_grant(&locator.grant_id)?;
        if locator.root_digest.is_empty() || grant.root_digest != locator.root_digest {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            ));
        }
        let target = grant.root.join(&locator.relative_path);
        #[cfg(windows)]
        {
            let _path_guards = lock_workspace_parent(&grant.root, &locator.root_digest, &target)?;
            recover_workspace_patch(&target)?;
        }
        Ok(self
            .resolve_file(&locator.grant_id, &locator.relative_path, true)?
            .path)
    }

    /// Build the run-bound fileRef for one qualified read result. The caller
    /// owns the binding store; the service only projects the private binding.
    pub(crate) fn file_binding(
        &self,
        grant_id: &str,
        workspace_name: &str,
        relative_path: &str,
        result: &WorkspaceReadResult,
        principal: [u8; 32],
        conversation_id: &str,
    ) -> WorkspaceFileBinding {
        let has_bom = result.content.starts_with('\u{feff}');
        WorkspaceFileBinding {
            grant_id: grant_id.to_owned(),
            workspace_name: workspace_name.to_owned(),
            relative_path: relative_path.to_owned(),
            root_digest: result.root_digest.clone(),
            file_identity: result.file_identity.clone(),
            file_digest: result.content_digest.clone(),
            size_bytes: result.size_bytes,
            has_bom,
            newline: newline_style(&result.content).unwrap_or(NewlineStyle::Lf),
            principal,
            conversation_id: conversation_id.to_owned(),
            expires_at: Instant::now() + WORKSPACE_FILE_REFERENCE_TTL,
        }
    }

    pub(crate) fn create_binding(
        &self,
        grant_id: &str,
        workspace_name: &str,
        relative_path: &str,
        preview: &CreateFilePreview,
        principal: [u8; 32],
        conversation_id: &str,
    ) -> WorkspaceCreateBinding {
        WorkspaceCreateBinding {
            grant_id: grant_id.to_owned(),
            workspace_name: workspace_name.to_owned(),
            relative_path: relative_path.to_owned(),
            root_digest: preview.root_digest.clone(),
            content_digest: preview.planned_digest.clone(),
            principal,
            conversation_id: conversation_id.to_owned(),
            expires_at: Instant::now() + WORKSPACE_FILE_REFERENCE_TTL,
        }
    }

    fn resolve_file(
        &self,
        grant_id: &str,
        relative_path: &str,
        require_safe_text: bool,
    ) -> Result<ResolvedWorkspaceFile, WorkspaceError> {
        let grant = self.resolve_grant(grant_id)?;
        validate_relative_path(relative_path)?;
        let candidate = grant.root.join(relative_path);
        assert_no_reparse_components(&grant.root, &candidate)?;
        let canonical = fs::canonicalize(&candidate).map_err(|_| {
            WorkspaceError::new("workspace-file-not-found", "Workspace file is unavailable")
        })?;
        if !canonical.starts_with(&grant.root) {
            return Err(WorkspaceError::new(
                "workspace-containment-denied",
                "Workspace file is outside the authorized root",
            ));
        }
        let metadata = fs::symlink_metadata(&canonical).map_err(|_| workspace_read_error())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || is_reparse_point(&metadata)
            || (require_safe_text && !is_safe_text_file(&canonical))
        {
            return Err(WorkspaceError::new(
                "workspace-file-type-denied",
                if require_safe_text {
                    "Only bounded text files can be read"
                } else {
                    "Only regular files can be imported"
                },
            ));
        }
        let relative = safe_relative_string(&grant.root, &canonical)?;
        Ok(ResolvedWorkspaceFile {
            root: grant.root,
            relative,
            path: canonical,
            root_digest: grant.root_digest,
        })
    }

    fn resolve_grant(&self, grant_id: &str) -> Result<ResolvedGrant, WorkspaceError> {
        validate_public_id(grant_id)?;
        let connection = self.open_read()?;
        let (root, registered_identity) = connection
            .query_row(
                "SELECT canonical_root, root_digest FROM agent_workspace_grant
                 WHERE id = ?1 AND enabled = 1",
                [grant_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| workspace_database_error())?
            .ok_or_else(|| {
                WorkspaceError::new(
                    "workspace-grant-not-found",
                    "Workspace grant is disabled or unavailable",
                )
            })?;
        let root = PathBuf::from(root);
        let canonical = fs::canonicalize(&root).map_err(|_| {
            WorkspaceError::new(
                "workspace-grant-unavailable",
                "Workspace grant root is unavailable",
            )
        })?;
        if canonical != root {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            ));
        }
        let metadata = fs::symlink_metadata(&canonical).map_err(|_| workspace_read_error())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(WorkspaceError::new(
                "workspace-grant-reparse-denied",
                "Workspace grant root is no longer safe",
            ));
        }
        let actual_identity = workspace_path_identity(&canonical, true)?;
        let root_digest = if registered_identity == actual_identity {
            actual_identity
        } else if registered_identity == legacy_root_path_digest(&canonical) {
            // Existing R6.1 grants predate filesystem identities. Upgrade the
            // value atomically in the existing column; this is not a schema
            // migration and races fail closed by comparing the old value.
            let connection = self.open_write()?;
            let changed = connection
                .execute(
                    "UPDATE agent_workspace_grant SET root_digest=?2,updated_at=?3
                     WHERE id=?1 AND enabled=1 AND root_digest=?4",
                    params![
                        grant_id,
                        actual_identity,
                        chrono::Utc::now().to_rfc3339(),
                        registered_identity
                    ],
                )
                .map_err(|_| workspace_database_error())?;
            if changed != 1 {
                return Err(WorkspaceError::new(
                    "workspace-grant-changed",
                    "Workspace grant identity changed",
                ));
            }
            actual_identity
        } else {
            return Err(WorkspaceError::new(
                "workspace-grant-changed",
                "Workspace grant identity changed",
            ));
        };
        Ok(ResolvedGrant {
            root: canonical,
            root_digest,
        })
    }

    fn view(&self, grant_id: &str) -> Result<WorkspaceGrantView, WorkspaceError> {
        let connection = self.open_read()?;
        connection
            .query_row(
                "SELECT id, label, root_name, enabled, created_at, updated_at
                 FROM agent_workspace_grant WHERE id = ?1",
                [grant_id],
                |row| {
                    Ok(WorkspaceGrantView {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        root_name: row.get(2)?,
                        enabled: row.get::<_, i64>(3)? != 0,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|_| workspace_database_error())?
            .ok_or_else(|| {
                WorkspaceError::new(
                    "workspace-grant-not-found",
                    "Workspace grant no longer exists",
                )
            })
    }

    fn open_read(&self) -> Result<Connection, WorkspaceError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }

    fn open_write(&self) -> Result<Connection, WorkspaceError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }
}

struct ResolvedGrant {
    root: PathBuf,
    root_digest: String,
}

struct ResolvedWorkspaceFile {
    root: PathBuf,
    path: PathBuf,
    relative: String,
    root_digest: String,
}

fn validate_relative_path(value: &str) -> Result<(), WorkspaceError> {
    if value.is_empty()
        || value.as_bytes().len() > 1024
        || value.contains('\0')
        || Path::new(value).is_absolute()
        || Path::new(value).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(WorkspaceError::new(
            "workspace-path-invalid",
            "Workspace path must be relative to an authorized grant",
        ));
    }
    Ok(())
}

/// Write-target policy. Rejects absolute/UNC/prefix/parent traversal, NUL,
/// ADS colons, trailing dots/spaces, Windows reserved device names, denied
/// segments, sensitive credential/temp/backup targets, and non-text
/// extensions. The policy is enforced by direct contract, never by prompt.
fn validate_write_target(value: &str) -> Result<(), WorkspaceError> {
    if value.is_empty()
        || value.chars().count() > MAX_WRITE_PATH_CHARS
        || value.contains('\0')
        || Path::new(value).is_absolute()
        || Path::new(value).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(workspace_path_invalid());
    }
    let mut components = Vec::new();
    for component in Path::new(value).components() {
        let Component::Normal(component) = component else {
            return Err(workspace_path_invalid());
        };
        let name = component.to_str().ok_or_else(workspace_path_invalid)?;
        components.push(name);
        validate_write_component(name)?;
    }
    let file_name = components.pop().ok_or_else(workspace_path_invalid)?;
    let lower = file_name.to_ascii_lowercase();
    if SENSITIVE_FILE_NAMES.iter().any(|name| *name == lower) {
        return Err(workspace_write_denied());
    }
    if SENSITIVE_TEMP_SUFFIXES
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        return Err(workspace_write_denied());
    }
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if SENSITIVE_EXTENSIONS
        .iter()
        .any(|sensitive| *sensitive == extension)
    {
        return Err(workspace_write_denied());
    }
    if !is_writable_text_extension(&extension) {
        return Err(WorkspaceError::new(
            "workspace-file-type-denied",
            "Only explicit text extensions can be created or patched",
        ));
    }
    Ok(())
}

fn validate_write_component(name: &str) -> Result<(), WorkspaceError> {
    let lower = name.to_ascii_lowercase();
    if WRITE_DENY_SEGMENTS.iter().any(|segment| *segment == lower) {
        return Err(workspace_write_denied());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(workspace_write_denied());
    }
    #[cfg(windows)]
    if name.contains(':') {
        return Err(workspace_write_denied());
    }
    if is_windows_reserved_name(&lower) {
        return Err(workspace_write_denied());
    }
    Ok(())
}

fn is_windows_reserved_name(lower: &str) -> bool {
    let stem = lower.split('.').next().unwrap_or(lower);
    matches!(
        stem,
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

fn is_writable_text_extension(extension: &str) -> bool {
    matches!(
        extension,
        "md" | "markdown"
            | "txt"
            | "json"
            | "jsonl"
            | "csv"
            | "tsv"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "html"
            | "css"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "rs"
            | "py"
            | "java"
            | "kt"
            | "swift"
            | "go"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "sql"
            | "ini"
            | "conf"
    )
}

/// New files are UTF-8 without BOM and LF-only. Mixed newlines, NUL bytes,
/// and any carriage returns are rejected.
fn validate_new_content(content: &str) -> Result<(), WorkspaceError> {
    if content.contains('\0') {
        return Err(workspace_file_type_denied());
    }
    if content.starts_with('\u{feff}') {
        return Err(WorkspaceError::new(
            "workspace-write-denied",
            "New workspace files must not carry a BOM",
        ));
    }
    if content.contains('\r') {
        return Err(WorkspaceError::new(
            "workspace-write-denied",
            "New workspace files must use LF line endings",
        ));
    }
    if content.as_bytes().len() > MAX_WRITE_CONTENT_BYTES {
        return Err(workspace_preview_too_large());
    }
    Ok(())
}

/// Public read-qualification: `Some` only when the content has one consistent
/// newline convention; mixed newlines yield `None` and never a writable ref.
pub(crate) fn qualified_read_newline(content: &str) -> Option<NewlineStyle> {
    newline_style(content)
}

fn newline_style(content: &str) -> Option<NewlineStyle> {
    if content.contains('\r') {
        let bytes = content.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\r' => {
                    if index + 1 >= bytes.len() || bytes[index + 1] != b'\n' {
                        return None;
                    }
                    index += 2;
                }
                b'\n' => return None,
                _ => index += 1,
            }
        }
        Some(NewlineStyle::CrLf)
    } else {
        Some(NewlineStyle::Lf)
    }
}

/// Strict UTF-16 offset validation: every offset must sit on a char boundary,
/// edits must not overlap, and the sorted application order is deterministic.
/// Returns (final_text, changed_lines_in_diff).
fn apply_utf16_edits(
    content: &str,
    edits: &[PatchEdit],
) -> Result<(String, usize), WorkspaceError> {
    validate_edits(edits)?;
    let mut boundaries = vec![0usize];
    let mut total_units = 0usize;
    for ch in content.chars() {
        let mut buffer = [0u16; 2];
        total_units += ch.encode_utf16(&mut buffer).len();
        boundaries.push(total_units);
    }
    let mut sorted = edits.to_vec();
    sorted.sort_by_key(|edit| edit.start_utf16);
    let mut previous_end = 0usize;
    let mut result = Vec::with_capacity(content.len());
    let mut cursor = 0usize;
    for edit in &sorted {
        if edit.start_utf16 < previous_end
            || edit.start_utf16 > edit.end_utf16
            || edit.end_utf16 > total_units
            || !boundaries.contains(&edit.start_utf16)
            || !boundaries.contains(&edit.end_utf16)
        {
            return Err(workspace_edit_invalid());
        }
        result.push(content_units(content, cursor, edit.start_utf16)?);
        result.push(edit.replacement.clone());
        cursor = edit.end_utf16;
        previous_end = edit.end_utf16;
    }
    result.push(content_units(content, cursor, total_units)?);
    let after = result.concat();
    if after.len() > MAX_WRITE_CONTENT_BYTES {
        return Err(workspace_preview_too_large());
    }
    Ok((after, 0))
}

/// Extract the UTF-16 slice [start, end) from content as a String. Both
/// offsets must be char boundaries; callers validate this beforehand.
fn content_units(content: &str, start: usize, end: usize) -> Result<String, WorkspaceError> {
    if start == end {
        return Ok(String::new());
    }
    let mut units = Vec::new();
    let mut current = 0usize;
    for ch in content.chars() {
        let mut buffer = [0u16; 2];
        let length = ch.encode_utf16(&mut buffer).len();
        if current + length > start && current < end {
            let mut buffer = [0u16; 2];
            let encoded = ch.encode_utf16(&mut buffer);
            units.extend_from_slice(encoded);
        }
        current += length;
        if current >= end {
            break;
        }
    }
    if current < end {
        return Err(workspace_edit_invalid());
    }
    String::from_utf16(&units).map_err(|_| workspace_edit_invalid())
}

fn validate_edits(edits: &[PatchEdit]) -> Result<(), WorkspaceError> {
    if edits.is_empty() || edits.len() > MAX_PATCH_EDITS {
        return Err(workspace_edit_invalid());
    }
    for edit in edits {
        if edit.replacement.as_bytes().len() > MAX_WRITE_CONTENT_BYTES
            || edit.replacement.contains('\0')
        {
            return Err(workspace_edit_invalid());
        }
    }
    Ok(())
}

/// Simple deterministic line diff over the changed region. The result is the
/// full serialized diff; the caller enforces the preview byte limit.
fn build_text_diff(before: &str, after: &str) -> String {
    let before_lines = before.lines().collect::<Vec<_>>();
    let after_lines = after.lines().collect::<Vec<_>>();
    let mut prefix = 0usize;
    while prefix < before_lines.len()
        && prefix < after_lines.len()
        && before_lines[prefix] == after_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < before_lines.len().saturating_sub(prefix)
        && suffix < after_lines.len().saturating_sub(prefix)
        && before_lines[before_lines.len() - 1 - suffix]
            == after_lines[after_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let mut diff = String::new();
    for line in &before_lines[prefix..before_lines.len() - suffix] {
        diff.push_str("- ");
        diff.push_str(line);
        diff.push('\n');
    }
    for line in &after_lines[prefix..after_lines.len() - suffix] {
        diff.push_str("+ ");
        diff.push_str(line);
        diff.push('\n');
    }
    diff
}

/// Same-directory verified temporary + sync + atomic no-clobber create.
fn atomic_create_no_replace(target: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
    let parent = target.parent().ok_or_else(workspace_path_invalid)?;
    let temporary = temporary_path(parent);
    write_new_synced(&temporary, bytes)?;
    let result = move_file_no_replace(&temporary, target);
    let _ = fs::remove_file(&temporary);
    result
}

/// Same-directory verified temporary + sync + atomic replace of the target.
/// Windows uses the handle-bound transaction below instead of a path replace.
#[cfg(not(windows))]
fn atomic_replace_file(target: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
    let parent = target.parent().ok_or_else(workspace_path_invalid)?;
    let temporary = temporary_path(parent);
    write_new_synced(&temporary, bytes)?;
    let result = replace_file_atomic(&temporary, target);
    let _ = fs::remove_file(&temporary);
    result
}

/// Handle guards for every extant component from an authorized root to the
/// target parent. On Windows each handle denies DELETE sharing, so a late
/// external rename/junction replacement cannot redirect the final commit.
#[cfg(windows)]
struct WorkspaceCommitGuards {
    _directories: Vec<File>,
}

#[cfg(windows)]
fn lock_workspace_parent(
    root: &Path,
    expected_root_digest: &str,
    target: &Path,
) -> Result<WorkspaceCommitGuards, WorkspaceError> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| workspace_containment_denied())?;
    let components = relative
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_owned()),
            _ => Err(workspace_path_invalid()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err(workspace_path_invalid());
    }
    let mut current = root.to_path_buf();
    let root_guard = open_workspace_directory_guard(&current)?;
    if workspace_file_identity(&root_guard, &current)? != expected_root_digest {
        return Err(WorkspaceError::new(
            "workspace-grant-changed",
            "Workspace grant identity changed",
        ));
    }
    let mut directories = vec![root_guard];
    for component in components.iter().take(components.len().saturating_sub(1)) {
        current.push(component);
        let guard =
            open_workspace_directory_guard(&current).map_err(|_| workspace_parent_missing())?;
        directories.push(guard);
    }
    Ok(WorkspaceCommitGuards {
        _directories: directories,
    })
}

#[cfg(windows)]
fn prepare_workspace_patch(
    target: &Path,
    original_bytes: &[u8],
    next_bytes: &[u8],
    original_file_identity: &str,
) -> Result<PreparedWorkspacePatch, WorkspaceError> {
    let parent = target.parent().ok_or_else(workspace_path_invalid)?;
    let target_file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(workspace_path_invalid)?
        .to_owned();
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let temp_file_name = format!(".lrw-{nonce}.tmp");
    let backup_file_name = format!(".lrw-{nonce}.backup");
    let journal_file_name = format!(".lrw-{nonce}.journal");
    let temp = parent.join(&temp_file_name);
    let backup = parent.join(&backup_file_name);
    let journal = parent.join(&journal_file_name);
    write_new_synced(&temp, next_bytes)?;
    let next_file_identity = match open_workspace_file_no_follow(&temp, false)
        .and_then(|file| workspace_file_identity(&file, &temp))
    {
        Ok(identity) => identity,
        Err(error) => {
            let _ = remove_workspace_transaction_file(&temp);
            return Err(error);
        }
    };
    let record = WorkspaceWriteJournal {
        version: WORKSPACE_WRITE_JOURNAL_VERSION,
        target_file_name,
        backup_file_name,
        temp_file_name,
        original_digest: sha256_hex(original_bytes),
        next_digest: sha256_hex(next_bytes),
        original_file_identity: original_file_identity.to_owned(),
        next_file_identity: next_file_identity.clone(),
    };
    let encoded = serde_json::to_vec(&record).map_err(|_| workspace_write_failed())?;
    if let Err(error) = write_new_synced(&journal, &encoded) {
        let _ = remove_workspace_transaction_file(&temp);
        return Err(error);
    }
    Ok(PreparedWorkspacePatch {
        temp,
        backup,
        journal,
        original_digest: record.original_digest,
        next_digest: record.next_digest,
        original_file_identity: record.original_file_identity,
        next_file_identity,
    })
}

#[cfg(windows)]
fn commit_prepared_workspace_patch(
    target: &Path,
    target_file: File,
    prepared: PreparedWorkspacePatch,
    #[cfg(test)] after_target_renamed: Option<AfterWorkspaceTargetRenamedHook>,
) -> Result<(), WorkspaceCommitFailure> {
    if let Err(error) = rename_open_workspace_file(&target_file, &prepared.backup) {
        prepared.cleanup_before_commit();
        return Err(error.into());
    }
    drop(target_file);
    #[cfg(test)]
    if let Some(hook) = after_target_renamed {
        hook(target, &prepared.temp, &prepared.backup);
    }
    if let Err(error) = move_file_no_replace(&prepared.temp, target) {
        // Once target -> backup has succeeded, a failed install can only be a
        // known no-write if the original file can be restored and then proved
        // to be the same identity and digest. Every other branch keeps the
        // journal/locator for durable uncertain reconciliation.
        if restore_original_after_failed_install(target, &prepared) {
            return Err(error.into());
        }
        return Err(WorkspaceCommitFailure::unknown_after_mutation(
            workspace_write_uncertain(),
        ));
    }
    // The target can be considered committed only after its exact temporary
    // file identity and planned digest are observable at the final name.
    if !matches!(
        workspace_recovery_file_matches(
            target,
            &prepared.next_digest,
            &prepared.next_file_identity,
        ),
        Ok(Some(true))
    ) {
        return Err(WorkspaceCommitFailure::unknown_after_mutation(
            workspace_write_uncertain(),
        ));
    }
    // New target is authoritative. Cleanup is best effort only after commit
    // has been proved; if an external process made cleanup unsafe, leaving the
    // journal is safer than rewriting or falsely rolling back.
    if matches!(
        workspace_recovery_file_matches(
            &prepared.backup,
            &prepared.original_digest,
            &prepared.original_file_identity,
        ),
        Ok(Some(true))
    ) {
        let _ = remove_workspace_transaction_file(&prepared.backup);
    }
    let _ = remove_workspace_transaction_file(&prepared.journal);
    Ok(())
}

#[cfg(windows)]
fn restore_original_after_failed_install(target: &Path, prepared: &PreparedWorkspacePatch) -> bool {
    if target.exists()
        || !matches!(
            workspace_recovery_file_matches(
                &prepared.temp,
                &prepared.next_digest,
                &prepared.next_file_identity,
            ),
            Ok(None) | Ok(Some(true))
        )
    {
        return false;
    }
    // Keep the exact original backup handle open from identity/digest
    // verification through the no-replace rename. A path-only restore would
    // reopen a Windows TOCTOU interval just as we try to prove rollback.
    let Ok(Some(backup_file)) = workspace_recovery_open_exact(
        &prepared.backup,
        &prepared.original_digest,
        &prepared.original_file_identity,
    ) else {
        return false;
    };
    if rename_open_workspace_file(&backup_file, target).is_err() {
        return false;
    }
    drop(backup_file);
    if !matches!(
        workspace_recovery_file_matches(
            target,
            &prepared.original_digest,
            &prepared.original_file_identity,
        ),
        Ok(Some(true))
    ) {
        return false;
    }
    if matches!(
        workspace_recovery_file_matches(
            &prepared.temp,
            &prepared.next_digest,
            &prepared.next_file_identity,
        ),
        Ok(Some(true))
    ) {
        let _ = remove_workspace_transaction_file(&prepared.temp);
    }
    let _ = remove_workspace_transaction_file(&prepared.journal);
    true
}

#[cfg(windows)]
fn rename_open_workspace_file(file: &File, replacement: &Path) -> Result<(), WorkspaceError> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileRenameInfo {
        replace_if_exists: u32,
        root_directory: *mut std::ffi::c_void,
        file_name_length: u32,
        file_name: [u16; 32768],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(
            file: *mut std::ffi::c_void,
            file_information_class: i32,
            file_information: *const std::ffi::c_void,
            buffer_size: u32,
        ) -> i32;
    }
    const FILE_RENAME_INFO_CLASS: i32 = 3;
    let wide = replacement.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.is_empty() || wide.len() > 32768 {
        return Err(workspace_write_failed());
    }
    let mut information = Box::new(FileRenameInfo {
        replace_if_exists: 0,
        root_directory: std::ptr::null_mut(),
        file_name_length: (wide.len() * 2) as u32,
        file_name: [0; 32768],
    });
    information.file_name[..wide.len()].copy_from_slice(&wide);
    let size = std::mem::offset_of!(FileRenameInfo, file_name) + wide.len() * 2;
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FILE_RENAME_INFO_CLASS,
            (&*information as *const FileRenameInfo).cast(),
            size as u32,
        )
    } == 0
    {
        return Err(workspace_file_changed());
    }
    Ok(())
}

fn temporary_path(parent: &Path) -> PathBuf {
    parent.join(format!(
        ".lrw-{}-{}.tmp",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ))
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| workspace_write_failed())?;
    file.write_all(bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|_| workspace_write_failed())
}

#[cfg(windows)]
fn move_file_no_replace(temporary: &Path, target: &Path) -> Result<(), WorkspaceError> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let from = temporary
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let to = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) != 0 };
    if ok {
        return Ok(());
    }
    let code = std::io::Error::last_os_error();
    if code.raw_os_error() == Some(183) {
        // ERROR_ALREADY_EXISTS: atomic no-clobber move refused the target.
        return Err(workspace_file_exists());
    }
    Err(workspace_write_failed())
}

#[cfg(not(windows))]
fn move_file_no_replace(temporary: &Path, target: &Path) -> Result<(), WorkspaceError> {
    // hard_link is atomic and fails with AlreadyExists when the target exists.
    fs::hard_link(temporary, target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            workspace_file_exists()
        } else {
            workspace_write_failed()
        }
    })?;
    let _ = fs::remove_file(temporary);
    Ok(())
}

#[cfg(windows)]
fn remove_workspace_transaction_file(path: &Path) -> Result<(), WorkspaceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && !is_reparse_point(&metadata) =>
        {
            fs::remove_file(path).map_err(|_| workspace_write_failed())
        }
        Ok(_) => Err(WorkspaceError::new(
            "workspace-reparse-denied",
            "Workspace transaction path is unsafe",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(workspace_write_failed()),
    }
}

#[cfg(windows)]
fn read_workspace_recovery_file(path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(workspace_read_error()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(WorkspaceError::new(
            "workspace-reparse-denied",
            "Workspace recovery path is unsafe",
        ));
    }
    let mut file = open_workspace_file_no_follow(path, false)?;
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_WRITE_CONTENT_BYTES as u64) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| workspace_read_error())?;
    Ok(Some(bytes))
}

#[cfg(windows)]
fn workspace_recovery_file_matches(
    path: &Path,
    expected_digest: &str,
    expected_identity: &str,
) -> Result<Option<bool>, WorkspaceError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(workspace_read_error()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || is_reparse_point(&metadata)
        || metadata.len() > MAX_WRITE_CONTENT_BYTES as u64
    {
        return Err(WorkspaceError::new(
            "workspace-file-changed",
            "Workspace recovery identity changed",
        ));
    }
    let mut file = open_workspace_file_no_follow(path, true)?;
    let identity = workspace_file_identity(&file, path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| workspace_read_error())?;
    Ok(Some(
        identity == expected_identity && sha256_hex(&bytes) == expected_digest,
    ))
}

/// Open an exact recovery candidate exclusively and keep that handle alive so
/// the caller can perform the following no-replace rename without reopening a
/// validation-to-mutation window. `None` means absent or not the recorded
/// file; unsafe/locked paths remain typed errors and therefore uncertain.
#[cfg(windows)]
fn workspace_recovery_open_exact(
    path: &Path,
    expected_digest: &str,
    expected_identity: &str,
) -> Result<Option<File>, WorkspaceError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(workspace_read_error()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || is_reparse_point(&metadata)
        || metadata.len() > MAX_WRITE_CONTENT_BYTES as u64
    {
        return Err(WorkspaceError::new(
            "workspace-file-changed",
            "Workspace recovery identity changed",
        ));
    }
    let mut file = open_workspace_file_no_follow(path, true)?;
    let identity = workspace_file_identity(&file, path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| workspace_read_error())?;
    if identity != expected_identity || sha256_hex(&bytes) != expected_digest {
        return Ok(None);
    }
    Ok(Some(file))
}

#[cfg(windows)]
fn workspace_transaction_name(value: &str, suffix: &str) -> bool {
    value.starts_with(".lrw-")
        && value.ends_with(suffix)
        && value.len() <= 160
        && !value.contains(['/', '\\', ':'])
}

#[cfg(windows)]
fn recover_workspace_patch(target: &Path) -> Result<(), WorkspaceError> {
    let parent = target.parent().ok_or_else(workspace_path_invalid)?;
    let target_file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(workspace_path_invalid)?;
    let entries = fs::read_dir(parent).map_err(|_| workspace_read_error())?;
    for entry in entries {
        let entry = entry.map_err(|_| workspace_read_error())?;
        let journal_name = entry.file_name().to_string_lossy().to_string();
        if !workspace_transaction_name(&journal_name, ".journal") {
            continue;
        }
        let journal_path = entry.path();
        let Some(bytes) = read_workspace_recovery_file(&journal_path)? else {
            continue;
        };
        let record: WorkspaceWriteJournal =
            serde_json::from_slice(&bytes).map_err(|_| workspace_write_failed())?;
        if record.target_file_name != target_file_name {
            continue;
        }
        if record.version != WORKSPACE_WRITE_JOURNAL_VERSION {
            return Err(workspace_file_changed());
        }
        if !workspace_transaction_name(&record.temp_file_name, ".tmp")
            || !workspace_transaction_name(&record.backup_file_name, ".backup")
            || record.original_digest.len() != 64
            || record.next_digest.len() != 64
            || !workspace_file_identity_is_valid(&record.original_file_identity)
            || !workspace_file_identity_is_valid(&record.next_file_identity)
        {
            return Err(workspace_write_failed());
        }
        let backup = parent.join(&record.backup_file_name);
        let temp = parent.join(&record.temp_file_name);
        let backup_state = workspace_recovery_file_matches(
            &backup,
            &record.original_digest,
            &record.original_file_identity,
        )?;
        let temp_state = workspace_recovery_file_matches(
            &temp,
            &record.next_digest,
            &record.next_file_identity,
        )?;
        if matches!(backup_state, Some(false)) || matches!(temp_state, Some(false)) {
            return Err(workspace_file_changed());
        }
        let target_original = workspace_recovery_file_matches(
            target,
            &record.original_digest,
            &record.original_file_identity,
        )?;
        let target_next = workspace_recovery_file_matches(
            target,
            &record.next_digest,
            &record.next_file_identity,
        )?;
        if matches!(target_next, Some(true)) {
            if matches!(backup_state, Some(true)) {
                let _ = remove_workspace_transaction_file(&backup);
            }
            if matches!(temp_state, Some(true)) {
                let _ = remove_workspace_transaction_file(&temp);
            }
            let _ = remove_workspace_transaction_file(&journal_path);
            continue;
        }
        if matches!(target_original, Some(true)) && backup_state.is_none() {
            if matches!(temp_state, Some(true)) {
                let _ = remove_workspace_transaction_file(&temp);
            }
            let _ = remove_workspace_transaction_file(&journal_path);
            continue;
        }
        if target_original.is_none() && target_next.is_none() && matches!(backup_state, Some(true))
        {
            let backup_file = workspace_recovery_open_exact(
                &backup,
                &record.original_digest,
                &record.original_file_identity,
            )?
            .ok_or_else(workspace_file_changed)?;
            rename_open_workspace_file(&backup_file, target)?;
            drop(backup_file);
            if !matches!(
                workspace_recovery_file_matches(
                    target,
                    &record.original_digest,
                    &record.original_file_identity,
                ),
                Ok(Some(true))
            ) {
                return Err(workspace_file_changed());
            }
            if matches!(temp_state, Some(true)) {
                let _ = remove_workspace_transaction_file(&temp);
            }
            let _ = remove_workspace_transaction_file(&journal_path);
            continue;
        }
        return Err(workspace_file_changed());
    }
    Ok(())
}

#[cfg(windows)]
fn workspace_file_identity_is_valid(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("win-v1-") else {
        return false;
    };
    let Some((volume, index)) = rest.split_once('-') else {
        return false;
    };
    volume.len() == 8
        && index.len() == 16
        && volume.bytes().all(|byte| byte.is_ascii_hexdigit())
        && index.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(not(windows))]
fn recover_workspace_patch(_target: &Path) -> Result<(), WorkspaceError> {
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomic(temporary: &Path, target: &Path) -> Result<(), WorkspaceError> {
    // POSIX rename replaces the target path atomically and never follows it.
    fs::rename(temporary, target).map_err(|_| workspace_write_failed())
}

/// Per-target trusted lock shared across all grant operations in this
/// process. External processes are handled by the CAS digest re-check plus
/// the atomic replace, which yields exactly one winner.
fn workspace_mutation_lock(
    identity: &Path,
    target: &Path,
) -> Result<Arc<Mutex<()>>, WorkspaceError> {
    static WORKSPACE_MUTATION_LOCKS: OnceLock<Mutex<HashMap<(PathBuf, PathBuf), Weak<Mutex<()>>>>> =
        OnceLock::new();
    let mut map = WORKSPACE_MUTATION_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(lock) = map
        .get(&(identity.to_path_buf(), target.to_path_buf()))
        .and_then(Weak::upgrade)
    {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    map.insert(
        (identity.to_path_buf(), target.to_path_buf()),
        Arc::downgrade(&lock),
    );
    Ok(lock)
}

fn legacy_root_path_digest(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))
}

fn checked_workspace_root_identity(root: &Path, expected: &str) -> Result<String, WorkspaceError> {
    let actual = workspace_path_identity(root, true)?;
    if actual != expected {
        return Err(WorkspaceError::new(
            "workspace-grant-changed",
            "Workspace grant identity changed",
        ));
    }
    Ok(actual)
}

#[cfg(windows)]
fn open_workspace_file_no_follow(path: &Path, exclusive: bool) -> Result<File, WorkspaceError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_SHARE_DELETE: u32 = 0x4;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_WRITE_THROUGH: u32 = 0x8000_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let mut options = OpenOptions::new();
    options.read(true);
    if exclusive {
        options
            .write(true)
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE_ACCESS)
            .share_mode(0);
    } else {
        options
            .access_mode(GENERIC_READ)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    let file = options
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH)
        .open(path)
        .map_err(|_| {
            if exclusive {
                WorkspaceError::new(
                    "workspace-file-changed",
                    "Workspace file is being edited by another process",
                )
            } else {
                workspace_read_error()
            }
        })?;
    let metadata = file.metadata().map_err(|_| workspace_read_error())?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WorkspaceError::new(
            "workspace-reparse-denied",
            "Workspace file identity changed before it could be read",
        ));
    }
    Ok(file)
}

/// Test-only access to the same exclusive, no-follow Windows open used by the
/// production commit. It lets service-level fault injection hold the backup
/// at the real post-rename boundary instead of faking a helper outcome.
#[cfg(all(test, windows))]
pub(crate) fn open_workspace_file_exclusive_for_test(path: &Path) -> Result<File, WorkspaceError> {
    open_workspace_file_no_follow(path, true)
}

#[cfg(not(windows))]
fn open_workspace_file_no_follow(path: &Path, _exclusive: bool) -> Result<File, WorkspaceError> {
    File::open(path).map_err(|_| workspace_read_error())
}

#[cfg(windows)]
fn open_workspace_directory_guard(path: &Path) -> Result<File, WorkspaceError> {
    open_workspace_directory_fence(path, true)
}

#[cfg(windows)]
fn open_workspace_directory_fence(path: &Path, delete_access: bool) -> Result<File, WorkspaceError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const GENERIC_READ: u32 = 0x8000_0000;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_WRITE_THROUGH: u32 = 0x8000_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let file = OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ | if delete_access { DELETE_ACCESS } else { 0 })
        // Keep ordinary child I/O possible, but refuse DELETE sharing so a
        // late rename/delete/reparse of this path component cannot race the
        // final commit.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
        )
        .open(path)
        .map_err(|failure| {
            eprintln!("[filesystem-directory-fence] delete_access={delete_access} os_error={:?}", failure.raw_os_error());
            workspace_parent_missing()
        })?;
    let metadata = file.metadata().map_err(|_| workspace_read_error())?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WorkspaceError::new(
            "workspace-reparse-denied",
            "Workspace path crosses a reparse point",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_workspace_directory_identity_probe(path: &Path) -> Result<File, WorkspaceError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_SHARE_DELETE: u32 = 0x4;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let file = OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ)
        // The live guard requested DELETE access, so this read-only probe must
        // share DELETE even though the guard itself deliberately does not.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| workspace_parent_missing())?;
    let metadata = file.metadata().map_err(|_| workspace_read_error())?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WorkspaceError::new(
            "workspace-reparse-denied",
            "Workspace path crosses a reparse point",
        ));
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_workspace_directory_guard(_path: &Path) -> Result<File, WorkspaceError> {
    Err(WorkspaceError::new(
        "workspace-write-failed",
        "Workspace exclusive directory guards are unavailable on this platform",
    ))
}

#[cfg(windows)]
fn workspace_file_identity(file: &File, path: &Path) -> Result<String, WorkspaceError> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileTime {
        low_date_time: u32,
        high_date_time: u32,
    }
    #[repr(C)]
    struct ByHandleFileInformation {
        file_attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetVolumePathNameW(
            file_name: *const u16,
            volume_path_name: *mut u16,
            buffer_length: u32,
        ) -> i32;
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
        fn GetFileInformationByHandle(
            file: *mut std::ffi::c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }
    const DRIVE_FIXED: u32 = 3;
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut volume_path = vec![0u16; 32_768];
    if unsafe {
        GetVolumePathNameW(
            wide_path.as_ptr(),
            volume_path.as_mut_ptr(),
            volume_path.len() as u32,
        )
    } == 0
        || unsafe { GetDriveTypeW(volume_path.as_ptr()) } != DRIVE_FIXED
    {
        return Err(WorkspaceError::new(
            "workspace-grant-unavailable",
            "Workspace root requires a fixed local filesystem",
        ));
    }
    let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::zeroed();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 {
        return Err(workspace_read_error());
    }
    let information = unsafe { information.assume_init() };
    Ok(format!(
        "win-v1-{:08x}-{:08x}{:08x}",
        information.volume_serial_number, information.file_index_high, information.file_index_low
    ))
}

#[cfg(unix)]
fn workspace_file_identity(file: &File, _path: &Path) -> Result<String, WorkspaceError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|_| workspace_read_error())?;
    Ok(format!("unix-v1-{}-{}", metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
fn workspace_file_identity(_file: &File, _path: &Path) -> Result<String, WorkspaceError> {
    Err(WorkspaceError::new(
        "workspace-write-failed",
        "Workspace file identity is unavailable on this platform",
    ))
}

/// A no-follow directory handle plus its stable filesystem object identity.
///
/// On Windows the handle denies DELETE sharing, so the directory cannot be
/// removed, renamed, or replaced while a caller performs bounded I/O through
/// the guarded root. The raw volume/file identity never leaves Backend code.
pub(crate) struct FilesystemDirectoryIdentityGuard {
    _handle: File,
    identity: String,
}

impl FilesystemDirectoryIdentityGuard {
    pub(crate) fn identity(&self) -> &str {
        &self.identity
    }

    /// Confirms that the caller's current path still resolves to the exact
    /// directory object held by this guard. Windows can prove this while the
    /// no-delete-share handle is live. Other platforms keep the existing
    /// identity implementation for Workspace registration, but fail closed
    /// when a caller requires the stronger replacement fence.
    pub(crate) fn verify_current_path(&self, path: &Path) -> Result<(), WorkspaceError> {
        #[cfg(windows)]
        {
            let current = open_workspace_directory_identity_probe(path)?;
            if workspace_file_identity(&current, path)? != self.identity {
                return Err(WorkspaceError::new(
                    "workspace-grant-changed",
                    "Workspace grant identity changed",
                ));
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Err(WorkspaceError::new(
                "workspace-grant-unavailable",
                "Stable directory replacement guards are unavailable on this platform",
            ))
        }
    }
}

pub(crate) fn filesystem_directory_identity_guard(
    path: &Path,
) -> Result<FilesystemDirectoryIdentityGuard, WorkspaceError> {
    #[cfg(windows)]
    // Identity readers only need READ access. Denying DELETE sharing still
    // fences replacement, while independent identity readers can coexist.
    // The separate Workspace commit guard retains its existing DELETE access.
    let file = open_workspace_directory_fence(path, false)?;
    #[cfg(not(windows))]
    let file = {
        let metadata = fs::symlink_metadata(path).map_err(|_| workspace_read_error())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(WorkspaceError::new(
                "workspace-reparse-denied",
                "Workspace path crosses a reparse point",
            ));
        }
        File::open(path).map_err(|_| workspace_read_error())?
    };
    let identity = workspace_file_identity(&file, path)?;
    Ok(FilesystemDirectoryIdentityGuard {
        _handle: file,
        identity,
    })
}

fn workspace_path_identity(path: &Path, directory: bool) -> Result<String, WorkspaceError> {
    if directory {
        return filesystem_directory_identity_guard(path).map(|guard| guard.identity().to_owned());
    }
    let file = open_workspace_file_no_follow(path, false)?;
    workspace_file_identity(&file, path)
}

#[cfg(not(windows))]
fn read_file_bytes(path: &Path) -> Result<Vec<u8>, WorkspaceError> {
    let mut file = File::open(path).map_err(|_| workspace_read_error())?;
    let metadata = file.metadata().map_err(|_| workspace_read_error())?;
    if !metadata.is_file() {
        return Err(workspace_file_type_denied());
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(MAX_READ_BYTES)
            .min(MAX_READ_BYTES),
    );
    file.read_to_end(&mut bytes)
        .map_err(|_| workspace_read_error())?;
    if bytes.contains(&0) {
        return Err(workspace_file_type_denied());
    }
    Ok(bytes)
}

#[derive(Clone, Debug)]
pub(crate) struct QualifiedWorkspaceText {
    pub(crate) content: Vec<u8>,
    pub(crate) root_digest: String,
    pub(crate) file_identity: String,
}

/// Private binding for LuckyRay's one app-owned, read-only project manifest
/// check.  It intentionally carries filesystem identities and never derives
/// `Serialize`: the renderer and model only ever receive an opaque recipe ref.
#[derive(Clone, Debug)]
pub(crate) struct WorkspaceProjectManifestBinding {
    pub(crate) root: PathBuf,
    pub(crate) root_digest: String,
    pub(crate) manifest_name: String,
    pub(crate) manifest_digest: String,
    pub(crate) manifest_identity: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn workspace_path_invalid() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-path-invalid",
        "Workspace path must be relative to an authorized grant",
    )
}

fn workspace_write_denied() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-write-denied",
        "Workspace target is not allowed for Agent writes",
    )
}

fn workspace_file_exists() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-file-exists",
        "Workspace target already exists and will never be overwritten",
    )
}

fn workspace_file_changed() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-file-changed",
        "Workspace file changed since it was read; re-read it before writing",
    )
}

fn workspace_parent_missing() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-parent-missing",
        "Workspace parent folder does not exist",
    )
}

fn workspace_file_not_found() -> WorkspaceError {
    WorkspaceError::new("workspace-file-not-found", "Workspace file is unavailable")
}

fn workspace_containment_denied() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-containment-denied",
        "Workspace file is outside the authorized root",
    )
}

fn workspace_file_type_denied() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-file-type-denied",
        "Only bounded UTF-8 text files can be created or patched",
    )
}

fn workspace_edit_invalid() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-edit-invalid",
        "Workspace patch edits are invalid or out of range",
    )
}

fn workspace_preview_too_large() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-preview-too-large",
        "Workspace write preview exceeds the 24 KiB limit",
    )
}

fn workspace_diff_too_large() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-diff-too-large",
        "Workspace patch diff exceeds the changed-line limit",
    )
}

fn workspace_write_failed() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-write-failed",
        "Workspace file could not be written",
    )
}

/// A mutation crossed the target -> backup linearization boundary, but the
/// Backend could not prove either the planned replacement or a complete
/// rollback. It is deliberately outside the model-recoverable error set:
/// the durable journal and receipt must remain for startup reconciliation.
fn workspace_write_uncertain() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-write-uncertain",
        "Workspace write outcome is being reconciled",
    )
}

fn workspace_change_set_invalid() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-change-set-invalid",
        "Workspace change set is invalid",
    )
}

fn workspace_change_set_stopped() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-change-set-stopped",
        "Workspace change set stopped before the next file",
    )
}

fn change_set_item_outcome(
    item: &WorkspaceChangeSetItem,
    disposition: WorkspaceCommitDisposition,
) -> WorkspaceChangeSetItemOutcome {
    WorkspaceChangeSetItemOutcome {
        workspace_name: item.workspace_name().to_owned(),
        relative_path: item.relative_path().to_owned(),
        operation: item.operation(),
        open_token: item.open_token().to_owned(),
        disposition,
    }
}

fn workspace_file_ref_invalid() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-file-ref-invalid",
        "Workspace file reference is invalid or from another run",
    )
}

fn workspace_file_ref_expired() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-file-ref-expired",
        "Workspace file reference has expired",
    )
}

fn assert_no_reparse_components(root: &Path, candidate: &Path) -> Result<(), WorkspaceError> {
    let relative = candidate.strip_prefix(root).map_err(|_| {
        WorkspaceError::new(
            "workspace-containment-denied",
            "Workspace path is outside the authorized root",
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(WorkspaceError::new(
                "workspace-path-invalid",
                "Workspace path is invalid",
            ));
        };
        current.push(component);
        if !current.exists() {
            break;
        }
        let metadata = fs::symlink_metadata(&current).map_err(|_| workspace_read_error())?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(WorkspaceError::new(
                "workspace-reparse-denied",
                "Workspace path crosses a symlink or reparse point",
            ));
        }
    }
    Ok(())
}

fn safe_relative_string(root: &Path, path: &Path) -> Result<String, WorkspaceError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        WorkspaceError::new(
            "workspace-containment-denied",
            "Workspace path is outside the authorized root",
        )
    })?;
    let value = relative.to_string_lossy().replace('\\', "/");
    validate_relative_path(&value)?;
    Ok(value)
}

fn is_safe_text_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "md" | "markdown"
            | "txt"
            | "json"
            | "jsonl"
            | "csv"
            | "tsv"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "html"
            | "css"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "rs"
            | "py"
            | "java"
            | "kt"
            | "swift"
            | "go"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "sql"
            | "ini"
            | "conf"
            | "log"
    )
}

fn bounded_snippet(content: &str, byte_position: usize, needle_bytes: usize) -> String {
    let start = byte_position.saturating_sub(120);
    let end = (byte_position + needle_bytes + 240).min(content.len());
    let mut safe_start = start;
    while safe_start < content.len() && !content.is_char_boundary(safe_start) {
        safe_start += 1;
    }
    let mut safe_end = end;
    while safe_end > safe_start && !content.is_char_boundary(safe_end) {
        safe_end -= 1;
    }
    content[safe_start..safe_end]
        .replace(['\r', '\n'], " ")
        .chars()
        .take(360)
        .collect()
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn validate_public_id(value: &str) -> Result<(), WorkspaceError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(WorkspaceError::new(
            "workspace-grant-invalid",
            "Workspace grant identity is invalid",
        ));
    }
    Ok(())
}

fn open_connection(path: &Path, flags: OpenFlags) -> Result<Connection, WorkspaceError> {
    let connection =
        Connection::open_with_flags(path, flags).map_err(|_| workspace_database_error())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| workspace_database_error())?;
    Ok(connection)
}

fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn workspace_database_error() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-grant-store-unavailable",
        "Workspace grants are unavailable",
    )
}

fn workspace_selection_reference_invalid() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-selection-reference-invalid",
        "Folder selection reference is invalid or stale",
    )
}

fn workspace_selection_unavailable() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-selection-unavailable",
        "Selected folder is unavailable",
    )
}

fn workspace_selection_changed() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-selection-changed",
        "Selected folder changed before authorization",
    )
}

fn workspace_read_error() -> WorkspaceError {
    WorkspaceError::new(
        "workspace-read-failed",
        "Authorized workspace content could not be read",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded_service() -> (tempfile::TempDir, WorkspaceGrantService) {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("workspace.db");
        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE agent_workspace_grant (
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, canonical_root TEXT NOT NULL,
                    root_name TEXT NOT NULL, root_digest TEXT NOT NULL, enabled INTEGER NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE agent_project (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    primary_workspace_grant_id TEXT NOT NULL,
                    sort_order INTEGER NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        (temp, WorkspaceGrantService::new(db_path))
    }

    #[test]
    fn authorized_root_reads_but_adjacent_path_is_denied() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("note.md"), "LuckyRay workspace evidence").unwrap();
        fs::write(temp.path().join("outside.md"), "secret").unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let read = service.read(&grant.id, "note.md").unwrap();
        assert!(read.content.contains("workspace evidence"));
        assert_eq!(
            service.read(&grant.id, "../outside.md").unwrap_err().code,
            "workspace-path-invalid"
        );
    }

    #[test]
    fn search_never_returns_absolute_paths() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("note.md"), "needle").unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let results = service.search(&grant.id, "needle", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].relative_path, "note.md");
        assert!(!results[0]
            .relative_path
            .contains(temp.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn search_surfaces_binary_filename_matches_for_import_without_reading_them() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("target-photo.jpg"), [0xff, 0xd8, 0xff, 0xe0]).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();

        let results = service.search(&grant.id, "target-photo", 10).unwrap();
        assert_eq!(
            results.len(),
            1,
            "a JPG name must be discoverable for import"
        );
        assert_eq!(results[0].relative_path, "target-photo.jpg");
        assert_eq!(
            results[0].snippet, "",
            "binary files are never text-read by search"
        );
        assert!(!results[0].readable_text);
        assert!(results[0].importable_material);
    }

    #[test]
    fn aliases_disambiguate_duplicate_labels_without_leaking_grant_ids() {
        let (_temp, service) = seeded_service();
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        let first = service.add(first_root.path(), "Shared").unwrap();
        let second = service.add(second_root.path(), "Shared").unwrap();
        fs::create_dir(first_root.path().join("nested")).unwrap();
        let third = service
            .add(first_root.path().join("nested").as_path(), "Unique")
            .unwrap();

        let aliases = service.build_aliases().unwrap();
        assert_eq!(aliases.len(), 3);
        let names = aliases
            .iter()
            .map(|alias| alias.name.as_str())
            .collect::<Vec<_>>();
        assert!(
            names.contains(&"Shared") && names.contains(&"Shared (2)") && names.contains(&"Unique"),
            "duplicate labels get a stable deterministic suffix: {names:?}"
        );
        // The alias map retains the internal grant id only as non-serializable
        // Backend state for resolution.
        assert!(
            aliases.iter().any(|alias| alias.grant_id == first.id)
                && aliases.iter().any(|alias| alias.grant_id == second.id)
                && aliases.iter().any(|alias| alias.grant_id == third.id),
            "every grant keeps its internal id only for Backend resolution"
        );
        let shared_a = aliases.iter().find(|alias| alias.name == "Shared").unwrap();
        let shared_b = aliases
            .iter()
            .find(|alias| alias.name == "Shared (2)")
            .unwrap();
        assert_ne!(
            shared_a.grant_id, shared_b.grant_id,
            "the two duplicate aliases resolve to different grants"
        );
        assert!(
            shared_a.grant_id == first.id || shared_a.grant_id == second.id,
            "duplicate aliases only ever map to the real duplicate grants"
        );
        // The tool-facing output has a distinct DTO and never leaks ids.
        let safe = aliases
            .iter()
            .map(WorkspaceAliasView::observation)
            .collect::<Vec<_>>();
        let safe_text = serde_json::to_string(&safe).unwrap();
        assert!(
            !safe_text.contains("wsg-"),
            "grant ids must not leak: {safe_text}"
        );
        assert!(
            safe_text.contains("Shared (2)"),
            "disambiguated aliases stay visible in the safe output: {safe_text}"
        );
    }

    fn binding_for_read(
        service: &WorkspaceGrantService,
        grant_id: &str,
        relative: &str,
    ) -> WorkspaceFileBinding {
        let result = service.read(grant_id, relative).unwrap();
        service.file_binding(
            grant_id,
            "Allowed",
            relative,
            &result,
            [7u8; 32],
            "conversation-1",
        )
    }

    fn binding_for_create(
        service: &WorkspaceGrantService,
        grant: &WorkspaceGrantView,
        relative: &str,
        content: &str,
    ) -> WorkspaceCreateBinding {
        let preview = service
            .create_text_preview(&grant.id, relative, content)
            .unwrap();
        service.create_binding(
            &grant.id,
            "Allowed",
            relative,
            &preview,
            [7u8; 32],
            "conversation-1",
        )
    }

    fn locator_for(
        service: &WorkspaceGrantService,
        grant: &WorkspaceGrantView,
        relative: &str,
    ) -> WorkspaceWriteLocator {
        let resolved = service.resolve_grant(&grant.id).unwrap();
        WorkspaceWriteLocator {
            grant_id: grant.id.clone(),
            relative_path: relative.to_owned(),
            root_digest: resolved.root_digest,
        }
    }

    #[test]
    fn change_set_preflights_all_targets_then_commits_mixed_create_and_patch_exactly_once() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/notes.md"), "before\n").unwrap();
        let grant = service.add(&root, "Allowed").unwrap();

        let patch_binding = binding_for_read(&service, &grant.id, "docs/notes.md");
        let patch_edits = vec![PatchEdit {
            start_utf16: 0,
            end_utf16: 6,
            replacement: "after".to_owned(),
        }];
        let patch_preview = service
            .patch_text_preview(&patch_binding, &patch_edits)
            .unwrap();
        let create_content = "# New\nbody\n";
        let create_binding = binding_for_create(&service, &grant, "docs/new.md", create_content);
        let create_preview = service
            .create_text_preview(&grant.id, "docs/new.md", create_content)
            .unwrap();
        let set = WorkspaceChangeSetBinding::new(vec![
            WorkspaceChangeSetItem::Patch {
                binding: patch_binding,
                edits: patch_edits,
                planned_digest: patch_preview.planned_digest,
                open_token: "workspace-open-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            },
            WorkspaceChangeSetItem::Create {
                binding: create_binding,
                content: create_content.to_owned(),
                planned_digest: create_preview.planned_digest,
                open_token: "workspace-open-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
            },
        ])
        .unwrap();

        let outcome = service.commit_change_set(&set, &|| false).unwrap();
        assert!(outcome.fully_committed());
        assert_eq!(outcome.items.len(), 2);
        assert!(outcome
            .items
            .iter()
            .all(|item| item.disposition == WorkspaceCommitDisposition::Committed));
        assert_eq!(
            fs::read_to_string(root.join("docs/notes.md")).unwrap(),
            "after\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("docs/new.md")).unwrap(),
            create_content
        );
        assert_eq!(
            service
                .reconcile_change_set(&set.durable_locator())
                .unwrap(),
            WorkspaceChangeSetReconciliation::Committed,
            "reconciliation proves the exact ordered collection without replaying it"
        );
        assert!(
            outcome
                .items
                .iter()
                .all(|item| !item.workspace_name.contains("wsg-")
                    && !item
                        .relative_path
                        .contains(temp.path().to_string_lossy().as_ref())),
            "the post-commit item outcome remains product-safe"
        );
    }

    #[test]
    fn change_set_external_preflight_conflict_keeps_every_target_at_write_zero() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        let existing = root.join("docs/notes.md");
        fs::write(&existing, "before\n").unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let patch_binding = binding_for_read(&service, &grant.id, "docs/notes.md");
        let edits = vec![PatchEdit {
            start_utf16: 0,
            end_utf16: 6,
            replacement: "after".to_owned(),
        }];
        let patch_preview = service.patch_text_preview(&patch_binding, &edits).unwrap();
        let create_content = "new\n";
        let create_binding = binding_for_create(&service, &grant, "docs/new.md", create_content);
        let create_preview = service
            .create_text_preview(&grant.id, "docs/new.md", create_content)
            .unwrap();
        let set = WorkspaceChangeSetBinding::new(vec![
            WorkspaceChangeSetItem::Create {
                binding: create_binding,
                content: create_content.to_owned(),
                planned_digest: create_preview.planned_digest,
                open_token: "workspace-open-cccccccccccccccccccccccccccccccc".to_owned(),
            },
            WorkspaceChangeSetItem::Patch {
                binding: patch_binding,
                edits,
                planned_digest: patch_preview.planned_digest,
                open_token: "workspace-open-dddddddddddddddddddddddddddddddd".to_owned(),
            },
        ])
        .unwrap();

        // The other editor wins before the change-set commit starts. Every
        // target is preflighted before the first write, so even the valid
        // create must stay absent.
        fs::write(&existing, "external\n").unwrap();
        let error = service.commit_change_set(&set, &|| false).unwrap_err();
        assert_eq!(error.code, "workspace-file-changed");
        assert_eq!(
            error.disposition,
            WorkspaceCommitDisposition::KnownNotWritten
        );
        assert_eq!(fs::read_to_string(&existing).unwrap(), "external\n");
        assert!(
            !root.join("docs/new.md").exists(),
            "preflight conflict means all writes are zero"
        );
    }

    #[test]
    fn change_set_stop_after_first_commit_is_explicit_partial_and_never_starts_remaining_files() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let first = binding_for_create(&service, &grant, "docs/first.md", "one\n");
        let first_preview = service
            .create_text_preview(&grant.id, "docs/first.md", "one\n")
            .unwrap();
        let second = binding_for_create(&service, &grant, "docs/second.md", "two\n");
        let second_preview = service
            .create_text_preview(&grant.id, "docs/second.md", "two\n")
            .unwrap();
        let set = WorkspaceChangeSetBinding::new(vec![
            WorkspaceChangeSetItem::Create {
                binding: first,
                content: "one\n".to_owned(),
                planned_digest: first_preview.planned_digest,
                open_token: "workspace-open-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_owned(),
            },
            WorkspaceChangeSetItem::Create {
                binding: second,
                content: "two\n".to_owned(),
                planned_digest: second_preview.planned_digest,
                open_token: "workspace-open-ffffffffffffffffffffffffffffffff".to_owned(),
            },
        ])
        .unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_after_first_validation = stopped.clone();
        service.set_after_final_validation_hook(Arc::new(move || {
            stopped_after_first_validation.store(true, Ordering::Release);
        }));

        let outcome = service
            .commit_change_set(&set, &|| stopped.load(Ordering::Acquire))
            .unwrap();
        assert_eq!(outcome.items.len(), 2);
        assert_eq!(
            outcome.items[0].disposition,
            WorkspaceCommitDisposition::Committed
        );
        assert_eq!(
            outcome.items[1].disposition,
            WorkspaceCommitDisposition::KnownNotWritten
        );
        assert_eq!(
            fs::read_to_string(root.join("docs/first.md")).unwrap(),
            "one\n"
        );
        assert!(
            !root.join("docs/second.md").exists(),
            "Stop halts the sequential writer before the second target"
        );
        assert_eq!(
            service
                .reconcile_change_set(&set.durable_locator())
                .unwrap(),
            WorkspaceChangeSetReconciliation::Partial,
            "startup can honestly classify a stopped mid-commit set without replay"
        );
    }

    #[test]
    fn write_target_policy_rejects_unsafe_paths_and_non_text() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        for (path, code) in [
            ("C:\\Windows\\system32\\evil.md", "workspace-path-invalid"),
            ("../escape.md", "workspace-path-invalid"),
            ("sub\\..\\escape.md", "workspace-path-invalid"),
            ("\\\\server\\share\\x.md", "workspace-path-invalid"),
            ("note.bin", "workspace-file-type-denied"),
            ("archive.zip", "workspace-file-type-denied"),
            (".git/config", "workspace-write-denied"),
            ("node_modules/x.js", "workspace-write-denied"),
            ("__pycache__/x.py", "workspace-write-denied"),
            ("dist/bundle.js", "workspace-write-denied"),
            (".venv/lib.py", "workspace-write-denied"),
            (".env", "workspace-write-denied"),
            ("secret.pem", "workspace-write-denied"),
            ("cred.key", "workspace-write-denied"),
            ("backup.tmp", "workspace-write-denied"),
            (".notes.swp", "workspace-write-denied"),
            ("CON", "workspace-write-denied"),
            ("con.txt", "workspace-write-denied"),
            ("NUL.md", "workspace-write-denied"),
            ("lpt1.log", "workspace-write-denied"),
            ("trailing ", "workspace-write-denied"),
            ("trailing.", "workspace-write-denied"),
        ] {
            let error = service
                .create_text_preview(&grant.id, path, "content")
                .unwrap_err();
            assert_eq!(error.code, code, "path: {path}");
        }
        #[cfg(windows)]
        {
            assert_eq!(
                service
                    .create_text_preview(&grant.id, "ads:stream.md", "x")
                    .unwrap_err()
                    .code,
                "workspace-write-denied"
            );
        }
    }

    #[test]
    fn create_text_commit_exact_one_and_never_overwrites() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let preview = service
            .create_text_preview(&grant.id, "docs/note.md", "line one\nline two\n")
            .unwrap();
        assert_eq!(preview.size_bytes, 18);
        // Nothing exists before commit; approval is the only gate.
        let locator = locator_for(&service, &grant, "docs/note.md");
        assert!(service.reconcile_digest(&locator).unwrap().is_none());
        assert!(!root.join("docs/note.md").exists());
        let binding = binding_for_create(&service, &grant, "docs/note.md", "line one\nline two\n");
        let outcome = service
            .commit_create_text(&binding, "line one\nline two\n")
            .unwrap();
        assert_eq!(outcome.content_digest, preview.planned_digest);
        assert_eq!(
            fs::read_to_string(root.join("docs/note.md")).unwrap(),
            "line one\nline two\n"
        );
        // Existing target never overwrites.
        let stale_binding = binding.clone();
        assert_eq!(
            service
                .commit_create_text(&stale_binding, "line one\nline two\n")
                .unwrap_err()
                .code,
            "workspace-file-exists"
        );
        // No recursive parent creation.
        let missing_binding = binding_for_create(&service, &grant, "missing/deep.md", "x");
        assert_eq!(
            service
                .commit_create_text(&missing_binding, "x")
                .unwrap_err()
                .code,
            "workspace-parent-missing"
        );
        assert!(!root.join("missing").exists());
    }

    #[test]
    fn create_rejects_bom_crlf_nul_and_oversize() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        assert_eq!(
            service
                .create_text_preview(&grant.id, "a.md", "\u{feff}content")
                .unwrap_err()
                .code,
            "workspace-write-denied"
        );
        assert_eq!(
            service
                .create_text_preview(&grant.id, "a.md", "cr\r\nlf")
                .unwrap_err()
                .code,
            "workspace-write-denied"
        );
        assert_eq!(
            service
                .create_text_preview(&grant.id, "a.md", "nul\0inside")
                .unwrap_err()
                .code,
            "workspace-file-type-denied"
        );
        let big = "x".repeat(24 * 1024 + 1);
        assert_eq!(
            service
                .create_text_preview(&grant.id, "a.md", &big)
                .unwrap_err()
                .code,
            "workspace-preview-too-large"
        );
        assert_eq!(newline_style("a\rb"), None);
        assert_eq!(newline_style("a\r\nb"), Some(NewlineStyle::CrLf));
        assert_eq!(newline_style("a\nb"), Some(NewlineStyle::Lf));
    }

    #[test]
    fn patch_cas_flow_keeps_bom_and_newline_and_conflict_never_writes() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let original = "line one\r\nline two\r\nline three\r\n";
        fs::write(root.join("notes.txt"), original).unwrap();
        let binding = binding_for_read(&service, &grant.id, "notes.txt");
        assert!(!binding.has_bom);
        assert_eq!(binding.newline, NewlineStyle::CrLf);
        let edits = vec![PatchEdit {
            start_utf16: 0,
            end_utf16: 4,
            replacement: "LINE".to_owned(),
        }];
        let preview = service.patch_text_preview(&binding, &edits).unwrap();
        assert!(
            preview.diff.contains("- line one"),
            "diff: {}",
            preview.diff
        );
        assert!(
            preview.diff.contains("+ LINE one"),
            "diff: {}",
            preview.diff
        );
        // External edit after read -> typed conflict, zero writes.
        fs::write(root.join("notes.txt"), "external\r\n").unwrap();
        assert_eq!(
            service
                .patch_text_preview(&binding, &edits)
                .unwrap_err()
                .code,
            "workspace-file-changed"
        );
        assert_eq!(
            service
                .commit_patch_text(&binding, &edits)
                .unwrap_err()
                .code,
            "workspace-file-changed"
        );
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "external\r\n"
        );
        // Re-read, preview, and commit keeps CRLF and BOM format.
        let binding = binding_for_read(&service, &grant.id, "notes.txt");
        let edits = vec![PatchEdit {
            start_utf16: 0,
            end_utf16: 8,
            replacement: "NEW".to_owned(),
        }];
        let preview = service.patch_text_preview(&binding, &edits).unwrap();
        let outcome = service.commit_patch_text(&binding, &edits).unwrap();
        assert_eq!(outcome.content_digest, preview.planned_digest);
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "NEW\r\n"
        );
        // A BOM file keeps its BOM across a patch.
        let with_bom = "\u{feff}hello\n";
        fs::write(root.join("bom.txt"), with_bom).unwrap();
        let binding = binding_for_read(&service, &grant.id, "bom.txt");
        assert!(binding.has_bom);
        let edits = vec![PatchEdit {
            start_utf16: 1,
            end_utf16: 6,
            replacement: "world".to_owned(),
        }];
        service.commit_patch_text(&binding, &edits).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("bom.txt")).unwrap(),
            "\u{feff}world\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn patch_final_validation_guard_blocks_late_external_edit_and_parent_rename() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let target = root.join("notes.txt");
        fs::write(&target, "before\n").unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let binding = binding_for_read(&service, &grant.id, "notes.txt");
        let write_blocked = Arc::new(AtomicBool::new(false));
        let rename_blocked = Arc::new(AtomicBool::new(false));
        let target_for_hook = target.clone();
        let root_for_hook = root.clone();
        let displaced = temp.path().join("displaced-root");
        let write_probe = write_blocked.clone();
        let rename_probe = rename_blocked.clone();
        service.set_after_final_validation_hook(Arc::new(move || {
            // This hook is intentionally after the final digest/identity
            // validation and immediately before the production commit. A
            // normal external process must not be able to win this window.
            write_probe.store(
                fs::write(&target_for_hook, "external edit\n").is_err(),
                Ordering::Release,
            );
            rename_probe.store(
                fs::rename(&root_for_hook, &displaced).is_err(),
                Ordering::Release,
            );
        }));

        let outcome = service.commit_patch_text(
            &binding,
            &[PatchEdit {
                start_utf16: 0,
                end_utf16: 6,
                replacement: "after".to_owned(),
            }],
        );
        assert!(outcome.is_ok(), "guarded commit: {outcome:?}");
        assert!(
            write_blocked.load(Ordering::Acquire),
            "an external edit reached the post-validation commit window"
        );
        assert!(
            rename_blocked.load(Ordering::Acquire),
            "an external parent rename/reparse replacement reached the commit window"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "after\n");
    }

    #[cfg(windows)]
    #[test]
    fn patch_post_rename_install_and_rollback_failure_stays_durable_unknown_until_recovery() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let target = root.join("notes.txt");
        fs::write(&target, "before\n").unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let binding = binding_for_read(&service, &grant.id, "notes.txt");
        let backup_guard = Arc::new(Mutex::new(None::<File>));
        let backup_guard_for_hook = backup_guard.clone();
        let journal_path = Arc::new(Mutex::new(None::<PathBuf>));
        let journal_path_for_hook = journal_path.clone();

        service.set_after_target_renamed_hook(Arc::new(move |_target, temporary, backup| {
            // This is the production seam immediately after target -> backup.
            // Remove the prepared temp so installation fails, then keep a real
            // exclusive backup handle open so automatic rollback also fails.
            fs::remove_file(temporary).unwrap();
            *journal_path_for_hook
                .lock()
                .unwrap_or_else(|value| value.into_inner()) =
                Some(backup.with_extension("journal"));
            *backup_guard_for_hook
                .lock()
                .unwrap_or_else(|value| value.into_inner()) =
                Some(open_workspace_file_no_follow(backup, true).unwrap());
        }));

        let error = service
            .commit_patch_text(
                &binding,
                &[PatchEdit {
                    start_utf16: 0,
                    end_utf16: 6,
                    replacement: "after".to_owned(),
                }],
            )
            .unwrap_err();
        // RED before P1-E: this was workspace-file-changed, so the service
        // falsely classified the post-rename state as a retryable write0.
        assert_eq!(error.code, "workspace-write-uncertain");
        assert!(
            !target.exists(),
            "the target is absent while the original only exists as backup"
        );
        let journal = journal_path
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
            .expect("post-rename journal path");
        assert!(journal.exists(), "unknown mutation must retain its journal");

        // Simulate restart after the temporary external lock disappears. The
        // journal may restore only the exact original and then clean itself.
        drop(
            backup_guard
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .take(),
        );
        let locator = locator_for(&service, &grant, "notes.txt");
        assert_eq!(
            service.reconcile_digest(&locator).unwrap().as_deref(),
            Some(binding.file_digest.as_str())
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "before\n");
        assert!(!journal.exists(), "proven rollback cleans the journal");
        assert_eq!(
            service.reconcile_digest(&locator).unwrap().as_deref(),
            Some(binding.file_digest.as_str()),
            "recovery is idempotent"
        );
    }

    #[cfg(windows)]
    #[test]
    fn patch_recovery_keeps_identity_mismatched_backup_uncertain_without_touching_files() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let target = root.join("notes.txt");
        fs::write(&target, "before\n").unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let binding = binding_for_read(&service, &grant.id, "notes.txt");
        let backup_guard = Arc::new(Mutex::new(None::<File>));
        let backup_guard_for_hook = backup_guard.clone();
        let backup_path = Arc::new(Mutex::new(None::<PathBuf>));
        let backup_path_for_hook = backup_path.clone();
        let journal_path = Arc::new(Mutex::new(None::<PathBuf>));
        let journal_path_for_hook = journal_path.clone();

        service.set_after_target_renamed_hook(Arc::new(move |_target, temporary, backup| {
            fs::remove_file(temporary).unwrap();
            *backup_path_for_hook
                .lock()
                .unwrap_or_else(|value| value.into_inner()) = Some(backup.to_path_buf());
            *journal_path_for_hook
                .lock()
                .unwrap_or_else(|value| value.into_inner()) =
                Some(backup.with_extension("journal"));
            *backup_guard_for_hook
                .lock()
                .unwrap_or_else(|value| value.into_inner()) =
                Some(open_workspace_file_no_follow(backup, true).unwrap());
        }));

        let error = service
            .commit_patch_text(
                &binding,
                &[PatchEdit {
                    start_utf16: 0,
                    end_utf16: 6,
                    replacement: "after".to_owned(),
                }],
            )
            .unwrap_err();
        assert_eq!(
            error.disposition,
            WorkspaceCommitDisposition::UnknownAfterMutation
        );
        drop(
            backup_guard
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .take(),
        );
        let backup = backup_path
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
            .expect("backup path");
        let journal = journal_path
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
            .expect("journal path");
        fs::write(&backup, "tampered external content\n").unwrap();
        let before_backup = fs::read(&backup).unwrap();
        let locator = locator_for(&service, &grant, "notes.txt");

        for _ in 0..2 {
            let error = service.reconcile_digest(&locator).unwrap_err();
            assert_eq!(error.code, "workspace-file-changed");
            assert!(!target.exists(), "recovery must not invent a target");
            assert_eq!(fs::read(&backup).unwrap(), before_backup);
            assert!(journal.exists(), "uncertain journal remains durable");
        }
    }

    #[cfg(windows)]
    #[test]
    fn create_final_validation_guard_never_clobbers_late_external_target_or_parent() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let target = root.join("new.md");
        let grant = service.add(&root, "Allowed").unwrap();
        let binding = binding_for_create(&service, &grant, "new.md", "agent content\n");
        let target_for_hook = target.clone();
        let root_for_hook = root.clone();
        let displaced = temp.path().join("displaced-create-root");
        let renamed = Arc::new(AtomicBool::new(false));
        let rename_probe = renamed.clone();
        service.set_after_final_validation_hook(Arc::new(move || {
            // This seam is after the root/parent identity and target absence
            // checks. A late parent replacement must be denied; an external
            // creator that wins the no-clobber race must keep its content.
            rename_probe.store(
                fs::rename(&root_for_hook, &displaced).is_err(),
                Ordering::Release,
            );
            fs::write(&target_for_hook, "external creator content\n").unwrap();
        }));
        let error = service
            .commit_create_text(&binding, "agent content\n")
            .unwrap_err();
        assert!(
            matches!(
                error.code,
                "workspace-file-exists" | "workspace-write-failed"
            ),
            "late no-clobber race must have a safe typed failure: {error:?}"
        );
        assert!(
            renamed.load(Ordering::Acquire),
            "a late external parent rename/reparse replacement reached create commit"
        );
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "external creator content\n",
            "the agent create must never overwrite a late external target"
        );
    }

    #[cfg(windows)]
    #[test]
    fn patch_rejects_replaced_grant_root_without_touching_new_content() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("notes.txt"), "before\n").unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let binding = binding_for_read(&service, &grant.id, "notes.txt");
        let prior_root = temp.path().join("prior-root");
        fs::rename(&root, &prior_root).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("notes.txt"), "external replacement\n").unwrap();

        let error = service
            .commit_patch_text(
                &binding,
                &[PatchEdit {
                    start_utf16: 0,
                    end_utf16: 6,
                    replacement: "after".to_owned(),
                }],
            )
            .unwrap_err();
        assert_eq!(error.code, "workspace-grant-changed");
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "external replacement\n"
        );
    }

    #[test]
    fn patch_utf16_offsets_validate_boundaries_and_overlap() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let original = "你好 world\n";
        fs::write(root.join("u.txt"), original).unwrap();
        let binding = binding_for_read(&service, &grant.id, "u.txt");
        let ok = vec![PatchEdit {
            start_utf16: 0,
            end_utf16: 2,
            replacement: "再见".to_owned(),
        }];
        let preview = service.patch_text_preview(&binding, &ok).unwrap();
        assert!(
            preview.diff.contains("+ 再见 world"),
            "diff: {}",
            preview.diff
        );
        let overlap = vec![
            PatchEdit {
                start_utf16: 0,
                end_utf16: 2,
                replacement: "a".to_owned(),
            },
            PatchEdit {
                start_utf16: 1,
                end_utf16: 3,
                replacement: "b".to_owned(),
            },
        ];
        assert_eq!(
            service
                .patch_text_preview(&binding, &overlap)
                .unwrap_err()
                .code,
            "workspace-edit-invalid"
        );
        let reversed = vec![PatchEdit {
            start_utf16: 3,
            end_utf16: 1,
            replacement: "x".to_owned(),
        }];
        assert_eq!(
            service
                .patch_text_preview(&binding, &reversed)
                .unwrap_err()
                .code,
            "workspace-edit-invalid"
        );
        let out_of_range = vec![PatchEdit {
            start_utf16: 0,
            end_utf16: 999,
            replacement: "x".to_owned(),
        }];
        assert_eq!(
            service
                .patch_text_preview(&binding, &out_of_range)
                .unwrap_err()
                .code,
            "workspace-edit-invalid"
        );
        // A mid-character offset (inside an emoji surrogate pair) is rejected.
        let emoji = "a😀b\n";
        fs::write(root.join("e.txt"), emoji).unwrap();
        let binding = binding_for_read(&service, &grant.id, "e.txt");
        let mid_surrogate = vec![PatchEdit {
            start_utf16: 1,
            end_utf16: 2,
            replacement: "x".to_owned(),
        }];
        assert_eq!(
            service
                .patch_text_preview(&binding, &mid_surrogate)
                .unwrap_err()
                .code,
            "workspace-edit-invalid"
        );
        let whole_emoji = vec![PatchEdit {
            start_utf16: 1,
            end_utf16: 3,
            replacement: "X".to_owned(),
        }];
        let preview = service.patch_text_preview(&binding, &whole_emoji).unwrap();
        assert!(preview.diff.contains("+ aXb"), "diff: {}", preview.diff);
    }

    #[test]
    fn file_bindings_reject_forged_cross_run_stale_and_expired() {
        let bindings = WorkspaceFileBindings::default();
        let binding = WorkspaceFileBinding {
            grant_id: "wsg-1".to_owned(),
            workspace_name: "Allowed".to_owned(),
            relative_path: "a.md".to_owned(),
            root_digest: "r".to_owned(),
            file_identity: "f".to_owned(),
            file_digest: "d".to_owned(),
            size_bytes: 1,
            has_bom: false,
            newline: NewlineStyle::Lf,
            principal: [1u8; 32],
            conversation_id: "c1".to_owned(),
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        let reference = bindings.bind(binding.clone());
        assert_eq!(
            bindings.resolve("file-ref-forged").unwrap_err().code,
            "workspace-file-ref-invalid"
        );
        let fresh = WorkspaceFileBindings::default();
        assert_eq!(
            fresh.resolve(&reference).unwrap_err().code,
            "workspace-file-ref-invalid",
            "cross-run references never resolve"
        );
        assert!(bindings.resolve(&reference).is_ok());
        assert!(bindings.consume(&reference).is_ok());
        assert_eq!(
            bindings.consume(&reference).unwrap_err().code,
            "workspace-file-ref-invalid",
            "a consumed reference is stale"
        );
        let expired_store = WorkspaceFileBindings::default();
        let expired = WorkspaceFileBinding {
            expires_at: Instant::now() - Duration::from_secs(1),
            ..binding.clone()
        };
        let expired_reference = expired_store.bind(expired);
        assert_eq!(
            expired_store.resolve(&expired_reference).unwrap_err().code,
            "workspace-file-ref-expired"
        );
    }

    #[test]
    fn management_ref_hides_grant_ids_and_old_forged_refs_fail_closed() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let views = service.management_snapshot(&service.list().unwrap());
        assert_eq!(views.len(), 1);
        let serialized = serde_json::to_string(&views).unwrap();
        assert!(!serialized.contains(&grant.id), "{serialized}");
        assert!(views[0].management_ref.starts_with("wsg-ui-ref-"));
        let consumed = service
            .consume_management_ref(&views[0].management_ref)
            .unwrap();
        assert_eq!(consumed, grant.id);
        assert_eq!(
            service
                .consume_management_ref(&views[0].management_ref)
                .unwrap_err()
                .code,
            "workspace-management-reference-invalid"
        );
        assert_eq!(
            service
                .consume_management_ref("wsg-ui-ref-forged")
                .unwrap_err()
                .code,
            "workspace-management-reference-invalid"
        );
        // A second snapshot invalidates every previous reference.
        let refreshed = service.management_snapshot(&service.list().unwrap());
        assert_eq!(
            service
                .consume_management_ref(&refreshed[0].management_ref)
                .unwrap(),
            grant.id
        );
        // The management ref drives enable/remove without the grant id.
        let views = service.management_snapshot(&service.list().unwrap());
        let service_clone = service.clone();
        let new_service = WorkspaceGrantService::new_with_management(
            temp.path().join("workspace.db"),
            service.management_bindings.clone(),
        );
        let _ = service_clone;
        new_service
            .set_enabled(
                &new_service
                    .consume_management_ref(&views[0].management_ref)
                    .unwrap(),
                false,
            )
            .unwrap();
        assert!(!new_service.list().unwrap()[0].enabled);
        let views = new_service.management_snapshot(&new_service.list().unwrap());
        new_service
            .remove(
                &new_service
                    .consume_management_ref(&views[0].management_ref)
                    .unwrap(),
            )
            .unwrap();
        assert!(new_service.list().unwrap().is_empty());
    }

    #[test]
    fn folder_selection_is_one_shot_caller_and_action_bound_without_path_projection() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("selected");
        fs::create_dir(&root).unwrap();

        let selection = service.issue_add_folder_selection(&root, "main").unwrap();
        let serialized = serde_json::to_string(&selection).unwrap();
        assert!(selection.management_ref.starts_with("wsg-selection-ref-"));
        assert_eq!(selection.label, "selected");
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));
        assert_eq!(
            service
                .add_from_folder_selection(&selection.management_ref, "other-window")
                .unwrap_err()
                .code,
            "workspace-selection-reference-invalid"
        );
        assert!(service.list().unwrap().is_empty());

        let selection = service.issue_add_folder_selection(&root, "main").unwrap();
        assert_eq!(
            service
                .folder_selections
                .consume(
                    &selection.management_ref,
                    "main",
                    WorkspaceFolderSelectionAction::ProjectFolder,
                )
                .unwrap_err()
                .code,
            "workspace-selection-reference-invalid"
        );

        let selection = service.issue_add_folder_selection(&root, "main").unwrap();
        let grant = service
            .add_from_folder_selection(&selection.management_ref, "main")
            .unwrap();
        assert_eq!(grant.label, "selected");
        assert_eq!(service.list().unwrap().len(), 1);
        assert_eq!(
            service
                .add_from_folder_selection(&selection.management_ref, "main")
                .unwrap_err()
                .code,
            "workspace-selection-reference-invalid",
            "a selection reference is consumed exactly once"
        );

        let expired = WorkspaceFolderSelections::new(Duration::ZERO);
        let selection = expired
            .issue(&root, "main", WorkspaceFolderSelectionAction::AddGrant)
            .unwrap();
        assert_eq!(
            expired
                .consume(
                    &selection.management_ref,
                    "main",
                    WorkspaceFolderSelectionAction::AddGrant,
                )
                .unwrap_err()
                .code,
            "workspace-selection-reference-expired"
        );
    }

    #[cfg(windows)]
    #[test]
    fn folder_selection_rejects_same_path_replacement_before_grant_insert() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("selected");
        fs::create_dir(&root).unwrap();
        let selection = service.issue_add_folder_selection(&root, "main").unwrap();

        fs::remove_dir(&root).unwrap();
        fs::create_dir(&root).unwrap();
        assert_eq!(
            service
                .add_from_folder_selection(&selection.management_ref, "main")
                .unwrap_err()
                .code,
            "workspace-selection-changed"
        );
        assert!(service.list().unwrap().is_empty());

        let fresh = service.issue_add_folder_selection(&root, "main").unwrap();
        service
            .add_from_folder_selection(&fresh.management_ref, "main")
            .unwrap();
        assert_eq!(service.list().unwrap().len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn create_target_symlink_is_never_followed_or_replaced() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("real.txt"), "real").unwrap();
        let link = root.join("link.txt");
        if std::os::windows::fs::symlink_file(&root.join("real.txt"), &link).is_err() {
            return;
        }
        let grant = service.add(&root, "Allowed").unwrap();
        let binding = service
            .create_text_preview(&grant.id, "link.txt", "payload")
            .map(|preview| {
                service.create_binding(
                    &grant.id,
                    "Allowed",
                    "link.txt",
                    &preview,
                    [7; 32],
                    "conversation-1",
                )
            });
        let error = binding.unwrap_err();
        assert_eq!(error.code, "workspace-reparse-denied");
        assert_eq!(fs::read_to_string(root.join("real.txt")).unwrap(), "real");
    }

    #[test]
    fn diff_is_full_and_deterministic() {
        let before = "a\nb\nc\nd\n";
        let after = "a\nB\nc\nd\n";
        let diff = build_text_diff(before, after);
        assert_eq!(diff, "- b\n+ B\n");
    }

    #[test]
    fn diff_line_limit_and_oversize_rejected() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        let content = (0..450)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("big.txt"), &content).unwrap();
        let binding = binding_for_read(&service, &grant.id, "big.txt");
        let total_units = content.encode_utf16().count();
        // A single bounded edit replacing the whole file touches 450+ lines.
        let edits = vec![PatchEdit {
            start_utf16: 0,
            end_utf16: total_units,
            replacement: "collapsed".to_owned(),
        }];
        assert_eq!(
            service
                .patch_text_preview(&binding, &edits)
                .unwrap_err()
                .code,
            "workspace-diff-too-large"
        );
    }

    #[test]
    fn reconcile_digest_returns_none_for_absent_or_unsafe() {
        let (temp, service) = seeded_service();
        let root = temp.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let grant = service.add(&root, "Allowed").unwrap();
        assert_eq!(
            service
                .reconcile_digest(&locator_for(&service, &grant, "missing.md"))
                .unwrap(),
            None
        );
        fs::write(root.join("x.bin"), [0xff, 0xfe]).unwrap();
        assert_eq!(
            service
                .reconcile_digest(&locator_for(&service, &grant, "x.bin"))
                .unwrap(),
            None
        );
        fs::write(root.join("ok.md"), "hello").unwrap();
        let digest = service
            .reconcile_digest(&locator_for(&service, &grant, "ok.md"))
            .unwrap()
            .unwrap();
        assert_eq!(
            digest,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
