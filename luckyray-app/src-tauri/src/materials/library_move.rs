//! MAT-LIB-R3-A: whole-library safe move on the R2 transfer ledger.
//! The single MaterialCatalog stays authoritative: the library id, member
//! identities, folders/tags and provenance never change; a durable staged
//! copy is verified file-by-file before one write transaction switches the
//! registered root and the managed paths. Old files are never deleted — a
//! recovery marker is left at the old root instead.
use super::catalog::{canonical_regular_file, canonical_trusted_root};
use super::export::DirectoryHold;
use super::library_archive::{copy_media, freeze_path, hash_reader, hold_frozen, SourceMedia};
use super::library_package::*;
use super::library_transfer::{persist_job, TransferControl, TransferJob};
use super::*;
use rusqlite::params;
use serde_json::json;
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

fn io(e: std::io::Error) -> MaterialError {
    MaterialError::io("library-move-io", "素材库移动读写失败", e)
}

fn move_origin(job: &TransferJob) -> MaterialResult<PathBuf> {
    let key: serde_json::Value =
        serde_json::from_str(&job.request_key).map_err(|e| fail(e.to_string()))?;
    if key.get(0).and_then(|v| v.as_str()) != Some("move") {
        return Err(fail("移动任务身份无效"));
    }
    key.get(2)
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .ok_or_else(|| fail("移动任务身份无效"))
}

fn relative_under(library_path: Option<&str>, old_root: &Path) -> Option<PathBuf> {
    let path = Path::new(library_path?);
    if !path.is_absolute() {
        return None;
    }
    path.strip_prefix(old_root).ok().map(|p| p.to_path_buf())
}

/// Read the registered root of a library, refusing the default/legacy scope
/// which has no single movable directory.
pub(crate) fn library_root(base: &MaterialCatalog, library_id: &str) -> MaterialResult<String> {
    let conn = base.open_read()?;
    let row: Option<(Option<String>, String)> = conn
        .query_row(
            "SELECT root_path,state FROM material_library WHERE id=?1",
            [library_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| MaterialError::database("读取库登记失败", e))
        .ok();
    let Some((root, state)) = row else {
        return Err(MaterialError::new("library-not-found", "素材库不存在"));
    };
    if state != "ready" {
        return Err(MaterialError::new("library-offline", "素材库位置不可用；请先重新定位"));
    }
    root.ok_or_else(|| {
        MaterialError::new(
            "library-move-unsupported",
            "默认兼容库沿用既有多个存储根，没有可整体移动的独立库目录",
        )
    })
}

/// Read the managed members of a library. Returns (rows, stuck) where rows
/// carry the movable files and stuck counts managed files registered outside
/// the library root — those make a whole-library move impossible.
fn managed_members(
    conn: &rusqlite::Connection,
    library_id: &str,
    old_root: &Path,
) -> MaterialResult<(Vec<(String, u64)>, usize)> {
    let mut statement = conn
        .prepare(
            "SELECT a.library_path,COALESCE(a.size_bytes,0) FROM asset a \
             JOIN material_library_asset m ON m.asset_id=a.id \
             WHERE m.library_id=?1 AND a.storage_mode='managed' ORDER BY a.id",
        )
        .map_err(|e| MaterialError::database("读取库托管文件失败", e))?;
    let (mut rows, mut stuck) = (Vec::new(), 0usize);
    for entry in statement
        .query_map([library_id], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)? as u64))
        })
        .map_err(|e| MaterialError::database("读取库托管文件失败", e))?
    {
        let (path, size) = entry.map_err(|e| MaterialError::database("读取库托管文件失败", e))?;
        match relative_under(path.as_deref(), old_root) {
            Some(relative) => rows.push((relative.to_string_lossy().into_owned(), size)),
            None => stuck += 1,
        }
    }
    Ok((rows, stuck))
}

