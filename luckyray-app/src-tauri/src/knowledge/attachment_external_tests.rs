use super::attachment_tests::fixture;
use super::external_attachments::{
    external_target_path, file_path_key, portable_attachment_target,
};
use super::markdown_links::{attachment_links, LinkSyntax};
use super::*;

#[cfg(windows)]
#[test]
fn external_same_disk_normal_and_verbatim_paths_use_relative_targets() {
    for root in [r"C:\Vault", r"\\?\C:\Vault", "//?/C:/Vault"] {
        for target in [
            r"c:\Images\图 # %20 (2).png",
            r"\\?\c:\Images\图 # %20 (2).png",
            "//?/c:/Images/图 # %20 (2).png",
        ] {
            let link = portable_attachment_target(Path::new(root), "notes/n.md", Path::new(target))
                .unwrap();
            assert!(
                link.starts_with("../../Images/"),
                "{root} -> {target}: {link}"
            );
            assert!(link.contains("%23") && link.contains("%2520"));
            let resolved =
                external_target_path(Path::new(root), "notes/n.md", &link, LinkSyntax::Markdown)
                    .unwrap()
                    .unwrap();
            assert_eq!(file_path_key(&resolved), file_path_key(Path::new(target)));
        }
    }
    let inside = portable_attachment_target(
        Path::new(r"\\?\C:\Vault"),
        "notes/n.md",
        Path::new(r"c:\vault\notes\图.png"),
    )
    .unwrap();
    assert!(inside.starts_with("./"), "{inside}");
}

#[cfg(windows)]
#[test]
fn external_cross_disk_verbatim_paths_generate_decodable_file_uri() {
    let target = Path::new(r"\\?\C:\Images\图 # %20 (2).png");
    let uri = portable_attachment_target(Path::new(r"\\?\D:\Vault"), "n.md", target).unwrap();
    assert!(uri.starts_with("file:///C:/Images/"), "{uri}");
    assert!(!uri.contains("%3F"));
    let resolved = external_target_path(Path::new(r"D:\Vault"), "n.md", &uri, LinkSyntax::Markdown)
        .unwrap()
        .unwrap();
    assert_eq!(file_path_key(&resolved), file_path_key(target));
}

#[test]
fn external_resolver_requires_exact_approved_file_and_scanner_does_not_grant_access() {
    let (service, root, registration) = fixture("external-approval");
    let original = root.parent().unwrap().join("image # %.png");
    std::fs::write(&original, b"original").unwrap();
    let target = portable_attachment_target(&root, "n.md", &original).unwrap();
    std::fs::write(root.join("n.md"), format!("![x]({target})")).unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id,
        relative_path: "n.md".into(),
    };
    let denied = service
        .resolve_attachment_with_approved_paths(&note, &target, false, &[])
        .unwrap();
    assert_eq!(denied.status, "external-unregistered");
    assert!(service
        .document_attachment_paths(&note, &[])
        .unwrap()
        .is_empty());
    let approved = vec![original.to_string_lossy().into_owned()];
    let resolved = service
        .resolve_attachment_with_approved_paths(&note, &target, false, &approved)
        .unwrap();
    assert_eq!(resolved.status, "resolved");
    assert_eq!(
        std::fs::read(resolved.absolute_path.unwrap()).unwrap(),
        b"original"
    );
    assert_eq!(
        service
            .document_attachment_paths(&note, &approved)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn external_resolver_accepts_file_uri_within_current_vault() {
    let (service, root, registration) = fixture("external-local-uri");
    let original = root.join("image.png");
    std::fs::write(&original, b"original").unwrap();
    let target = url::Url::from_file_path(&original).unwrap().to_string();
    std::fs::write(root.join("n.md"), format!("![x]({target})")).unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id,
        relative_path: "n.md".into(),
    };
    let result = service
        .resolve_attachment_with_approved_paths(&note, &target, false, &[])
        .unwrap();
    assert_eq!(result.status, "resolved");
    assert_eq!(
        std::fs::read(result.absolute_path.unwrap()).unwrap(),
        b"original"
    );
}

