//! Process-local tool registry and executor.
//!
//! Tool idempotency, trusted principals, and Vault response leases are valid
//! only for the lifetime of the running desktop application process. External
//! CLI/MCP adapters must call that process through authenticated LocalTransport
//! `/api/v1/tools/list` and `/api/v1/tools/run`. Direct app-data runtime
//! initialization is unsupported unless a future design adds cross-process OS
//! locking, registry generation leases, and cross-process idempotency.

use crate::backend::BackendServices;
use crate::knowledge::{
    KnowledgeCreateInput, KnowledgeDocumentRef, KnowledgeSetTagsInput, KnowledgeWriteInput,
};
use crate::materials::MaterialFilter;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::{Barrier, OnceLock};

const MAX_JSON_DEPTH: usize = 16;
const MAX_JSON_NODES: usize = 20_000;
const REQUEST_CACHE_CAPACITY: usize = 256;
// Idempotency retains only validated public results. Reserving the declared
// output bound before dispatch caps concurrent/TTL retention at sixteen
// maximum-sized tool results instead of 256 potentially sensitive 512 KiB
// results (plus input copies).
const REQUEST_CACHE_BYTE_BUDGET: usize = 8 * 1024 * 1024;
const REQUEST_CACHE_TTL: Duration = Duration::from_secs(300);
const REQUEST_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_READ_CONTENT_BYTES: usize = 256 * 1024;
const MAX_WRITE_CONTENT_BYTES: usize = 512 * 1024;
const MAX_TOOL_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_WEB_TOOL_OUTPUT_BYTES: usize = 60 * 1024;
const MAX_AGENT_WRITE_CONTENT_BYTES: usize = 32 * 1024;
#[cfg(test)]
pub(crate) const AGENT_WRITE_TOOL_IDS: [&str; 3] =
    ["knowledge.create", "knowledge.append", "knowledge.set_tags"];
pub(crate) const AGENT_CANVAS_WRITE_TOOL_IDS: [&str; 2] = ["canvas.mutate", "canvas.generate"];
// Canvas is intentionally the one frozen compatibility profile in R6.
pub(crate) const AGENT_CANVAS_TOOL_IDS: [&str; 14] = [
    "knowledge.search",
    "knowledge.read",
    "materials.search",
    "web.search",
    "web.fetch",
    "browser.open",
    "browser.read",
    "browser.extract",
    "knowledge.create",
    "knowledge.append",
    "knowledge.set_tags",
    "canvas.inspect",
    "canvas.mutate",
    "canvas.generate",
];

#[cfg(test)]
type RequestTestGate = Arc<(Barrier, Barrier)>;

#[cfg(test)]
type RequestTestGates = OnceLock<Mutex<HashMap<String, RequestTestGate>>>;

#[cfg(test)]
static BEFORE_REQUEST_SETTLE: RequestTestGates = OnceLock::new();

#[cfg(test)]
static BEFORE_FOLLOWER_WAIT: RequestTestGates = OnceLock::new();

#[cfg(test)]
static AFTER_REAUTHORIZE_BEFORE_HANDOFF: RequestTestGates = OnceLock::new();

#[cfg(test)]
static DURING_CURRENT_VAULT_HANDOFF: RequestTestGates = OnceLock::new();

#[cfg(test)]
static BEFORE_AGENT_WRITE_SOURCE_LOCK: RequestTestGates = OnceLock::new();

#[cfg(test)]
static BEFORE_KNOWLEDGE_SEARCH_SNAPSHOT: RequestTestGates = OnceLock::new();

#[cfg(test)]
struct RequestExecutionGate {
    expected: usize,
    state: Mutex<(usize, bool)>,
    condition: Condvar,
}

