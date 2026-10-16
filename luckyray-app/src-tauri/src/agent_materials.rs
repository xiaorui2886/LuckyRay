use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

use crate::agent_workspace::WorkspaceGrantService;
use crate::materials::{
    MaterialAssetPatch, MaterialCatalog, MaterialFilter, MaterialFolderInput, MaterialFolderMove,
    MaterialImportOptions, MaterialRelocateOptions, MaterialTagPatch,
};
use std::path::Path;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentMaterialSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) mime_type: String,
    pub(crate) size_bytes: Option<i64>,
    pub(crate) description: String,
    pub(crate) rating: Option<i64>,
    pub(crate) dominant_color: Option<String>,
    pub(crate) folder_id: Option<String>,
    pub(crate) tag_ids: Vec<String>,
    pub(crate) imported_at: String,
    pub(crate) updated_at: String,
    pub(crate) revision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialSetTagsInput {
    pub(crate) asset_id: String,
    pub(crate) expected_revision: String,
    pub(crate) tag_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialCategorizeInput {
    pub(crate) asset_id: String,
    pub(crate) expected_revision: String,
    #[serde(default)]
    pub(crate) folder_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialImportFromGrantInput {
    pub(crate) grant_id: String,
    pub(crate) relative_path: String,
    #[serde(default)]
    pub(crate) folder_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentMaterialError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl AgentMaterialError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AgentMaterialError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AgentMaterialError {}

#[derive(Clone)]
pub(crate) struct AgentMaterialService {
    catalog: MaterialCatalog,
    workspace: WorkspaceGrantService,
}

impl AgentMaterialService {
    pub(crate) fn new(catalog: MaterialCatalog, workspace: WorkspaceGrantService) -> Self {
        Self { catalog, workspace }
    }

    pub(crate) fn inspect(
        &self,
        asset_id: &str,
    ) -> Result<AgentMaterialSummary, AgentMaterialError> {
        validate_public_id(asset_id)?;
        let asset = self
            .catalog
            .list_assets(&MaterialFilter::default())
            .map_err(material_error)?
            .into_iter()
            .find(|asset| asset.id == asset_id)
            .ok_or_else(|| {
                AgentMaterialError::new("material-not-found", "Material no longer exists")
            })?;
        let tag_ids = self
            .catalog
            .get_asset_tags(asset_id)
            .map_err(material_error)?;
        let revision = self
            .catalog
            .revision_for_asset(&asset)
            .map_err(material_error)?;
        Ok(AgentMaterialSummary {
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            mime_type: asset.mime_type,
            size_bytes: asset.size_bytes,
            description: asset.description,
            rating: asset.rating,
            dominant_color: asset.dominant_color,
            folder_id: asset.folder_id,
            tag_ids,
            imported_at: asset.imported_at,
            updated_at: asset.updated_at,
            revision,
        })
    }

    pub(crate) fn list(
        &self,
        filter: &MaterialFilter,
    ) -> Result<Vec<AgentMaterialSummary>, AgentMaterialError> {
        self.catalog
            .list_assets(filter)
            .map_err(material_error)?
            .into_iter()
            .map(|asset| {
                let tag_ids = self
                    .catalog
                    .get_asset_tags(&asset.id)
                    .map_err(material_error)?;
                let revision = self
                    .catalog
                    .revision_for_asset(&asset)
                    .map_err(material_error)?;
                Ok(AgentMaterialSummary {
                    id: asset.id,
                    name: asset.name,
                    kind: asset.kind,
                    mime_type: asset.mime_type,
                    size_bytes: asset.size_bytes,
                    description: asset.description,
                    rating: asset.rating,
                    dominant_color: asset.dominant_color,
                    folder_id: asset.folder_id,
                    tag_ids,
                    imported_at: asset.imported_at,
                    updated_at: asset.updated_at,
                    revision,
                })
            })
            .collect()
    }

    pub(crate) fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(AgentMaterialSummary, String)>, AgentMaterialError> {
        self.catalog
            .search_assets(query, limit.min(100))
            .map_err(material_error)?
            .into_iter()
            .map(|hit| Ok((self.inspect(&hit.asset.id)?, hit.snippet)))
            .collect()
    }

    pub(crate) fn change_snapshot(&self) -> Result<Value, AgentMaterialError> {
        serde_json::to_value(self.catalog.read_change().map_err(material_error)?)
            .map_err(|_| material_database_error())
    }

    pub(crate) fn missing_assets(&self) -> Result<Value, AgentMaterialError> {
        let items = self
            .catalog
            .scan_missing()
            .map_err(material_error)?
            .into_iter()
            .map(|item| json!({ "id": item.id, "name": item.name }))
            .collect::<Vec<_>>();
        Ok(json!({ "items": items }))
    }

    pub(crate) fn tag_map(&self, ids: Vec<String>) -> Result<Value, AgentMaterialError> {
        for id in &ids {
            validate_public_id(id)?;
        }
        serde_json::to_value(
            self.catalog
                .list_asset_tag_map(Some(ids))
                .map_err(material_error)?,
        )
        .map_err(|_| material_database_error())
    }

    pub(crate) fn preview(&self, asset_id: &str) -> Result<Value, AgentMaterialError> {
        let asset = self.inspect(asset_id)?;
        let text_preview = self
            .catalog
            .read_agent_text_preview(asset_id, 16 * 1024)
            .map_err(material_error)?;
        let (preview_kind, content, truncated) = match text_preview {
            Some((content, truncated)) => ("text", Some(content), truncated),
            None => ("metadata", None, false),
        };
        Ok(json!({
            "assetId": asset.id,
            "name": asset.name,
            "kind": asset.kind,
            "mimeType": asset.mime_type,
            "description": asset.description,
            "dominantColor": asset.dominant_color,
            "previewKind": preview_kind,
            "content": content,
            "truncated": truncated,
            "revision": asset.revision,
            "available": true,
        }))
    }

    pub(crate) fn references(&self, asset_id: &str) -> Result<Value, AgentMaterialError> {
        let asset = self.inspect(asset_id)?;
        let connection = rusqlite::Connection::open_with_flags(
            self.catalog.db_path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| material_database_error())?;
        let collection_count = connection
            .query_row(
                "SELECT COUNT(*) FROM collection_item
                 WHERE asset_id = ?1 OR processed_asset_id = ?1",
                [asset_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| material_database_error())?;
        let run_artifact_count = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_run_artifact
                 WHERE entity_kind = 'material' AND entity_ref = ?1",
                [asset_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| material_database_error())?;
        Ok(json!({
            "assetId": asset.id,
            "revision": asset.revision,
            "collectionReferences": collection_count.max(0),
            "agentArtifactReferences": run_artifact_count.max(0),
        }))
    }

    pub(crate) fn taxonomy(&self) -> Result<Value, AgentMaterialError> {
        let tags = self
            .catalog
            .list_tags()
            .map_err(material_error)?
            .into_iter()
            .map(|tag| {
                json!({
                    "id": tag.id,
                    "name": tag.name,
                    "color": tag.color,
                    "assetCount": tag.asset_count.max(0),
                    "updatedAt": tag.updated_at,
                })
            })
            .collect::<Vec<_>>();
        let folders = flatten_folders(self.catalog.list_folders().map_err(material_error)?, None);
        Ok(json!({"tags": tags, "folders": folders}))
    }

    pub(crate) fn set_tags(
        &self,
        input: MaterialSetTagsInput,
    ) -> Result<AgentMaterialSummary, AgentMaterialError> {
        validate_public_id(&input.asset_id)?;
        validate_revision(&input.expected_revision)?;
        if input.tag_ids.len() > 64 {
            return Err(AgentMaterialError::new(
                "material-tags-invalid",
                "Too many material tags",
            ));
        }
        let mut unique = BTreeSet::new();
        for tag_id in &input.tag_ids {
            validate_public_id(tag_id)?;
            if !unique.insert(tag_id.clone()) {
                return Err(AgentMaterialError::new(
                    "material-tags-invalid",
                    "Material tags must be unique",
                ));
            }
        }
        let mut connection = rusqlite::Connection::open(self.catalog.db_path())
            .map_err(|_| material_database_error())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| material_database_error())?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| material_database_error())?;
        let current = read_revision_state(&transaction, &input.asset_id)?;
        if current.revision != input.expected_revision {
            return Err(material_conflict());
        }
        for tag_id in &input.tag_ids {
            let exists = transaction
                .query_row("SELECT 1 FROM material_library_tag WHERE id = ?1 AND library_id=(SELECT legacy_id FROM material_library_state WHERE singleton=1)", [tag_id], |_| Ok(()))
                .optional()
                .map_err(|_| material_database_error())?
                .is_some();
            if !exists {
                return Err(AgentMaterialError::new(
                    "material-tag-not-found",
                    "A selected material tag no longer exists",
                ));
            }
        }
        transaction
            .execute(
                "DELETE FROM item_tag WHERE item_type = 'asset' AND item_id = ?1",
                [&input.asset_id],
            )
            .map_err(|_| material_database_error())?;
        let timestamp = chrono::Utc::now().to_rfc3339();
        for tag_id in &input.tag_ids {
            transaction
                .execute(
                    "INSERT INTO item_tag(id, item_type, item_id, tag_id, created_at)
                     VALUES (?1, 'asset', ?2, ?3, ?4)",
                    params![
                        format!("item-tag-{}", random_id()),
                        input.asset_id,
                        tag_id,
                        timestamp
                    ],
                )
                .map_err(|_| material_database_error())?;
        }
        let changed = transaction
            .execute(
                "UPDATE asset SET updated_at = ?2
                 WHERE id = ?1 AND COALESCE(updated_at, imported_at) = ?3",
                params![input.asset_id, timestamp, current.updated_at],
            )
            .map_err(|_| material_database_error())?;
        if changed != 1 {
            return Err(material_conflict());
        }
        crate::materials::publish_change_metadata(
            &transaction,
            "agent-material-tags",
            vec![input.asset_id.clone()],
            false,
        )
        .map_err(material_error)?;
        transaction
            .commit()
            .map_err(|_| material_database_error())?;
        self.inspect(&input.asset_id)
    }

    pub(crate) fn categorize(
        &self,
        input: MaterialCategorizeInput,
    ) -> Result<AgentMaterialSummary, AgentMaterialError> {
        validate_public_id(&input.asset_id)?;
        validate_revision(&input.expected_revision)?;
        if let Some(folder_id) = &input.folder_id {
            validate_public_id(folder_id)?;
        }
        let mut connection = rusqlite::Connection::open(self.catalog.db_path())
            .map_err(|_| material_database_error())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| material_database_error())?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| material_database_error())?;
        let current = read_revision_state(&transaction, &input.asset_id)?;
        if current.revision != input.expected_revision {
            return Err(material_conflict());
        }
        if let Some(folder_id) = &input.folder_id {
            crate::materials::assert_library_member(&transaction,"folder",folder_id).map_err(material_error)?;
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM folder WHERE id = ?1 AND scope = 'materials'",
                    [folder_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|_| material_database_error())?
                .is_some();
            if !exists {
                return Err(AgentMaterialError::new(
                    "material-folder-not-found",
                    "Material folder no longer exists",
                ));
            }
        }
        let timestamp = chrono::Utc::now().to_rfc3339();
        let changed = transaction
            .execute(
                "UPDATE asset SET folder_id = ?2, updated_at = ?3
                 WHERE id = ?1 AND COALESCE(updated_at, imported_at) = ?4",
                params![
                    input.asset_id,
                    input.folder_id,
                    timestamp,
                    current.updated_at
                ],
            )
            .map_err(|_| material_database_error())?;
        if changed != 1 {
            return Err(material_conflict());
        }
        crate::materials::publish_change_metadata(
            &transaction,
            "agent-material-categorize",
            vec![input.asset_id.clone()],
            true,
        )
        .map_err(material_error)?;
        transaction
            .commit()
            .map_err(|_| material_database_error())?;
        self.inspect(&input.asset_id)
    }

    pub(crate) fn update_metadata(
        &self,
        asset_id: &str,
        expected_revision: &str,
        patch: MaterialAssetPatch,
    ) -> Result<AgentMaterialSummary, AgentMaterialError> {
        validate_public_id(asset_id)?;
        validate_revision(expected_revision)?;
        if patch.storage_mode.is_some()
            || patch.original_path.is_some()
            || !matches!(patch.library_path, crate::materials::PatchValue::Missing)
        {
            return Err(AgentMaterialError::new(
                "material-path-authority-invalid",
                "Material paths require an authorized filesystem operation",
            ));
        }
        let mut connection = self.open_immediate()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| material_database_error())?;
        let current = read_revision_state(&transaction, asset_id)?;
        if current.revision != expected_revision {
            return Err(material_conflict());
        }
        let current_asset = transaction
            .query_row(
                "SELECT name, COALESCE(description, ''), rating, dominant_color, folder_id
                 FROM asset WHERE id=?1",
                [asset_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    AgentMaterialError::new("material-not-found", "Material no longer exists")
                }
                _ => material_database_error(),
            })?;
        let name = patch
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current_asset.0);
        let description = patch.description.as_deref().unwrap_or(&current_asset.1);
        let rating = match patch.rating {
            crate::materials::PatchValue::Missing => current_asset.2,
            crate::materials::PatchValue::Value(value) => value.map(|value| value.clamp(0, 5)),
        };
        let dominant_color = match patch.dominant_color {
            crate::materials::PatchValue::Missing => current_asset.3,
            crate::materials::PatchValue::Value(value) => value,
        };
        let folder_id = match patch.folder_id {
            crate::materials::PatchValue::Missing => current_asset.4.clone(),
            crate::materials::PatchValue::Value(value) => value,
        };
        if let Some(folder_id) = &folder_id {
            require_material_folder(&transaction, folder_id)?;
        }
        let timestamp = chrono::Utc::now().to_rfc3339();
        let changed = transaction
            .execute(
                "UPDATE asset SET name=?2, description=?3, rating=?4, dominant_color=?5,
                 folder_id=?6, updated_at=?7 WHERE id=?1 AND COALESCE(updated_at, imported_at)=?8",
                params![
                    asset_id,
                    name,
                    description,
                    rating,
                    dominant_color,
                    folder_id,
                    timestamp,
                    current.updated_at
                ],
            )
            .map_err(|_| material_database_error())?;
        if changed != 1 {
            return Err(material_conflict());
        }
        crate::materials::publish_change_metadata(
            &transaction,
            "dsh-material-update",
            vec![asset_id.to_owned()],
            folder_id != current_asset.4,
        )
        .map_err(material_error)?;
        transaction
            .commit()
            .map_err(|_| material_database_error())?;
        self.inspect(asset_id)
    }

    pub(crate) fn add_tag_names(
        &self,
        asset_id: &str,
        expected_revision: &str,
        names: &[String],
    ) -> Result<AgentMaterialSummary, AgentMaterialError> {
        validate_public_id(asset_id)?;
        validate_revision(expected_revision)?;
        if names.is_empty() || names.len() > 64 {
            return Err(AgentMaterialError::new(
                "material-tags-invalid",
                "Material tags are invalid",
            ));
        }
        let mut connection = self.open_immediate()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| material_database_error())?;
        let current = read_revision_state(&transaction, asset_id)?;
        if current.revision != expected_revision {
            return Err(material_conflict());
        }
        let timestamp = chrono::Utc::now().to_rfc3339();
        for name in names {
            let name = name.trim();
            if name.is_empty() || name.len() > 120 {
                return Err(AgentMaterialError::new(
                    "material-tags-invalid",
                    "Material tags are invalid",
                ));
            }
            let existing = transaction
                .query_row(
                    "SELECT id FROM material_library_tag WHERE name=?1 COLLATE NOCASE AND library_id=(SELECT legacy_id FROM material_library_state WHERE singleton=1) LIMIT 1",
                    [name],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|_| material_database_error())?;
            let tag_id = existing.unwrap_or_else(|| format!("tag-{}", random_id()));
            transaction
                .execute(
                    "INSERT OR IGNORE INTO material_library_tag(id,library_id,name,color,created_at,updated_at) SELECT ?1,legacy_id,?2,NULL,?3,?3 FROM material_library_state WHERE singleton=1",
                    params![tag_id, name, timestamp],
                )
                .map_err(|_| material_database_error())?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO item_tag(id,item_type,item_id,tag_id,created_at)
                     VALUES(?1,'asset',?2,?3,?4)",
                    params![
                        format!("item-tag-{}", random_id()),
                        asset_id,
                        tag_id,
                        timestamp
                    ],
                )
                .map_err(|_| material_database_error())?;
        }
        let changed = transaction
            .execute(
                "UPDATE asset SET updated_at=?2 WHERE id=?1 AND COALESCE(updated_at, imported_at)=?3",
                params![asset_id, timestamp, current.updated_at],
            )
            .map_err(|_| material_database_error())?;
        if changed != 1 {
            return Err(material_conflict());
        }
        crate::materials::publish_change_metadata(
            &transaction,
            "dsh-material-add-tags",
            vec![asset_id.to_owned()],
            false,
        )
        .map_err(material_error)?;
        transaction
            .commit()
            .map_err(|_| material_database_error())?;
        self.inspect(asset_id)
    }

    pub(crate) fn relocate(
        &self,
        asset_id: &str,
        expected_revision: &str,
        target: &Path,
        options: &MaterialRelocateOptions,
    ) -> Result<AgentMaterialSummary, AgentMaterialError> {
        validate_public_id(asset_id)?;
        validate_revision(expected_revision)?;
        self.catalog
            .relocate_asset_with_revision(asset_id, target, options, Some(expected_revision))
            .map_err(material_error)?;
        self.inspect(asset_id)
    }

    pub(crate) fn rename_file(
        &self,
        asset_id: &str,
        expected_revision: &str,
        file_name: &str,
    ) -> Result<AgentMaterialSummary, AgentMaterialError> {
        validate_public_id(asset_id)?;
        validate_revision(expected_revision)?;
        self.catalog
            .rename_asset_file_with_revision(asset_id, file_name, Some(expected_revision))
            .map_err(material_error)?;
        self.inspect(asset_id)
    }

    pub(crate) fn delete(
        &self,
        asset_id: &str,
        expected_revision: &str,
        delete_file: bool,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(asset_id)?;
        validate_revision(expected_revision)?;
        let outcome = self
            .catalog
            .delete_asset_with_revision(asset_id, delete_file, Some(expected_revision))
            .map_err(material_error)?;
        serde_json::to_value(outcome.value).map_err(|_| material_database_error())
    }

    pub(crate) fn remove_record(
        &self,
        asset_id: &str,
        expected_revision: &str,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(asset_id)?;
        validate_revision(expected_revision)?;
        let outcome = self
            .catalog
            .remove_asset_record_with_revision(asset_id, Some(expected_revision))
            .map_err(material_error)?;
        serde_json::to_value(outcome.value).map_err(|_| material_database_error())
    }

    pub(crate) fn create_folder(
        &self,
        parent_id: Option<String>,
        name: String,
    ) -> Result<Value, AgentMaterialError> {
        if let Some(parent_id) = &parent_id {
            validate_public_id(parent_id)?;
        }
        serde_json::to_value(
            self.catalog
                .create_folder(MaterialFolderInput { parent_id, name })
                .map_err(material_error)?
                .value,
        )
        .map_err(|_| material_database_error())
    }

    pub(crate) fn rename_folder(
        &self,
        folder_id: &str,
        expected_updated_at: &str,
        name: &str,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(folder_id)?;
        let value = self
            .catalog
            .rename_folder_with_revision(folder_id, name, Some(expected_updated_at))
            .map_err(material_error)?
            .value;
        serde_json::to_value(value).map_err(|_| material_database_error())
    }

    pub(crate) fn move_folder(
        &self,
        input: MaterialFolderMove,
        expected_updated_at: &str,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(&input.id)?;
        if let Some(target) = &input.target_id {
            validate_public_id(target)?;
        }
        let value = self
            .catalog
            .move_folder_with_revision(input, Some(expected_updated_at))
            .map_err(material_error)?
            .value;
        Ok(json!({ "moved": value }))
    }

    pub(crate) fn delete_folder(
        &self,
        folder_id: &str,
        expected_updated_at: &str,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(folder_id)?;
        let value = self
            .catalog
            .delete_folder_with_revision(folder_id, Some(expected_updated_at))
            .map_err(material_error)?
            .value;
        Ok(json!({ "deleted": value }))
    }

    pub(crate) fn create_tag(
        &self,
        name: &str,
        color: Option<String>,
    ) -> Result<Value, AgentMaterialError> {
        serde_json::to_value(
            self.catalog
                .create_tag(name, color)
                .map_err(material_error)?
                .value,
        )
        .map_err(|_| material_database_error())
    }

    pub(crate) fn update_tag(
        &self,
        tag_id: &str,
        expected_updated_at: &str,
        patch: MaterialTagPatch,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(tag_id)?;
        serde_json::to_value(
            self.catalog
                .update_tag_with_revision(tag_id, patch, Some(expected_updated_at))
                .map_err(material_error)?
                .value,
        )
        .map_err(|_| material_database_error())
    }

    pub(crate) fn delete_tag(
        &self,
        tag_id: &str,
        expected_updated_at: &str,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(tag_id)?;
        let value = self
            .catalog
            .delete_tag_with_revision(tag_id, Some(expected_updated_at))
            .map_err(material_error)?
            .value;
        Ok(json!({ "deleted": value }))
    }

    pub(crate) fn merge_tags(
        &self,
        target_id: &str,
        target_updated_at: &str,
        sources: Vec<(String, String)>,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(target_id)?;
        let source_ids = sources.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        let expected = sources
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        serde_json::to_value(
            self.catalog
                .merge_tags_with_revisions(
                    target_id,
                    Some(target_updated_at),
                    source_ids,
                    &expected,
                )
                .map_err(material_error)?
                .value,
        )
        .map_err(|_| material_database_error())
    }

    pub(crate) fn import_authorized_path(
        &self,
        path: &Path,
        options: &MaterialImportOptions,
    ) -> Result<Value, AgentMaterialError> {
        let outcome = if path.is_dir() {
            self.catalog.import_folder(path, options)
        } else {
            self.catalog.import_paths(&[path.to_path_buf()], options)
        }
        .map_err(material_error)?;
        safe_import_result(outcome.value)
    }

    pub(crate) fn migrate_library(
        &self,
        source: &Path,
        target: &Path,
    ) -> Result<Value, AgentMaterialError> {
        serde_json::to_value(
            self.catalog
                .migrate_managed_library(source, target)
                .map_err(material_error)?
                .value,
        )
        .map_err(|_| material_database_error())
    }

    pub(crate) fn retry_pending_deletions(&self) -> Result<Value, AgentMaterialError> {
        serde_json::to_value(
            self.catalog
                .retry_pending_deletions()
                .map_err(material_error)?,
        )
        .map_err(|_| material_database_error())
    }

    pub(crate) fn clear_thumbnail_references(&self) -> Result<Value, AgentMaterialError> {
        let value = self
            .catalog
            .clear_video_thumbnail_references()
            .map_err(material_error)?
            .value;
        Ok(json!({ "cleared": value }))
    }

    pub(crate) fn import_from_grant(
        &self,
        input: MaterialImportFromGrantInput,
    ) -> Result<Value, AgentMaterialError> {
        validate_public_id(&input.grant_id)?;
        if let Some(folder_id) = &input.folder_id {
            validate_public_id(folder_id)?;
        }
        let path = self
            .workspace
            .resolve_for_import(&input.grant_id, &input.relative_path)
            .map_err(|error| AgentMaterialError::new(error.code, error.message))?;
        let outcome = self
            .catalog
            .import_paths(
                &[path],
                &MaterialImportOptions {
                    folder_id: input.folder_id,
                    storage_mode: "managed".to_owned(),
                    managed_library_dir: None,
                    preserve_folder_structure: false,
                    recursive: false,
                },
            )
            .map_err(material_error)?;
        let safe_assets = outcome
            .value
            .assets
            .iter()
            .map(|asset| {
                json!({
                    "id": asset.id,
                    "name": asset.name,
                    "kind": asset.kind,
                    "mimeType": asset.mime_type,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "importedCount": outcome.value.imported_count,
            "skippedDuplicateCount": outcome.value.skipped_duplicate_count,
            "failedCount": outcome.value.failed_count,
            "assets": safe_assets,
        }))
    }

    fn open_immediate(&self) -> Result<rusqlite::Connection, AgentMaterialError> {
        let connection = rusqlite::Connection::open(self.catalog.db_path())
            .map_err(|_| material_database_error())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| material_database_error())?;
        Ok(connection)
    }
}

