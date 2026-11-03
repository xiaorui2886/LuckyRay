//! Linux move of a material's real file (素材详情 → 移动或重命名文件).
//!
//! Two rules, both as Windows v1.9.9: within one filesystem the held source
//! object is renamed with `renameat2(RENAME_NOREPLACE)` between two parent
//! directories reached from `/` without following any link, and both parents
//! are proved again around the rename. Across filesystems (the kernel's
//! `EXDEV`, which Windows reports as `ERROR_NOT_SAME_DEVICE`) the same object is
//! copied into the destination directory, verified against the caller's digest,
//! published without replacing anything, and only then is the source unlinked
//! (`PreparedCopy`). The rename path still never unlinks, truncates or replaces
//! a name: its only inverse is the same no-replace rename in the other
//! direction.
use crate::linux_fs::{conflict, owned_fd, Directory};
use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};

/// Message of the refusal for a destination on another filesystem.
pub(crate) const CROSS_DEVICE: &str = "attachment-move-cross-device";

pub(crate) fn cross_device() -> io::Error {
    io::Error::new(io::ErrorKind::CrossesDevices, CROSS_DEVICE)
}

/// True for the pre-rename refusal and for a kernel `EXDEV` (for example two
/// bind mounts of one filesystem).
pub(crate) fn is_cross_device(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EXDEV) || error.kind() == io::ErrorKind::CrossesDevices
}

/// The object a name must keep denoting. ctime is deliberately absent: the
/// rename itself changes it. `links` is compared but not required to be 1:
/// Windows v1.9.9 moves a material that still has a second hard link, and a
/// rename only moves one name. A link count that changes *during* the move is
/// still outside interference the proof can accept, so it is part of the
/// identity compared around the rename. (`nlink == 1` stays mandatory for the
/// delete quarantine, which removes the last name.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Object {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    links: u64,
}

fn object_of(file: &File) -> io::Result<Object> {
    let m = file.metadata()?;
    if !m.is_file() {
        return Err(conflict());
    }
    Ok(Object {
        device: m.dev(),
        inode: m.ino(),
        mode: m.mode(),
        uid: m.uid(),
        gid: m.gid(),
        links: m.nlink(),
    })
}

fn component(name: &OsStr) -> io::Result<CString> {
    let path = Path::new(name);
    if !matches!(path.components().next(), Some(Component::Normal(_)))
        || path.components().count() != 1
    {
        return Err(conflict());
    }
    CString::new(name.as_bytes()).map_err(|_| conflict())
}

/// What `name` denotes in the held directory, without following a link.
fn named(directory: &Directory, name: &CString) -> io::Result<Object> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(directory.file.as_raw_fd(), name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW)
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(conflict());
    }
    Ok(Object {
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
        mode: stat.st_mode as u32,
        uid: stat.st_uid as u32,
        gid: stat.st_gid as u32,
        links: stat.st_nlink as u64,
    })
}

fn leaf(path: &Path) -> io::Result<(Directory, CString)> {
    let parent = path.parent().ok_or_else(conflict)?;
    let name = path.file_name().ok_or_else(conflict)?;
    Ok((Directory::open(parent)?, component(name)?))
}

/// A kernel or filesystem without `RENAME_NOREPLACE` must be refused as a
/// capability failure, not reported as an ordinary rename error. Nothing has
/// moved in that case and there is no copy fallback (T02 §5.6.2/§5.6.4).
pub(crate) fn rename_capability_error(error: io::Error) -> io::Error {
    if matches!(error.raw_os_error(), Some(libc::ENOSYS) | Some(libc::EINVAL))
        || error.kind() == io::ErrorKind::Unsupported
    {
        io::Error::new(io::ErrorKind::Unsupported, "linux-renameat2-unsupported")
    } else {
        error
    }
}

fn rename_no_replace(
    from: &Directory,
    from_name: &CString,
    to: &Directory,
    to_name: &CString,
) -> io::Result<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            from.file.as_raw_fd(),
            from_name.as_ptr(),
            to.file.as_raw_fd(),
            to_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EXDEV) {
            return Err(cross_device());
        }
        return Err(rename_capability_error(error));
    }
    Ok(())
}

/// Both parent directories of one move, opened without following a link at any
/// level. Holding them keeps the checked inodes alive; the identity re-check
/// around the rename is what detects a replaced ancestor.
pub(crate) fn hold_parents(source: &Path, destination: &Path) -> io::Result<Vec<File>> {
    let mut held = Vec::new();
    for path in [source, destination] {
        let parent = path.parent().ok_or_else(conflict)?;
        held.push(Directory::open(parent)?.file);
    }
    Ok(held)
}

