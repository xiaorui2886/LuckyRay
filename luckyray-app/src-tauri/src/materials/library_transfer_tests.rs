use super::super::library_archive::*;
use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn setup() -> MaterialCatalog {
    let c = MaterialCatalog::new_for_test();
    apply_transfer_schema(&c.open_write().unwrap()).unwrap();
    c
}

#[test]
fn unresolved_history_survives_restart_and_twenty_completed_jobs_with_owner_isolation() {
    let c = setup();
    let a = lib(&c, "A");
    let b = lib(&c, "B");
    add(&a, "one.png", b"one");
    let offline = add(&a, "missing.png", b"offline").library_path.unwrap();
    let away = format!("{offline}.offline");
    std::fs::rename(&offline, &away).unwrap();
    let anchor = a.library_scope_key().unwrap();
    let target = b.library_scope_key().unwrap();
    let m = LibraryTransferManager::default();
    let mut unresolved = Vec::new();
    for i in 0..3 {
        let id = unique_id("transfer");
        m.start_copy(
            c.clone(),
            &anchor,
            &id,
            &target,
            TransferSelection::default(),
        )
        .unwrap();
        let mut result = wait(&m, &c, &anchor, &id);
        assert_eq!(result.phase, "partial");
        let (job, _) = load_job(&c, &anchor, &id).unwrap();
        if i == 0 {
            // Fault fixture: the process stopped with a durable staging journal.
            result.phase = "staging".into();
        } else if i == 2 {
            result.phase = "cancelled".into();
        }
        persist_job(&c, &job, &result, None).unwrap();
        c.open_write()
            .unwrap()
            .execute(
                "UPDATE material_library_transfer SET created_at='2000-01-01' WHERE id=?1",
                [&id],
            )
            .unwrap();
        unresolved.push(id);
    }
    std::fs::rename(&away, &offline).unwrap();
    let mut completed = Vec::new();
    for i in 0..20 {
        let id = unique_id("transfer");
        m.start_copy(
            c.clone(),
            &anchor,
            &id,
            &target,
            TransferSelection::default(),
        )
        .unwrap();
        assert_eq!(wait(&m, &c, &anchor, &id).phase, "completed");
        c.open_write()
            .unwrap()
            .execute(
                "UPDATE material_library_transfer SET created_at=?2 WHERE id=?1",
                rusqlite::params![id, format!("2026-01-01T00:00:{i:02}Z")],
            )
            .unwrap();
        completed.push(id);
    }
    let foreign = unique_id("transfer");
    m.start_copy(
        c.clone(),
        &target,
        &foreign,
        &anchor,
        TransferSelection::default(),
    )
    .unwrap();
    assert_eq!(wait(&m, &c, &target, &foreign).phase, "completed");
    drop(m);
    let restarted = LibraryTransferManager::default();
    let all = restarted.list(&c, &anchor, false).unwrap();
    assert_eq!(all.len(), 19);
    assert_eq!(
        all.iter()
            .filter(|s| s.phase == "completed")
            .map(|s| s.task_id.clone())
            .collect::<Vec<_>>(),
        completed.into_iter().rev().take(16).collect::<Vec<_>>()
    );
    let open = restarted.list(&c, &anchor, true).unwrap();
    assert_eq!(open.len(), 3);
    for id in &unresolved {
        assert!(open.iter().any(|s| &s.task_id == id && s.retryable));
    }
    assert_eq!(
        open.iter()
            .find(|s| s.task_id == unresolved[0])
            .unwrap()
            .phase,
        "interrupted"
    );
    assert_eq!(
        open.iter()
            .find(|s| s.task_id == unresolved[1])
            .unwrap()
            .phase,
        "partial"
    );
    assert_eq!(
        open.iter()
            .find(|s| s.task_id == unresolved[2])
            .unwrap()
            .phase,
        "cancelled"
    );
    assert!(all
        .iter()
        .all(|s| s.source_library_id == anchor && s.task_id != foreign));
    assert!(restarted.status(&c, &target, &unresolved[0]).is_err());
    for action in [
        json!({"op":"transferList"}),
        json!({"op":"transferList","unresolvedOnly":true}),
    ] {
        let request = serde_json::from_value(json!({"libraryId":null,"action":action})).unwrap();
        assert!(execute_library_request(c.clone(), request)
            .unwrap_err()
            .contains("library-context-required"));
    }
}
fn lib(c: &MaterialCatalog, name: &str) -> MaterialCatalog {
    let root = tempfile::tempdir().unwrap().keep();
    let l = c.create_library(name, &root, "managed").unwrap();
    c.for_library(&l.id).unwrap()
}
fn add(c: &MaterialCatalog, name: &str, bytes: &[u8]) -> MaterialAsset {
    let result = c
        .import_bytes(
            vec![MaterialBytesInput {
                name: name.into(),
                original_path: "https://example.test/art/42".into(),
                mime_type: "image/png".into(),
                bytes: bytes.into(),
                description: Some("可移植描述".into()),
            }],
            &MaterialImportOptions::default(),
        )
        .unwrap()
        .value;
    result.assets[0].clone()
}
fn wait(m: &LibraryTransferManager, c: &MaterialCatalog, anchor: &str, id: &str) -> TransferStatus {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let s = m.status(c, anchor, id).unwrap();
        if matches!(
            s.phase.as_str(),
            "completed" | "partial" | "failed" | "cancelled"
        ) {
            return s;
        }
        assert!(Instant::now() < deadline, "timeout: {s:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn fixture_package(c: &MaterialCatalog, path: &Path) -> LibraryPackage {
    let (mut p, local) = c.package_snapshot(&TransferSelection::default()).unwrap();
    let mut media = Vec::new();
    for (a, local) in p.assets.iter_mut().zip(local) {
        let mut s = freeze_media(c, &local).unwrap();
        let h = verify_media(&s, |_| Ok(())).unwrap();
        s.sha256 = Some(h.clone());
        a.sha256 = h;
        a.size_bytes = s.size;
        media.push(s);
    }
    write_package(&p, &media, path, |_, _| Ok(())).unwrap();
    p
}
fn rewrite(
    input: &Path,
    output: &Path,
    edit: impl Fn(&str, Vec<u8>) -> Vec<u8>,
    extra: Option<(&str, &[u8])>,
) {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(input).unwrap()).unwrap();
    let mut writer = zip::ZipWriter::new(std::fs::File::create(output).unwrap());
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        let name = entry.name().to_string();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        writer
            .start_file(
                &name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(&edit(&name, bytes)).unwrap();
    }
    if let Some((name, bytes)) = extra {
        writer
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
}
fn snapshot_fields(c: &MaterialCatalog) -> Value {
    let conn = c.open_read().unwrap();
    let mut tables = serde_json::Map::new();
    for table in [
        "asset",
        "folder",
        "material_library",
        "material_library_state",
        "material_library_asset",
        "material_library_asset_history",
        "material_library_folder",
        "material_library_tag",
        "material_library_smart_folder",
        "item_tag",
        "asset_source_page",
        "material_note_identity",
        "material_note_vault",
        "material_note_ref",
        "favorite_item",
        "smart_folder_definition",
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        if !exists {
            continue;
        }
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
            .unwrap();
        let count = stmt.column_count();
        let values = stmt
            .query_map([], |r| {
                let mut row = Vec::new();
                for i in 0..count {
                    let value = match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => json!(n),
                        rusqlite::types::ValueRef::Real(n) => json!(n),
                        rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                        rusqlite::types::ValueRef::Blob(s) => json!(s),
                    };
                    row.push(value);
                }
                Ok(Value::Array(row))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        tables.insert(table.into(), Value::Array(values));
    }
    Value::Object(tables)
}

fn rewrite_manifest(input: &Path, output: &Path, edit: impl Fn(&mut Value)) {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(input).unwrap()).unwrap();
    let mut manifest = Vec::new();
    zip.by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut manifest)
        .unwrap();
    let mut value: Value = serde_json::from_slice(&manifest).unwrap();
    edit(&mut value);
    let manifest = serde_json::to_vec(&value).unwrap();
    let mut integrity = Vec::new();
    zip.by_name("integrity.json")
        .unwrap()
        .read_to_end(&mut integrity)
        .unwrap();
    let mut integrity: Value = serde_json::from_slice(&integrity).unwrap();
    let entry = integrity["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["path"] == "manifest.json")
        .unwrap();
    entry["sha256"] = json!(format!("{:x}", Sha256::digest(&manifest)));
    entry["sizeBytes"] = json!(manifest.len());
    let integrity = serde_json::to_vec(&integrity).unwrap();
    drop(zip);
    rewrite(
        input,
        output,
        |name, bytes| match name {
            "manifest.json" => manifest.clone(),
            "integrity.json" => integrity.clone(),
            _ => bytes,
        },
        None,
    );
}
fn semantic(p: &LibraryPackage) -> Value {
    fn folder_path(p: &LibraryPackage, id: Option<&str>) -> Vec<String> {
        let mut names = Vec::new();
        let mut cursor = id;
        while let Some(id) = cursor {
            let f = p.folders.iter().find(|f| f.id == id).unwrap();
            names.push(f.name.clone());
            cursor = f.parent_id.as_deref();
        }
        names.reverse();
        names
    }
    let tag_name = |id: &str| p.tags.iter().find(|t| t.id == id).unwrap().name.clone();
    let mut assets = Vec::new();
    for a in &p.assets {
        let mut v = serde_json::to_value(a).unwrap();
        v.as_object_mut().unwrap().remove("id");
        v["folderId"] = json!(folder_path(p, a.folder_id.as_deref()));
        v["tagIds"] = json!(a.tag_ids.iter().map(|id| tag_name(id)).collect::<Vec<_>>());
        if let Some(s) = v.get_mut("sourcePage").and_then(Value::as_object_mut) {
            s.remove("assetId");
        }
        assets.push(v);
    }
    assets.sort_by_key(Value::to_string);
    let mut folders = Vec::new();
    for f in &p.folders {
        let mut v = serde_json::to_value(f).unwrap();
        v["id"] = json!(folder_path(p, Some(&f.id)));
        v["parentId"] = json!(folder_path(p, f.parent_id.as_deref()));
        folders.push(v);
    }
    folders.sort_by_key(Value::to_string);
    let mut tags = p
        .tags
        .iter()
        .map(|t| {
            let mut v = serde_json::to_value(t).unwrap();
            v.as_object_mut().unwrap().remove("id");
            v
        })
        .collect::<Vec<_>>();
    tags.sort_by_key(Value::to_string);
    let mut smart = p
        .smart_folders
        .iter()
        .map(|s| {
            let mut v = serde_json::to_value(s).unwrap();
            v.as_object_mut().unwrap().remove("id");
            if let Some(ids) = v["criteria"]["tagIds"].as_array_mut() {
                for id in ids {
                    *id = json!(tag_name(id.as_str().unwrap()));
                }
            }
            v
        })
        .collect::<Vec<_>>();
    smart.sort_by_key(Value::to_string);
    let mut favorites = p
        .favorites
        .iter()
        .map(|f| {
            let mut v = serde_json::to_value(f).unwrap();
            let a = p.assets.iter().find(|a| a.id == f.asset_id).unwrap();
            v["assetId"] = json!([a.name, a.sha256]);
            v
        })
        .collect::<Vec<_>>();
    favorites.sort_by_key(Value::to_string);
    let mut prefs = p.preferences.clone();
    if let Some(raw) = prefs
        .get("luckyray-materials-filter-v1")
        .and_then(Value::as_str)
    {
        let mut filter: Value = serde_json::from_str(raw).unwrap();
        if let Some(ids) = filter["tagIds"].as_array_mut() {
            for id in ids {
                *id = json!(tag_name(id.as_str().unwrap()));
            }
        }
        if let Some(id) = filter["folderId"].as_str() {
            filter["folderId"] = json!(folder_path(p, Some(id)));
        }
        prefs["luckyray-materials-filter-v1"] = filter;
    }
    json!({"name":p.name,"assets":assets,"folders":folders,"tags":tags,"smart":smart,"favorites":favorites,"preferences":prefs})
}
#[test]
fn full_semantic_roundtrip_preserves_hierarchy_rules_and_media_and_excludes_secrets() {
    let c = setup();
    let a = lib(&c, "完整中文库");
    let other = lib(&c, "其他库");
    let forbidden = add(&other, "其他库不能入包.png", b"other-library-secret");
    let asset = add(&a, "主图.png", b"semantic-media");
    let parent = a
        .create_folder(MaterialFolderInput {
            parent_id: None,
            name: "父级".into(),
        })
        .unwrap()
        .value;
    let child = a
        .create_folder(MaterialFolderInput {
            parent_id: Some(parent.id.clone()),
            name: "子级".into(),
        })
        .unwrap()
        .value;
    a.move_asset(&asset.id, Some(&child.id)).unwrap();
    a.update_asset(
        &asset.id,
        MaterialAssetPatch {
            rating: PatchValue::Value(Some(4)),
            dominant_color: PatchValue::Value(Some("#112233".into())),
            ..Default::default()
        },
        "metadata-test",
    )
    .unwrap();
    let tag = a.create_tag("a", Some("#ff0011".into())).unwrap().value;
    let case = a.create_tag("A", Some("#123456".into())).unwrap().value;
    a.set_asset_tags(&asset.id, vec![tag.id.clone(), case.id.clone()])
        .unwrap();
    let mut conn = a.open_write().unwrap();
    crate::favorites::add(
        &mut conn,
        crate::favorites::FavoriteItemType::Material,
        &asset.id,
    )
    .unwrap();
    crate::favorites::update_notes(
        &mut conn,
        crate::favorites::FavoriteItemType::Material,
        &asset.id,
        "收藏主题",
        "素材收藏文案",
    )
    .unwrap();
    crate::smart_folders::create(
        &mut conn,
        crate::smart_folders::SmartFolderDefinitionInput {
            name: "高分设计".into(),
            criteria: crate::smart_folders::SmartFolderCriteria::Material {
                query: "主图".into(),
                kinds: vec!["image".into()],
                tag_ids: vec![tag.id.clone()],
                favorite: Some(true),
                added: Default::default(),
                modified: Default::default(),
            },
            sort: crate::smart_folders::SmartFolderSort::NameAsc,
        },
    )
    .unwrap();
    conn.execute("INSERT INTO asset_source_page(asset_id,page_url,page_kind,title) VALUES(?1,'https://example.test/work/42','work-page','来源作品')",[&asset.id]).unwrap();
    let anchor = a.library_scope_key().unwrap();
    a.save_library_preferences(&anchor,json!({"luckyray-materials-view-v1":"list","luckyray-materials-sort-v1":"newest","luckyray-materials-zoom-v1":"200","luckyray-materials-filter-v1":json!({"kinds":["image"],"tagIds":[tag.id],"recentOnly":false,"storageMode":"all","folderId":child.id,"color":null,"dateFrom":"","dateTo":"","ratingMin":4,"token":"embedded-credential-secret"}).to_string(),"luckyray-materials-workview-v1":json!({"active":"design","saved":{"design":{"viewMode":"grid","zoom":210,"password":"preset-secret"}}}).to_string(),"luckyray-material-watch-sources-v1":"watch-path-secret","token":"app-token-secret"})).unwrap();
    let private_path = c.app_data_dir().join("private.md");
    std::fs::write(&private_path, b"private-vault-secret").unwrap();
    let private = c
        .register_note_attachment(&private_path, "private-vault", None)
        .unwrap();
    let shared = c
        .register_note_attachment(
            Path::new(asset.library_path.as_ref().unwrap()),
            "ordinary-vault",
            None,
        )
        .unwrap();
    assert_eq!(shared.id, asset.id);
    c.replace_note_attachment_refs(
        "ordinary-vault",
        "notes/saved.md",
        &[NoteAttachmentRefInput {
            asset_id: asset.id.clone(),
            target: "../assets/主图.png".into(),
        }],
    )
    .unwrap();
    c.replace_note_attachment_refs(
        "private-vault",
        "notes/private.md",
        &[NoteAttachmentRefInput {
            asset_id: private.id.clone(),
            target: "../private.md".into(),
        }],
    )
    .unwrap();
    let source_assets = a.list_assets(&MaterialFilter::default()).unwrap();
    let ref_before = snapshot_fields(&c)["material_note_ref"].clone();
    assert_eq!(ref_before.as_array().unwrap().len(), 2);
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original.lrlibrary");
    let p = fixture_package(&a, &original);
    let serialized = serde_json::to_string(&p).unwrap();
    for secret in [
        "embedded-credential-secret",
        "preset-secret",
        "watch-path-secret",
        "app-token-secret",
        &forbidden.id,
        &private.id,
    ] {
        assert!(!serialized.contains(secret), "leaked {secret}");
    }
    let fresh = setup();
    let legacy = fresh.library_state().unwrap().0;
    let root = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    m.start_restore(
        fresh.clone(),
        &legacy,
        &id,
        original.to_str().unwrap(),
        root.path().to_str().unwrap(),
        "完整中文库",
    )
    .unwrap();
    let done = wait(&m, &fresh, &legacy, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    let restored = fresh
        .for_library(done.target_library_id.as_ref().unwrap())
        .unwrap();
    let restored_package = temp.path().join("restored.lrlibrary");
    let q = fixture_package(&restored, &restored_package);
    assert_eq!(semantic(&p), semantic(&q));
    assert_eq!(
        a.list_assets(&MaterialFilter::default()).unwrap(),
        source_assets
    );
    assert_eq!(snapshot_fields(&c)["material_note_ref"], ref_before);
    assert!(
        fresh
            .open_read()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM material_note_vault", [], |r| r
                .get::<_, i64>(0))
            .unwrap()
            == 0
    );
    assert_ne!(p.folders[0].id, q.folders[0].id);
    assert_ne!(p.tags[0].id, q.tags[0].id);
    assert_ne!(p.smart_folders[0].id, q.smart_folders[0].id);
}
fn await_phase(
    m: &LibraryTransferManager,
    c: &MaterialCatalog,
    anchor: &str,
    id: &str,
    phase: &str,
) -> TransferStatus {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let s = m.status(c, anchor, id).unwrap();
        if s.phase == phase {
            return s;
        }
        assert!(
            !matches!(s.phase.as_str(), "failed" | "completed" | "partial"),
            "unexpected terminal {s:?}"
        );
        assert!(Instant::now() < deadline, "timeout {s:?}");
        std::thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn schema_increment_is_atomic_idempotent_and_preserves_r1_rows() {
    let c = MaterialCatalog::new_for_test();
    let a = add(&c, "旧.png", b"legacy");
    let before = snapshot_fields(&c);
    let conn = c.open_write().unwrap();
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    apply_transfer_schema(&conn).unwrap();
    conn.execute_batch("ROLLBACK").unwrap();
    assert!(verify_transfer_schema(&conn).is_err());
    assert_eq!(snapshot_fields(&c), before);
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    apply_transfer_schema(&conn).unwrap();
    conn.execute_batch("COMMIT").unwrap();
    apply_transfer_schema(&conn).unwrap();
    verify_transfer_schema(&conn).unwrap();
    super::super::libraries::verify_library_schema(&conn).unwrap();
    assert_eq!(snapshot_fields(&c), before);
    assert_eq!(c.get_assets(&[a.id]).unwrap().len(), 1);
    conn.execute_batch("DROP INDEX material_library_transfer_anchor; CREATE INDEX material_library_transfer_anchor ON material_library_transfer(kind)").unwrap();
    assert_eq!(
        verify_transfer_schema(&conn).unwrap_err().code,
        "library-transfer-schema-drift"
    );
}
#[test]
fn transfer_schema_identifier_quotes_are_equivalent_but_check_literal_drift_is_not() {
    let c = MaterialCatalog::new_for_test(); let conn = c.open_write().unwrap();
    conn.execute_batch(&TRANSFER_SCHEMA.replace("material_library_transfer(", "\"material_library_transfer\"(")).unwrap();
    verify_transfer_schema(&conn).unwrap();
    conn.execute_batch("DROP TABLE material_library_transfer").unwrap();
    for value in ["MOVE", "mo ve", "merge"] {
        conn.execute_batch(&TRANSFER_SCHEMA.replace("'move'", &format!("'{value}'"))).unwrap();
        assert_eq!(verify_transfer_schema(&conn).unwrap_err().code,"library-transfer-schema-drift");
        conn.execute_batch("DROP TABLE material_library_transfer").unwrap();
    }
}
#[test]
fn same_names_and_hashes_map_without_overwriting_target_metadata() {
    let c = setup();
    let a = lib(&c, "A");
    let b = lib(&c, "B");
    let src = add(&a, "源.png", b"duplicate");
    let keep = add(&b, "目标人工名.png", b"duplicate");
    let source_tag = a.create_tag("同名", Some("red".into())).unwrap().value;
    let target_tag = b.create_tag("同名", Some("blue".into())).unwrap().value;
    a.set_asset_tags(&src.id, vec![source_tag.id.clone()])
        .unwrap();
    let source_folder = a
        .create_folder(MaterialFolderInput {
            parent_id: None,
            name: "同名分类".into(),
        })
        .unwrap()
        .value;
    let target_folder = b
        .create_folder(MaterialFolderInput {
            parent_id: None,
            name: "同名分类".into(),
        })
        .unwrap()
        .value;
    a.move_asset(&src.id, Some(&source_folder.id)).unwrap();
    let another = add(&a, "另一个.png", b"different");
    a.move_asset(&another.id, Some(&source_folder.id)).unwrap();
    a.set_asset_tags(&another.id, vec![source_tag.id]).unwrap();
    let original = a.get_assets(&[src.id.clone(), another.id.clone()]).unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    let anchor = a.library_scope_key().unwrap();
    m.start_copy(
        c.clone(),
        &anchor,
        &id,
        &b.library_scope_key().unwrap(),
        TransferSelection {
            folder_id: Some(source_folder.id),
            asset_ids: None,
        },
    )
    .unwrap();
    let result = wait(&m, &c, &anchor, &id);
    assert_eq!(result.phase, "completed", "{result:?}");
    assert_eq!((result.copied, result.skipped), (1, 1));
    assert_eq!(b.get_assets(&[keep.id.clone()]).unwrap()[0], keep);
    assert_eq!(a.get_assets(&[src.id, another.id]).unwrap(), original);
    assert_eq!(b.list_folders().unwrap().len(), 1);
    let copied = b
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .into_iter()
        .find(|x| x.id != keep.id)
        .unwrap();
    assert_eq!(
        std::fs::read_dir(b.import_library_root(None).unwrap())
            .unwrap()
            .count(),
        2,
        "same-hash skip must not leave a third media copy"
    );
    assert_eq!(copied.folder_id, Some(target_folder.id));
    assert_eq!(
        b.get_asset_tags(&copied.id).unwrap(),
        vec![target_tag.id.clone()]
    );
    assert_eq!(
        b.list_tags()
            .unwrap()
            .into_iter()
            .find(|t| t.id == target_tag.id)
            .unwrap()
            .color,
        Some("blue".into())
    );
}
#[test]
fn copy_scope_and_task_owner_never_follow_ui_or_accept_vault_ids() {
    let c = setup();
    let a = lib(&c, "A");
    let b = lib(&c, "B");
    let asset = add(&a, "源.png", &vec![7; 2 * 1024 * 1024]);
    let foreign = add(&b, "其他.png", b"other");
    let private_path = c.app_data_dir().join("private.md");
    std::fs::write(&private_path, b"vault secret").unwrap();
    let private = c
        .register_note_attachment(&private_path, "vault-a", None)
        .unwrap();
    let m = LibraryTransferManager::default();
    let anchor = a.library_scope_key().unwrap();
    let target = b.library_scope_key().unwrap();
    for id in [foreign.id, private.id.clone()] {
        assert!(m
            .start_copy(
                c.clone(),
                &anchor,
                &unique_id("transfer"),
                &target,
                TransferSelection {
                    asset_ids: Some(vec![id]),
                    folder_id: None
                }
            )
            .is_err());
    }
    *m.test_pause_ms.lock().unwrap() = 10;
    let id = unique_id("transfer");
    m.start_copy(
        c.clone(),
        &anchor,
        &id,
        &target,
        TransferSelection {
            asset_ids: Some(vec![asset.id]),
            folder_id: None,
        },
    )
    .unwrap();
    c.select_library(&target).unwrap();
    assert!(m.status(&c, &target, &id).is_err());
    assert!(m.cancel(&c, &target, &id).is_err());
    assert_eq!(wait(&m, &c, &anchor, &id).target_library_id, Some(target));
    assert_eq!(a.list_assets(&MaterialFilter::default()).unwrap().len(), 1);
    assert!(c.get_assets(&[private.id]).is_err());
    let action: LibraryRequest = serde_json::from_value(
        json!({"libraryId":null,"vaultId":"vault-a","action":{"op":"transferList"}}),
    )
    .unwrap();
    assert!(execute_library_request(c.clone(), action)
        .unwrap_err()
        .contains("not-authorized"));
    let no_library: LibraryRequest =
        serde_json::from_value(json!({"libraryId":null,"action":{"op":"transferList"}})).unwrap();
    assert!(execute_library_request(c, no_library)
        .unwrap_err()
        .contains("context-required"));
}
#[test]
fn cancellation_and_restart_retry_preserve_identity_without_partial_ready_library() {
    let c = setup();
    let a = lib(&c, "源");
    add(&a, "large.png", &vec![5; 3 * 1024 * 1024]);
    let dir = tempfile::tempdir().unwrap();
    let package = dir.path().join("backup.lrlibrary");
    fixture_package(&a, &package);
    let independent = setup();
    let anchor = independent.library_state().unwrap().0;
    let root = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    *m.test_pause_ms.lock().unwrap() = 20;
    let id = unique_id("transfer");
    let start = m
        .start_restore(
            independent.clone(),
            &anchor,
            &id,
            package.to_str().unwrap(),
            root.path().to_str().unwrap(),
            "恢复",
        )
        .unwrap();
    await_phase(&m, &independent, &anchor, &id, "staging");
    m.cancel(&independent, &anchor, &id).unwrap();
    let cancelled = wait(&m, &independent, &anchor, &id);
    assert_eq!(cancelled.phase, "cancelled");
    assert_eq!(independent.list_libraries(true).unwrap().len(), 1);
    let recovered = LibraryTransferManager::default();
    let persisted = recovered.status(&independent, &anchor, &id).unwrap();
    assert_eq!(persisted.phase, "cancelled");
    recovered.retry(independent.clone(), &anchor, &id).unwrap();
    let done = wait(&recovered, &independent, &anchor, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    assert_eq!(done.target_library_id, start.target_library_id);
    assert_eq!(independent.list_libraries(true).unwrap().len(), 2);
    assert_eq!(a.list_assets(&MaterialFilter::default()).unwrap().len(), 1);
}
#[test]
fn disk_full_after_written_chunk_rolls_back_and_retries_same_job() {
    let c = setup();
    let a = lib(&c, "源");
    add(&a, "large.png", &vec![2; 2 * 1024 * 1024]);
    let dir = tempfile::tempdir().unwrap();
    let package = dir.path().join("backup.lrlibrary");
    fixture_package(&a, &package);
    let independent = setup();
    let anchor = independent.library_state().unwrap().0;
    let root = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    m.test_disk_full.store(true, Ordering::Release);
    let id = unique_id("transfer");
    m.start_restore(
        independent.clone(),
        &anchor,
        &id,
        package.to_str().unwrap(),
        root.path().to_str().unwrap(),
        "恢复",
    )
    .unwrap();
    let failed = wait(&m, &independent, &anchor, &id);
    assert_eq!(failed.phase, "failed");
    assert!(failed.error.unwrap().contains("磁盘空间不足"));
    assert_eq!(independent.list_libraries(true).unwrap().len(), 1);
    m.test_disk_full.store(false, Ordering::Release);
    m.retry(independent.clone(), &anchor, &id).unwrap();
    let done = wait(&m, &independent, &anchor, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    assert_eq!(independent.list_libraries(true).unwrap().len(), 2);
    let stage = independent
        .app_data_dir()
        .join("material-library-staging")
        .join(&id);
    let deadline = Instant::now() + Duration::from_secs(3);
    while stage.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!stage.exists(), "completed operation cache was retained");
}
#[test]
fn sqlite_failure_after_media_staging_rolls_back_full_library_and_recovers() {
    let c = setup();
    let a = lib(&c, "源");
    add(&a, "one.png", b"one");
    add(&a, "two.png", b"two");
    let dir = tempfile::tempdir().unwrap();
    let package = dir.path().join("backup.lrlibrary");
    fixture_package(&a, &package);
    let independent = setup();
    let before = snapshot_fields(&independent);
    let conn = independent.open_write().unwrap();
    conn.execute_batch("CREATE TRIGGER r2_fault BEFORE INSERT ON asset BEGIN SELECT RAISE(ABORT,'injected catalog failure'); END").unwrap();
    let anchor = independent.library_state().unwrap().0;
    let root = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    m.start_restore(
        independent.clone(),
        &anchor,
        &id,
        package.to_str().unwrap(),
        root.path().to_str().unwrap(),
        "恢复",
    )
    .unwrap();
    assert_eq!(wait(&m, &independent, &anchor, &id).phase, "failed");
    assert_eq!(snapshot_fields(&independent), before);
    assert!(root.path().join("library.json").is_file());
    conn.execute_batch("DROP TRIGGER r2_fault").unwrap();
    let recovered = LibraryTransferManager::default();
    recovered.retry(independent.clone(), &anchor, &id).unwrap();
    let done = wait(&recovered, &independent, &anchor, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    assert_eq!(
        independent
            .for_library(done.target_library_id.as_ref().unwrap())
            .unwrap()
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn file_mutation_during_export_does_not_publish_mixed_backup() {
    let c = setup();
    let a = lib(&c, "源");
    let one = add(&a, "first.png", &vec![1; 2 * 1024 * 1024]);
    add(&a, "second.png", &vec![2; 2 * 1024 * 1024]);
    let output = tempfile::tempdir().unwrap();
    let path = output.path().join("backup.lrlibrary");
    let m = LibraryTransferManager::default();
    *m.test_pause_ms.lock().unwrap() = 40;
    let anchor = a.library_scope_key().unwrap();
    let id = unique_id("transfer");
    m.start_export(c.clone(), &anchor, &id, path.to_str().unwrap())
        .unwrap();
    await_phase(&m, &c, &anchor, &id, "staging");
    std::fs::write(one.library_path.unwrap(), b"changed revision").unwrap();
    let failed = wait(&m, &c, &anchor, &id);
    assert_eq!(failed.phase, "failed", "{failed:?}");
    assert!(!path.exists());
    assert!(std::fs::read_dir(output.path()).unwrap().next().is_none());
}
#[test]
fn partial_copy_is_explicit_and_retry_does_not_duplicate_successes() {
    let c = setup();
    let a = lib(&c, "A");
    let b = lib(&c, "B");
    let one = add(&a, "one.png", b"one");
    let missing = add(&a, "missing.png", b"offline");
    let original = missing.library_path.clone().unwrap();
    let away = PathBuf::from(format!("{original}.offline"));
    std::fs::rename(&original, &away).unwrap();
    let anchor = a.library_scope_key().unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    m.start_copy(
        c.clone(),
        &anchor,
        &id,
        &b.library_scope_key().unwrap(),
        TransferSelection::default(),
    )
    .unwrap();
    let partial = wait(&m, &c, &anchor, &id);
    assert_eq!(partial.phase, "partial", "{partial:?}");
    assert_eq!((partial.copied, partial.failed), (1, 1));
    let copied_id = partial
        .items
        .iter()
        .find(|i| i.asset_id == one.id)
        .unwrap()
        .target_asset_id
        .clone();
    std::fs::rename(&away, &original).unwrap();
    m.retry(c.clone(), &anchor, &id).unwrap();
    let complete = wait(&m, &c, &anchor, &id);
    assert_eq!(complete.phase, "completed", "{complete:?}");
    assert_eq!(
        complete
            .items
            .iter()
            .find(|i| i.asset_id == one.id)
            .unwrap()
            .target_asset_id,
        copied_id
    );
    assert_eq!(b.list_assets(&MaterialFilter::default()).unwrap().len(), 2);
}
#[test]
fn unsafe_duplicate_and_overcompressed_archives_fail_before_extracting() {
    let c = setup();
    let a = lib(&c, "源");
    add(&a, "one.png", b"one");
    let root = tempfile::tempdir().unwrap();
    let valid = root.path().join("valid.lrlibrary");
    fixture_package(&a, &valid);
    for (index, name) in [
        "../outside",
        "/absolute",
        "C:/outside",
        "media/CON",
        "media/NUL.txt",
        "media/com1.png",
        "media/lpt9",
        "media/a\\b",
        "media/a.",
        "media/a ",
        "media/a/b",
        "MANIFEST.json",
    ]
    .iter()
    .enumerate()
    {
        let bad = root.path().join(format!("bad{index}.lrlibrary"));
        rewrite(&valid, &bad, |_, b| b, Some((name, b"evil")));
        assert!(inspect_package(&bad).is_err(), "accepted {name}");
        assert!(!root.path().join("outside").exists());
    }
    let duplicate = root.path().join("duplicate.lrlibrary");
    rewrite(&valid, &duplicate, |_, b| b, Some(("Manifest.json", b"{}")));
    let mut bytes = std::fs::read(&duplicate).unwrap();
    let from = b"Manifest.json";
    for i in 0..bytes.len() - from.len() {
        if &bytes[i..i + from.len()] == from {
            bytes[i] = b'm';
        }
    }
    std::fs::write(&duplicate, &bytes).unwrap();
    assert!(inspect_package(&duplicate)
        .unwrap_err()
        .message
        .contains("重复"));
    let count_bomb = root.path().join("declared-count.lrlibrary");
    let mut bytes = std::fs::read(&valid).unwrap();
    let end = bytes.len() - 22;
    for offset in [8, 10] {
        bytes[end + offset..end + offset + 2].copy_from_slice(&10_003u16.to_le_bytes());
    }
    std::fs::write(&count_bomb, bytes).unwrap();
    assert!(inspect_package(&count_bomb)
        .unwrap_err()
        .message
        .contains("预算"));
    let link = root.path().join("symlink.lrlibrary");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&link).unwrap());
    writer
        .add_symlink(
            format!("media/{}", "a".repeat(64)),
            "../../outside",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.finish().unwrap();
    assert!(inspect_package(&link).unwrap_err().message.contains("链接"));
    let bomb = root.path().join("ratio.lrlibrary");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&bomb).unwrap());
    writer
        .start_file(
            "manifest.json",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    writer.write_all(&vec![0; 2 * 1024 * 1024]).unwrap();
    writer.finish().unwrap();
    assert!(inspect_package(&bomb).unwrap_err().message.contains("压缩"));
}
#[test]
fn unsupported_versions_missing_references_and_corrupted_media_do_not_create_libraries() {
    let c = setup();
    let a = lib(&c, "源");
    add(&a, "one.png", b"one");
    let root = tempfile::tempdir().unwrap();
    let valid = root.path().join("valid.lrlibrary");
    fixture_package(&a, &valid);
    for (index, edit) in (0..9).enumerate() {
        let bad = root.path().join(format!("bad{index}.lrlibrary"));
        rewrite_manifest(&valid, &bad, |p| {
            match edit {
                0 => p["version"] = json!(99),
                1 => p["assets"][0]["folderId"] = json!("foreign-folder"),
                2 => p["assets"][0]["tagIds"] = json!(["foreign-tag"]),
                3 => p["preferences"] = json!({"token":"secret"}),
                4 => {
                    let duplicate = p["assets"][0].clone();
                    p["assets"].as_array_mut().unwrap().push(duplicate);
                }
                5 => {
                    p["folders"] = json!([{"id":"cycle","parentId":"cycle","name":"cycle","sortOrder":0,"open":true,"createdAt":"2026-09-29T00:00:00Z","updatedAt":"2026-09-29T00:00:00Z"}])
                }
                6 => {
                    p["assets"][0]["sourceUrl"] =
                        json!("https://example.test/image?access_token=credential")
                }
                7 => p["complete"] = json!(false),
                _ => p["catalogSchema"] = json!(99),
            };
        });
        let independent = setup();
        let dest = tempfile::tempdir().unwrap();
        let m = LibraryTransferManager::default();
        assert!(m
            .start_restore(
                independent.clone(),
                &independent.library_state().unwrap().0,
                &unique_id("transfer"),
                bad.to_str().unwrap(),
                dest.path().to_str().unwrap(),
                "恢复"
            )
            .is_err());
        assert_eq!(independent.list_libraries(true).unwrap().len(), 1);
        assert!(std::fs::read_dir(dest.path()).unwrap().next().is_none());
    }
    let corrupt = root.path().join("corrupt.lrlibrary");
    rewrite(
        &valid,
        &corrupt,
        |n, mut b| {
            if n.starts_with("media/") {
                b[0] ^= 1;
            }
            b
        },
        None,
    );
    inspect_package(&corrupt).unwrap();
    let independent = setup();
    let anchor = independent.library_state().unwrap().0;
    let dest = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    m.start_restore(
        independent.clone(),
        &anchor,
        &id,
        corrupt.to_str().unwrap(),
        dest.path().to_str().unwrap(),
        "恢复",
    )
    .unwrap();
    assert_eq!(wait(&m, &independent, &anchor, &id).phase, "failed");
    assert_eq!(independent.list_libraries(true).unwrap().len(), 1);
}
#[test]
fn copy_preserves_source_and_has_independent_owned_files() {
    let c = setup();
    let a = lib(&c, "A");
    let b = lib(&c, "B");
    let original = add(&a, "图片.png", b"real media");
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    let anchor = a.library_scope_key().unwrap();
    let target = b.library_scope_key().unwrap();
    m.start_copy(
        c.clone(),
        &anchor,
        &id,
        &target,
        TransferSelection {
            asset_ids: Some(vec![original.id.clone()]),
            folder_id: None,
        },
    )
    .unwrap();
    let result = wait(&m, &c, &anchor, &id);
    assert_eq!(result.phase, "completed", "{result:?}");
    assert_eq!(result.copied, 1);
    let copied = b.list_assets(&MaterialFilter::default()).unwrap().remove(0);
    assert_ne!(copied.id, original.id);
    assert_ne!(copied.library_path, original.library_path);
    assert_eq!(copied.description, original.description);
    b.delete_asset(&copied.id, true).unwrap();
    assert_eq!(a.get_assets(&[original.id.clone()]).unwrap()[0], original);
    assert_eq!(
        std::fs::read(original.library_path.unwrap()).unwrap(),
        b"real media"
    );
}
#[test]
fn real_zip_roundtrip_to_independent_installation() {
    let c = setup();
    let a = lib(&c, "中文库");
    let original = add(&a, "中文.png", b"portable media");
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("中文.lrlibrary");
    let anchor = a.library_scope_key().unwrap();
    let m = LibraryTransferManager::default();
    let export = unique_id("transfer");
    m.start_export(c.clone(), &anchor, &export, output.to_str().unwrap())
        .unwrap();
    let result = wait(&m, &c, &anchor, &export);
    assert_eq!(result.phase, "completed", "{result:?}");
    let p = inspect_package(&output).unwrap();
    assert_eq!(p.assets[0].description, original.description);
    assert_eq!(p.assets[0].size_bytes, 14);
    assert_eq!(
        p.assets[0].source_url.as_deref(),
        Some("https://example.test/art/42")
    );
    let independent = setup();
    let default = independent.library_state().unwrap().0;
    let dest = tempfile::tempdir().unwrap();
    let import = unique_id("transfer");
    m.start_restore(
        independent.clone(),
        &default,
        &import,
        output.to_str().unwrap(),
        dest.path().to_str().unwrap(),
        "恢复库",
    )
    .unwrap();
    let restored = wait(&m, &independent, &default, &import);
    assert_eq!(restored.phase, "completed", "{restored:?}");
    let b = independent
        .for_library(restored.target_library_id.as_ref().unwrap())
        .unwrap();
    let copied = b.list_assets(&MaterialFilter::default()).unwrap().remove(0);
    assert_ne!(copied.id, original.id);
    assert_eq!(copied.name, original.name);
    assert_eq!(copied.description, original.description);
    assert_eq!(copied.content_hash, original.content_hash);
    assert_eq!(
        std::fs::read(copied.library_path.unwrap()).unwrap(),
        b"portable media"
    );
    let again = m
        .start_restore(
            independent.clone(),
            &default,
            &import,
            output.to_str().unwrap(),
            dest.path().to_str().unwrap(),
            "恢复库",
        )
        .unwrap();
    assert_eq!(again.phase, "completed");
    assert_eq!(independent.list_libraries(true).unwrap().len(), 2);
}

#[test]
fn linked_and_source_media_restore_with_fresh_identity_and_same_name_suffix() {
    let c = setup();
    let a = lib(&c, "同名库");
    let originals = tempfile::tempdir().unwrap();
    let mut source_assets = Vec::new();
    for mode in ["linked", "source"] {
        let path = originals.path().join(format!("{mode}.png"));
        std::fs::write(&path, format!("external-{mode}-bytes")).unwrap();
        source_assets.push(
            a.import_paths(
                &[path],
                &MaterialImportOptions {
                    storage_mode: mode.into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0),
        );
    }
    let anchor = a.library_scope_key().unwrap();
    let m = LibraryTransferManager::default();
    let output = tempfile::tempdir().unwrap();
    let package = output.path().join("portable.lrlibrary");
    let export = unique_id("transfer");
    m.start_export(c.clone(), &anchor, &export, package.to_str().unwrap())
        .unwrap();
    c.select_library(&c.library_state().unwrap().0).unwrap();
    assert_eq!(wait(&m, &c, &anchor, &export).phase, "completed");
    let p = inspect_package(&package).unwrap();
    assert!(!serde_json::to_string(&p)
        .unwrap()
        .contains(originals.path().to_str().unwrap()));
    let mut target_ids = Vec::new();
    for suffix in [2, 3] {
        let root = tempfile::tempdir().unwrap();
        let id = unique_id("transfer");
        m.start_restore(
            c.clone(),
            &anchor,
            &id,
            package.to_str().unwrap(),
            root.path().to_str().unwrap(),
            "同名库",
        )
        .unwrap();
        let done = wait(&m, &c, &anchor, &id);
        assert_eq!(done.phase, "completed", "{done:?}");
        assert_eq!(
            done.target_name.as_deref(),
            Some(format!("同名库（导入 {suffix}）").as_str())
        );
        let target = c
            .for_library(done.target_library_id.as_ref().unwrap())
            .unwrap();
        for restored in target.list_assets(&MaterialFilter::default()).unwrap() {
            let original = source_assets
                .iter()
                .find(|a| a.name == restored.name)
                .unwrap();
            assert_eq!(restored.storage_mode, "managed");
            assert_ne!(restored.id, original.id);
            assert_eq!(
                std::fs::read(restored.library_path.as_ref().unwrap()).unwrap(),
                std::fs::read(&original.original_path).unwrap()
            );
            target.delete_asset(&restored.id, true).unwrap();
            assert!(Path::new(&original.original_path).is_file());
        }
        target_ids.push(done.target_library_id.unwrap());
    }
    assert_ne!(target_ids[0], target_ids[1]);
    assert_ne!(target_ids[0], anchor);
    for asset in &source_assets {
        assert_eq!(a.get_assets(&[asset.id.clone()]).unwrap()[0], *asset);
    }
}

#[test]
fn retry_preserves_human_target_deletion_and_renamed_organization() {
    let c = setup();
    let a = lib(&c, "源");
    let b = lib(&c, "目标");
    let folder = a
        .create_folder(MaterialFolderInput {
            name: "原分类".into(),
            parent_id: None,
        })
        .unwrap()
        .value;
    let tag = a
        .create_tag("原标签", Some("#112233".into()))
        .unwrap()
        .value;
    let one = add(&a, "one.png", b"one");
    let missing = add(&a, "two.png", b"two");
    for asset in [&one, &missing] {
        a.move_asset(&asset.id, Some(&folder.id)).unwrap();
        a.set_asset_tags(&asset.id, vec![tag.id.clone()]).unwrap();
    }
    let original = missing.library_path.as_ref().unwrap();
    let away = format!("{original}.offline");
    std::fs::rename(original, &away).unwrap();
    let anchor = a.library_scope_key().unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    m.start_copy(
        c.clone(),
        &anchor,
        &id,
        &b.library_scope_key().unwrap(),
        TransferSelection::default(),
    )
    .unwrap();
    let partial = wait(&m, &c, &anchor, &id);
    assert_eq!(partial.phase, "partial");
    let copied = b.list_assets(&MaterialFilter::default()).unwrap().remove(0);
    let target_folder = b.list_folders().unwrap().remove(0);
    let target_tag = b.list_tags().unwrap().remove(0);
    b.rename_folder(&target_folder.id, "人工改名").unwrap();
    b.update_tag(
        &target_tag.id,
        MaterialTagPatch {
            name: Some("人工标签".into()),
            color: PatchValue::Value(Some("#ffffff".into())),
        },
    )
    .unwrap();
    b.delete_asset(&copied.id, true).unwrap();
    std::fs::rename(&away, original).unwrap();
    let recovered = LibraryTransferManager::default();
    recovered.retry(c.clone(), &anchor, &id).unwrap();
    let done = wait(&recovered, &c, &anchor, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    let assets = b.list_assets(&MaterialFilter::default()).unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].name, "two.png");
    assert_eq!(
        assets[0].folder_id.as_deref(),
        Some(target_folder.id.as_str())
    );
    let folders = b.list_folders().unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].name, "人工改名");
    let tags = b.list_tags().unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].name, "人工标签");
    assert_eq!(tags[0].color.as_deref(), Some("#ffffff"));
    assert_eq!(b.get_asset_tags(&assets[0].id).unwrap()[0], target_tag.id);
}

