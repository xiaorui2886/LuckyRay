//! Optimistic macOS writes with an on-disk recovery record and an atomic swap.
//! External programs can race revision checks. In that case preserve displaced
//! bytes and the journal; never silently discard a competing version.
use super::{error, KnowledgeError};
use crate::macos_fs::{digest, require_empty_acl, Directory, Version};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
#[path = "macos_recovery_state.rs"]
mod recovery_state;
use recovery_state::{decide, Recovery};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    nonce: String,
    target: String,
    before: Option<String>,
    after: String,
    #[serde(default)]
    before_object: Option<(u64, u64)>,
    #[serde(default)]
    next_object: Option<(u64, u64)>,
}

pub(super) struct RecoveryRecord {
    pub(super) version: Version,
    pub(super) target: String,
    pub(super) before: Option<String>,
    pub(super) after: String,
    pub(super) before_object: Option<(u64,u64)>,
    pub(super) next_object: Option<(u64,u64)>,
    pub(super) backup: String,
}
pub(super) fn inspect_record(dir:&Directory,name:&str)->Result<RecoveryRecord,KnowledgeError> {
    let (bytes,version)=dir.read_owned(OsStr::new(name)).map_err(|_|failed())?.ok_or_else(failed)?;
    let record:Journal=serde_json::from_slice(&bytes).map_err(|_|failed())?;
    if record.version!=1 || !super::macos_record_policy::record_name(&format!("{}.json",record.nonce))
        || ![format!(".lrm-{}.journal",record.nonce),format!(".lrm-{}.history",record.nonce)].contains(&name.to_owned())
        || !super::macos_record_policy::data_path(&record.target) || record.target.contains('/')
        || !super::macos_record_policy::hash64(&record.after)
        || record.before.as_ref().is_some_and(|value|!super::macos_record_policy::hash64(value)) {return Err(failed());}
    Ok(RecoveryRecord{version,target:record.target,before:record.before,after:record.after,
        before_object:record.before_object,next_object:record.next_object,backup:format!(".lrm-{}.backup",record.nonce)})
}
fn failed() -> KnowledgeError {
    error(
        "knowledge-recovery-required",
        "Knowledge write needs recovery; existing versions have been preserved",
    )
}
fn conflict() -> KnowledgeError {
    error(
        "knowledge-revision-conflict",
        "Knowledge document changed during the write; recovery copies have been preserved",
    )
}
fn acl_unsupported() -> KnowledgeError {
    error(
        "knowledge-acl-unsupported",
        "This file has an ACL which cannot be preserved by this write; the source is unchanged",
    )
}

pub(crate) fn write(
    path: &Path,
    bytes: &[u8],
    replace: bool,
    fail_before_commit: bool,
    expected: Option<&Version>,
    validate: impl FnOnce() -> Result<(), KnowledgeError>,
) -> Result<(), KnowledgeError> {
    let parent = path.parent().ok_or_else(failed)?;
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(failed)?;
    let dir = Directory::open(parent, false, false).map_err(|_| failed())?;
    write_at(
        &dir,
        OsStr::new(name),
        bytes,
        replace,
        fail_before_commit,
        expected,
        validate,
    ).map(|_|())
}

