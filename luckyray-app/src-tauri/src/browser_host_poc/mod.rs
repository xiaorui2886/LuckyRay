//! Shared raw WebView2 host core.
//!
//! The production Personal Browser sidecar and the R4-A2 fixture binary both
//! compile this module. Neither binary initializes Tauri/Wry nor installs an
//! application IPC bridge, host object, custom protocol, or web message API.

use rand::{distributions::Alphanumeric, Rng};
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: u32 = 1;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_ID_BYTES: usize = 64;
const MAX_NONCE_BYTES: usize = 96;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductionViewport {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    visible: bool,
}

impl ProductionViewport {
    fn is_valid(&self) -> bool {
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, tag = "command", rename_all = "kebab-case")]
enum Request {
    Initialize {
        version: u32,
        id: String,
        challenge: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "testFixtureUrl")]
        test_fixture_url: Option<String>,
        #[serde(rename = "testFixtureExpectSecurity")]
        test_fixture_expect_security: Option<bool>,
        #[serde(rename = "testFixtureStorage")]
        test_fixture_storage: Option<TestStorageMode>,
        #[serde(rename = "testFixtureExpectedNavigationDenials")]
        test_fixture_expected_navigation_denials: Option<u8>,
    },
    Close {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, tag = "command", rename_all = "kebab-case")]
enum ProductionRequest {
    Initialize {
        version: u32,
        id: String,
        challenge: String,
        #[serde(rename = "testFixtureHidden")]
        test_fixture_hidden: Option<bool>,
        #[serde(rename = "testFixturePort")]
        test_fixture_port: Option<u16>,
        #[serde(rename = "testFixtureId")]
        test_fixture_id: Option<String>,
        #[serde(rename = "embedParentWindow")]
        embed_parent_window: Option<i64>,
        #[serde(rename = "embedViewport")]
        embed_viewport: Option<ProductionViewport>,
        #[serde(rename = "embedProfileId")]
        embed_profile_id: Option<String>,
        #[serde(rename = "agentGatewayPort")]
        agent_gateway_port: Option<u16>,
        #[serde(rename = "agentGatewayToken")]
        agent_gateway_token: Option<String>,
        #[serde(rename = "agentProfileRoot")]
        agent_profile_root: Option<String>,
    },
    Navigate {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
        url: String,
    },
    Back {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
    },
    Forward {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
    },
    Reload {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
    },
    Stop {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
    },
    Status {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
    },
    Read {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
    },
    Extract {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
        kind: AgentExtractKind,
        index: Option<usize>,
    },
    SetViewport {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
        viewport: ProductionViewport,
    },
    Close {
        version: u32,
        id: String,
        #[serde(rename = "sessionNonce")]
        session_nonce: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum AgentExtractKind {
    Main,
    Article,
    Headings,
    Links,
    Table,
}

struct AgentReadonlyConfig {
    gateway_address: SocketAddr,
    gateway_token: String,
    profile_root: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProductionMode {
    Personal,
    AgentReadonly,
}

impl ProductionMode {
    fn is_agent(self) -> bool {
        self == Self::AgentReadonly
    }
}

struct GatewayResource {
    status: i32,
    reason: &'static str,
    content_type: String,
    final_url: String,
    body: Vec<u8>,
}

fn fetch_agent_resource(
    gateway_address: SocketAddr,
    gateway_token: &str,
    method: &str,
    url: &str,
) -> Result<GatewayResource, ()> {
    const MAX_HEADER: usize = 32 * 1024;
    const MAX_BODY: usize = 2 * 1024 * 1024;
    if !matches!(method, "GET" | "HEAD")
        || url.as_bytes().len() > 8 * 1024
        || gateway_token.is_empty()
        || gateway_token.as_bytes().len() > MAX_NONCE_BYTES
    {
        return Err(());
    }
    let payload =
        serde_json::to_vec(&serde_json::json!({"method":method,"url":url})).map_err(|_| ())?;
    let mut stream =
        TcpStream::connect_timeout(&gateway_address, Duration::from_secs(1)).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(16)))
        .map_err(|_| ())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| ())?;
    write!(
        stream,
        "POST /__luckyray_agent_fetch HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {gateway_token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    )
    .map_err(|_| ())?;
    stream.write_all(&payload).map_err(|_| ())?;
    let mut response = Vec::new();
    stream
        .take((MAX_HEADER + MAX_BODY + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|_| ())?;
    if response.len() > MAX_HEADER + MAX_BODY {
        return Err(());
    }
    let boundary = response
        .windows(4)
        .position(|value| value == b"\r\n\r\n")
        .ok_or(())?;
    if boundary > MAX_HEADER {
        return Err(());
    }
    let header = std::str::from_utf8(&response[..boundary]).map_err(|_| ())?;
    let mut lines = header.split("\r\n");
    let status_line = lines.next().ok_or(())?;
    if status_line != "HTTP/1.1 200 OK" {
        return Err(());
    }
    let mut length = None;
    let mut origin_status = None;
    let mut content_type = None;
    let mut final_url = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(());
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("x-luckyray-origin-status") {
            origin_status = value.parse::<i32>().ok();
        } else if name.eq_ignore_ascii_case("x-luckyray-origin-content-type") {
            content_type = Some(value.to_owned());
        } else if name.eq_ignore_ascii_case("x-luckyray-final-url") {
            final_url = Some(value.to_owned());
        }
    }
    let body = response[(boundary + 4)..].to_vec();
    if length != Some(body.len()) || body.len() > MAX_BODY {
        return Err(());
    }
    let status = origin_status
        .filter(|value| (100..=599).contains(value))
        .ok_or(())?;
    let content_type = content_type
        .filter(|value| {
            !value.is_empty()
                && value.as_bytes().len() <= 256
                && value
                    .bytes()
                    .all(|byte| byte == b' ' || byte.is_ascii_graphic())
        })
        .ok_or(())?;
    let final_url = final_url
        .filter(|value| {
            !value.is_empty()
                && value.as_bytes().len() <= 8 * 1024
                && value.chars().all(|character| !character.is_control())
        })
        .ok_or(())?;
    Ok(GatewayResource {
        status,
        reason: if (200..=299).contains(&status) {
            "OK"
        } else {
            "Upstream"
        },
        content_type,
        final_url,
        body,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionResponse {
    version: u32,
    id: String,
    event: &'static str,
    phase: &'static str,
    code: &'static str,
    challenge: Option<String>,
    session_nonce: Option<String>,
    status: &'static str,
    origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_token: Option<String>,
    title: Option<String>,
    can_go_back: bool,
    can_go_forward: bool,
    generation: u64,
    control_mode: &'static str,
    agent_automation: &'static str,
    network_isolation: &'static str,
    private_subresource_prevention: &'static str,
    result: Option<Value>,
}

#[derive(Clone, Debug)]
struct ProductionState {
    status: &'static str,
    origin: Option<String>,
    document_token: Option<String>,
    navigation_id: Option<u64>,
    title: Option<String>,
    can_go_back: bool,
    can_go_forward: bool,
    generation: u64,
    result: Option<Value>,
}

impl Default for ProductionState {
    fn default() -> Self {
        Self {
            status: "idle",
            origin: None,
            document_token: None,
            navigation_id: None,
            title: None,
            can_go_back: false,
            can_go_forward: false,
            generation: 0,
            result: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TestStorageMode {
    Set,
    Read,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    version: u32,
    id: String,
    event: &'static str,
    phase: &'static str,
    challenge: String,
    session_nonce: String,
    availability: &'static str,
    code: &'static str,
    profile_fingerprint: Option<String>,
    security: Option<SecurityEvidence>,
    test_storage: Option<Value>,
}

#[derive(Clone, Copy)]
struct HostFailure {
    code: &'static str,
    phase: &'static str,
}

impl HostFailure {
    const fn new(code: &'static str, phase: &'static str) -> Self {
        Self { code, phase }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecurityEvidence {
    permission_denied: usize,
    popup_denied: usize,
    download_denied: usize,
    navigation_denied: usize,
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct Visitor;

        impl<'de> de::Visitor<'de> for Visitor {
            type Value = Value;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("strict JSON")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
                Ok(Value::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
                Ok(Value::Number(value.into()))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
                Ok(Value::Number(value.into()))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Value, E>
            where
                E: de::Error,
            {
                serde_json::Number::from_f64(value)
                    .map(Value::Number)
                    .ok_or_else(|| E::custom("non-finite number"))
            }

            fn visit_str<E>(self, value: &str) -> Result<Value, E> {
                Ok(Value::String(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Value, E> {
                Ok(Value::String(value))
            }

            fn visit_none<E>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }

            fn visit_unit<E>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                StrictValue::deserialize(deserializer).map(|value| value.0)
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Value, A::Error>
            where
                A: de::SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(Value::Array(values))
            }

            fn visit_map<A>(self, mut access: A) -> Result<Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                let mut object = Map::new();
                let mut keys = HashSet::new();
                while let Some(key) = access.next_key::<String>()? {
                    if !keys.insert(key.clone()) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    let value = access.next_value::<StrictValue>()?;
                    object.insert(key, value.0);
                }
                Ok(Value::Object(object))
            }
        }

        deserializer.deserialize_any(Visitor).map(Self)
    }
}

fn read_frame(reader: &mut impl BufRead) -> Result<Vec<u8>, ()> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|_| ())?;
        if available.is_empty() {
            return Err(());
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if frame.len().saturating_add(take) > MAX_FRAME_BYTES + 1 {
            return Err(());
        }
        frame.extend_from_slice(&available[..take]);
        reader.consume(take);
        if frame.last() == Some(&b'\n') {
            break;
        }
    }
    frame.pop();
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
    if frame.is_empty() {
        return Err(());
    }
    Ok(frame)
}

fn parse_request(frame: &[u8]) -> Result<Request, ()> {
    let mut deserializer = serde_json::Deserializer::from_slice(frame);
    let strict = StrictValue::deserialize(&mut deserializer).map_err(|_| ())?;
    deserializer.end().map_err(|_| ())?;
    serde_json::from_value(strict.0).map_err(|_| ())
}

fn parse_production_request(frame: &[u8]) -> Result<ProductionRequest, ()> {
    let mut deserializer = serde_json::Deserializer::from_slice(frame);
    let strict = StrictValue::deserialize(&mut deserializer).map_err(|_| ())?;
    deserializer.end().map_err(|_| ())?;
    serde_json::from_value(strict.0).map_err(|_| ())
}

fn valid_token(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn write_response(writer: &mut impl Write, response: &Response) -> Result<(), ()> {
    let bytes = serde_json::to_vec(response).map_err(|_| ())?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(());
    }
    writer.write_all(&bytes).map_err(|_| ())?;
    writer.write_all(b"\n").map_err(|_| ())?;
    writer.flush().map_err(|_| ())
}

fn random_nonce() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

pub(crate) fn run() -> i32 {
    let test_mode = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => false,
        [arg] if arg == "--test-fixture" && fixture_runtime_enabled() => true,
        _ => return 64,
    };
    let mut reader = io::BufReader::new(io::stdin().lock());
    let mut writer = io::BufWriter::new(io::stdout().lock());
    let request = match read_frame(&mut reader).and_then(|frame| parse_request(&frame)) {
        Ok(request) => request,
        Err(()) => return 64,
    };

    let Request::Initialize {
        version,
        id,
        challenge,
        workspace_id,
        test_fixture_url,
        test_fixture_expect_security,
        test_fixture_storage,
        test_fixture_expected_navigation_denials,
    } = request
    else {
        return 64;
    };
    if version != PROTOCOL_VERSION
        || !valid_token(&id, MAX_ID_BYTES)
        || !valid_token(&challenge, MAX_NONCE_BYTES)
        || !valid_token(&workspace_id, 64)
    {
        return 64;
    }

    let session_nonce = random_nonce();
    let mut response = Response {
        version: PROTOCOL_VERSION,
        id,
        event: "initialized",
        phase: "unavailable",
        challenge,
        session_nonce,
        availability: "poc-only",
        code: "browser-host-remote-navigation-unavailable",
        profile_fingerprint: None,
        security: None,
        test_storage: None,
    };
    let mut active_fixture = None;
    if test_mode {
        if test_fixture_expect_security != Some(true) {
            response.event = "session-failed";
            response.phase = "fixture-contract";
            response.code = "browser-host-fixture-contract-invalid";
            let _ = write_response(&mut writer, &response);
            return 70;
        }
        let Some(url) = test_fixture_url else {
            return 64;
        };
        match open_webview_fixture(
            &workspace_id,
            &url,
            test_fixture_storage,
            test_fixture_expected_navigation_denials.unwrap_or(1),
        ) {
            Ok(fixture) => {
                response.event = "session-ready";
                response.phase = "session-ready";
                response.code = "ok";
                response.profile_fingerprint = Some(profile_fingerprint(&workspace_id));
                response.security = Some(fixture.evidence().clone());
                response.test_storage = fixture.storage().cloned();
                active_fixture = Some(fixture);
            }
            Err(failure) => {
                response.event = "session-failed";
                response.phase = failure.phase;
                response.code = failure.code;
                let _ = write_response(&mut writer, &response);
                return 70;
            }
        }
    } else if test_fixture_url.is_some()
        || test_fixture_expect_security.is_some()
        || test_fixture_storage.is_some()
        || test_fixture_expected_navigation_denials.is_some()
    {
        return 64;
    }
    if write_response(&mut writer, &response).is_err() {
        return 74;
    }
    if !test_mode {
        return 0;
    }

    let mut generation = 0u64;
    let mut closed = false;
    loop {
        let frame = match read_optional_frame(&mut reader) {
            Ok(Some(frame)) => frame,
            Ok(None) => return 0,
            Err(()) => return 64,
        };
        let request = match parse_request(&frame) {
            Ok(request) => request,
            Err(()) => return 64,
        };
        let Request::Close {
            version,
            id,
            session_nonce: requested_nonce,
            expected_generation,
        } = request
        else {
            return 64;
        };
        if version != PROTOCOL_VERSION || !valid_token(&id, MAX_ID_BYTES) {
            return 64;
        }
        if requested_nonce != response.session_nonce {
            if write_protocol_result(
                &mut writer,
                &id,
                "error",
                "browser-session-invalid",
                generation,
            )
            .is_err()
            {
                return 74;
            }
            continue;
        }
        let expected = if closed { generation } else { 0 };
        if expected_generation != expected {
            if write_protocol_result(
                &mut writer,
                &id,
                "error",
                "browser-generation-stale",
                generation,
            )
            .is_err()
            {
                return 74;
            }
            continue;
        }
        if !closed {
            if let Some(mut fixture) = active_fixture.take() {
                if let Err(failure) = fixture.shutdown() {
                    let _ = write_failure_result(&mut writer, &id, failure, generation);
                    return 70;
                }
            }
            generation = 1;
            closed = true;
        }
        if write_protocol_result(&mut writer, &id, "closed", "ok", generation).is_err() {
            return 74;
        }
    }
}

pub(crate) fn run_production() -> i32 {
    let (mode, test_hidden) = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => (ProductionMode::Personal, false),
        [arg] if arg == "--test-window-hidden" && fixture_runtime_enabled() => {
            (ProductionMode::Personal, true)
        }
        [arg] if arg == "--agent-readonly" => (ProductionMode::AgentReadonly, false),
        [agent, hidden]
            if agent == "--agent-readonly"
                && hidden == "--test-window-hidden"
                && fixture_runtime_enabled() =>
        {
            (ProductionMode::AgentReadonly, true)
        }
        _ => return 64,
    };
    let mut reader = io::BufReader::new(io::stdin().lock());
    let frame = match read_frame(&mut reader) {
        Ok(frame) => frame,
        Err(()) => return 64,
    };
    drop(reader);
    let request = match parse_production_request(&frame) {
        Ok(request) => request,
        Err(()) => return 64,
    };
    let ProductionRequest::Initialize {
        version,
        id,
        challenge,
        test_fixture_hidden,
        test_fixture_port,
        test_fixture_id,
        embed_parent_window,
        embed_viewport,
        embed_profile_id,
        agent_gateway_port,
        agent_gateway_token,
        agent_profile_root,
    } = request
    else {
        return 64;
    };
    if version != PROTOCOL_VERSION
        || !valid_token(&id, MAX_ID_BYTES)
        || !valid_token(&challenge, MAX_NONCE_BYTES)
        || test_fixture_hidden.unwrap_or(false) != test_hidden
        || ((test_fixture_port.is_some() || test_fixture_id.is_some())
            && !fixture_runtime_enabled())
        || (test_hidden
            && test_fixture_id
                .as_deref()
                .is_none_or(|value| !valid_token(value, 64)))
        || (!test_hidden && test_fixture_id.is_some())
        || embed_parent_window.is_some() != embed_viewport.is_some()
        || (!mode.is_agent() && embed_parent_window.is_some() != embed_profile_id.is_some())
        || (mode.is_agent() && embed_profile_id.is_some())
        || embed_parent_window.is_some_and(|value| value <= 0)
        || embed_viewport
            .as_ref()
            .is_some_and(|value| !value.is_valid())
        || embed_profile_id
            .as_deref()
            .is_some_and(|value| !valid_token(value, 64))
        || (mode.is_agent()
            != (agent_gateway_port.is_some()
                && agent_gateway_token.is_some()
                && agent_profile_root.is_some()))
        || mode.is_agent()
            && (agent_gateway_port == Some(0)
                || agent_gateway_token
                    .as_deref()
                    .is_none_or(|value| !valid_token(value, MAX_NONCE_BYTES))
                || agent_profile_root
                    .as_deref()
                    .is_none_or(|value| value.as_bytes().len() > 2048 || value.contains('\0')))
        || !mode.is_agent()
            && (agent_gateway_port.is_some()
                || agent_gateway_token.is_some()
                || agent_profile_root.is_some())
    {
        return 64;
    }

    let agent_config = if mode.is_agent() {
        Some(AgentReadonlyConfig {
            gateway_address: SocketAddr::from(([127, 0, 0, 1], agent_gateway_port.unwrap())),
            gateway_token: agent_gateway_token.unwrap(),
            profile_root: PathBuf::from(agent_profile_root.unwrap()),
        })
    } else {
        None
    };

    let session_nonce = random_nonce();
    let mut session = match open_production_webview(
        test_hidden || (mode.is_agent() && embed_parent_window.is_none()),
        test_fixture_port,
        test_fixture_id.as_deref(),
        embed_parent_window,
        embed_viewport,
        embed_profile_id.as_deref(),
        agent_config,
    ) {
        Ok(session) => session,
        Err(failure) => {
            let response = production_error_response(
                id,
                "session-failed",
                failure.code,
                failure.phase,
                ProductionState::default(),
                mode,
            );
            let _ = write_production_response(&mut io::stdout().lock(), &response);
            return 70;
        }
    };
    let initial_state = session.snapshot();
    let initialized = production_response(
        id,
        "session-ready",
        "ok",
        "session-ready",
        Some(challenge),
        Some(session_nonce.clone()),
        initial_state,
        mode,
    );
    let mut writer = io::BufWriter::new(io::stdout().lock());
    if write_production_response(&mut writer, &initialized).is_err() {
        return 74;
    }

    let (request_tx, request_rx) = mpsc::channel::<Result<ProductionRequest, ()>>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = io::BufReader::new(stdin.lock());
        loop {
            match read_optional_frame(&mut reader) {
                Ok(Some(frame)) => {
                    if request_tx.send(parse_production_request(&frame)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(()) => {
                    let _ = request_tx.send(Err(()));
                    break;
                }
            }
        }
    });

    loop {
        if !session.pump() {
            let _ = session.shutdown();
            return 70;
        }
        let request = match request_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ok(request)) => request,
            Ok(Err(())) => {
                let _ = session.shutdown();
                return 64;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = session.shutdown();
                return 0;
            }
        };
        let (version, id, requested_nonce, expected_generation) =
            production_request_identity(&request);
        if version != PROTOCOL_VERSION || !valid_token(id, MAX_ID_BYTES) {
            let _ = session.shutdown();
            return 64;
        }
        let current = session.snapshot();
        if requested_nonce != session_nonce {
            let response = production_error_response(
                id.to_owned(),
                "error",
                "browser-session-invalid",
                "protocol",
                current,
                mode,
            );
            if write_production_response(&mut writer, &response).is_err() {
                return 74;
            }
            continue;
        }
        let generation_resync_allowed = matches!(
            request,
            ProductionRequest::Status { .. }
                | ProductionRequest::SetViewport { .. }
                | ProductionRequest::Close { .. }
        );
        if expected_generation != current.generation && !generation_resync_allowed {
            let response = production_error_response(
                id.to_owned(),
                "error",
                "browser-generation-stale",
                "generation",
                current,
                mode,
            );
            if write_production_response(&mut writer, &response).is_err() {
                return 74;
            }
            continue;
        }
        if matches!(request, ProductionRequest::Close { .. }) {
            if let Err(failure) = session.shutdown() {
                let response = production_error_response(
                    id.to_owned(),
                    "session-failed",
                    failure.code,
                    failure.phase,
                    session.snapshot(),
                    mode,
                );
                let _ = write_production_response(&mut writer, &response);
                return 70;
            }
            let mut closed = current;
            closed.status = "closed";
            closed.generation = closed.generation.saturating_add(1);
            let response = production_response(
                id.to_owned(),
                "closed",
                "ok",
                "closed",
                None,
                None,
                closed,
                mode,
            );
            if write_production_response(&mut writer, &response).is_err() {
                return 74;
            }
            return 0;
        }
        let response = match session.execute(&request) {
            Ok(event) => production_response(
                id.to_owned(),
                event,
                "ok",
                event,
                None,
                None,
                session.snapshot(),
                mode,
            ),
            Err(failure) => production_error_response(
                id.to_owned(),
                "error",
                failure.code,
                failure.phase,
                session.snapshot(),
                mode,
            ),
        };
        if write_production_response(&mut writer, &response).is_err() {
            return 74;
        }
    }
}

fn production_request_identity(request: &ProductionRequest) -> (u32, &str, &str, u64) {
    match request {
        ProductionRequest::Initialize { .. } => (0, "", "", 0),
        ProductionRequest::Navigate {
            version,
            id,
            session_nonce,
            expected_generation,
            ..
        }
        | ProductionRequest::Back {
            version,
            id,
            session_nonce,
            expected_generation,
        }
        | ProductionRequest::Forward {
            version,
            id,
            session_nonce,
            expected_generation,
        }
        | ProductionRequest::Reload {
            version,
            id,
            session_nonce,
            expected_generation,
        }
        | ProductionRequest::Stop {
            version,
            id,
            session_nonce,
            expected_generation,
        }
        | ProductionRequest::Status {
            version,
            id,
            session_nonce,
            expected_generation,
        }
        | ProductionRequest::Read {
            version,
            id,
            session_nonce,
            expected_generation,
        }
        | ProductionRequest::Extract {
            version,
            id,
            session_nonce,
            expected_generation,
            ..
        }
        | ProductionRequest::SetViewport {
            version,
            id,
            session_nonce,
            expected_generation,
            ..
        }
        | ProductionRequest::Close {
            version,
            id,
            session_nonce,
            expected_generation,
        } => (*version, id, session_nonce, *expected_generation),
    }
}

fn production_response(
    id: String,
    event: &'static str,
    code: &'static str,
    phase: &'static str,
    challenge: Option<String>,
    session_nonce: Option<String>,
    state: ProductionState,
    mode: ProductionMode,
) -> ProductionResponse {
    ProductionResponse {
        version: PROTOCOL_VERSION,
        id,
        event,
        phase,
        code,
        challenge,
        session_nonce,
        status: state.status,
        origin: state.origin,
        document_token: state.document_token,
        title: state.title,
        can_go_back: state.can_go_back,
        can_go_forward: state.can_go_forward,
        generation: state.generation,
        control_mode: if mode.is_agent() {
            "agent-readonly"
        } else {
            "user-only"
        },
        agent_automation: if mode.is_agent() {
            "read-only"
        } else {
            "unavailable"
        },
        network_isolation: if mode.is_agent() {
            "parent-gateway"
        } else {
            "top-level-only"
        },
        private_subresource_prevention: if mode.is_agent() {
            "enforced"
        } else {
            "not-guaranteed"
        },
        result: state.result,
    }
}

fn production_error_response(
    id: String,
    event: &'static str,
    code: &'static str,
    phase: &'static str,
    state: ProductionState,
    mode: ProductionMode,
) -> ProductionResponse {
    production_response(id, event, code, phase, None, None, state, mode)
}

fn write_production_response(
    writer: &mut impl Write,
    response: &ProductionResponse,
) -> Result<(), ()> {
    let bytes = serde_json::to_vec(response).map_err(|_| ())?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(());
    }
    writer.write_all(&bytes).map_err(|_| ())?;
    writer.write_all(b"\n").map_err(|_| ())?;
    writer.flush().map_err(|_| ())
}

fn write_failure_result(
    writer: &mut impl Write,
    id: &str,
    failure: HostFailure,
    generation: u64,
) -> Result<(), ()> {
    let value = serde_json::json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "event": "session-failed",
        "phase": failure.phase,
        "code": failure.code,
        "generation": generation,
    });
    let bytes = serde_json::to_vec(&value).map_err(|_| ())?;
    writer.write_all(&bytes).map_err(|_| ())?;
    writer.write_all(b"\n").map_err(|_| ())?;
    writer.flush().map_err(|_| ())
}

