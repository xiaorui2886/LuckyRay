use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::agent_materials::AgentMaterialService;
use crate::knowledge::{
    KnowledgeCreateInput, KnowledgeDeleteInput, KnowledgeDocumentRef, KnowledgeInsertInput,
    KnowledgeMoveInput, KnowledgeService, KnowledgeSetTagsInput, KnowledgeTargetIdentity,
    KnowledgeWriteInput,
};
use crate::materials::{
    MaterialAssetPatch, MaterialFilter, MaterialFolderMove, MaterialImportOptions,
    MaterialRelocateOptions, MaterialTagPatch,
};
use std::path::PathBuf;

pub(crate) const UPDATE_RESOURCE_PROTOCOL: u32 = 1;
const MAX_SESSIONS: usize = 64;
const MAX_REFS_PER_SESSION: usize = 512;
const MAX_CALLS_PER_SESSION: usize = 256;
const REF_TTL: Duration = Duration::from_secs(30 * 60);
const DSH_RESOURCE_OPERATION_MANIFEST: &str =
    include_str!("../dsh-host/luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json");

#[cfg(test)]
pub(crate) const DSH_RESOURCE_OPERATION_INVENTORY: &[(&str, ResourceAccess)] = &[
    ("luckyray_knowledge_list", ResourceAccess::Read),
    ("luckyray_knowledge_recent", ResourceAccess::Read),
    ("luckyray_knowledge_search", ResourceAccess::Read),
    ("luckyray_knowledge_read", ResourceAccess::Read),
    ("luckyray_knowledge_index_snapshot", ResourceAccess::Read),
    ("luckyray_knowledge_index_refresh", ResourceAccess::Read),
    ("luckyray_knowledge_relations", ResourceAccess::Read),
    ("luckyray_knowledge_backlinks", ResourceAccess::Read),
    ("luckyray_knowledge_tags", ResourceAccess::Read),
    ("luckyray_knowledge_tag_documents", ResourceAccess::Read),
    ("luckyray_knowledge_embed_documents", ResourceAccess::Read),
    ("luckyray_knowledge_create", ResourceAccess::Write),
    ("luckyray_knowledge_append", ResourceAccess::Write),
    ("luckyray_knowledge_insert", ResourceAccess::Write),
    ("luckyray_knowledge_replace", ResourceAccess::Write),
    ("luckyray_knowledge_move", ResourceAccess::Write),
    ("luckyray_knowledge_set_tags", ResourceAccess::Write),
    ("luckyray_knowledge_delete", ResourceAccess::Destructive),
    ("luckyray_knowledge_source_register", ResourceAccess::Full),
    ("luckyray_knowledge_source_activate", ResourceAccess::Full),
    ("luckyray_knowledge_source_deactivate", ResourceAccess::Full),
    ("luckyray_materials_list", ResourceAccess::Read),
    ("luckyray_materials_get", ResourceAccess::Read),
    ("luckyray_materials_search", ResourceAccess::Read),
    ("luckyray_materials_inspect", ResourceAccess::Read),
    ("luckyray_materials_preview", ResourceAccess::Read),
    ("luckyray_materials_references", ResourceAccess::Read),
    ("luckyray_materials_taxonomy", ResourceAccess::Read),
    ("luckyray_materials_folders", ResourceAccess::Read),
    ("luckyray_materials_tags", ResourceAccess::Read),
    ("luckyray_materials_tag_map", ResourceAccess::Read),
    ("luckyray_materials_change", ResourceAccess::Read),
    ("luckyray_materials_scan_missing", ResourceAccess::Read),
    ("luckyray_materials_update", ResourceAccess::Write),
    ("luckyray_materials_set_tags", ResourceAccess::Write),
    ("luckyray_materials_add_tags", ResourceAccess::Write),
    ("luckyray_materials_categorize", ResourceAccess::Write),
    ("luckyray_materials_folder_create", ResourceAccess::Write),
    ("luckyray_materials_folder_rename", ResourceAccess::Write),
    ("luckyray_materials_folder_move", ResourceAccess::Write),
    ("luckyray_materials_tag_create", ResourceAccess::Write),
    ("luckyray_materials_tag_update", ResourceAccess::Write),
    ("luckyray_materials_tag_merge", ResourceAccess::Write),
    ("luckyray_materials_move", ResourceAccess::Write),
    ("luckyray_materials_import_path", ResourceAccess::Write),
    ("luckyray_materials_import_folder", ResourceAccess::Write),
    ("luckyray_materials_relocate", ResourceAccess::Write),
    ("luckyray_materials_rename", ResourceAccess::Write),
    (
        "luckyray_materials_asset_delete",
        ResourceAccess::Destructive,
    ),
    (
        "luckyray_materials_record_delete",
        ResourceAccess::Destructive,
    ),
    (
        "luckyray_materials_folder_delete",
        ResourceAccess::Destructive,
    ),
    ("luckyray_materials_tag_delete", ResourceAccess::Destructive),
    ("luckyray_materials_wide_import", ResourceAccess::Full),
    ("luckyray_materials_wide_relocate", ResourceAccess::Full),
    ("luckyray_materials_migrate_library", ResourceAccess::Full),
    ("luckyray_materials_retry_pending", ResourceAccess::Full),
    ("luckyray_materials_thumbnail_cleanup", ResourceAccess::Full),
    ("luckyray_web_search", ResourceAccess::Read),
    ("luckyray_web_fetch", ResourceAccess::Read),
    ("luckyray_browser_open", ResourceAccess::Read),
    ("luckyray_browser_read", ResourceAccess::Read),
    ("luckyray_browser_extract", ResourceAccess::Read),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResourceAccess {
    Read,
    Write,
    Destructive,
    Full,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceOperationManifest {
    version: u32,
    operations: Vec<ResourceOperationManifestEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceOperationManifestEntry {
    id: String,
    access: String,
}

fn resource_operation_inventory() -> Result<&'static [(String, ResourceAccess)], DshResourceError> {
    static INVENTORY: OnceLock<Option<Vec<(String, ResourceAccess)>>> = OnceLock::new();
    INVENTORY
        .get_or_init(|| {
            let manifest: ResourceOperationManifest =
                serde_json::from_str(DSH_RESOURCE_OPERATION_MANIFEST).ok()?;
            if manifest.version != UPDATE_RESOURCE_PROTOCOL
                || manifest.operations.is_empty()
                || manifest.operations.len() > 128
            {
                return None;
            }
            let mut seen = std::collections::HashSet::new();
            manifest
                .operations
                .into_iter()
                .map(|entry| {
                    if entry.id.len() > 128
                        || !entry.id.starts_with("luckyray_knowledge_")
                            && !entry.id.starts_with("luckyray_materials_")
                            && !entry.id.starts_with("luckyray_web_")
                            && !entry.id.starts_with("luckyray_browser_")
                        || !entry.id.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                        })
                        || !seen.insert(entry.id.clone())
                    {
                        return None;
                    }
                    let access = match entry.access.as_str() {
                        "read" => ResourceAccess::Read,
                        "write" => ResourceAccess::Write,
                        "destructive" => ResourceAccess::Destructive,
                        "full" => ResourceAccess::Full,
                        _ => return None,
                    };
                    Some((entry.id, access))
                })
                .collect::<Option<Vec<_>>>()
        })
        .as_deref()
        .ok_or_else(|| DshResourceError::new("dsh-resource-manifest-invalid"))
}

