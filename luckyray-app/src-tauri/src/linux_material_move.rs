//! Linux move of a material's real file (素材详情 → 移动或重命名文件).
//!
//! One rule, the same as Windows v1.9.9 within one volume: the held source
//! object is renamed with `renameat2(RENAME_NOREPLACE)` between two parent
//! directories reached from `/` without following any link, and both parents
//! are proved again around the rename. A different filesystem is refused before
//! anything moves (`attachment-move-cross-device`); there is no copy fallback.
//! Nothing here unlinks, truncates or replaces a name: the only inverse is the
//! same no-replace rename in the other direction.
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
/// rename itself changes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Object {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
}

fn object_of(file: &File) -> io::Result<Object> {
    let m = file.metadata()?;
    if !m.is_file() {
        return Err(conflict());
    }
    Ok(Object { device: m.dev(), inode: m.ino(), mode: m.mode(), uid: m.uid(), gid: m.gid() })
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
    })
}

fn leaf(path: &Path) -> io::Result<(Directory, CString)> {
    let parent = path.parent().ok_or_else(conflict)?;
    let name = path.file_name().ok_or_else(conflict)?;
    Ok((Directory::open(parent)?, component(name)?))
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
        return Err(if error.raw_os_error() == Some(libc::EXDEV) { cross_device() } else { error });
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
