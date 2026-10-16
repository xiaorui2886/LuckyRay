//! Exact-note operations. The native dispatcher authenticates the real caller,
//! live view and authority before entering these APIs. No renderer path, SQL,
//! active-Main source or guessed asset identity is accepted here.
use crate::knowledge::{AttachmentPublication, KnowledgeDocumentRef, KnowledgeDocumentSnapshot, KnowledgeIndexSnapshot, KnowledgeMoveInput, KnowledgeService, KnowledgeSetTagsInput, KnowledgeTargetIdentity};
use crate::workspace_actions::ActionCorrelation;
use crate::workspace_windows::ViewGrant;
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, fs::File, io::{Read, Seek, SeekFrom}, path::Path, sync::Mutex, time::{Duration, Instant}};
use unicode_normalization::UnicodeNormalization;

pub(crate) const MAX_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;
const MAX_CONTENT: usize = 8 * 1024 * 1024;
const MAX_REVIEW_NOTES: usize = 64;
const REVIEW_TTL: Duration = Duration::from_secs(180);

pub(crate) fn reference_for(view: &ViewGrant) -> Result<KnowledgeDocumentRef, String> {
    if view.kind != "note" { return Err("workspace-note-required".into()); }
    let reference = KnowledgeDocumentRef { vault_id: view.library_id.clone(), relative_path: view.resource_id.clone().ok_or("workspace-note-required")? };
    crate::workspace_notes_metadata::document_id(&reference)?;
    Ok(reference)
}

pub(crate) fn validate_note(
    scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str,
) -> Result<(KnowledgeDocumentRef, KnowledgeTargetIdentity, KnowledgeDocumentSnapshot), String> {
    if content.len() > MAX_CONTENT || correlation.revision.is_empty() || correlation.revision.len() > 128
        || correlation.request_id == 0 || correlation.request_id > 9_007_199_254_740_991 || correlation.generation > 9_007_199_254_740_991 {
        return Err("workspace-note-action-invalid".into());
    }
    scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
    let reference = reference_for(view)?;
    let identity = scope.current_target_identity().map_err(crate::knowledge_error)?;
    let document = scope.read_document_for_target(&identity, &reference).map_err(crate::knowledge_error)?;
    if document.revision != correlation.revision || document.content != content { return Err("knowledge-revision-conflict".into()); }
    Ok((reference, identity, document))
}

pub(crate) fn rename_note(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, title: &str) -> Result<KnowledgeDocumentSnapshot, String> {
    let (reference, identity, document) = validate_note(scope, view, correlation, content)?;
    validate_title(title)?;
    if document.summary.title == title.trim() { return Ok(document); }
    let renamed = scope.move_document_for_target(&identity, &KnowledgeMoveInput { document_ref: reference.clone(), title: title.into(), expected_revision: correlation.revision.clone(), parent_relative_path: None }).map_err(crate::knowledge_error)?;
    if renamed.summary.document_ref == reference && renamed.revision != correlation.revision { return Err("knowledge-revision-conflict".into()); }
    Ok(renamed)
}

fn validate_title(title: &str) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 512 || title.chars().any(char::is_control) { return Err("workspace-note-title-invalid".into()); }
    Ok(())
}

pub(crate) fn create_note(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, source_content: &str, title: &str, content: &str) -> Result<KnowledgeDocumentSnapshot, String> {
    let (reference, identity, _) = validate_note(scope, view, correlation, source_content)?;
    validate_title(title)?;
    if content.len() > MAX_CONTENT { return Err("workspace-note-content-limit".into()); }
    scope.workspace_create_sibling(&identity, &reference, &correlation.revision, title, content).map_err(crate::knowledge_error)
}

