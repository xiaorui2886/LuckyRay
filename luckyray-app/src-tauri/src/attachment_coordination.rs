//! Catalog projection of saved Markdown. Knowledge owns documents and Vault bytes.
use super::*;

pub(super) fn resolve_attachment_with_material_identity(
    service: &knowledge::KnowledgeService,
    catalog: &materials::MaterialCatalog,
    document_ref: &knowledge::KnowledgeDocumentRef,
    destination: &str,
    wiki: bool,
) -> Result<knowledge::AttachmentResolution, String> {
    let approved = catalog.approved_vault_attachment_paths(&document_ref.vault_id)
        .map_err(|e| e.message)?;
    let mut result = service.resolve_attachment_with_approved_paths(
        document_ref, destination, wiki, &approved,
    ).map_err(knowledge_error)?;
    if result.status == "resolved" {
        if let Some(path) = result.absolute_path.as_deref() {
            result.material_asset_id = catalog.material_id_for_vault_attachment(
                &document_ref.vault_id, std::path::Path::new(path),
            ).map_err(|e| e.message)?;
        }
    }
    Ok(result)
}

fn plan_authorization(plan: &knowledge::AttachmentOperationPlan) -> Result<String, String> {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    let key = KEY.get_or_init(rand::random);
    let mut unsigned = plan.clone();
    unsigned.authorization.clear();
    let payload = serde_json::to_vec(&unsigned).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    digest.update(key);
    digest.update(Sha256::digest(&payload));
    Ok(format!("{:x}", digest.finalize()))
}
pub(super) fn authorize_attachment_plan(
    service: &knowledge::KnowledgeService,
    mut plan: knowledge::AttachmentOperationPlan,
) -> Result<knowledge::AttachmentOperationPlan, String> {
    let active = service
        .active_ui_source_identity()
        .map_err(knowledge_error)?;
    if active.vault_id != plan.vault_id {
        return Err("knowledge-source-inactive".into());
    }
    plan.source_epoch = active.source_epoch;
    plan.authorization = plan_authorization(&plan)?;
    Ok(plan)
}
pub(super) fn verify_attachment_plan(
    plan: &knowledge::AttachmentOperationPlan,
    source_epoch: u64,
) -> Result<(), String> {
    if plan.source_epoch != source_epoch
        || plan.authorization.is_empty()
        || plan.authorization != plan_authorization(plan)?
    {
        return Err("附件预览已失效或发生变化，请重新预览。".into());
    }
    Ok(())
}

pub(super) fn project_saved_mutation(
    mut result: knowledge::KnowledgeMutationResult,
) -> knowledge::KnowledgeMutationResult {
    let outcome = (|| {
        sync_note_attachment_index(
            &knowledge_service()?,
            &backend_services()?.material_catalog(),
            &result.document.summary.document_ref,
        )
    })();
    if let Err(message) = outcome {
        result.index_stale = true;
        result.index_warning = Some(knowledge::KnowledgeMutationWarning {
            code: "attachment-index-pending".into(),
            message,
        });
    }
    result
}

pub(super) fn sync_note_attachment_index(
    service: &knowledge::KnowledgeService,
    catalog: &materials::MaterialCatalog,
    document_ref: &knowledge::KnowledgeDocumentRef,
) -> Result<(), String> {
    let approved = catalog
        .approved_vault_attachment_paths(&document_ref.vault_id)
        .map_err(|e| e.message)?;
    service
        .with_attachment_index_snapshot(document_ref, &approved, |targets, paths| {
            let previous = catalog
                .note_attachment_refs(&document_ref.vault_id, &document_ref.relative_path)
                .map_err(|e| e.message)?;
            let mut refs = Vec::new();
            for (target, path) in paths {
                let asset = catalog
                    .register_note_attachment(
                        std::path::Path::new(&path),
                        &document_ref.vault_id,
                        None,
                    )
                    .map_err(|e| e.message)?;
                refs.push(materials::NoteAttachmentRefInput {
                    asset_id: asset.id,
                    target,
                });
            }
            // Missing files keep their relationship until the saved target itself disappears.
            for reference in previous {
                if targets.contains(&reference.target)
                    && !refs.iter().any(|r| r.target == reference.target)
                {
                    refs.push(reference);
                }
            }
            catalog
                .replace_note_attachment_refs(
                    &document_ref.vault_id,
                    &document_ref.relative_path,
                    &refs,
                )
                .map_err(|e| e.message)
        })
        .map_err(knowledge_error)
}

