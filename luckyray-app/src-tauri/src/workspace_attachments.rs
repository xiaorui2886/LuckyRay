//! Opaque attachment capabilities for registered workspace child webviews.
//! The URI never accepts a path, label, view, or revision. Tauri supplies caller
//! identity. Every use rechecks the live view, saved note, reference and bytes.
use crate::workspace_windows::{ViewGrant, WorkspaceWindows};
use crate::knowledge::{KnowledgeService, KnowledgeTargetIdentity};
use crate::workspace_actions::ActionCorrelation;
use crate::workspace_note_actions::WorkspaceAttachmentImport;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use tauri::{http::{header, Method, Request, Response, StatusCode}, Manager};

const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_TOKENS_PER_WINDOW: usize = 256;
const MAX_TOKENS: usize = 12 * MAX_TOKENS_PER_WINDOW;
const MAX_ATTACHMENT_BYTES: usize = 64 * 1024 * 1024;
const DENIED: &str = "workspace-attachment-denied";

/// Both production modes must load this exact CSP-bearing entry. A same-origin
/// navigation to Main's index would otherwise remove the child-only policy.
pub(crate) const CHILD_ENTRY: &str = "workspace-child.html#workspace";
pub(crate) fn child_navigation_allowed(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    if url.path() != "/workspace-child.html" || url.fragment() != Some("workspace")
        || url.query().is_some() || !url.username().is_empty() || url.password().is_some() { return false; }
    if let Some(dev_url) = dev_url { return url.origin() == dev_url.origin(); }
    matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")))
}

/// Debug-only fixture route uses the identical CSP and source renderer tests;
/// production spawn never selects it without the separate fixture identity.
pub(crate) fn fixture_navigation_allowed(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    if !cfg!(all(debug_assertions, feature = "workspace-runtime-fixture")) { return false; }
    if url.path() != "/tests/fixtures/workspace-native-child.html" || url.fragment() != Some("workspace")
        || url.query().is_some() || !url.username().is_empty() || url.password().is_some() { return false; }
    if let Some(dev_url) = dev_url { return url.origin() == dev_url.origin(); }
    matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")))
}

