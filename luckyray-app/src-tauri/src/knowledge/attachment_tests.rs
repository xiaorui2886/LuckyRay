use super::attachments::{publish_bytes, resolve_attachment};
use super::markdown_links::LinkSyntax;
use super::*;

pub(super) fn fixture(label: &str) -> (KnowledgeService, PathBuf, KnowledgeVaultRegistration) {
    let base = PathBuf::from("C:/Cursor/_qa").join(format!(
        "vault-attachments-{label}-{:032x}",
        rand::random::<u128>()
    ));
    let root = base.join("vault");
    std::fs::create_dir_all(root.join(".luckyray")).unwrap();
    let registration = KnowledgeVaultRegistration {
        id: format!("vault-{label}"),
        name: label.into(),
        root_path: root.to_string_lossy().into_owned(),
        mode: "vault-bound".into(),
        created_at: "2026-09-07T00:00:00Z".into(),
        last_opened_at: "2026-09-07T00:00:00Z".into(),
        schema_version: VAULT_SCHEMA_VERSION,
        link_update_policy: Default::default(),
    };
    std::fs::write(
        root.join(".luckyray/vault.json"),
        serde_json::to_vec(&registration).unwrap(),
    )
    .unwrap();
    let service = KnowledgeService::initialize(&base.join("app")).unwrap();
    service.register_current_vault(&registration).unwrap();
    (service, root.canonicalize().unwrap(), registration)
}

#[test]
fn concurrent_attachment_readers_share_a_guarded_vault_root() {
    let (service, root, registration) = fixture("parallel-root-readers");
    std::fs::write(root.join("a.png"), b"image").unwrap();
    std::fs::write(root.join("n.md"), "![[a.png]]").unwrap();
    service.activate_ui_source(&registration.id).unwrap();
    let (_vault, guard, _identity) = service.capture_current_target().unwrap();
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        let deletion = OpenOptions::new().access_mode(0x8000_0000 | 0x0001_0000).share_mode(3)
            .custom_flags(0x0200_0000 | 0x0020_0000).open(&root).unwrap_err();
        assert_eq!(deletion.raw_os_error(), Some(32));
        eprintln!("root DELETE access remains fenced with Win32 error 32");
    }
    let result = service.resolve_vault_attachment(&KnowledgeDocumentRef { vault_id: registration.id, relative_path: "n.md".into() }, "a.png", true);
    assert!(result.is_ok(), "another production reader must coexist: {result:?}");
    guard.verify_current_path(&root).unwrap();
    assert!(std::fs::rename(&root, root.with_file_name("replaced-vault")).is_err(), "live guards must still fence root replacement");
}

#[cfg(windows)]
#[test]
fn importing_plain_note_does_not_scan_unrelated_linked_project() {
    use std::os::windows::process::CommandExt;
    let (service, root, registration) = fixture("import-unrelated-project");
    let source = root.parent().unwrap().join("source");
    let outside = root.parent().unwrap().join("unrelated");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(source.join("笔记.md"), "plain note").unwrap();
    let linked = source.join("linked-project");
    let output = std::process::Command::new("cmd.exe").args(["/c", "mklink", "/J"]).arg(&linked).arg(&outside).creation_flags(0x08000000).output().unwrap();
    assert!(output.status.success());
    let active = service.activate_ui_source(&registration.id).unwrap();
    let result = service.preview_attachment_import(&registration.id, &source, &["笔记.md".into()], "");
    assert!(result.is_ok(), "a selected plain note must not depend on unrelated linked directories: {result:?}");
    let outcome = service.execute_attachment_operation(active.source_epoch, &result.unwrap()).unwrap();
    assert_eq!(outcome.status, "complete");
    assert_eq!(std::fs::read_to_string(root.join("笔记.md")).unwrap(), "plain note");
    assert_eq!(std::fs::read_to_string(source.join("笔记.md")).unwrap(), "plain note");
}

