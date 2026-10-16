//! Fixed-name, bounded, application-owned staging. No caller-controlled path is accepted.
use super::verification::{admit_version, official_artifact, MAX_PACKAGE_BYTES};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Intent {
    pub version: String,
    pub url: String,
    pub signature: String,
}
impl Intent {
    pub(crate) fn validate(&self, installed: &str) -> Result<(), &'static str> {
        admit_version(installed, &self.version)?;
        official_artifact(&self.version, &self.url)?;
        if self.signature.len() > 16384 || self.signature.is_empty() {
            return Err("update-signature-invalid");
        }
        Ok(())
    }
}
pub(crate) struct Store {
    root: PathBuf,
}
impl Store {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    pub(crate) fn ensure(&self) -> Result<(), &'static str> {
        fs::create_dir_all(&self.root).map_err(|_| "update-cache-unavailable")
    }
    fn remove(&self, name: &str) -> Result<(), &'static str> {
        match fs::remove_file(self.path(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("update-cache-unavailable"),
        }
    }
    fn write_new(&self, name: &str, bytes: &[u8]) -> Result<(), &'static str> {
        self.ensure()?;
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path(name))
            .map_err(|_| "update-cache-unavailable")?;
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(|_| "update-cache-unavailable")
    }
    /// Publish intent last; an interrupted package write never authorizes installation.
    pub(crate) fn schedule(&self, intent: &Intent, bytes: &[u8]) -> Result<(), &'static str> {
        self.cancel()?;
        self.remove("attempt.json")?;
        self.write_new("package.bin", bytes)?;
        let json = serde_json::to_vec(intent).map_err(|_| "update-cache-unavailable")?;
        self.write_new("intent.tmp", &json)?;
        fs::rename(self.path("intent.tmp"), self.path("intent.json"))
            .map_err(|_| "update-cache-unavailable")
    }
    pub(crate) fn cancel(&self) -> Result<(), &'static str> {
        // Remove admission before removing data, so cleanup failure cannot start an update.
        self.remove("intent.json")?;
        self.remove("intent.tmp")?;
        self.remove("package.bin")
    }
    fn read_bounded(&self, name: &str, max: usize) -> Result<Vec<u8>, &'static str> {
        let file = fs::File::open(self.path(name)).map_err(|_| "update-cache-unavailable")?;
        if file
            .metadata()
            .map_err(|_| "update-cache-unavailable")?
            .len()
            > max as u64
        {
            return Err("update-cache-invalid");
        }
        let mut bytes = Vec::new();
        file.take(max as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "update-cache-unavailable")?;
        if bytes.len() > max {
            return Err("update-cache-invalid");
        }
        Ok(bytes)
    }
    pub(crate) fn pending(&self) -> bool {
        self.path("intent.json").exists()
    }
    /// Immediate handoff is one attempt, not a pending next-start instruction.
    /// Publish the diagnostic record before launching; cancellation/crash must
    /// not make startup silently install the same package again.
    pub(crate) fn begin_immediate_attempt(&self, intent: &Intent) -> Result<(), &'static str> {
        self.remove("intent.json")?;
        self.remove("attempt.tmp")?;
        self.remove("attempt.json")?;
        let bytes = serde_json::to_vec(intent).map_err(|_| "update-cache-unavailable")?;
        self.write_new("attempt.tmp", &bytes)?;
        fs::rename(self.path("attempt.tmp"), self.path("attempt.json"))
            .map_err(|_| "update-cache-unavailable")
    }
    /// Consume before any attempt. Crashes/canceled installers cannot form a restart loop.
    pub(crate) fn take_intent(&self) -> Result<Option<Intent>, &'static str> {
        if !self.pending() {
            return Ok(None);
        }
        self.remove("attempt.json")?;
        fs::rename(self.path("intent.json"), self.path("attempt.json"))
            .map_err(|_| "update-cache-unavailable")?;
        let bytes = self.read_bounded("attempt.json", 32768)?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "update-cache-invalid")
    }
    pub(crate) fn package(&self) -> Result<Vec<u8>, &'static str> {
        self.read_bounded("package.bin", MAX_PACKAGE_BYTES)
    }
    pub(crate) fn unfinished_attempt(&self) -> bool {
        self.path("attempt.json").exists()
    }
    pub(crate) fn attempt(&self) -> Result<Intent, &'static str> {
        serde_json::from_slice(&self.read_bounded("attempt.json", 32768)?)
            .map_err(|_| "update-cache-invalid")
    }
    pub(crate) fn clear_attempt(&self) -> Result<(), &'static str> {
        self.cancel()?;
        self.remove("attempt.json")?;
        // Keep extracted installers until explicit cache maintenance. Do not follow cache junctions
        // or race a still-running installer while cleaning up a confirmed update.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> Store {
        let root = std::env::temp_dir().join(format!(
            "lr-update-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Store::new(root)
    }
    fn intent() -> Intent {
        Intent{version:"1.0.1".into(),url:"https://github.com/xiaorui2886/LuckyRay/releases/download/v1.0.1/LuckyRay_1.0.1_x64-setup.exe".into(),signature:"fixture-not-trusted".into()}
    }
    #[test]
    fn immediate_handoff_records_one_attempt_without_scheduling_another_start() {
        let s = store();
        s.schedule(&intent(), b"fixture").unwrap();
        s.begin_immediate_attempt(&intent()).unwrap();
        assert!(!s.pending());
        assert!(s.take_intent().unwrap().is_none());
        assert_eq!(s.attempt().unwrap().version, "1.0.1");
        assert_eq!(s.package().unwrap(), b"fixture");
        fs::remove_dir_all(s.root()).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn locked_cache_cleanup_cannot_publish_an_install_intent() {
        // An actual Windows handle denies replacement/removal in this unique
        // test root. This is sharing-denial coverage, not an ACL/full-disk test.
        use std::os::windows::fs::OpenOptionsExt;
        let s = store();
        s.write_new("package.bin", b"previous fixture").unwrap();
        let path = s.path("package.bin");
        let held = OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
        let result = s.schedule(&intent(), b"new fixture");
        drop(held);
        assert_eq!(result, Err("update-cache-unavailable"));
        assert!(!s.pending());
        assert!(s.take_intent().unwrap().is_none());
        assert_eq!(s.package().unwrap(), b"previous fixture");
        fs::remove_dir_all(s.root()).unwrap();
    }
    #[test]
    fn attempts_are_consumed_once() {
        let s = store();
        s.schedule(&intent(), b"fixture").unwrap();
        assert!(s.take_intent().unwrap().is_some());
        assert!(s.take_intent().unwrap().is_none());
        assert!(s.unfinished_attempt());
        assert_eq!(s.package().unwrap(), b"fixture");
        fs::remove_dir_all(s.root()).unwrap();
    }
    #[test]
    fn cancellation_removes_admission() {
        let s = store();
        s.schedule(&intent(), b"fixture").unwrap();
        s.cancel().unwrap();
        assert!(!s.pending());
        assert!(s.package().is_err());
        fs::remove_dir_all(s.root()).unwrap();
    }
    #[test]
    fn damaged_intent_cannot_loop() {
        let s = store();
        s.write_new("intent.json", b"not json").unwrap();
        assert!(s.take_intent().is_err());
        assert!(!s.pending());
        assert!(s.take_intent().unwrap().is_none());
        fs::remove_dir_all(s.root()).unwrap();
    }
    #[test]
    fn intent_never_accepts_path_or_extra_fields() {
        let mut i = intent();
        i.url = "file:///tmp/a.exe".into();
        assert!(i.validate("1.0.0").is_err());
        assert!(serde_json::from_str::<Intent>(
            r#"{"version":"1.0.1","url":"x","signature":"x","path":"C:\\other.exe"}"#
        )
        .is_err());
    }
}
