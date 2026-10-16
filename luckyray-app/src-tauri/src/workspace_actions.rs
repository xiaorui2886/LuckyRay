//! Bounded child-to-Main intents. Only the existing window command dispatcher
//! calls these methods after Tauri has supplied the real webview caller.
//! A renderer can nominate an opaque ticket, never a path/command or service.
use crate::knowledge::{KnowledgeCreateInput, KnowledgeDocumentRef, KnowledgeService, KnowledgeTargetIdentity};
use crate::workspace_graph::{GrantedGraphNode, MissingDocumentTarget, WorkspaceGraphs};
use crate::workspace_windows::ViewGrant;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use unicode_normalization::UnicodeNormalization;

const TTL: Duration = Duration::from_secs(120);
const MAX_PENDING: usize = 64;
const MAX_PER_WINDOW: usize = 8;
const MAX_TEXT: usize = 10 * 1024;
const MAX_CONTENT: usize = 8 * 1024 * 1024;
const EXPIRED: &str = "workspace-action-expired";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionCorrelation { pub request_id: u64, pub revision: String, pub generation: u64 }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GraphAction { Open, OpenDefault, Reveal, AskAi, CreateMissing }
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WritingIntent { Rewrite, Shorten, Summary, Translate, Expand, Continue, Title }
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection { pub start: usize, pub end: usize }
/// NOT Deserialize: only the metadata owner can resolve a child ticket to one
/// of these verified targets. No caller supplied title/path is trusted.
pub(crate) enum VerifiedNoteAction {
    OpenDocument { document_ref: KnowledgeDocumentRef, revision: String }, OpenTag { name: String },
    AskAi, SuggestAi, WriteAi { intent: WritingIntent, selection: Selection },
    OpenDefault, Reveal,
}
#[derive(Clone)]
enum Target {
    Document { reference: KnowledgeDocumentRef, revision: String, title: String },
    Tag { name: String },
    Missing { source_ref: KnowledgeDocumentRef, source_revision: String, raw_target: String, target: MissingDocumentTarget },
}
#[derive(Clone)]
enum Proof {
    Note { reference: KnowledgeDocumentRef, revision: String },
    Graph { snapshot_id: String, node_token: String },
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum MainAction {
    OpenDocument { #[serde(rename = "vaultId")] vault_id: String, title: String },
    CreateMissing { #[serde(rename = "vaultId")] vault_id: String, title: String, #[serde(rename = "relativePath")] relative_path: String },
    OpenTag { #[serde(rename = "vaultId")] vault_id: String, name: String },
    ComposeAi { source: &'static str, text: String },
    FileOperation { mode: &'static str, label: String },
}
#[derive(Clone)]
struct Entry {
    id: String, caller: String, view: ViewGrant, correlation: ActionCorrelation,
    scope: KnowledgeService, identity: KnowledgeTargetIdentity, proof: Proof, target: Target,
    action: MainAction, expires: Instant, claim: Option<String>, executed: bool, execution_succeeded: bool,
    result: Option<Result<(), &'static str>>,
}
#[derive(Default)]
pub(crate) struct WorkspaceActions { entries: Mutex<HashMap<String, Entry>>, latest_requests: Mutex<HashMap<(String, String), u64>> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionReceipt { pub id: String, pub request_id: u64, pub view_id: String, pub revision: String, pub generation: u64 }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainActionOffer { pub id: String, pub title: String, pub view_id: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainActionClaim { pub id: String, pub claim_token: String, pub remaining_ms: u64, pub action: MainAction }
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum MainExecution { Acknowledged, OpenView { view: ViewGrant }, OpenedInOrigin { #[serde(rename = "viewId")] view_id: String } }
/// The host selects a captured destination; no Main-global vault is consulted.
pub(crate) enum BoundDocument { MainWorkspace { view: ViewGrant }, OriginWindow { view_id: String } }
impl From<BoundDocument> for MainExecution {
    fn from(bound: BoundDocument) -> Self { match bound {
        BoundDocument::MainWorkspace { view } => Self::OpenView { view },
        BoundDocument::OriginWindow { view_id } => Self::OpenedInOrigin { view_id },
    } }
}
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Completion { Performed, Cancelled, Failed }

fn token() -> String { format!("{:032x}", rand::random::<u128>()) }
fn main_only(caller: &str) -> Result<(), String> { if caller == "main" { Ok(()) } else { Err("workspace-action-main-required".into()) } }
fn limited(value: &str, limit: usize) -> String { value.chars().scan(0, |bytes, ch| { *bytes += ch.len_utf8(); (*bytes <= limit).then_some(ch) }).collect() }
fn valid_correlation(value: &ActionCorrelation) -> bool { value.request_id > 0 && value.request_id <= 9_007_199_254_740_991 && value.generation <= 9_007_199_254_740_991 && !value.revision.is_empty() && value.revision.len() <= 256 }
fn ref_for(view: &ViewGrant) -> Result<KnowledgeDocumentRef, String> {
    if view.kind != "note" { return Err("workspace-action-note-required".into()); }
    Ok(KnowledgeDocumentRef { vault_id: view.library_id.clone(), relative_path: view.resource_id.clone().ok_or("workspace-action-note-required")? })
}
fn document_target(scope: &KnowledgeService, reference: &KnowledgeDocumentRef) -> Result<Target, String> {
    let document = scope.read_document(reference).map_err(crate::knowledge_error)?;
    Ok(Target::Document { reference: reference.clone(), revision: document.revision, title: document.summary.title })
}
fn selected_utf16(content: &str, selection: Selection) -> Result<String, String> {
    let units = content.encode_utf16().collect::<Vec<_>>();
    if selection.end < selection.start || selection.end > units.len() { return Err("workspace-action-selection-invalid".into()); }
    String::from_utf16(&units[selection.start..selection.end]).map_err(|_| "workspace-action-selection-invalid".into())
}
fn compose_note(title: &str, content: &str, purpose: &str) -> MainAction {
    MainAction::ComposeAi { source: "notes", text: format!("{}\n\n笔记：{}\n\n{}{}", purpose, limited(title, 256), limited(content, MAX_TEXT - 1024), if content.len() > MAX_TEXT - 1024 { "\n\n（笔记较长，此处仅包含前面的部分。）" } else { "" }) }
}
impl WorkspaceActions {
    /// Commit a registry close while holding the action lock in its established
    /// action->registry order. Failed validation has no revocation side effect.
    pub(crate) fn commit_view_closes<T>(&self,caller:&str,close:impl FnOnce()->Result<(T,Vec<String>),String>)->Result<(T,Vec<String>),String>{
        let mut entries=self.entries.lock().map_err(|_|"workspace-action-lock")?;
        let (result,closed)=close()?;
        entries.retain(|_,entry|entry.caller!=caller||!closed.contains(&entry.view.id));
        if let Ok(mut latest)=self.latest_requests.lock(){for id in &closed{latest.remove(&(caller.into(),id.clone()));}}
        Ok((result,closed))
    }
    pub(crate) fn remove_view(&self, caller: &str, view_id: &str) { if let Ok(mut entries) = self.entries.lock() { entries.retain(|_, entry| entry.caller != caller || entry.view.id != view_id); if let Ok(mut latest) = self.latest_requests.lock() { latest.remove(&(caller.into(), view_id.into())); } } }
    pub(crate) fn remove_window(&self, caller: &str) { if let Ok(mut entries) = self.entries.lock() { entries.retain(|_, entry| entry.caller != caller); if let Ok(mut latest) = self.latest_requests.lock() { latest.retain(|(owner, _), _| owner != caller); } } }
    fn insert(&self, mut entry: Entry) -> Result<ActionReceipt, String> {
        if entry.caller == "main" || entry.caller.is_empty() || entry.caller.len() > 128 || entry.view.id.is_empty() || entry.view.id.len() > 128 || !valid_correlation(&entry.correlation) { return Err("workspace-action-invalid-request".into()); }
        entry.scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
        let mut entries = self.entries.lock().map_err(|_| "workspace-action-lock")?;
        let now = Instant::now(); entries.retain(|_, held| held.expires > now);
        let owner = (entry.caller.clone(), entry.view.id.clone());
        let mut latest = self.latest_requests.lock().map_err(|_| "workspace-action-lock")?;
        if latest.get(&owner).is_some_and(|previous| *previous >= entry.correlation.request_id) { return Err("workspace-action-request-superseded".into()); }
        if !latest.contains_key(&owner) && latest.len() >= 256 { return Err("workspace-action-capacity".into()); }
        entries.retain(|_, held| held.caller != entry.caller || held.view.id != entry.view.id);
        if entries.len() >= MAX_PENDING || entries.values().filter(|held| held.caller == entry.caller).count() >= MAX_PER_WINDOW { return Err("workspace-action-capacity".into()); }
        entry.expires = now + TTL;
        let receipt = ActionReceipt { id: entry.id.clone(), request_id: entry.correlation.request_id, view_id: entry.view.id.clone(), revision: entry.correlation.revision.clone(), generation: entry.correlation.generation };
        latest.insert(owner, entry.correlation.request_id);
        entries.insert(entry.id.clone(), entry); Ok(receipt)
    }
    /// Host must first compare the request's authority to metadata.authority(),
    /// resolve any target tickets, and confirm this exact view is currently open.
    pub(crate) fn enqueue_note(&self, caller: &str, view: &ViewGrant, scope: &KnowledgeService,
        correlation: ActionCorrelation, content: &str, action: VerifiedNoteAction,
    ) -> Result<ActionReceipt, String> {
        if content.len() > MAX_CONTENT { return Err("workspace-action-content-limit".into()); }
        let reference = ref_for(view)?;
        let identity = scope.current_target_identity().map_err(crate::knowledge_error)?;
        let document = scope.read_document_for_target(&identity, &reference).map_err(crate::knowledge_error)?;
        if document.revision != correlation.revision || document.content != content { return Err("workspace-action-revision-changed".into()); }
        let mut target = document_target(scope, &reference)?;
        let action = match action {
            VerifiedNoteAction::OpenDocument { document_ref, revision: expected_target_revision } => {
                if document_ref.vault_id != view.library_id { return Err("workspace-action-source-changed".into()); }
                target = document_target(scope, &document_ref)?;
                let Target::Document { title, revision, .. } = &target else { unreachable!() };
                if *revision != expected_target_revision { return Err("workspace-action-target-changed".into()); }
                MainAction::OpenDocument { vault_id: view.library_id.clone(), title: title.clone() }
            },
            VerifiedNoteAction::OpenTag { name } => {
                if name.is_empty() || name.len() > 256 { return Err("workspace-action-invalid-tag".into()); }
                target = Target::Tag { name: name.clone() }; MainAction::OpenTag { vault_id: view.library_id.clone(), name }
            },
            VerifiedNoteAction::AskAi => compose_note(&document.summary.title, &document.content, "请结合这篇笔记回答我的后续问题。"),
            VerifiedNoteAction::SuggestAi => compose_note(&document.summary.title, &document.content, "请为这篇笔记建议摘要和标签。请等我确认发送。"),
            VerifiedNoteAction::WriteAi { intent, selection } => {
                let selected = selected_utf16(&document.content, selection)?;
                let purpose = match intent { WritingIntent::Rewrite => "请改写以下文字。", WritingIntent::Shorten => "请精简以下文字。", WritingIntent::Summary => "请总结以下文字。", WritingIntent::Translate => "请翻译以下文字。", WritingIntent::Expand => "请扩写以下文字。", WritingIntent::Continue => "请续写以下文字。", WritingIntent::Title => "请为以下文字拟定标题。" };
                compose_note(&document.summary.title, if selected.is_empty() { &document.content } else { &selected }, purpose)
            },
            VerifiedNoteAction::OpenDefault => MainAction::FileOperation { mode: "open", label: document.summary.title },
            VerifiedNoteAction::Reveal => MainAction::FileOperation { mode: "reveal", label: document.summary.title },
        };
        self.insert(Entry { id: token(), caller: caller.into(), view: view.clone(), correlation, scope: scope.clone(), identity,
            proof: Proof::Note { reference, revision: document.revision }, target, action, expires: Instant::now(), claim: None, executed: false, execution_succeeded: false, result: None })
    }
    pub(crate) fn enqueue_graph(&self, caller: &str, view: &ViewGrant, scope: &KnowledgeService, graphs: &WorkspaceGraphs,
        snapshot_id: &str, node_token: &str, request_id: u64, action: GraphAction,
    ) -> Result<ActionReceipt, String> {
        if view.kind != "graph" { return Err("workspace-action-graph-required".into()); }
        let node = graphs.node_for_scope(caller, &view.id, snapshot_id, node_token, scope)?;
        let revision = graphs.rendered_revision(caller, &view.id, snapshot_id)?;
        let identity = scope.current_target_identity().map_err(crate::knowledge_error)?;
        let target = match node {
            GrantedGraphNode::Document { document_ref, revision, title, .. } => Target::Document { reference: document_ref, revision, title },
            GrantedGraphNode::Tag { name } => Target::Tag { name },
            GrantedGraphNode::MissingDocument { source_ref, source_revision, raw_target, target } => Target::Missing { source_ref, source_revision, raw_target, target },
            // A graph's catalog label is not shell/navigation authority. An
            // exact per-item captured catalog adapter must be added separately.
            GrantedGraphNode::LibraryAsset { .. } => return Err("workspace-action-library-item-adapter-required".into()),
            GrantedGraphNode::VaultAsset { .. } => return Err("workspace-action-vault-attachment-adapter-required".into()),
        };
        let main_action = match (&target, action) {
            (Target::Document { title, .. }, GraphAction::Open) => MainAction::OpenDocument { vault_id: view.library_id.clone(), title: title.clone() },
            (Target::Tag { name }, GraphAction::Open) => MainAction::OpenTag { vault_id: view.library_id.clone(), name: name.clone() },
            (Target::Missing { target, .. }, GraphAction::CreateMissing) => MainAction::CreateMissing { vault_id: view.library_id.clone(), title: target.title.clone(), relative_path: target.relative_path.clone() },
            (Target::Document { title, .. }, GraphAction::OpenDefault) => MainAction::FileOperation { mode: "open", label: title.clone() },
            (Target::Document { title, .. }, GraphAction::Reveal) => MainAction::FileOperation { mode: "reveal", label: title.clone() },
            (Target::Document { reference, revision, title }, GraphAction::AskAi) => {
                let document = scope.read_document_for_target(&identity, reference).map_err(crate::knowledge_error)?;
                if document.revision != *revision { return Err("workspace-action-revision-changed".into()); }
                compose_note(title, &document.content, "请解释这个图谱笔记节点的上下文关系，并建议下一步整理工作。")
            },
            (Target::Tag { name }, GraphAction::AskAi) => {
                let index = scope.refresh_index_for_target(&identity).map_err(crate::knowledge_error)?;
                if index.stale || !index.errors.is_empty() || index.refresh_error.is_some() { return Err("workspace-action-index-incomplete".into()); }
                let canonical = |value: &str| value.trim().trim_start_matches('#').trim().nfc().collect::<String>().to_lowercase();
                let wanted = canonical(name);
                let related = index.documents.iter().filter(|document| document.frontmatter_tags.iter().any(|tag| canonical(tag) == wanted))
                    .take(32).map(|document| limited(&document.title, 200)).collect::<Vec<_>>();
                if related.is_empty() { return Err("workspace-action-target-changed".into()); }
                MainAction::ComposeAi { source: "graph", text: format!("请根据以下已绑定来源的图谱信息，解释标签关系并建议整理工作。\n来源知识库：{}\n标签：{}\n关联笔记标题（最多 32 条）：\n{}", limited(&view.library_id, 256), limited(name, 256), related.join("\n")) }
            },
            _ => return Err("workspace-action-unsupported-target".into()),
        };
        self.insert(Entry { id: token(), caller: caller.into(), view: view.clone(), correlation: ActionCorrelation { request_id, revision, generation: 0 }, scope: scope.clone(), identity,
            proof: Proof::Graph { snapshot_id: snapshot_id.into(), node_token: node_token.into() }, target, action: main_action, expires: Instant::now(), claim: None, executed: false, execution_succeeded: false, result: None })
    }
    fn validate(entry: &Entry, graphs: &WorkspaceGraphs,
        live: &mut impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>,
    ) -> Result<(), String> {
        if entry.expires <= Instant::now() { return Err(EXPIRED.into()); }
        live(&entry.caller, &entry.view, &entry.correlation)?;
        entry.scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
        if entry.scope.current_target_identity().map_err(crate::knowledge_error)? != entry.identity { return Err("workspace-action-source-changed".into()); }
        match &entry.proof {
            Proof::Note { reference, revision } => {
                if entry.scope.read_document_for_target(&entry.identity, reference).map_err(crate::knowledge_error)?.revision != *revision { return Err("workspace-action-revision-changed".into()); }
            },
            Proof::Graph { snapshot_id, node_token } => { graphs.node_for_scope(&entry.caller, &entry.view.id, snapshot_id, node_token, &entry.scope)?; },
        }
        if let Target::Document { reference, revision, .. } = &entry.target {
            if entry.scope.read_document_for_target(&entry.identity, reference).map_err(crate::knowledge_error)?.revision != *revision { return Err("workspace-action-target-changed".into()); }
        }
        Ok(())
    }
    pub(crate) fn pending(&self, caller: &str) -> Result<Vec<MainActionOffer>, String> {
        main_only(caller)?;
        let mut entries = self.entries.lock().map_err(|_| "workspace-action-lock")?;
        entries.retain(|_, entry| entry.expires > Instant::now());
        Ok(entries.values().filter(|entry| entry.claim.is_none() && entry.result.is_none()).map(|entry|
            MainActionOffer { id: entry.id.clone(), title: entry.view.title.clone(), view_id: entry.view.id.clone() }).collect())
    }
    /// The live callback verifies registry ownership, open status, exact ViewGrant
    /// and request generation. It must not call back into this broker. Do not
    /// hold a registry mutex when entering broker methods (one lock order).
    pub(crate) fn claim(&self, caller: &str, id: &str, graphs: &WorkspaceGraphs,
        mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>,
        main_target: impl FnOnce(&KnowledgeTargetIdentity) -> Result<(), String>,
    ) -> Result<MainActionClaim, String> {
        main_only(caller)?;
        let mut entries = self.entries.lock().map_err(|_| "workspace-action-lock")?;
        let entry = entries.get_mut(id).ok_or(EXPIRED)?;
        if entry.claim.is_some() || entry.result.is_some() { return Err("workspace-action-already-claimed".into()); }
        Self::validate(entry, graphs, &mut live)?;
        // The existing Tags route is global. A captured source mismatch is an
        // explicit missing scoped destination, never a global source switch.
        if matches!(entry.action, MainAction::OpenTag { .. }) { main_target(&entry.identity)?; }
        let claim_token = token(); entry.claim = Some(claim_token.clone());
        Ok(MainActionClaim { id: entry.id.clone(), claim_token, remaining_ms: entry.expires.saturating_duration_since(Instant::now()).as_millis() as u64, action: entry.action.clone() })
    }
    pub(crate) fn validate_claim(&self, caller: &str, id: &str, claim_token: &str, graphs: &WorkspaceGraphs,
        mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>,
        main_target: impl FnOnce(&KnowledgeTargetIdentity) -> Result<(), String>,
    ) -> Result<u64, String> {
        main_only(caller)?;
        let entries = self.entries.lock().map_err(|_| "workspace-action-lock")?;
        let entry = entries.get(id).ok_or(EXPIRED)?;
        if entry.claim.as_deref() != Some(claim_token) || entry.result.is_some() { return Err("workspace-action-claim-invalid".into()); }
        Self::validate(entry, graphs, &mut live)?;
        if matches!(entry.action, MainAction::OpenTag { .. }) { main_target(&entry.identity)?; }
        Ok(entry.expires.saturating_duration_since(Instant::now()).as_millis() as u64)
    }
    pub(crate) fn execute(&self, caller: &str, id: &str, claim_token: &str, confirmed: bool, graphs: &WorkspaceGraphs,
        mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>,
        bind_document: impl FnOnce(&str, &ViewGrant, &KnowledgeService, &KnowledgeDocumentRef, &str) -> Result<BoundDocument, String>,
    ) -> Result<MainExecution, String> {
        main_only(caller)?;
        let mut entries = self.entries.lock().map_err(|_| "workspace-action-lock")?;
        let entry = entries.get_mut(id).ok_or(EXPIRED)?;
        if entry.claim.as_deref() != Some(claim_token) || entry.result.is_some() || entry.executed { return Err("workspace-action-claim-invalid".into()); }
        Self::validate(entry, graphs, &mut live)?;
        if matches!(entry.action, MainAction::CreateMissing { .. }) && !confirmed { return Err("workspace-action-confirmation-required".into()); }
        if matches!(entry.action, MainAction::ComposeAi { .. } | MainAction::OpenTag { .. }) { return Err("workspace-action-main-presentation-required".into()); }
        // At most once, including uncertain shell/binding responses. A retry
        // must be an explicit new child request, never re-execute this claim.
        entry.executed = true;
        let result = (|| match (&entry.action, &entry.target) {
            (MainAction::OpenDocument { .. }, Target::Document { reference, title, .. }) =>
                Ok(bind_document(&entry.caller, &entry.view, &entry.scope, reference, title)?.into()),
            (MainAction::FileOperation { mode, .. }, Target::Document { reference, revision, .. }) => {
                entry.scope.with_workspace_action_document_path(&entry.identity, reference, revision, |path| {
                    if *mode == "reveal" { tauri_plugin_opener::reveal_item_in_dir(path).map_err(|_| "workspace-action-shell-failed".into()) }
                    else { tauri_plugin_opener::open_path(path, None::<&str>).map_err(|_| "workspace-action-shell-failed".into()) }
                })?;
                Ok(MainExecution::Acknowledged)
            },
            (MainAction::CreateMissing { .. }, Target::Missing { source_ref, source_revision, raw_target, target }) => {
                let index = entry.scope.refresh_index_for_target(&entry.identity).map_err(crate::knowledge_error)?;
                if index.stale || !index.errors.is_empty() || index.refresh_error.is_some() { return Err("workspace-action-index-incomplete".into()); }
                let source = index.documents.iter().find(|document| document.document_ref == *source_ref).ok_or("workspace-action-source-changed")?;
                if source.revision != *source_revision || !source.wiki_links.iter().any(|link| link.target.split('|').next() == Some(raw_target.as_str())) { return Err("workspace-action-revision-changed".into()); }
                if crate::workspace_graph::missing_document_target(&source_ref.relative_path, raw_target).as_ref() != Some(target) { return Err("workspace-action-target-changed".into()); }
                if !crate::workspace_graph::missing_target_is_unresolved(&index, source_ref, raw_target) { return Err("workspace-action-create-conflict".into()); }
                let created = entry.scope.create_document_for_target(&entry.identity, &KnowledgeCreateInput { title: target.title.clone(), parent_relative_path: (!target.parent_path.is_empty()).then(|| target.parent_path.clone()), content: String::new() }).map_err(crate::knowledge_error)?;
                // A partial commit is not falsely described as successful; do
                // not retry creation or open a different file on a conflict.
                if created.index_stale || created.index_warning.is_some() || created.document.summary.document_ref.relative_path != target.relative_path { return Err("workspace-action-created-recheck-required".into()); }
                Ok(bind_document(&entry.caller, &entry.view, &entry.scope, &created.document.summary.document_ref, &created.document.summary.title)?.into())
            },
            _ => Err("workspace-action-unsupported-target".into()),
        })();
        entry.execution_succeeded = result.is_ok();
        result
    }
    pub(crate) fn complete(&self, caller: &str, id: &str, claim_token: &str, completion: Completion,
        graphs: &WorkspaceGraphs, mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>,
    ) -> Result<(), String> {
        main_only(caller)?;
        let mut entries = self.entries.lock().map_err(|_| "workspace-action-lock")?;
        let entry = entries.get_mut(id).ok_or(EXPIRED)?;
        if entry.claim.as_deref() != Some(claim_token) || entry.result.is_some() { return Err("workspace-action-claim-invalid".into()); }
        Self::validate(entry, graphs, &mut live)?;
        if matches!(completion, Completion::Performed) && !entry.execution_succeeded && !matches!(entry.action, MainAction::ComposeAi { .. } | MainAction::OpenTag { .. }) { return Err("workspace-action-not-executed".into()); }
        entry.result = Some(match completion { Completion::Performed => Ok(()), Completion::Cancelled => Err("workspace-action-cancelled"), Completion::Failed => Err("workspace-action-failed") });
        Ok(())
    }
    pub(crate) fn cancel(&self, caller: &str, id: &str) -> Result<(), String> {
        main_only(caller)?;
        let mut entries = self.entries.lock().map_err(|_| "workspace-action-lock")?;
        let entry = entries.get_mut(id).ok_or(EXPIRED)?;
        if entry.result.is_some() { return Err("workspace-action-already-completed".into()); }
        entry.result = Some(Err("workspace-action-cancelled")); Ok(())
    }
    /// Result delivery is caller+view+request bound and returns no paths, note
    /// bodies, target identities, claim tokens or arbitrary Main reply data.
    pub(crate) fn status(&self, caller: &str, view: &ViewGrant, id: &str, correlation: &ActionCorrelation,
        graphs: &WorkspaceGraphs, mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>,
    ) -> Result<Value, String> {
        let entries = self.entries.lock().map_err(|_| "workspace-action-lock")?;
        let entry = entries.get(id).filter(|entry| entry.caller == caller && entry.view == *view && entry.correlation == *correlation).ok_or(EXPIRED)?;
        Self::validate(entry, graphs, &mut live)?;
        Ok(match &entry.result {
            None => json!({"state":"pending"}),
            Some(Ok(())) => json!({"state":"completed","result":{"ok":true,"value":{"kind":"acknowledged"}}}),
            Some(Err(code)) => json!({"state":"completed","result":{"ok":false,"code":"unavailable","message":code}}),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_selection_never_splits_a_surrogate() {
        assert_eq!(selected_utf16("a😀b", Selection { start: 1, end: 3 }).unwrap(), "😀");
        assert!(selected_utf16("a😀b", Selection { start: 1, end: 2 }).is_err());
        assert!(selected_utf16("abc", Selection { start: 4, end: 4 }).is_err());
    }
    #[test]
    fn protocol_rejects_unknown_actions_and_fields() {
        assert!(serde_json::from_value::<GraphAction>(json!("runCommand")).is_err());
        assert!(serde_json::from_value::<Selection>(json!({"start":0,"end":1,"path":"/private"})).is_err());
        assert!(serde_json::from_value::<ActionCorrelation>(json!({"requestId":1,"revision":"r","generation":0,"caller":"main"})).is_err());
        assert!(main_only("workspace-main").is_err()); assert!(main_only("main").is_ok());
    }
    #[test]
    fn text_caps_are_utf8_safe_and_correlations_bounded() {
        assert!(limited(&"😀".repeat(100), 99).len() <= 99);
        assert!(!valid_correlation(&ActionCorrelation { request_id: 0, revision: "r".into(), generation: 0 }));
        assert!(!valid_correlation(&ActionCorrelation { request_id: 1, revision: "".into(), generation: 0 }));
        let action = compose_note("Synthetic", &"a".repeat(MAX_CONTENT), "Rewrite");
        let MainAction::ComposeAi { text, .. } = action else { unreachable!() };
        assert!(text.len() < MAX_TEXT);
    }
    fn fixture() -> (KnowledgeService, std::path::PathBuf, ViewGrant, String) {
        let base = std::env::temp_dir().join(format!("workspace-actions-test-{}", token()));
        let root = base.join("vault"); std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let registration = crate::knowledge::KnowledgeVaultRegistration { id: "vault".into(), name: "Synthetic".into(), root_path: root.to_string_lossy().into(), mode: "vault-bound".into(), created_at: "2026-10-06T00:00:00Z".into(), last_opened_at: "2026-10-06T00:00:00Z".into(), schema_version: 1, link_update_policy: Default::default() };
        std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        std::fs::write(root.join("note.md"), "synthetic note").unwrap();
        let service = KnowledgeService::initialize(base.join("app")).unwrap(); service.register_current_vault(&registration).unwrap();
        let service = service.capture_workspace_scope("vault").unwrap();
        let view = ViewGrant { id: "note-view".into(), kind: "note".into(), library_id: "vault".into(), resource_id: Some("note.md".into()), title: "Note".into() };
        let revision = service.read_document(&ref_for(&view).unwrap()).unwrap().revision;
        (service, root, view, revision)
    }
    fn correlation(revision: &str, request_id: u64) -> ActionCorrelation { ActionCorrelation { request_id, revision: revision.into(), generation: 7 } }
    #[test]
    fn only_origin_and_exact_current_request_receive_sanitized_reply() {
        let (scope, _, view, revision) = fixture(); let broker = WorkspaceActions::default(); let graphs = WorkspaceGraphs::default();
        let request = correlation(&revision, 1);
        let receipt = broker.enqueue_note("child", &view, &scope, request.clone(), "synthetic note", VerifiedNoteAction::AskAi).unwrap();
        assert!(broker.pending("child").is_err());
        assert!(broker.claim("other", &receipt.id, &graphs, |_,_,_| Ok(()), |_| Ok(())).is_err());
        let claim = broker.claim("main", &receipt.id, &graphs, |caller, grant, correlation| { assert_eq!(caller,"child"); assert_eq!(*grant,view); assert_eq!(*correlation,request); Ok(()) }, |_| Ok(())).unwrap();
        assert!(broker.claim("main", &receipt.id, &graphs, |_,_,_| Ok(()), |_| Ok(())).is_err());
        assert!(broker.status("other", &view, &receipt.id, &request, &graphs, |_,_,_| Ok(())).is_err());
        assert!(broker.status("child", &view, &receipt.id, &correlation(&revision,2), &graphs, |_,_,_| Ok(())).is_err());
        broker.complete("main", &receipt.id, &claim.claim_token, Completion::Performed, &graphs, |_,_,_| Ok(())).unwrap();
        let reply = broker.status("child", &view, &receipt.id, &request, &graphs, |_,_,_| Ok(())).unwrap().to_string();
        for secret in ["synthetic note", "note.md", "claimToken", "sourceId"] { assert!(!reply.contains(secret)); }
        assert!(reply.contains("acknowledged"));
        assert!(broker.enqueue_note("child", &view, &scope, request, "synthetic note", VerifiedNoteAction::AskAi).is_err());
    }
    #[test]
    fn expiration_supersession_rebind_and_saved_edits_revoke_old_claims() {
        let (scope, root, view, revision) = fixture(); let broker = WorkspaceActions::default(); let graphs = WorkspaceGraphs::default();
        let first = broker.enqueue_note("child", &view, &scope, correlation(&revision,1), "synthetic note", VerifiedNoteAction::AskAi).unwrap();
        let first_claim = broker.claim("main", &first.id, &graphs, |_,_,_| Ok(()), |_| Ok(())).unwrap();
        let next = broker.enqueue_note("child", &view, &scope, correlation(&revision,2), "synthetic note", VerifiedNoteAction::AskAi).unwrap();
        assert!(broker.complete("main", &first.id, &first_claim.claim_token, Completion::Performed, &graphs, |_,_,_| Ok(())).is_err());
        broker.entries.lock().unwrap().get_mut(&next.id).unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(broker.claim("main", &next.id, &graphs, |_,_,_| Ok(()), |_| Ok(())).is_err());
        broker.pending("main").unwrap();
        assert!(broker.enqueue_note("child", &view, &scope, correlation(&revision,2), "synthetic note", VerifiedNoteAction::AskAi).is_err());
        let third = broker.enqueue_note("child", &view, &scope, correlation(&revision,3), "synthetic note", VerifiedNoteAction::AskAi).unwrap();
        broker.remove_view("child", &view.id);
        assert!(broker.claim("main", &third.id, &graphs, |_,_,_| Ok(()), |_| Ok(())).is_err());
        let fresh = broker.enqueue_note("child", &view, &scope, correlation(&revision,1), "synthetic note", VerifiedNoteAction::AskAi).unwrap();
        std::fs::write(root.join("note.md"), "external edit").unwrap();
        assert!(broker.claim("main", &fresh.id, &graphs, |_,_,_| Ok(()), |_| Ok(())).is_err());
    }
    #[test]
    fn note_content_and_open_target_revision_cannot_silently_change() {
        let (scope, _, view, revision) = fixture(); let broker = WorkspaceActions::default();
        assert!(broker.enqueue_note("child", &view, &scope, correlation(&revision,1), "unsaved draft", VerifiedNoteAction::AskAi).is_err());
        assert!(broker.enqueue_note("child", &view, &scope, correlation(&revision,1), "synthetic note", VerifiedNoteAction::OpenDocument { document_ref: ref_for(&view).unwrap(), revision: "wrong".into() }).is_err());
        for index in 0..MAX_PER_WINDOW {
            let mut selected = view.clone(); selected.id = format!("view-{index}");
            broker.enqueue_note("child", &selected, &scope, correlation(&revision,1), "synthetic note", VerifiedNoteAction::AskAi).unwrap();
        }
        assert!(broker.enqueue_note("child", &view, &scope, correlation(&revision,1), "synthetic note", VerifiedNoteAction::AskAi).is_err());
    }

}
