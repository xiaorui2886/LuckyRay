#[path = "note_attachments.rs"]
mod note_attachments;
use note_attachments::{scope_condition, ensure_note_attachment_schema, protect_note_attachment};

pub(super) fn export_file_identity(file: &std::fs::File) -> MaterialResult<String> {
    note_attachments::file_identity(file)
}
use super::{MaterialQueryScope, NoteAttachmentRefInput, NoteAttachmentDetails, NoteAttachmentReference, NoteAttachmentMoveCandidate};
use super::csv_export::{CsvExportPlanRequest, CsvRow, CsvSnapshot};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};

use super::{
    CatalogOutcome, MaterialAsset, MaterialAssetPatch, MaterialAssetSearchHit,
    MaterialAssetTagNames, MaterialBytesInput, MaterialChange, MaterialDeleteResult, MaterialError,
    MaterialFilter, MaterialFolder, MaterialFolderInput, MaterialFolderMove, MaterialImportError,
    MaterialImportOptions, MaterialImportResult, MaterialLibraryMigrationError,
    MaterialLibraryMigrationResult, MaterialRelocateOptions, MaterialResult,
    MaterialSourcePage, MaterialSourcePageInput, MaterialStagedFileInput, MaterialTag,
    MaterialTagMergeResult, MaterialTagPatch,
    MissingMaterialAsset, PatchValue, PendingDeletionCleanupResult, RemoveMaterialResult,
};

