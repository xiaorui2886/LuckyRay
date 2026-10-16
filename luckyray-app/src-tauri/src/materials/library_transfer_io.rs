//! Media preflight/staging. Every retry keeps frozen identities and never follows UI selection.
use super::catalog::canonical_trusted_root;
use super::export::{move_no_replace, DirectoryHold};
use super::library_archive::*;
use super::library_package::*;
use super::library_transfer::*;
use super::*;
use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

fn io(e: std::io::Error) -> MaterialError {
    MaterialError::io("library-transfer-io", "素材库任务读写失败", e)
}
fn controlled_digest(path: &Path, control: &TransferControl) -> MaterialResult<String> {
    let frozen = freeze_path(path, "package", MAX_BYTES + 2 * MAX_METADATA)?;
    verify_media(&frozen, |b| control.progress("校验库包", b, frozen.size))
}
pub(super) fn cleanup_completed_stage(
    base: &MaterialCatalog,
    job: &TransferJob,
) -> MaterialResult<()> {
    let app = canonical_trusted_root(base.app_data_dir())?;
    let parent = app.join("material-library-staging");
    let stage = parent.join(&job.id);
    if !stage.exists() {
        return Ok(());
    }
    let canonical = canonical_trusted_root(&stage)?;
    if canonical != stage || !canonical.starts_with(&parent) {
        return Err(fail("缓存清理路径越界"));
    }
    let hold = DirectoryHold::new(&canonical).map_err(fail)?;
    let media = canonical.join("media");
    let allowed: std::collections::HashSet<_> = job
        .package
        .assets
        .iter()
        .map(|a| media_leaf(job, a))
        .collect::<MaterialResult<_>>()?;
    let hashes: std::collections::HashSet<_> = job
        .package
        .assets
        .iter()
        .map(|a| a.sha256.as_str())
        .collect();
    // Inspect the complete bounded layout first. Never recurse through unknown paths.
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&canonical).map_err(io)? {
        let path = entry.map_err(io)?.path();
        if path == media {
            canonical_trusted_root(&path)?;
            for child in std::fs::read_dir(&path).map_err(io)? {
                let child = child.map_err(io)?.path();
                if !child
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| hashes.contains(n))
                {
                    return Err(fail("缓存目录含未知文件，已保留"));
                }
                super::catalog::canonical_regular_file(&child)?;
                files.push(child);
            }
        } else {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| fail("缓存文件名无效"))?;
            if name != "input.lrlibrary" && !allowed.contains(name) {
                return Err(fail("缓存目录含未知文件，已保留"));
            }
            super::catalog::canonical_regular_file(&path)?;
            files.push(path);
        }
    }
    for path in files {
        hold.verify().map_err(fail)?;
        std::fs::remove_file(path).map_err(io)?;
    }
    hold.verify().map_err(fail)?;
    drop(hold);
    if media.exists() {
        canonical_trusted_root(&media)?;
        std::fs::remove_dir(&media).map_err(io)?;
    }
    canonical_trusted_root(&stage)?;
    std::fs::remove_dir(stage).map_err(io)
}
pub(super) fn media_leaf(job: &TransferJob, a: &PackageAsset) -> MaterialResult<String> {
    let extension = Path::new(&a.name)
        .extension()
        .and_then(|s| s.to_str())
        .filter(|s| s.len() <= 12 && s.bytes().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("bin");
    Ok(format!(
        "{}.{}",
        job.mapped("asset", &a.id)?,
        extension.to_ascii_lowercase()
    ))
}
fn record_failure(control: &TransferControl, index: usize, message: String) {
    let mut s = control.status.lock().unwrap();
    s.items[index].state = "failed".into();
    s.items[index].error = Some(message);
    s.failed = s.items.iter().filter(|i| i.state == "failed").count();
    s.completed = s.items.iter().filter(|i| i.state != "pending").count();
}
fn assert_snapshot_version(base: &MaterialCatalog, job: &TransferJob) -> MaterialResult<()> {
    let version: i64 = base
        .open_read()?
        .query_row(
            "SELECT version FROM material_library WHERE id=?1",
            [&job.anchor],
            |r| r.get(0),
        )
        .map_err(db)?;
    if version != job.package.source_version {
        return Err(fail("源库元数据已变化；请新建任务以取得一致快照"));
    }
    Ok(())
}
fn owned_restore_root(job: &TransferJob) -> MaterialResult<()> {
    let root = canonical_trusted_root(&job.root)?;
    let hold = DirectoryHold::new(&root).map_err(fail)?;
    let marker = root.join(format!(".luckyray-restore-{}.pending", job.id));
    let bytes = serde_json::to_vec(&json!({"taskId":job.id,"libraryId":job.target_library_id}))
        .map_err(|e| fail(e.to_string()))?;
    if marker.exists() {
        super::catalog::canonical_regular_file(&marker)?;
        if std::fs::read(&marker).map_err(io)? != bytes {
            return Err(fail("恢复目录所属任务不匹配"));
        }
    } else {
        if std::fs::read_dir(&root).map_err(io)?.next().is_some() {
            return Err(fail("恢复目录已被其他文件占用"));
        }
        hold.verify().map_err(fail)?;
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
            .map_err(io)?;
        f.write_all(&bytes).and_then(|_| f.sync_all()).map_err(io)?;
    }
    for entry in std::fs::read_dir(&root).map_err(io)? {
        let path = entry.map_err(io)?.path();
        if path != marker && path != root.join("assets") && path != root.join("library.json") {
            if path == root.join(format!(".luckyray-identity-{}.tmp", job.id)) {
                super::catalog::canonical_regular_file(&path)?;
                continue;
            }
            return Err(fail("恢复目录新增了非任务文件"));
        }
    }
    Ok(())
}
pub(super) fn identity(job: &TransferJob) -> MaterialResult<()> {
    let manifest = job.root.join("library.json");
    let bytes = serde_json::to_vec_pretty(&json!({"format":1,"libraryId":job.target_library_id}))
        .map_err(|e| fail(e.to_string()))?;
    if manifest.exists() {
        super::catalog::canonical_regular_file(&manifest)?;
        if std::fs::read(&manifest).map_err(io)? != bytes {
            return Err(fail("恢复目录库身份冲突"));
        }
        return Ok(());
    }
    let temporary = job.root.join(format!(".luckyray-identity-{}.tmp", job.id));
    if temporary.exists() {
        super::catalog::canonical_regular_file(&temporary)?;
        std::fs::remove_file(&temporary).map_err(io)?;
    }
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io)?;
    f.write_all(&bytes).and_then(|_| f.sync_all()).map_err(io)?;
    drop(f);
    move_no_replace(&temporary, &manifest).map_err(io)
}
pub(super) fn perform(
    base: &MaterialCatalog,
    job: &mut TransferJob,
    control: &TransferControl,
) -> MaterialResult<()> {
    control.progress("准备任务", 0, 0)?;
    let stage = job.stage_root(base)?;
    let stage_hold = DirectoryHold::new(&stage).map_err(fail)?;
    let mut sources = Vec::new();
    if job.kind == "restore" {
        owned_restore_root(job)?;
        let path = job
            .package_path
            .as_ref()
            .ok_or_else(|| fail("缺少库包路径"))?;
        let archived = stage.join("input.lrlibrary");
        if job.artifact_sha256.is_none() {
            let mut source = freeze_path(path, "package", MAX_BYTES + 2 * MAX_METADATA)?;
            source.sha256 = Some(verify_media(&source, |b| {
                control.progress("校验库包", b, source.size)
            })?);
            // Persist its digest before copying. A retry cannot accept a changed input.
            job.artifact_sha256 = source.sha256.clone();
            persist_job(base, job, &control.status.lock().unwrap(), None)?;
            copy_media(&source, &archived, |b| {
                control.progress("暂存库包", b, source.size)
            })?;
        } else if !archived.exists() {
            let mut source = freeze_path(path, "package", MAX_BYTES + 2 * MAX_METADATA)?;
            source.sha256 = job.artifact_sha256.clone();
            verify_media(&source, |b| control.progress("复核原库包", b, source.size))?;
            copy_media(&source, &archived, |b| {
                control.progress("暂存库包", b, source.size)
            })?;
        }
        let hash = controlled_digest(&archived, control)?;
        if Some(hash) != job.artifact_sha256 {
            return Err(fail("暂存库包已变化"));
        }
        let mut inspected = inspect_package(&archived)?;
        inspected.name = job.package.name.clone();
        if serde_json::to_value(&inspected).map_err(|e| fail(e.to_string()))?
            != serde_json::to_value(&job.package).map_err(|e| fail(e.to_string()))?
        {
            return Err(fail("导入库包与冻结快照不一致"));
        }
        let extracted = stage.join("media");
        std::fs::create_dir_all(&extracted).map_err(io)?;
        canonical_trusted_root(&extracted)?;
        sources = extract_media(&archived, &job.package, &extracted, |name, b| {
            control.progress(name, b, 0)
        })?
        .into_values()
        .collect();
        for item in &mut control.status.lock().unwrap().items {
            item.state = "pending".into();
            item.error = None;
        }
    } else {
        let source = base.for_library(&job.anchor)?;
        assert_snapshot_version(base, job)?;
        control.status.lock().unwrap().phase = "verifying".into();
        // Freeze every file stamp before reading bytes, rather than at each ZIP entry.
        for (index, a) in job.locals.iter().enumerate() {
            if job.kind == "copy"
                && matches!(
                    control.status.lock().unwrap().items[index].state.as_str(),
                    "copied" | "skipped"
                )
            {
                continue;
            }
            control.progress(&a.name, 0, 0)?;
            let frozen = job
                .media
                .iter()
                .find(|m| m.asset_id == a.id)
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| freeze_media(&source, a));
            match frozen {
                Ok(s) => sources.push(s),
                Err(e) => {
                    if e.code == "library-transfer-cancelled" {
                        return Err(e);
                    }
                    record_failure(control, index, e.message);
                }
            }
        }
        let mut total = 0u64;
        for s in &mut sources {
            let index = job
                .package
                .assets
                .iter()
                .position(|a| a.id == s.asset_id)
                .ok_or_else(|| fail("媒体身份未知"))?;
            let a = &mut job.package.assets[index];
            match verify_media(s, |b| control.progress(&a.name, b, s.size)) {
                Ok(hash) => {
                    a.sha256 = hash.clone();
                    a.size_bytes = s.size;
                    s.sha256 = Some(hash);
                    total = total
                        .checked_add(s.size)
                        .ok_or_else(|| fail("任务超出体积预算"))?;
                    control.status.lock().unwrap().items[index].state = "pending".into();
                    control.status.lock().unwrap().items[index].error = None;
                    control.status.lock().unwrap().items[index].target_asset_id = None;
                }
                Err(e) => {
                    if e.code == "library-transfer-cancelled" {
                        return Err(e);
                    }
                    record_failure(control, index, e.message);
                }
            }
        }
        if total > MAX_BYTES {
            return Err(fail("任务超出20GiB预算"));
        }
        sources.retain(|s| {
            control
                .status
                .lock()
                .unwrap()
                .items
                .iter()
                .find(|i| i.asset_id == s.asset_id)
                .is_some_and(|i| i.state != "failed")
        });
        job.media = sources.clone();
        persist_job(base, job, &control.status.lock().unwrap(), None)?;
        if job.kind == "move" {
            // The move keeps the shared freeze/verify stage, then owns its
            // own staged copy and authority switch in one place.
            return super::library_move::perform_move(base, job, control);
        }
        if job.kind == "export"
            && control
                .status
                .lock()
                .unwrap()
                .items
                .iter()
                .any(|i| i.state == "failed")
        {
            return Err(fail("部分原文件缺失、离线或已变化；完整备份未生成"));
        }
    }
    stage_hold.verify().map_err(fail)?;
    control.status.lock().unwrap().phase = "staging".into();
    if job.kind == "export" {
        let root = super::export::validate_destination(base, &job.root, &job.protected_roots)
            .map_err(fail)?;
        let hold = DirectoryHold::new(&root).map_err(fail)?;
        let output = job
            .output
            .as_ref()
            .ok_or_else(|| fail("库包输出位置缺失"))?;
        let temporary = root.join(format!(".luckyray-library-{}.tmp", job.id));
        let mut verified;
        let reading_hold;
        if output.exists() {
            verified = freeze_path(output, "package", MAX_BYTES + 2 * MAX_METADATA)?;
            reading_hold = open_frozen(&verified)?;
            let hash = verify_media(&verified, |b| {
                control.progress("复核已发布库包", b, verified.size)
            })?;
            if Some(hash) != job.artifact_sha256 {
                return Err(fail("库包输出位置已占用，未覆盖已有文件"));
            }
            control.begin_commit()?;
        } else {
            if temporary.exists() {
                super::catalog::canonical_regular_file(&temporary)?;
                std::fs::remove_file(&temporary).map_err(io)?;
            }
            let outcome = write_package(&job.package, &sources, &temporary, |name, b| {
                hold.verify().map_err(fail)?;
                control.progress(name, b, 0)
            });
            if let Err(e) = outcome {
                if super::catalog::canonical_regular_file(&temporary).is_ok() {
                    let _ = std::fs::remove_file(&temporary);
                }
                return Err(e);
            }
            assert_snapshot_version(base, job)?;
            verified = freeze_path(&temporary, "package", MAX_BYTES + 2 * MAX_METADATA)?;
            reading_hold = open_frozen(&verified)?;
            let hash = verify_media(&verified, |b| {
                control.progress("校验库包", b, verified.size)
            })?;
            job.artifact_sha256 = Some(hash);
            persist_job(base, job, &control.status.lock().unwrap(), None)?;
            control.begin_commit()?;
            hold.verify().map_err(fail)?;
            move_no_replace(&temporary, output).map_err(io)?;
            verified.path = output.clone();
        }
        // Deny write/delete until the durable completion ACK. The identity and
        // stamp must match the exact file that was hashed before publication.
        let _published_hold = hold_frozen(&verified)?;
        drop(reading_hold);
        let mut s = control.status.lock().unwrap().clone();
        s.phase = "completed".into();
        s.copied = s.total;
        s.completed = s.total;
        s.failed = 0;
        s.retryable = false;
        for item in &mut s.items {
            item.state = "copied".into();
            item.error = None;
        }
        persist_job(base, job, &s, None)?;
        *control.status.lock().unwrap() = s;
        return Ok(());
    }
    let target = job
        .target_library_id
        .as_ref()
        .ok_or_else(|| fail("目标库身份缺失"))?;
    let media_root = if job.kind == "copy" {
        let scoped = base.for_library(target)?;
        let expected = scoped.import_library_root(None)?;
        if expected != job.root {
            return Err(fail("目标库位置在任务期间已变化"));
        }
        std::fs::create_dir_all(&expected).map_err(io)?;
        canonical_trusted_root(&expected)?
    } else {
        owned_restore_root(job)?;
        let path = job.root.join("assets");
        std::fs::create_dir_all(&path).map_err(io)?;
        canonical_trusted_root(&path)?
    };
    base.register_managed_root(&media_root)?;
    let target_hold = DirectoryHold::new(&media_root).map_err(fail)?;
    for source in &sources {
        let index = job
            .package
            .assets
            .iter()
            .position(|a| a.id == source.asset_id)
            .unwrap();
        let a = &job.package.assets[index];
        if job.kind == "copy" {
            use rusqlite::OptionalExtension;
            let duplicate: Option<String> = base.open_read()?.query_row("SELECT a.id FROM asset a JOIN material_library_asset m ON m.asset_id=a.id WHERE m.library_id=?1 AND a.content_hash=?2 ORDER BY a.id LIMIT 1",rusqlite::params![target,a.sha256],|r|r.get(0)).optional().map_err(db)?;
            if let Some(existing) = duplicate {
                control.status.lock().unwrap().items[index].target_asset_id = Some(existing);
                continue;
            }
        }
        let staged = stage.join(media_leaf(job, a)?);
        let result = copy_media(source, &staged, |b| {
            control.progress(&a.name, b, source.size)
        })
        .and_then(|_| {
            stage_hold.verify().map_err(fail)?;
            target_hold.verify().map_err(fail)?;
            let mut s = freeze_path(&staged, &a.id, MAX_FILE)?;
            s.sha256 = Some(a.sha256.clone());
            copy_media(&s, &media_root.join(media_leaf(job, a)?), |b| {
                target_hold.verify().map_err(fail)?;
                control.progress(&a.name, b, source.size)
            })
        });
        if let Err(e) = result {
            if e.code == "library-transfer-cancelled" || job.kind == "restore" {
                return Err(e);
            }
            record_failure(control, index, e.message);
        }
    }
    if job.kind == "restore" {
        validate_package(&job.package)?;
        owned_restore_root(job)?;
        identity(job)?;
        base.register_managed_root(&job.root)?;
    }
    // Verify bytes before acquiring the Catalog writer. On Windows these held
    // handles deny write/delete through the short metadata-only commit.
    let mut final_media = std::collections::HashMap::new();
    let mut final_holds = Vec::new();
    for (index, a) in job.package.assets.iter().enumerate() {
        let item = control.status.lock().unwrap().items[index].clone();
        if item.state != "pending" || (job.kind == "copy" && item.target_asset_id.is_some()) {
            continue;
        }
        let mut snapshot = freeze_path(&media_root.join(media_leaf(job, a)?), &a.id, MAX_FILE)?;
        let mut hold = hold_frozen(&snapshot)?;
        let (hash, size) = hash_reader(&mut hold, |b| control.progress(&a.name, b, a.size_bytes))?;
        if hash != a.sha256 || size != a.size_bytes {
            return Err(fail("提交前目标媒体hash/大小变化"));
        }
        snapshot.sha256 = Some(hash);
        final_media.insert(a.id.clone(), snapshot);
        final_holds.push(hold);
    }
    control.progress("提交素材库", 0, 0)?;
    target_hold.verify().map_err(fail)?;
    if job.kind == "restore" {
        owned_restore_root(job)?;
    }
    control.begin_commit()?;
    // The DB transaction publishes the whole new library and completes the journal atomically.
    super::library_transfer_commit::commit(base, job, control, &media_root, &final_media)?;
    if job.kind == "restore" {
        let marker = job
            .root
            .join(format!(".luckyray-restore-{}.pending", job.id));
        if super::catalog::canonical_regular_file(&marker).is_ok() {
            let _ = std::fs::remove_file(marker);
        }
    }
    Ok(())
}
