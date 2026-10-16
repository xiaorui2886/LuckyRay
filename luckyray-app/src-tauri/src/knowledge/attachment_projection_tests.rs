//! Independent production projection regression checks on disposable data only.
use super::attachment_tests::fixture;
use super::*;
use crate::attachment_coordination::{
    authorize_attachment_plan, finish_attachment_projection, sync_note_attachment_index,
    verify_attachment_plan,
};
use crate::materials::MaterialCatalog;

#[test]
fn projection_signed_plan_rejects_body_epoch_and_relocation_tampering() {
    let (service, root, registration) = fixture("projection-seal");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("n.md"), "source").unwrap();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let plan = authorize_attachment_plan(
        &service,
        service
            .preview_attachment_import(&registration.id, &source, &["n.md".into()], "")
            .unwrap(),
    )
    .unwrap();
    verify_attachment_plan(&plan, epoch).unwrap();
    let roundtrip = serde_json::from_slice(&serde_json::to_vec(&plan).unwrap()).unwrap();
    verify_attachment_plan(&roundtrip, epoch).unwrap();
    let mut altered = plan.clone();
    altered.material_relocation = Some(("other-asset".into(), "C:/other.png".into(), "[]".into()));
    assert!(verify_attachment_plan(&altered, epoch).is_err());
    let mut altered = plan.clone();
    altered.files[0].relative_path = "other.md".into();
    assert!(verify_attachment_plan(&altered, epoch).is_err());
    assert!(verify_attachment_plan(&plan, epoch + 1).is_err());
}

#[test]
fn projection_source_aba_after_native_execute_refuses_catalog_changes() {
    let (service, root, registration) = fixture("projection-source");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("image.png"), b"pixels").unwrap();
    std::fs::write(source.join("n.md"), "![[image.png]]").unwrap();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let plan = service
        .preview_attachment_import_with_policy(
            &registration.id,
            &source,
            &["n.md".into()],
            "",
            true,
        )
        .unwrap();
    let native = service.execute_attachment_operation(epoch, &plan).unwrap();
    let (_other_service, _other_root, other_registration) = fixture("projection-source-b");
    service.register_current_vault(&other_registration).unwrap();
    service.activate_ui_source(&other_registration.id).unwrap();
    service.register_current_vault(&registration).unwrap();
    let next = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    assert_ne!(next, epoch);
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let projected = finish_attachment_projection(&service, &catalog, &plan, native, epoch);
    assert_eq!(projected.status, "partial");
    assert!(projected
        .issues
        .iter()
        .any(|issue| issue.status.contains("attachment-index-pending")));
    assert!(catalog
        .approved_vault_attachment_paths(&registration.id)
        .unwrap()
        .is_empty());
    assert!(catalog
        .note_attachment_refs(&registration.id, "n.md")
        .unwrap()
        .is_empty());
}

