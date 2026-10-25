use super::attachment_tests::fixture;
use super::attachments::resolve_attachment;
use super::external_attachments::portable_attachment_target;
use super::markdown_links::attachment_links;
use super::*;

#[test]
fn portability_audit_is_read_only_and_does_not_guess_ambiguous_materials() {
    let (service, root, _registration) = fixture("portability-audit");
    std::fs::create_dir(root.join("one")).unwrap();
    std::fs::create_dir(root.join("two")).unwrap();
    std::fs::write(root.join("one/dup.png"), b"one").unwrap();
    std::fs::write(root.join("two/dup.png"), b"two").unwrap();
    std::fs::write(root.join("ok.png"), b"okay").unwrap();
    let outside = root.parent().unwrap().join("legacy.png");
    std::fs::write(&outside, b"legacy").unwrap();
    let original = "![[ok.png]]\n![[dup.png]]\n![[gone.png]]\n![[legacy.png]]\n![[uncertain.png]]";
    std::fs::write(root.join("n.md"), original).unwrap();
    let before = index::attachment_inventory(&root).unwrap();
    let materials = vec![
        ("a".into(), "legacy.png".into(), Some(outside.clone())),
        ("b".into(), "uncertain.png".into(), Some(outside.clone())),
        ("c".into(), "uncertain.png".into(), Some(outside)),
    ];
    let audit = service
        .audit_attachment_portability(&[], &[], &materials)
        .unwrap();
    assert_eq!(audit.document_count, 1);
    assert_eq!(
        audit
            .entries
            .iter()
            .filter(|entry| entry.status == "ambiguous")
            .count(),
        2
    );
    assert_eq!(
        audit
            .entries
            .iter()
            .filter(|entry| entry.status == "missing")
            .count(),
        1
    );
    assert_eq!(audit.migration_file_count, 1);
    assert_eq!(audit.migration_copy_bytes, 6);
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        original
    );
    assert_eq!(index::attachment_inventory(&root).unwrap(), before);
    assert!(!root.join(".luckyray/attachment-operations").exists());
}

#[test]
fn portability_export_rewrites_real_paths_preserves_syntax_and_source_bytes() {
    let (service, root, registration) = fixture("portability-export");
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::create_dir_all(root.join("images")).unwrap();
    std::fs::write(root.join("images/图 # %.png"), b"inside").unwrap();
    let outside = root.parent().unwrap().join("外部 图片.png");
    std::fs::write(&outside, b"outside").unwrap();
    let target = portable_attachment_target(&root, "notes/n.md", &outside).unwrap();
    let original = format!(
        "![[images/图 # %.png|300]]\n![alt]({target}#page=2 \"title\")\n[other](../other.md)"
    );
    // Literal # has fragment semantics in Wiki syntax, so use an ordinary readable
    // name here; encoded # and % are covered by the external Markdown round-trip.
    std::fs::rename(
        root.join("images/图 # %.png"),
        root.join("images/图 片.png"),
    )
    .unwrap();
    let original = original.replace("图 # %.png", "图 片.png");
    std::fs::write(root.join("notes/n.md"), &original).unwrap();
    std::fs::write(root.join("other.md"), "untouched").unwrap();
    let approved = vec![(
        "notes/n.md".into(),
        vec![outside.to_string_lossy().into_owned()],
    )];
    let output = root.parent().unwrap().join("export");
    let exported = service
        .export_independent_vault(
            service
                .activate_ui_source(&registration.id)
                .unwrap()
                .source_epoch,
            &output,
            &approved,
        )
        .unwrap();
    assert_eq!(exported.status, "complete", "{exported:?}");
    assert_eq!(exported.document_count, 2);
    assert_eq!(exported.attachment_count, 2);
    let saved = std::fs::read_to_string(output.join("notes/n.md")).unwrap();
    assert!(saved.contains("![[attachments/图 片.png|300]]"));
    assert!(saved.contains("#page=2 \"title\""));
    assert!(saved.contains("[other](../other.md)"));
    let inventory = index::attachment_inventory(&output).unwrap();
    let mut observed = Vec::new();
    for link in attachment_links(&saved)
        .into_iter()
        .filter(|link| link.embedded)
    {
        let result = resolve_attachment(
            &output,
            &inventory,
            "notes/n.md",
            &link.destination,
            link.syntax,
        )
        .unwrap();
        assert_eq!(result.status, "resolved");
        observed.push(std::fs::read(result.absolute_path.unwrap()).unwrap());
    }
    assert!(observed.contains(&b"inside".to_vec()) && observed.contains(&b"outside".to_vec()));
    assert_eq!(
        std::fs::read_to_string(root.join("notes/n.md")).unwrap(),
        original
    );
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
}

