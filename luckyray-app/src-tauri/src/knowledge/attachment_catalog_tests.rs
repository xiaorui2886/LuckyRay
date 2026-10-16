//! Production service composition; all files are isolated synthetic fixtures.
use super::attachment_tests::fixture;
use super::*;
use crate::attachment_coordination::{finish_attachment_projection, sync_note_attachment_index};
use crate::materials::{
    MaterialCatalog, MaterialFilter, MaterialImportOptions, MaterialQueryScope,
};
use base64::Engine;

fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=").unwrap()
}
fn setup(
    label: &str,
) -> (
    KnowledgeService,
    PathBuf,
    MaterialCatalog,
    KnowledgeDocumentRef,
    u64,
) {
    let (service, root, registration) = fixture(label);
    std::fs::write(root.join("note.md"), "start\n").unwrap();
    let active = service.activate_ui_source(&registration.id).unwrap();
    let catalog = MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    (
        service,
        root,
        catalog,
        KnowledgeDocumentRef {
            vault_id: registration.id,
            relative_path: "note.md".into(),
        },
        active.source_epoch,
    )
}
fn publish(
    service: &KnowledgeService,
    catalog: &MaterialCatalog,
    doc: &KnowledgeDocumentRef,
    epoch: u64,
    path: Option<&Path>,
    id: Option<&str>,
    bytes: Option<Vec<u8>>,
) -> AttachmentPublication {
    crate::publish_attachment_with_services(
        service,
        catalog,
        crate::KnowledgePublishAttachmentInput {
            document_ref: doc.clone(),
            source_epoch: epoch,
            expected_revision: service.read_document(doc).unwrap().revision,
            name: "原图 中文.png".into(),
            bytes,
            source_path: path.map(|p| p.to_string_lossy().into_owned()),
            material_id: id.map(str::to_owned),
            handling_policy: None,
        },
    )
    .unwrap()
}
fn save(
    service: &KnowledgeService,
    catalog: &MaterialCatalog,
    doc: &KnowledgeDocumentRef,
    epoch: u64,
    text: String,
) {
    service
        .replace_document_from_ui(
            epoch,
            &KnowledgeWriteInput {
                document_ref: doc.clone(),
                content: text,
                expected_revision: Some(service.read_document(doc).unwrap().revision),
            },
        )
        .unwrap();
    sync_note_attachment_index(service, catalog, doc).unwrap();
}
fn collection(
    catalog: &MaterialCatalog,
    doc: &KnowledgeDocumentRef,
) -> Vec<crate::materials::MaterialAsset> {
    catalog
        .list_assets_scoped(
            &MaterialFilter::default(),
            &MaterialQueryScope {
                scope: "note-attachments".into(),
                vault_id: Some(doc.vault_id.clone()),
                include_unreferenced: false,
            },
        )
        .unwrap()
}
fn assert_saved_bytes(
    service: &KnowledgeService,
    catalog: &MaterialCatalog,
    doc: &KnowledgeDocumentRef,
    expected: &Path,
) {
    let allowed = catalog
        .approved_vault_attachment_paths(&doc.vault_id)
        .unwrap();
    let paths = service.document_attachment_paths(doc, &allowed).unwrap();
    assert_eq!(paths.len(), 1);
    assert_eq!(
        std::fs::canonicalize(&paths[0].1).unwrap(),
        expected.canonicalize().unwrap()
    );
    assert_eq!(
        std::fs::read(&paths[0].1).unwrap(),
        std::fs::read(expected).unwrap()
    );
}

#[test]
fn attachment_resolution_projects_registered_material_identity_and_preserves_native_version() {
    let (service, root, catalog, doc, epoch) = setup("resolved-material-identity");
    let source = root.parent().unwrap().join("original.png");
    std::fs::write(&source, png()).unwrap();
    let asset = catalog.import_paths(&[source.clone()], &MaterialImportOptions {
        storage_mode: "managed".into(), ..Default::default()
    }).unwrap().value.assets[0].clone();
    let output = publish(&service, &catalog, &doc, epoch, None, Some(&asset.id), None);
    save(&service, &catalog, &doc, epoch, output.markdown);
    let approved = catalog.approved_vault_attachment_paths(&doc.vault_id).unwrap();
    let (target, path) = service.document_attachment_paths(&doc, &approved).unwrap().remove(0);
    let native = service.resolve_attachment_with_approved_paths(&doc, &target, false, &approved).unwrap();
    let result = crate::attachment_coordination::resolve_attachment_with_material_identity(
        &service, &catalog, &doc, &target, false,
    ).unwrap();
    assert_eq!(result.status, "resolved");
    assert_eq!(result.material_asset_id, Some(asset.id));
    assert_eq!(result.absolute_path.as_deref(), Some(path.as_str()));
    assert_eq!(result.version, native.version);
    assert!(result.version.is_some());
    assert_eq!(serde_json::to_value(&result).unwrap()["materialAssetId"], result.material_asset_id.unwrap());

    std::fs::write(root.join("local.png"), png()).unwrap();
    let local = crate::attachment_coordination::resolve_attachment_with_material_identity(
        &service, &catalog, &doc, "local.png", false,
    ).unwrap();
    assert_eq!(local.status, "resolved");
    assert_eq!(local.material_asset_id, None);
    let unknown = crate::attachment_coordination::resolve_attachment_with_material_identity(
        &service, &catalog, &doc, url::Url::from_file_path(&source).unwrap().as_str(), false,
    ).unwrap();
    assert_ne!(unknown.status, "resolved");
    assert_eq!(unknown.material_asset_id, None);
}