impl ResourceAccess {
    fn is_mutating(self) -> bool {
        self != Self::Read
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum EffectiveMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl EffectiveMode {
    fn permits(self, access: ResourceAccess) -> bool {
        match access {
            ResourceAccess::Read => true,
            ResourceAccess::Write | ResourceAccess::Destructive => {
                matches!(self, Self::WorkspaceWrite | Self::DangerFullAccess)
            }
            ResourceAccess::Full => self == Self::DangerFullAccess,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DshResourcePolicyEnvelope {
    session_id: String,
    policy_seq: i64,
    mode: EffectiveMode,
    approval_policy: String,
    workspace_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DshResourceCallEnvelope {
    session_id: String,
    policy_seq: i64,
    mode: EffectiveMode,
    approval_policy: String,
    workspace_root: String,
    call_id: String,
    root_call_id: String,
    operation: String,
    approval: String,
    args: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DshResourceError {
    pub(crate) code: &'static str,
}

impl DshResourceError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

impl std::fmt::Display for DshResourceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for DshResourceError {}

#[derive(Clone)]
enum BoundResource {
    Knowledge {
        document_ref: KnowledgeDocumentRef,
        revision: String,
        target: KnowledgeTargetIdentity,
    },
    Material {
        asset_id: String,
        revision: String,
    },
    MaterialFolder {
        folder_id: String,
        updated_at: String,
    },
    MaterialTag {
        tag_id: String,
        updated_at: String,
    },
}

struct BoundRef {
    value: BoundResource,
    expires_at: Instant,
}

struct SessionFence {
    policy_seq: i64,
    mode: EffectiveMode,
    approval_policy: String,
    workspace_root: String,
    refs: HashMap<String, BoundRef>,
    ref_order: VecDeque<String>,
    call_results: HashMap<String, CallSettlement>,
    call_order: VecDeque<String>,
    web_scope: Option<crate::web_tools::WebScopeLease>,
    browser_scope: Option<crate::agent_browser::AgentBrowserScopeLease>,
    scope: [u8; 32],
    expires_at: Instant,
}

#[derive(Clone)]
struct CallSettlement {
    fingerprint: String,
    result: Result<Value, &'static str>,
    knowledge_read_target: Option<KnowledgeTargetIdentity>,
}

impl SessionFence {
    fn from_policy(policy: &DshResourcePolicyEnvelope, scope: [u8; 32]) -> Self {
        Self {
            policy_seq: policy.policy_seq,
            mode: policy.mode,
            approval_policy: policy.approval_policy.clone(),
            workspace_root: policy.workspace_root.clone(),
            refs: HashMap::new(),
            ref_order: VecDeque::new(),
            call_results: HashMap::new(),
            call_order: VecDeque::new(),
            web_scope: None,
            browser_scope: None,
            scope,
            expires_at: Instant::now() + REF_TTL,
        }
    }

    fn matches_call(&self, call: &DshResourceCallEnvelope) -> bool {
        self.policy_seq == call.policy_seq
            && self.mode == call.mode
            && self.approval_policy == call.approval_policy
            && self.workspace_root == call.workspace_root
    }

    fn sweep(&mut self) {
        let now = Instant::now();
        self.refs.retain(|_, value| value.expires_at > now);
        self.ref_order.retain(|key| self.refs.contains_key(key));
    }

    fn bind(&mut self, value: BoundResource) -> String {
        self.sweep();
        while self.refs.len() >= MAX_REFS_PER_SESSION {
            if let Some(oldest) = self.ref_order.pop_front() {
                self.refs.remove(&oldest);
            } else {
                break;
            }
        }
        let reference = opaque_ref();
        self.refs.insert(
            reference.clone(),
            BoundRef {
                value,
                expires_at: Instant::now() + REF_TTL,
            },
        );
        self.ref_order.push_back(reference.clone());
        reference
    }

    fn remember_call(
        &mut self,
        call_id: &str,
        fingerprint: String,
        result: Result<Value, &'static str>,
        knowledge_read_target: Option<KnowledgeTargetIdentity>,
    ) {
        while self.call_results.len() >= MAX_CALLS_PER_SESSION {
            if let Some(oldest) = self.call_order.pop_front() {
                self.call_results.remove(&oldest);
            } else {
                break;
            }
        }
        self.call_results.insert(
            call_id.to_owned(),
            CallSettlement {
                fingerprint,
                result,
                knowledge_read_target,
            },
        );
        self.call_order.push_back(call_id.to_owned());
        self.expires_at = Instant::now() + REF_TTL;
    }
}

type SessionKey = (u64, String);

#[derive(Default)]
struct BrokerState {
    sessions: HashMap<SessionKey, Arc<Mutex<SessionFence>>>,
    session_order: VecDeque<SessionKey>,
    mutation_tombstones: HashMap<(String, String), Instant>,
}

#[derive(Clone)]
pub(crate) struct DshResourceBroker {
    backend: Arc<crate::backend::BackendServices>,
    knowledge: KnowledgeService,
    materials: AgentMaterialService,
    state: Arc<Mutex<BrokerState>>,
}

impl DshResourceBroker {
    pub(crate) fn new(backend: Arc<crate::backend::BackendServices>) -> Self {
        Self {
            knowledge: backend.knowledge(),
            materials: backend.agent_materials(),
            backend,
            state: Arc::new(Mutex::new(BrokerState::default())),
        }
    }

    pub(crate) fn sync_policy(
        &self,
        host_generation: u64,
        policy: DshResourcePolicyEnvelope,
    ) -> Result<Value, DshResourceError> {
        validate_generation_and_session(host_generation, &policy.session_id)?;
        validate_policy(&policy.approval_policy, &policy.workspace_root)?;
        if policy.mode == EffectiveMode::WorkspaceWrite && policy.workspace_root.is_empty() {
            return Err(DshResourceError::new("dsh-resource-policy-invalid"));
        }
        let fence = self.session_fence(host_generation, &policy)?;
        let mut fence = fence
            .lock()
            .map_err(|_| DshResourceError::new("dsh-resource-broker-unavailable"))?;
        fence.expires_at = Instant::now() + REF_TTL;
        if policy.policy_seq < fence.policy_seq {
            return Err(DshResourceError::new("dsh-resource-policy-stale"));
        }
        if policy.policy_seq == fence.policy_seq
            && (policy.mode != fence.mode
                || policy.approval_policy != fence.approval_policy
                || policy.workspace_root != fence.workspace_root)
        {
            return Err(DshResourceError::new("dsh-resource-policy-conflict"));
        }
        if policy.policy_seq > fence.policy_seq {
            fence.policy_seq = policy.policy_seq;
            fence.mode = policy.mode;
            fence.approval_policy = policy.approval_policy;
            fence.workspace_root = policy.workspace_root;
            fence.refs.clear();
            fence.ref_order.clear();
            fence.web_scope.take();
            fence.browser_scope.take();
        }
        Ok(json!({ "accepted": true }))
    }

    pub(crate) fn execute(
        &self,
        host_generation: u64,
        call: DshResourceCallEnvelope,
    ) -> Result<Value, DshResourceError> {
        validate_generation_and_session(host_generation, &call.session_id)?;
        validate_call(&call)?;
        let access = operation_access(&call.operation)?;
        let key = (host_generation, call.session_id.clone());
        let fence = self
            .state
            .lock()
            .map_err(|_| DshResourceError::new("dsh-resource-broker-unavailable"))?
            .sessions
            .get(&key)
            .cloned()
            .ok_or_else(|| DshResourceError::new("dsh-resource-policy-unavailable"))?;
        let mut fence = fence
            .lock()
            .map_err(|_| DshResourceError::new("dsh-resource-broker-unavailable"))?;
        fence.expires_at = Instant::now() + REF_TTL;
        if !fence.matches_call(&call) {
            return Err(DshResourceError::new("dsh-resource-policy-stale"));
        }
        if !fence.mode.permits(access) {
            return Err(DshResourceError::new("dsh-resource-policy-denied"));
        }
        if matches!(access, ResourceAccess::Destructive | ResourceAccess::Full) {
            if fence.approval_policy == "ask" && call.approval != "allowed-once" {
                return Err(DshResourceError::new("dsh-resource-approval-required"));
            }
            if access == ResourceAccess::Destructive
                && fence.mode == EffectiveMode::WorkspaceWrite
                && fence.approval_policy == "never"
            {
                return Err(DshResourceError::new("dsh-resource-approval-required"));
            }
        }
        let fingerprint = call_fingerprint(&call)?;
        if let Some(settlement) = fence.call_results.get(&call.call_id) {
            if settlement.fingerprint != fingerprint {
                return Err(DshResourceError::new("dsh-resource-call-replayed"));
            }
            // Replaying a completed read is still a delivery. It must hold
            // the same current-Vault fence as the original response rather
            // than serving a cached old root after a switch or replacement.
            // Mutation settlements remain replayable to prevent duplicate
            // effects; they are receipts, not fresh reads of the current root.
            return match &settlement.knowledge_read_target {
                Some(target) => self
                    .knowledge
                    .with_current_target_response_lease(target, || settlement.result.clone())
                    .map_err(knowledge_error)?
                    .map_err(DshResourceError::new),
                None => settlement.result.clone().map_err(DshResourceError::new),
            };
        }
        if access.is_mutating() {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DshResourceError::new("dsh-resource-broker-unavailable"))?;
            state
                .mutation_tombstones
                .retain(|_, expires| *expires > Instant::now());
            let tombstone = (call.session_id.clone(), call.call_id.clone());
            if state.mutation_tombstones.contains_key(&tombstone) {
                return Err(DshResourceError::new(
                    "dsh-resource-mutation-outcome-unknown",
                ));
            }
            state
                .mutation_tombstones
                .insert(tombstone, Instant::now() + REF_TTL);
        }
        let delivery_target = if access == ResourceAccess::Read
            && call.operation.starts_with("luckyray_knowledge_")
        {
            Some(
                self.knowledge
                    .current_target_identity()
                    .map_err(knowledge_error)?,
            )
        } else {
            None
        };
        let result = match (delivery_target.as_ref(), self.dispatch(&mut fence, &call)) {
            (Some(target), Ok(value)) => {
                let result = self
                    .knowledge
                    .with_current_target_response_lease(target, || value)
                    .map_err(knowledge_error);
                if result.is_err() {
                    fence.refs.clear();
                    fence.ref_order.clear();
                }
                result
            }
            (_, result) => result,
        };
        fence.remember_call(
            &call.call_id,
            fingerprint,
            result.as_ref().cloned().map_err(|error| error.code),
            delivery_target,
        );
        result
    }

    pub(crate) fn retire_generation(&self, host_generation: u64) {
        let scopes = if let Ok(mut state) = self.state.lock() {
            let scopes = state
                .sessions
                .keys()
                .filter(|(generation, _)| *generation == host_generation)
                .map(|(generation, session_id)| resource_scope(*generation, session_id))
                .collect::<Vec<_>>();
            state
                .sessions
                .retain(|(generation, _), _| *generation != host_generation);
            state
                .session_order
                .retain(|(generation, _)| *generation != host_generation);
            scopes
        } else {
            Vec::new()
        };
        for scope in scopes {
            self.backend.web_tools().cancel_scope(scope);
            self.backend.agent_browser().cancel_scope(scope);
        }
    }

    fn session_fence(
        &self,
        host_generation: u64,
        policy: &DshResourcePolicyEnvelope,
    ) -> Result<Arc<Mutex<SessionFence>>, DshResourceError> {
        let key = (host_generation, policy.session_id.clone());
        let mut state = self
            .state
            .lock()
            .map_err(|_| DshResourceError::new("dsh-resource-broker-unavailable"))?;
        let now = Instant::now();
        state.sessions.retain(|_, fence| {
            Arc::strong_count(fence) > 1
                || fence
                    .lock()
                    .map(|fence| fence.expires_at > now)
                    .unwrap_or(false)
        });
        let live_keys = state
            .sessions
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        state.session_order.retain(|key| live_keys.contains(key));
        if let Some(existing) = state.sessions.get(&key) {
            return Ok(existing.clone());
        }
        if state.sessions.len() >= MAX_SESSIONS {
            return Err(DshResourceError::new("dsh-resource-capacity-unavailable"));
        }
        let scope = resource_scope(host_generation, &policy.session_id);
        let fence = Arc::new(Mutex::new(SessionFence::from_policy(policy, scope)));
        state.sessions.insert(key.clone(), fence.clone());
        state.session_order.push_back(key);
        Ok(fence)
    }

    fn dispatch(
        &self,
        fence: &mut SessionFence,
        call: &DshResourceCallEnvelope,
    ) -> Result<Value, DshResourceError> {
        match call.operation.as_str() {
            "luckyray_web_search" => self.web_search(fence, &call.args),
            "luckyray_web_fetch" => self.web_fetch(fence, &call.args),
            "luckyray_browser_open" => self.browser_open(fence, &call.args),
            "luckyray_browser_read" => self.browser_read(fence, &call.args),
            "luckyray_browser_extract" => self.browser_extract(fence, &call.args),
            "luckyray_knowledge_list" | "luckyray_knowledge_recent" => {
                self.knowledge_list(fence, &call.args)
            }
            "luckyray_knowledge_search" => self.knowledge_search(fence, &call.args),
            "luckyray_knowledge_read" => self.knowledge_read(fence, &call.args),
            "luckyray_knowledge_index_snapshot" | "luckyray_knowledge_index_refresh" => {
                self.knowledge_index(fence)
            }
            "luckyray_knowledge_relations"
            | "luckyray_knowledge_backlinks"
            | "luckyray_knowledge_tags"
            | "luckyray_knowledge_tag_documents"
            | "luckyray_knowledge_embed_documents" => {
                self.knowledge_relations(fence, &call.operation, &call.args)
            }
            "luckyray_knowledge_create" => self.knowledge_create(fence, &call.args),
            "luckyray_knowledge_append" | "luckyray_knowledge_replace" => {
                self.knowledge_write(fence, &call.operation, &call.args)
            }
            "luckyray_knowledge_insert" => self.knowledge_insert(fence, &call.args),
            "luckyray_knowledge_move" => self.knowledge_move(fence, &call.args),
            "luckyray_knowledge_set_tags" => self.knowledge_set_tags(fence, &call.args),
            "luckyray_knowledge_delete" => self.knowledge_delete(fence, &call.args),
            "luckyray_knowledge_source_register"
            | "luckyray_knowledge_source_activate"
            | "luckyray_knowledge_source_deactivate" => {
                self.knowledge_source_admin(&call.operation, &call.args)
            }
            "luckyray_materials_list" => self.material_list(fence, &call.args),
            "luckyray_materials_search" => self.material_search(fence, &call.args),
            "luckyray_materials_inspect" | "luckyray_materials_get" => {
                self.material_inspect(fence, &call.args)
            }
            "luckyray_materials_preview" => self.material_preview(fence, &call.args),
            "luckyray_materials_references" => self.material_references(fence, &call.args),
            "luckyray_materials_taxonomy"
            | "luckyray_materials_folders"
            | "luckyray_materials_tags" => self.material_taxonomy(fence),
            "luckyray_materials_tag_map" => self.material_tag_map(fence, &call.args),
            "luckyray_materials_change" => self.material_change(fence),
            "luckyray_materials_scan_missing" => self.material_missing(fence),
            "luckyray_materials_update"
            | "luckyray_materials_set_tags"
            | "luckyray_materials_add_tags"
            | "luckyray_materials_categorize"
            | "luckyray_materials_move"
            | "luckyray_materials_relocate"
            | "luckyray_materials_rename"
            | "luckyray_materials_asset_delete"
            | "luckyray_materials_record_delete" => {
                self.material_asset_mutation(fence, &call.operation, &call.args)
            }
            "luckyray_materials_folder_create"
            | "luckyray_materials_folder_rename"
            | "luckyray_materials_folder_move"
            | "luckyray_materials_folder_delete"
            | "luckyray_materials_tag_create"
            | "luckyray_materials_tag_update"
            | "luckyray_materials_tag_merge"
            | "luckyray_materials_tag_delete" => {
                self.material_taxonomy_mutation(fence, &call.operation, &call.args)
            }
            "luckyray_materials_import_path"
            | "luckyray_materials_import_folder"
            | "luckyray_materials_wide_import" => self.material_import(fence, &call.args),
            "luckyray_materials_wide_relocate" => {
                self.material_asset_mutation(fence, "luckyray_materials_relocate", &call.args)
            }
            "luckyray_materials_migrate_library" => self.material_migrate(&call.args),
            "luckyray_materials_retry_pending" => self.material_retry_pending(),
            "luckyray_materials_thumbnail_cleanup" => self.material_thumbnail_cleanup(),
            _ => Err(DshResourceError::new(
                "dsh-resource-operation-not-implemented",
            )),
        }
    }

    fn ensure_web_scope(&self, fence: &mut SessionFence) -> Result<(), DshResourceError> {
        if fence.web_scope.is_some()
            && self
                .backend
                .web_tools()
                .scope_search_ready(fence.scope)
                .is_err_and(|error| error.code == "web-turn-stopped")
        {
            fence.web_scope.take();
        }
        if fence.web_scope.is_none() {
            fence.web_scope = Some(
                self.backend
                    .web_tools()
                    .bind_scope(&self.backend, fence.scope)
                    .map_err(web_error)?,
            );
        }
        Ok(())
    }

    fn web_search(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        self.ensure_web_scope(fence)?;
        self.ensure_browser_scope(fence)?;
        let mut output = self
            .backend
            .web_tools()
            .search(&self.backend, fence.scope, args)
            .map_err(web_error)?;
        if let Some(results) = output.get_mut("results").and_then(Value::as_array_mut) {
            for result in results {
                let Some(fetch_ref) = result.get("fetchRef").and_then(Value::as_str) else {
                    continue;
                };
                let raw_url = self
                    .backend
                    .web_tools()
                    .navigation_url(fence.scope, fetch_ref)
                    .map_err(web_error)?;
                let navigation_ref = self
                    .backend
                    .agent_browser()
                    .remember_navigation(fence.scope, &raw_url)
                    .map_err(browser_error)?;
                if let Some(object) = result.as_object_mut() {
                    object.insert("navigationRef".into(), Value::String(navigation_ref));
                }
            }
        }
        Ok(output)
    }

    fn web_fetch(&self, fence: &mut SessionFence, args: &Value) -> Result<Value, DshResourceError> {
        self.ensure_web_scope(fence)?;
        self.backend
            .web_tools()
            .fetch(fence.scope, args)
            .map_err(web_error)
    }

    fn ensure_browser_scope(&self, fence: &mut SessionFence) -> Result<(), DshResourceError> {
        if fence.browser_scope.is_some() && !self.backend.agent_browser().scope_ready(fence.scope) {
            fence.browser_scope.take();
        }
        if fence.browser_scope.is_none() {
            fence.browser_scope = Some(
                self.backend
                    .agent_browser()
                    .bind_scope(fence.scope, Instant::now() + REF_TTL)
                    .map_err(browser_error)?,
            );
        }
        Ok(())
    }

    fn browser_open(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        self.ensure_browser_scope(fence)?;
        self.backend
            .agent_browser()
            .open(fence.scope, required_string(args, "navigationRef", 52)?)
            .map_err(browser_error)
    }

    fn browser_read(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        self.ensure_browser_scope(fence)?;
        self.backend
            .agent_browser()
            .read(fence.scope, required_string(args, "browserRef", 56)?)
            .map_err(browser_error)
    }

    fn browser_extract(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        self.ensure_browser_scope(fence)?;
        let index = args
            .get("index")
            .map(|value| {
                value
                    .as_u64()
                    .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))
            })
            .transpose()?;
        self.backend
            .agent_browser()
            .extract(
                fence.scope,
                required_string(args, "browserRef", 56)?,
                required_string(args, "kind", 16)?,
                index,
            )
            .map_err(browser_error)
    }

    fn knowledge_list(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let target = self
            .knowledge
            .current_target_identity()
            .map_err(knowledge_error)?;
        let limit = bounded_limit(args, 100);
        let snapshot = self
            .knowledge
            .refresh_index_for_target(&target)
            .map_err(knowledge_error)?;
        let items = snapshot
            .documents
            .into_iter()
            .take(limit)
            .map(|document| {
                let summary = document.summary();
                let reference = fence.bind(BoundResource::Knowledge {
                    document_ref: summary.document_ref,
                    revision: document.revision,
                    target: target.clone(),
                });
                json!({
                    "resourceRef": reference,
                    "title": summary.title,
                    "modifiedAt": summary.modified_at,
                    "size": summary.size,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "items": items }))
    }

    fn knowledge_search(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let query = required_string(args, "query", 2_000)?.to_lowercase();
        let target = self
            .knowledge
            .current_target_identity()
            .map_err(knowledge_error)?;
        let limit = bounded_limit(args, 100);
        let snapshot = self
            .knowledge
            .refresh_index_for_target(&target)
            .map_err(knowledge_error)?;
        let items = snapshot
            .documents
            .into_iter()
            .filter(|document| {
                document.title.to_lowercase().contains(&query)
                    || document.plain_text.to_lowercase().contains(&query)
            })
            .take(limit)
            .map(|document| {
                let summary = document.summary();
                let reference = fence.bind(BoundResource::Knowledge {
                    document_ref: summary.document_ref,
                    revision: document.revision,
                    target: target.clone(),
                });
                json!({ "resourceRef": reference, "title": summary.title, "size": summary.size })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "items": items }))
    }

    fn knowledge_read(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let reference = required_string(args, "resourceRef", 128)?;
        let (document_ref, revision, target) = knowledge_ref(fence, reference)?;
        let document = self
            .knowledge
            .read_document_for_target(&target, &document_ref)
            .map_err(knowledge_error)?;
        if document.revision != revision {
            return Err(DshResourceError::new("dsh-resource-revision-stale"));
        }
        Ok(json!({
            "resourceRef": reference,
            "title": document.summary.title,
            "content": document.content,
            "revision": document.revision,
        }))
    }

    fn knowledge_index(&self, fence: &mut SessionFence) -> Result<Value, DshResourceError> {
        let target = self
            .knowledge
            .current_target_identity()
            .map_err(knowledge_error)?;
        let snapshot = self
            .knowledge
            .refresh_index_for_target(&target)
            .map_err(knowledge_error)?;
        let items = snapshot
            .documents
            .into_iter()
            .take(500)
            .map(|document| {
                let resource_ref = fence.bind(BoundResource::Knowledge {
                    document_ref: document.document_ref,
                    revision: document.revision,
                    target: target.clone(),
                });
                json!({
                    "resourceRef": resource_ref,
                    "title": document.title,
                    "excerpt": document.excerpt,
                    "tags": document.tags,
                    "modifiedAt": document.modified_at,
                    "size": document.size,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "version": snapshot.version,
            "builtAt": snapshot.built_at,
            "stale": snapshot.stale,
            "items": items,
        }))
    }

    fn knowledge_relations(
        &self,
        fence: &mut SessionFence,
        operation: &str,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let target = self
            .knowledge
            .current_target_identity()
            .map_err(knowledge_error)?;
        let snapshot = self
            .knowledge
            .refresh_index_for_target(&target)
            .map_err(knowledge_error)?;
        if operation == "luckyray_knowledge_tags" {
            let mut counts = std::collections::BTreeMap::<String, usize>::new();
            for document in &snapshot.documents {
                let mut seen = std::collections::BTreeSet::new();
                for tag in &document.tags {
                    let key = tag.to_lowercase();
                    if seen.insert(key.clone()) {
                        *counts.entry(key).or_default() += 1;
                    }
                }
            }
            return Ok(
                json!({ "items": counts.into_iter().map(|(name, document_count)| json!({"name": name, "documentCount": document_count})).collect::<Vec<_>>() }),
            );
        }
        let query = if matches!(
            operation,
            "luckyray_knowledge_tag_documents" | "luckyray_knowledge_embed_documents"
        ) {
            Some(
                required_string(args, "query", 2_000)?
                    .trim()
                    .trim_start_matches('#')
                    .to_lowercase(),
            )
        } else {
            None
        };
        if let Some(query) = query {
            let items = snapshot
                .documents
                .into_iter()
                .filter(|document| {
                    if operation == "luckyray_knowledge_tag_documents" {
                        document.tags.iter().any(|tag| tag.to_lowercase() == query)
                    } else {
                        document
                            .embeds
                            .iter()
                            .any(|embed| embed.target.to_lowercase() == query)
                    }
                })
                .map(|document| {
                    let reference = fence.bind(BoundResource::Knowledge {
                        document_ref: document.document_ref,
                        revision: document.revision,
                        target: target.clone(),
                    });
                    json!({ "resourceRef": reference, "title": document.title })
                })
                .collect::<Vec<_>>();
            return Ok(json!({ "items": items }));
        }
        let reference = required_string(args, "resourceRef", 128)?;
        let (document_ref, revision, bound_target) = knowledge_ref(fence, reference)?;
        if bound_target != target {
            return Err(DshResourceError::new("dsh-resource-context-stale"));
        }
        let document = snapshot
            .documents
            .iter()
            .find(|document| document.document_ref == document_ref && document.revision == revision)
            .ok_or_else(|| DshResourceError::new("dsh-resource-revision-stale"))?;
        if operation == "luckyray_knowledge_relations" {
            return Ok(json!({
                "headings": document.headings,
                "wikiLinks": document.wiki_links,
                "embeds": document.embeds,
                "tags": document.tags,
            }));
        }
        let title = document.title.to_lowercase();
        let stem = document.file_name.trim_end_matches(".md").to_lowercase();
        let backlinks = snapshot
            .documents
            .into_iter()
            .filter(|candidate| {
                candidate.wiki_links.iter().any(|link| {
                    let normalized = link
                        .target
                        .split('#')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .trim_end_matches(".md")
                        .to_lowercase();
                    normalized == title || normalized == stem
                })
            })
            .map(|candidate| {
                let source_ref = fence.bind(BoundResource::Knowledge {
                    document_ref: candidate.document_ref,
                    revision: candidate.revision,
                    target: target.clone(),
                });
                json!({ "sourceRef": source_ref, "title": candidate.title })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "items": backlinks }))
    }

    fn knowledge_source_admin(
        &self,
        operation: &str,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        match operation {
            "luckyray_knowledge_source_deactivate" => {
                self.knowledge
                    .deactivate_ui_source()
                    .map_err(knowledge_error)?;
                Ok(json!({ "active": false }))
            }
            "luckyray_knowledge_source_activate" => {
                let target = self
                    .knowledge
                    .current_target_identity()
                    .map_err(knowledge_error)?;
                let activation = self
                    .knowledge
                    .activate_ui_source(&target.target_id)
                    .map_err(knowledge_error)?;
                Ok(json!({ "active": true, "sourceEpoch": activation.source_epoch }))
            }
            "luckyray_knowledge_source_register" => {
                let root = required_string(args, "authorizedPath", 32 * 1024)?;
                let metadata_path = PathBuf::from(root).join(".luckyray").join("vault.json");
                let bytes = std::fs::read(metadata_path)
                    .map_err(|_| DshResourceError::new("dsh-resource-source-invalid"))?;
                let mut registration: crate::knowledge::KnowledgeVaultRegistration =
                    serde_json::from_slice(&bytes)
                        .map_err(|_| DshResourceError::new("dsh-resource-source-invalid"))?;
                registration.root_path = root.to_owned();
                self.knowledge
                    .register_current_vault(&registration)
                    .map_err(knowledge_error)?;
                Ok(json!({ "registered": true, "name": registration.name }))
            }
            _ => Err(DshResourceError::new("dsh-resource-operation-unknown")),
        }
    }

    fn knowledge_create(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let target = self
            .knowledge
            .current_target_identity()
            .map_err(knowledge_error)?;
        let input: KnowledgeCreateInput = from_args(args)?;
        let result = self
            .knowledge
            .create_document_for_target(&target, &input)
            .map_err(knowledge_error)?;
        let reference = fence.bind(BoundResource::Knowledge {
            document_ref: result.document.summary.document_ref.clone(),
            revision: result.document.revision.clone(),
            target,
        });
        Ok(json!({
            "resourceRef": reference,
            "title": result.document.summary.title,
            "revision": result.document.revision,
            "committed": true,
            "warning": result.index_warning,
        }))
    }

    fn knowledge_write(
        &self,
        fence: &mut SessionFence,
        operation: &str,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let reference = required_string(args, "resourceRef", 128)?.to_owned();
        let content = required_string(args, "content", 512 * 1024)?.to_owned();
        let (document_ref, revision, target) = knowledge_ref(fence, &reference)?;
        let input = KnowledgeWriteInput {
            document_ref,
            content,
            expected_revision: Some(revision),
        };
        let result = if operation.ends_with("append") {
            self.knowledge.append_document_for_target(&target, &input)
        } else {
            self.knowledge.replace_document_for_target(&target, &input)
        }
        .map_err(knowledge_error)?;
        let next_ref = fence.bind(BoundResource::Knowledge {
            document_ref: result.document.summary.document_ref.clone(),
            revision: result.document.revision.clone(),
            target,
        });
        Ok(
            json!({ "resourceRef": next_ref, "revision": result.document.revision, "committed": true }),
        )
    }

    fn knowledge_insert(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let reference = required_string(args, "resourceRef", 128)?.to_owned();
        let (document_ref, revision, target) = knowledge_ref(fence, &reference)?;
        let offset = args
            .get("offset")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))?;
        let text = required_string(args, "text", 512 * 1024)?.to_owned();
        let result = self
            .knowledge
            .insert_document_for_target(
                &target,
                &KnowledgeInsertInput {
                    document_ref,
                    offset,
                    text,
                    expected_revision: Some(revision),
                },
            )
            .map_err(knowledge_error)?;
        let next_ref = fence.bind(BoundResource::Knowledge {
            document_ref: result.document.summary.document_ref.clone(),
            revision: result.document.revision.clone(),
            target,
        });
        Ok(
            json!({ "resourceRef": next_ref, "revision": result.document.revision, "committed": true }),
        )
    }

    fn knowledge_move(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let reference = required_string(args, "resourceRef", 128)?.to_owned();
        let (document_ref, revision, target) = knowledge_ref(fence, &reference)?;
        let input = KnowledgeMoveInput {
            document_ref,
            title: required_string(args, "title", 256)?.to_owned(),
            expected_revision: revision,
            parent_relative_path: optional_string(args, "parentRelativePath", 8 * 1024)?,
        };
        let document = self
            .knowledge
            .move_document_for_target(&target, &input)
            .map_err(knowledge_error)?;
        let next_ref = fence.bind(BoundResource::Knowledge {
            document_ref: document.summary.document_ref,
            revision: document.revision.clone(),
            target,
        });
        Ok(json!({ "resourceRef": next_ref, "revision": document.revision, "committed": true }))
    }

    fn knowledge_set_tags(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let reference = required_string(args, "resourceRef", 128)?.to_owned();
        let (document_ref, revision, target) = knowledge_ref(fence, &reference)?;
        let tags = args
            .get("tags")
            .and_then(Value::as_array)
            .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let result = self
            .knowledge
            .set_document_tags_for_target(
                &target,
                &KnowledgeSetTagsInput {
                    document_ref,
                    expected_revision: revision,
                    tags,
                },
            )
            .map_err(knowledge_error)?;
        let next_ref = fence.bind(BoundResource::Knowledge {
            document_ref: result.document.summary.document_ref.clone(),
            revision: result.document.revision.clone(),
            target,
        });
        Ok(
            json!({ "resourceRef": next_ref, "revision": result.document.revision, "committed": true }),
        )
    }

    fn knowledge_delete(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let reference = required_string(args, "resourceRef", 128)?.to_owned();
        let (document_ref, revision, target) = knowledge_ref(fence, &reference)?;
        self.knowledge
            .delete_document_for_target(
                &target,
                &KnowledgeDeleteInput {
                    document_ref,
                    expected_revision: revision,
                },
            )
            .map_err(knowledge_error)?;
        fence.refs.remove(&reference);
        Ok(json!({ "deleted": true, "committed": true }))
    }

    fn material_inspect(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let (asset_id, expected_revision) = material_ref_from_args(fence, args)?;
        let item = self
            .materials
            .inspect(&asset_id)
            .map_err(|_| DshResourceError::new("dsh-resource-operation-failed"))?;
        if item.revision != expected_revision {
            return Err(DshResourceError::new("dsh-resource-revision-stale"));
        }
        let resource_ref = fence.bind(BoundResource::Material {
            asset_id: item.id.clone(),
            revision: item.revision.clone(),
        });
        serde_json::to_value(item)
            .map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.remove("id");
                    let tag_count = object
                        .remove("tagIds")
                        .and_then(|value| value.as_array().map(Vec::len))
                        .unwrap_or(0);
                    object.remove("folderId");
                    object.insert("resourceRef".to_owned(), Value::String(resource_ref));
                    object.insert("tagCount".to_owned(), json!(tag_count));
                }
                value
            })
            .map_err(|_| DshResourceError::new("dsh-resource-response-invalid"))
    }

    fn material_preview(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let (asset_id, revision) = material_ref_from_args(fence, args)?;
        let value = self
            .materials
            .preview(&asset_id)
            .map_err(|_| DshResourceError::new("dsh-resource-operation-failed"))?;
        if value.get("revision").and_then(Value::as_str) != Some(revision.as_str()) {
            return Err(DshResourceError::new("dsh-resource-revision-stale"));
        }
        Ok(redact_material_identity(value))
    }

    fn material_references(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let (asset_id, revision) = material_ref_from_args(fence, args)?;
        let value = self
            .materials
            .references(&asset_id)
            .map_err(|_| DshResourceError::new("dsh-resource-operation-failed"))?;
        if value.get("revision").and_then(Value::as_str) != Some(revision.as_str()) {
            return Err(DshResourceError::new("dsh-resource-revision-stale"));
        }
        Ok(redact_material_identity(value))
    }

    fn material_list(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let filter = args
            .get("filter")
            .cloned()
            .map(serde_json::from_value::<MaterialFilter>)
            .transpose()
            .map_err(|_| DshResourceError::new("dsh-resource-arguments-invalid"))?
            .unwrap_or_default();
        let items = self
            .materials
            .list(&filter)
            .map_err(material_error)?
            .into_iter()
            .take(200)
            .map(|item| material_summary_value(fence, item))
            .collect::<Vec<_>>();
        Ok(json!({ "items": items }))
    }

    fn material_search(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let query = required_string(args, "query", 2_000)?;
        let limit = bounded_limit(args, 100);
        let items = self
            .materials
            .search(query, limit)
            .map_err(material_error)?
            .into_iter()
            .map(|(item, snippet)| {
                let mut value = material_summary_value(fence, item);
                value["snippet"] = Value::String(snippet);
                value
            })
            .collect::<Vec<_>>();
        Ok(json!({ "items": items }))
    }

    fn material_taxonomy(&self, fence: &mut SessionFence) -> Result<Value, DshResourceError> {
        let mut value = self.materials.taxonomy().map_err(material_error)?;
        if let Some(folders) = value.get_mut("folders").and_then(Value::as_array_mut) {
            let mut references = HashMap::new();
            for folder in folders.iter_mut() {
                let object = folder
                    .as_object_mut()
                    .ok_or_else(|| DshResourceError::new("dsh-resource-response-invalid"))?;
                let id = object
                    .remove("id")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .ok_or_else(|| DshResourceError::new("dsh-resource-response-invalid"))?;
                let updated_at = object
                    .remove("updatedAt")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default();
                let reference = fence.bind(BoundResource::MaterialFolder {
                    folder_id: id.clone(),
                    updated_at,
                });
                references.insert(id, reference.clone());
                object.insert("folderRef".to_owned(), Value::String(reference));
            }
            for folder in folders.iter_mut() {
                let object = folder
                    .as_object_mut()
                    .ok_or_else(|| DshResourceError::new("dsh-resource-response-invalid"))?;
                let parent_ref = match object.remove("parentId") {
                    None | Some(Value::Null) => Value::Null,
                    Some(Value::String(parent_id)) => {
                        Value::String(references.get(&parent_id).cloned().ok_or_else(|| {
                            DshResourceError::new("dsh-resource-response-invalid")
                        })?)
                    }
                    _ => return Err(DshResourceError::new("dsh-resource-response-invalid")),
                };
                object.insert("parentRef".to_owned(), parent_ref);
            }
        }
        if let Some(tags) = value.get_mut("tags").and_then(Value::as_array_mut) {
            for tag in tags {
                let Some(object) = tag.as_object_mut() else {
                    continue;
                };
                let Some(id) = object
                    .remove("id")
                    .and_then(|value| value.as_str().map(str::to_owned))
                else {
                    continue;
                };
                let updated_at = object
                    .remove("updatedAt")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default();
                let reference = fence.bind(BoundResource::MaterialTag {
                    tag_id: id,
                    updated_at,
                });
                object.insert("tagRef".to_owned(), Value::String(reference));
            }
        }
        Ok(value)
    }

    fn material_tag_map(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let references = args
            .get("resourceRefs")
            .and_then(Value::as_array)
            .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))?;
        let mut ids = Vec::new();
        let mut owned_refs = Vec::new();
        for reference in references.iter().take(64) {
            let reference = reference
                .as_str()
                .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))?;
            ids.push(material_ref(fence, reference)?.0);
            owned_refs.push(reference.to_owned());
        }
        let raw = self
            .materials
            .tag_map(ids.clone())
            .map_err(material_error)?;
        let object = raw
            .as_object()
            .ok_or_else(|| DshResourceError::new("dsh-resource-response-invalid"))?;
        let items = ids
            .iter()
            .zip(owned_refs)
            .map(|(id, resource_ref)| {
                json!({
                    "resourceRef": resource_ref,
                    "tags": object.get(id).cloned().unwrap_or_else(|| json!([])),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "items": items }))
    }

    fn material_change(&self, fence: &mut SessionFence) -> Result<Value, DshResourceError> {
        let raw = self.materials.change_snapshot().map_err(material_error)?;
        let mut refs = Vec::new();
        for id in raw
            .get("affectedIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(200)
        {
            if let Ok(item) = self.materials.inspect(id) {
                refs.push(fence.bind(BoundResource::Material {
                    asset_id: item.id,
                    revision: item.revision,
                }));
            }
        }
        Ok(json!({
            "version": raw.get("version").cloned().unwrap_or(Value::Null),
            "reason": raw.get("reason").cloned().unwrap_or(Value::Null),
            "affectedRefs": refs,
            "foldersChanged": raw.get("foldersChanged").cloned().unwrap_or(Value::Bool(false)),
            "occurredAt": raw.get("occurredAt").cloned().unwrap_or(Value::Null),
        }))
    }

    fn material_missing(&self, fence: &mut SessionFence) -> Result<Value, DshResourceError> {
        let raw = self.materials.missing_assets().map_err(material_error)?;
        let mut items = Vec::new();
        for value in raw
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(200)
        {
            let Some(id) = value.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Ok(item) = self.materials.inspect(id) {
                let resource_ref = fence.bind(BoundResource::Material {
                    asset_id: item.id,
                    revision: item.revision,
                });
                items.push(json!({ "resourceRef": resource_ref, "name": item.name }));
            }
        }
        Ok(json!({ "items": items }))
    }

    fn material_asset_mutation(
        &self,
        fence: &mut SessionFence,
        operation: &str,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let reference = required_string(args, "resourceRef", 128)?.to_owned();
        let (asset_id, revision) = material_ref(fence, &reference)?;
        match operation {
            "luckyray_materials_update" => {
                let patch = serde_json::from_value::<MaterialAssetPatch>(
                    args.get("patch").cloned().unwrap_or_else(|| json!({})),
                )
                .map_err(|_| DshResourceError::new("dsh-resource-arguments-invalid"))?;
                let item = self
                    .materials
                    .update_metadata(&asset_id, &revision, patch)
                    .map_err(material_error)?;
                return Ok(
                    json!({ "resource": material_summary_value(fence, item), "committed": true }),
                );
            }
            "luckyray_materials_set_tags" => {
                let tag_refs = string_array(args, "tagRefs", 64)?;
                let mut tag_ids = Vec::new();
                for tag_ref in tag_refs {
                    tag_ids.push(material_tag_ref(fence, &tag_ref)?.0);
                }
                let item = self
                    .materials
                    .set_tags(crate::agent_materials::MaterialSetTagsInput {
                        asset_id,
                        expected_revision: revision,
                        tag_ids,
                    })
                    .map_err(material_error)?;
                return Ok(
                    json!({ "resource": material_summary_value(fence, item), "committed": true }),
                );
            }
            "luckyray_materials_add_tags" => {
                let names = string_array(args, "names", 64)?;
                let item = self
                    .materials
                    .add_tag_names(&asset_id, &revision, &names)
                    .map_err(material_error)?;
                return Ok(
                    json!({ "resource": material_summary_value(fence, item), "committed": true }),
                );
            }
            "luckyray_materials_categorize" | "luckyray_materials_move" => {
                let folder_id = args
                    .get("folderRef")
                    .and_then(Value::as_str)
                    .map(|reference| material_folder_ref(fence, reference).map(|value| value.0))
                    .transpose()?;
                let item = self
                    .materials
                    .categorize(crate::agent_materials::MaterialCategorizeInput {
                        asset_id,
                        expected_revision: revision,
                        folder_id,
                    })
                    .map_err(material_error)?;
                return Ok(
                    json!({ "resource": material_summary_value(fence, item), "committed": true }),
                );
            }
            "luckyray_materials_relocate" => {
                let path = PathBuf::from(required_string(args, "authorizedPath", 32 * 1024)?);
                let options = serde_json::from_value::<MaterialRelocateOptions>(
                    args.get("options").cloned().unwrap_or_else(|| json!({})),
                )
                .map_err(|_| DshResourceError::new("dsh-resource-arguments-invalid"))?;
                let item = self
                    .materials
                    .relocate(&asset_id, &revision, &path, &options)
                    .map_err(material_error)?;
                return Ok(
                    json!({ "resource": material_summary_value(fence, item), "committed": true }),
                );
            }
            "luckyray_materials_rename" => {
                let item = self
                    .materials
                    .rename_file(
                        &asset_id,
                        &revision,
                        required_string(args, "fileName", 256)?,
                    )
                    .map_err(material_error)?;
                return Ok(
                    json!({ "resource": material_summary_value(fence, item), "committed": true }),
                );
            }
            "luckyray_materials_asset_delete" => {
                self.materials
                    .delete(
                        &asset_id,
                        &revision,
                        args.get("deleteFile")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    )
                    .map_err(material_error)?;
            }
            "luckyray_materials_record_delete" => {
                self.materials
                    .remove_record(&asset_id, &revision)
                    .map_err(material_error)?;
            }
            _ => return Err(DshResourceError::new("dsh-resource-operation-unknown")),
        }
        fence.refs.remove(&reference);
        Ok(json!({ "deleted": true, "committed": true }))
    }

    fn material_taxonomy_mutation(
        &self,
        fence: &mut SessionFence,
        operation: &str,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let value = match operation {
            "luckyray_materials_folder_create" => {
                let parent_id = args
                    .get("parentRef")
                    .and_then(Value::as_str)
                    .map(|reference| material_folder_ref(fence, reference).map(|value| value.0))
                    .transpose()?;
                self.materials
                    .create_folder(parent_id, required_string(args, "name", 256)?.to_owned())
                    .map_err(material_error)?
            }
            "luckyray_materials_folder_rename" => {
                let (id, revision) =
                    material_folder_ref(fence, required_string(args, "folderRef", 128)?)?;
                self.materials
                    .rename_folder(&id, &revision, required_string(args, "name", 256)?)
                    .map_err(material_error)?
            }
            "luckyray_materials_folder_move" => {
                let (id, revision) =
                    material_folder_ref(fence, required_string(args, "folderRef", 128)?)?;
                let target_id = args
                    .get("targetRef")
                    .and_then(Value::as_str)
                    .map(|reference| material_folder_ref(fence, reference).map(|value| value.0))
                    .transpose()?;
                self.materials
                    .move_folder(
                        MaterialFolderMove {
                            id,
                            target_id,
                            position: required_string(args, "position", 16)?.to_owned(),
                        },
                        &revision,
                    )
                    .map_err(material_error)?
            }
            "luckyray_materials_folder_delete" => {
                let (id, revision) =
                    material_folder_ref(fence, required_string(args, "folderRef", 128)?)?;
                self.materials
                    .delete_folder(&id, &revision)
                    .map_err(material_error)?
            }
            "luckyray_materials_tag_create" => self
                .materials
                .create_tag(
                    required_string(args, "name", 120)?,
                    optional_string(args, "color", 64)?,
                )
                .map_err(material_error)?,
            "luckyray_materials_tag_update" => {
                let (id, revision) =
                    material_tag_ref(fence, required_string(args, "tagRef", 128)?)?;
                let patch = serde_json::from_value::<MaterialTagPatch>(
                    args.get("patch").cloned().unwrap_or_else(|| json!({})),
                )
                .map_err(|_| DshResourceError::new("dsh-resource-arguments-invalid"))?;
                self.materials
                    .update_tag(&id, &revision, patch)
                    .map_err(material_error)?
            }
            "luckyray_materials_tag_delete" => {
                let (id, revision) =
                    material_tag_ref(fence, required_string(args, "tagRef", 128)?)?;
                self.materials
                    .delete_tag(&id, &revision)
                    .map_err(material_error)?
            }
            "luckyray_materials_tag_merge" => {
                let (target, target_revision) =
                    material_tag_ref(fence, required_string(args, "targetRef", 128)?)?;
                let mut sources = Vec::new();
                for source in string_array(args, "sourceRefs", 64)? {
                    sources.push(material_tag_ref(fence, &source)?);
                }
                self.materials
                    .merge_tags(&target, &target_revision, sources)
                    .map_err(material_error)?
            }
            _ => return Err(DshResourceError::new("dsh-resource-operation-unknown")),
        };
        let _ = value;
        Ok(json!({ "taxonomy": self.material_taxonomy(fence)?, "committed": true }))
    }

    fn material_import(
        &self,
        fence: &mut SessionFence,
        args: &Value,
    ) -> Result<Value, DshResourceError> {
        let path = PathBuf::from(required_string(args, "authorizedPath", 32 * 1024)?);
        let options = serde_json::from_value::<MaterialImportOptions>(
            args.get("options").cloned().unwrap_or_else(|| json!({})),
        )
        .map_err(|_| DshResourceError::new("dsh-resource-arguments-invalid"))?;
        let raw = self
            .materials
            .import_authorized_path(&path, &options)
            .map_err(material_error)?;
        let mut assets = Vec::new();
        for value in raw
            .get("assets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(200)
        {
            let Some(id) = value.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Ok(item) = self.materials.inspect(id) {
                assets.push(material_summary_value(fence, item));
            }
        }
        Ok(json!({
            "importedCount": raw.get("importedCount").cloned().unwrap_or(json!(0)),
            "skippedDuplicateCount": raw.get("skippedDuplicateCount").cloned().unwrap_or(json!(0)),
            "failedCount": raw.get("failedCount").cloned().unwrap_or(json!(0)),
            "assets": assets,
            "committed": true,
        }))
    }

    fn material_migrate(&self, args: &Value) -> Result<Value, DshResourceError> {
        let source = PathBuf::from(required_string(args, "authorizedSourcePath", 32 * 1024)?);
        let target = PathBuf::from(required_string(args, "authorizedTargetPath", 32 * 1024)?);
        self.materials
            .migrate_library(&source, &target)
            .map(safe_admin_result)
            .map_err(material_error)
    }

    fn material_retry_pending(&self) -> Result<Value, DshResourceError> {
        self.materials
            .retry_pending_deletions()
            .map(safe_admin_result)
            .map_err(material_error)
    }

    fn material_thumbnail_cleanup(&self) -> Result<Value, DshResourceError> {
        self.materials
            .clear_thumbnail_references()
            .map_err(material_error)
    }
}

fn operation_access(operation: &str) -> Result<ResourceAccess, DshResourceError> {
    resource_operation_inventory()?
        .iter()
        .find_map(|(id, access)| (id == operation).then_some(*access))
        .ok_or_else(|| DshResourceError::new("dsh-resource-operation-unknown"))
}

fn validate_generation_and_session(
    generation: u64,
    session_id: &str,
) -> Result<(), DshResourceError> {
    if generation == 0
        || session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(DshResourceError::new("dsh-resource-context-invalid"));
    }
    Ok(())
}