#[test]
fn projection_index_snapshot_serializes_apply_and_guards_note_bytes() {
    use std::sync::mpsc;
    use std::time::Duration;
    let (service, root, registration) = fixture("projection-serialized");
    std::fs::write(root.join("n.md"), "![[image.png]]").unwrap();
    std::fs::write(root.join("image.png"), b"pixels").unwrap();
    let service = Arc::new(service);
    let note = KnowledgeDocumentRef {
        vault_id: registration.id,
        relative_path: "n.md".into(),
    };
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first_service = service.clone();
    let first_note = note.clone();
    let first_root = root.clone();
    let first = std::thread::spawn(move || {
        first_service
            .with_attachment_index_snapshot(&first_note, &[], |targets, paths| {
                assert_eq!(targets, vec!["image.png"]);
                assert_eq!(paths.len(), 1);
                #[cfg(windows)]
                assert!(std::fs::write(first_root.join("n.md"), "must not overwrite").is_err());
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .unwrap()
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (second_tx, second_rx) = mpsc::channel();
    let second_service = service.clone();
    let second_note = note.clone();
    let second = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        second_service
            .with_attachment_index_snapshot(&second_note, &[], |_, _| {
                second_tx.send(()).unwrap();
                Ok(())
            })
            .unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let blocked = second_rx.recv_timeout(Duration::from_millis(100)).is_err();
    release_tx.send(()).unwrap();
    first.join().unwrap();
    second.join().unwrap();
    assert!(
        blocked,
        "second projection must wait for first snapshot application"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        "![[image.png]]"
    );
}

#[test]
fn projection_partial_import_registers_only_verified_completed_note_and_protects_reference() {
    let (service, root, registration) = fixture("projection-partial");
    let source = root.parent().unwrap().join("source");
    std::fs::create_dir(&source).unwrap();
    for name in ["a", "b"] {
        std::fs::write(source.join(format!("{name}.png")), name.as_bytes()).unwrap();
        std::fs::write(
            source.join(format!("{name}.md")),
            format!("![[{name}.png]]"),
        )
        .unwrap();
    }
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let plan = service
        .preview_attachment_import_with_policy(
            &registration.id,
            &source,
            &["a.md".into(), "b.md".into()],
            "",
            true,
        )
        .unwrap();
    let mut native = service.execute_attachment_operation(epoch, &plan).unwrap();
    // Model partial completion evidence: the second target no longer matches
    // the planned after revision and must not grant its external file access.
    std::fs::write(root.join("b.md"), "external editor changed this note").unwrap();
    native.status = "partial".into();
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let result = finish_attachment_projection(&service, &catalog, &plan, native, epoch);
    assert_eq!(result.status, "partial");
    assert_eq!(
        catalog
            .note_attachment_refs(&registration.id, "a.md")
            .unwrap()
            .len(),
        1
    );
    assert!(catalog
        .note_attachment_refs(&registration.id, "b.md")
        .unwrap()
        .is_empty());
    assert_eq!(
        catalog
            .approved_vault_attachment_paths(&registration.id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn projection_relink_replay_accepts_normal_path_for_canonical_catalog_location() {
    let (service, root, registration) = fixture("projection-relink");
    let old = root.parent().unwrap().join("original.png");
    let new = root.parent().unwrap().join("moved.png");
    std::fs::write(&old, b"same pixels").unwrap();
    let old_target = url::Url::from_file_path(&old).unwrap().to_string();
    std::fs::write(root.join("n.md"), format!("![author]({old_target})")).unwrap();
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let asset = catalog
        .register_note_attachment(&old, &registration.id, None)
        .unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    sync_note_attachment_index(&service, &catalog, &note).unwrap();
    let before = catalog.attachment_details(&asset.id).unwrap();
    std::fs::rename(&old, &new).unwrap();
    let normal_new = new
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("//?/")
        .to_owned();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let mut plan = service
        .preview_attachment_relink(
            &registration.id,
            &[("n.md".into(), old_target)],
            Path::new(&normal_new),
        )
        .unwrap();
    plan.material_relocation = Some((
        asset.id.clone(),
        normal_new,
        serde_json::to_string(&before.references).unwrap(),
    ));
    plan.material_original_path = before.absolute_path.clone();
    plan.material_revision = Some(
        catalog
            .note_file_revision_for_asset(
                &catalog.for_attachment_projection().get_assets(&[asset.id.clone()]).unwrap().remove(0),
            )
            .unwrap(),
    );
    let native = service.execute_attachment_operation(epoch, &plan).unwrap();
    let first = finish_attachment_projection(&service, &catalog, &plan, native.clone(), epoch);
    assert_eq!(first.status, "complete", "{first:?}");
    let second = finish_attachment_projection(&service, &catalog, &plan, native, epoch);
    assert_eq!(second.status, "complete", "{second:?}");
    assert_eq!(
        catalog
            .attachment_details(&asset.id)
            .unwrap()
            .reference_count,
        1
    );
    assert!(!old.exists());
    assert_eq!(std::fs::read(&new).unwrap(), b"same pixels");
}

#[test]
fn projection_relink_rejects_asset_rebound_after_preview() {
    let (service, root, registration) = fixture("projection-relink-race");
    let old = root.parent().unwrap().join("original.png");
    let new = root.parent().unwrap().join("moved.png");
    std::fs::write(&old, b"same pixels").unwrap();
    let old_target = url::Url::from_file_path(&old).unwrap().to_string();
    std::fs::write(root.join("n.md"), format!("![author]({old_target})")).unwrap();
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let asset = catalog
        .register_note_attachment(&old, &registration.id, None)
        .unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    sync_note_attachment_index(&service, &catalog, &note).unwrap();
    let before = catalog.attachment_details(&asset.id).unwrap();
    std::fs::rename(&old, &new).unwrap();
    let normal_new = new
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("//?/")
        .to_owned();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let mut plan = service
        .preview_attachment_relink(
            &registration.id,
            &[("n.md".into(), old_target)],
            Path::new(&normal_new),
        )
        .unwrap();
    plan.material_relocation = Some((
        asset.id.clone(),
        normal_new,
        serde_json::to_string(&before.references).unwrap(),
    ));
    plan.material_original_path = before.absolute_path.clone();
    plan.material_revision = Some(
        catalog
            .note_file_revision_for_asset(
                &catalog.for_attachment_projection().get_assets(&[asset.id.clone()]).unwrap().remove(0),
            )
            .unwrap(),
    );
    let third = root.parent().unwrap().join("third-choice.png");
    std::fs::write(&third, b"same pixels").unwrap();
    catalog
        .relocate_asset_for_note_coordinator(
            &asset.id,
            &third,
            &crate::materials::MaterialRelocateOptions::default(),
            plan.material_revision.as_deref(),
            &before.references,
        )
        .unwrap();
    let native = service.execute_attachment_operation(epoch, &plan).unwrap();
    let result = finish_attachment_projection(&service, &catalog, &plan, native, epoch);
    assert_eq!(result.status, "partial", "{result:?}");
    let actual = catalog
        .attachment_details(&asset.id)
        .unwrap()
        .absolute_path
        .unwrap();
    assert_eq!(
        Path::new(&actual).canonicalize().unwrap(),
        third.canonicalize().unwrap()
    );
    assert!(result
        .issues
        .iter()
        .any(|issue| issue.status.contains("attachment-index-pending")));
}

fn publish_fixture_context(
    service: &KnowledgeService,
    note: &KnowledgeDocumentRef,
    epoch: u64,
    session: &KnowledgeContextSession,
    generation: u64,
) -> KnowledgeCurrentContext {
    let snapshot = service.read_document(note).unwrap();
    service
        .set_current_context(&KnowledgeCurrentContextInput {
            source_epoch: epoch,
            session_id: session.session_id.clone(),
            session_epoch: session.session_epoch,
            generation,
            document_ref: note.clone(),
            cursor_offset: Some(snapshot.content.encode_utf16().count()),
            selection: None,
            expected_revision: Some(snapshot.revision),
        })
        .unwrap()
}

#[test]
fn projection_material_detail_insert_three_modes_saves_real_markdown_and_indexes_asset() {
    use base64::Engine;
    let pixels=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=").unwrap();
    for mode in ["managed", "linked", "source"] {
        let (service, root, registration) = fixture(&format!("detail-insert-{mode}"));
        let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
        let source = root.parent().unwrap().join("用户图片.png");
        std::fs::write(&source, &pixels).unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &crate::materials::MaterialImportOptions {
                    storage_mode: mode.into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        if mode == "managed" {
            std::fs::write(&source, b"original source changed independently").unwrap();
        }
        std::fs::write(root.join("n.md"), "note\n").unwrap();
        let note = KnowledgeDocumentRef {
            vault_id: registration.id.clone(),
            relative_path: "n.md".into(),
        };
        let epoch = service
            .activate_ui_source(&registration.id)
            .unwrap()
            .source_epoch;
        let session = service
            .begin_current_context_session(epoch, "detail-test")
            .unwrap();
        publish_fixture_context(&service, &note, epoch, &session, 1);
        let result =
            crate::insert_material_current_with_services(&service, &catalog, &asset.id, epoch)
                .unwrap();
        assert!(!result.index_stale, "{result:?}");
        let saved = std::fs::read_to_string(root.join("n.md")).unwrap();
        assert!(saved.contains("![用户图片.png]"), "{mode}: {saved}");
        let link = super::markdown_links::attachment_links(&saved).remove(0);
        let path = super::external_attachments::external_target_path(
            &root,
            "n.md",
            &link.destination,
            link.syntax,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            pixels,
            "{mode}: actual Markdown file target"
        );
        let actual = catalog
            .resolve_external_drag_files(&[asset.id.clone()])
            .unwrap()
            .remove(0);
        assert_eq!(path.canonicalize().unwrap(), actual.canonicalize().unwrap());
        assert!(!root.join("attachments").exists());
        let refs = catalog
            .note_attachment_refs(&registration.id, "n.md")
            .unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].asset_id, asset.id);
    }
}

#[test]
fn projection_bound_current_refuses_context_aba_and_preserves_both_notes() {
    let (service, root, registration) = fixture("detail-context-aba");
    std::fs::write(root.join("a.md"), "A").unwrap();
    std::fs::write(root.join("b.md"), "B").unwrap();
    let a = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "a.md".into(),
    };
    let b = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "b.md".into(),
    };
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let session = service
        .begin_current_context_session(epoch, "context-test")
        .unwrap();
    let first = publish_fixture_context(&service, &a, epoch, &session, 1);
    publish_fixture_context(&service, &b, epoch, &session, 2);
    publish_fixture_context(&service, &a, epoch, &session, 3);
    let _source = service
        .lock_active_ui_source(epoch, Some(&registration.id))
        .unwrap();
    let error = service
        .insert_into_bound_current(
            &KnowledgeCurrentInsertInput {
                text: "must not insert".into(),
                append_if_no_cursor: true,
            },
            Some(&first),
            &_source,
        )
        .unwrap_err();
    assert_eq!(error.code, "knowledge-current-context-changed");
    assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "A");
    assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "B");
}

#[test]
fn projection_note_move_keeps_real_targets_and_moves_index_rows() {
    let (service, root, registration) = fixture("move-detail-refs");
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let outside = root.parent().unwrap().join("outside.png");
    std::fs::write(&outside, b"outside").unwrap();
    std::fs::write(root.join("inside.png"), b"inside").unwrap();
    std::fs::create_dir(root.join("nested")).unwrap();
    std::fs::write(
        root.join("n.md"),
        "![outside](../outside.png#page=2 \"author title\")\n![inside](./inside.png)",
    )
    .unwrap();
    catalog
        .register_note_attachment(&outside, &registration.id, None)
        .unwrap();
    let old = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    sync_note_attachment_index(&service, &catalog, &old).unwrap();
    let revision = service.read_document(&old).unwrap().revision;
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let result = crate::move_document_with_services(
        &service,
        &catalog,
        &KnowledgeMoveInput {
            document_ref: old.clone(),
            title: "moved".into(),
            expected_revision: revision,
            parent_relative_path: Some("nested".into()),
        },
        epoch,
    )
    .unwrap();
    let new = &result.summary.document_ref;
    assert_eq!(new.relative_path, "nested/moved.md");
    assert!(!root.join("n.md").exists());
    assert_eq!(
        catalog
            .note_attachment_refs(&registration.id, &new.relative_path)
            .unwrap()
            .len(),
        2
    );
    assert!(catalog
        .note_attachment_refs(&registration.id, &old.relative_path)
        .unwrap()
        .is_empty());
    let saved = std::fs::read_to_string(root.join(&new.relative_path)).unwrap();
    assert!(saved.contains("#page=2 \"author title\""));
    let mut observed = Vec::new();
    for link in super::markdown_links::attachment_links(&saved) {
        let path = super::external_attachments::external_target_path(
            &root,
            &new.relative_path,
            &link.destination,
            link.syntax,
        )
        .unwrap()
        .unwrap();
        observed.push(std::fs::read(path).unwrap());
    }
    assert!(observed.contains(&b"inside".to_vec()) && observed.contains(&b"outside".to_vec()));
}

#[test]
fn projection_note_move_retains_missing_attachment_relationship() {
    let (service, root, registration) = fixture("move-missing-refs");
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let outside = root.parent().unwrap().join("outside.png");
    std::fs::write(&outside, b"outside").unwrap();
    std::fs::create_dir(root.join("nested")).unwrap();
    std::fs::write(root.join("n.md"), "![outside](../outside.png)").unwrap();
    let asset = catalog
        .register_note_attachment(&outside, &registration.id, None)
        .unwrap();
    let old = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    sync_note_attachment_index(&service, &catalog, &old).unwrap();
    std::fs::rename(
        &outside,
        outside.with_file_name("temporarily-elsewhere.png"),
    )
    .unwrap();
    let revision = service.read_document(&old).unwrap().revision;
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let result = crate::move_document_with_services(
        &service,
        &catalog,
        &KnowledgeMoveInput {
            document_ref: old.clone(),
            title: "moved".into(),
            expected_revision: revision,
            parent_relative_path: Some("nested".into()),
        },
        epoch,
    )
    .unwrap();
    let refs = catalog
        .note_attachment_refs(&registration.id, &result.summary.document_ref.relative_path)
        .unwrap();
    assert_eq!(
        refs.len(),
        1,
        "unavailable attachment must retain known reference across note move"
    );
    assert_eq!(refs[0].asset_id, asset.id);
    assert!(catalog
        .note_attachment_refs(&registration.id, &old.relative_path)
        .unwrap()
        .is_empty());
    assert_eq!(
        catalog
            .attachment_details(&asset.id)
            .unwrap()
            .reference_count,
        1
    );
}

fn rollback_source_fixture(occupied: bool, added_reference: bool) {
    use base64::Engine;
    let pixels=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=").unwrap();
    let (service, root, registration) = fixture("rollback-projection");
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let source = root.parent().unwrap().join("source.png");
    let destination = root.parent().unwrap().join("moved.png");
    std::fs::write(&source, &pixels).unwrap();
    let asset = catalog
        .import_paths(
            &[source.clone()],
            &crate::materials::MaterialImportOptions {
                storage_mode: "source".into(),
                ..Default::default()
            },
        )
        .unwrap()
        .value
        .assets
        .remove(0);
    catalog
        .register_note_attachment(&source, &registration.id, Some(&asset.id))
        .unwrap();
    let original = format!("![image]({})", url::Url::from_file_path(&source).unwrap());
    std::fs::write(root.join("n.md"), &original).unwrap();
    let note = KnowledgeDocumentRef {
        vault_id: registration.id.clone(),
        relative_path: "n.md".into(),
    };
    sync_note_attachment_index(&service, &catalog, &note).unwrap();
    let epoch = service
        .activate_ui_source(&registration.id)
        .unwrap()
        .source_epoch;
    let plan = crate::attachment_file_moves::preview_with_services(
        &service,
        &catalog,
        &registration.id,
        &asset.id,
        &destination,
    )
    .unwrap();
    let native = service.execute_attachment_operation(epoch, &plan).unwrap();
    let forward = finish_attachment_projection(&service, &catalog, &plan, native, epoch);
    assert_eq!(forward.status, "complete", "{forward:?}");
    assert!(!source.exists());
    assert_eq!(std::fs::read(&destination).unwrap(), pixels);
    if added_reference {
        std::fs::write(
            root.join("new.md"),
            format!(
                "![new]({})",
                url::Url::from_file_path(&destination).unwrap()
            ),
        )
        .unwrap();
        sync_note_attachment_index(
            &service,
            &catalog,
            &KnowledgeDocumentRef {
                vault_id: registration.id.clone(),
                relative_path: "new.md".into(),
            },
        )
        .unwrap();
    }
    if occupied {
        std::fs::write(&source, b"unrelated occupant").unwrap();
    }
    crate::attachment_coordination::validate_attachment_rollback(&plan).unwrap();
    let native = service
        .recover_attachment_operation(epoch, &registration.id, &forward.operation_id, true)
        .unwrap();
    assert_eq!(native.status, "rolled-back", "{native:?}");
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        original
    );
    let rolled = crate::attachment_coordination::finish_attachment_rollback(
        &service, &catalog, &plan, native, epoch,
    );
    if occupied || added_reference {
        assert_eq!(rolled.status, "partial", "{rolled:?}");
        assert!(rolled
            .issues
            .iter()
            .any(|issue| issue.status.contains("attachment-rollback-pending")));
        if occupied {
            assert_eq!(std::fs::read(&source).unwrap(), b"unrelated occupant");
        } else {
            assert!(!source.exists());
        }
        assert_eq!(std::fs::read(&destination).unwrap(), pixels);
        assert_eq!(
            Path::new(
                &catalog
                    .attachment_details(&asset.id)
                    .unwrap()
                    .absolute_path
                    .unwrap()
            )
            .canonicalize()
            .unwrap(),
            destination.canonicalize().unwrap()
        );
    } else {
        assert_eq!(rolled.status, "rolled-back", "{rolled:?}");
        assert_eq!(std::fs::read(&source).unwrap(), pixels);
        assert!(!destination.exists());
        let refs = catalog
            .note_attachment_refs(&registration.id, "n.md")
            .unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].asset_id, asset.id);
        let link = super::markdown_links::attachment_links(
            &std::fs::read_to_string(root.join("n.md")).unwrap(),
        )
        .remove(0);
        let path = super::external_attachments::external_target_path(
            &root,
            "n.md",
            &link.destination,
            link.syntax,
        )
        .unwrap()
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), pixels);
        let again = service
            .recover_attachment_operation(epoch, &registration.id, &forward.operation_id, true)
            .unwrap();
        let again = crate::attachment_coordination::finish_attachment_rollback(
            &service, &catalog, &plan, again, epoch,
        );
        assert_eq!(again.status, "rolled-back", "{again:?}");
    }
}
#[test]
fn projection_source_move_rollback_restores_physical_file_and_refs() {
    rollback_source_fixture(false, false);
}
#[test]
fn projection_source_move_rollback_conflict_retains_both_files_and_partial_receipt() {
    rollback_source_fixture(true, false);
}