/// A move whose source, parents and vacancy were proved; nothing has moved yet.
pub(crate) struct PreparedMove<'a> {
    source: &'a File,
    object: Object,
    from: Directory,
    from_name: CString,
    to: Directory,
    to_name: CString,
}

impl<'a> PreparedMove<'a> {
    pub(crate) fn prepare(source: &'a File, from: &Path, to: &Path) -> io::Result<Self> {
        let object = object_of(source)?;
        let (from_dir, from_name) = leaf(from)?;
        let (to_dir, to_name) = leaf(to)?;
        if named(&from_dir, &from_name)? != object {
            return Err(conflict());
        }
        // Another filesystem is refused here, before any rename and without a
        // copy: the source keeps its name, bytes and inode.
        if to_dir.file.metadata()?.dev() != object.device {
            return Err(cross_device());
        }
        match named(&to_dir, &to_name) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(_) => return Err(io::Error::from(io::ErrorKind::AlreadyExists)),
            Err(error) => return Err(error),
        }
        Ok(Self { source, object, from: from_dir, from_name, to: to_dir, to_name })
    }

    /// Rename exactly the held object, then prove where it landed. If that proof
    /// fails, the same object is renamed back into its still-vacant name.
    pub(crate) fn commit(self) -> io::Result<()> {
        self.from.verify()?;
        self.to.verify()?;
        if object_of(self.source)? != self.object
            || named(&self.from, &self.from_name)? != self.object
        {
            return Err(conflict());
        }
        rename_no_replace(&self.from, &self.from_name, &self.to, &self.to_name)?;
        match self.settle() {
            Ok(()) => Ok(()),
            Err(failure) => Err(self.put_back(failure)),
        }
    }

    fn settle(&self) -> io::Result<()> {
        self.to.file.sync_all()?;
        self.from.file.sync_all()?;
        self.to.verify()?;
        self.from.verify()?;
        if named(&self.to, &self.to_name)? != self.object {
            return Err(conflict());
        }
        Ok(())
    }

    fn put_back(&self, failure: io::Error) -> io::Error {
        let back = (|| {
            let current = named(&self.to, &self.to_name)?;
            if (current.device, current.inode) != (self.object.device, self.object.inode) {
                return Err(conflict());
            }
            rename_no_replace(&self.to, &self.to_name, &self.from, &self.from_name)?;
            self.from.file.sync_all()?;
            self.to.file.sync_all()
        })();
        match back {
            Ok(()) => failure,
            Err(error) => io::Error::new(
                failure.kind(),
                format!("移动后无法确认目标目录，且未能移回原位置；文件保留在目标位置，未删除任何文件（{failure}；{error}）"),
            ),
        }
    }
}

/// Move the held, already-verified source object to `destination`.
pub(crate) fn move_held_no_replace(source: &File, from: &Path, destination: &Path) -> io::Result<()> {
    PreparedMove::prepare(source, from, destination)?.commit()
}

/// Source identity with the fields a copy must re-check before unlinking it:
/// a rename cannot change them, but a copy takes time and another writer can.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    device: u64,
    inode: u64,
    size: u64,
    mtime: (i64, i64),
}

fn stamp_of(file: &File) -> io::Result<Stamp> {
    let m = file.metadata()?;
    Ok(Stamp { device: m.dev(), inode: m.ino(), size: m.len(), mtime: (m.mtime(), m.mtime_nsec()) })
}

fn stamp_at(directory: &Directory, name: &CString) -> io::Result<Stamp> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(directory.file.as_raw_fd(), name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW)
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(conflict());
    }
    Ok(Stamp {
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
        size: stat.st_size as u64,
        mtime: (stat.st_mtime, stat.st_mtime_nsec),
    })
}

/// Message of the honest partial result: the destination is published and the
/// original is still there. Never reported as a successful move.
pub(crate) const SOURCE_KEPT: &str = "attachment-move-source-kept";