fn validate_policy(approval_policy: &str, workspace_root: &str) -> Result<(), DshResourceError> {
    if !matches!(approval_policy, "ask" | "never") || workspace_root.len() > 32 * 1024 {
        return Err(DshResourceError::new("dsh-resource-policy-invalid"));
    }
    Ok(())
}

fn validate_call(call: &DshResourceCallEnvelope) -> Result<(), DshResourceError> {
    validate_policy(&call.approval_policy, &call.workspace_root)?;
    if call.mode == EffectiveMode::WorkspaceWrite && call.workspace_root.is_empty() {
        return Err(DshResourceError::new("dsh-resource-policy-invalid"));
    }
    for value in [&call.call_id, &call.root_call_id] {
        if value.is_empty() || value.len() > 192 {
            return Err(DshResourceError::new("dsh-resource-call-invalid"));
        }
    }
    if !matches!(call.approval.as_str(), "not-required" | "allowed-once") {
        return Err(DshResourceError::new("dsh-resource-approval-invalid"));
    }
    Ok(())
}

fn call_fingerprint(call: &DshResourceCallEnvelope) -> Result<String, DshResourceError> {
    let encoded = serde_json::to_vec(&json!({
        "sessionId": call.session_id,
        "policySeq": call.policy_seq,
        "mode": call.mode,
        "approvalPolicy": call.approval_policy,
        "workspaceRoot": call.workspace_root,
        "rootCallId": call.root_call_id,
        "operation": call.operation,
        "approval": call.approval,
        "args": call.args,
    }))
    .map_err(|_| DshResourceError::new("dsh-resource-call-invalid"))?;
    Ok(format!("{:x}", sha2::Sha256::digest(encoded)))
}

