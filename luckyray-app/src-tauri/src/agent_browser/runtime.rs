use super::gateway::{GatewayPolicy, ValidatingGateway};
use crate::owned_process::{spawn_in_owned_job, AtomicSpawn, OwnedJob, OwnedProcess};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(test)]
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: u32 = 1;
const FRAME_MAX_BYTES: usize = 64 * 1024;
const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const DOM_SETTLE_TIMEOUT: Duration = Duration::from_millis(5_000);
const DOM_SETTLE_MINIMUM: Duration = Duration::from_millis(2_000);
const DOM_SETTLE_QUIET: Duration = Duration::from_millis(700);
const DOM_SETTLE_POLL: Duration = Duration::from_millis(100);
const MAX_SCOPES: usize = 16;
const MAX_NAVIGATION_REFS: usize = 32;
#[cfg(test)]
const SOURCE_DOMAIN: &[u8] = b"luckyray-agent-browser-source-v1\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentBrowserError {
    pub(crate) code: &'static str,
}

impl AgentBrowserError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

#[derive(Clone)]
pub(crate) struct AgentBrowserRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    host_path: PathBuf,
    gateway_mode: GatewayMode,
    state: Mutex<RuntimeState>,
}

#[derive(Clone, Copy)]
enum GatewayMode {
    Production,
    #[cfg(test)]
    ExactLoopback(SocketAddr),
}

#[derive(Default)]
struct RuntimeState {
    scopes: HashMap<[u8; 32], BrowserScope>,
}

struct BrowserScope {
    active: bool,
    deadline: Instant,
    navigation_refs: HashMap<String, String>,
    browser_refs: HashMap<String, u64>,
    navigation_generation: u64,
    host: Option<Arc<Mutex<AgentHost>>>,
    cancel_job: Option<Arc<OwnedJob>>,
    operation_in_flight: bool,
    surface: Option<AgentBrowserSurface>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBrowserViewport {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    visible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AgentBrowserSurface {
    parent_window: isize,
    viewport: AgentBrowserViewport,
}

impl AgentBrowserViewport {
    fn hidden() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            visible: false,
        }
    }

    fn valid(&self) -> bool {
        self.x >= 0
            && self.y >= 0
            && (1..=16_384).contains(&self.width)
            && (1..=16_384).contains(&self.height)
            && self
                .x
                .checked_add(self.width)
                .is_some_and(|value| value <= 32_768)
            && self
                .y
                .checked_add(self.height)
                .is_some_and(|value| value <= 32_768)
    }
}

pub(crate) struct AgentBrowserScopeLease {
    runtime: Weak<RuntimeInner>,
    scope: [u8; 32],
}

impl Drop for AgentBrowserScopeLease {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.upgrade() {
            runtime.cancel_scope(self.scope);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostResponse {
    version: u32,
    id: String,
    event: String,
    #[serde(rename = "phase")]
    _phase: String,
    code: String,
    challenge: Option<String>,
    session_nonce: Option<String>,
    status: String,
    origin: Option<String>,
    document_token: Option<String>,
    title: Option<String>,
    #[serde(rename = "canGoBack")]
    _can_go_back: bool,
    #[serde(rename = "canGoForward")]
    _can_go_forward: bool,
    generation: u64,
    control_mode: String,
    agent_automation: String,
    network_isolation: String,
    private_subresource_prevention: String,
    result: Option<Value>,
}

struct AgentHost {
    stdin: fs::File,
    responses: mpsc::Receiver<Result<HostResponse, ()>>,
    _reader: std::thread::JoinHandle<()>,
    _stderr: std::thread::JoinHandle<()>,
    process: OwnedProcess,
    job: Arc<OwnedJob>,
    _gateway: ValidatingGateway,
    profile: PathBuf,
    nonce: String,
    generation: u64,
    sequence: u64,
}

impl AgentBrowserRuntime {
    pub(crate) fn initialize() -> Result<Self, AgentBrowserError> {
        let host_path = crate::browser_broker::exact_browser_host_path()
            .map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
        Ok(Self {
            inner: Arc::new(RuntimeInner {
                host_path,
                gateway_mode: GatewayMode::Production,
                state: Mutex::new(RuntimeState::default()),
            }),
        })
    }

