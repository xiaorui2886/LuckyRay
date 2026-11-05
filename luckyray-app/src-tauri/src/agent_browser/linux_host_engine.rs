//! Linux Agent Browser engine (T55 slice 2).
//!
//! A pinned Chrome for Testing `chrome-headless-shell` driven over
//! `--remote-debugging-pipe` (fds 3/4, no DevTools TCP port). It is the Linux
//! counterpart of the Windows WebView2 Agent host and keeps its rules:
//! - every network request of every frame and worker is paused by a
//!   browser-wide `Fetch` interception and fetched only through the parent's
//!   authenticated `/__luckyray_agent_fetch` gateway (same client code as
//!   Windows); nothing is served that the gateway did not return;
//! - top-level navigation follows the same `AgentTopLevelPolicy`;
//! - the same proxy/resolver/WebRTC flags stay on as a backstop;
//! - the same lockdown script runs in every document;
//! - popups are closed, downloads denied, dialogs dismissed;
//! - the engine refuses to run unless its renderers are sandboxed (seccomp-bpf
//!   in a separate PID namespace), and never passes a sandbox-off switch.
//!
//! Wired (slice 3) into the `luckyray-browser-host --agent-readonly` sidecar,
//! which owns the engine from a dedicated long-lived thread.

use super::{
    agent_browser_arguments, agent_extract_script, bounded_title, browser_document_token,
    fetch_agent_resource, safe_origin, subresource_target_is_forbidden, validated_top_level_url,
    AgentExtractKind, AgentTopLevelPolicy, GatewayResource, HostFailure,
    AGENT_NETWORK_LOCKDOWN_SCRIPT, AGENT_READ_SCRIPT,
};
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub(crate) const MAX_PENDING_AGENT_RESOURCES: usize = 128;
pub(crate) const AGENT_RESOURCE_DEADLINE: Duration = Duration::from_secs(18);
const MAX_CDP_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const SANDBOX_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const FETCH_WORKERS: usize = 4;
const REDIRECT_CACHE_TTL: Duration = Duration::from_secs(30);

/// Switches that would weaken the engine. None of them is ever passed; the
/// launch refuses an argument list that contains one.
const FORBIDDEN_SWITCHES: &[&str] = &[
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-namespace-sandbox",
    "--disable-seccomp-filter-sandbox",
    "--no-zygote",
    "--single-process",
    "--in-process-gpu",
    "--remote-debugging-port",
    "--remote-debugging-address",
    "--remote-allow-origins",
    "--disable-web-security",
    "--allow-running-insecure-content",
    "--ignore-certificate-errors",
    "--user-data-dir",
    "--load-extension",
];

pub(crate) struct EngineConfig {
    /// The pinned `chrome-headless-shell` executable.
    pub(crate) shell: PathBuf,
    /// Lower-case hex sha256 the executable must match before it is started.
    pub(crate) expected_sha256: String,
    /// Fresh, empty, 0700 directory owned by this user.
    pub(crate) profile_root: PathBuf,
    pub(crate) gateway_address: SocketAddr,
    pub(crate) gateway_token: String,
    /// Exact loopback fixture port; honoured only in fixture/test builds by
    /// `validated_top_level_url`, exactly like the Windows host.
    pub(crate) test_fixture_port: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EngineSnapshot {
    pub(crate) status: &'static str,
    pub(crate) origin: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) document_token: Option<String>,
    pub(crate) generation: u64,
}

#[derive(Default)]
struct NavigationState {
    status: &'static str,
    origin: Option<String>,
    title: Option<String>,
    document_token: Option<String>,
    generation: u64,
    loader_id: Option<String>,
}

/// Counters a test (and later the host status) can read. No URLs or bodies.
#[derive(Default)]
pub(crate) struct MediationCounters {
    pub(crate) mediated: AtomicUsize,
    pub(crate) blocked: AtomicUsize,
    pub(crate) navigation_denied: AtomicUsize,
    pub(crate) popups_closed: AtomicUsize,
    pub(crate) dialogs_dismissed: AtomicUsize,
}

