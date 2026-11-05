//! Exclusive Mac folder creation relative to the verified parent descriptor.
//!
//! This narrows a parent-name swap; it does not prevent an uncoordinated
//! process from moving the held parent outside the vault during mkdir. If the
//! post-check fails, no pathname is deleted and the outcome remains uncertain.
use crate::macos_fs::Directory;
use std::ffi::{CString, OsStr};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Exists,
    Uncertain,
}

pub(super) fn create(parent: &Directory, name: &OsStr) -> Result<(), Failure> {
    create_with_hooks(parent, name, || {}, || {})
}

fn create_with_hooks(
    parent: &Directory,
    name: &OsStr,
    before_mkdir: impl FnOnce(),
    after_mkdir: impl FnOnce(),
) -> Result<(), Failure> {
    if !matches!((Path::new(name).components().next(), Path::new(name).components().nth(1)),
        (Some(Component::Normal(part)), None) if part == name)
    {
        return Err(Failure::Uncertain);
    }
    let name = CString::new(name.as_bytes()).map_err(|_| Failure::Uncertain)?;
    parent.current().map_err(|_| Failure::Uncertain)?;
    let directory = parent.identity_file().map_err(|_| Failure::Uncertain)?;
    parent.current().map_err(|_| Failure::Uncertain)?;
    before_mkdir();
    // Match std::fs::create_dir's Unix mode, subject to the caller's umask.
    if unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o777) } != 0 {
        let failure = io::Error::last_os_error();
        if failure.kind() == io::ErrorKind::AlreadyExists {
            parent.current().map_err(|_| Failure::Uncertain)?;
            return Err(Failure::Exists);
        }
        return Err(Failure::Uncertain);
    }
    after_mkdir();
    directory.sync_all().map_err(|_| Failure::Uncertain)?;
    parent.current().map_err(|_| Failure::Uncertain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Directory) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let parent = root.join("parent");
        fs::create_dir(&parent).unwrap();
        let directory = Directory::open(&parent, false, false).unwrap();
        (temp, root, directory)
    }

    #[test]
    fn macos_folder_create_rejects_existing_and_matches_standard_mode() {
        let (_temp, root, parent) = fixture();
        fs::create_dir(root.join("parent/existing")).unwrap();
        fs::write(root.join("parent/existing/keep"), b"keep").unwrap();
        assert_eq!(
            create(&parent, OsStr::new("existing")),
            Err(Failure::Exists)
        );
        assert_eq!(
            fs::read(root.join("parent/existing/keep")).unwrap(),
            b"keep"
        );
        create(&parent, OsStr::new("created")).unwrap();
        let standard = fs::metadata(root.join("parent/existing"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let actual = fs::metadata(root.join("parent/created"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(actual, standard);
    }

    #[test]
    fn macos_folder_create_uses_held_parent_after_a_temporary_swap() {
        let (_temp, root, parent) = fixture();
        fs::create_dir(root.join("replacement")).unwrap();
        let result = create_with_hooks(
            &parent,
            OsStr::new("new"),
            || {
                fs::rename(root.join("parent"), root.join("held")).unwrap();
                fs::rename(root.join("replacement"), root.join("parent")).unwrap();
            },
            || {
                fs::rename(root.join("parent"), root.join("replacement-held")).unwrap();
                fs::rename(root.join("held"), root.join("parent")).unwrap();
            },
        );
        assert_eq!(result, Ok(()));
        assert!(root.join("parent/new").is_dir());
        assert!(!root.join("replacement-held/new").exists());
    }

    #[test]
    fn macos_folder_create_preserves_a_displaced_parent_and_reports_uncertain() {
        let (_temp, root, parent) = fixture();
        fs::create_dir(root.join("replacement")).unwrap();
        let result = create_with_hooks(
            &parent,
            OsStr::new("new"),
            || {
                fs::rename(root.join("parent"), root.join("held")).unwrap();
                fs::rename(root.join("replacement"), root.join("parent")).unwrap();
            },
            || {},
        );
        assert_eq!(result, Err(Failure::Uncertain));
        assert!(root.join("held/new").is_dir());
        assert!(!root.join("parent/new").exists());
    }

    #[test]
    fn macos_folder_create_does_not_report_conflict_in_a_displaced_parent() {
        let (_temp, root, parent) = fixture();
        fs::create_dir(root.join("parent/existing")).unwrap();
        fs::create_dir(root.join("replacement")).unwrap();
        let result = create_with_hooks(
            &parent,
            OsStr::new("existing"),
            || {
                fs::rename(root.join("parent"), root.join("held")).unwrap();
                fs::rename(root.join("replacement"), root.join("parent")).unwrap();
            },
            || {},
        );
        assert_eq!(result, Err(Failure::Uncertain));
        assert!(root.join("held/existing").is_dir());
        assert!(!root.join("parent/existing").exists());
    }
}
