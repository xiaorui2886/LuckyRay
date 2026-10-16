//! Local, main-window-only copies of ordinary catalog originals. No source
//! paths, arbitrary file reads, or task authority are exposed to Companion.
use super::{MaterialAsset, MaterialCatalog, MaterialFilter, MaterialFolder, MaterialQueryScope};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_ITEMS: usize = 500;
const MAX_FOLDERS: usize = 512;
const PAGE_SIZE: u32 = 128;
const MAX_PLANS: usize = 16;
const MAX_TASKS: usize = 16;
const MAX_RUNNING: usize = 2;
const PLAN_TTL: Duration = Duration::from_secs(600);
const COPY_CHUNK: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ExportPlanRequest {
    Assets { #[serde(rename = "assetIds")] asset_ids: Vec<String> },
    Folder { #[serde(rename = "folderId")] folder_id: Option<String> },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportPlanSummary {
    pub plan_id: String,
    pub total: usize,
    pub scope_label: String,
    pub includes_descendants: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportItemStatus {
    pub asset_id: String,
    pub name: String,
    pub state: String,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportTaskStatus {
    pub task_id: String,
    pub destination: String,
    pub preserve_hierarchy: bool,
    pub phase: String,
    pub total: usize,
    pub completed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub current_file: Option<String>,
    pub current_bytes: u64,
    pub current_total_bytes: u64,
    pub items: Vec<ExportItemStatus>,
}

#[derive(Clone)]
struct PlanItem {
    asset: MaterialAsset,
    relative_folder: Vec<String>,
    source_stamp: Option<FileStamp>,
}

struct PendingPlan {
    created: Instant,
    items: Vec<PlanItem>,
    library_id: String,
}

struct TaskControl {
    library_id:String,
    status: Mutex<ExportTaskStatus>,
    cancel: AtomicBool,
    #[cfg(test)]
    chunk_pause: Duration,
}

#[derive(Default)]
struct ExportState {
    plans: HashMap<String, PendingPlan>,
    tasks: HashMap<String, Arc<TaskControl>>,
}

#[derive(Default)]
pub(crate) struct ExportManager {
    state: Mutex<ExportState>,
    #[cfg(test)]
    chunk_pause: Mutex<Duration>,
}

static EXPORT_MANAGER: OnceLock<ExportManager> = OnceLock::new();

pub(crate) fn export_manager() -> &'static ExportManager {
    EXPORT_MANAGER.get_or_init(ExportManager::default)
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl ExportManager {
    pub(crate) fn plan(&self, catalog: &MaterialCatalog, request: ExportPlanRequest) -> Result<ExportPlanSummary, String> {
        let folders = catalog.list_folders().map_err(|error| error.message)?;
        let paths = folder_paths(&folders)?;
        let (assets, scope_label, includes_descendants) = match request {
            ExportPlanRequest::Assets { asset_ids } => {
                if asset_ids.is_empty() || asset_ids.len() > MAX_ITEMS {
                    return Err("请选择 1 到 500 个普通素材".into());
                }
                let mut ids = HashSet::new();
                let mut assets = Vec::new();
                for id in asset_ids {
                    if ids.insert(id.clone()) {
                        assets.push(catalog.get_ordinary_export_asset(&id)
                            .map_err(|error| error.message)?);
                    }
                }
                (assets, "选中素材".to_owned(), false)
            }
            ExportPlanRequest::Folder { folder_id } => {
                let selected = if let Some(id) = folder_id.as_deref() {
                    if !paths.contains_key(id) { return Err("所选分类已不存在".into()); }
                    Some(id)
                } else { None };
                let allowed = selected.map(|id| paths.iter()
                    .filter_map(|(folder_id, path)| {
                        let root = paths.get(id)?;
                        path.starts_with(root).then_some(folder_id.clone())
                    }).collect::<HashSet<_>>());
                let mut assets = Vec::new();
                let mut seen = HashSet::new();
                if let Some(folder_ids) = allowed {
                    let mut folder_ids = folder_ids.into_iter().collect::<Vec<_>>();
                    folder_ids.sort();
                    for id in folder_ids {
                        collect_folder_assets(catalog, Some(id), &mut assets, &mut seen)?;
                    }
                } else {
                    collect_folder_assets(catalog, None, &mut assets, &mut seen)?;
                }
                let label = selected.and_then(|id| folder_name(&folders, id))
                    .unwrap_or_else(|| "全部普通素材".into());
                (assets, label, true)
            }
        };
        if assets.is_empty() { return Err("该范围内没有普通素材可导出".into()); }
        let mut items = Vec::with_capacity(assets.len());
        for asset in assets {
            let relative_folder = asset.folder_id.as_deref()
                .and_then(|id| paths.get(id)).cloned().unwrap_or_default();
            let source_stamp = catalog.resolve_export_file(&asset).ok()
                .and_then(|path| File::open(path).ok())
                .and_then(|file| FileStamp::from_file(&file).ok());
            items.push(PlanItem { asset, relative_folder, source_stamp });
        }
        let plan_id = new_id();
        let total = items.len();
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        state.plans.retain(|_, plan| plan.created.elapsed() < PLAN_TTL);
        if state.plans.len() >= MAX_PLANS { return Err("待确认导出计划过多，请完成或取消已有计划".into()); }
        state.plans.insert(plan_id.clone(), PendingPlan { created: Instant::now(), items,library_id:catalog.library_scope_key().map_err(|e|e.message)? });
        Ok(ExportPlanSummary { plan_id, total, scope_label, includes_descendants })
    }

    pub(crate) fn discard_plan(&self, plan_id: &str) {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).plans.remove(plan_id);
    }

    pub(crate) fn start(&self, catalog: MaterialCatalog, plan_id: &str, destination: &str,
        preserve_hierarchy: bool, additional_protected: &[PathBuf]) -> Result<ExportTaskStatus, String> {
        let root = validate_destination(&catalog, Path::new(destination), additional_protected)?;
        let root_hold = DirectoryHold::new(&root)?;
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let pending = state.plans.get(plan_id).ok_or("导出计划已取消或过期，请重新选择")?;
        if pending.library_id!=catalog.library_scope_key().map_err(|e|e.message)? {return Err("导出计划属于另一个素材库".into());}
        if pending.created.elapsed() >= PLAN_TTL { state.plans.remove(plan_id); return Err("导出计划已过期，请重新选择".into()); }
        if state.tasks.values().filter(|task| {
            let phase = &task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).phase;
            matches!(phase.as_str(), "preparing" | "running" | "cancelling")
        }).count() >= MAX_RUNNING { return Err("已有两个导出任务在运行，请等待或取消其中一个".into()); }
        if state.tasks.len() >= MAX_TASKS {
            let finished = state.tasks.iter().find(|(_, task)| {
                let phase = &task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).phase;
                matches!(phase.as_str(), "completed" | "cancelled")
            }).map(|(id, _)| id.clone());
            if let Some(id) = finished { state.tasks.remove(&id); }
            else { return Err("导出任务摘要已满，请完成当前任务".into()); }
        }
        let plan = state.plans.remove(plan_id).expect("checked pending export plan");
        let task_id = new_id();
        let status = ExportTaskStatus {
            task_id: task_id.clone(), destination: root.to_string_lossy().into_owned(),
            preserve_hierarchy,
            phase: "preparing".into(), total: plan.items.len(), completed: 0, succeeded: 0,
            failed: 0, cancelled: 0, current_file: None, current_bytes: 0,
            current_total_bytes: 0, items: plan.items.iter().map(|item| ExportItemStatus {
                asset_id: item.asset.id.clone(), name: item.asset.name.clone(),
                state: "queued".into(), output_path: None, error: None,
            }).collect(),
        };
        let task = Arc::new(TaskControl {
            library_id:plan.library_id.clone(),
            status: Mutex::new(status.clone()), cancel: AtomicBool::new(false),
            #[cfg(test)]
            chunk_pause: *self.chunk_pause.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
        });
        state.tasks.insert(task_id.clone(), Arc::clone(&task));
        drop(state);
        let protected = additional_protected.to_vec();
        std::thread::spawn(move || run_task(catalog, root, root_hold, protected, preserve_hierarchy, plan.items, task));
        Ok(status)
    }

    pub(crate) fn list_scoped(&self,catalog:&MaterialCatalog)->Result<Vec<ExportTaskStatus>,String> {
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
    pub(crate) fn status(&self, task_id: &str) -> Result<ExportTaskStatus, String> {
        let task = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .tasks.get(task_id).cloned().ok_or("导出任务不存在或摘要已过期")?;
        let status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        Ok(status)
    }

    pub(crate) fn cancel(&self, task_id: &str) -> Result<ExportTaskStatus, String> {
        let task = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .tasks.get(task_id).cloned().ok_or("导出任务不存在或摘要已过期")?;
        task.cancel.store(true, Ordering::SeqCst);
        let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(status.phase.as_str(), "preparing" | "running") { status.phase = "cancelling".into(); }
        Ok(status.clone())
    }
}

fn collect_folder_assets(catalog: &MaterialCatalog, folder_id: Option<String>,
    assets: &mut Vec<MaterialAsset>, seen: &mut HashSet<String>) -> Result<(), String> {
    let filter = MaterialFilter { folder_id, limit: Some(PAGE_SIZE), ..Default::default() };
    let mut offset = 0u64;
    loop {
        let page = catalog.list_assets_page_scoped(&filter, &MaterialQueryScope::default(), offset)
            .map_err(|error| error.message)?;
        let count = page.len();
        for asset in page {
            if seen.insert(asset.id.clone()) { assets.push(asset); }
            if assets.len() > MAX_ITEMS { return Err("导出计划超过 500 个素材，请缩小选择范围".into()); }
        }
        if count < PAGE_SIZE as usize { return Ok(()); }
        offset += PAGE_SIZE as u64;
    }
}

fn folder_name(folders: &[MaterialFolder], id: &str) -> Option<String> {
    for folder in folders {
        if folder.id == id { return Some(folder.name.clone()); }
        if let Some(name) = folder_name(&folder.children, id) { return Some(name); }
    }
    None
}

fn folder_paths(folders: &[MaterialFolder]) -> Result<HashMap<String, Vec<String>>, String> {
    let mut paths = HashMap::new();
    let mut stack = vec![(folders, Vec::<String>::new(), 0usize)];
    while let Some((siblings, parent, depth)) = stack.pop() {
        if depth > 16 { return Err("素材分类层级过深，无法安全导出".into()); }
        let mut used = HashSet::new();
        let mut children = Vec::new();
        for folder in siblings {
            if paths.len() >= MAX_FOLDERS { return Err("素材分类过多，请缩小导出范围".into()); }
            let base = safe_component(&folder.name);
            let name = unique_component(&base, &mut used, false);
            let mut path = parent.clone();
            path.push(name);
            if paths.insert(folder.id.clone(), path.clone()).is_some() {
                return Err("素材分类 ID 重复，无法安全导出".into());
            }
            children.push((&folder.children[..], path, depth + 1));
        }
        stack.extend(children);
    }
    Ok(paths)
}

fn safe_component(raw: &str) -> String {
    safe_component_with_limit(raw, 140)
}

fn safe_component_with_limit(raw: &str, limit: usize) -> String {
    let replaced = raw.chars().map(|ch| match ch {
        '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
        ch if ch.is_control() => '_',
        ch => ch,
    }).collect::<String>();
    let trimmed = replaced.trim().trim_end_matches([' ', '.']);
    // Leave room for collision suffixes (` (10000)`) while keeping the
    // generated component within the same validation bound.
    let mut name = trimmed.chars().take(limit).collect::<String>();
    if name.is_empty() { name = "untitled".into(); }
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4 && base.as_bytes()[3].is_ascii_digit() && base.as_bytes()[3] != b'0');
    if reserved { format!("_{name}") } else { name }
}

// The catalog title is editable independently of the original file. Use it
// only as the output stem; the verified local source owns the file suffix.
fn safe_export_file_name(title: &str, source: &Path) -> Result<String, String> {
    let leaf = source.file_name().and_then(|name| name.to_str())
        .ok_or("原文件名无法安全用于导出")?;
    let Some(extension) = source.extension().and_then(|value| value.to_str())
        .filter(|value| !value.is_empty()) else {
        // A genuinely extensionless original must not acquire a misleading
        // extension from a display title such as "reference.jpg".
        return Ok(safe_component(leaf));
    };
    let suffix = format!(".{extension}");
    let suffix_chars = suffix.chars().count();
    if suffix_chars > 120 { return Err("原文件扩展名过长，无法安全导出".into()); }
    let stem = title.rfind('.').filter(|position| *position > 0)
        .filter(|position| title[position + 1..].to_lowercase() == extension.to_lowercase())
        .map(|position| &title[..position]).unwrap_or(title);
    // Reserve room for the real suffix, a reserved-name prefix, and (10000)
    // collision numbering. Truncation may shorten the title, never the type.
    let safe_stem = safe_component_with_limit(stem, 140 - suffix_chars - 9);
    Ok(format!("{safe_stem}{suffix}"))
}

fn unique_component(base: &str, used: &mut HashSet<String>, file: bool) -> String {
    for index in 1..=10_000 {
        let candidate = if index == 1 { base.to_owned() } else if file {
            let (stem, extension) = base.rfind('.').filter(|position| *position > 0)
                .map(|position| (&base[..position], &base[position..])).unwrap_or((base, ""));
            format!("{stem} ({index}){extension}")
        } else { format!("{base} ({index})") };
        if used.insert(candidate.to_lowercase()) { return candidate; }
    }
    format!("{base}-{}", new_id())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    identity: String,
}

impl FileStamp {
    fn from_file(file: &File) -> std::io::Result<Self> {
        let metadata = file.metadata()?;
        let identity = super::catalog::export_file_identity(file)
            .map_err(|error| std::io::Error::other(error.message))?;
        Ok(Self { len: metadata.len(), modified: metadata.modified().ok(), identity })
    }
}

fn reject_reparse_path(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    let mut seen_root = false;
    for component in path.components() {
        if matches!(component, std::path::Component::RootDir) { seen_root = true; }
        current.push(component.as_os_str());
        // On Windows a verbatim canonical path first yields a drive *prefix*
        // (e.g. `\\?\D:`) before its root separator. The prefix alone is not
        // a filesystem entry and symlink_metadata reports ERROR_INVALID_FUNCTION.
        if !seen_root { continue; }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x0400 != 0
                };
                #[cfg(not(windows))]
                let reparse = metadata.file_type().is_symlink();
                if reparse { return Err("输出路径包含符号链接或重解析点".into()); }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("无法验证输出目录: {error}")),
        }
    }
    Ok(())
}