fn import_fixture(reference: bool, absolute_uri: bool) {
    let (service, root, registration) = fixture("external-import");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir_all(source.join("nested")).unwrap();
    std::fs::create_dir_all(source.join("images")).unwrap();
    let picture = source.join("images/中文 # %20.png");
    std::fs::write(&picture, b"source original").unwrap();
    let target = if absolute_uri {
        url::Url::from_file_path(&picture).unwrap().to_string()
    } else {
        "../images/%E4%B8%AD%E6%96%87%20%23%20%2520.png".into()
    };
    let original = format!("![author]({target}#page=2 \"original title\")");
    std::fs::write(source.join("nested/n.md"), &original).unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service
        .preview_attachment_import_with_policy(
            &registration.id,
            &source,
            &["nested/n.md".into()],
            "",
            reference,
        )
        .unwrap();
    assert!(plan.issues.is_empty(), "{plan:?}");
    let result = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(result.status, "complete", "{result:?}");
    let saved = std::fs::read_to_string(root.join("nested/n.md")).unwrap();
    assert!(saved.contains("#page=2 \"original title\""), "{saved}");
    let link = attachment_links(&saved).remove(0);
    let path = external_target_path(&root, "nested/n.md", &link.destination, link.syntax)
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"source original");
    if reference {
        assert_eq!(file_path_key(&path), file_path_key(&picture));
        assert!(!root.join("attachments").exists());
        assert_eq!(plan.external_paths.len(), 1);
    } else {
        assert!(path.starts_with(&root), "{path:?}");
        assert_ne!(file_path_key(&path), file_path_key(&picture));
    }
    assert_eq!(
        std::fs::read_to_string(source.join("nested/n.md")).unwrap(),
        original
    );
    assert_eq!(std::fs::read(&picture).unwrap(), b"source original");
}

#[test]
fn external_import_reference_keeps_original_and_rewrites_relative_target() {
    import_fixture(true, false);
}
#[test]
fn external_import_copy_writes_actual_independent_attachment() {
    import_fixture(false, false);
}
#[test]
fn external_import_inside_source_file_uri_reference_is_registered() {
    import_fixture(true, true);
}
#[test]
fn external_import_inside_source_file_uri_copy_is_independent() {
    import_fixture(false, true);
}

#[test]
fn external_import_outside_source_root_keeps_link_kind_in_both_policies() {
    for reference in [true, false] {
        let (service, root, registration) = fixture("external-import-outside");
        let source = root.parent().unwrap().join("source");
        std::fs::create_dir(&source).unwrap();
        let original_file = root.parent().unwrap().join("guide.pdf");
        std::fs::write(&original_file, b"original document").unwrap();
        let original = "[Read guide](../guide.pdf#page=3 \"author title\")";
        std::fs::write(source.join("n.md"), original).unwrap();
        let active = service.activate_ui_source(&registration.id).unwrap();
        let plan = service
            .preview_attachment_import_with_policy(
                &registration.id,
                &source,
                &["n.md".into()],
                "",
                reference,
            )
            .unwrap();
        assert!(plan.issues.is_empty());
        let result = service
            .execute_attachment_operation(active.source_epoch, &plan)
            .unwrap();
        assert_eq!(result.status, "complete");
        let saved = std::fs::read_to_string(root.join("n.md")).unwrap();
        assert!(saved.contains("#page=3 \"author title\""));
        let link = attachment_links(&saved).remove(0);
        assert!(!link.embedded);
        let target = external_target_path(&root, "n.md", &link.destination, link.syntax)
            .unwrap()
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"original document");
        assert_eq!(
            file_path_key(&target) == file_path_key(&original_file),
            reference
        );
        assert_eq!(
            std::fs::read_to_string(source.join("n.md")).unwrap(),
            original
        );
    }
}

#[test]
fn external_import_reference_style_reports_partial_without_fake_rewrite() {
    let (service, root, registration) = fixture("external-import-reference-style");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(root.parent().unwrap().join("outside.png"), b"pixels").unwrap();
    let original = "![author][id]\n\n[id]: ../outside.png\n";
    std::fs::write(source.join("n.md"), original).unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let plan = service
        .preview_attachment_import_with_policy(
            &registration.id,
            &source,
            &["n.md".into()],
            "",
            true,
        )
        .unwrap();
    assert!(plan
        .issues
        .iter()
        .any(|issue| issue.status == "unsupported-reference-style-rewrite"));
    assert!(plan.external_paths.is_empty());
    let result = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(result.status, "complete-with-unresolved");
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        original
    );
}

