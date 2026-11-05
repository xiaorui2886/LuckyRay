//! These call the production service, admission store and recovery path.
//! They require Darwin; Linux policy checks are not substitutes for them.
use super::*;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

#[test]
fn macos_folder_mutation_entry_gate_fails_closed() {
    let error = crate::folder_mutation_guard::require_safe_platform(cfg!(target_os = "macos"))
        .expect_err("native Mac folder entry must remain disabled until source binding is safe");
    assert!(error.starts_with("knowledge-folder-mutation-unavailable:"));
}

fn fixture() -> (
    tempfile::TempDir,
    KnowledgeService,
    PathBuf,
    KnowledgeVaultRegistration,
    u64,
) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("vault");
    std::fs::create_dir_all(root.join(".luckyray")).unwrap();
    let registration = KnowledgeVaultRegistration {
        id: "synthetic-recovery-vault".into(),
        name: "Synthetic recovery".into(),
        root_path: root.to_str().unwrap().into(),
        mode: "vault-bound".into(),
        created_at: "2026-11-02T00:00:00Z".into(),
        last_opened_at: "2026-11-02T00:00:00Z".into(),
        schema_version: VAULT_SCHEMA_VERSION,
        link_update_policy: Default::default(),
    };
    std::fs::write(
        root.join(".luckyray/vault.json"),
        serde_json::to_vec(&registration).unwrap(),
    )
    .unwrap();
    let service = KnowledgeService::initialize(base.join("app")).unwrap();
    service.register_current_vault(&registration).unwrap();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    (temp, service, root, registration, epoch)
}
fn replace_same_bytes(path: &Path) -> (PathBuf, u64, Vec<u8>) {
    let bytes = std::fs::read(path).unwrap();
    let original = std::fs::metadata(path).unwrap();
    assert_eq!(original.nlink(), 1);
    let held = path.with_file_name(format!("external-held-{:032x}", rand::random::<u128>()));
    assert!(!held.exists());
    std::fs::rename(path, &held).unwrap();
    let mut replacement = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(original.mode() & 0o777)
        .open(path)
        .unwrap();
    replacement.write_all(&bytes).unwrap();
    replacement.sync_all().unwrap();
    let actual = replacement.metadata().unwrap();
    assert_eq!(actual.mode() & 0o777, original.mode() & 0o777);
    assert_eq!(actual.nlink(), 1);
    assert_eq!((actual.uid(), actual.gid()), (original.uid(), original.gid()));
    assert_ne!((actual.dev(), actual.ino()), (original.dev(), original.ino()));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert_eq!(std::fs::read(&held).unwrap(), bytes);
    let inode = actual.ino();
    (held, inode, bytes)
}

#[test]
fn macos_ui_delete_retains_the_observed_note_for_recovery() {
    let (_temp, service, root, registration, epoch) = fixture();
    let path = root.join("Delete.md");
    let bytes = b"# Delete\n\nSynthetic delete.\n";
    std::fs::write(&path, bytes).unwrap();
    let original_inode = std::fs::metadata(&path).unwrap().ino();
    let document_ref = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Delete.md".into() };
    let observed = service.read_document(&document_ref).unwrap();
    service.delete_document_from_ui(epoch, &KnowledgeDeleteInput {
        document_ref, expected_revision: observed.revision,
        expected_file_identity: Some(observed.summary.file_identity.unwrap()),
    }).unwrap();
    assert!(!path.exists());
    let retained: Vec<_> = std::fs::read_dir(&root).unwrap().map(|entry| entry.unwrap().path())
        .filter(|p| p.file_name().and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".lrk-remove-") && name.ends_with(".backup")))
        .collect();
    assert_eq!(retained.len(), 1);
    assert_eq!(std::fs::metadata(&retained[0]).unwrap().ino(), original_inode);
    assert_eq!(std::fs::read(&retained[0]).unwrap(), bytes);
    let recovery = service.note_recovery_snapshot(&registration.id, false).unwrap();
    assert!(recovery.records.iter().any(|record| record.original_path == "Delete.md"
        && record.versions.iter().any(|version| version.slot == "retained" && version.revision == sha256_hex(bytes))));
}