    pub(crate) fn unavailable() -> Self {
        Self {
            inner: Arc::new(RuntimeInner {
                host_path: PathBuf::new(),
                gateway_mode: GatewayMode::Production,
                state: Mutex::new(RuntimeState::default()),
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn exact_loopback_for_test(origin: SocketAddr) -> Result<Self, AgentBrowserError> {
        let host_path = crate::browser_broker::exact_browser_host_path()
            .map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
        Ok(Self {
            inner: Arc::new(RuntimeInner {
                host_path,
                gateway_mode: GatewayMode::ExactLoopback(origin),
                state: Mutex::new(RuntimeState::default()),
            }),
        })
    }

    pub(crate) fn bind_scope(
        &self,
        scope: [u8; 32],
        deadline: Instant,
    ) -> Result<AgentBrowserScopeLease, AgentBrowserError> {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state
            .scopes
            .retain(|_, item| item.active && item.deadline > Instant::now());
        if state.scopes.len() >= MAX_SCOPES || state.scopes.contains_key(&scope) {
            return Err(AgentBrowserError::new("agent-browser-busy"));
        }
        state.scopes.insert(
            scope,
            BrowserScope {
                active: true,
                deadline,
                navigation_refs: HashMap::new(),
                browser_refs: HashMap::new(),
                navigation_generation: 0,
                host: None,
                cancel_job: None,
                operation_in_flight: false,
                surface: None,
            },
        );
        Ok(AgentBrowserScopeLease {
            runtime: Arc::downgrade(&self.inner),
            scope,
        })
    }

    pub(crate) fn register_surface(
        &self,
        scope: [u8; 32],
        parent_window: isize,
    ) -> Result<(), AgentBrowserError> {
        if parent_window == 0 {
            return Err(AgentBrowserError::new("agent-browser-surface-invalid"));
        }
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = active_scope(&mut state, scope)?;
        if item.host.is_some() || item.surface.is_some() {
            return Err(AgentBrowserError::new("agent-browser-surface-invalid"));
        }
        item.surface = Some(AgentBrowserSurface {
            parent_window,
            viewport: AgentBrowserViewport::hidden(),
        });
        Ok(())
    }

    pub(crate) fn set_surface(
        &self,
        scope: [u8; 32],
        parent_window: isize,
        viewport: AgentBrowserViewport,
    ) -> Result<(), AgentBrowserError> {
        if parent_window == 0 || !viewport.valid() {
            return Err(AgentBrowserError::new("agent-browser-surface-invalid"));
        }
        let host = {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let item = active_scope(&mut state, scope)?;
            let surface = item
                .surface
                .as_mut()
                .ok_or_else(|| AgentBrowserError::new("agent-browser-surface-invalid"))?;
            if surface.parent_window != parent_window {
                return Err(AgentBrowserError::new("agent-browser-surface-invalid"));
            }
            surface.viewport = viewport.clone();
            item.host.clone()
        };
        if let Some(host) = host {
            host.lock()
                .unwrap_or_else(|error| error.into_inner())
                .command(
                    "set-viewport",
                    json!({"viewport":viewport}),
                    OPERATION_TIMEOUT,
                )?;
        }
        Ok(())
    }

    pub(crate) fn remember_navigation(
        &self,
        scope: [u8; 32],
        raw_url: &str,
    ) -> Result<String, AgentBrowserError> {
        let validated = crate::web_tools::validate_fetch_url(raw_url, cfg!(test))
            .map_err(|_| AgentBrowserError::new("agent-browser-navigation-denied"))?;
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = active_scope(&mut state, scope)?;
        if item.navigation_refs.len() >= MAX_NAVIGATION_REFS {
            return Err(AgentBrowserError::new("agent-browser-capacity"));
        }
        if let Some((reference, _)) = item
            .navigation_refs
            .iter()
            .find(|(_, url)| *url == validated.as_str())
        {
            return Ok(reference.clone());
        }
        let reference = format!("nav-{}", random_token(48));
        item.navigation_refs
            .insert(reference.clone(), validated.to_string());
        Ok(reference)
    }

    pub(crate) fn open(
        &self,
        scope: [u8; 32],
        navigation_ref: &str,
    ) -> Result<Value, AgentBrowserError> {
        let (url, scope_deadline, mut host, mut surface) = {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let item = begin_operation(&mut state, scope)?;
            let url = item
                .navigation_refs
                .get(navigation_ref)
                .cloned()
                .ok_or_else(|| AgentBrowserError::new("agent-browser-reference-invalid"));
            match url {
                Ok(url) => (url, item.deadline, item.host.clone(), item.surface.clone()),
                Err(error) => {
                    item.operation_in_flight = false;
                    return Err(error);
                }
            }
        };

        let result = (|| {
            if host.is_none() {
                let spawned = AgentHost::spawn(
                    &self.inner.host_path,
                    self.inner.gateway_mode,
                    surface.as_ref(),
                )?;
                let cancel_job = Arc::clone(&spawned.job);
                let candidate = Arc::new(Mutex::new(spawned));
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let item = active_scope(&mut state, scope)?;
                if !item.operation_in_flight {
                    return Err(AgentBrowserError::new("agent-browser-terminated"));
                }
                item.cancel_job = Some(cancel_job);
                item.host = Some(Arc::clone(&candidate));
                surface = item.surface.clone();
                host = Some(candidate);
            }
            let host = host.ok_or_else(|| AgentBrowserError::new("agent-browser-unavailable"))?;
            let mut host_guard = host.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(surface) = surface.as_ref() {
                host_guard.command(
                    "set-viewport",
                    json!({"viewport":surface.viewport}),
                    bounded_timeout(OPERATION_TIMEOUT, scope_deadline)?,
                )?;
            }
            host_guard.command(
                "navigate",
                json!({"url":url}),
                bounded_timeout(OPEN_TIMEOUT, scope_deadline)?,
            )?;
            let deadline = (Instant::now() + OPEN_TIMEOUT).min(scope_deadline);
            let response = loop {
                let status = host_guard.command(
                    "status",
                    json!({}),
                    bounded_timeout(OPERATION_TIMEOUT, deadline)?,
                )?;
                if matches!(status.status.as_str(), "loaded" | "error") {
                    break status;
                }
                if Instant::now() >= deadline {
                    return Err(AgentBrowserError::new("agent-browser-timeout"));
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            if response.status != "loaded" {
                return Err(AgentBrowserError::new(safe_navigation_failure_code(
                    response.title.as_deref(),
                )));
            }
            let response = wait_for_dom_settle(&mut host_guard, scope_deadline)?;
            drop(host_guard);
            let host_name = safe_host_from_origin(response.origin.as_deref())?;
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let item = active_scope(&mut state, scope)?;
            if !item
                .host
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &host))
            {
                return Err(AgentBrowserError::new("agent-browser-terminated"));
            }
            item.navigation_generation = item.navigation_generation.saturating_add(1).max(1);
            item.browser_refs.clear();
            let browser_ref = format!("browser-{}", random_token(48));
            item.browser_refs
                .insert(browser_ref.clone(), item.navigation_generation);
            let source_token = response
                .document_token
                .filter(|value| {
                    value.starts_with("src-b-")
                        && value.len() == 70
                        && value[6..].bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| AgentBrowserError::new("agent-browser-invalid-response"))?;
            Ok(
                json!({"browserRef":browser_ref,"state":"ready","host":host_name,"sourceToken":source_token,"sourceKind":"browser"}),
            )
        })();
        self.inner.finish_operation(scope);
        result
    }

    pub(crate) fn read(
        &self,
        scope: [u8; 32],
        browser_ref: &str,
    ) -> Result<Value, AgentBrowserError> {
        self.operation(scope, browser_ref, "read", json!({}))
    }

    pub(crate) fn extract(
        &self,
        scope: [u8; 32],
        browser_ref: &str,
        kind: &str,
        index: Option<u64>,
    ) -> Result<Value, AgentBrowserError> {
        if !matches!(kind, "main" | "article" | "headings" | "links" | "table")
            || kind != "table" && index.is_some()
            || index.is_some_and(|value| value > 15)
        {
            return Err(AgentBrowserError::new("agent-browser-input-invalid"));
        }
        let mut extra = json!({"kind":kind});
        if let Some(index) = index {
            extra["index"] = Value::from(index);
        }
        self.operation(scope, browser_ref, "extract", extra)
    }

    fn operation(
        &self,
        scope: [u8; 32],
        browser_ref: &str,
        command: &str,
        extra: Value,
    ) -> Result<Value, AgentBrowserError> {
        let (host, scope_deadline) = {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let item = begin_operation(&mut state, scope)?;
            let valid =
                item.browser_refs.get(browser_ref).copied() == Some(item.navigation_generation);
            let host = item.host.clone();
            if !valid || host.is_none() {
                item.operation_in_flight = false;
                return Err(AgentBrowserError::new("agent-browser-reference-invalid"));
            }
            (host.expect("checked"), item.deadline)
        };
        let result = (|| {
            let mut host_guard = host.lock().unwrap_or_else(|error| error.into_inner());
            let response = host_guard.command(
                command,
                extra,
                bounded_timeout(OPERATION_TIMEOUT, scope_deadline)?,
            )?;
            drop(host_guard);
            let mut result = response
                .result
                .ok_or_else(|| AgentBrowserError::new("agent-browser-invalid-response"))?;
            if command == "extract" && result.get("kind") == Some(&Value::String("links".into())) {
                if let Some(links) = result.get_mut("items").and_then(Value::as_array_mut) {
                    for link in links {
                        let Some(object) = link.as_object_mut() else {
                            continue;
                        };
                        let Some(raw_url) = object
                            .remove("url")
                            .and_then(|value| value.as_str().map(str::to_owned))
                        else {
                            continue;
                        };
                        let mut state = self
                            .inner
                            .state
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        let item = active_scope(&mut state, scope)?;
                        let navigation_ref = remember_navigation_in_scope(item, &raw_url)?;
                        object.insert("navigationRef".into(), Value::String(navigation_ref));
                    }
                }
            }
            let serialized = serde_json::to_vec(&result)
                .map_err(|_| AgentBrowserError::new("agent-browser-invalid-response"))?;
            if serialized.len() > 60 * 1024
                || serialized
                    .windows(7)
                    .any(|value| value.eq_ignore_ascii_case(b"cookie:"))
            {
                return Err(AgentBrowserError::new("agent-browser-output-too-large"));
            }
            Ok(result)
        })();
        self.inner.finish_operation(scope);
        result
    }

    pub(crate) fn cancel_scope(&self, scope: [u8; 32]) {
        self.inner.cancel_scope(scope);
    }

    pub(crate) fn scope_ready(&self, scope: [u8; 32]) -> bool {
        if !self.inner.host_path.is_file() {
            return false;
        }
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state
            .scopes
            .get(&scope)
            .is_some_and(|item| item.active && item.deadline > Instant::now())
    }

    #[cfg(test)]
    pub(crate) fn retained_scope_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .scopes
            .len()
    }
}

fn wait_for_dom_settle(
    host: &mut AgentHost,
    scope_deadline: Instant,
) -> Result<HostResponse, AgentBrowserError> {
    let started = Instant::now();
    let deadline = (started + DOM_SETTLE_TIMEOUT).min(scope_deadline);
    let mut last_digest = None;
    let mut last_change = started;
    let mut last_response = None;

    loop {
        let now = Instant::now();
        if now >= deadline {
            return last_response.ok_or_else(|| AgentBrowserError::new("agent-browser-timeout"));
        }
        let response = host.command(
            "read",
            json!({}),
            bounded_timeout(OPERATION_TIMEOUT, deadline)?,
        )?;
        let result = response
            .result
            .as_ref()
            .ok_or_else(|| AgentBrowserError::new("agent-browser-invalid-response"))?;
        let serialized = serde_json::to_vec(&result)
            .map_err(|_| AgentBrowserError::new("agent-browser-invalid-response"))?;
        if serialized.len() > 60 * 1024 {
            return Err(AgentBrowserError::new("agent-browser-output-too-large"));
        }
        let digest: [u8; 32] = Sha256::digest(&serialized).into();
        let sampled_at = Instant::now();
        if last_digest != Some(digest) {
            last_digest = Some(digest);
            last_change = sampled_at;
        }
        last_response = Some(response);
        if sampled_at.duration_since(started) >= DOM_SETTLE_MINIMUM
            && sampled_at.duration_since(last_change) >= DOM_SETTLE_QUIET
        {
            return last_response
                .ok_or_else(|| AgentBrowserError::new("agent-browser-invalid-response"));
        }
        if sampled_at >= deadline {
            return last_response.ok_or_else(|| AgentBrowserError::new("agent-browser-timeout"));
        }
        std::thread::sleep(DOM_SETTLE_POLL.min(deadline.saturating_duration_since(sampled_at)));
    }
}

impl RuntimeInner {
    fn cancel_scope(&self, scope: [u8; 32]) {
        let (cancel_job, host) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            match state.scopes.remove(&scope) {
                Some(mut item) => {
                    item.active = false;
                    item.navigation_refs.clear();
                    item.browser_refs.clear();
                    (item.cancel_job.take(), item.host.take())
                }
                None => (None, None),
            }
        };
        if let Some(job) = cancel_job {
            job.terminate();
        }
        drop(host);
    }

    fn finish_operation(&self, scope: [u8; 32]) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(item) = state.scopes.get_mut(&scope) {
            item.operation_in_flight = false;
        }
    }
}

fn active_scope(
    state: &mut RuntimeState,
    scope: [u8; 32],
) -> Result<&mut BrowserScope, AgentBrowserError> {
    let item = state
        .scopes
        .get_mut(&scope)
        .ok_or_else(|| AgentBrowserError::new("agent-browser-scope-required"))?;
    if !item.active || Instant::now() >= item.deadline {
        return Err(AgentBrowserError::new("agent-browser-scope-expired"));
    }
    Ok(item)
}

fn begin_operation(
    state: &mut RuntimeState,
    scope: [u8; 32],
) -> Result<&mut BrowserScope, AgentBrowserError> {
    let item = active_scope(state, scope)?;
    if item.operation_in_flight {
        return Err(AgentBrowserError::new("agent-browser-busy"));
    }
    item.operation_in_flight = true;
    Ok(item)
}

fn bounded_timeout(limit: Duration, deadline: Instant) -> Result<Duration, AgentBrowserError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| AgentBrowserError::new("agent-browser-timeout"))?;
    Ok(limit.min(remaining).max(Duration::from_millis(1)))
}

/// The one launch refusal reported as itself rather than as unavailable: on
/// Linux the engine never runs unsandboxed, and a host that cannot provide the
/// sandbox (the AppImage on Ubuntu with restricted user namespaces) says so.
fn linux_launch_refusal(ready: &HostResponse) -> Option<&'static str> {
    (cfg!(target_os = "linux")
        && ready.version == PROTOCOL_VERSION
        && ready.id == "initialize"
        && ready.event == "session-failed"
        && ready.code == "agent-browser-sandbox-unavailable")
        .then_some("agent-browser-sandbox-unavailable")
}

fn safe_navigation_failure_code(phase: Option<&str>) -> &'static str {
    match phase {
        Some("navigation-timeout") => "agent-browser-navigation-timeout",
        Some(
            "navigation-cannot-connect"
            | "navigation-connection-aborted"
            | "navigation-connection-reset"
            | "navigation-disconnected"
            | "navigation-server-unreachable",
        ) => "agent-browser-connection-failed",
        Some("navigation-invalid-response") => "agent-browser-invalid-response",
        _ => "agent-browser-navigation-failed",
    }
}

