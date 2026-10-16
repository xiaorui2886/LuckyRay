//! Ephemeral editing advice and unique creation through the existing Vault authority.
use super::*;
use std::time::{Duration, Instant};

const LEASE: Duration = Duration::from_secs(15);
const MAX_SESSIONS: usize = 512;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCommittedChange {
    pub vault_id: String,
    pub relative_paths: Vec<String>,
}

#[derive(Default)]
pub(super) struct RemoteEditing {
    target: Option<KnowledgeTargetIdentity>,
    sessions: HashMap<(String, String, String), Session>,
}

struct Session {
    generation: u64,
    until: Instant,
    editing: bool,
}

pub(super) struct CommittedCheckpoint {
    incarnation: u128,
    sequence: u64,
}

impl Default for CommittedCheckpoint {
    fn default() -> Self {
        Self {
            incarnation: rand::random(),
            sequence: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCommittedCheckpoint {
    pub vault_id: String,
    pub checkpoint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeEditingStatus {
    pub desktop_editing: bool,
    pub mobile_editing: bool,
    pub lease_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeEditingLease {
    pub session_id: String,
    pub generation: u64,
    pub editing: bool,
    pub lease_ms: u64,
}

impl RemoteEditing {
    fn scope(&mut self, target: &KnowledgeTargetIdentity) {
        if self.target.as_ref() != Some(target) {
            self.sessions.clear();
            self.target = Some(target.clone());
        }
    }

    fn open(
        &mut self,
        device: &str,
        path: &str,
        now: Instant,
    ) -> Result<KnowledgeEditingLease, KnowledgeError> {
        self.sessions.retain(|_, session| session.until > now);
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(error(
                "knowledge-presence-capacity",
                "Editing presence capacity reached",
            ));
        }
        let session_id = loop {
            let candidate = format!("{:032x}", rand::random::<u128>());
            if !self
                .sessions
                .contains_key(&(device.into(), path.into(), candidate.clone()))
            {
                break candidate;
            }
        };
        self.sessions.insert(
            (device.into(), path.into(), session_id.clone()),
            Session {
                generation: 0,
                until: now + LEASE,
                editing: false,
            },
        );
        Ok(KnowledgeEditingLease {
            session_id,
            generation: 0,
            editing: false,
            lease_ms: LEASE.as_millis() as u64,
        })
    }

    fn set(
        &mut self,
        key: (String, String, String),
        generation: u64,
        editing: bool,
        now: Instant,
    ) -> Result<KnowledgeEditingLease, KnowledgeError> {
        // Only POST may allocate a token. Removing a released/expired token is safe:
        // a late PUT is never allowed to recreate it, even with a higher generation.
        self.sessions.retain(|_, session| session.until > now);
        let entry = self.sessions.get_mut(&key).ok_or_else(|| {
            error(
                "knowledge-presence-expired",
                "Editing session is released or expired",
            )
        })?;
        if generation > entry.generation {
            entry.generation = generation;
            entry.editing = editing;
            if editing {
                entry.until = now + LEASE;
            }
        }
        let result = KnowledgeEditingLease {
            session_id: key.2.clone(),
            generation: entry.generation,
            editing: entry.editing,
            lease_ms: LEASE.as_millis() as u64,
        };
        if !result.editing && generation == result.generation {
            self.sessions.remove(&key);
        }
        Ok(result)
    }
}

impl KnowledgeService {
    /// Ephemeral wake-up watermark, not a content revision/cursor. A restarted
    /// process gets a different incarnation. UI-source fencing is entirely in
    /// memory here: no Vault traversal, index clone, registry read or DB work.
    pub(crate) fn companion_committed_checkpoint_from_ui(
        &self,
        source_epoch: u64,
        vault_id: &str,
    ) -> Result<KnowledgeCommittedCheckpoint, KnowledgeError> {
        let source = self
            .ui_source
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge source unavailable"))?;
        if source.epoch != source_epoch || source.active_vault_id.as_deref() != Some(vault_id) {
            return Err(error(
                "knowledge-source-inactive",
                "Knowledge source is retired",
            ));
        }
        let checkpoint = self.committed_checkpoint.lock().map_err(|_| {
            error(
                "knowledge-lock-poisoned",
                "Knowledge checkpoint unavailable",
            )
        })?;
        Ok(KnowledgeCommittedCheckpoint {
            vault_id: vault_id.into(),
            checkpoint: format!("{:032x}:{}", checkpoint.incarnation, checkpoint.sequence),
        })
    }

    pub(crate) fn companion_editing_from_ui(
        &self,
        source_epoch: u64,
        document: &KnowledgeDocumentRef,
    ) -> Result<KnowledgeEditingStatus, KnowledgeError> {
        {
            let _source = self.lock_active_ui_source(source_epoch, Some(&document.vault_id))?;
        }
        let expected = self.current_target_identity()?;
        let result = self.companion_editing_status(&expected, document, None)?;
        let _source = self.lock_active_ui_source(source_epoch, Some(&document.vault_id))?;
        Ok(result)
    }

    pub(crate) fn companion_directories_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
    ) -> Result<Vec<String>, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if identity != *expected {
            return Err(knowledge_target_not_current());
        }
        let mut directories = vec![String::new()];
        let mut pending = vec![PathBuf::new()];
        let mut visited = 0usize;
        while let Some(relative) = pending.pop() {
            let directory = safe_existing_directory(&vault.root, &relative)?;
            for entry in std::fs::read_dir(directory).map_err(|_| {
                error(
                    "knowledge-list-failed",
                    "Cannot enumerate Vault directories",
                )
            })? {
                let entry = entry.map_err(|_| {
                    error("knowledge-list-failed", "Cannot inspect Vault directory")
                })?;
                visited += 1;
                if visited > 100_000 {
                    return Err(error(
                        "knowledge-index-capacity",
                        "Vault directory inventory exceeds its limit",
                    ));
                }
                let name = entry.file_name();
                let name = name.to_str().ok_or_else(|| {
                    error(
                        "knowledge-path-unavailable",
                        "Vault filename is not Unicode",
                    )
                })?;
                if [".luckyray", ".obsidian", ".git"]
                    .iter()
                    .any(|reserved| name.eq_ignore_ascii_case(reserved))
                    || name.starts_with(".lrk-")
                {
                    continue;
                }
                if has_reparse_point(&entry.path())? {
                    return Err(error(
                        "knowledge-path-reparse-forbidden",
                        "Vault directory inventory contains a linked path",
                    ));
                }
                if entry
                    .file_type()
                    .map_err(|_| error("knowledge-list-failed", "Cannot inspect Vault directory"))?
                    .is_dir()
                {
                    let child = relative.join(name);
                    let path = relative_path_string(&child);
                    if path.len() > 1024 {
                        return Err(error(
                            "knowledge-path-invalid",
                            "Directory path exceeds its limit",
                        ));
                    }
                    directories.push(path);
                    pending.push(child);
                }
            }
        }
        directories.sort();
        self.verify_current_target(expected, &guard)?;
        Ok(directories)
    }

    pub(crate) fn set_companion_committed_listener(
        &self,
        listener: impl Fn(KnowledgeCommittedChange) + Send + Sync + 'static,
    ) -> Result<(), KnowledgeError> {
        *self
            .committed_listener
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge listener unavailable"))? =
            Some(Arc::new(listener));
        Ok(())
    }

    pub(crate) fn notify_companion_committed(&self, vault_id: &str, relative_paths: Vec<String>) {
        // Advance even if no listener is installed or native event delivery fails.
        // This is called only after the existing durable commit/receipt succeeds.
        if let Ok(mut checkpoint) = self.committed_checkpoint.lock() {
            if checkpoint.sequence == u64::MAX {
                *checkpoint = CommittedCheckpoint::default();
            } else {
                checkpoint.sequence += 1;
            }
        }
        let listener = self
            .committed_listener
            .lock()
            .ok()
            .and_then(|listener| listener.clone());
        if let Some(listener) = listener {
            listener(KnowledgeCommittedChange {
                vault_id: vault_id.into(),
                relative_paths,
            });
        }
    }

    pub(crate) fn companion_editing_status(
        &self,
        expected: &KnowledgeTargetIdentity,
        document: &KnowledgeDocumentRef,
        exclude_device: Option<&str>,
    ) -> Result<KnowledgeEditingStatus, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if identity != *expected {
            return Err(knowledge_target_not_current());
        }
        require_matching_vault(document, &vault.registration)?;
        safe_markdown_relative_path(&document.relative_path)?;
        let desktop_editing = {
            let source = self
                .ui_source
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Knowledge source unavailable"))?;
            source.active_vault_id.as_deref() == Some(&document.vault_id)
                && source.dirty_paths.contains(&document.relative_path)
        };
        let mobile_editing = self.with_current_target_response_lease(expected, || {
            let mut remote = self
                .remote_editing
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Editing presence unavailable"))?;
            remote.scope(expected);
            let now = Instant::now();
            Ok::<_, KnowledgeError>(remote.sessions.iter().any(|((device, path, _), session)| {
                Some(device.as_str()) != exclude_device
                    && path == &document.relative_path
                    && session.editing
                    && session.until > now
            }))
        })??;
        self.verify_current_target(expected, &guard)?;
        Ok(KnowledgeEditingStatus {
            desktop_editing,
            mobile_editing,
            lease_ms: LEASE.as_millis() as u64,
        })
    }

    pub(crate) fn companion_open_editing(
        &self,
        expected: &KnowledgeTargetIdentity,
        document: &KnowledgeDocumentRef,
        device: &str,
    ) -> Result<KnowledgeEditingLease, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if identity != *expected {
            return Err(knowledge_target_not_current());
        }
        require_matching_vault(document, &vault.registration)?;
        safe_markdown_relative_path(&document.relative_path)?;
        let result = self.with_current_target_response_lease(expected, || {
            let mut remote = self
                .remote_editing
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Editing presence unavailable"))?;
            remote.scope(expected);
            remote.open(device, &document.relative_path, Instant::now())
        })??;
        self.verify_current_target(expected, &guard)?;
        Ok(result)
    }

