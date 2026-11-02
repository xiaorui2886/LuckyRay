//! Linux admission and execution for the attachment kinds that are open:
//! new-file imports, in-Vault attachment renames, conversions, note moves and
//! external reference updates. Real file moves and relinks stay refused until
//! the platform rename primitive is implemented for them.
use super::attachment_operations::{bytes, validate_plan, AttachmentOperationIssue};
use super::*;
use crate::linux_attachment_store::{Dependency, ImportStore, MAX_FILE, MAX_INTENT};

/// Attachments are private files (0600, no extra attributes). Markdown
/// documents are ordinary user files: a removal renames their inode, so only
/// the recorded identity and bytes are proved for them.
pub(super) fn step_is_private(relative_path: &str) -> bool {
    !relative_path.to_ascii_lowercase().ends_with(".md")
}

/// Durable intent of one admitted Linux attachment operation.
pub(super) struct LinuxAttachmentIntent {
    pub(super) store: ImportStore,
    pub(super) id: String,
    pub(super) plan: AttachmentOperationPlan,
}

/// Kind-dispatch admission. The import rule is unchanged; the four in-Vault
/// mutation kinds have their own closed shapes below, and everything else is
/// still refused.
pub(super) fn admit_linux_attachment_operation(
    operation: &AttachmentOperationPlan,
) -> Result<(), KnowledgeError> {
    match operation.kind.as_str() {
        "import" => admit_import(operation),
        "attachment-rename" => admit_rename(operation),
        "conversion" => admit_conversion(operation),
        "note-move" => admit_note_move(operation),
        "external-reference-update" => admit_external_reference_update(operation),
        _ => Err(linux_knowledge_write_unavailable()),
    }
}

fn admit_import(operation: &AttachmentOperationPlan) -> Result<(), KnowledgeError> {
    if operation.files.is_empty()
        || operation.material_relocation.is_some()
        || operation.material_revision.is_some()
        || operation.material_original_path.is_some()
        || operation.material_file_move.is_some()
        || operation.files.iter().any(|file| {
            file.before.is_some()
                || file.before_revision.is_some()
                || file.after.is_none()
                || file.after_revision.is_none()
        })
    {
        return Err(linux_knowledge_write_unavailable());
    }
    let mut total = 0usize;
    for file in &operation.files {
        let content = bytes(&file.after)?.ok_or_else(linux_knowledge_write_unavailable)?;
        total = total
            .checked_add(content.len())
            .ok_or_else(linux_knowledge_write_unavailable)?;
        if content.len() > MAX_FILE || total > 128 * 1024 * 1024 {
            return Err(linux_knowledge_write_unavailable());
        }
    }
    for (path, digest) in &operation.attachment_dependencies {
        if !operation
            .files
            .iter()
            .any(|file| &file.relative_path == path && file.after_revision.as_ref() == Some(digest))
        {
            return Err(linux_knowledge_write_unavailable());
        }
    }
    for (note, _) in &operation.external_paths {
        if !operation
            .files
            .iter()
            .any(|file| &file.relative_path == note && note.to_ascii_lowercase().ends_with(".md"))
        {
            return Err(linux_knowledge_write_unavailable());
        }
    }
    Ok(())
}