fn require_material_folder(
    connection: &rusqlite::Connection,
    folder_id: &str,
) -> Result<(), AgentMaterialError> {
    validate_public_id(folder_id)?;
    crate::materials::assert_library_member(connection,"folder",folder_id).map_err(material_error)?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM folder WHERE id=?1 AND scope='materials'",
            [folder_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| material_database_error())?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(AgentMaterialError::new(
            "material-folder-not-found",
            "Material folder no longer exists",
        ))
    }
}

fn safe_import_result(
    result: crate::materials::MaterialImportResult,
) -> Result<Value, AgentMaterialError> {
    let assets = result
        .assets
        .into_iter()
        .map(|asset| {
            json!({
                "id": asset.id,
                "name": asset.name,
                "kind": asset.kind,
                "mimeType": asset.mime_type,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "importedCount": result.imported_count,
        "skippedDuplicateCount": result.skipped_duplicate_count,
        "failedCount": result.failed_count,
        "assets": assets,
    }))
}

struct RevisionState {
    updated_at: String,
    revision: String,
}

fn read_revision_state(
    connection: &rusqlite::Connection,
    asset_id: &str,
) -> Result<RevisionState, AgentMaterialError> {
    crate::materials::assert_library_member(connection,"asset",asset_id).map_err(material_error)?;
    let row = connection
        .query_row(
            "SELECT id, COALESCE(updated_at, imported_at), folder_id, content_hash
             FROM asset WHERE id = ?1",
            [asset_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| material_database_error())?
        .ok_or_else(|| {
            AgentMaterialError::new("material-not-found", "Material no longer exists")
        })?;
    let mut statement = connection
        .prepare(
            "SELECT tag_id FROM item_tag
             WHERE item_type = 'asset' AND item_id = ?1 ORDER BY tag_id",
        )
        .map_err(|_| material_database_error())?;
    let tags = statement
        .query_map([asset_id], |row| row.get::<_, String>(0))
        .map_err(|_| material_database_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| material_database_error())?;
    Ok(RevisionState {
        updated_at: row.1.clone(),
        revision: crate::materials::material_revision(
            &row.0,
            &row.1,
            row.2.as_deref(),
            row.3.as_deref(),
            &tags,
        ),
    })
}

fn flatten_folders(
    folders: Vec<crate::materials::MaterialFolder>,
    parent_id: Option<String>,
) -> Vec<Value> {
    let mut output = Vec::new();
    for folder in folders {
        let id = folder.id.clone();
        output.push(json!({
            "id": folder.id,
            "name": folder.name,
            "parentId": parent_id,
            "updatedAt": folder.updated_at,
        }));
        output.extend(flatten_folders(folder.children, Some(id)));
    }
    output
}

fn validate_public_id(value: &str) -> Result<(), AgentMaterialError> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(AgentMaterialError::new(
            "material-identity-invalid",
            "Material identity is invalid",
        ));
    }
    Ok(())
}

