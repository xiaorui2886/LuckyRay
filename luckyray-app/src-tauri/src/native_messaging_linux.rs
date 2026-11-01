//! Per-user Linux native-messaging manifest installation.
//!
//! New registration uses an unnamed inode; revocation empties allowed_origins
//! through a checked transaction retaining backups and prior inodes. No shell,
//! system-wide browser configuration, pathname deletion or implicit grant change.

use std::ffi::{CString, OsString};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
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
    Reenabled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RevokeOutcome { Revoked, AlreadyRevoked, Absent }

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
    source: &crate::linux_fs::RunningExecutable,
) -> Result<InstallOutcome, &'static str> {
    registration_family(manifest)?;
    verify_source(manifest, source)?;
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
    let result = install_at(&root, profile, manifest)?;
    if verify_source(manifest, source).is_err() {
        // Compensate only inside the same captured browser location, and only
        // if its exact managed active/revoked family still matches.
        let _ = revoke_at(&root, profile, manifest);
        return Err("linux-native-host-install-uncertain");
    }
    Ok(result)
}

pub(crate) fn revoke_for_current_user(browser: Browser, manifest: &[u8], source: &crate::linux_fs::RunningExecutable) -> Result<RevokeOutcome, &'static str> {
    registration_family(manifest)?;
    verify_source(manifest, source)?;
    if unsafe { libc::geteuid() } == 0 { return Err("linux-native-host-user-required"); }
    let (root, profile) = location_from(browser,
        std::env::var_os("CHROME_USER_DATA_DIR"), std::env::var_os("CHROME_CONFIG_HOME"),
        std::env::var_os("XDG_CONFIG_HOME"), std::env::var_os("HOME"))?;
    let result = revoke_at(&root, profile, manifest)?;
    verify_source(manifest, source).map_err(|_| "linux-native-host-revocation-uncertain")?;
    Ok(result)
}

fn verify_source(manifest: &[u8], source: &crate::linux_fs::RunningExecutable) -> Result<(), &'static str> {
    let value: serde_json::Value = serde_json::from_slice(manifest).map_err(|_| "linux-native-host-manifest-invalid")?;
    if value["path"].as_str().map(Path::new) != Some(source.path()) { return Err("linux-native-host-binary-invalid"); }
    source.revalidate().map_err(|_| "linux-native-host-binary-invalid")
}

fn registration_family(expected: &[u8]) -> Result<Vec<u8>, &'static str> {
    if expected.is_empty() || expected.len() > MAX_MANIFEST_BYTES { return Err("linux-native-host-manifest-invalid"); }
    let mut value: serde_json::Value = serde_json::from_slice(expected).map_err(|_| "linux-native-host-manifest-invalid")?;
    let valid = value.as_object().is_some_and(|object| object.len() == 5)
        && value["name"].as_str() == Some(crate::local_transport::NATIVE_HOST_NAME)
        && value["description"].as_str() == Some("LuckyRay browser bridge")
        && value["type"].as_str() == Some("stdio")
        && value["path"].as_str().is_some_and(|path| Path::new(path).is_absolute());
    let origins = value["allowed_origins"].as_array().ok_or("linux-native-host-manifest-invalid")?;
    if !valid || origins.is_empty() || origins.iter().any(|origin| {
        let Some(origin) = origin.as_str() else { return true; };
        let Some(id) = origin.strip_prefix("chrome-extension://").and_then(|value| value.strip_suffix('/')) else { return true; };
        if id.len() != 32 || !id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)) { return true; }
        crate::local_transport::canonical_extension_origin(origin.trim_end_matches('/'))
            .is_none_or(|canonical| format!("{canonical}/") != origin)
    }) { return Err("linux-native-host-manifest-invalid"); }
    value["allowed_origins"] = serde_json::json!([]);
    serde_json::to_vec_pretty(&value).map_err(|_| "linux-native-host-manifest-invalid")
}

fn record_error(error: io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::Interrupted => "linux-native-host-recovery-required",
        io::ErrorKind::Unsupported => "linux-native-host-file-attributes-unsupported",
        _ => "linux-native-host-manifest-conflict",
    }
}

fn registry_directory(root: &Path, profile: Option<&str>, create: bool)
    -> Result<Option<crate::linux_fs::Directory>, &'static str> {
    let mut paths = vec![root.to_path_buf()];
    let parent = if let Some(name) = profile {
        if !["google-chrome", "chromium", "microsoft-edge", "google-chrome-for-testing"].contains(&name) {
            return Err("linux-native-host-browser-invalid");
        }
        let parent = root.join(name);
        paths.push(parent.clone());
        parent
    } else { root.to_path_buf() };
    paths.push(parent.join("NativeMessagingHosts"));
    let last = paths.len() - 1;
    for (index, path) in paths.iter().enumerate() {
        // A registration may create the chosen browser subdirectory, never an
        // arbitrary missing configuration root or a profile during revocation.
        match crate::linux_fs::Directory::owned(path, create && index != 0) {
            Ok(directory) if index == last => return Ok(Some(directory)),
            Ok(_) => {},
            Err(error) if !create && error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(record_error(error)),
        }
    }
    Err("linux-native-host-directory-invalid")
}

