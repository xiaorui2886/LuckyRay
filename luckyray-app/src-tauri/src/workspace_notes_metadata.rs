//! Exact-note read projection and bounded metadata capabilities. The dispatcher
//! supplies a validated live caller/view, its captured service, and granted ref.
//! This module has no writer, global active source, filesystem path API or SQL.
use crate::knowledge::{KnowledgeDocumentRef, KnowledgeDocumentSnapshot, KnowledgeIndexDocument, KnowledgeIndexSnapshot, KnowledgeService, KnowledgeTargetIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use unicode_normalization::UnicodeNormalization;

const MAX_SESSIONS: usize = 256;
const MAX_METADATA_DTO_BYTES: usize = 512 * 1024;
const MAX_INDEX_DOCUMENTS: usize = 100_000;
const MAX_NOTES: usize = 256;
const MAX_BACKLINKS: usize = 128;
const MAX_TAGS: usize = 256;
const MAX_LINKS: usize = 512;
const MAX_LINK_EXAMINATIONS: usize = 100_000;
const MAX_QUERY_RESULTS: usize = 64;
const MAX_TICKETS: usize = 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoteAuthority {
    pub vault_id: String,
    pub source_id: String,
    pub document_id: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteSnapshot {
    pub authority: NoteAuthority,
    pub document_ref: KnowledgeDocumentRef,
    pub content: String,
    pub revision: String,
    pub title: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteTargetTicket { pub ticket: String, pub document_id: String, pub title: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteSuggestion { pub id: String, pub title: String, pub snippet: String, pub target: NoteTargetTicket }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteBacklink { pub target: NoteTargetTicket, pub snippet: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct NoteEmbedTarget { pub target: String, pub wiki: bool, pub note: NoteTargetTicket }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteTag { pub id: String, pub name: String, pub ticket: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteMetadata {
    pub notes: Vec<NoteSuggestion>, pub tags: Vec<NoteTag>, pub links: Vec<Value>,
    pub backlinks: Vec<NoteBacklink>, pub document_tags: Vec<String>, pub favorite: bool,
    pub note_embeds: Vec<NoteEmbedTarget>,
}
/// complete means the declared scope is complete, never whole-vault coverage.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteMetadataCompleteness {
    pub complete: bool, pub missing: Vec<String>, pub truncated: bool, pub truncated_fields: Vec<String>,
    pub note_suggestions: &'static str, pub scope: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteMetadataSnapshot {
    pub authority: NoteAuthority, pub revision: String, pub metadata: NoteMetadata,
    pub completeness: NoteMetadataCompleteness,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteQuerySnapshot {
    pub authority: NoteAuthority, pub revision: String, pub query: String,
    pub notes: Vec<NoteSuggestion>, pub completeness: NoteMetadataCompleteness,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteIndexSnapshot {
    pub authority: NoteAuthority, pub revision: String, pub notes: Vec<NoteSuggestion>,
    pub total: usize, pub next_cursor: Option<String>, pub completeness: NoteMetadataCompleteness,
}
/// A provider must already be bound to this captured source/library by the host.
/// Unavailable is not an authoritative false favorite status.
#[derive(Clone, Debug)]
pub(crate) enum NoteFavoriteStatus { Known(bool), Unavailable }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GrantedNoteTarget {
    Document { document_ref: KnowledgeDocumentRef, revision: String, title: String },
    Tag { name: String },
}
#[derive(Clone)]
struct HeldMetadata {
    generation: String, authority: NoteAuthority, source_ref: KnowledgeDocumentRef,
    revision: String, identity: KnowledgeTargetIdentity,
    targets: HashMap<String, GrantedNoteTarget>, complete: bool,
}
#[derive(Default)]
struct MetadataState {
    held: HashMap<(String, String), HeldMetadata>, pending: HashMap<(String, String), String>,
    pages: HashMap<(String, String), IndexPage>,
}
#[derive(Clone)]
struct IndexPage { generation: String, digest: String, next_cursor: String, offset: usize, tickets: Vec<String> }
#[derive(Default)]
pub(crate) struct WorkspaceNotesMetadata { state: Mutex<MetadataState> }

fn token() -> String { format!("{:032x}{:032x}", rand::random::<u128>(), rand::random::<u128>()) }
fn owner(caller: &str, view_id: &str) -> Result<(String, String), String> {
    if caller.is_empty() || caller.len() > 128 || view_id.is_empty() || view_id.len() > 128
        || caller.contains(['\0', '\r', '\n']) || view_id.contains(['\0', '\r', '\n']) { return Err("workspace-note-invalid-owner".into()); }
    Ok((caller.into(), view_id.into()))
}
fn validate_ref(reference: &KnowledgeDocumentRef) -> Result<(), String> {
    let path = &reference.relative_path;
    if reference.vault_id.is_empty() || reference.vault_id.len() > 256 || reference.vault_id.trim() != reference.vault_id
        || path.is_empty() || path.len() > 4096 || path.contains(['\\', ':', '\0', '\r', '\n'])
        || !path.to_lowercase().ends_with(".md")
        || path.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".luckyray")) {
        return Err("workspace-note-invalid-document-ref".into());
    }
    Ok(())
}
/// Matches production knowledgeDocumentNoteId, including JSON property order.
pub(crate) fn document_id(reference: &KnowledgeDocumentRef) -> Result<String, String> {
    validate_ref(reference)?;
    let encoded = serde_json::to_vec(reference).map_err(|_| "workspace-note-serialize")?;
    Ok(format!("kdoc-{}", encoded.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}
fn authority_from_identity(identity: &KnowledgeTargetIdentity, reference: &KnowledgeDocumentRef) -> Result<NoteAuthority, String> {
    let source = serde_json::to_vec(&("workspace-note-source-v1", &identity.target_id, &identity.identity_digest)).map_err(|_| "workspace-note-serialize")?;
    Ok(NoteAuthority { vault_id: reference.vault_id.clone(), source_id: format!("note-source-v1:{:x}", Sha256::digest(source)), document_id: document_id(reference)? })
}
pub(crate) fn authority_for(scope: &KnowledgeService, reference: &KnowledgeDocumentRef) -> Result<NoteAuthority, String> {
    scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
    if scope.current_vault_id().map_err(crate::knowledge_error)? != reference.vault_id { return Err("workspace-note-scope-mismatch".into()); }
    authority_from_identity(&scope.current_target_identity().map_err(crate::knowledge_error)?, reference)
}
/// Wrap the existing scoped CAS result in the SAME captured service, never read
/// a second document or replace the writer. No absolute summary fields escape.
pub(crate) fn snapshot_for(scope: &KnowledgeService, snapshot: KnowledgeDocumentSnapshot) -> Result<NoteSnapshot, String> {
    Ok(NoteSnapshot { authority: authority_for(scope, &snapshot.summary.document_ref)?, document_ref: snapshot.summary.document_ref,
        content: snapshot.content, revision: snapshot.revision, title: snapshot.summary.title })
}
fn require_revision(scope: &KnowledgeService, reference: &KnowledgeDocumentRef, revision: &str) -> Result<(), String> {
    if revision.is_empty() || revision.len() > 128 { return Err("workspace-note-revision-required".into()); }
    if scope.read_document(reference).map_err(crate::knowledge_error)?.revision != revision { return Err("knowledge-revision-conflict".into()); }
    Ok(())
}
fn tag_key(name: &str) -> String { name.trim().nfc().collect::<String>().to_lowercase() }
fn encode_component(value: &str) -> String {
    value.bytes().map(|byte| if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect()
}
fn tag_id(vault: &str, name: &str) -> String { format!("real-vault-tag:{}:{}", encode_component(vault), encode_component(&tag_key(name))) }
fn snippet(document: &KnowledgeIndexDocument) -> String { document.excerpt.chars().take(240).collect() }
fn completeness(index: &KnowledgeIndexSnapshot, scope: &'static str) -> NoteMetadataCompleteness {
    let missing = if index.stale || !index.errors.is_empty() || index.refresh_error.is_some() { vec!["workspace-note-index-incomplete".into()] } else { vec![] };
    NoteMetadataCompleteness { complete: missing.is_empty(), missing, truncated: false, truncated_fields: vec![], note_suggestions: scope, scope }
}
fn truncated(value: &mut NoteMetadataCompleteness, field: &str) { value.complete = false; value.truncated = true; value.truncated_fields.push(field.into()); }
fn validate_index(index: &KnowledgeIndexSnapshot, reference: &KnowledgeDocumentRef) -> Result<(), String> {
    if index.vault_id != reference.vault_id || index.documents.iter().any(|document| document.document_ref.vault_id != reference.vault_id || validate_ref(&document.document_ref).is_err()) { return Err("workspace-note-scope-mismatch".into()); }
    if index.documents.len() > MAX_INDEX_DOCUMENTS { return Err("workspace-note-index-capacity".into()); }
    Ok(())
}
fn grant_document(document: &KnowledgeIndexDocument, targets: &mut HashMap<String, GrantedNoteTarget>) -> Result<NoteTargetTicket, String> {
    let ticket = token();
    targets.insert(ticket.clone(), GrantedNoteTarget::Document { document_ref: document.document_ref.clone(), revision: document.revision.clone(), title: document.title.clone() });
    Ok(NoteTargetTicket { ticket, document_id: document_id(&document.document_ref)?, title: document.title.clone() })
}
fn suggestion(document: &KnowledgeIndexDocument, targets: &mut HashMap<String, GrantedNoteTarget>) -> Result<NoteSuggestion, String> {
    let target = grant_document(document, targets)?;
    Ok(NoteSuggestion { id: target.document_id.clone(), title: target.title.clone(), snippet: snippet(document), target })
}

impl WorkspaceNotesMetadata {
    /// Call on every view close, rebind, transfer-out and failed registration.
    pub(crate) fn remove_view(&self, caller: &str, view_id: &str) {
        if let Ok(mut state) = self.state.lock() { let key = (caller.into(), view_id.into()); state.held.remove(&key); state.pending.remove(&key); state.pages.remove(&key); }
    }
    pub(crate) fn remove_window(&self, caller: &str) {
        if let Ok(mut state) = self.state.lock() { state.held.retain(|(label, _), _| label != caller); state.pending.retain(|(label, _), _| label != caller); state.pages.retain(|(label, _), _| label != caller); }
    }
    pub(crate) fn read(
        &self, caller: &str, view_id: &str, scope: &KnowledgeService,
        reference: &KnowledgeDocumentRef, revision: &str,
        mut favorite: impl FnMut(&NoteAuthority) -> Result<NoteFavoriteStatus, String>,
    ) -> Result<NoteMetadataSnapshot, String> {
        let key = owner(caller, view_id)?;
        let generation = token();
        let previous = {
            let mut state = self.state.lock().map_err(|_| "workspace-note-metadata-lock")?;
            if !state.held.contains_key(&key) && !state.pending.contains_key(&key) && state.held.len() + state.pending.len() >= MAX_SESSIONS { return Err("workspace-note-session-capacity".into()); }
            let previous = state.held.get(&key).filter(|held| held.source_ref == *reference && held.revision == revision).cloned();
            if previous.is_none() { state.held.remove(&key); state.pages.remove(&key); }
            state.pending.insert(key.clone(), generation.clone());
            previous
        };
        let built = (|| {
            let authority = authority_for(scope, reference)?;
            let identity = scope.current_target_identity().map_err(crate::knowledge_error)?;
            require_revision(scope, reference, revision)?;
            let favorite = match favorite(&authority)? { NoteFavoriteStatus::Known(value) => value, NoteFavoriteStatus::Unavailable => return Err("workspace-note-favorite-provider-required".into()) };
            let index = scope.refresh_index().map_err(crate::knowledge_error)?;
            let (mut snapshot, mut targets) = build_metadata(&index, reference, revision, authority.clone(), favorite)?;
            // Detect a save, root replacement or re-created same-ID vault during projection.
            if authority_for(scope, reference)? != authority { return Err("workspace-note-scope-mismatch".into()); }
            require_revision(scope, reference, revision)?;
            let retained = previous.as_ref().filter(|held| held.authority == authority && held.identity == identity);
            if let Some(previous) = retained {
                let replacement = targets.iter().filter_map(|(new, target)| previous.targets.iter().find(|(_, old)| *old == target).map(|(old, _)| (new.clone(), old.clone()))).collect::<HashMap<_, _>>();
                for note in &mut snapshot.metadata.notes { if let Some(ticket) = replacement.get(&note.target.ticket) { note.target.ticket = ticket.clone(); } }
                for backlink in &mut snapshot.metadata.backlinks { if let Some(ticket) = replacement.get(&backlink.target.ticket) { backlink.target.ticket = ticket.clone(); } }
                for embed in &mut snapshot.metadata.note_embeds { if let Some(ticket)=replacement.get(&embed.note.ticket){embed.note.ticket=ticket.clone();} }
                for tag in &mut snapshot.metadata.tags { if let Some(ticket) = replacement.get(&tag.ticket) { tag.ticket = ticket.clone(); } }
                targets = targets.into_iter().map(|(ticket, target)| (replacement.get(&ticket).cloned().unwrap_or(ticket), target)).collect();
                for (ticket, target) in &previous.targets { targets.entry(ticket.clone()).or_insert_with(|| target.clone()); }
                if targets.len() > MAX_TICKETS { return Err("workspace-note-ticket-capacity".into()); }
            }
            let held = HeldMetadata { generation: retained.map(|held| held.generation.clone()).unwrap_or_else(|| generation.clone()), authority, source_ref: reference.clone(), revision: revision.into(), identity, targets, complete: snapshot.completeness.complete };
            Ok::<_, String>((snapshot, held))
        })();
        let mut state = self.state.lock().map_err(|_| "workspace-note-metadata-lock")?;
        if state.pending.get(&key) != Some(&generation) { return Err("workspace-note-metadata-superseded".into()); }
        state.pending.remove(&key);
        let (snapshot, mut held) = built?;
        // A same-source index/query can finish while metadata is refreshed.
        // Preserve its newly issued bounded tickets instead of invalidating it.
        if let Some(current) = state.held.get(&key).filter(|current| current.generation == held.generation && current.authority == held.authority && current.identity == held.identity && current.revision == held.revision) {
            for (ticket, target) in &current.targets { held.targets.entry(ticket.clone()).or_insert_with(|| target.clone()); }
            if held.targets.len() > MAX_TICKETS { return Err("workspace-note-ticket-capacity".into()); }
        }
        state.held.insert(key, held);
        Ok(snapshot)
    }
    fn held(&self, caller: &str, view_id: &str) -> Result<HeldMetadata, String> {
        self.state.lock().map_err(|_| "workspace-note-metadata-lock")?.held.get(&owner(caller, view_id)?)
            .filter(|held| held.complete).cloned().ok_or_else(|| "workspace-note-metadata-expired".into())
    }
    fn validate_held(held: &HeldMetadata, scope: &KnowledgeService, reference: &KnowledgeDocumentRef, revision: &str) -> Result<(), String> {
        if held.source_ref != *reference || held.revision != revision || held.authority != authority_for(scope, reference)?
            || held.identity != scope.current_target_identity().map_err(crate::knowledge_error)? { return Err("workspace-note-scope-mismatch".into()); }
        require_revision(scope, reference, revision)
    }
    /// A nonempty user query searches titles/file names only, returns <=64 short
    /// summaries, and adds tickets to this revision's bounded target registry.
    pub(crate) fn query(
        &self, caller: &str, view_id: &str, scope: &KnowledgeService, reference: &KnowledgeDocumentRef,
        revision: &str, query: &str, limit: usize,
    ) -> Result<NoteQuerySnapshot, String> {
        if query.trim().is_empty() || query.chars().count() > 120 || query.contains(['\0', '\r', '\n']) || limit == 0 || limit > MAX_QUERY_RESULTS { return Err("workspace-note-invalid-query".into()); }
        let held = self.held(caller, view_id)?;
        Self::validate_held(&held, scope, reference, revision)?;
        let index = scope.refresh_index().map_err(crate::knowledge_error)?;
        validate_index(&index, reference)?;
        let mut quality = completeness(&index, "title-query");
        let needle = query.trim().nfc().collect::<String>().to_lowercase();
        let mut matching = index.documents.iter().filter(|document| document.title.nfc().collect::<String>().to_lowercase().contains(&needle) || document.file_name.to_lowercase().contains(&needle)).collect::<Vec<_>>();
        matching.sort_by(|a, b| a.document_ref.relative_path.cmp(&b.document_ref.relative_path));
        if matching.len() > limit { truncated(&mut quality, "notes"); }
        let mut targets = HashMap::new();
        let notes = matching.into_iter().take(limit).map(|document| suggestion(document, &mut targets)).collect::<Result<Vec<_>, _>>()?;
        let snapshot = NoteQuerySnapshot { authority: held.authority.clone(), revision: revision.into(), query: query.into(), notes, completeness: quality };
        if serde_json::to_vec(&snapshot).map_err(|_| "workspace-note-serialize")?.len() > MAX_METADATA_DTO_BYTES { return Err("workspace-note-metadata-capacity".into()); }
        Self::validate_held(&held, scope, reference, revision)?;
        let mut state = self.state.lock().map_err(|_| "workspace-note-metadata-lock")?;
        let current = state.held.get_mut(&owner(caller, view_id)?).filter(|value| value.generation == held.generation).ok_or("workspace-note-metadata-superseded")?;
        if current.targets.len() + targets.len() > MAX_TICKETS { return Err("workspace-note-ticket-capacity".into()); }
        // Stale index results are explanatory only and never become authority.
        if snapshot.completeness.missing.is_empty() { current.targets.extend(targets); }
        Ok(snapshot)
    }
    /// Explicit index panel. Each page replaces the previous page's tickets,
    /// keeping grants bounded even in a very large vault. Cursor binds the
    /// complete index revision set plus this exact metadata generation.
    pub(crate) fn list_index(
        &self, caller: &str, view_id: &str, scope: &KnowledgeService, reference: &KnowledgeDocumentRef,
        revision: &str, cursor: Option<&str>, limit: usize,
    ) -> Result<NoteIndexSnapshot, String> {
        if limit == 0 || limit > MAX_QUERY_RESULTS || cursor.is_some_and(|cursor| cursor.len() != 64) { return Err("workspace-note-index-query-invalid".into()); }
        let key = owner(caller, view_id)?;
        let (held, previous) = {
            let state = self.state.lock().map_err(|_| "workspace-note-metadata-lock")?;
            (state.held.get(&key).cloned().ok_or("workspace-note-metadata-expired")?, state.pages.get(&key).cloned())
        };
        Self::validate_held(&held, scope, reference, revision)?;
        let index = scope.refresh_index_for_target(&held.identity).map_err(crate::knowledge_error)?;
        validate_index(&index, reference)?;
        let quality = completeness(&index, "vault-index-page");
        if !quality.missing.is_empty() { return Err("workspace-note-index-incomplete".into()); }
        let mut documents = index.documents.iter().collect::<Vec<_>>();
        documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let identities = documents.iter().map(|document| (&document.document_ref, &document.revision)).collect::<Vec<_>>();
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&identities).map_err(|_| "workspace-note-serialize")?));
        let offset = match cursor {
            Some(cursor) => previous.as_ref().filter(|page| page.generation == held.generation && page.digest == digest && page.next_cursor == cursor).map(|page| page.offset).ok_or("workspace-note-index-cursor-expired")?,
            None => 0,
        };
        if offset > documents.len() { return Err("workspace-note-index-cursor-expired".into()); }
        let mut targets = HashMap::new();
        let notes = documents.iter().skip(offset).take(limit).map(|document| suggestion(document, &mut targets)).collect::<Result<Vec<_>, _>>()?;
        let next_offset = offset + notes.len();
        let next_cursor = (next_offset < documents.len()).then(token);
        let result = NoteIndexSnapshot { authority: held.authority.clone(), revision: revision.into(), notes, total: documents.len(), next_cursor: next_cursor.clone(), completeness: quality };
        if serde_json::to_vec(&result).map_err(|_| "workspace-note-serialize")?.len() > MAX_METADATA_DTO_BYTES { return Err("workspace-note-metadata-capacity".into()); }
        Self::validate_held(&held, scope, reference, revision)?;
        let mut state = self.state.lock().map_err(|_| "workspace-note-metadata-lock")?;
        // A concurrent page request cannot consume or replace our cursor.
        if state.pages.get(&key).map(|page| &page.next_cursor) != previous.as_ref().map(|page| &page.next_cursor) { return Err("workspace-note-index-cursor-expired".into()); }
        let current = state.held.get_mut(&key).filter(|current| current.generation == held.generation).ok_or("workspace-note-metadata-superseded")?;
        if let Some(previous) = &previous { for ticket in &previous.tickets { current.targets.remove(ticket); } }
        if current.targets.len() + targets.len() > MAX_TICKETS { return Err("workspace-note-ticket-capacity".into()); }
        let tickets = targets.keys().cloned().collect();
        current.targets.extend(targets);
        state.pages.insert(key, IndexPage { generation: held.generation, digest, next_cursor: next_cursor.unwrap_or_default(), offset: next_offset, tickets });
        Ok(result)
    }
    /// Parent broker consumes this result; never trust renderer documentId/title.
    pub(crate) fn target_for_scope(
        &self, caller: &str, view_id: &str, ticket: &str, scope: &KnowledgeService,
        source_ref: &KnowledgeDocumentRef, expected_revision: &str,
    ) -> Result<GrantedNoteTarget, String> {
        let held = {
            let state = self.state.lock().map_err(|_| "workspace-note-metadata-lock")?;
            let key = owner(caller, view_id)?;
            let held = state.held.get(&key).ok_or("workspace-note-metadata-expired")?;
            if !held.complete && !state.pages.get(&key).is_some_and(|page| page.generation == held.generation && page.tickets.iter().any(|value| value == ticket)) { return Err("workspace-note-metadata-expired".into()); }
            held.clone()
        };
        Self::validate_held(&held, scope, source_ref, expected_revision)?;
        let target = held.targets.get(ticket).cloned().ok_or("workspace-note-target-not-granted")?;
        if let GrantedNoteTarget::Document { document_ref, revision, .. } = &target { require_revision(scope, document_ref, revision)?; }
        Self::validate_held(&held, scope, source_ref, expected_revision)?;
        let state = self.state.lock().map_err(|_| "workspace-note-metadata-lock")?;
        if !state.held.get(&owner(caller, view_id)?).is_some_and(|value| value.generation == held.generation) { return Err("workspace-note-metadata-expired".into()); }
        Ok(target)
    }
    pub(crate) fn tag_name_for_id(&self, caller: &str, view_id: &str, id: &str, scope: &KnowledgeService, source_ref: &KnowledgeDocumentRef, revision: &str) -> Result<String, String> {
        let held = self.held(caller, view_id)?;
        Self::validate_held(&held, scope, source_ref, revision)?;
        held.targets.values().find_map(|target| match target { GrantedNoteTarget::Tag { name } if tag_id(&source_ref.vault_id, name) == id => Some(name.clone()), _ => None }).ok_or_else(|| "workspace-note-tag-not-granted".into())
    }
}

fn build_metadata(
    index: &KnowledgeIndexSnapshot, reference: &KnowledgeDocumentRef, revision: &str,
    authority: NoteAuthority, favorite: bool,
) -> Result<(NoteMetadataSnapshot, HashMap<String, GrantedNoteTarget>), String> {
    validate_index(index, reference)?;
    let source = index.documents.iter().find(|document| document.document_ref == *reference).ok_or("workspace-note-not-indexed")?;
    if source.revision != revision { return Err("knowledge-revision-conflict".into()); }
    let mut quality = completeness(index, "linked-and-backlinked");
    let mut related = BTreeMap::new();
    let mut links = Vec::new();
    let mut targets = HashMap::new();
    let mut note_embeds=Vec::new();
    // Production Notes represents wiki note embeds as document chips. Only
    // a ticketed note target is needed; its body is never projected or served.
    for embed in source.embeds.iter().filter(|embed|embed.raw.starts_with("![[")) {
        let resolved=crate::knowledge::resolve_wiki_target(index,reference,&embed.target);
        if let Some(target)=resolved.document_ref {
            if note_embeds.len()>=MAX_NOTES { truncated(&mut quality,"noteEmbeds");break; }
            let document=index.documents.iter().find(|document|document.document_ref==target).ok_or("workspace-note-not-indexed")?;
            related.insert(target.relative_path.clone(),target);
            note_embeds.push(NoteEmbedTarget{target:embed.target.clone(),wiki:true,note:grant_document(document,&mut targets)?});
        }
    }
    for link in source.wiki_links.iter().take(MAX_LINKS + 1) {
        let resolved = crate::knowledge::resolve_wiki_target(index, reference, &link.target);
        if let Some(target) = &resolved.document_ref { related.insert(target.relative_path.clone(), target.clone()); }
        if links.len() < MAX_LINKS {
            links.push(json!({"targetTitle":link.target,"toNoteId":resolved.document_ref.as_ref().map(document_id).transpose()?,"isMissing":if resolved.document_ref.is_some(){0}else{1}}));
        }
    }
    if source.wiki_links.len() > MAX_LINKS { truncated(&mut quality, "links"); }
    let mut backlinks = Vec::new();
    let mut backlink_count = 0;
    let mut examinations = 0;
    let source_name = reference.relative_path.rsplit('/').next().unwrap_or("").to_lowercase();
    for document in &index.documents {
        if document.document_ref == *reference { continue; }
        let references_source = document.wiki_links.iter().any(|link| {
            examinations += 1;
            if examinations > MAX_LINK_EXAMINATIONS { return false; }
            // Resolution scans the index. Reject unrelated file names first;
            // relative-path and ambiguity decisions remain in the canonical resolver.
            let normalized = link.target.split('#').next().unwrap_or("").trim().replace('\\', "/");
            let file = normalized.rsplit('/').next().unwrap_or("").to_lowercase();
            let filename = if file.ends_with(".md") { file } else { format!("{file}.md") };
            if filename != source_name { return false; }
            let resolved = crate::knowledge::resolve_wiki_target(index, &document.document_ref, &link.target);
            resolved.document_ref.as_ref() == Some(reference) || resolved.candidates.contains(reference)
        });
        if examinations > MAX_LINK_EXAMINATIONS { truncated(&mut quality, "backlinkScan"); break; }
        if references_source {
            backlink_count += 1;
            if backlink_count > MAX_BACKLINKS { break; }
            related.insert(document.relative_path.clone(), document.document_ref.clone());
            if backlinks.len() < MAX_BACKLINKS { backlinks.push(NoteBacklink { target: grant_document(document, &mut targets)?, snippet: snippet(document) }); }
        }
    }
    if backlink_count > MAX_BACKLINKS { truncated(&mut quality, "backlinks"); }
    if related.len() > MAX_NOTES { truncated(&mut quality, "notes"); }
    let mut notes = Vec::new();
    let mut tags = BTreeMap::new();
    for tag in source.tags.iter().chain(source.frontmatter_tags.iter()) { let display = tag.trim().nfc().collect::<String>(); if !display.is_empty() { tags.entry(tag_key(&display)).or_insert(display); } }
    for reference in related.values().take(MAX_NOTES) {
        if let Some(document) = index.documents.iter().find(|document| document.document_ref == *reference) {
            notes.push(suggestion(document, &mut targets)?);
            for tag in &document.tags { let display = tag.trim().nfc().collect::<String>(); if !display.is_empty() { tags.entry(tag_key(&display)).or_insert(display); } }
        }
    }
    if tags.len() > MAX_TAGS { truncated(&mut quality, "tags"); }
    if source.frontmatter_tags.len() > MAX_TAGS { truncated(&mut quality, "documentTags"); }
    let tag_dtos = tags.values().take(MAX_TAGS).map(|name| {
        let ticket = token(); targets.insert(ticket.clone(), GrantedNoteTarget::Tag { name: name.clone() });
        NoteTag { id: tag_id(&reference.vault_id, name), name: name.clone(), ticket }
    }).collect();
    let metadata = NoteMetadata { notes, tags: tag_dtos, links, backlinks, document_tags: source.frontmatter_tags.iter().take(MAX_TAGS).map(|name| tag_id(&reference.vault_id, name)).collect(), favorite, note_embeds };
    let snapshot = NoteMetadataSnapshot { authority, revision: revision.into(), metadata, completeness: quality };
    if serde_json::to_vec(&snapshot).map_err(|_| "workspace-note-serialize")?.len() > MAX_METADATA_DTO_BYTES { return Err("workspace-note-metadata-capacity".into()); }
    Ok((snapshot, targets))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reference(path: &str) -> KnowledgeDocumentRef { KnowledgeDocumentRef { vault_id: "vault-a".into(), relative_path: path.into() } }
    fn identity(digest: &str) -> KnowledgeTargetIdentity { KnowledgeTargetIdentity { target_id: "vault-a".into(), identity_digest: digest.into(), label: "A".into() } }
    fn index() -> KnowledgeIndexSnapshot {
        let document = |path: &str, title: &str, target: Option<&str>| json!({"documentRef":{"vaultId":"vault-a","relativePath":path},"relativePath":path,"fileName":path,"title":title,"revision":"r1","headings":[],"wikiLinks":target.map(|value|vec![json!({"raw":format!("[[{value}]]"),"target":value,"alias":null,"line":1})]).unwrap_or_default(),"embeds":[],"tags":["shared"],"frontmatterTags":["shared"],"inlineTags":[],"plainText":"PRIVATE WHOLE DOCUMENT","excerpt":"bounded snippet","contentLength":5000,"modifiedAt":null,"size":5000});
        serde_json::from_value(json!({"vaultId":"vault-a","generation":1,"builtAt":"now","documents":[document("A.md","A",Some("B")),document("B.md","B",None),document("C.md","C",Some("A")),document("Unrelated.md","Unrelated",None)],"errors":[],"version":1,"changedPaths":[],"removedPaths":[],"stale":false,"refreshError":null})).unwrap()
    }
    fn built() -> (NoteMetadataSnapshot, HeldMetadata) {
        let source_ref = reference("A.md"); let identity = identity("original-root-incarnation");
        let authority = authority_from_identity(&identity, &source_ref).unwrap();
        let (snapshot, targets) = build_metadata(&index(), &source_ref, "r1", authority.clone(), false).unwrap();
        let held = HeldMetadata { generation: token(), authority, source_ref, revision:"r1".into(), identity, targets, complete:true };
        (snapshot, held)
    }
    #[test]
    fn projects_only_linked_metadata_and_never_bodies_or_roots() {
        let (snapshot, _) = built();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        for forbidden in ["PRIVATE WHOLE DOCUMENT", "plainText", "rootPath", "absolutePath", "Unrelated"] { assert!(!encoded.contains(forbidden), "{forbidden}"); }
        assert_eq!(snapshot.metadata.notes.len(),2); assert_eq!(snapshot.metadata.backlinks.len(),1);
        assert!(snapshot.completeness.complete); assert_eq!(snapshot.completeness.scope,"linked-and-backlinked");
        assert!(snapshot.metadata.notes.iter().all(|note|note.target.ticket.len()==64));
    }
    #[test]
    fn wiki_note_embeds_are_ticketed_chips_without_attachment_or_body_authority() {
        let mut input=index();input.documents[0].wiki_links.clear();input.documents[0].embeds=serde_json::from_value(json!([{"raw":"![[B.md]]","target":"B.md","kind":"md","line":2}])).unwrap();
        let source=reference("A.md");let authority=authority_from_identity(&identity("root"),&source).unwrap();
        let(snapshot,targets)=build_metadata(&input,&source,"r1",authority,false).unwrap();
        assert_eq!(snapshot.metadata.note_embeds.len(),1);let embed=&snapshot.metadata.note_embeds[0];assert_eq!(embed.note.document_id,document_id(&reference("B.md")).unwrap());assert!(targets.contains_key(&embed.note.ticket));
        let encoded=serde_json::to_string(&snapshot).unwrap();for forbidden in ["PRIVATE WHOLE DOCUMENT","absolutePath","previewUrl"]{assert!(!encoded.contains(forbidden));}
    }
    #[test]
    fn current_revision_and_scope_are_required() {
        let authority = authority_from_identity(&identity("one"), &reference("A.md")).unwrap();
        assert!(build_metadata(&index(),&reference("A.md"),"old",authority.clone(),false).is_err());
        let mut wrong=index();wrong.documents[1].document_ref.vault_id="vault-b".into();
        assert!(build_metadata(&wrong,&reference("A.md"),"r1",authority,false).is_err());
        for path in ["/outside.md","../outside.md","C:\\outside.md",".luckyray/private.md","folder/../../other.md"] { assert!(document_id(&reference(path)).is_err()); }
    }
    #[test]
    fn document_codec_matches_production_and_source_changes_on_recreated_vault() {
        let source = reference("含义/A.md");
        assert_eq!(document_id(&source).unwrap(), KnowledgeService::document_id(&source));
        let a=authority_from_identity(&identity("old-root"),&source).unwrap();
        let b=authority_from_identity(&identity("new-root"),&source).unwrap();
        assert_eq!(a.document_id,b.document_id);assert_ne!(a.source_id,b.source_id);
        assert!(!serde_json::to_string(&a).unwrap().contains("old-root"));
    }
    #[test]
    fn forged_owner_ticket_and_close_replay_are_rejected() {
        let registry=WorkspaceNotesMetadata::default(); let (snapshot,held)=built();
        let ticket=snapshot.metadata.notes[0].target.ticket.clone();
        registry.state.lock().unwrap().held.insert(("window-a".into(),"view-a".into()),held);
        assert!(registry.held("window-a","view-a").unwrap().targets.contains_key(&ticket));
        assert!(!registry.held("window-a","view-a").unwrap().targets.contains_key("B.md"));
        assert!(registry.held("window-b","view-a").is_err());assert!(registry.held("window-a","view-b").is_err());
        registry.remove_view("window-a","view-a");assert!(registry.held("window-a","view-a").is_err());
        let (_,rebound)=built();registry.state.lock().unwrap().held.insert(("window-a".into(),"view-a".into()),rebound);
        assert!(!registry.held("window-a","view-a").unwrap().targets.contains_key(&ticket));
        registry.remove_window("window-a");assert!(registry.held("window-a","view-a").is_err());
    }
    #[test]
    fn stale_or_truncated_metadata_never_claims_full_readiness() {
        let authority=authority_from_identity(&identity("one"),&reference("A.md")).unwrap();
        let mut input=index();input.stale=true;
        let (stale,_)=build_metadata(&input,&reference("A.md"),"r1",authority.clone(),false).unwrap();assert!(!stale.completeness.complete);
        input.stale=false;input.documents[0].wiki_links=vec![input.documents[0].wiki_links[0].clone();MAX_LINKS+1];
        let (limited,_)=build_metadata(&input,&reference("A.md"),"r1",authority,false).unwrap();
        assert!(!limited.completeness.complete);assert!(limited.completeness.truncated);assert_eq!(limited.metadata.links.len(),MAX_LINKS);
    }
    #[test]
    fn snippets_and_tags_are_bounded_and_use_production_unicode_identity() {
        let authority=authority_from_identity(&identity("one"),&reference("A.md")).unwrap();let mut input=index();
        input.documents[1].excerpt="字".repeat(500);
        input.documents[0].tags=vec!["Cafe\u{301}".into(),"CAFÉ".into()];input.documents[0].frontmatter_tags=vec!["CAFÉ".into()];
        input.documents[1].tags=vec![];input.documents[2].tags=vec![];
        let (snapshot,_)=build_metadata(&input,&reference("A.md"),"r1",authority,false).unwrap();
        assert_eq!(snapshot.metadata.notes[0].snippet.chars().count(),240);assert_eq!(snapshot.metadata.tags.len(),1);
        assert_eq!(tag_id("vault-a","CAFÉ"),"real-vault-tag:vault-a:caf%C3%A9");
    }
    #[test]
    fn native_scope_checks_reject_global_service_stale_revisions_and_missing_provider() {
        let root=tempfile::tempdir().unwrap();let vault=root.path().join("vault");
        std::fs::create_dir_all(vault.join(".luckyray")).unwrap();
        let registration=crate::knowledge::KnowledgeVaultRegistration { id:"vault-a".into(),name:"A".into(),root_path:vault.to_string_lossy().into(),mode:"vault-bound".into(),created_at:"2026-10-01T00:00:00Z".into(),last_opened_at:"2026-10-01T00:00:00Z".into(),schema_version:1,link_update_policy:Default::default() };
        std::fs::write(vault.join(".luckyray/vault.json"),serde_json::to_vec(&registration).unwrap()).unwrap();
        std::fs::write(vault.join("A.md"),"# A\n\n[[B]]").unwrap();std::fs::write(vault.join("B.md"),"# B").unwrap();
        let service=KnowledgeService::initialize(root.path().join("app")).unwrap();service.register_current_vault(&registration).unwrap();
        assert!(authority_for(&service,&reference("A.md")).is_err());
        let scope=service.capture_workspace_scope("vault-a").unwrap();let revision=scope.read_document(&reference("A.md")).unwrap().revision;
        let registry=WorkspaceNotesMetadata::default();
        assert!(registry.read("window","view",&scope,&reference("A.md"),&revision, |_|Ok(NoteFavoriteStatus::Unavailable)).is_err());
        let cancelled=registry.read("window","view",&scope,&reference("A.md"),&revision, |_| { registry.remove_view("window","view"); Ok(NoteFavoriteStatus::Known(false)) });
        assert_eq!(cancelled.unwrap_err(),"workspace-note-metadata-superseded");
        let snapshot=registry.read("window","view",&scope,&reference("A.md"),&revision, |_|Ok(NoteFavoriteStatus::Known(false))).unwrap();
        let ticket=&snapshot.metadata.notes[0].target.ticket;
        assert!(registry.target_for_scope("window","view",ticket,&scope,&reference("A.md"),&revision).is_ok());
        let refreshed=registry.read("window","view",&scope,&reference("A.md"),&revision, |_|Ok(NoteFavoriteStatus::Known(true))).unwrap();
        assert_eq!(refreshed.metadata.notes[0].target.ticket,*ticket);
        assert!(refreshed.metadata.favorite);
        let first=registry.list_index("window","view",&scope,&reference("A.md"),&revision,None,1).unwrap();
        assert_eq!(first.total,2);assert_eq!(first.notes.len(),1);
        assert_eq!(first.completeness.scope,"vault-index-page");
        let cursor=first.next_cursor.clone().unwrap();
        registry.read("window","view",&scope,&reference("A.md"),&revision, |_|Ok(NoteFavoriteStatus::Known(false))).unwrap();
        let next=registry.list_index("window","view",&scope,&reference("A.md"),&revision,Some(&cursor),1).unwrap();
        assert_eq!(next.notes.len(),1);assert!(next.next_cursor.is_none());
        assert!(registry.list_index("window","view",&scope,&reference("A.md"),&revision,Some(&cursor),1).is_err());
        assert!(registry.target_for_scope("forged","view",ticket,&scope,&reference("A.md"),&revision).is_err());
        assert!(registry.target_for_scope("window","view",ticket,&scope,&reference("B.md"),&revision).is_err());
        std::fs::write(vault.join("A.md"),"# Updated\n\n[[B]]").unwrap();
        assert!(registry.target_for_scope("window","view",ticket,&scope,&reference("A.md"),&revision).is_err());
        // Re-created root at the same textual location cannot inherit the scope.
        std::fs::rename(&vault,root.path().join("retired-vault")).unwrap();
        std::fs::create_dir_all(vault.join(".luckyray")).unwrap();
        std::fs::write(vault.join(".luckyray/vault.json"),serde_json::to_vec(&registration).unwrap()).unwrap();
        std::fs::write(vault.join("A.md"),"# Updated\n\n[[B]]").unwrap();
        assert!(authority_for(&scope,&reference("A.md")).is_err());
    }
}
