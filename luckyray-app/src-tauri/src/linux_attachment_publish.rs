//! Linux copy-publish of one new Vault attachment (复制发布, T02 §5.3.b).
//!
//! Same rule as Windows v1.9.9: a published attachment is always a new name,
//! never an overwrite. The Vault root is held as an owned directory under the
//! write lease, `attachments/` is reached through that descriptor without
//! following a link, the bytes are staged in a private (0600) `.lrk-` file,
//! verified, and published with `renameat2(RENAME_NOREPLACE)`. The published
//! name is then proved to denote the staged object with the expected bytes.
//!
//! There is no journal: the only change is one new name. Nothing is truncated.
//! As on Windows, a failed stage is removed, but only while its name still
//! denotes the object this call created (dev + inode, no-follow); otherwise it
//! is left as a hidden `.lrk-` file, which the attachment inventory ignores.
use crate::linux_fs::{conflict, no_default_acl, private_file_metadata, Directory, Version};
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};

pub(crate) const ATTACHMENTS: &str = "attachments";

/// The held Vault root, its write lease and its `attachments/` directory.
pub(crate) struct PublishTarget {
    root: Directory,
    attachments: Directory,
    _lease: File,
}

fn stage_name() -> OsString {
    OsString::from(format!(".lrk-attachment-{:032x}.tmp", rand::random::<u128>()))
}

fn hex(digest: impl AsRef<[u8]>) -> String {
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Stream the held file from its start; the length must stay `size`.
fn digest_of(file: &mut File, size: u64) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > size {
            return Err(conflict());
        }
        hash.update(&buffer[..count]);
    }
    if total != size || file.metadata()?.len() != size {
        return Err(conflict());
    }
    Ok(hex(hash.finalize()))
}

impl PublishTarget {
    /// `create` makes a missing `attachments/` (0700, through the held root).
    pub(crate) fn open(root: &std::path::Path, create: bool) -> io::Result<Self> {
        let root = Directory::owned(root, false)?;
        no_default_acl(&root.file)?;
        let lease = root.lock()?;
        let attachments = root.child_owned(OsStr::new(ATTACHMENTS), create, false)?;
        Ok(Self { root, attachments, _lease: lease })
    }

    fn verify(&self) -> io::Result<()> {
        self.root.verify()?;
        self.attachments.verify()
    }

    /// Any object (file, directory, link, device) occupies the name.
    pub(crate) fn vacant(&self, name: &OsStr) -> io::Result<bool> {
        self.verify()?;
        let component = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(name))
            .map_err(|_| conflict())?;
        if name.is_empty() || name.as_encoded_bytes().contains(&b'/') {
            return Err(conflict());
        }
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::fstatat(
                std::os::fd::AsRawFd::as_raw_fd(&self.attachments.file),
                component.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            Ok(true)
        } else {
            Err(error)
        }
    }

    /// Publish `bytes` under the vacant leaf `name` of `attachments/`.
    pub(crate) fn publish(&self, name: &OsStr, bytes: &[u8]) -> io::Result<()> {
        self.publish_from(name, &mut io::Cursor::new(bytes), bytes.len() as u64, &hex(Sha256::digest(bytes)))
    }

    /// Bounded-buffer form for large staged sources (companion video). The
    /// copied bytes must have exactly `size` and the SHA-256 `digest`.
    pub(crate) fn publish_from(&self, name: &OsStr, source: &mut dyn Read, size: u64, digest: &str) -> io::Result<()> {
        if name.as_encoded_bytes().starts_with(b".lrk-") || !self.vacant(name)? {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        let stage = stage_name();
        // 0600, O_EXCL|O_NOFOLLOW, ACL/xattr refused before any payload byte.
        let mut staged = self.attachments.create_private(&stage, b"")?;
        let outcome = self.publish_stage(&stage, &mut staged, name, source, size, digest);
        if outcome.is_err() {
            // Windows v1.9.9 removes its failed temp file; only ours is removed.
            self.discard_own_stage(&stage, &staged);
        }
        outcome
    }

    /// Unlink the failed stage only while the name (no-follow) still denotes
    /// the held object this call created; otherwise leave whatever is there.
    fn discard_own_stage(&self, stage: &OsStr, staged: &File) {
        let Ok(held) = staged.metadata() else { return };
        let Ok(component) = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(stage)) else { return };
        let directory = std::os::fd::AsRawFd::as_raw_fd(&self.attachments.file);
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if self.attachments.verify().is_err()
            || unsafe { libc::fstatat(directory, component.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0
            || stat.st_mode & libc::S_IFMT != libc::S_IFREG
            || stat.st_dev as u64 != std::os::unix::fs::MetadataExt::dev(&held)
            || stat.st_ino as u64 != std::os::unix::fs::MetadataExt::ino(&held)
        {
            return;
        }
        if unsafe { libc::unlinkat(directory, component.as_ptr(), 0) } == 0 {
            let _ = self.attachments.file.sync_all();
        }
    }

    fn publish_stage(&self, stage: &OsStr, staged: &mut File, name: &OsStr, source: &mut dyn Read, size: u64, digest: &str) -> io::Result<()> {
        let copied = io::copy(&mut source.take(size + 1), staged)?;
        staged.sync_all()?;
        private_file_metadata(staged)?;
        if copied != size || !digest_of(staged, size)?.eq_ignore_ascii_case(digest) {
            return Err(conflict());
        }
        let held = Version::of(staged)?;
        self.attachments.verify_named(stage, staged)?;
        self.verify()?;
        // The kernel refuses an occupied name even if it appeared after `vacant`.
        self.attachments.rename_new(stage, &self.attachments, name)?;
        let mut published = self.attachments.open_file(name, true)?;
        if !Version::of(&published)?.same_object(&held)
            || !digest_of(&mut published, size)?.eq_ignore_ascii_case(digest)
        {
            return Err(conflict());
        }
        private_file_metadata(&published)?;
        self.attachments.verify_named(name, staged)?;
        staged.flush()?;
        self.verify()
    }
}
