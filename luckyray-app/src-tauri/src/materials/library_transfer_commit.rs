//! Frozen source IDs are mapping keys only. Destination rows get fresh local identity.
use super::catalog::unique_id;
use super::library_package::*;
use super::library_transfer::*;
use super::library_transfer_io::media_leaf;
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub(super) struct CopyAssetPlan {
    pub copies: HashSet<String>,
    pub duplicates: HashMap<String, String>,
}
/// The same ordered hash decisions drive read-only merge preview and commit.
/// Include earlier planned copies, since later equal-content sources also skip.
pub(super) fn plan_copy_assets(c: &Connection, target: &str, package: &LibraryPackage, candidates: &HashSet<String>, mapping: &HashMap<String, String>) -> MaterialResult<CopyAssetPlan> {
    let mut result = CopyAssetPlan { copies: HashSet::new(), duplicates: HashMap::new() };
    let mut planned_hashes = HashMap::new();
    for asset in &package.assets {
        if !candidates.contains(&asset.id) { continue; }
        if asset.sha256.len() != 64 { return Err(fail("复制规划缺少已核验内容摘要")); }
        let existing: Option<String> = c.query_row("SELECT a.id FROM asset a JOIN material_library_asset m ON m.asset_id=a.id WHERE m.library_id=?1 AND a.content_hash=?2 ORDER BY a.id LIMIT 1", params![target, asset.sha256], |r| r.get(0)).optional().map_err(db)?;
        if let Some(id) = existing.or_else(|| planned_hashes.get(&asset.sha256).cloned()) {
            result.duplicates.insert(asset.id.clone(), id);
        } else {
            let id = mapping.get(&format!("asset:{}", asset.id)).cloned().ok_or_else(|| fail("素材身份映射缺失"))?;
            planned_hashes.insert(asset.sha256.clone(), id);
            result.copies.insert(asset.id.clone());
        }
    }
    Ok(result)
}
pub(super) struct PlannedFolder { pub folder: PackageFolder, pub id: String, pub parent: Option<String>, pub create: bool }
pub(super) struct PlannedTag { pub tag: PackageTag, pub id: String, pub create: bool }
pub(super) struct MetadataPlan {
    pub folders: Vec<PlannedFolder>, pub tags: Vec<PlannedTag>,
    pub mapping: HashMap<String, String>,
}
/// Copy only actual copied assets' organization plus a selected folder subtree;
/// restore keeps the complete package. Resolve parent + name, including folders
/// planned earlier in this transaction, and retain retry mappings after edits.
pub(super) fn plan_metadata(c: &Connection, target: &str, package: &LibraryPackage, copy: bool, ready: &HashSet<String>, selected: Option<&str>, frozen: &HashMap<String, String>) -> MaterialResult<MetadataPlan> {
    let mut needed: HashSet<String> = package.assets.iter().filter(|a| ready.contains(&a.id)).filter_map(|a| a.folder_id.clone()).collect();
    if let Some(selected) = selected {
        needed.insert(selected.into());
        loop {
            let before = needed.len();
            for folder in &package.folders {
                if folder.parent_id.as_ref().is_some_and(|parent| needed.contains(parent)) { needed.insert(folder.id.clone()); }
            }
            if before == needed.len() { break; }
        }
    }
    loop {
        let before = needed.len();
        for folder in &package.folders {
            if needed.contains(&folder.id) { if let Some(parent) = &folder.parent_id { needed.insert(parent.clone()); } }
        }
        if before == needed.len() { break; }
    }
    let mut remaining: Vec<_> = package.folders.iter().filter(|f| !copy || needed.contains(&f.id)).cloned().collect();
    let mut result = MetadataPlan { folders: vec![], tags: vec![], mapping: frozen.clone() };
    let mut done = HashSet::new();
    while !remaining.is_empty() {
        let before = remaining.len(); let mut rest = vec![];
        for folder in remaining {
            if folder.parent_id.as_ref().is_some_and(|p| !done.contains(p)) { rest.push(folder); continue; }
            let parent = folder.parent_id.as_ref().map(|p| result.mapping.get(&format!("folder:{p}")).cloned().ok_or_else(|| fail("分类父级映射缺失"))).transpose()?;
            let frozen_id = result.mapping.get(&format!("folder:{}", folder.id)).cloned().ok_or_else(|| fail("分类身份映射缺失"))?;
            let retained: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM material_library_folder WHERE folder_id=?1 AND library_id=?2)", params![frozen_id, target], |r| r.get(0)).map_err(db)?;
            let existing: Option<String> = if copy && retained { Some(frozen_id.clone()) } else if copy {
                let stored = c.query_row("SELECT f.id FROM folder f JOIN material_library_folder m ON m.folder_id=f.id WHERE m.library_id=?1 AND f.parent_id IS ?2 AND f.name=?3 ORDER BY f.id LIMIT 1", params![target, parent, folder.name], |r| r.get(0)).optional().map_err(db)?;
                stored.or_else(|| result.folders.iter().find(|f| f.parent == parent && f.folder.name == folder.name).map(|f| f.id.clone()))
            } else { None };
            let create = existing.is_none() && !retained;
            let id = existing.unwrap_or_else(|| if copy { unique_id("folder") } else { frozen_id });
            result.mapping.insert(format!("folder:{}", folder.id), id.clone());
            done.insert(folder.id.clone());
            result.folders.push(PlannedFolder { folder, id, parent, create });
        }
        if rest.len() == before { return Err(fail("源分类存在循环或缺失父级")); }
        remaining = rest;
    }
    let used: HashSet<_> = package.assets.iter().filter(|a| ready.contains(&a.id)).flat_map(|a| a.tag_ids.iter()).collect();
    for tag in &package.tags {
        if copy && !used.contains(&tag.id) { continue; }
        let frozen_id = result.mapping.get(&format!("tag:{}", tag.id)).cloned().ok_or_else(|| fail("标签身份映射缺失"))?;
        let retained: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM material_library_tag WHERE id=?1 AND library_id=?2)", params![frozen_id, target], |r| r.get(0)).map_err(db)?;
        let existing: Option<String> = if copy && retained { Some(frozen_id.clone()) } else if copy {
            c.query_row("SELECT id FROM material_library_tag WHERE library_id=?1 AND name=?2 ORDER BY id LIMIT 1", params![target, tag.name], |r| r.get(0)).optional().map_err(db)?
        } else { None };
        let create = existing.is_none() && !retained;
        let id = existing.unwrap_or_else(|| if copy { unique_id("tag") } else { frozen_id });
        result.mapping.insert(format!("tag:{}", tag.id), id.clone());
        result.tags.push(PlannedTag { tag: tag.clone(), id, create });
    }
    Ok(result)
}

