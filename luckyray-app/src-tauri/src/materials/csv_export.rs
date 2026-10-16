//! User-requested, metadata-only CSV export for ordinary materials. The plan
//! freezes a bounded SQLite snapshot; neither planning nor writing opens media.
use super::MaterialCatalog;
use super::export::{validate_destination, DirectoryHold, move_no_replace};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(test)]
use std::sync::Condvar;
use std::time::{Duration, Instant};

const MAX_ROWS: usize = 500;
const MAX_PLANS: usize = 16;
const MAX_TASKS: usize = 16;
const PLAN_TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum CsvExportPlanRequest {
    Assets { #[serde(rename = "assetIds")] asset_ids: Vec<String> },
    Folder { #[serde(rename = "folderId")] folder_id: String },
}

#[derive(Clone, Debug)]
pub(super) struct CsvRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub mime_type: String,
    pub size_bytes: Option<i64>,
    pub folder_name: String,
    pub folder_path: Vec<String>,
    pub tags: Vec<String>,
    pub rating: Option<i64>,
    pub imported_at: String,
    pub source_type: String,
    pub source_title: String,
    pub source_page_url: String,
    pub description: String,
}

#[derive(Debug)]
pub(super) struct CsvSnapshot {
    pub rows: Vec<CsvRow>,
    pub scope_label: String,
    pub includes_descendants: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvExportPlanSummary {
    pub plan_id: String,
    pub total: usize,
    pub scope_label: String,
    pub includes_descendants: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvExportTaskStatus {
    pub task_id: String,
    pub phase: String,
    pub total: usize,
    pub completed: usize,
    pub output_path: Option<String>,
    pub destination: String,
    pub error: Option<String>,
}

struct PendingPlan { created: Instant, rows: Arc<Vec<CsvRow>>, library_id:String }
struct TaskControl {
    status: Mutex<CsvExportTaskStatus>,
    cancel: AtomicBool,
    retried: AtomicBool,
    rows: Arc<Vec<CsvRow>>,
    include_description: bool,
    library_id:String,
    #[cfg(test)]
    write_probe: Option<Arc<dyn Fn(CsvWriteCheckpoint, &TaskControl) -> Result<(), String> + Send + Sync>>,
    #[cfg(test)]
    finished: Condvar,
}
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum CsvWriteCheckpoint { RowWritten, BeforeCommit }
#[derive(Default)]
struct CsvState { plans: HashMap<String, PendingPlan>, tasks: HashMap<String, Arc<TaskControl>> }
#[derive(Default)]
pub(crate) struct CsvExportManager { state: Mutex<CsvState> }
static CSV_MANAGER: OnceLock<CsvExportManager> = OnceLock::new();
pub(crate) fn csv_export_manager() -> &'static CsvExportManager { CSV_MANAGER.get_or_init(CsvExportManager::default) }

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl CsvExportManager {
    pub(crate) fn plan(&self, catalog: &MaterialCatalog, request: CsvExportPlanRequest) -> Result<CsvExportPlanSummary, String> {
        let snapshot = catalog.csv_metadata_snapshot(request).map_err(|error| error.message)?;
        if snapshot.rows.is_empty() { return Err("所选范围没有可导出的素材记录".into()); }
        if snapshot.rows.len() > MAX_ROWS { return Err("清单超过 500 行，请缩小选择范围".into()); }
        let summary = CsvExportPlanSummary {
            plan_id: new_id(), total: snapshot.rows.len(), scope_label: snapshot.scope_label,
            includes_descendants: snapshot.includes_descendants,
        };
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        state.plans.retain(|_, plan| plan.created.elapsed() < PLAN_TTL);
        if state.plans.len() >= MAX_PLANS { return Err("待确认清单过多，请先完成或关闭已有清单".into()); }
        state.plans.insert(summary.plan_id.clone(), PendingPlan {
            created: Instant::now(), rows: Arc::new(snapshot.rows),library_id:catalog.library_scope_key().map_err(|e|e.message)?,
        });
        Ok(summary)
    }

    pub(crate) fn discard(&self, plan_id: &str) {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).plans.remove(plan_id);
    }

    pub(crate) fn start(&self, catalog: MaterialCatalog, plan_id: &str, destination: &str,
        include_description: bool, protected: &[PathBuf]) -> Result<CsvExportTaskStatus, String> {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let plan = state.plans.get(plan_id).ok_or("清单计划已取消或过期，请重新选择")?;
        if plan.library_id!=catalog.library_scope_key().map_err(|e|e.message)? {return Err("清单计划属于另一个素材库".into());}
        if plan.created.elapsed() >= PLAN_TTL {
            state.plans.remove(plan_id);
            return Err("清单计划已过期，请重新选择".into());
        }
        let rows = Arc::clone(&plan.rows);
        let result = self.start_locked(&mut state, catalog, rows, destination, include_description, protected)?;
        state.plans.remove(plan_id);
        Ok(result)
    }

    pub(crate) fn retry(&self, catalog: MaterialCatalog, task_id: &str,
        protected: &[PathBuf]) -> Result<CsvExportTaskStatus, String> {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = Arc::clone(state.tasks.get(task_id).ok_or("清单任务摘要已过期")?);
        if previous.library_id!=catalog.library_scope_key().map_err(|e|e.message)? {return Err("清单任务属于另一个素材库".into());}
        let status = previous.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        if status.phase != "failed" { return Err("只能重试失败的清单任务".into()); }
        if previous.retried.load(Ordering::SeqCst) { return Err("该清单失败项已由新任务接续".into()); }
        let rows = Arc::clone(&previous.rows);
        let include_description = previous.include_description;
        let child = self.start_locked(&mut state, catalog, rows, &status.destination, include_description, protected)?;
        previous.retried.store(true, Ordering::SeqCst);
        Ok(child)
    }

    fn start_locked(&self, state: &mut CsvState, catalog: MaterialCatalog, rows: Arc<Vec<CsvRow>>,
        destination: &str, include_description: bool, protected: &[PathBuf]) -> Result<CsvExportTaskStatus, String> {
        if state.tasks.values().any(|task| matches!(task.status.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner).phase.as_str(), "preparing" | "running" | "cancelling")) {
            return Err("已有清单任务在运行，请等待或取消".into());
        }
        if state.tasks.len() >= MAX_TASKS {
            let finished = state.tasks.iter().find(|(_, task)| matches!(task.status.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner).phase.as_str(), "completed" | "cancelled" | "failed"))
                .map(|(id, _)| id.clone());
            if let Some(id) = finished { state.tasks.remove(&id); }
            else { return Err("清单任务摘要已满".into()); }
        }
        let target = Path::new(destination);
        if !target.is_absolute() || target.extension().and_then(|v| v.to_str()).is_none_or(|v| !v.eq_ignore_ascii_case("csv")) {
            return Err("请选择本地 .csv 文件路径".into());
        }
        let parent = target.parent().ok_or("清单输出路径无效")?;
        let root = validate_destination(&catalog, parent, protected)?;
        let hold = DirectoryHold::new(&root)?;
        let name = target.file_name().and_then(|value| value.to_str()).ok_or("清单文件名无效")?;
        if name == ".csv" || name.chars().any(char::is_control) { return Err("清单文件名无效".into()); }
        let task_id = new_id();
        let status = CsvExportTaskStatus {
            task_id: task_id.clone(), phase: "preparing".into(), total: rows.len(), completed: 0,
            output_path: None, destination: target.to_string_lossy().into_owned(), error: None,
        };
        let task = Arc::new(TaskControl { status: Mutex::new(status.clone()), cancel: AtomicBool::new(false),
            retried: AtomicBool::new(false), rows,
            include_description,library_id:catalog.library_scope_key().map_err(|e|e.message)?,
            #[cfg(test)]
            write_probe: None,
            #[cfg(test)]
            finished: Condvar::new(),
        });
        state.tasks.insert(task_id, Arc::clone(&task));
        let protected = protected.to_vec();
        std::thread::spawn(move || run_task(catalog, root, hold, protected, task));
        Ok(status)
    }

    pub(crate) fn list_scoped(&self,catalog:&MaterialCatalog)->Result<Vec<CsvExportTaskStatus>,String> {
        let library=catalog.library_scope_key().map_err(|e|e.message)?;
        let state=self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut tasks=state.tasks.values().filter(|task|task.library_id==library).map(|task|task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()).collect::<Vec<_>>();
        tasks.sort_by(|a,b|a.task_id.cmp(&b.task_id));Ok(tasks)
    }
    pub(crate) fn assert_task_scope(&self,catalog:&MaterialCatalog,id:&str)->Result<(),String> {
        let library=catalog.library_scope_key().map_err(|e|e.message)?;
        let state=self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let task=state.tasks.get(id).ok_or("素材任务不存在或已过期")?;
        if task.library_id!=library {return Err("素材任务属于另一个库".into());}
        Ok(())
    }
    pub(crate) fn discard_scoped(&self,catalog:&MaterialCatalog,id:&str)->Result<(),String> {
        let library=catalog.library_scope_key().map_err(|e|e.message)?;
        let mut state=self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(plan)=state.plans.get(id) {if plan.library_id!=library {return Err("素材计划属于另一个库".into());}}
        state.plans.remove(id);
        Ok(())
    }
    pub(crate) fn status(&self, task_id: &str) -> Result<CsvExportTaskStatus, String> {
        let task = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .tasks.get(task_id).cloned().ok_or("清单任务摘要已过期")?;
        let status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        Ok(status)
    }

    pub(crate) fn cancel(&self, task_id: &str) -> Result<CsvExportTaskStatus, String> {
        let task = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .tasks.get(task_id).cloned().ok_or("清单任务摘要已过期")?;
        task.cancel.store(true, Ordering::SeqCst);
        let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(status.phase.as_str(), "preparing" | "running") { status.phase = "cancelling".into(); }
        Ok(status.clone())
    }
}