#[derive(Clone)]
struct Grant {
    label: String,
    view: ViewGrant,
    source: KnowledgeTargetIdentity,
    revision: String,
    destination: String,
    wiki: bool,
    digest: String,
    identity: String,
    mime: &'static str,
    kind: &'static str,
    expires: Instant,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AttachmentBaseline { view: ViewGrant, references: Vec<(String, bool, String)> }
impl AttachmentBaseline {
    pub(crate) fn valid_for(&self, view: &ViewGrant) -> bool {
        self.view == *view && view.kind == "note" && self.references.len() <= 256 && self.references.iter().all(|(destination, _, identity)| {
            !destination.is_empty() && destination.len() <= 8192 && !destination.contains(['\0', '\r', '\n'])
                && !identity.is_empty() && identity.len() <= 4096 && !identity.contains(['\\', ':', '\0', '\r', '\n'])
                && identity.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        })
    }
    pub(crate) fn for_view(mut self, view: &ViewGrant) -> Result<Self, String> {
        if self.view.kind != view.kind || self.view.library_id != view.library_id || self.view.resource_id != view.resource_id { return Err(DENIED.into()); }
        self.view = view.clone(); Ok(self)
    }
    fn allows(&self, view: &ViewGrant, destination: &str, wiki: bool, identity: &str) -> bool {
        self.view == *view && self.references.iter().any(|(allowed, syntax, path)| allowed == destination && *syntax == wiki && path == identity)
    }
}
#[derive(Default)]
pub(crate) struct WorkspaceAttachments {
    grants: Mutex<HashMap<String, Grant>>,
    baselines: Mutex<HashMap<String, AttachmentBaseline>>,
    read_gate: Mutex<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentToken {
    status: &'static str,
    token: String,
    version: String,
    media_kind: &'static str,
    expires_in_ms: u64,
}

impl WorkspaceAttachments {
    pub(crate) fn outgoing_baseline(&self, caller: &str, view: &ViewGrant, service: &crate::knowledge::KnowledgeService) -> Result<AttachmentBaseline, String> {
        if let Some(baseline) = self.saved_baseline(caller, view)? { return Ok(baseline); }
        if caller == "main" {
            let reference = crate::knowledge::KnowledgeDocumentRef { vault_id: view.library_id.clone(), relative_path: view.resource_id.clone().ok_or(DENIED)? };
            let references = service.workspace_attachment_references(&reference).map_err(|_| DENIED)?;
            let baseline = AttachmentBaseline { view: view.clone(), references };
            self.register_baseline("main", baseline.clone())?;
            return Ok(baseline);
        }
        // Legacy recovery still permits document transfer but never derives
        // attachment authority from content that a child could have written.
        Ok(AttachmentBaseline { view: view.clone(), references: vec![] })
    }
    pub(crate) fn saved_baseline(&self, label: &str, view: &ViewGrant) -> Result<Option<AttachmentBaseline>, String> {
        let baselines = self.baselines.lock().map_err(|_| DENIED)?;
        match baselines.get(&format!("{label}/{}", view.id)) {
            Some(baseline) if baseline.valid_for(view) => Ok(Some(baseline.clone())),
            Some(_) => Err(DENIED.into()), None => Ok(None),
        }
    }
    pub(crate) fn register_baseline(&self, label: &str, baseline: AttachmentBaseline) -> Result<(), String> {
        if !baseline.valid_for(&baseline.view) { return Err(DENIED.into()); }
        self.baselines.lock().map_err(|_| DENIED)?.insert(format!("{label}/{}", baseline.view.id), baseline);
        Ok(())
    }
    /// Only a native publication result may add authority. The source content
    /// is checked for equality, never scanned for additional attachment grants.
    pub(crate) fn add_publication(
        &self, label: &str, view: &ViewGrant, scope: &KnowledgeService,
        correlation: &ActionCorrelation, content: &str, imported: &WorkspaceAttachmentImport,
    ) -> Result<(), String> {
        let _read = self.read_gate.lock().map_err(|_| DENIED)?;
        let (reference, expected, _) = crate::workspace_note_actions::validate_note(scope, view, correlation, content)?;
        let links = crate::knowledge::companion_attachment_links(&imported.publication.markdown);
        if imported.identity != imported.publication.relative_path || links.len() != 1
            || links[0].destination != imported.destination
            || (links[0].syntax == crate::knowledge::CompanionLinkSyntax::Wiki) != imported.wiki {
            return Err("workspace-note-publication-invalid".into());
        }
        scope.with_workspace_attachment_publication(&expected, &reference, &correlation.revision, content, &imported.publication, || {
            let mut baselines = self.baselines.lock().map_err(|_| DENIED)?;
            let key = format!("{label}/{}", view.id);
            let mut baseline = baselines.get(&key).cloned().unwrap_or_else(|| AttachmentBaseline { view: view.clone(), references: vec![] });
            if !baseline.valid_for(view) { return Err(DENIED.into()); }
            if let Some((_, _, identity)) = baseline.references.iter().find(|(destination, wiki, _)| destination == &imported.destination && *wiki == imported.wiki) {
                // An import cannot retarget an already granted link to a new object.
                if identity != &imported.identity { return Err(DENIED.into()); }
                return Ok(());
            }
            baseline.references.push((imported.destination.clone(), imported.wiki, imported.identity.clone()));
            if !baseline.valid_for(view) { return Err("workspace-attachment-reference-limit".into()); }
            baselines.insert(key, baseline);
            Ok(())
        })
    }

    /// A same-parent native rename preserves link resolution. Carry only the
    /// original mapping into the renamed view and revoke every prior token.
    pub(crate) fn rebind_after_rename(
        &self, label: &str, old_view: &ViewGrant, new_view: &ViewGrant,
        scope: &KnowledgeService, new_revision: &str,
    ) -> Result<(), String> {
        let _read = self.read_gate.lock().map_err(|_| DENIED)?;
        let old_reference = crate::workspace_note_actions::reference_for(old_view)?;
        let new_reference = crate::workspace_note_actions::reference_for(new_view)?;
        let parent = |path: &str| path.rsplit_once('/').map(|(parent, _)| parent.to_owned()).unwrap_or_default();
        if old_view.id != new_view.id || old_reference.vault_id != new_reference.vault_id
            || parent(&old_reference.relative_path) != parent(&new_reference.relative_path)
            || new_revision.is_empty() || new_revision.len() > 128 {
            return Err(DENIED.into());
        }
        let expected = scope.current_target_identity().map_err(crate::knowledge_error)?;
        scope.with_workspace_action_document_path(&expected, &new_reference, new_revision, |_| {
            let mut baselines = self.baselines.lock().map_err(|_| DENIED)?;
            let key = format!("{label}/{}", old_view.id);
            let mut baseline = baselines.get(&key).cloned().unwrap_or_else(|| AttachmentBaseline { view: old_view.clone(), references: vec![] });
            if !baseline.valid_for(old_view) { return Err(DENIED.into()); }
            baseline.view = new_view.clone();
            if !baseline.valid_for(new_view) { return Err(DENIED.into()); }
            let mut grants = self.grants.lock().map_err(|_| DENIED)?;
            grants.retain(|_, grant| grant.label != label || grant.view.id != old_view.id);
            baselines.insert(key, baseline);
            Ok(())
        })
    }
    fn expected_reference(&self, caller: &str, view: &ViewGrant, destination: &str, wiki: bool) -> Result<String, String> {
        self.baselines.lock().map_err(|_| DENIED)?.get(&format!("{caller}/{}", view.id))
            .filter(|baseline| baseline.view == *view)
            .and_then(|baseline| baseline.references.iter().find(|(allowed, syntax, _)| allowed == destination && *syntax == wiki))
            .map(|(_, _, identity)| identity.clone()).ok_or_else(|| "workspace-attachment-main-grant-required".into())
    }
    fn authorize_reference(&self, caller: &str, view: &ViewGrant, destination: &str, wiki: bool, identity: &str) -> Result<(), String> {
        if self.baselines.lock().map_err(|_| DENIED)?.get(&format!("{caller}/{}", view.id))
            .is_some_and(|baseline| baseline.allows(view, destination, wiki, identity)) { return Ok(()); }
        Err("workspace-attachment-main-grant-required".into())
    }
    pub(crate) fn remove_view(&self,label:&str,view_id:&str){
        if let Ok(mut grants)=self.grants.lock(){grants.retain(|_,grant|grant.label!=label||grant.view.id!=view_id);}
        if let Ok(mut baselines)=self.baselines.lock(){baselines.remove(&format!("{label}/{view_id}"));}
    }
    pub(crate) fn remove_window(&self, label: &str) {
        if let Ok(mut grants) = self.grants.lock() { grants.retain(|_, grant| grant.label != label); }
        if let Ok(mut baselines) = self.baselines.lock() { baselines.retain(|key, _| !key.starts_with(&format!("{label}/"))); }
    }

