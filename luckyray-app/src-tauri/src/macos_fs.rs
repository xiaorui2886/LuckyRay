//! Descriptor-relative macOS file operations. Symlinks and path traversal are
//! rejected. Revision checks detect concurrent edits; they are not mandatory
//! locks against other programs running as the same user.
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::{File, Metadata};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

pub(crate) const MAX_RECORD: u64 = 32 * 1024 * 1024;
// Attachments have a separate product limit. Credentials and journals retain
// MAX_RECORD; accepting a larger blob never changes their read/write policy.
pub(crate) const MAX_ATTACHMENT_BLOB: u64 = 64 * 1024 * 1024;

fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
fn name(value: &OsStr) -> io::Result<CString> {
    let mut parts = Path::new(value).components();
    if !matches!((parts.next(), parts.next()), (Some(Component::Normal(p)), None) if p == value) {
        return Err(invalid());
    }
    CString::new(value.as_bytes()).map_err(|_| invalid())
}
fn opened(fd: i32) -> io::Result<File> {
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Version {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) hash: String,
    mode: u32,
    size: u64,
    modified: (i64, i64),
}
impl Version {
    pub(crate) fn matches_metadata(&self, metadata: &Metadata) -> bool {
        self.device == metadata.dev()
            && self.inode == metadata.ino()
            && self.size == metadata.len()
            && self.mode == metadata.mode()
            && self.modified == (metadata.mtime(), metadata.mtime_nsec())
    }
    pub(crate) fn permissions(&self) -> u32 {
        self.mode & 0o777
    }
    fn of(meta: &Metadata, bytes: &[u8]) -> Self {
        Self {
            device: meta.dev(),
            inode: meta.ino(),
            hash: digest(bytes),
            mode: meta.mode(),
            size: meta.len(),
            modified: (meta.mtime(), meta.mtime_nsec()),
        }
    }
}

pub(crate) struct EntryInfo {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) mode: u32,
}

pub(crate) struct Directory {
    file: File,
    path: PathBuf,
    private: bool,
    trusted: bool,
    owned: bool,
}
impl Directory {
    pub(crate) fn try_clone(&self) -> io::Result<Self> {
        self.current()?;
        Ok(Self { file: self.file.try_clone()?, path: self.path.clone(), private: self.private,
            trusted: self.trusted, owned: self.owned })
    }
    pub(crate) fn identity_file(&self) -> io::Result<File> {
        self.file.try_clone()
    }
    pub(crate) fn open(path: &Path, create: bool, private: bool) -> io::Result<Self> {
        Self::open_checked(path, create, private, false, false)
    }

    /// Executable parents follow the ordinary owner/write checks, with one
    /// object-bound exception for the system's root:admin Applications directory.
    /// Private credential traversal never uses that exception.
    pub(crate) fn open_trusted(path: &Path) -> io::Result<Self> {
        Self::open_checked(path, false, false, true, false)
    }

    /// Non-secret user configuration may be readable by other users. Existing
    /// directory modes are preserved; credentials keep their private policy.
    pub(crate) fn open_owned(path: &Path, create: bool) -> io::Result<Self> {
        Self::open_checked(path, create, false, false, true)
    }