#[test]
fn macos_ui_delete_rejects_a_same_bytes_replacement() {
    let (_temp, service, root, registration, epoch) = fixture();
    let path = root.join("Delete.md");
    std::fs::write(&path, b"synthetic retained note").unwrap();
    let document_ref = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Delete.md".into() };
    let observed = service.read_document(&document_ref).unwrap();
    let (held, replacement_inode, bytes) = replace_same_bytes(&path);
    let error = service.delete_document_from_ui(epoch, &KnowledgeDeleteInput {
        document_ref, expected_revision: observed.revision,
        expected_file_identity: Some(observed.summary.file_identity.unwrap()),
    }).unwrap_err();
    assert_eq!(error.code, "knowledge-document-identity-mismatch");
    assert_eq!(std::fs::metadata(&path).unwrap().ino(), replacement_inode);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read(&held).unwrap(), bytes);
    assert!(!std::fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".lrk-remove-")));
}

#[test]
fn macos_ui_delete_rejects_a_retired_vault_epoch() {
    let (_temp, service, root, registration, epoch) = fixture();
    let path = root.join("Delete.md");
    std::fs::write(&path, b"synthetic retained note").unwrap();
    let document_ref = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Delete.md".into() };
    let observed = service.read_document(&document_ref).unwrap();
    let next = service.activate_ui_source(&registration.id).unwrap().source_epoch;
    assert_ne!(epoch, next);
    let error = service.delete_document_from_ui(epoch, &KnowledgeDeleteInput {
        document_ref, expected_revision: observed.revision,
        expected_file_identity: Some(observed.summary.file_identity.unwrap()),
    }).unwrap_err();
    assert_eq!(error.code, "knowledge-source-inactive");
    assert_eq!(std::fs::read(&path).unwrap(), b"synthetic retained note");
}

#[test]
fn macos_move_and_delete_refuse_ambiguous_path_aliases() {
    for directory in ["Folder\\Child", " Folder", "Folder /Child", "Folder/ Child", "/Folder", "Folder/"] {
        assert!(crate::safe_vault_relative_directory_path(directory).is_err(), "{directory:?}");
    }
    for note in ["Folder\\Note.md", " Folder/Note.md", "Folder /Note.md", "Folder/ Note.md"] {
        assert!(crate::safe_vault_relative_markdown_path(note).is_err(), "{note:?}");
    }
    assert!(crate::safe_vault_relative_directory_path("").is_ok());
    assert!(crate::safe_vault_relative_directory_path("Folder With Spaces/Child").is_ok());
    assert!(crate::safe_vault_relative_markdown_path("Folder With Spaces/Note.md").is_ok());
    let (_temp, service, root, registration, epoch) = fixture();
    std::fs::create_dir(root.join("Folder")).unwrap();
    std::fs::create_dir(root.join("Moved")).unwrap();
    let nested = root.join("Folder/Note.md");
    let literal = root.join("Folder\\Note.md");
    std::fs::write(&nested, b"synthetic nested note").unwrap();
    std::fs::write(&literal, b"synthetic literal name").unwrap();
    let nested_ref = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Folder/Note.md".into() };
    let observed = service.read_document(&nested_ref).unwrap();
    let identity = observed.summary.file_identity.unwrap();
    let alias = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Folder\\Note.md".into() };
    let move_error = service.move_document_from_ui(epoch, &KnowledgeMoveInput {
        document_ref: alias.clone(), title: "Note.md".into(), expected_revision: observed.revision.clone(),
        parent_relative_path: Some("Moved".into()), expected_file_identity: Some(identity.clone()),
    }).unwrap_err();
    assert_eq!(move_error.code, "knowledge-invalid-document-ref");
    let delete_error = service.delete_document_from_ui(epoch, &KnowledgeDeleteInput {
        document_ref: alias, expected_revision: observed.revision.clone(), expected_file_identity: Some(identity.clone()),
    }).unwrap_err();
    assert_eq!(delete_error.code, "knowledge-invalid-document-ref");
    let parent_error = service.move_document_from_ui(epoch, &KnowledgeMoveInput {
        document_ref: nested_ref, title: "Note.md".into(), expected_revision: observed.revision,
        parent_relative_path: Some(" Moved".into()), expected_file_identity: Some(identity),
    }).unwrap_err();
    assert_eq!(parent_error.code, "knowledge-invalid-document-ref");
    assert_eq!(std::fs::read(&nested).unwrap(), b"synthetic nested note");
    assert_eq!(std::fs::read(&literal).unwrap(), b"synthetic literal name");
    assert!(!root.join("Moved/Note.md").exists());
}