fn validate_revision(value: &str) -> Result<(), AgentMaterialError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AgentMaterialError::new(
            "material-revision-invalid",
            "Material revision is invalid",
        ))
    }
}

fn material_error(error: crate::materials::MaterialError) -> AgentMaterialError {
    let code = match error.code.as_str() {
        "material-revision-conflict" => "material-revision-conflict",
        "material-folder-not-found" => "material-folder-not-found",
        "material-tag-not-found" => "material-tag-not-found",
        "not-found" | "material-not-found" => "material-not-found",
        _ => "material-operation-failed",
    };
    AgentMaterialError::new(code, error.message)
}

fn material_database_error() -> AgentMaterialError {
    AgentMaterialError::new(
        "material-database-unavailable",
        "Material catalog is unavailable",
    )
}

fn material_conflict() -> AgentMaterialError {
    AgentMaterialError::new(
        "material-revision-conflict",
        "Material changed; reload before applying this proposal",
    )
}

fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_preview_is_bounded_useful_and_never_discloses_the_source_path() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("preview.md");
        std::fs::write(&source, "# Useful preview\n\nVISIBLE-MATERIAL-CONTENT").unwrap();
        let backend = crate::backend::BackendServices::initialize(root.path()).unwrap();
        let imported = backend
            .material_catalog()
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".to_owned(),
                    recursive: false,
                    ..MaterialImportOptions::default()
                },
            )
            .unwrap();
        let asset_id = imported.value.assets[0].id.clone();

        let preview = backend.agent_materials().preview(&asset_id).unwrap();
        assert_eq!(preview["previewKind"], "text");
        assert_eq!(preview["truncated"], false);
        assert!(preview["content"]
            .as_str()
            .is_some_and(|content| content.contains("VISIBLE-MATERIAL-CONTENT")));
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(!serialized.contains(source.to_string_lossy().as_ref()));
        assert!(!serialized.contains("previewToken"));
    }

    #[test]
    fn material_library_r1_old_agent_raw_transaction_checks_default_before_writing() {
        let root=tempfile::tempdir().unwrap();let backend=crate::backend::BackendServices::initialize(root.path()).unwrap();
        let c=backend.material_catalog();let libroot=root.path().join("B");std::fs::create_dir(&libroot).unwrap();
        let lib=c.create_library("B",&libroot,"managed").unwrap();let b=c.for_library(&lib.id).unwrap();
        let input=||vec![crate::materials::MaterialBytesInput{name:"same.txt".into(),original_path:"https://example.test/source".into(),mime_type:"text/plain".into(),bytes:b"content".to_vec(),description:None}];
        let a=c.import_bytes(input(),&MaterialImportOptions::default()).unwrap().value.assets.remove(0);
        let asset=b.import_bytes(input(),&MaterialImportOptions::default()).unwrap().value.assets.remove(0);
        let tag=c.create_tag("new default tag",None).unwrap().value;let foreign_tag=b.create_tag("new B tag",None).unwrap().value;
        let folder=b.create_folder(crate::materials::MaterialFolderInput{name:"foreign folder".into(),parent_id:None}).unwrap().value;
        c.select_library(&lib.id).unwrap();let service=backend.agent_materials();
        let revision=b.revision_for_asset(&asset).unwrap();
        assert!(service.set_tags(MaterialSetTagsInput{asset_id:asset.id.clone(),expected_revision:revision.clone(),tag_ids:vec![tag.id.clone()]}).is_err());
        assert!(service.categorize(MaterialCategorizeInput{asset_id:a.id.clone(),expected_revision:c.revision_for_asset(&a).unwrap(),folder_id:Some(folder.id)}).is_err());
        assert!(service.set_tags(MaterialSetTagsInput{asset_id:a.id.clone(),expected_revision:c.revision_for_asset(&a).unwrap(),tag_ids:vec![foreign_tag.id]}).is_err());
        assert_eq!(b.revision_for_asset(&asset).unwrap(),revision);assert!(b.get_asset_tags(&asset.id).unwrap().is_empty());
        service.set_tags(MaterialSetTagsInput{asset_id:a.id.clone(),expected_revision:c.revision_for_asset(&a).unwrap(),tag_ids:vec![tag.id.clone()]}).unwrap();
        assert_eq!(c.get_asset_tags(&a.id).unwrap(),vec![tag.id]);
        assert!(service.inspect(&asset.id).is_err());
    }
    #[test]
    fn revisions_include_tags_and_folder() {
        let base = crate::materials::material_revision("a", "time", None, Some("hash"), &[]);
        let tagged =
            crate::materials::material_revision("a", "time", None, Some("hash"), &["tag".into()]);
        let folder =
            crate::materials::material_revision("a", "time", Some("folder"), Some("hash"), &[]);
        assert_ne!(base, tagged);
        assert_ne!(base, folder);
    }

    #[test]
    fn revision_format_is_strict() {
        assert!(validate_revision(&"a".repeat(64)).is_ok());
        assert!(validate_revision("not-a-revision").is_err());
    }
}