#[test]
fn durable_export_recovers_after_file_publish_before_completed_ledger() {
    let c = setup();
    let a = lib(&c, "源");
    add(&a, "one.png", b"one");
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("recover.lrlibrary");
    let anchor = a.library_scope_key().unwrap();
    let id = unique_id("transfer");
    let connection = c.open_write().unwrap();
    connection.execute_batch("CREATE TRIGGER export_commit_failure BEFORE UPDATE ON material_library_transfer WHEN NEW.phase='completed' BEGIN SELECT RAISE(ABORT,'injected-export-completion'); END;").unwrap();
    let m = LibraryTransferManager::default();
    m.start_export(c.clone(), &anchor, &id, output.to_str().unwrap())
        .unwrap();
    assert_eq!(wait(&m, &c, &anchor, &id).phase, "failed");
    assert!(output.is_file());
    let bytes = std::fs::read(&output).unwrap();
    connection
        .execute_batch("DROP TRIGGER export_commit_failure")
        .unwrap();
    let recovered = LibraryTransferManager::default();
    recovered.retry(c.clone(), &anchor, &id).unwrap();
    assert_eq!(wait(&recovered, &c, &anchor, &id).phase, "completed");
    assert_eq!(std::fs::read(&output).unwrap(), bytes);
    assert!(recovered
        .start_export(
            c.clone(),
            &anchor,
            &id,
            root.path().join("different.lrlibrary").to_str().unwrap()
        )
        .is_err());
    assert_eq!(
        recovered.retry(c.clone(), &anchor, &id).unwrap().phase,
        "completed"
    );
}

