//! Reveal one catalog-authorized canonical file. A zero child count means the
//! absolute PIDL itself is the item to select, rather than a directory PIDL.
use std::{
    ffi::OsString,
    marker::PhantomData,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    rc::Rc,
};
use windows::{
    core::PCWSTR,
    Win32::{
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{
            Common::ITEMIDLIST, PathCchStripPrefix, SHGetNameFromIDList,
            SHOpenFolderAndSelectItems, SHParseDisplayName, SIGDN_FILESYSPATH,
        },
    },
};

pub(super) fn reveal(path: &Path) -> Result<(), String> {
    let path = path.to_path_buf();
    // A fresh STA avoids inheriting a pooled worker's unrelated COM apartment.
    // Both COM and the PIDL remain owned by this one thread until selection ends.
    std::thread::Builder::new()
        .name("material-reveal".into())
        .spawn(move || {
            reveal_with_selector(&path, |pidl, children, flags| unsafe {
                SHOpenFolderAndSelectItems(pidl, children, flags)
            })
        })
        .map_err(|error| format!("material-reveal-worker-failed: {error}"))?
        .join()
        .map_err(|_| "material-reveal-worker-panicked".to_owned())?
}

fn reveal_with_selector(
    path: &Path,
    select: impl FnOnce(
        *const ITEMIDLIST,
        Option<&[*const ITEMIDLIST]>,
        u32,
    ) -> windows::core::Result<()>,
) -> Result<(), String> {
    let _apartment = ComApartment::initialize()?;
    let item = AbsolutePidl::parse(path)?;
    // Documented single-item form: cidl=0, apidl=NULL, absolute FILE PIDL.
    // https://learn.microsoft.com/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems
    select(item.0, None, 0).map_err(|error| shell_error("select", error))
}

fn shell_error(stage: &str, error: windows::core::Error) -> String {
    format!(
        "material-reveal-{stage}-failed: 0x{:08x}: {error}",
        error.code().0 as u32
    )
}

struct ComApartment(PhantomData<Rc<()>>);

impl ComApartment {
    fn initialize() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|error| shell_error("com", error))?;
        // S_FALSE also owns one initialization and needs one CoUninitialize.
        Ok(Self(PhantomData))
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct AbsolutePidl(*mut ITEMIDLIST);

fn shell_display_name(path: &Path) -> Result<Vec<u16>, String> {
    let mut name = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // Shell parsing does not accept Win32 verbatim prefixes. Let Windows perform
    // this display conversion, including verbatim UNC, without changing catalog paths.
    unsafe { PathCchStripPrefix(&mut name) }
        .ok()
        .map_err(|error| shell_error("path", error))?;
    Ok(name)
}

fn pidl_file_path(pidl: *const ITEMIDLIST) -> Result<PathBuf, String> {
    let name = unsafe { SHGetNameFromIDList(pidl, SIGDN_FILESYSPATH) }
        .map_err(|error| shell_error("identity", error))?;
    let path = OsString::from_wide(unsafe { name.as_wide() });
    unsafe { CoTaskMemFree(Some(name.0.cast())) };
    Ok(path.into())
}

impl AbsolutePidl {
    fn parse(path: &Path) -> Result<Self, String> {
        let name = shell_display_name(path)?;
        let mut item = Self(std::ptr::null_mut());
        unsafe { SHParseDisplayName(PCWSTR(name.as_ptr()), None, &mut item.0, 0, None) }
            .map_err(|error| shell_error("parse", error))?;
        if item.0.is_null() {
            return Err("material-reveal-empty-pidl".into());
        }
        let actual = pidl_file_path(item.0)?
            .canonicalize()
            .map_err(|error| format!("material-reveal-identity-unavailable: {error}"))?;
        if actual != path {
            return Err("material-reveal-identity-mismatch".into());
        }
        Ok(item)
    }
}

impl Drop for AbsolutePidl {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CoTaskMemFree(Some(self.0.cast())) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{core::HRESULT, Win32::System::Com::COINIT_MULTITHREADED};

    fn pidl_path(pidl: *const ITEMIDLIST) -> std::path::PathBuf {
        pidl_file_path(pidl).unwrap()
    }