/// Read-only impact preview: what moves, what stays, and every condition that
/// would refuse the move — before any file is touched.
pub(crate) fn preview_move(
    base: &MaterialCatalog,
    library_id: &str,
    target: &Path,
) -> MaterialResult<serde_json::Value> {
    let old_root = library_root(base, library_id)?;
    let old = PathBuf::from(&old_root);
    let target = canonical_trusted_root(target)?;
    if old == target {
        return Err(fail("目标位置与当前库位置相同"));
    }
    if target.starts_with(&old) || old.starts_with(&target) {
        return Err(fail("目标目录不能位于当前库目录内部（或包含当前库）"));
    }
    let mut protected = base.transfer_watch_roots()?;
    super::export::validate_destination(base, &target, &protected).map_err(fail)?;
    if target.join("library.json").is_file() {
        return Err(MaterialError::new(
            "library-move-target-identity",
            "目标目录已包含素材库身份文件；请改用「重新定位已有库」",
        ));
    }
    if std::fs::read_dir(&target)
        .map_err(|e| MaterialError::io("library-move-io", "读取目标目录失败", e))?
        .next()
        .is_some()
    {
        return Err(MaterialError::new(
            "library-move-target-not-empty",
            "目标目录不为空；为保护已有文件，移动库需要一个空目录",
        ));
    }
    let conn = base.open_read()?;
    let library_name: String = conn
        .query_row(
            "SELECT name FROM material_library WHERE id=?1",
            [library_id],
            |r| r.get(0),
        )
        .map_err(|e| MaterialError::database("读取库登记失败", e))?;
    let (rows, stuck) = managed_members(&conn, library_id, &old)?;
    if stuck > 0 {
        return Err(MaterialError::new(
            "library-move-members-scattered",
            &format!("{stuck} 个托管文件登记在库根目录之外，无法整库安全移动；请先重新定位这些素材"),
        ));
    }
    let managed_bytes: u64 = rows.iter().map(|(_, size)| *size).sum();
    let linked_assets: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM asset a JOIN material_library_asset m ON m.asset_id=a.id \
             WHERE m.library_id=?1 AND a.storage_mode!='managed'",
            [library_id],
            |r| Ok(r.get::<_, i64>(0)? as usize),
        )
        .map_err(|e| MaterialError::database("统计库链接文件失败", e))?;
    // One library per physical root is guaranteed by the UNIQUE index on
    // material_library.root_path, so no shared-root movable-set exists here.
    let mut excluded = Vec::new();
    if linked_assets > 0 {
        excluded.push(format!(
            "{linked_assets} 个链接/源文件类素材仅登记路径，不搬移文件"
        ));
    }
    excluded.push("Vault 附件与原位置引用不归库拥有，不参与移动".to_owned());
    Ok(json!({
        "libraryId": library_id,
        "libraryName": library_name,
        "oldRoot": old_root,
        "newRoot": target.to_string_lossy(),
        "managedAssets": rows.len(),
        "managedBytes": managed_bytes,
        "linkedAssets": linked_assets,
        "excluded": excluded,
    }))
}

/// Keep only the movable managed members in the frozen snapshot so the job's
/// items and frozen media never include linked originals or Vault references.
pub(super) fn retain_movable_members(
    package: &mut LibraryPackage,
    locals: &mut Vec<MaterialAsset>,
    old_root: &Path,
) {
    let movable: HashSet<String> = locals
        .iter()
        .filter(|a| relative_under(a.library_path.as_deref(), old_root).is_some())
        .filter(|a| a.storage_mode == "managed")
        .map(|a| a.id.clone())
        .collect();
    locals.retain(|a| movable.contains(a.id.as_str()));
    package.assets.retain(|a| movable.contains(a.id.as_str()));
    package.favorites.retain(|f| movable.contains(f.asset_id.as_str()));
}

/// Validate that the target root is owned by this job: a durable pending
/// marker plus only the files this job expects at their final positions.
fn owned_move_root(job: &TransferJob, expected: &HashSet<PathBuf>) -> MaterialResult<()> {
    let root = &job.root;
    let hold = DirectoryHold::new(root).map_err(fail)?;
    let marker = root.join(format!(".luckyray-move-{}.pending", job.id));
    let tmp_suffix = format!(".luckyray-move-{}.tmp", job.id);
    let bytes = serde_json::to_vec(&json!({"taskId": &job.id, "libraryId": &job.anchor}))
        .map_err(|e| fail(e.to_string()))?;
    if marker.exists() {
        canonical_regular_file(&marker)?;
        if std::fs::read(&marker).map_err(io)? != bytes {
            return Err(fail("移动目录所属任务不匹配"));
        }
    } else {
        if std::fs::read_dir(root).map_err(io)?.next().is_some() {
            return Err(fail("移动目录已被其他文件占用"));
        }
        hold.verify().map_err(fail)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
            .map_err(io)?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(io)?;
    }
    // Inspect the complete layout before copying. Every file must be the
    // pending marker, the identity manifest, or an expected staged copy.
    let mut stack = vec![root.clone()];
    let mut budget = expected.len() + 16;
    while let Some(directory) = stack.pop() {
        if canonical_trusted_root(&directory)? != directory {
            return Err(fail("移动目录含不可信路径"));
        }
        for entry in std::fs::read_dir(&directory).map_err(io)? {
            let path = entry.map_err(io)?.path();
            if budget == 0 {
                return Err(fail("移动目录内容超出任务预算"));
            }
            budget -= 1;
            if std::fs::symlink_metadata(&path).map_err(io)?.is_dir() {
                stack.push(path);
            } else {
                canonical_regular_file(&path)?;
                if path == marker
                    || path == root.join("library.json")
                    || path == root.join(format!(".luckyray-identity-{}.tmp", job.id))
                {
                    continue;
                }
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
                if name.is_some_and(|n| n.ends_with(&tmp_suffix)) {
                    continue;
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| fail("移动目录路径无效"))?;
                if !expected.contains(relative) {
                    return Err(fail("移动目录含非任务文件，已停止"));
                }
            }
        }
    }
    hold.verify().map_err(fail)
}

