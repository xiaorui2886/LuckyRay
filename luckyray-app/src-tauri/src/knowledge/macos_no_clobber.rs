//! A Darwin no-clobber rename primitive for a future verified vault transaction.
//!
//! The caller must already hold and validate both directory handles against its
//! vault grant. This primitive does not provide exclusive-writer protection,
//! validate a document revision, or prove a directory is still within the grant;
//! it must not be used as a complete note or attachment transaction by itself.

use std::ffi::OsStr;
use std::path::{Component, Path};

fn is_single_name(name: &OsStr) -> bool {
    if name.as_encoded_bytes().contains(&0) {
        return false;
    }
    let mut parts = Path::new(name).components();
    matches!((parts.next(), parts.next()), (Some(Component::Normal(part)), None) if part == name)
}

/// Open one child directory without following a link, relative to a directory
/// whose identity the caller has already accepted. The returned handle does not
/// prevent another process from subsequently moving the directory.
#[cfg(target_os = "macos")]
pub(super) fn open_child_directory(
    parent: &std::fs::File,
    name: &OsStr,
) -> std::io::Result<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;

    const O_RDONLY: c_int = 0;
    const O_NOFOLLOW: c_int = 0x0000_0100;
    const O_DIRECTORY: c_int = 0x0010_0000;
    const O_CLOEXEC: c_int = 0x0100_0000;
    unsafe extern "C" {
        fn openat(dirfd: c_int, path: *const c_char, oflag: c_int, ...) -> c_int;
    }

    if !is_single_name(name) || !parent.metadata()?.is_dir() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let name = CString::new(name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let fd = unsafe {
        openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            O_RDONLY | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // openat returned a new owned descriptor and transfers it to File once.
    let child = unsafe { std::fs::File::from_raw_fd(fd) };
    if !child.metadata()?.is_dir() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    Ok(child)
}

/// Create one new file with mode 0600 relative to an already validated directory.
/// The caller retains the returned handle for writing, syncing, and any
/// identity checks. A failure after creation can leave an entry for the
/// caller's journal/recovery path; this helper never deletes an unverified path.
/// It does not inspect inherited ACLs or establish a complete transaction.
#[cfg(target_os = "macos")]
pub(super) fn create_new(
    directory: &std::fs::File,
    name: &OsStr,
) -> std::io::Result<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    const O_WRONLY: c_int = 0x0000_0001;
    const O_NOFOLLOW: c_int = 0x0000_0100;
    const O_CREAT: c_int = 0x0000_0200;
    const O_EXCL: c_int = 0x0000_0800;
    const O_CLOEXEC: c_int = 0x0100_0000;
    unsafe extern "C" {
        fn openat(dirfd: c_int, path: *const c_char, oflag: c_int, ...) -> c_int;
    }

    if !is_single_name(name) || !directory.metadata()?.is_dir() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let name = CString::new(name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // O_EXCL prevents replacing an existing file or link. O_NOFOLLOW and
    // O_CLOEXEC are set at creation, without an inheritance race.
    let fd = unsafe {
        openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            O_WRONLY | O_NOFOLLOW | O_CREAT | O_EXCL | O_CLOEXEC,
            0o600 as c_int,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // openat returned a new owned descriptor and transfers it to File once.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}

/// Rename one directory entry without replacing an existing destination.
/// No path-string or non-atomic fallback is permitted when the filesystem does
/// not support the required flags. Directory handle authority is the caller's
/// responsibility, as is any transaction journal and crash recovery.
#[cfg(target_os = "macos")]
pub(super) fn rename_no_replace(
    source_directory: &std::fs::File,
    source_name: &OsStr,
    target_directory: &std::fs::File,
    target_name: &OsStr,
) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    const RENAME_EXCL: c_uint = 0x0000_0004;
    const RENAME_NOFOLLOW_ANY: c_uint = 0x0000_0010;
    unsafe extern "C" {
        fn renameatx_np(
            from_fd: c_int,
            from: *const c_char,
            to_fd: c_int,
            to: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }

    if !is_single_name(source_name) || !is_single_name(target_name) {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    if !source_directory.metadata()?.is_dir() || !target_directory.metadata()?.is_dir() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let source = CString::new(source_name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let target = CString::new(target_name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // Each name is exactly one literal component, so it cannot escape its
    // directory handle through an absolute path or parent traversal. Both
    // handles and NUL-terminated names remain alive through the syscall.
    // Do not pass RENAME_RESOLVE_BENEATH: it is absent from macOS 15's XNU.
    let result = unsafe {
        renameatx_np(
            source_directory.as_raw_fd(),
            source.as_ptr(),
            target_directory.as_raw_fd(),
            target.as_ptr(),
            RENAME_EXCL | RENAME_NOFOLLOW_ANY,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod name_tests {
    use super::is_single_name;
    use std::ffi::OsStr;

    #[test]
    fn accepts_only_one_literal_component() {
        for name in ["素材 ①.md", "name with spaces", ".lrk-123.tmp"] {
            assert!(is_single_name(OsStr::new(name)), "{name:?}");
        }
        for name in ["", ".", "..", "../outside", "nested/file", "file/", "a\0b"] {
            assert!(!is_single_name(OsStr::new(name)), "{name:?}");
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod native_tests {
    use super::{create_new, open_child_directory, rename_no_replace};
    use std::ffi::OsStr;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn fixture() -> (PathBuf, File) {
        let root = std::env::temp_dir().join(format!(
            "luckyray-macos-rename-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("create new synthetic fixture");
        let dir = File::open(&root).expect("open synthetic fixture");
        (root, dir)
    }

    #[test]
    fn existing_destination_and_source_remain_untouched() {
        let (root, dir) = fixture();
        fs::write(root.join("source"), b"source").unwrap();
        fs::write(root.join("target"), b"target").unwrap();
        let error =
            rename_no_replace(&dir, OsStr::new("source"), &dir, OsStr::new("target")).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(root.join("source")).unwrap(), b"source");
        assert_eq!(fs::read(root.join("target")).unwrap(), b"target");
        fs::remove_file(root.join("source")).unwrap();
        fs::remove_file(root.join("target")).unwrap();
        drop(dir);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn create_new_does_not_replace_an_existing_file_or_link() {
        use std::os::unix::fs::symlink;
        let (root, dir) = fixture();
        let mut file = create_new(&dir, OsStr::new("新建 file")).unwrap();
        file.write_all(b"synthetic").unwrap();
        file.sync_all().unwrap();
        assert_eq!(
            create_new(&dir, OsStr::new("新建 file"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        symlink("missing", root.join("dangling")).unwrap();
        assert_eq!(
            create_new(&dir, OsStr::new("dangling")).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(root.join("新建 file")).unwrap(), b"synthetic");
        assert!(!root.join("missing").exists());
        drop(file);
        fs::remove_file(root.join("新建 file")).unwrap();
        fs::remove_file(root.join("dangling")).unwrap();
        drop(dir);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn opens_a_real_child_directory_and_rejects_a_link() {
        use std::os::unix::fs::symlink;
        let (root, dir) = fixture();
        fs::create_dir(root.join("真实 folder")).unwrap();
        symlink("真实 folder", root.join("linked folder")).unwrap();
        let child = open_child_directory(&dir, OsStr::new("真实 folder")).unwrap();
        assert!(child.metadata().unwrap().is_dir());
        assert!(open_child_directory(&dir, OsStr::new("linked folder")).is_err());
        assert!(open_child_directory(&dir, OsStr::new("../outside")).is_err());
        drop(child);
        fs::remove_file(root.join("linked folder")).unwrap();
        fs::remove_dir(root.join("真实 folder")).unwrap();
        drop(dir);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn moves_unicode_name_without_a_clobber_fallback() {
        let (root, dir) = fixture();
        fs::write(root.join("暂存 file"), b"synthetic").unwrap();
        rename_no_replace(&dir, OsStr::new("暂存 file"), &dir, OsStr::new("笔记 ①")).unwrap();
        assert!(!root.join("暂存 file").exists());
        assert_eq!(fs::read(root.join("笔记 ①")).unwrap(), b"synthetic");
        fs::remove_file(root.join("笔记 ①")).unwrap();
        drop(dir);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn refuses_to_rename_a_symlink() {
        use std::os::unix::fs::symlink;
        let (root, dir) = fixture();
        fs::write(root.join("real"), b"synthetic").unwrap();
        symlink("real", root.join("link")).unwrap();
        assert!(rename_no_replace(&dir, OsStr::new("link"), &dir, OsStr::new("result")).is_err());
        assert!(fs::symlink_metadata(root.join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!root.join("result").exists());
        fs::remove_file(root.join("link")).unwrap();
        fs::remove_file(root.join("real")).unwrap();
        drop(dir);
        fs::remove_dir(root).unwrap();
    }
}
