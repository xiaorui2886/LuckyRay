use crate::agent_workspace::{
    filesystem_directory_identity_guard, FilesystemDirectoryIdentityGuard, WorkspaceError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

mod index;
mod saved_scopes;
pub(crate) use saved_scopes::SavedKnowledgeScope;
#[cfg(test)]
mod native_read_concurrency_tests;
pub(crate) use index::resolve_wiki_target;
mod live_sync;
mod companion_folders;
mod companion_import;
pub(crate) use companion_import::companion_import_path_key;
pub(crate) use live_sync::{KnowledgeEditingStatus, KnowledgeEditingLease, KnowledgeCommittedChange, KnowledgeCommittedCheckpoint};
mod attachment_inventory_cache;
mod markdown_links;
pub(crate) use markdown_links::{attachment_links as companion_attachment_links, LinkSyntax as CompanionLinkSyntax};

pub(crate) fn companion_note_name(title: &str) -> Result<String, KnowledgeError> { safe_markdown_name(title) }
pub(crate) fn companion_replaced_content(before: &str, content: &str) -> Result<String, KnowledgeError> {
    replace_text(&decode_document(before.as_bytes())?, content)
}
mod attachments;
mod workspace_attachment_reads;
mod workspace_action_paths;
mod workspace_note_actions;
mod workspace_graph_assets;
mod external_attachments;
pub(crate) use external_attachments::attachment_target_rewrites;
mod attachment_portability;
pub(crate) use attachment_portability::{AttachmentAudit, AttachmentExportResult};
#[cfg(test)]
mod attachment_portability_tests;
#[cfg(test)]
mod attachment_external_tests;
#[cfg(test)]
mod attachment_catalog_tests;
#[cfg(test)]
mod attachment_projection_tests;
mod attachment_operations;
mod attachment_receipts;
mod attachment_policy;
mod attachment_observations;
pub(crate) use attachment_observations::ExternalAttachmentUpdate;
pub(crate) use attachment_operations::{AttachmentOperationPlan, AttachmentOperationResult, AttachmentOperationIssue};
#[cfg(test)]
mod attachment_tests;
#[cfg(test)]
mod extension_template_native_tests;
#[cfg(test)]
mod attachment_inventory_cache_tests;
#[cfg(test)]
mod attachment_browser_test;
pub(crate) use attachments::{AttachmentPublication, AttachmentResolution};

pub(crate) use index::normalize_embed_target;
pub(crate) use index::{
    KnowledgeBacklink, KnowledgeDocumentRelations, KnowledgeIndexDocument, KnowledgeIndexSnapshot, KnowledgeTagSummary,
};

const VAULT_SCHEMA_VERSION: u32 = 1;
const WRITE_JOURNAL_VERSION: u32 = 1;

static KNOWLEDGE_MUTATION_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    OnceLock::new();

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeWriteJournal {
    version: u32,
    nonce: String,
    target_file_name: String,
    backup_file_name: String,
    temp_file_name: String,
    original_revision: String,
    next_revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentRef {
    pub vault_id: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeVaultRegistration {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub mode: String,
    pub created_at: String,
    pub last_opened_at: String,
    pub schema_version: u32,
    #[serde(default)]
    pub link_update_policy: LinkUpdatePolicy,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LinkUpdatePolicy {
    #[default]
    Ask,
    Always,
}

impl<'de> Deserialize<'de> for LinkUpdatePolicy {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(if value.as_str() == Some("always") { Self::Always } else { Self::Ask })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentSummary {
    pub document_ref: KnowledgeDocumentRef,
    pub title: String,
    pub relative_path: String,
    pub modified_at: Option<String>,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentSnapshot {
    #[serde(flatten)]
    pub summary: KnowledgeDocumentSummary,
    pub content: String,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCreateInput {
    pub title: String,
    #[serde(default)]
    pub parent_relative_path: Option<String>,
    #[serde(default)]
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeWriteInput {
    pub document_ref: KnowledgeDocumentRef,
    pub content: String,
    #[serde(default)]
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeMoveInput {
    pub document_ref: KnowledgeDocumentRef,
    pub title: String,
    pub expected_revision: String,
    #[serde(default)]
    pub parent_relative_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDeleteInput {
    pub document_ref: KnowledgeDocumentRef,
    pub expected_revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeSetTagsInput {
    pub document_ref: KnowledgeDocumentRef,
    pub expected_revision: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeInsertInput {
    pub document_ref: KnowledgeDocumentRef,
    pub offset: usize,
    pub text: String,
    #[serde(default)]
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeMutationResult {
    pub document: KnowledgeDocumentSnapshot,
    pub position: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_warning: Option<KnowledgeMutationWarning>,
    #[serde(default)]
    pub index_stale: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeMutationWarning {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCurrentContextInput {
    pub source_epoch: u64,
    pub session_id: String,
    pub session_epoch: u64,
    pub generation: u64,
    pub document_ref: KnowledgeDocumentRef,
    #[serde(default)]
    pub cursor_offset: Option<usize>,
    #[serde(default)]
    pub selection: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCurrentContextClearInput {
    pub source_epoch: u64,
    pub session_id: String,
    pub session_epoch: u64,
    pub generation: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeContextSession {
    pub session_id: String,
    pub session_epoch: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeUiSourceActivation {
    pub vault_id: String,
    pub source_epoch: u64,
}

/// Backend-only identity for a project Knowledge authorization target.
///
/// The target id and digest never enter renderer DTOs. The digest binds the
/// stable Vault registration to its canonical root and creation identity so a
/// removed/recreated registration cannot inherit a project's old grant.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct KnowledgeTargetIdentity {
    pub(crate) target_id: String,
    pub(crate) identity_digest: String,
    pub(crate) label: String,
}

/// Native-only recovery record; never supplied by a renderer or exposed in DTOs.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceScopeRecord {
    registration:KnowledgeVaultRegistration,target_id:String,identity_digest:String,label:String,
}

impl WorkspaceScopeRecord {
    /// Read-only captured root for native retirement checks. Keep the complete
    /// registration and its authority fields private to Knowledge.
    pub(crate) fn root_path(&self) -> &Path {
        Path::new(&self.registration.root_path)
    }
}

/// Immutable Backend-only Knowledge authority frozen at Agent run admission.
/// A run can target at most the one real Vault that was current at admission;
/// later project grants or Vault switches never expand it.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct KnowledgeRunScope {
    target: Option<KnowledgeTargetIdentity>,
    digest: String,
}

impl std::fmt::Debug for KnowledgeRunScope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KnowledgeRunScope")
            .field("target", &self.target.as_ref().map(|_| "[bound]"))
            .field("digest", &"[sha256]")
            .finish()
    }
}

impl KnowledgeRunScope {
    pub(crate) fn empty() -> Self {
        Self::from_target(None)
    }

    pub(crate) fn for_target(target: KnowledgeTargetIdentity) -> Self {
        Self::from_target(Some(target))
    }

    fn from_target(target: Option<KnowledgeTargetIdentity>) -> Self {
        let digest = format!(
            "{:x}",
            Sha256::digest(
                [
                    b"luckyray-agent-knowledge-scope-v1\0".as_slice(),
                    target
                        .as_ref()
                        .map(|value| value.identity_digest.as_bytes())
                        .unwrap_or_default(),
                ]
                .concat(),
            )
        );
        Self { target, digest }
    }

    pub(crate) fn allows(&self, target: &KnowledgeTargetIdentity) -> bool {
        self.target.as_ref().is_some_and(|allowed| {
            allowed.target_id == target.target_id
                && allowed.identity_digest == target.identity_digest
        })
    }

    pub(crate) fn allows_target_id(&self, target_id: &str) -> bool {
        self.target
            .as_ref()
            .is_some_and(|allowed| allowed.target_id == target_id)
    }

    pub(crate) fn target(&self) -> Option<&KnowledgeTargetIdentity> {
        self.target.as_ref()
    }

    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }
}

impl std::fmt::Debug for KnowledgeTargetIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KnowledgeTargetIdentity")
            .field("target_id", &"[redacted]")
            .field("identity_digest", &"[sha256]")
            .field("label", &self.label)
            .finish()
    }
}

pub(crate) struct KnowledgeUiSourceGuard<'a> {
    _state: std::sync::MutexGuard<'a, KnowledgeUiSourceState>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCurrentContext {
    pub document_ref: KnowledgeDocumentRef,
    pub cursor_offset: Option<usize>,
    pub selection: Option<String>,
    pub expected_revision: String,
    pub updated_at: String,
}

#[derive(Default)]
struct KnowledgeCurrentContextState {
    next_session_epoch: u64,
    active_session_id: Option<String>,
    active_session_epoch: u64,
    active_owner: KnowledgeCurrentContextOwner,
    // Once the desktop Notes editor has claimed ownership, legacy iframe updates stay
    // retired for this service lifetime. Source activation clears content, not priority.
    desktop_claimed: bool,
    generation: u64,
    context: Option<KnowledgeCurrentContext>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum KnowledgeCurrentContextOwner {
    #[default]
    None,
    Desktop,
    LegacyIframe,
}

#[derive(Default)]
struct KnowledgeUiSourceState {
    epoch: u64,
    active_vault_id: Option<String>,
    dirty_paths: std::collections::HashSet<String>,
    dirty_generation: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCurrentInsertInput {
    pub text: String,
    #[serde(default = "default_true")]
    pub append_if_no_cursor: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KnowledgeError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KnowledgeHttpResponse {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for KnowledgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for KnowledgeError {}

fn shared_knowledge_mutation_lock(app_data_dir: &Path) -> Result<Arc<Mutex<()>>, KnowledgeError> {
    let mut locks = KNOWLEDGE_MUTATION_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(app_data_dir).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(app_data_dir.to_path_buf(), Arc::downgrade(&lock));
    Ok(lock)
}

#[derive(Clone)]
pub(crate) struct KnowledgeService {
    app_data_dir: PathBuf,
    // A workspace view captures existing authority once. Switching Main's Vault
    // never silently retargets it; root identity is rechecked on each operation.
    workspace_scope: Option<(KnowledgeVaultRegistration, KnowledgeTargetIdentity)>,
    mutation_lock: Arc<Mutex<()>>,
    current_context: Arc<Mutex<KnowledgeCurrentContextState>>,
    ui_source: Arc<Mutex<KnowledgeUiSourceState>>,
    remote_editing: Arc<Mutex<live_sync::RemoteEditing>>,
    committed_listener: Arc<Mutex<Option<Arc<dyn Fn(KnowledgeCommittedChange) + Send + Sync>>>>,
    committed_checkpoint: Arc<Mutex<live_sync::CommittedCheckpoint>>,
    index: index::KnowledgeIndex,
    attachment_inventory: Arc<attachment_inventory_cache::AttachmentInventoryCache>,
    attachment_attempt: Arc<Mutex<Option<attachment_operations::AttachmentAttemptState>>>,
    attachment_observations: Arc<Mutex<attachment_observations::AttachmentObservations>>,
    #[cfg(test)]
    write_fault_before_commit: Arc<AtomicBool>,
    #[cfg(test)]
    after_final_validation: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
    #[cfg(test)]
    interrupt_after_backup_rename: Arc<AtomicBool>,
    #[cfg(test)]
    attachment_fault_after_steps: Arc<std::sync::atomic::AtomicUsize>,
}

impl KnowledgeService {
    pub(crate) fn document_id(document_ref: &KnowledgeDocumentRef) -> String {
        legacy_note_id(document_ref)
    }

    pub(crate) fn parse_document_id(value: &str) -> Result<KnowledgeDocumentRef, KnowledgeError> {
        parse_legacy_note_id(value)
    }

    pub(crate) fn initialize(app_data_dir: impl AsRef<Path>) -> Result<Self, KnowledgeError> {
        std::fs::create_dir_all(app_data_dir.as_ref()).map_err(|_| {
            error(
                "knowledge-app-data-unavailable",
                "Knowledge app data is unavailable",
            )
        })?;
        let app_data_dir = std::fs::canonicalize(app_data_dir.as_ref()).map_err(|_| {
            error(
                "knowledge-app-data-unavailable",
                "Knowledge app data is unavailable",
            )
        })?;
        let service = Self {
            mutation_lock: shared_knowledge_mutation_lock(&app_data_dir)?,
            app_data_dir,
            workspace_scope: None,
            current_context: Arc::new(Mutex::new(KnowledgeCurrentContextState::default())),
            ui_source: Arc::new(Mutex::new(KnowledgeUiSourceState::default())),
            remote_editing: Arc::new(Mutex::new(Default::default())),
            committed_listener: Arc::new(Mutex::new(None)),
            committed_checkpoint: Arc::new(Mutex::new(live_sync::CommittedCheckpoint::default())),
            index: index::KnowledgeIndex::default(),
            attachment_inventory: Arc::new(attachment_inventory_cache::AttachmentInventoryCache::new()),
            attachment_attempt: Arc::new(Mutex::new(None)),
            attachment_observations: Arc::new(Mutex::new(Default::default())),
            #[cfg(test)]
            write_fault_before_commit: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            after_final_validation: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            interrupt_after_backup_rename: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            attachment_fault_after_steps: Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX)),
        };
        service.recover_registered_vault_if_present()?;
        if service.current_vault_path().is_file() {
            let vault = service.current_vault_unlocked()?;
            service.migrate_saved_vaults(&[vault.registration])?;
        }
        Ok(service)
    }

    pub(crate) fn capture_workspace_scope(&self, vault_id: &str) -> Result<Self, KnowledgeError> {
        let (vault, _guard, identity) = self.capture_current_target()?;
        if vault.registration.id != vault_id { return Err(knowledge_target_not_current()); }
        let mut scoped = self.clone();
        scoped.workspace_scope = Some((vault.registration, identity));
        scoped.index = index::KnowledgeIndex::default();
        Ok(scoped)
    }

    pub(crate) fn workspace_recovery_record(&self)->Result<WorkspaceScopeRecord,KnowledgeError>{
        let (registration,identity)=self.workspace_scope.as_ref().ok_or_else(knowledge_target_not_current)?;
        Ok(WorkspaceScopeRecord{registration:registration.clone(),target_id:identity.target_id.clone(),identity_digest:identity.identity_digest.clone(),label:identity.label.clone()})
    }
    pub(crate) fn restore_workspace_scope(&self,record:&WorkspaceScopeRecord)->Result<Self,KnowledgeError>{
        let mut scope=self.clone();scope.workspace_scope=Some((record.registration.clone(),KnowledgeTargetIdentity{target_id:record.target_id.clone(),identity_digest:record.identity_digest.clone(),label:record.label.clone()}));
        scope.index=index::KnowledgeIndex::default();scope.current_vault_unlocked()?;Ok(scope)
    }

    pub(crate) fn register_current_vault(
        &self,
        vault: &KnowledgeVaultRegistration,
    ) -> Result<(), KnowledgeError> {
        if self.workspace_scope.is_some() { return Err(knowledge_target_not_current()); }
        let mut ui_source = self
            .ui_source
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge UI source lock failed"))?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let trusted = trusted_vault(vault)?;
        recover_pending_document_writes(&trusted.root)?;
        let mut normalized = vault.clone();
        normalized.root_path = trusted.root.to_string_lossy().to_string();
        normalized.link_update_policy = trusted.registration.link_update_policy;
        let bytes = serde_json::to_vec_pretty(&normalized).map_err(|_| {
            error(
                "knowledge-vault-registry-invalid",
                "Vault registration is invalid",
            )
        })?;
        self.remember_current_saved_unlocked(&normalized)?;
        atomic_write(&self.current_vault_path(), &bytes, true)?;
        ui_source.epoch = ui_source.epoch.saturating_add(1).max(1);
        ui_source.active_vault_id = None;
        let mut context = self.current_context.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge current context lock failed",
            )
        })?;
        context.active_session_id = None;
        context.active_session_epoch = 0;
        context.active_owner = KnowledgeCurrentContextOwner::None;
        context.generation = 0;
        context.context = None;
        self.index.invalidate()?;
        self.attachment_inventory.invalidate();
        Ok(())
    }

    pub(crate) fn activate_ui_source(
        &self,
        vault_id: &str,
    ) -> Result<KnowledgeUiSourceActivation, KnowledgeError> {
        let mut state = self
            .ui_source
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge UI source lock failed"))?;
        let current = self.current_vault_unlocked()?;
        if current.registration.id != vault_id {
            return Err(error(
                "knowledge-vault-not-current",
                "Knowledge UI source is not the current Vault",
            ));
        }
        state.epoch = state.epoch.saturating_add(1).max(1);
        state.active_vault_id = Some(vault_id.to_string());
        state.dirty_paths.clear();
        state.dirty_generation = 0;
        let mut context = self.current_context.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge current context lock failed",
            )
        })?;
        context.active_session_id = None;
        context.active_session_epoch = 0;
        context.active_owner = KnowledgeCurrentContextOwner::None;
        context.generation = 0;
        context.context = None;
        Ok(KnowledgeUiSourceActivation {
            vault_id: vault_id.to_string(),
            source_epoch: state.epoch,
        })
    }

    pub(crate) fn deactivate_ui_source(&self) -> Result<(), KnowledgeError> {
        let mut source = self
            .ui_source
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge UI source lock failed"))?;
        source.epoch = source.epoch.saturating_add(1).max(1);
        source.active_vault_id = None;
        source.dirty_paths.clear();
        source.dirty_generation = 0;
        let mut context = self.current_context.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge current context lock failed",
            )
        })?;
        context.active_session_id = None;
        context.active_session_epoch = 0;
        context.active_owner = KnowledgeCurrentContextOwner::None;
        context.generation = 0;
        context.context = None;
        self.index.invalidate()?;
        self.attachment_inventory.invalidate();
        Ok(())
    }

    /// Plugin adapter final source+draft veto; caller must also use the renderer's
    /// live editor dirty check. Do not nest *_from_ui (the source mutex is held).
    pub(crate) fn with_plugin_source<T>(&self, epoch:u64, document:Option<&KnowledgeDocumentRef>, action:impl FnOnce()->Result<T,KnowledgeError>)->Result<T,KnowledgeError> {
        let source=self.lock_active_ui_source(epoch,document.map(|r|r.vault_id.as_str()))?;
        if document.is_some_and(|r|source._state.dirty_paths.contains(&r.relative_path)) {
            return Err(error("knowledge-desktop-draft-busy","Desktop has an unsaved draft"));
        }
        action()
    }

    pub(crate) fn create_document_from_ui(
        &self,
        source_epoch: u64,
        input: &KnowledgeCreateInput,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        let _source = self.lock_active_ui_source(source_epoch, None)?;
        self.create_document(input)
    }

    pub(crate) fn append_document_from_ui(
        &self,
        source_epoch: u64,
        input: &KnowledgeWriteInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _source =
            self.lock_active_ui_source(source_epoch, Some(&input.document_ref.vault_id))?;
        self.append_document(input)
    }

    pub(crate) fn insert_document_from_ui(
        &self,
        source_epoch: u64,
        input: &KnowledgeInsertInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _source =
            self.lock_active_ui_source(source_epoch, Some(&input.document_ref.vault_id))?;
        self.insert_document(input)
    }

    pub(crate) fn replace_document_from_ui(
        &self,
        source_epoch: u64,
        input: &KnowledgeWriteInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _source =
            self.lock_active_ui_source(source_epoch, Some(&input.document_ref.vault_id))?;
        self.replace_document(input)
    }

    pub(crate) fn move_document_from_ui(
        &self,
        source_epoch: u64,
        input: &KnowledgeMoveInput,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        let _source =
            self.lock_active_ui_source(source_epoch, Some(&input.document_ref.vault_id))?;
        self.move_document(input)
    }

    pub(crate) fn delete_document_from_ui(
        &self,
        source_epoch: u64,
        input: &KnowledgeDeleteInput,
    ) -> Result<(), KnowledgeError> {
        let _source =
            self.lock_active_ui_source(source_epoch, Some(&input.document_ref.vault_id))?;
        self.delete_document(input)
    }

    pub(crate) fn set_document_tags_from_ui(
        &self,
        source_epoch: u64,
        input: &KnowledgeSetTagsInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _source =
            self.lock_active_ui_source(source_epoch, Some(&input.document_ref.vault_id))?;
        self.set_document_tags(input)
    }

    pub(crate) fn insert_into_current_from_ui(
        &self,
        source_epoch: u64,
        input: &KnowledgeCurrentInsertInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _source = self.lock_active_ui_source(source_epoch, None)?;
        self.insert_into_bound_current(input,None,&_source)
    }

    pub(crate) fn lock_active_ui_source(
        &self,
        source_epoch: u64,
        expected_vault_id: Option<&str>,
    ) -> Result<KnowledgeUiSourceGuard<'_>, KnowledgeError> {
        let state = self
            .ui_source
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge UI source lock failed"))?;
        let current = self.current_vault_unlocked()?;
        if state.epoch != source_epoch
            || state.active_vault_id.as_deref() != Some(current.registration.id.as_str())
            || expected_vault_id.is_some_and(|vault_id| vault_id != current.registration.id)
        {
            return Err(error(
                "knowledge-source-inactive",
                "Knowledge writes require the active real Vault source",
            ));
        }
        Ok(KnowledgeUiSourceGuard { _state: state })
    }

    pub(crate) fn create_document(
        &self,
        input: &KnowledgeCreateInput,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        self.create_document_for_vault(None, input)
    }

    pub(crate) fn create_document_for_expected_vault(
        &self,
        expected_vault_id: &str,
        input: &KnowledgeCreateInput,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        self.create_document_for_vault(Some(expected_vault_id), input)
    }

    pub(crate) fn create_document_for_expected_vault_with_receipt(
        &self,
        expected_vault_id: &str,
        input: &KnowledgeCreateInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.create_document_for_vault_receipt(Some(expected_vault_id), input)
    }

    pub(crate) fn create_document_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeCreateInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.create_document_for_vault_receipt_and_target(None, Some(expected), input)
    }

    fn create_document_for_vault(
        &self,
        expected_vault_id: Option<&str>,
        input: &KnowledgeCreateInput,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        Ok(self
            .create_document_for_vault_receipt(expected_vault_id, input)?
            .document)
    }

    fn create_document_for_vault_receipt(
        &self,
        expected_vault_id: Option<&str>,
        input: &KnowledgeCreateInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.create_document_for_vault_receipt_and_target(expected_vault_id, None, input)
    }

    fn create_document_for_vault_receipt_and_target(
        &self,
        expected_vault_id: Option<&str>,
        expected_target: Option<&KnowledgeTargetIdentity>,
        input: &KnowledgeCreateInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        if expected_vault_id.is_some_and(|expected| expected != vault.registration.id) {
            return Err(error(
                "knowledge-vault-not-current",
                "Knowledge operation no longer targets the current Vault",
            ));
        }
        let target_guard = self.capture_expected_target_unlocked(&vault, expected_target)?;
        let parent = safe_relative_directory(input.parent_relative_path.as_deref())?;
        let file_name = safe_markdown_name(&input.title)?;
        let relative_path = if parent.as_os_str().is_empty() {
            PathBuf::from(file_name)
        } else {
            parent.join(file_name)
        };
        let parent_path = if parent.as_os_str().is_empty() {
            vault.root.clone()
        } else {
            safe_existing_directory(&vault.root, &parent)?
        };
        let target = parent_path.join(relative_path.file_name().unwrap_or_default());
        if target.exists() {
            return Err(error(
                "knowledge-name-conflict",
                "A document with this name already exists",
            ));
        }
        self.assert_expected_target_unlocked(&vault, expected_target, target_guard.as_ref())?;
        self.write_document(&target, input.content.as_bytes(), false)?;
        #[cfg(test)]
        if let Some(hook) = self
            .after_final_validation
            .lock()
            .expect("knowledge test hook lock")
            .take()
        {
            hook();
        }
        if let Err(error) =
            self.assert_expected_target_unlocked(&vault, expected_target, target_guard.as_ref())
        {
            let rollback_confirmed = std::fs::read(&target)
                .ok()
                .is_some_and(|bytes| bytes == input.content.as_bytes())
                && std::fs::remove_file(&target).is_ok()
                && !target.exists();
            if rollback_confirmed {
                return Err(error);
            }
            let document = snapshot_from_committed_bytes(
                &vault,
                &relative_path,
                &target,
                input.content.as_bytes(),
            )?;
            return Ok(KnowledgeMutationResult {
                document,
                position: "created".to_string(),
                index_stale: true,
                index_warning: Some(KnowledgeMutationWarning {
                    code: error.code.to_string(),
                    message: "Document was written, but the active Vault changed before post-write verification"
                        .to_string(),
                }),
            });
        }
        let (document, index_warning) =
            match self.snapshot_from_path(&vault, &relative_path, &target) {
                Ok(snapshot) => (snapshot, None),
                Err(error) => (
                    snapshot_from_committed_bytes(
                        &vault,
                        &relative_path,
                        &target,
                        input.content.as_bytes(),
                    )?,
                    Some(KnowledgeMutationWarning {
                        code: error.code.to_string(),
                        message: "Document was written, but follow-up metadata could not be read"
                            .to_string(),
                    }),
                ),
            };
        Ok(KnowledgeMutationResult {
            document,
            position: "created".to_string(),
            index_stale: index_warning.is_some(),
            index_warning,
        })
    }

    pub(crate) fn list_documents(&self) -> Result<Vec<KnowledgeDocumentSummary>, KnowledgeError> {
        let mut documents = self
            .refresh_index()?
            .documents
            .into_iter()
            .map(|document| document.summary())
            .collect::<Vec<_>>();
        documents.sort_by(|left, right| {
            right
                .modified_at
                .cmp(&left.modified_at)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        Ok(documents)
    }

    pub(crate) fn read_document(
        &self,
        document_ref: &KnowledgeDocumentRef,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        // Captured window scopes share this existing transaction gate. A read
        // must not enter an exclusive Windows commit or its rename interval.
        let _guard = self.mutation_lock.lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        self.read_document_unlocked(document_ref)
    }

    fn read_document_unlocked(
        &self,
        document_ref: &KnowledgeDocumentRef,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        let vault = self.current_vault_unlocked()?;
        require_matching_vault(document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&document_ref.relative_path)?;
        let target = safe_existing_file(&vault.root, &relative)?;
        self.snapshot_from_path(&vault, &relative, &target)
    }

    pub(crate) fn read_document_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        document_ref: &KnowledgeDocumentRef,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        let _guard = self.mutation_lock.lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let root_guard = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        require_matching_vault(document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&document_ref.relative_path)?;
        let target = safe_existing_file(&vault.root, &relative)?;
        let snapshot = self.snapshot_from_path(&vault, &relative, &target)?;
        self.assert_expected_target_unlocked(&vault, Some(expected), root_guard.as_ref())?;
        drop(root_guard);
        Ok(snapshot)
    }

    pub(crate) fn current_vault_id(&self) -> Result<String, KnowledgeError> {
        Ok(self.current_vault_unlocked()?.registration.id)
    }

    pub(crate) fn companion_set_desktop_drafts(&self, source_epoch: u64, generation: u64, paths: Vec<String>) -> Result<(), KnowledgeError> {
        let mut source = self.ui_source.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge source unavailable"))?;
        if source.epoch != source_epoch || source.active_vault_id.is_none() { return Err(knowledge_target_not_current()); }
        if generation <= source.dirty_generation { return Ok(()); }
        if paths.len() > 1000 { return Err(error("knowledge-drafts-invalid", "Too many pending drafts")); }
        for path in &paths { safe_markdown_relative_path(path)?; }
        source.dirty_paths = paths.into_iter().collect();
        source.dirty_generation = generation;
        Ok(())
    }

    /// Hold source ownership while checking the draft veto and entering the
    /// existing mutation service. Renderer revision guards handle an input that
    /// began before its dirty notification reached the backend.
    pub(crate) fn with_companion_draft_guard<T>(&self, document_ref: &KnowledgeDocumentRef, action: impl FnOnce() -> Result<T, KnowledgeError>) -> Result<T, KnowledgeError> {
        let source = self.ui_source.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge source unavailable"))?;
        if source.active_vault_id.as_deref() == Some(&document_ref.vault_id) && source.dirty_paths.contains(&document_ref.relative_path) {
            return Err(error("knowledge-desktop-draft-busy", "Desktop has an unsaved draft"));
        }
        action()
    }

    pub(crate) fn companion_has_unsaved_draft(&self) -> Result<bool, KnowledgeError> {
        let source = self.ui_source.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge source unavailable"))?;
        let owns_source = match &self.workspace_scope {
            Some((registration, _)) => source.active_vault_id.as_deref() == Some(registration.id.as_str()),
            None => source.active_vault_id.is_some(),
        };
        Ok(owns_source && !source.dirty_paths.is_empty())
    }

    pub(crate) fn companion_document_identity(&self, document_ref: &KnowledgeDocumentRef, expected: &KnowledgeTargetIdentity) -> Result<Option<String>, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if identity != *expected { return Err(knowledge_target_not_current()); }
        require_matching_vault(document_ref, &vault.registration)?;
        let path = safe_existing_file(&vault.root, &safe_markdown_relative_path(&document_ref.relative_path)?)?;
        let file = File::open(&path).map_err(|_| error("knowledge-not-found", "Document unavailable"))?;
        let object = index::attachment_object_identity(&file, &path).map(|(device, file)| format!("{device:x}:{file:x}"));
        self.verify_current_target(expected, &guard)?;
        Ok(object)
    }

    pub(crate) fn current_target_identity(
        &self,
    ) -> Result<KnowledgeTargetIdentity, KnowledgeError> {
        self.capture_current_target()
            .map(|(_, _, identity)| identity)
    }

    fn capture_current_target(
        &self,
    ) -> Result<
        (
            TrustedVault,
            FilesystemDirectoryIdentityGuard,
            KnowledgeTargetIdentity,
        ),
        KnowledgeError,
    > {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let current = self.current_vault_unlocked()?;
        let root_guard = filesystem_directory_identity_guard(&current.root)
            .map_err(map_filesystem_identity_error)?;
        root_guard
            .verify_current_path(&current.root)
            .map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(&current, root_guard.identity())?;
        Ok((current, root_guard, identity))
    }

    fn verify_current_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        root_guard: &FilesystemDirectoryIdentityGuard,
    ) -> Result<(), KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let current_vault = self.current_vault_unlocked()?;
        root_guard
            .verify_current_path(&current_vault.root)
            .map_err(map_filesystem_identity_error)?;
        let current = knowledge_target_identity(&current_vault, root_guard.identity())?;
        if current != *expected {
            return Err(knowledge_target_not_current());
        }
        Ok(())
    }

    pub(crate) fn active_ui_source_identity(
        &self,
    ) -> Result<KnowledgeUiSourceActivation, KnowledgeError> {
        let state = self
            .ui_source
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge UI source lock failed"))?;
        let current = self.current_vault_unlocked()?;
        if state.active_vault_id.as_deref() != Some(current.registration.id.as_str()) {
            return Err(error(
                "knowledge-source-inactive",
                "Knowledge operations require the active real Vault source",
            ));
        }
        Ok(KnowledgeUiSourceActivation {
            vault_id: current.registration.id,
            source_epoch: state.epoch,
        })
    }

    pub(crate) fn activate_current_ui_source(
        &self,
    ) -> Result<KnowledgeUiSourceActivation, KnowledgeError> {
        let current_vault_id = self.current_vault_id()?;
        self.activate_ui_source(&current_vault_id)
    }

    /// Linearizes a bounded response handoff against current-Vault switches.
    ///
    /// `register_current_vault` uses the same mutation lock, so the closure is
    /// executed only while `expected_vault_id` is still the registered Vault.
    /// Callers must keep the closure bounded and must not perform I/O or wait on
    /// another service lock while this lease is held.
    pub(crate) fn with_current_vault_response_lease<T>(
        &self,
        expected_vault_id: &str,
        handoff: impl FnOnce() -> T,
    ) -> Result<T, KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let current = self.current_vault_unlocked()?;
        if current.registration.id != expected_vault_id {
            return Err(error(
                "knowledge-vault-not-current",
                "Knowledge operation no longer targets the current Vault",
            ));
        }
        Ok(handoff())
    }

    /// Publishes a bounded safe response only while the exact Knowledge target
    /// and its filesystem root object are still current. The closure must not
    /// perform I/O or acquire another service lock.
    pub(crate) fn with_current_target_response_lease<T>(
        &self,
        expected: &KnowledgeTargetIdentity,
        handoff: impl FnOnce() -> T,
    ) -> Result<T, KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let current = self.current_vault_unlocked()?;
        let root_guard = filesystem_directory_identity_guard(&current.root)
            .map_err(map_filesystem_identity_error)?;
        root_guard
            .verify_current_path(&current.root)
            .map_err(map_filesystem_identity_error)?;
        if knowledge_target_identity(&current, root_guard.identity())? != *expected {
            return Err(knowledge_target_not_current());
        }
        Ok(handoff())
    }

    pub(crate) fn recent_documents(
        &self,
        limit: usize,
    ) -> Result<Vec<KnowledgeDocumentSummary>, KnowledgeError> {
        Ok(self
            .list_documents()?
            .into_iter()
            .take(limit.min(200))
            .collect())
    }

    pub(crate) fn search_documents(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<KnowledgeDocumentSummary>, KnowledgeError> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return self.recent_documents(limit);
        }
        let mut indexed_documents = self.refresh_index()?.documents;
        indexed_documents.sort_by(|left, right| {
            right
                .modified_at
                .cmp(&left.modified_at)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        let mut matches = Vec::new();
        for document in indexed_documents {
            if document.title.to_lowercase().contains(&query)
                || document.plain_text.to_lowercase().contains(&query)
            {
                matches.push(document.summary());
                if matches.len() >= limit.min(200) {
                    break;
                }
            }
        }
        Ok(matches)
    }

    /// Watcher-driven invalidation of the shared attachment snapshot. The
    /// document index only reports Markdown deltas, so non-Markdown file
    /// events (and incomplete watcher batches) must drop the snapshot here.
    pub(crate) fn invalidate_attachment_inventory(&self, vault_id: &str) -> Result<(), KnowledgeError> {
        let current = self.current_vault_unlocked()?;
        if current.registration.id != vault_id {
            return Err(knowledge_target_not_current());
        }
        self.attachment_inventory.invalidate();
        Ok(())
    }

    pub(crate) fn refresh_index(&self) -> Result<KnowledgeIndexSnapshot, KnowledgeError> {
        let vault = self.current_vault_unlocked()?;
        let snapshot = self.index.refresh(&vault)?;
        // Full reconciliation is also the recovery path for lost non-Markdown
        // watcher events. Markdown-only saves use refresh_modified_documents.
        self.attachment_inventory.invalidate();
        Ok(snapshot)
    }

    pub(crate) fn refresh_modified_documents(&self, paths: &[String]) -> Result<KnowledgeIndexSnapshot, KnowledgeError> {
        let (vault, root_guard, identity) = self.capture_current_target()?;
        let snapshot = self.index.refresh_modified(&vault, paths)?;
        self.verify_current_target(&identity, &root_guard)?;
        Ok(snapshot)
    }

    /// Refreshes only the exact Backend identity frozen into an Agent run.
    /// The current registration is captured under the same mutation lock used
    /// by Vault switches, then revalidated before the snapshot can leave the
    /// Backend. A switch can therefore make the read fail, but can never make
    /// an old run query or receive a newly active Vault.
    pub(crate) fn refresh_index_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
    ) -> Result<KnowledgeIndexSnapshot, KnowledgeError> {
        let (vault, root_guard, identity) = self.capture_current_target()?;
        if identity != *expected {
            return Err(knowledge_target_not_current());
        }
        let snapshot = self.index.refresh(&vault)?;
        self.verify_current_target(expected, &root_guard)?;
        drop(root_guard);
        // Full reconciliation is also the recovery path for lost non-Markdown
        // watcher events. Markdown-only saves use refresh_modified_documents.
        self.attachment_inventory.invalidate();
        Ok(snapshot)
    }

    pub(crate) fn refresh_index_for_legacy_identity(
        &self,
        vault_id: &str,
        caller_root: &str,
    ) -> Result<(KnowledgeIndexSnapshot, PathBuf), KnowledgeError> {
        let vault = self.current_vault_unlocked()?;
        if vault.registration.id != vault_id {
            return Err(error(
                "knowledge-vault-mismatch",
                "Knowledge index request belongs to a different Vault",
            ));
        }
        let caller_root = PathBuf::from(caller_root).canonicalize().map_err(|_| {
            error(
                "knowledge-vault-mismatch",
                "Knowledge index Vault identity is invalid",
            )
        })?;
        if caller_root != vault.root {
            return Err(error(
                "knowledge-vault-mismatch",
                "Knowledge index Vault identity does not match the trusted current Vault",
            ));
        }
        let snapshot = self.index.refresh(&vault)?;
        Ok((snapshot, vault.root))
    }

    pub(crate) fn index_snapshot(&self) -> Result<KnowledgeIndexSnapshot, KnowledgeError> {
        let vault = self.current_vault_unlocked()?;
        self.index.snapshot(&vault)
    }

    pub(crate) fn document_relations(
        &self,
        document_ref: &KnowledgeDocumentRef,
    ) -> Result<KnowledgeDocumentRelations, KnowledgeError> {
        let snapshot = self.refresh_index()?;
        let document = snapshot
            .documents
            .into_iter()
            .find(|document| &document.document_ref == document_ref)
            .ok_or_else(|| error("knowledge-not-found", "Knowledge document does not exist"))?;
        Ok(KnowledgeDocumentRelations {
            document_ref: document.document_ref,
            headings: document.headings,
            wiki_links: document.wiki_links,
            embeds: document.embeds,
            tags: document.tags,
        })
    }

    pub(crate) fn backlinks(
        &self,
        document_ref: &KnowledgeDocumentRef,
    ) -> Result<Vec<KnowledgeBacklink>, KnowledgeError> {
        let snapshot = self.refresh_index()?;
        if snapshot
            .documents
            .iter()
            .all(|document| &document.document_ref != document_ref)
        {
            return Err(error(
                "knowledge-not-found",
                "Knowledge document does not exist",
            ));
        }
        let mut backlinks = Vec::new();
        for document in &snapshot.documents {
            for link in &document.wiki_links {
                let resolution =
                    index::resolve_wiki_target(&snapshot, &document.document_ref, &link.target);
                if resolution.document_ref.as_ref() == Some(document_ref)
                    || resolution
                        .candidates
                        .iter()
                        .any(|candidate| candidate == document_ref)
                {
                    backlinks.push(KnowledgeBacklink {
                        source_ref: document.document_ref.clone(),
                        link: link.clone(),
                        resolution,
                    });
                }
            }
        }
        backlinks.sort_by(|left, right| {
            left.source_ref
                .relative_path
                .cmp(&right.source_ref.relative_path)
                .then_with(|| left.link.line.cmp(&right.link.line))
        });
        Ok(backlinks)
    }

    pub(crate) fn tag_summary(&self) -> Result<Vec<KnowledgeTagSummary>, KnowledgeError> {
        let snapshot = self.refresh_index()?;
        let mut counts = std::collections::HashMap::<String, (String, usize)>::new();
        for document in snapshot.documents {
            let mut seen = std::collections::HashSet::new();
            for tag in document.tags {
                let key = tag.to_lowercase();
                if seen.insert(key.clone()) {
                    let entry = counts.entry(key).or_insert((tag, 0));
                    entry.1 += 1;
                }
            }
        }
        let mut summary = counts
            .into_values()
            .map(|(name, document_count)| KnowledgeTagSummary {
                name,
                document_count,
            })
            .collect::<Vec<_>>();
        summary.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        Ok(summary)
    }

    pub(crate) fn documents_for_tag(
        &self,
        tag: &str,
    ) -> Result<Vec<KnowledgeDocumentSummary>, KnowledgeError> {
        let tag = tag.trim().trim_start_matches('#').to_lowercase();
        if tag.is_empty() {
            return Err(error("knowledge-tag-required", "Knowledge tag is required"));
        }
        let mut documents = self
            .refresh_index()?
            .documents
            .into_iter()
            .filter(|document| {
                document
                    .tags
                    .iter()
                    .any(|value| value.to_lowercase() == tag)
            })
            .map(|document| document.summary())
            .collect::<Vec<_>>();
        documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(documents)
    }

    pub(crate) fn documents_referencing_embed(
        &self,
        target: &str,
    ) -> Result<Vec<KnowledgeDocumentSummary>, KnowledgeError> {
        let target = target.trim();
        if target.is_empty() {
            return Err(error(
                "knowledge-embed-target-required",
                "Knowledge embed target is required",
            ));
        }
        let mut documents = self
            .refresh_index()?
            .documents
            .into_iter()
            .filter(|document| document.embeds.iter().any(|embed| embed.target == target))
            .map(|document| document.summary())
            .collect::<Vec<_>>();
        documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(documents)
    }

    pub(crate) fn set_document_tags(
        &self,
        input: &KnowledgeSetTagsInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.set_document_tags_for_optional_target(None, input)
    }

    pub(crate) fn set_document_tags_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeSetTagsInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.set_document_tags_for_optional_target(Some(expected), input)
    }

    fn set_document_tags_for_optional_target(
        &self,
        expected: Option<&KnowledgeTargetIdentity>,
        input: &KnowledgeSetTagsInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let tags = normalize_document_tags(&input.tags)?;
        let mut result = self.mutate_document_for_optional_target(
            expected,
            &input.document_ref,
            Some(&input.expected_revision),
            |document| replace_frontmatter_tags(document, &tags),
            "tags",
        )?;
        let refreshed = match expected {
            Some(target) => self.refresh_index_for_target(target),
            None => self.refresh_index(),
        };
        match refreshed {
            Ok(snapshot) if snapshot.stale => {
                result.index_stale = true;
                result.index_warning = snapshot
                    .refresh_error
                    .map(|failure| KnowledgeMutationWarning {
                        code: failure.code,
                        message: failure.message,
                    })
                    .or_else(|| {
                        Some(KnowledgeMutationWarning {
                            code: "knowledge-index-stale".to_string(),
                            message: "Knowledge document was saved but the index is stale"
                                .to_string(),
                        })
                    });
            }
            Ok(_) => {}
            Err(failure) => {
                result.index_stale = true;
                result.index_warning = Some(KnowledgeMutationWarning {
                    code: failure.code.to_string(),
                    message: failure.message,
                });
            }
        }
        Ok(result)
    }

    #[cfg(test)]
    fn index_document_read_count(&self) -> usize {
        self.index.document_read_count()
    }

    #[cfg(test)]
    fn index_max_active_refreshes(&self) -> usize {
        self.index.max_active_refreshes()
    }

    #[cfg(test)]
    fn set_before_index_document_read(&self, hook: impl Fn() + Send + Sync + 'static) {
        self.index.set_before_document_read(hook);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_index_refresh(&self) {
        self.index.fail_next_refresh();
    }

    #[cfg(test)]
    pub(crate) fn fail_next_index_mark_dirty(&self) {
        self.index.fail_next_mark_dirty();
    }

    #[cfg(test)]
    fn force_unreliable_index_identity(&self, enabled: bool) {
        self.index.force_unreliable_identity(enabled);
    }

    pub(crate) fn append_document(
        &self,
        input: &KnowledgeWriteInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.mutate_document_for_optional_target(
            None,
            &input.document_ref,
            input.expected_revision.as_deref(),
            |document| append_text(document, &input.content),
            "append",
        )
    }

    pub(crate) fn append_document_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeWriteInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.mutate_document_for_optional_target(
            Some(expected),
            &input.document_ref,
            input.expected_revision.as_deref(),
            |document| append_text(document, &input.content),
            "append",
        )
    }

    pub(crate) fn preview_agent_create_revision(
        &self,
        document_ref: &KnowledgeDocumentRef,
        content: &str,
    ) -> Result<String, KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        require_matching_vault(document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&document_ref.relative_path)?;
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let target_parent = if parent.as_os_str().is_empty() {
            vault.root.clone()
        } else {
            safe_existing_directory(&vault.root, parent)?
        };
        let target = target_parent.join(relative.file_name().unwrap_or_default());
        if target.exists() {
            return Err(error(
                "knowledge-name-conflict",
                "A document with this name already exists",
            ));
        }
        self.assert_current_vault_unlocked(&vault.registration.id, &vault.root)?;
        Ok(sha256_hex(content.as_bytes()))
    }

    pub(crate) fn preview_agent_append_revision(
        &self,
        document_ref: &KnowledgeDocumentRef,
        expected_revision: &str,
        content: &str,
    ) -> Result<String, KnowledgeError> {
        self.preview_existing_document_revision(document_ref, expected_revision, |document| {
            append_text(document, content)
        })
    }

    pub(crate) fn preview_agent_set_tags_revision(
        &self,
        document_ref: &KnowledgeDocumentRef,
        expected_revision: &str,
        tags: &[String],
    ) -> Result<String, KnowledgeError> {
        let tags = normalize_document_tags(tags)?;
        self.preview_existing_document_revision(document_ref, expected_revision, |document| {
            replace_frontmatter_tags(document, &tags)
        })
    }

    fn preview_existing_document_revision(
        &self,
        document_ref: &KnowledgeDocumentRef,
        expected_revision: &str,
        mutation: impl FnOnce(&DecodedDocument) -> Result<String, KnowledgeError>,
    ) -> Result<String, KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        require_matching_vault(document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&document_ref.relative_path)?;
        let target = safe_existing_file(&vault.root, &relative)?;
        let bytes = std::fs::read(&target).map_err(|_| {
            error(
                "knowledge-read-failed",
                "Knowledge document could not be read",
            )
        })?;
        if sha256_hex(&bytes) != expected_revision {
            return Err(error(
                "knowledge-revision-conflict",
                "Knowledge document changed since it was opened",
            ));
        }
        let decoded = decode_document(&bytes)?;
        let next_content = mutation(&decoded)?;
        let next_bytes = encode_document(&decoded, &next_content);
        self.assert_current_vault_unlocked(&vault.registration.id, &vault.root)?;
        Ok(sha256_hex(&next_bytes))
    }

    pub(crate) fn insert_document(
        &self,
        input: &KnowledgeInsertInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.mutate_document_for_optional_target(
            None,
            &input.document_ref,
            input.expected_revision.as_deref(),
            |document| insert_text(document, input.offset, &input.text),
            "cursor",
        )
    }

    pub(crate) fn insert_document_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeInsertInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.mutate_document_for_optional_target(
            Some(expected),
            &input.document_ref,
            input.expected_revision.as_deref(),
            |document| insert_text(document, input.offset, &input.text),
            "cursor",
        )
    }

    pub(crate) fn replace_document(
        &self,
        input: &KnowledgeWriteInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.mutate_document_for_optional_target(
            None,
            &input.document_ref,
            input.expected_revision.as_deref(),
            |document| replace_text(document, &input.content),
            "replace",
        )
    }

    pub(crate) fn replace_document_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeWriteInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        self.mutate_document_for_optional_target(
            Some(expected),
            &input.document_ref,
            input.expected_revision.as_deref(),
            |document| replace_text(document, &input.content),
            "replace",
        )
    }

    pub(crate) fn move_document(
        &self,
        input: &KnowledgeMoveInput,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        self.move_document_for_optional_target(None, input)
    }

    pub(crate) fn move_document_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeMoveInput,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        self.move_document_for_optional_target(Some(expected), input)
    }

    /// Predict the exact bytes written by the product move path, including
    /// relative attachment-link rewrites, before recording a service intent.
    pub(crate) fn companion_expected_move_revision_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeMoveInput,
        destination: &str,
    ) -> Result<String, KnowledgeError> {
        let _guard = self.mutation_lock.lock().map_err(|_| {
            error("knowledge-lock-poisoned", "Knowledge service lock failed")
        })?;
        let vault = self.current_vault_unlocked()?;
        let target_guard = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        require_matching_vault(&input.document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&input.document_ref.relative_path)?;
        let source = safe_existing_file(&vault.root, &relative)?;
        let bytes = std::fs::read(&source).map_err(|_| {
            error("knowledge-read-failed", "Knowledge document could not be read")
        })?;
        if sha256_hex(&bytes) != input.expected_revision {
            return Err(error("knowledge-revision-conflict", "Knowledge document changed since it was opened"));
        }
        let after = self.moved_note_bytes_unlocked(&vault, input, destination, &bytes)?;
        self.assert_expected_target_unlocked(&vault, Some(expected), target_guard.as_ref())?;
        Ok(sha256_hex(&after))
    }

    fn move_document_for_optional_target(
        &self,
        expected_target: Option<&KnowledgeTargetIdentity>,
        input: &KnowledgeMoveInput,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let target_guard = self.capture_expected_target_unlocked(&vault, expected_target)?;
        require_matching_vault(&input.document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&input.document_ref.relative_path)?;
        let target = safe_existing_file(&vault.root, &relative)?;
        let file_name = safe_markdown_name(&input.title)?;
        let parent_relative = match input.parent_relative_path.as_deref() {
            Some(value) => safe_relative_directory(Some(value))?,
            None => relative
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_path_buf(),
        };
        let destination_relative = if parent_relative.as_os_str().is_empty() {
            PathBuf::from(file_name)
        } else {
            parent_relative.join(file_name)
        };
        let destination_parent = if parent_relative.as_os_str().is_empty() {
            vault.root.clone()
        } else {
            safe_existing_directory(&vault.root, &parent_relative)?
        };
        let destination =
            destination_parent.join(destination_relative.file_name().unwrap_or_default());
        if destination == target {
            return self.snapshot_from_path(&vault, &relative, &target);
        }
        if destination.exists() {
            return Err(error(
                "knowledge-name-conflict",
                "A document with this name already exists",
            ));
        }

        let mut file = open_exclusive_document(&target)?;
        let bytes = read_exclusive_document(&mut file)?;
        if sha256_hex(&bytes) != input.expected_revision {
            return Err(error(
                "knowledge-revision-conflict",
                "Knowledge document changed since it was opened",
            ));
        }
        self.assert_expected_target_unlocked(&vault, expected_target, target_guard.as_ref())?;
        drop(file);
        self.move_note_with_attachments_unlocked(&vault, input, &relative_path_string(&destination_relative), &bytes, target_guard.as_ref())?;

        self.index.mark_document_dirty(&input.document_ref)?;
        let next_ref = KnowledgeDocumentRef {
            vault_id: input.document_ref.vault_id.clone(),
            relative_path: destination_relative.to_string_lossy().replace('\\', "/"),
        };
        self.index.mark_document_dirty(&next_ref)?;
        self.snapshot_from_path(&vault, &destination_relative, &destination)
    }

    pub(crate) fn delete_document(
        &self,
        input: &KnowledgeDeleteInput,
    ) -> Result<(), KnowledgeError> {
        self.delete_document_for_optional_target(None, input)
    }

    pub(crate) fn delete_document_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeDeleteInput,
    ) -> Result<(), KnowledgeError> {
        self.delete_document_for_optional_target(Some(expected), input)
    }

    fn delete_document_for_optional_target(
        &self,
        expected_target: Option<&KnowledgeTargetIdentity>,
        input: &KnowledgeDeleteInput,
    ) -> Result<(), KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let target_guard = self.capture_expected_target_unlocked(&vault, expected_target)?;
        require_matching_vault(&input.document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&input.document_ref.relative_path)?;
        let target = safe_existing_file(&vault.root, &relative)?;
        let mut file = open_exclusive_document(&target)?;
        let bytes = read_exclusive_document(&mut file)?;
        if sha256_hex(&bytes) != input.expected_revision {
            return Err(error(
                "knowledge-revision-conflict",
                "Knowledge document changed since it was opened",
            ));
        }
        self.assert_expected_target_unlocked(&vault, expected_target, target_guard.as_ref())?;
        delete_open_file(&file)?;
        drop(file);
        self.index.mark_document_dirty(&input.document_ref)?;
        Ok(())
    }

    pub(crate) fn begin_current_context_session(
        &self,
        source_epoch: u64,
        session_id: &str,
    ) -> Result<KnowledgeContextSession, KnowledgeError> {
        if session_id.is_empty()
            || session_id.len() > 128
            || !session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(error(
                "knowledge-context-session-invalid",
                "Knowledge context session identity is invalid",
            ));
        }
        let _source = self.lock_active_ui_source(source_epoch, None)?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let mut state = self.current_context.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge current context lock failed",
            )
        })?;
        state.next_session_epoch = state.next_session_epoch.saturating_add(1).max(1);
        state.active_session_id = Some(session_id.to_string());
        state.active_session_epoch = state.next_session_epoch;
        state.active_owner = KnowledgeCurrentContextOwner::Desktop;
        state.desktop_claimed = true;
        state.generation = 0;
        state.context = None;
        Ok(KnowledgeContextSession {
            session_id: session_id.to_string(),
            session_epoch: state.active_session_epoch,
        })
    }

    pub(crate) fn set_current_context(
        &self,
        input: &KnowledgeCurrentContextInput,
    ) -> Result<KnowledgeCurrentContext, KnowledgeError> {
        let _source =
            self.lock_active_ui_source(input.source_epoch, Some(&input.document_ref.vault_id))?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let snapshot = self.read_document_unlocked(&input.document_ref)?;
        if input
            .expected_revision
            .as_deref()
            .is_some_and(|expected| expected != snapshot.revision)
        {
            return Err(error(
                "knowledge-revision-conflict",
                "Knowledge document changed before the editor context was published",
            ));
        }
        if input
            .cursor_offset
            .is_some_and(|offset| byte_offset_for_utf16(&snapshot.content, offset).is_none())
        {
            return Err(error(
                "knowledge-offset-conflict",
                "Knowledge document cursor offset is stale",
            ));
        }
        let context = KnowledgeCurrentContext {
            document_ref: input.document_ref.clone(),
            cursor_offset: input.cursor_offset,
            selection: input.selection.clone(),
            expected_revision: snapshot.revision,
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        let mut current = self.current_context.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge current context lock failed",
            )
        })?;
        require_ordered_current_context(
            &current,
            &input.session_id,
            input.session_epoch,
            input.generation,
        )?;
        current.generation = input.generation;
        current.context = Some(context.clone());
        Ok(context)
    }

    pub(crate) fn get_current_context(
        &self,
    ) -> Result<Option<KnowledgeCurrentContext>, KnowledgeError> {
        self.current_context
            .lock()
            .map(|state| state.context.clone())
            .map_err(|_| {
                error(
                    "knowledge-lock-poisoned",
                    "Knowledge current context lock failed",
                )
            })
    }

    pub(crate) fn publish_legacy_current_context(
        &self,
        note_id: Option<&str>,
        cursor_offset: Option<i64>,
        selection: Option<String>,
    ) -> Result<(), KnowledgeError> {
        let document_ref = note_id
            .filter(|value| !value.is_empty())
            .map(parse_legacy_note_id)
            .transpose()?;
        let cursor_offset = cursor_offset
            .map(|offset| {
                usize::try_from(offset).map_err(|_| {
                    error(
                        "knowledge-offset-conflict",
                        "Knowledge document cursor offset is stale",
                    )
                })
            })
            .transpose()?;
        let source_epoch = {
            let source = self
                .ui_source
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Knowledge UI source lock failed"))?;
            if source.active_vault_id.is_none() {
                return Err(error(
                    "knowledge-vault-required",
                    "Open or create a Vault before publishing editor context",
                ));
            }
            source.epoch
        };
        let (session, generation) = self.legacy_current_context_order(source_epoch)?;
        let Some(document_ref) = document_ref else {
            return self.clear_current_context(&KnowledgeCurrentContextClearInput {
                source_epoch,
                session_id: session.session_id,
                session_epoch: session.session_epoch,
                generation,
            });
        };
        self.set_current_context(&KnowledgeCurrentContextInput {
            source_epoch,
            session_id: session.session_id,
            session_epoch: session.session_epoch,
            generation,
            document_ref,
            cursor_offset,
            selection,
            expected_revision: None,
        })?;
        Ok(())
    }

    fn legacy_current_context_order(
        &self,
        source_epoch: u64,
    ) -> Result<(KnowledgeContextSession, u64), KnowledgeError> {
        let _source = self.lock_active_ui_source(source_epoch, None)?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let mut state = self.current_context.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge current context lock failed",
            )
        })?;
        if state.desktop_claimed || state.active_owner == KnowledgeCurrentContextOwner::Desktop {
            return Err(error(
                "knowledge-context-owner-conflict",
                "The desktop Notes editor owns the current Knowledge context",
            ));
        }
        if state.active_owner == KnowledgeCurrentContextOwner::None {
            state.next_session_epoch = state.next_session_epoch.saturating_add(1).max(1);
            state.active_session_id = Some("legacy-public-iframe".to_string());
            state.active_session_epoch = state.next_session_epoch;
            state.active_owner = KnowledgeCurrentContextOwner::LegacyIframe;
            state.generation = 0;
            state.context = None;
        }
        let session = KnowledgeContextSession {
            session_id: state
                .active_session_id
                .clone()
                .unwrap_or_else(|| "legacy-public-iframe".to_string()),
            session_epoch: state.active_session_epoch,
        };
        Ok((session, state.generation.saturating_add(1).max(1)))
    }

    pub(crate) fn clear_current_context(
        &self,
        input: &KnowledgeCurrentContextClearInput,
    ) -> Result<(), KnowledgeError> {
        let _source = self.lock_active_ui_source(input.source_epoch, None)?;
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let mut state = self.current_context.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge current context lock failed",
            )
        })?;
        require_ordered_current_context(
            &state,
            &input.session_id,
            input.session_epoch,
            input.generation,
        )?;
        state.generation = input.generation;
        state.context = None;
        Ok(())
    }

    pub(crate) fn insert_into_current(
        &self,
        input: &KnowledgeCurrentInsertInput,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _source=KnowledgeUiSourceGuard{_state:self.ui_source.lock().map_err(|_|error("knowledge-lock-poisoned","Knowledge UI source lock failed"))?};
        self.insert_into_bound_current(input,None,&_source)
    }

    /// Material embeds are Markdown blocks. General text insertion stays literal.
    pub(crate) fn insert_material_block_into_bound_current(&self, markdown: &str, context: &KnowledgeCurrentContext, source: &KnowledgeUiSourceGuard<'_>) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let document = self.read_document(&context.document_ref)?;
        if document.revision != context.expected_revision {
            return Err(error("knowledge-revision-conflict", "Note changed before material insertion"));
        }
        let text = if let Some(offset) = context.cursor_offset {
            let byte = byte_offset_for_utf16(&document.content, offset).ok_or_else(|| error("knowledge-offset-conflict", "Material insertion cursor is stale"))?;
            let before = &document.content[..byte];
            let after = &document.content[byte..];
            let leading = before.chars().rev().take_while(|c| *c == '\r' || *c == '\n').filter(|c| *c == '\n').count();
            let trailing = after.chars().take_while(|c| *c == '\r' || *c == '\n').filter(|c| *c == '\n').count();
            let newline = if document.content.contains("\r\n") { "\r\n" } else { "\n" };
            format!("{}{}{}", newline.repeat(if before.is_empty() { 0 } else { 2usize.saturating_sub(leading) }), markdown, newline.repeat(if after.is_empty() { 0 } else { 2usize.saturating_sub(trailing) }))
        } else { markdown.to_owned() };
        self.insert_into_bound_current(&KnowledgeCurrentInsertInput { text, append_if_no_cursor: true }, Some(context), source)
    }

    pub(crate) fn insert_into_bound_current(&self,input:&KnowledgeCurrentInsertInput,expected:Option<&KnowledgeCurrentContext>,_source:&KnowledgeUiSourceGuard<'_>)->Result<KnowledgeMutationResult,KnowledgeError> {
        let mut current=self.current_context.lock().map_err(|_|error("knowledge-lock-poisoned","Knowledge current context lock failed"))?;
        let context = current.context.clone().ok_or_else(|| {
            error(
                "knowledge-current-context-required",
                "No current Knowledge document is open",
            )
        })?;
        if expected.is_some_and(|expected|expected!=&context) {return Err(error("knowledge-current-context-changed","Current note changed before attachment insertion"));}
        let result = if let Some(offset) = context.cursor_offset {
            self.insert_document(&KnowledgeInsertInput {
                document_ref: context.document_ref.clone(),
                offset,
                text: input.text.clone(),
                expected_revision: Some(context.expected_revision.clone()),
            })?
        } else if input.append_if_no_cursor {
            self.append_document(&KnowledgeWriteInput {
                document_ref: context.document_ref.clone(),
                content: input.text.clone(),
                expected_revision: Some(context.expected_revision.clone()),
            })?
        } else {
            return Err(error(
                "knowledge-current-cursor-required",
                "The current Knowledge document has no cursor position",
            ));
        };
        let next_offset = context
            .cursor_offset
            .map(|offset| offset.saturating_add(input.text.encode_utf16().count()));
        if current
            .context
            .as_ref()
            .is_some_and(|candidate| candidate == &context)
        {
            current.context = Some(KnowledgeCurrentContext {
                document_ref: context.document_ref,
                cursor_offset: next_offset,
                selection: None,
                expected_revision: result.document.revision.clone(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            });
        }
        Ok(result)
    }

    pub(crate) fn handles_http_path(path: &str) -> bool {
        let path = path.split('?').next().unwrap_or(path);
        matches!(
            path,
            "/api/knowledge/documents"
                | "/api/knowledge/documents/recent"
                | "/api/knowledge/documents/search"
                | "/api/knowledge/read"
                | "/api/knowledge/current"
                | "/api/knowledge/context"
                | "/api/knowledge/current/clear"
                | "/api/knowledge/append"
                | "/api/knowledge/insert"
                | "/api/knowledge/replace"
                | "/api/knowledge/insert-current"
                | "/api/notes"
                | "/api/notes/recent"
                | "/api/notes/search"
                | "/api/notes/current"
        ) || path.starts_with("/api/notes/")
    }

    pub(crate) fn dispatch_http(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> KnowledgeHttpResponse {
        match self.dispatch_http_result(method, path, body) {
            Ok(value) => KnowledgeHttpResponse {
                status: 200,
                body: value.to_string(),
            },
            Err(error) => KnowledgeHttpResponse {
                status: knowledge_http_status(error.code),
                body: json!({ "code": error.code, "message": error.message }).to_string(),
            },
        }
    }

    fn dispatch_http_result(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<Value, KnowledgeError> {
        let raw_path = path;
        let path = raw_path.split('?').next().unwrap_or(raw_path);
        let parsed_body = || -> Result<Value, KnowledgeError> {
            serde_json::from_str(body.unwrap_or("{}")).map_err(|_| {
                error(
                    "knowledge-invalid-request",
                    "Knowledge request JSON is invalid",
                )
            })
        };
        match (method, path) {
            ("GET", "/api/knowledge/documents") | ("GET", "/api/knowledge/documents/recent") => {
                serde_json::to_value(self.recent_documents(200)?).map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                })
            }
            ("POST", "/api/knowledge/documents/search") => {
                let body = parsed_body()?;
                let query = body.get("query").and_then(Value::as_str).unwrap_or("");
                let limit = body.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
                serde_json::to_value(self.search_documents(query, limit)?).map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                })
            }
            ("POST", "/api/knowledge/documents") => {
                let input = serde_json::from_value::<KnowledgeCreateInput>(parsed_body()?)
                    .map_err(|_| {
                        error(
                            "knowledge-invalid-request",
                            "Knowledge create request is invalid",
                        )
                    })?;
                serde_json::to_value(self.create_document(&input)?).map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                })
            }
            ("POST", "/api/knowledge/read") => {
                let document_ref = serde_json::from_value::<KnowledgeDocumentRef>(
                    parsed_body()?
                        .get("documentRef")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(|_| {
                    error(
                        "knowledge-invalid-request",
                        "Knowledge read request is invalid",
                    )
                })?;
                serde_json::to_value(self.read_document(&document_ref)?).map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                })
            }
            ("POST", "/api/knowledge/append") => {
                let input = serde_json::from_value::<KnowledgeWriteInput>(parsed_body()?).map_err(
                    |_| {
                        error(
                            "knowledge-invalid-request",
                            "Knowledge append request is invalid",
                        )
                    },
                )?;
                serde_json::to_value(self.append_document(&input)?).map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                })
            }
            ("POST", "/api/knowledge/insert") => {
                let input = serde_json::from_value::<KnowledgeInsertInput>(parsed_body()?)
                    .map_err(|_| {
                        error(
                            "knowledge-invalid-request",
                            "Knowledge insert request is invalid",
                        )
                    })?;
                serde_json::to_value(self.insert_document(&input)?).map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                })
            }
            ("POST", "/api/knowledge/replace") => {
                let input = serde_json::from_value::<KnowledgeWriteInput>(parsed_body()?).map_err(
                    |_| {
                        error(
                            "knowledge-invalid-request",
                            "Knowledge replace request is invalid",
                        )
                    },
                )?;
                serde_json::to_value(self.replace_document(&input)?).map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                })
            }
            ("GET", "/api/knowledge/current") => serde_json::to_value(self.get_current_context()?)
                .map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                }),
            ("POST", "/api/knowledge/context") | ("POST", "/api/knowledge/current/clear") => {
                Err(error(
                    "knowledge-ui-context-only",
                    "Knowledge editor context can only be published by the desktop UI",
                ))
            }
            ("POST", "/api/knowledge/insert-current") => {
                let input = serde_json::from_value::<KnowledgeCurrentInsertInput>(parsed_body()?)
                    .map_err(|_| {
                    error(
                        "knowledge-invalid-request",
                        "Knowledge insert request is invalid",
                    )
                })?;
                serde_json::to_value(self.insert_into_current(&input)?).map_err(|_| {
                    error(
                        "knowledge-response-failed",
                        "Knowledge response could not be encoded",
                    )
                })
            }
            ("GET", "/api/notes/recent") => Ok(json!({
                "notes": self.recent_documents(50)?.iter().map(legacy_note_summary).collect::<Vec<_>>()
            })),
            ("GET", "/api/notes/search") | ("POST", "/api/notes/search") => {
                let query = if method == "GET" {
                    query_parameter(raw_path, "q").unwrap_or_default()
                } else {
                    parsed_body()?
                        .get("query")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                Ok(json!({
                    "notes": self.search_documents(&query, 100)?.iter().map(legacy_note_summary).collect::<Vec<_>>()
                }))
            }
            ("GET", "/api/notes/current") => {
                let context = self.get_current_context()?.ok_or_else(|| {
                    error(
                        "knowledge-current-context-required",
                        "No current Knowledge document is open",
                    )
                })?;
                Ok(json!({
                    "noteId": legacy_note_id(&context.document_ref),
                    "documentRef": context.document_ref,
                    "cursorOffset": context.cursor_offset,
                    "selection": context.selection,
                    "revision": context.expected_revision,
                    "updatedAt": context.updated_at,
                }))
            }
            ("POST", "/api/notes") => {
                let body = parsed_body()?;
                let snapshot = self.create_document(&KnowledgeCreateInput {
                    title: body
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Untitled")
                        .to_string(),
                    parent_relative_path: None,
                    content: body
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                })?;
                Ok(json!({
                    "id": legacy_note_id(&snapshot.summary.document_ref),
                    "title": snapshot.summary.title,
                    "source": "vault",
                    "documentRef": snapshot.summary.document_ref,
                    "revision": snapshot.revision,
                }))
            }
            _ if method == "POST"
                && path.ends_with("/append")
                && path.starts_with("/api/notes/") =>
            {
                let id = path
                    .trim_start_matches("/api/notes/")
                    .trim_end_matches("/append");
                let document_ref = parse_legacy_note_id(id)?;
                let body = parsed_body()?;
                let content = body
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let result = self.append_document(&KnowledgeWriteInput {
                    document_ref: document_ref.clone(),
                    content: content.clone(),
                    expected_revision: body
                        .get("expectedRevision")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })?;
                Ok(json!({
                    "id": legacy_note_id(&document_ref),
                    "appendedChars": content.chars().count(),
                    "documentRef": document_ref,
                    "revision": result.document.revision,
                }))
            }
            _ if method == "POST"
                && path.ends_with("/insert-at-cursor")
                && path.starts_with("/api/notes/") =>
            {
                let id = path
                    .trim_start_matches("/api/notes/")
                    .trim_end_matches("/insert-at-cursor");
                let document_ref = parse_legacy_note_id(id)?;
                let context = self.get_current_context()?.ok_or_else(|| {
                    error(
                        "knowledge-current-context-required",
                        "No current Knowledge document is open",
                    )
                })?;
                if context.document_ref != document_ref {
                    return Err(error(
                        "knowledge-current-context-conflict",
                        "The selected Knowledge document is not current",
                    ));
                }
                let body = parsed_body()?;
                let text = body
                    .get("content")
                    .or_else(|| body.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let result = self.insert_into_current(&KnowledgeCurrentInsertInput {
                    text: text.clone(),
                    append_if_no_cursor: true,
                })?;
                Ok(json!({
                    "noteId": legacy_note_id(&document_ref),
                    "inserted": text.chars().count(),
                    "position": result.position,
                    "documentRef": document_ref,
                    "revision": result.document.revision,
                }))
            }
            _ => Err(error(
                "knowledge-route-not-found",
                "Knowledge route is not available",
            )),
        }
    }

    fn current_vault_path(&self) -> PathBuf {
        self.app_data_dir.join("notes-vault-current.json")
    }

    fn current_vault_unlocked(&self) -> Result<TrustedVault, KnowledgeError> {
        if let Some((registration, expected)) = &self.workspace_scope {
            let vault = trusted_vault(registration)?;
            let guard = filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error)?;
            guard.verify_current_path(&vault.root).map_err(map_filesystem_identity_error)?;
            if knowledge_target_identity(&vault, guard.identity())? != *expected { return Err(knowledge_target_not_current()); }
            return Ok(vault);
        }
        let path = self.current_vault_path();
        if !path.is_file() {
            return Err(error(
                "knowledge-vault-required",
                "Open or create a Vault before using knowledge documents",
            ));
        }
        let bytes = std::fs::read(path).map_err(|_| {
            error(
                "knowledge-vault-registry-unavailable",
                "Current Vault registration is unavailable",
            )
        })?;
        let registration =
            serde_json::from_slice::<KnowledgeVaultRegistration>(&bytes).map_err(|_| {
                error(
                    "knowledge-vault-registry-invalid",
                    "Current Vault registration is invalid",
                )
            })?;
        trusted_vault(&registration)
    }

    fn assert_current_vault_unlocked(
        &self,
        vault_id: &str,
        root: &Path,
    ) -> Result<(), KnowledgeError> {
        let current = self.current_vault_unlocked()?;
        if current.registration.id != vault_id || current.root != root {
            return Err(error(
                "knowledge-vault-changed",
                "Current Vault changed while the document operation was running",
            ));
        }
        Ok(())
    }

    fn capture_expected_target_unlocked(
        &self,
        vault: &TrustedVault,
        expected: Option<&KnowledgeTargetIdentity>,
    ) -> Result<Option<FilesystemDirectoryIdentityGuard>, KnowledgeError> {
        let Some(expected) = expected else {
            return Ok(None);
        };
        let root_guard = filesystem_directory_identity_guard(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        root_guard
            .verify_current_path(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        if knowledge_target_identity(vault, root_guard.identity())? != *expected {
            return Err(knowledge_target_not_current());
        }
        Ok(Some(root_guard))
    }

    fn assert_expected_target_unlocked(
        &self,
        vault: &TrustedVault,
        expected: Option<&KnowledgeTargetIdentity>,
        root_guard: Option<&FilesystemDirectoryIdentityGuard>,
    ) -> Result<(), KnowledgeError> {
        self.assert_current_vault_unlocked(&vault.registration.id, &vault.root)?;
        let Some(expected) = expected else {
            return Ok(());
        };
        let root_guard = root_guard.ok_or_else(knowledge_target_not_current)?;
        root_guard
            .verify_current_path(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        if knowledge_target_identity(vault, root_guard.identity())? != *expected {
            return Err(knowledge_target_not_current());
        }
        Ok(())
    }

    fn snapshot_from_path(
        &self,
        vault: &TrustedVault,
        relative: &Path,
        target: &Path,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        let bytes = std::fs::read(target).map_err(|failure| {
            error(
                "knowledge-read-failed",
                &format!("Knowledge document read failed (phase=content, kind={:?}, os={:?})", failure.kind(), failure.raw_os_error()),
            )
        })?;
        let content_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let content = String::from_utf8(content_bytes.to_vec()).map_err(|_| {
            error(
                "knowledge-encoding-unsupported",
                "Knowledge documents must use UTF-8",
            )
        })?;
        let metadata = std::fs::metadata(target).map_err(|failure| {
            error(
                "knowledge-read-failed",
                &format!("Knowledge document read failed (phase=metadata, kind={:?}, os={:?})", failure.kind(), failure.raw_os_error()),
            )
        })?;
        Ok(KnowledgeDocumentSnapshot {
            summary: summary_from_metadata(vault, relative, &metadata),
            content,
            revision: sha256_hex(&bytes),
        })
    }

    fn mutate_document_for_optional_target(
        &self,
        expected_target: Option<&KnowledgeTargetIdentity>,
        document_ref: &KnowledgeDocumentRef,
        expected_revision: Option<&str>,
        mutation: impl FnOnce(&DecodedDocument) -> Result<String, KnowledgeError>,
        position: &str,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let target_guard = self.capture_expected_target_unlocked(&vault, expected_target)?;
        require_matching_vault(document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&document_ref.relative_path)?;
        let target = safe_existing_file(&vault.root, &relative)?;
        let committed_bytes = self.commit_existing_document(
            &vault,
            &target,
            expected_revision,
            expected_target,
            target_guard.as_ref(),
            mutation,
        )?;
        let mut warning = self
            .index
            .mark_document_dirty(document_ref)
            .err()
            .map(|error| KnowledgeMutationWarning {
                code: error.code.to_string(),
                message: "Document was written, but the Knowledge index update failed".to_string(),
            });
        let document = match self.snapshot_from_path(&vault, &relative, &target) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                if warning.is_none() {
                    warning = Some(KnowledgeMutationWarning {
                        code: error.code.to_string(),
                        message: "Document was written, but follow-up metadata could not be read"
                            .to_string(),
                    });
                }
                snapshot_from_committed_bytes(&vault, &relative, &target, &committed_bytes)?
            }
        };
        Ok(KnowledgeMutationResult {
            document,
            position: position.to_string(),
            index_stale: warning.is_some(),
            index_warning: warning,
        })
    }

    fn recover_registered_vault_if_present(&self) -> Result<(), KnowledgeError> {
        let path = self.current_vault_path();
        if !path.is_file() {
            return Ok(());
        }
        let bytes = std::fs::read(path).map_err(|_| {
            error(
                "knowledge-vault-registry-unavailable",
                "Current Vault registration is unavailable",
            )
        })?;
        let registration =
            serde_json::from_slice::<KnowledgeVaultRegistration>(&bytes).map_err(|_| {
                error(
                    "knowledge-vault-registry-invalid",
                    "Current Vault registration is invalid",
                )
            })?;
        let trusted = trusted_vault(&registration)?;
        recover_pending_document_writes(&trusted.root)
    }

    #[cfg(windows)]
    fn commit_existing_document(
        &self,
        vault: &TrustedVault,
        target: &Path,
        expected_revision: Option<&str>,
        expected_target: Option<&KnowledgeTargetIdentity>,
        target_guard: Option<&FilesystemDirectoryIdentityGuard>,
        mutation: impl FnOnce(&DecodedDocument) -> Result<String, KnowledgeError>,
    ) -> Result<Vec<u8>, KnowledgeError> {
        let mut target_file = open_exclusive_document(target)?;
        let original_bytes = read_exclusive_document(&mut target_file)?;
        let original_revision = sha256_hex(&original_bytes);
        if expected_revision.is_some_and(|expected| expected != original_revision) {
            return Err(error(
                "knowledge-revision-conflict",
                "Knowledge document changed since it was opened",
            ));
        }
        let decoded = decode_document(&original_bytes)?;
        let next_content = mutation(&decoded)?;
        let next_bytes = encode_document(&decoded, &next_content);
        self.assert_expected_target_unlocked(vault, expected_target, target_guard)?;

        let prepared = prepare_document_write(target, &original_bytes, &next_bytes)?;
        #[cfg(test)]
        if self.write_fault_before_commit.swap(false, Ordering::AcqRel) {
            prepared.cleanup_before_commit();
            return Err(error(
                "knowledge-write-failed",
                "Knowledge document write failed before commit",
            ));
        }
        #[cfg(test)]
        if let Some(hook) = self
            .after_final_validation
            .lock()
            .expect("knowledge test hook lock")
            .take()
        {
            hook();
        }
        self.assert_expected_target_unlocked(vault, expected_target, target_guard)?;
        #[cfg(test)]
        let interrupt_after_backup = self
            .interrupt_after_backup_rename
            .swap(false, Ordering::AcqRel);
        #[cfg(not(test))]
        let interrupt_after_backup = false;
        commit_prepared_document(target, target_file, prepared, interrupt_after_backup)?;
        Ok(next_bytes)
    }

    #[cfg(not(windows))]
    fn commit_existing_document(
        &self,
        _vault: &TrustedVault,
        _target: &Path,
        _expected_revision: Option<&str>,
        _expected_target: Option<&KnowledgeTargetIdentity>,
        _target_guard: Option<&FilesystemDirectoryIdentityGuard>,
        _mutation: impl FnOnce(&DecodedDocument) -> Result<String, KnowledgeError>,
    ) -> Result<Vec<u8>, KnowledgeError> {
        Err(error(
            "knowledge-exclusive-commit-unsupported",
            "Knowledge document mutation is unavailable on this platform",
        ))
    }

    fn write_document(
        &self,
        path: &Path,
        bytes: &[u8],
        replace: bool,
    ) -> Result<(), KnowledgeError> {
        #[cfg(test)]
        let fail_before_commit = self.write_fault_before_commit.swap(false, Ordering::AcqRel);
        #[cfg(not(test))]
        let fail_before_commit = false;
        atomic_write_with_fault(path, bytes, replace, fail_before_commit)
    }

    #[cfg(test)]
    fn fail_next_write_before_commit(&self) {
        self.write_fault_before_commit
            .store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn set_after_final_validation_hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self
            .after_final_validation
            .lock()
            .expect("knowledge test hook lock") = Some(Arc::new(hook));
    }

    #[cfg(test)]
    fn interrupt_next_write_after_backup_rename(&self) {
        self.interrupt_after_backup_rename
            .store(true, Ordering::Release);
    }
}

