//! Select the macOS bundle's resource location for read-only admission.
//! This lexical selection grants no trust: installation, file and runtime
//! authority checks still run on the selected resources, without fallbacks.
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub(crate) fn resource_directory(executable: &Path) -> Result<PathBuf, &'static str> {
    const INVALID: &str = "dsh-installation-layout-invalid";
    let bytes = executable.as_os_str().as_bytes();
    if !executable.is_absolute()
        || bytes.contains(&0)
        || bytes.windows(2).any(|part| part == b"//")
        || bytes
            .split(|byte| *byte == b'/')
            .any(|part| part == b"." || part == b"..")
    {
        return Err(INVALID);
    }
    let macos = executable.parent().ok_or(INVALID)?;
    let contents = macos.parent().ok_or(INVALID)?;
    let bundle = contents.parent().ok_or(INVALID)?;
    if executable.file_name().is_none()
        || macos.file_name() != Some(std::ffi::OsStr::new("MacOS"))
        || contents.file_name() != Some(std::ffi::OsStr::new("Contents"))
        || bundle.extension() != Some(std::ffi::OsStr::new("app"))
    {
        return Err(INVALID);
    }
    Ok(contents.join("Resources"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_bundle_selects_resources_including_spaces_and_unicode() {
        for root in ["/Applications", "/Users/example/应用 space"] {
            let bundle = Path::new(root).join("LuckyRay.app");
            assert_eq!(
                resource_directory(&bundle.join("Contents/MacOS/luckyray-app")).unwrap(),
                bundle.join("Contents/Resources")
            );
        }
    }

    #[test]
    fn flat_development_backup_and_traversing_paths_are_not_resource_fallbacks() {
        for path in [
            "relative/LuckyRay.app/Contents/MacOS/luckyray-app",
            "/tmp/luckyray-app",
            "/Applications/LuckyRay.app.saved/Contents/MacOS/luckyray-app",
            "/Applications/LuckyRay.app/Contents/Resources/luckyray-app",
            "/Applications/LuckyRay.app/Contents/MacOS/../luckyray-app",
            "/Applications/LuckyRay.app/Contents/MacOS/./luckyray-app",
            "/Applications//LuckyRay.app/Contents/MacOS/luckyray-app",
        ] {
            assert!(resource_directory(Path::new(path)).is_err(), "{path}");
        }
    }
}
