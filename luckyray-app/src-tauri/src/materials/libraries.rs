//! Local library identity and ordinary membership. Never changes the active Vault.
use super::catalog::*;
use super::models::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const LIBRARY_SCHEMA: &str = include_str!("library_schema.sql");

pub(crate) fn apply_library_schema(conn: &Connection) -> MaterialResult<()> {
    conn.execute_batch(LIBRARY_SCHEMA)
        .map_err(|e| MaterialError::database("建立素材库范围失败", e))?;
    verify_library_schema(conn)
}
pub(crate) fn verify_library_schema(conn: &Connection) -> MaterialResult<()> {
    // Compare the complete catalog-owned declarations. A missing/drifted trigger
    // must fail at bootstrap before another consumer can insert unscoped rows.
    let normalize = |sql: &str| {
        sql.replace("IF NOT EXISTS ", "")
            .trim()
            .trim_end_matches(';')
            .split_whitespace()
            .collect::<String>()
            .to_ascii_lowercase()
    };
    for line in LIBRARY_SCHEMA
        .lines()
        .filter(|line| line.starts_with("CREATE "))
    {
        let words = line.split_whitespace().collect::<Vec<_>>();
        let unique = words.get(1) == Some(&"UNIQUE");
        let name = words[if unique { 6 } else { 5 }].split('(').next().unwrap();
        let start = LIBRARY_SCHEMA.find(line).unwrap();
        let suffix = &LIBRARY_SCHEMA[start..];
        let end = if words[1] == "TRIGGER" {
            suffix.find("\nEND;").map(|end| end + 5)
        } else {
            suffix.find(';').map(|end| end + 1)
        }
        .unwrap();
        let actual: Option<String> = conn
            .query_row("SELECT sql FROM sqlite_schema WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| MaterialError::database("验证库定义失败", e))?;
        if actual
            .as_ref()
            .is_none_or(|sql| normalize(sql) != normalize(&suffix[..end]))
        {
            return Err(MaterialError::new(
                "library-schema-drift",
                format!("素材库定义 {name} 缺失或不匹配"),
            ));
        }
    }
    conn.prepare("SELECT s.legacy_id,s.active_id,l.name,l.root_path,l.storage_mode,l.visible,l.state,l.preferences_json,l.version,c.root_path,w.kind,w.object_id,w.library_id FROM material_library_state s JOIN material_library l ON l.id=s.legacy_id LEFT JOIN material_library_creation c ON c.library_id=l.id LEFT JOIN material_library_write_intent w ON 0").map_err(|e|MaterialError::database("验证素材库字段失败",e))?;
    let invalid: i64 = conn.query_row("SELECT COUNT(*) FROM material_library_asset m JOIN material_note_identity n ON n.asset_id=m.asset_id WHERE n.ordinary=0", [], |r|r.get(0))
        .map_err(|e|MaterialError::database("验证迁移范围失败",e))?;
    if invalid != 0 {
        return Err(MaterialError::new(
            "library-migration-invalid",
            "笔记附件不能成为普通素材",
        ));
    }
    let missing:i64=conn.query_row("SELECT COUNT(*) FROM asset a WHERE NOT EXISTS(SELECT 1 FROM material_note_identity n WHERE n.asset_id=a.id AND n.ordinary=0) AND NOT EXISTS(SELECT 1 FROM material_library_asset m WHERE m.asset_id=a.id)",[],|r|r.get(0)).map_err(|e|MaterialError::database("验证普通素材归属失败",e))?;
    if missing != 0 {
        return Err(MaterialError::new(
            "library-migration-invalid",
            "普通素材缺少唯一库归属",
        ));
    }
    for sql in [
        "SELECT EXISTS(SELECT 1 FROM folder f WHERE f.scope='materials' AND NOT EXISTS(SELECT 1 FROM material_library_folder m WHERE m.folder_id=f.id))",
        "SELECT EXISTS(SELECT 1 FROM smart_folder_definition f WHERE f.source='material' AND NOT EXISTS(SELECT 1 FROM material_library_smart_folder m WHERE m.definition_id=f.id))",
        "SELECT EXISTS(SELECT 1 FROM material_library_asset m WHERE NOT EXISTS(SELECT 1 FROM asset a WHERE a.id=m.asset_id))",
        "SELECT EXISTS(SELECT 1 FROM material_library_folder m WHERE NOT EXISTS(SELECT 1 FROM folder f WHERE f.id=m.folder_id AND f.scope='materials'))",
        "SELECT EXISTS(SELECT 1 FROM material_library_smart_folder m WHERE NOT EXISTS(SELECT 1 FROM smart_folder_definition f WHERE f.id=m.definition_id AND f.source='material'))",
        "SELECT EXISTS(SELECT 1 FROM material_library_tag WHERE library_id NOT IN(SELECT id FROM material_library))",
    ] {
        if conn.query_row(sql,[],|r|r.get::<_,bool>(0)).map_err(|e|MaterialError::database("验证组织集合失败",e))? {return Err(MaterialError::new("library-migration-invalid","素材组织集合缺失或错误"));}
    }
    for (table, column) in [
        ("material_library_asset", "asset_id"),
        ("material_library_folder", "folder_id"),
        ("material_library_smart_folder", "definition_id"),
    ] {
        let mut statement=conn.prepare(&format!("SELECT {column},library_id FROM {table} WHERE library_id NOT IN(SELECT id FROM material_library) LIMIT 1")).map_err(|e|MaterialError::database("验证库组织归属失败",e))?;
        if statement
            .exists([])
            .map_err(|e| MaterialError::database("验证库归属失败", e))?
        {
            return Err(MaterialError::new(
                "library-migration-invalid",
                "库归属引用未知库",
            ));
        }
    }
    let state_count:i64=conn.query_row("SELECT COUNT(*) FROM material_library_state WHERE singleton=1 AND legacy_id IN(SELECT id FROM material_library WHERE visible=1) AND active_id IN(SELECT id FROM material_library WHERE visible=1)",[],|r|r.get(0)).map_err(|e|MaterialError::database("验证默认库身份失败",e))?;
    let intent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM material_library_write_intent",
            [],
            |r| r.get(0),
        )
        .map_err(|e| MaterialError::database("验证归属事务失败", e))?;
    if state_count != 1 || intent_count != 0 {
        return Err(MaterialError::new(
            "library-migration-invalid",
            "库状态或原子归属事务无效",
        ));
    }
    for (name, expected) in [
        (
            "material_library_asset_lookup",
            vec!["library_id", "asset_id"],
        ),
        (
            "material_library_folder_lookup",
            vec!["library_id", "folder_id"],
        ),
        (
            "material_library_smart_lookup",
            vec!["library_id", "definition_id"],
        ),
    ] {
        let mut statement = conn
            .prepare(&format!("PRAGMA index_info({name})"))
            .map_err(|e| MaterialError::database("验证素材库索引失败", e))?;
        let columns = statement
            .query_map([], |r| r.get::<_, String>(2))
            .map_err(|e| MaterialError::database("验证索引失败", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("验证索引失败", e))?;
        if columns != expected {
            return Err(MaterialError::new(
                "library-schema-index-invalid",
                format!("素材库索引 {name} 无效"),
            ));
        }
    }
    Ok(())
}

pub(super) fn has_libraries(conn: &Connection) -> MaterialResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='material_library_state')",
        [],
        |r| r.get(0),
    )
    .map_err(|e| MaterialError::database("读取库版本失败", e))
}

