//! Scoped, optimistic public per-user configuration records. No path deletion:
//! disabled states are explicit data, with retained backups and prior inodes.
use crate::linux_fs::{conflict, Directory, Permissions, Snapshot};
use std::ffi::OsStr;
use std::io;
use std::os::unix::fs::MetadataExt;

const MAX_BYTES: usize = 64 * 1024;

pub(crate) struct Record {
    pub(crate) snapshot: Snapshot,
    pub(crate) state: usize,
}

fn checked_family(family: &[&[u8]]) -> io::Result<()> {
    if family.is_empty() || family.iter().any(|bytes| bytes.is_empty() || bytes.len() > MAX_BYTES) {
        return Err(conflict());
    }
    Ok(())
}

pub(crate) fn validate_metadata(file: &std::fs::File) -> io::Result<()> {
    Permissions::capture(file)?;
    if file.metadata()?.mode() & 0o022 != 0 { return Err(conflict()); }
    Ok(())
}

pub(crate) fn read(dir: &Directory, name: &OsStr, family: &[&[u8]]) -> io::Result<Option<Record>> {
    checked_family(family)?;
    // A status query never creates a lock, recovery record or missing profile.
    if crate::linux_file_store::recovery_pending(dir)? {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "linux-managed-record-recovery-required"));
    }
    let Some(snapshot) = dir.read(name, false, MAX_BYTES)? else { return Ok(None); };
    validate_metadata(&snapshot.file)?;
    let state = family.iter().position(|bytes| *bytes == snapshot.bytes.as_slice()).ok_or_else(conflict)?;
    Ok(Some(Record { snapshot, state }))
}

pub(crate) fn recover(dir: &Directory, name: &OsStr, family: &[&[u8]]) -> io::Result<()> {
    checked_family(family)?;
    if crate::linux_file_store::recovery_pending(dir)? {
        crate::linux_fs::no_default_acl(&dir.file)?;
        crate::linux_file_store::recover_managed(dir, name, family)?;
    }
    Ok(())
}

