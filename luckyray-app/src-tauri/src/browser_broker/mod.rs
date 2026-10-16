use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

const PROTOCOL_VERSION: u32 = 1;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_EMBEDDED_SESSIONS: usize = 8;

pub(crate) struct BrowserBroker {
    host_path: PathBuf,
    test_fixture_id: Option<String>,
    test_fixture_port: Option<u16>,
    state: Mutex<BrowserProcesses>,
}

#[derive(Default)]
struct BrowserProcesses {
    standalone: Option<HostProcess>,
    embedded: HashMap<String, HostProcess>,
}

impl BrowserProcesses {
    fn host_mut(&mut self, session_id: &str) -> Option<&mut HostProcess> {
        if self
            .standalone
            .as_ref()
            .is_some_and(|host| host.session_id == session_id)
        {
            return self.standalone.as_mut();
        }
        self.embedded.get_mut(session_id)
    }

    fn remove(&mut self, session_id: &str) -> Option<HostProcess> {
        if self
            .standalone
            .as_ref()
            .is_some_and(|host| host.session_id == session_id)
        {
            return self.standalone.take();
        }
        self.embedded.remove(session_id)
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.standalone.is_none() && self.embedded.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersonalBrowserViewport {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub visible: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersonalBrowserStatus {
    pub session_id: String,
    pub status: String,
    pub origin: Option<String>,
    pub title: Option<String>,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub generation: u64,
    pub control_mode: String,
    pub agent_automation: String,
    pub network_isolation: String,
    pub private_subresource_prevention: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostResponse {
    version: u32,
    id: String,
    event: String,
    phase: String,
    code: String,
    challenge: Option<String>,
    session_nonce: Option<String>,
    status: String,
    origin: Option<String>,
    #[serde(default, rename = "documentToken")]
    _document_token: Option<String>,
    title: Option<String>,
    can_go_back: bool,
    can_go_forward: bool,
    generation: u64,
    control_mode: String,
    agent_automation: String,
    network_isolation: String,
    private_subresource_prevention: String,
    #[serde(rename = "result")]
    _result: Option<Value>,
}

struct HostProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    session_id: String,
    nonce: String,
    generation: u64,
    request_sequence: u64,
    last_status: PersonalBrowserStatus,
}

impl BrowserBroker {
    pub(crate) fn initialize(app_data: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_data).map_err(|_| "browser-app-data-unavailable")?;
        Ok(Self {
            host_path: exact_browser_host_path()?,
            test_fixture_id: None,
            test_fixture_port: None,
            state: Mutex::new(BrowserProcesses::default()),
        })
    }

    #[cfg(test)]
    fn with_host_path(host_path: PathBuf) -> Self {
        Self {
            host_path,
            test_fixture_id: None,
            test_fixture_port: None,
            state: Mutex::new(BrowserProcesses::default()),
        }
    }

    #[cfg(all(test, feature = "browser-host-poc-fixture"))]
    fn with_fixture_host_path(
        host_path: PathBuf,
        fixture_id: &str,
        fixture_port: Option<u16>,
    ) -> Self {
        Self {
            host_path,
            test_fixture_id: Some(fixture_id.to_owned()),
            test_fixture_port: fixture_port,
            state: Mutex::new(BrowserProcesses::default()),
        }
    }

    pub(crate) fn open_personal(
        &self,
        caller_label: &str,
    ) -> Result<PersonalBrowserStatus, String> {
        require_trusted_main_caller(caller_label)?;
        let mut guard = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(host) = guard.standalone.as_mut() {
            if host
                .child
                .try_wait()
                .map_err(|_| "browser-host-terminated")?
                .is_none()
            {
                return Ok(host.last_status.clone());
            }
            guard.standalone = None;
        }
        let host = HostProcess::spawn(
            &self.host_path,
            self.test_fixture_id.as_deref(),
            self.test_fixture_port,
            None,
            None,
        )?;
        let status = host.last_status.clone();
        guard.standalone = Some(host);
        Ok(status)
    }

    pub(crate) fn open_personal_embedded(
        &self,
        caller_label: &str,
        parent_window: isize,
        viewport: PersonalBrowserViewport,
    ) -> Result<PersonalBrowserStatus, String> {
        require_trusted_main_caller(caller_label)?;
        validate_viewport(&viewport)?;
        if parent_window == 0 {
            return Err("browser-viewport-invalid".into());
        }
        let mut guard = self.state.lock().unwrap_or_else(|error| error.into_inner());
        guard.embedded.retain(|_, host| {
            host.child
                .try_wait()
                .ok()
                .is_some_and(|status| status.is_none())
        });
        if guard.embedded.len() >= MAX_EMBEDDED_SESSIONS {
            return Err("browser-tab-capacity".into());
        }
        let host = HostProcess::spawn(
            &self.host_path,
            self.test_fixture_id.as_deref(),
            self.test_fixture_port,
            Some(parent_window),
            Some(viewport),
        )?;
        let status = host.last_status.clone();
        guard.embedded.insert(status.session_id.clone(), host);
        Ok(status)
    }

    pub(crate) fn set_personal_viewport(
        &self,
        caller_label: &str,
        session_id: &str,
        expected_generation: u64,
        viewport: PersonalBrowserViewport,
    ) -> Result<PersonalBrowserStatus, String> {
        require_trusted_main_caller(caller_label)?;
        validate_viewport(&viewport)?;
        let mut guard = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let host = guard.host_mut(session_id).ok_or("browser-session-stale")?;
        // Viewport ownership is bound to the opaque session rather than the
        // page navigation generation. A resize that races a navigation may
        // safely resync bounds, but can never address another session.
        let _ = expected_generation;
        host.request_viewport(viewport)
    }

    pub(crate) fn command_personal(
        &self,
        caller_label: &str,
        session_id: &str,
        expected_generation: u64,
        command: &str,
        url: Option<String>,
    ) -> Result<PersonalBrowserStatus, String> {
        require_trusted_main_caller(caller_label)?;
        let mut guard = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let host = guard.host_mut(session_id).ok_or("browser-session-stale")?;
        if host.generation != expected_generation {
            return Err("browser-generation-stale".into());
        }
        match command {
            "navigate" | "back" | "forward" | "reload" | "stop" | "status" => {}
            _ => return Err("browser-command-invalid".into()),
        }
        host.request(command, url)
    }

    pub(crate) fn close_personal(
        &self,
        caller_label: &str,
        session_id: &str,
        expected_generation: u64,
    ) -> Result<PersonalBrowserStatus, String> {
        require_trusted_main_caller(caller_label)?;
        let mut guard = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(mut host) = guard.remove(session_id) else {
            return Ok(PersonalBrowserStatus {
                session_id: session_id.to_owned(),
                status: "closed".into(),
                origin: None,
                title: None,
                can_go_back: false,
                can_go_forward: false,
                generation: expected_generation.saturating_add(1),
                control_mode: "user-only".into(),
                agent_automation: "unavailable".into(),
                network_isolation: "top-level-only".into(),
                private_subresource_prevention: "not-guaranteed".into(),
            });
        };
        // Closing is the only idempotent stale-generation operation: allowing a
        // matching session to tear down prevents a late status event from
        // stranding the child process during page unmount or app shutdown.
        host.request("close", None)
    }
}

impl Drop for BrowserBroker {
    fn drop(&mut self) {
        let processes = self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(mut host) = processes.standalone.take() {
            host.force_stop();
        }
        for (_, mut host) in processes.embedded.drain() {
            host.force_stop();
        }
    }
}

impl HostProcess {
    fn spawn(
        executable: &Path,
        test_fixture_id: Option<&str>,
        test_fixture_port: Option<u16>,
        parent_window: Option<isize>,
        viewport: Option<PersonalBrowserViewport>,
    ) -> Result<Self, String> {
        if !executable.is_absolute() || !executable.is_file() {
            return Err("browser-host-unavailable".into());
        }
        let mut command = Command::new(executable);
        if test_fixture_id.is_some() {
            command.arg("--test-window-hidden");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "browser-host-unavailable")?;
        let stdin = child.stdin.take().ok_or("browser-host-unavailable")?;
        let stdout = child.stdout.take().ok_or("browser-host-unavailable")?;
        let session_id = format!("personal-{}", random_token(24));
        let challenge = random_token(40);
        let mut host = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            session_id: session_id.clone(),
            nonce: String::new(),
            generation: 0,
            request_sequence: 0,
            last_status: PersonalBrowserStatus {
                session_id: session_id.clone(),
                status: "starting".into(),
                origin: None,
                title: None,
                can_go_back: false,
                can_go_forward: false,
                generation: 0,
                control_mode: "user-only".into(),
                agent_automation: "unavailable".into(),
                network_isolation: "top-level-only".into(),
                private_subresource_prevention: "not-guaranteed".into(),
            },
        };
        let mut initialize = json!({
            "command": "initialize",
            "version": PROTOCOL_VERSION,
            "id": "initialize",
            "challenge": challenge,
        });
        if let Some(fixture_id) = test_fixture_id {
            initialize["testFixtureHidden"] = Value::Bool(true);
            initialize["testFixtureId"] = Value::String(fixture_id.to_owned());
            if let Some(port) = test_fixture_port {
                initialize["testFixturePort"] = Value::from(port);
            }
        }
        if let (Some(parent_window), Some(viewport)) = (parent_window, viewport) {
            initialize["embedParentWindow"] = Value::from(parent_window as i64);
            initialize["embedViewport"] =
                serde_json::to_value(viewport).map_err(|_| "browser-host-protocol-invalid")?;
            initialize["embedProfileId"] = Value::String(session_id.clone());
        }
        host.write_frame(&initialize)?;
        let response = host.read_response()?;
        if response.version != PROTOCOL_VERSION
            || response.id != "initialize"
            || response.event != "session-ready"
            || response.code != "ok"
            || response.challenge.as_deref() != Some(challenge.as_str())
        {
            host.force_stop();
            return Err("browser-host-handshake-invalid".into());
        }
        host.nonce = response
            .session_nonce
            .clone()
            .filter(|value| valid_token(value, 96))
            .ok_or("browser-host-handshake-invalid")?;
        host.apply_response(response);
        Ok(host)
    }

    fn request(
        &mut self,
        command: &str,
        url: Option<String>,
    ) -> Result<PersonalBrowserStatus, String> {
        if self
            .child
            .try_wait()
            .map_err(|_| "browser-host-terminated")?
            .is_some()
        {
            return Err("browser-host-terminated".into());
        }
        self.request_sequence = self.request_sequence.saturating_add(1);
        let id = format!("request-{}", self.request_sequence);
        let mut request = json!({
            "command": command,
            "version": PROTOCOL_VERSION,
            "id": id,
            "sessionNonce": self.nonce,
            "expectedGeneration": self.generation,
        });
        if let Some(url) = url {
            request["url"] = Value::String(url);
        }
        self.write_frame(&request)?;
        let response = self.read_response()?;
        if response.version != PROTOCOL_VERSION || response.id != id {
            return Err("browser-host-protocol-invalid".into());
        }
        if response.code != "ok" {
            return Err(public_host_error(&response));
        }
        self.apply_response(response);
        Ok(self.last_status.clone())
    }

    fn request_viewport(
        &mut self,
        viewport: PersonalBrowserViewport,
    ) -> Result<PersonalBrowserStatus, String> {
        if self
            .child
            .try_wait()
            .map_err(|_| "browser-host-terminated")?
            .is_some()
        {
            return Err("browser-host-terminated".into());
        }
        self.request_sequence = self.request_sequence.saturating_add(1);
        let id = format!("request-{}", self.request_sequence);
        self.write_frame(&json!({
            "command": "set-viewport",
            "version": PROTOCOL_VERSION,
            "id": id,
            "sessionNonce": self.nonce,
            "expectedGeneration": self.generation,
            "viewport": viewport,
        }))?;
        let response = self.read_response()?;
        if response.version != PROTOCOL_VERSION || response.id != id {
            return Err("browser-host-protocol-invalid".into());
        }
        if response.code != "ok" {
            return Err(public_host_error(&response));
        }
        self.apply_response(response);
        Ok(self.last_status.clone())
    }

    fn write_frame(&mut self, value: &Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|_| "browser-host-protocol-invalid")?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err("browser-host-frame-too-large".into());
        }
        self.stdin
            .write_all(&bytes)
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|_| "browser-host-terminated".into())
    }

    fn read_response(&mut self) -> Result<HostResponse, String> {
        let mut bytes = Vec::new();
        let count = self
            .stdout
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "browser-host-terminated")?;
        if count == 0 {
            return Err("browser-host-terminated".into());
        }
        if bytes.len() > MAX_FRAME_BYTES || bytes.last() != Some(&b'\n') {
            return Err("browser-host-protocol-invalid".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "browser-host-protocol-invalid".into())
    }

    fn apply_response(&mut self, response: HostResponse) {
        self.generation = response.generation;
        self.last_status = PersonalBrowserStatus {
            session_id: self.session_id.clone(),
            status: response.status,
            origin: response.origin,
            title: response.title,
            can_go_back: response.can_go_back,
            can_go_forward: response.can_go_forward,
            generation: response.generation,
            control_mode: response.control_mode,
            agent_automation: response.agent_automation,
            network_isolation: response.network_isolation,
            private_subresource_prevention: response.private_subresource_prevention,
        };
    }

    fn force_stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.force_stop();
    }
}

