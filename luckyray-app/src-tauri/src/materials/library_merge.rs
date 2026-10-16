//! MAT-LIB-R3-B: merge preview. The merge itself is the frozen R2
//! whole-library copy (anchor=source, target), which already maps same-name
//! folders/tags onto the target's existing ones, keeps both sides of a
//! same-name/different-content pair, skips assets whose content already
//! exists in the target (the target's human metadata stays authoritative)
//! and never touches the source registration. This module only computes the
//! honest before-you-commit view of exactly that behavior.
use super::library_package::*;
use super::library_transfer::*;
use super::*;
use rusqlite::OptionalExtension;
use std::collections::HashSet;
use super::library_transfer_commit::{plan_copy_assets, plan_metadata};
use super::library_archive::{freeze_media, verify_media};
use serde_json::json;

fn lib_name(conn: &rusqlite::Connection, id: &str) -> MaterialResult<String> {
    conn.query_row(
        "SELECT name FROM material_library WHERE id=?1 AND state='ready' AND visible=1",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| MaterialError::database("读取库登记失败", e))?
    .ok_or_else(|| fail("源或目标素材库不可用"))
}

fn folder_path(package: &LibraryPackage, id: &Option<String>) -> MaterialResult<Vec<String>> {
    let mut path = vec![];
    let mut cursor = id.as_deref();
    while let Some(id) = cursor {
        if path.len() >= MAX_DEPTH { return Err(fail("分类层级无效")); }
        let folder = package.folders.iter().find(|f| f.id == id).ok_or_else(|| fail("分类快照不完整"))?;
        path.push(folder.name.clone()); cursor = folder.parent_id.as_deref();
    }
    path.reverse(); Ok(path)
}
fn tag_metadata(package: &LibraryPackage, asset: &PackageAsset) -> MaterialResult<Vec<(String, Option<String>)>> {
    let mut tags = asset.tag_ids.iter().map(|id| package.tags.iter().find(|t| &t.id == id)
        .map(|t| (t.name.clone(), t.color.clone())).ok_or_else(|| fail("标签快照不完整")))
        .collect::<MaterialResult<Vec<_>>>()?;
    tags.sort(); Ok(tags)
}
fn metadata_differences(source: &PackageAsset, source_package: &LibraryPackage, target: &PackageAsset, target_package: &LibraryPackage) -> MaterialResult<Vec<&'static str>> {
    let mut fields = vec![];
    if source.name != target.name { fields.push("名称"); }
    if source.description != target.description { fields.push("描述"); }
    if source.rating != target.rating { fields.push("评分"); }
    if source.dominant_color != target.dominant_color { fields.push("颜色"); }
    if folder_path(source_package, &source.folder_id)? != folder_path(target_package, &target.folder_id)? { fields.push("分类"); }
    if tag_metadata(source_package, source)? != tag_metadata(target_package, target)? { fields.push("标签"); }
    if source.source_url != target.source_url || serde_json::to_value(&source.source_page).map_err(|e| fail(e.to_string()))? != serde_json::to_value(&target.source_page).map_err(|e| fail(e.to_string()))? { fields.push("来源"); }
    let favorite = |p: &LibraryPackage, id: &str| p.favorites.iter().find(|f| f.asset_id == id).map(|f| (f.theme.clone(), f.copy.clone()));
    if favorite(source_package, &source.id) != favorite(target_package, &target.id) { fields.push("收藏笔记"); }
    Ok(fields)
}