/// A rename is exactly: one new attachment, any number of rewritten Markdown
/// notes, and the old attachment removed last. Anything else - including a
/// second removal, a Markdown removal, or an in-place attachment rewrite - is
/// refused rather than approximated.
fn admit_rename(operation: &AttachmentOperationPlan) -> Result<(), KnowledgeError> {
    if operation.files.len() < 2
        || operation.files.len() > 1024
        || operation.material_relocation.is_some()
        || operation.material_revision.is_some()
        || operation.material_original_path.is_some()
        || operation.material_file_move.is_some()
        || !operation.external_paths.is_empty()
        || !operation.external_dependencies.is_empty()
    {
        return Err(linux_knowledge_write_unavailable());
    }
    let first = &operation.files[0];
    let last = &operation.files[operation.files.len() - 1];
    if first.before.is_some()
        || first.after.is_none()
        || last.after.is_some()
        || last.before.is_none()
    {
        return Err(linux_knowledge_write_unavailable());
    }
    let mut total = 0usize;
    let mut created = 0usize;
    let mut removed = 0usize;
    for file in &operation.files {
        let before = bytes(&file.before)?;
        let after = bytes(&file.after)?;
        let markdown = file.relative_path.to_ascii_lowercase().ends_with(".md");
        let charge = match (before.as_deref(), after.as_deref()) {
            (None, Some(content)) => {
                // The published attachment is never Markdown: that path is a
                // note move, which is not admitted yet.
                if markdown {
                    return Err(linux_knowledge_write_unavailable());
                }
                created += 1;
                content.len()
            }
            (Some(previous), Some(content)) => {
                // An in-place rewrite is only ever the Markdown link update.
                if !markdown {
                    return Err(linux_knowledge_write_unavailable());
                }
                previous.len() + content.len()
            }
            (Some(previous), None) => {
                if markdown {
                    return Err(linux_knowledge_write_unavailable());
                }
                removed += 1;
                previous.len()
            }
            (None, None) => return Err(linux_knowledge_write_unavailable()),
        };
        if charge > 2 * MAX_FILE {
            return Err(linux_knowledge_write_unavailable());
        }
        total = total
            .checked_add(charge)
            .ok_or_else(linux_knowledge_write_unavailable)?;
        if total > 128 * 1024 * 1024 {
            return Err(linux_knowledge_write_unavailable());
        }
    }
    if created != 1 || removed != 1 {
        return Err(linux_knowledge_write_unavailable());
    }
    for (path, digest) in &operation.attachment_dependencies {
        if !operation.files.iter().any(|file| {
            &file.relative_path == path
                && file.before.is_none()
                && file.after_revision.as_ref() == Some(digest)
        }) {
            return Err(linux_knowledge_write_unavailable());
        }
    }
    Ok(())
}

/// Collecting old material attachments: publish the copies first, then rewrite
/// the notes that point at them. Nothing is removed and nothing external is
/// written - the source bytes were sealed into the plan at preview time.
fn admit_conversion(operation: &AttachmentOperationPlan) -> Result<(), KnowledgeError> {
    if operation.files.is_empty()
        || operation.files.len() > 1024
        || operation.material_relocation.is_some()
        || operation.material_revision.is_some()
        || operation.material_original_path.is_some()
        || operation.material_file_move.is_some()
        || !operation.external_paths.is_empty()
        || !operation.external_dependencies.is_empty()
    {
        return Err(linux_knowledge_write_unavailable());
    }
    let mut total = 0usize;
    let mut created = 0usize;
    let mut rewriting = false;
    for file in &operation.files {
        let before = bytes(&file.before)?;
        let after = bytes(&file.after)?;
        let markdown = file.relative_path.to_ascii_lowercase().ends_with(".md");
        let charge = match (before.as_deref(), after.as_deref()) {
            (None, Some(content)) => {
                // A rewrite may never precede the copy it points at, or an
                // interruption would leave Markdown pointing at a missing file.
                if markdown || rewriting {
                    return Err(linux_knowledge_write_unavailable());
                }
                created += 1;
                content.len()
            }
            (Some(previous), Some(content)) => {
                if !markdown {
                    return Err(linux_knowledge_write_unavailable());
                }
                rewriting = true;
                previous.len() + content.len()
            }
            // Conversion only copies and rewrites; it never removes or no-ops.
            (Some(_), None) | (None, None) => return Err(linux_knowledge_write_unavailable()),
        };
        if charge > 2 * MAX_FILE {
            return Err(linux_knowledge_write_unavailable());
        }
        total = total
            .checked_add(charge)
            .ok_or_else(linux_knowledge_write_unavailable)?;
        if total > 128 * 1024 * 1024 {
            return Err(linux_knowledge_write_unavailable());
        }
    }
    if created == 0 {
        return Err(linux_knowledge_write_unavailable());
    }
    for (path, digest) in &operation.attachment_dependencies {
        if !operation.files.iter().any(|file| {
            &file.relative_path == path
                && file.before.is_none()
                && file.after_revision.as_ref() == Some(digest)
        }) {
            return Err(linux_knowledge_write_unavailable());
        }
    }
    Ok(())
}

