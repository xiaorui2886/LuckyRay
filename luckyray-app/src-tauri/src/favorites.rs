use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

const FAVORITE_THEME_MAX_CHARS: usize = 120;
const FAVORITE_COPY_MAX_CHARS: usize = 1_200;
const FAVORITE_ITEM_ID_MAX_CHARS: usize = 2_048;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FavoriteItemType {
    Material,
    Note,
    Canvas,
}

impl FavoriteItemType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Material => "material",
            Self::Note => "note",
            Self::Canvas => "canvas",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteItem {
    pub item_type: FavoriteItemType,
    pub item_id: String,
    pub theme: String,
    pub copy: String,
    pub favorited_at: String,
    pub note_updated_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteCounts {
    pub material: u64,
    pub note: u64,
    pub canvas: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteRemoval {
    pub removed: bool,
    pub had_notes: bool,
}

pub(crate) fn list(
    connection: &Connection,
    item_type: FavoriteItemType,
) -> Result<Vec<FavoriteItem>, String> {
    let condition=crate::materials::library_namespace_condition(connection,"asset","favorite_item.item_id").map_err(|e|e.message)?;
    let sql=format!("SELECT item_type,item_id,theme,copy,favorited_at,note_updated_at FROM favorite_item WHERE item_type=?1 AND (item_type<>'material' OR {condition}) ORDER BY favorited_at DESC,item_id ASC");
    let mut statement = connection.prepare(&sql)
        .map_err(database_error)?;
    let rows = statement
        .query_map([item_type.as_str()], favorite_from_row)
        .map_err(database_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

pub(crate) fn counts(connection: &Connection) -> Result<FavoriteCounts, String> {
    let mut counts = FavoriteCounts {
        material: 0,
        note: 0,
        canvas: 0,
    };
    let condition=crate::materials::library_namespace_condition(connection,"asset","favorite_item.item_id").map_err(|e|e.message)?;
    let sql=format!("SELECT item_type,COUNT(*) FROM favorite_item WHERE item_type<>'material' OR {condition} GROUP BY item_type");
    let mut statement = connection.prepare(&sql)
        .map_err(database_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })
        .map_err(database_error)?;
    for row in rows {
        let (item_type, count) = row.map_err(database_error)?;
        match item_type.as_str() {
            "material" => counts.material = count,
            "note" => counts.note = count,
            "canvas" => counts.canvas = count,
            _ => return Err("favorite-invalid-type: 收藏记录类型无效".to_string()),
        }
    }
    Ok(counts)
}

pub(crate) fn add(
    connection: &mut Connection,
    item_type: FavoriteItemType,
    item_id: &str,
) -> Result<FavoriteItem, String> {
    let item_id = validate_item_id(item_id)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    assert_material(&transaction,item_type,item_id)?;
    let timestamp = chrono::Utc::now().to_rfc3339();
    transaction
        .execute(
            "INSERT OR IGNORE INTO favorite_item(
                item_type,item_id,theme,copy,favorited_at,note_updated_at
             ) VALUES(?1,?2,'','',?3,NULL)",
            rusqlite::params![item_type.as_str(), item_id, timestamp],
        )
        .map_err(database_error)?;
    let favorite = query_one(&transaction, item_type, item_id)?
        .ok_or_else(|| "favorite-write-failed: 收藏记录未能保存".to_string())?;
    transaction.commit().map_err(database_error)?;
    Ok(favorite)
}

pub(crate) fn update_notes(
    connection: &mut Connection,
    item_type: FavoriteItemType,
    item_id: &str,
    theme: &str,
    copy: &str,
) -> Result<FavoriteItem, String> {
    let item_id = validate_item_id(item_id)?;
    let theme = validate_text("收藏主题", theme, FAVORITE_THEME_MAX_CHARS)?;
    let copy = validate_text("收藏文案", copy, FAVORITE_COPY_MAX_CHARS)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    assert_material(&transaction,item_type,item_id)?;
    let updated = transaction
        .execute(
            "UPDATE favorite_item
             SET theme=?1,copy=?2,note_updated_at=?3
             WHERE item_type=?4 AND item_id=?5",
            rusqlite::params![
                theme,
                copy,
                chrono::Utc::now().to_rfc3339(),
                item_type.as_str(),
                item_id,
            ],
        )
        .map_err(database_error)?;
    if updated != 1 {
        return Err("favorite-not-found: 收藏记录不存在".to_string());
    }
    let favorite = query_one(&transaction, item_type, item_id)?
        .ok_or_else(|| "favorite-not-found: 收藏记录不存在".to_string())?;
    transaction.commit().map_err(database_error)?;
    Ok(favorite)
}

pub(crate) fn remove(
    connection: &mut Connection,
    item_type: FavoriteItemType,
    item_id: &str,
) -> Result<FavoriteRemoval, String> {
    let item_id = validate_item_id(item_id)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    assert_material(&transaction,item_type,item_id)?;
    let had_notes = transaction
        .query_row(
            "SELECT theme<>'' OR copy<>'' FROM favorite_item WHERE item_type=?1 AND item_id=?2",
            rusqlite::params![item_type.as_str(), item_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(database_error)?
        .unwrap_or(false);
    let removed = transaction
        .execute(
            "DELETE FROM favorite_item WHERE item_type=?1 AND item_id=?2",
            rusqlite::params![item_type.as_str(), item_id],
        )
        .map_err(database_error)?
        > 0;
    transaction.commit().map_err(database_error)?;
    Ok(FavoriteRemoval { removed, had_notes })
}

fn query_one(
    connection: &Connection,
    item_type: FavoriteItemType,
    item_id: &str,
) -> Result<Option<FavoriteItem>, String> {
    connection
        .query_row(
            "SELECT item_type,item_id,theme,copy,favorited_at,note_updated_at
             FROM favorite_item WHERE item_type=?1 AND item_id=?2",
            rusqlite::params![item_type.as_str(), item_id],
            favorite_from_row,
        )
        .optional()
        .map_err(database_error)
}

fn favorite_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FavoriteItem> {
    let item_type = match row.get::<_, String>(0)?.as_str() {
        "material" => FavoriteItemType::Material,
        "note" => FavoriteItemType::Note,
        "canvas" => FavoriteItemType::Canvas,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(FavoriteItem {
        item_type,
        item_id: row.get(1)?,
        theme: row.get(2)?,
        copy: row.get(3)?,
        favorited_at: row.get(4)?,
        note_updated_at: row.get(5)?,
    })
}

fn validate_item_id(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > FAVORITE_ITEM_ID_MAX_CHARS
    {
        return Err("favorite-invalid-item-id: 收藏来源标识无效".to_string());
    }
    Ok(value)
}

fn validate_text<'a>(label: &str, value: &'a str, max_chars: usize) -> Result<&'a str, String> {
    if value.chars().count() > max_chars {
        return Err(format!("favorite-text-too-long: {label}过长"));
    }
    Ok(value)
}

fn database_error(error: rusqlite::Error) -> String {
    format!("favorite-database-error: 收藏数据操作失败: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE favorite_item(
                    item_type TEXT NOT NULL CHECK(item_type IN ('material','note','canvas')),
                    item_id TEXT NOT NULL,
                    theme TEXT NOT NULL DEFAULT '',
                    copy TEXT NOT NULL DEFAULT '',
                    favorited_at TEXT NOT NULL,
                    note_updated_at TEXT,
                    PRIMARY KEY(item_type,item_id)
                 );",
            )
            .unwrap();
        connection
    }

    #[test]
    fn favorite_identity_is_idempotent_and_annotations_are_reference_only() {
        let mut connection = fixture();
        let first = add(&mut connection, FavoriteItemType::Material, "asset-a").unwrap();
        let second = add(&mut connection, FavoriteItemType::Material, "asset-a").unwrap();
        assert_eq!(first, second);
        let updated = update_notes(
            &mut connection,
            FavoriteItemType::Material,
            "asset-a",
            "构图",
            "保留这组色彩关系",
        )
        .unwrap();
        assert_eq!(updated.theme, "构图");
        assert_eq!(updated.copy, "保留这组色彩关系");
        assert_eq!(counts(&connection).unwrap().material, 1);
        let removed = remove(&mut connection, FavoriteItemType::Material, "asset-a").unwrap();
        assert_eq!(
            removed,
            FavoriteRemoval {
                removed: true,
                had_notes: true
            }
        );
    }

    #[test]
    fn same_source_id_can_exist_in_different_domains() {
        let mut connection = fixture();
        add(&mut connection, FavoriteItemType::Material, "same-id").unwrap();
        add(&mut connection, FavoriteItemType::Canvas, "same-id").unwrap();
        let result = counts(&connection).unwrap();
        assert_eq!((result.material, result.note, result.canvas), (1, 0, 1));
    }
}

fn assert_material(connection:&Connection,item_type:FavoriteItemType,id:&str)->Result<(),String> {
    if item_type==FavoriteItemType::Material {crate::materials::assert_library_member(connection,"asset",id).map_err(|e|e.message)?;}
    Ok(())
}