fn remember_navigation_in_scope(
    item: &mut BrowserScope,
    raw_url: &str,
) -> Result<String, AgentBrowserError> {
    let validated = crate::web_tools::validate_fetch_url(raw_url, cfg!(test))
        .map_err(|_| AgentBrowserError::new("agent-browser-navigation-denied"))?;
    if item.navigation_refs.len() >= MAX_NAVIGATION_REFS {
        return Err(AgentBrowserError::new("agent-browser-capacity"));
    }
    let reference = format!("nav-{}", random_token(48));
    item.navigation_refs
        .insert(reference.clone(), validated.to_string());
    Ok(reference)
}

impl AgentHost {
    fn spawn(
        host_path: &Path,
        gateway_mode: GatewayMode,
        surface: Option<&AgentBrowserSurface>,
    ) -> Result<Self, AgentBrowserError> {
        if !host_path.is_absolute() || !host_path.is_file() {
            return Err(AgentBrowserError::new("agent-browser-unavailable"));
        }
        // Linux: the sidecar's directory chain must be one no other user can
        // rewrite (no symlinked, group- or other-writable ancestor), so the
        // host cannot be swapped by name. The file itself is then checked and
        // executed by descriptor in `spawn_in_owned_job`.
        #[cfg(target_os = "linux")]
        if host_path
            .parent()
            .map(crate::linux_fs::Directory::trusted)
            .map_or(true, |directory| directory.is_err())
        {
            return Err(AgentBrowserError::new("agent-browser-unavailable"));
        }
        let gateway_policy = match gateway_mode {
            GatewayMode::Production => GatewayPolicy::production(),
            #[cfg(test)]
            GatewayMode::ExactLoopback(origin) => GatewayPolicy::exact_loopback_for_fixture(origin),
        };
        let gateway = ValidatingGateway::start(gateway_policy)
            .map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
        let profile = create_profile_root()?;
        let child_temp = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
        let current_dir = host_path
            .parent()
            .ok_or_else(|| AgentBrowserError::new("agent-browser-unavailable"))?;
        let mut environment = Vec::<(OsString, OsString)>::new();
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            environment.push(("SystemRoot".into(), system_root.clone()));
            environment.push(("WINDIR".into(), system_root.clone()));
            environment.push((
                "PATH".into(),
                PathBuf::from(system_root).join("System32").into_os_string(),
            ));
        }
        environment.push(("TEMP".into(), child_temp.as_os_str().to_owned()));
        environment.push(("TMP".into(), child_temp.as_os_str().to_owned()));
        // Test builds only: the pinned engine unpacked by CI, since the child
        // environment is otherwise cleared. Honoured by fixture hosts alone.
        #[cfg(all(test, target_os = "linux"))]
        if let Some(shell) = std::env::var_os("LUCKYRAY_AGENT_BROWSER_TEST_SHELL") {
            environment.push(("LUCKYRAY_AGENT_BROWSER_TEST_SHELL".into(), shell));
        }
        let launch_args = {
            let value = vec![OsString::from("--agent-readonly")];
            #[cfg(test)]
            {
                let mut value = value;
                if matches!(gateway_mode, GatewayMode::ExactLoopback(_)) {
                    value.push(OsString::from("--test-window-hidden"));
                }
                value
            }
            #[cfg(not(test))]
            {
                value
            }
        };
        let AtomicSpawn {
            process,
            mut stdin,
            stdout,
            stderr,
            job,
        } = spawn_in_owned_job(host_path, &launch_args, current_dir, environment, false)
            .map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
        let job = Arc::new(job);
        let (response_tx, responses) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) => break,
                    Ok(_) if bytes.len() <= FRAME_MAX_BYTES && bytes.last() == Some(&b'\n') => {
                        let value = serde_json::from_slice::<HostResponse>(&bytes).map_err(|_| ());
                        if response_tx.send(value).is_err() {
                            break;
                        }
                    }
                    _ => {
                        let _ = response_tx.send(Err(()));
                        break;
                    }
                }
            }
        });
        let stderr_reader = std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut buffer = [0u8; 4096];
            while stderr.read(&mut buffer).unwrap_or(0) > 0 {
                buffer.fill(0);
            }
        });
        let challenge = random_token(48);
        let initialize = {
            let value = json!({
                "version":PROTOCOL_VERSION,"id":"initialize","command":"initialize","challenge":challenge,
                "agentGatewayPort":gateway.address().port(),"agentGatewayToken":gateway.control_token(),
                "agentProfileRoot":profile.to_string_lossy()
            });
            let mut value = value;
            if let Some(surface) = surface {
                value["embedParentWindow"] = Value::from(surface.parent_window as i64);
                value["embedViewport"] = json!(surface.viewport);
            }
            #[cfg(test)]
            {
                if let GatewayMode::ExactLoopback(origin) = gateway_mode {
                    value["testFixtureHidden"] = Value::Bool(true);
                    value["testFixturePort"] = Value::from(origin.port());
                    value["testFixtureId"] = Value::String("agent-browser-runtime-fixture".into());
                }
                value
            }
            #[cfg(not(test))]
            {
                value
            }
        };
        if let Err(error) = write_frame(&mut stdin, &initialize) {
            return fail_agent_host_launch(&process, &job, &profile, reader, stderr_reader, error);
        }
        let ready = match responses.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(ready)) => ready,
            _ => {
                return fail_agent_host_launch(
                    &process,
                    &job,
                    &profile,
                    reader,
                    stderr_reader,
                    AgentBrowserError::new("agent-browser-unavailable"),
                )
            }
        };
        let ready_failure = linux_launch_refusal(&ready);
        if ready.version != PROTOCOL_VERSION
            || ready.id != "initialize"
            || ready.event != "session-ready"
            || ready.code != "ok"
            || ready.challenge.as_deref() != Some(challenge.as_str())
            || ready.control_mode != "agent-readonly"
            || ready.network_isolation != "parent-gateway"
            || ready.private_subresource_prevention != "enforced"
            || ready.agent_automation != "read-only"
        {
            return fail_agent_host_launch(
                &process,
                &job,
                &profile,
                reader,
                stderr_reader,
                AgentBrowserError::new(ready_failure.unwrap_or("agent-browser-unavailable")),
            );
        }
        let Some(nonce) = ready.session_nonce.filter(|value| valid_token(value, 96)) else {
            return fail_agent_host_launch(
                &process,
                &job,
                &profile,
                reader,
                stderr_reader,
                AgentBrowserError::new("agent-browser-unavailable"),
            );
        };
        Ok(Self {
            stdin,
            responses,
            _reader: reader,
            _stderr: stderr_reader,
            process,
            job,
            _gateway: gateway,
            profile,
            nonce,
            generation: ready.generation,
            sequence: 0,
        })
    }

    fn command(
        &mut self,
        command: &str,
        extra: Value,
        timeout: Duration,
    ) -> Result<HostResponse, AgentBrowserError> {
        if !self.process.is_running() {
            return Err(AgentBrowserError::new("agent-browser-terminated"));
        }
        self.sequence = self.sequence.saturating_add(1);
        let id = format!("agent-{}", self.sequence);
        let mut value = json!({"version":PROTOCOL_VERSION,"id":id,"command":command,"sessionNonce":self.nonce,"expectedGeneration":self.generation});
        if let (Some(target), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, item) in extra {
                target.insert(key.clone(), item.clone());
            }
        }
        write_frame(&mut self.stdin, &value)?;
        let response = self
            .responses
            .recv_timeout(timeout)
            .map_err(|_| AgentBrowserError::new("agent-browser-timeout"))?
            .map_err(|_| AgentBrowserError::new("agent-browser-terminated"))?;
        if response.version != PROTOCOL_VERSION || response.id != id || response.code != "ok" {
            return Err(AgentBrowserError::new("agent-browser-operation-failed"));
        }
        self.generation = response.generation;
        Ok(response)
    }
}