#[test]
fn protected_watch_roots_and_new_user_files_are_never_overwritten() {
    let c = setup();
    let a = lib(&c, "源");
    add(&a, "large.png", &vec![7; 2 * 1024 * 1024]);
    let watch = tempfile::tempdir().unwrap();
    let anchor = a.library_scope_key().unwrap();
    a.save_library_preferences(&anchor,json!({"luckyray-material-watch-sources-v1":json!([{"enabled":true,"path":watch.path().to_str().unwrap()}]).to_string()})).unwrap();
    let m = LibraryTransferManager::default();
    assert!(m
        .start_export(
            c.clone(),
            &anchor,
            &unique_id("transfer"),
            watch.path().join("bad.lrlibrary").to_str().unwrap()
        )
        .is_err());
    let output = tempfile::tempdir().unwrap();
    let package = output.path().join("valid.lrlibrary");
    fixture_package(&a, &package);
    assert!(m
        .start_restore(
            c.clone(),
            &anchor,
            &unique_id("transfer"),
            package.to_str().unwrap(),
            watch.path().to_str().unwrap(),
            "恢复"
        )
        .is_err());
    let independent = setup();
    let owner = independent.library_state().unwrap().0;
    let root = tempfile::tempdir().unwrap();
    *m.test_pause_ms.lock().unwrap() = 40;
    let id = unique_id("transfer");
    m.start_restore(
        independent.clone(),
        &owner,
        &id,
        package.to_str().unwrap(),
        root.path().to_str().unwrap(),
        "恢复",
    )
    .unwrap();
    await_phase(&m, &independent, &owner, &id, "staging");
    // A user may write into the previously empty directory while the picker is closed.
    let user_file = root.path().join("用户文件.txt");
    std::fs::write(&user_file, b"user-owned").unwrap();
    let result = wait(&m, &independent, &owner, &id);
    assert_eq!(result.phase, "failed", "{result:?}");
    assert_eq!(independent.list_libraries(true).unwrap().len(), 1);
    assert_eq!(std::fs::read(user_file).unwrap(), b"user-owned");
}

