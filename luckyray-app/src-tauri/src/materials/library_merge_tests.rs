//! MAT-LIB-R3-B tests: honest merge preview and a merge that keeps the
//! source library and the target's human metadata intact.
use super::super::catalog::unique_id;
use super::super::library_transfer::*;
use super::*;
use serde_json::json;
use std::path::Path;
use std::time::{Duration, Instant};

fn setup() -> MaterialCatalog {
    let c = MaterialCatalog::new_for_test();
    apply_transfer_schema(&c.open_write().unwrap()).unwrap();
    c
}

fn lib(c: &MaterialCatalog, name: &str) -> MaterialCatalog {
    let root = tempfile::tempdir().unwrap().keep();
    let library = c.create_library(name, &root, "managed").unwrap();
    c.for_library(&library.id).unwrap()
}

fn add(c: &MaterialCatalog, name: &str, bytes: &[u8], description: &str) -> MaterialAsset {
    let result = c
        .import_bytes(
            vec![MaterialBytesInput {
                name: name.into(),
                original_path: "https://example.test/art/42".into(),
                mime_type: "image/png".into(),
                bytes: bytes.into(),
                description: Some(description.into()),
            }],
            &MaterialImportOptions::default(),
        )
        .unwrap()
        .value;
    result.assets[0].clone()
}

fn wait(m: &LibraryTransferManager, c: &MaterialCatalog, anchor: &str, id: &str) -> TransferStatus {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let s = m.status(c, anchor, id).unwrap();
        if matches!(s.phase.as_str(), "completed" | "partial" | "failed" | "cancelled") {
            return s;
        }
        assert!(Instant::now() < deadline, "timeout: {s:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn merge_preview_reports_mapping_skips_and_name_clashes() {
    let c = setup();
    let source = lib(&c, "源库");
    let target = lib(&c, "目标库");
    let source_id = source.library_scope_key().unwrap();
    let target_id = target.library_scope_key().unwrap();

    let twin_source = add(&source, "源版本.png", b"same-bytes", "源库描述");
    let _clash = add(&source, "同名素材.png", b"source-unique", "源库描述");
    source.create_folder(MaterialFolderInput { parent_id: None, name: "分类甲".into() }).unwrap();
    let source_tag = source.create_tag("同名标签", Some("red".into())).unwrap().value;
    source.set_asset_tags(&twin_source.id, vec![source_tag.id]).unwrap();

    let twin_target = add(&target, "目标人工名.png", b"same-bytes", "目标库人工描述");
    let _target_clash = add(&target, "同名素材.png", b"target-unique", "目标描述");
    target.create_folder(MaterialFolderInput { parent_id: None, name: "分类甲".into() }).unwrap();
    target.create_tag("同名标签", Some("blue".into())).unwrap();
    let _ = twin_target;

    assert!(super::preview_merge(&c, &source_id, &source_id).unwrap_err().message.contains("另一个"));
    let plan = super::preview_merge(&c, &target_id, &source_id).unwrap();
    assert_eq!(plan["sourceName"], json!("源库"));
    assert_eq!(plan["targetName"], json!("目标库"));
    assert_eq!(plan["assets"]["total"], json!(2));
    assert_eq!(plan["assets"]["identicalContent"], json!(1));
    assert_eq!(plan["assets"]["newCopies"], json!(1));
    assert_eq!(plan["folders"]["mapped"], json!(0));
    assert_eq!(plan["folders"]["omitted"], json!(1));
    assert_eq!(plan["tags"]["mapped"], json!(0));
    assert_eq!(plan["tags"]["omitted"], json!(1));
    let identical = plan["identical"].as_array().unwrap();
    assert_eq!(identical.len(), 1);
    assert_eq!(identical[0]["sourceName"], json!("源版本.png"));
    assert_eq!(identical[0]["targetName"], json!("目标人工名.png"));
    assert_eq!(identical[0]["metadataDiffers"], json!(true));
    let conflicts = plan["nameConflicts"].as_array().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0]["name"], json!("同名素材.png"));
    let notes = plan["notes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<_>>()
        .join("；");
    assert!(notes.contains("跳过复制"), "{notes}");
    assert!(notes.contains("目标库已有版本"), "{notes}");
    assert!(notes.contains("显示名称不是身份"), "{notes}");
    assert!(notes.contains("从列表中移除"), "{notes}");
}