fn fixture_runtime_enabled() -> bool {
    cfg!(all(feature = "browser-host-poc-fixture", debug_assertions))
}

fn read_optional_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, ()> {
    if reader.fill_buf().map_err(|_| ())?.is_empty() {
        return Ok(None);
    }
    read_frame(reader).map(Some)
}

fn write_protocol_result(
    writer: &mut impl Write,
    id: &str,
    event: &'static str,
    code: &'static str,
    generation: u64,
) -> Result<(), ()> {
    let value = serde_json::json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "event": event,
        "code": code,
        "generation": generation,
    });
    let bytes = serde_json::to_vec(&value).map_err(|_| ())?;
    writer.write_all(&bytes).map_err(|_| ())?;
    writer.write_all(b"\n").map_err(|_| ())?;
    writer.flush().map_err(|_| ())
}

fn profile_fingerprint(workspace_id: &str) -> String {
    let digest = Sha256::digest(workspace_id.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn browser_document_token(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"luckyray-agent-browser-source-v1\0");
    hasher.update(value.as_bytes());
    format!("src-b-{:x}", hasher.finalize())
}

#[cfg(windows)]
type ActiveProduction = windows_host::ProductionSession;

#[cfg(windows)]
fn open_production_webview(
    hidden: bool,
    test_fixture_port: Option<u16>,
    test_fixture_id: Option<&str>,
    embed_parent_window: Option<i64>,
    embed_viewport: Option<ProductionViewport>,
    embed_profile_id: Option<&str>,
    agent_config: Option<AgentReadonlyConfig>,
) -> Result<ActiveProduction, HostFailure> {
    windows_host::open_production(
        hidden,
        test_fixture_port,
        test_fixture_id,
        embed_parent_window,
        embed_viewport,
        embed_profile_id,
        agent_config,
    )
}

#[cfg(not(windows))]
struct ActiveProduction;

#[cfg(not(windows))]
impl ActiveProduction {
    fn snapshot(&self) -> ProductionState {
        ProductionState::default()
    }

    fn pump(&mut self) -> bool {
        false
    }

    fn execute(&mut self, _request: &ProductionRequest) -> Result<&'static str, HostFailure> {
        Err(HostFailure::new(
            "browser-host-platform-unsupported",
            "platform",
        ))
    }

    fn shutdown(&mut self) -> Result<(), HostFailure> {
        Ok(())
    }
}

