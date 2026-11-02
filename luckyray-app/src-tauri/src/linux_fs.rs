//! Descriptor-relative Linux files. Checks detect replacement; they do not
//! prevent another process running as the same user from changing files.
use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

pub(crate) fn conflict() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "linux-file-changed-or-unsafe")
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

pub(crate) fn owned_fd(fd: i32) -> io::Result<File> {
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else if fd < 3 {
        let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        if copy < 0 {
            Err(error)
        } else {
            Ok(unsafe { File::from_raw_fd(copy) })
        }
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

/// A retained, named instance of this running executable. Environment strings
/// and copied/unrelated ELFs cannot manufacture this kernel object identity.
pub(crate) struct RunningExecutable {
    directory: Directory,
    file: File,
    name: std::ffi::OsString,
    path: PathBuf,
    version: Version,
}

impl RunningExecutable {
    pub(crate) fn acquire(path: &Path) -> io::Result<Self> {
        let directory = Directory::trusted(path.parent().ok_or_else(conflict)?)?;
        let name = path.file_name().ok_or_else(conflict)?.to_owned();
        let file = directory.open_file(&name, false)?;
        no_attributes(&file)?;
        let metadata = file.metadata()?;
        let running = std::fs::metadata("/proc/self/exe")?;
        if metadata.mode() & 0o7022 != 0 || metadata.mode() & 0o111 == 0
            || ![0, unsafe { libc::geteuid() }].contains(&metadata.uid())
            || (metadata.dev(), metadata.ino()) != (running.dev(), running.ino()) { return Err(conflict()); }
        let version = Version::of(&file)?;
        let lease = Self { directory, file, name, path: path.to_owned(), version };
        lease.revalidate()?;
        Ok(lease)
    }

    pub(crate) fn path(&self) -> &Path { &self.path }

    pub(crate) fn revalidate(&self) -> io::Result<()> {
        no_attributes(&self.file)?;
        if Version::of(&self.file)? != self.version { return Err(conflict()); }
        self.directory.verify_named(&self.name, &self.file)?;
        if Version::of(&self.file)? != self.version { return Err(conflict()); }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Version {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    length: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl Version {
    pub(crate) fn of(file: &File) -> io::Result<Self> {
        let m = file.metadata()?;
        if !m.is_file() || m.nlink() != 1 {
            return Err(conflict());
        }
        Ok(Self {
            device: m.dev(),
            inode: m.ino(),
            length: m.len(),
            modified: (m.mtime(), m.mtime_nsec()),
            changed: (m.ctime(), m.ctime_nsec()),
        })
    }
    pub(crate) fn same_object(&self, other: &Self) -> bool {
        self.device == other.device && self.inode == other.inode
    }
}

pub(crate) struct Snapshot {
    pub(crate) file: File,
    pub(crate) version: Version,
    pub(crate) bytes: Vec<u8>,
}

/// Ordinary POSIX ownership/mode only. Files carrying ACLs, labels or other
/// xattrs are refused rather than silently losing an access restriction.
pub(crate) struct Permissions {
    mode: u32,
    gid: u32,
}

fn attributes_unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "linux-file-attributes-unsupported",
    )
}

pub(crate) fn no_attributes(file: &File) -> io::Result<()> {
    let count = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0) };
    if count != 0 {
        return Err(attributes_unsupported());
    }
    Ok(())
}

pub(crate) fn no_default_acl(directory: &File) -> io::Result<()> {
    let count = unsafe {
        libc::fgetxattr(
            directory.as_raw_fd(),
            c"system.posix_acl_default".as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    if count < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA) {
        return Ok(());
    }
    Err(attributes_unsupported())
}

pub(crate) fn private_file_metadata(file: &File) -> io::Result<()> {
    Version::of(file)?;
    let m = file.metadata()?;
    if m.uid() != unsafe { libc::geteuid() } || m.gid() != unsafe { libc::getegid() }
        || m.mode() & 0o7777 != 0o600 { return Err(conflict()); }
    no_attributes(file)
}

impl Permissions {
    pub(crate) fn capture(file: &File) -> io::Result<Self> {
        no_attributes(file)?;
        let m = file.metadata()?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o7000 != 0 {
            return Err(attributes_unsupported());
        }
        Ok(Self {
            mode: m.mode() & 0o777,
            gid: m.gid(),
        })
    }
    pub(crate) fn apply(&self, file: &File) -> io::Result<()> {
        no_attributes(file)?;
        if file.metadata()?.gid() != self.gid
            && unsafe { libc::fchown(file.as_raw_fd(), !0 as libc::uid_t, self.gid) } != 0
        {
            return Err(attributes_unsupported());
        }
        if unsafe { libc::fchmod(file.as_raw_fd(), self.mode as libc::mode_t) } != 0 {
            return Err(attributes_unsupported());
        }
        let m = file.metadata()?;
        if m.mode() & 0o777 != self.mode || m.gid() != self.gid {
            return Err(attributes_unsupported());
        }
        no_attributes(file)?;
        file.sync_all()
    }
    pub(crate) fn matches(&self, file: &File) -> io::Result<()> {
        let current = Self::capture(file)?;
        if current.mode != self.mode || current.gid != self.gid {
            return Err(attributes_unsupported());
        }
        Ok(())
    }
}

pub(crate) struct Directory {
    pub(crate) file: File,
    pub(crate) path: PathBuf,
    identity: (u64, u64),
    policy: DirectoryPolicy,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DirectoryPolicy { Read, Trusted, Owned, Private }

impl Directory {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        Self::walk(path, false, DirectoryPolicy::Read)
    }

    pub(crate) fn private(path: &Path, create: bool) -> io::Result<Self> {
        Self::walk(path, create, DirectoryPolicy::Private)
    }

    /// Public per-user records may live in a 0755 configuration directory.
    /// They still require a user-owned leaf, safe ancestors and no links/ACLs.
    pub(crate) fn owned(path: &Path, create: bool) -> io::Result<Self> {
        Self::walk(path, create, DirectoryPolicy::Owned)
    }

    pub(crate) fn trusted(path: &Path) -> io::Result<Self> {
        Self::walk(path, false, DirectoryPolicy::Trusted)
    }

    fn walk(path: &Path, create: bool, policy: DirectoryPolicy) -> io::Result<Self> {
        let scoped = policy != DirectoryPolicy::Read;
        if !path.is_absolute() {
            return Err(conflict());
        }
        let mut file = owned_fd(unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        })?;
        for part in path.components() {
            let name = match part {
                Component::RootDir => continue,
                Component::Normal(name) => component(name)?,
                _ => return Err(conflict()),
            };
            let mut fd = unsafe {
                libc::openat(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 && create && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
                if scoped { no_default_acl(&file)?; }
                if unsafe { libc::mkdirat(file.as_raw_fd(), name.as_ptr(), 0o700) } != 0
                    && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(io::Error::last_os_error());
                }
                fd = unsafe {
                    libc::openat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
            }
            file = owned_fd(fd)?;
            if scoped {
                let m = file.metadata()?;
                let uid = unsafe { libc::geteuid() };
                // Root-owned sticky /tmp is usable for isolated test profiles.
                if (m.uid() != uid && m.uid() != 0)
                    || (m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0))
                {
                    return Err(conflict());
                }
            }
        }
        let m = file.metadata()?;
        if matches!(policy, DirectoryPolicy::Owned | DirectoryPolicy::Private)
            && (m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o7022 != 0) {
            return Err(conflict());
        }
        if policy == DirectoryPolicy::Private && m.mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "linux-private-directory-permissions",
            ));
        }
        if scoped {
            no_attributes(&file)?;
        }
        Ok(Self {
            file,
            path: path.into(),
            identity: (m.dev(), m.ino()),
            policy,
        })
    }

    pub(crate) fn verify(&self) -> io::Result<()> {
        let current = Self::walk(&self.path, false, self.policy)?;
        if current.identity != self.identity {
            return Err(conflict());
        }
        Ok(())
    }

    pub(crate) fn try_clone(&self) -> io::Result<Self> {
        self.verify()?;
        Ok(Self { file: self.file.try_clone()?, path: self.path.clone(), identity: self.identity, policy: self.policy })
    }

    /// Owned child reached through this held descriptor; never a path-based mkdir.
    pub(crate) fn child_owned(&self, name: &OsStr, create: bool, private: bool) -> io::Result<Self> {
        if !matches!(self.policy, DirectoryPolicy::Owned | DirectoryPolicy::Private) { return Err(conflict()); }
        self.verify()?;
        no_attributes(&self.file)?;
        no_default_acl(&self.file)?;
        let component = component(name)?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut fd = unsafe { libc::openat(self.file.as_raw_fd(), component.as_ptr(), flags) };
        if fd < 0 && create && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            if unsafe { libc::mkdirat(self.file.as_raw_fd(), component.as_ptr(), 0o700) } != 0
                && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err(io::Error::last_os_error());
            }
            self.file.sync_all()?;
            fd = unsafe { libc::openat(self.file.as_raw_fd(), component.as_ptr(), flags) };
        }
        let file = owned_fd(fd)?;
        let m = file.metadata()?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o7022 != 0
            || (private && m.mode() & 0o077 != 0) { return Err(conflict()); }
        no_attributes(&file)?;
        no_default_acl(&file)?;
        let child = Self { file, path: self.path.join(name), identity: (m.dev(), m.ino()),
            policy: if private { DirectoryPolicy::Private } else { DirectoryPolicy::Owned } };
        self.verify()?;
        child.verify()?;
        Ok(child)
    }

    /// Check inherited access metadata before writing any private payload bytes.
    pub(crate) fn create_private(&self, name: &OsStr, bytes: &[u8]) -> io::Result<File> {
        if !matches!(self.policy, DirectoryPolicy::Owned | DirectoryPolicy::Private) { return Err(conflict()); }
        self.verify()?;
        no_attributes(&self.file)?;
        no_default_acl(&self.file)?;
        let component = component(name)?;
        let mut file = owned_fd(unsafe { libc::openat(self.file.as_raw_fd(), component.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) })?;
        private_file_metadata(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        private_file_metadata(&file)?;
        self.verify_named(name, &file)?;
        self.file.sync_all()?;
        Ok(file)
    }

    pub(crate) fn open_file(&self, name: &OsStr, private: bool) -> io::Result<File> {
        self.verify()?;
        let name = component(name)?;
        let file = owned_fd(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        })?;
        Version::of(&file)?;
        let m = file.metadata()?;
        if private && (m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0) {
            return Err(conflict());
        }
        if private {
            no_attributes(&file)?;
        }
        Ok(file)
    }

    pub(crate) fn read(
        &self,
        name: &OsStr,
        private: bool,
        limit: usize,
    ) -> io::Result<Option<Snapshot>> {
        let mut file = match self.open_file(name, private) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let version = Version::of(&file)?;
        if version.length > limit as u64 {
            return Err(conflict());
        }
        let mut bytes = Vec::new();
        (&mut file).take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit || Version::of(&file)? != version {
            return Err(conflict());
        }
        self.verify_named(name, &file)?;
        Ok(Some(Snapshot {
            file,
            version,
            bytes,
        }))
    }

    pub(crate) fn verify_named(&self, name: &OsStr, file: &File) -> io::Result<()> {
        let current = self.open_file(name, false)?;
        if !Version::of(file)?.same_object(&Version::of(&current)?) {
            return Err(conflict());
        }
        self.verify()
    }

    pub(crate) fn create(&self, name: &OsStr, bytes: &[u8]) -> io::Result<File> {
        self.verify()?;
        let name_c = component(name)?;
        let mut file = owned_fd(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name_c.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        })?;
        file.write_all(bytes)?;
        file.sync_all()?;
        self.verify_named(name, &file)?;
        self.file.sync_all()?;
        Ok(file)
    }

    pub(crate) fn rename_new(&self, from: &OsStr, other: &Self, to: &OsStr) -> io::Result<()> {
        self.verify()?;
        other.verify()?;
        let from = component(from)?;
        let to = component(to)?;
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                self.file.as_raw_fd(),
                from.as_ptr(),
                other.file.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        self.file.sync_all()?;
        other.file.sync_all()?;
        self.verify()?;
        other.verify()
    }

    pub(crate) fn lock(&self) -> io::Result<File> {
        let name = OsStr::new(".luckyray-write.lock");
        let file = match self.create(name, b"") {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => self.open_file(name, true)?,
            Err(e) => return Err(e),
        };
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, "linux-file-busy"));
        }
        self.verify_named(name, &file)?;
        Ok(file)
    }
}