#[test]
fn portability_export_reuses_physical_path_but_not_equal_content_at_other_paths() {
    let (service, root, registration) = fixture("portability-identities");
    std::fs::create_dir(root.join("a")).unwrap();
    std::fs::create_dir(root.join("b")).unwrap();
    std::fs::write(root.join("a/image.png"), b"identical").unwrap();
    std::fs::write(root.join("b/image.png"), b"identical").unwrap();
    std::fs::write(
        root.join("n.md"),
        "![[a/image.png]]\n![[b/image.png]]\n![[a/image.png]]",
    )
    .unwrap();
    let output = root.parent().unwrap().join("export");
    let result = service
        .export_independent_vault(
            service
                .activate_ui_source(&registration.id)
                .unwrap()
                .source_epoch,
            &output,
            &[],
        )
        .unwrap();
    assert_eq!(result.status, "complete");
    assert_eq!(result.attachment_count, 2);
    let saved = std::fs::read_to_string(output.join("n.md")).unwrap();
    let links = attachment_links(&saved);
    assert_eq!(links[0].destination, links[2].destination);
    assert_ne!(links[0].destination, links[1].destination);
}

#[test]
fn portability_export_reports_missing_unapproved_and_reference_style_without_repair() {
    let (service, root, registration) = fixture("portability-partial");
    std::fs::write(root.join("ok.png"), b"okay").unwrap();
    let outside = root.parent().unwrap().join("private.png");
    std::fs::write(&outside, b"do not copy").unwrap();
    let target = portable_attachment_target(&root, "n.md", &outside).unwrap();
    let original = format!("![[missing.png]]\n![outside]({target})\n![ref][id]\n\n[id]: ./ok.png\n![remote](https://example.test/r.png)");
    std::fs::write(root.join("n.md"), &original).unwrap();
    let output = root.parent().unwrap().join("export");
    let result = service
        .export_independent_vault(
            service
                .activate_ui_source(&registration.id)
                .unwrap()
                .source_epoch,
            &output,
            &[],
        )
        .unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(result.attachment_count, 0);
    for status in [
        "missing",
        "external-attachment-not-approved",
        "unsupported-reference-style-rewrite",
    ] {
        assert!(
            result.issues.iter().any(|issue| issue.status == status),
            "{result:?}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(output.join("n.md")).unwrap(),
        original
    );
}

#[test]
fn portability_export_rejects_existing_output_and_source_overlap_without_overwrite() {
    let (service, root, registration) = fixture("portability-destination");
    std::fs::write(root.join("n.md"), "source").unwrap();
    let output = root.parent().unwrap().join("export");
    std::fs::create_dir(&output).unwrap();
    std::fs::write(output.join("keep.txt"), b"keep").unwrap();
    assert_eq!(
        service
            .export_independent_vault(
                service
                    .activate_ui_source(&registration.id)
                    .unwrap()
                    .source_epoch,
                &output,
                &[]
            )
            .unwrap_err()
            .code,
        "knowledge-export-destination-not-empty"
    );
    assert_eq!(std::fs::read(output.join("keep.txt")).unwrap(), b"keep");
    assert_eq!(
        service
            .export_independent_vault(
                service
                    .activate_ui_source(&registration.id)
                    .unwrap()
                    .source_epoch,
                &root.join("export"),
                &[]
            )
            .unwrap_err()
            .code,
        "knowledge-export-source-overlap"
    );
    assert!(!root.join("export").exists());
    assert_eq!(
        service
            .export_independent_vault(
                service
                    .activate_ui_source(&registration.id)
                    .unwrap()
                    .source_epoch,
                Path::new("relative-output"),
                &[]
            )
            .unwrap_err()
            .code,
        "knowledge-export-invalid-destination"
    );
}

#[cfg(windows)]
#[test]
fn portability_export_rejects_linked_output_ancestor() {
    use std::os::windows::process::CommandExt;
    let (service, root, registration) = fixture("portability-reparse");
    std::fs::write(root.join("n.md"), "source").unwrap();
    let physical = root.parent().unwrap().join("physical");
    std::fs::create_dir(&physical).unwrap();
    let linked = root.parent().unwrap().join("linked");
    let result = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&linked)
        .arg(&physical)
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(result.status.success());
    assert_eq!(
        service
            .export_independent_vault(
                service
                    .activate_ui_source(&registration.id)
                    .unwrap()
                    .source_epoch,
                &linked.join("export"),
                &[]
            )
            .unwrap_err()
            .code,
        "knowledge-path-reparse-forbidden"
    );
    assert!(!physical.join("export").exists());
}