fn run_task(catalog: MaterialCatalog, root: PathBuf, hold: DirectoryHold, protected: Vec<PathBuf>, task: Arc<TaskControl>) {
    let result = write_task(&catalog, &root, &hold, &protected, &task);
    let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    match result {
        Ok(path) => { status.phase = "completed".into(); status.completed = status.total;
            status.output_path = Some(path.to_string_lossy().into_owned()); },
        Err(error) if error == "cancelled" => { status.phase = "cancelled".into(); status.error = None; },
        Err(error) => { status.phase = "failed".into(); status.error = Some(error); },
    }
    #[cfg(test)]
    task.finished.notify_all();
}

struct TempGuard { path: PathBuf, identity: String, committed: bool }
impl Drop for TempGuard {
    fn drop(&mut self) {
        if self.committed { return; }
        if let Ok(file) = File::open(&self.path) {
            if super::catalog::export_file_identity(&file).is_ok_and(|id| id == self.identity) {
                drop(file);
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

fn write_task(catalog: &MaterialCatalog, root: &Path, hold: &DirectoryHold,
    protected: &[PathBuf], task: &TaskControl) -> Result<PathBuf, String> {
    if task.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
    hold.verify()?;
    if validate_destination(catalog, root, protected)? != root { return Err("清单目录已变化".into()); }
    let task_id = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).task_id.clone();
    let temp = root.join(format!(".luckyray-csv-{task_id}.tmp"));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)
        .map_err(|error| format!("创建清单临时文件失败: {error}"))?;
    let identity = match super::catalog::export_file_identity(&file) {
        Ok(identity) => identity,
        Err(error) => {
            drop(file);
            let _ = std::fs::remove_file(&temp);
            return Err(error.message);
        }
    };
    let mut guard = TempGuard { path: temp.clone(), identity, committed: false };
    {
        let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if status.phase != "cancelling" { status.phase = "running".into(); }
    }
    file.write_all(b"\xef\xbb\xbf").map_err(|error| format!("写入 CSV BOM 失败: {error}"))?;
    write_header(&mut file, task.include_description)?;
    for row in task.rows.iter() {
        if task.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        write_row(&mut file, row, task.include_description)?;
        task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).completed += 1;
        #[cfg(test)]
        if let Some(probe) = &task.write_probe { probe(CsvWriteCheckpoint::RowWritten, task)?; }
    }
    file.flush().map_err(|error| format!("刷新 CSV 失败: {error}"))?;
    file.sync_all().map_err(|error| format!("同步 CSV 失败: {error}"))?;
    drop(file);
    if task.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
    #[cfg(test)]
    if let Some(probe) = &task.write_probe { probe(CsvWriteCheckpoint::BeforeCommit, task)?; }
    hold.verify()?;
    if validate_destination(catalog, root, protected)? != root { return Err("清单目录已变化".into()); }
    let requested = Path::new(&task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).destination)
        .file_name().ok_or("清单文件名无效")?.to_owned();
    let requested = Path::new(&requested);
    let stem = requested.file_stem().and_then(|v| v.to_str()).ok_or("清单文件名无效")?;
    for suffix in 0..10_000 {
        if task.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        let name = if suffix == 0 { requested.to_string_lossy().into_owned() }
            else { format!("{stem} ({suffix}).csv") };
        let output = root.join(name);
        match move_no_replace(&temp, &output) {
            Ok(()) => { guard.committed = true; return Ok(output); },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("完成 CSV 失败: {error}")),
        }
    }
    Err("重名清单过多，请更换文件名".into())
}

