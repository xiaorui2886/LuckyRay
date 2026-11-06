#![allow(dead_code, unused_imports)]
//! Executable proof of actual Consumer/Catalog operations using synthetic data.
//! `cargo run --manifest-path tests/native-material-consumer/Cargo.toml`
//! Registry/transport tests remain in the main crate; this proof needs no GTK.
mod materials;
mod tool_adapter;
mod backend {
    pub(crate) struct BackendServices(pub(crate) crate::materials::MaterialCatalog);
    impl BackendServices { pub(crate) fn material_catalog(&self)->crate::materials::MaterialCatalog {self.0.clone()} }
}
mod local_transport {
    // Explicit fixture host seam only. Production native-only authentication,
    // revocation and request caches are covered by main-crate tests, not mocked as passed here.
    pub(crate) struct VerifiedTransportPrincipal(pub(crate) crate::materials::consumer::ConsumerAuthorization);
    impl VerifiedTransportPrincipal {
        pub(crate) fn material_authorization(&self,_:&crate::materials::MaterialCatalog)->crate::materials::MaterialResult<crate::materials::consumer::ConsumerAuthorization>{Ok(self.0.clone())}
        pub(crate) fn material_admission(&self)->crate::materials::MaterialResult<()> {Ok(())}
    }
}
use base64::{engine::general_purpose::STANDARD, Engine};
use materials::consumer::*;
use materials::*;
use serde_json::json;
use std::collections::BTreeMap;

// Event delivery and opening a catalog-owned resource are the only host seams.
// SQLite transactions, authorization, catalog IO and preview/import are real.
fn publish_catalog_change_global(_: &Option<MaterialChange>) {}
mod companion_gateway {
    pub(crate) mod content {
        pub(crate) fn open_resource(
            path: impl AsRef<std::path::Path>,
        ) -> std::io::Result<std::fs::File> {
            std::fs::File::open(path)
        }
    }
}

