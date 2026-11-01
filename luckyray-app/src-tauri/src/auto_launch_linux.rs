//! Per-user Linux desktop autostart. This never executes a shell or searches PATH.
//!
//! Writes use conflict detection and retained recovery copies. Disabling uses
//! the XDG Hidden=true state; it never unlinks a pathname after an inspection.

use std::ffi::OsString;
#[cfg(test)]
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

const ENTRY_NAME: &str = "com.luckyray.desktop.desktop";
#[cfg(test)]
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

fn config_root(xdg: Option<OsString>, home: Option<OsString>) -> Result<PathBuf, String> {
    if let Some(path) = xdg.map(PathBuf::from).filter(|path| path.is_absolute()) {
        return Ok(path);
    }
    home.map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|path| path.join(".config"))
        .ok_or_else(|| "auto-launch-config-unavailable".to_string())
}

fn executable() -> Result<PathBuf, String> {
    // APPIMAGE alone cannot prove which carrier contains this running binary.
    // Never persist an ephemeral mount or an unverified environment pathname.
    if std::env::var_os("APPIMAGE").is_some() {
        return Err("auto-launch-appimage-source-unverified".to_string());
    }
    std::env::current_exe().map_err(|_| "auto-launch-executable-unavailable".to_string())
}

fn entry_for(executable: &Path) -> Result<String, String> {
    if !executable.is_absolute() {
        return Err("auto-launch-executable-invalid".to_string());
    }
    let value = executable
        .to_str()
        .ok_or_else(|| "auto-launch-executable-invalid".to_string())?;
    // The desktop-entry spec does not permit '=' in the executable name/path.
    // Control characters are rejected rather than encoded into a command line.
    if value.contains('=') || value.chars().any(char::is_control) {
        return Err("auto-launch-executable-invalid".to_string());
    }
    let mut exec = String::from("\"");
    for ch in value.chars() {
        match ch {
            '%' => exec.push_str("%%"),
            // Desktop-string decoding happens before command-line unquoting.
            '\\' => exec.push_str("\\\\\\\\"),
            '"' | '$' | '`' => {
                exec.push_str("\\\\");
                exec.push(ch);
            }
            _ => exec.push(ch),
        }
    }
    exec.push('"');
    Ok(format!("[Desktop Entry]\nType=Application\nName=LuckyRay\nExec={exec}\nTerminal=false\nX-LuckyRay-Managed=true\n"))
}

fn entry_path(root: &Path) -> PathBuf {
    root.join("autostart").join(ENTRY_NAME)
}

fn record_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::Interrupted => "auto-launch-recovery-required",
        io::ErrorKind::Unsupported => "auto-launch-file-attributes-unsupported",
        _ => "auto-launch-entry-conflict",
    }.to_owned()
}

fn directory(root: &Path, create: bool) -> Result<Option<crate::linux_fs::Directory>, String> {
    for path in [root.to_owned(), root.join("autostart")] {
        match crate::linux_fs::Directory::owned(&path, create) {
            Ok(_) => {},
            Err(error) if !create && error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(record_error(error)),
        }
    }
    crate::linux_fs::Directory::owned(&root.join("autostart"), false)
        .map(Some).map_err(record_error)
}

fn enabled_at(root: &Path, executable: &Path) -> Result<bool, String> {
    let expected = entry_for(executable)?;
    let disabled = format!("{expected}Hidden=true\n");
    let Some(dir) = directory(root, false)? else { return Ok(false); };
    crate::linux_managed_record::read(&dir, std::ffi::OsStr::new(ENTRY_NAME),
        &[expected.as_bytes(), disabled.as_bytes()]).map(|record| record.is_some_and(|record| record.state == 0))
        .map_err(record_error)
}