#[derive(Clone)]
pub(crate) struct MaterialCatalog {
    pub(super) db_path: PathBuf,
    pub(super) app_data_dir: PathBuf,
    pub(super) library_id: Option<String>,
    pub(super) attachment_projection: bool,
    #[cfg(test)]
    delete_fault: Option<DeleteTestFault>,
    #[cfg(test)]
    import_barrier: Option<std::sync::Arc<std::sync::Barrier>>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeleteTestFault {
    QuarantineRename,
    Purge,
}

const PENDING_DELETION_VERSION: u32 = 2;
const MANAGED_ROOT_VERSION: u32 = 1;
const MAX_EXTERNAL_DRAG_ASSETS: usize = 64;
const MAX_TARGETED_ASSET_READS: usize = 64;

/// Classify only the existing origin's *type*. Never copy its raw path/CDN URL
/// into CSV. This mirrors materialSourceInfo in the Desktop detail UI.
fn csv_source_type(origin: &str, safe_page_kind: Option<&str>) -> &'static str {
    match safe_page_kind {
        Some("work-page") => return "作品页",
        Some("capture-page") => return "采集页",
        _ => {}
    }
    if origin.chars().any(|ch| ch.is_control()) { return "未记录"; }
    if origin.starts_with("recording://") { return "录屏"; }
    if origin.starts_with("canvas-generation://") { return "生成"; }
    let windows_drive = origin.as_bytes().get(0).is_some_and(u8::is_ascii_alphabetic)
        && origin.as_bytes().get(1) == Some(&b':')
        && origin.as_bytes().get(2).is_some_and(|ch| matches!(*ch, b'\\' | b'/'));
    if let Ok(url) = reqwest::Url::parse(origin) {
        if matches!(url.scheme(), "http" | "https") && url.host().is_some()
            && url.username().is_empty() && url.password().is_none() {
            return if url.path() == "/" && url.query().is_none() && url.fragment().is_none() {
                "网站入口"
            } else { "网页资源" };
        }
        return if windows_drive { "本地文件" } else { "未记录" };
    }
    if origin.is_empty() { return "未记录"; }
    let lower = origin.to_ascii_lowercase();
    if ["browser:", "dropped:", "blob:", "data:", "javascript:", "file:"].iter()
        .any(|prefix| lower.starts_with(prefix)) || lower.starts_with("http:") || lower.starts_with("https:") {
        return "未记录";
    }
    if origin.split_once(':').is_some_and(|(scheme, _)| !scheme.is_empty()
        && scheme.bytes().next().is_some_and(|ch| ch.is_ascii_alphabetic())
        && scheme.bytes().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'+' | b'.' | b'-'))) {
        return if windows_drive { "本地文件" } else { "未记录" };
    }
    "本地文件"
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegisteredManagedRoot {
    version: u32,
    root_id: String,
    canonical_path: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct PendingMaterialDeletion {
    version: u32,
    token: String,
    asset_id: String,
    #[serde(default)]
    library_id: Option<String>,
    storage_mode: String,
    content_hash: String,
    root_id: Option<String>,
    original_relative: Option<String>,
    source_path: Option<String>,
    quarantine_name: String,
}

struct DeleteQuarantine {
    manifest_path: PathBuf,
    record: PendingMaterialDeletion,
    original_path: PathBuf,
    quarantine_path: PathBuf,
}

struct ImportItemOutcome {
    asset: Option<MaterialAsset>,
    changed: bool,
}

#[derive(Clone, Debug)]
struct TrustedManagedFile {
    root_id: String,
    relative_path: PathBuf,
    file_path: PathBuf,
}

#[derive(Clone, Debug)]
struct OwnedPhysicalFile {
    storage_mode: String,
    content_hash: String,
    root_id: Option<String>,
    relative_path: Option<PathBuf>,
    file_path: PathBuf,
}

fn asset_revision_in(connection: &Connection, asset: &MaterialAsset) -> MaterialResult<String> {
    let mut statement = connection
        .prepare(
            "SELECT tag_id FROM item_tag
             WHERE item_type = 'asset' AND item_id = ?1 ORDER BY tag_id",
        )
        .map_err(|error| MaterialError::database("准备素材版本查询失败", error))?;
    let tags = statement
        .query_map([asset.id.as_str()], |row| row.get::<_, String>(0))
        .map_err(|error| MaterialError::database("查询素材版本失败", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| MaterialError::database("读取素材版本失败", error))?;
    Ok(material_revision(
        &asset.id,
        &asset.updated_at,
        asset.folder_id.as_deref(),
        asset.content_hash.as_deref(),
        &tags,
    ))
}

/// Revision authority for service transactions sharing the catalog database.
/// The caller must hold its write transaction before checking a remote
/// `expectedRevision`; reopening the catalog outside that transaction races.
pub(crate) fn asset_revision_by_id_in(
    connection: &Connection,
    asset_id: &str,
) -> MaterialResult<Option<String>> {
    match read_asset(connection, asset_id) {
        Ok(asset) => asset_revision_in(connection, &asset).map(Some),
        Err(error) if error.code == "not-found" => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn material_revision(
    asset_id: &str,
    updated_at: &str,
    folder_id: Option<&str>,
    content_hash: Option<&str>,
    tag_ids: &[String],
) -> String {
    let mut tags = tag_ids.to_vec();
    tags.sort();
    let mut digest = Sha256::new();
    digest.update(b"luckyray-material-revision-v1\0");
    digest.update(asset_id.as_bytes());
    digest.update(b"\0");
    digest.update(updated_at.as_bytes());
    digest.update(b"\0");
    digest.update(folder_id.unwrap_or_default().as_bytes());
    digest.update(b"\0");
    digest.update(content_hash.unwrap_or_default().as_bytes());
    digest.update(b"\0");
    digest.update(tags.join("\0").as_bytes());
    format!("{:x}", digest.finalize())
}

fn note_file_revision_in(connection:&Connection,asset:&MaterialAsset)->MaterialResult<String> {
    let base=asset_revision_in(connection,asset)?;
    let has_index:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='material_note_identity' AND type='table')",[],|r|r.get(0)).map_err(|e|MaterialError::database("Read attachment revision",e))?;
    let binding=if has_index {
        let has_version:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('material_note_identity') WHERE name='file_version')",[],|r|r.get(0)).map_err(|e|MaterialError::database("Read attachment revision",e))?;
        let sql=if has_version {"SELECT file_identity,file_version FROM material_note_identity WHERE asset_id=?1"} else {"SELECT file_identity,'' FROM material_note_identity WHERE asset_id=?1"};
        connection.query_row(sql,[&asset.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(|e|MaterialError::database("Read attachment revision",e))?
    } else {None};
    let encoded=serde_json::to_vec(&(base,&asset.storage_mode,&asset.original_path,&asset.library_path,asset.size_bytes,binding)).map_err(|e|MaterialError::new("material-revision-invalid",e.to_string()))?;
    Ok(format!("note-file:{:x}",Sha256::digest(encoded)))
}

fn assert_asset_revision(
    connection: &Connection,
    asset: &MaterialAsset,
    expected_revision: Option<&str>,
) -> MaterialResult<()> {
    if let Some(expected) = expected_revision {
        let actual=if expected.starts_with("note-file:") {note_file_revision_in(connection,asset)?} else {asset_revision_in(connection,asset)?};
        if actual != expected {
            return Err(MaterialError::new(
                "material-revision-conflict",
                "素材已变化，请刷新后重试",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub(super) struct TrustedManagedRoot {
    root_id: String,
    root_path: PathBuf,
}

impl MaterialCatalog {
    pub(crate) fn new(db_path: impl Into<PathBuf>, app_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
            app_data_dir: app_data_dir.into(),
            library_id: None,
            attachment_projection: false,
            #[cfg(test)]
            delete_fault: None,
            #[cfg(test)]
            import_barrier: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test() -> Self {
        let root = std::env::temp_dir().join(format!(
            "luckyray-material-catalog-{}-{}",
            std::process::id(),
            unique_id("fixture")
        ));
        std::fs::create_dir_all(&root).unwrap();
        let catalog = Self::new(root.join("luckyray.db"), &root);
        catalog.initialize_test_schema().unwrap();
        catalog
    }

    #[cfg(test)]
    pub(crate) fn new_for_test_at(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref();
        std::fs::create_dir_all(root).unwrap();
        let catalog = Self::new(root.join("luckyray.db"), root);
        catalog.initialize_test_schema().unwrap();
        catalog
    }

    pub(crate) fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub(crate) fn revision_for_asset(&self, asset: &MaterialAsset) -> MaterialResult<String> {
        let connection = self.open_read()?;
        read_asset(&connection,&asset.id)?;
        asset_revision_in(&connection, asset)
    }

    pub(crate) fn note_file_revision_for_asset(&self,asset:&MaterialAsset)->MaterialResult<String> {
        note_file_revision_in(&self.open_read()?,asset)
    }

    pub(crate) fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    #[cfg(test)]
    fn with_test_delete_quarantine_failure(mut self) -> Self {
        self.delete_fault = Some(DeleteTestFault::QuarantineRename);
        self
    }

    #[cfg(test)]
    fn with_test_delete_purge_failure(mut self) -> Self {
        self.delete_fault = Some(DeleteTestFault::Purge);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_test_import_barrier(
        mut self,
        barrier: std::sync::Arc<std::sync::Barrier>,
    ) -> Self {
        self.import_barrier = Some(barrier);
        self
    }

    #[cfg(test)]
    fn wait_at_import_barrier(&self) {
        if let Some(barrier) = &self.import_barrier {
            barrier.wait();
        }
    }

    fn should_fail_delete_quarantine(&self) -> bool {
        #[cfg(test)]
        {
            return self.delete_fault == Some(DeleteTestFault::QuarantineRename);
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    fn should_fail_delete_purge(&self) -> bool {
        #[cfg(test)]
        {
            return self.delete_fault == Some(DeleteTestFault::Purge);
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    pub(super) fn open_read(&self) -> MaterialResult<Connection> {
        if !self.db_path.exists() {
            return Err(MaterialError::new(
                "database-missing",
                format!("数据库文件不存在: {}", self.db_path.to_string_lossy()),
            ));
        }
        let conn = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| MaterialError::database("打开素材数据库失败", error))?;
        self.install_library_context(&conn)?;
        Ok(conn)
    }

    pub(super) fn open_write(&self) -> MaterialResult<Connection> {
        if !self.db_path.exists() {
            return Err(MaterialError::new(
                "database-missing",
                format!("数据库文件不存在: {}", self.db_path.to_string_lossy()),
            ));
        }
        let conn = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| MaterialError::database("打开素材数据库失败", error))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|error| MaterialError::database("设置素材数据库等待超时失败", error))?;
        self.install_library_context(&conn)?;
        Ok(conn)
    }

    fn install_library_context(&self, conn: &Connection) -> MaterialResult<()> {
        if !super::libraries::has_libraries(conn)? {
            conn.execute_batch("CREATE TEMP VIEW material_visible_asset AS SELECT id AS asset_id FROM asset; CREATE TEMP VIEW material_visible_folder AS SELECT id AS folder_id FROM folder WHERE scope='materials'; CREATE TEMP VIEW material_visible_tag AS SELECT * FROM tag;").map_err(|e|MaterialError::database("建立旧范围失败",e))?;
            return Ok(());
        }
        let id = if self.attachment_projection { None } else if let Some(id)=&self.library_id {Some(id.clone())} else {
            Some(conn.query_row("SELECT legacy_id FROM material_library_state WHERE singleton=1",[],|r|r.get::<_,String>(0)).map_err(|e|MaterialError::database("读取默认库失败",e))?)
        };
        conn.execute_batch("CREATE TEMP TABLE material_library_context(library_id TEXT)").map_err(|e|MaterialError::database("冻结素材库上下文失败",e))?;
        conn.execute("INSERT INTO temp.material_library_context VALUES(?1)",[id]).map_err(|e|MaterialError::database("冻结素材库上下文失败",e))?;
        conn.execute_batch("CREATE TEMP VIEW material_visible_asset AS SELECT asset_id FROM main.material_library_asset WHERE library_id=(SELECT library_id FROM temp.material_library_context) UNION SELECT id FROM main.asset WHERE (SELECT library_id FROM temp.material_library_context) IS NULL;
            CREATE TEMP VIEW material_visible_folder AS SELECT folder_id FROM main.material_library_folder WHERE library_id=(SELECT library_id FROM temp.material_library_context) UNION SELECT id FROM main.folder WHERE (SELECT library_id FROM temp.material_library_context) IS NULL;
            CREATE TEMP VIEW material_visible_tag AS SELECT id,name,color,created_at,updated_at FROM main.material_library_tag WHERE library_id=COALESCE((SELECT library_id FROM temp.material_library_context),(SELECT legacy_id FROM main.material_library_state));").map_err(|e|MaterialError::database("建立库查询范围失败",e))?;
        Ok(())
    }

    /// Only existing Vault coordinators may use this internal projection.
    pub(crate) fn for_attachment_projection(&self) -> Self {
        let mut catalog=self.clone();catalog.attachment_projection=true;catalog
    }

    fn managed_roots_dir(&self) -> PathBuf {
        self.app_data_dir.join("material-managed-roots")
    }

    fn trusted_app_subdirectory(
        &self,
        name: &str,
        create: bool,
        error_code: &str,
    ) -> MaterialResult<PathBuf> {
        let app_root = canonical_trusted_root(&self.app_data_dir)?;
        let directory = self.app_data_dir.join(name);
        if create {
            std::fs::create_dir_all(&directory)
                .map_err(|error| MaterialError::io(error_code, "创建应用受控目录失败", error))?;
        }
        reject_reparse_components(&directory).map_err(|error| {
            MaterialError::new(
                error_code,
                format!("应用受控目录包含重解析点: {}", error.message),
            )
        })?;
        let metadata = std::fs::symlink_metadata(&directory)
            .map_err(|error| MaterialError::io(error_code, "无法验证应用受控目录", error))?;
        if !metadata.is_dir() || metadata_is_reparse(&metadata) {
            return Err(MaterialError::new(error_code, "应用受控目录不是普通目录"));
        }
        let canonical = directory
            .canonicalize()
            .map_err(|error| MaterialError::io(error_code, "无法规范化应用受控目录", error))?;
        if canonical == app_root || !canonical.starts_with(&app_root) {
            return Err(MaterialError::new(error_code, "应用受控目录越界"));
        }
        Ok(canonical)
    }

    pub(super) fn register_managed_root(&self, path: &Path) -> MaterialResult<TrustedManagedRoot> {
        let root_path = canonical_trusted_root(path)?;
        let root_id = managed_root_id(&root_path);
        let default_root = self.app_data_dir.join("asset-library");
        if default_root.exists() && canonical_trusted_root(&default_root)? == root_path {
            return Ok(TrustedManagedRoot { root_id, root_path });
        }
        let directory = self.trusted_app_subdirectory(
            "material-managed-roots",
            true,
            "managed-root-register-failed",
        )?;
        let record = RegisteredManagedRoot {
            version: MANAGED_ROOT_VERSION,
            root_id: root_id.clone(),
            canonical_path: root_path.to_string_lossy().to_string(),
        };
        let record_path = directory.join(format!("{root_id}.json"));
        if record_path.exists() {
            let existing = self.read_registered_managed_root(&record_path)?;
            if existing.root_id == root_id && existing.root_path == root_path {
                return Ok(existing);
            }
            return Err(MaterialError::new(
                "managed-root-register-conflict",
                "托管素材库注册记录冲突",
            ));
        }
        let temporary = directory.join(format!("{root_id}.{}.tmp", unique_id("root")));
        let bytes = serde_json::to_vec(&record)
            .map_err(|error| MaterialError::new("serialize-error", error.to_string()))?;
        std::fs::write(&temporary, bytes).map_err(|error| {
            MaterialError::io(
                "managed-root-register-failed",
                "写入托管素材库注册记录失败",
                error,
            )
        })?;
        if let Err(error) = std::fs::rename(&temporary, &record_path) {
            let _ = std::fs::remove_file(&temporary);
            if record_path.exists() {
                let existing = self.read_registered_managed_root(&record_path)?;
                if existing.root_id == root_id && existing.root_path == root_path {
                    return Ok(existing);
                }
            }
            return Err(MaterialError::io(
                "managed-root-register-failed",
                "提交托管素材库注册记录失败",
                error,
            ));
        }
        Ok(TrustedManagedRoot { root_id, root_path })
    }

    fn read_registered_managed_root(&self, path: &Path) -> MaterialResult<TrustedManagedRoot> {
        let trusted_directory = self.trusted_app_subdirectory(
            "material-managed-roots",
            false,
            "managed-root-record-invalid",
        )?;
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            MaterialError::io(
                "managed-root-record-invalid",
                "无法检查托管素材库注册记录",
                error,
            )
        })?;
        if path.parent() != Some(trusted_directory.as_path())
            || !metadata.is_file()
            || metadata_is_reparse(&metadata)
        {
            return Err(MaterialError::new(
                "managed-root-record-invalid",
                "托管素材库注册记录不是受控普通文件",
            ));
        }
        let file_stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| is_sha256_id(value))
            .ok_or_else(|| {
                MaterialError::new("managed-root-record-invalid", "托管素材库注册文件名无效")
            })?;
        let record = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RegisteredManagedRoot>(&bytes).ok())
            .ok_or_else(|| {
                MaterialError::new("managed-root-record-invalid", "托管素材库注册记录损坏")
            })?;
        if record.version != MANAGED_ROOT_VERSION
            || record.root_id != file_stem
            || !is_sha256_id(&record.root_id)
        {
            return Err(MaterialError::new(
                "managed-root-record-invalid",
                "托管素材库注册记录身份不匹配",
            ));
        }
        let root_path = canonical_trusted_root(Path::new(&record.canonical_path))?;
        if managed_root_id(&root_path) != record.root_id {
            return Err(MaterialError::new(
                "managed-root-record-invalid",
                "托管素材库注册路径校验失败",
            ));
        }
        Ok(TrustedManagedRoot {
            root_id: record.root_id,
            root_path,
        })
    }

    fn trusted_managed_roots(&self) -> Vec<TrustedManagedRoot> {
        let mut roots = Vec::new();
        let default_root = self.app_data_dir.join("asset-library");
        if let Ok(root_path) = canonical_trusted_root(&default_root) {
            roots.push(TrustedManagedRoot {
                root_id: managed_root_id(&root_path),
                root_path,
            });
        }
        let registered_dir = self
            .managed_roots_dir()
            .exists()
            .then(|| {
                self.trusted_app_subdirectory(
                    "material-managed-roots",
                    false,
                    "managed-root-record-invalid",
                )
            })
            .and_then(Result::ok);
        if let Some(registered_dir) = registered_dir {
            let Ok(entries) = std::fs::read_dir(registered_dir) else {
                return roots;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(root) = self.read_registered_managed_root(&path) {
                    if !roots.iter().any(|current| current.root_id == root.root_id) {
                        roots.push(root);
                    }
                }
            }
        }
        roots.sort_by_key(|root| std::cmp::Reverse(root.root_path.components().count()));
        roots
    }

    fn trusted_managed_root_by_id(&self, root_id: &str) -> MaterialResult<TrustedManagedRoot> {
        self.trusted_managed_roots()
            .into_iter()
            .find(|root| root.root_id == root_id)
            .ok_or_else(|| {
                MaterialError::new("managed-root-untrusted", "删除恢复记录引用了未注册素材库")
            })
    }

    fn resolve_trusted_managed_leaf(&self, path: &Path) -> MaterialResult<TrustedManagedFile> {
        if !path.is_absolute() {
            return Err(MaterialError::new(
                "managed-path-untrusted",
                "托管素材路径必须是受信素材库内的绝对路径",
            ));
        }
        reject_reparse_components(path)?;
        let file_name = path
            .file_name()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                MaterialError::new("managed-path-untrusted", "托管素材路径缺少文件名")
            })?;
        let parent = path.parent().ok_or_else(|| {
            MaterialError::new("managed-path-untrusted", "托管素材路径缺少父目录")
        })?;
        let parent_path = parent.canonicalize().map_err(|error| {
            MaterialError::io(
                "managed-path-unavailable",
                "无法规范化托管素材父目录",
                error,
            )
        })?;
        let root = self
            .trusted_managed_roots()
            .into_iter()
            .find(|root| parent_path.starts_with(&root.root_path))
            .ok_or_else(|| {
                MaterialError::new("managed-path-untrusted", "托管素材路径不在已注册素材库内")
            })?;
        let candidate = parent_path.join(file_name);
        let file_path = if path.exists() {
            path.canonicalize().map_err(|error| {
                MaterialError::io("managed-path-unavailable", "无法规范化托管素材路径", error)
            })?
        } else {
            candidate
        };
        if !file_path.starts_with(&root.root_path) || file_path == root.root_path {
            return Err(MaterialError::new(
                "managed-path-untrusted",
                "托管素材路径越过已注册素材库边界",
            ));
        }
        let relative_path = file_path
            .strip_prefix(&root.root_path)
            .map(Path::to_path_buf)
            .map_err(|_| MaterialError::new("managed-path-untrusted", "托管素材路径越界"))?;
        validate_safe_relative_path(&relative_path)?;
        Ok(TrustedManagedFile {
            root_id: root.root_id,
            relative_path,
            file_path,
        })
    }

    fn resolve_trusted_managed_file(&self, path: &Path) -> MaterialResult<TrustedManagedFile> {
        let resolved = self.resolve_trusted_managed_leaf(path)?;
        let metadata = std::fs::symlink_metadata(&resolved.file_path).map_err(|error| {
            MaterialError::io(
                "managed-path-unavailable",
                "无法安全验证托管素材路径",
                error,
            )
        })?;
        if !metadata.is_file() || metadata_is_reparse(&metadata) {
            return Err(MaterialError::new(
                "managed-path-untrusted",
                "托管素材删除目标不是受信普通文件",
            ));
        }
        Ok(resolved)
    }

    fn resolve_physical_file(&self, storage_mode: &str, path: &Path) -> MaterialResult<PathBuf> {
        if storage_mode == "managed" {
            return self
                .resolve_trusted_managed_file(path)
                .map(|file| file.file_path);
        }
        canonical_regular_file(path)
    }

    fn validate_physical_ownership(
        &self,
        conn: &Connection,
        asset: &MaterialAsset,
        path: &Path,
    ) -> MaterialResult<PathBuf> {
        let canonical = self.validate_exclusive_physical_path(conn, asset, path)?;
        let expected_hash = asset
            .content_hash
            .as_deref()
            .filter(|hash| is_sha256_id(hash))
            .ok_or_else(|| {
                MaterialError::new(
                    "physical-content-unverified",
                    "素材缺少可验证的内容身份，不能修改或删除真实文件",
                )
            })?;
        let actual_hash = sha256_file(&canonical)?;
        if !actual_hash.eq_ignore_ascii_case(expected_hash) {
            return Err(MaterialError::new(
                "physical-content-mismatch",
                "目标文件内容与素材身份不匹配",
            ));
        }
        Ok(canonical)
    }

    fn validate_exclusive_physical_path(
        &self,
        conn: &Connection,
        asset: &MaterialAsset,
        path: &Path,
    ) -> MaterialResult<PathBuf> {
        let canonical = self.resolve_physical_file(&asset.storage_mode, path)?;
        ensure_path_not_owned_by_other_asset(conn, &asset.id, &canonical)?;
        Ok(canonical)
    }

    fn validate_delete_physical_file(
        &self,
        conn: &Connection,
        asset: &MaterialAsset,
    ) -> MaterialResult<OwnedPhysicalFile> {
        match asset.storage_mode.as_str() {
            "managed" => {
                let expected_hash = asset
                    .content_hash
                    .as_deref()
                    .filter(|hash| is_sha256_id(hash))
                    .ok_or_else(|| {
                        MaterialError::new(
                            "physical-content-unverified",
                            "素材缺少可验证的内容身份，不能删除真实文件",
                        )
                    })?
                    .to_ascii_lowercase();
                let path = asset
                    .library_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                    .ok_or_else(|| {
                        MaterialError::new("managed-path-untrusted", "托管素材缺少受信文件路径")
                    })?;
                let canonical = self.validate_physical_ownership(conn, asset, Path::new(path))?;
                let trusted = self.resolve_trusted_managed_file(&canonical)?;
                Ok(OwnedPhysicalFile {
                    storage_mode: "managed".to_string(),
                    content_hash: expected_hash,
                    root_id: Some(trusted.root_id),
                    relative_path: Some(trusted.relative_path),
                    file_path: trusted.file_path,
                })
            }
            "source" => {
                let path = asset
                    .library_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                    .unwrap_or(asset.original_path.as_str());
                let canonical =
                    self.validate_exclusive_physical_path(conn, asset, Path::new(path))?;
                if !asset.original_path.trim().is_empty() {
                    let original = canonical_regular_file(Path::new(&asset.original_path))?;
                    if canonical_path_key(&original) != canonical_path_key(&canonical) {
                        return Err(MaterialError::new(
                            "physical-identity-mismatch",
                            "源文件记录的原始路径与管理路径不一致",
                        ));
                    }
                }
                if let Some(library_path) = asset
                    .library_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                {
                    let library = canonical_regular_file(Path::new(library_path))?;
                    if canonical_path_key(&library) != canonical_path_key(&canonical) {
                        return Err(MaterialError::new(
                            "physical-identity-mismatch",
                            "源文件记录的原始路径与管理路径不一致",
                        ));
                    }
                }
                Ok(OwnedPhysicalFile {
                    storage_mode: "source".to_string(),
                    content_hash: sha256_file(&canonical)?,
                    root_id: None,
                    relative_path: None,
                    file_path: canonical,
                })
            }
            "linked" => Err(MaterialError::new(
                "delete-file-unsafe-storage",
                "链接引用素材只能解除引用，不能删除真实文件",
            )),
            _ => Err(MaterialError::new(
                "invalid-storage-mode",
                "无效的素材存储模式",
            )),
        }
    }

    /// Advance the DURABLE material change authority for a favorite mutation.
    ///
    /// Favorite state lives in the favorites authority rather than in the
    /// catalog tables, so the catalog cannot derive a change from its own
    /// triggers — but existing Desktop surfaces still invalidate through the
    /// single material-change authority. This publishes that real, persisted
    /// change (not a transient synthetic event) for the affected asset.
    pub(crate) fn publish_favorite_change(&self, asset_id: &str) -> MaterialResult<MaterialChange> {
        let conn = self.open_write()?;
        ensure_change_schema(&conn)?;
        // Favorite state lives in favorite_item, which has no material trigger,
        // so advance the version explicitly with the same statement shape the
        // catalog triggers use — then publish the reason/affected ids through
        // the one durable authority.
        let version_before = read_change(&conn)?.version;
        conn.execute(
            "UPDATE material_change_state SET version = version + 1, reason = ?1, affected_ids_json = ?2, folders_changed = 0, occurred_at = ?3 WHERE singleton = 1",
            rusqlite::params![
                "favorite",
                serde_json::to_string(&vec![asset_id.to_string()])
                    .map_err(|error| MaterialError::new("serialize-error", error.to_string()))?,
                now(),
            ],
        )
        .map_err(|error| MaterialError::database("发布收藏变更失败", error))?;
        finalize_change(
            &conn,
            version_before,
            "favorite",
            vec![asset_id.to_string()],
            false,
        )?
        .ok_or_else(|| MaterialError::new("change-not-published", "发布收藏变更失败"))
    }

    pub(crate) fn read_change(&self) -> MaterialResult<MaterialChange> {
        if !self.db_path.exists() {
            return Ok(default_change());
        }
        let conn = self.open_write()?;
        let mut change=read_change(&conn)?;
        if let Some(library)=super::libraries::connection_library(&conn)? {
            change.affected_ids.retain(|id|conn.query_row("SELECT EXISTS(SELECT 1 FROM material_library_asset_history WHERE asset_id=?1 AND library_id=?2)",rusqlite::params![id,library],|r|r.get::<_,bool>(0)).unwrap_or(false));
        }
        Ok(change)
    }

    pub(crate) fn import_paths(
        &self,
        paths: &[PathBuf],
        options: &MaterialImportOptions,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        self.import_paths_with_progress(paths, options, &mut |_| {})
    }

    pub(crate) fn import_paths_with_progress(
        &self,
        paths: &[PathBuf],
        options: &MaterialImportOptions,
        progress: &mut dyn FnMut(serde_json::Value),
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        let storage_mode = normalize_storage_mode(&options.storage_mode)?;
        let library_dir = self.import_library_root(options.managed_library_dir.as_deref())?;
        if storage_mode == "managed" {
            std::fs::create_dir_all(&library_dir).map_err(|error| {
                MaterialError::io("create-library-failed", "创建素材库目录失败", error)
            })?;
            self.register_managed_root(&library_dir)?;
        }

        let conn = self.open_write()?;
        validate_material_folder(&conn, options.folder_id.as_deref())?;
        let mut result = MaterialImportResult::default();
        let mut changed = false;

        for (index, source_path) in paths.iter().enumerate() {
            let file_name = source_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| source_path.to_string_lossy().to_string());
            let mut report = |bytes: u64, total: u64| progress(serde_json::json!({
                "current":index,"total":paths.len(),"name":file_name,
                "bytesRead":bytes,"bytesTotal":total,
                "phase":if storage_mode=="managed" {"copying"} else {"importing"}
            }));
            match self.import_one_path_with_progress(
                &conn,
                source_path,
                &file_name,
                storage_mode,
                &library_dir,
                options.folder_id.as_deref(),
                &mut report,
            ) {
                Ok(outcome) => {
                    changed |= outcome.changed;
                    if let Some(asset) = outcome.asset {
                        result.imported_count += 1;
                        result.assets.push(asset);
                    } else {
                        result.skipped_duplicate_count += 1;
                    }
                }
                Err(error) => result.failed_items.push(MaterialImportError {
                    file: file_name,
                    code: error.code,
                    error: error.message,
                }),
            }
            progress(serde_json::json!({"current":index+1,"total":paths.len(),"phase":"importing"}));
        }
        result.failed_count = result.failed_items.len() as u32;
        let affected_ids = result.assets.iter().map(|asset| asset.id.clone()).collect();
        let change = changed
            .then(|| publish_change_metadata(&conn, "material-import", affected_ids, false))
            .transpose()?;
        Ok(CatalogOutcome {
            value: result,
            change,
        })
    }

    pub(crate) fn import_folder(
        &self,
        root: &Path,
        options: &MaterialImportOptions,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        if !root.is_dir() {
            return Err(MaterialError::new(
                "source-missing",
                format!("目录不存在: {}", root.to_string_lossy()),
            ));
        }
        let storage_mode = normalize_storage_mode(&options.storage_mode)?;
        let library_dir = self.import_library_root(options.managed_library_dir.as_deref())?;
        if storage_mode == "managed" {
            std::fs::create_dir_all(&library_dir).map_err(|error| {
                MaterialError::io("create-library-failed", "创建素材库目录失败", error)
            })?;
            self.register_managed_root(&library_dir)?;
        }
        let files = collect_import_files(root, options.recursive);
        let conn = self.open_write()?;
        validate_material_folder(&conn, options.folder_id.as_deref())?;
        let mut result = MaterialImportResult::default();
        let mut folders_changed = false;
        let mut changed = false;
        for source_path in files {
            let file_name = source_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let folder_id = if options.preserve_folder_structure {
                let (folder_id, created) =
                    ensure_folder_path(&conn, root, &source_path, options.folder_id.as_deref())?;
                folders_changed |= created;
                Some(folder_id)
            } else {
                options.folder_id.clone()
            };
            match self.import_one_path(
                &conn,
                &source_path,
                &file_name,
                storage_mode,
                &library_dir,
                folder_id.as_deref(),
            ) {
                Ok(outcome) => {
                    changed |= outcome.changed;
                    if let Some(asset) = outcome.asset {
                        result.imported_count += 1;
                        result.assets.push(asset);
                    } else {
                        result.skipped_duplicate_count += 1;
                    }
                }
                Err(error) => result.failed_items.push(MaterialImportError {
                    file: file_name,
                    code: error.code,
                    error: error.message,
                }),
            }
        }
        result.failed_count = result.failed_items.len() as u32;
        let affected_ids = result.assets.iter().map(|asset| asset.id.clone()).collect();
        let change = (changed || folders_changed)
            .then(|| {
                publish_change_metadata(
                    &conn,
                    "material-folder-import",
                    affected_ids,
                    folders_changed,
                )
            })
            .transpose()?;
        Ok(CatalogOutcome {
            value: result,
            change,
        })
    }

    pub(crate) fn import_bytes(
        &self,
        items: Vec<MaterialBytesInput>,
        options: &MaterialImportOptions,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        self.import_bytes_with_source(items, options, None)
    }

    pub(crate) fn import_bytes_with_source(
        &self,
        items: Vec<MaterialBytesInput>,
        options: &MaterialImportOptions,
        source_page: Option<&MaterialSourcePageInput>,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        self.import_bytes_with_source_policy(items, options, source_page, false)
    }

    /// Consumer retries keep the canonical duplicate's manual metadata, even
    /// when another import wins the content race after the initial lookup.
    pub(super) fn import_consumer_bytes_with_source(
        &self, items: Vec<MaterialBytesInput>, options: &MaterialImportOptions,
        source_page: Option<&MaterialSourcePageInput>,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        self.import_bytes_with_source_policy(items, options, source_page, true)
    }

    fn import_bytes_with_source_policy(
        &self, items: Vec<MaterialBytesInput>, options: &MaterialImportOptions,
        source_page: Option<&MaterialSourcePageInput>, keep_duplicate_metadata: bool,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        if source_page.is_some() && items.len() != 1 {
            return Err(MaterialError::new("source-page-binding-invalid", "来源页面只可绑定单个采集目标"));
        }
        if normalize_storage_mode(&options.storage_mode)? != "managed" {
            return Err(MaterialError::new(
                "bytes-import-requires-managed",
                "字节导入仅支持托管素材",
            ));
        }
        let library_dir = self.import_library_root(options.managed_library_dir.as_deref())?;
        std::fs::create_dir_all(&library_dir).map_err(|error| {
            MaterialError::io("create-library-failed", "创建素材库目录失败", error)
        })?;
        self.register_managed_root(&library_dir)?;
        let conn = self.open_write()?;
        validate_material_folder(&conn, options.folder_id.as_deref())?;
        let mut result = MaterialImportResult::default();
        let mut changed = false;
        for item in items {
            let file_name = item.name.clone();
            match self.import_managed_bytes_atomic(
                &conn,
                &library_dir,
                &item.name,
                &item.original_path,
                &item.mime_type,
                item.description.as_deref().unwrap_or_default(),
                &item.bytes,
                options.folder_id.as_deref(),
                source_page,
                keep_duplicate_metadata,
            ) {
                Ok(outcome) => {
                    changed |= outcome.changed;
                    if let Some(asset) = outcome.asset {
                        result.imported_count += 1;
                        result.assets.push(asset);
                    } else {
                        result.skipped_duplicate_count += 1;
                    }
                }
                Err(error) => result.failed_items.push(MaterialImportError {
                    file: file_name,
                    code: error.code,
                    error: error.message,
                }),
            }
        }
        result.failed_count = result.failed_items.len() as u32;
        let affected_ids = result.assets.iter().map(|asset| asset.id.clone()).collect();
        let change = changed
            .then(|| publish_change_metadata(&conn, "material-bytes-import", affected_ids, false))
            .transpose()?;
        Ok(CatalogOutcome {
            value: result,
            change,
        })
    }

    /// Atomically adopts an app-owned media-transfer staging file into the
    /// managed library. Hashing and sizing are streamed, and the staging file
    /// is removed on every trusted-path outcome (success, duplicate, or
    /// failure). Arbitrary caller-supplied filesystem paths are never deleted.
    pub(crate) fn import_staged_file(
        &self,
        input: MaterialStagedFileInput,
        options: &MaterialImportOptions,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        self.import_staged_file_with_source(input, options, None)
    }

    pub(crate) fn import_staged_file_with_source(
        &self,
        input: MaterialStagedFileInput,
        options: &MaterialImportOptions,
        source_page: Option<&MaterialSourcePageInput>,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        self.import_staged_file_with_source_checked(input, options, source_page, || Ok(()))
    }

    /// An external authority may acquire its commit guard after the streaming
    /// hash, but before any managed-library or catalog side effect. The guard
    /// remains live through the catalog transaction and file promotion.
    pub(crate) fn import_staged_file_with_source_checked<G>(
        &self,
        input: MaterialStagedFileInput,
        options: &MaterialImportOptions,
        source_page: Option<&MaterialSourcePageInput>,
        before_commit: impl FnOnce() -> MaterialResult<G>,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        self.import_staged_file_with_policy(input, options, source_page, false, before_commit)
    }

    pub(super) fn import_consumer_staged_file_with_source(
        &self, input: MaterialStagedFileInput, options: &MaterialImportOptions,
        source_page: Option<&MaterialSourcePageInput>,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        self.import_staged_file_with_policy(input, options, source_page, true, || Ok(()))
    }

    fn import_staged_file_with_policy<G>(
        &self, input: MaterialStagedFileInput, options: &MaterialImportOptions,
        source_page: Option<&MaterialSourcePageInput>, preserve_duplicate: bool,
        before_commit: impl FnOnce() -> MaterialResult<G>,
    ) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        if normalize_storage_mode(&options.storage_mode)? != "managed" {
            return Err(MaterialError::new(
                "staged-import-requires-managed",
                "暂存文件导入仅支持托管素材",
            ));
        }
        let staged_path = self.resolve_trusted_media_staging_file(&input.path)?;
        let mut cleanup = StagedFileCleanup(Some(staged_path.clone()));
        let (hash, size_bytes) = sha256_file_and_size(&staged_path)?;
        if size_bytes != input.expected_size_bytes
            || !hash.eq_ignore_ascii_case(&input.expected_sha256)
        {
            return Err(MaterialError::new(
                "staged-file-changed",
                "暂存素材内容与下载结果不一致",
            ));
        }
        // A rejected (revoked/stopped) Services request retains its verified
        // staging file for a later authorized retry. Ordinary import failures
        // still run the existing cleanup policy.
        let _commit_guard = match before_commit() {
            Ok(guard) => guard,
            Err(error) => { cleanup.0 = None; return Err(error); }
        };
        let _cleanup = cleanup;
        let original_source = safe_original_source_projection(&input.original_source)?;
        let library_dir = self.import_library_root(options.managed_library_dir.as_deref())?;
        std::fs::create_dir_all(&library_dir).map_err(|error| {
            MaterialError::io("create-library-failed", "创建素材库目录失败", error)
        })?;
        self.register_managed_root(&library_dir)?;
        let conn = self.open_write()?;
        validate_material_folder(&conn, options.folder_id.as_deref())?;
        #[cfg(test)]
        self.wait_at_import_barrier();
        begin_transaction(&conn)?;
        let mut created_destination = None;
        let operation = (|| {
            let duplicate = conn
                .query_row(
                    "SELECT id FROM asset WHERE COALESCE(storage_mode,'linked')='managed' AND content_hash=?1 AND id IN (SELECT asset_id FROM temp.material_visible_asset) LIMIT 1",
                    [&hash],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| MaterialError::database("查询重复托管素材失败", error))?;
            if let Some(existing_id) = duplicate {
                let changed = if preserve_duplicate { false } else {
                    update_duplicate_folder(&conn, &existing_id, options.folder_id.as_deref())?
                        | insert_source_page_if_absent(&conn, &existing_id, source_page)?
                };
                let asset = read_asset(&conn, &existing_id)?;
                let change = changed
                    .then(|| {
                        publish_change_metadata(
                            &conn,
                            "material-staged-import",
                            vec![existing_id],
                            false,
                        )
                    })
                    .transpose()?;
                commit_transaction(&conn)?;
                return Ok(CatalogOutcome {
                    value: MaterialImportResult {
                        assets: vec![asset],
                        skipped_duplicate_count: 1,
                        ..MaterialImportResult::default()
                    },
                    change,
                });
            }

            let id = unique_id("asset");
            let name = safe_file_name(&input.name);
            let kind = kind_from_name(&name).to_string();
            let destination = library_dir.join(managed_content_file_name(&hash, &name));
            ensure_path_not_owned_by_other_asset(&conn, &id, &destination)?;
            if promote_managed_temp_no_clobber(&staged_path, &destination, &hash)? {
                created_destination = Some(destination.clone());
            }
            let timestamp = now();
            let path = destination.to_string_lossy().to_string();
            let size_i64 = i64::try_from(size_bytes).map_err(|_| {
                MaterialError::new("staged-file-too-large", "暂存素材大小超出支持范围")
            })?;
            prepare_new_member(&conn,"asset",&id)?;
            conn.execute(
                "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash) VALUES(?1,?2,?3,?4,'managed',?5,?6,?7,?8,?9,NULL,NULL,?10,?11,?11,?12)",
                rusqlite::params![
                    id,
                    name,
                    original_source,
                    path,
                    kind,
                    input.mime_type,
                    size_i64,
                    if kind == "image" { path.as_str() } else { "" },
                    input.description.as_deref().unwrap_or_default(),
                    options.folder_id.as_deref(),
                    timestamp,
                    hash,
                ],
            )
            .map_err(|error| MaterialError::database("写入素材记录失败", error))?;
            bind_new_member(&conn, "asset", &id)?;
            insert_source_page_if_absent(&conn, &id, source_page)?;
            let asset = read_asset(&conn, &id)?;
            let change = publish_change_metadata(
                &conn,
                "material-staged-import",
                vec![asset.id.clone()],
                false,
            )?;
            commit_transaction(&conn)?;
            Ok(CatalogOutcome {
                value: MaterialImportResult {
                    assets: vec![asset],
                    imported_count: 1,
                    ..MaterialImportResult::default()
                },
                change: Some(change),
            })
        })();
        match operation {
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                let _ = rollback_transaction(&conn);
                if let Some(path) = created_destination {
                    let _ = std::fs::remove_file(path);
                }
                Err(error)
            }
        }
    }

    fn resolve_trusted_media_staging_file(&self, path: &Path) -> MaterialResult<PathBuf> {
        let staging_root = self.app_data_dir.join("media-transfer-staging");
        let canonical_root = resolve_media_staging_root(&staging_root)?;
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|error| MaterialError::io("staged-file-missing", "暂存素材不存在", error))?;
        if !metadata.is_file() || metadata_is_reparse(&metadata) {
            return Err(MaterialError::new(
                "staged-file-untrusted",
                "暂存素材不是可信普通文件",
            ));
        }
        let canonical = std::fs::canonicalize(path).map_err(|error| {
            MaterialError::io("staged-file-untrusted", "无法验证暂存素材路径", error)
        })?;
        if canonical.parent() != Some(canonical_root.as_path()) {
            return Err(MaterialError::new(
                "staged-file-untrusted",
                "暂存素材不在应用暂存目录中",
            ));
        }
        Ok(canonical)
    }

    pub(crate) fn migrate_managed_library(
        &self,
        source_dir: &Path,
        target_dir: &Path,
    ) -> MaterialResult<CatalogOutcome<MaterialLibraryMigrationResult>> {
        if target_dir.as_os_str().is_empty() {
            return Err(MaterialError::new("invalid-target", "目标目录不能为空"));
        }
        std::fs::create_dir_all(target_dir).map_err(|error| {
            MaterialError::io("create-library-failed", "创建目标素材库失败", error)
        })?;
        let source_root = canonical_trusted_root(source_dir)?;
        let target_root = canonical_trusted_root(target_dir)?;
        if source_root == target_root {
            return Ok(CatalogOutcome {
                value: MaterialLibraryMigrationResult::default(),
                change: None,
            });
        }

        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let version_before = read_change(&conn)?.version;
        let assets = self.list_assets_scoped(&MaterialFilter::default(), &MaterialQueryScope { scope: "all".into(), ..Default::default() })?;
        // Validate the complete batch before the first filesystem move.
        for asset in assets.iter().filter(|asset| {
            asset.storage_mode == "managed" && asset.library_path.as_deref()
                .and_then(|path| Path::new(path).canonicalize().ok())
                .is_some_and(|path| path.is_file() && path.starts_with(&source_root))
        }) {
            protect_note_attachment(&conn, &asset.id, true)?;
        }
        let has_migratable_asset = assets.iter().any(|asset| {
            asset.storage_mode == "managed"
                && asset
                    .library_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                    .and_then(|path| Path::new(path).canonicalize().ok())
                    .is_some_and(|path| path.is_file() && path.starts_with(&source_root))
        });
        if !has_migratable_asset {
            commit_transaction(&conn)?;
            return Ok(CatalogOutcome {
                value: MaterialLibraryMigrationResult::default(),
                change: None,
            });
        }
        let mut result = MaterialLibraryMigrationResult::default();
        let mut moved_ids = Vec::new();
        let mut moved_files = Vec::new();
        for asset in assets
            .into_iter()
            .filter(|asset| asset.storage_mode == "managed")
        {
            let Some(library_path) = asset
                .library_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
            else {
                result.skipped_count += 1;
                continue;
            };
            let source_path = PathBuf::from(library_path);
            if !source_path.is_file() {
                result.skipped_count += 1;
                continue;
            }
            let source_real = source_path
                .canonicalize()
                .unwrap_or_else(|_| source_path.clone());
            if !source_real.starts_with(&source_root) {
                result.skipped_count += 1;
                continue;
            }
            let file_name = source_path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| safe_file_name(&asset.name));
            let mut destination = target_root.join(&file_name);
            if destination.exists() {
                destination = target_root.join(format!(
                    "{}-{}",
                    safe_file_name(&asset.id),
                    safe_file_name(&file_name)
                ));
            }
            if let Err(error) = move_material_file(&source_path, &destination) {
                result.failed_items.push(MaterialLibraryMigrationError {
                    file: library_path.to_string(),
                    error,
                });
                continue;
            }
            let destination_text = destination.to_string_lossy().to_string();
            if let Err(error) = conn.execute(
                "UPDATE asset SET library_path=?1, thumbnail_url=NULL, updated_at=?2 WHERE id=?3",
                rusqlite::params![destination_text, now(), asset.id],
            ) {
                let rollback = move_material_file(&destination, &source_path).err();
                let message = rollback.map_or_else(
                    || format!("更新数据库失败: {error}"),
                    |rollback| format!("更新数据库失败: {error}; 文件回滚失败: {rollback}"),
                );
                result.failed_items.push(MaterialLibraryMigrationError {
                    file: destination_text,
                    error: message,
                });
                continue;
            }
            moved_ids.push(asset.id);
            moved_files.push((source_path, destination));
            result.moved_count += 1;
        }
        result.failed_count = result.failed_items.len() as u32;
        if result.failed_count > 0 {
            let _ = rollback_transaction(&conn);
            restore_migrated_files(&moved_files).map_err(|error| {
                MaterialError::new(
                    "managed-migration-rollback-failed",
                    format!("迁移失败后恢复素材文件失败: {error}"),
                )
            })?;
            result.moved_count = 0;
            return Ok(CatalogOutcome {
                value: result,
                change: None,
            });
        }

        let source_record = self
            .managed_roots_dir()
            .join(format!("{}.json", managed_root_id(&source_root)));
        let target_record = self
            .managed_roots_dir()
            .join(format!("{}.json", managed_root_id(&target_root)));
        let source_record_existed = source_record.exists();
        let target_record_existed = target_record.exists();
        let register_result = self
            .register_managed_root(&source_root)
            .and_then(|_| self.register_managed_root(&target_root));
        if let Err(error) = register_result {
            let _ = rollback_transaction(&conn);
            if !source_record_existed {
                let _ = std::fs::remove_file(&source_record);
            }
            if !target_record_existed {
                let _ = std::fs::remove_file(&target_record);
            }
            restore_migrated_files(&moved_files).map_err(|restore_error| {
                MaterialError::new(
                    error.code.clone(),
                    format!("{}；恢复迁移文件失败: {restore_error}", error.message),
                )
            })?;
            return Err(error);
        }
        let change = match finalize_change(
            &conn,
            version_before,
            "managed-library-migration",
            moved_ids,
            false,
        ) {
            Ok(change) => change,
            Err(error) => {
                let _ = rollback_transaction(&conn);
                if !source_record_existed {
                    let _ = std::fs::remove_file(&source_record);
                }
                if !target_record_existed {
                    let _ = std::fs::remove_file(&target_record);
                }
                restore_migrated_files(&moved_files).map_err(|restore_error| {
                    MaterialError::new(
                        error.code.clone(),
                        format!("{}；恢复迁移文件失败: {restore_error}", error.message),
                    )
                })?;
                return Err(error);
            }
        };
        if let Err(error) = commit_transaction(&conn) {
            let _ = rollback_transaction(&conn);
            if !source_record_existed {
                let _ = std::fs::remove_file(&source_record);
            }
            if !target_record_existed {
                let _ = std::fs::remove_file(&target_record);
            }
            restore_migrated_files(&moved_files).map_err(|restore_error| {
                MaterialError::new(
                    error.code.clone(),
                    format!("{}；恢复迁移文件失败: {restore_error}", error.message),
                )
            })?;
            return Err(error);
        }
        Ok(CatalogOutcome {
            value: result,
            change,
        })
    }

    fn import_managed_bytes_atomic(
        &self,
        conn: &Connection,
        library_dir: &Path,
        file_name: &str,
        original_path: &str,
        mime_type: &str,
        description: &str,
        bytes: &[u8],
        folder_id: Option<&str>,
        source_page: Option<&MaterialSourcePageInput>,
        keep_duplicate_metadata: bool,
    ) -> MaterialResult<ImportItemOutcome> {
        let hash = sha256_bytes(bytes);
        let id = unique_id("asset");
        let temporary = library_dir.join(format!(".luckyray-import-{id}.tmp"));
        std::fs::write(&temporary, bytes)
            .map_err(|error| MaterialError::io("copy-failed", "保存待导入素材失败", error))?;
        self.import_managed_file_atomic(conn, library_dir, file_name, original_path,
            mime_type, description, &temporary, &hash, bytes.len() as u64,
            folder_id, source_page, keep_duplicate_metadata)
    }

    fn import_managed_file_atomic(
        &self, conn: &Connection, library_dir: &Path, file_name: &str,
        original_path: &str, mime_type: &str, description: &str,
        temporary: &Path, hash: &str, size: u64, folder_id: Option<&str>,
        source_page: Option<&MaterialSourcePageInput>, keep_duplicate_metadata: bool,
    ) -> MaterialResult<ImportItemOutcome> {
        let id = unique_id("asset");
        let name = safe_file_name(file_name);
        #[cfg(test)]
        self.wait_at_import_barrier();
        if let Err(error) = begin_transaction(conn) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        let mut created_destination = None;
        let operation = (|| {
            let duplicate = conn
                .query_row(
                    "SELECT id FROM asset WHERE COALESCE(storage_mode,'linked')='managed' AND content_hash=?1 AND id IN (SELECT asset_id FROM temp.material_visible_asset) LIMIT 1",
                    [&hash],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| MaterialError::database("查询重复托管素材失败", error))?;
            if let Some(existing_id) = duplicate {
                let changed = if keep_duplicate_metadata { false } else {
                    update_duplicate_folder(conn, &existing_id, folder_id)?
                        | insert_source_page_if_absent(conn, &existing_id, source_page)?
                };
                commit_transaction(conn)?;
                return Ok(ImportItemOutcome {
                    asset: None,
                    changed,
                });
            }

            let kind = kind_from_name(&name).to_string();
            let destination = library_dir.join(managed_content_file_name(&hash, &name));
            ensure_path_not_owned_by_other_asset(conn, &id, &destination)?;
            if promote_managed_temp_no_clobber(&temporary, &destination, &hash)? {
                created_destination = Some(destination.clone());
            }
            let timestamp = now();
            let path = destination.to_string_lossy().to_string();
            prepare_new_member(conn,"asset",&id)?;
            conn.execute(
                "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash) VALUES(?1,?2,?3,?4,'managed',?5,?6,?7,?8,?9,NULL,NULL,?10,?11,?11,?12)",
                rusqlite::params![
                    id,
                    name,
                    original_path,
                    path,
                    kind,
                    mime_type,
                    i64::try_from(size).unwrap_or(i64::MAX),
                    if kind == "image" { path.as_str() } else { "" },
                    description,
                    folder_id,
                    timestamp,
                    hash
                ],
            )
            .map_err(|error| MaterialError::database("写入素材记录失败", error))?;
            insert_source_page_if_absent(conn, &id, source_page)?;
            bind_new_member(conn, "asset", &id)?;
            let asset = read_asset(conn, &id)?;
            commit_transaction(conn)?;
            Ok(ImportItemOutcome {
                asset: Some(asset),
                changed: true,
            })
        })();
        match operation {
            Ok(outcome) => {
                let _ = std::fs::remove_file(&temporary);
                Ok(outcome)
            }
            Err(error) => {
                let _ = rollback_transaction(conn);
                let _ = std::fs::remove_file(&temporary);
                if let Some(path) = created_destination {
                    let _ = std::fs::remove_file(path);
                }
                Err(error)
            }
        }
    }

    fn import_one_path(
        &self,
        conn: &Connection,
        source_path: &Path,
        file_name: &str,
        storage_mode: &str,
        library_dir: &Path,
        folder_id: Option<&str>,
    ) -> MaterialResult<ImportItemOutcome> {
        self.import_one_path_with_progress(conn, source_path, file_name, storage_mode,
            library_dir, folder_id, &mut |_, _| {})
    }

    fn import_one_path_with_progress(
        &self, conn: &Connection, source_path: &Path, file_name: &str,
        storage_mode: &str, library_dir: &Path, folder_id: Option<&str>,
        progress: &mut dyn FnMut(u64, u64),
    ) -> MaterialResult<ImportItemOutcome> {
        if !source_path.is_file() {
            return Err(MaterialError::new(
                "source-missing",
                format!("素材文件不存在: {}", source_path.to_string_lossy()),
            ));
        }
        let normalized_source = normalize_path_identity(source_path);
        let temporary = (storage_mode == "managed").then(|| library_dir.join(format!(".luckyray-import-{}.tmp", unique_id("stream"))));
        // Only this newly allocated staging file is disposable, never the source.
        let _cleanup = StagedFileCleanup(temporary.clone());
        let (hash, size) = stream_import_file(source_path, temporary.as_deref(), progress)?;
        if storage_mode == "managed" {
            return self.import_managed_file_atomic(
                conn,
                library_dir,
                file_name,
                &normalized_source,
                "",
                "",
                temporary.as_deref().expect("managed staging file"),
                &hash,
                size,
                folder_id,
                None,
                false,
            );
        }
        #[cfg(test)]
        self.wait_at_import_barrier();
        begin_transaction(conn)?;
        let operation = (|| {
            let existing_id = conn
                .query_row(
                "SELECT id FROM asset WHERE COALESCE(storage_mode, 'linked') = ?1 AND lower(replace(original_path, '\\', '/')) = ?2 AND id IN (SELECT asset_id FROM temp.material_visible_asset) LIMIT 1",
                rusqlite::params![storage_mode, normalized_source.to_ascii_lowercase()],
                |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| MaterialError::database("查询重复路径素材失败", error))?;
            if let Some(existing_id) = existing_id {
                let folder_changed = update_duplicate_folder(conn, &existing_id, folder_id)?;
                let source_changed = if storage_mode == "source" {
                    let current = read_asset(conn, &existing_id)?;
                    let canonical = canonical_regular_file(source_path)?;
                    let path_text = normalize_path_identity(&canonical);
                    let kind = kind_from_name(file_name).to_string();
                    let size_bytes = i64::try_from(size).unwrap_or(i64::MAX);
                    let thumbnail_url = if kind == "image" {
                        path_text.clone()
                    } else {
                        String::new()
                    };
                    if current.original_path != path_text
                        || current.library_path.as_deref() != Some(path_text.as_str())
                        || current.content_hash.as_deref() != Some(hash.as_str())
                        || current.size_bytes != Some(size_bytes)
                        || current.kind != kind
                        || current.thumbnail_url != thumbnail_url
                    {
                        conn.execute(
                            "UPDATE asset SET original_path=?1, library_path=?1, content_hash=?2, size_bytes=?3, kind=?4, thumbnail_url=?5, updated_at=?6 WHERE id=?7",
                            rusqlite::params![path_text, hash, size_bytes, kind, thumbnail_url, now(), existing_id],
                        )
                        .map_err(|error| {
                            MaterialError::database("刷新源素材文件身份失败", error)
                        })?;
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                commit_transaction(conn)?;
                return Ok(ImportItemOutcome {
                    asset: None,
                    changed: folder_changed || source_changed,
                });
            }
            let id = unique_id("asset");
            let kind = kind_from_name(file_name).to_string();
            let size_bytes = i64::try_from(size).unwrap_or(i64::MAX);
            let library_path = (storage_mode == "source").then(|| normalized_source.clone());
            let thumbnail_url = if kind == "image" {
                library_path
                    .as_deref()
                    .unwrap_or(&normalized_source)
                    .to_string()
            } else {
                String::new()
            };
            let timestamp = now();
            prepare_new_member(conn,"asset",&id)?;
            conn.execute(
                "INSERT INTO asset (
                id, name, original_path, library_path, storage_mode, kind, mime_type,
                size_bytes, thumbnail_url, description, rating, dominant_color, folder_id,
                imported_at, updated_at, content_hash
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, '', NULL, NULL, ?9, ?10, ?10, ?11)",
                rusqlite::params![
                    id,
                    file_name,
                    normalized_source,
                    library_path,
                    storage_mode,
                    kind,
                    size_bytes,
                    thumbnail_url,
                    folder_id,
                    timestamp,
                    hash
                ],
            )
            .map_err(|error| MaterialError::database("写入素材记录失败", error))?;
            bind_new_member(conn, "asset", &id)?;
            let asset = read_asset(conn, &id)?;
            commit_transaction(conn)?;
            Ok(ImportItemOutcome {
                asset: Some(asset),
                changed: true,
            })
        })();
        if operation.is_err() {
            let _ = rollback_transaction(conn);
        }
        operation
    }

    pub(crate) fn list_assets(
        &self,
        filter: &MaterialFilter,
    ) -> MaterialResult<Vec<MaterialAsset>> {
        self.list_assets_scoped(filter, &MaterialQueryScope::default())
    }

    pub(crate) fn list_assets_scoped(&self, filter: &MaterialFilter, scope: &MaterialQueryScope) -> MaterialResult<Vec<MaterialAsset>> {
        self.list_assets_page_scoped(filter, scope, 0)
    }

    /// Companion pages use the same storage/category predicates as the desktop.
    pub(crate) fn list_assets_page_scoped(&self, filter: &MaterialFilter, scope: &MaterialQueryScope, offset: u64) -> MaterialResult<Vec<MaterialAsset>> {
        if !self.db_path.exists() {
            return Ok(Vec::new());
        }
        let conn = self.open_read()?;
        let mut sql = String::from(
            "SELECT a.id, a.name, a.original_path, a.library_path, \
             COALESCE(a.storage_mode, 'linked'), a.kind, COALESCE(a.mime_type, ''), \
             a.size_bytes, COALESCE(a.thumbnail_url, ''), COALESCE(a.description, ''), \
             a.rating, a.dominant_color, a.folder_id, a.imported_at, \
             COALESCE(a.updated_at, a.imported_at), a.content_hash FROM asset a",
        );
        let mut conditions = vec![scope_condition(&conn, scope, "a.id")?];
        let mut values = Vec::<Value>::new();
        if let Some(query)=non_empty(filter.query.as_deref()) {
            if query.len()>4096 {return Err(MaterialError::new("material-query-invalid","搜索内容过长"))}
            conditions.push("(instr(lower(a.name),lower(?))>0 OR instr(lower(COALESCE(a.description,'')),lower(?))>0)".into());
            values.push(Value::Text(query.to_string()));values.push(Value::Text(query.to_string()));
        }

        if !filter.tag_ids.is_empty() {
            let placeholders = repeat_placeholders(filter.tag_ids.len());
            conditions.push(format!(
                "a.id IN (SELECT item_id FROM item_tag WHERE item_type = 'asset' \
                 AND tag_id IN ({placeholders}) GROUP BY item_id \
                 HAVING COUNT(DISTINCT tag_id) = {})",
                filter.tag_ids.len()
            ));
            values.extend(filter.tag_ids.iter().cloned().map(Value::Text));
        }
        if !filter.kinds.is_empty() {
            conditions.push(format!(
                "a.kind IN ({})",
                repeat_placeholders(filter.kinds.len())
            ));
            values.extend(filter.kinds.iter().cloned().map(Value::Text));
        }
        if let Some(folder_id) = non_empty(filter.folder_id.as_deref()) {
            conditions.push("a.folder_id = ?".to_string());
            values.push(Value::Text(folder_id.to_string()));
        }
        if let Some(color) = normalize_color(filter.dominant_color.as_deref()) {
            conditions.push(
                "(a.dominant_color = ? OR a.dominant_color LIKE ? OR \
                 a.dominant_color LIKE ? OR a.dominant_color LIKE ?)"
                    .to_string(),
            );
            values.push(Value::Text(color.clone()));
            values.push(Value::Text(format!("{color},%")));
            values.push(Value::Text(format!("%,{color}")));
            values.push(Value::Text(format!("%,{color},%")));
        }
        if let Some(rating_min) = filter.rating_min {
            conditions.push("COALESCE(a.rating, 0) >= ?".to_string());
            values.push(Value::Integer(rating_min));
        }
        if let Some(date_from) = non_empty(filter.date_from.as_deref()) {
            conditions.push("a.imported_at >= ?".to_string());
            values.push(Value::Text(date_from.to_string()));
        }
        if let Some(date_to) = non_empty(filter.date_to.as_deref()) {
            conditions.push("a.imported_at < ?".to_string());
            values.push(Value::Text(date_to.to_string()));
        }
        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }
        sql.push_str(" ORDER BY a.imported_at DESC, a.id DESC");
        let limit = if filter.recent_only {
            Some(50)
        } else {
            filter.limit.filter(|value| *value > 0)
        };
        if let Some(limit) = limit {
            sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
        }

        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| MaterialError::database("准备素材查询失败", error))?;
        let rows = statement
            .query_map(params_from_iter(values), material_asset_from_row)
            .map_err(|error| MaterialError::database("查询素材失败", error))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| MaterialError::database("读取素材结果失败", error))
    }

    pub(crate) fn get_assets(&self, asset_ids: &[String]) -> MaterialResult<Vec<MaterialAsset>> {
        if asset_ids.is_empty() || asset_ids.len() > MAX_TARGETED_ASSET_READS {
            return Err(MaterialError::new(
                "material-target-selection-invalid",
                "请选择 1 到 64 个素材",
            ));
        }
        if asset_ids.iter().any(|id| {
            id.is_empty() || id.len() > 256 || id.trim() != id || id.chars().any(char::is_control)
        }) {
            return Err(MaterialError::new(
                "material-target-selection-invalid",
                "素材选择无效",
            ));
        }
        if !self.db_path.exists() {
            return Ok(Vec::new());
        }
        let connection = self.open_read()?;
        let mut seen = HashSet::new();
        let mut assets = Vec::with_capacity(asset_ids.len());
        for asset_id in asset_ids {
            if !seen.insert(asset_id.as_str()) {
                continue;
            }
            match read_asset(&connection, asset_id) {
                Ok(asset) => assets.push(asset),
                Err(error) if error.code == "not-found" => {}
                Err(error) => return Err(error),
            }
        }
        Ok(assets)
    }

    /// The local export adapter must not turn a guessed path or a hidden note
    /// attachment id into file authority. Resolve one ordinary catalog row by
    /// id, then reuse the catalog's storage-mode-specific physical-file gate.
    pub(crate) fn get_ordinary_export_asset(&self, asset_id: &str) -> MaterialResult<MaterialAsset> {
        let asset = self.get_assets(&[asset_id.to_owned()])?.into_iter().next()
            .ok_or_else(|| MaterialError::new("export-asset-missing", "素材记录已不存在"))?;
        let conn = self.open_read()?;
        let ordinary = scope_condition(&conn, &MaterialQueryScope::default(), "a.id")?;
        let sql = format!("SELECT EXISTS(SELECT 1 FROM asset a WHERE a.id=?1 AND {ordinary})");
        let visible: bool = conn.query_row(&sql, [asset_id], |row| row.get(0))
            .map_err(|error| MaterialError::database("验证普通素材范围失败", error))?;
        if !visible {
            return Err(MaterialError::new("export-asset-scope", "不能从普通素材导出中读取知识库附件"));
        }
        Ok(asset)
    }

    /// One bounded read transaction supplies the CSV confirmation snapshot.
    /// Only catalog columns are projected; no source-file resolver or media IO.
    pub(super) fn csv_metadata_snapshot(&self, request: CsvExportPlanRequest) -> MaterialResult<CsvSnapshot> {
        let conn = self.open_read()?;
        conn.execute_batch("BEGIN DEFERRED")
            .map_err(|error| MaterialError::database("开始清单快照失败", error))?;
        // Resolve only folder metadata required by the requested scope/rows.
        // A large number of unrelated folders must not block one selected ID.
        let mut folders = HashMap::<String, (Option<String>, String)>::new();

        let (ids, folder_scope, scope_label, descendants) = match request {
            CsvExportPlanRequest::Assets { asset_ids } => {
                if asset_ids.is_empty() || asset_ids.len() > 1000 || asset_ids.iter().any(|id|
                    id.is_empty() || id.len() > 256 || id.trim() != id || id.chars().any(char::is_control)) {
                    return Err(MaterialError::new("csv-selection-invalid", "请选择有效的素材记录"));
                }
                let mut seen = HashSet::new();
                let ids = asset_ids.into_iter().filter(|id| seen.insert(id.clone())).collect::<Vec<_>>();
                if ids.len() > 500 { return Err(MaterialError::new("csv-too-many-rows", "清单超过 500 行，请缩小选择范围")); }
                (ids, false, "选中素材".to_owned(), false)
            }
            CsvExportPlanRequest::Folder { folder_id } => {
                let folder = conn.query_row("SELECT parent_id,name FROM folder WHERE id=?1 AND scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder)",
                    [&folder_id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)))
                    .optional().map_err(|error| MaterialError::database("查询目标分类失败", error))?
                    .ok_or_else(||
                    MaterialError::new("csv-folder-missing", "所选分类已不存在，请重新选择"))?;
                folders.insert(folder_id.clone(), folder.clone());
                // UNION de-duplicates IDs even if malformed parent links cycle.
                // The 10k bound protects the query without counting unrelated folders.
                let folder_count: i64 = conn.query_row("WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM folder WHERE id=?1 AND scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder)
                    UNION SELECT f.id FROM folder f JOIN subtree s ON f.parent_id=s.id WHERE f.scope='materials'
                ) SELECT COUNT(*) FROM (SELECT id FROM subtree LIMIT 10001)", [&folder_id], |row| row.get(0))
                    .map_err(|error| MaterialError::database("核对分类范围失败", error))?;
                if folder_count > 10_000 {
                    return Err(MaterialError::new("csv-too-many-folders", "所选分类子树超过 10000 个分类，请缩小范围"));
                }
                (vec![folder_id], true, folder.1, true)
            }
        };
        let ordinary = scope_condition(&conn, &MaterialQueryScope::default(), "a.id")?;
        let prefix = if folder_scope { "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM folder WHERE id=?1 AND scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder)
            UNION SELECT f.id FROM folder f JOIN subtree s ON f.parent_id=s.id WHERE f.scope='materials'
        ) " } else { "" };
        let scope = if folder_scope { "a.folder_id IN (SELECT id FROM subtree)".to_owned() }
            else { format!("a.id IN ({})", repeat_placeholders(ids.len())) };
        let sql = format!("{prefix}SELECT a.id,a.name,a.kind,COALESCE(a.mime_type,''),a.size_bytes,a.folder_id,
            a.rating,a.imported_at,COALESCE(a.description,''),a.original_path,
            s.page_url,s.page_kind,s.title FROM asset a LEFT JOIN asset_source_page s ON s.asset_id=a.id
            WHERE {ordinary} AND {scope} ORDER BY a.imported_at,a.id LIMIT 501");
        let mut statement = conn.prepare(&sql)
            .map_err(|error| MaterialError::database("准备清单快照失败", error))?;
        let mapped = statement.query_map(params_from_iter(ids.iter()), |row| {
            let original: String = row.get(9)?;
            let url: Option<String> = row.get(10)?;
            let page_kind: Option<String> = row.get(11)?;
            let title: Option<String> = row.get(12)?;
            let safe_page = url.zip(page_kind).and_then(|(url, kind)|
                MaterialSourcePageInput::from_parts(&url, &kind, title.as_deref()));
            let source_type = csv_source_type(&original, safe_page.as_ref().map(|page| page.page_kind.as_str()));
            Ok((CsvRow {
                id: row.get(0)?, name: row.get(1)?, kind: row.get(2)?, mime_type: row.get(3)?,
                size_bytes: row.get(4)?, folder_name: String::new(), folder_path: Vec::new(), tags: Vec::new(),
                rating: row.get(6)?, imported_at: row.get(7)?, description: row.get(8)?,
                source_type: source_type.to_owned(),
                source_title: safe_page.as_ref().and_then(|page| page.title.clone()).unwrap_or_default(),
                source_page_url: safe_page.map(|page| page.page_url).unwrap_or_default(),
            }, row.get::<_, Option<String>>(5)?))
        }).map_err(|error| MaterialError::database("查询清单快照失败", error))?;
        let mut rows = mapped.collect::<Result<Vec<_>, _>>()
            .map_err(|error| MaterialError::database("读取清单快照失败", error))?;
        drop(statement);
        if rows.len() > 500 { return Err(MaterialError::new("csv-too-many-rows", "清单超过 500 行，请缩小分类范围")); }
        if !folder_scope && rows.len() != ids.len() {
            return Err(MaterialError::new("csv-selection-stale", "部分选中素材已失效或不是普通素材，请重新选择"));
        }
        for (row, folder_id) in &mut rows {
            let mut path = Vec::new();
            let mut cursor = folder_id.clone();
            let mut visited = HashSet::new();
            while let Some(id) = cursor {
                if path.len() >= 128 || !visited.insert(id.clone()) {
                    return Err(MaterialError::new("csv-folder-depth", "分类层级超过 128 层或存在循环，不能安全导出"));
                }
                let (parent, name) = if let Some(folder) = folders.get(&id) { folder.clone() } else {
                    let folder = conn.query_row("SELECT parent_id,name FROM folder WHERE id=?1 AND scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder)",
                        [&id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)))
                        .optional().map_err(|error| MaterialError::database("查询分类层级失败", error))?
                        .ok_or_else(|| MaterialError::new("csv-folder-stale", "素材分类已失效，请重试"))?;
                    folders.insert(id, folder.clone());
                    folder
                };
                path.push(name);
                cursor = parent;
            }
            path.reverse();
            row.folder_name = path.last().cloned().unwrap_or_default();
            row.folder_path = path;
        }
        let mut positions = HashMap::new();
        for (index, (row, _)) in rows.iter().enumerate() { positions.insert(row.id.clone(), index); }
        let row_ids = rows.iter().map(|(row, _)| row.id.clone()).collect::<Vec<_>>();
        for chunk in row_ids.chunks(400) {
            let sql = format!("SELECT i.item_id,t.name FROM item_tag i JOIN temp.material_visible_tag t ON t.id=i.tag_id
                WHERE i.item_type='asset' AND i.item_id IN ({}) ORDER BY i.item_id,i.created_at,i.id", repeat_placeholders(chunk.len()));
            let mut statement = conn.prepare(&sql)
                .map_err(|error| MaterialError::database("准备清单标签失败", error))?;
            let tags = statement.query_map(params_from_iter(chunk.iter()), |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| MaterialError::database("查询清单标签失败", error))?;
            for tag in tags {
                let (id, name) = tag.map_err(|error| MaterialError::database("读取清单标签失败", error))?;
                if let Some(index) = positions.get(&id) { rows[*index].0.tags.push(name); }
            }
        }
        Ok(CsvSnapshot { rows: rows.into_iter().map(|(row, _)| row).collect(), scope_label, includes_descendants: descendants })
    }

    pub(crate) fn resolve_export_file(&self, asset: &MaterialAsset) -> MaterialResult<PathBuf> {
        read_asset(&self.open_read()?,&asset.id)?;
        let candidate = match asset.storage_mode.as_str() {
            "managed" | "source" => asset.library_path.as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(asset.original_path.as_str()),
            "linked" => asset.original_path.as_str(),
            _ => return Err(MaterialError::new("export-source-invalid", "素材没有可导出的本地原文件")),
        };
        if candidate.is_empty() || candidate.starts_with("browser:") {
            return Err(MaterialError::new("export-source-invalid", "素材没有可导出的本地原文件"));
        }
        self.resolve_physical_file(&asset.storage_mode, Path::new(candidate))
    }

    pub(crate) fn export_protected_roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![self.app_data_dir.canonicalize()
            .unwrap_or_else(|_| self.app_data_dir.clone())];
        roots.extend(self.trusted_managed_roots().into_iter().map(|root| root.root_path));
        roots
    }

    pub(crate) fn get_source_page(&self, asset_id: &str) -> MaterialResult<Option<MaterialSourcePage>> {
        if asset_id.is_empty() || asset_id.len() > 256 || asset_id.trim() != asset_id
            || asset_id.chars().any(char::is_control) {
            return Err(MaterialError::new("material-target-selection-invalid", "素材选择无效"));
        }
        let conn = self.open_read()?;
        match read_asset(&conn,asset_id) {Ok(_)=>{},Err(e) if e.code=="not-found"=>return Ok(None),Err(e)=>return Err(e)};
        let stored = conn.query_row(
            "SELECT s.page_url, s.page_kind, s.title FROM asset_source_page s
             JOIN asset a ON a.id=s.asset_id WHERE s.asset_id=?1",
            [asset_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
        ).optional().map_err(|error| MaterialError::database("读取来源页面失败", error))?;
        Ok(stored.and_then(|(url, kind, title)| {
            MaterialSourcePageInput::from_parts(&url, &kind, title.as_deref()).map(|safe| MaterialSourcePage {
                asset_id: asset_id.to_owned(),
                page_url: safe.page_url,
                page_kind: safe.page_kind,
                title: safe.title,
            })
        }))
    }

    pub(crate) fn find_managed_asset_by_hash(&self, hash: &str) -> MaterialResult<Option<MaterialAsset>> {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(MaterialError::new("material-hash-invalid", "素材哈希无效"));
        }
        let conn = self.open_read()?;
        let id = conn.query_row(
            "SELECT id FROM asset WHERE COALESCE(storage_mode,'linked')='managed' AND content_hash=?1 AND id IN (SELECT asset_id FROM temp.material_visible_asset) LIMIT 1",
            [hash], |row| row.get::<_, String>(0),
        ).optional().map_err(|error| MaterialError::database("查询重复素材失败", error))?;
        id.map(|id| read_asset(&conn, &id)).transpose()
    }

    /// Resolve only a catalog-owned object; callers never supply a filesystem path.
    pub(crate) fn companion_resource(&self, asset_id: &str, thumbnail: bool) -> MaterialResult<(MaterialAsset, std::fs::File)> {
        let connection = self.open_read()?;
        let asset = read_asset(&connection, asset_id)?;
        let candidate = match asset.storage_mode.as_str() {
            "managed" | "source" => asset.library_path.as_deref().filter(|s| !s.is_empty()).unwrap_or(&asset.original_path),
            "linked" => &asset.original_path,
            _ => return Err(MaterialError::new("material-resource-unavailable", "素材存储方式不可用")),
        };
        let path = if thumbnail && asset.kind == "video" {
            let root = self.app_data_dir.join("thumbnails").join("video");
            // Never follow a database thumbnail URL to an arbitrary local file.
            if asset_id.is_empty() || !asset_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
                return Err(MaterialError::new("material-resource-unavailable", "预览不可用"));
            }
            let root = root.canonicalize().map_err(|e| MaterialError::io("material-resource-unavailable", "预览尚未生成", e))?;
            ["jpg", "jpeg", "png", "webp"].iter().filter_map(|ext| root.join(format!("{asset_id}.{ext}")).canonicalize().ok())
                .find(|path| path.starts_with(&root)).ok_or_else(|| MaterialError::new("material-resource-unavailable", "预览尚未生成"))?
        } else {
            self.resolve_physical_file(&asset.storage_mode, Path::new(candidate))?
        };
        let file = crate::companion_gateway::content::open_resource(path).map_err(|e| MaterialError::io("material-resource-unavailable", "文件暂时不可用", e))?;
        if !file.metadata().map_err(|e| MaterialError::io("material-resource-unavailable", "文件暂时不可用", e))?.is_file() {
            return Err(MaterialError::new("material-resource-unavailable", "文件暂时不可用"));
        }
        Ok((asset, file))
    }

    pub(crate) fn read_agent_text_preview(
        &self,
        asset_id: &str,
        max_bytes: usize,
    ) -> MaterialResult<Option<(String, bool)>> {
        if max_bytes == 0 || max_bytes > 64 * 1024 {
            return Err(MaterialError::new(
                "agent-preview-invalid",
                "素材预览范围无效",
            ));
        }
        let connection = self.open_read()?;
        let asset = read_asset(&connection, asset_id)?;
        let extension = Path::new(&asset.name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let text_like = asset.kind == "text"
            || asset.mime_type.starts_with("text/")
            || matches!(
                extension.as_str(),
                "md" | "txt"
                    | "json"
                    | "csv"
                    | "html"
                    | "htm"
                    | "xml"
                    | "yaml"
                    | "yml"
                    | "toml"
                    | "js"
                    | "jsx"
                    | "ts"
                    | "tsx"
                    | "css"
                    | "py"
                    | "rs"
            );
        if !text_like {
            return Ok(None);
        }
        let candidate = match asset.storage_mode.as_str() {
            "managed" | "source" => asset
                .library_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .unwrap_or(asset.original_path.as_str()),
            "linked" => asset.original_path.as_str(),
            _ => {
                return Err(MaterialError::new(
                    "agent-preview-unavailable",
                    "素材预览不可用",
                ));
            }
        };
        let path = self.resolve_physical_file(&asset.storage_mode, Path::new(candidate))?;
        let mut file = std::fs::File::open(&path).map_err(|error| {
            MaterialError::io("agent-preview-unavailable", "无法读取素材预览", error)
        })?;
        let mut bytes = Vec::with_capacity(max_bytes.saturating_add(1));
        file.by_ref()
            .take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                MaterialError::io("agent-preview-unavailable", "无法读取素材预览", error)
            })?;
        if bytes.iter().any(|byte| *byte == 0) {
            return Ok(None);
        }
        let truncated = bytes.len() > max_bytes;
        bytes.truncate(max_bytes);
        let text = match std::str::from_utf8(&bytes) {
            Ok(value) => value,
            Err(error) if truncated && error.error_len().is_none() => {
                let valid = error.valid_up_to();
                bytes.truncate(valid);
                std::str::from_utf8(&bytes).map_err(|_| {
                    MaterialError::new("agent-preview-unavailable", "素材不是有效 UTF-8 文本")
                })?
            }
            Err(_) => return Ok(None),
        };
        Ok(Some((text.to_owned(), truncated)))
    }

    pub(crate) fn resolve_external_drag_files(
        &self,
        asset_ids: &[String],
    ) -> MaterialResult<Vec<PathBuf>> {
        if asset_ids.is_empty() || asset_ids.len() > MAX_EXTERNAL_DRAG_ASSETS {
            return Err(MaterialError::new(
                "external-drag-invalid-selection",
                "请选择 1 到 64 个素材拖到其他软件",
            ));
        }
        if asset_ids.iter().any(|id| {
            id.is_empty() || id.len() > 256 || id.trim() != id || id.chars().any(char::is_control)
        }) {
            return Err(MaterialError::new(
                "external-drag-invalid-selection",
                "素材选择无效",
            ));
        }

        let assets = self
            .list_assets_scoped(&MaterialFilter::default(), &MaterialQueryScope { scope: "all".into(), ..Default::default() })?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect::<HashMap<_, _>>();
        let mut paths = Vec::with_capacity(asset_ids.len());
        let mut seen_paths = HashSet::new();

        for asset_id in asset_ids {
            let asset = assets.get(asset_id).ok_or_else(|| {
                MaterialError::new(
                    "external-drag-asset-unavailable",
                    "所选素材已不存在，请刷新素材库后重试",
                )
            })?;
            let candidate = match asset.storage_mode.as_str() {
                "managed" | "source" => asset
                    .library_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                    .unwrap_or(asset.original_path.as_str()),
                "linked" => asset.original_path.as_str(),
                _ => {
                    return Err(MaterialError::new(
                        "external-drag-asset-unavailable",
                        "所选素材无法安全拖到其他软件",
                    ));
                }
            };
            let path = self
                .resolve_physical_file(&asset.storage_mode, Path::new(candidate))
                .map_err(|_| {
                    MaterialError::new(
                        "external-drag-asset-unavailable",
                        "所选素材文件不可用，请重新定位后再试",
                    )
                })?;
            let path_key = canonical_path_key(&path);
            if seen_paths.insert(path_key) {
                paths.push(path);
            }
        }
        Ok(paths)
    }

    pub(crate) fn resolve_open_in_lightseek_paths(
        &self,
        asset_ids: &[String],
    ) -> MaterialResult<Vec<PathBuf>> {
        if asset_ids.is_empty() || asset_ids.len() > MAX_EXTERNAL_DRAG_ASSETS {
            return Err(MaterialError::new(
                "lightseek-material-selection-invalid",
                "请选择 1 到 64 个素材发送到 LightSeek",
            ));
        }
        if asset_ids.iter().any(|id| {
            id.is_empty() || id.len() > 256 || id.trim() != id || id.chars().any(char::is_control)
        }) {
            return Err(MaterialError::new(
                "lightseek-material-selection-invalid",
                "素材选择无效",
            ));
        }

        let assets = self
            .list_assets_scoped(&MaterialFilter::default(), &MaterialQueryScope { scope: "all".into(), ..Default::default() })?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect::<HashMap<_, _>>();
        let mut paths = Vec::with_capacity(asset_ids.len());
        for asset_id in asset_ids {
            let asset = assets.get(asset_id).ok_or_else(|| {
                MaterialError::new(
                    "lightseek-material-unavailable",
                    "素材原文件已移动或不存在，请在素材库重新定位后重试",
                )
            })?;
            let candidate = match asset.storage_mode.as_str() {
                "managed" | "source" => asset
                    .library_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                    .unwrap_or(asset.original_path.as_str()),
                "linked" => asset.original_path.as_str(),
                _ => {
                    return Err(MaterialError::new(
                        "lightseek-material-unavailable",
                        "素材原文件已移动或不存在，请在素材库重新定位后重试",
                    ));
                }
            };
            let path = self
                .resolve_physical_file(&asset.storage_mode, Path::new(candidate))
                .map_err(|_| {
                    MaterialError::new(
                        "lightseek-material-unavailable",
                        "素材原文件已移动或不存在，请在素材库重新定位后重试",
                    )
                })?;
            paths.push(path);
        }
        Ok(paths)
    }

    pub(crate) fn search_assets(
        &self,
        fts_query: &str,
        limit: usize,
    ) -> MaterialResult<Vec<MaterialAssetSearchHit>> {
        self.search_assets_scoped(fts_query, limit, &MaterialQueryScope::default())
    }
    pub(crate) fn search_assets_scoped(&self, fts_query: &str, limit: usize, scope: &MaterialQueryScope) -> MaterialResult<Vec<MaterialAssetSearchHit>> {
        if !self.db_path.exists() || fts_query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.open_read()?;
        let mut statement = conn
            .prepare(
                &format!("SELECT a.id, a.name, a.original_path, a.library_path,
             COALESCE(a.storage_mode, 'linked'), a.kind, COALESCE(a.mime_type, ''),
             a.size_bytes, COALESCE(a.thumbnail_url, ''), COALESCE(a.description, ''),
             a.rating, a.dominant_color, a.folder_id, a.imported_at,
             COALESCE(a.updated_at, a.imported_at), a.content_hash,
             snippet(asset_search, 2, '<b>', '</b>', '...', 32)
             FROM asset_search JOIN asset a ON a.id=asset_search.id
             WHERE asset_search MATCH ?1 AND {} ORDER BY rank LIMIT ?2", scope_condition(&conn, scope, "a.id")?),
            )
            .map_err(|error| MaterialError::database("准备素材全文搜索失败", error))?;
        let hits = statement
            .query_map(
                rusqlite::params![fts_query, i64::try_from(limit.max(1)).unwrap_or(i64::MAX)],
                |row| {
                    Ok(MaterialAssetSearchHit {
                        asset: material_asset_from_row(row)?,
                        snippet: row.get::<_, Option<String>>(16)?.unwrap_or_default(),
                    })
                },
            )
            .map_err(|error| MaterialError::database("查询素材全文搜索失败", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| MaterialError::database("读取素材全文搜索结果失败", error))?;
        Ok(hits)
    }

    pub(crate) fn update_asset(
        &self,
        id: &str,
        patch: MaterialAssetPatch,
        reason: &str,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        if patch.storage_mode.is_some()
            || patch.original_path.is_some()
            || !matches!(patch.library_path, PatchValue::Missing)
        {
            return Err(MaterialError::new(
                "unsafe-material-path-patch",
                "素材物理路径与存储模式不能通过通用更新接口修改",
            ));
        }
        let conn = self.open_write()?;
        let version_before = read_change(&conn)?.version;
        let mut current = match read_asset(&conn, id) {
            Ok(asset) => asset,
            Err(error) if error.code == "not-found" => {
                return Ok(CatalogOutcome {
                    value: None,
                    change: None,
                })
            }
            Err(error) => return Err(error),
        };
        let before = current.clone();
        if let PatchValue::Value(Some(folder_id)) = &patch.folder_id {
            validate_material_folder(&conn, Some(folder_id))?;
        }
        if let Some(name) = patch.name.filter(|value| !value.trim().is_empty()) {
            current.name = name.trim().to_string();
        }
        if let Some(description) = patch.description {
            current.description = description;
        }
        if let PatchValue::Value(rating) = patch.rating {
            current.rating = rating.map(|value| value.clamp(0, 5));
        }
        if let PatchValue::Value(color) = patch.dominant_color {
            current.dominant_color = color;
        }
        if let Some(path) = patch.original_path {
            current.original_path = path;
        }
        if let PatchValue::Value(path) = patch.library_path {
            current.library_path = path;
        }
        if let Some(kind) = patch.kind {
            current.kind = kind;
        }
        if let Some(mime_type) = patch.mime_type {
            current.mime_type = mime_type;
        }
        if let PatchValue::Value(size) = patch.size_bytes {
            current.size_bytes = size;
        }
        if let Some(thumbnail) = patch.thumbnail_url {
            current.thumbnail_url = thumbnail;
        }
        if let PatchValue::Value(folder_id) = patch.folder_id {
            current.folder_id = folder_id;
        }
        if current == before {
            return Ok(CatalogOutcome {
                value: Some(before),
                change: None,
            });
        }
        current.updated_at = now();
        let affected = conn
            .execute(
                "UPDATE asset SET name=?1, original_path=?2, library_path=?3, storage_mode=?4,
             kind=?5, mime_type=?6, size_bytes=?7, thumbnail_url=?8, description=?9,
             rating=?10, dominant_color=?11, folder_id=?12, updated_at=?13 WHERE id=?14",
                rusqlite::params![
                    current.name,
                    current.original_path,
                    current.library_path,
                    current.storage_mode,
                    current.kind,
                    current.mime_type,
                    current.size_bytes,
                    current.thumbnail_url,
                    current.description,
                    current.rating,
                    current.dominant_color,
                    current.folder_id,
                    current.updated_at,
                    id
                ],
            )
            .map_err(|error| MaterialError::database("更新素材失败", error))?;
        if affected == 0 {
            return Ok(CatalogOutcome {
                value: None,
                change: None,
            });
        }
        let value = read_asset(&conn, id)?;
        let change = finalize_change(&conn, version_before, reason, vec![id.to_string()], false)?;
        Ok(CatalogOutcome {
            value: Some(value),
            change,
        })
    }

    pub(crate) fn relocate_asset(
        &self,
        id: &str,
        target: &Path,
        options: &MaterialRelocateOptions,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        self.relocate_asset_with_revision(id, target, options, None)
    }

    pub(crate) fn relocate_asset_with_revision(
        &self,
        id: &str,
        target: &Path,
        options: &MaterialRelocateOptions,
        expected_revision: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        self.relocate_asset_internal(id, target, options, expected_revision, None)
    }

    /// Internal note coordinator only: the full cross-vault reference snapshot
    /// is rechecked under the same database write transaction as the mutation.
    pub(crate) fn relocate_asset_for_note_coordinator(
        &self, id: &str, target: &Path,
        options: &MaterialRelocateOptions,
        expected_revision: Option<&str>,
        expected_references: &[NoteAttachmentReference],
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        self.for_attachment_projection().relocate_asset_internal(id, target, options, expected_revision, Some(expected_references))
    }

    fn relocate_asset_internal(
        &self, id: &str, target: &Path,
        options: &MaterialRelocateOptions,
        expected_revision: Option<&str>,
        expected_references: Option<&[NoteAttachmentReference]>,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let operation = (|| {
            let current = match read_asset(&conn, id) {
                Ok(asset) => asset,
                Err(error) if error.code == "not-found" => {
                    commit_transaction(&conn)?;
                    return Ok(CatalogOutcome {
                        value: None,
                        change: None,
                    });
                }
                Err(error) => return Err(error),
            };
            assert_asset_revision(&conn, &current, expected_revision)?;
            if let Some(snapshot) = expected_references {
                note_attachments::assert_reference_snapshot(&conn, id, snapshot)?;
            } else {
                protect_note_attachment(&conn, id, true)?;
            }
            let version_before = read_change(&conn)?.version;
            let (canonical, content_hash) = match current.storage_mode.as_str() {
                "source" => {
                    let canonical =
                        self.validate_exclusive_physical_path(&conn, &current, target)?;
                    let content_hash = sha256_file(&canonical)?;
                    let matches_current = current
                        .content_hash
                        .as_deref()
                        .is_some_and(|expected| content_hash.eq_ignore_ascii_case(expected));
                    if !matches_current {
                        if !options.allow_source_content_change {
                            let mut error = MaterialError::new(
                                "source-relocate-content-mismatch",
                                "所选源文件内容与原素材不一致，需要用户确认后才能重新绑定",
                            );
                            error.details = Some(serde_json::json!({
                                "actualContentHash": content_hash,
                            }));
                            return Err(error);
                        }
                        let expected_hash = options
                            .expected_source_content_hash
                            .as_deref()
                            .filter(|hash| is_sha256_id(hash))
                            .ok_or_else(|| {
                                MaterialError::new(
                                    "source-relocate-confirmation-required",
                                    "重新绑定外部编辑后的源文件需要有效的确认身份",
                                )
                            })?;
                        if !content_hash.eq_ignore_ascii_case(expected_hash) {
                            return Err(MaterialError::new(
                                "source-relocate-target-changed",
                                "所选源文件在确认期间已发生变化，请重新选择",
                            ));
                        }
                    }
                    (canonical, content_hash)
                }
                "managed" | "linked" => {
                    let canonical = self.validate_physical_ownership(&conn, &current, target)?;
                    let content_hash = current.content_hash.clone().ok_or_else(|| {
                        MaterialError::new(
                            "physical-content-unverified",
                            "素材缺少可验证的内容身份，不能重新定位",
                        )
                    })?;
                    (canonical, content_hash)
                }
                _ => {
                    return Err(MaterialError::new(
                        "invalid-storage-mode",
                        "无效的素材存储模式",
                    ))
                }
            };
            let path_text = canonical.to_string_lossy().to_string();
            let kind = kind_from_name(
                canonical
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&current.name),
            )
            .to_string();
            let size = canonical
                .metadata()
                .map_err(|error| {
                    MaterialError::io(
                        "physical-path-unavailable",
                        "无法读取重新定位素材文件信息",
                        error,
                    )
                })?
                .len();
            let size = i64::try_from(size).unwrap_or(i64::MAX);
            let (original_path, library_path) = match current.storage_mode.as_str() {
                "managed" => (current.original_path.clone(), Some(path_text.clone())),
                "source" => (path_text.clone(), Some(path_text.clone())),
                "linked" => (path_text.clone(), None),
                _ => {
                    return Err(MaterialError::new(
                        "invalid-storage-mode",
                        "无效的素材存储模式",
                    ))
                }
            };
            if original_path == current.original_path
                && library_path == current.library_path
                && kind == current.kind
                && current.size_bytes == Some(size)
                && current.content_hash.as_deref() == Some(content_hash.as_str())
            {
                commit_transaction(&conn)?;
                return Ok(CatalogOutcome {
                    value: Some(current),
                    change: None,
                });
            }
            let timestamp = now();
            let thumbnail_url = if kind == "image" || kind == "video" {
                path_text
            } else {
                String::new()
            };
            conn.execute(
                "UPDATE asset SET original_path=?1, library_path=?2, kind=?3, size_bytes=?4, thumbnail_url=?5, content_hash=?6, updated_at=?7 WHERE id=?8",
                rusqlite::params![original_path, library_path, kind, size, thumbnail_url, content_hash, timestamp, id],
            )
            .map_err(|error| MaterialError::database("重新定位素材失败", error))?;
            note_attachments::refresh_attachment_binding(&conn, id, &canonical)?;
            let value = read_asset(&conn, id)?;
            let change = finalize_change(
                &conn,
                version_before,
                "material-relocate",
                vec![id.to_string()],
                false,
            )?;
            commit_transaction(&conn)?;
            Ok(CatalogOutcome {
                value: Some(value),
                change,
            })
        })();
        if operation.is_err() {
            let _ = rollback_transaction(&conn);
        }
        operation
    }

    pub(crate) fn rename_asset_file(
        &self,
        id: &str,
        file_name: &str,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        self.rename_asset_file_with_revision(id, file_name, None)
    }

    pub(crate) fn rename_asset_file_with_revision(
        &self,
        id: &str,
        file_name: &str,
        expected_revision: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        self.rename_asset_file_internal(id, file_name, expected_revision, None, None, None)
    }

    /// Internal note coordinator only: the full cross-vault reference snapshot
    /// is rechecked under the same database write transaction as the mutation.
    pub(crate) fn rename_asset_file_for_note_coordinator(
        &self, id: &str, file_name: &str,
        expected_revision: Option<&str>,
        expected_references: &[NoteAttachmentReference],
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        self.for_attachment_projection().rename_asset_file_internal(id, file_name, expected_revision, Some(expected_references), None, None)
    }

    /// Preflight the exact physical source and destination without moving bytes.
    pub(crate) fn prepare_note_file_move(&self,id:&str,target:&Path)->MaterialResult<(String,String,String)> {
        let conn=self.open_write()?;
        let asset=read_asset_unrestricted(&conn,id)?;
        let owned=self.validate_delete_physical_file(&conn,&asset)?;
        let name=target.file_name().and_then(|s|s.to_str()).ok_or_else(||MaterialError::new("invalid-file-name","目标文件名无效"))?;
        validate_asset_file_name(name)?;
        let destination=canonical_regular_leaf(target)?;
        if destination.exists() {return Err(MaterialError::new("physical-path-owned","目标文件已存在，不能覆盖"))}
        if asset.storage_mode=="managed" {self.resolve_trusted_managed_leaf(&destination)?;}
        ensure_path_not_owned_by_other_asset(&conn,id,&destination)?;
        Ok((owned.file_path.to_string_lossy().into_owned(),destination.to_string_lossy().into_owned(),owned.content_hash))
    }
    /// Used only after the Knowledge receipt records pending document rewrites.
    pub(crate) fn move_asset_file_for_note_coordinator(&self,id:&str,target:&Path,expected_revision:&str,expected_references:&[NoteAttachmentReference],expected_hash:&str)->MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        let name=target.file_name().and_then(|s|s.to_str()).ok_or_else(||MaterialError::new("invalid-file-name","目标文件名无效"))?;
        self.for_attachment_projection().rename_asset_file_internal(id,name,Some(expected_revision),Some(expected_references),Some(target),Some(expected_hash))
    }

    fn rename_asset_file_internal(
        &self, id: &str, file_name: &str,
        expected_revision: Option<&str>,
        expected_references: Option<&[NoteAttachmentReference]>,
        target_path: Option<&Path>,
        expected_content_hash: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialAsset>>> {
        let file_name = validate_asset_file_name(file_name)?;
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let mut renamed_paths: Option<(PathBuf, PathBuf)> = None;
        let operation = (|| {
            let current = match read_asset(&conn, id) {
                Ok(asset) => asset,
                Err(error) if error.code == "not-found" => {
                    commit_transaction(&conn)?;
                    return Ok(CatalogOutcome {
                        value: None,
                        change: None,
                    });
                }
                Err(error) => return Err(error),
            };
            assert_asset_revision(&conn, &current, expected_revision)?;
            if let Some(snapshot) = expected_references {
                note_attachments::assert_reference_snapshot(&conn, id, snapshot)?;
            } else {
                protect_note_attachment(&conn, id, true)?;
            }
            if current.storage_mode == "linked" {
                return Err(MaterialError::new(
                    "rename-file-unsafe-storage",
                    "链接引用素材不能重命名真实文件",
                ));
            }
            let version_before = read_change(&conn)?.version;
            let owned = self.validate_delete_physical_file(&conn, &current)?;
            if expected_content_hash.is_some_and(|expected|expected!=owned.content_hash) {
                return Err(MaterialError::new("attachment-version-changed","附件内容在预览后已变化，请重新预览"));
            }
            let parent = owned.file_path.parent().ok_or_else(|| {
                MaterialError::new("physical-path-untrusted", "素材真实文件缺少父目录")
            })?;
            let destination = target_path.map(Path::to_path_buf).unwrap_or_else(||parent.join(&file_name));
            if canonical_path_key(&destination) == canonical_path_key(&owned.file_path) {
                commit_transaction(&conn)?;
                return Ok(CatalogOutcome {
                    value: Some(current),
                    change: None,
                });
            }
            if destination.exists() {
                return Err(MaterialError::new(
                    "physical-path-owned",
                    "同目录下已存在目标文件",
                ));
            }
            let destination = canonical_regular_leaf(&destination)?;
            if current.storage_mode == "managed" {
                self.resolve_trusted_managed_leaf(&destination)?;
            }
            ensure_path_not_owned_by_other_asset(&conn, id, &destination)?;
            let _parent_guards=hold_material_parent_directories(&owned.file_path,&destination)?;
            let mut source_options=std::fs::OpenOptions::new();source_options.read(true);
            #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;source_options.access_mode(0x80010000).share_mode(1);}
            let mut source_guard=source_options.open(&owned.file_path).map_err(|e|MaterialError::io("attachment-file-busy","附件正被其他程序写入，请稍后重试",e))?;
            let source_identity=note_attachments::file_identity(&source_guard)?;
            if sha256_file(&owned.file_path)?!=owned.content_hash {return Err(MaterialError::new("attachment-version-changed","附件在移动前已变化，请重新预览"))}
            let copied_guard=move_owned_handle_no_replace(&mut source_guard, &destination).map_err(|error| {
                MaterialError::io("rename-file-failed", "重命名素材真实文件失败", error)
            })?;
            renamed_paths = Some((owned.file_path.clone(), destination.clone()));
            let destination_guard=std::fs::File::open(&destination).map_err(|e|MaterialError::io("attachment-unavailable","无法校验移动后的附件",e))?;
            let destination_identity=note_attachments::file_identity(&destination_guard)?;
            // Same-volume moves preserve file identity; cross-volume moves copy
            // bytes and are checked against the held, write-fenced source digest.
            if (source_identity.split(':').next()==destination_identity.split(':').next() && source_identity!=destination_identity) || sha256_file(&destination)?!=owned.content_hash {
                return Err(MaterialError::new("attachment-version-changed","附件在移动期间变化，正在恢复原位置"));
            }
            if copied_guard.is_some() {mark_held_file_for_deletion(&source_guard).map_err(|e|MaterialError::io("move-source-remove-failed","复制已验证但原文件尚未移除，已保留恢复记录",e))?;}
            drop(destination_guard);
            drop(copied_guard);
            drop(source_guard); // cross-volume delete disposition completes here
            let path_text = destination.to_string_lossy().to_string();
            let kind = kind_from_name(&file_name).to_string();
            let size = destination
                .metadata()
                .map_err(|error| {
                    MaterialError::io("physical-path-unavailable", "读取重命名文件信息失败", error)
                })?
                .len();
            let size = i64::try_from(size).unwrap_or(i64::MAX);
            let original_path = if current.storage_mode == "source" {
                path_text.clone()
            } else {
                current.original_path.clone()
            };
            let thumbnail_url = if kind == "image" || kind == "video" {
                path_text.clone()
            } else {
                String::new()
            };
            conn.execute(
                "UPDATE asset SET name=?1, original_path=?2, library_path=?3, kind=?4, size_bytes=?5, thumbnail_url=?6, content_hash=?7, updated_at=?8 WHERE id=?9",
                rusqlite::params![file_name, original_path, path_text, kind, size, thumbnail_url, owned.content_hash, now(), id],
            )
            .map_err(|error| MaterialError::database("更新重命名素材记录失败", error))?;
            note_attachments::refresh_attachment_binding(&conn, id, &destination)?;
            let value = read_asset(&conn, id)?;
            let change = finalize_change(
                &conn,
                version_before,
                "material-file-rename",
                vec![id.to_string()],
                false,
            )?;
            commit_transaction(&conn)?;
            renamed_paths = None;
            Ok(CatalogOutcome {
                value: Some(value),
                change,
            })
        })();
        if let Err(error) = operation {
            let _ = rollback_transaction(&conn);
            if let Some((original, renamed)) = renamed_paths {
                if let Err(restore_error) = move_owned_file_no_replace(&renamed, &original) {
                    return Err(MaterialError::new(
                        error.code,
                        format!("{}；恢复重命名文件失败: {restore_error}", error.message),
                    ));
                }
            }
            return Err(error);
        }
        operation
    }

    pub(crate) fn delete_asset(
        &self,
        id: &str,
        delete_file: bool,
    ) -> MaterialResult<CatalogOutcome<MaterialDeleteResult>> {
        self.delete_asset_with_revision(id, delete_file, None)
    }

    pub(crate) fn delete_asset_with_revision(
        &self,
        id: &str,
        delete_file: bool,
        expected_revision: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<MaterialDeleteResult>> {
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let current = match read_asset(&conn, id) {
            Ok(asset) => asset,
            Err(error) if error.code == "not-found" => {
                commit_transaction(&conn)?;
                return Ok(CatalogOutcome {
                    value: MaterialDeleteResult {
                        success: false,
                        cleanup_pending: false,
                    },
                    change: None,
                });
            }
            Err(error) => {
                let _ = rollback_transaction(&conn);
                return Err(error);
            }
        };
        assert_asset_revision(&conn, &current, expected_revision)?;
        if protect_note_attachment(&conn, id, delete_file)? {
            let change = publish_change_metadata(&conn, "material-demote", vec![id.to_string()], false)?;
            commit_transaction(&conn)?;
            return Ok(CatalogOutcome { value: MaterialDeleteResult { success: true, cleanup_pending: false }, change: Some(change) });
        }
        let version_before = match read_change(&conn) {
            Ok(change) => change.version,
            Err(error) => {
                let _ = rollback_transaction(&conn);
                return Err(error);
            }
        };
        let owned_file = if delete_file {
            match self.validate_delete_physical_file(&conn, &current) {
                Ok(file) => Some(file),
                Err(error) => {
                    let _ = rollback_transaction(&conn);
                    return Err(error);
                }
            }
        } else {
            None
        };
        let quarantine = match self.prepare_delete_quarantine(&current, owned_file.as_ref()) {
            Ok(quarantine) => quarantine,
            Err(error) => {
                let _ = rollback_transaction(&conn);
                return Err(error);
            }
        };
        let database_result: MaterialResult<Option<MaterialChange>> = (|| {
            if let Some(quarantine) = quarantine.as_ref() {
                conn.execute(
                    "INSERT INTO material_delete_pending_identity(token,asset_id,storage_mode,content_hash,canonical_path,root_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![
                        quarantine.record.token,
                        quarantine.record.asset_id,
                        quarantine.record.storage_mode,
                        quarantine.record.content_hash,
                        quarantine.original_path.to_string_lossy(),
                        quarantine.record.root_id,
                        now()
                    ],
                )
                .map_err(|error| MaterialError::database("记录素材删除物理身份失败", error))?;
            }
            conn.execute(
                "DELETE FROM item_tag WHERE item_type='asset' AND item_id=?1",
                [id],
            )
            .map_err(|error| MaterialError::database("清理素材标签失败", error))?;
            let deleted = conn
                .execute("DELETE FROM asset WHERE id=?1", [id])
                .map_err(|error| MaterialError::database("删除素材失败", error))?;
            if deleted == 0 {
                return Err(MaterialError::new(
                    "delete-record-changed",
                    "素材记录已变化，未执行文件删除",
                ));
            }
            let change = finalize_change(
                &conn,
                version_before,
                "material-delete",
                vec![id.to_string()],
                false,
            )?;
            commit_transaction(&conn)?;
            Ok(change)
        })();
        let change = match database_result {
            Ok(change) => change,
            Err(error) => {
                let _ = rollback_transaction(&conn);
                if let Some(quarantine) = quarantine.as_ref() {
                    if let Err(restore_error) = self.restore_delete_quarantine(quarantine, &current)
                    {
                        return Err(MaterialError::new(
                            error.code,
                            format!(
                                "{}；恢复隔离文件失败: {}",
                                error.message, restore_error.message
                            ),
                        ));
                    }
                }
                return Err(error);
            }
        };
        for directory in [
            self.app_data_dir.join("thumbnails").join("video"),
            self.app_data_dir.join(".thumbnails"),
        ] {
            if let Ok(entries) = std::fs::read_dir(directory) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(id) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
        let cleanup_pending = quarantine
            .as_ref()
            .is_some_and(|quarantine| self.purge_delete_quarantine(quarantine).is_err());
        Ok(CatalogOutcome {
            value: MaterialDeleteResult {
                success: true,
                cleanup_pending,
            },
            change,
        })
    }

    pub(crate) fn retry_pending_deletions(&self) -> MaterialResult<PendingDeletionCleanupResult> {
        let pending_dir = self.app_data_dir.join("material-delete-pending");
        match std::fs::symlink_metadata(&pending_dir) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PendingDeletionCleanupResult::default());
            }
            Err(error) => {
                return Err(MaterialError::io(
                    "delete-pending-untrusted",
                    "无法检查素材删除恢复目录",
                    error,
                ));
            }
        }
        let pending_dir = self.trusted_app_subdirectory(
            "material-delete-pending",
            false,
            "delete-pending-untrusted",
        )?;
        let entries = match std::fs::read_dir(&pending_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PendingDeletionCleanupResult::default());
            }
            Err(error) => {
                return Err(MaterialError::io(
                    "delete-pending-read-failed",
                    "读取素材删除恢复目录失败",
                    error,
                ));
            }
        };
        let mut result = PendingDeletionCleanupResult::default();
        for entry in entries.flatten() {
            let manifest_path = entry.path();
            if manifest_path.extension().and_then(|value| value.to_str()) != Some("json")
                || manifest_path.parent() != Some(pending_dir.as_path())
            {
                result.pending += 1;
                continue;
            }
            let manifest_metadata = match std::fs::symlink_metadata(&manifest_path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    result.pending += 1;
                    continue;
                }
            };
            if !manifest_metadata.is_file() || metadata_is_reparse(&manifest_metadata) {
                result.pending += 1;
                continue;
            }
            let record = std::fs::read(&manifest_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<PendingMaterialDeletion>(&bytes).ok());
            let Some(record) = record else {
                result.pending += 1;
                continue;
            };
            let scope=self.library_scope_key()?;
            let owner=record.library_id.as_deref().unwrap_or(&self.library_state()?.0).to_owned();
            if scope!=owner {continue;}
            let quarantine = match self.validate_pending_deletion(&manifest_path, &record) {
                Ok(quarantine) => quarantine,
                Err(_) => {
                    result.pending += 1;
                    continue;
                }
            };
            let conn = self.open_write()?;
            begin_transaction(&conn)?;
            let cleanup = match read_asset(&conn, &record.asset_id) {
                Ok(asset) => {
                    let restored = ensure_path_not_owned_by_other_asset(
                        &conn,
                        &record.asset_id,
                        &quarantine.original_path,
                    )
                    .and_then(|_| self.restore_delete_quarantine(&quarantine, &asset))
                    .and_then(|_| {
                        conn.execute(
                            "DELETE FROM material_delete_pending_identity WHERE token=?1",
                            [&record.token],
                        )
                        .map_err(|error| {
                            MaterialError::database("清理已恢复素材删除身份失败", error)
                        })?;
                        Ok(())
                    });
                    match restored {
                        Ok(()) => commit_transaction(&conn),
                        Err(error) => {
                            let _ = rollback_transaction(&conn);
                            Err(error)
                        }
                    }
                }
                Err(error) if error.code == "not-found" => {
                    let _ = rollback_transaction(&conn);
                    self.purge_delete_quarantine(&quarantine)
                }
                Err(error) => {
                    let _ = rollback_transaction(&conn);
                    return Err(error);
                }
            };
            if cleanup.is_ok() {
                result.cleaned += 1;
            } else {
                result.pending += 1;
            }
        }
        Ok(result)
    }

    fn prepare_delete_quarantine(
        &self,
        asset: &MaterialAsset,
        owned_file: Option<&OwnedPhysicalFile>,
    ) -> MaterialResult<Option<DeleteQuarantine>> {
        let Some(owned_file) = owned_file else {
            return Ok(None);
        };
        let parent = owned_file
            .file_path
            .parent()
            .ok_or_else(|| MaterialError::new("delete-target-invalid", "素材文件缺少父目录"))?;
        let token = unique_id("delete");
        let file_name = owned_file
            .file_path
            .file_name()
            .map(|name| safe_file_name(&name.to_string_lossy()))
            .unwrap_or_else(|| "asset".to_string());
        let quarantine_name = format!(".luckyray-delete-pending-{token}-{file_name}");
        let quarantine_path = parent.join(&quarantine_name);
        let pending_dir = self.trusted_app_subdirectory(
            "material-delete-pending",
            true,
            "delete-pending-create-failed",
        )?;
        let manifest_path = pending_dir.join(format!("{token}.json"));
        let temporary_manifest = pending_dir.join(format!("{token}.json.tmp"));
        let record = PendingMaterialDeletion {
            version: PENDING_DELETION_VERSION,
            token: token.clone(),
            asset_id: asset.id.clone(),
            library_id: Some(self.library_scope_key()?),
            storage_mode: owned_file.storage_mode.clone(),
            content_hash: owned_file.content_hash.clone(),
            root_id: owned_file.root_id.clone(),
            original_relative: owned_file
                .relative_path
                .as_deref()
                .map(relative_path_to_manifest)
                .transpose()?,
            source_path: (owned_file.storage_mode == "source")
                .then(|| owned_file.file_path.to_string_lossy().to_string()),
            quarantine_name,
        };
        let bytes = serde_json::to_vec(&record)
            .map_err(|error| MaterialError::new("serialize-error", error.to_string()))?;
        std::fs::write(&temporary_manifest, bytes).map_err(|error| {
            MaterialError::io(
                "delete-pending-write-failed",
                "写入素材删除恢复记录失败",
                error,
            )
        })?;
        if let Err(error) = std::fs::rename(&temporary_manifest, &manifest_path) {
            let _ = std::fs::remove_file(&temporary_manifest);
            return Err(MaterialError::io(
                "delete-pending-write-failed",
                "提交素材删除恢复记录失败",
                error,
            ));
        }
        if self.should_fail_delete_quarantine() {
            let _ = std::fs::remove_file(&manifest_path);
            return Err(MaterialError::new(
                "delete-quarantine-failed",
                "隔离素材文件失败",
            ));
        }
        if let Err(error) = std::fs::rename(&owned_file.file_path, &quarantine_path) {
            let _ = std::fs::remove_file(&manifest_path);
            return Err(MaterialError::io(
                "delete-quarantine-failed",
                "隔离素材文件失败",
                error,
            ));
        }
        Ok(Some(DeleteQuarantine {
            manifest_path,
            record,
            original_path: owned_file.file_path.clone(),
            quarantine_path,
        }))
    }

    fn validate_pending_deletion(
        &self,
        manifest_path: &Path,
        record: &PendingMaterialDeletion,
    ) -> MaterialResult<DeleteQuarantine> {
        if record.version != PENDING_DELETION_VERSION
            || !is_delete_token(&record.token)
            || manifest_path.file_name().and_then(|value| value.to_str())
                != Some(format!("{}.json", record.token).as_str())
        {
            return Err(MaterialError::new(
                "delete-pending-invalid",
                "素材删除恢复记录版本或身份无效",
            ));
        }
        if !is_sha256_id(&record.content_hash) {
            return Err(MaterialError::new(
                "delete-pending-invalid",
                "素材删除恢复记录缺少内容身份",
            ));
        }
        let (original_path, root_id) = match record.storage_mode.as_str() {
            "managed" => {
                if record.source_path.is_some() {
                    return Err(MaterialError::new(
                        "delete-pending-invalid",
                        "托管素材删除恢复记录包含源文件路径",
                    ));
                }
                let root_id = record.root_id.as_deref().ok_or_else(|| {
                    MaterialError::new("delete-pending-invalid", "托管素材删除恢复记录缺少根身份")
                })?;
                let relative_text = record.original_relative.as_deref().ok_or_else(|| {
                    MaterialError::new("delete-pending-invalid", "托管素材删除恢复记录缺少相对路径")
                })?;
                let root = self.trusted_managed_root_by_id(root_id)?;
                let relative_path = manifest_relative_path(relative_text)?;
                let original =
                    self.resolve_trusted_managed_leaf(&root.root_path.join(&relative_path))?;
                if original.root_id != root.root_id
                    || relative_path_to_manifest(&original.relative_path)? != relative_text
                {
                    return Err(MaterialError::new(
                        "delete-pending-invalid",
                        "素材删除恢复记录原路径不匹配",
                    ));
                }
                (original.file_path, Some(root.root_id))
            }
            "source" => {
                if record.root_id.is_some() || record.original_relative.is_some() {
                    return Err(MaterialError::new(
                        "delete-pending-invalid",
                        "源文件删除恢复记录包含托管根身份",
                    ));
                }
                let source_path = record.source_path.as_deref().ok_or_else(|| {
                    MaterialError::new("delete-pending-invalid", "源文件删除恢复记录缺少路径")
                })?;
                (canonical_regular_leaf(Path::new(source_path))?, None)
            }
            _ => {
                return Err(MaterialError::new(
                    "delete-pending-invalid",
                    "素材删除恢复记录存储模式无效",
                ))
            }
        };
        let original_name = original_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                MaterialError::new("delete-pending-invalid", "素材删除恢复记录缺少文件名")
            })?;
        let quarantine_name = format!(
            ".luckyray-delete-pending-{}-{}",
            record.token,
            safe_file_name(original_name)
        );
        if record.quarantine_name != quarantine_name
            || Path::new(&record.quarantine_name)
                .file_name()
                .and_then(|value| value.to_str())
                != Some(record.quarantine_name.as_str())
        {
            return Err(MaterialError::new(
                "delete-pending-invalid",
                "素材删除恢复记录隔离文件名不匹配",
            ));
        }
        let quarantine_path = original_path
            .parent()
            .ok_or_else(|| MaterialError::new("delete-pending-invalid", "隔离文件缺少受信父目录"))?
            .join(&record.quarantine_name);
        if quarantine_path.exists() {
            let quarantine = match record.storage_mode.as_str() {
                "managed" => {
                    self.resolve_trusted_managed_file(&quarantine_path)?
                        .file_path
                }
                "source" => canonical_regular_file(&quarantine_path)?,
                _ => unreachable!(),
            };
            if quarantine.parent() != original_path.parent() {
                return Err(MaterialError::new(
                    "delete-pending-invalid",
                    "隔离文件越过素材文件父目录",
                ));
            }
        }
        if original_path.exists() {
            let current = match record.storage_mode.as_str() {
                "managed" => self.resolve_trusted_managed_file(&original_path)?.file_path,
                "source" => canonical_regular_file(&original_path)?,
                _ => unreachable!(),
            };
            if canonical_path_key(&current) != canonical_path_key(&original_path)
                || (record.storage_mode == "managed"
                    && root_id.as_deref() != record.root_id.as_deref())
            {
                return Err(MaterialError::new(
                    "delete-pending-invalid",
                    "原文件不再属于删除恢复记录身份",
                ));
            }
        }
        Ok(DeleteQuarantine {
            manifest_path: manifest_path.to_path_buf(),
            record: record.clone(),
            original_path,
            quarantine_path,
        })
    }

    fn validate_pending_asset_identity(
        &self,
        quarantine: &DeleteQuarantine,
        asset: &MaterialAsset,
    ) -> MaterialResult<()> {
        if asset.id != quarantine.record.asset_id
            || asset.storage_mode != quarantine.record.storage_mode
        {
            return Err(MaterialError::new(
                "delete-pending-asset-mismatch",
                "素材删除恢复记录与数据库记录不匹配",
            ));
        }
        match asset.storage_mode.as_str() {
            "managed" => {
                if asset.content_hash.as_deref() != Some(quarantine.record.content_hash.as_str()) {
                    return Err(MaterialError::new(
                        "delete-pending-asset-mismatch",
                        "待恢复托管素材内容身份与删除记录不匹配",
                    ));
                }
                let library_path = asset
                    .library_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                    .ok_or_else(|| {
                        MaterialError::new(
                            "delete-pending-asset-mismatch",
                            "待恢复托管素材缺少文件路径",
                        )
                    })?;
                let current = self.resolve_trusted_managed_leaf(Path::new(library_path))?;
                if Some(current.root_id.as_str()) != quarantine.record.root_id.as_deref()
                    || quarantine.record.original_relative.as_deref()
                        != Some(relative_path_to_manifest(&current.relative_path)?.as_str())
                {
                    return Err(MaterialError::new(
                        "delete-pending-asset-mismatch",
                        "待恢复托管素材路径与删除记录不匹配",
                    ));
                }
            }
            "source" => {
                let source_path = asset
                    .library_path
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                    .unwrap_or(asset.original_path.as_str());
                let current = canonical_regular_leaf(Path::new(source_path))?;
                let recorded = quarantine.record.source_path.as_deref().ok_or_else(|| {
                    MaterialError::new("delete-pending-asset-mismatch", "待恢复源文件缺少路径身份")
                })?;
                let recorded = canonical_regular_leaf(Path::new(recorded))?;
                if canonical_path_key(&current) != canonical_path_key(&recorded) {
                    return Err(MaterialError::new(
                        "delete-pending-asset-mismatch",
                        "待恢复源文件路径与删除记录不匹配",
                    ));
                }
            }
            _ => {
                return Err(MaterialError::new(
                    "delete-pending-asset-mismatch",
                    "待恢复素材存储模式不支持物理删除",
                ))
            }
        }
        Ok(())
    }

    fn restore_delete_quarantine(
        &self,
        quarantine: &DeleteQuarantine,
        asset: &MaterialAsset,
    ) -> MaterialResult<()> {
        let validated =
            self.validate_pending_deletion(&quarantine.manifest_path, &quarantine.record)?;
        self.validate_pending_asset_identity(&validated, asset)?;
        let original_exists = validated.original_path.exists();
        let quarantine_exists = validated.quarantine_path.exists();
        for path in [
            original_exists.then_some(validated.original_path.as_path()),
            quarantine_exists.then_some(validated.quarantine_path.as_path()),
        ]
        .into_iter()
        .flatten()
        {
            let actual_hash = sha256_file(path)?;
            if !actual_hash.eq_ignore_ascii_case(&validated.record.content_hash) {
                return Err(MaterialError::new(
                    "delete-pending-content-mismatch",
                    "待恢复文件内容与删除恢复身份不匹配",
                ));
            }
        }
        match (original_exists, quarantine_exists) {
            (false, true) => {
                std::fs::rename(&validated.quarantine_path, &validated.original_path).map_err(
                    |error| {
                        MaterialError::io("delete-restore-failed", "恢复隔离素材文件失败", error)
                    },
                )?;
            }
            (true, false) => {}
            (true, true) => {
                return Err(MaterialError::new(
                    "delete-restore-conflict",
                    "原路径已存在，隔离文件无法自动恢复",
                ));
            }
            (false, false) => {
                return Err(MaterialError::new(
                    "delete-restore-missing",
                    "隔离文件与原文件均不存在，保留恢复记录",
                ));
            }
        }
        remove_pending_manifest(&validated.manifest_path, "delete-restore-record-failed")
    }

    fn validate_pending_journal(
        &self,
        conn: &Connection,
        quarantine: &DeleteQuarantine,
    ) -> MaterialResult<()> {
        let row = conn
            .query_row(
                "SELECT asset_id,storage_mode,content_hash,canonical_path,root_id FROM material_delete_pending_identity WHERE token=?1",
                [&quarantine.record.token],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| MaterialError::database("读取素材删除物理身份失败", error))?
            .ok_or_else(|| {
                MaterialError::new(
                    "delete-pending-identity-missing",
                    "素材删除恢复记录缺少数据库物理身份凭据",
                )
            })?;
        if row.0 != quarantine.record.asset_id
            || row.1 != quarantine.record.storage_mode
            || !row.2.eq_ignore_ascii_case(&quarantine.record.content_hash)
            || canonical_path_key(Path::new(&row.3))
                != canonical_path_key(&quarantine.original_path)
            || row.4 != quarantine.record.root_id
        {
            return Err(MaterialError::new(
                "delete-pending-identity-mismatch",
                "素材删除恢复记录与数据库物理身份凭据不匹配",
            ));
        }
        Ok(())
    }

    fn purge_delete_quarantine_in_transaction(
        &self,
        conn: &Connection,
        quarantine: &DeleteQuarantine,
    ) -> MaterialResult<()> {
        if self.should_fail_delete_purge() {
            return Err(MaterialError::new(
                "delete-cleanup-pending",
                "素材记录已删除，隔离文件等待后台清理",
            ));
        }
        let validated =
            self.validate_pending_deletion(&quarantine.manifest_path, &quarantine.record)?;
        self.validate_pending_journal(conn, &validated)?;
        ensure_path_not_owned_by_other_asset(
            conn,
            &validated.record.asset_id,
            &validated.original_path,
        )?;
        if validated.original_path.exists() {
            return Err(MaterialError::new(
                "delete-cleanup-conflict",
                "原路径存在文件，拒绝清理隔离记录",
            ));
        }
        if validated.quarantine_path.exists() {
            let quarantine_hash = sha256_file(&validated.quarantine_path)?;
            if !quarantine_hash.eq_ignore_ascii_case(&validated.record.content_hash) {
                return Err(MaterialError::new(
                    "delete-pending-content-mismatch",
                    "隔离文件内容与删除恢复身份不匹配",
                ));
            }
        }
        match std::fs::remove_file(&validated.quarantine_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(MaterialError::io(
                    "delete-cleanup-pending",
                    "隔离文件等待后台清理",
                    error,
                ));
            }
        }
        remove_pending_manifest(&validated.manifest_path, "delete-cleanup-record-failed")?;
        conn.execute(
            "DELETE FROM material_delete_pending_identity WHERE token=?1",
            [&validated.record.token],
        )
        .map_err(|error| MaterialError::database("清理素材删除物理身份失败", error))?;
        Ok(())
    }

    fn purge_delete_quarantine(&self, quarantine: &DeleteQuarantine) -> MaterialResult<()> {
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let result = self.purge_delete_quarantine_in_transaction(&conn, quarantine);
        match result {
            Ok(()) => commit_transaction(&conn),
            Err(error) => {
                let _ = rollback_transaction(&conn);
                Err(error)
            }
        }
    }

    pub(crate) fn scan_missing(&self) -> MaterialResult<Vec<MissingMaterialAsset>> {
        let assets = self.list_assets_scoped(&MaterialFilter::default(), &MaterialQueryScope { scope: "all".into(), ..Default::default() })?;
        Ok(assets
            .into_iter()
            .filter_map(|asset| {
                let path = missing_asset_path(&asset)?;
                Some(MissingMaterialAsset {
                    id: asset.id,
                    name: asset.name,
                    library_path: path,
                })
            })
            .collect())
    }

    pub(crate) fn clear_video_thumbnail_references(&self) -> MaterialResult<CatalogOutcome<usize>> {
        let conn = self.open_write()?;
        let version_before = read_change(&conn)?.version;
        let mut statement = conn
            .prepare(
                "SELECT id FROM asset WHERE id IN (SELECT asset_id FROM temp.material_visible_asset) AND kind='video' AND (
                thumbnail_url LIKE '%/thumbnails/video/%' OR
                thumbnail_url LIKE '%\\thumbnails\\video\\%'
            )",
            )
            .map_err(|error| MaterialError::database("查询视频缩略图引用失败", error))?;
        let affected_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| MaterialError::database("读取视频缩略图引用失败", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| MaterialError::database("读取视频缩略图引用失败", error))?;
        drop(statement);
        if affected_ids.is_empty() {
            return Ok(CatalogOutcome {
                value: 0,
                change: None,
            });
        }
        begin_transaction(&conn)?;
        let affected = conn
            .execute(
                "UPDATE asset SET thumbnail_url=NULL, updated_at=?1 WHERE id IN (
                SELECT id FROM asset WHERE id IN (SELECT asset_id FROM temp.material_visible_asset) AND kind='video' AND (
                    thumbnail_url LIKE '%/thumbnails/video/%' OR
                    thumbnail_url LIKE '%\\thumbnails\\video\\%'
                )
            )",
                [now()],
            )
            .map_err(|error| MaterialError::database("清理视频缩略图引用失败", error))?;
        let change = finalize_change(
            &conn,
            version_before,
            "video-thumbnail-cache-clear",
            affected_ids,
            false,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome {
            value: affected,
            change,
        })
    }

    pub(crate) fn remove_asset_record(
        &self,
        id: &str,
    ) -> MaterialResult<CatalogOutcome<RemoveMaterialResult>> {
        self.remove_asset_record_with_revision(id, None)
    }

    pub(crate) fn remove_asset_record_with_revision(
        &self,
        id: &str,
        expected_revision: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<RemoveMaterialResult>> {
        let file_still_exists = read_asset(&self.open_read()?, id)
            .ok()
            .and_then(|asset| note_attachments::actual_path(&asset).ok().map(str::to_owned))
            .is_some_and(|path| Path::new(&path).exists());
        let outcome = self.delete_asset_with_revision(id, false, expected_revision)?;
        Ok(CatalogOutcome {
            value: RemoveMaterialResult {
                success: outcome.value.success,
                file_still_exists,
            },
            change: outcome.change,
        })
    }

    pub(crate) fn list_folders(&self) -> MaterialResult<Vec<MaterialFolder>> {
        if !self.db_path.exists() {
            return Ok(Vec::new());
        }
        let conn = self.open_read()?;
        let mut statement = conn
            .prepare(
                "SELECT id, scope, parent_id, name, sort_order, open, created_at, updated_at
             FROM folder WHERE scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder) ORDER BY sort_order, name COLLATE NOCASE",
            )
            .map_err(|error| MaterialError::database("准备素材文件夹查询失败", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok(MaterialFolder {
                    id: row.get(0)?,
                    scope: row.get(1)?,
                    parent_id: row.get(2)?,
                    name: row.get(3)?,
                    sort_order: row.get(4)?,
                    open: row.get::<_, i64>(5)? != 0,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    children: Vec::new(),
                })
            })
            .map_err(|error| MaterialError::database("查询素材文件夹失败", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| MaterialError::database("读取素材文件夹失败", error))?;
        Ok(build_folder_tree(rows))
    }

    pub(crate) fn create_folder(
        &self,
        input: MaterialFolderInput,
    ) -> MaterialResult<CatalogOutcome<MaterialFolder>> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(MaterialError::new("invalid-name", "文件夹名称不能为空"));
        }
        let conn = self.open_write()?;
        validate_material_folder(&conn, input.parent_id.as_deref())?;
        begin_transaction(&conn)?;
        let existing_id = conn.query_row(
            "SELECT id FROM folder WHERE scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder) AND parent_id IS ?1 AND name=?2 COLLATE NOCASE LIMIT 1",
            rusqlite::params![input.parent_id.as_deref(), name],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|error| MaterialError::database("检查同名素材文件夹失败", error))?;
        if let Some(id) = existing_id {
            if let Some(existing) = find_folder_flat(&conn, &id)? {
                return Ok(CatalogOutcome {
                    value: existing,
                    change: None,
                });
            }
        }
        let version_before = read_change(&conn)?.version;
        let sort_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1)+1 FROM folder WHERE scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder) AND parent_id IS ?1",
            [input.parent_id.as_deref()], |row| row.get(0)
        ).map_err(|error| MaterialError::database("计算文件夹顺序失败", error))?;
        let folder = MaterialFolder {
            id: unique_id("folder"),
            scope: "materials".into(),
            parent_id: input.parent_id,
            name: name.to_string(),
            sort_order,
            open: false,
            created_at: now(),
            updated_at: now(),
            children: Vec::new(),
        };
        prepare_new_member(&conn,"folder",&folder.id)?;
        conn.execute("INSERT INTO folder(id,scope,parent_id,name,sort_order,open,created_at,updated_at) VALUES(?1,'materials',?2,?3,?4,0,?5,?6)",
            rusqlite::params![folder.id, folder.parent_id, folder.name, folder.sort_order, folder.created_at, folder.updated_at])
            .map_err(|error| MaterialError::database("创建素材文件夹失败", error))?;
        bind_new_member(&conn,"folder",&folder.id)?;
        let change = finalize_change(
            &conn,
            version_before,
            "material-folder-create",
            Vec::new(),
            true,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome {
            value: folder,
            change,
        })
    }

    pub(crate) fn rename_folder(
        &self,
        id: &str,
        name: &str,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialFolder>>> {
        self.rename_folder_with_revision(id, name, None)
    }

    pub(crate) fn rename_folder_with_revision(
        &self,
        id: &str,
        name: &str,
        expected_updated_at: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialFolder>>> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(CatalogOutcome {
                value: None,
                change: None,
            });
        }
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        if let Some(current) = find_folder_flat(&conn, id)? {
            if expected_updated_at.is_some_and(|expected| expected != current.updated_at) {
                return Err(MaterialError::new(
                    "material-revision-conflict",
                    "素材文件夹已变化",
                ));
            }
            if current.name == name {
                commit_transaction(&conn)?;
                return Ok(CatalogOutcome {
                    value: Some(current),
                    change: None,
                });
            }
        }
        let version_before = read_change(&conn)?.version;
        let affected = conn
            .execute(
                "UPDATE folder SET name=?1, updated_at=?2 WHERE id=?3 AND scope='materials'",
                rusqlite::params![name, now(), id],
            )
            .map_err(|error| MaterialError::database("重命名素材文件夹失败", error))?;
        let value = if affected == 0 {
            None
        } else {
            find_folder_flat(&conn, id)?
        };
        let change = finalize_change(
            &conn,
            version_before,
            "material-folder-rename",
            Vec::new(),
            true,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome { value, change })
    }

    pub(crate) fn delete_folder(&self, id: &str) -> MaterialResult<CatalogOutcome<bool>> {
        self.delete_folder_with_revision(id, None)
    }

    pub(crate) fn delete_folder_with_revision(
        &self,
        id: &str,
        expected_updated_at: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<bool>> {
        let conn = self.open_write()?;
        let version_before = read_change(&conn)?.version;
        begin_transaction(&conn)?;
        if let Some(expected) = expected_updated_at {
            let current = find_folder_flat(&conn, id)?
                .ok_or_else(|| MaterialError::new("not-found", "素材文件夹不存在"))?;
            if current.updated_at != expected {
                return Err(MaterialError::new(
                    "material-revision-conflict",
                    "素材文件夹已变化",
                ));
            }
        }
        conn.execute("UPDATE asset SET folder_id=NULL, updated_at=?1 WHERE folder_id IN (
            WITH RECURSIVE descendants(id) AS (
                SELECT id FROM folder WHERE id=?2 AND scope='materials'
                UNION ALL SELECT f.id FROM folder f JOIN descendants d ON f.parent_id=d.id WHERE f.scope='materials'
            ) SELECT id FROM descendants
        )", rusqlite::params![now(), id])
            .map_err(|error| MaterialError::database("移出文件夹中的素材失败", error))?;
        let affected = conn.execute("DELETE FROM folder WHERE id IN (
            WITH RECURSIVE descendants(id) AS (
                SELECT id FROM folder WHERE id=?1 AND scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder)
                UNION ALL SELECT f.id FROM folder f JOIN descendants d ON f.parent_id=d.id WHERE f.scope='materials'
            ) SELECT id FROM descendants
        )", [id])
            .map_err(|error| MaterialError::database("删除素材文件夹失败", error))?;
        let change = finalize_change(
            &conn,
            version_before,
            "material-folder-delete",
            Vec::new(),
            true,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome {
            value: affected > 0,
            change,
        })
    }

    pub(crate) fn move_asset(
        &self,
        id: &str,
        folder_id: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<bool>> {
        let conn = self.open_write()?;
        match read_asset(&conn,id) {Ok(_)=>{},Err(e) if e.code=="not-found"=>return Ok(CatalogOutcome{value:false,change:None}),Err(e)=>return Err(e)};
        validate_material_folder(&conn, folder_id)?;
        let current_folder = conn
            .query_row("SELECT folder_id FROM asset WHERE id=?1", [id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()
            .map_err(|error| MaterialError::database("读取素材目录失败", error))?;
        if current_folder
            .as_ref()
            .is_some_and(|current| current.as_deref() == folder_id)
        {
            return Ok(CatalogOutcome {
                value: true,
                change: None,
            });
        }
        let version_before = read_change(&conn)?.version;
        let affected = conn
            .execute(
                "UPDATE asset SET folder_id=?1, updated_at=?2 WHERE id=?3",
                rusqlite::params![folder_id, now(), id],
            )
            .map_err(|error| MaterialError::database("移动素材失败", error))?;
        let change = finalize_change(
            &conn,
            version_before,
            "material-asset-move",
            vec![id.to_string()],
            true,
        )?;
        Ok(CatalogOutcome {
            value: affected > 0,
            change,
        })
    }

    pub(crate) fn move_folder(
        &self,
        input: MaterialFolderMove,
    ) -> MaterialResult<CatalogOutcome<bool>> {
        self.move_folder_with_revision(input, None)
    }

    pub(crate) fn move_folder_with_revision(
        &self,
        input: MaterialFolderMove,
        expected_updated_at: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<bool>> {
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let Some(current) = find_folder_flat(&conn, &input.id)? else {
            return Ok(CatalogOutcome {
                value: false,
                change: None,
            });
        };
        if expected_updated_at.is_some_and(|expected| expected != current.updated_at) {
            return Err(MaterialError::new(
                "material-revision-conflict",
                "素材文件夹已变化",
            ));
        }
        if input.target_id.as_deref() == Some(input.id.as_str()) {
            return Ok(CatalogOutcome {
                value: true,
                change: None,
            });
        }
        let version_before = read_change(&conn)?.version;
        let (parent_id, sort_order) = match input.position.as_str() {
            "inside" => {
                validate_material_folder(&conn, input.target_id.as_deref())?;
                let order = next_folder_order(&conn, input.target_id.as_deref())?;
                (input.target_id, order)
            }
            "before" | "after" => {
                let target = input
                    .target_id
                    .as_deref()
                    .ok_or_else(|| MaterialError::new("invalid-target", "缺少目标文件夹"))?;
                let folder = find_folder_flat(&conn, target)?
                    .ok_or_else(|| MaterialError::new("invalid-target", "目标文件夹不存在"))?;
                let offset = i64::from(input.position == "after");
                (folder.parent_id, folder.sort_order + offset)
            }
            _ => return Err(MaterialError::new("invalid-position", "无效的移动位置")),
        };
        if let Some(parent) = parent_id.as_deref() {
            let cycle = conn
                .query_row(
                    "WITH RECURSIVE ancestors(id,parent_id) AS (
                SELECT id,parent_id FROM folder WHERE id=?1
                UNION ALL SELECT f.id,f.parent_id FROM folder f JOIN ancestors a ON f.id=a.parent_id
            ) SELECT 1 FROM ancestors WHERE id=?2 LIMIT 1",
                    rusqlite::params![parent, input.id],
                    |_| Ok(()),
                )
                .is_ok();
            if cycle {
                return Err(MaterialError::new(
                    "folder-cycle",
                    "不能将文件夹移动到自身或后代",
                ));
            }
        }
        conn.execute(
            "UPDATE folder SET sort_order=sort_order+1, updated_at=?1
             WHERE scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder) AND parent_id IS ?2 AND id<>?3 AND sort_order>=?4",
            rusqlite::params![now(), parent_id.as_deref(), input.id, sort_order],
        )
        .map_err(|error| MaterialError::database("调整素材文件夹顺序失败", error))?;
        let affected = conn.execute("UPDATE folder SET parent_id=?1, sort_order=?2, updated_at=?3 WHERE id=?4 AND scope='materials'",
            rusqlite::params![parent_id, sort_order, now(), input.id])
            .map_err(|error| MaterialError::database("移动素材文件夹失败", error))?;
        let change = finalize_change(
            &conn,
            version_before,
            "material-folder-move",
            Vec::new(),
            true,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome {
            value: affected > 0,
            change,
        })
    }

    pub(crate) fn list_tags(&self) -> MaterialResult<Vec<MaterialTag>> {
        self.list_tags_scoped(&MaterialQueryScope::default())
    }
    pub(crate) fn list_tags_scoped(&self, scope: &MaterialQueryScope) -> MaterialResult<Vec<MaterialTag>> {
        let conn = self.open_read()?;
        let mut statement = conn
            .prepare(
                &format!("SELECT t.id,t.name,t.color,
            (SELECT COUNT(*) FROM item_tag i WHERE i.tag_id=t.id AND i.item_type='asset' AND {}),
            0 AS note_count,
            t.created_at,t.updated_at FROM temp.material_visible_tag t ORDER BY t.name COLLATE NOCASE", scope_condition(&conn, scope, "i.item_id")?),
            )
            .map_err(|error| MaterialError::database("准备标签查询失败", error))?;
        let tags = statement
            .query_map([], material_tag_from_row)
            .map_err(|error| MaterialError::database("查询标签失败", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| MaterialError::database("读取标签失败", error))?;
        Ok(tags)
    }

    pub(crate) fn create_tag(
        &self,
        name: &str,
        color: Option<String>,
    ) -> MaterialResult<CatalogOutcome<MaterialTag>> {
        let name = name.trim();
        if name.is_empty() {
            return Err(MaterialError::new("invalid-name", "标签名称不能为空"));
        }
        let conn = self.open_write()?;
        let version_before = read_change(&conn)?.version;
        let id = unique_id("tag");
        let timestamp = now();
        conn.execute(
            "INSERT INTO material_library_tag(id,library_id,name,color,created_at,updated_at) SELECT ?1,COALESCE(library_id,(SELECT legacy_id FROM main.material_library_state)),?2,?3,?4,?4 FROM temp.material_library_context",
            rusqlite::params![id, name, color, timestamp],
        )
        .map_err(|error| MaterialError::database("创建标签失败", error))?;
        let value = read_tag(&conn, &id)?;
        let change = finalize_change(
            &conn,
            version_before,
            "material-tag-create",
            Vec::new(),
            false,
        )?;
        Ok(CatalogOutcome { value, change })
    }

    pub(crate) fn update_tag(
        &self,
        id: &str,
        patch: MaterialTagPatch,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialTag>>> {
        self.update_tag_with_revision(id, patch, None)
    }

    pub(crate) fn update_tag_with_revision(
        &self,
        id: &str,
        patch: MaterialTagPatch,
        expected_updated_at: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<Option<MaterialTag>>> {
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let current = read_tag(&conn, id).ok();
        let Some(current) = current else {
            return Ok(CatalogOutcome {
                value: None,
                change: None,
            });
        };
        if expected_updated_at.is_some_and(|expected| expected != current.updated_at) {
            return Err(MaterialError::new(
                "material-revision-conflict",
                "素材标签已变化",
            ));
        }
        let name = patch
            .name
            .unwrap_or_else(|| current.name.clone())
            .trim()
            .to_string();
        if name.is_empty() {
            return Ok(CatalogOutcome {
                value: None,
                change: None,
            });
        }
        let color = match patch.color {
            PatchValue::Missing => current.color.clone(),
            PatchValue::Value(value) => value,
        };
        if name == current.name && color == current.color {
            return Ok(CatalogOutcome {
                value: Some(current),
                change: None,
            });
        }
        let version_before = read_change(&conn)?.version;
        conn.execute(
            "UPDATE material_library_tag SET name=?1,color=?2,updated_at=?3 WHERE id=?4 AND library_id=(SELECT library_id FROM temp.material_library_context)",
            rusqlite::params![name, color, now(), id],
        )
        .map_err(|error| MaterialError::database("更新标签失败", error))?;
        let value = read_tag(&conn, id).map(Some)?;
        let change = finalize_change(
            &conn,
            version_before,
            "material-tag-update",
            Vec::new(),
            false,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome { value, change })
    }

    pub(crate) fn delete_tag(&self, id: &str) -> MaterialResult<CatalogOutcome<bool>> {
        self.delete_tag_with_revision(id, None)
    }

    pub(crate) fn delete_tag_with_revision(
        &self,
        id: &str,
        expected_updated_at: Option<&str>,
    ) -> MaterialResult<CatalogOutcome<bool>> {
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let current = read_tag(&conn, id)?;
        if let Some(expected) = expected_updated_at {
            if current.updated_at != expected {
                return Err(MaterialError::new(
                    "material-revision-conflict",
                    "素材标签已变化",
                ));
            }
        }
        let version_before = read_change(&conn)?.version;
        conn.execute("DELETE FROM item_tag WHERE tag_id=?1 AND item_type='asset' AND item_id IN (SELECT asset_id FROM temp.material_visible_asset)", [id])
            .map_err(|error| MaterialError::database("清理标签关系失败", error))?;
        let affected = conn
            .execute("DELETE FROM material_library_tag WHERE id=?1 AND library_id=(SELECT library_id FROM temp.material_library_context)", [id])
            .map_err(|error| MaterialError::database("删除标签失败", error))?;
        let change = finalize_change(
            &conn,
            version_before,
            "material-tag-delete",
            Vec::new(),
            false,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome {
            value: affected > 0,
            change,
        })
    }

    pub(crate) fn get_asset_tags(&self, id: &str) -> MaterialResult<Vec<String>> {
        let conn = self.open_read()?;
        read_asset(&conn,id)?;
        let mut statement = conn.prepare("SELECT tag_id FROM item_tag WHERE item_type='asset' AND item_id=?1 ORDER BY created_at")
            .map_err(|error| MaterialError::database("准备素材标签查询失败", error))?;
        let tags = statement
            .query_map([id], |row| row.get(0))
            .map_err(|error| MaterialError::database("查询素材标签失败", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| MaterialError::database("读取素材标签失败", error))?;
        Ok(tags)
    }

    pub(crate) fn set_asset_tags(
        &self,
        id: &str,
        tag_ids: Vec<String>,
    ) -> MaterialResult<CatalogOutcome<Vec<String>>> {
        let conn = self.open_write()?;
        let version_before = read_change(&conn)?.version;
        read_asset(&conn, id)?;
        let mut valid = Vec::new();
        for tag_id in tag_ids {
            read_tag(&conn, &tag_id).map_err(|_|MaterialError::new("material-library-scope","标签不属于此素材库"))?;
            if !valid.contains(&tag_id) {
                valid.push(tag_id);
            }
        }
        let current = self.get_asset_tags(id)?;
        if current == valid {
            return Ok(CatalogOutcome {
                value: valid,
                change: None,
            });
        }
        begin_transaction(&conn)?;
        conn.execute(
            "DELETE FROM item_tag WHERE item_type='asset' AND item_id=?1",
            [id],
        )
        .map_err(|error| MaterialError::database("替换素材标签失败", error))?;
        for tag_id in &valid {
            conn.execute("INSERT INTO item_tag(id,item_type,item_id,tag_id,created_at) VALUES(?1,'asset',?2,?3,?4)", rusqlite::params![unique_id("itemtag"),id,tag_id,now()])
            .map_err(|error| MaterialError::database("写入素材标签失败", error))?;
        }
        let change = finalize_change(
            &conn,
            version_before,
            "material-asset-tags",
            vec![id.to_string()],
            false,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome {
            value: valid,
            change,
        })
    }

    pub(crate) fn list_asset_tag_map(
        &self,
        ids: Option<Vec<String>>,
    ) -> MaterialResult<HashMap<String, Vec<String>>> {
        let conn = self.open_read()?;
        let mut map = HashMap::new();
        let requested = ids.map(|ids| {
            let mut seen = HashSet::new();
            ids.into_iter()
                .filter(|id| seen.insert(id.clone()))
                .collect::<Vec<_>>()
        });
        if let Some(ids) = &requested {
            for id in ids {
                map.insert(id.clone(), Vec::new());
            }
            for chunk in ids.chunks(400) {
                let sql = format!(
                    "SELECT item_id,tag_id FROM item_tag WHERE item_type='asset' AND item_id IN (SELECT asset_id FROM temp.material_visible_asset) AND item_id IN ({}) ORDER BY item_id,created_at",
                    repeat_placeholders(chunk.len())
                );
                let mut statement = conn
                    .prepare(&sql)
                    .map_err(|error| MaterialError::database("准备素材标签映射查询失败", error))?;
                let rows = statement
                    .query_map(params_from_iter(chunk.iter()), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| MaterialError::database("查询素材标签映射失败", error))?;
                for row in rows {
                    let (item_id, tag_id) = row
                        .map_err(|error| MaterialError::database("读取素材标签映射失败", error))?;
                    map.entry(item_id).or_default().push(tag_id);
                }
            }
        } else {
            let mut statement = conn.prepare("SELECT item_id,tag_id FROM item_tag WHERE item_type='asset' AND item_id IN (SELECT asset_id FROM temp.material_visible_asset) ORDER BY item_id,created_at")
                .map_err(|error| MaterialError::database("准备素材标签映射查询失败", error))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| MaterialError::database("查询素材标签映射失败", error))?;
            for row in rows {
                let (item_id, tag_id) =
                    row.map_err(|error| MaterialError::database("读取素材标签映射失败", error))?;
                map.entry(item_id).or_default().push(tag_id);
            }
        }
        Ok(map)
    }

    pub(crate) fn merge_tags(
        &self,
        target_id: &str,
        source_ids: Vec<String>,
    ) -> MaterialResult<CatalogOutcome<MaterialTagMergeResult>> {
        self.merge_tags_with_revisions(target_id, None, source_ids, &HashMap::new())
    }

    pub(crate) fn merge_tags_with_revisions(
        &self,
        target_id: &str,
        expected_target_updated_at: Option<&str>,
        source_ids: Vec<String>,
        expected_source_updated_at: &HashMap<String, String>,
    ) -> MaterialResult<CatalogOutcome<MaterialTagMergeResult>> {
        let conn = self.open_write()?;
        begin_transaction(&conn)?;
        let target = read_tag(&conn, target_id)?;
        if expected_target_updated_at.is_some_and(|expected| expected != target.updated_at) {
            return Err(MaterialError::new(
                "material-revision-conflict",
                "目标素材标签已变化",
            ));
        }
        let sources = source_ids
            .into_iter()
            .filter(|id| id != target_id)
            .filter_map(|id| read_tag(&conn, &id).ok())
            .collect::<Vec<_>>();
        if sources.iter().any(|source| {
            expected_source_updated_at
                .get(&source.id)
                .is_some_and(|expected| expected != &source.updated_at)
        }) || expected_source_updated_at.len() != sources.len()
            && !expected_source_updated_at.is_empty()
        {
            return Err(MaterialError::new(
                "material-revision-conflict",
                "源素材标签已变化",
            ));
        }
        if sources.is_empty() {
            return Ok(CatalogOutcome {
                value: MaterialTagMergeResult {
                    target_name: target.name,
                    source_names: Vec::new(),
                },
                change: None,
            });
        }
        let version_before = read_change(&conn)?.version;
        for source in &sources {
            let relations = {
                let mut statement = conn
                    .prepare("SELECT item_type,item_id FROM item_tag WHERE tag_id=?1 AND item_type='asset' AND item_id IN (SELECT asset_id FROM temp.material_visible_asset)")
                    .map_err(|error| MaterialError::database("读取原标签关系失败", error))?;
                let values = statement
                    .query_map([source.id.as_str()], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| MaterialError::database("查询原标签关系失败", error))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| MaterialError::database("读取原标签关系失败", error))?;
                values
            };
            for (item_type, item_id) in relations {
                let exists=conn.query_row("SELECT 1 FROM item_tag WHERE item_type=?1 AND item_id=?2 AND tag_id=?3 LIMIT 1",rusqlite::params![item_type,item_id,target_id],|_|Ok(())).is_ok();
                if !exists {
                    conn.execute("INSERT INTO item_tag(id,item_type,item_id,tag_id,created_at) VALUES(?1,?2,?3,?4,?5)",rusqlite::params![unique_id("itemtag"),item_type,item_id,target_id,now()])
                    .map_err(|error|MaterialError::database("合并标签关系失败",error))?;
                }
            }
            conn.execute("DELETE FROM item_tag WHERE tag_id=?1 AND item_type='asset' AND item_id IN (SELECT asset_id FROM temp.material_visible_asset)", [source.id.as_str()])
                .map_err(|error| MaterialError::database("清理原标签关系失败", error))?;
            conn.execute("DELETE FROM material_library_tag WHERE id=?1 AND library_id=(SELECT library_id FROM temp.material_library_context)", [source.id.as_str()])
                .map_err(|error| MaterialError::database("删除原标签失败", error))?;
        }
        let change = finalize_change(
            &conn,
            version_before,
            "material-tag-merge",
            Vec::new(),
            false,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome {
            value: MaterialTagMergeResult {
                target_name: target.name,
                source_names: sources.into_iter().map(|tag| tag.name).collect(),
            },
            change,
        })
    }

    pub(crate) fn add_asset_tag_names(
        &self,
        assignments: Vec<MaterialAssetTagNames>,
    ) -> MaterialResult<CatalogOutcome<usize>> {
        let conn = self.open_write()?;
        let version_before = read_change(&conn)?.version;
        begin_transaction(&conn)?;
        let mut inserted = 0usize;
        let mut affected_ids = Vec::new();
        for assignment in assignments {
            if read_asset(&conn, &assignment.asset_id).is_err() {
                continue;
            }
            let mut asset_changed = false;
            for tag in assignment.tags {
                let name = tag.name.trim();
                if name.is_empty() {
                    continue;
                }
                let existing_tag_id = conn
                    .query_row(
                        "SELECT id FROM temp.material_visible_tag WHERE name=?1 COLLATE NOCASE LIMIT 1",
                        [name],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|error| MaterialError::database("查询自动标签失败", error))?;
                let tag_id = if let Some(id) = existing_tag_id {
                    id
                } else {
                    let id = unique_id("tag");
                    conn.execute(
                        "INSERT INTO material_library_tag(id,library_id,name,color,created_at,updated_at) SELECT ?1,COALESCE(library_id,(SELECT legacy_id FROM main.material_library_state)),?2,?3,?4,?4 FROM temp.material_library_context",
                        rusqlite::params![id, name, tag.color, now()],
                    ).map_err(|error| MaterialError::database("创建素材自动标签失败", error))?;
                    id
                };
                let exists = conn.query_row(
                    "SELECT 1 FROM item_tag WHERE item_type='asset' AND item_id=?1 AND tag_id=?2 LIMIT 1",
                    rusqlite::params![assignment.asset_id, tag_id],
                    |_| Ok(()),
                ).is_ok();
                if !exists {
                    conn.execute(
                        "INSERT INTO item_tag(id,item_type,item_id,tag_id,created_at) VALUES(?1,'asset',?2,?3,?4)",
                        rusqlite::params![unique_id("itemtag"), assignment.asset_id, tag_id, now()],
                    ).map_err(|error| MaterialError::database("写入素材自动标签失败", error))?;
                    inserted += 1;
                    asset_changed = true;
                }
            }
            if asset_changed {
                affected_ids.push(assignment.asset_id);
            }
        }
        let change = finalize_change(
            &conn,
            version_before,
            "material-auto-tag",
            affected_ids,
            false,
        )?;
        commit_transaction(&conn)?;
        Ok(CatalogOutcome {
            value: inserted,
            change,
        })
    }

    #[cfg(test)]
    fn initialize_test_schema(&self) -> MaterialResult<()> {
        let conn = Connection::open(&self.db_path)
            .map_err(|error| MaterialError::database("创建测试数据库失败", error))?;
        conn.execute_batch(
            "CREATE TABLE asset (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, original_path TEXT NOT NULL,
                library_path TEXT, storage_mode TEXT NOT NULL DEFAULT 'linked', kind TEXT NOT NULL,
                mime_type TEXT, size_bytes INTEGER, thumbnail_url TEXT, description TEXT,
                rating INTEGER, dominant_color TEXT, folder_id TEXT, imported_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, content_hash TEXT
             );
             CREATE TABLE item_tag (
                id TEXT PRIMARY KEY, item_type TEXT NOT NULL, item_id TEXT NOT NULL,
                tag_id TEXT NOT NULL, created_at TEXT NOT NULL
             );
             CREATE TABLE folder (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE tag (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE favorite_item(item_type TEXT,item_id TEXT,theme TEXT,copy TEXT,favorited_at TEXT,note_updated_at TEXT,PRIMARY KEY(item_type,item_id));
             CREATE TABLE smart_folder_definition(id TEXT PRIMARY KEY,name TEXT,source TEXT,criteria_version INTEGER,criteria_json TEXT,sort TEXT,created_at TEXT,updated_at TEXT);",
        )
        .map_err(|error| MaterialError::database("创建测试 schema 失败", error))?;
        ensure_change_schema(&conn)?;
        super::libraries::apply_library_schema(&conn)
    }
}

impl MaterialError {
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub(crate) fn database(context: &str, error: rusqlite::Error) -> Self {
        Self::new("database-error", format!("{context}: {error}"))
    }

    pub(crate) fn io(code: &str, context: &str, error: std::io::Error) -> Self {
        Self::new(code, format!("{context}: {error}"))
    }
}

pub(crate) fn ensure_change_schema(conn: &Connection) -> MaterialResult<()> {
    ensure_note_attachment_schema(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS material_change_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            version INTEGER NOT NULL DEFAULT 0,
            reason TEXT NOT NULL DEFAULT 'bootstrap',
            affected_ids_json TEXT NOT NULL DEFAULT '[]',
            folders_changed INTEGER NOT NULL DEFAULT 0,
            occurred_at TEXT NOT NULL DEFAULT ''
         );
         INSERT OR IGNORE INTO material_change_state(
            singleton, version, reason, affected_ids_json, folders_changed, occurred_at
         ) VALUES (1, 0, 'bootstrap', '[]', 0, '');
         CREATE TABLE IF NOT EXISTS material_delete_pending_identity (
            token TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL,
            storage_mode TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            canonical_path TEXT NOT NULL,
            root_id TEXT,
            created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS asset_source_page (
            asset_id TEXT PRIMARY KEY,
            page_url TEXT NOT NULL,
            page_kind TEXT NOT NULL CHECK(page_kind IN ('work-page','capture-page')),
            title TEXT
         );
         CREATE TRIGGER IF NOT EXISTS material_source_page_change AFTER INSERT ON asset_source_page BEGIN
            UPDATE material_change_state SET version=version+1, reason='source-page-insert',
                affected_ids_json='[]', folders_changed=0,
                occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_source_page_asset_delete AFTER DELETE ON asset BEGIN
            DELETE FROM asset_source_page WHERE asset_id=OLD.id;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_asset_insert AFTER INSERT ON asset BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'asset-insert', affected_ids_json = '[]', folders_changed = 0, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_asset_update AFTER UPDATE ON asset BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'asset-update', affected_ids_json = '[]', folders_changed = 0, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_asset_delete AFTER DELETE ON asset BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'asset-delete', affected_ids_json = '[]', folders_changed = 0, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_folder_insert AFTER INSERT ON folder WHEN NEW.scope = 'materials' BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'folder-insert', affected_ids_json = '[]', folders_changed = 1, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_folder_update AFTER UPDATE ON folder WHEN NEW.scope = 'materials' BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'folder-update', affected_ids_json = '[]', folders_changed = 1, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_folder_delete AFTER DELETE ON folder WHEN OLD.scope = 'materials' BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'folder-delete', affected_ids_json = '[]', folders_changed = 1, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_asset_tag_insert AFTER INSERT ON item_tag WHEN NEW.item_type = 'asset' BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'asset-tag-insert', affected_ids_json = '[]', folders_changed = 0, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_asset_tag_delete AFTER DELETE ON item_tag WHEN OLD.item_type = 'asset' BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'asset-tag-delete', affected_ids_json = '[]', folders_changed = 0, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_tag_insert AFTER INSERT ON tag BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'tag-insert', affected_ids_json = '[]', folders_changed = 0, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_tag_update AFTER UPDATE ON tag BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'tag-update', affected_ids_json = '[]', folders_changed = 0, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TRIGGER IF NOT EXISTS material_change_tag_delete AFTER DELETE ON tag BEGIN
            UPDATE material_change_state SET version = version + 1, reason = 'tag-delete', affected_ids_json = '[]', folders_changed = 0, occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
         END;
         CREATE TABLE IF NOT EXISTS companion_service_change (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL CHECK(domain IN ('materials','knowledge')),
            scope_id TEXT NOT NULL,
            object_id TEXT NOT NULL,
            revision TEXT NOT NULL,
            kind TEXT NOT NULL,
            tombstone INTEGER NOT NULL DEFAULT 0,
            occurred_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_companion_service_change_scope
            ON companion_service_change(domain,scope_id,seq);
         CREATE TRIGGER IF NOT EXISTS companion_service_asset_insert AFTER INSERT ON asset BEGIN
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('materials','',NEW.id,NEW.updated_at,'created',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         END;
         CREATE TRIGGER IF NOT EXISTS companion_service_asset_update AFTER UPDATE ON asset BEGIN
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('materials','',NEW.id,NEW.updated_at,'updated',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         END;
         CREATE TRIGGER IF NOT EXISTS companion_service_asset_delete AFTER DELETE ON asset BEGIN
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('materials','',OLD.id,OLD.updated_at,'removed',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         END;
         CREATE TRIGGER IF NOT EXISTS companion_service_asset_tag_insert AFTER INSERT ON item_tag WHEN NEW.item_type='asset' BEGIN
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('materials','',NEW.item_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'tagged',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         END;
         CREATE TRIGGER IF NOT EXISTS companion_service_asset_tag_delete AFTER DELETE ON item_tag WHEN OLD.item_type='asset' BEGIN
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('materials','',OLD.item_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'tagged',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         END;
         CREATE TRIGGER IF NOT EXISTS companion_service_source_page_insert AFTER INSERT ON asset_source_page BEGIN
            UPDATE asset SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.asset_id;
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('materials','',NEW.asset_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'updated',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         END;",
    )
    .map_err(|error| MaterialError::database("初始化素材变更协议失败", error))
}

fn default_change() -> MaterialChange {
    MaterialChange {
        version: 0,
        reason: "bootstrap".to_string(),
        affected_ids: Vec::new(),
        folders_changed: false,
        occurred_at: String::new(),
    }
}

fn begin_transaction(conn: &Connection) -> MaterialResult<()> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| MaterialError::database("开始素材事务失败", error))
}

fn commit_transaction(conn: &Connection) -> MaterialResult<()> {
    conn.execute_batch("COMMIT")
        .map_err(|error| MaterialError::database("提交素材事务失败", error))
}

fn rollback_transaction(conn: &Connection) -> MaterialResult<()> {
    conn.execute_batch("ROLLBACK")
        .map_err(|error| MaterialError::database("回滚素材事务失败", error))
}

fn update_duplicate_folder(
    conn: &Connection,
    asset_id: &str,
    folder_id: Option<&str>,
) -> MaterialResult<bool> {
    let Some(folder_id) = folder_id else {
        return Ok(false);
    };
    conn.execute(
        "UPDATE asset SET folder_id=?1, updated_at=?2 WHERE id=?3 AND folder_id IS NOT ?1",
        rusqlite::params![folder_id, now(), asset_id],
    )
    .map(|affected| affected > 0)
    .map_err(|error| MaterialError::database("更新重复素材目录失败", error))
}

fn insert_source_page_if_absent(
    conn: &Connection,
    asset_id: &str,
    source_page: Option<&MaterialSourcePageInput>,
) -> MaterialResult<bool> {
    let Some(source_page) = source_page else { return Ok(false); };
    let safe = MaterialSourcePageInput::from_parts(
        &source_page.page_url, &source_page.page_kind, source_page.title.as_deref(),
    ).ok_or_else(|| MaterialError::new("source-page-invalid", "来源页面地址无效"))?;
    conn.execute(
        "INSERT OR IGNORE INTO asset_source_page(asset_id,page_url,page_kind,title)
         SELECT id,?2,?3,?4 FROM asset WHERE id=?1",
        rusqlite::params![asset_id, safe.page_url, safe.page_kind, safe.title],
    ).map(|count| count > 0)
    .map_err(|error| MaterialError::database("写入来源页面失败", error))
}

fn remove_pending_manifest(path: &Path, code: &str) -> MaterialResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(MaterialError::io(code, "清理素材删除恢复记录失败", error)),
    }
}

pub(crate) fn read_change(conn: &Connection) -> MaterialResult<MaterialChange> {
    ensure_change_schema(conn)?;
    conn.query_row(
        "SELECT version, reason, affected_ids_json, folders_changed, occurred_at FROM material_change_state WHERE singleton = 1",
        [],
        |row| {
            let affected_ids: String = row.get(2)?;
            Ok(MaterialChange {
                version: row.get(0)?,
                reason: row.get(1)?,
                affected_ids: serde_json::from_str(&affected_ids).unwrap_or_default(),
                folders_changed: row.get::<_, i64>(3)? != 0,
                occurred_at: row.get(4)?,
            })
        },
    )
    .map_err(|error| MaterialError::database("读取素材变更状态失败", error))
}

fn finalize_change(
    conn: &Connection,
    version_before: i64,
    reason: &str,
    affected_ids: Vec<String>,
    folders_changed: bool,
) -> MaterialResult<Option<MaterialChange>> {
    if read_change(conn)?.version <= version_before {
        return Ok(None);
    }
    publish_change_metadata(conn, reason, affected_ids, folders_changed).map(Some)
}

pub(crate) fn publish_change_metadata(
    conn: &Connection,
    reason: &str,
    mut affected_ids: Vec<String>,
    folders_changed: bool,
) -> MaterialResult<MaterialChange> {
    ensure_change_schema(conn)?;
    affected_ids.sort();
    affected_ids.dedup();
    let affected_json = serde_json::to_string(&affected_ids)
        .map_err(|error| MaterialError::new("serialize-error", error.to_string()))?;
    conn.execute(
        "UPDATE material_change_state SET reason = ?1, affected_ids_json = ?2, folders_changed = ?3, occurred_at = ?4 WHERE singleton = 1",
        rusqlite::params![reason, affected_json, i64::from(folders_changed), now()],
    ).map_err(|error| MaterialError::database("发布素材变更元数据失败", error))?;
    read_change(conn)
}

fn validate_material_folder(conn: &Connection, folder_id: Option<&str>) -> MaterialResult<()> {
    let Some(folder_id) = non_empty(folder_id) else {
        return Ok(());
    };
    let exists = conn
        .query_row(
            "SELECT 1 FROM folder WHERE id = ?1 AND scope = 'materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder) LIMIT 1",
            [folder_id],
            |_| Ok(()),
        )
        .is_ok();
    if exists {
        Ok(())
    } else {
        Err(MaterialError::new(
            "invalid-folder",
            "目标文件夹不存在或不属于素材库",
        ))
    }
}

fn collect_import_files(root: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                files.push(path);
            } else if recursive && path.is_dir() {
                directories.push(path);
            }
        }
    }
    files.sort();
    files
}

fn ensure_folder_path(
    conn: &Connection,
    root: &Path,
    source_path: &Path,
    base_parent: Option<&str>,
) -> MaterialResult<(String, bool)> {
    let mut parent_id = base_parent.map(str::to_string);
    let mut created_any = false;
    let root_name = root
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "imported-folder".to_string());
    let relative_parent = source_path.strip_prefix(root).ok().and_then(Path::parent);
    let names = std::iter::once(root_name).chain(relative_parent.into_iter().flat_map(|path| {
        path.components()
            .filter_map(|component| match component {
                std::path::Component::Normal(name) => Some(name.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
    }));
    for name in names {
        let existing = conn.query_row(
            "SELECT id FROM folder WHERE scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder) AND parent_id IS ?1 AND name=?2 LIMIT 1",
            rusqlite::params![parent_id.as_deref(), name],
            |row| row.get::<_, String>(0),
        ).ok();
        parent_id = if let Some(id) = existing {
            Some(id)
        } else {
            let id = unique_id("folder");
            let order = next_folder_order(conn, parent_id.as_deref())?;
            let timestamp = now();
            conn.execute_batch("SAVEPOINT material_folder_bind").map_err(|e|MaterialError::database("开始导入分类失败",e))?;
            let inserted=(|| {
                prepare_new_member(conn,"folder",&id)?;
                conn.execute("INSERT INTO folder(id,scope,parent_id,name,sort_order,open,created_at,updated_at) VALUES(?1,'materials',?2,?3,?4,1,?5,?5)",rusqlite::params![id,parent_id,name,order,timestamp]).map_err(|e|MaterialError::database("创建导入文件夹失败",e))?;
                bind_new_member(conn,"folder",&id)
            })();
            if inserted.is_err() {let _=conn.execute_batch("ROLLBACK TO material_folder_bind");}
            conn.execute_batch("RELEASE material_folder_bind").map_err(|e|MaterialError::database("提交导入分类失败",e))?;
            inserted?;
            created_any = true;
            Some(id)
        };
    }
    Ok((
        parent_id.expect("root folder is always present"),
        created_any,
    ))
}

fn prepare_new_member(conn:&Connection,kind:&str,id:&str)->MaterialResult<()> {
    let Some(library)=super::libraries::connection_library(conn)? else {return Ok(());};
    if conn.is_autocommit() {return Err(MaterialError::new("library-transaction-required","库归属必须与对象原子保存"));}
    conn.execute("INSERT INTO material_library_write_intent(kind,object_id,library_id) VALUES(?1,?2,?3)",rusqlite::params![kind,id,library]).map_err(|e|MaterialError::database("登记库归属意图失败",e))?;
    Ok(())
}
fn bind_new_member(conn:&Connection,kind:&str,id:&str)->MaterialResult<()> {
    let Some(library)=super::libraries::connection_library(conn)? else {return Ok(());};
    let (table,column)=if kind=="asset" {("material_library_asset","asset_id")}else{("material_library_folder","folder_id")};
    conn.execute(&format!("UPDATE {table} SET library_id=?1 WHERE {column}=?2 AND library_id<>?1"),rusqlite::params![library,id]).map_err(|e|MaterialError::database("保存素材库归属失败",e))?;Ok(())
}

pub(super) fn read_asset(conn: &Connection, id: &str) -> MaterialResult<MaterialAsset> {
    let asset=read_asset_unrestricted(conn,id)?;
    if super::libraries::connection_library(conn)?.is_some() { super::libraries::assert_member(conn,"asset",id)?; }
    Ok(asset)
}

fn read_asset_unrestricted(conn: &Connection, id: &str) -> MaterialResult<MaterialAsset> {
    conn.query_row(
        "SELECT a.id, a.name, a.original_path, a.library_path, COALESCE(a.storage_mode, 'linked'),
         a.kind, COALESCE(a.mime_type, ''), a.size_bytes, COALESCE(a.thumbnail_url, ''),
         COALESCE(a.description, ''), a.rating, a.dominant_color, a.folder_id, a.imported_at,
         COALESCE(a.updated_at, a.imported_at), a.content_hash FROM asset a WHERE a.id = ?1 LIMIT 1",
        [id],
        material_asset_from_row,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => MaterialError::new("not-found", "素材记录不存在"),
        other => MaterialError::database("读取素材记录失败", other),
    })
}

fn material_tag_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MaterialTag> {
    Ok(MaterialTag {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        asset_count: row.get(3)?,
        note_count: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn read_tag(conn: &Connection, id: &str) -> MaterialResult<MaterialTag> {
    conn.query_row(
        "SELECT t.id,t.name,t.color,
        (SELECT COUNT(*) FROM item_tag i WHERE i.tag_id=t.id AND i.item_type='asset'),
        (SELECT COUNT(*) FROM item_tag i WHERE i.tag_id=t.id AND i.item_type='note'),
        t.created_at,t.updated_at FROM temp.material_visible_tag t WHERE t.id=?1",
        [id],
        material_tag_from_row,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => MaterialError::new("not-found", "标签不存在"),
        other => MaterialError::database("读取标签失败", other),
    })
}

fn find_folder_flat(conn: &Connection, id: &str) -> MaterialResult<Option<MaterialFolder>> {
    conn.query_row("SELECT id,scope,parent_id,name,sort_order,open,created_at,updated_at FROM folder WHERE id=?1 AND scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder)", [id], |row| Ok(MaterialFolder {
        id: row.get(0)?, scope: row.get(1)?, parent_id: row.get(2)?, name: row.get(3)?, sort_order: row.get(4)?,
        open: row.get::<_,i64>(5)? != 0, created_at: row.get(6)?, updated_at: row.get(7)?, children: Vec::new()
    })).optional().map_err(|error| MaterialError::database("读取素材文件夹失败", error))
}

fn next_folder_order(conn: &Connection, parent_id: Option<&str>) -> MaterialResult<i64> {
    conn.query_row("SELECT COALESCE(MAX(sort_order),-1)+1 FROM folder WHERE scope='materials' AND id IN (SELECT folder_id FROM temp.material_visible_folder) AND parent_id IS ?1", [parent_id], |row| row.get(0))
        .map_err(|error| MaterialError::database("计算文件夹顺序失败", error))
}

fn build_folder_tree(folders: Vec<MaterialFolder>) -> Vec<MaterialFolder> {
    let mut by_parent: HashMap<Option<String>, Vec<MaterialFolder>> = HashMap::new();
    for folder in folders {
        by_parent
            .entry(folder.parent_id.clone())
            .or_default()
            .push(folder);
    }
    fn attach(
        parent: Option<String>,
        map: &mut HashMap<Option<String>, Vec<MaterialFolder>>,
    ) -> Vec<MaterialFolder> {
        let mut nodes = map.remove(&parent).unwrap_or_default();
        nodes.sort_by_key(|folder| folder.sort_order);
        for node in &mut nodes {
            node.children = attach(Some(node.id.clone()), map);
        }
        nodes
    }
    attach(None, &mut by_parent)
}

fn normalize_storage_mode(value: &str) -> MaterialResult<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "managed" => Ok("managed"),
        "linked" => Ok("linked"),
        "source" => Ok("source"),
        _ => Err(MaterialError::new(
            "invalid-storage-mode",
            "无效的素材存储模式",
        )),
    }
}

fn local_material_path(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.starts_with("browser:") || value.starts_with("dropped:") {
        return None;
    }
    Some(value.to_string())
}

fn missing_asset_path(asset: &MaterialAsset) -> Option<String> {
    let original = local_material_path(Some(asset.original_path.as_str()));
    let library = local_material_path(asset.library_path.as_deref());
    match asset.storage_mode.as_str() {
        "managed" => library.filter(|path| !Path::new(path).is_file()),
        "linked" => original.filter(|path| !Path::new(path).is_file()),
        "source" => match (original, library) {
            (None, None) => None,
            (Some(path), None) | (None, Some(path)) => {
                (!Path::new(&path).is_file()).then_some(path)
            }
            (Some(original), Some(library)) => {
                let same_path = canonical_path_key(Path::new(&original))
                    == canonical_path_key(Path::new(&library));
                if same_path {
                    (!Path::new(&library).is_file()).then_some(library)
                } else {
                    let original_exists = Path::new(&original).is_file();
                    let library_exists = Path::new(&library).is_file();
                    Some(match (original_exists, library_exists) {
                        (true, false) => library,
                        (false, true) => original,
                        _ => library,
                    })
                }
            }
        },
        _ => None,
    }
}

fn normalize_path_identity(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

pub(super) fn canonical_regular_file(path: &Path) -> MaterialResult<PathBuf> {
    if !path.is_absolute() {
        return Err(MaterialError::new(
            "physical-path-untrusted",
            "素材真实文件必须使用绝对路径",
        ));
    }
    reject_reparse_components(path).map_err(|error| {
        MaterialError::new(
            if error.code == "managed-path-reparse" {
                "physical-path-reparse"
            } else {
                "physical-path-unavailable"
            },
            error.message,
        )
    })?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        MaterialError::io("physical-path-unavailable", "无法验证素材真实文件", error)
    })?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err(MaterialError::new(
            "physical-path-untrusted",
            "素材真实文件不是普通文件",
        ));
    }
    path.canonicalize().map_err(|error| {
        MaterialError::io("physical-path-unavailable", "无法规范化素材真实文件", error)
    })
}

fn canonical_regular_leaf(path: &Path) -> MaterialResult<PathBuf> {
    if !path.is_absolute() {
        return Err(MaterialError::new(
            "physical-path-untrusted",
            "素材真实文件必须使用绝对路径",
        ));
    }
    reject_reparse_components(path).map_err(|error| {
        MaterialError::new(
            if error.code == "managed-path-reparse" {
                "physical-path-reparse"
            } else {
                "physical-path-unavailable"
            },
            error.message,
        )
    })?;
    let name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| MaterialError::new("physical-path-untrusted", "素材真实文件缺少文件名"))?;
    let parent = path
        .parent()
        .ok_or_else(|| MaterialError::new("physical-path-untrusted", "素材真实文件缺少父目录"))?;
    let parent = parent.canonicalize().map_err(|error| {
        MaterialError::io(
            "physical-path-unavailable",
            "无法规范化素材真实文件父目录",
            error,
        )
    })?;
    let candidate = parent.join(name);
    if path.exists() {
        canonical_regular_file(path)
    } else {
        Ok(candidate)
    }
}

fn canonical_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    let value = value.to_lowercase();
    value
}

fn ensure_path_not_owned_by_other_asset(
    conn: &Connection,
    asset_id: &str,
    target: &Path,
) -> MaterialResult<()> {
    let target_key = canonical_path_key(target);
    let mut statement = conn
        .prepare("SELECT id, original_path, library_path FROM asset WHERE id<>?1")
        .map_err(|error| MaterialError::database("准备素材文件归属检查失败", error))?;
    let rows = statement
        .query_map([asset_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| MaterialError::database("查询素材文件归属失败", error))?;
    for row in rows {
        let (_other_id, original_path, library_path) =
            row.map_err(|error| MaterialError::database("读取素材文件归属失败", error))?;
        for candidate in [Some(original_path), library_path].into_iter().flatten() {
            if candidate.trim().is_empty() {
                continue;
            }
            if let Ok(canonical) = canonical_regular_leaf(Path::new(&candidate)) {
                if canonical_path_key(&canonical) == target_key {
                    return Err(MaterialError::new(
                        "physical-path-owned",
                        "目标文件已由其他素材记录占用",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> MaterialResult<String> {
    let bytes = std::fs::read(path).map_err(|error| {
        MaterialError::io("physical-path-unavailable", "读取素材真实文件失败", error)
    })?;
    Ok(sha256_bytes(&bytes))
}

fn validate_asset_file_name(value: &str) -> MaterialResult<String> {
    let value = value.trim();
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.chars().any(|character| {
            matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) || character.is_control()
        })
    {
        return Err(MaterialError::new(
            "invalid-file-name",
            "文件名为空或包含系统不支持的字符",
        ));
    }
    Ok(value.to_string())
}

/// Resolve the directory where app-owned writes actually land. Windows package
/// redirection can canonicalize a directory and its new files to different roots.
/// Derive trust from our exclusive probe, never from a submitted staging file.
pub(crate) fn resolve_media_staging_root(path: &Path) -> MaterialResult<PathBuf> {
    std::fs::create_dir_all(path).map_err(|error| {
        MaterialError::io("staging-unavailable", "无法创建媒体暂存目录", error)
    })?;
    canonical_trusted_root(path)?;
    let probe_path = path.join(format!(".{}.probe", unique_id("staging-root")));
    let probe = std::fs::OpenOptions::new().write(true).create_new(true)
        .open(&probe_path).map_err(|error| {
            MaterialError::io("staging-unavailable", "无法验证媒体暂存写入目录", error)
        })?;
    let result = (|| {
        let actual = probe_path.canonicalize().map_err(|error| {
            MaterialError::io("staging-unavailable", "无法解析媒体暂存写入目录", error)
        })?;
        let parent = actual.parent().ok_or_else(|| {
            MaterialError::new("staging-unavailable", "媒体暂存写入目录无效")
        })?;
        canonical_trusted_root(parent)
    })();
    drop(probe);
    let cleanup = std::fs::remove_file(&probe_path);
    if let Err(error) = cleanup {
        return Err(MaterialError::io("staging-unavailable", "无法清理媒体暂存验证文件", error));
    }
    result
}

pub(super) fn canonical_trusted_root(path: &Path) -> MaterialResult<PathBuf> {
    if !path.is_absolute() {
        return Err(MaterialError::new(
            "managed-root-untrusted",
            "托管素材库必须使用绝对路径",
        ));
    }
    reject_reparse_components(path)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        MaterialError::io("managed-root-unavailable", "无法验证托管素材库目录", error)
    })?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err(MaterialError::new(
            "managed-root-untrusted",
            "托管素材库不是受信普通目录",
        ));
    }
    path.canonicalize().map_err(|error| {
        MaterialError::io(
            "managed-root-unavailable",
            "无法规范化托管素材库目录",
            error,
        )
    })
}

fn validate_safe_relative_path(path: &Path) -> MaterialResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(MaterialError::new(
            "managed-path-untrusted",
            "托管素材相对路径不安全",
        ));
    }
    Ok(())
}

fn managed_root_id(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    let text = text.to_lowercase();
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn is_sha256_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_delete_token(value: &str) -> bool {
    value.starts_with("delete-")
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn relative_path_to_manifest(path: &Path) -> MaterialResult<String> {
    validate_safe_relative_path(path)?;
    let mut segments = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err(MaterialError::new(
                "delete-pending-invalid",
                "素材删除恢复相对路径无效",
            ));
        };
        let segment = segment.to_str().ok_or_else(|| {
            MaterialError::new("delete-pending-invalid", "素材删除恢复路径不是有效 UTF-8")
        })?;
        if segment.contains(['/', '\\', ':']) {
            return Err(MaterialError::new(
                "delete-pending-invalid",
                "素材删除恢复路径包含无效字符",
            ));
        }
        segments.push(segment);
    }
    Ok(segments.join("/"))
}

fn manifest_relative_path(value: &str) -> MaterialResult<PathBuf> {
    if value.is_empty() || value.contains('\\') || value.contains(':') {
        return Err(MaterialError::new(
            "delete-pending-invalid",
            "素材删除恢复相对路径无效",
        ));
    }
    let mut path = PathBuf::new();
    for segment in value.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(MaterialError::new(
                "delete-pending-invalid",
                "素材删除恢复相对路径包含越界段",
            ));
        }
        path.push(segment);
    }
    validate_safe_relative_path(&path)?;
    Ok(path)
}

fn reject_reparse_components(path: &Path) -> MaterialResult<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(
            component,
            std::path::Component::Prefix(_) | std::path::Component::RootDir
        ) {
            continue;
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata_is_reparse(&metadata) => {
                return Err(MaterialError::new(
                    "managed-path-reparse",
                    "托管素材路径包含符号链接或重解析点",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(MaterialError::io(
                    "managed-path-unavailable",
                    "无法检查托管素材路径组件",
                    error,
                ));
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// Rename the verified source handle rather than looking its path up again.
/// On different volumes, create a new target and mark the held source for
/// deletion only after the copied bytes have been flushed successfully.
fn move_owned_handle_no_replace(source:&mut std::fs::File,destination:&Path)->std::io::Result<Option<std::fs::File>> {
    #[cfg(windows)] {
        use std::os::windows::{ffi::OsStrExt,fs::OpenOptionsExt,io::AsRawHandle};
        #[link(name="kernel32")] extern "system" {fn SetFileInformationByHandle(handle:*mut std::ffi::c_void,class:i32,info:*const std::ffi::c_void,size:u32)->i32;}
        let name:Vec<u16>=destination.as_os_str().encode_wide().collect();
        // FILE_RENAME_INFO: DWORD flags, pointer-aligned RootDirectory, DWORD
        // byte length, then WCHAR filename. Vec<usize> keeps pointer alignment.
        let root_offset=std::mem::size_of::<usize>();
        let length_offset=root_offset+std::mem::size_of::<usize>();
        let name_offset=length_offset+4;
        let bytes=name_offset+(name.len()+1)*2;
        let mut info=vec![0usize;(bytes+std::mem::size_of::<usize>()-1)/std::mem::size_of::<usize>()];
        unsafe {
            let ptr=info.as_mut_ptr() as *mut u8;
            std::ptr::write_unaligned(ptr.add(length_offset) as *mut u32,(name.len()*2) as u32);
            std::ptr::copy_nonoverlapping(name.as_ptr() as *const u8,ptr.add(name_offset),name.len()*2);
        }
        if unsafe {SetFileInformationByHandle(source.as_raw_handle(),3,info.as_ptr() as *const _,bytes as u32)}!=0 {return Ok(None)}
        let error=std::io::Error::last_os_error();
        if error.raw_os_error()!=Some(17) {return Err(error)}
        let mut output=std::fs::OpenOptions::new().write(true).create_new(true).access_mode(0x40010000).share_mode(1).open(destination)?;
        let copied=(||->std::io::Result<()> {
            std::io::copy(source,&mut output)?;
            output.sync_all()?;
            Ok(())
        })();
        if copied.is_err() {
            // Only our CREATE_NEW target can be disposed through this handle.
            // A cleanup failure leaves both copies; the source is never lost.
            let delete:u8=1;
            unsafe {SetFileInformationByHandle(output.as_raw_handle(),4,&delete as *const _ as *const _,1);}
        }
        copied?;
        Ok(Some(output))
    }
    #[cfg(not(windows))] {let _=(source,destination);Err(std::io::Error::new(std::io::ErrorKind::Unsupported,"Coordinated physical moves require Windows"))}
}

fn mark_held_file_for_deletion(file:&std::fs::File)->std::io::Result<()> {
    #[cfg(windows)] {
        use std::os::windows::io::AsRawHandle;
        #[link(name="kernel32")] extern "system" {fn SetFileInformationByHandle(handle:*mut std::ffi::c_void,class:i32,info:*const std::ffi::c_void,size:u32)->i32;}
        let delete:u8=1;
        if unsafe {SetFileInformationByHandle(file.as_raw_handle(),4,&delete as *const _ as *const _,1)}==0 {return Err(std::io::Error::last_os_error())}
        Ok(())
    }
    #[cfg(not(windows))] {let _=file;Err(std::io::Error::new(std::io::ErrorKind::Unsupported,"Windows operation"))}
}

fn hold_material_parent_directories(source:&Path,destination:&Path)->MaterialResult<Vec<std::fs::File>> {
    let mut guards=Vec::new();
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        let mut seen=HashSet::new();
        for path in [source,destination] {
            let mut ancestors=path.parent().ok_or_else(||MaterialError::new("physical-path-untrusted","目标父目录不存在"))?.ancestors().collect::<Vec<_>>();
            ancestors.reverse();
            for parent in ancestors {
                if !seen.insert(canonical_path_key(parent)) {continue;}
                let guard=std::fs::OpenOptions::new().read(true).share_mode(3).custom_flags(0x02000000|0x00200000).open(parent).map_err(|e|MaterialError::io("attachment-directory-busy","附件目录正在变化，请稍后重试",e))?;
                let metadata=guard.metadata().map_err(|e|MaterialError::io("attachment-directory-unavailable","无法校验附件目录",e))?;
                if !metadata.is_dir()||metadata_is_reparse(&metadata) {return Err(MaterialError::new("physical-path-reparse","附件目录包含重解析点"))}
                guards.push(guard);
            }
        }
    }
    #[cfg(not(windows))] let _=(source,destination);
    Ok(guards)
}

/// Windows ownership moves never replace a concurrently-created destination.
/// COPY_ALLOWED supports different volumes without granting arbitrary deletion.
fn move_owned_file_no_replace(source:&Path,destination:&Path)->std::io::Result<()> {
    let _parent_guards=hold_material_parent_directories(source,destination).map_err(|e|std::io::Error::other(e.message))?;
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        #[link(name="kernel32")] extern "system" {fn MoveFileExW(source:*const u16,destination:*const u16,flags:u32)->i32;}
        let source_w:Vec<u16>=source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination_w:Vec<u16>=destination.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {MoveFileExW(source_w.as_ptr(),destination_w.as_ptr(),2)}==0 {return Err(std::io::Error::last_os_error())}
        if source.exists() {return Err(std::io::Error::other("目标已复制但源文件尚未移除；已保留两处文件，请恢复操作"))}
        Ok(())
    }
    #[cfg(not(windows))] { let _=(source,destination);Err(std::io::Error::new(std::io::ErrorKind::Unsupported,"Coordinated physical moves require Windows")) }
}

fn move_material_file(source: &Path, destination: &Path) -> Result<(), String> {
    match std::fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            std::fs::copy(source, destination).map_err(|copy_error| {
                format!("移动失败: {rename_error}; 复制失败: {copy_error}")
            })?;
            if let Err(remove_error) = std::fs::remove_file(source) {
                let _ = std::fs::remove_file(destination);
                return Err(format!("复制后删除原文件失败: {remove_error}"));
            }
            Ok(())
        }
    }
}

