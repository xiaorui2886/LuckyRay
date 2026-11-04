//! Linux (AppImage) install: verify the staged bytes with the Linux release
//! identity, atomically replace the running AppImage named by the standard
//! `APPIMAGE` environment variable, and start the replaced file. The final
//! restart is behind the normal quit path, so it can be disabled by simply not
//! calling it.
//!
//! Order mirrors Windows v1.9.9: verify -> resolve target -> stage -> re-verify
//! the staged bytes -> rename -> fsync -> restart. Anything else (deb, unknown
//! formats, APPIMAGE absent) keeps the notice-only behaviour.

use super::verification::{verify_package, LINUX_PROFILE};
use libc;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

/// Re-usable primitives, identical to the probe crate
/// `/workspace/linux-port/probes/appimage-self-replace` (T35).
pub(crate) enum ReplaceFailure {
    TargetInvalid,
    TargetChanged,
    TemporaryExists,
    CopyFailed,
    StagedVerificationFailed,
    PublishFailed,
}

fn user_uid() -> u32 {
    unsafe { libc::geteuid() as u32 }
}

fn validate_target(path: &std::path::Path, current_uid: u32) -> Result<(), ReplaceFailure> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if !path.is_absolute() {
        return Err(ReplaceFailure::TargetInvalid);
    }
    if path.extension().and_then(|e| e.to_str()) != Some("AppImage") {
        return Err(ReplaceFailure::TargetInvalid);
    }
    let meta = std::fs::symlink_metadata(path).map_err(|_| ReplaceFailure::TargetInvalid)?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(ReplaceFailure::TargetInvalid);
    }
    if meta.uid() != current_uid {
        return Err(ReplaceFailure::TargetInvalid);
    }
    if meta.permissions().mode() & 0o200 == 0 {
        return Err(ReplaceFailure::TargetInvalid);
    }
    Ok(())
}

/// The running AppImage, resolved from the standard `APPIMAGE` env var.
pub(crate) fn resolve_target() -> Result<PathBuf, &'static str> {
    let raw = std::env::var("APPIMAGE").map_err(|_| "update-appimage-target-unavailable")?;
    let path = std::path::PathBuf::from(raw);
    validate_target(&path, user_uid()).map_err(|_| "update-appimage-target-invalid")?;
    Ok(path)
}

/// Verifies the staged bytes with the Linux release identity.
pub(crate) fn verify(
    bytes: &[u8],
    signature: &str,
    public_key: &str,
    version: &str,
) -> Result<(), &'static str> {
    verify_package(bytes, signature, public_key, version, &LINUX_PROFILE)
}

/// Atomically replaces the running AppImage with verified bytes and returns
/// the replaced path. Same order as the T35 probe (`replace`): stage
/// `.lrk-<pid>-<nanos>.tmp` in the target directory, fsync, re-read and compare
/// byte-for-byte, rename over the target, fsync the directory.
pub(crate) fn replace_target(bytes: &[u8], target: &std::path::Path) -> Result<(), &'static str> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let before = std::fs::symlink_metadata(target)
        .map(|m| (m.ino(), m.len(), m.mtime(), m.mtime_nsec()))
        .map_err(|_| "update-appimage-target-invalid")?;
    let directory = target.parent().ok_or("update-appimage-target-invalid")?;
    let dir_file = std::fs::File::open(directory).map_err(|_| "update-appimage-stage-failed")?;
    let name = CString::new(format!(
        ".lrk-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ))
    .map_err(|_| "update-appimage-stage-failed")?;
    let fd = unsafe {
        libc::openat(
            dir_file.as_raw_fd(),
            name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o755,
        )
    };
    if fd < 0 {
        return Err(match io::Error::last_os_error().kind() {
            io::ErrorKind::AlreadyExists => "update-appimage-stage-collision",
            _ => "update-appimage-stage-failed",
        });
    }
    let staged = unsafe { std::fs::File::from_raw_fd(fd) };
    let result = (|| -> Result<(), &'static str> {
        use std::io::{Read, Seek, SeekFrom, Write};
        let mut writer = &staged;
        writer.write_all(bytes).map_err(|_| "update-appimage-stage-failed")?;
        staged.sync_all().map_err(|_| "update-appimage-stage-failed")?;
        // A cached file is untrusted: re-read exactly what landed on disk.
        let mut written = Vec::with_capacity(bytes.len());
        let mut reader = &staged;
        reader.seek(SeekFrom::Start(0)).map_err(|_| "update-appimage-stage-failed")?;
        reader.read_to_end(&mut written).map_err(|_| "update-appimage-stage-failed")?;
        if written.as_slice() != bytes {
            return Err("update-verification-failed");
        }
        // The user's AppImage must not have moved underneath us.
        let now = std::fs::symlink_metadata(target)
            .map(|m| (m.ino(), m.len(), m.mtime(), m.mtime_nsec()))
            .map_err(|_| "update-appimage-target-invalid")?;
        if now != before {
            return Err("update-target-changed");
        }
        dir_file.sync_all().map_err(|_| "update-appimage-publish-failed")?;
        if unsafe {
            libc::renameat(
                dir_file.as_raw_fd(),
                name.as_ptr(),
                dir_file.as_raw_fd(),
                CString::new(target.as_os_str().as_bytes())
                    .map_err(|_| "update-appimage-publish-failed")?
                    .as_ptr(),
            )
        } != 0
        {
            return Err("update-appimage-publish-failed");
        }
        dir_file.sync_all().map_err(|_| "update-appimage-publish-failed")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = unsafe {
            libc::unlinkat(dir_file.as_raw_fd(), name.as_ptr(), 0)
        };
    }
    result
}

/// Starts the replaced AppImage. The caller then quits behind the normal
/// single-instance barrier.
pub(crate) fn restart(target: &std::path::Path) -> Result<(), &'static str> {
    std::process::Command::new(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "update-appimage-restart-failed")
}