fn set_at(root: &Path, executable: &Path, enabled: bool) -> Result<(), String> {
    let expected = entry_for(executable)?;
    let disabled = format!("{expected}Hidden=true\n");
    let source = crate::linux_fs::RunningExecutable::acquire(executable).map_err(|_| "auto-launch-executable-invalid".to_owned())?;
    let Some(dir) = directory(root, enabled)? else { return Ok(()); };
    let family = [expected.as_bytes(), disabled.as_bytes()];
    crate::linux_managed_record::recover(&dir, std::ffi::OsStr::new(ENTRY_NAME), &family).map_err(record_error)?;
    if !enabled && crate::linux_managed_record::read(&dir, std::ffi::OsStr::new(ENTRY_NAME), &family)
        .map_err(record_error)?.is_none() { return Ok(()); }
    source.revalidate().map_err(|_| "auto-launch-executable-changed".to_owned())?;
    crate::linux_managed_record::set(&dir, std::ffi::OsStr::new(ENTRY_NAME), &family, usize::from(!enabled))
        .map_err(record_error)?;
    if let Err(error) = source.revalidate() {
        if enabled {
            // Only our exact managed payload can be disabled in compensation.
            // An external replacement is preserved and the outcome stays error.
            let _ = crate::linux_managed_record::set(&dir, std::ffi::OsStr::new(ENTRY_NAME), &family, 1);
        }
        return Err(format!("auto-launch-executable-changed: {error}"));
    }
    Ok(())
}

fn environment() -> Result<(PathBuf, PathBuf), String> {
    if unsafe { libc::geteuid() } == 0 { return Err("auto-launch-user-required".into()); }
    Ok((
        config_root(
            std::env::var_os("XDG_CONFIG_HOME"),
            std::env::var_os("HOME"),
        )?,
        executable()?,
    ))
}

pub(super) fn get() -> Result<bool, String> {
    let (root, executable) = environment()?;
    let source = crate::linux_fs::RunningExecutable::acquire(&executable).map_err(|_| "auto-launch-executable-invalid".to_owned())?;
    let enabled = enabled_at(&root, &executable)?;
    source.revalidate().map_err(|_| "auto-launch-executable-changed".to_owned())?;
    Ok(enabled)
}

