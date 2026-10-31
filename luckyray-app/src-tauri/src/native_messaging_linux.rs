//! Per-user Linux native-messaging manifest installation.
//!
//! Only a new name is installed. An existing different entry is never
//! replaced. Publication uses an unnamed inode and a held directory fd; no
//! shell, system-wide browser configuration or PATH lookup is involved.
//! Removal of an existing entry is intentionally not implemented until the
//! requested file-concurrency contract has been decided and proved.

use std::ffi::{CString, OsString};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const MANIFEST: &str = "com.luckyray.desktop.json";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Browser {
    Chrome,
    Chromium,
    Edge,
    ChromeForTesting,
}

impl Browser {
    pub(crate) fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "chrome" => Ok(Self::Chrome),
            "chromium" => Ok(Self::Chromium),
            "edge" => Ok(Self::Edge),
            "chrome-for-testing" => Ok(Self::ChromeForTesting),
            _ => Err("linux-native-host-browser-invalid"),
        }
    }

    fn profile_dir(self) -> &'static str {
        match self {
            Self::Chrome => "google-chrome",
            Self::Chromium => "chromium",
            Self::Edge => "microsoft-edge",
            Self::ChromeForTesting => "google-chrome-for-testing",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum InstallOutcome {
    Installed,
    AlreadyInstalled,
}

fn absolute(value: Option<OsString>) -> Option<PathBuf> {
    value.map(PathBuf::from).filter(|value| value.is_absolute())
}

fn location_from(
    browser: Browser,
    chrome_data: Option<OsString>,
    chrome_config: Option<OsString>,
    xdg_config: Option<OsString>,
    home: Option<OsString>,
) -> Result<(PathBuf, Option<&'static str>), &'static str> {
    if browser != Browser::Edge {
        if let Some(value) = chrome_data.filter(|value| !value.is_empty()) {
            return absolute(Some(value))
                .map(|root| (root, None))
                .ok_or("linux-native-host-config-invalid");
        }
        if let Some(value) = chrome_config.filter(|value| !value.is_empty()) {
            return absolute(Some(value))
                .map(|root| (root, Some(browser.profile_dir())))
                .ok_or("linux-native-host-config-invalid");
        }
    }
    let root = absolute(xdg_config)
        .or_else(|| absolute(home).map(|path| path.join(".config")))
        .ok_or("linux-native-host-config-invalid")?;
    Ok((root, Some(browser.profile_dir())))
}

pub(crate) fn install_for_current_user(
    browser: Browser,
    manifest: &[u8],
) -> Result<InstallOutcome, &'static str> {
    crate::linux_credential_admission::require()?;
    // A package post-install script often runs as root. It must not install a
    // manifest in root's profile on behalf of an unknown desktop user.
    if unsafe { libc::geteuid() } == 0 {
        return Err("linux-native-host-user-required");
    }
    let (root, profile) = location_from(
        browser,
        std::env::var_os("CHROME_USER_DATA_DIR"),
        std::env::var_os("CHROME_CONFIG_HOME"),
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("HOME"),
    )?;
    install_at(&root, profile, manifest)
}

fn validate_directory(file: &File) -> Result<(), &'static str> {
    let metadata = file
        .metadata()
        .map_err(|_| "linux-native-host-directory-invalid")?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err("linux-native-host-directory-invalid");
    }
    Ok(())
}

fn open_root(root: &Path) -> Result<File, &'static str> {
    if !root.is_absolute() {
        return Err("linux-native-host-config-invalid");
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)
        .map_err(|_| "linux-native-host-config-unavailable")?;
    validate_directory(&file)?;
    Ok(file)
}

