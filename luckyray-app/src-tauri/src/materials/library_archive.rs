//! Bounded ZIP adapter using the project's existing zip crate. No arbitrary extraction.
use super::catalog::{canonical_regular_file, export_file_identity};
use super::export::{move_no_replace, DirectoryHold};
use super::library_package::*;
use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::UNIX_EPOCH;

pub(super) const CHUNK: usize = 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourceMedia {
    pub asset_id: String,
    pub path: PathBuf,
    pub identity: String,
    pub size: u64,
    pub modified: u64,
    pub sha256: Option<String>,
}
fn io(e: std::io::Error) -> MaterialError {
    MaterialError::io("library-transfer-io", "读写素材库媒体失败", e)
}
fn zip_error(e: zip::result::ZipError) -> MaterialError {
    fail(format!("库包归档无效: {e}"))
}
// zip 2's name index collapses duplicate central entries and allocates using the
// declared count. Read only the bounded end-directory counters before invoking
// its parser; all entry parsing/decompression remains in the existing crate.
struct MetadataBudgetFile {
    file: File,
    remaining: Arc<AtomicU64>,
}
impl Read for MetadataBudgetFile {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let budget = self.remaining.load(Ordering::Relaxed);
        if buffer.len() as u64 > budget {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ZIP metadata read budget exceeded",
            ));
        }
        let n = self.file.read(buffer)?;
        if budget != u64::MAX {
            self.remaining.fetch_sub(n as u64, Ordering::Relaxed);
        }
        Ok(n)
    }
}
impl Seek for MetadataBudgetFile {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(position)
    }
}
fn bounded_archive(mut file: File) -> MaterialResult<zip::ZipArchive<MetadataBudgetFile>> {
    let size = file.metadata().map_err(io)?.len();
    if size < 22 || size > MAX_BYTES + 4 * MAX_METADATA {
        return Err(fail("库包文件体积超出预算"));
    }
    let tail_size = size.min(65_557);
    file.seek(SeekFrom::End(-(tail_size as i64))).map_err(io)?;
    let mut tail = vec![0; tail_size as usize];
    file.read_exact(&mut tail).map_err(io)?;
    let position = (0..=tail.len() - 22)
        .rev()
        .find(|&i| {
            tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06]
                && i + 22 + u16::from_le_bytes([tail[i + 20], tail[i + 21]]) as usize == tail.len()
        })
        .ok_or_else(|| fail("库包末目录无效"))?;
    let end = &tail[position..position + 22];
    let u16_at = |b: &[u8], i: usize| u16::from_le_bytes(b[i..i + 2].try_into().unwrap());
    let u32_at = |b: &[u8], i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let u64_at = |b: &[u8], i: usize| u64::from_le_bytes(b[i..i + 8].try_into().unwrap());
    if u16_at(end, 4) != 0
        || u16_at(end, 6) != 0
        || u16_at(end, 8) != u16_at(end, 10)
        || u16_at(end, 20) > 4096
    {
        return Err(fail("不支持多卷或过长注释库包"));
    }
    let mut count = u16_at(end, 10) as u64;
    let mut cd_size = u32_at(end, 12) as u64;
    let mut cd_offset = u32_at(end, 16) as u64;
    let end_offset = size - tail_size + position as u64;
    if position >= 20 && tail[position - 20..position - 16] == [0x50, 0x4b, 0x06, 0x07] {
        let locator = &tail[position - 20..position];
        let offset = u64_at(locator, 8);
        if u32_at(locator, 4) != 0
            || u32_at(locator, 16) != 1
            || offset.checked_add(56).is_none_or(|v| v > end_offset - 20)
        {
            return Err(fail("ZIP64目录位置无效"));
        }
        file.seek(SeekFrom::Start(offset)).map_err(io)?;
        let mut block = [0u8; 56];
        file.read_exact(&mut block).map_err(io)?;
        if block[..4] != [0x50, 0x4b, 0x06, 0x06]
            || u64_at(&block, 4) != 44
            || u32_at(&block, 16) != 0
            || u32_at(&block, 20) != 0
            || u64_at(&block, 24) != u64_at(&block, 32)
        {
            return Err(fail("ZIP64目录无效或超出预算"));
        }
        let actual_count = u64_at(&block, 32);
        if count != 65535 && count != actual_count {
            return Err(fail("ZIP64条目计数矛盾"));
        }
        count = actual_count;
        cd_size = u64_at(&block, 40);
        cd_offset = u64_at(&block, 48);
    }
    if count > MAX_ASSETS as u64 + 2
        || cd_size > MAX_METADATA
        || cd_offset
            .checked_add(cd_size)
            .is_none_or(|v| v > end_offset)
    {
        return Err(fail("库包目录计数或体积超出预算"));
    }
    file.seek(SeekFrom::Start(0)).map_err(io)?;
    let remaining = Arc::new(AtomicU64::new(MAX_METADATA + 1024 * 1024));
    let archive = zip::ZipArchive::new(MetadataBudgetFile {
        file,
        remaining: remaining.clone(),
    })
    .map_err(zip_error)?;
    if archive.len() as u64 != count
        || archive.offset() != 0
        || archive.central_directory_start() != cd_offset
    {
        return Err(fail("库包含重复条目或目录偏移矛盾"));
    }
    remaining.store(u64::MAX, Ordering::Relaxed);
    Ok(archive)
}
fn stamp(f: &File) -> MaterialResult<(String, u64, u64)> {
    let m = f.metadata().map_err(io)?;
    if !m.is_file() {
        return Err(fail("媒体不是普通文件"));
    }
    let modified = m
        .modified()
        .map_err(io)?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| fail("媒体时间无效"))?
        .as_nanos()
        .try_into()
        .map_err(|_| fail("媒体时间超出预算"))?;
    Ok((export_file_identity(f)?, m.len(), modified))
}
pub(super) fn freeze_media(
    catalog: &MaterialCatalog,
    a: &MaterialAsset,
) -> MaterialResult<SourceMedia> {
    let path = catalog.resolve_export_file(a)?;
    freeze_path(&path, &a.id, MAX_FILE)
}
pub(super) fn freeze_path(path: &Path, id: &str, budget: u64) -> MaterialResult<SourceMedia> {
    let path = canonical_regular_file(path)?;
    let file = crate::companion_gateway::content::open_resource(&path).map_err(io)?;
    let (identity, size, modified) = stamp(&file)?;
    if size > budget {
        return Err(fail("文件超出任务预算"));
    }
    Ok(SourceMedia {
        asset_id: id.into(),
        path,
        identity,
        size,
        modified,
        sha256: None,
    })
}
pub(super) fn open_frozen(s: &SourceMedia) -> MaterialResult<File> {
    let path = canonical_regular_file(&s.path)?;
    if path != s.path {
        return Err(fail("媒体路径已变化"));
    }
    let f = crate::companion_gateway::content::open_resource(&path).map_err(io)?;
    if stamp(&f)? != (s.identity.clone(), s.size, s.modified) {
        return Err(fail("素材在任务期间已变化，请重新开始"));
    }
    Ok(f)
}
pub(super) fn hold_frozen(s: &SourceMedia) -> MaterialResult<File> {
    let path = canonical_regular_file(&s.path)?;
    if path != s.path {
        return Err(fail("提交媒体路径已变化"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(io)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file.metadata().map_err(io)?.file_attributes() & 0x400 != 0 {
            return Err(fail("提交媒体包含重解析点"));
        }
    }
    if stamp(&file)? != (s.identity.clone(), s.size, s.modified) {
        return Err(fail("提交媒体身份已变化"));
    }
    Ok(file)
}
pub(super) fn hash_reader<R: Read>(
    r: &mut R,
    mut progress: impl FnMut(u64) -> MaterialResult<()>,
) -> MaterialResult<(String, u64)> {
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0; CHUNK];
    loop {
        progress(bytes)?;
        let n = r.read(&mut buffer).map_err(io)?;
        if n == 0 {
            break;
        }
        bytes = bytes
            .checked_add(n as u64)
            .ok_or_else(|| fail("媒体过大"))?;
        if bytes > MAX_BYTES + 2 * MAX_METADATA {
            return Err(fail("媒体超出预算"));
        }
        hash.update(&buffer[..n]);
    }
    progress(bytes)?;
    Ok((format!("{:x}", hash.finalize()), bytes))
}
pub(super) fn verify_media(
    s: &SourceMedia,
    progress: impl FnMut(u64) -> MaterialResult<()>,
) -> MaterialResult<String> {
    let mut f = open_frozen(s)?;
    let (hash, size) = hash_reader(&mut f, progress)?;
    if size != s.size
        || stamp(&f)? != (s.identity.clone(), s.size, s.modified)
        || s.sha256.as_ref().is_some_and(|h| h != &hash)
    {
        return Err(fail("素材在任务期间已变化，请重新开始"));
    }
    Ok(hash)
}
pub(super) fn sha_file(path: &Path) -> MaterialResult<(String, u64)> {
    let path = canonical_regular_file(path)?;
    let mut f = crate::companion_gateway::content::open_resource(&path).map_err(io)?;
    hash_reader(&mut f, |_| Ok(()))
}

pub(super) fn copy_media(
    s: &SourceMedia,
    destination: &Path,
    mut progress: impl FnMut(u64) -> MaterialResult<()>,
) -> MaterialResult<()> {
    let hash = s.sha256.as_ref().ok_or_else(|| fail("媒体尚未核验"))?;
    if destination.exists() {
        let (existing, size) = sha_file(destination)?;
        if &existing == hash && size == s.size {
            return Ok(());
        }
        return Err(fail("目标暂存媒体与恢复记录冲突"));
    }
    let parent = destination.parent().ok_or_else(|| fail("目标目录无效"))?;
    let hold = DirectoryHold::new(parent).map_err(fail)?;
    let mut source = open_frozen(s)?;
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(io)?;
    let operation = (|| {
        let mut h = Sha256::new();
        let mut count = 0u64;
        let mut buffer = vec![0; CHUNK];
        loop {
            progress(count)?;
            hold.verify().map_err(fail)?;
            let n = source.read(&mut buffer).map_err(io)?;
            if n == 0 {
                break;
            }
            count += n as u64;
            if count > s.size {
                return Err(fail("素材变大"));
            }
            target.write_all(&buffer[..n]).map_err(io)?;
            h.update(&buffer[..n]);
        }
        if count != s.size
            || format!("{:x}", h.finalize()) != *hash
            || stamp(&source)? != (s.identity.clone(), s.size, s.modified)
        {
            return Err(fail("复制期间素材已变化"));
        }
        progress(count)?;
        target.sync_all().map_err(io)?;
        hold.verify().map_err(fail)?;
        Ok(())
    })();
    drop(target);
    if operation.is_err() {
        if canonical_regular_file(destination).is_ok() {
            let _ = std::fs::remove_file(destination);
        }
    }
    operation
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntegrityEntry {
    path: String,
    sha256: String,
    size_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Integrity {
    version: u32,
    entries: Vec<IntegrityEntry>,
}

pub(super) fn write_package(
    p: &LibraryPackage,
    sources: &[SourceMedia],
    temporary: &Path,
    mut progress: impl FnMut(&str, u64) -> MaterialResult<()>,
) -> MaterialResult<()> {
    validate_package(p)?;
    let mut writer = zip::ZipWriter::new(
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary)
            .map_err(io)?,
    );
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o600);
    let metadata = serde_json::to_vec(p).map_err(|e| fail(e.to_string()))?;
    if metadata.len() as u64 > MAX_METADATA {
        return Err(fail("元数据快照超出16MiB预算"));
    }
    writer
        .start_file("manifest.json", options)
        .map_err(zip_error)?;
    writer.write_all(&metadata).map_err(io)?;
    let mut entries = vec![IntegrityEntry {
        path: "manifest.json".into(),
        sha256: format!("{:x}", Sha256::digest(&metadata)),
        size_bytes: metadata.len() as u64,
    }];
    let by_id: HashMap<_, _> = sources.iter().map(|s| (&s.asset_id, s)).collect();
    let mut written = HashSet::new();
    for a in &p.assets {
        progress(&a.name, 0)?;
        if !written.insert(&a.sha256) {
            continue;
        }
        let s = by_id.get(&a.id).ok_or_else(|| fail("媒体快照缺失"))?;
        let path = format!("media/{}", a.sha256);
        writer.start_file(&path, options).map_err(zip_error)?;
        let mut source = open_frozen(s)?;
        let mut h = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = vec![0; CHUNK];
        loop {
            progress(&a.name, bytes)?;
            let n = source.read(&mut buffer).map_err(io)?;
            if n == 0 {
                break;
            }
            bytes += n as u64;
            if bytes > a.size_bytes {
                return Err(fail("备份期间素材变大"));
            }
            writer.write_all(&buffer[..n]).map_err(io)?;
            h.update(&buffer[..n]);
        }
        if bytes != a.size_bytes
            || format!("{:x}", h.finalize()) != a.sha256
            || stamp(&source)? != (s.identity.clone(), s.size, s.modified)
        {
            return Err(fail("备份期间素材发生变化"));
        }
        entries.push(IntegrityEntry {
            path,
            sha256: a.sha256.clone(),
            size_bytes: bytes,
        });
    }
    // Earlier copied sources are rechecked too: a backup never silently mixes file revisions.
    for s in sources {
        verify_media(s, |b| progress(&s.asset_id, b))?;
    }
    let integrity = serde_json::to_vec(&Integrity {
        version: 1,
        entries,
    })
    .map_err(|e| fail(e.to_string()))?;
    writer
        .start_file("integrity.json", options)
        .map_err(zip_error)?;
    writer.write_all(&integrity).map_err(io)?;
    writer.finish().map_err(zip_error)?.sync_all().map_err(io)?;
    Ok(())
}

fn safe_entry(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 256
        || name.contains('\\')
        || name.contains(':')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.split('/').count() > 2
    {
        return false;
    }
    name.split('/').all(|part| {
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || part.chars().any(char::is_control)
        {
            return false;
        }
        let base = part.split('.').next().unwrap().to_ascii_uppercase();
        !matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            && !(base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && base.as_bytes()[3].is_ascii_digit())
    })
}
fn read_bounded<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
    budget: u64,
) -> MaterialResult<Vec<u8>> {
    let entry = archive.by_name(name).map_err(zip_error)?;
    if entry.size() > budget {
        return Err(fail("库包元数据超出预算"));
    }
    let mut bytes = Vec::new();
    entry.take(budget + 1).read_to_end(&mut bytes).map_err(io)?;
    if bytes.len() as u64 > budget {
        return Err(fail("库包条目超出预算"));
    }
    Ok(bytes)
}
pub(super) fn inspect_package(path: &Path) -> MaterialResult<LibraryPackage> {
    let path = canonical_regular_file(path)?;
    let file = crate::companion_gateway::content::open_resource(&path).map_err(io)?;
    let mut archive = bounded_archive(file)?;
    if archive.len() > MAX_ASSETS + 2 {
        return Err(fail("库包条目数量超出预算"));
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(zip_error)?;
        let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
        if !safe_entry(entry.name())
            || !names.insert(entry.name().to_ascii_lowercase())
            || entry.is_dir()
            || entry.is_symlink()
            || !matches!(mode, 0 | 0o100000)
            || entry.size() > MAX_FILE
            || entry.compressed_size() == 0 && entry.size() > 0
            || entry.size()
                > entry
                    .compressed_size()
                    .saturating_mul(1000)
                    .max(1024 * 1024)
        {
            return Err(fail("库包含危险路径、链接、重复条目或压缩预算超限"));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| fail("库包过大"))?;
    }
    if total > MAX_BYTES + 2 * MAX_METADATA {
        return Err(fail("库包解压体积超出预算"));
    }
    let manifest = read_bounded(&mut archive, "manifest.json", MAX_METADATA)?;
    let p: LibraryPackage =
        serde_json::from_slice(&manifest).map_err(|e| fail(format!("库包manifest无效: {e}")))?;
    validate_package(&p)?;
    let integrity: Integrity =
        serde_json::from_slice(&read_bounded(&mut archive, "integrity.json", MAX_METADATA)?)
            .map_err(|e| fail(e.to_string()))?;
    if integrity.version != 1 {
        return Err(fail("完整性清单版本不支持"));
    }
    let mut expected = HashMap::from([(
        "manifest.json".into(),
        (
            format!("{:x}", Sha256::digest(&manifest)),
            manifest.len() as u64,
        ),
    )]);
    for a in &p.assets {
        let key = format!("media/{}", a.sha256);
        if let Some((_, size)) = expected.insert(key, (a.sha256.clone(), a.size_bytes)) {
            if size != a.size_bytes {
                return Err(fail("同hash媒体大小矛盾"));
            }
        }
    }
    if integrity.entries.len() != expected.len() || names.len() != expected.len() + 1 {
        return Err(fail("库包媒体缺失或含未声明条目"));
    }
    let mut checked = HashSet::new();
    for e in integrity.entries {
        if !checked.insert(e.path.clone())
            || expected.get(&e.path) != Some(&(e.sha256.clone(), e.size_bytes))
            || !names.contains(&e.path)
        {
            return Err(fail("完整性清单不匹配"));
        }
        let file = archive.by_name(&e.path).map_err(zip_error)?;
        if file.size() != e.size_bytes {
            return Err(fail("媒体清单大小不匹配"));
        }
    }
    Ok(p)
}