#[test]
fn macos_ui_rename_preserves_bytes_and_rejects_replacement_or_occupied_target() {
    let (_temp, service, root, registration, epoch) = fixture();
    std::fs::create_dir(root.join("Folder")).unwrap();
    // A reference-style attachment link need not be rewritten when the
    // containing directory remains unchanged.
    let contents = b"# Before\n\n![image][asset]\n\n[asset]: ../attachments/image.png\n";
    let before_path = root.join("Folder/Before.md");
    let after_path = root.join("Folder/After.md");
    std::fs::write(&before_path, contents).unwrap();
    let before_ref = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Folder/Before.md".into() };
    let observed = service.read_document(&before_ref).unwrap();
    let renamed = service.move_document_from_ui(epoch, &KnowledgeMoveInput {
        document_ref: before_ref, title: "After".into(), parent_relative_path: Some("Folder".into()),
        expected_revision: observed.revision, expected_file_identity: Some(observed.summary.file_identity.unwrap()),
    }).unwrap();
    assert_eq!(renamed.summary.document_ref.relative_path, "Folder/After.md");
    assert!(!before_path.exists());
    assert_eq!(std::fs::read(&after_path).unwrap(), contents);
    #[cfg(feature = "macos-note-flow")]
    {
        let directory = crate::macos_fs::Directory::open(&root, false, false).unwrap();
        assert!(crate::macos_note_flow::missing(&directory, "Folder/Before.md"));
        assert!(!crate::macos_note_flow::missing(&directory, "Folder/After.md"));
        assert!(!crate::macos_note_flow::missing(&directory, "MissingParent/Note.md"));
    }

    let replaced_path = root.join("Folder/Replaced.md");
    std::fs::write(&replaced_path, b"same bytes").unwrap();
    let replaced_ref = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Folder/Replaced.md".into() };
    let old = service.read_document(&replaced_ref).unwrap();
    let (held, replacement_inode, bytes) = replace_same_bytes(&replaced_path);
    let error = service.move_document_from_ui(epoch, &KnowledgeMoveInput {
        document_ref: replaced_ref, title: "ReplacementTarget".into(), parent_relative_path: Some("Folder".into()),
        expected_revision: old.revision, expected_file_identity: Some(old.summary.file_identity.unwrap()),
    }).unwrap_err();
    assert_eq!(error.code, "knowledge-document-identity-mismatch");
    assert_eq!(std::fs::metadata(&replaced_path).unwrap().ino(), replacement_inode);
    assert_eq!(std::fs::read(&replaced_path).unwrap(), bytes);
    assert_eq!(std::fs::read(&held).unwrap(), bytes);
    assert!(!root.join("Folder/ReplacementTarget.md").exists());

    let occupied_source = root.join("Folder/Source.md");
    let occupied_target = root.join("Folder/Occupied.md");
    std::fs::write(&occupied_source, b"source").unwrap();
    std::fs::write(&occupied_target, b"foreign target").unwrap();
    let source_ref = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Folder/Source.md".into() };
    let old = service.read_document(&source_ref).unwrap();
    assert!(service.move_document_from_ui(epoch, &KnowledgeMoveInput {
        document_ref: source_ref, title: "Occupied".into(), parent_relative_path: Some("Folder".into()),
        expected_revision: old.revision, expected_file_identity: Some(old.summary.file_identity.unwrap()),
    }).is_err());
    assert_eq!(std::fs::read(&occupied_source).unwrap(), b"source");
    assert_eq!(std::fs::read(&occupied_target).unwrap(), b"foreign target");
}