/// Moving a note inside the Vault: publish the rewritten document under its new
/// name, then move the original aside. Exactly two steps, in that order.
fn admit_note_move(operation: &AttachmentOperationPlan) -> Result<(), KnowledgeError> {
    if operation.files.len() != 2
        || !operation.attachment_dependencies.is_empty()
        || operation.material_relocation.is_some()
        || operation.material_revision.is_some()
        || operation.material_original_path.is_some()
        || operation.material_file_move.is_some()
        || !operation.external_paths.is_empty()
        || !operation.external_dependencies.is_empty()
    {
        return Err(linux_knowledge_write_unavailable());
    }
    let published = &operation.files[0];
    let removed = &operation.files[1];
    let published_markdown = published.relative_path.to_ascii_lowercase().ends_with(".md");
    let removed_markdown = removed.relative_path.to_ascii_lowercase().ends_with(".md");
    if !published_markdown
        || !removed_markdown
        || published.before.is_some()
        || published.after.is_none()
        || removed.before.is_none()
        || removed.after.is_some()
    {
        return Err(linux_knowledge_write_unavailable());
    }
    let after = bytes(&published.after)?.ok_or_else(linux_knowledge_write_unavailable)?;
    let before = bytes(&removed.before)?.ok_or_else(linux_knowledge_write_unavailable)?;
    if after.len() > MAX_FILE || before.len() > MAX_FILE {
        return Err(linux_knowledge_write_unavailable());
    }
    Ok(())
}

/// Updating references after an external move: existing Markdown only. The
/// moved files themselves are already in place and are held, never written, so
/// no external path is admitted here.
fn admit_external_reference_update(
    operation: &AttachmentOperationPlan,
) -> Result<(), KnowledgeError> {
    if operation.files.is_empty()
        || operation.files.len() > 1024
        || operation.material_relocation.is_some()
        || operation.material_revision.is_some()
        || operation.material_original_path.is_some()
        || operation.material_file_move.is_some()
        || !operation.external_paths.is_empty()
        || !operation.external_dependencies.is_empty()
    {
        return Err(linux_knowledge_write_unavailable());
    }
    let mut total = 0usize;
    for file in &operation.files {
        if !file.relative_path.to_ascii_lowercase().ends_with(".md") {
            return Err(linux_knowledge_write_unavailable());
        }
        let before = bytes(&file.before)?.ok_or_else(linux_knowledge_write_unavailable)?;
        let after = bytes(&file.after)?.ok_or_else(linux_knowledge_write_unavailable)?;
        if before.len() > MAX_FILE || after.len() > MAX_FILE {
            return Err(linux_knowledge_write_unavailable());
        }
        total = total
            .checked_add(before.len() + after.len())
            .ok_or_else(linux_knowledge_write_unavailable)?;
        if total > 128 * 1024 * 1024 {
            return Err(linux_knowledge_write_unavailable());
        }
    }
    Ok(())
}

impl KnowledgeService {
    pub(super) fn read_linux_attachment_operation_plan(
        &self,
        vault: &TrustedVault,
        id: &str,
        guard: &FilesystemDirectoryIdentityGuard,
    ) -> Result<AttachmentOperationPlan, KnowledgeError> {
        let (_, plan) = self.load_linux_attachment_store(vault, id, guard)?;
        let identity = knowledge_target_identity(vault, guard.identity())?;
        self.verify_current_target(&identity, guard)?;
        Ok(plan)
    }

    pub(super) fn load_linux_attachment_store(
        &self,
        vault: &TrustedVault,
        id: &str,
        guard: &FilesystemDirectoryIdentityGuard,
    ) -> Result<(ImportStore, AttachmentOperationPlan), KnowledgeError> {
        let store =
            ImportStore::open(&vault.root, id, false).map_err(linux_transactions::failure)?;
        if store.root_identity().map_err(linux_transactions::failure)? != guard.identity() {
            return Err(knowledge_target_not_current());
        }
        let plan: AttachmentOperationPlan =
            serde_json::from_slice(&store.read_intent().map_err(linux_transactions::failure)?)
                .map_err(|_| error("knowledge-recovery-invalid", "Invalid Linux attachment intent"))?;
        validate_plan(vault, &plan)?;
        admit_linux_attachment_operation(&plan)?;
        if plan.receipt_authorization.is_empty() {
            return Err(error(
                "knowledge-recovery-untrusted",
                "Linux attachment recovery requires sealed evidence",
            ));
        }
        self.verify_attachment_receipt(&plan)?;
        store.verify().map_err(linux_transactions::failure)?;
        Ok((store, plan))
    }