    fn open_checked(path: &Path, create: bool, private: bool, trusted: bool, owned: bool) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(invalid());
        }
        let raw = path.as_os_str().as_bytes();
        if raw.contains(&0)
            || raw.windows(2).any(|v| v == b"//")
            || raw.split(|&b| b == b'/').any(|p| p == b"." || p == b"..")
        {
            return Err(invalid());
        }
        let mut dir = opened(unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        })?;
        for part in path.components() {
            let Component::Normal(part) = part else {
                continue;
            };
            if trusted && !private && !owned {
                validate_executable_ancestor(&dir)?;
            } else if private || owned {
                validate_ancestor(&dir)?;
            }
            let part = name(part)?;
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
            let mut next = unsafe { libc::openat(dir.as_raw_fd(), part.as_ptr(), flags) };
            if next < 0 && create && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
                let result = unsafe { libc::mkdirat(dir.as_raw_fd(), part.as_ptr(), 0o700) };
                if result != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(io::Error::last_os_error());
                }
                next = unsafe { libc::openat(dir.as_raw_fd(), part.as_ptr(), flags) };
            }
            dir = opened(next)?;
        }
        if !dir.metadata()?.is_dir() {
            return Err(invalid());
        }
        if trusted {
            if private || owned {
                validate_ancestor(&dir)?;
            } else {
                validate_executable_ancestor(&dir)?;
            }
        }
        if owned {
            let meta = dir.metadata()?;
            if meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o022 != 0 || meta.mode() & 0o700 != 0o700
            {
                return Err(invalid());
            }
            reject_allow_acl(&dir)?;
        }
        if private {
            let meta = dir.metadata()?;
            if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 {
                return Err(invalid());
            }
            reject_allow_acl(&dir)?;
            if create {
                dir.set_permissions(std::fs::Permissions::from_mode(0o700))?;
            }
            if dir.metadata()?.mode() & 0o077 != 0 {
                return Err(invalid());
            }
        }
        Ok(Self {
            file: dir,
            path: path.to_owned(),
            private,
            trusted,
            owned,
        })
    }

    pub(crate) fn current(&self) -> io::Result<()> {
        let current = Self::open_checked(&self.path, false, self.private, self.trusted, self.owned)?;
        let (a, b) = (self.file.metadata()?, current.file.metadata()?);
        if (a.dev(), a.ino()) != (b.dev(), b.ino()) {
            return Err(invalid());
        }
        Ok(())
    }

    /// Open/create only this immediate child through the retained parent.
    /// Unlike open(path, true, ...), this cannot recreate a missing vault root.
    /// Existing directory permissions are checked without changing them.
    pub(crate) fn child(&self, entry: &OsStr, create: bool) -> io::Result<Self> {
        self.current()?;
        let component = name(entry)?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        let mut fd = unsafe { libc::openat(self.file.as_raw_fd(), component.as_ptr(), flags) };
        if fd < 0 && create && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            if unsafe { libc::mkdirat(self.file.as_raw_fd(), component.as_ptr(), 0o700) } != 0
                && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
            {
                return Err(io::Error::last_os_error());
            }
            self.file.sync_all()?;
            fd = unsafe { libc::openat(self.file.as_raw_fd(), component.as_ptr(), flags) };
        }
        let child = Self {
            file: opened(fd)?,
            path: self.path.join(entry),
            private: self.private,
            trusted: self.trusted,
            owned: self.owned,
        };
        self.current()?;
        child.current()?;
        Ok(child)
    }

    pub(crate) fn open_regular(&self, entry: &OsStr) -> io::Result<File> {
        self.open_regular_with_access(entry, libc::O_RDONLY)
    }
    pub(crate) fn open_writable(&self, entry: &OsStr) -> io::Result<File> {
        self.open_regular_with_access(entry, libc::O_RDWR)
    }
    pub(crate) fn open_metadata(&self, entry: &OsStr) -> io::Result<File> {
        self.open_regular_with_access(entry, libc::O_EVTONLY)
    }

    /// Observe the named inode without opening its data stream. O_EVTONLY
    /// still requests read access on Darwin, so it cannot inspect a mode-000
    /// publication. This observation grants no authority to change that inode.
    pub(crate) fn entry_info(&self, entry: &OsStr) -> io::Result<EntryInfo> {
        self.current()?;
        let entry = name(entry)?;
        let mut meta: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(self.file.as_raw_fd(), entry.as_ptr(), &mut meta, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if meta.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(invalid());
        }
        self.current()?;
        Ok(EntryInfo { device: meta.st_dev as u64, inode: meta.st_ino, mode: meta.st_mode as u32 })
    }
    fn open_regular_with_access(&self, entry: &OsStr, access: i32) -> io::Result<File> {
        self.current()?;
        let entry = name(entry)?;
        let file = opened(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                entry.as_ptr(),
                access | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        })?;
        validate_file(&file, self.private)?;
        self.current()?;
        Ok(file)
    }

    pub(crate) fn read(&self, entry: &OsStr) -> io::Result<Option<(Vec<u8>, Version)>> {
        self.read_checked(entry, self.private, false, MAX_RECORD)
    }
    pub(crate) fn read_owned(&self, entry: &OsStr) -> io::Result<Option<(Vec<u8>, Version)>> {
        self.read_checked(entry, true, false, MAX_RECORD)
    }
    pub(crate) fn read_attachment(&self, entry: &OsStr) -> io::Result<Option<(Vec<u8>, Version)>> {
        if self.private || self.trusted || self.owned { return Err(invalid()); }
        self.read_checked(entry, self.private, false, MAX_ATTACHMENT_BLOB)
    }
    pub(crate) fn read_config(&self, entry: &OsStr) -> io::Result<Option<(Vec<u8>, Version)>> {
        if !self.owned {
            return Err(invalid());
        }
        self.read_checked(entry, false, true, MAX_RECORD)
    }
    fn read_checked(&self, entry: &OsStr, private: bool, config: bool, limit: u64) -> io::Result<Option<(Vec<u8>, Version)>> {
        self.current()?;
        let entry = name(entry)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                entry.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        let mut file = match opened(fd) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let before = file.metadata()?;
        validate_file(&file, private)?;
        if config {
            if before.uid() != unsafe { libc::geteuid() }
                || before.mode() & 0o022 != 0 || before.nlink() != 1
            {
                return Err(invalid());
            }
            reject_allow_acl(&file)?;
        }
        if before.len() > limit {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if bytes.len() as u64 > limit || changed(&before, &after) {
            return Err(invalid());
        }
        let version = Version::of(&after, &bytes);
        let probe = opened(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                entry.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        })?;
        if changed(&after, &probe.metadata()?) {
            return Err(invalid());
        }
        self.current()?;
        Ok(Some((bytes, version)))
    }

    pub(crate) fn create(&self, entry: &OsStr, bytes: &[u8]) -> io::Result<File> {
        self.create_bounded(entry, bytes, MAX_RECORD)
    }
    pub(crate) fn create_attachment(&self, entry: &OsStr, bytes: &[u8]) -> io::Result<File> {
        if self.private || self.trusted || self.owned { return Err(invalid()); }
        self.create_bounded(entry, bytes, MAX_ATTACHMENT_BLOB)
    }
    fn create_bounded(&self, entry: &OsStr, bytes: &[u8], limit: u64) -> io::Result<File> {
        self.current()?;
        if bytes.len() as u64 > limit {
            return Err(invalid());
        }
        let entry = name(entry)?;
        let mut file = opened(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                entry.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        })?;
        validate_file(&file, self.private)?;
        reject_allow_acl(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        self.file.sync_all()?;
        self.current()?;
        Ok(file)
    }

    pub(crate) fn rename(&self, from: &OsStr, to: &OsStr, exchange: bool) -> io::Result<()> {
        self.current()?;
        let (from, to) = (name(from)?, name(to)?);
        const RENAME_NOFOLLOW_ANY: u32 = 0x10;
        let flags = (if exchange {
            libc::RENAME_SWAP
        } else {
            libc::RENAME_EXCL
        }) | RENAME_NOFOLLOW_ANY;
        let result = unsafe {
            libc::renameatx_np(
                self.file.as_raw_fd(),
                from.as_ptr(),
                self.file.as_raw_fd(),
                to.as_ptr(),
                flags,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        self.file.sync_all()?;
        self.current()
    }

    pub(crate) fn remove(&self, entry: &OsStr, expected: &Version) -> io::Result<()> {
        let current = self.read(entry)?.ok_or_else(invalid)?;
        if &current.1 != expected {
            return Err(invalid());
        }
        let entry = name(entry)?;
        // unlinkat never follows a last-component symlink. Revision/identity
        // checks are optimistic; a same-user writer can still race cleanup.
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), entry.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        self.file.sync_all()
    }

    pub(crate) fn lock(&self, entry: &OsStr) -> io::Result<File> {
        self.current()?;
        let entry = name(entry)?;
        let file = opened(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                entry.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        })?;
        validate_file(&file, true)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let probe = opened(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                entry.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        })?;
        if changed(&file.metadata()?, &probe.metadata()?) {
            return Err(invalid());
        }
        self.current()?;
        Ok(file)
    }

    pub(crate) fn entries(&self) -> io::Result<Vec<OsString>> {
        self.current()?;
        let fd = unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(io::Error::last_os_error());
        }
        unsafe {
            libc::rewinddir(stream);
        }
        let mut names = Vec::new();
        let result = loop {
            unsafe {
                *libc::__error() = 0;
            }
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break if io::Error::last_os_error().raw_os_error() == Some(0) {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                };
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes != b"." && bytes != b".." {
                names.push(OsString::from_vec(bytes.to_vec()));
            }
            if names.len() > 100_000 {
                break Err(invalid());
            }
        };
        unsafe {
            libc::closedir(stream);
        }
        result?;
        self.current()?;
        Ok(names)
    }
}

