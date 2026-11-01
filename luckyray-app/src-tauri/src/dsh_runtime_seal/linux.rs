//! A Linux optimistic use-window check, not a mandatory write/delete lease.
use crate::linux_fs::{Directory, Version};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::File;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;

pub(super) struct Lease {
    directory: Directory,
    name: OsString,
    file: File,
    version: Version,
    hash: [u8; 32],
    mode: u32,
    uid: u32,
}

fn hash(file: &File) -> Result<[u8; 32], ()> {
    let length = file.metadata().map_err(|_| ())?.len();
    if length > 512 * 1024 * 1024 {
        return Err(());
    }
    let mut digest = Sha256::new();
    let mut offset = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read_at(&mut buffer, offset).map_err(|_| ())?;
        if count == 0 {
            break;
        }
        offset += count as u64;
        if offset > length {
            return Err(());
        }
        digest.update(&buffer[..count]);
    }
    if offset != length {
        return Err(());
    }
    Ok(digest.finalize().into())
}

impl Lease {
    pub(super) fn matches_sha256(&self, expected: &str) -> bool {
        self.hash.iter().map(|byte| format!("{byte:02x}")).collect::<String>() == expected
    }

    pub(super) fn acquire(path: &Path) -> Result<Self, ()> {
        let directory = Directory::open(path.parent().ok_or(())?).map_err(|_| ())?;
        let name = path.file_name().ok_or(())?.to_owned();
        let file = directory.open_file(&name, false).map_err(|_| ())?;
        crate::linux_fs::no_attributes(&file).map_err(|_| ())?;
        let metadata = file.metadata().map_err(|_| ())?;
        if metadata.mode() & 0o7022 != 0 || metadata.mode() & 0o400 != 0o400
            || ![0, unsafe { libc::geteuid() }].contains(&metadata.uid())
        {
            return Err(());
        }
        let version = Version::of(&file).map_err(|_| ())?;
        let hash = hash(&file)?;
        let lease = Self {
            directory,
            name,
            file,
            version,
            hash,
            mode: metadata.mode(),
            uid: metadata.uid(),
        };
        lease.revalidate()?;
        Ok(lease)
    }

    pub(super) fn revalidate(&self) -> Result<(), ()> {
        let metadata = self.file.metadata().map_err(|_| ())?;
        if Version::of(&self.file).map_err(|_| ())? != self.version
            || metadata.mode() != self.mode
            || metadata.uid() != self.uid
            || hash(&self.file)? != self.hash
        {
            return Err(());
        }
        self.directory
            .verify_named(&self.name, &self.file)
            .map_err(|_| ())?;
        if Version::of(&self.file).map_err(|_| ())? != self.version {
            return Err(());
        }
        Ok(())
    }
}