#[cfg(windows)]
#[test]
fn importing_explicit_paths_ignores_unrelated_junction_but_basename_stays_unresolved() {
    use std::os::windows::process::CommandExt;
    let (service, root, registration) = fixture("import-explicit-source");
    let source = root.parent().unwrap().join("source");
    let outside = root.parent().unwrap().join("outside");
    std::fs::create_dir_all(source.join("notes")).unwrap();
    std::fs::create_dir_all(source.join("附件")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(source.join("附件/图 片.png"), b"selected attachment").unwrap();
    std::fs::write(outside.join("图 片.png"), b"must never be read").unwrap();
    let linked = source.join("node_modules");
    let output = std::process::Command::new("cmd.exe").args(["/c", "mklink", "/J"])
        .arg(&linked).arg(&outside).creation_flags(0x08000000).output().unwrap();
    assert!(output.status.success());
    let original = "![alt](../附件/图%20片.png#part)\n![[附件/图 片.png|300]]\n![[图 片.png]]\n![missing](../附件/missing.png)";
    std::fs::write(source.join("notes/n.md"), original).unwrap();
    std::fs::write(source.join("notes/other.md"), "[n](n.md)").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_import(&registration.id, &source,
        &["notes/n.md".into(), "notes/other.md".into()], "imported").unwrap();
    assert_eq!(plan.attachment_count, 1);
    assert_eq!(plan.document_count, 2);
    assert!(plan.issues.iter().any(|issue| issue.status == "source-inventory-incomplete"));
    assert!(plan.issues.iter().any(|issue| issue.status == "missing"));
    let outcome = service.execute_attachment_operation(active.source_epoch, &plan).unwrap();
    assert_eq!(outcome.status, "complete-with-unresolved");
    let text = std::fs::read_to_string(root.join("imported/notes/n.md")).unwrap();
    assert!(text.contains("![[图 片.png]]"));
    assert!(text.contains("#part"));
    assert!(!text.contains("../附件/图%20片.png"));
    assert_eq!(std::fs::read_to_string(source.join("notes/n.md")).unwrap(), original);
    assert_eq!(std::fs::read(outside.join("图 片.png")).unwrap(), b"must never be read");
    // Explicitly selecting a linked path is still rejected, never followed.
    std::fs::write(source.join("unsafe.md"), "![x](node_modules/图%20片.png)").unwrap();
    let failure = service.preview_attachment_import(&registration.id, &source, &["unsafe.md".into()], "").unwrap_err();
    assert_eq!(failure.code, "knowledge-path-reparse-forbidden");
}

#[cfg(windows)]
#[test]
fn importing_five_sibling_wiki_images_preserves_wiki_and_readable_names() {
    use std::os::windows::process::CommandExt;
    let (service, root, registration) = fixture("import-five-sibling-images");
    let source = root.parent().unwrap().join("source");
    let outside = root.parent().unwrap().join("unrelated");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let mut original = String::new();
    std::fs::create_dir_all(source.join("other")).unwrap();
    for index in 1..=5 {
        let name = format!("截图 {index}.png");
        std::fs::write(source.join(&name), format!("image {index}")).unwrap();
        std::fs::write(outside.join(&name), "unrelated same basename").unwrap();
        std::fs::write(source.join("other").join(&name), "non-sibling duplicate").unwrap();
        original.push_str(&format!("![[{name}#part|300]]\n"));
    }
    std::fs::write(source.join("笔记.md"), &original).unwrap();
    let output = std::process::Command::new("cmd.exe").args(["/c", "mklink", "/J"])
        .arg(source.join("node_modules")).arg(&outside).creation_flags(0x08000000).output().unwrap();
    assert!(output.status.success());
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_import(&registration.id, &source, &["笔记.md".into()], "nested").unwrap();
    assert_eq!(plan.attachment_count, 5);
    assert!(plan.issues.is_empty());
    assert_eq!(service.execute_attachment_operation(active.source_epoch, &plan).unwrap().status, "complete");
    let imported = std::fs::read_to_string(root.join("nested/笔记.md")).unwrap();
    for index in 1..=5 {
        let name = format!("截图 {index}.png");
        assert!(imported.contains(&format!("![[attachments/{name}#part|300]]")));
        assert_eq!(std::fs::read(root.join("attachments").join(&name)).unwrap(), format!("image {index}").as_bytes());
    }
    assert!(!imported.contains("%20"));
    assert_eq!(std::fs::read_to_string(source.join("笔记.md")).unwrap(), original);
}

#[test]
fn readable_attachment_names_handle_existing_and_planned_conflicts_and_reuse() {
    let (service, root, registration) = fixture("readable-copy-names");
    let source = root.parent().unwrap().join("source");
    for folder in ["a", "b", "c"] { std::fs::create_dir_all(source.join(folder)).unwrap(); }
    std::fs::create_dir_all(root.join("attachments")).unwrap();
    std::fs::write(root.join("attachments/photo.png"), b"existing").unwrap();
    std::fs::write(source.join("a/photo.png"), b"first").unwrap();
    std::fs::write(source.join("b/photo.png"), b"second").unwrap();
    std::fs::write(source.join("c/other.png"), b"first").unwrap();
    std::fs::write(source.join("n.md"), "![[a/photo.png|alias]]\n![alt](b/photo.png \"title\")\n![[c/other.png]]").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_import(&registration.id, &source, &["n.md".into()], "").unwrap();
    assert_eq!(plan.attachment_count, 3);
    assert_eq!(service.execute_attachment_operation(active.source_epoch, &plan).unwrap().status, "complete");
    assert_eq!(std::fs::read(root.join("attachments/photo.png")).unwrap(), b"existing");
    assert_eq!(std::fs::read(root.join("attachments/photo (2).png")).unwrap(), b"first");
    assert_eq!(std::fs::read(root.join("attachments/photo (3).png")).unwrap(), b"second");
    let imported = std::fs::read_to_string(root.join("n.md")).unwrap();
    assert!(imported.contains("![[attachments/photo (2).png|alias]]"));
    assert!(imported.contains("![[attachments/other.png]]"));
    assert_eq!(std::fs::read(root.join("attachments/other.png")).unwrap(), b"first");
    assert!(imported.contains("![alt](./attachments/photo%20%283%29.png \"title\")"));
    let inventory = index::attachment_inventory(&root).unwrap();
    let reused = publish_bytes(&root, &inventory, "n.md", "new-name.png", b"first").unwrap();
    assert!(reused.reused);
    assert_eq!(std::fs::read(root.join(&reused.relative_path)).unwrap(), b"first");
    let published = publish_bytes(&root, &inventory, "n.md", "photo.png", b"third").unwrap();
    assert_eq!(published.relative_path, "attachments/photo (4).png");
    let legacy = format!("attachments/{}.png", sha256_hex(b"legacy bytes"));
    std::fs::write(root.join(&legacy), b"legacy bytes").unwrap();
    let inventory = index::attachment_inventory(&root).unwrap();
    let reused = publish_bytes(&root, &inventory, "n.md", "readable.png", b"legacy bytes").unwrap();
    assert!(!reused.reused);
    assert_eq!(reused.relative_path, "attachments/readable.png");
    assert_eq!(std::fs::read(root.join(&legacy)).unwrap(), b"legacy bytes");
    let inventory = index::attachment_inventory(&root).unwrap();
    let reused = publish_bytes(&root, &inventory, "n.md", "another.png", b"legacy bytes").unwrap();
    assert!(reused.reused);
    assert_eq!(reused.relative_path, "attachments/readable.png");
    assert_eq!(super::attachments::attachment_copy_name("CON.png", 1), "attachment-CON.png");
    assert_eq!(super::attachments::attachment_copy_name(&format!("{}.png", sha256_hex(b"legacy")), 1), "attachment.png");
    assert_eq!(super::attachments::attachment_copy_name("../图#片[1].png", 1), "图_片_1_.png");
}

#[test]
fn link_policy_has_one_authority_and_preserves_target_and_source_identity() {
    let (service, root, registration) = fixture("link-policy");
    let active = service.activate_ui_source(&registration.id).unwrap();
    let (_, _, before_identity) = service.capture_current_target().unwrap();
    let cache_before = std::fs::read(service.current_vault_path()).unwrap();
    #[cfg(windows)]
    let _cache_read_lock = {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new().read(true).share_mode(1).open(service.current_vault_path()).unwrap()
    };
    assert_eq!(service.set_attachment_link_update_policy(&registration.id, active.source_epoch, LinkUpdatePolicy::Always).unwrap(), LinkUpdatePolicy::Always);
    assert_eq!(std::fs::read(service.current_vault_path()).unwrap(), cache_before);
    assert_eq!(service.attachment_link_update_policy(&registration.id).unwrap(), LinkUpdatePolicy::Always);
    let (_, _, after_identity) = service.capture_current_target().unwrap();
    assert_eq!(before_identity, after_identity);
    assert!(service.lock_active_ui_source(active.source_epoch, Some(&registration.id)).is_ok());
    // Native open with an older registration may update metadata but must preserve policy.
    let mut stale = registration.clone();
    stale.root_path = root.to_string_lossy().into_owned();
    service.write_vault_registration_metadata(&root.join(".luckyray/vault.json"), &stale).unwrap();
    assert_eq!(service.attachment_link_update_policy(&registration.id).unwrap(), LinkUpdatePolicy::Always);
    assert_eq!(service.set_attachment_link_update_policy(&registration.id, active.source_epoch, LinkUpdatePolicy::Ask).unwrap(), LinkUpdatePolicy::Ask);
    assert!(service.set_attachment_link_update_policy("other-vault", active.source_epoch, LinkUpdatePolicy::Always).is_err());
    assert!(service.set_attachment_link_update_policy(&registration.id, active.source_epoch + 1, LinkUpdatePolicy::Always).is_err());
    assert_eq!(service.attachment_link_update_policy(&registration.id).unwrap(), LinkUpdatePolicy::Ask);
}

#[test]
fn attachment_cancel_before_runner_is_not_lost() {
    let (service, root, registration) = fixture("cancel-before-runner");
    std::fs::write(root.join("old.pdf"), b"pdf").unwrap();
    std::fs::write(root.join("a.md"), "[A](./old.pdf)").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_rename(&registration.id, "old.pdf", "new.pdf").unwrap();
    let request_id = "00000000-0000-0000-0000-000000000001";
    let attempt = service.begin_attachment_attempt(&registration.id, request_id).unwrap();
    let lock = service.mutation_lock.lock().unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let worker_service = service.clone();
    let worker_barrier = barrier.clone();
    let worker = std::thread::spawn(move || {
        worker_barrier.wait();
        worker_service.execute_attachment_attempt(active.source_epoch, &plan, attempt).unwrap()
    });
    barrier.wait();
    service.cancel_attachment_operation(&registration.id, request_id).unwrap();
    drop(lock);
    let outcome = worker.join().unwrap();
    assert_eq!(outcome.status, "partial");
    assert_eq!(outcome.completed_files, 0);
    assert!(root.join(outcome.recovery_path).exists());
    assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "[A](./old.pdf)");
    assert!(!root.join("new.pdf").exists());
}

