//! Linux hardening of 删除素材文件 (T02 §5.4.b, D1 = Windows v1.9.9).
//!
//! Deletion keeps the Windows shape: quarantine rename → catalog commit →
//! permanent delete (no system trash). Linux adds proof that the object being
//! quarantined, restored or purged is the one that was checked:
//! - quarantine: the leaf is opened without following a link, must be a
//!   regular file with one link whose held bytes match the catalog hash, and is
//!   renamed with `renameat2(RENAME_NOREPLACE)` (fsync + landed-inode check
//!   come from the material move primitive);
//! - a side record `{dev, ino}` is written next to (not inside) the portable
//!   pending manifest;
//! - purge requires that record and the quarantined name to still denote it;
//! - restore is a no-replace rename back and refuses an occupied original.
//! This module never unlinks anything; the catalog keeps its own purge.
use crate::linux_fs::{conflict, owned_fd, Directory};
use sha2::{Digest, Sha256};
use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

const RECORD_LIMIT: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    pub(crate) device: u64,
    pub(crate) inode: u64,
}

fn leaf(path: &Path) -> io::Result<(Directory, CString)> {
    let parent = path.parent().ok_or_else(conflict)?;
    let name = path.file_name().ok_or_else(conflict)?;
    let text = Path::new(name);
    if text.components().count() != 1 {
        return Err(conflict());
    }
    Ok((Directory::open(parent)?, CString::new(name.as_bytes()).map_err(|_| conflict())?))
}

fn open_leaf(directory: &Directory, name: &CString) -> io::Result<File> {
    owned_fd(unsafe {
        libc::openat(
            directory.file.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    })
}

/// A regular, singly linked file; a hard link would let "delete" remove bytes
/// still reachable under another name, so it is refused like on Windows' handle.
fn single(file: &File) -> io::Result<Identity> {
    let m = file.metadata()?;
    if !m.is_file() || m.nlink() != 1 {
        return Err(conflict());
    }
    Ok(Identity { device: m.dev(), inode: m.ino() })
}

fn sha256_held(file: &mut File) -> io::Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// What a name denotes now, without following a link.
pub(crate) fn identity_at(path: &Path) -> io::Result<Identity> {
    let (directory, name) = leaf(path)?;
    single(&open_leaf(&directory, &name)?)
}

/// Rename the checked original into the quarantine name in the same parent.
pub(crate) fn quarantine(original: &Path, quarantine: &Path, expected_sha256: &str) -> io::Result<Identity> {
    if original.parent() != quarantine.parent() {
        return Err(conflict());
    }
    let (directory, name) = leaf(original)?;
    let mut file = open_leaf(&directory, &name)?;
    let identity = single(&file)?;
    if !sha256_held(&mut file)?.eq_ignore_ascii_case(expected_sha256) || single(&file)? != identity {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "delete-content-mismatch"));
    }
    crate::linux_material_move::move_held_no_replace(&file, original, quarantine)?;
    if identity_at(quarantine)? != identity {
        return Err(conflict());
    }
    Ok(identity)
}

pub(crate) fn encode(identity: Identity) -> Vec<u8> {
    format!("luckyray-delete-identity v1 {} {}\n", identity.device, identity.inode).into_bytes()
}

pub(crate) fn decode(bytes: &[u8]) -> io::Result<Identity> {
    let text = std::str::from_utf8(bytes).map_err(|_| conflict())?;
    let mut parts = text.strip_suffix('\n').ok_or_else(conflict)?.split(' ');
    if parts.next() != Some("luckyray-delete-identity") || parts.next() != Some("v1") {
        return Err(conflict());
    }
    let device = parts.next().ok_or_else(conflict)?.parse().map_err(|_| conflict())?;
    let inode = parts.next().ok_or_else(conflict)?.parse().map_err(|_| conflict())?;
    if parts.next().is_some() {
        return Err(conflict());
    }
    Ok(Identity { device, inode })
}

fn record_name(token: &str) -> io::Result<String> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(conflict());
    }
    Ok(format!("{token}.inode"))
}

/// Durable side record (O_EXCL, 0600, file + directory fsync).
pub(crate) fn write_record(directory: &Path, token: &str, identity: Identity) -> io::Result<()> {
    let directory = Directory::owned(directory, true)?;
    directory.create(OsStr::new(&record_name(token)?), &encode(identity))?;
    Ok(())
}

pub(crate) fn read_record(directory: &Path, token: &str) -> io::Result<Option<Identity>> {
    let directory = match Directory::owned(directory, false) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    match directory.read(OsStr::new(&record_name(token)?), true, RECORD_LIMIT)? {
        Some(snapshot) => decode(&snapshot.bytes).map(Some),
        None => Ok(None),
    }
}

/// Purge precondition: the record exists and the quarantined name denotes it.
pub(crate) fn verify_before_purge(record: Option<Identity>, quarantine: &Path) -> io::Result<()> {
    let record = record.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "delete-identity-missing"))?;
    if identity_at(quarantine)? != record {
        return Err(conflict());
    }
    Ok(())
}

/// Restore: no-replace rename of the recorded object back to its name.
pub(crate) fn restore(record: Option<Identity>, quarantine: &Path, original: &Path) -> io::Result<()> {
    if let Some(record) = record {
        if identity_at(quarantine)? != record {
            return Err(conflict());
        }
    }
    crate::linux_material_move::move_path_no_replace(quarantine, original)
}