fn main() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("fixture.db");
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection
        .execute_batch(include_str!("fixture.sql"))
        .unwrap();
    ensure_change_schema(&connection).unwrap();
    apply_library_schema(&connection).unwrap();
    drop(connection);
    let catalog = MaterialCatalog::new(&db, root.path());
    for name in ["target", "other"] {
        std::fs::create_dir(root.path().join(name)).unwrap();
    }
    let library = catalog
        .create_library("target", &root.path().join("target"), "managed")
        .unwrap()
        .id;
    let other = catalog
        .create_library("other", &root.path().join("other"), "managed")
        .unwrap()
        .id;
    let permission = ConsumerPermissions {
        read: true,
        organize: true,
        import: true,
        files: false,
    };
    let authorization = ConsumerAuthorization {
        enumerate: true,
        libraries: BTreeMap::from([(library.clone(), permission)]),
        ..Default::default()
    };
    let service = MaterialConsumer::new(catalog.clone(), authorization.clone());
    let target = ConsumerTarget {
        library_id: library.clone(),
        request_id: "native.domain.proof".into(),
    };
    let bytes = ConsumerBytesInput {
        library_id: library.clone(),
        request_id: target.request_id.clone(),
        name: "fixture.md".into(),
        mime_type: "text/markdown".into(),
        bytes_base64: STANDARD.encode(b"# Native fixture\n"),
        target_folder_id: None,
        new_folder_name: None,
        tag_ids: vec![],
        tag_names: vec![],
        description: None,
        source_page_url: None,
        source_page_title: None,
        source_page_kind: None,
    };
    catalog.select_library(&other).unwrap();
    let imported = service.import_bytes(&bytes).unwrap();
    let id = imported["assetId"].as_str().unwrap();
    let revision = imported["asset"]["revision"].as_str().unwrap();
    assert_eq!(imported["libraryId"], library);
    assert!(catalog
        .for_library(&other)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap()
        .is_empty());
    assert_eq!(
        service.import_bytes(&bytes).unwrap()["disposition"],
        "duplicate"
    );
    assert_eq!(
        service.list(&target, &Default::default()).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    println!("PASS explicit-library import, dot request ID, UI-switch isolation and duplicate preservation");

    let preview = service.preview(&target, id).unwrap();
    assert_eq!(preview["content"], "# Native fixture\n");
    for field in ["originalPath", "libraryPath", "rootPath"] {
        assert!(!preview.to_string().contains(field));
    }
    assert_eq!(
        service.original(&target, id).unwrap_err().code,
        "consumer-library-denied"
    );
    println!("PASS bounded text preview, path-free projections and original-file denial");

    let foreign = catalog
        .for_library(&other)
        .unwrap()
        .create_tag("foreign", None)
        .unwrap()
        .value;
    let denied = service.organize(
        &target,
        ConsumerOrganization::SetTags {
            asset_id: id.into(),
            expected_revision: revision.into(),
            tag_ids: vec![foreign.id],
        },
    );
    assert!(denied.is_err());
    assert!(catalog
        .for_library(&library)
        .unwrap()
        .get_asset_tags(id)
        .unwrap()
        .is_empty());
    println!("PASS foreign tag refusal before mutation");

    let tag = service
        .organize(
            &target,
            ConsumerOrganization::CreateTag {
                name: "fixture".into(),
                color: None,
            },
        )
        .unwrap();
    let folder = service
        .organize(
            &target,
            ConsumerOrganization::CreateFolder {
                name: "examples".into(),
                parent_id: None,
            },
        )
        .unwrap();
    let tagged = service
        .organize(
            &target,
            ConsumerOrganization::SetTags {
                asset_id: id.into(),
                expected_revision: revision.into(),
                tag_ids: vec![tag["tag"]["id"].as_str().unwrap().into()],
            },
        )
        .unwrap();
    assert_eq!(tagged["committed"], true);
    let stale = service.update_metadata(
        &target,
        id,
        revision,
        ConsumerMetadataPatch {
            description: Some("should not commit".into()),
            ..Default::default()
        },
    );
    assert_eq!(stale.unwrap_err().code, "material-revision-conflict");
    let categorized = service
        .organize(
            &target,
            ConsumerOrganization::Categorize {
                asset_id: id.into(),
                expected_revision: tagged["asset"]["revision"].as_str().unwrap().into(),
                folder_id: Some(folder["folder"]["id"].as_str().unwrap().into()),
            },
        )
        .unwrap();
    let updated = service
        .update_metadata(
            &target,
            id,
            categorized["asset"]["revision"].as_str().unwrap(),
            ConsumerMetadataPatch {
                name: Some("display name".into()),
                description: Some("safe".into()),
                rating: PatchValue::Value(Some(4)),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated["asset"]["description"], "safe");
    assert_eq!(updated["asset"]["folderId"], folder["folder"]["id"]);
    println!(
        "PASS taxonomy creation, CAS tag/category writes, stale CAS refusal and metadata update"
    );

    let mut denied_auth = authorization;
    denied_auth.libraries.get_mut(&library).unwrap().organize = false;
    let denied = MaterialConsumer::new(catalog.clone(), denied_auth).update_metadata(
        &target,
        id,
        updated["asset"]["revision"].as_str().unwrap(),
        ConsumerMetadataPatch {
            description: Some("denied".into()),
            ..Default::default()
        },
    );
    assert_eq!(denied.unwrap_err().code, "consumer-library-denied");
    assert!(serde_json::from_value::<ConsumerMetadataPatch>(
        json!({"originalPath":"/tmp/private"})
    )
    .is_err());
    println!("PASS organize-permission and physical-path patch denial");

    let version = catalog
        .for_library(&library)
        .unwrap()
        .read_library_change()
        .unwrap()
        .version;
    let mut invalid = bytes.clone();
    invalid.request_id = "invalid-image".into();
    invalid.name = "fixture.png".into();
    invalid.mime_type = "image/png".into();
    assert!(service.import_bytes(&invalid).is_err());
    invalid = bytes;
    invalid.name = "../escape.md".into();
    assert!(service.import_bytes(&invalid).is_err());
    assert_eq!(
        catalog
            .for_library(&library)
            .unwrap()
            .read_library_change()
            .unwrap()
            .version,
        version
    );
    println!("PASS corrupt image/path-name refusal without writes");

    let revision = service.detail(&target, id).unwrap()["asset"]["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads = ["concurrent-first", "concurrent-second"].map(|name| {
        let catalog = catalog.clone();
        let revision = revision.clone();
        let id = id.to_owned();
        let target = target.clone();
        let gate = gate.clone();
        let library = library.clone();
        std::thread::spawn(move || {
            let service = MaterialConsumer::new(
                catalog,
                ConsumerAuthorization {
                    enumerate: true,
                    libraries: BTreeMap::from([(library, permission)]),
                    ..Default::default()
                },
            );
            gate.wait();
            service.update_metadata(
                &target,
                &id,
                &revision,
                ConsumerMetadataPatch {
                    name: Some(name.into()),
                    ..Default::default()
                },
            )
        })
    });
    let results = threads.map(|thread| thread.join().unwrap());
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| result
                .as_ref()
                .err()
                .is_some_and(|error| error.code == "material-revision-conflict"))
            .count(),
        1
    );
    catalog.set_library_visible(&library, false).unwrap();
    assert!(service.preview(&target, id).is_err());
    println!("PASS concurrent CAS single winner and hidden-library refusal");
    catalog.set_library_visible(&library, true).unwrap();
    let adapter_auth=ConsumerAuthorization {enumerate:true,libraries:BTreeMap::from([(library.clone(),permission)]),..Default::default()};
    tool_adapter::run(&backend::BackendServices(catalog.clone()),&local_transport::VerifiedTransportPrincipal(adapter_auth));
    // A controlled post-import projection outage preserves the committed identity
    // instead of making a duplicate import look like a safe-to-retry refusal.
    let receipt_input=ConsumerBytesInput {library_id:library.clone(),request_id:"receipt.projection".into(),name:"receipt.md".into(),mime_type:"text/markdown".into(),bytes_base64:STANDARD.encode(b"# Receipt fallback"),target_folder_id:None,new_folder_name:None,tag_ids:vec![],tag_names:vec![],description:None,source_page_url:None,source_page_title:None,source_page_kind:None};
    let committed=service.import_bytes(&receipt_input).unwrap();
    rusqlite::Connection::open(&db).unwrap().execute_batch("ALTER TABLE item_tag RENAME COLUMN created_at TO projection_unavailable").unwrap();
    let replay=service.import_bytes(&receipt_input).unwrap();
    assert_eq!(replay["assetId"],committed["assetId"]);
    assert_eq!(replay["disposition"],"duplicate");
    assert_eq!(replay["outputUnavailable"],true);
    println!("PASS committed import receipt survives metadata projection failure");
    println!("8 production-domain proof groups plus actual adapter dispatch passed; no real user profile opened");
}