// This exercises the protected service suggested for the UI fix. It does
// not prove that the production UI currently calls that service.
#[test]
fn macos_note_move_fixture_preserves_the_attachment_target_and_source() {
    use base64::Engine;
    let (_temp, service, root, registration, epoch) = fixture();
    std::fs::create_dir(root.join("Moved")).unwrap();
    std::fs::create_dir(root.join("attachments")).unwrap();
    let image = base64::engine::general_purpose::STANDARD.decode(
        "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAPklEQVR42mP4EOX2nxKsO+0DRZhh1AGjDhh1wKgDRh0w4A6w2dL0nxL8dZ8NRXjUAaMOGHXAqANGHTDgDgAAuIv4agXNJmAAAAAASUVORK5CYII="
    ).unwrap();
    assert_eq!(sha256_hex(&image), "a4307dbf28c24f349374a7d97bcb4e3856b1cf505f9d8f203c490b60200a976d");
    std::fs::write(root.join("attachments/note-flow.png"), &image).unwrap();
    let original = b"# Synthetic\n\nSynthetic note.\n\n![fixture](attachments/note-flow.png)\n\nSaved by the native note flow.\n";
    std::fs::write(root.join("Synthetic.md"), original).unwrap();
    let source_inode = std::fs::metadata(root.join("Synthetic.md")).unwrap().ino();
    let source = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Synthetic.md".into() };
    let before = service.read_document(&source).unwrap();
    let moved = service.move_document_from_ui(epoch, &KnowledgeMoveInput {
        document_ref: source, title: "Synthetic.md".into(), parent_relative_path: Some("Moved".into()),
        expected_revision: before.revision,
        expected_file_identity: None,
    }).unwrap();
    assert_eq!(moved.summary.document_ref.relative_path, "Moved/Synthetic.md");
    assert!(moved.content.contains("../attachments/note-flow.png"));
    assert!(moved.content.contains("Saved by the native note flow."));
    assert!(!root.join("Synthetic.md").exists());
    assert_eq!(std::fs::read(root.join("attachments/note-flow.png")).unwrap(), image);
    let resolved = service.resolve_vault_attachment(&moved.summary.document_ref, "../attachments/note-flow.png", false).unwrap();
    assert_eq!(resolved.status, "resolved");
    assert_eq!(resolved.relative_path.as_deref(), Some("attachments/note-flow.png"));
    let retained = std::fs::read_dir(&root).unwrap().map(|entry| entry.unwrap().path())
        .filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(".lrk-remove-") && name.ends_with(".backup")))
        .collect::<Vec<_>>();
    assert_eq!(retained.len(), 1);
    assert_eq!(std::fs::metadata(&retained[0]).unwrap().ino(), source_inode);
    assert_eq!(std::fs::read(&retained[0]).unwrap(), original);
}

#[test]
fn macos_note_move_rejects_stale_or_replaced_source_and_occupied_target() {
    for case in ["stale-revision", "source-symlink", "target-exists"] {
        let (_temp, service, root, registration, epoch) = fixture();
        std::fs::create_dir(root.join("Moved")).unwrap();
        let original = b"![fixture](attachments/note-flow.png)\n";
        let source_path = root.join("Synthetic.md");
        std::fs::write(&source_path, original).unwrap();
        let source = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "Synthetic.md".into() };
        let revision = service.read_document(&source).unwrap().revision;
        let outside = root.parent().unwrap().join("outside.md");
        match case {
            "stale-revision" => std::fs::write(&source_path, b"newer external input").unwrap(),
            "source-symlink" => {
                std::fs::write(&outside, original).unwrap();
                std::fs::remove_file(&source_path).unwrap();
                std::os::unix::fs::symlink(&outside, &source_path).unwrap();
            },
            "target-exists" => std::fs::write(root.join("Moved/Synthetic.md"), b"foreign destination").unwrap(),
            _ => unreachable!(),
        }
        let result = service.move_document_from_ui(epoch, &KnowledgeMoveInput {
            document_ref: source, title: "Synthetic.md".into(), parent_relative_path: Some("Moved".into()),
            expected_revision: revision,
            expected_file_identity: None,
        });
        assert!(result.is_err(), "{case} must not report a successful move");
        match case {
            "stale-revision" => assert_eq!(std::fs::read(&source_path).unwrap(), b"newer external input"),
            "source-symlink" => {
                assert!(std::fs::symlink_metadata(&source_path).unwrap().file_type().is_symlink());
                assert_eq!(std::fs::read(&outside).unwrap(), original);
            },
            "target-exists" => {
                assert_eq!(std::fs::read(&source_path).unwrap(), original);
                assert_eq!(std::fs::read(root.join("Moved/Synthetic.md")).unwrap(), b"foreign destination");
            },
            _ => unreachable!(),
        }
        if case != "target-exists" { assert!(!root.join("Moved/Synthetic.md").exists()); }
    }
}