pub(super) fn connection_library(conn: &Connection) -> MaterialResult<Option<String>> {
    if !has_libraries(conn)? {
        return Ok(None);
    }
    let contextual: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_temp_master WHERE name='material_library_context')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| MaterialError::database("读取库上下文失败", e))?;
    if contextual {
        return conn
            .query_row(
                "SELECT library_id FROM temp.material_library_context",
                [],
                |r| r.get(0),
            )
            .map_err(|e| MaterialError::database("读取库上下文失败", e));
    }
    conn.query_row(
        "SELECT legacy_id FROM material_library_state WHERE singleton=1",
        [],
        |r| r.get(0),
    )
    .map(Some)
    .map_err(|e| MaterialError::database("读取默认库失败", e))
}

pub(crate) fn namespace_condition(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> MaterialResult<String> {
    let Some(library) = connection_library(conn)? else {
        return Ok("1".into());
    };
    let library = library.replace('\'', "''");
    let (table, column) = match kind {
        "asset" => ("material_library_asset", "asset_id"),
        "folder" => ("material_library_folder", "folder_id"),
        "smart" => ("material_library_smart_folder", "definition_id"),
        _ => return Err(MaterialError::new("library-kind-invalid", "库对象类型无效")),
    };
    Ok(format!(
        "EXISTS(SELECT 1 FROM {table} ml WHERE ml.{column}={id} AND ml.library_id='{library}')"
    ))
}

pub(crate) fn assert_member(conn: &Connection, kind: &str, id: &str) -> MaterialResult<()> {
    if !has_libraries(conn)? {
        return Ok(());
    }
    let condition = namespace_condition(conn, kind, "?1")?;
    let valid: bool = conn
        .query_row(&format!("SELECT {condition}"), [id], |r| r.get(0))
        .map_err(|e| MaterialError::database("检查素材库归属失败", e))?;
    if !valid {
        return Err(MaterialError::new(
            "material-library-scope",
            "对象不属于此素材库",
        ));
    }
    Ok(())
}
pub(crate) fn bind_smart_library(conn: &Connection, id: &str) -> MaterialResult<()> {
    if let Some(library) = connection_library(conn)? {
        conn.execute("INSERT INTO material_library_smart_folder(definition_id,library_id) VALUES(?1,?2) ON CONFLICT(definition_id) DO UPDATE SET library_id=excluded.library_id",rusqlite::params![id,library]).map_err(|e|MaterialError::database("保存智能文件夹库归属失败",e))?;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialLibrary {
    pub id: String,
    pub name: String,
    pub root_path: Option<String>,
    pub storage_mode: String,
    pub visible: bool,
    pub state: String,
    pub preferences: serde_json::Value,
    pub version: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LibraryIdentity {
    format: u32,
    library_id: String,
}

impl MaterialCatalog {
    /// The pre-library path export API stays legacy-only for registered library
    /// files. Uncatalogued canvas/browser downloads retain their existing route.
    pub(crate) fn assert_legacy_file_path(&self, path: &Path) -> MaterialResult<()> {
        let path = canonical_regular_file(path)?;
        let conn = self.open_read()?;
        if !has_libraries(&conn)? {
            return Ok(());
        }
        let legacy = self.library_state()?.0;
        let mut statement=conn.prepare("SELECT a.original_path,a.library_path,m.library_id FROM asset a JOIN material_library_asset m ON m.asset_id=a.id").map_err(|e|MaterialError::database("验证兼容导出范围失败",e))?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| MaterialError::database("验证兼容导出范围失败", e))?;
        let mut foreign = false;
        for row in rows {
            let (original, managed, library) =
                row.map_err(|e| MaterialError::database("读取导出归属失败", e))?;
            if [Some(original), managed]
                .into_iter()
                .flatten()
                .filter_map(|p| canonical_regular_file(Path::new(&p)).ok())
                .any(|p| p == path)
            {
                if library == legacy {
                    return Ok(());
                }
                foreign = true;
            }
        }
        if foreign {
            return Err(MaterialError::new(
                "material-library-scope",
                "旧导出接口不能读取其他素材库",
            ));
        }
        for library in self.list_libraries(true)? {
            if library.id != legacy {
                if let Some(root) = library.root_path {
                    if canonical_trusted_root(Path::new(&root))
                        .is_ok_and(|root| path.starts_with(root))
                    {
                        return Err(MaterialError::new(
                            "material-library-scope",
                            "旧导出接口不能读取其他素材库目录",
                        ));
                    }
                }
            }
        }
        Ok(())
    }
    pub(crate) fn read_library_change(&self) -> MaterialResult<MaterialChange> {
        let conn = self.open_read()?;
        let id = self.library_scope_key()?;
        let version: i64 = conn
            .query_row(
                "SELECT version FROM material_library WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|e| MaterialError::database("读取素材库变更失败", e))?;
        Ok(MaterialChange {
            version,
            reason: "library-reconcile".into(),
            affected_ids: vec![],
            folders_changed: true,
            occurred_at: chrono::Utc::now().to_rfc3339(),
        })
    }
    pub(crate) fn library_scope_key(&self) -> MaterialResult<String> {
        if let Some(id) = &self.library_id {
            return Ok(id.clone());
        }
        Ok(self.library_state()?.0)
    }

    pub(super) fn import_library_root(
        &self,
        legacy_override: Option<&str>,
    ) -> MaterialResult<PathBuf> {
        if let Some(id) = &self.library_id {
            let lib = self.library_in(&self.open_read()?, id)?;
            if lib.state != "ready" {
                return Err(MaterialError::new(
                    "library-offline",
                    "素材库位置不可用；请重新定位",
                ));
            }
            if let Some(root) = lib.root_path {
                return Ok(Self::verify_library_identity(Path::new(&root), id)?.join("assets"));
            }
        }
        Ok(legacy_override
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.app_data_dir.join("asset-library")))
    }
    /// Existing frozen task control needs only registry identity, even when files are offline/hidden.
    pub(crate) fn for_library_task(&self, id: &str) -> MaterialResult<Self> {
        let conn = self.open_read()?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM material_library WHERE id=?1 AND state='ready')",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| MaterialError::database("读取任务库身份失败", e))?;
        if !exists {
            return Err(MaterialError::new(
                "library-not-found",
                "任务所属素材库未登记",
            ));
        }
        let mut scoped = self.clone();
        scoped.library_id = Some(id.into());
        Ok(scoped)
    }
    pub(crate) fn for_library(&self, id: &str) -> MaterialResult<Self> {
        if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
            return Err(MaterialError::new("library-invalid", "素材库身份无效"));
        }
        let conn = self.open_read()?;
        let library = self.library_in(&conn, id)?;
        if library.state != "ready" || !library.visible {
            return Err(MaterialError::new(
                "library-unavailable",
                match library.state.as_str() {
                    "offline" => "素材库位置不可用，请连接原位置或在库管理中重新定位",
                    "conflict" => "素材库身份与登记不一致，请在库管理中核对位置",
                    "creating" => "素材库创建尚未完成，请在库管理中恢复",
                    _ => "素材库已从列表移除，请在库管理中重新加入",
                },
            ));
        }
        let mut scoped = self.clone();
        scoped.library_id = Some(id.into());
        Ok(scoped)
    }
    pub(crate) fn library_state(&self) -> MaterialResult<(String, String)> {
        self.open_read()?
            .query_row(
                "SELECT legacy_id,active_id FROM material_library_state WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| MaterialError::database("读取当前素材库失败", e))
    }
    pub(crate) fn list_libraries(
        &self,
        include_hidden: bool,
    ) -> MaterialResult<Vec<MaterialLibrary>> {
        let conn = self.open_read()?;
        let mut statement = conn
            .prepare(
                "SELECT id FROM material_library WHERE (?1 OR visible=1) ORDER BY created_at,id",
            )
            .map_err(|e| MaterialError::database("读取素材库列表失败", e))?;
        let ids = statement
            .query_map([include_hidden], |r| r.get::<_, String>(0))
            .map_err(|e| MaterialError::database("读取素材库列表失败", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("读取素材库列表失败", e))?;
        ids.iter().map(|id| self.library_in(&conn, id)).collect()
    }
    fn library_in(&self, conn: &Connection, id: &str) -> MaterialResult<MaterialLibrary> {
        let mut lib=conn.query_row("SELECT id,name,root_path,storage_mode,visible,state,preferences_json,version FROM material_library WHERE id=?1",[id],|r|Ok(MaterialLibrary {
            id:r.get(0)?,name:r.get(1)?,root_path:r.get(2)?,storage_mode:r.get(3)?,visible:r.get(4)?,state:r.get(5)?,preferences:serde_json::from_str(&r.get::<_,String>(6)?).unwrap_or(serde_json::json!({})),version:r.get(7)?
        })).map_err(|e|MaterialError::database("读取素材库失败",e))?;
        if lib.state == "ready" {
            if let Some(root) = &lib.root_path {
                lib.state = match Self::verify_library_identity(Path::new(root), id) {
                    Ok(_) => "ready",
                    Err(e) if e.code == "library-identity-conflict" => "conflict",
                    Err(_) => "offline",
                }
                .into();
            }
        }
        Ok(lib)
    }
    pub(crate) fn create_library(
        &self,
        name: &str,
        root: &Path,
        storage_mode: &str,
    ) -> MaterialResult<MaterialLibrary> {
        let name = validate_library_name(name)?;
        if !matches!(storage_mode, "managed" | "linked" | "source") {
            return Err(MaterialError::new("library-policy-invalid", "存储方式无效"));
        }
        // Caller selects an existing empty directory. Never creates a missing/offline root.
        let root = canonical_trusted_root(root)?;
        if std::fs::read_dir(&root)
            .map_err(|e| MaterialError::io("library-root-unavailable", "读取目录失败", e))?
            .next()
            .is_some()
        {
            return Err(MaterialError::new(
                "library-root-not-empty",
                "新素材库请选择空目录；已有库请用本机重开",
            ));
        }
        let conn = self.open_write()?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| MaterialError::database("开始创建库失败", e))?;
        let id = unique_id("library");
        let at = chrono::Utc::now().to_rfc3339();
        conn.execute("INSERT INTO material_library(id,name,root_path,storage_mode,state,created_at,updated_at) VALUES(?1,?2,?3,?4,'creating',?5,?5)",rusqlite::params![id,name,root.to_string_lossy(),storage_mode,at]).map_err(|e|MaterialError::database("登记素材库失败",e))?;
        conn.execute(
            "INSERT INTO material_library_creation(library_id,root_path) VALUES(?1,?2)",
            rusqlite::params![id, root.to_string_lossy()],
        )
        .map_err(|e| MaterialError::database("登记创建恢复任务失败", e))?;
        conn.execute_batch("COMMIT")
            .map_err(|e| MaterialError::database("保存创建意图失败", e))?;
        self.finish_library_creation(&id)?;
        self.library_in(&conn, &id)
    }
    pub(crate) fn recover_library_creations(&self) -> MaterialResult<()> {
        let conn = self.open_read()?;
        let mut statement = conn
            .prepare("SELECT library_id FROM material_library_creation")
            .map_err(|e| MaterialError::database("读取库创建恢复任务失败", e))?;
        let ids = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| MaterialError::database("读取创建任务失败", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("读取创建任务失败", e))?;
        for id in ids {
            if let Err(error) = self.finish_library_creation(&id) {
                eprintln!("素材库创建尚未恢复 {}: {}", id, error.message);
            }
        }
        Ok(())
    }
    fn finish_library_creation(&self, id: &str) -> MaterialResult<()> {
        let conn = self.open_write()?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| MaterialError::database("开始库创建恢复失败", e))?;
        let root: String = conn
            .query_row(
                "SELECT root_path FROM material_library_creation WHERE library_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| MaterialError::database("读取创建意图失败", e))?;
        let root = canonical_trusted_root(Path::new(&root))?;
        let manifest = root.join("library.json");
        let temporary = root.join(format!(".luckyray-{}.pending", id));
        let bytes = serde_json::to_vec_pretty(&LibraryIdentity {
            format: 1,
            library_id: id.into(),
        })
        .map_err(|e| MaterialError::new("library-identity-invalid", e.to_string()))?;
        if manifest.exists() {
            Self::verify_library_identity(&root, id)?;
        } else {
            for entry in std::fs::read_dir(&root)
                .map_err(|e| MaterialError::io("library-root-unavailable", "读取创建目录失败", e))?
            {
                let path = entry
                    .map_err(|e| {
                        MaterialError::io("library-root-unavailable", "读取创建目录失败", e)
                    })?
                    .path();
                if path != temporary {
                    return Err(MaterialError::new(
                        "library-create-conflict",
                        "创建期间目录新增了其他文件，请先处理目录冲突",
                    ));
                }
            }
            if temporary.exists() {
                canonical_regular_file(&temporary)?;
            }
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temporary)
                .map_err(|e| {
                    MaterialError::io("library-create-failed", "写入库身份临时文件失败", e)
                })?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| MaterialError::io("library-create-failed", "保存库身份失败", e))?;
            drop(file);
            // No replacement of an existing identity, including an unrelated clone.
            if manifest.exists() {
                return Err(MaterialError::new(
                    "library-create-conflict",
                    "目录已出现库身份，请重新核对",
                ));
            }
            std::fs::rename(&temporary, &manifest)
                .map_err(|e| MaterialError::io("library-create-failed", "提交库身份文件失败", e))?;
            Self::verify_library_identity(&root, id)?;
        }
        self.register_managed_root(&root)?;
        conn.execute(
            "UPDATE material_library SET state='ready' WHERE id=?1",
            [id],
        )
        .map_err(|e| MaterialError::database("完成库创建失败", e))?;
        conn.execute(
            "DELETE FROM material_library_creation WHERE library_id=?1",
            [id],
        )
        .map_err(|e| MaterialError::database("完成创建恢复任务失败", e))?;
        conn.execute_batch("COMMIT")
            .map_err(|e| MaterialError::database("提交库创建失败", e))?;
        Ok(())
    }
    fn verify_library_identity(root: &Path, id: &str) -> MaterialResult<PathBuf> {
        let root = canonical_trusted_root(root)?;
        let path = canonical_regular_file(&root.join("library.json"))?;
        let metadata = std::fs::metadata(&path)
            .map_err(|e| MaterialError::io("library-offline", "读取素材库身份失败", e))?;
        if metadata.len() > 4096 {
            return Err(MaterialError::new(
                "library-identity-conflict",
                "库身份文件无效",
            ));
        }
        let bytes = std::fs::read(&path)
            .map_err(|e| MaterialError::io("library-offline", "读取素材库身份失败", e))?;
        let identity: LibraryIdentity = serde_json::from_slice(&bytes).map_err(|_| {
            MaterialError::new(
                "library-identity-conflict",
                "此目录不是可重开的本机素材库；外来库需要完整库包",
            )
        })?;
        if identity.format != 1 || identity.library_id != id {
            return Err(MaterialError::new(
                "library-identity-conflict",
                "素材库身份不匹配",
            ));
        }
        Ok(root)
    }
    pub(crate) fn select_library(&self, id: &str) -> MaterialResult<()> {
        self.for_library(id)?;
        self.open_write()?
            .execute(
                "UPDATE material_library_state SET active_id=?1 WHERE singleton=1",
                [id],
            )
            .map_err(|e| MaterialError::database("保存当前素材库失败", e))?;
        Ok(())
    }
    pub(crate) fn rename_library(&self, id: &str, name: &str) -> MaterialResult<()> {
        let name = validate_library_name(name)?;
        let changed = self
            .open_write()?
            .execute(
                "UPDATE material_library SET name=?1,updated_at=?2 WHERE id=?3",
                rusqlite::params![name, chrono::Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| MaterialError::database("重命名素材库失败", e))?;
        if changed == 0 {
            return Err(MaterialError::new("library-not-found", "找不到素材库"));
        }
        Ok(())
    }
    pub(crate) fn set_library_visible(&self, id: &str, visible: bool) -> MaterialResult<()> {
        let conn = self.open_write()?;
        let (legacy, active) = self.library_state()?;
        if !visible && id == legacy {
            return Err(MaterialError::new(
                "library-legacy-required",
                "默认库仍供兼容客户端使用，不能从列表移除",
            ));
        }
        if !visible && id == active {
            return Err(MaterialError::new(
                "library-active-required",
                "请先切换到另一个库，再移除此库",
            ));
        }
        let changed = conn
            .execute(
                "UPDATE material_library SET visible=?1 WHERE id=?2",
                rusqlite::params![visible, id],
            )
            .map_err(|e| MaterialError::database("更新素材库列表失败", e))?;
        if changed == 0 {
            return Err(MaterialError::new(
                "library-not-found",
                "此库不在本机 Catalog 中，跨电脑恢复需要完整库包",
            ));
        }
        Ok(())
    }
    pub(crate) fn reopen_library(&self, root: &Path) -> MaterialResult<MaterialLibrary> {
        let root = canonical_trusted_root(root)?;
        let path = canonical_regular_file(&root.join("library.json"))?;
        let bytes = std::fs::read(&path)
            .map_err(|e| MaterialError::io("library-offline", "读取库身份失败", e))?;
        if bytes.len() > 4096 {
            return Err(MaterialError::new(
                "library-identity-conflict",
                "库身份文件无效",
            ));
        }
        let identity: LibraryIdentity = serde_json::from_slice(&bytes)
            .map_err(|_| MaterialError::new("library-identity-conflict", "库身份文件无效"))?;
        let lib = self.library_in(&self.open_read()?, &identity.library_id)?;
        if lib.root_path.as_deref() != Some(root.to_string_lossy().as_ref()) {
            return Err(MaterialError::new(
                "library-identity-conflict",
                "相同库身份出现在不同目录，请明确使用重新定位",
            ));
        }
        Self::verify_library_identity(&root, &lib.id)?;
        self.set_library_visible(&lib.id, true)?;
        self.library_in(&self.open_read()?, &lib.id)
    }
    pub(crate) fn save_library_preferences(
        &self,
        id: &str,
        prefs: serde_json::Value,
    ) -> MaterialResult<()> {
        if !prefs.is_object() {
            return Err(MaterialError::new(
                "library-preferences-invalid",
                "显示偏好无效",
            ));
        }
        let text = prefs.to_string();
        if text.len() > 32768 {
            return Err(MaterialError::new(
                "library-preferences-invalid",
                "显示偏好过大",
            ));
        }
        let changed = self
            .open_write()?
            .execute(
                "UPDATE material_library SET preferences_json=?1 WHERE id=?2",
                rusqlite::params![text, id],
            )
            .map_err(|e| MaterialError::database("保存库显示偏好失败", e))?;
        if changed != 1 {
            return Err(MaterialError::new(
                "library-not-found",
                "此素材库未在本机登记",
            ));
        }
        Ok(())
    }
    /// Explicit location repair only. No copying, moving, or deleting originals.
    pub(crate) fn relocate_library(
        &self,
        id: &str,
        target: &Path,
    ) -> MaterialResult<MaterialLibrary> {
        let target = Self::verify_library_identity(target, id)?;
        let conn = self.open_write()?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| MaterialError::database("开始重新定位失败", e))?;
        let old = self.library_in(&conn, id)?;
        let old_root = old.root_path.ok_or_else(|| {
            MaterialError::new(
                "library-location-unregistered",
                "默认库沿用既有多个存储根，请通过原素材重新定位工具修复；不能把库改为一个空目录",
            )
        })?;
        if Path::new(&old_root) == target {
            return self.library_in(&conn, id);
        }
        if Self::verify_library_identity(Path::new(&old_root), id).is_ok() {
            return Err(MaterialError::new(
                "library-identity-conflict",
                "原库位置仍可用，同身份的另一个目录属于冲突；请明确处理复制目录后再重新定位",
            ));
        }
        let mut statement=conn.prepare("SELECT a.id,a.library_path,a.thumbnail_url,a.size_bytes FROM asset a JOIN material_library_asset m ON m.asset_id=a.id WHERE m.library_id=?1 AND a.storage_mode='managed'").map_err(|e|MaterialError::database("读取库文件位置失败",e))?;
        let rows = statement
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<u64>>(3)?,
                ))
            })
            .map_err(|e| MaterialError::database("读取库文件位置失败", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("读取库文件位置失败", e))?;
        drop(statement);
        for (asset, path, thumbnail, size) in rows {
            let relative = Path::new(&path).strip_prefix(&old_root).map_err(|_| {
                MaterialError::new(
                    "library-location-conflict",
                    "库中存在非此根管理的文件，不能自动重新定位",
                )
            })?;
            let next = canonical_regular_file(&target.join(relative))?;
            if !next.starts_with(&target) {
                return Err(MaterialError::new(
                    "library-location-conflict",
                    "文件不在目标库目录中",
                ));
            }
            if size.is_some_and(|s| {
                std::fs::metadata(&next)
                    .map(|m| m.len() != s)
                    .unwrap_or(true)
            }) {
                return Err(MaterialError::new(
                    "library-file-mismatch",
                    "目标库文件大小不匹配",
                ));
            }
            let thumb = thumbnail.map(|t| {
                Path::new(&t)
                    .strip_prefix(&old_root)
                    .map(|r| target.join(r).to_string_lossy().into_owned())
                    .unwrap_or(t)
            });
            conn.execute(
                "UPDATE asset SET library_path=?1,thumbnail_url=?2 WHERE id=?3",
                rusqlite::params![next.to_string_lossy(), thumb, asset],
            )
            .map_err(|e| MaterialError::database("重新定位素材失败", e))?;
        }
        self.register_managed_root(&target)?;
        if target.join("assets").is_dir() {
            self.register_managed_root(&target.join("assets"))?;
        }
        conn.execute(
            "UPDATE material_library SET root_path=?1,state='ready',updated_at=?2 WHERE id=?3",
            rusqlite::params![
                target.to_string_lossy(),
                chrono::Utc::now().to_rfc3339(),
                id
            ],
        )
        .map_err(|e| MaterialError::database("更新库位置失败", e))?;
        conn.execute_batch("COMMIT")
            .map_err(|e| MaterialError::database("提交库位置失败", e))?;
        self.library_in(&conn, id)
    }
}
fn validate_library_name(name: &str) -> MaterialResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err(MaterialError::new(
            "library-name-invalid",
            "请输入 1 到 120 字的素材库名称",
        ));
    }
    Ok(name.into())
}