#[test]
fn external_conversion_collects_only_approved_references_and_preserves_authored_syntax() {
    let (service, root, registration) = fixture("external-convert");
    let original_file = root.parent().unwrap().join("source image.png");
    std::fs::write(&original_file, b"source original").unwrap();
    let uri = url::Url::from_file_path(&original_file)
        .unwrap()
        .to_string();
    let original =
        format!("![[../source image.png|300]]\n![author]({uri}#page=2 \"width=300 height=200\")");
    std::fs::write(root.join("n.md"), &original).unwrap();
    std::fs::write(root.join("other.md"), &original).unwrap();
    let reference = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    let active = service.activate_ui_source(&registration.id).unwrap();
    let approved = vec![(
        "n.md".into(),
        vec![original_file.to_string_lossy().into_owned()],
    )];
    let plan = service
        .preview_attachment_conversion_with_approved(&[reference], &[], &approved)
        .unwrap();
    assert!(plan.issues.is_empty(), "{plan:?}");
    assert_eq!(plan.attachment_count, 1);
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        original,
        "preview is read-only"
    );
    let result = service
        .execute_attachment_operation(active.source_epoch, &plan)
        .unwrap();
    assert_eq!(result.status, "complete");
    let saved = std::fs::read_to_string(root.join("n.md")).unwrap();
    assert!(
        saved.contains("![[attachments/source image.png|300]]"),
        "{saved}"
    );
    assert!(saved.contains("#page=2 \"width=300 height=200\""));
    let inventory = index::attachment_inventory(&root).unwrap();
    for link in attachment_links(&saved) {
        let resolved = super::attachments::resolve_attachment(
            &root,
            &inventory,
            "n.md",
            &link.destination,
            link.syntax,
        )
        .unwrap();
        assert_eq!(resolved.status, "resolved");
        assert_eq!(
            std::fs::read(resolved.absolute_path.unwrap()).unwrap(),
            b"source original"
        );
    }
    assert_eq!(std::fs::read(&original_file).unwrap(), b"source original");
    assert_eq!(
        std::fs::read_to_string(root.join("other.md")).unwrap(),
        original
    );
}

#[test]
fn external_conversion_requires_per_note_approval_before_inspecting_sources() {
    let (service, root, registration) = fixture("external-convert-denied");
    let missing = root.parent().unwrap().join("must-not-inspect.png");
    let uri = url::Url::from_file_path(&missing).unwrap().to_string();
    let original = format!("![private]({uri})");
    std::fs::write(root.join("n.md"), &original).unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    let plan = service
        .preview_attachment_conversion_with_approved(
            &[note.clone()],
            &[],
            &[(
                "other.md".into(),
                vec![missing.to_string_lossy().into_owned()],
            )],
        )
        .unwrap();
    assert_eq!(plan.issues.len(), 1);
    assert_eq!(plan.issues[0].status, "external-unregistered");
    assert_eq!(plan.attachment_count, 0);
    let old_wrapper = service.preview_attachment_conversion(&[note], &[]).unwrap();
    assert_eq!(old_wrapper.issues[0].status, "external-unregistered");
    assert!(!root.join("attachments").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        original
    );
}

#[test]
fn external_conversion_missing_approved_file_preserves_note_and_reports_unavailable() {
    let (service, root, registration) = fixture("external-convert-missing");
    let missing = root.parent().unwrap().join("missing.png");
    let original = "![[../missing.png|author]]";
    std::fs::write(root.join("n.md"), original).unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    let plan = service
        .preview_attachment_conversion_with_approved(
            &[note],
            &[],
            &[("n.md".into(), vec![missing.to_string_lossy().into_owned()])],
        )
        .unwrap();
    assert_eq!(plan.attachment_count, 0);
    assert_eq!(plan.issues.len(), 1);
    assert_ne!(plan.issues[0].status, "external-unregistered");
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        original
    );
}