pub(super) fn validate_destination(catalog: &MaterialCatalog, destination: &Path,
    additional_protected: &[PathBuf]) -> Result<PathBuf, String> {
    if !destination.is_absolute() { return Err("请选择绝对路径的本地输出文件夹".into()); }
    reject_reparse_path(destination)?;
    let root = destination.canonicalize().map_err(|error| format!("无法访问输出文件夹: {error}"))?;
    if !root.is_dir() { return Err("输出目标不是文件夹".into()); }
    reject_protected_output_path(catalog, &root, additional_protected)?;
    Ok(root)
}

fn output_is_at_or_below(path: &Path, protected: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = path.components().map(|part| part.as_os_str().to_string_lossy().to_lowercase()).collect::<Vec<_>>();
        let protected = protected.components().map(|part| part.as_os_str().to_string_lossy().to_lowercase()).collect::<Vec<_>>();
        protected.len() <= path.len() && protected.iter().zip(path.iter()).all(|(a, b)| a == b)
    }
    #[cfg(not(windows))]
    { path.starts_with(protected) }
}

fn reject_protected_output_path(catalog: &MaterialCatalog, candidate: &Path,
    additional_protected: &[PathBuf]) -> Result<(), String> {
    let protected = catalog.export_protected_roots().into_iter()
        .chain(additional_protected.iter().cloned());
    for path in protected {
        if let Some(path) = canonicalize_protected_prefix(&path) {
            if output_is_at_or_below(candidate, &path) {
                return Err("不能把素材导出到应用数据、受管库或监控目录".into());
            }
        }
    }
    Ok(())
}

