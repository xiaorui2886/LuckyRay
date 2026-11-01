//! MCP 2025-11-25 stdio adapter for LuckyRay's process-owned Tool Registry.
//!
//! This module is a protocol adapter only. It discovers and calls the running
//! desktop application through the proof-verified LocalTransport `ToolClient`.
//! It never initializes backend services or opens Vault, SQLite, or app-data
//! business files directly.

use crate::tool_client::{ToolClient, ToolClientError};
use rand::{rngs::OsRng, RngCore};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResult, ContentBlock, ErrorCode, Implementation,
        InitializeRequestParams, InitializeResult, JsonObject, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, RequestId, ServerCapabilities, ServerInfo, Tool,
        ToolAnnotations,
    },
    service::RequestContext,
    ErrorData as McpError, RoleServer, ServerHandler, ServiceExt,
};
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Write as _};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const MCP_PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V_2025_11_25;
const MCP_COMPAT_PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V_2025_06_18;
const MCP_REQUEST_ID_TTL: Duration = Duration::from_secs(5 * 60);
const MCP_REQUEST_ID_CAPACITY: usize = 256;
const MCP_JSON_RPC_ID_MAX_BYTES: usize = 256;
const MCP_MAX_INPUT_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const fn checked_product(left: usize, right: usize) -> usize {
    match left.checked_mul(right) {
        Some(value) => value,
        None => panic!("MCP byte budget overflow"),
    }
}

const fn checked_sum(left: usize, right: usize) -> usize {
    match left.checked_add(right) {
        Some(value) => value,
        None => panic!("MCP byte budget overflow"),
    }
}

// Tool Registry v1 permits 512 KiB public results. A logical byte can require a
// six-byte JSON control escape, and structured MCP output carries that JSON once
// as structuredContent plus once as JSON text (at most two encoded copies).
// 512 KiB * 6 * (1 + 2), plus a fixed envelope/schema allowance, bounds every
// current registry result and tools/list definition without relying on samples.
const MCP_BACKEND_MAX_PUBLIC_OUTPUT_BYTES: usize = 512 * 1024;
const MCP_JSON_ESCAPE_MAX_FACTOR: usize = 6;
const MCP_STRUCTURED_AND_TEXT_FACTOR: usize = 3;
const MCP_OUTPUT_ENVELOPE_MAX_BYTES: usize = 256 * 1024;
const MCP_MAX_OUTPUT_MESSAGE_BYTES: usize = checked_sum(
    checked_product(
        checked_product(
            MCP_BACKEND_MAX_PUBLIC_OUTPUT_BYTES,
            MCP_JSON_ESCAPE_MAX_FACTOR,
        ),
        MCP_STRUCTURED_AND_TEXT_FACTOR,
    ),
    MCP_OUTPUT_ENVELOPE_MAX_BYTES,
);
const MCP_MAX_OUTPUT_READ_AHEAD_BYTES: usize = checked_product(MCP_MAX_OUTPUT_MESSAGE_BYTES, 2);
const MCP_BRIDGE_BYTES: usize = 64 * 1024;
// A single bounded frame can occupy the full cap; queueing one frame gives the
// stdio bridge a hard aggregate retained-output budget equal to that cap.
const MCP_OUTPUT_QUEUE: usize = 1;
const MCP_MAX_AGGREGATE_OUTPUT_BYTES: usize = checked_sum(
    checked_sum(
        MCP_MAX_OUTPUT_READ_AHEAD_BYTES,
        checked_product(MCP_MAX_OUTPUT_MESSAGE_BYTES, MCP_OUTPUT_QUEUE),
    ),
    MCP_BRIDGE_BYTES,
);

#[derive(Clone)]
enum Connector {
    Production,
    #[cfg(test)]
    Test {
        app_data: std::path::PathBuf,
        ports: Vec<u16>,
    },
}

