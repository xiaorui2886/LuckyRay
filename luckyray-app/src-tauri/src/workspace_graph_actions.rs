//! Exact captured-source graph intents. Child webviews supply only opaque graph
//! tickets (or a bounded PNG), while Main claims a mounted service lease. Paths,
//! catalog selection, revisions and all native effects remain backend-owned.
use crate::knowledge::{KnowledgeDocumentRef, KnowledgeService, KnowledgeTargetIdentity};
use crate::materials::{MaterialAsset, MaterialCatalog, MaterialFilter};
use crate::workspace_actions::{ActionCorrelation, ActionReceipt, BoundDocument, GraphAction, MainExecution};
use crate::workspace_graph::{GrantedGraphNode, GraphLibraryEmbed, WorkspaceGraphs};
use crate::workspace_windows::ViewGrant;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, io::Read, sync::Mutex, time::{Duration, Instant}};
use tauri_plugin_dialog::DialogExt;
use unicode_normalization::UnicodeNormalization;

const ACTION_TTL: Duration = Duration::from_secs(120);
const LEASE_TTL: Duration = Duration::from_secs(30);
const MAX_ACTIONS: usize = 64;
const MAX_PER_WINDOW: usize = 8;
const MAX_CATALOG_ASSETS: u32 = 10_000;
const MAX_CATALOG_BYTES: usize = 16 * 1024 * 1024;
const MAX_PNG_BYTES: usize = 32 * 1024 * 1024;
const MAX_PNG_PIXELS: usize = 16 * 1024 * 1024;
const MAX_FILE_HASH: u64 = 256 * 1024 * 1024;
const EXPIRED: &str = "workspace-graph-action-expired";
fn opaque() -> String { format!("{:032x}{:032x}", rand::random::<u128>(), rand::random::<u128>()) }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn main_only(caller: &str) -> Result<(), String> { if caller == "main" { Ok(()) } else { Err("workspace-graph-action-main-required".into()) } }
fn material_error(error: crate::materials::MaterialError) -> String { crate::encode_material_catalog_command_error(error) }
fn limited(value: &str, bytes: usize) -> String { let mut end = value.len().min(bytes); while !value.is_char_boundary(end) { end -= 1; } value[..end].to_owned() }

fn wiki_key(value: &str) -> String { value.trim().to_lowercase() }
fn vault_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let mut result = String::new(); let mut slash = false;
    for ch in normalized.trim_start_matches('/').chars() {
        if ch != '/' || !slash { result.push(ch); } slash = ch == '/';
    }
    result.trim().to_owned()
}
fn clean_embed_chars(value: &str) -> String {
    value.chars().filter_map(|ch| match ch {
        '\u{feff}' | '\u{200b}'..='\u{200d}' | '\u{2060}' => None,
        '\u{a0}' | '\u{1680}' | '\u{180e}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' => Some(' '),
        value => Some(value),
    }).collect()
}
fn decode_uri_component(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len()); let input = value.as_bytes(); let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            let a = (*input.get(i + 1)? as char).to_digit(16)?;
            let b = (*input.get(i + 2)? as char).to_digit(16)?;
            bytes.push((a * 16 + b) as u8); i += 3;
        } else { bytes.push(input[i]); i += 1; }
    }
    String::from_utf8(bytes).ok()
}
/// Same normalization order as normalizeMarkdownEmbedTarget, including its
/// all-or-nothing URI decode and Markdown punctuation escapes.
fn embed_target(value: &str) -> String {
    let clean = clean_embed_chars(value); let clean = clean.trim();
    let decoded = decode_uri_component(clean).unwrap_or_else(|| clean.into());
    let normalized = clean_embed_chars(&decoded); let mut chars = normalized.chars().peekable(); let mut result = String::new();
    while let Some(ch) = chars.next() {
        if ch == '\\' && chars.peek().is_some_and(|ch| "\\`*_[]{}()#+-.!|>~".contains(*ch)) { result.push(chars.next().unwrap()); }
        else { result.push(ch); }
    }
    result.trim().nfc().collect()
}
fn path_filename(value: &str) -> String {
    let value = embed_target(value).replace('\\', "/"); value.trim().rsplit('/').next().unwrap_or_default().into()
}
fn parsed_embed_target(raw: &str) -> String {
    let title = raw.split('|').next().unwrap_or_default().split('#').next().unwrap_or_default().trim();
    embed_target(if title.is_empty() { raw } else { title })
}
fn exact_asset_revision(catalog: &MaterialCatalog, asset: &MaterialAsset) -> Result<String, String> {
    let base = catalog.revision_for_asset(asset).map_err(material_error)?;
    let encoded = serde_json::to_vec(&("workspace-graph-catalog-row-v1", asset, base)).map_err(|_| "workspace-graph-catalog-invalid")?;
    Ok(format!("graph-asset-v1:{}", digest(&encoded)))
}