#[test]
fn portability_export_stale_source_does_not_create_output() {
    let (service, root, registration) = fixture("portability-stale");
    std::fs::write(root.join("n.md"), "source").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let output = root.parent().unwrap().join("export");
    let result = service
        .export_independent_vault(active.source_epoch + 1, &output, &[])
        .unwrap_err();
    assert_eq!(result.code, "knowledge-source-inactive");
    assert!(!output.exists());
}

#[test]
fn portability_export_file_uri_requires_approval_for_each_note() {
    let (service, root, registration) = fixture("portability-uri");
    let original = root.parent().unwrap().join("actual # %20 中文.png");
    std::fs::write(&original, b"original pixels").unwrap();
    let target = url::Url::from_file_path(&original).unwrap().to_string();
    let markdown = format!("![author]({target} \"title\")");
    std::fs::write(root.join("approved.md"), &markdown).unwrap();
    std::fs::write(root.join("unapproved.md"), &markdown).unwrap();
    let approved = vec![(
        "approved.md".into(),
        vec![original.to_string_lossy().into_owned()],
    )];
    let output = root.parent().unwrap().join("export");
    let result = service
        .export_independent_vault(
            service
                .activate_ui_source(&registration.id)
                .unwrap()
                .source_epoch,
            &output,
            &approved,
        )
        .unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(result.attachment_count, 1);
    assert!(result
        .issues
        .iter()
        .any(|issue| issue.document == "unapproved.md"
            && issue.status == "external-attachment-not-approved"));
    assert_eq!(
        std::fs::read_to_string(output.join("unapproved.md")).unwrap(),
        markdown
    );
    let saved = std::fs::read_to_string(output.join("approved.md")).unwrap();
    let link = attachment_links(&saved).remove(0);
    let inventory = index::attachment_inventory(&output).unwrap();
    let resolved = resolve_attachment(
        &output,
        &inventory,
        "approved.md",
        &link.destination,
        link.syntax,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(resolved.absolute_path.unwrap()).unwrap(),
        b"original pixels"
    );
    assert_eq!(std::fs::read(&original).unwrap(), b"original pixels");
}

#[test]
fn portability_export_attachment_names_avoid_note_directories() {
    let (service, root, registration) = fixture("portability-directory-conflict");
    std::fs::create_dir_all(root.join("attachments/photo.png")).unwrap();
    std::fs::write(root.join("attachments/photo.png/n.md"), "nested note").unwrap();
    std::fs::write(root.join("photo.png"), b"pixels").unwrap();
    std::fs::write(root.join("n.md"), "![[photo.png]]").unwrap();
    let output = root.parent().unwrap().join("export");
    let result = service
        .export_independent_vault(
            service
                .activate_ui_source(&registration.id)
                .unwrap()
                .source_epoch,
            &output,
            &[],
        )
        .unwrap();
    assert_eq!(result.status, "complete", "{result:?}");
    assert_eq!(
        std::fs::read(output.join("attachments/photo (2).png")).unwrap(),
        b"pixels"
    );
    assert_eq!(
        std::fs::read_to_string(output.join("attachments/photo.png/n.md")).unwrap(),
        "nested note"
    );
}