impl Connector {
    fn connect(&self) -> Result<ToolClient, ToolClientError> {
        match self {
            Self::Production => ToolClient::connect(),
            #[cfg(test)]
            Self::Test { app_data, ports } => ToolClient::connect_with(app_data, ports.clone()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum BackendToolRisk {
    Read,
    Write,
    Dangerous,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendToolAvailability {
    available: bool,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendToolDefinition {
    id: String,
    version: u32,
    title: String,
    description: String,
    risk: BackendToolRisk,
    input_schema: Value,
    output_schema: Value,
    availability: BackendToolAvailability,
    idempotency: String,
    max_input_bytes: usize,
    max_output_bytes: usize,
}

enum AdapterFailure {
    Client(ToolClientError),
    Protocol,
}

impl From<ToolClientError> for AdapterFailure {
    fn from(error: ToolClientError) -> Self {
        Self::Client(error)
    }
}

#[derive(Clone)]
struct RequestIdentityState {
    session_nonce: [u8; 16],
    entries: Arc<Mutex<HashMap<[u8; 32], RequestIdentityEntry>>>,
}

#[derive(Clone)]
struct RequestIdentityEntry {
    call_digest: [u8; 32],
    backend_request_id: String,
    last_seen: Instant,
}

impl RequestIdentityState {
    fn new() -> Self {
        let mut session_nonce = [0u8; 16];
        OsRng.fill_bytes(&mut session_nonce);
        Self {
            session_nonce,
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn backend_request_id(
        &self,
        json_rpc_id: &impl serde::Serialize,
        tool_name: &str,
        arguments: &Value,
    ) -> Result<String, McpCallFailure> {
        let id_bytes = serde_json::to_vec(json_rpc_id)
            .map_err(|_| McpCallFailure::new("mcp-request-id-invalid"))?;
        if id_bytes.len() > MCP_JSON_RPC_ID_MAX_BYTES {
            return Err(McpCallFailure::new("mcp-request-id-invalid"));
        }
        let id_digest: [u8; 32] = Sha256::digest(&id_bytes).into();
        let mut call_hasher = Sha256::new();
        call_hasher.update(tool_name.as_bytes());
        call_hasher.update([0]);
        call_hasher.update(canonical_json_bytes(arguments));
        let call_digest: [u8; 32] = call_hasher.finalize().into();

        let now = Instant::now();
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| McpCallFailure::new("mcp-request-state-unavailable"))?;
        entries
            .retain(|_, entry| now.saturating_duration_since(entry.last_seen) < MCP_REQUEST_ID_TTL);
        if let Some(entry) = entries.get_mut(&id_digest) {
            if entry.call_digest != call_digest {
                return Err(McpCallFailure::new("request-id-conflict"));
            }
            entry.last_seen = now;
            return Ok(entry.backend_request_id.clone());
        }
        if entries.len() >= MCP_REQUEST_ID_CAPACITY {
            return Err(McpCallFailure::new("tool-request-capacity"));
        }
        let backend_request_id = format!(
            "mcp-{}-{}",
            hex_prefix(&self.session_nonce, self.session_nonce.len()),
            hex_prefix(&id_digest, 16)
        );
        entries.insert(
            id_digest,
            RequestIdentityEntry {
                call_digest,
                backend_request_id: backend_request_id.clone(),
                last_seen: now,
            },
        );
        Ok(backend_request_id)
    }
}

#[derive(Clone, Copy, Debug)]
struct McpCallFailure {
    code: &'static str,
}

impl McpCallFailure {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }
}

#[derive(Clone)]
struct LuckyRayMcpServer {
    connector: Connector,
    request_ids: RequestIdentityState,
}

impl LuckyRayMcpServer {
    fn production() -> Self {
        Self::new(Connector::Production)
    }

    fn new(connector: Connector) -> Self {
        Self {
            connector,
            request_ids: RequestIdentityState::new(),
        }
    }
}

impl ServerHandler for LuckyRayMcpServer {
    fn get_info(&self) -> ServerInfo {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(MCP_PROTOCOL_VERSION)
            .with_server_info(
                Implementation::new("luckyray-mcp", env!("CARGO_PKG_VERSION"))
                    .with_title("LuckyRay MCP")
                    .with_description("Proof-verified adapter for LuckyRay tools"),
            )
    }

    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, McpError> {
        if request.protocol_version != MCP_PROTOCOL_VERSION
            && request.protocol_version != MCP_COMPAT_PROTOCOL_VERSION
        {
            return Err(McpError::invalid_params(
                "Unsupported MCP protocol version",
                Some(json!({"supported":["2025-11-25","2025-06-18"]})),
            ));
        }
        let negotiated_version = request.protocol_version.clone();
        context.peer.set_peer_info(request);
        Ok(self.get_info().with_protocol_version(negotiated_version))
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        if request.and_then(|params| params.cursor).is_some() {
            return Err(McpError::invalid_params(
                "LuckyRay tools/list does not use cursors",
                None,
            ));
        }
        let connector = self.connector.clone();
        let definitions = tokio::task::spawn_blocking(move || load_definitions(&connector))
            .await
            .map_err(|_| safe_registry_error("tool-adapter-unavailable"))?
            .map_err(|error| match error {
                AdapterFailure::Client(error) => safe_registry_error(error.code()),
                AdapterFailure::Protocol => safe_registry_error("protocol-incompatible"),
            })?;
        let tools = definitions
            .into_iter()
            .filter(|definition| {
                definition.availability.available && mcp_output_supported(definition)
            })
            .map(to_mcp_tool)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let tool_name = request.name.into_owned();
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        let connector = self.connector.clone();
        let connected = tokio::task::spawn_blocking(move || {
            let client = connector.connect()?;
            let definitions = parse_definitions(client.list_tools()?)?;
            Ok::<_, AdapterFailure>((client, definitions))
        })
        .await;
        let (client, definitions) = match connected {
            Err(_) => return Ok(call_failure("tool-adapter-unavailable", None)),
            Ok(Err(AdapterFailure::Client(error))) => return Ok(safe_tool_client_result(&error)),
            Ok(Err(AdapterFailure::Protocol)) => {
                return Ok(call_failure("protocol-incompatible", None))
            }
            Ok(Ok(connected)) => connected,
        };
        let Some(definition) = definitions
            .iter()
            .find(|definition| definition.id == tool_name)
        else {
            return Err(McpError::new(
                ErrorCode::INVALID_PARAMS,
                "Unknown tool",
                Some(json!({"code":"tool-not-found"})),
            ));
        };
        if !mcp_output_supported(definition) {
            return Ok(call_failure("mcp-tool-output-unsupported", None));
        }

        let mut backend_input = arguments.clone();
        let request_id = if definition.risk == BackendToolRisk::Read {
            None
        } else {
            let request_id =
                match self
                    .request_ids
                    .backend_request_id(&context.id, &tool_name, &arguments)
                {
                    Ok(value) => value,
                    Err(error) => return Ok(call_failure(error.code, None)),
                };
            if let Some(object) = backend_input.as_object_mut() {
                object.insert("requestId".to_string(), Value::String(request_id.clone()));
            }
            Some(request_id)
        };
        let name_for_run = tool_name.clone();
        let result = tokio::task::spawn_blocking(move || {
            client.run_tool(&name_for_run, backend_input, request_id.as_deref())
        })
        .await
        .map_err(|_| safe_registry_error("tool-adapter-unavailable"))?;
        match result {
            Ok(result) => {
                if result.get("toolId").and_then(Value::as_str) != Some(tool_name.as_str()) {
                    return Ok(call_failure("protocol-incompatible", None));
                }
                let Some(output) = result.get("result").cloned() else {
                    return Ok(call_failure("protocol-incompatible", None));
                };
                Ok(bounded_success_result(&context.id, definition.risk, output))
            }
            Err(error) => Ok(safe_tool_client_result(&error)),
        }
    }
}

fn load_definitions(connector: &Connector) -> Result<Vec<BackendToolDefinition>, AdapterFailure> {
    let client = connector.connect()?;
    parse_definitions(client.list_tools()?)
}

fn parse_definitions(value: Value) -> Result<Vec<BackendToolDefinition>, AdapterFailure> {
    serde_json::from_value(value).map_err(|_| AdapterFailure::Protocol)
}

fn mcp_output_supported(definition: &BackendToolDefinition) -> bool {
    definition.max_output_bytes <= MCP_BACKEND_MAX_PUBLIC_OUTPUT_BYTES
}

fn to_mcp_tool(definition: BackendToolDefinition) -> Result<Tool, McpError> {
    let input_schema = value_as_schema(definition.input_schema)?;
    let output_schema = value_as_schema(definition.output_schema)?;
    let annotations = ToolAnnotations::new()
        .read_only(definition.risk == BackendToolRisk::Read)
        .destructive(definition.risk == BackendToolRisk::Dangerous)
        .idempotent(definition.risk == BackendToolRisk::Read)
        .open_world(definition.id == "capability.run");
    let mut tool = Tool::new_with_raw(
        definition.id,
        Some(definition.description.into()),
        Arc::new(input_schema),
    )
    .with_title(definition.title)
    .with_raw_output_schema(Arc::new(output_schema))
    .with_annotations(annotations);
    tool.execution = None;
    let _ = (
        definition.version,
        definition.idempotency,
        definition.max_input_bytes,
        definition.max_output_bytes,
        definition.availability.code,
        definition.availability.reason,
    );
    Ok(tool)
}

fn value_as_schema(value: Value) -> Result<JsonObject, McpError> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| safe_registry_error("tool-schema-invalid"))
}

fn safe_registry_error(code: &str) -> McpError {
    McpError::internal_error(
        "LuckyRay tool registry is unavailable",
        Some(json!({"code":safe_code(code)})),
    )
}

fn safe_tool_client_result(error: &ToolClientError) -> CallToolResult {
    call_failure(error.code(), error.status())
}

fn bounded_success_result(
    request_id: &RequestId,
    risk: BackendToolRisk,
    output: Value,
) -> CallToolResult {
    let result = CallToolResult::structured(output);
    let frame = json!({"jsonrpc":"2.0","id":request_id,"result":&result});
    if serde_json::to_vec(&frame)
        .ok()
        .is_some_and(|bytes| bytes.len() <= MCP_MAX_OUTPUT_MESSAGE_BYTES)
    {
        return result;
    }
    if risk == BackendToolRisk::Read {
        return call_failure("mcp-output-too-large", None);
    }
    // Registry definitions above the proven MCP bound are rejected before
    // dispatch. This last-resort branch protects against a violated backend
    // contract after a mutation may already have committed and therefore must
    // not invite an automatic retry by reporting an ordinary failure.
    CallToolResult::success(vec![ContentBlock::text(
        "Tool committed, but its result exceeded the MCP response limit. Do not retry automatically.",
    )])
}

fn call_failure(code: &str, status: Option<u16>) -> CallToolResult {
    let code = safe_code(code);
    let message = match code {
        "app-unavailable" => "Open LuckyRay and retry",
        "authentication-unavailable" | "authentication-failed" => {
            "LuckyRay authentication is unavailable"
        }
        "protocol-incompatible" => "Update LuckyRay or the MCP adapter",
        "knowledge-vault-required" => "Open or create a Vault",
        "knowledge-vault-not-current" | "knowledge-vault-changed" => {
            "The requested Vault is not current"
        }
        "knowledge-revision-conflict" => "The Knowledge document revision changed",
        "request-id-conflict" => "The MCP request id was reused with different arguments",
        "tool-request-capacity" => "The MCP request capacity is exhausted",
        "mcp-request-id-invalid" => "The MCP request id is invalid",
        _ => "LuckyRay tool execution failed",
    };
    CallToolResult::error(vec![ContentBlock::text(
        json!({"code":code,"message":message,"status":status}).to_string(),
    )])
}

fn safe_code(code: &str) -> &str {
    if !code.is_empty()
        && code.len() <= 96
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        code
    } else {
        "tool-request-failed"
    }
}

fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let mut keys = object.keys().collect::<Vec<_>>();
                keys.sort();
                let mut result = serde_json::Map::new();
                for key in keys {
                    result.insert(key.clone(), canonical(&object[key]));
                }
                Value::Object(result)
            }
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            _ => value.clone(),
        }
    }
    serde_json::to_vec(&canonical(value)).unwrap_or_else(|_| b"null".to_vec())
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    bytes
        .iter()
        .take(count)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

