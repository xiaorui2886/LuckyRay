//! Graph-only handoff for exact, saved, vault-owned attachment tickets.
//! The broker supplies all paths and revisions from its captured graph, never
//! from an IPC path. Keep the note, root and attachment guards through launch.
use super::attachments::{hold_verified_attachment, read_scoped_attachment_bytes, resolve_attachment};
use super::markdown_links::{attachment_links, LinkSyntax};
use super::*;

impl KnowledgeService {
    pub(crate) fn with_workspace_graph_asset<T>(
        &self, expected: &KnowledgeTargetIdentity, source: &KnowledgeDocumentRef,
        source_revision: &str, target: &str, relative_path: &str,
        attachment_revision: &str, content_digest: Option<&str>,
        action: impl FnOnce(&Path, &[u8]) -> Result<T, String>,
    ) -> Result<T, String> {
        self.workspace_recovery_record().map_err(crate::knowledge_error)?;
        let _mutation = self.mutation_lock.lock().map_err(|_| "workspace-graph-action-lock")?;
        let vault = self.current_vault_unlocked().map_err(crate::knowledge_error)?;
        require_matching_vault(source, &vault.registration).map_err(crate::knowledge_error)?;
        let root = filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error).map_err(crate::knowledge_error)?;
        if knowledge_target_identity(&vault, root.identity()).map_err(crate::knowledge_error)? != *expected {
            return Err("workspace-graph-action-source-changed".into());
        }
        let _note = hold_verified_attachment(&vault.root, &source.relative_path, source_revision).map_err(crate::knowledge_error)?;
        let note = safe_markdown_relative_path(&source.relative_path).map_err(crate::knowledge_error)?;
        let bytes = read_scoped_attachment_bytes(&vault.root, &note).map_err(crate::knowledge_error)?;
        if bytes.len() > 8 * 1024 * 1024 || sha256_hex(&bytes) != source_revision {
            return Err("workspace-graph-action-revision-changed".into());
        }
        let content = decode_document(&bytes).map_err(crate::knowledge_error)?.content;
        if !attachment_links(&content).iter().any(|link| link.destination == target && link.syntax == LinkSyntax::Wiki) {
            return Err("workspace-graph-action-reference-changed".into());
        }
        let (inventory, _) = self.attachment_inventory.get_or_build(&vault, &root, expected).map_err(crate::knowledge_error)?;
        let resolved = resolve_attachment(&vault.root, &inventory, &source.relative_path, target, LinkSyntax::Wiki).map_err(crate::knowledge_error)?;
        if resolved.status != "resolved" || resolved.relative_path.as_deref() != Some(relative_path)
            || resolved.version.as_deref() != Some(attachment_revision) {
            return Err("workspace-graph-action-asset-changed".into());
        }
        let relative = safe_relative_path(relative_path, false).map_err(crate::knowledge_error)?;
        let path = safe_existing_file(&vault.root, &relative).map_err(crate::knowledge_error)?;
        let asset_bytes = read_scoped_attachment_bytes(&vault.root, &relative).map_err(crate::knowledge_error)?;
        let digest = sha256_hex(&asset_bytes);
        if content_digest.is_some_and(|expected| expected != digest) { return Err("workspace-graph-action-asset-changed".into()); }
        let _asset = hold_verified_attachment(&vault.root, relative_path, &digest).map_err(crate::knowledge_error)?;
        if sha256_hex(&read_scoped_attachment_bytes(&vault.root, &note).map_err(crate::knowledge_error)?) != source_revision {
            return Err("workspace-graph-action-revision-changed".into());
        }
        self.assert_expected_target_unlocked(&vault, Some(expected), Some(&root)).map_err(crate::knowledge_error)?;
        action(&path, &asset_bytes)
    }
}

impl KnowledgeService {
    /// Revalidate missing-target proof at the actual mutation boundary while
    /// holding the source file, captured root and the service mutation lock.
    pub(crate) fn create_workspace_graph_missing(
        &self, expected:&KnowledgeTargetIdentity, source:&KnowledgeDocumentRef,
        revision:&str, raw_target:&str, target:&crate::workspace_graph::MissingDocumentTarget,
    )->Result<KnowledgeDocumentSnapshot,KnowledgeError>{
        self.workspace_recovery_record()?;
        let _mutation=self.mutation_lock.lock().map_err(|_|error("knowledge-lock-poisoned","Knowledge lock failed"))?;
        let vault=self.current_vault_unlocked()?;
        let root=self.capture_expected_target_unlocked(&vault,Some(expected))?;
        require_matching_vault(source,&vault.registration)?;
        let source_relative=safe_markdown_relative_path(&source.relative_path)?;
        let _source=hold_verified_attachment(&vault.root,&source.relative_path,revision)?;
        if sha256_hex(&read_scoped_attachment_bytes(&vault.root,&source_relative)?)!=revision{return Err(error("knowledge-revision-conflict","Graph source note changed before creation"));}
        let index=self.index.refresh(&vault)?;
        if index.stale||!index.errors.is_empty()||index.refresh_error.is_some(){return Err(error("workspace-graph-index-incomplete","Graph source index is incomplete"));}
        let source_note=index.documents.iter().find(|document|document.document_ref==*source).ok_or_else(||error("knowledge-not-found","Graph source note is missing"))?;
        if source_note.revision!=revision||!source_note.wiki_links.iter().any(|link|link.target.split('|').next()==Some(raw_target))
            ||crate::workspace_graph::missing_document_target(&source.relative_path,raw_target).as_ref()!=Some(target)
            ||!crate::workspace_graph::missing_target_is_unresolved(&index,source,raw_target){return Err(error("workspace-graph-create-conflict","Graph target is no longer missing"));}
        let relative=safe_markdown_relative_path(&target.relative_path)?;
        let parent=relative.parent().unwrap_or_else(||Path::new(""));
        let directory=if parent.as_os_str().is_empty(){vault.root.clone()}else{safe_existing_directory(&vault.root,parent)?};
        let _parents=attachments::guard_existing_ancestors(&vault.root,&directory.join("note"))?;
        let destination=directory.join(relative.file_name().ok_or_else(||error("knowledge-invalid-path","Missing document target is invalid"))?);
        if destination.exists(){return Err(error("knowledge-name-conflict","A document with this name already exists"));}
        if sha256_hex(&read_scoped_attachment_bytes(&vault.root,&source_relative)?)!=revision{return Err(error("knowledge-revision-conflict","Graph source note changed before creation"));}
        self.assert_expected_target_unlocked(&vault,Some(expected),root.as_ref())?;
        self.write_document(&destination,b"",false)?;
        self.assert_expected_target_unlocked(&vault,Some(expected),root.as_ref())?;
        let created=self.snapshot_from_path(&vault,&relative,&destination)?;
        self.index.mark_document_dirty(&created.summary.document_ref)?;
        Ok(created)
    }
}
