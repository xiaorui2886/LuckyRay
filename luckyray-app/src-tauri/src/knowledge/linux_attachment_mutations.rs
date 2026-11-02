//! Forward execution and provable rollback for Linux attachment mutations.
//!
//! Steps run in plan order and roll back in reverse. Each step is admitted by
//! sealed evidence, so a crash leaves an explainable state instead of a guess.
//! Rollback owns exactly two actions: rename a tombstone back to its original
//! name, and write the recorded Markdown bytes back. No user object is ever
//! unlinked here, and a state that cannot be proven stops the operation with a
//! report rather than being "made safe" by deleting something.
use super::attachment_operations::{
    bytes, hold_unreferenced_attachment, AttachmentFileChange, AttachmentOperationIssue,
};
use super::linux_attachment_import::{admit_linux_attachment_operation, import_dependencies};
use super::*;
use crate::linux_attachment_store::ImportStore;
use std::io;

/// Result of one forward step; `true` means the step was already durable.
type StepOutcome = io::Result<bool>;
fn rollback_failure(failure: io::Error) -> KnowledgeError {
    // One code for "not proven", with the specific reason kept in the message
    // and in the reported issue, so no caller can read this as success.
    let (code, message) = match failure.kind() {
        io::ErrorKind::AlreadyExists => (
            "knowledge-linux-rollback-unprovable",
            "The original path now holds another file; nothing was overwritten",
        ),
        io::ErrorKind::NotFound => (
            "knowledge-linux-rollback-unprovable",
            "The removed original is no longer in the recovery name",
        ),
        io::ErrorKind::Unsupported => (
            "knowledge-linux-fs-unsupported",
            "The filesystem does not support a provable rollback rename",
        ),
        _ => (
            "knowledge-linux-rollback-unprovable",
            "The current state matches neither the before nor the after bytes",
        ),
    };
    error(code, message)
}

fn step_failure(failure: io::Error) -> KnowledgeError {
    linux_transactions::failure(failure)
}

impl KnowledgeService {
    /// Single Linux execution entry; `admit` already restricted the kind.
    pub(super) fn execute_linux_attachment_operation_unlocked(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        match operation.kind.as_str() {
            "import" => self.execute_linux_attachment_import_unlocked(vault, operation, cancelled),
            "attachment-rename" => {
                self.execute_linux_attachment_rename_unlocked(vault, operation, cancelled)
            }
            _ => Err(linux_knowledge_write_unavailable()),
        }
    }

