//! Create-only, descriptor-relative Linux import commits with durable inode evidence.
//! The root flock coordinates cooperating writers. Same-user external changes
//! are detected at validation boundaries, not forcibly excluded as on Windows.
//! Never overwrite/unlink a user object. Rollback is deliberately not admitted.
use crate::linux_fs::{conflict, private_file_metadata, Directory, Snapshot, Version};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

pub(crate) const MAX_FILE: usize = 64 * 1024 * 1024;
pub(crate) const MAX_INTENT: usize = 384 * 1024 * 1024;
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn id_valid(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn relative(value: &str) -> io::Result<PathBuf> {
    if value.is_empty()
        || value.trim() != value
        || value.contains(['\\', ':', '\0'])
        || value.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(conflict());
    }
    let path = Path::new(value);
    for part in path.components() {
        let Component::Normal(name) = part else {
            return Err(conflict());
        };
        let name = name.to_str().ok_or_else(conflict)?;
        if [".luckyray", ".git", ".obsidian"]
            .iter()
            .any(|reserved| name.eq_ignore_ascii_case(reserved))
            || name.starts_with(".lrk-")
        {
            return Err(conflict());
        }
    }
    Ok(path.to_owned())
}

fn private_read(dir: &Directory, name: &OsStr, limit: usize) -> io::Result<Option<Snapshot>> {
    let value = dir.read(name, true, limit)?;
    if let Some(value) = &value {
        private_file_metadata(&value.file)?;
    }
    Ok(value)
}

