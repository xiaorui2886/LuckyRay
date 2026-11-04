//! Read-only, schema-specific projection of the desktop's canonical canvas.
//!
//! No HTTP handler, generic RPC, URL fetcher, filesystem-path resolver or save
//! endpoint lives here. `prepare` resolves only explicit `asset:<id>` / legacy media-card asset-ID references
//! in known canvas fields, through the supplied, already-authorized catalog.
//! `project` itself is pure. Keep `CanvasProjection` native-side and serialize
//! ONLY `display_document()`. Unknown data, provider configuration and original
//! media identities stay in the raw canonical snapshot, never in browser JSON.
//!
//! Integration contract: validate the existing canvas session and read grant
//! under the gateway transition fence before prepare/open/restore; construct a
//! session from that validated cookie and CanvasSessionBinding. Use the existing
//! request-scoped MaterialCatalog, never for_attachment_projection or a catalog
//! search across libraries. Revocation/expiry must close in-flight streams too.
//! Read raw canonical JSON under the existing canvas lock, alongside its normal
//! revision/digest validation. Do not reconstruct raw JSON from CanvasDocument:
//! that type does not preserve unknown top-level fields. Unchanged restore is
//! not write authorization or CAS; it deliberately rejects EVERY browser edit.
//!
//! Unimported generated output (including ComfyUI), remote/data/blob URLs, note
//! attachments and unbound paths are unavailable in this first read-only slice.
//! A path merely appearing in JSON never creates file-reading authority.

use super::canvas_sessions::CanvasSessionBinding;
use crate::materials::{MaterialAsset, MaterialCatalog};
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use zeroize::Zeroizing;

const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_VALUES: usize = 200_000;
const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 5_000;
const MAX_EDGES: usize = 10_000;
const MAX_HISTORY: usize = 4_096;
const MAX_REFERENCES: usize = 64;
const MAX_MEDIA_ITEMS: usize = 64;
const MAX_ASSETS: usize = 512;
const MAX_TEXT: usize = 64 * 1024;
const MAX_TIMESTAMP_BYTES: usize = 64;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SOURCE: usize = 16 * 1024;
const MEDIA_PREFIX: &str = "/canvas/media/";

type Object = Map<String, Value>;
type Result<T> = std::result::Result<T, ProjectionError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProjectionError {
    InvalidDocument,
    UnsupportedSchema,
    TooLarge,
    SessionChanged,
    CanonicalChanged,
    ReadOnly,
    MediaUnavailable,
}

/// Native-only identity; neither Debug nor Serialize may expose the cookie key.
pub(super) struct CanvasMediaSession {
    binding: CanvasSessionBinding,
    key: Zeroizing<[u8; 32]>,
}
impl CanvasMediaSession {
    /// This validates syntax, NOT authentication. The gateway must first call
    /// its current CanvasSessions::validate and verify the live canvas grant.
    pub(super) fn from_validated_session(
        binding: CanvasSessionBinding,
        cookie: &str,
    ) -> Result<Self> {
        if !hex_id(cookie) || binding.device_id.is_empty() || binding.desktop_instance.is_empty()
            || binding.device_id.len() > 128 || binding.desktop_instance.len() > 128
        {
            return Err(ProjectionError::SessionChanged);
        }
        let mut hash = Sha256::new();
        hash.update(b"luckyray-canvas-media-session-v1\0");
        hash.update(cookie.as_bytes());
        Ok(Self { binding, key: Zeroizing::new(hash.finalize().into()) })
    }
    fn same(&self, other: &Self) -> bool {
        self.binding == other.binding && self.key.as_ref() == other.key.as_ref()
    }
    fn copy_native(&self) -> Self {
        Self { binding: self.binding.clone(), key: Zeroizing::new(*self.key) }
    }
    fn media_id(&self, canvas_id: &str, source: &CatalogSource) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.key.as_ref())
            .expect("SHA256 HMAC accepts a 32-byte key");
        let generation = self.binding.gateway_generation.to_string();
        let permission_revision = self.binding.permission_revision.to_string();
        for field in [
            "luckyray-canvas-media-v1", &self.binding.device_id,
            &self.binding.desktop_instance, &generation,
            &permission_revision, canvas_id, &source.asset_id,
            if source.thumbnail { "thumbnail" } else { "original" }, &source.revision,
        ] {
            mac.update(&(field.len() as u64).to_be_bytes());
            mac.update(field.as_bytes());
        }
        format!("{:x}", mac.finalize().into_bytes())
    }
}

#[derive(Clone)]
struct CatalogSource {
    asset_id: String,
    thumbnail: bool,
    revision: String,
    mime: &'static str,
    length: u64,
}

