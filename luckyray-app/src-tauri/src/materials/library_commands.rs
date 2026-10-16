//! Local main-window adapter payload. No HTTP route or mobile contract additions.
use super::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LibraryRequest {
    pub library_id: Option<String>,
    pub vault_id: Option<String>,
    pub action: LibraryAction,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum LibraryAction {
    VideoMarks { id: String },
    VideoMarkSave { id: String, #[serde(rename = "sourceRevision")] source_revision: String, mark: super::video_tools::VideoMark },
    VideoMarkDelete { id: String, #[serde(rename = "sourceRevision")] source_revision: String, #[serde(rename = "markId")] mark_id: String },
    VideoFrame { id: String, #[serde(rename = "sourceRevision")] source_revision: String, time: f64, bytes: Vec<u8> },
    AppearancePrepare { id: String },
    AppearanceCommit { token: String },
    AppearanceDiscard { token: String },
    AppearanceQuery {
        ids: Vec<String>,
        query: super::appearance::QueryInput,
        #[serde(rename = "maximumDistance")]
        maximum_distance: f64,
    },
    TransferCopy {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "targetLibraryId")]
        target_library_id: String,
        selection: TransferSelection,
    },
    TransferExport {
        #[serde(rename = "requestId")]
        request_id: String,
        destination: String,
        #[serde(default, rename = "watchRoots")]
        watch_roots: Vec<String>,
        #[serde(skip)]
        protected_roots: Vec<std::path::PathBuf>,
    },
    TransferRestore {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "packagePath")]
        package_path: String,
        root: String,
        name: String,
        #[serde(default, rename = "watchRoots")]
        watch_roots: Vec<String>,
        #[serde(skip)]
        protected_roots: Vec<std::path::PathBuf>,
    },
    TransferList {
        #[serde(default, rename = "unresolvedOnly")]
        unresolved_only: bool,
    },
    TransferStatus {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    TransferCancel {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    TransferRetry {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    Registry {
        #[serde(default)]
        include_hidden: bool,
    },
    Create {
        name: String,
        root: String,
        #[serde(rename = "storageMode")]
        storage_mode: String,
    },
    RenameLibrary {
        name: String,
    },
    Select,
    Hide,
    Show,
    Reopen {
        root: String,
    },
    RelocateLibrary {
        root: String,
    },
    MoveLibraryPreview {
        root: String,
    },
    MoveLibrary {
        #[serde(rename = "requestId")]
        request_id: String,
        root: String,
    },
    MergeLibraryPreview {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    MergeLibrary {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    Preferences {
        value: Value,
    },
    List {
        #[serde(default)]
        filter: MaterialFilter,
    },
    Get {
        ids: Vec<String>,
    },
    Change,
    ImportPaths {
        paths: Vec<String>,
        options: MaterialImportOptions,
        #[serde(default)]
        progress: Option<tauri::ipc::JavaScriptChannelId>,
    },
    ImportBytes {
        items: Vec<MaterialBytesInput>,
        options: MaterialImportOptions,
    },
    ImportFolder {
        path: String,
        options: MaterialImportOptions,
    },
    Update {
        id: String,
        patch: MaterialAssetPatch,
    },
    Delete {
        id: String,
        #[serde(default, rename = "deleteFile")]
        delete_file: bool,
    },
    Relocate {
        id: String,
        path: String,
        #[serde(default)]
        options: MaterialRelocateOptions,
    },
    RenameFile {
        id: String,
        name: String,
    },
    Missing,
    Folders,
    CreateFolder {
        input: MaterialFolderInput,
    },
    RenameFolder {
        id: String,
        name: String,
    },
    DeleteFolder {
        id: String,
    },
    MoveFolder {
        input: MaterialFolderMove,
    },
    Move {
        id: String,
        #[serde(rename = "folderId")]
        folder_id: Option<String>,
    },
    Tags,
    CreateTag {
        name: String,
        color: Option<String>,
    },
    UpdateTag {
        id: String,
        patch: MaterialTagPatch,
    },
    DeleteTag {
        id: String,
    },
    AssetTags {
        id: String,
    },
    SetTags {
        id: String,
        #[serde(rename = "tagIds")]
        tag_ids: Vec<String>,
    },
    TagMap {
        ids: Option<Vec<String>>,
    },
    SourcePage {
        id: String,
    },
    Favorites,
    FavoriteCounts,
    FavoriteAdd {
        id: String,
    },
    FavoriteRemove {
        id: String,
    },
    FavoriteNotes {
        id: String,
        theme: String,
        copy: String,
    },
    SmartFolders,
    SmartCreate {
        input: crate::smart_folders::SmartFolderDefinitionInput,
    },
    SmartUpdate {
        id: String,
        input: crate::smart_folders::SmartFolderDefinitionInput,
    },
    SmartDelete {
        id: String,
    },
    Tasks,
    RetryPendingDeletions,
    ExportStatus {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    ExportCancel {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    ExportDiscard {
        #[serde(rename = "planId")]
        plan_id: String,
    },
    CsvStatus {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    CsvCancel {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    CsvDiscard {
        #[serde(rename = "planId")]
        plan_id: String,
    },
    CsvRetry {
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(default, rename = "watchRoots")]
        watch_roots: Vec<String>,
    },
    ExportPlan {
        request: ExportPlanRequest,
    },
    ExportStart {
        #[serde(rename = "planId")]
        plan_id: String,
        destination: String,
        #[serde(default, rename = "preserveHierarchy")]
        preserve_hierarchy: bool,
        #[serde(default, rename = "watchRoots")]
        watch_roots: Vec<String>,
    },
    CsvPlan {
        request: CsvExportPlanRequest,
    },
    CsvStart {
        #[serde(rename = "planId")]
        plan_id: String,
        destination: String,
        #[serde(default, rename = "includeDescription")]
        include_description: bool,
        #[serde(default, rename = "watchRoots")]
        watch_roots: Vec<String>,
    },
}
fn encode<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}
fn error(e: MaterialError) -> String {
    format!(
        "luckyray-material-error:{}",
        json!({"code":e.code,"message":e.message,"details":e.details})
    )
}

pub(crate) fn execute_library_request(
    base: MaterialCatalog,
    request: LibraryRequest,
) -> Result<Value, String> {
    execute_library_request_with_progress(base, request, &mut |_| {})
}

pub(crate) fn execute_library_request_with_progress(
    base: MaterialCatalog,
    request: LibraryRequest,
    progress: &mut dyn FnMut(Value),
) -> Result<Value, String> {
    use LibraryAction::*;
    if let Some(vault) = request.vault_id.as_deref() {
        if request.library_id.is_some() {
            return Err("material-context-conflict".into());
        }
        let ids = match &request.action {
            Get { ids } => ids.clone(),
            Update { id, .. }
            | AssetTags { id }
            | SetTags { id, .. }
            | SourcePage { id }
            | RenameFile { id, .. }
            | Delete { id, .. }
            | Relocate { id, .. } => vec![id.clone()],
            Tags | CreateTag { .. } => vec![],
            _ => return Err("vault-attachment-operation-not-authorized".into()),
        };
        let c = base.for_vault_attachment_ids(vault, &ids).map_err(error)?;
        return match request.action {
            Delete { id, delete_file } => {
                encode(c.delete_asset(&id, delete_file).map_err(error)?.value)
            }
            Get { ids } => encode(c.get_assets(&ids).map_err(error)?),
            Update { id, patch } => encode(
                c.update_asset(&id, patch, "vault-attachment-update")
                    .map_err(error)?
                    .value,
            ),
            AssetTags { id } => encode(c.get_asset_tags(&id).map_err(error)?),
            SetTags { id, tag_ids } => encode(c.set_asset_tags(&id, tag_ids).map_err(error)?.value),
            SourcePage { id } => encode(c.get_source_page(&id).map_err(error)?),
            CreateTag { name, color } => encode(c.create_tag(&name, color).map_err(error)?.value),
            Tags => encode(
                c.list_tags_scoped(&MaterialQueryScope {
                    scope: "note-attachments".into(),
                    vault_id: Some(vault.into()),
                    include_unreferenced: true,
                })
                .map_err(error)?,
            ),
            RenameFile { id, name } => {
                encode(c.rename_asset_file(&id, &name).map_err(error)?.value)
            }
            Relocate { id, path, options } => encode(
                c.relocate_asset(&id, Path::new(&path), &options)
                    .map_err(error)?
                    .value,
            ),
            _ => Err("vault-attachment-operation-not-authorized".into()),
        };
    }
    let id = request.library_id.as_deref();
    match request.action {
        TransferCopy {
            request_id,
            target_library_id,
            selection,
        } => {
            return encode(
                library_transfer_manager()
                    .start_copy(
                        base,
                        id.ok_or("library-context-required")?,
                        &request_id,
                        &target_library_id,
                        selection,
                    )
                    .map_err(error)?,
            )
        }
        TransferExport {
            request_id,
            destination,
            protected_roots,
            ..
        } => {
            return encode(
                library_transfer_manager()
                    .start_export_guarded(
                        base,
                        id.ok_or("library-context-required")?,
                        &request_id,
                        &destination,
                        &protected_roots,
                    )
                    .map_err(error)?,
            )
        }
        TransferRestore {
            request_id,
            package_path,
            root,
            name,
            protected_roots,
            ..
        } => {
            return encode(
                library_transfer_manager()
                    .start_restore_guarded(
                        base,
                        id.ok_or("library-context-required")?,
                        &request_id,
                        &package_path,
                        &root,
                        &name,
                        &protected_roots,
                    )
                    .map_err(error)?,
            )
        }
        TransferList { unresolved_only } => {
            return encode(
                library_transfer_manager()
                    .list(
                        &base,
                        id.ok_or("library-context-required")?,
                        unresolved_only,
                    )
                    .map_err(error)?,
            )
        }
        TransferStatus { task_id } => {
            return encode(
                library_transfer_manager()
                    .status(&base, id.ok_or("library-context-required")?, &task_id)
                    .map_err(error)?,
            )
        }
        TransferCancel { task_id } => {
            return encode(
                library_transfer_manager()
                    .cancel(&base, id.ok_or("library-context-required")?, &task_id)
                    .map_err(error)?,
            )
        }
        TransferRetry { task_id } => {
            return encode(
                library_transfer_manager()
                    .retry(base, id.ok_or("library-context-required")?, &task_id)
                    .map_err(error)?,
            )
        }
        Registry { include_hidden } => {
            base.recover_library_creations().map_err(error)?;
            let (legacy_id, active_id) = base.library_state().map_err(error)?;
            return Ok(
                json!({"libraries":base.list_libraries(include_hidden).map_err(error)?,"legacyId":legacy_id,"activeId":active_id}),
            );
        }
        Create {
            name,
            root,
            storage_mode,
        } => {
            return encode(
                base.create_library(&name, Path::new(&root), &storage_mode)
                    .map_err(error)?,
            )
        }
        Reopen { root } => return encode(base.reopen_library(Path::new(&root)).map_err(error)?),
        RenameLibrary { name } => {
            base.rename_library(id.ok_or("library-context-required")?, &name)
                .map_err(error)?;
            return Ok(Value::Null);
        }
        Hide | Show => {
            base.set_library_visible(
                id.ok_or("library-context-required")?,
                matches!(request.action, Show),
            )
            .map_err(error)?;
            return Ok(Value::Null);
        }
        Select => {
            base.select_library(id.ok_or("library-context-required")?)
                .map_err(error)?;
            return Ok(Value::Null);
        }
        RelocateLibrary { root } => {
            return encode(
                base.relocate_library(id.ok_or("library-context-required")?, Path::new(&root))
                    .map_err(error)?,
            )
        }
        MoveLibraryPreview { root } => {
            return encode(
                library_transfer_manager().preview_library_move(
                    &base,
                    id.ok_or("library-context-required")?,
                    std::path::Path::new(&root),
                )
                .map_err(error)?,
            )
        }
        MoveLibrary { request_id, root } => {
            return encode(
                library_transfer_manager()
                    .start_move(
                        base,
                        id.ok_or("library-context-required")?,
                        &request_id,
                        &root,
                    )
                    .map_err(error)?,
            )
        }
        MergeLibraryPreview { source_id } => {
            return encode(
                super::library_merge::preview_merge(
                    &base,
                    id.ok_or("library-context-required")?,
                    &source_id,
                )
                .map_err(error)?,
            )
        }
        MergeLibrary { request_id, source_id } => {
            return encode(
                super::library_merge::start_merge(
                    library_transfer_manager(),
                    base,
                    id.ok_or("library-context-required")?,
                    &request_id,
                    &source_id,
                )
                .map_err(error)?,
            )
        }
        Preferences { value } => {
            base.save_library_preferences(id.ok_or("library-context-required")?, value)
                .map_err(error)?;
            return Ok(Value::Null);
        }
        _ => {}
    }
    let context_id = id.ok_or("library-context-required")?;
    let c = if matches!(
        &request.action,
        Tasks
            | AppearanceDiscard { .. }
            | ExportStatus { .. }
            | ExportCancel { .. }
            | ExportDiscard { .. }
            | CsvStatus { .. }
            | CsvCancel { .. }
            | CsvDiscard { .. }
    ) {
        base.for_library_task(context_id)
    } else {
        base.for_library(context_id)
    }
    .map_err(error)?;
    match request.action {
        AppearancePrepare { id } => encode(super::appearance::prepare(&c,&id).map_err(error)?),
        VideoMarks { id } => encode(c.video_marks(&id).map_err(error)?),
        VideoMarkSave { id, source_revision, mark } => { c.save_video_mark(&id, &source_revision, &mark).map_err(error)?; Ok(Value::Null) },
        VideoMarkDelete { id, source_revision, mark_id } => { c.delete_video_mark(&id, &source_revision, &mark_id).map_err(error)?; Ok(Value::Null) },
        VideoFrame { id, source_revision, time, bytes } => encode(c.import_video_frame(&id, &source_revision, time, bytes).map_err(error)?),
        AppearanceCommit { token } => { super::appearance::commit(&c,&token).map_err(error)?; Ok(Value::Null) },
        AppearanceDiscard { token } => { super::appearance::discard(&c,&token).map_err(error)?; Ok(Value::Null) },
        AppearanceQuery { ids, query, maximum_distance } => encode(super::appearance::query(&c,ids,query,maximum_distance).map_err(error)?),
        Tasks => Ok(
            json!({"exports":export_manager().list_scoped(&c)?,"csv":csv_export_manager().list_scoped(&c)?}),
        ),
        RetryPendingDeletions => encode(c.retry_pending_deletions().map_err(error)?),
        List { filter } => encode(c.list_assets(&filter).map_err(error)?),
        Get { ids } => encode(c.get_assets(&ids).map_err(error)?),
        Change => encode(c.read_library_change().map_err(error)?),
        ImportPaths { paths, options, .. } => encode(
            c.import_paths_with_progress(
                &paths
                    .iter()
                    .map(std::path::PathBuf::from)
                    .collect::<Vec<_>>(),
                &options,
                progress,
            )
            .map_err(error)?
            .value,
        ),
        ImportBytes { items, options } => {
            encode(c.import_bytes(items, &options).map_err(error)?.value)
        }
        ImportFolder { path, options } => encode(
            c.import_folder(Path::new(&path), &options)
                .map_err(error)?
                .value,
        ),
        Update { id, patch } => encode(
            c.update_asset(&id, patch, "library-ui-update")
                .map_err(error)?
                .value,
        ),
        Delete { id, delete_file } => {
            encode(c.delete_asset(&id, delete_file).map_err(error)?.value)
        }
        Relocate { id, path, options } => encode(
            c.relocate_asset(&id, Path::new(&path), &options)
                .map_err(error)?
                .value,
        ),
        RenameFile { id, name } => encode(c.rename_asset_file(&id, &name).map_err(error)?.value),
        Missing => encode(c.scan_missing().map_err(error)?),
        Folders => encode(c.list_folders().map_err(error)?),
        CreateFolder { input } => encode(c.create_folder(input).map_err(error)?.value),
        RenameFolder { id, name } => encode(c.rename_folder(&id, &name).map_err(error)?.value),
        DeleteFolder { id } => encode(c.delete_folder(&id).map_err(error)?.value),
        MoveFolder { input } => encode(c.move_folder(input).map_err(error)?.value),
        Move { id, folder_id } => encode(
            c.move_asset(&id, folder_id.as_deref())
                .map_err(error)?
                .value,
        ),
        Tags => encode(c.list_tags().map_err(error)?),
        CreateTag { name, color } => encode(c.create_tag(&name, color).map_err(error)?.value),
        UpdateTag { id, patch } => encode(c.update_tag(&id, patch).map_err(error)?.value),
        DeleteTag { id } => encode(c.delete_tag(&id).map_err(error)?.value),
        AssetTags { id } => encode(c.get_asset_tags(&id).map_err(error)?),
        SetTags { id, tag_ids } => encode(c.set_asset_tags(&id, tag_ids).map_err(error)?.value),
        TagMap { ids } => encode(c.list_asset_tag_map(ids).map_err(error)?),
        SourcePage { id } => encode(c.get_source_page(&id).map_err(error)?),
        Favorites => encode(crate::favorites::list(
            &c.open_read().map_err(error)?,
            crate::favorites::FavoriteItemType::Material,
        )?),
        FavoriteCounts => encode(crate::favorites::counts(&c.open_read().map_err(error)?)?),
        FavoriteAdd { id } => encode(crate::favorites::add(
            &mut c.open_write().map_err(error)?,
            crate::favorites::FavoriteItemType::Material,
            &id,
        )?),
        FavoriteRemove { id } => encode(crate::favorites::remove(
            &mut c.open_write().map_err(error)?,
            crate::favorites::FavoriteItemType::Material,
            &id,
        )?),
        FavoriteNotes { id, theme, copy } => encode(crate::favorites::update_notes(
            &mut c.open_write().map_err(error)?,
            crate::favorites::FavoriteItemType::Material,
            &id,
            &theme,
            &copy,
        )?),
        SmartFolders => encode(
            crate::smart_folders::list(&c.open_read().map_err(error)?)?
                .into_iter()
                .filter(|item| item.source == crate::smart_folders::SmartFolderSource::Material)
                .collect::<Vec<_>>(),
        ),
        SmartCreate { input } => {
            if !matches!(
                input.criteria,
                crate::smart_folders::SmartFolderCriteria::Material { .. }
            ) {
                return Err("material-library-smart-source".into());
            }
            encode(crate::smart_folders::create(
                &mut c.open_write().map_err(error)?,
                input,
            )?)
        }
        SmartUpdate { id, input } => {
            super::libraries::assert_member(&c.open_read().map_err(error)?, "smart", &id)
                .map_err(error)?;
            encode(crate::smart_folders::update(
                &mut c.open_write().map_err(error)?,
                &id,
                input,
            )?)
        }
        SmartDelete { id } => {
            super::libraries::assert_member(&c.open_read().map_err(error)?, "smart", &id)
                .map_err(error)?;
            encode(crate::smart_folders::delete(
                &mut c.open_write().map_err(error)?,
                &id,
            )?)
        }
        ExportStatus { task_id } => {
            export_manager().assert_task_scope(&c, &task_id)?;
            encode(export_manager().status(&task_id)?)
        }
        ExportCancel { task_id } => {
            export_manager().assert_task_scope(&c, &task_id)?;
            encode(export_manager().cancel(&task_id)?)
        }
        ExportDiscard { plan_id } => {
            export_manager().discard_scoped(&c, &plan_id)?;
            Ok(Value::Null)
        }
        CsvStatus { task_id } => {
            csv_export_manager().assert_task_scope(&c, &task_id)?;
            encode(csv_export_manager().status(&task_id)?)
        }
        CsvCancel { task_id } => {
            csv_export_manager().assert_task_scope(&c, &task_id)?;
            encode(csv_export_manager().cancel(&task_id)?)
        }
        CsvDiscard { plan_id } => {
            csv_export_manager().discard_scoped(&c, &plan_id)?;
            Ok(Value::Null)
        }
        CsvRetry {
            task_id,
            watch_roots,
        } => encode(
            csv_export_manager().retry(
                c,
                &task_id,
                &watch_roots
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect::<Vec<_>>(),
            )?,
        ),
        ExportPlan { request } => encode(export_manager().plan(&c, request)?),
        ExportStart {
            plan_id,
            destination,
            preserve_hierarchy,
            watch_roots,
        } => encode(
            export_manager().start(
                c,
                &plan_id,
                &destination,
                preserve_hierarchy,
                &watch_roots
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect::<Vec<_>>(),
            )?,
        ),
        CsvPlan { request } => encode(csv_export_manager().plan(&c, request)?),
        CsvStart {
            plan_id,
            destination,
            include_description,
            watch_roots,
        } => encode(
            csv_export_manager().start(
                c,
                &plan_id,
                &destination,
                include_description,
                &watch_roots
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect::<Vec<_>>(),
            )?,
        ),
        _ => Err("library-operation-invalid".into()),
    }
}