fn open_directory_at(parent: &File, name: &str) -> io::Result<File> {
    let name = CString::new(name).map_err(|_| io::ErrorKind::InvalidInput)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn ensure_directory_at(parent: &File, name: &str) -> Result<File, &'static str> {
    let directory = match open_directory_at(parent, name) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let name_c = CString::new(name).map_err(|_| "linux-native-host-directory-invalid")?;
            let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name_c.as_ptr(), 0o700) };
            if result != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err("linux-native-host-directory-unavailable");
            }
            open_directory_at(parent, name)
                .map_err(|_| "linux-native-host-directory-unavailable")?
        }
        Err(_) => return Err("linux-native-host-directory-unavailable"),
    };
    validate_directory(&directory)?;
    Ok(directory)
}

fn read_existing(directory: &File) -> Result<Option<(std::fs::Metadata, Vec<u8>)>, &'static str> {
    let name = CString::new(MANIFEST).expect("fixed manifest name");
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        if io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err("linux-native-host-manifest-conflict");
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|_| "linux-native-host-manifest-conflict")?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o022 != 0
        || metadata.len() > MAX_MANIFEST_BYTES as u64
    {
        return Err("linux-native-host-manifest-conflict");
    }
    let mut bytes = Vec::new();
    file.take((MAX_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "linux-native-host-manifest-conflict")?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("linux-native-host-manifest-conflict");
    }
    Ok(Some((metadata, bytes)))
}

fn inspect_existing(
    directory: &File,
    expected: &[u8],
) -> Result<Option<InstallOutcome>, &'static str> {
    match read_existing(directory)? {
        None => Ok(None),
        Some((_, bytes)) if bytes == expected => Ok(Some(InstallOutcome::AlreadyInstalled)),
        Some(_) => Err("linux-native-host-manifest-conflict"),
    }
}