fn install_at(root: &Path, profile: Option<&str>, expected: &[u8]) -> Result<InstallOutcome, &'static str> {
    let revoked = registration_family(expected)?;
    let family = [expected, revoked.as_slice()];
    let directory = registry_directory(root, profile, true)?.ok_or("linux-native-host-directory-invalid")?;
    let target = std::ffi::OsStr::new(MANIFEST);
    crate::linux_managed_record::recover(&directory, target, &family).map_err(record_error)?;
    if let Some(existing) = crate::linux_managed_record::read(&directory, target, &family).map_err(record_error)? {
        if existing.state == 0 { return Ok(InstallOutcome::AlreadyInstalled); }
        crate::linux_managed_record::set(&directory, target, &family, 0).map_err(record_error)?;
        return Ok(InstallOutcome::Reenabled);
    }
    crate::linux_fs::no_default_acl(&directory.file).map_err(record_error)?;
    let dot = c".";
    let fd = unsafe { libc::openat(directory.file.as_raw_fd(), dot.as_ptr(),
        libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC, 0o600) };
    let mut temporary = crate::linux_fs::owned_fd(fd).map_err(|_| "linux-native-host-atomic-install-unavailable")?;
    temporary.write_all(expected).and_then(|_| temporary.sync_all()).map_err(|_| "linux-native-host-write-failed")?;
    let source = CString::new(format!("/proc/self/fd/{}", temporary.as_raw_fd())).map_err(|_| "linux-native-host-write-failed")?;
    let name = CString::new(MANIFEST).expect("fixed manifest name");
    directory.verify().map_err(record_error)?;
    let result = unsafe { libc::linkat(libc::AT_FDCWD, source.as_ptr(), directory.file.as_raw_fd(), name.as_ptr(), libc::AT_SYMLINK_FOLLOW) };
    if result != 0 {
        if io::Error::last_os_error().kind() == io::ErrorKind::AlreadyExists {
            return match crate::linux_managed_record::read(&directory, target, &family).map_err(record_error)? {
                Some(record) if record.state == 0 => Ok(InstallOutcome::AlreadyInstalled),
                _ => Err("linux-native-host-manifest-conflict"),
            };
        }
        return Err("linux-native-host-atomic-install-unavailable");
    }
    let installed = crate::linux_managed_record::read(&directory, target, &family)
        .map_err(|_| "linux-native-host-install-uncertain")?.ok_or("linux-native-host-install-uncertain")?;
    let source = temporary.metadata().map_err(|_| "linux-native-host-install-uncertain")?;
    if (installed.snapshot.version.device, installed.snapshot.version.inode) != (source.dev(), source.ino())
        || installed.state != 0 { return Err("linux-native-host-install-uncertain"); }
    directory.file.sync_all().and_then(|_| directory.verify()).map_err(|_| "linux-native-host-install-uncertain")?;
    Ok(InstallOutcome::Installed)
}