#[test]
fn external_import_wiki_dimensions_become_standard_markdown_size_metadata() {
    for (alias, title) in [
        ("300", Some("width=300")),
        ("300x200", Some("width=300 height=200")),
        ("author", None),
    ] {
        let (service, root, registration) = fixture("external-import-width");
        let source = root.parent().unwrap().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("picture.png"), b"source original").unwrap();
        let original = format!("![[picture.png|{alias}]]");
        std::fs::write(source.join("n.md"), &original).unwrap();
        let active = service.activate_ui_source(&registration.id).unwrap();
        let plan = service
            .preview_attachment_import_with_policy(
                &registration.id,
                &source,
                &["n.md".into()],
                "",
                true,
            )
            .unwrap();
        let result = service
            .execute_attachment_operation(active.source_epoch, &plan)
            .unwrap();
        assert_eq!(result.status, "complete");
        let saved = std::fs::read_to_string(root.join("n.md")).unwrap();
        if let Some(title) = title {
            assert!(saved.contains(&format!("\"{title}\"")), "{saved}");
            assert!(saved.starts_with("![picture.png]"));
        } else {
            assert!(saved.starts_with("![author]"));
            assert!(!saved.contains("width="));
        }
        let link = attachment_links(&saved).remove(0);
        let path = external_target_path(&root, "n.md", &link.destination, link.syntax)
            .unwrap()
            .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"source original");
        assert_eq!(
            std::fs::read_to_string(source.join("n.md")).unwrap(),
            original
        );
    }
}

#[test]
fn external_copy_publication_keeps_distinct_source_paths_with_equal_bytes() {
    let (service, root, registration) = fixture("copy-source-identities");
    let first = root.parent().unwrap().join("first.png");
    let second = root.parent().unwrap().join("second.png");
    std::fs::write(&first, b"equal bytes").unwrap();
    std::fs::write(&second, b"equal bytes").unwrap();
    std::fs::write(root.join("existing.png"), b"equal bytes").unwrap();
    std::fs::write(root.join("n.md"), "note").unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    let snapshot = service.read_document(&note).unwrap();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let a = service
        .publish_attachment_with_policy(
            epoch,
            &note,
            &snapshot.revision,
            "first.png",
            &[],
            Some(&first),
            false,
            false,
        )
        .unwrap();
    let b = service
        .publish_attachment_with_policy(
            epoch,
            &note,
            &snapshot.revision,
            "second.png",
            &[],
            Some(&second),
            false,
            false,
        )
        .unwrap();
    assert!(!a.reused && !b.reused);
    assert_ne!(a.relative_path, b.relative_path);
    assert_eq!(
        std::fs::read(root.join(&a.relative_path)).unwrap(),
        b"equal bytes"
    );
    assert_eq!(
        std::fs::read(root.join(&b.relative_path)).unwrap(),
        b"equal bytes"
    );
    std::fs::write(root.join(&a.relative_path), b"edited first copy").unwrap();
    assert_eq!(
        std::fs::read(root.join(&b.relative_path)).unwrap(),
        b"equal bytes"
    );
    assert_eq!(std::fs::read(&first).unwrap(), b"equal bytes");
    assert_eq!(std::fs::read(&second).unwrap(), b"equal bytes");
}

#[test]
fn external_reference_to_vault_legacy_filename_never_creates_a_copy() {
    let (service, root, registration) = fixture("reference-legacy-local");
    std::fs::create_dir(root.join("attachments")).unwrap();
    let relative = format!("attachments/{}.png", sha256_hex(b"legacy pixels"));
    let original = root.join(&relative);
    std::fs::write(&original, b"legacy pixels").unwrap();
    std::fs::write(root.join("n.md"), "note").unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    let snapshot = service.read_document(&note).unwrap();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let before = index::attachment_inventory(&root).unwrap();
    let result = service
        .publish_attachment_with_policy(
            epoch,
            &note,
            &snapshot.revision,
            "pretty.png",
            &[],
            Some(&original),
            true,
            true,
        )
        .unwrap();
    assert!(result.reused);
    assert_eq!(result.relative_path, relative);
    assert_eq!(index::attachment_inventory(&root).unwrap(), before);
}

