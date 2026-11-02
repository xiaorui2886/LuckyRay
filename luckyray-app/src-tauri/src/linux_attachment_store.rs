//! Descriptor-relative Linux attachment commits with durable inode evidence.
//! The root flock coordinates cooperating writers. Same-user external changes
//! are detected at validation boundaries, not forcibly excluded as on Windows.
//! Three verbs exist: `Create` publishes a new name, `Replace` rewrites an
//! existing Markdown note, `Remove` renames an attachment to a tombstone.
//! Nothing here unlinks a user object, so a rollback can rename the original
//! inode back instead of reconstructing it from bytes.
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
/// Domain separation for the legacy create-only record. Records written before
/// this module learned `Replace`/`Remove` must keep verifying byte for byte so
/// an import that is in flight during an upgrade still recovers.
const LEGACY_STEP_DOMAIN: &[u8] = b"luckyray-linux-import-step-v1\0";
const STEP_DOMAIN: &[u8] = b"luckyray-linux-import-step-v2\0";
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

/// The closed set of physical actions. There is deliberately no fourth verb and
/// no "delete": `Remove` only renames, so its inverse is a rename.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Verb {
    Create,
    Replace,
    Remove,
}

/// The inode observed when the evidence was written. `Version` additionally
/// tracks ctime for read snapshots; this subset is what the sealed step binds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: u64,
    inode: u64,
    length: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    modified: (i64, i64),
}

impl Identity {
    fn of(file: &File) -> io::Result<Self> {
        let m = file.metadata()?;
        if !m.is_file() || m.nlink() != 1 {
            return Err(conflict());
        }
        Ok(Self {
            device: m.dev(),
            inode: m.ino(),
            length: m.len(),
            uid: m.uid(),
            gid: m.gid(),
            mode: m.mode(),
            modified: (m.mtime(), m.mtime_nsec()),
        })
    }
    fn same(&self, other: &Self) -> bool {
        self.device == other.device
            && self.inode == other.inode
            && self.length == other.length
            && self.uid == other.uid
            && self.gid == other.gid
            && self.mode == other.mode
            && self.modified == other.modified
    }
}