impl Drop for AgentHost {
    fn drop(&mut self) {
        let _ = self.command("close", json!({}), Duration::from_secs(2));
        // The controller can finish its protocol close before every WebView2
        // subprocess has released the profile.  The Job contains only this
        // owned browser tree, so always close that final process boundary
        // before removing the ephemeral directory.
        self.job.terminate();
        let _ = self.process.wait_for(Duration::from_secs(2));
        remove_profile_dir(&self.profile);
    }
}

fn fail_agent_host_launch(
    process: &OwnedProcess,
    job: &Arc<OwnedJob>,
    profile: &Path,
    reader: std::thread::JoinHandle<()>,
    stderr_reader: std::thread::JoinHandle<()>,
    error: AgentBrowserError,
) -> Result<AgentHost, AgentBrowserError> {
    job.terminate();
    let _ = process.wait_for(Duration::from_secs(2));
    let _ = reader.join();
    let _ = stderr_reader.join();
    remove_profile_dir(profile);
    Err(error)
}

fn create_profile_root() -> Result<PathBuf, AgentBrowserError> {
    let base = std::env::temp_dir()
        .join("LuckyRay")
        .join("AgentBrowser")
        .join("v1");
    fs::create_dir_all(&base).map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
    let base = base
        .canonicalize()
        .map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
    #[cfg(target_os = "linux")]
    restrict_linux_profile_base(&base)?;
    cleanup_stale_profiles(&base);
    let profile = base.join(format!("session-{}", random_token(32)));
    #[cfg(not(target_os = "linux"))]
    fs::create_dir(&profile).map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&profile)
            .map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
    }
    let metadata = fs::symlink_metadata(&profile)
        .map_err(|_| AgentBrowserError::new("agent-browser-unavailable"))?;
    if metadata.file_type().is_symlink()
        || !profile
            .canonicalize()
            .map(|value| value.starts_with(&base))
            .unwrap_or(false)
    {
        return Err(AgentBrowserError::new("agent-browser-unavailable"));
    }
    Ok(profile)
}