#[test]
fn publication_three_material_modes_use_real_current_path_without_copy() {
    for mode in ["linked", "managed", "source"] {
        let (service, root, catalog, doc, epoch) = setup(&format!("catalog-{mode}"));
        let source = root.parent().unwrap().join("原图 空格.png");
        std::fs::write(&source, png()).unwrap();
        let material = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: mode.into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets[0]
            .clone();
        let real = if mode == "linked" {
            source.clone()
        } else {
            PathBuf::from(material.library_path.as_ref().unwrap())
        };
        if mode == "managed" {
            std::fs::write(&source, b"original independently changed").unwrap();
        }
        let output = publish(
            &service,
            &catalog,
            &doc,
            epoch,
            None,
            Some(&material.id),
            None,
        );
        save(&service, &catalog, &doc, epoch, output.markdown);
        assert_saved_bytes(&service, &catalog, &doc, &real);
        assert!(
            !root.join("attachments").exists(),
            "reference publication must not manufacture a Vault copy"
        );
        assert_eq!(collection(&catalog, &doc)[0].id, material.id);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            catalog
                .attachment_details(&material.id)
                .unwrap()
                .reference_count,
            1
        );
    }
}
#[test]
fn dedicated_source_and_clipboard_classification_missing_and_deletion_protection() {
    let (service, root, catalog, doc, epoch) = setup("catalog-dedicated");
    let source = root.parent().unwrap().join("external.png");
    std::fs::write(&source, png()).unwrap();
    let output = publish(&service, &catalog, &doc, epoch, Some(&source), None, None);
    save(&service, &catalog, &doc, epoch, output.markdown.clone());
    let asset = collection(&catalog, &doc)[0].clone();
    assert!(catalog
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
    assert_saved_bytes(&service, &catalog, &doc, &source);
    std::fs::rename(&source, source.with_extension("missing")).unwrap();
    sync_note_attachment_index(&service, &catalog, &doc).unwrap();
    assert_eq!(
        catalog
            .attachment_details(&asset.id)
            .unwrap()
            .reference_count,
        1
    );
    assert_eq!(
        catalog
            .for_vault_attachment_ids(&doc.vault_id, &[asset.id.clone()])
            .unwrap()
            .delete_asset(&asset.id, true)
            .unwrap_err()
            .code,
        "material-in-use-by-notes"
    );
    save(&service, &catalog, &doc, epoch, "reference removed".into());
    assert_eq!(
        catalog
            .attachment_details(&asset.id)
            .unwrap()
            .reference_count,
        0
    );
    let screenshot = publish(&service, &catalog, &doc, epoch, None, None, Some(png()));
    save(&service, &catalog, &doc, epoch, screenshot.markdown);
    let stored = PathBuf::from(
        catalog
            .attachment_details(&collection(&catalog, &doc)[0].id)
            .unwrap()
            .absolute_path
            .unwrap(),
    );
    assert!(stored.starts_with(&root));
    assert_eq!(std::fs::read(&stored).unwrap(), png());
    assert!(catalog
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
}
#[test]
fn relink_projection_keeps_asset_id_and_closed_vault_pending() {
    let (service, root, catalog, doc, epoch) = setup("catalog-relink");
    let source = root.parent().unwrap().join("old.png");
    std::fs::write(&source, png()).unwrap();
    let output = publish(&service, &catalog, &doc, epoch, Some(&source), None, None);
    save(&service, &catalog, &doc, epoch, output.markdown);
    let asset = collection(&catalog, &doc)[0].clone();
    let (other, other_root, other_reg) = fixture("catalog-closed");
    std::fs::write(other_root.join("note.md"), "start").unwrap();
    let other_active = other.activate_ui_source(&other_reg.id).unwrap();
    let other_doc = KnowledgeDocumentRef {
        vault_id: other_reg.id,
        relative_path: "note.md".into(),
    };
    let output = publish(
        &other,
        &catalog,
        &other_doc,
        other_active.source_epoch,
        Some(&source),
        None,
        None,
    );
    save(
        &other,
        &catalog,
        &other_doc,
        other_active.source_epoch,
        output.markdown,
    );
    let closed_before = std::fs::read(other_root.join("note.md")).unwrap();
    assert_eq!(
        catalog
            .attachment_details(&asset.id)
            .unwrap()
            .reference_count,
        2
    );
    // External in-place editing keeps the path/inode but changes the content
    // version; the production scan must refresh Catalog before later recovery.
    let mut edited = png();
    edited.extend_from_slice(b"updated image metadata");
    let original_hash = asset.content_hash.clone();
    std::fs::write(&source, &edited).unwrap();
    sync_note_attachment_index(&service, &catalog, &doc).unwrap();
    let refreshed = catalog.for_attachment_projection().get_assets(&[asset.id.clone()]).unwrap().remove(0);
    assert_ne!(refreshed.content_hash, original_hash);
    assert_eq!(refreshed.size_bytes, Some(edited.len() as i64));
    let replacement = root.parent().unwrap().join("new 中文.png");
    std::fs::rename(&source, &replacement).unwrap();
    let details = catalog.attachment_details(&asset.id).unwrap();
    let refs = details
        .references
        .iter()
        .filter(|r| r.vault_id == doc.vault_id)
        .map(|r| (r.note_path.clone(), r.target.clone()))
        .collect::<Vec<_>>();
    let mut plan = service
        .preview_attachment_relink(&doc.vault_id, &refs, &replacement)
        .unwrap();
    // Same plan enrichment as the production command, with a supplied fixture service.
    for r in details
        .references
        .iter()
        .filter(|r| r.vault_id != doc.vault_id)
    {
        plan.issues.push(AttachmentOperationIssue {
            document: r.note_path.clone(),
            target: r.target.clone(),
            status: "other-vault-pending".into(),
        });
    }
    plan.material_revision = Some(catalog.note_file_revision_for_asset(&refreshed).unwrap());
    plan.material_relocation = Some((
        asset.id.clone(),
        replacement.to_string_lossy().into_owned(),
        serde_json::to_string(&details.references).unwrap(),
    ));
    let result = service.execute_attachment_operation(epoch, &plan).unwrap();
    let result = finish_attachment_projection(&service, &catalog, &plan, result, epoch);
    assert_eq!(result.status, "complete-with-unresolved", "{result:?}");
    let repeated = finish_attachment_projection(&service, &catalog, &plan, result.clone(), epoch);
    assert_eq!(
        repeated.status, result.status,
        "projection recovery must be idempotent: {repeated:?}"
    );
    assert!(result
        .issues
        .iter()
        .any(|i| i.status == "other-vault-pending"));
    assert_eq!(collection(&catalog, &doc)[0].id, asset.id);
    assert_eq!(
        catalog
            .attachment_details(&asset.id)
            .unwrap()
            .reference_count,
        2
    );
    assert_saved_bytes(&service, &catalog, &doc, &replacement);
    assert_eq!(std::fs::read(&replacement).unwrap(), edited);
    assert_eq!(
        std::fs::read(other_root.join("note.md")).unwrap(),
        closed_before
    );
    assert_eq!(
        catalog.for_attachment_projection().get_assets(&[asset.id]).unwrap()[0].storage_mode,
        "linked"
    );
}

#[test]
fn coordinated_source_and_managed_file_move_rewrites_saved_links_and_keeps_identity() {
    for mode in ["source", "managed"] {
        let (service, root, catalog, doc, epoch) = setup(&format!("catalog-move-{mode}"));
        let source = root.parent().unwrap().join("move-original.png");
        std::fs::write(&source, png()).unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: mode.into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets[0]
            .clone();
        let output = publish(&service, &catalog, &doc, epoch, None, Some(&asset.id), None);
        save(&service, &catalog, &doc, epoch, output.markdown);
        let original = PathBuf::from(asset.library_path.as_ref().unwrap());
        let destination = original
            .parent()
            .unwrap()
            .join("move-target")
            .join("已移动 中文.png");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let plan = crate::attachment_file_moves::preview_with_services(
            &service,
            &catalog,
            &doc.vault_id,
            &asset.id,
            &destination,
        )
        .unwrap();
        assert!(original.exists());
        assert!(!destination.exists());
        let saved = service.execute_attachment_operation(epoch, &plan).unwrap();
        assert!(
            original.exists(),
            "notes-first receipt does not prematurely remove the original"
        );
        let result = finish_attachment_projection(&service, &catalog, &plan, saved, epoch);
        assert_eq!(result.status, "complete", "{result:?}");
        assert!(!original.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), png());
        assert_saved_bytes(&service, &catalog, &doc, &destination);
        let final_asset = catalog.for_attachment_projection().get_assets(&[asset.id.clone()]).unwrap().remove(0);
        assert_eq!(final_asset.id, asset.id);
        assert_eq!(final_asset.storage_mode, mode);
        assert_eq!(
            catalog
                .attachment_details(&asset.id)
                .unwrap()
                .reference_count,
            1
        );
        assert_eq!(
            finish_attachment_projection(&service, &catalog, &plan, result.clone(), epoch).status,
            "complete"
        );
        let movement = plan.material_file_move.as_ref().unwrap();
        let new_doc = KnowledgeDocumentRef {
            vault_id: doc.vault_id.clone(),
            relative_path: "new.md".into(),
        };
        std::fs::write(root.join("new.md"), "start").unwrap();
        let new_link = publish(
            &service,
            &catalog,
            &new_doc,
            epoch,
            None,
            Some(&asset.id),
            None,
        );
        save(&service, &catalog, &new_doc, epoch, new_link.markdown);
        assert!(
            crate::attachment_file_moves::rollback_file_move(&catalog, movement).is_err(),
            "later note references must block reverse movement"
        );
        assert!(destination.exists());
        assert!(!original.exists());
        std::fs::remove_file(root.join("new.md")).unwrap();
        let version = catalog.read_change().unwrap().version;
        catalog
            .prune_note_attachment_refs(&doc.vault_id, &["note.md".into()], version)
            .unwrap();

        std::fs::write(&original, b"rollback destination conflict").unwrap();
        assert!(crate::attachment_file_moves::rollback_file_move(&catalog, movement).is_err());
        assert_eq!(
            std::fs::read(&original).unwrap(),
            b"rollback destination conflict"
        );
        assert_eq!(std::fs::read(&destination).unwrap(), png());
        std::fs::remove_file(&original).unwrap(); // synthetic conflict only
        service
            .recover_attachment_operation(epoch, &doc.vault_id, &result.operation_id, true)
            .unwrap();
        crate::attachment_file_moves::rollback_file_move(&catalog, movement).unwrap();
        sync_note_attachment_index(&service, &catalog, &doc).unwrap();
        assert!(!destination.exists());
        assert_eq!(std::fs::read(&original).unwrap(), png());
        assert_saved_bytes(&service, &catalog, &doc, &original);
        crate::attachment_file_moves::rollback_file_move(&catalog, movement).unwrap();
    }
}

#[test]
fn coordinated_file_move_destination_conflict_is_durable_and_recoverable() {
    let (service, root, catalog, doc, epoch) = setup("catalog-move-conflict");
    let source = root.parent().unwrap().join("source.png");
    std::fs::write(&source, png()).unwrap();
    let asset = catalog
        .import_paths(
            &[source.clone()],
            &MaterialImportOptions {
                storage_mode: "source".into(),
                ..Default::default()
            },
        )
        .unwrap()
        .value
        .assets[0]
        .clone();
    let output = publish(&service, &catalog, &doc, epoch, None, Some(&asset.id), None);
    save(&service, &catalog, &doc, epoch, output.markdown);
    let destination = root.parent().unwrap().join("destination.png");
    let plan = crate::attachment_file_moves::preview_with_services(
        &service,
        &catalog,
        &doc.vault_id,
        &asset.id,
        &destination,
    )
    .unwrap();
    // Another file arrives after preview: it must never be overwritten.
    std::fs::write(&destination, b"unrelated target").unwrap();
    let saved = service.execute_attachment_operation(epoch, &plan).unwrap();
    let result = finish_attachment_projection(&service, &catalog, &plan, saved, epoch);
    assert_eq!(result.status, "partial");
    assert_eq!(std::fs::read(&source).unwrap(), png());
    assert_eq!(std::fs::read(&destination).unwrap(), b"unrelated target");
    assert_eq!(
        catalog
            .attachment_details(&asset.id)
            .unwrap()
            .reference_count,
        1
    );
    assert!(service
        .list_attachment_operations(&doc.vault_id)
        .unwrap()
        .contains(&result.operation_id));
    let directory = root.join(".luckyray/attachment-operations");
    assert!(std::fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".result.json"))
        .any(|e| {
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(e.path()).unwrap()).unwrap();
            value["operationId"] == result.operation_id && value["status"] == "partial"
        }));
    std::fs::remove_file(&destination).unwrap(); // only the synthetic conflict fixture
    let resumed = service
        .recover_attachment_operation(epoch, &doc.vault_id, &result.operation_id, false)
        .unwrap();
    let resumed = finish_attachment_projection(&service, &catalog, &plan, resumed, epoch);
    assert_eq!(resumed.status, "complete", "{resumed:?}");
    assert!(!source.exists());
    assert_eq!(std::fs::read(&destination).unwrap(), png());
    assert_saved_bytes(&service, &catalog, &doc, &destination);
}