#[test]
fn merge_run_delegates_to_copy_and_preserves_both_sides() {
    let c = setup();
    let source = lib(&c, "源库");
    let target = lib(&c, "目标库");
    let source_id = source.library_scope_key().unwrap();
    let target_id = target.library_scope_key().unwrap();

    let twin_source = add(&source, "源版本.png", b"same-bytes", "源库描述");
    let clash = add(&source, "同名素材.png", b"source-unique", "源库描述");
    source.create_tag("同名标签", Some("red".into())).unwrap();

    let twin_target = add(&target, "目标人工名.png", b"same-bytes", "目标库人工描述");
    let _target_clash = add(&target, "同名素材.png", b"target-unique", "目标描述");
    target.create_tag("同名标签", Some("blue".into())).unwrap();
    let mut tags = source.list_tags().unwrap();
    let source_tag = tags.remove(0);
    source.set_asset_tags(&twin_source.id, vec![source_tag.id.clone()]).unwrap();

    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    let started = super::start_merge(&m, c.clone(), &target_id, &id, &source_id).unwrap();
    assert_eq!(started.kind, "copy");
    assert_eq!(started.source_library_id, source_id);
    assert_eq!(started.target_library_id.as_deref(), Some(target_id.as_str()));
    let done = wait(&m, &c, &source_id, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    assert_eq!(done.skipped, 1, "identical content skips copying");
    assert_eq!(done.copied, 1);

    // Target keeps its own human metadata for the identical asset.
    let kept: (String, String) = c
        .open_read()
        .unwrap()
        .query_row(
            "SELECT name,description FROM asset WHERE id=?1",
            [&twin_target.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(kept, ("目标人工名.png".into(), "目标库人工描述".into()));

    // Same name, different content: both coexist in the target.
    let names: Vec<String> = {
        let conn = c.open_read().unwrap();
        let mut statement = conn
            .prepare(
                "SELECT a.name FROM asset a JOIN material_library_asset m ON m.asset_id=a.id \
                 WHERE m.library_id=?1 ORDER BY a.name,a.id",
            )
            .unwrap();
        statement
            .query_map([&target_id], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(
        names.iter().filter(|n| n.as_str() == "同名素材.png").count(),
        2,
        "{names:?}"
    );

    // The merged copy gets a fresh target identity and carries the source
    // description; the source library and its files stay fully registered.
    let merged_id = done
        .items
        .iter()
        .find(|i| i.asset_id == clash.id)
        .and_then(|i| i.target_asset_id.clone())
        .expect("merged asset identity");
    assert_ne!(merged_id, clash.id, "display name is not the identity");
    let merged: (String, String, String) = c
        .open_read()
        .unwrap()
        .query_row(
            "SELECT a.name,a.description,a.library_path FROM asset a JOIN material_library_asset m ON m.asset_id=a.id \
             WHERE m.library_id=?1 AND a.id=?2",
            rusqlite::params![target_id, merged_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(merged.0, "同名素材.png");
    assert_eq!(merged.1, "源库描述");
    assert!(Path::new(&merged.2).is_file(), "merged media exists in target root");
    let source_members: i64 = c
        .open_read()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM material_library_asset WHERE library_id=?1",
            [&source_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source_members, 2, "source registration untouched");
    assert!(Path::new(clash.library_path.as_deref().unwrap()).is_file());
    assert!(Path::new(twin_source.library_path.as_deref().unwrap()).is_file());

    // The merge is visible in the source library's task history.
    let restarted = LibraryTransferManager::default();
    let listed = restarted.list(&c, &source_id, false).unwrap();
    assert!(listed.iter().any(|s| s.task_id == id && s.phase == "completed"));
}

#[test]
fn merge_commands_flow_through_the_library_request_surface() {
    let c = setup();
    let source = lib(&c, "命令源库");
    let target = lib(&c, "命令目标库");
    let source_id = source.library_scope_key().unwrap();
    let target_id = target.library_scope_key().unwrap();
    add(&source, "素材.png", b"bytes", "描述");

    let no_target: LibraryRequest =
        serde_json::from_value(json!({"libraryId":null,"action":{"op":"mergeLibraryPreview","sourceId": source_id}})).unwrap();
    assert!(execute_library_request(c.clone(), no_target)
        .unwrap_err()
        .contains("library-context-required"));

    let preview: LibraryRequest = serde_json::from_value(json!({
        "libraryId": target_id,
        "action": {"op":"mergeLibraryPreview","sourceId": source_id}
    }))
    .unwrap();
    let plan = execute_library_request(c.clone(), preview).unwrap();
    assert_eq!(plan["assets"]["newCopies"], json!(1));

    let id = unique_id("transfer");
    let start: LibraryRequest = serde_json::from_value(json!({
        "libraryId": target_id,
        "action": {"op":"mergeLibrary","requestId": id, "sourceId": source_id}
    }))
    .unwrap();
    let started = execute_library_request(c.clone(), start).unwrap();
    assert_eq!(started["taskId"], json!(id));
    let done = wait(library_transfer_manager(), &c, &source_id, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    let target_assets: i64 = c
        .open_read()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM material_library_asset WHERE library_id=?1",
            [&target_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(target_assets, 1);
}

fn folder(c: &MaterialCatalog, parent_id: Option<&str>, name: &str) -> MaterialFolder {
    c.create_folder(MaterialFolderInput { parent_id: parent_id.map(String::from), name: name.into() }).unwrap().value
}
fn flattened_folders(tree: &[MaterialFolder]) -> Vec<&MaterialFolder> {
    let mut result = vec![];
    for folder in tree { result.push(folder); result.extend(flattened_folders(&folder.children)); }
    result
}
#[test]
fn merge_preview_and_commit_share_parent_mapping_and_actual_used_organization() {
    let c = setup(); let source = lib(&c,"规划源"); let target = lib(&c,"规划目标");
    let source_id = source.library_scope_key().unwrap(); let target_id = target.library_scope_key().unwrap();
    let sa = folder(&source,None,"项目甲"); let sax = folder(&source,Some(&sa.id),"共享");
    let sb = folder(&source,None,"项目乙"); let sbx = folder(&source,Some(&sb.id),"共享");
    folder(&source,None,"空分类"); let duplicate_only = folder(&source,None,"仅重复分类");
    let ta = folder(&target,None,"项目甲"); let tax = folder(&target,Some(&ta.id),"共享");
    let other = folder(&target,None,"别的父级"); folder(&target,Some(&other.id),"共享");
    let used = source.create_tag("已用同名",Some("red".into())).unwrap().value;
    let new_tag = source.create_tag("已用新标签",None).unwrap().value;
    source.create_tag("未使用",None).unwrap();
    let duplicate_tag = source.create_tag("仅重复素材使用",None).unwrap().value;
    target.create_tag("已用同名",Some("blue".into())).unwrap();
    let first = add(&source,"新增甲.png",b"new-a","新甲描述"); source.move_asset(&first.id,Some(&sax.id)).unwrap(); source.set_asset_tags(&first.id,vec![used.id]).unwrap();
    let second = add(&source,"新增乙.png",b"new-b","新乙描述"); source.move_asset(&second.id,Some(&sbx.id)).unwrap(); source.set_asset_tags(&second.id,vec![new_tag.id]).unwrap();
    let duplicate = add(&source,"源人工名.png",b"same-unique-content","不同人工描述"); source.move_asset(&duplicate.id,Some(&duplicate_only.id)).unwrap(); source.set_asset_tags(&duplicate.id,vec![duplicate_tag.id]).unwrap();
    let kept = add(&target,"目标人工名.png",b"same-unique-content","目标人工描述");
    let source_before = source.list_assets(&MaterialFilter::default()).unwrap();
    let folders_before = flattened_folders(&target.list_folders().unwrap()).len(); let tags_before = target.list_tags().unwrap().len();
    let preview = super::preview_merge(&c,&target_id,&source_id).unwrap();
    assert_eq!(preview["folders"],json!({"total":6,"mapped":2,"new":2,"omitted":2}));
    assert_eq!(preview["tags"],json!({"total":4,"mapped":1,"new":1,"omitted":2}));
    assert_eq!(preview["assets"]["newCopies"],json!(2)); assert_eq!(preview["assets"]["metadataConflicts"],json!(1));
    let differences = preview["identical"][0]["metadataDifferences"].as_array().unwrap();
    for field in ["名称","描述","分类","标签"] { assert!(differences.contains(&json!(field)),"{preview}"); }
    let manager = LibraryTransferManager::default(); let id = unique_id("transfer");
    super::start_merge(&manager,c.clone(),&target_id,&id,&source_id).unwrap();
    let done = wait(&manager,&c,&source_id,&id); assert_eq!(done.phase,"completed","{done:?}");
    assert_eq!(done.copied,preview["assets"]["newCopies"].as_u64().unwrap() as usize);
    assert_eq!(done.skipped,preview["assets"]["identicalContent"].as_u64().unwrap() as usize);
    let tree = target.list_folders().unwrap(); let folders = flattened_folders(&tree); let tags = target.list_tags().unwrap();
    assert_eq!(folders.len()-folders_before,preview["folders"]["new"].as_u64().unwrap() as usize);
    assert_eq!(tags.len()-tags_before,preview["tags"]["new"].as_u64().unwrap() as usize);
    assert!(!folders.iter().any(|f| f.name=="空分类" || f.name=="仅重复分类"));
    assert!(!tags.iter().any(|t| t.name=="未使用" || t.name=="仅重复素材使用"));
    let copied_first = done.items.iter().find(|i| i.asset_id==first.id).unwrap().target_asset_id.clone().unwrap();
    assert_eq!(target.get_assets(&[copied_first]).unwrap()[0].folder_id,Some(tax.id));
    let new_parent = folders.iter().find(|f|f.name=="项目乙").unwrap();
    let new_child = folders.iter().find(|f|f.name=="共享" && f.parent_id.as_ref()==Some(&new_parent.id)).unwrap();
    let copied_second = done.items.iter().find(|i|i.asset_id==second.id).unwrap().target_asset_id.clone().unwrap();
    assert_eq!(target.get_assets(&[copied_second]).unwrap()[0].folder_id,Some(new_child.id.clone()));
    assert_eq!(target.get_assets(&[kept.id.clone()]).unwrap()[0],kept);
    assert_eq!(source.list_assets(&MaterialFilter::default()).unwrap(),source_before);
    assert!(Path::new(duplicate.library_path.as_ref().unwrap()).is_file());
}
#[test]
fn merge_preview_hashes_current_bytes_instead_of_cached_hash() {
    let c=setup(); let source=lib(&c,"摘要源"); let target=lib(&c,"摘要目标");
    let asset=add(&source,"源.png",b"old-cached-content","源描述");
    let kept=add(&target,"目标.png",b"actual-current-content","保留描述");
    std::fs::write(asset.library_path.as_ref().unwrap(),b"actual-current-content").unwrap();
    let source_id=source.library_scope_key().unwrap(); let target_id=target.library_scope_key().unwrap();
    let preview=super::preview_merge(&c,&target_id,&source_id).unwrap();
    assert_eq!(preview["assets"]["identicalContent"],json!(1)); assert_eq!(preview["assets"]["newCopies"],json!(0));
    let manager=LibraryTransferManager::default(); let id=unique_id("transfer");
    super::start_merge(&manager,c.clone(),&target_id,&id,&source_id).unwrap();
    let done=wait(&manager,&c,&source_id,&id); assert_eq!(done.phase,"completed","{done:?}"); assert_eq!((done.copied,done.skipped),(0,1));
    assert_eq!(target.get_assets(&[kept.id.clone()]).unwrap()[0],kept);
}
