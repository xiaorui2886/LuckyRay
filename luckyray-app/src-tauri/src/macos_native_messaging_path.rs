//! Match Tauri's macOS app-data location for the browser-launched host.
//! This module does not create the directory or read any credentials.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

fn validated_home(home: Option<&OsStr>) -> Result<&Path, String> {
    let home = home.map(Path::new).ok_or("native-home-unavailable")?;
    if !home.is_absolute()
        || home
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("native-home-unavailable".to_string());
    }
    Ok(home)
}

pub(crate) fn app_data_dir(home: Option<&OsStr>) -> Result<PathBuf, String> {
    let home = validated_home(home)?;
    Ok(home.join("Library/Application Support/com.luckyray.desktop"))
}

/// User-level stable-channel locations only. This is a lexical plan, not
/// permission to write or remove a manifest or a proof of directory identity.
pub(crate) fn browser_manifest_paths(home: Option<&OsStr>) -> Result<[PathBuf; 2], String> {
    let home = validated_home(home)?;
    Ok([
        home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.luckyray.desktop.json"),
        home.join("Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.luckyray.desktop.json"),
    ])
}

#[cfg(test)]
mod tests {
    use super::{app_data_dir, browser_manifest_paths};
    use std::ffi::OsStr;

    #[test]
    fn retains_spaces_and_unicode_in_home_path() {
        let home = std::env::temp_dir().join("LuckyRay 路径 space");
        assert_eq!(
            app_data_dir(Some(home.as_os_str())).unwrap(),
            home.join("Library/Application Support/com.luckyray.desktop")
        );
    }

    #[test]
    fn refuses_missing_relative_or_parent_traversing_home() {
        assert!(app_data_dir(None).is_err());
        assert!(app_data_dir(Some(OsStr::new(""))).is_err());
        assert!(app_data_dir(Some(OsStr::new("relative"))).is_err());
        let traversing = std::env::temp_dir().join("..").join("other");
        assert!(app_data_dir(Some(traversing.as_os_str())).is_err());
        assert!(browser_manifest_paths(Some(traversing.as_os_str())).is_err());
    }

    #[test]
    fn derives_only_the_two_stable_user_manifest_paths() {
        let home = std::env::temp_dir().join("LuckyRay user home");
        let paths = browser_manifest_paths(Some(home.as_os_str())).unwrap();
        assert_eq!(paths[0], home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.luckyray.desktop.json"));
        assert_eq!(paths[1], home.join("Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.luckyray.desktop.json"));
    }
}
