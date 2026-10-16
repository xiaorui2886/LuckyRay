//! Short-lived engine process and bounded transport. No permission decisions here.
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver, Sender, TryRecvError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
#[derive(Clone)]
pub struct WorkerControl(Arc<Mutex<Child>>);
impl WorkerControl {
    pub fn terminate(&self) {
        if let Ok(mut child) = self.0.lock() {
            let _ = child.kill();
        }
    }
}
pub struct Worker {
    child: Arc<Mutex<Child>>,
    input: Option<ChildStdin>,
    output: Option<Receiver<Result<Value, String>>>,
    cancel: Sender<()>,
    reader: Option<JoinHandle<()>>,
    watchdog: Option<JoinHandle<()>>,
}
impl Worker {
    pub fn control(&self) -> WorkerControl {
        WorkerControl(self.child.clone())
    }
    pub fn launch(
        executable: &Path,
        source: &str,
        event: &Value,
        timeout: Duration,
    ) -> Result<Self, String> {
        let initial = serde_json::to_string(&serde_json::json!({"source":source,"event":event}))
            .map_err(|_| "plugin-input")?;
        if initial.len() > 180000 {
            return Err("plugin-input-limit".into());
        }
        let mut command = Command::new(executable);
        command
            .arg("--extension-worker")
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
            if let Some(root) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", root);
            }
        }
        let mut child = command.spawn().map_err(|_| "plugin-worker-start")?;
        let mut input = child.stdin.take().ok_or("plugin-worker-input")?;
        let output = child.stdout.take().ok_or("plugin-worker-output")?;
        let child = Arc::new(Mutex::new(child));
        let (cancel, wake) = mpsc::channel();
        let weak = Arc::downgrade(&child);
        let watchdog = thread::spawn(move || {
            if wake.recv_timeout(timeout).is_err() {
                if let Some(child) = weak.upgrade() {
                    if let Ok(mut child) = child.lock() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
        // The watchdog also bounds a child that never consumes its initial input.
        if writeln!(input, "{initial}")
            .and_then(|_| input.flush())
            .is_err()
        {
            let _ = cancel.send(());
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = watchdog.join();
            return Err("plugin-worker-input".into());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let mut total = 0usize;
            for _ in 0..65 {
                let mut line = String::new();
                let read = reader.by_ref().take(131073).read_line(&mut line);
                match read {
                    Ok(0) => {
                        let _ = tx.send(Err("plugin-worker-ended".into()));
                        return;
                    }
                    Ok(size) if size <= 131072 && line.ends_with('\n') => {
                        total += size;
                        if total > 4 * 1024 * 1024 {
                            break;
                        }
                        let message = serde_json::from_str(&line)
                            .map_err(|_| "plugin-worker-protocol".into());
                        if tx.send(message).is_err() {
                            return;
                        }
                    }
                    _ => break,
                }
            }
            let _ = tx.send(Err("plugin-output-limit".into()));
        });
        Ok(Self {
            child,
            input: Some(input),
            output: Some(rx),
            cancel,
            reader: Some(reader),
            watchdog: Some(watchdog),
        })
    }
    pub fn poll(&self) -> Result<Option<Value>, String> {
        match self.output.as_ref().ok_or("plugin-retired")?.try_recv() {
            Ok(value) => value.map(Some),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err("plugin-worker-ended".into()),
        }
    }
    pub fn reply(&mut self, value: &Value) -> Result<(), String> {
        let body = serde_json::to_string(value).map_err(|_| "plugin-result")?;
        if body.len() > 2_000_000 {
            return Err("plugin-result-limit".into());
        }
        let input = self.input.as_mut().ok_or("plugin-retired")?;
        writeln!(input, "{body}")
            .and_then(|_| input.flush())
            .map_err(|_| "plugin-worker-ended".into())
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        // Drop receiver first: a reader blocked on its bounded channel then wakes.
        self.output.take();
        self.input.take();
        let _ = self.cancel.send(());
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
    }
}