    /// Single Linux recovery entry. `rollback` is passed through: an import has
    /// no removal to undo, a rename can prove both of its inverse actions.
    pub(super) fn recover_linux_attachment_operation_unlocked(
        &self,
        vault: &TrustedVault,
        id: &str,
        rollback: bool,
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        let guard = filesystem_directory_identity_guard(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(vault, guard.identity())?;
        let (store, operation) = self.load_linux_attachment_store(vault, id, &guard)?;
        match operation.kind.as_str() {
            "import" => {
                if rollback {
                    // Imports only publish new names; there is nothing to undo.
                    return Err(linux_knowledge_write_unavailable());
                }
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
            "attachment-rename" => self.run_linux_attachment_mutation(
                vault,
                &operation,
                id,
                &store,
                &guard,
                &identity,
                rollback,
                cancelled,
            ),
            _ => Err(linux_knowledge_write_unavailable()),
        }
    }

    fn execute_linux_attachment_rename_unlocked(
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
        let intent = self.prepare_linux_attachment_operation(
            vault,
            operation,
            &guard,
            &identity,
            |_| Ok(()),
        )?;
        self.run_linux_attachment_mutation(
            vault,
            &intent.plan,
            &intent.id,
            &intent.store,
            &guard,
            &identity,
            false,
            cancelled,
        )
    }

    /// Order matters: the creation runs first and the removal last, so an
    /// interruption never leaves Markdown pointing at a missing attachment.
    fn run_linux_attachment_mutation(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        id: &str,
        store: &ImportStore,
        guard: &FilesystemDirectoryIdentityGuard,
        identity: &KnowledgeTargetIdentity,
        rollback: bool,
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        let mut result = AttachmentOperationResult {
            operation_id: id.into(),
            status: if rollback {
                "rolled-back"
            } else if operation.issues.is_empty() {
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
        let ordered: Vec<(usize, &AttachmentFileChange)> = if rollback {
            operation.files.iter().enumerate().rev().collect()
        } else {
            operation.files.iter().enumerate().collect()
        };
        for (index, file) in ordered {
            if cancelled.load(Ordering::Acquire) {
                result.status = "partial".into();
                result.issues.push(AttachmentOperationIssue {
                    document: file.relative_path.clone(),
                    target: String::new(),
                    status: "cancelled-between-files".into(),
                });
                break;
            }
            let outcome = if rollback {
                self.rollback_linux_attachment_step(vault, file, index, store, guard, identity, cancelled)
            } else {
                self.apply_linux_attachment_step(vault, file, index, store, guard, identity, cancelled)
            };
            match outcome {
                Ok(()) => result.completed_files += 1,
                Err(failure) => {
                    result.status = "partial".into();
                    result.issues.push(AttachmentOperationIssue {
                        document: file.relative_path.clone(),
                        target: String::new(),
                        status: format!("{}: {}", failure.code, failure.message),
                    });
                    break;
                }
            }
        }
        let encoded = serde_json::to_vec(&result)
            .map_err(|_| error("knowledge-recovery-invalid", "Cannot encode attachment result"))?;
        store
            .append_result(&format!("{:032x}", rand::random::<u128>()), &encoded)
            .map_err(linux_transactions::failure)?;
        Ok(result)
    }

    /// Target epoch, source epoch and the sealed dependencies are re-proved
    /// around every publication, exactly as for imports.
    fn admit_linux_attachment_step(
        &self,
        vault: &TrustedVault,
        identity: &KnowledgeTargetIdentity,
        guard: &FilesystemDirectoryIdentityGuard,
        cancelled: &AtomicBool,
        admission_error: &mut Option<KnowledgeError>,
    ) -> io::Result<()> {
        if let Err(failure) =
            self.assert_expected_target_unlocked(vault, Some(identity), Some(guard))
        {
            *admission_error = Some(failure);
            return Err(crate::linux_fs::conflict());
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        Ok(())
    }

    fn apply_linux_attachment_step(
        &self,
        vault: &TrustedVault,
        file: &AttachmentFileChange,
        index: usize,
        store: &ImportStore,
        guard: &FilesystemDirectoryIdentityGuard,
        identity: &KnowledgeTargetIdentity,
        cancelled: &AtomicBool,
    ) -> Result<(), KnowledgeError> {
        let before = bytes(&file.before)?;
        let after = bytes(&file.after)?;
        let key = self.attachment_receipt_key(false)?;
        let mut admission_error: Option<KnowledgeError> = None;
        let outcome: StepOutcome = match (before.as_deref(), after.as_deref()) {
            (None, Some(content)) => store.install(index, &file.relative_path, content, &key, || {
                self.admit_linux_attachment_step(
                    vault,
                    identity,
                    guard,
                    cancelled,
                    &mut admission_error,
                )
            }),
            (Some(previous), Some(content)) => store.install_replace(
                index,
                &file.relative_path,
                previous,
                content,
                &key,
                || {
                    self.admit_linux_attachment_step(
                        vault,
                        identity,
                        guard,
                        cancelled,
                        &mut admission_error,
                    )
                },
            ),
            (Some(previous), None) => {
                // Preview is not a snapshot of future references: no Markdown may
                // still resolve here, and every inspected note stays held.
                let _references =
                    hold_unreferenced_attachment(&vault.root, &file.relative_path)?;
                store.install_remove(index, &file.relative_path, previous, &key, || {
                    self.admit_linux_attachment_step(
                        vault,
                        identity,
                        guard,
                        cancelled,
                        &mut admission_error,
                    )
                })
            }
            (None, None) => {
                return Err(error("knowledge-recovery-invalid", "Empty operation step"));
            }
        };
        outcome.map_err(|failure| {
            admission_error
                .take()
                .map_or_else(|| step_failure(failure), |admission| admission)
        })?;
        if file.relative_path.to_ascii_lowercase().ends_with(".md") {
            self.index.mark_document_dirty(&KnowledgeDocumentRef {
                vault_id: vault.registration.id.clone(),
                relative_path: file.relative_path.clone(),
            })?;
        }
        Ok(())
    }

    /// Reverse direction of the same engine. A created name is retained and
    /// reported, never deleted: later notes may already reference it.
    fn rollback_linux_attachment_step(
        &self,
        vault: &TrustedVault,
        file: &AttachmentFileChange,
        index: usize,
        store: &ImportStore,
        guard: &FilesystemDirectoryIdentityGuard,
        identity: &KnowledgeTargetIdentity,
        cancelled: &AtomicBool,
    ) -> Result<(), KnowledgeError> {
        let before = bytes(&file.before)?;
        let after = bytes(&file.after)?;
        let previous = match before.as_deref() {
            Some(previous) => previous,
            None => return Ok(()),
        };
        let key = self.attachment_receipt_key(false)?;
        let mut admission_error: Option<KnowledgeError> = None;
        let outcome: StepOutcome = match after.as_deref() {
            Some(_) => store.restore_replaced(index, &file.relative_path, previous, &key, || {
                self.admit_linux_attachment_step(
                    vault,
                    identity,
                    guard,
                    cancelled,
                    &mut admission_error,
                )
            }),
            None => store.restore_removed(index, &file.relative_path, previous, &key, || {
                self.admit_linux_attachment_step(
                    vault,
                    identity,
                    guard,
                    cancelled,
                    &mut admission_error,
                )
            }),
        };
        outcome.map_err(|failure| {
            admission_error
                .take()
                .map_or_else(|| rollback_failure(failure), |admission| admission)
        })?;
        if file.relative_path.to_ascii_lowercase().ends_with(".md") {
            self.index.mark_document_dirty(&KnowledgeDocumentRef {
                vault_id: vault.registration.id.clone(),
                relative_path: file.relative_path.clone(),
            })?;
        }
        Ok(())
    }
}