#[cfg(not(windows))]
fn open_production_webview(
    _hidden: bool,
    _test_fixture_port: Option<u16>,
    _test_fixture_id: Option<&str>,
    _embed_parent_window: Option<i64>,
    _embed_viewport: Option<ProductionViewport>,
    _embed_profile_id: Option<&str>,
    _agent_config: Option<AgentReadonlyConfig>,
) -> Result<ActiveProduction, HostFailure> {
    Err(HostFailure::new(
        "browser-host-platform-unsupported",
        "platform",
    ))
}

#[cfg(all(windows, feature = "browser-host-poc-fixture"))]
type ActiveFixture = windows_host::FixtureSession;

#[cfg(all(windows, feature = "browser-host-poc-fixture"))]
fn open_webview_fixture(
    workspace_id: &str,
    url: &str,
    storage_mode: Option<TestStorageMode>,
    expected_navigation_denials: u8,
) -> Result<ActiveFixture, HostFailure> {
    windows_host::open(workspace_id, url, storage_mode, expected_navigation_denials)
}

#[cfg(not(all(windows, feature = "browser-host-poc-fixture")))]
struct ActiveFixture;

#[cfg(not(all(windows, feature = "browser-host-poc-fixture")))]
impl ActiveFixture {
    fn evidence(&self) -> &SecurityEvidence {
        unreachable!()
    }

    fn storage(&self) -> Option<&Value> {
        unreachable!()
    }

    fn shutdown(&mut self) -> Result<(), HostFailure> {
        unreachable!()
    }
}

#[cfg(not(all(windows, feature = "browser-host-poc-fixture")))]
fn open_webview_fixture(
    _workspace_id: &str,
    _url: &str,
    _storage_mode: Option<TestStorageMode>,
    _expected_navigation_denials: u8,
) -> Result<ActiveFixture, HostFailure> {
    Err(HostFailure::new(
        "browser-host-platform-unsupported",
        "platform",
    ))
}