/// Preparation is the only discovery step; no caller-supplied path allowlist.
/// A clone freezes the existing catalog/library context for subsequent reads.
pub(super) struct CanvasMediaContext {
    session: CanvasMediaSession,
    catalog: MaterialCatalog,
    canonical_hash: [u8; 32],
    aliases: HashMap<String, CatalogSource>,
}
impl CanvasMediaContext {
    pub(super) fn prepare(
        canonical: &Value,
        session: &CanvasMediaSession,
        catalog: &MaterialCatalog,
    ) -> Result<Self> {
        validate_document_budget(canonical)?;
        let ids = referenced_asset_ids(canonical)?;
        let mut context = Self {
            session: session.copy_native(), catalog: catalog.clone(),
            canonical_hash: value_hash(canonical)?, aliases: HashMap::new(),
        };
        // An unavailable catalog must not hide a readable canvas's text/layout.
        // It grants zero media, not a fallback to a different/active library.
        let Ok(scope) = catalog.library_scope_key() else { return Ok(context); };
        let Ok(catalog) = catalog.for_library(&scope) else { return Ok(context); };
        context.catalog = catalog.clone();
        for id in ids {
            // Ordinary material ownership/visibility excludes note attachments.
            // Missing, wrong-library, deleted or non-media assets stay null.
            let Ok(asset) = catalog.get_ordinary_export_asset(&id) else { continue; };
            if !matches!(asset.kind.as_str(), "image" | "video" | "audio") { continue; }
            let Ok((opened, file)) = catalog.companion_resource(&id, false) else { continue; };
            if opened != asset { continue; }
            let Ok(source) = describe_source(&catalog, &opened, file, false) else { continue; };
            let Some(path) = served_local_path(&asset) else { continue; };
            context.add_alias(path, &source);
            context.add_alias(&format!("asset:{id}"), &source);
            if asset.kind == "video" && !asset.thumbnail_url.is_empty() {
                if let Ok((opened, file)) = catalog.companion_resource(&id, true) {
                    if opened == asset {
                        if let Ok(source) = describe_source(&catalog, &opened, file, true) {
                            // The database spelling is only an alias. Actual reads
                            // still use companion_resource's fixed thumbnail root.
                            context.add_alias(&asset.thumbnail_url, &source);
                        }
                    }
                }
            }
            // Image thumbnails are the original catalog-owned image. Never
            // grant an unrelated database thumbnail URL its own path authority.
            if asset.kind == "image" && local_alias(&asset.thumbnail_url) == local_alias(path) {
                context.add_alias(&asset.thumbnail_url, &source);
            }
        }
        Ok(context)
    }
    fn add_alias(&mut self, raw: &str, source: &CatalogSource) {
        if let Some(alias) = local_alias(raw) {
            // A source spelling shared by ambiguous catalog records fails closed.
            if self.aliases.get(&alias).is_some_and(|previous|
                previous.asset_id != source.asset_id || previous.thumbnail != source.thumbnail)
            {
                self.aliases.insert(alias, CatalogSource {
                    asset_id: String::new(), thumbnail: false, revision: String::new(),
                    mime: "", length: 0,
                });
            } else {
                self.aliases.insert(alias, source.clone());
            }
        }
    }
}

/// Native-only holder. Export only the explicit display-document accessor.
pub(super) struct CanvasProjection {
    display: Value,
    canonical: Value,
    session: CanvasMediaSession,
    catalog: MaterialCatalog,
    sources: HashMap<String, CatalogSource>,
    unavailable_media: usize,
}
/// A file handle obtained through catalog authority, never from browser input.
/// The eventual HTTP handler must use a fixed MIME, nosniff, no-store, bounded
/// range/streaming logic, and the existing revocation fence/socket lifecycle.
pub(super) struct CanvasMediaRead {
    pub(super) file: File,
    pub(super) mime: &'static str,
    pub(super) length: u64,
}
impl CanvasProjection {
    pub(super) fn display_document(&self) -> &Value { &self.display }
    pub(super) fn unavailable_media_count(&self) -> usize { self.unavailable_media }
    /// Does not merge browser JSON. Even a changed unknown field or a swapped
    /// opaque media ID is rejected. Original hidden fields and media spellings
    /// are returned byte-value-exactly from the native canonical snapshot.
    pub(super) fn restore_unchanged(&self, session: &CanvasMediaSession, display: &Value) -> Result<Value> {
        if !self.session.same(session) { return Err(ProjectionError::SessionChanged); }
        validate_document_budget(display)?;
        if display != &self.display { return Err(ProjectionError::ReadOnly); }
        Ok(self.canonical.clone())
    }
    pub(super) fn open_media(&self, session: &CanvasMediaSession, id: &str) -> Result<CanvasMediaRead> {
        if !self.session.same(session) { return Err(ProjectionError::SessionChanged); }
        // The caller strips exactly /canvas/media/. No URL/path/query parser.
        if !hex_id(id) { return Err(ProjectionError::MediaUnavailable); }
        let source = self.sources.get(id).ok_or(ProjectionError::MediaUnavailable)?;
        let ordinary = self.catalog.get_ordinary_export_asset(&source.asset_id)
            .map_err(|_| ProjectionError::MediaUnavailable)?;
        let (asset, file) = self.catalog.companion_resource(&source.asset_id, source.thumbnail)
            .map_err(|_| ProjectionError::MediaUnavailable)?;
        if asset != ordinary { return Err(ProjectionError::MediaUnavailable); }
        let current = describe_source(&self.catalog, &asset, file.try_clone()
            .map_err(|_| ProjectionError::MediaUnavailable)?, source.thumbnail)?;
        if current.revision != source.revision || current.mime != source.mime || current.length != source.length {
            return Err(ProjectionError::MediaUnavailable);
        }
        // try_clone shares the cursor on supported platforms; rewind the actual
        // handle before handing it to the bounded/range-serving transport.
        let mut file = file;
        file.seek(SeekFrom::Start(0)).map_err(|_| ProjectionError::MediaUnavailable)?;
        Ok(CanvasMediaRead { file, mime: source.mime, length: source.length })
    }
}