/// One temporary name per attempt, in the destination directory, recognisable
/// by the residue scan (`.lrk-move-<pid>-<nanos>.tmp`).
fn temporary_name() -> CString {
    CString::new(format!(
        ".lrk-move-{}-{}.tmp",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
    .unwrap_or_else(|_| CString::new(".lrk-move-0-0.tmp").expect("fixed name"))
}

/// A cross-filesystem move whose source, parents and vacancy were proved and
/// whose invisible temporary already exists in the destination directory.
///
/// Same order as Windows v1.9.9 `move_owned_handle_no_replace` on
/// ERROR_NOT_SAME_DEVICE: create the new target, copy from the held source,
/// flush it, publish without replacing, and only then handle the source.
pub(crate) struct PreparedCopy<'a> {
    source: &'a File,
    stamp: Stamp,
    from: Directory,
    from_name: CString,
    to: Directory,
    to_name: CString,
    temporary: CString,
    staged: File,
}

impl<'a> PreparedCopy<'a> {
    pub(crate) fn prepare(source: &'a File, from: &Path, to: &Path) -> io::Result<Self> {
        let stamp = stamp_of(source)?;
        let (from_dir, from_name) = leaf(from)?;
        let (to_dir, to_name) = leaf(to)?;
        if stamp_at(&from_dir, &from_name)? != stamp {
            return Err(conflict());
        }
        match named(&to_dir, &to_name) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(_) => return Err(io::Error::from(io::ErrorKind::AlreadyExists)),
            Err(error) => return Err(error),
        }
        let temporary = temporary_name();
        let staged = to_dir.create(OsStr::from_bytes(temporary.as_bytes()), b"")?;
        Ok(Self { source, stamp, from: from_dir, from_name, to: to_dir, to_name, temporary, staged })
    }

    /// Copy, verify, publish, then unlink the source it came from.
    pub(crate) fn commit(self, expected_sha256: &str) -> io::Result<()> {
        // Borrows, so the directory stays open for the cleanup below: the name
        // removed is exactly the temporary this attempt created.
        let directory = self.to.file.as_raw_fd();
        let temporary = self.temporary.clone();
        let result = self.run(expected_sha256);
        if result.is_err() {
            // Only the name this attempt created is removed. Before the publish
            // the source was never touched; after it, an error means the source
            // is still there and both copies are complete.
            let _ = unsafe { libc::unlinkat(directory, temporary.as_ptr(), 0) };
        }
        result
    }

    fn run(&self, expected_sha256: &str) -> io::Result<()> {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Seek, SeekFrom, Write};

        let mut reader = self.source;
        reader.seek(SeekFrom::Start(0))?;
        let mut writer = &self.staged;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            writer.write_all(&buffer[..read])?;
            total += read as u64;
        }
        self.staged.sync_all()?;
        if total != self.stamp.size || format!("{:x}", hasher.finalize()) != expected_sha256 {
            return Err(io::Error::new(io::ErrorKind::Other, "attachment-version-changed"));
        }
        // Publish without replacing, then make both directory entries durable
        // before the source may go -- the same guarantee the Windows
        // WRITE_THROUGH move gives.
        self.to.file.sync_all()?;
        rename_no_replace(&self.to, &self.temporary, &self.to, &self.to_name)?;
        self.to.file.sync_all()?;
        named(&self.to, &self.to_name)?;
        // Only now may the source go, and only if it is still the object copied.
        if stamp_at(&self.from, &self.from_name)? != self.stamp || stamp_of(self.source)? != self.stamp {
            return Err(io::Error::new(io::ErrorKind::Other, "source-changed"));
        }
        if unsafe { libc::unlinkat(self.from.file.as_raw_fd(), self.from_name.as_ptr(), 0) } != 0 {
            return Err(io::Error::new(io::ErrorKind::Other, SOURCE_KEPT));
        }
        self.from.file.sync_all()?;
        Ok(())
    }
}

/// Move the held source across filesystems by copying it into the destination
/// directory and unlinking it only after the published copy is durable.
/// `expected_sha256` is the digest the caller already verified on the source.
pub(crate) fn copy_held_no_replace(
    source: &File,
    from: &Path,
    destination: &Path,
    expected_sha256: &str,
) -> io::Result<()> {
    PreparedCopy::prepare(source, from, destination)?.commit(expected_sha256)
}

/// Path form used by the catalog's recovery (`renamed_paths`): the leaf is
/// opened without following a link, then moved exactly like a held source.
pub(crate) fn move_path_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let (directory, name) = leaf(source)?;
    let file = owned_fd(unsafe {
        libc::openat(
            directory.file.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    })?;
    move_held_no_replace(&file, source, destination)
}