fn required_string<'a>(
    args: &'a Value,
    key: &str,
    maximum: usize,
) -> Result<&'a str, DshResourceError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= maximum)
        .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))
}

fn optional_string(
    args: &Value,
    key: &str,
    maximum: usize,
) -> Result<Option<String>, DshResourceError> {
    args.get(key)
        .map(|value| {
            value
                .as_str()
                .filter(|value| value.len() <= maximum)
                .map(str::to_owned)
                .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))
        })
        .transpose()
}

fn bounded_limit(args: &Value, fallback: usize) -> usize {
    args.get("limit")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(fallback)
        .clamp(1, 200)
}

fn from_args<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, DshResourceError> {
    serde_json::from_value(args.clone())
        .map_err(|_| DshResourceError::new("dsh-resource-arguments-invalid"))
}

fn knowledge_ref(
    fence: &mut SessionFence,
    reference: &str,
) -> Result<(KnowledgeDocumentRef, String, KnowledgeTargetIdentity), DshResourceError> {
    fence.sweep();
    match fence.refs.get(reference).map(|bound| &bound.value) {
        Some(BoundResource::Knowledge {
            document_ref,
            revision,
            target,
        }) => Ok((document_ref.clone(), revision.clone(), target.clone())),
        _ => Err(DshResourceError::new("dsh-resource-ref-invalid")),
    }
}

