//! Per-user Linux desktop autostart. This never executes a shell or searches PATH.
//!
//! An existing entry is only removed when it exactly matches the one generated
//! for the current executable. Foreign, edited, or stale entries are preserved
//! and reported as a conflict rather than silently overwritten or removed.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const ENTRY_NAME: &str = "com.luckyray.desktop.desktop";
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
        // Linux O_NOFOLLOW: refuse even a symlink swapped in at open time.
        const O_NOFOLLOW: i32 = 0x20000;
        options.custom_flags(O_NOFOLLOW);
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
        Some(_) => {
            return fs::remove_file(&destination)
                .map_err(|_| "auto-launch-remove-failed".to_string())
        }
        None if !enabled => return Ok(()),
        None => {}
    }
    let directory = destination
        .parent()
        .ok_or_else(|| "auto-launch-config-unavailable".to_string())?;
    fs::create_dir_all(directory).map_err(|_| "auto-launch-directory-failed".to_string())?;
    let temporary = directory.join(format!(
        ".{ENTRY_NAME}.{}.{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut created = false;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "auto-launch-write-failed".to_string())?;
        created = true;
        file.write_all(expected.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "auto-launch-write-failed".to_string())?;
        drop(file);
        // A hard link fails if another entry appeared; it never replaces it.
        fs::hard_link(&temporary, &destination).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                "auto-launch-entry-conflict"
            } else {
                "auto-launch-write-failed"
            }
            .to_string()
        })?;
        Ok(())
    })();
    if created {
        let _ = fs::remove_file(&temporary);
    }
    result
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

    #[test]
    fn creates_queries_and_removes_only_the_matching_entry() {
        let scratch = Scratch::new();
        let app = scratch.0.join("中文 app %name");
        assert!(!enabled_at(&scratch.0, &app).unwrap());
        set_at(&scratch.0, &app, true).unwrap();
        assert!(enabled_at(&scratch.0, &app).unwrap());
        set_at(&scratch.0, &app, true).unwrap();
        set_at(&scratch.0, &app, false).unwrap();
        assert!(!enabled_at(&scratch.0, &app).unwrap());
        set_at(&scratch.0, &app, false).unwrap();
    }

    #[test]
    fn rejects_conflicting_and_stale_entries_without_changing_them() {
        let scratch = Scratch::new();
        let app = scratch.0.join("app");
        set_at(&scratch.0, &app, true).unwrap();
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
        set_at(&scratch.0, &app, true).unwrap();
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
}
