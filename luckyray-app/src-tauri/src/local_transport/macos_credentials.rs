//! Private credential files for the macOS local transport. The lifetime flock
//! serializes cooperating desktop instances; it is not a same-user sandbox.
use crate::macos_fs::{Directory, Version};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const RECORDS: [&str; 3] = [
    super::AUTH_FILE_NAME,
    "local-transport-materials-grants-v1.json",
    "local-transport-web-library-grants-v1.json",
];
const FAILURE: &str = "macos-credential-file-unsafe-or-conflicted";
const RECOVERY: &str = ".local-transport-recovery-required";
pub(super) struct Store {
    directory: Directory,
    versions: Mutex<BTreeMap<String, Option<Version>>>,
    _writer_lock: File,
    conflicted: AtomicBool,
}
impl Store {
    pub(super) fn open(path: &Path) -> Result<Self, String> {
        let directory = Directory::open(path, true, true).map_err(|_| FAILURE)?;
        if directory
            .read_owned(OsStr::new(RECOVERY))
            .map_err(|_| FAILURE)?
            .is_some()
        {
            return Err(FAILURE.into());
        }
        let lock = directory
            .lock(OsStr::new(".local-transport-writer.lock"))
            .map_err(|_| "macos-credential-writer-unavailable")?;
        if directory
            .read_owned(OsStr::new(RECOVERY))
            .map_err(|_| FAILURE)?
            .is_some()
        {
            return Err(FAILURE.into());
        }
        Ok(Self {
            directory,
            versions: Mutex::new(BTreeMap::new()),
            _writer_lock: lock,
            conflicted: AtomicBool::new(false),
        })
    }
    pub(super) fn available(&self) -> Result<(), String> {
        if self.conflicted.load(Ordering::Acquire) {
            return Err(FAILURE.into());
        }
        self.directory.current().map_err(|_| self.conflict())?;
        let versions = self.versions.lock().map_err(|_| FAILURE)?;
        for (name, expected) in versions.iter() {
            let current = self
                .directory
                .read(OsStr::new(name))
                .map_err(|_| self.conflict())?;
            if current.as_ref().map(|(_, version)| version) != expected.as_ref() {
                return Err(self.conflict());
            }
        }
        Ok(())
    }
    fn conflict(&self) -> String {
        self.conflicted.store(true, Ordering::Release);
        let _ = self
            .directory
            .create(OsStr::new(RECOVERY), b"credential-record-conflict\n");
        FAILURE.into()
    }
    pub(super) fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        self.available()?;
        if !RECORDS.contains(&name) {
            return Err(FAILURE.into());
        }
        let mut versions = self.versions.lock().map_err(|_| FAILURE)?;
        let current = self.directory.read(OsStr::new(name)).map_err(|_| FAILURE)?;
        let version = current.as_ref().map(|(_, version)| version.clone());
        if versions
            .get(name)
            .is_some_and(|expected| expected != &version)
        {
            return Err(self.conflict());
        }
        versions.insert(name.to_owned(), version);
        Ok(current.map(|(bytes, _)| bytes))
    }
    pub(super) fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.available()?;
        if !RECORDS.contains(&name) {
            return Err(FAILURE.into());
        }
        let mut versions = self.versions.lock().map_err(|_| FAILURE)?;
        let expected = versions.get(name).ok_or(FAILURE)?.clone();
        let current = self
            .directory
            .read(OsStr::new(name))
            .map_err(|_| self.conflict())?;
        if current.as_ref().map(|(_, v)| v) != expected.as_ref() {
            return Err(self.conflict());
        }
        let temporary = format!(".lr-auth-{}.previous", super::random_hex(16));
        let staged = self
            .directory
            .create(OsStr::new(&temporary), bytes)
            .map_err(|_| FAILURE)?;
        self.directory
            .rename(OsStr::new(&temporary), OsStr::new(name), expected.is_some())
            .map_err(|_| self.conflict())?;
        let installed = self
            .directory
            .read(OsStr::new(name))
            .map_err(|_| self.conflict())?
            .ok_or_else(|| self.conflict())?;
        use std::os::unix::fs::MetadataExt;
        let staged_meta = staged.metadata().map_err(|_| self.conflict())?;
        if installed.1.device != staged_meta.dev()
            || installed.1.inode != staged_meta.ino()
            || installed.0 != bytes
        {
            return Err(self.conflict());
        }
        if let Some(expected) = expected {
            let previous = self
                .directory
                .read(OsStr::new(&temporary))
                .map_err(|_| self.conflict())?
                .ok_or_else(|| self.conflict())?;
            if previous.1 != expected {
                // Preserve the displaced version for recovery. Do not accept a
                // credential rotation which raced another writer.
                return Err(self.conflict());
            }
            // The new record is verified and committed. A cleanup failure keeps
            // a private previous version, without pretending the commit failed.
            let _ = self.directory.remove(OsStr::new(&temporary), &previous.1);
        }
        versions.insert(name.to_owned(), Some(installed.1));
        Ok(())
    }
}

pub(super) fn read_native(path: &Path) -> Result<Vec<u8>, String> {
    let directory = Directory::open(path, false, true).map_err(|_| FAILURE)?;
    if directory
        .read_owned(OsStr::new(RECOVERY))
        .map_err(|_| FAILURE)?
        .is_some()
    {
        return Err(FAILURE.into());
    }
    directory
        .read(OsStr::new(super::AUTH_FILE_NAME))
        .map_err(|_| FAILURE)?
        .map(|(bytes, _)| bytes)
        .ok_or_else(|| "app-unavailable".into())
}