/// A complete ordinary-assets scan of ONE captured catalog. Hitting either cap
/// is an error, never authoritative NoMatch. No ambient active library is read.
/// Capture once per graph read and reuse this resolver for all embed targets.
pub(crate) struct CapturedCatalogResolver {
    catalog: MaterialCatalog, library_id: String, version: i64,
    assets: Vec<MaterialAsset>, direct: HashMap<String, HashSet<usize>>,
}
impl CapturedCatalogResolver {
    pub(crate) fn capture(catalog: &MaterialCatalog) -> Result<Self, String> {
        let library_id = catalog.library_scope_key().map_err(material_error)?;
        let catalog = catalog.for_library(&library_id).map_err(material_error)?;
        let before = catalog.read_change().map_err(material_error)?.version;
        let assets = catalog.list_assets(&MaterialFilter { limit: Some(MAX_CATALOG_ASSETS + 1), ..Default::default() }).map_err(material_error)?;
        if assets.len() > MAX_CATALOG_ASSETS as usize { return Err("workspace-graph-catalog-limit".into()); }
        let size = serde_json::to_vec(&assets).map_err(|_| "workspace-graph-catalog-invalid")?.len();
        if size > MAX_CATALOG_BYTES { return Err("workspace-graph-catalog-limit".into()); }
        if catalog.read_change().map_err(material_error)?.version != before { return Err("workspace-graph-catalog-changed".into()); }
        let mut direct: HashMap<String, HashSet<usize>> = HashMap::new();
        for (index, asset) in assets.iter().enumerate() {
            for key in [asset.id.clone(), asset.name.clone(), path_filename(&asset.original_path), path_filename(asset.library_path.as_deref().unwrap_or_default()), vault_path(&asset.original_path), vault_path(asset.library_path.as_deref().unwrap_or_default())] {
                let key = wiki_key(&key); if !key.is_empty() { direct.entry(key).or_default().insert(index); }
            }
        }
        Ok(Self { catalog, library_id, version: before, assets, direct })
    }
    fn selected(&self, raw: &str) -> Option<&MaterialAsset> {
        let decoded = parsed_embed_target(raw); let key = wiki_key(&decoded);
        if key.is_empty() { return None; }
        if let Some(asset) = self.assets.iter().find(|asset| asset.id == decoded) { return Some(asset); }
        let mut keys = vec![key, wiki_key(&vault_path(&decoded))];
        if !decoded.contains(['/', '\\']) { keys.push(wiki_key(&path_filename(&decoded))); }
        let mut matches = HashSet::new();
        for key in keys { if let Some(found) = self.direct.get(&key) { matches.extend(found.iter().copied()); } }
        if matches.len() != 1 { return None; }
        self.assets.get(*matches.iter().next()?)
    }
    pub(crate) fn resolve(&self, raw: &str) -> Result<GraphLibraryEmbed, String> {
        if raw.len() > 8192 { return Err("workspace-graph-embed-limit".into()); }
        if self.catalog.library_scope_key().map_err(material_error)? != self.library_id
            || self.catalog.read_change().map_err(material_error)?.version != self.version { return Err("workspace-graph-catalog-changed".into()); }
        let Some(asset) = self.selected(raw) else { return Ok(GraphLibraryEmbed::NoMatch); };
        let current = self.catalog.get_ordinary_export_asset(&asset.id).map_err(material_error)?;
        if current != *asset { return Err("workspace-graph-catalog-changed".into()); }
        let asset_revision = exact_asset_revision(&self.catalog, asset)?;
        if self.catalog.read_change().map_err(material_error)?.version != self.version { return Err("workspace-graph-catalog-changed".into()); }
        Ok(GraphLibraryEmbed::Match { asset_id: asset.id.clone(), asset_name: asset.name.clone(), asset_revision })
    }
}
pub(crate) fn captured_catalog_resolver(catalog: &MaterialCatalog) -> Result<CapturedCatalogResolver, String> { CapturedCatalogResolver::capture(catalog) }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GraphMainKind { OpenDocument, OpenTag, CreateMissing, ComposeAi, FileOperation, OpenCatalogAsset, Screenshot }
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum GraphMainAction {
    OpenDocument { #[serde(rename = "vaultId")] vault_id: String, title: String },
    OpenTag { #[serde(rename = "vaultId")] vault_id: String, name: String },
    CreateMissing { #[serde(rename = "vaultId")] vault_id: String, title: String, #[serde(rename = "relativePath")] relative_path: String },
    ComposeAi { source: &'static str, text: String },
    FileOperation { mode: &'static str, label: String },
    OpenCatalogAsset { #[serde(rename = "libraryId")] library_id: String, asset: MaterialAsset, #[serde(rename = "assetRevision")] asset_revision: String },
    Screenshot { mime: &'static str, bytes: Vec<u8> },
}
impl GraphMainAction {
    fn service(&self) -> GraphMainKind { match self { Self::OpenDocument {..} => GraphMainKind::OpenDocument, Self::OpenTag {..} => GraphMainKind::OpenTag, Self::CreateMissing {..} => GraphMainKind::CreateMissing, Self::ComposeAi {..} => GraphMainKind::ComposeAi, Self::FileOperation {..} => GraphMainKind::FileOperation, Self::OpenCatalogAsset {..} => GraphMainKind::OpenCatalogAsset, Self::Screenshot {..} => GraphMainKind::Screenshot } }
    fn presentation(&self) -> bool { matches!(self, Self::OpenTag {..} | Self::ComposeAi {..} | Self::OpenCatalogAsset {..}) }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphMainLease { pub lease_token: String, pub expires_in_ms: u64 }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphMainOffer { pub id: String, pub view_id: String, pub title: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphMainClaim { pub id: String, pub claim_token: String, pub remaining_ms: u64, pub action: GraphMainAction }
// Empty structs preserve the wire tag while enforcing unknown-field rejection;
// internally tagged unit variants silently consume extra payload fields.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum GraphExecuteInput { Perform { #[serde(default)] confirmed: bool }, SaveScreenshot {} }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum GraphCompletion {
    Acknowledged {},
    Screenshot { result: ScreenshotResult },
    Cancelled {},
    Failed { code: String },
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScreenshotResult { Copied, Saved }
#[derive(Clone)]
struct Lease { token: String, kinds: HashSet<GraphMainKind>, expires: Instant }
#[derive(Clone)]
struct Entry {
    id: String, caller: String, view: ViewGrant, correlation: ActionCorrelation,
    scope: KnowledgeService, catalog: MaterialCatalog, identity: KnowledgeTargetIdentity,
    snapshot_id: String, source_id: String, node_token: Option<String>, node: Option<GrantedGraphNode>,
    native_digest: Option<String>, action: GraphMainAction, expires: Instant,
    claim: Option<(String, String)>, executed: bool, execution: Option<GraphCompletion>, result: Option<GraphCompletion>,
}
#[derive(Default)]
struct BrokerState { entries: HashMap<String, Entry>, latest: HashMap<(String, String), u64>, lease: Option<Lease> }
#[derive(Default)]
pub(crate) struct WorkspaceGraphActions { state: Mutex<BrokerState> }

fn checked_catalog_asset(catalog: &MaterialCatalog, id: &str, revision: &str) -> Result<MaterialAsset, String> {
    let asset = catalog.get_ordinary_export_asset(id).map_err(material_error)?;
    if exact_asset_revision(catalog, &asset)? != revision { return Err("workspace-graph-action-asset-changed".into()); }
    Ok(asset)
}
/// The companion resource resolver validates catalog membership and physical
/// storage identity. Hash bounded bytes to detect same-size/time file rewrites.
fn catalog_file_digest(catalog: &MaterialCatalog, id: &str, revision: &str) -> Result<String, String> {
    let expected = checked_catalog_asset(catalog, id, revision)?;
    let (asset, mut file) = catalog.companion_resource(id, false).map_err(material_error)?;
    if asset != expected { return Err("workspace-graph-action-asset-changed".into()); }
    if file.metadata().map_err(|_| "workspace-graph-action-file-unavailable")?.len() > MAX_FILE_HASH { return Err("workspace-graph-action-file-limit".into()); }
    let mut hash = Sha256::new(); let mut buffer = [0u8; 64 * 1024]; let mut total = 0u64;
    loop { let read = file.read(&mut buffer).map_err(|_| "workspace-graph-action-file-unavailable")?; if read == 0 { break; } total += read as u64; if total > MAX_FILE_HASH { return Err("workspace-graph-action-file-limit".into()); } hash.update(&buffer[..read]); }
    checked_catalog_asset(catalog, id, revision)?;
    Ok(format!("{:x}", hash.finalize()))
}
fn check_source(view: &ViewGrant, scope: &KnowledgeService, source_id: &str) -> Result<KnowledgeTargetIdentity, String> {
    if view.kind != "graph" || view.resource_id.is_some() { return Err("workspace-graph-action-view-invalid".into()); }
    scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
    let identity = scope.current_target_identity().map_err(crate::knowledge_error)?;
    if scope.current_vault_id().map_err(crate::knowledge_error)? != view.library_id || crate::workspace_graph::graph_source_id(&identity)? != source_id { return Err("workspace-graph-action-source-changed".into()); }
    Ok(identity)
}
fn tag_key(value: &str) -> String { value.trim().trim_start_matches('#').trim().nfc().collect::<String>().to_lowercase() }
fn graph_ai(scope: &KnowledgeService, identity: &KnowledgeTargetIdentity, node: &GrantedGraphNode) -> Result<GraphMainAction, String> {
    let text = match node {
        GrantedGraphNode::Document { document_ref, revision, title, .. } => {
            let note = scope.read_document_for_target(identity, document_ref).map_err(crate::knowledge_error)?;
            if note.revision != *revision { return Err("workspace-graph-action-revision-changed".into()); }
            format!("请解释这个图谱笔记节点的上下文关系，并建议下一步整理工作。\n\n笔记：{}\n\n{}", limited(title,256), limited(&note.content,8*1024))
        },
        GrantedGraphNode::Tag { name } => {
            let index = scope.refresh_index_for_target(identity).map_err(crate::knowledge_error)?;
            if index.stale || !index.errors.is_empty() || index.refresh_error.is_some() { return Err("workspace-graph-action-index-incomplete".into()); }
            let names = index.documents.iter().filter(|note| note.tags.iter().any(|tag| tag_key(tag)==tag_key(name))).take(32).map(|note| limited(&note.title,200)).collect::<Vec<_>>();
            if names.is_empty() { return Err("workspace-graph-action-target-changed".into()); }
            format!("请解释这个已绑定来源图谱中的标签关系并建议整理工作。\n标签：{}\n关联笔记标题（最多32条）：\n{}",limited(name,256),names.join("\n"))
        },
        _ => return Err("workspace-graph-action-unsupported-target".into()),
    };
    Ok(GraphMainAction::ComposeAi { source: "graph", text })
}

impl WorkspaceGraphActions {
    // Claimed effects belong to one Main lease. Retiring that owner is terminal:
    // never release its claims for replay, and never overwrite a completed result.
    fn retire_claims(state: &mut BrokerState, lease_token: &str) {
        for entry in state.entries.values_mut() {
            if entry.result.is_none() && entry.claim.as_ref().is_some_and(|(owner, _)| owner == lease_token) {
                entry.result = Some(GraphCompletion::Failed { code: "workspace-graph-main-retired".into() });
            }
        }
    }
    pub(crate) fn register(&self, caller: &str, kinds: Vec<GraphMainKind>) -> Result<GraphMainLease, String> {
        main_only(caller)?; if kinds.len() > 7 { return Err("workspace-graph-action-services-invalid".into()); }
        let kinds = kinds.into_iter().collect::<HashSet<_>>();
        let mut state = self.state.lock().map_err(|_| "workspace-graph-action-lock")?;
        let token = state.lease.as_ref().filter(|lease| lease.expires > Instant::now() && lease.kinds == kinds).map(|lease| lease.token.clone()).unwrap_or_else(opaque);
        if let Some(retired) = state.lease.as_ref().filter(|lease| lease.token != token).map(|lease| lease.token.clone()) {
            Self::retire_claims(&mut state, &retired);
        }
        state.lease = Some(Lease { token: token.clone(), kinds, expires: Instant::now()+LEASE_TTL });
        Ok(GraphMainLease { lease_token: token, expires_in_ms: LEASE_TTL.as_millis() as u64 })
    }
    pub(crate) fn unregister(&self, caller: &str, lease_token: &str) -> Result<(), String> {
        main_only(caller)?; let mut state = self.state.lock().map_err(|_| "workspace-graph-action-lock")?;
        if state.lease.as_ref().is_some_and(|lease| lease.token == lease_token) { Self::retire_claims(&mut state, lease_token); state.lease = None; } Ok(())
    }
    pub(crate) fn available(&self) -> Result<Vec<GraphMainKind>, String> {
        let state = self.state.lock().map_err(|_| "workspace-graph-action-lock")?;
        Ok(state.lease.as_ref().filter(|lease| lease.expires>Instant::now()).map(|lease| lease.kinds.iter().copied().collect()).unwrap_or_default())
    }
    fn lease<'a>(state: &'a BrokerState, token: &str, kind: Option<GraphMainKind>) -> Result<&'a Lease, String> {
        state.lease.as_ref().filter(|lease| lease.token==token && lease.expires>Instant::now() && kind.map_or(true,|kind|lease.kinds.contains(&kind))).ok_or_else(||"workspace-graph-main-service-unavailable".into())
    }
    fn insert(&self, mut entry: Entry) -> Result<ActionReceipt,String> {
        if entry.caller.is_empty() || entry.caller.len()>128 || entry.view.id.is_empty() || entry.view.id.len()>128
            || entry.correlation.request_id==0 || entry.correlation.request_id>9_007_199_254_740_991 { return Err("workspace-graph-action-request-invalid".into()); }
        let mut state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;
        let lease=state.lease.as_ref().ok_or("workspace-graph-main-service-unavailable")?;
        Self::lease(&state,&lease.token,Some(entry.action.service()))?;
        state.entries.retain(|_,held|held.expires>Instant::now());
        let owner=(entry.caller.clone(),entry.view.id.clone());
        if state.latest.get(&owner).is_some_and(|last|*last>=entry.correlation.request_id) {return Err("workspace-graph-action-request-superseded".into());}
        if !state.latest.contains_key(&owner) && state.latest.len()>=256 {return Err("workspace-graph-action-capacity".into());}
        if state.entries.values().any(|held|held.caller==entry.caller&&held.view.id==entry.view.id&&held.claim.is_some()&&held.result.is_none()) {return Err("workspace-graph-action-in-progress".into());}
        state.entries.retain(|_,held|held.caller!=entry.caller||held.view.id!=entry.view.id);
        let held_bytes:usize=state.entries.values().map(|held|match &held.action{GraphMainAction::Screenshot{bytes,..}=>bytes.len(),_=>0}).sum();
        let incoming_bytes=match &entry.action{GraphMainAction::Screenshot{bytes,..}=>bytes.len(),_=>0};
        if held_bytes+incoming_bytes>2*MAX_PNG_BYTES{return Err("workspace-graph-action-capacity".into());}
        if state.entries.len()>=MAX_ACTIONS || state.entries.values().filter(|held|held.caller==entry.caller).count()>=MAX_PER_WINDOW {return Err("workspace-graph-action-capacity".into());}
        entry.expires=Instant::now()+ACTION_TTL;
        let receipt=ActionReceipt{id:entry.id.clone(),request_id:entry.correlation.request_id,view_id:entry.view.id.clone(),revision:entry.correlation.revision.clone(),generation:0};
        state.latest.insert(owner,entry.correlation.request_id);state.entries.insert(entry.id.clone(),entry);Ok(receipt)
    }
    pub(crate) fn has_pending_window(&self,label:&str)->Result<bool,String>{
        let state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;
        Ok(state.entries.values().any(|entry|entry.expires>Instant::now()&&entry.result.is_none()&&(entry.caller==label||label=="main")))
    }
    pub(crate) fn enqueue_node(&self,caller:&str,view:&ViewGrant,scope:&KnowledgeService,catalog:&MaterialCatalog,graphs:&WorkspaceGraphs,
        snapshot_id:&str,source_id:&str,node_token:&str,request_id:u64,action:GraphAction)->Result<ActionReceipt,String>{
        let identity=check_source(view,scope,source_id)?;
        let node=graphs.node_for_scope(caller,&view.id,snapshot_id,node_token,scope)?;
        let revision=graphs.rendered_revision(caller,&view.id,snapshot_id)?;
        let mut native_digest=None;
        let main_action=match (&node,action){
            (GrantedGraphNode::Document{title,..},GraphAction::Open)=>GraphMainAction::OpenDocument{vault_id:view.library_id.clone(),title:title.clone()},
            (GrantedGraphNode::Tag{name},GraphAction::Open)=>GraphMainAction::OpenTag{vault_id:view.library_id.clone(),name:name.clone()},
            (GrantedGraphNode::MissingDocument{target,..},GraphAction::CreateMissing)=>GraphMainAction::CreateMissing{vault_id:view.library_id.clone(),title:target.title.clone(),relative_path:target.relative_path.clone()},
            (GrantedGraphNode::Document{title,..},GraphAction::OpenDefault|GraphAction::Reveal)=>GraphMainAction::FileOperation{mode:if action==GraphAction::Reveal{"reveal"}else{"open"},label:title.clone()},
            (GrantedGraphNode::Document{..}|GrantedGraphNode::Tag{..},GraphAction::AskAi)=>graph_ai(scope,&identity,&node)?,
            (GrantedGraphNode::LibraryAsset{asset_id,asset_revision},GraphAction::AskAi)=>{
                let asset=checked_catalog_asset(catalog,asset_id,asset_revision)?;
                native_digest=Some(catalog_file_digest(catalog,asset_id,asset_revision)?);
                GraphMainAction::ComposeAi{source:"graph",text:format!("请根据以下已绑定来源的素材元数据，解释这个图谱素材节点的关系并建议整理工作。\n素材名：{}\n类型：{}\n描述：{}",limited(&asset.name,256),limited(&asset.kind,64),limited(&asset.description,6*1024))}
            },
            (GrantedGraphNode::VaultAsset{source_ref,source_revision,target,relative_path,attachment_revision},GraphAction::AskAi)=>{
                native_digest=Some(scope.with_workspace_graph_asset(&identity,source_ref,source_revision,target,relative_path,attachment_revision,None,|_,bytes|Ok(digest(bytes)))?);
                GraphMainAction::ComposeAi{source:"graph",text:format!("请根据以下已绑定来源图谱中的附件关系，建议整理工作。\n来源笔记：{}\n附件：{}",limited(&source_ref.relative_path,1024),limited(relative_path,1024))}
            },
            (GrantedGraphNode::LibraryAsset{asset_id,asset_revision},GraphAction::Open|GraphAction::OpenDefault|GraphAction::Reveal)=>{
                let asset=checked_catalog_asset(catalog,asset_id,asset_revision)?;
                native_digest=Some(catalog_file_digest(catalog,asset_id,asset_revision)?);
                if action==GraphAction::Open {GraphMainAction::OpenCatalogAsset{library_id:catalog.library_scope_key().map_err(material_error)?,asset,asset_revision:asset_revision.clone()}}
                else {GraphMainAction::FileOperation{mode:if action==GraphAction::Reveal{"reveal"}else{"open"},label:asset.name}}
            },
            (GrantedGraphNode::VaultAsset{source_ref,source_revision,target,relative_path,attachment_revision},GraphAction::Open|GraphAction::OpenDefault|GraphAction::Reveal)=>{
                native_digest=Some(scope.with_workspace_graph_asset(&identity,source_ref,source_revision,target,relative_path,attachment_revision,None,|_,bytes|Ok(digest(bytes)))?);
                GraphMainAction::FileOperation{mode:if action==GraphAction::Reveal{"reveal"}else{"open"},label:relative_path.rsplit('/').next().unwrap_or(relative_path).into()}
            },
            _=>return Err("workspace-graph-action-unsupported-target".into()),
        };
        self.insert(Entry{id:opaque(),caller:caller.into(),view:view.clone(),correlation:ActionCorrelation{request_id,revision,generation:0},scope:scope.clone(),catalog:catalog.clone(),identity,
            snapshot_id:snapshot_id.into(),source_id:source_id.into(),node_token:Some(node_token.into()),node:Some(node),native_digest,action:main_action,expires:Instant::now(),claim:None,executed:false,execution:None,result:None})
    }
    pub(crate) fn enqueue_screenshot(&self,caller:&str,view:&ViewGrant,scope:&KnowledgeService,catalog:&MaterialCatalog,graphs:&WorkspaceGraphs,
        snapshot_id:&str,source_id:&str,revision:&str,request_id:u64,bytes:Vec<u8>)->Result<ActionReceipt,String>{
        validate_png(&bytes)?;
        let identity=check_source(view,scope,source_id)?;
        if graphs.rendered_revision(caller,&view.id,snapshot_id)?!=revision{return Err("workspace-graph-action-revision-changed".into());}
        let resolver=CapturedCatalogResolver::capture(catalog)?;WorkspaceGraphs::check_revision(scope,revision,|target|resolver.resolve(target))?;
        self.insert(Entry{id:opaque(),caller:caller.into(),view:view.clone(),correlation:ActionCorrelation{request_id,revision:revision.into(),generation:0},scope:scope.clone(),catalog:catalog.clone(),identity,
            snapshot_id:snapshot_id.into(),source_id:source_id.into(),node_token:None,node:None,native_digest:None,action:GraphMainAction::Screenshot{mime:"image/png",bytes},expires:Instant::now(),claim:None,executed:false,execution:None,result:None})
    }
    fn validate_entry(entry:&Entry,graphs:&WorkspaceGraphs,live:&mut impl FnMut(&str,&ViewGrant,&ActionCorrelation)->Result<(),String>)->Result<(),String>{
        if entry.expires<=Instant::now(){return Err(EXPIRED.into());}
        live(&entry.caller,&entry.view,&entry.correlation)?;
        if check_source(&entry.view,&entry.scope,&entry.source_id)?!=entry.identity{return Err("workspace-graph-action-source-changed".into());}
        if graphs.rendered_revision(&entry.caller,&entry.view.id,&entry.snapshot_id)?!=entry.correlation.revision{return Err("workspace-graph-action-revision-changed".into());}
        if let Some(ticket)=&entry.node_token {graphs.node_for_scope(&entry.caller,&entry.view.id,&entry.snapshot_id,ticket,&entry.scope)?;}
        match &entry.node {
            Some(GrantedGraphNode::Document{document_ref,revision,..})=>{if entry.scope.read_document_for_target(&entry.identity,document_ref).map_err(crate::knowledge_error)?.revision!=*revision{return Err("workspace-graph-action-revision-changed".into());}},
            Some(GrantedGraphNode::MissingDocument{source_ref,source_revision,..})=>{if entry.scope.read_document_for_target(&entry.identity,source_ref).map_err(crate::knowledge_error)?.revision!=*source_revision{return Err("workspace-graph-action-revision-changed".into());}},
            Some(GrantedGraphNode::LibraryAsset{asset_id,asset_revision})=>{if Some(catalog_file_digest(&entry.catalog,asset_id,asset_revision)?)!=entry.native_digest{return Err("workspace-graph-action-asset-changed".into());}},
            Some(GrantedGraphNode::VaultAsset{source_ref,source_revision,target,relative_path,attachment_revision})=>{entry.scope.with_workspace_graph_asset(&entry.identity,source_ref,source_revision,target,relative_path,attachment_revision,entry.native_digest.as_deref(),|_,_|Ok(()))?;},
            Some(GrantedGraphNode::Tag{..})|None=>{let resolver=CapturedCatalogResolver::capture(&entry.catalog)?;WorkspaceGraphs::check_revision(&entry.scope,&entry.correlation.revision,|target|resolver.resolve(target))?;},
        }
        Ok(())
    }
    pub(crate) fn pending(&self,caller:&str,lease_token:&str)->Result<Vec<GraphMainOffer>,String>{
        main_only(caller)?;let mut state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;Self::lease(&state,lease_token,None)?;
        state.entries.retain(|_,entry|entry.expires>Instant::now());
        Ok(state.entries.values().filter(|entry|entry.claim.is_none()&&entry.result.is_none()).map(|entry|GraphMainOffer{id:entry.id.clone(),view_id:entry.view.id.clone(),title:entry.view.title.clone()}).collect())
    }
    pub(crate) fn claim(&self,caller:&str,lease_token:&str,id:&str,graphs:&WorkspaceGraphs,mut live:impl FnMut(&str,&ViewGrant,&ActionCorrelation)->Result<(),String>)->Result<GraphMainClaim,String>{
        main_only(caller)?;let mut state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;
        let entry=state.entries.get(id).ok_or(EXPIRED)?;Self::lease(&state,lease_token,Some(entry.action.service()))?;
        if entry.claim.is_some()||entry.result.is_some(){return Err("workspace-graph-action-already-claimed".into());}
        Self::validate_entry(entry,graphs,&mut live)?;
        let entry=state.entries.get_mut(id).ok_or(EXPIRED)?;let claim_token=opaque();entry.claim=Some((lease_token.into(),claim_token.clone()));
        Ok(GraphMainClaim{id:entry.id.clone(),claim_token,remaining_ms:entry.expires.saturating_duration_since(Instant::now()).as_millis() as u64,action:entry.action.clone()})
    }
    fn claim_entry<'a>(state:&'a BrokerState,lease_token:&str,id:&str,claim_token:&str)->Result<&'a Entry,String>{
        let entry=state.entries.get(id).ok_or(EXPIRED)?;Self::lease(state,lease_token,Some(entry.action.service()))?;
        if entry.claim.as_ref().map(|(lease,claim)|(lease.as_str(),claim.as_str()))!=Some((lease_token,claim_token))||entry.result.is_some(){return Err("workspace-graph-action-claim-invalid".into());}Ok(entry)
    }
    /// Only tags use Main's existing source-bound Tags page. Check its native
    /// identity before claim/presentation/completion; matching a vault id alone
    /// does not prove that Main still owns the captured root.
    pub(crate) fn validate_main_target(&self,caller:&str,lease_token:&str,id:&str,claim_token:&str,
        check:impl FnOnce(&KnowledgeTargetIdentity)->Result<(),String>)->Result<(),String>{
        main_only(caller)?;let state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;
        let entry=Self::claim_entry(&state,lease_token,id,claim_token)?;
        if matches!(entry.action,GraphMainAction::OpenTag{..}){check(&entry.identity)?;}Ok(())
    }
    pub(crate) fn validate_claim(&self,caller:&str,lease_token:&str,id:&str,claim_token:&str,graphs:&WorkspaceGraphs,mut live:impl FnMut(&str,&ViewGrant,&ActionCorrelation)->Result<(),String>)->Result<u64,String>{
        main_only(caller)?;let state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;let entry=Self::claim_entry(&state,lease_token,id,claim_token)?;Self::validate_entry(entry,graphs,&mut live)?;
        Ok(entry.expires.saturating_duration_since(Instant::now()).as_millis() as u64)
    }
    /// Native effects are at most once. The host derives dirty-note guards and
    /// destinations from verified references; no renderer path reaches it.
    pub(crate) fn execute<Guard>(&self,caller:&str,lease_token:&str,id:&str,claim_token:&str,input:GraphExecuteInput,
        app:&tauri::AppHandle,graphs:&WorkspaceGraphs,
        mut live:impl FnMut(&str,&ViewGrant,&ActionCorrelation)->Result<(),String>,
        bind_document:impl FnOnce(&str,&ViewGrant,&KnowledgeService,&KnowledgeDocumentRef,&str)->Result<BoundDocument,String>,
        authorize_write:impl FnOnce(&KnowledgeService,&[KnowledgeDocumentRef])->Result<Guard,String>,
    )->Result<Value,String>{
        main_only(caller)?;
        let mut state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;
        let entry=Self::claim_entry(&state,lease_token,id,claim_token)?;
        Self::validate_entry(entry,graphs,&mut live)?;
        if entry.executed{return Err("workspace-graph-action-already-executed".into());}
        if matches!(input,GraphExecuteInput::SaveScreenshot {}){
            if !matches!(entry.action,GraphMainAction::Screenshot{..}){return Err("workspace-graph-action-invalid-execution".into());}
            state.entries.get_mut(id).ok_or(EXPIRED)?.executed=true;
            // Native dialog can wait for a user. Never hold the broker or registry
            // lock while it is open; renewals and source close must remain live.
            drop(state);
            let selected=app.dialog().file().set_title("保存图谱截图").add_filter("PNG image",&["png"]).set_file_name("luckyray-graph.png").blocking_save_file();
            let mut state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;
            let entry=Self::claim_entry(&state,lease_token,id,claim_token)?;
            Self::validate_entry(entry,graphs,&mut live)?;
            let Some(selected)=selected else {
                state.entries.get_mut(id).ok_or(EXPIRED)?.execution=Some(GraphCompletion::Cancelled {});
                return Ok(json!({"kind":"screenshot","result":"cancelled"}));
            };
            let path=selected.into_path().map_err(|_|"workspace-graph-screenshot-destination-unavailable")?;
            let GraphMainAction::Screenshot{bytes,..}=&entry.action else {return Err("workspace-graph-action-invalid-execution".into());};
            validate_png(bytes)?;
            // create_new rejects symlinks and existing files. This narrow route
            // never silently overwrites another file chosen by a stale dialog.
            let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_|"workspace-graph-screenshot-save-failed")?;
            use std::io::Write;
            file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|_|"workspace-graph-screenshot-save-failed")?;
            Self::validate_entry(entry,graphs,&mut live)?;
            state.entries.get_mut(id).ok_or(EXPIRED)?.execution=Some(GraphCompletion::Screenshot{result:ScreenshotResult::Saved});
            return Ok(json!({"kind":"screenshot","result":"saved"}));
        }
        let GraphExecuteInput::Perform{confirmed}=input else {return Err("workspace-graph-action-invalid-execution".into());};
        if entry.action.presentation()||matches!(entry.action,GraphMainAction::Screenshot{..}){return Err("workspace-graph-action-main-presentation-required".into());}
        if matches!(entry.action,GraphMainAction::CreateMissing{..})&&!confirmed{return Err("workspace-graph-action-confirmation-required".into());}
        let entry=state.entries.get_mut(id).ok_or(EXPIRED)?;
        entry.executed=true;
        let result=(||->Result<MainExecution,String>{match(&entry.action,&entry.node){
            (GraphMainAction::OpenDocument{..},Some(GrantedGraphNode::Document{document_ref,title,..}))=>Ok(bind_document(&entry.caller,&entry.view,&entry.scope,document_ref,title)?.into()),
            (GraphMainAction::FileOperation{mode,..},Some(GrantedGraphNode::Document{document_ref,revision,..}))=>{
                entry.scope.with_workspace_action_document_path(&entry.identity,document_ref,revision,|path|shell(path,mode))?;Ok(MainExecution::Acknowledged)
            },
            (GraphMainAction::FileOperation{mode,..},Some(GrantedGraphNode::LibraryAsset{asset_id,asset_revision}))=>{
                // Resolve the exact companion resource while holding its native
                // file handle. The existing material-shell boundary rechecks the
                // captured catalog's physical file and storage mode at launch.
                let (_,file)=entry.catalog.companion_resource(asset_id,false).map_err(material_error)?;
                if Some(catalog_file_digest(&entry.catalog,asset_id,asset_revision)?)!=entry.native_digest{return Err("workspace-graph-action-asset-changed".into());}
                crate::material_shell::perform(&entry.catalog,&crate::material_shell::MaterialShellRequest{asset_id:asset_id.clone(),action:if *mode=="reveal"{crate::material_shell::MaterialShellAction::Reveal}else{crate::material_shell::MaterialShellAction::Open}})?;
                drop(file);Ok(MainExecution::Acknowledged)
            },
            (GraphMainAction::FileOperation{mode,..},Some(GrantedGraphNode::VaultAsset{source_ref,source_revision,target,relative_path,attachment_revision}))=>{
                entry.scope.with_workspace_graph_asset(&entry.identity,source_ref,source_revision,target,relative_path,attachment_revision,entry.native_digest.as_deref(),|path,_|shell(path,mode))?;Ok(MainExecution::Acknowledged)
            },
            (GraphMainAction::CreateMissing{..},Some(GrantedGraphNode::MissingDocument{source_ref,source_revision,raw_target,target}))=>{
                let target_ref=KnowledgeDocumentRef{vault_id:entry.view.library_id.clone(),relative_path:target.relative_path.clone()};
                let _write=authorize_write(&entry.scope,&[source_ref.clone(),target_ref])?;
                Self::validate_entry(entry,graphs,&mut live)?;
                let index=entry.scope.refresh_index_for_target(&entry.identity).map_err(crate::knowledge_error)?;
                if index.stale||!index.errors.is_empty()||index.refresh_error.is_some(){return Err("workspace-graph-action-index-incomplete".into());}
                let source=index.documents.iter().find(|document|document.document_ref==*source_ref).ok_or("workspace-graph-action-source-changed")?;
                if source.revision!=*source_revision||!source.wiki_links.iter().any(|link|link.target.split('|').next()==Some(raw_target.as_str())){return Err("workspace-graph-action-revision-changed".into());}
                if crate::workspace_graph::missing_document_target(&source_ref.relative_path,raw_target).as_ref()!=Some(target)
                    ||!crate::workspace_graph::missing_target_is_unresolved(&index,source_ref,raw_target){return Err("workspace-graph-action-create-conflict".into());}
                let created=entry.scope.create_workspace_graph_missing(&entry.identity,source_ref,source_revision,raw_target,target).map_err(crate::knowledge_error)?;
                drop(_write);
                Ok(bind_document(&entry.caller,&entry.view,&entry.scope,&created.summary.document_ref,&created.summary.title)?.into())
            },
            _=>Err("workspace-graph-action-unsupported-target".into()),
        }})();
        entry.execution=Some(if result.is_ok(){GraphCompletion::Acknowledged {}}else{GraphCompletion::Failed{code:"workspace-graph-native-effect-failed".into()}});
        result.and_then(|execution|serde_json::to_value(execution).map_err(|_|"workspace-graph-action-serialize".into()))
    }
    pub(crate) fn complete(&self,caller:&str,lease_token:&str,id:&str,claim_token:&str,result:GraphCompletion,graphs:&WorkspaceGraphs,
        mut live:impl FnMut(&str,&ViewGrant,&ActionCorrelation)->Result<(),String>)->Result<(),String>{
        main_only(caller)?;let mut state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;
        let entry=Self::claim_entry(&state,lease_token,id,claim_token)?;
        Self::validate_entry(entry,graphs,&mut live)?;
        match &result {
            GraphCompletion::Acknowledged {} if entry.action.presentation()=>(),
            GraphCompletion::Acknowledged {} if entry.execution==Some(GraphCompletion::Acknowledged {})=>(),
            GraphCompletion::Screenshot{result:ScreenshotResult::Copied} if matches!(entry.action,GraphMainAction::Screenshot{..})&&!entry.executed=>(),
            GraphCompletion::Screenshot{result:ScreenshotResult::Saved} if entry.execution==Some(result.clone())=>(),
            GraphCompletion::Cancelled {}=>(),
            GraphCompletion::Failed{code} if !code.is_empty()&&code.len()<=128&&code.bytes().all(|ch|ch.is_ascii_alphanumeric()||ch==b'-')=>(),
            _=>return Err("workspace-graph-action-effect-unconfirmed".into()),
        }
        state.entries.get_mut(id).ok_or(EXPIRED)?.result=Some(result);Ok(())
    }
    pub(crate) fn status(&self,caller:&str,view:&ViewGrant,id:&str,correlation:&ActionCorrelation,graphs:&WorkspaceGraphs,
        mut live:impl FnMut(&str,&ViewGrant,&ActionCorrelation)->Result<(),String>)->Result<Value,String>{
        let state=self.state.lock().map_err(|_|"workspace-graph-action-lock")?;
        let entry=state.entries.get(id).filter(|entry|entry.caller==caller&&entry.view==*view&&entry.correlation==*correlation).ok_or(EXPIRED)?;
        Self::validate_entry(entry,graphs,&mut live)?;
        Ok(match &entry.result{
            None=>json!({"state":"pending"}),
            Some(GraphCompletion::Acknowledged {})=>json!({"state":"completed","result":{"ok":true,"value":{"kind":"acknowledged"}}}),
            Some(GraphCompletion::Screenshot{result})=>json!({"state":"completed","result":{"ok":true,"value":{"kind":"screenshot","result":result}}}),
            Some(GraphCompletion::Cancelled {})=>json!({"state":"completed","result":{"ok":false,"code":"cancelled","message":"workspace-graph-action-cancelled"}}),
            Some(GraphCompletion::Failed{code})=>json!({"state":"completed","result":{"ok":false,"code":"unavailable","message":code}}),
        })
    }
    pub(crate) fn remove_view(&self,caller:&str,view_id:&str){if let Ok(mut state)=self.state.lock(){state.entries.retain(|_,entry|entry.caller!=caller||entry.view.id!=view_id);state.latest.remove(&(caller.into(),view_id.into()));}}
    pub(crate) fn remove_window(&self,caller:&str){if let Ok(mut state)=self.state.lock(){state.entries.retain(|_,entry|entry.caller!=caller);state.latest.retain(|(owner,_),_|owner!=caller);if caller=="main"{if let Some(retired)=state.lease.take(){Self::retire_claims(&mut state,&retired.token);}}}}
}
fn shell(path:&std::path::Path,mode:&str)->Result<(),String>{
    if mode=="reveal"{tauri_plugin_opener::reveal_item_in_dir(path).map_err(|_|"workspace-graph-action-shell-failed".into())}
    else{tauri_plugin_opener::open_path(path,None::<&str>).map_err(|_|"workspace-graph-action-shell-failed".into())}
}
fn crc32(bytes:&[u8])->u32{let mut crc=!0u32;for byte in bytes{crc^=*byte as u32;for _ in 0..8{crc=(crc>>1)^if crc&1!=0{0xedb8_8320}else{0};}}!crc}
fn read_be(bytes:&[u8])->Result<u32,String>{Ok(u32::from_be_bytes(bytes.try_into().map_err(|_|"workspace-graph-screenshot-invalid")?))}
/// Decode the actual bounded raster, verify every PNG CRC and require a complete
/// zlib stream. Canvas produces non-interlaced PNG; animated/interlaced inputs
/// are deliberately outside this narrowly granted screenshot payload.
fn validate_png(bytes:&[u8])->Result<(),String>{
    let invalid=||"workspace-graph-screenshot-invalid".to_owned();
    if bytes.len()<57||bytes.len()>MAX_PNG_BYTES||bytes.get(..8)!=Some(&b"\x89PNG\r\n\x1a\n"[..]){return Err(invalid());}
    let(mut offset,mut row_bytes,mut height,mut expected,mut color)=(8usize,0usize,0usize,0usize,0u8);
    let(mut header,mut data,mut ended,mut palette,mut data_ended)=(false,false,false,false,false);
    let mut compressed=Vec::new();
    while offset<bytes.len(){
        let length=read_be(bytes.get(offset..offset+4).ok_or_else(invalid)?)? as usize;
        let end=offset.checked_add(length).and_then(|value|value.checked_add(12)).filter(|end|*end<=bytes.len()).ok_or_else(invalid)?;
        let kind=&bytes[offset+4..offset+8];let payload=&bytes[offset+8..end-4];
        if kind.iter().any(|ch|!ch.is_ascii_alphabetic())||crc32(&bytes[offset+4..end-4])!=read_be(&bytes[end-4..end])?{return Err(invalid());}
        match kind {
            b"IHDR"=>{
                if header||offset!=8||length!=13{return Err(invalid());}header=true;
                let width=read_be(&payload[..4])? as usize;height=read_be(&payload[4..8])? as usize;
                let depth=payload[8] as usize;color=payload[9];
                let channels=match color{0 if [1,2,4,8,16].contains(&depth)=>1,2 if [8,16].contains(&depth)=>3,3 if [1,2,4,8].contains(&depth)=>1,4 if [8,16].contains(&depth)=>2,6 if [8,16].contains(&depth)=>4,_=>return Err(invalid())};
                if width==0||height==0||width>8192||height>8192||width.checked_mul(height).filter(|pixels|*pixels<=MAX_PNG_PIXELS).is_none()||payload[10..]!=[0,0,0]{return Err(invalid());}
                row_bytes=(width*channels*depth+7)/8+1;expected=row_bytes*height;
            },
            b"PLTE"=>{if !header||data||palette||length==0||length>768||length%3!=0{return Err(invalid());}palette=true;},
            b"IDAT"=>{if !header||data_ended||color==3&&!palette{return Err(invalid());}data=true;compressed.extend_from_slice(payload);},
            b"IEND"=>{if !header||!data||length!=0||end!=bytes.len(){return Err(invalid());}ended=true;},
            b"acTL"|b"fcTL"|b"fdAT"=>return Err(invalid()),
            _=>{if !header||kind[0].is_ascii_uppercase(){return Err(invalid());}if data{data_ended=true;}},
        }
        if ended{break;}offset=end;
    }
    if !ended||compressed.is_empty()||expected>MAX_PNG_PIXELS*8+8192{return Err(invalid());}
    let mut decoder=flate2::Decompress::new(true);
    let mut raster=Vec::with_capacity(expected+1);
    let status=decoder.decompress_vec(&compressed,&mut raster,flate2::FlushDecompress::Finish).map_err(|_|invalid())?;
    if status!=flate2::Status::StreamEnd||raster.len()!=expected||decoder.total_in()!=compressed.len() as u64{return Err(invalid());}
    if (0..height).any(|row|raster[row*row_bytes]>4){return Err(invalid());}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn asset(id:&str,name:&str,path:&str)->MaterialAsset{
        MaterialAsset{id:id.into(),name:name.into(),original_path:path.into(),library_path:None,storage_mode:"linked".into(),kind:"image".into(),mime_type:"image/png".into(),size_bytes:Some(1),thumbnail_url:String::new(),description:String::new(),rating:None,dominant_color:None,folder_id:None,imported_at:"2026-10-06".into(),updated_at:"2026-10-06".into(),content_hash:None}
    }
    fn resolver(assets:Vec<MaterialAsset>)->CapturedCatalogResolver{
        let mut direct:HashMap<String,HashSet<usize>>=HashMap::new();
        for(index,asset)in assets.iter().enumerate(){for key in[asset.id.clone(),asset.name.clone(),path_filename(&asset.original_path),path_filename(asset.library_path.as_deref().unwrap_or_default()),vault_path(&asset.original_path),vault_path(asset.library_path.as_deref().unwrap_or_default())]{let key=wiki_key(&key);if !key.is_empty(){direct.entry(key).or_default().insert(index);}}}
        CapturedCatalogResolver{catalog:MaterialCatalog::new_for_test(),library_id:"test".into(),version:1,assets,direct}
    }
    #[test]
    fn catalog_matching_preserves_main_exact_id_path_and_ambiguity_semantics(){
        let resolver=resolver(vec![asset("ID-A","shared.png","C:\\first\\shared.png"),asset("ID-B","shared.png","C:\\second\\shared.png"),asset("ID-C","café.png","/vault/pictures/café.png")]);
        assert_eq!(resolver.selected("ID-A").unwrap().id,"ID-A");
        assert!(resolver.selected("shared.png").is_none());
        assert_eq!(resolver.selected("C:/first/shared.png").unwrap().id,"ID-A");
        assert!(resolver.selected("first/shared.png").is_none(),"Main does not grant arbitrary suffix aliases");
        assert_eq!(resolver.selected("caf%C3%A9.png|display").unwrap().id,"ID-C");
        assert_eq!(resolver.selected("cafe\u{301}.png#fragment").unwrap().id,"ID-C");
        assert_eq!(embed_target("a%20b%QQ"),"a%20b%QQ","URI decode is all-or-nothing");
        assert_eq!(embed_target("\u{200b}hello\\[x\\].png\u{a0}"),"hello[x].png");
    }
    #[test]
    fn complete_catalog_scan_keeps_exact_library_and_revision(){
        let catalog=MaterialCatalog::new_for_test();
        let path=catalog.app_data_dir().join("exact.png");std::fs::write(&path,b"synthetic").unwrap();
        let imported=catalog.import_paths(&[path],&crate::materials::MaterialImportOptions{storage_mode:"linked".into(),..Default::default()}).unwrap().value.assets.remove(0);
        let captured=CapturedCatalogResolver::capture(&catalog).unwrap();
        let GraphLibraryEmbed::Match{asset_id,asset_revision,..}=captured.resolve("exact.png").unwrap() else{panic!("expected exact catalog match")};
        assert_eq!(asset_id,imported.id);assert_eq!(checked_catalog_asset(&catalog,&asset_id,&asset_revision).unwrap(),imported);
        assert!(checked_catalog_asset(&catalog,&asset_id,"forged").is_err());
        assert!(matches!(captured.resolve("unknown.png").unwrap(),GraphLibraryEmbed::NoMatch));
    }
    #[test]
    fn service_leases_are_main_only_effect_specific_and_revoked_on_unmount(){
        let broker=WorkspaceGraphActions::default();assert!(broker.register("child",vec![GraphMainKind::ComposeAi]).is_err());
        let lease=broker.register("main",vec![GraphMainKind::ComposeAi]).unwrap();
        {let state=broker.state.lock().unwrap();assert!(WorkspaceGraphActions::lease(&state,&lease.lease_token,Some(GraphMainKind::ComposeAi)).is_ok());assert!(WorkspaceGraphActions::lease(&state,&lease.lease_token,Some(GraphMainKind::Screenshot)).is_err());}
        let renewed=broker.register("main",vec![GraphMainKind::ComposeAi]).unwrap();assert_eq!(lease.lease_token,renewed.lease_token);
        let changed=broker.register("main",vec![GraphMainKind::Screenshot]).unwrap();assert_ne!(lease.lease_token,changed.lease_token);
        assert!(broker.pending("main",&lease.lease_token).is_err());broker.unregister("main",&changed.lease_token).unwrap();assert!(broker.available().unwrap().is_empty());
    }
    fn fixture()->(KnowledgeService,std::path::PathBuf,ViewGrant,MaterialCatalog,WorkspaceGraphs,crate::workspace_graph::GraphSnapshot,String){
        let base=std::env::temp_dir().join(format!("workspace-graph-broker-{}",opaque()));let root=base.join("vault");std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let registration=crate::knowledge::KnowledgeVaultRegistration{id:"vault".into(),name:"Synthetic".into(),root_path:root.to_string_lossy().into(),mode:"vault-bound".into(),created_at:"2026-10-06T00:00:00Z".into(),last_opened_at:"2026-10-06T00:00:00Z".into(),schema_version:1,link_update_policy:Default::default()};
        std::fs::write(root.join(".luckyray/vault.json"),serde_json::to_vec(&registration).unwrap()).unwrap();std::fs::write(root.join("note.md"),"synthetic note").unwrap();
        let service=KnowledgeService::initialize(base.join("app")).unwrap();service.register_current_vault(&registration).unwrap();let scope=service.capture_workspace_scope("vault").unwrap();
        let view=ViewGrant{id:"graph-view".into(),kind:"graph".into(),library_id:"vault".into(),resource_id:None,title:"Graph".into()};
        let graphs=WorkspaceGraphs::default();let snapshot=graphs.read("child",&view.id,&scope,|_|Ok(GraphLibraryEmbed::NoMatch)).unwrap();
        let ticket=snapshot.grants.iter().find_map(|grant|match grant{crate::workspace_graph::GraphNodeTicket::Document{token,..}=>Some(token.clone()),_=>None}).unwrap();
        (scope,root,view,MaterialCatalog::new_for_test(),graphs,snapshot,ticket)
    }
    #[test]
    fn tickets_source_claims_and_completed_replies_are_exact_origin_bound(){
        let(scope,_,view,catalog,graphs,snapshot,ticket)=fixture();let broker=WorkspaceGraphActions::default();
        assert!(broker.enqueue_node("child",&view,&scope,&catalog,&graphs,&snapshot.snapshot_id,&snapshot.source_id,&ticket,1,GraphAction::AskAi).is_err(),"unmounted Main cannot accept an effect");
        let lease=broker.register("main",vec![GraphMainKind::ComposeAi]).unwrap();
        for(owner,source)in[("other",snapshot.source_id.as_str()),("child","graph-source-v1:forged")]{assert!(broker.enqueue_node(owner,&view,&scope,&catalog,&graphs,&snapshot.snapshot_id,source,&ticket,1,GraphAction::AskAi).is_err());}
        let receipt=broker.enqueue_node("child",&view,&scope,&catalog,&graphs,&snapshot.snapshot_id,&snapshot.source_id,&ticket,1,GraphAction::AskAi).unwrap();
        let claim=broker.claim("main",&lease.lease_token,&receipt.id,&graphs,|owner,actual,_|{assert_eq!(owner,"child");assert_eq!(actual,&view);Ok(())}).unwrap();
        assert!(broker.claim("main",&lease.lease_token,&receipt.id,&graphs,|_,_,_|Ok(())).is_err());
        let correlation=ActionCorrelation{request_id:1,revision:snapshot.revision.clone(),generation:0};
        assert!(broker.status("other",&view,&receipt.id,&correlation,&graphs,|_,_,_|Ok(())).is_err());
        assert!(broker.complete("main",&lease.lease_token,&receipt.id,"forged",GraphCompletion::Acknowledged {},&graphs,|_,_,_|Ok(())).is_err());
        broker.complete("main",&lease.lease_token,&receipt.id,&claim.claim_token,GraphCompletion::Acknowledged {},&graphs,|_,_,_|Ok(())).unwrap();
        let result=broker.status("child",&view,&receipt.id,&correlation,&graphs,|_,_,_|Ok(())).unwrap().to_string();assert!(result.contains("acknowledged"));
        for secret in["synthetic note","note.md","claimToken","sourceId"]{assert!(!result.contains(secret));}
    }
    #[test]
    fn saved_edit_revoke_close_and_false_native_success_are_rejected(){
        let(scope,root,view,catalog,graphs,snapshot,ticket)=fixture();let broker=WorkspaceGraphActions::default();let lease=broker.register("main",vec![GraphMainKind::OpenDocument]).unwrap();
        let receipt=broker.enqueue_node("child",&view,&scope,&catalog,&graphs,&snapshot.snapshot_id,&snapshot.source_id,&ticket,1,GraphAction::Open).unwrap();
        let claim=broker.claim("main",&lease.lease_token,&receipt.id,&graphs,|_,_,_|Ok(())).unwrap();
        assert!(broker.complete("main",&lease.lease_token,&receipt.id,&claim.claim_token,GraphCompletion::Acknowledged {},&graphs,|_,_,_|Ok(())).is_err());
        std::fs::write(root.join("note.md"),"changed saved note").unwrap();assert!(broker.validate_claim("main",&lease.lease_token,&receipt.id,&claim.claim_token,&graphs,|_,_,_|Ok(())).is_err());
        broker.remove_view("child",&view.id);assert!(broker.validate_claim("main",&lease.lease_token,&receipt.id,&claim.claim_token,&graphs,|_,_,_|Ok(())).is_err());
    }
    #[test]
    fn retiring_main_lease_settles_claims_without_replay_and_preserves_unclaimed_offers(){
        for retirement in ["empty", "changed", "expired", "unregister", "close"] {
            let(scope,_,view,catalog,graphs,snapshot,ticket)=fixture();
            let broker=WorkspaceGraphActions::default();
            let lease=broker.register("main",vec![GraphMainKind::ComposeAi]).unwrap();
            let receipt=broker.enqueue_node("child",&view,&scope,&catalog,&graphs,&snapshot.snapshot_id,&snapshot.source_id,&ticket,1,GraphAction::AskAi).unwrap();
            let claim=broker.claim("main",&lease.lease_token,&receipt.id,&graphs,|_,_,_|Ok(())).unwrap();
            let renewed=broker.register("main",vec![GraphMainKind::ComposeAi]).unwrap();
            assert_eq!(renewed.lease_token,lease.lease_token,"same-owner renewal retains outstanding claims");
            assert!(broker.validate_claim("main",&lease.lease_token,&receipt.id,&claim.claim_token,&graphs,|_,_,_|Ok(())).is_ok());
            // A distinct Graph has an offer that has never been claimed by the retiring owner.
            let mut other=view.clone();other.id="unclaimed-graph".into();
            let other_snapshot=graphs.read("child",&other.id,&scope,|_|Ok(GraphLibraryEmbed::NoMatch)).unwrap();
            let other_ticket=other_snapshot.grants.iter().find_map(|grant|match grant{crate::workspace_graph::GraphNodeTicket::Document{token,..}=>Some(token.clone()),_=>None}).unwrap();
            let offered=broker.enqueue_node("child",&other,&scope,&catalog,&graphs,&other_snapshot.snapshot_id,&other_snapshot.source_id,&other_ticket,1,GraphAction::AskAi).unwrap();
            // Retirement cannot undo a native effect already issued, or advertise it as success.
            {let mut state=broker.state.lock().unwrap();let entry=state.entries.get_mut(&receipt.id).unwrap();entry.executed=true;entry.execution=Some(GraphCompletion::Acknowledged {});}
            match retirement {
                "empty"=>{broker.register("main",vec![]).unwrap();},
                "changed"=>{broker.register("main",vec![GraphMainKind::Screenshot]).unwrap();},
                "expired"=>{broker.state.lock().unwrap().lease.as_mut().unwrap().expires=Instant::now()-Duration::from_secs(1);},
                "unregister"=>{broker.unregister("main",&lease.lease_token).unwrap();},
                "close"=>broker.remove_window("main"),
                _=>unreachable!(),
            }
            let replacement=broker.register("main",vec![GraphMainKind::ComposeAi]).unwrap();
            assert_ne!(replacement.lease_token,lease.lease_token);
            {let state=broker.state.lock().unwrap();let entry=state.entries.get(&receipt.id).unwrap();
                assert!(entry.executed);assert_eq!(entry.execution,Some(GraphCompletion::Acknowledged {}));
                assert_eq!(entry.claim,Some((lease.lease_token.clone(),claim.claim_token.clone())));
            }
            let correlation=ActionCorrelation{request_id:1,revision:snapshot.revision.clone(),generation:0};
            let status=broker.status("child",&view,&receipt.id,&correlation,&graphs,|_,_,_|Ok(())).unwrap();
            assert_eq!(status["state"],"completed");
            assert_eq!(status["result"]["ok"],false);
            assert_eq!(status["result"]["message"],"workspace-graph-main-retired");
            assert!(broker.complete("main",&lease.lease_token,&receipt.id,&claim.claim_token,GraphCompletion::Acknowledged {},&graphs,|_,_,_|Ok(())).is_err());
            assert!(broker.complete("main",&replacement.lease_token,&receipt.id,&claim.claim_token,GraphCompletion::Acknowledged {},&graphs,|_,_,_|Ok(())).is_err());
            assert!(broker.claim("main",&replacement.lease_token,&receipt.id,&graphs,|_,_,_|Ok(())).is_err(),"retired claimed work must never be replayed");
            assert_eq!(broker.status("child",&view,&receipt.id,&correlation,&graphs,|_,_,_|Ok(())).unwrap(),status);
            let pending=broker.pending("main",&replacement.lease_token).unwrap();
            assert!(pending.iter().any(|offer|offer.id==offered.id));
            assert!(!pending.iter().any(|offer|offer.id==receipt.id));
            assert!(broker.claim("main",&replacement.lease_token,&offered.id,&graphs,|_,_,_|Ok(())).is_ok());
            assert!(broker.enqueue_node("child",&view,&scope,&catalog,&graphs,&snapshot.snapshot_id,&snapshot.source_id,&ticket,2,GraphAction::AskAi).is_ok(),"retired claim cannot block the Graph's next action");
        }
    }
    #[test]
    fn retirement_preserves_completed_outcomes_and_stale_unregister_cannot_revoke_successor(){
        let(scope,_,view,catalog,graphs,snapshot,ticket)=fixture();
        let broker=WorkspaceGraphActions::default();
        let lease=broker.register("main",vec![GraphMainKind::ComposeAi]).unwrap();
        let receipt=broker.enqueue_node("child",&view,&scope,&catalog,&graphs,&snapshot.snapshot_id,&snapshot.source_id,&ticket,1,GraphAction::AskAi).unwrap();
        let claim=broker.claim("main",&lease.lease_token,&receipt.id,&graphs,|_,_,_|Ok(())).unwrap();
        broker.complete("main",&lease.lease_token,&receipt.id,&claim.claim_token,GraphCompletion::Acknowledged {},&graphs,|_,_,_|Ok(())).unwrap();
        broker.register("main",vec![]).unwrap();
        let replacement=broker.register("main",vec![GraphMainKind::ComposeAi]).unwrap();
        broker.unregister("main",&lease.lease_token).unwrap();
        assert!(broker.pending("main",&replacement.lease_token).is_ok());
        let correlation=ActionCorrelation{request_id:1,revision:snapshot.revision.clone(),generation:0};
        let status=broker.status("child",&view,&receipt.id,&correlation,&graphs,|_,_,_|Ok(())).unwrap();
        assert_eq!(status["result"]["ok"],true);
    }
    fn png(width:u32,height:u32,raw:&[u8])->Vec<u8>{
        use std::io::Write;let mut result=b"\x89PNG\r\n\x1a\n".to_vec();
        let mut chunk=|kind:&[u8;4],data:&[u8]|{result.extend_from_slice(&(data.len() as u32).to_be_bytes());result.extend_from_slice(kind);result.extend_from_slice(data);let mut checked=kind.to_vec();checked.extend_from_slice(data);result.extend_from_slice(&crc32(&checked).to_be_bytes());};
        let mut header=width.to_be_bytes().to_vec();header.extend_from_slice(&height.to_be_bytes());header.extend_from_slice(&[8,6,0,0,0]);chunk(b"IHDR",&header);
        let mut encoder=flate2::write::ZlibEncoder::new(Vec::new(),flate2::Compression::default());encoder.write_all(raw).unwrap();chunk(b"IDAT",&encoder.finish().unwrap());chunk(b"IEND",&[]);result
    }
    #[test]
    fn screenshot_validates_crc_dimensions_filters_full_raster_and_bounds(){
        let valid=png(1,1,&[0,10,20,30,255]);assert!(validate_png(&valid).is_ok());
        for invalid in[png(1,1,&[7,10,20,30,255]),png(1,1,&[0,10,20]),png(1,1,&[0,10,20,30,255,1]),png(0,1,&[]),png(8192,8192,&[])]{assert!(validate_png(&invalid).is_err());}
        let mut corrupt=valid.clone();corrupt[29]^=1;assert!(validate_png(&corrupt).is_err());
        let mut trailing=valid.clone();trailing.push(0);assert!(validate_png(&trailing).is_err());
        assert!(validate_png(&valid[..valid.len()-1]).is_err());
        assert!(serde_json::from_value::<GraphExecuteInput>(json!({"kind":"saveScreenshot","path":"/private"})).is_err());
        assert!(serde_json::from_value::<GraphCompletion>(json!({"kind":"acknowledged","message":"unverified"})).is_err());
    }
}
