//! Portable metadata snapshot: ordinary members only, from one SQLite read transaction.
//! Physical paths live only in the local transfer journal, never in the package.
use super::catalog::{read_asset, unique_id};
use super::library_package_preferences::{portable_preferences, validate_preferences};
use super::*;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(super) const MAX_ASSETS: usize = 10_000;
pub(super) const MAX_METADATA: u64 = 16 * 1024 * 1024;
pub(super) const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;
pub(super) const MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;
pub(super) const MAX_DEPTH: usize = 64;
pub(super) fn fail(message: impl Into<String>) -> MaterialError {
    MaterialError::new("library-transfer-invalid", message)
}
pub(super) fn db(e: rusqlite::Error) -> MaterialError {
    MaterialError::database("素材库快照/提交失败", e)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackageAsset {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub mime_type: String,
    pub description: String,
    pub rating: Option<i64>,
    pub dominant_color: Option<String>,
    pub folder_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub imported_at: String,
    pub updated_at: String,
    pub source_url: Option<String>,
    pub source_page: Option<MaterialSourcePage>,
    pub sha256: String,
    pub size_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackageFolder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
    pub open: bool,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackageTag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackageSmart {
    pub id: String,
    pub name: String,
    pub criteria: crate::smart_folders::SmartFolderCriteria,
    pub sort: crate::smart_folders::SmartFolderSort,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackageFavorite {
    pub asset_id: String,
    pub theme: String,
    pub copy: String,
    pub favorited_at: String,
    pub note_updated_at: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LibraryPackage {
    pub format: String,
    pub version: u32,
    pub catalog_schema: u32,
    pub complete: bool,
    pub source_library_id: String,
    pub name: String,
    pub snapshot_at: String,
    pub source_version: i64,
    pub preferences: Value,
    pub assets: Vec<PackageAsset>,
    pub folders: Vec<PackageFolder>,
    pub tags: Vec<PackageTag>,
    pub smart_folders: Vec<PackageSmart>,
    pub favorites: Vec<PackageFavorite>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferSelection {
    pub asset_ids: Option<Vec<String>>,
    pub folder_id: Option<String>,
}

fn rows<T, F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>(
    conn: &Connection,
    sql: &str,
    mut f: F,
) -> MaterialResult<Vec<T>> {
    let sql = if sql.contains("LIMIT") {
        sql.into()
    } else {
        format!("{sql} LIMIT 10001")
    };
    let mut bytes = 0u64;
    let result = conn
        .prepare(&sql)
        .map_err(db)?
        .query_map([], |row| {
            for index in 0..row.as_ref().column_count() {
                if let rusqlite::types::ValueRef::Text(value) = row.get_ref(index)? {
                    bytes += value.len() as u64;
                }
            }
            if bytes > MAX_METADATA {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(fail("组织快照超出16MiB预算")),
                ));
            }
            f(row)
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    if result.len() > MAX_ASSETS {
        return Err(fail("库内对象数量超出10000预算"));
    }
    Ok(result)
}

// Allowlist presentation preferences. Watch roots/statuses and file caches carry local
// authority/paths and are deliberately not portable or automatically re-enabled.
pub(super) fn safe_source_url(value: &str) -> Option<String> {
    if value.len() > 32_768 {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    if url.query_pairs().any(|(k, _)| {
        super::models::source_secret_key(&k) || {
            let k = k.to_ascii_lowercase();
            k.contains("token")
                || k.contains("password")
                || k.contains("credential")
                || k.contains("connection_string")
                || k.contains("signing_key")
                || k.ends_with("_secret")
                || matches!(
                    k.as_str(),
                    "session" | "sessionid" | "access_key" | "client_secret"
                )
        }
    }) || url
        .fragment()
        .is_some_and(super::models::source_fragment_has_secret)
    {
        return None;
    }
    Some(url.to_string())
}

impl MaterialCatalog {
    pub(super) fn package_snapshot(
        &self,
        selection: &TransferSelection,
    ) -> MaterialResult<(LibraryPackage, Vec<MaterialAsset>)> {
        if self.attachment_projection {
            return Err(fail("笔记附件不可用于素材库包"));
        }
        let library_id = self.library_scope_key()?;
        let conn = self.open_read()?;
        conn.execute_batch("BEGIN").map_err(db)?;
        let (name, preferences, source_version): (String, String, i64) = conn
            .query_row(
                "SELECT name,preferences_json,version FROM material_library WHERE id=?1",
                [&library_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(db)?;
        let folders=rows(&conn,"SELECT f.id,f.parent_id,f.name,f.sort_order,f.open,f.created_at,f.updated_at FROM folder f JOIN temp.material_visible_folder m ON m.folder_id=f.id ORDER BY f.sort_order,f.id",|r|Ok(PackageFolder{id:r.get(0)?,parent_id:r.get(1)?,name:r.get(2)?,sort_order:r.get(3)?,open:r.get(4)?,created_at:r.get(5)?,updated_at:r.get(6)?}))?;
        let mut allowed_folders: HashSet<String> = folders.iter().map(|f| f.id.clone()).collect();
        if let Some(folder) = &selection.folder_id {
            if !allowed_folders.contains(folder) {
                return Err(fail("分类不属于源素材库"));
            }
            allowed_folders = HashSet::from([folder.clone()]);
            loop {
                let before = allowed_folders.len();
                for f in &folders {
                    if f.parent_id
                        .as_ref()
                        .is_some_and(|p| allowed_folders.contains(p))
                    {
                        allowed_folders.insert(f.id.clone());
                    }
                }
                if before == allowed_folders.len() {
                    break;
                }
            }
        }
        if selection.asset_ids.is_some() && selection.folder_id.is_some() {
            return Err(fail("请选择素材或分类中的一种"));
        }
        let mut ids = rows(
            &conn,
            "SELECT asset_id FROM temp.material_visible_asset ORDER BY asset_id LIMIT 10001",
            |r| r.get::<_, String>(0),
        )?;
        if let Some(selected) = &selection.asset_ids {
            let set: HashSet<_> = selected.iter().collect();
            if set.len() != selected.len()
                || selected.is_empty()
                || selected.len() > MAX_ASSETS
                || selected
                    .iter()
                    .any(|id| super::libraries::assert_member(&conn, "asset", id).is_err())
            {
                return Err(fail("素材选择无效或越过库范围"));
            }
            ids = selected.clone();
        }
        let mut local = Vec::new();
        let mut assets = Vec::new();
        let mut metadata_bytes = 0u64;
        for id in ids {
            let fields:u64=conn.query_row("SELECT length(CAST(COALESCE(description,'') AS BLOB))+length(CAST(name AS BLOB))+length(CAST(original_path AS BLOB))+length(CAST(COALESCE(library_path,'') AS BLOB)) FROM asset WHERE id=?1",[&id],|r|r.get(0)).map_err(db)?;
            metadata_bytes = metadata_bytes
                .checked_add(fields)
                .ok_or_else(|| fail("元数据过大"))?;
            if metadata_bytes > MAX_METADATA {
                return Err(fail("素材元数据快照超出16MiB预算"));
            }
            let a = read_asset(&conn, &id)?;
            if selection.folder_id.is_some()
                && !a
                    .folder_id
                    .as_ref()
                    .is_some_and(|f| allowed_folders.contains(f))
            {
                continue;
            }
            let tag_ids=conn.prepare("SELECT i.tag_id FROM item_tag i JOIN temp.material_visible_tag t ON t.id=i.tag_id WHERE i.item_type='asset' AND i.item_id=?1 ORDER BY i.tag_id").map_err(db)?.query_map([&id],|r|r.get(0)).map_err(db)?.collect::<Result<Vec<String>,_>>().map_err(db)?;
            let page = conn
                .query_row(
                    "SELECT page_url,page_kind,title FROM asset_source_page WHERE asset_id=?1",
                    [&id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .ok()
                .and_then(|(u, k, t)| MaterialSourcePageInput::from_parts(&u, &k, t.as_deref()))
                .filter(|s| safe_source_url(&s.page_url).is_some())
                .map(|s| MaterialSourcePage {
                    asset_id: id.clone(),
                    page_url: s.page_url,
                    page_kind: s.page_kind,
                    title: s.title,
                });
            assets.push(PackageAsset {
                id: a.id.clone(),
                name: a.name.clone(),
                kind: a.kind.clone(),
                mime_type: a.mime_type.clone(),
                description: a.description.clone(),
                rating: a.rating,
                dominant_color: a.dominant_color.clone(),
                folder_id: a.folder_id.clone(),
                tag_ids,
                imported_at: a.imported_at.clone(),
                updated_at: a.updated_at.clone(),
                source_url: safe_source_url(&a.original_path),
                source_page: page,
                sha256: String::new(),
                size_bytes: 0,
            });
            local.push(a);
        }
        if assets.len() > MAX_ASSETS || folders.len() > MAX_ASSETS {
            return Err(fail("本轮库包最多支持10000个素材/分类"));
        }
        let tags = rows(
            &conn,
            "SELECT id,name,color,created_at,updated_at FROM temp.material_visible_tag ORDER BY id",
            |r| {
                Ok(PackageTag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            },
        )?;
        let smart_folders=rows(&conn,"SELECT s.id,s.name,s.criteria_json,s.sort,s.created_at,s.updated_at FROM smart_folder_definition s JOIN material_library_smart_folder m ON m.definition_id=s.id WHERE m.library_id=(SELECT library_id FROM temp.material_library_context) AND s.source='material' ORDER BY s.id",|r|{
            let criteria=serde_json::from_str(&r.get::<_,String>(2)?).map_err(|e|rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,Box::new(e)))?;
            let sort=serde_json::from_value(json!(r.get::<_,String>(3)?)).map_err(|e|rusqlite::Error::FromSqlConversionFailure(3,rusqlite::types::Type::Text,Box::new(e)))?;
            Ok(PackageSmart{id:r.get(0)?,name:r.get(1)?,criteria,sort,created_at:r.get(4)?,updated_at:r.get(5)?})
        })?;
        let included: HashSet<_> = assets.iter().map(|a| a.id.as_str()).collect();
        let favorites=rows(&conn,"SELECT f.item_id,f.theme,f.copy,f.favorited_at,f.note_updated_at FROM favorite_item f JOIN temp.material_visible_asset m ON m.asset_id=f.item_id WHERE f.item_type='material' ORDER BY f.item_id",|r|Ok(PackageFavorite{asset_id:r.get(0)?,theme:r.get(1)?,copy:r.get(2)?,favorited_at:r.get(3)?,note_updated_at:r.get(4)?}))?.into_iter().filter(|f|included.contains(f.asset_id.as_str())).collect();
        conn.execute_batch("COMMIT").map_err(db)?;
        Ok((
            LibraryPackage {
                format: "LuckyRay.MaterialLibrary".into(),
                version: 1,
                catalog_schema: 25,
                complete: true,
                source_library_id: library_id,
                name,
                snapshot_at: chrono::Utc::now().to_rfc3339(),
                source_version,
                preferences: portable_preferences(
                    &serde_json::from_str(&preferences).map_err(|_| fail("库偏好数据无效"))?,
                    &folders.iter().map(|f| &f.id).collect(),
                    &tags.iter().map(|t| &t.id).collect(),
                ),
                assets,
                folders,
                tags,
                smart_folders,
                favorites,
            },
            local,
        ))
    }
}

pub(super) fn validate_package(p: &LibraryPackage) -> MaterialResult<()> {
    if p.format != "LuckyRay.MaterialLibrary"
        || p.version != 1
        || !(24..=25).contains(&p.catalog_schema)
        || !p.complete
    {
        return Err(fail("不支持的库包版本/schema或非完整包"));
    }
    if p.name.trim().is_empty()
        || p.name.chars().count() > 120
        || p.assets.len() > MAX_ASSETS
        || p.folders.len() > MAX_ASSETS
        || p.tags.len() > MAX_ASSETS
        || p.smart_folders.len() > 512
        || p.favorites.len() > MAX_ASSETS
    {
        return Err(fail("库包组织数量/名称超出预算"));
    }
    fn id_set<'a>(ids: impl Iterator<Item = &'a String>) -> MaterialResult<HashSet<&'a String>> {
        let mut set = HashSet::new();
        for id in ids {
            if id.is_empty()
                || id.len() > 256
                || id.chars().any(char::is_control)
                || !set.insert(id)
            {
                return Err(fail("库包对象ID为空、重复或无效"));
            }
        }
        Ok(set)
    }
    let assets = id_set(p.assets.iter().map(|a| &a.id))?;
    if p.source_library_id.is_empty()
        || p.source_library_id.len() > 256
        || p.source_library_id.chars().any(char::is_control)
    {
        return Err(fail("源库身份无效"));
    }
    let folders = id_set(p.folders.iter().map(|f| &f.id))?;
    let tags = id_set(p.tags.iter().map(|t| &t.id))?;
    id_set(p.smart_folders.iter().map(|s| &s.id))?;
    let mut sum = 0u64;
    for a in &p.assets {
        if a.sha256.len() != 64
            || !a
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || a.size_bytes > MAX_FILE
            || a.name.is_empty()
            || a.name.len() > 1024
            || a.description.len() > 1024 * 1024
            || a.mime_type.len() > 256
            || a.kind.len() > 80
            || a.rating.is_some_and(|r| !(0..=5).contains(&r))
        {
            return Err(fail("素材字段/媒体清单无效"));
        }
        sum = sum
            .checked_add(a.size_bytes)
            .ok_or_else(|| fail("库包过大"))?;
        if a.folder_id.as_ref().is_some_and(|f| !folders.contains(f))
            || a.tag_ids.len() > 1024
            || a.tag_ids.iter().collect::<HashSet<_>>().len() != a.tag_ids.len()
            || a.tag_ids.iter().any(|t| !tags.contains(t))
        {
            return Err(fail("库包素材引用未知组织"));
        }
        if a.source_url
            .as_ref()
            .is_some_and(|u| safe_source_url(u).as_ref() != Some(u))
        {
            return Err(fail("来源URL含凭据或无效"));
        }
        if let Some(s) = &a.source_page {
            if s.asset_id != a.id
                || safe_source_url(&s.page_url).is_none()
                || MaterialSourcePageInput::from_parts(
                    &s.page_url,
                    &s.page_kind,
                    s.title.as_deref(),
                )
                .is_none()
            {
                return Err(fail("来源页面无效"));
            }
        }
    }
    if sum > MAX_BYTES {
        return Err(fail("库包媒体超出20GiB预算"));
    }
    let parents: HashMap<_, _> = p
        .folders
        .iter()
        .map(|f| (&f.id, f.parent_id.as_ref()))
        .collect();
    for f in &p.folders {
        if f.name.is_empty() || f.name.len() > 1024 {
            return Err(fail("分类名称无效"));
        }
        let mut cursor = f.parent_id.as_ref();
        let mut seen = HashSet::from([&f.id]);
        while let Some(id) = cursor {
            if !seen.insert(id) || seen.len() > MAX_DEPTH || !folders.contains(id) {
                return Err(fail("分类循环、过深或引用未知分类"));
            }
            cursor = *parents.get(id).unwrap();
        }
    }
    for t in &p.tags {
        if t.name.is_empty()
            || t.name.len() > 1024
            || t.color.as_ref().is_some_and(|c| c.len() > 64)
        {
            return Err(fail("标签字段无效"));
        }
    }
    for s in &p.smart_folders {
        crate::smart_folders::validate_input(crate::smart_folders::SmartFolderDefinitionInput {
            name: s.name.clone(),
            criteria: s.criteria.clone(),
            sort: s.sort,
        })
        .map_err(fail)?;
        match &s.criteria {
            crate::smart_folders::SmartFolderCriteria::Material { tag_ids, .. }
                if tag_ids.iter().all(|t| tags.contains(t)) => {}
            _ => return Err(fail("库包智能规则越过素材域或引用未知标签")),
        };
        if s.name.is_empty() || s.name.len() > 240 {
            return Err(fail("智能规则名称无效"));
        }
    }
    id_set(p.favorites.iter().map(|f| &f.asset_id))?;
    if p.favorites
        .iter()
        .any(|f| !assets.contains(&f.asset_id) || f.theme.len() > 4096 || f.copy.len() > 16384)
    {
        return Err(fail("收藏引用/字段无效"));
    }
    validate_preferences(p)?;
    Ok(())
}

pub(super) fn fresh_map(p: &LibraryPackage) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (prefix, ids) in [
        ("asset", p.assets.iter().map(|a| &a.id).collect::<Vec<_>>()),
        ("folder", p.folders.iter().map(|f| &f.id).collect()),
        ("tag", p.tags.iter().map(|t| &t.id).collect()),
        ("smart", p.smart_folders.iter().map(|s| &s.id).collect()),
    ] {
        for id in ids {
            map.insert(format!("{prefix}:{id}"), unique_id(prefix));
        }
    }
    map
}