/// Pure bounded projection; prepare must have seen this exact canonical value.
pub(super) fn project(
    canonical: &Value,
    normalized: &crate::canvas_agent::CanvasDocument,
    context: &CanvasMediaContext,
) -> Result<CanvasProjection> {
    validate_document_budget(canonical)?;
    if value_hash(canonical)? != context.canonical_hash { return Err(ProjectionError::CanonicalChanged); }
    // Prove that the validated typed view and retained raw snapshot describe
    // the same canonical file. normalize_document verifies the existing digest;
    // it does not derive a digest from the lossy display projection.
    let parsed: crate::canvas_agent::CanvasDocument = serde_json::from_value(canonical.clone())
        .map_err(|_| ProjectionError::InvalidDocument)?;
    let verified = crate::canvas_agent::normalize_document(parsed)
        .map_err(|_| ProjectionError::InvalidDocument)?;
    if &verified != normalized { return Err(ProjectionError::CanonicalChanged); }
    let root = object(canonical)?;
    let schema = root_field(root, "schemaVersion", "schema_version")?.and_then(Value::as_u64).unwrap_or(2);
    if !(1..=2).contains(&schema) { return Err(ProjectionError::UnsupportedSchema); }
    let canvas_id = root_field(root, "canvasId", "canvas_id")?.and_then(Value::as_str)
        .filter(|v| plain_id(v)).ok_or(ProjectionError::InvalidDocument)?;
    let mut projector = Projector { context, canvas_id, sources: HashMap::new(), unavailable: 0 };
    let mut display = Object::new();
    display.insert("remoteProjectionVersion".into(), json!(1));
    display.insert("schemaVersion".into(), json!(schema));
    display.insert("canvasId".into(), json!(canvas_id));
    let name = root.get("name").and_then(Value::as_str).ok_or(ProjectionError::InvalidDocument)?;
    if name.len() > MAX_TEXT { return Err(ProjectionError::TooLarge); }
    display.insert("name".into(), json!(name));
    for (out, stored) in [("createdAt", "created_at"), ("updatedAt", "updated_at")] {
        let timestamp = root_field(root, out, stored)?.and_then(Value::as_str)
            .filter(|value| rfc3339_timestamp(value)).ok_or(ProjectionError::InvalidDocument)?;
        display.insert(out.into(), json!(timestamp));
    }
    // Legacy missing revision/digest use only the existing validated desktop
    // normalization defaults. Never silently omit a required browser field.
    if normalized.revision > MAX_JS_SAFE_INTEGER || !hex_id(&normalized.content_digest) {
        return Err(ProjectionError::InvalidDocument);
    }
    display.insert("revision".into(), json!(normalized.revision));
    display.insert("contentDigest".into(), json!(normalized.content_digest));
    display.insert("nodes".into(), Value::Array(required_array(root.get("nodes"), MAX_NODES)?.iter()
        .map(|node| projector.node(node)).collect::<Result<_>>()?));
    display.insert("edges".into(), Value::Array(required_array(root.get("edges"), MAX_EDGES)?.iter()
        .map(|edge| projector.edge(edge)).collect::<Result<_>>()?));
    let mut viewport = Object::new();
    copy_numbers(object(root.get("viewport").ok_or(ProjectionError::InvalidDocument)?)?, &mut viewport, &["x", "y", "zoom"]);
    if viewport.len() != 3 || !viewport.get("zoom").and_then(Value::as_f64).is_some_and(|zoom| zoom > 0.0) {
        return Err(ProjectionError::InvalidDocument);
    }
    display.insert("viewport".into(), Value::Object(viewport));
    display.insert("generationHistory".into(), Value::Array(array(root_field(root, "generationHistory", "generation_history")?, MAX_HISTORY)?.iter()
        .map(|item| projector.history(item)).collect::<Result<_>>()?));
    display.insert("remoteUnavailableMediaCount".into(), json!(projector.unavailable));
    let display = Value::Object(display);
    validate_display_contract(&display)?;
    validate_document_budget(&display)?;
    Ok(CanvasProjection { display, canonical: canonical.clone(), session: context.session.copy_native(),
        catalog: context.catalog.clone(), sources: projector.sources, unavailable_media: projector.unavailable })
}

