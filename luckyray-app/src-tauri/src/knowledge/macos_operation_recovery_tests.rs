//! These call the production service, admission store and recovery path.
//! They require Darwin; Linux policy checks are not substitutes for them.
use super::*;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

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