#[test]
fn portability_export_collects_absolute_file_uri_inside_source_vault() {
    let (service, root, registration) = fixture("portability-internal-uri");
    let original = root.join("inside.png");
    std::fs::write(&original, b"inside pixels").unwrap();
    let uri = url::Url::from_file_path(&original).unwrap().to_string();
    std::fs::write(root.join("n.md"), format!("![inside]({uri})")).unwrap();
    let output = root.parent().unwrap().join("export");
    let result = service
        .export_independent_vault(
            service
                .activate_ui_source(&registration.id)
                .unwrap()
                .source_epoch,
            &output,
            &[],
        )
        .unwrap();
    assert_eq!(result.status, "complete", "{result:?}");
    assert_eq!(result.attachment_count, 1);
    let saved = std::fs::read_to_string(output.join("n.md")).unwrap();
    assert!(!saved.contains("file:"));
    let link = attachment_links(&saved).remove(0);
    let inventory = index::attachment_inventory(&output).unwrap();
    let resolved =
        resolve_attachment(&output, &inventory, "n.md", &link.destination, link.syntax).unwrap();
    assert_eq!(
        std::fs::read(resolved.absolute_path.unwrap()).unwrap(),
        b"inside pixels"
    );
}

#[test]
fn note_archive_exports_only_selected_note_and_deduplicated_attachments() {
    let (service, root, registration) = fixture("single-note-zip");
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::create_dir_all(root.join("pictures")).unwrap();
    std::fs::write(root.join("pictures/a.png"), b"image").unwrap();
    let original = "![[pictures/a.png|300]]\n![same](../pictures/a.png)\n[website](https://example.invalid/remote.png)";
    std::fs::write(root.join("notes/n.md"), original).unwrap();
    std::fs::write(root.join("private-other.md"), "must not export").unwrap();
    let output = root.parent().unwrap().join("note.zip");
    let epoch = service.activate_ui_source(&registration.id).unwrap().source_epoch;
    let reference = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "notes/n.md".into() };
    let result = service.export_note_archive(epoch, &output, &[], &reference).unwrap();
    assert_eq!(result.document_count, 1);
    assert_eq!(result.attachment_count, 1);
    let mut zip = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
    assert_eq!(zip.len(), 3);
    assert!(zip.by_name("private-other.md").is_err());
    let mut markdown = String::new();
    zip.by_name("notes/n.md").unwrap().read_to_string(&mut markdown).unwrap();
    assert!(markdown.contains("![[attachments/a.png|300]]"));
    assert!(markdown.contains("../attachments/a.png"));
    assert!(markdown.contains("https://example.invalid/remote.png"));
    assert!(zip.by_name("LuckyRay-export-receipt.json").is_ok());
    assert_eq!(std::fs::read_to_string(root.join("notes/n.md")).unwrap(), original);
    let before = std::fs::read(&output).unwrap();
    assert!(service.export_note_archive(epoch, &output, &[], &reference).is_err());
    assert_eq!(std::fs::read(&output).unwrap(), before);
}

#[test]
fn note_archive_rejects_source_overlap_path_escape_and_stale_source() {
    let (service, root, registration) = fixture("note-zip-boundaries");
    std::fs::write(root.join("n.md"), "safe").unwrap();
    let epoch = service.activate_ui_source(&registration.id).unwrap().source_epoch;
    let reference = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "n.md".into() };
    assert!(service.export_note_archive(epoch, &root.join("inside.zip"), &[], &reference).is_err());
    assert!(!root.join("inside.zip").exists());
    let outside = root.parent().unwrap().join("outside.zip");
    assert!(service.export_note_archive(epoch + 1, &outside, &[], &reference).is_err());
    let escaped = KnowledgeDocumentRef { vault_id: registration.id, relative_path: "../secret.md".into() };
    assert!(service.export_note_archive(epoch, &outside, &[], &escaped).is_err());
    assert!(!outside.exists());
}

#[test]
fn note_archive_reports_missing_and_ambiguous_attachments_without_guessing() {
    let (service, root, registration) = fixture("note-zip-missing");
    std::fs::create_dir(root.join("one")).unwrap(); std::fs::create_dir(root.join("two")).unwrap();
    std::fs::write(root.join("one/a.png"), b"one").unwrap(); std::fs::write(root.join("two/a.png"), b"two").unwrap();
    std::fs::write(root.join("n.md"), "![[a.png]]\n![[missing.png]]").unwrap();
    let epoch = service.activate_ui_source(&registration.id).unwrap().source_epoch;
    let reference = KnowledgeDocumentRef { vault_id: registration.id, relative_path: "n.md".into() };
    let result = service.export_note_archive(epoch, &root.parent().unwrap().join("missing.zip"), &[], &reference).unwrap();
    assert_eq!(result.status, "partial"); assert_eq!(result.attachment_count, 0); assert_eq!(result.issues.len(), 2);
}