fn require_ordered_current_context(
    state: &KnowledgeCurrentContextState,
    session_id: &str,
    session_epoch: u64,
    generation: u64,
) -> Result<(), KnowledgeError> {
    if state.active_session_id.as_deref() != Some(session_id)
        || state.active_session_epoch != session_epoch
        || generation <= state.generation
    {
        return Err(error(
            "knowledge-context-stale",
            "Knowledge editor context update is stale",
        ));
    }
    Ok(())
}

fn knowledge_http_status(code: &str) -> u16 {
    match code {
        "knowledge-vault-required" | "knowledge-not-found" => 404,
        "knowledge-revision-conflict"
        | "knowledge-offset-conflict"
        | "knowledge-current-context-conflict"
        | "knowledge-context-stale"
        | "knowledge-context-owner-conflict"
        | "knowledge-vault-changed"
        | "knowledge-name-conflict" => 409,
        "knowledge-ui-context-only" => 403,
        "knowledge-write-failed" | "knowledge-read-failed" | "knowledge-list-failed" => 500,
        _ => 400,
    }
}

fn legacy_note_summary(summary: &KnowledgeDocumentSummary) -> Value {
    json!({
        "id": legacy_note_id(&summary.document_ref),
        "title": summary.title,
        "updatedAt": summary.modified_at,
        "relativePath": summary.relative_path,
        "documentRef": summary.document_ref,
    })
}

