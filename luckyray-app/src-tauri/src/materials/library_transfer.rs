//! Finite, durable R2 jobs. The existing main-window library command owns all authority.
use super::catalog::{canonical_trusted_root, unique_id};
use super::library_archive::*;
use super::library_package::*;
use super::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub(crate) const TRANSFER_SCHEMA: &str = include_str!("library_transfer_schema.sql");
const TRANSFER_SCHEMA_V25: &str = include_str!("library_transfer_schema_v25.sql");
#[cfg(test)]
pub(crate) fn apply_transfer_schema(conn: &Connection) -> MaterialResult<()> {
    conn.execute_batch(TRANSFER_SCHEMA).map_err(db)?;
    verify_transfer_schema(conn)
}
pub(crate) fn apply_transfer_schema_v25(conn: &Connection) -> MaterialResult<()> {
    conn.execute_batch(TRANSFER_SCHEMA_V25).map_err(db)?;
    verify_transfer_schema_against(conn, TRANSFER_SCHEMA_V25)
}
/// Called only by bootstrap's v26 migration, inside its BEGIN IMMEDIATE.
/// Verify the precise old shape before rebuilding; never "repair" unknown drift.
pub(crate) fn migrate_transfer_schema_v26(conn: &Connection) -> MaterialResult<()> {
    if conn.is_autocommit() {
        return Err(fail("素材库任务升级必须在 bootstrap 事务中执行"));
    }
    verify_transfer_schema_against(conn, TRANSFER_SCHEMA_V25)?;
    let supplemental = conn.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='material_library_transfer' AND type IN('index','trigger') AND sql IS NOT NULL AND name<>'material_library_transfer_anchor' ORDER BY type,name").map_err(db)?
        .query_map([], |r| r.get::<_, String>(0)).map_err(db)?
        .collect::<Result<Vec<_>, _>>().map_err(db)?;
    conn.execute_batch(
        "CREATE TABLE material_library_transfer_r3 AS SELECT * FROM material_library_transfer;
         DROP TABLE material_library_transfer;",
    ).map_err(db)?;
    conn.execute_batch(TRANSFER_SCHEMA).map_err(db)?;
    conn.execute_batch("INSERT INTO material_library_transfer(id,anchor_library_id,kind,phase,payload_json,result_json,created_at,updated_at)
        SELECT id,anchor_library_id,kind,phase,payload_json,result_json,created_at,updated_at FROM material_library_transfer_r3;
        DROP TABLE material_library_transfer_r3;").map_err(db)?;
    for sql in supplemental { conn.execute_batch(&sql).map_err(db)?; }
    verify_transfer_schema(conn)
}
pub(crate) fn verify_transfer_schema(conn: &Connection) -> MaterialResult<()> {
    verify_transfer_schema_against(conn, TRANSFER_SCHEMA)
}
// SQL keywords/identifier quotes are presentation; CHECK string literals are data.
// Preserve literal case, whitespace and escaping so semantic drift stays visible.
fn normalized_transfer_sql(sql: &str) -> String {
    let mut chars = sql.chars().peekable();
    let mut result = String::new();
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            result.push(ch);
            while let Some(next) = chars.next() {
                result.push(next);
                if next == '\'' {
                    if chars.peek() == Some(&'\'') { result.push(chars.next().unwrap()); }
                    else { break; }
                }
            }
        } else if matches!(ch, '"' | '`' | '[') {
            let end = if ch == '[' { ']' } else { ch };
            let mut identifier = String::new();
            while let Some(next) = chars.next() {
                if next == end { break; }
                identifier.push(next);
            }
            if identifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                result.push_str(&identifier.to_ascii_lowercase());
            } else {
                result.push(ch); result.push_str(&identifier); result.push(end);
            }
        } else if !ch.is_ascii_whitespace() { result.push(ch.to_ascii_lowercase()); }
    }
    for prefix in ["createtable", "createindex"] {
        if let Some(rest) = result.strip_prefix(&format!("{prefix}ifnotexists")) {
            return format!("{prefix}{rest}");
        }
    }
    result
}
fn verify_transfer_schema_against(conn: &Connection, schema: &str) -> MaterialResult<()> {
    let expected = Connection::open_in_memory().map_err(db)?;
    expected
        .execute_batch("CREATE TABLE material_library(id TEXT PRIMARY KEY)")
        .map_err(db)?;
    expected.execute_batch(schema).map_err(db)?;
    for name in [
        "material_library_transfer",
        "material_library_transfer_anchor",
    ] {
        let actual: Option<String> = conn
            .query_row("SELECT sql FROM sqlite_schema WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db)?;
        let sql: String = expected
            .query_row("SELECT sql FROM sqlite_schema WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .map_err(db)?;
        if actual.is_none_or(|actual| normalized_transfer_sql(&actual) != normalized_transfer_sql(&sql)) {
            return Err(MaterialError::new(
                "library-transfer-schema-drift",
                "素材库任务表缺失或定义漂移",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferItem {
    pub asset_id: String,
    pub name: String,
    pub state: String,
    pub target_asset_id: Option<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferStatus {
    pub task_id: String,
    pub kind: String,
    pub phase: String,
    pub source_library_id: String,
    pub target_library_id: Option<String>,
    pub source_name: String,
    pub target_name: Option<String>,
    pub current_file: Option<String>,
    pub current_bytes: u64,
    pub current_total_bytes: u64,
    pub completed: usize,
    pub total: usize,
    pub copied: usize,
    pub skipped: usize,
    pub failed: usize,
    pub items: Vec<TransferItem>,
    pub error: Option<String>,
    pub output_path: Option<String>,
    pub retryable: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TransferJob {
    pub id: String,
    pub kind: String,
    pub anchor: String,
    pub request_key: String,
    pub target_library_id: Option<String>,
    pub root: PathBuf,
    pub protected_roots: Vec<PathBuf>,
    pub output: Option<PathBuf>,
    pub artifact_sha256: Option<String>,
    pub package_path: Option<PathBuf>,
    pub package: LibraryPackage,
    pub locals: Vec<MaterialAsset>,
    pub media: Vec<SourceMedia>,
    pub mapping: HashMap<String, String>,
}
impl TransferJob {
    pub(super) fn mapped(&self, kind: &str, id: &str) -> MaterialResult<String> {
        self.mapping
            .get(&format!("{kind}:{id}"))
            .cloned()
            .ok_or_else(|| fail("身份映射缺失"))
    }
    pub(super) fn stage_root(&self, base: &MaterialCatalog) -> MaterialResult<PathBuf> {
        let app = canonical_trusted_root(base.app_data_dir())?;
        let parent = app.join("material-library-staging");
        std::fs::create_dir_all(&parent)
            .map_err(|e| MaterialError::io("library-transfer-io", "建立任务暂存目录失败", e))?;
        canonical_trusted_root(&parent)?;
        let path = parent.join(&self.id);
        std::fs::create_dir_all(&path)
            .map_err(|e| MaterialError::io("library-transfer-io", "建立任务暂存目录失败", e))?;
        let root = canonical_trusted_root(&path)?;
        if !root.starts_with(&app) {
            return Err(fail("任务暂存路径越界"));
        }
        Ok(root)
    }
}
pub(super) struct TransferControl {
    pub status: Mutex<TransferStatus>,
    cancel: AtomicBool,
    #[cfg(test)]
    pub pause_ms: u64,
    #[cfg(test)]
    pub disk_full: bool,
}
impl TransferControl {
    pub(super) fn progress(&self, name: &str, bytes: u64, total: u64) -> MaterialResult<()> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(MaterialError::new(
                "library-transfer-cancelled",
                "任务已取消",
            ));
        }
        let mut s = self.status.lock().unwrap();
        #[cfg(test)]
        if self.disk_full && bytes > 0 && s.phase == "staging" {
            return Err(MaterialError::io(
                "library-transfer-io",
                "注入暂存写入磁盘空间不足",
                std::io::Error::from_raw_os_error(112),
            ));
        }
        s.current_file = Some(name.into());
        s.current_bytes = bytes;
        s.current_total_bytes = total;
        drop(s);
        #[cfg(test)]
        if self.pause_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(self.pause_ms));
        }
        Ok(())
    }
    pub(super) fn begin_commit(&self) -> MaterialResult<()> {
        let mut s = self.status.lock().unwrap();
        if self.cancel.load(Ordering::Acquire) {
            return Err(MaterialError::new(
                "library-transfer-cancelled",
                "任务已取消",
            ));
        }
        s.phase = "committing".into();
        s.retryable = false;
        Ok(())
    }
}
#[derive(Default)]
pub(crate) struct LibraryTransferManager {
    tasks: Mutex<HashMap<String, Arc<TransferControl>>>,
    #[cfg(test)]
    test_pause_ms: Mutex<u64>,
    #[cfg(test)]
    test_disk_full: AtomicBool,
}
static MANAGER: OnceLock<LibraryTransferManager> = OnceLock::new();
pub(crate) fn library_transfer_manager() -> &'static LibraryTransferManager {
    MANAGER.get_or_init(LibraryTransferManager::default)
}
#[cfg(test)]
impl LibraryTransferManager {
    pub(super) fn set_test_pause(&self, ms: u64) {
        *self.test_pause_ms.lock().unwrap() = ms;
    }
}
fn valid_job_id(id: &str) -> bool {
    id.len() >= 16 && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
impl MaterialCatalog {
    pub(super) fn transfer_watch_roots(&self) -> MaterialResult<Vec<PathBuf>> {
        let conn = self.open_read()?;
        let mut statement = conn
            .prepare("SELECT preferences_json FROM material_library")
            .map_err(db)?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db)?;
        let mut paths = Vec::new();
        for row in rows {
            let value: serde_json::Value =
                serde_json::from_str(&row.map_err(db)?).map_err(|_| fail("库监控偏好无效"))?;
            let Some(raw) = value
                .get("luckyray-material-watch-sources-v1")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let sources: serde_json::Value =
                serde_json::from_str(raw).map_err(|_| fail("库监控偏好无效"))?;
            let array = sources
                .as_array()
                .ok_or_else(|| fail("库监控目录配置无效"))?;
            for source in array {
                if source.get("enabled").and_then(serde_json::Value::as_bool) != Some(true) {
                    continue;
                }
                let path = source
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| fail("库监控位置无效"))?;
                if path.len() > 32_768 || !Path::new(path).is_absolute() {
                    return Err(fail("库监控位置无效"));
                }
                let path = PathBuf::from(path);
                if !paths.contains(&path) {
                    paths.push(path);
                }
                if paths.len() > 1024 {
                    return Err(fail("库监控目录数量超出保护预算"));
                }
            }
        }
        Ok(paths)
    }
}
pub(super) fn persist_job(
    base: &MaterialCatalog,
    job: &TransferJob,
    status: &TransferStatus,
    conn: Option<&Connection>,
) -> MaterialResult<()> {
    let own;
    let conn = if let Some(c) = conn {
        c
    } else {
        own = base.open_write()?;
        &own
    };
    let phase = match status.phase.as_str() {
        "completed" => "completed",
        "cancelled" => "cancelled",
        "failed" | "partial" => "failed",
        _ => "running",
    };
    conn.execute("UPDATE material_library_transfer SET phase=?2,payload_json=?3,result_json=?4,updated_at=?5 WHERE id=?1",rusqlite::params![job.id,phase,serde_json::to_string(job).map_err(|e|fail(e.to_string()))?,serde_json::to_string(status).map_err(|e|fail(e.to_string()))?,chrono::Utc::now().to_rfc3339()]).map_err(db)?;
    Ok(())
}
fn load_job(
    base: &MaterialCatalog,
    anchor: &str,
    id: &str,
) -> MaterialResult<(TransferJob, TransferStatus)> {
    if !valid_job_id(id) {
        return Err(fail("任务身份无效"));
    }
    let c = base.open_read()?;
    let (payload,result):(String,String)=c.query_row("SELECT payload_json,result_json FROM material_library_transfer WHERE id=?1 AND anchor_library_id=?2",rusqlite::params![id,anchor],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|fail("任务不属于此素材库"))?;
    Ok((
        serde_json::from_str(&payload).map_err(|e| fail(e.to_string()))?,
        serde_json::from_str(&result).map_err(|e| fail(e.to_string()))?,
    ))
}
fn initial_status(base: &MaterialCatalog, job: &TransferJob) -> MaterialResult<TransferStatus> {
    let target_name = if job.kind == "copy" {
        Some(
            base.open_read()?
                .query_row(
                    "SELECT name FROM material_library WHERE id=?1",
                    [job.target_library_id.as_deref().unwrap()],
                    |r| r.get::<_, String>(0),
                )
                .map_err(db)?,
        )
    } else if job.kind == "restore" {
        Some(job.package.name.clone())
    } else if job.kind == "move" {
        Some(job.root.to_string_lossy().to_string())
    } else {
        None
    };
    let source_name = if job.kind == "restore" {
        job.package_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "完整库包".into())
    } else {
        job.package.name.clone()
    };
    Ok(TransferStatus {
        task_id: job.id.clone(),
        kind: job.kind.clone(),
        phase: "prepared".into(),
        source_library_id: job.anchor.clone(),
        target_library_id: job.target_library_id.clone(),
        source_name,
        target_name,
        current_file: None,
        current_bytes: 0,
        current_total_bytes: 0,
        completed: 0,
        total: job.package.assets.len(),
        copied: 0,
        skipped: 0,
        failed: 0,
        items: job
            .package
            .assets
            .iter()
            .map(|a| TransferItem {
                asset_id: a.id.clone(),
                name: a.name.clone(),
                state: "pending".into(),
                target_asset_id: None,
                error: None,
            })
            .collect(),
        error: None,
        output_path: job.output.as_ref().map(|p| p.to_string_lossy().to_string()),
        retryable: true,
    })
}
impl LibraryTransferManager {
    pub(crate) fn start_copy(
        &self,
        base: MaterialCatalog,
        anchor: &str,
        request_id: &str,
        target: &str,
        selection: TransferSelection,
    ) -> MaterialResult<TransferStatus> {
        if anchor == target {
            return Err(fail("请选择另一素材库"));
        }
        let key = serde_json::to_string(&json!(["copy", anchor, target, selection]))
            .map_err(|e| fail(e.to_string()))?;
        if let Some(s) = self.existing(&base, anchor, request_id, &key)? {
            return Ok(s);
        }
        let source = base.for_library(anchor)?;
        let dest = base.for_library(target)?;
        let (p, locals) = source.package_snapshot(&selection)?;
        let root = dest.import_library_root(None)?;
        self.insert_and_start(
            base,
            TransferJob {
                id: request_id.into(),
                kind: "copy".into(),
                anchor: anchor.into(),
                request_key: key,
                target_library_id: Some(target.into()),
                root,
                protected_roots: vec![],
                output: None,
                artifact_sha256: None,
                package_path: None,
                mapping: fresh_map(&p),
                package: p,
                locals,
                media: vec![],
            },
        )
    }
    pub(crate) fn preview_library_move(
        &self,
        base: &MaterialCatalog,
        anchor: &str,
        destination: &Path,
    ) -> MaterialResult<serde_json::Value> {
        base.for_library_task(anchor)?;
        super::library_move::preview_move(base, anchor, destination)
    }
    pub(crate) fn start_move(
        &self,
        base: MaterialCatalog,
        anchor: &str,
        request_id: &str,
        destination: &str,
    ) -> MaterialResult<TransferStatus> {
        base.for_library_task(anchor)?;
        let old_root = super::library_move::library_root(&base, anchor)?;
        // The frozen origin rides in the request key, so a resumed payload
        // alone can re-verify that the authority never moved mid-job.
        let key = serde_json::to_string(&json!(["move", anchor, old_root, destination]))
            .map_err(|e| fail(e.to_string()))?;
        if valid_job_id(request_id) {
            let exists: bool = base
                .open_read()?
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM material_library_transfer WHERE id=?1)",
                    [request_id],
                    |r| r.get(0),
                )
                .map_err(db)?;
            if exists {
                // A replayed completed move re-registers the library at its
                // new root, so the frozen origin no longer matches; only the
                // destination decides whether this is the same request.
                let (job, _) = load_job(&base, anchor, request_id)?;
                let job_destination = serde_json::from_str::<serde_json::Value>(&job.request_key)
                    .ok()
                    .and_then(|k| k.get(3).and_then(|v| v.as_str()).map(PathBuf::from))
                    .and_then(|d| d.canonicalize().ok());
                let same_destination = job.kind == "move"
                    && job_destination.is_some_and(|d| d == job.root)
                    && Path::new(destination)
                        .canonicalize()
                        .is_ok_and(|d| d == job.root);
                if !same_destination {
                    return Err(fail("重复任务身份与原请求不一致"));
                }
                return self.status(&base, anchor, request_id);
            }
        }
        super::library_move::preview_move(&base, anchor, Path::new(destination))?;
        let mut protected_roots = base.transfer_watch_roots()?;
        let root = super::export::validate_destination(&base, Path::new(destination), &protected_roots)
            .map_err(fail)?;
        let source = base.for_library(anchor)?;
        let (mut package, mut locals) = source.package_snapshot(&TransferSelection::default())?;
        super::library_move::retain_movable_members(&mut package, &mut locals, Path::new(&old_root));
        self.insert_and_start(
            base,
            TransferJob {
                id: request_id.into(),
                kind: "move".into(),
                anchor: anchor.into(),
                request_key: key,
                target_library_id: Some(anchor.into()),
                root,
                protected_roots,
                output: None,
                artifact_sha256: None,
                package_path: None,
                mapping: fresh_map(&package),
                package,
                locals,
                media: vec![],
            },
        )
    }
    pub(crate) fn start_export(
        &self,
        base: MaterialCatalog,
        anchor: &str,
        request_id: &str,
        destination: &str,
    ) -> MaterialResult<TransferStatus> {
        self.start_export_guarded(base, anchor, request_id, destination, &[])
    }
    pub(crate) fn start_export_guarded(
        &self,
        base: MaterialCatalog,
        anchor: &str,
        request_id: &str,
        destination: &str,
        protected: &[PathBuf],
    ) -> MaterialResult<TransferStatus> {
        let key = serde_json::to_string(&json!(["export", anchor, destination]))
            .map_err(|e| fail(e.to_string()))?;
        if let Some(s) = self.existing(&base, anchor, request_id, &key)? {
            return Ok(s);
        }
        let source = base.for_library(anchor)?;
        let (p, locals) = source.package_snapshot(&TransferSelection::default())?;
        let output = PathBuf::from(destination);
        let parent = output.parent().ok_or_else(|| fail("请选择库包输出位置"))?;
        let mut protected_roots = base.transfer_watch_roots()?;
        protected_roots.extend_from_slice(protected);
        let root =
            super::export::validate_destination(&base, parent, &protected_roots).map_err(fail)?;
        let name = output
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| fail("库包文件名无效"))?;
        if !name.to_ascii_lowercase().ends_with(".lrlibrary")
            || name.contains([':', '\\'])
            || name.len() > 240
            || output.exists()
        {
            return Err(fail("库包文件已存在或名称无效，请选择新文件"));
        }
        self.insert_and_start(
            base,
            TransferJob {
                id: request_id.into(),
                kind: "export".into(),
                anchor: anchor.into(),
                request_key: key,
                target_library_id: None,
                output: Some(root.join(name)),
                root,
                protected_roots,
                artifact_sha256: None,
                package_path: None,
                mapping: fresh_map(&p),
                package: p,
                locals,
                media: vec![],
            },
        )
    }
    pub(crate) fn start_restore(
        &self,
        base: MaterialCatalog,
        anchor: &str,
        request_id: &str,
        package_path: &str,
        root: &str,
        name: &str,
    ) -> MaterialResult<TransferStatus> {
        self.start_restore_guarded(base, anchor, request_id, package_path, root, name, &[])
    }
    pub(crate) fn start_restore_guarded(
        &self,
        base: MaterialCatalog,
        anchor: &str,
        request_id: &str,
        package_path: &str,
        root: &str,
        name: &str,
        protected: &[PathBuf],
    ) -> MaterialResult<TransferStatus> {
        base.for_library_task(anchor)?;
        let key = serde_json::to_string(&json!(["restore", anchor, package_path, root, name]))
            .map_err(|e| fail(e.to_string()))?;
        if let Some(s) = self.existing(&base, anchor, request_id, &key)? {
            return Ok(s);
        }
        let mut protected_roots = base.transfer_watch_roots()?;
        protected_roots.extend_from_slice(protected);
        let root = super::export::validate_destination(&base, Path::new(root), &protected_roots)
            .map_err(fail)?;
        if std::fs::read_dir(&root)
            .map_err(|e| MaterialError::io("library-transfer-io", "读取恢复目录失败", e))?
            .next()
            .is_some()
        {
            return Err(fail("恢复为新库必须选择空目录；不能覆盖已有库"));
        }
        if name.trim().is_empty()
            || name.chars().count() > 120
            || name.chars().any(char::is_control)
        {
            return Err(fail("新库名称无效"));
        }
        let package_path = super::catalog::canonical_regular_file(Path::new(package_path))?;
        let mut p = inspect_package(&package_path)?;
        p.name = name.trim().into();
        let names: std::collections::HashSet<_> = base
            .list_libraries(true)?
            .into_iter()
            .map(|l| l.name.to_lowercase())
            .collect();
        if names.contains(&p.name.to_lowercase()) {
            let stem = p.name.chars().take(100).collect::<String>();
            for suffix in 2..=10_000 {
                let candidate = format!("{stem}（导入 {suffix}）");
                if !names.contains(&candidate.to_lowercase()) {
                    p.name = candidate;
                    break;
                }
            }
            if names.contains(&p.name.to_lowercase()) {
                return Err(fail("新库同名冲突过多，请选择另一名称"));
            }
        }
        self.insert_and_start(
            base,
            TransferJob {
                id: request_id.into(),
                kind: "restore".into(),
                anchor: anchor.into(),
                request_key: key,
                target_library_id: Some(unique_id("library")),
                root,
                protected_roots,
                output: None,
                artifact_sha256: None,
                package_path: Some(package_path),
                mapping: fresh_map(&p),
                package: p,
                locals: vec![],
                media: vec![],
            },
        )
    }
    fn existing(
        &self,
        base: &MaterialCatalog,
        anchor: &str,
        id: &str,
        key: &str,
    ) -> MaterialResult<Option<TransferStatus>> {
        if !valid_job_id(id) {
            return Err(fail("任务身份无效"));
        }
        let exists: bool = base
            .open_read()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM material_library_transfer WHERE id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(db)?;
        if !exists {
            return Ok(None);
        }
        let (job, _) = load_job(base, anchor, id)?;
        if job.request_key != key {
            return Err(fail("重复任务身份与原请求不一致"));
        }
        self.status(base, anchor, id).map(Some)
    }
    fn insert_and_start(
        &self,
        base: MaterialCatalog,
        job: TransferJob,
    ) -> MaterialResult<TransferStatus> {
        let status = initial_status(&base, &job)?;
        if serde_json::to_vec(&job.package)
            .map_err(|e| fail(e.to_string()))?
            .len() as u64
            > MAX_METADATA
        {
            return Err(fail("库包元数据快照超出16MiB预算"));
        }
        let c = base.open_write()?;
        let at = chrono::Utc::now().to_rfc3339();
        c.execute("INSERT INTO material_library_transfer(id,anchor_library_id,kind,phase,payload_json,result_json,created_at,updated_at) VALUES(?1,?2,?3,'prepared',?4,?5,?6,?6)",rusqlite::params![job.id,job.anchor,job.kind,serde_json::to_string(&job).map_err(|e|fail(e.to_string()))?,serde_json::to_string(&status).map_err(|e|fail(e.to_string()))?,at]).map_err(db)?;
        self.launch(base, job, status)
    }
    pub(crate) fn list(
        &self,
        base: &MaterialCatalog,
        anchor: &str,
        unresolved_only: bool,
    ) -> MaterialResult<Vec<TransferStatus>> {
        let c = base.open_read()?;
        // Durable unresolved work is never displaced by completed history.
        let sql = if unresolved_only {
            "SELECT id FROM material_library_transfer WHERE anchor_library_id=?1 AND phase<>'completed' ORDER BY created_at DESC,id DESC"
        } else {
            "SELECT id FROM material_library_transfer WHERE anchor_library_id=?1 AND (phase<>'completed' OR id IN (SELECT id FROM material_library_transfer WHERE anchor_library_id=?1 AND phase='completed' ORDER BY created_at DESC,id DESC LIMIT 16)) ORDER BY (phase='completed'),created_at DESC,id DESC"
        };
        let ids = c
            .prepare(sql)
            .map_err(db)?
            .query_map([anchor], |r| r.get::<_, String>(0))
            .map_err(db)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db)?;
        ids.iter().map(|id| self.status(base, anchor, id)).collect()
    }
    pub(crate) fn status(
        &self,
        base: &MaterialCatalog,
        anchor: &str,
        id: &str,
    ) -> MaterialResult<TransferStatus> {
        let (_, mut persisted) = load_job(base, anchor, id)?;
        if let Some(t) = self.tasks.lock().unwrap().get(id) {
            return Ok(t.status.lock().unwrap().clone());
        }
        if matches!(
            persisted.phase.as_str(),
            "prepared" | "running" | "verifying" | "staging" | "committing"
        ) {
            persisted.phase = "interrupted".into();
            persisted.error = Some("上次任务中断；可从冻结记录重试".into());
            persisted.retryable = true;
        }
        Ok(persisted)
    }
    pub(crate) fn cancel(
        &self,
        base: &MaterialCatalog,
        anchor: &str,
        id: &str,
    ) -> MaterialResult<TransferStatus> {
        load_job(base, anchor, id)?;
        if let Some(t) = self.tasks.lock().unwrap().get(id) {
            let s = t.status.lock().unwrap();
            if !matches!(
                s.phase.as_str(),
                "committing" | "completed" | "partial" | "failed" | "cancelled"
            ) {
                t.cancel.store(true, Ordering::Release);
            }
            return Ok(s.clone());
        }
        let (job, mut status) = load_job(base, anchor, id)?;
        if status.phase != "completed" {
            status.phase = "cancelled".into();
            status.retryable = true;
            persist_job(base, &job, &status, None)?;
        }
        Ok(status)
    }
    pub(crate) fn retry(
        &self,
        base: MaterialCatalog,
        anchor: &str,
        id: &str,
    ) -> MaterialResult<TransferStatus> {
        let (job, mut status) = load_job(&base, anchor, id)?;
        if status.phase == "completed" {
            return Ok(status);
        }
        if let Some(t) = self.tasks.lock().unwrap().get(id) {
            if matches!(
                t.status.lock().unwrap().phase.as_str(),
                "running" | "verifying" | "staging" | "committing"
            ) {
                return Ok(t.status.lock().unwrap().clone());
            }
        }
        status.phase = "prepared".into();
        status.error = None;
        status.retryable = true;
        self.launch(base, job, status)
    }
    fn launch(
        &self,
        base: MaterialCatalog,
        job: TransferJob,
        mut status: TransferStatus,
    ) -> MaterialResult<TransferStatus> {
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(existing) = tasks.get(&job.id) {
            let current = existing.status.lock().unwrap();
            if matches!(
                current.phase.as_str(),
                "running" | "verifying" | "staging" | "committing"
            ) {
                return Ok(current.clone());
            }
        }
        if tasks
            .values()
            .filter(|t| {
                matches!(
                    t.status.lock().unwrap().phase.as_str(),
                    "running" | "verifying" | "staging" | "committing"
                )
            })
            .count()
            >= 2
        {
            return Err(fail("已有两个素材库任务，请稍后重试"));
        }
        if tasks.len() >= 16 {
            tasks.retain(|_, t| {
                matches!(
                    t.status.lock().unwrap().phase.as_str(),
                    "running" | "verifying" | "staging" | "committing"
                )
            });
        }
        status.phase = "running".into();
        let initial = status.clone();
        let control = Arc::new(TransferControl {
            status: Mutex::new(status),
            cancel: AtomicBool::new(false),
            #[cfg(test)]
            pause_ms: *self.test_pause_ms.lock().unwrap(),
            #[cfg(test)]
            disk_full: self.test_disk_full.load(Ordering::Acquire),
        });
        tasks.insert(job.id.clone(), control.clone());
        drop(tasks);
        if let Err(error) = persist_job(&base, &job, &initial, None) {
            self.tasks.lock().unwrap().remove(&job.id);
            return Err(error);
        }
        std::thread::spawn(move || run_job(base, job, control));
        Ok(initial)
    }
}

pub(super) fn run_job(base: MaterialCatalog, mut job: TransferJob, control: Arc<TransferControl>) {
    let operation = super::library_transfer_io::perform(&base, &mut job, &control);
    if let Err(e) = operation {
        let mut s = control.status.lock().unwrap();
        s.phase = if e.code == "library-transfer-cancelled" {
            "cancelled"
        } else {
            "failed"
        }
        .into();
        let message = e.message;
        let cancelled = s.phase == "cancelled";
        for item in &mut s.items {
            if item.state == "pending" {
                item.state = if cancelled { "cancelled" } else { "failed" }.into();
                item.error = Some(message.clone());
            }
        }
        s.failed = s.items.iter().filter(|i| i.state == "failed").count();
        s.completed = s.items.iter().filter(|i| i.state != "pending").count();
        s.error = Some(message);
        s.retryable = true;
        let _ = persist_job(&base, &job, &s, None);
    } else if control.status.lock().unwrap().phase == "completed" {
        // Completion is durable before cache removal; a cleanup interruption
        // cannot undo the library/package or make a retry duplicate it.
        let _ = super::library_transfer_io::cleanup_completed_stage(&base, &job);
    }
}

#[cfg(test)]
#[path = "library_transfer_tests.rs"]
mod tests;
