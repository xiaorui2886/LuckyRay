use sha2::{Digest, Sha256};
#[cfg(test)]
use super::MaterialFilter;

use super::{
    CatalogOutcome, MaterialAsset, MaterialBytesInput, MaterialCatalog, MaterialChange,
    MaterialError, MaterialImportOptions, MaterialImportResult, MaterialResult,
    MaterialSourcePageInput, MaterialStagedFileInput,
};

#[derive(Debug)]
pub(crate) struct ResolvedMaterialImport {
    pub asset: MaterialAsset,
    pub skipped_duplicate: bool,
    pub change: Option<MaterialChange>,
}

pub(crate) fn canonical_import_response(imported: &ResolvedMaterialImport) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "disposition": if imported.skipped_duplicate { "duplicate" } else { "imported" },
        "asset": &imported.asset,
        "assetId": &imported.asset.id,
        "assetName": &imported.asset.name,
        "folderId": &imported.asset.folder_id,
        "sizeBytes": imported.asset.size_bytes,
        "kind": &imported.asset.kind,
        "skippedDuplicate": imported.skipped_duplicate,
        "changed": imported.change.is_some(),
        "importedCount": if imported.skipped_duplicate { 0 } else { 1 },
        "skippedDuplicateCount": if imported.skipped_duplicate { 1 } else { 0 },
        "failedCount": 0,
    })
}

/// Tauri's byte-import Adapter. Keeping this seam separate from the HTTP
/// download Adapter makes parity executable while both still share Catalog.
pub(crate) fn import_tauri_material_bytes(
    catalog: &MaterialCatalog,
    items: Vec<MaterialBytesInput>,
    options: &MaterialImportOptions,
) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
    catalog.import_bytes(items, options)
}

/// Shared post-download adapter seam. Network IO stays in Tauri/HTTP adapters;
/// bytes, managed dedupe, persistence and duplicate resolution stay identical.
pub(crate) fn import_downloaded_material(
    catalog: &MaterialCatalog,
    input: MaterialBytesInput,
    options: &MaterialImportOptions,
) -> MaterialResult<ResolvedMaterialImport> {
    import_downloaded_material_with_source(catalog, input, options, None)
}

pub(crate) fn import_downloaded_material_with_source(
    catalog: &MaterialCatalog,
    input: MaterialBytesInput,
    options: &MaterialImportOptions,
    source_page: Option<&MaterialSourcePageInput>,
) -> MaterialResult<ResolvedMaterialImport> {
    let content_hash = format!("{:x}", Sha256::digest(&input.bytes));
    let CatalogOutcome { value, change } = catalog.import_bytes_with_source(vec![input], options, source_page)?;
    let skipped_duplicate = value.skipped_duplicate_count > 0;
    let asset = if let Some(asset) = value.assets.into_iter().next() {
        asset
    } else {
        catalog
            .find_managed_asset_by_hash(&content_hash)?
            .ok_or_else(|| {
                value.failed_items.into_iter().next().map_or_else(
                    || MaterialError::new("missing-import-result", "导入结果缺少对应素材记录"),
                    |failure| MaterialError::new(failure.code, failure.error),
                )
            })?
    };
    Ok(ResolvedMaterialImport {
        asset,
        skipped_duplicate,
        change,
    })
}

/// Same Catalog byte import, with a duplicate policy fixed to keep the
/// target's manual information. Legacy download behavior stays unchanged.
pub(super) fn import_consumer_material_with_source(
    catalog: &MaterialCatalog, input: MaterialBytesInput, options: &MaterialImportOptions,
    source_page: Option<&MaterialSourcePageInput>,
) -> MaterialResult<ResolvedMaterialImport> {
    let hash = format!("{:x}", Sha256::digest(&input.bytes));
    let CatalogOutcome { value, change } = catalog.import_consumer_bytes_with_source(vec![input], options, source_page)?;
    let duplicate = value.skipped_duplicate_count > 0;
    let asset = if let Some(asset) = value.assets.into_iter().next() { asset } else {
        catalog.find_managed_asset_by_hash(&hash)?.ok_or_else(|| value.failed_items.into_iter().next()
            .map(|failure| MaterialError::new(failure.code,failure.error))
            .unwrap_or_else(|| MaterialError::new("missing-import-result","导入结果缺少素材")))?
    };
    Ok(ResolvedMaterialImport { asset, skipped_duplicate:duplicate, change })
}