pub(crate) fn engine_arguments(profile: &Path, gateway_port: u16) -> Vec<String> {
    let mut arguments = vec![
        "--remote-debugging-pipe".to_owned(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_owned(),
        "--no-default-browser-check".to_owned(),
        "--disable-extensions".to_owned(),
        "--disable-sync".to_owned(),
        "--deny-permission-prompts".to_owned(),
        "--disable-crash-reporter".to_owned(),
        "--disable-breakpad".to_owned(),
        "--metrics-recording-only".to_owned(),
    ];
    arguments.extend(agent_browser_arguments(gateway_port));
    arguments.push("about:blank".to_owned());
    arguments
}

fn argument_is_forbidden(argument: &str, profile: &Path) -> bool {
    if argument == format!("--user-data-dir={}", profile.display()) {
        return false;
    }
    // Chromium on POSIX accepts both `--switch` and `-switch`.
    let Some(bare) = argument.strip_prefix("--").or_else(|| argument.strip_prefix('-')) else {
        return false;
    };
    FORBIDDEN_SWITCHES.iter().any(|switch| {
        let switch = switch.trim_start_matches('-');
        bare == switch || bare.strip_prefix(switch).is_some_and(|rest| rest.starts_with('='))
    })
}

/// The engine executable, opened once without following links and checked
/// as an object: a regular single-link ELF file owned by root or this user,
/// with no set-id or group/other write bits and no extended attributes
/// (file capabilities, ACLs, labels), inside a trusted directory chain. The
/// pin is hashed from this descriptor and the engine is executed from it, so
/// a swap of the path after the check cannot change what runs.
struct VerifiedEngine {
    directory: crate::linux_fs::Directory,
    name: std::ffi::OsString,
    file: File,
}

fn open_verified_engine(shell: &Path, expected: &str) -> Result<VerifiedEngine, HostFailure> {
    use std::os::unix::fs::FileExt;
    let integrity = || HostFailure::new("agent-browser-engine-integrity", "engine-integrity");
    let (Some(parent), Some(name)) = (shell.parent(), shell.file_name()) else {
        return Err(integrity());
    };
    if !shell.is_absolute()
        || shell
            .components()
            .any(|part| !matches!(part, std::path::Component::RootDir | std::path::Component::Normal(_)))
    {
        return Err(integrity());
    }
    let directory = crate::linux_fs::Directory::trusted(parent).map_err(|_| integrity())?;
    let file = directory.open_file(name, false).map_err(|_| integrity())?;
    let metadata = file.metadata().map_err(|_| integrity())?;
    if metadata.mode() & 0o111 == 0
        || metadata.mode() & 0o6022 != 0
        || ![0, unsafe { libc::geteuid() }].contains(&metadata.uid())
    {
        return Err(integrity());
    }
    crate::linux_fs::no_attributes(&file).map_err(|_| integrity())?;
    let mut header = [0u8; 4];
    file.read_exact_at(&mut header, 0).map_err(|_| integrity())?;
    if header != *b"\x7fELF" {
        return Err(integrity());
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut offset = 0u64;
    loop {
        let read = file.read_at(&mut buffer, offset).map_err(|_| integrity())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        offset += read as u64;
    }
    if expected.len() != 64 || format!("{:x}", hasher.finalize()) != expected {
        return Err(integrity());
    }
    Ok(VerifiedEngine {
        directory,
        name: name.to_owned(),
        file,
    })
}

#[cfg(test)]
fn sha256_file(path: &Path) -> Result<String, HostFailure> {
    let mut file = File::open(path)
        .map_err(|_| HostFailure::new("agent-browser-engine-unavailable", "engine-integrity"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| HostFailure::new("agent-browser-engine-unavailable", "engine-integrity"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Linux form of the Windows `prepare_agent_profile`: an existing, empty,
/// non-symlink directory owned by this user with mode 0700.
fn prepare_profile(requested: &Path) -> Result<PathBuf, HostFailure> {
    let failure = || HostFailure::new("agent-browser-profile-invalid", "profile");
    if !requested.is_absolute() {
        return Err(failure());
    }
    // No `.`/`..` or symlinked component anywhere on the way: the walk opens
    // every ancestor with O_NOFOLLOW and refuses one another user can write.
    if requested
        .components()
        .any(|part| !matches!(part, std::path::Component::RootDir | std::path::Component::Normal(_)))
    {
        return Err(failure());
    }
    crate::linux_fs::Directory::private(requested, false).map_err(|_| failure())?;
    let metadata = fs::symlink_metadata(requested).map_err(|_| failure())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(failure());
    }
    let canonical = requested.canonicalize().map_err(|_| failure())?;
    if fs::read_dir(&canonical).map_err(|_| failure())?.next().is_some() {
        return Err(failure());
    }
    for child in ["home", "config", "cache", "data", "tmp", "chrome"] {
        fs::create_dir(canonical.join(child)).map_err(|_| failure())?;
        fs::set_permissions(canonical.join(child), fs::Permissions::from_mode(0o700))
            .map_err(|_| failure())?;
    }
    Ok(canonical)
}

fn cloexec_pipe() -> Result<(OwnedFd, OwnedFd), HostFailure> {
    let mut fds = [0 as RawFd; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(HostFailure::new("agent-browser-engine-unavailable", "engine-pipe"));
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// Duplicate to a high descriptor so the child's dup2 to 3/4 cannot clobber.
fn high_fd(fd: &OwnedFd) -> Result<OwnedFd, HostFailure> {
    let value = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 100) };
    if value < 0 {
        return Err(HostFailure::new("agent-browser-engine-unavailable", "engine-pipe"));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(value) })
}

// ---------------------------------------------------------------- CDP pipe

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>;

struct Cdp {
    writer: Mutex<File>,
    next_id: AtomicU64,
    pending: Pending,
    alive: Arc<AtomicBool>,
}

impl Cdp {
    fn send_raw(&self, message: &Value) -> Result<(), HostFailure> {
        let mut bytes = serde_json::to_vec(message)
            .map_err(|_| HostFailure::new("agent-browser-engine-failed", "cdp-encode"))?;
        if bytes.len() > MAX_CDP_MESSAGE_BYTES || bytes.contains(&0) {
            return Err(HostFailure::new("agent-browser-engine-failed", "cdp-encode"));
        }
        bytes.push(0);
        let mut writer = self.writer.lock().unwrap_or_else(|error| error.into_inner());
        writer
            .write_all(&bytes)
            .map_err(|_| HostFailure::new("agent-browser-engine-failed", "cdp-write"))
    }

    fn post(&self, method: &str, params: Value, session: Option<&str>) -> Result<u64, HostFailure> {
        let id = self.next_id.fetch_add(1, Ordering::AcqRel);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = Value::String(session.to_owned());
        }
        self.send_raw(&message)?;
        Ok(id)
    }

    fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, HostFailure> {
        let failure = || HostFailure::new("agent-browser-engine-failed", "cdp-call");
        if !self.alive.load(Ordering::Acquire) {
            return Err(failure());
        }
        let id = self.next_id.fetch_add(1, Ordering::AcqRel);
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, tx);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = Value::String(session.to_owned());
        }
        if let Err(error) = self.send_raw(&message) {
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            return Err(error);
        }
        let response = rx.recv_timeout(COMMAND_TIMEOUT);
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id);
        let response = response.map_err(|_| failure())?;
        if response.get("error").is_some() {
            return Err(failure());
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// Splits the pipe stream into NUL-terminated messages with a hard size cap.
pub(crate) struct FrameReader<R: Read> {
    inner: R,
    buffer: Vec<u8>,
}

impl<R: Read> FrameReader<R> {
    pub(crate) fn new(inner: R) -> Self {
        Self {
            inner,
            buffer: Vec::new(),
        }
    }

    pub(crate) fn next_frame(&mut self) -> Result<Option<Vec<u8>>, ()> {
        loop {
            if let Some(position) = self.buffer.iter().position(|byte| *byte == 0) {
                // A frame over the cap is refused even when its terminator
                // arrived in the same read.
                if position > MAX_CDP_MESSAGE_BYTES {
                    return Err(());
                }
                let frame: Vec<u8> = self.buffer.drain(..=position).collect();
                return Ok(Some(frame[..frame.len() - 1].to_vec()));
            }
            if self.buffer.len() > MAX_CDP_MESSAGE_BYTES {
                return Err(());
            }
            let mut chunk = [0u8; 64 * 1024];
            match self.inner.read(&mut chunk) {
                Ok(0) => return Ok(None),
                Ok(read) => self.buffer.extend_from_slice(&chunk[..read]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return Err(()),
            }
        }
    }
}

// ------------------------------------------------------------ mediation

struct Paused {
    request_id: String,
    method: String,
    url: String,
    is_main_document: bool,
    received: Instant,
}

struct CachedRedirectTarget {
    resource: GatewayResource,
    stored: Instant,
}

struct Shared {
    cdp: Cdp,
    policy: Mutex<AgentTopLevelPolicy>,
    state: Mutex<NavigationState>,
    main_frame: Mutex<Option<String>>,
    page_session: Mutex<Option<String>>,
    page_target: Mutex<Option<String>>,
    /// Top frames of popups (frame id == target id); never served.
    popup_frames: Mutex<std::collections::HashSet<String>>,
    redirect_cache: Mutex<HashMap<String, CachedRedirectTarget>>,
    in_flight: AtomicUsize,
    active: AtomicBool,
    counters: MediationCounters,
    test_fixture_port: Option<u16>,
    gateway_address: SocketAddr,
    gateway_token: String,
    state_changed: (Mutex<u64>, std::sync::Condvar),
}

impl Shared {
    fn notify(&self) {
        let (lock, condvar) = &self.state_changed;
        let mut value = lock.lock().unwrap_or_else(|error| error.into_inner());
        *value = value.wrapping_add(1);
        condvar.notify_all();
    }

    fn block(&self, request_id: &str) {
        self.counters.blocked.fetch_add(1, Ordering::AcqRel);
        // Same response as the Windows immediate_agent_block.
        let _ = self.cdp.post(
            "Fetch.fulfillRequest",
            json!({
                "requestId": request_id,
                "responseCode": 403,
                "responsePhrase": "Blocked",
                "responseHeaders": [
                    {"name": "Content-Type", "value": "text/plain"},
                    {"name": "Cache-Control", "value": "no-store"}
                ],
                "body": base64::engine::general_purpose::STANDARD.encode(b"blocked"),
            }),
            None,
        );
    }

    fn fail(&self, request_id: &str) {
        self.counters.blocked.fetch_add(1, Ordering::AcqRel);
        let _ = self.cdp.post(
            "Fetch.failRequest",
            json!({"requestId": request_id, "errorReason": "BlockedByClient"}),
            None,
        );
    }

    fn fulfill(&self, request_id: &str, resource: &GatewayResource) {
        self.counters.mediated.fetch_add(1, Ordering::AcqRel);
        let _ = self.cdp.post(
            "Fetch.fulfillRequest",
            json!({
                "requestId": request_id,
                "responseCode": resource.status,
                "responsePhrase": resource.reason,
                "responseHeaders": [
                    {"name": "Content-Type", "value": resource.content_type},
                    {"name": "Content-Length", "value": resource.body.len().to_string()},
                    {"name": "Cache-Control", "value": "no-store"}
                ],
                "body": base64::engine::general_purpose::STANDARD.encode(&resource.body),
            }),
            None,
        );
    }

    /// The gateway already followed redirects. Windows rewrites the request
    /// URI to the final URL; CDP cannot, so the engine answers with a 307 to
    /// the final URL and serves the already-fetched bytes once from memory,
    /// so the origin is never fetched twice.
    fn redirect(&self, request_id: &str, resource: GatewayResource) {
        let location = resource.final_url.clone();
        self.redirect_cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                location.clone(),
                CachedRedirectTarget {
                    resource,
                    stored: Instant::now(),
                },
            );
        let _ = self.cdp.post(
            "Fetch.fulfillRequest",
            json!({
                "requestId": request_id,
                "responseCode": 307,
                "responsePhrase": "Temporary Redirect",
                "responseHeaders": [
                    {"name": "Location", "value": location},
                    {"name": "Cache-Control", "value": "no-store"}
                ],
                "body": "",
            }),
            None,
        );
    }

    fn deny_navigation(&self) {
        self.counters.navigation_denied.fetch_add(1, Ordering::AcqRel);
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.status = "error";
        state.title = Some("agent-browser-navigation-denied".to_owned());
        state.document_token = None;
        drop(state);
        self.notify();
    }

    /// Admission for one paused request, on the reader thread. Returns the
    /// job to fetch, or answers immediately.
    fn admit(&self, params: &Value) -> Option<Paused> {
        let request_id = params.get("requestId")?.as_str()?.to_owned();
        let url = params
            .pointer("/request/url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let method = params
            .pointer("/request/method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let resource_type = params.get("resourceType").and_then(Value::as_str);
        let frame = params.get("frameId").and_then(Value::as_str);
        let is_main_document = resource_type == Some("Document")
            && frame.is_some()
            && self
                .main_frame
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_deref()
                == frame;
        let from_popup = frame.is_some_and(|frame| {
            self.popup_frames
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains(frame)
        });
        // Service worker scripts (Chromium marks them `Service-Worker:
        // script`) are refused, so no worker can be registered (design §5).
        let service_worker_script = params
            .pointer("/request/headers")
            .and_then(Value::as_object)
            .is_some_and(|headers| headers.keys().any(|name| name.eq_ignore_ascii_case("service-worker")));
        if !self.active.load(Ordering::Acquire)
            || from_popup
            || service_worker_script
            || !matches!(method.as_str(), "GET" | "HEAD")
            || self.in_flight.load(Ordering::Acquire) >= MAX_PENDING_AGENT_RESOURCES
        {
            self.block(&request_id);
            return None;
        }
        if is_main_document {
            // Windows NavigationStarting: validate and require the policy.
            match validated_top_level_url(&url, self.test_fixture_port) {
                Ok(target)
                    if self
                        .policy
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .permits(&target) =>
                {
                    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                    state.status = "loading";
                    state.origin = safe_origin(&target);
                    state.document_token = Some(browser_document_token(target.as_str()));
                    state.title = None;
                    state.generation = state.generation.saturating_add(1);
                    drop(state);
                    self.notify();
                }
                _ => {
                    // Windows cancels the navigation (SetCancel); the current
                    // document stays and the session reports the denial.
                    self.deny_navigation();
                    self.fail(&request_id);
                    return None;
                }
            }
        } else if subresource_target_is_forbidden(&url, self.test_fixture_port) {
            // Stricter than needed: the gateway would refuse it too, but a
            // private target never even reaches the gateway.
            self.block(&request_id);
            return None;
        }
        let cached = {
            let mut cache = self
                .redirect_cache
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            cache.retain(|_, value| value.stored.elapsed() < REDIRECT_CACHE_TTL);
            cache.remove(&url)
        };
        if let Some(cached) = cached {
            self.fulfill(&request_id, &cached.resource);
            return None;
        }
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        Some(Paused {
            request_id,
            method,
            url,
            is_main_document,
            received: Instant::now(),
        })
    }

    /// Completion on a fetch worker (Windows complete_agent_response).
    fn complete(&self, job: Paused, result: Result<GatewayResource, ()>) {
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
        let resource = match result {
            Ok(resource)
                if self.active.load(Ordering::Acquire)
                    && job.received.elapsed() < AGENT_RESOURCE_DEADLINE =>
            {
                resource
            }
            _ => return self.block(&job.request_id),
        };
        if resource.final_url == job.url {
            return self.fulfill(&job.request_id, &resource);
        }
        if job.is_main_document {
            match validated_top_level_url(&resource.final_url, self.test_fixture_port) {
                Ok(_) => self
                    .policy
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .allow_gateway_final(&resource.final_url),
                Err(_) => {
                    self.deny_navigation();
                    return self.fail(&job.request_id);
                }
            }
        } else if subresource_target_is_forbidden(&resource.final_url, self.test_fixture_port) {
            return self.block(&job.request_id);
        }
        self.redirect(&job.request_id, resource);
    }
}

// ---------------------------------------------------------------- sandbox

fn proc_field(proc_root: &Path, pid: u32, file: &str) -> Option<String> {
    fs::read_to_string(proc_root.join(pid.to_string()).join(file)).ok()
}

fn parent_pid(proc_root: &Path, pid: u32) -> Option<u32> {
    let stat = proc_field(proc_root, pid, "stat")?;
    let after = stat.rsplit_once(')')?.1;
    after.split_whitespace().nth(1)?.parse().ok()
}

/// Every renderer under the browser must run with a seccomp-bpf filter in its
/// own PID namespace (true for both the user-namespace and the setuid
/// sandbox). Returns the number of sandboxed renderers, or an error if any
/// renderer is unsandboxed or none exists yet.
pub(crate) fn renderer_sandbox_check(proc_root: &Path, browser_pid: u32) -> Result<usize, HostFailure> {
    let failure = || HostFailure::new("agent-browser-sandbox-unavailable", "sandbox-check");
    let browser_pid_ns = fs::read_link(proc_root.join(browser_pid.to_string()).join("ns/pid"))
        .map_err(|_| failure())?;
    let mut descendants = vec![browser_pid];
    let mut changed = true;
    let entries: Vec<u32> = fs::read_dir(proc_root)
        .map_err(|_| failure())?
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    let parents: HashMap<u32, u32> = entries
        .iter()
        .filter_map(|pid| Some((*pid, parent_pid(proc_root, *pid)?)))
        .collect();
    while changed {
        changed = false;
        for (pid, parent) in &parents {
            if descendants.contains(parent) && !descendants.contains(pid) {
                descendants.push(*pid);
                changed = true;
            }
        }
    }
    let mut renderers = 0usize;
    for pid in descendants.into_iter().skip(1) {
        let Some(cmdline) = proc_field(proc_root, pid, "cmdline") else {
            continue;
        };
        if !cmdline.contains("--type=renderer") {
            continue;
        }
        let status = proc_field(proc_root, pid, "status").ok_or_else(failure)?;
        let seccomp_filter = status
            .lines()
            .any(|line| line.split_whitespace().collect::<Vec<_>>() == ["Seccomp:", "2"]);
        let pid_ns = fs::read_link(proc_root.join(pid.to_string()).join("ns/pid"))
            .map_err(|_| failure())?;
        if !seccomp_filter || pid_ns == browser_pid_ns {
            return Err(failure());
        }
        renderers += 1;
    }
    if renderers == 0 {
        return Err(failure());
    }
    Ok(renderers)
}

/// Ubuntu 23.10+ restricts unprivileged user namespaces through AppArmor.
const USERNS_RESTRICTION: &str = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/// An engine that dies before CDP is up on a host that restricts user
/// namespaces could not start its sandbox (it never runs without one): report
/// that, so the AppImage on locked-down Ubuntu refuses with the sandbox code.
/// The deb's AppArmor profile lifts the restriction for its root-owned engine.
pub(crate) fn classify_start_failure(
    failure: HostFailure,
    engine_exited: bool,
    userns_restriction: Option<&str>,
) -> HostFailure {
    if engine_exited && userns_restriction.map(str::trim) == Some("1") {
        HostFailure::new("agent-browser-sandbox-unavailable", "sandbox-userns-restricted")
    } else {
        failure
    }
}

/// True when no process of the engine holds a listening TCP socket.
pub(crate) fn engine_has_no_listening_tcp(proc_root: &Path, browser_pid: u32) -> bool {
    let mut listening = std::collections::HashSet::new();
    for table in ["net/tcp", "net/tcp6"] {
        let Ok(text) = fs::read_to_string(proc_root.join(browser_pid.to_string()).join(table)) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() > 9 && fields[3] == "0A" {
                listening.insert(format!("socket:[{}]", fields[9]));
            }
        }
    }
    let Ok(entries) = fs::read_dir(proc_root) else {
        return false;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|v| v.parse::<u32>().ok()) else {
            continue;
        };
        let mut cursor = Some(pid);
        let mut belongs = false;
        for _ in 0..64 {
            match cursor {
                Some(value) if value == browser_pid => {
                    belongs = true;
                    break;
                }
                Some(value) if value > 1 => cursor = parent_pid(proc_root, value),
                _ => break,
            }
        }
        if !belongs {
            continue;
        }
        if let Ok(fds) = fs::read_dir(entry.path().join("fd")) {
            for fd in fds.flatten() {
                if let Ok(target) = fs::read_link(fd.path()) {
                    if listening.contains(target.to_string_lossy().as_ref()) {
                        return false;
                    }
                }
            }
        }
    }
    true
}

// ----------------------------------------------------------------- engine

pub(crate) struct LinuxAgentEngine {
    child: Option<Child>,
    shared: Arc<Shared>,
    reader: Option<JoinHandle<()>>,
    workers: Vec<JoinHandle<()>>,
    job_tx: Option<mpsc::Sender<Paused>>,
    browser_pid: u32,
}

impl LinuxAgentEngine {
    pub(crate) fn start(config: EngineConfig) -> Result<Self, HostFailure> {
        if config.gateway_token.is_empty() || !config.gateway_address.ip().is_loopback() {
            return Err(HostFailure::new("agent-browser-gateway-unavailable", "engine-config"));
        }
        let expected = config.expected_sha256.to_ascii_lowercase();
        let verified = open_verified_engine(&config.shell, &expected)?;
        // Above 4, so the child's dup2 onto 3/4 cannot replace the image.
        let image = high_fd(&OwnedFd::from(verified.file.try_clone().map_err(|_| {
            HostFailure::new("agent-browser-engine-integrity", "engine-integrity")
        })?))?;
        let profile = prepare_profile(&config.profile_root)?;
        let arguments = engine_arguments(&profile.join("chrome"), config.gateway_address.port());
        if arguments
            .iter()
            .any(|argument| argument_is_forbidden(argument, &profile.join("chrome")))
        {
            return Err(HostFailure::new("agent-browser-engine-unavailable", "engine-arguments"));
        }

        // fds: the engine reads commands on 3 and writes responses on 4.
        let (command_read, command_write) = cloexec_pipe()?;
        let (event_read, event_write) = cloexec_pipe()?;
        let child_in = high_fd(&command_read)?;
        let child_out = high_fd(&event_write)?;
        drop(command_read);
        drop(event_write);
        let child_in_raw = child_in.as_raw_fd();
        let child_out_raw = child_out.as_raw_fd();

        let mut command = Command::new(format!("/proc/self/fd/{}", image.as_raw_fd()));
        command
            .arg0(&config.shell)
            .args(&arguments)
            .env_clear()
            .env("HOME", profile.join("home"))
            .env("XDG_CONFIG_HOME", profile.join("config"))
            .env("XDG_CACHE_HOME", profile.join("cache"))
            .env("XDG_DATA_HOME", profile.join("data"))
            .env("TMPDIR", profile.join("tmp"))
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                    || libc::dup2(child_in_raw, 3) != 3
                    || libc::dup2(child_out_raw, 4) != 4
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command
            .spawn()
            .map_err(|_| HostFailure::new("agent-browser-engine-unavailable", "engine-spawn"))?;
        drop(child_in);
        drop(child_out);
        drop(image);
        let browser_pid = child.id();
        // The name must still be the object that was hashed and executed.
        if verified.directory.verify_named(&verified.name, &verified.file).is_err() {
            let mut child = child;
            unsafe { libc::kill(-(browser_pid as i32), libc::SIGKILL) };
            let _ = child.wait();
            return Err(HostFailure::new("agent-browser-engine-integrity", "engine-integrity"));
        }

        let alive = Arc::new(AtomicBool::new(true));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let shared = Arc::new(Shared {
            cdp: Cdp {
                writer: Mutex::new(File::from(command_write)),
                next_id: AtomicU64::new(1),
                pending: Arc::clone(&pending),
                alive: Arc::clone(&alive),
            },
            policy: Mutex::new(AgentTopLevelPolicy::default()),
            state: Mutex::new(NavigationState {
                status: "idle",
                ..NavigationState::default()
            }),
            main_frame: Mutex::new(None),
            page_session: Mutex::new(None),
            page_target: Mutex::new(None),
            popup_frames: Mutex::new(std::collections::HashSet::new()),
            redirect_cache: Mutex::new(HashMap::new()),
            in_flight: AtomicUsize::new(0),
            active: AtomicBool::new(true),
            counters: MediationCounters::default(),
            test_fixture_port: config.test_fixture_port,
            gateway_address: config.gateway_address,
            gateway_token: config.gateway_token,
            state_changed: (Mutex::new(0), std::sync::Condvar::new()),
        });

        let (job_tx, job_rx) = mpsc::channel::<Paused>();
        let job_rx = Arc::new(Mutex::new(job_rx));
        let mut workers = Vec::new();
        for index in 0..FETCH_WORKERS {
            let receiver = Arc::clone(&job_rx);
            let worker_shared = Arc::clone(&shared);
            let worker = std::thread::Builder::new()
                .name(format!("luckyray-agent-browser-fetch-{index}"))
                .spawn(move || loop {
                    let job = {
                        let receiver = receiver.lock().unwrap_or_else(|error| error.into_inner());
                        receiver.recv()
                    };
                    let Ok(job) = job else { break };
                    let result = if worker_shared.active.load(Ordering::Acquire) {
                        fetch_agent_resource(
                            worker_shared.gateway_address,
                            &worker_shared.gateway_token,
                            &job.method,
                            &job.url,
                        )
                    } else {
                        Err(())
                    };
                    worker_shared.complete(job, result);
                })
                .map_err(|_| HostFailure::new("agent-browser-engine-unavailable", "engine-workers"))?;
            workers.push(worker);
        }

        let reader_shared = Arc::clone(&shared);
        let reader_tx = job_tx.clone();
        let reader = std::thread::Builder::new()
            .name("luckyray-agent-browser-cdp".into())
            .spawn(move || {
                let mut frames = FrameReader::new(File::from(event_read));
                while let Ok(Some(frame)) = frames.next_frame() {
                    let Ok(message) = serde_json::from_slice::<Value>(&frame) else {
                        break;
                    };
                    dispatch(&reader_shared, &reader_tx, message);
                }
                reader_shared.cdp.alive.store(false, Ordering::Release);
                reader_shared.active.store(false, Ordering::Release);
                reader_shared
                    .cdp
                    .pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clear();
                reader_shared.notify();
            })
            .map_err(|_| HostFailure::new("agent-browser-engine-unavailable", "engine-reader"))?;

        let mut engine = Self {
            child: Some(child),
            shared,
            reader: Some(reader),
            workers,
            job_tx: Some(job_tx),
            browser_pid,
        };
        if let Err(failure) = engine.configure() {
            let exited = engine.engine_exited_within(Duration::from_secs(1));
            engine.close();
            let restriction = fs::read_to_string(USERNS_RESTRICTION).ok();
            return Err(classify_start_failure(failure, exited, restriction.as_deref()));
        }
        if let Err(failure) = engine.wait_for_sandboxed_renderer() {
            engine.close();
            return Err(failure);
        }
        Ok(engine)
    }

    fn configure(&self) -> Result<(), HostFailure> {
        let cdp = &self.shared.cdp;
        // Browser-wide: every request of every target is paused for mediation.
        cdp.call(
            "Fetch.enable",
            json!({"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}),
            None,
        )?;
        cdp.call("Browser.setDownloadBehavior", json!({"behavior": "deny"}), None)?;
        let targets = cdp.call("Target.getTargets", json!({}), None)?;
        let target = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| item["type"] == "page"))
            .and_then(|item| item["targetId"].as_str())
            .ok_or_else(|| HostFailure::new("agent-browser-engine-failed", "engine-target"))?
            .to_owned();
        // Record our page before auto-attach, so only other pages count as popups.
        *self
            .shared
            .page_target
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(target.clone());
        // New pages (popups) attach paused and are closed in `dispatch`.
        cdp.call(
            "Target.setAutoAttach",
            json!({"autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true}),
            None,
        )?;
        let attached = cdp.call(
            "Target.attachToTarget",
            json!({"targetId": target, "flatten": true}),
            None,
        )?;
        let session = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| HostFailure::new("agent-browser-engine-failed", "engine-target"))?
            .to_owned();
        *self
            .shared
            .page_session
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(session.clone());
        prepare_document_session(&self.shared, &session)?;
        cdp.call("Page.setLifecycleEventsEnabled", json!({"enabled": true}), Some(&session))?;
        cdp.call("Network.setBypassServiceWorker", json!({"bypass": true}), Some(&session))?;
        let tree = cdp.call("Page.getFrameTree", json!({}), Some(&session))?;
        let frame = tree
            .pointer("/frameTree/frame/id")
            .and_then(Value::as_str)
            .ok_or_else(|| HostFailure::new("agent-browser-engine-failed", "engine-target"))?
            .to_owned();
        *self
            .shared
            .main_frame
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(frame);
        Ok(())
    }

    fn wait_for_sandboxed_renderer(&self) -> Result<(), HostFailure> {
        let deadline = Instant::now() + SANDBOX_CHECK_TIMEOUT;
        loop {
            match renderer_sandbox_check(Path::new("/proc"), self.browser_pid) {
                Ok(_) => return Ok(()),
                Err(failure) if Instant::now() >= deadline => return Err(failure),
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    /// False once the engine's CDP pipe has closed (the engine exited).
    pub(crate) fn is_alive(&self) -> bool {
        self.child.is_some() && self.shared.cdp.alive.load(Ordering::Acquire)
    }

    pub(crate) fn browser_pid(&self) -> u32 {
        self.browser_pid
    }

    pub(crate) fn counters(&self) -> &MediationCounters {
        &self.shared.counters
    }

    pub(crate) fn snapshot(&self) -> EngineSnapshot {
        let state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        EngineSnapshot {
            status: state.status,
            origin: state.origin.clone(),
            title: state.title.clone(),
            document_token: state.document_token.clone(),
            generation: state.generation,
        }
    }

    fn session(&self) -> Result<String, HostFailure> {
        self.shared
            .page_session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .ok_or_else(|| HostFailure::new("browser-host-terminated", "engine-session"))
    }

    pub(crate) fn navigate(&self, url: &str) -> Result<(), HostFailure> {
        let target = validated_top_level_url(url, self.shared.test_fixture_port)?;
        self.shared
            .policy
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .begin(&target);
        {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.status = "loading";
            state.loader_id = None;
            state.document_token = None;
            state.title = None;
        }
        let session = self.session()?;
        let result = self
            .shared
            .cdp
            .call("Page.navigate", json!({"url": target.as_str()}), Some(&session))
            .map_err(|_| HostFailure::new("browser-navigation-failed", "navigation-dispatch"))?;
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if result.get("errorText").is_some() {
            if state.status != "error" {
                state.status = "error";
                state.title = Some("navigation-failed".to_owned());
                state.document_token = None;
            }
        } else {
            state.loader_id = result
                .get("loaderId")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        drop(state);
        self.shared.notify();
        Ok(())
    }

    /// Waits until the navigation is loaded (DOMContentLoaded, as on
    /// Windows) or failed, then re-checks the renderer sandbox.
    pub(crate) fn wait_settled(&self, timeout: Duration) -> Result<EngineSnapshot, HostFailure> {
        let deadline = Instant::now() + timeout;
        let (lock, condvar) = &self.shared.state_changed;
        loop {
            let snapshot = self.snapshot();
            if snapshot.status != "loading" {
                if snapshot.status == "loaded" {
                    renderer_sandbox_check(Path::new("/proc"), self.browser_pid)?;
                }
                return Ok(snapshot);
            }
            if !self.shared.cdp.alive.load(Ordering::Acquire) {
                return Err(HostFailure::new("browser-host-terminated", "engine-exit"));
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(HostFailure::new("browser-navigation-timeout", "navigation-wait"));
            }
            let guard = lock.lock().unwrap_or_else(|error| error.into_inner());
            let _ = condvar
                .wait_timeout(guard, (deadline - now).min(Duration::from_millis(100)))
                .map_err(|_| ());
        }
    }

    fn require_ready(&self) -> Result<String, HostFailure> {
        if self.snapshot().status != "loaded" {
            return Err(HostFailure::new("browser-session-not-ready", "agent-readonly"));
        }
        self.session()
    }

    fn evaluate(&self, script: &str, code: &'static str, phase: &'static str) -> Result<Value, HostFailure> {
        let session = self.require_ready()?;
        let result = self
            .shared
            .cdp
            .call(
                "Runtime.evaluate",
                json!({"expression": script, "returnByValue": true, "awaitPromise": false}),
                Some(&session),
            )
            .map_err(|_| HostFailure::new(code, phase))?;
        if result.get("exceptionDetails").is_some() {
            return Err(HostFailure::new(code, phase));
        }
        let value = result
            .pointer("/result/value")
            .cloned()
            .ok_or_else(|| HostFailure::new(code, phase))?;
        super::sanitize_agent_result(value)
    }

    pub(crate) fn read(&self) -> Result<Value, HostFailure> {
        self.evaluate(AGENT_READ_SCRIPT, "browser-read-failed", "read-execute")
    }

    pub(crate) fn extract(&self, kind: AgentExtractKind, index: Option<usize>) -> Result<Value, HostFailure> {
        let script = agent_extract_script(kind, index)?;
        self.evaluate(&script, "browser-extract-failed", "extract-execute")
    }

    /// Test-only probe of the live document (the Windows fixture evidence
    /// role); never part of the Agent protocol.
    #[cfg(test)]
    pub(crate) fn probe(&self, expression: &str) -> Result<Value, HostFailure> {
        let session = self.session()?;
        let result = self.shared.cdp.call(
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
            Some(&session),
        )?;
        Ok(result.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    /// True when the engine process has already exited (within `wait`).
    fn engine_exited_within(&mut self, wait: Duration) -> bool {
        let Some(child) = self.child.as_mut() else {
            return true;
        };
        let deadline = Instant::now() + wait;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => return false,
            }
        }
    }

    pub(crate) fn close(&mut self) {
        self.shared.active.store(false, Ordering::Release);
        let _ = self.shared.cdp.post("Browser.close", json!({}), None);
        if let Some(mut child) = self.child.take() {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    _ => {
                        // The engine runs in its own process group.
                        unsafe {
                            libc::kill(-(self.browser_pid as i32), libc::SIGKILL);
                        }
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
        self.job_tx.take();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Drop for LinuxAgentEngine {
    fn drop(&mut self) {
        self.close();
    }
}

/// Lockdown script, dialog handling and nested auto-attach for a document
/// target (the page and every out-of-process iframe).
fn prepare_document_session(shared: &Shared, session: &str) -> Result<(), HostFailure> {
    let cdp = &shared.cdp;
    cdp.call("Page.enable", json!({}), Some(session))?;
    cdp.call(
        "Page.addScriptToEvaluateOnNewDocument",
        json!({"source": AGENT_NETWORK_LOCKDOWN_SCRIPT, "runImmediately": true}),
        Some(session),
    )?;
    cdp.call(
        "Target.setAutoAttach",
        json!({"autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true}),
        Some(session),
    )?;
    Ok(())
}

fn dispatch(shared: &Arc<Shared>, jobs: &mpsc::Sender<Paused>, message: Value) {
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if let Some(sender) = shared
            .cdp
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id)
        {
            let _ = sender.send(message);
        }
        return;
    }
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let session = message.get("sessionId").and_then(Value::as_str);
    match method {
        "Fetch.requestPaused" => {
            if let Some(job) = shared.admit(&params) {
                if let Err(error) = jobs.send(job) {
                    let job = error.0;
                    shared.complete(job, Err(()));
                }
            }
        }
        "Target.attachedToTarget" => {
            let child_session = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let kind = params
                .pointer("/targetInfo/type")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let target_id = params
                .pointer("/targetInfo/targetId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let ours = shared
                .page_target
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_deref()
                == Some(target_id.as_str());
            if kind.as_deref() == Some("page") && !ours {
                shared
                    .popup_frames
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(target_id.clone());
            }
            let worker = Arc::clone(shared);
            // Configure off the reader thread: calls need the reader running.
            std::thread::spawn(move || {
                match kind.as_deref() {
                    Some("page") if !ours => {
                        // Popups never load anything: their requests are
                        // refused in `admit`. Resume first (a paused popup can
                        // stall its opener's renderer), then close it.
                        worker.counters.popups_closed.fetch_add(1, Ordering::AcqRel);
                        let _ = worker.cdp.call(
                            "Runtime.runIfWaitingForDebugger",
                            json!({}),
                            Some(&child_session),
                        );
                        let _ = worker
                            .cdp
                            .call("Target.closeTarget", json!({"targetId": target_id}), None);
                        return;
                    }
                    Some("service_worker") => {
                        // Defence in depth: a worker that somehow started is
                        // closed before it runs.
                        let _ = worker
                            .cdp
                            .call("Target.closeTarget", json!({"targetId": target_id}), None);
                        return;
                    }
                    Some("iframe") => {
                        if prepare_document_session(&worker, &child_session).is_err() {
                            let _ = worker
                                .cdp
                                .call("Target.closeTarget", json!({"targetId": target_id}), None);
                            return;
                        }
                    }
                    _ => {}
                }
                let _ = worker.cdp.post(
                    "Runtime.runIfWaitingForDebugger",
                    json!({}),
                    Some(&child_session),
                );
            });
        }
        "Page.javascriptDialogOpening" => {
            if let Some(session) = session {
                shared
                    .counters
                    .dialogs_dismissed
                    .fetch_add(1, Ordering::AcqRel);
                let _ = shared.cdp.post(
                    "Page.handleJavaScriptDialog",
                    json!({"accept": false}),
                    Some(session),
                );
            }
        }
        "Page.lifecycleEvent" => {
            let page_session = shared
                .page_session
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            if session != page_session.as_deref() {
                return;
            }
            let main = shared
                .main_frame
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            if params.get("frameId").and_then(Value::as_str) != main.as_deref()
                || params.get("name").and_then(Value::as_str) != Some("DOMContentLoaded")
            {
                return;
            }
            let loader = params.get("loaderId").and_then(Value::as_str);
            let mut state = shared.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.status == "loading"
                && state.document_token.is_some()
                && (state.loader_id.is_none() || state.loader_id.as_deref() == loader)
            {
                state.status = "loaded";
            }
            drop(state);
            shared.notify();
            let title_shared = Arc::clone(shared);
            let title_session = page_session.unwrap_or_default();
            std::thread::spawn(move || {
                if let Ok(result) = title_shared.cdp.call(
                    "Runtime.evaluate",
                    json!({"expression": "document.title", "returnByValue": true}),
                    Some(&title_session),
                ) {
                    let title = result
                        .pointer("/result/value")
                        .and_then(Value::as_str)
                        .and_then(bounded_title);
                    let mut state = title_shared
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if state.status == "loaded" {
                        state.title = title;
                    }
                    drop(state);
                    title_shared.notify();
                }
            });
        }
        "Inspector.detached" | "Target.targetCrashed" => {
            let mut state = shared.state.lock().unwrap_or_else(|error| error.into_inner());
            state.status = "error";
            state.document_token = None;
            drop(state);
            shared.active.store(false, Ordering::Release);
            shared.notify();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    //! Synthetic loopback pages only. The engine-backed tests need the pinned
    //! shell, unpacked by `tools/linux-agent-browser/shell.py`, at
    //! `LUCKYRAY_AGENT_BROWSER_TEST_SHELL`; they fail (never skip) without it.
    use super::super::super::gateway::{GatewayPolicy, ValidatingGateway};
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::{TcpListener, TcpStream};

    const PIN: &str = include_str!("../../../tools/linux-agent-browser/pin.json");

    fn pinned_executable_sha256() -> String {
        let pin: Value = serde_json::from_str(PIN).expect("pin.json");
        pin["executableSha256"].as_str().expect("executableSha256").to_owned()
    }

    fn pinned_shell() -> PathBuf {
        let path = std::env::var_os("LUCKYRAY_AGENT_BROWSER_TEST_SHELL")
            .expect("LUCKYRAY_AGENT_BROWSER_TEST_SHELL must point at the pinned shell");
        PathBuf::from(path)
    }

    fn fresh_profile(root: &Path) -> PathBuf {
        let profile = root.join("profile");
        fs::create_dir(&profile).unwrap();
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
        profile
    }

    type Route = (u16, &'static str, String, Option<String>);

    /// Minimal synthetic HTTP server: fixed routes, records every request path.
    struct Fixture {
        address: SocketAddr,
        hits: Arc<Mutex<Vec<String>>>,
        connections: Arc<AtomicUsize>,
    }

    impl Fixture {
        fn start(routes: HashMap<&'static str, Route>) -> Self {
            Self::serve_on(TcpListener::bind("127.0.0.1:0").unwrap(), routes)
        }

        fn serve_on(listener: TcpListener, routes: HashMap<&'static str, Route>) -> Self {
            let address = listener.local_addr().unwrap();
            let hits = Arc::new(Mutex::new(Vec::new()));
            let connections = Arc::new(AtomicUsize::new(0));
            let (thread_hits, thread_connections) = (Arc::clone(&hits), Arc::clone(&connections));
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { break };
                    thread_connections.fetch_add(1, Ordering::AcqRel);
                    let routes = routes.clone();
                    let hits = Arc::clone(&thread_hits);
                    std::thread::spawn(move || serve(stream, &routes, &hits));
                }
            });
            Self {
                address,
                hits,
                connections,
            }
        }

        fn origin(&self) -> String {
            format!("http://{}", self.address)
        }

        fn hits_for(&self, path: &str) -> usize {
            self.hits.lock().unwrap().iter().filter(|hit| *hit == path).count()
        }
    }

    fn serve(stream: TcpStream, routes: &HashMap<&'static str, Route>, hits: &Mutex<Vec<String>>) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                break;
            }
        }
        let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
        hits.lock().unwrap().push(path.clone());
        let (status, content_type, body, location) = routes
            .get(path.as_str())
            .cloned()
            .unwrap_or((404, "text/plain", "missing".to_owned(), None));
        let mut response = format!(
            "HTTP/1.1 {status} Synthetic\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        if let Some(location) = location {
            response.push_str(&format!("Location: {location}\r\n"));
        }
        response.push_str("\r\n");
        response.push_str(&body);
        let mut stream = stream;
        let _ = stream.write_all(response.as_bytes());
    }

    fn page(body: &str) -> Route {
        (200, "text/html; charset=utf-8", body.to_owned(), None)
    }

    struct Running {
        engine: LinuxAgentEngine,
        _gateway: ValidatingGateway,
        _root: tempfile::TempDir,
    }

    fn start_engine(fixture: &Fixture) -> Running {
        let gateway =
            ValidatingGateway::start(GatewayPolicy::exact_loopback_for_fixture(fixture.address))
                .expect("gateway");
        let root = tempfile::tempdir().unwrap();
        let engine = LinuxAgentEngine::start(EngineConfig {
            shell: pinned_shell(),
            expected_sha256: pinned_executable_sha256(),
            profile_root: fresh_profile(root.path()),
            gateway_address: gateway.address(),
            gateway_token: gateway.control_token().to_owned(),
            test_fixture_port: Some(fixture.address.port()),
        })
        .expect("engine starts sandboxed");
        Running {
            engine,
            _gateway: gateway,
            _root: root,
        }
    }

    fn load(engine: &LinuxAgentEngine, url: &str) -> EngineSnapshot {
        engine.navigate(url).expect("navigate");
        engine.wait_settled(Duration::from_secs(20)).expect("settled")
    }

    fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        condition()
    }

    #[test]
    fn linux_engine_reads_and_extracts_a_synthetic_loopback_page_through_the_gateway() {
        let mut routes = HashMap::new();
        routes.insert(
            "/",
            page(
                "<!doctype html><title>Synthetic Agent Fixture</title><main><h1>Synthetic heading</h1>\
                 <h2>Second heading</h2><p>Synthetic paragraph for the Linux engine.</p>\
                 <a href=\"/next\">Next synthetic page</a><table><tr><th>k</th><th>v</th></tr>\
                 <tr><td>alpha</td><td>1</td></tr></table></main>",
            ),
        );
        let fixture = Fixture::start(routes);
        let running = start_engine(&fixture);
        let engine = &running.engine;

        let url = format!("{}/", fixture.origin());
        let snapshot = load(engine, &url);
        assert_eq!(snapshot.status, "loaded");
        assert_eq!(snapshot.origin.as_deref(), Some(fixture.origin().as_str()));
        assert_eq!(snapshot.document_token, Some(browser_document_token(&url)));
        assert!(wait_until(|| engine.snapshot().title.as_deref() == Some("Synthetic Agent Fixture")));

        let read = engine.read().expect("read");
        let text = read.to_string();
        assert!(text.contains("Synthetic paragraph for the Linux engine."), "{text}");
        let headings = engine.extract(AgentExtractKind::Headings, None).unwrap().to_string();
        assert!(headings.contains("Synthetic heading") && headings.contains("Second heading"));
        let links = engine.extract(AgentExtractKind::Links, None).unwrap().to_string();
        assert!(links.contains("Next synthetic page") && links.contains("/next"));
        let table = engine.extract(AgentExtractKind::Table, Some(0)).unwrap().to_string();
        assert!(table.contains("alpha"));

        // Fetched once, by the gateway, never directly by the engine.
        assert_eq!(fixture.hits_for("/"), 1);
        assert!(engine.counters().mediated.load(Ordering::Acquire) >= 1);
        assert!(renderer_sandbox_check(Path::new("/proc"), engine.browser_pid()).unwrap() >= 1);
        assert!(engine_has_no_listening_tcp(Path::new("/proc"), engine.browser_pid()));
    }

    #[test]
    fn linux_engine_blocks_private_targets_unmediated_channels_and_popups() {
        let outsider = Fixture::start(HashMap::new());
        let q = outsider.origin();
        let mut routes = HashMap::new();
        routes.insert(
            "/",
            page(&format!(
                "<!doctype html><title>Probe</title><img src=\"http://10.0.0.1/x.png\">\
                 <iframe src=\"{q}/frame\"></iframe>\
                 <script>\
                 window.__probe = {{}};\
                 window.__probe.rtc = typeof RTCPeerConnection;\
                 window.__probe.transport = typeof WebTransport;\
                 window.__probe.beacon = typeof navigator.sendBeacon;\
                 fetch('{q}/fetch').then(r => window.__probe.fetch = r.status, () => window.__probe.fetch = 'error');\
                 fetch('/post', {{method: 'POST', body: 'x'}}).then(r => window.__probe.post = r.status, () => window.__probe.post = 'error');\
                 try {{ const ws = new WebSocket('ws://{host}/ws'); ws.onerror = () => window.__probe.ws = 'error'; ws.onopen = () => window.__probe.ws = 'open'; }} catch (e) {{ window.__probe.ws = 'throw'; }}\
                 try {{ window.open('/popup'); }} catch (e) {{}}\
                 try {{ alert('synthetic'); }} catch (e) {{}}\
                 </script>",
                host = outsider.address
            )),
        );
        routes.insert("/popup", page("<title>Popup</title>"));
        routes.insert("/post", page("never"));
        let fixture = Fixture::start(routes);
        let running = start_engine(&fixture);
        let engine = &running.engine;

        assert_eq!(load(engine, &format!("{}/", fixture.origin())).status, "loaded");
        assert!(wait_until(|| {
            engine
                .probe("JSON.stringify(window.__probe)")
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .is_some_and(|value| value.contains("\"fetch\"") && value.contains("\"ws\""))
        }));
        let probe = engine.probe("window.__probe").unwrap();
        assert_eq!(probe["rtc"], "undefined");
        assert_eq!(probe["transport"], "undefined");
        assert_ne!(probe["fetch"], 200);
        assert_ne!(probe["ws"], "open");
        assert!(wait_until(|| engine.counters().popups_closed.load(Ordering::Acquire) >= 1));
        assert!(engine.counters().blocked.load(Ordering::Acquire) >= 2);
        std::thread::sleep(Duration::from_millis(500));

        // Nothing reached the second loopback server or the private address,
        // and the fixture saw no POST, popup or download fetch.
        assert_eq!(outsider.connections.load(Ordering::Acquire), 0);
        assert_eq!(fixture.hits_for("/post"), 0);
        assert_eq!(fixture.hits_for("/popup"), 0);
        assert_eq!(fixture.hits_for("/"), 1);
        assert_eq!(engine.snapshot().status, "loaded");
        assert!(engine_has_no_listening_tcp(Path::new("/proc"), engine.browser_pid()));
    }

    #[test]
    fn linux_engine_follows_gateway_redirects_once_and_denies_unpermitted_navigation() {
        let outsider = Fixture::start(HashMap::new());
        let mut routes = HashMap::new();
        routes.insert("/start", (302, "text/plain", String::new(), Some("/final".to_owned())));
        routes.insert("/final", page("<title>Final</title><p>Synthetic final page</p>"));
        routes.insert(
            "/escape",
            (302, "text/plain", String::new(), Some(format!("{}/", outsider.origin()))),
        );
        routes.insert("/other", page("<title>Other</title>"));
        let fixture = Fixture::start(routes);
        let running = start_engine(&fixture);
        let engine = &running.engine;

        let snapshot = load(engine, &format!("{}/start", fixture.origin()));
        assert_eq!(snapshot.status, "loaded");
        let final_url = format!("{}/final", fixture.origin());
        assert_eq!(snapshot.document_token, Some(browser_document_token(&final_url)));
        assert!(engine.read().unwrap().to_string().contains("Synthetic final page"));
        assert_eq!(fixture.hits_for("/start"), 1);
        assert_eq!(fixture.hits_for("/final"), 1);
        assert_eq!(
            engine.probe("location.href").unwrap(),
            Value::String(final_url.clone())
        );

        // A page-initiated navigation the Agent did not ask for is cancelled.
        let denied_before = engine.counters().navigation_denied.load(Ordering::Acquire);
        let _ = engine.probe("location.href = '/other'; 1");
        assert!(wait_until(|| engine.snapshot().status == "error"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.title.as_deref(), Some("agent-browser-navigation-denied"));
        assert_eq!(snapshot.document_token, None);
        assert!(engine.counters().navigation_denied.load(Ordering::Acquire) > denied_before);
        assert_eq!(fixture.hits_for("/other"), 0);
        assert!(engine.read().is_err());

        // A redirect to another origin is refused by the gateway.
        let snapshot = load(engine, &format!("{}/escape", fixture.origin()));
        // Same as Windows: the refused fetch is answered with the 403 block.
        assert_eq!(snapshot.status, "loaded");
        assert_eq!(
            snapshot.document_token,
            Some(browser_document_token(&format!("{}/escape", fixture.origin())))
        );
        assert_eq!(engine.probe("document.body.innerText").unwrap(), "blocked");
        assert_eq!(fixture.hits_for("/escape"), 1);
        assert_eq!(outsider.connections.load(Ordering::Acquire), 0);

        // Private or non-fixture targets are refused before anything starts.
        assert!(engine.navigate(&format!("{}/", outsider.origin())).is_err());
        assert!(engine.navigate("http://10.0.0.1/").is_err());
        assert!(engine.navigate("file:///etc/hostname").is_err());
    }

    #[test]
    fn linux_engine_refuses_a_shell_or_profile_that_does_not_match() {
        let root = tempfile::tempdir().unwrap();
        let fake_shell = root.path().join("chrome-headless-shell");
        let marker = root.path().join("ran");
        fs::write(
            &fake_shell,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&fake_shell, fs::Permissions::from_mode(0o700)).unwrap();
        let config = |profile: PathBuf, sha: String| EngineConfig {
            shell: fake_shell.clone(),
            expected_sha256: sha,
            profile_root: profile,
            gateway_address: "127.0.0.1:9".parse().unwrap(),
            gateway_token: "synthetic-token".to_owned(),
            test_fixture_port: None,
        };
        let profile = fresh_profile(root.path());
        let failure = LinuxAgentEngine::start(config(profile.clone(), pinned_executable_sha256()))
            .err()
            .expect("pin mismatch refused");
        assert_eq!(failure.code, "agent-browser-engine-integrity");
        assert!(!marker.exists(), "a shell that is not the pin must never run");
        assert!(LinuxAgentEngine::start(config(profile.clone(), "00".repeat(32))).is_err());
        assert!(!marker.exists());

        // Right hash, bad profiles: refused before spawn as well. The engine
        // must be an ELF image now, so a synthetic stand-in is used here.
        let fake_shell = synthetic_engine(root.path(), "stand-in", 0o700);
        let config = |profile: PathBuf, sha: String| EngineConfig {
            shell: fake_shell.clone(),
            expected_sha256: sha,
            profile_root: profile,
            gateway_address: "127.0.0.1:9".parse().unwrap(),
            gateway_token: "synthetic-token".to_owned(),
            test_fixture_port: None,
        };
        let real_sha = sha256_file(&fake_shell).unwrap();
        fs::write(profile.join("stale"), b"x").unwrap();
        let failure = LinuxAgentEngine::start(config(profile.clone(), real_sha.clone())).err().unwrap();
        assert_eq!(failure.code, "agent-browser-profile-invalid");
        let open = root.path().join("open");
        fs::create_dir(&open).unwrap();
        fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(LinuxAgentEngine::start(config(open, real_sha.clone())).is_err());
        let real_dir = root.path().join("real");
        fs::create_dir(&real_dir).unwrap();
        fs::set_permissions(&real_dir, fs::Permissions::from_mode(0o700)).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&real_dir, &link).unwrap();
        assert!(LinuxAgentEngine::start(config(link, real_sha.clone())).is_err());
        assert!(fs::read_dir(&real_dir).unwrap().next().is_none());
        assert!(LinuxAgentEngine::start(config(PathBuf::from("relative"), real_sha.clone())).is_err());
        // No token or a non-loopback gateway is refused too.
        let mut no_gateway = config(root.path().join("unused"), real_sha);
        no_gateway.gateway_address = "10.0.0.1:9".parse().unwrap();
        assert_eq!(
            LinuxAgentEngine::start(no_gateway).err().unwrap().code,
            "agent-browser-gateway-unavailable"
        );
        assert!(!marker.exists());
    }

    fn fake_process(root: &Path, pid: u32, ppid: u32, cmdline: &str, seccomp: u8, pid_ns: &str) {
        let dir = root.join(pid.to_string());
        fs::create_dir_all(dir.join("ns")).unwrap();
        fs::write(dir.join("stat"), format!("{pid} (chrome) S {ppid} {pid} {pid} 0")).unwrap();
        fs::write(dir.join("cmdline"), cmdline.replace(' ', "\0")).unwrap();
        fs::write(dir.join("status"), format!("Name:\tchrome\nSeccomp:\t{seccomp}\n")).unwrap();
        std::os::unix::fs::symlink(format!("pid:[{pid_ns}]"), dir.join("ns/pid")).unwrap();
    }

    #[test]
    fn linux_engine_sandbox_check_refuses_unsandboxed_or_missing_renderers() {
        let browser = "/opt/shell --remote-debugging-pipe";
        let renderer = "/opt/shell --type=renderer --lang=en";
        // Sandboxed: renderer under the zygote, seccomp filter, own PID ns.
        let good = tempfile::tempdir().unwrap();
        fake_process(good.path(), 100, 1, browser, 0, "1");
        fake_process(good.path(), 101, 100, "/opt/shell --type=zygote", 0, "2");
        fake_process(good.path(), 102, 101, renderer, 2, "2");
        fake_process(good.path(), 200, 1, renderer, 0, "1"); // not ours
        assert_eq!(renderer_sandbox_check(good.path(), 100).unwrap(), 1);

        // Seccomp off, same PID namespace, or no renderer: refused.
        for (seccomp, namespace) in [(0u8, "2"), (1, "2"), (2, "1")] {
            let bad = tempfile::tempdir().unwrap();
            fake_process(bad.path(), 100, 1, browser, 0, "1");
            fake_process(bad.path(), 101, 100, "/opt/shell --type=zygote", 0, "2");
            fake_process(bad.path(), 102, 101, renderer, 2, "2");
            fake_process(bad.path(), 103, 101, renderer, seccomp, namespace);
            assert_eq!(
                renderer_sandbox_check(bad.path(), 100).err().unwrap().code,
                "agent-browser-sandbox-unavailable"
            );
        }
        let none = tempfile::tempdir().unwrap();
        fake_process(none.path(), 100, 1, browser, 0, "1");
        assert!(renderer_sandbox_check(none.path(), 100).is_err());
        assert!(renderer_sandbox_check(none.path(), 999).is_err());
    }

    #[test]
    fn linux_engine_start_failure_under_restricted_userns_is_a_sandbox_refusal() {
        let cdp = || HostFailure::new("agent-browser-engine-failed", "cdp-call");
        let refused = classify_start_failure(cdp(), true, Some("1\n"));
        assert_eq!(refused.code, "agent-browser-sandbox-unavailable");
        assert_eq!(refused.phase, "sandbox-userns-restricted");
        // Unrestricted host, sysctl absent, or an engine that is still alive:
        // the original failure stands.
        for (exited, restriction) in [(true, Some("0\n")), (true, None), (false, Some("1\n"))] {
            let kept = classify_start_failure(cdp(), exited, restriction);
            assert_eq!((kept.code, kept.phase), ("agent-browser-engine-failed", "cdp-call"));
        }
    }

    #[test]
    fn linux_engine_arguments_are_pipe_only_and_cdp_frames_are_bounded() {
        let profile = Path::new("/tmp/LuckyRay/AgentBrowser/v1/synthetic/chrome");
        let arguments = engine_arguments(profile, 43123);
        assert_eq!(arguments[0], "--remote-debugging-pipe");
        assert_eq!(arguments.last().map(String::as_str), Some("about:blank"));
        for expected in agent_browser_arguments(43123) {
            assert!(arguments.contains(&expected), "{expected}");
        }
        assert!(!arguments.iter().any(|argument| argument_is_forbidden(argument, profile)));
        for switch in FORBIDDEN_SWITCHES {
            assert!(!arguments.iter().any(|argument| argument.starts_with(&format!("{switch}=")) && *switch != "--user-data-dir"));
            assert!(argument_is_forbidden(switch, profile));
            assert!(argument_is_forbidden(&format!("{switch}=1"), profile));
        }
        assert!(argument_is_forbidden("--user-data-dir=/tmp/other", profile));
        assert!(!arguments.iter().any(|argument| argument.contains("remote-debugging-port")));

        // NUL framing, split reads, and the size cap.
        let stream = b"{\"id\":1}\0{\"id\":2,\"result\":{}}\0{\"id\":".to_vec();
        let mut frames = FrameReader::new(std::io::Cursor::new(stream));
        assert_eq!(frames.next_frame().unwrap().unwrap(), b"{\"id\":1}");
        assert_eq!(frames.next_frame().unwrap().unwrap(), b"{\"id\":2,\"result\":{}}");
        assert_eq!(frames.next_frame().unwrap(), None);
        let oversized = vec![b'a'; MAX_CDP_MESSAGE_BYTES + 2];
        let mut frames = FrameReader::new(std::io::Cursor::new(oversized));
        assert!(frames.next_frame().is_err());
        assert_eq!(MAX_PENDING_AGENT_RESOURCES, 128);
        assert_eq!(AGENT_RESOURCE_DEADLINE, Duration::from_secs(18));
    }

    // ------------------------------------------------------------ attacks
    // T55 slice 5: every case below must be refused (fail closed) with the
    // production checks unchanged. Synthetic data only.

    /// A small ELF image standing in for the engine; it is never started by
    /// these tests because every case is refused before spawn.
    fn synthetic_engine(directory: &Path, name: &str, mode: u32) -> PathBuf {
        let path = directory.join(name);
        fs::copy("/bin/true", &path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn set_synthetic_xattr(path: &Path) {
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        let rc = unsafe {
            libc::setxattr(
                name.as_ptr(),
                c"user.luckyray-synthetic".as_ptr(),
                b"1".as_ptr().cast(),
                1,
                0,
            )
        };
        assert_eq!(rc, 0, "the test filesystem must support user xattrs");
    }

    fn private_dir(path: &Path) -> PathBuf {
        fs::create_dir_all(path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        path.to_owned()
    }

    fn start_code(shell: &Path, sha: &str, profile: PathBuf) -> &'static str {
        match LinuxAgentEngine::start(EngineConfig {
            shell: shell.to_owned(),
            expected_sha256: sha.to_owned(),
            profile_root: profile,
            gateway_address: "127.0.0.1:9".parse().unwrap(),
            gateway_token: "synthetic-token".to_owned(),
            test_fixture_port: None,
        }) {
            Ok(_) => "started",
            Err(failure) => failure.code,
        }
    }

    #[test]
    fn linux_engine_attack_refuses_a_swapped_linked_writable_or_attributed_engine() {
        let root = tempfile::tempdir().unwrap();
        let bin = private_dir(&root.path().join("bin"));
        let good = synthetic_engine(&bin, "chrome-headless-shell", 0o755);
        let sha = sha256_file(&good).unwrap();
        // A profile that is not empty: the integrity checks run first, so a
        // passing engine reaches the profile check and stops there.
        let stale = private_dir(&root.path().join("stale"));
        fs::write(stale.join("x"), b"x").unwrap();
        let bad_profile = || stale.clone();
        assert_eq!(start_code(&good, &sha, bad_profile()), "agent-browser-profile-invalid");

        let integrity = "agent-browser-engine-integrity";
        // Symlink to the pinned image.
        let link = bin.join("link");
        std::os::unix::fs::symlink(&good, &link).unwrap();
        assert_eq!(start_code(&link, &sha, bad_profile()), integrity);
        // Symlinked directory on the way.
        let dir_link = root.path().join("bin-link");
        std::os::unix::fs::symlink(&bin, &dir_link).unwrap();
        assert_eq!(start_code(&dir_link.join("chrome-headless-shell"), &sha, bad_profile()), integrity);
        // `..` in the path.
        assert_eq!(
            start_code(&bin.join("..").join("bin").join("chrome-headless-shell"), &sha, bad_profile()),
            integrity
        );
        // Hard link: both names refused while nlink > 1.
        let hard = bin.join("hard");
        fs::hard_link(&good, &hard).unwrap();
        assert_eq!(start_code(&hard, &sha, bad_profile()), integrity);
        assert_eq!(start_code(&good, &sha, bad_profile()), integrity);
        fs::remove_file(&hard).unwrap();
        assert_eq!(start_code(&good, &sha, bad_profile()), "agent-browser-profile-invalid");
        // Group/other-writable, set-id or non-executable image.
        for mode in [0o775, 0o757, 0o4755, 0o2755, 0o644] {
            fs::set_permissions(&good, fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(start_code(&good, &sha, bad_profile()), integrity, "{mode:o}");
        }
        fs::set_permissions(&good, fs::Permissions::from_mode(0o755)).unwrap();
        // Group-writable directory holding the image.
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o775)).unwrap();
        assert_eq!(start_code(&good, &sha, bad_profile()), integrity);
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        // Extended attribute on the image (file capabilities, labels, ACLs).
        let attributed = synthetic_engine(&bin, "attributed", 0o755);
        set_synthetic_xattr(&attributed);
        assert_eq!(start_code(&attributed, &sha, bad_profile()), integrity);
        // A swapped image (another binary renamed over the name) fails the pin.
        let other = bin.join("other");
        fs::write(&other, b"\x7fELF synthetic swapped image").unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o755)).unwrap();
        fs::rename(&other, &good).unwrap();
        assert_eq!(start_code(&good, &sha, bad_profile()), integrity);
        // Swapped after the check: the name no longer is the verified object.
        let fresh = synthetic_engine(&bin, "fresh", 0o755);
        let fresh_sha = sha256_file(&fresh).unwrap();
        let verified = open_verified_engine(&fresh, &fresh_sha).expect("baseline verifies");
        assert!(verified.directory.verify_named(&verified.name, &verified.file).is_ok());
        let replacement = synthetic_engine(&bin, "replacement", 0o755);
        fs::rename(&replacement, &fresh).unwrap();
        assert!(verified.directory.verify_named(&verified.name, &verified.file).is_err());
        // Missing engine.
        assert_eq!(start_code(&bin.join("missing"), &sha, bad_profile()), integrity);
        assert!(fs::read_dir(&stale).unwrap().count() == 1);
    }

    #[test]
    fn linux_engine_attack_profile_path_escapes_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let bin = private_dir(&root.path().join("bin"));
        let engine = synthetic_engine(&bin, "chrome-headless-shell", 0o755);
        let sha = sha256_file(&engine).unwrap();
        let invalid = "agent-browser-profile-invalid";
        let target = private_dir(&root.path().join("target"));
        // `..` and `.` components, even when they resolve to a valid empty dir.
        let base = private_dir(&root.path().join("base"));
        assert_eq!(start_code(&engine, &sha, base.join("..").join("target")), invalid);
        assert_eq!(start_code(&engine, &sha, base.join(".").join("..").join("target")), invalid);
        // A symlinked ancestor.
        let real_parent = private_dir(&root.path().join("real-parent"));
        let escaped = private_dir(&real_parent.join("profile"));
        let parent_link = root.path().join("parent-link");
        std::os::unix::fs::symlink(&real_parent, &parent_link).unwrap();
        assert_eq!(start_code(&engine, &sha, parent_link.join("profile")), invalid);
        // A group-writable ancestor.
        let shared = private_dir(&root.path().join("shared"));
        let under_shared = private_dir(&shared.join("profile"));
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o770)).unwrap();
        assert_eq!(start_code(&engine, &sha, under_shared.clone()), invalid);
        // An attributed profile directory.
        let attributed = private_dir(&root.path().join("attributed"));
        set_synthetic_xattr(&attributed);
        assert_eq!(start_code(&engine, &sha, attributed.clone()), invalid);
        // Relative and missing.
        assert_eq!(start_code(&engine, &sha, PathBuf::from("profile")), invalid);
        assert_eq!(start_code(&engine, &sha, root.path().join("missing")), invalid);
        // Nothing was created in any target.
        for directory in [&target, &escaped, &under_shared, &attributed] {
            assert!(fs::read_dir(directory).unwrap().next().is_none(), "{}", directory.display());
        }
    }

    #[test]
    fn linux_engine_attack_switch_injection_is_refused_and_absent_from_the_running_tree() {
        let profile = Path::new("/tmp/LuckyRay/AgentBrowser/v1/synthetic/chrome");
        for injected in [
            "--no-sandbox",
            "-no-sandbox",
            "--no-sandbox=1",
            "--remote-debugging-port=9222",
            "-remote-debugging-port=0",
            "--remote-debugging-address=0.0.0.0",
            "--remote-allow-origins=*",
            "--disable-web-security",
            "--single-process",
            "--no-zygote",
            "--user-data-dir=/tmp/LuckyRay/AgentBrowser/v1/synthetic/chrome/../other",
            "-user-data-dir=/tmp/other",
            "--load-extension=/tmp/synthetic",
        ] {
            assert!(argument_is_forbidden(injected, profile), "{injected}");
        }
        for allowed in ["--remote-debugging-pipe", "about:blank", "--disable-sync", "no-sandbox"] {
            assert!(!argument_is_forbidden(allowed, profile), "{allowed}");
        }

        // The real engine tree: no process carries a forbidden switch, the
        // environment is the cleared allowlist, and nothing listens on TCP.
        let fixture = Fixture::start(HashMap::from([("/", page("<title>Tree</title>"))]));
        let running = start_engine(&fixture);
        let engine = &running.engine;
        assert_eq!(load(engine, &format!("{}/", fixture.origin())).status, "loaded");
        let browser = engine.browser_pid();
        let mut tree = vec![browser];
        let mut index = 0;
        while index < tree.len() {
            let parent = tree[index];
            for entry in fs::read_dir("/proc").unwrap().flatten() {
                let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
                let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else { continue };
                let Some(rest) = stat.rfind(')').map(|at| &stat[at + 1..]) else { continue };
                if rest.split_whitespace().nth(1).and_then(|v| v.parse::<u32>().ok()) == Some(parent)
                    && !tree.contains(&pid)
                {
                    tree.push(pid);
                }
            }
            index += 1;
        }
        assert!(tree.len() >= 2, "the engine runs renderers");
        let allowed_env = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "PATH", "LANG"];
        let user_data = format!("--user-data-dir={}", running._root.path().join("profile").canonicalize().unwrap().join("chrome").display());
        for pid in &tree {
            let Ok(cmdline) = fs::read(format!("/proc/{pid}/cmdline")) else { continue };
            for argument in cmdline.split(|byte| *byte == 0).filter(|a| !a.is_empty()) {
                let argument = String::from_utf8_lossy(argument);
                if argument == user_data {
                    continue;
                }
                assert!(
                    !argument_is_forbidden(&argument, Path::new("/nonexistent")),
                    "pid {pid}: {argument}"
                );
            }
            if *pid == browser {
                let environ = fs::read(format!("/proc/{pid}/environ")).unwrap();
                for pair in environ.split(|byte| *byte == 0).filter(|p| !p.is_empty()) {
                    let key = String::from_utf8_lossy(pair.split(|b| *b == b'=').next().unwrap()).into_owned();
                    assert!(allowed_env.contains(&key.as_str()), "engine env {key}");
                }
                let exe = fs::read_link(format!("/proc/{pid}/exe")).unwrap();
                assert_eq!(exe, pinned_shell().canonicalize().unwrap());
            }
        }
        assert!(engine_has_no_listening_tcp(Path::new("/proc"), browser));
    }

    #[test]
    fn linux_engine_attack_gateway_bypass_rebinding_workers_downloads_and_permissions_are_blocked() {
        let outsider = Fixture::start(HashMap::new());
        let body = r#"<!doctype html><title>Bypass</title>
<img src="http://[::ffff:127.0.0.1]:__PORT__/v4mapped.png">
<img src="http://localhost:__PORT__/rebind.png">
<img src="http://169.254.169.254/latest/meta-data/">
<img src="http://[::1]:__PORT__/v6loopback.png">
<script>
window.__probe = {};
const note = (key) => (value) => { window.__probe[key] = value; };
fetch('http://localhost:__PORT__/rebind-fetch').then(r => note('rebind')(r.status), () => note('rebind')('error'));
fetch('http://[::ffff:127.0.0.1]:__PORT__/v4mapped-fetch').then(r => note('mapped')(r.status), () => note('mapped')('error'));
fetch('/to-metadata').then(r => r.text()).then(note('metadata'), () => note('metadata')('error'));
fetch('/to-outsider').then(r => r.text()).then(note('outsider'), () => note('outsider')('error'));
try { new EventSource('http://localhost:__PORT__/events').onerror = () => note('events')('error'); } catch (e) { note('events')('throw'); }
if (navigator.serviceWorker) {
  navigator.serviceWorker.register('/sw.js').then(() => note('sw')('registered'), () => note('sw')('refused'));
} else { note('sw')('absent'); }
(typeof Notification === 'undefined' ? Promise.resolve('absent') : Notification.requestPermission())
  .then(note('notification'), () => note('notification')('refused'));
navigator.permissions.query({name: 'geolocation'}).then(s => note('geo')(s.state), () => note('geo')('refused'));
setTimeout(() => note('done')(true), 1500);
</script>"#;
        // Bind first, then serve the page that names its own port.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut routes = HashMap::new();
        routes.insert("/", page(&body.replace("__PORT__", &address.port().to_string())));
        routes.insert("/to-metadata", (302, "text/plain", String::new(), Some("http://169.254.169.254/latest/meta-data/".to_owned())));
        routes.insert("/to-outsider", (302, "text/plain", String::new(), Some(format!("{}/redirected", outsider.origin()))));
        routes.insert("/sw.js", (200, "text/javascript", "self.addEventListener('fetch', () => {});".to_owned(), None));
        routes.insert("/download", (200, "application/octet-stream", "synthetic-download-body".to_owned(), None));
        let fixture = Fixture::serve_on(listener, routes);
        let running = start_engine(&fixture);
        let engine = &running.engine;
        assert_eq!(load(engine, &format!("{}/", fixture.origin())).status, "loaded");
        assert!(wait_until(|| {
            engine
                .probe("JSON.stringify(window.__probe)")
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .is_some_and(|value| value.contains("\"done\""))
        }));
        std::thread::sleep(Duration::from_millis(500));
        let probe = engine.probe("window.__probe").unwrap();
        for key in ["rebind", "mapped"] {
            assert_ne!(probe[key], 200, "{key}: {probe}");
        }
        assert_ne!(probe["metadata"], Value::Null, "{probe}");
        assert!(!probe["metadata"].as_str().unwrap_or("").contains("meta-data"), "{probe}");
        assert_ne!(probe["sw"], "registered", "{probe}");
        assert_eq!(fixture.hits_for("/sw.js"), 0, "a worker script never reaches a server");
        assert_ne!(probe["notification"], "granted", "{probe}");
        assert_ne!(probe["geo"], "granted", "{probe}");
        // Loopback by another name, a v4-mapped or v6 literal, a redirect to
        // another origin or the metadata address: none reached a server.
        for path in ["/v4mapped.png", "/rebind.png", "/v6loopback.png", "/rebind-fetch", "/v4mapped-fetch", "/events"] {
            assert_eq!(fixture.hits_for(path), 0, "{path}");
        }
        assert_eq!(outsider.connections.load(Ordering::Acquire), 0);
        // A download link clicked by the page: denied or cancelled, and no
        // file with the synthetic name lands anywhere in the profile.
        let _ = engine.probe(
            "(() => { const a = document.createElement('a'); a.href = '/download'; \
             a.download = 'synthetic.bin'; document.body.appendChild(a); a.click(); return 1; })()",
        );
        std::thread::sleep(Duration::from_millis(1500));
        let mut stack = vec![running._root.path().to_owned()];
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(&directory).into_iter().flatten().flatten() {
                let kind = entry.file_type().unwrap();
                if kind.is_dir() {
                    stack.push(entry.path());
                } else if kind.is_file() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    assert!(!name.contains("synthetic.bin") && !name.ends_with(".crdownload"), "{name}");
                }
            }
        }
        // The download click is a page-initiated navigation: it is either
        // ignored or cancelled (fail closed), never followed.
        let snapshot = engine.snapshot();
        assert!(
            snapshot.status == "loaded"
                || snapshot.title.as_deref() == Some("agent-browser-navigation-denied"),
            "{snapshot:?}"
        );
        assert!(engine_has_no_listening_tcp(Path::new("/proc"), engine.browser_pid()));
    }

    #[test]
    fn linux_engine_attack_oversized_or_malformed_cdp_input_fails_closed() {
        // Exactly at the cap is accepted, one byte over is refused, and a
        // stream that never terminates its frame is refused at the cap.
        let mut at_cap = vec![b'a'; MAX_CDP_MESSAGE_BYTES];
        at_cap.push(0);
        let mut frames = FrameReader::new(std::io::Cursor::new(at_cap));
        assert_eq!(frames.next_frame().unwrap().unwrap().len(), MAX_CDP_MESSAGE_BYTES);
        let mut over = vec![b'a'; MAX_CDP_MESSAGE_BYTES + 1];
        over.push(0);
        assert!(FrameReader::new(std::io::Cursor::new(over)).next_frame().is_err());
        struct Endless;
        impl Read for Endless {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                buffer.fill(b'a');
                Ok(buffer.len())
            }
        }
        assert!(FrameReader::new(Endless).next_frame().is_err());
    }
}
