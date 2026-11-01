//! macOS child lifecycle with a dedicated process group. Descendants which
//! deliberately leave the group, and abrupt termination of the app, can escape
//! cleanup. Keep the direct child unreaped while signalling the group so its
//! PID cannot be recycled into an unrelated group.
use std::ffi::OsString;
use std::fs::File;
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[link(name = "proc")]
unsafe extern "C" {}

#[derive(Clone, Copy, Debug)]
pub(crate) struct OwnedProcessError;

struct Group {
    pid: libc::pid_t,
    child: Mutex<Option<Child>>,
}

impl Group {
    // WNOWAIT retains the child (including its zombie) as the PID anchor.
    fn exit_status(&self) -> Result<Option<bool>, OwnedProcessError> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                return Ok((info.si_pid == self.pid)
                    .then_some(info.si_code == libc::CLD_EXITED && info.si_status == 0));
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                // ECHILD includes another waiter reaping the anchor. Never
                // signal that numerical PID/PGID after ownership is lost.
                return Err(OwnedProcessError);
            }
        }
    }

    fn signal(&self) -> bool {
        if self.exit_status().is_err() {
            return false;
        }
        let result = unsafe { libc::kill(-self.pid, libc::SIGKILL) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }

    fn settled(&self) -> bool {
        if !matches!(self.exit_status(), Ok(Some(_))) {
            return false;
        }
        // Inspect only this anchored group, never a system-wide kill list.
        const PROC_PGRP_ONLY: u32 = 2;
        let mut pids = vec![0i32; 4096];
        unsafe {
            *libc::__error() = 0;
        }
        let bytes = unsafe {
            libc::proc_listpids(
                PROC_PGRP_ONLY,
                self.pid as u32,
                pids.as_mut_ptr().cast(),
                (pids.len() * std::mem::size_of::<i32>()) as i32,
            )
        };
        if bytes < 0
            || (bytes == 0 && std::io::Error::last_os_error().raw_os_error() != Some(0))
            || bytes as usize >= pids.len() * std::mem::size_of::<i32>()
        {
            return false;
        }
        for pid in pids
            .into_iter()
            .take(bytes as usize / std::mem::size_of::<i32>())
        {
            if pid == 0 || pid == self.pid {
                continue;
            }
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let read = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    std::mem::size_of_val(&info) as i32,
                )
            };
            if read as usize != std::mem::size_of_val(&info) {
                return false;
            }
            // SZOMB=5. A group member still executing keeps settlement false.
            if info.pbi_pgid == self.pid as u32 && info.pbi_status != 5 {
                return false;
            }
        }
        true
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.signal();
        if let Ok(slot) = self.child.get_mut() {
            if let Some(mut child) = slot.take() {
                // Reap without blocking a UI destructor on an unresponsive
                // child. This thread exists only for this child, inside the app.
                let _ = std::thread::Builder::new()
                    .name("luckyray-child-reaper".into())
                    .spawn(move || {
                        let _ = child.wait();
                    });
            }
        }
    }
}

