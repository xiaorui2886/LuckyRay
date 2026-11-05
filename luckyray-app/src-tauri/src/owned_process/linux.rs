//! Linux process-group lifecycle. Descendants that call setsid/setpgid can
//! escape, and abrupt desktop death does not guarantee group cleanup.
use super::OwnedProcessError;
use crate::linux_fs::Directory;
use std::ffi::OsString;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct State {
    child: Option<Child>,
    pid: libc::pid_t,
}

impl State {
    // WNOWAIT reserves the leader's PID until the authority is dropped. A later
    // group signal therefore cannot hit a newly reused numeric group ID.
    fn status(&self) -> Result<Option<bool>, OwnedProcessError> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            let rc = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if rc == 0 {
                break;
            }
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                return Err(OwnedProcessError);
            }
        }
        if unsafe { info.si_pid() } == 0 {
            return Ok(None);
        }
        Ok(Some(
            info.si_code == libc::CLD_EXITED && unsafe { info.si_status() } == 0,
        ))
    }
    fn signal_group(&self) {
        if self.child.is_some() && self.status().is_ok() {
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
        }
    }
    fn group_quiet(&self) -> bool {
        if !matches!(self.status(), Ok(Some(_))) {
            return false;
        }
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return false;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return false;
            };
            if entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<u32>().ok())
                .is_none()
            {
                continue;
            }
            let stat = match std::fs::read(entry.path().join("stat")) {
                Ok(stat) => stat,
                // A task that exits between readdir and read answers ENOENT,
                // EINVAL or ESRCH; it is gone, so it is not a live member.
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
                    ) || e.raw_os_error() == Some(libc::ESRCH) =>
                {
                    continue
                }
                Err(_) => return false,
            };
            let Some(end) = stat.iter().rposition(|b| *b == b')') else {
                return false;
            };
            let Ok(fields) = std::str::from_utf8(&stat[end + 1..]) else {
                return false;
            };
            let mut fields = fields.split_ascii_whitespace();
            let state = fields.next();
            let _parent = fields.next();
            let group = fields.next().and_then(|s| s.parse::<i32>().ok());
            if group == Some(self.pid) && !matches!(state, Some("Z" | "X" | "x")) {
                return false;
            }
        }
        true
    }
}