#[cfg(test)]
impl RequestExecutionGate {
    fn wait_until_full(&self) {
        let mut state = self.state.lock().expect("execution gate lock");
        while state.0 < self.expected {
            state = self.condition.wait(state).expect("execution gate wait");
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().expect("execution gate lock");
        state.1 = true;
        self.condition.notify_all();
    }

    fn entered(&self) -> usize {
        self.state.lock().expect("execution gate lock").0
    }
}

#[cfg(test)]
static BEFORE_REQUEST_EXECUTION: OnceLock<Mutex<HashMap<String, Arc<RequestExecutionGate>>>> =
    OnceLock::new();

#[cfg(test)]
static CORRUPT_WRITE_OUTPUT_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[cfg(test)]
static PANIC_LEADER_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[cfg(test)]
static CANCEL_LEADER_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[cfg(test)]
fn set_leader_abort_hook(storage: &'static OnceLock<Mutex<Option<String>>>, request_id: &str) {
    *storage
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("leader abort hook lock") = Some(request_id.to_string());
}

#[cfg(test)]
fn take_leader_abort_hook(
    storage: &'static OnceLock<Mutex<Option<String>>>,
    request_id: &str,
) -> bool {
    let mut hook = storage
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("leader abort hook lock");
    if hook.as_deref() == Some(request_id) {
        hook.take();
        true
    } else {
        false
    }
}

#[cfg(test)]
fn corrupt_write_output_for(request_id: &str) {
    *CORRUPT_WRITE_OUTPUT_FOR
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("output corruption hook lock") = Some(request_id.to_string());
}

#[cfg(test)]
fn take_write_output_corruption(request_id: Option<&str>) -> bool {
    let mut hook = CORRUPT_WRITE_OUTPUT_FOR
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("output corruption hook lock");
    if request_id.is_some_and(|request_id| hook.as_deref() == Some(request_id)) {
        hook.take();
        true
    } else {
        false
    }
}

#[cfg(test)]
fn block_request_execution(prefix: &str, expected: usize) -> Arc<RequestExecutionGate> {
    let gate = Arc::new(RequestExecutionGate {
        expected,
        state: Mutex::new((0, false)),
        condition: Condvar::new(),
    });
    BEFORE_REQUEST_EXECUTION
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("execution hook lock")
        .insert(prefix.to_string(), gate.clone());
    gate
}

#[cfg(test)]
fn enter_request_execution_gate(request_id: &str) {
    let gate = BEFORE_REQUEST_EXECUTION
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("execution hook lock")
        .iter()
        .find(|(prefix, _)| request_id.starts_with(prefix.as_str()))
        .map(|(_, gate)| gate.clone());
    if let Some(gate) = gate {
        let mut state = gate.state.lock().expect("execution gate lock");
        state.0 += 1;
        gate.condition.notify_all();
        while !state.1 {
            state = gate.condition.wait(state).expect("execution gate wait");
        }
    }
}

#[cfg(test)]
fn install_request_test_gate(
    storage: &'static RequestTestGates,
    request_id: &str,
) -> RequestTestGate {
    let gate = Arc::new((Barrier::new(2), Barrier::new(2)));
    storage
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("request test gate lock")
        .insert(request_id.to_string(), gate.clone());
    gate
}

#[cfg(test)]
pub(crate) fn install_agent_write_source_lock_test_gate(
    expected_vault_id: &str,
) -> Arc<(Barrier, Barrier)> {
    install_request_test_gate(&BEFORE_AGENT_WRITE_SOURCE_LOCK, expected_vault_id)
}

#[cfg(test)]
fn enter_request_test_gate(storage: &'static RequestTestGates, request_id: &str) {
    let gate = storage
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("request test gate lock")
        .remove(request_id);
    if let Some(gate) = gate {
        gate.0.wait();
        gate.1.wait();
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ToolRisk {
    Read,
    Write,
    Dangerous,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ToolCallerKind {
    Agent,
    #[cfg(test)]
    Tauri,
    LocalTransport,
    #[cfg(test)]
    TestCli,
    #[cfg(test)]
    TestMcp,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ToolTrustMode {
    TrustedAgent,
    #[cfg(test)]
    TrustedUi,
    TrustedLocalTransport,
    #[cfg(test)]
    TrustedNative,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolCallContext {
    caller: ToolCallerKind,
    trust: ToolTrustMode,
    max_risk: ToolRisk,
    deadline: Option<Instant>,
    principal: ToolPrincipal,
    web_scope: Option<[u8; 32]>,
    browser_scope: Option<[u8; 32]>,
    canvas_scope: Option<[u8; 32]>,
    conversation_id: Option<String>,
    capability_snapshot: Option<Arc<crate::agent_capabilities::CapabilitySnapshot>>,
    workspace_aliases: Option<Arc<Vec<crate::agent_workspace::WorkspaceAliasView>>>,
    memory_bindings: Option<Arc<crate::agent_memory::MemoryRunBindings>>,
    file_bindings: Option<Arc<crate::agent_workspace::WorkspaceFileBindings>>,
    /// Per-run opaque project-check recipe refs. These are intentionally
    /// separate from file refs and approvals: a ref only resolves Backend
    /// state, while the existing permit remains the execution authority.
    execution_bindings: Option<Arc<crate::agent_execution::ExecutionRunBindings>>,
    /// Backend-only Knowledge scope frozen at run admission. Agent contexts
    /// without this field are fail-closed for the whole Knowledge pack.
    knowledge_scope: Option<Arc<crate::knowledge::KnowledgeRunScope>>,
    /// A workspace write inherits a real active Vault/source fence only when
    /// the run started with one. No-Vault workspace writes remain valid.
    workspace_source: Option<crate::knowledge::KnowledgeUiSourceActivation>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ToolPrincipal([u8; 32]);

impl std::fmt::Debug for ToolPrincipal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ToolPrincipal(sha256)")
    }
}

impl ToolPrincipal {
    #[cfg(test)]
    fn namespace(value: &[u8]) -> Self {
        Self(Sha256::digest(value).into())
    }
}

impl ToolCallContext {
    pub(crate) fn agent_read(principal_digest: [u8; 32]) -> Self {
        Self {
            caller: ToolCallerKind::Agent,
            trust: ToolTrustMode::TrustedAgent,
            max_risk: ToolRisk::Read,
            deadline: Some(Instant::now() + Duration::from_secs(30)),
            principal: ToolPrincipal(principal_digest),
            web_scope: None,
            browser_scope: None,
            canvas_scope: None,
            conversation_id: None,
            capability_snapshot: None,
            workspace_aliases: None,
            memory_bindings: None,
            file_bindings: None,
            execution_bindings: None,
            knowledge_scope: None,
            workspace_source: None,
        }
    }

    pub(crate) fn agent_read_scoped(
        principal_digest: [u8; 32],
        web_scope: [u8; 32],
        browser_scope: [u8; 32],
    ) -> Self {
        let mut context = Self::agent_read(principal_digest);
        context.web_scope = Some(web_scope);
        context.browser_scope = Some(browser_scope);
        context
    }

    pub(crate) fn agent_canvas_scoped(
        principal_digest: [u8; 32],
        web_scope: [u8; 32],
        browser_scope: [u8; 32],
        canvas_scope: [u8; 32],
    ) -> Self {
        let mut context = Self::agent_read_scoped(principal_digest, web_scope, browser_scope);
        context.canvas_scope = Some(canvas_scope);
        context
    }

    pub(crate) fn with_agent_run(
        mut self,
        conversation_id: String,
        capability_snapshot: Arc<crate::agent_capabilities::CapabilitySnapshot>,
    ) -> Self {
        self.conversation_id = Some(conversation_id);
        self.capability_snapshot = Some(capability_snapshot);
        self
    }

    pub(crate) fn with_workspace_aliases(
        mut self,
        aliases: Arc<Vec<crate::agent_workspace::WorkspaceAliasView>>,
    ) -> Self {
        self.workspace_aliases = Some(aliases);
        self
    }

    pub(crate) fn workspace_aliases(
        &self,
    ) -> Option<Arc<Vec<crate::agent_workspace::WorkspaceAliasView>>> {
        self.workspace_aliases.clone()
    }

    pub(crate) fn with_memory_bindings(
        mut self,
        bindings: Arc<crate::agent_memory::MemoryRunBindings>,
    ) -> Self {
        self.memory_bindings = Some(bindings);
        self
    }

    pub(crate) fn memory_binding(
        &self,
        reference: &str,
    ) -> Result<crate::agent_memory::MemoryRunBinding, ToolError> {
        self.memory_bindings
            .as_deref()
            .ok_or_else(|| {
                ToolError::new(
                    "memory-reference-invalid",
                    "Memory reference is unavailable for this Agent run",
                )
            })?
            .resolve(reference)
            .map_err(map_memory_error)
    }

    pub(crate) fn memory_bindings(
        &self,
    ) -> Result<Arc<crate::agent_memory::MemoryRunBindings>, ToolError> {
        self.memory_bindings.clone().ok_or_else(|| {
            ToolError::new(
                "memory-reference-invalid",
                "Memory references are unavailable for this Agent run",
            )
        })
    }

    pub(crate) fn with_file_bindings(
        mut self,
        bindings: Arc<crate::agent_workspace::WorkspaceFileBindings>,
    ) -> Self {
        self.file_bindings = Some(bindings);
        self
    }

    pub(crate) fn with_execution_bindings(
        mut self,
        bindings: Arc<crate::agent_execution::ExecutionRunBindings>,
    ) -> Self {
        self.execution_bindings = Some(bindings);
        self
    }

    pub(crate) fn with_knowledge_scope(
        mut self,
        scope: Arc<crate::knowledge::KnowledgeRunScope>,
    ) -> Self {
        self.knowledge_scope = Some(scope);
        self
    }

    fn knowledge_target_is_current(&self, backend: &BackendServices) -> bool {
        if self.caller != ToolCallerKind::Agent {
            return backend.knowledge().current_vault_id().is_ok();
        }
        let Some(scope) = self.knowledge_scope.as_deref() else {
            return false;
        };
        backend
            .knowledge()
            .current_target_identity()
            .is_ok_and(|target| scope.allows(&target))
    }

    fn verify_knowledge_target(
        &self,
        backend: &BackendServices,
        requested_target_id: Option<&str>,
    ) -> Result<(), ToolError> {
        if self.caller != ToolCallerKind::Agent {
            return Ok(());
        }
        let scope = self.knowledge_scope.as_deref().ok_or_else(|| {
            ToolError::new(
                "agent-project-knowledge-denied",
                "This Agent run has no Knowledge authorization",
            )
        })?;
        let current = backend
            .knowledge()
            .current_target_identity()
            .map_err(ToolError::from_knowledge)?;
        if !scope.allows(&current)
            || requested_target_id.is_some_and(|target_id| {
                !scope.allows_target_id(target_id) || target_id != current.target_id
            })
        {
            return Err(ToolError::new(
                "agent-project-knowledge-denied",
                "Knowledge access is not authorized for this Agent run",
            ));
        }
        Ok(())
    }

    pub(crate) fn execution_binding(
        &self,
        reference: &str,
    ) -> Result<crate::agent_execution::ExecutionRecipeBinding, ToolError> {
        let binding = self
            .execution_bindings
            .as_deref()
            .ok_or_else(|| {
                ToolError::new(
                    "execution-recipe-invalid",
                    "Project check references are unavailable for this Agent run",
                )
            })?
            .resolve(reference)
            .map_err(map_execution_error)?;
        if binding.principal != self.principal.0
            || self
                .conversation_id
                .as_deref()
                .is_none_or(|conversation_id| conversation_id != binding.conversation_id)
        {
            return Err(ToolError::new(
                "execution-recipe-invalid",
                "Project check reference is invalid or from another run",
            ));
        }
        Ok(binding)
    }

    pub(crate) fn consume_execution_binding(
        &self,
        reference: &str,
    ) -> Result<crate::agent_execution::ExecutionRecipeBinding, ToolError> {
        let binding = self
            .execution_bindings
            .as_deref()
            .ok_or_else(|| {
                ToolError::new(
                    "execution-recipe-invalid",
                    "Project check references are unavailable for this Agent run",
                )
            })?
            .consume(reference)
            .map_err(map_execution_error)?;
        if binding.principal != self.principal.0
            || self
                .conversation_id
                .as_deref()
                .is_none_or(|conversation_id| conversation_id != binding.conversation_id)
        {
            return Err(ToolError::new(
                "execution-recipe-invalid",
                "Project check reference is invalid or from another run",
            ));
        }
        Ok(binding)
    }

    pub(crate) fn execution_bindings(
        &self,
    ) -> Result<Arc<crate::agent_execution::ExecutionRunBindings>, ToolError> {
        self.execution_bindings.clone().ok_or_else(|| {
            ToolError::new(
                "execution-recipe-invalid",
                "Project check references are unavailable for this Agent run",
            )
        })
    }

    pub(crate) fn with_workspace_source(
        mut self,
        source: Option<crate::knowledge::KnowledgeUiSourceActivation>,
    ) -> Self {
        self.workspace_source = source.filter(|value| !value.vault_id.is_empty());
        self
    }

    fn workspace_source(&self) -> Option<&crate::knowledge::KnowledgeUiSourceActivation> {
        self.workspace_source.as_ref()
    }

    fn verify_workspace_source(&self, backend: &BackendServices) -> Result<(), ToolError> {
        let Some(expected) = self.workspace_source() else {
            return Ok(());
        };
        let current = backend
            .knowledge()
            .active_ui_source_identity()
            .map_err(ToolError::from_knowledge)?;
        if &current != expected {
            return Err(ToolError::new(
                "workspace-source-changed",
                "Workspace write context changed",
            ));
        }
        Ok(())
    }

    /// Resolve a run-bound workspace fileRef. Forged, cross-run, consumed,
    /// and expired references fail closed before any approval or file access.
    pub(crate) fn file_binding(
        &self,
        reference: &str,
    ) -> Result<crate::agent_workspace::WorkspaceFileBinding, ToolError> {
        let binding = self
            .file_bindings
            .as_deref()
            .ok_or_else(|| {
                ToolError::new(
                    "workspace-file-ref-invalid",
                    "Workspace file references are unavailable for this Agent run",
                )
            })?
            .resolve(reference)
            .map_err(map_workspace_error)?;
        // The binding is authoritative for this run's principal and
        // conversation only; any other authority is a forged reference.
        if binding.principal != self.principal.0
            || self
                .conversation_id
                .as_deref()
                .is_none_or(|conversation_id| conversation_id != binding.conversation_id)
        {
            return Err(ToolError::new(
                "workspace-file-ref-invalid",
                "Workspace file reference is invalid or from another run",
            ));
        }
        Ok(binding)
    }

    pub(crate) fn file_bindings(
        &self,
    ) -> Result<Arc<crate::agent_workspace::WorkspaceFileBindings>, ToolError> {
        self.file_bindings.clone().ok_or_else(|| {
            ToolError::new(
                "workspace-file-ref-invalid",
                "Workspace file references are unavailable for this Agent run",
            )
        })
    }

    pub(crate) fn workspace_create_binding(
        &self,
        request_id: &str,
    ) -> Result<crate::agent_workspace::WorkspaceCreateBinding, ToolError> {
        let binding = self
            .file_bindings
            .as_deref()
            .ok_or_else(|| {
                ToolError::new(
                    "workspace-file-ref-invalid",
                    "Workspace create binding is unavailable for this Agent run",
                )
            })?
            .resolve_create(request_id)
            .map_err(map_workspace_error)?;
        if binding.principal != self.principal.0
            || self
                .conversation_id
                .as_deref()
                .is_none_or(|conversation_id| conversation_id != binding.conversation_id)
        {
            return Err(ToolError::new(
                "workspace-file-ref-invalid",
                "Workspace create binding is invalid or from another run",
            ));
        }
        Ok(binding)
    }

    /// Resolve the server-bound multi-file proposal before an approval exists.
    /// The request id is never file authority; it only addresses an opaque,
    /// per-run binding in the Backend store.
    pub(crate) fn workspace_change_set_binding(
        &self,
        request_id: &str,
    ) -> Result<crate::agent_workspace::WorkspaceChangeSetBinding, ToolError> {
        let binding = self
            .file_bindings
            .as_deref()
            .ok_or_else(|| {
                ToolError::new(
                    "workspace-file-ref-invalid",
                    "Workspace change-set binding is unavailable for this Agent run",
                )
            })?
            .resolve_change_set(request_id)
            .map_err(map_workspace_error)?;
        if binding.principal != self.principal.0
            || self
                .conversation_id
                .as_deref()
                .is_none_or(|conversation_id| conversation_id != binding.conversation_id)
        {
            return Err(ToolError::new(
                "workspace-file-ref-invalid",
                "Workspace change-set binding is invalid or from another run",
            ));
        }
        Ok(binding)
    }

    /// Consume the complete change-set binding exactly once when the approved
    /// dispatch crosses into the writer. A partial or unknown result may never
    /// be replayed with the same proposal/permit.
    pub(crate) fn consume_workspace_change_set_binding(
        &self,
        request_id: &str,
    ) -> Result<crate::agent_workspace::WorkspaceChangeSetBinding, ToolError> {
        let binding = self
            .file_bindings
            .as_deref()
            .ok_or_else(|| {
                ToolError::new(
                    "workspace-file-ref-invalid",
                    "Workspace change-set binding is unavailable for this Agent run",
                )
            })?
            .consume_change_set(request_id)
            .map_err(map_workspace_error)?;
        if binding.principal != self.principal.0
            || self
                .conversation_id
                .as_deref()
                .is_none_or(|conversation_id| conversation_id != binding.conversation_id)
        {
            return Err(ToolError::new(
                "workspace-file-ref-invalid",
                "Workspace change-set binding is invalid or from another run",
            ));
        }
        Ok(binding)
    }

    pub(crate) fn workspace_run_authority(&self) -> Result<([u8; 32], String), ToolError> {
        let conversation_id = self.conversation_id.clone().ok_or_else(|| {
            ToolError::new(
                "agent-run-scope-required",
                "Workspace writes require the current Agent run",
            )
        })?;
        Ok((self.principal.0, conversation_id))
    }

    /// Resolve a frozen run alias to its internal grant id. Used by the agent
    /// engine to build approval previews and durable receipts.
    pub(crate) fn workspace_grant_id(&self, alias: &str) -> Result<String, ToolError> {
        self.workspace_aliases
            .as_deref()
            .ok_or_else(|| {
                ToolError::new(
                    "workspace-alias-invalid",
                    "No workspace alias is bound to this run",
                )
            })?
            .iter()
            .find(|candidate| candidate.name == alias)
            .map(|candidate| candidate.grant_id.clone())
            .ok_or_else(|| {
                ToolError::new(
                    "workspace-alias-invalid",
                    "The workspace display name is not bound to this run",
                )
            })
    }

    fn web_scope(&self) -> Result<[u8; 32], ToolError> {
        self.web_scope
            .ok_or_else(|| ToolError::new("web-scope-required", "Web tool scope is unavailable"))
    }

    fn browser_scope(&self) -> Result<[u8; 32], ToolError> {
        self.browser_scope.ok_or_else(|| {
            ToolError::new(
                "browser-scope-required",
                "Agent Browser scope is unavailable",
            )
        })
    }

    fn canvas_scope(&self) -> Result<[u8; 32], ToolError> {
        self.canvas_scope.ok_or_else(|| {
            ToolError::new(
                "canvas-scope-required",
                "Canvas capability scope is unavailable",
            )
        })
    }

    fn agent_approved_write(&self) -> Result<Self, ToolError> {
        if self.caller != ToolCallerKind::Agent || self.trust != ToolTrustMode::TrustedAgent {
            return Err(ToolError::new(
                "tool-risk-denied",
                "Approved writes require the trusted Agent boundary",
            ));
        }
        let mut context = self.clone();
        context.max_risk = ToolRisk::Write;
        context.deadline = Some(Instant::now() + Duration::from_secs(30));
        Ok(context)
    }
    pub(crate) fn local_transport_verified(principal_digest: [u8; 32]) -> Self {
        Self {
            caller: ToolCallerKind::LocalTransport,
            trust: ToolTrustMode::TrustedLocalTransport,
            max_risk: ToolRisk::Dangerous,
            deadline: Some(Instant::now() + Duration::from_secs(30)),
            principal: ToolPrincipal(principal_digest),
            web_scope: None,
            browser_scope: None,
            canvas_scope: None,
            conversation_id: None,
            capability_snapshot: None,
            workspace_aliases: None,
            memory_bindings: None,
            file_bindings: None,
            execution_bindings: None,
            knowledge_scope: None,
            workspace_source: None,
        }
    }

    #[cfg(test)]
    fn future_cli() -> Self {
        Self {
            caller: ToolCallerKind::TestCli,
            trust: ToolTrustMode::TrustedNative,
            max_risk: ToolRisk::Dangerous,
            deadline: Some(Instant::now() + Duration::from_secs(30)),
            principal: ToolPrincipal::namespace(b"luckyray-tool-principal:test-cli:v1"),
            web_scope: None,
            browser_scope: None,
            canvas_scope: None,
            conversation_id: None,
            capability_snapshot: None,
            workspace_aliases: None,
            memory_bindings: None,
            file_bindings: None,
            execution_bindings: None,
            knowledge_scope: None,
            workspace_source: None,
        }
    }

    #[cfg(test)]
    fn future_mcp() -> Self {
        Self {
            caller: ToolCallerKind::TestMcp,
            trust: ToolTrustMode::TrustedNative,
            max_risk: ToolRisk::Dangerous,
            deadline: Some(Instant::now() + Duration::from_secs(30)),
            principal: ToolPrincipal::namespace(b"luckyray-tool-principal:test-mcp:v1"),
            web_scope: None,
            browser_scope: None,
            canvas_scope: None,
            conversation_id: None,
            capability_snapshot: None,
            workspace_aliases: None,
            memory_bindings: None,
            file_bindings: None,
            execution_bindings: None,
            knowledge_scope: None,
            workspace_source: None,
        }
    }

    #[cfg(test)]
    fn tauri() -> Self {
        Self {
            caller: ToolCallerKind::Tauri,
            trust: ToolTrustMode::TrustedUi,
            max_risk: ToolRisk::Dangerous,
            deadline: Some(Instant::now() + Duration::from_secs(30)),
            principal: ToolPrincipal::namespace(b"luckyray-tool-principal:tauri-ui:v1"),
            web_scope: None,
            browser_scope: None,
            canvas_scope: None,
            conversation_id: None,
            capability_snapshot: None,
            workspace_aliases: None,
            memory_bindings: None,
            file_bindings: None,
            execution_bindings: None,
            knowledge_scope: None,
            workspace_source: None,
        }
    }
}

impl ToolDefinition {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn risk(&self) -> ToolRisk {
        self.risk
    }

    pub(crate) fn is_available(&self) -> bool {
        self.availability.available
    }

    pub(crate) fn version(&self) -> u32 {
        self.version
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }

    pub(crate) fn description(&self) -> &str {
        &self.description
    }

    pub(crate) fn input_schema(&self) -> &Value {
        &self.input_schema
    }

    pub(crate) fn output_schema(&self) -> &Value {
        &self.output_schema
    }

    pub(crate) fn idempotency(&self) -> &str {
        &self.idempotency
    }

    pub(crate) fn max_input_bytes(&self) -> usize {
        self.max_input_bytes
    }

    pub(crate) fn max_output_bytes(&self) -> usize {
        self.max_output_bytes
    }
}

impl ToolRunRequest {
    pub(crate) fn read(tool_id: String, input: Value) -> Self {
        Self {
            tool_id,
            input,
            request_id: None,
        }
    }

    pub(crate) fn agent_write(tool_id: String, input: Value) -> Self {
        Self {
            tool_id,
            input,
            request_id: None,
        }
    }
}

impl ToolRunResult {
    pub(crate) fn result(&self) -> &Value {
        &self.result
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolAvailability {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolDefinition {
    id: String,
    version: u32,
    title: String,
    description: String,
    risk: ToolRisk,
    input_schema: Value,
    output_schema: Value,
    availability: ToolAvailability,
    idempotency: String,
    max_input_bytes: usize,
    max_output_bytes: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolRunRequest {
    tool_id: String,
    input: Value,
    #[serde(default)]
    request_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolRunResult {
    tool_id: String,
    version: u32,
    result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ToolError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    /// Backend-only outcome metadata for the Workspace commit boundary. This
    /// is never serialized to a model, renderer, safe event, or ledger; the
    /// Agent service consumes it before deciding whether a prepared receipt
    /// may be discarded.
    pub(crate) workspace_commit_disposition:
        Option<crate::agent_workspace::WorkspaceCommitDisposition>,
    /// Backend-only execution admission evidence. It is set only by the
    /// Permit/dispatch boundary and is never serialized to any public surface.
    pub(crate) execution_dispatch_disposition:
        Option<crate::agent_execution::ExecutionDispatchDisposition>,
}

impl ToolError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            workspace_commit_disposition: None,
            execution_dispatch_disposition: None,
        }
    }

    fn from_workspace_commit_failure(
        error: crate::agent_workspace::WorkspaceCommitFailure,
    ) -> Self {
        Self {
            code: error.code,
            message: error.message,
            workspace_commit_disposition: Some(error.disposition),
            execution_dispatch_disposition: None,
        }
    }

    fn with_execution_dispatch_disposition(
        mut self,
        disposition: crate::agent_execution::ExecutionDispatchDisposition,
    ) -> Self {
        self.execution_dispatch_disposition = Some(disposition);
        self
    }

    fn from_knowledge(error: crate::knowledge::KnowledgeError) -> Self {
        let message = match error.code {
            "knowledge-vault-required" => "Open or create a Vault before using this tool",
            "knowledge-vault-not-current" | "knowledge-vault-changed" => {
                "Knowledge operation no longer targets the current Vault"
            }
            "knowledge-revision-conflict" => "Knowledge document revision changed",
            "knowledge-name-conflict" => "Knowledge document already exists",
            "knowledge-parent-missing" => "Knowledge document parent folder does not exist",
            "knowledge-not-found" | "knowledge-document-not-found" => {
                "Knowledge document was not found"
            }
            _ => "Knowledge operation failed",
        };
        Self::new(error.code, message)
    }

    fn from_web(error: crate::web_tools::WebToolError) -> Self {
        Self::new(error.code, error.message)
    }

    fn from_browser(error: crate::agent_browser::AgentBrowserError) -> Self {
        Self::new(error.code, "Agent Browser operation failed")
    }

    fn from_canvas(error: crate::canvas_agent::CanvasAgentError) -> Self {
        Self::new(error.code, "Canvas capability operation failed")
    }

    pub(crate) fn status(&self) -> u16 {
        match self.code {
            "tool-not-found" | "knowledge-document-not-found" => 404,
            "tool-unavailable" | "knowledge-vault-required" => 503,
            "tool-risk-denied" | "capability-disabled" => 403,
            "request-id-conflict"
            | "knowledge-revision-conflict"
            | "knowledge-name-conflict"
            | "knowledge-vault-not-current" => 409,
            "tool-input-too-large" | "tool-output-too-large" => 413,
            "tool-request-capacity" => 429,
            _ => 400,
        }
    }
}

fn mark_execution_pre_admission(error: ToolError, execution_run: bool) -> ToolError {
    if execution_run {
        error.with_execution_dispatch_disposition(
            crate::agent_execution::ExecutionDispatchDisposition::NotAdmitted,
        )
    } else {
        error
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct AgentWriteBinding {
    local_turn_id: String,
    engine_session_id: String,
    engine_turn_id: String,
    tool_call_id: String,
    generation: u64,
    principal_digest: [u8; 32],
    tool_id: String,
    request_id: String,
    input_digest: [u8; 32],
    expected_vault_id: Option<String>,
    source_epoch: Option<u64>,
    expected_revision: Option<String>,
}

impl AgentWriteBinding {
    pub(crate) fn requires_active_source(&self) -> bool {
        self.source_epoch.is_some() && self.expected_vault_id.is_some()
    }
}

impl std::fmt::Debug for AgentWriteBinding {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentWriteBinding")
            .field("run_scope", &"opaque")
            .field("tool_id", &self.tool_id)
            .field("request_id", &"opaque")
            .field("input_digest", &"sha256")
            .field(
                "expected_vault_id",
                &self.expected_vault_id.as_ref().map(|_| "opaque"),
            )
            .field("source_epoch", &self.source_epoch.map(|_| "opaque"))
            .field(
                "expected_revision",
                &self.expected_revision.as_ref().map(|_| "opaque"),
            )
            .finish()
    }
}

#[cfg(test)]
impl AgentWriteBinding {
    pub(crate) fn test_fixture(label: u8) -> Self {
        Self {
            local_turn_id: format!("turn-{label}"),
            engine_session_id: format!("session-{label}"),
            engine_turn_id: format!("engine-turn-{label}"),
            tool_call_id: format!("call-{label}"),
            generation: u64::from(label) + 1,
            principal_digest: [label; 32],
            tool_id: "knowledge.create".to_string(),
            request_id: format!("request-{label}"),
            input_digest: [label.wrapping_add(1); 32],
            expected_vault_id: Some(format!("vault-{label}")),
            source_epoch: Some(u64::from(label) + 10),
            expected_revision: None,
        }
    }
}

pub(crate) struct AgentWriteScope {
    local_turn_id: String,
    engine_session_id: String,
    engine_turn_id: String,
    tool_call_id: String,
    generation: u64,
    source_epoch: u64,
}

impl AgentWriteScope {
    pub(crate) fn new(
        local_turn_id: String,
        engine_session_id: String,
        engine_turn_id: String,
        tool_call_id: String,
        generation: u64,
        source_epoch: u64,
    ) -> Self {
        Self {
            local_turn_id,
            engine_session_id,
            engine_turn_id,
            tool_call_id,
            generation,
            source_epoch,
        }
    }
}

pub(crate) trait AgentWritePermit: Send + Sync {
    fn consume(&self, binding: &AgentWriteBinding) -> Result<(), ToolError>;
}

pub(crate) struct PreparedAgentWrite {
    definition: ToolDefinition,
    input: Value,
    request_id: String,
    binding: AgentWriteBinding,
}

impl std::fmt::Debug for PreparedAgentWrite {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedAgentWrite")
            .field("tool_id", &self.definition.id)
            .field("request_id", &"opaque")
            .field("input", &"redacted")
            .field("binding", &self.binding)
            .finish()
    }
}

impl PreparedAgentWrite {
    pub(crate) fn binding(&self) -> &AgentWriteBinding {
        &self.binding
    }

    pub(crate) fn input(&self) -> &Value {
        &self.input
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ToolError {}

#[derive(Clone, Eq)]
struct RequestKey {
    tool_id: String,
    principal_digest: [u8; 32],
    request_id: String,
}

impl PartialEq for RequestKey {
    fn eq(&self, other: &Self) -> bool {
        self.tool_id == other.tool_id
            && self.principal_digest == other.principal_digest
            && self.request_id == other.request_id
    }
}

impl Hash for RequestKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.tool_id.hash(state);
        self.principal_digest.hash(state);
        self.request_id.hash(state);
    }
}

#[derive(Clone)]
struct RequestSlot {
    input_digest: [u8; 32],
    inflight_started_at: Instant,
    settled_at: Option<Instant>,
    retained_bytes: usize,
    result: Arc<(Mutex<Option<Result<ToolRunResult, ToolError>>>, Condvar)>,
}

#[derive(Default)]
struct RequestState {
    entries: HashMap<RequestKey, RequestSlot>,
    retained_bytes: usize,
}

struct ReservationGuard {
    requests: Arc<Mutex<RequestState>>,
    key: RequestKey,
    result: Arc<(Mutex<Option<Result<ToolRunResult, ToolError>>>, Condvar)>,
    active: bool,
}

impl ReservationGuard {
    fn new(
        requests: Arc<Mutex<RequestState>>,
        key: RequestKey,
        result: Arc<(Mutex<Option<Result<ToolRunResult, ToolError>>>, Condvar)>,
    ) -> Self {
        Self {
            requests,
            key,
            result,
            active: true,
        }
    }

    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for ReservationGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut state = self
            .requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        remove_request_slot(&mut state, &self.key, &self.result);
        let (lock, condition) = &*self.result;
        let mut settled = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if settled.is_none() {
            *settled = Some(Err(ToolError::new(
                "tool-execution-aborted",
                "Tool execution ended before publication",
            )));
            condition.notify_all();
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct ToolRegistry {
    requests: Arc<Mutex<RequestState>>,
}

#[cfg(test)]
#[derive(Clone)]
struct ToolRuntime {
    backend: BackendServices,
}

#[cfg(test)]
impl ToolRuntime {
    fn initialize(app_data_dir: impl AsRef<std::path::Path>) -> Result<Self, ToolError> {
        let backend = BackendServices::initialize(app_data_dir).map_err(|_| {
            ToolError::new(
                "backend-not-ready",
                "Backend tool runtime initialization failed",
            )
        })?;
        Ok(Self { backend })
    }

    fn run_tool(
        &self,
        context: &ToolCallContext,
        request: ToolRunRequest,
    ) -> Result<ToolRunResult, ToolError> {
        self.backend.run_tool(context, request)
    }

    #[cfg(test)]
    fn request_cache_snapshot(&self) -> RequestCacheSnapshot {
        self.backend.tool_request_cache_snapshot()
    }

    #[cfg(test)]
    fn expire_settled_requests(&self) {
        self.backend.expire_settled_tool_requests();
    }

    #[cfg(test)]
    fn backdate_inflight_request(&self, request_id: &str) {
        self.backend.backdate_inflight_tool_request(request_id);
    }
}

#[cfg(test)]
#[derive(Debug)]
pub(crate) struct RequestCacheSnapshot {
    pub(crate) entries: usize,
    pub(crate) retained_bytes: usize,
    pub(crate) serialized: String,
}

impl ToolRegistry {
    pub(crate) fn initialize() -> Result<Self, ToolError> {
        let registry = Self::default();
        validate_definitions(&registry.base_definitions(false, false))?;
        Ok(registry)
    }

    #[cfg(test)]
    pub(crate) fn request_cache_snapshot(&self) -> RequestCacheSnapshot {
        let state = self.requests.lock().expect("tool request cache lock");
        let entries = state
            .entries
            .iter()
            .map(|(key, slot)| {
                let settled = slot.result.0.lock().expect("tool result lock");
                json!({
                    "toolId":key.tool_id,
                    "requestId":key.request_id,
                    "principalDigest":hex_digest(&key.principal_digest),
                    "inputDigest":hex_digest(&slot.input_digest),
                    "retainedBytes":slot.retained_bytes,
                    "result":settled.as_ref().and_then(|result| result.as_ref().ok()),
                })
            })
            .collect::<Vec<_>>();
        RequestCacheSnapshot {
            entries: entries.len(),
            retained_bytes: state.retained_bytes,
            serialized: serde_json::to_string(&entries).expect("serialize cache snapshot"),
        }
    }

    #[cfg(test)]
    pub(crate) fn expire_settled_requests(&self) {
        let mut state = self.requests.lock().expect("tool request cache lock");
        for slot in state.entries.values_mut() {
            if slot.settled_at.is_some() {
                slot.settled_at = Some(Instant::now() - REQUEST_CACHE_TTL - Duration::from_secs(1));
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn backdate_inflight_request(&self, request_id: &str) {
        let mut state = self.requests.lock().expect("tool request cache lock");
        let slot = state
            .entries
            .iter_mut()
            .find(|(key, _)| key.request_id == request_id)
            .map(|(_, slot)| slot)
            .expect("inflight request slot");
        assert!(slot.settled_at.is_none());
        slot.inflight_started_at = Instant::now() - REQUEST_CACHE_TTL - Duration::from_secs(1);
    }

    pub(crate) fn list_tools(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        validate_context(context)?;
        let has_vault = backend.knowledge().current_vault_id().is_ok();
        let execution_available = backend.execution().available();
        let mut definitions = self.base_definitions(has_vault, execution_available);
        if context.caller == ToolCallerKind::Agent {
            if !context.knowledge_target_is_current(backend) {
                definitions.retain(|definition| {
                    !definition.id.starts_with("knowledge.") && definition.id != "capability.run"
                });
            }
            if context.canvas_scope.is_some() {
                definitions.retain(|definition| {
                    crate::agent_capabilities::pack_for_tool(&definition.id) == "canvas-compat"
                        || AGENT_CANVAS_TOOL_IDS.contains(&definition.id.as_str())
                });
            } else {
                definitions.retain(|definition| !definition.id.starts_with("canvas."));
            }
            definitions = backend
                .agent_capabilities()
                .filter_live_definitions(definitions)
                .map_err(|error| ToolError::new(error.code, error.message))?;
            if let Err(error) = context.web_scope().and_then(|scope| {
                backend
                    .web_tools()
                    .scope_search_ready(scope)
                    .map_err(ToolError::from_web)
            }) {
                for definition in definitions
                    .iter_mut()
                    .filter(|definition| definition.id.starts_with("web."))
                {
                    definition.availability = unavailable(error.code, &error.message);
                }
            }
            if context
                .browser_scope()
                .map(|scope| backend.agent_browser().scope_ready(scope))
                != Ok(true)
            {
                for definition in definitions
                    .iter_mut()
                    .filter(|definition| definition.id.starts_with("browser."))
                {
                    definition.availability =
                        unavailable("agent-browser-unavailable", "Agent Browser is unavailable");
                }
            }
            if let Some(scope) = context.canvas_scope {
                if backend.canvas_agent().inspect(scope).is_err() {
                    for definition in definitions
                        .iter_mut()
                        .filter(|definition| definition.id.starts_with("canvas."))
                    {
                        definition.availability = unavailable(
                            "canvas-agent-context-unavailable",
                            "Canvas capability context is unavailable",
                        );
                    }
                }
            }
            if backend.workspace().has_enabled_grants().unwrap_or(false) == false {
                for definition in definitions.iter_mut().filter(|definition| {
                    definition.id.starts_with("workspace.")
                        || definition.id.starts_with("execution.")
                }) {
                    definition.availability = unavailable(
                        "workspace-grant-required",
                        "Authorize a workspace root before using this tool",
                    );
                }
            }
        } else {
            definitions.retain(|definition| {
                !definition.id.starts_with("web.")
                    && !definition.id.starts_with("browser.")
                    && !definition.id.starts_with("canvas.")
                    && !definition.id.starts_with("memory.")
                    && !definition.id.starts_with("skills.")
                    && !definition.id.starts_with("workspace.")
                    && !definition.id.starts_with("execution.")
                    && !definition.id.starts_with("schedule.")
                    && !matches!(
                        definition.id.as_str(),
                        "materials.inspect"
                            | "materials.preview"
                            | "materials.references"
                            | "materials.taxonomy"
                            | "materials.set_tags"
                            | "materials.categorize"
                            | "materials.import_from_grant"
                    )
            });
        }
        definitions.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(definitions)
    }

    pub(crate) fn agent_catalog_definitions(
        &self,
        backend: &BackendServices,
    ) -> Vec<ToolDefinition> {
        self.base_definitions(
            backend.knowledge().current_vault_id().is_ok(),
            backend.execution().available(),
        )
    }

    pub(crate) fn run_tool(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        request: ToolRunRequest,
    ) -> Result<ToolRunResult, ToolError> {
        validate_context(context)?;
        if let Some(snapshot) = context.capability_snapshot.as_deref() {
            backend
                .agent_capabilities()
                .assert_snapshot_current(snapshot, &request.tool_id)
                .map_err(|error| ToolError::new(error.code, error.message))?;
        }
        let definitions = self.list_tools(backend, context)?;
        let definition = definitions
            .iter()
            .find(|definition| definition.id == request.tool_id)
            .ok_or_else(|| ToolError::new("tool-not-found", "Tool does not exist"))?;
        if context.max_risk < definition.risk {
            return Err(ToolError::new(
                "tool-risk-denied",
                "Tool risk is not granted to this caller",
            ));
        }
        if !definition.availability.available && definition.id != "materials.search" {
            return Err(unavailable_tool_error(definition));
        }
        let input_bytes = serde_json::to_vec(&request.input)
            .map_err(|_| ToolError::new("tool-input-invalid", "Tool input is invalid"))?;
        if input_bytes.len() > definition.max_input_bytes {
            return Err(ToolError::new(
                "tool-input-too-large",
                "Tool input exceeds its declared limit",
            ));
        }
        drop(input_bytes);
        validate_json_limits(&request.input)?;
        validate_schema(&definition.input_schema, &request.input, "input")?;
        let embedded_request_id = request
            .input
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let request_id = merge_request_ids(request.request_id, embedded_request_id)?;
        if definition.risk >= ToolRisk::Write && request_id.is_none() {
            return Err(ToolError::new(
                "tool-input-invalid",
                "Write tools require requestId",
            ));
        }
        let input_digest = canonical_json_digest(&request.input)?;
        if definition.id == "capability.run"
            && request_id.as_ref().is_some_and(|request_id| {
                !self.request_slot_exists(definition, context, request_id)
            })
        {
            let connection = backend.open_write().map_err(|_| {
                ToolError::new(
                    "backend-database-unavailable",
                    "Capability state is unavailable",
                )
            })?;
            crate::seed_local_capabilities(&connection).map_err(|_| {
                ToolError::new("capability-unavailable", "Capability state is unavailable")
            })?;
        }
        self.authorize_current(backend, context, definition, &request.input)?;
        if let Some(request_id) = request_id.clone() {
            return self.run_idempotent(
                backend,
                context,
                definition,
                request.input,
                request_id,
                input_digest,
            );
        }
        self.execute_checked(backend, context, definition, request.input, None, None)
    }

    pub(crate) fn prepare_agent_write(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        request: ToolRunRequest,
        scope: AgentWriteScope,
    ) -> Result<PreparedAgentWrite, ToolError> {
        validate_context(context)?;
        if let Some(snapshot) = context.capability_snapshot.as_deref() {
            backend
                .agent_capabilities()
                .assert_snapshot_current(snapshot, &request.tool_id)
                .map_err(|error| ToolError::new(error.code, error.message))?;
        }
        if context.caller != ToolCallerKind::Agent
            || context.trust != ToolTrustMode::TrustedAgent
            || request.tool_id.starts_with("canvas.")
        {
            return Err(ToolError::new(
                "tool-risk-denied",
                "Agent write preparation is not available to this caller",
            ));
        }
        let definitions = self.base_definitions(
            backend.knowledge().current_vault_id().is_ok(),
            backend.execution().available(),
        );
        let definition = definitions
            .into_iter()
            .find(|definition| definition.id == request.tool_id)
            .ok_or_else(|| ToolError::new("tool-not-found", "Tool does not exist"))?;
        if definition.risk != ToolRisk::Write || !definition.availability.available {
            return Err(unavailable_tool_error(&definition));
        }
        let input_bytes = serde_json::to_vec(&request.input)
            .map_err(|_| ToolError::new("tool-input-invalid", "Tool input is invalid"))?;
        if input_bytes.len() > definition.max_input_bytes {
            return Err(ToolError::new(
                "tool-input-too-large",
                "Tool input exceeds its declared limit",
            ));
        }
        validate_json_limits(&request.input)?;
        validate_schema(&definition.input_schema, &request.input, "input")?;
        if matches!(definition.id.as_str(), "memory.update" | "memory.delete") {
            // The model may only target a reference that this exact Backend
            // run created from a safe memory.search observation. Resolve it
            // before an approval is issued, so forged/cross-run/stale tokens
            // cannot create an approval card or reach a write handler.
            let _ = context.memory_binding(required_string(&request.input, "memoryRef")?)?;
        }
        if definition.id == "workspace.patch_text" {
            // Resolve and authorize the run-bound fileRef before any approval
            // card exists. Forged, cross-run, consumed, and expired references
            // fail closed here, so they can never reach a user decision.
            let _ = context.file_binding(required_string(&request.input, "fileRef")?)?;
        }
        if definition.id == "workspace.change_set" {
            let request_id = request
                .input
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::new("tool-input-invalid", "requestId is required"))?;
            let _ = context.workspace_change_set_binding(request_id)?;
        }
        if definition.id == "execution.run" {
            // A recipe ref comes only from execution.list in this exact run.
            // Resolve it before an approval exists so forged, expired, and
            // cross-run refs cannot create a confirmation card.
            // The source check is intentionally before the approval wait. The
            // approved-write path later holds the same source lock through
            // permit consumption and dispatch, so checking again in the inner
            // handler would recursively acquire that mutex.
            context.verify_workspace_source(backend)?;
            let _ = context.execution_binding(required_string(&request.input, "recipeRef")?)?;
        }
        let visible_bytes = match definition.id.as_str() {
            "knowledge.create" | "knowledge.append" => {
                required_string(&request.input, "content")?.as_bytes().len()
            }
            "knowledge.set_tags" => serde_json::to_vec(
                request
                    .input
                    .get("tags")
                    .ok_or_else(|| ToolError::new("tool-input-invalid", "tags are required"))?,
            )
            .map_err(|_| ToolError::new("tool-input-invalid", "tags are invalid"))?
            .len(),
            _ => input_bytes.len(),
        };
        if visible_bytes > MAX_AGENT_WRITE_CONTENT_BYTES {
            return Err(ToolError::new(
                "tool-input-too-large",
                "Agent write preview exceeds the visible approval limit",
            ));
        }
        let embedded_request_id = request
            .input
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let request_id = merge_request_ids(request.request_id, embedded_request_id)?
            .ok_or_else(|| ToolError::new("tool-input-invalid", "Write tools require requestId"))?;
        validate_request_id(&request_id)?;
        if definition.id == "workspace.create_text" {
            let binding = context.workspace_create_binding(&request_id)?;
            let alias = required_string(&request.input, "grantAlias")?;
            let relative_path = required_string(&request.input, "relativePath")?;
            let content = required_string(&request.input, "content")?;
            if binding.workspace_name != alias
                || binding.relative_path != relative_path
                || binding.content_digest != format!("{:x}", Sha256::digest(content.as_bytes()))
            {
                return Err(ToolError::new(
                    "workspace-file-ref-invalid",
                    "Workspace create binding no longer matches this request",
                ));
            }
        }
        if definition.id == "workspace.change_set" {
            let binding = context.workspace_change_set_binding(&request_id)?;
            if binding.items.len() < 2
                || binding.items.len() > crate::agent_workspace::MAX_CHANGE_SET_FILES
            {
                return Err(ToolError::new(
                    "workspace-change-set-invalid",
                    "Workspace change set binding is invalid",
                ));
            }
        }
        let input_expected_vault_id = request
            .input
            .get("expectedVaultId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if request.tool_id.starts_with("knowledge.") || request.tool_id == "capability.run" {
            let expected_vault_id = input_expected_vault_id.as_deref().ok_or_else(|| {
                ToolError::new("tool-input-invalid", "expectedVaultId is required")
            })?;
            require_live_vault(backend, expected_vault_id)?;
        }
        let expected_revision = request
            .input
            .get("expectedRevision")
            .map(|value| match value {
                Value::String(value) => value.clone(),
                Value::Number(value) => value.to_string(),
                _ => String::new(),
            })
            .filter(|value| !value.is_empty());
        let input_digest = canonical_json_digest(&request.input)?;
        let knowledge_write = request.tool_id.starts_with("knowledge.");
        let workspace_write = matches!(
            request.tool_id.as_str(),
            "workspace.create_text"
                | "workspace.patch_text"
                | "workspace.change_set"
                | "execution.run"
        );
        let workspace_source = workspace_write
            .then(|| context.workspace_source())
            .flatten();
        let expected_vault_id = if knowledge_write {
            input_expected_vault_id
        } else {
            workspace_source.map(|source| source.vault_id.clone())
        };
        let source_epoch = if knowledge_write {
            Some(scope.source_epoch)
        } else {
            workspace_source.map(|source| source.source_epoch)
        };
        Ok(PreparedAgentWrite {
            definition,
            input: request.input,
            request_id: request_id.clone(),
            binding: AgentWriteBinding {
                local_turn_id: scope.local_turn_id,
                engine_session_id: scope.engine_session_id,
                engine_turn_id: scope.engine_turn_id,
                tool_call_id: scope.tool_call_id,
                generation: scope.generation,
                principal_digest: context.principal.0,
                tool_id: request.tool_id,
                request_id,
                input_digest,
                expected_vault_id,
                source_epoch,
                expected_revision,
            },
        })
    }

    pub(crate) fn run_prepared_agent_write(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        prepared: PreparedAgentWrite,
        permit: &dyn AgentWritePermit,
    ) -> Result<ToolRunResult, ToolError> {
        let never_cancelled = || false;
        self.run_prepared_agent_write_with_cancel(
            backend,
            context,
            prepared,
            permit,
            &never_cancelled,
        )
    }

    pub(crate) fn run_prepared_agent_write_with_cancel(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        prepared: PreparedAgentWrite,
        permit: &dyn AgentWritePermit,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<ToolRunResult, ToolError> {
        let execution_run = prepared.binding.tool_id == "execution.run";
        let write_context = context
            .agent_approved_write()
            .map_err(|error| mark_execution_pre_admission(error, execution_run))?;
        let knowledge = backend.knowledge();
        let _source = if let (Some(source_epoch), Some(expected_vault_id)) = (
            prepared.binding.source_epoch,
            prepared.binding.expected_vault_id.as_deref(),
        ) {
            #[cfg(test)]
            enter_request_test_gate(&BEFORE_AGENT_WRITE_SOURCE_LOCK, expected_vault_id);
            Some(
                knowledge
                    .lock_active_ui_source(source_epoch, Some(expected_vault_id))
                    .map_err(|error| {
                        // A workspace write inherits this fence only when a
                        // real Vault/source was active at prepare time. Do not
                        // expose the knowledge implementation code to the
                        // model or let a source switch become an uncertain
                        // post-dispatch outcome: no file handler has run yet.
                        if prepared.binding.tool_id.starts_with("workspace.") {
                            let _ = error;
                            ToolError::new(
                                "workspace-source-changed",
                                "Workspace write context changed",
                            )
                        } else {
                            ToolError::from_knowledge(error)
                        }
                    })
                    .map_err(|error| mark_execution_pre_admission(error, execution_run))?,
            )
        } else {
            None
        };
        self.authorize_current(
            backend,
            &write_context,
            &prepared.definition,
            &prepared.input,
        )
        .map_err(|error| mark_execution_pre_admission(error, execution_run))?;
        // This is the one write linearization point. The authority validates and
        // consumes the permit immediately before the real handler is entered.
        if cancelled() {
            if prepared.binding.tool_id == "workspace.change_set" {
                return Err(ToolError::from_workspace_commit_failure(
                    crate::agent_workspace::WorkspaceCommitFailure {
                        code: "workspace-change-set-stopped",
                        message: "Workspace change set stopped before dispatch".to_owned(),
                        disposition:
                            crate::agent_workspace::WorkspaceCommitDisposition::KnownNotWritten,
                    },
                ));
            }
            if prepared.binding.tool_id == "execution.run" {
                return Err(ToolError::new(
                    "execution-not-started",
                    "Controlled project check was stopped before launch",
                )
                .with_execution_dispatch_disposition(
                    crate::agent_execution::ExecutionDispatchDisposition::NotAdmitted,
                ));
            }
            return Err(ToolError::new(
                "tool-execution-aborted",
                "Agent write was stopped before dispatch",
            ));
        }
        if let Err(error) = permit.consume(&prepared.binding) {
            return Err(mark_execution_pre_admission(error, execution_run));
        }
        let execution_admitted = execution_run;
        self.execute_checked(
            backend,
            &write_context,
            &prepared.definition,
            prepared.input,
            Some(prepared.request_id),
            Some(cancelled),
        )
        .map_err(|error| {
            if execution_admitted {
                error.with_execution_dispatch_disposition(
                    crate::agent_execution::ExecutionDispatchDisposition::UnknownAfterAdmission,
                )
            } else {
                error
            }
        })
    }

    pub(crate) fn prepare_canvas_write(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        request: ToolRunRequest,
        scope: crate::canvas_agent::CanvasWriteScope,
    ) -> Result<crate::canvas_agent::PreparedCanvasWrite, ToolError> {
        validate_context(context)?;
        if context.caller != ToolCallerKind::Agent
            || context.trust != ToolTrustMode::TrustedAgent
            || !AGENT_CANVAS_WRITE_TOOL_IDS.contains(&request.tool_id.as_str())
        {
            return Err(ToolError::new(
                "tool-risk-denied",
                "Canvas write preparation is not available to this caller",
            ));
        }
        let canvas_scope = context.canvas_scope()?;
        let definition = self
            .base_definitions(
                backend.knowledge().current_vault_id().is_ok(),
                backend.execution().available(),
            )
            .into_iter()
            .find(|definition| definition.id == request.tool_id)
            .ok_or_else(|| ToolError::new("tool-not-found", "Tool does not exist"))?;
        let bytes = serde_json::to_vec(&request.input)
            .map_err(|_| ToolError::new("tool-input-invalid", "Tool input is invalid"))?;
        if bytes.len() > definition.max_input_bytes {
            return Err(ToolError::new(
                "tool-input-too-large",
                "Tool input exceeds its declared limit",
            ));
        }
        validate_json_limits(&request.input)?;
        validate_schema(&definition.input_schema, &request.input, "input")?;
        backend
            .canvas_agent()
            .prepare(
                canvas_scope,
                &request.tool_id,
                &request.input,
                scope,
                context.principal.0,
            )
            .map_err(ToolError::from_canvas)
    }

    pub(crate) fn run_prepared_canvas_write(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        prepared: crate::canvas_agent::PreparedCanvasWrite,
        permit: &dyn crate::canvas_agent::CanvasWritePermit,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
        journal: &dyn crate::canvas_agent::CanvasGenerationJournal,
    ) -> Result<ToolRunResult, ToolError> {
        let write_context = context.agent_approved_write()?;
        let tool_id = prepared.tool_id.clone();
        let request_id = prepared.binding.request_id.clone();
        let value = backend
            .canvas_agent()
            .execute_with_cancel(
                write_context.canvas_scope()?,
                prepared,
                permit,
                cancelled,
                journal,
            )
            .map_err(ToolError::from_canvas)?;
        Ok(ToolRunResult {
            tool_id,
            version: 1,
            result: value,
            request_id: Some(request_id),
        })
    }

    fn request_slot_exists(
        &self,
        definition: &ToolDefinition,
        context: &ToolCallContext,
        request_id: &str,
    ) -> bool {
        let key = RequestKey {
            tool_id: definition.id.clone(),
            principal_digest: context.principal.0,
            request_id: request_id.to_string(),
        };
        self.requests
            .lock()
            .ok()
            .is_some_and(|state| state.entries.contains_key(&key))
    }

    fn run_idempotent(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        definition: &ToolDefinition,
        input: Value,
        request_id: String,
        input_digest: [u8; 32],
    ) -> Result<ToolRunResult, ToolError> {
        validate_request_id(&request_id)?;
        let key = RequestKey {
            tool_id: definition.id.clone(),
            principal_digest: context.principal.0,
            request_id: request_id.clone(),
        };
        let (slot, leader) = {
            let mut state = self
                .requests
                .lock()
                .map_err(|_| ToolError::new("tool-lock-poisoned", "Tool request lock failed"))?;
            prune_request_state(&mut state);
            if let Some(existing) = state.entries.get(&key) {
                if existing.input_digest != input_digest {
                    return Err(ToolError::new(
                        "request-id-conflict",
                        "requestId was already used for different tool input",
                    ));
                }
                (existing.clone(), false)
            } else {
                let reservation = definition.max_output_bytes;
                if state.entries.len() >= REQUEST_CACHE_CAPACITY
                    || state
                        .retained_bytes
                        .checked_add(reservation)
                        .is_none_or(|total| total > REQUEST_CACHE_BYTE_BUDGET)
                {
                    return Err(ToolError::new(
                        "tool-request-capacity",
                        "Tool request capacity is exhausted",
                    ));
                }
                let slot = RequestSlot {
                    input_digest,
                    inflight_started_at: Instant::now(),
                    settled_at: None,
                    retained_bytes: reservation,
                    result: Arc::new((Mutex::new(None), Condvar::new())),
                };
                state.entries.insert(key.clone(), slot.clone());
                state.retained_bytes += reservation;
                (slot, true)
            }
        };

        let mut reservation_guard = leader.then(|| {
            ReservationGuard::new(self.requests.clone(), key.clone(), slot.result.clone())
        });

        if leader {
            #[cfg(test)]
            enter_request_execution_gate(&key.request_id);
            #[cfg(test)]
            if take_leader_abort_hook(&PANIC_LEADER_FOR, &key.request_id) {
                panic!("injected tool leader abort");
            }
            #[cfg(test)]
            if take_leader_abort_hook(&CANCEL_LEADER_FOR, &key.request_id) {
                drop(reservation_guard.take());
                return Err(ToolError::new(
                    "tool-execution-aborted",
                    "Tool execution ended before publication",
                ));
            }
            let result =
                self.execute_checked(backend, context, definition, input, Some(request_id), None);
            #[cfg(test)]
            enter_request_test_gate(&BEFORE_REQUEST_SETTLE, &key.request_id);
            match result {
                Ok(value) => {
                    let actual_bytes = serde_json::to_vec(&value)
                        .map_err(|_| {
                            ToolError::new("tool-output-invalid", "Tool output is invalid")
                        })?
                        .len();
                    let mut state = self.requests.lock().map_err(|_| {
                        ToolError::new("tool-lock-poisoned", "Tool request lock failed")
                    })?;
                    let previous = {
                        let entry = state
                            .entries
                            .get_mut(&key)
                            .filter(|entry| Arc::ptr_eq(&entry.result, &slot.result))
                            .ok_or_else(|| {
                                ToolError::new(
                                    "tool-execution-aborted",
                                    "Tool reservation ended before publication",
                                )
                            })?;
                        let previous = entry.retained_bytes;
                        entry.retained_bytes = actual_bytes;
                        entry.settled_at = Some(Instant::now());
                        previous
                    };
                    state.retained_bytes = state
                        .retained_bytes
                        .saturating_sub(previous)
                        .saturating_add(actual_bytes);
                    let (lock, condition) = &*slot.result;
                    let mut settled = lock.lock().map_err(|_| {
                        ToolError::new("tool-lock-poisoned", "Tool request lock failed")
                    })?;
                    *settled = Some(Ok(value.clone()));
                    condition.notify_all();
                    drop(settled);
                    drop(state);
                    reservation_guard
                        .as_mut()
                        .expect("leader reservation guard")
                        .disarm();
                    Ok(value)
                }
                Err(error) => {
                    let mut state = self.requests.lock().map_err(|_| {
                        ToolError::new("tool-lock-poisoned", "Tool request lock failed")
                    })?;
                    remove_request_slot(&mut state, &key, &slot.result);
                    let (lock, condition) = &*slot.result;
                    let mut settled = lock.lock().map_err(|_| {
                        ToolError::new("tool-lock-poisoned", "Tool request lock failed")
                    })?;
                    *settled = Some(Err(error.clone()));
                    condition.notify_all();
                    drop(settled);
                    drop(state);
                    reservation_guard
                        .as_mut()
                        .expect("leader reservation guard")
                        .disarm();
                    Err(error)
                }
            }
        } else {
            #[cfg(test)]
            enter_request_test_gate(&BEFORE_FOLLOWER_WAIT, &key.request_id);
            let (lock, condition) = &*slot.result;
            let settled = lock
                .lock()
                .map_err(|_| ToolError::new("tool-lock-poisoned", "Tool request lock failed"))?;
            let (settled, timeout) = condition
                .wait_timeout_while(settled, REQUEST_WAIT_TIMEOUT, |value| value.is_none())
                .map_err(|_| ToolError::new("tool-lock-poisoned", "Tool request lock failed"))?;
            if timeout.timed_out() && settled.is_none() {
                return Err(ToolError::new(
                    "tool-timeout",
                    "Tool request did not settle before the deadline",
                ));
            }
            let result = settled.clone().unwrap_or_else(|| {
                Err(ToolError::new(
                    "tool-timeout",
                    "Tool request did not settle before the deadline",
                ))
            });
            drop(settled);
            self.handoff_cached_result(
                backend,
                context,
                definition,
                &input,
                &key.request_id,
                result,
            )
        }
    }

    fn handoff_cached_result(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        definition: &ToolDefinition,
        input: &Value,
        _request_id: &str,
        result: Result<ToolRunResult, ToolError>,
    ) -> Result<ToolRunResult, ToolError> {
        self.authorize_current(backend, context, definition, input)?;
        #[cfg(test)]
        enter_request_test_gate(&AFTER_REAUTHORIZE_BEFORE_HANDOFF, _request_id);
        let result = result?;
        let Some(expected_vault_id) = expected_handoff_vault(definition, input, &result)? else {
            return Ok(result);
        };
        backend
            .knowledge()
            .with_current_vault_response_lease(&expected_vault_id, || {
                #[cfg(test)]
                enter_request_test_gate(&DURING_CURRENT_VAULT_HANDOFF, _request_id);
                validate_result_vault_identity(&result.result, &expected_vault_id)
                    .map(|_| result.clone())
            })
            .map_err(ToolError::from_knowledge)?
    }

    fn authorize_current(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        definition: &ToolDefinition,
        input: &Value,
    ) -> Result<(), ToolError> {
        validate_context(context)?;
        let current_definition = self
            .list_tools(backend, context)?
            .into_iter()
            .find(|candidate| candidate.id == definition.id)
            .ok_or_else(|| ToolError::new("tool-not-found", "Tool does not exist"))?;
        if context.max_risk < current_definition.risk {
            return Err(ToolError::new(
                "tool-risk-denied",
                "Tool risk is not granted to this caller",
            ));
        }
        if !current_definition.availability.available && current_definition.id != "materials.search"
        {
            return Err(unavailable_tool_error(&current_definition));
        }
        match current_definition.id.as_str() {
            "materials.search"
            | "materials.inspect"
            | "materials.preview"
            | "materials.references"
            | "materials.taxonomy"
            | "materials.set_tags"
            | "materials.categorize"
            | "materials.import_from_grant"
            | "memory.list"
            | "memory.search"
            | "memory.add"
            | "memory.update"
            | "memory.delete"
            | "skills.list"
            | "skills.view"
            | "skills.create"
            | "skills.patch"
            | "workspace.search"
            | "workspace.read"
            | "workspace.list"
            | "workspace.create_text"
            | "workspace.patch_text"
            | "workspace.change_set"
            | "execution.list"
            | "execution.run"
            | "schedule.list"
            | "schedule.create"
            | "schedule.edit"
            | "schedule.pause"
            | "schedule.resume"
            | "schedule.manual_trigger"
            | "schedule.remove"
            | "web.fetch"
            | "web.search"
            | "browser.open"
            | "browser.read"
            | "browser.extract"
            | "canvas.inspect"
            | "canvas.mutate"
            | "canvas.generate" => Ok(()),
            "knowledge.search" => {
                context.verify_knowledge_target(backend, None)?;
                backend
                    .knowledge()
                    .current_vault_id()
                    .map(|_| ())
                    .map_err(ToolError::from_knowledge)
            }
            "knowledge.read" => {
                let document_ref = parse_document_ref(input)?;
                context.verify_knowledge_target(backend, Some(&document_ref.vault_id))?;
                require_live_vault(backend, &document_ref.vault_id)
            }
            "knowledge.create" | "knowledge.append" | "knowledge.set_tags" => {
                let expected_vault_id = required_string(input, "expectedVaultId")?;
                context.verify_knowledge_target(backend, Some(expected_vault_id))?;
                require_live_vault(backend, expected_vault_id)
            }
            "capability.run" => {
                let expected_vault_id = required_string(input, "expectedVaultId")?;
                context.verify_knowledge_target(backend, Some(expected_vault_id))?;
                require_live_vault(backend, expected_vault_id)?;
                preflight_capability(backend, input).map(|_| ())
            }
            _ => Err(ToolError::new("tool-not-found", "Tool does not exist")),
        }
    }

    fn execute_checked(
        &self,
        backend: &BackendServices,
        context: &ToolCallContext,
        definition: &ToolDefinition,
        input: Value,
        request_id: Option<String>,
        cancelled: Option<&(dyn Fn() -> bool + Send + Sync)>,
    ) -> Result<ToolRunResult, ToolError> {
        if context
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(ToolError::new(
                "tool-timeout",
                "Tool deadline elapsed before dispatch",
            ));
        }
        let result = execute_tool(backend, context, definition.id.as_str(), &input, cancelled)?;
        #[cfg(test)]
        let result = {
            let mut result = result;
            if definition.risk >= ToolRisk::Write
                && take_write_output_corruption(request_id.as_deref())
            {
                result["unexpectedPostCommitField"] = Value::String("forced-invalid".to_string());
            }
            result
        };
        if definition.risk == ToolRisk::Read
            && context
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(ToolError::new("tool-timeout", "Read tool deadline elapsed"));
        }
        let output = ToolRunResult {
            tool_id: definition.id.clone(),
            version: definition.version,
            result,
            request_id,
        };
        let validation = validate_schema(&definition.output_schema, &output.result, "output")
            .and_then(|_| {
                serde_json::to_vec(&output)
                    .map_err(|_| ToolError::new("tool-output-invalid", "Tool output is invalid"))
            })
            .and_then(|bytes| {
                if bytes.len() <= definition.max_output_bytes {
                    Ok(())
                } else {
                    Err(ToolError::new(
                        "tool-output-too-large",
                        "Tool output exceeds its declared limit",
                    ))
                }
            });
        if let Err(error) = validation {
            if definition.risk < ToolRisk::Write {
                return Err(error);
            }
            let fallback = committed_output_fallback(definition, &input, &output)?;
            validate_schema(&definition.output_schema, &fallback.result, "output")?;
            let bytes = serde_json::to_vec(&fallback)
                .map_err(|_| ToolError::new("tool-output-invalid", "Tool output is invalid"))?;
            if bytes.len() > definition.max_output_bytes {
                return Err(ToolError::new(
                    "tool-output-too-large",
                    "Tool output exceeds its declared limit",
                ));
            }
            return Ok(fallback);
        }
        Ok(output)
    }

    fn base_definitions(&self, has_vault: bool, execution_available: bool) -> Vec<ToolDefinition> {
        let knowledge_availability = if has_vault {
            available()
        } else {
            unavailable(
                "knowledge-vault-required",
                "Open or create a Vault before using this tool",
            )
        };
        let mut definitions = vec![
            definition(
                "capability.run",
                "Run capability",
                "Runs a registered LuckyRay capability through the canonical executor.",
                ToolRisk::Dangerous,
                object_schema(
                    vec![
                        ("capabilityId", string_schema(1, 80)),
                        ("expectedVaultId", string_schema(1, 128)),
                        ("sourceMode", enum_schema(&["headless"])),
                        ("input", capability_payload_schema()),
                        ("requestId", string_schema(1, 96)),
                    ],
                    &[
                        "capabilityId",
                        "expectedVaultId",
                        "sourceMode",
                        "input",
                        "requestId",
                    ],
                ),
                capability_output_schema(),
                knowledge_availability.clone(),
                "request-id-single-flight",
                768 * 1024,
                MAX_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "knowledge.append",
                "Append to knowledge document",
                "Appends Markdown to a revision-checked Vault document.",
                ToolRisk::Write,
                document_mutation_schema("content", string_schema(1, MAX_WRITE_CONTENT_BYTES)),
                mutation_output_schema(),
                knowledge_availability.clone(),
                "request-id-single-flight",
                MAX_WRITE_CONTENT_BYTES + 4096,
                MAX_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "knowledge.create",
                "Create knowledge document",
                "Creates a no-clobber Markdown document in the current trusted Vault.",
                ToolRisk::Write,
                object_schema(
                    vec![
                        ("expectedVaultId", string_schema(1, 128)),
                        ("relativePath", string_schema(1, 512)),
                        ("title", string_schema(1, 256)),
                        ("content", string_schema(0, MAX_WRITE_CONTENT_BYTES)),
                        ("requestId", string_schema(1, 96)),
                    ],
                    &["expectedVaultId", "relativePath", "content", "requestId"],
                ),
                document_output_schema(),
                knowledge_availability.clone(),
                "request-id-single-flight",
                MAX_WRITE_CONTENT_BYTES + 4096,
                MAX_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "knowledge.read",
                "Read knowledge document",
                "Reads a canonical document from the current trusted Vault.",
                ToolRisk::Read,
                document_identity_schema(false),
                document_output_schema(),
                knowledge_availability.clone(),
                "read-only",
                4096,
                MAX_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "knowledge.search",
                "Search knowledge",
                "Searches the authoritative backend Knowledge Index.",
                ToolRisk::Read,
                object_schema(
                    vec![
                        ("query", string_schema(0, 1024)),
                        ("limit", integer_schema(1, 50)),
                    ],
                    &["query"],
                ),
                knowledge_search_output_schema(),
                knowledge_availability.clone(),
                "read-only",
                4096,
                MAX_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "knowledge.set_tags",
                "Set knowledge tags",
                "Replaces frontmatter tags with revision and Vault guards.",
                ToolRisk::Write,
                document_mutation_schema(
                    "tags",
                    json!({"type":"array","maxItems":64,"items":string_schema(1, 128)}),
                ),
                mutation_output_schema(),
                knowledge_availability,
                "request-id-single-flight",
                16 * 1024,
                MAX_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "materials.search",
                "Search materials",
                "Searches MaterialCatalog and returns public-safe logical metadata. If multiple candidates match a name, ask user to choose instead of inspecting each candidate endlessly.",
                ToolRisk::Read,
                object_schema(
                    vec![
                        ("query", string_schema(0, 1024)),
                        ("limit", integer_schema(1, 50)),
                    ],
                    &["query"],
                ),
                materials_search_output_schema(),
                available(),
                "read-only",
                4096,
                MAX_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "web.fetch",
                "Fetch web page",
                "Fetches a validated public HTTP(S) page through LuckyRay's bounded network adapter.",
                ToolRisk::Read,
                object_schema(
                    vec![("fetchRef", string_schema(69, 69))],
                    &["fetchRef"],
                ),
                web_fetch_output_schema(),
                available(),
                "read-only",
                8192,
                MAX_WEB_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "web.search",
                "Search the web",
                "Searches a configured SearXNG JSON endpoint through LuckyRay's replaceable adapter.",
                ToolRisk::Read,
                object_schema(
                    vec![
                        ("query", string_schema(1, 1024)),
                        ("limit", integer_schema(5, 8)),
                    ],
                    &["query"],
                ),
                web_search_output_schema(),
                available(),
                "read-only",
                4096,
                MAX_WEB_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "browser.open",
                "Open dynamic web page",
                "Opens a server-issued navigation reference in the isolated read-only Agent Browser.",
                ToolRisk::Read,
                object_schema(vec![("navigationRef", string_schema(52, 52))], &["navigationRef"]),
                object_schema(
                    vec![
                        ("browserRef", string_schema(56, 56)),
                        ("state", json!({"type":"string","enum":["ready"]})),
                        ("host", string_schema(1, 253)),
                        ("sourceToken", string_schema(70, 70)),
                        ("sourceKind", json!({"type":"string","enum":["browser"]})),
                    ],
                    &["browserRef", "state", "host", "sourceToken", "sourceKind"],
                ),
                available(),
                "turn-scoped-read-only",
                1024,
                MAX_WEB_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "browser.read",
                "Read dynamic web page",
                "Reads bounded visible text from the current isolated Agent Browser page.",
                ToolRisk::Read,
                object_schema(vec![("browserRef", string_schema(56, 56))], &["browserRef"]),
                json!({"type":"object","additionalProperties":false,"required":["kind","host","title","visibleText","characterCount"],"properties":{"kind":{"type":"string","enum":["read"]},"host":{"type":"string","minLength":1,"maxLength":253},"title":{"type":"string","maxLength":512},"visibleText":{"type":"string","maxLength":24576},"characterCount":{"type":"integer","minimum":0,"maximum":24576}}}),
                available(),
                "turn-scoped-read-only",
                1024,
                MAX_WEB_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "browser.extract",
                "Extract dynamic page structure",
                "Extracts a fixed bounded structure without accepting selectors or JavaScript.",
                ToolRisk::Read,
                object_schema(
                    vec![
                        ("browserRef", string_schema(56, 56)),
                        ("kind", json!({"type":"string","enum":["main","article","headings","links","table"]})),
                        ("index", integer_schema(0, 15)),
                    ],
                    &["browserRef", "kind"],
                ),
                json!({"type":"object","additionalProperties":true,"required":["kind","host"],"properties":{"kind":{"type":"string","enum":["main","article","headings","links","table"]},"host":{"type":"string","minLength":1,"maxLength":253},"title":{"type":"string","maxLength":512},"visibleText":{"type":"string","maxLength":24576},"items":{"type":"array","maxItems":64},"rows":{"type":"array","maxItems":40},"index":{"type":"integer","minimum":0,"maximum":15}}}),
                available(),
                "turn-scoped-read-only",
                2048,
                MAX_WEB_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "canvas.inspect",
                "Inspect current Canvas",
                "Reads the bounded safe structure of the server-bound current Canvas.",
                ToolRisk::Read,
                object_schema(vec![], &[]),
                json!({"type":"object","additionalProperties":false,"required":["revision","nodeCount","edgeCount","nodes","edges","truncated"],"properties":{"revision":{"type":"integer","minimum":0},"nodeCount":{"type":"integer","minimum":0},"edgeCount":{"type":"integer","minimum":0},"nodes":{"type":"array","maxItems":160},"edges":{"type":"array","maxItems":240},"truncated":{"type":"boolean"}}}),
                available(),
                "turn-scoped-read-only",
                256,
                MAX_WEB_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "canvas.mutate",
                "Propose Canvas changes",
                "Prepares a bounded structured Canvas mutation for explicit user approval.",
                ToolRisk::Write,
                object_schema(
                    vec![
                        ("requestId", string_schema(1, 96)),
                        (
                            "operations",
                            json!({
                                "type":"array",
                                "minItems":1,
                                "maxItems":32,
                                "items":{
                                    "oneOf":[
                                        {"type":"object","additionalProperties":false,"required":["op","kind","title","x","y"],"properties":{"op":{"const":"create"},"kind":{"type":"string","enum":["text","note-ref","material-ref"]},"title":{"type":"string","minLength":1,"maxLength":256},"text":{"type":"string","maxLength":32768},"referenceToken":{"type":"string","minLength":1,"maxLength":128},"x":{"type":"number","minimum":-1000000,"maximum":1000000},"y":{"type":"number","minimum":-1000000,"maximum":1000000}}},
                                        {"type":"object","additionalProperties":false,"required":["op","nodeId"],"properties":{"op":{"const":"update"},"nodeId":{"type":"string","minLength":1,"maxLength":128},"title":{"type":"string","minLength":1,"maxLength":256},"text":{"type":"string","minLength":1,"maxLength":32768}}},
                                        {"type":"object","additionalProperties":false,"required":["op","nodeIds","layout"],"properties":{"op":{"const":"arrange"},"nodeIds":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","minLength":1,"maxLength":128}},"layout":{"type":"string","enum":["grid","row","column"]}}},
                                        {"type":"object","additionalProperties":false,"required":["op","sourceId","targetId"],"properties":{"op":{"const":"connect"},"sourceId":{"type":"string","minLength":1,"maxLength":128},"targetId":{"type":"string","minLength":1,"maxLength":128}}},
                                        {"type":"object","additionalProperties":false,"required":["op","sourceId","targetId"],"properties":{"op":{"const":"disconnect"},"sourceId":{"type":"string","minLength":1,"maxLength":128},"targetId":{"type":"string","minLength":1,"maxLength":128}}},
                                        {"type":"object","additionalProperties":false,"required":["op","nodeIds","title"],"properties":{"op":{"const":"group"},"nodeIds":{"type":"array","minItems":2,"maxItems":32,"items":{"type":"string","minLength":1,"maxLength":128}},"title":{"type":"string","minLength":1,"maxLength":256}}},
                                        {"type":"object","additionalProperties":false,"required":["op","groupId"],"properties":{"op":{"const":"ungroup"},"groupId":{"type":"string","minLength":1,"maxLength":128}}}
                                    ]
                                }
                            }),
                        ),
                    ],
                    &["requestId", "operations"],
                ),
                json!({"type":"object","additionalProperties":false,"required":["ok","revision","contentDigest","artifactName","committedWarning"],"properties":{"ok":{"type":"boolean"},"revision":{"type":"integer","minimum":1},"contentDigest":{"type":"string","minLength":64,"maxLength":64},"artifactName":{"type":"string","maxLength":80},"committedWarning":{"type":"boolean"}}}),
                available(),
                "approval-one-shot-cas",
                64 * 1024,
                MAX_WEB_TOOL_OUTPUT_BYTES,
            ),
            definition(
                "canvas.generate",
                "Propose Canvas generation",
                "Prepares a bounded text, image, or video generation node for explicit user approval.",
                ToolRisk::Write,
                object_schema(
                    vec![
                        ("requestId", string_schema(1, 96)),
                        ("kind", enum_schema(&["text", "image", "video"])),
                        ("prompt", string_schema(1, 16 * 1024)),
                    ],
                    &["requestId", "kind", "prompt"],
                ),
                json!({"type":"object","additionalProperties":false,"required":["ok","revision","contentDigest","artifactName","committedWarning"],"properties":{"ok":{"type":"boolean"},"revision":{"type":"integer","minimum":1},"contentDigest":{"type":"string","minLength":64,"maxLength":64},"artifactName":{"type":"string","maxLength":80},"committedWarning":{"type":"boolean"}}}),
                available(),
                "approval-one-shot-cas",
                24 * 1024,
                MAX_WEB_TOOL_OUTPUT_BYTES,
            ),
        ];
        definitions.extend(r6_agent_definitions(execution_available));
        definitions
    }
}

fn r6_agent_definitions(execution_available: bool) -> Vec<ToolDefinition> {
    let read_object = || {
        json!({
            "type": "object",
            "additionalProperties": true
        })
    };
    let read_array = || {
        json!({
            "type": "array",
            "maxItems": 100,
            "items": {"type": "object", "additionalProperties": true}
        })
    };
    let write_output = || {
        json!({
            "type": "object",
            "additionalProperties": true
        })
    };
    let scope_schema = || enum_schema(&["global", "vault"]);
    let resource_schema = || {
        json!({
            "type": "array",
            "maxItems": 64,
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "content"],
                "properties": {
                    "path": string_schema(1, 240),
                    "content": string_schema(0, 64 * 1024)
                }
            }
        })
    };
    let skill_package_schema = || {
        object_schema(
            vec![
                ("skillId", string_schema(1, 160)),
                ("name", string_schema(1, 120)),
                ("description", string_schema(1, 500)),
                ("version", string_schema(5, 24)),
                ("scope", scope_schema()),
                ("skillMd", string_schema(1, 64 * 1024)),
                ("resources", resource_schema()),
            ],
            &[
                "skillId",
                "name",
                "description",
                "version",
                "scope",
                "skillMd",
                "resources",
            ],
        )
    };
    let execution_availability = if execution_available {
        available()
    } else {
        unavailable(
            "execution-unavailable",
            "Controlled project checking is unavailable",
        )
    };
    vec![
        definition(
            "memory.list",
            "List saved memory",
            "Lists at most 20 saved memories available to this run: global plus the current knowledge base, or global only when no knowledge base is open. Use this for requests to list, verify, or discover saved memories; do not guess keywords. Results expose only opaque per-run memoryRef values for a later approved update or delete.",
            ToolRisk::Read,
            object_schema(vec![("limit", integer_schema(1, 20))], &[]),
            read_array(),
            available(),
            "read-only-bounded",
            1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "memory.search",
            "Search memory",
            "Finds memory by one non-empty query using literal keyword matching (not semantic search). Use memory.list instead when the user asks what is saved. Do not repeat a no-result query or guess a chain of unrelated keywords. Results contain only opaque per-run memoryRef values for a later approved update or delete.",
            ToolRisk::Read,
            object_schema(
                vec![
                    ("query", string_schema(1, 1024)),
                    ("limit", integer_schema(1, 20)),
                    ("scope", enum_schema(&["all", "global"])),
                ],
                &["query"],
            ),
            read_array(),
            available(),
            "read-only",
            4096,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "memory.add",
            "Propose memory",
            "Proposes an explicit user-requested global or Vault memory with optional TTL.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("content", string_schema(1, 16 * 1024)),
                    ("scope", scope_schema()),
                    ("importance", json!({"type":"number","minimum":0,"maximum":1})),
                    ("ttlSeconds", integer_schema(60, 315_360_000)),
                    ("requestId", string_schema(1, 96)),
                ],
                &["content", "scope", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            24 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "memory.update",
            "Update memory",
            "Proposes a revision-checked update to a memory returned by memory.list or memory.search in this same run. Use its opaque memoryRef only; LuckyRay owns the durable identity and revision. Every update requires user approval.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("memoryRef", string_schema(1, 160)),
                    ("content", string_schema(1, 16 * 1024)),
                    ("importance", json!({"type":"number","minimum":0,"maximum":1})),
                    ("ttlSeconds", integer_schema(60, 315_360_000)),
                    ("requestId", string_schema(1, 96)),
                ],
                &["memoryRef", "content", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            24 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "memory.delete",
            "Delete memory",
            "Proposes revision-checked deletion of a memory returned by memory.list or memory.search in this same run. Use its opaque memoryRef only; LuckyRay owns the durable identity and revision. Every deletion requires user approval.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("memoryRef", string_schema(1, 160)),
                    ("requestId", string_schema(1, 96)),
                ],
                &["memoryRef", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            4096,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "skills.list",
            "List skills",
            "Lists enabled audited Skills without loading their full instructions.",
            ToolRisk::Read,
            object_schema(vec![], &[]),
            read_array(),
            available(),
            "read-only",
            256,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "skills.view",
            "View skill",
            "Loads one enabled SKILL.md or one declared resource through progressive disclosure.",
            ToolRisk::Read,
            object_schema(
                vec![
                    ("skillId", string_schema(1, 160)),
                    ("resourcePath", string_schema(1, 240)),
                ],
                &["skillId"],
            ),
            read_object(),
            available(),
            "read-only",
            1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "skills.create",
            "Create skill version",
            "Stages a complete, script-free Skill package for approval and immutable commit.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("package", skill_package_schema()),
                    ("requestId", string_schema(1, 96)),
                ],
                &["package", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            128 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "skills.patch",
            "Patch skill version",
            "Stages a complete replacement Skill version with digest CAS.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("expectedDigest", string_schema(64, 64)),
                    ("package", skill_package_schema()),
                    ("requestId", string_schema(1, 96)),
                ],
                &["expectedDigest", "package", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            128 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "materials.inspect",
            "Inspect material",
            "Returns safe MaterialCatalog metadata and a revision digest without local paths.",
            ToolRisk::Read,
            object_schema(vec![("assetId", string_schema(1, 200))], &["assetId"]),
            read_object(),
            available(),
            "read-only",
            1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "materials.preview",
            "Preview material",
            "Returns bounded UTF-8 text content when safe, otherwise useful media metadata, without filesystem disclosure.",
            ToolRisk::Read,
            object_schema(vec![("assetId", string_schema(1, 200))], &["assetId"]),
            read_object(),
            available(),
            "read-only",
            1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "materials.references",
            "Inspect material references",
            "Returns bounded reference counts for a MaterialCatalog item.",
            ToolRisk::Read,
            object_schema(vec![("assetId", string_schema(1, 200))], &["assetId"]),
            read_object(),
            available(),
            "read-only",
            1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "materials.taxonomy",
            "List material taxonomy",
            "Lists safe material tags and folders for classification.",
            ToolRisk::Read,
            object_schema(vec![], &[]),
            read_object(),
            available(),
            "read-only",
            256,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "materials.set_tags",
            "Set material tags",
            "Proposes a revision-checked full tag replacement using only existing tag IDs returned by materials.taxonomy. It never creates tags; when adding a tag, preserve the inspected existing tag IDs.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("assetId", string_schema(1, 200)),
                    ("expectedRevision", string_schema(64, 64)),
                    (
                        "tagIds",
                        json!({"type":"array","maxItems":64,"uniqueItems":true,"items":string_schema(1, 200)}),
                    ),
                    ("requestId", string_schema(1, 96)),
                ],
                &["assetId", "expectedRevision", "tagIds", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            16 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "materials.categorize",
            "Categorize material",
            "Proposes revision-checked movement into a material folder.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("assetId", string_schema(1, 200)),
                    ("expectedRevision", string_schema(64, 64)),
                    ("folderId", nullable_string_schema(200)),
                    ("requestId", string_schema(1, 96)),
                ],
                &["assetId", "expectedRevision", "folderId", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            4096,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "materials.import_from_grant",
            "Import authorized material",
            "Copies one regular file from a user-authorized workspace (selected by its safe display name) into managed materials.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("grantAlias", string_schema(1, 160)),
                    ("relativePath", string_schema(1, 1024)),
                    ("folderId", nullable_string_schema(200)),
                    ("requestId", string_schema(1, 96)),
                ],
                &["grantAlias", "relativePath", "folderId", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            4096,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "workspace.list",
            "List authorized workspaces",
            "Lists the safe display names of the workspaces authorized for this run. Use the returned name as the grantAlias for workspace.search and workspace.read.",
            ToolRisk::Read,
            object_schema(vec![], &[]),
            read_array(),
            available(),
            "read-only",
            256,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "workspace.search",
            "Search authorized workspace",
            "Finds authorized files by filename and searches bounded text content only in readableText files. Each result says readableText and importableMaterial: use workspace.read only when readableText is true; use materials.import_from_grant for an importable material such as an image.",
            ToolRisk::Read,
            object_schema(
                vec![
                    ("grantAlias", string_schema(1, 160)),
                    ("query", string_schema(1, 1024)),
                    ("limit", integer_schema(1, 50)),
                ],
                &["grantAlias", "query"],
            ),
            read_array(),
            available(),
            "read-only",
            4096,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "workspace.read",
            "Read authorized workspace file",
            "Reads one bounded UTF-8 text file from an authorized workspace. Call it only for a workspace.search result marked readableText=true; binary files return a recoverable denial and may instead be imported through materials.import_from_grant. When the read is a complete, untruncated UTF-8 text file within the write size limit, the result includes a one-shot fileRef for workspace.patch_text.",
            ToolRisk::Read,
            object_schema(
                vec![
                    ("grantAlias", string_schema(1, 160)),
                    ("relativePath", string_schema(1, 1024)),
                ],
                &["grantAlias", "relativePath"],
            ),
            read_object(),
            available(),
            "read-only",
            4096,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "workspace.create_text",
            "Create a text file in an authorized workspace",
            "Proposes a single new UTF-8 (no BOM, LF) text file inside an authorized workspace root. The parent folder must already exist and be safe; directories are never created. The target must not exist and is never overwritten. A complete preview is shown for approval before anything is written.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("grantAlias", string_schema(1, 160)),
                    ("relativePath", string_schema(1, 512)),
                    ("content", string_schema(1, 24 * 1024)),
                    ("requestId", string_schema(1, 96)),
                ],
                &["grantAlias", "relativePath", "content", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            28 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "workspace.patch_text",
            "Patch a text file in an authorized workspace",
            "Proposes UTF-16-offset edits to a text file previously read in this run through workspace.read using the returned fileRef. The Backend validates every offset on a character boundary, rejects overlapping edits, builds the complete diff, and commits with a compare-and-swap so an external edit or concurrent write yields exactly one winner. The final identity and digest are always Backend-computed.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("fileRef", string_schema(1, 128)),
                    (
                        "edits",
                        json!({
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 64,
                            "items": object_schema(
                                vec![
                                    ("startUtf16", integer_schema(0, 24 * 1024)),
                                    ("endUtf16", integer_schema(0, 24 * 1024)),
                                    ("replacement", string_schema(0, 24 * 1024)),
                                ],
                                &["startUtf16", "endUtf16", "replacement"],
                            ),
                        }),
                    ),
                    ("requestId", string_schema(1, 96)),
                ],
                &["fileRef", "edits", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            32 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "workspace.change_set",
            "Propose a bounded Workspace change set",
            "Proposes 2 to 8 complete UTF-8 text-file creates or patches as one approval. Every item must use an authorized workspace name; patches require a fileRef from workspace.read in this run. LuckyRay validates every file, shows every complete preview, then either applies the bounded set sequentially with an honest partial result or writes nothing before the first file. Never include hidden paths, digests, or file identities.",
            ToolRisk::Write,
            object_schema(
                vec![
                    (
                        "changes",
                        json!({
                            "type":"array",
                            "minItems":2,
                            "maxItems":8,
                            "items":{
                                "oneOf":[
                                    {
                                        "type":"object",
                                        "additionalProperties":false,
                                        "required":["operation","grantAlias","relativePath","content"],
                                        "properties":{
                                            "operation":{"const":"create"},
                                            "grantAlias": string_schema(1, 160),
                                            "relativePath": string_schema(1, 512),
                                            "content": string_schema(1, 24 * 1024)
                                        }
                                    },
                                    {
                                        "type":"object",
                                        "additionalProperties":false,
                                        "required":["operation","fileRef","edits"],
                                        "properties":{
                                            "operation":{"const":"patch"},
                                            "fileRef": string_schema(1, 128),
                                            "edits":{
                                                "type":"array",
                                                "minItems":1,
                                                "maxItems":64,
                                                "items": object_schema(
                                                    vec![
                                                        ("startUtf16", integer_schema(0, 24 * 1024)),
                                                        ("endUtf16", integer_schema(0, 24 * 1024)),
                                                        ("replacement", string_schema(0, 24 * 1024)),
                                                    ],
                                                    &["startUtf16", "endUtf16", "replacement"],
                                                )
                                            }
                                        }
                                    }
                                ]
                            }
                        }),
                    ),
                    ("requestId", string_schema(1, 96)),
                ],
                &["changes", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-change-set",
            112 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "execution.list",
            "List controlled project checks",
            "Lists only Backend-issued, fixed LuckyRay project checks for one authorized workspace. This does not grant a shell, project scripts, dependency installation, arbitrary commands, or network access.",
            ToolRisk::Read,
            object_schema(
                vec![("grantAlias", string_schema(1, 160))],
                &["grantAlias"],
            ),
            read_array(),
            execution_availability.clone(),
            "read-only-bounded",
            1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "execution.run",
            "Run controlled project check",
            "Proposes exactly one Backend-issued project check returned by execution.list in this same run. LuckyRay will show the fixed check and require confirmation. It never accepts an executable, shell command, arguments, working directory, environment, project script, dependency installation, or network request.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("recipeRef", string_schema(1, 160)),
                    ("requestId", string_schema(1, 96)),
                ],
                &["recipeRef", "requestId"],
            ),
            write_output(),
            execution_availability,
            "approval-one-shot-recipe",
            4096,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "schedule.list",
            "List schedules",
            "Lists app-owned schedules and their latest safe run status.",
            ToolRisk::Read,
            object_schema(vec![], &[]),
            read_array(),
            available(),
            "read-only",
            256,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "schedule.create",
            "Create schedule",
            "Proposes a one-time or interval schedule; each fire creates a fresh R5 background run. For a relative one-time request use kind=once, runAt=null, intervalSeconds=null, and delaySeconds (60..31536000). For an absolute one-time request use an RFC3339 runAt and omit delaySeconds.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("title", string_schema(1, 120)),
                    ("prompt", string_schema(1, 64 * 1024)),
                    ("kind", enum_schema(&["once", "interval"])),
                    ("runAt", nullable_string_schema(64)),
                    ("intervalSeconds", nullable_integer_schema(60, 31_536_000)),
                    ("delaySeconds", integer_schema(60, 31_536_000)),
                    ("requestId", string_schema(1, 96)),
                ],
                &["title", "prompt", "kind", "runAt", "intervalSeconds", "requestId"],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            72 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        definition(
            "schedule.edit",
            "Edit schedule",
            "Proposes a revision-checked schedule replacement. Relative one-time timing uses delaySeconds and is resolved only after approval; absolute timing uses RFC3339 runAt.",
            ToolRisk::Write,
            object_schema(
                vec![
                    ("id", string_schema(1, 160)),
                    ("expectedRevision", integer_schema(1, i64::MAX)),
                    ("title", string_schema(1, 120)),
                    ("prompt", string_schema(1, 64 * 1024)),
                    ("kind", enum_schema(&["once", "interval"])),
                    ("runAt", nullable_string_schema(64)),
                    ("intervalSeconds", nullable_integer_schema(60, 31_536_000)),
                    ("delaySeconds", integer_schema(60, 31_536_000)),
                    ("requestId", string_schema(1, 96)),
                ],
                &[
                    "id",
                    "expectedRevision",
                    "title",
                    "prompt",
                    "kind",
                    "runAt",
                    "intervalSeconds",
                    "requestId",
                ],
            ),
            write_output(),
            available(),
            "approval-one-shot-cas",
            72 * 1024,
            MAX_TOOL_OUTPUT_BYTES,
        ),
        schedule_state_definition(
            "schedule.pause",
            "Pause schedule",
            "Pauses future fires and safely cancels work that has not started.",
        ),
        schedule_state_definition("schedule.resume", "Resume schedule", "Resumes future fires."),
        schedule_state_definition(
            "schedule.manual_trigger",
            "Trigger schedule now",
            "Queues one deduplicated fresh background run.",
        ),
        schedule_state_definition(
            "schedule.remove",
            "Remove schedule",
            "Soft-retires future fires, preserves history and results, and requests one Stop for a currently active run.",
        ),
    ]
}

fn schedule_state_definition(id: &str, title: &str, description: &str) -> ToolDefinition {
    definition(
        id,
        title,
        description,
        ToolRisk::Write,
        object_schema(
            vec![
                ("id", string_schema(1, 160)),
                ("expectedRevision", integer_schema(1, i64::MAX)),
                ("requestId", string_schema(1, 96)),
            ],
            &["id", "expectedRevision", "requestId"],
        ),
        json!({"type":"object","additionalProperties":true}),
        available(),
        "approval-one-shot-cas",
        4096,
        MAX_TOOL_OUTPUT_BYTES,
    )
}

fn nullable_string_schema(max_length: usize) -> Value {
    json!({
        "oneOf": [
            {"type": "null"},
            string_schema(1, max_length)
        ]
    })
}

fn nullable_integer_schema(minimum: i64, maximum: i64) -> Value {
    json!({
        "oneOf": [
            {"type": "null"},
            integer_schema(minimum, maximum)
        ]
    })
}

fn execute_tool(
    backend: &BackendServices,
    context: &ToolCallContext,
    tool_id: &str,
    input: &Value,
    cancelled: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> Result<Value, ToolError> {
    match tool_id {
        "knowledge.search" => execute_knowledge_search(backend, context, input),
        "knowledge.read" => execute_knowledge_read(backend, context, input),
        "materials.search" => execute_materials_search(backend, input),
        "memory.list" => execute_memory_list(context, backend, input),
        "memory.search" => execute_memory_search(context, backend, input),
        "memory.add" => execute_memory_add(context, backend, input),
        "memory.update" => execute_memory_update(context, backend, input),
        "memory.delete" => execute_memory_delete(context, backend, input),
        "skills.list" => execute_skills_list(backend),
        "skills.view" => execute_skills_view(backend, input),
        "skills.create" => execute_skills_create(backend, input),
        "skills.patch" => execute_skills_patch(backend, input),
        "materials.inspect" => execute_materials_inspect(backend, input),
        "materials.preview" => execute_materials_preview(backend, input),
        "materials.references" => execute_materials_references(backend, input),
        "materials.taxonomy" => backend
            .agent_materials()
            .taxonomy()
            .map_err(map_agent_material_error),
        "materials.set_tags" => execute_materials_set_tags(backend, input),
        "materials.categorize" => execute_materials_categorize(backend, input),
        "materials.import_from_grant" => {
            execute_materials_import_from_grant(context, backend, input)
        }
        "workspace.search" => execute_workspace_search(context, backend, input),
        "workspace.read" => execute_workspace_read(context, backend, input),
        "workspace.list" => execute_workspace_list(context),
        "workspace.create_text" => execute_workspace_create_text(context, backend, input),
        "workspace.patch_text" => execute_workspace_patch_text(context, backend, input),
        "workspace.change_set" => execute_workspace_change_set(context, backend, input, cancelled),
        "execution.list" => execute_execution_list(context, backend, input),
        "execution.run" => execute_execution_run(context, backend, input, cancelled),
        "schedule.list" => {
            let schedules = backend.schedules().list().map_err(map_schedule_error)?;
            Ok(Value::Array(
                schedules.into_iter().map(project_schedule_model).collect(),
            ))
        }
        "schedule.create" => execute_schedule_create(backend, context, input),
        "schedule.edit" => execute_schedule_edit(backend, input),
        "schedule.pause" => execute_schedule_state(backend, input, "pause"),
        "schedule.resume" => execute_schedule_state(backend, input, "resume"),
        "schedule.manual_trigger" => execute_schedule_state(backend, input, "manual-trigger"),
        "schedule.remove" => execute_schedule_state(backend, input, "remove"),
        "web.fetch" => backend
            .web_tools()
            .fetch(context.web_scope()?, input)
            .map_err(ToolError::from_web),
        "web.search" => {
            let web_scope = context.web_scope()?;
            let browser_scope = context.browser_scope()?;
            let mut output = backend
                .web_tools()
                .search(backend, web_scope, input)
                .map_err(ToolError::from_web)?;
            if let Some(results) = output.get_mut("results").and_then(Value::as_array_mut) {
                for result in results {
                    let Some(fetch_ref) = result.get("fetchRef").and_then(Value::as_str) else {
                        continue;
                    };
                    let raw_url = backend
                        .web_tools()
                        .navigation_url(web_scope, fetch_ref)
                        .map_err(ToolError::from_web)?;
                    let navigation_ref = backend
                        .agent_browser()
                        .remember_navigation(browser_scope, &raw_url)
                        .map_err(ToolError::from_browser)?;
                    if let Some(object) = result.as_object_mut() {
                        object.insert("navigationRef".into(), Value::String(navigation_ref));
                    }
                }
            }
            Ok(output)
        }
        "browser.open" => {
            let navigation_ref = required_string(input, "navigationRef")?;
            backend
                .agent_browser()
                .open(context.browser_scope()?, navigation_ref)
                .map_err(ToolError::from_browser)
        }
        "browser.read" => {
            let browser_ref = required_string(input, "browserRef")?;
            backend
                .agent_browser()
                .read(context.browser_scope()?, browser_ref)
                .map_err(ToolError::from_browser)
        }
        "browser.extract" => {
            let browser_ref = required_string(input, "browserRef")?;
            let kind = required_string(input, "kind")?;
            let index = optional_u64(input, "index");
            backend
                .agent_browser()
                .extract(context.browser_scope()?, browser_ref, kind, index)
                .map_err(ToolError::from_browser)
        }
        "canvas.inspect" => backend
            .canvas_agent()
            .inspect(context.canvas_scope()?)
            .map_err(ToolError::from_canvas),
        "knowledge.create" => execute_knowledge_create(backend, input),
        "knowledge.append" => execute_knowledge_append(backend, input),
        "knowledge.set_tags" => execute_knowledge_set_tags(backend, input),
        "capability.run" => execute_capability(backend, input),
        _ => Err(ToolError::new("tool-not-found", "Tool does not exist")),
    }
}

fn execute_memory_search(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let query = required_string(input, "query")?;
    if query.trim().is_empty() {
        return Err(ToolError::new(
            "memory-query-required",
            "Memory keyword search requires a non-empty literal query; use memory.list to discover saved memory",
        ));
    }
    let limit = optional_u64(input, "limit").unwrap_or(8).clamp(1, 20) as usize;
    let scope = if input.get("scope").and_then(Value::as_str) == Some("global") {
        crate::agent_memory::MemoryScope::global()
    } else {
        current_memory_scope(backend)
    };
    let bindings = context.memory_bindings()?;
    let entries = backend
        .memory()
        .search(&scope, query, limit)
        .map_err(map_memory_error)?;
    serialize_tool_output(
        entries
            .iter()
            .map(|entry| crate::agent_memory::project_memory_agent_entry(entry, &bindings))
            .collect::<Vec<_>>(),
    )
}

fn execute_memory_list(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let limit = optional_u64(input, "limit").unwrap_or(20).clamp(1, 20) as usize;
    let scope = current_memory_scope(backend);
    let bindings = context.memory_bindings()?;
    let entries = backend
        .memory()
        .list_for_agent(&scope, limit)
        .map_err(map_memory_error)?;
    serialize_tool_output(
        entries
            .iter()
            .map(|entry| crate::agent_memory::project_memory_agent_entry(entry, &bindings))
            .collect::<Vec<_>>(),
    )
}

fn execute_memory_add(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let scope = match required_string(input, "scope")? {
        "global" => crate::agent_memory::MemoryScope::global(),
        "vault" => current_vault_memory_scope(backend)?,
        _ => {
            return Err(ToolError::new(
                "tool-input-invalid",
                "Memory scope is invalid",
            ))
        }
    };
    let create = crate::agent_memory::MemoryCreateInput {
        content: required_string(input, "content")?.to_owned(),
        scope,
        importance: input.get("importance").and_then(Value::as_f64),
        ttl_seconds: optional_u64(input, "ttlSeconds"),
        source: Some("agent-approved".to_owned()),
    };
    let entry = backend.memory().create(create).map_err(map_memory_error)?;
    let bindings = context.memory_bindings()?;
    serialize_tool_output(crate::agent_memory::project_memory_agent_entry(
        &entry,
        bindings.as_ref(),
    ))
}

fn execute_memory_update(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let binding = context.memory_binding(required_string(input, "memoryRef")?)?;
    ensure_memory_binding_scope_current(backend, &binding)?;
    let previous_entry_id = binding.entry_id.clone();
    let update = crate::agent_memory::MemoryUpdateInput {
        id: binding.entry_id,
        expected_revision: binding.expected_revision,
        content: required_string(input, "content")?.to_owned(),
        source: None,
        importance: input.get("importance").and_then(Value::as_f64),
        ttl_seconds: optional_u64(input, "ttlSeconds"),
        replace_source: false,
        preserve_expiry: input.get("ttlSeconds").is_none(),
    };
    let entry = backend.memory().update(update).map_err(map_memory_error)?;
    let bindings = context.memory_bindings()?;
    let memory_ref = bindings.replace_entry(&previous_entry_id, &entry);
    let source_label = crate::agent_memory::memory_source_label(&entry).to_owned();
    let scope_label = crate::agent_memory::memory_scope_label(&entry).to_owned();
    serialize_tool_output(crate::agent_memory::MemoryAgentEntry {
        memory_ref,
        content: entry.content,
        source_label,
        scope_label,
    })
}

fn execute_memory_delete(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let binding = context.memory_binding(required_string(input, "memoryRef")?)?;
    ensure_memory_binding_scope_current(backend, &binding)?;
    backend
        .memory()
        .delete(crate::agent_memory::MemoryDeleteInput {
            id: binding.entry_id.clone(),
            expected_revision: binding.expected_revision,
        })
        .map_err(map_memory_error)?;
    context.memory_bindings()?.forget_entry(&binding.entry_id);
    Ok(json!({"ok": true, "deleted": true}))
}

fn ensure_memory_binding_scope_current(
    backend: &BackendServices,
    binding: &crate::agent_memory::MemoryRunBinding,
) -> Result<(), ToolError> {
    let Some(bound_vault) = binding.vault_id.as_deref() else {
        return Ok(());
    };
    let current_vault = backend
        .knowledge()
        .current_vault_id()
        .map_err(ToolError::from_knowledge)?;
    if current_vault == bound_vault {
        Ok(())
    } else {
        Err(ToolError::new(
            "memory-reference-invalid",
            "The selected memory reference is no longer current",
        ))
    }
}

fn execute_skills_list(backend: &BackendServices) -> Result<Value, ToolError> {
    let vault_id = backend.knowledge().current_vault_id().ok();
    serialize_tool_output(
        backend
            .skills()
            .list(vault_id.as_deref())
            .map_err(map_skill_error)?,
    )
}

fn execute_skills_view(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    let vault_id = backend.knowledge().current_vault_id().ok();
    serialize_tool_output(
        backend
            .skills()
            .view(
                required_string(input, "skillId")?,
                vault_id.as_deref(),
                input.get("resourcePath").and_then(Value::as_str),
            )
            .map_err(map_skill_error)?,
    )
}

fn execute_skills_create(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    let package = parse_skill_package(backend, input.get("package").cloned())?;
    serialize_tool_output(
        backend
            .skills()
            .create(
                crate::agent_skills::SkillCreateInput { package },
                "user-approved-agent",
            )
            .map_err(map_skill_error)?,
    )
}

fn execute_skills_patch(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    let package = parse_skill_package(backend, input.get("package").cloned())?;
    serialize_tool_output(
        backend
            .skills()
            .patch(
                crate::agent_skills::SkillPatchInput {
                    expected_digest: required_string(input, "expectedDigest")?.to_owned(),
                    package,
                },
                "user-approved-agent",
            )
            .map_err(map_skill_error)?,
    )
}

fn execute_materials_inspect(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    serialize_tool_output(
        backend
            .agent_materials()
            .inspect(required_string(input, "assetId")?)
            .map_err(map_agent_material_error)?,
    )
}

fn execute_materials_preview(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    backend
        .agent_materials()
        .preview(required_string(input, "assetId")?)
        .map_err(map_agent_material_error)
}

fn execute_materials_references(
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    backend
        .agent_materials()
        .references(required_string(input, "assetId")?)
        .map_err(map_agent_material_error)
}

fn execute_materials_set_tags(
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let tag_ids = input
        .get("tagIds")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::new("tool-input-invalid", "tagIds are required"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| ToolError::new("tool-input-invalid", "tagIds are invalid"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    serialize_tool_output(
        backend
            .agent_materials()
            .set_tags(crate::agent_materials::MaterialSetTagsInput {
                asset_id: required_string(input, "assetId")?.to_owned(),
                expected_revision: required_string(input, "expectedRevision")?.to_owned(),
                tag_ids,
            })
            .map_err(map_agent_material_error)?,
    )
}

fn execute_materials_categorize(
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    serialize_tool_output(
        backend
            .agent_materials()
            .categorize(crate::agent_materials::MaterialCategorizeInput {
                asset_id: required_string(input, "assetId")?.to_owned(),
                expected_revision: required_string(input, "expectedRevision")?.to_owned(),
                folder_id: input
                    .get("folderId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
            .map_err(map_agent_material_error)?,
    )
}

fn execute_materials_import_from_grant(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let grant_id = workspace_alias_to_grant_id(context, required_string(input, "grantAlias")?)?;
    backend
        .agent_materials()
        .import_from_grant(crate::agent_materials::MaterialImportFromGrantInput {
            grant_id,
            relative_path: required_string(input, "relativePath")?.to_owned(),
            folder_id: input
                .get("folderId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
        .map_err(map_agent_material_error)
}

fn workspace_alias_to_grant_id(
    context: &ToolCallContext,
    alias: &str,
) -> Result<String, ToolError> {
    let aliases = context.workspace_aliases().ok_or_else(|| {
        ToolError::new(
            "workspace-alias-invalid",
            "No workspace alias is bound to this run",
        )
    })?;
    aliases
        .iter()
        .find(|candidate| candidate.name == alias)
        .map(|candidate| candidate.grant_id.clone())
        .ok_or_else(|| {
            ToolError::new(
                "workspace-alias-invalid",
                "The workspace display name is not bound to this run",
            )
        })
}

fn execute_workspace_list(context: &ToolCallContext) -> Result<Value, ToolError> {
    let aliases = context.workspace_aliases().ok_or_else(|| {
        ToolError::new(
            "workspace-alias-invalid",
            "No workspace alias is bound to this run",
        )
    })?;
    // Only the explicit model-observation DTO is serialized: grant ids,
    // absolute paths, roots, and internal database fields never leave the
    // Backend.
    let safe = aliases
        .iter()
        .map(crate::agent_workspace::WorkspaceAliasView::observation)
        .collect::<Vec<_>>();
    serialize_tool_output(safe)
}

fn execute_workspace_search(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let alias = required_string(input, "grantAlias")?;
    let grant_id = workspace_alias_to_grant_id(context, alias)?;
    let safe = backend
        .workspace()
        .search(
            &grant_id,
            required_string(input, "query")?,
            optional_u64(input, "limit").unwrap_or(10) as usize,
        )
        .map_err(map_workspace_error)?
        .into_iter()
        .map(|hit| hit.observation(alias))
        .collect::<Vec<_>>();
    serialize_tool_output(safe)
}

fn execute_workspace_read(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    context.verify_workspace_source(backend)?;
    let alias = required_string(input, "grantAlias")?;
    let grant_id = workspace_alias_to_grant_id(context, alias)?;
    let relative_path = required_string(input, "relativePath")?;
    let result = backend
        .workspace()
        .read(&grant_id, relative_path)
        .map_err(map_workspace_error)?;
    // A fileRef is issued only for a qualified, complete, untruncated UTF-8
    // text read with a single newline convention and the write size limit.
    // Mixed newlines, NUL bytes, binary, truncated reads, and oversize files
    // never receive a writable reference.
    let file_ref = if !result.truncated
        && result.size_bytes <= MAX_WORKSPACE_WRITE_CONTENT_BYTES as u64
        && crate::agent_workspace::qualified_read_newline(&result.content).is_some()
    {
        let conversation_id = context.conversation_id.clone().ok_or_else(|| {
            ToolError::new(
                "agent-run-scope-required",
                "Workspace reads require the current Agent run",
            )
        })?;
        let binding = backend.workspace().file_binding(
            &grant_id,
            alias,
            relative_path,
            &result,
            context.principal.0,
            &conversation_id,
        );
        Some(context.file_bindings()?.bind(binding))
    } else {
        None
    };
    let safe = result.observation(alias, file_ref);
    serialize_tool_output(safe)
}

fn execute_workspace_create_text(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let request_id = required_string(input, "requestId")?;
    let binding = context.workspace_create_binding(request_id)?;
    let alias = required_string(input, "grantAlias")?;
    let relative_path = required_string(input, "relativePath")?;
    let content = required_string(input, "content")?;
    if alias != binding.workspace_name
        || relative_path != binding.relative_path
        || format!("{:x}", Sha256::digest(content.as_bytes())) != binding.content_digest
    {
        return Err(ToolError::new(
            "workspace-file-ref-invalid",
            "Workspace create binding no longer matches this request",
        ));
    }
    let outcome = backend
        .workspace()
        .commit_create_text(&binding, content)
        .map_err(map_workspace_error)?;
    context
        .file_bindings()?
        .consume_create(request_id)
        .map_err(map_workspace_error)?;
    let safe = outcome.observation(alias, relative_path);
    serialize_tool_output(safe)
}

fn execute_workspace_patch_text(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    let file_ref = required_string(input, "fileRef")?;
    let binding = context.file_binding(file_ref)?;
    let edits = parse_patch_edits(input)?;
    let outcome = backend
        .workspace()
        .commit_patch_text(&binding, &edits)
        .map_err(ToolError::from_workspace_commit_failure)?;
    // One-shot: a committed write consumes the reference so it can never be
    // replayed into a second mutation of the same target.
    context
        .file_bindings()?
        .consume(file_ref)
        .map_err(map_workspace_error)?;
    let safe = outcome.observation(&binding.workspace_name, &binding.relative_path);
    serialize_tool_output(safe)
}

/// Dispatch an already-approved, Backend-bound change set. The model input is
/// checked during preparation; execution consumes the entire binding once so
/// a partial result or an uncertain post-mutation state can never be replayed
/// with the same proposal.
fn execute_workspace_change_set(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
    cancelled: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> Result<Value, ToolError> {
    let request_id = required_string(input, "requestId")?;
    let binding = context.consume_workspace_change_set_binding(request_id)?;
    let never_cancelled = || false;
    let cancelled = cancelled.unwrap_or(&never_cancelled);
    let outcome = backend
        .workspace()
        .commit_change_set(&binding, cancelled)
        .map_err(ToolError::from_workspace_commit_failure)?;
    let partial = !outcome.fully_committed();
    serialize_tool_output(json!({
        "ok": !partial,
        "status": if partial { "partial" } else { "committed" },
        "files": outcome.items.into_iter().map(|item| json!({
            "operation": item.operation,
            "workspace": item.workspace_name,
            "relativePath": item.relative_path,
            "status": match item.disposition {
                crate::agent_workspace::WorkspaceCommitDisposition::Committed => "committed",
                crate::agent_workspace::WorkspaceCommitDisposition::KnownNotWritten => "not-applied",
                crate::agent_workspace::WorkspaceCommitDisposition::UnknownAfterMutation => "uncertain",
            },
        })).collect::<Vec<_>>(),
    }))
}

/// Project exactly one fixed Backend-owned recipe. The visible recipe ref is
/// opaque and run-bound; no root, manifest, executable, argv, or environment
/// enters this observation.
fn execute_execution_list(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    context.verify_workspace_source(backend)?;
    let alias = required_string(input, "grantAlias")?;
    let grant_id = workspace_alias_to_grant_id(context, alias)?;
    let (principal, conversation_id) = context.workspace_run_authority()?;
    let bindings = context.execution_bindings()?;
    let recipe = backend
        .execution()
        .list_manifest_check(
            &backend.workspace(),
            &grant_id,
            alias,
            principal,
            &conversation_id,
            bindings.as_ref(),
        )
        .map_err(map_execution_error)?;
    serialize_tool_output(vec![recipe])
}

/// Run the previously listed fixed check after the existing approval/permit
/// layer has consumed this request. The handler itself has no shell surface:
/// it resolves and consumes one opaque ref, rechecks its private locator, and
/// launches only LuckyRay's app-owned helper with static argv.
fn execute_execution_run(
    context: &ToolCallContext,
    backend: &BackendServices,
    input: &Value,
    cancelled: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> Result<Value, ToolError> {
    let recipe_ref = required_string(input, "recipeRef")?;
    let binding = context.consume_execution_binding(recipe_ref)?;
    let never_cancelled = || false;
    let cancelled = cancelled.unwrap_or(&never_cancelled);
    let result = backend
        .execution()
        .run_manifest_check(&backend.workspace(), &binding, cancelled);
    serialize_tool_output(result.public_view())
}

fn parse_patch_edits(input: &Value) -> Result<Vec<crate::agent_workspace::PatchEdit>, ToolError> {
    parse_patch_edits_public(input)
}

/// Shared with the agent engine so approval previews and durable receipts can
/// build the Backend-computed diff without duplicating the edit contract.
pub(crate) fn parse_patch_edits_public(
    input: &Value,
) -> Result<Vec<crate::agent_workspace::PatchEdit>, ToolError> {
    let edits = input
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::new("tool-input-invalid", "edits are required"))?;
    edits
        .iter()
        .map(|edit| {
            let start_utf16 = edit
                .get("startUtf16")
                .and_then(Value::as_u64)
                .ok_or_else(|| ToolError::new("tool-input-invalid", "startUtf16 is required"))?;
            let end_utf16 = edit
                .get("endUtf16")
                .and_then(Value::as_u64)
                .ok_or_else(|| ToolError::new("tool-input-invalid", "endUtf16 is required"))?;
            let replacement = edit
                .get("replacement")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::new("tool-input-invalid", "replacement is required"))?;
            Ok(crate::agent_workspace::PatchEdit {
                start_utf16: start_utf16 as usize,
                end_utf16: end_utf16 as usize,
                replacement: replacement.to_owned(),
            })
        })
        .collect()
}

fn execute_schedule_create(
    backend: &BackendServices,
    context: &ToolCallContext,
    input: &Value,
) -> Result<Value, ToolError> {
    let conversation_id = context.conversation_id.clone().ok_or_else(|| {
        ToolError::new(
            "agent-run-scope-required",
            "Schedule creation requires the current Agent run",
        )
    })?;
    let kind = parse_schedule_kind(required_string(input, "kind")?)?;
    let (run_at, interval_seconds) = crate::agent_schedules::resolve_agent_schedule_timing(
        &kind,
        input.get("runAt").and_then(Value::as_str),
        optional_u64(input, "intervalSeconds"),
        optional_u64(input, "delaySeconds"),
    )
    .map_err(map_schedule_error)?;
    backend
        .schedules()
        .create(crate::agent_schedules::ScheduleCreateInput {
            title: required_string(input, "title")?.to_owned(),
            prompt: required_string(input, "prompt")?.to_owned(),
            conversation_id,
            kind,
            run_at,
            interval_seconds,
        })
        .map(project_schedule_model)
        .map_err(map_schedule_error)
}

fn execute_schedule_edit(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    let kind = parse_schedule_kind(required_string(input, "kind")?)?;
    let (run_at, interval_seconds) = crate::agent_schedules::resolve_agent_schedule_timing(
        &kind,
        input.get("runAt").and_then(Value::as_str),
        optional_u64(input, "intervalSeconds"),
        optional_u64(input, "delaySeconds"),
    )
    .map_err(map_schedule_error)?;
    backend
        .schedules()
        .edit(crate::agent_schedules::ScheduleEditInput {
            id: required_string(input, "id")?.to_owned(),
            expected_revision: required_u64(input, "expectedRevision")?,
            title: required_string(input, "title")?.to_owned(),
            prompt: required_string(input, "prompt")?.to_owned(),
            kind,
            run_at,
            interval_seconds,
        })
        .map(project_schedule_model)
        .map_err(map_schedule_error)
}

fn execute_schedule_state(
    backend: &BackendServices,
    input: &Value,
    action: &str,
) -> Result<Value, ToolError> {
    let id = required_string(input, "id")?;
    let revision = required_u64(input, "expectedRevision")?;
    match action {
        "pause" => backend
            .schedules()
            .pause(id, revision)
            .map(project_schedule_model)
            .map_err(map_schedule_error),
        "resume" => backend
            .schedules()
            .resume(id, revision)
            .map(project_schedule_model)
            .map_err(map_schedule_error),
        "manual-trigger" => {
            let queued = backend
                .schedules()
                .manual_trigger(id, revision)
                .map_err(map_schedule_error)?;
            serialize_tool_output(queued)
        }
        "remove" => {
            backend
                .schedules()
                .remove(id, revision)
                .map_err(map_schedule_error)?;
            Ok(json!({"ok": true, "status": "retired"}))
        }
        _ => Err(ToolError::new(
            "tool-input-invalid",
            "Schedule action is invalid",
        )),
    }
}

fn project_schedule_model(schedule: crate::agent_schedules::AgentSchedule) -> Value {
    json!({
        "id": schedule.id,
        "title": schedule.title,
        "promptPreview": schedule.prompt_preview,
        "kind": schedule.kind,
        "intervalSeconds": schedule.interval_seconds,
        "nextFireAt": schedule.next_fire_at,
        "status": schedule.status,
        "revision": schedule.revision,
        "history": schedule.fires.into_iter().map(|fire| json!({
            "trigger": fire.trigger_kind,
            "status": fire.status,
            "createdAt": fire.created_at,
            "updatedAt": fire.updated_at,
        })).collect::<Vec<_>>(),
    })
}

fn parse_skill_package(
    backend: &BackendServices,
    package: Option<Value>,
) -> Result<crate::agent_skills::SkillPackageInput, ToolError> {
    let mut package = package
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| ToolError::new("tool-input-invalid", "Skill package is required"))?;
    let scope = package
        .remove("scope")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| ToolError::new("tool-input-invalid", "Skill scope is required"))?;
    let scope = match scope.as_str() {
        "global" => crate::agent_skills::SkillScope::global(),
        "vault" => crate::agent_skills::SkillScope {
            kind: crate::agent_skills::SkillScopeKind::Vault,
            vault_id: Some(
                backend
                    .knowledge()
                    .current_vault_id()
                    .map_err(ToolError::from_knowledge)?,
            ),
        },
        _ => {
            return Err(ToolError::new(
                "tool-input-invalid",
                "Skill scope is invalid",
            ))
        }
    };
    package.insert(
        "scope".to_owned(),
        serde_json::to_value(scope)
            .map_err(|_| ToolError::new("tool-input-invalid", "Skill scope is invalid"))?,
    );
    serde_json::from_value(Value::Object(package))
        .map_err(|_| ToolError::new("tool-input-invalid", "Skill package is invalid"))
}

fn parse_schedule_kind(value: &str) -> Result<crate::agent_schedules::ScheduleKind, ToolError> {
    match value {
        "once" => Ok(crate::agent_schedules::ScheduleKind::Once),
        "interval" => Ok(crate::agent_schedules::ScheduleKind::Interval),
        _ => Err(ToolError::new(
            "tool-input-invalid",
            "Schedule kind is invalid",
        )),
    }
}

fn current_memory_scope(backend: &BackendServices) -> crate::agent_memory::MemoryScope {
    backend
        .knowledge()
        .current_vault_id()
        .map(crate::agent_memory::MemoryScope::vault)
        .unwrap_or_else(|_| crate::agent_memory::MemoryScope::global())
}

fn current_vault_memory_scope(
    backend: &BackendServices,
) -> Result<crate::agent_memory::MemoryScope, ToolError> {
    backend
        .knowledge()
        .current_vault_id()
        .map(crate::agent_memory::MemoryScope::vault)
        .map_err(ToolError::from_knowledge)
}

fn serialize_tool_output<T: Serialize>(value: T) -> Result<Value, ToolError> {
    serde_json::to_value(value)
        .map_err(|_| ToolError::new("tool-output-invalid", "Tool output is invalid"))
}

fn map_memory_error(error: crate::agent_memory::MemoryError) -> ToolError {
    ToolError::new(error.code, error.message)
}

fn map_skill_error(error: crate::agent_skills::SkillError) -> ToolError {
    ToolError::new(error.code, error.message)
}

const MAX_WORKSPACE_WRITE_CONTENT_BYTES: usize = 24 * 1024;

fn map_workspace_error(error: crate::agent_workspace::WorkspaceError) -> ToolError {
    ToolError::new(error.code, error.message)
}

fn map_execution_error(error: crate::agent_execution::ExecutionError) -> ToolError {
    ToolError::new(error.code, error.message)
}

fn map_agent_material_error(error: crate::agent_materials::AgentMaterialError) -> ToolError {
    ToolError::new(error.code, error.message)
}

fn map_schedule_error(error: crate::agent_schedules::ScheduleError) -> ToolError {
    ToolError::new(error.code, error.message)
}

fn execute_knowledge_search(
    backend: &BackendServices,
    context: &ToolCallContext,
    input: &Value,
) -> Result<Value, ToolError> {
    let query = required_string(input, "query")?.to_lowercase();
    let limit = optional_u64(input, "limit").unwrap_or(10).clamp(1, 50) as usize;
    #[cfg(test)]
    enter_request_test_gate(&BEFORE_KNOWLEDGE_SEARCH_SNAPSHOT, &query);
    let snapshot = if context.caller == ToolCallerKind::Agent {
        let target = frozen_knowledge_target(context)?;
        backend
            .knowledge()
            .refresh_index_for_target(target)
            .map_err(map_frozen_knowledge_error)?
    } else {
        backend
            .knowledge()
            .refresh_index()
            .map_err(ToolError::from_knowledge)?
    };
    let documents = snapshot
        .documents
        .iter()
        .filter(|document| {
            query.is_empty()
                || document.title.to_lowercase().contains(&query)
                || document.plain_text.to_lowercase().contains(&query)
        })
        .take(limit)
        .map(|document| {
            json!({
                "id": crate::knowledge::KnowledgeService::document_id(&document.document_ref),
                "documentRef": document.document_ref,
                "title": document.title,
                "excerpt": document.excerpt,
                "revision": document.revision,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "vaultId": snapshot.vault_id,
        "generation": snapshot.generation,
        "stale": snapshot.stale,
        "warning": snapshot.refresh_error.map(|warning| json!({"code":warning.code})),
        "documents": documents,
    }))
}

fn execute_knowledge_read(
    backend: &BackendServices,
    context: &ToolCallContext,
    input: &Value,
) -> Result<Value, ToolError> {
    let document_ref = parse_document_ref(input)?;
    let snapshot = if context.caller == ToolCallerKind::Agent {
        backend
            .knowledge()
            .read_document_for_target(frozen_knowledge_target(context)?, &document_ref)
            .map_err(map_frozen_knowledge_error)?
    } else {
        backend
            .knowledge()
            .read_document(&document_ref)
            .map_err(ToolError::from_knowledge)?
    };
    if snapshot.content.as_bytes().len() > MAX_READ_CONTENT_BYTES {
        return Err(ToolError::new(
            "tool-output-too-large",
            "Knowledge document exceeds the readable tool limit",
        ));
    }
    Ok(document_value(&snapshot, true))
}

fn frozen_knowledge_target(
    context: &ToolCallContext,
) -> Result<&crate::knowledge::KnowledgeTargetIdentity, ToolError> {
    context
        .knowledge_scope
        .as_deref()
        .and_then(crate::knowledge::KnowledgeRunScope::target)
        .ok_or_else(|| {
            ToolError::new(
                "agent-project-knowledge-denied",
                "This Agent run has no Knowledge authorization",
            )
        })
}

fn map_frozen_knowledge_error(error: crate::knowledge::KnowledgeError) -> ToolError {
    if error.code == "knowledge-target-not-current" {
        ToolError::new(
            "agent-project-knowledge-denied",
            "Knowledge access is not authorized for this Agent run",
        )
    } else {
        ToolError::from_knowledge(error)
    }
}

fn execute_materials_search(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    let query = required_string(input, "query")?;
    let limit = optional_u64(input, "limit").unwrap_or(10).clamp(1, 50) as usize;
    let catalog = backend.material_catalog();
    let assets = if query.trim().is_empty() {
        catalog
            .list_assets(&MaterialFilter {
                recent_only: true,
                limit: Some(limit as u32),
                ..Default::default()
            })
            .map_err(|_| ToolError::new("material-catalog-error", "Material search failed"))?
            .into_iter()
            .take(limit)
            .map(|asset| (asset, String::new()))
            .collect::<Vec<_>>()
    } else {
        let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
        catalog
            .search_assets(&fts_query, limit)
            .map_err(|_| ToolError::new("material-catalog-error", "Material search failed"))?
            .into_iter()
            .map(|hit| (hit.asset, hit.snippet))
            .collect::<Vec<_>>()
    };
    Ok(json!({
        "assets": assets.into_iter().map(|(asset, excerpt)| json!({
            "id": asset.id,
            "name": asset.name,
            "kind": asset.kind,
            "mimeType": asset.mime_type,
            "folderId": asset.folder_id,
            "sizeBytes": asset.size_bytes,
            "excerpt": excerpt,
        })).collect::<Vec<_>>()
    }))
}

fn execute_knowledge_create(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    let expected_vault_id = required_string(input, "expectedVaultId")?;
    let relative_path = required_string(input, "relativePath")?;
    let (parent_relative_path, derived_title) = split_markdown_path(relative_path)?;
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(&derived_title);
    if title != derived_title {
        return Err(ToolError::new(
            "tool-input-invalid",
            "title must match the relativePath file name",
        ));
    }
    let mutation = backend
        .knowledge()
        .create_document_for_expected_vault_with_receipt(
            expected_vault_id,
            &KnowledgeCreateInput {
                title: title.to_string(),
                parent_relative_path,
                content: required_string(input, "content")?.to_string(),
            },
        )
        .map_err(ToolError::from_knowledge)?;
    let mut result = document_value(&mutation.document, false);
    if let Some(warning) = mutation.index_warning {
        result["indexStale"] = Value::Bool(true);
        result["indexWarning"] = json!({"code":warning.code});
    }
    match backend.knowledge().refresh_index() {
        Ok(index) => {
            result["indexStale"] = Value::Bool(
                result
                    .get("indexStale")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || index.stale,
            );
            if let Some(warning) = index.refresh_error {
                result["indexWarning"] = json!({"code":warning.code});
            }
        }
        Err(error) => {
            result["indexStale"] = Value::Bool(true);
            result["indexWarning"] = json!({
                "code":error.code,
                "message":"Document was created, but the Knowledge index refresh failed"
            });
        }
    }
    Ok(result)
}

fn execute_knowledge_append(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    require_expected_vault(input)?;
    let mutation = backend
        .knowledge()
        .append_document(&KnowledgeWriteInput {
            document_ref: parse_document_ref(input)?,
            content: required_string(input, "content")?.to_string(),
            expected_revision: Some(required_string(input, "expectedRevision")?.to_string()),
        })
        .map_err(ToolError::from_knowledge)?;
    Ok(mutation_value(&mutation))
}

fn execute_knowledge_set_tags(
    backend: &BackendServices,
    input: &Value,
) -> Result<Value, ToolError> {
    require_expected_vault(input)?;
    let tags = input
        .get("tags")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::new("tool-input-invalid", "tags must be an array"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| ToolError::new("tool-input-invalid", "tag must be a string"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mutation = backend
        .knowledge()
        .set_document_tags(&KnowledgeSetTagsInput {
            document_ref: parse_document_ref(input)?,
            expected_revision: required_string(input, "expectedRevision")?.to_string(),
            tags,
        })
        .map_err(ToolError::from_knowledge)?;
    Ok(mutation_value(&mutation))
}

fn execute_capability(backend: &BackendServices, input: &Value) -> Result<Value, ToolError> {
    let expected_vault = required_string(input, "expectedVaultId")?;
    if backend
        .knowledge()
        .current_vault_id()
        .map_err(ToolError::from_knowledge)?
        != expected_vault
    {
        return Err(ToolError::new(
            "knowledge-vault-not-current",
            "Capability no longer targets the current Vault",
        ));
    }
    let canonical = preflight_capability(backend, input)?;
    let outcome =
        crate::capabilities::execute_knowledge_capability(backend, &canonical, input.get("input"))
            .map_err(|error| ToolError::new(error.code, "Capability execution failed"))?;
    if backend
        .knowledge()
        .current_vault_id()
        .map_err(ToolError::from_knowledge)?
        != expected_vault
    {
        return Err(ToolError::new(
            "knowledge-vault-not-current",
            "Capability no longer targets the current Vault",
        ));
    }
    Ok(json!({
        "capabilityId": canonical,
        "summary": outcome.summary,
        "result": outcome.result,
        "indexWarning": outcome.index_warning,
        "indexStale": outcome.index_stale,
    }))
}

fn preflight_capability(backend: &BackendServices, input: &Value) -> Result<String, ToolError> {
    let requested = required_string(input, "capabilityId")?;
    let canonical = crate::canonical_knowledge_capability_id(requested)
        .ok_or_else(|| ToolError::new("capability-not-found", "Capability does not exist"))?;
    validate_capability_payload(canonical, input.get("input").unwrap_or(&Value::Null))?;
    let connection = backend.open_read().map_err(|_| {
        ToolError::new(
            "backend-database-unavailable",
            "Capability state is unavailable",
        )
    })?;
    let enabled = connection
        .query_row(
            "SELECT enabled FROM local_capability WHERE id = ?1",
            rusqlite::params![canonical],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| ToolError::new("capability-unavailable", "Capability is unavailable"))?;
    if enabled == 0 {
        return Err(ToolError::new(
            "capability-disabled",
            "Capability is disabled",
        ));
    }
    Ok(canonical.to_string())
}

fn validate_capability_payload(capability_id: &str, value: &Value) -> Result<(), ToolError> {
    let object = value.as_object().ok_or_else(|| {
        ToolError::new("tool-input-invalid", "Capability input must be an object")
    })?;
    let common = [
        "text",
        "params",
        "source",
        "documentRef",
        "documentId",
        "expectedRevision",
    ];
    let specific: &[&str] = match capability_id {
        "skill.summary" => &["style", "maxChars"],
        "skill.search_intent" => &["query", "limit", "scope"],
        "wf.web_to_note" => &[
            "title",
            "url",
            "content",
            "parentRelativePath",
            "includeSource",
        ],
        "wf.note_to_summary" => &["style", "title", "parentRelativePath"],
        _ => &[],
    };
    if object
        .keys()
        .any(|key| !common.contains(&key.as_str()) && !specific.contains(&key.as_str()))
    {
        return Err(ToolError::new(
            "tool-input-invalid",
            "Capability input contains an unknown field",
        ));
    }
    if let Some(params) = object.get("params") {
        let params = params.as_object().ok_or_else(|| {
            ToolError::new("tool-input-invalid", "Capability params must be an object")
        })?;
        if params
            .keys()
            .any(|key| !common.contains(&key.as_str()) && !specific.contains(&key.as_str()))
        {
            return Err(ToolError::new(
                "tool-input-invalid",
                "Capability params contain an unknown field",
            ));
        }
    }
    Ok(())
}

fn require_expected_vault(input: &Value) -> Result<(), ToolError> {
    let expected = required_string(input, "expectedVaultId")?;
    let document_ref = parse_document_ref(input)?;
    if expected != document_ref.vault_id {
        return Err(ToolError::new(
            "knowledge-vault-not-current",
            "Document ref does not match expectedVaultId",
        ));
    }
    Ok(())
}

fn parse_document_ref(input: &Value) -> Result<KnowledgeDocumentRef, ToolError> {
    match (input.get("id"), input.get("documentRef")) {
        (Some(Value::String(id)), None) => {
            crate::knowledge::KnowledgeService::parse_document_id(id)
                .map_err(ToolError::from_knowledge)
        }
        (None, Some(value)) => serde_json::from_value::<KnowledgeDocumentRef>(value.clone())
            .map_err(|_| ToolError::new("tool-input-invalid", "documentRef is invalid")),
        _ => Err(ToolError::new(
            "tool-input-invalid",
            "Exactly one of id or documentRef is required",
        )),
    }
}

fn document_value(
    snapshot: &crate::knowledge::KnowledgeDocumentSnapshot,
    include_content: bool,
) -> Value {
    let mut value = json!({
        "id": crate::knowledge::KnowledgeService::document_id(&snapshot.summary.document_ref),
        "documentRef": snapshot.summary.document_ref,
        "title": snapshot.summary.title,
        "relativePath": snapshot.summary.relative_path,
        "modifiedAt": snapshot.summary.modified_at,
        "size": snapshot.summary.size,
        "revision": snapshot.revision,
    });
    if include_content {
        value["content"] = Value::String(snapshot.content.clone());
    }
    value
}

fn mutation_value(mutation: &crate::knowledge::KnowledgeMutationResult) -> Value {
    json!({
        "document": document_value(&mutation.document, false),
        "position": mutation.position,
        "indexWarning": mutation.index_warning,
        "indexStale": mutation.index_stale,
        "committed": true,
    })
}

fn committed_output_fallback(
    definition: &ToolDefinition,
    input: &Value,
    original: &ToolRunResult,
) -> Result<ToolRunResult, ToolError> {
    let warning = json!({"code":"tool-output-redacted"});
    let result = match definition.id.as_str() {
        "knowledge.create" => bounded_document_fallback(&original.result, input, warning)?,
        "knowledge.append" | "knowledge.set_tags" => {
            let document = original.result.get("document").unwrap_or(&Value::Null);
            json!({
                "document":bounded_document_fallback(document, input, warning.clone())?,
                "position":original.result.get("position").and_then(Value::as_str).unwrap_or("updated"),
                "indexWarning":warning,
                "indexStale":true,
                "committed":true,
            })
        }
        "capability.run" => json!({
            "capabilityId":crate::canonical_knowledge_capability_id(
                required_string(input, "capabilityId")?
            ).ok_or_else(|| ToolError::new("capability-not-found", "Capability does not exist"))?,
            "summary":"Capability committed; detailed output unavailable",
            "result":{"kind":"committed","outputUnavailable":true},
            "indexWarning":warning,
            "indexStale":true,
        }),
        _ => {
            return Err(ToolError::new(
                "tool-output-invalid",
                "Committed tool output could not be represented safely",
            ))
        }
    };
    Ok(ToolRunResult {
        tool_id: original.tool_id.clone(),
        version: original.version,
        result,
        request_id: original.request_id.clone(),
    })
}

fn bounded_document_fallback(
    original: &Value,
    input: &Value,
    warning: Value,
) -> Result<Value, ToolError> {
    let document_ref = original
        .get("documentRef")
        .and_then(|value| serde_json::from_value::<KnowledgeDocumentRef>(value.clone()).ok())
        .or_else(|| parse_document_ref(input).ok())
        .or_else(|| {
            Some(KnowledgeDocumentRef {
                vault_id: required_string(input, "expectedVaultId").ok()?.to_string(),
                relative_path: required_string(input, "relativePath").ok()?.to_string(),
            })
        })
        .ok_or_else(|| {
            ToolError::new(
                "tool-output-invalid",
                "Committed document identity is unavailable",
            )
        })?;
    let title = original
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_string)
        .or_else(|| {
            document_ref
                .relative_path
                .rsplit('/')
                .next()
                .and_then(|name| name.strip_suffix(".md"))
                .filter(|name| !name.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Committed document".to_string());
    let id = crate::knowledge::KnowledgeService::document_id(&document_ref);
    Ok(json!({
        "id":id,
        "documentRef":document_ref,
        "title":title,
        "relativePath":document_ref.relative_path,
        "size":original.get("size").and_then(Value::as_u64).unwrap_or(0),
        "revision":original.get("revision").and_then(Value::as_str).unwrap_or("committed-revision-unavailable"),
        "indexWarning":warning,
        "indexStale":true,
    }))
}

fn split_markdown_path(value: &str) -> Result<(Option<String>, String), ToolError> {
    if value.is_empty()
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('\\')
        || value.contains('\0')
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || value.contains(':')
        || !value.to_ascii_lowercase().ends_with(".md")
        || value.starts_with(".luckyray/")
    {
        return Err(ToolError::new(
            "tool-input-invalid",
            "relativePath must be a safe Vault-relative Markdown path",
        ));
    }
    let mut parts = value.split('/').collect::<Vec<_>>();
    let file_name = parts.pop().unwrap_or_default().to_string();
    let parent = (!parts.is_empty()).then(|| parts.join("/"));
    Ok((parent, file_name))
}

fn required_string<'a>(input: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("tool-input-invalid", format!("{key} is required")))
}

fn optional_u64(input: &Value, key: &str) -> Option<u64> {
    input.get(key).and_then(Value::as_u64)
}

fn required_u64(input: &Value, key: &str) -> Result<u64, ToolError> {
    optional_u64(input, key)
        .ok_or_else(|| ToolError::new("tool-input-invalid", format!("{key} is required")))
}

fn merge_request_ids(
    outer: Option<String>,
    embedded: Option<String>,
) -> Result<Option<String>, ToolError> {
    match (outer, embedded) {
        (Some(outer), Some(embedded)) if outer != embedded => Err(ToolError::new(
            "request-id-conflict",
            "Envelope and input requestId values differ",
        )),
        (Some(value), _) | (_, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

fn validate_request_id(value: &str) -> Result<(), ToolError> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ToolError::new(
            "tool-input-invalid",
            "requestId format is invalid",
        ));
    }
    Ok(())
}

fn validate_context(context: &ToolCallContext) -> Result<(), ToolError> {
    let valid = matches!(
        (context.caller, context.trust),
        (
            ToolCallerKind::LocalTransport,
            ToolTrustMode::TrustedLocalTransport
        )
    ) || matches!(
        (context.caller, context.trust),
        (ToolCallerKind::Agent, ToolTrustMode::TrustedAgent)
    );
    #[cfg(test)]
    let valid = valid
        || matches!(
            (context.caller, context.trust),
            (ToolCallerKind::Tauri, ToolTrustMode::TrustedUi)
                | (ToolCallerKind::TestCli, ToolTrustMode::TrustedNative)
                | (ToolCallerKind::TestMcp, ToolTrustMode::TrustedNative)
        );
    if valid {
        Ok(())
    } else {
        Err(ToolError::new(
            "tool-caller-invalid",
            "Tool caller context is invalid",
        ))
    }
}

fn canonical_json_digest(value: &Value) -> Result<[u8; 32], ToolError> {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let mut keys = object.keys().collect::<Vec<_>>();
                keys.sort();
                let mut result = Map::new();
                for key in keys {
                    result.insert(key.clone(), canonical(&object[key]));
                }
                Value::Object(result)
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    let canonical = canonical(value);
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|_| ToolError::new("tool-input-invalid", "Tool input is invalid"))?;
    Ok(Sha256::digest(&bytes).into())
}

#[cfg(test)]
fn hex_digest(value: &[u8; 32]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn prune_request_state(state: &mut RequestState) {
    let expired = state
        .entries
        .iter()
        .filter_map(|(key, slot)| {
            let _inflight_started_at = slot.inflight_started_at;
            slot.settled_at
                .is_some_and(|settled_at| settled_at.elapsed() >= REQUEST_CACHE_TTL)
                .then(|| key.clone())
        })
        .collect::<Vec<_>>();
    for key in expired {
        if let Some(slot) = state.entries.remove(&key) {
            state.retained_bytes = state.retained_bytes.saturating_sub(slot.retained_bytes);
        }
    }
}

fn remove_request_slot(
    state: &mut RequestState,
    key: &RequestKey,
    expected_result: &Arc<(Mutex<Option<Result<ToolRunResult, ToolError>>>, Condvar)>,
) {
    if state
        .entries
        .get(key)
        .is_some_and(|entry| Arc::ptr_eq(&entry.result, expected_result))
    {
        if let Some(slot) = state.entries.remove(key) {
            state.retained_bytes = state.retained_bytes.saturating_sub(slot.retained_bytes);
        }
    }
}

fn unavailable_tool_error(definition: &ToolDefinition) -> ToolError {
    if definition.availability.code.as_deref() == Some("knowledge-vault-required") {
        ToolError::new(
            "knowledge-vault-required",
            "Open or create a Vault before using this tool",
        )
    } else if definition.availability.code.as_deref() == Some("web-network-disabled") {
        ToolError::new("web-network-disabled", "Enable Agent web access first")
    } else if definition.availability.code.as_deref() == Some("web-search-unavailable") {
        ToolError::new(
            "web-search-unavailable",
            "Configure a SearXNG endpoint first",
        )
    } else {
        ToolError::new(
            "tool-unavailable",
            definition
                .availability
                .reason
                .clone()
                .unwrap_or_else(|| "Tool is unavailable".to_string()),
        )
    }
}

fn require_live_vault(backend: &BackendServices, expected_vault_id: &str) -> Result<(), ToolError> {
    let current = backend
        .knowledge()
        .current_vault_id()
        .map_err(ToolError::from_knowledge)?;
    if current == expected_vault_id {
        Ok(())
    } else {
        Err(ToolError::new(
            "knowledge-vault-not-current",
            "Knowledge operation no longer targets the current Vault",
        ))
    }
}

fn expected_handoff_vault(
    definition: &ToolDefinition,
    input: &Value,
    result: &ToolRunResult,
) -> Result<Option<String>, ToolError> {
    match definition.id.as_str() {
        "materials.search"
        | "materials.inspect"
        | "materials.preview"
        | "materials.references"
        | "materials.taxonomy"
        | "materials.set_tags"
        | "materials.categorize"
        | "materials.import_from_grant"
        | "memory.list"
        | "memory.search"
        | "memory.add"
        | "memory.update"
        | "memory.delete"
        | "skills.list"
        | "skills.view"
        | "skills.create"
        | "skills.patch"
        | "workspace.search"
        | "workspace.read"
        | "schedule.list"
        | "schedule.create"
        | "schedule.edit"
        | "schedule.pause"
        | "schedule.resume"
        | "schedule.manual_trigger"
        | "schedule.remove"
        | "web.fetch"
        | "web.search"
        | "canvas.inspect" => Ok(None),
        "canvas.mutate" | "canvas.generate" => Ok(None),
        "knowledge.search" => result
            .result
            .get("vaultId")
            .and_then(Value::as_str)
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| ToolError::new("tool-output-invalid", "Tool Vault identity is missing")),
        "knowledge.read" => Ok(Some(parse_document_ref(input)?.vault_id)),
        "knowledge.create" | "knowledge.append" | "knowledge.set_tags" | "capability.run" => {
            Ok(Some(required_string(input, "expectedVaultId")?.to_string()))
        }
        _ => Err(ToolError::new("tool-not-found", "Tool does not exist")),
    }
}

fn validate_result_vault_identity(value: &Value, expected_vault_id: &str) -> Result<(), ToolError> {
    match value {
        Value::Array(values) => {
            for value in values {
                validate_result_vault_identity(value, expected_vault_id)?;
            }
        }
        Value::Object(values) => {
            if let Some(vault_id) = values.get("vaultId") {
                if vault_id.as_str() != Some(expected_vault_id) {
                    return Err(ToolError::new(
                        "tool-output-invalid",
                        "Tool result Vault identity does not match the authorized Vault",
                    ));
                }
            }
            if let Some(document_ref) = values.get("documentRef") {
                let document_ref = serde_json::from_value::<KnowledgeDocumentRef>(
                    document_ref.clone(),
                )
                .map_err(|_| {
                    ToolError::new("tool-output-invalid", "Tool document identity is invalid")
                })?;
                if document_ref.vault_id != expected_vault_id {
                    return Err(ToolError::new(
                        "tool-output-invalid",
                        "Tool document identity does not match the authorized Vault",
                    ));
                }
            }
            if let Some(id) = values.get("id").and_then(Value::as_str) {
                if id.starts_with("kdoc-") {
                    let document_ref = crate::knowledge::KnowledgeService::parse_document_id(id)
                        .map_err(|_| {
                            ToolError::new(
                                "tool-output-invalid",
                                "Tool document identity is invalid",
                            )
                        })?;
                    if document_ref.vault_id != expected_vault_id {
                        return Err(ToolError::new(
                            "tool-output-invalid",
                            "Tool document identity does not match the authorized Vault",
                        ));
                    }
                }
            }
            for value in values.values() {
                validate_result_vault_identity(value, expected_vault_id)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_json_limits(value: &Value) -> Result<(), ToolError> {
    fn walk(value: &Value, depth: usize, nodes: &mut usize) -> bool {
        *nodes += 1;
        if depth > MAX_JSON_DEPTH || *nodes > MAX_JSON_NODES {
            return false;
        }
        match value {
            Value::Array(values) => values.iter().all(|value| walk(value, depth + 1, nodes)),
            Value::Object(values) => values.values().all(|value| walk(value, depth + 1, nodes)),
            _ => true,
        }
    }
    let mut nodes = 0;
    if walk(value, 0, &mut nodes) {
        Ok(())
    } else {
        Err(ToolError::new(
            "tool-input-invalid",
            "Tool input exceeds structural limits",
        ))
    }
}

fn validate_schema(schema: &Value, value: &Value, label: &str) -> Result<(), ToolError> {
    let invalid = || {
        ToolError::new(
            if label == "output" {
                "tool-output-invalid"
            } else {
                "tool-input-invalid"
            },
            format!("Tool {label} does not match schema"),
        )
    };
    if let Some(expected) = schema.get("const") {
        if value != expected {
            return Err(invalid());
        }
    }
    if let Some(branches) = schema.get("oneOf") {
        let branches = branches.as_array().ok_or_else(invalid)?;
        let matches = branches
            .iter()
            .filter(|branch| validate_schema(branch, value, label).is_ok())
            .count();
        return if matches == 1 { Ok(()) } else { Err(invalid()) };
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.contains(value) {
            return Err(invalid());
        }
    }
    match schema.get("type").and_then(Value::as_str).unwrap_or("any") {
        "object" => {
            let object = value.as_object().ok_or_else(invalid)?;
            if let Some(max) = schema.get("maxProperties").and_then(Value::as_u64) {
                if object.len() > max as usize {
                    return Err(invalid());
                }
            }
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if schema.get("additionalProperties") == Some(&Value::Bool(false))
                && object.keys().any(|key| !properties.contains_key(key))
            {
                return Err(invalid());
            }
            for required in schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !object.contains_key(required) {
                    return Err(invalid());
                }
            }
            for (key, child) in object {
                if let Some(child_schema) = properties.get(key) {
                    validate_schema(child_schema, child, label)?;
                }
            }
        }
        "array" => {
            let array = value.as_array().ok_or_else(invalid)?;
            if schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .is_some_and(|max| array.len() > max as usize)
            {
                return Err(invalid());
            }
            if let Some(item_schema) = schema.get("items") {
                for item in array {
                    validate_schema(item_schema, item, label)?;
                }
            }
        }
        "string" => {
            let string = value.as_str().ok_or_else(invalid)?;
            let length = string.chars().count();
            if schema
                .get("minLength")
                .and_then(Value::as_u64)
                .is_some_and(|min| length < min as usize)
                || schema
                    .get("maxLength")
                    .and_then(Value::as_u64)
                    .is_some_and(|max| length > max as usize)
            {
                return Err(invalid());
            }
        }
        "integer" => {
            let integer = value.as_i64().ok_or_else(invalid)?;
            if schema
                .get("minimum")
                .and_then(Value::as_i64)
                .is_some_and(|min| integer < min)
                || schema
                    .get("maximum")
                    .and_then(Value::as_i64)
                    .is_some_and(|max| integer > max)
            {
                return Err(invalid());
            }
        }
        "number" => {
            let number = value.as_f64().ok_or_else(invalid)?;
            if schema
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|min| number < min)
                || schema
                    .get("maximum")
                    .and_then(Value::as_f64)
                    .is_some_and(|max| number > max)
            {
                return Err(invalid());
            }
        }
        "boolean" => {
            if !value.is_boolean() {
                return Err(invalid());
            }
        }
        "null" => {
            if !value.is_null() {
                return Err(invalid());
            }
        }
        "any" => {}
        _ => {
            return Err(ToolError::new(
                "tool-schema-invalid",
                "Tool schema type is invalid",
            ))
        }
    }
    Ok(())
}

fn validate_definitions(definitions: &[ToolDefinition]) -> Result<(), ToolError> {
    let mut ids = std::collections::HashSet::new();
    for definition in definitions {
        if definition.version == 0
            || definition.max_input_bytes == 0
            || definition.max_output_bytes == 0
            || definition.max_input_bytes > 1024 * 1024
            || definition.max_output_bytes > MAX_TOOL_OUTPUT_BYTES
            || definition.title.chars().count() > 128
            || definition.description.chars().count() > 1024
            || serde_json::to_vec(&definition.input_schema)
                .ok()
                .is_none_or(|value| value.len() > 64 * 1024)
            || serde_json::to_vec(&definition.output_schema)
                .ok()
                .is_none_or(|value| value.len() > 64 * 1024)
            || !definition.id.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'-' | b'_')
            })
            || !definition.id.contains('.')
            || !ids.insert(definition.id.clone())
        {
            return Err(ToolError::new(
                "tool-registry-invalid",
                "Tool registry contains an invalid definition",
            ));
        }
        validate_schema_shape(&definition.input_schema)?;
        validate_schema_shape(&definition.output_schema)?;
    }
    Ok(())
}

fn validate_schema_shape(schema: &Value) -> Result<(), ToolError> {
    let object = schema
        .as_object()
        .ok_or_else(|| ToolError::new("tool-schema-invalid", "Tool schema must be an object"))?;
    if let Some(branches) = object.get("oneOf") {
        let branches = branches
            .as_array()
            .ok_or_else(|| ToolError::new("tool-schema-invalid", "Tool schema oneOf is invalid"))?;
        if branches.is_empty() || branches.len() > 32 {
            return Err(ToolError::new(
                "tool-schema-invalid",
                "Tool schema oneOf is invalid",
            ));
        }
        for branch in branches {
            validate_schema_shape(branch)?;
        }
        return Ok(());
    }
    if object.contains_key("const") && !object.contains_key("type") {
        return Ok(());
    }
    let schema_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("tool-schema-invalid", "Tool schema type is required"))?;
    if !matches!(
        schema_type,
        "object" | "array" | "string" | "integer" | "number" | "boolean" | "null" | "any"
    ) {
        return Err(ToolError::new(
            "tool-schema-invalid",
            "Tool schema type is unsupported",
        ));
    }
    if schema_type == "object" {
        if object
            .get("additionalProperties")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(ToolError::new(
                "tool-schema-invalid",
                "Tool object schema additionalProperties must be boolean",
            ));
        }
        if let Some(properties) = object.get("properties") {
            for property in properties
                .as_object()
                .ok_or_else(|| {
                    ToolError::new("tool-schema-invalid", "Tool schema properties are invalid")
                })?
                .values()
            {
                validate_schema_shape(property)?;
            }
        }
    }
    if schema_type == "array" {
        if let Some(items) = object.get("items") {
            validate_schema_shape(items)?;
        }
    }
    Ok(())
}

fn definition(
    id: &str,
    title: &str,
    description: &str,
    risk: ToolRisk,
    input_schema: Value,
    output_schema: Value,
    availability: ToolAvailability,
    idempotency: &str,
    max_input_bytes: usize,
    max_output_bytes: usize,
) -> ToolDefinition {
    ToolDefinition {
        id: id.to_string(),
        version: 1,
        title: title.to_string(),
        description: description.to_string(),
        risk,
        input_schema,
        output_schema,
        availability,
        idempotency: idempotency.to_string(),
        max_input_bytes,
        max_output_bytes,
    }
}

fn available() -> ToolAvailability {
    ToolAvailability {
        available: true,
        code: None,
        reason: None,
    }
}

fn unavailable(code: &str, reason: &str) -> ToolAvailability {
    ToolAvailability {
        available: false,
        code: Some(code.to_string()),
        reason: Some(reason.to_string()),
    }
}

fn object_schema(properties: Vec<(&str, Value)>, required: &[&str]) -> Value {
    let properties = properties
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect::<Map<_, _>>();
    json!({
        "type":"object",
        "additionalProperties":false,
        "properties":properties,
        "required":required,
    })
}

fn string_schema(min: usize, max: usize) -> Value {
    json!({"type":"string","minLength":min,"maxLength":max})
}

fn integer_schema(min: i64, max: i64) -> Value {
    json!({"type":"integer","minimum":min,"maximum":max})
}

fn enum_schema(values: &[&str]) -> Value {
    json!({"type":"string","enum":values})
}

fn document_ref_schema() -> Value {
    object_schema(
        vec![
            ("vaultId", string_schema(1, 128)),
            ("relativePath", string_schema(1, 512)),
        ],
        &["vaultId", "relativePath"],
    )
}

fn document_identity_schema(include_write_fields: bool) -> Value {
    // id and documentRef identify the same authority through different
    // representations. Accept exactly one, never an ambiguous combination
    // and never an empty identity. This JSON Schema is passed unchanged into
    // the child capability manifest, so provider tool calls are constrained
    // before they reach the parent parser.
    let mut id_properties = vec![("id", string_schema(1, 2048))];
    let mut document_ref_properties = vec![("documentRef", document_ref_schema())];
    let mut id_required = vec!["id"];
    let mut document_ref_required = vec!["documentRef"];
    if include_write_fields {
        for (name, schema) in [
            ("expectedVaultId", string_schema(1, 128)),
            ("expectedRevision", string_schema(1, 128)),
            ("requestId", string_schema(1, 96)),
        ] {
            id_properties.push((name, schema.clone()));
            document_ref_properties.push((name, schema));
        }
        id_required.extend(["expectedVaultId", "expectedRevision", "requestId"]);
        document_ref_required.extend(["expectedVaultId", "expectedRevision", "requestId"]);
    }
    json!({
        "oneOf": [
            object_schema(id_properties, &id_required),
            object_schema(document_ref_properties, &document_ref_required),
        ]
    })
}

fn document_mutation_schema(field: &str, field_schema: Value) -> Value {
    let mut identity = document_identity_schema(true);
    let branches = identity
        .get_mut("oneOf")
        .and_then(Value::as_array_mut)
        .expect("document identity schema has exact-one branches");
    for branch in branches {
        let properties = branch
            .get_mut("properties")
            .and_then(Value::as_object_mut)
            .expect("document identity branch has properties");
        properties.insert(field.to_owned(), field_schema.clone());
        let required = branch
            .get_mut("required")
            .and_then(Value::as_array_mut)
            .expect("document identity branch has required fields");
        required.push(Value::String(field.to_owned()));
    }
    identity
}

fn generic_output_schema() -> Value {
    json!({"type":"object","additionalProperties":true,"maxProperties":32})
}

fn document_output_schema() -> Value {
    object_schema(
        vec![
            ("id", string_schema(1, 2048)),
            ("documentRef", document_ref_schema()),
            ("title", string_schema(1, 256)),
            ("relativePath", string_schema(1, 512)),
            ("modifiedAt", json!({"type":"any"})),
            ("size", integer_schema(0, i64::MAX)),
            ("revision", string_schema(1, 128)),
            ("content", string_schema(0, MAX_READ_CONTENT_BYTES)),
            ("indexWarning", json!({"type":"any"})),
            ("indexStale", json!({"type":"boolean"})),
        ],
        &[
            "id",
            "documentRef",
            "title",
            "relativePath",
            "size",
            "revision",
        ],
    )
}

fn mutation_output_schema() -> Value {
    object_schema(
        vec![
            ("document", document_output_schema()),
            ("position", string_schema(1, 32)),
            ("indexWarning", json!({"type":"any"})),
            ("indexStale", json!({"type":"boolean"})),
            ("committed", json!({"type":"boolean"})),
        ],
        &["document", "position", "indexStale", "committed"],
    )
}

fn knowledge_search_output_schema() -> Value {
    object_schema(
        vec![
            ("vaultId", string_schema(1, 128)),
            ("generation", integer_schema(0, i64::MAX)),
            ("stale", json!({"type":"boolean"})),
            ("warning", json!({"type":"any"})),
            (
                "documents",
                json!({"type":"array","maxItems":50,"items":generic_output_schema()}),
            ),
        ],
        &["vaultId", "generation", "stale", "warning", "documents"],
    )
}

fn materials_search_output_schema() -> Value {
    object_schema(
        vec![(
            "assets",
            json!({"type":"array","maxItems":50,"items":generic_output_schema()}),
        )],
        &["assets"],
    )
}

fn web_search_output_schema() -> Value {
    object_schema(
        vec![
            ("adapter", enum_schema(&["tavily", "searxng"])),
            (
                "results",
                json!({"type":"array","maxItems":10,"items":generic_output_schema()}),
            ),
        ],
        &["adapter", "results"],
    )
}

fn web_fetch_output_schema() -> Value {
    object_schema(
        vec![
            ("id", string_schema(69, 69)),
            ("fetchRef", string_schema(69, 69)),
            ("sourceToken", string_schema(70, 70)),
            ("displayUrl", string_schema(1, 4096)),
            ("host", string_schema(1, 253)),
            ("title", string_schema(0, 512)),
            ("text", string_schema(0, 48 * 1024)),
            ("contentType", string_schema(1, 96)),
            ("truncated", json!({"type":"boolean"})),
        ],
        &[
            "id",
            "fetchRef",
            "sourceToken",
            "displayUrl",
            "host",
            "title",
            "text",
            "contentType",
            "truncated",
        ],
    )
}

fn capability_output_schema() -> Value {
    object_schema(
        vec![
            ("capabilityId", string_schema(1, 80)),
            ("summary", string_schema(0, MAX_READ_CONTENT_BYTES)),
            (
                "result",
                json!({"type":"object","additionalProperties":true,"maxProperties":32}),
            ),
            ("indexWarning", json!({"type":"any"})),
            ("indexStale", json!({"type":"boolean"})),
        ],
        &[
            "capabilityId",
            "summary",
            "result",
            "indexWarning",
            "indexStale",
        ],
    )
}

fn capability_payload_schema() -> Value {
    let scalar_properties = vec![
        ("text", string_schema(0, MAX_WRITE_CONTENT_BYTES)),
        ("source", string_schema(0, 128)),
        ("documentRef", document_ref_schema()),
        ("documentId", string_schema(1, 2048)),
        ("expectedRevision", string_schema(1, 128)),
        ("style", enum_schema(&["short", "bullets", "actions"])),
        ("maxChars", integer_schema(20, 2000)),
        ("query", string_schema(0, 1024)),
        ("limit", integer_schema(1, 50)),
        ("scope", enum_schema(&["all", "notes", "assets"])),
        ("title", string_schema(1, 256)),
        ("url", string_schema(1, 8192)),
        ("content", string_schema(0, MAX_WRITE_CONTENT_BYTES)),
        ("parentRelativePath", string_schema(1, 512)),
        ("includeSource", json!({"type":"boolean"})),
    ];
    let params = object_schema(scalar_properties.clone(), &[]);
    let mut properties = scalar_properties;
    properties.push(("params", params));
    object_schema(properties, &[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::KnowledgeVaultRegistration;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};

    static SEQUENCE: AtomicUsize = AtomicUsize::new(1);

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "luckyray-tools-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn backend_with_vault(label: &str) -> (BackendServices, KnowledgeVaultRegistration) {
        let app_data = temp_dir(&format!("{label}-app"));
        let root = temp_dir(&format!("{label}-vault"));
        fs::create_dir_all(root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: format!("vault-{label}"),
            name: label.to_string(),
            root_path: root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        backend.knowledge().register_current_vault(&vault).unwrap();
        (backend, vault)
    }

    fn runtime_with_vault(
        label: &str,
    ) -> (ToolRuntime, BackendServices, KnowledgeVaultRegistration) {
        let app_data = temp_dir(&format!("{label}-runtime-app"));
        let root = temp_dir(&format!("{label}-runtime-vault"));
        fs::create_dir_all(root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: format!("vault-{label}"),
            name: label.to_string(),
            root_path: root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let controller = BackendServices::initialize(&app_data).unwrap();
        controller
            .knowledge()
            .register_current_vault(&vault)
            .unwrap();
        let runtime = ToolRuntime::initialize(&app_data).unwrap();
        (runtime, controller, vault)
    }

    #[test]
    fn agent_catalog_is_exact14_and_write_tools_remain_unexecutable_without_a_permit() {
        let app_data = temp_dir("agent-web-catalog");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let definitions = backend
            .list_tools(&ToolCallContext::agent_canvas_scoped(
                [7u8; 32], [8u8; 32], [9u8; 32], [10u8; 32],
            ))
            .unwrap();
        assert_eq!(
            definitions
                .iter()
                .map(|definition| definition.id().to_owned())
                .collect::<Vec<_>>(),
            vec![
                "browser.extract",
                "browser.open",
                "browser.read",
                "canvas.generate",
                "canvas.inspect",
                "canvas.mutate",
                "knowledge.append",
                "knowledge.create",
                "knowledge.read",
                "knowledge.search",
                "knowledge.set_tags",
                "materials.search",
                "web.fetch",
                "web.search",
            ]
        );

        for tool_id in [
            "web.search",
            "web.fetch",
            "browser.open",
            "browser.read",
            "browser.extract",
            "canvas.inspect",
        ] {
            let definition = definitions
                .iter()
                .find(|definition| definition.id() == tool_id)
                .unwrap_or_else(|| panic!("missing production tool {tool_id}"));
            assert_eq!(definition.risk(), ToolRisk::Read);
        }
        for tool_id in AGENT_CANVAS_WRITE_TOOL_IDS {
            let definition = definitions
                .iter()
                .find(|definition| definition.id() == tool_id)
                .unwrap_or_else(|| panic!("missing production tool {tool_id}"));
            assert_eq!(definition.risk(), ToolRisk::Write);
        }
        for tool_id in AGENT_WRITE_TOOL_IDS {
            let definition = definitions
                .iter()
                .find(|definition| definition.id() == tool_id)
                .unwrap_or_else(|| panic!("missing production tool {tool_id}"));
            assert_eq!(definition.risk(), ToolRisk::Write);
        }
        let denied = backend
            .run_tool(
                &ToolCallContext::agent_read([7u8; 32]),
                ToolRunRequest::agent_write(
                    "knowledge.create".to_owned(),
                    json!({
                        "expectedVaultId":"forged",
                        "relativePath":"Denied.md",
                        "content":"must-not-write",
                        "requestId":"forged-request"
                    }),
                ),
            )
            .unwrap_err();
        assert_eq!(denied.code, "tool-risk-denied");
        let local = backend
            .list_tools(&ToolCallContext::local_transport_verified([3u8; 32]))
            .unwrap();
        assert!(local
            .iter()
            .all(|definition| !definition.id().starts_with("web.")
                && !definition.id().starts_with("browser.")));
    }

    #[test]
    fn authenticated_capability_snapshot_is_the_single_dynamic_agent_gate() {
        let (backend, _) = backend_with_vault("dynamic-agent-capabilities");
        let context = ToolCallContext::agent_read_scoped([31u8; 32], [32u8; 32], [33u8; 32]);
        let definitions = backend.list_tools(&context).unwrap();
        let registry = backend.agent_capabilities();
        let bootstrap = registry
            .bootstrap_manifest(backend.agent_tool_catalog())
            .unwrap();
        let snapshot = registry
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::Standard,
                "请记住这个偏好",
                definitions,
            )
            .unwrap();

        assert!(!bootstrap.environment_probe);
        assert!(snapshot.allows("memory.search"));
        assert!(snapshot.allows("memory.add"));
        assert!(snapshot.allows("skills.list"));
        assert!(!snapshot.allows("capability.run"));
        assert!(!snapshot
            .tools
            .iter()
            .any(|tool| tool.id.starts_with("canvas.")));
        let material_set_tags = snapshot
            .tools
            .iter()
            .find(|tool| tool.id == "materials.set_tags")
            .expect("standard snapshot exposes the approved material mutation");
        let material_properties = material_set_tags
            .input_schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("material schema has properties");
        let material_required = material_set_tags
            .input_schema
            .get("required")
            .and_then(Value::as_array)
            .expect("material schema has required fields");
        // requestId and expectedRevision are server-owned: a model must never
        // be prompted to manufacture either value. The parent injects the
        // one-shot request id and overwrites revision with the server-bound
        // selected asset immediately before ToolRegistry validation.
        assert!(!material_properties.contains_key("requestId"));
        assert!(!material_properties.contains_key("expectedRevision"));
        assert!(!material_required.iter().any(|value| value == "requestId"));
        assert!(!material_required
            .iter()
            .any(|value| value == "expectedRevision"));
        assert!(
            material_set_tags.description.contains("existing tag IDs"),
            "the model contract must not imply that materials.set_tags can create a tag"
        );
        let knowledge_read = snapshot
            .tools
            .iter()
            .find(|tool| tool.id == "knowledge.read")
            .expect("standard snapshot exposes knowledge.read");
        let identity_branches = knowledge_read
            .input_schema
            .get("oneOf")
            .and_then(Value::as_array)
            .expect("knowledge.read declares one exact identity form");
        assert_eq!(identity_branches.len(), 2);
        for tool in &snapshot.tools {
            assert_eq!(
                bootstrap
                    .tools
                    .iter()
                    .find(|candidate| candidate.id == tool.id),
                Some(tool),
                "{} drifted between ToolRegistry bootstrap and run snapshot",
                tool.id
            );
            assert!(snapshot.prompt.contains(&format!("- {} [", tool.id)));
        }
        for forbidden in ["terminal.exec", "file.read", "skill_view", "mcp."] {
            assert!(!snapshot.prompt.contains(forbidden));
        }

        let live_context = context.clone().with_agent_run(
            "conversation-dynamic-capabilities".to_owned(),
            Arc::new(snapshot.clone()),
        );
        let listed = backend
            .run_tool(
                &live_context,
                ToolRunRequest::read("skills.list".to_owned(), json!({})),
            )
            .unwrap();
        assert!(listed.result().is_array());

        let mut forged = snapshot.clone();
        forged.prompt.push_str("\nforged capability");
        let forged_error = backend
            .run_tool(
                &context.clone().with_agent_run(
                    "conversation-forged-capabilities".to_owned(),
                    Arc::new(forged),
                ),
                ToolRunRequest::read("skills.list".to_owned(), json!({})),
            )
            .unwrap_err();
        assert_eq!(forged_error.code, "agent-capability-snapshot-invalid");

        registry.set_enabled("skills", false).unwrap();
        let stale_error = backend
            .run_tool(
                &live_context,
                ToolRunRequest::read("skills.list".to_owned(), json!({})),
            )
            .unwrap_err();
        assert_eq!(stale_error.code, "agent-capability-stale");

        let refreshed = registry
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::Standard,
                "继续",
                backend.list_tools(&context).unwrap(),
            )
            .unwrap();
        assert!(!refreshed.allows("skills.list"));
        let disabled_error = backend
            .run_tool(
                &context.with_agent_run(
                    "conversation-disabled-capabilities".to_owned(),
                    Arc::new(refreshed),
                ),
                ToolRunRequest::read("skills.list".to_owned(), json!({})),
            )
            .unwrap_err();
        assert_eq!(disabled_error.code, "agent-capability-denied");
    }

    #[test]
    fn standard_memory_snapshot_discovers_bounded_list_and_approved_mutations() {
        let (backend, _) = backend_with_vault("memory-standard-discovery");
        let context = ToolCallContext::agent_read_scoped([41u8; 32], [42u8; 32], [43u8; 32]);
        let registry = backend.agent_capabilities();
        let snapshot = registry
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::Standard,
                "请核实我保存的记忆，只给简短结论",
                backend.list_tools(&context).unwrap(),
            )
            .unwrap();

        for tool_id in [
            "memory.list",
            "memory.search",
            "memory.add",
            "memory.update",
            "memory.delete",
        ] {
            assert!(
                snapshot.allows(tool_id),
                "an enabled standard Memory pack must discover {tool_id}"
            );
            assert!(snapshot.prompt.contains(&format!("- {tool_id} [")));
        }

        registry.set_enabled("memory", false).unwrap();
        let disabled = registry
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::Standard,
                "请核实我保存的记忆",
                backend.list_tools(&context).unwrap(),
            )
            .unwrap();
        assert!(
            disabled
                .tools
                .iter()
                .all(|tool| !tool.id.starts_with("memory.")),
            "disabled Memory must disappear from discovery and prompt"
        );
        assert!(!disabled.prompt.contains("memory."));
        let disabled_context = context
            .with_agent_run(
                "conversation-memory-disabled".to_owned(),
                Arc::new(disabled),
            )
            .with_memory_bindings(Arc::new(crate::agent_memory::MemoryRunBindings::default()));
        let dispatch = backend
            .run_tool(
                &disabled_context,
                ToolRunRequest::read("memory.list".to_owned(), json!({})),
            )
            .unwrap_err();
        assert_eq!(dispatch.code, "agent-capability-denied");
    }

    #[test]
    fn schedule_create_snapshot_supports_backend_timed_relative_delay() {
        let (backend, _) = backend_with_vault("schedule-relative-delay-schema");
        let context = ToolCallContext::agent_read_scoped([101u8; 32], [102u8; 32], [103u8; 32]);
        let snapshot = backend
            .agent_capabilities()
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::Standard,
                "一分钟后执行一次",
                backend.list_tools(&context).unwrap(),
            )
            .unwrap();
        let create = snapshot
            .tools
            .iter()
            .find(|tool| tool.id == "schedule.create")
            .expect("schedule.create is discoverable");
        let properties = create.input_schema["properties"]
            .as_object()
            .expect("schedule.create properties");
        assert!(
            properties.contains_key("delaySeconds"),
            "relative one-time schedules need a typed duration instead of a model-invented timestamp"
        );
        assert!(!properties.contains_key("requestId"));
        assert!(create.description.contains("delaySeconds"));
    }

    #[test]
    fn memory_list_is_bounded_safe_and_cross_conversation_with_current_vault_isolation() {
        fn context_for(
            backend: &BackendServices,
            conversation_id: &str,
            seed: u8,
        ) -> ToolCallContext {
            let base =
                ToolCallContext::agent_read_scoped([seed; 32], [seed + 1; 32], [seed + 2; 32]);
            let snapshot = backend
                .agent_capabilities()
                .build_snapshot(
                    crate::agent_capabilities::CapabilityProfile::Standard,
                    "请列出我保存的记忆",
                    backend.list_tools(&base).unwrap(),
                )
                .unwrap();
            base.with_agent_run(conversation_id.to_owned(), Arc::new(snapshot))
                .with_memory_bindings(Arc::new(crate::agent_memory::MemoryRunBindings::default()))
        }

        fn listed(backend: &BackendServices, context: &ToolCallContext) -> Value {
            backend
                .run_tool(
                    context,
                    ToolRunRequest::read("memory.list".to_owned(), json!({"limit":20})),
                )
                .unwrap()
                .result()
                .clone()
        }

        let (backend, vault_a) = backend_with_vault("memory-list-cross-conversation");
        let global = backend
            .memory()
            .create(crate::agent_memory::MemoryCreateInput {
                content: "global cross-conversation preference".to_owned(),
                scope: crate::agent_memory::MemoryScope::global(),
                importance: None,
                ttl_seconds: None,
                source: Some("user".to_owned()),
            })
            .unwrap();
        let current = backend
            .memory()
            .create(crate::agent_memory::MemoryCreateInput {
                content: "current vault cross-conversation fact".to_owned(),
                scope: crate::agent_memory::MemoryScope::vault(vault_a.id.clone()),
                importance: None,
                ttl_seconds: None,
                source: Some("agent-approved".to_owned()),
            })
            .unwrap();

        let first = listed(&backend, &context_for(&backend, "fresh-conversation-a", 51));
        let second = listed(&backend, &context_for(&backend, "fresh-conversation-b", 61));
        for observation in [&first, &second] {
            let entries = observation
                .as_array()
                .expect("memory.list returns a bounded array");
            assert_eq!(entries.len(), 2);
            assert!(entries.iter().any(|entry| {
                entry["content"] == "global cross-conversation preference"
                    && entry["scopeLabel"] == "全局"
            }));
            assert!(entries.iter().any(|entry| {
                entry["content"] == "current vault cross-conversation fact"
                    && entry["scopeLabel"] == "当前知识库"
            }));
            let serialized = serde_json::to_string(observation).unwrap();
            for forbidden in [
                global.id.as_str(),
                current.id.as_str(),
                vault_a.id.as_str(),
                "revision",
                "createdAt",
                "updatedAt",
                "accessedCount",
                "agent-approved",
            ] {
                assert!(!serialized.contains(forbidden), "leaked {forbidden}");
            }
        }
        assert_ne!(
            first[0]["memoryRef"], second[0]["memoryRef"],
            "fresh conversations must receive fresh run-bound references"
        );

        let vault_b_root = temp_dir("memory-list-vault-b");
        fs::create_dir_all(vault_b_root.join(".luckyray")).unwrap();
        let vault_b = KnowledgeVaultRegistration {
            id: "vault-memory-list-b".to_owned(),
            name: "memory-list-b".to_owned(),
            root_path: vault_b_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_owned(),
            created_at: "2026-08-07T00:00:00Z".to_owned(),
            last_opened_at: "2026-08-07T00:00:00Z".to_owned(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_b_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault_b).unwrap(),
        )
        .unwrap();
        backend
            .memory()
            .create(crate::agent_memory::MemoryCreateInput {
                content: "other vault fact".to_owned(),
                scope: crate::agent_memory::MemoryScope::vault(vault_b.id.clone()),
                importance: None,
                ttl_seconds: None,
                source: None,
            })
            .unwrap();
        backend
            .knowledge()
            .register_current_vault(&vault_b)
            .unwrap();
        let switched = listed(&backend, &context_for(&backend, "fresh-conversation-c", 71));
        let switched_text = serde_json::to_string(&switched).unwrap();
        assert!(switched_text.contains("global cross-conversation preference"));
        assert!(switched_text.contains("other vault fact"));
        assert!(!switched_text.contains("current vault cross-conversation fact"));

        let no_vault_backend =
            BackendServices::initialize(temp_dir("memory-list-no-vault")).unwrap();
        no_vault_backend
            .memory()
            .create(crate::agent_memory::MemoryCreateInput {
                content: "global without vault".to_owned(),
                scope: crate::agent_memory::MemoryScope::global(),
                importance: None,
                ttl_seconds: None,
                source: None,
            })
            .unwrap();
        no_vault_backend
            .memory()
            .create(crate::agent_memory::MemoryCreateInput {
                content: "unavailable vault memory".to_owned(),
                scope: crate::agent_memory::MemoryScope::vault("vault-unavailable".to_owned()),
                importance: None,
                ttl_seconds: None,
                source: None,
            })
            .unwrap();
        let no_vault = listed(
            &no_vault_backend,
            &context_for(&no_vault_backend, "fresh-conversation-no-vault", 81),
        );
        assert_eq!(no_vault.as_array().unwrap().len(), 1);
        assert_eq!(no_vault[0]["content"], "global without vault");

        let empty_search = no_vault_backend
            .run_tool(
                &context_for(&no_vault_backend, "empty-search", 91),
                ToolRunRequest::read("memory.search".to_owned(), json!({"query":""})),
            )
            .unwrap_err();
        assert_eq!(empty_search.code, "tool-input-invalid");
    }

    #[test]
    fn agent_write_source_epoch_guard_covers_permit_consume_and_handler() {
        struct SourceRacePermit {
            begin_release: mpsc::SyncSender<()>,
            release_attempted: Arc<AtomicBool>,
            release_finished: Arc<AtomicBool>,
        }

        impl AgentWritePermit for SourceRacePermit {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                self.begin_release.send(()).unwrap();
                let deadline = Instant::now() + Duration::from_secs(1);
                while !self.release_attempted.load(Ordering::Acquire) {
                    assert!(Instant::now() < deadline, "source release did not start");
                    std::thread::yield_now();
                }
                assert!(
                    !self.release_finished.load(Ordering::Acquire),
                    "source release overtook the guarded write linearization point"
                );
                Ok(())
            }
        }

        struct CountingPermit(Arc<AtomicUsize>);

        impl AgentWritePermit for CountingPermit {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                self.0.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }
        }

        let (backend, vault) = backend_with_vault("agent-source-lease");
        let activation = backend.knowledge().activate_ui_source(&vault.id).unwrap();
        let context = ToolCallContext::agent_read([21; 32]);
        let prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "knowledge.create".to_owned(),
                    json!({
                        "expectedVaultId":vault.id,
                        "relativePath":"Guarded.md",
                        "content":"guarded",
                        "requestId":"guarded-request"
                    }),
                ),
                AgentWriteScope::new(
                    "local-turn".to_owned(),
                    "engine-session".to_owned(),
                    "engine-turn".to_owned(),
                    "tool-call".to_owned(),
                    1,
                    activation.source_epoch,
                ),
            )
            .unwrap();
        let (begin_release, release_started) = mpsc::sync_channel(1);
        let release_attempted = Arc::new(AtomicBool::new(false));
        let release_finished = Arc::new(AtomicBool::new(false));
        let release_knowledge = backend.knowledge();
        let attempted = release_attempted.clone();
        let finished = release_finished.clone();
        let release = std::thread::spawn(move || {
            release_started.recv().unwrap();
            attempted.store(true, Ordering::Release);
            release_knowledge.deactivate_ui_source().unwrap();
            finished.store(true, Ordering::Release);
        });
        backend
            .run_prepared_agent_write(
                &context,
                prepared,
                &SourceRacePermit {
                    begin_release,
                    release_attempted,
                    release_finished: release_finished.clone(),
                },
            )
            .unwrap();
        release.join().unwrap();
        assert!(release_finished.load(Ordering::Acquire));
        assert_eq!(
            fs::read_to_string(std::path::Path::new(&vault.root_path).join("Guarded.md")).unwrap(),
            "guarded"
        );

        let stale = backend.knowledge().activate_ui_source(&vault.id).unwrap();
        let prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "knowledge.create".to_owned(),
                    json!({
                        "expectedVaultId":vault.id,
                        "relativePath":"MustNotWrite.md",
                        "content":"denied",
                        "requestId":"stale-source-request"
                    }),
                ),
                AgentWriteScope::new(
                    "local-turn-2".to_owned(),
                    "engine-session".to_owned(),
                    "engine-turn-2".to_owned(),
                    "tool-call-2".to_owned(),
                    2,
                    stale.source_epoch,
                ),
            )
            .unwrap();
        backend.knowledge().deactivate_ui_source().unwrap();
        let consumes = Arc::new(AtomicUsize::new(0));
        let error = backend
            .run_prepared_agent_write(&context, prepared, &CountingPermit(consumes.clone()))
            .unwrap_err();
        assert_eq!(error.code, "knowledge-source-inactive");
        assert_eq!(consumes.load(Ordering::Acquire), 0);
        assert!(!std::path::Path::new(&vault.root_path)
            .join("MustNotWrite.md")
            .exists());
    }

    #[test]
    fn disabled_agent_network_fails_before_the_configured_search_endpoint_is_contacted() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let app_data = temp_dir("agent-web-disabled");
        let backend = BackendServices::initialize(&app_data).unwrap();
        backend
            .open_write()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES ('agentWebSearchUrl',?1)",
                [format!("http://{address}/search")],
            )
            .unwrap();
        let _lease = backend
            .web_tools()
            .bind_scope(&backend, [14u8; 32])
            .unwrap();
        let error = backend
            .run_tool(
                &ToolCallContext::agent_read_scoped([4u8; 32], [14u8; 32], [24u8; 32]),
                ToolRunRequest::read(
                    "web.search".to_owned(),
                    json!({"query":"must not dispatch"}),
                ),
            )
            .unwrap_err();
        assert_eq!(error.code, "web-network-disabled");
        assert!(matches!(
            listener.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    #[test]
    fn web_search_uses_the_server_owned_searxng_adapter_without_query_in_the_url() {
        let fetch_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let fetch_address = fetch_listener.local_addr().unwrap();
        let fetch_server = std::thread::spawn(move || {
            let (mut socket, _) = fetch_listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let read = socket.read(&mut request).unwrap();
            let body = b"search-to-fetch-observation";
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut buffer = [0u8; 1024];
                        loop {
                            let read = socket.read(&mut buffer).unwrap_or(0);
                            if read == 0 {
                                break;
                            }
                            request.extend_from_slice(&buffer[..read]);
                            let header_end = request
                                .windows(4)
                                .position(|window| window == b"\r\n\r\n")
                                .map(|index| index + 4);
                            let expected = header_end.and_then(|index| {
                                let headers = String::from_utf8_lossy(&request[..index]);
                                headers
                                    .lines()
                                    .find_map(|line| {
                                        line.strip_prefix("Content-Length: ")
                                            .or_else(|| line.strip_prefix("content-length: "))
                                    })
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                                    .map(|length| index + length)
                            });
                            if expected.is_some_and(|expected| request.len() >= expected) {
                                break;
                            }
                        }
                        let body = format!(
                            "{{\"results\":[{{\"url\":\"http://{fetch_address}/article?token=PRIVATE\",\"title\":\"Safe result\",\"content\":\"bounded snippet\"}}]}}"
                        );
                        write!(
                            socket,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .unwrap();
                        socket.write_all(body.as_bytes()).unwrap();
                        return request;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "search fixture was not called");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("search fixture accept failed: {error}"),
                }
            }
        });

        let app_data = temp_dir("agent-web-search");
        let backend = BackendServices::initialize(&app_data).unwrap();
        backend.web_tools().enable_result_loopback_for_test();
        let status = backend
            .web_tools()
            .update_settings(
                &backend,
                crate::web_tools::SearchSettingsUpdate {
                    enabled: true,
                    provider: "searxng".to_owned(),
                    tavily_api_key: None,
                    clear_tavily_api_key: false,
                    searxng_endpoint: Some(format!("http://{address}/search")),
                    clear_searxng_endpoint: false,
                    searxng_allow_local: true,
                },
            )
            .unwrap();
        assert!(status.ready, "fixture search settings must be ready");
        let lease = backend
            .web_tools()
            .bind_scope(&backend, [18u8; 32])
            .unwrap();
        let browser_lease = backend
            .agent_browser()
            .bind_scope([28u8; 32], Instant::now() + Duration::from_secs(30))
            .unwrap();
        assert!(backend.web_tools().scope_search_ready([18u8; 32]).is_ok());
        let context = ToolCallContext::agent_read_scoped([8u8; 32], [18u8; 32], [28u8; 32]);
        let web_definition = backend
            .list_tools(&context)
            .unwrap()
            .into_iter()
            .find(|definition| definition.id == "web.search")
            .unwrap();
        assert!(web_definition.availability.available);
        assert!(backend.web_tools().scope_search_ready([18u8; 32]).is_ok());
        let result = backend
            .run_tool(
                &context,
                ToolRunRequest::read(
                    "web.search".to_string(),
                    json!({"query":"fixture search","limit":5}),
                ),
            )
            .unwrap();
        let request = server.join().unwrap();
        let request = String::from_utf8(request).unwrap();
        assert!(request.starts_with("POST /search HTTP/1.1\r\n"));
        assert!(!request.starts_with("POST /search?"));
        assert!(request.contains("q=fixture+search"));
        assert_eq!(result.result()["adapter"], "searxng");
        assert_eq!(result.result()["results"].as_array().unwrap().len(), 1);
        let serialized = serde_json::to_string(result.result()).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        let fetch_ref = result.result()["results"][0]["fetchRef"].as_str().unwrap();
        assert!(fetch_ref.starts_with("wref-"));
        let fetched = backend
            .run_tool(
                &context,
                ToolRunRequest::read("web.fetch".to_string(), json!({"fetchRef":fetch_ref})),
            )
            .unwrap();
        assert_eq!(fetched.result()["text"], "search-to-fetch-observation");
        let fetch_request = fetch_server.join().unwrap();
        assert!(fetch_request.starts_with("GET /article?token=PRIVATE HTTP/1.1\r\n"));
        assert!(!serde_json::to_string(fetched.result())
            .unwrap()
            .contains("PRIVATE"));
        drop(browser_lease);
        drop(lease);
    }

    #[test]
    fn web_fetch_runs_through_the_registry_and_removes_active_html_content() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let read = socket.read(&mut request).unwrap();
            let body = br#"<!doctype html><html><head><title>Fixture title</title><style>PRIVATE-STYLE</style><meta name='secret' content='PRIVATE-META'></head><body><main>Visible article</main><script>PRIVATE-SCRIPT</script><form>PRIVATE-FORM</form></body></html>"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let app_data = temp_dir("agent-web-fetch");
        let backend = BackendServices::initialize(&app_data).unwrap();
        backend
            .web_tools()
            .update_settings(
                &backend,
                crate::web_tools::SearchSettingsUpdate {
                    enabled: true,
                    provider: "searxng".to_owned(),
                    tavily_api_key: None,
                    clear_tavily_api_key: false,
                    searxng_endpoint: Some(format!("http://{address}/search")),
                    clear_searxng_endpoint: false,
                    searxng_allow_local: true,
                },
            )
            .unwrap();
        let scope = [19u8; 32];
        let _lease = backend.web_tools().bind_scope(&backend, scope).unwrap();
        let fetch_ref = backend
            .web_tools()
            .issue_ref_for_test(
                scope,
                &format!("http://{address}/article?token=PRIVATE-QUERY"),
            )
            .unwrap();
        let result = backend
            .run_tool(
                &ToolCallContext::agent_read_scoped([9u8; 32], scope, [29u8; 32]),
                ToolRunRequest::read("web.fetch".to_string(), json!({"fetchRef":fetch_ref})),
            )
            .unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /article?token=PRIVATE-QUERY HTTP/1.1\r\n"));
        assert_eq!(result.result()["title"], "Fixture title");
        assert!(result.result()["text"]
            .as_str()
            .unwrap()
            .contains("Visible article"));
        let serialized = serde_json::to_string(result.result()).unwrap();
        assert!(!serialized.contains("PRIVATE-SCRIPT"));
        assert!(!serialized.contains("PRIVATE-STYLE"));
        assert!(!serialized.contains("PRIVATE-META"));
        assert!(!serialized.contains("PRIVATE-FORM"));
        assert!(!serialized.contains("PRIVATE-QUERY"));
    }

    #[test]
    fn agent_web_fetch_rejects_model_supplied_urls_before_network_dispatch() {
        let app_data = temp_dir("agent-web-fetch-url-denied");
        let backend = BackendServices::initialize(&app_data).unwrap();
        backend
            .web_tools()
            .update_settings(
                &backend,
                crate::web_tools::SearchSettingsUpdate {
                    enabled: true,
                    provider: "searxng".to_owned(),
                    tavily_api_key: None,
                    clear_tavily_api_key: false,
                    searxng_endpoint: Some("https://search.example.test/search".to_owned()),
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        let scope = [20u8; 32];
        let _lease = backend.web_tools().bind_scope(&backend, scope).unwrap();
        let error = backend
            .run_tool(
                &ToolCallContext::agent_read_scoped([9u8; 32], scope, [29u8; 32]),
                ToolRunRequest::read(
                    "web.fetch".to_string(),
                    json!({"url":"https://example.invalid/private"}),
                ),
            )
            .unwrap_err();
        assert_eq!(error.code, "tool-input-invalid");
    }

    #[test]
    fn definitions_are_deterministic_and_equal_across_internal_test_principals() {
        let (backend, _) = backend_with_vault("definitions");
        let first = backend.list_tools(&ToolCallContext::future_cli()).unwrap();
        let second = backend.list_tools(&ToolCallContext::future_mcp()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 7);
        assert!(first.windows(2).all(|pair| pair[0].id < pair[1].id));
        assert!(first
            .iter()
            .all(|tool| tool.input_schema["additionalProperties"] == Value::Bool(false)));
    }

    #[test]
    fn registry_rejects_duplicate_and_oversized_definitions() {
        let registry = ToolRegistry::default();
        let mut definitions = registry.base_definitions(true, false);
        definitions.push(definitions[0].clone());
        assert_eq!(
            validate_definitions(&definitions).unwrap_err().code,
            "tool-registry-invalid"
        );
        let mut oversized = registry.base_definitions(true, false);
        oversized[0].max_input_bytes = 1024 * 1024 + 1;
        assert_eq!(
            validate_definitions(&oversized).unwrap_err().code,
            "tool-registry-invalid"
        );
        let mut bad_schema = registry.base_definitions(true, false);
        bad_schema[0].input_schema = json!({"type":"executable"});
        assert_eq!(
            validate_definitions(&bad_schema).unwrap_err().code,
            "tool-schema-invalid"
        );
    }

    #[test]
    fn knowledge_vertical_slice_enforces_identity_revision_and_no_clobber() {
        let (backend, vault) = backend_with_vault("knowledge-slice");
        fs::create_dir_all(std::path::Path::new(&vault.root_path).join("Inbox")).unwrap();
        let context = ToolCallContext::future_cli();
        let created = backend
            .run_tool(
                &context,
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: json!({
                        "expectedVaultId": vault.id,
                        "relativePath":"Inbox/Registry.md",
                        "content":"REGISTRY-TOKEN",
                        "requestId":"create-1"
                    }),
                    request_id: None,
                },
            )
            .unwrap();
        let id = created.result["id"].as_str().unwrap().to_string();
        let revision = created.result["revision"].as_str().unwrap().to_string();
        let searched = backend
            .run_tool(
                &context,
                ToolRunRequest {
                    tool_id: "knowledge.search".to_string(),
                    input: json!({"query":"REGISTRY-TOKEN","limit":10}),
                    request_id: None,
                },
            )
            .unwrap();
        assert_eq!(searched.result["documents"].as_array().unwrap().len(), 1);
        let appended = backend
            .run_tool(
                &context,
                ToolRunRequest {
                    tool_id: "knowledge.append".to_string(),
                    input: json!({
                        "id":id,
                        "expectedVaultId":vault.id,
                        "expectedRevision":revision,
                        "content":"\nNEXT",
                        "requestId":"append-1"
                    }),
                    request_id: None,
                },
            )
            .unwrap();
        assert_eq!(appended.result["committed"], true);
        let duplicate = backend.run_tool(
            &context,
            ToolRunRequest {
                tool_id: "knowledge.create".to_string(),
                input: json!({
                    "expectedVaultId":vault.id,
                    "relativePath":"Inbox/Registry.md",
                    "content":"different",
                    "requestId":"create-2"
                }),
                request_id: None,
            },
        );
        assert_eq!(duplicate.unwrap_err().code, "knowledge-name-conflict");
    }

    #[test]
    fn request_id_is_single_flight_conflict_safe_and_failure_retryable() {
        let (backend, vault) = backend_with_vault("requests");
        let context = ToolCallContext::future_cli();
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault.id,
                "relativePath":"Once.md",
                "content":"once",
                "requestId":"same-request"
            }),
            request_id: None,
        };
        let first = backend.run_tool(&context, request.clone()).unwrap();
        let second = backend.run_tool(&context, request).unwrap();
        assert_eq!(first, second);
        let conflict = backend.run_tool(
            &context,
            ToolRunRequest {
                tool_id: "knowledge.create".to_string(),
                input: json!({
                    "expectedVaultId":vault.id,
                    "relativePath":"Other.md",
                    "content":"other",
                    "requestId":"same-request"
                }),
                request_id: None,
            },
        );
        assert_eq!(conflict.unwrap_err().code, "request-id-conflict");

        let failing = ToolRunRequest {
            tool_id: "knowledge.append".to_string(),
            input: json!({
                "id":first.result["id"],
                "expectedVaultId":vault.id,
                "expectedRevision":"stale",
                "content":"retry",
                "requestId":"failure-retry"
            }),
            request_id: None,
        };
        assert!(backend.run_tool(&context, failing.clone()).is_err());
        assert!(backend.run_tool(&context, failing).is_err());

        let retry_request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault.id,
                "relativePath":"Later/Retry.md",
                "content":"retry",
                "requestId":"same-failed-request"
            }),
            request_id: None,
        };
        assert_eq!(
            backend
                .run_tool(&context, retry_request.clone())
                .unwrap_err()
                .code,
            "knowledge-parent-missing"
        );
        fs::create_dir_all(std::path::Path::new(&vault.root_path).join("Later")).unwrap();
        assert!(backend.run_tool(&context, retry_request).is_ok());
    }

    #[test]
    fn cached_write_is_reauthorized_against_the_live_vault() {
        let app_data = temp_dir("cached-vault-authorization-app");
        let root_a = temp_dir("cached-vault-authorization-a");
        let root_b = temp_dir("cached-vault-authorization-b");
        for root in [&root_a, &root_b] {
            fs::create_dir_all(root.join(".luckyray")).unwrap();
        }
        let vault_a = KnowledgeVaultRegistration {
            id: "vault-cached-authorization-a".to_string(),
            name: "Vault A".to_string(),
            root_path: root_a.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        let vault_b = KnowledgeVaultRegistration {
            id: "vault-cached-authorization-b".to_string(),
            name: "Vault B".to_string(),
            root_path: root_b.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        for (root, vault) in [(&root_a, &vault_a), (&root_b, &vault_b)] {
            fs::write(
                root.join(".luckyray").join("vault.json"),
                serde_json::to_vec_pretty(vault).unwrap(),
            )
            .unwrap();
        }
        let controller = BackendServices::initialize(&app_data).unwrap();
        controller
            .knowledge()
            .register_current_vault(&vault_a)
            .unwrap();
        let runtime = ToolRuntime::initialize(&app_data).unwrap();
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault_a.id,
                "relativePath":"Cached.md",
                "content":"cached authorization",
                "requestId":"cached-vault-authorization"
            }),
            request_id: None,
        };
        let first = runtime
            .run_tool(&ToolCallContext::future_cli(), request.clone())
            .unwrap();
        controller
            .knowledge()
            .register_current_vault(&vault_b)
            .unwrap();
        let switched = runtime
            .run_tool(&ToolCallContext::future_cli(), request.clone())
            .unwrap_err();
        assert_eq!(switched.code, "knowledge-vault-not-current");
        assert!(!root_b.join("Cached.md").exists());

        controller
            .knowledge()
            .register_current_vault(&vault_a)
            .unwrap();
        let replay = runtime
            .run_tool(&ToolCallContext::future_cli(), request)
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(fs::read_dir(&root_a).unwrap().count(), 2);
    }

