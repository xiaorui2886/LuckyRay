//! Thin Windows launcher for the existing Tauri-generated NSIS installer.
//! Startup is service-free; an immediate update must pass the shared saved/task
//! barrier and drain services before starting the prepared installer.
use std::{
    fs::{File, OpenOptions},
    io::Write,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    os::windows::io::AsRawHandle,
    path::Path,
};
use windows_sys::Win32::{Foundation::CloseHandle, UI::WindowsAndMessaging::SW_SHOWNORMAL};

/// A created but suspended installer is the reliable pre-exit handoff. Its
/// pinned package and directories are already held inside the child. Dropping
/// this guard before commit stops only our never-started child, not any app.
pub(crate) struct PreparedInstaller {
    process: windows_sys::Win32::Foundation::HANDLE,
    thread: windows_sys::Win32::Foundation::HANDLE,
}
impl PreparedInstaller {
    pub(crate) fn start(mut self) -> Result<(), &'static str> {
        unsafe {
            if windows_sys::Win32::System::Threading::ResumeThread(self.thread) == u32::MAX {
                return Err("update-install-failed");
            }
            CloseHandle(self.thread);
            CloseHandle(self.process);
        }
        self.process = std::ptr::null_mut();
        self.thread = std::ptr::null_mut();
        Ok(())
    }
}
impl Drop for PreparedInstaller {
    fn drop(&mut self) {
        if !self.process.is_null() {
            unsafe { stop_unstarted_installer(self.process, self.thread); }
        }
    }
}

pub(crate) fn prepare(cache: &Path, bytes: &[u8]) -> Result<PreparedInstaller, &'static str> {
    let exe = std::env::current_exe().map_err(|_| "update-install-path-invalid")?;
    let parent = std::fs::canonicalize(exe.parent().ok_or("update-install-path-invalid")?)
        .map_err(|_| "update-install-path-invalid")?;
    let _install_path_guard = pin_directory_chain(&parent)?;
    let directory = parent
        .to_str()
        .ok_or("update-install-path-invalid")?
        .trim_start_matches(r"\\?\");
    if directory.as_bytes().get(1) != Some(&b':') {
        return Err("update-install-path-invalid");
    }
    if directory.chars().any(|c| c == '"' || c.is_control()) {
        return Err("update-install-path-invalid");
    }
    // Never launch the staging package directly. Create an exclusive new attempt directory.
    let cache = std::fs::canonicalize(cache).map_err(|_| "update-cache-unavailable")?;
    let _cache_path_guard = pin_directory_chain(&cache)?;
    let attempt = cache.join(format!(
        "installer-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "update-install-failed")?
            .as_nanos()
    ));
    std::fs::create_dir(&attempt).map_err(|_| "update-cache-unavailable")?;
    let _attempt_guard = pin_directory_chain(&attempt)?;
    let path = attempt.join("LuckyRay-update.exe");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "update-cache-unavailable")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "update-cache-unavailable")?;
    }
    // Deny modification/removal between verification and Windows loading the image.
    let file = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .map_err(|_| "update-cache-unavailable")?;
    verify_staged(&file, bytes)?;
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let filename_text = path
        .to_str()
        .ok_or("update-install-path-invalid")?
        .trim_start_matches(r"\\?\");
    let filename = wide(filename_text);
    // /D is deliberately last/unquoted. The executable itself is explicitly passed,
    // so spaces cannot redirect CreateProcess to another application.
    let mut command = wide(&format!("\"{filename_text}\" /P /UPDATE /R /D={directory}"));
    unsafe {
        use windows_sys::Win32::Foundation::{
            DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, ERROR_ELEVATION_REQUIRED,
        };
        use windows_sys::Win32::System::Threading::{
            CreateProcessW, GetCurrentProcess, CREATE_SUSPENDED, PROCESS_INFORMATION,
            STARTUPINFOW,
        };
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        // Current-user NSIS only. Start suspended, with documented full-access
        // process/thread handles. No installer instruction runs before guards exist.
        if CreateProcessW(
            filename.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_SUSPENDED,
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut process,
        ) == 0
        {
            return Err(if GetLastError() == ERROR_ELEVATION_REQUIRED {
                "update-install-elevation-required"
            } else {
                "update-install-failed"
            });
        }
        for guard in std::iter::once(&file)
            .chain(_install_path_guard.iter())
            .chain(_cache_path_guard.iter())
            .chain(_attempt_guard.iter())
        {
            let mut remote = std::ptr::null_mut();
            if DuplicateHandle(
                GetCurrentProcess(),
                guard.as_raw_handle(),
                process.hProcess,
                &mut remote,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            ) == 0
            {
                stop_unstarted_installer(process.hProcess, process.hThread);
                return Err("update-install-failed");
            }
        }
        Ok(PreparedInstaller { process: process.hProcess, thread: process.hThread })
    }
}