impl Drop for State {
    fn drop(&mut self) {
        self.signal_group();
        if let Some(mut child) = self.child.take() {
            // Reap only our own leader. A stuck kernel task must not block UI Drop.
            let _ = std::thread::Builder::new()
                .name("linux-child-reaper".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

pub(crate) struct OwnedProcess(Arc<Mutex<State>>);
pub(crate) struct OwnedJob(Arc<Mutex<State>>);
impl Drop for OwnedJob {
    fn drop(&mut self) {
        self.terminate();
    }
}
pub(crate) struct AtomicSpawn {
    pub(crate) process: OwnedProcess,
    pub(crate) stdin: File,
    pub(crate) stdout: File,
    pub(crate) stderr: File,
    pub(crate) job: OwnedJob,
}

impl OwnedProcess {
    pub(crate) fn process_id(&self) -> u32 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).pid as u32
    }
    pub(crate) fn is_running(&self) -> bool {
        !matches!(
            self.0.lock().unwrap_or_else(|e| e.into_inner()).status(),
            Ok(Some(_))
        )
    }
    pub(crate) fn succeeded(&self) -> bool {
        matches!(
            self.0.lock().unwrap_or_else(|e| e.into_inner()).status(),
            Ok(Some(true))
        )
    }
    pub(crate) fn wait_for(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.is_running() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub(crate) fn terminate(&self) {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.status().is_ok() {
            unsafe {
                libc::kill(state.pid, libc::SIGKILL);
            }
        }
        drop(state);
        let _ = self.wait_for(Duration::from_secs(2));
    }
}

impl OwnedJob {
    pub(crate) fn terminate(&self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .signal_group();
    }
    /// Samples the original group, excluding zombies. Escaped descendants are
    /// outside this Linux authority and cannot be inferred from this result.
    pub(crate) fn settled(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .group_quiet()
    }
    pub(crate) fn terminate_and_wait(&self, timeout: Duration) -> bool {
        self.terminate();
        let deadline = Instant::now() + timeout;
        loop {
            if self.settled() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

pub(crate) fn spawn_in_owned_job(
    executable: &Path,
    arguments: &[OsString],
    current_dir: &Path,
    environment: Vec<(OsString, OsString)>,
    force_prelaunch_job_failure: bool,
) -> Result<AtomicSpawn, OwnedProcessError> {
    if force_prelaunch_job_failure {
        return Err(OwnedProcessError);
    }
    let run = || -> std::io::Result<AtomicSpawn> {
        let parent = Directory::open(executable.parent().ok_or_else(crate::linux_fs::conflict)?)?;
        let executable_file = parent.open_file(
            executable
                .file_name()
                .ok_or_else(crate::linux_fs::conflict)?,
            false,
        )?;
        let metadata = executable_file.metadata()?;
        crate::linux_fs::no_attributes(&executable_file)?;
        if metadata.mode() & 0o111 == 0
            || metadata.mode() & 0o6022 != 0
            || ![0, unsafe { libc::geteuid() }].contains(&metadata.uid())
        {
            return Err(crate::linux_fs::conflict());
        }
        let mut header = [0; 4];
        executable_file.read_exact_at(&mut header, 0)?;
        if header != *b"\x7fELF" {
            return Err(crate::linux_fs::conflict());
        }
        let cwd = Directory::open(current_dir)?;
        let mut command = Command::new(format!("/proc/self/fd/{}", executable_file.as_raw_fd()));
        command
            .arg0(executable)
            .args(arguments)
            .process_group(0)
            .current_dir(format!("/proc/self/fd/{}", cwd.file.as_raw_fd()))
            .env_clear()
            .envs(environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let state = Arc::new(Mutex::new(State {
            pid: child.id() as i32,
            child: None,
        }));
        let stdin =
            unsafe { File::from_raw_fd(child.stdin.take().expect("piped stdin").into_raw_fd()) };
        let stdout =
            unsafe { File::from_raw_fd(child.stdout.take().expect("piped stdout").into_raw_fd()) };
        let stderr =
            unsafe { File::from_raw_fd(child.stderr.take().expect("piped stderr").into_raw_fd()) };
        state.lock().unwrap_or_else(|e| e.into_inner()).child = Some(child);
        parent.verify_named(executable.file_name().unwrap(), &executable_file)?;
        cwd.verify()?;
        Ok(AtomicSpawn {
            process: OwnedProcess(state.clone()),
            job: OwnedJob(state),
            stdin,
            stdout,
            stderr,
        })
    };
    run().map_err(|error| {
        #[cfg(test)]
        eprintln!("agent-host-trace: launcher io error {error:?}");
        OwnedProcessError
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    /// Copy an executable fixture and wait until it is exec-able.
    ///
    /// `fs::copy` holds a write fd on the new inode. A sibling test that forks
    /// during that window gives its child a copy of the fd until the child's
    /// own exec (O_CLOEXEC closes it only there), and exec of the fixture fails
    /// with ETXTBSY while any such fd is open. Our fd is closed once `copy`
    /// returns, so no new holder can appear; a probe exec that succeeds proves
    /// every inherited one is gone, and the launcher then sees a quiet file.
    fn owned_executable_copy(source: &Path, dest: &Path) {
        std::fs::copy(source, dest).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match std::process::Command::new(dest)
                .args(["-c", "exit 0"])
                .stdin(std::process::Stdio::null())
                .status()
            {
                Ok(status) => {
                    assert!(status.success(), "fixture probe failed");
                    return;
                }
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY)
                    && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("fixture not executable: {e}"),
            }
        }
    }
    #[test]
    fn linux_owned_process_stdio_exit_and_group_cleanup() {
        let root = tempfile::tempdir().unwrap();
        // The launcher validates ELF + file attributes, so the synthetic shell
        // lives in the owned directory (as the packaged plugin will).
        let shell = root.path().join("sh");
        owned_executable_copy(&Path::new("/bin/sh").canonicalize().unwrap(), &shell);
        let args = vec![
            "-c".into(),
            "read value; /bin/sleep 30 & printf diagnostic >&2; printf '%s' \"$value\"; wait"
                .into(),
        ];
        let mut spawned =
            spawn_in_owned_job(&shell, &args, root.path(), Vec::new(), false).unwrap();
        spawned.stdin.write_all(b"synthetic\n").unwrap();
        let mut stdout = spawned.stdout;
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut bytes = [0; 9];
            let result = stdout.read_exact(&mut bytes);
            let _ = tx.send(result.map(|_| bytes));
        });
        let result = rx.recv_timeout(Duration::from_secs(3));
        if result.is_err() {
            spawned.job.terminate();
        }
        assert_eq!(result.unwrap().unwrap(), *b"synthetic");
        reader.join().unwrap();
        assert!(spawned.process.is_running());
        assert!(spawned.job.terminate_and_wait(Duration::from_secs(3)));
        assert!(spawned.process.wait_for(Duration::from_secs(1)));
        assert!(!spawned.process.succeeded());
        // Root and normal group members were stopped, so pipes reach EOF.
        let mut output = String::new();
        spawned.stderr.read_to_string(&mut output).unwrap();
        assert_eq!(output, "diagnostic");
    }
    #[test]
    fn linux_prelaunch_failure_and_unsafe_sources_do_not_start() {
        let root = tempfile::tempdir().unwrap();
        let shell = Path::new("/bin/sh").canonicalize().unwrap();
        assert!(spawn_in_owned_job(&shell, &[], root.path(), Vec::new(), true).is_err());
        assert!(spawn_in_owned_job(Path::new("sh"), &[], root.path(), Vec::new(), false).is_err());
        let link = root.path().join("shell");
        std::os::unix::fs::symlink(&shell, &link).unwrap();
        assert!(spawn_in_owned_job(&link, &[], root.path(), Vec::new(), false).is_err());
        let owned = root.path().join("sh-ok");
        owned_executable_copy(&shell, &owned);
        let success = spawn_in_owned_job(
            &owned,
            &["-c".into(), "exit 0".into()],
            root.path(),
            Vec::new(),
            false,
        )
        .unwrap();
        assert!(success.process.wait_for(Duration::from_secs(2)));
        assert!(success.process.succeeded());
        assert!(success.job.settled());
    }
    #[test]
    fn stopping_the_group_leaves_no_descendant_of_the_plugin_shaped_tree() {
        // T20: the plugin runs as `node server.mjs` with helper children. Prove
        // the shape with a synthetic tree: a background sleep and a foreground
        // one, both in the spawned process group, must all be gone after stop.
        let root = tempfile::tempdir().unwrap();
        // The launcher validates the ELF and the file attributes, so the
        // synthetic executable lives in the owned directory (exactly where the
        // packaged plugin will live) instead of a read-only system path.
        let shell = root.path().join("sh");
        owned_executable_copy(&Path::new("/bin/sh").canonicalize().unwrap(), &shell);
        let args = vec![
            "-c".into(),
            "sleep 60 & echo $!; exec sleep 60".into(),
        ];
        let mut spawned =
            spawn_in_owned_job(&shell, &args, root.path(), Vec::new(), false).unwrap();
        let leader = spawned.process.process_id();
        let mut line = String::new();
        {
            use std::io::BufRead;
            let mut reader = std::io::BufReader::new(&mut spawned.stdout);
            reader.read_line(&mut line).unwrap();
        }
        let background: i32 = line.trim().parse().expect("background pid");
        assert!(background > 0);
        let alive = |pid: i32| Path::new(&format!("/proc/{pid}")).exists();
        assert!(alive(background) && alive(leader as i32));
        assert!(spawned.process.is_running());
        assert!(spawned.job.terminate_and_wait(Duration::from_secs(5)));
        // Reaping the leader is what removes its /proc entry; the grandchild is
        // reparented and disappears on its own.
        assert!(!spawned.process.is_running());
        // The leader is reaped only when the authority drops (WNOWAIT keeps its
        // pid reserved on purpose), so the grandchild is what must be gone now.
        assert!(!alive(background), "background child survived the group stop");
        assert!(spawned.job.settled());
        drop(spawned);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while alive(leader as i32) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!alive(leader as i32), "the leader was not released after stop");
    }

}
