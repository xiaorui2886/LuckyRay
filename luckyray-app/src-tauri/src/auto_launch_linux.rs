//! Per-user Linux desktop autostart. This never executes a shell or searches PATH.
//!
//! Reading is supported, but changes fail closed until file identity and
//! concurrent replacement can be protected throughout the operation.

use std::ffi::OsString;
#[cfg(test)]
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Read};
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
    // AppImages run from an ephemeral mount; retain the AppImage, not that mount.
    if let Some(value) = std::env::var_os("APPIMAGE") {
        let path = PathBuf::from(value);
        if !path.is_absolute()
            || !path.is_file()
            || !path
                .extension()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.eq_ignore_ascii_case("appimage"))
        {
            return Err("auto-launch-appimage-invalid".to_string());
        }
        return Ok(path);
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

fn read_entry(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Reject a symlink even if it is swapped in at open time, and never
        // wait for a FIFO writer before checking the opened object's type.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    match options.open(path) {
        Ok(file) => {
            let metadata = file
                .metadata()
                .map_err(|_| "auto-launch-read-failed".to_string())?;
            if !metadata.is_file() || metadata.len() > 16 * 1024 {
                return Err("auto-launch-entry-conflict".to_string());
            }
            let mut contents = Vec::new();
            file.take(16 * 1024 + 1)
                .read_to_end(&mut contents)
                .map_err(|_| "auto-launch-read-failed".to_string())?;
            if contents.len() > 16 * 1024 {
                return Err("auto-launch-entry-conflict".to_string());
            }
            Ok(Some(contents))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("auto-launch-read-failed".to_string()),
    }
}

fn enabled_at(root: &Path, executable: &Path) -> Result<bool, String> {
    let expected = entry_for(executable)?;
    match read_entry(&entry_path(root))? {
        None => Ok(false),
        Some(actual) if actual == expected.as_bytes() => Ok(true),
        Some(_) => Err("auto-launch-entry-conflict".to_string()),
    }
}

fn set_at(root: &Path, executable: &Path, enabled: bool) -> Result<(), String> {
    let expected = entry_for(executable)?;
    let destination = entry_path(root);
    match read_entry(&destination)? {
        Some(actual) if actual != expected.as_bytes() => {
            return Err("auto-launch-entry-conflict".to_string())
        }
        Some(_) if enabled => return Ok(()),
        // Path-based unlink after an inspection can remove a replacement.
        Some(_) => return Err("auto-launch-write-safety-unavailable".to_string()),
        None if !enabled => return Ok(()),
        // A named staging file can be replaced before linking or cleanup.
        // Do not create any name until identity-bound mutation is available.
        None => return Err("auto-launch-write-safety-unavailable".to_string()),
    }
}

fn environment() -> Result<(PathBuf, PathBuf), String> {
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
    enabled_at(&root, &executable)
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
    fn rejects_writes_and_deletes_before_any_filesystem_changes() {
        let scratch = Scratch::new();
        let app = scratch.0.join("中文 app %name");
        assert!(!enabled_at(&scratch.0, &app).unwrap());
        assert_eq!(
            set_at(&scratch.0, &app, true),
            Err("auto-launch-write-safety-unavailable".into())
        );
        assert!(!scratch.0.join("autostart").exists());
        set_at(&scratch.0, &app, false).unwrap();
        assert!(!scratch.0.join("autostart").exists());
        install_synthetic_entry(&scratch.0, &app);
        assert!(enabled_at(&scratch.0, &app).unwrap());
        set_at(&scratch.0, &app, true).unwrap();
        let before = fs::read(entry_path(&scratch.0)).unwrap();
        assert_eq!(
            set_at(&scratch.0, &app, false),
            Err("auto-launch-write-safety-unavailable".into())
        );
        assert_eq!(fs::read(entry_path(&scratch.0)).unwrap(), before);
        assert_eq!(
            fs::read_dir(scratch.0.join("autostart")).unwrap().count(),
            1
        );
    }

    #[test]
    fn rejects_conflicting_and_stale_entries_without_changing_them() {
        let scratch = Scratch::new();
        let app = scratch.0.join("app");
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

    #[cfg(target_os = "linux")]
    #[test]
    fn generated_entry_passes_desktop_file_validate_when_supplied() {
        let Some(validator) = std::env::var_os("LUCKYRAY_DESKTOP_FILE_VALIDATE") else {
            return;
        };
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
        let app = scratch.0.join("app");
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
        let app = root.join("app");
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