/// The shared temp directory is world-writable: the LuckyRay/AgentBrowser/v1
/// chain must be ours and closed to others before a profile goes inside it.
#[cfg(target_os = "linux")]
fn restrict_linux_profile_base(base: &Path) -> Result<(), AgentBrowserError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let unavailable = || AgentBrowserError::new("agent-browser-unavailable");
    let euid = unsafe { libc::geteuid() };
    let mut directory = base.to_path_buf();
    for _ in 0..3 {
        let metadata = fs::symlink_metadata(&directory).map_err(|_| unavailable())?;
        if !metadata.file_type().is_dir() || metadata.uid() != euid {
            return Err(unavailable());
        }
        if metadata.mode() & 0o077 != 0 {
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| unavailable())?;
        }
        directory = directory.parent().ok_or_else(unavailable)?.to_path_buf();
    }
    Ok(())
}

fn cleanup_stale_profiles(base: &Path) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten().take(8) {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                continue;
            }
        }
        if !entry.file_name().to_string_lossy().starts_with("session-")
            || metadata
                .modified()
                .ok()
                .and_then(|value| value.elapsed().ok())
                < Some(Duration::from_secs(24 * 60 * 60))
            || !path
                .canonicalize()
                .map(|value| value.starts_with(base))
                .unwrap_or(false)
        {
            continue;
        }
        remove_profile_dir(&path);
    }
}

