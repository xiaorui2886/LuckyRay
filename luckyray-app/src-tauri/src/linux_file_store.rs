//! Optimistic Linux commits with a durable journal and retained prior version.
//! Names are relative to a held directory. Concurrent external edits are detected
//! when observed; this is not mandatory exclusion against the same OS user.
use crate::linux_fs::{conflict, Directory, Snapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::io;

pub(crate) const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    nonce: String,
    target: String,
    backup: String,
    displaced: String,
    next: String,
    before: Option<String>,
    after: String,
}

fn same(left: Option<&Snapshot>, right: Option<&Snapshot>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.version == right.version && left.bytes == right.bytes,
        _ => false,
    }
}

#[cfg(test)]
thread_local! {
    static CRASH_AFTER_JOURNAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Test seam distinct from `fail_before` (a clean, self-discarding failure):
/// the next write on this thread stops as if the process died right after
/// its journal became durable.
#[cfg(test)]
pub(crate) fn crash_next_write_after_journal() {
    CRASH_AFTER_JOURNAL.with(|flag| flag.set(true));
}

pub(crate) fn write(
    dir: &Directory,
    name: &OsStr,
    expected: Option<&Snapshot>,
    bytes: &[u8],
    private: bool,
    fail_before: bool,
    interrupt_after_backup: bool,
) -> io::Result<Snapshot> {
    write_inner(
        dir,
        name,
        expected,
        bytes,
        private,
        fail_before,
        interrupt_after_backup,
        true,
    )
}

/// The caller already holds this directory's cooperating-writer lock.
/// The Linux attachment store takes the Vault lease before a step runs, and a
/// second flock on the same file from the same process fails instead of
/// excluding anyone, so the attachment path reuses the lock it already holds.
/// Everything else (expected-state proof, retained backup, journal, rename) is
/// identical to `write`.
pub(crate) fn write_locked(
    dir: &Directory,
    name: &OsStr,
    expected: Option<&Snapshot>,
    bytes: &[u8],
    private: bool,
) -> io::Result<Snapshot> {
    write_inner(dir, name, expected, bytes, private, false, false, false)
}

fn write_inner(
    dir: &Directory,
    name: &OsStr,
    expected: Option<&Snapshot>,
    bytes: &[u8],
    private: bool,
    fail_before: bool,
    interrupt_after_backup: bool,
    lock: bool,
) -> io::Result<Snapshot> {
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(conflict());
    }
    let target = name
        .to_str()
        .filter(|name| !name.starts_with(".lrk-"))
        .ok_or_else(conflict)?;
    let preflight = dir.read(name, private, MAX_RECORD_BYTES)?;
    if !same(expected, preflight.as_ref()) {
        return Err(conflict());
    }
    crate::linux_fs::no_default_acl(&dir.file)?;
    let permissions = preflight
        .as_ref()
        .map(|old| crate::linux_fs::Permissions::capture(&old.file))
        .transpose()?;
    let _lock = if lock { Some(dir.lock()?) } else { None };
    let current = dir.read(name, private, MAX_RECORD_BYTES)?;
    if !same(preflight.as_ref(), current.as_ref()) {
        return Err(conflict());
    }
    let nonce = format!("{:032x}", rand::random::<u128>());
    let next = format!(".lrk-{nonce}.tmp");
    let backup = format!(".lrk-{nonce}.backup");
    let displaced = format!(".lrk-{nonce}.displaced");
    let journal_name = format!(".lrk-{nonce}.journal");
    let next_file = dir.create(OsStr::new(&next), bytes)?;
    if let Some(permissions) = permissions.as_ref() {
        permissions.apply(&next_file)?;
    }
    // An external editor can keep writing the old inode after it is moved.
    // Retain an independent copy of the version read by this transaction.
    let backup_file = match current.as_ref() {
        Some(previous) => Some(dir.create(OsStr::new(&backup), &previous.bytes)?),
        None => None,
    };
    let journal = Journal {
        version: 1,
        nonce,
        target: target.into(),
        backup,
        displaced,
        next,
        before: current.as_ref().map(|v| digest(&v.bytes)),
        after: digest(bytes),
    };
    let journal_bytes = serde_json::to_vec(&journal).map_err(|_| conflict())?;
    let journal_file = dir.create(OsStr::new(&journal_name), &journal_bytes)?;
    #[cfg(test)]
    if CRASH_AFTER_JOURNAL.with(|flag| flag.replace(false)) {
        // Simulated process death: the journal, draft and backup stay on disk
        // for startup recovery, with the target untouched.
        return Err(io::Error::other("linux-write-crashed-after-journal"));
    }
    if fail_before {
        // No target mutation occurred: discard this transaction's own files,
        // journal first so recovery never acts on a half-removed set.
        dir.remove_owned(OsStr::new(&journal_name), &journal_file)?;
        if let Some(file) = backup_file.as_ref() {
            dir.remove_owned(OsStr::new(&journal.backup), file)?;
        }
        dir.remove_owned(OsStr::new(&journal.next), &next_file)?;
        return Err(io::Error::other("linux-write-interrupted-before-commit"));
    }
    let checked = dir.read(name, private, MAX_RECORD_BYTES)?;
    if !same(current.as_ref(), checked.as_ref()) {
        // No target mutation occurred. Retain the draft and backup as conflict
        // evidence without asking startup recovery to overwrite an external edit.
        dir.verify_named(OsStr::new(&journal_name), &journal_file)?;
        dir.rename_new(
            OsStr::new(&journal_name),
            dir,
            OsStr::new(&format!(".lrk-{}.conflict", journal.nonce)),
        )?;
        return Err(conflict());
    }
    if let Some(previous) = current.as_ref() {
        dir.rename_new(name, dir, OsStr::new(&journal.displaced))?;
        let displaced = dir.read(OsStr::new(&journal.displaced), private, MAX_RECORD_BYTES)?;
        if !displaced.as_ref().is_some_and(|moved| {
            previous.version.same_object(&moved.version) && previous.bytes == moved.bytes
        }) {
            // Restore only into a vacant name. A replacement writer is preserved.
            let _ = dir.rename_new(OsStr::new(&journal.displaced), dir, name);
            return Err(conflict());
        }
        if let (Some(policy), Some(moved)) = (permissions.as_ref(), displaced.as_ref()) {
            if let Err(error) = policy.matches(&moved.file) {
                let _ = dir.rename_new(OsStr::new(&journal.displaced), dir, name);
                return Err(error);
            }
        }
    }
    if interrupt_after_backup {
        return Err(io::Error::other("linux-write-interrupted-after-backup"));
    }
    dir.verify_named(OsStr::new(&journal.next), &next_file)?;
    dir.rename_new(OsStr::new(&journal.next), dir, name)?;
    let installed = dir
        .read(name, private, MAX_RECORD_BYTES)?
        .ok_or_else(conflict)?;
    if !crate::linux_fs::Version::of(&next_file)?.same_object(&installed.version)
        || installed.bytes != bytes
    {
        return Err(conflict());
    }
    dir.verify_named(OsStr::new(&journal_name), &journal_file)?;
    dir.rename_new(
        OsStr::new(&journal_name),
        dir,
        OsStr::new(&format!(".lrk-{}.receipt", journal.nonce)),
    )?;
    // The backup and receipt remain available for recovery and manual review.
    Ok(installed)
}