/// Move tail after the shared freeze/verify stage: staged copies land in the
/// user-chosen root, then one transaction switches the authority.
pub(super) fn perform_move(
    base: &MaterialCatalog,
    job: &mut TransferJob,
    control: &TransferControl,
) -> MaterialResult<()> {
    if control
        .status
        .lock()
        .unwrap()
        .items
        .iter()
        .any(|i| i.state == "failed")
    {
        return Err(fail("部分原文件缺失、离线或已变化；整库移动需要全部托管文件可用"));
    }
    let old_root = move_origin(job)?;
    let root = job.root.clone();
    let expected: HashSet<PathBuf> = job
        .locals
        .iter()
        .filter_map(|a| relative_under(a.library_path.as_deref(), &old_root))
        .collect();
    owned_move_root(job, &expected)?;
    let hold = DirectoryHold::new(&root).map_err(fail)?;
    control.status.lock().unwrap().phase = "staging".into();
    let tmp_suffix = format!(".luckyray-move-{}.tmp", job.id);
    for asset in job.locals.clone() {
        let source = job
            .media
            .iter()
            .find(|m| m.asset_id == asset.id)
            .ok_or_else(|| fail("媒体身份未知"))?
            .clone();
        let relative =
            relative_under(asset.library_path.as_deref(), &old_root).ok_or_else(|| {
                fail("库中存在非此根管理的文件，不能整体移动")
            })?;
        let destination = root.join(&relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
            canonical_trusted_root(parent)?;
        }
        // Copies land under this job's own tmp suffix and are renamed into
        // place, so a killed attempt can never publish a partial file and a
        // foreign file at the final path is never overwritten or deleted.
        let temporary = destination.with_file_name(format!(
            "{}{}",
            destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            tmp_suffix
        ));
        let name = asset.name.clone();
        let size = source.size;
        let copied = |bytes: u64| control.progress(&name, bytes, size);
        if temporary.exists() && canonical_regular_file(&temporary).is_ok() {
            std::fs::remove_file(&temporary).map_err(io)?;
        }
        if !destination.exists() {
            copy_media(&source, &temporary, copied)?;
            hold.verify().map_err(fail)?;
            super::export::move_no_replace(&temporary, &destination).map_err(io)?;
        } else {
            // Resuming our own verified copy; a hash mismatch here is a
            // foreign or damaged file the job must not touch.
            copy_media(&source, &destination, copied)?;
        }
        if temporary.exists() && canonical_regular_file(&temporary).is_ok() {
            std::fs::remove_file(&temporary).map_err(io)?;
        }
        hold.verify().map_err(fail)?;
    }
    // Verify every destination byte-for-byte and hold them through commit.
    let mut final_media = std::collections::HashMap::new();
    let mut holds = Vec::new();
    for asset in job.locals.clone() {
        let source = job
            .media
            .iter()
            .find(|m| m.asset_id == asset.id)
            .ok_or_else(|| fail("媒体身份未知"))?;
        let relative = relative_under(asset.library_path.as_deref(), &old_root)
            .ok_or_else(|| fail("库中存在非此根管理的文件，不能整体移动"))?;
        let mut snapshot =
            freeze_path(&root.join(relative), &asset.id, MAX_FILE)?;
        let mut opened = hold_frozen(&snapshot)?;
        let (hash, bytes) = hash_reader(&mut opened, |b| {
            control.progress(&asset.name, b, source.size)
        })?;
        if Some(&hash) != source.sha256.as_ref() || bytes != source.size {
            return Err(fail("提交前目标副本hash/大小变化"));
        }
        snapshot.sha256 = Some(hash);
        holds.push(opened);
        final_media.insert(asset.id.clone(), snapshot);
    }
    // Re-check ownership before committing: a file the user dropped into the
    // target while the picker was closed stops the switch instead of being
    // overwritten or carried into the new library root.
    owned_move_root(job, &expected)?;
    super::library_transfer_io::identity(job)?;
    base.register_managed_root(&root)?;
    if root.join("assets").is_dir() {
        base.register_managed_root(&root.join("assets"))?;
    }
    control.begin_commit()?;
    commit_move(base, job, control, &old_root, &final_media)?;
    // Durable completion first; cleanup below is best-effort and never
    // affects the switched authority.
    let marker = root.join(format!(".luckyray-move-{}.pending", job.id));
    if canonical_regular_file(&marker).is_ok() {
        let _ = std::fs::remove_file(&marker);
    }
    write_recovery_marker(&old_root, &root, job);
    Ok(())
}