fn legacy_note_id(document_ref: &KnowledgeDocumentRef) -> String {
    let payload = serde_json::to_vec(document_ref).unwrap_or_default();
    format!("kdoc-{}", hex_encode(&payload))
}

fn parse_legacy_note_id(value: &str) -> Result<KnowledgeDocumentRef, KnowledgeError> {
    let encoded = value.strip_prefix("kdoc-").ok_or_else(|| {
        error(
            "legacy-db-note-retired",
            "Legacy database note identities are retired",
        )
    })?;
    let bytes = hex_decode(encoded)?;
    let document_ref = serde_json::from_slice::<KnowledgeDocumentRef>(&bytes).map_err(|_| {
        error(
            "knowledge-invalid-document-ref",
            "Knowledge document reference is invalid",
        )
    })?;
    let canonical_path = safe_markdown_relative_path(&document_ref.relative_path)
        .ok()
        .and_then(|path| {
            path.iter()
                .map(OsStr::to_str)
                .collect::<Option<Vec<_>>>()
                .map(|segments| segments.join("/"))
        });
    if document_ref.vault_id.trim().is_empty()
        || document_ref.vault_id.trim() != document_ref.vault_id
        || canonical_path.as_deref() != Some(document_ref.relative_path.as_str())
        || legacy_note_id(&document_ref) != value
    {
        return Err(error(
            "knowledge-invalid-document-ref",
            "Knowledge document reference is invalid",
        ));
    }
    Ok(document_ref)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(value: &str) -> Result<Vec<u8>, KnowledgeError> {
    if value.is_empty()
        || value.len() % 2 != 0
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(error(
            "knowledge-invalid-document-ref",
            "Knowledge document reference is invalid",
        ));
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| {
                error(
                    "knowledge-invalid-document-ref",
                    "Knowledge document reference is invalid",
                )
            })
        })
        .collect()
}