pub(crate) fn set(dir: &Directory, name: &OsStr, family: &[&[u8]], state: usize) -> io::Result<Record> {
    recover(dir, name, family)?;
    let bytes = *family.get(state).ok_or_else(conflict)?;
    let current = read(dir, name, family)?;
    if let Some(record) = current.as_ref() {
        if record.state == state {
            dir.verify_named(name, &record.snapshot.file)?;
            return Ok(current.unwrap());
        }
    }
    let snapshot = crate::linux_file_store::write(dir, name,
        current.as_ref().map(|record| &record.snapshot), bytes, false, false, false)?;
    Ok(Record { snapshot, state })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::fd::AsRawFd;
    use std::path::Path;
    const FAMILY: &[&[u8]] = &[b"managed enabled", b"managed disabled"];

    fn names(dir: &Directory) -> Vec<std::ffi::OsString> {
        let mut names: Vec<_> = fs::read_dir(&dir.path).unwrap().map(|item| item.unwrap().file_name()).collect();
        names.sort(); names
    }

    #[test]
    fn linux_managed_status_is_read_only_and_recovery_rejects_another_target() {
        let root = tempfile::tempdir().unwrap();
        let dir = Directory::owned(root.path(), false).unwrap();
        assert!(read(&dir, OsStr::new("managed"), FAMILY).unwrap().is_none());
        assert!(names(&dir).is_empty());
        let foreign = dir.create(OsStr::new("foreign"), FAMILY[0]).unwrap();
        let before = dir.read(OsStr::new("foreign"), false, MAX_BYTES).unwrap().unwrap();
        assert!(crate::linux_file_store::write(&dir, OsStr::new("foreign"), Some(&before),
            FAMILY[1], false, false, true).is_err());
        let pending = names(&dir);
        assert!(recover(&dir, OsStr::new("managed"), FAMILY).is_err());
        assert_eq!(names(&dir), pending);
        assert!(!root.path().join("managed").exists());
        assert!(!root.path().join("foreign").exists());
        assert_eq!(foreign.metadata().unwrap().ino(), before.version.inode);
    }

    #[test]
    fn linux_managed_recovery_does_not_activate_an_unknown_payload_family() {
        let root = tempfile::tempdir().unwrap();
        let dir = Directory::owned(root.path(), false).unwrap();
        dir.create(OsStr::new("managed"), b"foreign startup payload").unwrap();
        let before = dir.read(OsStr::new("managed"), false, MAX_BYTES).unwrap().unwrap();
        assert!(crate::linux_file_store::write(&dir, OsStr::new("managed"), Some(&before),
            FAMILY[1], false, false, true).is_err());
        let pending = names(&dir);
        assert!(recover(&dir, OsStr::new("managed"), FAMILY).is_err());
        assert_eq!(names(&dir), pending);
        assert!(!root.path().join("managed").exists());
    }

    #[test]
    fn linux_managed_records_reject_hardlinks_and_external_attributes() {
        let root = tempfile::tempdir().unwrap();
        let dir = Directory::owned(root.path(), false).unwrap();
        let record = set(&dir, OsStr::new("managed"), FAMILY, 0).unwrap();
        fs::hard_link(root.path().join("managed"), root.path().join("alias")).unwrap();
        assert!(set(&dir, OsStr::new("managed"), FAMILY, 1).is_err());
        assert_eq!(fs::read(root.path().join("alias")).unwrap(), FAMILY[0]);
        fs::remove_file(root.path().join("alias")).unwrap();
        assert_eq!(unsafe { libc::fsetxattr(record.snapshot.file.as_raw_fd(), c"user.luckyray-test".as_ptr(),
            b"retain".as_ptr().cast(), 6, 0) }, 0);
        assert!(set(&dir, OsStr::new("managed"), FAMILY, 1).is_err());
        assert_eq!(fs::read(root.path().join("managed")).unwrap(), FAMILY[0]);
    }

    #[test]
    fn linux_managed_default_acl_is_refused_before_new_file_creation() {
        let root = tempfile::tempdir().unwrap();
        let dir = Directory::owned(root.path(), false).unwrap();
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, permission) in [(1u16, 7u16), (4, 5), (32, 0)] {
            acl.extend(tag.to_le_bytes()); acl.extend(permission.to_le_bytes()); acl.extend(u32::MAX.to_le_bytes());
        }
        assert_eq!(unsafe { libc::fsetxattr(dir.file.as_raw_fd(), c"system.posix_acl_default".as_ptr(),
            acl.as_ptr().cast(), acl.len(), 0) }, 0);
        assert!(set(&dir, OsStr::new("managed"), FAMILY, 0).is_err());
        assert!(names(&dir).is_empty());
    }

    #[test]
    fn linux_managed_recovery_rejects_unsafe_metadata_before_restoring_or_accepting() {
        // Exercise the missing target (displaced inode) and existing target
        // recovery branches, with unchanged bytes but unsafe mode or real ACL.
        for displaced in [true, false] {
            for acl_added in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let dir = Directory::owned(root.path(), false).unwrap();
                let target = OsStr::new("managed.desktop");
                dir.create(target, FAMILY[0]).unwrap();
                let before = dir.read(target, false, MAX_BYTES).unwrap().unwrap();
                assert!(crate::linux_file_store::write(
                    &dir, target, Some(&before), FAMILY[1], false, !displaced, displaced,
                ).is_err());

                if acl_added {
                    // A named-user ACL survives as an xattr even though the
                    // resulting ordinary mode has no group/other write bits.
                    let mut acl = 2u32.to_le_bytes().to_vec();
                    for (tag, permission, id) in [
                        (1u16, 6u16, u32::MAX),
                        (2, 4, unsafe { libc::geteuid() } + 1),
                        (4, 0, u32::MAX),
                        (16, 4, u32::MAX),
                        (32, 0, u32::MAX),
                    ] {
                        acl.extend(tag.to_le_bytes());
                        acl.extend(permission.to_le_bytes());
                        acl.extend(id.to_le_bytes());
                    }
                    assert_eq!(unsafe {
                        libc::fsetxattr(before.file.as_raw_fd(), c"system.posix_acl_access".as_ptr(),
                            acl.as_ptr().cast(), acl.len(), 0)
                    }, 0);
                    assert_eq!(before.file.metadata().unwrap().mode() & 0o022, 0);
                    assert!(crate::linux_fs::no_attributes(&before.file).is_err());
                } else {
                    assert_eq!(unsafe { libc::fchmod(before.file.as_raw_fd(), 0o666) }, 0);
                }

                let pending = names(&dir);
                assert_eq!(pending.iter().filter(|name| Path::new(name).extension() == Some(OsStr::new("journal"))).count(), 1);
                let bytes = |extension| {
                    let name = pending.iter().find(|name| Path::new(name).extension() == Some(OsStr::new(extension))).unwrap();
                    fs::read(root.path().join(name)).unwrap()
                };
                assert_eq!(bytes("backup"), FAMILY[0]);
                assert_eq!(bytes("tmp"), FAMILY[1]);

                assert!(set(&dir, target, FAMILY, 1).is_err());
                assert_eq!(names(&dir), pending, "displaced={displaced}, acl={acl_added}");
                assert_eq!(root.path().join(target).exists(), !displaced);
                assert_eq!(before.file.metadata().unwrap().ino(), before.version.inode);
                assert_eq!(bytes("backup"), FAMILY[0]);
                assert_eq!(bytes("tmp"), FAMILY[1]);
                if displaced { assert_eq!(bytes("displaced"), FAMILY[0]); }
                if acl_added {
                    assert!(crate::linux_fs::no_attributes(&before.file).is_err());
                } else {
                    assert_eq!(before.file.metadata().unwrap().mode() & 0o777, 0o666);
                }
            }
        }
    }
}