pub(super) fn sync_current_attachment_index(
    service: &knowledge::KnowledgeService,
    catalog: &materials::MaterialCatalog,
) -> Result<(), String> {
    for document in service.list_documents().map_err(knowledge_error)? {
        sync_note_attachment_index(service, catalog, &document.document_ref)?;
    }
    let version = catalog.read_change().map_err(|e| e.message)?.version;
    let snapshot = service.refresh_index().map_err(knowledge_error)?;
    if snapshot.errors.is_empty() {
        let notes = snapshot
            .documents
            .into_iter()
            .map(|document| document.relative_path)
            .collect::<Vec<_>>();
        catalog
            .prune_note_attachment_refs(&snapshot.vault_id, &notes, version)
            .map_err(|e| e.message)?;
    }
    Ok(())
}

fn approved_documents(
    service: &knowledge::KnowledgeService,
    catalog: &materials::MaterialCatalog,
) -> Result<Vec<(String, Vec<String>)>, String> {
    service
        .list_documents()
        .map_err(knowledge_error)?
        .into_iter()
        .map(|document| {
            let paths = catalog
                .approved_note_attachment_paths(
                    &document.document_ref.vault_id,
                    &document.relative_path,
                )
                .map_err(|e| e.message)?;
            Ok((document.relative_path, paths))
        })
        .collect()
}