fn revoke_at(root: &Path, profile: Option<&str>, expected: &[u8]) -> Result<RevokeOutcome, &'static str> {
    let revoked = registration_family(expected)?;
    let family = [expected, revoked.as_slice()];
    let Some(directory) = registry_directory(root, profile, false)? else { return Ok(RevokeOutcome::Absent); };
    let target = std::ffi::OsStr::new(MANIFEST);
    crate::linux_managed_record::recover(&directory, target, &family).map_err(record_error)?;
    match crate::linux_managed_record::read(&directory, target, &family).map_err(record_error)? {
        None => return Ok(RevokeOutcome::Absent),
        Some(record) if record.state == 1 => return Ok(RevokeOutcome::AlreadyRevoked),
        Some(_) => {},
    }
    crate::linux_managed_record::set(&directory, target, &family, 1).map_err(record_error)?;
    Ok(RevokeOutcome::Revoked)
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

    fn manifest(path: &Path) -> Vec<u8> {
        serde_json::to_vec_pretty(&serde_json::json!({
            "name": crate::local_transport::NATIVE_HOST_NAME,
            "description": "LuckyRay browser bridge", "type": "stdio", "path": path,
            "allowed_origins": ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
        })).unwrap()
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
    fn malformed_registration_is_refused_before_profile_access() {
        let source = crate::linux_fs::RunningExecutable::acquire(&std::env::current_exe().unwrap()).unwrap();
        assert_eq!(
            install_for_current_user(Browser::Chromium, b"synthetic", &source),
            Err("linux-native-host-manifest-invalid")
        );
    }

    #[test]
    fn installs_new_manifest_without_replacing_existing_content() {
        let root = Scratch::new();
        let expected = manifest(&std::env::current_exe().unwrap());
        assert_eq!(
            install_at(&root.0, Some("chromium"), &expected).unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(
            install_at(&root.0, Some("chromium"), &expected).unwrap(),
            InstallOutcome::AlreadyInstalled
        );
        let path = root.0.join("chromium/NativeMessagingHosts").join(MANIFEST);
        assert_eq!(fs::read(&path).unwrap(), expected);
        assert_eq!(
            install_at(&root.0, Some("chromium"), &manifest(&root.0.join("foreign"))),
            Err("linux-native-host-manifest-conflict")
        );
        assert_eq!(fs::read(path).unwrap(), expected);
    }

    #[test]
    fn refuses_a_symlinked_manifest_or_browser_directory() {
        let root = Scratch::new();
        let expected = manifest(&std::env::current_exe().unwrap());
        let outside = root.0.join("outside");
        fs::write(&outside, b"preserve").unwrap();
        let directory = root.0.join("chromium/NativeMessagingHosts");
        fs::create_dir_all(&directory).unwrap();
        symlink(&outside, directory.join(MANIFEST)).unwrap();
        assert!(install_at(&root.0, Some("chromium"), &expected).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"preserve");
        symlink(&directory, root.0.join("google-chrome")).unwrap();
        assert!(install_at(&root.0, Some("google-chrome"), &expected).is_err());
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
            install_at(&root.0, Some("chromium"), &manifest(&std::env::current_exe().unwrap())),
            Err("linux-native-host-manifest-conflict")
        );
        assert_eq!(fs::read(outside).unwrap(), b"foreign");
    }

    #[test]
    fn installs_into_an_absolute_unicode_config_path() {
        let root = Scratch::new();
        let config = root.0.join("\u{4e2d}\u{6587} config");
        fs::create_dir(&config).unwrap();
        let expected = manifest(&std::env::current_exe().unwrap());
        assert_eq!(
            install_at(&config, None, &expected).unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(
            fs::read(config.join("NativeMessagingHosts").join(MANIFEST)).unwrap(),
            expected
        );
    }

    #[test]
    fn linux_registration_revocation_is_explicit_idempotent_and_reenable_is_checked() {
        let root = Scratch::new();
        let expected = manifest(&std::env::current_exe().unwrap());
        assert_eq!(revoke_at(&root.0, Some("chromium"), &expected).unwrap(), RevokeOutcome::Absent);
        assert!(!root.0.join("chromium").exists());
        assert_eq!(install_at(&root.0, Some("chromium"), &expected).unwrap(), InstallOutcome::Installed);
        let path = root.0.join("chromium/NativeMessagingHosts").join(MANIFEST);
        let old_inode = fs::metadata(&path).unwrap().ino();
        assert_eq!(revoke_at(&root.0, Some("chromium"), &expected).unwrap(), RevokeOutcome::Revoked);
        let disabled: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(disabled["allowed_origins"], serde_json::json!([]));
        assert_eq!(revoke_at(&root.0, Some("chromium"), &expected).unwrap(), RevokeOutcome::AlreadyRevoked);
        let directory = path.parent().unwrap();
        let displaced = fs::read_dir(directory).unwrap().map(|item| item.unwrap().path())
            .find(|path| path.extension().is_some_and(|ext| ext == "displaced")).unwrap();
        assert_eq!(fs::metadata(&displaced).unwrap().ino(), old_inode);
        assert_eq!(fs::read(displaced).unwrap(), expected);
        assert_eq!(install_at(&root.0, Some("chromium"), &expected).unwrap(), InstallOutcome::Reenabled);
        assert_eq!(fs::read(path).unwrap(), expected);
    }

    #[test]
    fn linux_registration_refuses_ancestor_links_and_foreign_revocations() {
        let root = Scratch::new();
        let outside = Scratch::new();
        let expected = manifest(&std::env::current_exe().unwrap());
        let alias = root.0.join("alias");
        symlink(&outside.0, &alias).unwrap();
        assert!(install_at(&alias, Some("chromium"), &expected).is_err());
        assert!(!outside.0.join("chromium").exists());
        install_at(&root.0, Some("chromium"), &expected).unwrap();
        let path = root.0.join("chromium/NativeMessagingHosts").join(MANIFEST);
        fs::write(&path, b"foreign registration").unwrap();
        assert!(revoke_at(&root.0, Some("chromium"), &expected).is_err());
        assert_eq!(fs::read(path).unwrap(), b"foreign registration");
    }
}
