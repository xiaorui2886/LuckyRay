//! Immutable, object-bound recovery records for the Mac Vault. A small manifest
//! is published last; pieces are never auto-deleted after errors or cancellation.
//! This stores bytes only. Plan validation and external-file HMAC authority are
//! still required by the existing service before any recovery is executed.
use super::macos_record_policy as layout;
use crate::macos_fs::{digest, require_empty_acl, Directory, Version};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::unix::fs::MetadataExt;

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "recovery-record-invalid")
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Piece {
    name: String,
    bytes: usize,
    device: u64,
    inode: u64,
    hash: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    format: String,
    root: (u64, u64),
    bytes: usize,
    hash: String,
    pieces: Vec<Piece>,
}
pub(super) struct Store {
    root: Directory,
    directory: Directory,
    root_object: (u64, u64),
}
impl Store {
    pub(super) fn read_optional(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        if !layout::record_name(name) {
            return Err(invalid());
        }
        self.check()?;
        match self.directory.entry_info(OsStr::new(name)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.check()?;
                Ok(None)
            }
            Err(error) => Err(error),
            Ok(_) => self.read(name).map(Some),
        }
    }
    pub(super) fn lock_operation(&self, id: &str) -> io::Result<File> {
        if !layout::record_name(&format!("{id}.json")) || id.len() != 32 {
            return Err(invalid());
        }
        self.check()?;
        let lock = self
            .directory
            .lock(OsStr::new(&format!("{id}.steps.lock")))?;
        self.check()?;
        Ok(lock)
    }
    pub(super) fn open(root: &Directory, create: bool) -> io::Result<Self> {
        let metadata = root.child(OsStr::new(".luckyray"), false)?;
        let operations = metadata.child(OsStr::new("attachment-operations"), create)?;
        let directory = operations.child(OsStr::new("macos"), create)?;
        let root_metadata = root.identity_file()?.metadata()?;
        let result = Self {
            root: root.try_clone()?,
            directory,
            root_object: (root_metadata.dev(), root_metadata.ino()),
        };
        result.check()?;
        Ok(result)
    }
    fn check(&self) -> io::Result<()> {
        self.root.current()?;
        self.directory.current()?;
        let file = self.directory.identity_file()?;
        let metadata = file.metadata()?;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.mode() & 0o500 != 0o500
        {
            return Err(invalid());
        }
        require_empty_acl(&file)
    }
    fn verify_created(&self, name: &str, file: &File, expected: &Version) -> io::Result<()> {
        self.check()?;
        require_empty_acl(file)?;
        let metadata = file.metadata()?;
        let actual = self
            .directory
            .read_owned(OsStr::new(name))?
            .ok_or_else(invalid)?;
        if &actual.1 != expected
            || !expected.matches_metadata(&metadata)
            || metadata.mode() & 0o7777 != 0o600
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn create(&self, name: &str, bytes: &[u8]) -> io::Result<(File, Version)> {
        self.check()?;
        let file = self.directory.create(OsStr::new(name), bytes)?;
        require_empty_acl(&file)?;
        let actual = self
            .directory
            .read_owned(OsStr::new(name))?
            .ok_or_else(invalid)?;
        if actual.0 != bytes || !actual.1.matches_metadata(&file.metadata()?) {
            return Err(invalid());
        }
        self.verify_created(name, &file, &actual.1)?;
        Ok((file, actual.1))
    }
    pub(super) fn write(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        if !layout::record_name(name) {
            return Err(invalid());
        }
        let count = layout::piece_count(bytes.len()).ok_or_else(invalid)?;
        self.check()?;
        match self.directory.open_metadata(OsStr::new(name)) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            _ => return Err(io::ErrorKind::AlreadyExists.into()),
        }
        let mut held = Vec::new();
        let mut pieces = Vec::new();
        for (index, part) in bytes.chunks(layout::PIECE_BYTES).enumerate() {
            let part_name = layout::piece_name(name, index).ok_or_else(invalid)?;
            let (file, version) = self.create(&part_name, part)?;
            pieces.push(Piece {
                name: part_name.clone(),
                bytes: part.len(),
                device: version.device,
                inode: version.inode,
                hash: version.hash.clone(),
            });
            held.push((part_name, file, version));
        }
        if held.len() != count {
            return Err(invalid());
        }
        let manifest = Manifest {
            version: 1,
            format: "macos-attachment-record-v1".into(),
            root: self.root_object,
            bytes: bytes.len(),
            hash: digest(bytes),
            pieces,
        };
        let encoded = serde_json::to_vec(&manifest).map_err(|_| invalid())?;
        for (name, file, version) in &held {
            self.verify_created(name, file, version)?;
        }
        let (file, version) = self.create(name, &encoded)?;
        for (name, file, version) in &held {
            self.verify_created(name, file, version)?;
        }
        self.verify_created(name, &file, &version)?;
        self.check()
    }
    pub(super) fn read(&self, name: &str) -> io::Result<Vec<u8>> {
        if !layout::record_name(name) {
            return Err(invalid());
        }
        self.check()?;
        let manifest = self
            .directory
            .read_owned(OsStr::new(name))?
            .ok_or_else(invalid)?;
        let parsed: Manifest = serde_json::from_slice(&manifest.0).map_err(|_| invalid())?;
        if parsed.version != 1
            || parsed.format != "macos-attachment-record-v1"
            || parsed.root != self.root_object
            || !layout::hash64(&parsed.hash)
            || layout::piece_count(parsed.bytes) != Some(parsed.pieces.len())
        {
            return Err(invalid());
        }
        let mut bytes = Vec::with_capacity(parsed.bytes);
        for (index, part) in parsed.pieces.iter().enumerate() {
            if layout::piece_name(name, index).as_deref() != Some(part.name.as_str())
                || layout::piece_len(parsed.bytes, parsed.pieces.len(), index) != Some(part.bytes)
                || !layout::hash64(&part.hash)
            {
                return Err(invalid());
            }
            let actual = self
                .directory
                .read_owned(OsStr::new(&part.name))?
                .ok_or_else(invalid)?;
            if actual.0.len() != part.bytes
                || (actual.1.device, actual.1.inode) != (part.device, part.inode)
                || actual.1.hash != part.hash
            {
                return Err(invalid());
            }
            bytes.extend_from_slice(&actual.0);
        }
        let again = self
            .directory
            .read_owned(OsStr::new(name))?
            .ok_or_else(invalid)?;
        if again.1 != manifest.1 || bytes.len() != parsed.bytes || digest(&bytes) != parsed.hash {
            return Err(invalid());
        }
        self.check()?;
        Ok(bytes)
    }
    pub(super) fn ids(&self) -> io::Result<Vec<String>> {
        self.check()?;
        let mut ids = self
            .directory
            .entries()?
            .into_iter()
            .filter_map(|entry| entry.into_string().ok())
            .filter(|entry| entry.len() == 37 && layout::record_name(entry))
            .map(|entry| entry[..32].to_owned())
            .collect::<Vec<_>>();
        if ids.len() > 4096 {
            return Err(invalid());
        }
        ids.sort();
        self.check()?;
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    fn replace_private_fixture(path: &std::path::Path, bytes: &[u8]) {
        let original = std::fs::metadata(path).unwrap();
        assert_eq!(original.mode() & 0o777, 0o600);
        assert_eq!(original.nlink(), 1);
        let retained = path.with_extension("retained");
        assert!(!retained.exists());
        std::fs::rename(path, &retained).unwrap();
        let mut replacement = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        replacement.write_all(bytes).unwrap();
        replacement.sync_all().unwrap();
        let actual = replacement.metadata().unwrap();
        assert_eq!(actual.mode() & 0o777, 0o600);
        assert_eq!(actual.nlink(), 1);
        assert_eq!((actual.uid(), actual.gid()), (original.uid(), original.gid()));
        assert_ne!((actual.dev(), actual.ino()), (original.dev(), original.ino()));
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(std::fs::read(retained).unwrap(), bytes);
    }
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Directory) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir(root.join(".luckyray")).unwrap();
        let directory = Directory::open(&root, false, false).unwrap();
        (temp, root, directory)
    }
    #[test]
    fn macos_operation_record_chunks_large_payload_and_refuses_manifest_replacement() {
        let (_temp, root, directory) = fixture();
        let store = Store::open(&directory, true).unwrap();
        let name = "a".repeat(32) + ".json";
        let bytes = vec![17; 32 * 1024 * 1024 + 1];
        store.write(&name, &bytes).unwrap();
        assert_eq!(store.read(&name).unwrap(), bytes);
        assert!(store.write(&name, b"replacement").is_err());
        assert_eq!(store.ids().unwrap(), vec!["a".repeat(32)]);
        let record = root
            .join(".luckyray/attachment-operations/macos")
            .join(&name);
        let same = std::fs::read(&record).unwrap();
        replace_private_fixture(&record, &same);
        // A fresh read observes a new valid manifest object, but cannot retarget
        // any piece: every piece remains bound to its stored inode and digest.
        assert_eq!(store.read(&name).unwrap(), bytes);
        let part = record.parent().unwrap().join(format!("{name}.part-000"));
        let data = std::fs::read(&part).unwrap();
        replace_private_fixture(&part, &data);
        // The replacement passes the real private file policy (including ACL)
        // before the manifest's stored piece identity is required to reject it.
        let qualified = store
            .directory
            .read_owned(part.file_name().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(qualified.0, data);
        assert!(store.read(&name).is_err());
    }
    #[test]
    fn macos_operation_store_refuses_linked_or_nonprivate_locations_without_chmod() {
        use std::os::unix::fs::symlink;
        let (_temp, root, directory) = fixture();
        let store = Store::open(&directory, true).unwrap();
        drop(store);
        let path = root.join(".luckyray/attachment-operations/macos");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Store::open(&directory, false).is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o755);
        // Qualify the target again so the link case cannot fail on mode alone.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        Store::open(&directory, false).unwrap();
        std::fs::rename(&path, path.with_extension("retained")).unwrap();
        symlink(path.with_extension("retained"), &path).unwrap();
        assert!(Store::open(&directory, false).is_err());
    }
}
