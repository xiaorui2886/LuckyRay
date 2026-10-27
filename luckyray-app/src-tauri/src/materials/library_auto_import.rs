//! Root auto-import is a scoped entry to the existing Catalog save/dedupe chain.
use super::catalog::*;
use super::*;
use std::path::{Path, PathBuf};

impl MaterialCatalog {
    /// Event batches inspect only changed paths. None means startup/low-frequency
    /// reconciliation. Metadata stability + a read-only sharing lease on Windows
    /// prevents importing a paused-but-still-open copy as a complete file.
    pub(crate) fn import_stable_library_files(&self, expected_root: &Path, paths: Option<&[String]>)
        -> MaterialResult<(CatalogOutcome<MaterialImportResult>, Vec<String>, u128)> {
        let started = std::time::Instant::now();
        let root = self.library_watch_root()?;
        if root != expected_root { return Err(MaterialError::new("library-watch-root-changed", "库目录已变化，请重新确认自动导入")); }
        let mut files = std::collections::BTreeSet::new();
        match paths {
            None => files.extend(collect_library_files(&root)?),
            Some(paths) => for path in paths {
                let path = PathBuf::from(path);
                if !is_library_source_path(&root, &path) { continue; }
                if path.is_dir() { files.extend(collect_library_files(&path)?); }
                else if path.is_file() { files.insert(path); }
            },
        }
        let mut deferred = Vec::new();
        let mut samples = Vec::new();
        for path in files {
            if !is_library_source_path(&root, &path) { continue; }
            if samples.len() >= 128 { deferred.push(path.to_string_lossy().into_owned()); continue; }
            match std::fs::metadata(&path) {
                Ok(meta) => samples.push((path, (meta.len(), meta.modified().ok()))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                Err(e) => return Err(MaterialError::io("library-watch-read-failed", "读取自动导入文件失败", e)),
            }
        }
        if !samples.is_empty() { std::thread::sleep(std::time::Duration::from_millis(750)); }
        let mut leases = Vec::new();
        let mut ready = Vec::new();
        for (path, stamp) in samples {
            if !is_library_source_path(&root, &path) { continue; }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)] {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(1); // FILE_SHARE_READ only; no active writer/rename.
            }
            match options.open(&path) {
                Ok(file) => {
                    let meta = file.metadata().map_err(|e| MaterialError::io("library-watch-read-failed", "读取自动导入文件失败", e))?;
                    if (meta.len(), meta.modified().ok()) == stamp {
                        leases.push(file); ready.push(path);
                    } else { deferred.push(path.to_string_lossy().into_owned()); }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                Err(e) if matches!(e.raw_os_error(), Some(32) | Some(33)) => deferred.push(path.to_string_lossy().into_owned()),
                Err(e) => return Err(MaterialError::io("library-watch-read-failed", "自动导入文件无法读取", e)),
            }
        }
        // Revalidate after waiting; do not follow a relocated or hidden library.
        if self.library_watch_root()? != root { return Err(MaterialError::new("library-watch-root-changed", "库目录已变化")); }
        let id = self.library_scope_key()?;
        let library = self.list_libraries(true)?.into_iter().find(|l| l.id == id)
            .ok_or_else(|| MaterialError::new("library-unavailable", "素材库不存在"))?;
        let result = self.import_folder_files(&root, &MaterialImportOptions {
            storage_mode: library.storage_mode, preserve_folder_structure: true,
            ..MaterialImportOptions::default()
        }, ready)?;
        drop(leases); // Hold sharing leases throughout the existing import/save chain.
        Ok((result, deferred, started.elapsed().as_millis()))
    }

    pub(crate) fn library_watch_root(&self) -> MaterialResult<PathBuf> {
        let id = self.library_scope_key()?;
        let lib = self.list_libraries(true)?.into_iter().find(|lib| lib.id == id)
            .ok_or_else(|| MaterialError::new("library-unavailable", "素材库不存在"))?;
        if lib.state != "ready" || !lib.visible {
            return Err(MaterialError::new("library-unavailable", "素材库不可用或已隐藏"));
        }
        match lib.root_path {
            Some(_) => Ok(self.import_library_root(None)?.parent().expect("managed assets has a root").to_owned()),
            None => Ok(self.import_library_root(None)?),
        }
    }

    pub(crate) fn import_library_watch_root(&self, expected_root: &Path) -> MaterialResult<CatalogOutcome<MaterialImportResult>> {
        let root = self.library_watch_root()?;
        // A relocated library must be explicitly enabled again, never follow stale opt-in.
        if root != expected_root {
            return Err(MaterialError::new("library-watch-root-changed", "库目录已变化，请重新确认自动导入"));
        }
        let files = collect_library_files(&root)?;
        let id = self.library_scope_key()?;
        let library = self.list_libraries(true)?.into_iter().find(|lib| lib.id == id)
            .ok_or_else(|| MaterialError::new("library-unavailable", "素材库不存在"))?;
        // Keep the library's existing storage/dedupe policy. Managed output is
        // excluded above; source mode refreshes existing metadata in Catalog.
        self.import_folder_files(&root, &MaterialImportOptions {
            storage_mode: library.storage_mode, preserve_folder_structure: true,
            ..MaterialImportOptions::default()
        }, files)
    }
}