pub(super) fn set(enabled: bool) -> Result<(), String> {
    let (root, executable) = environment()?;
    set_at(&root, &executable, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "luckyray-autostart-test-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn install_synthetic_entry(root: &Path, app: &Path) {
        fs::create_dir(root.join("autostart")).unwrap();
        fs::write(entry_path(root), entry_for(app).unwrap()).unwrap();
    }

    #[test]
    fn linux_autostart_enable_disable_reenable_keeps_prior_inodes_and_bytes() {
        let scratch = Scratch::new();
        let app = std::env::current_exe().unwrap();
        assert!(!enabled_at(&scratch.0, &app).unwrap());
        set_at(&scratch.0, &app, false).unwrap();
        assert!(!scratch.0.join("autostart").exists());
        set_at(&scratch.0, &app, true).unwrap();
        assert!(enabled_at(&scratch.0, &app).unwrap());
        let before = fs::read(entry_path(&scratch.0)).unwrap();
        let inode = fs::metadata(entry_path(&scratch.0)).unwrap().ino();
        set_at(&scratch.0, &app, false).unwrap();
        assert!(!enabled_at(&scratch.0, &app).unwrap());
        assert!(fs::read_to_string(entry_path(&scratch.0)).unwrap().ends_with("Hidden=true\n"));
        let files: Vec<_> = fs::read_dir(scratch.0.join("autostart")).unwrap().map(|item| item.unwrap().path()).collect();
        let displaced = files.iter().find(|path| path.extension().is_some_and(|ext| ext == "displaced")).unwrap();
        assert_eq!(fs::metadata(displaced).unwrap().ino(), inode);
        assert_eq!(fs::read(displaced).unwrap(), before);
        let backup = files.iter().find(|path| path.extension().is_some_and(|ext| ext == "backup")).unwrap();
        assert_ne!(fs::metadata(backup).unwrap().ino(), inode);
        assert_eq!(fs::read(backup).unwrap(), before);
        set_at(&scratch.0, &app, true).unwrap();
        assert!(enabled_at(&scratch.0, &app).unwrap());
        assert_eq!(fs::read(entry_path(&scratch.0)).unwrap(), before);
    }

    #[test]
    fn rejects_conflicting_and_stale_entries_without_changing_them() {
        let scratch = Scratch::new();
        let app = std::env::current_exe().unwrap();
        install_synthetic_entry(&scratch.0, &app);
        let before = fs::read(entry_path(&scratch.0)).unwrap();
        let other = scratch.0.join("other app");
        assert_eq!(
            enabled_at(&scratch.0, &other),
            Err("auto-launch-entry-conflict".to_string())
        );
        assert!(set_at(&scratch.0, &other, true).is_err());
        assert!(set_at(&scratch.0, &other, false).is_err());
        assert_eq!(fs::read(entry_path(&scratch.0)).unwrap(), before);
        fs::write(entry_path(&scratch.0), b"foreign data").unwrap();
        assert!(set_at(&scratch.0, &app, true).is_err());
        assert!(set_at(&scratch.0, &app, false).is_err());
        assert_eq!(fs::read(entry_path(&scratch.0)).unwrap(), b"foreign data");
    }

    #[test]
    fn escapes_desktop_exec_metacharacters() {
        let scratch = Scratch::new();
        let app = scratch.0.join("中文 space % $ ` \" \\ name");
        let entry = entry_for(&app).unwrap();
        assert!(entry.contains(r#"中文 space %% \\$ \\` \\" \\\\ name"#));
    }

    #[test]
    fn rejects_newlines_and_equal_signs_in_executable() {
        let scratch = Scratch::new();
        for name in ["bad\nname", "bad=name"] {
            assert!(entry_for(&scratch.0.join(name)).is_err());
        }
    }

    #[test]
    fn uses_absolute_xdg_config_or_home_fallback() {
        let scratch = Scratch::new();
        let xdg = scratch.0.join("alternate config");
        assert_eq!(
            config_root(Some(xdg.clone().into()), Some(scratch.0.clone().into())).unwrap(),
            xdg
        );
        assert_eq!(
            config_root(Some("relative".into()), Some(scratch.0.clone().into())).unwrap(),
            scratch.0.join(".config")
        );
        assert!(config_root(None, Some("relative".into())).is_err());
    }

    #[test]
    fn linux_autostart_rejects_unrelated_and_linked_executables_before_creating_state() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new();
        let actual = std::env::current_exe().unwrap();
        let alias = scratch.0.join("alias");
        symlink(&actual, &alias).unwrap();
        assert!(set_at(&scratch.0, &alias, true).is_err());
        let unrelated = Path::new("/usr/bin/true");
        assert!(set_at(&scratch.0, unrelated, true).is_err());
        assert!(!scratch.0.join("autostart").exists());
    }

    #[test]
    fn linux_autostart_rejects_ancestor_links_and_shared_config_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let scratch = Scratch::new();
        let outside = Scratch::new();
        let alias = scratch.0.join("alias");
        symlink(&outside.0, &alias).unwrap();
        let actual = std::env::current_exe().unwrap();
        assert!(set_at(&alias, &actual, true).is_err());
        assert!(!outside.0.join("autostart").exists());
        fs::set_permissions(&scratch.0, fs::Permissions::from_mode(0o775)).unwrap();
        assert!(set_at(&scratch.0, &actual, true).is_err());
        assert!(!scratch.0.join("autostart").exists());
    }

    #[test]
    fn linux_autostart_interruption_recovery_is_explicit_and_preserves_permissions() {
        use std::ffi::OsStr;
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new();
        let actual = std::env::current_exe().unwrap();
        set_at(&scratch.0, &actual, true).unwrap();
        fs::set_permissions(entry_path(&scratch.0), fs::Permissions::from_mode(0o640)).unwrap();
        let dir = directory(&scratch.0, false).unwrap().unwrap();
        let before = dir.read(OsStr::new(ENTRY_NAME), false, 64 * 1024).unwrap().unwrap();
        let disabled = format!("{}Hidden=true\n", entry_for(&actual).unwrap());
        assert!(crate::linux_file_store::write(&dir, OsStr::new(ENTRY_NAME), Some(&before),
            disabled.as_bytes(), false, false, true).is_err());
        let names = || { let mut names: Vec<_> = fs::read_dir(&dir.path).unwrap().map(|item| item.unwrap().file_name()).collect(); names.sort(); names };
        let pending = names();
        assert_eq!(enabled_at(&scratch.0, &actual), Err("auto-launch-recovery-required".into()));
        assert_eq!(names(), pending, "status queries do not perform recovery writes");
        set_at(&scratch.0, &actual, false).unwrap();
        assert!(!enabled_at(&scratch.0, &actual).unwrap());
        let after = fs::metadata(entry_path(&scratch.0)).unwrap();
        assert_eq!(after.mode() & 0o777, 0o640);
        assert_eq!(after.gid(), before.file.metadata().unwrap().gid());
    }

    #[test]
    fn linux_autostart_interrupted_recovery_preserves_an_external_replacement() {
        use std::ffi::OsStr;
        let scratch = Scratch::new();
        let actual = std::env::current_exe().unwrap();
        set_at(&scratch.0, &actual, true).unwrap();
        let dir = directory(&scratch.0, false).unwrap().unwrap();
        let before = dir.read(OsStr::new(ENTRY_NAME), false, 64 * 1024).unwrap().unwrap();
        let disabled = format!("{}Hidden=true\n", entry_for(&actual).unwrap());
        assert!(crate::linux_file_store::write(&dir, OsStr::new(ENTRY_NAME), Some(&before),
            disabled.as_bytes(), false, false, true).is_err());
        fs::write(entry_path(&scratch.0), b"foreign replacement").unwrap();
        assert!(set_at(&scratch.0, &actual, false).is_err());
        assert_eq!(fs::read(entry_path(&scratch.0)).unwrap(), b"foreign replacement");
        assert!(crate::linux_file_store::recovery_pending(&dir).unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires desktop-file-validate in LUCKYRAY_DESKTOP_FILE_VALIDATE"]
    fn generated_entry_passes_desktop_file_validate_when_supplied() {
        let validator = std::env::var_os("LUCKYRAY_DESKTOP_FILE_VALIDATE").expect("actual validator is required");
        let scratch = Scratch::new();
        let app = scratch.0.join("中文 app % $");
        install_synthetic_entry(&scratch.0, &app);
        let result = std::process::Command::new(validator)
            .arg(entry_path(&scratch.0))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "desktop-file-validate failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_follow_or_remove_a_symlink_entry() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new();
        let app = std::env::current_exe().unwrap();
        let target = scratch.0.join("unrelated");
        fs::write(&target, b"preserve").unwrap();
        fs::create_dir_all(scratch.0.join("autostart")).unwrap();
        symlink(&target, entry_path(&scratch.0)).unwrap();
        assert!(enabled_at(&scratch.0, &app).is_err());
        assert!(set_at(&scratch.0, &app, true).is_err());
        assert!(set_at(&scratch.0, &app, false).is_err());
        assert_eq!(fs::read(target).unwrap(), b"preserve");
        assert!(fs::symlink_metadata(entry_path(&scratch.0))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    // Runs only as the bounded synthetic child of the test below. Keeping the
    // potentially blocking operation in a child lets the parent kill and reap
    // it if a regression reintroduces a blocking FIFO open.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "invoked only by the bounded FIFO regression"]
    fn fifo_no_writer_child() {
        use std::os::unix::fs::FileTypeExt;
        let root = PathBuf::from(std::env::var_os("LUCKYRAY_AUTOSTART_FIFO_FIXTURE").unwrap());
        let app = std::env::current_exe().unwrap();
        assert!(fs::symlink_metadata(entry_path(&root))
            .unwrap()
            .file_type()
            .is_fifo());
        for result in [
            enabled_at(&root, &app).map(|_| ()),
            set_at(&root, &app, true),
            set_at(&root, &app, false),
        ] {
            assert_eq!(result, Err("auto-launch-entry-conflict".to_string()));
        }
        assert!(fs::symlink_metadata(entry_path(&root))
            .unwrap()
            .file_type()
            .is_fifo());
        fs::write(root.join("fifo-test-complete"), b"verified").unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fifo_without_writer_is_rejected_within_deadline() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::FileTypeExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let scratch = Scratch::new();
        fs::create_dir(scratch.0.join("autostart")).unwrap();
        let fifo = entry_path(&scratch.0);
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(fs::symlink_metadata(&fifo).unwrap().file_type().is_fifo());
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "fifo_no_writer_child"])
            .env("LUCKYRAY_AUTOSTART_FIFO_FIXTURE", &scratch.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    assert!(status.success(), "FIFO child failed: {status}");
                    break;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Ok(None) | Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("FIFO child did not settle within the five-second deadline");
                }
            }
        }
        assert_eq!(
            fs::read(scratch.0.join("fifo-test-complete")).unwrap(),
            b"verified"
        );
        assert!(fs::symlink_metadata(&fifo).unwrap().file_type().is_fifo());
    }
}