struct Projector<'a> {
    context: &'a CanvasMediaContext,
    canvas_id: &'a str,
    sources: HashMap<String, CatalogSource>,
    unavailable: usize,
}
impl Projector<'_> {
    fn media(&mut self, value: &Value) -> Value {
        if value.is_null() || value.as_str() == Some("") { return Value::Null; }
        let source = value.as_str().and_then(local_alias).and_then(|alias| self.context.aliases.get(&alias))
            .filter(|source| !source.asset_id.is_empty());
        if let Some(source) = source {
            let id = self.context.session.media_id(self.canvas_id, source);
            self.sources.insert(id.clone(), source.clone());
            json!(format!("{MEDIA_PREFIX}{id}"))
        } else {
            self.unavailable += 1;
            Value::Null
        }
    }
    fn media_fields(&mut self, source: &Object, out: &mut Object, keys: &[&str]) {
        for key in keys { if let Some(value) = source.get(*key) { out.insert((*key).into(), self.media(value)); } }
    }
    fn media_items(&mut self, value: Option<&Value>) -> Result<Value> {
        Ok(Value::Array(array(value, MAX_MEDIA_ITEMS)?.iter().map(|item| {
            let item = object(item)?;
            let mut result = Object::new();
            self.media_fields(item, &mut result, &["url", "thumbnailUrl"]);
            Ok(Value::Object(result))
        }).collect::<Result<_>>()?))
    }
    fn references(&mut self, value: Option<&Value>) -> Result<Value> {
        Ok(Value::Array(array(value, MAX_REFERENCES)?.iter().map(|item| {
            let item = object(item)?;
            let mut result = Object::new();
            copy_ids(item, &mut result, &["id", "sourceNodeId", "mentionKey"]);
            copy_text(item, &mut result, &["label", "text"])?;
            copy_enum(item, &mut result, "kind", &["image", "video", "audio", "text", "note", "noteRef"]);
            copy_enum(item, &mut result, "role", EDGE_ROLES);
            copy_enum(item, &mut result, "issue", &["invalid-source", "missing-source", "missing-media"]);
            self.media_fields(item, &mut result, &["mediaUrl", "thumbnailUrl"]);
            Ok(Value::Object(result))
        }).collect::<Result<_>>()?))
    }
    fn request(&mut self, value: &Value) -> Result<Value> {
        let input = object(value)?;
        let mut out = Object::new();
        copy_enum(input, &mut out, "kind", &["text", "image", "video"]);
        copy_text(input, &mut out, &["prompt", "sourcePrompt", "model", "aspect", "quality", "resolution"])?;
        copy_numbers(input, &mut out, &["duration", "count", "cameraStrength"]);
        copy_bools(input, &mut out, &["sound"]);
        out.insert("references".into(), self.references(input.get("references"))?);
        // comfyui, editor extensions, profiles, account pools and unknown
        // provider-specific request fields are native-only, not recursively copied.
        Ok(Value::Object(out))
    }
    fn task(&mut self, value: &Value) -> Result<Value> {
        let input = object(value)?;
        let mut out = Object::new();
        copy_ids(input, &mut out, &["id", "parentTaskId", "sourceNodeId", "resultNodeId"]);
        copy_timestamps(input, &mut out, &["createdAt", "updatedAt"])?;
        copy_numbers(input, &mut out, &["version", "attempt", "progress"]);
        copy_enum(input, &mut out, "status", STATUSES);
        copy_enum(input, &mut out, "providerStage", &["submitting", "queued", "generating", "downloading"]);
        out.insert("adapter".into(), Value::Null);
        out.insert("error".into(), if input.get("error").is_some_and(|v| !v.is_null()) {
            json!({"code":"REMOTE_DETAIL_UNAVAILABLE","message":"请在桌面查看生成详情","retryable":false})
        } else { Value::Null });
        if let Some(request) = input.get("request").filter(|v| !v.is_null()) { out.insert("request".into(), self.request(request)?); }
        Ok(Value::Object(out))
    }
    fn history(&mut self, value: &Value) -> Result<Value> {
        let input = object(value)?;
        let mut out = Object::new();
        copy_ids(input, &mut out, &["id", "taskId", "parentTaskId", "sourceNodeId", "resultNodeId"]);
        copy_timestamps(input, &mut out, &["createdAt", "updatedAt"])?;
        copy_numbers(input, &mut out, &["version", "attempt", "duration", "progress"]);
        copy_enum(input, &mut out, "kind", &["text", "image", "video"]);
        copy_enum(input, &mut out, "status", STATUSES);
        copy_text(input, &mut out, &["prompt", "model", "aspect", "quality", "resolution", "outputText"])?;
        self.media_fields(input, &mut out, &["outputMediaUrl", "outputThumbnailUrl"]);
        if input.contains_key("outputMediaItems") { out.insert("outputMediaItems".into(), self.media_items(input.get("outputMediaItems"))?); }
        if let Some(request) = input.get("request").filter(|v| !v.is_null()) { out.insert("request".into(), self.request(request)?); }
        if input.get("errorMessage").is_some() || input.get("errorDetail").is_some() || input.get("errorCode").is_some() {
            out.insert("errorCode".into(), json!("REMOTE_DETAIL_UNAVAILABLE"));
            out.insert("errorMessage".into(), json!("请在桌面查看生成详情"));
            out.insert("errorRetryable".into(), json!(false));
        }
        Ok(Value::Object(out))
    }
    fn provenance(&mut self, value: &Value) -> Result<Value> {
        let input = object(value)?;
        let mut out = Object::new();
        copy_numbers(input, &mut out, &["version"]);
        copy_ids(input, &mut out, &["historyId", "taskId"]);
        copy_timestamps(input, &mut out, &["createdAt"])?;
        copy_enum(input, &mut out, "kind", &["image", "video"]);
        if let Some(request) = input.get("request").filter(|v| !v.is_null()) { out.insert("request".into(), self.request(request)?); }
        Ok(Value::Object(out))
    }
    fn shot(&mut self, value: &Value, node_id: &str) -> Result<Value> {
        let input = object(value)?;
        let mut out = Object::new();
        copy_numbers(input, &mut out, &["version", "order", "durationSeconds"]);
        copy_text(input, &mut out, &["title", "description", "lighting", "sound", "cameraMovement", "action", "dialogue"])?;
        copy_enum(input, &mut out, "framing", &["wide", "full", "medium", "close", "detail"]);
        if let Some(value) = input.get("chosenResult").filter(|v| !v.is_null()) {
            let chosen = object(value)?;
            let mut result = Object::new();
            copy_ids(chosen, &mut result, &["taskId", "historyId"]);
            copy_timestamps(chosen, &mut result, &["selectedAt"])?;
            copy_enum(chosen, &mut result, "kind", &["image", "video"]);
            self.media_fields(chosen, &mut result, &["url", "thumbnailUrl"]);
            if let (Some(kind), Some(url)) = (result.get("kind").and_then(Value::as_str), result.get("url").and_then(Value::as_str)) {
                // storyboardCandidates.keyFor includes its media URL. Re-derive
                // from the display identity instead of leaking its original key.
                let key = json!([node_id, kind, url]).to_string();
                result.insert("key".into(), json!(key));
            }
            out.insert("chosenResult".into(), Value::Object(result));
        }
        Ok(Value::Object(out))
    }
    fn node(&mut self, value: &Value) -> Result<Value> {
        let input = object(value)?;
        let data = object(input.get("data").ok_or(ProjectionError::InvalidDocument)?)?;
        let mut out = Object::new();
        copy_ids(input, &mut out, &["id", "parentId"]);
        if !out.contains_key("id") { return Err(ProjectionError::InvalidDocument); }
        out.insert("type".into(), json!(if data.get("kind").and_then(Value::as_str) == Some("group") { "group" } else { "spike" }));
        copy_enum(input, &mut out, "extent", &["parent"]);
        copy_numbers(input, &mut out, &["width", "height", "zIndex"]);
        copy_bools(input, &mut out, &["hidden"]);
        let mut position = Object::new();
        copy_numbers(object(input.get("position").ok_or(ProjectionError::InvalidDocument)?)?, &mut position, &["x", "y"]);
        if position.len() != 2 { return Err(ProjectionError::InvalidDocument); }
        out.insert("position".into(), Value::Object(position));
        // Never forward arbitrary CSS/style, HTML, event handlers or class names.
        if let Some(style) = input.get("style").and_then(Value::as_object) {
            let mut safe = Object::new(); copy_numbers(style, &mut safe, &["width", "height"]);
            out.insert("style".into(), Value::Object(safe));
        }
        let mut safe = Object::new();
        copy_enum(data, &mut safe, "kind", &["text", "image", "video", "noteRef", "aiPrompt", "aiResult", "generator", "group"]);
        if !safe.contains_key("kind") { return Err(ProjectionError::UnsupportedSchema); }
        copy_enum(data, &mut safe, "role", &["resource", "editable", "generator", "result", "container"]);
        for key in ["resultKind", "generationKind", "refKind"] { copy_enum(data, &mut safe, key, &["text", "image", "video", "audio", "note"]); }
        copy_enum(data, &mut safe, "generationSource", &["online", "comfyui"]);
        copy_ids(data, &mut safe, &["derivedFromNodeId", "sourceGenerationTaskId", "sourceGenerationHistoryId"]);
        copy_timestamps(data, &mut safe, &["refUpdatedAt"])?;
        copy_text(data, &mut safe, &["label", "result", "refSummary", "refContextText", "generationPrompt", "generationModel", "generationAspect", "generationQuality", "generationResolution"])?;
        safe.entry("label").or_insert_with(|| json!(""));
        // Payload is user text only on text/prompt cards; elsewhere preserve only
        // recognized object identity, never an untyped path-bearing payload.
        if matches!(data.get("kind").and_then(Value::as_str), Some("text" | "aiPrompt")) {
            copy_text(data, &mut safe, &["payload"])?;
        } else if let Some(payload) = data.get("payload").and_then(Value::as_str)
            .filter(|v| asset_id(v).is_some() || v.strip_prefix("note:").is_some_and(plain_id)
                || matches!(data.get("kind").and_then(Value::as_str), Some("image" | "video")) && plain_id(v)) {
            safe.insert("payload".into(), json!(payload));
        }
        copy_numbers(data, &mut safe, &["capabilitiesVersion", "generationDuration", "generationCount", "generationCameraStrength", "groupMemberCount"]);
        copy_bools(data, &mut safe, &["labelIsCustom", "_manualSize", "_emptyMedia", "generationSound"]);
        self.media_fields(data, &mut safe, &["refMediaUrl", "refThumbnailUrl", "resultMediaUrl", "resultThumbnailUrl", "sourceGenerationMediaUrl"]);
        if data.contains_key("resultMediaItems") { safe.insert("resultMediaItems".into(), self.media_items(data.get("resultMediaItems"))?); }
        if data.contains_key("generationReferences") { safe.insert("generationReferences".into(), self.references(data.get("generationReferences"))?); }
        if let Some(value) = data.get("generationTask").filter(|v| !v.is_null()) { safe.insert("generationTask".into(), self.task(value)?); }
        if let Some(value) = data.get("materialGenerationProvenance").filter(|v| !v.is_null()) { safe.insert("materialGenerationProvenance".into(), self.provenance(value)?); }
        if let Some(value) = data.get("storyboardShot").filter(|v| !v.is_null()) { safe.insert("storyboardShot".into(), self.shot(value, out["id"].as_str().ok_or(ProjectionError::InvalidDocument)?)?); }
        if let Some(value) = data.get("storyboard").and_then(Value::as_object) {
            let mut board = Object::new(); copy_numbers(value, &mut board, &["version"]);
            copy_text(value, &mut board, &["sourceScript"])?; safe.insert("storyboard".into(), Value::Object(board));
        }
        out.insert("data".into(), Value::Object(safe));
        Ok(Value::Object(out))
    }
    fn edge(&mut self, value: &Value) -> Result<Value> {
        let input = object(value)?;
        let mut out = Object::new();
        copy_ids(input, &mut out, &["id", "source", "target", "sourceHandle", "targetHandle"]);
        if !["id", "source", "target"].iter().all(|key| out.contains_key(*key)) { return Err(ProjectionError::InvalidDocument); }
        copy_enum(input, &mut out, "type", &["default", "straight", "step", "smoothstep", "simplebezier"]);
        copy_bools(input, &mut out, &["animated", "hidden"]);
        copy_text(input, &mut out, &["label"])?;
        if let Some(data) = input.get("data").and_then(Value::as_object) {
            let mut safe = Object::new();
            copy_enum(data, &mut safe, "role", EDGE_ROLES);
            copy_enum(data, &mut safe, "relation", &["derivation"]);
            copy_numbers(data, &mut safe, &["semanticsVersion", "order"]);
            self.media_fields(data, &mut safe, &["referenceMediaUrl"]);
            out.insert("data".into(), Value::Object(safe));
        }
        Ok(Value::Object(out))
    }
}
const EDGE_ROLES: &[&str] = &["generic", "reference", "promptContext", "firstFrame", "lastFrame", "videoReference"];
const STATUSES: &[&str] = &["queued", "running", "succeeded", "failed", "cancelled"];