    pub(crate) fn companion_set_editing(
        &self,
        expected: &KnowledgeTargetIdentity,
        document: &KnowledgeDocumentRef,
        device: &str,
        session: &str,
        generation: u64,
        editing: bool,
    ) -> Result<KnowledgeEditingLease, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if identity != *expected {
            return Err(knowledge_target_not_current());
        }
        require_matching_vault(document, &vault.registration)?;
        safe_markdown_relative_path(&document.relative_path)?;
        if generation == 0
            || generation > 9_007_199_254_740_991
            || device.len() > 160
            || session.is_empty()
            || session.len() > 160
            || !session
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(error(
                "knowledge-presence-invalid",
                "Invalid editing session",
            ));
        }
        // Target validation and session scope mutation are one bounded handoff.
        // An old request must not reset a replacement target's newer sessions.
        // Do not acquire the UI-source lock inside this mutation lease.
        let result = self.with_current_target_response_lease(expected, || {
            let mut remote = self
                .remote_editing
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Editing presence unavailable"))?;
            remote.scope(expected);
            remote.set(
                (
                    device.to_owned(),
                    document.relative_path.clone(),
                    session.to_owned(),
                ),
                generation,
                editing,
                Instant::now(),
            )
        })??;
        self.verify_current_target(expected, &guard)?;
        Ok(result)
    }

    /// The caller persists the chosen path AND staged file object in its existing
    /// operation journal before the no-replace publish. This makes interrupted
    /// recovery identify our file, rather than another same-content note.
    pub(crate) fn create_unique_document_for_target(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeCreateInput,
        mut prepare: impl FnMut(&str, &str) -> Result<(), KnowledgeError>,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service unavailable"))?;
        let vault = self.current_vault_unlocked()?;
        let guard = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        let parent = safe_relative_directory(input.parent_relative_path.as_deref())?;
        let parent_path = safe_existing_directory(&vault.root, &parent)?;
        let mut parent_guards = Vec::new();
        let mut guarded_path = vault.root.clone();
        for component in parent.components() {
            guarded_path.push(component.as_os_str());
            let guard = filesystem_directory_identity_guard(&guarded_path)
                .map_err(map_filesystem_identity_error)?;
            guard
                .verify_current_path(&guarded_path)
                .map_err(map_filesystem_identity_error)?;
            parent_guards.push((guarded_path.clone(), guard));
        }
        let name = safe_markdown_name(&input.title)?;
        let stem = Path::new(&name)
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap();
        for suffix in 0..1000 {
            let name = match suffix {
                0 => name.clone(),
                1 => format!("{stem}（副本）.md"),
                _ => format!("{stem}（副本 {suffix}）.md"),
            };
            let relative = parent.join(&name);
            let path = parent_path.join(&name);
            if path
                .try_exists()
                .map_err(|_| error("knowledge-write-failed", "Cannot inspect create target"))?
            {
                continue;
            }
            let staged =
                parent_path.join(format!(".lrk-create-{:032x}.tmp", rand::random::<u128>()));
            let outcome = (|| {
                let mut options = OpenOptions::new();
                options.read(true).write(true).create_new(true);
                #[cfg(windows)]
                {
                    use std::os::windows::fs::OpenOptionsExt;
                    // Keep the staged object's handle throughout publish; no other
                    // process can modify or replace it between journal and rename.
                    options
                        .access_mode(0x80000000 | 0x40000000 | 0x00010000)
                        .share_mode(1);
                }
                let mut file = options
                    .open(&staged)
                    .map_err(|_| error("knowledge-write-failed", "Cannot stage new note"))?;
                file.write_all(input.content.as_bytes())
                    .and_then(|_| file.sync_all())
                    .map_err(|_| error("knowledge-write-failed", "Cannot flush new note"))?;
                let object = index::attachment_object_identity(&file, &staged)
                    .map(|(device, file)| format!("{device:x}:{file:x}"))
                    .ok_or_else(|| {
                        error(
                            "knowledge-identity-unavailable",
                            "Cannot identify staged note",
                        )
                    })?;
                prepare(&relative_path_string(&relative), &object)?;
                self.assert_expected_target_unlocked(&vault, Some(expected), guard.as_ref())?;
                for (path, guard) in &parent_guards {
                    guard
                        .verify_current_path(path)
                        .map_err(map_filesystem_identity_error)?;
                }
                if let Err(failure) = rename_open_file(&file, &path) {
                    if path.try_exists().unwrap_or(false) {
                        return Ok(None);
                    }
                    return Err(failure);
                }
                let document = snapshot_from_committed_bytes(
                    &vault,
                    &relative,
                    &path,
                    input.content.as_bytes(),
                )
                .map_err(|_| {
                    error(
                        "knowledge-unique-create-uncertain",
                        "Published note receipt is unavailable",
                    )
                })?;
                let warning = self
                    .assert_expected_target_unlocked(&vault, Some(expected), guard.as_ref())
                    .err()
                    .map(|failure| KnowledgeMutationWarning {
                        code: failure.code.into(),
                        message: failure.message,
                    });
                Ok(Some(KnowledgeMutationResult {
                    document,
                    position: "created".into(),
                    index_stale: warning.is_some(),
                    index_warning: warning,
                }))
            })();
            // Only this operation's private staging path can be cleaned up.
            let _ = std::fs::remove_file(&staged);
            match outcome? {
                Some(result) => return Ok(result),
                None => continue,
            }
        }
        Err(error(
            "knowledge-name-conflict",
            "No unique note name available within the create limit",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn dirty_presence_is_per_note_and_mobile_presence_never_vetoes_writes() {
        let (service, root, vault) = super::super::tests::registered_service("live-presence");
        let doc = service
            .create_document(&KnowledgeCreateInput {
                title: "正在编辑".into(),
                content: "baseline".into(),
                parent_relative_path: None,
            })
            .unwrap();
        let other = service
            .create_document(&KnowledgeCreateInput {
                title: "干净笔记".into(),
                content: "other".into(),
                parent_relative_path: None,
            })
            .unwrap();
        let target = service.current_target_identity().unwrap();
        let activation = service.activate_ui_source(&vault.id).unwrap();
        service
            .companion_set_desktop_drafts(
                activation.source_epoch,
                1,
                vec![doc.summary.relative_path.clone()],
            )
            .unwrap();
        assert!(
            service
                .companion_editing_from_ui(activation.source_epoch, &doc.summary.document_ref)
                .unwrap()
                .desktop_editing
        );
        assert!(
            !service
                .companion_editing_status(&target, &other.summary.document_ref, None)
                .unwrap()
                .desktop_editing
        );
        let session = service
            .companion_open_editing(&target, &other.summary.document_ref, "phone-a")
            .unwrap()
            .session_id;
        service
            .companion_set_editing(
                &target,
                &other.summary.document_ref,
                "phone-a",
                &session,
                1,
                true,
            )
            .unwrap();
        assert!(
            service
                .companion_editing_from_ui(activation.source_epoch, &other.summary.document_ref)
                .unwrap()
                .mobile_editing
        );
        assert!(
            !service
                .companion_editing_status(&target, &other.summary.document_ref, Some("phone-a"))
                .unwrap()
                .mobile_editing
        );
        assert!(service
            .with_companion_draft_guard(&other.summary.document_ref, || Ok(()))
            .is_ok());
        assert_eq!(
            service
                .with_companion_draft_guard(&doc.summary.document_ref, || Ok(()))
                .unwrap_err()
                .code,
            "knowledge-desktop-draft-busy"
        );
        service
            .companion_set_desktop_drafts(activation.source_epoch, 2, vec![])
            .unwrap();
        assert!(service
            .with_companion_draft_guard(&doc.summary.document_ref, || Ok(()))
            .is_ok());
        service.deactivate_ui_source().unwrap();
        assert!(service
            .companion_editing_from_ui(activation.source_epoch, &doc.summary.document_ref)
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unique_creation_chooses_final_name_and_never_overwrites_external_collision() {
        let (service, root, _vault) = super::super::tests::registered_service("live-unique");
        let target = service.current_target_identity().unwrap();
        let input = KnowledgeCreateInput {
            title: "同名".into(),
            content: "new body".into(),
            parent_relative_path: None,
        };
        std::fs::write(root.join("同名.md"), b"original bytes").unwrap();
        let mut attempts = Vec::new();
        let created = service
            .create_unique_document_for_target(&target, &input, |path, object| {
                assert!(!object.is_empty());
                attempts.push(path.to_owned());
                if path == "同名（副本）.md" {
                    std::fs::write(root.join(path), b"external collision").unwrap();
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(created.document.summary.relative_path, "同名（副本 2）.md");
        assert_eq!(attempts, vec!["同名（副本）.md", "同名（副本 2）.md"]);
        assert_eq!(
            std::fs::read(root.join("同名.md")).unwrap(),
            b"original bytes"
        );
        assert_eq!(
            std::fs::read(root.join("同名（副本）.md")).unwrap(),
            b"external collision"
        );
        assert_eq!(created.document.content, "new body");
        assert!(std::fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".lrk-create-")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leases_expire_release_and_ignore_reordered_renewals() {
        let mut leases = RemoteEditing::default();
        let now = Instant::now();
        let session = leases.open("device-a", "note.md", now).unwrap();
        assert!(
            !session.editing,
            "opening a late response never publishes editing"
        );
        let key = ("device-a".into(), "note.md".into(), session.session_id);
        assert!(leases.set(key.clone(), 1, true, now).unwrap().editing);
        assert!(
            leases
                .set(key.clone(), 2, true, now + Duration::from_secs(5))
                .unwrap()
                .editing
        );
        assert_eq!(
            leases
                .set(key.clone(), 1, true, now + Duration::from_secs(10))
                .unwrap()
                .generation,
            2
        );
        assert_eq!(
            leases.sessions[&key].until,
            now + Duration::from_secs(20),
            "old renewal cannot extend lease"
        );
        assert_eq!(
            leases
                .set(key.clone(), 3, true, now + Duration::from_secs(20))
                .unwrap_err()
                .code,
            "knowledge-presence-expired"
        );
        let fresh = leases
            .open("device-a", "note.md", now + Duration::from_secs(20))
            .unwrap();
        let fresh_key = ("device-a".into(), "note.md".into(), fresh.session_id);
        assert!(
            leases
                .set(fresh_key.clone(), 1, true, now + Duration::from_secs(20))
                .unwrap()
                .editing
        );
        assert_eq!(
            leases
                .set(key, 99, false, now + Duration::from_secs(20))
                .unwrap_err()
                .code,
            "knowledge-presence-expired"
        );
        assert!(
            leases.sessions[&fresh_key].editing,
            "late old release cannot affect replacement"
        );
        assert!(
            !leases
                .set(fresh_key.clone(), 3, false, now + Duration::from_secs(20))
                .unwrap()
                .editing
        );
        assert_eq!(
            leases
                .set(fresh_key, 4, true, now + Duration::from_secs(20))
                .unwrap_err()
                .code,
            "knowledge-presence-expired"
        );
    }

    #[test]
    fn committed_checkpoint_is_constant_cost_and_fences_source_and_incarnation() {
        let (service, root, vault) = super::super::tests::registered_service("checkpoint-cost");
        for index in 0..1000 {
            std::fs::write(
                root.join(format!("note-{index}.md")),
                format!("large vault body {index}"),
            )
            .unwrap();
        }
        let built = service.refresh_index().unwrap();
        assert_eq!(built.documents.len(), 1000);
        let reads = service.index_document_read_count();
        let activation = service.activate_ui_source(&vault.id).unwrap();
        let before = service
            .companion_committed_checkpoint_from_ui(activation.source_epoch, &vault.id)
            .unwrap()
            .checkpoint;
        let started = Instant::now();
        for _ in 0..1000 {
            assert_eq!(
                service
                    .companion_committed_checkpoint_from_ui(activation.source_epoch, &vault.id)
                    .unwrap()
                    .checkpoint,
                before
            );
        }
        println!("checkpoint-cost: documents=1000 checks=1000 elapsed_us={} additional_document_reads={}", started.elapsed().as_micros(), service.index_document_read_count() - reads);
        assert_eq!(service.index_document_read_count(), reads);
        assert_eq!(service.index_snapshot().unwrap().version, built.version);
        service.notify_companion_committed(&vault.id, vec!["note-0.md".into()]);
        assert_ne!(
            service
                .companion_committed_checkpoint_from_ui(activation.source_epoch, &vault.id)
                .unwrap()
                .checkpoint,
            before
        );
        assert_eq!(
            service.index_document_read_count(),
            reads,
            "commit wake itself does not scan an index"
        );
        service.deactivate_ui_source().unwrap();
        assert!(service
            .companion_committed_checkpoint_from_ui(activation.source_epoch, &vault.id)
            .is_err());
        let replacement = service.activate_ui_source(&vault.id).unwrap();
        assert_ne!(activation.source_epoch, replacement.source_epoch);
        assert!(service
            .companion_committed_checkpoint_from_ui(activation.source_epoch, &vault.id)
            .is_err());
        let restarted = KnowledgeService::initialize(&service.app_data_dir).unwrap();
        assert_ne!(
            service.committed_checkpoint.lock().unwrap().incarnation,
            restarted.committed_checkpoint.lock().unwrap().incarnation
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_unique_creation_serializes_final_names_without_losing_content() {
        let (service, root, _vault) = super::super::tests::registered_service("concurrent-unique");
        let target = service.current_target_identity().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let workers = (0..4)
            .map(|index| {
                let service = service.clone();
                let target = target.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    service
                        .create_unique_document_for_target(
                            &target,
                            &KnowledgeCreateInput {
                                title: "concurrent".into(),
                                content: format!("writer-{index}"),
                                parent_relative_path: None,
                            },
                            |_, _| Ok(()),
                        )
                        .unwrap()
                        .document
                })
            })
            .collect::<Vec<_>>();
        let documents = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        let paths = documents
            .iter()
            .map(|document| document.summary.relative_path.clone())
            .collect::<HashSet<_>>();
        assert_eq!(paths.len(), 4);
        for document in documents {
            assert_eq!(
                std::fs::read_to_string(root.join(document.summary.relative_path)).unwrap(),
                document.content
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sequential_scopes_reclaim_release_and_expiry_without_lifetime_exhaustion() {
        let mut leases = RemoteEditing::default();
        let now = Instant::now();
        for index in 0..1000 {
            let path = format!("note-{index}.md");
            let session = leases.open("device", &path, now).unwrap();
            let key = ("device".into(), path, session.session_id);
            assert!(leases.set(key.clone(), 1, true, now).unwrap().editing);
            assert!(!leases.set(key.clone(), 2, false, now).unwrap().editing);
            assert_eq!(
                leases.set(key, 100, true, now).unwrap_err().code,
                "knowledge-presence-expired"
            );
            assert!(leases.sessions.is_empty());
        }
        for index in 0..1000 {
            let at = now + LEASE * index;
            let session = leases.open("device", "note.md", at).unwrap();
            // Half are unused late POSTs; half are editing abandoned without release.
            if index % 2 == 0 {
                leases
                    .set(
                        ("device".into(), "note.md".into(), session.session_id),
                        1,
                        true,
                        at,
                    )
                    .unwrap();
            }
            assert_eq!(leases.sessions.len(), 1);
        }
    }

    #[test]
    fn capacity_counts_only_live_leases_including_inert_posts() {
        let mut leases = RemoteEditing::default();
        let now = Instant::now();
        let mut sessions = Vec::new();
        for _ in 0..MAX_SESSIONS {
            sessions.push(leases.open("device", "note.md", now).unwrap().session_id);
        }
        assert_eq!(
            leases.open("device", "note.md", now).unwrap_err().code,
            "knowledge-presence-capacity"
        );
        leases
            .set(
                ("device".into(), "note.md".into(), sessions[0].clone()),
                1,
                false,
                now,
            )
            .unwrap();
        leases.open("device", "note.md", now).unwrap();
        assert_eq!(leases.sessions.len(), MAX_SESSIONS);
        leases.open("device", "note.md", now + LEASE).unwrap();
        assert_eq!(
            leases.sessions.len(),
            1,
            "unused POST capacity expires without explicit release"
        );
        assert_eq!(
            leases
                .set(
                    ("other-device".into(), "note.md".into(), sessions[1].clone()),
                    1,
                    true,
                    now + LEASE
                )
                .unwrap_err()
                .code,
            "knowledge-presence-expired"
        );
    }

    #[test]
    fn retired_target_advice_and_creation_do_not_mutate_the_replacement_vault() {
        let (service, first_root, _first_vault) =
            super::super::tests::registered_service("presence-target-a");
        let first = service
            .create_document(&KnowledgeCreateInput {
                title: "Same path".into(),
                content: "first vault".into(),
                parent_relative_path: None,
            })
            .unwrap();
        let old_target = service.current_target_identity().unwrap();
        let old_session = service
            .companion_open_editing(&old_target, &first.summary.document_ref, "phone")
            .unwrap()
            .session_id;
        service
            .companion_set_editing(
                &old_target,
                &first.summary.document_ref,
                "phone",
                &old_session,
                1,
                true,
            )
            .unwrap();
        let (other, second_root, second_vault) =
            super::super::tests::registered_service("presence-target-b");
        let second = other
            .create_document(&KnowledgeCreateInput {
                title: "Same path".into(),
                content: "second vault".into(),
                parent_relative_path: None,
            })
            .unwrap();
        service.register_current_vault(&second_vault).unwrap();
        let new_target = service.current_target_identity().unwrap();
        assert!(
            !service
                .companion_editing_status(&new_target, &second.summary.document_ref, None)
                .unwrap()
                .mobile_editing
        );
        let new_session = service
            .companion_open_editing(&new_target, &second.summary.document_ref, "phone")
            .unwrap()
            .session_id;
        service
            .companion_set_editing(
                &new_target,
                &second.summary.document_ref,
                "phone",
                &new_session,
                1,
                true,
            )
            .unwrap();
        assert!(service
            .companion_set_editing(
                &old_target,
                &first.summary.document_ref,
                "phone",
                &old_session,
                2,
                false
            )
            .is_err());
        assert!(service
            .companion_editing_status(&old_target, &first.summary.document_ref, None)
            .is_err());
        assert!(
            service
                .companion_editing_status(&new_target, &second.summary.document_ref, None)
                .unwrap()
                .mobile_editing
        );
        assert!(service
            .create_unique_document_for_target(
                &old_target,
                &KnowledgeCreateInput {
                    title: "Retired create".into(),
                    content: "must not publish".into(),
                    parent_relative_path: None,
                },
                |_, _| panic!("retired target cannot prepare a publish")
            )
            .is_err());
        assert!(!second_root.join("Retired create.md").exists());
        assert_eq!(
            std::fs::read_to_string(second_root.join("Same path.md")).unwrap(),
            "second vault"
        );
        std::fs::remove_dir_all(first_root).unwrap();
        std::fs::remove_dir_all(second_root).unwrap();
    }
}
