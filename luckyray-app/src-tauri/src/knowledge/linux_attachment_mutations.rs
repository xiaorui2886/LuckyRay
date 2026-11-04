//! Forward execution and provable rollback for Linux attachment mutations.
//!
//! Steps run in plan order and roll back in reverse. Each step is admitted by
//! sealed evidence, so a crash leaves an explainable state instead of a guess.
//! Rollback owns exactly two actions: rename a tombstone back to its original
//! name, and write the recorded Markdown bytes back. No user object is ever
//! unlinked here, and a state that cannot be proven stops the operation with a
//! report rather than being "made safe" by deleting something.
use super::attachment_operations::{
    bytes, hold_external_dependencies, hold_unreferenced_attachment, AttachmentFileChange,
    AttachmentOperationIssue,
};
use super::attachments::hold_verified_attachment;
use super::linux_attachment_import::{
    admit_linux_attachment_operation, import_dependencies, step_is_private,
};
use super::*;
use crate::linux_attachment_store::ImportStore;
use std::io;

/// Result of one forward step; `true` means the step was already durable.
type StepOutcome = io::Result<bool>;

/// Read-only recovery state of one Vault. A tombstone is the original inode a
/// `Remove` step renamed aside; nothing is cleaned automatically (D3). Only the
/// Linux port creates tombstones, so this type is Linux-only too.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentRecoverySummary {
    pub tombstones: usize,
}

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

/// A tombstone this Vault's own removals leave behind: `.lrk-<id>-<index>.removed`.
fn is_tombstone_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".lrk-") else {
        return false;
    };
    let Some((id, rest)) = rest.split_once('-') else {
        return false;
    };
    let Some(index) = rest.strip_suffix(".removed") else {
        return false;
    };
    id.len() == 32
        && id.bytes().all(|byte| byte.is_ascii_hexdigit())
        && !index.is_empty()
        && index.bytes().all(|byte| byte.is_ascii_digit())
}

impl KnowledgeService {
    /// Single Linux execution entry; `admit` already restricted the kind.
    pub(super) fn execute_linux_attachment_operation_unlocked(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        source_epoch: u64,
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        match operation.kind.as_str() {
            "import" => self.execute_linux_attachment_import_unlocked(vault, operation, cancelled),
            "attachment-rename" | "conversion" | "note-move" | "external-reference-update"
            | "attachment-relink" => self
                .execute_linux_attachment_mutation_unlocked(
                    vault,
                    operation,
                    source_epoch,
                    cancelled,
                ),
            _ => Err(linux_knowledge_write_unavailable()),
        }
    }