#[cfg(test)]
mod tests {
    use super::super::export;
    use super::*;
    fn second(catalog: &MaterialCatalog) -> MaterialLibrary {
        let root = catalog.app_data_dir.join("second");
        std::fs::create_dir(&root).unwrap();
        catalog.create_library("第二库", &root, "managed").unwrap()
    }
    fn import(catalog: &MaterialCatalog) -> MaterialAsset {
        catalog
            .import_bytes(
                vec![MaterialBytesInput {
                    name: "same.txt".into(),
                    original_path: "https://example.test/source".into(),
                    mime_type: "text/plain".into(),
                    bytes: b"identical content".to_vec(),
                    description: None,
                }],
                &MaterialImportOptions::default(),
            )
            .unwrap()
            .value
            .assets
            .remove(0)
    }
    #[test]
    fn library_r1_same_hash_independent_identity_and_legacy_ignores_ui_selection() {
        let c = MaterialCatalog::new_for_test();
        let a = import(&c);
        let library = second(&c);
        let b = c.for_library(&library.id).unwrap();
        let asset = import(&b);
        assert_ne!(a.id, asset.id);
        assert_eq!(a.content_hash, asset.content_hash);
        assert_ne!(a.library_path, asset.library_path);
        c.select_library(&library.id).unwrap();
        assert_eq!(
            c.list_assets(&MaterialFilter::default())
                .unwrap()
                .iter()
                .map(|a| a.id.clone())
                .collect::<Vec<_>>(),
            vec![a.id.clone()]
        );
        assert_eq!(
            b.list_assets(&MaterialFilter::default())
                .unwrap()
                .iter()
                .map(|a| a.id.clone())
                .collect::<Vec<_>>(),
            vec![asset.id.clone()]
        );
        assert_eq!(
            c.get_assets(&[asset.id.clone()]).unwrap_err().code,
            "material-library-scope"
        );
        assert_eq!(
            c.companion_resource(&asset.id, false).unwrap_err().code,
            "material-library-scope"
        );
        assert!(c.get_source_page(&asset.id).is_err());
        assert!(c.get_asset_tags(&asset.id).is_err());
        assert!(c
            .assert_legacy_file_path(Path::new(asset.library_path.as_ref().unwrap()))
            .is_err());
        c.assert_legacy_file_path(Path::new(a.library_path.as_ref().unwrap()))
            .unwrap();
        assert!(b.get_assets(&[a.id.clone()]).is_err());
        assert!(c
            .update_asset(&asset.id, MaterialAssetPatch::default(), "test")
            .is_err());
        let duplicate = b
            .import_bytes(
                vec![MaterialBytesInput {
                    name: "same.txt".into(),
                    original_path: "https://example.test/source".into(),
                    mime_type: "text/plain".into(),
                    bytes: b"identical content".to_vec(),
                    description: None,
                }],
                &MaterialImportOptions::default(),
            )
            .unwrap()
            .value;
        assert_eq!(duplicate.skipped_duplicate_count, 1);
        assert_eq!(b.list_assets(&MaterialFilter::default()).unwrap().len(), 1);
        b.delete_asset(&asset.id, true).unwrap();
        assert!(Path::new(a.library_path.as_ref().unwrap()).is_file());
    }
    #[test]
    fn library_r1_schema_drift_fails_before_writes_and_vault_projection_is_explicit() {
        let c = MaterialCatalog::new_for_test();
        let lib = second(&c);
        let b = c.for_library(&lib.id).unwrap();
        let foreign = import(&b);
        let path = c.app_data_dir.join("private.txt");
        std::fs::write(&path, b"private attachment").unwrap();
        let private = c.register_note_attachment(&path, "vault-a", None).unwrap();
        assert!(c.get_assets(&[private.id.clone()]).is_err());
        assert!(b.get_assets(&[private.id.clone()]).is_err());
        assert!(c
            .for_vault_attachment_ids("vault-b", &[private.id.clone()])
            .is_err());
        assert!(c
            .for_vault_attachment_ids("vault-a", &[foreign.id.clone()])
            .is_err());
        let authorized = c
            .for_vault_attachment_ids("vault-a", &[private.id.clone()])
            .unwrap();
        authorized
            .update_asset(
                &private.id,
                MaterialAssetPatch {
                    name: Some("renamed private".into()),
                    ..Default::default()
                },
                "vault-test",
            )
            .unwrap();
        assert_eq!(
            authorized.get_assets(&[private.id.clone()]).unwrap()[0].name,
            "renamed private"
        );
        let delete = |vault: &str| serde_json::from_value::<super::super::library_commands::LibraryRequest>(serde_json::json!({
            "libraryId": null, "vaultId": vault, "action": {"op":"delete","id":private.id,"deleteFile":false}
        })).unwrap();
        assert!(super::super::library_commands::execute_library_request(c.clone(), delete("vault-b")).is_err());
        assert!(super::super::library_commands::execute_library_request(c.clone(), delete("vault-a")).is_ok());
        assert!(path.is_file());
        let conn = c.open_write().unwrap();
        verify_library_schema(&conn).unwrap();
        conn.execute_batch("DROP TRIGGER material_library_asset_default")
            .unwrap();
        assert_eq!(
            verify_library_schema(&conn).unwrap_err().code,
            "library-schema-drift"
        );
    }
    #[test]
    fn library_r1_task_scope_survives_offline_and_never_follows_active_library() {
        let c = MaterialCatalog::new_for_test();
        let a = import(&c);
        let lib = second(&c);
        let b = c.for_library(&lib.id).unwrap();
        let asset = import(&b);
        let manager = export::ExportManager::default();
        let plan = manager
            .plan(
                &b,
                export::ExportPlanRequest::Assets {
                    asset_ids: vec![asset.id.clone()],
                },
            )
            .unwrap();
        let output = tempfile::tempdir().unwrap();
        assert!(manager
            .start(
                c.clone(),
                &plan.plan_id,
                output.path().to_str().unwrap(),
                false,
                &[]
            )
            .is_err());
        let task = manager
            .start(
                b.clone(),
                &plan.plan_id,
                output.path().to_str().unwrap(),
                false,
                &[],
            )
            .unwrap();
        assert!(manager.assert_task_scope(&c, &task.task_id).is_err());
        assert!(manager.list_scoped(&c).unwrap().is_empty());
        // Windows keeps the source directory busy while a worker holds its file.
        // Settle that worker before simulating an offline volume by renaming it.
        manager.cancel(&task.task_id).unwrap();
        let mut settled = false;
        for _ in 0..500 {
            if !matches!(manager.status(&task.task_id).unwrap().phase.as_str(), "preparing" | "running" | "cancelling") {
                settled = true; break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(settled, "frozen task did not settle");
        std::fs::rename(
            lib.root_path.as_ref().unwrap(),
            c.app_data_dir.join("offline"),
        )
        .unwrap();
        let control = c.for_library_task(&lib.id).unwrap();
        manager.assert_task_scope(&control, &task.task_id).unwrap();
        assert_eq!(manager.list_scoped(&control).unwrap().len(), 1);
        manager.cancel(&task.task_id).unwrap();
        assert!(c.get_assets(&[a.id]).is_ok());
    }
    #[test]
    fn library_r1_folders_tags_and_wrong_folder_id_are_isolated() {
        let c = MaterialCatalog::new_for_test();
        let library = second(&c);
        let b = c.for_library(&library.id).unwrap();
        let fa = c
            .create_folder(MaterialFolderInput {
                name: "same".into(),
                parent_id: None,
            })
            .unwrap()
            .value;
        let fb = b
            .create_folder(MaterialFolderInput {
                name: "same".into(),
                parent_id: None,
            })
            .unwrap()
            .value;
        assert_ne!(fa.id, fb.id);
        let ta = c.create_tag("same", None).unwrap().value;
        let tb = b.create_tag("same", None).unwrap().value;
        assert_ne!(ta.id, tb.id);
        let aa = import(&c);
        let ab = import(&b);
        assert!(c.move_asset(&aa.id, Some(&fb.id)).is_err());
        assert!(c.move_asset(&ab.id, Some(&fa.id)).is_err());
        assert!(b
            .create_folder(MaterialFolderInput {
                name: "bad".into(),
                parent_id: Some(fa.id)
            })
            .is_err());
        c.set_asset_tags(&aa.id, vec![ta.id.clone()]).unwrap();
        b.set_asset_tags(&ab.id, vec![tb.id.clone()]).unwrap();
        b.update_tag(
            &tb.id,
            MaterialTagPatch {
                name: Some("renamed".into()),
                color: PatchValue::Missing,
            },
        )
        .unwrap();
        assert_eq!(c.list_tags().unwrap()[0].name, "same");
        assert_eq!(b.list_tags().unwrap()[0].name, "renamed");
        assert_eq!(c.list_folders().unwrap().len(), 1);
        assert_eq!(b.list_folders().unwrap().len(), 1);
        assert!(c.delete_tag(&tb.id).is_err());
    }
    #[test]
    fn library_r1_list_management_restart_offline_and_clone_conflict() {
        let c = MaterialCatalog::new_for_test();
        let lib = second(&c);
        let a = import(&c);
        let _ = a;
        c.rename_library(&lib.id, "new name").unwrap();
        c.select_library(&lib.id).unwrap();
        let restarted = MaterialCatalog::new(c.db_path.clone(), c.app_data_dir.clone());
        assert_eq!(restarted.library_state().unwrap().1, lib.id);
        assert!(c.set_library_visible(&lib.id, false).is_err());
        let legacy = c.library_state().unwrap().0;
        c.select_library(&legacy).unwrap();
        assert!(c.set_library_visible(&legacy, false).is_err());
        c.set_library_visible(&lib.id, false).unwrap();
        assert_eq!(c.list_libraries(false).unwrap().len(), 1);
        c.reopen_library(Path::new(lib.root_path.as_ref().unwrap()))
            .unwrap();
        assert_eq!(c.list_libraries(false).unwrap().len(), 2);
        let clone = c.app_data_dir.join("clone");
        std::fs::create_dir(&clone).unwrap();
        std::fs::copy(
            Path::new(lib.root_path.as_ref().unwrap()).join("library.json"),
            clone.join("library.json"),
        )
        .unwrap();
        assert_eq!(
            c.reopen_library(&clone).unwrap_err().code,
            "library-identity-conflict"
        );
        std::fs::rename(lib.root_path.as_ref().unwrap(), c.app_data_dir.join("gone")).unwrap();
        assert_eq!(
            c.list_libraries(false)
                .unwrap()
                .iter()
                .find(|l| l.id == lib.id)
                .unwrap()
                .state,
            "offline"
        );
        assert!(c.for_library(&lib.id).is_err());
        assert_eq!(
            c.for_library_task(&lib.id)
                .unwrap()
                .library_scope_key()
                .unwrap(),
            lib.id
        );
    }
    #[test]
    fn library_r1_versions_search_favorites_and_smart_rules_are_independent() {
        let c = MaterialCatalog::new_for_test();
        let aa = import(&c);
        let lib = second(&c);
        let b = c.for_library(&lib.id).unwrap();
        let version = c.read_library_change().unwrap().version;
        let ab = import(&b);
        assert_eq!(c.read_library_change().unwrap().version, version);
        let folder = b
            .create_folder(MaterialFolderInput {
                name: "B".into(),
                parent_id: None,
            })
            .unwrap()
            .value;
        assert_eq!(c.read_library_change().unwrap().version, version);
        b.move_asset(&ab.id, Some(&folder.id)).unwrap();
        let mut cb = b.open_write().unwrap();
        let mut ca = c.open_write().unwrap();
        crate::favorites::add(
            &mut cb,
            crate::favorites::FavoriteItemType::Material,
            &ab.id,
        )
        .unwrap();
        assert!(crate::favorites::add(
            &mut ca,
            crate::favorites::FavoriteItemType::Material,
            &ab.id
        )
        .is_err());
        assert_eq!(crate::favorites::counts(&ca).unwrap().material, 0);
        assert_eq!(crate::favorites::counts(&cb).unwrap().material, 1);
        assert!(crate::favorites::remove(
            &mut ca,
            crate::favorites::FavoriteItemType::Material,
            &ab.id
        )
        .is_err());
        let input = || {
            serde_json::from_value(serde_json::json!({"name":"same","criteria":{"source":"material","query":"same"},"sort":"added-desc"})).unwrap()
        };
        let sa = crate::smart_folders::create(&mut ca, input()).unwrap();
        let sb = crate::smart_folders::create(&mut cb, input()).unwrap();
        assert_ne!(sa.id, sb.id);
        assert_eq!(crate::smart_folders::list(&ca).unwrap().len(), 1);
        assert_eq!(crate::smart_folders::list(&cb).unwrap().len(), 1);
        assert!(crate::smart_folders::update(&mut ca, &sb.id, input()).is_err());
        assert!(crate::smart_folders::delete(&mut ca, &sb.id).is_err());
        let results = b
            .list_assets(&MaterialFilter {
                query: Some("same".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, ab.id);
        assert_ne!(results[0].id, aa.id);
        assert_eq!(
            cb.query_row(
                "SELECT COUNT(*) FROM material_library_write_intent",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn library_r1_creation_restart_recovers_each_owned_file_checkpoint() {
        for checkpoint in 0..3 {
            let c = MaterialCatalog::new_for_test();
            let root = c.app_data_dir.join("pending");
            std::fs::create_dir(&root).unwrap();
            let id = "library-pending";
            let conn = c.open_write().unwrap();
            conn.execute("INSERT INTO material_library(id,name,root_path,state,created_at,updated_at) VALUES(?1,'pending',?2,'creating','now','now')",rusqlite::params![id,root.to_string_lossy()]).unwrap();
            conn.execute(
                "INSERT INTO material_library_creation VALUES(?1,?2)",
                rusqlite::params![id, root.to_string_lossy()],
            )
            .unwrap();
            if checkpoint == 1 {
                std::fs::write(root.join(format!(".luckyray-{}.pending", id)), b"partial").unwrap();
            }
            if checkpoint == 2 {
                std::fs::write(
                    root.join("library.json"),
                    serde_json::to_vec(&LibraryIdentity {
                        format: 1,
                        library_id: id.into(),
                    })
                    .unwrap(),
                )
                .unwrap();
            }
            let restart = MaterialCatalog::new(c.db_path.clone(), c.app_data_dir.clone());
            restart.recover_library_creations().unwrap();
            restart.recover_library_creations().unwrap();
            assert_eq!(restart.library_in(&conn, id).unwrap().state, "ready");
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM material_library_creation", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
                0
            );
            assert_eq!(restart.list_libraries(true).unwrap().len(), 2);
        }
    }
    #[test]
    fn library_r1_creation_conflict_never_overwrites_foreign_identity() {
        let c = MaterialCatalog::new_for_test();
        let root = c.app_data_dir.join("conflict");
        std::fs::create_dir(&root).unwrap();
        let conn = c.open_write().unwrap();
        conn.execute("INSERT INTO material_library(id,name,root_path,state,created_at,updated_at) VALUES('library-pending','pending',?1,'creating','now','now')",[root.to_string_lossy().as_ref()]).unwrap();
        conn.execute(
            "INSERT INTO material_library_creation VALUES('library-pending',?1)",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
        let foreign = b"{\"format\":1,\"libraryId\":\"foreign\"}";
        std::fs::write(root.join("library.json"), foreign).unwrap();
        c.recover_library_creations().unwrap();
        assert_eq!(std::fs::read(root.join("library.json")).unwrap(), foreign);
        assert_eq!(
            c.library_in(&conn, "library-pending").unwrap().state,
            "creating"
        );
        assert!(c.for_library("library-pending").is_err());
    }
    #[test]
    fn library_r1_relocation_keeps_ids_tags_organization_and_originals() {
        let c = MaterialCatalog::new_for_test();
        let aa = import(&c);
        let lib = second(&c);
        let b = c.for_library(&lib.id).unwrap();
        let ab = import(&b);
        let tag = b.create_tag("tag", None).unwrap().value;
        b.set_asset_tags(&ab.id, vec![tag.id.clone()]).unwrap();
        c.save_library_preferences(&lib.id, serde_json::json!({"view":"grid"}))
            .unwrap();
        c.select_library(&lib.id).unwrap();
        let target = c.app_data_dir.join("moved");
        std::fs::rename(lib.root_path.as_ref().unwrap(), &target).unwrap();
        c.relocate_library(&lib.id, &target).unwrap();
        let recovered = c.for_library(&lib.id).unwrap();
        let row = recovered.get_assets(&[ab.id.clone()]).unwrap().remove(0);
        assert_eq!(row.id, ab.id);
        assert!(Path::new(row.library_path.as_ref().unwrap())
            .starts_with(target.canonicalize().unwrap()));
        assert_eq!(row.original_path, ab.original_path);
        assert_eq!(recovered.get_asset_tags(&ab.id).unwrap(), vec![tag.id]);
        assert_eq!(c.library_state().unwrap().1, lib.id);
        assert_eq!(
            c.library_in(&c.open_read().unwrap(), &lib.id)
                .unwrap()
                .preferences["view"],
            "grid"
        );
        let (_, mut file) = recovered.companion_resource(&ab.id, false).unwrap();
        let mut bytes = Vec::new();
        use std::io::Read;
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"identical content");
        assert!(Path::new(aa.library_path.as_ref().unwrap()).is_file());
    }
}