struct StrictJson(Value);

impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictJsonVisitor)
    }
}

struct StrictJsonVisitor;

impl<'de> Visitor<'de> for StrictJsonVisitor {
    type Value = StrictJson;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictJson(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(StrictJson(Value::Number(value.into())))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(StrictJson(Value::Number(value.into())))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .map(StrictJson)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(StrictJson(Value::String(value.to_string())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictJson(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJson(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJson(Value::Null))
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        StrictJson::deserialize(deserializer)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<StrictJson>()? {
            values.push(value.0);
        }
        Ok(StrictJson(Value::Array(values)))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut seen = HashSet::new();
        let mut values = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom("duplicate JSON object key"));
            }
            let value = map.next_value::<StrictJson>()?;
            values.insert(key, value.0);
        }
        Ok(StrictJson(Value::Object(values)))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InputLifecycle {
    AwaitInitialize,
    AwaitInitialized,
    Ready,
}

#[derive(Debug)]
struct ValidatedMessage {
    bytes: Vec<u8>,
    method: String,
    id: Option<Value>,
}

struct StrictInputError {
    code: i64,
    message: &'static str,
    id: Option<Value>,
    respond: bool,
}

impl StrictInputError {
    fn response(&self) -> Option<Vec<u8>> {
        if !self.respond {
            return None;
        }
        let mut bytes = serde_json::to_vec(&json!({
            "jsonrpc":"2.0",
            "id":self.id.clone().unwrap_or(Value::Null),
            "error":{"code":self.code,"message":self.message},
        }))
        .ok()?;
        bytes.push(b'\n');
        Some(bytes)
    }
}

fn validate_stdio_message(bytes: Vec<u8>) -> Result<ValidatedMessage, StrictInputError> {
    let StrictJson(value) =
        serde_json::from_slice::<StrictJson>(&bytes).map_err(|_| StrictInputError {
            code: -32700,
            message: "Parse error",
            id: None,
            respond: true,
        })?;
    let object = value.as_object().ok_or(StrictInputError {
        code: -32600,
        message: "Invalid Request",
        id: None,
        respond: true,
    })?;
    let raw_id = object.get("id").cloned();
    let id = match raw_id {
        Some(Value::String(value)) => Some(Value::String(value)),
        Some(Value::Number(value)) => Some(Value::Number(value)),
        Some(_) => {
            return Err(StrictInputError {
                code: -32600,
                message: "Invalid Request",
                id: None,
                respond: true,
            })
        }
        None => None,
    };
    let notification = id.is_none();
    if object.get("jsonrpc") != Some(&Value::String("2.0".to_string()))
        || !object
            .keys()
            .all(|key| matches!(key.as_str(), "jsonrpc" | "id" | "method" | "params"))
    {
        return Err(StrictInputError {
            code: -32600,
            message: "Invalid Request",
            id,
            respond: !notification,
        });
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or(StrictInputError {
            code: -32600,
            message: "Invalid Request",
            id: id.clone(),
            respond: !notification,
        })?
        .to_string();
    validate_method_params(&method, object.get("params"), id.clone(), notification)?;
    Ok(ValidatedMessage { bytes, method, id })
}

fn validate_method_params(
    method: &str,
    params: Option<&Value>,
    id: Option<Value>,
    notification: bool,
) -> Result<(), StrictInputError> {
    let fail = || StrictInputError {
        code: -32602,
        message: "Invalid params",
        id: id.clone(),
        respond: !notification,
    };
    let params_object = params_as_object(params).ok_or_else(fail)?;
    let keys_allowed = |object: &JsonObject, allowed: &[&str]| {
        object
            .keys()
            .all(|key| allowed.iter().any(|allowed| key == allowed))
    };
    match method {
        "initialize" => {
            if notification {
                return Err(fail());
            }
            let object = params_object.ok_or_else(fail)?;
            if !keys_allowed(
                object,
                &["protocolVersion", "capabilities", "clientInfo", "_meta"],
            ) || !object.contains_key("protocolVersion")
                || !object.contains_key("capabilities")
                || !object.contains_key("clientInfo")
                || !object["protocolVersion"].is_string()
                || !object["capabilities"].is_object()
                || !object["clientInfo"].is_object()
            {
                return Err(fail());
            }
        }
        "notifications/initialized" => {
            if !notification || params_object.is_some_and(|object| !object.is_empty()) {
                return Err(fail());
            }
        }
        "ping" => {
            if notification || params_object.is_some_and(|object| !object.is_empty()) {
                return Err(fail());
            }
        }
        "tools/list" => {
            if notification {
                return Err(fail());
            }
            if let Some(object) = params_object {
                if !keys_allowed(object, &["cursor", "_meta"])
                    || object.get("cursor").is_some_and(|value| !value.is_string())
                {
                    return Err(fail());
                }
            }
        }
        "tools/call" => {
            if notification {
                return Err(fail());
            }
            let object = params_object.ok_or_else(fail)?;
            if !keys_allowed(object, &["name", "arguments", "_meta"])
                || !object.get("name").is_some_and(Value::is_string)
                || object
                    .get("arguments")
                    .is_some_and(|value| !value.is_object())
            {
                return Err(fail());
            }
        }
        "notifications/cancelled" => {
            if !notification {
                return Err(fail());
            }
            let object = params_object.ok_or_else(fail)?;
            if !keys_allowed(object, &["requestId", "reason", "_meta"])
                || !object.contains_key("requestId")
            {
                return Err(fail());
            }
        }
        _ => {}
    }
    Ok(())
}

fn params_as_object(value: Option<&Value>) -> Option<Option<&JsonObject>> {
    match value {
        None => Some(None),
        Some(Value::Object(object)) => Some(Some(object)),
        _ => None,
    }
}

enum BoundedLine {
    Eof,
    Line(Vec<u8>),
    Oversize,
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> io::Result<BoundedLine> {
    let mut line = Vec::new();
    let mut oversize = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if oversize {
                Ok(BoundedLine::Oversize)
            } else if line.is_empty() {
                Ok(BoundedLine::Eof)
            } else {
                Ok(BoundedLine::Line(line))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consume = newline.map_or(available.len(), |index| index + 1);
        let content = if newline.is_some() {
            &available[..consume - 1]
        } else {
            &available[..consume]
        };
        if !oversize {
            if line.len().saturating_add(content.len()) > max_bytes {
                line.clear();
                oversize = true;
            } else {
                line.extend_from_slice(content);
            }
        }
        reader.consume(consume);
        if newline.is_some() {
            if oversize {
                return Ok(BoundedLine::Oversize);
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(BoundedLine::Line(line));
        }
    }
}

async fn forward_stdin<R, W>(
    input: R,
    mut bridge: W,
    output: mpsc::Sender<Vec<u8>>,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut input = BufReader::new(input);
    let mut lifecycle = InputLifecycle::AwaitInitialize;
    loop {
        let decision = match read_bounded_line(&mut input, MCP_MAX_INPUT_MESSAGE_BYTES).await? {
            BoundedLine::Eof => break,
            BoundedLine::Oversize => {
                let error = StrictInputError {
                    code: -32600,
                    message: "MCP message is too large",
                    id: None,
                    respond: true,
                };
                if let Some(response) = error.response() {
                    let _ = output.send(response).await;
                }
                continue;
            }
            BoundedLine::Line(bytes) if bytes.is_empty() => continue,
            BoundedLine::Line(bytes) => validate_stdio_message(bytes),
        };
        let message = match decision {
            Ok(message) => message,
            Err(error) => {
                if let Some(response) = error.response() {
                    let _ = output.send(response).await;
                }
                continue;
            }
        };
        let lifecycle_error = match message.method.as_str() {
            "ping" => false,
            "initialize" if lifecycle == InputLifecycle::AwaitInitialize => {
                lifecycle = InputLifecycle::AwaitInitialized;
                false
            }
            "notifications/initialized" if lifecycle == InputLifecycle::AwaitInitialized => {
                lifecycle = InputLifecycle::Ready;
                false
            }
            _ => lifecycle != InputLifecycle::Ready,
        };
        if lifecycle_error {
            let respond = message.id.is_some();
            let error = StrictInputError {
                code: -32600,
                message: "MCP initialization is incomplete",
                id: message.id,
                respond,
            };
            if let Some(response) = error.response() {
                let _ = output.send(response).await;
            }
            continue;
        }
        bridge.write_all(&message.bytes).await?;
        bridge.write_all(b"\n").await?;
        bridge.flush().await?;
    }
    bridge.shutdown().await
}

async fn forward_sdk_output<R>(input: R, output: mpsc::Sender<Vec<u8>>) -> io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut input = BufReader::new(input);
    loop {
        match read_bounded_line(&mut input, MCP_MAX_OUTPUT_READ_AHEAD_BYTES).await? {
            BoundedLine::Eof => return Ok(()),
            BoundedLine::Oversize => {
                let mut response = bounded_output_overflow_response(&[]);
                response.push(b'\n');
                if output.send(response).await.is_err() {
                    return Ok(());
                }
            }
            BoundedLine::Line(mut line) => {
                if line.len() > MCP_MAX_OUTPUT_MESSAGE_BYTES {
                    line = bounded_output_overflow_response(&line);
                }
                line.push(b'\n');
                if output.send(line).await.is_err() {
                    return Ok(());
                }
            }
        }
    }
}

fn bounded_output_overflow_response(line: &[u8]) -> Vec<u8> {
    let parsed = serde_json::from_slice::<Value>(line).ok();
    let id = parsed
        .as_ref()
        .and_then(|value| value.get("id").cloned())
        .filter(|value| value.is_string() || value.is_number())
        .unwrap_or(Value::Null);
    if parsed
        .as_ref()
        .and_then(|value| value.pointer("/result/isError"))
        == Some(&Value::Bool(false))
    {
        return serde_json::to_vec(&json!({
            "jsonrpc":"2.0",
            "id":id,
            "result":{
                "content":[{"type":"text","text":"Tool committed, but its result exceeded the MCP response limit. Do not retry automatically."}],
                "isError":false
            }
        }))
        .unwrap_or_default();
    }
    serde_json::to_vec(&json!({
        "jsonrpc":"2.0",
        "id":id,
        "error":{"code":-32603,"message":"MCP response exceeded its bounded adapter limit"}
    }))
    .unwrap_or_else(|_| b"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"MCP response unavailable\"}}".to_vec())
}

async fn write_stdout<W>(mut output: W, mut messages: mpsc::Receiver<Vec<u8>>) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    while let Some(message) = messages.recv().await {
        output.write_all(&message).await?;
        output.flush().await?;
    }
    Ok(())
}

async fn serve_stdio<R, W>(input: R, output: W, handler: LuckyRayMcpServer) -> Result<(), ()>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    debug_assert!(MCP_MAX_AGGREGATE_OUTPUT_BYTES >= MCP_MAX_OUTPUT_MESSAGE_BYTES);
    let (bridge_client, bridge_server) = tokio::io::duplex(MCP_BRIDGE_BYTES);
    let (bridge_read, bridge_write) = tokio::io::split(bridge_client);
    let (output_sender, output_receiver) = mpsc::channel(MCP_OUTPUT_QUEUE);
    let writer = tokio::spawn(write_stdout(output, output_receiver));
    let sdk_output = tokio::spawn(forward_sdk_output(bridge_read, output_sender.clone()));
    let stdin = tokio::spawn(forward_stdin(input, bridge_write, output_sender.clone()));
    drop(output_sender);

    let outcome = match handler.serve(bridge_server).await {
        Ok(server) => server.waiting().await.map(|_| ()).map_err(|_| ()),
        Err(_) => Err(()),
    };
    stdin.abort();
    let _ = stdin.await;
    let _ = sdk_output.await;
    let _ = writer.await;
    outcome
}

async fn run_async() -> Result<(), ()> {
    serve_stdio(
        tokio::io::stdin(),
        tokio::io::stdout(),
        LuckyRayMcpServer::production(),
    )
    .await
}

#[derive(Clone, Copy)]
enum PrintConfigTarget {
    Codex,
    Json,
}

fn parse_process_args<I>(args: I) -> Result<Option<PrintConfigTarget>, ()>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args = args.into_iter();
    let Some(flag) = args.next() else {
        return Ok(None);
    };
    if flag != "--print-config" {
        return Err(());
    }
    let target = match args.next().as_deref() {
        Some(value) if value == "codex" => PrintConfigTarget::Codex,
        Some(value) if value == "json" => PrintConfigTarget::Json,
        _ => return Err(()),
    };
    if args.next().is_some() {
        return Err(());
    }
    Ok(Some(target))
}

fn render_config(target: PrintConfigTarget, executable: &Path) -> Result<String, ()> {
    let command = executable.to_str().ok_or(())?;
    match target {
        PrintConfigTarget::Codex => {
            let quoted_command = serde_json::to_string(command).map_err(|_| ())?;
            Ok(format!(
                "[mcp_servers.luckyray]\ncommand = {quoted_command}\nargs = []\ndefault_tools_approval_mode = \"writes\"\n"
            ))
        }
        PrintConfigTarget::Json => serde_json::to_string(&json!({
            "mcpServers": {
                "luckyray": {
                    "command": command,
                    "args": []
                }
            }
        }))
        .map(|value| format!("{value}\n"))
        .map_err(|_| ()),
    }
}

fn print_config(target: PrintConfigTarget) -> Result<(), ()> {
    let executable = std::env::current_exe().map_err(|_| ())?;
    let output = render_config(target, &executable)?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(output.as_bytes()).map_err(|_| ())?;
    stdout.flush().map_err(|_| ())
}

pub fn run<I>(args: I) -> i32
where
    I: IntoIterator<Item = OsString>,
{
    match parse_process_args(args) {
        Ok(Some(target)) => {
            if print_config(target).is_ok() {
                return 0;
            }
            eprintln!("luckyray-mcp: configuration output unavailable");
            return 1;
        }
        Ok(None) => {}
        Err(()) => {
            eprintln!("usage: luckyray-mcp [--print-config <codex|json>]");
            return 2;
        }
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return 1,
    };
    if runtime.block_on(run_async()).is_ok() {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::{
        call_failure, mcp_output_supported, render_config, serve_stdio, validate_stdio_message,
        BackendToolDefinition, Connector, LuckyRayMcpServer, PrintConfigTarget,
        RequestIdentityState, StrictInputError, MCP_BACKEND_MAX_PUBLIC_OUTPUT_BYTES,
        MCP_MAX_INPUT_MESSAGE_BYTES, MCP_MAX_OUTPUT_MESSAGE_BYTES,
    };
    use crate::knowledge::KnowledgeVaultRegistration;
    use crate::{
        backend::BackendServices,
        local_transport::{start_server, ServerConfig},
        LegacyLocalTransportAdapter,
    };
    use rmcp::{
        model::{CallToolRequestParams, CallToolResult},
        ServiceExt,
    };
    use serde_json::{json, Value};
    use std::fs;
    use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "luckyray-mcp-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn transport_test_guard() -> MutexGuard<'static, ()> {
        static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        lock_test_guard(GUARD.get_or_init(|| Mutex::new(())))
    }

    #[test]
    fn config_rendering_round_trips_windows_quotes_backslashes_and_unicode() {
        let executable =
            std::path::Path::new(r#"C:\Program Files\Lucky "Ray"\工具\luckyray-mcp.exe"#);
        let codex = render_config(PrintConfigTarget::Codex, executable).unwrap();
        let parsed: toml::Value = toml::from_str(&codex).unwrap();
        assert_eq!(
            parsed["mcp_servers"]["luckyray"]["command"].as_str(),
            executable.to_str()
        );
        assert_eq!(
            parsed["mcp_servers"]["luckyray"]["default_tools_approval_mode"].as_str(),
            Some("writes")
        );
        let generic = render_config(PrintConfigTarget::Json, executable).unwrap();
        let parsed: Value = serde_json::from_str(&generic).unwrap();
        assert_eq!(
            parsed["mcpServers"]["luckyray"]["command"],
            executable.to_string_lossy().as_ref()
        );
    }

    fn lock_test_guard(lock: &'static Mutex<()>) -> MutexGuard<'static, ()> {
        lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn transport_test_lock_recovers_after_a_previous_holder_panics() {
        static POISONED: OnceLock<Mutex<()>> = OnceLock::new();
        let lock = POISONED.get_or_init(|| Mutex::new(()));
        let _ = std::thread::spawn(move || {
            let _guard = lock.lock().unwrap();
            panic!("intentional test-lock poison");
        })
        .join();
        drop(lock_test_guard(lock));
    }

    fn register_vault(
        backend: &BackendServices,
        id: &str,
        root: &std::path::Path,
    ) -> KnowledgeVaultRegistration {
        fs::create_dir_all(root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: id.to_string(),
            name: id.to_string(),
            root_path: root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-16T00:00:00Z".to_string(),
            last_opened_at: "2026-07-16T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        backend.knowledge().register_current_vault(&vault).unwrap();
        vault
    }

    fn production_server(
        label: &str,
    ) -> (
        Arc<BackendServices>,
        crate::local_transport::LocalTransportHandle,
        std::path::PathBuf,
        KnowledgeVaultRegistration,
    ) {
        let app_data = temp_dir(&format!("{label}-app"));
        let vault_root = temp_dir(&format!("{label}-vault"));
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let vault = register_vault(&backend, &format!("vault-{label}"), &vault_root);
        let mut config = ServerConfig::test(app_data.clone());
        // MCP unit fixtures connect to an explicit test port and must not
        // occupy the production discovery range used concurrently by native
        // messaging and ToolClient contract tests.
        config.ports = (47418..=47467).collect();
        config.max_connections = 32;
        config.read_timeout = Duration::from_secs(5);
        config.write_timeout = Duration::from_secs(5);
        let server = start_server(
            config,
            Arc::new(LegacyLocalTransportAdapter::new(backend.clone())),
        )
        .unwrap();
        (backend, server, app_data, vault)
    }

    fn transport_port(transport: &crate::local_transport::LocalTransportHandle) -> u16 {
        transport
            .client_config()
            .base_url
            .parse::<reqwest::Url>()
            .unwrap()
            .port()
            .unwrap()
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn official_rmcp_client_lists_production_tools_and_calls_read_and_write() {
        let _guard = transport_test_guard();
        let (backend, transport, app_data, vault) = production_server("official-client");
        fs::write(
            std::path::Path::new(&vault.root_path).join("Existing.md"),
            "# Existing\n\nSearchable MCP content.\n",
        )
        .unwrap();
        backend.knowledge().refresh_index().unwrap();
        runtime().block_on(async move {
            let port = transport_port(&transport);
            let (client_io, server_io) = tokio::io::duplex(256 * 1024);
            let handler = LuckyRayMcpServer::new(Connector::Test {
                app_data,
                ports: vec![port; 4],
            });
            let server_task = tokio::spawn(async move {
                let server = handler.serve(server_io).await.unwrap();
                server.waiting().await.unwrap();
            });
            let client = ().serve(client_io).await.unwrap();
            let listed = client.list_tools(Default::default()).await.unwrap();
            let names = listed
                .tools
                .iter()
                .map(|tool| tool.name.as_ref())
                .collect::<Vec<_>>();
            assert_eq!(
                names,
                vec![
                    "capability.run",
                    "knowledge.append",
                    "knowledge.create",
                    "knowledge.read",
                    "knowledge.search",
                    "knowledge.set_tags",
                    "materials.search",
                ]
            );
            let expected_annotations = [
                ("capability.run", false, true, false, true),
                ("knowledge.append", false, false, false, false),
                ("knowledge.create", false, false, false, false),
                ("knowledge.read", true, false, true, false),
                ("knowledge.search", true, false, true, false),
                ("knowledge.set_tags", false, false, false, false),
                ("materials.search", true, false, true, false),
            ];
            for tool in &listed.tools {
                assert!(tool.output_schema.is_some());
                let annotations = tool.annotations.as_ref().unwrap();
                let (_, read_only, destructive, idempotent, open_world) = expected_annotations
                    .iter()
                    .find(|(name, ..)| *name == tool.name.as_ref())
                    .unwrap();
                assert_eq!(annotations.read_only_hint, Some(*read_only));
                assert_eq!(annotations.destructive_hint, Some(*destructive));
                assert_eq!(annotations.idempotent_hint, Some(*idempotent));
                assert_eq!(annotations.open_world_hint, Some(*open_world));
            }

            let search = client
                .call_tool(
                    CallToolRequestParams::new("knowledge.search").with_arguments(
                        json!({"query":"Searchable MCP","limit":5})
                            .as_object()
                            .unwrap()
                            .clone(),
                    ),
                )
                .await
                .unwrap();
            assert_eq!(search.is_error, Some(false));
            assert!(search.structured_content.as_ref().unwrap()["documents"]
                .as_array()
                .is_some_and(|items| items.len() == 1));
            let search_wire = serde_json::to_value(&search).unwrap();
            assert_eq!(search_wire["content"].as_array().unwrap().len(), 1);
            assert_eq!(
                search_wire["content"][0]["text"],
                serde_json::to_string(search.structured_content.as_ref().unwrap()).unwrap()
            );

            let create = client
                .call_tool(
                    CallToolRequestParams::new("knowledge.create").with_arguments(
                        json!({
                            "expectedVaultId":vault.id,
                            "relativePath":"McpCreated.md",
                            "content":"# MCP created\n\nCreated through the registry.\n"
                        })
                        .as_object()
                        .unwrap()
                        .clone(),
                    ),
                )
                .await
                .unwrap();
            assert_eq!(create.is_error, Some(false));
            assert_eq!(
                create.structured_content.as_ref().unwrap()["documentRef"]["vaultId"],
                vault.id
            );
            assert!(std::path::Path::new(&vault.root_path)
                .join("McpCreated.md")
                .is_file());
            client.cancel().await.unwrap();
            server_task.await.unwrap();
        });
    }

    async fn send_json(writer: &mut (impl tokio::io::AsyncWrite + Unpin), value: &Value) {
        writer
            .write_all(value.to_string().as_bytes())
            .await
            .unwrap();
        writer.write_all(b"\n").await.unwrap();
        writer.flush().await.unwrap();
    }

    async fn read_json(reader: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(!line.is_empty());
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn stdio_duplicate_write_is_idempotent_and_vault_switch_rejects_cached_result() {
        let _guard = transport_test_guard();
        let (backend, transport, app_data, vault_a) = production_server("stdio-idempotency");
        let escaped_content = format!("# Escaped\n\n{}", "\\".repeat(220 * 1024));
        fs::write(
            std::path::Path::new(&vault_a.root_path).join("Escaped.md"),
            &escaped_content,
        )
        .unwrap();
        backend.knowledge().refresh_index().unwrap();
        let vault_b_root = temp_dir("stdio-idempotency-vault-b");
        runtime().block_on(async move {
            let port = transport_port(&transport);
            let handler = LuckyRayMcpServer::new(Connector::Test {
                app_data,
                ports: vec![port; 4],
            });
            let (mut input_writer, input_reader) = tokio::io::duplex(256 * 1024);
            let (output_writer, output_reader) = tokio::io::duplex(256 * 1024);
            let mut output_reader = BufReader::new(output_reader);
            let task = tokio::spawn(serve_stdio(input_reader, output_writer, handler));
            send_json(
                &mut input_writer,
                &json!({
                    "jsonrpc":"2.0","id":"initialize-1","method":"initialize",
                    "params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"contract","version":"1"}}
                }),
            )
            .await;
            assert_eq!(
                read_json(&mut output_reader).await["result"]["protocolVersion"],
                "2025-11-25"
            );
            send_json(
                &mut input_writer,
                &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            )
            .await;
            send_json(
                &mut input_writer,
                &json!({
                    "jsonrpc":"2.0","id":"unknown-tool","method":"tools/call",
                    "params":{"name":"knowledge.unknown","arguments":{}}
                }),
            )
            .await;
            let unknown_tool = read_json(&mut output_reader).await;
            assert_eq!(unknown_tool["error"]["code"], -32602);
            assert_eq!(unknown_tool["error"]["data"]["code"], "tool-not-found");
            send_json(
                &mut input_writer,
                &json!({
                    "jsonrpc":"2.0","id":"large-read","method":"tools/call",
                    "params":{"name":"knowledge.read","arguments":{"documentRef":{
                        "vaultId":vault_a.id,"relativePath":"Escaped.md"
                    }}}
                }),
            )
            .await;
            let large_read = read_json(&mut output_reader).await;
            assert_eq!(large_read["result"]["isError"], false, "{large_read}");
            assert_eq!(
                large_read["result"]["structuredContent"]["content"],
                escaped_content
            );
            assert!(serde_json::to_vec(&large_read).unwrap().len() > 1024 * 1024);
            let call = json!({
                "jsonrpc":"2.0","id":"same-write-id","method":"tools/call",
                "params":{"name":"knowledge.create","arguments":{
                    "expectedVaultId":vault_a.id,
                    "relativePath":"Once.md","content":"# Once\n"
                }}
            });
            send_json(&mut input_writer, &call).await;
            let first = read_json(&mut output_reader).await;
            assert_eq!(first["result"]["isError"], false, "{first}");
            send_json(&mut input_writer, &call).await;
            let replay = read_json(&mut output_reader).await;
            assert_eq!(replay["result"], first["result"]);
            let mut new_request = call.clone();
            new_request["id"] = Value::String("same-arguments-new-id".to_string());
            send_json(&mut input_writer, &new_request).await;
            let independently_dispatched = read_json(&mut output_reader).await;
            assert_eq!(independently_dispatched["result"]["isError"], true);
            let independent_error: Value = serde_json::from_str(
                independently_dispatched["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(independent_error["code"], "knowledge-name-conflict");
            assert_eq!(
                fs::read_dir(std::path::Path::new(&vault_a.root_path))
                .unwrap()
                .filter(|entry| entry.as_ref().unwrap().file_name() == "Once.md")
                .count(),
                1
            );

            register_vault(&backend, "vault-stdio-b", &vault_b_root);
            send_json(&mut input_writer, &call).await;
            let switched = read_json(&mut output_reader).await;
            assert_eq!(switched["result"]["isError"], true);
            assert!(switched["result"].get("structuredContent").is_none());
            let error_text = switched["result"]["content"][0]["text"]
                .as_str()
                .unwrap();
            let error_value: Value = serde_json::from_str(error_text).unwrap();
            assert_eq!(error_value["code"], "knowledge-vault-not-current");
            assert!(!vault_b_root.join("Once.md").exists());
            drop(input_writer);
            assert!(task.await.unwrap().is_ok());
        });
    }

    #[test]
    fn request_identity_is_session_scoped_canonical_and_never_retains_raw_input() {
        let first = RequestIdentityState::new();
        let second = RequestIdentityState::new();
        let sensitive = "PRIVATE-MCP-INPUT-SENTINEL?token=hidden";
        let left = json!({"b":2,"a":sensitive});
        let right = json!({"a":sensitive,"b":2});
        let first_id = first
            .backend_request_id(&7, "knowledge.create", &left)
            .unwrap();
        assert_eq!(
            first_id,
            first
                .backend_request_id(&7, "knowledge.create", &right)
                .unwrap()
        );
        assert_ne!(
            first_id,
            second
                .backend_request_id(&7, "knowledge.create", &left)
                .unwrap()
        );
        assert_ne!(
            first_id,
            first
                .backend_request_id(&8, "knowledge.create", &left)
                .unwrap()
        );
        assert!(!first_id.contains(sensitive));
        assert_eq!(first.entries.lock().unwrap().len(), 2);
        assert_eq!(
            first
                .backend_request_id(&7, "knowledge.create", &json!({"a":"different"}))
                .unwrap_err()
                .code,
            "request-id-conflict"
        );
    }

    #[test]
    fn business_errors_are_text_only_and_do_not_claim_the_success_output_schema() {
        let error = call_failure("knowledge-vault-required", Some(409));
        assert_eq!(error.is_error, Some(true));
        assert_eq!(error.content.len(), 1);
        assert!(error.structured_content.is_none());
        let wire = serde_json::to_string(&error).unwrap();
        assert!(wire.contains("knowledge-vault-required"));
        assert!(!wire.contains("PRIVATE"));
    }

    #[test]
    fn legal_control_character_result_fits_the_stdio_output_bound() {
        let output = json!({
            "documentRef":{"vaultId":"vault-output-bound","relativePath":"Control.md"},
            "kdoc":"kdoc-output-bound",
            "revision":"a".repeat(64),
            "content":"\u{0001}".repeat(256 * 1024),
            "title":"Control",
            "modifiedAt":"2026-07-16T00:00:00Z",
            "size":256 * 1024
        });
        let response = json!({
            "jsonrpc":"2.0",
            "id":"control-character-output",
            "result":CallToolResult::structured(output)
        });
        let bytes = serde_json::to_vec(&response).unwrap();
        assert!(
            bytes.len() >= 3_408_502,
            "fixture must cover the reviewer-measured boundary"
        );
        assert!(bytes.len() <= MCP_MAX_OUTPUT_MESSAGE_BYTES);
    }

    #[test]
    fn future_tool_definitions_above_the_proven_output_bound_are_not_dispatchable() {
        let definition: BackendToolDefinition = serde_json::from_value(json!({
            "id":"knowledge.future","version":1,"title":"Future","description":"Future",
            "risk":"write","inputSchema":{"type":"object"},
            "outputSchema":{"type":"object"},"availability":{"available":true},
            "idempotency":"request-id-single-flight","maxInputBytes":1,
            "maxOutputBytes":MCP_BACKEND_MAX_PUBLIC_OUTPUT_BYTES + 1
        }))
        .unwrap();
        assert!(!mcp_output_supported(&definition));
    }

    #[test]
    fn strict_stdio_validation_rejects_duplicates_unknown_fields_and_non_utf8() {
        let duplicate = br#"{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}"#.to_vec();
        let error = validate_stdio_message(duplicate).unwrap_err();
        assert_eq!(error.code, -32700);
        let unknown = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"knowledge.read","arguments":{},"extra":true}}"#.to_vec();
        let error = validate_stdio_message(unknown).unwrap_err();
        assert_eq!(error.code, -32602);
        let non_utf8 = vec![b'{', 0xff, b'}'];
        let error = validate_stdio_message(non_utf8).unwrap_err();
        assert_eq!(error.code, -32700);
        let invalid_id = br#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#.to_vec();
        let error = validate_stdio_message(invalid_id).unwrap_err();
        assert_eq!(error.code, -32600);
        let invalid_notification =
            br#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{"extra":true}}"#
                .to_vec();
        let error: StrictInputError = validate_stdio_message(invalid_notification).unwrap_err();
        assert!(!error.respond);
    }

    #[test]
    fn stdio_lifecycle_negotiates_only_stable_versions_and_keeps_notifications_silent() {
        runtime().block_on(async {
            let handler = LuckyRayMcpServer::new(Connector::Test {
                app_data: temp_dir("lifecycle-offline"),
                ports: Vec::new(),
            });
            let (mut input_writer, input_reader) = tokio::io::duplex(64 * 1024);
            let (output_writer, output_reader) = tokio::io::duplex(64 * 1024);
            let mut output_reader = BufReader::new(output_reader);
            let task = tokio::spawn(serve_stdio(input_reader, output_writer, handler));

            send_json(
                &mut input_writer,
                &json!({"jsonrpc":"2.0","id":"too-early","method":"tools/list","params":{}}),
            )
            .await;
            assert_eq!(read_json(&mut output_reader).await["error"]["code"], -32600);
            send_json(
                &mut input_writer,
                &json!({
                    "jsonrpc":"2.0","id":"compat-init","method":"initialize",
                    "params":{"protocolVersion":"2025-06-18","capabilities":{},
                        "clientInfo":{"name":"compat-contract","version":"1"}}
                }),
            )
            .await;
            assert_eq!(
                read_json(&mut output_reader).await["result"]["protocolVersion"],
                "2025-06-18"
            );
            send_json(
                &mut input_writer,
                &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            )
            .await;
            send_json(
                &mut input_writer,
                &json!({"jsonrpc":"2.0","id":"ping-after-notification","method":"ping"}),
            )
            .await;
            let ping = read_json(&mut output_reader).await;
            assert_eq!(ping["id"], "ping-after-notification");
            assert!(ping.get("result").is_some());
            send_json(
                &mut input_writer,
                &json!({"jsonrpc":"2.0","id":"unknown-method","method":"unknown/method"}),
            )
            .await;
            assert_eq!(read_json(&mut output_reader).await["error"]["code"], -32601);
            drop(input_writer);
            assert!(task.await.unwrap().is_ok());
        });

        runtime().block_on(async {
            let handler = LuckyRayMcpServer::new(Connector::Test {
                app_data: temp_dir("unsupported-version"),
                ports: Vec::new(),
            });
            let (mut input_writer, input_reader) = tokio::io::duplex(64 * 1024);
            let (output_writer, output_reader) = tokio::io::duplex(64 * 1024);
            let mut output_reader = BufReader::new(output_reader);
            let task = tokio::spawn(serve_stdio(input_reader, output_writer, handler));
            send_json(
                &mut input_writer,
                &json!({
                    "jsonrpc":"2.0","id":"draft-init","method":"initialize",
                    "params":{"protocolVersion":"2026-07-28","capabilities":{},
                        "clientInfo":{"name":"draft-contract","version":"1"}}
                }),
            )
            .await;
            assert_eq!(read_json(&mut output_reader).await["error"]["code"], -32602);
            drop(input_writer);
            assert!(task.await.unwrap().is_err());
        });
    }

    #[test]
    fn stdio_oversize_input_is_rejected_without_poisoning_the_session() {
        runtime().block_on(async {
            let handler = LuckyRayMcpServer::new(Connector::Test {
                app_data: temp_dir("oversize-input"),
                ports: Vec::new(),
            });
            let (mut input_writer, input_reader) = tokio::io::duplex(2 * 1024 * 1024);
            let (output_writer, output_reader) = tokio::io::duplex(64 * 1024);
            let mut output_reader = BufReader::new(output_reader);
            let task = tokio::spawn(serve_stdio(input_reader, output_writer, handler));
            input_writer
                .write_all(&[b'{', 0xff, b'}', b'\n'])
                .await
                .unwrap();
            input_writer.flush().await.unwrap();
            assert_eq!(read_json(&mut output_reader).await["error"]["code"], -32700);
            input_writer
                .write_all(&vec![b'x'; MCP_MAX_INPUT_MESSAGE_BYTES + 1])
                .await
                .unwrap();
            input_writer.write_all(b"\n").await.unwrap();
            input_writer.flush().await.unwrap();
            let rejected = read_json(&mut output_reader).await;
            assert_eq!(rejected["error"]["code"], -32600);
            assert_eq!(rejected["id"], Value::Null);
            send_json(
                &mut input_writer,
                &json!({
                    "jsonrpc":"2.0","id":"after-oversize","method":"initialize",
                    "params":{"protocolVersion":"2025-11-25","capabilities":{},
                        "clientInfo":{"name":"bounded-contract","version":"1"}}
                }),
            )
            .await;
            assert_eq!(
                read_json(&mut output_reader).await["result"]["protocolVersion"],
                "2025-11-25"
            );
            drop(input_writer);
            assert!(task.await.unwrap().is_ok());
        });
    }
}
