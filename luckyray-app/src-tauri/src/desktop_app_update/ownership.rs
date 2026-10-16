//! Windows-only installation admission. Never terminates another process.
use fs2::FileExt;
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            CreateMutexW, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

pub(crate) struct Ownership {
    _mutex: windows_sys::Win32::Foundation::HANDLE,
    _lock: File,
    executable: PathBuf,
    profile: PathBuf,
}
// Handles are retained in a process-lifetime OnceLock; never release ownership from another thread.
unsafe impl Send for Ownership {}
unsafe impl Sync for Ownership {}
fn normalized(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_lowercase()
}
fn under(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with('\\'))
}
fn owned_runtime_blocks(path: &str, install: &str, profile: &str,
    pid: u32, parent: u32, reserved: Option<(u32, Option<u32>)>) -> bool {
    // Only exact PIDs attested by the reserved host's authenticated lifecycle,
    // their exact parent links and the pinned bundled Node path qualify.
    // Never excuse siblings, arbitrary descendants or profile runtimes.
    if path == format!(r"{}\deepseek-harness\node\node.exe", install) {
        if let Some((host, surface)) = reserved {
            if pid == host && parent == std::process::id()
                || surface == Some(pid) && parent == host { return false; }
        }
    }
    under(path, install) || under(path, profile)
}
impl Ownership {
    pub(crate) fn acquire(cache: &Path, profile: &Path) -> Result<Self, &'static str> {
        let name: Vec<u16> = "Global\\LuckyRayDesktopSignedUpdateV1"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if mutex.is_null() {
            return Err("update-ownership-unknown");
        }
        let wait = unsafe { WaitForSingleObject(mutex, 30000) };
        if wait != 0 && wait != 128 {
            unsafe {
                CloseHandle(mutex);
            }
            return Err("update-instance-active");
        }
        // This process-lifetime handle is deliberately not closed by Tauri cleanup.
        std::fs::create_dir_all(cache).map_err(|_| "update-cache-unavailable")?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(cache.join("owner.lock"))
            .map_err(|_| "update-cache-unavailable")?;
        lock.try_lock_exclusive()
            .map_err(|_| "update-instance-active")?;
        Ok(Self {
            _mutex: mutex,
            _lock: lock,
            executable: std::env::current_exe().map_err(|_| "update-ownership-unknown")?,
            profile: profile.to_owned(),
        })
    }
    pub(crate) fn admit(&self) -> Result<(), &'static str> {
        self.admit_for_restart(None)
    }
    pub(crate) fn admit_for_restart(&self, reserved_probe: Option<(u32, Option<u32>)>) -> Result<(), &'static str> {
        let install = normalized(
            &std::fs::canonicalize(self.executable.parent().ok_or("update-ownership-unknown")?)
                .map_err(|_| "update-ownership-unknown")?,
        );
        let profile = normalized(
            &std::fs::canonicalize(&self.profile).map_err(|_| "update-ownership-unknown")?,
        );
        let own_name = self
            .executable
            .file_name()
            .ok_or("update-ownership-unknown")?
            .to_string_lossy()
            .to_lowercase();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("update-ownership-unknown");
            }
            struct Handle(windows_sys::Win32::Foundation::HANDLE);
            impl Drop for Handle {
                fn drop(&mut self) {
                    unsafe {
                        CloseHandle(self.0);
                    }
                }
            }
            let _snapshot = Handle(snapshot);
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snapshot, &mut entry);
            while ok != 0 {
                if entry.th32ProcessID != std::process::id() {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|c| *c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                    // Main, shipped sidecars and DSH's bundled Node must be attributable.
                    let relevant = name == own_name
                        || name.starts_with("luckyray")
                        || name == "node.exe"
                        || name == "dsh.exe";
                    if name == own_name || name.starts_with("luckyray") {
                        return Err("update-instance-active");
                    }
                    if relevant {
                        let process =
                            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                        if process.is_null() {
                            return Err("update-ownership-unknown");
                        }
                        let _process = Handle(process);
                        let mut buffer = vec![0u16; 32768];
                        let mut size = buffer.len() as u32;
                        if QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size)
                            == 0
                        {
                            return Err("update-ownership-unknown");
                        }
                        let path = normalized(
                            &std::fs::canonicalize(Path::new(&String::from_utf16_lossy(
                                &buffer[..size as usize],
                            )))
                            .map_err(|_| "update-ownership-unknown")?,
                        );
                        if owned_runtime_blocks(&path, &install, &profile,
                            entry.th32ProcessID, entry.th32ParentProcessID, reserved_probe) {
                            return Err("update-instance-active");
                        }
                    }
                }
                ok = Process32NextW(snapshot, &mut entry);
            }
            if GetLastError() != ERROR_NO_MORE_FILES {
                return Err("update-ownership-unknown");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_boundary_is_not_prefix_guess() {
        assert!(under(r"c:\app\node\node.exe", r"c:\app"));
        assert!(!under(r"c:\app-other\app.exe", r"c:\app"));
    }
    #[test]
    fn reserved_probe_is_not_another_instance_but_other_children_still_block() {
        let install = r"c:\fixture";
        let profile = r"c:\profile";
        let node = r"c:\fixture\deepseek-harness\node\node.exe";
        let parent = std::process::id();
        assert!(!owned_runtime_blocks(node, install, profile, 44, parent, Some((44, None))));
        assert!(owned_runtime_blocks(node, install, profile, 45, parent, Some((44, None))));
        assert!(owned_runtime_blocks(node, install, profile, 44, parent + 1, Some((44, None))));
        assert!(owned_runtime_blocks(node, install, profile, 44, parent, None));
        assert!(owned_runtime_blocks(r"c:\profile\node.exe", install, profile, 44, parent, Some((44, None))));
        assert!(owned_runtime_blocks(r"c:\fixture\other\node.exe", install, profile, 44, parent, Some((44, None))));
        assert!(!owned_runtime_blocks(node, install, profile, 45, 44, Some((44, Some(45)))));
        assert!(owned_runtime_blocks(node, install, profile, 46, 44, Some((44, Some(45)))));
        assert!(owned_runtime_blocks(node, install, profile, 45, parent, Some((44, Some(45)))));
    }
}