#[test]
fn attachment_attempt_cancel_is_scoped_and_resume_starts_clean() {
    let (service, root, registration) = fixture("attempt-scope");
    std::fs::write(root.join("old.pdf"), b"pdf").unwrap();
    std::fs::write(root.join("a.md"), "[A](./old.pdf)").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_rename(&registration.id, "old.pdf", "new.pdf").unwrap();
    let first = "00000000-0000-0000-0000-000000000003";
    let next = "00000000-0000-0000-0000-000000000004";
    let attempt = service.begin_attachment_attempt(&registration.id, first).unwrap();
    assert!(service.begin_attachment_attempt(&registration.id, first).is_err());
    assert!(service.begin_attachment_attempt(&registration.id, next).is_err());
    service.cancel_attachment_operation(&registration.id, first).unwrap();
    let partial = service.execute_attachment_attempt(active.source_epoch, &plan, attempt).unwrap();
    assert_eq!(partial.status, "partial");
    assert_eq!(partial.completed_files, 0);
    let recovery = service.begin_attachment_attempt(&registration.id, next).unwrap();
    // These are real cancellation entry calls after B is accepted, before its runner.
    service.cancel_attachment_operation(&registration.id, first).unwrap();
    service.cancel_attachment_operation("another-vault", next).unwrap();
    service.cancel_attachment_operation(&registration.id, "unknown").unwrap();
    let completed = service.recover_attachment_attempt(active.source_epoch, &registration.id, &partial.operation_id, false, recovery).unwrap();
    assert_eq!(completed.status, "complete");
    assert_eq!(completed.operation_id, partial.operation_id);
    assert!(!root.join("old.pdf").exists());
    let rollback = service.begin_attachment_attempt(&registration.id, "00000000-0000-0000-0000-000000000005").unwrap();
    service.cancel_attachment_operation(&registration.id, next).unwrap();
    assert_eq!(service.recover_attachment_attempt(active.source_epoch, &registration.id, &partial.operation_id, true, rollback).unwrap().status, "rolled-back");
    assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "[A](./old.pdf)");
}

#[test]
fn attachment_attempt_error_paths_release_admission_and_private_import_ignores_stop() {
    let (service, root, registration) = fixture("attempt-errors");
    std::fs::write(root.join("old.pdf"), b"pdf").unwrap();
    std::fs::write(root.join("a.md"), "[A](./old.pdf)").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_rename(&registration.id, "old.pdf", "new.pdf").unwrap();
    let attempt = service.begin_attachment_attempt(&registration.id, "00000000-0000-0000-0000-000000000006").unwrap();
    std::fs::write(root.join("a.md"), "changed externally").unwrap();
    assert!(service.execute_attachment_attempt(active.source_epoch, &plan, attempt).is_err());
    let attempt = service.begin_attachment_attempt(&registration.id, "00000000-0000-0000-0000-000000000007").unwrap();
    assert!(service.recover_attachment_attempt(active.source_epoch, &registration.id, "invalid-receipt", false, attempt).is_err());
    let private = service.begin_attachment_attempt(&registration.id, "00000000-0000-0000-0000-000000000008").unwrap();
    service.cancel_attachment_operation(&registration.id, "00000000-0000-0000-0000-000000000008").unwrap();
    std::fs::write(root.join("a.md"), "[A](./old.pdf)").unwrap();
    // This is the same private execution entry used by normal Markdown import.
    assert_eq!(service.execute_attachment_operation(active.source_epoch, &plan).unwrap().status, "complete");
    drop(private);
    assert!(service.begin_attachment_attempt(&registration.id, "00000000-0000-0000-0000-000000000009").is_ok());
}

#[test]
fn attachment_collection_does_not_report_note_links_as_missing_materials() {
    let (service, root, registration) = fixture("collection-note-links");
    let material = root.parent().unwrap().join("physical.png");
    std::fs::write(&material, b"image").unwrap();
    std::fs::write(root.join("a.md"), "[[Existing]] [[folder/Uncreated]] [[v1.2-roadmap]] ![[legacy.png]] ![[absent.png]]").unwrap();
    std::fs::write(root.join("Existing.md"), "existing note").unwrap();
    let reference = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "a.md".into() };
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_conversion(&[reference.clone()], &[("material-id".into(), "legacy.png".into(), Some(material))]).unwrap();
    assert_eq!(plan.issues.len(), 1);
    assert_eq!(plan.issues[0].target, "absent.png");
    let result = service.execute_attachment_operation(active.source_epoch, &plan).unwrap();
    assert_eq!(result.status, "complete-with-unresolved");
    let content = service.read_document(&reference).unwrap().content;
    assert!(content.contains("[[Existing]] [[folder/Uncreated]] [[v1.2-roadmap]]"));
    assert!(content.contains("![[absent.png]]"));
    assert!(content.contains("![[attachments/"));
}

#[test]
fn attachment_resolution_file_version_changes_when_file_changes() {
    let (service, root, registration) = fixture("resolution-version");
    std::fs::write(root.join("a.md"), "![image](./image.png)").unwrap();
    std::fs::write(root.join("image.png"), b"first image").unwrap();
    let reference = KnowledgeDocumentRef { vault_id: registration.id, relative_path: "a.md".into() };
    let first = service.resolve_vault_attachment(&reference, "./image.png", false).unwrap();
    let unchanged = service.resolve_vault_attachment(&reference, "./image.png", false).unwrap();
    assert_eq!(first.version, unchanged.version);
    std::fs::write(root.join("image.png"), b"replacement image bytes").unwrap();
    let changed = service.resolve_vault_attachment(&reference, "./image.png", false).unwrap();
    assert_ne!(first.version, changed.version);
    assert_eq!(first.relative_path, changed.relative_path);
}