fn material_ref_from_args(
    fence: &mut SessionFence,
    args: &Value,
) -> Result<(String, String), DshResourceError> {
    let reference = required_string(args, "resourceRef", 128)?;
    fence.sweep();
    match fence.refs.get(reference).map(|bound| &bound.value) {
        Some(BoundResource::Material { asset_id, revision }) => {
            Ok((asset_id.clone(), revision.clone()))
        }
        _ => Err(DshResourceError::new("dsh-resource-ref-invalid")),
    }
}

fn material_ref(
    fence: &mut SessionFence,
    reference: &str,
) -> Result<(String, String), DshResourceError> {
    fence.sweep();
    match fence.refs.get(reference).map(|bound| &bound.value) {
        Some(BoundResource::Material { asset_id, revision }) => {
            Ok((asset_id.clone(), revision.clone()))
        }
        _ => Err(DshResourceError::new("dsh-resource-ref-invalid")),
    }
}

fn material_folder_ref(
    fence: &mut SessionFence,
    reference: &str,
) -> Result<(String, String), DshResourceError> {
    fence.sweep();
    match fence.refs.get(reference).map(|bound| &bound.value) {
        Some(BoundResource::MaterialFolder {
            folder_id,
            updated_at,
        }) => Ok((folder_id.clone(), updated_at.clone())),
        _ => Err(DshResourceError::new("dsh-resource-ref-invalid")),
    }
}

fn material_tag_ref(
    fence: &mut SessionFence,
    reference: &str,
) -> Result<(String, String), DshResourceError> {
    fence.sweep();
    match fence.refs.get(reference).map(|bound| &bound.value) {
        Some(BoundResource::MaterialTag { tag_id, updated_at }) => {
            Ok((tag_id.clone(), updated_at.clone()))
        }
        _ => Err(DshResourceError::new("dsh-resource-ref-invalid")),
    }
}

fn material_summary_value(
    fence: &mut SessionFence,
    item: crate::agent_materials::AgentMaterialSummary,
) -> Value {
    let resource_ref = fence.bind(BoundResource::Material {
        asset_id: item.id,
        revision: item.revision.clone(),
    });
    json!({
        "resourceRef": resource_ref,
        "name": item.name,
        "kind": item.kind,
        "mimeType": item.mime_type,
        "sizeBytes": item.size_bytes,
        "description": item.description,
        "rating": item.rating,
        "dominantColor": item.dominant_color,
        "tagCount": item.tag_ids.len(),
        "importedAt": item.imported_at,
        "updatedAt": item.updated_at,
        "revision": item.revision,
    })
}