#[cfg(windows)]
mod windows_host {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::ffi::{c_void, OsStr};
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::os::windows::ffi::OsStrExt;
    use std::rc::Rc;
    use std::sync::atomic::AtomicBool;
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
    use windows::{
        core::{w, Interface, BOOL, HSTRING, PCWSTR, PWSTR},
        Win32::{
            Foundation::{CloseHandle, E_POINTER, HANDLE, HINSTANCE, HWND, RECT},
            Storage::FileSystem::{
                CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
                FILE_LIST_DIRECTORY, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
            },
            System::{
                Com::{CoInitializeEx, IStream, COINIT_APARTMENTTHREADED},
                LibraryLoader::GetModuleHandleW,
            },
            UI::Shell::{
                FOLDERID_LocalAppData, SHCreateMemStream, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
            },
            UI::WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
                GetWindowLongPtrW, IsWindow, PeekMessageW, RegisterClassW, SetWindowLongPtrW,
                SetWindowPos, ShowWindow, TranslateMessage, GWL_STYLE, HWND_TOP, MSG, PM_REMOVE,
                SWP_NOACTIVATE, SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WNDCLASSW,
                WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_DISABLED, WS_OVERLAPPEDWINDOW,
            },
        },
    };

    type HostResult<T> = std::result::Result<T, ()>;

    struct ProfileLease(HANDLE);

    impl Drop for ProfileLease {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    struct Controller(ICoreWebView2Controller);

    impl Drop for Controller {
        fn drop(&mut self) {
            unsafe {
                let _ = self.0.Close();
            }
        }
    }

    extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: windows::Win32::Foundation::WPARAM,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    fn disable_agent_surface(hwnd: HWND) {
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_DISABLED.0 as isize);
        }
    }

    const MAX_PENDING_AGENT_RESOURCES: usize = 128;
    const AGENT_RESOURCE_DEADLINE: Duration = Duration::from_secs(18);
    const AGENT_NETWORK_LOCKDOWN_SCRIPT: &str = r#"(()=>{
      'use strict';
      const disable=(target,name,value=undefined)=>{
        try{
          Object.defineProperty(target,name,{value,writable:false,configurable:false,enumerable:false});
        }catch(_error){
          throw new Error('luckyray-agent-network-lockdown');
        }
      };
      disable(globalThis,'RTCPeerConnection');
      disable(globalThis,'webkitRTCPeerConnection');
      disable(globalThis,'WebTransport');
    })();"#;

    #[derive(Default)]
    struct AgentTopLevelPolicy {
        allowed_urls: HashSet<String>,
    }

    impl AgentTopLevelPolicy {
        fn begin(&mut self, target: &url::Url) {
            self.allowed_urls.clear();
            self.allowed_urls.insert(target.as_str().to_owned());
        }

        fn allow_gateway_final(&mut self, target: &str) {
            self.allowed_urls.insert(target.to_owned());
        }

        fn permits(&self, target: &url::Url) -> bool {
            self.allowed_urls.contains(target.as_str())
        }
    }

    struct AgentFetchJob {
        id: u64,
        method: String,
        url: String,
    }

    struct AgentFetchCompletion {
        id: u64,
        result: std::result::Result<GatewayResource, ()>,
    }

    struct PendingAgentResponse {
        args: ICoreWebView2WebResourceRequestedEventArgs,
        request: ICoreWebView2WebResourceRequest,
        deferral: Option<ICoreWebView2Deferral>,
        deadline: Instant,
        is_document: bool,
    }

    #[derive(Clone)]
    struct AgentResourceHandler {
        active: Arc<AtomicBool>,
        next_id: Rc<Cell<u64>>,
        pending: Rc<RefCell<HashMap<u64, PendingAgentResponse>>>,
        job_tx: mpsc::Sender<AgentFetchJob>,
        environment: ICoreWebView2Environment,
        top_level_policy: Arc<Mutex<AgentTopLevelPolicy>>,
    }

    struct AgentResourcePipeline {
        active: Arc<AtomicBool>,
        pending: Rc<RefCell<HashMap<u64, PendingAgentResponse>>>,
        completion_rx: mpsc::Receiver<AgentFetchCompletion>,
        job_tx: Option<mpsc::Sender<AgentFetchJob>>,
        workers: Vec<std::thread::JoinHandle<()>>,
        top_level_policy: Arc<Mutex<AgentTopLevelPolicy>>,
    }

    impl AgentResourcePipeline {
        fn start(
            config: &AgentReadonlyConfig,
            environment: &ICoreWebView2Environment,
            top_level_policy: Arc<Mutex<AgentTopLevelPolicy>>,
        ) -> (Self, AgentResourceHandler) {
            let active = Arc::new(AtomicBool::new(true));
            let pending = Rc::new(RefCell::new(HashMap::new()));
            let (job_tx, job_rx) = mpsc::channel::<AgentFetchJob>();
            let job_rx = Arc::new(Mutex::new(job_rx));
            let (completion_tx, completion_rx) = mpsc::channel();
            let mut workers = Vec::new();
            for index in 0..4 {
                let worker_rx = Arc::clone(&job_rx);
                let worker_tx = completion_tx.clone();
                let worker_active = Arc::clone(&active);
                let gateway_address = config.gateway_address;
                let gateway_token = config.gateway_token.clone();
                if let Ok(worker) = std::thread::Builder::new()
                    .name(format!("luckyray-agent-browser-fetch-{index}"))
                    .spawn(move || loop {
                        let job = {
                            let receiver =
                                worker_rx.lock().unwrap_or_else(|error| error.into_inner());
                            receiver.recv()
                        };
                        let Ok(job) = job else { break };
                        let result = if worker_active.load(Ordering::Acquire) {
                            fetch_agent_resource(
                                gateway_address,
                                &gateway_token,
                                &job.method,
                                &job.url,
                            )
                        } else {
                            Err(())
                        };
                        if worker_tx
                            .send(AgentFetchCompletion { id: job.id, result })
                            .is_err()
                        {
                            break;
                        }
                    })
                {
                    workers.push(worker);
                }
            }
            let handler = AgentResourceHandler {
                active: Arc::clone(&active),
                next_id: Rc::new(Cell::new(1)),
                pending: Rc::clone(&pending),
                job_tx: job_tx.clone(),
                environment: environment.clone(),
                top_level_policy: Arc::clone(&top_level_policy),
            };
            (
                Self {
                    active,
                    pending,
                    completion_rx,
                    job_tx: Some(job_tx),
                    workers,
                    top_level_policy,
                },
                handler,
            )
        }

        fn drain(&mut self, environment: &ICoreWebView2Environment) {
            while let Ok(completion) = self.completion_rx.try_recv() {
                if let Some(pending) = self.pending.borrow_mut().remove(&completion.id) {
                    complete_agent_response(
                        environment,
                        &self.top_level_policy,
                        pending,
                        completion.result,
                    );
                }
            }
            let now = Instant::now();
            let expired: Vec<u64> = self
                .pending
                .borrow()
                .iter()
                .filter_map(|(id, pending)| (now >= pending.deadline).then_some(*id))
                .collect();
            for id in expired {
                if let Some(pending) = self.pending.borrow_mut().remove(&id) {
                    complete_agent_response(environment, &self.top_level_policy, pending, Err(()));
                }
            }
        }

        fn cancel(&mut self, environment: &ICoreWebView2Environment) {
            self.active.store(false, Ordering::Release);
            self.job_tx.take();
            let pending = std::mem::take(&mut *self.pending.borrow_mut());
            for (_, response) in pending {
                complete_agent_response(environment, &self.top_level_policy, response, Err(()));
            }
            self.workers.clear();
        }
    }

    fn immediate_agent_block(
        environment: &ICoreWebView2Environment,
        args: &ICoreWebView2WebResourceRequestedEventArgs,
    ) {
        unsafe {
            if let Some(content) = SHCreateMemStream(Some(b"blocked")) {
                if let Ok(response) = environment.CreateWebResourceResponse(
                    &content,
                    403,
                    w!("Blocked"),
                    w!("Content-Type: text/plain\r\nCache-Control: no-store"),
                ) {
                    let _ = args.SetResponse(&response);
                }
            }
        }
    }

    fn complete_agent_response(
        environment: &ICoreWebView2Environment,
        top_level_policy: &Arc<Mutex<AgentTopLevelPolicy>>,
        mut pending: PendingAgentResponse,
        result: std::result::Result<GatewayResource, ()>,
    ) {
        unsafe {
            match result {
                Ok(resource) => {
                    if pending.is_document {
                        top_level_policy
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .allow_gateway_final(&resource.final_url);
                    }
                    let final_url = HSTRING::from(resource.final_url);
                    let _ = pending.request.SetUri(PCWSTR(final_url.as_ptr()));
                    if let Some(content) = SHCreateMemStream(Some(&resource.body)) {
                        let reason = HSTRING::from(resource.reason);
                        let headers = HSTRING::from(format!(
                            "Content-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store",
                            resource.content_type,
                            resource.body.len()
                        ));
                        if let Ok(response) = environment.CreateWebResourceResponse(
                            &content,
                            resource.status,
                            PCWSTR(reason.as_ptr()),
                            PCWSTR(headers.as_ptr()),
                        ) {
                            let _ = pending.args.SetResponse(&response);
                        } else {
                            immediate_agent_block(environment, &pending.args);
                        }
                    } else {
                        immediate_agent_block(environment, &pending.args);
                    }
                }
                Err(()) => immediate_agent_block(environment, &pending.args),
            }
            if let Some(deferral) = pending.deferral.take() {
                let _ = deferral.Complete();
            }
        }
    }

    pub(super) struct ProductionSession {
        controller: Option<Controller>,
        webview: Option<ICoreWebView2>,
        environment: Option<ICoreWebView2Environment>,
        environment_exit_source: Option<ICoreWebView2Environment5>,
        browser_process_exit: Option<mpsc::Receiver<()>>,
        hwnd: HWND,
        state: Arc<Mutex<ProductionState>>,
        test_fixture_port: Option<u16>,
        lease: Option<ProfileLease>,
        embedded: bool,
        ephemeral_profile: Option<PathBuf>,
        agent_readonly: bool,
        agent_resources: Option<AgentResourcePipeline>,
        agent_top_level_policy: Option<Arc<Mutex<AgentTopLevelPolicy>>>,
    }

    impl ProductionSession {
        pub(super) fn snapshot(&self) -> ProductionState {
            self.state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        }

        pub(super) fn pump(&mut self) -> bool {
            pump_messages();
            if let (Some(resources), Some(environment)) =
                (self.agent_resources.as_mut(), self.environment.as_ref())
            {
                resources.drain(environment);
            }
            !self.hwnd.is_invalid() && unsafe { IsWindow(Some(self.hwnd)).as_bool() }
        }

        pub(super) fn execute(
            &mut self,
            request: &ProductionRequest,
        ) -> std::result::Result<&'static str, HostFailure> {
            let webview = self.webview.as_ref().ok_or_else(|| {
                HostFailure::new("browser-host-terminated", "webview-unavailable")
            })?;
            match request {
                ProductionRequest::Status { .. } => Ok("status"),
                ProductionRequest::Read { .. } => {
                    self.require_agent_ready()?;
                    let result = execute_script(webview, AGENT_READ_SCRIPT)
                        .map_err(|_| HostFailure::new("browser-read-failed", "read-execute"))?;
                    self.store_agent_result(result)?;
                    Ok("read-completed")
                }
                ProductionRequest::Extract { kind, index, .. } => {
                    self.require_agent_ready()?;
                    let script = agent_extract_script(*kind, *index)?;
                    let result = execute_script(webview, &script).map_err(|_| {
                        HostFailure::new("browser-extract-failed", "extract-execute")
                    })?;
                    self.store_agent_result(result)?;
                    Ok("extract-completed")
                }
                ProductionRequest::Navigate { url, .. } => {
                    let target = validated_top_level_url(url, self.test_fixture_port)?;
                    if let Some(policy) = self.agent_top_level_policy.as_ref() {
                        policy
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .begin(&target);
                    }
                    let previous_generation = self.snapshot().generation;
                    self.mark_navigation_dispatched();
                    unsafe {
                        webview
                            .Navigate(PCWSTR(HSTRING::from(target.as_str()).as_ptr()))
                            .map_err(|_| {
                                HostFailure::new("browser-navigation-failed", "navigation-dispatch")
                            })?;
                    }
                    self.wait_for_navigation_start(previous_generation)?;
                    Ok("navigating")
                }
                ProductionRequest::Back { .. } => {
                    if !self.snapshot().can_go_back {
                        return Err(HostFailure::new(
                            "browser-history-unavailable",
                            "history-back",
                        ));
                    }
                    let previous_generation = self.snapshot().generation;
                    self.mark_navigation_dispatched();
                    unsafe { webview.GoBack() }.map_err(|_| {
                        HostFailure::new("browser-navigation-failed", "history-back")
                    })?;
                    self.wait_for_navigation_start(previous_generation)?;
                    Ok("navigating")
                }
                ProductionRequest::Forward { .. } => {
                    if !self.snapshot().can_go_forward {
                        return Err(HostFailure::new(
                            "browser-history-unavailable",
                            "history-forward",
                        ));
                    }
                    let previous_generation = self.snapshot().generation;
                    self.mark_navigation_dispatched();
                    unsafe { webview.GoForward() }.map_err(|_| {
                        HostFailure::new("browser-navigation-failed", "history-forward")
                    })?;
                    self.wait_for_navigation_start(previous_generation)?;
                    Ok("navigating")
                }
                ProductionRequest::Reload { .. } => {
                    let previous_generation = self.snapshot().generation;
                    self.mark_navigation_dispatched();
                    unsafe { webview.Reload() }
                        .map_err(|_| HostFailure::new("browser-navigation-failed", "reload"))?;
                    self.wait_for_navigation_start(previous_generation)?;
                    Ok("navigating")
                }
                ProductionRequest::Stop { .. } => {
                    unsafe { webview.Stop() }
                        .map_err(|_| HostFailure::new("browser-navigation-failed", "stop"))?;
                    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                    if state.status == "loading" {
                        state.status = "idle";
                    }
                    Ok("stopped")
                }
                ProductionRequest::SetViewport { viewport, .. } => {
                    self.set_viewport(viewport)?;
                    Ok("viewport-updated")
                }
                ProductionRequest::Initialize { .. } | ProductionRequest::Close { .. } => Err(
                    HostFailure::new("browser-protocol-invalid", "protocol-command"),
                ),
            }
        }

        fn mark_navigation_dispatched(&self) {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.status = "loading";
            state.result = None;
        }

        fn require_agent_ready(&self) -> std::result::Result<(), HostFailure> {
            let state = self.snapshot();
            if !self.agent_readonly || state.status != "loaded" {
                return Err(HostFailure::new(
                    "browser-session-not-ready",
                    "agent-readonly",
                ));
            }
            Ok(())
        }

        fn store_agent_result(&self, result: Value) -> std::result::Result<(), HostFailure> {
            let result = sanitize_agent_result(result)?;
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.result = Some(result);
            Ok(())
        }

        fn set_viewport(
            &mut self,
            viewport: &ProductionViewport,
        ) -> std::result::Result<(), HostFailure> {
            if !self.embedded || !viewport.is_valid() {
                return Err(HostFailure::new(
                    "browser-viewport-invalid",
                    "viewport-update",
                ));
            }
            unsafe {
                SetWindowPos(
                    self.hwnd,
                    Some(HWND_TOP),
                    viewport.x,
                    viewport.y,
                    viewport.width,
                    viewport.height,
                    SWP_NOACTIVATE,
                )
                .map_err(|_| HostFailure::new("browser-viewport-invalid", "viewport-window"))?;
                if let Some(controller) = self.controller.as_ref() {
                    controller
                        .0
                        .SetBounds(RECT {
                            left: 0,
                            top: 0,
                            right: viewport.width,
                            bottom: viewport.height,
                        })
                        .map_err(|_| {
                            HostFailure::new("browser-viewport-invalid", "viewport-controller")
                        })?;
                    controller.0.SetIsVisible(viewport.visible).map_err(|_| {
                        HostFailure::new("browser-viewport-invalid", "viewport-visible")
                    })?;
                }
                if self.agent_readonly {
                    disable_agent_surface(self.hwnd);
                }
                let show = if viewport.visible {
                    if self.agent_readonly {
                        SW_SHOWNOACTIVATE
                    } else {
                        SW_SHOW
                    }
                } else {
                    SW_HIDE
                };
                let _ = ShowWindow(self.hwnd, show);
            }
            Ok(())
        }

        fn wait_for_navigation_start(
            &mut self,
            previous_generation: u64,
        ) -> std::result::Result<(), HostFailure> {
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                if !self.pump() {
                    return Err(HostFailure::new(
                        "browser-host-terminated",
                        "navigation-start",
                    ));
                }
                let current = self.snapshot();
                if current.generation != previous_generation || current.status == "error" {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(HostFailure::new(
                        "browser-navigation-failed",
                        "navigation-start-timeout",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        pub(super) fn shutdown(&mut self) -> std::result::Result<(), HostFailure> {
            if let (Some(resources), Some(environment)) =
                (self.agent_resources.as_mut(), self.environment.as_ref())
            {
                resources.cancel(environment);
            }
            if let Some(controller) = self.controller.as_ref() {
                unsafe { controller.0.Close() }.map_err(|_| {
                    HostFailure::new("browser-host-close-incomplete", "controller-close")
                })?;
            }
            pump_for(Duration::from_millis(50));
            self.webview.take();
            self.controller.take();
            self.agent_resources.take();
            if let Some(exit) = self.browser_process_exit.take() {
                wait_for_signal(exit, Duration::from_secs(20)).map_err(|_| {
                    HostFailure::new("browser-host-close-incomplete", "browser-process-exit")
                })?;
            }
            self.environment_exit_source.take();
            self.environment.take();
            self.lease.take();
            if !self.hwnd.is_invalid() {
                unsafe {
                    let _ = DestroyWindow(self.hwnd);
                }
            }
            self.hwnd = HWND::default();
            if let Some(profile) = self.ephemeral_profile.take() {
                let _ = fs::remove_dir_all(profile);
            }
            Ok(())
        }
    }

    impl Drop for ProductionSession {
        fn drop(&mut self) {
            let _ = self.shutdown();
        }
    }

    pub(super) fn open_production(
        hidden: bool,
        test_fixture_port: Option<u16>,
        test_fixture_id: Option<&str>,
        embed_parent_window: Option<i64>,
        embed_viewport: Option<ProductionViewport>,
        embed_profile_id: Option<&str>,
        agent_config: Option<AgentReadonlyConfig>,
    ) -> std::result::Result<ProductionSession, HostFailure> {
        if (hidden || test_fixture_port.is_some() || test_fixture_id.is_some())
            && agent_config.is_none()
            && !fixture_runtime_enabled()
        {
            return Err(HostFailure::new(
                "browser-host-test-mode-unavailable",
                "test-gate",
            ));
        }
        for key in [
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            "WEBVIEW2_USER_DATA_FOLDER",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
        ] {
            std::env::remove_var(key);
        }
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|_| HostFailure::new("browser-host-com-unavailable", "com-initialize"))?;
        let agent_mode = agent_config.is_some();
        let profile = if let Some(config) = agent_config.as_ref() {
            prepare_agent_profile(&config.profile_root)
        } else {
            prepare_production_profile(test_fixture_id, embed_profile_id)
        }
        .map_err(|_| HostFailure::new("browser-host-profile-unavailable", "profile-prepare"))?;
        let lease = open_profile_lease(&profile)
            .map_err(|_| HostFailure::new("browser-host-profile-unavailable", "profile-lease"))?;
        let embed = match (embed_parent_window, embed_viewport) {
            (Some(parent), Some(viewport)) if parent > 0 && viewport.is_valid() => {
                let parent = HWND(parent as isize as *mut c_void);
                if !unsafe { IsWindow(Some(parent)).as_bool() } {
                    return Err(HostFailure::new(
                        "browser-viewport-invalid",
                        "viewport-parent",
                    ));
                }
                Some((parent, viewport))
            }
            (None, None) => None,
            _ => {
                return Err(HostFailure::new(
                    "browser-viewport-invalid",
                    "viewport-contract",
                ))
            }
        };
        let hwnd = create_browser_window(hidden, embed.as_ref(), agent_mode)
            .map_err(|_| HostFailure::new("browser-host-window-unavailable", "window-create"))?;
        create_production_session(
            hwnd,
            &profile,
            hidden,
            test_fixture_port,
            lease,
            embed.as_ref().map(|(_, viewport)| viewport),
            embed_profile_id.is_some() || agent_mode,
            agent_config,
        )
    }

    fn create_browser_window(
        hidden: bool,
        embed: Option<&(HWND, ProductionViewport)>,
        agent_readonly: bool,
    ) -> HostResult<HWND> {
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            lpszClassName: w!("LuckyRayPersonalBrowserHost"),
            ..Default::default()
        };
        unsafe {
            let _ = RegisterClassW(&class);
            let (style, x, y, width, height, parent, visible) =
                if let Some((parent, viewport)) = embed {
                    (
                        WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                        viewport.x,
                        viewport.y,
                        viewport.width,
                        viewport.height,
                        Some(*parent),
                        viewport.visible,
                    )
                } else {
                    (WS_OVERLAPPEDWINDOW, 120, 120, 1100, 760, None, !hidden)
                };
            let hwnd = CreateWindowExW(
                Default::default(),
                w!("LuckyRayPersonalBrowserHost"),
                w!("LuckyRay Personal Browser"),
                style,
                x,
                y,
                width,
                height,
                parent,
                None,
                GetModuleHandleW(None)
                    .ok()
                    .map(|module| HINSTANCE(module.0)),
                None,
            )
            .map_err(|_| ())?;
            if agent_readonly {
                disable_agent_surface(hwnd);
            }
            if visible {
                let _ = ShowWindow(
                    hwnd,
                    if agent_readonly {
                        SW_SHOWNOACTIVATE
                    } else {
                        SW_SHOW
                    },
                );
            }
            Ok(hwnd)
        }
    }

    fn create_production_session(
        hwnd: HWND,
        profile: &Path,
        hidden: bool,
        test_fixture_port: Option<u16>,
        lease: ProfileLease,
        embed_viewport: Option<&ProductionViewport>,
        ephemeral_profile: bool,
        agent_config: Option<AgentReadonlyConfig>,
    ) -> std::result::Result<ProductionSession, HostFailure> {
        let options: ICoreWebView2EnvironmentOptions =
            webview2_com::CoreWebView2EnvironmentOptions::default().into();
        if let Some(config) = agent_config.as_ref() {
            let arguments = agent_browser_arguments(config.gateway_address.port());
            unsafe {
                options.SetAdditionalBrowserArguments(PCWSTR(HSTRING::from(arguments).as_ptr()))
            }
            .map_err(|_| {
                HostFailure::new(
                    "browser-host-environment-unavailable",
                    "environment-options",
                )
            })?;
        }
        let options2: ICoreWebView2EnvironmentOptions2 = options.cast().map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-options",
            )
        })?;
        unsafe { options2.SetExclusiveUserDataFolderAccess(true) }.map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-options",
            )
        })?;
        let profile_h = HSTRING::from(profile.as_os_str());
        let environment = create_environment(profile_h, options)?;
        verify_environment_profile(&environment, profile)?;
        let controller = create_controller(&environment, hwnd)?;
        unsafe {
            let width = embed_viewport.map_or(1100, |viewport| viewport.width);
            let height = embed_viewport.map_or(760, |viewport| viewport.height);
            let visible = embed_viewport.map_or(!hidden, |viewport| viewport.visible);
            controller
                .0
                .SetBounds(RECT {
                    left: 0,
                    top: 0,
                    right: width,
                    bottom: height,
                })
                .map_err(|_| {
                    HostFailure::new("browser-host-controller-unavailable", "controller-bounds")
                })?;
            controller.0.SetIsVisible(visible).map_err(|_| {
                HostFailure::new("browser-host-controller-unavailable", "controller-visible")
            })?;
        }
        let webview = unsafe { controller.0.CoreWebView2() }
            .map_err(|_| HostFailure::new("browser-host-webview-unavailable", "webview-create"))?;
        configure_production_settings(&webview).map_err(|_| {
            HostFailure::new("browser-host-webview-unavailable", "webview-settings")
        })?;
        if agent_config.is_some() {
            install_agent_network_lockdown(&webview).map_err(|_| {
                HostFailure::new("browser-host-webview-unavailable", "agent-network-lockdown")
            })?;
        }
        let state = Arc::new(Mutex::new(ProductionState::default()));
        let agent_top_level_policy = agent_config
            .as_ref()
            .map(|_| Arc::new(Mutex::new(AgentTopLevelPolicy::default())));
        let (agent_resources, agent_handler) = if let Some(config) = agent_config.as_ref() {
            let (resources, handler) = AgentResourcePipeline::start(
                config,
                &environment,
                Arc::clone(
                    agent_top_level_policy
                        .as_ref()
                        .expect("agent policy exists with agent config"),
                ),
            );
            (Some(resources), Some(handler))
        } else {
            (None, None)
        };
        attach_production_handlers(
            &environment,
            &webview,
            Arc::clone(&state),
            test_fixture_port,
            agent_handler,
            agent_top_level_policy.clone(),
        )
        .map_err(|_| HostFailure::new("browser-host-webview-unavailable", "handlers-installed"))?;
        let environment5: ICoreWebView2Environment5 = environment.cast().map_err(|_| {
            HostFailure::new("browser-host-webview-unavailable", "browser-process-bind")
        })?;
        let (browser_exit_tx, browser_process_exit) = mpsc::channel();
        let mut token = 0i64;
        unsafe {
            environment5
                .add_BrowserProcessExited(
                    &BrowserProcessExitedEventHandler::create(Box::new(move |_, args| {
                        if args.is_some() {
                            let _ = browser_exit_tx.send(());
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| {
                    HostFailure::new("browser-host-webview-unavailable", "browser-process-bind")
                })?;
        }
        verify_profile_storage_written(profile).map_err(|_| {
            HostFailure::new("browser-host-readiness-probe-failed", "profile-write-probe")
        })?;
        Ok(ProductionSession {
            controller: Some(controller),
            webview: Some(webview),
            environment: Some(environment),
            environment_exit_source: Some(environment5),
            browser_process_exit: Some(browser_process_exit),
            hwnd,
            state,
            test_fixture_port,
            lease: Some(lease),
            embedded: embed_viewport.is_some(),
            ephemeral_profile: ephemeral_profile.then(|| profile.to_path_buf()),
            agent_readonly: agent_config.is_some(),
            agent_resources,
            agent_top_level_policy,
        })
    }

    fn create_environment(
        profile_h: HSTRING,
        options: ICoreWebView2EnvironmentOptions,
    ) -> std::result::Result<ICoreWebView2Environment, HostFailure> {
        let (tx, rx) = mpsc::channel();
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                CreateCoreWebView2EnvironmentWithOptions(
                    PCWSTR::null(),
                    PCWSTR(profile_h.as_ptr()),
                    &options,
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error_code, environment| {
                error_code?;
                tx.send(environment.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                    .map_err(|_| windows::core::Error::from(E_POINTER))?;
                Ok(())
            }),
        )
        .map_err(|_| {
            HostFailure::new("browser-host-environment-unavailable", "environment-create")
        })?;
        rx.recv()
            .map_err(|_| {
                HostFailure::new("browser-host-environment-unavailable", "environment-create")
            })?
            .map_err(|_| {
                HostFailure::new("browser-host-environment-unavailable", "environment-create")
            })
    }

    fn verify_environment_profile(
        environment: &ICoreWebView2Environment,
        profile: &Path,
    ) -> std::result::Result<(), HostFailure> {
        let environment7: ICoreWebView2Environment7 = environment.cast().map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-udf-verify",
            )
        })?;
        let mut actual = PWSTR::null();
        unsafe { environment7.UserDataFolder(&mut actual) }.map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-udf-verify",
            )
        })?;
        let actual = PathBuf::from(CoTaskMemPWSTR::from(actual).to_string())
            .canonicalize()
            .map_err(|_| {
                HostFailure::new(
                    "browser-host-environment-unavailable",
                    "environment-udf-verify",
                )
            })?;
        let expected = profile.canonicalize().map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-udf-verify",
            )
        })?;
        if actual == expected {
            Ok(())
        } else {
            Err(HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-udf-verify",
            ))
        }
    }

    fn create_controller(
        environment: &ICoreWebView2Environment,
        hwnd: HWND,
    ) -> std::result::Result<Controller, HostFailure> {
        let (tx, rx) = mpsc::channel();
        let environment = environment.clone();
        CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                environment
                    .CreateCoreWebView2Controller(hwnd, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error_code, controller| {
                error_code?;
                tx.send(controller.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                    .map_err(|_| windows::core::Error::from(E_POINTER))?;
                Ok(())
            }),
        )
        .map_err(|_| {
            HostFailure::new("browser-host-controller-unavailable", "controller-create")
        })?;
        Ok(Controller(
            rx.recv()
                .map_err(|_| {
                    HostFailure::new("browser-host-controller-unavailable", "controller-create")
                })?
                .map_err(|_| {
                    HostFailure::new("browser-host-controller-unavailable", "controller-create")
                })?,
        ))
    }

    fn configure_production_settings(webview: &ICoreWebView2) -> HostResult<()> {
        let settings = unsafe { webview.Settings() }.map_err(|_| ())?;
        unsafe {
            settings
                .SetAreDefaultContextMenusEnabled(false)
                .map_err(|_| ())?;
            settings.SetAreDevToolsEnabled(false).map_err(|_| ())?;
            settings.SetIsStatusBarEnabled(false).map_err(|_| ())?;
            settings
                .SetAreDefaultScriptDialogsEnabled(false)
                .map_err(|_| ())?;
            settings.SetIsWebMessageEnabled(false).map_err(|_| ())?;
            settings.SetAreHostObjectsAllowed(false).map_err(|_| ())?;
        }
        let settings4: ICoreWebView2Settings4 = settings.cast().map_err(|_| ())?;
        unsafe {
            settings4
                .SetIsGeneralAutofillEnabled(false)
                .map_err(|_| ())?;
            settings4
                .SetIsPasswordAutosaveEnabled(false)
                .map_err(|_| ())?;
        }
        Ok(())
    }

    fn install_agent_network_lockdown(webview: &ICoreWebView2) -> HostResult<()> {
        let webview = webview.clone();
        AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                let script = CoTaskMemPWSTR::from(AGENT_NETWORK_LOCKDOWN_SCRIPT);
                webview
                    .AddScriptToExecuteOnDocumentCreated(*script.as_ref().as_pcwstr(), &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(|error_code, script_id| {
                error_code?;
                if script_id.is_empty() {
                    Err(windows::core::Error::from(E_POINTER))
                } else {
                    Ok(())
                }
            }),
        )
        .map_err(|_| ())
    }

    fn verify_profile_storage_written(profile: &Path) -> HostResult<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if fs::read_dir(profile)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false)
            {
                return Ok(());
            }
            pump_for(Duration::from_millis(25));
        }
        Err(())
    }

    fn attach_production_handlers(
        environment: &ICoreWebView2Environment,
        webview: &ICoreWebView2,
        state: Arc<Mutex<ProductionState>>,
        test_fixture_port: Option<u16>,
        agent_handler: Option<AgentResourceHandler>,
        agent_top_level_policy: Option<Arc<Mutex<AgentTopLevelPolicy>>>,
    ) -> HostResult<()> {
        let response_environment = environment.clone();
        let mut token = 0i64;
        unsafe {
            // The v22 request-source-kind filter omitted parser-originated
            // scripts on supported WebView2 runtimes. Use the established
            // all-context filter for the Agent host as well, so every document
            // and subresource is mediated by the authenticated gateway.
            webview
                .AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
                .map_err(|_| ())?;
            webview
                .add_WebResourceRequested(
                    &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let request = args.Request()?;
                            let mut uri = PWSTR::null();
                            request.Uri(&mut uri)?;
                            let uri = CoTaskMemPWSTR::from(uri).to_string();
                            if let Some(handler) = agent_handler.as_ref() {
                                if uri == "about:blank" {
                                    return Ok(());
                                }
                                let mut method = PWSTR::null();
                                request.Method(&mut method)?;
                                let method = CoTaskMemPWSTR::from(method).to_string();
                                let mut resource_context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                                args.ResourceContext(&mut resource_context)?;
                                let is_document =
                                    resource_context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT;
                                if !handler.active.load(Ordering::Acquire)
                                    || !matches!(method.as_str(), "GET" | "HEAD")
                                    || handler.pending.borrow().len() >= MAX_PENDING_AGENT_RESOURCES
                                {
                                    immediate_agent_block(&handler.environment, &args);
                                    return Ok(());
                                }
                                let deferral = match args.GetDeferral() {
                                    Ok(value) => value,
                                    Err(_) => {
                                        immediate_agent_block(&handler.environment, &args);
                                        return Ok(());
                                    }
                                };
                                let id = handler.next_id.get();
                                handler.next_id.set(id.saturating_add(1).max(1));
                                handler.pending.borrow_mut().insert(
                                    id,
                                    PendingAgentResponse {
                                        args: args.clone(),
                                        request,
                                        deferral: Some(deferral),
                                        deadline: Instant::now() + AGENT_RESOURCE_DEADLINE,
                                        is_document,
                                    },
                                );
                                if handler
                                    .job_tx
                                    .send(AgentFetchJob {
                                        id,
                                        method,
                                        url: uri,
                                    })
                                    .is_err()
                                {
                                    if let Some(pending) = handler.pending.borrow_mut().remove(&id)
                                    {
                                        complete_agent_response(
                                            &handler.environment,
                                            &handler.top_level_policy,
                                            pending,
                                            Err(()),
                                        );
                                    }
                                }
                            } else if subresource_target_is_forbidden(&uri, test_fixture_port) {
                                let _ = request.SetUri(w!("about:blank"));
                                let content = SHCreateMemStream(Some(b"blocked"))
                                    .ok_or_else(|| windows::core::Error::from(E_POINTER))?;
                                let blocked_response = response_environment
                                    .CreateWebResourceResponse(
                                        &content,
                                        403,
                                        w!("Blocked"),
                                        w!("Content-Type: text/plain"),
                                    )?;
                                args.SetResponse(&blocked_response)?;
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            let navigation_state = Arc::clone(&state);
            let navigation_policy = agent_top_level_policy.clone();
            let projects_agent_document_token = agent_top_level_policy.is_some();
            webview
                .add_NavigationStarting(
                    &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut navigation_id = 0u64;
                            args.NavigationId(&mut navigation_id)?;
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            let uri = CoTaskMemPWSTR::from(uri).to_string();
                            if uri == "about:blank" {
                                return Ok(());
                            }
                            match validated_top_level_url(&uri, test_fixture_port) {
                                Ok(target) => {
                                    if navigation_policy.as_ref().is_some_and(|policy| {
                                        !policy
                                            .lock()
                                            .unwrap_or_else(|error| error.into_inner())
                                            .permits(&target)
                                    }) {
                                        args.SetCancel(true)?;
                                        let mut state = navigation_state
                                            .lock()
                                            .unwrap_or_else(|error| error.into_inner());
                                        state.status = "error";
                                        state.title =
                                            Some("agent-browser-navigation-denied".to_owned());
                                        state.document_token = None;
                                        state.navigation_id = Some(navigation_id);
                                        return Ok(());
                                    }
                                    let mut state = navigation_state
                                        .lock()
                                        .unwrap_or_else(|error| error.into_inner());
                                    state.status = "loading";
                                    state.origin = safe_origin(&target);
                                    state.document_token = projects_agent_document_token
                                        .then(|| browser_document_token(target.as_str()));
                                    state.navigation_id = Some(navigation_id);
                                    state.title = None;
                                    state.generation = state.generation.saturating_add(1);
                                }
                                Err(failure) => {
                                    args.SetCancel(true)?;
                                    let mut state = navigation_state
                                        .lock()
                                        .unwrap_or_else(|error| error.into_inner());
                                    state.status = "error";
                                    state.title = Some(failure.code.to_owned());
                                    state.document_token = None;
                                    state.navigation_id = Some(navigation_id);
                                }
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            webview
                .add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            webview
                .add_NewWindowRequested(
                    &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            args.SetHandled(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            let webview4: ICoreWebView2_4 = webview.cast().map_err(|_| ())?;
            webview4
                .add_DownloadStarting(
                    &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            args.SetCancel(true)?;
                            args.SetHandled(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            let complete_state = Arc::clone(&state);
            webview
                .add_NavigationCompleted(
                    &NavigationCompletedEventHandler::create(Box::new(move |webview, args| {
                        if let (Some(webview), Some(args)) = (webview, args) {
                            let mut navigation_id = 0u64;
                            args.NavigationId(&mut navigation_id)?;
                            let mut success = BOOL(0);
                            args.IsSuccess(&mut success)?;
                            let mut web_error = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                            args.WebErrorStatus(&mut web_error)?;
                            let mut can_back = BOOL(0);
                            let mut can_forward = BOOL(0);
                            webview.CanGoBack(&mut can_back)?;
                            webview.CanGoForward(&mut can_forward)?;
                            let mut title = PWSTR::null();
                            webview.DocumentTitle(&mut title)?;
                            let title = bounded_title(&CoTaskMemPWSTR::from(title).to_string());
                            let mut state = complete_state
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            if state.navigation_id != Some(navigation_id) {
                                return Ok(());
                            }
                            if state.status == "loading" {
                                state.status = if success.as_bool() { "loaded" } else { "error" };
                                state.title = if success.as_bool() {
                                    title
                                } else {
                                    Some(navigation_failure_phase(web_error).to_owned())
                                };
                            } else if state.status == "loaded" && title.is_some() {
                                // A top-level DOMContentLoaded event can make an Agent page
                                // safely readable before slow subresources finish. Preserve that
                                // usable state even if the later completion reports a subresource
                                // failure.
                                state.title = title;
                            }
                            state.can_go_back = can_back.as_bool();
                            state.can_go_forward = can_forward.as_bool();
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            if agent_top_level_policy.is_some() {
                let dom_state = Arc::clone(&state);
                let dom_webview: ICoreWebView2_2 = webview.cast().map_err(|_| ())?;
                dom_webview
                    .add_DOMContentLoaded(
                        &DOMContentLoadedEventHandler::create(Box::new(move |webview, args| {
                            if let (Some(webview), Some(args)) = (webview, args) {
                                let mut navigation_id = 0u64;
                                args.NavigationId(&mut navigation_id)?;
                                let mut source = PWSTR::null();
                                webview.Source(&mut source)?;
                                let source = CoTaskMemPWSTR::from(source).to_string();
                                let Ok(target) =
                                    validated_top_level_url(&source, test_fixture_port)
                                else {
                                    return Ok(());
                                };
                                let mut title = PWSTR::null();
                                webview.DocumentTitle(&mut title)?;
                                let title = bounded_title(&CoTaskMemPWSTR::from(title).to_string());
                                let mut state =
                                    dom_state.lock().unwrap_or_else(|error| error.into_inner());
                                if state.status == "loading"
                                    && state.navigation_id == Some(navigation_id)
                                    && state.origin == safe_origin(&target)
                                    && state.document_token.is_some()
                                {
                                    state.status = "loaded";
                                    state.title = title;
                                }
                            }
                            Ok(())
                        })),
                        &mut token,
                    )
                    .map_err(|_| ())?;
            }
            let source_state = Arc::clone(&state);
            let source_projects_agent_document_token = agent_top_level_policy.is_some();
            webview
                .add_SourceChanged(
                    &SourceChangedEventHandler::create(Box::new(move |webview, _| {
                        if let Some(webview) = webview {
                            let mut source = PWSTR::null();
                            webview.Source(&mut source)?;
                            let source = CoTaskMemPWSTR::from(source).to_string();
                            if let Ok(target) = validated_top_level_url(&source, test_fixture_port)
                            {
                                let mut state = source_state
                                    .lock()
                                    .unwrap_or_else(|error| error.into_inner());
                                state.origin = safe_origin(&target);
                                state.document_token = source_projects_agent_document_token
                                    .then(|| browser_document_token(target.as_str()));
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            let title_state = Arc::clone(&state);
            webview
                .add_DocumentTitleChanged(
                    &DocumentTitleChangedEventHandler::create(Box::new(move |webview, _| {
                        if let Some(webview) = webview {
                            let mut title = PWSTR::null();
                            webview.DocumentTitle(&mut title)?;
                            title_state
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .title = bounded_title(&CoTaskMemPWSTR::from(title).to_string());
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            let history_state = Arc::clone(&state);
            webview
                .add_HistoryChanged(
                    &HistoryChangedEventHandler::create(Box::new(move |webview, _| {
                        if let Some(webview) = webview {
                            let mut can_back = BOOL(0);
                            let mut can_forward = BOOL(0);
                            webview.CanGoBack(&mut can_back)?;
                            webview.CanGoForward(&mut can_forward)?;
                            let mut state = history_state
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            state.can_go_back = can_back.as_bool();
                            state.can_go_forward = can_forward.as_bool();
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
        }
        Ok(())
    }

    fn bounded_title(value: &str) -> Option<String> {
        let title: String = value
            .chars()
            .filter(|character| !character.is_control())
            .take(256)
            .collect();
        if title.is_empty() {
            None
        } else {
            Some(title)
        }
    }

    const AGENT_READ_SCRIPT: &str = r#"(()=>{
      const clean=(value)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
      const clip=(value,max)=>{const text=clean(value);const enc=new TextEncoder();if(enc.encode(text).length<=max)return text;let lo=0,hi=text.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(enc.encode(text.slice(0,mid)).length<=max)lo=mid;else hi=mid-1;}return text.slice(0,lo).trimEnd();};
      const visible=clip(document.body?.innerText||'',24576);
      return {kind:'read',host:location.hostname.toLowerCase(),title:clip(document.title,512),visibleText:visible,characterCount:[...visible].length};
    })()"#;

    fn agent_extract_script(
        kind: AgentExtractKind,
        index: Option<usize>,
    ) -> std::result::Result<String, HostFailure> {
        let body = match kind {
            AgentExtractKind::Main => {
                if index.is_some() {
                    return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
                }
                "const root=document.querySelector('main')||document.body;return {kind:'main',host:location.hostname.toLowerCase(),title:clip(document.title,512),visibleText:clip(root?.innerText||'',24576)};".to_owned()
            }
            AgentExtractKind::Article => {
                if index.is_some() {
                    return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
                }
                "const root=document.querySelector('article')||document.querySelector('main')||document.body;return {kind:'article',host:location.hostname.toLowerCase(),title:clip(document.title,512),visibleText:clip(root?.innerText||'',24576)};".to_owned()
            }
            AgentExtractKind::Headings => {
                if index.is_some() {
                    return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
                }
                "const items=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0,64).map(node=>({level:Number(node.tagName.slice(1)),text:clip(node.innerText||node.textContent||'',512)})).filter(item=>item.text);return {kind:'headings',host:location.hostname.toLowerCase(),items};".to_owned()
            }
            AgentExtractKind::Links => {
                if index.is_some() {
                    return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
                }
                "const items=[];for(const node of [...document.querySelectorAll('a[href]')]){if(items.length>=64)break;try{const target=new URL(node.href,location.href);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)continue;const label=clip(node.innerText||node.getAttribute('aria-label')||'',512);if(!label)continue;items.push({label,host:target.hostname.toLowerCase(),url:target.href});}catch{}}return {kind:'links',host:location.hostname.toLowerCase(),items};".to_owned()
            }
            AgentExtractKind::Table => {
                let index = index.unwrap_or(0);
                if index > 15 {
                    return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
                }
                format!("const table=document.querySelectorAll('table')[{index}];const rows=table?[...table.rows].slice(0,40).map(row=>[...row.cells].slice(0,20).map(cell=>clip(cell.innerText||cell.textContent||'',512))):[];return {{kind:'table',host:location.hostname.toLowerCase(),index:{index},rows}};")
            }
        };
        Ok(format!(
            r#"(()=>{{
          const clean=(value)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[ \t]+/g,' ').replace(/\n{{3,}}/g,'\n\n').trim();
          const clip=(value,max)=>{{const text=clean(value);const enc=new TextEncoder();if(enc.encode(text).length<=max)return text;let lo=0,hi=text.length;while(lo<hi){{const mid=Math.ceil((lo+hi)/2);if(enc.encode(text.slice(0,mid)).length<=max)lo=mid;else hi=mid-1;}}return text.slice(0,lo).trimEnd();}};
          {body}
        }})()"#
        ))
    }

    fn sanitize_agent_result(mut value: Value) -> std::result::Result<Value, HostFailure> {
        fn visit(value: &mut Value, depth: usize) -> bool {
            if depth > 6 {
                return false;
            }
            match value {
                Value::String(text) => {
                    let mut clean = String::new();
                    for character in text.chars() {
                        if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
                            continue;
                        }
                        if matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
                            continue;
                        }
                        if clean.len().saturating_add(character.len_utf8()) > 24 * 1024 {
                            break;
                        }
                        clean.push(character);
                    }
                    *text = clean;
                    true
                }
                Value::Array(items) => {
                    if items.len() > 128 {
                        return false;
                    }
                    items.iter_mut().all(|item| visit(item, depth + 1))
                }
                Value::Object(object) => {
                    if object.len() > 16 {
                        return false;
                    }
                    object.values_mut().all(|item| visit(item, depth + 1))
                }
                Value::Null | Value::Bool(_) | Value::Number(_) => true,
            }
        }
        if !visit(&mut value, 0) {
            return Err(HostFailure::new(
                "browser-result-too-large",
                "result-budget",
            ));
        }
        if let Some(object) = value.as_object_mut() {
            if object.contains_key("characterCount") {
                let count = object
                    .get("visibleText")
                    .and_then(Value::as_str)
                    .map(|text| text.chars().count())
                    .ok_or_else(|| HostFailure::new("browser-result-invalid", "result-shape"))?;
                object.insert("characterCount".into(), Value::from(count));
            }
        }
        if serde_json::to_vec(&value)
            .map(|bytes| bytes.len() > 60 * 1024)
            .unwrap_or(true)
        {
            return Err(HostFailure::new(
                "browser-result-too-large",
                "result-budget",
            ));
        }
        Ok(value)
    }

    fn safe_origin(target: &url::Url) -> Option<String> {
        let origin = target.origin().ascii_serialization();
        if origin == "null" || origin.len() > 512 {
            None
        } else {
            Some(origin)
        }
    }

    fn validated_top_level_url(
        value: &str,
        test_fixture_port: Option<u16>,
    ) -> std::result::Result<url::Url, HostFailure> {
        if value.is_empty()
            || value.len() > 8192
            || value.chars().any(|character| character.is_control())
        {
            return Err(HostFailure::new(
                "browser-navigation-invalid",
                "navigation-validate",
            ));
        }
        let target = url::Url::parse(value)
            .map_err(|_| HostFailure::new("browser-navigation-invalid", "navigation-validate"))?;
        if !matches!(target.scheme(), "http" | "https") {
            return Err(HostFailure::new(
                "browser-navigation-scheme-denied",
                "navigation-policy",
            ));
        }
        if !target.username().is_empty() || target.password().is_some() {
            return Err(HostFailure::new(
                "browser-navigation-userinfo-denied",
                "navigation-policy",
            ));
        }
        let host = target
            .host()
            .ok_or_else(|| HostFailure::new("browser-navigation-invalid", "navigation-validate"))?;
        if let (Some(allowed_port), url::Host::Ipv4(address)) = (test_fixture_port, host.clone()) {
            if fixture_runtime_enabled()
                && target.scheme() == "http"
                && address == Ipv4Addr::LOCALHOST
                && target.port() == Some(allowed_port)
            {
                return Ok(target);
            }
        }
        if host_is_forbidden(host) {
            return Err(HostFailure::new(
                "browser-navigation-private-target",
                "navigation-policy",
            ));
        }
        Ok(target)
    }

    fn subresource_target_is_forbidden(value: &str, test_fixture_port: Option<u16>) -> bool {
        let Ok(target) = url::Url::parse(value) else {
            return true;
        };
        if matches!(target.scheme(), "data" | "blob") {
            return false;
        }
        if !matches!(target.scheme(), "http" | "https") {
            return true;
        }
        validated_top_level_url(value, test_fixture_port).is_err()
    }

    fn host_is_forbidden(host: url::Host<&str>) -> bool {
        match host {
            url::Host::Domain(domain) => {
                let domain = domain.trim_end_matches('.').to_ascii_lowercase();
                domain == "localhost" || domain.ends_with(".localhost")
            }
            url::Host::Ipv4(address) => ipv4_is_forbidden(address),
            url::Host::Ipv6(address) => ipv6_is_forbidden(address),
        }
    }

    fn ipv4_is_forbidden(address: Ipv4Addr) -> bool {
        let [a, b, c, _] = address.octets();
        a == 0
            || a == 10
            || a == 127
            || (a == 100 && (64..=127).contains(&b))
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 192 && b == 0 && c == 0)
            || (a == 192 && b == 0 && c == 2)
            || (a == 198 && (b == 18 || b == 19))
            || (a == 198 && b == 51 && c == 100)
            || (a == 203 && b == 0 && c == 113)
            || a >= 224
    }

    fn ipv6_is_forbidden(address: Ipv6Addr) -> bool {
        if address.is_unspecified() || address.is_loopback() || address.is_multicast() {
            return true;
        }
        let segments = address.segments();
        if (segments[0] & 0xfe00) == 0xfc00
            || (segments[0] & 0xffc0) == 0xfe80
            || (segments[0] & 0xffc0) == 0xfec0
            || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        {
            return true;
        }
        if segments[..5] == [0, 0, 0, 0, 0] && (segments[5] == 0 || segments[5] == 0xffff) {
            let mapped = Ipv4Addr::new(
                (segments[6] >> 8) as u8,
                segments[6] as u8,
                (segments[7] >> 8) as u8,
                segments[7] as u8,
            );
            return ipv4_is_forbidden(mapped);
        }
        false
    }

    #[cfg(test)]
    mod production_policy_tests {
        use super::*;

        #[test]
        fn production_navigation_rejects_local_credentials_controls_and_non_http_schemes() {
            for target in [
                "http://127.0.0.1/",
                "http://localhost/",
                "http://service.localhost/",
                "http://10.0.0.1/",
                "http://169.254.169.254/latest/meta-data/",
                "http://[::1]/",
                "http://[::ffff:127.0.0.1]/",
                "https://user:password@example.com/",
                "file:///secret",
                "data:text/plain,secret",
                "javascript:alert(1)",
                "https://example.com/\u{0}hidden",
            ] {
                assert!(
                    validated_top_level_url(target, None).is_err(),
                    "target={target:?}"
                );
            }
        }

        #[cfg(feature = "browser-host-poc-fixture")]
        #[test]
        fn production_fixture_exception_is_exact_to_its_test_port() {
            assert!(validated_top_level_url("http://127.0.0.1:32123/page", Some(32123)).is_ok());
            assert!(validated_top_level_url("http://127.0.0.1:32124/page", Some(32123)).is_err());
            assert!(
                validated_top_level_url("http://user@127.0.0.1:32123/page", Some(32123)).is_err()
            );
        }

        #[test]
        fn agent_result_budget_handles_worst_case_json_escaping_and_strips_controls() {
            let hostile = format!("{}\u{0}\u{202e}PRIVATE", "\\\"".repeat(20 * 1024));
            let value = sanitize_agent_result(serde_json::json!({
                "kind":"read",
                "host":"example.org",
                "title":"safe",
                "visibleText":hostile,
                "characterCount":0
            }));
            assert!(value.is_ok());
            let value = match value {
                Ok(value) => value,
                Err(_) => unreachable!("checked"),
            };
            let visible = value["visibleText"].as_str().unwrap();
            assert!(visible.as_bytes().len() <= 24 * 1024);
            assert!(!visible.contains('\u{0}') && !visible.contains('\u{202e}'));
            assert_eq!(
                value["characterCount"].as_u64().unwrap() as usize,
                visible.chars().count()
            );
            assert!(serde_json::to_vec(&value).unwrap().len() < 60 * 1024);
        }
    }

    fn prepare_production_profile(
        test_fixture_id: Option<&str>,
        embed_profile_id: Option<&str>,
    ) -> HostResult<PathBuf> {
        let (base, components): (PathBuf, Vec<String>) = if let Some(id) = test_fixture_id {
            (
                std::env::temp_dir(),
                vec![
                    "luckyray-browser-host-production-tests-v1".into(),
                    "personal".into(),
                    profile_fingerprint(id),
                ],
            )
        } else {
            let known =
                unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None) }
                    .map_err(|_| ())?;
            let suffix = embed_profile_id
                .map(|id| vec!["tabs".into(), profile_fingerprint(id)])
                .unwrap_or_else(|| vec!["default".into()]);
            let mut components = vec!["LuckyRay".into(), "BrowserHost".into(), "personal".into()];
            components.extend(suffix);
            (
                PathBuf::from(CoTaskMemPWSTR::from(known).to_string()),
                components,
            )
        };
        let base = base.canonicalize().map_err(|_| ())?;
        let mut current = base.clone();
        for component in components {
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
                Ok(_) => return Err(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&current).map_err(|_| ())?;
                }
                Err(_) => return Err(()),
            }
        }
        let canonical = current.canonicalize().map_err(|_| ())?;
        if canonical.starts_with(base) {
            Ok(canonical)
        } else {
            Err(())
        }
    }

    fn prepare_agent_profile(requested: &Path) -> HostResult<PathBuf> {
        if !requested.is_absolute() {
            return Err(());
        }
        let temp = std::env::temp_dir().canonicalize().map_err(|_| ())?;
        let base = temp.join("LuckyRay").join("AgentBrowser").join("v1");
        let base = base.canonicalize().map_err(|_| ())?;
        let metadata = fs::symlink_metadata(requested).map_err(|_| ())?;
        if !metadata.is_dir() || is_reparse(&metadata) {
            return Err(());
        }
        let canonical = requested.canonicalize().map_err(|_| ())?;
        if canonical == base || !canonical.starts_with(&base) {
            return Err(());
        }
        if fs::read_dir(&canonical).map_err(|_| ())?.next().is_some() {
            return Err(());
        }
        Ok(canonical)
    }

    fn agent_browser_arguments(gateway_port: u16) -> String {
        format!(
            "--proxy-server=http://127.0.0.1:{gateway_port} \
             --proxy-bypass-list=<-loopback> \
             --host-resolver-rules=\"MAP * ~NOTFOUND, EXCLUDE 127.0.0.1\" \
             --disable-quic \
             --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
             --disable-background-networking \
             --disable-component-update \
             --disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"
        )
    }

    fn pump_messages() {
        unsafe {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    pub(super) struct FixtureSession {
        controller: Option<Controller>,
        webview: Option<ICoreWebView2>,
        environment: Option<ICoreWebView2Environment>,
        environment_exit_source: Option<ICoreWebView2Environment5>,
        browser_process_exit: Option<mpsc::Receiver<()>>,
        hwnd: HWND,
        evidence: SecurityEvidence,
        storage: Option<Value>,
        lease: Option<ProfileLease>,
    }

    impl FixtureSession {
        pub(super) fn evidence(&self) -> &SecurityEvidence {
            &self.evidence
        }

        pub(super) fn storage(&self) -> Option<&Value> {
            self.storage.as_ref()
        }

        pub(super) fn shutdown(&mut self) -> std::result::Result<(), HostFailure> {
            if let Some(controller) = self.controller.as_ref() {
                unsafe { controller.0.Close() }.map_err(|_| {
                    HostFailure::new("browser-host-close-incomplete", "controller-close")
                })?;
            }
            pump_for(Duration::from_millis(50));
            self.webview.take();
            self.controller.take();
            if let Some(exit) = self.browser_process_exit.take() {
                wait_for_signal(exit, Duration::from_secs(20)).map_err(|_| {
                    HostFailure::new("browser-host-close-incomplete", "browser-process-exit")
                })?;
            }
            self.environment_exit_source.take();
            self.environment.take();
            self.lease.take();
            unsafe {
                let _ = DestroyWindow(self.hwnd);
            }
            self.hwnd = HWND::default();
            Ok(())
        }
    }

    impl Drop for FixtureSession {
        fn drop(&mut self) {
            if self.shutdown().is_err() && !self.hwnd.is_invalid() {
                unsafe {
                    let _ = DestroyWindow(self.hwnd);
                }
            }
        }
    }

    pub(super) fn open(
        workspace_id: &str,
        url: &str,
        storage_mode: Option<TestStorageMode>,
        expected_navigation_denials: u8,
    ) -> std::result::Result<FixtureSession, HostFailure> {
        if !(1..=8).contains(&expected_navigation_denials) {
            return Err(HostFailure::new(
                "browser-host-fixture-contract-invalid",
                "fixture-contract",
            ));
        }
        let allowed_origin = parse_test_url(url)
            .map_err(|_| HostFailure::new("browser-host-fixture-url-invalid", "fixture-url"))?;
        for key in [
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            "WEBVIEW2_USER_DATA_FOLDER",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
        ] {
            std::env::remove_var(key);
        }
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|_| HostFailure::new("browser-host-com-unavailable", "com-initialize"))?;
        let profile = prepare_profile(workspace_id, true)
            .map_err(|_| HostFailure::new("browser-host-profile-unavailable", "profile-prepare"))?;
        let lease = open_profile_lease(&profile)
            .map_err(|_| HostFailure::new("browser-host-profile-unavailable", "profile-lease"))?;
        let hwnd = create_hidden_window()
            .map_err(|_| HostFailure::new("browser-host-window-unavailable", "window-create"))?;
        create_session(
            hwnd,
            &profile,
            url,
            &allowed_origin,
            lease,
            storage_mode,
            expected_navigation_denials,
        )
    }

    fn create_hidden_window() -> HostResult<HWND> {
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            lpszClassName: w!("LuckyRayBrowserHostPoc"),
            ..Default::default()
        };
        unsafe {
            let _ = RegisterClassW(&class);
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("LuckyRayBrowserHostPoc"),
                w!("LuckyRay Browser Host POC"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                800,
                600,
                None,
                None,
                GetModuleHandleW(None)
                    .ok()
                    .map(|module| HINSTANCE(module.0)),
                None,
            )
            .map_err(|_| ())
        }
    }

    fn create_session(
        hwnd: HWND,
        profile: &Path,
        url: &str,
        allowed_origin: &FixtureOrigin,
        lease: ProfileLease,
        storage_mode: Option<TestStorageMode>,
        expected_navigation_denials: u8,
    ) -> std::result::Result<FixtureSession, HostFailure> {
        let options: ICoreWebView2EnvironmentOptions =
            webview2_com::CoreWebView2EnvironmentOptions::default().into();
        let options2: ICoreWebView2EnvironmentOptions2 = options.cast().map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-options",
            )
        })?;
        unsafe { options2.SetExclusiveUserDataFolderAccess(true) }.map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-options",
            )
        })?;
        let profile_h = HSTRING::from(profile.as_os_str());
        let environment = (|| -> HostResult<ICoreWebView2Environment> {
            let (tx, rx) = mpsc::channel();
            let profile_h = profile_h.clone();
            let options = options.clone();
            CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| unsafe {
                    CreateCoreWebView2EnvironmentWithOptions(
                        PCWSTR::null(),
                        PCWSTR(profile_h.as_ptr()),
                        &options,
                        &handler,
                    )
                    .map_err(webview2_com::Error::WindowsError)
                }),
                Box::new(move |error_code, environment| {
                    error_code?;
                    tx.send(environment.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                        .map_err(|_| windows::core::Error::from(E_POINTER))?;
                    Ok(())
                }),
            )
            .map_err(|_| ())?;
            rx.recv().map_err(|_| ())?.map_err(|_| ())
        })()
        .map_err(|_| {
            HostFailure::new("browser-host-environment-unavailable", "environment-create")
        })?;
        let environment7: ICoreWebView2Environment7 = environment.cast().map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-udf-verify",
            )
        })?;
        let mut actual_profile = PWSTR::null();
        unsafe { environment7.UserDataFolder(&mut actual_profile) }.map_err(|_| {
            HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-udf-verify",
            )
        })?;
        let actual_profile = PathBuf::from(CoTaskMemPWSTR::from(actual_profile).to_string())
            .canonicalize()
            .map_err(|_| {
                HostFailure::new(
                    "browser-host-environment-unavailable",
                    "environment-udf-verify",
                )
            })?;
        if actual_profile
            != profile.canonicalize().map_err(|_| {
                HostFailure::new(
                    "browser-host-environment-unavailable",
                    "environment-udf-verify",
                )
            })?
        {
            return Err(HostFailure::new(
                "browser-host-environment-unavailable",
                "environment-udf-verify",
            ));
        }
        let controller = (|| -> HostResult<Controller> {
            let (tx, rx) = mpsc::channel();
            let environment = environment.clone();
            CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| unsafe {
                    environment
                        .CreateCoreWebView2Controller(hwnd, &handler)
                        .map_err(webview2_com::Error::WindowsError)
                }),
                Box::new(move |error_code, controller| {
                    error_code?;
                    tx.send(controller.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                        .map_err(|_| windows::core::Error::from(E_POINTER))?;
                    Ok(())
                }),
            )
            .map_err(|_| ())?;
            Ok(Controller(rx.recv().map_err(|_| ())?.map_err(|_| ())?))
        })()
        .map_err(|_| {
            HostFailure::new("browser-host-controller-unavailable", "controller-create")
        })?;
        unsafe {
            controller
                .0
                .SetBounds(RECT {
                    left: 0,
                    top: 0,
                    right: 800,
                    bottom: 600,
                })
                .map_err(|_| {
                    HostFailure::new("browser-host-controller-unavailable", "controller-create")
                })?;
            controller.0.SetIsVisible(false).map_err(|_| {
                HostFailure::new("browser-host-controller-unavailable", "controller-create")
            })?;
        }
        let webview = unsafe { controller.0.CoreWebView2() }
            .map_err(|_| HostFailure::new("browser-host-webview-unavailable", "webview-create"))?;
        let environment5: ICoreWebView2Environment5 = environment.cast().map_err(|_| {
            HostFailure::new("browser-host-webview-unavailable", "browser-process-bind")
        })?;
        let (browser_exit_tx, browser_process_exit) = mpsc::channel();
        let mut browser_exit_token = 0i64;
        unsafe {
            environment5
                .add_BrowserProcessExited(
                    &BrowserProcessExitedEventHandler::create(Box::new(move |_, args| {
                        if args.is_some() {
                            let _ = browser_exit_tx.send(());
                        }
                        Ok(())
                    })),
                    &mut browser_exit_token,
                )
                .map_err(|_| {
                    HostFailure::new("browser-host-webview-unavailable", "browser-process-bind")
                })?;
        }
        configure_settings(&webview).map_err(|_| {
            HostFailure::new("browser-host-webview-unavailable", "webview-settings")
        })?;
        let permission = Arc::new(AtomicUsize::new(0));
        let popup = Arc::new(AtomicUsize::new(0));
        let download = Arc::new(AtomicUsize::new(0));
        let navigation = Arc::new(AtomicUsize::new(0));
        let blocked_response = unsafe {
            environment.CreateWebResourceResponse(
                None::<&IStream>,
                403,
                w!("Blocked"),
                w!("Content-Type: text/plain"),
            )
        }
        .map_err(|_| HostFailure::new("browser-host-webview-unavailable", "handlers-installed"))?;
        attach_security_handlers(
            &webview,
            blocked_response,
            allowed_origin.clone(),
            Arc::clone(&permission),
            Arc::clone(&popup),
            Arc::clone(&download),
            Arc::clone(&navigation),
        )
        .map_err(|_| HostFailure::new("browser-host-webview-unavailable", "handlers-installed"))?;
        let (start_tx, start_rx) = mpsc::channel();
        let (tx, rx) = mpsc::channel();
        let mut token = 0i64;
        unsafe {
            let initial_url = url.to_string();
            webview
                .add_NavigationStarting(
                    &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            let uri = CoTaskMemPWSTR::from(uri).to_string();
                            if uri == initial_url {
                                let mut navigation_id = 0u64;
                                args.NavigationId(&mut navigation_id)?;
                                let _ = start_tx.send(navigation_id);
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| {
                    HostFailure::new("browser-host-navigation-failed", "navigation-start")
                })?;
            webview
                .add_NavigationCompleted(
                    &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                        let result = if let Some(args) = args {
                            let mut navigation_id = 0u64;
                            args.NavigationId(&mut navigation_id)?;
                            let mut success = BOOL(0);
                            args.IsSuccess(&mut success)?;
                            let mut web_error = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                            args.WebErrorStatus(&mut web_error)?;
                            (navigation_id, success.as_bool(), web_error)
                        } else {
                            (0, false, COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN)
                        };
                        let _ = tx.send(result);
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| {
                    HostFailure::new("browser-host-navigation-failed", "navigation-start")
                })?;
            let target = HSTRING::from(url);
            webview.Navigate(PCWSTR(target.as_ptr())).map_err(|_| {
                HostFailure::new("browser-host-navigation-failed", "navigation-start")
            })?;
        }
        let initial_navigation_id = wait_for_value(start_rx, Duration::from_secs(5))
            .map_err(|_| HostFailure::new("browser-host-navigation-failed", "navigation-start"))?;
        let (initial_navigation_succeeded, web_error) =
            wait_for_navigation(rx, initial_navigation_id, Duration::from_secs(5)).map_err(
                |_| HostFailure::new("browser-host-navigation-failed", "navigation-complete"),
            )?;
        if !initial_navigation_succeeded {
            return Err(HostFailure::new(
                "browser-host-navigation-failed",
                navigation_failure_phase(web_error),
            ));
        }
        start_page_security_probe(&webview)
            .map_err(|_| HostFailure::new("browser-host-page-probe-failed", "page-probe-start"))?;
        wait_for_page_probe(&webview, Duration::from_secs(5))
            .map_err(|_| HostFailure::new("browser-host-page-probe-failed", "page-probe"))?;
        pump_until_security(
            Duration::from_secs(5),
            [&permission, &popup, &download, &navigation],
            expected_navigation_denials as usize,
        )
        .map_err(|_| HostFailure::new("browser-host-security-probe-failed", "security-probes"))?;
        execute_readiness_probe(&webview).map_err(|_| {
            HostFailure::new("browser-host-readiness-probe-failed", "profile-write-probe")
        })?;
        let storage = match storage_mode {
            Some(mode) => Some(execute_storage_probe(&webview, mode).map_err(|_| {
                HostFailure::new("browser-host-storage-probe-failed", "storage-probe")
            })?),
            None => None,
        };
        let evidence = SecurityEvidence {
            permission_denied: permission.load(Ordering::SeqCst),
            popup_denied: popup.load(Ordering::SeqCst),
            download_denied: download.load(Ordering::SeqCst),
            navigation_denied: navigation.load(Ordering::SeqCst),
        };
        Ok(FixtureSession {
            controller: Some(controller),
            webview: Some(webview),
            environment: Some(environment),
            environment_exit_source: Some(environment5),
            browser_process_exit: Some(browser_process_exit),
            hwnd,
            evidence,
            storage,
            lease: Some(lease),
        })
    }

    fn configure_settings(webview: &ICoreWebView2) -> HostResult<()> {
        let settings = unsafe { webview.Settings() }.map_err(|_| ())?;
        unsafe {
            settings
                .SetAreDefaultContextMenusEnabled(false)
                .map_err(|_| ())?;
            settings.SetAreDevToolsEnabled(false).map_err(|_| ())?;
            settings.SetIsStatusBarEnabled(false).map_err(|_| ())?;
        }
        Ok(())
    }

    fn execute_storage_probe(webview: &ICoreWebView2, mode: TestStorageMode) -> HostResult<Value> {
        let script = match mode {
            TestStorageMode::Set => "(()=>{const before=localStorage.getItem('luckyray-poc-isolation');localStorage.setItem('luckyray-poc-isolation','workspace-a-value');return JSON.stringify({before,after:localStorage.getItem('luckyray-poc-isolation')})})()",
            TestStorageMode::Read => "localStorage.getItem('luckyray-poc-isolation')",
        };
        let outer = execute_script(webview, script)?;
        match mode {
            TestStorageMode::Set => {
                let encoded = outer.as_str().ok_or(())?;
                serde_json::from_str(encoded).map_err(|_| ())
            }
            TestStorageMode::Read => Ok(outer),
        }
    }

    fn execute_readiness_probe(webview: &ICoreWebView2) -> HostResult<()> {
        let result = execute_script(
            webview,
            "(()=>{localStorage.setItem('luckyray-poc-session-ready','1');return localStorage.getItem('luckyray-poc-session-ready')==='1'})()",
        )?;
        if result == Value::Bool(true) {
            Ok(())
        } else {
            Err(())
        }
    }

    fn wait_for_page_probe(webview: &ICoreWebView2, duration: Duration) -> HostResult<()> {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            let value = execute_script(webview, "window.__luckyrayPocProbeComplete ?? null")?;
            let verified = [
                "tauriAbsent",
                "internalsAbsent",
                "tauriIpcAbsent",
                "wryIpcAbsent",
                "externalInvokeAbsent",
            ]
            .iter()
            .all(|key| value.get(key) == Some(&Value::Bool(true)));
            if verified {
                return Ok(());
            }
            pump_for(Duration::from_millis(25));
        }
        Err(())
    }

    fn start_page_security_probe(webview: &ICoreWebView2) -> HostResult<()> {
        let started = execute_script(
            webview,
            "(()=>{if(typeof window.__luckyrayStartSecurityProbe!=='function')return false;window.__luckyrayStartSecurityProbe();return true})()",
        )?;
        if started == Value::Bool(true) {
            Ok(())
        } else {
            Err(())
        }
    }

    fn execute_script(webview: &ICoreWebView2, script: &str) -> HostResult<Value> {
        let webview = webview.clone();
        let script = HSTRING::from(script);
        let (tx, rx) = mpsc::channel();
        ExecuteScriptCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                webview
                    .ExecuteScript(PCWSTR(script.as_ptr()), &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error_code, result| {
                error_code?;
                tx.send(result)
                    .map_err(|_| windows::core::Error::from(E_POINTER))?;
                Ok(())
            }),
        )
        .map_err(|_| ())?;
        let json = rx.recv().map_err(|_| ())?;
        serde_json::from_str(&json).map_err(|_| ())
    }

    fn attach_security_handlers(
        webview: &ICoreWebView2,
        blocked_response: ICoreWebView2WebResourceResponse,
        allowed_origin: FixtureOrigin,
        permission: Arc<AtomicUsize>,
        popup: Arc<AtomicUsize>,
        download: Arc<AtomicUsize>,
        navigation: Arc<AtomicUsize>,
    ) -> HostResult<()> {
        let mut token = 0i64;
        unsafe {
            webview
                .AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
                .map_err(|_| ())?;
            let network_origin = allowed_origin.clone();
            let network_denied = Arc::clone(&navigation);
            webview
                .add_WebResourceRequested(
                    &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let request = args.Request()?;
                            let mut uri = PWSTR::null();
                            request.Uri(&mut uri)?;
                            let uri = CoTaskMemPWSTR::from(uri).to_string();
                            if !network_origin.matches_navigation(&uri) {
                                network_denied.fetch_add(1, Ordering::SeqCst);
                                args.SetResponse(&blocked_response)?;
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            webview
                .add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            permission.fetch_add(1, Ordering::SeqCst);
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            webview
                .add_NewWindowRequested(
                    &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            popup.fetch_add(1, Ordering::SeqCst);
                            args.SetHandled(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            let webview4: ICoreWebView2_4 = webview.cast().map_err(|_| ())?;
            webview4
                .add_DownloadStarting(
                    &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            download.fetch_add(1, Ordering::SeqCst);
                            args.SetCancel(true)?;
                            args.SetHandled(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
            webview
                .add_NavigationStarting(
                    &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            let uri = CoTaskMemPWSTR::from(uri).to_string();
                            if !allowed_origin.matches_navigation(&uri) {
                                navigation.fetch_add(1, Ordering::SeqCst);
                                args.SetCancel(true)?;
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| ())?;
        }
        Ok(())
    }

    #[derive(Clone)]
    struct FixtureOrigin {
        port: u16,
    }

    impl FixtureOrigin {
        fn matches_navigation(&self, value: &str) -> bool {
            exact_loopback_url(value, self.port, false).is_ok()
        }
    }

    fn parse_test_url(value: &str) -> HostResult<FixtureOrigin> {
        let parsed = exact_loopback_url(value, 0, true)?;
        let path = parsed.path().strip_prefix('/').ok_or(())?;
        if path.len() < 16
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !path
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'/'))
        {
            return Err(());
        }
        Ok(FixtureOrigin {
            port: parsed.port().ok_or(())?,
        })
    }

    fn exact_loopback_url(
        value: &str,
        expected_port: u16,
        require_path: bool,
    ) -> HostResult<url::Url> {
        let parsed = url::Url::parse(value).map_err(|_| ())?;
        let port = parsed.port().ok_or(())?;
        let authority = value
            .strip_prefix("http://")
            .and_then(|rest| rest.split_once('/').map(|(authority, _)| authority))
            .ok_or(())?;
        if parsed.scheme() != "http"
            || parsed.username() != ""
            || parsed.password().is_some()
            || parsed.host() != Some(url::Host::Ipv4(Ipv4Addr::LOCALHOST))
            || port == 0
            || (expected_port != 0 && port != expected_port)
            || authority != format!("127.0.0.1:{port}")
            || (require_path && parsed.path() == "/")
        {
            return Err(());
        }
        Ok(parsed)
    }

    fn prepare_profile(workspace_id: &str, test_mode: bool) -> HostResult<PathBuf> {
        let root = if test_mode {
            std::env::temp_dir().join("luckyray-browser-host-poc-tests-v1")
        } else {
            let path =
                unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None) }
                    .map_err(|_| ())?;
            PathBuf::from(CoTaskMemPWSTR::from(path).to_string())
                .join("LuckyRay")
                .join("browser-host")
        };
        let relative = PathBuf::from("personal").join(profile_fingerprint(workspace_id));
        fs::create_dir_all(&root).map_err(|_| ())?;
        let root = root.canonicalize().map_err(|_| ())?;
        let mut current = root.clone();
        for component in relative.components() {
            let Component::Normal(component) = component else {
                return Err(());
            };
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if !metadata.is_dir() || is_reparse(&metadata) {
                        return Err(());
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir(&current).map_err(|_| ())?;
                }
                Err(_) => return Err(()),
            }
        }
        let canonical = current.canonicalize().map_err(|_| ())?;
        if !canonical.starts_with(root) {
            return Err(());
        }
        Ok(canonical)
    }

    fn is_reparse(metadata: &fs::Metadata) -> bool {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }

    fn open_profile_lease(profile: &Path) -> HostResult<ProfileLease> {
        let wide: Vec<u16> = OsStr::new(profile)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                FILE_LIST_DIRECTORY.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                None,
            )
        }
        .map_err(|_| ())?;
        Ok(ProfileLease(handle))
    }

    fn pump_for(duration: Duration) {
        let deadline = Instant::now() + duration;
        let mut message = MSG::default();
        while Instant::now() < deadline {
            unsafe {
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_for_value<T>(rx: mpsc::Receiver<T>, duration: Duration) -> HostResult<T> {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            match rx.try_recv() {
                Ok(value) => return Ok(value),
                Err(mpsc::TryRecvError::Disconnected) => return Err(()),
                Err(mpsc::TryRecvError::Empty) => pump_for(Duration::from_millis(25)),
            }
        }
        Err(())
    }

    fn wait_for_signal(rx: mpsc::Receiver<()>, duration: Duration) -> HostResult<()> {
        wait_for_value(rx, duration)
    }

    fn wait_for_navigation(
        rx: mpsc::Receiver<(u64, bool, COREWEBVIEW2_WEB_ERROR_STATUS)>,
        initial_navigation_id: u64,
        duration: Duration,
    ) -> HostResult<(bool, COREWEBVIEW2_WEB_ERROR_STATUS)> {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            match rx.try_recv() {
                Ok((navigation_id, success, web_error))
                    if navigation_id == initial_navigation_id =>
                {
                    return Ok((success, web_error));
                }
                Ok(_) | Err(mpsc::TryRecvError::Empty) => pump_for(Duration::from_millis(25)),
                Err(mpsc::TryRecvError::Disconnected) => return Err(()),
            }
        }
        Err(())
    }

    fn navigation_failure_phase(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> &'static str {
        match status {
            COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => "navigation-cannot-connect",
            COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED => "navigation-connection-aborted",
            COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET => "navigation-connection-reset",
            COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "navigation-disconnected",
            COREWEBVIEW2_WEB_ERROR_STATUS_ERROR_HTTP_INVALID_SERVER_RESPONSE => {
                "navigation-invalid-response"
            }
            COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED => "navigation-operation-canceled",
            COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED => "navigation-redirect-failed",
            COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => "navigation-server-unreachable",
            COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => "navigation-timeout",
            _ => "navigation-complete",
        }
    }

    fn pump_until_security(
        duration: Duration,
        counters: [&Arc<AtomicUsize>; 4],
        expected_navigation_denials: usize,
    ) -> HostResult<()> {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            pump_for(Duration::from_millis(25));
            if counters[1].load(Ordering::SeqCst) > 0
                && counters[2].load(Ordering::SeqCst) > 0
                && counters[3].load(Ordering::SeqCst) >= expected_navigation_denials
            {
                return Ok(());
            }
        }
        Err(())
    }
}