    fn insert(&self, mut grant: Grant, now: Instant) -> Result<AttachmentToken, String> {
        let mut grants = self.grants.lock().map_err(|_| DENIED)?;
        grants.retain(|_, previous| previous.expires > now);
        // A refresh may reuse a token only for the identical caller/view/note/
        // reference/bytes. It does not silently extend authority after a save.
        let existing = grants.iter().find(|(_, previous)| previous.label == grant.label && previous.view == grant.view && previous.source == grant.source
            && previous.revision == grant.revision && previous.destination == grant.destination
            && previous.wiki == grant.wiki && previous.digest == grant.digest && previous.identity == grant.identity).map(|(token, _)| token.clone());
        if existing.is_none() && (grants.len() >= MAX_TOKENS || grants.values().filter(|previous| previous.label == grant.label).count() >= MAX_TOKENS_PER_WINDOW) {
            return Err("workspace-attachment-token-limit".into());
        }
        let token = existing.unwrap_or_else(|| format!("{:032x}{:032x}", rand::random::<u128>(), rand::random::<u128>()));
        grant.expires = now + TOKEN_TTL;
        let result = AttachmentToken { status: "resolved", token: token.clone(), version: grant.digest.clone(), media_kind: grant.kind, expires_in_ms: TOKEN_TTL.as_millis() as u64 };
        grants.insert(token, grant);
        Ok(result)
    }