fn query_parameter(path: &str, key: &str) -> Option<String> {
    path.split_once('?')?.1.split('&').find_map(|entry| {
        let (name, value) = entry.split_once('=').unwrap_or((entry, ""));
        (name == key).then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let pair = &value[index + 1..index + 3];
            if let Ok(decoded) = u8::from_str_radix(pair, 16) {
                output.push(decoded);
                index += 3;
                continue;
            }
        }
        output.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

struct DecodedDocument {
    content: String,
    has_bom: bool,
    line_ending: &'static str,
    final_newline: bool,
}

fn decode_document(bytes: &[u8]) -> Result<DecodedDocument, KnowledgeError> {
    let has_bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let content_bytes = if has_bom { &bytes[3..] } else { bytes };
    let content = String::from_utf8(content_bytes.to_vec()).map_err(|_| {
        error(
            "knowledge-encoding-unsupported",
            "Knowledge documents must use UTF-8",
        )
    })?;
    let line_ending = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let final_newline = content.ends_with('\n');
    Ok(DecodedDocument {
        content,
        has_bom,
        line_ending,
        final_newline,
    })
}

fn normalized_line_endings(value: &str, line_ending: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', line_ending)
}

fn trim_final_line_endings<'a>(value: &'a str, line_ending: &str) -> &'a str {
    let mut trimmed = value;
    while trimmed.ends_with(line_ending) {
        trimmed = &trimmed[..trimmed.len() - line_ending.len()];
    }
    trimmed
}

fn append_text(document: &DecodedDocument, value: &str) -> Result<String, KnowledgeError> {
    if value.is_empty() {
        return Err(error(
            "knowledge-content-required",
            "Content is required for append",
        ));
    }
    let normalized = normalized_line_endings(value, document.line_ending);
    let old = trim_final_line_endings(&document.content, document.line_ending);
    let addition = trim_final_line_endings(&normalized, document.line_ending);
    let mut next = if old.is_empty() {
        addition.to_string()
    } else {
        format!("{old}{0}{0}{addition}", document.line_ending)
    };
    if document.final_newline {
        next.push_str(document.line_ending);
    }
    Ok(next)
}

fn insert_text(
    document: &DecodedDocument,
    offset: usize,
    value: &str,
) -> Result<String, KnowledgeError> {
    if value.is_empty() {
        return Err(error(
            "knowledge-content-required",
            "Content is required for insert",
        ));
    }
    let byte_offset = byte_offset_for_utf16(&document.content, offset).ok_or_else(|| {
        error(
            "knowledge-offset-conflict",
            "Knowledge document cursor offset is stale",
        )
    })?;
    let normalized = normalized_line_endings(value, document.line_ending);
    let mut next = String::with_capacity(document.content.len() + normalized.len());
    next.push_str(&document.content[..byte_offset]);
    next.push_str(&normalized);
    next.push_str(&document.content[byte_offset..]);
    Ok(next)
}

fn byte_offset_for_utf16(content: &str, offset: usize) -> Option<usize> {
    if offset == 0 {
        return Some(0);
    }
    let mut utf16_offset = 0;
    for (byte_offset, character) in content.char_indices() {
        if utf16_offset == offset {
            return Some(byte_offset);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > offset {
            return None;
        }
    }
    (utf16_offset == offset).then_some(content.len())
}

fn replace_text(document: &DecodedDocument, value: &str) -> Result<String, KnowledgeError> {
    // A full replacement owns the complete body, including its final blank
    // lines. Reusing the previous EOF shape silently discards user input and
    // makes the saved revision acknowledge a different editor document.
    // Preserve the existing file's line-ending style, not its newline count.
    Ok(normalized_line_endings(value, document.line_ending))
}

fn encode_document(document: &DecodedDocument, content: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(content.len() + if document.has_bom { 3 } else { 0 });
    if document.has_bom {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(content.as_bytes());
    bytes
}

fn normalize_document_tags(tags: &[String]) -> Result<Vec<String>, KnowledgeError> {
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    for value in tags {
        let tag = value.trim().trim_start_matches('#').trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > 64 || tag.contains(['\r', '\n', '\0']) || tag.starts_with('-') {
            return Err(error(
                "knowledge-tag-invalid",
                "Knowledge tag contains unsupported characters",
            ));
        }
        let key = tag.to_lowercase();
        if seen.insert(key) {
            normalized.push(tag.to_string());
        }
    }
    Ok(normalized)
}

fn yaml_tag_value(tag: &str) -> String {
    let simple = tag
        .chars()
        .all(|character| character.is_alphanumeric() || matches!(character, '_' | '-' | '.' | '/'))
        && !matches!(
            tag.to_ascii_lowercase().as_str(),
            "true" | "false" | "null" | "yes" | "no" | "on" | "off"
        );
    if simple {
        tag.to_string()
    } else {
        serde_json::to_string(tag).unwrap_or_else(|_| "\"\"".to_string())
    }
}

fn rendered_tags(tags: &[String]) -> Vec<String> {
    if tags.is_empty() {
        vec!["tags: []".to_string()]
    } else {
        std::iter::once("tags:".to_string())
            .chain(
                tags.iter()
                    .map(|tag| format!("  - {}", yaml_tag_value(tag))),
            )
            .collect()
    }
}

fn top_level_frontmatter_key(line: &str) -> Option<(&str, &str)> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    let (key, value) = line.split_once(':')?;
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return None;
    }
    Some((key, value))
}

fn replace_frontmatter_tags(
    document: &DecodedDocument,
    tags: &[String],
) -> Result<String, KnowledgeError> {
    let normalized = document.content.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines = normalized
        .split('\n')
        .map(str::to_string)
        .collect::<Vec<_>>();
    let had_final_empty = lines.last().is_some_and(String::is_empty);
    if had_final_empty {
        lines.pop();
    }
    let tags_block = rendered_tags(tags);

    let next = if lines.first().is_some_and(|line| line.trim() == "---") {
        let closing = lines
            .iter()
            .enumerate()
            .skip(1)
            .find_map(|(index, line)| (line.trim() == "---").then_some(index))
            .ok_or_else(|| {
                error(
                    "knowledge-frontmatter-ambiguous",
                    "Knowledge frontmatter is not closed",
                )
            })?;
        let mut tag_fields = Vec::new();
        for (index, line) in lines[1..closing].iter().enumerate() {
            if let Some((key, value)) = top_level_frontmatter_key(line) {
                if matches!(key.to_ascii_lowercase().as_str(), "tag" | "tags") {
                    tag_fields.push((index + 1, value.trim().is_empty()));
                }
            }
        }
        if tag_fields.len() > 1 {
            return Err(error(
                "knowledge-frontmatter-ambiguous",
                "Knowledge frontmatter contains duplicate tag fields",
            ));
        }
        if let Some((start, list_form)) = tag_fields.first().copied() {
            let mut end = start + 1;
            if list_form {
                while end < closing {
                    let line = &lines[end];
                    if line.starts_with(char::is_whitespace) && line.trim_start().starts_with('-') {
                        end += 1;
                        continue;
                    }
                    if line.starts_with(char::is_whitespace) && !line.trim().is_empty() {
                        return Err(error(
                            "knowledge-frontmatter-ambiguous",
                            "Knowledge tag list contains an unsupported nested value",
                        ));
                    }
                    break;
                }
            } else {
                let value = top_level_frontmatter_key(&lines[start])
                    .map(|(_, value)| value.trim())
                    .unwrap_or("");
                let malformed_inline = value.starts_with('[') && !value.ends_with(']');
                let malformed_quote = (value.starts_with('"') && !value.ends_with('"'))
                    || (value.starts_with('\'') && !value.ends_with('\''));
                if value.starts_with('|')
                    || value.starts_with('>')
                    || value.starts_with('{')
                    || malformed_inline
                    || malformed_quote
                {
                    return Err(error(
                        "knowledge-frontmatter-ambiguous",
                        "Knowledge tag field uses an unsupported YAML shape",
                    ));
                }
            }
            lines.splice(start..end, tags_block);
            lines
        } else if tags.is_empty() {
            lines
        } else {
            lines.splice(closing..closing, tags_block);
            lines
        }
    } else if tags.is_empty() {
        lines
    } else {
        let mut output = vec!["---".to_string()];
        output.extend(tags_block);
        output.push("---".to_string());
        output.push(String::new());
        output.extend(lines);
        output
    };

    let mut result = next.join(document.line_ending);
    if document.final_newline || had_final_empty {
        result.push_str(document.line_ending);
    }
    Ok(result)
}

fn default_true() -> bool {
    true
}

#[derive(Clone)]
struct TrustedVault {
    registration: KnowledgeVaultRegistration,
    root: PathBuf,
}

fn knowledge_target_identity(
    vault: &TrustedVault,
    root_object_identity: &str,
) -> Result<KnowledgeTargetIdentity, KnowledgeError> {
    let label = vault.registration.name.trim();
    if label.is_empty() || label.as_bytes().len() > 120 || label.chars().any(char::is_control) {
        return Err(error(
            "knowledge-vault-registry-invalid",
            "Vault registration label is invalid",
        ));
    }
    let identity_digest = format!(
        "{:x}",
        Sha256::digest(
            [
                b"luckyray-project-knowledge-target-v1\0".as_slice(),
                vault.registration.id.as_bytes(),
                b"\0",
                vault.root.to_string_lossy().as_bytes(),
                b"\0",
                root_object_identity.as_bytes(),
                b"\0",
                vault.registration.created_at.as_bytes(),
                b"\0",
                vault.registration.mode.as_bytes(),
                b"\0",
                &vault.registration.schema_version.to_le_bytes(),
            ]
            .concat(),
        )
    );
    Ok(KnowledgeTargetIdentity {
        target_id: vault.registration.id.clone(),
        identity_digest,
        label: label.to_owned(),
    })
}

fn map_filesystem_identity_error(error_value: WorkspaceError) -> KnowledgeError {
    match error_value.code {
        "workspace-reparse-denied" | "workspace-grant-reparse-denied" => error(
            "knowledge-path-reparse-forbidden",
            "Knowledge Vault root cannot use a link or reparse point",
        ),
        _ => error(
            "knowledge-vault-unavailable",
            "Knowledge Vault root identity is unavailable",
        ),
    }
}

fn knowledge_target_not_current() -> KnowledgeError {
    error(
        "knowledge-target-not-current",
        "Knowledge authorization no longer targets the current Vault",
    )
}

fn error(code: &'static str, message: impl Into<String>) -> KnowledgeError {
    KnowledgeError {
        code,
        message: message.into(),
    }
}