fn restore_migrated_files(moved: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    for (source, destination) in moved.iter().rev() {
        if destination.exists() {
            move_material_file(destination, source)?;
        }
    }
    Ok(())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn stream_import_file(source: &Path, destination: Option<&Path>, progress: &mut dyn FnMut(u64, u64)) -> MaterialResult<(String, u64)> {
    use std::io::Write;
    let failure = |e| MaterialError::io("source-read-failed", "读取或暂存素材失败", e);
    let mut input = std::fs::File::open(source).map_err(failure)?;
    let before = input.metadata().map_err(failure)?;
    let mut output = destination.map(|p| std::fs::OpenOptions::new().write(true).create_new(true).open(p)).transpose().map_err(failure)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0u64;
    let mut reported = std::time::Instant::now();
    progress(0, before.len());
    loop {
        let n = input.read(&mut buffer).map_err(failure)?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
        if let Some(output) = output.as_mut() { output.write_all(&buffer[..n]).map_err(failure)?; }
        size += n as u64;
        if reported.elapsed() >= Duration::from_millis(100) {
            progress(size, before.len()); reported = std::time::Instant::now();
        }
    }
    if let Some(output) = output { output.sync_all().map_err(failure)?; }
    let after = input.metadata().map_err(failure)?;
    if size != before.len() || after.len() != before.len() || before.modified().ok() != after.modified().ok() {
        return Err(MaterialError::new("source-changed", "导入过程中原文件已变化，请重试"));
    }
    progress(size, size);
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn sha256_file_and_size(path: &Path) -> MaterialResult<(String, u64)> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| MaterialError::io("staged-file-read-failed", "读取暂存素材失败", error))?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            MaterialError::io("staged-file-read-failed", "读取暂存素材失败", error)
        })?;
        if read == 0 {
            break;
        }
        size = size.checked_add(read as u64).ok_or_else(|| {
            MaterialError::new("staged-file-too-large", "暂存素材大小超出支持范围")
        })?;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn safe_original_source_projection(raw: &str) -> MaterialResult<String> {
    // A Services upload without a web source has no origin to project. The
    // staging path remains app-owned and verified independently of this field.
    if raw.is_empty() { return Ok(String::new()); }
    let url = reqwest::Url::parse(raw)
        .map_err(|_| MaterialError::new("staged-source-invalid", "暂存素材来源无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(MaterialError::new(
            "staged-source-invalid",
            "暂存素材来源无效",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

struct StagedFileCleanup(Option<PathBuf>);

impl Drop for StagedFileCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.as_ref() {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn managed_content_file_name(content_hash: &str, source_name: &str) -> String {
    let extension = Path::new(source_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase();
    if extension.is_empty() {
        content_hash.to_string()
    } else {
        format!("{content_hash}.{extension}")
    }
}

fn promote_managed_temp_no_clobber(
    temporary: &Path,
    destination: &Path,
    expected_hash: &str,
) -> MaterialResult<bool> {
    reject_reparse_components(destination.parent().unwrap_or(destination))?;
    // The download staging area and a user-selected library may be on different
    // volumes. Publish only a complete, verified sibling on the target volume;
    // never copy directly onto the final name or replace an existing asset.
    let mut sibling = None;
    let mut parent_guards = Vec::new();
    let linked = match std::fs::hard_link(temporary, destination) {
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            parent_guards = hold_material_parent_directories(temporary, destination)?;
            sibling = Some(copy_managed_sibling(temporary, destination, expected_hash)?);
            std::fs::hard_link(sibling.as_ref().unwrap().0.as_ref().unwrap(), destination)
        }
        result => result,
    };
    let result = match linked {
        Ok(()) => Ok(true),
        Err(error) => match std::fs::symlink_metadata(destination) {
            Ok(metadata) if metadata.is_file() && !metadata_is_reparse(&metadata) => {
                let existing_hash = sha256_file(destination)?;
                if existing_hash.eq_ignore_ascii_case(expected_hash) {
                    Ok(false)
                } else {
                    Err(MaterialError::new(
                        "managed-destination-conflict",
                        "托管素材目标已存在且内容不一致",
                    ))
                }
            }
            Ok(_) => Err(MaterialError::new(
                "managed-destination-conflict",
                "托管素材目标已被非普通文件对象占用",
            )),
            Err(metadata_error) if metadata_error.kind() == std::io::ErrorKind::NotFound => Err(
                MaterialError::io("copy-failed", "提交托管素材文件失败", error),
            ),
            Err(metadata_error) => Err(MaterialError::io(
                "copy-failed",
                "验证托管素材目标失败",
                metadata_error,
            )),
        },
    };
    drop(sibling);
    drop(parent_guards);
    result
}

fn copy_managed_sibling(
    source: &Path, destination: &Path, expected_hash: &str,
) -> MaterialResult<StagedFileCleanup> {
    use std::io::Write;
    let failure = |error| MaterialError::io("copy-failed", "暂存跨盘素材失败", error);
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        // Pin a regular source against replacement/writes while copying.
        options.share_mode(1).custom_flags(0x00200000);
    }
    let mut input = options.open(source).map_err(failure)?;
    let metadata = input.metadata().map_err(failure)?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err(MaterialError::new("staged-file-untrusted", "暂存素材不是可信普通文件"));
    }
    let sibling = destination.with_file_name(format!(".luckyray-import-{}.tmp", unique_id("cross-volume")));
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true)
        .open(&sibling).map_err(failure)?;
    let cleanup = StagedFileCleanup(Some(sibling));
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    let copied = (|| -> MaterialResult<()> {
        loop {
            let count = input.read(&mut buffer).map_err(failure)?;
            if count == 0 { break; }
            output.write_all(&buffer[..count]).map_err(failure)?;
            hash.update(&buffer[..count]);
            size += count as u64;
        }
        if size != metadata.len() || !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(expected_hash) {
            return Err(MaterialError::new("staged-file-changed", "暂存素材内容与下载结果不一致"));
        }
        output.sync_all().map_err(failure)
    })();
    // Close before cleanup, including failure, on Windows.
    drop(output);
    copied?;
    Ok(cleanup)
}

fn safe_file_name(name: &str) -> String {
    let value = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => character,
        })
        .collect::<String>();
    let trimmed = value.trim().trim_matches('.');
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn kind_from_name(name: &str) -> &'static str {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" => "image",
        "mp4" | "mov" | "avi" | "mkv" | "webm" => "video",
        "mp3" | "wav" | "ogg" | "flac" | "m4a" => "audio",
        "pdf" | "doc" | "docx" | "md" | "txt" | "rtf" | "ppt" | "pptx" | "xls" | "xlsx" => {
            "document"
        }
        _ => "other",
    }
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn material_asset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MaterialAsset> {
    Ok(MaterialAsset {
        id: row.get(0)?,
        name: row.get(1)?,
        original_path: row.get(2)?,
        library_path: row.get(3)?,
        storage_mode: row.get(4)?,
        kind: row.get(5)?,
        mime_type: row.get(6)?,
        size_bytes: row.get(7)?,
        thumbnail_url: row.get(8)?,
        description: row.get(9)?,
        rating: row.get(10)?,
        dominant_color: row.get(11)?,
        folder_id: row.get(12)?,
        imported_at: row.get(13)?,
        updated_at: row.get(14)?,
        content_hash: row.get(15)?,
    })
}