#[test]
fn external_copy_import_reuses_one_source_per_plan_without_merging_equal_other_paths() {
    let (service, root, registration) = fixture("copy-import-identities");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir_all(source.join("a")).unwrap();
    std::fs::create_dir(source.join("b")).unwrap();
    std::fs::write(source.join("a/image.png"), b"same").unwrap();
    std::fs::write(source.join("b/image.png"), b"same").unwrap();
    std::fs::write(
        source.join("one.md"),
        "![[a/image.png]]\n![[b/image.png]]\n![[a/image.png]]",
    )
    .unwrap();
    std::fs::write(source.join("two.md"), "![[a/image.png]]").unwrap();
    std::fs::write(root.join("existing.png"), b"same").unwrap();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let plan = service
        .preview_attachment_import_with_policy(
            &registration.id,
            &source,
            &["one.md".into(), "two.md".into()],
            "",
            false,
        )
        .unwrap();
    assert_eq!(plan.attachment_count, 2);
    let outcome = service.execute_attachment_operation(epoch, &plan).unwrap();
    assert_eq!(outcome.status, "complete");
    let one = attachment_links(&std::fs::read_to_string(root.join("one.md")).unwrap());
    let two = attachment_links(&std::fs::read_to_string(root.join("two.md")).unwrap());
    assert_ne!(one[0].destination, one[1].destination);
    assert_eq!(one[0].destination, one[2].destination);
    assert_eq!(one[0].destination, two[0].destination);
    let inventory = index::attachment_inventory(&root).unwrap();
    for link in one {
        let resolved = super::attachments::resolve_attachment(
            &root,
            &inventory,
            "one.md",
            &link.destination,
            link.syntax,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(resolved.absolute_path.unwrap()).unwrap(),
            b"same"
        );
    }
    assert_eq!(std::fs::read(source.join("a/image.png")).unwrap(), b"same");
    assert_eq!(std::fs::read(source.join("b/image.png")).unwrap(), b"same");
}

#[test]
fn moving_note_preserves_external_relative_targets_without_granting_access() {
    let (service, root, registration) = fixture("external-note-move");
    let original_file = root.parent().unwrap().join("photo # %.png");
    std::fs::write(&original_file, b"same external original").unwrap();
    let target = portable_attachment_target(&root, "n.md", &original_file).unwrap();
    std::fs::write(root.join("n.md"), format!("![image]({target}#fragment \"width=300\")\n[plain]({target})")).unwrap();
    std::fs::create_dir(root.join("nested")).unwrap();
    let active=service.activate_ui_source(&registration.id).unwrap();
    let note=KnowledgeDocumentRef{vault_id:registration.id.clone(),relative_path:"n.md".into()};
    let document=service.read_document(&note).unwrap();
    let moved=service.move_document_from_ui(active.source_epoch,&KnowledgeMoveInput{document_ref:note,title:"moved".into(),parent_relative_path:Some("nested".into()),expected_revision:document.revision}).unwrap();
    assert!(moved.content.contains("#fragment \"width=300\""));
    let links=attachment_links(&moved.content);
    assert_eq!(links.len(),2);
    for link in links {
        let resolved=external_target_path(&root,"nested/moved.md",&link.destination,link.syntax).unwrap().unwrap();
        assert_eq!(file_path_key(&resolved),file_path_key(&original_file));
        assert_eq!(service.resolve_attachment_with_approved_paths(&moved.summary.document_ref,&link.destination,false,&[]).unwrap().status,"external-unregistered");
    }
    assert_eq!(std::fs::read(&original_file).unwrap(),b"same external original");
    assert!(!root.join("n.md").exists());
}