    fn get(&self, token: &str, caller: &str, now: Instant) -> Result<Grant, String> {
        let mut grants = self.grants.lock().map_err(|_| DENIED)?;
        grants.retain(|_, grant| grant.expires > now);
        grants.get(token).filter(|grant| grant.label == caller).cloned().ok_or_else(|| DENIED.into())
    }
}

fn media_type(extension: &str) -> Option<(&'static str, &'static str)> {
    Some(match extension {
        "png" => ("image/png", "image"), "jpg" | "jpeg" => ("image/jpeg", "image"),
        "gif" => ("image/gif", "image"), "webp" => ("image/webp", "image"),
        "avif" => ("image/avif", "image"), "bmp" => ("image/bmp", "image"),
        "svg" => ("image/svg+xml", "image"), "ico" => ("image/x-icon", "image"),
        "mp4" | "m4v" => ("video/mp4", "video"), "webm" => ("video/webm", "video"),
        "mov" => ("video/quicktime", "video"), "mkv" => ("video/x-matroska", "video"),
        "mp3" => ("audio/mpeg", "audio"), "wav" => ("audio/wav", "audio"),
        "ogg" | "oga" => ("audio/ogg", "audio"), "m4a" => ("audio/mp4", "audio"),
        "flac" => ("audio/flac", "audio"), "aac" => ("audio/aac", "audio"),
        _ => return None,
    })
}

fn attachment_type(extension: &str) -> Result<(&'static str, &'static str), String> {
    if extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown") {
        return Err("workspace-attachment-markdown-unsupported".into());
    }
    Ok(media_type(extension).unwrap_or(("application/octet-stream", "file")))
}

pub(crate) fn issue(registry: &WorkspaceWindows, caller: &str, view_id: &str, revision: &str, destination: &str, wiki: bool) -> Result<AttachmentToken, String> {
    let _read = registry.attachments.read_gate.lock().map_err(|_| DENIED)?;
    let (view, service) = registry.attachment_scope(caller, view_id)?;
    let source = service.current_target_identity().map_err(crate::knowledge_error)?;
    let reference = crate::knowledge::KnowledgeDocumentRef { vault_id: view.library_id.clone(), relative_path: view.resource_id.clone().ok_or(DENIED)? };
    let target = destination.split(['#', '?', '|']).next().unwrap_or_default();
    attachment_type(std::path::Path::new(target).extension().and_then(|extension| extension.to_str()).unwrap_or_default())?;
    let allowed_identity = registry.attachments.expected_reference(caller, &view, destination, wiki)?;
    let (bytes, extension, identity) = service.read_workspace_attachment(&reference, revision, destination, wiki, &allowed_identity)
        .map_err(|failure| match failure.code {
            "workspace-attachment-not-referenced" => "workspace-attachment-save-reference-first".to_owned(),
            _ => DENIED.to_owned(),
        })?;
    registry.attachments.authorize_reference(caller, &view, destination, wiki, &identity)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES { return Err(DENIED.into()); }
    let (mime, kind) = attachment_type(&extension)?;
    registry.attachments.insert(Grant { label: caller.into(), view, source, revision: revision.into(), destination: destination.into(), wiki,
        digest: format!("{:x}", Sha256::digest(&bytes)), identity, mime, kind, expires: Instant::now() }, Instant::now())
}

/// The renderer supplies only an opaque capability. The captured service holds
/// the root, saved source and attachment until the synchronous OS handoff ends.
pub(crate) fn open_token(
    registry: &WorkspaceWindows, caller: &str, view_id: &str, revision: &str, token: &str,
) -> Result<(), String> {
    let _read = registry.attachments.read_gate.lock().map_err(|_| DENIED)?;
    let grant = registry.attachments.get(token, caller, Instant::now())?;
    if grant.view.id != view_id || grant.revision != revision { return Err(DENIED.into()); }
    let (view, service) = registry.attachment_scope(caller, view_id)?;
    if view != grant.view { return Err(DENIED.into()); }
    registry.attachments.authorize_reference(caller, &view, &grant.destination, grant.wiki, &grant.identity)?;
    let reference = crate::workspace_note_actions::reference_for(&view)?;
    let expected = service.current_target_identity().map_err(crate::knowledge_error)?;
    if expected != grant.source { return Err(DENIED.into()); }
    service.with_workspace_attachment_open_path(&expected, &reference, revision, &grant.destination, grant.wiki, &grant.identity, &grant.digest, |path| {
        // Recheck revocation and exact live scope immediately before invoking
        // the opener. No path is returned to or accepted from the renderer.
        registry.attachments.get(token, caller, Instant::now())?;
        let (live_view, live_scope) = registry.attachment_scope(caller, &grant.view.id)?;
        if live_view != grant.view || !service.same_workspace_attachment_source(&live_scope) { return Err(DENIED.into()); }
        registry.attachments.authorize_reference(caller, &view, &grant.destination, grant.wiki, &grant.identity)?;
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|_| "workspace-attachment-open-failed".into())
    })
}

fn uri_token(uri: &tauri::http::Uri) -> Option<&str> {
    if uri.query().is_some() { return None; }
    match (uri.scheme_str()?, uri.host()?) {
        ("workspace-attachment", "localhost") | ("http" | "https", "workspace-attachment.localhost") => (),
        _ => return None,
    }
    let token = uri.path().strip_prefix('/')?;
    (token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))).then_some(token)
}

/// One byte range only. Explicit bounds, suffix ranges and open-ended ranges are
/// supported for ordinary media seeking; malformed/multiple ranges fail closed.
fn byte_range(value: Option<&str>, length: usize) -> Result<Option<(usize, usize)>, ()> {
    let Some(value) = value else { return Ok(None); };
    if length == 0 { return Err(()); }
    let (start, end) = value.strip_prefix("bytes=").ok_or(())?.split_once('-').ok_or(())?;
    let number = |value: &str| -> Result<usize, ()> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { return Err(()); }
        value.parse::<usize>().map_err(|_| ())
    };
    if start.is_empty() {
        let count = number(end)?;
        if count == 0 { return Err(()); }
        return Ok(Some((length.saturating_sub(count), length - 1)));
    }
    let start = number(start)?;
    let end = if end.is_empty() { length - 1 } else { number(end)?.min(length - 1) };
    if start >= length || end < start { return Err(()); }
    Ok(Some((start, end)))
}

fn response(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder().status(status).header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .body(body).expect("static workspace response headers")
}

