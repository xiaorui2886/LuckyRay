//! Local recovery UI contract. This API grants no outside-Vault authority.
use super::*;

use super::note_recovery_types::*;

impl KnowledgeService {
    pub(crate) fn note_recovery_snapshot(
        &self,
        vault_id: &str,
        summary_only: bool,
    ) -> Result<RecoverySnapshot, KnowledgeError> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (vault_id, summary_only);
            Ok(RecoverySnapshot {
                supported: false,
                startup_blocked: false,
                records: Vec::new(),
                issues: Vec::new(),
                scan_incomplete: false,
            })
        }
        #[cfg(target_os = "macos")]
        {
            let _lock = self
                .mutation_lock
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Knowledge recovery lock failed"))?;
            let vault = self.current_vault_unlocked()?;
            if vault.registration.id != vault_id {
                return Err(knowledge_target_not_current());
            }
            let guard = filesystem_directory_identity_guard(&vault.root)
                .map_err(map_filesystem_identity_error)?;
            let root = guard
                .macos_directory(&vault.root)
                .map_err(map_filesystem_identity_error)?;
            let startup_blocked = self
                .recovery_needed
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Knowledge recovery state failed"))?
                .as_ref()
                == Some(&vault.root);
            let mut result = if summary_only {
                RecoverySnapshot {
                    supported: true,
                    startup_blocked,
                    records: Vec::new(),
                    issues: Vec::new(),
                    scan_incomplete: false,
                }
            } else {
                super::macos_note_recovery::snapshot(&root).map_err(recovery_failure)?
            };
            result.startup_blocked = startup_blocked;
            self.assert_current_vault_unlocked(vault_id, &vault.root)?;
            root.current().map_err(recovery_failure)?;
            Ok(result)
        }
    }

    pub(crate) fn recover_note_version(
        &self,
        source_epoch: u64,
        vault_id: &str,
        record_path: &str,
        token: &str,
        slot: &str,
        destination: Option<&str>,
        restore_original: bool,
    ) -> Result<String, KnowledgeError> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (
                source_epoch,
                vault_id,
                record_path,
                token,
                slot,
                destination,
                restore_original,
            );
            Err(error(
                "knowledge-recovery-unsupported",
                "This recovery entry is specific to macOS",
            ))
        }
        #[cfg(target_os = "macos")]
        {
            let _inventory_mutation = self.attachment_inventory.mutation();
            let _source = self.lock_active_ui_source(source_epoch, Some(vault_id))?;
            let _lock = self
                .mutation_lock
                .lock()
                .map_err(|_| error("knowledge-lock-poisoned", "Knowledge recovery lock failed"))?;
            let vault = self.current_vault_unlocked()?;
            if vault.registration.id != vault_id {
                return Err(knowledge_target_not_current());
            }
            let guard = filesystem_directory_identity_guard(&vault.root)
                .map_err(map_filesystem_identity_error)?;
            let identity = knowledge_target_identity(&vault, guard.identity())?;
            let root = guard
                .macos_directory(&vault.root)
                .map_err(map_filesystem_identity_error)?;
            let validate = || {
                self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&guard))
                    .map_err(|_| {
                        std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "knowledge-target-changed",
                        )
                    })
            };
            let path = if restore_original {
                if destination.is_some() {
                    return Err(error(
                        "knowledge-recovery-invalid",
                        "Original restoration cannot choose another target",
                    ));
                }
                super::macos_note_recovery::restore(&root, record_path, token, validate)
                    .map_err(recovery_failure)?
            } else {
                let path = destination.ok_or_else(|| {
                    error(
                        "knowledge-recovery-invalid",
                        "A new recovery copy name is required",
                    )
                })?;
                super::macos_note_recovery::copy_version(
                    &root,
                    record_path,
                    token,
                    slot,
                    path,
                    validate,
                )
                .map_err(recovery_failure)?;
                path.into()
            };
            if path.to_ascii_lowercase().ends_with(".md") {
                self.index.mark_document_dirty(&KnowledgeDocumentRef {
                    vault_id: vault_id.into(),
                    relative_path: path.clone(),
                })?;
            }
            Ok(path)
        }
    }
}
#[cfg(target_os = "macos")]
fn recovery_failure(_: std::io::Error) -> KnowledgeError {
    error("knowledge-recovery-required","Recovery is unconfirmed or conflicted. Refresh records and inspect existing files; a new copy may remain. No existing content was deleted or permissions changed")
}
