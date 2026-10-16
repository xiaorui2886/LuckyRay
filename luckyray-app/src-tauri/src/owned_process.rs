//! Lifecycle-neutral Windows process containment.
//!
//! This module owns only the pre-execution Job binding and inherited stdio
//! carrier. Product runtimes remain responsible for protocol, readiness,
//! restart and durable outcome truth.

#[cfg(all(windows, feature = "browser-host-runtime"))]
use std::ffi::{c_void, OsStr, OsString};
#[cfg(all(windows, feature = "browser-host-runtime"))]
use std::fs;
#[cfg(all(windows, feature = "browser-host-runtime"))]
use std::os::windows::ffi::OsStrExt;
#[cfg(all(windows, feature = "browser-host-runtime"))]
use std::os::windows::io::FromRawHandle;
#[cfg(all(windows, feature = "browser-host-runtime"))]
use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[cfg(test)]
static CREATE_PROCESS_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

#[cfg(all(windows, feature = "browser-host-runtime"))]
use windows::core::{PCWSTR, PWSTR};
#[cfg(all(windows, feature = "browser-host-runtime"))]
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
};
#[cfg(all(windows, feature = "browser-host-runtime"))]
use windows::Win32::Security::SECURITY_ATTRIBUTES;
#[cfg(all(windows, feature = "browser-host-runtime"))]
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(all(windows, feature = "browser-host-runtime"))]
use windows::Win32::System::Pipes::CreatePipe;
#[cfg(all(windows, feature = "browser-host-runtime"))]
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW,
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

#[derive(Clone, Copy, Debug)]
pub(crate) struct OwnedProcessError;

#[cfg(all(windows, feature = "browser-host-runtime"))]
pub(crate) struct OwnedJob(isize);

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl OwnedJob {
    fn create() -> Result<Self, OwnedProcessError> {
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|_| OwnedProcessError)?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|_| {
                let _ = CloseHandle(job);
                OwnedProcessError
            })?;
            Ok(Self(job.0 as isize))
        }
    }

    fn raw(&self) -> HANDLE {
        HANDLE(self.0 as *mut _)
    }

    pub(crate) fn terminate(&self) {
        unsafe {
            let _ = TerminateJobObject(HANDLE(self.0 as *mut _), 70);
        }
    }

    fn active_process_count(&self) -> Result<u32, OwnedProcessError> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(self.raw()),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
            .map_err(|_| OwnedProcessError)?;
        }
        Ok(accounting.ActiveProcesses)
    }

    /// Bounded, non-terminating settled probe: true when the job no longer
    /// owns ANY process (a prior terminate fully drained). Used by recovery
    /// paths to confirm a teardown before rebuilding a control channel.
    pub(crate) fn settled(&self) -> bool {
        matches!(self.active_process_count(), Ok(0))
    }

    /// Synchronously proves that the existing Job authority no longer owns a
    /// process before a replacement generation may be admitted. This bounded
    /// settlement check is not a background monitor or restart authority.
    pub(crate) fn terminate_and_wait(&self, timeout: Duration) -> bool {
        if unsafe { TerminateJobObject(self.raw(), 70) }.is_err() {
            return false;
        }
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match self.active_process_count() {
                Ok(0) => return true,
                Ok(_) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => return false,
            }
        }
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl Drop for OwnedJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(HANDLE(self.0 as *mut _));
        }
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
struct OwnedWindowsHandle(isize);

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl OwnedWindowsHandle {
    fn new(handle: HANDLE) -> Result<Self, OwnedProcessError> {
        if handle.is_invalid() {
            return Err(OwnedProcessError);
        }
        Ok(Self(handle.0 as isize))
    }

    fn raw(&self) -> HANDLE {
        HANDLE(self.0 as *mut _)
    }

    fn into_file(mut self) -> fs::File {
        let raw = self.0 as *mut c_void;
        self.0 = 0;
        unsafe { fs::File::from_raw_handle(raw) }
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl Drop for OwnedWindowsHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                let _ = CloseHandle(HANDLE(self.0 as *mut _));
            }
        }
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
pub(crate) struct OwnedProcess {
    handle: OwnedWindowsHandle,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl OwnedProcess {
    pub(crate) fn process_id(&self) -> u32 {
        unsafe { windows::Win32::System::Threading::GetProcessId(self.handle.raw()) }
    }
    /// Command workers require an actual successful exit, not just a final
    /// stdout row. Product readiness remains owned by its existing protocol.
    pub(crate) fn succeeded(&self) -> bool {
        if self.is_running() { return false; }
        let mut code = u32::MAX;
        unsafe { GetExitCodeProcess(self.handle.raw(), &mut code).is_ok() && code == 0 }
    }

    pub(crate) fn is_running(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle.raw(), 0) != WAIT_OBJECT_0 }
    }

    pub(crate) fn wait_for(&self, timeout: Duration) -> bool {
        let milliseconds = timeout.as_millis().min(u32::MAX as u128) as u32;
        unsafe { WaitForSingleObject(self.handle.raw(), milliseconds) == WAIT_OBJECT_0 }
    }

    pub(crate) fn terminate(&self) {
        unsafe {
            let _ = TerminateProcess(self.handle.raw(), 70);
        }
        let _ = self.wait_for(Duration::from_secs(2));
    }
}

