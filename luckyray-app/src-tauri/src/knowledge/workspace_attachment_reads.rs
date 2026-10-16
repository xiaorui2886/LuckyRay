//! Exact persisted-note attachment reads for registered workspace children.
//! No draft-path grants, external approvals, root changes or path-bearing output.
use super::attachments::{hold_verified_attachment, read_scoped_attachment_bytes, resolve_attachment};
use super::markdown_links::{attachment_links, LinkSyntax};
use super::*;

impl KnowledgeService {
    /// Called only while Main grants the note. Child edits never refresh this
    /// baseline. Resolved relative identities remain inside the trusted scope.
    pub(crate) fn workspace_attachment_references(&self, document_ref: &KnowledgeDocumentRef) -> Result<Vec<(String, bool, String)>, KnowledgeError> {
        let _mutation = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        require_matching_vault(document_ref, &vault.registration)?;
        let root_guard = filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(&vault, root_guard.identity())?;
        let note = safe_markdown_relative_path(&document_ref.relative_path)?;
        let note_bytes = read_scoped_attachment_bytes(&vault.root, &note)?;
        if note_bytes.len() > 8 * 1024 * 1024 { return Err(error("workspace-attachment-denied", "Note exceeds attachment scan limit")); }
        let revision = sha256_hex(&note_bytes);
        let _note_guard = hold_verified_attachment(&vault.root, &document_ref.relative_path, &revision)?;
        let links = attachment_links(&decode_document(&note_bytes)?.content);
        if links.len() > 4096 { return Err(error("workspace-attachment-reference-limit", "Note has too many attachment references")); }
        let (inventory, _) = self.attachment_inventory.get_or_build(&vault, &root_guard, &identity)?;
        let mut references = Vec::new();
        for link in links {
            if let Ok(resolved) = resolve_attachment(&vault.root, &inventory, &document_ref.relative_path, &link.destination, link.syntax) {
                if let Some(relative) = resolved.relative_path.filter(|_| resolved.status == "resolved") {
                    if references.len() >= 256 { return Err(error("workspace-attachment-reference-limit", "Note has too many resolved attachment references")); }
                    references.push((link.destination, link.syntax == LinkSyntax::Wiki, relative));
                }
            }
        }
        if sha256_hex(&read_scoped_attachment_bytes(&vault.root, &note)?) != revision { return Err(error("workspace-attachment-revision-stale", "Note changed while its attachment grant was captured")); }
        self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&root_guard))?;
        Ok(references)
    }
    pub(crate) fn read_workspace_attachment(
        &self,
        document_ref: &KnowledgeDocumentRef,
        revision: &str,
        destination: &str,
        wiki: bool,
        allowed_identity: &str,
    ) -> Result<(Vec<u8>, String, String), KnowledgeError> {
        if revision.is_empty() || revision.len() > 128 || destination.is_empty() || destination.len() > 8192 {
            return Err(error("workspace-attachment-denied", "Attachment request is invalid"));
        }
        // Use the captured KnowledgeService's authority; never activate Main's vault.
        let _mutation = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        require_matching_vault(document_ref, &vault.registration)?;
        let root_guard = filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(&vault, root_guard.identity())?;
        let note = safe_markdown_relative_path(&document_ref.relative_path)?;
        let _note_guard = hold_verified_attachment(&vault.root, &document_ref.relative_path, revision)?;
        let note_bytes = read_scoped_attachment_bytes(&vault.root, &note)?;
        if note_bytes.len() > 8 * 1024 * 1024 || sha256_hex(&note_bytes) != revision {
            return Err(error("workspace-attachment-revision-stale", "Read the current saved note before resolving attachments"));
        }
        let syntax = if wiki { LinkSyntax::Wiki } else { LinkSyntax::Markdown };
        let content = decode_document(&note_bytes)?.content;
        if !attachment_links(&content).iter().any(|link| link.destination == destination && link.syntax == syntax) {
            // Text in a code block, a different note, or unsaved Markdown is not authority.
            return Err(error("workspace-attachment-not-referenced", "Save this attachment reference before previewing it"));
        }
        let (inventory, _) = self.attachment_inventory.get_or_build(&vault, &root_guard, &identity)?;
        let resolved = resolve_attachment(&vault.root, &inventory, &document_ref.relative_path, destination, syntax)?;
        let relative = resolved.relative_path.filter(|_| resolved.status == "resolved")
            .ok_or_else(|| error("workspace-attachment-unavailable", "Referenced attachment is unavailable"))?;
        if relative != allowed_identity {
            return Err(error("workspace-attachment-main-grant-required", "Attachment identity is outside the original Main grant"));
        }
        // Only vault-owned paths from the existing resolver reach the guarded reader.
        // In particular absolute/external references never receive an implicit approval.
        let identity_path = relative.clone();
        let relative = safe_relative_path(&relative, false)?;
        let extension = relative.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
        let bytes = read_scoped_attachment_bytes(&vault.root, &relative)?;
        // Recheck external edits on platforms where read handles cannot deny writes.
        if sha256_hex(&read_scoped_attachment_bytes(&vault.root, &note)?) != revision {
            return Err(error("workspace-attachment-revision-stale", "The saved note changed during attachment read"));
        }
        self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&root_guard))?;
        Ok((bytes, extension, identity_path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(content: &str) -> (KnowledgeService, PathBuf, KnowledgeDocumentRef, String) {
        let base = std::env::temp_dir().join(format!("workspace-attachment-test-{:032x}", rand::random::<u128>()));
        let root = base.join("vault");
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let registration = KnowledgeVaultRegistration { id: "vault".into(), name: "Synthetic test".into(), root_path: root.to_string_lossy().into(), mode: "vault-bound".into(), created_at: "2026-10-06T00:00:00Z".into(), last_opened_at: "2026-10-06T00:00:00Z".into(), schema_version: 1, link_update_policy: Default::default() };
        std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        std::fs::write(root.join("note.md"), content).unwrap();
        std::fs::write(root.join("picture.png"), b"synthetic-image").unwrap();
        std::fs::write(root.join("secret.png"), b"not-referenced").unwrap();
        let service = KnowledgeService::initialize(&base.join("app")).unwrap();
        service.register_current_vault(&registration).unwrap();
        let service = service.capture_workspace_scope("vault").unwrap();
        (service, root, KnowledgeDocumentRef { vault_id: "vault".into(), relative_path: "note.md".into() }, sha256_hex(content.as_bytes()))
    }

    #[test]
    fn exact_saved_reference_and_syntax_are_required() {
        let (service, _, note, revision) = fixture("![[picture.png]]\n`![[secret.png]]`");
        assert_eq!(service.read_workspace_attachment(&note, &revision, "picture.png", true, "picture.png").unwrap().0, b"synthetic-image");
        for (destination, wiki) in [("secret.png", true), ("picture.png", false), ("../secret.png", true), ("/etc/passwd", false), ("file:///etc/passwd", false)] {
            assert!(service.read_workspace_attachment(&note, &revision, destination, wiki, "picture.png").is_err());
        }
        let other_vault = KnowledgeDocumentRef { vault_id: "forged".into(), ..note.clone() };
        assert!(service.read_workspace_attachment(&other_vault, &revision, "picture.png", true, "picture.png").is_err());
    }

    #[test]
    fn source_baseline_is_resolved_and_does_not_include_unreferenced_files() {
        let (service, root, note, _) = fixture("![[picture.png]]");
        let baseline = service.workspace_attachment_references(&note).unwrap();
        assert_eq!(baseline, vec![("picture.png".into(), true, "picture.png".into())]);
        std::fs::write(root.join("note.md"), "![[picture.png]]\n![[secret.png]]").unwrap();
        assert!(!baseline.iter().any(|reference| reference.0 == "secret.png"));
    }

    #[test]
    fn stale_revision_and_removed_reference_are_rejected() {
        let (service, root, note, revision) = fixture("![[picture.png]]");
        assert!(service.read_workspace_attachment(&note, "forged", "picture.png", true, "picture.png").is_err());
        std::fs::write(root.join("note.md"), "new saved note").unwrap();
        assert!(service.read_workspace_attachment(&note, &revision, "picture.png", true, "picture.png").is_err());
        assert!(service.read_workspace_attachment(&note, &sha256_hex(b"new saved note"), "picture.png", true, "picture.png").is_err());
    }

    #[test]
    fn referenced_external_path_and_oversized_file_are_rejected() {
        let (service, root, note, _) = fixture("![external](../outside.png)\n![[picture.png]]");
        std::fs::write(root.parent().unwrap().join("outside.png"), b"outside").unwrap();
        let revision = service.read_document(&note).unwrap().revision;
        assert!(service.read_workspace_attachment(&note, &revision, "../outside.png", false, "outside.png").is_err());
        OpenOptions::new().write(true).open(root.join("picture.png")).unwrap().set_len(64 * 1024 * 1024 + 1).unwrap();
        assert!(service.read_workspace_attachment(&note, &revision, "picture.png", true, "picture.png").is_err());
    }
}