#[test]
fn macos_recovery_never_adopts_a_same_bytes_replacement_of_a_created_note() {
    for durable_completion in [true, false] {
        let (_temp, service, root, registration, epoch) = fixture();
        let source = root.parent().unwrap().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("a.md"), b"synthetic a").unwrap();
        std::fs::write(source.join("b.md"), b"synthetic b").unwrap();
        let plan = service
            .preview_attachment_import(
                &registration.id,
                &source,
                &["a.md".into(), "b.md".into()],
                "",
            )
            .unwrap();
        if durable_completion {
            service
                .attachment_fault_after_steps
                .store(1, Ordering::Release);
        } else {
            service
                .attachment_fault_before_step_receipt
                .store(true, Ordering::Release);
        }
        let partial = service.execute_attachment_operation(epoch, &plan).unwrap();
        assert_eq!(partial.status, "partial");
        assert!(root.join("a.md").is_file());
        assert!(!root.join("b.md").exists());
        if !durable_completion {
            // Even the actual, unchanged publication cannot fill an unknown
            // receipt window by being observed again during recovery.
            assert!(service
                .recover_attachment_operation(epoch, &registration.id, &partial.operation_id, false)
                .is_err());
        }
        let (held, inode, bytes) = replace_same_bytes(&root.join("a.md"));
        for rollback in [false, true] {
            assert!(service
                .recover_attachment_operation(
                    epoch,
                    &registration.id,
                    &partial.operation_id,
                    rollback
                )
                .is_err());
            assert_eq!(std::fs::metadata(root.join("a.md")).unwrap().ino(), inode);
            assert_eq!(std::fs::read(root.join("a.md")).unwrap(), bytes);
            assert_eq!(std::fs::read(&held).unwrap(), bytes);
            assert!(!root.join("b.md").exists());
        }
    }
}
#[test]
fn macos_recovery_completion_and_rewrite_undo_require_the_published_note_inode() {
    for target in ["n.md", "new.png"] {
        let (_temp, service, root, registration, epoch) = fixture();
        std::fs::write(root.join("old.png"), b"synthetic image").unwrap();
        std::fs::write(root.join("n.md"), b"![[old.png]]").unwrap();
        let plan = service
            .preview_attachment_rename(&registration.id, "old.png", "new.png")
            .unwrap();
        assert_eq!(plan.files.len(), 3);
        service
            .attachment_fault_after_steps
            .store(2, Ordering::Release);
        let partial = service.execute_attachment_operation(epoch, &plan).unwrap();
        assert_eq!(partial.status, "partial");
        let (held, inode, bytes) = replace_same_bytes(&root.join(target));
        for rollback in [false, true] {
            assert!(service
                .recover_attachment_operation(
                    epoch,
                    &registration.id,
                    &partial.operation_id,
                    rollback
                )
                .is_err());
            assert_eq!(std::fs::metadata(root.join(target)).unwrap().ino(), inode);
            assert_eq!(std::fs::read(&held).unwrap(), bytes);
            assert_eq!(
                std::fs::read(root.join("old.png")).unwrap(),
                b"synthetic image"
            );
            assert_eq!(
                std::fs::read(root.join("new.png")).unwrap(),
                b"synthetic image"
            );
        }
    }
}
#[test]
fn macos_recovery_of_a_removed_path_requires_the_retained_original_object() {
    let (_temp, service, root, registration, epoch) = fixture();
    std::fs::write(root.join("old.md"), b"synthetic original").unwrap();
    service
        .move_document(&KnowledgeMoveInput {
            document_ref: KnowledgeDocumentRef {
                vault_id: registration.id.clone(),
                relative_path: "old.md".into(),
            },
            expected_revision: sha256_hex(b"synthetic original"),
            title: "moved".into(),
            parent_relative_path: None,
            expected_file_identity: None,
        })
        .unwrap();
    let id = service
        .list_attachment_operations(&registration.id)
        .unwrap()
        .pop()
        .unwrap();
    let backup = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(".lrk-remove-")
                && path.extension().is_some_and(|ext| ext == "backup")
        })
        .unwrap();
    let (held, inode, bytes) = replace_same_bytes(&backup);
    for rollback in [false, true] {
        assert!(service
            .recover_attachment_operation(epoch, &registration.id, &id, rollback)
            .is_err());
        assert!(!root.join("old.md").exists());
        assert!(root.join("moved.md").is_file());
        assert_eq!(std::fs::metadata(&backup).unwrap().ino(), inode);
        assert_eq!(std::fs::read(&held).unwrap(), bytes);
    }
}

