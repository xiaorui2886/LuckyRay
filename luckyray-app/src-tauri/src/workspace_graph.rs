//! Narrow graph capability primitives. The window command owner supplies an
//! already captured KnowledgeService and checks the selected ViewGrant first.
//! No command in this module accepts a renderer path, vault id or tag name.
use crate::knowledge::{KnowledgeDocumentRef, KnowledgeIndexSnapshot, KnowledgeService, KnowledgeSetTagsInput, KnowledgeTargetIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use unicode_normalization::UnicodeNormalization;

const MAX_GRAPH_SESSIONS: usize = 256;
const MAX_GRAPH_NODES: usize = 100_000;
const MAX_GRAPH_DTO_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphCompleteness { pub complete: bool, pub missing: Vec<String> }

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum GraphNodeTicket {
    Document { token: String, #[serde(rename = "relativePath")] relative_path: String },
    MissingDocument { token: String, #[serde(rename = "sourceRelativePath")] source_relative_path: String, #[serde(rename = "relativePath")] relative_path: String, title: String },
    Tag { token: String, tag: String },
    LibraryAsset { token: String, #[serde(rename = "assetId")] asset_id: String },
    VaultAsset { token: String, #[serde(rename = "relativePath")] relative_path: String },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphSnapshot {
    pub snapshot_id: String,
    pub source_id: String,
    pub revision: String,
    pub vault_id: String,
    pub version: u64,
    pub generated_at: String,
    pub documents: Vec<Value>,
    pub embeds: Vec<Value>,
    pub grants: Vec<GraphNodeTicket>,
    pub completeness: GraphCompleteness,
}

/// Data supplied by a backend-owned, captured catalog adapter, never by the
/// renderer. Returning Unavailable is different from an authoritative no-match.
#[derive(Clone, Debug)]
pub(crate) enum GraphLibraryEmbed {
    Match { asset_id: String, asset_name: String, asset_revision: String },
    NoMatch,
    Unavailable,
}

#[derive(Clone, Debug)]
pub(crate) enum GrantedGraphNode {
    Document { document_ref: KnowledgeDocumentRef, revision: String, title: String, tags: Vec<String> },
    MissingDocument { source_ref: KnowledgeDocumentRef, source_revision: String, raw_target: String, target: MissingDocumentTarget },
    /// Immutable target vocabulary from the granted snapshot. This ticket grants
    /// no write to another document, tag collection or material catalog.
    Tag { name: String },
    LibraryAsset { asset_id: String, asset_revision: String },
    VaultAsset { source_ref: KnowledgeDocumentRef, source_revision: String, target: String, relative_path: String, attachment_revision: String },
}
/// Derived from a saved wiki link, never from renderer missing-node metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MissingDocumentTarget { pub relative_path: String, pub parent_path: String, pub title: String }

pub(crate) fn missing_document_target(source_path: &str, raw: &str) -> Option<MissingDocumentTarget> {
    let normalized = raw.split('|').next()?.split('#').next()?.trim().replace('\\', "/");
    if normalized.is_empty() || normalized.len() > 2048 || normalized.starts_with(['/', '~'])
        || normalized.contains([':', '\0', '\r', '\n', '?', '*', '<', '>', '"']) { return None; }
    let mut parts: Vec<&str> = if normalized.starts_with('.') {
        source_path.rsplit_once('/').map(|(parent, _)| parent.split('/').collect()).unwrap_or_default()
    } else { Vec::new() };
    for part in normalized.split('/') {
        match part { "" | "." => (), ".." => { parts.pop()?; },
            value if value.eq_ignore_ascii_case(".luckyray") || value.trim() != value || value.ends_with('.') => return None,
            value => parts.push(value), }
    }
    let name = parts.pop()?;
    let title = if name.to_ascii_lowercase().ends_with(".md") { &name[..name.len()-3] } else { name };
    let title = title.trim();
    if title.is_empty() || title.len() > 255 || title.ends_with('.') { return None; }
    let parent_path = parts.join("/");
    let relative_path = if parent_path.is_empty() { format!("{title}.md") } else { format!("{parent_path}/{title}.md") };
    Some(MissingDocumentTarget { relative_path, parent_path, title: title.into() })
}

/// Conservative parity with the production graph's title/path-suffix aliases.
/// A possibly resolved or ambiguous link never acquires creation authority.
pub(crate) fn missing_target_is_unresolved(index: &KnowledgeIndexSnapshot, source_ref: &KnowledgeDocumentRef, raw_target: &str) -> bool {
    let resolution = crate::knowledge::resolve_wiki_target(index, source_ref, raw_target);
    if resolution.status != "unresolved" || !resolution.candidates.is_empty() { return false; }
    let Some(target) = missing_document_target(&source_ref.relative_path, raw_target) else { return false; };
    let alias = raw_target.split('|').next().unwrap_or("").split('#').next().unwrap_or("").trim().replace('\\', "/").to_lowercase();
    let alias = alias.strip_suffix(".md").unwrap_or(&alias);
    !index.documents.iter().any(|existing| {
        let path = existing.relative_path.to_lowercase();
        let stem = path.strip_suffix(".md").unwrap_or(&path);
        existing.relative_path.eq_ignore_ascii_case(&target.relative_path)
            || existing.title.to_lowercase().trim_end_matches(".md") == alias || stem == alias || stem.ends_with(&format!("/{alias}"))
    })
}

#[derive(Clone)]
struct HeldSnapshot {
    id: String,
    revision: String,
    vault_id: String,
    nodes: HashMap<String, GrantedGraphNode>,
    complete: bool,
    scope_identity: Option<KnowledgeTargetIdentity>,
}
#[derive(Default)]
struct GraphState {
    snapshots: HashMap<(String, String), HeldSnapshot>,
    pending_reads: HashMap<(String, String), String>,
}
#[derive(Default)]
pub(crate) struct WorkspaceGraphs { state: Mutex<GraphState> }
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GraphRelationMode { Connect, Disconnect }

fn token() -> String { format!("{:032x}", rand::random::<u128>()) }
fn key(caller: &str, view_id: &str) -> Result<(String, String), String> {
    if caller.is_empty() || caller.len() > 128 || view_id.is_empty() || view_id.len() > 128 { return Err("workspace-graph-invalid-owner".into()); }
    Ok((caller.into(), view_id.into()))
}
fn safe_embed_target(target: &str) -> bool {
    let target = target.trim();
    if target.is_empty() || target.starts_with(['/', '\\', '~']) || target.as_bytes().get(1) == Some(&b':') { return false; }
    let normalized = target.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    !normalized.is_empty() && normalized.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".luckyray"))
}
fn tag_display(tag: &str) -> String { tag.trim().trim_start_matches('#').trim().to_string() }
fn tag_key(tag: &str) -> String { tag_display(tag).nfc().collect::<String>().to_lowercase() }
pub(crate) fn graph_source_id(identity: &KnowledgeTargetIdentity) -> Result<String, String> {
    let source = serde_json::to_vec(&("workspace-graph-source-v1", &identity.target_id, &identity.identity_digest)).map_err(|_| "workspace-graph-serialize")?;
    Ok(format!("graph-source-v1:{:x}", Sha256::digest(source)))
}
fn graph_digest(vault_id: &str, documents: &[Value], embeds: &[Value], missing: &[String]) -> Result<String, String> {
    // Generations/build timestamps and opaque tickets are intentionally excluded:
    // transfer compares semantic graph content, not which process read it.
    let encoded = serde_json::to_vec(&json!({"vaultId":vault_id,"documents":documents,"embeds":embeds,"missing":missing})).map_err(|_| "workspace-graph-serialize")?;
    if encoded.len() > MAX_GRAPH_DTO_BYTES { return Err("workspace-graph-capacity".into()); }
    Ok(format!("graph-v1:{:x}", Sha256::digest(encoded)))
}

impl WorkspaceGraphs {
    pub(crate) fn remove_view(&self, caller: &str, view_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            let owner = (caller.into(), view_id.into());
            state.snapshots.remove(&owner); state.pending_reads.remove(&owner);
        }
    }
    pub(crate) fn remove_window(&self, caller: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.snapshots.retain(|(owner, _), _| owner != caller);
            state.pending_reads.retain(|(owner, _), _| owner != caller);
        }
    }

    /// A fresh read invalidates all old tickets for this particular retained
    /// view. Other graph views and Main's active source remain untouched.
    pub(crate) fn read(
        &self, caller: &str, view_id: &str, scope: &KnowledgeService,
        mut library_embed: impl FnMut(&str) -> Result<GraphLibraryEmbed, String>,
    ) -> Result<GraphSnapshot, String> {
        let owner = key(caller, view_id)?;
        let read_id = token();
        {
            let mut state = self.state.lock().map_err(|_| "workspace-graph-lock")?;
            if !state.snapshots.contains_key(&owner) && !state.pending_reads.contains_key(&owner)
                && state.snapshots.len() + state.pending_reads.len() >= MAX_GRAPH_SESSIONS { return Err("workspace-graph-window-limit".into()); }
            state.snapshots.remove(&owner);
            state.pending_reads.insert(owner.clone(), read_id.clone());
        }
        let built = (|| {
        // Fail closed if an integration accidentally supplies the global service.
        scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
        let identity = scope.current_target_identity().map_err(crate::knowledge_error)?;
        let index = scope.refresh_index().map_err(crate::knowledge_error)?;
        if index.vault_id != scope.current_vault_id().map_err(crate::knowledge_error)? { return Err("workspace-graph-scope-mismatch".into()); }
        let (mut snapshot, mut held) = build_snapshot(&index, |document_ref, target| {
            let resolution = crate::knowledge::resolve_wiki_target(&index, document_ref, target);
            if let Some(document) = resolution.document_ref { return Ok(Some((json!({"kind":"document","relativePath":document.relative_path}), None))); }
            if target.to_lowercase().ends_with(".md") { return Ok(None); }
            match library_embed(target)? {
                GraphLibraryEmbed::Match { asset_id, asset_name, asset_revision } => Ok(Some((json!({"kind":"library-asset","assetId":asset_id,"assetName":asset_name,"assetRevision":asset_revision}), Some(GrantedGraphNode::LibraryAsset { asset_id, asset_revision })))),
                GraphLibraryEmbed::Unavailable => Err("workspace-graph-library-embed-scope-required".into()),
                GraphLibraryEmbed::NoMatch => {
                    let resolved = scope.resolve_vault_attachment(document_ref, target, true).map_err(crate::knowledge_error)?;
                    if resolved.status == "ambiguous" { return Err("workspace-graph-ambiguous-embed".into()); }
                    if resolved.status != "resolved" { return Ok(None); }
                    let Some(relative_path) = resolved.relative_path else { return Err("workspace-graph-external-embed-route-required".into()); };
                    let attachment_revision = resolved.version.ok_or("workspace-graph-attachment-revision-required")?;
                    let source_revision = index.documents.iter().find(|document| document.document_ref == *document_ref).map(|document| document.revision.clone()).ok_or("workspace-graph-source-document-required")?;
                    let label = relative_path.rsplit('/').next().unwrap_or(&relative_path).to_string();
                    Ok(Some((json!({"kind":"vault-asset","relativePath":relative_path,"label":label,"attachmentRevision":attachment_revision}), Some(GrantedGraphNode::VaultAsset { source_ref: document_ref.clone(), source_revision, target: target.into(), relative_path, attachment_revision }))))
                }
            }
        })?;
        if scope.current_target_identity().map_err(crate::knowledge_error)? != identity { return Err("workspace-graph-scope-mismatch".into()); }
        snapshot.source_id = graph_source_id(&identity)?;
        held.scope_identity = Some(identity);
        Ok::<_, String>((snapshot, held))
        })();
        let mut state = self.state.lock().map_err(|_| "workspace-graph-lock")?;
        if state.pending_reads.get(&owner) != Some(&read_id) { return Err("workspace-graph-read-superseded".into()); }
        state.pending_reads.remove(&owner);
        let (snapshot, held) = built?;
        state.snapshots.insert(owner, held);
        Ok(snapshot)
    }

    fn held(&self, caller: &str, view_id: &str, snapshot_id: &str) -> Result<HeldSnapshot, String> {
        self.state.lock().map_err(|_| "workspace-graph-lock")?.snapshots.get(&key(caller, view_id)?)
            .filter(|held| held.id == snapshot_id && held.complete).cloned().ok_or_else(|| "workspace-graph-snapshot-expired".into())
    }
    /// Parent's ready/transfer branch can compare this typed digest. Before
    /// accepting a transfer it must read a fresh graph on the captured scope and
    /// compare content digests, rather than trying note_ref/read_document.
    pub(crate) fn rendered_revision(&self, caller: &str, view_id: &str, snapshot_id: &str) -> Result<String, String> {
        Ok(self.held(caller, view_id, snapshot_id)?.revision)
    }
    /// Revalidate transfer/ready content without replacing live renderer tickets.
    /// The host must supply the same captured catalog adapter used by read().
    pub(crate) fn check_revision(
        scope: &KnowledgeService, expected: &str,
        library_embed: impl FnMut(&str) -> Result<GraphLibraryEmbed, String>,
    ) -> Result<(), String> {
        let fresh = Self::default().read("revision-check", "transient", scope, library_embed)?;
        if !fresh.completeness.complete || fresh.revision != expected { return Err("workspace-graph-revision-conflict".into()); }
        Ok(())
    }
    pub(crate) fn node(
        &self, caller: &str, view_id: &str, snapshot_id: &str, node_token: &str,
    ) -> Result<GrantedGraphNode, String> {
        self.held(caller, view_id, snapshot_id)?.nodes.get(node_token).cloned().ok_or_else(|| "workspace-graph-node-not-granted".into())
    }
    /// Parent actions use this variant so a valid ticket can never be paired
    /// with a different captured service (including a recreated same-ID vault).
    pub(crate) fn node_for_scope(&self, caller: &str, view_id: &str, snapshot_id: &str, node_token: &str, scope: &KnowledgeService) -> Result<GrantedGraphNode, String> {
        let held = self.held(caller, view_id, snapshot_id)?;
        scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
        if held.scope_identity.as_ref() != Some(&scope.current_target_identity().map_err(crate::knowledge_error)?)
            || held.vault_id != scope.current_vault_id().map_err(crate::knowledge_error)? { return Err("workspace-graph-scope-mismatch".into()); }
        held.nodes.get(node_token).cloned().ok_or_else(|| "workspace-graph-node-not-granted".into())
    }
    /// Returns only the exact snapshot document. The parent may derive a Note
    /// ViewGrant with this ref and the SAME captured scope, never current scope.
    pub(crate) fn document(
        &self, caller: &str, view_id: &str, snapshot_id: &str, node_token: &str, scope: &KnowledgeService,
    ) -> Result<KnowledgeDocumentRef, String> {
        let held = self.held(caller, view_id, snapshot_id)?;
        scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
        if scope.current_vault_id().map_err(crate::knowledge_error)? != held.vault_id || held.scope_identity.as_ref() != Some(&scope.current_target_identity().map_err(crate::knowledge_error)?) { return Err("workspace-graph-scope-mismatch".into()); }
        match held.nodes.get(node_token) {
            Some(GrantedGraphNode::Document { document_ref, .. }) => {
                scope.read_document(document_ref).map_err(crate::knowledge_error)?;
                Ok(document_ref.clone())
            },
            _ => Err("workspace-graph-document-not-granted".into()),
        }
    }
    pub(crate) fn mutate_tag<Guard>(
        &self, caller: &str, view_id: &str, snapshot_id: &str, source_token: &str, target_token: &str,
        mode: GraphRelationMode, scope: &KnowledgeService,
        authorize_write: Option<impl FnOnce(&KnowledgeDocumentRef) -> Result<Guard, String>>,
    ) -> Result<Value, String> {
        let held = self.held(caller, view_id, snapshot_id)?;
        scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
        if scope.current_vault_id().map_err(crate::knowledge_error)? != held.vault_id || held.scope_identity.as_ref() != Some(&scope.current_target_identity().map_err(crate::knowledge_error)?) { return Err("workspace-graph-scope-mismatch".into()); }
        let source = held.nodes.get(source_token).ok_or("workspace-graph-node-not-granted")?;
        let target = held.nodes.get(target_token).ok_or("workspace-graph-node-not-granted")?;
        let (document_ref, revision, tags, name) = match (source, target) {
            (GrantedGraphNode::Document { document_ref, revision, tags, .. }, GrantedGraphNode::Tag { name })
            | (GrantedGraphNode::Tag { name }, GrantedGraphNode::Document { document_ref, revision, tags, .. }) => (document_ref, revision, tags, name),
            _ => return Err("workspace-graph-invalid-relation".into()),
        };
        // The host derives its dirty-note veto from this verified ref, never a
        // renderer path. A returned lock/lease stays alive across the commit.
        // Omitting the host integration always fails closed.
        let _host_write_guard = authorize_write.ok_or("workspace-graph-host-write-guard-required")?(document_ref)?;
        // Even a no-op validates the snapshot's note revision. No current-store
        // revision is substituted, and the read-only tag target has no writer.
        let current = scope.read_document(document_ref).map_err(crate::knowledge_error)?;
        if current.revision != *revision { return Err("knowledge-revision-conflict".into()); }
        let wanted = tag_key(name);
        let exists = tags.iter().any(|tag| tag_key(tag) == wanted);
        let connect = matches!(mode, GraphRelationMode::Connect);
        if exists == connect { return Ok(json!({"changed":false,"message":if exists {"关系已存在"} else {"关系不存在"}})); }
        let mut next = tags.iter().filter(|tag| connect || tag_key(tag) != wanted).cloned().collect::<Vec<_>>();
        if connect { next.push(name.clone()); }
        let mutation = scope.with_companion_draft_guard(document_ref, || scope.set_document_tags(&KnowledgeSetTagsInput { document_ref: document_ref.clone(), expected_revision: revision.clone(), tags: next })).map_err(crate::knowledge_error)?;
        // Old tickets must not silently acquire new revisions after a write.
        self.remove_view(caller, view_id);
        Ok(json!({"changed":true,"message":if mutation.index_stale || mutation.index_warning.is_some() {"关系已保存；图谱索引需要刷新"} else if connect {"已连接文档与标签"} else {"已断开文档与标签"},"revision":mutation.document.revision,"indexWarning":mutation.index_warning,"indexStale":mutation.index_stale}))
    }
}

fn build_snapshot(
    index: &KnowledgeIndexSnapshot,
    mut resolve_embed: impl FnMut(&KnowledgeDocumentRef, &str) -> Result<Option<(Value, Option<GrantedGraphNode>)>, String>,
) -> Result<(GraphSnapshot, HeldSnapshot), String> {
    if index.documents.len() > MAX_GRAPH_NODES { return Err("workspace-graph-capacity".into()); }
    let mut documents = Vec::new();
    let mut embeds = Vec::new();
    let mut nodes = HashMap::new();
    let mut grants = Vec::new();
    let mut tags = BTreeMap::new();
    let mut assets = BTreeMap::new();
    let mut missing = Vec::new();
    let mut missing_targets = BTreeMap::new();
    if index.stale || !index.errors.is_empty() || index.refresh_error.is_some() { missing.push("workspace-graph-index-incomplete".into()); }
    for document in &index.documents {
        if document.document_ref.vault_id != index.vault_id { return Err("workspace-graph-scope-mismatch".into()); }
        documents.push(json!({"relativePath":document.relative_path,"fileName":document.file_name,"title":document.title,"revision":document.revision,"wikiLinks":document.wiki_links,"embeds":document.embeds,"frontmatterTags":document.frontmatter_tags,"mtime":document.modified_at}));
        let ticket = token();
        grants.push(GraphNodeTicket::Document { token: ticket.clone(), relative_path: document.relative_path.clone() });
        nodes.insert(ticket, GrantedGraphNode::Document { document_ref: document.document_ref.clone(), revision: document.revision.clone(), title: document.title.clone(), tags: document.frontmatter_tags.clone() });
        for link in &document.wiki_links {
            let raw_target = link.target.split('|').next().unwrap_or("");
            if !missing_target_is_unresolved(index, &document.document_ref, raw_target) { continue; }
            let Some(target) = missing_document_target(&document.relative_path, raw_target) else { continue; };
            missing_targets.entry((document.relative_path.to_lowercase(), target.relative_path.to_lowercase())).or_insert_with(||
                GrantedGraphNode::MissingDocument { source_ref: document.document_ref.clone(), source_revision: document.revision.clone(), raw_target: raw_target.into(), target });
        }
        for tag in &document.frontmatter_tags { let display = tag_display(tag); if !display.is_empty() { tags.entry(tag_key(&display)).or_insert(display); } }
        let mut resolutions = Vec::new();
        for embed in &document.embeds {
            let target = crate::knowledge::normalize_embed_target(embed.target.split('|').next().unwrap_or("").split('#').next().unwrap_or(""));
            if !safe_embed_target(&target) { continue; }
            match resolve_embed(&document.document_ref, &target) {
                Ok(Some((resolution, granted))) => {
                    if let Some(granted) = granted {
                        let asset_key = match &granted {
                            GrantedGraphNode::LibraryAsset { asset_id, .. } => format!("library:{asset_id}"),
                            GrantedGraphNode::VaultAsset { relative_path, .. } => format!("vault:{relative_path}"),
                            _ => return Err("workspace-graph-invalid-embed-grant".into()),
                        };
                        assets.entry(asset_key).or_insert(granted);
                    }
                    if !resolutions.contains(&resolution) { resolutions.push(resolution); }
                },
                Ok(None) => (),
                Err(code) => missing.push(code),
            }
        }
        if !resolutions.is_empty() { embeds.push(json!({"sourceRelativePath":document.relative_path,"resolutions":resolutions})); }
    }
    for (_, granted) in missing_targets {
        let GrantedGraphNode::MissingDocument { source_ref, target, .. } = &granted else { unreachable!() };
        let ticket = token();
        grants.push(GraphNodeTicket::MissingDocument { token: ticket.clone(), source_relative_path: source_ref.relative_path.clone(), relative_path: target.relative_path.clone(), title: target.title.clone() });
        nodes.insert(ticket, granted);
    }
    for (_, name) in tags {
        let ticket = token(); grants.push(GraphNodeTicket::Tag { token: ticket.clone(), tag: name.clone() });
        nodes.insert(ticket, GrantedGraphNode::Tag { name });
    }
    for (_, asset) in assets {
        let ticket = token();
        grants.push(match &asset {
            GrantedGraphNode::LibraryAsset { asset_id, .. } => GraphNodeTicket::LibraryAsset { token: ticket.clone(), asset_id: asset_id.clone() },
            GrantedGraphNode::VaultAsset { relative_path, .. } => GraphNodeTicket::VaultAsset { token: ticket.clone(), relative_path: relative_path.clone() },
            _ => return Err("workspace-graph-invalid-embed-grant".into()),
        });
        nodes.insert(ticket, asset);
    }
    if nodes.len() > MAX_GRAPH_NODES { return Err("workspace-graph-capacity".into()); }
    missing.sort(); missing.dedup();
    let revision = graph_digest(&index.vault_id, &documents, &embeds, &missing)?;
    let id = token();
    let complete = missing.is_empty();
    let held = HeldSnapshot { id: id.clone(), revision: revision.clone(), vault_id: index.vault_id.clone(), nodes, complete, scope_identity: None };
    Ok((GraphSnapshot { snapshot_id: id, source_id: String::new(), revision, vault_id: index.vault_id.clone(), version: index.version, generated_at: index.built_at.clone(), documents, embeds, grants, completeness: GraphCompleteness { complete, missing } }, held))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn index() -> KnowledgeIndexSnapshot {
        serde_json::from_value(json!({"vaultId":"vault-a","generation":1,"builtAt":"now","documents":[{"documentRef":{"vaultId":"vault-a","relativePath":"A.md"},"relativePath":"A.md","fileName":"A.md","title":"A","revision":"r1","headings":[],"wikiLinks":[],"embeds":[],"tags":["shared"],"frontmatterTags":["shared"],"inlineTags":[],"plainText":"private full text","excerpt":"private excerpt","contentLength":100,"modifiedAt":null,"size":100}],"errors":[],"version":1,"changedPaths":[],"removedPaths":[],"stale":false,"refreshError":null})).unwrap()
    }
    #[test]
    fn source_id_binds_captured_incarnation_and_never_exposes_native_identity() {
        let identity = KnowledgeTargetIdentity { target_id: "vault-a".into(), identity_digest: "private-root-identity".into(), label: "A".into() };
        let first = graph_source_id(&identity).unwrap();
        let renamed = KnowledgeTargetIdentity { label: "New name".into(), ..identity.clone() };
        assert_eq!(first, graph_source_id(&renamed).unwrap());
        let recreated = KnowledgeTargetIdentity { identity_digest: "new-root-incarnation".into(), ..identity.clone() };
        assert_ne!(first, graph_source_id(&recreated).unwrap());
        assert_eq!(first.len(), "graph-source-v1:".len() + 64);
        assert!(!first.contains("private-root-identity"));
    }
    #[test]
    fn projection_omits_body_and_absolute_authority() {
        let (snapshot, _) = build_snapshot(&index(), |_, _| Ok(None)).unwrap();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        for forbidden in ["plainText", "excerpt", "absolutePath", "rootPath", "private full text"] { assert!(!encoded.contains(forbidden)); }
        assert_eq!(snapshot.grants.len(), 2);
        assert!(snapshot.completeness.complete);
    }
    #[test]
    fn snapshot_tokens_are_owner_view_and_generation_scoped() {
        let registry = WorkspaceGraphs::default();
        let (snapshot, held) = build_snapshot(&index(), |_, _| Ok(None)).unwrap();
        let node = held.nodes.keys().next().unwrap().clone();
        registry.state.lock().unwrap().snapshots.insert(("window-a".into(),"graph-a".into()), held);
        assert!(registry.node("window-a","graph-a",&snapshot.snapshot_id,&node).is_ok());
        for (caller,view,id,ticket) in [("window-b","graph-a",snapshot.snapshot_id.as_str(),node.as_str()),("window-a","graph-b",snapshot.snapshot_id.as_str(),node.as_str()),("window-a","graph-a","forged",node.as_str()),("window-a","graph-a",snapshot.snapshot_id.as_str(),"A.md")] { assert!(registry.node(caller,view,id,ticket).is_err()); }
        registry.remove_view("window-a","graph-a");
        assert!(registry.node("window-a","graph-a",&snapshot.snapshot_id,&node).is_err());
    }
    #[test]
    fn digest_ignores_ticket_and_scan_generation_but_tracks_content() {
        let mut input = index();
        let (a, _) = build_snapshot(&input, |_, _| Ok(None)).unwrap();
        input.version += 1; input.generation += 1; input.built_at = "later".into();
        let (b, _) = build_snapshot(&input, |_, _| Ok(None)).unwrap();
        assert_eq!(a.revision,b.revision); assert_ne!(a.snapshot_id,b.snapshot_id);
        input.documents[0].revision = "changed".into();
        let (c, _) = build_snapshot(&input, |_, _| Ok(None)).unwrap();
        assert_ne!(a.revision,c.revision);
    }
    #[test]
    fn tag_tickets_use_production_nfc_identity() {
        assert_eq!(tag_key("Cafe\u{301}"), tag_key("Café"));
        assert_eq!(tag_key("# CAFÉ "), "café");
        let mut input = index();
        input.documents[0].frontmatter_tags = vec!["Cafe\u{301}".into(), "Café".into(), "CAFÉ".into()];
        let (snapshot, held) = build_snapshot(&input, |_, _| Ok(None)).unwrap();
        assert_eq!(snapshot.grants.iter().filter(|grant| matches!(grant, GraphNodeTicket::Tag { .. })).count(), 1);
        assert_eq!(held.nodes.values().filter(|grant| matches!(grant, GrantedGraphNode::Tag { .. })).count(), 1);
    }
    #[test]
    fn unsafe_embed_targets_never_enter_resolvers() {
        for value in ["../secret.png", "/absolute.png", "C:\\private.png", "~/.secret", ".luckyray/private", "folder/../../private"] { assert!(!safe_embed_target(value), "{value}"); }
        for value in ["image.png", "folder/image.png", "./image.png"] { assert!(safe_embed_target(value), "{value}"); }
    }
    #[test]
    fn stale_index_never_grants_operations() {
        let mut input = index(); input.stale = true;
        let (snapshot, held) = build_snapshot(&input, |_, _| Ok(None)).unwrap();
        assert!(!snapshot.completeness.complete); assert!(!held.complete);
    }
    #[test]
    fn missing_target_derivation_is_saved_link_only_and_root_bounded() {
        for unsafe_target in ["../../../Outside", "/absolute", "C:\\secret", "~/.secret", ".luckyray/private", "Folder/.luckyray/private", "Bad:Name", "bad\nname"] { assert!(missing_document_target("Folder/A.md", unsafe_target).is_none(), "{unsafe_target}"); }
        assert_eq!(missing_document_target("Folder/A.md", "New#heading|label").unwrap().relative_path, "New.md");
        assert_eq!(missing_document_target("Folder/A.md", "./New").unwrap().relative_path, "Folder/New.md");
        assert_eq!(missing_document_target("Folder/A.md", "../New").unwrap().relative_path, "New.md");
        let mut input = index();
        input.documents[0].wiki_links.push(serde_json::from_value(json!({"raw":"[[New]]","target":"New","alias":null,"line":1})).unwrap());
        let (snapshot, held) = build_snapshot(&input, |_,_| Ok(None)).unwrap();
        assert_eq!(snapshot.grants.iter().filter(|grant| matches!(grant, GraphNodeTicket::MissingDocument { .. })).count(), 1);
        assert!(held.nodes.values().any(|node| matches!(node, GrantedGraphNode::MissingDocument { source_revision, target, .. } if source_revision == "r1" && target.relative_path == "New.md")));
        // A title alias resolves in the production topology and must not emit a
        // missing ticket that could manufacture a duplicate note.
        input.documents[0].title = "New".into();
        let (snapshot, _) = build_snapshot(&input, |_,_| Ok(None)).unwrap();
        assert!(!snapshot.grants.iter().any(|grant| matches!(grant, GraphNodeTicket::MissingDocument { .. })));
    }

}
