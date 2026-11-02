//! Linux admission for new-file imports only. Other attachment mutations and
//! rollback remain refused: Linux cannot conditionally unlink a named inode.
use super::attachment_operations::{bytes, validate_plan, AttachmentOperationIssue};
use super::*;
use crate::linux_attachment_store::{Dependency, ImportStore, MAX_FILE, MAX_INTENT};

fn admit(operation: &AttachmentOperationPlan) -> Result<(), KnowledgeError> {
    if operation.kind != "import"
        || operation.files.is_empty()
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

impl KnowledgeService {
    pub(super) fn read_linux_attachment_operation_plan(
        &self,
        vault: &TrustedVault,
        id: &str,
        guard: &FilesystemDirectoryIdentityGuard,
    ) -> Result<AttachmentOperationPlan, KnowledgeError> {
        let (_, plan) = self.load_linux_import_store(vault, id, guard)?;
        let identity = knowledge_target_identity(vault, guard.identity())?;
        self.verify_current_target(&identity, guard)?;
        Ok(plan)
    }

    fn load_linux_import_store(
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
                .map_err(|_| error("knowledge-recovery-invalid", "Invalid Linux import intent"))?;
        validate_plan(vault, &plan)?;
        admit(&plan)?;
        if plan.receipt_authorization.is_empty() {
            return Err(error(
                "knowledge-recovery-untrusted",
                "Linux import requires sealed recovery evidence",
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
        let (store, plan) = self.load_linux_import_store(vault, &result.operation_id, guard)?;
        if result.total_files != plan.files.len()
            || result.completed_files > result.total_files
            || !matches!(
                result.status.as_str(),
                "complete" | "complete-with-unresolved" | "partial"
            )
            || result.recovery_path
                != format!(
                    ".luckyray/attachment-operations/{}.json",
                    result.operation_id
                )
        {
            return Err(error(
                "knowledge-recovery-invalid",
                "Projection does not match the admitted import",
            ));
        }
        if result.status != "partial" {
            if result.completed_files != result.total_files {
                return Err(error(
                    "knowledge-recovery-invalid",
                    "Incomplete import cannot have a completed projection",
                ));
            }
            let key = self.attachment_receipt_key(false)?;
            for (index, file) in plan.files.iter().enumerate() {
                store
                    .verify_installed(
                        index,
                        &file.relative_path,
                        &bytes(&file.after)?.ok_or_else(linux_knowledge_write_unavailable)?,
                        &key,
                    )
                    .map_err(linux_transactions::failure)?;
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

    pub(super) fn execute_linux_attachment_import_unlocked(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        admit(operation)?;
        let guard = filesystem_directory_identity_guard(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(vault, guard.identity())?;
        if identity.identity_digest != operation.target_identity {
            return Err(knowledge_target_not_current());
        }
        self.assert_expected_target_unlocked(vault, Some(&identity), Some(&guard))?;
        let id = format!("{:032x}", rand::random::<u128>());
        let store =
            ImportStore::open(&vault.root, &id, true).map_err(linux_transactions::failure)?;
        if store.root_identity().map_err(linux_transactions::failure)? != guard.identity() {
            return Err(knowledge_target_not_current());
        }
        for file in &operation.files {
            store
                .require_vacant(&file.relative_path)
                .map_err(linux_transactions::failure)?;
        }
        let sealed = self.seal_attachment_receipt(operation)?;
        self.verify_attachment_receipt(&sealed)?;
        let encoded = serde_json::to_vec(&sealed)
            .map_err(|_| error("knowledge-recovery-invalid", "Cannot encode import intent"))?;
        if encoded.len() > MAX_INTENT {
            return Err(linux_knowledge_write_unavailable());
        }
        // Admission dependencies are checked before the durable intent and again
        // around every publication. The immutable, sealed payload is authoritative.
        let dependencies = import_dependencies(&sealed)?;
        self.assert_expected_target_unlocked(vault, Some(&identity), Some(&guard))?;
        store
            .write_intent(&encoded)
            .map_err(linux_transactions::failure)?;
        self.run_linux_attachment_import(
            vault,
            &sealed,
            &id,
            &store,
            &guard,
            &identity,
            &dependencies,
            cancelled,
        )
    }

    pub(super) fn recover_linux_attachment_import_unlocked(
        &self,
        vault: &TrustedVault,
        id: &str,
        rollback: bool,
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        // Preserve every object. A safe conditional unlink/rollback is not
        // provided by the Linux primitive; never emulate Windows exclusion.
        if rollback {
            return Err(linux_knowledge_write_unavailable());
        }
        let guard = filesystem_directory_identity_guard(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(vault, guard.identity())?;
        let (store, operation) = self.load_linux_import_store(vault, id, &guard)?;
        let dependencies = import_dependencies(&operation)?;
        self.run_linux_attachment_import(
            vault,
            &operation,
            id,
            &store,
            &guard,
            &identity,
            &dependencies,
            cancelled,
        )
    }

    fn run_linux_attachment_import(
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

fn import_dependencies(
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