fn mapped(job: &TransferJob, kind: &str, id: &Option<String>) -> MaterialResult<Option<String>> {
    id.as_ref().map(|id| job.mapped(kind, id)).transpose()
}
fn remap_preferences(p: &Value, mapping: &HashMap<String, String>) -> MaterialResult<Value> {
    let mut result = p.clone();
    if let Some(raw) = p
        .get("luckyray-materials-filter-v1")
        .and_then(Value::as_str)
    {
        let mut filter: Value = serde_json::from_str(raw).map_err(|_| fail("素材筛选偏好无效"))?;
        if let Some(ids) = filter.get_mut("tagIds").and_then(Value::as_array_mut) {
            for id in ids {
                let old = id.as_str().ok_or_else(|| fail("筛选标签身份无效"))?;
                *id = Value::String(
                    mapping
                        .get(&format!("tag:{old}"))
                        .cloned()
                        .ok_or_else(|| fail("筛选引用未知标签"))?,
                );
            }
        }
        if let Some(id) = filter.get_mut("folderId") {
            if let Some(old) = id.as_str() {
                if !old.is_empty() {
                    *id = Value::String(
                        mapping
                            .get(&format!("folder:{old}"))
                            .cloned()
                            .ok_or_else(|| fail("筛选引用未知分类"))?,
                    );
                }
            }
        }
        result["luckyray-materials-filter-v1"] =
            Value::String(serde_json::to_string(&filter).map_err(|e| fail(e.to_string()))?);
    }
    Ok(result)
}
fn intent(c: &Connection, kind: &str, id: &str, library: &str) -> MaterialResult<()> {
    c.execute(
        "INSERT INTO material_library_write_intent(kind,object_id,library_id) VALUES(?1,?2,?3)",
        params![kind, id, library],
    )
    .map_err(db)?;
    Ok(())
}
pub(super) fn commit(
    base: &MaterialCatalog,
    job: &mut TransferJob,
    control: &TransferControl,
    media_root: &Path,
    final_media: &HashMap<String, super::library_archive::SourceMedia>,
) -> MaterialResult<()> {
    let mut c = base.open_write()?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db)?;
    let target = job
        .target_library_id
        .clone()
        .ok_or_else(|| fail("缺少目标素材库"))?;
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
    if job.kind == "restore" {
        // The library stays absent until ALL rows and the completed journal commit.
        let preferences = remap_preferences(&job.package.preferences, &job.mapping)?;
        let at = chrono::Utc::now().to_rfc3339();
        tx.execute("INSERT INTO material_library(id,name,root_path,storage_mode,visible,state,created_at,updated_at,preferences_json) VALUES(?1,?2,?3,'managed',1,'ready',?4,?4,?5)",params![target,job.package.name,job.root.to_string_lossy(),at,serde_json::to_string(&preferences).map_err(|e|fail(e.to_string()))?]).map_err(db)?;
    } else {
        let ready:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM material_library WHERE id=?1 AND state='ready' AND visible=1)",[&target],|r|r.get(0)).map_err(db)?;
        if !ready {
            return Err(fail("目标库已不可用"));
        }
        let root: Option<String> = tx
            .query_row(
                "SELECT root_path FROM material_library WHERE id=?1",
                [&target],
                |r| r.get(0),
            )
            .map_err(db)?;
        let expected = root
            .map(|r| std::path::PathBuf::from(r).join("assets"))
            .unwrap_or_else(|| base.app_data_dir().join("asset-library"));
        if expected != job.root {
            return Err(fail("目标库位置在任务期间已变化；未向新位置提交素材"));
        }
    }
    let ready_assets: HashSet<String> = control
        .status
        .lock()
        .unwrap()
        .items
        .iter()
        .filter(|i| i.state == "pending")
        .map(|i| i.asset_id.clone())
        .collect();
    let mut results = control.status.lock().unwrap().clone();
    let ready_assets = if job.kind == "copy" {
        let assets = plan_copy_assets(&tx, &target, &job.package, &ready_assets, &job.mapping)?;
        for (index, asset) in job.package.assets.iter().enumerate() {
            if let Some(id) = assets.duplicates.get(&asset.id) {
                results.items[index].state = "skipped".into();
                results.items[index].target_asset_id = Some(id.clone());
                results.items[index].error = None;
            }
        }
        assets.copies
    } else { ready_assets };
    let key: Value = serde_json::from_str(&job.request_key).map_err(|e| fail(e.to_string()))?;
    let selected = key.get(3).and_then(|v| v.get("folderId")).and_then(Value::as_str);
    let metadata = plan_metadata(&tx, &target, &job.package, job.kind == "copy", &ready_assets, selected, &job.mapping)?;
    job.mapping = metadata.mapping;
    for planned in metadata.folders {
        if !planned.create { continue; }
        let f = planned.folder;
        intent(&tx, "folder", &planned.id, &target)?;
        tx.execute("INSERT INTO folder(id,scope,parent_id,name,sort_order,open,created_at,updated_at) VALUES(?1,'materials',?2,?3,?4,?5,?6,?7)",params![planned.id,planned.parent,f.name,f.sort_order,f.open,f.created_at,f.updated_at]).map_err(db)?;
    }
    for planned in metadata.tags {
        if !planned.create { continue; }
        let t = planned.tag;
        tx.execute("INSERT INTO material_library_tag(id,library_id,name,color,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6)",params![planned.id,target,t.name,t.color,t.created_at,t.updated_at]).map_err(db)?;
    }
    let mut changed = Vec::new();
    for (index, a) in job.package.assets.iter().enumerate() {
        if !ready_assets.contains(&a.id) {
            continue;
        }
        let id = job.mapped("asset", &a.id)?;
        let own:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM material_library_asset WHERE asset_id=?1 AND library_id=?2)",params![id,target],|r|r.get(0)).map_err(db)?;
        if own {
            results.items[index].state = "copied".into();
            results.items[index].target_asset_id = Some(id);
            results.items[index].error = None;
            continue;
        }
        if job.kind == "copy" {
            let duplicate:Option<String>=tx.query_row("SELECT a.id FROM asset a JOIN material_library_asset m ON m.asset_id=a.id WHERE m.library_id=?1 AND a.content_hash=?2 ORDER BY a.id LIMIT 1",params![target,a.sha256],|r|r.get(0)).optional().map_err(db)?;
            if let Some(existing) = duplicate {
                results.items[index].state = "skipped".into();
                results.items[index].target_asset_id = Some(existing);
                results.items[index].error = None;
                continue;
            }
        }
        let path = media_root.join(media_leaf(job, a)?);
        if !final_media.contains_key(&a.id) {
            return Err(fail("目标已有内容在提交前已变化；请按原目标重试"));
        }
        super::library_archive::open_frozen(
            final_media
                .get(&a.id)
                .ok_or_else(|| fail("提交媒体尚未核验"))?,
        )?;
        let path = path.to_string_lossy().to_string();
        let origin = a.source_url.as_deref().unwrap_or(&path);
        intent(&tx, "asset", &id, &target)?;
        tx.execute("INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash) VALUES(?1,?2,?3,?4,'managed',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",params![id,a.name,origin,path,a.kind,a.mime_type,a.size_bytes as i64,if a.kind=="image"{&path}else{""},a.description,a.rating,a.dominant_color,mapped(job,"folder",&a.folder_id)?,a.imported_at,a.updated_at,a.sha256]).map_err(db)?;
        for tag in &a.tag_ids {
            tx.execute("INSERT INTO item_tag(id,item_type,item_id,tag_id,created_at) VALUES(?1,'asset',?2,?3,?4)",params![super::catalog::unique_id("relation"),id,job.mapped("tag",tag)?,a.imported_at]).map_err(db)?;
        }
        if let Some(s) = &a.source_page {
            tx.execute("INSERT INTO asset_source_page(asset_id,page_url,page_kind,title) VALUES(?1,?2,?3,?4)",params![id,s.page_url,s.page_kind,s.title]).map_err(db)?;
        }
        if let Some(f) = job.package.favorites.iter().find(|f| f.asset_id == a.id) {
            tx.execute("INSERT INTO favorite_item(item_type,item_id,theme,copy,favorited_at,note_updated_at) VALUES('material',?1,?2,?3,?4,?5)",params![id,f.theme,f.copy,f.favorited_at,f.note_updated_at]).map_err(db)?;
        }
        // Source-page relation triggers deliberately touch ordinary edits. A
        // portable restore/copy keeps the frozen meaningful modification time.
        tx.execute(
            "UPDATE asset SET updated_at=?2 WHERE id=?1",
            params![id, a.updated_at],
        )
        .map_err(db)?;
        results.items[index].state = "copied".into();
        results.items[index].target_asset_id = Some(id.clone());
        results.items[index].error = None;
        changed.push(id);
    }
    if job.kind == "restore" {
        for s in &job.package.smart_folders {
            let mut criteria = s.criteria.clone();
            if let crate::smart_folders::SmartFolderCriteria::Material { tag_ids, .. } =
                &mut criteria
            {
                for id in tag_ids {
                    *id = job.mapped("tag", id)?;
                }
            }
            let id = job.mapped("smart", &s.id)?;
            let sort = serde_json::to_value(s.sort).map_err(|e| fail(e.to_string()))?;
            tx.execute("INSERT INTO smart_folder_definition(id,name,source,criteria_version,criteria_json,sort,created_at,updated_at) VALUES(?1,?2,'material',1,?3,?4,?5,?6)",params![id,s.name,serde_json::to_string(&criteria).map_err(|e|fail(e.to_string()))?,sort.as_str().ok_or_else(||fail("智能排序无效"))?,s.created_at,s.updated_at]).map_err(db)?;
            tx.execute(
                "INSERT INTO material_library_smart_folder(definition_id,library_id) VALUES(?1,?2)",
                params![id, target],
            )
            .map_err(db)?;
        }
    }
    results.copied = results.items.iter().filter(|i| i.state == "copied").count();
    results.skipped = results
        .items
        .iter()
        .filter(|i| i.state == "skipped")
        .count();
    results.failed = results.items.iter().filter(|i| i.state == "failed").count();
    results.completed = results.copied + results.skipped + results.failed;
    results.phase = if results.failed > 0 {
        "partial"
    } else {
        "completed"
    }
    .into();
    results.retryable = results.failed > 0;
    results.error = if results.failed > 0 {
        Some("部分素材未复制；请查看逐项结果后重试".into())
    } else {
        None
    };
    publish_change_metadata(&tx, "material-library-transfer", changed, true)?;
    persist_job(base, job, &results, Some(&tx))?;
    tx.commit().map_err(db)?;
    *control.status.lock().unwrap() = results;
    Ok(())
}