fn tag_key(value: &str) -> String { value.trim().trim_start_matches('#').trim().nfc().collect::<String>().to_lowercase() }
fn normalize_tags(values: &[String]) -> Result<Vec<String>, String> {
    if values.len() > 256 { return Err("workspace-note-tag-limit".into()); }
    let mut seen = HashSet::new();
    let mut tags = Vec::new();
    for value in values {
        let value = value.trim().trim_start_matches('#').trim().nfc().collect::<String>();
        if value.is_empty() || value.chars().count() > 64 || value.starts_with('-') || value.chars().any(char::is_control) { return Err("workspace-note-tag-invalid".into()); }
        if seen.insert(tag_key(&value)) { tags.push(value); }
    }
    Ok(tags)
}
fn checked_index(scope: &KnowledgeService, identity: &KnowledgeTargetIdentity, reference: &KnowledgeDocumentRef, revision: &str) -> Result<KnowledgeIndexSnapshot, String> {
    let index = scope.refresh_index_for_target(identity).map_err(crate::knowledge_error)?;
    if index.documents.len() > 100_000 || index.stale || !index.errors.is_empty() || index.refresh_error.is_some() { return Err("workspace-note-index-incomplete".into()); }
    if index.vault_id != reference.vault_id || index.documents.iter().any(|document| document.document_ref.vault_id != reference.vault_id) { return Err("workspace-note-scope-mismatch".into()); }
    if !index.documents.iter().any(|document| document.document_ref == *reference && document.revision == revision) { return Err("knowledge-revision-conflict".into()); }
    Ok(index)
}
fn save_tags(scope: &KnowledgeService, identity: &KnowledgeTargetIdentity, reference: KnowledgeDocumentRef, revision: &str, tags: &[String]) -> Result<KnowledgeDocumentSnapshot, String> {
    let tags = normalize_tags(tags)?;
    scope.set_document_tags_for_target(identity, &KnowledgeSetTagsInput { document_ref: reference, expected_revision: revision.into(), tags }).map(|result| result.document).map_err(crate::knowledge_error)
}
/// Replaces only the frontmatter tag field using the exact saved-note CAS.
pub(crate) fn apply_tags(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, names: &[String]) -> Result<KnowledgeDocumentSnapshot, String> {
    let (reference, identity, _) = validate_note(scope, view, correlation, content)?;
    save_tags(scope, &identity, reference, &correlation.revision, names)
}
/// Applying AI suggestions is additive, matching production Notes. It never
/// repurposes a stale suggestion selection as a replacement of current tags.
pub(crate) fn merge_tags(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, names: &[String]) -> Result<KnowledgeDocumentSnapshot, String> {
    if names.is_empty() { return Err("workspace-note-tag-selection-empty".into()); }
    let (reference, identity, _) = validate_note(scope, view, correlation, content)?;
    let index=checked_index(scope,&identity,&reference,&correlation.revision)?;
    let mut tags=index.documents.iter().find(|document|document.document_ref==reference).ok_or("workspace-note-not-found")?.frontmatter_tags.clone();
    tags.extend(normalize_tags(names)?);save_tags(scope,&identity,reference,&correlation.revision,&tags)
}
/// `name` must come from a verified metadata ticket/id mapping, not tagId text.
pub(crate) fn remove_tag(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, name: &str) -> Result<KnowledgeDocumentSnapshot, String> {
    let (reference, identity, _) = validate_note(scope, view, correlation, content)?;
    let index = checked_index(scope, &identity, &reference, &correlation.revision)?;
    let source = index.documents.iter().find(|document| document.document_ref == reference).ok_or("workspace-note-not-found")?;
    let key = tag_key(name);
    if key.is_empty() || !source.frontmatter_tags.iter().any(|value| tag_key(value) == key) { return Err("workspace-note-tag-not-assigned".into()); }
    let tags = source.frontmatter_tags.iter().filter(|value| tag_key(value) != key).cloned().collect::<Vec<_>>();
    save_tags(scope, &identity, reference, &correlation.revision, &tags)
}
pub(crate) fn create_tag(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, name: &str) -> Result<KnowledgeDocumentSnapshot, String> {
    let (reference, identity, _) = validate_note(scope, view, correlation, content)?;
    let name = normalize_tags(&[name.into()])?.remove(0);
    let index = checked_index(scope, &identity, &reference, &correlation.revision)?;
    let mut tags = index.documents.iter().find(|document| document.document_ref == reference).ok_or("workspace-note-not-found")?.frontmatter_tags.clone();
    tags.push(name);
    save_tags(scope, &identity, reference, &correlation.revision, &tags)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceAttachmentImport {
    pub publication: AttachmentPublication,
    pub destination: String, pub wiki: bool, pub identity: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceNoteReference { pub destination: String, pub wiki: bool, pub label: String }

/// These are display candidates only. The host MUST intersect its original
/// Main grant before issuing an open/preview ticket, even after a child save.
pub(crate) fn list_current_references(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str) -> Result<Vec<WorkspaceNoteReference>, String> {
    validate_note(scope, view, correlation, content)?;
    let links = crate::knowledge::companion_attachment_links(content);
    if links.len() > 4096 { return Err("workspace-note-reference-limit".into()); }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for link in links {
        let wiki = link.syntax == crate::knowledge::CompanionLinkSyntax::Wiki;
        let base = link.destination.split(['#', '?', '|']).next().unwrap_or_default();
        let extension = Path::new(base).extension().and_then(|extension| extension.to_str());
        if !link.embedded && (extension.is_none() || extension.is_some_and(|extension| extension.eq_ignore_ascii_case("md")) || base.starts_with("https://") || base.starts_with("http://")) { continue; }
        if link.destination.len() > 8192 { return Err("workspace-note-reference-limit".into()); }
        if seen.insert((link.destination.clone(), wiki)) {
            let label = link.destination.rsplit('/').next().unwrap_or(&link.destination).chars().take(256).collect();
            result.push(WorkspaceNoteReference { destination: link.destination, wiki, label });
        }
        if result.len() > 256 { return Err("workspace-note-reference-limit".into()); }
    }
    Ok(result)
}

pub(crate) fn import_attachment(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, name: &str, bytes: &[u8]) -> Result<WorkspaceAttachmentImport, String> {
    let (reference, identity, _) = validate_note(scope, view, correlation, content)?;
    if name.is_empty() || name.len() > 512 || name.contains(['/', '\\']) || name.chars().any(char::is_control) || bytes.len() > MAX_ATTACHMENT_BYTES { return Err("workspace-note-attachment-invalid".into()); }
    let publication = scope.workspace_publish_attachment(&identity, &reference, &correlation.revision, name, bytes).map_err(crate::knowledge_error)?;
    // Never rescan the caller's content to widen authority. Only this new
    // server-created publication can add one exact attachment identity.
    let mut links = crate::knowledge::companion_attachment_links(&publication.markdown);
    if links.len() != 1 { return Err("workspace-note-publication-invalid".into()); }
    let link = links.remove(0);
    Ok(WorkspaceAttachmentImport { destination: link.destination, wiki: link.syntax == crate::knowledge::CompanionLinkSyntax::Wiki, identity: publication.relative_path.clone(), publication })
}

/// Call ONLY with an OS-picker result owned by the Main command handler.
pub(crate) fn import_attachment_file(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, selected: &Path) -> Result<WorkspaceAttachmentImport, String> {
    validate_note(scope, view, correlation, content)?;
    let name = selected.file_name().and_then(|name| name.to_str()).ok_or("workspace-note-picker-file-invalid")?;
    let bytes = scope.workspace_read_picked_file(selected, MAX_ATTACHMENT_BYTES).map_err(crate::knowledge_error)?;
    import_attachment(scope, view, correlation, content, name, &bytes)
}
/// Main has explicitly selected a catalog item and opened this exact object.
/// Child-provided asset ids are not accepted as catalog read authority here.
pub(crate) fn import_attachment_reader(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, name: &str, file: &mut File) -> Result<WorkspaceAttachmentImport, String> {
    validate_note(scope, view, correlation, content)?;
    let before = file.metadata().map_err(|_| "workspace-note-attachment-unavailable")?;
    if !before.is_file() || before.len() > MAX_ATTACHMENT_BYTES as u64 { return Err("workspace-note-attachment-limit".into()); }
    file.seek(SeekFrom::Start(0)).map_err(|_| "workspace-note-attachment-unavailable")?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut *file).take(MAX_ATTACHMENT_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| "workspace-note-attachment-unavailable")?;
    let after = file.metadata().map_err(|_| "workspace-note-attachment-unavailable")?;
    if bytes.len() as u64 != before.len() || before.len() != after.len() || before.modified().ok() != after.modified().ok() { return Err("workspace-note-attachment-changed".into()); }
    import_attachment(scope, view, correlation, content, name, &bytes)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceNoteExport { pub name: String, pub bytes: Vec<u8>, pub mime_type: &'static str }
pub(crate) fn export_markdown(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str) -> Result<WorkspaceNoteExport, String> {
    let (reference, identity, _) = validate_note(scope, view, correlation, content)?;
    let bytes = scope.workspace_markdown_bytes(&identity, &reference, &correlation.revision).map_err(crate::knowledge_error)?;
    Ok(WorkspaceNoteExport { name: Path::new(&reference.relative_path).file_name().and_then(|name| name.to_str()).ok_or("workspace-note-export-invalid")?.into(), bytes, mime_type: "text/markdown; charset=utf-8" })
}
/// Imports one Markdown picked in Main into the captured note's own directory.
/// Existing attachment links stay ordinary text and do not obtain new grants.
pub(crate) fn import_markdown_file(scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, selected: &Path) -> Result<KnowledgeDocumentSnapshot, String> {
    validate_note(scope, view, correlation, content)?;
    if !selected.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")) { return Err("workspace-note-markdown-required".into()); }
    let title = selected.file_stem().and_then(|name| name.to_str()).ok_or("workspace-note-picker-file-invalid")?;
    let bytes = scope.workspace_read_picked_file(selected, MAX_CONTENT).map_err(crate::knowledge_error)?;
    let imported = KnowledgeService::workspace_decode_markdown(&bytes).map_err(crate::knowledge_error)?;
    create_note(scope, view, correlation, content, title, &imported)
}

#[derive(Clone)]
struct TagRenameTarget { reference: KnowledgeDocumentRef, document_id: String, title: String, revision: String, tags: Vec<String> }
struct TagReview {
    caller: String, view: ViewGrant, correlation: ActionCorrelation, content: String,
    scope: KnowledgeService, identity: KnowledgeTargetIdentity, targets: Vec<TagRenameTarget>, expires: Instant,
}
#[derive(Default)]
pub(crate) struct WorkspaceNoteActions { reviews: Mutex<HashMap<String, TagReview>> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagRenameNote { pub document_id: String, pub title: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagRenameReview {
    pub id: String, pub old_name: String, pub name: String, pub notes: Vec<TagRenameNote>,
    pub inline_only_count: usize, pub scope: &'static str, pub expires_in_ms: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagRenameFailure { pub document_id: String, pub code: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagRenameResult { pub updated: Vec<KnowledgeDocumentSnapshot>, pub failures: Vec<TagRenameFailure> }

impl WorkspaceNoteActions {
    pub(crate) fn remove_view(&self, caller: &str, view_id: &str) { if let Ok(mut reviews) = self.reviews.lock() { reviews.retain(|_, review| review.caller != caller || review.view.id != view_id); } }
    pub(crate) fn remove_window(&self, caller: &str) { if let Ok(mut reviews) = self.reviews.lock() { reviews.retain(|_, review| review.caller != caller); } }
    /// Only pass an old name resolved from the source note's metadata ticket.
    /// Review DTOs expose titles and opaque document ids, never note bodies.
    pub(crate) fn prepare_tag_rename(&self, caller: &str, scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, old_name: &str, name: &str) -> Result<TagRenameReview, String> {
        if caller.is_empty() || caller.len() > 128 { return Err("workspace-note-owner-invalid".into()); }
        let (reference, identity, _) = validate_note(scope, view, correlation, content)?;
        let name = normalize_tags(&[name.into()])?.remove(0);
        let old_name = normalize_tags(&[old_name.into()])?.remove(0);
        let old_key = tag_key(&old_name);
        let index = checked_index(scope, &identity, &reference, &correlation.revision)?;
        let mut targets = Vec::new();
        let mut inline_only_count = 0;
        for document in index.documents {
            if document.frontmatter_tags.iter().any(|tag| tag_key(tag) == old_key) {
                if targets.len() == MAX_REVIEW_NOTES { return Err("workspace-note-tag-review-limit".into()); }
                let tags = normalize_tags(&document.frontmatter_tags.iter().map(|tag| if tag_key(tag) == old_key { name.clone() } else { tag.clone() }).collect::<Vec<_>>())?;
                targets.push(TagRenameTarget { document_id: crate::workspace_notes_metadata::document_id(&document.document_ref)?, reference: document.document_ref, title: document.title, revision: document.revision, tags });
            } else if document.tags.iter().any(|tag| tag_key(tag) == old_key) { inline_only_count += 1; }
        }
        if targets.is_empty() { return Err("workspace-note-no-frontmatter-tag-targets".into()); }
        targets.sort_by(|left, right| left.document_id.cmp(&right.document_id));
        validate_note(scope, view, correlation, content)?;
        let id = format!("{:032x}{:032x}", rand::random::<u128>(), rand::random::<u128>());
        let result = TagRenameReview { id: id.clone(), old_name, name, notes: targets.iter().map(|target| TagRenameNote { document_id: target.document_id.clone(), title: target.title.clone() }).collect(), inline_only_count, scope: "frontmatter-only", expires_in_ms: REVIEW_TTL.as_millis() as u64 };
        let mut reviews = self.reviews.lock().map_err(|_| "workspace-note-action-lock")?;
        reviews.retain(|_, review| review.expires > Instant::now() && (review.caller != caller || review.view.id != view.id));
        if reviews.len() >= 32 { return Err("workspace-note-action-capacity".into()); }
        reviews.insert(id, TagReview { caller: caller.into(), view: view.clone(), correlation: correlation.clone(), content: content.into(), scope: scope.clone(), identity, targets, expires: Instant::now() + REVIEW_TTL });
        Ok(result)
    }
    /// Main chooses the exact reviewed ids. Single-use review is consumed before
    /// writes; each target has its own CAS, and partial outcomes are explicit.
    pub(crate) fn commit_tag_rename(&self, caller: &str, id: &str, selected: &[String], mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>) -> Result<TagRenameResult, String> {
        if caller != "main" { return Err("workspace-action-main-required".into()); }
        if selected.is_empty() || selected.len() > MAX_REVIEW_NOTES { return Err("workspace-note-tag-selection-invalid".into()); }
        let mut reviews = self.reviews.lock().map_err(|_| "workspace-note-action-lock")?;
        let review = reviews.get(id).ok_or("workspace-note-tag-review-expired")?;
        if review.expires <= Instant::now() { return Err("workspace-note-tag-review-expired".into()); }
        let chosen = selected.iter().cloned().collect::<HashSet<_>>();
        if chosen.len() != selected.len() || selected.iter().any(|id| !review.targets.iter().any(|target| target.document_id == *id)) { return Err("workspace-note-tag-selection-invalid".into()); }
        live(&review.caller, &review.view, &review.correlation)?;
        let (_, identity, _) = validate_note(&review.scope, &review.view, &review.correlation, &review.content)?;
        if identity != review.identity { return Err("workspace-note-source-changed".into()); }
        let review = reviews.remove(id).ok_or("workspace-note-tag-review-expired")?;
        let mut result = TagRenameResult { updated: Vec::new(), failures: Vec::new() };
        for target in review.targets.into_iter().filter(|target| chosen.contains(&target.document_id)) {
            match save_tags(&review.scope, &review.identity, target.reference, &target.revision, &target.tags) {
                Ok(document) => result.updated.push(document),
                Err(code) => result.failures.push(TagRenameFailure { document_id: target.document_id, code }),
            }
        }
        Ok(result)
    }
}

const HANDLER_TTL: Duration = Duration::from_secs(15);
const ACTION_TTL: Duration = Duration::from_secs(180);
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct NoteSelection { pub start: usize, pub end: usize }
#[derive(Clone, Debug)]
pub(crate) enum NoteMainRequest {
    AskAi, OpenTag { name: String },
    SuggestAi, WriteAi { action: String, selection: NoteSelection },
    PickAttachment { selection: NoteSelection },
    PickCatalog { selection: NoteSelection, suggested_asset_id: Option<String> },
    ImportDocument, ExportDocument { format: String }, RenameTag { review: TagRenameReview },
    ManageKnowledge { section: String },
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum NoteMainAction {
    ComposeAi { text: String },
    OpenTag { #[serde(rename="vaultId")] vault_id: String, name: String },
    SuggestAi { title: String, content: String, #[serde(rename = "currentTags")] current_tags: Vec<String>, #[serde(rename = "knownTags")] known_tags: Vec<String> },
    WriteAi { action: String, content: String, selection: NoteSelection },
    PickAttachment { selection: NoteSelection },
    PickCatalog { selection: NoteSelection, #[serde(rename = "suggestedAssetId", skip_serializing_if = "Option::is_none")] suggested_asset_id: Option<String> },
    ImportDocument,
    ExportDocument { format: String, content: String, title: String },
    RenameTag { review: TagRenameReview },
    ManageKnowledge { #[serde(rename = "vaultId")] vault_id: String, #[serde(rename = "sourceId")] source_id: String, section: String },
}
impl NoteMainAction {
    fn kind(&self) -> &'static str { match self { Self::ComposeAi {..} => "composeAi", Self::OpenTag {..} => "openTag", Self::SuggestAi {..} => "suggestAi", Self::WriteAi {..} => "writeAi", Self::PickAttachment {..} => "pickAttachment", Self::PickCatalog {..} => "pickCatalog", Self::ImportDocument => "importDocument", Self::ExportDocument {..} => "exportDocument", Self::RenameTag {..} => "renameTag", Self::ManageKnowledge {..} => "manageKnowledge" } }
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum NoteActionOutcome {
    Suggestion { #[serde(skip_serializing_if = "Option::is_none")] summary: Option<String>, tags: Vec<String> },
    ReplaceRange { selection: NoteSelection, text: String },
    Saved { snapshot: crate::workspace_notes_metadata::NoteSnapshot, #[serde(skip_serializing_if="Option::is_none")] message: Option<String> },
    Acknowledged { #[serde(skip_serializing_if = "Option::is_none")] message: Option<String> },
    Renamed { title: String, #[serde(rename = "documentId")] document_id: String },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum NoteMainCompletion {
    Suggestion { summary: Option<String>, tags: Vec<String> },
    ReplaceRange { selection: NoteSelection, text: String },
    Acknowledged { message: Option<String> },
    Cancelled {},
    Failed { #[serde(alias = "message")] code: String },
}
#[derive(Clone)]
pub(crate) struct NoteExecutionContext {
    pub caller: String,
    pub scope: KnowledgeService, pub view: ViewGrant, pub correlation: ActionCorrelation,
    pub content: String, pub action: NoteMainAction,
}
#[derive(Clone)]
struct NoteActionEntry {
    id: String, caller: String, context: NoteExecutionContext, identity: KnowledgeTargetIdentity,
    expires: Instant, claim: Option<String>, executed: bool,
    result: Option<Result<NoteActionOutcome, String>>,
}
struct NoteHandler { kinds: HashSet<String>, expires: Instant }
#[derive(Default)]
struct NoteQueueState { entries: HashMap<String, NoteActionEntry>, latest: HashMap<(String, String), u64>, handler: Option<NoteHandler> }
#[derive(Default)]
pub(crate) struct NoteActionStore { state: Mutex<NoteQueueState> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteHandlerStatus { pub kinds: Vec<String>, pub expires_in_ms: u64 }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteActionReceipt { pub id: String, pub request_id: u64, pub view_id: String, pub revision: String, pub generation: u64 }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteActionOffer { pub id: String, pub title: String, pub view_id: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteActionClaim { pub id: String, pub claim_token: String, pub remaining_ms: u64, pub action: NoteMainAction, pub source: NoteActionSource }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteActionSource { pub view_id: String, pub vault_id: String, pub source_id: String, pub title: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteActionStatus {
    #[serde(flatten)] pub receipt: NoteActionReceipt,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")] pub result: Option<NoteActionResult>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum NoteActionResult {
    Success { ok: bool, value: NoteActionOutcome },
    Failure { ok: bool, code: &'static str, message: String },
}
fn main_only(caller: &str) -> Result<(), String> { if caller == "main" { Ok(()) } else { Err("workspace-action-main-required".into()) } }
fn action_token() -> String { format!("{:032x}{:032x}", rand::random::<u128>(), rand::random::<u128>()) }
fn validate_selection(content: &str, selection: NoteSelection) -> Result<(), String> {
    let utf16 = content.encode_utf16().collect::<Vec<_>>();
    if selection.start > selection.end || selection.end > utf16.len() || String::from_utf16(&utf16[..selection.start]).is_err() || String::from_utf16(&utf16[selection.start..selection.end]).is_err() { return Err("workspace-note-selection-invalid".into()); }
    Ok(())
}
impl NoteActionEntry {
    fn receipt(&self) -> NoteActionReceipt { NoteActionReceipt { id: self.id.clone(), request_id: self.context.correlation.request_id, view_id: self.context.view.id.clone(), revision: self.context.correlation.revision.clone(), generation: self.context.correlation.generation } }
    fn validate(&self, live: &mut impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>) -> Result<(), String> {
        if self.expires <= Instant::now() { return Err("workspace-note-action-expired".into()); }
        live(&self.caller, &self.context.view, &self.context.correlation)?;
        if self.context.scope.current_target_identity().map_err(crate::knowledge_error)? != self.identity { return Err("workspace-note-source-changed".into()); }
        let saved = match &self.result { Some(Ok(NoteActionOutcome::Saved { snapshot, .. })) => Some(snapshot), _ => None };
        if let Some(snapshot) = saved.filter(|snapshot| reference_for(&self.context.view).ok().as_ref() == Some(&snapshot.document_ref)) {
            // A trusted native CAS may advance this note. Verify its exact
            // committed replacement, rather than bypassing source proof.
            let current = self.context.scope.read_document_for_target(&self.identity, &snapshot.document_ref).map_err(crate::knowledge_error)?;
            if current.revision != snapshot.revision || current.content != snapshot.content { return Err("knowledge-revision-conflict".into()); }
        } else {
            // Attachment publication, export and creation do not change the
            // source note. Even completed results remain revision-bound.
            validate_note(&self.context.scope, &self.context.view, &self.context.correlation, &self.context.content)?;
        }
        Ok(())
    }
}
impl NoteActionStore {
    pub(crate) fn has_pending_window(&self, label: &str) -> Result<bool, String> {
        let state=self.state.lock().map_err(|_|"workspace-note-action-lock")?;
        Ok(state.entries.values().any(|entry|entry.expires>Instant::now()&&entry.result.is_none()&&(entry.caller==label||label=="main")))
    }
    pub(crate) fn reserve_direct(&self, caller: &str, view: &ViewGrant, correlation: &ActionCorrelation) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        let owner = (caller.to_owned(), view.id.clone());
        if state.latest.get(&owner).is_some_and(|latest| *latest >= correlation.request_id) { return Err("workspace-note-action-superseded".into()); }
        if !state.latest.contains_key(&owner) && state.latest.len() >= 256 { return Err("workspace-note-action-capacity".into()); }
        state.latest.insert(owner, correlation.request_id);
        state.entries.retain(|_, entry| entry.caller != caller || entry.context.view.id != view.id);
        Ok(())
    }
    fn require_handler(state: &NoteQueueState, id: &str) -> Result<(), String> {
        let entry = state.entries.get(id).ok_or("workspace-note-action-expired")?;
        if state.handler.as_ref().is_some_and(|handler| handler.expires > Instant::now() && handler.kinds.contains(entry.context.action.kind())) { Ok(()) } else { Err("workspace-note-main-handler-unavailable".into()) }
    }
    pub(crate) fn remove_view(&self, caller: &str, view_id: &str) { if let Ok(mut state) = self.state.lock() { state.entries.retain(|_, entry| entry.caller != caller || entry.context.view.id != view_id); state.latest.remove(&(caller.into(), view_id.into())); } }
    pub(crate) fn remove_window(&self, caller: &str) { if let Ok(mut state) = self.state.lock() { state.entries.retain(|_, entry| entry.caller != caller); state.latest.retain(|(owner, _), _| owner != caller); if caller == "main" { state.handler = None; } } }
    pub(crate) fn register_main(&self, caller: &str, kinds: &[String]) -> Result<NoteHandlerStatus, String> {
        main_only(caller)?;
        if kinds.len() > 10 || kinds.iter().any(|kind| !matches!(kind.as_str(), "composeAi" | "openTag" | "suggestAi" | "writeAi" | "pickAttachment" | "pickCatalog" | "importDocument" | "exportDocument" | "renameTag" | "manageKnowledge")) { return Err("workspace-note-handler-invalid".into()); }
        let kinds = kinds.iter().cloned().collect::<HashSet<_>>();
        let mut announced = kinds.iter().cloned().collect::<Vec<_>>(); announced.sort();
        self.state.lock().map_err(|_| "workspace-note-action-lock")?.handler = Some(NoteHandler { kinds, expires: Instant::now() + HANDLER_TTL });
        Ok(NoteHandlerStatus { kinds: announced, expires_in_ms: HANDLER_TTL.as_millis() as u64 })
    }
    pub(crate) fn capabilities(&self) -> Result<NoteHandlerStatus, String> {
        let state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        let Some(handler) = state.handler.as_ref().filter(|handler| handler.expires > Instant::now()) else { return Ok(NoteHandlerStatus { kinds: vec![], expires_in_ms: 0 }); };
        let mut kinds = handler.kinds.iter().cloned().collect::<Vec<_>>(); kinds.sort();
        Ok(NoteHandlerStatus { kinds, expires_in_ms: handler.expires.saturating_duration_since(Instant::now()).as_millis() as u64 })
    }
    pub(crate) fn enqueue(&self, caller: &str, scope: &KnowledgeService, view: &ViewGrant, correlation: &ActionCorrelation, content: &str, request: NoteMainRequest) -> Result<NoteActionReceipt, String> {
        if caller.is_empty() || caller.len() > 128 || view.id.is_empty() || view.id.len() > 128 { return Err("workspace-note-owner-invalid".into()); }
        let (reference, identity, document) = validate_note(scope, view, correlation, content)?;
        let action = match request {
            NoteMainRequest::AskAi => {
                let bounded = content.chars().scan(0usize, |bytes, ch| { *bytes += ch.len_utf8(); (*bytes <= 9 * 1024).then_some(ch) }).collect::<String>();
                let truncated=bounded.len()<content.len();
                NoteMainAction::ComposeAi { text: format!("请基于这篇笔记帮我分析。\n\n笔记：{}\n\n{}{}", document.summary.title.chars().take(128).collect::<String>(), bounded, if truncated { "\n\n（长笔记仅附上前面的部分。）" } else { "" }) }
            },
            NoteMainRequest::OpenTag { name } => {
                let name=normalize_tags(&[name])?.remove(0);
                NoteMainAction::OpenTag { vault_id: reference.vault_id.clone(), name }
            },
            NoteMainRequest::SuggestAi => {
                if content.len() > 256 * 1024 { return Err("workspace-note-ai-content-limit".into()); }
                let index = checked_index(scope, &identity, &reference, &correlation.revision)?;
                let current_tags = index.documents.iter().find(|document| document.document_ref == reference).ok_or("workspace-note-not-found")?.frontmatter_tags.clone();
                let mut known = HashSet::new();
                let mut known_tags = Vec::new();
                for tag in index.documents.iter().flat_map(|document| &document.frontmatter_tags) { if known.insert(tag_key(tag)) && known_tags.len() < 256 { known_tags.push(tag.clone()); } }
                NoteMainAction::SuggestAi { title: document.summary.title, content: content.into(), current_tags, known_tags }
            },
            NoteMainRequest::WriteAi { action, selection } => {
                if content.len() > 256 * 1024 || !matches!(action.as_str(), "rewrite" | "shorten" | "summary" | "translate" | "expand" | "continue" | "title") { return Err("workspace-note-ai-action-invalid".into()); }
                validate_selection(content, selection)?;
                NoteMainAction::WriteAi { action, content: content.into(), selection }
            },
            NoteMainRequest::PickAttachment { selection } => { validate_selection(content, selection)?; NoteMainAction::PickAttachment { selection } },
            NoteMainRequest::PickCatalog { selection, suggested_asset_id } => {
                validate_selection(content, selection)?;
                if suggested_asset_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)) { return Err("workspace-note-catalog-id-invalid".into()); }
                NoteMainAction::PickCatalog { selection, suggested_asset_id }
            },
            NoteMainRequest::ImportDocument => NoteMainAction::ImportDocument,
            NoteMainRequest::ExportDocument { format } => {
                if !matches!(format.as_str(), "markdown" | "pdf") { return Err("workspace-note-export-format-invalid".into()); }
                NoteMainAction::ExportDocument { format, content: content.into(), title: document.summary.title }
            },
            NoteMainRequest::RenameTag { review } => {
                if review.notes.is_empty() || review.notes.len() > MAX_REVIEW_NOTES || review.id.len() != 64 { return Err("workspace-note-tag-review-invalid".into()); }
                NoteMainAction::RenameTag { review }
            },
            NoteMainRequest::ManageKnowledge { section } => {
                if !matches!(section.as_str(), "vaults" | "settings" | "folders" | "attachments") { return Err("workspace-note-management-section-invalid".into()); }
                let authority = crate::workspace_notes_metadata::authority_for(scope, &reference)?;
                NoteMainAction::ManageKnowledge { vault_id: authority.vault_id, source_id: authority.source_id, section }
            },
        };
        let mut state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        if !state.handler.as_ref().is_some_and(|handler| handler.expires > Instant::now() && handler.kinds.contains(action.kind())) { return Err("workspace-note-main-handler-unavailable".into()); }
        state.entries.retain(|_, entry| entry.expires > Instant::now());
        let owner = (caller.into(), view.id.clone());
        if state.latest.get(&owner).is_some_and(|latest| *latest >= correlation.request_id) { return Err("workspace-note-action-superseded".into()); }
        if (!state.latest.contains_key(&owner) && state.latest.len() >= 256) || state.entries.len() >= 64 { return Err("workspace-note-action-capacity".into()); }
        state.entries.retain(|_, entry| entry.caller != caller || entry.context.view.id != view.id);
        let entry = NoteActionEntry { id: action_token(), caller: caller.into(), context: NoteExecutionContext { caller: caller.into(), scope: scope.clone(), view: view.clone(), correlation: correlation.clone(), content: content.into(), action }, identity, expires: Instant::now() + ACTION_TTL, claim: None, executed: false, result: None };
        let receipt = entry.receipt();
        state.latest.insert(owner, correlation.request_id); state.entries.insert(entry.id.clone(), entry);
        Ok(receipt)
    }
    pub(crate) fn pending(&self, caller: &str) -> Result<Vec<NoteActionOffer>, String> {
        main_only(caller)?;
        let mut state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        state.entries.retain(|_, entry| entry.expires > Instant::now());
        let Some(handler) = state.handler.as_ref().filter(|handler| handler.expires > Instant::now()) else { return Ok(vec![]); };
        Ok(state.entries.values().filter(|entry| entry.claim.is_none() && entry.result.is_none() && handler.kinds.contains(entry.context.action.kind())).map(|entry| NoteActionOffer { id: entry.id.clone(), title: entry.context.view.title.clone(), view_id: entry.context.view.id.clone() }).collect())
    }
    pub(crate) fn claim(&self, caller: &str, id: &str, mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>) -> Result<NoteActionClaim, String> {
        main_only(caller)?;
        let mut state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        let entry = state.entries.get(id).ok_or("workspace-note-action-expired")?;
        if !state.handler.as_ref().is_some_and(|handler| handler.expires > Instant::now() && handler.kinds.contains(entry.context.action.kind())) { return Err("workspace-note-main-handler-unavailable".into()); }
        let entry = state.entries.get_mut(id).ok_or("workspace-note-action-expired")?;
        if entry.claim.is_some() || entry.result.is_some() { return Err("workspace-note-action-already-claimed".into()); }
        entry.validate(&mut live)?;
        let claim_token = action_token(); entry.claim = Some(claim_token.clone());
        let authority = crate::workspace_notes_metadata::authority_for(&entry.context.scope, &reference_for(&entry.context.view)?)?;
        let source = NoteActionSource { view_id: entry.context.view.id.clone(), vault_id: authority.vault_id, source_id: authority.source_id, title: entry.context.view.title.clone() };
        Ok(NoteActionClaim { id: id.into(), claim_token, remaining_ms: entry.expires.saturating_duration_since(Instant::now()).as_millis() as u64, action: entry.context.action.clone(), source })
    }
    pub(crate) fn validate(&self, caller: &str, id: &str, claim: &str, mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>) -> Result<NoteExecutionContext, String> {
        main_only(caller)?;
        let state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        Self::require_handler(&state, id)?;
        let entry = state.entries.get(id).ok_or("workspace-note-action-expired")?;
        if entry.claim.as_deref() != Some(claim) || entry.result.is_some() || entry.executed { return Err("workspace-note-action-claim-invalid".into()); }
        entry.validate(&mut live)?;
        Ok(entry.context.clone())
    }
    /// Invoke after a picker/review returns. Revalidates before the synchronous
    /// native operation. Never hold this lock while an OS dialog is open.
    pub(crate) fn execute_result(&self, caller: &str, id: &str, claim: &str, mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>, execute: impl FnOnce(&NoteExecutionContext) -> Result<NoteActionOutcome, String>) -> Result<NoteActionOutcome, String> {
        main_only(caller)?;
        let mut state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        Self::require_handler(&state, id)?;
        let entry = state.entries.get_mut(id).ok_or("workspace-note-action-expired")?;
        if entry.claim.as_deref() != Some(claim) || entry.result.is_some() || entry.executed { return Err("workspace-note-action-claim-invalid".into()); }
        entry.validate(&mut live)?;
        if matches!(entry.context.action, NoteMainAction::SuggestAi {..} | NoteMainAction::WriteAi {..} | NoteMainAction::ComposeAi {..} | NoteMainAction::OpenTag {..}) { return Err("workspace-note-native-action-invalid".into()); }
        // Mark consumed before calling any native writer. Failed actions also
        // require a fresh user intent, preventing ambiguous replay.
        entry.executed = true;
        let result = execute(&entry.context);
        entry.result = Some(result.clone());
        result
    }
    pub(crate) fn complete(&self, caller: &str, id: &str, claim: &str, completion: NoteMainCompletion, mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>) -> Result<(), String> {
        main_only(caller)?;
        let mut state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        Self::require_handler(&state, id)?;
        let entry = state.entries.get_mut(id).ok_or("workspace-note-action-expired")?;
        if entry.claim.as_deref() != Some(claim) || entry.result.is_some() || entry.executed { return Err("workspace-note-action-claim-invalid".into()); }
        entry.validate(&mut live)?;
        let result = match completion {
            NoteMainCompletion::Cancelled {} => Err("workspace-note-action-cancelled".into()),
            NoteMainCompletion::Failed { code } => { if code.is_empty() || code.len() > 160 || code.chars().any(char::is_control) { return Err("workspace-note-result-invalid".into()); } Err(code) },
            NoteMainCompletion::Suggestion { summary, tags } if matches!(entry.context.action, NoteMainAction::SuggestAi {..}) => {
                if summary.as_ref().is_some_and(|summary| summary.len() > 16 * 1024) { return Err("workspace-note-result-limit".into()); }
                Ok(NoteActionOutcome::Suggestion { summary, tags: normalize_tags(&tags)? })
            },
            NoteMainCompletion::ReplaceRange { selection, text } => {
                let NoteMainAction::WriteAi { action, selection: expected, .. } = &entry.context.action else { return Err("workspace-note-result-kind-invalid".into()); };
                let expected = if action == "continue" { NoteSelection { start: expected.start, end: expected.start } } else { *expected };
                if selection != expected || text.len() > MAX_CONTENT { return Err("workspace-note-result-invalid".into()); }
                Ok(NoteActionOutcome::ReplaceRange { selection, text })
            },
            NoteMainCompletion::Acknowledged { message } if matches!(entry.context.action, NoteMainAction::ManageKnowledge {..} | NoteMainAction::ComposeAi {..} | NoteMainAction::OpenTag {..}) => {
                if message.as_ref().is_some_and(|message| message.len() > 512) { return Err("workspace-note-result-limit".into()); }
                Ok(NoteActionOutcome::Acknowledged { message })
            },
            // Picker/export/rename success is recorded only by execute_result.
            _ => return Err("workspace-note-native-execution-required".into()),
        };
        entry.result = Some(result); Ok(())
    }
    pub(crate) fn status(&self, caller: &str, id: &str, mut live: impl FnMut(&str, &ViewGrant, &ActionCorrelation) -> Result<(), String>) -> Result<NoteActionStatus, String> {
        let state = self.state.lock().map_err(|_| "workspace-note-action-lock")?;
        let entry = state.entries.get(id).ok_or("workspace-note-action-expired")?;
        if entry.caller != caller { return Err("workspace-note-action-owner-mismatch".into()); }
        entry.validate(&mut live)?;
        let result = entry.result.as_ref().map(|result| match result { Ok(value) => NoteActionResult::Success { ok: true, value: value.clone() }, Err(message) => NoteActionResult::Failure { ok: false, code: "unavailable", message: message.clone() } });
        Ok(NoteActionStatus { receipt: entry.receipt(), state: if result.is_some() { "completed" } else { "pending" }, result })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(content: &str) -> (tempfile::TempDir, KnowledgeService, ViewGrant, ActionCorrelation) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        std::fs::create_dir_all(root.join("folder")).unwrap();
        let registration = crate::knowledge::KnowledgeVaultRegistration { id: "vault".into(), name: "Fixture".into(), root_path: root.to_string_lossy().into(), mode: "vault-bound".into(), created_at: "2026-10-06T00:00:00Z".into(), last_opened_at: "2026-10-06T00:00:00Z".into(), schema_version: 1, link_update_policy: Default::default() };
        std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        std::fs::write(root.join("folder/Note.md"), content).unwrap();
        let global = KnowledgeService::initialize(temp.path().join("app")).unwrap();
        global.register_current_vault(&registration).unwrap();
        let scope = global.capture_workspace_scope("vault").unwrap();
        let view = ViewGrant { id: "view".into(), kind: "note".into(), title: "Note".into(), library_id: "vault".into(), resource_id: Some("folder/Note.md".into()) };
        let revision = scope.read_document(&reference_for(&view).unwrap()).unwrap().revision;
        (temp, scope, view, ActionCorrelation { request_id: 1, revision, generation: 0 })
    }
    #[test]
    fn exact_source_content_and_utf16_selection_are_required() {
        let (_temp, scope, view, correlation) = fixture("# Note\n\n😀");
        assert!(validate_note(&scope, &view, &correlation, "forged").is_err());
        let mut forged = view.clone(); forged.library_id = "other".into();
        assert!(validate_note(&scope, &forged, &correlation, "# Note\n\n😀").is_err());
        assert!(validate_selection("😀", NoteSelection { start: 0, end: 1 }).is_err());
        assert!(validate_selection("😀", NoteSelection { start: 1, end: 1 }).is_err());
        assert!(validate_selection("😀", NoteSelection { start: 0, end: 2 }).is_ok());
    }
    #[test]
    fn ai_tag_application_merges_current_frontmatter_and_rejects_empty_selection() {
        let content="---\ntags: [keep]\n---\n\n# Note";let(_temp,scope,view,correlation)=fixture(content);
        assert!(merge_tags(&scope,&view,&correlation,content,&[]).is_err());
        let saved=merge_tags(&scope,&view,&correlation,content,&["new".into()]).unwrap();
        let index=scope.refresh_index().unwrap();let current=index.documents.iter().find(|document|document.document_ref==saved.summary.document_ref).unwrap();
        assert!(current.frontmatter_tags.contains(&"keep".into()));assert!(current.frontmatter_tags.contains(&"new".into()));
    }
    #[test]
    fn mounted_handler_claim_owner_and_result_kind_are_enforced() {
        let (_temp, scope, view, correlation) = fixture("# Note");
        let store = NoteActionStore::default();
        assert!(store.enqueue("child", &scope, &view, &correlation, "# Note", NoteMainRequest::WriteAi { action: "rewrite".into(), selection: NoteSelection { start: 0, end: 6 } }).is_err());
        assert!(store.register_main("child", &["writeAi".into()]).is_err());
        store.register_main("main", &["writeAi".into()]).unwrap();
        let receipt = store.enqueue("child", &scope, &view, &correlation, "# Note", NoteMainRequest::WriteAi { action: "rewrite".into(), selection: NoteSelection { start: 0, end: 6 } }).unwrap();
        assert!(store.claim("child", &receipt.id, |_, _, _| Ok(())).is_err());
        let claim = store.claim("main", &receipt.id, |_, _, _| Ok(())).unwrap();
        assert!(store.claim("main", &receipt.id, |_, _, _| Ok(())).is_err());
        assert!(store.complete("main", &receipt.id, &claim.claim_token, NoteMainCompletion::Acknowledged { message: None }, |_, _, _| Ok(())).is_err());
        assert!(store.status("other-child", &receipt.id, |_, _, _| Ok(())).is_err());
        store.complete("main", &receipt.id, &claim.claim_token, NoteMainCompletion::ReplaceRange { selection: NoteSelection { start: 0, end: 6 }, text: "# New".into() }, |_, _, _| Ok(())).unwrap();
        let result = serde_json::to_value(store.status("child", &receipt.id, |_, _, _| Ok(())).unwrap()).unwrap();
        assert_eq!(result["state"], "completed"); assert_eq!(result["result"]["ok"], true);
        assert_eq!(result["result"]["value"]["kind"], "replace-range");
        store.remove_view("child", "view");
        assert!(store.status("child", &receipt.id, |_, _, _| Ok(())).is_err());
    }
    #[test]
    fn handler_expiry_and_external_edit_revoke_pending_execution() {
        let (temp, scope, view, correlation) = fixture("# Note");
        let store = NoteActionStore::default();
        store.register_main("main", &["pickAttachment".into()]).unwrap();
        let receipt = store.enqueue("child", &scope, &view, &correlation, "# Note", NoteMainRequest::PickAttachment { selection: NoteSelection { start: 6, end: 6 } }).unwrap();
        let claim = store.claim("main", &receipt.id, |_, _, _| Ok(())).unwrap();
        store.state.lock().unwrap().handler.as_mut().unwrap().expires = Instant::now();
        assert!(store.validate("main", &receipt.id, &claim.claim_token, |_, _, _| Ok(())).is_err());
        store.register_main("main", &["pickAttachment".into()]).unwrap();
        std::fs::write(temp.path().join("vault/folder/Note.md"), "changed").unwrap();
        assert!(store.execute_result("main", &receipt.id, &claim.claim_token, |_, _, _| Ok(()), |_| panic!("must not execute stale intent")).is_err());
    }
    #[test]
    fn references_are_candidates_only_and_export_preserves_bytes() {
        let content = "\u{feff}# Note\r\n\r\n![[image.png]]\r\n[file](document.pdf)\r\n`![[secret.png]]`\r\n";
        let (_temp, scope, view, correlation) = fixture(content);
        let saved = scope.read_document(&reference_for(&view).unwrap()).unwrap();
        let references = list_current_references(&scope, &view, &correlation, &saved.content).unwrap();
        assert_eq!(references.len(), 2);
        assert!(!references.iter().any(|reference| reference.destination == "secret.png"));
        assert_eq!(export_markdown(&scope, &view, &correlation, &saved.content).unwrap().bytes, content.as_bytes());
    }
    #[test]
    fn tag_review_binds_exact_targets_and_requires_main_selection() {
        let content = "---\ntags: [old]\n---\n# Note";
        let (temp, scope, view, correlation) = fixture(content);
        std::fs::write(temp.path().join("vault/Other.md"), "---\ntags: [old]\n---\n# Other").unwrap();
        let reviews = WorkspaceNoteActions::default();
        let review = reviews.prepare_tag_rename("child", &scope, &view, &correlation, content, "old", "new").unwrap();
        assert_eq!(review.scope, "frontmatter-only"); assert_eq!(review.notes.len(), 2);
        assert!(reviews.commit_tag_rename("child", &review.id, &[review.notes[0].document_id.clone()], |_, _, _| Ok(())).is_err());
        assert!(reviews.commit_tag_rename("main", &review.id, &["forged".into()], |_, _, _| Ok(())).is_err());
        assert!(reviews.commit_tag_rename("main", &review.id, &[review.notes[0].document_id.clone()], |_, _, _| Err("closed".into())).is_err());
        reviews.remove_view("child", "view");
        assert!(reviews.commit_tag_rename("main", &review.id, &[review.notes[0].document_id.clone()], |_, _, _| Ok(())).is_err());
    }
    #[test]
    #[cfg(windows)]
    fn scoped_create_and_attachment_never_accept_a_destination_path() {
        let (temp, scope, view, correlation) = fixture("# Note");
        let created = create_note(&scope, &view, &correlation, "# Note", "Sibling", "new note").unwrap();
        assert_eq!(created.summary.document_ref.relative_path, "folder/Sibling.md");
        assert!(create_note(&scope, &view, &correlation, "# Note", "../Outside", "no").is_err());
        assert!(import_attachment(&scope, &view, &correlation, "# Note", "../secret.png", b"file").is_err());
        let imported = import_attachment(&scope, &view, &correlation, "# Note", "picked.png", b"file").unwrap();
        assert_eq!(std::fs::read(temp.path().join("vault").join(&imported.identity)).unwrap(), b"file");
        assert_eq!(imported.identity, "attachments/picked.png");
    }
}