/// Read-only current impact, using the exact commit planner. File digests are
/// verified, not guessed from a stale cached content_hash. No task or row writes.
pub(crate) fn preview_merge(base: &MaterialCatalog, target_id: &str, source_id: &str) -> MaterialResult<serde_json::Value> {
    if target_id == source_id { return Err(fail("请选择另一个素材库作为合并来源")); }
    let conn = base.open_read()?;
    conn.execute_batch("BEGIN").map_err(db)?;
    let source_name = lib_name(&conn, source_id)?;
    let target_name = lib_name(&conn, target_id)?;
    let source = base.for_library(source_id)?;
    let (mut package, locals) = source.package_snapshot(&TransferSelection::default())?;
    let (target_package, _) = base.for_library(target_id)?.package_snapshot(&TransferSelection::default())?;
    let mut bytes = 0u64;
    for (asset, local) in package.assets.iter_mut().zip(&locals) {
        let media = freeze_media(&source, local)?;
        bytes = bytes.checked_add(media.size).ok_or_else(|| fail("合并预览超出体积预算"))?;
        if bytes > MAX_BYTES { return Err(fail("合并预览超出20GiB预算")); }
        asset.sha256 = verify_media(&media, |_| Ok(()))?;
        asset.size_bytes = media.size;
    }
    let candidates = package.assets.iter().map(|a| a.id.clone()).collect::<HashSet<_>>();
    let mapping = fresh_map(&package);
    let assets = plan_copy_assets(&conn, target_id, &package, &candidates, &mapping)?;
    let metadata = plan_metadata(&conn, target_id, &package, true, &assets.copies, None, &mapping)?;
    let mut identical = vec![]; let mut name_conflicts = vec![]; let mut conflict_count = 0usize;
    let mut metadata_conflicts = 0usize; let mut linked = 0usize; let mut planned_names = HashSet::new();
    for (asset, local) in package.assets.iter().zip(&locals) {
        if let Some(twin_id) = assets.duplicates.get(&asset.id) {
            let twin = target_package.assets.iter().find(|a| &a.id == twin_id)
                .map(|a| (a, &target_package))
                .or_else(|| package.assets.iter().find(|a| mapping.get(&format!("asset:{}", a.id)) == Some(twin_id)).map(|a| (a, &package)))
                .ok_or_else(|| fail("目标库在预览期间已变化，请重新预览"))?;
            let differences = metadata_differences(asset, &package, twin.0, twin.1)?;
            if !differences.is_empty() { metadata_conflicts += 1; }
            identical.push(json!({ "sourceId": asset.id, "sourceName": asset.name, "targetName": twin.0.name,
                "metadataDiffers": !differences.is_empty(), "metadataDifferences": differences }));
        } else {
            if local.storage_mode != "managed" { linked += 1; }
            if target_package.assets.iter().any(|a| a.name == asset.name) || !planned_names.insert(asset.name.clone()) {
                conflict_count += 1;
                if name_conflicts.len() < 50 { name_conflicts.push(json!({ "sourceId": asset.id, "name": asset.name })); }
            }
        }
    }
    let folders_new = metadata.folders.iter().filter(|f| f.create).count();
    let tags_new = metadata.tags.iter().filter(|t| t.create).count();
    let folders_omitted = package.folders.len() - metadata.folders.len();
    let tags_omitted = package.tags.len() - metadata.tags.len();
    let mut notes = vec![];
    if !identical.is_empty() { notes.push(format!("{} 个素材内容相同：跳过复制，沿用目标库已有版本（名称、描述、分类、标签等人工信息）；源库一侧完整保持不变", identical.len())); }
    if metadata_conflicts > 0 { notes.push(format!("{metadata_conflicts} 个同内容素材的人工信息不同，差异已列出；本次不会覆盖或合并这些人工信息，源库版本继续保留")); }
    if conflict_count > 0 { notes.push(format!("{conflict_count} 个同名但内容不同的素材将同时保留为两条记录，显示名称不是身份")); }
    if linked > 0 { notes.push(format!("{linked} 个链接/源文件类素材会在目标库生成独立托管副本")); }
    if folders_omitted > 0 || tags_omitted > 0 { notes.push(format!("{folders_omitted} 个分类和 {tags_omitted} 个标签未被本次实际复制的素材使用，不复制到目标；空分类及只属于跳过素材的分类/标签保留在源库")); }
    notes.push("智能规则与目标库显示偏好不迁移，可在目标库按需重建".into());
    notes.push("源库登记与文件保持不变；如需移除请合并后另行「从列表中移除」（仅隐藏登记，不删文件）".into());
    notes.push("预览反映当前可读内容；执行仍会核验冻结快照，期间源文件或目标变化可能导致失败或实际跳过数量变化".into());
    Ok(json!({
        "sourceId": source_id, "sourceName": source_name, "targetId": target_id, "targetName": target_name,
        "assets": { "total": package.assets.len(), "identicalContent": identical.len(), "newCopies": assets.copies.len(), "metadataConflicts": metadata_conflicts },
        "folders": { "total": package.folders.len(), "mapped": metadata.folders.len() - folders_new, "new": folders_new, "omitted": folders_omitted },
        "tags": { "total": package.tags.len(), "mapped": metadata.tags.len() - tags_new, "new": tags_new, "omitted": tags_omitted },
        "identical": identical, "nameConflicts": name_conflicts, "nameConflictCount": conflict_count, "notes": notes,
    }))
}

/// Validate both sides and hand the merge to the frozen whole-library copy.
pub(crate) fn start_merge(
    manager: &LibraryTransferManager,
    base: MaterialCatalog,
    target_id: &str,
    request_id: &str,
    source_id: &str,
) -> MaterialResult<TransferStatus> {
    preview_merge(&base, target_id, source_id)?;
    manager.start_copy(
        base,
        source_id,
        request_id,
        target_id,
        TransferSelection::default(),
    )
}

#[cfg(test)]
#[path = "library_merge_tests.rs"]
mod tests;