fn string_array(args: &Value, key: &str, maximum: usize) -> Result<Vec<String>, DshResourceError> {
    let values = args
        .get(key)
        .and_then(Value::as_array)
        .filter(|values| values.len() <= maximum)
        .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 512)
                .map(str::to_owned)
                .ok_or_else(|| DshResourceError::new("dsh-resource-arguments-invalid"))
        })
        .collect()
}

fn redact_material_identity(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("assetId");
        object.remove("id");
        object.remove("folderId");
        object.remove("tagIds");
        object.remove("originalPath");
        object.remove("libraryPath");
        object.remove("thumbnailUrl");
    }
    value
}

fn safe_admin_result(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(safe_admin_result).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .filter(|(key, _)| {
                    let normalized = key.to_ascii_lowercase();
                    !normalized.ends_with("id")
                        && !normalized.ends_with("ids")
                        && !normalized.contains("path")
                        && !normalized.contains("digest")
                        && !normalized.contains("locator")
                })
                .map(|(key, value)| (key, safe_admin_result(value)))
                .collect(),
        ),
        other => other,
    }
}

fn knowledge_error(error: crate::knowledge::KnowledgeError) -> DshResourceError {
    match error.code {
        "knowledge-revision-conflict" => DshResourceError::new("dsh-resource-revision-stale"),
        "knowledge-target-not-current"
        | "knowledge-vault-changed"
        | "knowledge-vault-not-current" => DshResourceError::new("dsh-resource-identity-stale"),
        _ => DshResourceError::new("dsh-resource-operation-failed"),
    }
}

fn material_error(error: crate::agent_materials::AgentMaterialError) -> DshResourceError {
    match error.code {
        "material-revision-conflict" => DshResourceError::new("dsh-resource-revision-stale"),
        "material-not-found" | "material-folder-not-found" | "material-tag-not-found" => {
            DshResourceError::new("dsh-resource-identity-stale")
        }
        _ => DshResourceError::new("dsh-resource-operation-failed"),
    }
}

fn web_error(error: crate::web_tools::WebToolError) -> DshResourceError {
    DshResourceError::new(error.code)
}

fn browser_error(error: crate::agent_browser::AgentBrowserError) -> DshResourceError {
    DshResourceError::new(error.code)
}

fn resource_scope(host_generation: u64, session_id: &str) -> [u8; 32] {
    let mut digest = sha2::Sha256::new();
    digest.update(b"luckyray-dsh-resource-scope-v1\0");
    digest.update(host_generation.to_le_bytes());
    digest.update(session_id.as_bytes());
    digest.finalize().into()
}