/// Single write transaction: re-check the authority still points at the old
/// root, then switch library_path/thumbnail_url for every member and the
/// registered root — or roll everything back.
fn commit_move(
    base: &MaterialCatalog,
    job: &TransferJob,
    control: &TransferControl,
    old_root: &Path,
    final_media: &std::collections::HashMap<String, SourceMedia>,
) -> MaterialResult<()> {
    let mut connection = base.open_write()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db)?;
    let previous: String = tx
        .query_row(
            "SELECT phase FROM material_library_transfer WHERE id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .map_err(db)?;
    if previous == "completed" {
        return Ok(());
    }
    let (root_path, state, visible, version): (Option<String>, String, i64, i64) = tx
        .query_row(
            "SELECT root_path,state,visible,version FROM material_library WHERE id=?1",
            [&job.anchor],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(db)?;
    if state != "ready" || visible != 1 {
        return Err(fail("素材库已不可用"));
    }
    if root_path.as_deref() != Some(old_root.to_string_lossy().as_ref()) {
        return Err(fail("库位置在任务期间已变化；未切换权威"));
    }
    if version != job.package.source_version {
        return Err(fail("源库元数据已变化；请新建任务以取得一致快照"));
    }
    let mut changed = Vec::new();
    for asset in &job.locals {
        let snapshot = final_media
            .get(&asset.id)
            .ok_or_else(|| fail("提交媒体尚未核验"))?;
        // Deny write/delete on the verified copy through the transaction.
        hold_frozen(snapshot)?;
        let thumbnail = Path::new(&asset.thumbnail_url)
            .strip_prefix(old_root)
            .map(|relative| job.root.join(relative).to_string_lossy().into_owned())
            .unwrap_or_else(|_| asset.thumbnail_url.clone());
        let moved = tx
            .execute(
                "UPDATE asset SET library_path=?1,thumbnail_url=?2 WHERE id=?3",
                params![snapshot.path.to_string_lossy(), thumbnail, asset.id],
            )
            .map_err(db)?;
        if moved != 1 {
            return Err(fail("素材已在此期间被移除"));
        }
        changed.push(asset.id.clone());
    }
    tx.execute(
        "UPDATE material_library SET root_path=?1,state='ready',updated_at=?2 WHERE id=?3",
        params![
            job.root.to_string_lossy(),
            chrono::Utc::now().to_rfc3339(),
            job.anchor
        ],
    )
    .map_err(db)?;
    let mut results = control.status.lock().unwrap().clone();
    for item in &mut results.items {
        item.state = "copied".into();
        item.target_asset_id = Some(item.asset_id.clone());
        item.error = None;
    }
    results.copied = results.items.len();
    results.skipped = 0;
    results.failed = 0;
    results.completed = results.copied;
    results.phase = "completed".into();
    results.retryable = false;
    results.error = None;
    results.current_file = None;
    results.current_bytes = 0;
    publish_change_metadata(&tx, "material-library-move", changed, true)?;
    persist_job(base, job, &results, Some(&tx))?;
    tx.commit().map_err(db)?;
    *control.status.lock().unwrap() = results;
    Ok(())
}

/// Recovery record at the old root. The originals are intentionally left in
/// place — cleanup is the user's decision, never automatic.
fn write_recovery_marker(old_root: &Path, new_root: &Path, job: &TransferJob) {
    let files: Vec<_> = job
        .locals
        .iter()
        .map(|a| {
            json!({
                "assetId": a.id,
                "libraryPath": a.library_path,
                "sha256": job.media.iter().find(|m| m.asset_id == a.id).and_then(|m| m.sha256.clone()),
            })
        })
        .collect();
    let info = json!({
        "libraryId": job.anchor,
        "movedTo": new_root.to_string_lossy(),
        "movedAt": chrono::Utc::now().to_rfc3339(),
        "files": files,
        "note": "此素材库已整体移动；原文件未删除。确认新位置工作正常后可自行清理。",
    });
    let marker = old_root.join(format!(".luckyray-moved-{}", chrono::Utc::now().timestamp()));
    if let Ok(bytes) = serde_json::to_vec_pretty(&info) {
        let _ = std::fs::write(&marker, bytes);
    }
}

#[cfg(test)]
#[path = "library_move_tests.rs"]
mod tests;