#[test]
fn target_relocation_during_copy_cannot_retarget_the_frozen_operation() {
    let c = setup();
    let a = lib(&c, "源");
    let b = lib(&c, "目标");
    let original = add(&a, "large.png", &vec![1; 4 * 1024 * 1024]);
    let anchor = a.library_scope_key().unwrap();
    let target = b.library_scope_key().unwrap();
    let old = b
        .import_library_root(None)
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let replacement = tempfile::tempdir().unwrap();
    std::fs::copy(
        old.join("library.json"),
        replacement.path().join("library.json"),
    )
    .unwrap();
    std::fs::create_dir(replacement.path().join("assets")).unwrap();
    let m = LibraryTransferManager::default();
    *m.test_pause_ms.lock().unwrap() = 40;
    let id = unique_id("transfer");
    m.start_copy(
        c.clone(),
        &anchor,
        &id,
        &target,
        TransferSelection::default(),
    )
    .unwrap();
    await_phase(&m, &c, &anchor, &id, "staging");
    std::fs::remove_file(old.join("library.json")).unwrap();
    c.relocate_library(&target, replacement.path()).unwrap();
    let result = wait(&m, &c, &anchor, &id);
    assert_eq!(result.phase, "failed", "{result:?}");
    assert!(c
        .for_library(&target)
        .unwrap()
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
    assert!(std::fs::read_dir(replacement.path().join("assets"))
        .unwrap()
        .next()
        .is_none());
    assert_eq!(a.get_assets(&[original.id.clone()]).unwrap()[0], original);
}