fn opaque_ref() -> String {
    let mut bytes = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut value = String::from("rr-");
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::KnowledgeVaultRegistration;
    use crate::web_tools::SearchSettingsUpdate;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};

    fn fixture_with_backend() -> (
        tempfile::TempDir,
        Arc<crate::backend::BackendServices>,
        DshResourceBroker,
    ) {
        fixture_with_agent_browser(None)
    }

    fn fixture_with_agent_browser(
        agent_browser: Option<crate::agent_browser::AgentBrowserRuntime>,
    ) -> (
        tempfile::TempDir,
        Arc<crate::backend::BackendServices>,
        DshResourceBroker,
    ) {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path().join("vault");
        std::fs::create_dir_all(vault.join(".luckyray")).unwrap();
        let registration = KnowledgeVaultRegistration {
            id: "vault-resource-test".to_owned(),
            name: "Resource Test".to_owned(),
            root_path: vault.to_string_lossy().to_string(),
            mode: "vault-bound".to_owned(),
            created_at: "2026-08-24T00:00:00Z".to_owned(),
            last_opened_at: "2026-08-24T00:00:00Z".to_owned(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            vault.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&registration).unwrap(),
        )
        .unwrap();
        let mut backend = crate::backend::BackendServices::initialize(root.path()).unwrap();
        if let Some(agent_browser) = agent_browser {
            backend.install_agent_browser_for_test(agent_browser);
        }
        let backend = Arc::new(backend);
        backend
            .knowledge()
            .register_current_vault(&registration)
            .unwrap();
        let broker = DshResourceBroker::new(backend);
        (root, Arc::clone(&broker.backend), broker)
    }

    fn fixture() -> (tempfile::TempDir, DshResourceBroker) {
        let (root, _backend, broker) = fixture_with_backend();
        (root, broker)
    }

    fn policy(mode: EffectiveMode, seq: i64) -> DshResourcePolicyEnvelope {
        DshResourcePolicyEnvelope {
            session_id: "session-resource".to_owned(),
            policy_seq: seq,
            mode,
            approval_policy: "ask".to_owned(),
            workspace_root: r"C:\workspace".to_owned(),
        }
    }

    fn call(
        operation: &str,
        mode: EffectiveMode,
        seq: i64,
        args: Value,
    ) -> DshResourceCallEnvelope {
        DshResourceCallEnvelope {
            session_id: "session-resource".to_owned(),
            policy_seq: seq,
            mode,
            approval_policy: "ask".to_owned(),
            workspace_root: r"C:\workspace".to_owned(),
            call_id: format!("call-{operation}"),
            root_call_id: format!("call-{operation}"),
            operation: operation.to_owned(),
            approval: "not-required".to_owned(),
            args,
        }
    }

    fn call_with(
        session_id: &str,
        call_id: &str,
        operation: &str,
        mode: EffectiveMode,
        seq: i64,
        approval: &str,
        args: Value,
    ) -> DshResourceCallEnvelope {
        DshResourceCallEnvelope {
            session_id: session_id.to_owned(),
            policy_seq: seq,
            mode,
            approval_policy: "ask".to_owned(),
            workspace_root: if mode == EffectiveMode::WorkspaceWrite {
                r"C:\workspace".to_owned()
            } else {
                String::new()
            },
            call_id: call_id.to_owned(),
            root_call_id: call_id.to_owned(),
            operation: operation.to_owned(),
            approval: approval.to_owned(),
            args,
        }
    }

    fn policy_for(session_id: &str, mode: EffectiveMode, seq: i64) -> DshResourcePolicyEnvelope {
        let mut value = policy(mode, seq);
        value.session_id = session_id.to_owned();
        if mode != EffectiveMode::WorkspaceWrite {
            value.workspace_root.clear();
        }
        value
    }

    #[test]
    fn inventory_is_unique_complete_and_policy_classified() {
        let inventory = resource_operation_inventory().unwrap();
        assert_eq!(inventory.len(), 62);
        let ids = inventory
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), inventory.len());
        assert_eq!(
            inventory
                .iter()
                .map(|(id, access)| (id.as_str(), *access))
                .collect::<Vec<_>>(),
            DSH_RESOURCE_OPERATION_INVENTORY
        );
    }

    #[test]
    fn dsh_web_search_uses_backend_owned_settings_and_scope() {
        let (_root, backend, broker) = fixture_with_backend();
        broker
            .sync_policy(7, policy(EffectiveMode::ReadOnly, 0))
            .unwrap();
        let error = broker
            .execute(
                7,
                call(
                    "luckyray_web_search",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({ "query": "official DSH search", "limit": 5 }),
                ),
            )
            .unwrap_err();
        assert_eq!(error.code, "web-network-disabled");

        backend
            .web_tools()
            .expire_scope_for_test(resource_scope(7, "session-resource"));
        let mut renewed_call = call(
            "luckyray_web_search",
            EffectiveMode::ReadOnly,
            0,
            json!({ "query": "official DSH search after expiry", "limit": 5 }),
        );
        renewed_call.call_id = "call-web-search-after-expiry".to_owned();
        renewed_call.root_call_id = renewed_call.call_id.clone();
        let error = broker.execute(7, renewed_call).unwrap_err();
        assert_eq!(error.code, "web-network-disabled");
    }

    #[test]
    fn dsh_browser_rejects_an_unissued_navigation_ref_inside_the_session_scope() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(7, policy(EffectiveMode::ReadOnly, 0))
            .unwrap();
        let error = broker
            .execute(
                7,
                call(
                    "luckyray_browser_open",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({ "navigationRef": format!("nav-{}", "Z".repeat(48)) }),
                ),
            )
            .unwrap_err();
        assert_eq!(error.code, "agent-browser-reference-invalid");
    }

    #[test]
    fn dsh_web_search_and_fetch_preserve_server_owned_secrets_and_session_refs() {
        let fetch_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let fetch_address = fetch_listener.local_addr().unwrap();
        let fetch_server = std::thread::spawn(move || {
            let (mut socket, _) = fetch_listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let read = socket.read(&mut request).unwrap();
            let body = b"official-dsh-web-observation";
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let search_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let search_address = search_listener.local_addr().unwrap();
        let search_server = std::thread::spawn(move || {
            let (mut socket, _) = search_listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
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
                    String::from_utf8_lossy(&request[..index])
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
                "{{\"results\":[{{\"url\":\"http://{fetch_address}/article?token=PRIVATE\",\"title\":\"Official result\",\"content\":\"bounded snippet\"}}]}}"
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });

        let (_root, backend, broker) = fixture_with_backend();
        backend.web_tools().enable_result_loopback_for_test();
        backend
            .web_tools()
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "searxng".to_owned(),
                    tavily_api_key: None,
                    clear_tavily_api_key: false,
                    searxng_endpoint: Some(format!("http://{search_address}/search")),
                    clear_searxng_endpoint: false,
                    searxng_allow_local: true,
                },
            )
            .unwrap();
        broker
            .sync_policy(7, policy(EffectiveMode::ReadOnly, 0))
            .unwrap();
        let searched = broker
            .execute(
                7,
                call(
                    "luckyray_web_search",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({ "query": "official DSH query", "limit": 5 }),
                ),
            )
            .unwrap();
        let request = search_server.join().unwrap();
        assert!(request.starts_with("POST /search HTTP/1.1\r\n"));
        assert!(!request.starts_with("POST /search?"));
        assert!(request.contains("q=official+DSH+query"));
        assert_eq!(searched["adapter"], "searxng");
        let serialized = serde_json::to_string(&searched).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("official DSH query"));
        assert!(!serialized.contains(search_address.to_string().as_str()));
        let fetch_ref = searched["results"][0]["fetchRef"].as_str().unwrap();

        broker
            .sync_policy(7, policy_for("other-session", EffectiveMode::ReadOnly, 0))
            .unwrap();
        let cross_session = broker
            .execute(
                7,
                call_with(
                    "other-session",
                    "other-fetch",
                    "luckyray_web_fetch",
                    EffectiveMode::ReadOnly,
                    0,
                    "not-required",
                    json!({ "fetchRef": fetch_ref }),
                ),
            )
            .unwrap_err();
        assert_eq!(cross_session.code, "web-ref-expired");

        let fetched = broker
            .execute(
                7,
                call(
                    "luckyray_web_fetch",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({ "fetchRef": fetch_ref }),
                ),
            )
            .unwrap();
        assert_eq!(fetched["text"], "official-dsh-web-observation");
        assert!(!serde_json::to_string(&fetched).unwrap().contains("PRIVATE"));
        assert!(fetch_server
            .join()
            .unwrap()
            .starts_with("GET /article?token=PRIVATE HTTP/1.1\r\n"));
        assert_eq!(backend.web_tools().retained_scope_count(), 2);
        broker.retire_generation(7);
        assert_eq!(backend.web_tools().retained_scope_count(), 0);
    }

    #[test]
    fn dsh_search_drives_the_isolated_agent_browser_and_generation_cleanup() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stopping = Arc::new(AtomicBool::new(false));
        let server_stopping = Arc::clone(&stopping);
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            while !server_stopping.load(Ordering::Acquire) {
                let (mut socket, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("browser fixture accept failed: {error}"),
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 2048];
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
                        String::from_utf8_lossy(&request[..index])
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
                let request = String::from_utf8_lossy(&request).into_owned();
                let first_line = request.lines().next().unwrap_or_default().to_owned();
                requests.push(first_line.clone());
                let (content_type, body) = if first_line.contains(" /search ") {
                    (
                        "application/json",
                        format!(
                            "{{\"results\":[{{\"url\":\"http://{address}/article\",\"title\":\"DSH browser fixture\",\"content\":\"Open the isolated page\"}}]}}"
                        ),
                    )
                } else if first_line.contains(" /article ") {
                    (
                        "text/html; charset=utf-8",
                        "<!doctype html><html><head><title>Official DSH Browser</title></head><body><main><h1>Official DSH browser observation</h1><p>isolated rendered content</p><a href='/next'>Next</a></main></body></html>".to_owned(),
                    )
                } else {
                    ("text/plain", "fixture auxiliary response".to_owned())
                };
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            requests
        });

        let runtime = crate::agent_browser::AgentBrowserRuntime::exact_loopback_for_test(address)
            .expect("isolated Agent Browser host is available");
        let runtime_observer = runtime.clone();
        let (_root, backend, broker) = fixture_with_agent_browser(Some(runtime));
        backend.web_tools().enable_result_loopback_for_test();
        backend
            .web_tools()
            .update_settings(
                &backend,
                SearchSettingsUpdate {
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
        broker
            .sync_policy(11, policy(EffectiveMode::ReadOnly, 0))
            .unwrap();
        let searched = broker
            .execute(
                11,
                call(
                    "luckyray_web_search",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({ "query": "open official DSH fixture", "limit": 5 }),
                ),
            )
            .unwrap();
        let navigation_ref = searched["results"][0]["navigationRef"]
            .as_str()
            .expect("search result gets an opaque Agent Browser navigation ref");
        assert!(navigation_ref.starts_with("nav-") && navigation_ref.len() == 52);
        assert!(searched["results"][0].get("url").is_none());
        assert!(searched["results"][0]["fetchRef"]
            .as_str()
            .is_some_and(|reference| reference.starts_with("wref-")));
        let opened = broker
            .execute(
                11,
                call(
                    "luckyray_browser_open",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({ "navigationRef": navigation_ref }),
                ),
            )
            .unwrap();
        assert_eq!(opened["state"], "ready");
        assert_eq!(opened["sourceKind"], "browser");
        let browser_ref = opened["browserRef"].as_str().unwrap();
        let read = broker
            .execute(
                11,
                call(
                    "luckyray_browser_read",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({ "browserRef": browser_ref }),
                ),
            )
            .unwrap();
        assert!(read["visibleText"]
            .as_str()
            .is_some_and(|text| text.contains("isolated rendered content")));
        let extracted = broker
            .execute(
                11,
                call(
                    "luckyray_browser_extract",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({ "browserRef": browser_ref, "kind": "headings" }),
                ),
            )
            .unwrap();
        assert_eq!(extracted["kind"], "headings");
        broker
            .sync_policy(
                11,
                policy_for("other-browser-session", EffectiveMode::ReadOnly, 0),
            )
            .unwrap();
        let cross_session = broker
            .execute(
                11,
                call_with(
                    "other-browser-session",
                    "other-browser-read",
                    "luckyray_browser_read",
                    EffectiveMode::ReadOnly,
                    0,
                    "not-required",
                    json!({ "browserRef": browser_ref }),
                ),
            )
            .unwrap_err();
        assert_eq!(cross_session.code, "agent-browser-reference-invalid");
        assert_eq!(runtime_observer.retained_scope_count(), 2);

        broker
            .sync_policy(
                11,
                policy_for("session-resource", EffectiveMode::ReadOnly, 1),
            )
            .unwrap();
        assert_eq!(runtime_observer.retained_scope_count(), 1);
        broker
            .sync_policy(
                11,
                policy_for("other-browser-session", EffectiveMode::ReadOnly, 1),
            )
            .unwrap();
        assert_eq!(runtime_observer.retained_scope_count(), 0);

        let searched_again = broker
            .execute(
                11,
                call_with(
                    "session-resource",
                    "search-after-turn-end",
                    "luckyray_web_search",
                    EffectiveMode::ReadOnly,
                    1,
                    "not-required",
                    json!({ "query": "reopen official DSH fixture", "limit": 5 }),
                ),
            )
            .unwrap();
        let navigation_ref = searched_again["results"][0]["navigationRef"]
            .as_str()
            .unwrap();
        broker
            .execute(
                11,
                call_with(
                    "session-resource",
                    "browser-open-after-turn-end",
                    "luckyray_browser_open",
                    EffectiveMode::ReadOnly,
                    1,
                    "not-required",
                    json!({ "navigationRef": navigation_ref }),
                ),
            )
            .unwrap();
        assert_eq!(runtime_observer.retained_scope_count(), 1);
        broker.retire_generation(11);
        assert_eq!(runtime_observer.retained_scope_count(), 0);
        stopping.store(true, Ordering::Release);
        let _ = TcpStream::connect(address);
        let requests = server.join().unwrap();
        assert!(requests.iter().any(|line| line.contains(" /search ")));
        assert!(requests.iter().any(|line| line.contains(" /article ")));
    }

    #[test]
    fn generation_retirement_never_waits_on_a_held_session_fence() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(17, policy(EffectiveMode::ReadOnly, 0))
            .unwrap();
        let fence = broker
            .state
            .lock()
            .unwrap()
            .sessions
            .get(&(17, "session-resource".to_owned()))
            .cloned()
            .unwrap();
        let held_fence = fence.lock().unwrap();
        let retiring = broker.clone();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let retirement = std::thread::spawn(move || {
            retiring.retire_generation(17);
            finished_tx.send(()).unwrap();
        });
        let finished_without_fence = finished_rx.recv_timeout(Duration::from_secs(1)).is_ok();
        drop(held_fence);
        retirement.join().unwrap();
        assert!(
            finished_without_fence,
            "generation retirement must not acquire SessionFence while holding BrokerState"
        );
    }

    #[test]
    fn read_only_lists_bounded_refs_and_denies_create_before_effect() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(7, policy(EffectiveMode::ReadOnly, 0))
            .unwrap();
        let listed = broker
            .execute(
                7,
                call(
                    "luckyray_knowledge_list",
                    EffectiveMode::ReadOnly,
                    0,
                    json!({}),
                ),
            )
            .unwrap();
        assert_eq!(listed["items"].as_array().unwrap().len(), 0);
        let denied = broker.execute(
            7,
            call(
                "luckyray_knowledge_create",
                EffectiveMode::ReadOnly,
                0,
                json!({ "title": "Denied", "content": "write0" }),
            ),
        );
        assert_eq!(denied.unwrap_err().code, "dsh-resource-policy-denied");
        assert!(broker.knowledge.list_documents().unwrap().is_empty());
    }

    #[test]
    fn mode_matrix_has_no_hidden_full_access_ceiling_and_read_only_denies_every_effect_family() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(
                7,
                policy_for("session-resource", EffectiveMode::ReadOnly, 0),
            )
            .unwrap();
        for (index, (operation, access)) in DSH_RESOURCE_OPERATION_INVENTORY.iter().enumerate() {
            assert!(
                EffectiveMode::DangerFullAccess.permits(*access),
                "{operation}"
            );
            if *access == ResourceAccess::Full {
                assert!(
                    !EffectiveMode::WorkspaceWrite.permits(*access),
                    "{operation}"
                );
            }
            if access.is_mutating() {
                let denied = broker.execute(
                    7,
                    call_with(
                        "session-resource",
                        &format!("deny-{index}"),
                        operation,
                        EffectiveMode::ReadOnly,
                        0,
                        "not-required",
                        json!({}),
                    ),
                );
                assert_eq!(
                    denied.unwrap_err().code,
                    "dsh-resource-policy-denied",
                    "{operation}"
                );
            }
        }
        assert!(broker.knowledge.list_documents().unwrap().is_empty());
    }

    #[test]
    fn knowledge_refs_are_session_generation_revision_and_policy_bound() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(7, policy_for("session-a", EffectiveMode::WorkspaceWrite, 0))
            .unwrap();
        let created = broker
            .execute(
                7,
                call_with(
                    "session-a",
                    "create-a",
                    "luckyray_knowledge_create",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "title": "Bound", "content": "alpha" }),
                ),
            )
            .unwrap();
        let reference = created["resourceRef"].as_str().unwrap().to_owned();
        let read = broker
            .execute(
                7,
                call_with(
                    "session-a",
                    "read-a",
                    "luckyray_knowledge_read",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "resourceRef": reference }),
                ),
            )
            .unwrap();
        assert_eq!(read["content"], "alpha");

        broker
            .sync_policy(7, policy_for("session-b", EffectiveMode::ReadOnly, 0))
            .unwrap();
        assert_eq!(
            broker
                .execute(
                    7,
                    call_with(
                        "session-b",
                        "cross-read",
                        "luckyray_knowledge_read",
                        EffectiveMode::ReadOnly,
                        0,
                        "not-required",
                        json!({ "resourceRef": created["resourceRef"] }),
                    ),
                )
                .unwrap_err()
                .code,
            "dsh-resource-ref-invalid"
        );

        broker
            .sync_policy(7, policy_for("session-a", EffectiveMode::ReadOnly, 1))
            .unwrap();
        assert_eq!(
            broker
                .execute(
                    7,
                    call_with(
                        "session-a",
                        "stale-write",
                        "luckyray_knowledge_append",
                        EffectiveMode::WorkspaceWrite,
                        0,
                        "not-required",
                        json!({ "resourceRef": created["resourceRef"], "content": "beta" }),
                    ),
                )
                .unwrap_err()
                .code,
            "dsh-resource-policy-stale"
        );
        broker.retire_generation(7);
        assert_eq!(
            broker
                .execute(
                    7,
                    call_with(
                        "session-a",
                        "retired-read",
                        "luckyray_knowledge_read",
                        EffectiveMode::ReadOnly,
                        1,
                        "not-required",
                        json!({ "resourceRef": created["resourceRef"] }),
                    ),
                )
                .unwrap_err()
                .code,
            "dsh-resource-policy-unavailable"
        );
    }

    #[test]
    fn call_identity_replay_cannot_alias_another_operation_or_payload() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(3, policy_for("session-a", EffectiveMode::ReadOnly, 0))
            .unwrap();
        broker
            .execute(
                3,
                call_with(
                    "session-a",
                    "same-call",
                    "luckyray_knowledge_list",
                    EffectiveMode::ReadOnly,
                    0,
                    "not-required",
                    json!({}),
                ),
            )
            .unwrap();
        assert_eq!(
            broker
                .execute(
                    3,
                    call_with(
                        "session-a",
                        "same-call",
                        "luckyray_knowledge_recent",
                        EffectiveMode::ReadOnly,
                        0,
                        "not-required",
                        json!({}),
                    ),
                )
                .unwrap_err()
                .code,
            "dsh-resource-call-replayed"
        );
    }

    #[test]
    fn destructive_knowledge_effect_requires_official_one_shot_approval() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(5, policy_for("session-a", EffectiveMode::WorkspaceWrite, 0))
            .unwrap();
        let created = broker
            .execute(
                5,
                call_with(
                    "session-a",
                    "create",
                    "luckyray_knowledge_create",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "title": "Approval", "content": "keep" }),
                ),
            )
            .unwrap();
        let reference = created["resourceRef"].as_str().unwrap();
        let denied = broker.execute(
            5,
            call_with(
                "session-a",
                "delete-denied",
                "luckyray_knowledge_delete",
                EffectiveMode::WorkspaceWrite,
                0,
                "not-required",
                json!({ "resourceRef": reference }),
            ),
        );
        assert_eq!(denied.unwrap_err().code, "dsh-resource-approval-required");
        assert_eq!(broker.knowledge.list_documents().unwrap().len(), 1);
    }

    #[test]
    fn workspace_never_cannot_bypass_destructive_approval_but_full_never_remains_complete() {
        let (_root, broker) = fixture();
        let mut workspace_policy =
            policy_for("session-workspace", EffectiveMode::WorkspaceWrite, 0);
        workspace_policy.approval_policy = "never".to_owned();
        broker.sync_policy(6, workspace_policy).unwrap();
        let mut create = call_with(
            "session-workspace",
            "create-workspace-never",
            "luckyray_knowledge_create",
            EffectiveMode::WorkspaceWrite,
            0,
            "not-required",
            json!({ "title": "Workspace never", "content": "keep" }),
        );
        create.approval_policy = "never".to_owned();
        let created = broker.execute(6, create).unwrap();
        let mut denied_delete = call_with(
            "session-workspace",
            "delete-workspace-never",
            "luckyray_knowledge_delete",
            EffectiveMode::WorkspaceWrite,
            0,
            "not-required",
            json!({ "resourceRef": created["resourceRef"] }),
        );
        denied_delete.approval_policy = "never".to_owned();
        assert_eq!(
            broker.execute(6, denied_delete).unwrap_err().code,
            "dsh-resource-approval-required"
        );

        let mut full_policy = policy_for("session-full", EffectiveMode::DangerFullAccess, 0);
        full_policy.approval_policy = "never".to_owned();
        broker.sync_policy(6, full_policy).unwrap();
        let mut full_create = call_with(
            "session-full",
            "create-full-never",
            "luckyray_knowledge_create",
            EffectiveMode::DangerFullAccess,
            0,
            "not-required",
            json!({ "title": "Full never", "content": "delete" }),
        );
        full_create.approval_policy = "never".to_owned();
        let full_created = broker.execute(6, full_create).unwrap();
        let mut full_delete = call_with(
            "session-full",
            "delete-full-never",
            "luckyray_knowledge_delete",
            EffectiveMode::DangerFullAccess,
            0,
            "not-required",
            json!({ "resourceRef": full_created["resourceRef"] }),
        );
        full_delete.approval_policy = "never".to_owned();
        let deleted = broker.execute(6, full_delete).unwrap();
        assert_eq!(deleted["committed"], true);
    }

    #[test]
    fn material_import_returns_only_opaque_refs_and_revision_cas_rejects_stale_mutation() {
        let (root, broker) = fixture();
        let source = root.path().join("sample.txt");
        std::fs::write(&source, b"material-body").unwrap();
        broker
            .sync_policy(9, policy_for("session-a", EffectiveMode::WorkspaceWrite, 0))
            .unwrap();
        let imported = broker
            .execute(
                9,
                call_with(
                    "session-a",
                    "import",
                    "luckyray_materials_import_path",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "authorizedPath": source, "options": {} }),
                ),
            )
            .unwrap();
        let resource = &imported["assets"][0];
        assert!(resource.get("resourceRef").is_some());
        assert!(resource.get("id").is_none());
        assert!(!imported
            .to_string()
            .contains(root.path().to_string_lossy().as_ref()));
        let old_ref = resource["resourceRef"].as_str().unwrap().to_owned();
        let updated = broker
            .execute(
                9,
                call_with(
                    "session-a",
                    "update",
                    "luckyray_materials_update",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "resourceRef": old_ref, "patch": { "name": "Updated" } }),
                ),
            )
            .unwrap();
        assert_eq!(updated["resource"]["name"], "Updated");
        assert_eq!(
            broker
                .execute(
                    9,
                    call_with(
                        "session-a",
                        "stale-update",
                        "luckyray_materials_update",
                        EffectiveMode::WorkspaceWrite,
                        0,
                        "not-required",
                        json!({ "resourceRef": old_ref, "patch": { "name": "Stale" } }),
                    ),
                )
                .unwrap_err()
                .code,
            "dsh-resource-revision-stale"
        );
    }

    #[test]
    fn knowledge_same_path_root_replacement_revokes_old_refs_before_read_or_write() {
        let (root, broker) = fixture();
        broker
            .sync_policy(
                12,
                policy_for("session-a", EffectiveMode::WorkspaceWrite, 0),
            )
            .unwrap();
        let created = broker
            .execute(
                12,
                call_with(
                    "session-a",
                    "create",
                    "luckyray_knowledge_create",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "title": "Original", "content": "A-only" }),
                ),
            )
            .unwrap();
        let reference = created["resourceRef"].as_str().unwrap().to_owned();
        let cached_read = || call_with(
            "session-a", "cached-read", "luckyray_knowledge_read",
            EffectiveMode::WorkspaceWrite, 0, "not-required",
            json!({ "resourceRef": reference }),
        );
        let first_read = broker.execute(12, cached_read()).unwrap();
        assert_eq!(first_read["content"], "A-only");
        assert_eq!(broker.execute(12, cached_read()).unwrap(), first_read);
        let vault = root.path().join("vault");
        let old = root.path().join("vault-old");
        std::fs::rename(&vault, &old).unwrap();
        std::fs::create_dir_all(vault.join(".luckyray")).unwrap();
        let registration = KnowledgeVaultRegistration {
            id: "vault-resource-test".to_owned(),
            name: "Resource Test".to_owned(),
            root_path: vault.to_string_lossy().to_string(),
            mode: "vault-bound".to_owned(),
            created_at: "2026-08-24T00:00:00Z".to_owned(),
            last_opened_at: "2026-08-24T00:00:00Z".to_owned(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            vault.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&registration).unwrap(),
        )
        .unwrap();
        std::fs::write(vault.join("Original.md"), "B-marker").unwrap();
        let cached_error = broker.execute(12, cached_read()).unwrap_err();
        assert_eq!(cached_error.code, "dsh-resource-identity-stale");
        let denied = broker.execute(
            12,
            call_with(
                "session-a",
                "read-replaced",
                "luckyray_knowledge_read",
                EffectiveMode::WorkspaceWrite,
                0,
                "not-required",
                json!({ "resourceRef": reference }),
            ),
        );
        let error = denied.unwrap_err();
        assert_eq!(error.code, "dsh-resource-identity-stale");
        assert!(!error.to_string().contains("B-marker"));
    }

    #[test]
    fn cached_knowledge_discovery_rejects_vault_switch_and_fresh_discovery_recovers() {
        let (root, backend, broker) = fixture_with_backend();
        broker.sync_policy(13, policy_for("session-a", EffectiveMode::ReadOnly, 0)).unwrap();
        std::fs::write(root.path().join("vault").join("A.md"), "A-only").unwrap();
        let discovery = |call_id| call_with(
            "session-a", call_id, "luckyray_knowledge_list",
            EffectiveMode::ReadOnly, 0, "not-required", json!({}),
        );
        let first = broker.execute(13, discovery("list-a")).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 1);
        let old_ref = first["items"][0]["resourceRef"].clone();
        let vault = root.path().join("vault-b");
        std::fs::create_dir_all(vault.join(".luckyray")).unwrap();
        let registration = KnowledgeVaultRegistration {
            id: "vault-resource-b".to_owned(), name: "Resource B".to_owned(),
            root_path: vault.to_string_lossy().to_string(), mode: "vault-bound".to_owned(),
            created_at: "2026-08-24T00:00:00Z".to_owned(),
            last_opened_at: "2026-08-24T00:00:00Z".to_owned(),
            schema_version: 1, link_update_policy: Default::default(),
        };
        std::fs::write(vault.join(".luckyray").join("vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        std::fs::write(vault.join("B.md"), "B-only").unwrap();
        backend.knowledge().register_current_vault(&registration).unwrap();
        assert_eq!(broker.execute(13, discovery("list-a")).unwrap_err().code, "dsh-resource-identity-stale");
        let second = broker.execute(13, discovery("list-b")).unwrap();
        assert_eq!(second["items"].as_array().unwrap().len(), 1);
        assert_ne!(second["items"][0]["resourceRef"], old_ref);
        assert_eq!(broker.execute(13, call_with(
            "session-a", "read-old", "luckyray_knowledge_read",
            EffectiveMode::ReadOnly, 0, "not-required", json!({ "resourceRef": old_ref }),
        )).unwrap_err().code, "dsh-resource-identity-stale");
        let read = broker.execute(13, call_with(
            "session-a", "read-new", "luckyray_knowledge_read",
            EffectiveMode::ReadOnly, 0, "not-required",
            json!({ "resourceRef": second["items"][0]["resourceRef"] }),
        )).unwrap();
        assert_eq!(read["content"], "B-only");
    }

    #[test]
    fn mutation_settlement_linearizes_before_permission_narrowing() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(
                13,
                policy_for("session-a", EffectiveMode::WorkspaceWrite, 0),
            )
            .unwrap();
        let created = broker
            .execute(
                13,
                call_with(
                    "session-a",
                    "create-before-race",
                    "luckyray_knowledge_create",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "title": "Race", "content": "before" }),
                ),
            )
            .unwrap();
        let resource_ref = created["resourceRef"].as_str().unwrap().to_owned();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let hook_entered = entered.clone();
        let hook_release = release.clone();
        broker.knowledge.set_after_final_validation_hook(move || {
            hook_entered.wait();
            hook_release.wait();
        });

        let writer = broker.clone();
        let write_ref = resource_ref.clone();
        let write = std::thread::spawn(move || {
            writer.execute(
                13,
                call_with(
                    "session-a",
                    "append-before-narrowing",
                    "luckyray_knowledge_append",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "resourceRef": write_ref, "content": " after" }),
                ),
            )
        });
        entered.wait();

        let narrower = broker.clone();
        let (settled_tx, settled_rx) = std::sync::mpsc::channel();
        let narrowing = std::thread::spawn(move || {
            let result =
                narrower.sync_policy(13, policy_for("session-a", EffectiveMode::ReadOnly, 1));
            settled_tx.send(result).unwrap();
        });
        assert!(
            settled_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "the official policy transition waits for the admitted effect settlement"
        );
        release.wait();
        assert_eq!(write.join().unwrap().unwrap()["committed"], true);
        assert!(settled_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_ok());
        narrowing.join().unwrap();
        assert_eq!(
            broker
                .execute(
                    13,
                    call_with(
                        "session-a",
                        "append-after-narrowing",
                        "luckyray_knowledge_append",
                        EffectiveMode::WorkspaceWrite,
                        0,
                        "not-required",
                        json!({ "resourceRef": resource_ref, "content": " denied" }),
                    ),
                )
                .unwrap_err()
                .code,
            "dsh-resource-policy-stale"
        );
    }

    #[test]
    fn folder_and_tag_refs_are_revision_bound_inside_material_authority() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(
                14,
                policy_for("session-a", EffectiveMode::WorkspaceWrite, 0),
            )
            .unwrap();
        let folder_created = broker
            .execute(
                14,
                call_with(
                    "session-a",
                    "folder-create",
                    "luckyray_materials_folder_create",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "name": "Folder A" }),
                ),
            )
            .unwrap();
        let folder_ref = folder_created["taxonomy"]["folders"][0]["folderRef"]
            .as_str()
            .unwrap()
            .to_owned();
        broker
            .execute(
                14,
                call_with(
                    "session-a",
                    "folder-rename",
                    "luckyray_materials_folder_rename",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "folderRef": folder_ref, "name": "Folder B" }),
                ),
            )
            .unwrap();
        assert_eq!(
            broker
                .execute(
                    14,
                    call_with(
                        "session-a",
                        "folder-stale",
                        "luckyray_materials_folder_rename",
                        EffectiveMode::WorkspaceWrite,
                        0,
                        "not-required",
                        json!({ "folderRef": folder_ref, "name": "Folder C" }),
                    ),
                )
                .unwrap_err()
                .code,
            "dsh-resource-revision-stale"
        );

        let tag_created = broker
            .execute(
                14,
                call_with(
                    "session-a",
                    "tag-create",
                    "luckyray_materials_tag_create",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "name": "Tag A" }),
                ),
            )
            .unwrap();
        assert!(tag_created["taxonomy"]["tags"][0]["tagRef"].is_string());
        assert!(!tag_created.to_string().contains("tag-"));
    }

    #[test]
    fn nested_material_taxonomy_preserves_hierarchy_without_private_ids() {
        let (_root, broker) = fixture();
        broker
            .sync_policy(
                15,
                policy_for("session-a", EffectiveMode::WorkspaceWrite, 0),
            )
            .unwrap();
        let parent = broker
            .execute(
                15,
                call_with(
                    "session-a",
                    "parent-create",
                    "luckyray_materials_folder_create",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "name": "Parent" }),
                ),
            )
            .unwrap();
        let parent_ref = parent["taxonomy"]["folders"][0]["folderRef"]
            .as_str()
            .unwrap()
            .to_owned();
        let child = broker
            .execute(
                15,
                call_with(
                    "session-a",
                    "child-create",
                    "luckyray_materials_folder_create",
                    EffectiveMode::WorkspaceWrite,
                    0,
                    "not-required",
                    json!({ "name": "Child", "parentRef": parent_ref }),
                ),
            )
            .unwrap();
        let folders = child["taxonomy"]["folders"].as_array().unwrap();
        let parent = folders
            .iter()
            .find(|folder| folder["name"] == "Parent")
            .unwrap();
        let nested = folders
            .iter()
            .find(|folder| folder["name"] == "Child")
            .unwrap();
        assert_eq!(nested["parentRef"], parent["folderRef"]);
        assert!(nested["folderRef"].is_string());
        let serialized = serde_json::to_string(folders).unwrap();
        assert!(!serialized.contains("\"id\""));
        assert!(!serialized.contains("parentId"));
        assert!(!serialized.contains("updatedAt"));
    }
}
