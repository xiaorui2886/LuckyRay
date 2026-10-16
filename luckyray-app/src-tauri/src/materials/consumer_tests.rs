use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
#[test]
fn consumer_published_fixture_png_passes_real_catalog_decoder() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/materialLibraryConsumer.v1.json"
    ))
    .unwrap();
    let (base, id, _) = fixture();
    let catalog = base.for_library(&id).unwrap();
    let folder = catalog
        .create_folder(MaterialFolderInput {
            name: "网页截图".into(),
            parent_id: None,
        })
        .unwrap()
        .value;
    let mut input: ConsumerBytesInput =
        serde_json::from_value(golden["importRequest"].clone()).unwrap();
    input.library_id = id.clone();
    input.target_folder_id = Some(folder.id.clone());
    let result = MaterialConsumer::new(base.clone(), authorization(&id))
        .import_bytes(&input)
        .unwrap();
    assert_eq!(result["asset"]["folderId"], folder.id);
    assert_eq!(result["asset"]["kind"], "image");
    assert_eq!(result["asset"]["storageMode"], "managed");
    assert_eq!(catalog.list_assets(&Default::default()).unwrap().len(), 1);
    assert!(base.list_assets(&Default::default()).unwrap().is_empty());
}
fn fixture() -> (MaterialCatalog, String, String) {
    let base = MaterialCatalog::new_for_test();
    std::fs::create_dir(base.app_data_dir().join("consumer-target")).unwrap();
    std::fs::create_dir(base.app_data_dir().join("consumer-other")).unwrap();
    let id = base
        .create_library(
            "截图目标",
            &base.app_data_dir().join("consumer-target"),
            "managed",
        )
        .unwrap()
        .id;
    let other = base
        .create_library(
            "其他库",
            &base.app_data_dir().join("consumer-other"),
            "managed",
        )
        .unwrap()
        .id;
    (base, id, other)
}
fn rights() -> ConsumerPermissions {
    ConsumerPermissions {
        read: true,
        organize: true,
        import: true,
        files: false,
    }
}
#[test]
fn consumer_ingest_only_cannot_read_duplicate_metadata_or_organize_existing_folder() {
    let (base, id, _) = fixture();
    let allowed = MaterialConsumer::new(base.clone(), authorization(&id));
    let input = capture(&id);
    allowed.import_bytes(&input).unwrap();
    let mut auth = authorization(&id);
    auth.libraries.get_mut(&id).unwrap().read = false;
    let importer = MaterialConsumer::new(base.clone(), auth);
    assert_eq!(
        importer.authorize_import(&target(&id)).unwrap_err().code,
        "consumer-library-denied"
    );
    assert_eq!(
        importer.import_bytes(&input).unwrap_err().code,
        "consumer-library-denied"
    );
    let scoped = base.for_library(&id).unwrap();
    let folder = scoped
        .create_folder(MaterialFolderInput {
            name: "已有分类".into(),
            parent_id: None,
        })
        .unwrap()
        .value;
    let mut auth = authorization(&id);
    auth.libraries.get_mut(&id).unwrap().organize = false;
    let importer = MaterialConsumer::new(base, auth);
    let mut classified = input;
    classified.target_folder_id = Some(folder.id);
    classified.bytes_base64 = STANDARD.encode(b"# Another capture");
    assert_eq!(
        importer.import_bytes(&classified).unwrap_err().code,
        "consumer-library-denied"
    );
    assert_eq!(scoped.list_assets(&Default::default()).unwrap().len(), 1);
}
fn authorization(id: &str) -> ConsumerAuthorization {
    ConsumerAuthorization {
        enumerate: true,
        libraries: BTreeMap::from([(id.to_owned(), rights())]),
        ..Default::default()
    }
}
fn target(id: &str) -> ConsumerTarget {
    ConsumerTarget {
        library_id: id.into(),
        request_id: "popup:test-1".into(),
    }
}
fn capture(id: &str) -> ConsumerBytesInput {
    ConsumerBytesInput {
        library_id: id.into(),
        request_id: "popup:test-1".into(),
        name: "正文.md".into(),
        mime_type: "text/markdown".into(),
        bytes_base64: STANDARD.encode(b"# Collector article"),
        target_folder_id: None,
        new_folder_name: None,
        tag_ids: vec![],
        tag_names: vec![],
        description: None,
        source_page_url: Some("https://example.test/article".into()),
        source_page_title: Some("文章".into()),
        source_page_kind: Some("capture-page".into()),
    }
}
#[test]
fn consumer_registry_is_not_read_or_file_authorization_and_legacy_never_expands() {
    let (base, id, other) = fixture();
    base.select_library(&id).unwrap();
    let service = MaterialConsumer::new(
        base.clone(),
        ConsumerAuthorization {
            enumerate: true,
            legacy: rights(),
            ..Default::default()
        },
    );
    let registry = service.libraries().unwrap();
    assert_eq!(registry["libraries"].as_array().unwrap().len(), 3);
    assert!(registry.to_string().find("rootPath").is_none());
    assert_eq!(
        service.taxonomy(&target(&id)).unwrap_err().code,
        "consumer-library-denied"
    );
    assert_eq!(
        service.import_bytes(&capture(&other)).unwrap_err().code,
        "consumer-library-denied"
    );
    let legacy = base.library_state().unwrap().0;
    assert!(service.taxonomy(&target(&legacy)).is_ok());
    assert_eq!(
        service
            .original(&target(&legacy), "missing")
            .unwrap_err()
            .code,
        "consumer-library-denied"
    );
}
#[test]
fn consumer_capture_taxonomy_and_retry_preserve_exact_target_and_manual_information() {
    let (base, id, other) = fixture();
    let service = MaterialConsumer::new(base.clone(), authorization(&id));
    let folder = base
        .for_library(&id)
        .unwrap()
        .create_folder(MaterialFolderInput {
            parent_id: None,
            name: "文章分类".into(),
        })
        .unwrap()
        .value;
    let mut input = capture(&id);
    input.target_folder_id = Some(folder.id.clone());
    input.tag_names = vec!["收集".into()];
    base.select_library(&other).unwrap();
    let result = service.import_bytes(&input).unwrap();
    assert_eq!(result["libraryId"], id);
    assert_eq!(result["disposition"], "imported");
    assert_eq!(result["asset"]["folderId"], folder.id);
    assert_eq!(result["asset"]["tagIds"].as_array().unwrap().len(), 1);
    assert!(result.to_string().find("libraryPath").is_none());
    let before = service.taxonomy(&target(&id)).unwrap();
    input.name = "不同名称.md".into();
    input.new_folder_name = Some("不能新增的空分类".into());
    input.tag_names = vec!["不能新增的标签".into()];
    let duplicate = service.import_bytes(&input).unwrap();
    assert_eq!(duplicate["disposition"], "duplicate");
    assert_eq!(duplicate["assetId"], result["assetId"]);
    assert_eq!(duplicate["asset"]["name"], "正文.md");
    assert_eq!(
        service.taxonomy(&target(&id)).unwrap()["folders"],
        before["folders"]
    );
    assert_eq!(
        service.taxonomy(&target(&id)).unwrap()["tags"],
        before["tags"]
    );
    assert!(base
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
    assert!(base
        .for_library(&other)
        .unwrap()
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
    base.select_library(&id).unwrap();
    base.select_library(&other).unwrap();
    base.select_library(&id).unwrap();
    assert_eq!(
        service
            .detail(&target(&id), result["assetId"].as_str().unwrap())
            .unwrap()["asset"]["id"],
        result["assetId"]
    );
}
#[test]
fn consumer_foreign_folder_and_tag_fail_before_any_write() {
    let (base, id, other) = fixture();
    let service = MaterialConsumer::new(base.clone(), authorization(&id));
    let foreign = base.for_library(&other).unwrap();
    let folder = foreign
        .create_folder(MaterialFolderInput {
            parent_id: None,
            name: "私有分类".into(),
        })
        .unwrap()
        .value;
    let tag = foreign.create_tag("私有标签", None).unwrap().value;
    let mut input = capture(&id);
    input.target_folder_id = Some(folder.id);
    input.new_folder_name = Some("不得创建".into());
    assert_eq!(
        service.import_bytes(&input).unwrap_err().code,
        "consumer-folder-denied"
    );
    input.target_folder_id = None;
    input.tag_ids = vec![tag.id];
    assert_eq!(
        service.import_bytes(&input).unwrap_err().code,
        "consumer-tag-denied"
    );
    let scoped = base.for_library(&id).unwrap();
    assert!(scoped
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
    assert!(scoped.list_folders().unwrap().is_empty());
    assert!(scoped.list_tags().unwrap().is_empty());
}
#[test]
fn consumer_removed_offline_and_wrong_library_reads_fail_closed() {
    let (base, id, other) = fixture();
    let service = MaterialConsumer::new(base.clone(), authorization(&id));
    let asset = service.import_bytes(&capture(&id)).unwrap()["assetId"]
        .as_str()
        .unwrap()
        .to_owned();
    let wrong = MaterialConsumer::new(base.clone(), authorization(&other));
    assert_eq!(
        wrong.detail(&target(&other), &asset).unwrap_err().code,
        "material-library-scope"
    );
    base.set_library_visible(&id, false).unwrap();
    assert_eq!(
        service.taxonomy(&target(&id)).unwrap_err().code,
        "library-unavailable"
    );
    base.set_library_visible(&id, true).unwrap();
    let root = base.app_data_dir().join("consumer-target");
    std::fs::rename(&root, root.with_extension("offline")).unwrap();
    assert_eq!(
        service.import_bytes(&capture(&id)).unwrap_err().code,
        "library-unavailable"
    );
    assert_eq!(
        service.libraries().unwrap()["libraries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["libraryId"] == id)
            .unwrap()["state"],
        "offline"
    );
    assert!(!root.exists());
}
#[test]
fn consumer_png_rejects_corruption_mime_mismatch_and_unsafe_names() {
    let (base, id, _) = fixture();
    let service = MaterialConsumer::new(base, authorization(&id));
    let mut input = capture(&id);
    input.mime_type = "image/png".into();
    input.name = "截图.png".into();
    input.bytes_base64 = STANDARD.encode(b"not-png");
    assert_eq!(
        service.import_bytes(&input).unwrap_err().code,
        "consumer-input-invalid"
    );
    input = capture(&id);
    input.name = "../escape.md".into();
    assert_eq!(
        service.import_bytes(&input).unwrap_err().code,
        "consumer-input-invalid"
    );
    input = capture(&id);
    input.mime_type = "image/svg+xml".into();
    assert_eq!(
        service.import_bytes(&input).unwrap_err().code,
        "consumer-input-invalid"
    );
}

#[test]
fn consumer_late_revocation_gate_prevents_folder_tag_file_and_asset_writes() {
    let (base, id, _) = fixture();
    let service = MaterialConsumer::new(base.clone(), authorization(&id));
    let mut input = capture(&id);
    input.new_folder_name = Some("撤销后不得创建".into());
    input.tag_names = vec!["不得创建".into()];
    let error = service
        .import_bytes_checked(&input, || {
            Err::<(), _>(MaterialError::new("consumer-library-denied", "revoked"))
        })
        .unwrap_err();
    assert_eq!(error.code, "consumer-library-denied");
    let scoped = base.for_library(&id).unwrap();
    assert!(scoped
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
    assert!(scoped.list_folders().unwrap().is_empty());
    assert!(scoped.list_tags().unwrap().is_empty());
    assert!(!base.app_data_dir().join("consumer-target/assets").exists());
}
#[test]
fn consumer_private_vault_projection_is_absent_even_with_library_file_grant() {
    let (base, id, _) = fixture();
    let path = base.app_data_dir().join("private-note.png");
    std::fs::write(&path, b"private note").unwrap();
    let private = base
        .register_note_attachment(&path, "vault-private", None)
        .unwrap();
    let mut auth = authorization(&id);
    auth.libraries.get_mut(&id).unwrap().files = true;
    let service = MaterialConsumer::new(base, auth);
    assert!(service
        .list(&target(&id), &MaterialFilter::default())
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(service.detail(&target(&id), &private.id).is_err());
    assert!(service.original(&target(&id), &private.id).is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"private note");
}
#[test]
fn consumer_png_true_bytes_round_trip_inside_selected_library() {
    let (base, id, other) = fixture();
    let service = MaterialConsumer::new(base.clone(), authorization(&id));
    let mut png = std::io::Cursor::new(vec![]);
    image::DynamicImage::new_rgba8(3, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let mut input = capture(&id);
    input.name = "屏幕截图.png".into();
    input.mime_type = "image/png".into();
    input.bytes_base64 = STANDARD.encode(png.get_ref());
    let result = service.import_bytes(&input).unwrap();
    let asset = base
        .for_library(&id)
        .unwrap()
        .get_assets(&[result["assetId"].as_str().unwrap().into()])
        .unwrap()
        .remove(0);
    assert_eq!(
        std::fs::read(asset.library_path.unwrap()).unwrap(),
        *png.get_ref()
    );
    assert!(base
        .for_library(&other)
        .unwrap()
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
}

#[test]
fn consumer_service_grant_adapter_never_interprets_catalog_as_all_libraries() {
    let (base, id, _) = fixture();
    let legacy = ConsumerAuthorization::from_service_grants(&base, true, |class, scope, key| {
        Ok(class == "content.read" && scope == "catalog" && key.is_empty())
    })
    .unwrap();
    let service = MaterialConsumer::new(base.clone(), legacy);
    assert_eq!(
        service.taxonomy(&target(&id)).unwrap_err().code,
        "consumer-library-denied"
    );
    assert!(service
        .taxonomy(&target(&base.library_state().unwrap().0))
        .is_ok());
    let explicit = ConsumerAuthorization::from_service_grants(&base, true, |class, scope, key| {
        Ok(class == "content.read" && scope == "material-library" && key == id)
    })
    .unwrap();
    let explicit = MaterialConsumer::new(base, explicit);
    assert!(explicit.taxonomy(&target(&id)).is_ok());
    assert_eq!(
        explicit.import_bytes(&capture(&id)).unwrap_err().code,
        "consumer-library-denied"
    );
}
#[test]
fn consumer_concurrent_duplicate_adapter_preserves_the_winning_organization() {
    let (base, id, _) = fixture();
    let scoped = base.for_library(&id).unwrap();
    let a = scoped
        .create_folder(MaterialFolderInput {
            parent_id: None,
            name: "A".into(),
        })
        .unwrap()
        .value;
    let b = scoped
        .create_folder(MaterialFolderInput {
            parent_id: None,
            name: "B".into(),
        })
        .unwrap()
        .value;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let start = |folder: String, barrier: std::sync::Arc<std::sync::Barrier>| {
        let catalog = scoped.clone().with_test_import_barrier(barrier);
        std::thread::spawn(move || {
            import_consumer_material_with_source(
                &catalog,
                MaterialBytesInput {
                    name: "concurrent.md".into(),
                    original_path: "browser:concurrent".into(),
                    mime_type: "text/markdown".into(),
                    bytes: b"# Concurrent same bytes".to_vec(),
                    description: None,
                },
                &MaterialImportOptions {
                    folder_id: Some(folder),
                    ..Default::default()
                },
                None,
            )
            .unwrap()
        })
    };
    let first = start(a.id, barrier.clone());
    let second = start(b.id, barrier);
    let first = first.join().unwrap();
    let second = second.join().unwrap();
    assert_eq!(first.asset.id, second.asset.id);
    assert_ne!(first.skipped_duplicate, second.skipped_duplicate);
    assert_eq!(first.asset.folder_id, second.asset.folder_id);
    assert_eq!(
        scoped
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn consumer_verified_adapter_receipts_replay_restart_conflict_revoke_and_interruption() {
    use crate::{backend::BackendServices, local_transport::VerifiedTransportPrincipal};
    let profile = tempfile::tempdir().unwrap();
    let backend = BackendServices::initialize(profile.path()).unwrap();
    let base = backend.material_catalog();
    let root = profile.path().join("A");
    std::fs::create_dir(&root).unwrap();
    let id = base.create_library("A", &root, "managed").unwrap().id;
    let other_root = profile.path().join("B");
    std::fs::create_dir(&other_root).unwrap();
    let other = base.create_library("B", &other_root, "managed").unwrap().id;
    let principal = VerifiedTransportPrincipal::capture_test_principal();
    let path = "/api/material-libraries/import-bytes";
    let input = capture(&id);
    let body = serde_json::to_string(&input).unwrap();
    let mut auth = authorization(&id);
    auth.libraries.insert(other.clone(), rights());
    base.select_library(&other).unwrap();
    let first = super::super::consumer_transport::route(
        &backend,
        &principal,
        auth.clone(),
        "POST",
        path,
        Some(&body),
        |target| {
            assert_eq!(target.library_id, id);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(first.status, 200);
    let result: Value = serde_json::from_str(&first.body).unwrap();
    assert_eq!(result["libraryId"], id);
    drop(base);
    drop(backend);
    let backend = BackendServices::initialize(profile.path()).unwrap();
    let replay = super::super::consumer_transport::route(
        &backend,
        &principal,
        auth.clone(),
        "POST",
        path,
        Some(&body),
        |_| -> MaterialResult<()> { panic!("completed receipt must not reexecute") },
    )
    .unwrap();
    assert_eq!(replay.body, first.body);
    let mut changed = input.clone();
    changed.library_id = other.clone();
    let changed = serde_json::to_string(&changed).unwrap();
    let conflict = super::super::consumer_transport::route(
        &backend,
        &principal,
        auth.clone(),
        "POST",
        path,
        Some(&changed),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(conflict.status, 409);
    assert!(conflict.body.contains("request-id-conflict"));
    assert!(backend
        .material_catalog()
        .for_library(&other)
        .unwrap()
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
    let revoke = super::super::consumer_transport::route(
        &backend,
        &principal,
        Default::default(),
        "POST",
        path,
        Some(&body),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(revoke.status, 403);
    backend
        .material_catalog()
        .set_library_visible(&id, false)
        .unwrap();
    let hidden = super::super::consumer_transport::route(
        &backend,
        &principal,
        auth.clone(),
        "POST",
        path,
        Some(&body),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(hidden.status, 409);
    backend
        .material_catalog()
        .set_library_visible(&id, true)
        .unwrap();
    let key = principal.capture_request_key(&format!("{path}:{}", input.request_id));
    std::fs::remove_file(
        profile
            .path()
            .join("note-capture-receipts")
            .join(format!("{key}.result")),
    )
    .unwrap();
    let interrupted = super::super::consumer_transport::route(
        &backend,
        &principal,
        auth,
        "POST",
        path,
        Some(&body),
        |_| -> MaterialResult<()> { panic!("interrupted receipt must not reexecute") },
    )
    .unwrap();
    assert_eq!(interrupted.status, 409);
    assert!(interrupted.body.contains("capture-commit-uncertain"));
    assert_eq!(
        backend
            .material_catalog()
            .for_library(&id)
            .unwrap()
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn consumer_verified_adapter_wrong_method_unknown_fields_and_ungranted_queries_fail_closed() {
    use crate::{backend::BackendServices, local_transport::VerifiedTransportPrincipal};
    let profile = tempfile::tempdir().unwrap();
    let backend = BackendServices::initialize(profile.path()).unwrap();
    let principal = VerifiedTransportPrincipal::capture_test_principal();
    let id = backend.material_catalog().library_state().unwrap().0;
    let auth = authorization(&id);
    let wrong = super::super::consumer_transport::route(
        &backend,
        &principal,
        auth.clone(),
        "POST",
        "/api/material-libraries",
        None,
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(wrong.status, 405);
    let malformed = super::super::consumer_transport::route(
        &backend,
        &principal,
        auth,
        "POST",
        "/api/material-libraries/taxonomy",
        Some(&json!({"libraryId":id,"requestId":"x","grants":["files"]}).to_string()),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(malformed.status, 400);
    let denied = super::super::consumer_transport::route(
        &backend,
        &principal,
        Default::default(),
        "POST",
        "/api/material-libraries/query",
        Some(&json!({"libraryId":id,"requestId":"x"}).to_string()),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(denied.status, 403);
}
