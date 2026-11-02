//! Optimistic descriptor/object checks at macOS use boundaries. Holding these
//! descriptors does not exclude another process running as the same user.
use super::{RuntimeSealControl, RuntimeSealProgress};
use crate::macos_fs::{require_empty_acl, Directory};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{File, Metadata};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;
use std::sync::atomic::AtomicBool;

pub(super) type Identity = (u64, u64, u64, u64, u32, u32, u32, i64, i64, i64, i64);
pub(super) fn identity(meta: &Metadata) -> Identity {
    (
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.nlink(),
        meta.uid(),
        meta.gid(),
        meta.mode(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    )
}
pub(super) fn check_file(file: &File) -> Result<Metadata, ()> {
    let meta = file.metadata().map_err(|_| ())?;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.len() > 512 * 1024 * 1024
        || meta.mode() & 0o7022 != 0
        || meta.mode() & 0o400 == 0
        || ![0, unsafe { libc::geteuid() }].contains(&meta.uid())
    {
        return Err(());
    }
    require_empty_acl(file).map_err(|_| ())?;
    Ok(meta)
}
pub(super) fn hash(file: &File, control: &RuntimeSealControl<'_>) -> Result<String, ()> {
    let before = check_file(file)?;
    let mut digest = Sha256::new();
    let mut offset = 0u64;
    let mut bytes = [0; 64 * 1024];
    loop {
        control.progress(RuntimeSealProgress::HashChunk)?;
        let count = file.read_at(&mut bytes, offset).map_err(|_| ())?;
        if count == 0 {
            break;
        }
        offset = offset.checked_add(count as u64).ok_or(())?;
        if offset > before.len() {
            return Err(());
        }
        digest.update(&bytes[..count]);
    }
    if offset != before.len() || identity(&check_file(file)?) != identity(&before) {
        return Err(());
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub(super) struct Lease {
    directory: Directory,
    name: OsString,
    file: File,
    object: Identity,
    parent_object: Identity,
    hash: String,
}
impl Lease {
    pub(super) fn acquire(path: &Path) -> Result<Self, ()> {
        let cancelled = AtomicBool::new(false);
        Self::acquire_controlled(path, &RuntimeSealControl::new(&cancelled))
    }
    pub(super) fn acquire_controlled(
        path: &Path,
        control: &RuntimeSealControl<'_>,
    ) -> Result<Self, ()> {
        control.check()?;
        let directory = Directory::open_trusted(path.parent().ok_or(())?).map_err(|_| ())?;
        let name = path.file_name().ok_or(())?.to_owned();
        let file = directory.open_regular(&name).map_err(|_| ())?;
        let parent_object = identity(
            &directory
                .identity_file()
                .map_err(|_| ())?
                .metadata()
                .map_err(|_| ())?,
        );
        let object = identity(&check_file(&file)?);
        let hash = hash(&file, control)?;
        let held = Self {
            directory,
            name,
            file,
            object,
            parent_object,
            hash,
        };
        held.revalidate_controlled(control)?;
        Ok(held)
    }
    pub(super) fn object_identity(&self) -> Identity {
        self.object
    }
    pub(super) fn matches_sha256(&self, expected: &str) -> bool {
        self.hash == expected
    }
    pub(super) fn revalidate(&self) -> Result<(), ()> {
        let cancelled = AtomicBool::new(false);
        self.revalidate_controlled(&RuntimeSealControl::new(&cancelled))
    }
    pub(super) fn revalidate_controlled(&self, control: &RuntimeSealControl<'_>) -> Result<(), ()> {
        control.progress(RuntimeSealProgress::RevalidateObject)?;
        if identity(&check_file(&self.file)?) != self.object
            || hash(&self.file, control)? != self.hash
        {
            return Err(());
        }
        let named = self.directory.open_regular(&self.name).map_err(|_| ())?;
        if identity(&check_file(&named)?) != self.object
            || identity(&check_file(&self.file)?) != self.object
        {
            return Err(());
        }
        self.directory.current().map_err(|_| ())?;
        if identity(
            &self
                .directory
                .identity_file()
                .map_err(|_| ())?
                .metadata()
                .map_err(|_| ())?,
        ) != self.parent_object
        {
            return Err(());
        }
        Ok(())
    }
}