pub(super) fn extract_media(
    path: &Path,
    p: &LibraryPackage,
    destination: &Path,
    mut progress: impl FnMut(&str, u64) -> MaterialResult<()>,
) -> MaterialResult<HashMap<String, SourceMedia>> {
    let path = canonical_regular_file(path)?;
    let file = crate::companion_gateway::content::open_resource(&path).map_err(io)?;
    let mut archive = bounded_archive(file)?;
    let root = super::catalog::canonical_trusted_root(destination)?;
    let hold = DirectoryHold::new(&root).map_err(fail)?;
    let mut sources = HashMap::new();
    for a in &p.assets {
        progress(&a.name, 0)?;
        hold.verify().map_err(fail)?;
        let leaf = root.join(&a.sha256);
        if leaf.exists() {
            let (hash, size) = sha_file(&leaf)?;
            if hash != a.sha256 || size != a.size_bytes {
                return Err(fail("库包暂存冲突"));
            }
        } else {
            let partial = root.join(format!("{}.partial", a.sha256));
            if partial.exists() {
                canonical_regular_file(&partial)?;
                std::fs::remove_file(&partial).map_err(io)?;
            }
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&partial)
                .map_err(io)?;
            let mut entry = archive
                .by_name(&format!("media/{}", a.sha256))
                .map_err(zip_error)?;
            let operation = (|| {
                let mut h = Sha256::new();
                let mut bytes = 0u64;
                let mut buffer = vec![0; CHUNK];
                loop {
                    progress(&a.name, bytes)?;
                    hold.verify().map_err(fail)?;
                    let n = entry.read(&mut buffer).map_err(io)?;
                    if n == 0 {
                        break;
                    }
                    bytes += n as u64;
                    if bytes > a.size_bytes {
                        return Err(fail("库包媒体超过声明大小"));
                    }
                    out.write_all(&buffer[..n]).map_err(io)?;
                    h.update(&buffer[..n]);
                }
                if bytes != a.size_bytes || format!("{:x}", h.finalize()) != a.sha256 {
                    return Err(fail("库包媒体hash不匹配"));
                }
                out.sync_all().map_err(io)?;
                Ok(())
            })();
            drop(out);
            operation?;
            hold.verify().map_err(fail)?;
            move_no_replace(&partial, &leaf).map_err(io)?;
        }
        let f = crate::companion_gateway::content::open_resource(&leaf).map_err(io)?;
        let (identity, size, modified) = stamp(&f)?;
        sources.insert(
            a.id.clone(),
            SourceMedia {
                asset_id: a.id.clone(),
                path: canonical_regular_file(&leaf)?,
                identity,
                size,
                modified,
                sha256: Some(a.sha256.clone()),
            },
        );
    }
    Ok(sources)
}