#[test]
fn attachment_rename_rechecks_new_references_on_execute_and_resume() {
    for added_note in [false, true] {
        let (service, root, registration) = fixture("rename-late-reference");
        std::fs::write(root.join("old.pdf"), b"pdf").unwrap();
        std::fs::write(root.join("a.md"), "[A](./old.pdf)").unwrap();
        if !added_note { std::fs::write(root.join("b.md"), "unrelated").unwrap(); }
        let active = service.activate_ui_source(&registration.id).unwrap();
        let plan = service.preview_attachment_rename(&registration.id, "old.pdf", "new.pdf").unwrap();
        std::fs::write(root.join("b.md"), "[Late reference](./old.pdf)").unwrap();
        let result = service.execute_attachment_operation(active.source_epoch, &plan).unwrap();
        assert_eq!(result.status, "partial");
        assert!(result.issues.iter().any(|issue| issue.status.contains("knowledge-attachment-new-reference")));
        assert_eq!(std::fs::read(root.join("old.pdf")).unwrap(), b"pdf");
        assert!(std::fs::read_to_string(root.join("a.md")).unwrap().contains("./new.pdf"));
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "[Late reference](./old.pdf)");
        std::fs::write(root.join("b.md"), "[Updated](./new.pdf)").unwrap();
        std::fs::write(root.join("c.md"), "![[old.pdf]]").unwrap();
        let resumed = service.recover_attachment_operation(active.source_epoch, &registration.id, &result.operation_id, false).unwrap();
        assert_eq!(resumed.status, "partial");
        assert!(root.join("old.pdf").exists());
        std::fs::write(root.join("c.md"), "![[new.pdf]]").unwrap();
        let completed = service.recover_attachment_operation(active.source_epoch, &registration.id, &result.operation_id, false).unwrap();
        assert_eq!(completed.status, "complete");
        assert!(!root.join("old.pdf").exists());
    }
}

#[test]
fn attachment_import_preserves_markdown_labels_titles_and_escapes() {
    let (service, root, registration) = fixture("import-authored-markdown");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("contract.pdf"), b"contract").unwrap();
    std::fs::write(source.join("photo.png"), b"photo").unwrap();
    let original = "[Signed **contract**](<./contract.pdf#page=2> \"2026\")\n![A \\[caption\\] & view](./photo.png 'Photo title')\n`[unchanged](./contract.pdf)`\n";
    std::fs::write(source.join("n.md"), original).unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_import(&registration.id, &source, &["n.md".into()], "").unwrap();
    assert_eq!(service.execute_attachment_operation(active.source_epoch, &plan).unwrap().status, "complete");
    let expected = original.replace("./contract.pdf#page=2", "./attachments/contract.pdf#page=2")
        .replace("./photo.png", "./attachments/photo.png");
    assert_eq!(std::fs::read_to_string(root.join("n.md")).unwrap(), expected);
    assert_eq!(std::fs::read_to_string(source.join("n.md")).unwrap(), original);
}

#[test]
fn attachment_material_id_conversion_preserves_type_and_markdown_text() {
    let (service, root, registration) = fixture("conversion-material-types");
    let image = root.parent().unwrap().join("image.png");
    let pdf = root.parent().unwrap().join("document.pdf");
    std::fs::write(&image, b"image bytes").unwrap();
    std::fs::write(&pdf, b"pdf bytes").unwrap();
    std::fs::create_dir_all(root.join("attachments")).unwrap();
    let legacy = format!("attachments/{}.png", sha256_hex(b"image bytes"));
    std::fs::write(root.join(&legacy), b"image bytes").unwrap();
    let original = "![Original alt](image-id \"Image title\")\n[Signed contract](pdf-id#page=2 '2026')\n![[image-id|300]]";
    let document = service.create_document(&KnowledgeCreateInput { title: "n".into(), parent_relative_path: None, content: original.into() }).unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_conversion(&[document.summary.document_ref], &[
        ("image-id".into(), "display image".into(), Some(image.clone())),
        ("pdf-id".into(), "display contract".into(), Some(pdf.clone())),
    ]).unwrap();
    assert!(plan.files.iter().any(|file| file.relative_path.ends_with(".png")));
    assert!(plan.files.iter().any(|file| file.relative_path.ends_with(".pdf")));
    assert!(!plan.files.iter().any(|file| file.relative_path.ends_with(".bin")));
    assert_eq!(service.execute_attachment_operation(active.source_epoch, &plan).unwrap().status, "complete");
    let content = std::fs::read_to_string(root.join("n.md")).unwrap();
    assert!(content.contains("![Original alt](./attachments/image.png \"Image title\")"));
    assert!(content.contains("[Signed contract](./attachments/document.pdf#page=2 '2026')"));
    assert!(content.contains("![[attachments/image.png|300]]"));
    assert_eq!(std::fs::read(root.join(&legacy)).unwrap(), b"image bytes");
    assert_eq!(std::fs::read(image).unwrap(), b"image bytes");
    assert_eq!(std::fs::read(pdf).unwrap(), b"pdf bytes");
}

#[test]
fn attachment_bytes_dedupe_and_name_conflicts_preserve_originals() {
    let (_service, root, _) = fixture("dedupe");
    std::fs::create_dir(root.join("existing")).unwrap();
    std::fs::write(root.join("existing/图 片.png"), b"verified bytes").unwrap();
    let inventory = index::attachment_inventory(&root).unwrap();
    let reused = publish_bytes(
        &root,
        &inventory,
        "notes/n.md",
        "different.png",
        b"verified bytes",
    )
    .unwrap();
    assert!(reused.reused);
    assert_eq!(reused.relative_path, "existing/图 片.png");
    let different = publish_bytes(
        &root,
        &inventory,
        "notes/n.md",
        "图 片.png",
        b"different bytes",
    )
    .unwrap();
    assert!(!different.reused);
    assert_eq!(
        std::fs::read(root.join(&different.relative_path)).unwrap(),
        b"different bytes"
    );
    assert_eq!(
        std::fs::read(root.join("existing/图 片.png")).unwrap(),
        b"verified bytes"
    );
    let inventory = index::attachment_inventory(&root).unwrap();
    let resolved = resolve_attachment(
        &root,
        &inventory,
        "notes/n.md",
        &super::markdown_links::markdown_relative_target("notes/n.md", &different.relative_path),
        LinkSyntax::Markdown,
    )
    .unwrap();
    assert_eq!(resolved.status, "resolved");
}

#[test]
fn attachment_basename_ambiguity_does_not_poison_explicit_paths() {
    let (_service, root, _) = fixture("ambiguity");
    for folder in ["a", "b"] {
        std::fs::create_dir(root.join(folder)).unwrap();
        std::fs::write(root.join(folder).join("图片.png"), folder).unwrap();
    }
    let inventory = index::attachment_inventory(&root).unwrap();
    assert_eq!(
        resolve_attachment(&root, &inventory, "a/n.md", "图片.png", LinkSyntax::Wiki)
            .unwrap()
            .status,
        "ambiguous"
    );
    assert_eq!(
        resolve_attachment(&root, &inventory, "a/n.md", "b/图片.png", LinkSyntax::Wiki)
            .unwrap()
            .relative_path
            .as_deref(),
        Some("b/图片.png")
    );
    assert_eq!(
        resolve_attachment(
            &root,
            &inventory,
            "a/n.md",
            "图片.png",
            LinkSyntax::Markdown
        )
        .unwrap()
        .relative_path
        .as_deref(),
        Some("a/图片.png")
    );
}