fn canonicalize_protected_prefix(path: &Path) -> Option<PathBuf> {
    let mut ancestor = path;
    let mut missing = Vec::new();
    while !ancestor.exists() {
        missing.push(ancestor.file_name()?.to_os_string());
        ancestor = ancestor.parent()?;
    }
    let mut canonical = ancestor.canonicalize().ok()?;
    for segment in missing.into_iter().rev() { canonical.push(segment); }
    Some(canonical)
}

// The picker chooses a path, but all writes must remain bound to that same
// directory tree while a task runs. On Windows these handles deny FILE_SHARE_DELETE,
// so the selected root (and its ancestors) cannot be renamed/replaced with a
// junction between validation, temp creation, and the no-replace commit.
pub(super) struct DirectoryHold { handles: Vec<File>, path: PathBuf, identity: String }

#[cfg(windows)]
fn open_directory_no_delete(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new().read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_directory_no_delete(path: &Path) -> std::io::Result<File> { File::open(path) }

impl DirectoryHold {
    pub(super) fn new(path: &Path) -> Result<Self, String> {
        reject_reparse_path(path)?;
        let canonical = path.canonicalize().map_err(|error| format!("验证输出目录失败: {error}"))?;
        if canonical != path { return Err("输出目录在确认后发生变化".into()); }
        let mut current = PathBuf::new();
        let mut handles = Vec::new();
        let mut seen_root = false;
        for component in path.components() {
            if matches!(component, std::path::Component::RootDir) { seen_root = true; }
            current.push(component.as_os_str());
            if !seen_root { continue; }
            let handle = open_directory_no_delete(&current)
                .map_err(|error| format!("锁定导出目录失败: {error}"))?;
            if !handle.metadata().is_ok_and(|metadata| metadata.is_dir()) {
                return Err("输出目录链包含非文件夹对象".into());
            }
            handles.push(handle);
        }
        let leaf = handles.last().ok_or("输出目录无效")?;
        let identity = super::catalog::export_file_identity(leaf)
            .map_err(|error| error.message)?;
        let hold = Self { handles, path: path.to_path_buf(), identity };
        hold.verify()?;
        Ok(hold)
    }

    pub(super) fn verify(&self) -> Result<(), String> {
        reject_reparse_path(&self.path)?;
        if self.path.canonicalize().ok().as_deref() != Some(self.path.as_path()) {
            return Err("输出目录在导出期间发生变化".into());
        }
        let current = open_directory_no_delete(&self.path)
            .map_err(|error| format!("复核输出目录失败: {error}"))?;
        let identity = super::catalog::export_file_identity(&current)
            .map_err(|error| error.message)?;
        if identity != self.identity { return Err("输出目录身份在导出期间发生变化".into()); }
        Ok(())
    }
}

fn ensure_output_dir(root: &Path, relative: &[String]) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for segment in relative {
        if safe_component_with_limit(segment, 150) != *segment || segment == "." || segment == ".." {
            return Err("导出分类路径无效".into());
        }
        current.push(segment);
        match std::fs::create_dir(&current) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(error) => return Err(format!("创建导出分类失败: {error}")),
        }
        reject_reparse_path(&current)?;
        let canonical = current.canonicalize().map_err(|error| format!("验证导出分类失败: {error}"))?;
        if !canonical.is_dir() || !canonical.starts_with(root) {
            return Err("导出分类越过所选输出目录".into());
        }
        current = canonical;
    }
    Ok(current)
}

