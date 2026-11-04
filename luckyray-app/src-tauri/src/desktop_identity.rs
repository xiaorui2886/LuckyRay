//! The desktop identity bound into local MCP pairings (`desktopExe`) and into
//! the v2/v3 nonce proofs. Windows and macOS keep `current_exe()` exactly.
//!
//! Linux: an AppImage runs from a fresh `/tmp/.mount_*` directory every launch,
//! so the identity is `$APPIMAGE`, but only while the executable really runs
//! inside that image's `$APPDIR` and `$APPIMAGE` is a regular file; otherwise
//! the executable path. A mount path is never an identity. The same rules live
//! in `packages/community-mcp/src/server-linux.mjs` (`stableIdentity`), which
//! pairs the plugin with the running desktop.

pub(crate) const UNAVAILABLE: &str = "desktop-identity-unavailable";

#[cfg(not(target_os = "linux"))]
pub(crate) fn executable() -> Result<String, &'static str> {
    Ok(std::env::current_exe()
        .map_err(|_| UNAVAILABLE)?
        .to_string_lossy()
        .into_owned())
}

#[cfg(target_os = "linux")]
pub(crate) fn executable() -> Result<String, &'static str> {
    let exe = std::env::current_exe().map_err(|_| UNAVAILABLE)?;
    stable(
        exe.as_os_str(),
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("APPDIR").as_deref(),
    )
    .ok_or(UNAVAILABLE)
}

/// Absolute, already normalized (what Node's `path.resolve(p) === p` accepts).
#[cfg(target_os = "linux")]
fn normal(p: &str) -> bool {
    p.starts_with('/')
        && !p.contains('\0')
        && (p == "/" || !p.ends_with('/'))
        && !p.contains("//")
        && !p.split('/').any(|c| c == "." || c == "..")
}

#[cfg(target_os = "linux")]
pub(crate) fn stable(
    exe: &std::ffi::OsStr,
    appimage: Option<&std::ffi::OsStr>,
    appdir: Option<&std::ffi::OsStr>,
) -> Option<String> {
    let exe = exe.to_str().filter(|e| normal(e))?;
    if let Some(image) = appimage {
        let image = image.to_str().filter(|i| normal(i))?;
        let dir = appdir?.to_str().filter(|d| normal(d) && *d != "/")?;
        if !exe.starts_with(&format!("{dir}/")) {
            return None;
        }
        // lstat: a symlinked or missing image is not an identity.
        if !std::fs::symlink_metadata(image).ok()?.file_type().is_file() {
            return None;
        }
        return Some(image.to_owned());
    }
    if exe.split('/').any(|c| c.starts_with(".mount_")) {
        return None;
    }
    Some(exe.to_owned())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn s(v: &str) -> &OsStr {
        OsStr::new(v)
    }

    #[test]
    fn appimage_is_named_by_its_image_only_while_running_inside_appdir() {
        let dir = std::env::temp_dir().join(format!("lr-identity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = dir.join("LuckyRay_1.9.9_amd64.AppImage");
        std::fs::write(&image, b"synthetic").unwrap();
        let image = image.to_str().unwrap().to_owned();
        let mount = format!("{}/.mount_Ab12Cd", dir.to_str().unwrap());
        let inner = format!("{mount}/usr/bin/luckyray-app");
        assert_eq!(stable(s(&inner), Some(s(&image)), Some(s(&mount))), Some(image.clone()));
        assert_eq!(stable(s("/usr/bin/luckyray-app"), None, None).as_deref(), Some("/usr/bin/luckyray-app"));
        let missing = format!("{}/missing.AppImage", dir.to_str().unwrap());
        let dotted = format!("{}/x/../LuckyRay_1.9.9_amd64.AppImage", dir.to_str().unwrap());
        let link = format!("{}/link.AppImage", dir.to_str().unwrap());
        std::os::unix::fs::symlink(&image, &link).unwrap();
        for (exe, img, appdir) in [
            (inner.as_str(), None, None),
            (inner.as_str(), Some(image.as_str()), None),
            ("/usr/bin/luckyray-app", Some(image.as_str()), Some(mount.as_str())),
            (inner.as_str(), Some(missing.as_str()), Some(mount.as_str())),
            (inner.as_str(), Some("relative.AppImage"), Some(mount.as_str())),
            (inner.as_str(), Some(""), Some(mount.as_str())),
            (inner.as_str(), Some(image.as_str()), Some("/")),
            (inner.as_str(), Some(dotted.as_str()), Some(mount.as_str())),
            (inner.as_str(), Some(link.as_str()), Some(mount.as_str())),
            ("relative/luckyray-app", None, None),
            ("/opt//luckyray-app", None, None),
        ] {
            assert_eq!(stable(s(exe), img.map(s), appdir.map(s)), None, "{exe} {img:?} {appdir:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn this_process_has_an_identity() {
        // Test binaries run from target/, never from an AppImage mount.
        if std::env::var_os("APPIMAGE").is_none() {
            assert_eq!(executable().unwrap(), std::env::current_exe().unwrap().to_str().unwrap());
        }
    }
}
