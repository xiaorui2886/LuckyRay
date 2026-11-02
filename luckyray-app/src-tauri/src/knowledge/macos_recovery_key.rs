//! Local receipt authority only. Existing key objects are checked and retained;
//! invalid permissions, aliases and conflicting keys never cause a reset.
use crate::macos_fs::{require_empty_acl, Directory, Version};
use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
const KEY: &str = "attachment-receipt.key";
const FOLDER: &str = "knowledge-recovery-auth";
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "recovery-key-object-conflict")
}
struct BoundKey {
    bytes: [u8; 32],
    version: Version,
    file: File,
}
impl BoundKey {
    fn verify(&self, directory: &Directory) -> io::Result<()> {
        require_empty_acl(&self.file)?;
        let actual = directory.read_owned(OsStr::new(KEY))?.ok_or_else(invalid)?;
        if actual.0 != self.bytes
            || actual.1 != self.version
            || !self.version.matches_metadata(&self.file.metadata()?)
        {
            return Err(invalid());
        }
        directory.current()
    }
}
fn read(directory: &Directory) -> io::Result<Option<BoundKey>> {
    let Some((bytes, version)) = directory.read_owned(OsStr::new(KEY))? else {
        return Ok(None);
    };
    let file = directory.open_regular(OsStr::new(KEY))?;
    let result = BoundKey {
        bytes: bytes.try_into().map_err(|_| invalid())?,
        version,
        file,
    };
    result.verify(directory)?;
    Ok(Some(result))
}
fn private_directory(parent: &Directory, path: &Path, create: bool) -> io::Result<Directory> {
    let child = parent.child(OsStr::new(FOLDER), create)?;
    let held = child.identity_file()?;
    require_empty_acl(&held)?;
    let result = Directory::open(&path.join(FOLDER), false, true)?;
    let current = result.identity_file()?.metadata()?;
    let expected = held.metadata()?;
    if (current.dev(), current.ino()) != (expected.dev(), expected.ino()) {
        return Err(invalid());
    }
    parent.current()?;
    result.current()?;
    Ok(result)
}
pub(super) fn load(path: &Path, create: bool) -> io::Result<[u8; 32]> {
    static IO: OnceLock<Mutex<()>> = OnceLock::new();
    let _lock = IO
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| invalid())?;
    let parent = Directory::open_owned(path, false)?;
    let legacy = read(&parent)?;
    if let Some(legacy) = legacy {
        match private_directory(&parent, path, false) {
            Ok(directory) => {
                if let Some(current) = read(&directory)? {
                    if current.bytes != legacy.bytes {
                        return Err(invalid());
                    }
                    current.verify(&directory)?;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => parent.current()?,
            Err(error) => return Err(error),
        }
        legacy.verify(&parent)?;
        return Ok(legacy.bytes);
    }
    let directory = private_directory(&parent, path, create)?;
    let current = match read(&directory)? {
        Some(value) => value,
        None if create => {
            let bytes: [u8; 32] = rand::random();
            match directory.create(OsStr::new(KEY), &bytes) {
                Ok(file) => {
                    require_empty_acl(&file)?;
                    let actual = read(&directory)?.ok_or_else(invalid)?;
                    if actual.bytes != bytes || !actual.version.matches_metadata(&file.metadata()?)
                    {
                        return Err(invalid());
                    }
                    actual
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    read(&directory)?.ok_or_else(invalid)?
                }
                Err(error) => return Err(error),
            }
        }
        None => return Err(io::ErrorKind::NotFound.into()),
    };
    // A concurrent legacy creator is a conflict, not a reason to replace or
    // silently rotate either key. No receipt is issued on a disagreement.
    if let Some(legacy) = read(&parent)? {
        if legacy.bytes != current.bytes {
            return Err(invalid());
        }
        legacy.verify(&parent)?;
    }
    current.verify(&directory)?;
    parent.current()?;
    Ok(current.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Directory) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap();
        let dir = Directory::open(&path, false, false).unwrap();
        (temp, path, dir)
    }
    #[test]
    fn macos_recovery_key_reuses_qualified_legacy_authority_without_moving_it() {
        let (_temp, path, directory) = fixture();
        let file = directory.create(OsStr::new(KEY), &[3; 32]).unwrap();
        let inode = file.metadata().unwrap().ino();
        assert_eq!(load(&path, false).unwrap(), [3; 32]);
        assert!(!path.join(FOLDER).exists());
        assert_eq!(std::fs::metadata(path.join(KEY)).unwrap().ino(), inode);
    }
    #[test]
    fn macos_recovery_key_is_private_stable_and_does_not_adopt_changed_permissions() {
        let (_temp, path, _) = fixture();
        let first = load(&path, true).unwrap();
        assert_eq!(load(&path, false).unwrap(), first);
        let folder = path.join(FOLDER);
        assert_eq!(std::fs::metadata(&folder).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            std::fs::metadata(folder.join(KEY)).unwrap().mode() & 0o777,
            0o600
        );
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(load(&path, true).is_err());
        assert_eq!(std::fs::metadata(&folder).unwrap().mode() & 0o777, 0o755);
    }
    #[test]
    fn macos_recovery_key_conflict_keeps_both_original_objects() {
        let (_temp, path, parent) = fixture();
        let current = load(&path, true).unwrap();
        let legacy = [current[0] ^ 1; 32];
        parent.create(OsStr::new(KEY), &legacy).unwrap();
        assert!(load(&path, true).is_err());
        assert_eq!(std::fs::read(path.join(KEY)).unwrap(), legacy);
        assert_eq!(std::fs::read(path.join(FOLDER).join(KEY)).unwrap(), current);
    }
}