const HEADERS: [&str; 13] = ["素材ID", "名称", "类型", "MIME", "已记录大小（bytes）", "分类名称",
    "分类层级（JSON数组）", "标签名称（JSON数组）", "评分", "导入时间", "来源类型", "来源标题", "来源页面URL"];

fn write_header(writer: &mut impl Write, description: bool) -> Result<(), String> {
    let mut fields = HEADERS.iter().map(|value| value.to_string()).collect::<Vec<_>>();
    if description { fields.push("描述".into()); }
    write_line(writer, &fields)
}

fn write_row(writer: &mut impl Write, row: &CsvRow, description: bool) -> Result<(), String> {
    // Multi-valued names are JSON arrays inside one RFC4180 cell. A consumer
    // first parses CSV, then parses the folder/tag cell as JSON; separators in
    // the original names never change the CSV column count.
    let mut fields = vec![safe_text(&row.id), safe_text(&row.name), safe_text(&row.kind), safe_text(&row.mime_type),
        row.size_bytes.map(|v| v.to_string()).unwrap_or_default(), safe_text(&row.folder_name),
        safe_text(&serde_json::to_string(&row.folder_path).map_err(|error| error.to_string())?),
        safe_text(&serde_json::to_string(&row.tags).map_err(|error| error.to_string())?),
        row.rating.map(|v| v.to_string()).unwrap_or_default(), safe_text(&row.imported_at),
        safe_text(&row.source_type), safe_text(&row.source_title), safe_text(&row.source_page_url)];
    if description { fields.push(safe_text(&row.description)); }
    write_line(writer, &fields)
}

