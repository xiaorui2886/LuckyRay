//! Physical asset moves coordinated through the existing Knowledge receipt.
//! This module does not own a registry or independently rewrite Markdown.
use super::*;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialFileMove {
    pub vault_id: String,
    pub asset_id: String,
    pub original_path: String,
    pub destination_path: String,
    pub storage_mode: String,
    pub expected_revision: String,
    pub expected_hash: String,
    pub expected_references: Vec<materials::NoteAttachmentReference>,
}

#[tauri::command]
pub(super) fn knowledge_preview_material_file_move(
    vault_id: String,
    asset_id: String,
    destination_path: String,
) -> Result<knowledge::AttachmentOperationPlan, String> {
    let service = knowledge_service()?;
    let catalog = backend_services()?.material_catalog();
    let plan = preview_with_services(
        &service,
        &catalog,
        &vault_id,
        &asset_id,
        std::path::Path::new(&destination_path),
    )?;
    attachment_coordination::authorize_attachment_plan(&service, plan)
}

pub(super) fn preview_with_services(
    service: &knowledge::KnowledgeService,
    catalog: &materials::MaterialCatalog,
    vault_id: &str,
    asset_id: &str,
    destination: &std::path::Path,
) -> Result<knowledge::AttachmentOperationPlan, String> {
    if service.current_vault_id().map_err(knowledge_error)? != vault_id {
        return Err("knowledge-target-not-current".into());
    }
    attachment_coordination::sync_current_attachment_index(service, catalog)?;
    let asset = catalog
        .get_assets(&[asset_id.into()])
        .map_err(|e| e.message)?
        .into_iter()
        .next()
        .ok_or("素材记录不存在")?;
    if !matches!(asset.storage_mode.as_str(), "source" | "managed") {
        return Err("链接引用仅登记原位置，不移动或改名原文件。".into());
    }
    let details = catalog
        .attachment_details(asset_id)
        .map_err(|e| e.message)?;
    let refs = details
        .references
        .iter()
        .filter(|r| r.vault_id == vault_id)
        .map(|r| (r.note_path.clone(), r.target.clone()))
        .collect::<Vec<_>>();
    if refs.is_empty() {
        return Err("当前知识库没有引用此素材，请切换到引用它的知识库。".into());
    }
    let (original_path, destination_path, expected_hash) = catalog
        .prepare_note_file_move(asset_id, destination)
        .map_err(|e| e.message)?;
    let expected_revision = catalog
        .note_file_revision_for_asset(&asset)
        .map_err(|e| e.message)?;
    let mut plan = service
        .preview_attachment_file_move(
            vault_id,
            &refs,
            std::path::Path::new(&original_path),
            std::path::Path::new(&destination_path),
        )
        .map_err(knowledge_error)?;
    for reference in details.references.iter().filter(|r| r.vault_id != vault_id) {
        plan.issues.push(knowledge::AttachmentOperationIssue {
            document: reference.note_path.clone(),
            target: reference.target.clone(),
            status: "other-vault-pending".into(),
        });
    }
    plan.material_file_move = Some(MaterialFileMove {
        vault_id: vault_id.into(),
        asset_id: asset_id.into(),
        original_path,
        destination_path,
        storage_mode: asset.storage_mode,
        expected_revision,
        expected_hash,
        expected_references: details.references,
    });
    Ok(plan)
}

fn canonical_key(path: &std::path::Path) -> Result<String, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("附件位置不可用：{e}"))?;
    let key = canonical.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let key = key.to_lowercase();
    Ok(key)
}