struct TempOutput { path: PathBuf, stamp: FileStamp, committed: bool }
impl Drop for TempOutput {
    fn drop(&mut self) {
        if self.committed { return; }
        if let Ok(file) = File::open(&self.path) {
            if FileStamp::from_file(&file).is_ok_and(|current|
                current.identity == self.stamp.identity) {
                drop(file);
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

#[cfg(windows)]
pub(super) fn move_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32; }
    let from = from.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let to = to.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    // No MOVEFILE_REPLACE_EXISTING. Temp and target share one directory/volume.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        Err(std::io::Error::last_os_error())
    } else { Ok(()) }
}

#[cfg(not(windows))]
pub(super) fn move_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::hard_link(from, to)?;
    std::fs::remove_file(from)
}

enum CopyResult { Success(PathBuf), Cancelled, Failure(String) }

fn copy_one(catalog: &MaterialCatalog, root: &Path, protected: &[PathBuf],
    root_hold: &DirectoryHold, task: &TaskControl, task_id: &str, index: usize, item: &PlanItem,
    preserve_hierarchy: bool) -> CopyResult {
    let work = || -> Result<PathBuf, String> {
        if task.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        root_hold.verify()?;
        if validate_destination(catalog, root, protected)? != root { return Err("输出目录已改变".into()); }
        let current = catalog.get_ordinary_export_asset(&item.asset.id)
            .map_err(|error| error.message)?;
        if current.storage_mode != item.asset.storage_mode
            || current.original_path != item.asset.original_path
            || current.library_path != item.asset.library_path
            || current.name != item.asset.name
            || current.folder_id != item.asset.folder_id
            || current.content_hash != item.asset.content_hash {
            return Err("素材记录或原文件绑定在计划后发生变化，请重试失败项".into());
        }
        let source = catalog.resolve_export_file(&current).map_err(|error| error.message)?;
        let mut input = File::open(&source).map_err(|error| format!("打开原文件失败: {error}"))?;
        let before = FileStamp::from_file(&input).map_err(|error| format!("检查原文件失败: {error}"))?;
        if item.source_stamp.as_ref().is_some_and(|stamp| stamp != &before) {
            return Err("原文件在计划后发生变化，请重试失败项".into());
        }
        let relative = if preserve_hierarchy { &item.relative_folder[..] } else { &[] };
        let intended = relative.iter().fold(root.to_path_buf(), |path, segment| path.join(segment));
        // Check the generated path *before* creating any classification folder;
        // a safe picker root can still contain an enabled watch/managed subtree.
        reject_protected_output_path(catalog, &intended, protected)?;
        let directory = ensure_output_dir(root, relative)?;
        reject_protected_output_path(catalog, &directory, protected)?;
        let directory_hold = DirectoryHold::new(&directory)?;
        root_hold.verify()?;
        let name = safe_export_file_name(&current.name, &source)?;
        let temp_path = directory.join(format!(".luckyray-export-{task_id}-{index}.partial"));
        let mut output = OpenOptions::new().write(true).create_new(true).open(&temp_path)
            .map_err(|error| format!("创建任务临时文件失败: {error}"))?;
        let stamp = FileStamp::from_file(&output).map_err(|error| format!("验证临时文件失败: {error}"))?;
        let mut temp = TempOutput { path: temp_path, stamp, committed: false };
        {
            let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            status.current_total_bytes = before.len;
            status.current_bytes = 0;
        }
        let mut hash = Sha256::new();
        let mut copied = 0u64;
        let mut buffer = vec![0u8; COPY_CHUNK];
        loop {
            if task.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
            let read = input.read(&mut buffer).map_err(|error| format!("读取原文件失败: {error}"))?;
            if read == 0 { break; }
            output.write_all(&buffer[..read]).map_err(|error| format!("写入导出文件失败: {error}"))?;
            hash.update(&buffer[..read]);
            copied += read as u64;
            task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current_bytes = copied;
            #[cfg(test)]
            std::thread::sleep(task.chunk_pause);
        }
        output.sync_all().map_err(|error| format!("提交导出文件失败: {error}"))?;
        drop(output);
        let after = FileStamp::from_file(&input).map_err(|error| format!("复核原文件失败: {error}"))?;
        let path_after = File::open(&source).ok().and_then(|file| FileStamp::from_file(&file).ok());
        if copied != before.len || before != after || path_after.as_ref() != Some(&before) {
            return Err("原文件在复制时发生替换或截断，未交付部分输出".into());
        }
        // Linked/source files are user-owned and may have been edited before
        // planning; their plan-time stamp and during-copy identity are the
        // freshness authority. Managed bytes remain bound to catalog hash.
        if current.storage_mode == "managed" && current.content_hash.as_deref().is_some_and(|expected|
            expected.len() == 64 && !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(expected)) {
            return Err("原文件内容与素材记录不一致，未交付部分输出".into());
        }
        if task.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        root_hold.verify()?;
        directory_hold.verify()?;
        let mut used = HashSet::new();
        for _ in 0..10_000 {
            let candidate_name = unique_component(&name, &mut used, true);
            let candidate = directory.join(candidate_name);
            if candidate.exists() { continue; }
            match move_no_replace(&temp.path, &candidate) {
                Ok(()) => {
                    temp.committed = true;
                    return Ok(candidate);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("完成导出文件失败: {error}")),
            }
        }
        Err("目标位置同名文件过多，请选择其他位置".into())
    };
    match work() {
        Ok(path) => CopyResult::Success(path),
        Err(error) if error == "cancelled" => CopyResult::Cancelled,
        Err(error) => CopyResult::Failure(error),
    }
}