fn changed(a: &Metadata, b: &Metadata) -> bool {
    (
        a.dev(),
        a.ino(),
        a.len(),
        a.mtime(),
        a.mtime_nsec(),
        a.ctime(),
        a.ctime_nsec(),
    ) != (
        b.dev(),
        b.ino(),
        b.len(),
        b.mtime(),
        b.mtime_nsec(),
        b.ctime(),
        b.ctime_nsec(),
    )
}
fn validate_file(file: &File, private: bool) -> io::Result<()> {
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(invalid());
    }
    if private {
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 || meta.nlink() != 1
        {
            return Err(invalid());
        }
        reject_allow_acl(file)?;
    }
    Ok(())
}
fn validate_ancestor(file: &File) -> io::Result<()> {
    let meta = file.metadata()?;
    let root_sticky = meta.uid() == 0 && meta.mode() & (libc::S_ISVTX as u32) != 0;
    if !meta.is_dir()
        || (meta.uid() != 0 && meta.uid() != unsafe { libc::geteuid() })
        || (meta.mode() & 0o022 != 0 && !root_sticky)
    {
        return Err(invalid());
    }
    reject_allow_acl(file)
}

fn administrator_gid() -> io::Result<libc::gid_t> {
    let mut record: libc::group = unsafe { std::mem::zeroed() };
    let mut found = std::ptr::null_mut();
    let mut storage = vec![0; 64 * 1024];
    let result = unsafe {
        libc::getgrnam_r(
            c"admin".as_ptr(),
            &mut record,
            storage.as_mut_ptr(),
            storage.len(),
            &mut found,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    if found.is_null()
        || record.gr_name.is_null()
        || unsafe { CStr::from_ptr(record.gr_name) }.to_bytes() != b"admin"
    {
        return Err(invalid());
    }
    Ok(record.gr_gid)
}

fn validate_executable_ancestor(file: &File) -> io::Result<()> {
    if validate_ancestor(file).is_ok() {
        return Ok(());
    }
    // Apple's files/hierarchy.osx provisions Applications as root:admin 0775.
    // Trust only that real root child, not arbitrary admin-writable directories
    // or a directory whose name happens to be Applications. Matching vnode
    // identity also handles the system Data-volume spelling of the same object.
    let before = file.metadata()?;
    if !before.is_dir() || before.uid() != 0 || before.mode() & 0o7777 != 0o775 {
        return Err(invalid());
    }
    let root = opened(unsafe {
        libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
    })?;
    let root_meta = root.metadata()?;
    if !root_meta.is_dir() || root_meta.uid() != 0 || root_meta.mode() & 0o022 != 0 {
        return Err(invalid());
    }
    reject_allow_acl(&root)?;
    let applications = opened(unsafe {
        libc::openat(
            root.as_raw_fd(), c"Applications".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    })?;
    let anchor = applications.metadata()?;
    let object = |meta: &Metadata| (meta.dev(), meta.ino(), meta.uid(), meta.gid(), meta.mode());
    if !system_applications_matches(object(&before), object(&anchor), administrator_gid()?)
    {
        return Err(invalid());
    }
    reject_allow_acl(file)?;
    reject_allow_acl(&applications)?;
    if changed(&before, &file.metadata()?) || changed(&anchor, &applications.metadata()?)
        || changed(&root_meta, &root.metadata()?)
    {
        return Err(invalid());
    }
    Ok(())
}

fn system_applications_matches(
    candidate: (u64, u64, u32, u32, u32),
    anchor: (u64, u64, u32, u32, u32),
    admin_gid: libc::gid_t,
) -> bool {
    candidate == anchor && candidate.2 == 0 && candidate.3 == admin_gid
        && candidate.4 & 0o7777 == 0o775
        && candidate.4 & libc::S_IFMT as u32 == libc::S_IFDIR as u32
}

// macOS extended ACLs can grant access beyond the mode bits. Deny entries do
// not broaden authority; any allow entry is rejected rather than erased.
pub(crate) fn require_empty_acl(file: &File) -> io::Result<()> {
    check_acl(file, false)
}

fn reject_allow_acl(file: &File) -> io::Result<()> {
    check_acl(file, true)
}

fn check_acl(file: &File, allow_deny_entries: bool) -> io::Result<()> {
    unsafe extern "C" {
        fn acl_get_fd_np(fd: i32, kind: i32) -> *mut libc::c_void;
        fn acl_get_entry(acl: *mut libc::c_void, entry: i32, out: *mut *mut libc::c_void) -> i32;
        fn acl_get_tag_type(entry: *mut libc::c_void, tag: *mut i32) -> i32;
        fn acl_free(acl: *mut libc::c_void) -> i32;
    }
    let before = file.metadata()?;
    unsafe {
        *libc::__error() = 0;
    }
    let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) };
    if acl.is_null() {
        return if io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            if changed(&before, &file.metadata()?) {
                Err(invalid())
            } else {
                Ok(())
            }
        } else {
            Err(io::Error::last_os_error())
        };
    }
    let mut entry = std::ptr::null_mut();
    let mut index = 0;
    let result = loop {
        let read = unsafe { acl_get_entry(acl, index, &mut entry) };
        if read != 0 {
            break if io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            };
        }
        let mut tag = 0;
        if !allow_deny_entries || unsafe { acl_get_tag_type(entry, &mut tag) } != 0 || tag != 2 {
            break Err(invalid());
        }
        index = -1;
    };
    unsafe {
        acl_free(acl);
    }
    result?;
    if changed(&before, &file.metadata()?) {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod registration_policy_tests {
    use super::*;

    #[test]
    fn macos_manifest_registration_system_applications_identity() {
        let directory = libc::S_IFDIR as u32;
        let anchor = (10, 20, 0, 80, directory | 0o775);
        assert!(system_applications_matches(anchor, anchor, 80));
        assert!(!system_applications_matches((11, 20, 0, 80, directory | 0o775), anchor, 80));
        assert!(!system_applications_matches((10, 21, 0, 80, directory | 0o775), anchor, 80));
        for candidate in [
            (10, 20, 501, 80, directory | 0o775),
            (10, 20, 0, 20, directory | 0o775),
            (10, 20, 0, 80, directory | 0o777),
            (10, 20, 0, 80, libc::S_IFREG as u32 | 0o775),
        ] {
            assert!(!system_applications_matches(candidate, anchor, 80));
            assert!(!system_applications_matches(candidate, candidate, 80));
        }
        assert!(!system_applications_matches(anchor, anchor, 20));
    }
}