    pub(super) fn record_linux_attachment_projection(
        &self,
        vault: &TrustedVault,
        guard: &FilesystemDirectoryIdentityGuard,
        result: &AttachmentOperationResult,
    ) -> Result<(), KnowledgeError> {
        let (store, plan) = self.load_linux_attachment_store(vault, &result.operation_id, guard)?;
        if result.total_files != plan.files.len()
            || result.completed_files > result.total_files
            || !matches!(
                result.status.as_str(),
                "complete" | "complete-with-unresolved" | "partial" | "rolled-back"
            )
            || result.recovery_path
                != format!(
                    ".luckyray/attachment-operations/{}.json",
                    result.operation_id
                )
        {
            return Err(error(
                "knowledge-recovery-invalid",
                "Projection does not match the admitted operation",
            ));
        }
        if result.status != "partial" {
            if result.completed_files != result.total_files {
                return Err(error(
                    "knowledge-recovery-invalid",
                    "Incomplete operation cannot have a completed projection",
                ));
            }
            let key = self.attachment_receipt_key(false)?;
            for (index, file) in plan.files.iter().enumerate() {
                let before = bytes(&file.before)?;
                let after = bytes(&file.after)?;
                if result.status == "rolled-back" {
                    // A retained creation is not asserted: it stays on purpose.
                    if let Some(previous) = before.as_deref() {
                        store
                            .verify_before_state(
                                index,
                                &file.relative_path,
                                previous,
                                step_is_private(&file.relative_path),
                                &key,
                            )
                            .map_err(linux_transactions::failure)?;
                    }
                } else if plan.kind == "import" {
                    store
                        .verify_installed(
                            index,
                            &file.relative_path,
                            &after.ok_or_else(linux_knowledge_write_unavailable)?,
                            &key,
                        )
                        .map_err(linux_transactions::failure)?;
                } else {
                    store
                        .verify_step(
                            index,
                            &file.relative_path,
                            before.as_deref(),
                            after.as_deref(),
                            step_is_private(&file.relative_path),
                            &key,
                        )
                        .map_err(linux_transactions::failure)?;
                }
            }
        }
        let identity = knowledge_target_identity(vault, guard.identity())?;
        self.verify_current_target(&identity, guard)?;
        let encoded = serde_json::to_vec(result).map_err(|_| {
            error(
                "knowledge-recovery-invalid",
                "Cannot encode projection receipt",
            )
        })?;
        store
            .append_result(&format!("{:032x}", rand::random::<u128>()), &encoded)
            .map_err(linux_transactions::failure)
    }

    /// Publish the sealed intent before any mutation. Every created name is
    /// proven vacant first, then `before_commit` runs (admission dependencies
    /// are held before the record becomes durable), and the target epoch is
    /// re-checked immediately before the record is written.
    pub(super) fn prepare_linux_attachment_operation(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        guard: &FilesystemDirectoryIdentityGuard,
        identity: &KnowledgeTargetIdentity,
        before_commit: impl FnOnce(&AttachmentOperationPlan) -> Result<(), KnowledgeError>,
    ) -> Result<LinuxAttachmentIntent, KnowledgeError> {
        let id = format!("{:032x}", rand::random::<u128>());
        let store =
            ImportStore::open(&vault.root, &id, true).map_err(linux_transactions::failure)?;
        if store.root_identity().map_err(linux_transactions::failure)? != guard.identity() {
            return Err(knowledge_target_not_current());
        }
        for file in &operation.files {
            if file.before.is_none() {
                // An occupied destination is a name conflict, not a revision
                // conflict: nothing of this transaction was ever written there.
                store
                    .require_vacant(&file.relative_path)
                    .map_err(linux_transactions::failure)?;
            }
        }
        let sealed = self.seal_attachment_receipt(operation)?;
        self.verify_attachment_receipt(&sealed)?;
        let encoded = serde_json::to_vec(&sealed)
            .map_err(|_| error("knowledge-recovery-invalid", "Cannot encode attachment intent"))?;
        if encoded.len() > MAX_INTENT {
            return Err(linux_knowledge_write_unavailable());
        }
        before_commit(&sealed)?;
        self.assert_expected_target_unlocked(vault, Some(identity), Some(guard))?;
        store
            .write_intent(&encoded)
            .map_err(linux_transactions::failure)?;
        Ok(LinuxAttachmentIntent {
            store,
            id,
            plan: sealed,
        })
    }

