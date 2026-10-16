use super::{
    error, has_reparse_point, relative_path_string, sha256_hex, KnowledgeDocumentRef,
    KnowledgeDocumentSummary, KnowledgeError, TrustedVault,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

// The cache is process-local and is cleared on Vault switch/deactivation. Each document read is
// capped at 4 MiB, each retained search representation at 256K Unicode scalar values, and the
// complete snapshot at 50K documents / 128 MiB of retained UTF-8 search text.
const MAX_INDEX_DOCUMENT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SEARCH_TEXT_CHARS: usize = 256 * 1024;
const MAX_INDEX_DOCUMENTS: usize = 50_000;
const MAX_RETAINED_SEARCH_TEXT_BYTES: usize = 128 * 1024 * 1024;
const MAX_STABLE_READ_ATTEMPTS: usize = 3;

/// Bounded, reconstructible file inventory for one attachment operation. No persistent
/// store is created. Reparse entries make mutation planning fail closed rather than
/// silently pretending that an incomplete inventory proves a basename unique.
pub(super) fn attachment_inventory(root: &Path) -> Result<Vec<String>, KnowledgeError> {
    let mut pending = vec![PathBuf::new()];
    let mut files = Vec::new();
    let mut visited = 0usize;
    while let Some(relative) = pending.pop() {
        let directory = super::safe_existing_directory(root, &relative)?;
        let entries = std::fs::read_dir(directory).map_err(|_| error("knowledge-index-read-dir-failed", "Cannot enumerate Vault attachments"))?;
        for entry in entries {
            let entry = entry.map_err(|_| error("knowledge-index-read-dir-failed", "Cannot inspect Vault attachment"))?;
            visited += 1;
            if visited > 100_000 { return Err(error("knowledge-index-capacity", "Vault attachment inventory exceeds 100000 entries")); }
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| error("knowledge-path-unavailable", "Vault filename is not Unicode"))?;
            if [".luckyray", ".obsidian", ".git"].iter().any(|reserved| name.eq_ignore_ascii_case(reserved)) || name.starts_with(".lrk-") { continue; }
            if has_reparse_point(&entry.path())? { return Err(error("knowledge-path-reparse-forbidden", "Vault attachment inventory contains a linked path")); }
            let child = relative.join(name);
            let kind = entry.file_type().map_err(|_| error("knowledge-index-metadata-failed", "Cannot inspect Vault attachment"))?;
            if kind.is_dir() { pending.push(child); }
            else if kind.is_file() {
                super::safe_existing_file(root, &child)?;
                files.push(relative_path_string(&child));
            }
        }
    }
    files.sort();
    Ok(files)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeIndexHeading {
    pub level: u8,
    pub text: String,
    pub slug: String,
    pub line: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeIndexWikiLink {
    pub raw: String,
    pub target: String,
    pub alias: Option<String>,
    pub line: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeIndexEmbed {
    pub raw: String,
    pub target: String,
    pub kind: Option<String>,
    pub line: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeIndexDocument {
    pub document_ref: KnowledgeDocumentRef,
    pub relative_path: String,
    pub file_name: String,
    pub title: String,
    pub revision: String,
    pub headings: Vec<KnowledgeIndexHeading>,
    pub wiki_links: Vec<KnowledgeIndexWikiLink>,
    pub embeds: Vec<KnowledgeIndexEmbed>,
    pub tags: Vec<String>,
    pub frontmatter_tags: Vec<String>,
    pub inline_tags: Vec<String>,
    pub plain_text: String,
    pub excerpt: String,
    pub content_length: usize,
    pub modified_at: Option<String>,
    pub size: u64,
}

impl KnowledgeIndexDocument {
    pub(crate) fn summary(&self) -> KnowledgeDocumentSummary {
        KnowledgeDocumentSummary {
            document_ref: self.document_ref.clone(),
            title: self.title.clone(),
            relative_path: self.relative_path.clone(),
            modified_at: self.modified_at.clone(),
            size: self.size,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeIndexError {
    pub code: String,
    pub message: String,
    pub document_ref: KnowledgeDocumentRef,
    pub relative_path: String,
    pub stale_document_retained: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeIndexSnapshot {
    pub vault_id: String,
    pub generation: u64,
    pub built_at: String,
    pub documents: Vec<KnowledgeIndexDocument>,
    pub errors: Vec<KnowledgeIndexError>,
    pub version: u64,
    pub changed_paths: Vec<String>,
    pub removed_paths: Vec<String>,
    pub stale: bool,
    pub refresh_error: Option<KnowledgeIndexRefreshFailure>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeIndexRefreshFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentRelations {
    pub document_ref: KnowledgeDocumentRef,
    pub headings: Vec<KnowledgeIndexHeading>,
    pub wiki_links: Vec<KnowledgeIndexWikiLink>,
    pub embeds: Vec<KnowledgeIndexEmbed>,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeWikiResolution {
    pub status: String,
    pub document_ref: Option<KnowledgeDocumentRef>,
    pub candidates: Vec<KnowledgeDocumentRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeBacklink {
    pub source_ref: KnowledgeDocumentRef,
    pub link: KnowledgeIndexWikiLink,
    pub resolution: KnowledgeWikiResolution,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeTagSummary {
    pub name: String,
    pub document_count: usize,
}

pub(crate) fn resolve_wiki_target(
    snapshot: &KnowledgeIndexSnapshot,
    source_ref: &KnowledgeDocumentRef,
    raw_target: &str,
) -> KnowledgeWikiResolution {
    let target = raw_target
        .split('#')
        .next()
        .unwrap_or("")
        .trim()
        .replace('\\', "/");
    if target.is_empty() || target.starts_with('/') || target.contains(':') {
        return KnowledgeWikiResolution {
            status: "unresolved".to_string(),
            document_ref: None,
            candidates: Vec::new(),
        };
    }
    let source_parent = Path::new(&source_ref.relative_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let target_with_extension = if target.to_ascii_lowercase().ends_with(".md") {
        target.clone()
    } else {
        format!("{target}.md")
    };
    let Some(relative_candidate) =
        normalize_relative_candidate(&source_parent.join(&target_with_extension))
    else {
        return KnowledgeWikiResolution {
            status: "unresolved".to_string(),
            document_ref: None,
            candidates: Vec::new(),
        };
    };
    let target_name = Path::new(&target_with_extension)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("");
    let target_has_directory = target.contains('/');
    let mut candidates = snapshot
        .documents
        .iter()
        .filter(|document| {
            document
                .relative_path
                .eq_ignore_ascii_case(&target_with_extension)
                || document
                    .relative_path
                    .eq_ignore_ascii_case(&relative_candidate)
                || (!target_has_directory
                    && Path::new(&document.relative_path)
                        .file_stem()
                        .and_then(OsStr::to_str)
                        .is_some_and(|stem| stem.eq_ignore_ascii_case(target_name)))
        })
        .map(|document| document.document_ref.clone())
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    candidates.dedup();
    match candidates.as_slice() {
        [document_ref] => KnowledgeWikiResolution {
            status: "resolved".to_string(),
            document_ref: Some(document_ref.clone()),
            candidates,
        },
        [] => KnowledgeWikiResolution {
            status: "unresolved".to_string(),
            document_ref: None,
            candidates,
        },
        _ => KnowledgeWikiResolution {
            status: "ambiguous".to_string(),
            document_ref: None,
            candidates,
        },
    }
}

fn normalize_relative_candidate(path: &Path) -> Option<String> {
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => segments.push(segment.to_str()?.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                segments.pop()?;
            }
            Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct KnowledgeIndexFingerprint {
    size: u64,
    modified_nanos: u128,
    identity: Option<KnowledgeIndexFileIdentity>,
}

impl KnowledgeIndexFingerprint {
    fn can_reuse(&self, current: &Self) -> bool {
        self.identity.is_some() && current.identity.is_some() && self == current
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct KnowledgeIndexFileIdentity {
    device: u64,
    file: u64,
    change_seconds: i64,
    change_nanos: i64,
}

struct OpenIndexDocument {
    file: File,
    metadata: Metadata,
    fingerprint: KnowledgeIndexFingerprint,
}

#[derive(Clone)]
struct KnowledgeIndexEntry {
    fingerprint: KnowledgeIndexFingerprint,
    document: KnowledgeIndexDocument,
}

#[derive(Default)]
struct KnowledgeIndexCapacity {
    documents: usize,
    search_text_bytes: usize,
}

impl KnowledgeIndexCapacity {
    fn include(&mut self, document: &KnowledgeIndexDocument) -> Result<(), KnowledgeError> {
        let documents = self.documents.saturating_add(1);
        let search_text_bytes = self
            .search_text_bytes
            .checked_add(document.plain_text.len())
            .ok_or_else(index_capacity_error)?;
        if documents > MAX_INDEX_DOCUMENTS || search_text_bytes > MAX_RETAINED_SEARCH_TEXT_BYTES {
            return Err(index_capacity_error());
        }
        self.documents = documents;
        self.search_text_bytes = search_text_bytes;
        Ok(())
    }
}

fn index_capacity_error() -> KnowledgeError {
    error(
        "knowledge-index-capacity-exceeded",
        "Knowledge index capacity was exceeded",
    )
}

#[derive(Default)]
struct KnowledgeIndexState {
    generation: u64,
    completed_refreshes: u64,
    vault_id: Option<String>,
    root: Option<PathBuf>,
    version: u64,
    built_at: String,
    documents: HashMap<String, KnowledgeIndexEntry>,
    errors: Vec<KnowledgeIndexError>,
    changed_paths: Vec<String>,
    removed_paths: Vec<String>,
    stale: bool,
    refresh_error: Option<KnowledgeIndexRefreshFailure>,
    dirty_paths: HashSet<String>,
}

#[derive(Clone, Default)]
pub(crate) struct KnowledgeIndex {
    state: Arc<Mutex<KnowledgeIndexState>>,
    refresh_lock: Arc<Mutex<()>>,
    #[cfg(test)]
    document_reads: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    active_refreshes: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    max_active_refreshes: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    before_document_read: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
    #[cfg(test)]
    fail_next_refresh: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(test)]
    fail_next_mark_dirty: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(test)]
    force_unreliable_identity: Arc<std::sync::atomic::AtomicBool>,
}

impl KnowledgeIndex {
    pub(crate) fn invalidate(&self) -> Result<(), KnowledgeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
        state.generation = state.generation.saturating_add(1).max(1);
        state.vault_id = None;
        state.root = None;
        state.documents.clear();
        state.errors.clear();
        state.changed_paths.clear();
        state.removed_paths.clear();
        state.stale = false;
        state.refresh_error = None;
        state.dirty_paths.clear();
        Ok(())
    }

    pub(crate) fn refresh(
        &self,
        vault: &TrustedVault,
    ) -> Result<KnowledgeIndexSnapshot, KnowledgeError> {
        let (request_generation, observed_refreshes) = {
            let state = self
                .state
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
            (state.generation, state.completed_refreshes)
        };
        let _refresh_guard = self.refresh_lock.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge index refresh lock failed",
            )
        })?;

        {
            let state = self
                .state
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
            if state.generation != request_generation {
                return Err(error(
                    "knowledge-index-generation-stale",
                    "Knowledge index request belongs to a stale Vault generation",
                ));
            }
            if state.completed_refreshes > observed_refreshes
                && state.vault_id.as_deref() == Some(vault.registration.id.as_str())
                && state.root.as_deref() == Some(vault.root.as_path())
            {
                return snapshot_from_state(&state);
            }
        }

        #[cfg(test)]
        let _activity = RefreshActivity::begin(self);

        let (previous, dirty_paths) = {
            let state = self
                .state
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
            if state.vault_id.as_deref() == Some(vault.registration.id.as_str())
                && state.root.as_deref() == Some(vault.root.as_path())
            {
                (state.documents.clone(), state.dirty_paths.clone())
            } else {
                (HashMap::new(), HashSet::new())
            }
        };
        #[cfg(test)]
        if self
            .fail_next_refresh
            .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            let failure = error(
                "knowledge-index-refresh-failed",
                "Knowledge index refresh failed",
            );
            self.record_refresh_failure(request_generation, &failure)?;
            return Err(failure);
        }
        let mut next = HashMap::new();
        let mut errors = Vec::new();
        let mut changed_paths = Vec::new();
        let mut capacity = KnowledgeIndexCapacity::default();
        if let Err(failure) = scan_directory(
            self,
            vault,
            request_generation,
            &vault.root,
            Path::new(""),
            &previous,
            &dirty_paths,
            &mut next,
            &mut errors,
            &mut changed_paths,
            &mut capacity,
        ) {
            self.record_refresh_failure(request_generation, &failure)?;
            return Err(failure);
        }
        let mut removed_paths = previous
            .keys()
            .filter(|path| !next.contains_key(*path))
            .cloned()
            .collect::<Vec<_>>();
        changed_paths.sort();
        removed_paths.sort();

        let mut state = self
            .state
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
        if state.generation != request_generation {
            return Err(error(
                "knowledge-index-generation-stale",
                "Knowledge index refresh was superseded by a Vault change",
            ));
        }
        let vault_changed = state.vault_id.as_deref() != Some(vault.registration.id.as_str())
            || state.root.as_deref() != Some(vault.root.as_path());
        let errors_changed = state.errors != errors;
        if vault_changed
            || state.version == 0
            || !changed_paths.is_empty()
            || !removed_paths.is_empty()
            || errors_changed
        {
            state.version = state.version.saturating_add(1).max(1);
            // Deltas describe this version, not the latest reader's scan.
            // Attachment publication and desktop watchers read independently.
            state.changed_paths = changed_paths;
            state.removed_paths = removed_paths;
        }
        state.vault_id = Some(vault.registration.id.clone());
        state.root = Some(vault.root.clone());
        state.documents = next;
        state.errors = errors;
        state.stale = state
            .errors
            .iter()
            .any(|failure| failure.stale_document_retained);
        state.refresh_error = None;
        state.dirty_paths.clear();
        state.built_at = chrono::Utc::now().to_rfc3339();
        state.completed_refreshes = state.completed_refreshes.saturating_add(1).max(1);
        snapshot_from_state(&state)
    }

    /// Refresh known modified documents without enumerating the Vault. Structural
    /// or uncertain observations use refresh(); this shares its cache and lock.
    pub(crate) fn refresh_modified(
        &self,
        vault: &TrustedVault,
        paths: &[String],
    ) -> Result<KnowledgeIndexSnapshot, KnowledgeError> {
        if paths.is_empty() || paths.len() > 256 { return self.refresh(vault); }
        let paths = paths.iter().map(|path| super::safe_markdown_relative_path(path)
            .map(|relative| relative_path_string(&relative))).collect::<Result<HashSet<_>, _>>()?;
        let guard = self.refresh_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge index refresh lock failed"))?;
        let (generation, previous, dirty, mut errors) = {
            let state = self.state.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
            if state.vault_id.as_deref() != Some(vault.registration.id.as_str()) || state.root.as_deref() != Some(vault.root.as_path())
                || state.version == 0 || state.stale || state.refresh_error.is_some()
                || paths.iter().any(|path| !state.documents.contains_key(path)) {
                drop(state); drop(guard); return self.refresh(vault);
            }
            (state.generation, state.documents.clone(), state.dirty_paths.clone(), state.errors.clone())
        };
        let mut next = previous;
        let mut changed = Vec::new();
        errors.retain(|failure| !paths.contains(&failure.relative_path));
        for path in &paths {
            self.ensure_generation(generation)?;
            let relative = Path::new(path);
            let absolute = match super::safe_existing_file(&vault.root, relative) {
                Ok(path) => path,
                // A file disappeared or became unsafe after the observation.
                // Full reconciliation owns removal and structural diagnostics.
                Err(_) => { drop(guard); return self.refresh(vault); }
            };
            let opened = match open_index_document(self, vault, &absolute) {
                Ok(opened) => opened,
                Err(failure) => { self.record_refresh_failure(generation, &failure)?; return Err(failure); }
            };
            if !dirty.contains(path) && next[path].fingerprint.can_reuse(&opened.fingerprint) { continue; }
            match parse_document(self, vault, &absolute, relative, opened) {
                Ok((document, fingerprint)) => {
                    if next[path].document != document { changed.push(path.clone()); }
                    next.insert(path.clone(), KnowledgeIndexEntry { document, fingerprint });
                }
                Err(failure) => errors.push(KnowledgeIndexError {
                    code: failure.code.to_string(), message: failure.message,
                    document_ref: KnowledgeDocumentRef { vault_id: vault.registration.id.clone(), relative_path: path.clone() },
                    relative_path: path.clone(), stale_document_retained: true,
                }),
            }
        }
        let mut capacity = KnowledgeIndexCapacity::default();
        for entry in next.values() { capacity.include(&entry.document)?; }
        changed.sort(); errors.sort_by(|a,b| a.relative_path.cmp(&b.relative_path));
        let mut state = self.state.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
        if state.generation != generation { return Err(error("knowledge-index-generation-stale", "Modified document refresh belongs to a stale Vault generation")); }
        if !changed.is_empty() || state.errors != errors {
            state.version = state.version.saturating_add(1).max(1);
            state.changed_paths = changed;
            state.removed_paths.clear();
        }
        state.documents = next;
        state.errors = errors;
        state.stale = state.errors.iter().any(|failure| failure.stale_document_retained);
        state.refresh_error = None;
        for path in &paths { state.dirty_paths.remove(path); }
        state.built_at = chrono::Utc::now().to_rfc3339();
        // Do not count this as a completed full scan: a waiting full refresh
        // still has to discover unrelated structural/external changes.
        snapshot_from_state(&state)
    }

    pub(crate) fn snapshot(
        &self,
        vault: &TrustedVault,
    ) -> Result<KnowledgeIndexSnapshot, KnowledgeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
        if state.vault_id.as_deref() != Some(vault.registration.id.as_str())
            || state.root.as_deref() != Some(vault.root.as_path())
            || state.version == 0
        {
            return Err(error(
                "knowledge-index-not-ready",
                "Knowledge index has not been built for the current Vault",
            ));
        }
        snapshot_from_state(&state)
    }

    fn record_refresh_failure(
        &self,
        generation: u64,
        failure: &KnowledgeError,
    ) -> Result<(), KnowledgeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
        if state.generation == generation && state.version > 0 {
            state.stale = true;
            state.refresh_error = Some(KnowledgeIndexRefreshFailure {
                code: failure.code.to_string(),
                message: failure.message.clone(),
            });
        }
        Ok(())
    }

    fn ensure_generation(&self, generation: u64) -> Result<(), KnowledgeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
        if state.generation != generation {
            return Err(error(
                "knowledge-index-generation-stale",
                "Knowledge index refresh was superseded by a Vault change",
            ));
        }
        Ok(())
    }

    fn fingerprint(
        &self,
        file: &File,
        metadata: &Metadata,
        path: &Path,
    ) -> KnowledgeIndexFingerprint {
        let identity = reliable_file_identity(file, metadata, path);
        #[cfg(test)]
        let identity = if self
            .force_unreliable_identity
            .load(std::sync::atomic::Ordering::Acquire)
        {
            None
        } else {
            identity
        };
        KnowledgeIndexFingerprint {
            size: metadata.len(),
            modified_nanos: metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_nanos())
                .unwrap_or_default(),
            identity,
        }
    }

    pub(crate) fn mark_document_dirty(
        &self,
        document_ref: &KnowledgeDocumentRef,
    ) -> Result<(), KnowledgeError> {
        #[cfg(test)]
        if self
            .fail_next_mark_dirty
            .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(error(
                "knowledge-index-dirty-failed",
                "Knowledge index dirty marker failed",
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge index lock failed"))?;
        if state.vault_id.as_deref() == Some(document_ref.vault_id.as_str()) {
            state.dirty_paths.insert(document_ref.relative_path.clone());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn document_read_count(&self) -> usize {
        self.document_reads
            .load(std::sync::atomic::Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn max_active_refreshes(&self) -> usize {
        self.max_active_refreshes
            .load(std::sync::atomic::Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn set_before_document_read(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self
            .before_document_read
            .lock()
            .expect("knowledge index read hook lock") = Some(Arc::new(hook));
    }

    #[cfg(test)]
    pub(crate) fn fail_next_refresh(&self) {
        self.fail_next_refresh
            .store(true, std::sync::atomic::Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_mark_dirty(&self) {
        self.fail_next_mark_dirty
            .store(true, std::sync::atomic::Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn force_unreliable_identity(&self, enabled: bool) {
        self.force_unreliable_identity
            .store(enabled, std::sync::atomic::Ordering::Release);
    }
}

fn snapshot_from_state(
    state: &KnowledgeIndexState,
) -> Result<KnowledgeIndexSnapshot, KnowledgeError> {
    let vault_id = state.vault_id.clone().ok_or_else(|| {
        error(
            "knowledge-index-not-ready",
            "Knowledge index has not been built",
        )
    })?;
    let mut documents = state
        .documents
        .values()
        .map(|entry| entry.document.clone())
        .collect::<Vec<_>>();
    documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(KnowledgeIndexSnapshot {
        vault_id,
        generation: state.generation,
        built_at: state.built_at.clone(),
        documents,
        errors: state.errors.clone(),
        version: state.version,
        changed_paths: state.changed_paths.clone(),
        removed_paths: state.removed_paths.clone(),
        stale: state.stale,
        refresh_error: state.refresh_error.clone(),
    })
}

#[allow(clippy::too_many_arguments)]
fn scan_directory(
    index: &KnowledgeIndex,
    vault: &TrustedVault,
    request_generation: u64,
    directory: &Path,
    relative_directory: &Path,
    previous: &HashMap<String, KnowledgeIndexEntry>,
    dirty_paths: &HashSet<String>,
    next: &mut HashMap<String, KnowledgeIndexEntry>,
    errors: &mut Vec<KnowledgeIndexError>,
    changed_paths: &mut Vec<String>,
    capacity: &mut KnowledgeIndexCapacity,
) -> Result<(), KnowledgeError> {
    let entries = std::fs::read_dir(directory).map_err(|_| {
        error(
            "knowledge-index-read-dir-failed",
            "Knowledge index could not read a Vault directory",
        )
    })?;
    let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(|_| {
        error(
            "knowledge-index-read-dir-failed",
            "Knowledge index could not enumerate a Vault directory",
        )
    })?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());

    for entry in entries {
        index.ensure_generation(request_generation)?;
        let name = entry.file_name();
        if name.to_string_lossy().eq_ignore_ascii_case(".luckyray") {
            continue;
        }
        let relative = relative_directory.join(&name);
        let relative_path = relative_path_string(&relative);
        let document_ref = KnowledgeDocumentRef {
            vault_id: vault.registration.id.clone(),
            relative_path: relative_path.clone(),
        };
        if has_reparse_point(&entry.path())? {
            errors.push(KnowledgeIndexError {
                code: "knowledge-path-reparse-forbidden".to_string(),
                message: "Knowledge index skipped a linked or reparse path".to_string(),
                document_ref,
                relative_path,
                stale_document_retained: false,
            });
            continue;
        }
        let file_type = entry.file_type().map_err(|_| {
            error(
                "knowledge-index-metadata-failed",
                "Knowledge index could not inspect a Vault entry",
            )
        })?;
        if file_type.is_dir() {
            scan_directory(
                index,
                vault,
                request_generation,
                &entry.path(),
                &relative,
                previous,
                dirty_paths,
                next,
                errors,
                changed_paths,
                capacity,
            )?;
            continue;
        }
        if !file_type.is_file()
            || !relative
                .extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let opened = open_index_document(index, vault, &entry.path())?;
        if !dirty_paths.contains(&relative_path) {
            if let Some(cached) = previous.get(&relative_path) {
                if cached.fingerprint.can_reuse(&opened.fingerprint) {
                    capacity.include(&cached.document)?;
                    next.insert(relative_path, cached.clone());
                    continue;
                }
            }
        }
        match parse_document(index, vault, &entry.path(), &relative, opened) {
            Ok((document, fingerprint)) => {
                capacity.include(&document)?;
                changed_paths.push(relative_path.clone());
                next.insert(
                    relative_path,
                    KnowledgeIndexEntry {
                        fingerprint,
                        document,
                    },
                );
            }
            Err(failure) => {
                let stale_document_retained = if let Some(entry) = previous.get(&relative_path) {
                    capacity.include(&entry.document)?;
                    next.insert(relative_path.clone(), entry.clone());
                    true
                } else {
                    false
                };
                errors.push(KnowledgeIndexError {
                    code: failure.code.to_string(),
                    message: failure.message,
                    document_ref,
                    relative_path,
                    stale_document_retained,
                });
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn reliable_file_identity(
    file: &File,
    _metadata: &Metadata,
    path: &Path,
) -> Option<KnowledgeIndexFileIdentity> {
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
    #[repr(C)]
    struct FileBasicInfo {
        creation_time: i64,
        last_access_time: i64,
        last_write_time: i64,
        change_time: i64,
        file_attributes: u32,
    }
    const FILE_BASIC_INFO_CLASS: i32 = 0;
    #[link(name = "kernel32")]
    extern "system" {
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
        fn GetFileInformationByHandleEx(
            file: *mut std::ffi::c_void,
            information_class: i32,
            information: *mut std::ffi::c_void,
            information_size: u32,
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
        return None;
    }
    let mut identity = std::mem::MaybeUninit::<ByHandleFileInformation>::zeroed();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), identity.as_mut_ptr()) } == 0 {
        return None;
    }
    let identity = unsafe { identity.assume_init() };
    let volume = u64::from(identity.volume_serial_number);
    let file_index =
        (u64::from(identity.file_index_high) << 32) | u64::from(identity.file_index_low);
    if volume == 0 || file_index == 0 {
        return None;
    }
    let mut basic = std::mem::MaybeUninit::<FileBasicInfo>::zeroed();
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FILE_BASIC_INFO_CLASS,
            basic.as_mut_ptr().cast(),
            std::mem::size_of::<FileBasicInfo>() as u32,
        )
    };
    if result == 0 {
        return None;
    }
    let basic = unsafe { basic.assume_init() };
    if basic.change_time == 0 {
        return None;
    }
    Some(KnowledgeIndexFileIdentity {
        device: volume,
        file: file_index,
        change_seconds: basic.change_time,
        change_nanos: 0,
    })
}

#[cfg(unix)]
fn reliable_file_identity(
    _file: &File,
    metadata: &Metadata,
    _path: &Path,
) -> Option<KnowledgeIndexFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    if metadata.dev() == 0
        || metadata.ino() == 0
        || (metadata.ctime() == 0 && metadata.ctime_nsec() == 0)
    {
        return None;
    }
    Some(KnowledgeIndexFileIdentity {
        device: metadata.dev(),
        file: metadata.ino(),
        change_seconds: metadata.ctime(),
        change_nanos: metadata.ctime_nsec(),
    })
}

#[cfg(not(any(windows, unix)))]
fn reliable_file_identity(
    _file: &File,
    _metadata: &Metadata,
    _path: &Path,
) -> Option<KnowledgeIndexFileIdentity> {
    None
}

#[cfg(windows)]
fn attachment_link_count(file: &File, _metadata: &Metadata) -> Option<u64> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct StandardInfo { allocation_size: i64, end_of_file: i64, links: u32, delete_pending: u8, directory: u8 }
    #[link(name = "kernel32")]
    extern "system" { fn GetFileInformationByHandleEx(file: *mut std::ffi::c_void, class: i32, info: *mut std::ffi::c_void, size: u32) -> i32; }
    let mut info = std::mem::MaybeUninit::<StandardInfo>::zeroed();
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), 1, info.as_mut_ptr().cast(), std::mem::size_of::<StandardInfo>() as u32) } == 0 { return None; }
    Some(u64::from(unsafe { info.assume_init() }.links))
}
#[cfg(unix)]
fn attachment_link_count(_file: &File, metadata: &Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.nlink())
}
#[cfg(not(any(windows, unix)))]
fn attachment_link_count(_file: &File, _metadata: &Metadata) -> Option<u64> { None }

/// Object identity only: renaming may change freshness timestamps, but not this pair.
pub(super) fn attachment_object_identity(file: &File, path: &Path) -> Option<(u64, u64)> {
    let metadata = file.metadata().ok()?;
    if attachment_link_count(file, &metadata)? != 1 { return None; }
    reliable_file_identity(file, &metadata, path).map(|value| (value.device, value.file))
}

#[cfg(windows)]
fn open_index_file(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_index_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn open_index_document(
    index: &KnowledgeIndex,
    vault: &TrustedVault,
    path: &Path,
) -> Result<OpenIndexDocument, KnowledgeError> {
    let file = open_index_file(path).map_err(|_| {
        error(
            "knowledge-index-read-failed",
            "Knowledge index could not open a Markdown document",
        )
    })?;
    let metadata = file.metadata().map_err(|_| {
        error(
            "knowledge-index-metadata-failed",
            "Knowledge index could not inspect a Markdown document",
        )
    })?;
    if !metadata.is_file() || has_reparse_point(path)? {
        return Err(error(
            "knowledge-path-reparse-forbidden",
            "Knowledge index skipped a linked or reparse path",
        ));
    }
    let canonical = path.canonicalize().map_err(|_| {
        error(
            "knowledge-index-read-failed",
            "Knowledge index could not resolve a Markdown document",
        )
    })?;
    if !canonical.starts_with(&vault.root) {
        return Err(error(
            "knowledge-path-escape",
            "Knowledge document path escapes the current Vault",
        ));
    }
    let fingerprint = index.fingerprint(&file, &metadata, path);
    Ok(OpenIndexDocument {
        file,
        metadata,
        fingerprint,
    })
}

fn read_stable_document(
    _index: &KnowledgeIndex,
    vault: &TrustedVault,
    path: &Path,
    mut opened: OpenIndexDocument,
) -> Result<(Vec<u8>, Metadata, KnowledgeIndexFingerprint), KnowledgeError> {
    for attempt in 0..MAX_STABLE_READ_ATTEMPTS {
        if opened.metadata.len() > MAX_INDEX_DOCUMENT_BYTES {
            return Err(error(
                "knowledge-index-document-too-large",
                "Knowledge index skipped a Markdown document larger than 4 MiB",
            ));
        }
        #[cfg(test)]
        if let Some(hook) = _index
            .before_document_read
            .lock()
            .expect("knowledge index read hook lock")
            .take()
        {
            hook();
        }
        #[cfg(test)]
        _index
            .document_reads
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        opened.file.seek(SeekFrom::Start(0)).map_err(|_| {
            error(
                "knowledge-index-read-failed",
                "Knowledge index could not read a Markdown document",
            )
        })?;
        let mut bytes = Vec::with_capacity(opened.metadata.len() as usize);
        opened.file.read_to_end(&mut bytes).map_err(|_| {
            error(
                "knowledge-index-read-failed",
                "Knowledge index could not read a Markdown document",
            )
        })?;
        let after_metadata = opened.file.metadata().map_err(|_| {
            error(
                "knowledge-index-metadata-failed",
                "Knowledge index could not verify a Markdown document after reading",
            )
        })?;
        let after_fingerprint = _index.fingerprint(&opened.file, &after_metadata, path);
        if opened.fingerprint == after_fingerprint {
            return Ok((bytes, after_metadata, after_fingerprint));
        }
        if attempt + 1 < MAX_STABLE_READ_ATTEMPTS {
            opened = open_index_document(_index, vault, path)?;
        }
    }
    Err(error(
        "knowledge-index-document-changing",
        "Knowledge document changed while the index was reading it",
    ))
}

fn parse_document(
    index: &KnowledgeIndex,
    vault: &TrustedVault,
    path: &Path,
    relative: &Path,
    opened: OpenIndexDocument,
) -> Result<(KnowledgeIndexDocument, KnowledgeIndexFingerprint), KnowledgeError> {
    let (bytes, metadata, fingerprint) = read_stable_document(index, vault, path, opened)?;
    let content_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let content = String::from_utf8(content_bytes.to_vec()).map_err(|_| {
        error(
            "knowledge-encoding-unsupported",
            "Knowledge documents must use UTF-8",
        )
    })?;
    let mut headings = Vec::new();
    let mut wiki_links = Vec::new();
    let mut embeds = Vec::new();
    let mut frontmatter_tags = HashSet::new();
    let mut inline_tags = HashSet::new();
    parse_frontmatter_tags(&content, &mut frontmatter_tags);
    parse_inline_tags(&content, &mut inline_tags);
    let mut fence_marker: Option<&str> = None;
    for (index, line) in content.lines().enumerate() {
        let line_number = index + 1;
        if let Some(marker) = fence_marker_for(line) {
            if fence_marker == Some(marker) {
                fence_marker = None;
            } else if fence_marker.is_none() {
                fence_marker = Some(marker);
            }
            continue;
        }
        if fence_marker.is_some() {
            continue;
        }
        if let Some(heading) = parse_heading(line, line_number) {
            headings.push(heading);
        }
    }
    for link in super::markdown_links::attachment_links(&content) {
        let raw = content[link.span].to_owned();
        // Index display candidates, including published external files. Actual
        // access still passes through the registered-path attachment resolver.
        let local_file = link.destination.to_ascii_lowercase().starts_with("file://")
            || (link.destination.as_bytes().get(1) == Some(&b':')
                && link.destination.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && matches!(link.destination.as_bytes().get(2), Some(b'/' | b'\\')));
        let local_attachment_link = link.syntax == super::markdown_links::LinkSyntax::Markdown
            && (local_file || !link.destination.contains(':')) && !link.destination.starts_with('#')
            && !link.destination.split('#').next().unwrap_or("").to_ascii_lowercase().ends_with(".md");
        if link.embedded || local_attachment_link {
            let path_target = link.destination.split('#').next().unwrap_or(&link.destination);
            let kind = Path::new(path_target).extension().and_then(OsStr::to_str).map(str::to_ascii_lowercase);
            embeds.push(KnowledgeIndexEmbed { raw, target: link.destination, kind, line: link.line });
        } else if link.syntax == super::markdown_links::LinkSyntax::Wiki {
            wiki_links.push(KnowledgeIndexWikiLink { raw, target: link.destination, alias: link.alias, line: link.line });
        }
    }
    let relative_path = relative_path_string(relative);
    let fallback_title = relative
        .file_stem()
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled")
        .to_string();
    let title = headings
        .iter()
        .find(|heading| heading.level == 1)
        .map(|heading| heading.text.clone())
        .unwrap_or(fallback_title);
    let full_plain_text = markdown_plain_text(&content);
    let plain_text = full_plain_text
        .chars()
        .take(MAX_SEARCH_TEXT_CHARS)
        .collect::<String>();
    let excerpt = plain_text.chars().take(240).collect::<String>();
    let mut tags = frontmatter_tags.clone();
    tags.extend(inline_tags.iter().cloned());
    let mut tags = tags.into_iter().collect::<Vec<_>>();
    let mut frontmatter_tags = frontmatter_tags.into_iter().collect::<Vec<_>>();
    let mut inline_tags = inline_tags.into_iter().collect::<Vec<_>>();
    sort_tags(&mut tags);
    sort_tags(&mut frontmatter_tags);
    sort_tags(&mut inline_tags);
    let modified_at = metadata.modified().ok().map(|time| {
        let value: chrono::DateTime<chrono::Utc> = time.into();
        value.to_rfc3339()
    });
    Ok((
        KnowledgeIndexDocument {
            document_ref: KnowledgeDocumentRef {
                vault_id: vault.registration.id.clone(),
                relative_path: relative_path.clone(),
            },
            relative_path,
            file_name: path
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or("")
                .to_string(),
            title,
            revision: sha256_hex(&bytes),
            headings,
            wiki_links,
            embeds,
            tags,
            frontmatter_tags,
            inline_tags,
            plain_text,
            excerpt,
            content_length: content.len(),
            modified_at,
            size: metadata.len(),
        },
        fingerprint,
    ))
}

fn sort_tags(tags: &mut [String]) {
    tags.sort_by_key(|tag| tag.to_lowercase());
}

fn heading_slug(text: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for character in text.trim().to_lowercase().chars() {
        if character.is_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character);
            pending_dash = false;
        } else if character.is_whitespace() || matches!(character, '-' | '_') {
            pending_dash = true;
        }
    }
    if slug.is_empty() {
        "heading".to_string()
    } else {
        slug
    }
}

fn parse_heading(line: &str, line_number: usize) -> Option<KnowledgeIndexHeading> {
    let trimmed = line.trim_start();
    let level = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.starts_with(' ') {
        return None;
    }
    let text = rest.trim().trim_matches('#').trim().to_string();
    (!text.is_empty()).then(|| KnowledgeIndexHeading {
        level: level as u8,
        slug: heading_slug(&text),
        text,
        line: line_number,
    })
}

pub(crate) fn normalize_embed_target(value: &str) -> String {
    let mut cleaned = String::new();
    for character in value.chars() {
        match character {
            '\u{FEFF}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' => {}
            '\u{00A0}'
            | '\u{1680}'
            | '\u{180E}'
            | '\u{2000}'..='\u{200A}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}' => cleaned.push(' '),
            _ => cleaned.push(character),
        }
    }
    let mut unescaped = String::new();
    let mut characters = cleaned.trim().chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\\' {
            if let Some(next) = characters.peek().copied() {
                if matches!(
                    next,
                    '\\' | '`'
                        | '*'
                        | '_'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '('
                        | ')'
                        | '#'
                        | '+'
                        | '-'
                        | '.'
                        | '!'
                        | '|'
                        | '>'
                        | '~'
                ) {
                    unescaped.push(next);
                    characters.next();
                    continue;
                }
            }
        }
        unescaped.push(character);
    }
    unescaped.trim().to_string()
}

fn parse_link_body(body: &str) -> (String, Option<String>) {
    let mut parts = body.splitn(2, '|');
    let target = normalize_embed_target(parts.next().unwrap_or(""));
    let alias = parts
        .next()
        .map(normalize_embed_target)
        .filter(|value| !value.is_empty());
    (target, alias)
}

fn find_wiki_open(line: &str, offset: usize) -> Option<(usize, usize)> {
    let regular = line[offset..].find("[[").map(|index| (offset + index, 2));
    let escaped = line[offset..]
        .find("\\[\\[")
        .map(|index| (offset + index, 4));
    match (regular, escaped) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn find_wiki_close(line: &str, offset: usize) -> Option<(usize, usize)> {
    let regular = line[offset..].find("]]").map(|index| (offset + index, 2));
    let escaped = line[offset..]
        .find("\\]\\]")
        .map(|index| (offset + index, 4));
    match (regular, escaped) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn wiki_raw_start(line: &str, start: usize) -> usize {
    let prefix = &line[..start];
    let trimmed = prefix.trim_end_matches(|character| {
        matches!(
            character,
            '\u{FEFF}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}'
        )
    });
    if trimmed.ends_with('!') {
        trimmed.len().saturating_sub(1)
    } else {
        start
    }
}

fn parse_wiki_like_items(
    line: &str,
    line_number: usize,
    wiki_links: &mut Vec<KnowledgeIndexWikiLink>,
    embeds: &mut Vec<KnowledgeIndexEmbed>,
) {
    let mut offset = 0;
    while let Some((start, open_len)) = find_wiki_open(line, offset) {
        let body_start = start + open_len;
        let Some((end, close_len)) = find_wiki_close(line, body_start) else {
            break;
        };
        let raw_start = wiki_raw_start(line, start);
        let raw = line[raw_start..end + close_len].to_string();
        let (target, alias) = parse_link_body(&line[body_start..end]);
        if !target.is_empty() {
            if raw_start < start {
                let kind = Path::new(&target)
                    .extension()
                    .and_then(OsStr::to_str)
                    .map(str::to_ascii_lowercase);
                embeds.push(KnowledgeIndexEmbed {
                    raw,
                    target,
                    kind,
                    line: line_number,
                });
            } else {
                wiki_links.push(KnowledgeIndexWikiLink {
                    raw,
                    target,
                    alias,
                    line: line_number,
                });
            }
        }
        offset = end + close_len;
    }
}

fn normalize_tag(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_start_matches('#')
        .trim()
        .to_string()
}

fn parse_frontmatter_tags(content: &str, tags: &mut HashSet<String>) {
    let mut lines = content.strip_prefix('\u{FEFF}').unwrap_or(content).lines();
    if lines.next().map(str::trim) != Some("---") {
        return;
    }
    let mut in_tags_list = false;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some((key, rest)) = trimmed.split_once(':') {
            if matches!(key.trim().to_ascii_lowercase().as_str(), "tag" | "tags") {
                in_tags_list = rest.trim().is_empty();
                for tag in rest.trim().trim_matches(['[', ']']).split(',') {
                    let normalized = normalize_tag(tag);
                    if !normalized.is_empty() {
                        tags.insert(normalized);
                    }
                }
                continue;
            }
        }
        if in_tags_list {
            if let Some(value) = trimmed.strip_prefix('-') {
                let normalized = normalize_tag(value);
                if !normalized.is_empty() {
                    tags.insert(normalized);
                }
            } else if !trimmed.is_empty() {
                in_tags_list = false;
            }
        }
    }
}

fn valid_inline_tag(tag: &str) -> bool {
    let tag = tag.trim().trim_start_matches('#');
    let character_count = tag.chars().count();
    if !(2..=64).contains(&character_count) {
        return false;
    }
    if matches!(character_count, 3 | 6 | 8)
        && tag.chars().all(|character| character.is_ascii_hexdigit())
    {
        return false;
    }
    let semantic_count = tag
        .chars()
        .filter(|character| character.is_alphabetic())
        .count();
    let digit_count = tag
        .chars()
        .filter(|character| character.is_ascii_digit())
        .count();
    semantic_count > 0
        && digit_count <= semantic_count
        && tag
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
}

fn collect_inline_tags(line: &str, tags: &mut HashSet<String>) {
    let mut in_inline_code = false;
    for (index, character) in line.char_indices() {
        if character == '`' {
            in_inline_code = !in_inline_code;
            continue;
        }
        if in_inline_code || character != '#' {
            continue;
        }
        let before = line[..index].chars().next_back();
        if before.is_some_and(|previous| {
            previous.is_alphanumeric()
                || matches!(previous, '#' | '/' | '\\' | ':' | '?' | '&' | '=' | '%')
        }) {
            continue;
        }
        let after = index + character.len_utf8();
        let Some(next) = line[after..].chars().next() else {
            continue;
        };
        if next.is_whitespace() || next == '#' {
            continue;
        }
        let prefix = line[..index].split_whitespace().last().unwrap_or("");
        if prefix.contains("://") || prefix.contains('?') || prefix.contains('&') {
            continue;
        }
        let candidate = line[after..]
            .split(|candidate: char| {
                candidate.is_whitespace()
                    || matches!(
                        candidate,
                        ',' | '.'
                            | ';'
                            | ':'
                            | '!'
                            | '?'
                            | ')'
                            | ']'
                            | '}'
                            | '"'
                            | '\''
                            | '<'
                            | '>'
                    )
            })
            .next()
            .unwrap_or("")
            .trim_matches(|candidate: char| {
                matches!(candidate, '#' | '[' | '(' | '<' | '>' | '`' | '"' | '\'')
            })
            .trim();
        if valid_inline_tag(candidate) {
            tags.insert(candidate.to_string());
        }
    }
}

fn parse_inline_tags(content: &str, tags: &mut HashSet<String>) {
    let mut in_frontmatter = false;
    let mut frontmatter_done = false;
    let mut fence_marker: Option<&str> = None;
    for (index, line) in content
        .strip_prefix('\u{FEFF}')
        .unwrap_or(content)
        .lines()
        .enumerate()
    {
        let trimmed = line.trim_start();
        if index == 0 && trimmed.trim() == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if index > 0 && trimmed.trim() == "---" {
                in_frontmatter = false;
                frontmatter_done = true;
            }
            continue;
        }
        if !frontmatter_done && trimmed.trim() == "---" {
            continue;
        }
        if let Some(marker) = fence_marker_for(line) {
            if fence_marker == Some(marker) {
                fence_marker = None;
            } else if fence_marker.is_none() {
                fence_marker = Some(marker);
            }
            continue;
        }
        if fence_marker.is_none() {
            collect_inline_tags(line, tags);
        }
    }
}

fn fence_marker_for(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("```") {
        Some("```")
    } else if trimmed.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

fn markdown_plain_text(content: &str) -> String {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed == "---" || trimmed.starts_with("```") {
                return None;
            }
            Some(
                trimmed
                    .trim_start_matches('#')
                    .trim_start_matches('>')
                    .trim_start_matches('-')
                    .trim_start_matches('*')
                    .trim()
                    .to_string(),
            )
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
struct RefreshActivity<'a> {
    index: &'a KnowledgeIndex,
}

#[cfg(test)]
impl<'a> RefreshActivity<'a> {
    fn begin(index: &'a KnowledgeIndex) -> Self {
        use std::sync::atomic::Ordering;
        let active = index.active_refreshes.fetch_add(1, Ordering::AcqRel) + 1;
        let mut observed = index.max_active_refreshes.load(Ordering::Acquire);
        while active > observed {
            match index.max_active_refreshes.compare_exchange(
                observed,
                active,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(next) => observed = next,
            }
        }
        Self { index }
    }
}

#[cfg(test)]
impl Drop for RefreshActivity<'_> {
    fn drop(&mut self) {
        self.index
            .active_refreshes
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