/// Held read-only dependency; no-follow traversal and inode/version/digest recheck.
pub(crate) struct Dependency {
    directory: Directory,
    name: OsString,
    snapshot: Snapshot,
}
impl Dependency {
    pub(crate) fn open(path: &Path, digest: &str) -> io::Result<Self> {
        let directory = Directory::open(path.parent().ok_or_else(conflict)?)?;
        let name = path.file_name().ok_or_else(conflict)?.to_owned();
        let snapshot = directory
            .read(&name, false, MAX_FILE)?
            .ok_or_else(conflict)?;
        if hash(&snapshot.bytes) != digest {
            return Err(conflict());
        }
        Ok(Self {
            directory,
            name,
            snapshot,
        })
    }
    pub(crate) fn verify(&self) -> io::Result<()> {
        let now = self
            .directory
            .read(&self.name, false, MAX_FILE)?
            .ok_or_else(conflict)?;
        if now.version != self.snapshot.version || now.bytes != self.snapshot.bytes {
            return Err(conflict());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    version: u32,
    relative: String,
    digest: String,
    context: String,
    signature: String,
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    modified: (i64, i64),
}
impl Step {
    fn capture(relative: &str, context: &str, snapshot: &Snapshot) -> io::Result<Self> {
        private_file_metadata(&snapshot.file)?;
        let m = snapshot.file.metadata()?;
        Ok(Self {
            version: 1,
            relative: relative.into(),
            digest: hash(&snapshot.bytes),
            context: context.into(),
            signature: String::new(),
            device: m.dev(),
            inode: m.ino(),
            uid: m.uid(),
            gid: m.gid(),
            mode: m.mode(),
            modified: (m.mtime(), m.mtime_nsec()),
        })
    }
    fn matches(&self, relative: &str, bytes: &[u8], snapshot: &Snapshot) -> io::Result<()> {
        let now = Self::capture(relative, &self.context, snapshot)?;
        if self.version != 1
            || self.relative != relative
            || self.digest != hash(bytes)
            || snapshot.bytes != bytes
            || self.device != now.device
            || self.inode != now.inode
            || self.uid != now.uid
            || self.gid != now.gid
            || self.mode != now.mode
            || self.modified != now.modified
        {
            return Err(conflict());
        }
        Ok(())
    }
    fn signature(&self, key: &[u8; 32]) -> io::Result<String> {
        let mut unsigned = self.clone();
        unsigned.signature.clear();
        let payload = serde_json::to_vec(&unsigned).map_err(|_| conflict())?;
        let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| conflict())?;
        mac.update(b"luckyray-linux-import-step-v1\0");
        mac.update(&payload);
        Ok(format!("{:x}", mac.finalize().into_bytes()))
    }
    fn verify_authority(&self, context: &str, key: &[u8; 32]) -> io::Result<()> {
        let expected = self.signature(key)?;
        if self.context != context
            || self.signature.len() != expected.len()
            || self
                .signature
                .bytes()
                .zip(expected.bytes())
                .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                != 0
        {
            return Err(conflict());
        }
        Ok(())
    }
}

pub(crate) struct ImportStore {
    root: Directory,
    metadata: Directory,
    recovery: Directory,
    _lease: File,
    id: String,
    intent_hash: OnceLock<String>,
    intent_identity: OnceLock<(File, Version)>,
}
impl ImportStore {
    pub(crate) fn open(root: &Path, id: &str, create: bool) -> io::Result<Self> {
        if !id_valid(id) {
            return Err(conflict());
        }
        let root = Directory::owned(root, false)?;
        crate::linux_fs::no_default_acl(&root.file)?;
        let lease = root.lock()?;
        let metadata = root.child_owned(OsStr::new(".luckyray"), false, false)?;
        let recovery = metadata.child_owned(OsStr::new("attachment-operations"), create, true)?;
        Ok(Self {
            root,
            metadata,
            recovery,
            _lease: lease,
            id: id.into(),
            intent_hash: OnceLock::new(),
            intent_identity: OnceLock::new(),
        })
    }
    pub(crate) fn root_identity(&self) -> io::Result<String> {
        self.verify()?;
        let m = self.root.file.metadata()?;
        Ok(format!("unix-v1-{}-{}", m.dev(), m.ino()))
    }
    pub(crate) fn verify(&self) -> io::Result<()> {
        self.root.verify()?;
        self.metadata.verify()?;
        self.recovery.verify()?;
        if let Some((file, version)) = self.intent_identity.get() {
            private_file_metadata(file)?;
            if &Version::of(file)? != version {
                return Err(conflict());
            }
            self.recovery
                .verify_named(OsStr::new(&format!("{}.json", self.id)), file)?;
        }
        Ok(())
    }
    pub(crate) fn write_intent(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > MAX_INTENT {
            return Err(conflict());
        }
        self.verify()?;
        let file = self
            .recovery
            .create_private(OsStr::new(&format!("{}.json", self.id)), bytes)?;
        let version = Version::of(&file)?;
        self.intent_identity
            .set((file, version))
            .map_err(|_| conflict())?;
        self.intent_hash.set(hash(bytes)).map_err(|_| conflict())?;
        Ok(())
    }
    pub(crate) fn read_intent(&self) -> io::Result<Vec<u8>> {
        self.verify()?;
        let snapshot = private_read(
            &self.recovery,
            OsStr::new(&format!("{}.json", self.id)),
            MAX_INTENT,
        )?
        .ok_or_else(conflict)?;
        let bytes = snapshot.bytes;
        let _ = self.intent_identity.set((snapshot.file, snapshot.version));
        let _ = self.intent_hash.set(hash(&bytes));
        Ok(bytes)
    }
    pub(crate) fn append_result(&self, nonce: &str, bytes: &[u8]) -> io::Result<()> {
        if !id_valid(nonce) || bytes.len() > MAX_FILE {
            return Err(conflict());
        }
        self.verify()?;
        self.recovery.create_private(
            OsStr::new(&format!("{}-{nonce}.result.json", self.id)),
            bytes,
        )?;
        Ok(())
    }
    fn parent(&self, path: &Path, create: bool) -> io::Result<Directory> {
        self.verify()?;
        // Start with a duplicate of the held root, not a reopened caller path.
        let mut directory = self.root.try_clone()?;
        for part in path.parent().unwrap_or(Path::new("")).components() {
            let Component::Normal(name) = part else {
                return Err(conflict());
            };
            directory = directory.child_owned(name, create, false)?;
        }
        Ok(directory)
    }
    pub(crate) fn require_vacant(&self, value: &str) -> io::Result<()> {
        let path = relative(value)?;
        let parent = match self.parent(&path, false) {
            Ok(parent) => parent,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        match parent.read(path.file_name().ok_or_else(conflict)?, false, MAX_FILE)? {
            None => Ok(()),
            Some(_) => Err(io::Error::from(io::ErrorKind::AlreadyExists)),
        }
    }

    pub(crate) fn list_ids(root: &Path) -> io::Result<Vec<String>> {
        let store = Self::open(root, "00000000000000000000000000000000", false)?;
        let mut ids = Vec::new();
        for (index, entry) in
            std::fs::read_dir(format!("/proc/self/fd/{}", store.recovery.file.as_raw_fd()))?
                .enumerate()
        {
            if index >= 4096 {
                return Err(conflict());
            }
            let entry = entry?;
            let name = entry.file_name();
            if let Some(id) = name
                .to_str()
                .and_then(|name| name.strip_suffix(".json"))
                .filter(|id| id_valid(id))
            {
                let file = store.recovery.open_file(&name, true)?;
                private_file_metadata(&file)?;
                if file.metadata()?.len() > MAX_INTENT as u64 {
                    return Err(conflict());
                }
                ids.push(id.to_owned());
            }
        }
        store.verify()?;
        ids.sort();
        Ok(ids)
    }

    pub(crate) fn verify_installed(
        &self,
        index: usize,
        value: &str,
        bytes: &[u8],
        key: &[u8; 32],
    ) -> io::Result<()> {
        self.verify()?;
        if index >= 1024 || bytes.len() > MAX_FILE {
            return Err(conflict());
        }
        if self.intent_hash.get().is_none() {
            self.read_intent()?;
        }
        let context = format!(
            "{}:{index}:{}",
            self.id,
            self.intent_hash.get().ok_or_else(conflict)?
        );
        let step = private_read(
            &self.recovery,
            OsStr::new(&format!("{}-{index}.step.json", self.id)),
            16 * 1024,
        )?
        .ok_or_else(conflict)?;
        let step: Step = serde_json::from_slice(&step.bytes).map_err(|_| conflict())?;
        step.verify_authority(&context, key)?;
        let path = relative(value)?;
        let parent = self.parent(&path, false)?;
        let target = private_read(&parent, path.file_name().ok_or_else(conflict)?, MAX_FILE)?
            .ok_or_else(conflict)?;
        step.matches(value, bytes, &target)?;
        self.verify()
    }
    /// true means this transaction's recorded inode was already durably installed.
    pub(crate) fn install(
        &self,
        index: usize,
        value: &str,
        bytes: &[u8],
        key: &[u8; 32],
        mut admit: impl FnMut() -> io::Result<()>,
    ) -> io::Result<bool> {
        if index >= 1024 || bytes.len() > MAX_FILE {
            return Err(conflict());
        }
        let intent = self
            .recovery
            .open_file(OsStr::new(&format!("{}.json", self.id)), true)?;
        private_file_metadata(&intent)?;
        if intent.metadata()?.len() == 0 || intent.metadata()?.len() > MAX_INTENT as u64 {
            return Err(conflict());
        }
        if self.intent_hash.get().is_none() {
            self.read_intent()?;
        }
        let context = format!(
            "{}:{index}:{}",
            self.id,
            self.intent_hash.get().ok_or_else(conflict)?
        );
        let path = relative(value)?;
        let parent = self.parent(&path, true)?;
        let name = path.file_name().ok_or_else(conflict)?;
        let step_name = format!("{}-{index}.step.json", self.id);
        let existing = private_read(&self.recovery, OsStr::new(&step_name), 16 * 1024)?;
        let step: Option<Step> = existing
            .as_ref()
            .map(|s| serde_json::from_slice(&s.bytes).map_err(|_| conflict()))
            .transpose()?;
        if let Some(step) = &step {
            step.verify_authority(&context, key)?;
        }
        if let Some(target) = private_read(&parent, name, MAX_FILE)? {
            step.ok_or_else(conflict)?.matches(value, bytes, &target)?;
            admit()?;
            self.verify()?;
            return Ok(true);
        }
        admit()?;
        let stage_name = format!(".lrk-import-{}-{index}.tmp", self.id);
        let stage_name = OsStr::new(&stage_name);
        let stage = match private_read(&parent, stage_name, MAX_FILE)? {
            Some(stage) => stage,
            None if step.is_none() => {
                parent.create_private(stage_name, bytes)?;
                private_read(&parent, stage_name, MAX_FILE)?.ok_or_else(conflict)?
            }
            None => return Err(conflict()),
        };
        if stage.bytes != bytes {
            return Err(conflict());
        }
        let step = match step {
            Some(step) => {
                step.matches(value, bytes, &stage)?;
                step
            }
            None => {
                let mut step = Step::capture(value, &context, &stage)?;
                step.signature = step.signature(key)?;
                let encoded = serde_json::to_vec(&step).map_err(|_| conflict())?;
                self.recovery
                    .create_private(OsStr::new(&step_name), &encoded)?;
                step
            }
        };
        // Durable intent + stage inode evidence precede the only publication.
        admit()?;
        self.verify()?;
        step.matches(
            value,
            bytes,
            &private_read(&parent, stage_name, MAX_FILE)?.ok_or_else(conflict)?,
        )?;
        parent.verify_named(stage_name, &stage.file)?;
        parent.rename_new(stage_name, &parent, name)?;
        step.matches(
            value,
            bytes,
            &private_read(&parent, name, MAX_FILE)?.ok_or_else(conflict)?,
        )?;
        admit()?;
        self.verify()?;
        Ok(false)
    }
}
