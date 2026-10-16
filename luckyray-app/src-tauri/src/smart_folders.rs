use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

const CRITERIA_VERSION: u32 = 1;
const NAME_MAX_CHARS: usize = 80;
const QUERY_MAX_CHARS: usize = 240;
const FILTER_LIST_MAX_ITEMS: usize = 32;
const FILTER_VALUE_MAX_CHARS: usize = 160;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SmartFolderSource {
    Material,
    Note,
    Canvas,
}

impl SmartFolderSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Material => "material",
            Self::Note => "note",
            Self::Canvas => "canvas",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) enum SmartFolderSort {
    #[serde(rename = "added-desc")]
    AddedDesc,
    #[serde(rename = "modified-desc")]
    ModifiedDesc,
    #[serde(rename = "modified-asc")]
    ModifiedAsc,
    #[serde(rename = "name-asc")]
    NameAsc,
}

impl SmartFolderSort {
    fn as_str(self) -> &'static str {
        match self {
            Self::AddedDesc => "added-desc",
            Self::ModifiedDesc => "modified-desc",
            Self::ModifiedAsc => "modified-asc",
            Self::NameAsc => "name-asc",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "added-desc" => Ok(Self::AddedDesc),
            "modified-desc" => Ok(Self::ModifiedDesc),
            "modified-asc" => Ok(Self::ModifiedAsc),
            "name-asc" => Ok(Self::NameAsc),
            _ => Err("smart-folder-invalid-sort: 智能文件夹排序无效".to_owned()),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SmartFolderTimeWindow {
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "source", rename_all = "lowercase")]
pub(crate) enum SmartFolderCriteria {
    Material {
        #[serde(default)]
        query: String,
        #[serde(default)]
        kinds: Vec<String>,
        #[serde(default, rename = "tagIds")]
        tag_ids: Vec<String>,
        #[serde(default)]
        favorite: Option<bool>,
        #[serde(default)]
        added: SmartFolderTimeWindow,
        #[serde(default)]
        modified: SmartFolderTimeWindow,
    },
    Note {
        #[serde(default)]
        query: String,
        #[serde(default, rename = "tagIds")]
        tag_ids: Vec<String>,
        #[serde(default)]
        favorite: Option<bool>,
        #[serde(default)]
        modified: SmartFolderTimeWindow,
    },
    Canvas {
        #[serde(default)]
        query: String,
        #[serde(default)]
        favorite: Option<bool>,
        #[serde(default)]
        modified: SmartFolderTimeWindow,
    },
}

impl SmartFolderCriteria {
    fn source(&self) -> SmartFolderSource {
        match self {
            Self::Material { .. } => SmartFolderSource::Material,
            Self::Note { .. } => SmartFolderSource::Note,
            Self::Canvas { .. } => SmartFolderSource::Canvas,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SmartFolderDefinitionInput {
    pub name: String,
    pub criteria: SmartFolderCriteria,
    pub sort: SmartFolderSort,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SmartFolderDefinition {
    pub id: String,
    pub name: String,
    pub source: SmartFolderSource,
    pub criteria_version: u32,
    pub criteria: SmartFolderCriteria,
    pub sort: SmartFolderSort,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn list(connection: &Connection) -> Result<Vec<SmartFolderDefinition>, String> {
    let condition=crate::materials::library_namespace_condition(connection,"smart","smart_folder_definition.id").map_err(|e|e.message)?;
    let sql=format!("SELECT id,name,source,criteria_version,criteria_json,sort,created_at,updated_at FROM smart_folder_definition WHERE source<>'material' OR {condition} ORDER BY updated_at DESC,name COLLATE NOCASE ASC");
    let mut statement = connection.prepare(&sql)
        .map_err(database_error)?;
    let rows = statement
        .query_map([], definition_from_row)
        .map_err(database_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

pub(crate) fn create(
    connection: &mut Connection,
    input: SmartFolderDefinitionInput,
) -> Result<SmartFolderDefinition, String> {
    let input = validate_input(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let id: String = transaction
        .query_row("SELECT 'smart-' || lower(hex(randomblob(16)))", [], |row| {
            row.get(0)
        })
        .map_err(database_error)?;
    let timestamp = chrono::Utc::now().to_rfc3339();
    let source = input.criteria.source();
    let criteria_json = serde_json::to_string(&input.criteria)
        .map_err(|error| format!("smart-folder-criteria-encode-failed: {error}"))?;
    transaction
        .execute(
            "INSERT INTO smart_folder_definition(
                id,name,source,criteria_version,criteria_json,sort,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
            rusqlite::params![
                id,
                input.name,
                source.as_str(),
                CRITERIA_VERSION,
                criteria_json,
                input.sort.as_str(),
                timestamp,
            ],
        )
        .map_err(database_error)?;
    if source==SmartFolderSource::Material {crate::materials::bind_smart_library(&transaction,&id).map_err(|e|e.message)?;}
    let definition = query_one(&transaction, &id)?
        .ok_or_else(|| "smart-folder-write-failed: 智能文件夹未能保存".to_owned())?;
    transaction.commit().map_err(database_error)?;
    Ok(definition)
}

pub(crate) fn update(
    connection: &mut Connection,
    id: &str,
    input: SmartFolderDefinitionInput,
) -> Result<SmartFolderDefinition, String> {
    let id = validate_id(id)?;
    let input = validate_input(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let existing=query_one(&transaction,id)?.ok_or("smart-folder-not-found")?;
    if existing.source==SmartFolderSource::Material {crate::materials::assert_library_member(&transaction,"smart",id).map_err(|e|e.message)?;}
    let source = input.criteria.source();
    if source!=existing.source && (source==SmartFolderSource::Material || existing.source==SmartFolderSource::Material) {return Err("smart-folder-source-conflict: 不能改变素材智能文件夹域".into());}
    let criteria_json = serde_json::to_string(&input.criteria)
        .map_err(|error| format!("smart-folder-criteria-encode-failed: {error}"))?;
    let updated = transaction
        .execute(
            "UPDATE smart_folder_definition
             SET name=?1,source=?2,criteria_version=?3,criteria_json=?4,sort=?5,updated_at=?6
             WHERE id=?7",
            rusqlite::params![
                input.name,
                source.as_str(),
                CRITERIA_VERSION,
                criteria_json,
                input.sort.as_str(),
                chrono::Utc::now().to_rfc3339(),
                id,
            ],
        )
        .map_err(database_error)?;
    if updated != 1 {
        return Err("smart-folder-not-found: 智能文件夹不存在".to_owned());
    }
    let definition = query_one(&transaction, id)?
        .ok_or_else(|| "smart-folder-not-found: 智能文件夹不存在".to_owned())?;
    transaction.commit().map_err(database_error)?;
    Ok(definition)
}

pub(crate) fn delete(connection: &mut Connection, id: &str) -> Result<bool, String> {
    let id = validate_id(id)?;
    if let Some(existing)=query_one(connection,id)? {if existing.source==SmartFolderSource::Material {crate::materials::assert_library_member(connection,"smart",id).map_err(|e|e.message)?;}}
    connection
        .execute("DELETE FROM smart_folder_definition WHERE id=?1", [id])
        .map(|count| count > 0)
        .map_err(database_error)
}

fn query_one(connection: &Connection, id: &str) -> Result<Option<SmartFolderDefinition>, String> {
    use rusqlite::OptionalExtension;
    connection
        .query_row(
            "SELECT id,name,source,criteria_version,criteria_json,sort,created_at,updated_at
             FROM smart_folder_definition WHERE id=?1",
            [id],
            definition_from_row,
        )
        .optional()
        .map_err(database_error)
}

fn definition_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SmartFolderDefinition> {
    let source = match row.get::<_, String>(2)?.as_str() {
        "material" => SmartFolderSource::Material,
        "note" => SmartFolderSource::Note,
        "canvas" => SmartFolderSource::Canvas,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let criteria_version = row.get::<_, u32>(3)?;
    if criteria_version != CRITERIA_VERSION {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let criteria_json = row.get::<_, String>(4)?;
    let criteria =
        serde_json::from_str::<SmartFolderCriteria>(&criteria_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    if criteria.source() != source {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let sort_value = row.get::<_, String>(5)?;
    let sort = SmartFolderSort::parse(&sort_value).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(SmartFolderDefinition {
        id: row.get(0)?,
        name: row.get(1)?,
        source,
        criteria_version,
        criteria,
        sort,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub(crate) fn validate_input(input: SmartFolderDefinitionInput) -> Result<SmartFolderDefinitionInput, String> {
    let name = input.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > NAME_MAX_CHARS {
        return Err("smart-folder-invalid-name: 智能文件夹名称无效".to_owned());
    }
    validate_criteria(&input.criteria)?;
    let source = input.criteria.source();
    if source != SmartFolderSource::Material && input.sort == SmartFolderSort::AddedDesc {
        return Err("smart-folder-invalid-sort: 当前来源不支持按添加时间排序".to_owned());
    }
    Ok(SmartFolderDefinitionInput { name, ..input })
}

fn validate_criteria(criteria: &SmartFolderCriteria) -> Result<(), String> {
    match criteria {
        SmartFolderCriteria::Material {
            query,
            kinds,
            tag_ids,
            added,
            modified,
            ..
        } => {
            validate_text("query", query, QUERY_MAX_CHARS)?;
            validate_list("kinds", kinds)?;
            validate_list("tagIds", tag_ids)?;
            validate_window(added)?;
            validate_window(modified)
        }
        SmartFolderCriteria::Note {
            query,
            tag_ids,
            modified,
            ..
        } => {
            validate_text("query", query, QUERY_MAX_CHARS)?;
            validate_list("tagIds", tag_ids)?;
            validate_window(modified)
        }
        SmartFolderCriteria::Canvas {
            query, modified, ..
        } => {
            validate_text("query", query, QUERY_MAX_CHARS)?;
            validate_window(modified)
        }
    }
}

fn validate_list(label: &str, values: &[String]) -> Result<(), String> {
    if values.len() > FILTER_LIST_MAX_ITEMS {
        return Err(format!("smart-folder-invalid-criteria: {label} 条件过多"));
    }
    for value in values {
        if value.is_empty()
            || value.trim() != value
            || value.chars().count() > FILTER_VALUE_MAX_CHARS
        {
            return Err(format!("smart-folder-invalid-criteria: {label} 条件无效"));
        }
    }
    Ok(())
}

fn validate_window(window: &SmartFolderTimeWindow) -> Result<(), String> {
    for value in [&window.after, &window.before].into_iter().flatten() {
        chrono::DateTime::parse_from_rfc3339(value)
            .map_err(|_| "smart-folder-invalid-criteria: 时间条件无效".to_owned())?;
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, max_chars: usize) -> Result<(), String> {
    if value.chars().count() > max_chars {
        return Err(format!("smart-folder-invalid-criteria: {label} 过长"));
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<&str, String> {
    if !value.starts_with("smart-")
        || value.trim() != value
        || value.chars().count() > 80
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("smart-folder-invalid-id: 智能文件夹标识无效".to_owned());
    }
    Ok(value)
}

fn database_error(error: rusqlite::Error) -> String {
    format!("smart-folder-database-error: 智能文件夹数据操作失败: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE smart_folder_definition(
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    source TEXT NOT NULL CHECK(source IN ('material','note','canvas')),
                    criteria_version INTEGER NOT NULL,
                    criteria_json TEXT NOT NULL,
                    sort TEXT NOT NULL CHECK(sort IN ('added-desc','modified-desc','modified-asc','name-asc')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        connection
    }

    fn material_input(name: &str) -> SmartFolderDefinitionInput {
        SmartFolderDefinitionInput {
            name: name.to_owned(),
            criteria: SmartFolderCriteria::Material {
                query: "海边".to_owned(),
                kinds: vec!["image".to_owned()],
                tag_ids: vec!["tag-blue".to_owned()],
                favorite: Some(true),
                added: SmartFolderTimeWindow::default(),
                modified: SmartFolderTimeWindow::default(),
            },
            sort: SmartFolderSort::AddedDesc,
        }
    }

    #[test]
    fn definitions_are_reference_only_and_crud_is_bounded() {
        let mut connection = fixture();
        let created = create(&mut connection, material_input("灵感图")).unwrap();
        assert!(created.id.starts_with("smart-"));
        assert_eq!(created.source, SmartFolderSource::Material);
        assert_eq!(list(&connection).unwrap().len(), 1);
        let updated = update(&mut connection, &created.id, material_input("蓝色灵感")).unwrap();
        assert_eq!(updated.name, "蓝色灵感");
        assert!(delete(&mut connection, &created.id).unwrap());
        assert!(list(&connection).unwrap().is_empty());
    }

    #[test]
    fn criteria_are_discriminated_and_reject_invalid_sort_or_time() {
        let mut connection = fixture();
        let note = SmartFolderDefinitionInput {
            name: "笔记".to_owned(),
            criteria: SmartFolderCriteria::Note {
                query: String::new(),
                tag_ids: vec![],
                favorite: None,
                modified: SmartFolderTimeWindow::default(),
            },
            sort: SmartFolderSort::AddedDesc,
        };
        assert!(create(&mut connection, note)
            .unwrap_err()
            .contains("不支持按添加时间"));
        let mut invalid = material_input("错误时间");
        if let SmartFolderCriteria::Material { added, .. } = &mut invalid.criteria {
            added.after = Some("yesterday".to_owned());
        }
        assert!(create(&mut connection, invalid)
            .unwrap_err()
            .contains("时间条件无效"));

        let canvas = SmartFolderDefinitionInput {
            name: "最早画布".to_owned(),
            criteria: SmartFolderCriteria::Canvas {
                query: String::new(),
                favorite: None,
                modified: SmartFolderTimeWindow::default(),
            },
            sort: SmartFolderSort::ModifiedAsc,
        };
        assert_eq!(
            create(&mut connection, canvas).unwrap().sort,
            SmartFolderSort::ModifiedAsc,
        );
    }
}
