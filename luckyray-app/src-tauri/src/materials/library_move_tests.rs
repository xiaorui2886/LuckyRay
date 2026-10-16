//! MAT-LIB-R3-A tests: preview honesty, staged authority switch, and
//! recovery from cancel/interrupt without half-moved libraries.
use super::super::library_archive::*;
use super::super::library_transfer::*;
use super::*;
use super::super::catalog::unique_id;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
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

fn add(c: &MaterialCatalog, name: &str, bytes: &[u8]) -> MaterialAsset {
    let result = c
        .import_bytes(
            vec![MaterialBytesInput {
                name: name.into(),
                original_path: "https://example.test/art/42".into(),
                mime_type: "image/png".into(),
                bytes: bytes.into(),
                description: Some("可移动描述".into()),
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

fn await_phase(
    m: &LibraryTransferManager,
    c: &MaterialCatalog,
    anchor: &str,
    id: &str,
    phase: &str,
) -> TransferStatus {
    let deadline = Instant::now() + Duration::from_secs(30);
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

fn root_of(c: &MaterialCatalog, anchor: &str) -> PathBuf {
    PathBuf::from(
        c.open_read()
            .unwrap()
            .query_row(
                "SELECT root_path FROM material_library WHERE id=?1",
                [anchor],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
    )
}

fn marker_at(old_root: &Path) -> Option<PathBuf> {
    std::fs::read_dir(old_root)
        .ok()?
        .map(|entry| entry.ok().map(|e| e.path()))
        .flatten()
        .find(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(".luckyray-moved-"))
        })
}

#[test]
fn preview_reports_impact_and_refuses_unsafe_targets() {
    let c = setup();
    let a = lib(&c, "源库");
    let asset = add(&a, "素材.png", b"bytes");
    let anchor = a.library_scope_key().unwrap();
    let old_root = root_of(&c, &anchor);
    let watch = tempfile::tempdir().unwrap();
    a.save_library_preferences(&anchor, json!({"luckyray-material-watch-sources-v1":json!([{"enabled":true,"path":watch.path().to_str().unwrap()}]).to_string()})).unwrap();

    let legacy = setup();
    let legacy_id = legacy.library_state().unwrap().0;
    let fresh = tempfile::tempdir().unwrap();
    assert!(LibraryTransferManager::default()
        .preview_library_move(&legacy, &legacy_id, fresh.path())
        .unwrap_err()
        .message
        .contains("默认兼容库"));

    let m = LibraryTransferManager::default();
    let same = m.preview_library_move(&c, &anchor, &old_root);
    assert!(same.unwrap_err().message.contains("相同"));
    std::fs::create_dir_all(old_root.join("inner")).unwrap();
    let nested = m.preview_library_move(&c, &anchor, &old_root.join("inner"));
    assert!(nested.unwrap_err().message.contains("内部"));
    let non_empty = tempfile::tempdir().unwrap();
    std::fs::write(non_empty.path().join("已有.txt"), b"x").unwrap();
    assert!(m
        .preview_library_move(&c, &anchor, non_empty.path())
        .unwrap_err()
        .message
        .contains("不为空"));
    let relocated = tempfile::tempdir().unwrap();
    std::fs::write(
        relocated.path().join("library.json"),
        br#"{"format":1,"libraryId":"other"}"#,
    )
    .unwrap();
    assert!(m
        .preview_library_move(&c, &anchor, relocated.path())
        .unwrap_err()
        .message
        .contains("重新定位"));
    assert!(m
        .preview_library_move(&c, &anchor, watch.path())
        .is_err());
    assert!(m
        .preview_library_move(&c, &anchor, c.app_data_dir())
        .is_err());

    let target = tempfile::tempdir().unwrap();
    let plan = m.preview_library_move(&c, &anchor, target.path()).unwrap();
    assert_eq!(plan["managedAssets"], json!(1));
    assert_eq!(plan["managedBytes"], json!(asset.size_bytes.unwrap_or(0)));
    assert_eq!(plan["linkedAssets"], json!(0));
    assert_eq!(plan["oldRoot"], json!(old_root.to_string_lossy()));
    assert!(plan.get("sharedRootOtherLibraries").is_none());
    let excluded = plan["excluded"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<_>>()
        .join("；");
    assert!(excluded.contains("Vault 附件"));
}

#[test]
fn move_switches_authority_preserving_identity_and_originals() {
    let c = setup();
    let a = lib(&c, "源库");
    let first = add(&a, "中文素材.png", b"first-bytes");
    let second = add(&a, "second.png", &vec![7; 2 * 1024 * 1024]);
    let folder = a
        .create_folder(MaterialFolderInput {
            parent_id: None,
            name: "分类甲".into(),
        })
        .unwrap()
        .value;
    let tag = a.create_tag("标签乙", Some("#112233".into())).unwrap().value;
    a.set_asset_tags(&first.id, vec![tag.id.clone()]).unwrap();
    a.move_asset(&first.id, Some(&folder.id)).unwrap();
    let anchor = a.library_scope_key().unwrap();
    let old_root = root_of(&c, &anchor);
    let old_first = first.library_path.clone().unwrap();
    let old_second = second.library_path.clone().unwrap();

    let target = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    let started = m
        .start_move(c.clone(), &anchor, &id, target.path().to_str().unwrap())
        .unwrap();
    assert_eq!(started.kind, "move");
    assert!(
        started
            .target_name
            .as_deref()
            .is_some_and(|name| Path::new(name) == target.path().canonicalize().unwrap())
    );
    let done = wait(&m, &c, &anchor, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    assert_eq!(done.copied, 2);
    assert!(done.items.iter().all(|i| i.state == "copied"));

    // The authority moved; every identity, membership and preference stayed.
    assert_eq!(root_of(&c, &anchor), target.path().canonicalize().unwrap());
    let conn = c.open_read().unwrap();
    let (count, moved_first, moved_second): (i64, String, String) = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM material_library_asset WHERE library_id=?1), \
             (SELECT library_path FROM asset WHERE id=?2), \
             (SELECT library_path FROM asset WHERE id=?3)",
            [&anchor, &first.id, &second.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(count, 2);
    let target_root = target.path().canonicalize().unwrap();
    assert!(Path::new(&moved_first).starts_with(&target_root));
    assert!(Path::new(&moved_second).starts_with(&target_root));
    drop(conn);
    assert_eq!(std::fs::read(&moved_first).unwrap(), b"first-bytes");
    assert_eq!(std::fs::read(&moved_second).unwrap(), vec![7; 2 * 1024 * 1024]);
    assert_eq!(
        a.get_asset_tags(&first.id).unwrap(),
        vec![tag.id.clone()]
    );
    assert_eq!(
        a.list_assets(&MaterialFilter::default()).unwrap().len(),
        2
    );

    // Thumbnails follow the file convention (image thumbnails equal the file).
    let thumb: String = c
        .open_read()
        .unwrap()
        .query_row("SELECT thumbnail_url FROM asset WHERE id=?1", [&first.id], |r| r.get(0))
        .unwrap();
    assert_eq!(thumb, moved_first);

    // New root carries the same library identity and no pending marker.
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(target.path().join("library.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["libraryId"], json!(anchor));
    assert!(!target.path().join(format!(".luckyray-move-{id}.pending")).exists());

    // Originals are preserved and a recovery record explains them.
    assert!(Path::new(&old_first).is_file());
    assert!(Path::new(&old_second).is_file());
    let marker = marker_at(&old_root).expect("recovery marker");
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(&marker).unwrap()).unwrap();
    assert_eq!(record["libraryId"], json!(anchor));
    assert_eq!(
        record["movedTo"],
        json!(target.path().canonicalize().unwrap().to_string_lossy())
    );
    assert_eq!(record["files"].as_array().unwrap().len(), 2);
    assert!(record["note"].as_str().unwrap().contains("未删除"));

    // Restart view: the ledger keeps the finished move visible and retry is inert.
    let restarted = LibraryTransferManager::default();
    let listed = restarted.list(&c, &anchor, false).unwrap();
    assert!(listed.iter().any(|s| s.task_id == id && s.phase == "completed"));
    assert_eq!(
        restarted.retry(c.clone(), &anchor, &id).unwrap().phase,
        "completed"
    );
    assert_eq!(root_of(&c, &anchor), target.path().canonicalize().unwrap());
}

#[test]
fn move_cancel_keeps_old_authority_and_resumes_after_restart() {
    let c = setup();
    let a = lib(&c, "源库");
    add(&a, "large.png", &vec![9; 3 * 1024 * 1024]);
    let anchor = a.library_scope_key().unwrap();
    let old_root = root_of(&c, &anchor);
    let target = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    m.set_test_pause(30);
    let id = unique_id("transfer");
    m.start_move(c.clone(), &anchor, &id, target.path().to_str().unwrap())
        .unwrap();
    await_phase(&m, &c, &anchor, &id, "staging");
    m.cancel(&c, &anchor, &id).unwrap();
    let cancelled = wait(&m, &c, &anchor, &id);
    assert_eq!(cancelled.phase, "cancelled");

    // Old authority untouched; target keeps the pending marker only.
    assert_eq!(root_of(&c, &anchor), old_root.canonicalize().unwrap());
    assert!(target.path().join(format!(".luckyray-move-{id}.pending")).is_file());
    assert_eq!(
        c.open_read()
            .unwrap()
            .query_row(
                "SELECT library_path FROM asset JOIN material_library_asset ON asset_id=id WHERE library_id=?1",
                [&anchor],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
            .starts_with(old_root.to_string_lossy().as_ref()),
        true
    );

    // A crashed-looking journal is reported interrupted and stays retryable.
    c.open_write().unwrap().execute(
        "UPDATE material_library_transfer SET result_json=json_set(result_json,'$.phase','staging') WHERE id=?1",
        [&id],
    ).unwrap();
    let restarted = LibraryTransferManager::default();
    let persisted = restarted.status(&c, &anchor, &id).unwrap();
    assert_eq!(persisted.phase, "interrupted");
    assert!(persisted.retryable);
    restarted.retry(c.clone(), &anchor, &id).unwrap();
    let done = wait(&restarted, &c, &anchor, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    assert_eq!(root_of(&c, &anchor), target.path().canonicalize().unwrap());
    assert!(!target.path().join(format!(".luckyray-move-{id}.pending")).exists());
    assert!(a.list_assets(&MaterialFilter::default()).unwrap().len() == 1);
    let moved: String = c
        .open_read()
        .unwrap()
        .query_row(
            "SELECT library_path FROM asset JOIN material_library_asset ON asset_id=id WHERE library_id=?1",
            [&anchor],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        std::fs::read(&moved).unwrap(),
        vec![9; 3 * 1024 * 1024],
        "resumed copy must be byte-identical"
    );
    assert!(marker_at(&old_root).is_some(), "originals kept after resume");
}

#[test]
fn user_files_in_move_target_are_never_overwritten() {
    let c = setup();
    let a = lib(&c, "源库");
    let asset = add(&a, "keeper.png", &vec![3; 2 * 1024 * 1024]);
    let anchor = a.library_scope_key().unwrap();
    let old_root = root_of(&c, &anchor);
    let m = LibraryTransferManager::default();
    m.set_test_pause(40);

    // Foreign file at an unrelated path: the pre-commit ownership recheck
    // must stop the switch and leave the user's file untouched.
    let target = tempfile::tempdir().unwrap();
    let id = unique_id("transfer");
    m.start_move(c.clone(), &anchor, &id, target.path().to_str().unwrap())
        .unwrap();
    await_phase(&m, &c, &anchor, &id, "staging");
    let user_file = target.path().join("用户文件.txt");
    std::fs::write(&user_file, b"user-owned").unwrap();
    let result = wait(&m, &c, &anchor, &id);
    assert_eq!(result.phase, "failed", "{result:?}");
    assert!(result.error.as_deref().unwrap().contains("非任务文件"));
    assert_eq!(std::fs::read(&user_file).unwrap(), b"user-owned");
    assert_eq!(root_of(&c, &anchor), old_root.canonicalize().unwrap());

    // Foreign file colliding with an expected media path: never deleted.
    let collide = tempfile::tempdir().unwrap();
    let relative = Path::new(&asset.library_path.clone().unwrap())
        .strip_prefix(&old_root)
        .unwrap()
        .to_path_buf();
    let occupied = collide.path().join(&relative);
    std::fs::create_dir_all(occupied.parent().unwrap()).unwrap();
    std::fs::write(&occupied, b"user-owned-media").unwrap();
    let second = unique_id("transfer");
    let blocked = m
        .start_move(c.clone(), &anchor, &second, collide.path().to_str().unwrap())
        .unwrap_err();
    assert!(blocked.message.contains("不为空"));
    assert_eq!(std::fs::read(&occupied).unwrap(), b"user-owned-media");
}

#[test]
fn scattered_managed_files_and_shared_roots_are_explained_not_moved() {
    let c = setup();
    let a = lib(&c, "共享库");
    let asset = add(&a, "one.png", b"one");
    let anchor = a.library_scope_key().unwrap();
    let old_root = root_of(&c, &anchor);
    let outside = tempfile::tempdir().unwrap();
    let stray = outside.path().join("stray.png");
    std::fs::write(&stray, b"stray").unwrap();
    c.open_write().unwrap().execute(
        "UPDATE asset SET library_path=?1 WHERE id=?2",
        rusqlite::params![stray.to_string_lossy(), asset.id],
    ).unwrap();
    let m = LibraryTransferManager::default();
    let target = tempfile::tempdir().unwrap();
    let refused = m
        .preview_library_move(&c, &anchor, target.path())
        .unwrap_err();
    assert!(refused.message.contains("库根目录之外"), "{refused:?}");
    assert!(m
        .start_move(c.clone(), &anchor, &unique_id("transfer"), target.path().to_str().unwrap())
        .is_err());

    // The UNIQUE index on material_library.root_path structurally forbids a
    // second library sharing this root; confirm the invariant holds.
    assert!(c
        .open_write()
        .unwrap()
        .execute(
            "INSERT INTO material_library(id,name,root_path,storage_mode,visible,state,created_at,updated_at,preferences_json)              VALUES('sibling','同根库',?1,'managed',1,'ready','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','{}')",
            rusqlite::params![old_root.to_string_lossy()],
        )
        .is_err());
}

#[test]
fn move_preserves_linked_members_and_vault_attachments() {
    let c = setup();
    let a = lib(&c, "混合库");
    let managed = add(&a, "managed.png", b"managed");
    let anchor = a.library_scope_key().unwrap();
    let old_root = root_of(&c, &anchor);
    let linked_original = tempfile::tempdir().unwrap();
    let linked_path = linked_original.path().join("外部引用.png");
    std::fs::write(&linked_path, b"linked").unwrap();
    let linked_id = unique_id("asset");
    c.open_write().unwrap().execute(
        "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash) \
         VALUES(?1,'外部.png',?2,NULL,'linked','image','image/png',6,'','',NULL,NULL,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL)",
        rusqlite::params![linked_id, linked_path.to_string_lossy()],
    ).unwrap();
    c.open_write().unwrap().execute(
        "UPDATE material_library_asset SET library_id=?1 WHERE asset_id=?2",
        rusqlite::params![anchor, linked_id],
    ).unwrap();
    let vault_path = c.app_data_dir().join("attachment.md");
    std::fs::write(&vault_path, b"vault-owned").unwrap();
    let attachment = c.register_note_attachment(&vault_path, "vault-move", None).unwrap();

    let target = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    let started = m
        .start_move(c.clone(), &anchor, &id, target.path().to_str().unwrap())
        .unwrap();
    assert_eq!(started.total, 1, "only the managed member is a move item");
    let done = wait(&m, &c, &anchor, &id);
    assert_eq!(done.phase, "completed", "{done:?}");

    // Linked member keeps pointing at its original location.
    let linked_now: Option<String> = c
        .open_read()
        .unwrap()
        .query_row("SELECT library_path FROM asset WHERE id=?1", [&linked_id], |r| r.get(0))
        .unwrap();
    assert_eq!(linked_now, None);
    let linked_original_path: String = c
        .open_read()
        .unwrap()
        .query_row("SELECT original_path FROM asset WHERE id=?1", [&linked_id], |r| r.get(0))
        .unwrap();
    assert_eq!(linked_original_path, linked_path.to_string_lossy());
    assert!(!target.path().join("外部引用.png").exists());

    // Vault attachment projection is outside the move entirely.
    let vault_count: i64 = c
        .open_read()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM material_note_vault", [], |r| r.get(0))
        .unwrap();
    assert!(vault_count >= 1);
    let registered: i64 = c
        .open_read()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM material_library_asset WHERE asset_id=?1",
            [&attachment.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(registered, 0, "vault attachment never joins a library");
    assert!(Path::new(&vault_path).is_file());
    assert_eq!(std::fs::read(&vault_path).unwrap(), b"vault-owned");
    let members: i64 = c
        .open_read()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM material_library_asset WHERE library_id=?1",
            [&anchor],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(members, 2, "linked member stays registered");
    let managed_path: String = c
        .open_read()
        .unwrap()
        .query_row("SELECT library_path FROM asset WHERE id=?1", [&managed.id], |r| r.get(0))
        .unwrap();
    assert!(Path::new(&managed_path).starts_with(&target.path().canonicalize().unwrap()));
    assert!(Path::new(managed.library_path.as_deref().unwrap()).is_file(), "old copy kept");
}

#[test]
fn move_recreates_nested_long_chinese_paths_and_is_idempotent() {
    let c = setup();
    let a = lib(&c, "深层库");
    let asset = add(&a, "深层素材.png", b"deep");
    let anchor = a.library_scope_key().unwrap();
    let old_root = root_of(&c, &anchor);
    let nested = PathBuf::from("assets/很深/的/中文/目录/结构/再加一段较长的名称以确保路径长度超出常规限制/深层素材.png");
    let moved_old = old_root.join(&nested);
    std::fs::create_dir_all(moved_old.parent().unwrap()).unwrap();
    std::fs::rename(
        asset.library_path.as_deref().unwrap(),
        &moved_old,
    )
    .unwrap();
    c.open_write().unwrap().execute(
        "UPDATE asset SET library_path=?1 WHERE id=?2",
        rusqlite::params![moved_old.to_string_lossy(), asset.id],
    ).unwrap();

    let target = tempfile::tempdir().unwrap();
    let m = LibraryTransferManager::default();
    let id = unique_id("transfer");
    m.start_move(c.clone(), &anchor, &id, target.path().to_str().unwrap())
        .unwrap();
    assert_eq!(wait(&m, &c, &anchor, &id).phase, "completed");
    let new_path = target.path().join(&nested);
    assert!(new_path.is_file(), "{}", new_path.display());
    assert_eq!(std::fs::read(&new_path).unwrap(), b"deep");
    assert!(moved_old.is_file(), "original nested file kept");

    // Same request id + same destination returns the durable job, and a
    // mismatched destination for the same id is refused.
    let again = m
        .start_move(c.clone(), &anchor, &id, target.path().to_str().unwrap())
        .unwrap();
    assert_eq!(again.task_id, id);
    assert_eq!(again.phase, "completed");
    let other = tempfile::tempdir().unwrap();
    assert!(m
        .start_move(c.clone(), &anchor, &id, other.path().to_str().unwrap())
        .is_err());
    let rows: i64 = c
        .open_read()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM material_library_transfer WHERE anchor_library_id=?1",
            [&anchor],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn move_commands_flow_through_the_library_request_surface() {
    let c = setup();
    let a = lib(&c, "命令库");
    add(&a, "cmd.png", b"cmd");
    let anchor = a.library_scope_key().unwrap();
    let target = tempfile::tempdir().unwrap();
    let id = unique_id("transfer");

    let no_library: LibraryRequest =
        serde_json::from_value(json!({"libraryId":null,"action":{"op":"moveLibraryPreview","root":target.path().to_str().unwrap()}})).unwrap();
    assert!(execute_library_request(c.clone(), no_library)
        .unwrap_err()
        .contains("library-context-required"));

    let preview: LibraryRequest = serde_json::from_value(json!({
        "libraryId": anchor,
        "action": {"op":"moveLibraryPreview","root": target.path().to_str().unwrap()}
    }))
    .unwrap();
    let plan = execute_library_request(c.clone(), preview).unwrap();
    assert_eq!(plan["managedAssets"], json!(1));

    let start: LibraryRequest = serde_json::from_value(json!({
        "libraryId": anchor,
        "action": {"op":"moveLibrary","requestId": id, "root": target.path().to_str().unwrap()}
    }))
    .unwrap();
    let started = execute_library_request(c.clone(), start).unwrap();
    assert_eq!(started["taskId"], json!(id));

    let done = wait(library_transfer_manager(), &c, &anchor, &id);
    assert_eq!(done.phase, "completed", "{done:?}");
    assert_eq!(root_of(&c, &anchor), target.path().canonicalize().unwrap());

    let status: LibraryRequest = serde_json::from_value(json!({
        "libraryId": anchor,
        "action": {"op":"transferStatus","taskId": id}
    }))
    .unwrap();
    let polled = execute_library_request(c.clone(), status).unwrap();
    assert_eq!(polled["phase"], json!("completed"));
    assert_eq!(polled["kind"], json!("move"));
}