pub(super) fn is_library_source_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else { return false; };
    if relative.as_os_str().is_empty() { return false; }
    let mut cursor = root.to_owned();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else { return false; };
        let name = part.to_string_lossy().to_ascii_lowercase();
        if excluded_name(&name) { return false; }
        cursor.push(part);
        if let Ok(metadata) = std::fs::symlink_metadata(&cursor) {
            if metadata.file_type().is_symlink() { return false; }
            #[cfg(windows)] {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 { return false; }
            }
            if metadata.is_dir() && cursor.join("library.json").exists() { return false; }
        }
    }
    true
}

fn excluded_name(name: &str) -> bool {
    name.starts_with('.') || name == "library.json" || name == "assets"
        || [".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite-wal", ".sqlite-shm", ".tmp", ".part", ".crdownload"].iter().any(|suffix| name.ends_with(suffix))
}

fn collect_library_files(root: &Path) -> MaterialResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut directories = vec![root.to_owned()];
    while let Some(directory) = directories.pop() {
        let entries = std::fs::read_dir(&directory)
            .map_err(|e| MaterialError::io("library-watch-read-failed", "无法扫描素材库目录", e))?;
        for entry in entries {
            let entry = entry.map_err(|e| MaterialError::io("library-watch-read-failed", "读取素材库文件失败", e))?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|e| MaterialError::io("library-watch-read-failed", "读取素材库文件属性失败", e))?;
            if metadata.file_type().is_symlink() { continue; }
            #[cfg(windows)] {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 { continue; } // Junctions/reparse points.
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            // Product-owned files, caches, managed copies and other libraries are not sources.
            if excluded_name(&name) {
                continue;
            }
            if metadata.is_dir() {
                if !path.join("library.json").exists() { directories.push(path); }
            } else if metadata.is_file() { files.push(path); }
        }
    }
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn library_auto_import_root_preserves_identity_dedupes_and_excludes_internal_files() {
        let base = MaterialCatalog::new_for_test();
        let root = base.app_data_dir().join("中文 空格库");
        std::fs::create_dir_all(&root).unwrap();
        let lib = base.create_library("自动导入测试", &root, "managed").unwrap();
        let catalog = base.for_library(&lib.id).unwrap();
        let root = catalog.library_watch_root().unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::create_dir_all(root.join("another")).unwrap();
        for (name, bytes) in [("新增.txt", "one"), ("sub/第二.txt", "two"), ("assets/owned.txt", "owned"), ("private.db", "db"), (".hidden", "hidden"), ("another/library.json", "{}"), ("another/private.txt", "other")] {
            std::fs::write(root.join(name), bytes).unwrap();
        }
        assert!(catalog.import_library_watch_root(&root.join("sub")).is_err());
        let result = catalog.import_library_watch_root(&root).unwrap().value;
        assert_eq!(result.imported_count, 2);
        assert_eq!(result.failed_count, 0);
        assert_eq!(catalog.import_library_watch_root(&root).unwrap().value.skipped_duplicate_count, 2);
        assert_eq!(catalog.list_assets(&Default::default()).unwrap().len(), 2);
        assert!(base.list_assets(&Default::default()).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(root.join("新增.txt")).unwrap(), "one");
        std::fs::write(root.join("新增.txt"), "changed-content").unwrap();
        assert_eq!(catalog.import_library_watch_root(&root).unwrap().value.imported_count, 1);
    }

    #[test]
    fn library_auto_import_respects_source_policy_and_keeps_existing_asset_id() {
        let base = MaterialCatalog::new_for_test();
        let root = base.app_data_dir().join("source-library");
        std::fs::create_dir_all(&root).unwrap();
        let lib = base.create_library("源文件库", &root, "source").unwrap();
        let catalog = base.for_library(&lib.id).unwrap();
        let root = catalog.library_watch_root().unwrap();
        std::fs::write(root.join("source.txt"), "first").unwrap();
        let first = catalog.import_library_watch_root(&root).unwrap();
        let id = first.value.assets[0].id.clone();
        assert_eq!(first.value.assets[0].storage_mode, "source");
        assert!(catalog.import_library_watch_root(&root).unwrap().change.is_none());
        std::fs::write(root.join("source.txt"), "updated-source").unwrap();
        let changed = catalog.import_library_watch_root(&root).unwrap();
        assert!(changed.change.is_some());
        let assets = catalog.list_assets(&Default::default()).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].id, id);
        assert_eq!(assets[0].size_bytes, Some(14));
    }
}