    #[test]
    fn cached_handoff_rejects_a_vault_switch_after_ordinary_reauthorization() {
        let (runtime, controller, vault_a) = runtime_with_vault("cached-handoff-a");
        let root_b = temp_dir("cached-handoff-b-vault");
        fs::create_dir_all(root_b.join(".luckyray")).unwrap();
        let vault_b = KnowledgeVaultRegistration {
            id: "vault-cached-handoff-b".to_string(),
            name: "Cached handoff B".to_string(),
            root_path: root_b.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root_b.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault_b).unwrap(),
        )
        .unwrap();
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault_a.id,
                "relativePath":"Cached handoff.md",
                "content":"cached in A",
                "requestId":"cached-handoff-race"
            }),
            request_id: None,
        };
        let first = runtime
            .run_tool(&ToolCallContext::future_cli(), request.clone())
            .unwrap();
        let handoff_gate =
            install_request_test_gate(&AFTER_REAUTHORIZE_BEFORE_HANDOFF, "cached-handoff-race");
        let runtime = Arc::new(runtime);
        let replay = {
            let runtime = runtime.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        handoff_gate.0.wait();
        controller
            .knowledge()
            .register_current_vault(&vault_b)
            .unwrap();
        handoff_gate.1.wait();
        assert_eq!(
            replay.join().unwrap().unwrap_err().code,
            "knowledge-vault-not-current"
        );
        assert!(!root_b.join("Cached handoff.md").exists());

        controller
            .knowledge()
            .register_current_vault(&vault_a)
            .unwrap();
        let replay = runtime
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: json!({
                        "expectedVaultId":vault_a.id,
                        "relativePath":"Cached handoff.md",
                        "content":"cached in A",
                        "requestId":"cached-handoff-race"
                    }),
                    request_id: None,
                },
            )
            .unwrap();
        assert_eq!(replay, first);
    }

    #[test]
    fn cached_handoff_linearizes_before_a_waiting_vault_switch() {
        let (runtime, controller, vault_a) = runtime_with_vault("handoff-linearizes-a");
        let root_b = temp_dir("handoff-linearizes-b-vault");
        fs::create_dir_all(root_b.join(".luckyray")).unwrap();
        let vault_b = KnowledgeVaultRegistration {
            id: "vault-handoff-linearizes-b".to_string(),
            name: "Handoff linearizes B".to_string(),
            root_path: root_b.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root_b.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault_b).unwrap(),
        )
        .unwrap();
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault_a.id,
                "relativePath":"Linearized.md",
                "content":"A result",
                "requestId":"handoff-linearizes"
            }),
            request_id: None,
        };
        let first = runtime
            .run_tool(&ToolCallContext::future_cli(), request.clone())
            .unwrap();
        let handoff_gate =
            install_request_test_gate(&DURING_CURRENT_VAULT_HANDOFF, "handoff-linearizes");
        let runtime = Arc::new(runtime);
        let replay = {
            let runtime = runtime.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        handoff_gate.0.wait();
        let (switched_tx, switched_rx) = std::sync::mpsc::channel();
        let switch = std::thread::spawn(move || {
            controller
                .knowledge()
                .register_current_vault(&vault_b)
                .unwrap();
            switched_tx.send(()).unwrap();
        });
        assert!(switched_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        handoff_gate.1.wait();
        assert_eq!(replay.join().unwrap().unwrap(), first);
        switched_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        switch.join().unwrap();
    }

    #[test]
    fn request_identity_is_principal_scoped_and_canonical_input_is_digest_only() {
        let (runtime, _, vault) = runtime_with_vault("principal-digest");
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault.id,
                "relativePath":"Principal.md",
                "content":"principal isolation",
                "requestId":"principal-isolation"
            }),
            request_id: None,
        };
        runtime
            .run_tool(&ToolCallContext::future_cli(), request.clone())
            .unwrap();
        assert_eq!(
            runtime
                .run_tool(&ToolCallContext::future_mcp(), request.clone())
                .unwrap_err()
                .code,
            "knowledge-name-conflict"
        );
        assert_eq!(
            runtime
                .run_tool(&ToolCallContext::tauri(), request)
                .unwrap_err()
                .code,
            "knowledge-name-conflict"
        );

        let large_sentinel = format!(
            "PRIVATE-INPUT-SENTINEL-{}",
            "x".repeat(MAX_WRITE_CONTENT_BYTES - 64)
        );
        let large_request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault.id,
                "relativePath":"DigestOnly.md",
                "content":large_sentinel,
                "requestId":"digest-only"
            }),
            request_id: None,
        };
        runtime
            .run_tool(&ToolCallContext::future_cli(), large_request)
            .unwrap();
        let snapshot = runtime.request_cache_snapshot();
        assert!(snapshot.entries >= 2);
        assert!(snapshot.retained_bytes <= REQUEST_CACHE_BYTE_BUDGET);
        assert!(!snapshot.serialized.contains("PRIVATE-INPUT-SENTINEL"));
        assert!(!snapshot.serialized.contains("principal isolation"));
    }

    #[test]
    fn semantic_object_key_order_reuses_the_same_digest_and_invalid_request_ids_fail() {
        let (runtime, _, vault) = runtime_with_vault("canonical-digest");
        let mut first = Map::new();
        first.insert("expectedVaultId".to_string(), json!(vault.id));
        first.insert("relativePath".to_string(), json!("Canonical.md"));
        first.insert("content".to_string(), json!("same semantic input"));
        first.insert("requestId".to_string(), json!("canonical-order"));
        let mut reordered = Map::new();
        reordered.insert("requestId".to_string(), json!("canonical-order"));
        reordered.insert("content".to_string(), json!("same semantic input"));
        reordered.insert("relativePath".to_string(), json!("Canonical.md"));
        reordered.insert("expectedVaultId".to_string(), json!(vault.id));
        let first = runtime
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: Value::Object(first),
                    request_id: None,
                },
            )
            .unwrap();
        let replay = runtime
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: Value::Object(reordered),
                    request_id: None,
                },
            )
            .unwrap();
        assert_eq!(first, replay);

        for invalid in ["contains control\u{0001}", &"x".repeat(97)] {
            let error = runtime
                .run_tool(
                    &ToolCallContext::future_cli(),
                    ToolRunRequest {
                        tool_id: "knowledge.create".to_string(),
                        input: json!({
                            "expectedVaultId":vault.id,
                            "relativePath":"Invalid.md",
                            "content":"must not execute",
                            "requestId":invalid
                        }),
                        request_id: None,
                    },
                )
                .unwrap_err();
            assert_eq!(error.code, "tool-input-invalid");
        }
        assert!(!std::path::Path::new(&vault.root_path)
            .join("Invalid.md")
            .exists());
    }

    #[test]
    fn concurrent_identical_request_id_creates_exactly_one_document() {
        let (backend, vault) = backend_with_vault("request-concurrency");
        let backend = Arc::new(backend);
        let start = Arc::new(std::sync::Barrier::new(9));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let backend = backend.clone();
            let start = start.clone();
            let vault_id = vault.id.clone();
            workers.push(std::thread::spawn(move || {
                start.wait();
                backend.run_tool(
                    &ToolCallContext::future_cli(),
                    ToolRunRequest {
                        tool_id: "knowledge.create".to_string(),
                        input: json!({
                            "expectedVaultId":vault_id,
                            "relativePath":"Concurrent.md",
                            "content":"one execution",
                            "requestId":"concurrent-create"
                        }),
                        request_id: None,
                    },
                )
            }));
        }
        start.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect::<Vec<_>>();
        assert!(results.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(backend.knowledge().list_documents().unwrap().len(), 1);
    }

    #[test]
    fn follower_reauthorizes_after_wait_while_committed_leader_keeps_success() {
        let (runtime, controller, vault_a) = runtime_with_vault("follower-authorization-a");
        let root_b = temp_dir("follower-authorization-b-vault");
        fs::create_dir_all(root_b.join(".luckyray")).unwrap();
        let vault_b = KnowledgeVaultRegistration {
            id: "vault-follower-authorization-b".to_string(),
            name: "Follower B".to_string(),
            root_path: root_b.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root_b.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault_b).unwrap(),
        )
        .unwrap();
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault_a.id,
                "relativePath":"Follower.md",
                "content":"committed once",
                "requestId":"follower-reauthorize"
            }),
            request_id: None,
        };
        let settle_gate = install_request_test_gate(&BEFORE_REQUEST_SETTLE, "follower-reauthorize");
        let follower_gate =
            install_request_test_gate(&BEFORE_FOLLOWER_WAIT, "follower-reauthorize");
        let handoff_gate =
            install_request_test_gate(&AFTER_REAUTHORIZE_BEFORE_HANDOFF, "follower-reauthorize");
        let runtime = Arc::new(runtime);
        let leader = {
            let runtime = runtime.clone();
            let request = request.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        settle_gate.0.wait();
        let follower = {
            let runtime = runtime.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        follower_gate.0.wait();
        follower_gate.1.wait();
        settle_gate.1.wait();
        handoff_gate.0.wait();
        controller
            .knowledge()
            .register_current_vault(&vault_b)
            .unwrap();
        handoff_gate.1.wait();

        assert!(leader.join().unwrap().is_ok());
        assert_eq!(
            follower.join().unwrap().unwrap_err().code,
            "knowledge-vault-not-current"
        );
        assert!(std::path::Path::new(&vault_a.root_path)
            .join("Follower.md")
            .exists());
        assert!(!root_b.join("Follower.md").exists());

        controller
            .knowledge()
            .register_current_vault(&vault_a)
            .unwrap();
        assert!(runtime
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: json!({
                        "expectedVaultId":vault_a.id,
                        "relativePath":"Follower.md",
                        "content":"committed once",
                        "requestId":"follower-reauthorize"
                    }),
                    request_id: None,
                }
            )
            .is_ok());
    }

    #[test]
    fn follower_handoff_linearizes_before_a_waiting_vault_switch() {
        let (runtime, controller, vault_a) = runtime_with_vault("follower-handoff-a");
        let root_b = temp_dir("follower-handoff-b-vault");
        fs::create_dir_all(root_b.join(".luckyray")).unwrap();
        let vault_b = KnowledgeVaultRegistration {
            id: "vault-follower-handoff-b".to_string(),
            name: "Follower handoff B".to_string(),
            root_path: root_b.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root_b.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault_b).unwrap(),
        )
        .unwrap();
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault_a.id,
                "relativePath":"Follower linearized.md",
                "content":"committed in A",
                "requestId":"follower-handoff-linearizes"
            }),
            request_id: None,
        };
        let settle_gate =
            install_request_test_gate(&BEFORE_REQUEST_SETTLE, "follower-handoff-linearizes");
        let follower_gate =
            install_request_test_gate(&BEFORE_FOLLOWER_WAIT, "follower-handoff-linearizes");
        let handoff_gate =
            install_request_test_gate(&DURING_CURRENT_VAULT_HANDOFF, "follower-handoff-linearizes");
        let runtime = Arc::new(runtime);
        let leader = {
            let runtime = runtime.clone();
            let request = request.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        settle_gate.0.wait();
        let follower = {
            let runtime = runtime.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        follower_gate.0.wait();
        follower_gate.1.wait();
        settle_gate.1.wait();
        handoff_gate.0.wait();
        let (switched_tx, switched_rx) = std::sync::mpsc::channel();
        let switch = std::thread::spawn(move || {
            controller
                .knowledge()
                .register_current_vault(&vault_b)
                .unwrap();
            switched_tx.send(()).unwrap();
        });
        assert!(switched_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        handoff_gate.1.wait();
        let leader_result = leader.join().unwrap().unwrap();
        assert_eq!(follower.join().unwrap().unwrap(), leader_result);
        switched_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        switch.join().unwrap();
    }

    #[test]
    fn aggregate_reservation_rejects_before_execution_and_releases_after_settle() {
        let (runtime, _, vault) = runtime_with_vault("aggregate-budget");
        let runtime = Arc::new(runtime);
        let gate = block_request_execution("capacity-", 16);
        let mut workers = Vec::new();
        for index in 0..16 {
            let runtime = runtime.clone();
            let vault_id = vault.id.clone();
            workers.push(std::thread::spawn(move || {
                runtime.run_tool(
                    &ToolCallContext::future_cli(),
                    ToolRunRequest {
                        tool_id: "knowledge.create".to_string(),
                        input: json!({
                            "expectedVaultId":vault_id,
                            "relativePath":format!("Capacity-{index}.md"),
                            "content":format!("capacity {index}"),
                            "requestId":format!("capacity-{index}")
                        }),
                        request_id: None,
                    },
                )
            }));
        }
        gate.wait_until_full();
        let snapshot = runtime.request_cache_snapshot();
        assert_eq!(snapshot.entries, 16);
        assert_eq!(snapshot.retained_bytes, REQUEST_CACHE_BYTE_BUDGET);

        let overflow = runtime
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: json!({
                        "expectedVaultId":vault.id,
                        "relativePath":"Capacity-overflow.md",
                        "content":"must not execute",
                        "requestId":"capacity-overflow"
                    }),
                    request_id: None,
                },
            )
            .unwrap_err();
        assert_eq!(overflow.code, "tool-request-capacity");
        assert_eq!(gate.entered(), 16);
        assert!(!std::path::Path::new(&vault.root_path)
            .join("Capacity-overflow.md")
            .exists());

        gate.release();
        for worker in workers {
            assert!(worker.join().unwrap().is_ok());
        }
        let settled = runtime.request_cache_snapshot();
        assert!(settled.retained_bytes < REQUEST_CACHE_BYTE_BUDGET);
        assert!(runtime
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: json!({
                        "expectedVaultId":vault.id,
                        "relativePath":"Capacity-restored.md",
                        "content":"restored",
                        "requestId":"capacity-restored"
                    }),
                    request_id: None,
                },
            )
            .is_ok());
    }

    #[test]
    fn post_commit_output_failure_becomes_bounded_cached_success() {
        let (runtime, controller, vault) = runtime_with_vault("committed-output-fallback");
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault.id,
                "relativePath":"Committed.md",
                "content":"commit exactly once",
                "requestId":"committed-output-fallback"
            }),
            request_id: None,
        };
        corrupt_write_output_for("committed-output-fallback");
        let first = runtime
            .run_tool(&ToolCallContext::future_cli(), request.clone())
            .unwrap();
        assert_eq!(first.result["indexWarning"]["code"], "tool-output-redacted");
        assert_eq!(first.result["indexStale"], true);
        let replay = runtime
            .run_tool(&ToolCallContext::future_cli(), request)
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(
            fs::read_to_string(std::path::Path::new(&vault.root_path).join("Committed.md"))
                .unwrap(),
            "commit exactly once"
        );

        let committed_ref = KnowledgeDocumentRef {
            vault_id: vault.id.clone(),
            relative_path: "Committed.md".to_string(),
        };
        let revision = controller
            .knowledge()
            .read_document(&committed_ref)
            .unwrap()
            .revision;
        let append = ToolRunRequest {
            tool_id: "knowledge.append".to_string(),
            input: json!({
                "documentRef":committed_ref,
                "expectedVaultId":vault.id,
                "expectedRevision":revision,
                "content":"\nappend once",
                "requestId":"committed-append-fallback"
            }),
            request_id: None,
        };
        corrupt_write_output_for("committed-append-fallback");
        let appended = runtime
            .run_tool(&ToolCallContext::future_cli(), append.clone())
            .unwrap();
        assert_eq!(
            appended.result["indexWarning"]["code"],
            "tool-output-redacted"
        );
        assert_eq!(
            appended,
            runtime
                .run_tool(&ToolCallContext::future_cli(), append)
                .unwrap()
        );
        assert_eq!(
            fs::read_to_string(std::path::Path::new(&vault.root_path).join("Committed.md"))
                .unwrap(),
            "commit exactly once\n\n\nappend once"
        );

        let capability = ToolRunRequest {
            tool_id: "capability.run".to_string(),
            input: json!({
                "capabilityId":"wf.web_to_note",
                "expectedVaultId":vault.id,
                "sourceMode":"headless",
                "input":{"title":"Capability committed","content":"created once"},
                "requestId":"committed-capability-fallback"
            }),
            request_id: None,
        };
        corrupt_write_output_for("committed-capability-fallback");
        let capability_result = runtime
            .run_tool(&ToolCallContext::future_cli(), capability.clone())
            .unwrap();
        assert_eq!(
            capability_result.result["indexWarning"]["code"],
            "tool-output-redacted"
        );
        assert_eq!(
            capability_result,
            runtime
                .run_tool(&ToolCallContext::future_cli(), capability)
                .unwrap()
        );
        assert_eq!(
            fs::read_to_string(
                std::path::Path::new(&vault.root_path).join("Capability committed.md")
            )
            .unwrap(),
            "created once"
        );
    }

    #[test]
    fn expiry_and_failure_release_cache_accounting_without_underflow() {
        let (runtime, _, vault) = runtime_with_vault("cache-expiry");
        let failed = runtime.run_tool(
            &ToolCallContext::future_cli(),
            ToolRunRequest {
                tool_id: "knowledge.create".to_string(),
                input: json!({
                    "expectedVaultId":vault.id,
                    "relativePath":"Missing/Failed.md",
                    "content":"failure releases",
                    "requestId":"failure-releases"
                }),
                request_id: None,
            },
        );
        assert_eq!(failed.unwrap_err().code, "knowledge-parent-missing");
        assert!(!runtime
            .request_cache_snapshot()
            .serialized
            .contains("failure-releases"));

        runtime
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: json!({
                        "expectedVaultId":vault.id,
                        "relativePath":"Expiring.md",
                        "content":"expires",
                        "requestId":"expires-cleanly"
                    }),
                    request_id: None,
                },
            )
            .unwrap();
        assert!(runtime.request_cache_snapshot().retained_bytes > 0);
        runtime.expire_settled_requests();
        runtime
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.create".to_string(),
                    input: json!({
                        "expectedVaultId":vault.id,
                        "relativePath":"After expiry.md",
                        "content":"after expiry",
                        "requestId":"after-expiry"
                    }),
                    request_id: None,
                },
            )
            .unwrap();
        let snapshot = runtime.request_cache_snapshot();
        assert_eq!(snapshot.entries, 1);
        assert!(snapshot.retained_bytes <= REQUEST_CACHE_BYTE_BUDGET);
        assert!(!snapshot.serialized.contains("expires-cleanly"));
    }

    #[test]
    fn settled_success_receives_a_full_ttl_after_a_long_inflight_execution() {
        let (runtime, _, vault) = runtime_with_vault("settled-ttl");
        let runtime = Arc::new(runtime);
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault.id,
                "relativePath":"Long execution.md",
                "content":"settled TTL starts now",
                "requestId":"long-inflight-settled-ttl"
            }),
            request_id: None,
        };
        let execution_gate = block_request_execution("long-inflight-settled-ttl", 1);
        let leader = {
            let runtime = runtime.clone();
            let request = request.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        execution_gate.wait_until_full();
        runtime.backdate_inflight_request("long-inflight-settled-ttl");
        execution_gate.release();
        let first = leader.join().unwrap().unwrap();
        let immediate = runtime
            .run_tool(&ToolCallContext::future_cli(), request.clone())
            .unwrap();
        assert_eq!(immediate, first);
        assert_eq!(execution_gate.entered(), 1);

        runtime.expire_settled_requests();
        assert_eq!(
            runtime
                .run_tool(&ToolCallContext::future_cli(), request)
                .unwrap_err()
                .code,
            "knowledge-name-conflict"
        );
        assert_eq!(execution_gate.entered(), 2);
    }

    #[test]
    fn leader_panic_aborts_followers_releases_capacity_and_allows_retry() {
        let (runtime, _, vault) = runtime_with_vault("leader-panic");
        let runtime = Arc::new(runtime);
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault.id,
                "relativePath":"Panic retry.md",
                "content":"retry after owner abort",
                "requestId":"leader-panic-retry"
            }),
            request_id: None,
        };
        let execution_gate = block_request_execution("leader-panic-retry", 1);
        let follower_gate = install_request_test_gate(&BEFORE_FOLLOWER_WAIT, "leader-panic-retry");
        set_leader_abort_hook(&PANIC_LEADER_FOR, "leader-panic-retry");
        let leader = {
            let runtime = runtime.clone();
            let request = request.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        execution_gate.wait_until_full();
        let follower = {
            let runtime = runtime.clone();
            let request = request.clone();
            std::thread::spawn(move || runtime.run_tool(&ToolCallContext::future_cli(), request))
        };
        follower_gate.0.wait();
        follower_gate.1.wait();
        execution_gate.release();
        assert!(leader.join().is_err());
        assert_eq!(
            follower.join().unwrap().unwrap_err().code,
            "tool-execution-aborted"
        );
        let after_abort = runtime.request_cache_snapshot();
        assert_eq!(after_abort.entries, 0);
        assert_eq!(after_abort.retained_bytes, 0);

        assert!(runtime
            .run_tool(&ToolCallContext::future_cli(), request)
            .is_ok());
    }

    #[test]
    fn cancelled_leader_scope_uses_the_same_abort_safe_cleanup() {
        let (runtime, _, vault) = runtime_with_vault("leader-cancel");
        let request = ToolRunRequest {
            tool_id: "knowledge.create".to_string(),
            input: json!({
                "expectedVaultId":vault.id,
                "relativePath":"Cancelled retry.md",
                "content":"retry after cancellation",
                "requestId":"leader-cancel-retry"
            }),
            request_id: None,
        };
        set_leader_abort_hook(&CANCEL_LEADER_FOR, "leader-cancel-retry");
        assert_eq!(
            runtime
                .run_tool(&ToolCallContext::future_cli(), request.clone())
                .unwrap_err()
                .code,
            "tool-execution-aborted"
        );
        let after_cancel = runtime.request_cache_snapshot();
        assert_eq!(after_cancel.entries, 0);
        assert_eq!(after_cancel.retained_bytes, 0);
        assert!(runtime
            .run_tool(&ToolCallContext::future_cli(), request)
            .is_ok());
    }

    #[test]
    fn stale_reservation_guard_cannot_remove_a_replacement_slot() {
        let requests = Arc::new(Mutex::new(RequestState::default()));
        let key = RequestKey {
            tool_id: "knowledge.create".to_string(),
            principal_digest: [7; 32],
            request_id: "stale-guard".to_string(),
        };
        let old_result = Arc::new((Mutex::new(None), Condvar::new()));
        let old_slot = RequestSlot {
            input_digest: [1; 32],
            inflight_started_at: Instant::now(),
            settled_at: None,
            retained_bytes: 10,
            result: old_result.clone(),
        };
        requests
            .lock()
            .unwrap()
            .entries
            .insert(key.clone(), old_slot);
        requests.lock().unwrap().retained_bytes = 10;
        let guard = ReservationGuard::new(requests.clone(), key.clone(), old_result);
        let replacement_result = Arc::new((Mutex::new(None), Condvar::new()));
        let replacement = RequestSlot {
            input_digest: [2; 32],
            inflight_started_at: Instant::now(),
            settled_at: None,
            retained_bytes: 20,
            result: replacement_result.clone(),
        };
        {
            let mut state = requests.lock().unwrap();
            state.entries.insert(key.clone(), replacement);
            state.retained_bytes = 20;
        }
        drop(guard);
        let state = requests.lock().unwrap();
        assert!(state
            .entries
            .get(&key)
            .is_some_and(|slot| Arc::ptr_eq(&slot.result, &replacement_result)));
        assert_eq!(state.retained_bytes, 20);
    }

    #[test]
    fn cached_capability_result_rechecks_live_availability() {
        let (runtime, controller, vault) = runtime_with_vault("capability-availability");
        let request = ToolRunRequest {
            tool_id: "capability.run".to_string(),
            input: json!({
                "capabilityId":"skill.summary",
                "expectedVaultId":vault.id,
                "sourceMode":"headless",
                "input":{"text":"availability must be rechecked"},
                "requestId":"capability-availability"
            }),
            request_id: None,
        };
        let first = runtime
            .run_tool(&ToolCallContext::future_cli(), request.clone())
            .unwrap();
        controller
            .open_write()
            .unwrap()
            .execute(
                "UPDATE local_capability SET enabled = 0 WHERE id = 'skill.summary'",
                [],
            )
            .unwrap();
        assert_eq!(
            runtime
                .run_tool(&ToolCallContext::future_cli(), request.clone())
                .unwrap_err()
                .code,
            "capability-disabled"
        );
        controller
            .open_write()
            .unwrap()
            .execute(
                "UPDATE local_capability SET enabled = 1 WHERE id = 'skill.summary'",
                [],
            )
            .unwrap();
        let replay = runtime
            .run_tool(&ToolCallContext::future_cli(), request)
            .unwrap();
        assert_eq!(first, replay);
    }

    #[test]
    fn capability_write_rechecks_vault_after_a_slow_run() {
        let (backend, vault_a) = backend_with_vault("switch-a");
        let root_b = temp_dir("switch-b-vault");
        fs::create_dir_all(root_b.join(".luckyray")).unwrap();
        let vault_b = KnowledgeVaultRegistration {
            id: "vault-switch-b".to_string(),
            name: "Switch B".to_string(),
            root_path: root_b.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            root_b.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault_b).unwrap(),
        )
        .unwrap();
        let barrier = crate::capabilities::block_before_capability_create("Slow page");
        let backend = Arc::new(backend);
        let runner = {
            let backend = backend.clone();
            let vault_id = vault_a.id.clone();
            std::thread::spawn(move || {
                backend.run_tool(
                    &ToolCallContext::future_cli(),
                    ToolRunRequest {
                        tool_id: "capability.run".to_string(),
                        input: json!({
                            "capabilityId":"wf.web_to_note",
                            "expectedVaultId":vault_id,
                            "sourceMode":"headless",
                            "input":{"title":"Slow page","content":"must not cross vaults"},
                            "requestId":"slow-capability"
                        }),
                        request_id: None,
                    },
                )
            })
        };
        barrier.0.wait();
        backend
            .knowledge()
            .register_current_vault(&vault_b)
            .unwrap();
        barrier.1.wait();
        assert_eq!(
            runner.join().unwrap().unwrap_err().code,
            "knowledge-vault-not-current"
        );
        assert!(!std::path::Path::new(&vault_a.root_path)
            .join("Slow page.md")
            .exists());
        assert!(!root_b.join("Slow page.md").exists());
    }

    #[test]
    fn read_tags_and_capability_use_existing_services() {
        let (backend, vault) = backend_with_vault("delegation");
        let created = backend
            .knowledge()
            .create_document(&KnowledgeCreateInput {
                title: "Delegated.md".to_string(),
                parent_relative_path: None,
                content: "# Delegated\n\nSEARCHABLE-TEXT".to_string(),
            })
            .unwrap();
        let id = crate::knowledge::KnowledgeService::document_id(&created.summary.document_ref);
        let context = ToolCallContext::future_cli();
        let read = backend
            .run_tool(
                &context,
                ToolRunRequest {
                    tool_id: "knowledge.read".to_string(),
                    input: json!({"id":id}),
                    request_id: None,
                },
            )
            .unwrap();
        assert_eq!(read.result["content"], "# Delegated\n\nSEARCHABLE-TEXT");
        let tags = backend
            .run_tool(
                &context,
                ToolRunRequest {
                    tool_id: "knowledge.set_tags".to_string(),
                    input: json!({
                        "documentRef":created.summary.document_ref,
                        "expectedVaultId":vault.id,
                        "expectedRevision":created.revision,
                        "tags":["registry"],
                        "requestId":"tags-1"
                    }),
                    request_id: None,
                },
            )
            .unwrap();
        assert_eq!(tags.result["committed"], true);
        let capability = backend
            .run_tool(
                &context,
                ToolRunRequest {
                    tool_id: "capability.run".to_string(),
                    input: json!({
                        "capabilityId":"skill.search_intent",
                        "expectedVaultId":vault.id,
                        "sourceMode":"headless",
                        "input":{"query":"SEARCHABLE-TEXT","scope":"notes","limit":5},
                        "requestId":"capability-1"
                    }),
                    request_id: None,
                },
            )
            .unwrap();
        assert_eq!(capability.result["capabilityId"], "skill.search_intent");
        assert_eq!(
            capability.result["result"]["documents"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let disabled = backend.run_tool(
            &context,
            ToolRunRequest {
                tool_id: "capability.run".to_string(),
                input: json!({
                    "capabilityId":"wf.note_to_summary",
                    "expectedVaultId":vault.id,
                    "sourceMode":"headless",
                    "input":{"documentRef":created.summary.document_ref},
                    "requestId":"capability-disabled"
                }),
                request_id: None,
            },
        );
        assert_eq!(disabled.unwrap_err().code, "capability-disabled");
    }

    #[test]
    fn material_results_never_expose_local_paths() {
        let (backend, _) = backend_with_vault("materials-safe");
        let result = backend
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "materials.search".to_string(),
                    input: json!({"query":"","limit":5}),
                    request_id: None,
                },
            )
            .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("libraryPath"));
        assert!(!serialized.contains("originalPath"));
    }

    #[test]
    fn schema_rejects_unknown_depth_and_oversized_input() {
        let (backend, _) = backend_with_vault("schema");
        let context = ToolCallContext::future_cli();
        let unknown = backend.run_tool(
            &context,
            ToolRunRequest {
                tool_id: "knowledge.search".to_string(),
                input: json!({"query":"x","unknown":true}),
                request_id: None,
            },
        );
        assert_eq!(unknown.unwrap_err().code, "tool-input-invalid");
        let mut nested = json!({});
        for _ in 0..20 {
            nested = json!({"value":nested});
        }
        let too_deep = backend.run_tool(
            &context,
            ToolRunRequest {
                tool_id: "capability.run".to_string(),
                input: json!({
                    "capabilityId":"skill.summary",
                    "expectedVaultId":"vault-schema",
                    "sourceMode":"headless",
                    "input":nested,
                    "requestId":"deep"
                }),
                request_id: None,
            },
        );
        assert_eq!(too_deep.unwrap_err().code, "tool-input-invalid");

        let path_control = backend.run_tool(
            &context,
            ToolRunRequest {
                tool_id: "knowledge.create".to_string(),
                input: json!({
                    "expectedVaultId":"vault-schema",
                    "relativePath":"Bad\u{0001}.md",
                    "content":"x",
                    "requestId":"control-path"
                }),
                request_id: None,
            },
        );
        assert_eq!(path_control.unwrap_err().code, "tool-input-invalid");
    }

    #[test]
    fn memory_write_references_are_backend_bound_per_run_before_any_approval_or_write() {
        let app_data = temp_dir("memory-reference-binding");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let entry = backend
            .memory()
            .create(crate::agent_memory::MemoryCreateInput {
                content: "bound memory fixture".to_owned(),
                scope: crate::agent_memory::MemoryScope::global(),
                importance: None,
                ttl_seconds: None,
                source: Some("agent-approved".to_owned()),
            })
            .unwrap();
        let owner_bindings = Arc::new(crate::agent_memory::MemoryRunBindings::default());
        let projected =
            crate::agent_memory::project_memory_agent_entry(&entry, owner_bindings.as_ref());
        let forged_context = ToolCallContext::agent_read([41; 32])
            .with_memory_bindings(Arc::new(crate::agent_memory::MemoryRunBindings::default()));
        let forged = backend
            .prepare_agent_write(
                &forged_context,
                ToolRunRequest::agent_write(
                    "memory.update".to_owned(),
                    json!({
                        "memoryRef":projected.memory_ref,
                        "content":"must not write",
                        "requestId":"memory-forged-cross-run"
                    }),
                ),
                AgentWriteScope::new(
                    "memory-forged-turn".to_owned(),
                    "memory-forged-session".to_owned(),
                    "memory-forged-engine-turn".to_owned(),
                    "memory-forged-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap_err();
        assert_eq!(forged.code, "memory-reference-invalid");
        let same_run_context =
            ToolCallContext::agent_read([42; 32]).with_memory_bindings(owner_bindings.clone());
        let fabricated = backend
            .prepare_agent_write(
                &same_run_context,
                ToolRunRequest::agent_write(
                    "memory.delete".to_owned(),
                    json!({
                        "memoryRef":"memory-ref-fabricated",
                        "requestId":"memory-fabricated"
                    }),
                ),
                AgentWriteScope::new(
                    "memory-fabricated-turn".to_owned(),
                    "memory-fabricated-session".to_owned(),
                    "memory-fabricated-engine-turn".to_owned(),
                    "memory-fabricated-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap_err();
        assert_eq!(fabricated.code, "memory-reference-invalid");
        let unchanged = backend.memory().get(&entry.id).unwrap().unwrap();
        assert_eq!(unchanged.content, "bound memory fixture");
        assert_eq!(unchanged.revision, entry.revision);

        struct ApproveOnce;
        impl AgentWritePermit for ApproveOnce {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                Ok(())
            }
        }
        // A successful approved update must rotate the model-facing reference
        // before returning its observation. The original reference may never
        // reach a second approval, even though it names the same durable row.
        let initial_ref = projected.memory_ref.clone();
        let rotation_context =
            ToolCallContext::agent_read([43; 32]).with_memory_bindings(owner_bindings.clone());
        let rotate_prepared = backend
            .prepare_agent_write(
                &rotation_context,
                ToolRunRequest::agent_write(
                    "memory.update".to_owned(),
                    json!({
                        "memoryRef":initial_ref.clone(),
                        "content":"fresh bound memory",
                        "requestId":"memory-rotate-reference"
                    }),
                ),
                AgentWriteScope::new(
                    "memory-rotate-turn".to_owned(),
                    "memory-rotate-session".to_owned(),
                    "memory-rotate-engine-turn".to_owned(),
                    "memory-rotate-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        let rotated = backend
            .run_prepared_agent_write(&rotation_context, rotate_prepared, &ApproveOnce)
            .unwrap();
        let rotated_ref = rotated
            .result()
            .get("memoryRef")
            .and_then(Value::as_str)
            .expect("approved update returns a replacement reference")
            .to_owned();
        assert_ne!(rotated_ref, initial_ref);
        for (tool_id, input) in [
            (
                "memory.update",
                json!({
                    "memoryRef":initial_ref.clone(),
                    "content":"old reference must not update",
                    "requestId":"memory-old-reference-update"
                }),
            ),
            (
                "memory.delete",
                json!({
                    "memoryRef":initial_ref.clone(),
                    "requestId":"memory-old-reference-delete"
                }),
            ),
        ] {
            let error = backend
                .prepare_agent_write(
                    &rotation_context,
                    ToolRunRequest::agent_write(tool_id.to_owned(), input),
                    AgentWriteScope::new(
                        format!("memory-old-reference-{tool_id}-turn"),
                        format!("memory-old-reference-{tool_id}-session"),
                        format!("memory-old-reference-{tool_id}-engine-turn"),
                        format!("memory-old-reference-{tool_id}-call"),
                        1,
                        0,
                    ),
                )
                .unwrap_err();
            assert_eq!(error.code, "memory-reference-invalid");
        }
        for (tool_id, input) in [
            (
                "memory.update",
                json!({
                    "memoryRef":rotated_ref.clone(),
                    "content":"replacement reference stays usable",
                    "requestId":"memory-replacement-update"
                }),
            ),
            (
                "memory.delete",
                json!({
                    "memoryRef":rotated_ref.clone(),
                    "requestId":"memory-replacement-delete"
                }),
            ),
        ] {
            backend
                .prepare_agent_write(
                    &rotation_context,
                    ToolRunRequest::agent_write(tool_id.to_owned(), input),
                    AgentWriteScope::new(
                        format!("memory-replacement-{tool_id}-turn"),
                        format!("memory-replacement-{tool_id}-session"),
                        format!("memory-replacement-{tool_id}-engine-turn"),
                        format!("memory-replacement-{tool_id}-call"),
                        1,
                        0,
                    ),
                )
                .expect("the replacement reference must remain approval-eligible");
        }
        let rotated_entry = backend.memory().get(&entry.id).unwrap().unwrap();
        assert_eq!(rotated_entry.content, "fresh bound memory");
        let stale_context =
            ToolCallContext::agent_read([43; 32]).with_memory_bindings(owner_bindings.clone());
        let prepared = backend
            .prepare_agent_write(
                &stale_context,
                ToolRunRequest::agent_write(
                    "memory.update".to_owned(),
                    json!({
                        "memoryRef":rotated_ref.clone(),
                        "content":"stale overwrite",
                        "requestId":"memory-stale-reference"
                    }),
                ),
                AgentWriteScope::new(
                    "memory-stale-turn".to_owned(),
                    "memory-stale-session".to_owned(),
                    "memory-stale-engine-turn".to_owned(),
                    "memory-stale-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        let external = backend
            .memory()
            .update(crate::agent_memory::MemoryUpdateInput {
                id: entry.id.clone(),
                expected_revision: rotated_entry.revision,
                content: "external winner".to_owned(),
                source: None,
                importance: None,
                ttl_seconds: None,
                replace_source: false,
                preserve_expiry: true,
            })
            .unwrap();
        let stale = backend
            .run_prepared_agent_write(&stale_context, prepared, &ApproveOnce)
            .unwrap_err();
        assert_eq!(stale.code, "memory-revision-conflict");
        let after_stale = backend.memory().get(&entry.id).unwrap().unwrap();
        assert_eq!(after_stale.revision, external.revision);
        assert_eq!(after_stale.content, "external winner");

        let current_projection =
            crate::agent_memory::project_memory_agent_entry(&external, owner_bindings.as_ref());
        let delete_prepared = backend
            .prepare_agent_write(
                &rotation_context,
                ToolRunRequest::agent_write(
                    "memory.delete".to_owned(),
                    json!({
                        "memoryRef":current_projection.memory_ref.clone(),
                        "requestId":"memory-delete-all-references"
                    }),
                ),
                AgentWriteScope::new(
                    "memory-delete-turn".to_owned(),
                    "memory-delete-session".to_owned(),
                    "memory-delete-engine-turn".to_owned(),
                    "memory-delete-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        backend
            .run_prepared_agent_write(&rotation_context, delete_prepared, &ApproveOnce)
            .unwrap();
        assert!(backend.memory().get(&entry.id).unwrap().is_none());
        for (index, memory_ref) in [initial_ref, rotated_ref, current_projection.memory_ref]
            .into_iter()
            .enumerate()
        {
            let error = backend
                .prepare_agent_write(
                    &rotation_context,
                    ToolRunRequest::agent_write(
                        "memory.delete".to_owned(),
                        json!({
                            "memoryRef":memory_ref,
                            "requestId":format!("memory-deleted-reference-{index}")
                        }),
                    ),
                    AgentWriteScope::new(
                        format!("memory-deleted-reference-{index}-turn"),
                        format!("memory-deleted-reference-{index}-session"),
                        format!("memory-deleted-reference-{index}-engine-turn"),
                        format!("memory-deleted-reference-{index}-call"),
                        1,
                        0,
                    ),
                )
                .unwrap_err();
            assert_eq!(error.code, "memory-reference-invalid");
        }

        let definition = r6_agent_definitions(false)
            .into_iter()
            .find(|definition| definition.id == "memory.update")
            .expect("memory update definition");
        let properties = definition
            .input_schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("memory update schema properties");
        assert!(properties.contains_key("memoryRef"));
        assert!(!properties.contains_key("id"));
        assert!(!properties.contains_key("expectedRevision"));
        assert!(definition.description.contains("opaque memoryRef"));
        let search_definition = r6_agent_definitions(false)
            .into_iter()
            .find(|definition| definition.id == "memory.search")
            .expect("memory search definition");
        assert!(search_definition
            .description
            .contains("literal keyword matching"));
    }

    #[test]
    fn material_import_schema_rejects_internal_grant_id_override() {
        let definition = r6_agent_definitions(false)
            .into_iter()
            .find(|definition| definition.id == "materials.import_from_grant")
            .expect("materials import definition");
        let safe_input = json!({
            "grantAlias":"Import Source",
            "relativePath":"from-workspace.md",
            "folderId":Value::Null,
            "requestId":"request-safe"
        });
        validate_schema(&definition.input_schema, &safe_input, "input")
            .expect("safe alias input must remain valid");

        let forged_internal_id = json!({
            "grantAlias":"Import Source",
            "grantId":"wsg-forged",
            "relativePath":"from-workspace.md",
            "folderId":Value::Null,
            "requestId":"request-safe"
        });
        assert_eq!(
            validate_schema(&definition.input_schema, &forged_internal_id, "input")
                .expect_err("the model must not be able to override an internal grant id")
                .code,
            "tool-input-invalid"
        );
    }

    #[test]
    fn controlled_execution_is_project_task_only_recipe_bound_and_approval_gated() {
        struct ApproveOnce(AtomicUsize);
        impl AgentWritePermit for ApproveOnce {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }

        struct RejectPermit(AtomicUsize);
        impl AgentWritePermit for RejectPermit {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(ToolError::new(
                    "agent-write-permit-invalid",
                    "Approval permit is not valid",
                ))
            }
        }

        let app_data = temp_dir("controlled-execution-app");
        let workspace_root = temp_dir("controlled-execution-project");
        fs::write(
            workspace_root.join("package.json"),
            b"\xef\xbb\xbf{\"name\":\"safe-project\"}",
        )
        .unwrap();
        let mut backend = BackendServices::initialize(&app_data).unwrap();
        let (catalog, launches) = crate::agent_execution::ExecutionRecipeCatalog::with_fixture(
            crate::agent_execution::ExecutionRunObservation::try_new(
                crate::agent_execution::ExecutionStatus::Passed,
                Some(crate::agent_execution::ManifestName::PackageJson),
                crate::agent_execution::ExecutionReason::Valid,
            )
            .unwrap(),
        );
        backend.set_execution_catalog(catalog);
        let grant = backend
            .workspace()
            .add(&workspace_root, "Safe Project")
            .unwrap();
        let aliases = backend.workspace().build_aliases().unwrap();
        let base = ToolCallContext::agent_read([91; 32]);
        let project_snapshot = backend
            .agent_capabilities()
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::ProjectTask,
                "检查授权项目",
                backend.list_tools(&base).unwrap(),
            )
            .unwrap();
        let standard_snapshot = backend
            .agent_capabilities()
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::Standard,
                "普通对话",
                backend.list_tools(&base).unwrap(),
            )
            .unwrap();
        assert!(project_snapshot
            .tools
            .iter()
            .any(|tool| tool.id == "execution.run"));
        assert!(standard_snapshot
            .tools
            .iter()
            .all(|tool| !tool.id.starts_with("execution.")));

        let bindings = Arc::new(crate::agent_execution::ExecutionRunBindings::default());
        let context = base
            .with_agent_run(
                "execution-project-conversation".to_owned(),
                Arc::new(project_snapshot),
            )
            .with_workspace_aliases(Arc::new(aliases))
            .with_execution_bindings(bindings);
        let listed = backend
            .run_tool(
                &context,
                ToolRunRequest::read(
                    "execution.list".to_owned(),
                    json!({"grantAlias":"Safe Project"}),
                ),
            )
            .unwrap()
            .result()
            .clone();
        let recipe_ref = listed[0]["recipeRef"]
            .as_str()
            .expect("one opaque run-bound recipe ref")
            .to_owned();
        let listed_json = serde_json::to_string(&listed).unwrap();
        for forbidden in [
            grant.id.as_str(),
            workspace_root.to_string_lossy().as_ref(),
            "Cargo.toml",
            "manifestDigest",
            "executable",
            "arguments",
            "workingDirectory",
            "environment",
        ] {
            assert!(
                !listed_json.contains(forbidden),
                "execution observation leaked {forbidden}: {listed_json}"
            );
        }

        let authority_prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":recipe_ref.clone(),"requestId":"authority-before-permit"}),
                ),
                AgentWriteScope::new(
                    "execution-authority-turn".to_owned(),
                    "execution-authority-session".to_owned(),
                    "execution-authority-engine-turn".to_owned(),
                    "execution-authority-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        backend.workspace().set_enabled(&grant.id, false).unwrap();
        let authority_permit = ApproveOnce(AtomicUsize::new(0));
        let authority_error = backend
            .run_prepared_agent_write(&context, authority_prepared, &authority_permit)
            .unwrap_err();
        assert_eq!(authority_error.code, "tool-unavailable");
        assert_eq!(
            authority_error.execution_dispatch_disposition,
            Some(crate::agent_execution::ExecutionDispatchDisposition::NotAdmitted),
            "current-authority failures before permit consumption are proven not admitted"
        );
        assert_eq!(authority_permit.0.load(Ordering::SeqCst), 0);
        assert_eq!(launches.load(Ordering::SeqCst), 0);
        backend.workspace().set_enabled(&grant.id, true).unwrap();

        let invalid_permit_prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":recipe_ref.clone(),"requestId":"invalid-permit-before-admission"}),
                ),
                AgentWriteScope::new(
                    "execution-invalid-permit-turn".to_owned(),
                    "execution-invalid-permit-session".to_owned(),
                    "execution-invalid-permit-engine-turn".to_owned(),
                    "execution-invalid-permit-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        let invalid_permit = RejectPermit(AtomicUsize::new(0));
        let invalid_permit_error = backend
            .run_prepared_agent_write(&context, invalid_permit_prepared, &invalid_permit)
            .unwrap_err();
        assert_eq!(invalid_permit_error.code, "agent-write-permit-invalid");
        assert_eq!(
            invalid_permit_error.execution_dispatch_disposition,
            Some(crate::agent_execution::ExecutionDispatchDisposition::NotAdmitted)
        );
        assert_eq!(invalid_permit.0.load(Ordering::SeqCst), 1);
        assert_eq!(launches.load(Ordering::SeqCst), 0);

        let forged = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":"recipe-ref-forged","requestId":"forged-recipe"}),
                ),
                AgentWriteScope::new(
                    "execution-forged-turn".to_owned(),
                    "execution-forged-session".to_owned(),
                    "execution-forged-engine-turn".to_owned(),
                    "execution-forged-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap_err();
        assert_eq!(forged.code, "execution-recipe-invalid");
        assert_eq!(launches.load(Ordering::SeqCst), 0);

        let cancelled_prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":recipe_ref.clone(),"requestId":"cancelled-before-permit"}),
                ),
                AgentWriteScope::new(
                    "execution-cancelled-turn".to_owned(),
                    "execution-cancelled-session".to_owned(),
                    "execution-cancelled-engine-turn".to_owned(),
                    "execution-cancelled-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        let cancelled_permit = ApproveOnce(AtomicUsize::new(0));
        let cancelled_error = backend
            .run_prepared_agent_write_with_cancel(
                &context,
                cancelled_prepared,
                &cancelled_permit,
                &|| true,
            )
            .unwrap_err();
        assert_eq!(cancelled_error.code, "execution-not-started");
        assert_eq!(
            cancelled_error.execution_dispatch_disposition,
            Some(crate::agent_execution::ExecutionDispatchDisposition::NotAdmitted)
        );
        assert_eq!(cancelled_permit.0.load(Ordering::SeqCst), 0);
        assert_eq!(launches.load(Ordering::SeqCst), 0);

        let stopped_listed = backend
            .run_tool(
                &context,
                ToolRunRequest::read(
                    "execution.list".to_owned(),
                    json!({"grantAlias":"Safe Project"}),
                ),
            )
            .unwrap()
            .result()
            .clone();
        let stopped_ref = stopped_listed[0]["recipeRef"].as_str().unwrap().to_owned();
        let stopped_prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":stopped_ref,"requestId":"stopped-after-permit"}),
                ),
                AgentWriteScope::new(
                    "execution-stopped-turn".to_owned(),
                    "execution-stopped-session".to_owned(),
                    "execution-stopped-engine-turn".to_owned(),
                    "execution-stopped-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        let stopped_permit = ApproveOnce(AtomicUsize::new(0));
        let cancellation_polls = AtomicUsize::new(0);
        let stopped = backend
            .run_prepared_agent_write_with_cancel(
                &context,
                stopped_prepared,
                &stopped_permit,
                &|| cancellation_polls.fetch_add(1, Ordering::SeqCst) > 0,
            )
            .unwrap();
        assert_eq!(stopped.result()["status"], "not-run");
        assert_eq!(stopped.result()["reason"], "not-started");
        assert_eq!(stopped_permit.0.load(Ordering::SeqCst), 1);
        assert_eq!(launches.load(Ordering::SeqCst), 0);

        let prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":recipe_ref.clone(),"requestId":"approved-check"}),
                ),
                AgentWriteScope::new(
                    "execution-approved-turn".to_owned(),
                    "execution-approved-session".to_owned(),
                    "execution-approved-engine-turn".to_owned(),
                    "execution-approved-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        assert_eq!(
            launches.load(Ordering::SeqCst),
            0,
            "approval precedes process launch"
        );
        let permit = ApproveOnce(AtomicUsize::new(0));
        let result = backend
            .run_prepared_agent_write(&context, prepared, &permit)
            .unwrap();
        assert_eq!(result.result()["status"], "passed");
        assert_eq!(
            result.result()["summary"],
            "项目清单检查已通过（package.json）。"
        );
        assert_eq!(permit.0.load(Ordering::SeqCst), 1);
        assert_eq!(
            launches.load(Ordering::SeqCst),
            1,
            "approved check launches exactly once"
        );

        let unknown_listed = backend
            .run_tool(
                &context,
                ToolRunRequest::read(
                    "execution.list".to_owned(),
                    json!({"grantAlias":"Safe Project"}),
                ),
            )
            .unwrap()
            .result()
            .clone();
        let unknown_ref = unknown_listed[0]["recipeRef"].as_str().unwrap().to_owned();
        let unknown_prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":unknown_ref.clone(),"requestId":"unknown-after-admission"}),
                ),
                AgentWriteScope::new(
                    "execution-unknown-turn".to_owned(),
                    "execution-unknown-session".to_owned(),
                    "execution-unknown-engine-turn".to_owned(),
                    "execution-unknown-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        context.consume_execution_binding(&unknown_ref).unwrap();
        let unknown_permit = ApproveOnce(AtomicUsize::new(0));
        let unknown_error = backend
            .run_prepared_agent_write(&context, unknown_prepared, &unknown_permit)
            .unwrap_err();
        assert_eq!(
            unknown_error.execution_dispatch_disposition,
            Some(crate::agent_execution::ExecutionDispatchDisposition::UnknownAfterAdmission)
        );
        assert_eq!(unknown_permit.0.load(Ordering::SeqCst), 1);
        assert_eq!(launches.load(Ordering::SeqCst), 1);

        let duplicate = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":recipe_ref,"requestId":"duplicate-check"}),
                ),
                AgentWriteScope::new(
                    "execution-duplicate-turn".to_owned(),
                    "execution-duplicate-session".to_owned(),
                    "execution-duplicate-engine-turn".to_owned(),
                    "execution-duplicate-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap_err();
        assert_eq!(duplicate.code, "execution-recipe-invalid");
        assert_eq!(
            launches.load(Ordering::SeqCst),
            1,
            "duplicate approval cannot replay"
        );
    }

    #[test]
    fn execution_source_switch_before_permit_is_typed_not_admitted() {
        struct CountingPermit(AtomicUsize);

        impl AgentWritePermit for CountingPermit {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }

        let (mut backend, vault) = backend_with_vault("execution-source-before-permit");
        let workspace_root = temp_dir("execution-source-before-permit-project");
        fs::write(workspace_root.join("package.json"), r#"{"name":"fixture"}"#).unwrap();
        let (catalog, launches) = crate::agent_execution::ExecutionRecipeCatalog::with_fixture(
            crate::agent_execution::ExecutionRunObservation::try_new(
                crate::agent_execution::ExecutionStatus::Passed,
                Some(crate::agent_execution::ManifestName::PackageJson),
                crate::agent_execution::ExecutionReason::Valid,
            )
            .unwrap(),
        );
        backend.set_execution_catalog(catalog);
        let grant = backend
            .workspace()
            .add(&workspace_root, "Source Project")
            .unwrap();
        let aliases = backend.workspace().build_aliases().unwrap();
        let activation = backend.knowledge().activate_ui_source(&vault.id).unwrap();
        let base = ToolCallContext::agent_read([92; 32]);
        let snapshot = backend
            .agent_capabilities()
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::ProjectTask,
                "检查授权项目",
                backend.list_tools(&base).unwrap(),
            )
            .unwrap();
        let context = base
            .with_agent_run(
                "execution-source-conversation".to_owned(),
                Arc::new(snapshot),
            )
            .with_workspace_aliases(Arc::new(aliases))
            .with_workspace_source(Some(activation.clone()))
            .with_execution_bindings(Arc::new(
                crate::agent_execution::ExecutionRunBindings::default(),
            ));
        let listed = backend
            .run_tool(
                &context,
                ToolRunRequest::read(
                    "execution.list".to_owned(),
                    json!({"grantAlias":"Source Project"}),
                ),
            )
            .unwrap()
            .result()
            .clone();
        let recipe_ref = listed[0]["recipeRef"].as_str().unwrap().to_owned();
        let prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":recipe_ref,"requestId":"source-before-permit"}),
                ),
                AgentWriteScope::new(
                    "execution-source-turn".to_owned(),
                    "execution-source-session".to_owned(),
                    "execution-source-engine-turn".to_owned(),
                    "execution-source-call".to_owned(),
                    1,
                    activation.source_epoch,
                ),
            )
            .unwrap();
        backend.knowledge().deactivate_ui_source().unwrap();
        let permit = CountingPermit(AtomicUsize::new(0));
        let error = backend
            .run_prepared_agent_write(&context, prepared, &permit)
            .unwrap_err();
        assert_eq!(error.code, "knowledge-source-inactive");
        assert_eq!(
            error.execution_dispatch_disposition,
            Some(crate::agent_execution::ExecutionDispatchDisposition::NotAdmitted),
            "an inactive source before permit consumption is proven not admitted"
        );
        assert_eq!(permit.0.load(Ordering::SeqCst), 0);
        assert_eq!(launches.load(Ordering::SeqCst), 0);
        assert!(grant.enabled);
    }

    /// This is intentionally separate from the fixture-backed policy test
    /// above: it drives the real registered Tauri externalBin through the
    /// production ToolRegistry and approval/permit seam. A current Cargo
    /// target/debug sidecar would not satisfy this contract.
    #[cfg(windows)]
    #[test]
    fn registered_execution_sidecar_runs_only_after_approval_and_matches_the_fixed_recipe() {
        struct ApproveOnce(AtomicUsize);
        impl AgentWritePermit for ApproveOnce {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }

        let app_data = temp_dir("registered-execution-sidecar-app");
        let workspace_root = temp_dir("registered-execution-sidecar-project");
        fs::write(
            workspace_root.join("package.json"),
            r#"{"name":"safe-project"}"#,
        )
        .unwrap();
        let resource_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let (catalog, launches) =
            crate::agent_execution::ExecutionRecipeCatalog::app_owned_with_launch_counter_for_test(
                &resource_dir,
            );
        let target = option_env!("LUCKYRAY_BUILD_TARGET").expect("build target is exported");
        assert_eq!(
            catalog
                .executable_for_test()
                .and_then(|path| path.file_name())
                .and_then(|name| name.to_str()),
            Some(format!("luckyray-cli-{target}.exe").as_str()),
            "the production service must resolve Tauri's exact registered externalBin"
        );

        let mut backend = BackendServices::initialize(&app_data).unwrap();
        backend.set_execution_catalog(catalog);
        backend
            .workspace()
            .add(&workspace_root, "Safe Project")
            .unwrap();
        let aliases = backend.workspace().build_aliases().unwrap();
        let base = ToolCallContext::agent_read([92; 32]);
        let snapshot = backend
            .agent_capabilities()
            .build_snapshot(
                crate::agent_capabilities::CapabilityProfile::ProjectTask,
                "检查授权项目",
                backend.list_tools(&base).unwrap(),
            )
            .unwrap();
        let context = base
            .with_agent_run(
                "registered-execution-project-conversation".to_owned(),
                Arc::new(snapshot),
            )
            .with_workspace_aliases(Arc::new(aliases))
            .with_execution_bindings(Arc::new(
                crate::agent_execution::ExecutionRunBindings::default(),
            ));
        let listed = backend
            .run_tool(
                &context,
                ToolRunRequest::read(
                    "execution.list".to_owned(),
                    json!({"grantAlias":"Safe Project"}),
                ),
            )
            .unwrap()
            .result()
            .clone();
        let recipe_ref = listed[0]["recipeRef"]
            .as_str()
            .expect("registered production recipe is opaque and run-bound")
            .to_owned();
        let prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "execution.run".to_owned(),
                    json!({"recipeRef":recipe_ref,"requestId":"registered-sidecar-check"}),
                ),
                AgentWriteScope::new(
                    "registered-sidecar-turn".to_owned(),
                    "registered-sidecar-session".to_owned(),
                    "registered-sidecar-engine-turn".to_owned(),
                    "registered-sidecar-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        assert_eq!(
            launches.load(Ordering::SeqCst),
            0,
            "no registered sidecar process may spawn before approval"
        );
        let permit = ApproveOnce(AtomicUsize::new(0));
        let result = backend
            .run_prepared_agent_write(&context, prepared, &permit)
            .unwrap();
        assert_eq!(result.result()["status"], "passed");
        assert_eq!(permit.0.load(Ordering::SeqCst), 1);
        assert_eq!(
            launches.load(Ordering::SeqCst),
            1,
            "the fixed registered sidecar spawns exactly once after approval"
        );
    }

    #[test]
    fn no_vault_and_large_read_fail_with_stable_codes() {
        let app_data = temp_dir("no-vault-app");
        let no_vault = BackendServices::initialize(&app_data).unwrap();
        let error = no_vault
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.search".to_string(),
                    input: json!({"query":""}),
                    request_id: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "knowledge-vault-required");

        let (backend, _) = backend_with_vault("large-read");
        let created = backend
            .knowledge()
            .create_document(&KnowledgeCreateInput {
                title: "Large.md".to_string(),
                parent_relative_path: None,
                content: "x".repeat(MAX_READ_CONTENT_BYTES + 1),
            })
            .unwrap();
        let error = backend
            .run_tool(
                &ToolCallContext::future_cli(),
                ToolRunRequest {
                    tool_id: "knowledge.read".to_string(),
                    input: json!({"documentRef":created.summary.document_ref}),
                    request_id: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "tool-output-too-large");
    }

    #[test]
    fn project_knowledge_scope_filters_discovery_and_dispatch_before_query() {
        let (backend, vault) = backend_with_vault("project-knowledge-tool-scope");
        let target = backend.knowledge().current_target_identity().unwrap();
        let denied = ToolCallContext::agent_read([93; 32])
            .with_knowledge_scope(Arc::new(crate::knowledge::KnowledgeRunScope::empty()));
        let denied_tools = backend.list_tools(&denied).unwrap();
        assert!(denied_tools.iter().all(|tool| {
            !matches!(
                tool.id(),
                "knowledge.search" | "knowledge.read" | "capability.run"
            )
        }));
        assert!(denied_tools
            .iter()
            .any(|tool| tool.id() == "workspace.list"));
        assert_eq!(
            backend
                .run_tool(
                    &denied,
                    ToolRunRequest::read(
                        "knowledge.search".to_owned(),
                        json!({"query":"must-not-query"}),
                    ),
                )
                .unwrap_err()
                .code,
            "tool-not-found"
        );

        let allowed = ToolCallContext::agent_read([94; 32]).with_knowledge_scope(Arc::new(
            crate::knowledge::KnowledgeRunScope::for_target(target),
        ));
        let allowed_tools = backend.list_tools(&allowed).unwrap();
        assert!(allowed_tools
            .iter()
            .any(|tool| tool.id() == "knowledge.search"));
        assert!(allowed_tools
            .iter()
            .any(|tool| tool.id() == "knowledge.read"));

        let switched_root = temp_dir("project-knowledge-tool-scope-switched");
        std::fs::create_dir_all(switched_root.join(".luckyray")).unwrap();
        let switched = crate::knowledge::KnowledgeVaultRegistration {
            id: "vault-project-scope-switched".to_owned(),
            name: "Switched Knowledge".to_owned(),
            root_path: switched_root.to_string_lossy().into_owned(),
            mode: "vault-bound".to_owned(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_opened_at: chrono::Utc::now().to_rfc3339(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            switched_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&switched).unwrap(),
        )
        .unwrap();
        backend
            .knowledge()
            .register_current_vault(&switched)
            .unwrap();
        assert!(backend
            .list_tools(&allowed)
            .unwrap()
            .iter()
            .all(|tool| !tool.id().starts_with("knowledge.")));
        assert_ne!(vault.id, switched.id);
    }

    #[test]
    fn project_knowledge_search_never_crosses_the_frozen_target_during_dispatch() {
        let (backend, _) = backend_with_vault("project-knowledge-search-race");
        let target = backend.knowledge().current_target_identity().unwrap();
        let context = ToolCallContext::agent_read([95; 32]).with_knowledge_scope(Arc::new(
            crate::knowledge::KnowledgeRunScope::for_target(target),
        ));
        let query = "cross-vault-leak-window";
        let gate = install_request_test_gate(&BEFORE_KNOWLEDGE_SEARCH_SNAPSHOT, query);
        let backend = Arc::new(backend);
        let worker_backend = backend.clone();
        let worker = std::thread::spawn(move || {
            worker_backend.run_tool(
                &context,
                ToolRunRequest::read("knowledge.search".to_owned(), json!({"query":query})),
            )
        });

        gate.0.wait();
        let switched_root = temp_dir("project-knowledge-search-race-switched");
        std::fs::create_dir_all(switched_root.join(".luckyray")).unwrap();
        std::fs::write(
            switched_root.join("leak.md"),
            "# Switched\ncross-vault-leak-window\n",
        )
        .unwrap();
        let switched = crate::knowledge::KnowledgeVaultRegistration {
            id: "vault-project-search-race-switched".to_owned(),
            name: "Switched Search Knowledge".to_owned(),
            root_path: switched_root.to_string_lossy().into_owned(),
            mode: "vault-bound".to_owned(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_opened_at: chrono::Utc::now().to_rfc3339(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            switched_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&switched).unwrap(),
        )
        .unwrap();
        backend
            .knowledge()
            .register_current_vault(&switched)
            .unwrap();
        gate.1.wait();

        let error = worker.join().unwrap().unwrap_err();
        assert_eq!(error.code, "agent-project-knowledge-denied");
    }

    fn workspace_write_context(
        backend: &BackendServices,
        grant: &crate::agent_workspace::WorkspaceGrantView,
    ) -> ToolCallContext {
        let aliases = backend.workspace().build_aliases().unwrap();
        assert!(aliases.iter().any(|alias| alias.grant_id == grant.id));
        let mut context = ToolCallContext::agent_read([9u8; 32]);
        context.max_risk = ToolRisk::Write;
        context.conversation_id = Some("conversation-write-tools".to_owned());
        context.workspace_aliases = Some(Arc::new(aliases));
        context.file_bindings = Some(Arc::new(
            crate::agent_workspace::WorkspaceFileBindings::default(),
        ));
        context
    }

    fn write_request(tool_id: &str, input: serde_json::Value) -> ToolRunRequest {
        ToolRunRequest {
            tool_id: tool_id.to_owned(),
            input,
            request_id: None,
        }
    }

    fn bind_workspace_create_for_test(
        backend: &BackendServices,
        context: &ToolCallContext,
        grant: &crate::agent_workspace::WorkspaceGrantView,
        alias: &str,
        relative_path: &str,
        content: &str,
        request_id: &str,
    ) {
        let preview = backend
            .workspace()
            .create_text_preview(&grant.id, relative_path, content)
            .unwrap();
        let binding = backend.workspace().create_binding(
            &grant.id,
            alias,
            relative_path,
            &preview,
            context.principal.0,
            context.conversation_id.as_deref().unwrap(),
        );
        context
            .file_bindings
            .as_deref()
            .unwrap()
            .bind_create(request_id, binding);
    }

    #[test]
    fn workspace_write_schema_rejects_unknown_fields_and_internal_overrides() {
        let definitions = r6_agent_definitions(false);
        let create = definitions
            .iter()
            .find(|definition| definition.id == "workspace.create_text")
            .expect("workspace.create_text definition");
        let patch = definitions
            .iter()
            .find(|definition| definition.id == "workspace.patch_text")
            .expect("workspace.patch_text definition");
        assert_eq!(create.risk, ToolRisk::Write);
        assert_eq!(patch.risk, ToolRisk::Write);
        let safe_create = json!({
            "grantAlias":"Import Source",
            "relativePath":"docs/new.md",
            "content":"# New\nbody",
            "requestId":"request-safe"
        });
        validate_schema(&create.input_schema, &safe_create, "input")
            .expect("safe create input must remain valid");
        for (field, value) in [
            ("grantId", json!("wsg-forged")),
            ("absolutePath", json!("C:\\secret\\x.md")),
            ("revision", json!("rev-1")),
            ("digest", json!("deadbeef")),
            ("requestIdOverride", json!("x")),
        ] {
            let mut forged = safe_create.clone();
            forged[field] = value;
            assert_eq!(
                validate_schema(&create.input_schema, &forged, "input")
                    .expect_err("unknown fields must be rejected")
                    .code,
                "tool-input-invalid",
                "field: {field}"
            );
        }
        let safe_patch = json!({
            "fileRef":"file-ref-safe",
            "edits":[{"startUtf16":0,"endUtf16":4,"replacement":"new"}],
            "requestId":"request-safe"
        });
        validate_schema(&patch.input_schema, &safe_patch, "input")
            .expect("safe patch input must remain valid");
        for (field, value) in [
            ("grantId", json!("wsg-forged")),
            ("absolutePath", json!("C:\\secret\\x.md")),
            ("revision", json!("rev-1")),
            ("digest", json!("deadbeef")),
        ] {
            let mut forged = safe_patch.clone();
            forged[field] = value;
            assert_eq!(
                validate_schema(&patch.input_schema, &forged, "input")
                    .expect_err("unknown fields must be rejected")
                    .code,
                "tool-input-invalid",
                "field: {field}"
            );
        }
        let mut bad_edit = safe_patch.clone();
        bad_edit["edits"] =
            json!([{"startUtf16":0,"endUtf16":4,"replacement":"x","digest":"deadbeef"}]);
        assert_eq!(
            validate_schema(&patch.input_schema, &bad_edit, "input")
                .expect_err("nested unknown fields must be rejected")
                .code,
            "tool-input-invalid"
        );
        let mut too_many = safe_patch.clone();
        too_many["edits"] = json!((0..65)
            .map(|_| json!({"startUtf16":0,"endUtf16":0,"replacement":""}))
            .collect::<Vec<_>>());
        assert_eq!(
            validate_schema(&patch.input_schema, &too_many, "input")
                .expect_err("edits cap is enforced by schema")
                .code,
            "tool-input-invalid"
        );
    }

    #[test]
    fn workspace_create_text_commits_exact_once_and_never_overwrites() {
        let app_data = temp_dir("workspace-create-text");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let root = app_data.join("grant-root");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        let grant = backend.workspace().add(&root, "Write Root").unwrap();
        let context = workspace_write_context(&backend, &grant);
        bind_workspace_create_for_test(
            &backend,
            &context,
            &grant,
            "Write Root",
            "docs/new.md",
            "# New\nbody\n",
            "request-1",
        );
        let output = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.create_text",
                    json!({
                        "grantAlias":"Write Root",
                        "relativePath":"docs/new.md",
                        "content":"# New\nbody\n",
                        "requestId":"request-1"
                    }),
                ),
            )
            .unwrap();
        assert_eq!(output.result()["ok"], json!(true));
        assert_eq!(
            std::fs::read_to_string(root.join("docs/new.md")).unwrap(),
            "# New\nbody\n"
        );
        let text = serde_json::to_string(output.result()).unwrap();
        assert!(
            !text.contains(&grant.id) && !text.contains(&root.to_string_lossy().to_string()),
            "grant identity and absolute paths must never reach the model: {text}"
        );
        let error = backend
            .workspace()
            .create_text_preview(&grant.id, "docs/new.md", "overwrite attempt")
            .unwrap_err();
        assert_eq!(error.code, "workspace-file-exists");
        assert_eq!(
            std::fs::read_to_string(root.join("docs/new.md")).unwrap(),
            "# New\nbody\n"
        );
        let denied = backend
            .workspace()
            .create_text_preview(&grant.id, ".git/config", "x")
            .unwrap_err();
        assert_eq!(denied.code, "workspace-write-denied");
        assert!(!root.join(".git").exists());
    }

    #[test]
    fn workspace_write_source_switch_is_rejected_before_permit_and_no_vault_stays_valid() {
        struct CountingPermit(Arc<AtomicUsize>);

        impl AgentWritePermit for CountingPermit {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                self.0.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }
        }

        struct ApproveOnce;

        impl AgentWritePermit for ApproveOnce {
            fn consume(&self, _binding: &AgentWriteBinding) -> Result<(), ToolError> {
                Ok(())
            }
        }

        let (backend, vault) = backend_with_vault("workspace-write-source-switch");
        let workspace_root = temp_dir("workspace-write-source-switch-root");
        fs::create_dir_all(&workspace_root).unwrap();
        let grant = backend
            .workspace()
            .add(&workspace_root, "Source Fence")
            .unwrap();
        let activation = backend.knowledge().activate_ui_source(&vault.id).unwrap();
        let context = workspace_write_context(&backend, &grant)
            .with_workspace_source(Some(activation.clone()));
        bind_workspace_create_for_test(
            &backend,
            &context,
            &grant,
            "Source Fence",
            "must-not-write.md",
            "must not survive source switch",
            "workspace-source-fence",
        );
        let prepared = backend
            .prepare_agent_write(
                &context,
                ToolRunRequest::agent_write(
                    "workspace.create_text".to_owned(),
                    json!({
                        "grantAlias":"Source Fence",
                        "relativePath":"must-not-write.md",
                        "content":"must not survive source switch",
                        "requestId":"workspace-source-fence"
                    }),
                ),
                AgentWriteScope::new(
                    "workspace-source-turn".to_owned(),
                    "workspace-source-session".to_owned(),
                    "workspace-source-engine-turn".to_owned(),
                    "workspace-source-call".to_owned(),
                    1,
                    activation.source_epoch,
                ),
            )
            .unwrap();
        backend.knowledge().deactivate_ui_source().unwrap();
        let permit_consumes = Arc::new(AtomicUsize::new(0));
        let error = backend
            .run_prepared_agent_write(&context, prepared, &CountingPermit(permit_consumes.clone()))
            .unwrap_err();
        assert_eq!(error.code, "workspace-source-changed");
        assert_eq!(
            permit_consumes.load(Ordering::Acquire),
            0,
            "a source switch must fail before one-shot permit consumption"
        );
        assert!(
            !workspace_root.join("must-not-write.md").exists(),
            "source switch must produce zero file writes"
        );

        let no_vault_data = temp_dir("workspace-write-no-vault");
        let no_vault_backend = BackendServices::initialize(&no_vault_data).unwrap();
        let no_vault_root = no_vault_data.join("grant-root");
        fs::create_dir_all(&no_vault_root).unwrap();
        let no_vault_grant = no_vault_backend
            .workspace()
            .add(&no_vault_root, "Standalone Workspace")
            .unwrap();
        let no_vault_context = workspace_write_context(&no_vault_backend, &no_vault_grant);
        bind_workspace_create_for_test(
            &no_vault_backend,
            &no_vault_context,
            &no_vault_grant,
            "Standalone Workspace",
            "allowed-without-vault.md",
            "standalone write",
            "workspace-no-vault",
        );
        let prepared = no_vault_backend
            .prepare_agent_write(
                &no_vault_context,
                ToolRunRequest::agent_write(
                    "workspace.create_text".to_owned(),
                    json!({
                        "grantAlias":"Standalone Workspace",
                        "relativePath":"allowed-without-vault.md",
                        "content":"standalone write",
                        "requestId":"workspace-no-vault"
                    }),
                ),
                AgentWriteScope::new(
                    "workspace-no-vault-turn".to_owned(),
                    "workspace-no-vault-session".to_owned(),
                    "workspace-no-vault-engine-turn".to_owned(),
                    "workspace-no-vault-call".to_owned(),
                    1,
                    0,
                ),
            )
            .unwrap();
        no_vault_backend
            .run_prepared_agent_write(&no_vault_context, prepared, &ApproveOnce)
            .unwrap();
        assert_eq!(
            fs::read_to_string(no_vault_root.join("allowed-without-vault.md")).unwrap(),
            "standalone write",
            "a workspace-only run remains valid without a Vault/source fence"
        );
    }

    #[test]
    fn workspace_read_issues_file_ref_only_for_qualified_text() {
        let app_data = temp_dir("workspace-read-ref");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let root = app_data.join("grant-root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ok.md"), "line one\nline two\n").unwrap();
        std::fs::write(root.join("mixed.md"), "a\r\nb\n").unwrap();
        std::fs::write(root.join("big.md"), "x".repeat(300 * 1024)).unwrap();
        let grant = backend.workspace().add(&root, "Read Root").unwrap();
        let context = workspace_write_context(&backend, &grant);
        let read = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.read",
                    json!({"grantAlias":"Read Root","relativePath":"ok.md"}),
                ),
            )
            .unwrap();
        let file_ref = read.result()["fileRef"]
            .as_str()
            .expect("qualified read issues a fileRef");
        assert!(file_ref.starts_with("file-ref-"));
        let mixed = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.read",
                    json!({"grantAlias":"Read Root","relativePath":"mixed.md"}),
                ),
            )
            .unwrap();
        assert_eq!(
            mixed.result()["fileRef"],
            Value::Null,
            "mixed newlines never qualify"
        );
        let big = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.read",
                    json!({"grantAlias":"Read Root","relativePath":"big.md"}),
                ),
            )
            .unwrap();
        assert_eq!(big.result()["truncated"], json!(true));
        assert_eq!(
            big.result()["fileRef"],
            Value::Null,
            "truncated reads never qualify"
        );
    }

    #[test]
    fn workspace_patch_commits_cas_consumes_ref_once_and_conflicts_typed() {
        let app_data = temp_dir("workspace-patch-ref");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let root = app_data.join("grant-root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("notes.txt"), "line one\nline two\n").unwrap();
        let grant = backend.workspace().add(&root, "Patch Root").unwrap();
        let context = workspace_write_context(&backend, &grant);
        let read = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.read",
                    json!({"grantAlias":"Patch Root","relativePath":"notes.txt"}),
                ),
            )
            .unwrap();
        let file_ref = read.result()["fileRef"].as_str().unwrap().to_owned();
        let output = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.patch_text",
                    json!({
                        "fileRef": file_ref,
                        "edits":[{"startUtf16":0,"endUtf16":4,"replacement":"LINE"}],
                        "requestId":"request-1"
                    }),
                ),
            )
            .unwrap();
        assert_eq!(output.result()["ok"], json!(true));
        assert_eq!(
            std::fs::read_to_string(root.join("notes.txt")).unwrap(),
            "LINE one\nline two\n"
        );
        let text = serde_json::to_string(output.result()).unwrap();
        assert!(
            !text.contains(&grant.id)
                && !text.contains("file-ref-")
                && !text.contains("digest")
                && !text.contains(&root.to_string_lossy().to_string()),
            "a committed patch observation must never carry identity or digests: {text}"
        );
        // The one-shot reference is consumed.
        let replay = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.patch_text",
                    json!({
                        "fileRef": file_ref,
                        "edits":[{"startUtf16":0,"endUtf16":4,"replacement":"again"}],
                        "requestId":"request-2"
                    }),
                ),
            )
            .unwrap_err();
        assert_eq!(replay.code, "workspace-file-ref-invalid");
        // A forged reference fails closed before any file access.
        let forged = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.patch_text",
                    json!({
                        "fileRef":"file-ref-forged",
                        "edits":[{"startUtf16":0,"endUtf16":1,"replacement":"x"}],
                        "requestId":"request-3"
                    }),
                ),
            )
            .unwrap_err();
        assert_eq!(forged.code, "workspace-file-ref-invalid");
    }

    #[test]
    fn workspace_patch_cas_conflict_and_race_have_one_winner() {
        let app_data = temp_dir("workspace-patch-race");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let root = app_data.join("grant-root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("notes.txt"), "original\n").unwrap();
        let grant = backend.workspace().add(&root, "Race Root").unwrap();
        let first = workspace_write_context(&backend, &grant);
        let second = workspace_write_context(&backend, &grant);
        let first_ref = backend
            .run_tool(
                &first,
                write_request(
                    "workspace.read",
                    json!({"grantAlias":"Race Root","relativePath":"notes.txt"}),
                ),
            )
            .unwrap();
        let first_ref = first_ref.result()["fileRef"].as_str().unwrap().to_owned();
        let second_ref = backend
            .run_tool(
                &second,
                write_request(
                    "workspace.read",
                    json!({"grantAlias":"Race Root","relativePath":"notes.txt"}),
                ),
            )
            .unwrap();
        let second_ref = second_ref.result()["fileRef"].as_str().unwrap().to_owned();
        let first_write = backend
            .run_tool(
                &first,
                write_request(
                    "workspace.patch_text",
                    json!({
                        "fileRef": first_ref,
                        "edits":[{"startUtf16":0,"endUtf16":8,"replacement":"first"}],
                        "requestId":"request-1"
                    }),
                ),
            )
            .unwrap();
        assert_eq!(first_write.result()["ok"], json!(true));
        // The second agent's CAS must lose without overwriting.
        let second_write = backend
            .run_tool(
                &second,
                write_request(
                    "workspace.patch_text",
                    json!({
                        "fileRef": second_ref,
                        "edits":[{"startUtf16":0,"endUtf16":8,"replacement":"second"}],
                        "requestId":"request-2"
                    }),
                ),
            )
            .unwrap_err();
        assert_eq!(second_write.code, "workspace-file-changed");
        assert_eq!(
            std::fs::read_to_string(root.join("notes.txt")).unwrap(),
            "first\n"
        );
    }

    #[test]
    fn workspace_patch_invalid_edits_are_typed_never_protocol_invalid() {
        let app_data = temp_dir("workspace-patch-edits");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let root = app_data.join("grant-root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("e.txt"), "你好 world\n").unwrap();
        let grant = backend.workspace().add(&root, "Edit Root").unwrap();
        let context = workspace_write_context(&backend, &grant);
        let file_ref = backend
            .run_tool(
                &context,
                write_request(
                    "workspace.read",
                    json!({"grantAlias":"Edit Root","relativePath":"e.txt"}),
                ),
            )
            .unwrap();
        let file_ref = file_ref.result()["fileRef"].as_str().unwrap().to_owned();
        for edits in [
            json!([{"startUtf16":3,"endUtf16":1,"replacement":"x"}]),
            json!([{"startUtf16":0,"endUtf16":999,"replacement":"x"}]),
            json!([
                {"startUtf16":0,"endUtf16":2,"replacement":"a"},
                {"startUtf16":1,"endUtf16":3,"replacement":"b"}
            ]),
        ] {
            let error = backend
                .run_tool(
                    &context,
                    write_request(
                        "workspace.patch_text",
                        json!({
                            "fileRef": file_ref,
                            "edits": edits,
                            "requestId":"request-1"
                        }),
                    ),
                )
                .unwrap_err();
            assert!(
                matches!(
                    error.code,
                    "workspace-edit-invalid" | "workspace-file-changed"
                ),
                "expected a typed edit error, got {}",
                error.code
            );
        }
        assert_eq!(
            std::fs::read_to_string(root.join("e.txt")).unwrap(),
            "你好 world\n"
        );
    }
}