fn install_at(
    root: &Path,
    profile: Option<&str>,
    expected: &[u8],
) -> Result<InstallOutcome, &'static str> {
    if expected.is_empty() || expected.len() > MAX_MANIFEST_BYTES {
        return Err("linux-native-host-manifest-invalid");
    }
    let root = open_root(root)?;
    let profile_dir;
    let parent = if let Some(name) = profile {
        // This private function only accepts the four fixed browser names.
        if ![
            "google-chrome",
            "chromium",
            "microsoft-edge",
            "google-chrome-for-testing",
        ]
        .contains(&name)
        {
            return Err("linux-native-host-browser-invalid");
        }
        profile_dir = ensure_directory_at(&root, name)?;
        &profile_dir
    } else {
        &root
    };
    let directory = ensure_directory_at(parent, "NativeMessagingHosts")?;
    if let Some(outcome) = inspect_existing(&directory, expected)? {
        return Ok(outcome);
    }

    let dot = CString::new(".").expect("fixed name");
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            dot.as_ptr(),
            libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("linux-native-host-atomic-install-unavailable");
    }
    let mut temporary = unsafe { File::from_raw_fd(fd) };
    temporary
        .write_all(expected)
        .and_then(|_| temporary.sync_all())
        .map_err(|_| "linux-native-host-write-failed")?;
    let source = CString::new(format!("/proc/self/fd/{}", temporary.as_raw_fd()))
        .map_err(|_| "linux-native-host-write-failed")?;
    let target = CString::new(MANIFEST).expect("fixed manifest name");
    let result = unsafe {
        libc::linkat(
            libc::AT_FDCWD,
            source.as_ptr(),
            directory.as_raw_fd(),
            target.as_ptr(),
            libc::AT_SYMLINK_FOLLOW,
        )
    };
    if result != 0 {
        if io::Error::last_os_error().kind() == io::ErrorKind::AlreadyExists {
            return inspect_existing(&directory, expected)?
                .ok_or("linux-native-host-manifest-conflict");
        }
        return Err("linux-native-host-atomic-install-unavailable");
    }
    let source_metadata = temporary
        .metadata()
        .map_err(|_| "linux-native-host-install-uncertain")?;
    let Some((installed, bytes)) =
        read_existing(&directory).map_err(|_| "linux-native-host-install-uncertain")?
    else {
        return Err("linux-native-host-install-uncertain");
    };
    if installed.dev() != source_metadata.dev()
        || installed.ino() != source_metadata.ino()
        || bytes != expected
    {
        return Err("linux-native-host-install-uncertain");
    }
    // Failure after publication is reported as uncertain, never as a rollback.
    directory
        .sync_all()
        .map_err(|_| "linux-native-host-install-uncertain")?;
    Ok(InstallOutcome::Installed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "luckyray-native-host-linux-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn chromium_environment_uses_only_absolute_config_and_known_profiles() {
        let root = Scratch::new();
        assert_eq!(
            location_from(
                Browser::Chrome,
                Some(root.0.clone().into()),
                None,
                None,
                None
            )
            .unwrap(),
            (root.0.clone(), None)
        );
        assert_eq!(
            location_from(
                Browser::Chromium,
                None,
                Some(root.0.clone().into()),
                None,
                None
            )
            .unwrap(),
            (root.0.clone(), Some("chromium"))
        );
        assert_eq!(
            location_from(
                Browser::Edge,
                Some("ignored".into()),
                None,
                Some(root.0.clone().into()),
                None
            )
            .unwrap(),
            (root.0.clone(), Some("microsoft-edge"))
        );
        assert!(location_from(Browser::Chrome, Some("relative".into()), None, None, None).is_err());
        assert!(Browser::parse("../../foreign").is_err());
    }

    #[test]
    fn production_registration_entry_is_closed_before_profile_access() {
        assert_eq!(
            install_for_current_user(Browser::Chromium, b"synthetic"),
            Err(crate::linux_credential_admission::UNAVAILABLE)
        );
    }

    #[test]
    fn installs_new_manifest_without_replacing_existing_content() {
        let root = Scratch::new();
        let expected = br#"{"name":"com.luckyray.desktop","type":"stdio"}"#;
        assert_eq!(
            install_at(&root.0, Some("chromium"), expected).unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(
            install_at(&root.0, Some("chromium"), expected).unwrap(),
            InstallOutcome::AlreadyInstalled
        );
        let path = root.0.join("chromium/NativeMessagingHosts").join(MANIFEST);
        assert_eq!(fs::read(&path).unwrap(), expected);
        assert_eq!(
            install_at(&root.0, Some("chromium"), b"foreign"),
            Err("linux-native-host-manifest-conflict")
        );
        assert_eq!(fs::read(path).unwrap(), expected);
    }

    #[test]
    fn refuses_a_symlinked_manifest_or_browser_directory() {
        let root = Scratch::new();
        let outside = root.0.join("outside");
        fs::write(&outside, b"preserve").unwrap();
        let directory = root.0.join("chromium/NativeMessagingHosts");
        fs::create_dir_all(&directory).unwrap();
        symlink(&outside, directory.join(MANIFEST)).unwrap();
        assert!(install_at(&root.0, Some("chromium"), b"expected").is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"preserve");
        symlink(&directory, root.0.join("google-chrome")).unwrap();
        assert!(install_at(&root.0, Some("google-chrome"), b"expected").is_err());
        assert_eq!(fs::read(outside).unwrap(), b"preserve");
    }

    #[test]
    fn refuses_hardlinked_existing_file_and_preserves_its_contents() {
        let root = Scratch::new();
        let directory = root.0.join("chromium/NativeMessagingHosts");
        fs::create_dir_all(&directory).unwrap();
        let outside = root.0.join("existing");
        fs::write(&outside, b"foreign").unwrap();
        fs::hard_link(&outside, directory.join(MANIFEST)).unwrap();
        assert_eq!(
            install_at(&root.0, Some("chromium"), b"new"),
            Err("linux-native-host-manifest-conflict")
        );
        assert_eq!(fs::read(outside).unwrap(), b"foreign");
    }

    #[test]
    fn installs_into_an_absolute_unicode_config_path() {
        let root = Scratch::new();
        let config = root.0.join("\u{4e2d}\u{6587} config");
        fs::create_dir(&config).unwrap();
        assert_eq!(
            install_at(&config, None, b"configured").unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(
            fs::read(config.join("NativeMessagingHosts").join(MANIFEST)).unwrap(),
            b"configured"
        );
    }
}