#[test]
fn attachment_publication_rejects_stale_revision_and_inactive_source() {
    let (service, root, registration) = fixture("source");
    let document = service
        .create_document(&KnowledgeCreateInput {
            title: "n".into(),
            parent_relative_path: None,
            content: "original".into(),
        })
        .unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let result = service.publish_attachment_from_ui(
        active.source_epoch,
        &document.summary.document_ref,
        "stale",
        "a.png",
        b"image",
        None,
        false,
    );
    assert_eq!(result.unwrap_err().code, "knowledge-revision-conflict");
    assert!(!root.join("attachments").exists());
    let result = service
        .publish_attachment_from_ui(
            active.source_epoch,
            &document.summary.document_ref,
            &document.revision,
            "a.png",
            b"image",
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        std::fs::read(root.join(&result.relative_path)).unwrap(),
        b"image"
    );
    assert_eq!(std::fs::read(root.join("n.md")).unwrap(), b"original");
    service.deactivate_ui_source().unwrap();
    assert_eq!(
        service
            .publish_attachment_from_ui(
                active.source_epoch,
                &document.summary.document_ref,
                &document.revision,
                "b.png",
                b"new",
                None,
                false
            )
            .unwrap_err()
            .code,
        "knowledge-source-inactive"
    );
}

#[test]
fn attachment_source_inside_vault_is_referenced_in_place() {
    let (service, root, registration) = fixture("in-place");
    std::fs::write(root.join("original.pdf"), b"pdf fixture").unwrap();
    let document = service
        .create_document(&KnowledgeCreateInput {
            title: "n".into(),
            parent_relative_path: None,
            content: "note".into(),
        })
        .unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let result = service
        .publish_attachment_from_ui(
            active.source_epoch,
            &document.summary.document_ref,
            &document.revision,
            "original.pdf",
            &[],
            Some(&root.join("original.pdf")),
            false,
        )
        .unwrap();
    assert_eq!(result.relative_path, "original.pdf");
    assert!(result.reused);
    assert!(!result.markdown.starts_with('!'));
    assert!(!root.join("attachments").exists());
}

#[test]
fn attachment_conversion_preview_is_read_only_and_partial_resume_preserves_external_edits() {
    let (service, root, registration) = fixture("conversion-recovery");
    let material = root.parent().unwrap().join("original.png");
    std::fs::write(&material, b"fixture image").unwrap();
    let document = service
        .create_document(&KnowledgeCreateInput {
            title: "n".into(),
            parent_relative_path: None,
            content: "![[legacy.png|300]]\n`![[legacy.png]]`\n![[missing.png]]".into(),
        })
        .unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let mapping = vec![(
        "asset-1".into(),
        "legacy.png".into(),
        Some(material.clone()),
    )];
    let plan = service
        .preview_attachment_conversion(&[document.summary.document_ref.clone()], &mapping)
        .unwrap();
    assert_eq!(plan.attachment_count, 1);
    assert_eq!(plan.document_count, 1);
    assert_eq!(plan.issues.len(), 1);
    assert!(!root.join("attachments").exists());
    assert!(!root.join(".luckyray/attachment-operations").exists());
    service
        .attachment_fault_after_steps
        .store(1, Ordering::Release);
    let partial = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(partial.status, "partial");
    assert_eq!(partial.completed_files, 1);
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        document.content
    );
    std::fs::write(root.join("n.md"), "external edit").unwrap();
    let conflicted = service
        .recover_attachment_operation(
            active.source_epoch,
            &registration.id,
            &partial.operation_id,
            false,
        )
        .unwrap();
    assert_eq!(conflicted.status, "partial");
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        "external edit"
    );
    std::fs::write(root.join("n.md"), &document.content).unwrap();
    let resumed = service
        .recover_attachment_operation(
            active.source_epoch,
            &registration.id,
            &partial.operation_id,
            false,
        )
        .unwrap();
    assert_eq!(resumed.status, "complete-with-unresolved");
    let converted = std::fs::read_to_string(root.join("n.md")).unwrap();
    assert!(converted.starts_with("![[attachments/original.png|300]]"));
    assert!(converted.contains("`![[legacy.png]]`"));
    assert!(converted.contains("![[missing.png]]"));
    assert_eq!(std::fs::read(&material).unwrap(), b"fixture image");
    let rollback = service
        .recover_attachment_operation(
            active.source_epoch,
            &registration.id,
            &partial.operation_id,
            true,
        )
        .unwrap();
    assert_eq!(rollback.status, "rolled-back");
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        document.content
    );
}

#[test]
fn attachment_import_and_note_move_keep_portable_targets() {
    let (service, root, registration) = fixture("import-move");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir_all(source.join("notes")).unwrap();
    std::fs::create_dir_all(source.join("attachments")).unwrap();
    std::fs::write(source.join("attachments/图片.png"), b"portable image").unwrap();
    let original = "![图片](../attachments/图片.png)\n![[attachments/图片.png|300]]";
    std::fs::write(source.join("notes/n.md"), original).unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service
        .preview_attachment_import(
            &registration.id,
            &source,
            &["notes/n.md".into()],
            "imported",
        )
        .unwrap();
    assert_eq!(plan.attachment_count, 1);
    let imported = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(imported.status, "complete");
    let reference = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "imported/notes/n.md".into(),
    };
    let document = service.read_document(&reference).unwrap();
    let moved = service
        .move_document_from_ui(
            active.source_epoch,
            &KnowledgeMoveInput {
                document_ref: reference,
                title: "moved".into(),
                parent_relative_path: Some(String::new()),
                expected_revision: document.revision,
            },
        )
        .unwrap();
    let inventory = index::attachment_inventory(&root).unwrap();
    for link in super::markdown_links::attachment_links(&moved.content) {
        assert_eq!(
            resolve_attachment(
                &root,
                &inventory,
                "moved.md",
                &link.destination,
                link.syntax
            )
            .unwrap()
            .status,
            "resolved"
        );
    }
    assert_eq!(
        std::fs::read_to_string(source.join("notes/n.md")).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read(source.join("attachments/图片.png")).unwrap(),
        b"portable image"
    );
    assert!(!root.join("imported/notes/n.md").exists());
}

