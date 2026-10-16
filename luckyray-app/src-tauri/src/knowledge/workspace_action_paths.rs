//! Parent-only shell handoff for a backend-verified captured document.
use super::*;

impl KnowledgeService {
    /// No renderer path enters this API. Keep the exact root/target identity
    /// alive until the synchronous shell handoff has finished.
    pub(crate) fn with_workspace_action_document_path<T>(
        &self, expected: &KnowledgeTargetIdentity, document_ref: &KnowledgeDocumentRef,
        revision: &str, action: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        self.workspace_recovery_record().map_err(crate::knowledge_error)?;
        let _mutation = self.mutation_lock.lock().map_err(|_| "workspace-action-lock")?;
        let vault = self.current_vault_unlocked().map_err(crate::knowledge_error)?;
        require_matching_vault(document_ref, &vault.registration).map_err(crate::knowledge_error)?;
        let root_guard = filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error).map_err(crate::knowledge_error)?;
        if knowledge_target_identity(&vault, root_guard.identity()).map_err(crate::knowledge_error)? != *expected { return Err("workspace-action-source-changed".into()); }
        let relative = safe_markdown_relative_path(&document_ref.relative_path).map_err(crate::knowledge_error)?;
        let target = safe_existing_file(&vault.root, &relative).map_err(crate::knowledge_error)?;
        let _file_guard = super::attachments::hold_verified_attachment(&vault.root, &document_ref.relative_path, revision).map_err(crate::knowledge_error)?;
        let snapshot = self.snapshot_from_path(&vault, &relative, &target).map_err(crate::knowledge_error)?;
        if snapshot.revision != revision { return Err("workspace-action-revision-changed".into()); }
        self.assert_expected_target_unlocked(&vault, Some(expected), Some(&root_guard)).map_err(crate::knowledge_error)?;
        action(&target)
    }
}