fn remove_profile_dir(profile: &Path) {
    for _ in 0..40 {
        if fs::remove_dir_all(profile).is_ok() || !profile.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn write_frame(writer: &mut fs::File, value: &Value) -> Result<(), AgentBrowserError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| AgentBrowserError::new("agent-browser-protocol-invalid"))?;
    if bytes.len() > FRAME_MAX_BYTES {
        return Err(AgentBrowserError::new("agent-browser-protocol-invalid"));
    }
    writer
        .write_all(&bytes)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|_| AgentBrowserError::new("agent-browser-terminated"))
}

fn safe_host_from_origin(origin: Option<&str>) -> Result<String, AgentBrowserError> {
    let origin = origin.ok_or_else(|| AgentBrowserError::new("agent-browser-invalid-response"))?;
    let url = reqwest::Url::parse(origin)
        .map_err(|_| AgentBrowserError::new("agent-browser-invalid-response"))?;
    let host = url
        .host_str()
        .ok_or_else(|| AgentBrowserError::new("agent-browser-invalid-response"))?;
    if host.is_empty()
        || host.len() > 253
        || !host.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']')
        })
    {
        return Err(AgentBrowserError::new("agent-browser-invalid-response"));
    }
    Ok(host.to_ascii_lowercase())
}

#[cfg(test)]
fn browser_source_token(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SOURCE_DOMAIN);
    hasher.update(url.as_bytes());
    format!("src-b-{:x}", hasher.finalize())
}