fn referenced_asset_ids(value: &Value) -> Result<BTreeSet<String>> {
    let root = object(value)?;
    let mut ids = BTreeSet::new();
    for node in array(root.get("nodes"), MAX_NODES)? {
        let data = object(object(node)?.get("data").ok_or(ProjectionError::InvalidDocument)?)?;
        // Text that happens to contain asset:<id> is not an asset reference.
        if matches!(data.get("kind").and_then(Value::as_str), Some("image" | "video" | "aiResult" | "generator")) {
            add_asset_id(data.get("payload"), &mut ids)?;
            if matches!(data.get("kind").and_then(Value::as_str), Some("image" | "video")) {
                if let Some(id) = data.get("payload").and_then(Value::as_str).filter(|id| plain_id(id)) { ids.insert(id.into()); }
                if ids.len() > MAX_ASSETS { return Err(ProjectionError::TooLarge); }
            }
        }
        reference_asset_ids(data.get("generationReferences"), &mut ids)?;
        for key in ["generationTask", "materialGenerationProvenance"] {
            if let Some(request) = data.get(key).and_then(|v| v.get("request")) {
                reference_asset_ids(request.get("references"), &mut ids)?;
            }
        }
    }
    for item in array(root_field(root, "generationHistory", "generation_history")?, MAX_HISTORY)? {
        if let Some(request) = item.get("request") { reference_asset_ids(request.get("references"), &mut ids)?; }
    }
    Ok(ids)
}
fn reference_asset_ids(value: Option<&Value>, ids: &mut BTreeSet<String>) -> Result<()> {
    for value in array(value, MAX_REFERENCES)? {
        let reference = object(value)?;
        add_asset_id(reference.get("id"), ids)?;
        if matches!(reference.get("kind").and_then(Value::as_str), Some("image" | "video" | "audio")) {
            if let Some(id) = reference.get("id").and_then(Value::as_str).filter(|id| plain_id(id)) { ids.insert(id.into()); }
            if ids.len() > MAX_ASSETS { return Err(ProjectionError::TooLarge); }
        }
    }
    Ok(())
}
fn add_asset_id(value: Option<&Value>, ids: &mut BTreeSet<String>) -> Result<()> {
    if let Some(id) = value.and_then(Value::as_str).and_then(asset_id) { ids.insert(id.into()); }
    if ids.len() > MAX_ASSETS { return Err(ProjectionError::TooLarge); }
    Ok(())
}
fn asset_id(value: &str) -> Option<&str> { value.strip_prefix("asset:").filter(|id| plain_id(id)) }
fn plain_id(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) }
fn identity(value: &str) -> bool { !value.is_empty() && value.len() <= 256 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.')) }
fn hex_id(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn object(value: &Value) -> Result<&Object> { value.as_object().ok_or(ProjectionError::InvalidDocument) }
fn array(value: Option<&Value>, limit: usize) -> Result<&[Value]> {
    match value { None | Some(Value::Null) => Ok(&[]), Some(Value::Array(values)) if values.len() <= limit => Ok(values),
        Some(Value::Array(_)) => Err(ProjectionError::TooLarge), _ => Err(ProjectionError::InvalidDocument) }
}
fn required_array(value: Option<&Value>, limit: usize) -> Result<&[Value]> {
    if !matches!(value, Some(Value::Array(_))) { return Err(ProjectionError::InvalidDocument); }
    array(value, limit)
}
fn rfc3339_timestamp(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_TIMESTAMP_BYTES && value.is_ascii()
        && !value.chars().any(char::is_control)
        && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
fn copy_timestamps(source: &Object, out: &mut Object, keys: &[&str]) -> Result<()> {
    for key in keys {
        if let Some(value) = source.get(*key).filter(|value| !value.is_null()) {
            let timestamp = value.as_str().filter(|value| rfc3339_timestamp(value))
                .ok_or(ProjectionError::InvalidDocument)?;
            out.insert((*key).into(), json!(timestamp));
        }
    }
    Ok(())
}
/// Keep the exported DTO aligned with the existing remote read client's
/// required fields. Invalid source values cause failure, not a partial success.
fn validate_display_contract(value: &Value) -> Result<()> {
    let display = object(value)?;
    let integer = |key: &str| display.get(key).and_then(Value::as_u64)
        .is_some_and(|value| value <= MAX_JS_SAFE_INTEGER);
    let valid = display.get("remoteProjectionVersion") == Some(&json!(1))
        && integer("remoteUnavailableMediaCount") && integer("revision")
        && display.get("schemaVersion").and_then(Value::as_u64).is_some_and(|v| (1..=2).contains(&v))
        && display.get("canvasId").and_then(Value::as_str).is_some_and(plain_id)
        && display.get("name").and_then(Value::as_str).is_some_and(|v| v.len() <= MAX_TEXT)
        && ["createdAt", "updatedAt"].iter().all(|key| display.get(*key).and_then(Value::as_str).is_some_and(rfc3339_timestamp))
        && display.get("contentDigest").and_then(Value::as_str).is_some_and(hex_id)
        && ["nodes", "edges", "generationHistory"].iter().all(|key| display.get(*key).is_some_and(Value::is_array))
        && display.get("viewport").and_then(Value::as_object).is_some_and(|viewport|
            ["x", "y", "zoom"].iter().all(|key| viewport.get(*key).and_then(Value::as_f64).is_some_and(f64::is_finite))
            && viewport.get("zoom").and_then(Value::as_f64).is_some_and(|zoom| zoom > 0.0));
    if valid { Ok(()) } else { Err(ProjectionError::InvalidDocument) }
}
fn root_field<'a>(root: &'a Object, public: &str, stored: &str) -> Result<Option<&'a Value>> {
    match (root.get(public), root.get(stored)) {
        (Some(a), Some(b)) if a != b => Err(ProjectionError::InvalidDocument),
        (Some(a), _) | (_, Some(a)) => Ok(Some(a)), _ => Ok(None),
    }
}
fn copy_text(source: &Object, out: &mut Object, keys: &[&str]) -> Result<()> {
    for key in keys { if let Some(value) = source.get(*key).and_then(Value::as_str) {
        if value.len() > MAX_TEXT { return Err(ProjectionError::TooLarge); }
        // These fields are user-visible prose, not configuration. Do not strip
        // words such as "workflow", paths in prose, URLs, punctuation or Unicode.
        out.insert((*key).into(), json!(value));
    } }
    Ok(())
}
fn copy_ids(source: &Object, out: &mut Object, keys: &[&str]) {
    for key in keys { if let Some(value) = source.get(*key).and_then(Value::as_str).filter(|v| identity(v)) { out.insert((*key).into(), json!(value)); } }
}
fn copy_numbers(source: &Object, out: &mut Object, keys: &[&str]) {
    for key in keys { if let Some(value) = source.get(*key).filter(|v| v.as_f64().is_some_and(|n| n.is_finite() && n.abs() <= 1e15)) { out.insert((*key).into(), value.clone()); } }
}
fn copy_bools(source: &Object, out: &mut Object, keys: &[&str]) {
    for key in keys { if let Some(value) = source.get(*key).filter(|v| v.is_boolean()) { out.insert((*key).into(), value.clone()); } }
}
fn copy_enum(source: &Object, out: &mut Object, key: &str, allowed: &[&str]) {
    if let Some(value) = source.get(key).and_then(Value::as_str).filter(|v| allowed.contains(v)) { out.insert(key.into(), json!(value)); }
}

fn served_local_path(asset: &MaterialAsset) -> Option<&str> {
    let path = match asset.storage_mode.as_str() {
        "managed" | "source" => asset.library_path.as_deref().filter(|v| !v.is_empty()).unwrap_or(&asset.original_path),
        "linked" => &asset.original_path, _ => return None,
    };
    local_alias(path).map(|_| path)
}
/// Decode only the two desktop convertFileSrc prefixes; never a generic URL,
/// scheme, host or query. No decoded value is ever passed to filesystem APIs.
fn local_alias(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > MAX_SOURCE || raw.chars().any(char::is_control) { return None; }
    if asset_id(raw).is_some() { return Some(raw.into()); }
    let value = if let Some(encoded) = raw.strip_prefix("http://asset.localhost/")
        .or_else(|| raw.strip_prefix("https://asset.localhost/"))
        .or_else(|| raw.strip_prefix("asset://localhost/")) {
        if encoded.contains(['?', '#']) { return None; }
        decode_percent(encoded)?
    } else { raw.to_owned() };
    let path = value.replace('\\', "/");
    // No UNC, relative paths, alternate data streams, parent traversal or
    // arbitrary schemes. Match the catalog-owned spelling, not the filesystem.
    let windows = path.len() > 3 && path.as_bytes()[0].is_ascii_alphabetic() && path.as_bytes().get(1..3) == Some(&b":/"[..]);
    if !(path.starts_with('/') && !path.starts_with("//") || windows)
        || path.chars().any(char::is_control) || path.contains(['?', '#'])
        || path.split('/').any(|part| matches!(part, "." | ".."))
        || path[if windows { 2 } else { 0 }..].contains(':') { return None; }
    Some(path)
}
fn decode_percent(value: &str) -> Option<String> {
    let mut output = Vec::with_capacity(value.len()); let bytes = value.as_bytes(); let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            output.push(u8::from_str_radix(hex, 16).ok()?); i += 3;
        } else { output.push(bytes[i]); i += 1; }
    }
    String::from_utf8(output).ok()
}