#[cfg(windows)]
#[test]
fn cross_disk_import_persists_independently_readable_original_uri() {
    let (service,old_root,mut registration)=fixture("real-cross-disk-uri");
    let root=PathBuf::from("D:/codex/luckyray/_qa").join(format!("cross-disk-vault-{:032x}",rand::random::<u128>()));
    std::fs::create_dir_all(root.join(".luckyray")).unwrap();
    registration.root_path=root.to_string_lossy().into_owned();
    std::fs::write(root.join(".luckyray/vault.json"),serde_json::to_vec(&registration).unwrap()).unwrap();
    service.register_current_vault(&registration).unwrap();
    let source=old_root.parent().unwrap().join("cross-disk-source");
    std::fs::create_dir_all(&source).unwrap();
    let original=source.join("原图 # %.png");
    let png=base64::Engine::decode(&base64::engine::general_purpose::STANDARD,"iVBORw0KGgoAAAANSUhEUgAAALQAAABkCAYAAAAv8xodAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMtSURBVHhe7dLBjRRBFATRdQMfcAQbMBkJl0B9GAnFhd35VdnVqfjSu+xhp1IdH9++//gjtfjgH6QnM2hVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVMWhVeVTQP3//ehv/lzodHzTDXIG/oR7HBs0Id+Bv6vmOC5rRJfANeq5jgmZkd+Cb7tBy3JVyRNAM6058W1rLcVfKrUEzppPwrSktx10ptwXNgE7ENye0HHel3BI0wzkZ375by3FXSjxoBvME3LBTy3FXSjRohvIk3LJLy3FXikF/Erfs0nLclRILmoE8ETft0HLclRIJmmE8Gbet1nLclWLQX8Rtq7Ucd6VsD5pBNODGlVqOu1IM+g3cuFLLcVfK1qAZQhNuXaXluCvFoN/Erau0HHelbAuaATTi5hVajrtSDHqAm1doOe5KMegBbl6h5bgrZUvQ/PDNuH2q5bgrxaCHuH2q5bgrxaCHuH2q5bgrxaCHuH2q5bgrxaCHuH2q5bgrxaCHuH2q5bgrxaCHuH2q5bgrZXnQ/ODtuH+q5bgrZXnQF370Ztw+1XLclWLQQ9w+1XLclWLQQ9w+1XLclWLQQ9w+1XLclWLQQ9w+1XLclWLQQ9w+1XLclWLQQ9w+1XLclbIl6As/fCNuXqHluCvFoAe4eYWW464Ugx7g5hVajrtStgV9YQBNuHWVluOuFIN+E7eu0nLclbI16AtDaMCNK7Ucd6UY9Bu4caWW466U7UFfGMSTcdtqLcddKQb9Rdy2WstxV0ok6AvDeCJu2qHluCslFvSFgTwJt+zSctyVYtCfxC27tBx3pUSDvjCUJ+CGnVqOu1LiQV8YzMn49t1ajrtSbgn6wnBOxDcntBx3pdwW9IUBnYRvTWk57kq5NegXxnQnvi2t5bgr5YigLwzrDnyTnueYoF8YWQLfoOc6LugXRrcDf1PPd2zQL4xwBf6Gehwf9L8Y5lfwf6nTo4KW/segVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVcWgVeUvzBYlJcuMUDcAAAAASUVORK5CYII=").unwrap();
    std::fs::write(&original,&png).unwrap();
    std::fs::write(source.join("n.md"),"![[原图 # %.png]]").unwrap();
    // A literal # is an authored Wiki fragment delimiter; standard Markdown
    // percent-encodes the filename so this fixture expresses the actual file.
    std::fs::write(source.join("n.md"),"![原图](./%E5%8E%9F%E5%9B%BE%20%23%20%25.png)").unwrap();
    let active=service.activate_ui_source(&registration.id).unwrap();
    let plan=service.preview_attachment_import_with_policy(&registration.id,&source,&["n.md".into()],"",true).unwrap();
    let outcome=service.execute_attachment_operation(active.source_epoch,&plan).unwrap();
    assert_eq!(outcome.status,"complete");
    assert_eq!(plan.attachment_count,0);
    let saved=std::fs::read_to_string(root.join("n.md")).unwrap();
    let links=attachment_links(&saved);
    assert_eq!(links.len(),1);
    assert!(links[0].destination.starts_with("file:///C:/"));
    // url::Url reads only the saved text; no Catalog lookup participates.
    let decoded=url::Url::parse(&links[0].destination).unwrap().to_file_path().unwrap();
    assert_eq!(std::fs::read(&decoded).unwrap(),png);
    assert!(!root.join("attachments").exists());
    eprintln!("INDEPENDENT_ORIGINAL={}\nSAVED_MARKDOWN={}",decoded.display(),root.join("n.md").display());
}