fn safe_text(value: &str) -> String {
    let candidate = value.trim_start_matches(|ch: char| ch.is_whitespace() || ch.is_control()
        || matches!(ch, '\u{feff}' | '\u{200b}' | '\u{200c}' | '\u{200d}'));
    if candidate.starts_with(['=', '+', '-', '@']) { format!("'{value}") } else { value.to_owned() }
}

fn write_line(writer: &mut impl Write, fields: &[String]) -> Result<(), String> {
    for (index, field) in fields.iter().enumerate() {
        if index > 0 { writer.write_all(b",").map_err(|error| error.to_string())?; }
        writer.write_all(b"\"").map_err(|error| error.to_string())?;
        writer.write_all(field.replace('"', "\"\"").as_bytes()).map_err(|error| error.to_string())?;
        writer.write_all(b"\"").map_err(|error| error.to_string())?;
    }
    writer.write_all(b"\r\n").map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row() -> CsvRow {
        CsvRow { id: "id-1".into(), name: "  =HYPERLINK(\"x\")\r\n中文😀".into(), kind: "image".into(),
            mime_type: "image/png".into(), size_bytes: Some(123), folder_name: "子,类".into(),
            folder_path: vec!["父\n类".into(), "子,类".into()], tags: vec!["a,b".into(), "=bad".into()],
            rating: Some(4), imported_at: "2026-09-26".into(), source_type: "作品页".into(),
            source_title: "@title".into(), source_page_url: "https://example.test/work?q=1#part".into(),
            description: "+formula".into() }
    }

    fn parse_csv(input: &str) -> Vec<Vec<String>> {
        let mut lines = Vec::new();
        let mut line = Vec::new();
        let mut field = String::new();
        let mut chars = input.chars().peekable();
        let mut quoted = false;
        while let Some(ch) = chars.next() {
            if quoted {
                if ch == '"' {
                    if chars.peek() == Some(&'"') { chars.next(); field.push('"'); }
                    else { quoted = false; }
                } else { field.push(ch); }
            } else {
                match ch {
                    '"' => quoted = true,
                    ',' => { line.push(std::mem::take(&mut field)); },
                    '\r' if chars.peek() == Some(&'\n') => {
                        chars.next(); line.push(std::mem::take(&mut field)); lines.push(std::mem::take(&mut line));
                    },
                    _ => field.push(ch),
                }
            }
        }
        assert!(!quoted);
        lines
    }

    #[test]
    fn csv_quotes_multivalued_unicode_and_formula_text_without_changing_source() {
        let row = sample_row();
        let original = row.name.clone();
        let mut bytes = Vec::new();
        write_header(&mut bytes, true).unwrap();
        write_row(&mut bytes, &row, true).unwrap();
        let output = String::from_utf8(bytes).unwrap();
        let parsed = parse_csv(&output);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].len(), 14);
        assert_eq!(parsed[1].len(), 14);
        assert_eq!(parsed[1][1], format!("'{original}"));
        assert_eq!(parsed[1][4], "123");
        assert_eq!(serde_json::from_str::<Vec<String>>(&parsed[1][6]).unwrap(), row.folder_path);
        assert_eq!(serde_json::from_str::<Vec<String>>(&parsed[1][7]).unwrap(), row.tags);
        assert_eq!(parsed[1][11], "'@title");
        assert_eq!(parsed[1][12], "https://example.test/work?q=1#part");
        assert_eq!(parsed[1][13], "'+formula");
        assert_eq!(row.name, original);
        for dangerous in ["=1+1", " +1", "\t@SUM(1)", "\r\n-HYPERLINK(1)", "\u{feff}=1", "\u{200b}+1"] {
            assert_eq!(safe_text(dangerous), format!("'{dangerous}"));
        }
        assert_eq!(safe_text("normal = text"), "normal = text");
    }

    #[test]
    fn release_runtime_protected_targets_reject_csv_export_but_allow_user_output() {
        let fixture = tempfile::tempdir().unwrap();
        let catalog = MaterialCatalog::new_for_test_at(fixture.path().join("profile"));
        let protected = ["app-data", "config", "cache", "resource", "exe", "watch"]
            .map(|name| fixture.path().join(name));
        for directory in &protected {
            std::fs::create_dir_all(directory.join("nested")).unwrap();
        }
        let output = fixture.path().join("user-output");
        std::fs::create_dir(&output).unwrap();
        for (index, target) in protected.iter().map(|p| p.join("nested"))
            .chain(std::iter::once(output)).enumerate() {
            let target = target.canonicalize().unwrap();
            let task = TaskControl {
                status: Mutex::new(CsvExportTaskStatus { task_id: format!("protected-{index}"),
                    phase: "preparing".into(), total: 1, completed: 0, output_path: None,
                    destination: target.join("清单.csv").to_string_lossy().into_owned(), error: None }),
                cancel: AtomicBool::new(false), retried: AtomicBool::new(false),
                rows: Arc::new(vec![sample_row()]), include_description: false, library_id:catalog.library_scope_key().unwrap(),
                write_probe: None, finished: Condvar::new(),
            };
            let hold = DirectoryHold::new(&target).unwrap();
            let result = write_task(&catalog, &target, &hold, &protected, &task);
            if index < protected.len() {
                assert!(result.is_err());
                assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
            } else {
                let bytes = std::fs::read(result.unwrap()).unwrap();
                assert!(bytes.starts_with(b"\xef\xbb\xbf"));
                let parsed = parse_csv(std::str::from_utf8(&bytes[3..]).unwrap());
                assert_eq!(parsed.len(), 2);
                assert_eq!(parsed[1][0], "id-1");
                assert_eq!(task.rows[0].name, sample_row().name);
            }
        }
    }

    #[test]
    fn csv_real_output_is_bom_crlf_noclobber_and_cancel_cleans_only_own_temp() {
        let fixture = tempfile::tempdir().unwrap();
        let catalog = MaterialCatalog::new_for_test_at(fixture.path().join("profile"));
        let root = fixture.path().join("out");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let existing = root.join("清单.csv");
        std::fs::write(&existing, b"keep").unwrap();
        let requested = existing.to_string_lossy().into_owned();
        let task = TaskControl {
            status: Mutex::new(CsvExportTaskStatus { task_id: "test-task".into(), phase: "preparing".into(),
                total: 1, completed: 0, output_path: None, destination: requested.clone(), error: None }),
            cancel: AtomicBool::new(false), retried: AtomicBool::new(false),
            rows: Arc::new(vec![sample_row()]), include_description: false, library_id:catalog.library_scope_key().unwrap(),
            write_probe: None, finished: Condvar::new(),
        };
        let hold = DirectoryHold::new(&root).unwrap();
        let output = write_task(&catalog, &root, &hold, &[], &task).unwrap();
        assert_eq!(output.file_name().unwrap().to_string_lossy(), "清单 (1).csv");
        assert_eq!(std::fs::read(&existing).unwrap(), b"keep");
        let bytes = std::fs::read(&output).unwrap();
        assert!(bytes.starts_with(b"\xef\xbb\xbf"));
        let parsed = parse_csv(std::str::from_utf8(&bytes[3..]).unwrap());
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].len(), 13);
        assert_eq!(parsed[1].len(), 13);
        assert!(!root.join(".luckyray-csv-test-task.tmp").exists());
        task.cancel.store(true, Ordering::SeqCst);
        assert_eq!(write_task(&catalog, &root, &hold, &[], &task).unwrap_err(), "cancelled");
        assert_eq!(std::fs::read(&output).unwrap(), bytes);
    }

    #[test]
    fn csv_cancel_after_partial_write_cleans_only_own_temp() {
        let fixture = tempfile::tempdir().unwrap();
        let catalog = MaterialCatalog::new_for_test_at(fixture.path().join("profile"));
        let root = fixture.path().join("out");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let existing = root.join("清单.csv");
        let other_temp = root.join(".luckyray-csv-another-task.tmp");
        let source = fixture.path().join("source.txt");
        std::fs::write(&existing, b"existing output").unwrap();
        std::fs::write(&other_temp, b"another task").unwrap();
        std::fs::write(&source, b"source unchanged").unwrap();
        let first = sample_row();
        let original_name = first.name.clone();
        let temp = root.join(".luckyray-csv-partial-cancel.tmp");
        let task = Arc::new(TaskControl {
            status: Mutex::new(CsvExportTaskStatus { task_id: "partial-cancel".into(), phase: "preparing".into(),
                total: 2, completed: 0, output_path: None,
                destination: existing.to_string_lossy().into_owned(), error: None }),
            cancel: AtomicBool::new(false), retried: AtomicBool::new(false),
            rows: Arc::new(vec![first, sample_row()]), include_description: false, library_id:catalog.library_scope_key().unwrap(),
            write_probe: Some(Arc::new(move |checkpoint, control| {
                if checkpoint == CsvWriteCheckpoint::RowWritten {
                    let bytes = std::fs::read(&temp).unwrap();
                    assert!(bytes.starts_with(b"\xef\xbb\xbf"));
                    assert!(bytes.len() > 3, "header and first row were actually written");
                    control.cancel.store(true, Ordering::SeqCst);
                }
                Ok(())
            })),
            finished: Condvar::new(),
        });
        run_task(catalog, root.clone(), DirectoryHold::new(&root).unwrap(), vec![], Arc::clone(&task));
        let status = task.status.lock().unwrap();
        assert_eq!(status.phase, "cancelled");
        assert_eq!(status.completed, 1);
        assert!(status.output_path.is_none());
        assert!(!root.join(".luckyray-csv-partial-cancel.tmp").exists());
        assert_eq!(std::fs::read(&existing).unwrap(), b"existing output");
        assert_eq!(std::fs::read(&other_temp).unwrap(), b"another task");
        assert_eq!(std::fs::read(&source).unwrap(), b"source unchanged");
        assert_eq!(task.rows[0].name, original_name);
    }

    #[test]
    fn csv_retry_after_real_post_write_failure_can_claim_parent_only_once() {
        let fixture = tempfile::tempdir().unwrap();
        let catalog = MaterialCatalog::new_for_test_at(fixture.path().join("profile"));
        let root = fixture.path().join("out");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let destination = root.join("清单.csv").to_string_lossy().into_owned();
        let other_temp = root.join(".luckyray-csv-another-task.tmp");
        let source = fixture.path().join("source.txt");
        std::fs::write(&other_temp, b"another task").unwrap();
        std::fs::write(&source, b"source unchanged").unwrap();
        let temp = root.join(".luckyray-csv-failed-parent.tmp");
        let row = sample_row();
        let original_name = row.name.clone();
        let parent = Arc::new(TaskControl {
            status: Mutex::new(CsvExportTaskStatus { task_id: "failed-parent".into(), phase: "preparing".into(),
                total: 1, completed: 0, output_path: None, destination, error: None }),
            cancel: AtomicBool::new(false), retried: AtomicBool::new(false),
            rows: Arc::new(vec![row]), include_description: false, library_id:catalog.library_scope_key().unwrap(),
            write_probe: Some(Arc::new(move |checkpoint, _| {
                if checkpoint == CsvWriteCheckpoint::BeforeCommit {
                    let bytes = std::fs::read(&temp).unwrap();
                    assert!(bytes.starts_with(b"\xef\xbb\xbf"));
                    assert_eq!(parse_csv(std::str::from_utf8(&bytes[3..]).unwrap()).len(), 2);
                    return Err("test-only post-write failure".into());
                }
                Ok(())
            })),
            finished: Condvar::new(),
        });
        run_task(catalog.clone(), root.clone(), DirectoryHold::new(&root).unwrap(), vec![], Arc::clone(&parent));
        let failed = parent.status.lock().unwrap().clone();
        assert_eq!(failed.phase, "failed");
        assert_eq!(failed.completed, 1);
        assert_eq!(failed.error.as_deref(), Some("test-only post-write failure"));
        assert!(failed.output_path.is_none());
        assert!(!root.join(".luckyray-csv-failed-parent.tmp").exists());
        assert!(!root.join("清单.csv").exists());
        assert_eq!(std::fs::read(&other_temp).unwrap(), b"another task");
        assert_eq!(std::fs::read(&source).unwrap(), b"source unchanged");
        assert_eq!(parent.rows[0].name, original_name);
        let manager = CsvExportManager::default();
        manager.state.lock().unwrap().tasks.insert("failed-parent".into(), Arc::clone(&parent));
        let child = manager.retry(catalog.clone(), "failed-parent", &[]).unwrap();
        assert!(manager.retry(catalog.clone(), "failed-parent", &[]).unwrap_err().contains("已由新任务接续"));
        let child_control = Arc::clone(manager.state.lock().unwrap().tasks.get(&child.task_id).unwrap());
        let status = child_control.status.lock().unwrap();
        let (status, timeout) = child_control.finished.wait_timeout_while(status, Duration::from_secs(10),
            |status| matches!(status.phase.as_str(), "preparing" | "running" | "cancelling")).unwrap();
        assert!(!timeout.timed_out(), "retry task did not reach a terminal state");
        assert_eq!(status.phase, "completed");
        let output = status.output_path.clone().unwrap();
        drop(status);
        assert_eq!(std::fs::read(&output).unwrap()[..3], *b"\xef\xbb\xbf");
        assert!(manager.retry(catalog, "failed-parent", &[]).unwrap_err().contains("已由新任务接续"));
        let csv_outputs = std::fs::read_dir(&root).unwrap().filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "csv")).count();
        assert_eq!(csv_outputs, 1, "replay cannot write a second CSV");
        assert_eq!(std::fs::read(&other_temp).unwrap(), b"another task");
        assert_eq!(std::fs::read(&source).unwrap(), b"source unchanged");
    }
}