pub(crate) fn serve(app: &tauri::AppHandle, caller: &str, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(registry) = app.try_state::<WorkspaceWindows>() else { return response(StatusCode::NOT_FOUND, vec![]); };
    let _read = match registry.attachments.read_gate.lock() { Ok(read) => read, Err(_) => return response(StatusCode::NOT_FOUND, vec![]) };
    let result = (|| -> Result<_, String> {
        if request.method() != Method::GET && request.method() != Method::HEAD { return Err(DENIED.into()); }
        if !request.body().is_empty() { return Err(DENIED.into()); }
        let token = uri_token(request.uri()).ok_or(DENIED)?;
        let grant = registry.attachments.get(token, caller, Instant::now())?;
        // No request header or URI field supplies caller/view authority.
        let (view, service) = registry.attachment_scope(caller, &grant.view.id)?;
        if view != grant.view { return Err(DENIED.into()); }
        if service.current_target_identity().map_err(crate::knowledge_error)? != grant.source { return Err(DENIED.into()); }
        let reference = crate::knowledge::KnowledgeDocumentRef { vault_id: view.library_id.clone(), relative_path: view.resource_id.clone().ok_or(DENIED)? };
        registry.attachments.authorize_reference(caller, &view, &grant.destination, grant.wiki, &grant.identity)?;
        let (bytes, extension, identity) = service.read_workspace_attachment(&reference, &grant.revision, &grant.destination, grant.wiki, &grant.identity).map_err(|_| DENIED)?;
        registry.attachments.authorize_reference(caller, &view, &grant.destination, grant.wiki, &identity)?;
        if bytes.len() > MAX_ATTACHMENT_BYTES || format!("{:x}", Sha256::digest(&bytes)) != grant.digest || media_type(&extension) != Some((grant.mime, grant.kind)) { return Err(DENIED.into()); }
        // Closed/transferred tabs and destroyed windows lose already issued tokens.
        let (live_view, live_scope) = registry.attachment_scope(caller, &grant.view.id)?;
        if live_view != grant.view || !service.same_workspace_attachment_source(&live_scope) { return Err(DENIED.into()); }
        Ok((grant, bytes))
    })();
    let Ok((grant, bytes)) = result else { return response(StatusCode::NOT_FOUND, vec![]); };
    let length = bytes.len();
    let range = match request.headers().get(header::RANGE).map(|value| value.to_str()).transpose() {
        Ok(value) => byte_range(value, length), Err(_) => Err(()),
    };
    let Ok(range) = range else {
        let mut result = response(StatusCode::RANGE_NOT_SATISFIABLE, vec![]);
        result.headers_mut().insert(header::CONTENT_RANGE, format!("bytes */{length}").parse().unwrap());
        return result;
    };
    let (status, body_length) = range.map(|(start, end)| (StatusCode::PARTIAL_CONTENT, end - start + 1)).unwrap_or((StatusCode::OK, length));
    let body = if request.method() == Method::HEAD { vec![] } else if let Some((start, end)) = range { bytes[start..=end].to_vec() } else { bytes };
    let mut result = response(status, body);
    let headers = result.headers_mut();
    headers.insert(header::CONTENT_TYPE, grant.mime.parse().unwrap());
    headers.insert(header::CONTENT_LENGTH, body_length.to_string().parse().unwrap());
    headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    headers.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Accept-Ranges, Content-Range, Content-Length".parse().unwrap());
    if let Some((start, end)) = range { headers.insert(header::CONTENT_RANGE, format!("bytes {start}-{end}/{length}").parse().unwrap()); }
    // This enables same-child fetch as well as media elements. CORS is not the
    // authorization check: trusted Tauri caller identity above is mandatory.
    if let Some(origin) = app.get_webview_window(caller).and_then(|window| window.url().ok()).map(|url| url.origin().ascii_serialization()) {
        if let Ok(origin) = origin.parse() { headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin); }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn note_fixture(content: &str) -> (tempfile::TempDir, KnowledgeService, ViewGrant, ActionCorrelation) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::create_dir_all(root.join("attachments")).unwrap();
        let registration = crate::knowledge::KnowledgeVaultRegistration { id: "vault".into(), name: "Fixture".into(), root_path: root.to_string_lossy().into(), mode: "vault-bound".into(), created_at: "2026-10-06T00:00:00Z".into(), last_opened_at: "2026-10-06T00:00:00Z".into(), schema_version: 1, link_update_policy: Default::default() };
        std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        std::fs::write(root.join("folder/Note.md"), content).unwrap();
        std::fs::write(root.join("picture.png"), b"original").unwrap();
        std::fs::write(root.join("secret.png"), b"not-granted").unwrap();
        std::fs::write(root.join("attachments/picked.png"), b"picked-by-main").unwrap();
        let service = KnowledgeService::initialize(temp.path().join("app")).unwrap();
        service.register_current_vault(&registration).unwrap();
        let scope = service.capture_workspace_scope("vault").unwrap();
        let view = ViewGrant { id: "note-one".into(), kind: "note".into(), library_id: "vault".into(), resource_id: Some("folder/Note.md".into()), title: "Note".into() };
        let revision = scope.read_document(&crate::workspace_note_actions::reference_for(&view).unwrap()).unwrap().revision;
        (temp, scope, view, ActionCorrelation { request_id: 1, revision, generation: 0 })
    }
    fn imported() -> WorkspaceAttachmentImport {
        let bytes = b"picked-by-main";
        WorkspaceAttachmentImport {
            publication: crate::knowledge::AttachmentPublication { relative_path: "attachments/picked.png".into(), markdown: "![[attachments/picked.png]]".into(), sha256: format!("{:x}", Sha256::digest(bytes)), bytes: bytes.len() as u64, reused: false },
            destination: "attachments/picked.png".into(), wiki: true, identity: "attachments/picked.png".into(),
        }
    }
    fn grant(now: Instant) -> Grant {
        Grant { label: "workspace-one".into(), view: ViewGrant { id: "note-one".into(), kind: "note".into(), library_id: "vault".into(), resource_id: Some("one.md".into()), title: "Note".into() }, source: KnowledgeTargetIdentity { target_id: "target".into(), identity_digest: "root-identity".into(), label: "Vault".into() }, revision: "revision".into(), destination: "image.png".into(), wiki: true, digest: "digest".into(), identity: "image.png".into(), mime: "image/png", kind: "image", expires: now }
    }
    #[test]
    fn child_cannot_expand_baseline_by_saving_new_links_or_changing_resolution() {
        let registry = WorkspaceAttachments::default(); let view = grant(Instant::now()).view;
        registry.register_baseline("workspace-one", AttachmentBaseline { view: view.clone(), references: vec![("image.png".into(), true, "original/image.png".into())] }).unwrap();
        assert!(registry.authorize_reference("workspace-one", &view, "image.png", true, "original/image.png").is_ok());
        for (destination, wiki, identity) in [("secret.png", true, "secret.png"), ("image.png", true, "other/image.png"), ("image.png", false, "original/image.png")] {
            assert!(registry.authorize_reference("workspace-one", &view, destination, wiki, identity).is_err());
        }
        assert!(registry.authorize_reference("workspace-two", &view, "image.png", true, "original/image.png").is_err());
        let mut forged_view = view.clone(); forged_view.id = "other".into();
        assert!(registry.authorize_reference("workspace-one", &forged_view, "image.png", true, "original/image.png").is_err());
    }
    #[test]
    fn native_publication_adds_only_its_exact_verified_identity() {
        let content = "# Note\n![[picture.png]]\n![[secret.png]]";
        let (_temp, scope, view, correlation) = note_fixture(content);
        let registry = WorkspaceAttachments::default();
        registry.register_baseline("workspace-one", AttachmentBaseline { view: view.clone(), references: vec![("picture.png".into(), true, "picture.png".into())] }).unwrap();
        let publication = imported();
        registry.add_publication("workspace-one", &view, &scope, &correlation, content, &publication).unwrap();
        registry.add_publication("workspace-one", &view, &scope, &correlation, content, &publication).unwrap();
        let baseline = registry.saved_baseline("workspace-one", &view).unwrap().unwrap();
        assert_eq!(baseline.references.len(), 2);
        assert!(baseline.allows(&view, "picture.png", true, "picture.png"));
        assert!(baseline.allows(&view, &publication.destination, publication.wiki, &publication.identity));
        assert!(!baseline.allows(&view, "secret.png", true, "secret.png"));
        assert!(registry.expected_reference("workspace-two", &view, &publication.destination, true).is_err());
    }
    #[test]
    fn changed_source_or_forged_publication_cannot_add_authority() {
        let (temp, scope, view, correlation) = note_fixture("# Note");
        let registry = WorkspaceAttachments::default();
        let original = imported();
        assert!(registry.add_publication("workspace-one", &view, &scope, &correlation, "forged", &original).is_err());
        let mut wrong_revision = correlation.clone(); wrong_revision.revision = "stale".into();
        assert!(registry.add_publication("workspace-one", &view, &scope, &wrong_revision, "# Note", &original).is_err());
        for field in ["identity", "destination", "syntax", "markdown", "hash", "bytes"] {
            let mut forged = original.clone();
            match field {
                "identity" => forged.identity = "secret.png".into(),
                "destination" => forged.destination = "secret.png".into(),
                "syntax" => forged.wiki = false,
                "markdown" => forged.publication.markdown.push_str("\n![[secret.png]]"),
                "hash" => forged.publication.sha256 = "0".repeat(64),
                "bytes" => forged.publication.bytes += 1,
                _ => unreachable!(),
            }
            assert!(registry.add_publication("workspace-one", &view, &scope, &correlation, "# Note", &forged).is_err(), "{field}");
        }
        assert!(registry.saved_baseline("workspace-one", &view).unwrap().is_none());
        std::fs::write(temp.path().join("vault/attachments/picked.png"), b"changed-file").unwrap();
        assert!(registry.add_publication("workspace-one", &view, &scope, &correlation, "# Note", &original).is_err());
    }
    #[test]
    fn publication_cannot_retarget_an_existing_baseline_reference() {
        let (_temp, scope, view, correlation) = note_fixture("# Note");
        let registry = WorkspaceAttachments::default();
        let publication = imported();
        registry.register_baseline("workspace-one", AttachmentBaseline { view: view.clone(), references: vec![(publication.destination.clone(), publication.wiki, "previous/picked.png".into())] }).unwrap();
        assert!(registry.add_publication("workspace-one", &view, &scope, &correlation, "# Note", &publication).is_err());
        assert_eq!(registry.expected_reference("workspace-one", &view, &publication.destination, true).unwrap(), "previous/picked.png");
    }
    #[test]
    fn rename_preserves_mapping_revokes_tokens_and_never_rescans_note() {
        let content = "# Note\n![[picture.png]]\n![[secret.png]]";
        let (temp, scope, view, correlation) = note_fixture(content);
        let registry = WorkspaceAttachments::default();
        registry.register_baseline("workspace-one", AttachmentBaseline { view: view.clone(), references: vec![("picture.png".into(), true, "picture.png".into())] }).unwrap();
        let now = Instant::now(); let mut old_grant = grant(now); old_grant.view = view.clone();
        let token = registry.insert(old_grant, now).unwrap().token;
        let mut renamed = view.clone(); renamed.resource_id = Some("folder/Renamed.md".into()); renamed.title = "Renamed".into();
        std::fs::rename(temp.path().join("vault/folder/Note.md"), temp.path().join("vault/folder/Renamed.md")).unwrap();
        registry.rebind_after_rename("workspace-one", &view, &renamed, &scope, &correlation.revision).unwrap();
        assert!(registry.get(&token, "workspace-one", Instant::now()).is_err());
        assert!(registry.saved_baseline("workspace-one", &view).is_err());
        let baseline = registry.saved_baseline("workspace-one", &renamed).unwrap().unwrap();
        assert_eq!(baseline.references, vec![("picture.png".into(), true, "picture.png".into())]);
        assert!(registry.expected_reference("workspace-one", &renamed, "secret.png", true).is_err());
        let other = WorkspaceAttachments::default();
        other.rebind_after_rename("workspace-one", &view, &renamed, &scope, &correlation.revision).unwrap();
        assert!(other.saved_baseline("workspace-one", &renamed).unwrap().unwrap().references.is_empty());
    }
    #[test]
    fn rename_rejects_changed_view_source_parent_or_revision() {
        let (_temp, scope, view, correlation) = note_fixture("# Note");
        let registry = WorkspaceAttachments::default();
        for field in ["view", "vault", "parent", "kind"] {
            let mut changed = view.clone();
            match field {
                "view" => changed.id = "other".into(),
                "vault" => changed.library_id = "other".into(),
                "parent" => changed.resource_id = Some("other/Note.md".into()),
                "kind" => changed.kind = "graph".into(),
                _ => unreachable!(),
            }
            assert!(registry.rebind_after_rename("workspace-one", &view, &changed, &scope, &correlation.revision).is_err(), "{field}");
        }
        assert!(registry.rebind_after_rename("workspace-one", &view, &view, &scope, "stale").is_err());
    }
    #[test]
    fn tokens_are_caller_bound_expiring_and_repeatable_for_media_ranges() {
        let registry = WorkspaceAttachments::default(); let now = Instant::now();
        let token = registry.insert(grant(now), now).unwrap().token;
        for caller in ["main", "workspace-forged", "workspace-two", ""] { assert!(registry.get(&token, caller, now).is_err()); }
        assert!(registry.get("forged", "workspace-one", now).is_err());
        assert!(registry.get(&token, "workspace-one", now).is_ok());
        assert!(registry.get(&token, "workspace-one", now + Duration::from_secs(1)).is_ok());
        assert!(registry.get(&token, "workspace-one", now + TOKEN_TTL).is_err());
    }
    #[test]
    fn per_window_token_count_is_bounded_and_expired_tokens_release_capacity() {
        let registry = WorkspaceAttachments::default(); let now = Instant::now();
        for index in 0..MAX_TOKENS_PER_WINDOW {
            let mut current = grant(now); current.destination = format!("{index}.png");
            registry.insert(current, now).unwrap();
        }
        let mut extra = grant(now); extra.destination = "extra.png".into();
        assert!(registry.insert(extra.clone(), now).is_err());
        assert!(registry.insert(extra, now + TOKEN_TTL).is_ok());
    }
    #[test]
    fn issue_identity_changes_do_not_reuse_tokens_and_close_revokes() {
        let registry = WorkspaceAttachments::default(); let now = Instant::now();
        let original = grant(now); let token = registry.insert(original.clone(), now).unwrap().token;
        assert_eq!(registry.insert(original.clone(), now).unwrap().token, token);
        let mut changed = original.clone(); changed.view.id = "other-view".into();
        assert_ne!(registry.insert(changed, now).unwrap().token, token);
        let mut changed = original.clone(); changed.source.identity_digest = "replacement-root".into();
        assert_ne!(registry.insert(changed, now).unwrap().token, token);
        let mut changed = original; changed.revision = "new-revision".into();
        assert_ne!(registry.insert(changed, now).unwrap().token, token);
        registry.remove_window("workspace-one"); assert!(registry.get(&token, "workspace-one", now).is_err());
    }
    #[test]
    fn arbitrary_paths_queries_and_hosts_are_not_capabilities() {
        let valid = "a".repeat(64);
        for base in ["workspace-attachment://localhost", "http://workspace-attachment.localhost", "https://workspace-attachment.localhost"] {
            assert_eq!(uri_token(&format!("{base}/{valid}").parse().unwrap()), Some(valid.as_str()));
            for suffix in ["/etc/passwd", "/../image.png", "/%2fsecret", "/a?viewId=forged", "/a?label=main"] { assert!(uri_token(&format!("{base}{suffix}").parse().unwrap()).is_none()); }
        }
        assert!(uri_token(&format!("workspace-attachment://forged/{valid}").parse().unwrap()).is_none());
        assert!(uri_token(&format!("workspace-attachment://localhost/{valid}?path=secret").parse().unwrap()).is_none());
    }
    #[test]
    fn range_requests_are_bounded_and_malformed_ranges_are_rejected() {
        assert_eq!(byte_range(None, 10), Ok(None));
        assert_eq!(byte_range(Some("bytes=0-3"), 10), Ok(Some((0, 3))));
        assert_eq!(byte_range(Some("bytes=5-"), 10), Ok(Some((5, 9))));
        assert_eq!(byte_range(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(byte_range(Some("bytes=0-999"), 10), Ok(Some((0, 9))));
        for range in ["bytes=10-", "bytes=4-2", "bytes=-0", "bytes=0-1,3-4", "bytes=+1-2", "bytes=184467440737095516160-", "items=0-1", "bytes=-"] { assert!(byte_range(Some(range), 10).is_err()); }
        assert!(byte_range(Some("bytes=0-0"), 0).is_err());
    }
    #[test]
    fn child_navigation_cannot_escape_its_csp_entry_in_dev_or_packaged_mode() {
        let dev: tauri::Url = "http://localhost:1420".parse().unwrap();
        assert!(child_navigation_allowed(&"http://localhost:1420/workspace-child.html#workspace".parse().unwrap(), Some(&dev)));
        for url in ["http://localhost:1420/index.html#workspace", "http://localhost:1420/", "http://localhost:1420/workspace-child.html", "http://localhost:1420/workspace-child.html#main", "http://localhost:1420/workspace-child.html?entry=main#workspace", "http://attacker.invalid:1420/workspace-child.html#workspace", "data:text/html,hello", "file:///workspace-child.html#workspace"] {
            assert!(!child_navigation_allowed(&url.parse().unwrap(), Some(&dev)), "{url}");
        }
        for base in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
            assert!(child_navigation_allowed(&format!("{base}/workspace-child.html#workspace").parse().unwrap(), None));
            assert!(!child_navigation_allowed(&format!("{base}/index.html#workspace").parse().unwrap(), None));
        }
        assert!(!child_navigation_allowed(&"https://attacker.invalid/workspace-child.html#workspace".parse().unwrap(), None));
        assert!(!child_navigation_allowed(&"asset://localhost/workspace-child.html#workspace".parse().unwrap(), None));
    }
    #[test]
    fn active_document_types_are_not_served() { for extension in ["html", "js", "md", "json", "pdf", "txt"] { assert!(media_type(extension).is_none()); } }
    #[test]
    fn nonmedia_tokens_are_opener_only_and_markdown_is_unsupported() {
        for extension in ["pdf", "txt", "docx", "zip", "html", "js", "json", ""] {
            assert_eq!(attachment_type(extension).unwrap(), ("application/octet-stream", "file"));
            assert!(media_type(extension).is_none());
        }
        for extension in ["md", "MD", "markdown", "MARKDOWN"] {
            assert_eq!(attachment_type(extension).unwrap_err(), "workspace-attachment-markdown-unsupported");
        }
        assert_eq!(attachment_type("png").unwrap(), ("image/png", "image"));
    }
}