fn describe_source(catalog: &MaterialCatalog, asset: &MaterialAsset, mut file: File, thumbnail: bool) -> Result<CatalogSource> {
    let unavailable = |_| ProjectionError::MediaUnavailable;
    let metadata = file.metadata().map_err(unavailable)?;
    let limit = match (asset.kind.as_str(), thumbnail) { (_, true) | ("image", false) => 64 * 1024 * 1024,
        ("video", false) => 1024 * 1024 * 1024, ("audio", false) => 256 * 1024 * 1024, _ => 0 };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit { return Err(ProjectionError::MediaUnavailable); }
    let mut head = [0u8; 32]; let count = file.read(&mut head).map_err(unavailable)?;
    let bytes = &head[..count];
    let mime = sniff_media(bytes, if thumbnail { "image" } else { &asset.kind }).ok_or(ProjectionError::MediaUnavailable)?;
    let revision = catalog.revision_for_asset(asset).map_err(|_| ProjectionError::MediaUnavailable)?;
    let modified = metadata.modified().map_err(unavailable)?.duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ProjectionError::MediaUnavailable)?.as_nanos();
    let mut hash = Sha256::new();
    // Include only authoritative catalog/file facts; never provider URLs.
    hash.update(catalog.library_scope_key().map_err(|_| ProjectionError::MediaUnavailable)?.as_bytes());
    hash.update(b"\0"); hash.update(revision.as_bytes()); hash.update(metadata.len().to_be_bytes()); hash.update(modified.to_be_bytes());
    hash.update(bytes); hash.update(mime.as_bytes());
    Ok(CatalogSource { asset_id: asset.id.clone(), thumbnail, revision: format!("{:x}", hash.finalize()), mime, length: metadata.len() })
}
fn sniff_media(bytes: &[u8], kind: &str) -> Option<&'static str> {
    match kind {
        "image" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some("image/png"),
        "image" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some("image/jpeg"),
        "image" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Some("image/gif"),
        "image" if bytes.starts_with(b"RIFF") && bytes.get(8..12).is_some_and(|v| v == b"WEBP") => Some("image/webp"),
        "video" if bytes.get(4..8).is_some_and(|v| v == b"ftyp") => Some("video/mp4"),
        "video" if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) => Some("video/webm"),
        "audio" if bytes.starts_with(b"RIFF") && bytes.get(8..12).is_some_and(|v| v == b"WAVE") => Some("audio/wav"),
        "audio" if bytes.starts_with(b"OggS") => Some("audio/ogg"),
        "audio" if bytes.starts_with(b"ID3") || bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0 => Some("audio/mpeg"),
        _ => None,
    }
}