    pub(super) fn execute_linux_attachment_import_unlocked(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        admit_linux_attachment_operation(operation)?;
        let guard = filesystem_directory_identity_guard(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(vault, guard.identity())?;
        if identity.identity_digest != operation.target_identity {
            return Err(knowledge_target_not_current());
        }
        self.assert_expected_target_unlocked(vault, Some(&identity), Some(&guard))?;
        // Admission dependencies are held before the durable intent and verified
        // again around every publication. The sealed payload is authoritative;
        // the caller's copy is never re-read.
        let mut dependencies = Vec::new();
        let intent =
            self.prepare_linux_attachment_operation(vault, operation, &guard, &identity, |sealed| {
                dependencies = import_dependencies(sealed)?;
                Ok(())
            })?;
        self.run_linux_attachment_import(
            vault,
            &intent.plan,
            &intent.id,
            &intent.store,
            &guard,
            &identity,
            &dependencies,
            cancelled,
        )
    }

    pub(super) fn run_linux_attachment_import(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        id: &str,
        store: &ImportStore,
        guard: &FilesystemDirectoryIdentityGuard,
        identity: &KnowledgeTargetIdentity,
        dependencies: &[Dependency],
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        let mut result = AttachmentOperationResult {
            operation_id: id.into(),
            status: if operation.issues.is_empty() {
                "complete"
            } else {
                "complete-with-unresolved"
            }
            .into(),
            completed_files: 0,
            total_files: operation.files.len(),
            issues: operation.issues.clone(),
            recovery_path: format!(".luckyray/attachment-operations/{id}.json"),
        };
        let receipt_key = self.attachment_receipt_key(false)?;
        for (index, file) in operation.files.iter().enumerate() {
            let interrupted = cancelled.load(Ordering::Acquire);
            #[cfg(test)]
            let interrupted = interrupted
                || (result.completed_files
                    == self.attachment_fault_after_steps.load(Ordering::Acquire)
                    && {
                        self.attachment_fault_after_steps
                            .store(usize::MAX, Ordering::Release);
                        true
                    });
            if interrupted {
                result.status = "partial".into();
                result.issues.push(AttachmentOperationIssue {
                    document: file.relative_path.clone(),
                    target: String::new(),
                    status: "cancelled-between-files".into(),
                });
                break;
            }
            let outcome = (|| {
                let content = bytes(&file.after)?.ok_or_else(linux_knowledge_write_unavailable)?;
                let mut admission_error = None;
                store
                    .install(index, &file.relative_path, &content, &receipt_key, || {
                        if let Err(failure) =
                            self.assert_expected_target_unlocked(vault, Some(identity), Some(guard))
                        {
                            admission_error = Some(failure);
                            return Err(crate::linux_fs::conflict());
                        }
                        if cancelled.load(Ordering::Acquire) {
                            return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                        }
                        for dependency in dependencies {
                            dependency.verify()?;
                        }
                        Ok(())
                    })
                    .map_err(|failure| {
                        admission_error.unwrap_or_else(|| linux_transactions::failure(failure))
                    })?;
                if file.relative_path.to_ascii_lowercase().ends_with(".md") {
                    self.index.mark_document_dirty(&KnowledgeDocumentRef {
                        vault_id: vault.registration.id.clone(),
                        relative_path: file.relative_path.clone(),
                    })?;
                }
                Ok::<_, KnowledgeError>(())
            })();
            match outcome {
                Ok(()) => result.completed_files += 1,
                Err(failure) => {
                    result.status = "partial".into();
                    result.issues.push(AttachmentOperationIssue {
                        document: file.relative_path.clone(),
                        target: String::new(),
                        status: failure.code.to_owned(),
                    });
                    break;
                }
            }
        }
        let mut durable = result.clone();
        if !operation.external_paths.is_empty() {
            durable.status = "partial".into();
            durable.issues.push(AttachmentOperationIssue {
                document: String::new(),
                target: String::new(),
                status: "attachment-projection-pending".into(),
            });
        }
        let encoded = serde_json::to_vec(&durable)
            .map_err(|_| error("knowledge-recovery-invalid", "Cannot encode import result"))?;
        store
            .append_result(&format!("{:032x}", rand::random::<u128>()), &encoded)
            .map_err(linux_transactions::failure)?;
        Ok(result)
    }
}

pub(super) fn import_dependencies(
    operation: &AttachmentOperationPlan,
) -> Result<Vec<Dependency>, KnowledgeError> {
    operation
        .external_dependencies
        .iter()
        .map(|(path, digest)| {
            Dependency::open(Path::new(path), digest).map_err(linux_transactions::failure)
        })
        .collect()
}
