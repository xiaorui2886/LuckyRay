//! Writes derived from an already captured workspace note, never Main's active vault.
use super::*;

impl KnowledgeService {
    /// Compare captured scope identities without reacquiring the mutation lock
    /// while a verified attachment handoff already holds it.
    pub(crate) fn same_workspace_attachment_source(&self, other: &Self) -> bool {
        match (&self.workspace_scope, &other.workspace_scope) {
            (Some((_, source)), Some((_, other_source))) => source == other_source,
            _ => false,
        }
    }

    pub(crate) fn workspace_create_sibling(
        &self, expected: &KnowledgeTargetIdentity, source: &KnowledgeDocumentRef,
        revision: &str, title: &str, content: &str,
    ) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
        self.workspace_recovery_record()?;
        let _lock = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let root = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        require_matching_vault(source, &vault.registration)?;
        let relative = safe_markdown_relative_path(&source.relative_path)?;
        let source_path = safe_existing_file(&vault.root, &relative)?;
        let mut source_file = open_exclusive_document(&source_path)?;
        if sha256_hex(&read_exclusive_document(&mut source_file)?) != revision {
            return Err(error("knowledge-revision-conflict", "Source note changed before creation"));
        }
        // The renderer chooses a title, never a directory.
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let name = safe_markdown_name(title)?;
        let destination_relative = parent.join(name);
        let directory = if parent.as_os_str().is_empty() { vault.root.clone() } else { safe_existing_directory(&vault.root, parent)? };
        let _parents = attachments::guard_existing_ancestors(&vault.root, &directory.join("note"))?;
        let destination = directory.join(destination_relative.file_name().unwrap_or_default());
        if destination.exists() { return Err(error("knowledge-name-conflict", "A document with this name already exists")); }
        self.assert_expected_target_unlocked(&vault, Some(expected), root.as_ref())?;
        self.write_document(&destination, content.as_bytes(), false)?;
        self.assert_expected_target_unlocked(&vault, Some(expected), root.as_ref())?;
        let snapshot = self.snapshot_from_path(&vault, &destination_relative, &destination)?;
        self.index.mark_document_dirty(&snapshot.summary.document_ref)?;
        Ok(snapshot)
    }

    pub(crate) fn workspace_publish_attachment(
        &self, expected: &KnowledgeTargetIdentity, source: &KnowledgeDocumentRef,
        revision: &str, name: &str, bytes: &[u8],
    ) -> Result<AttachmentPublication, KnowledgeError> {
        self.workspace_recovery_record()?;
        if bytes.len() > 32 * 1024 * 1024 { return Err(error("workspace-note-attachment-limit", "Attachment exceeds 32 MiB")); }
        let _inventory = self.attachment_inventory.mutation();
        let _lock = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let root = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        require_matching_vault(source, &vault.registration)?;
        let relative = safe_markdown_relative_path(&source.relative_path)?;
        let target = safe_existing_file(&vault.root, &relative)?;
        let mut note = open_exclusive_document(&target)?;
        if sha256_hex(&read_exclusive_document(&mut note)?) != revision {
            return Err(error("knowledge-revision-conflict", "Source note changed before attachment import"));
        }
        let inventory = index::attachment_inventory(&vault.root)?;
        self.assert_expected_target_unlocked(&vault, Some(expected), root.as_ref())?;
        let result = attachments::publish_bytes(&vault.root, &inventory, &source.relative_path, name, bytes)?;
        self.assert_expected_target_unlocked(&vault, Some(expected), root.as_ref())?;
        Ok(result)
    }

    /// Verify only this backend-created publication. In particular, saved note
    /// text is never rescanned here to discover or grant unrelated attachments.
    pub(crate) fn with_workspace_attachment_publication<T>(
        &self, expected: &KnowledgeTargetIdentity, source: &KnowledgeDocumentRef,
        revision: &str, content: &str, publication: &AttachmentPublication,
        commit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.workspace_recovery_record().map_err(crate::knowledge_error)?;
        if content.len() > 8 * 1024 * 1024 || publication.bytes > 64 * 1024 * 1024
            || revision.is_empty() || revision.len() > 128 || publication.sha256.len() != 64
            || !publication.sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err("workspace-note-publication-invalid".into());
        }
        let _mutation = self.mutation_lock.lock().map_err(|_| "workspace-attachment-lock")?;
        let vault = self.current_vault_unlocked().map_err(crate::knowledge_error)?;
        let root = self.capture_expected_target_unlocked(&vault, Some(expected)).map_err(crate::knowledge_error)?;
        require_matching_vault(source, &vault.registration).map_err(crate::knowledge_error)?;
        let note = safe_markdown_relative_path(&source.relative_path).map_err(crate::knowledge_error)?;
        let _note_guard = attachments::hold_verified_attachment(&vault.root, &source.relative_path, revision).map_err(crate::knowledge_error)?;
        let note_bytes = attachments::read_scoped_attachment_bytes(&vault.root, &note).map_err(crate::knowledge_error)?;
        if note_bytes.len() > 8 * 1024 * 1024 || sha256_hex(&note_bytes) != revision
            || decode_document(&note_bytes).map_err(crate::knowledge_error)?.content != content {
            return Err("knowledge-revision-conflict".into());
        }
        let relative = safe_relative_path(&publication.relative_path, false).map_err(crate::knowledge_error)?;
        if relative_path_string(&relative) != publication.relative_path { return Err("workspace-note-publication-invalid".into()); }
        let _attachment_guard = attachments::hold_verified_attachment(&vault.root, &publication.relative_path, &publication.sha256).map_err(crate::knowledge_error)?;
        let bytes = attachments::read_scoped_attachment_bytes(&vault.root, &relative).map_err(crate::knowledge_error)?;
        let verified = attachments::publication(&source.relative_path, publication.relative_path.clone(), &bytes, publication.reused);
        if bytes.len() > 64 * 1024 * 1024 || verified.sha256 != publication.sha256
            || verified.bytes != publication.bytes || verified.markdown != publication.markdown {
            return Err("workspace-note-publication-invalid".into());
        }
        if sha256_hex(&attachments::read_scoped_attachment_bytes(&vault.root, &note).map_err(crate::knowledge_error)?) != revision {
            return Err("knowledge-revision-conflict".into());
        }
        self.assert_expected_target_unlocked(&vault, Some(expected), root.as_ref()).map_err(crate::knowledge_error)?;
        commit()
    }

    /// Only an already-issued opaque token may reach this helper. Resolve the
    /// parser-confirmed saved reference again and hold the exact source and file
    /// through the synchronous opener; no native path crosses the command API.
    pub(crate) fn with_workspace_attachment_open_path<T>(
        &self, expected: &KnowledgeTargetIdentity, source: &KnowledgeDocumentRef,
        revision: &str, destination: &str, wiki: bool, allowed_identity: &str, digest: &str,
        open: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        use super::markdown_links::{attachment_links, LinkSyntax};
        self.workspace_recovery_record().map_err(crate::knowledge_error)?;
        if revision.is_empty() || revision.len() > 128 || destination.is_empty() || destination.len() > 8192
            || digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err("workspace-attachment-denied".into());
        }
        let _mutation = self.mutation_lock.lock().map_err(|_| "workspace-attachment-lock")?;
        let vault = self.current_vault_unlocked().map_err(crate::knowledge_error)?;
        require_matching_vault(source, &vault.registration).map_err(crate::knowledge_error)?;
        let root_guard = filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error).map_err(crate::knowledge_error)?;
        if knowledge_target_identity(&vault, root_guard.identity()).map_err(crate::knowledge_error)? != *expected { return Err("workspace-attachment-denied".into()); }
        let note = safe_markdown_relative_path(&source.relative_path).map_err(crate::knowledge_error)?;
        let _note_guard = attachments::hold_verified_attachment(&vault.root, &source.relative_path, revision).map_err(crate::knowledge_error)?;
        let note_bytes = attachments::read_scoped_attachment_bytes(&vault.root, &note).map_err(crate::knowledge_error)?;
        if note_bytes.len() > 8 * 1024 * 1024 || sha256_hex(&note_bytes) != revision { return Err("workspace-attachment-revision-stale".into()); }
        let syntax = if wiki { LinkSyntax::Wiki } else { LinkSyntax::Markdown };
        let content = decode_document(&note_bytes).map_err(crate::knowledge_error)?.content;
        if !attachment_links(&content).iter().any(|link| link.destination == destination && link.syntax == syntax) {
            return Err("workspace-attachment-not-referenced".into());
        }
        let (inventory, _) = self.attachment_inventory.get_or_build(&vault, &root_guard, expected).map_err(crate::knowledge_error)?;
        let resolved = attachments::resolve_attachment(&vault.root, &inventory, &source.relative_path, destination, syntax).map_err(crate::knowledge_error)?;
        let identity = resolved.relative_path.filter(|_| resolved.status == "resolved").ok_or("workspace-attachment-unavailable")?;
        if identity != allowed_identity { return Err("workspace-attachment-main-grant-required".into()); }
        let relative = safe_relative_path(&identity, false).map_err(crate::knowledge_error)?;
        let extension = relative.extension().and_then(|value| value.to_str()).unwrap_or_default();
        if extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown") { return Err("workspace-attachment-markdown-unsupported".into()); }
        let _attachment_guard = attachments::hold_verified_attachment(&vault.root, &identity, digest).map_err(crate::knowledge_error)?;
        let bytes = attachments::read_scoped_attachment_bytes(&vault.root, &relative).map_err(crate::knowledge_error)?;
        if bytes.len() > 64 * 1024 * 1024 || sha256_hex(&bytes) != digest { return Err("workspace-attachment-denied".into()); }
        let path = safe_existing_file(&vault.root, &relative).map_err(crate::knowledge_error)?;
        if sha256_hex(&attachments::read_scoped_attachment_bytes(&vault.root, &note).map_err(crate::knowledge_error)?) != revision {
            return Err("workspace-attachment-revision-stale".into());
        }
        self.assert_expected_target_unlocked(&vault, Some(expected), Some(&root_guard)).map_err(crate::knowledge_error)?;
        open(&path)
    }

    pub(crate) fn workspace_markdown_bytes(
        &self, expected: &KnowledgeTargetIdentity, source: &KnowledgeDocumentRef, revision: &str,
    ) -> Result<Vec<u8>, KnowledgeError> {
        self.workspace_recovery_record()?;
        let _lock = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let root = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        require_matching_vault(source, &vault.registration)?;
        let _file = attachments::hold_verified_attachment(&vault.root, &source.relative_path, revision)?;
        let bytes = attachments::read_scoped_attachment_bytes(&vault.root, &safe_markdown_relative_path(&source.relative_path)?)?;
        if bytes.len() > 8 * 1024 * 1024 || sha256_hex(&bytes) != revision {
            return Err(error("knowledge-revision-conflict", "Source note changed before export"));
        }
        self.assert_expected_target_unlocked(&vault, Some(expected), root.as_ref())?;
        Ok(bytes)
    }

    /// Used only after the native Main picker has returned this exact path.
    /// There is deliberately no command accepting a renderer supplied path.
    pub(crate) fn workspace_read_picked_file(&self, path: &Path, limit: usize) -> Result<Vec<u8>, KnowledgeError> {
        self.workspace_recovery_record()?;
        if !path.is_absolute() { return Err(error("workspace-note-picker-path-invalid", "Picker did not return an absolute file")); }
        for ancestor in path.ancestors().filter(|part| !part.as_os_str().is_empty()) {
            if has_reparse_point(ancestor)? { return Err(error("knowledge-path-reparse-forbidden", "Picked file traverses a linked path")); }
        }
        let bytes = attachments::read_attachment_bytes(path)?;
        if bytes.len() > limit { return Err(error("workspace-note-file-limit", "Picked file exceeds the operation limit")); }
        Ok(bytes)
    }

    pub(crate) fn workspace_decode_markdown(bytes: &[u8]) -> Result<String, KnowledgeError> {
        if bytes.len() > 8 * 1024 * 1024 { return Err(error("workspace-note-content-limit", "Markdown exceeds 8 MiB")); }
        Ok(decode_document(bytes)?.content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(content: &str) -> (tempfile::TempDir, KnowledgeService, KnowledgeDocumentRef, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let registration = KnowledgeVaultRegistration { id: "vault".into(), name: "Fixture".into(), root_path: root.to_string_lossy().into(), mode: "vault-bound".into(), created_at: "2026-10-06T00:00:00Z".into(), last_opened_at: "2026-10-06T00:00:00Z".into(), schema_version: 1, link_update_policy: Default::default() };
        std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        std::fs::write(root.join("note.md"), content).unwrap();
        std::fs::write(root.join("report.pdf"), b"synthetic-pdf").unwrap();
        std::fs::write(root.join("secret.pdf"), b"private").unwrap();
        std::fs::write(root.join("other.md"), "# Other").unwrap();
        std::fs::write(root.join("other.markdown"), "# Other").unwrap();
        let service = KnowledgeService::initialize(temp.path().join("app")).unwrap();
        service.register_current_vault(&registration).unwrap();
        (temp, service.capture_workspace_scope("vault").unwrap(), KnowledgeDocumentRef { vault_id: "vault".into(), relative_path: "note.md".into() }, sha256_hex(content.as_bytes()))
    }

    #[test]
    fn open_handoff_requires_exact_saved_reference_identity_and_bytes() {
        let content = "# Note\n[report](report.pdf)\n`[hidden](secret.pdf)`";
        let (temp, scope, note, revision) = fixture(content);
        let expected = scope.current_target_identity().unwrap();
        let digest = sha256_hex(b"synthetic-pdf");
        let path = scope.with_workspace_attachment_open_path(&expected, &note, &revision, "report.pdf", false, "report.pdf", &digest, |path| Ok(path.to_owned())).unwrap();
        // Windows temp paths may use a short-name alias while the opener returns a verbatim canonical path.
        assert_eq!(path.canonicalize().unwrap(), temp.path().join("vault/report.pdf").canonicalize().unwrap());
        for (request_revision, destination, wiki, identity, hash) in [
            ("stale", "report.pdf", false, "report.pdf", digest.as_str()),
            (revision.as_str(), "secret.pdf", false, "secret.pdf", digest.as_str()),
            (revision.as_str(), "report.pdf", true, "report.pdf", digest.as_str()),
            (revision.as_str(), "report.pdf", false, "secret.pdf", digest.as_str()),
            (revision.as_str(), "report.pdf", false, "report.pdf", "invalid"),
            (revision.as_str(), "/etc/passwd", false, "report.pdf", digest.as_str()),
            (revision.as_str(), "../report.pdf", false, "report.pdf", digest.as_str()),
        ] {
            assert!(scope.with_workspace_attachment_open_path::<()>(&expected, &note, request_revision, destination, wiki, identity, hash, |_| panic!("must not hand off rejected reference")).is_err());
        }
        let wrong_note = KnowledgeDocumentRef { relative_path: "other.md".into(), ..note.clone() };
        assert!(scope.with_workspace_attachment_open_path::<()>(&expected, &wrong_note, &revision, "report.pdf", false, "report.pdf", &digest, |_| panic!("must not open another note's attachment")).is_err());
        let wrong_vault = KnowledgeDocumentRef { vault_id: "other".into(), ..note.clone() };
        assert!(scope.with_workspace_attachment_open_path::<()>(&expected, &wrong_vault, &revision, "report.pdf", false, "report.pdf", &digest, |_| panic!("must not open another vault's attachment")).is_err());
    }

    #[test]
    fn same_vault_id_in_another_root_does_not_match_captured_source() {
        let (_temp, scope, _, _) = fixture("# Note");
        let (_other_temp, other, _, _) = fixture("# Note");
        assert!(scope.same_workspace_attachment_source(&scope.clone()));
        assert!(!scope.same_workspace_attachment_source(&other));
    }

    #[test]
    fn changed_or_oversized_attachment_never_reaches_opener() {
        let (temp, scope, note, revision) = fixture("[report](report.pdf)");
        let expected = scope.current_target_identity().unwrap();
        let digest = sha256_hex(b"synthetic-pdf");
        std::fs::write(temp.path().join("vault/report.pdf"), b"external-edit").unwrap();
        assert!(scope.with_workspace_attachment_open_path::<()>(&expected, &note, &revision, "report.pdf", false, "report.pdf", &digest, |_| panic!("must not open edited attachment")).is_err());
        OpenOptions::new().write(true).open(temp.path().join("vault/report.pdf")).unwrap().set_len(64 * 1024 * 1024 + 1).unwrap();
        assert!(scope.with_workspace_attachment_open_path::<()>(&expected, &note, &revision, "report.pdf", false, "report.pdf", &digest, |_| panic!("must not open oversized attachment")).is_err());
    }

    #[test]
    fn removed_reference_and_changed_root_revoke_handoff() {
        let (temp, scope, note, revision) = fixture("[report](report.pdf)");
        let expected = scope.current_target_identity().unwrap();
        let digest = sha256_hex(b"synthetic-pdf");
        std::fs::write(temp.path().join("vault/note.md"), "# Reference removed").unwrap();
        for revision in [&revision, &sha256_hex(b"# Reference removed")] {
            assert!(scope.with_workspace_attachment_open_path::<()>(&expected, &note, revision, "report.pdf", false, "report.pdf", &digest, |_| panic!("must not open removed reference")).is_err());
        }
        std::fs::rename(temp.path().join("vault"), temp.path().join("old-vault")).unwrap();
        std::fs::create_dir_all(temp.path().join("vault/.luckyray")).unwrap();
        std::fs::copy(temp.path().join("old-vault/.luckyray/vault.json"), temp.path().join("vault/.luckyray/vault.json")).unwrap();
        std::fs::write(temp.path().join("vault/note.md"), "[report](report.pdf)").unwrap();
        std::fs::write(temp.path().join("vault/report.pdf"), b"synthetic-pdf").unwrap();
        assert!(scope.with_workspace_attachment_open_path::<()>(&expected, &note, &revision, "report.pdf", false, "report.pdf", &digest, |_| panic!("must not open replaced root")).is_err());
    }

    #[test]
    fn markdown_transclusions_are_explicitly_unsupported() {
        let (_temp, scope, note, revision) = fixture("![[other.md]]\n![[other.markdown]]");
        let expected = scope.current_target_identity().unwrap();
        for destination in ["other.md", "other.markdown"] {
            let result = scope.with_workspace_attachment_open_path::<()>(&expected, &note, &revision, destination, true, destination, &sha256_hex(b"# Other"), |_| panic!("must not open markdown transclusions"));
            assert_eq!(result.unwrap_err(), "workspace-attachment-markdown-unsupported");
        }
    }
}