pub(crate) fn recover(dir: &Directory, private: bool) -> io::Result<()> {
    recover_inner(dir, private, None)
}

/// Managed startup/registration records never recover another target or an
/// executable/configuration payload outside their caller's fixed family.
pub(crate) fn recover_managed(dir: &Directory, name: &OsStr, family: &[&[u8]]) -> io::Result<()> {
    let target = name.to_str().ok_or_else(conflict)?;
    let digests: Vec<_> = family.iter().map(|bytes| digest(bytes)).collect();
    recover_inner(dir, false, Some((target, &digests)))
}

pub(crate) fn recovery_pending(dir: &Directory) -> io::Result<bool> {
    dir.verify()?;
    let entries = std::fs::read_dir(format!("/proc/self/fd/{}", std::os::fd::AsRawFd::as_raw_fd(&dir.file)))?;
    let mut pending = false;
    for (count, item) in entries.enumerate() {
        if count > 100_000 { return Err(conflict()); }
        let item = item?;
        if item.file_name().to_str().is_some_and(|name| name.starts_with(".lrk-") && name.ends_with(".journal")) {
            pending = true;
        }
    }
    dir.verify()?;
    Ok(pending)
}

fn recover_inner(dir: &Directory, private: bool, scope: Option<(&str, &[String])>) -> io::Result<()> {
    let _lock = dir.lock()?;
    let entries = std::fs::read_dir(format!(
        "/proc/self/fd/{}",
        std::os::fd::AsRawFd::as_raw_fd(&dir.file)
    ))?;
    for (count, entry) in entries.enumerate() {
        if count > 100_000 {
            return Err(conflict());
        }
        let entry = entry?;
        let name = entry.file_name();
        let Some(name_text) = name.to_str() else {
            continue;
        };
        if !name_text.starts_with(".lrk-") || !name_text.ends_with(".journal") {
            continue;
        }
        let opened = dir.read(&name, true, 64 * 1024)?.ok_or_else(conflict)?;
        let record: Journal = serde_json::from_slice(&opened.bytes).map_err(|_| conflict())?;
        let valid_digest =
            |hash: &str| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit());
        if record.version != 1
            || record.nonce.len() != 32
            || !record.nonce.bytes().all(|b| b.is_ascii_hexdigit())
            || name_text != format!(".lrk-{}.journal", record.nonce)
            || record.backup != format!(".lrk-{}.backup", record.nonce)
            || record.displaced != format!(".lrk-{}.displaced", record.nonce)
            || record.next != format!(".lrk-{}.tmp", record.nonce)
            || record.target.starts_with(".lrk-")
            || !valid_digest(&record.after)
            || record.before.as_deref().is_some_and(|h| !valid_digest(h))
        {
            return Err(conflict());
        }
        if let Some((target, allowed)) = scope {
            if record.target != target || !allowed.contains(&record.after)
                || record.before.as_ref().is_some_and(|hash| !allowed.contains(hash)) {
                return Err(conflict());
            }
        }
        // Directory::read validates that target is one normal name, with no links.
        let target = dir.read(OsStr::new(&record.target), private, MAX_RECORD_BYTES)?;
        if scope.is_some() {
            if let Some(target) = target.as_ref() {
                crate::linux_managed_record::validate_metadata(&target.file)?;
            }
        }
        match target.as_ref().map(|value| digest(&value.bytes)) {
            Some(hash) if hash == record.after || record.before.as_ref() == Some(&hash) => {}
            None => {
                if let Some(expected) = record.before.as_ref() {
                    let backup = dir
                        .read(OsStr::new(&record.backup), private, MAX_RECORD_BYTES)?
                        .ok_or_else(conflict)?;
                    if digest(&backup.bytes) != *expected {
                        return Err(conflict());
                    }
                    // Restore the original inode with its actual permissions.
                    // The independent byte copy alone cannot reconstruct ACLs
                    // or labels added to that inode by an external editor.
                    let displaced = dir
                        .read(OsStr::new(&record.displaced), private, MAX_RECORD_BYTES)?
                        .ok_or_else(conflict)?;
                    if digest(&displaced.bytes) != *expected {
                        return Err(conflict());
                    }
                    // Apply the normal managed-record policy before restoring
                    // an active pathname or acknowledging its journal.
                    if scope.is_some() {
                        crate::linux_managed_record::validate_metadata(&displaced.file)?;
                    }
                    dir.rename_new(
                        OsStr::new(&record.displaced),
                        dir,
                        OsStr::new(&record.target),
                    )?;
                    dir.verify_named(OsStr::new(&record.target), &displaced.file)?;
                }
            }
            // Never overwrite an external edit during recovery.
            _ => return Err(conflict()),
        }
        dir.verify_named(&name, &opened.file)?;
        dir.rename_new(
            &name,
            dir,
            OsStr::new(&format!(".lrk-{}.receipt", record.nonce)),
        )?;
    }
    dir.verify()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    #[test]
    fn linux_commit_preserves_backup_and_rejects_stale_revision() {
        let root = tempfile::tempdir().unwrap();
        let dir = Directory::open(root.path()).unwrap();
        let initial = dir.create(OsStr::new("note.md"), b"original").unwrap();
        assert_eq!(unsafe { libc::fchmod(initial.as_raw_fd(), 0o640) }, 0);
        let original = dir
            .read(OsStr::new("note.md"), false, 1024)
            .unwrap()
            .unwrap();
        let mut external = std::fs::OpenOptions::new()
            .write(true)
            .open(root.path().join("note.md"))
            .unwrap();
        write(
            &dir,
            OsStr::new("note.md"),
            Some(&original),
            b"next",
            false,
            false,
            false,
        )
        .unwrap();
        assert!(write(
            &dir,
            OsStr::new("note.md"),
            Some(&original),
            b"stale",
            false,
            false,
            false
        )
        .is_err());
        assert_eq!(std::fs::read(root.path().join("note.md")).unwrap(), b"next");
        let backup = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension() == Some(OsStr::new("backup")))
            .unwrap();
        assert_eq!(std::fs::read(backup).unwrap(), b"original");
        assert_eq!(
            std::fs::metadata(root.path().join("note.md"))
                .unwrap()
                .mode()
                & 0o777,
            0o640
        );
        external
            .write_all(b"external edit to the displaced inode")
            .unwrap();
        let displaced = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension() == Some(OsStr::new("displaced")))
            .unwrap();
        assert_eq!(external.metadata().unwrap().nlink(), 1);
        assert_eq!(
            std::fs::read(displaced).unwrap(),
            b"external edit to the displaced inode"
        );
        let backup = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension() == Some(OsStr::new("backup")))
            .unwrap();
        assert_eq!(std::fs::read(backup).unwrap(), b"original");

        let current = dir
            .read(OsStr::new("note.md"), false, 1024)
            .unwrap()
            .unwrap();
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, permission, id) in [
            (1u16, 6u16, u32::MAX),
            (2, 4, unsafe { libc::geteuid() }.saturating_add(1)),
            (4, 0, u32::MAX),
            (16, 4, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            acl.extend_from_slice(&tag.to_le_bytes());
            acl.extend_from_slice(&permission.to_le_bytes());
            acl.extend_from_slice(&id.to_le_bytes());
        }
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    current.file.as_raw_fd(),
                    c"system.posix_acl_access".as_ptr(),
                    acl.as_ptr().cast(),
                    acl.len(),
                    0,
                )
            },
            0,
            "synthetic POSIX ACL requires filesystem support"
        );
        let with_acl = dir
            .read(OsStr::new("note.md"), false, 1024)
            .unwrap()
            .unwrap();
        let count = std::fs::read_dir(root.path()).unwrap().count();
        let failure = write(
            &dir,
            OsStr::new("note.md"),
            Some(&with_acl),
            b"must not replace",
            false,
            false,
            false,
        )
        .err()
        .expect("ACL replacement must be refused");
        assert_eq!(failure.kind(), io::ErrorKind::Unsupported);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), count);
        assert_eq!(std::fs::read(root.path().join("note.md")).unwrap(), b"next");
        let mut retained = vec![0; acl.len()];
        assert_eq!(
            unsafe {
                libc::fgetxattr(
                    with_acl.file.as_raw_fd(),
                    c"system.posix_acl_access".as_ptr(),
                    retained.as_mut_ptr().cast(),
                    retained.len(),
                )
            },
            acl.len() as isize
        );
        assert_eq!(retained, acl);
    }
    #[test]
    fn linux_interrupted_commit_recovers_without_overwriting_external_edit() {
        let root = tempfile::tempdir().unwrap();
        let dir = Directory::open(root.path()).unwrap();
        dir.create(OsStr::new("note.md"), b"original").unwrap();
        let original = dir
            .read(OsStr::new("note.md"), false, 1024)
            .unwrap()
            .unwrap();
        let mut external = std::fs::OpenOptions::new()
            .write(true)
            .open(root.path().join("note.md"))
            .unwrap();
        assert!(write(
            &dir,
            OsStr::new("note.md"),
            Some(&original),
            b"draft",
            false,
            false,
            true
        )
        .is_err());
        assert!(!root.path().join("note.md").exists());
        recover(&dir, false).unwrap();
        assert_eq!(
            std::fs::read(root.path().join("note.md")).unwrap(),
            b"original"
        );
        external
            .write_all(b"delayed editor after recovery")
            .unwrap();
        assert_eq!(
            std::fs::read(root.path().join("note.md")).unwrap(),
            b"delayed editor after recovery"
        );
        let current = dir
            .read(OsStr::new("note.md"), false, 1024)
            .unwrap()
            .unwrap();
        assert!(write(
            &dir,
            OsStr::new("note.md"),
            Some(&current),
            b"draft2",
            false,
            false,
            true
        )
        .is_err());
        dir.create(OsStr::new("note.md"), b"external").unwrap();
        assert!(recover(&dir, false).is_err());
        assert_eq!(
            std::fs::read(root.path().join("note.md")).unwrap(),
            b"external"
        );
    }
}
