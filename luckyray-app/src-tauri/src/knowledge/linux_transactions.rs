use super::*;
use crate::linux_fs::{Directory, Version};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;

pub(super) fn failure(error_value: std::io::Error) -> KnowledgeError {
    let code = if error_value.kind() == std::io::ErrorKind::Unsupported {
        "knowledge-permissions-unsupported"
    } else if error_value.kind() == std::io::ErrorKind::AlreadyExists {
        "knowledge-name-conflict"
    } else if error_value.to_string().contains("interrupted") {
        "knowledge-write-interrupted"
    } else {
        "knowledge-revision-conflict"
    };
    error(code, "Linux file changed or the operation is unavailable; retained backups and drafts may require recovery")
}

pub(super) fn parent(path: &Path) -> Result<(Directory, std::ffi::OsString), KnowledgeError> {
    let directory = path
        .parent()
        .ok_or_else(|| failure(crate::linux_fs::conflict()))?;
    let name = path
        .file_name()
        .ok_or_else(|| failure(crate::linux_fs::conflict()))?
        .to_owned();
    Ok((Directory::open(directory).map_err(failure)?, name))
}

pub(super) fn atomic_write(
    path: &Path,
    bytes: &[u8],
    replace: bool,
    fail: bool,
) -> Result<(), KnowledgeError> {
    let (dir, name) = parent(path)?;
    let current = dir
        .read(&name, false, crate::linux_file_store::MAX_RECORD_BYTES)
        .map_err(failure)?;
    if !replace && current.is_some() {
        return Err(error(
            "knowledge-name-conflict",
            "Destination already exists",
        ));
    }
    crate::linux_file_store::write(&dir, &name, current.as_ref(), bytes, false, fail, false)
        .map(|_| ())
        .map_err(failure)
}

pub(super) fn move_new(source: &Path, destination: &Path) -> Result<(), KnowledgeError> {
    let (from, name) = parent(source)?;
    let (to, next) = parent(destination)?;
    let opened = from.open_file(&name, false).map_err(failure)?;
    from.verify_named(&name, &opened).map_err(failure)?;
    from.rename_new(&name, &to, &next).map_err(failure)?;
    to.verify_named(&next, &opened).map_err(failure)
}

pub(super) fn open(path: &Path) -> Result<File, KnowledgeError> {
    let (dir, name) = parent(path)?;
    let file = dir.open_file(&name, false).map_err(failure)?;
    let metadata = file.metadata().map_err(failure)?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o200 == 0 {
        return Err(error(
            "knowledge-write-failed",
            "Note is not owned and writable by the current user",
        ));
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(error(
            "knowledge-revision-conflict",
            "Note is busy in another cooperating process",
        ));
    }
    dir.verify_named(&name, &file).map_err(failure)?;
    Ok(file)
}

pub(super) fn read(file: &mut File) -> Result<Vec<u8>, KnowledgeError> {
    let version = Version::of(file).map_err(failure)?;
    let limit = crate::linux_file_store::MAX_RECORD_BYTES;
    if file.metadata().map_err(failure)?.len() > limit as u64 {
        return Err(failure(crate::linux_fs::conflict()));
    }
    file.seek(SeekFrom::Start(0)).map_err(failure)?;
    let mut bytes = Vec::new();
    (&mut *file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() > limit || Version::of(file).map_err(failure)? != version {
        return Err(failure(crate::linux_fs::conflict()));
    }
    Ok(bytes)
}

pub(super) fn rename_open(file: &File, destination: &Path) -> Result<(), KnowledgeError> {
    let source =
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(failure)?;
    let (dir, name) = parent(&source)?;
    dir.verify_named(&name, file).map_err(failure)?;
    move_new(&source, destination)?;
    let (to, next) = parent(destination)?;
    to.verify_named(&next, file).map_err(failure)
}

pub(super) fn delete_open(file: &File) -> Result<(), KnowledgeError> {
    let source =
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(failure)?;
    let (dir, name) = parent(&source)?;
    dir.verify_named(&name, file).map_err(failure)?;
    let nonce = format!("{:032x}", rand::random::<u128>());
    let mut readable = file.try_clone().map_err(failure)?;
    let original = read(&mut readable)?;
    dir.create(OsStr::new(&format!(".lrk-{nonce}.backup")), &original)
        .map_err(failure)?;
    let receipt = serde_json::to_vec(&serde_json::json!({"kind":"linux-delete-attempt",
        "target":name.to_str().ok_or_else(|| failure(crate::linux_fs::conflict()))?,
        "sha256":crate::linux_file_store::digest(&original)}))
    .map_err(|_| failure(crate::linux_fs::conflict()))?;
    dir.create(
        OsStr::new(&format!(".lrk-{nonce}.delete-receipt")),
        &receipt,
    )
    .map_err(failure)?;
    let backup = format!(".lrk-{nonce}.deleted");
    dir.rename_new(&name, &dir, OsStr::new(&backup))
        .map_err(failure)?;
    dir.verify_named(OsStr::new(&backup), file)
        .map_err(failure)?;
    let moved = dir
        .read(
            OsStr::new(&backup),
            false,
            crate::linux_file_store::MAX_RECORD_BYTES,
        )
        .map_err(failure)?
        .ok_or_else(|| failure(crate::linux_fs::conflict()))?;
    if moved.bytes != original {
        let _ = dir.rename_new(OsStr::new(&backup), &dir, &name);
        return Err(failure(crate::linux_fs::conflict()));
    }
    Ok(())
}

pub(super) fn recover(root: &Path) -> Result<(), KnowledgeError> {
    let mut directories = vec![root.to_owned()];
    let mut count = 0;
    while let Some(path) = directories.pop() {
        count += 1;
        if count > 100_000 {
            return Err(failure(crate::linux_fs::conflict()));
        }
        let dir = Directory::open(&path).map_err(failure)?;
        let mut pending = false;
        for entry in
            std::fs::read_dir(format!("/proc/self/fd/{}", dir.file.as_raw_fd())).map_err(failure)?
        {
            let entry = entry.map_err(failure)?;
            let kind = entry.file_type().map_err(failure)?;
            if kind.is_dir() {
                directories.push(path.join(entry.file_name()));
            }
            if entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(".lrk-") && n.ends_with(".journal"))
            {
                pending = true;
            }
        }
        if pending {
            crate::linux_file_store::recover(&dir, false).map_err(failure)?;
        }
        dir.verify().map_err(failure)?;
    }
    Ok(())
}