pub(crate) fn launch(cache: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    prepare(cache, bytes)?.start()?;
    // No backend/LSH/editor has started in this process. Exiting releases the
    // lifetime mutex; the installer waits for it, rather than killing a live app.
    std::process::exit(0)
}
/// Pin every physical ancestor against rename/delete through process creation.
/// OPEN_REPARSE_POINT plus metadata inspection rejects a substituted junction.
fn pin_directory_chain(path: &Path) -> Result<Vec<File>, &'static str> {
    let mut paths = path
        .ancestors()
        .filter(|p| !p.as_os_str().is_empty())
        .collect::<Vec<_>>();
    paths.reverse();
    let mut handles = Vec::new();
    for directory in paths {
        let handle = OpenOptions::new()
            .access_mode(0x80)
            .share_mode(3)
            .custom_flags(0x02000000 | 0x00200000)
            .open(directory)
            .map_err(|_| "update-install-path-invalid")?;
        let metadata = handle
            .metadata()
            .map_err(|_| "update-install-path-invalid")?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err("update-install-path-invalid");
        }
        handles.push(handle);
    }
    Ok(handles)
}
fn verify_staged(mut file: &File, expected: &[u8]) -> Result<(), &'static str> {
    use std::io::Read;
    if file
        .metadata()
        .map_err(|_| "update-cache-unavailable")?
        .len()
        != expected.len() as u64
    {
        return Err("update-cache-invalid");
    }
    let mut offset = 0;
    let mut buffer = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "update-cache-unavailable")?;
        if n == 0 {
            break;
        }
        if expected.get(offset..offset + n) != Some(&buffer[..n]) {
            return Err("update-cache-invalid");
        }
        offset += n;
    }
    if offset != expected.len() {
        return Err("update-cache-invalid");
    }
    Ok(())
}

/// The receipt is diagnostic evidence, not an authentication or signing key.
pub(crate) fn completion_matches(version: &str) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(root) = exe.parent() else {
        return false;
    };
    if root.join("luckyray-install-in-progress.txt").exists() {
        return false;
    }
    let Ok(file) = File::open(root.join("luckyray-install-complete.txt")) else {
        return false;
    };
    if file.metadata().map(|m| m.len() > 256).unwrap_or(true) {
        return false;
    }
    use std::io::Read;
    let mut value = String::new();
    file.take(257).read_to_string(&mut value).is_ok()
        && value == format!("com.luckyray.desktop|{version}")
}
pub(crate) fn refuse_incomplete_installation() {
    let partial = std::env::current_exe()
        .ok()
        .and_then(|p| {
            p.parent()
                .map(|p| p.join("luckyray-install-in-progress.txt"))
        })
        .is_some_and(|p| p.exists());
    if !partial {
        return;
    }
    // Do not start DSH or open user databases against a partially replaced program.
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let title = wide("LuckyRay");
    let message=wide("上次安装未完成。为保护数据，软件暂未启动。请从官方下载页重新运行安装包进行修复，不要删除应用数据。\n\n打开官方下载页？\nThe previous installation did not complete. Open the official download page to repair it?");
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDYES, MB_ICONERROR, MB_YESNO,
        };
        if MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONERROR,
        ) == IDYES
        {
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            let verb = wide("open");
            let url = wide("https://github.com/xiaorui2886/LuckyRay/releases");
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }
    std::process::exit(1);
}

pub(crate) fn startup_notice(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
    let title: Vec<u16> = "LuckyRay".encode_utf16().chain(Some(0)).collect();
    let message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONWARNING,
        );
    }
}

/// This process was created by us and is still suspended. Never stop an existing app.
unsafe fn stop_unstarted_installer(
    process: windows_sys::Win32::Foundation::HANDLE,
    thread: windows_sys::Win32::Foundation::HANDLE,
) {
    use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};
    let terminated = TerminateProcess(process, 1) != 0;
    let waited = WaitForSingleObject(process, 5000);
    if waited != 0 {
        let _ = terminated;
        startup_notice("无法确认本次尚未运行的安装器已退出，已停止启动以保护文件。请在任务管理器关闭本次 LuckyRay-update.exe 与等待中的 LuckyRay 后重试。\nThe suspended installer could not be confirmed stopped. Close this LuckyRay-update.exe and waiting LuckyRay process in Task Manager before retrying.");
        loop {
            std::thread::park();
        }
    }
    CloseHandle(thread);
    CloseHandle(process);
}