    #[test]
    fn windows_shell_display_conversion_preserves_drive_and_unc_targets() {
        for (input, expected) in [
            (r"\\?\C:\中文 #1\image (2).png", r"C:\中文 #1\image (2).png"),
            (
                r"\\?\UNC\server\share\中文 #1.png",
                r"\\server\share\中文 #1.png",
            ),
            (r"C:\unchanged%20name.png", r"C:\unchanged%20name.png"),
        ] {
            let buffer = shell_display_name(Path::new(input)).unwrap();
            let length = buffer.iter().position(|value| *value == 0).unwrap();
            assert_eq!(
                OsString::from_wide(&buffer[..length]),
                OsString::from(expected)
            );
        }
    }

    #[test]
    fn shell_parsing_never_selects_a_different_file_after_prefix_conversion() {
        std::thread::spawn(|| {
            let fixture = tempfile::tempdir().unwrap();
            let root = fixture.path().canonicalize().unwrap();
            std::fs::write(root.join("name.png"), b"ordinary file").unwrap();
            let exact = root.join("name.png.");
            std::fs::write(&exact, b"literal trailing dot").unwrap();
            let canonical = exact.canonicalize().unwrap();
            assert_ne!(canonical, root.join("name.png").canonicalize().unwrap());
            let mut calls = 0;
            let result = reveal_with_selector(&canonical, |pidl, _, _| {
                calls += 1;
                assert_eq!(pidl_path(pidl).canonicalize().unwrap(), canonical);
                Ok(())
            });
            assert_eq!(calls, usize::from(result.is_ok()));
        })
        .join()
        .unwrap();
    }

    #[test]
    fn single_file_selection_uses_absolute_file_pidl_without_child_array() {
        std::thread::spawn(|| {
            let fixture = tempfile::tempdir().unwrap();
            let file = fixture.path().join("中文 image #1 (2).png");
            std::fs::write(&file, b"PIDL fixture").unwrap();
            let canonical = file.canonicalize().unwrap();
            let mut calls = 0;
            reveal_with_selector(&canonical, |pidl, children, flags| {
                calls += 1;
                assert!(children.is_none());
                assert_eq!(flags, 0);
                assert_eq!(pidl_path(pidl).canonicalize().unwrap(), canonical);
                assert_ne!(
                    pidl_path(pidl).canonicalize().unwrap(),
                    canonical.parent().unwrap()
                );
                Ok(())
            })
            .unwrap();
            assert_eq!(calls, 1);
            // A different apartment can initialize only after our STA was balanced.
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .unwrap();
            unsafe { CoUninitialize() };
        })
        .join()
        .unwrap();
    }

    #[test]
    fn selection_hresult_is_preserved_and_com_is_balanced_on_failure() {
        std::thread::spawn(|| {
            let fixture = tempfile::NamedTempFile::new().unwrap();
            let canonical = fixture.path().canonicalize().unwrap();
            let mut calls = 0;
            let error = reveal_with_selector(&canonical, |_, _, _| {
                calls += 1;
                Err(windows::core::Error::from_hresult(HRESULT(
                    0x80070002u32 as i32,
                )))
            })
            .unwrap_err();
            assert_eq!(
                calls, 1,
                "failed selection must not attempt a folder-only fallback"
            );
            assert!(
                error.contains("material-reveal-select-failed: 0x80070002"),
                "{error}"
            );
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .unwrap();
            unsafe { CoUninitialize() };
        })
        .join()
        .unwrap();
    }

    #[test]
    fn failed_com_initialization_never_selects_or_uninitializes_another_apartment() {
        std::thread::spawn(|| {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .unwrap();
            let result = reveal_with_selector(Path::new("C:/unused.png"), |_, _, _| {
                panic!("COM failure reached selection")
            });
            assert!(result.unwrap_err().contains("material-reveal-com-failed"));
            assert_eq!(
                unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.0,
                1,
                "the original MTA must still be initialized"
            );
            unsafe {
                CoUninitialize();
                CoUninitialize();
            }
        })
        .join()
        .unwrap();
    }

    #[test]
    fn parse_failure_never_reaches_selection_and_releases_com() {
        std::thread::spawn(|| {
            let fixture = tempfile::tempdir().unwrap();
            let absent = fixture.path().join("not-created.png");
            let result =
                reveal_with_selector(&absent, |_, _, _| panic!("missing file reached selection"));
            assert!(result.unwrap_err().contains("material-reveal-parse-failed"));
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .unwrap();
            unsafe { CoUninitialize() };
        })
        .join()
        .unwrap();
    }
}