fn trusted_vault(vault: &KnowledgeVaultRegistration) -> Result<TrustedVault, KnowledgeError> {
    if vault.id.trim().is_empty()
        || vault.mode != "vault-bound"
        || vault.schema_version != VAULT_SCHEMA_VERSION
    {
        return Err(error(
            "knowledge-vault-registry-invalid",
            "Vault registration is invalid",
        ));
    }
    let configured_root = PathBuf::from(vault.root_path.trim());
    if !configured_root.is_absolute() {
        return Err(error(
            "knowledge-vault-registry-invalid",
            "Vault registration root is invalid",
        ));
    }
    if has_reparse_point(&configured_root)? {
        return Err(error(
            "knowledge-vault-unavailable",
            "The registered Vault root is unsafe",
        ));
    }
    let root = configured_root.canonicalize().map_err(|_| {
        error(
            "knowledge-vault-unavailable",
            "The registered Vault is unavailable",
        )
    })?;
    if !root.is_dir() || has_reparse_point(&root)? {
        return Err(error(
            "knowledge-vault-unavailable",
            "The registered Vault root is unsafe",
        ));
    }
    let metadata_path = root.join(".luckyray").join("vault.json");
    if has_reparse_point(&root.join(".luckyray"))? || has_reparse_point(&metadata_path)? {
        return Err(error(
            "knowledge-vault-registry-invalid",
            "Vault metadata path is unsafe",
        ));
    }
    let metadata_bytes = std::fs::read(&metadata_path).map_err(|_| {
        error(
            "knowledge-vault-registry-invalid",
            "Vault metadata is unavailable",
        )
    })?;
    let persisted =
        serde_json::from_slice::<KnowledgeVaultRegistration>(&metadata_bytes).map_err(|_| {
            error(
                "knowledge-vault-registry-invalid",
                "Vault metadata is invalid",
            )
        })?;
    let persisted_root = PathBuf::from(persisted.root_path.trim())
        .canonicalize()
        .map_err(|_| {
            error(
                "knowledge-vault-registry-invalid",
                "Vault metadata root is invalid",
            )
        })?;
    if persisted.id != vault.id
        || persisted_root != root
        || persisted.mode != "vault-bound"
        || persisted.schema_version != VAULT_SCHEMA_VERSION
    {
        return Err(error(
            "knowledge-vault-registry-invalid",
            "Vault metadata does not match the current registration",
        ));
    }
    let mut registration = vault.clone();
    // The Vault metadata is the preference authority; the app registration is a location cache.
    registration.link_update_policy = persisted.link_update_policy;
    Ok(TrustedVault {
        registration,
        root,
    })
}

fn safe_relative_directory(value: Option<&str>) -> Result<PathBuf, KnowledgeError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => safe_relative_path(value, false),
        None => Ok(PathBuf::new()),
    }
}

pub(crate) fn safe_markdown_relative_path(value: &str) -> Result<PathBuf, KnowledgeError> {
    let relative = safe_relative_path(value, false)?;
    let is_markdown = relative
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
    if !is_markdown {
        return Err(error(
            "knowledge-path-not-markdown",
            "Knowledge documents must use the .md extension",
        ));
    }
    Ok(relative)
}

fn safe_relative_path(value: &str, allow_empty: bool) -> Result<PathBuf, KnowledgeError> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return if allow_empty {
            Ok(PathBuf::new())
        } else {
            Err(error(
                "knowledge-invalid-document-ref",
                "Knowledge document path is empty",
            ))
        };
    }
    if normalized.starts_with('/')
        || normalized.starts_with('~')
        || normalized.contains(':')
        || normalized.contains('\0')
    {
        return Err(error(
            "knowledge-path-outside-vault",
            "Knowledge document path must stay inside the current Vault",
        ));
    }
    let mut relative = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.eq_ignore_ascii_case(".luckyray")
        {
            return Err(error(
                "knowledge-path-outside-vault",
                "Knowledge document path contains an unsafe segment",
            ));
        }
        relative.push(segment);
    }
    Ok(relative)
}

fn safe_markdown_name(value: &str) -> Result<String, KnowledgeError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.contains('\0')
        || trimmed.eq_ignore_ascii_case(".luckyray")
    {
        return Err(error(
            "knowledge-invalid-title",
            "Knowledge document title is invalid",
        ));
    }
    let name = if trimmed.to_ascii_lowercase().ends_with(".md") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.md")
    };
    let _ = safe_markdown_relative_path(&name)?;
    Ok(name)
}

fn safe_existing_directory(root: &Path, relative: &Path) -> Result<PathBuf, KnowledgeError> {
    let target = root.join(relative);
    assert_safe_components(root, relative)?;
    let canonical = target.canonicalize().map_err(|_| {
        error(
            "knowledge-parent-missing",
            "Knowledge document parent folder does not exist",
        )
    })?;
    if !canonical.is_dir() || !canonical.starts_with(root) {
        return Err(error(
            "knowledge-path-outside-vault",
            "Knowledge document parent folder is unsafe",
        ));
    }
    Ok(canonical)
}

fn safe_existing_file(root: &Path, relative: &Path) -> Result<PathBuf, KnowledgeError> {
    assert_safe_components(root, relative)?;
    let target = root.join(relative);
    let canonical = target
        .canonicalize()
        .map_err(|_| error("knowledge-not-found", "Knowledge document does not exist"))?;
    if !canonical.is_file() || !canonical.starts_with(root) {
        return Err(error(
            "knowledge-path-outside-vault",
            "Knowledge document path is unsafe",
        ));
    }
    Ok(canonical)
}

fn assert_safe_components(root: &Path, relative: &Path) -> Result<(), KnowledgeError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        if !current.exists() {
            continue;
        }
        if has_reparse_point(&current)? {
            return Err(error(
                "knowledge-path-reparse-forbidden",
                "Knowledge document path contains a link or reparse point",
            ));
        }
    }
    Ok(())
}

fn has_reparse_point(path: &Path) -> Result<bool, KnowledgeError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        error(
            "knowledge-path-unavailable",
            "Knowledge document path could not be inspected",
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0);
    }
    #[cfg(not(windows))]
    Ok(false)
}

fn summary_from_metadata(
    vault: &TrustedVault,
    relative: &Path,
    metadata: &std::fs::Metadata,
) -> KnowledgeDocumentSummary {
    let relative_path = relative_path_string(relative);
    let title = relative
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("Untitled")
        .to_string();
    let modified_at = metadata.modified().ok().map(|time| {
        let date_time: chrono::DateTime<chrono::Utc> = time.into();
        date_time.to_rfc3339()
    });
    KnowledgeDocumentSummary {
        document_ref: KnowledgeDocumentRef {
            vault_id: vault.registration.id.clone(),
            relative_path: relative_path.clone(),
        },
        title,
        relative_path,
        modified_at,
        size: metadata.len(),
    }
}

fn snapshot_from_committed_bytes(
    vault: &TrustedVault,
    relative: &Path,
    target: &Path,
    bytes: &[u8],
) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
    let content_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let content = String::from_utf8(content_bytes.to_vec()).map_err(|_| {
        error(
            "knowledge-encoding-unsupported",
            "Knowledge documents must use UTF-8",
        )
    })?;
    let summary = match std::fs::metadata(target) {
        Ok(metadata) => summary_from_metadata(vault, relative, &metadata),
        Err(_) => {
            let relative_path = relative_path_string(relative);
            KnowledgeDocumentSummary {
                document_ref: KnowledgeDocumentRef {
                    vault_id: vault.registration.id.clone(),
                    relative_path: relative_path.clone(),
                },
                title: relative
                    .file_stem()
                    .and_then(OsStr::to_str)
                    .unwrap_or("Untitled")
                    .to_string(),
                relative_path,
                modified_at: None,
                size: bytes.len() as u64,
            }
        }
    };
    Ok(KnowledgeDocumentSnapshot {
        summary,
        content,
        revision: sha256_hex(bytes),
    })
}

fn require_matching_vault(
    document_ref: &KnowledgeDocumentRef,
    vault: &KnowledgeVaultRegistration,
) -> Result<(), KnowledgeError> {
    if document_ref.vault_id != vault.id {
        return Err(error(
            "knowledge-vault-mismatch",
            "Knowledge document belongs to a different Vault",
        ));
    }
    Ok(())
}

fn relative_path_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(windows)]
struct PreparedDocumentWrite {
    temp: PathBuf,
    backup: PathBuf,
    journal: PathBuf,
    original_revision: String,
}

#[cfg(windows)]
impl PreparedDocumentWrite {
    fn cleanup_before_commit(&self) {
        let _ = remove_owned_transaction_file(&self.temp);
        let _ = remove_owned_transaction_file(&self.journal);
    }
}

#[cfg(windows)]
fn open_exclusive_document(path: &Path) -> Result<File, KnowledgeError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_WRITE_THROUGH: u32 = 0x8000_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE_ACCESS)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH)
        .open(path)
        .map_err(|_| {
            error(
                "knowledge-revision-conflict",
                "Knowledge document is being edited by another process",
            )
        })?;
    let metadata = file.metadata().map_err(|_| {
        error(
            "knowledge-write-failed",
            "Knowledge document metadata could not be verified",
        )
    })?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(error(
            "knowledge-path-reparse-forbidden",
            "Knowledge document path cannot use a reparse point",
        ));
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_exclusive_document(_path: &Path) -> Result<File, KnowledgeError> {
    Err(error(
        "knowledge-exclusive-write-unsupported",
        "Knowledge document move and delete are unavailable on this platform",
    ))
}

#[cfg(windows)]
fn read_exclusive_document(file: &mut File) -> Result<Vec<u8>, KnowledgeError> {
    file.seek(SeekFrom::Start(0))
        .and_then(|_| {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map(|_| bytes)
        })
        .map_err(|_| {
            error(
                "knowledge-read-failed",
                "Knowledge document could not be read",
            )
        })
}

#[cfg(not(windows))]
fn read_exclusive_document(_file: &mut File) -> Result<Vec<u8>, KnowledgeError> {
    Err(error(
        "knowledge-exclusive-write-unsupported",
        "Knowledge document move and delete are unavailable on this platform",
    ))
}

#[cfg(windows)]
fn prepare_document_write(
    target: &Path,
    original_bytes: &[u8],
    next_bytes: &[u8],
) -> Result<PreparedDocumentWrite, KnowledgeError> {
    let parent = target.parent().ok_or_else(|| {
        error(
            "knowledge-write-failed",
            "Knowledge document target has no parent folder",
        )
    })?;
    let target_file_name = target
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| {
            error(
                "knowledge-write-failed",
                "Knowledge document target is invalid",
            )
        })?
        .to_string();
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let temp_file_name = format!(".lrk-{nonce}.tmp");
    let backup_file_name = format!(".lrk-{nonce}.backup");
    let journal_file_name = format!(".lrk-{nonce}.journal");
    let temp = parent.join(&temp_file_name);
    let backup = parent.join(&backup_file_name);
    let journal = parent.join(&journal_file_name);
    write_new_synced(&temp, next_bytes)?;
    let record = KnowledgeWriteJournal {
        version: WRITE_JOURNAL_VERSION,
        nonce,
        target_file_name,
        backup_file_name,
        temp_file_name,
        original_revision: sha256_hex(original_bytes),
        next_revision: sha256_hex(next_bytes),
    };
    let journal_bytes = serde_json::to_vec(&record).map_err(|_| {
        error(
            "knowledge-write-failed",
            "Knowledge write journal could not be encoded",
        )
    })?;
    if let Err(failure) = write_new_synced(&journal, &journal_bytes) {
        let _ = remove_owned_transaction_file(&temp);
        return Err(failure);
    }
    Ok(PreparedDocumentWrite {
        temp,
        backup,
        journal,
        original_revision: record.original_revision,
    })
}

#[cfg(windows)]
fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), KnowledgeError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| {
            error(
                "knowledge-write-failed",
                "Knowledge transaction file could not be created",
            )
        })?;
    file.write_all(bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|_| {
            error(
                "knowledge-write-failed",
                "Knowledge transaction file could not be flushed",
            )
        })
}

#[cfg(windows)]
fn commit_prepared_document(
    target: &Path,
    target_file: File,
    prepared: PreparedDocumentWrite,
    interrupt_after_backup: bool,
) -> Result<(), KnowledgeError> {
    if let Err(failure) = rename_open_file(&target_file, &prepared.backup) {
        prepared.cleanup_before_commit();
        return Err(failure);
    }
    drop(target_file);
    if interrupt_after_backup {
        return Err(error(
            "knowledge-write-interrupted",
            "Knowledge document write was interrupted and will be recovered",
        ));
    }

    if let Err(failure) = move_file_no_replace(&prepared.temp, target) {
        if !target.exists() && move_file_no_replace(&prepared.backup, target).is_ok() {
            let _ = remove_owned_transaction_file(&prepared.temp);
            let _ = remove_owned_transaction_file(&prepared.journal);
            return Err(failure);
        }
        return Err(error(
            "knowledge-revision-conflict",
            "Knowledge document path changed during commit; recovery is pending",
        ));
    }

    // Once the no-clobber move succeeds, the committed target is authoritative.
    // Cleanup failures leave the durable journal for startup recovery instead of
    // returning an error that would imply the document write was rolled back.
    if recovery_file_has_revision(&prepared.backup, &prepared.original_revision).unwrap_or(false)
        && remove_owned_transaction_file(&prepared.backup).is_ok()
    {
        let _ = remove_owned_transaction_file(&prepared.journal);
    }
    Ok(())
}

#[cfg(windows)]
fn recover_pending_document_writes(root: &Path) -> Result<(), KnowledgeError> {
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|_| {
            error(
                "knowledge-recovery-required",
                "Knowledge recovery directory could not be inspected",
            )
        })? {
            let entry = entry.map_err(|_| {
                error(
                    "knowledge-recovery-required",
                    "Knowledge recovery entry could not be inspected",
                )
            })?;
            let metadata = match std::fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    return Err(error(
                        "knowledge-recovery-required",
                        "Knowledge recovery entry could not be verified",
                    ))
                }
            };
            if metadata.is_dir() {
                if !metadata.file_type().is_symlink() {
                    directories.push(entry.path());
                }
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".lrk-") && name.ends_with(".journal") {
                recover_document_write(&entry.path())?;
            }
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn recover_pending_document_writes(_root: &Path) -> Result<(), KnowledgeError> {
    Ok(())
}

#[cfg(windows)]
fn recover_document_write(journal_path: &Path) -> Result<(), KnowledgeError> {
    let parent = journal_path.parent().ok_or_else(recovery_error)?;
    let journal_bytes = read_recovery_file(journal_path)?.ok_or_else(recovery_error)?;
    let record: KnowledgeWriteJournal =
        serde_json::from_slice(&journal_bytes).map_err(|_| recovery_error())?;
    validate_write_journal(journal_path, &record)?;
    let target = parent.join(&record.target_file_name);
    let backup = parent.join(&record.backup_file_name);
    let temp = parent.join(&record.temp_file_name);
    let target_bytes = read_recovery_file(&target)?;
    let backup_bytes = read_recovery_file(&backup)?;
    let temp_bytes = read_recovery_file(&temp)?;

    if backup_bytes
        .as_ref()
        .is_some_and(|bytes| sha256_hex(bytes) != record.original_revision)
        || temp_bytes
            .as_ref()
            .is_some_and(|bytes| sha256_hex(bytes) != record.next_revision)
    {
        return Err(recovery_error());
    }

    match target_bytes.as_ref().map(|bytes| sha256_hex(bytes)) {
        Some(revision)
            if revision == record.original_revision || revision == record.next_revision =>
        {
            if backup_bytes.is_some() {
                remove_owned_transaction_file(&backup)?;
            }
            if temp_bytes.is_some() {
                remove_owned_transaction_file(&temp)?;
            }
            remove_owned_transaction_file(journal_path)
        }
        None if backup_bytes
            .as_ref()
            .is_some_and(|bytes| sha256_hex(bytes) == record.original_revision) =>
        {
            move_file_no_replace(&backup, &target)?;
            if temp_bytes.is_some() {
                remove_owned_transaction_file(&temp)?;
            }
            remove_owned_transaction_file(journal_path)
        }
        _ => Err(recovery_error()),
    }
}

#[cfg(windows)]
fn validate_write_journal(
    journal_path: &Path,
    record: &KnowledgeWriteJournal,
) -> Result<(), KnowledgeError> {
    let safe_nonce = !record.nonce.is_empty()
        && record
            .nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-');
    let journal_name = journal_path.file_name().and_then(OsStr::to_str);
    let target_is_single_markdown = Path::new(&record.target_file_name).components().count() == 1
        && record
            .target_file_name
            .to_ascii_lowercase()
            .ends_with(".md");
    let revision_is_valid =
        |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if record.version != WRITE_JOURNAL_VERSION
        || !safe_nonce
        || journal_name != Some(format!(".lrk-{}.journal", record.nonce).as_str())
        || record.backup_file_name != format!(".lrk-{}.backup", record.nonce)
        || record.temp_file_name != format!(".lrk-{}.tmp", record.nonce)
        || !target_is_single_markdown
        || !revision_is_valid(&record.original_revision)
        || !revision_is_valid(&record.next_revision)
    {
        return Err(recovery_error());
    }
    Ok(())
}

#[cfg(windows)]
fn read_recovery_file(path: &Path) -> Result<Option<Vec<u8>>, KnowledgeError> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(recovery_error()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(recovery_error());
    }
    std::fs::read(path).map(Some).map_err(|_| recovery_error())
}

#[cfg(windows)]
fn recovery_file_has_revision(path: &Path, revision: &str) -> Result<bool, KnowledgeError> {
    Ok(read_recovery_file(path)?.is_some_and(|bytes| sha256_hex(&bytes) == revision))
}

#[cfg(windows)]
fn remove_owned_transaction_file(path: &Path) -> Result<(), KnowledgeError> {
    if read_recovery_file(path)?.is_none() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|_| recovery_error())
}

#[cfg(windows)]
fn recovery_error() -> KnowledgeError {
    error(
        "knowledge-recovery-required",
        "Knowledge document recovery requires attention",
    )
}