/// Object identity plus content digest of the state before the step.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Before {
    identity: Identity,
    digest: String,
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
    // Appended after every v1 field so a legacy record re-serializes to exactly
    // the bytes its v1 signature covers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    verb: Option<Verb>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    before: Option<Before>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tombstone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
}
impl Step {
    /// A published name. The stage is renamed into place, so the identity
    /// captured here is the identity at the target.
    fn capture_create(
        relative: &str,
        context: &str,
        stage: &str,
        snapshot: &Snapshot,
    ) -> io::Result<Self> {
        private_file_metadata(&snapshot.file)?;
        let identity = Identity::of(&snapshot.file)?;
        Ok(Self {
            version: 2,
            relative: relative.into(),
            digest: hash(&snapshot.bytes),
            context: context.into(),
            signature: String::new(),
            device: identity.device,
            inode: identity.inode,
            uid: identity.uid,
            gid: identity.gid,
            mode: identity.mode,
            modified: identity.modified,
            verb: Some(Verb::Create),
            before: None,
            tombstone: None,
            stage: Some(stage.into()),
        })
    }
    /// A rewritten Markdown note. Publication creates a new inode, so only the
    /// pre-state identity and the post-state digest can be proven in advance.
    fn capture_replace(
        relative: &str,
        context: &str,
        before: Identity,
        before_digest: &str,
        after_digest: &str,
    ) -> Self {
        Self {
            version: 2,
            relative: relative.into(),
            digest: after_digest.into(),
            context: context.into(),
            signature: String::new(),
            device: before.device,
            inode: before.inode,
            uid: before.uid,
            gid: before.gid,
            mode: before.mode,
            modified: before.modified,
            verb: Some(Verb::Replace),
            before: Some(Before {
                identity: before,
                digest: before_digest.into(),
            }),
            tombstone: None,
            stage: None,
        }
    }
    /// An attachment moved aside to its tombstone name.
    fn capture_remove(
        relative: &str,
        context: &str,
        tombstone: &str,
        snapshot: &Snapshot,
    ) -> io::Result<Self> {
        private_file_metadata(&snapshot.file)?;
        let identity = Identity::of(&snapshot.file)?;
        let digest = hash(&snapshot.bytes);
        Ok(Self {
            version: 2,
            relative: relative.into(),
            digest: digest.clone(),
            context: context.into(),
            signature: String::new(),
            device: identity.device,
            inode: identity.inode,
            uid: identity.uid,
            gid: identity.gid,
            mode: identity.mode,
            modified: identity.modified,
            verb: Some(Verb::Remove),
            before: Some(Before { identity, digest }),
            tombstone: Some(tombstone.into()),
            stage: None,
        })
    }
    fn verb(&self) -> io::Result<Verb> {
        match (self.version, self.verb) {
            (1, None) => Ok(Verb::Create),
            (2, Some(verb)) => Ok(verb),
            _ => Err(conflict()),
        }
    }
    fn shape(&self) -> io::Result<()> {
        let digest_valid = |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
        if !digest_valid(&self.digest) {
            return Err(conflict());
        }
        let shaped = match self.verb()? {
            Verb::Create => self.before.is_none() && self.tombstone.is_none(),
            Verb::Replace => self.before.is_some() && self.tombstone.is_none(),
            Verb::Remove => {
                self.tombstone.is_some()
                    && self
                        .before
                        .as_ref()
                        .is_some_and(|before| before.digest == self.digest)
            }
        };
        if !shaped {
            return Err(conflict());
        }
        if let Some(before) = &self.before {
            if !digest_valid(&before.digest) {
                return Err(conflict());
            }
        }
        if let Some(tombstone) = &self.tombstone {
            if tombstone.len() <= ".lrk-.removed".len()
                || !tombstone.starts_with(".lrk-")
                || !tombstone.ends_with(".removed")
                || tombstone.contains('/')
            {
                return Err(conflict());
            }
        }
        Ok(())
    }
    /// `Create`: the published inode itself, proven by identity and content.
    fn verify_created(&self, relative: &str, bytes: &[u8], snapshot: &Snapshot) -> io::Result<()> {
        private_file_metadata(&snapshot.file)?;
        let identity = Identity::of(&snapshot.file)?;
        if self.verb()? != Verb::Create
            || self.relative != relative
            || self.digest != hash(bytes)
            || snapshot.bytes != bytes
            || self.device != identity.device
            || self.inode != identity.inode
            || self.uid != identity.uid
            || self.gid != identity.gid
            || self.mode != identity.mode
            || self.modified != identity.modified
        {
            return Err(conflict());
        }
        Ok(())
    }
    /// `Replace`: only the content can be proven after publication.
    fn verify_replaced(&self, relative: &str, snapshot: &Snapshot) -> io::Result<()> {
        if self.verb()? != Verb::Replace
            || self.relative != relative
            || self.digest != hash(&snapshot.bytes)
        {
            return Err(conflict());
        }
        Ok(())
    }
    /// `Replace`/`Remove`: the snapshot is the recorded pre-state object.
    fn verify_before(
        &self,
        relative: &str,
        snapshot: &Snapshot,
        verb: Verb,
        private: bool,
    ) -> io::Result<()> {
        if private {
            private_file_metadata(&snapshot.file)?;
        }
        let identity = Identity::of(&snapshot.file)?;
        let before = self.before.as_ref().ok_or_else(conflict)?;
        if self.verb()? != verb
            || self.relative != relative
            || before.digest != hash(&snapshot.bytes)
            || !before.identity.same(&identity)
        {
            return Err(conflict());
        }
        Ok(())
    }
    fn signature(&self, key: &[u8; 32]) -> io::Result<String> {
        let mut unsigned = self.clone();
        unsigned.signature.clear();
        let payload = serde_json::to_vec(&unsigned).map_err(|_| conflict())?;
        let domain: &[u8] = match self.version {
            1 => LEGACY_STEP_DOMAIN,
            2 => STEP_DOMAIN,
            _ => return Err(conflict()),
        };
        let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| conflict())?;
        mac.update(domain);
        mac.update(&payload);
        Ok(format!("{:x}", mac.finalize().into_bytes()))
    }
    fn verify_authority(&self, context: &str, key: &[u8; 32]) -> io::Result<()> {
        self.shape()?;
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

    fn context(&self, index: usize) -> io::Result<String> {
        if self.intent_hash.get().is_none() {
            self.read_intent()?;
        }
        Ok(format!(
            "{}:{index}:{}",
            self.id,
            self.intent_hash.get().ok_or_else(conflict)?
        ))
    }

    /// Optional sealed evidence for one step. Absence is normal before the step
    /// runs; presence must verify, including the v1 records of an import that
    /// was already in flight when this build started.
    fn read_step(&self, index: usize, key: &[u8; 32]) -> io::Result<Option<Step>> {
        if index >= 1024 {
            return Err(conflict());
        }
        let context = self.context(index)?;
        let existing = private_read(
            &self.recovery,
            OsStr::new(&format!("{}-{index}.step.json", self.id)),
            16 * 1024,
        )?;
        let step: Option<Step> = existing
            .as_ref()
            .map(|snapshot| serde_json::from_slice(&snapshot.bytes).map_err(|_| conflict()))
            .transpose()?;
        if let Some(step) = &step {
            step.verify_authority(&context, key)?;
        }
        Ok(step)
    }

    /// Durable evidence before the only publication. `create_private` fsyncs the
    /// record and the directory, so a crash afterwards is explainable.
    fn write_step(&self, index: usize, step: &Step, key: &[u8; 32]) -> io::Result<Step> {
        let mut sealed = step.clone();
        let signature = sealed.signature(key)?;
        sealed.signature = signature;
        let encoded = serde_json::to_vec(&sealed).map_err(|_| conflict())?;
        self.recovery
            .create_private(OsStr::new(&format!("{}-{index}.step.json", self.id)), &encoded)?;
        Ok(sealed)
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
        let step = self.read_step(index, key)?.ok_or_else(conflict)?;
        let path = relative(value)?;
        let parent = self.parent(&path, false)?;
        let target = private_read(&parent, path.file_name().ok_or_else(conflict)?, MAX_FILE)?
            .ok_or_else(conflict)?;
        step.verify_created(value, bytes, &target)?;
        self.verify()
    }

    /// Prove one executed step of any verb. `Remove` proves the tombstone, not
    /// the now-vacant original name.
    pub(crate) fn verify_step(
        &self,
        index: usize,
        value: &str,
        before: Option<&[u8]>,
        after: Option<&[u8]>,
        key: &[u8; 32],
    ) -> io::Result<()> {
        self.verify()?;
        if index >= 1024
            || before.is_some_and(|bytes| bytes.len() > MAX_FILE)
            || after.is_some_and(|bytes| bytes.len() > MAX_FILE)
        {
            return Err(conflict());
        }
        let step = self.read_step(index, key)?.ok_or_else(conflict)?;
        let path = relative(value)?;
        let parent = self.parent(&path, false)?;
        let name = path.file_name().ok_or_else(conflict)?;
        match step.verb()? {
            Verb::Create => {
                let content = after.ok_or_else(conflict)?;
                let target = private_read(&parent, name, MAX_FILE)?.ok_or_else(conflict)?;
                step.verify_created(value, content, &target)?;
            }
            Verb::Replace => {
                if after.is_none() {
                    return Err(conflict());
                }
                let target = parent.read(name, false, MAX_FILE)?.ok_or_else(conflict)?;
                step.verify_replaced(value, &target)?;
                if let Some(previous) = before {
                    let digest = hash(previous);
                    if step.before.as_ref().map(|record| record.digest.as_str())
                        != Some(digest.as_str())
                    {
                        return Err(conflict());
                    }
                }
            }
            Verb::Remove => {
                let previous = hash(before.ok_or_else(conflict)?);
                let tombstone = step.tombstone.as_deref().ok_or_else(conflict)?;
                if step.digest != previous {
                    return Err(conflict());
                }
                let tomb = private_read(&parent, OsStr::new(tombstone), MAX_FILE)?
                    .ok_or_else(conflict)?;
                step.verify_before(value, &tomb, Verb::Remove, true)?;
            }
        }
        self.verify()
    }

    /// Prove the pre-operation state after a rollback: the original bytes are
    /// back and, for `Remove`, the original inode was renamed back.
    pub(crate) fn verify_before_state(
        &self,
        index: usize,
        value: &str,
        before: &[u8],
        key: &[u8; 32],
    ) -> io::Result<()> {
        self.verify()?;
        if index >= 1024 || before.len() > MAX_FILE {
            return Err(conflict());
        }
        let digest = hash(before);
        let step = self.read_step(index, key)?.ok_or_else(conflict)?;
        let path = relative(value)?;
        let parent = self.parent(&path, false)?;
        let name = path.file_name().ok_or_else(conflict)?;
        match step.verb()? {
            Verb::Create => return Err(conflict()),
            Verb::Replace => {
                let target = parent.read(name, false, MAX_FILE)?.ok_or_else(conflict)?;
                if step.before.as_ref().map(|record| record.digest.as_str())
                    != Some(digest.as_str())
                    || hash(&target.bytes) != digest
                {
                    return Err(conflict());
                }
            }
            Verb::Remove => {
                let target = private_read(&parent, name, MAX_FILE)?.ok_or_else(conflict)?;
                step.verify_before(value, &target, Verb::Remove, true)?;
            }
        }
        self.verify()
    }

    /// Publish through the journalled note writer. The Vault lease already
    /// excludes cooperating writers, and re-locking the root directory from
    /// this process would fail rather than exclude anyone.
    fn publish_replace(
        &self,
        parent: &Directory,
        name: &OsStr,
        expected: &Snapshot,
        bytes: &[u8],
    ) -> io::Result<Snapshot> {
        if parent.path == self.root.path {
            crate::linux_file_store::write_locked(parent, name, Some(expected), bytes, false)
        } else {
            crate::linux_file_store::write(parent, name, Some(expected), bytes, false, false, false)
        }
    }

    /// Rewrite an existing Markdown note after proving the inode and its bytes.
    /// true means the recorded after-state was already published.
    pub(crate) fn install_replace(
        &self,
        index: usize,
        value: &str,
        before: &[u8],
        after: &[u8],
        key: &[u8; 32],
        mut admit: impl FnMut() -> io::Result<()>,
    ) -> io::Result<bool> {
        if index >= 1024 || before.len() > MAX_FILE || after.len() > MAX_FILE {
            return Err(conflict());
        }
        self.verify()?;
        let path = relative(value)?;
        let parent = self.parent(&path, false)?;
        let name = path.file_name().ok_or_else(conflict)?;
        let before_digest = hash(before);
        let after_digest = hash(after);
        let existing = self.read_step(index, key)?;
        if let Some(step) = &existing {
            if step.verb()? != Verb::Replace
                || step.digest != after_digest
                || step.before.as_ref().map(|record| record.digest.as_str())
                    != Some(before_digest.as_str())
            {
                return Err(conflict());
            }
        }
        let current = parent.read(name, false, MAX_FILE)?.ok_or_else(conflict)?;
        if hash(&current.bytes) == after_digest {
            existing
                .as_ref()
                .ok_or_else(conflict)?
                .verify_replaced(value, &current)?;
            admit()?;
            self.verify()?;
            return Ok(true);
        }
        if hash(&current.bytes) != before_digest {
            return Err(conflict());
        }
        let step = match existing {
            Some(step) => {
                step.verify_before(value, &current, Verb::Replace, false)?;
                step
            }
            None => {
                let context = self.context(index)?;
                let step = Step::capture_replace(
                    value,
                    &context,
                    Identity::of(&current.file)?,
                    &before_digest,
                    &after_digest,
                );
                self.write_step(index, &step, key)?
            }
        };
        admit()?;
        self.verify()?;
        // Re-prove the pre-state immediately before the only publication.
        let recheck = parent.read(name, false, MAX_FILE)?.ok_or_else(conflict)?;
        step.verify_before(value, &recheck, Verb::Replace, false)?;
        self.publish_replace(&parent, name, &recheck, after)?;
        let installed = parent.read(name, false, MAX_FILE)?.ok_or_else(conflict)?;
        step.verify_replaced(value, &installed)?;
        admit()?;
        self.verify()?;
        Ok(false)
    }

    /// Move the proven attachment to its tombstone name. The object is renamed,
    /// never unlinked, so the same inode can be renamed back.
    /// true means the original name is already vacant and the tombstone holds it.
    pub(crate) fn install_remove(
        &self,
        index: usize,
        value: &str,
        before: &[u8],
        key: &[u8; 32],
        mut admit: impl FnMut() -> io::Result<()>,
    ) -> io::Result<bool> {
        if index >= 1024 || before.len() > MAX_FILE {
            return Err(conflict());
        }
        self.verify()?;
        let path = relative(value)?;
        let parent = self.parent(&path, false)?;
        let name = path.file_name().ok_or_else(conflict)?;
        let before_digest = hash(before);
        let tombstone_label = format!(".lrk-{}-{index}.removed", self.id);
        let tombstone = OsStr::new(&tombstone_label);
        let existing = self.read_step(index, key)?;
        if let Some(step) = &existing {
            if step.verb()? != Verb::Remove
                || step.digest != before_digest
                || step.tombstone.as_deref() != Some(tombstone_label.as_str())
            {
                return Err(conflict());
            }
        }
        let step = match private_read(&parent, name, MAX_FILE)? {
            Some(target) => {
                if target.bytes != before {
                    return Err(conflict());
                }
                match existing {
                    Some(step) => {
                        step.verify_before(value, &target, Verb::Remove, true)?;
                        step
                    }
                    None => {
                        let context = self.context(index)?;
                        let step = Step::capture_remove(value, &context, &tombstone_label, &target)?;
                        self.write_step(index, &step, key)?
                    }
                }
            }
            None => {
                // Only evidence that already recorded this very inode explains a
                // missing original; anything else is unprovable and preserved.
                let step = existing.ok_or_else(conflict)?;
                if step.digest != before_digest {
                    return Err(conflict());
                }
                let tomb = private_read(&parent, tombstone, MAX_FILE)?.ok_or_else(conflict)?;
                step.verify_before(value, &tomb, Verb::Remove, true)?;
                admit()?;
                self.verify()?;
                return Ok(true);
            }
        };
        admit()?;
        self.verify()?;
        let recheck = private_read(&parent, name, MAX_FILE)?.ok_or_else(conflict)?;
        step.verify_before(value, &recheck, Verb::Remove, true)?;
        // A tombstone name that already holds another object is a conflict:
        // both objects are preserved and neither is overwritten.
        if private_read(&parent, tombstone, MAX_FILE)?.is_some() {
            return Err(conflict());
        }
        parent.verify_named(name, &recheck.file)?;
        parent.rename_new(name, &parent, tombstone)?;
        let moved = private_read(&parent, tombstone, MAX_FILE)?.ok_or_else(conflict)?;
        step.verify_before(value, &moved, Verb::Remove, true)?;
        admit()?;
        self.verify()?;
        Ok(false)
    }

    /// Rollback of `Remove`: rename the recorded tombstone back. Refuses without
    /// writing when the original name is occupied, the tombstone is gone, or the
    /// tombstone is no longer the recorded inode.
    /// true means the original name already holds the recorded inode.
    pub(crate) fn restore_removed(
        &self,
        index: usize,
        value: &str,
        before: &[u8],
        key: &[u8; 32],
        mut admit: impl FnMut() -> io::Result<()>,
    ) -> io::Result<bool> {
        if index >= 1024 || before.len() > MAX_FILE {
            return Err(conflict());
        }
        self.verify()?;
        let path = relative(value)?;
        let parent = self.parent(&path, false)?;
        let name = path.file_name().ok_or_else(conflict)?;
        let step = self.read_step(index, key)?.ok_or_else(conflict)?;
        if step.verb()? != Verb::Remove || step.digest != hash(before) {
            return Err(conflict());
        }
        let tombstone_label = step.tombstone.clone().ok_or_else(conflict)?;
        let tombstone = OsStr::new(&tombstone_label);
        if let Some(current) = parent.read(name, false, MAX_FILE)? {
            if step
                .verify_before(value, &current, Verb::Remove, true)
                .is_err()
            {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            admit()?;
            self.verify()?;
            return Ok(true);
        }
        let tomb = private_read(&parent, tombstone, MAX_FILE)?
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        step.verify_before(value, &tomb, Verb::Remove, true)?;
        admit()?;
        self.verify()?;
        parent.verify_named(tombstone, &tomb.file)?;
        parent.rename_new(tombstone, &parent, name)?;
        let restored = private_read(&parent, name, MAX_FILE)?.ok_or_else(conflict)?;
        step.verify_before(value, &restored, Verb::Remove, true)?;
        admit()?;
        self.verify()?;
        Ok(false)
    }

    /// Rollback of `Replace`: write the recorded bytes back. This creates a new
    /// inode, exactly like the Windows rollback; ACLs on the old inode are not
    /// reconstructed and are refused instead (`Permissions::capture`).
    /// true means the pre-state bytes were already present.
    pub(crate) fn restore_replaced(
        &self,
        index: usize,
        value: &str,
        before: &[u8],
        key: &[u8; 32],
        mut admit: impl FnMut() -> io::Result<()>,
    ) -> io::Result<bool> {
        if index >= 1024 || before.len() > MAX_FILE {
            return Err(conflict());
        }
        self.verify()?;
        let path = relative(value)?;
        let parent = self.parent(&path, false)?;
        let name = path.file_name().ok_or_else(conflict)?;
        let before_digest = hash(before);
        let step = self.read_step(index, key)?.ok_or_else(conflict)?;
        if step.verb()? != Verb::Replace {
            return Err(conflict());
        }
        if step.before.as_ref().map(|record| record.digest.as_str())
            != Some(before_digest.as_str())
        {
            return Err(conflict());
        }
        let current = parent.read(name, false, MAX_FILE)?.ok_or_else(conflict)?;
        if hash(&current.bytes) == before_digest {
            admit()?;
            self.verify()?;
            return Ok(true);
        }
        step.verify_replaced(value, &current)?;
        admit()?;
        self.verify()?;
        let recheck = parent.read(name, false, MAX_FILE)?.ok_or_else(conflict)?;
        step.verify_replaced(value, &recheck)?;
        self.publish_replace(&parent, name, &recheck, before)?;
        let restored = parent.read(name, false, MAX_FILE)?.ok_or_else(conflict)?;
        if hash(&restored.bytes) != before_digest {
            return Err(conflict());
        }
        admit()?;
        self.verify()?;
        Ok(false)
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
        let step = self.read_step(index, key)?;
        if let Some(step) = &step {
            if step.verb()? != Verb::Create {
                return Err(conflict());
            }
        }
        if let Some(target) = private_read(&parent, name, MAX_FILE)? {
            // A name this transaction never recorded is someone else's object.
            step.ok_or_else(|| io::Error::from(io::ErrorKind::AlreadyExists))?
                .verify_created(value, bytes, &target)?;
            admit()?;
            self.verify()?;
            return Ok(true);
        }
        admit()?;
        let stage_label = format!(".lrk-import-{}-{index}.tmp", self.id);
        let stage_name = OsStr::new(&stage_label);
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
                step.verify_created(value, bytes, &stage)?;
                step
            }
            None => {
                let step = Step::capture_create(value, &context, &stage_label, &stage)?;
                self.write_step(index, &step, key)?
            }
        };
        // Durable intent + stage inode evidence precede the only publication.
        admit()?;
        self.verify()?;
        step.verify_created(
            value,
            bytes,
            &private_read(&parent, stage_name, MAX_FILE)?.ok_or_else(conflict)?,
        )?;
        parent.verify_named(stage_name, &stage.file)?;
        parent.rename_new(stage_name, &parent, name)?;
        step.verify_created(
            value,
            bytes,
            &private_read(&parent, name, MAX_FILE)?.ok_or_else(conflict)?,
        )?;
        admit()?;
        self.verify()?;
        Ok(false)
    }
}