#[test]
fn macos_recovery_resumes_and_rolls_back_only_the_durably_bound_objects() {
    let (_temp, service, root, registration, epoch) = fixture();
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("a.md"), b"synthetic a").unwrap();
    std::fs::write(source.join("b.md"), b"synthetic b").unwrap();
    let plan = service
        .preview_attachment_import(
            &registration.id,
            &source,
            &["a.md".into(), "b.md".into()],
            "",
        )
        .unwrap();
    service
        .attachment_fault_after_steps
        .store(1, Ordering::Release);
    let partial = service.execute_attachment_operation(epoch, &plan).unwrap();
    assert_eq!(partial.status, "partial");
    let first_inode = std::fs::metadata(root.join("a.md")).unwrap().ino();
    let complete = service
        .recover_attachment_operation(epoch, &registration.id, &partial.operation_id, false)
        .unwrap();
    assert_eq!(complete.status, "complete");
    assert_eq!(
        std::fs::metadata(root.join("a.md")).unwrap().ino(),
        first_inode
    );
    let second_inode = std::fs::metadata(root.join("b.md")).unwrap().ino();
    let undone = service
        .recover_attachment_operation(epoch, &registration.id, &partial.operation_id, true)
        .unwrap();
    assert_eq!(undone.status, "rolled-back");
    assert!(!root.join("a.md").exists());
    assert!(!root.join("b.md").exists());
    let retained = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "backup"))
        .map(|path| std::fs::metadata(path).unwrap().ino())
        .collect::<Vec<_>>();
    assert!(retained.contains(&first_inode));
    assert!(retained.contains(&second_inode));
    assert_eq!(
        service
            .recover_attachment_operation(epoch, &registration.id, &partial.operation_id, true)
            .unwrap()
            .status,
        "rolled-back"
    );
    assert!(service
        .recover_attachment_operation(epoch, &registration.id, &partial.operation_id, false)
        .is_err());
    assert_eq!(std::fs::read(source.join("a.md")).unwrap(), b"synthetic a");
    assert_eq!(std::fs::read(source.join("b.md")).unwrap(), b"synthetic b");
}

#[test]
fn macos_move_note_rejects_replaced_file_object_with_same_path_and_content() {
    let (_temp, service, root, registration, epoch) = fixture();
    let original = b"# Synthetic\n\nSame content.\n";
    let source_path = root.join("Synthetic.md");
    std::fs::write(&source_path, original).unwrap();
    let source_meta = std::fs::metadata(&source_path).unwrap();
    let source_identity = format!("{}:{}", source_meta.dev(), source_meta.ino());
    let source = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "Synthetic.md".into(),
    };
    let revision = service.read_document(&source).unwrap().revision;

    // Replace file object at same path with exact same bytes
    let (_held, new_ino, _bytes) = replace_same_bytes(&source_path);
    assert_ne!(source_meta.ino(), new_ino);

    // Create target directory first so move reaches identity verification
    std::fs::create_dir_all(root.join("Moved")).unwrap();

    // Attempt to move providing the expected_file_identity from the original read
    let result = service.move_document_from_ui(epoch, &KnowledgeMoveInput {
        document_ref: source,
        title: "Synthetic.md".into(),
        parent_relative_path: Some("Moved".into()),
        expected_revision: revision,
        expected_file_identity: Some(source_identity),
    });

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "knowledge-document-identity-mismatch");
    assert!(root.join("Synthetic.md").exists());
    assert!(!root.join("Moved/Synthetic.md").exists());
}

#[test]
fn macos_move_note_succeeds_after_normal_save_with_updated_file_identity() {
    let (_temp, service, root, registration, epoch) = fixture();
    let original = "# Synthetic\n\nInitial content.\n";
    let source_path = root.join("Synthetic.md");
    std::fs::write(&source_path, original.as_bytes()).unwrap();
    let source = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "Synthetic.md".into(),
    };
    let initial_doc = service.read_document(&source).unwrap();
    let _initial_identity = initial_doc.summary.file_identity.expect("must have file identity");

    // User edits and saves via replace_document_from_ui (which performs atomic replacement)
    let updated_content = "# Synthetic\n\nUpdated content after edit.\n";
    let saved_result = service.replace_document_from_ui(epoch, &KnowledgeWriteInput {
        document_ref: source.clone(),
        content: updated_content.into(),
        expected_revision: Some(initial_doc.revision),
    }).unwrap();

    let saved_identity = saved_result.document.summary.file_identity.expect("saved doc must have file identity");
    let saved_revision = saved_result.document.revision;

    // Create target directory "Moved"
    std::fs::create_dir_all(root.join("Moved")).unwrap();

    // Move note with the updated file identity from the save
    let move_result = service.move_document_from_ui(epoch, &KnowledgeMoveInput {
        document_ref: source,
        title: "Synthetic.md".into(),
        parent_relative_path: Some("Moved".into()),
        expected_revision: saved_revision,
        expected_file_identity: Some(saved_identity),
    }).unwrap();

    assert_eq!(move_result.summary.relative_path, "Moved/Synthetic.md");
    assert!(root.join("Moved/Synthetic.md").exists());
    assert!(!root.join("Synthetic.md").exists());
}