fn repeat_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(",")
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn normalize_color(value: Option<&str>) -> Option<String> {
    non_empty(value).map(|value| value.to_ascii_lowercase())
}

pub(crate) fn unique_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}-{:x}-{:09x}-{:x}-{sequence:x}",
        now.as_secs(),
        now.subsec_nanos(),
        std::process::id()
    )
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use std::sync::{Arc, Barrier};

    use super::{
        canonical_path_key, canonical_regular_leaf, managed_content_file_name, managed_root_id,
        now, sha256_bytes, sha256_file, csv_source_type, MaterialCatalog,
    };
    use crate::materials::MaterialFilter;
    use crate::materials::CsvExportPlanRequest;
    use crate::materials::{
        MaterialAssetPatch, MaterialBytesInput, MaterialFolderInput, MaterialFolderMove,
        MaterialImportOptions, MaterialRelocateOptions, MaterialSourcePageInput, PatchValue,
    };

    #[test]
    fn staged_commit_to_separate_library_preserves_bytes_and_source() {
        use crate::materials::MaterialStagedFileInput;
        let catalog = MaterialCatalog::new_for_test();
        // Optional real second-volume root for Windows integration runs. The
        // default still exercises production staging/commit with isolated data.
        let external = std::env::var_os("LUCKYRAY_TEST_CROSS_VOLUME_ROOT");
        let root = external.as_ref().map(std::path::PathBuf::from)
            .unwrap_or_else(|| catalog.app_data_dir().join("separate"))
            .join(super::unique_id("staged-commit-test"));
        std::fs::create_dir_all(&root).unwrap();
        let staging = catalog.app_data_dir().join("media-transfer-staging");
        std::fs::create_dir_all(&staging).unwrap();
        let library = catalog.create_library("跨盘合成库", &root, "managed").unwrap();
        let scoped = catalog.for_library(&library.id).unwrap();
        let staged = staging.join("test.part");
        for extension in ["mp4", "webm"] {
        let bytes = std::env::var_os("LUCKYRAY_TEST_MEDIA_FIXTURES")
            .map(|dir| std::fs::read(std::path::PathBuf::from(dir).join(format!("synthetic.{extension}"))).unwrap())
            .unwrap_or_else(|| vec![if extension == "mp4" { 0x53u8 } else { 0x54 }; 13932]);
        let hash = sha256_bytes(&bytes);
        std::fs::write(&staged, &bytes).unwrap();
        if external.is_some() {
            let error = std::fs::hard_link(&staged, root.join("cross-volume-probe")).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(17), "requires real different Windows volumes");
            eprintln!("isolated Windows hard-link probe: raw_os_error=17 (different volumes)");
        }
        let options = MaterialImportOptions::default();
        let source = MaterialSourcePageInput { page_url: "https://example.com/video".into(),
            page_kind: "capture-page".into(), title: Some("合成视频来源".into()) };
        let input = || MaterialStagedFileInput { path: staged.clone(), name: format!("合成原格式.{extension}"),
            original_source: format!("https://example.com/test.{extension}"), mime_type: format!("video/{extension}"),
            description: None, expected_size_bytes: bytes.len() as u64, expected_sha256: hash.clone() };
        let saved = scoped.import_consumer_staged_file_with_source(input(), &options, Some(&source))
            .unwrap_or_else(|error| panic!("production staged commit: {} / {}", error.code, error.message));
        let asset = &saved.value.assets[0];
        assert_eq!(saved.value.imported_count, 1);
        assert_eq!(asset.name, format!("合成原格式.{extension}"));
        assert_eq!(asset.original_path, "https://example.com");
        assert_eq!(asset.content_hash.as_deref(), Some(hash.as_str()));
        assert_eq!(std::fs::read(asset.library_path.as_ref().unwrap()).unwrap(), bytes);
        assert!(!staged.exists());
        assert_eq!(scoped.get_source_page(&asset.id).unwrap().unwrap().page_url, source.page_url);
        std::fs::write(&staged, &bytes).unwrap();
        let duplicate = scoped.import_consumer_staged_file_with_source(input(), &options, Some(&source)).unwrap();
        assert_eq!(duplicate.value.skipped_duplicate_count, 1);
        assert_eq!(duplicate.value.assets[0].id, asset.id);
        assert!(!staged.exists());
        eprintln!("production explicit-library staged {extension}: bytes={}, hash={hash}, provenance+duplicate PASS", bytes.len());
        }
        assert_eq!(scoped.list_assets(&Default::default()).unwrap().len(), 2);
        assert_eq!(std::fs::read_dir(root.join("assets")).unwrap().count(), 2);
        let reopened = MaterialCatalog::new(catalog.db_path(), catalog.app_data_dir()).for_library(&library.id).unwrap();
        assert_eq!(reopened.list_assets(&Default::default()).unwrap().len(), 2);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(catalog.app_data_dir()).unwrap();
    }

    #[test]
    fn cross_volume_copy_hash_mismatch_cleans_private_sibling() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source.part");
        let destination = catalog.app_data_dir().join("final.mp4");
        std::fs::write(&source, b"changed-source").unwrap();
        let error = super::copy_managed_sibling(&source, &destination, &sha256_bytes(b"expected")).err().unwrap();
        assert_eq!(error.code, "staged-file-changed");
        assert!(!destination.exists());
        assert_eq!(std::fs::read(&source).unwrap(), b"changed-source");
        assert!(!std::fs::read_dir(catalog.app_data_dir()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".luckyray-import-")));
        std::fs::remove_dir_all(catalog.app_data_dir()).unwrap();
    }

    #[test]
    fn cross_volume_promotion_concurrent_publish_never_overwrites() {
        let catalog = MaterialCatalog::new_for_test();
        let root = std::env::var_os("LUCKYRAY_TEST_CROSS_VOLUME_ROOT").map(std::path::PathBuf::from)
            .unwrap_or_else(|| catalog.app_data_dir().join("separate"))
            .join(super::unique_id("promotion-test"));
        std::fs::create_dir_all(&root).unwrap();
        for same_bytes in [true, false] {
            let destination = root.join("final.mp4");
            let barrier = Arc::new(Barrier::new(2));
            let threads = (0..2).map(|index| {
                let bytes = vec![if same_bytes { 0x53u8 } else { 0x53 + index }; 128 * 1024];
                let source = catalog.app_data_dir().join(format!("{index}.part"));
                std::fs::write(&source, &bytes).unwrap();
                let hash = sha256_bytes(&bytes);
                let barrier = barrier.clone();
                let destination = destination.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    (super::promote_managed_temp_no_clobber(&source, &destination, &hash), hash)
                })
            }).collect::<Vec<_>>();
            let results = threads.into_iter().map(|t| t.join().unwrap()).collect::<Vec<_>>();
            assert_eq!(results.iter().filter(|(result, _)| matches!(result, Ok(true))).count(), 1);
            let winner = results.iter().find(|(result, _)| matches!(result, Ok(true))).unwrap();
            assert_eq!(sha256_file(&destination).unwrap(), winner.1);
            if same_bytes { assert_eq!(results.iter().filter(|(r, _)| matches!(r, Ok(false))).count(), 1); }
            else { assert_eq!(results.iter().find_map(|(r, _)| r.as_ref().err()).unwrap().code, "managed-destination-conflict"); }
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
            std::fs::remove_file(&destination).unwrap();
        }
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(catalog.app_data_dir()).unwrap();
    }

    fn pending_delete_entries(catalog: &MaterialCatalog) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(catalog.app_data_dir().join("material-delete-pending"))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    }

    fn library_entries(catalog: &MaterialCatalog) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(catalog.app_data_dir().join("asset-library"))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    }

    fn managed_bytes(name: &str, original_path: &str, bytes: &[u8]) -> MaterialBytesInput {
        MaterialBytesInput {
            name: name.into(),
            original_path: original_path.into(),
            mime_type: "image/png".into(),
            description: None,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn csv_metadata_snapshot_uses_ids_not_names_and_never_needs_missing_media() {
        let catalog = MaterialCatalog::new_for_test();
        let left = catalog.create_folder(MaterialFolderInput { parent_id: None, name: "同名".into() }).unwrap().value;
        let right_parent = catalog.create_folder(MaterialFolderInput { parent_id: None, name: "另一分类".into() }).unwrap().value;
        let right = catalog.create_folder(MaterialFolderInput { parent_id: Some(right_parent.id.clone()), name: "同名".into() }).unwrap().value;
        let conn = catalog.open_write().unwrap();
        for (id, folder) in [("left", &left.id), ("right", &right.id)] {
            conn.execute("INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash)
                VALUES(?1,'=危险名称','C:\\missing\\never-open.png',NULL,'linked','image','image/png',123,'','描述',4,NULL,?2,'2026-09-26','2026-09-26',NULL)", params![id,folder]).unwrap();
        }
        conn.execute("INSERT INTO asset_source_page(asset_id,page_url,page_kind,title) VALUES('left','https://works.test/pin/42?q=中文#slide-3','work-page','作品标题')", []).unwrap();
        conn.execute("INSERT INTO tag(id,name,color,created_at,updated_at) VALUES('tag-1','红,蓝',NULL,'2026','2026')", []).unwrap();
        conn.execute("INSERT INTO material_library_tag(id,library_id,name,color,created_at,updated_at) SELECT 'tag-1',legacy_id,'红,蓝',NULL,'2026','2026' FROM material_library_state", []).unwrap();
        conn.execute("INSERT INTO item_tag(id,item_type,item_id,tag_id,created_at) VALUES('item-1','asset','left','tag-1','2026')", []).unwrap();
        drop(conn);
        let folder = catalog.csv_metadata_snapshot(CsvExportPlanRequest::Folder { folder_id: left.id.clone() }).unwrap();
        assert_eq!(folder.rows.len(), 1);
        assert_eq!(folder.rows[0].id, "left");
        assert_eq!(folder.rows[0].folder_path, vec!["同名"]);
        assert_eq!(folder.rows[0].tags, vec!["红,蓝"]);
        assert_eq!(folder.rows[0].source_type, "作品页");
        assert!(folder.rows[0].source_page_url.contains("?q="));
        assert!(folder.rows[0].source_page_url.ends_with("#slide-3"));
        let selected = catalog.csv_metadata_snapshot(CsvExportPlanRequest::Assets { asset_ids: vec!["right".into(), "right".into()] }).unwrap();
        assert_eq!(selected.rows.len(), 1);
        assert_eq!(selected.rows[0].folder_path, vec!["另一分类", "同名"]);
        assert!(selected.rows[0].source_page_url.is_empty());
        assert!(catalog.csv_metadata_snapshot(CsvExportPlanRequest::Assets { asset_ids: vec!["left".into(), "gone".into()] }).is_err());
    }

    #[test]
    fn csv_folder_rejects_more_than_500_rows_before_any_file_write() {
        let catalog = MaterialCatalog::new_for_test();
        let folder = catalog.create_folder(MaterialFolderInput { parent_id: None, name: "很多".into() }).unwrap().value;
        let conn = catalog.open_write().unwrap();
        for index in 0..501 {
            conn.execute("INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash)
                VALUES(?1,?1,'C:\\missing\\never-open.png',NULL,'linked','other','',NULL,'','',NULL,NULL,?2,'2026','2026',NULL)",
                params![format!("asset-{index}"), folder.id]).unwrap();
        }
        drop(conn);
        let error = catalog.csv_metadata_snapshot(CsvExportPlanRequest::Folder { folder_id: folder.id }).unwrap_err();
        assert_eq!(error.code, "csv-too-many-rows");
    }

    #[test]
    fn csv_small_scope_ignores_unrelated_folders_and_supports_real_deep_paths() {
        let catalog = MaterialCatalog::new_for_test();
        let mut parent = None;
        let mut path_ids = Vec::new();
        for depth in 0..17 {
            let folder = catalog.create_folder(MaterialFolderInput {
                parent_id: parent.clone(), name: format!("Level {depth}"),
            }).unwrap().value;
            parent = Some(folder.id.clone());
            path_ids.push(folder.id);
        }
        let leaf = parent.unwrap();
        let conn = catalog.open_write().unwrap();
        for index in 0..513 {
            conn.execute("INSERT INTO folder(id,scope,parent_id,name,sort_order,open,created_at,updated_at)
                VALUES(?1,'materials',NULL,?2,0,0,'2026','2026')",
                params![format!("unrelated-{index}"), format!("Unrelated {index}")]).unwrap();
        }
        conn.execute("INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash)
            VALUES('deep-asset','deep.png','C:\\missing\\deep.png',NULL,'linked','image','image/png',10,'','',NULL,NULL,?1,'2026','2026',NULL)", [&leaf]).unwrap();
        drop(conn);
        let selected = catalog.csv_metadata_snapshot(CsvExportPlanRequest::Assets { asset_ids: vec!["deep-asset".into()] }).unwrap();
        assert_eq!(selected.rows.len(), 1);
        assert_eq!(selected.rows[0].folder_path.len(), 17);
        let folder = catalog.csv_metadata_snapshot(CsvExportPlanRequest::Folder { folder_id: path_ids[0].clone() }).unwrap();
        assert_eq!(folder.rows.len(), 1);
        assert_eq!(folder.rows[0].id, "deep-asset");
    }

    #[test]
    fn csv_source_type_does_not_mislabel_web_case_or_placeholder_as_local() {
        assert_eq!(csv_source_type("HTTPS://example.test/work?pin=42#frame", None), "网页资源");
        assert_eq!(csv_source_type("https://example.test/", None), "网站入口");
        assert_eq!(csv_source_type("data:image/png;base64,AA", None), "未记录");
        assert_eq!(csv_source_type("blob:https://example.test/id", None), "未记录");
        assert_eq!(csv_source_type("javascript:alert(1)", None), "未记录");
        assert_eq!(csv_source_type("https://user:secret@example.test/work", None), "未记录");
        assert_eq!(csv_source_type("C:\\missing\\image.png", None), "本地文件");
        assert_eq!(csv_source_type("https://cdn.test/image.png", Some("capture-page")), "采集页");
    }

    #[test]
    fn captured_work_page_survives_reopen_and_duplicate_never_overwrites_it() {
        let catalog = MaterialCatalog::new_for_test();
        let source = MaterialSourcePageInput::from_parts(
            "https://works.test/item/a?work=42#slide-3", "work-page", Some("作品 A"),
        ).unwrap();
        let input = managed_bytes("card.png", "https://cdn.test/a.png?sig=secret", b"image-a");
        let first = catalog.import_bytes_with_source(
            vec![input.clone()], &MaterialImportOptions::default(), Some(&source),
        ).unwrap();
        let id = first.value.assets[0].id.clone();
        assert_eq!(catalog.get_source_page(&id).unwrap().unwrap().page_url, source.page_url);
        let changed = MaterialSourcePageInput::from_parts(
            "https://works.test/item/b?work=99#other", "work-page", None,
        ).unwrap();
        let duplicate = catalog.import_bytes_with_source(
            vec![input], &MaterialImportOptions::default(), Some(&changed),
        ).unwrap();
        assert_eq!(duplicate.value.skipped_duplicate_count, 1);
        assert!(duplicate.change.is_none());
        let reopened = MaterialCatalog::new(catalog.db_path().to_path_buf(), catalog.app_data_dir().to_path_buf());
        let connection = rusqlite::Connection::open(reopened.db_path()).unwrap();
        super::ensure_change_schema(&connection).unwrap();
        super::ensure_change_schema(&connection).unwrap();
        assert_eq!(reopened.get_source_page(&id).unwrap().unwrap().page_url, source.page_url);
        assert_eq!(reopened.get_source_page("missing").unwrap(), None);
    }

    #[test]
    fn active_duplicate_only_fills_empty_source_and_bad_page_rolls_back() {
        let catalog = MaterialCatalog::new_for_test();
        let input = managed_bytes("legacy.png", "https://cdn.test/legacy.png", b"legacy");
        let first = catalog.import_bytes(vec![input.clone()], &MaterialImportOptions::default()).unwrap();
        let id = first.value.assets[0].id.clone();
        let before_revision = catalog.revision_for_asset(&first.value.assets[0]).unwrap();
        assert_eq!(catalog.get_source_page(&id).unwrap(), None);
        let source = MaterialSourcePageInput::from_parts(
            "https://works.test/item/legacy?x=1#detail", "work-page", None,
        ).unwrap();
        let filled = catalog.import_bytes_with_source(
            vec![input], &MaterialImportOptions::default(), Some(&source),
        ).unwrap();
        assert_eq!(filled.value.skipped_duplicate_count, 1);
        assert!(filled.change.is_some());
        assert_eq!(catalog.get_source_page(&id).unwrap().unwrap().page_url, source.page_url);
        let after_asset = catalog.get_assets(&[id.clone()]).unwrap().pop().unwrap();
        assert_ne!(catalog.revision_for_asset(&after_asset).unwrap(), before_revision);
        assert!(MaterialSourcePageInput::from_parts("javascript:alert(1)", "work-page", None).is_none());
        assert!(MaterialSourcePageInput::from_parts("https://user:secret@works.test/a", "work-page", None).is_none());
        let invalid = MaterialSourcePageInput {
            page_url: "file:///C:/secret".into(), page_kind: "work-page".into(), title: None,
        };
        let failed = catalog.import_bytes_with_source(
            vec![managed_bytes("bad.png", "https://cdn.test/bad.png", b"bad-new-image")],
            &MaterialImportOptions::default(), Some(&invalid),
        ).unwrap();
        assert_eq!(failed.value.imported_count, 0);
        assert_eq!(failed.value.failed_count, 1);
        assert!(catalog.find_managed_asset_by_hash(&sha256_bytes(b"bad-new-image")).unwrap().is_none());
    }

    fn insert_asset(
        catalog: &MaterialCatalog,
        id: &str,
        kind: &str,
        folder_id: &str,
        imported_at: &str,
        rating: i64,
        colors: &str,
    ) {
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "INSERT INTO asset (
                id, name, original_path, library_path, storage_mode, kind, mime_type,
                size_bytes, thumbnail_url, description, rating, dominant_color, folder_id,
                imported_at, updated_at, content_hash
             ) VALUES (?1, ?2, ?3, ?4, 'managed', ?5, 'image/png', 42, ?6, 'desc', ?7, ?8, ?9, ?10, ?10, ?11)",
            params![
                id,
                format!("{id}.png"),
                format!("C:/source/{id}.png"),
                format!("C:/library/{id}.png"),
                kind,
                format!("C:/library/{id}.png"),
                rating,
                colors,
                folder_id,
                imported_at,
                format!("hash-{id}")
            ],
        )
        .unwrap();
    }

    #[test]
    fn public_query_returns_full_shape_and_applies_all_filters() {
        let catalog = MaterialCatalog::new_for_test();
        insert_asset(
            &catalog,
            "match",
            "image",
            "folder-a",
            "2026-07-12T12:00:00Z",
            4,
            "#112233,#abcdef",
        );
        insert_asset(
            &catalog,
            "wrong-kind",
            "video",
            "folder-a",
            "2026-07-12T12:00:00Z",
            4,
            "#abcdef",
        );
        insert_asset(
            &catalog,
            "wrong-folder",
            "image",
            "folder-b",
            "2026-07-12T12:00:00Z",
            4,
            "#abcdef",
        );
        insert_asset(
            &catalog,
            "too-old",
            "image",
            "folder-a",
            "2026-06-01T12:00:00Z",
            4,
            "#abcdef",
        );
        insert_asset(
            &catalog,
            "wrong-rating",
            "image",
            "folder-a",
            "2026-07-12T12:00:00Z",
            2,
            "#abcdef",
        );
        insert_asset(
            &catalog,
            "wrong-color",
            "image",
            "folder-a",
            "2026-07-12T12:00:00Z",
            4,
            "#000000",
        );
        insert_asset(
            &catalog,
            "partial-tag",
            "image",
            "folder-a",
            "2026-07-12T12:00:00Z",
            4,
            "#abcdef",
        );
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        for (index, tag_id) in ["tag-a", "tag-b"].iter().enumerate() {
            conn.execute(
                "INSERT INTO item_tag (id, item_type, item_id, tag_id, created_at) VALUES (?1, 'asset', 'match', ?2, 'now')",
                params![format!("item-{index}"), tag_id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO item_tag (id, item_type, item_id, tag_id, created_at) VALUES ('partial-tag-a', 'asset', 'partial-tag', 'tag-a', 'now')",
            [],
        ).unwrap();

        let assets = catalog
            .list_assets(&MaterialFilter {
                kinds: vec!["image".into()],
                tag_ids: vec!["tag-a".into(), "tag-b".into()],
                folder_id: Some("folder-a".into()),
                date_from: Some("2026-07-01T00:00:00Z".into()),
                date_to: Some("2026-08-01T00:00:00Z".into()),
                rating_min: Some(3),
                dominant_color: Some("#abcdef".into()),
                limit: Some(10),
                ..MaterialFilter::default()
            })
            .unwrap();

        assert_eq!(assets.len(), 1);
        let asset = &assets[0];
        assert_eq!(asset.id, "match");
        assert_eq!(asset.original_path, "C:/source/match.png");
        assert_eq!(asset.library_path.as_deref(), Some("C:/library/match.png"));
        assert_eq!(asset.storage_mode, "managed");
        assert_eq!(asset.mime_type, "image/png");
        assert_eq!(asset.size_bytes, Some(42));
        assert_eq!(asset.thumbnail_url, "C:/library/match.png");
        assert_eq!(asset.description, "desc");
        assert_eq!(asset.rating, Some(4));
        assert_eq!(asset.dominant_color.as_deref(), Some("#112233,#abcdef"));
        assert_eq!(asset.content_hash.as_deref(), Some("hash-match"));

        let limited = catalog
            .list_assets(&MaterialFilter {
                limit: Some(1),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(limited.len(), 1);
        for index in 0..51 {
            insert_asset(
                &catalog,
                &format!("recent-{index}"),
                "other",
                "bulk",
                "2026-07-13T00:00:00Z",
                0,
                "",
            );
        }
        let recent = catalog
            .list_assets(&MaterialFilter {
                recent_only: true,
                limit: Some(1),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(recent.len(), 50);
    }

    #[test]
    fn targeted_asset_read_preserves_requested_identity_without_full_catalog_projection() {
        let catalog = MaterialCatalog::new_for_test();
        insert_asset(
            &catalog,
            "asset-a",
            "image",
            "folder-a",
            "2026-07-12T12:00:00Z",
            4,
            "#112233",
        );
        insert_asset(
            &catalog,
            "asset-b",
            "video",
            "folder-b",
            "2026-07-13T12:00:00Z",
            5,
            "#abcdef",
        );

        let assets = catalog
            .get_assets(&[
                "asset-b".to_owned(),
                "missing".to_owned(),
                "asset-a".to_owned(),
                "asset-b".to_owned(),
            ])
            .unwrap();
        assert_eq!(
            assets
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            vec!["asset-b", "asset-a"]
        );
        assert_eq!(
            catalog.get_assets(&[]).unwrap_err().code,
            "material-target-selection-invalid"
        );
    }

    #[test]
    fn targeted_asset_tag_map_queries_only_requested_ids_and_preserves_empty_entries() {
        let catalog = MaterialCatalog::new_for_test();
        for id in ["asset-a","asset-b"] {insert_asset(&catalog,id,"image","","2026-07-13T00:00:00Z",0,"");}
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        for (row_id, asset_id, tag_id) in [
            ("row-a", "asset-a", "tag-a"),
            ("row-b", "asset-b", "tag-b"),
            ("row-c", "asset-b", "tag-c"),
        ] {
            conn.execute(
                "INSERT INTO item_tag(id,item_type,item_id,tag_id,created_at) VALUES(?1,'asset',?2,?3,'now')",
                params![row_id, asset_id, tag_id],
            )
            .unwrap();
        }

        let map = catalog
            .list_asset_tag_map(Some(vec![
                "asset-a".to_owned(),
                "missing".to_owned(),
                "asset-a".to_owned(),
            ]))
            .unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("asset-a"), Some(&vec!["tag-a".to_owned()]));
        assert_eq!(map.get("missing"), Some(&Vec::new()));
        assert!(!map.contains_key("asset-b"));
        assert!(catalog
            .list_asset_tag_map(Some(Vec::new()))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn public_full_text_search_returns_ranked_canonical_assets_and_snippets() {
        let catalog = MaterialCatalog::new_for_test();
        insert_asset(
            &catalog,
            "search-match",
            "image",
            "folder-a",
            "2026-07-12T12:00:00Z",
            4,
            "#abcdef",
        );
        insert_asset(
            &catalog,
            "search-miss",
            "video",
            "folder-b",
            "2026-07-11T12:00:00Z",
            1,
            "#000000",
        );
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE asset_search USING fts5(id UNINDEXED, name, description, original_path);
             INSERT INTO asset_search(id, name, description, original_path)
             VALUES ('search-match', 'search-match.png', 'a unique catalog phrase', 'C:/source/search-match.png');
             INSERT INTO asset_search(id, name, description, original_path)
             VALUES ('search-miss', 'search-miss.png', 'unrelated words', 'C:/source/search-miss.png');",
        )
        .unwrap();

        let hits = catalog.search_assets("\"unique\"", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].asset.id, "search-match");
        assert_eq!(hits[0].asset.storage_mode, "managed");
        assert_eq!(
            hits[0].asset.content_hash.as_deref(),
            Some("hash-search-match")
        );
        assert!(hits[0].snippet.contains("<b>unique</b>"));
    }

    #[test]
    fn public_import_preserves_path_identity_and_dedupes_managed_content() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("same.bin");
        std::fs::write(&source, b"same-content").unwrap();
        let result = catalog
            .import_paths(&[source.clone()], &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(result.value.imported_count, 1);
        let duplicate = catalog
            .import_paths(&[source.clone()], &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(duplicate.value.skipped_duplicate_count, 1);

        let linked_source = source.clone();
        let linked = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "linked".into(),
                    ..MaterialImportOptions::default()
                },
            )
            .unwrap();
        assert_eq!(linked.value.imported_count, 1);
        let source_mode = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(source_mode.value.imported_count, 1);
        let source_duplicate = catalog
            .import_paths(
                &[linked_source],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(source_duplicate.value.skipped_duplicate_count, 1);

        let folder = catalog
            .create_folder(MaterialFolderInput {
                parent_id: None,
                name: "Dedupe".into(),
            })
            .unwrap()
            .value;
        let bytes = vec![MaterialBytesInput {
            name: "same-folder.bin".into(),
            original_path: "memory://same-folder".into(),
            mime_type: "application/octet-stream".into(),
            description: None,
            bytes: b"same-folder".to_vec(),
        }];
        let options = MaterialImportOptions {
            folder_id: Some(folder.id),
            ..Default::default()
        };
        catalog.import_bytes(bytes.clone(), &options).unwrap();
        let version = catalog.read_change().unwrap().version;
        let duplicate = catalog.import_bytes(bytes, &options).unwrap();
        assert_eq!(duplicate.value.skipped_duplicate_count, 1);
        assert!(duplicate.change.is_none());
        assert_eq!(catalog.read_change().unwrap().version, version);
    }

    #[test]
    fn public_managed_import_keeps_different_same_named_bytes_in_distinct_files() {
        let catalog = MaterialCatalog::new_for_test();
        let first = catalog
            .import_bytes(
                vec![managed_bytes(
                    "download.png",
                    "https://example.test/first.png",
                    b"first-managed-image",
                )],
                &MaterialImportOptions::default(),
            )
            .unwrap();
        let second = catalog
            .import_bytes(
                vec![managed_bytes(
                    "download.png",
                    "https://example.test/second.png",
                    b"second-managed-image",
                )],
                &MaterialImportOptions::default(),
            )
            .unwrap();

        let first_asset = &first.value.assets[0];
        let second_asset = &second.value.assets[0];
        let first_path = std::path::PathBuf::from(first_asset.library_path.as_ref().unwrap());
        let second_path = std::path::PathBuf::from(second_asset.library_path.as_ref().unwrap());

        assert_ne!(first_path, second_path);
        assert_eq!(
            sha256_file(&first_path).unwrap(),
            first_asset.content_hash.as_deref().unwrap()
        );
        assert_eq!(
            sha256_file(&second_path).unwrap(),
            second_asset.content_hash.as_deref().unwrap()
        );
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn rapid_same_named_managed_imports_keep_every_distinct_content_file() {
        let catalog = MaterialCatalog::new_for_test();
        let mut paths = std::collections::HashSet::new();
        for index in 0..16 {
            let bytes = format!("rapid-managed-content-{index}");
            let result = catalog
                .import_bytes(
                    vec![managed_bytes(
                        "download.png",
                        &format!("https://example.test/rapid/{index}.png"),
                        bytes.as_bytes(),
                    )],
                    &MaterialImportOptions::default(),
                )
                .unwrap();
            let asset = &result.value.assets[0];
            let path = std::path::PathBuf::from(asset.library_path.as_ref().unwrap());
            assert!(paths.insert(path.clone()));
            assert_eq!(
                sha256_file(&path).unwrap(),
                asset.content_hash.as_deref().unwrap()
            );
        }

        assert_eq!(paths.len(), 16);
        assert_eq!(library_entries(&catalog).len(), 16);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            16
        );
        assert_eq!(catalog.read_change().unwrap().version, 16);
    }

    #[test]
    fn public_managed_import_reuses_same_hash_orphan_without_overwriting_it() {
        let catalog = MaterialCatalog::new_for_test();
        let input = managed_bytes(
            "download.png",
            "https://example.test/orphan.png",
            b"orphan-managed-image",
        );
        let first = catalog
            .import_bytes(vec![input.clone()], &MaterialImportOptions::default())
            .unwrap();
        let first_asset = &first.value.assets[0];
        let first_path = std::path::PathBuf::from(first_asset.library_path.as_ref().unwrap());
        let first_hash = first_asset.content_hash.clone().unwrap();
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute("DELETE FROM asset WHERE id=?1", [&first_asset.id])
            .unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let recovered = catalog
            .import_bytes(vec![input], &MaterialImportOptions::default())
            .unwrap();
        let recovered_asset = &recovered.value.assets[0];

        assert_eq!(recovered.value.imported_count, 1);
        assert_eq!(recovered_asset.library_path.as_deref(), first_path.to_str());
        assert_eq!(sha256_file(&first_path).unwrap(), first_hash);
        assert_eq!(library_entries(&catalog), vec![first_path]);
        assert_eq!(catalog.read_change().unwrap().version, version_before + 1);
    }

    #[test]
    fn database_failure_never_removes_a_reused_same_hash_orphan() {
        let catalog = MaterialCatalog::new_for_test();
        let input = managed_bytes(
            "orphan-reject.png",
            "https://example.test/orphan-reject.png",
            b"orphan-must-survive-database-failure",
        );
        let first = catalog
            .import_bytes(vec![input.clone()], &MaterialImportOptions::default())
            .unwrap();
        let first_asset = &first.value.assets[0];
        let destination = std::path::PathBuf::from(first_asset.library_path.as_ref().unwrap());
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute("DELETE FROM asset WHERE id=?1", [&first_asset.id])
            .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_reused_orphan BEFORE INSERT ON asset
             WHEN NEW.name='orphan-reject.png' BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
        )
        .unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let rejected = catalog
            .import_bytes(vec![input], &MaterialImportOptions::default())
            .unwrap();

        assert_eq!(
            (rejected.value.imported_count, rejected.value.failed_count),
            (0, 1)
        );
        assert!(rejected.change.is_none());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"orphan-must-survive-database-failure"
        );
        assert_eq!(library_entries(&catalog), vec![destination]);
    }

    #[test]
    fn public_managed_import_fails_closed_for_different_preexisting_destination() {
        let catalog = MaterialCatalog::new_for_test();
        let input = managed_bytes(
            "download.png",
            "https://example.test/conflict.png",
            b"expected-managed-image",
        );
        let first = catalog
            .import_bytes(vec![input.clone()], &MaterialImportOptions::default())
            .unwrap();
        let first_asset = &first.value.assets[0];
        let destination = std::path::PathBuf::from(first_asset.library_path.as_ref().unwrap());
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute("DELETE FROM asset WHERE id=?1", [&first_asset.id])
            .unwrap();
        std::fs::write(&destination, b"unrelated-preexisting-file").unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let rejected = catalog
            .import_bytes(vec![input], &MaterialImportOptions::default())
            .unwrap();

        assert_eq!(
            (rejected.value.imported_count, rejected.value.failed_count),
            (0, 1)
        );
        assert_eq!(
            rejected.value.failed_items[0].code,
            "managed-destination-conflict"
        );
        assert!(rejected.change.is_none());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"unrelated-preexisting-file"
        );
        assert_eq!(library_entries(&catalog), vec![destination]);
    }

    #[cfg(windows)]
    #[test]
    fn public_managed_import_never_reuses_a_reparse_destination() {
        let catalog = MaterialCatalog::new_for_test();
        let bytes = b"managed-reparse-content";
        let library = catalog.app_data_dir().join("asset-library");
        std::fs::create_dir_all(&library).unwrap();
        let destination = library.join(managed_content_file_name(
            &sha256_bytes(bytes),
            "download.png",
        ));
        let external = catalog.app_data_dir().join("external-managed-target.png");
        std::fs::write(&external, bytes).unwrap();
        if let Err(error) = std::os::windows::fs::symlink_file(&external, &destination) {
            eprintln!("SKIP managed import reparse fixture: {error}");
            return;
        }
        let version_before = catalog.read_change().unwrap().version;

        let rejected = catalog
            .import_bytes(
                vec![managed_bytes(
                    "download.png",
                    "https://example.test/reparse.png",
                    bytes,
                )],
                &MaterialImportOptions::default(),
            )
            .unwrap();

        assert_eq!(
            (rejected.value.imported_count, rejected.value.failed_count),
            (0, 1)
        );
        assert_eq!(
            rejected.value.failed_items[0].code,
            "managed-destination-conflict"
        );
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(std::fs::read(&external).unwrap(), bytes);
        assert!(std::fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn catalog_initialization_and_listing_do_not_repair_legacy_shared_paths() {
        let catalog = MaterialCatalog::new_for_test();
        let shared_path = catalog
            .app_data_dir()
            .join("asset-library")
            .join("legacy-shared.png");
        std::fs::create_dir_all(shared_path.parent().unwrap()).unwrap();
        std::fs::write(&shared_path, b"latest-legacy-bytes").unwrap();
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        for (id, hash) in [("legacy-a", "legacy-hash-a"), ("legacy-b", "legacy-hash-b")] {
            conn.execute(
                "INSERT INTO asset (id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash)
                 VALUES (?1,'legacy.png','https://example.test/legacy.png',?2,'managed','image','image/png',1,?2,'',NULL,NULL,NULL,'now','now',?3)",
                rusqlite::params![id, shared_path.to_string_lossy(), hash],
            )
            .unwrap();
        }
        drop(conn);
        let reopened = MaterialCatalog::new(catalog.db_path(), catalog.app_data_dir());

        let assets = reopened.list_assets(&MaterialFilter::default()).unwrap();

        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].library_path, assets[1].library_path);
        assert_eq!(std::fs::read(&shared_path).unwrap(), b"latest-legacy-bytes");
    }

    #[test]
    fn public_import_reports_partial_success_and_noop_without_a_second_change() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("valid.png");
        std::fs::write(&source, b"valid-image-bytes").unwrap();
        let missing = catalog.app_data_dir().join("missing.png");
        let result = catalog
            .import_paths(
                &[source.clone(), missing],
                &MaterialImportOptions::default(),
            )
            .unwrap();
        assert_eq!(
            (result.value.imported_count, result.value.failed_count),
            (1, 1)
        );
        assert!(result.change.is_some());
        let version = result.change.unwrap().version;

        let duplicate = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(duplicate.value.skipped_duplicate_count, 1);
        assert!(duplicate.change.is_none());
        assert_eq!(catalog.read_change().unwrap().version, version);
    }

    #[test]
    fn public_managed_import_cleans_file_when_database_insert_fails() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("reject.bin");
        std::fs::write(&source, b"reject").unwrap();
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_test_asset BEFORE INSERT ON asset
             WHEN NEW.name='reject.bin' BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
        )
        .unwrap();
        let result = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(
            (result.value.imported_count, result.value.failed_count),
            (0, 1)
        );
        assert!(result.change.is_none());
        let library = catalog.app_data_dir().join("asset-library");
        assert!(std::fs::read_dir(library).unwrap().next().is_none());
    }

    #[test]
    fn public_bytes_import_rejects_non_managed_storage_without_side_effects() {
        for storage_mode in ["linked", "source"] {
            let catalog = MaterialCatalog::new_for_test();
            let version_before = catalog.read_change().unwrap().version;
            let error = catalog
                .import_bytes(
                    vec![MaterialBytesInput {
                        name: "adapter.bin".into(),
                        original_path: "https://example.test/adapter.bin".into(),
                        mime_type: "application/octet-stream".into(),
                        description: None,
                        bytes: b"must-be-managed".to_vec(),
                    }],
                    &MaterialImportOptions {
                        storage_mode: storage_mode.into(),
                        ..Default::default()
                    },
                )
                .unwrap_err();
            assert_eq!(error.code, "bytes-import-requires-managed");
            assert_eq!(catalog.read_change().unwrap().version, version_before);
            assert!(catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .is_empty());
            assert!(library_entries(&catalog).is_empty());
        }
    }

    #[test]
    fn public_concurrent_linked_and_source_same_path_are_atomic_noops() {
        for storage_mode in ["linked", "source"] {
            let fixture = MaterialCatalog::new_for_test();
            let source = fixture
                .app_data_dir()
                .join(format!("{storage_mode}-shared.bin"));
            std::fs::write(&source, b"same-path").unwrap();
            let db_path = fixture.db_path().to_path_buf();
            let app_data_dir = fixture.app_data_dir().to_path_buf();
            let barrier = Arc::new(Barrier::new(2));
            let first = MaterialCatalog::new(&db_path, &app_data_dir)
                .with_test_import_barrier(Arc::clone(&barrier));
            let second =
                MaterialCatalog::new(&db_path, &app_data_dir).with_test_import_barrier(barrier);
            let first_path = source.clone();
            let second_path = source.clone();
            let first_mode = storage_mode.to_string();
            let second_mode = storage_mode.to_string();
            let first_thread = std::thread::spawn(move || {
                first
                    .import_paths(
                        &[first_path],
                        &MaterialImportOptions {
                            storage_mode: first_mode,
                            ..Default::default()
                        },
                    )
                    .unwrap()
            });
            let second_thread = std::thread::spawn(move || {
                second
                    .import_paths(
                        &[second_path],
                        &MaterialImportOptions {
                            storage_mode: second_mode,
                            ..Default::default()
                        },
                    )
                    .unwrap()
            });
            let first = first_thread.join().unwrap();
            let second = second_thread.join().unwrap();
            assert_eq!(first.value.imported_count + second.value.imported_count, 1);
            assert_eq!(
                first.value.skipped_duplicate_count + second.value.skipped_duplicate_count,
                1
            );
            assert_eq!(
                fixture
                    .list_assets(&MaterialFilter::default())
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                u32::from(first.change.is_some()) + u32::from(second.change.is_some()),
                1
            );
            assert_eq!(fixture.read_change().unwrap().version, 1);
            assert_eq!(std::fs::read(&source).unwrap(), b"same-path");
        }
    }

    #[test]
    fn public_concurrent_linked_and_source_different_paths_do_not_merge_same_content() {
        for storage_mode in ["linked", "source"] {
            let fixture = MaterialCatalog::new_for_test();
            let first_path = fixture
                .app_data_dir()
                .join(format!("{storage_mode}-first.bin"));
            let second_path = fixture
                .app_data_dir()
                .join(format!("{storage_mode}-second.bin"));
            std::fs::write(&first_path, b"same-content-different-identity").unwrap();
            std::fs::write(&second_path, b"same-content-different-identity").unwrap();
            let db_path = fixture.db_path().to_path_buf();
            let app_data_dir = fixture.app_data_dir().to_path_buf();
            let barrier = Arc::new(Barrier::new(2));
            let first = MaterialCatalog::new(&db_path, &app_data_dir)
                .with_test_import_barrier(Arc::clone(&barrier));
            let second =
                MaterialCatalog::new(&db_path, &app_data_dir).with_test_import_barrier(barrier);
            let first_thread = std::thread::spawn(move || {
                first
                    .import_paths(
                        &[first_path],
                        &MaterialImportOptions {
                            storage_mode: storage_mode.into(),
                            ..Default::default()
                        },
                    )
                    .unwrap()
            });
            let second_thread = std::thread::spawn(move || {
                second
                    .import_paths(
                        &[second_path],
                        &MaterialImportOptions {
                            storage_mode: storage_mode.into(),
                            ..Default::default()
                        },
                    )
                    .unwrap()
            });
            let first = first_thread.join().unwrap();
            let second = second_thread.join().unwrap();
            assert_eq!(first.value.imported_count + second.value.imported_count, 2);
            assert_eq!(
                fixture
                    .list_assets(&MaterialFilter::default())
                    .unwrap()
                    .len(),
                2
            );
            assert!(first.change.is_some() && second.change.is_some());
            assert_eq!(fixture.read_change().unwrap().version, 2);
        }
    }

    #[test]
    fn public_concurrent_managed_failures_leave_no_database_or_files() {
        let fixture = MaterialCatalog::new_for_test();
        let first_path = fixture.app_data_dir().join("reject.bin");
        let second_path = fixture.app_data_dir().join("reject.bin.copy");
        std::fs::write(&first_path, b"concurrent-reject").unwrap();
        std::fs::write(&second_path, b"concurrent-reject").unwrap();
        let conn = rusqlite::Connection::open(fixture.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_concurrent_asset BEFORE INSERT ON asset
             BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
        )
        .unwrap();
        drop(conn);
        let db_path = fixture.db_path().to_path_buf();
        let app_data_dir = fixture.app_data_dir().to_path_buf();
        let barrier = Arc::new(Barrier::new(2));
        let first = MaterialCatalog::new(&db_path, &app_data_dir)
            .with_test_import_barrier(Arc::clone(&barrier));
        let second =
            MaterialCatalog::new(&db_path, &app_data_dir).with_test_import_barrier(barrier);
        let first_thread = std::thread::spawn(move || {
            first
                .import_paths(&[first_path], &MaterialImportOptions::default())
                .unwrap()
        });
        let second_thread = std::thread::spawn(move || {
            second
                .import_paths(&[second_path], &MaterialImportOptions::default())
                .unwrap()
        });
        let first = first_thread.join().unwrap();
        let second = second_thread.join().unwrap();
        assert_eq!(first.value.failed_count + second.value.failed_count, 2);
        assert!(first.change.is_none() && second.change.is_none());
        assert!(fixture
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
        assert!(library_entries(&fixture).is_empty());
        assert_eq!(fixture.read_change().unwrap().version, 0);
    }

    #[test]
    fn public_auto_tag_batch_aggregates_change_and_retries_as_noop() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("auto-tag.bin");
        std::fs::write(&source, b"auto-tag").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let assignment = crate::materials::MaterialAssetTagNames {
            asset_id: asset.id.clone(),
            tags: vec![
                crate::materials::MaterialNamedTag {
                    name: "设计".into(),
                    color: Some("#818cf8".into()),
                },
                crate::materials::MaterialNamedTag {
                    name: "截图".into(),
                    color: Some("#94a3b8".into()),
                },
            ],
        };
        let tagged = catalog
            .add_asset_tag_names(vec![assignment.clone()])
            .unwrap();
        assert_eq!(tagged.value, 2);
        assert!(tagged
            .change
            .as_ref()
            .is_some_and(|change| change.affected_ids == vec![asset.id.clone()]));
        assert_eq!(catalog.get_asset_tags(&asset.id).unwrap().len(), 2);
        let retry = catalog.add_asset_tag_names(vec![assignment]).unwrap();
        assert_eq!(retry.value, 0);
        assert!(retry.change.is_none());
    }

    #[test]
    fn public_thumbnail_reference_cleanup_publishes_once_and_retries_as_noop() {
        let catalog = MaterialCatalog::new_for_test();
        insert_asset(
            &catalog,
            "video-thumbnail",
            "video",
            "folder-a",
            "2026-07-12T12:00:00Z",
            0,
            "",
        );
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "UPDATE asset SET thumbnail_url='C:/app/thumbnails/video/video-thumbnail.jpg' WHERE id='video-thumbnail'",
            [],
        )
        .unwrap();

        let cleared = catalog.clear_video_thumbnail_references().unwrap();
        assert_eq!(cleared.value, 1);
        assert!(cleared
            .change
            .as_ref()
            .is_some_and(|change| change.affected_ids == vec!["video-thumbnail"]));
        let asset = catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .remove(0);
        assert!(asset.thumbnail_url.is_empty());

        let retry = catalog.clear_video_thumbnail_references().unwrap();
        assert_eq!(retry.value, 0);
        assert!(retry.change.is_none());
    }

    #[test]
    fn public_folder_import_preserves_hierarchy_and_aggregates_one_change() {
        let catalog = MaterialCatalog::new_for_test();
        let root = catalog.app_data_dir().join("album");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("one.jpg"), b"one").unwrap();
        std::fs::write(root.join("nested").join("two.jpg"), b"two").unwrap();
        let outcome = catalog
            .import_folder(&root, &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(outcome.value.imported_count, 2);
        assert!(outcome
            .change
            .as_ref()
            .is_some_and(|change| change.folders_changed));
        let folders = catalog.list_folders().unwrap();
        assert_eq!(folders[0].name, "album");
        assert_eq!(folders[0].children[0].name, "nested");
    }

    #[test]
    fn public_source_folder_rescan_refreshes_same_asset_then_becomes_noop() {
        let catalog = MaterialCatalog::new_for_test();
        let root = catalog.app_data_dir().join("source-watch-rescan");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("watched-source.bin");
        std::fs::write(&source, b"source-watch-before").unwrap();
        let options = MaterialImportOptions {
            storage_mode: "source".into(),
            preserve_folder_structure: false,
            ..Default::default()
        };
        let first = catalog.import_folder(&root, &options).unwrap();
        assert_eq!(first.value.imported_count, 1);
        let asset_id = first.value.assets[0].id.clone();
        let changed_bytes = b"source-watch-after-external-edit-and-longer";
        std::fs::write(&source, changed_bytes).unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let refreshed = catalog.import_folder(&root, &options).unwrap();

        assert_eq!(refreshed.value.imported_count, 0);
        assert_eq!(refreshed.value.skipped_duplicate_count, 1);
        assert!(refreshed
            .change
            .as_ref()
            .is_some_and(|change| change.version == version_before + 1));
        let assets = catalog.list_assets(&MaterialFilter::default()).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].id, asset_id);
        assert_eq!(assets[0].content_hash, Some(sha256_file(&source).unwrap()));
        assert_eq!(assets[0].size_bytes, Some(changed_bytes.len() as i64));

        let version_after_refresh = catalog.read_change().unwrap().version;
        let noop = catalog.import_folder(&root, &options).unwrap();
        assert_eq!(noop.value.skipped_duplicate_count, 1);
        assert!(noop.change.is_none());
        assert_eq!(
            catalog.read_change().unwrap().version,
            version_after_refresh
        );
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn public_material_tag_listing_ignores_retired_note_assignments() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("asset.txt");
        std::fs::write(&source, b"asset").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets[0]
            .clone();
        let tag = catalog.create_tag("shared", None).unwrap().value;
        catalog
            .set_asset_tags(&asset.id, vec![tag.id.clone()])
            .unwrap();

        catalog
            .open_write()
            .unwrap()
            .execute(
                "INSERT INTO item_tag(id,item_type,item_id,tag_id,created_at) VALUES (?1,'note','legacy-note',?2,'now')",
                rusqlite::params!["legacy-note-tag", tag.id],
            )
            .unwrap();

        let listed = catalog.list_tags().unwrap();
        let shared = listed
            .iter()
            .find(|candidate| candidate.id == tag.id)
            .unwrap();
        assert_eq!(shared.asset_count, 1);
        assert_eq!(shared.note_count, 0);
    }

    #[test]
    fn public_crud_tag_move_missing_and_delete_share_catalog_invariants() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("asset.txt");
        std::fs::write(&source, b"asset").unwrap();
        let imported = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap();
        let asset = imported.value.assets[0].clone();
        let folder = catalog
            .create_folder(MaterialFolderInput {
                parent_id: None,
                name: "Target".into(),
            })
            .unwrap()
            .value;
        assert!(
            catalog
                .move_asset(&asset.id, Some(&folder.id))
                .unwrap()
                .value
        );
        assert!(catalog
            .move_asset(&asset.id, Some(&folder.id))
            .unwrap()
            .change
            .is_none());
        let updated = catalog
            .update_asset(
                &asset.id,
                MaterialAssetPatch {
                    name: Some("Renamed".into()),
                    rating: PatchValue::Value(Some(5)),
                    ..Default::default()
                },
                "test-update",
            )
            .unwrap()
            .value
            .unwrap();
        assert_eq!(
            (updated.name.as_str(), updated.rating),
            ("Renamed", Some(5))
        );
        assert_eq!(updated.library_path, asset.library_path);
        assert!(catalog
            .update_asset(&asset.id, MaterialAssetPatch::default(), "test-noop")
            .unwrap()
            .change
            .is_none());
        let tag_created = catalog.create_tag("important", None).unwrap();
        assert!(tag_created.change.is_some());
        let tag = tag_created.value;
        assert!(catalog
            .update_tag(&tag.id, crate::materials::MaterialTagPatch::default())
            .unwrap()
            .change
            .is_none());
        let source_tag = catalog.create_tag("source", None).unwrap().value;
        assert_eq!(
            catalog
                .set_asset_tags(&asset.id, vec![source_tag.id.clone()])
                .unwrap()
                .value,
            vec![source_tag.id.clone()]
        );
        let merged = catalog.merge_tags(&tag.id, vec![source_tag.id]).unwrap();
        assert_eq!(merged.value.target_name, "important");
        assert_eq!(
            catalog.get_asset_tags(&asset.id).unwrap(),
            vec![tag.id.clone()]
        );
        let renamed_tag = catalog
            .update_tag(
                &tag.id,
                crate::materials::MaterialTagPatch {
                    name: Some("priority".into()),
                    color: PatchValue::Value(Some("#ff0000".into())),
                },
            )
            .unwrap()
            .value
            .unwrap();
        assert_eq!(
            (renamed_tag.name.as_str(), renamed_tag.color.as_deref()),
            ("priority", Some("#ff0000"))
        );
        assert!(catalog.delete_tag(&tag.id).unwrap().value);
        assert!(catalog.get_asset_tags(&asset.id).unwrap().is_empty());
        std::fs::remove_file(asset.library_path.as_ref().unwrap()).unwrap();
        assert_eq!(catalog.scan_missing().unwrap()[0].id, asset.id);
        assert!(
            catalog
                .remove_asset_record(&asset.id)
                .unwrap()
                .value
                .success
        );
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
        let child = catalog
            .create_folder(MaterialFolderInput {
                parent_id: Some(folder.id.clone()),
                name: "Child".into(),
            })
            .unwrap()
            .value;
        assert_eq!(
            catalog
                .rename_folder(&child.id, "Renamed child")
                .unwrap()
                .value
                .unwrap()
                .name,
            "Renamed child"
        );
        assert!(catalog.delete_folder(&folder.id).unwrap().value);
        assert!(catalog.list_folders().unwrap().is_empty());
    }

    #[test]
    fn public_missing_scan_finds_linked_asset_without_library_path() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("linked-missing-scan.bin");
        let renamed = catalog
            .app_data_dir()
            .join("linked-missing-scan-renamed.bin");
        std::fs::write(&source, b"linked-missing").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "linked".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        assert!(asset.library_path.is_none());
        std::fs::rename(&source, &renamed).unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let missing = catalog.scan_missing().unwrap();

        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].id, asset.id);
        assert_eq!(missing[0].library_path, asset.original_path);
        assert_eq!(catalog.read_change().unwrap().version, version_before);
    }

    #[test]
    fn public_missing_scan_tracks_all_storage_modes_and_clears_after_relocate() {
        for storage_mode in ["managed", "source", "linked"] {
            let catalog = MaterialCatalog::new_for_test();
            let source = catalog
                .app_data_dir()
                .join(format!("{storage_mode}-missing-original.bin"));
            std::fs::write(&source, format!("{storage_mode}-missing")).unwrap();
            let options = MaterialImportOptions {
                storage_mode: storage_mode.into(),
                ..Default::default()
            };
            let asset = catalog
                .import_paths(&[source.clone()], &options)
                .unwrap()
                .value
                .assets
                .remove(0);
            assert!(catalog.scan_missing().unwrap().is_empty(), "{storage_mode}");
            let recorded_path = if storage_mode == "linked" {
                asset.original_path.clone()
            } else {
                asset.library_path.clone().unwrap()
            };
            let recorded_path = std::path::PathBuf::from(recorded_path);
            let relocated_path = recorded_path
                .parent()
                .unwrap()
                .join(format!("{storage_mode}-missing-relocated.bin"));
            std::fs::rename(&recorded_path, &relocated_path).unwrap();
            let version_before_scan = catalog.read_change().unwrap().version;

            let missing = catalog.scan_missing().unwrap();

            assert_eq!(missing.len(), 1, "{storage_mode}");
            assert_eq!(missing[0].id, asset.id, "{storage_mode}");
            assert_eq!(
                canonical_path_key(std::path::Path::new(&missing[0].library_path)),
                canonical_path_key(&recorded_path),
                "{storage_mode}"
            );
            assert_eq!(
                catalog.read_change().unwrap().version,
                version_before_scan,
                "{storage_mode}"
            );

            let relocated = catalog
                .relocate_asset(
                    &asset.id,
                    &relocated_path,
                    &MaterialRelocateOptions::default(),
                )
                .unwrap();
            assert!(relocated.value.is_some(), "{storage_mode}");
            assert!(catalog.scan_missing().unwrap().is_empty(), "{storage_mode}");
            if storage_mode == "linked" {
                assert!(relocated.value.unwrap().library_path.is_none());
            }
        }
    }

    #[test]
    fn public_missing_scan_skips_non_local_placeholders_and_has_no_page_limit() {
        let catalog = MaterialCatalog::new_for_test();
        let mut conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        let tx = conn.transaction().unwrap();
        let timestamp = now();
        for index in 0..300 {
            let id = format!("missing-linked-{index}");
            let path = catalog
                .app_data_dir()
                .join(format!("missing-linked-{index}.bin"))
                .to_string_lossy()
                .to_string();
            tx.execute(
                "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash) VALUES(?1,?1,?2,NULL,'linked','other','',0,'','',NULL,NULL,NULL,?3,?3,NULL)",
                rusqlite::params![id, path, timestamp],
            )
            .unwrap();
        }
        for (id, original_path, library_path, storage_mode) in [
            ("placeholder-browser", "browser:asset-1", None, "linked"),
            ("placeholder-dropped", "dropped:asset-2", None, "source"),
            ("placeholder-empty", "", Some(""), "managed"),
        ] {
            tx.execute(
                "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash) VALUES(?1,?1,?2,?3,?4,'other','',0,'','',NULL,NULL,NULL,?5,?5,NULL)",
                rusqlite::params![id, original_path, library_path, storage_mode, timestamp],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;

        let missing = catalog.scan_missing().unwrap();

        assert_eq!(missing.len(), 300);
        assert!(missing
            .iter()
            .all(|asset| asset.id.starts_with("missing-linked-")));
        assert_eq!(catalog.read_change().unwrap().version, version_before);
    }

    #[test]
    fn public_missing_scan_surfaces_inconsistent_source_paths_without_guessing() {
        let catalog = MaterialCatalog::new_for_test();
        let original = catalog
            .app_data_dir()
            .join("source-consistency-original.bin");
        let alternate = catalog
            .app_data_dir()
            .join("source-consistency-alternate.bin");
        let missing_library = catalog
            .app_data_dir()
            .join("source-consistency-missing.bin");
        std::fs::write(&original, b"source-original").unwrap();
        std::fs::write(&alternate, b"source-alternate").unwrap();
        let asset = catalog
            .import_paths(
                &[original],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "UPDATE asset SET library_path=?1 WHERE id=?2",
            rusqlite::params![missing_library.to_string_lossy(), asset.id],
        )
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;

        let missing = catalog.scan_missing().unwrap();

        assert_eq!(missing.len(), 1);
        assert_eq!(
            canonical_path_key(std::path::Path::new(&missing[0].library_path)),
            canonical_path_key(&missing_library)
        );
        assert_eq!(catalog.read_change().unwrap().version, version_before);

        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "UPDATE asset SET library_path=?1 WHERE id=?2",
            rusqlite::params![alternate.to_string_lossy(), asset.id],
        )
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;
        let inconsistent = catalog.scan_missing().unwrap();
        assert_eq!(inconsistent.len(), 1);
        assert_eq!(
            canonical_path_key(std::path::Path::new(&inconsistent[0].library_path)),
            canonical_path_key(&alternate)
        );
        assert_eq!(catalog.read_change().unwrap().version, version_before);
    }

    #[test]
    fn public_folder_commands_are_idempotent_and_preserve_order() {
        let catalog = MaterialCatalog::new_for_test();
        let first = catalog
            .create_folder(MaterialFolderInput {
                parent_id: None,
                name: "First".into(),
            })
            .unwrap();
        let version_after_first = first.change.as_ref().unwrap().version;
        let duplicate = catalog
            .create_folder(MaterialFolderInput {
                parent_id: None,
                name: "first".into(),
            })
            .unwrap();
        assert_eq!(duplicate.value.id, first.value.id);
        assert!(duplicate.change.is_none());
        assert_eq!(catalog.read_change().unwrap().version, version_after_first);

        catalog
            .create_folder(MaterialFolderInput {
                parent_id: None,
                name: "Second".into(),
            })
            .unwrap();
        let third = catalog
            .create_folder(MaterialFolderInput {
                parent_id: None,
                name: "Third".into(),
            })
            .unwrap()
            .value;
        let moved = catalog
            .move_folder(MaterialFolderMove {
                id: third.id.clone(),
                target_id: Some(first.value.id.clone()),
                position: "before".into(),
            })
            .unwrap();
        assert!(moved.value);
        let roots = catalog.list_folders().unwrap();
        assert_eq!(
            roots
                .iter()
                .map(|folder| folder.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Third", "First", "Second"]
        );
    }

    #[test]
    fn public_delete_error_preserves_record_and_target() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("delete-source.bin");
        std::fs::write(&source, b"delete").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let directory = catalog.app_data_dir().join("not-a-file");
        std::fs::create_dir_all(&directory).unwrap();
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "UPDATE asset SET library_path=?1 WHERE id=?2",
            rusqlite::params![directory.to_string_lossy(), asset.id],
        )
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;
        let error = catalog.delete_asset(&asset.id, true).unwrap_err();
        assert_eq!(error.code, "managed-path-untrusted");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
        assert!(directory.is_dir());
    }

    #[test]
    fn public_delete_rejects_managed_record_outside_trusted_library_root() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("trusted-import.bin");
        std::fs::write(&source, b"managed").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let prefix_disguise = catalog.app_data_dir().join("asset-library-shadow");
        std::fs::create_dir_all(&prefix_disguise).unwrap();
        let external = prefix_disguise.join("external-user-file.bin");
        std::fs::write(&external, b"do-not-delete").unwrap();
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "UPDATE asset SET library_path=?1 WHERE id=?2",
            rusqlite::params![external.to_string_lossy(), asset.id],
        )
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();
        assert_eq!(error.code, "managed-path-untrusted");
        assert_eq!(std::fs::read(&external).unwrap(), b"do-not-delete");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
        assert!(pending_delete_entries(&catalog).is_empty());
    }

    #[test]
    fn public_update_rejects_any_physical_identity_patch_before_metadata_changes() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("patch-source.bin");
        std::fs::write(&source, b"managed").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let external = catalog.app_data_dir().join("patch-external.bin");
        std::fs::write(&external, b"external").unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog
            .update_asset(
                &asset.id,
                MaterialAssetPatch {
                    library_path: PatchValue::Value(Some(external.to_string_lossy().to_string())),
                    original_path: Some(external.to_string_lossy().to_string()),
                    name: Some("must-not-apply".into()),
                    ..Default::default()
                },
                "untrusted-path-patch",
            )
            .unwrap_err();
        assert_eq!(error.code, "unsafe-material-path-patch");
        let storage_error = catalog
            .update_asset(
                &asset.id,
                MaterialAssetPatch {
                    storage_mode: Some("source".into()),
                    name: Some("must-not-apply-either".into()),
                    ..Default::default()
                },
                "untrusted-storage-patch",
            )
            .unwrap_err();
        assert_eq!(storage_error.code, "unsafe-material-path-patch");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(std::fs::read(&external).unwrap(), b"external");
        let current = catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == asset.id)
            .unwrap();
        assert_eq!(current.name, asset.name);
        assert_eq!(current.storage_mode, "managed");
        assert_eq!(current.library_path, asset.library_path);
    }

    #[test]
    fn public_relocate_rejects_path_owned_by_another_managed_asset() {
        let catalog = MaterialCatalog::new_for_test();
        let source_a = catalog.app_data_dir().join("ownership-a.bin");
        let source_b = catalog.app_data_dir().join("ownership-b.bin");
        std::fs::write(&source_a, b"asset-a").unwrap();
        std::fs::write(&source_b, b"asset-b").unwrap();
        let asset_a = catalog
            .import_paths(&[source_a], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let asset_b = catalog
            .import_paths(&[source_b], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let path_a = asset_a.library_path.clone().unwrap();
        let path_b = asset_b.library_path.clone().unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog
            .relocate_asset(
                &asset_a.id,
                std::path::Path::new(&path_b),
                &MaterialRelocateOptions::default(),
            )
            .unwrap_err();

        assert_eq!(error.code, "physical-path-owned");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(std::fs::read(&path_b).unwrap(), b"asset-b");
        assert!(pending_delete_entries(&catalog).is_empty());
        let assets = catalog.list_assets(&MaterialFilter::default()).unwrap();
        assert_eq!(
            assets
                .iter()
                .find(|asset| asset.id == asset_a.id)
                .and_then(|asset| asset.library_path.as_deref()),
            Some(path_a.as_str())
        );
        assert!(assets.iter().any(|asset| asset.id == asset_b.id));
    }

    #[test]
    fn public_relocate_preserves_managed_source_and_linked_mode_semantics() {
        for storage_mode in ["managed", "source", "linked"] {
            let catalog = MaterialCatalog::new_for_test();
            let source = catalog
                .app_data_dir()
                .join(format!("relink-{storage_mode}-source.bin"));
            std::fs::write(&source, format!("relink-{storage_mode}")).unwrap();
            let asset = catalog
                .import_paths(
                    &[source.clone()],
                    &MaterialImportOptions {
                        storage_mode: storage_mode.to_string(),
                        ..Default::default()
                    },
                )
                .unwrap()
                .value
                .assets
                .remove(0);
            let old_physical = if storage_mode == "managed" {
                std::path::PathBuf::from(asset.library_path.clone().unwrap())
            } else {
                source.clone()
            };
            let target = if storage_mode == "managed" {
                catalog
                    .app_data_dir()
                    .join("asset-library")
                    .join("managed-relinked.bin")
            } else {
                catalog
                    .app_data_dir()
                    .join(format!("{storage_mode}-relinked.bin"))
            };
            std::fs::copy(&old_physical, &target).unwrap();
            std::fs::remove_file(&old_physical).unwrap();
            let version_before = catalog.read_change().unwrap().version;

            let relocated = catalog
                .relocate_asset(&asset.id, &target, &MaterialRelocateOptions::default())
                .unwrap();

            assert!(relocated.change.as_ref().is_some_and(|change| {
                change.version == version_before + 1
                    && change.affected_ids == vec![asset.id.clone()]
            }));
            let relocated = relocated.value.unwrap();
            match storage_mode {
                "managed" => {
                    assert_eq!(relocated.original_path, asset.original_path);
                    assert_eq!(
                        canonical_path_key(std::path::Path::new(
                            relocated.library_path.as_deref().unwrap()
                        )),
                        canonical_path_key(&target.canonicalize().unwrap())
                    );
                    assert!(catalog.delete_asset(&asset.id, true).unwrap().value.success);
                    assert!(!target.exists());
                }
                "source" => {
                    let expected = canonical_path_key(&target.canonicalize().unwrap());
                    assert_eq!(
                        canonical_path_key(std::path::Path::new(&relocated.original_path)),
                        expected
                    );
                    assert_eq!(
                        canonical_path_key(std::path::Path::new(
                            relocated.library_path.as_deref().unwrap()
                        )),
                        expected
                    );
                    assert!(catalog.delete_asset(&asset.id, true).unwrap().value.success);
                    assert!(!target.exists());
                }
                "linked" => {
                    assert_eq!(
                        canonical_path_key(std::path::Path::new(&relocated.original_path)),
                        canonical_path_key(&target.canonicalize().unwrap())
                    );
                    assert!(relocated.library_path.is_none());
                    assert_eq!(
                        catalog.delete_asset(&asset.id, true).unwrap_err().code,
                        "delete-file-unsafe-storage"
                    );
                    assert!(target.is_file());
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn public_relocate_rejects_unowned_content_mismatch_without_side_effects() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("relink-hash-source.bin");
        std::fs::write(&source, b"expected").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let target = catalog
            .app_data_dir()
            .join("asset-library")
            .join("wrong-content.bin");
        std::fs::write(&target, b"wrong").unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog
            .relocate_asset(
                &asset.id,
                &target,
                &MaterialRelocateOptions {
                    allow_source_content_change: true,
                    expected_source_content_hash: Some(sha256_file(&target).unwrap()),
                },
            )
            .unwrap_err();

        assert_eq!(error.code, "physical-content-mismatch");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(std::fs::read(&target).unwrap(), b"wrong");
        let current = catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == asset.id)
            .unwrap();
        assert_eq!(current.library_path, asset.library_path);
    }

    #[test]
    fn public_managed_relocate_rejects_matching_file_outside_trusted_root() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("managed-root-source.bin");
        std::fs::write(&source, b"managed-root").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let external_dir = catalog.app_data_dir().join("unregistered-external");
        std::fs::create_dir_all(&external_dir).unwrap();
        let external = external_dir.join("matching.bin");
        std::fs::write(&external, b"managed-root").unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog
            .relocate_asset(&asset.id, &external, &MaterialRelocateOptions::default())
            .unwrap_err();

        assert_eq!(error.code, "managed-path-untrusted");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(std::fs::read(&external).unwrap(), b"managed-root");
    }

    #[test]
    fn public_source_relocate_requires_confirmation_before_accepting_different_content() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source-relocate-missing.bin");
        let target = catalog.app_data_dir().join("source-relocate-selected.txt");
        std::fs::write(&source, b"source-relocate-before").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        std::fs::remove_file(&source).unwrap();
        let target_bytes = b"source-relocate-explicit-target-with-different-content";
        std::fs::write(&target, target_bytes).unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog
            .relocate_asset(&asset.id, &target, &MaterialRelocateOptions::default())
            .unwrap_err();

        assert_eq!(error.code, "source-relocate-content-mismatch");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        let current = catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == asset.id)
            .unwrap();
        assert_eq!(current.original_path, asset.original_path);
        assert_eq!(current.library_path, asset.library_path);
        assert_eq!(current.content_hash, asset.content_hash);
        assert_eq!(std::fs::read(&target).unwrap(), target_bytes);

        let confirmed_hash = error
            .details
            .as_ref()
            .and_then(|details| details.get("actualContentHash"))
            .and_then(|hash| hash.as_str())
            .unwrap()
            .to_string();
        let relocated = catalog
            .relocate_asset(
                &asset.id,
                &target,
                &MaterialRelocateOptions {
                    allow_source_content_change: true,
                    expected_source_content_hash: Some(confirmed_hash.clone()),
                },
            )
            .unwrap();

        assert!(relocated.change.as_ref().is_some_and(|change| {
            change.version == version_before + 1 && change.affected_ids == vec![asset.id.clone()]
        }));
        let relocated = relocated.value.unwrap();
        let canonical_target = canonical_regular_leaf(&target).unwrap();
        let target_text = canonical_target.to_string_lossy().to_string();
        assert_eq!(relocated.original_path, target_text);
        assert_eq!(
            relocated.library_path.as_deref(),
            Some(target_text.as_str())
        );
        assert_eq!(
            relocated.content_hash.as_deref(),
            Some(confirmed_hash.as_str())
        );
        assert_eq!(relocated.size_bytes, Some(target_bytes.len() as i64));
        assert_eq!(relocated.kind, "document");
        assert_eq!(catalog.read_change().unwrap().version, version_before + 1);
    }

    #[test]
    fn public_source_relocate_confirmation_rejects_target_changed_after_warning() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog
            .app_data_dir()
            .join("source-relocate-change-source.bin");
        let target = catalog
            .app_data_dir()
            .join("source-relocate-change-target.bin");
        std::fs::write(&source, b"source-before").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        std::fs::remove_file(&source).unwrap();
        std::fs::write(&target, b"first-selected-content").unwrap();
        let version_before = catalog.read_change().unwrap().version;
        let mismatch = catalog
            .relocate_asset(&asset.id, &target, &MaterialRelocateOptions::default())
            .unwrap_err();
        let confirmed_hash = mismatch
            .details
            .as_ref()
            .and_then(|details| details.get("actualContentHash"))
            .and_then(|hash| hash.as_str())
            .unwrap()
            .to_string();

        std::fs::write(&target, b"changed-after-warning").unwrap();
        let error = catalog
            .relocate_asset(
                &asset.id,
                &target,
                &MaterialRelocateOptions {
                    allow_source_content_change: true,
                    expected_source_content_hash: Some(confirmed_hash),
                },
            )
            .unwrap_err();

        assert_eq!(error.code, "source-relocate-target-changed");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        let current = catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == asset.id)
            .unwrap();
        assert_eq!(current.original_path, asset.original_path);
        assert_eq!(current.library_path, asset.library_path);
        assert_eq!(current.content_hash, asset.content_hash);
        assert_eq!(std::fs::read(&target).unwrap(), b"changed-after-warning");
    }

    #[test]
    fn public_source_relocate_confirmation_rechecks_path_ownership() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source-confirm-owner-a.bin");
        let target = catalog.app_data_dir().join("source-confirm-owner-b.bin");
        std::fs::write(&source, b"owner-a").unwrap();
        let options = MaterialImportOptions {
            storage_mode: "source".into(),
            ..Default::default()
        };
        let asset_a = catalog
            .import_paths(&[source.clone()], &options)
            .unwrap()
            .value
            .assets
            .remove(0);
        std::fs::remove_file(&source).unwrap();
        std::fs::write(&target, b"owner-b").unwrap();
        let mismatch = catalog
            .relocate_asset(&asset_a.id, &target, &MaterialRelocateOptions::default())
            .unwrap_err();
        let confirmed_hash = mismatch
            .details
            .as_ref()
            .and_then(|details| details.get("actualContentHash"))
            .and_then(|hash| hash.as_str())
            .unwrap()
            .to_string();
        let asset_b = catalog
            .import_paths(&[target.clone()], &options)
            .unwrap()
            .value
            .assets
            .remove(0);
        let version_before_override = catalog.read_change().unwrap().version;

        let error = catalog
            .relocate_asset(
                &asset_a.id,
                &target,
                &MaterialRelocateOptions {
                    allow_source_content_change: true,
                    expected_source_content_hash: Some(confirmed_hash),
                },
            )
            .unwrap_err();

        assert_eq!(error.code, "physical-path-owned");
        assert_eq!(
            catalog.read_change().unwrap().version,
            version_before_override
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"owner-b");
        let assets = catalog.list_assets(&MaterialFilter::default()).unwrap();
        let current_a = assets
            .iter()
            .find(|candidate| candidate.id == asset_a.id)
            .unwrap();
        let current_b = assets
            .iter()
            .find(|candidate| candidate.id == asset_b.id)
            .unwrap();
        assert_eq!(current_a.original_path, asset_a.original_path);
        assert_eq!(current_a.library_path, asset_a.library_path);
        assert_eq!(current_b.original_path, asset_b.original_path);
    }

    #[test]
    fn public_source_relocate_rejects_target_owned_by_another_asset() {
        for target_bytes in [b"same".as_slice(), b"different".as_slice()] {
            let catalog = MaterialCatalog::new_for_test();
            let source_a = catalog.app_data_dir().join("source-relocate-owner-a.bin");
            let source_b = catalog.app_data_dir().join("source-relocate-owner-b.bin");
            std::fs::write(&source_a, b"same").unwrap();
            std::fs::write(&source_b, target_bytes).unwrap();
            let options = MaterialImportOptions {
                storage_mode: "source".into(),
                ..Default::default()
            };
            let asset_a = catalog
                .import_paths(&[source_a], &options)
                .unwrap()
                .value
                .assets
                .remove(0);
            let asset_b = catalog
                .import_paths(&[source_b.clone()], &options)
                .unwrap()
                .value
                .assets
                .remove(0);
            let version_before = catalog.read_change().unwrap().version;

            let error = catalog
                .relocate_asset(&asset_a.id, &source_b, &MaterialRelocateOptions::default())
                .unwrap_err();

            assert_eq!(error.code, "physical-path-owned");
            assert_eq!(std::fs::read(&source_b).unwrap(), target_bytes);
            assert_eq!(catalog.read_change().unwrap().version, version_before);
            let assets = catalog.list_assets(&MaterialFilter::default()).unwrap();
            assert!(assets.iter().any(|candidate| candidate.id == asset_a.id));
            assert!(assets.iter().any(|candidate| candidate.id == asset_b.id));
        }
    }

    #[test]
    fn public_managed_and_source_file_rename_preserves_owned_identity() {
        for storage_mode in ["managed", "source"] {
            let catalog = MaterialCatalog::new_for_test();
            let source = catalog
                .app_data_dir()
                .join(format!("rename-{storage_mode}.bin"));
            std::fs::write(&source, format!("rename-{storage_mode}")).unwrap();
            let asset = catalog
                .import_paths(
                    &[source.clone()],
                    &MaterialImportOptions {
                        storage_mode: storage_mode.to_string(),
                        ..Default::default()
                    },
                )
                .unwrap()
                .value
                .assets
                .remove(0);
            let old_path = if storage_mode == "managed" {
                std::path::PathBuf::from(asset.library_path.clone().unwrap())
            } else {
                source.clone()
            };
            let version_before = catalog.read_change().unwrap().version;

            let renamed = catalog
                .rename_asset_file(&asset.id, &format!("renamed-{storage_mode}.bin"))
                .unwrap();
            assert!(renamed.change.as_ref().is_some_and(|change| {
                change.version == version_before + 1
                    && change.affected_ids == vec![asset.id.clone()]
            }));
            let renamed = renamed.value.unwrap();
            let new_path = std::path::PathBuf::from(renamed.library_path.clone().unwrap());
            assert!(!old_path.exists());
            assert!(new_path.is_file());
            assert_eq!(sha256_file(&new_path).unwrap(), asset.content_hash.unwrap());
            if storage_mode == "source" {
                assert_eq!(renamed.original_path, renamed.library_path.unwrap());
            }
            assert_eq!(catalog.read_change().unwrap().version, version_before + 1);
        }
    }

    #[test]
    fn public_source_external_edit_can_be_renamed_and_refreshes_identity() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog
            .app_data_dir()
            .join("source-external-edit-rename.bin");
        std::fs::write(&source, b"source-before-rename-edit").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let changed_bytes = b"source-after-external-edit-before-rename";
        std::fs::write(&source, changed_bytes).unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let renamed = catalog
            .rename_asset_file(&asset.id, "source-external-edit-renamed.bin")
            .unwrap();

        assert!(renamed.change.as_ref().is_some_and(|change| {
            change.version == version_before + 1 && change.affected_ids == vec![asset.id.clone()]
        }));
        let renamed = renamed.value.unwrap();
        let renamed_path = std::path::PathBuf::from(renamed.library_path.clone().unwrap());
        assert!(!source.exists());
        assert_eq!(std::fs::read(&renamed_path).unwrap(), changed_bytes);
        assert_eq!(renamed.original_path, renamed.library_path.unwrap());
        assert_eq!(
            renamed.content_hash,
            Some(sha256_file(&renamed_path).unwrap())
        );
        assert_eq!(renamed.size_bytes, Some(changed_bytes.len() as i64));
        assert_eq!(catalog.read_change().unwrap().version, version_before + 1);
    }

    #[test]
    fn public_source_file_rename_database_failure_restores_file_and_record() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("rename-rollback-source.bin");
        std::fs::write(&source, b"rename-rollback").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let changed_bytes = b"rename-rollback-after-external-edit";
        std::fs::write(&source, changed_bytes).unwrap();
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_file_rename BEFORE UPDATE OF library_path ON asset BEGIN SELECT RAISE(ABORT, 'rename rejected'); END;",
        )
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;
        let renamed_path = source.parent().unwrap().join("renamed-rollback.bin");

        let error = catalog
            .rename_asset_file(&asset.id, "renamed-rollback.bin")
            .unwrap_err();

        assert_eq!(error.code, "database-error");
        assert_eq!(std::fs::read(&source).unwrap(), changed_bytes);
        assert!(!renamed_path.exists());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        let current = catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .remove(0);
        assert_eq!(current.original_path, asset.original_path);
        assert_eq!(current.library_path, asset.library_path);
        assert_eq!(current.content_hash, asset.content_hash);
    }

    #[test]
    fn public_delete_rejects_legacy_cross_asset_path_even_when_hash_matches() {
        let catalog = MaterialCatalog::new_for_test();
        let source_a = catalog.app_data_dir().join("legacy-owner-a.bin");
        let source_b = catalog.app_data_dir().join("legacy-owner-b.bin");
        std::fs::write(&source_a, b"owner-a").unwrap();
        std::fs::write(&source_b, b"owner-b").unwrap();
        let asset_a = catalog
            .import_paths(&[source_a], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let asset_b = catalog
            .import_paths(&[source_b], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let path_b = asset_b.library_path.clone().unwrap();
        let hash_b = asset_b.content_hash.clone().unwrap();
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "UPDATE asset SET library_path=?1, content_hash=?2 WHERE id=?3",
            rusqlite::params![path_b, hash_b, asset_a.id],
        )
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog.delete_asset(&asset_a.id, true).unwrap_err();

        assert_eq!(error.code, "physical-path-owned");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(std::fs::read(&path_b).unwrap(), b"owner-b");
        assert!(pending_delete_entries(&catalog).is_empty());
        let assets = catalog.list_assets(&MaterialFilter::default()).unwrap();
        assert!(assets.iter().any(|asset| asset.id == asset_a.id));
        assert!(assets.iter().any(|asset| asset.id == asset_b.id));
    }

    #[test]
    fn public_delete_rejects_symlink_or_reparse_target_without_touching_external_file() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("reparse-source.bin");
        std::fs::write(&source, b"managed").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let external = catalog.app_data_dir().join("reparse-external.bin");
        std::fs::write(&external, b"outside").unwrap();
        let link = catalog
            .app_data_dir()
            .join("asset-library")
            .join("linked.bin");
        #[cfg(target_os = "windows")]
        let link_result = std::os::windows::fs::symlink_file(&external, &link);
        #[cfg(not(target_os = "windows"))]
        let link_result = std::os::unix::fs::symlink(&external, &link);
        if let Err(error) = link_result {
            eprintln!(
                "SKIP real symlink/reparse fixture: {}; canonical outside-root fixture remains active",
                error
            );
            let prefix_disguise = catalog.app_data_dir().join("asset-library-shadow");
            std::fs::create_dir_all(&prefix_disguise).unwrap();
            let disguised = prefix_disguise.join("outside.bin");
            std::fs::write(&disguised, b"outside").unwrap();
            let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
            conn.execute(
                "UPDATE asset SET library_path=?1 WHERE id=?2",
                rusqlite::params![disguised.to_string_lossy(), asset.id],
            )
            .unwrap();
            drop(conn);
            let delete_error = catalog.delete_asset(&asset.id, true).unwrap_err();
            assert_eq!(delete_error.code, "managed-path-untrusted");
            assert_eq!(std::fs::read(&disguised).unwrap(), b"outside");
            return;
        }
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "UPDATE asset SET library_path=?1 WHERE id=?2",
            rusqlite::params![link.to_string_lossy(), asset.id],
        )
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();
        assert_eq!(error.code, "managed-path-reparse");
        assert_eq!(std::fs::read(&external).unwrap(), b"outside");
        assert!(link.exists());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn public_retry_rejects_reparse_pending_directory() {
        let catalog = MaterialCatalog::new_for_test();
        let external_dir = catalog.app_data_dir().join("external-pending-dir");
        std::fs::create_dir_all(&external_dir).unwrap();
        let external_manifest = external_dir.join("delete-forged.json");
        std::fs::write(&external_manifest, b"not trusted").unwrap();
        let pending_link = catalog.app_data_dir().join("material-delete-pending");
        #[cfg(target_os = "windows")]
        let link_result = std::os::windows::fs::symlink_dir(&external_dir, &pending_link);
        #[cfg(not(target_os = "windows"))]
        let link_result = std::os::unix::fs::symlink(&external_dir, &pending_link);
        if let Err(error) = link_result {
            eprintln!("SKIP pending-dir reparse fixture: {error}");
            return;
        }

        let error = catalog.retry_pending_deletions().unwrap_err();
        assert_eq!(error.code, "delete-pending-untrusted");
        assert_eq!(std::fs::read(&external_manifest).unwrap(), b"not trusted");
        assert!(pending_link.exists());
    }

    #[test]
    fn public_retry_rejects_reparse_manifest_file_before_cleanup() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("manifest-link-source.bin");
        std::fs::write(&source, b"pending").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let db_path = catalog.db_path().to_path_buf();
        let app_data_dir = catalog.app_data_dir().to_path_buf();
        let faulted = catalog.with_test_delete_purge_failure();
        faulted.delete_asset(&asset.id, true).unwrap();
        let manifest = pending_delete_entries(&faulted).remove(0);
        let external_manifest = faulted.app_data_dir().join("external-manifest.json");
        std::fs::rename(&manifest, &external_manifest).unwrap();
        #[cfg(target_os = "windows")]
        let link_result = std::os::windows::fs::symlink_file(&external_manifest, &manifest);
        #[cfg(not(target_os = "windows"))]
        let link_result = std::os::unix::fs::symlink(&external_manifest, &manifest);
        if let Err(error) = link_result {
            eprintln!("SKIP manifest-file reparse fixture: {error}");
            return;
        }
        let quarantine = library_entries(&faulted)
            .into_iter()
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".luckyray-delete-pending-"))
            })
            .unwrap();
        let recovery = MaterialCatalog::new(db_path, app_data_dir);
        let version_before = recovery.read_change().unwrap().version;

        let retried = recovery.retry_pending_deletions().unwrap();
        assert_eq!((retried.cleaned, retried.pending), (0, 1));
        assert!(manifest.exists());
        assert!(external_manifest.is_file());
        assert_eq!(std::fs::read(&quarantine).unwrap(), b"pending");
        assert_eq!(recovery.read_change().unwrap().version, version_before);
    }

    #[test]
    fn public_delete_quarantine_failure_keeps_database_and_file_unchanged() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("quarantine-failure.bin");
        std::fs::write(&source, b"keep-me").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let managed_path = std::path::PathBuf::from(asset.library_path.as_ref().unwrap());
        let version_before = catalog.read_change().unwrap().version;
        let catalog = catalog.with_test_delete_quarantine_failure();

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();
        assert_eq!(error.code, "delete-quarantine-failed");
        assert!(managed_path.is_file());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn public_delete_database_failure_rolls_back_quarantined_file() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("database-failure.bin");
        std::fs::write(&source, b"restore-me").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let managed_path = std::path::PathBuf::from(asset.library_path.as_ref().unwrap());
        let version_before = catalog.read_change().unwrap().version;
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_asset_delete BEFORE DELETE ON asset
             BEGIN SELECT RAISE(ABORT, 'delete rejected'); END;",
        )
        .unwrap();
        drop(conn);

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();
        assert_eq!(error.code, "database-error");
        assert!(managed_path.is_file());
        assert_eq!(std::fs::read(&managed_path).unwrap(), b"restore-me");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
        assert!(pending_delete_entries(&catalog).is_empty());
    }

    #[test]
    fn public_source_external_edit_delete_database_failure_restores_actual_file() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source-delete-rollback.bin");
        std::fs::write(&source, b"source-delete-before-edit").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let changed_bytes = b"source-delete-after-external-edit";
        std::fs::write(&source, changed_bytes).unwrap();
        let version_before = catalog.read_change().unwrap().version;
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_source_asset_delete BEFORE DELETE ON asset
             BEGIN SELECT RAISE(ABORT, 'delete rejected'); END;",
        )
        .unwrap();
        drop(conn);

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();

        assert_eq!(error.code, "database-error");
        assert_eq!(std::fs::read(&source).unwrap(), changed_bytes);
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .iter()
            .any(|candidate| candidate.id == asset.id));
        assert!(pending_delete_entries(&catalog).is_empty());
    }

    #[test]
    fn public_delete_zero_row_guard_restores_quarantined_file() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("delete-stale.bin");
        std::fs::write(&source, b"restore-stale").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let managed_path = std::path::PathBuf::from(asset.library_path.as_ref().unwrap());
        let version_before = catalog.read_change().unwrap().version;
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER ignore_asset_delete BEFORE DELETE ON asset
             BEGIN SELECT RAISE(IGNORE); END;",
        )
        .unwrap();
        drop(conn);

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();
        assert_eq!(error.code, "delete-record-changed");
        assert_eq!(std::fs::read(&managed_path).unwrap(), b"restore-stale");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
        assert!(pending_delete_entries(&catalog).is_empty());
    }

    #[test]
    fn public_delete_success_commits_once_and_purges_quarantine() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("delete-success.bin");
        std::fs::write(&source, b"delete-me").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let managed_path = std::path::PathBuf::from(asset.library_path.as_ref().unwrap());
        let version_before = catalog.read_change().unwrap().version;

        let deleted = catalog.delete_asset(&asset.id, true).unwrap();
        assert!(deleted.value.success);
        assert!(!deleted.value.cleanup_pending);
        assert!(deleted.change.as_ref().is_some_and(|change| {
            change.version == version_before + 1 && change.affected_ids == vec![asset.id.clone()]
        }));
        assert!(!managed_path.exists());
        assert!(pending_delete_entries(&catalog).is_empty());
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn public_record_only_delete_preserves_managed_file() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("record-only.bin");
        std::fs::write(&source, b"keep-file").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let managed_path = std::path::PathBuf::from(asset.library_path.as_ref().unwrap());

        let deleted = catalog.delete_asset(&asset.id, false).unwrap();
        assert!(deleted.value.success);
        assert!(!deleted.value.cleanup_pending);
        assert!(deleted.change.is_some());
        assert_eq!(std::fs::read(&managed_path).unwrap(), b"keep-file");
        assert!(pending_delete_entries(&catalog).is_empty());
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn public_linked_physical_delete_fails_closed_and_keeps_reference() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("linked-user-file.bin");
        std::fs::write(&source, b"user-owned").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "linked".to_string(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();
        assert_eq!(error.code, "delete-file-unsafe-storage");
        assert_eq!(std::fs::read(&source).unwrap(), b"user-owned");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn public_source_physical_delete_removes_owned_file_and_publishes_once() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source-user-file.bin");
        std::fs::write(&source, b"source-owned").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".to_string(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let version_before = catalog.read_change().unwrap().version;

        let deleted = catalog.delete_asset(&asset.id, true).unwrap();

        assert!(deleted.value.success);
        assert!(!deleted.value.cleanup_pending);
        assert!(deleted.change.as_ref().is_some_and(|change| {
            change.version == version_before + 1 && change.affected_ids == vec![asset.id.clone()]
        }));
        assert!(!source.exists());
        assert!(pending_delete_entries(&catalog).is_empty());
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn public_managed_external_edit_still_blocks_physical_delete() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("managed-external-edit.bin");
        std::fs::write(&source, b"managed-before-edit").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let managed_path = std::path::PathBuf::from(asset.library_path.clone().unwrap());
        std::fs::write(&managed_path, b"managed-after-external-edit").unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();

        assert_eq!(error.code, "physical-content-mismatch");
        assert_eq!(
            std::fs::read(&managed_path).unwrap(),
            b"managed-after-external-edit"
        );
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert!(pending_delete_entries(&catalog).is_empty());
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .iter()
            .any(|candidate| candidate.id == asset.id));
    }

    #[test]
    fn public_source_external_edit_can_be_physically_deleted_once() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog
            .app_data_dir()
            .join("source-external-edit-delete.bin");
        std::fs::write(&source, b"source-before-external-edit").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".to_string(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        std::fs::write(&source, b"source-after-external-edit-and-longer").unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let deleted = catalog.delete_asset(&asset.id, true).unwrap();

        assert!(deleted.value.success);
        assert!(!deleted.value.cleanup_pending);
        assert!(deleted.change.as_ref().is_some_and(|change| {
            change.version == version_before + 1 && change.affected_ids == vec![asset.id.clone()]
        }));
        assert!(!source.exists());
        assert!(pending_delete_entries(&catalog).is_empty());
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn public_source_record_only_delete_preserves_real_file() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source-record-only.bin");
        std::fs::write(&source, b"keep-source").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".to_string(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        std::fs::write(&source, b"keep-source-after-external-edit").unwrap();

        let deleted = catalog.delete_asset(&asset.id, false).unwrap();

        assert!(deleted.value.success);
        assert!(deleted.change.is_some());
        assert_eq!(
            std::fs::read(&source).unwrap(),
            b"keep-source-after-external-edit"
        );
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn public_source_delete_rejects_path_owned_by_another_asset_regardless_of_hash() {
        for shared_bytes in [b"same".as_slice(), b"different".as_slice()] {
            let catalog = MaterialCatalog::new_for_test();
            let source_a = catalog.app_data_dir().join("source-owner-a.bin");
            let source_b = catalog.app_data_dir().join("source-owner-b.bin");
            std::fs::write(&source_a, b"same").unwrap();
            std::fs::write(&source_b, shared_bytes).unwrap();
            let options = MaterialImportOptions {
                storage_mode: "source".to_string(),
                ..Default::default()
            };
            let asset_a = catalog
                .import_paths(&[source_a], &options)
                .unwrap()
                .value
                .assets
                .remove(0);
            let asset_b = catalog
                .import_paths(&[source_b.clone()], &options)
                .unwrap()
                .value
                .assets
                .remove(0);
            let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
            conn.execute(
                "UPDATE asset SET original_path=?1,library_path=?1 WHERE id=?2",
                rusqlite::params![source_b.to_string_lossy(), asset_a.id],
            )
            .unwrap();
            drop(conn);
            let version_before = catalog.read_change().unwrap().version;

            let shared = catalog.delete_asset(&asset_a.id, true).unwrap_err();

            assert_eq!(shared.code, "physical-path-owned");
            assert_eq!(catalog.read_change().unwrap().version, version_before);
            assert_eq!(std::fs::read(&source_b).unwrap(), shared_bytes);
            assert!(pending_delete_entries(&catalog).is_empty());
            let assets = catalog.list_assets(&MaterialFilter::default()).unwrap();
            assert!(assets.iter().any(|candidate| candidate.id == asset_a.id));
            assert!(assets.iter().any(|candidate| candidate.id == asset_b.id));
        }
    }

    #[test]
    fn public_source_delete_rejects_symlink_or_reparse_without_touching_target() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source-reparse-import.bin");
        let external = catalog.app_data_dir().join("source-reparse-target.bin");
        let link = catalog.app_data_dir().join("source-reparse-link.bin");
        std::fs::write(&source, b"source-original").unwrap();
        std::fs::write(&external, b"source-target").unwrap();
        let asset = catalog
            .import_paths(
                &[source],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        #[cfg(target_os = "windows")]
        let link_result = std::os::windows::fs::symlink_file(&external, &link);
        #[cfg(not(target_os = "windows"))]
        let link_result = std::os::unix::fs::symlink(&external, &link);
        if let Err(error) = link_result {
            eprintln!("SKIP source symlink/reparse fixture: {error}");
            return;
        }
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute(
            "UPDATE asset SET original_path=?1,library_path=?1,content_hash=?2 WHERE id=?3",
            rusqlite::params![
                link.to_string_lossy(),
                sha256_file(&external).unwrap(),
                asset.id
            ],
        )
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;

        let error = catalog.delete_asset(&asset.id, true).unwrap_err();

        assert_eq!(error.code, "physical-path-reparse");
        assert_eq!(std::fs::read(&external).unwrap(), b"source-target");
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .iter()
            .any(|candidate| candidate.id == asset.id));
    }

    #[test]
    fn public_concurrent_relinks_cannot_share_one_physical_path() {
        let catalog = MaterialCatalog::new_for_test();
        let source_a = catalog.app_data_dir().join("concurrent-relink-a.bin");
        let source_b = catalog.app_data_dir().join("concurrent-relink-b.bin");
        let target = catalog.app_data_dir().join("concurrent-relink-target.bin");
        std::fs::write(&source_a, b"same-relink").unwrap();
        std::fs::write(&source_b, b"same-relink").unwrap();
        std::fs::write(&target, b"same-relink").unwrap();
        let asset_a = catalog
            .import_paths(
                &[source_a],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let asset_b = catalog
            .import_paths(
                &[source_b],
                &MaterialImportOptions {
                    storage_mode: "linked".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let barrier = Arc::new(Barrier::new(2));
        let db_path = catalog.db_path().to_path_buf();
        let app_data_dir = catalog.app_data_dir().to_path_buf();
        let target_a = target.clone();
        let target_b = target.clone();
        let barrier_a = Arc::clone(&barrier);
        let barrier_b = Arc::clone(&barrier);
        let id_a = asset_a.id.clone();
        let id_b = asset_b.id.clone();
        let db_a = db_path.clone();
        let app_a = app_data_dir.clone();
        let first = std::thread::spawn(move || {
            let catalog = MaterialCatalog::new(db_a, app_a);
            barrier_a.wait();
            catalog.relocate_asset(&id_a, &target_a, &MaterialRelocateOptions::default())
        });
        let second = std::thread::spawn(move || {
            let catalog = MaterialCatalog::new(db_path, app_data_dir);
            barrier_b.wait();
            catalog.relocate_asset(&id_b, &target_b, &MaterialRelocateOptions::default())
        });
        let outcomes = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter_map(|result| result.as_ref().err())
                .map(|error| error.code.as_str())
                .collect::<Vec<_>>(),
            vec!["physical-path-owned"]
        );
        let target_key = canonical_path_key(&target.canonicalize().unwrap());
        let owners = catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .into_iter()
            .filter(|asset| {
                [
                    Some(asset.original_path.as_str()),
                    asset.library_path.as_deref(),
                ]
                .into_iter()
                .flatten()
                .any(|path| {
                    canonical_regular_leaf(std::path::Path::new(path))
                        .is_ok_and(|path| canonical_path_key(&path) == target_key)
                })
            })
            .count();
        assert_eq!(owners, 1);
    }

    #[test]
    fn public_delete_purge_failure_returns_tracked_cleanup_pending_and_retries() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("purge-pending.bin");
        std::fs::write(&source, b"pending-cleanup").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let managed_path = std::path::PathBuf::from(asset.library_path.as_ref().unwrap());
        let db_path = catalog.db_path().to_path_buf();
        let app_data_dir = catalog.app_data_dir().to_path_buf();
        let catalog = catalog.with_test_delete_purge_failure();

        let deleted = catalog.delete_asset(&asset.id, true).unwrap();
        assert!(deleted.value.success);
        assert!(deleted.value.cleanup_pending);
        assert!(deleted.change.is_some());
        assert!(!managed_path.exists());
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
        assert_eq!(pending_delete_entries(&catalog).len(), 1);

        let recovery = MaterialCatalog::new(db_path, app_data_dir);
        let retried = recovery.retry_pending_deletions().unwrap();
        assert_eq!((retried.cleaned, retried.pending), (1, 0));
        assert!(pending_delete_entries(&recovery).is_empty());
    }

    #[test]
    fn library_r1_pending_delete_is_recovered_only_by_its_frozen_library() {
        let default = MaterialCatalog::new_for_test();
        let root = default.app_data_dir().join("other-library");
        std::fs::create_dir(&root).unwrap();
        let library = default.create_library("Other", &root, "managed").unwrap();
        let other = default.for_library(&library.id).unwrap();
        let source = default.app_data_dir().join("pending-other.bin");
        std::fs::write(&source, b"other-library-pending").unwrap();
        let asset = other.import_paths(&[source], &MaterialImportOptions::default()).unwrap().value.assets.remove(0);
        let faulted = other.with_test_delete_purge_failure();
        assert!(faulted.delete_asset(&asset.id, true).unwrap().value.cleanup_pending);
        let manifests = pending_delete_entries(&default);
        assert_eq!(manifests.len(), 1);
        let record: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifests[0]).unwrap()).unwrap();
        assert_eq!(record["libraryId"], library.id);
        default.select_library(&library.id).unwrap();
        assert_eq!(default.retry_pending_deletions().unwrap().cleaned, 0);
        assert!(manifests[0].is_file());
        let reopened = MaterialCatalog::new(default.db_path(), default.app_data_dir());
        assert_eq!(reopened.for_library(&library.id).unwrap().retry_pending_deletions().unwrap().cleaned, 1);
        assert!(!manifests[0].exists());
    }

    #[test]
    fn library_r1_linked_and_source_lifecycles_keep_cross_library_originals_safe() {
        let default = MaterialCatalog::new_for_test();
        let root = default.app_data_dir().join("source-library");
        std::fs::create_dir(&root).unwrap();
        let library = default.create_library("Sources", &root, "source").unwrap();
        let other = default.for_library(&library.id).unwrap();
        let a_path = default.app_data_dir().join("original-a.bin");
        let b_path = default.app_data_dir().join("original-b.bin");
        std::fs::write(&a_path, b"same-original-bytes").unwrap();
        std::fs::write(&b_path, b"same-original-bytes").unwrap();
        let source_options = MaterialImportOptions { storage_mode: "source".into(), ..Default::default() };
        let linked_options = MaterialImportOptions { storage_mode: "linked".into(), ..Default::default() };
        let a = default.import_paths(&[a_path.clone()], &source_options).unwrap().value.assets.remove(0);
        let b = other.import_paths(&[b_path.clone()], &source_options).unwrap().value.assets.remove(0);
        assert_ne!(a.id, b.id); assert_eq!(a.content_hash, b.content_hash);
        other.delete_asset(&b.id, true).unwrap();
        assert!(a_path.is_file()); assert!(!b_path.exists());
        let linked = other.import_paths(&[a_path.clone()], &linked_options).unwrap().value.assets.remove(0);
        assert_eq!(default.delete_asset(&a.id, true).unwrap_err().code, "physical-path-owned");
        assert_eq!(std::fs::read(&a_path).unwrap(), b"same-original-bytes");
        other.delete_asset(&linked.id, false).unwrap();
        default.delete_asset(&a.id, true).unwrap();
        assert!(!a_path.exists());
    }

    #[test]
    fn public_retry_keeps_pending_when_deleted_path_is_claimed_by_another_asset() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("pending-owner-source.bin");
        std::fs::write(&source, b"pending-owner").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let original_path = asset.library_path.clone().unwrap();
        let content_hash = asset.content_hash.clone().unwrap();
        let db_path = catalog.db_path().to_path_buf();
        let app_data_dir = catalog.app_data_dir().to_path_buf();
        let faulted = catalog.with_test_delete_purge_failure();
        let deleted = faulted.delete_asset(&asset.id, true).unwrap();
        assert!(deleted.value.cleanup_pending);
        let quarantine = library_entries(&faulted)
            .into_iter()
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".luckyray-delete-pending-"))
            })
            .unwrap();
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash) VALUES('asset-new-owner','new owner',?1,?1,'managed','other','',13,'','',NULL,NULL,NULL,?2,?2,?3)",
            rusqlite::params![original_path, now(), content_hash],
        )
        .unwrap();
        drop(conn);
        let recovery = MaterialCatalog::new(db_path, app_data_dir);
        let version_before = recovery.read_change().unwrap().version;

        let retried = recovery.retry_pending_deletions().unwrap();

        assert_eq!((retried.cleaned, retried.pending), (0, 1));
        assert!(quarantine.is_file());
        assert_eq!(std::fs::read(&quarantine).unwrap(), b"pending-owner");
        assert_eq!(recovery.read_change().unwrap().version, version_before);
        assert_eq!(pending_delete_entries(&recovery).len(), 1);
    }

    #[test]
    fn public_source_cleanup_pending_retries_with_database_identity_journal() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source-cleanup-pending.bin");
        std::fs::write(&source, b"source-pending").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let changed_bytes = b"source-pending-after-external-edit";
        std::fs::write(&source, changed_bytes).unwrap();
        let db_path = catalog.db_path().to_path_buf();
        let app_data_dir = catalog.app_data_dir().to_path_buf();
        let faulted = catalog.with_test_delete_purge_failure();

        let deleted = faulted.delete_asset(&asset.id, true).unwrap();

        assert!(deleted.value.cleanup_pending);
        assert!(!source.exists());
        let manifest = pending_delete_entries(&faulted).remove(0);
        let manifest_json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        let quarantine_hash = sha256_file(
            &source
                .parent()
                .unwrap()
                .join(manifest_json["quarantineName"].as_str().unwrap()),
        )
        .unwrap();
        assert_eq!(
            manifest_json["contentHash"].as_str(),
            Some(quarantine_hash.as_str())
        );
        let recovery = MaterialCatalog::new(db_path, app_data_dir);
        let retried = recovery.retry_pending_deletions().unwrap();
        assert_eq!((retried.cleaned, retried.pending), (1, 0));
        assert!(!manifest.exists());
    }

    #[test]
    fn public_source_cleanup_retry_rejects_quarantine_changed_after_commit() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("source-cleanup-tampered.bin");
        std::fs::write(&source, b"source-before-external-edit").unwrap();
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        std::fs::write(&source, b"source-after-external-edit").unwrap();
        let db_path = catalog.db_path().to_path_buf();
        let app_data_dir = catalog.app_data_dir().to_path_buf();
        let faulted = catalog.with_test_delete_purge_failure();
        let deleted = faulted.delete_asset(&asset.id, true).unwrap();
        assert!(deleted.value.cleanup_pending);
        let manifest = pending_delete_entries(&faulted).remove(0);
        let manifest_json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        let quarantine = source
            .parent()
            .unwrap()
            .join(manifest_json["quarantineName"].as_str().unwrap());
        std::fs::write(&quarantine, b"tampered-after-commit").unwrap();
        let recovery = MaterialCatalog::new(db_path, app_data_dir);
        let version_before = recovery.read_change().unwrap().version;

        let retried = recovery.retry_pending_deletions().unwrap();

        assert_eq!((retried.cleaned, retried.pending), (0, 1));
        assert_eq!(
            std::fs::read(&quarantine).unwrap(),
            b"tampered-after-commit"
        );
        assert!(manifest.is_file());
        assert_eq!(recovery.read_change().unwrap().version, version_before);
        assert!(recovery
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn public_old_pending_manifest_version_fails_closed() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("old-manifest.bin");
        std::fs::write(&source, b"old-manifest").unwrap();
        let asset = catalog
            .import_paths(&[source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let db_path = catalog.db_path().to_path_buf();
        let app_data_dir = catalog.app_data_dir().to_path_buf();
        let faulted = catalog.with_test_delete_purge_failure();
        faulted.delete_asset(&asset.id, true).unwrap();
        let manifest = pending_delete_entries(&faulted).remove(0);
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        json["version"] = serde_json::Value::from(1);
        std::fs::write(&manifest, serde_json::to_vec(&json).unwrap()).unwrap();
        let quarantine = library_entries(&faulted)
            .into_iter()
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".luckyray-delete-pending-"))
            })
            .unwrap();
        let recovery = MaterialCatalog::new(db_path, app_data_dir);

        let retried = recovery.retry_pending_deletions().unwrap();

        assert_eq!((retried.cleaned, retried.pending), (0, 1));
        assert!(manifest.is_file());
        assert!(quarantine.is_file());
    }

    #[test]
    fn public_retry_rejects_manifest_pointing_at_external_file() {
        let catalog = MaterialCatalog::new_for_test();
        let external = catalog.app_data_dir().join("forged-external.bin");
        std::fs::write(&external, b"never-delete").unwrap();
        let pending_dir = catalog.app_data_dir().join("material-delete-pending");
        std::fs::create_dir_all(&pending_dir).unwrap();
        let manifest = pending_dir.join("delete-forged.json");
        std::fs::write(
            &manifest,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "token": "delete-forged",
                "assetId": "missing-asset",
                "rootId": "forged-root",
                "originalPath": catalog.app_data_dir().join("forged-original.bin"),
                "quarantinePath": external,
            }))
            .unwrap(),
        )
        .unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let retried = catalog.retry_pending_deletions().unwrap();
        assert_eq!((retried.cleaned, retried.pending), (0, 1));
        assert_eq!(std::fs::read(&external).unwrap(), b"never-delete");
        assert!(manifest.is_file());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
    }

    #[test]
    fn public_retry_counts_forged_manifest_basename_as_pending_without_file_action() {
        let catalog = MaterialCatalog::new_for_test();
        let external = catalog.app_data_dir().join("forged-name-target.bin");
        std::fs::write(&external, b"keep").unwrap();
        let pending_dir = catalog.app_data_dir().join("material-delete-pending");
        std::fs::create_dir_all(&pending_dir).unwrap();
        let manifest = pending_dir.join("delete-forged.json.extra");
        std::fs::write(
            &manifest,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "token": "delete-forged",
                "assetId": "missing-asset",
                "rootId": "0".repeat(64),
                "originalRelative": "safe.bin",
                "quarantineName": ".luckyray-delete-pending-delete-forged-safe.bin",
            }))
            .unwrap(),
        )
        .unwrap();

        let retried = catalog.retry_pending_deletions().unwrap();
        assert_eq!((retried.cleaned, retried.pending), (0, 1));
        assert_eq!(std::fs::read(&external).unwrap(), b"keep");
        assert!(manifest.is_file());
    }

    #[test]
    fn public_retry_rejects_traversal_wrong_root_and_forged_quarantine_name() {
        for (field, value) in [
            ("originalRelative", "../escape.bin"),
            (
                "rootId",
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            ),
            ("quarantineName", "../outside.bin"),
        ] {
            let catalog = MaterialCatalog::new_for_test();
            let source = catalog.app_data_dir().join(format!("tamper-{field}.bin"));
            std::fs::write(&source, b"pending").unwrap();
            let asset = catalog
                .import_paths(&[source], &MaterialImportOptions::default())
                .unwrap()
                .value
                .assets
                .remove(0);
            let db_path = catalog.db_path().to_path_buf();
            let app_data_dir = catalog.app_data_dir().to_path_buf();
            let faulted = catalog.with_test_delete_purge_failure();
            let deleted = faulted.delete_asset(&asset.id, true).unwrap();
            assert!(deleted.value.cleanup_pending);
            let manifest = pending_delete_entries(&faulted).remove(0);
            let mut json: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
            json[field] = serde_json::Value::String(value.into());
            std::fs::write(&manifest, serde_json::to_vec(&json).unwrap()).unwrap();
            let quarantine = library_entries(&faulted)
                .into_iter()
                .find(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(".luckyray-delete-pending-"))
                })
                .unwrap();
            let recovery = MaterialCatalog::new(db_path, app_data_dir);
            let version_before = recovery.read_change().unwrap().version;

            let retried = recovery.retry_pending_deletions().unwrap();
            assert_eq!((retried.cleaned, retried.pending), (0, 1), "{field}");
            assert!(manifest.is_file(), "{field}");
            assert_eq!(std::fs::read(&quarantine).unwrap(), b"pending", "{field}");
            assert_eq!(recovery.read_change().unwrap().version, version_before);
        }
    }

    #[test]
    fn public_managed_library_migration_moves_files_and_publishes_once() {
        let catalog = MaterialCatalog::new_for_test();
        let original = catalog.app_data_dir().join("migration-source.bin");
        let old_library = catalog.app_data_dir().join("old-library");
        let new_library = catalog.app_data_dir().join("new-library");
        std::fs::write(&original, b"migrate").unwrap();
        let imported = catalog
            .import_paths(
                &[original],
                &MaterialImportOptions {
                    managed_library_dir: Some(old_library.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let before = catalog.read_change().unwrap().version;
        let migrated = catalog
            .migrate_managed_library(&old_library, &new_library)
            .unwrap();
        assert_eq!(
            (migrated.value.moved_count, migrated.value.failed_count),
            (1, 0)
        );
        assert!(migrated
            .change
            .as_ref()
            .is_some_and(|change| change.version > before));
        let asset = catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .remove(0);
        let migrated_id = asset.id.clone();
        let migrated_path = std::path::PathBuf::from(asset.library_path.unwrap());
        assert!(migrated_path.starts_with(new_library.canonicalize().unwrap()));
        assert!(migrated_path.is_file());
        assert!(!std::path::Path::new(imported.library_path.as_ref().unwrap()).exists());
        let deleted = catalog.delete_asset(&migrated_id, true).unwrap();
        assert!(deleted.value.success);
        assert!(!deleted.value.cleanup_pending);
        assert!(!migrated_path.exists());
    }

    #[test]
    fn public_empty_managed_library_migration_does_not_register_arbitrary_roots() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("empty-migration-source");
        let target = catalog.app_data_dir().join("empty-migration-target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        let version_before = catalog.read_change().unwrap().version;

        let migrated = catalog.migrate_managed_library(&source, &target).unwrap();

        assert_eq!(migrated.value.moved_count, 0);
        assert!(migrated.change.is_none());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        let registry = catalog.app_data_dir().join("material-managed-roots");
        assert!(!registry.exists() || std::fs::read_dir(registry).unwrap().next().is_none());
    }

    #[test]
    fn public_failed_managed_library_migration_does_not_register_target_root() {
        let catalog = MaterialCatalog::new_for_test();
        let original = catalog.app_data_dir().join("failed-migration-original.bin");
        let source = catalog.app_data_dir().join("failed-migration-source");
        let target = catalog.app_data_dir().join("failed-migration-target");
        std::fs::write(&original, b"migration-failure").unwrap();
        let asset = catalog
            .import_paths(
                &[original],
                &MaterialImportOptions {
                    managed_library_dir: Some(source.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        std::fs::create_dir_all(&target).unwrap();
        let file_name = std::path::Path::new(asset.library_path.as_deref().unwrap())
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        std::fs::create_dir_all(target.join(&file_name)).unwrap();
        std::fs::create_dir_all(target.join(format!("{}-{}", asset.id, file_name))).unwrap();
        let target_id = managed_root_id(&target.canonicalize().unwrap());

        let migrated = catalog.migrate_managed_library(&source, &target).unwrap();

        assert_eq!(migrated.value.moved_count, 0);
        assert_eq!(migrated.value.failed_count, 1);
        assert!(migrated.change.is_none());
        assert!(!catalog
            .app_data_dir()
            .join("material-managed-roots")
            .join(format!("{target_id}.json"))
            .exists());
        assert!(std::path::Path::new(asset.library_path.as_deref().unwrap()).is_file());
    }

    #[test]
    fn public_partial_managed_library_migration_rolls_back_files_and_target_trust() {
        let catalog = MaterialCatalog::new_for_test();
        let source_root = catalog.app_data_dir().join("partial-migration-source");
        let target_root = catalog.app_data_dir().join("partial-migration-target");
        let original_a = catalog.app_data_dir().join("partial-a.bin");
        let original_b = catalog.app_data_dir().join("partial-b.bin");
        std::fs::write(&original_a, b"partial-a").unwrap();
        std::fs::write(&original_b, b"partial-b").unwrap();
        catalog
            .import_paths(
                &[original_a, original_b],
                &MaterialImportOptions {
                    managed_library_dir: Some(source_root.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        let before_assets = catalog.list_assets(&MaterialFilter::default()).unwrap();
        assert_eq!(before_assets.len(), 2);
        let rejected_id = before_assets[1].id.clone();
        let conn = rusqlite::Connection::open(catalog.db_path()).unwrap();
        conn.execute_batch(&format!(
            "CREATE TRIGGER reject_partial_migration BEFORE UPDATE OF library_path ON asset WHEN OLD.id='{}' BEGIN SELECT RAISE(ABORT, 'partial rejected'); END;",
            rejected_id
        ))
        .unwrap();
        drop(conn);
        let version_before = catalog.read_change().unwrap().version;
        let target_id = {
            std::fs::create_dir_all(&target_root).unwrap();
            managed_root_id(&target_root.canonicalize().unwrap())
        };

        let migrated = catalog
            .migrate_managed_library(&source_root, &target_root)
            .unwrap();

        assert_eq!(migrated.value.moved_count, 0);
        assert_eq!(migrated.value.failed_count, 1);
        assert!(migrated.change.is_none());
        assert_eq!(catalog.read_change().unwrap().version, version_before);
        let after_assets = catalog.list_assets(&MaterialFilter::default()).unwrap();
        for before in before_assets {
            let after = after_assets
                .iter()
                .find(|asset| asset.id == before.id)
                .unwrap();
            assert_eq!(after.library_path, before.library_path);
            assert!(std::path::Path::new(after.library_path.as_deref().unwrap()).is_file());
        }
        assert!(!catalog
            .app_data_dir()
            .join("material-managed-roots")
            .join(format!("{target_id}.json"))
            .exists());
    }
}

#[cfg(test)]
mod import_folder_tests {
    use super::{MaterialCatalog, sha256_file_and_size};
    use std::path::Path;
    use crate::materials::MaterialImportOptions;

    #[test]
    fn duplicate_asset_update_with_preserved_folder_publishes_once() {
        let catalog = MaterialCatalog::new_for_test();
        let root = catalog.app_data_dir().join("preserved");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("asset.png");
        std::fs::write(&file, b"same").unwrap();
        catalog
            .import_paths(&[file.clone()], &MaterialImportOptions::default())
            .unwrap();
        let result = catalog
            .import_folder(&root, &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(result.value.skipped_duplicate_count, 1);
        assert!(result
            .change
            .as_ref()
            .is_some_and(|change| change.folders_changed));
    }

    #[test]
    fn normal_file_import_returns_asset_and_change() {
        let catalog = MaterialCatalog::new_for_test();
        let root = catalog.app_data_dir().join("normal");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("asset.png"), b"normal").unwrap();
        let result = catalog
            .import_folder(&root, &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(result.value.imported_count, 1);
        assert!(result.change.is_some());
    }

    #[test]
    fn streaming_import_reports_bytes_preserves_source_and_deduplicates() {
        use std::io::Write;
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("large-fixture.mp4");
        let block = [0x53u8; 64 * 1024];
        let mut file = std::fs::File::create(&source).unwrap();
        for _ in 0..128 { file.write_all(&block).unwrap(); }
        drop(file);
        let before = sha256_file_and_size(&source).unwrap();
        for mode in ["linked", "managed"] {
            let options = MaterialImportOptions { storage_mode: mode.into(), ..Default::default() };
            let mut events = Vec::new();
            let result = catalog.import_paths_with_progress(&[source.clone()], &options, &mut |v| events.push(v)).unwrap();
            assert_eq!(result.value.imported_count, 1);
            let asset = &result.value.assets[0];
            assert_eq!(asset.content_hash.as_deref(), Some(before.0.as_str()));
            assert_eq!(asset.size_bytes, Some(before.1 as i64));
            assert!(events.iter().any(|e| e["bytesRead"] == 0 && e["bytesTotal"] == before.1));
            assert!(events.iter().any(|e| e["bytesRead"] == before.1));
            assert_eq!(events.last().unwrap()["current"], 1);
            if mode == "managed" { assert_eq!(sha256_file_and_size(Path::new(asset.library_path.as_ref().unwrap())).unwrap(), before); }
            assert_eq!(catalog.import_paths(&[source.clone()], &options).unwrap().value.skipped_duplicate_count, 1);
            assert_eq!(sha256_file_and_size(&source).unwrap(), before);
        }
    }

    #[test]
    fn streaming_import_rejects_changed_source_without_committing() {
        let catalog = MaterialCatalog::new_for_test();
        let source = catalog.app_data_dir().join("changing.mp4");
        std::fs::write(&source, b"before").unwrap();
        let options = MaterialImportOptions { storage_mode: "managed".into(), ..Default::default() };
        let result = catalog.import_paths_with_progress(&[source.clone()], &options, &mut |v| {
            if v["bytesRead"] == 0 { std::fs::write(&source, b"changed-longer").unwrap(); }
        }).unwrap();
        assert_eq!(result.value.failed_count, 1);
        assert_eq!(result.value.failed_items[0].code, "source-changed");
        assert!(result.change.is_none());
        let root = catalog.import_library_root(None).unwrap();
        assert!(!std::fs::read_dir(root).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".luckyray-import-")));
        assert_eq!(std::fs::read(source).unwrap(), b"changed-longer");
    }

    #[test]
    fn partial_failure_keeps_success_and_one_change() {
        let catalog = MaterialCatalog::new_for_test();
        let file = catalog.app_data_dir().join("valid.png");
        std::fs::write(&file, b"valid").unwrap();
        let missing = catalog.app_data_dir().join("missing.png");
        let result = catalog
            .import_paths(&[file, missing], &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(
            (result.value.imported_count, result.value.failed_count),
            (1, 1)
        );
        assert!(result.change.is_some());
    }

    #[test]
    fn zero_write_import_does_not_publish() {
        let catalog = MaterialCatalog::new_for_test();
        let file = catalog.app_data_dir().join("same.png");
        std::fs::write(&file, b"same").unwrap();
        catalog
            .import_paths(&[file.clone()], &MaterialImportOptions::default())
            .unwrap();
        let result = catalog
            .import_paths(&[file], &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(result.value.skipped_duplicate_count, 1);
        assert!(result.change.is_none());
    }
}

#[cfg(test)]
mod external_drag_tests {
    use super::MaterialCatalog;
    use crate::materials::MaterialImportOptions;

    #[test]
    fn external_drag_resolves_managed_and_linked_assets_in_requested_order() {
        let catalog = MaterialCatalog::new_for_test();
        let managed_source = catalog.app_data_dir().join("managed-drag.png");
        let linked_source = catalog.app_data_dir().join("linked-drag.mov");
        let source_source = catalog.app_data_dir().join("source-drag.wav");
        std::fs::write(&managed_source, b"managed").unwrap();
        std::fs::write(&linked_source, b"linked").unwrap();
        std::fs::write(&source_source, b"source").unwrap();

        let managed = catalog
            .import_paths(&[managed_source], &MaterialImportOptions::default())
            .unwrap()
            .value
            .assets
            .remove(0);
        let linked = catalog
            .import_paths(
                &[linked_source.clone()],
                &MaterialImportOptions {
                    storage_mode: "linked".into(),
                    ..MaterialImportOptions::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let source = catalog
            .import_paths(
                &[source_source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..MaterialImportOptions::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);

        let resolved = catalog
            .resolve_external_drag_files(&[
                linked.id.clone(),
                managed.id.clone(),
                source.id.clone(),
                source.id,
            ])
            .unwrap();
        assert_eq!(resolved.len(), 3);
        assert_eq!(resolved[0], std::fs::canonicalize(&linked_source).unwrap());
        assert!(resolved[1].is_file());
        assert_ne!(resolved[1], resolved[0]);
        assert_eq!(resolved[2], std::fs::canonicalize(&source_source).unwrap());

        let error = catalog
            .resolve_external_drag_files(&[linked.id, "missing-asset".into()])
            .unwrap_err();
        assert_eq!(error.code, "external-drag-asset-unavailable");
    }

    #[test]
    fn lightseek_paths_preserve_selection_order_and_duplicates() {
        let catalog = MaterialCatalog::new_for_test();
        let first_path = catalog.app_data_dir().join("中文 素材 #1 (`版`).png");
        let second_path = catalog.app_data_dir().join("second material.png");
        std::fs::write(&first_path, b"").unwrap();
        std::fs::write(&second_path, b"").unwrap();
        let first = catalog
            .import_paths(
                &[first_path.clone()],
                &MaterialImportOptions {
                    storage_mode: "linked".into(),
                    ..MaterialImportOptions::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let second = catalog
            .import_paths(
                &[second_path.clone()],
                &MaterialImportOptions {
                    storage_mode: "linked".into(),
                    ..MaterialImportOptions::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);

        let resolved = catalog
            .resolve_open_in_lightseek_paths(&[
                second.id.clone(),
                first.id.clone(),
                second.id.clone(),
            ])
            .unwrap();
        assert_eq!(
            resolved,
            vec![
                std::fs::canonicalize(&second_path).unwrap(),
                std::fs::canonicalize(&first_path).unwrap(),
                std::fs::canonicalize(&second_path).unwrap(),
            ]
        );

        std::fs::remove_file(&first_path).unwrap();
        let error = catalog
            .resolve_open_in_lightseek_paths(&[first.id])
            .unwrap_err();
        assert_eq!(error.code, "lightseek-material-unavailable");
    }
}