pub(crate) fn exact_browser_host_path() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|_| "browser-host-unavailable")?;
    let mut directory = current.parent().ok_or("browser-host-unavailable")?;
    if directory.file_name().and_then(|name| name.to_str()) == Some("deps") {
        directory = directory.parent().ok_or("browser-host-unavailable")?;
    }
    Ok(directory.join(format!(
        "luckyray-browser-host{}",
        std::env::consts::EXE_SUFFIX
    )))
}

fn require_trusted_main_caller(caller_label: &str) -> Result<(), String> {
    if caller_label == "main" {
        Ok(())
    } else {
        Err("browser-caller-untrusted".into())
    }
}

fn validate_viewport(viewport: &PersonalBrowserViewport) -> Result<(), String> {
    let right = viewport.x.checked_add(viewport.width);
    let bottom = viewport.y.checked_add(viewport.height);
    if viewport.x < 0
        || viewport.y < 0
        || !(1..=16_384).contains(&viewport.width)
        || !(1..=16_384).contains(&viewport.height)
        || right.is_none_or(|value| value > 32_768)
        || bottom.is_none_or(|value| value > 32_768)
    {
        Err("browser-viewport-invalid".into())
    } else {
        Ok(())
    }
}

fn random_token(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn valid_token(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn public_host_error(response: &HostResponse) -> String {
    match response.code.as_str() {
        "browser-navigation-scheme-denied"
        | "browser-navigation-userinfo-denied"
        | "browser-navigation-private-target"
        | "browser-navigation-invalid"
        | "browser-navigation-failed"
        | "browser-history-unavailable"
        | "browser-generation-stale"
        | "browser-host-terminated" => response.code.clone(),
        _ => {
            let _ = &response.phase;
            "browser-host-operation-failed".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    use crate::local_transport::{self, AdapterResponse, TransportAdapter};
    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    use serde_json::Value as JsonValue;
    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    use std::io::{Read, Write};
    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    use std::net::{TcpListener, TcpStream};
    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn personal_broker_accepts_the_shared_host_response_shape() {
        let response: HostResponse = serde_json::from_value(serde_json::json!({
            "version": 1,
            "id": "personal-response",
            "event": "response",
            "phase": "status",
            "code": "ok",
            "challenge": null,
            "sessionNonce": null,
            "status": "loaded",
            "origin": "https://example.com",
            "title": "Example",
            "canGoBack": false,
            "canGoForward": false,
            "generation": 1,
            "controlMode": "user-only",
            "agentAutomation": "disabled",
            "networkIsolation": "personal-profile",
            "privateSubresourcePrevention": "not-applicable",
            "result": null
        }))
        .expect("shared production host response must remain compatible with personal broker");

        assert_eq!(response.id, "personal-response");
        assert_eq!(response.status, "loaded");
    }

    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    struct ProtectedAdapter(Arc<AtomicUsize>);

    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    impl TransportAdapter for ProtectedAdapter {
        fn dispatch(&self, _method: &str, _path: &str, _body: Option<&str>) -> AdapterResponse {
            self.0.fetch_add(1, Ordering::SeqCst);
            AdapterResponse {
                status: 200,
                body: "{}".into(),
            }
        }

        fn collect(&self, _body: &JsonValue) -> Result<JsonValue, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    #[test]
    fn remote_callers_are_rejected_before_any_process_spawn() {
        let broker = BrowserBroker::with_host_path(PathBuf::from("missing-host.exe"));
        assert_eq!(
            broker.open_personal("personal-browser-forged").unwrap_err(),
            "browser-caller-untrusted"
        );
        assert!(broker.state.lock().unwrap().is_empty());
    }

    #[test]
    fn browser_host_path_is_exact_sibling_not_path_search() {
        let path = exact_browser_host_path().unwrap();
        assert!(path.is_absolute());
        assert_eq!(
            path.file_name().and_then(|value| value.to_str()),
            Some("luckyray-browser-host.exe")
        );
    }

    #[test]
    fn embedded_viewport_rejects_zero_overflow_and_offscreen_geometry() {
        let invalid = [
            PersonalBrowserViewport {
                x: 0,
                y: 0,
                width: 0,
                height: 400,
                visible: true,
            },
            PersonalBrowserViewport {
                x: -1,
                y: 0,
                width: 400,
                height: 400,
                visible: true,
            },
            PersonalBrowserViewport {
                x: 32_700,
                y: 0,
                width: 400,
                height: 400,
                visible: true,
            },
        ];
        for viewport in invalid {
            assert_eq!(
                validate_viewport(&viewport).unwrap_err(),
                "browser-viewport-invalid"
            );
        }
        assert!(validate_viewport(&PersonalBrowserViewport {
            x: 900,
            y: 120,
            width: 520,
            height: 680,
            visible: false,
        })
        .is_ok());
    }

    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    #[test]
    fn production_broker_single_flights_real_hidden_host_and_closes_it() {
        let path = exact_browser_host_path().unwrap();
        let broker = BrowserBroker::with_fixture_host_path(path, "broker-real-host-test", None);
        let opened = broker.open_personal("main").unwrap();
        let repeated = broker.open_personal("main").unwrap();
        assert_eq!(opened.session_id, repeated.session_id);
        let status = broker
            .command_personal(
                "main",
                &opened.session_id,
                opened.generation,
                "status",
                None,
            )
            .unwrap();
        assert_eq!(status.status, "idle");
        let closed = broker
            .close_personal("main", &opened.session_id, status.generation)
            .unwrap();
        assert_eq!(closed.status, "closed");
        assert!(broker.state.lock().unwrap().is_empty());
        assert_eq!(
            broker
                .close_personal("main", &opened.session_id, closed.generation)
                .unwrap()
                .status,
            "closed"
        );
    }

    #[cfg(all(windows, feature = "browser-host-poc-fixture"))]
    #[test]
    fn personal_browser_has_no_local_transport_credential_and_cannot_dispatch_protected_work() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("luckyray-browser-local-transport-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let dispatches = Arc::new(AtomicUsize::new(0));
        let transport = local_transport::start_server(
            local_transport::ServerConfig::test(root.clone()),
            Arc::new(ProtectedAdapter(Arc::clone(&dispatches))),
        )
        .unwrap();
        let base_url = transport.client_config().base_url;
        let transport_port = base_url.rsplit(':').next().unwrap().parse::<u16>().unwrap();

        let page_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let page_port = page_listener.local_addr().unwrap().port();
        let page = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = page_listener.accept() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let body = format!(
                    "<!doctype html><title>User only</title><script>fetch('http://127.0.0.1:{transport_port}/api/v1/tools/list').catch(()=>null)</script>"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let mut unauthenticated = TcpStream::connect(("127.0.0.1", transport_port)).unwrap();
        write!(
            unauthenticated,
            "GET /api/v1/tools/list HTTP/1.1\r\nHost: 127.0.0.1:{transport_port}\r\nOrigin: http://127.0.0.1:{page_port}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        unauthenticated.read_to_string(&mut response).unwrap();
        assert!(
            response.starts_with("HTTP/1.1 401") || response.starts_with("HTTP/1.1 403"),
            "{response}"
        );
        assert_eq!(dispatches.load(Ordering::SeqCst), 0);

        let path = exact_browser_host_path().unwrap();
        let broker = BrowserBroker::with_fixture_host_path(
            path,
            "broker-local-transport-auth-test",
            Some(page_port),
        );
        let opened = broker.open_personal("main").unwrap();
        let navigated = broker
            .command_personal(
                "main",
                &opened.session_id,
                opened.generation,
                "navigate",
                Some(format!("http://127.0.0.1:{page_port}/fixture")),
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(dispatches.load(Ordering::SeqCst), 0);
        let _ = broker.close_personal("main", &opened.session_id, navigated.generation);
        page.join().unwrap();
        drop(transport);
        let _ = std::fs::remove_dir_all(root);
    }
}