    /// Single Linux recovery entry. `rollback` is passed through: an import has
    /// no removal to undo, a mutation can prove both of its inverse actions.
    pub(super) fn recover_linux_attachment_operation_unlocked(
        &self,
        vault: &TrustedVault,
        id: &str,
        source_epoch: u64,
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
            "attachment-rename" | "conversion" | "note-move" | "external-reference-update"
            | "attachment-relink" => self
                .run_linux_attachment_mutation(
                    vault,
                    &operation,
                    id,
                    &store,
                    &guard,
                    &identity,
                    source_epoch,
                    rollback,
                    cancelled,
                ),
            _ => Err(linux_knowledge_write_unavailable()),
        }
    }

    fn execute_linux_attachment_mutation_unlocked(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        source_epoch: u64,
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
            source_epoch,
            false,
            cancelled,
        )
    }

    /// Order matters: a creation runs before the rewrites that point at it and
    /// the removal runs last, so an interruption never leaves Markdown pointing
    /// at a missing attachment.
    #[allow(clippy::too_many_arguments)]
    fn run_linux_attachment_mutation(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        id: &str,
        store: &ImportStore,
        guard: &FilesystemDirectoryIdentityGuard,
        identity: &KnowledgeTargetIdentity,
        source_epoch: u64,
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
        // The external witness and its short-lived evidence gate the whole
        // operation, exactly as on Windows. A rollback re-reads nothing external,
        // so an expired witness never blocks an undo.
        let _external_files = if super::attachment_witness::witness_required(rollback) {
            self.hold_external_plan(vault, operation, source_epoch)?
        } else {
            Vec::new()
        };
        let _external_locations = if super::attachment_witness::witness_required(rollback) {
            hold_external_dependencies(operation)?
        } else {
            Vec::new()
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
            #[cfg(test)]
            if result.completed_files == self.attachment_fault_after_steps.load(Ordering::Acquire) {
                self.attachment_fault_after_steps.store(usize::MAX, Ordering::Release);
                result.status = "partial".into();
                result.issues.push(AttachmentOperationIssue {
                    document: file.relative_path.clone(),
                    target: String::new(),
                    status: "injected-interruption".into(),
                });
                break;
            }
            let outcome = if rollback {
                self.rollback_linux_attachment_step(
                    vault, file, index, store, guard, identity, cancelled,
                )
            } else {
                self.apply_linux_attachment_step(
                    vault, file, index, operation, store, guard, identity, cancelled,
                )
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
        // Same rule as Windows: when the catalog still has to move a file (or
        // record a path outside the Vault), the durable result stays pending
        // until that projection appends its own result. The caller still gets
        // the Markdown outcome. Only a material file move has such a step here.
        let mut durable_result = result.clone();
        if !operation.external_paths.is_empty()
            || operation.material_relocation.is_some()
            || operation.material_file_move.is_some()
        {
            durable_result.status = "partial".into();
            durable_result.issues.push(AttachmentOperationIssue {
                document: String::new(),
                target: String::new(),
                status: "attachment-projection-pending".into(),
            });
        }
        let encoded = serde_json::to_vec(&durable_result)
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
        // Test-only seams shared with the Windows engine: a hook that runs
        // after final validation (the target is then re-proved) and an
        // injected write failure before publication.
        #[cfg(test)]
        {
            let hook = self.after_final_validation.lock().expect("knowledge test hook lock").take();
            if let Some(hook) = hook {
                hook();
                if let Err(failure) =
                    self.assert_expected_target_unlocked(vault, Some(identity), Some(guard))
                {
                    *admission_error = Some(failure);
                    return Err(crate::linux_fs::conflict());
                }
            }
            if self.write_fault_before_commit.swap(false, Ordering::AcqRel) {
                *admission_error = Some(error(
                    "knowledge-write-failed",
                    "Knowledge document write failed before commit",
                ));
                return Err(io::Error::other("injected write failure"));
            }
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_linux_attachment_step(
        &self,
        vault: &TrustedVault,
        file: &AttachmentFileChange,
        index: usize,
        operation: &AttachmentOperationPlan,
        store: &ImportStore,
        guard: &FilesystemDirectoryIdentityGuard,
        identity: &KnowledgeTargetIdentity,
        cancelled: &AtomicBool,
    ) -> Result<(), KnowledgeError> {
        let before = bytes(&file.before)?;
        let after = bytes(&file.after)?;
        let key = self.attachment_receipt_key(false)?;
        let private = step_is_private(&file.relative_path);
        // A note move publishes the rewritten document under its new name and
        // keeps the ordinary mode of the document it replaces; the source is the
        // plan's only removal. Every other creation is a private attachment.
        let move_source = if operation.kind == "note-move" {
            operation
                .files
                .iter()
                .find(|other| other.after.is_none())
                .map(|other| other.relative_path.as_str())
        } else {
            None
        };
        let mut admission_error: Option<KnowledgeError> = None;
        let outcome: StepOutcome = match (before.as_deref(), after.as_deref()) {
            (None, Some(content)) => match move_source {
                Some(source) => store.install_copying_mode(
                    index,
                    source,
                    &file.relative_path,
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
                None => store.install(index, &file.relative_path, content, &key, || {
                    self.admit_linux_attachment_step(
                        vault,
                        identity,
                        guard,
                        cancelled,
                        &mut admission_error,
                    )
                }),
            },
            (Some(previous), Some(content)) => {
                // The attachments this note will point at must still be the
                // exact object the plan recorded, held for the whole rewrite.
                let _attachments = operation
                    .attachment_dependencies
                    .iter()
                    .map(|(relative, digest)| {
                        hold_verified_attachment(&vault.root, relative, digest)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                store.install_replace(
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
                )
            }
            (Some(previous), None) => {
                // Preview is not a snapshot of future references: no Markdown may
                // still resolve to an attachment this step removes, and every
                // inspected note stays held. A note move removes a document, not
                // an attachment, so there is no attachment reference to rescan.
                let _references = if private {
                    hold_unreferenced_attachment(&vault.root, &file.relative_path)?
                } else {
                    Vec::new()
                };
                store.install_remove(index, &file.relative_path, previous, private, &key, || {
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
            admission_error.take().map_or_else(
                || {
                    // A shared creation refuses when the source carries an ACL or
                    // another attribute that a new inode cannot reproduce. That is
                    // a capability refusal, not a changed file, and nothing was
                    // written when it is reported.
                    if move_source.is_some() && failure.kind() == io::ErrorKind::Unsupported {
                        error(
                            "knowledge-linux-fs-unsupported",
                            "The source note carries an access control entry or another attribute that cannot be reproduced; nothing was written",
                        )
                    } else {
                        step_failure(failure)
                    }
                },
                |admission| admission,
            )
        })?;
        if !private {
            self.index.mark_document_dirty(&KnowledgeDocumentRef {
                vault_id: vault.registration.id.clone(),
                relative_path: file.relative_path.clone(),
            })?;
        }
        Ok(())
    }

    /// Reverse direction of the same engine. A created name is retained and
    /// reported, never deleted: later notes may already reference it.
    #[allow(clippy::too_many_arguments)]
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
        let private = step_is_private(&file.relative_path);
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
            None => store.restore_removed(
                index,
                &file.relative_path,
                previous,
                private,
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
        };
        outcome.map_err(|failure| {
            admission_error
                .take()
                .map_or_else(|| rollback_failure(failure), |admission| admission)
        })?;
        if !private {
            self.index.mark_document_dirty(&KnowledgeDocumentRef {
                vault_id: vault.registration.id.clone(),
                relative_path: file.relative_path.clone(),
            })?;
        }
        Ok(())
    }

    /// A note move reaches this engine only after the rewritten bytes were
    /// computed by the move preview, so execution writes exactly those bytes.
    /// A partial result is reported as the same `knowledge-operation-partial`
    /// the Windows runner produces.
    pub(super) fn execute_linux_note_move_unlocked(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
    ) -> Result<(), KnowledgeError> {
        let result = self.execute_linux_attachment_operation_unlocked(
            vault,
            operation,
            operation.source_epoch,
            &AtomicBool::new(false),
        )?;
        if result.status == "partial" {
            return Err(error(
                "knowledge-operation-partial",
                format!(
                    "Note move is partial; recover operation {} in Vault attachments",
                    result.operation_id
                ),
            ));
        }
        Ok(())
    }

    /// Read-only count of the tombstones this Vault's own removals left behind.
    /// Nothing is cleaned, moved or opened for writing.
    pub(crate) fn attachment_recovery_summary(
        &self,
        vault_id: &str,
    ) -> Result<AttachmentRecoverySummary, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if vault.registration.id != vault_id {
            return Err(knowledge_target_not_current());
        }
        let tombstones = count_tombstones(&vault.root)?;
        self.verify_current_target(&identity, &guard)?;
        Ok(AttachmentRecoverySummary { tombstones })
    }
}

fn count_tombstones(root: &Path) -> Result<usize, KnowledgeError> {
    let mut pending = vec![PathBuf::new()];
    let mut count = 0usize;
    let mut visited = 0usize;
    while let Some(relative) = pending.pop() {
        let directory = safe_existing_directory(root, &relative)?;
        let entries = std::fs::read_dir(&directory).map_err(|_| {
            error("knowledge-recovery-read-failed", "Cannot inspect the Vault")
        })?;
        for entry in entries {
            visited += 1;
            if visited > 100_000 {
                return Err(error(
                    "knowledge-recovery-read-failed",
                    "Vault exceeds the recovery inspection limit",
                ));
            }
            let entry = entry.map_err(|_| {
                error("knowledge-recovery-read-failed", "Cannot inspect the Vault")
            })?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if [".luckyray", ".obsidian", ".git"]
                .iter()
                .any(|reserved| name.eq_ignore_ascii_case(reserved))
            {
                continue;
            }
            let kind = entry.file_type().map_err(|_| {
                error("knowledge-recovery-read-failed", "Cannot inspect the Vault")
            })?;
            if kind.is_dir() {
                pending.push(relative.join(name));
            } else if kind.is_file() && is_tombstone_name(name) {
                count += 1;
            }
        }
    }
    Ok(count)
}