#[cfg(not(all(windows, feature = "browser-host-runtime")))]
pub(crate) struct OwnedProcess;

#[cfg(not(all(windows, feature = "browser-host-runtime")))]
impl OwnedProcess {
    pub(crate) fn is_running(&self) -> bool {
        false
    }

    pub(crate) fn wait_for(&self, _timeout: Duration) -> bool {
        true
    }

    pub(crate) fn terminate(&self) {}
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
struct ProcThreadAttributeList {
    storage: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl ProcThreadAttributeList {
    fn new(attribute_count: u32) -> Result<Self, OwnedProcessError> {
        let mut bytes = 0usize;
        unsafe {
            let _ = InitializeProcThreadAttributeList(None, attribute_count, None, &mut bytes);
        }
        if bytes == 0 {
            return Err(OwnedProcessError);
        }
        let words = bytes.div_ceil(std::mem::size_of::<usize>());
        let mut storage = vec![0usize; words];
        let pointer = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
        unsafe {
            InitializeProcThreadAttributeList(Some(pointer), attribute_count, None, &mut bytes)
                .map_err(|_| OwnedProcessError)?;
        }
        Ok(Self { storage, pointer })
    }

    fn update(
        &mut self,
        attribute: usize,
        value: *const c_void,
        bytes: usize,
    ) -> Result<(), OwnedProcessError> {
        unsafe {
            UpdateProcThreadAttribute(self.pointer, 0, attribute, Some(value), bytes, None, None)
                .map_err(|_| OwnedProcessError)
        }
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl Drop for ProcThreadAttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
        self.storage.fill(0);
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
struct WindowsPipe {
    read: OwnedWindowsHandle,
    write: OwnedWindowsHandle,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
impl WindowsPipe {
    fn create() -> Result<Self, OwnedProcessError> {
        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        unsafe {
            CreatePipe(&mut read, &mut write, Some(&security), 0).map_err(|_| OwnedProcessError)?;
        }
        Ok(Self {
            read: OwnedWindowsHandle::new(read)?,
            write: OwnedWindowsHandle::new(write)?,
        })
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
pub(crate) struct AtomicSpawn {
    pub(crate) process: OwnedProcess,
    pub(crate) stdin: fs::File,
    pub(crate) stdout: fs::File,
    pub(crate) stderr: fs::File,
    pub(crate) job: OwnedJob,
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn encode_wide_null(value: &OsStr) -> Result<Vec<u16>, OwnedProcessError> {
    let mut wide: Vec<u16> = value.encode_wide().collect();
    if wide.contains(&0) {
        return Err(OwnedProcessError);
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn encode_environment(
    mut entries: Vec<(OsString, OsString)>,
) -> Result<Vec<u16>, OwnedProcessError> {
    entries.sort_by(|left, right| {
        left.0
            .to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&right.0.to_string_lossy().to_ascii_lowercase())
    });
    let mut block = Vec::new();
    for (key, value) in entries {
        let key: Vec<u16> = key.encode_wide().collect();
        let value: Vec<u16> = value.encode_wide().collect();
        if key.is_empty() || key.contains(&0) || key.contains(&(b'=' as u16)) || value.contains(&0)
        {
            return Err(OwnedProcessError);
        }
        block.extend(key);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
pub(crate) fn spawn_in_owned_job(
    executable: &Path,
    arguments: &[OsString],
    current_dir: &Path,
    environment: Vec<(OsString, OsString)>,
    force_prelaunch_job_failure: bool,
) -> Result<AtomicSpawn, OwnedProcessError> {
    let job = OwnedJob::create()?;
    let mut attributes = ProcThreadAttributeList::new(2)?;
    let job_handle = job.raw();
    attributes.update(
        PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
        (&job_handle as *const HANDLE).cast(),
        std::mem::size_of::<HANDLE>(),
    )?;

    // This test seam fails before CreateProcessW. It proves child code cannot
    // run when atomic Job binding setup is rejected.
    if force_prelaunch_job_failure {
        return Err(OwnedProcessError);
    }

    let stdin_pipe = WindowsPipe::create()?;
    let stdout_pipe = WindowsPipe::create()?;
    let stderr_pipe = WindowsPipe::create()?;
    unsafe {
        SetHandleInformation(
            stdout_pipe.read.raw(),
            HANDLE_FLAG_INHERIT.0,
            HANDLE_FLAGS(0),
        )
        .map_err(|_| OwnedProcessError)?;
        SetHandleInformation(
            stderr_pipe.read.raw(),
            HANDLE_FLAG_INHERIT.0,
            HANDLE_FLAGS(0),
        )
        .map_err(|_| OwnedProcessError)?;
        SetHandleInformation(
            stdin_pipe.write.raw(),
            HANDLE_FLAG_INHERIT.0,
            HANDLE_FLAGS(0),
        )
        .map_err(|_| OwnedProcessError)?;
    }
    let inherited = [
        stdin_pipe.read.raw(),
        stdout_pipe.write.raw(),
        stderr_pipe.write.raw(),
    ];
    attributes.update(
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
        inherited.as_ptr().cast(),
        std::mem::size_of_val(&inherited),
    )?;

    let executable_wide = encode_wide_null(executable.as_os_str())?;
    let current_dir_wide = encode_wide_null(current_dir.as_os_str())?;
    let mut command_line = Vec::with_capacity(executable_wide.len() + 64);
    command_line.push(b'"' as u16);
    command_line.extend_from_slice(&executable_wide[..executable_wide.len() - 1]);
    command_line.push(b'"' as u16);
    for argument in arguments {
        let bytes = argument.to_string_lossy();
        if bytes.is_empty()
            || bytes.len() > 128
            || !bytes
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(OwnedProcessError);
        }
        command_line.push(b' ' as u16);
        command_line.extend(argument.encode_wide());
    }
    command_line.push(0);
    let environment = encode_environment(environment)?;

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_pipe.read.raw();
    startup.StartupInfo.hStdOutput = stdout_pipe.write.raw();
    startup.StartupInfo.hStdError = stderr_pipe.write.raw();
    startup.lpAttributeList = attributes.pointer;
    let mut process = PROCESS_INFORMATION::default();
    let flags = PROCESS_CREATION_FLAGS(
        CREATE_NO_WINDOW.0 | CREATE_UNICODE_ENVIRONMENT.0 | EXTENDED_STARTUPINFO_PRESENT.0,
    );
    #[cfg(test)]
    CREATE_PROCESS_ATTEMPTS.fetch_add(1, Ordering::AcqRel);
    unsafe {
        CreateProcessW(
            PCWSTR(executable_wide.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            true,
            flags,
            Some(environment.as_ptr().cast()),
            PCWSTR(current_dir_wide.as_ptr()),
            &startup.StartupInfo,
            &mut process,
        )
        .map_err(|_| OwnedProcessError)?;
    }
    let process_handle = OwnedWindowsHandle::new(process.hProcess)?;
    let thread_handle = OwnedWindowsHandle::new(process.hThread)?;
    drop(thread_handle);
    let owned_process = OwnedProcess {
        handle: process_handle,
    };
    let WindowsPipe {
        read: stdin_read,
        write: stdin_write,
    } = stdin_pipe;
    drop(stdin_read);
    let WindowsPipe {
        read: stdout_read,
        write: stdout_write,
    } = stdout_pipe;
    let WindowsPipe {
        read: stderr_read,
        write: stderr_write,
    } = stderr_pipe;
    drop(stdout_write);
    drop(stderr_write);
    Ok(AtomicSpawn {
        process: owned_process,
        stdin: stdin_write.into_file(),
        stdout: stdout_read.into_file(),
        stderr: stderr_read.into_file(),
        job,
    })
}

#[cfg(test)]
#[cfg(all(windows, feature = "browser-host-runtime"))]
mod tests {
    use super::*;

    #[test]
    fn terminate_and_wait_settles_the_owned_process_tree() {
        let temp = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-fixtures")
            .join(format!(
                "luckyray-owned-process-tree-{}",
                std::process::id()
            ));
        let _ = fs::create_dir_all(&temp);
        let script_path = temp.join("owned-job-tree.ps1");
        let child_pid_path = temp.join("child.pid");
        fs::write(
            &script_path,
            r#"$child = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'child.pid'), [string]$child.Id)
Start-Sleep -Seconds 120
"#,
        )
        .unwrap();

        let spawn = spawn_in_owned_job(
            Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
            &[
                OsString::from("-NoProfile"),
                OsString::from("-File"),
                OsString::from("owned-job-tree.ps1"),
            ],
            &temp,
            vec![(OsString::from("SystemRoot"), OsString::from(r"C:\Windows"))],
            false,
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !child_pid_path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(child_pid_path.exists(), "child process did not start");
        assert!(spawn.job.active_process_count().unwrap() >= 2);

        assert!(spawn.job.terminate_and_wait(Duration::from_secs(5)));
        assert!(spawn.process.wait_for(Duration::from_secs(5)));
        assert_eq!(spawn.job.active_process_count().unwrap(), 0);

        drop(spawn);
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn prelaunch_job_failure_executes_no_child_side_effect() {
        let temp =
            std::env::temp_dir().join(format!("luckyray-owned-process-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp);
        let before = CREATE_PROCESS_ATTEMPTS.load(Ordering::Acquire);
        let result = spawn_in_owned_job(
            Path::new(r"C:\Windows\System32\cmd.exe"),
            &[OsString::from("exit")],
            &temp,
            vec![],
            true,
        );
        assert!(result.is_err());
        assert_eq!(CREATE_PROCESS_ATTEMPTS.load(Ordering::Acquire), before);
        let _ = fs::remove_dir_all(temp);
    }
}