pub(super) fn write_at(
    dir: &Directory,
    name: &OsStr,
    bytes: &[u8],
    replace: bool,
    fail_before_commit: bool,
    expected: Option<&Version>,
    validate: impl FnOnce() -> Result<(), KnowledgeError>,
) -> Result<super::macos_attachment_io::Checkpoint, KnowledgeError> {
    let name = name.to_str().ok_or_else(failed)?;
    if !super::macos_record_policy::data_path(name) || name.contains('/') {return Err(failed());}
    dir.current().map_err(|_| failed())?;
    let source = match dir.open_metadata(OsStr::new(name)) {
        Ok(file) => {
            require_empty_acl(&file).map_err(|_| acl_unsupported())?;
            if file.metadata().map_err(|_| failed())?.uid() != unsafe { libc::geteuid() } {
                return Err(error(
                    "knowledge-permissions-unsupported",
                    "Document ownership cannot be preserved",
                ));
            }
            Some(file)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(failed()),
    };
    let before = dir.read(OsStr::new(name)).map_err(|_| failed())?;
    verify_source(&dir, name, source.as_ref(), before.as_ref().map(|(_, v)| v))?;
    if !replace && before.is_some() {
        return Err(error(
            "knowledge-name-conflict",
            "A document with this name already exists",
        ));
    }
    let _write_access = if let Some((_, version)) = &before {
        use std::os::unix::fs::MetadataExt;
        let file = dir
            .open_writable(OsStr::new(name))
            .map_err(|_| error("knowledge-write-denied", "Document is not writable"))?;
        let meta = file.metadata().map_err(|_| failed())?;
        if (meta.dev(), meta.ino()) != (version.device, version.inode) {
            return Err(conflict());
        }
        Some(file)
    } else {
        None
    };
    if expected.is_some_and(|expected| before.as_ref().map(|(_, v)| v) != Some(expected)) {
        return Err(conflict());
    }
    let _lock = dir
        .lock(OsStr::new(".lrm-write.lock"))
        .map_err(|_| conflict())?;
    recover_directory(&dir)?;
    verify_source(&dir, name, source.as_ref(), before.as_ref().map(|(_, v)| v))?;
    let nonce = format!("{:032x}", rand::random::<u128>());
    let backup = format!(".lrm-{nonce}.backup");
    let journal = format!(".lrm-{nonce}.journal");
    let staged_file = dir
        .create(OsStr::new(&backup), bytes)
        .map_err(|_| failed())?;
    require_empty_acl(&staged_file).map_err(|_| acl_unsupported())?;
    if let Some(source) = &source {
        let original = source.metadata().map_err(|_| failed())?;
        let staged = staged_file.metadata().map_err(|_| failed())?;
        if (original.uid(), original.gid()) != (staged.uid(), staged.gid()) {
            return Err(error(
                "knowledge-permissions-unsupported",
                "Document ownership cannot be preserved",
            ));
        }
    }
    let record = Journal {
        version: 1,
        nonce,
        target: name.to_owned(),
        before: before.as_ref().map(|(_, v)| v.hash.clone()),
        after: digest(bytes),
        before_object: before
            .as_ref()
            .map(|(_, version)| (version.device, version.inode)),
        next_object: Some({
            let meta = staged_file.metadata().map_err(|_| failed())?;
            (meta.dev(), meta.ino())
        }),
    };
    let journal_bytes = serde_json::to_vec(&record).map_err(|_| failed())?;
    let journal_file = dir
        .create(OsStr::new(&journal), &journal_bytes)
        .map_err(|_| failed())?;
    created_version(&dir, &backup, &staged_file, &record.after)?;
    let journal_version = created_version(&dir, &journal, &journal_file, &digest(&journal_bytes))?;
    let checked = dir.read(OsStr::new(name)).map_err(|_| failed())?;
    if fail_before_commit || checked.as_ref().map(|(_, v)| v) != before.as_ref().map(|(_, v)| v) {
        // A path can be replaced after an identity check and before unlinkat.
        // Keep the staged bytes and archive their intent. The recovery view
        // can offer the draft without leaving an ordinary conflict pending.
        // Never delete a name which may now refer to another writer's object.
        archive(&dir, &record, &journal_version)?;
        return Err(if fail_before_commit {
            error(
                "knowledge-write-failed",
                "Knowledge write stopped before commit",
            )
        } else {
            conflict()
        });
    }
    validate()?;
    verify_source(&dir, name, source.as_ref(), before.as_ref().map(|(_, v)| v))?;
    require_empty_acl(&staged_file).map_err(|_| acl_unsupported())?;
    // Do not expose copied mode bits before inspecting the actual displaced
    // inode. A late source/ACL substitution must not broaden access.
    if before.is_some() {
        staged_file
            .set_permissions(std::fs::Permissions::from_mode(0))
            .map_err(|_| failed())?;
        staged_file.sync_all().map_err(|_| failed())?;
    }
    dir.rename(OsStr::new(&backup), OsStr::new(name), before.is_some())
        .map_err(|_| failed())?;
    let installed = dir.entry_info(OsStr::new(name)).map_err(|_| failed())?;
    let meta = staged_file.metadata().map_err(|_| failed())?;
    if (installed.device, installed.inode) != (meta.dev(), meta.ino()) {
        return Err(conflict());
    }
    if let Some((_, expected)) = &before {
        let displaced = dir
            .read(OsStr::new(&backup))
            .map_err(|_| failed())?
            .ok_or_else(failed)?;
        if &displaced.1 != expected {
            return Err(conflict());
        }
        let source = source.as_ref().ok_or_else(conflict)?;
        require_empty_acl(source).map_err(|_| failed())?;
        let original = source.metadata().map_err(|_| failed())?;
        if !expected.matches_metadata(&original)
            || (original.uid(), original.gid()) != (meta.uid(), meta.gid())
        {
            return Err(conflict());
        }
    }
    let mut reader = staged_file.try_clone().map_err(|_| failed())?;
    reader.seek(SeekFrom::Start(0)).map_err(|_| failed())?;
    let mut staged_bytes = Vec::new();
    reader
        .take(crate::macos_fs::MAX_RECORD + 1)
        .read_to_end(&mut staged_bytes)
        .map_err(|_| failed())?;
    if staged_bytes != bytes {
        return Err(conflict());
    }
    require_empty_acl(&staged_file).map_err(|_| failed())?;
    if let (Some(source), Some((_, expected))) = (&source, &before) {
        require_empty_acl(source).map_err(|_| failed())?;
        let current = source.metadata().map_err(|_| failed())?;
        if !expected.matches_metadata(&current)
            || (current.uid(), current.gid()) != (meta.uid(), meta.gid())
        {
            return Err(conflict());
        }
    }
    staged_file
        .set_permissions(std::fs::Permissions::from_mode(
            before.as_ref().map_or(0o600, |(_, v)| v.permissions()),
        ))
        .map_err(|_| failed())?;
    staged_file.sync_all().map_err(|_| failed())?;
    let installed = dir
        .read(OsStr::new(name))
        .map_err(|_| failed())?
        .ok_or_else(failed)?;
    if (installed.1.device, installed.1.inode) != (meta.dev(), meta.ino())
        || installed.1.hash != record.after
    {
        return Err(conflict());
    }
    // Keep the displaced inode reachable: another editor may still write
    // through an already-open descriptor after this commit returns. A create
    // has no displaced inode, but its journal is retained rather than unlinked
    // through a name that could have been replaced concurrently.
    // If the journal cannot be bound after the name change, the data write may
    // already have happened. Preserve every object and report recovery rather
    // than claiming an unambiguous completion.
    archive(&dir, &record, &journal_version)?;
    let checkpoint=super::macos_attachment_io::checkpoint_held(dir,OsStr::new(name),&staged_file,false).map_err(|_|conflict())?;
    require_empty_acl(&staged_file).map_err(|_|failed())?;
    let final_meta=staged_file.metadata().map_err(|_|failed())?;
    if !checkpoint.matches_metadata(&final_meta) || !installed.1.matches_metadata(&final_meta)
        || (final_meta.uid(),final_meta.gid())!=(meta.uid(),meta.gid()) {return Err(conflict());}
    Ok(checkpoint)
}

fn verify_source(
    dir: &Directory,
    name: &str,
    source: Option<&File>,
    expected: Option<&Version>,
) -> Result<(), KnowledgeError> {
    match (source, expected) {
        (None, None) => match dir.open_metadata(OsStr::new(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(conflict()),
        },
        (Some(source), Some(expected)) => {
            let current = dir
                .open_metadata(OsStr::new(name))
                .map_err(|_| conflict())?;
            let meta = current.metadata().map_err(|_| failed())?;
            let original = source.metadata().map_err(|_| failed())?;
            if !expected.matches_metadata(&meta)
                || (meta.dev(), meta.ino()) != (original.dev(), original.ino())
            {
                return Err(conflict());
            }
            require_empty_acl(&current).map_err(|_| acl_unsupported())?;
            require_empty_acl(source).map_err(|_| acl_unsupported())
        }
        _ => Err(conflict()),
    }
}

fn archive(dir: &Directory, record: &Journal, expected: &Version) -> Result<(), KnowledgeError> {
    // History identifies retained versions; its presence alone does not claim
    // that a prepared write committed. No automatic pruning removes backups.
    let from = format!(".lrm-{}.journal", record.nonce);
    let to = format!(".lrm-{}.history", record.nonce);
    let current = dir
        .read_owned(OsStr::new(&from))
        .map_err(|_| failed())?
        .ok_or_else(failed)?;
    if &current.1 != expected {
        return Err(failed());
    }
    dir.rename(OsStr::new(&from), OsStr::new(&to), false)
        .map_err(|_| failed())?;
    let archived = dir
        .read_owned(OsStr::new(&to))
        .map_err(|_| failed())?
        .ok_or_else(failed)?;
    if &archived.1 != expected {
        return Err(failed());
    }
    Ok(())
}

// A mode-000 inode may be an interrupted publication or an external
// permission restriction. Never guess and grant access during recovery.
fn recover_unexposed_target(dir: &Directory, record: &Journal) -> Result<(), KnowledgeError> {
    let info = match dir.entry_info(OsStr::new(&record.target)) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(failed()),
    };
    if info.mode & 0o777 == 0 {
        return Err(failed());
    }
    Ok(())
}

fn created_version(
    dir: &Directory,
    name: &str,
    file: &std::fs::File,
    hash: &str,
) -> Result<Version, KnowledgeError> {
    use std::os::unix::fs::MetadataExt;
    let version = dir
        .read(OsStr::new(name))
        .map_err(|_| failed())?
        .ok_or_else(failed)?
        .1;
    let meta = file.metadata().map_err(|_| failed())?;
    if (version.device, version.inode) != (meta.dev(), meta.ino()) || version.hash != hash {
        return Err(conflict());
    }
    Ok(version)
}
pub(super) fn recover_directory(dir: &Directory) -> Result<(), KnowledgeError> {
    for entry in dir.entries().map_err(|_| failed())? {
        let Some(name) = entry
            .to_str()
            .filter(|s| s.starts_with(".lrm-") && s.ends_with(".journal"))
        else {
            continue;
        };
        let data = dir
            .read_owned(&entry)
            .map_err(|_| failed())?
            .ok_or_else(failed)?;
        let record: Journal = serde_json::from_slice(&data.0).map_err(|_| failed())?;
        let hash = |v: &str| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit());
        if record.version != 1
            || record.nonce.len() != 32
            || !record.nonce.bytes().all(|b| b.is_ascii_hexdigit())
            || name != format!(".lrm-{}.journal", record.nonce)
            || !hash(&record.after)
            || record.target.starts_with(".lrm-")
            || record.before.as_ref().is_some_and(|v| !hash(v))
        {
            return Err(failed());
        }
        let backup = format!(".lrm-{}.backup", record.nonce);
        recover_unexposed_target(dir, &record)?;
        let target = dir.read(OsStr::new(&record.target)).map_err(|_| failed())?;
        let previous = dir.read(OsStr::new(&backup)).map_err(|_| failed())?;
        let target_hash = target.as_ref().map(|(_, v)| v.hash.as_str());
        let backup_hash = previous.as_ref().map(|(_, v)| v.hash.as_str());
        match decide(
            record.before.as_deref(),
            &record.after,
            target_hash,
            backup_hash,
        ) {
            Recovery::Retain => {
                if let (Some(expected), Some((_, target))) = (record.next_object, target.as_ref()) {
                    if expected != (target.device, target.inode) {
                        return Err(failed());
                    }
                }
                if let (Some(expected), Some((_, previous))) =
                    (record.before_object, previous.as_ref())
                {
                    if expected != (previous.device, previous.inode) {
                        return Err(failed());
                    }
                }
                archive(dir, &record, &data.1)?;
            }
            Recovery::Archive => {
                // Recovery never unlinks a version path. Hashes alone cannot
                // prove which inode an external editor still has open.
                archive(dir, &record, &data.1)?;
            }
            Recovery::Restore => {
                // A matching digest at a replacement inode is not the original
                // version. Legacy records without this proof need explicit UI
                // inspection/copy, rather than an automatic pathname restore.
                let Some((device,inode))=record.before_object else {return Err(failed());};
                if previous.as_ref().is_none_or(|(_,version)|(version.device,version.inode)!=(device,inode)) {
                    return Err(failed());
                }
                dir.rename(OsStr::new(&backup), OsStr::new(&record.target), false)
                    .map_err(|_| failed())?;
                let restored = dir
                    .read(OsStr::new(&record.target))
                    .map_err(|_| failed())?
                    .ok_or_else(failed)?;
                if previous.as_ref().map(|(_, version)| version) != Some(&restored.1) {
                    return Err(failed());
                }
                archive(dir, &record, &data.1)?;
            }
            Recovery::Preserve => return Err(failed()),
        }
    }
    Ok(())
}

pub(super) fn recover_tree(root: &Path) -> Result<(), KnowledgeError> {
    let mut pending = vec![root.to_owned()];
    let mut visited = 0usize;
    while let Some(path) = pending.pop() {
        visited += 1;
        if visited > 100_000 {
            return Err(failed());
        }
        let dir = Directory::open(&path, false, false).map_err(|_| failed())?;
        let entries = dir.entries().map_err(|_| failed())?;
        if entries.iter().any(|v| {
            v.to_str()
                .is_some_and(|v| v.starts_with(".lrm-") && v.ends_with(".journal"))
        }) {
            let _lock = dir
                .lock(OsStr::new(".lrm-write.lock"))
                .map_err(|_| failed())?;
            recover_directory(&dir)?;
        }
        for name in entries {
            let child = path.join(name);
            let meta = match std::fs::symlink_metadata(&child) {
                Ok(meta) => meta,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(failed()),
            };
            if meta.is_dir() && !meta.file_type().is_symlink() {
                pending.push(child);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "macos_transaction_tests.rs"]
mod tests;