#[test]
fn attachment_rename_rewrites_all_references_and_delete_note_keeps_shared_bytes() {
    let (service, root, registration) = fixture("attachment-rename");
    std::fs::write(root.join("a.pdf"), b"shared pdf").unwrap();
    for name in ["one", "two"] {
        service
            .create_document(&KnowledgeCreateInput {
                title: name.into(),
                parent_relative_path: None,
                content: "![[a.pdf#page=2]]\n[download](./a.pdf)".into(),
            })
            .unwrap();
    }
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service
        .preview_attachment_rename(&registration.id, "a.pdf", "attachments/renamed.pdf")
        .unwrap();
    let result = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(result.status, "complete");
    assert!(!root.join("a.pdf").exists());
    for name in ["one", "two"] {
        assert!(std::fs::read_to_string(root.join(format!("{name}.md")))
            .unwrap()
            .contains("attachments/renamed.pdf#page=2"));
    }
    let document_ref = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "one.md".into(),
    };
    let snapshot = service.read_document(&document_ref).unwrap();
    service
        .delete_document_from_ui(
            active.source_epoch,
            &KnowledgeDeleteInput {
                document_ref,
                expected_revision: snapshot.revision,
            },
        )
        .unwrap();
    assert_eq!(
        std::fs::read(root.join("attachments/renamed.pdf")).unwrap(),
        b"shared pdf"
    );
}

#[test]
fn attachment_copy_write_failure_leaves_note_unchanged_and_operation_recoverable() {
    let (service, root, registration) = fixture("write-failure");
    let material = root.parent().unwrap().join("image.png");
    std::fs::write(&material, b"image").unwrap();
    let document = service
        .create_document(&KnowledgeCreateInput {
            title: "n".into(),
            parent_relative_path: None,
            content: "![[old.png]]".into(),
        })
        .unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service
        .preview_attachment_conversion(
            &[document.summary.document_ref.clone()],
            &[("id".into(), "old.png".into(), Some(material))],
        )
        .unwrap();
    service.fail_next_write_before_commit();
    let result = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(result.completed_files, 0);
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        document.content
    );
    let ids = service
        .list_attachment_operations(&registration.id)
        .unwrap();
    assert!(ids.contains(&result.operation_id));
    let restarted = KnowledgeService::initialize(&service.app_data_dir).unwrap();
    let active = restarted.activate_ui_source(&registration.id).unwrap();
    assert_eq!(
        restarted
            .recover_attachment_operation(
                active.source_epoch,
                &registration.id,
                &result.operation_id,
                false
            )
            .unwrap()
            .status,
        "complete"
    );
}

#[test]
fn attachment_multi_document_partial_rollback_refuses_external_edits() {
    let (service, root, registration) = fixture("multi-document-recovery");
    let source = root.parent().unwrap().join("image.png");
    std::fs::write(&source, b"same").unwrap();
    let mut references = Vec::new();
    for title in ["one", "two"] {
        references.push(
            service
                .create_document(&KnowledgeCreateInput {
                    title: title.into(),
                    parent_relative_path: None,
                    content: "![[old.png]]".into(),
                })
                .unwrap()
                .summary
                .document_ref,
        );
    }
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service
        .preview_attachment_conversion(
            &references,
            &[("id".into(), "old.png".into(), Some(source))],
        )
        .unwrap();
    service
        .attachment_fault_after_steps
        .store(2, Ordering::Release);
    let result = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(result.completed_files, 2);
    assert!(std::fs::read_to_string(root.join("one.md"))
        .unwrap()
        .starts_with("![[attachments/"));
    assert_eq!(
        std::fs::read_to_string(root.join("two.md")).unwrap(),
        "![[old.png]]"
    );
    std::fs::write(root.join("one.md"), "external edit").unwrap();
    let rollback = service
        .recover_attachment_operation(
            active.source_epoch,
            &registration.id,
            &result.operation_id,
            true,
        )
        .unwrap();
    assert_eq!(rollback.status, "partial");
    assert_eq!(
        std::fs::read_to_string(root.join("one.md")).unwrap(),
        "external edit"
    );
    assert!(root.join(&plan.files[0].relative_path).is_file());
}

#[test]
fn attachment_ambiguous_missing_reference_style_and_stale_plan_are_explicit() {
    let (service, root, registration) = fixture("preview-problems");
    let document = service
        .create_document(&KnowledgeCreateInput {
            title: "n".into(),
            parent_relative_path: None,
            content: "![[duplicate.png]]\n![ref][shared]\n\n[shared]: missing.png".into(),
        })
        .unwrap();
    let mappings = vec![
        ("one".into(), "duplicate.png".into(), None),
        ("two".into(), "duplicate.png".into(), None),
    ];
    let plan = service
        .preview_attachment_conversion(&[document.summary.document_ref.clone()], &mappings)
        .unwrap();
    assert!(plan.issues.iter().any(|issue| issue.status == "ambiguous"));
    assert!(plan
        .issues
        .iter()
        .any(|issue| issue.status == "unsupported-reference-style-rewrite"));
    assert!(plan.files.is_empty());
    let active = service.activate_ui_source(&registration.id).unwrap();
    let mut changed = plan.clone();
    changed.target_identity = "different-root".into();
    assert!(service
        .execute_attachment_operation(active.source_epoch, &changed)
        .is_err());
    assert!(!root.join(".luckyray/attachment-operations").exists());
}

#[cfg(windows)]
#[test]
fn attachment_junction_is_rejected_without_reading_or_mutating_outside_bytes() {
    use std::os::windows::process::CommandExt;
    let (service, root, registration) = fixture("junction");
    let outside = root.parent().unwrap().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("sentinel.png"), b"outside sentinel").unwrap();
    let link = root.join("linked");
    let output = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        index::attachment_inventory(&root).unwrap_err().code,
        "knowledge-path-reparse-forbidden"
    );
    let reference = KnowledgeDocumentRef {
        vault_id: registration.id,
        relative_path: "n.md".into(),
    };
    assert!(service
        .resolve_vault_attachment(&reference, "linked/sentinel.png", true)
        .is_err());
    assert_eq!(
        std::fs::read(outside.join("sentinel.png")).unwrap(),
        b"outside sentinel"
    );
}

#[test]
fn attachment_cancellation_between_documents_is_recoverable() {
    let (service, root, registration) = fixture("cancel");
    let source = root.parent().unwrap().join("image.png");
    std::fs::write(&source, b"image").unwrap();
    let mut references = Vec::new();
    for title in ["one", "two"] {
        references.push(
            service
                .create_document(&KnowledgeCreateInput {
                    title: title.into(),
                    parent_relative_path: None,
                    content: "![[old.png]]".into(),
                })
                .unwrap()
                .summary
                .document_ref,
        );
    }
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service
        .preview_attachment_conversion(
            &references,
            &[("id".into(), "old.png".into(), Some(source))],
        )
        .unwrap();
    let request_id = "00000000-0000-0000-0000-000000000002";
    let attempt = service.begin_attachment_attempt(&registration.id, request_id).unwrap();
    let cancel_service = service.clone();
    let cancel_vault = registration.id.clone();
    service.set_after_final_validation_hook(move || {
        cancel_service.cancel_attachment_operation(&cancel_vault, request_id).unwrap();
    });
    let partial = service
        .execute_attachment_attempt(active.source_epoch, &plan, attempt)
        .unwrap();
    assert_eq!(partial.status, "partial");
    assert_eq!(partial.completed_files, 2);
    assert!(partial
        .issues
        .iter()
        .any(|issue| issue.status == "cancelled-between-files"));
    assert_eq!(
        std::fs::read_to_string(root.join("two.md")).unwrap(),
        "![[old.png]]"
    );
    assert_eq!(
        service
            .recover_attachment_operation(
                active.source_epoch,
                &registration.id,
                &partial.operation_id,
                false
            )
            .unwrap()
            .status,
        "complete"
    );
}