/// Called with an active source-epoch guard after the durable receipt has
/// recorded pending projection. Failure leaves the original file (or an
/// explicitly reported recovery copy) and never reports the move complete.
pub(super) fn finish_file_move(
    catalog: &materials::MaterialCatalog,
    movement: &MaterialFileMove,
) -> Result<(), String> {
    let asset = catalog
        .get_assets(&[movement.asset_id.clone()])
        .map_err(|e| e.message)?
        .into_iter()
        .next()
        .ok_or("素材记录不存在，文件移动尚未完成")?;
    if asset.storage_mode != movement.storage_mode
        || !matches!(asset.storage_mode.as_str(), "source" | "managed")
    {
        return Err("素材管理方式已变化，请重新预览移动。".into());
    }
    let current = asset.library_path.as_deref().ok_or("素材真实路径缺失")?;
    let current_path = std::path::Path::new(current);
    let destination = std::path::Path::new(&movement.destination_path);
    // A successful Catalog move commits path/hash together. Only that state
    // makes recovery idempotent; an unrelated existing target is not adopted.
    if destination.exists() && canonical_key(current_path)? == canonical_key(destination)? {
        let verified = catalog
            .resolve_external_drag_files(&[asset.id.clone()])
            .map_err(|e| e.message)?;
        let path = verified.first().ok_or("无法校验移动后的素材")?;
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        std::io::copy(&mut file, &mut hash).map_err(|e| e.to_string())?;
        if format!("{:x}", hash.finalize()) != movement.expected_hash {
            return Err("移动后的附件内容已变化，请检查恢复记录。".into());
        }
        return Ok(());
    }
    if canonical_key(current_path)? != canonical_key(std::path::Path::new(&movement.original_path))?
    {
        return Err("素材原位置已变化，请重新预览移动。".into());
    }
    catalog
        .move_asset_file_for_note_coordinator(
            &movement.asset_id,
            destination,
            &movement.expected_revision,
            &movement.expected_references,
            &movement.expected_hash,
        )
        .map_err(|e| e.message)?
        .value
        .ok_or("素材记录不存在，文件移动未完成")?;
    Ok(())
}

/// Undo only the physical move owned by this receipt. The caller restores the
/// recorded Markdown and retains a partial receipt if this reverse move fails.
pub(super) fn rollback_file_move(
    catalog: &materials::MaterialCatalog,
    movement: &MaterialFileMove,
) -> Result<(), String> {
    let asset = catalog
        .get_assets(&[movement.asset_id.clone()])
        .map_err(|e| e.message)?
        .into_iter()
        .next()
        .ok_or("素材记录不存在，无法恢复原位置")?;
    if asset.storage_mode != movement.storage_mode
        || !matches!(asset.storage_mode.as_str(), "source" | "managed")
    {
        return Err("素材管理方式已变化，不能自动恢复原位置。".into());
    }
    let current = std::path::Path::new(asset.library_path.as_deref().ok_or("素材真实路径缺失")?);
    let original = std::path::Path::new(&movement.original_path);
    if original.exists() && canonical_key(current)? == canonical_key(original)? {
        return Ok(());
    }
    if canonical_key(current)? != canonical_key(std::path::Path::new(&movement.destination_path))? {
        return Err("素材已移到其他位置，不能自动回滚。".into());
    }
    // Only original notes can participate in this rollback. Current-vault
    // document revisions are checked by Knowledge; other vaults retain their
    // original literal targets. A fresh snapshot then fences concurrent changes.
    let details = catalog
        .attachment_details(&asset.id)
        .map_err(|e| e.message)?;
    for reference in &details.references {
        let covered = movement.expected_references.iter().any(|before| {
            before.vault_id == reference.vault_id
                && before.note_path == reference.note_path
                && (reference.vault_id == movement.vault_id || before.target == reference.target)
        });
        if !covered
            || canonical_key(std::path::Path::new(&reference.absolute_path))?
                != canonical_key(std::path::Path::new(&movement.destination_path))?
        {
            return Err("移动后新增或修改了笔记引用，不能直接回滚，请重新预览引用更新。".into());
        }
    }
    let revision = catalog
        .note_file_revision_for_asset(&asset)
        .map_err(|e| e.message)?;
    catalog
        .move_asset_file_for_note_coordinator(
            &asset.id,
            original,
            &revision,
            &details.references,
            &movement.expected_hash,
        )
        .map_err(|e| e.message)?
        .value
        .ok_or("素材记录不存在，回滚未完成")?;
    Ok(())
}