#[cfg(windows)]
fn rename_open_file(file: &File, destination: &Path) -> Result<(), KnowledgeError> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;

    const FILE_RENAME_INFO_CLASS: i32 = 3;
    #[repr(C)]
    struct FileRenameInfo {
        replace_if_exists: u32,
        root_directory: *mut std::ffi::c_void,
        file_name_length: u32,
        file_name: [u16; 32768],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileInformationByHandle(
            file: *mut std::ffi::c_void,
            information_class: i32,
            information: *const std::ffi::c_void,
            buffer_size: u32,
        ) -> i32;
    }

    let wide = destination.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.is_empty() || wide.len() > 32768 {
        return Err(error(
            "knowledge-write-failed",
            "Knowledge document backup path is invalid",
        ));
    }
    let mut information = Box::new(FileRenameInfo {
        replace_if_exists: 0,
        root_directory: std::ptr::null_mut(),
        file_name_length: (wide.len() * 2) as u32,
        file_name: [0; 32768],
    });
    information.file_name[..wide.len()].copy_from_slice(&wide);
    let size = std::mem::offset_of!(FileRenameInfo, file_name) + wide.len() * 2;
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FILE_RENAME_INFO_CLASS,
            (&*information as *const FileRenameInfo).cast(),
            size as u32,
        )
    };
    if result == 0 {
        return Err(error(
            "knowledge-write-failed",
            "Knowledge document could not enter the commit journal",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn rename_open_file(_file: &File, _destination: &Path) -> Result<(), KnowledgeError> {
    Err(error(
        "knowledge-exclusive-write-unsupported",
        "Knowledge document move is unavailable on this platform",
    ))
}

#[cfg(windows)]
fn delete_open_file(file: &File) -> Result<(), KnowledgeError> {
    use std::os::windows::io::AsRawHandle;

    const FILE_DISPOSITION_INFO_CLASS: i32 = 4;
    #[repr(C)]
    struct FileDispositionInfo {
        delete_file: u8,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileInformationByHandle(
            file: *mut std::ffi::c_void,
            information_class: i32,
            information: *const std::ffi::c_void,
            buffer_size: u32,
        ) -> i32;
    }

    let information = FileDispositionInfo { delete_file: 1 };
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FILE_DISPOSITION_INFO_CLASS,
            (&information as *const FileDispositionInfo).cast(),
            std::mem::size_of::<FileDispositionInfo>() as u32,
        )
    };
    if result == 0 {
        return Err(error(
            "knowledge-delete-failed",
            "Knowledge document could not be deleted",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn delete_open_file(_file: &File) -> Result<(), KnowledgeError> {
    Err(error(
        "knowledge-exclusive-write-unsupported",
        "Knowledge document deletion is unavailable on this platform",
    ))
}

#[cfg(windows)]
fn move_file_no_replace(source: &Path, destination: &Path) -> Result<(), KnowledgeError> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(error(
            "knowledge-write-failed",
            "Knowledge document could not be committed without overwriting another writer",
        ));
    }
    Ok(())
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8], replace: bool) -> Result<(), KnowledgeError> {
    atomic_write_with_fault(path, bytes, replace, false)
}

fn atomic_write_with_fault(
    path: &Path,
    bytes: &[u8],
    replace: bool,
    fail_before_commit: bool,
) -> Result<(), KnowledgeError> {
    let parent = path.parent().ok_or_else(|| {
        error(
            "knowledge-write-failed",
            "Knowledge document target has no parent folder",
        )
    })?;
    let file_name = path.file_name().and_then(OsStr::to_str).ok_or_else(|| {
        error(
            "knowledge-write-failed",
            "Knowledge document target is invalid",
        )
    })?;
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let temp = parent.join(format!(".{file_name}.{nonce}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| {
                error(
                    "knowledge-write-failed",
                    "Knowledge document temp file could not be created",
                )
            })?;
        file.write_all(bytes)
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                error(
                    "knowledge-write-failed",
                    "Knowledge document temp file could not be flushed",
                )
            })?;
        drop(file);
        if fail_before_commit {
            return Err(error(
                "knowledge-write-failed",
                "Knowledge document write failed before commit",
            ));
        }
        if replace && path.exists() {
            replace_file(path, &temp)
        } else {
            std::fs::rename(&temp, path).map_err(|_| {
                error(
                    "knowledge-write-failed",
                    "Knowledge document could not be committed",
                )
            })
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
fn replace_file(target: &Path, replacement: &Path) -> Result<(), KnowledgeError> {
    use std::os::windows::ffi::OsStrExt;
    const REPLACEFILE_WRITE_THROUGH: u32 = 0x1;
    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let replacement_wide = replacement
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            replacement_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        return Err(error(
            "knowledge-write-failed",
            "Knowledge document could not be atomically replaced",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(target: &Path, replacement: &Path) -> Result<(), KnowledgeError> {
    std::fs::rename(replacement, target).map_err(|_| {
        error(
            "knowledge-write-failed",
            "Knowledge document could not be atomically replaced",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "luckyray-knowledge-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    pub(super) fn registered_service(label: &str) -> (KnowledgeService, PathBuf, KnowledgeVaultRegistration) {
        let app_data = temp_path(&format!("{label}-app"));
        let root = temp_path(&format!("{label}-vault"));
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: format!("vault-{label}"),
            name: label.to_string(),
            root_path: root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: VAULT_SCHEMA_VERSION,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let service = KnowledgeService::initialize(&app_data).unwrap();
        service.register_current_vault(&vault).unwrap();
        (service, root, vault)
    }

    #[test]
    fn agent_write_preview_revisions_match_create_append_and_set_tags_commits() {
        let (service, _root, vault) = registered_service("agent-write-preview-revisions");
        let document_ref = KnowledgeDocumentRef {
            vault_id: vault.id.clone(),
            relative_path: "Research.md".to_string(),
        };

        let create_content = "# Research\n";
        let planned_create = service
            .preview_agent_create_revision(&document_ref, create_content)
            .unwrap();
        let created = service
            .create_document_for_expected_vault_with_receipt(
                &vault.id,
                &KnowledgeCreateInput {
                    title: "Research".to_string(),
                    parent_relative_path: None,
                    content: create_content.to_string(),
                },
            )
            .unwrap();
        assert_eq!(created.document.revision, planned_create);

        let append_content = "New evidence\n";
        let planned_append = service
            .preview_agent_append_revision(
                &document_ref,
                &created.document.revision,
                append_content,
            )
            .unwrap();
        let appended = service
            .append_document(&KnowledgeWriteInput {
                document_ref: document_ref.clone(),
                content: append_content.to_string(),
                expected_revision: Some(created.document.revision),
            })
            .unwrap();
        assert_eq!(appended.document.revision, planned_append);

        let tags = vec!["research".to_string(), "verified source".to_string()];
        let planned_tags = service
            .preview_agent_set_tags_revision(&document_ref, &appended.document.revision, &tags)
            .unwrap();
        let tagged = service
            .set_document_tags(&KnowledgeSetTagsInput {
                document_ref,
                expected_revision: appended.document.revision,
                tags,
            })
            .unwrap();
        assert_eq!(tagged.document.revision, planned_tags);
    }

    fn create_registered_vault(label: &str) -> (PathBuf, KnowledgeVaultRegistration) {
        let root = temp_path(&format!("{label}-vault"));
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: format!("vault-{label}"),
            name: label.to_string(),
            root_path: root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: VAULT_SCHEMA_VERSION,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        (root, vault)
    }

    #[test]
    fn public_create_list_and_read_use_the_registered_vault() {
        let (service, root, vault) = registered_service("create-list-read");
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "First note".to_string(),
                parent_relative_path: None,
                content: "Hello from the vault".to_string(),
            })
            .unwrap();

        assert_eq!(
            created.summary.document_ref,
            KnowledgeDocumentRef {
                vault_id: vault.id.clone(),
                relative_path: "First note.md".to_string(),
            }
        );
        assert_eq!(created.content, "Hello from the vault");
        assert!(root.join("First note.md").is_file());

        let listed = service.list_documents().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].document_ref, created.summary.document_ref);

        let read = service
            .read_document(&created.summary.document_ref)
            .unwrap();
        assert_eq!(read.content, created.content);
        assert_eq!(read.revision, created.revision);
    }

    #[test]
    fn ui_compat_move_and_delete_are_revision_guarded_vault_operations() {
        let (service, root, vault) = registered_service("compat-move-delete");
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let created = service
            .create_document_from_ui(
                activation.source_epoch,
                &KnowledgeCreateInput {
                    title: "Original".to_string(),
                    parent_relative_path: None,
                    content: "sentinel".to_string(),
                },
            )
            .unwrap();

        let stale = service
            .move_document_from_ui(
                activation.source_epoch,
                &KnowledgeMoveInput {
                    document_ref: created.summary.document_ref.clone(),
                    title: "Renamed".to_string(),
                    expected_revision: "stale".to_string(),
                    parent_relative_path: None,
                },
            )
            .unwrap_err();
        assert_eq!(stale.code, "knowledge-revision-conflict");
        assert!(root.join("Original.md").is_file());

        let moved = service
            .move_document_from_ui(
                activation.source_epoch,
                &KnowledgeMoveInput {
                    document_ref: created.summary.document_ref.clone(),
                    title: "Renamed".to_string(),
                    expected_revision: created.revision,
                    parent_relative_path: None,
                },
            )
            .unwrap();
        assert!(!root.join("Original.md").exists());
        assert_eq!(std::fs::read(root.join("Renamed.md")).unwrap(), b"sentinel");
        assert_eq!(moved.summary.document_ref.relative_path, "Renamed.md");

        service
            .delete_document_from_ui(
                activation.source_epoch,
                &KnowledgeDeleteInput {
                    document_ref: moved.summary.document_ref,
                    expected_revision: moved.revision,
                },
            )
            .unwrap();
        assert!(!root.join("Renamed.md").exists());
        assert!(service.list_documents().unwrap().is_empty());
    }

    #[test]
    fn public_search_append_insert_and_replace_enforce_revisions() {
        let (service, _root, _vault) = registered_service("write-search");
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Writing".to_string(),
                parent_relative_path: None,
                content: "Alpha".to_string(),
            })
            .unwrap();
        let appended = service
            .append_document(&KnowledgeWriteInput {
                document_ref: created.summary.document_ref.clone(),
                content: "Beta".to_string(),
                expected_revision: Some(created.revision.clone()),
            })
            .unwrap();
        assert_eq!(appended.document.content, "Alpha\n\nBeta");
        assert_eq!(appended.position, "append");

        let inserted = service
            .insert_document(&KnowledgeInsertInput {
                document_ref: created.summary.document_ref.clone(),
                offset: 5,
                text: "!".to_string(),
                expected_revision: Some(appended.document.revision.clone()),
            })
            .unwrap();
        assert_eq!(inserted.document.content, "Alpha!\n\nBeta");
        assert_eq!(inserted.position, "cursor");

        let matches = service.search_documents("beta", 10).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].document_ref, created.summary.document_ref);
        assert_eq!(service.recent_documents(1).unwrap().len(), 1);

        let conflict = service
            .replace_document(&KnowledgeWriteInput {
                document_ref: created.summary.document_ref.clone(),
                content: "stale overwrite".to_string(),
                expected_revision: Some(created.revision.clone()),
            })
            .unwrap_err();
        assert_eq!(conflict.code, "knowledge-revision-conflict");
        assert_eq!(
            service
                .read_document(&created.summary.document_ref)
                .unwrap()
                .content,
            "Alpha!\n\nBeta"
        );
    }

    #[test]
    fn current_context_inserts_only_when_ref_revision_and_offset_are_current() {
        let (service, root, vault) = registered_service("current-context");
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let session = service
            .begin_current_context_session(activation.source_epoch, "current-context-session")
            .unwrap();
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Active".to_string(),
                parent_relative_path: None,
                content: "abcd".to_string(),
            })
            .unwrap();
        let stale_offset = service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: session.session_id.clone(),
                session_epoch: session.session_epoch,
                generation: 1,
                document_ref: created.summary.document_ref.clone(),
                cursor_offset: Some(5),
                selection: None,
                expected_revision: Some(created.revision.clone()),
            })
            .unwrap_err();
        assert_eq!(stale_offset.code, "knowledge-offset-conflict");
        let context = service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: session.session_id.clone(),
                session_epoch: session.session_epoch,
                generation: 1,
                document_ref: created.summary.document_ref.clone(),
                cursor_offset: Some(2),
                selection: Some("bc".to_string()),
                expected_revision: Some(created.revision.clone()),
            })
            .unwrap();
        assert_eq!(context.document_ref, created.summary.document_ref);
        assert_eq!(context.cursor_offset, Some(2));

        let inserted = service
            .insert_into_current(&KnowledgeCurrentInsertInput {
                text: "!".to_string(),
                append_if_no_cursor: true,
            })
            .unwrap();
        assert_eq!(inserted.document.content, "ab!cd");
        assert_eq!(inserted.position, "cursor");

        service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: session.session_id.clone(),
                session_epoch: session.session_epoch,
                generation: 2,
                document_ref: inserted.document.summary.document_ref.clone(),
                cursor_offset: Some(5),
                selection: None,
                expected_revision: Some(inserted.document.revision.clone()),
            })
            .unwrap();
        std::fs::write(root.join("Active.md"), "externally changed").unwrap();
        let stale = service
            .insert_into_current(&KnowledgeCurrentInsertInput {
                text: "unsafe".to_string(),
                append_if_no_cursor: true,
            })
            .unwrap_err();
        assert_eq!(stale.code, "knowledge-revision-conflict");
        assert_eq!(
            std::fs::read_to_string(root.join("Active.md")).unwrap(),
            "externally changed"
        );

        service
            .clear_current_context(&KnowledgeCurrentContextClearInput {
                source_epoch: activation.source_epoch,
                session_id: session.session_id,
                session_epoch: session.session_epoch,
                generation: 3,
            })
            .unwrap();
        let missing = service
            .insert_into_current(&KnowledgeCurrentInsertInput {
                text: "no target".to_string(),
                append_if_no_cursor: true,
            })
            .unwrap_err();
        assert_eq!(missing.code, "knowledge-current-context-required");
    }

    #[test]
    fn legacy_iframe_current_context_accepts_only_canonical_vault_identity() {
        let (service, _root, vault) = registered_service("legacy-iframe-context");
        service.activate_ui_source(&vault.id).unwrap();
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Iframe Active".to_string(),
                parent_relative_path: None,
                content: "abcd".to_string(),
            })
            .unwrap();
        let note_id = legacy_note_id(&created.summary.document_ref);
        service
            .publish_legacy_current_context(Some(&note_id), Some(2), Some("bc".to_string()))
            .unwrap();
        let context = service.get_current_context().unwrap().unwrap();
        assert_eq!(context.document_ref, created.summary.document_ref);
        assert_eq!(context.cursor_offset, Some(2));
        assert_eq!(context.selection.as_deref(), Some("bc"));

        let retired = service
            .publish_legacy_current_context(Some("legacy-db-note"), None, None)
            .unwrap_err();
        assert_eq!(retired.code, "legacy-db-note-retired");
        assert_eq!(
            service.get_current_context().unwrap().unwrap().document_ref,
            created.summary.document_ref
        );
        service
            .publish_legacy_current_context(None, None, None)
            .unwrap();
        assert!(service.get_current_context().unwrap().is_none());
    }

    #[test]
    fn desktop_current_context_cannot_be_replaced_or_cleared_by_legacy_iframe() {
        let (service, root, vault) = registered_service("desktop-context-owner");
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let legacy_document = service
            .create_document(&KnowledgeCreateInput {
                title: "Legacy Target".to_string(),
                parent_relative_path: None,
                content: "legacy".to_string(),
            })
            .unwrap();
        let desktop_document = service
            .create_document(&KnowledgeCreateInput {
                title: "Desktop Target".to_string(),
                parent_relative_path: None,
                content: "desktop".to_string(),
            })
            .unwrap();
        let desktop = service
            .begin_current_context_session(activation.source_epoch, "desktop-notes")
            .unwrap();
        service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: desktop.session_id,
                session_epoch: desktop.session_epoch,
                generation: 1,
                document_ref: desktop_document.summary.document_ref.clone(),
                cursor_offset: Some(7),
                selection: None,
                expected_revision: Some(desktop_document.revision),
            })
            .unwrap();

        let legacy_id = legacy_note_id(&legacy_document.summary.document_ref);
        let delayed_set = service
            .publish_legacy_current_context(Some(&legacy_id), Some(6), None)
            .unwrap_err();
        assert_eq!(delayed_set.code, "knowledge-context-owner-conflict");
        let delayed_clear = service
            .publish_legacy_current_context(None, None, None)
            .unwrap_err();
        assert_eq!(delayed_clear.code, "knowledge-context-owner-conflict");
        let retired_id = service
            .publish_legacy_current_context(Some("legacy-db-note"), None, None)
            .unwrap_err();
        assert_eq!(retired_id.code, "legacy-db-note-retired");
        let wrong_vault_id = legacy_note_id(&KnowledgeDocumentRef {
            vault_id: "another-vault".to_string(),
            relative_path: legacy_document.summary.relative_path.clone(),
        });
        let wrong_vault = service
            .publish_legacy_current_context(Some(&wrong_vault_id), Some(0), None)
            .unwrap_err();
        assert_eq!(wrong_vault.code, "knowledge-context-owner-conflict");
        assert_eq!(
            service.get_current_context().unwrap().unwrap().document_ref,
            desktop_document.summary.document_ref
        );

        service
            .insert_into_current(&KnowledgeCurrentInsertInput {
                text: "!".to_string(),
                append_if_no_cursor: false,
            })
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("Legacy Target.md")).unwrap(),
            "legacy"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("Desktop Target.md")).unwrap(),
            "desktop!"
        );
        std::fs::write(root.join("Desktop Target.md"), "external edit").unwrap();
        let stale_legacy = service
            .publish_legacy_current_context(
                Some(&legacy_note_id(&desktop_document.summary.document_ref)),
                Some(0),
                None,
            )
            .unwrap_err();
        assert_eq!(stale_legacy.code, "knowledge-context-owner-conflict");
        assert_eq!(
            service.get_current_context().unwrap().unwrap().document_ref,
            desktop_document.summary.document_ref
        );
    }

    #[test]
    fn desktop_owner_preempts_legacy_and_legacy_cannot_reclaim_same_source_epoch() {
        let (service, _root, vault) = registered_service("context-owner-order");
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let legacy_document = service
            .create_document(&KnowledgeCreateInput {
                title: "Legacy First".to_string(),
                parent_relative_path: None,
                content: "legacy".to_string(),
            })
            .unwrap();
        let desktop_document = service
            .create_document(&KnowledgeCreateInput {
                title: "Desktop Next".to_string(),
                parent_relative_path: None,
                content: "desktop".to_string(),
            })
            .unwrap();
        let legacy_id = legacy_note_id(&legacy_document.summary.document_ref);
        service
            .publish_legacy_current_context(Some(&legacy_id), Some(0), None)
            .unwrap();

        let desktop = service
            .begin_current_context_session(activation.source_epoch, "desktop-owner")
            .unwrap();
        service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: desktop.session_id.clone(),
                session_epoch: desktop.session_epoch,
                generation: 1,
                document_ref: desktop_document.summary.document_ref.clone(),
                cursor_offset: Some(0),
                selection: None,
                expected_revision: Some(desktop_document.revision),
            })
            .unwrap();
        let late_legacy = service
            .publish_legacy_current_context(Some(&legacy_id), Some(0), None)
            .unwrap_err();
        assert_eq!(late_legacy.code, "knowledge-context-owner-conflict");

        service
            .clear_current_context(&KnowledgeCurrentContextClearInput {
                source_epoch: activation.source_epoch,
                session_id: desktop.session_id,
                session_epoch: desktop.session_epoch,
                generation: 2,
            })
            .unwrap();
        let after_desktop_clear = service
            .publish_legacy_current_context(Some(&legacy_id), Some(0), None)
            .unwrap_err();
        assert_eq!(after_desktop_clear.code, "knowledge-context-owner-conflict");
        assert!(service.get_current_context().unwrap().is_none());

        let next_source = service.activate_ui_source(&vault.id).unwrap();
        assert!(next_source.source_epoch > activation.source_epoch);
        let after_source_reactivation = service
            .publish_legacy_current_context(Some(&legacy_id), Some(0), None)
            .unwrap_err();
        assert_eq!(
            after_source_reactivation.code,
            "knowledge-context-owner-conflict"
        );
        assert!(service.get_current_context().unwrap().is_none());
    }

    #[test]
    fn switching_vaults_isolates_equal_paths_and_clears_current_context() {
        let app_data = temp_path("two-vaults-app");
        let service = KnowledgeService::initialize(&app_data).unwrap();
        let (first_root, first_vault) = create_registered_vault("two-vaults-first");
        let (second_root, second_vault) = create_registered_vault("two-vaults-second");

        service.register_current_vault(&first_vault).unwrap();
        let activation = service.activate_ui_source(&first_vault.id).unwrap();
        let session = service
            .begin_current_context_session(activation.source_epoch, "two-vaults-session")
            .unwrap();
        let first = service
            .create_document(&KnowledgeCreateInput {
                title: "Same".to_string(),
                parent_relative_path: None,
                content: "first vault".to_string(),
            })
            .unwrap();
        service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: session.session_id,
                session_epoch: session.session_epoch,
                generation: 1,
                document_ref: first.summary.document_ref.clone(),
                cursor_offset: Some(0),
                selection: None,
                expected_revision: Some(first.revision),
            })
            .unwrap();

        service.register_current_vault(&second_vault).unwrap();
        assert!(service.get_current_context().unwrap().is_none());
        let second = service
            .create_document(&KnowledgeCreateInput {
                title: "Same".to_string(),
                parent_relative_path: None,
                content: "second vault".to_string(),
            })
            .unwrap();

        assert_eq!(first.summary.relative_path, second.summary.relative_path);
        assert_ne!(
            first.summary.document_ref.vault_id,
            second.summary.document_ref.vault_id
        );
        assert_eq!(
            std::fs::read_to_string(first_root.join("Same.md")).unwrap(),
            "first vault"
        );
        assert_eq!(
            std::fs::read_to_string(second_root.join("Same.md")).unwrap(),
            "second vault"
        );
        let mismatch = service
            .read_document(&first.summary.document_ref)
            .unwrap_err();
        assert_eq!(mismatch.code, "knowledge-vault-mismatch");
    }

    #[test]
    fn project_authorization_target_identity_is_stable_safe_and_replacement_sensitive() {
        let app_data = temp_path("project-authorization-target-app");
        let service = KnowledgeService::initialize(&app_data).unwrap();
        let (_first_root, first_vault) = create_registered_vault("project-authorization-first");
        service.register_current_vault(&first_vault).unwrap();
        let first = service.current_target_identity().unwrap();
        let repeated = service.current_target_identity().unwrap();
        assert_eq!(first, repeated);
        assert_eq!(first.target_id, first_vault.id);
        assert!(!first.label.is_empty());
        assert_eq!(first.identity_digest.len(), 64);

        let (_second_root, second_vault) = create_registered_vault("project-authorization-second");
        service.register_current_vault(&second_vault).unwrap();
        let second = service.current_target_identity().unwrap();
        assert_ne!(first.target_id, second.target_id);
        assert_ne!(first.identity_digest, second.identity_digest);

        let mut replacement = first_vault.clone();
        replacement.root_path = second_vault.root_path.clone();
        replacement.created_at = "replacement-identity".to_owned();
        replacement.last_opened_at = replacement.created_at.clone();
        std::fs::write(
            std::path::Path::new(&replacement.root_path)
                .join(".luckyray")
                .join("vault.json"),
            serde_json::to_vec_pretty(&replacement).unwrap(),
        )
        .unwrap();
        service.register_current_vault(&replacement).unwrap();
        let replaced = service.current_target_identity().unwrap();
        assert_eq!(replaced.target_id, first.target_id);
        assert_ne!(replaced.identity_digest, first.identity_digest);
    }

    #[cfg(windows)]
    #[test]
    fn project_authorization_target_identity_rejects_same_path_root_replacement() {
        let app_data = temp_path("project-authorization-same-path-app");
        let service = KnowledgeService::initialize(&app_data).unwrap();
        let (root, vault) = create_registered_vault("project-authorization-same-path");
        service.register_current_vault(&vault).unwrap();
        let original = service.current_target_identity().unwrap();

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        std::fs::write(root.join("replacement-only.md"), "replacement-root-marker").unwrap();
        std::fs::write(
            root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        service.register_current_vault(&vault).unwrap();

        let replacement = service.current_target_identity().unwrap();
        assert_eq!(replacement.target_id, original.target_id);
        assert_ne!(
            replacement.identity_digest, original.identity_digest,
            "deleting and recreating a Vault root at the same canonical path must rotate its Backend identity"
        );
        let delivered = AtomicBool::new(false);
        let denied = service.with_current_target_response_lease(&original, || {
            delivered.store(true, Ordering::SeqCst);
        });
        assert_eq!(denied.unwrap_err().code, "knowledge-target-not-current");
        assert!(
            !delivered.load(Ordering::SeqCst),
            "a replaced root cannot publish an old-target response"
        );
    }

    #[cfg(windows)]
    #[test]
    fn frozen_target_root_handle_blocks_replacement_during_index_io() {
        let (service, root, _) = registered_service("project-target-root-guard");
        std::fs::write(root.join("guarded.md"), "guarded-root-marker").unwrap();
        let replacement = root.with_extension("replacement");
        let displaced = root.with_extension("displaced");
        std::fs::create_dir_all(&replacement).unwrap();
        std::fs::write(
            replacement.join("replacement-only.md"),
            "replacement-root-marker",
        )
        .unwrap();
        let target = service.current_target_identity().unwrap();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let invoked = Arc::new(AtomicBool::new(false));
        let hook_entered = entered.clone();
        let hook_release = release.clone();
        let hook_invoked = invoked.clone();
        service.set_before_index_document_read(move || {
            if !hook_invoked.swap(true, Ordering::SeqCst) {
                hook_entered.wait();
                hook_release.wait();
            }
        });
        let worker_service = service.clone();
        let worker = std::thread::spawn(move || worker_service.refresh_index_for_target(&target));

        entered.wait();
        assert!(
            std::fs::rename(&root, &displaced).is_err(),
            "the production no-delete-share root handle must block same-path replacement during index I/O"
        );
        assert!(std::fs::rename(&replacement, &root).is_err());
        assert!(root.join("guarded.md").is_file());
        assert!(!root.join("replacement-only.md").exists());
        release.wait();

        let snapshot = worker.join().unwrap().unwrap();
        assert!(snapshot
            .documents
            .iter()
            .any(|document| document.plain_text.contains("guarded-root-marker")));
        drop(service);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(replacement).unwrap();
    }

    #[test]
    fn backend_context_order_rejects_stale_generation_and_retired_sessions() {
        let (service, _root, vault) = registered_service("context-order");
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Ordered".to_string(),
                parent_relative_path: None,
                content: "body".to_string(),
            })
            .unwrap();
        let old = service
            .begin_current_context_session(activation.source_epoch, "old-webview")
            .unwrap();
        service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: old.session_id.clone(),
                session_epoch: old.session_epoch,
                generation: 1,
                document_ref: created.summary.document_ref.clone(),
                cursor_offset: Some(1),
                selection: None,
                expected_revision: Some(created.revision.clone()),
            })
            .unwrap();
        let duplicate = service
            .clear_current_context(&KnowledgeCurrentContextClearInput {
                source_epoch: activation.source_epoch,
                session_id: old.session_id.clone(),
                session_epoch: old.session_epoch,
                generation: 1,
            })
            .unwrap_err();
        assert_eq!(duplicate.code, "knowledge-context-stale");

        let current = service
            .begin_current_context_session(activation.source_epoch, "new-webview")
            .unwrap();
        let retired = service
            .clear_current_context(&KnowledgeCurrentContextClearInput {
                source_epoch: activation.source_epoch,
                session_id: old.session_id,
                session_epoch: old.session_epoch,
                generation: 2,
            })
            .unwrap_err();
        assert_eq!(retired.code, "knowledge-context-stale");
        service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: current.session_id,
                session_epoch: current.session_epoch,
                generation: 1,
                document_ref: created.summary.document_ref.clone(),
                cursor_offset: Some(2),
                selection: None,
                expected_revision: Some(created.revision.clone()),
            })
            .unwrap();
        let reactivated = service.activate_ui_source(&vault.id).unwrap();
        assert!(reactivated.source_epoch > activation.source_epoch);
        assert!(service.get_current_context().unwrap().is_none());
        let delayed_old_begin = service
            .begin_current_context_session(activation.source_epoch, "delayed-old-webview")
            .unwrap_err();
        assert_eq!(delayed_old_begin.code, "knowledge-source-inactive");
        let current = service
            .begin_current_context_session(reactivated.source_epoch, "current-webview")
            .unwrap();
        service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: reactivated.source_epoch,
                session_id: current.session_id,
                session_epoch: current.session_epoch,
                generation: 1,
                document_ref: created.summary.document_ref.clone(),
                cursor_offset: Some(3),
                selection: None,
                expected_revision: Some(created.revision),
            })
            .unwrap();
        assert_eq!(
            service.get_current_context().unwrap().unwrap().document_ref,
            created.summary.document_ref
        );
    }

    #[test]
    fn ui_source_activation_blocks_db_view_writes_without_disabling_headless_vault_routes() {
        let (service, root, vault) = registered_service("ui-source");
        let inactive = service
            .create_document_from_ui(
                0,
                &KnowledgeCreateInput {
                    title: "Blocked".to_string(),
                    parent_relative_path: None,
                    content: "must not write".to_string(),
                },
            )
            .unwrap_err();
        assert_eq!(inactive.code, "knowledge-source-inactive");
        assert!(!root.join("Blocked.md").exists());

        let active = service.activate_ui_source(&vault.id).unwrap();
        let created = service
            .create_document_from_ui(
                active.source_epoch,
                &KnowledgeCreateInput {
                    title: "Visible".to_string(),
                    parent_relative_path: None,
                    content: "real vault".to_string(),
                },
            )
            .unwrap();
        service.deactivate_ui_source().unwrap();
        let stale = service
            .append_document_from_ui(
                active.source_epoch,
                &KnowledgeWriteInput {
                    document_ref: created.summary.document_ref.clone(),
                    content: "wrong mode".to_string(),
                    expected_revision: Some(created.revision),
                },
            )
            .unwrap_err();
        assert_eq!(stale.code, "knowledge-source-inactive");
        assert_eq!(
            std::fs::read_to_string(root.join("Visible.md")).unwrap(),
            "real vault"
        );
        let blocked_current = service
            .insert_into_current_from_ui(
                active.source_epoch,
                &KnowledgeCurrentInsertInput {
                    text: "must not insert".to_string(),
                    append_if_no_cursor: true,
                },
            )
            .unwrap_err();
        assert_eq!(blocked_current.code, "knowledge-source-inactive");
        let headless_current = service
            .insert_into_current(&KnowledgeCurrentInsertInput {
                text: "must not insert".to_string(),
                append_if_no_cursor: true,
            })
            .unwrap_err();
        assert_eq!(headless_current.code, "knowledge-current-context-required");
        assert_eq!(
            std::fs::read_to_string(root.join("Visible.md")).unwrap(),
            "real vault"
        );
        assert!(service.get_current_context().unwrap().is_none());

        let headless = service.dispatch_http(
            "POST",
            "/api/notes",
            Some(r#"{"title":"Headless","content":"independent adapter"}"#),
        );
        assert_eq!(headless.status, 200);
        assert_eq!(
            std::fs::read_to_string(root.join("Headless.md")).unwrap(),
            "independent adapter"
        );

        let reactivated = service.activate_ui_source(&vault.id).unwrap();
        assert!(reactivated.source_epoch > active.source_epoch);
        service
            .create_document_from_ui(
                reactivated.source_epoch,
                &KnowledgeCreateInput {
                    title: "Restored".to_string(),
                    parent_relative_path: None,
                    content: "active again".to_string(),
                },
            )
            .unwrap();
        assert!(root.join("Restored.md").is_file());
    }

    #[test]
    fn legacy_document_ids_bind_vault_and_path_and_reject_non_document_identity() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/knowledgeDocumentRef.vectors.json"
        ))
        .unwrap();
        for vector in vectors["positive"].as_array().unwrap() {
            let protocol_ref: KnowledgeDocumentRef =
                serde_json::from_value(vector["documentRef"].clone()).unwrap();
            let protocol_id = vector["noteId"].as_str().unwrap();
            assert_eq!(legacy_note_id(&protocol_ref), protocol_id);
            assert_eq!(parse_legacy_note_id(protocol_id).unwrap(), protocol_ref);
        }
        for vector in vectors["negative"].as_array().unwrap() {
            let protocol_id = vector["noteId"].as_str().unwrap();
            assert_eq!(
                parse_legacy_note_id(protocol_id).unwrap_err().code,
                "knowledge-invalid-document-ref"
            );
        }

        let first = KnowledgeDocumentRef {
            vault_id: "vault-a".to_string(),
            relative_path: "Same.md".to_string(),
        };
        let second = KnowledgeDocumentRef {
            vault_id: "vault-b".to_string(),
            relative_path: "Same.md".to_string(),
        };
        let first_id = legacy_note_id(&first);
        let second_id = legacy_note_id(&second);
        assert_ne!(first_id, second_id);
        assert_eq!(parse_legacy_note_id(&first_id).unwrap(), first);
        assert_eq!(parse_legacy_note_id(&second_id).unwrap(), second);
        assert_eq!(
            parse_legacy_note_id("legacy-db-note-id").unwrap_err().code,
            "legacy-db-note-retired"
        );
        let escaped = legacy_note_id(&KnowledgeDocumentRef {
            vault_id: "vault-a".to_string(),
            relative_path: "../outside.md".to_string(),
        });
        assert_eq!(
            parse_legacy_note_id(&escaped).unwrap_err().code,
            "knowledge-invalid-document-ref"
        );
    }

    #[test]
    fn public_paths_fail_closed_and_mutations_preserve_utf8_format() {
        let (service, root, vault) = registered_service("path-format");
        for path in [
            "../outside.md",
            "C:/outside.md",
            "//server/share.md",
            ".luckyray/vault.md",
            "not-markdown.txt",
            "",
        ] {
            let failure = service
                .read_document(&KnowledgeDocumentRef {
                    vault_id: vault.id.clone(),
                    relative_path: path.to_string(),
                })
                .unwrap_err();
            assert!(
                [
                    "knowledge-path-outside-vault",
                    "knowledge-path-not-markdown",
                    "knowledge-invalid-document-ref",
                ]
                .contains(&failure.code),
                "unexpected error for {path}: {}",
                failure.code
            );
        }
        assert!(!temp_path("outside").exists());

        let bytes = b"\xef\xbb\xbfalpha\r\nbeta\r\n";
        std::fs::write(root.join("Formatted.md"), bytes).unwrap();
        let document_ref = KnowledgeDocumentRef {
            vault_id: vault.id,
            relative_path: "Formatted.md".to_string(),
        };
        let before_mtime = std::fs::metadata(root.join("Formatted.md"))
            .unwrap()
            .modified()
            .unwrap();
        let snapshot = service.read_document(&document_ref).unwrap();
        assert_eq!(snapshot.content, "alpha\r\nbeta\r\n");
        assert_eq!(
            std::fs::metadata(root.join("Formatted.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before_mtime
        );
        let appended = service
            .append_document(&KnowledgeWriteInput {
                document_ref,
                content: "gamma\ndelta\n".to_string(),
                expected_revision: Some(snapshot.revision),
            })
            .unwrap();
        assert_eq!(
            appended.document.content,
            "alpha\r\nbeta\r\n\r\ngamma\r\ndelta\r\n"
        );
        let written = std::fs::read(root.join("Formatted.md")).unwrap();
        assert!(written.starts_with(&[0xef, 0xbb, 0xbf]));
        assert!(!written.windows(2).any(|window| window == b"\n\n"));
        assert!(written.ends_with(b"\r\n"));
    }

    #[test]
    fn legacy_http_routes_use_vault_documents_and_leave_db_note_sentinels_untouched() {
        let app_data = temp_path("legacy-http-app");
        std::fs::create_dir_all(&app_data).unwrap();
        let db_path = app_data.join("luckyray.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE note (id TEXT PRIMARY KEY, title TEXT, content TEXT);\n\
                 INSERT INTO note (id, title, content) VALUES ('sentinel', 'legacy', 'unchanged');",
            )
            .unwrap();
        drop(connection);
        let (root, vault) = create_registered_vault("legacy-http-vault");
        let service = KnowledgeService::initialize(&app_data).unwrap();
        service.register_current_vault(&vault).unwrap();

        let created = service.dispatch_http(
            "POST",
            "/api/notes",
            Some(r#"{"title":"From extension","content":"vault content"}"#),
        );
        assert_eq!(created.status, 200);
        let created_body: Value = serde_json::from_str(&created.body).unwrap();
        let id = created_body.get("id").and_then(Value::as_str).unwrap();
        assert!(id.starts_with("kdoc-"));
        assert_eq!(
            created_body
                .pointer("/documentRef/vaultId")
                .and_then(Value::as_str),
            Some(vault.id.as_str())
        );
        assert_eq!(
            std::fs::read_to_string(root.join("From extension.md")).unwrap(),
            "vault content"
        );

        let recent = service.dispatch_http("GET", "/api/notes/recent", None);
        let recent_body: Value = serde_json::from_str(&recent.body).unwrap();
        assert_eq!(recent_body["notes"].as_array().unwrap().len(), 1);

        let search = service.dispatch_http("GET", "/api/notes/search?q=vault", None);
        let search_body: Value = serde_json::from_str(&search.body).unwrap();
        assert_eq!(search_body["notes"].as_array().unwrap().len(), 1);

        let appended = service.dispatch_http(
            "POST",
            &format!("/api/notes/{id}/append"),
            Some(r#"{"content":"more"}"#),
        );
        assert_eq!(appended.status, 200);
        assert_eq!(
            std::fs::read_to_string(root.join("From extension.md")).unwrap(),
            "vault content\n\nmore"
        );

        let connection = rusqlite::Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let sentinel: (String, String, String) = connection
            .query_row(
                "SELECT id, title, content FROM note WHERE id='sentinel'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            sentinel,
            ("sentinel".into(), "legacy".into(), "unchanged".into())
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM note", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn no_registered_vault_is_a_stable_error() {
        let service = KnowledgeService::initialize(temp_path("no-vault")).unwrap();
        let error = service.list_documents().unwrap_err();
        assert_eq!(error.code, "knowledge-vault-required");
        let response = service.dispatch_http("GET", "/api/notes/recent", None);
        assert_eq!(response.status, 404);
        let body: Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(body["code"], "knowledge-vault-required");
    }

    #[test]
    fn atomic_write_failure_preserves_original_and_cleans_temp_file() {
        let (service, root, _vault) = registered_service("atomic-failure");
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Protected".to_string(),
                parent_relative_path: None,
                content: "original".to_string(),
            })
            .unwrap();
        service.fail_next_write_before_commit();
        let failure = service
            .replace_document(&KnowledgeWriteInput {
                document_ref: created.summary.document_ref,
                content: "must not commit".to_string(),
                expected_revision: Some(created.revision),
            })
            .unwrap_err();
        assert_eq!(failure.code, "knowledge-write-failed");
        assert_eq!(
            std::fs::read_to_string(root.join("Protected.md")).unwrap(),
            "original"
        );
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect::<Vec<_>>();
        assert!(
            leftovers.is_empty(),
            "temporary files were left behind: {leftovers:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn non_cooperating_process_cannot_write_or_replace_after_final_revision_validation() {
        for operation in ["write", "replace", "rename", "delete"] {
            let (service, root, _vault) = registered_service(&format!("os-race-{operation}"));
            let created = service
                .create_document(&KnowledgeCreateInput {
                    title: "Race".to_string(),
                    parent_relative_path: None,
                    content: "original".to_string(),
                })
                .unwrap();
            let target = root.join("Race.md");
            let replacement = root.join("external-replacement.tmp");
            let moved = root.join("external-moved.md");
            if operation == "replace" {
                std::fs::write(&replacement, "external replacement").unwrap();
            }
            let external_succeeded = Arc::new(AtomicBool::new(false));
            let observed = Arc::clone(&external_succeeded);
            let target_for_child = target.clone();
            let replacement_for_child = replacement.clone();
            let moved_for_child = moved.clone();
            service.set_after_final_validation_hook(move || {
                let script = if operation == "write" {
                    "$ErrorActionPreference='Stop'; try { [IO.File]::WriteAllText($env:LR_TARGET, 'external write'); exit 0 } catch { exit 73 }"
                } else if operation == "replace" {
                    "$ErrorActionPreference='Stop'; try { [IO.File]::Replace($env:LR_REPLACEMENT, $env:LR_TARGET, $null); exit 0 } catch { exit 73 }"
                } else if operation == "rename" {
                    "$ErrorActionPreference='Stop'; try { [IO.File]::Move($env:LR_TARGET, $env:LR_MOVED); exit 0 } catch { exit 73 }"
                } else {
                    "$ErrorActionPreference='Stop'; try { [IO.File]::Delete($env:LR_TARGET); exit 0 } catch { exit 73 }"
                };
                let status = Command::new("powershell.exe")
                    .args(["-NoProfile", "-NonInteractive", "-Command", script])
                    .env("LR_TARGET", &target_for_child)
                    .env("LR_REPLACEMENT", &replacement_for_child)
                    .env("LR_MOVED", &moved_for_child)
                    .status()
                    .expect("spawn independent Windows file writer");
                observed.store(status.success(), Ordering::Release);
            });

            let result = service
                .replace_document(&KnowledgeWriteInput {
                    document_ref: created.summary.document_ref,
                    content: "knowledge commit".to_string(),
                    expected_revision: Some(created.revision),
                })
                .unwrap();

            assert!(
                !external_succeeded.load(Ordering::Acquire),
                "independent {operation} entered the final validation-to-commit window"
            );
            assert_eq!(result.document.content, "knowledge commit");
            assert_eq!(
                std::fs::read_to_string(&target).unwrap(),
                "knowledge commit"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn preopened_non_cooperating_writer_forces_the_knowledge_commit_to_fail_closed() {
        let (service, root, _vault) = registered_service("os-preopened-writer");
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Preopened".to_string(),
                parent_relative_path: None,
                content: "original".to_string(),
            })
            .unwrap();
        let target = root.join("Preopened.md");
        let ready = root.join("external-writer.ready");
        let go = root.join("external-writer.go");
        let script = r#"
$ErrorActionPreference='Stop'
$share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
$file = [IO.File]::Open($env:LR_TARGET, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, $share)
[IO.File]::WriteAllText($env:LR_READY, 'ready')
while (-not [IO.File]::Exists($env:LR_GO)) { [Threading.Thread]::Yield() | Out-Null }
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes('external survives')
  $file.SetLength(0)
  $file.Position = 0
  $file.Write($bytes, 0, $bytes.Length)
  $file.Flush($true)
  $file.Dispose()
  exit 0
} catch {
  $file.Dispose()
  exit 73
}
"#;
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("LR_TARGET", &target)
            .env("LR_READY", &ready)
            .env("LR_GO", &go)
            .spawn()
            .expect("spawn preopened independent Windows writer");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(
            ready.exists(),
            "independent writer did not acquire its file handle"
        );

        let result = service.replace_document(&KnowledgeWriteInput {
            document_ref: created.summary.document_ref,
            content: "must not overwrite external handle".to_string(),
            expected_revision: Some(created.revision),
        });
        std::fs::write(&go, b"go").unwrap();
        let child_status = child.wait().expect("wait for independent Windows writer");

        assert!(
            child_status.success(),
            "external writer should retain its original handle"
        );
        assert_eq!(result.unwrap_err().code, "knowledge-revision-conflict");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "external survives"
        );
        assert!(std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                !name.ends_with(".journal") && !name.ends_with(".backup") && !name.ends_with(".tmp")
            }));
    }

    #[cfg(windows)]
    #[test]
    fn interrupted_exclusive_commit_recovers_original_before_service_becomes_ready() {
        let (service, root, _vault) = registered_service("journal-recovery");
        let app_data = service.app_data_dir.clone();
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Recoverable".to_string(),
                parent_relative_path: None,
                content: "original".to_string(),
            })
            .unwrap();
        service.interrupt_next_write_after_backup_rename();
        let interrupted = service
            .replace_document(&KnowledgeWriteInput {
                document_ref: created.summary.document_ref.clone(),
                content: "uncommitted".to_string(),
                expected_revision: Some(created.revision),
            })
            .unwrap_err();
        assert_eq!(interrupted.code, "knowledge-write-interrupted");
        assert!(!root.join("Recoverable.md").exists());
        assert!(std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".journal")));

        let restarted = KnowledgeService::initialize(&app_data).unwrap();
        assert_eq!(
            restarted
                .read_document(&created.summary.document_ref)
                .unwrap()
                .content,
            "original"
        );
        assert!(std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                !name.ends_with(".journal") && !name.ends_with(".backup") && !name.ends_with(".tmp")
            }));
    }

    #[cfg(windows)]
    #[test]
    fn concurrent_service_writers_serialize_and_stale_revision_fails_closed() {
        let (service, root, _vault) = registered_service("concurrent-writers");
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Concurrent".to_string(),
                parent_relative_path: None,
                content: "original".to_string(),
            })
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut threads = Vec::new();
        for content in ["first", "second"] {
            let service = service.clone();
            let barrier = Arc::clone(&barrier);
            let document_ref = created.summary.document_ref.clone();
            let revision = created.revision.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                service.replace_document(&KnowledgeWriteInput {
                    document_ref,
                    content: content.to_string(),
                    expected_revision: Some(revision),
                })
            }));
        }
        barrier.wait();
        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .map(|error| error.code)
                .collect::<Vec<_>>(),
            vec!["knowledge-revision-conflict"]
        );
        let final_content = std::fs::read_to_string(root.join("Concurrent.md")).unwrap();
        assert!(final_content == "first" || final_content == "second");
    }

    #[test]
    fn explicit_offsets_follow_webview_utf16_cursor_semantics() {
        let (service, _root, vault) = registered_service("utf16-offset");
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let session = service
            .begin_current_context_session(activation.source_epoch, "utf16-offset-session")
            .unwrap();
        let created = service
            .create_document(&KnowledgeCreateInput {
                title: "Emoji".to_string(),
                parent_relative_path: None,
                content: "a😀b".to_string(),
            })
            .unwrap();
        let inserted = service
            .insert_document(&KnowledgeInsertInput {
                document_ref: created.summary.document_ref,
                offset: 3,
                text: "!".to_string(),
                expected_revision: Some(created.revision),
            })
            .unwrap();
        assert_eq!(inserted.document.content, "a😀!b");
        let split_surrogate = service
            .set_current_context(&KnowledgeCurrentContextInput {
                source_epoch: activation.source_epoch,
                session_id: session.session_id,
                session_epoch: session.session_epoch,
                generation: 1,
                document_ref: inserted.document.summary.document_ref,
                cursor_offset: Some(2),
                selection: None,
                expected_revision: Some(inserted.document.revision),
            })
            .unwrap_err();
        assert_eq!(split_surrogate.code, "knowledge-offset-conflict");
    }

    #[test]
    fn linked_document_components_never_escape_the_vault() {
        let (service, root, vault) = registered_service("linked-path");
        let outside = temp_path("linked-path-outside.md");
        std::fs::write(&outside, "outside").unwrap();
        let link = root.join("Linked.md");
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_file(&outside, &link) {
            eprintln!("skipped real Windows reparse fixture because symlink creation is unavailable: {error}");
            return;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let failure = service
            .read_document(&KnowledgeDocumentRef {
                vault_id: vault.id,
                relative_path: "Linked.md".to_string(),
            })
            .unwrap_err();
        assert_eq!(failure.code, "knowledge-path-reparse-forbidden");
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "outside");
    }

    #[test]
    fn backend_index_parses_existing_markdown_and_reuses_unchanged_bytes() {
        let (service, root, vault) = registered_service("backend-index-reuse");
        std::fs::write(
            root.join("Alpha.md"),
            "---\ntags: [project, test]\n---\n# Alpha Title\nBody #inline\n## Section\n[[Beta|Alias]] ![[image.png]]\n",
        )
        .unwrap();

        let first = service.refresh_index().unwrap();
        assert_eq!(first.vault_id, vault.id);
        assert_eq!(first.documents.len(), 1);
        let document = &first.documents[0];
        assert_eq!(document.document_ref.relative_path, "Alpha.md");
        assert_eq!(document.title, "Alpha Title");
        assert_eq!(document.headings.len(), 2);
        assert_eq!(document.wiki_links[0].target, "Beta");
        assert_eq!(document.embeds[0].target, "image.png");
        assert!(document.frontmatter_tags.contains(&"project".to_string()));
        assert!(document.inline_tags.contains(&"inline".to_string()));
        let reads_after_first = service.index_document_read_count();

        let listed = service.list_documents().unwrap();
        let searched = service.search_documents("Body", 20).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(searched.len(), 1);
        assert_eq!(service.index_document_read_count(), reads_after_first);
    }

    #[cfg(windows)]
    fn restore_windows_last_write_time(path: &Path, last_write_time: u64) {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;

        const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        #[repr(C)]
        struct FileTime {
            low_date_time: u32,
            high_date_time: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn SetFileTime(
                file: *mut std::ffi::c_void,
                creation_time: *const FileTime,
                last_access_time: *const FileTime,
                last_write_time: *const FileTime,
            ) -> i32;
        }

        let file = OpenOptions::new()
            .write(true)
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)
            .unwrap();
        let value = FileTime {
            low_date_time: last_write_time as u32,
            high_date_time: (last_write_time >> 32) as u32,
        };
        assert_ne!(
            unsafe {
                SetFileTime(
                    file.as_raw_handle(),
                    std::ptr::null(),
                    std::ptr::null(),
                    &value,
                )
            },
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn external_same_length_write_with_restored_mtime_invalidates_the_index() {
        use std::os::windows::fs::MetadataExt;

        let (service, root, _vault) = registered_service("backend-index-change-time");
        let path = root.join("Changed.md");
        let original = "# TOKEN-A\n#tag-a [[Target-A]]\n";
        let changed = "# TOKEN-B\n#tag-b [[Target-B]]\n";
        assert_eq!(original.len(), changed.len());
        std::fs::write(&path, original).unwrap();
        let first = service.refresh_index().unwrap();
        let original_last_write = std::fs::metadata(&path).unwrap().last_write_time();
        assert_eq!(service.index_document_read_count(), 1);

        std::fs::write(&path, changed).unwrap();
        restore_windows_last_write_time(&path, original_last_write);
        assert_eq!(
            std::fs::metadata(&path).unwrap().last_write_time(),
            original_last_write
        );

        let refreshed = service.refresh_index().unwrap();
        assert!(refreshed.version > first.version);
        assert_eq!(refreshed.changed_paths, vec!["Changed.md"]);
        assert_eq!(refreshed.documents[0].title, "TOKEN-B");
        assert!(refreshed.documents[0].tags.contains(&"tag-b".to_string()));
        assert_eq!(refreshed.documents[0].wiki_links[0].target, "Target-B");
        assert_eq!(service.search_documents("TOKEN-B", 10).unwrap().len(), 1);
        assert!(service.search_documents("TOKEN-A", 10).unwrap().is_empty());
        assert_eq!(service.index_document_read_count(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn document_change_after_open_is_retried_before_publishing_the_index() {
        let (service, root, _vault) = registered_service("backend-index-stable-read");
        let path = root.join("Changing.md");
        std::fs::write(&path, "# TOKEN-A\n").unwrap();
        service.refresh_index().unwrap();
        std::fs::write(&path, "# TOKEN-B\n").unwrap();
        let reads_before = service.index_document_read_count();
        service.set_before_index_document_read({
            let path = path.clone();
            move || std::fs::write(&path, "# TOKEN-C\n").unwrap()
        });

        let refreshed = service.refresh_index().unwrap();
        assert_eq!(refreshed.documents[0].title, "TOKEN-C");
        assert_eq!(refreshed.changed_paths, vec!["Changing.md"]);
        assert_eq!(service.index_document_read_count(), reads_before + 2);
        assert_eq!(service.search_documents("TOKEN-C", 10).unwrap().len(), 1);
        assert!(service.search_documents("TOKEN-B", 10).unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn atomic_replace_with_restored_mtime_changes_the_file_identity() {
        use std::os::windows::fs::MetadataExt;

        let (service, root, _vault) = registered_service("backend-index-file-identity");
        let path = root.join("Replaced.md");
        let replacement = root.join("Replacement.tmp");
        std::fs::write(&path, "# TOKEN-A\n").unwrap();
        let first = service.refresh_index().unwrap();
        let original_last_write = std::fs::metadata(&path).unwrap().last_write_time();
        std::fs::write(&replacement, "# TOKEN-B\n").unwrap();
        restore_windows_last_write_time(&replacement, original_last_write);
        replace_file(&path, &replacement).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().last_write_time(),
            original_last_write
        );

        let refreshed = service.refresh_index().unwrap();
        assert!(refreshed.version > first.version);
        assert_eq!(refreshed.changed_paths, vec!["Replaced.md"]);
        assert_eq!(refreshed.documents[0].title, "TOKEN-B");
        assert_eq!(service.index_document_read_count(), 2);
    }

    #[test]
    fn unavailable_file_identity_is_conservatively_non_cacheable() {
        let (service, root, _vault) = registered_service("backend-index-unreliable-identity");
        std::fs::write(root.join("Unreliable.md"), "# Unreliable\n").unwrap();
        service.force_unreliable_index_identity(true);
        let first = service.refresh_index().unwrap();
        let reads_after_first = service.index_document_read_count();
        let second = service.refresh_index().unwrap();
        assert_eq!(second.documents, first.documents);
        assert_eq!(service.index_document_read_count(), reads_after_first + 1);

        service.force_unreliable_index_identity(false);
        service.refresh_index().unwrap();
        let reads_after_reliable_refresh = service.index_document_read_count();
        service.refresh_index().unwrap();
        assert_eq!(
            service.index_document_read_count(),
            reads_after_reliable_refresh
        );
    }

    #[test]
    fn backend_index_treats_escaped_openers_as_text_and_excludes_fenced_code() {
        assert_eq!(
            normalize_embed_target("\\_2k\\_delpmaspu (1).png"),
            "_2k_delpmaspu (1).png"
        );
        let (service, root, _vault) = registered_service("backend-index-parser-compat");
        std::fs::write(
            root.join("Alpha.md"),
            "# Alpha\n\n正文 [[Beta]] and ![[visible.png]]\n!\\[\\[\\_2k\\_delpmaspu (1).png]]\n\n```md\n[[Fake Code Link]]\n![[fake.png]]\n```\n\n~~~markdown\n[[Another Fake]]\n~~~\n",
        )
        .unwrap();
        let snapshot = service.refresh_index().unwrap();
        let document = &snapshot.documents[0];
        assert_eq!(
            document
                .wiki_links
                .iter()
                .map(|item| item.target.as_str())
                .collect::<Vec<_>>(),
            vec!["Beta"]
        );
        assert_eq!(
            document
                .embeds
                .iter()
                .map(|item| item.target.as_str())
                .collect::<Vec<_>>(),
            vec!["visible.png"]
        );
    }

    #[test]
    fn backend_index_refreshes_only_changed_documents_and_tracks_renames_and_deletes() {
        let (service, root, _vault) = registered_service("backend-index-delta");
        std::fs::write(root.join("Alpha.md"), "# Alpha\nfirst\n").unwrap();
        std::fs::write(root.join("Beta.md"), "# Beta\nstable\n").unwrap();
        let first = service.refresh_index().unwrap();
        assert_eq!(first.changed_paths, vec!["Alpha.md", "Beta.md"]);
        assert_eq!(service.index_document_read_count(), 2);

        let unchanged = service.refresh_index().unwrap();
        assert_eq!(unchanged.version, first.version);
        assert_eq!(unchanged.changed_paths, first.changed_paths);
        assert_eq!(service.index_document_read_count(), 2);

        std::fs::write(root.join("Alpha.md"), "# Alpha\nchanged body is longer\n").unwrap();
        let edited = service.refresh_index().unwrap();
        assert_eq!(edited.changed_paths, vec!["Alpha.md"]);
        assert_eq!(service.index_document_read_count(), 3);
        // An attachment publisher may refresh before the desktop watcher reads.
        // Reading that same version must not consume its change information.
        let second_reader = service.refresh_index().unwrap();
        assert_eq!(second_reader.version, edited.version);
        assert_eq!(second_reader.changed_paths, edited.changed_paths);

        std::fs::rename(root.join("Beta.md"), root.join("Renamed.md")).unwrap();
        let renamed = service.refresh_index().unwrap();
        assert_eq!(renamed.changed_paths, vec!["Renamed.md"]);
        assert_eq!(renamed.removed_paths, vec!["Beta.md"]);
        assert_eq!(service.index_document_read_count(), 4);
        let second_reader = service.refresh_index().unwrap();
        assert_eq!(second_reader.version, renamed.version);
        assert_eq!(second_reader.changed_paths, renamed.changed_paths);
        assert_eq!(second_reader.removed_paths, renamed.removed_paths);

        std::fs::remove_file(root.join("Alpha.md")).unwrap();
        let deleted = service.refresh_index().unwrap();
        assert_eq!(deleted.removed_paths, vec!["Alpha.md"]);
        assert_eq!(deleted.documents.len(), 1);
        assert_eq!(service.index_document_read_count(), 4);
    }

    #[test]
    fn modified_document_refresh_preserves_inventory_and_reconciles_structural_changes() {
        let (service, root, _vault) = registered_service("modified-document-refresh");
        std::fs::write(root.join("Alpha.md"), "# Alpha\nfirst\n").unwrap();
        std::fs::write(root.join("Beta.md"), "# Beta\nstable\n").unwrap();
        service.refresh_index().unwrap();
        let reads = service.index_document_read_count();
        std::fs::write(root.join("Discovered.md"), "new external note").unwrap();
        std::fs::write(root.join("Alpha.md"), "# Alpha\nlonger edited body ![](image.png)\n").unwrap();
        let edited = service.refresh_modified_documents(&["Alpha.md".into()]).unwrap();
        assert_eq!(edited.documents.len(), 2, "content refresh must not scan the whole Vault");
        assert_eq!(edited.changed_paths, vec!["Alpha.md"]);
        assert_eq!(service.index_document_read_count(), reads + 1);
        let echo = service.refresh_modified_documents(&["Alpha.md".into(), "Alpha.md".into()]).unwrap();
        assert_eq!(echo.version, edited.version);
        assert_eq!(service.index_document_read_count(), reads + 1, "unchanged save echo must reuse parsed content");
        assert!(service.refresh_modified_documents(&["../outside.md".into()]).is_err());
        service.fail_next_index_refresh();
        assert!(service.refresh_index().is_err());
        assert_eq!(service.refresh_modified_documents(&["Alpha.md".into()]).unwrap().documents.len(), 3,
            "a prior full-scan failure requires full recovery, not clearing the global stale state with a partial read");
        assert_eq!(service.refresh_index().unwrap().documents.len(), 3, "full reconciliation still discovers external files");
        std::fs::remove_file(root.join("Alpha.md")).unwrap();
        let removed = service.refresh_modified_documents(&["Alpha.md".into()]).unwrap();
        assert_eq!(removed.removed_paths, vec!["Alpha.md"], "a stale modify observation must reconcile a disappeared file");
    }

    #[test]
    fn legacy_index_identity_must_match_the_trusted_registered_vault() {
        let (service, root, vault) = registered_service("backend-index-legacy-identity");
        std::fs::write(root.join("Alpha.md"), "# Alpha\n").unwrap();
        let (snapshot, trusted_root) = service
            .refresh_index_for_legacy_identity(&vault.id, &vault.root_path)
            .unwrap();
        assert_eq!(snapshot.vault_id, vault.id);
        assert_eq!(trusted_root, root.canonicalize().unwrap());

        let wrong_vault = service
            .refresh_index_for_legacy_identity("vault-other", &vault.root_path)
            .unwrap_err();
        assert_eq!(wrong_vault.code, "knowledge-vault-mismatch");
        let outside = temp_path("backend-index-legacy-outside");
        std::fs::create_dir_all(&outside).unwrap();
        let wrong_root = service
            .refresh_index_for_legacy_identity(&vault.id, &outside.to_string_lossy())
            .unwrap_err();
        assert_eq!(wrong_root.code, "knowledge-vault-mismatch");
    }

    #[test]
    fn backend_index_keeps_last_known_good_document_when_a_changed_file_cannot_parse() {
        let (service, root, _vault) = registered_service("backend-index-stale");
        std::fs::write(root.join("Alpha.md"), "# Alpha\nvalid\n").unwrap();
        let first = service.refresh_index().unwrap();
        let revision = first.documents[0].revision.clone();

        std::fs::write(root.join("Alpha.md"), [0xff, 0xfe, 0xfd, 0x00]).unwrap();
        let stale = service.refresh_index().unwrap();
        assert!(stale.stale);
        assert_eq!(stale.documents.len(), 1);
        assert_eq!(stale.documents[0].revision, revision);
        assert_eq!(stale.errors.len(), 1);
        assert_eq!(stale.errors[0].code, "knowledge-encoding-unsupported");
        assert!(stale.errors[0].stale_document_retained);
    }

    #[test]
    fn failed_refresh_keeps_the_last_known_good_snapshot_available() {
        let (service, root, _vault) = registered_service("backend-index-global-failure");
        std::fs::write(root.join("Alpha.md"), "# Alpha\nvalid\n").unwrap();
        let first = service.refresh_index().unwrap();
        service.fail_next_index_refresh();
        let failure = service.refresh_index().unwrap_err();
        assert_eq!(failure.code, "knowledge-index-refresh-failed");
        let retained = service.index_snapshot().unwrap();
        assert_eq!(retained.version, first.version);
        assert_eq!(retained.documents, first.documents);
        assert!(retained.stale);
        assert_eq!(
            retained
                .refresh_error
                .as_ref()
                .map(|failure| failure.code.as_str()),
            Some("knowledge-index-refresh-failed")
        );
    }

    #[test]
    fn backend_index_relations_are_vault_bound_and_ambiguous_targets_remain_visible() {
        let (service, root, vault) = registered_service("backend-index-relations");
        std::fs::create_dir_all(root.join("one")).unwrap();
        std::fs::create_dir_all(root.join("two")).unwrap();
        std::fs::write(
            root.join("Source.md"),
            "---\ntags: [Project]\n---\n# Source\n[[Target]] [[one/Target]] ![[asset.png]] #inline\n",
        )
        .unwrap();
        std::fs::write(root.join("one/Target.md"), "# One\n").unwrap();
        std::fs::write(root.join("two/Target.md"), "# Two\n").unwrap();
        service.refresh_index().unwrap();

        let one_ref = KnowledgeDocumentRef {
            vault_id: vault.id.clone(),
            relative_path: "one/Target.md".to_string(),
        };
        let backlinks = service.backlinks(&one_ref).unwrap();
        assert_eq!(backlinks.len(), 2);
        assert_eq!(backlinks[0].resolution.status, "ambiguous");
        assert_eq!(backlinks[1].resolution.status, "resolved");
        let tags = service.tag_summary().unwrap();
        assert!(tags
            .iter()
            .any(|tag| tag.name == "Project" && tag.document_count == 1));
        assert!(tags
            .iter()
            .any(|tag| tag.name == "inline" && tag.document_count == 1));
        assert_eq!(service.documents_for_tag("project").unwrap().len(), 1);
        assert_eq!(
            service
                .documents_referencing_embed("asset.png")
                .unwrap()
                .len(),
            1
        );
        let relations = service
            .document_relations(&KnowledgeDocumentRef {
                vault_id: vault.id,
                relative_path: "Source.md".to_string(),
            })
            .unwrap();
        assert_eq!(relations.wiki_links.len(), 2);
        assert_eq!(relations.embeds.len(), 1);
    }

    #[test]
    fn backend_index_resolves_legal_parent_wiki_links_without_root_escape() {
        let (service, root, _vault) = registered_service("backend-index-parent-link");
        std::fs::create_dir_all(root.join("Folder")).unwrap();
        std::fs::write(root.join("Target.md"), "# Target\n").unwrap();
        std::fs::write(
            root.join("Folder/Source.md"),
            "# Source\n[[../Target]] [[../../Outside]]\n",
        )
        .unwrap();
        let snapshot = service.refresh_index().unwrap();
        let source = snapshot
            .documents
            .iter()
            .find(|document| document.relative_path == "Folder/Source.md")
            .unwrap();
        let parent = index::resolve_wiki_target(
            &snapshot,
            &source.document_ref,
            &source.wiki_links[0].target,
        );
        assert_eq!(parent.status, "resolved");
        assert_eq!(parent.document_ref.unwrap().relative_path, "Target.md");
        let escape = index::resolve_wiki_target(
            &snapshot,
            &source.document_ref,
            &source.wiki_links[1].target,
        );
        assert_eq!(escape.status, "unresolved");
        assert!(escape.candidates.is_empty());
    }

    #[test]
    fn backend_index_excludes_internal_metadata_and_reparse_escapes() {
        let (service, root, _vault) = registered_service("backend-index-boundary");
        std::fs::write(root.join("Visible.md"), "# Visible\n").unwrap();
        std::fs::write(root.join(".luckyray/Hidden.md"), "# Hidden\n").unwrap();
        let outside = temp_path("backend-index-boundary-outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("Outside.md"), "# Outside\n").unwrap();
        let link = root.join("Linked");
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args([
                    "/C",
                    "mklink",
                    "/J",
                    link.to_string_lossy().as_ref(),
                    outside.to_string_lossy().as_ref(),
                ])
                .status()
                .expect("junction command must run on Windows");
            assert!(
                status.success(),
                "Windows junction fixture must be available"
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let snapshot = service.refresh_index().unwrap();
        assert_eq!(snapshot.documents.len(), 1);
        assert_eq!(snapshot.documents[0].relative_path, "Visible.md");
        assert!(snapshot
            .errors
            .iter()
            .any(|failure| failure.code == "knowledge-path-reparse-forbidden"));
    }

    #[test]
    fn concurrent_index_requests_are_single_flight_and_a_vault_switch_invalidates_old_scan() {
        let (service, root, _vault) = registered_service("backend-index-concurrent");
        std::fs::write(root.join("Alpha.md"), "# Alpha\n").unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let service = service.clone();
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                service.refresh_index()
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        assert_eq!(service.index_max_active_refreshes(), 1);
        assert_eq!(service.index_document_read_count(), 1);

        std::fs::write(root.join("Alpha.md"), "# Alpha\nchanged\n").unwrap();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        service.set_before_index_document_read({
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            move || {
                entered.wait();
                release.wait();
            }
        });
        let old_service = service.clone();
        let old_scan = std::thread::spawn(move || old_service.refresh_index());
        entered.wait();
        let (next_root, next_vault) = create_registered_vault("backend-index-next-vault");
        std::fs::write(next_root.join("Next.md"), "# Next\n").unwrap();
        service.register_current_vault(&next_vault).unwrap();
        release.wait();
        assert_eq!(
            old_scan.join().unwrap().unwrap_err().code,
            "knowledge-index-generation-stale"
        );
        let next = service.refresh_index().unwrap();
        assert_eq!(next.vault_id, next_vault.id);
        assert_eq!(next.documents[0].relative_path, "Next.md");
    }

    #[cfg(windows)]
    #[test]
    fn set_document_tags_preserves_bytes_outside_the_safe_tag_field_and_refreshes_index() {
        let (service, root, vault) = registered_service("backend-index-set-tags");
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let original = b"\xef\xbb\xbf---\r\ntitle: Example\r\ntags: [old, \"quoted tag\"]\r\ncustom: keep\r\n---\r\n# Body\r\nText\r\n";
        std::fs::write(root.join("Tagged.md"), original).unwrap();
        let initial = service.refresh_index().unwrap();
        let document = &initial.documents[0];
        let result = service
            .set_document_tags_from_ui(
                activation.source_epoch,
                &KnowledgeSetTagsInput {
                    document_ref: document.document_ref.clone(),
                    expected_revision: document.revision.clone(),
                    tags: vec![
                        "Project".to_string(),
                        "project".to_string(),
                        "quoted tag".to_string(),
                    ],
                },
            )
            .unwrap();
        let bytes = std::fs::read(root.join("Tagged.md")).unwrap();
        assert!(bytes.starts_with(&[0xef, 0xbb, 0xbf]));
        let content = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(content.contains("title: Example\r\n"));
        assert!(content.contains("custom: keep\r\n"));
        assert!(content.contains("tags:\r\n  - Project\r\n  - \"quoted tag\"\r\n"));
        assert!(content.ends_with("# Body\r\nText\r\n"));
        assert_eq!(result.document.content, content);
        assert!(result.index_warning.is_none());
        assert!(!result.index_stale);
        let refreshed = service.index_snapshot().unwrap();
        assert_eq!(
            refreshed.documents[0].frontmatter_tags,
            vec!["Project", "quoted tag"]
        );

        let bytes_before_conflict = std::fs::read(root.join("Tagged.md")).unwrap();
        let conflict = service
            .set_document_tags(&KnowledgeSetTagsInput {
                document_ref: result.document.summary.document_ref.clone(),
                expected_revision: document.revision.clone(),
                tags: vec!["stale".to_string()],
            })
            .unwrap_err();
        assert_eq!(conflict.code, "knowledge-revision-conflict");
        assert_eq!(
            std::fs::read(root.join("Tagged.md")).unwrap(),
            bytes_before_conflict
        );

        std::fs::write(
            root.join("Duplicate.md"),
            "---\ntags: [one]\ntag: [two]\n---\nBody\n",
        )
        .unwrap();
        let duplicate = service.refresh_index().unwrap();
        let duplicate = duplicate
            .documents
            .iter()
            .find(|candidate| candidate.relative_path == "Duplicate.md")
            .unwrap();
        let failure = service
            .set_document_tags(&KnowledgeSetTagsInput {
                document_ref: duplicate.document_ref.clone(),
                expected_revision: duplicate.revision.clone(),
                tags: vec!["safe".to_string()],
            })
            .unwrap_err();
        assert_eq!(failure.code, "knowledge-frontmatter-ambiguous");
    }

    #[cfg(windows)]
    #[test]
    fn create_returns_a_committed_warning_when_post_commit_rollback_cannot_be_confirmed() {
        let (service, root, vault) = registered_service("create-post-commit-warning");
        let target = root.join("Committed.md");
        let replacement_root = temp_path("create-post-commit-warning-replacement");
        std::fs::create_dir_all(replacement_root.join(".luckyray")).unwrap();
        let replacement = KnowledgeVaultRegistration {
            id: "replacement-vault".to_string(),
            name: "Replacement".to_string(),
            root_path: replacement_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-28T00:00:00Z".to_string(),
            last_opened_at: "2026-07-28T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        let current_vault_path = service.current_vault_path();
        let target_for_hook = target.clone();
        service.set_after_final_validation_hook(move || {
            std::fs::write(&target_for_hook, "external replacement").unwrap();
            std::fs::write(
                &current_vault_path,
                serde_json::to_vec_pretty(&replacement).unwrap(),
            )
            .unwrap();
        });
        let result = service
            .create_document_for_expected_vault_with_receipt(
                &vault.id,
                &KnowledgeCreateInput {
                    title: "Committed".to_string(),
                    parent_relative_path: None,
                    content: "agent committed bytes".to_string(),
                },
            )
            .unwrap();
        assert!(result.index_stale);
        assert!(result.index_warning.is_some());
        assert_eq!(result.document.content, "agent committed bytes");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "external replacement"
        );
    }

    #[test]
    fn committed_tag_write_returns_an_index_warning_and_later_refresh_converges() {
        let (service, root, vault) = registered_service("backend-index-set-tags-warning");
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let path = root.join("Tagged.md");
        std::fs::write(&path, "---\ntags: [old]\n---\n# Body\n").unwrap();
        let initial = service.refresh_index().unwrap();
        let document = &initial.documents[0];
        service.fail_next_index_refresh();

        let result = service
            .set_document_tags_from_ui(
                activation.source_epoch,
                &KnowledgeSetTagsInput {
                    document_ref: document.document_ref.clone(),
                    expected_revision: document.revision.clone(),
                    tags: vec!["new".to_string()],
                },
            )
            .unwrap();
        assert_eq!(
            result
                .index_warning
                .as_ref()
                .map(|warning| warning.code.as_str()),
            Some("knowledge-index-refresh-failed")
        );
        assert!(result.index_stale);
        assert_ne!(result.document.revision, document.revision);
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("  - new\n"));
        let stale = service.index_snapshot().unwrap();
        assert!(stale.stale);
        assert_eq!(stale.documents[0].revision, document.revision);

        let refreshed = service.refresh_index().unwrap();
        assert!(!refreshed.stale);
        assert!(refreshed.refresh_error.is_none());
        assert_eq!(refreshed.documents[0].revision, result.document.revision);
        assert_eq!(refreshed.documents[0].frontmatter_tags, vec!["new"]);
    }

    #[test]
    fn frontmatter_tag_transform_supports_only_safe_scalar_inline_and_list_shapes() {
        let cases = [
            ("Body\n", "---\ntags:\n  - New\n---\n\nBody\n"),
            (
                "---\ntags: old\nkeep: yes\n---\nBody",
                "---\ntags:\n  - New\nkeep: yes\n---\nBody",
            ),
            (
                "---\ntags: [old, \"quoted tag\"]\nkeep: yes\n---\nBody\n",
                "---\ntags:\n  - New\nkeep: yes\n---\nBody\n",
            ),
            (
                "---\ntags:\n  - old\n\nkeep: yes\n---\nBody\n",
                "---\ntags:\n  - New\n\nkeep: yes\n---\nBody\n",
            ),
        ];
        for (input, expected) in cases {
            let decoded = decode_document(input.as_bytes()).unwrap();
            assert_eq!(
                replace_frontmatter_tags(&decoded, &["New".to_string()]).unwrap(),
                expected
            );
        }
        for input in [
            "---\ntags: [one]\ntag: [two]\n---\nBody\n",
            "---\ntags: [one\n---\nBody\n",
            "---\ntags: |\n  one\n---\nBody\n",
            "---\ntags:\n  nested: bad\n---\nBody\n",
            "---\ntags: one\nBody\n",
        ] {
            let decoded = decode_document(input.as_bytes()).unwrap();
            assert_eq!(
                replace_frontmatter_tags(&decoded, &["New".to_string()])
                    .unwrap_err()
                    .code,
                "knowledge-frontmatter-ambiguous"
            );
        }
    }
}