#[test]
fn attachment_long_unicode_paths_and_size_limit_are_deterministic() {
    let (service, root, registration) = fixture("long-path");
    let folder = format!(
        "{}/{}/{}",
        "长路径".repeat(18),
        "深目录".repeat(18),
        "附件".repeat(20)
    );
    std::fs::create_dir_all(root.join(&folder)).unwrap();
    let relative = format!("{folder}/Ä 图.png");
    std::fs::write(root.join(&relative), b"long path fixture").unwrap();
    let reference = KnowledgeDocumentRef {
        vault_id: registration.id,
        relative_path: "n.md".into(),
    };
    let result = service
        .resolve_vault_attachment(&reference, &format!("{folder}/ä 图.png"), true)
        .unwrap();
    assert_eq!(result.relative_path.as_deref(), Some(relative.as_str()));
    let oversized = root.parent().unwrap().join("oversized.bin");
    std::fs::File::create(&oversized)
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        super::attachments::read_attachment_bytes(&oversized)
            .unwrap_err()
            .code,
        "knowledge-attachment-size-limit"
    );
}

#[test]
fn attachment_copy_does_not_adopt_unrelated_equal_bytes_after_preview() {
    let (service, root, registration) = fixture("dependency-conflict");
    let source = root.parent().unwrap().join("material.png");
    std::fs::write(&source, b"verified").unwrap();
    std::fs::write(root.join("existing.png"), b"verified").unwrap();
    let document = service
        .create_document(&KnowledgeCreateInput {
            title: "n".into(),
            parent_relative_path: None,
            content: "![[legacy-id]]".into(),
        })
        .unwrap();
    let plan = service
        .preview_attachment_conversion(
            &[document.summary.document_ref.clone()],
            &[("legacy-id".into(), "original.png".into(), Some(source))],
        )
        .unwrap();
    assert_eq!(plan.attachment_count, 1);
    assert_eq!(plan.attachment_dependencies.len(), 1);
    std::fs::write(root.join("existing.png"), b"external replacement").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let result = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(result.status, "complete");
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        "![[attachments/material.png]]"
    );
    assert_eq!(std::fs::read(root.join("attachments/material.png")).unwrap(), b"verified");
    assert_eq!(
        std::fs::read(root.join("existing.png")).unwrap(),
        b"external replacement"
    );
}
#[test]
fn external_reference_update_uses_held_identity_and_only_rewrites_notes() {
    let (service, root, registration) = fixture("external-reference");
    std::fs::create_dir_all(root.join("attachments")).unwrap();
    std::fs::write(root.join("attachments/原 图.png"), b"image bytes").unwrap();
    std::fs::write(root.join("one.md"), "![[原 图.png|300]]\n![alt](attachments/%E5%8E%9F%20%E5%9B%BE.png#part)\n").unwrap();
    std::fs::write(root.join("two.md"), "![[attachments/原 图.png]]").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    // Keep an independent reader alive through witness capture, real rename,
    // preview, note writes, readback and rollback on the actual Windows FS.
    let (_, concurrent_root_guard, _) = service.capture_current_target().unwrap();
    service.resolve_vault_attachment(&KnowledgeDocumentRef{vault_id:registration.id.clone(),relative_path:"one.md".into()}, "原 图.png", true).unwrap();
    std::fs::rename(root.join("attachments/原 图.png"), root.join("attachments/new.png")).unwrap();
    let update=service.preview_external_attachment_changes(&registration.id, &["attachments/原 图.png".into(),"attachments/new.png".into()], false).unwrap();
    let plan=update.plan.expect("held object identifies external rename");
    assert_eq!(update.reference_count,3);assert_eq!(plan.document_count,2);
    assert_eq!(plan.kind,"external-reference-update");
    assert!(plan.files.iter().all(|file| file.relative_path.ends_with(".md") && file.before.is_some() && file.after.is_some()));
    assert_eq!(plan.attachment_count,0);assert_eq!(plan.copy_bytes,0);
    let result=service.execute_attachment_operation(active.source_epoch,&plan).unwrap();
    assert_eq!(result.status,"complete");
    let self_write=service.preview_external_attachment_changes(&registration.id,&["one.md".into(),"two.md".into()],false).unwrap();
    assert!(self_write.plan.is_none());assert_eq!(self_write.uncertain_count,0);
    let text=std::fs::read_to_string(root.join("one.md")).unwrap();
    assert!(text.contains("![[attachments/new.png|300]]"));assert!(text.contains("attachments/new.png#part"));
    assert_eq!(std::fs::read(root.join("attachments/new.png")).unwrap(),b"image bytes");
    assert!(!root.join("attachments/原 图.png").exists());
    service.recover_attachment_operation(active.source_epoch,&registration.id,&result.operation_id,true).unwrap();
    assert!(std::fs::read_to_string(root.join("one.md")).unwrap().contains("原 图.png"));
    assert!(root.join("attachments/new.png").exists());assert!(!root.join("attachments/原 图.png").exists());
    let mut forged=plan.clone();forged.files[0].relative_path="attachments/new.png".into();
    assert!(service.execute_attachment_operation(active.source_epoch,&forged).is_err());
    concurrent_root_guard.verify_current_path(&root).unwrap();
}

#[test]
fn importing_basename_uniqueness_and_conflicted_partial_notes_remain_safe() {
    let (service, root, registration) = fixture("import-basename-partial");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir_all(source.join("media")).unwrap();
    std::fs::write(source.join("media/a.png"), b"one attachment").unwrap();
    std::fs::write(source.join("n.md"), "![[a.png]]").unwrap();
    std::fs::write(source.join("other.md"), "[n](n.md)").unwrap();
    std::fs::write(root.join("n.md"), "existing destination").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_import(&registration.id, &source,
        &["n.md".into(), "other.md".into()], "").unwrap();
    assert_eq!(plan.attachment_count, 1);
    assert!(plan.issues.is_empty());
    assert!(plan.files.iter().any(|file| file.relative_path == "n (1).md"));
    service.attachment_fault_after_steps.store(1, Ordering::Release);
    let partial = service.execute_attachment_operation(active.source_epoch, &plan).unwrap();
    assert_eq!(partial.status, "partial");
    let resumed = service.recover_attachment_operation(active.source_epoch, &registration.id, &partial.operation_id, false).unwrap();
    assert_eq!(resumed.status, "complete");
    assert_eq!(std::fs::read_to_string(root.join("n.md")).unwrap(), "existing destination");
    assert!(std::fs::read_to_string(root.join("other.md")).unwrap().contains("n%20%281%29.md")
        || std::fs::read_to_string(root.join("other.md")).unwrap().contains("n%20(1).md"));
    assert_eq!(std::fs::read_to_string(source.join("n.md")).unwrap(), "![[a.png]]");
    std::fs::create_dir_all(source.join("duplicate")).unwrap();
    std::fs::write(source.join("duplicate/a.png"), b"second attachment").unwrap();
    let ambiguous = service.preview_attachment_import(&registration.id, &source, &["n.md".into()], "").unwrap();
    assert_eq!(ambiguous.attachment_count, 0);
    assert!(ambiguous.issues.iter().any(|issue| issue.status == "ambiguous"));
}