fn run_task(catalog: MaterialCatalog, root: PathBuf, root_hold: DirectoryHold, protected: Vec<PathBuf>,
    preserve_hierarchy: bool, items: Vec<PlanItem>, task: Arc<TaskControl>) {
    let task_id = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).task_id.clone();
    for (index, item) in items.iter().enumerate() {
        if task.cancel.load(Ordering::SeqCst) {
            let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            status.items[index].state = "cancelled".into();
            status.cancelled += 1;
            status.completed += 1;
            continue;
        }
        {
            let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            status.phase = "running".into();
            status.current_file = Some(item.asset.name.clone());
            status.current_bytes = 0;
            status.current_total_bytes = 0;
            status.items[index].state = "running".into();
        }
        let result = copy_one(&catalog, &root, &protected, &root_hold, &task, &task_id, index, item, preserve_hierarchy);
        let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match result {
            CopyResult::Success(path) => {
                status.items[index].state = "succeeded".into();
                status.items[index].output_path = Some(path.to_string_lossy().into_owned());
                status.succeeded += 1;
            }
            CopyResult::Cancelled => {
                status.items[index].state = "cancelled".into();
                status.cancelled += 1;
            }
            CopyResult::Failure(error) => {
                status.items[index].state = "failed".into();
                status.items[index].error = Some(error);
                status.failed += 1;
            }
        }
        status.completed += 1;
    }
    let mut status = task.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    status.current_file = None;
    status.current_bytes = 0;
    status.current_total_bytes = 0;
    status.phase = if task.cancel.load(Ordering::SeqCst) { "cancelled" } else { "completed" }.into();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::materials::{MaterialAssetPatch, MaterialBytesInput, MaterialFolderInput, MaterialImportOptions};

    fn fixture() -> (tempfile::TempDir, MaterialCatalog, ExportManager, PathBuf) {
        let base = std::env::var_os("LUCKYRAY_TEST_TEMP_ROOT")
            .map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&base).unwrap();
        let root = tempfile::Builder::new().prefix("material-export-r1-").tempdir_in(base).unwrap();
        let catalog = MaterialCatalog::new_for_test_at(root.path().join("app"));
        let output = root.path().join("output");
        std::fs::create_dir(&output).unwrap();
        (root, catalog, ExportManager::default(), output)
    }

    fn managed(catalog: &MaterialCatalog, name: &str, bytes: &[u8]) -> MaterialAsset {
        catalog.import_bytes(vec![MaterialBytesInput {
            name: name.into(), original_path: format!("https://cdn.test/{name}"),
            mime_type: "image/png".into(), description: None, bytes: bytes.to_vec(),
        }], &MaterialImportOptions::default()).unwrap().value.assets.remove(0)
    }

    fn completed(manager: &ExportManager, id: &str) -> ExportTaskStatus {
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            let status = manager.status(id).unwrap();
            if matches!(status.phase.as_str(), "completed" | "cancelled") { return status; }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("export task did not finish: {id}");
    }

    #[test]
    fn release_runtime_protected_targets_reject_original_export_but_allow_user_output() {
        let (root, catalog, manager, output) = fixture();
        let asset = managed(&catalog, "protected.png", b"original-must-stay-unchanged");
        let source = catalog.resolve_export_file(&asset).unwrap();
        let protected = ["app-data", "config", "cache", "resource", "exe", "watch"]
            .map(|name| root.path().join(name));
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets {
            asset_ids: vec![asset.id.clone()],
        }).unwrap();
        for directory in &protected {
            let target = directory.join("nested");
            std::fs::create_dir_all(&target).unwrap();
            assert!(manager.start(catalog.clone(), &plan.plan_id,
                target.to_str().unwrap(), false, &protected).is_err());
            assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        }
        let task = manager.start(catalog.clone(), &plan.plan_id,
            output.to_str().unwrap(), false, &protected).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!((result.succeeded, result.failed), (1, 0), "{result:?}");
        assert_eq!(std::fs::read(result.items[0].output_path.as_ref().unwrap()).unwrap(),
            b"original-must-stay-unchanged");
        assert_eq!(std::fs::read(source).unwrap(), b"original-must-stay-unchanged");
        assert_eq!(catalog.get_ordinary_export_asset(&asset.id).unwrap(), asset);
    }

    #[test]
    fn managed_original_single_dedupes_id_and_never_overwrites_existing_output() {
        let (_root, catalog, manager, output) = fixture();
        let asset = managed(&catalog, "海边.png", b"original-managed-bytes");
        let source = catalog.resolve_export_file(&asset).unwrap();
        let before = std::fs::read(&source).unwrap();
        std::fs::write(output.join("海边.png"), b"user-existing").unwrap();
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets {
            asset_ids: vec![asset.id.clone(), asset.id.clone()],
        }).unwrap();
        assert_eq!(plan.total, 1);
        let task = manager.start(catalog.clone(), &plan.plan_id, output.to_str().unwrap(), false, &[]).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!((result.succeeded, result.failed, result.cancelled), (1, 0, 0), "{result:?}");
        assert_eq!(std::fs::read(output.join("海边.png")).unwrap(), b"user-existing");
        let actual = result.items[0].output_path.as_ref().unwrap();
        assert_ne!(Path::new(actual), output.join("海边.png"));
        assert_eq!(std::fs::read(actual).unwrap(), before);
        assert_eq!(std::fs::read(source).unwrap(), before);
        assert_eq!(catalog.get_ordinary_export_asset(&asset.id).unwrap(), asset);
    }

    #[test]
    fn edited_title_keeps_verified_original_suffix_without_changing_source_or_catalog() {
        let (_root, catalog, manager, output) = fixture();
        let imported = managed(&catalog, "scene.PNG", b"unchanged-png-bytes");
        let asset = catalog.update_asset(&imported.id, MaterialAssetPatch {
            name: Some("海边参考".into()), ..Default::default()
        }, "test-title-only").unwrap().value.unwrap();
        let source = catalog.resolve_export_file(&asset).unwrap();
        let verified_suffix = source.extension().unwrap().to_str().unwrap();
        let original = std::fs::read(&source).unwrap();
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets {
            asset_ids: vec![asset.id.clone()],
        }).unwrap();
        let started = manager.start(catalog.clone(), &plan.plan_id,
            output.to_str().unwrap(), false, &[]).unwrap();
        let result = completed(&manager, &started.task_id);
        assert_eq!((result.succeeded, result.failed), (1, 0), "{result:?}");
        assert_eq!(Path::new(result.items[0].output_path.as_deref().unwrap())
            .file_name().unwrap().to_string_lossy(), format!("海边参考.{verified_suffix}"));
        assert_eq!(std::fs::read(result.items[0].output_path.as_ref().unwrap()).unwrap(), original);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(catalog.get_ordinary_export_asset(&asset.id).unwrap(), asset);
        assert_eq!(safe_export_file_name("draft.jpg", &source).unwrap(),
            format!("draft.jpg.{verified_suffix}"));
        assert_eq!(safe_export_file_name("draft.png", &source).unwrap(),
            format!("draft.{verified_suffix}"));
    }

    #[test]
    fn long_original_stem_and_collision_preserve_real_suffix_before_numbering() {
        let (root, catalog, manager, output) = fixture();
        let source = root.path().join(format!("{}.mp4", "v".repeat(140)));
        let bytes = b"unchanged-video-bytes";
        std::fs::write(&source, bytes).unwrap();
        let id = "long-video";
        rusqlite::Connection::open(root.path().join("app").join("luckyray.db")).unwrap().execute(
            "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,
                size_bytes,thumbnail_url,description,imported_at,updated_at)
             VALUES(?1,?2,?3,NULL,'linked','video','video/mp4',21,'','',
                '2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')",
            rusqlite::params![id, source.file_name().unwrap().to_str().unwrap(), source.to_str().unwrap()],
        ).unwrap();
        let asset = catalog.get_ordinary_export_asset(id).unwrap();
        let base = safe_export_file_name(&asset.name, &source).unwrap();
        assert!(base.ends_with(".mp4"));
        assert!(base.chars().count() <= 140);
        std::fs::write(output.join(&base), b"preexisting-user-file").unwrap();
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets {
            asset_ids: vec![id.into()],
        }).unwrap();
        let started = manager.start(catalog.clone(), &plan.plan_id,
            output.to_str().unwrap(), false, &[]).unwrap();
        let result = completed(&manager, &started.task_id);
        assert_eq!((result.succeeded, result.failed), (1, 0), "{result:?}");
        let actual = Path::new(result.items[0].output_path.as_deref().unwrap());
        assert_eq!(actual.file_name().unwrap().to_string_lossy(),
            format!("{} (2).mp4", &base[..base.len() - 4]));
        assert!(actual.file_name().unwrap().to_string_lossy().chars().count() <= 140);
        assert_eq!(std::fs::read(actual).unwrap(), bytes);
        assert_eq!(std::fs::read(output.join(base)).unwrap(), b"preexisting-user-file");
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        assert_eq!(catalog.get_ordinary_export_asset(id).unwrap(), asset);
        let extensionless = root.path().join("raw-original");
        assert_eq!(safe_export_file_name("fake.jpg", &extensionless).unwrap(), "raw-original");
    }

    #[test]
    fn nested_folder_plan_reads_beyond_first_page_and_flatten_is_deterministic() {
        let (root, catalog, manager, output) = fixture();
        let parent = catalog.create_folder(MaterialFolderInput { parent_id: None, name: "图像".into() })
            .unwrap().value;
        let child = catalog.create_folder(MaterialFolderInput {
            parent_id: Some(parent.id.clone()), name: "子类".into(),
        }).unwrap().value;
        let source_root = root.path().join("source");
        std::fs::create_dir(&source_root).unwrap();
        let db = root.path().join("app").join("luckyray.db");
        let connection = rusqlite::Connection::open(db).unwrap();
        for index in 0..130 {
            let source = source_root.join(format!("{index}.txt"));
            std::fs::write(&source, format!("original-{index}")).unwrap();
            connection.execute(
                "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,
                    size_bytes,thumbnail_url,description,folder_id,imported_at,updated_at)
                 VALUES(?1,?2,?3,NULL,'linked','document','text/plain',8,'','',?4,
                    '2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')",
                rusqlite::params![format!("asset-{index}"), format!("{index}.txt"),
                    source.to_str().unwrap(), child.id],
            ).unwrap();
        }
        let plan = manager.plan(&catalog, ExportPlanRequest::Folder {
            folder_id: Some(parent.id.clone()),
        }).unwrap();
        assert_eq!(plan.total, 130);
        let task = manager.start(catalog.clone(), &plan.plan_id, output.to_str().unwrap(), true, &[]).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!(result.succeeded, 130, "{result:?}");
        assert_eq!(std::fs::read(output.join("图像").join("子类").join("129.txt")).unwrap(), b"original-129");
        let flat_plan = manager.plan(&catalog, ExportPlanRequest::Folder {
            folder_id: Some(parent.id),
        }).unwrap();
        let flat_task = manager.start(catalog, &flat_plan.plan_id, output.to_str().unwrap(), false, &[]).unwrap();
        let flat_result = completed(&manager, &flat_task.task_id);
        assert_eq!(flat_result.succeeded, 130);
        assert_eq!(std::fs::read(output.join("129.txt")).unwrap(), b"original-129");
    }

    #[test]
    fn missing_source_partially_fails_and_retry_only_copies_failed_id() {
        let (_root, catalog, manager, output) = fixture();
        let first = managed(&catalog, "first.png", b"first");
        let second = managed(&catalog, "second.png", b"second");
        let source = catalog.resolve_export_file(&second).unwrap();
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets {
            asset_ids: vec![first.id.clone(), second.id.clone()],
        }).unwrap();
        std::fs::remove_file(&source).unwrap();
        let task = manager.start(catalog.clone(), &plan.plan_id, output.to_str().unwrap(), false, &[]).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!((result.succeeded, result.failed), (1, 1), "{result:?}");
        assert_eq!(result.items.iter().find(|item| item.asset_id == second.id).unwrap().state, "failed");
        assert!(output.join("first.png").is_file());
        std::fs::write(&source, b"second").unwrap();
        let retry = manager.plan(&catalog, ExportPlanRequest::Assets { asset_ids: vec![second.id] }).unwrap();
        let task = manager.start(catalog, &retry.plan_id, output.to_str().unwrap(), false, &[]).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!(result.succeeded, 1);
        assert_eq!(std::fs::read(output.join("first.png")).unwrap(), b"first");
        assert_eq!(std::fs::read(output.join("second.png")).unwrap(), b"second");
    }

    #[test]
    fn cancellation_interrupts_real_stream_and_keeps_only_prior_successes() {
        let (root, catalog, manager, output) = fixture();
        *manager.chunk_pause.lock().unwrap() = Duration::from_millis(5);
        let source_root = root.path().join("source");
        std::fs::create_dir(&source_root).unwrap();
        let large_source = source_root.join("large.bin");
        let file = File::create(&large_source).unwrap();
        file.set_len(96 * 1024 * 1024).unwrap();
        drop(file);
        let db = root.path().join("app").join("luckyray.db");
        let connection = rusqlite::Connection::open(db).unwrap();
        connection.execute(
            "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,
                size_bytes,thumbnail_url,description,imported_at,updated_at)
             VALUES('large','large.bin',?1,NULL,'linked','other','application/octet-stream',
                100663296,'','','2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')",
            [large_source.to_str().unwrap()],
        ).unwrap();
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets { asset_ids: vec!["large".into()] }).unwrap();
        let task = manager.start(catalog, &plan.plan_id, output.to_str().unwrap(), false, &[]).unwrap();
        for _ in 0..500 {
            if manager.status(&task.task_id).unwrap().current_bytes > 0 { break; }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(manager.status(&task.task_id).unwrap().current_bytes > 0,
            "{:?}", manager.status(&task.task_id).unwrap());
        #[cfg(windows)]
        assert!(std::fs::rename(&output, root.path().join("swapped-output")).is_err(),
            "active copy allowed its selected output root to be replaced");
        manager.cancel(&task.task_id).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!((result.succeeded, result.cancelled), (0, 1));
        assert!(!output.join("large.bin").exists());
        assert_eq!(std::fs::read_dir(&output).unwrap().count(), 0, "task-owned partial remained");
        assert_eq!(std::fs::metadata(&large_source).unwrap().len(), 96 * 1024 * 1024);
    }

    #[test]
    fn sanitizes_reserved_and_colliding_names_and_rejects_output_escape() {
        assert_eq!(safe_component("CON.txt"), "_CON.txt");
        assert_eq!(safe_component("a/b\\c?.png"), "a_b_c_.png");
        let mut used = HashSet::new();
        assert_eq!(unique_component("A.png", &mut used, true), "A.png");
        assert_eq!(unique_component("a.png", &mut used, true), "a (2).png");
        let (_root, catalog, _manager, output) = fixture();
        assert!(ensure_output_dir(&output, &["..".into()]).is_err());
        assert!(validate_destination(&catalog, &output.join("missing"), &[]).is_err());
        assert!(validate_destination(&catalog, &output, &[output.clone()]).is_err());
        let pending = output.join("pending.partial");
        let occupied = output.join("occupied.txt");
        std::fs::write(&pending, b"new-bytes").unwrap();
        std::fs::write(&occupied, b"existing-bytes").unwrap();
        assert!(move_no_replace(&pending, &occupied).is_err());
        assert_eq!(std::fs::read(&occupied).unwrap(), b"existing-bytes");
        assert_eq!(std::fs::read(&pending).unwrap(), b"new-bytes");
    }

    #[test]
    fn collision_mapping_keeps_distinct_categories_and_long_components_valid() {
        let folder = |id: &str, name: &str| MaterialFolder {
            id: id.into(), scope: "materials".into(), parent_id: None, name: name.into(),
            sort_order: 0, open: true, created_at: String::new(), updated_at: String::new(),
            children: Vec::new(),
        };
        let long = "中文".repeat(90);
        let paths = folder_paths(&[
            folder("one", "A:B"), folder("two", "A?B"),
            folder("three", &long), folder("four", &long),
        ]).unwrap();
        assert_eq!(paths["one"], vec!["A_B"]);
        assert_eq!(paths["two"], vec!["A_B (2)"]);
        assert_ne!(paths["three"], paths["four"]);
        let (_root, _catalog, _manager, output) = fixture();
        let output = output.canonicalize().unwrap();
        for id in ["one", "two", "three", "four"] {
            assert!(ensure_output_dir(&output, &paths[id]).unwrap().is_dir());
        }
    }

    #[test]
    fn linked_source_changes_after_plan_are_reported_without_output() {
        let (root, catalog, manager, output) = fixture();
        let source = root.path().join("linked.txt");
        std::fs::write(&source, b"before").unwrap();
        let db = root.path().join("app").join("luckyray.db");
        rusqlite::Connection::open(db).unwrap().execute(
            "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,
                size_bytes,thumbnail_url,description,imported_at,updated_at)
             VALUES('linked','linked.txt',?1,NULL,'linked','document','text/plain',6,'','',
                '2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')",
            [source.to_str().unwrap()],
        ).unwrap();
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets {
            asset_ids: vec!["linked".into()],
        }).unwrap();
        std::fs::write(&source, b"changed-source").unwrap();
        let task = manager.start(catalog, &plan.plan_id, output.to_str().unwrap(), false, &[]).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!((result.succeeded, result.failed), (0, 1), "{result:?}");
        assert!(!output.join("linked.txt").exists());
        assert_eq!(std::fs::read(source).unwrap(), b"changed-source");
    }

    #[test]
    fn linked_source_allows_selected_child_directory_but_blocks_enabled_watch_root() {
        let (root, catalog, manager, _output) = fixture();
        let downloads = root.path().join("Downloads");
        let output = downloads.join("Export");
        std::fs::create_dir_all(&output).unwrap();
        let source = downloads.join("linked.txt");
        std::fs::write(&source, b"linked-original").unwrap();
        let db = root.path().join("app").join("luckyray.db");
        rusqlite::Connection::open(db).unwrap().execute(
            "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,
                size_bytes,thumbnail_url,description,content_hash,imported_at,updated_at)
             VALUES('linked','linked.txt',?1,NULL,'linked','document','text/plain',15,'','',?2,
                '2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')",
            rusqlite::params![source.to_str().unwrap(), format!("{:x}", Sha256::digest(b"older-linked-bytes"))],
        ).unwrap();
        std::fs::hard_link(&source, output.join("linked.txt")).unwrap();
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets {
            asset_ids: vec!["linked".into()],
        }).unwrap();
        let task = manager.start(catalog.clone(), &plan.plan_id,
            output.to_str().unwrap(), false, &[]).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!((result.succeeded, result.failed), (1, 0), "{result:?}");
        let actual = Path::new(result.items[0].output_path.as_deref().unwrap());
        assert_eq!(actual.file_name().unwrap(), "linked (2).txt");
        assert_eq!(std::fs::read(actual).unwrap(), b"linked-original");
        assert_eq!(std::fs::read(&source).unwrap(), b"linked-original");
        assert_eq!(std::fs::read(output.join("linked.txt")).unwrap(), b"linked-original");
        let plan = manager.plan(&catalog, ExportPlanRequest::Assets {
            asset_ids: vec!["linked".into()],
        }).unwrap();
        assert!(manager.start(catalog, &plan.plan_id, output.to_str().unwrap(), false,
            &[downloads]).is_err(), "enabled monitor root must not receive export copies");
    }

    #[test]
    fn preserved_category_cannot_enter_protected_child_of_selected_root() {
        let (root, catalog, manager, output) = fixture();
        let folder = catalog.create_folder(MaterialFolderInput {
            parent_id: None, name: "Art".into(),
        }).unwrap().value;
        let watch_root = output.join("Art");
        std::fs::create_dir(&watch_root).unwrap();
        let not_yet_present_watch = output.join("FutureWatch");
        let canonical_output = output.canonicalize().unwrap();
        assert!(reject_protected_output_path(&catalog,
            &canonical_output.join("FutureWatch"), &[not_yet_present_watch.clone()]).is_err());
        assert!(!not_yet_present_watch.exists(), "precheck created a watch directory");
        let source = root.path().join("source.txt");
        std::fs::write(&source, b"original").unwrap();
        rusqlite::Connection::open(root.path().join("app").join("luckyray.db")).unwrap().execute(
            "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,
                size_bytes,thumbnail_url,description,folder_id,imported_at,updated_at)
             VALUES('protected-child','source.txt',?1,NULL,'linked','document','text/plain',8,
                '','',?2,'2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')",
            rusqlite::params![source.to_str().unwrap(), folder.id],
        ).unwrap();
        let plan = manager.plan(&catalog, ExportPlanRequest::Folder {
            folder_id: Some(folder.id),
        }).unwrap();
        let task = manager.start(catalog, &plan.plan_id, output.to_str().unwrap(), true,
            &[watch_root.clone()]).unwrap();
        let result = completed(&manager, &task.task_id);
        assert_eq!((result.succeeded, result.failed), (0, 1), "{result:?}");
        assert_eq!(std::fs::read_dir(&watch_root).unwrap().count(), 0);
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn held_output_directory_cannot_be_renamed_or_replaced_during_copy() {
        let (root, _catalog, _manager, output) = fixture();
        let canonical = output.canonicalize().unwrap();
        let hold = DirectoryHold::new(&canonical).unwrap();
        let replacement = root.path().join("moved-output");
        assert!(std::fs::rename(&output, &replacement).is_err(),
            "a directory with an export lease was renamed");
        hold.verify().unwrap();
        drop(hold);
        std::fs::rename(&output, &replacement).unwrap();
    }
}