struct BudgetWriter { bytes: usize, hash: Sha256 }
impl Write for BudgetWriter {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        self.bytes = self.bytes.checked_add(input.len()).filter(|v| *v <= MAX_DOCUMENT_BYTES)
            .ok_or_else(|| io::Error::other("canvas projection too large"))?;
        self.hash.update(input); Ok(input.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
fn value_hash(value: &Value) -> Result<[u8; 32]> {
    let mut writer = BudgetWriter { bytes: 0, hash: Sha256::new() };
    serde_json::to_writer(&mut writer, value).map_err(|_| ProjectionError::TooLarge)?;
    Ok(writer.hash.finalize().into())
}
fn validate_document_budget(value: &Value) -> Result<()> {
    // Check depth before serialization or cloning, including unknown fields.
    let mut pending = vec![(value, 0)]; let mut count = 0usize;
    while let Some((value, depth)) = pending.pop() {
        count += 1;
        if count > MAX_VALUES || depth > MAX_DEPTH { return Err(ProjectionError::TooLarge); }
        match value {
            Value::Array(values) => { if values.len() > MAX_VALUES.saturating_sub(count) { return Err(ProjectionError::TooLarge); }
                pending.extend(values.iter().map(|v| (v, depth + 1))); }
            Value::Object(values) => { if values.len() > MAX_VALUES.saturating_sub(count) { return Err(ProjectionError::TooLarge); }
                pending.extend(values.values().map(|v| (v, depth + 1))); }
            _ => {},
        }
        if pending.len() > MAX_VALUES { return Err(ProjectionError::TooLarge); }
    }
    value_hash(value).map(|_| ())
}

#[cfg(test)]
#[path = "canvas_media_tests.rs"]
mod tests;