#[test]
fn external_copy_delete_content_update_and_recreated_old_path_do_not_authorize_rename() {
    for scenario in ["copy-delete","same-path","old-recreated","overflow"] {
        let (service, root, registration)=fixture(scenario);
        std::fs::write(root.join("a.png"),b"same bytes").unwrap();std::fs::write(root.join("n.md"),"![[a.png]]").unwrap();
        service.activate_ui_source(&registration.id).unwrap();
        service.resolve_vault_attachment(&KnowledgeDocumentRef{vault_id:registration.id.clone(),relative_path:"n.md".into()},"a.png",true).unwrap();
        match scenario {
            "copy-delete"=>{std::fs::copy(root.join("a.png"),root.join("b.png")).unwrap();std::fs::remove_file(root.join("a.png")).unwrap();},
            "same-path"=>{std::fs::write(root.join("a.png"),b"changed").unwrap();},
            _=>{std::fs::rename(root.join("a.png"),root.join("b.png")).unwrap();if scenario=="old-recreated"{std::fs::write(root.join("a.png"),b"new file").unwrap();}}
        }
        let update=service.preview_external_attachment_changes(&registration.id,&["a.png".into(),"b.png".into()],scenario=="overflow").unwrap();
        assert!(update.plan.is_none(),"{scenario}");assert_eq!(std::fs::read_to_string(root.join("n.md")).unwrap(),"![[a.png]]");
    }
}

#[test]
fn new_publications_and_imports_do_not_reuse_legacy_hash_names() {
    let (service, root, registration) = fixture("readable-not-legacy");
    let document = service.create_document(&KnowledgeCreateInput {
        title: "n".into(), parent_relative_path: None, content: "original".into(),
    }).unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    std::fs::create_dir_all(root.join("attachments")).unwrap();
    let legacy = root.join(format!("attachments/{}.png", sha256_hex(b"picture")));
    std::fs::write(&legacy, b"picture").unwrap();
    let publication = service.publish_attachment_from_ui(active.source_epoch,
        &document.summary.document_ref, &document.revision, "nice.png", &[], Some(&legacy), false).unwrap();
    assert!(!publication.reused);
    assert_eq!(publication.relative_path, "attachments/nice.png");
    let pasted = service.publish_attachment_from_ui(active.source_epoch,
        &document.summary.document_ref, &document.revision, "clipboard.png", b"picture", None, false).unwrap();
    assert!(pasted.reused);
    assert_eq!(pasted.relative_path, publication.relative_path);
    assert_eq!(std::fs::read(&legacy).unwrap(), b"picture");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("other.png"), b"import-only").unwrap();
    std::fs::write(source.join("note.md"), "![[other.png|400]]").unwrap();
    let old_import = root.join(format!("attachments/{}.png", sha256_hex(b"import-only")));
    std::fs::write(&old_import, b"import-only").unwrap();
    let plan = service.preview_attachment_import(&registration.id, &source, &["note.md".into()], "").unwrap();
    assert_eq!(plan.attachment_count, 1);
    assert_eq!(service.execute_attachment_operation(active.source_epoch, &plan).unwrap().status, "complete");
    assert_eq!(std::fs::read_to_string(root.join("note.md")).unwrap(), "![[attachments/other.png|400]]");
    assert_eq!(std::fs::read(old_import).unwrap(), b"import-only");
}

#[test]
fn conversion_three_images_preserves_existing_reference_and_old_files() {
    let (service, root, registration) = fixture("conversion-three-images");
    std::fs::create_dir_all(root.join("attachments")).unwrap();
    let source = root.parent().unwrap().join("catalog-source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("portrait.png"), b"portrait bytes").unwrap();
    std::fs::write(source.join("three-view.png"), b"three view bytes").unwrap();
    let legacy = format!("attachments/{}.png", sha256_hex(b"portrait bytes"));
    std::fs::write(root.join(&legacy), b"portrait bytes").unwrap();
    std::fs::write(root.join("attachments/image.png"), b"existing third").unwrap();
    let untouched = format!("![[{legacy}]]");
    std::fs::write(root.join("other.md"), &untouched).unwrap();
    let original = "![[portrait.png]]\n![[three-view.png]]\n![image.png](./attachments/image.png)";
    let document = service.create_document(&KnowledgeCreateInput {
        title: "链接".into(), parent_relative_path: None, content: original.into(),
    }).unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service.preview_attachment_conversion(&[document.summary.document_ref.clone()], &[
        ("portrait-id".into(), "portrait.png".into(), Some(source.join("portrait.png"))),
        ("three-id".into(), "three-view.png".into(), Some(source.join("three-view.png"))),
    ]).unwrap();
    assert!(plan.issues.is_empty());
    assert_eq!(plan.document_count, 1);
    assert_eq!(plan.attachment_count, 2);
    assert_eq!(plan.files.len(), 3);
    assert_eq!(std::fs::read_to_string(root.join("链接.md")).unwrap(), original);
    assert_eq!(service.execute_attachment_operation(active.source_epoch, &plan).unwrap().status, "complete");
    assert_eq!(std::fs::read_to_string(root.join("链接.md")).unwrap(),
        "![[attachments/portrait.png]]\n![[attachments/three-view.png]]\n![image.png](./attachments/image.png)");
    let inventory = index::attachment_inventory(&root).unwrap();
    for (target, syntax, expected) in [
        ("attachments/portrait.png", LinkSyntax::Wiki, b"portrait bytes".as_slice()),
        ("attachments/three-view.png", LinkSyntax::Wiki, b"three view bytes".as_slice()),
        ("./attachments/image.png", LinkSyntax::Markdown, b"existing third".as_slice()),
    ] {
        let resolution = resolve_attachment(&root, &inventory, "链接.md", target, syntax).unwrap();
        assert_eq!(resolution.status, "resolved");
        assert_eq!(std::fs::read(root.join(resolution.relative_path.unwrap())).unwrap(), expected);
    }
    assert_eq!(std::fs::read(root.join(legacy)).unwrap(), b"portrait bytes");
    assert_eq!(std::fs::read_to_string(root.join("other.md")).unwrap(), untouched);
    assert_eq!(std::fs::read(source.join("portrait.png")).unwrap(), b"portrait bytes");
    assert_eq!(std::fs::read(source.join("three-view.png")).unwrap(), b"three view bytes");
}
