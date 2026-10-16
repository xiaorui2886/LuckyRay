//! A private job owns the tunnel and all of its descendants. Assign the suspended
//! child before resuming it; no fork race and no taskkill /IM against other apps.
#[cfg(windows)]
mod platform {
    use std::{
        collections::BTreeMap,
        ffi::OsStr,
        io::Read,
        os::windows::{ffi::OsStrExt, io::AsRawHandle},
        path::Path,
        ptr,
        sync::{Arc, Mutex},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
                InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
                UpdateProcThreadAttribute, CREATE_NO_WINDOW, CREATE_SUSPENDED,
                CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
            },
        },
    };
    use zeroize::{Zeroize, Zeroizing};
    fn wide(v: &OsStr) -> Vec<u16> {
        v.encode_wide().chain(Some(0)).collect()
    }
    fn quote(v: &str) -> String {
        let mut out = String::from("\"");
        let mut slashes = 0;
        for ch in v.chars() {
            if ch == '\\' {
                slashes += 1;
                continue;
            }
            if ch == '"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
            } else {
                out.push_str(&"\\".repeat(slashes));
            }
            slashes = 0;
            out.push(ch);
        }
        out.push_str(&"\\".repeat(slashes * 2));
        out.push('"');
        out
    }
    pub(crate) struct OwnedProcess {
        job: HANDLE,
        process: HANDLE,
        pub pid: u32,
        diagnostic: Arc<Mutex<Option<&'static str>>>,
    }
    // Windows process/job handles may be queried and closed on another worker.
    // The enclosing controller mutex serializes all operations.
    unsafe impl Send for OwnedProcess {}
    impl OwnedProcess {
        pub(crate) fn running(&self) -> bool {
            let mut code = 0;
            unsafe { GetExitCodeProcess(self.process, &mut code) != 0 && code == 259 }
        }
        pub(crate) fn failure_code(&self) -> Option<&'static str> {
            self.diagnostic.lock().ok().and_then(|v| *v)
        }
        pub(crate) fn stop(&mut self) -> Result<(), String> {
            if unsafe { TerminateJobObject(self.job, 0) } == 0 {
                return Err("plugin-stop-failed".into());
            }
            Ok(())
        }
    }
    // Raw child output stays in a bounded memory buffer and is never persisted
    // or returned. Only these fixed categories may reach the controller/UI.
    fn startup_failure(bytes: &[u8]) -> Option<&'static str> {
        let has = |needle: &[u8]| {
            bytes
                .windows(needle.len())
                .any(|v| v.eq_ignore_ascii_case(needle))
        };
        if has(b"401 unauthorized")
            || has(b"status code: 401")
            || has(b"status=401")
            || has(b"status 401")
            || has(b"\"status_code\":401")
            || has(b"incorrect api key")
            || has(b"invalid api key")
        {
            Some("tunnel-key-rejected")
        } else if has(b"403 forbidden")
            || has(b"status code: 403")
            || has(b"status=403")
            || has(b"status 403")
            || has(b"\"status_code\":403")
            || has(b"permission denied")
            || has(b"insufficient permissions")
        {
            Some("tunnel-access-denied")
        } else if has(b"status 404") || has(b"404 not found") {
            Some("tunnel-not-found")
        } else if has(b"status 400") || has(b"400 bad request") {
            Some("tunnel-configuration-rejected")
        } else if has(b"status 429") || has(b"429 too many requests") {
            Some("tunnel-service-rate-limited")
        } else if has(b"status 500")
            || has(b"status 502")
            || has(b"status 503")
            || has(b"status 504")
        {
            Some("tunnel-service-unavailable")
        } else if has(b"unknown flag")
            || has(b"unknown command")
            || has(b"invalid mcp command")
            || has(b"invalid --mcp")
            || has(b"invalid command spec")
        {
            Some("tunnel-runtime-options-invalid")
        } else if has(b"no such host")
            || has(b"connection refused")
            || has(b"certificate")
            || has(b"network is unreachable")
            || has(b"context deadline exceeded")
            // The pinned vendor returns this exact error only after its secret
            // HTTP client's transport request fails all bounded retries.
            || has(b"controlplane client: fetch managed cloudflare runtime")
        {
            Some("tunnel-network-unavailable")
        } else if (has(b"stdio") || has(b"mcp"))
            && (has(b"initialize failed") || has(b"unexpected eof") || has(b"failed to start"))
        {
            Some("tunnel-mcp-start-failed")
        } else if has(b"managed") && (has(b"failed") || has(b"error")) {
            Some("tunnel-managed-configuration-failed")
        } else {
            None
        }
    }
    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.job);
                CloseHandle(self.process);
            }
        }
    }
    pub(crate) fn external_tunnel_running() -> Result<bool, String> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("process-inventory-unavailable".into());
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snapshot, &mut entry);
            let mut found = false;
            while ok != 0 {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase();
                if matches!(
                    name.as_str(),
                    "tunnel-client.exe"
                        | "tunnel-client-runtime.exe"
                        | "tunnel-client-runtime-cloudflared.exe"
                ) {
                    found = true;
                    break;
                }
                ok = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            Ok(found)
        }
    }
    pub(crate) fn spawn(
        exe: &Path,
        args: &[String],
        cwd: &Path,
        env: BTreeMap<String, String>,
    ) -> Result<OwnedProcess, String> {
        let application = wide(exe.as_os_str());
        let directory = wide(cwd.as_os_str());
        let line = std::iter::once(exe.to_string_lossy().into_owned())
            .chain(args.iter().cloned())
            .map(|s| quote(&s))
            .collect::<Vec<_>>()
            .join(" ");
        let mut command = wide(OsStr::new(&line));
        let mut environment = Zeroizing::new(Vec::<u16>::new());
        for (key, value) in &env {
            if key.contains(['=', '\0']) || value.contains('\0') {
                return Err("plugin-environment-invalid".into());
            }
            let item = Zeroizing::new(format!("{key}={value}"));
            environment.extend(item.encode_utf16().chain(Some(0)));
        }
        environment.push(0);
        let (mut reader, writer) = std::io::pipe().map_err(|_| "plugin-output-pipe-failed")?;
        let input = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("NUL")
            .map_err(|_| "plugin-output-pipe-failed")?;
        let mut inherited = [
            input.as_raw_handle() as HANDLE,
            writer.as_raw_handle() as HANDLE,
        ];
        unsafe {
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                return Err("plugin-job-unavailable".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err("plugin-job-unavailable".into());
            }
            let mut attribute_bytes = 0;
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attribute_bytes);
            let mut attributes =
                vec![0usize; attribute_bytes.div_ceil(std::mem::size_of::<usize>())];
            let list = attributes.as_mut_ptr() as *mut _;
            if InitializeProcThreadAttributeList(list, 1, 0, &mut attribute_bytes) == 0 {
                CloseHandle(job);
                return Err("plugin-output-pipe-failed".into());
            }
            let mut handles_ready = true;
            for handle in inherited {
                handles_ready &=
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != 0;
            }
            let listed = UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited.as_mut_ptr() as *mut _,
                std::mem::size_of_val(&inherited),
                ptr::null_mut(),
                ptr::null_mut(),
            ) != 0;
            if !handles_ready || !listed {
                for handle in inherited {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
                }
                DeleteProcThreadAttributeList(list);
                CloseHandle(job);
                return Err("plugin-output-pipe-failed".into());
            }
            let mut startup: STARTUPINFOEXW = std::mem::zeroed();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = inherited[0];
            startup.StartupInfo.hStdOutput = inherited[1];
            startup.StartupInfo.hStdError = inherited[1];
            startup.lpAttributeList = list;
            let mut process: PROCESS_INFORMATION = std::mem::zeroed();
            let created = CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_NO_WINDOW
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_ptr() as *const _,
                directory.as_ptr(),
                &startup.StartupInfo,
                &mut process,
            );
            for handle in inherited {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
            DeleteProcThreadAttributeList(list);
            // The environment includes a runtime key. Erase the temporary UTF-16 buffer.
            environment.zeroize();
            if created == 0 {
                CloseHandle(job);
                return Err("plugin-process-start-failed".into());
            }
            if AssignProcessToJobObject(job, process.hProcess) == 0
                || ResumeThread(process.hThread) == u32::MAX
            {
                TerminateProcess(process.hProcess, 1);
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
                CloseHandle(job);
                return Err("plugin-job-assignment-failed".into());
            }
            CloseHandle(process.hThread);
            drop(writer);
            drop(input);
            let diagnostic = Arc::new(Mutex::new(None));
            let observed = diagnostic.clone();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                let mut retained = 0;
                loop {
                    let read = match reader.read(&mut buffer[retained..]) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let total = retained + read;
                    if let Some(code) = startup_failure(&buffer[..total]) {
                        if let Ok(mut value) = observed.lock() {
                            if value.is_none()
                                || *value == Some("tunnel-managed-configuration-failed")
                            {
                                *value = Some(code);
                            }
                        }
                    }
                    // Keep a small overlap for messages split across reads.
                    retained = total.min(256);
                    buffer.copy_within(total - retained..total, 0);
                    buffer[retained..].fill(0);
                }
                buffer.fill(0);
            });
            Ok(OwnedProcess {
                job,
                process: process.hProcess,
                pid: process.dwProcessId,
                diagnostic,
            })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            process::{Command, Stdio},
            thread,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        fn alive(pid: u32) -> bool {
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    return false;
                }
                let mut code = 0;
                let running = GetExitCodeProcess(handle, &mut code) != 0 && code == 259;
                CloseHandle(handle);
                running
            }
        }
        #[test]
        fn startup_output_exposes_only_fixed_error_categories() {
            assert_eq!(
                startup_failure(b"ERROR: 403 Forbidden; secret=synthetic-do-not-return"),
                Some("tunnel-access-denied")
            );
            assert_eq!(
                startup_failure(b"unknown flag: --example"),
                Some("tunnel-runtime-options-invalid")
            );
            assert_eq!(
                startup_failure(b"invalid api key: synthetic-do-not-return"),
                Some("tunnel-key-rejected")
            );
            assert_eq!(
                startup_failure(b"unclassified synthetic-do-not-return"),
                None
            );
            assert_eq!(
                startup_failure(
                    b"controlplane client: unexpected managed Cloudflare runtime status 404"
                ),
                Some("tunnel-not-found")
            );
            assert_eq!(
                startup_failure(
                    b"controlplane client: unexpected managed Cloudflare runtime status 403"
                ),
                Some("tunnel-access-denied")
            );
            assert_eq!(
                startup_failure(b"controlplane client: fetch managed Cloudflare runtime"),
                Some("tunnel-network-unavailable")
            );
        }
        #[test]
        fn windows_child_output_is_captured_without_exposing_raw_text() {
            let node = Path::new(env!("CARGO_MANIFEST_DIR")).join("dsh/node/node.exe");
            let temp = tempfile::tempdir().unwrap();
            let mut environment = BTreeMap::new();
            environment.insert("SystemRoot".into(), std::env::var("SystemRoot").unwrap());
            let owned = spawn(
                &node,
                &[
                    "-e".into(),
                    "console.error('unknown flag: synthetic-do-not-return');process.exitCode=2"
                        .into(),
                ],
                temp.path(),
                environment,
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while (owned.running() || owned.failure_code().is_none()) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(25));
            }
            assert_eq!(owned.failure_code(), Some("tunnel-runtime-options-invalid"));
        }

        #[test]
        fn windows_job_stops_only_its_own_parent_and_descendant() {
            let node = Path::new(env!("CARGO_MANIFEST_DIR")).join("dsh/node/node.exe");
            assert!(node.is_file(), "existing prepared bundled Node is required");
            let temp = tempfile::tempdir().unwrap();
            let child_record = temp.path().join("子进程 pid.json");
            let script = format!("const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore',windowsHide:true}});fs.writeFileSync({},JSON.stringify({{pid:child.pid}}));setInterval(()=>{{}},1000);",
                serde_json::to_string(&child_record.to_string_lossy()).unwrap());
            let mut environment = BTreeMap::new();
            environment.insert("SystemRoot".into(), std::env::var("SystemRoot").unwrap());
            let mut owned = spawn(&node, &["-e".into(), script], temp.path(), environment).unwrap();
            let mut unrelated = Command::new(&node);
            unrelated
                .args(["-e", "setInterval(()=>{},1000)"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            use std::os::windows::process::CommandExt;
            let mut unrelated = unrelated.creation_flags(CREATE_NO_WINDOW).spawn().unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !child_record.exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(30));
            }
            let observed = fs::read(&child_record)
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
            let descendant = observed
                .as_ref()
                .and_then(|v| v["pid"].as_u64())
                .map(|v| v as u32);
            let parent = owned.pid;
            let stopped = owned.stop();
            drop(owned);
            let deadline = Instant::now() + Duration::from_secs(10);
            while (alive(parent) || descendant.is_some_and(alive)) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(30));
            }
            let other_survived = unrelated.try_wait().unwrap().is_none();
            let _ = unrelated.kill();
            let _ = unrelated.wait();
            stopped.unwrap();
            assert!(
                descendant.is_some(),
                "owned Node must actually create a child"
            );
            assert!(!alive(parent));
            assert!(!alive(descendant.unwrap()));
            assert!(
                other_survived,
                "an unrelated Node process must survive stopping the plugin job"
            );
        }
    }
}
#[cfg(windows)]
pub(crate) use platform::*;
#[cfg(not(windows))]
pub(crate) struct OwnedProcess;
#[cfg(not(windows))]
impl OwnedProcess {
    pub(crate) fn running(&self) -> bool {
        false
    }
    pub(crate) fn failure_code(&self) -> Option<&'static str> {
        None
    }
    pub(crate) fn stop(&mut self) -> Result<(), String> {
        Ok(())
    }
}
#[cfg(not(windows))]
pub(crate) fn external_tunnel_running() -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(windows))]
pub(crate) fn spawn(
    _: &std::path::Path,
    _: &[String],
    _: &std::path::Path,
    _: std::collections::BTreeMap<String, String>,
) -> Result<OwnedProcess, String> {
    Err("plugin-platform-unsupported".into())
}