pub(crate) struct OwnedJob(Arc<Group>);
impl OwnedJob {
    pub(crate) fn terminate(&self) {
        self.0.signal();
    }
    pub(crate) fn settled(&self) -> bool {
        self.0.settled()
    }
    pub(crate) fn terminate_and_wait(&self, timeout: Duration) -> bool {
        if !self.0.signal() {
            return false;
        }
        let deadline = Instant::now() + timeout;
        loop {
            if self.0.settled() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for OwnedJob {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub(crate) struct OwnedProcess(Arc<Group>);
impl OwnedProcess {
    pub(crate) fn process_id(&self) -> u32 {
        self.0.pid as u32
    }
    pub(crate) fn succeeded(&self) -> bool {
        matches!(self.0.exit_status(), Ok(Some(true)))
    }
    pub(crate) fn is_running(&self) -> bool {
        !matches!(self.0.exit_status(), Ok(Some(_)))
    }
    pub(crate) fn wait_for(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if matches!(self.0.exit_status(), Ok(Some(_))) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub(crate) fn terminate(&self) {
        self.0.signal();
    }
}

pub(crate) struct AtomicSpawn {
    pub(crate) process: OwnedProcess,
    pub(crate) stdin: File,
    pub(crate) stdout: File,
    pub(crate) stderr: File,
    pub(crate) job: OwnedJob,
}

pub(crate) fn spawn_in_owned_job(
    executable: &Path,
    arguments: &[OsString],
    current_dir: &Path,
    environment: Vec<(OsString, OsString)>,
    force_prelaunch_job_failure: bool,
) -> Result<AtomicSpawn, OwnedProcessError> {
    if force_prelaunch_job_failure || !executable.is_absolute() || !current_dir.is_absolute() {
        return Err(OwnedProcessError);
    }
    let parent = crate::macos_fs::Directory::open(
        executable.parent().ok_or(OwnedProcessError)?,
        false,
        false,
    )
    .map_err(|_| OwnedProcessError)?;
    let executable_name = executable.file_name().ok_or(OwnedProcessError)?;
    let executable_file = parent
        .open_regular(executable_name)
        .map_err(|_| OwnedProcessError)?;
    let work = crate::macos_fs::Directory::open(current_dir, false, false)
        .map_err(|_| OwnedProcessError)?;
    let meta = executable_file.metadata().map_err(|_| OwnedProcessError)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.permissions().mode() & 0o111 == 0 {
        return Err(OwnedProcessError);
    }
    let mut child = Command::new(executable)
        .args(arguments)
        .current_dir(current_dir)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|_| OwnedProcessError)?;
    let pid = child.id() as libc::pid_t;
    let stdin = child.stdin.take().map(|p| File::from(OwnedFd::from(p)));
    let stdout = child.stdout.take().map(|p| File::from(OwnedFd::from(p)));
    let stderr = child.stderr.take().map(|p| File::from(OwnedFd::from(p)));
    let shared = Arc::new(Group {
        pid,
        child: Mutex::new(Some(child)),
    });
    let probe = parent
        .open_regular(executable_name)
        .and_then(|file| file.metadata());
    let unchanged = probe.as_ref().is_ok_and(|p| {
        (p.dev(), p.ino(), p.len(), p.mtime(), p.mtime_nsec())
            == (
                meta.dev(),
                meta.ino(),
                meta.len(),
                meta.mtime(),
                meta.mtime_nsec(),
            )
    });
    if work.current().is_err() || !unchanged {
        return Err(OwnedProcessError);
    }
    match (stdin, stdout, stderr) {
        (Some(stdin), Some(stdout), Some(stderr)) => Ok(AtomicSpawn {
            process: OwnedProcess(shared.clone()),
            job: OwnedJob(shared),
            stdin,
            stdout,
            stderr,
        }),
        _ => Err(OwnedProcessError),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn macos_platform_process_group_lifecycle() {
        use std::io::BufRead;
        struct Unrelated(Child);
        impl Drop for Unrelated {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut unrelated = Unrelated(Command::new("/bin/sleep").arg("30").spawn().unwrap());
        let child = spawn_in_owned_job(
            Path::new("/bin/sh"),
            &["-c".into(), "sleep 30 & echo ready; wait".into()],
            Path::new("/"),
            vec![("PATH".into(), "/usr/bin:/bin".into())],
            false,
        )
        .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(&child.stdout)
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "ready");
        assert!(child.process.is_running());
        assert!(child.job.terminate_and_wait(Duration::from_secs(3)));
        assert!(!child.process.is_running());
        assert!(!child.process.succeeded());
        assert!(child.job.settled());
        assert!(unrelated.0.try_wait().unwrap().is_none());
    }
    #[test]
    fn macos_platform_process_exit_status_keeps_pid_anchor() {
        assert!(
            spawn_in_owned_job(Path::new("/bin/sh"), &[], Path::new("/"), vec![], true).is_err()
        );
        let child = spawn_in_owned_job(
            Path::new("/bin/sh"),
            &["-c".into(), "exit 0".into()],
            Path::new("/"),
            vec![],
            false,
        )
        .unwrap();
        assert!(child.process.wait_for(Duration::from_secs(2)));
        assert!(child.process.succeeded());
        assert_eq!(
            unsafe { libc::getpgid(child.process.process_id() as i32) },
            child.process.process_id() as i32
        );
    }
}