#[test]
fn projection_source_move_rollback_protects_newly_added_reference() {
    rollback_source_fixture(false, true);
}


#[test]
fn projection_material_detail_insert_preserves_markdown_block_boundaries() {
    use base64::Engine;
    let (service, root, registration) = fixture("material-block-boundary");
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let source = root.parent().unwrap().join("picture.png");
    std::fs::write(&source, base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=").unwrap()).unwrap();
    let asset = catalog.import_paths(&[source], &crate::materials::MaterialImportOptions { storage_mode: "source".into(), ..Default::default() }).unwrap().value.assets.remove(0);
    let epoch = service.activate_ui_source(&registration.id).unwrap().source_epoch;
    let session = service.begin_current_context_session(epoch, "block-test").unwrap();
    for (index, (content, offset, before, after)) in [
        ("# Heading", 0, "", "\n\n# Heading"),
        ("left right", 5, "left \n\n", "\n\nright"),
        ("left\n\nright", 6, "left\n\n", "\n\nright"),
        ("😀后文", 2, "😀\n\n", "\n\n后文"),
        ("left\r\nright", 6, "left\r\n\r\n", "\r\n\r\nright"),
    ].into_iter().enumerate() {
        std::fs::write(root.join("n.md"), content).unwrap();
        let note = KnowledgeDocumentRef { vault_id: registration.id.clone(), relative_path: "n.md".into() };
        let snapshot = service.read_document(&note).unwrap();
        service.set_current_context(&KnowledgeCurrentContextInput { source_epoch: epoch, session_id: session.session_id.clone(), session_epoch: session.session_epoch, generation: index as u64 + 1, document_ref: note, cursor_offset: Some(offset), selection: None, expected_revision: Some(snapshot.revision) }).unwrap();
        let result = crate::insert_material_current_with_services(&service, &catalog, &asset.id, epoch).unwrap();
        let saved = std::fs::read_to_string(root.join("n.md")).unwrap();
        assert!(saved.starts_with(before) && saved.ends_with(after), "{saved:?}");
        let links = super::markdown_links::attachment_links(&saved);
        assert_eq!(links.len(), 1);
        assert!(saved[before.len()..saved.len()-after.len()].starts_with("![picture.png]"), "{saved:?}");
        assert!(!result.index_stale);
    }
}