fn random_token(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn valid_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_agent_host_refuses_a_host_that_is_not_an_executable_sidecar() {
        let root = tempfile::tempdir().unwrap();
        let host = root.path().join("synthetic-host");
        fs::write(&host, b"synthetic").unwrap();
        let result = AgentHost::spawn(&host, GatewayMode::Production, None);
        assert_eq!(result.err().map(|error| error.code), Some("agent-browser-unavailable"));
        assert!(AgentHost::spawn(Path::new("relative-host"), GatewayMode::Production, None).is_err());
        assert!(AgentHost::spawn(root.path(), GatewayMode::Production, None).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        assert_eq!(fs::read(host).unwrap(), b"synthetic");
    }

    /// T55 slice 5: a linked, writable, attributed, set-id or swapped
    /// sidecar, or one in an unsafe directory, is refused before it runs.
    /// The same copy in a clean directory starts, so each refusal is due to
    /// the one attribute under test.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_agent_host_attack_refuses_a_linked_writable_attributed_or_swapped_host() {
        use std::os::unix::fs::PermissionsExt;
        let sidecar = crate::browser_broker::exact_browser_host_path().unwrap();
        let address = serve_linux_synthetic_page();
        let root = tempfile::tempdir().unwrap();
        let private = |path: PathBuf| {
            fs::create_dir_all(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        };
        let bin = private(root.path().join("bin"));
        let good = bin.join("luckyray-browser-host");
        fs::copy(&sidecar, &good).unwrap();
        fs::set_permissions(&good, fs::Permissions::from_mode(0o755)).unwrap();
        let spawn = |path: &Path| AgentHost::spawn(path, GatewayMode::ExactLoopback(address), None);
        let refused = |path: &Path, case: &str| {
            assert_eq!(
                spawn(path).err().map(|error| error.code),
                Some("agent-browser-unavailable"),
                "{case}"
            );
        };
        drop(spawn(&good).expect("the clean copy starts"));

        let link = bin.join("link");
        std::os::unix::fs::symlink(&good, &link).unwrap();
        refused(&link, "symlinked host");
        let bin_link = root.path().join("bin-link");
        std::os::unix::fs::symlink(&bin, &bin_link).unwrap();
        refused(&bin_link.join("luckyray-browser-host"), "symlinked directory");
        let hard = bin.join("hard");
        fs::hard_link(&good, &hard).unwrap();
        refused(&hard, "hard link");
        refused(&good, "hard-linked original");
        fs::remove_file(&hard).unwrap();
        for mode in [0o775, 0o757, 0o4755, 0o2755, 0o644] {
            fs::set_permissions(&good, fs::Permissions::from_mode(mode)).unwrap();
            refused(&good, &format!("mode {mode:o}"));
        }
        fs::set_permissions(&good, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o775)).unwrap();
        refused(&good, "group-writable directory");
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        let attributed = bin.join("attributed");
        fs::copy(&good, &attributed).unwrap();
        let name = std::ffi::CString::new(attributed.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(
            unsafe { libc::setxattr(name.as_ptr(), c"user.luckyray-synthetic".as_ptr(), b"1".as_ptr().cast(), 1, 0) },
            0
        );
        refused(&attributed, "extended attribute");
        // Swapped for a non-ELF image under the same name.
        let swapped = bin.join("swapped");
        fs::write(&swapped, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&swapped, fs::Permissions::from_mode(0o755)).unwrap();
        fs::rename(&swapped, &good).unwrap();
        refused(&good, "swapped image");
        // `..` in the path is refused even when it resolves to the copy.
        let clean = private(root.path().join("clean"));
        fs::copy(&sidecar, clean.join("luckyray-browser-host")).unwrap();
        fs::set_permissions(clean.join("luckyray-browser-host"), fs::Permissions::from_mode(0o755)).unwrap();
        refused(&bin.join("..").join("clean").join("luckyray-browser-host"), "dot-dot path");
        drop(spawn(&clean.join("luckyray-browser-host")).expect("the clean copy still starts"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_agent_launch_refusal_reports_only_the_sandbox_code() {
        let response = |event: &str, code: &str| -> HostResponse {
            serde_json::from_value(json!({
                "version": PROTOCOL_VERSION, "id": "initialize", "event": event,
                "phase": "sandbox-userns-restricted", "code": code, "challenge": null,
                "sessionNonce": null, "status": "idle", "origin": null,
                "documentToken": null, "title": null, "canGoBack": false,
                "canGoForward": false, "generation": 0, "controlMode": "agent-readonly",
                "agentAutomation": "read-only", "networkIsolation": "parent-gateway",
                "privateSubresourcePrevention": "enforced", "result": null
            }))
            .unwrap()
        };
        assert_eq!(
            linux_launch_refusal(&response("session-failed", "agent-browser-sandbox-unavailable")),
            Some("agent-browser-sandbox-unavailable")
        );
        for (event, code) in [
            ("session-failed", "agent-browser-engine-unavailable"),
            ("session-failed", "agent-browser-engine-integrity"),
            ("session-ready", "agent-browser-sandbox-unavailable"),
        ] {
            assert_eq!(linux_launch_refusal(&response(event, code)), None);
        }
    }

    #[cfg(target_os = "linux")]
    const LINUX_SYNTHETIC_PAGE: &str = "<!doctype html><html><head><title>Synthetic Linux Agent Page</title></head><body><main><h1>Synthetic Linux heading</h1><p>synthetic rendered body for the Linux agent browser</p><a href=\"/next\">Synthetic next page</a></main></body></html>";

    /// Serves one synthetic page on loopback; everything else is 404.
    #[cfg(target_os = "linux")]
    fn serve_linux_synthetic_page() -> SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut request = Vec::new();
                let mut buffer = [0u8; 2048];
                while !request.windows(4).any(|value| value == b"\r\n\r\n") && request.len() < 16384 {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buffer[..read]),
                    }
                }
                let response = if request.starts_with(b"GET /article ") {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{LINUX_SYNTHETIC_PAGE}",
                        LINUX_SYNTHETIC_PAGE.len()
                    )
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
                };
                let _ = stream.write_all(response.as_bytes());
            }
        });
        address
    }

    /// (pid, state, ppid, pgrp) for every process visible in /proc.
    #[cfg(target_os = "linux")]
    fn linux_processes() -> Vec<(i32, char, i32, i32)> {
        let mut processes = Vec::new();
        for entry in fs::read_dir("/proc").unwrap().flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let Some(rest) = stat.rfind(')').map(|index| &stat[index + 1..]) else {
                continue;
            };
            let fields: Vec<&str> = rest.split_whitespace().collect();
            if fields.len() < 3 {
                continue;
            }
            let state = fields[0].chars().next().unwrap_or('?');
            let (Ok(ppid), Ok(pgrp)) = (fields[1].parse(), fields[2].parse()) else {
                continue;
            };
            processes.push((pid, state, ppid, pgrp));
        }
        processes
    }

    /// The engine is the sidecar's child that leads its own process group.
    #[cfg(target_os = "linux")]
    fn linux_engine_group(sidecar: u32) -> Option<i32> {
        linux_processes()
            .into_iter()
            .find(|(pid, state, ppid, pgrp)| *ppid == sidecar as i32 && pid == pgrp && *state != 'Z')
            .map(|(pid, ..)| pid)
    }

    #[cfg(target_os = "linux")]
    fn linux_live_in_group(group: i32) -> usize {
        linux_processes()
            .into_iter()
            .filter(|(_, state, _, pgrp)| *pgrp == group && *state != 'Z')
            .count()
    }

    #[cfg(target_os = "linux")]
    fn linux_wait_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        done()
    }

    /// Opens the synthetic page through the real sidecar, gateway and engine.
    #[cfg(target_os = "linux")]
    fn linux_open_synthetic(
        runtime: &AgentBrowserRuntime,
        scope: [u8; 32],
        address: SocketAddr,
    ) -> (String, u32, PathBuf, i32) {
        assert!(
            std::env::var_os("LUCKYRAY_AGENT_BROWSER_TEST_SHELL").is_some(),
            "LUCKYRAY_AGENT_BROWSER_TEST_SHELL must name the pinned engine"
        );
        let navigation = runtime
            .remember_navigation(scope, &format!("http://{address}/article"))
            .unwrap();
        let opened = runtime.open(scope, &navigation).expect("the Linux agent host opens");
        assert_eq!(opened["state"], "ready");
        assert_eq!(opened["sourceKind"], "browser");
        assert_eq!(opened["host"], "127.0.0.1");
        let browser_ref = opened["browserRef"].as_str().unwrap().to_owned();
        let (sidecar, profile) = {
            let state = runtime.inner.state.lock().unwrap();
            let host = state.scopes.get(&scope).unwrap().host.clone().unwrap();
            let host = host.lock().unwrap();
            (host.process.process_id(), host.profile.clone())
        };
        let group = linux_engine_group(sidecar).expect("the engine runs under the sidecar");
        (browser_ref, sidecar, profile, group)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_agent_host_reads_and_extracts_a_synthetic_loopback_page_through_the_gateway() {
        use std::os::unix::fs::PermissionsExt;
        let address = serve_linux_synthetic_page();
        let runtime = AgentBrowserRuntime::exact_loopback_for_test(address).unwrap();
        let scope = [0x51u8; 32];
        let _lease = runtime
            .bind_scope(scope, Instant::now() + Duration::from_secs(120))
            .unwrap();
        let (browser_ref, _sidecar, profile, group) = linux_open_synthetic(&runtime, scope, address);
        assert_eq!(
            fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let base = profile.parent().unwrap();
        assert_eq!(fs::metadata(base).unwrap().permissions().mode() & 0o077, 0);

        let read = runtime.read(scope, &browser_ref).unwrap();
        assert_eq!(read["kind"], "read");
        assert_eq!(read["title"], "Synthetic Linux Agent Page");
        assert!(read["visibleText"]
            .as_str()
            .unwrap()
            .contains("synthetic rendered body for the Linux agent browser"));
        let headings = runtime.extract(scope, &browser_ref, "headings", None).unwrap();
        assert_eq!(headings["kind"], "headings");
        assert!(headings.to_string().contains("Synthetic Linux heading"));
        let links = runtime.extract(scope, &browser_ref, "links", None).unwrap();
        let items = links["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].get("url").is_none());
        assert!(items[0]["navigationRef"].as_str().unwrap().starts_with("nav-"));
        assert_eq!(
            runtime.extract(scope, &browser_ref, "table", Some(16)).unwrap_err().code,
            "agent-browser-input-invalid"
        );
        assert_eq!(
            runtime
                .read(scope, &format!("browser-{}", "R".repeat(48)))
                .unwrap_err()
                .code,
            "agent-browser-reference-invalid"
        );

        runtime.cancel_scope(scope);
        assert!(linux_wait_until(Duration::from_secs(10), || linux_live_in_group(group) == 0));
        assert!(linux_wait_until(Duration::from_secs(5), || !profile.exists()));
        assert!(!runtime.scope_ready(scope));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_agent_host_death_takes_the_engine_down_and_fails_closed() {
        let address = serve_linux_synthetic_page();
        let runtime = AgentBrowserRuntime::exact_loopback_for_test(address).unwrap();
        let scope = [0x52u8; 32];
        let _lease = runtime
            .bind_scope(scope, Instant::now() + Duration::from_secs(120))
            .unwrap();
        let (browser_ref, sidecar, profile, group) = linux_open_synthetic(&runtime, scope, address);
        assert!(linux_live_in_group(group) >= 2, "engine browser and its helpers");
        // Only the sidecar dies: the engine must follow through its
        // parent-death signal, not through any cleanup in this process.
        assert_eq!(unsafe { libc::kill(sidecar as i32, libc::SIGKILL) }, 0);
        assert!(linux_wait_until(Duration::from_secs(10), || linux_live_in_group(group) == 0));
        assert!(runtime.read(scope, &browser_ref).is_err());
        runtime.cancel_scope(scope);
        assert!(linux_wait_until(Duration::from_secs(5), || !profile.exists()));
    }

    #[test]
    fn navigation_and_browser_refs_are_scope_bound_and_fail_before_host_start() {
        let runtime = AgentBrowserRuntime::unavailable();
        let first = [1u8; 32];
        let second = [2u8; 32];
        let _first_lease = runtime
            .bind_scope(first, Instant::now() + Duration::from_secs(30))
            .unwrap();
        let _second_lease = runtime
            .bind_scope(second, Instant::now() + Duration::from_secs(30))
            .unwrap();
        let reference = runtime
            .remember_navigation(first, "https://example.org/article?PRIVATE=query")
            .unwrap();
        assert_eq!(reference.len(), 52);
        assert_eq!(
            runtime
                .open(first, &format!("nav-{}", "Z".repeat(48)))
                .unwrap_err()
                .code,
            "agent-browser-reference-invalid"
        );
        assert_eq!(
            runtime.open(second, &reference).unwrap_err().code,
            "agent-browser-reference-invalid"
        );
        assert_eq!(
            runtime
                .read(first, &format!("browser-{}", "Y".repeat(48)))
                .unwrap_err()
                .code,
            "agent-browser-reference-invalid"
        );
        runtime.cancel_scope(first);
        assert_eq!(
            runtime.open(first, &reference).unwrap_err().code,
            "agent-browser-scope-required"
        );
        let token = browser_source_token("https://example.org/article?PRIVATE=query");
        assert!(token.starts_with("src-b-") && token.len() == 70);
        assert!(!token.contains("PRIVATE"));
    }

    #[test]
    fn one_scope_allows_only_one_linearized_browser_operation() {
        let runtime = AgentBrowserRuntime::unavailable();
        let scope = [3u8; 32];
        let _lease = runtime
            .bind_scope(scope, Instant::now() + Duration::from_secs(30))
            .unwrap();
        {
            let mut state = runtime
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.scopes.get_mut(&scope).unwrap().operation_in_flight = true;
        }
        assert_eq!(
            runtime
                .read(scope, &format!("browser-{}", "Q".repeat(48)))
                .unwrap_err()
                .code,
            "agent-browser-busy"
        );
        runtime.cancel_scope(scope);
        assert!(!runtime.scope_ready(scope));
    }

    #[test]
    fn visible_surface_is_scope_and_parent_bound_before_host_start() {
        let runtime = AgentBrowserRuntime::unavailable();
        let scope = [4u8; 32];
        let _lease = runtime
            .bind_scope(scope, Instant::now() + Duration::from_secs(30))
            .unwrap();
        runtime.register_surface(scope, 41).unwrap();
        let visible = AgentBrowserViewport {
            x: 12,
            y: 18,
            width: 720,
            height: 480,
            visible: true,
        };
        runtime.set_surface(scope, 41, visible.clone()).unwrap();
        {
            let state = runtime
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert_eq!(
                state.scopes.get(&scope).unwrap().surface,
                Some(AgentBrowserSurface {
                    parent_window: 41,
                    viewport: visible,
                })
            );
        }
        assert_eq!(
            runtime
                .set_surface(
                    scope,
                    42,
                    AgentBrowserViewport {
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1,
                        visible: false,
                    }
                )
                .unwrap_err()
                .code,
            "agent-browser-surface-invalid"
        );
        runtime.cancel_scope(scope);
        assert_eq!(
            runtime
                .set_surface(
                    scope,
                    41,
                    AgentBrowserViewport {
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1,
                        visible: false,
                    }
                )
                .unwrap_err()
                .code,
            "agent-browser-scope-required"
        );
    }

    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "controlled public HTTPS smoke; run explicitly when validating the production Agent Browser host"]
    fn production_host_reads_public_https_through_the_parent_gateway() {
        // This uses the real sidecar, real WebView2, isolated temporary
        // profile, and production validating gateway. It is intentionally
        // ignored in normal CI because it requires public network reachability
        // and a locally installed WebView2 runtime.
        let runtime = AgentBrowserRuntime::initialize().expect("production host path is available");
        let scope = [0x91u8; 32];
        let _lease = runtime
            .bind_scope(scope, Instant::now() + Duration::from_secs(90))
            .expect("scope lease");
        let target = std::env::var("LUCKYRAY_TEST_PUBLIC_HTTPS_URL")
            .unwrap_or_else(|_| "https://example.com/".to_owned());
        let navigation = runtime
            .remember_navigation(scope, &target)
            .expect("public HTTPS navigation is allowed");
        let opened = runtime
            .open(scope, &navigation)
            .expect("production host opens public HTTPS");
        let browser_ref = opened
            .get("browserRef")
            .and_then(Value::as_str)
            .expect("opaque browser ref");
        let read = runtime
            .read(scope, browser_ref)
            .expect("production host reads rendered public HTTPS");
        assert!(
            read.get("visibleText")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty()),
            "public page must yield bounded visible text"
        );
    }
}