#[tauri::command]
pub(super) async fn material_catalog_list_note_attachments(
    vault_id: Option<String>,
    include_unreferenced: Option<bool>,
    filter: Option<materials::MaterialFilter>,
    refresh_index: Option<bool>,
) -> Result<Vec<materials::MaterialAsset>, String> {
    // Existing Vault discovery can read many files. Never perform it on the
    // native event loop, which must continue servicing input and close events.
    tauri::async_runtime::spawn_blocking(move || {
        let service = knowledge_service()?;
        let catalog = backend_services()?.material_catalog();
        if refresh_index.unwrap_or(true)
            && vault_id.as_deref() == service.current_vault_id().ok().as_deref()
        {
            sync_current_attachment_index(&service, &catalog)?;
        }
        catalog
            .list_assets_scoped(
                &filter.unwrap_or_default(),
                &materials::MaterialQueryScope {
                    scope: "note-attachments".into(),
                    vault_id,
                    include_unreferenced: include_unreferenced.unwrap_or(false),
                },
            )
            .map_err(|e| e.message)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) fn material_catalog_attachment_details(
    id: String,
) -> Result<materials::NoteAttachmentDetails, String> {
    backend_services()?
        .material_catalog()
        .attachment_details(&id)
        .map_err(|e| e.message)
}

#[tauri::command]
pub(super) fn material_catalog_promote_note_attachment(
    id: String,
    folder_id: Option<String>,
) -> Result<materials::MaterialAsset, String> {
    backend_services()?
        .material_catalog()
        .promote_note_attachment(&id, folder_id.as_deref())
        .map_err(|e| e.message)
}

#[tauri::command]
pub(super) fn knowledge_get_attachment_handling_policy(vault_id: String) -> Result<String, String> {
    knowledge_service()?
        .attachment_handling_policy(&vault_id)
        .map_err(knowledge_error)
}
#[tauri::command]
pub(super) fn knowledge_set_attachment_handling_policy(
    vault_id: String,
    source_epoch: u64,
    policy: String,
) -> Result<String, String> {
    knowledge_service()?
        .set_attachment_handling_policy(&vault_id, source_epoch, &policy)
        .map_err(knowledge_error)
}

#[tauri::command]
pub(super) fn knowledge_attachment_versions(vault_id: String) -> Result<serde_json::Value, String> {
    let service = knowledge_service()?;
    let catalog = backend_services()?.material_catalog();
    if service.current_vault_id().map_err(knowledge_error)? != vault_id {
        return Err("knowledge-target-not-current".into());
    }
    let paths = catalog
        .approved_vault_attachment_paths(&vault_id)
        .map_err(|e| e.message)?;
    if paths.len() > 4096 {
        return Err("附件自动检查超过本次容量，请分批检查。".into());
    }
    let mut versions = Vec::new();
    let active = service
        .active_ui_source_identity()
        .map_err(knowledge_error)?;
    for path in paths {
        let _source = service
            .lock_active_ui_source(active.source_epoch, Some(&vault_id))
            .map_err(knowledge_error)?;
        catalog
            .register_note_attachment(std::path::Path::new(&path), &vault_id, None)
            .map_err(|e| e.message)?;
        let metadata = std::fs::metadata(&path).ok();
        let version = metadata.as_ref().map(|m| {
            format!(
                "{}-{}",
                m.len(),
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            )
        });
        versions.push(serde_json::json!({"path":path,"version":version}));
    }
    Ok(serde_json::json!({"versions":versions}))
}

#[tauri::command]
pub(super) fn knowledge_preview_attachment_relink(
    vault_id: String,
    asset_id: String,
    new_path: String,
) -> Result<knowledge::AttachmentOperationPlan, String> {
    let service = knowledge_service()?;
    let catalog = backend_services()?.material_catalog();
    if service.current_vault_id().map_err(knowledge_error)? != vault_id {
        return Err("knowledge-target-not-current".into());
    }
    sync_current_attachment_index(&service, &catalog)?;
    let details = catalog
        .attachment_details(&asset_id)
        .map_err(|e| e.message)?;
    let references = details
        .references
        .iter()
        .filter(|r| r.vault_id == vault_id)
        .map(|r| (r.note_path.clone(), r.target.clone()))
        .collect::<Vec<_>>();
    if references.is_empty() {
        return Err("此知识库没有引用这个附件。请切换到引用它的知识库。".into());
    }
    let mut plan = service
        .preview_attachment_relink(&vault_id, &references, std::path::Path::new(&new_path))
        .map_err(knowledge_error)?;
    let asset = catalog
        .get_assets(&[asset_id.clone()])
        .map_err(|e| e.message)?
        .into_iter()
        .next()
        .ok_or("素材记录不存在")?;
    let target_hash = plan
        .external_dependencies
        .first()
        .map(|(_, hash)| hash.as_str());
    if asset.content_hash.as_deref() != target_hash {
        return Err("所选文件与原附件内容不同，请选择原附件的新位置。".into());
    }
    for reference in details.references.iter().filter(|r| r.vault_id != vault_id) {
        plan.issues.push(knowledge::AttachmentOperationIssue {
            document: reference.note_path.clone(),
            target: reference.target.clone(),
            status: "other-vault-pending".into(),
        });
    }
    plan.material_revision = Some(
        catalog
            .note_file_revision_for_asset(&asset)
            .map_err(|e| e.message)?,
    );
    plan.material_original_path = details.absolute_path.clone();
    plan.material_relocation = Some((
        asset_id,
        new_path,
        serde_json::to_string(&details.references).map_err(|e| e.to_string())?,
    ));
    authorize_attachment_plan(&service, plan)
}

pub(super) fn finish_attachment_projection(
    service: &knowledge::KnowledgeService,
    catalog: &materials::MaterialCatalog,
    plan: &knowledge::AttachmentOperationPlan,
    mut result: knowledge::AttachmentOperationResult,
    source_epoch: u64,
) -> knowledge::AttachmentOperationResult {
    let projection = (|| -> Result<(), String> {
        let _source = service
            .lock_active_ui_source(source_epoch, Some(&plan.vault_id))
            .map_err(knowledge_error)?;
        if result.status == "partial"
            && (plan.material_relocation.is_some() || plan.material_file_move.is_some())
        {
            return Ok(());
        }
        if let Some(movement) = &plan.material_file_move {
            crate::attachment_file_moves::finish_file_move(catalog, movement)?;
        }
        if let Some((id, path, snapshot)) = &plan.material_relocation {
            let refs: Vec<materials::NoteAttachmentReference> =
                serde_json::from_str(snapshot).map_err(|e| e.to_string())?;
            // Idempotent recovery: a completed relocation already has the target path.
            let details = catalog.attachment_details(id).map_err(|e| e.message)?;
            let key = |p: &str| {
                p.replace('\\', "/")
                    .trim_start_matches("//?/")
                    .to_lowercase()
            };
            if details.absolute_path.as_deref().map(key) != Some(key(path)) {
                let revision = plan
                    .material_revision
                    .as_deref()
                    .ok_or("附件预览缺少素材版本，请重新预览。")?;
                catalog
                    .relocate_asset_for_note_coordinator(
                        id,
                        std::path::Path::new(path),
                        &materials::MaterialRelocateOptions::default(),
                        Some(revision),
                        &refs,
                    )
                    .map_err(|e| e.message)?;
            }
        }
        for (note, path) in &plan.external_paths {
            let document_ref = knowledge::KnowledgeDocumentRef {
                vault_id: plan.vault_id.clone(),
                relative_path: note.clone(),
            };
            if service
                .read_document(&document_ref)
                .ok()
                .is_some_and(|document| {
                    plan.files.iter().any(|file| {
                        file.relative_path == *note
                            && file.after_revision.as_deref() == Some(document.revision.as_str())
                    })
                })
            {
                let material_id = plan
                    .material_relocation
                    .as_ref()
                    .map(|(id, _, _)| id.as_str())
                    .or_else(|| {
                        plan.material_file_move
                            .as_ref()
                            .map(|movement| movement.asset_id.as_str())
                    });
                catalog
                    .register_note_attachment(
                        std::path::Path::new(path),
                        &plan.vault_id,
                        material_id,
                    )
                    .map_err(|e| e.message)?;
            }
        }
        sync_current_attachment_index(service, catalog)?;
        service
            .record_attachment_projection(&plan.vault_id, &result)
            .map_err(knowledge_error)
    })();
    if let Err(message) = projection {
        result.status = "partial".into();
        result.issues.push(knowledge::AttachmentOperationIssue {
            document: String::new(),
            target: String::new(),
            status: format!("attachment-index-pending: {message}"),
        });
        let _ = service.record_attachment_projection(&plan.vault_id, &result);
    }
    result
}

#[tauri::command]
pub(super) fn knowledge_audit_attachment_portability(
    vault_id: String,
    document_refs: Option<Vec<knowledge::KnowledgeDocumentRef>>,
) -> Result<knowledge::AttachmentAudit, String> {
    let service = knowledge_service()?;
    let catalog = backend_services()?.material_catalog();
    if service.current_vault_id().map_err(knowledge_error)? != vault_id {
        return Err("knowledge-target-not-current".into());
    }
    let approved = approved_documents(&service, &catalog)?;
    let mut mappings = Vec::new();
    for asset in catalog
        .list_assets_scoped(
            &materials::MaterialFilter::default(),
            &materials::MaterialQueryScope {
                scope: "all".into(),
                ..Default::default()
            },
        )
        .map_err(|e| e.message)?
    {
        let path = catalog
            .resolve_external_drag_files(&[asset.id.clone()])
            .ok()
            .and_then(|mut paths| paths.pop());
        mappings.push((asset.id, asset.name, path));
    }
    service
        .audit_attachment_portability(&document_refs.unwrap_or_default(), &approved, &mappings)
        .map_err(knowledge_error)
}

#[tauri::command]
pub(super) async fn knowledge_export_standalone_vault(
    vault_id: String,
    target_root: String,
    source_epoch: u64,
) -> Result<knowledge::AttachmentExportResult, String> {
    let service = knowledge_service()?;
    let catalog = backend_services()?.material_catalog();
    if service.current_vault_id().map_err(knowledge_error)? != vault_id {
        return Err("knowledge-target-not-current".into());
    }
    let approved = approved_documents(&service, &catalog)?;
    tauri::async_runtime::spawn_blocking(move || {
        service
            .export_independent_vault(source_epoch, std::path::Path::new(&target_root), &approved)
            .map_err(knowledge_error)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A relink only changes registration. It cannot recreate a missing old file.
pub(super) fn validate_attachment_rollback(
    plan: &knowledge::AttachmentOperationPlan,
) -> Result<(), String> {
    if plan.material_relocation.is_some() {
        let original = plan
            .material_original_path
            .as_deref()
            .ok_or("该恢复记录缺少原位置，请先重新预览附件恢复。")?;
        if !std::path::Path::new(original).is_file() {
            return Err(
                "原附件位置仍不可用，无法恢复有效的旧引用。请先恢复原文件，或继续使用新位置。"
                    .into(),
            );
        }
        let file = std::fs::File::open(original).map_err(|_| "原附件无法读取。")?;
        if file.metadata().map_err(|_| "原附件无法检查。")?.len() > 64 * 1024 * 1024 {
            return Err("原附件超过容量限制。".into());
        }
        let mut digest = Sha256::new();
        std::io::copy(
            &mut std::io::Read::take(file, 64 * 1024 * 1024 + 1),
            &mut digest,
        )
        .map_err(|_| "原附件无法校验。")?;
        if Some(format!("{:x}", digest.finalize()).as_str())
            != plan
                .external_dependencies
                .first()
                .map(|(_, hash)| hash.as_str())
        {
            return Err("原位置文件内容已经变化，未回滚笔记。".into());
        }
    }
    Ok(())
}

pub(super) fn finish_attachment_rollback(
    service: &knowledge::KnowledgeService,
    catalog: &materials::MaterialCatalog,
    plan: &knowledge::AttachmentOperationPlan,
    mut result: knowledge::AttachmentOperationResult,
    source_epoch: u64,
) -> knowledge::AttachmentOperationResult {
    let outcome = (|| -> Result<(), String> {
        let _source = service
            .lock_active_ui_source(source_epoch, Some(&plan.vault_id))
            .map_err(knowledge_error)?;
        if result.status == "partial" {
            return Ok(());
        }
        if let Some(movement) = &plan.material_file_move {
            crate::attachment_file_moves::rollback_file_move(catalog, movement)?;
        }
        if let Some((id, new_path, snapshot)) = &plan.material_relocation {
            let original = plan
                .material_original_path
                .as_deref()
                .ok_or("恢复记录缺少原附件位置。")?;
            let details = catalog.attachment_details(id).map_err(|e| e.message)?;
            let original_refs: Vec<materials::NoteAttachmentReference> =
                serde_json::from_str(snapshot).map_err(|_| "恢复记录引用快照无效。")?;
            if details.references.iter().any(|reference| {
                !original_refs.iter().any(|old| {
                    old.vault_id == reference.vault_id && old.note_path == reference.note_path
                })
            }) {
                return Err("该附件新增了笔记引用，请重新预览引用影响后操作。".into());
            }
            let key = |path: &str| {
                path.replace('\\', "/")
                    .trim_start_matches("//?/")
                    .to_lowercase()
            };
            let current = details
                .absolute_path
                .as_deref()
                .ok_or("附件记录缺少文件位置。")?;
            if key(current) != key(original) {
                if key(current) != key(new_path) {
                    return Err("附件位置已被其他操作更改，未覆盖该选择。".into());
                }
                let asset = catalog
                    .get_assets(&[id.clone()])
                    .map_err(|e| e.message)?
                    .into_iter()
                    .next()
                    .ok_or("附件记录不存在。")?;
                let revision = catalog
                    .note_file_revision_for_asset(&asset)
                    .map_err(|e| e.message)?;
                catalog
                    .relocate_asset_for_note_coordinator(
                        id,
                        std::path::Path::new(original),
                        &materials::MaterialRelocateOptions::default(),
                        Some(&revision),
                        &details.references,
                    )
                    .map_err(|e| e.message)?;
            }
        }
        sync_current_attachment_index(service, catalog)?;
        service
            .record_attachment_projection(&plan.vault_id, &result)
            .map_err(knowledge_error)
    })();
    if let Err(message) = outcome {
        result.status = "partial".into();
        result.issues.push(knowledge::AttachmentOperationIssue {
            document: String::new(),
            target: String::new(),
            status: format!("attachment-rollback-pending: {message}"),
        });
        let _ = service.record_attachment_projection(&plan.vault_id, &result);
    }
    result
}

#[tauri::command]
pub(super) fn knowledge_discover_attachment_moves(
    vault_id: String,
) -> Result<Vec<materials::NoteAttachmentMoveCandidate>, String> {
    let service = knowledge_service()?;
    let identity = service
        .active_ui_source_identity()
        .map_err(knowledge_error)?;
    if identity.vault_id != vault_id {
        return Err("knowledge-target-not-current".into());
    }
    let candidates = backend_services()?
        .material_catalog()
        .discover_note_attachment_moves(&vault_id)
        .map_err(|e| e.message)?;
    let _source = service
        .lock_active_ui_source(identity.source_epoch, Some(&vault_id))
        .map_err(knowledge_error)?;
    Ok(candidates)
}

#[tauri::command]
pub(super) async fn knowledge_export_note_archive(
    caller: tauri::Webview,
    document_ref: knowledge::KnowledgeDocumentRef, target_path: String, source_epoch: u64,
) -> Result<knowledge::AttachmentExportResult, String> {
    require_main_caller(&caller)?;
    let service = knowledge_service()?;
    let catalog = backend_services()?.material_catalog();
    if service.current_vault_id().map_err(knowledge_error)? != document_ref.vault_id {
        return Err("knowledge-target-not-current".into());
    }
    let approved = approved_documents(&service, &catalog)?;
    tauri::async_runtime::spawn_blocking(move || service.export_note_archive(
        source_epoch, std::path::Path::new(&target_path), &approved, &document_ref,
    ).map_err(knowledge_error)).await.map_err(|e| e.to_string())?
}