/// Streaming counterpart to the legacy byte adapter. The path can only be
/// minted by `MediaTransferService`; catalog validation still treats it as
/// untrusted until it resolves to a regular direct child of the app staging
/// directory.
pub(crate) fn import_staged_download(
    catalog: &MaterialCatalog,
    input: MaterialStagedFileInput,
    options: &MaterialImportOptions,
) -> MaterialResult<ResolvedMaterialImport> {
    import_staged_download_with_source(catalog, input, options, None)
}

pub(crate) fn import_staged_download_with_source(
    catalog: &MaterialCatalog,
    input: MaterialStagedFileInput,
    options: &MaterialImportOptions,
    source_page: Option<&MaterialSourcePageInput>,
) -> MaterialResult<ResolvedMaterialImport> {
    import_staged_download_with_source_checked(catalog, input, options, source_page, || Ok(()))
}

pub(crate) fn import_staged_download_with_source_checked<G>(
    catalog: &MaterialCatalog,
    input: MaterialStagedFileInput,
    options: &MaterialImportOptions,
    source_page: Option<&MaterialSourcePageInput>,
    before_commit: impl FnOnce() -> MaterialResult<G>,
) -> MaterialResult<ResolvedMaterialImport> {
    let expected_hash = input.expected_sha256.clone();
    let CatalogOutcome { value, change } = catalog.import_staged_file_with_source_checked(input, options, source_page, before_commit)?;
    let skipped_duplicate = value.skipped_duplicate_count > 0;
    let asset = if let Some(asset) = value.assets.into_iter().next() {
        asset
    } else {
        catalog.find_managed_asset_by_hash(&expected_hash)?
            .ok_or_else(|| MaterialError::new("missing-import-result", "导入结果缺少对应素材记录"))?
    };
    Ok(ResolvedMaterialImport {
        asset,
        skipped_duplicate,
        change,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn fixture_input() -> MaterialBytesInput {
        MaterialBytesInput {
            name: "adapter.png".into(),
            original_path: "https://example.test/adapter.png".into(),
            mime_type: "image/png".into(),
            description: None,
            bytes: b"shared-adapter-fixture".to_vec(),
        }
    }

    fn staged_input(
        catalog: &MaterialCatalog,
        name: &str,
        bytes: &[u8],
    ) -> MaterialStagedFileInput {
        let staging = catalog.app_data_dir().join("media-transfer-staging");
        std::fs::create_dir_all(&staging).unwrap();
        let path = staging.join(name);
        std::fs::write(&path, bytes).unwrap();
        MaterialStagedFileInput {
            path,
            name: "download.mp4".into(),
            original_source: "https://example.test/private/video?id=secret".into(),
            mime_type: "video/mp4".into(),
            description: None,
            expected_size_bytes: bytes.len() as u64,
            expected_sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    #[test]
    fn staged_adapter_streams_promotes_dedupes_and_projects_only_safe_origin() {
        let catalog = MaterialCatalog::new_for_test();
        let bytes = b"\0\0\0\x18ftypisom\0\0\0\0isommp42";
        let first_input = staged_input(&catalog, "first.part", bytes);
        let first_stage = first_input.path.clone();
        let first =
            import_staged_download(&catalog, first_input, &MaterialImportOptions::default())
                .unwrap();
        assert!(!first.skipped_duplicate);
        assert_eq!(first.asset.original_path, "https://example.test");
        assert!(!first_stage.exists());
        assert_eq!(
            std::fs::read(first.asset.library_path.as_ref().unwrap()).unwrap(),
            bytes
        );

        let duplicate_input = staged_input(&catalog, "duplicate.part", bytes);
        let duplicate_stage = duplicate_input.path.clone();
        let duplicate =
            import_staged_download(&catalog, duplicate_input, &MaterialImportOptions::default())
                .unwrap();
        assert!(duplicate.skipped_duplicate);
        assert_eq!(duplicate.asset.id, first.asset.id);
        assert!(!duplicate_stage.exists());
    }

    #[cfg(windows)]
    #[test]
    fn staging_root_matches_actual_app_data_writes_under_package_redirection() {
        let base = std::env::var_os("APPDATA").expect("Windows APPDATA");
        let logical = std::path::PathBuf::from(base).join(format!(
            "luckyray-staging-root-qa-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let actual = super::super::resolve_media_staging_root(&logical).unwrap();
        let file = actual.join("owned.part");
        std::fs::write(&file, b"owned staging bytes").unwrap();
        let resolved_file = file.canonicalize().unwrap();
        assert_eq!(resolved_file.parent(), Some(actual.as_path()));
        assert_eq!(super::super::resolve_media_staging_root(&logical).unwrap(), actual);
        assert_eq!(std::fs::read_dir(&actual).unwrap().count(), 1, "probe must be removed");
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(&actual).unwrap();
        if logical != actual { let _ = std::fs::remove_dir(&logical); }
    }

    #[test]
    fn staged_adapter_cleans_trusted_tamper_but_never_deletes_untrusted_input() {
        let catalog = MaterialCatalog::new_for_test();
        let mut trusted = staged_input(&catalog, "tampered.part", b"original");
        trusted.expected_sha256 = "0".repeat(64);
        let trusted_path = trusted.path.clone();
        let error = import_staged_download(&catalog, trusted, &MaterialImportOptions::default())
            .unwrap_err();
        assert_eq!(error.code, "staged-file-changed");
        assert!(!trusted_path.exists());

        let outside = catalog.app_data_dir().join("outside.part");
        std::fs::write(&outside, b"do-not-delete").unwrap();
        let input = MaterialStagedFileInput {
            path: outside.clone(),
            name: "outside.mp4".into(),
            original_source: "https://example.test/private?secret=1".into(),
            mime_type: "video/mp4".into(),
            description: None,
            expected_size_bytes: 13,
            expected_sha256: format!("{:x}", Sha256::digest(b"do-not-delete")),
        };
        let error =
            import_staged_download(&catalog, input, &MaterialImportOptions::default()).unwrap_err();
        assert_eq!(error.code, "staged-file-untrusted");
        assert!(outside.exists());
    }

    #[test]
    fn tauri_and_http_equivalent_adapters_keep_canonical_asset_parity() {
        let options = MaterialImportOptions::default();
        let tauri_catalog = MaterialCatalog::new_for_test();
        let tauri =
            import_tauri_material_bytes(&tauri_catalog, vec![fixture_input()], &options).unwrap();
        let tauri_asset = tauri.value.assets.into_iter().next().unwrap();

        let http_catalog = MaterialCatalog::new_for_test();
        let http = import_downloaded_material(&http_catalog, fixture_input(), &options).unwrap();
        assert_eq!(tauri_asset.name, http.asset.name);
        assert_eq!(tauri_asset.original_path, http.asset.original_path);
        assert_eq!(tauri_asset.storage_mode, http.asset.storage_mode);
        assert_eq!(tauri_asset.kind, http.asset.kind);
        assert_eq!(tauri_asset.mime_type, http.asset.mime_type);
        assert_eq!(tauri_asset.content_hash, http.asset.content_hash);
        assert_eq!(tauri.value.skipped_duplicate_count, 0);
        assert!(!http.skipped_duplicate);
        assert!(tauri.change.is_some() && http.change.is_some());

        let http_compat = serde_json::json!({
            "assetId": http.asset.id,
            "assetName": http.asset.name,
        });
        assert_eq!(http_compat["assetName"], tauri_asset.name);

        let tauri_duplicate =
            import_tauri_material_bytes(&tauri_catalog, vec![fixture_input()], &options).unwrap();
        let http_duplicate =
            import_downloaded_material(&http_catalog, fixture_input(), &options).unwrap();
        assert_eq!(tauri_duplicate.value.skipped_duplicate_count, 1);
        assert!(http_duplicate.skipped_duplicate);
        assert!(tauri_duplicate.change.is_none() && http_duplicate.change.is_none());
    }

    #[test]
    fn tauri_and_http_concurrent_bytes_import_has_one_canonical_record_and_file() {
        let fixture = MaterialCatalog::new_for_test();
        let db_path = fixture.db_path().to_path_buf();
        let app_data_dir = fixture.app_data_dir().to_path_buf();
        let version_before = fixture.read_change().unwrap().version;
        let barrier = Arc::new(Barrier::new(2));
        let tauri_catalog = MaterialCatalog::new(&db_path, &app_data_dir)
            .with_test_import_barrier(Arc::clone(&barrier));
        let http_catalog =
            MaterialCatalog::new(&db_path, &app_data_dir).with_test_import_barrier(barrier);
        let tauri_thread = std::thread::spawn(move || {
            import_tauri_material_bytes(
                &tauri_catalog,
                vec![fixture_input()],
                &MaterialImportOptions::default(),
            )
            .unwrap()
        });
        let http_thread = std::thread::spawn(move || {
            import_downloaded_material(
                &http_catalog,
                fixture_input(),
                &MaterialImportOptions::default(),
            )
            .unwrap()
        });
        let tauri = tauri_thread.join().unwrap();
        let http = http_thread.join().unwrap();

        assert_eq!(
            tauri.value.imported_count + u32::from(!http.skipped_duplicate),
            1
        );
        assert_eq!(
            tauri.value.skipped_duplicate_count + u32::from(http.skipped_duplicate),
            1
        );
        let assets = fixture.list_assets(&MaterialFilter::default()).unwrap();
        assert_eq!(assets.len(), 1);
        let library = app_data_dir.join("asset-library");
        let files = std::fs::read_dir(library)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_file())
            .collect::<Vec<_>>();
        assert_eq!(files.len(), 1);
        assert_eq!(fixture.read_change().unwrap().version, version_before + 1);
        assert_eq!(
            u32::from(tauri.change.is_some()) + u32::from(http.change.is_some()),
            1
        );
    }

    #[test]
    fn tauri_and_http_concurrent_different_bytes_with_same_name_do_not_overwrite() {
        let fixture = MaterialCatalog::new_for_test();
        let db_path = fixture.db_path().to_path_buf();
        let app_data_dir = fixture.app_data_dir().to_path_buf();
        let barrier = Arc::new(Barrier::new(2));
        let tauri_catalog = MaterialCatalog::new(&db_path, &app_data_dir)
            .with_test_import_barrier(Arc::clone(&barrier));
        let http_catalog =
            MaterialCatalog::new(&db_path, &app_data_dir).with_test_import_barrier(barrier);
        let tauri_thread = std::thread::spawn(move || {
            let mut input = fixture_input();
            input.name = "download.png".into();
            input.bytes = b"tauri-distinct-content".to_vec();
            import_tauri_material_bytes(
                &tauri_catalog,
                vec![input],
                &MaterialImportOptions::default(),
            )
            .unwrap()
        });
        let http_thread = std::thread::spawn(move || {
            let mut input = fixture_input();
            input.name = "download.png".into();
            input.bytes = b"http-distinct-content".to_vec();
            import_downloaded_material(&http_catalog, input, &MaterialImportOptions::default())
                .unwrap()
        });
        let tauri = tauri_thread.join().unwrap();
        let http = http_thread.join().unwrap();
        let tauri_asset = &tauri.value.assets[0];
        let tauri_path = std::path::PathBuf::from(tauri_asset.library_path.as_ref().unwrap());
        let http_path = std::path::PathBuf::from(http.asset.library_path.as_ref().unwrap());

        assert_eq!(tauri.value.imported_count, 1);
        assert!(!http.skipped_duplicate);
        assert_ne!(tauri_path, http_path);
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(&tauri_path).unwrap())),
            tauri_asset.content_hash.as_deref().unwrap()
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(&http_path).unwrap())),
            http.asset.content_hash.as_deref().unwrap()
        );
        assert_eq!(
            fixture
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            2
        );
        assert_eq!(fixture.read_change().unwrap().version, 2);
    }
}
