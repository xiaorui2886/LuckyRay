use crate::linux_file_store;
use crate::linux_fs::{Directory, Snapshot};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;

pub(super) struct CredentialStore {
    dir: Directory,
    versions: HashMap<String, Option<Snapshot>>,
}

impl CredentialStore {
    pub(super) fn open(path: &Path, create: bool) -> Result<Self, String> {
        let dir = Directory::private(path, create)
            .map_err(|_| "local transport credential directory is unsafe".to_owned())?;
        if create {
            linux_file_store::recover(&dir, true)
                .map_err(|_| "local transport credential recovery requires attention".to_owned())?;
        }
        Ok(Self {
            dir,
            versions: HashMap::new(),
        })
    }

    pub(super) fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let snapshot = self
            .dir
            .read(OsStr::new(name), true, 1024 * 1024)
            .map_err(|_| "local transport credential file is unsafe or changed".to_owned())?;
        let bytes = snapshot.as_ref().map(|s| s.bytes.clone());
        self.versions.insert(name.into(), snapshot);
        Ok(bytes)
    }

    pub(super) fn write(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > 1024 * 1024 {
            return Err("local transport credential record is too large".into());
        }
        if !self.versions.contains_key(name) {
            self.read(name)?;
        }
        let expected = self.versions.get(name).and_then(Option::as_ref);
        let next = linux_file_store::write(
            &self.dir,
            OsStr::new(name),
            expected,
            bytes,
            true,
            false,
            false,
        )
        .map_err(|_| "local transport credential conflict; reload required".to_owned())?;
        self.versions.insert(name.into(), Some(next));
        Ok(())
    }

    pub(super) fn validate_current(&self) -> Result<(), String> {
        for (name, expected) in &self.versions {
            let current = self
                .dir
                .read(OsStr::new(name), true, 1024 * 1024)
                .map_err(|_| "local transport credentials changed; reload required")?;
            let same = match (expected, current.as_ref()) {
                (None, None) => true,
                (Some(old), Some(now)) => {
                    old.version.same_object(&now.version) && old.bytes == now.bytes
                }
                _ => false,
            };
            if !same {
                return Err("local transport credentials changed; reload required".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn linux_credentials_reject_links_permissions_and_stale_writers() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("private");
        let mut first = CredentialStore::open(&profile, true).unwrap();
        first.read("auth.json").unwrap();
        first.write("auth.json", b"first").unwrap();
        let mut stale = CredentialStore::open(&profile, true).unwrap();
        stale.read("auth.json").unwrap();
        first.write("auth.json", b"rotated").unwrap();
        assert!(stale.write("auth.json", b"old").is_err());
        assert_eq!(
            std::fs::read(profile.join("auth.json")).unwrap(),
            b"rotated"
        );
        assert_eq!(
            std::fs::metadata(profile.join("auth.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        symlink(profile.join("auth.json"), profile.join("alias")).unwrap();
        assert!(first.read("alias").is_err());
        let fifo = std::ffi::CString::new(profile.join("fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(first.read("fifo").is_err());
        std::fs::set_permissions(
            profile.join("auth.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(first.read("auth.json").is_err());
        let alias = root.path().join("linked-profile");
        symlink(&profile, &alias).unwrap();
        assert!(CredentialStore::open(&alias, false).is_err());
    }
}
