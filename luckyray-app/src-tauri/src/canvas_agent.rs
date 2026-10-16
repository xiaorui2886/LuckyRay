use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const CANVAS_SCHEMA_VERSION: u32 = 2;
const MAX_CANVAS_BYTES: usize = 8 * 1024 * 1024;
const MAX_INSPECT_NODES: usize = 160;
const MAX_INSPECT_EDGES: usize = 240;
const MAX_INSPECT_TEXT_BYTES: usize = 24 * 1024;
const MAX_OPERATIONS: usize = 32;
const MAX_VISIBLE_MUTATION_BYTES: usize = 32 * 1024;
const MAX_PROMPT_BYTES: usize = 16 * 1024;
const MAX_AGENT_RECEIPTS: usize = 64;
const CONTEXT_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug)]
pub(crate) struct CanvasAgentError {
    pub(crate) code: &'static str,
}

impl CanvasAgentError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasAgentContextView {
    pub(crate) canvas_id: String,
    pub(crate) revision: u64,
    pub(crate) content_digest: String,
}

#[derive(Clone)]
struct ActiveCanvasContext {
    canvas_id: String,
    epoch: u64,
    expires_at: Instant,
}

#[derive(Default)]
struct CanvasAgentState {
    active: Option<ActiveCanvasContext>,
    next_epoch: u64,
}

#[derive(Clone)]
pub(crate) struct CanvasAgentService {
    app_data_dir: Arc<PathBuf>,
    state: Arc<Mutex<CanvasAgentState>>,
    generation_executor: Arc<Mutex<Option<Arc<dyn CanvasGenerationExecutor>>>>,
    canvas_locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
    index_lock: Arc<Mutex<()>>,
}

pub(crate) trait CanvasGenerationExecutor: Send + Sync {
    fn generate(
        &self,
        request: &CanvasGenerationRequest,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
        journal: &dyn CanvasGenerationJournal,
    ) -> Result<CanvasGenerationOutput, CanvasAgentError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CanvasGenerationStage {
    ProviderRequested,
    ProviderSucceeded,
    ProviderUncertain,
    Materializing,
    MaterialCommitted,
    CanvasAttaching,
    CanvasCommitted,
}

impl CanvasGenerationStage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ProviderRequested => "provider-requested",
            Self::ProviderSucceeded => "provider-succeeded",
            Self::ProviderUncertain => "provider-uncertain",
            Self::Materializing => "materializing",
            Self::MaterialCommitted => "material-committed",
            Self::CanvasAttaching => "canvas-attaching",
            Self::CanvasCommitted => "canvas-committed",
        }
    }
}

pub(crate) trait CanvasGenerationJournal: Send + Sync {
    fn transition(
        &self,
        stage: CanvasGenerationStage,
        material_id: Option<&str>,
        output_digest: Option<&str>,
    ) -> Result<(), CanvasAgentError>;
}

#[cfg(test)]
struct NoopCanvasGenerationJournal;

#[cfg(test)]
impl CanvasGenerationJournal for NoopCanvasGenerationJournal {
    fn transition(
        &self,
        _stage: CanvasGenerationStage,
        _material_id: Option<&str>,
        _output_digest: Option<&str>,
    ) -> Result<(), CanvasAgentError> {
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CanvasGenerationRequest {
    pub(crate) kind: String,
    pub(crate) prompt: String,
    pub(crate) operation_digest: String,
    pub(crate) request_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CanvasGenerationOutput {
    pub(crate) text: Option<String>,
    pub(crate) material_id: Option<String>,
    pub(crate) media_url: Option<String>,
    pub(crate) thumbnail_url: Option<String>,
    pub(crate) model_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct CanvasDocument {
    #[serde(default = "default_schema")]
    pub(crate) schema_version: u32,
    pub(crate) canvas_id: String,
    pub(crate) name: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) nodes: Value,
    pub(crate) edges: Value,
    pub(crate) viewport: Value,
    #[serde(default)]
    pub(crate) generation_history: Value,
    #[serde(default)]
    pub(crate) revision: u64,
    #[serde(default)]
    pub(crate) content_digest: String,
    #[serde(default)]
    pub(crate) agent_receipts: Vec<CanvasAgentReceipt>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasAgentReceipt {
    pub(crate) operation_digest: String,
    pub(crate) revision: u64,
    #[serde(default, flatten)]
    pub(crate) metadata: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct CanvasIndexEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) node_count: u32,
    pub(crate) edge_count: u32,
    #[serde(default)]
    pub(crate) cover_version: u8,
    #[serde(default)]
    pub(crate) cover_kind: Option<String>,
    #[serde(default)]
    pub(crate) cover_url: Option<String>,
    #[serde(default)]
    pub(crate) cover_poster: Option<String>,
    #[serde(default)]
    pub(crate) revision: u64,
    #[serde(default)]
    pub(crate) content_digest: String,
}

#[derive(Deserialize, Serialize)]
struct CanvasIndex {
    schema_version: u32,
    canvases: Vec<CanvasIndexEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanvasWriteBinding {
    pub(crate) local_turn_id: String,
    pub(crate) engine_session_id: String,
    pub(crate) engine_turn_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) generation: u64,
    pub(crate) principal_digest: [u8; 32],
    pub(crate) tool_id: String,
    pub(crate) request_id: String,
    pub(crate) input_digest: [u8; 32],
    pub(crate) canvas_id: String,
    pub(crate) context_epoch: u64,
    pub(crate) expected_revision: u64,
    pub(crate) expected_digest: String,
}

pub(crate) trait CanvasWritePermit: Send + Sync {
    fn consume(&self, binding: &CanvasWriteBinding) -> Result<(), CanvasAgentError>;
}

pub(crate) struct CanvasWriteScope {
    pub(crate) local_turn_id: String,
    pub(crate) engine_session_id: String,
    pub(crate) engine_turn_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) generation: u64,
}

#[derive(Clone)]
pub(crate) struct PreparedCanvasWrite {
    pub(crate) binding: CanvasWriteBinding,
    pub(crate) tool_id: String,
    pub(crate) preview: String,
    pub(crate) operation_digest: String,
    operations: Vec<CanvasOperation>,
}

impl PreparedCanvasWrite {
    pub(crate) fn generation_kind(&self) -> Option<&str> {
        match self.operations.as_slice() {
            [CanvasOperation::Generate { kind, .. }] => Some(kind.as_str()),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CanvasArtifactReconciliation {
    Committed,
    NotCommitted,
    Uncertain,
}

#[derive(Clone, Debug)]
enum CanvasOperation {
    Create {
        kind: String,
        title: String,
        text: String,
        reference_token: Option<String>,
        x: f64,
        y: f64,
    },
    Update {
        node_id: String,
        title: Option<String>,
        text: Option<String>,
    },
    Arrange {
        node_ids: Vec<String>,
        layout: String,
    },
    Connect {
        source_id: String,
        target_id: String,
    },
    Disconnect {
        source_id: String,
        target_id: String,
    },
    Group {
        node_ids: Vec<String>,
        title: String,
    },
    Ungroup {
        group_id: String,
    },
    Generate {
        kind: String,
        prompt: String,
        x: f64,
        y: f64,
    },
}

fn default_schema() -> u32 {
    1
}

fn valid_canvas_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn safe_text(value: &str, max_bytes: usize) -> bool {
    !value.as_bytes().is_empty()
        && value.as_bytes().len() <= max_bytes
        && !value.chars().any(|character| {
            character == '\0'
                || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        })
}

pub(crate) fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            let mut output = Map::new();
            for key in keys {
                output.insert(key.clone(), canonicalize(&object[key]));
            }
            Value::Object(output)
        }
        value => value.clone(),
    }
}

pub(crate) fn content_digest(document: &CanvasDocument) -> Result<String, CanvasAgentError> {
    let payload = json!({
        "canvasId": document.canvas_id,
        "name": document.name,
        "createdAt": document.created_at,
        "nodes": canonicalize(&document.nodes),
        "edges": canonicalize(&document.edges),
        "viewport": canonicalize(&document.viewport),
        "generationHistory": canonicalize(&document.generation_history),
    });
    let bytes = serde_json::to_vec(&canonicalize(&payload))
        .map_err(|_| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn canvas_dir(root: &Path) -> Result<PathBuf, CanvasAgentError> {
    let path = root.join("canvases");
    fs::create_dir_all(&path)
        .map_err(|_| CanvasAgentError::new("canvas-agent-storage-unavailable"))?;
    Ok(path)
}

fn canvas_path(root: &Path, canvas_id: &str) -> Result<PathBuf, CanvasAgentError> {
    if !valid_canvas_id(canvas_id) {
        return Err(CanvasAgentError::new("canvas-agent-context-invalid"));
    }
    Ok(canvas_dir(root)?.join(format!("{canvas_id}.json")))
}

pub(crate) fn normalize_document(
    mut document: CanvasDocument,
) -> Result<CanvasDocument, CanvasAgentError> {
    if !valid_canvas_id(&document.canvas_id) {
        return Err(CanvasAgentError::new("canvas-agent-storage-invalid"));
    }
    for receipt in &document.agent_receipts {
        if receipt.operation_digest.len() != 64
            || !receipt
                .operation_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || receipt.revision == 0
            || receipt.revision > document.revision
            || !valid_receipt_metadata(&receipt.metadata)
        {
            return Err(CanvasAgentError::new("canvas-agent-storage-invalid"));
        }
    }
    let actual = content_digest(&document)?;
    if document.schema_version >= CANVAS_SCHEMA_VERSION
        && !document.content_digest.is_empty()
        && document.content_digest != actual
    {
        return Err(CanvasAgentError::new("canvas-agent-storage-invalid"));
    }
    document.content_digest = actual;
    Ok(document)
}

fn valid_receipt_metadata(metadata: &Map<String, Value>) -> bool {
    if metadata.len() > 32
        || serde_json::to_vec(metadata).map_or(true, |bytes| bytes.len() > 8 * 1024)
    {
        return false;
    }
    for (key, value) in metadata {
        if key.is_empty()
            || key.as_bytes().len() > 64
            || key.chars().any(char::is_control)
            || !valid_receipt_value(value, 0)
        {
            return false;
        }
    }
    metadata
        .get("materialId")
        .is_none_or(|value| value.as_str().is_some_and(safe_id))
        && metadata
            .get("requestId")
            .is_none_or(|value| value.as_str().is_some_and(safe_id))
        && metadata.get("toolId").is_none_or(|value| {
            value
                .as_str()
                .is_some_and(|value| matches!(value, "canvas.mutate" | "canvas.generate"))
        })
        && metadata.get("generationKind").is_none_or(|value| {
            value
                .as_str()
                .is_some_and(|value| matches!(value, "text" | "image" | "video"))
        })
}

fn valid_receipt_value(value: &Value, depth: usize) -> bool {
    if depth > 3 {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(|number| number.is_finite()),
        Value::String(value) => {
            value.as_bytes().len() <= 1024 && !value.chars().any(char::is_control)
        }
        Value::Array(items) => {
            items.len() <= 32
                && items
                    .iter()
                    .all(|item| valid_receipt_value(item, depth + 1))
        }
        Value::Object(object) => {
            object.len() <= 32
                && object.iter().all(|(key, item)| {
                    !key.is_empty()
                        && key.as_bytes().len() <= 64
                        && !key.chars().any(char::is_control)
                        && valid_receipt_value(item, depth + 1)
                })
        }
    }
}

pub(crate) fn load_document(
    root: &Path,
    canvas_id: &str,
) -> Result<CanvasDocument, CanvasAgentError> {
    let path = canvas_path(root, canvas_id)?;
    let bytes =
        fs::read(&path).map_err(|_| CanvasAgentError::new("canvas-agent-context-unavailable"))?;
    if bytes.len() > MAX_CANVAS_BYTES {
        return Err(CanvasAgentError::new("canvas-agent-content-too-large"));
    }
    let document: CanvasDocument = serde_json::from_slice(&bytes)
        .map_err(|_| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
    if document.canvas_id != canvas_id {
        return Err(CanvasAgentError::new("canvas-agent-storage-invalid"));
    }
    normalize_document(document)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), CanvasAgentError> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
    let temp = path.with_file_name(format!(
        ".{file_name}.agent-{}-{}.tmp",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let result = (|| {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| CanvasAgentError::new("canvas-agent-storage-unavailable"))?;
        output
            .write_all(bytes)
            .and_then(|_| output.sync_all())
            .map_err(|_| CanvasAgentError::new("canvas-agent-storage-unavailable"))?;
        drop(output);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
            const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
            #[link(name = "Kernel32")]
            unsafe extern "system" {
                fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
            }
            let from = temp
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let to = path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(CanvasAgentError::new("canvas-agent-storage-unavailable"));
            }
        }
        #[cfg(not(windows))]
        fs::rename(&temp, path)
            .map_err(|_| CanvasAgentError::new("canvas-agent-storage-unavailable"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(crate) fn canvas_cover_from_nodes(
    nodes: &Value,
) -> (Option<String>, Option<String>, Option<String>) {
    fn text(value: Option<&Value>) -> Option<String> {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|candidate| !candidate.is_empty())
            .map(str::to_string)
    }

    let mut selected: Option<(f64, String, String, Option<String>)> = None;
    let mut consider = |score: f64, kind: &str, url: Option<String>, poster: Option<String>| {
        let Some(url) = url else { return };
        if selected.as_ref().is_some_and(|current| current.0 >= score) {
            return;
        }
        selected = Some((score, kind.to_owned(), url, poster));
    };
    let Some(items) = nodes.as_array() else {
        return (None, None, None);
    };
    for (index, node) in items.iter().enumerate() {
        let Some(data) = node.get("data") else {
            continue;
        };
        let kind = data.get("kind").and_then(Value::as_str).unwrap_or("");
        let generation_kind = data
            .get("generationKind")
            .and_then(Value::as_str)
            .unwrap_or("");
        let first_result = data
            .get("resultMediaItems")
            .and_then(Value::as_array)
            .and_then(|values| values.first());
        let result_url = text(first_result.and_then(|value| value.get("url")))
            .or_else(|| text(data.get("resultMediaUrl")));
        let result_thumbnail = text(first_result.and_then(|value| value.get("thumbnailUrl")))
            .or_else(|| text(data.get("resultThumbnailUrl")));
        let reference_url = text(data.get("refMediaUrl"));
        let reference_thumbnail = text(data.get("refThumbnailUrl"));
        let order_boost = index as f64 / items.len().max(1) as f64;

        if kind == "image" {
            consider(
                400.0 + order_boost,
                "image",
                reference_thumbnail.clone().or(reference_url.clone()),
                None,
            );
        } else if kind == "generator" && generation_kind == "image" {
            consider(
                360.0 + order_boost,
                "image",
                result_thumbnail.clone().or(result_url.clone()),
                None,
            );
        } else if kind == "video" {
            if reference_thumbnail.is_some() && reference_thumbnail != reference_url {
                consider(320.0 + order_boost, "image", reference_thumbnail, None);
            } else {
                consider(280.0 + order_boost, "video", reference_url, None);
            }
        } else if kind == "generator" && generation_kind == "video" {
            if result_thumbnail.is_some() && result_thumbnail != result_url {
                consider(300.0 + order_boost, "image", result_thumbnail, None);
            } else {
                consider(260.0 + order_boost, "video", result_url, result_thumbnail);
            }
        }
    }
    selected
        .map(|(_, kind, url, poster)| (Some(kind), Some(url), poster))
        .unwrap_or((None, None, None))
}

fn index_entry(document: &CanvasDocument) -> CanvasIndexEntry {
    let (cover_kind, cover_url, cover_poster) = canvas_cover_from_nodes(&document.nodes);
    CanvasIndexEntry {
        id: document.canvas_id.clone(),
        name: document.name.clone(),
        created_at: document.created_at.clone(),
        updated_at: document.updated_at.clone(),
        node_count: document
            .nodes
            .as_array()
            .map_or(0, |items| items.len() as u32),
        edge_count: document
            .edges
            .as_array()
            .map_or(0, |items| items.len() as u32),
        cover_version: 1,
        cover_kind,
        cover_url,
        cover_poster,
        revision: document.revision,
        content_digest: document.content_digest.clone(),
    }
}

fn update_index(root: &Path, document: &CanvasDocument) -> Result<(), CanvasAgentError> {
    let path = canvas_dir(root)?.join("index.json");
    let mut index = if path.exists() {
        let bytes = fs::read(&path)
            .map_err(|_| CanvasAgentError::new("canvas-agent-storage-unavailable"))?;
        serde_json::from_slice::<CanvasIndex>(&bytes)
            .map_err(|_| CanvasAgentError::new("canvas-agent-storage-invalid"))?
    } else {
        CanvasIndex {
            schema_version: CANVAS_SCHEMA_VERSION,
            canvases: Vec::new(),
        }
    };
    let entry = index_entry(document);
    if let Some(existing) = index
        .canvases
        .iter_mut()
        .find(|candidate| candidate.id == document.canvas_id)
    {
        *existing = entry;
    } else {
        index.canvases.push(entry);
    }
    index.schema_version = CANVAS_SCHEMA_VERSION;
    let bytes = serde_json::to_vec_pretty(&index)
        .map_err(|_| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
    atomic_write(&path, &bytes)
}

fn remove_from_index(root: &Path, canvas_id: &str) -> Result<(), CanvasAgentError> {
    let path = canvas_dir(root)?.join("index.json");
    if !path.exists() {
        return Ok(());
    }
    let bytes =
        fs::read(&path).map_err(|_| CanvasAgentError::new("canvas-agent-storage-unavailable"))?;
    let mut index = serde_json::from_slice::<CanvasIndex>(&bytes)
        .map_err(|_| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
    index.canvases.retain(|candidate| candidate.id != canvas_id);
    index.schema_version = CANVAS_SCHEMA_VERSION;
    let bytes = serde_json::to_vec_pretty(&index)
        .map_err(|_| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
    atomic_write(&path, &bytes)
}

impl CanvasAgentService {
    pub(crate) fn new(app_data_dir: impl AsRef<Path>) -> Self {
        Self {
            app_data_dir: Arc::new(app_data_dir.as_ref().to_path_buf()),
            state: Arc::new(Mutex::new(CanvasAgentState::default())),
            generation_executor: Arc::new(Mutex::new(None)),
            canvas_locks: Arc::new(Mutex::new(HashMap::new())),
            index_lock: Arc::new(Mutex::new(())),
        }
    }

    fn canvas_lock(&self, canvas_id: &str) -> Result<Arc<Mutex<()>>, CanvasAgentError> {
        if !valid_canvas_id(canvas_id) {
            return Err(CanvasAgentError::new("canvas-agent-context-invalid"));
        }
        let mut locks = self
            .canvas_locks
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(canvas_id).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(canvas_id.to_owned(), Arc::downgrade(&lock));
        Ok(lock)
    }

    fn validate_expected(
        document: &CanvasDocument,
        expected_revision: u64,
        expected_digest: &str,
    ) -> Result<(), CanvasAgentError> {
        if document.revision != expected_revision || document.content_digest != expected_digest {
            return Err(CanvasAgentError::new("canvas-agent-revision-conflict"));
        }
        Ok(())
    }

    fn write_document_locked(
        &self,
        mut document: CanvasDocument,
    ) -> Result<(CanvasDocument, bool), CanvasAgentError> {
        document.content_digest = content_digest(&document)?;
        document = normalize_document(document)?;
        let bytes = serde_json::to_vec_pretty(&document)
            .map_err(|_| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
        if bytes.len() > MAX_CANVAS_BYTES {
            return Err(CanvasAgentError::new("canvas-agent-content-too-large"));
        }
        let path = canvas_path(&self.app_data_dir, &document.canvas_id)?;
        atomic_write(&path, &bytes)?;
        let _index_guard = self
            .index_lock
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        let index_warning = update_index(&self.app_data_dir, &document).is_err();
        Ok((document, index_warning))
    }

    pub(crate) fn create_normal_canvas(
        &self,
        mut document: CanvasDocument,
    ) -> Result<CanvasIndexEntry, CanvasAgentError> {
        let lock = self.canvas_lock(&document.canvas_id)?;
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        let path = canvas_path(&self.app_data_dir, &document.canvas_id)?;
        if path.exists() {
            return Err(CanvasAgentError::new("canvas-agent-revision-conflict"));
        }
        document.agent_receipts.clear();
        document.revision = 0;
        document.content_digest = content_digest(&document)?;
        let (document, _) = self.write_document_locked(document)?;
        Ok(index_entry(&document))
    }

    pub(crate) fn save_normal_canvas(
        &self,
        mut incoming: CanvasDocument,
    ) -> Result<CanvasIndexEntry, CanvasAgentError> {
        let lock = self.canvas_lock(&incoming.canvas_id)?;
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        let path = canvas_path(&self.app_data_dir, &incoming.canvas_id)?;
        let current = path
            .exists()
            .then(|| load_document(&self.app_data_dir, &incoming.canvas_id))
            .transpose()?;
        let current_revision = if let Some(current) = current.as_ref() {
            Self::validate_expected(current, incoming.revision, &incoming.content_digest)?;
            incoming.agent_receipts = current.agent_receipts.clone();
            current.revision
        } else {
            if incoming.revision != 0 || !incoming.content_digest.is_empty() {
                return Err(CanvasAgentError::new("canvas-agent-revision-conflict"));
            }
            incoming.agent_receipts.clear();
            0
        };
        incoming.schema_version = CANVAS_SCHEMA_VERSION;
        incoming.revision = current_revision
            .checked_add(1)
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-revision-conflict"))?;
        let (saved, _) = self.write_document_locked(incoming)?;
        Ok(index_entry(&saved))
    }

    pub(crate) fn rename_normal_canvas(
        &self,
        canvas_id: &str,
        name: &str,
        expected_revision: u64,
        expected_digest: &str,
    ) -> Result<CanvasIndexEntry, CanvasAgentError> {
        let clean_name = name.trim();
        if !safe_text(clean_name, 1024) {
            return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
        }
        let lock = self.canvas_lock(canvas_id)?;
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        let mut document = load_document(&self.app_data_dir, canvas_id)?;
        Self::validate_expected(&document, expected_revision, expected_digest)?;
        document.name = clean_name.to_owned();
        document.updated_at = chrono::Utc::now().to_rfc3339();
        document.schema_version = CANVAS_SCHEMA_VERSION;
        document.revision = document
            .revision
            .checked_add(1)
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-revision-conflict"))?;
        let (saved, _) = self.write_document_locked(document)?;
        Ok(index_entry(&saved))
    }

    pub(crate) fn delete_normal_canvas(
        &self,
        canvas_id: &str,
        expected_revision: u64,
        expected_digest: &str,
    ) -> Result<(), CanvasAgentError> {
        let lock = self.canvas_lock(canvas_id)?;
        let _guard = lock.lock().unwrap_or_else(|value| value.into_inner());
        let document = load_document(&self.app_data_dir, canvas_id)?;
        Self::validate_expected(&document, expected_revision, expected_digest)?;
        let path = canvas_path(&self.app_data_dir, canvas_id)?;
        fs::remove_file(path)
            .map_err(|_| CanvasAgentError::new("canvas-agent-storage-unavailable"))?;
        let _index_guard = self
            .index_lock
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        remove_from_index(&self.app_data_dir, canvas_id)
    }

    pub(crate) fn set_generation_executor(&self, executor: Arc<dyn CanvasGenerationExecutor>) {
        *self
            .generation_executor
            .lock()
            .unwrap_or_else(|value| value.into_inner()) = Some(executor);
    }

    pub(crate) fn activate(
        &self,
        canvas_id: &str,
    ) -> Result<CanvasAgentContextView, CanvasAgentError> {
        let document = load_document(&self.app_data_dir, canvas_id)?;
        let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
        if state.active.as_ref().is_some_and(|active| {
            active.canvas_id == document.canvas_id && Instant::now() < active.expires_at
        }) {
            return Ok(CanvasAgentContextView {
                canvas_id: document.canvas_id,
                revision: document.revision,
                content_digest: document.content_digest,
            });
        }
        state.next_epoch = state.next_epoch.saturating_add(1).max(1);
        state.active = Some(ActiveCanvasContext {
            canvas_id: document.canvas_id.clone(),
            epoch: state.next_epoch,
            expires_at: Instant::now() + CONTEXT_TTL,
        });
        Ok(CanvasAgentContextView {
            canvas_id: document.canvas_id,
            revision: document.revision,
            content_digest: document.content_digest,
        })
    }

    pub(crate) fn clear(&self) {
        self.state
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .active = None;
    }

    pub(crate) fn clear_scope(&self, scope: [u8; 32]) {
        let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
        let matches = state.active.as_ref().is_some_and(|active| {
            let actual = Sha256::digest(
                [
                    b"luckyray-canvas-agent-scope-v1\0".as_slice(),
                    active.canvas_id.as_bytes(),
                    b"\0",
                    &active.epoch.to_le_bytes(),
                ]
                .concat(),
            );
            actual.as_slice() == scope
        });
        if matches {
            state.active = None;
        }
    }

    pub(crate) fn is_active_canvas(&self, canvas_id: &str) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .active
            .as_ref()
            .is_some_and(|active| {
                active.canvas_id == canvas_id && Instant::now() < active.expires_at
            })
    }

    pub(crate) fn current_scope(&self) -> Result<[u8; 32], CanvasAgentError> {
        let state = self.state.lock().unwrap_or_else(|value| value.into_inner());
        let active = state
            .active
            .as_ref()
            .filter(|active| Instant::now() < active.expires_at)
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-context-unavailable"))?;
        Ok(Sha256::digest(
            [
                b"luckyray-canvas-agent-scope-v1\0".as_slice(),
                active.canvas_id.as_bytes(),
                b"\0",
                &active.epoch.to_le_bytes(),
            ]
            .concat(),
        )
        .into())
    }

    fn live_context(
        &self,
        scope: [u8; 32],
    ) -> Result<(ActiveCanvasContext, CanvasDocument), CanvasAgentError> {
        let active = {
            let state = self.state.lock().unwrap_or_else(|value| value.into_inner());
            state
                .active
                .clone()
                .filter(|active| Instant::now() < active.expires_at)
                .ok_or_else(|| CanvasAgentError::new("canvas-agent-context-unavailable"))?
        };
        let actual = Sha256::digest(
            [
                b"luckyray-canvas-agent-scope-v1\0".as_slice(),
                active.canvas_id.as_bytes(),
                b"\0",
                &active.epoch.to_le_bytes(),
            ]
            .concat(),
        );
        if actual.as_slice() != scope {
            return Err(CanvasAgentError::new("canvas-agent-context-invalid"));
        }
        let document = load_document(&self.app_data_dir, &active.canvas_id)?;
        Ok((active, document))
    }

    pub(crate) fn inspect(&self, scope: [u8; 32]) -> Result<Value, CanvasAgentError> {
        let (_, document) = self.live_context(scope)?;
        let nodes = document
            .nodes
            .as_array()
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
        let edges = document
            .edges
            .as_array()
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
        let mut retained_bytes = 0usize;
        let safe_nodes = nodes
            .iter()
            .take(MAX_INSPECT_NODES)
            .map(|node| {
                let id = node
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| safe_id(id));
                let data = node.get("data").and_then(Value::as_object);
                let kind = data
                    .and_then(|data| data.get("kind"))
                    .and_then(Value::as_str)
                    .filter(|value| value.len() <= 32)
                    .unwrap_or("unknown");
                let title = data
                    .and_then(|data| data.get("label"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let remaining = MAX_INSPECT_TEXT_BYTES.saturating_sub(retained_bytes);
                let bounded = title
                    .chars()
                    .take(remaining.min(512))
                    .filter(|character| !character.is_control())
                    .collect::<String>();
                retained_bytes = retained_bytes.saturating_add(bounded.as_bytes().len());
                json!({"id":id.unwrap_or("invalid"),"kind":kind,"title":bounded})
            })
            .collect::<Vec<_>>();
        let safe_edges = edges
            .iter()
            .filter_map(|edge| {
                let source = edge.get("source")?.as_str().filter(|id| safe_id(id))?;
                let target = edge.get("target")?.as_str().filter(|id| safe_id(id))?;
                Some(json!({"source":source,"target":target}))
            })
            .take(MAX_INSPECT_EDGES)
            .collect::<Vec<_>>();
        Ok(json!({
            "revision": document.revision,
            "nodeCount": nodes.len(),
            "edgeCount": edges.len(),
            "nodes": safe_nodes,
            "edges": safe_edges,
            "truncated": nodes.len() > MAX_INSPECT_NODES || edges.len() > MAX_INSPECT_EDGES,
        }))
    }

    pub(crate) fn prepare(
        &self,
        scope: [u8; 32],
        tool_id: &str,
        input: &Value,
        write_scope: CanvasWriteScope,
        principal_digest: [u8; 32],
    ) -> Result<PreparedCanvasWrite, CanvasAgentError> {
        let (active, document) = self.live_context(scope)?;
        let request_id = input
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|value| safe_id(value))
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?
            .to_owned();
        let operations = match tool_id {
            "canvas.mutate" => parse_mutations(input)?,
            "canvas.generate" => vec![parse_generation(input)?],
            _ => return Err(CanvasAgentError::new("canvas-agent-tool-not-allowed")),
        };
        let preview = mutation_preview(&operations)?;
        if preview.as_bytes().len() > MAX_VISIBLE_MUTATION_BYTES {
            return Err(CanvasAgentError::new("canvas-agent-preview-too-large"));
        }
        let bytes = serde_json::to_vec(&canonicalize(input))
            .map_err(|_| CanvasAgentError::new("canvas-agent-input-invalid"))?;
        let operation_digest = format!("{:x}", Sha256::digest(&bytes));
        Ok(PreparedCanvasWrite {
            binding: CanvasWriteBinding {
                local_turn_id: write_scope.local_turn_id,
                engine_session_id: write_scope.engine_session_id,
                engine_turn_id: write_scope.engine_turn_id,
                tool_call_id: write_scope.tool_call_id,
                generation: write_scope.generation,
                principal_digest,
                tool_id: tool_id.to_owned(),
                request_id,
                input_digest: Sha256::digest(bytes).into(),
                canvas_id: document.canvas_id,
                context_epoch: active.epoch,
                expected_revision: document.revision,
                expected_digest: document.content_digest,
            },
            tool_id: tool_id.to_owned(),
            preview,
            operation_digest,
            operations,
        })
    }

    #[cfg(test)]
    pub(crate) fn execute(
        &self,
        scope: [u8; 32],
        prepared: PreparedCanvasWrite,
        permit: &dyn CanvasWritePermit,
    ) -> Result<Value, CanvasAgentError> {
        self.execute_with_cancel(
            scope,
            prepared,
            permit,
            &|| false,
            &NoopCanvasGenerationJournal,
        )
    }

    pub(crate) fn execute_with_cancel(
        &self,
        scope: [u8; 32],
        prepared: PreparedCanvasWrite,
        permit: &dyn CanvasWritePermit,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
        journal: &dyn CanvasGenerationJournal,
    ) -> Result<Value, CanvasAgentError> {
        let (active, document) = self.live_context(scope)?;
        if active.epoch != prepared.binding.context_epoch
            || document.canvas_id != prepared.binding.canvas_id
            || document.revision != prepared.binding.expected_revision
            || document.content_digest != prepared.binding.expected_digest
        {
            return Err(CanvasAgentError::new("canvas-agent-revision-conflict"));
        }
        permit.consume(&prepared.binding)?;
        if cancelled() {
            return Err(CanvasAgentError::new("canvas-agent-cancelled"));
        }
        let generated = if let [CanvasOperation::Generate { kind, prompt, .. }] =
            prepared.operations.as_slice()
        {
            let executor = self
                .generation_executor
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .clone()
                .ok_or_else(|| CanvasAgentError::new("canvas-agent-generation-unavailable"))?;
            Some(executor.generate(
                &CanvasGenerationRequest {
                    kind: kind.clone(),
                    prompt: prompt.clone(),
                    operation_digest: prepared.operation_digest.clone(),
                    request_id: prepared.binding.request_id.clone(),
                },
                cancelled,
                journal,
            )?)
        } else {
            None
        };
        if cancelled() {
            return Err(CanvasAgentError::new("canvas-agent-cancelled"));
        }
        let commit_lock = self.canvas_lock(&prepared.binding.canvas_id)?;
        let _commit_guard = commit_lock
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        let (latest_active, mut document) = self.live_context(scope)?;
        if latest_active.epoch != prepared.binding.context_epoch
            || document.canvas_id != prepared.binding.canvas_id
        {
            return Err(CanvasAgentError::new("canvas-agent-revision-conflict"));
        }
        Self::validate_expected(
            &document,
            prepared.binding.expected_revision,
            &prepared.binding.expected_digest,
        )?;
        journal.transition(CanvasGenerationStage::CanvasAttaching, None, None)?;
        if cancelled() {
            return Err(CanvasAgentError::new("canvas-agent-cancelled"));
        }
        apply_operations(&mut document, &prepared.operations, generated.as_ref())?;
        document.schema_version = CANVAS_SCHEMA_VERSION;
        document.revision = document
            .revision
            .checked_add(1)
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-revision-conflict"))?;
        let mut receipt_metadata = Map::new();
        receipt_metadata.insert("toolId".to_owned(), Value::String(prepared.tool_id.clone()));
        receipt_metadata.insert(
            "requestId".to_owned(),
            Value::String(prepared.binding.request_id.clone()),
        );
        if let Some(output) = generated.as_ref() {
            if let Some(material_id) = output.material_id.as_ref() {
                receipt_metadata
                    .insert("materialId".to_owned(), Value::String(material_id.clone()));
            }
            if let Some(kind) = prepared.generation_kind() {
                receipt_metadata
                    .insert("generationKind".to_owned(), Value::String(kind.to_owned()));
            }
        }
        document.agent_receipts.push(CanvasAgentReceipt {
            operation_digest: prepared.operation_digest.clone(),
            revision: document.revision,
            metadata: receipt_metadata,
        });
        if document.agent_receipts.len() > MAX_AGENT_RECEIPTS {
            document
                .agent_receipts
                .drain(..document.agent_receipts.len() - MAX_AGENT_RECEIPTS);
        }
        document.updated_at = chrono::Utc::now().to_rfc3339();
        let (document, index_warning) = self.write_document_locked(document)?;
        let stage_committed = journal
            .transition(CanvasGenerationStage::CanvasCommitted, None, None)
            .is_ok();
        Ok(json!({
            "ok": true,
            "revision": document.revision,
            "contentDigest": document.content_digest,
            "artifactName": if prepared.tool_id == "canvas.generate" { "Canvas generation" } else { "Canvas update" },
            "committedWarning": !stage_committed || index_warning,
        }))
    }

    #[cfg(test)]
    pub(crate) fn reconcile_artifact(
        &self,
        canvas_id: &str,
        operation_digest: &str,
        expected_revision: u64,
    ) -> Result<CanvasArtifactReconciliation, CanvasAgentError> {
        let planned_revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-artifact-invalid"))?;
        self.reconcile_artifact_with_recorded_identity(
            canvas_id,
            operation_digest,
            expected_revision,
            planned_revision,
            None,
        )
    }

    pub(crate) fn reconcile_artifact_with_recorded_identity(
        &self,
        canvas_id: &str,
        operation_digest: &str,
        expected_revision: u64,
        planned_revision: u64,
        recorded_material_id: Option<&str>,
    ) -> Result<CanvasArtifactReconciliation, CanvasAgentError> {
        if !valid_canvas_id(canvas_id)
            || operation_digest.len() != 64
            || !operation_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || recorded_material_id.is_some_and(|material_id| !safe_id(material_id))
        {
            return Err(CanvasAgentError::new("canvas-agent-artifact-invalid"));
        }
        let document = load_document(&self.app_data_dir, canvas_id)?;
        if let Some(receipt) = document
            .agent_receipts
            .iter()
            .find(|receipt| receipt.operation_digest == operation_digest)
        {
            if receipt.revision != planned_revision
                || recorded_material_id.is_some_and(|material_id| {
                    receipt.metadata.get("materialId").and_then(Value::as_str) != Some(material_id)
                })
            {
                return Ok(CanvasArtifactReconciliation::Uncertain);
            }
            return Ok(CanvasArtifactReconciliation::Committed);
        }
        if document.revision == expected_revision {
            return Ok(CanvasArtifactReconciliation::NotCommitted);
        }
        Ok(CanvasArtifactReconciliation::Uncertain)
    }

    pub(crate) fn validate_committed_artifact(
        &self,
        canvas_id: &str,
        operation_digest: &str,
    ) -> Result<String, CanvasAgentError> {
        let document = load_document(&self.app_data_dir, canvas_id)?;
        if !document
            .agent_receipts
            .iter()
            .any(|receipt| receipt.operation_digest == operation_digest)
        {
            return Err(CanvasAgentError::new("canvas-agent-artifact-changed"));
        }
        Ok(document.canvas_id)
    }
}

fn required_number(
    object: &Map<String, Value>,
    key: &str,
    default: f64,
) -> Result<f64, CanvasAgentError> {
    let value = object.get(key).and_then(Value::as_f64).unwrap_or(default);
    if !value.is_finite() || value.abs() > 1_000_000.0 {
        return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
    }
    Ok(value)
}

fn parse_mutations(input: &Value) -> Result<Vec<CanvasOperation>, CanvasAgentError> {
    let operations = input
        .get("operations")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= MAX_OPERATIONS)
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?;
    operations.iter().map(parse_operation).collect()
}

fn parse_operation(value: &Value) -> Result<CanvasOperation, CanvasAgentError> {
    let object = value
        .as_object()
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?;
    let op = object
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?;
    let allowed: &[&str] = match op {
        "create" => &["op", "kind", "title", "text", "referenceToken", "x", "y"],
        "update" => &["op", "nodeId", "title", "text"],
        "arrange" => &["op", "nodeIds", "layout"],
        "connect" | "disconnect" => &["op", "sourceId", "targetId"],
        "group" => &["op", "nodeIds", "title"],
        "ungroup" => &["op", "groupId"],
        _ => return Err(CanvasAgentError::new("canvas-agent-input-invalid")),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
    }
    let text = |key: &str, max: usize| -> Result<String, CanvasAgentError> {
        let value = object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?;
        if !safe_text(value, max) {
            return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
        }
        Ok(value.to_owned())
    };
    let id = |key: &str| -> Result<String, CanvasAgentError> {
        let value = object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| safe_id(value))
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?;
        Ok(value.to_owned())
    };
    let ids = || -> Result<Vec<String>, CanvasAgentError> {
        let values = object
            .get("nodeIds")
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty() && items.len() <= MAX_OPERATIONS)
            .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?;
        values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| safe_id(value))
                    .map(str::to_owned)
                    .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))
            })
            .collect()
    };
    Ok(match op {
        "create" => {
            let kind = text("kind", 32)?;
            if !matches!(kind.as_str(), "text" | "note-ref" | "material-ref") {
                return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
            }
            let reference_token = object
                .get("referenceToken")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if reference_token
                .as_deref()
                .is_some_and(|value| !safe_id(value))
            {
                return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
            }
            CanvasOperation::Create {
                kind,
                title: text("title", 256)?,
                text: object
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                reference_token,
                x: required_number(object, "x", 120.0)?,
                y: required_number(object, "y", 120.0)?,
            }
        }
        "update" => {
            let title = object
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let text_value = object
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if title.is_none() && text_value.is_none() {
                return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
            }
            if title.as_deref().is_some_and(|value| !safe_text(value, 256))
                || text_value
                    .as_deref()
                    .is_some_and(|value| !safe_text(value, MAX_VISIBLE_MUTATION_BYTES))
            {
                return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
            }
            CanvasOperation::Update {
                node_id: id("nodeId")?,
                title,
                text: text_value,
            }
        }
        "arrange" => {
            let layout = text("layout", 16)?;
            if !matches!(layout.as_str(), "grid" | "row" | "column") {
                return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
            }
            CanvasOperation::Arrange {
                node_ids: ids()?,
                layout,
            }
        }
        "connect" => CanvasOperation::Connect {
            source_id: id("sourceId")?,
            target_id: id("targetId")?,
        },
        "disconnect" => CanvasOperation::Disconnect {
            source_id: id("sourceId")?,
            target_id: id("targetId")?,
        },
        "group" => CanvasOperation::Group {
            node_ids: ids()?,
            title: text("title", 256)?,
        },
        "ungroup" => CanvasOperation::Ungroup {
            group_id: id("groupId")?,
        },
        _ => unreachable!(),
    })
}

fn parse_generation(input: &Value) -> Result<CanvasOperation, CanvasAgentError> {
    let object = input
        .as_object()
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?;
    if object
        .keys()
        .any(|key| !["requestId", "kind", "prompt", "x", "y"].contains(&key.as_str()))
    {
        return Err(CanvasAgentError::new("canvas-agent-input-invalid"));
    }
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "text" | "image" | "video"))
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?
        .to_owned();
    let prompt = object
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|value| safe_text(value, MAX_PROMPT_BYTES))
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-input-invalid"))?
        .to_owned();
    Ok(CanvasOperation::Generate {
        kind,
        prompt,
        x: required_number(object, "x", 160.0)?,
        y: required_number(object, "y", 160.0)?,
    })
}

fn mutation_preview(operations: &[CanvasOperation]) -> Result<String, CanvasAgentError> {
    let lines = operations
        .iter()
        .enumerate()
        .map(|(index, operation)| {
            let detail = match operation {
                CanvasOperation::Create { kind, title, .. } => {
                    format!("创建 {kind} 节点：{title}")
                }
                CanvasOperation::Update { node_id, .. } => format!("更新节点 {node_id}"),
                CanvasOperation::Arrange { node_ids, layout } => {
                    format!("按 {layout} 排列 {} 个节点", node_ids.len())
                }
                CanvasOperation::Connect {
                    source_id,
                    target_id,
                } => format!("连接 {source_id} → {target_id}"),
                CanvasOperation::Disconnect {
                    source_id,
                    target_id,
                } => format!("断开 {source_id} → {target_id}"),
                CanvasOperation::Group { node_ids, title } => {
                    format!("将 {} 个节点分组为：{title}", node_ids.len())
                }
                CanvasOperation::Ungroup { group_id } => format!("解除分组 {group_id}"),
                CanvasOperation::Generate {
                    kind,
                    prompt,
                    ..
                } => format!(
                    "生成 {kind} 节点（使用当前画布生成配置；图像/视频会在批准后运行）\n提示：{prompt}"
                ),
            };
            format!("{}. {detail}", index + 1)
        })
        .collect::<Vec<_>>()
        .join("\n");
    if lines.as_bytes().len() > MAX_VISIBLE_MUTATION_BYTES {
        return Err(CanvasAgentError::new("canvas-agent-preview-too-large"));
    }
    Ok(lines)
}

fn unique_id(prefix: &str, used: &HashSet<String>) -> String {
    for nonce in 0..128u64 {
        let digest = Sha256::digest(format!(
            "{prefix}\0{}\0{}\0{nonce}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let id = format!("{prefix}-{:x}", digest);
        let id = id[..(prefix.len() + 13).min(id.len())].to_owned();
        if !used.contains(&id) {
            return id;
        }
    }
    format!("{prefix}-fallback")
}

fn apply_operations(
    document: &mut CanvasDocument,
    operations: &[CanvasOperation],
    generated: Option<&CanvasGenerationOutput>,
) -> Result<(), CanvasAgentError> {
    let nodes = document
        .nodes
        .as_array_mut()
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
    let edges = document
        .edges
        .as_array_mut()
        .ok_or_else(|| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
    for operation in operations {
        let used = nodes
            .iter()
            .filter_map(|node| node.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect::<HashSet<_>>();
        match operation {
            CanvasOperation::Create {
                kind,
                title,
                text,
                reference_token,
                x,
                y,
            } => {
                let id = unique_id("agent-node", &used);
                let (node_kind, role, payload) = match kind.as_str() {
                    "note-ref" => ("noteRef", "reference", reference_token.clone()),
                    "material-ref" => ("image", "reference", reference_token.clone()),
                    _ => ("text", "text", None),
                };
                nodes.push(json!({
                    "id": id,
                    "type": "spike",
                    "position": {"x":x,"y":y},
                    "data": {
                        "kind": node_kind,
                        "role": role,
                        "label": title,
                        "result": text,
                        "payload": payload,
                        "capabilitiesVersion": 1
                    }
                }));
            }
            CanvasOperation::Update {
                node_id,
                title,
                text,
            } => {
                let node = nodes
                    .iter_mut()
                    .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
                    .ok_or_else(|| CanvasAgentError::new("canvas-agent-node-not-found"))?;
                let data = node
                    .get_mut("data")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
                if let Some(title) = title {
                    data.insert("label".to_owned(), Value::String(title.clone()));
                }
                if let Some(text) = text {
                    data.insert("result".to_owned(), Value::String(text.clone()));
                }
            }
            CanvasOperation::Arrange { node_ids, layout } => {
                for (index, node_id) in node_ids.iter().enumerate() {
                    let node = nodes
                        .iter_mut()
                        .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
                        .ok_or_else(|| CanvasAgentError::new("canvas-agent-node-not-found"))?;
                    let position = node
                        .get_mut("position")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| CanvasAgentError::new("canvas-agent-storage-invalid"))?;
                    let (column, row) = match layout.as_str() {
                        "column" => (0usize, index),
                        "grid" => (index % 3, index / 3),
                        _ => (index, 0usize),
                    };
                    position.insert("x".to_owned(), json!(120.0 + column as f64 * 360.0));
                    position.insert("y".to_owned(), json!(120.0 + row as f64 * 280.0));
                }
            }
            CanvasOperation::Connect {
                source_id,
                target_id,
            } => {
                if !used.contains(source_id) || !used.contains(target_id) || source_id == target_id
                {
                    return Err(CanvasAgentError::new("canvas-agent-node-not-found"));
                }
                if edges.iter().any(|edge| {
                    edge.get("source").and_then(Value::as_str) == Some(source_id)
                        && edge.get("target").and_then(Value::as_str) == Some(target_id)
                }) {
                    continue;
                }
                let edge_used = edges
                    .iter()
                    .filter_map(|edge| edge.get("id").and_then(Value::as_str).map(str::to_owned))
                    .collect::<HashSet<_>>();
                edges.push(json!({
                    "id": unique_id("agent-edge", &edge_used),
                    "source": source_id,
                    "target": target_id,
                    "data": {"role":"flow","semanticVersion":1}
                }));
            }
            CanvasOperation::Disconnect {
                source_id,
                target_id,
            } => edges.retain(|edge| {
                !(edge.get("source").and_then(Value::as_str) == Some(source_id)
                    && edge.get("target").and_then(Value::as_str) == Some(target_id))
            }),
            CanvasOperation::Group { node_ids, title } => {
                if node_ids.len() < 2 || node_ids.iter().any(|node_id| !used.contains(node_id)) {
                    return Err(CanvasAgentError::new("canvas-agent-node-not-found"));
                }
                let group_id = unique_id("agent-group", &used);
                nodes.push(json!({
                    "id":group_id,
                    "type":"group",
                    "position":{"x":80.0,"y":80.0},
                    "style":{"width":900.0,"height":620.0},
                    "dragHandle":".canvas-group-drag-handle",
                    "data":{"kind":"group","role":"container","label":title,"groupMemberCount":node_ids.len()}
                }));
                for node_id in node_ids {
                    let node = nodes
                        .iter_mut()
                        .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
                        .ok_or_else(|| CanvasAgentError::new("canvas-agent-node-not-found"))?;
                    if let Some(object) = node.as_object_mut() {
                        object.insert("parentId".to_owned(), Value::String(group_id.clone()));
                        object.insert("extent".to_owned(), Value::String("parent".to_owned()));
                    }
                }
            }
            CanvasOperation::Ungroup { group_id } => {
                let group_position = nodes
                    .iter()
                    .find(|node| node.get("id").and_then(Value::as_str) == Some(group_id))
                    .and_then(|node| node.get("position"))
                    .cloned()
                    .ok_or_else(|| CanvasAgentError::new("canvas-agent-node-not-found"))?;
                let group_x = group_position
                    .get("x")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let group_y = group_position
                    .get("y")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                nodes.retain(|node| node.get("id").and_then(Value::as_str) != Some(group_id));
                for node in nodes
                    .iter_mut()
                    .filter(|node| node.get("parentId").and_then(Value::as_str) == Some(group_id))
                {
                    let x = node
                        .get("position")
                        .and_then(|position| position.get("x"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    let y = node
                        .get("position")
                        .and_then(|position| position.get("y"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    if let Some(object) = node.as_object_mut() {
                        object.remove("parentId");
                        object.remove("extent");
                        object.insert("position".to_owned(), json!({"x":group_x+x,"y":group_y+y}));
                    }
                }
            }
            CanvasOperation::Generate { kind, prompt, x, y } => {
                let id = unique_id("agent-gen", &used);
                let now = chrono::Utc::now().to_rfc3339();
                let output = generated
                    .ok_or_else(|| CanvasAgentError::new("canvas-agent-generation-unavailable"))?;
                let data = match kind.as_str() {
                    "text" => {
                        let text = output
                            .text
                            .as_deref()
                            .filter(|value| safe_text(value, MAX_VISIBLE_MUTATION_BYTES))
                            .ok_or_else(|| {
                                CanvasAgentError::new("canvas-agent-generation-invalid")
                            })?;
                        json!({
                            "kind":"text","role":"text","label":text,"result":text,
                            "generationPrompt":prompt,"generationKind":kind,
                            "generationModel":output.model_label.as_deref().unwrap_or("当前模型"),
                            "generatedAt":now,
                            "capabilitiesVersion":1
                        })
                    }
                    "image" | "video" => {
                        let material_id = output
                            .material_id
                            .as_deref()
                            .filter(|value| safe_id(value))
                            .ok_or_else(|| {
                                CanvasAgentError::new("canvas-agent-generation-invalid")
                            })?;
                        let media_url = output
                            .media_url
                            .as_deref()
                            .filter(|value| !value.is_empty() && value.len() <= 4096)
                            .ok_or_else(|| {
                                CanvasAgentError::new("canvas-agent-generation-invalid")
                            })?;
                        json!({
                            "kind":kind,"role":kind,"label":prompt,
                            "materialId":material_id,"mediaUrl":media_url,
                            "thumbnailUrl":output.thumbnail_url,
                            "generationPrompt":prompt,"generationKind":kind,
                            "generationModel":output.model_label.as_deref().unwrap_or("当前模型"),
                            "generatedAt":now,
                            "capabilitiesVersion":1
                        })
                    }
                    _ => return Err(CanvasAgentError::new("canvas-agent-generation-invalid")),
                };
                nodes.push(json!({
                    "id":id,
                    "type":"spike",
                    "position":{"x":x,"y":y},
                    "data":data
                }));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;

    use super::*;

    struct TestPermit {
        binding: CanvasWriteBinding,
        consumed: AtomicBool,
    }

    impl CanvasWritePermit for TestPermit {
        fn consume(&self, binding: &CanvasWriteBinding) -> Result<(), CanvasAgentError> {
            if binding != &self.binding
                || self
                    .consumed
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
            {
                return Err(CanvasAgentError::new("agent-write-permit-invalid"));
            }
            Ok(())
        }
    }

    struct BlockingPermit {
        binding: CanvasWriteBinding,
        consumed: AtomicBool,
        entered: Mutex<Option<mpsc::SyncSender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl CanvasWritePermit for BlockingPermit {
        fn consume(&self, binding: &CanvasWriteBinding) -> Result<(), CanvasAgentError> {
            if binding != &self.binding
                || self
                    .consumed
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
            {
                return Err(CanvasAgentError::new("agent-write-permit-invalid"));
            }
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered
                    .send(())
                    .map_err(|_| CanvasAgentError::new("canvas-agent-test-failed"))?;
            }
            self.release
                .lock()
                .unwrap()
                .recv()
                .map_err(|_| CanvasAgentError::new("canvas-agent-test-failed"))
        }
    }

    struct TestGenerationExecutor {
        calls: Arc<AtomicUsize>,
    }

    impl CanvasGenerationExecutor for TestGenerationExecutor {
        fn generate(
            &self,
            request: &CanvasGenerationRequest,
            cancelled: &(dyn Fn() -> bool + Send + Sync),
            _journal: &dyn CanvasGenerationJournal,
        ) -> Result<CanvasGenerationOutput, CanvasAgentError> {
            if cancelled() {
                return Err(CanvasAgentError::new("canvas-agent-cancelled"));
            }
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(CanvasGenerationOutput {
                text: (request.kind == "text").then(|| "generated text".to_owned()),
                material_id: None,
                media_url: None,
                thumbnail_url: None,
                model_label: Some("server-model".to_owned()),
            })
        }
    }

    struct StagedGenerationExecutor;

    impl CanvasGenerationExecutor for StagedGenerationExecutor {
        fn generate(
            &self,
            request: &CanvasGenerationRequest,
            cancelled: &(dyn Fn() -> bool + Send + Sync),
            journal: &dyn CanvasGenerationJournal,
        ) -> Result<CanvasGenerationOutput, CanvasAgentError> {
            journal.transition(CanvasGenerationStage::ProviderRequested, None, None)?;
            if cancelled() {
                return Err(CanvasAgentError::new("canvas-agent-cancelled"));
            }
            journal.transition(CanvasGenerationStage::ProviderSucceeded, None, None)?;
            if matches!(request.kind.as_str(), "image" | "video") {
                journal.transition(
                    CanvasGenerationStage::Materializing,
                    None,
                    Some(&"d".repeat(64)),
                )?;
                journal.transition(
                    CanvasGenerationStage::MaterialCommitted,
                    Some("material-safe"),
                    Some(&"d".repeat(64)),
                )?;
            }
            Ok(CanvasGenerationOutput {
                text: (request.kind == "text").then(|| "generated text".to_owned()),
                material_id: (request.kind != "text").then(|| "material-safe".to_owned()),
                media_url: (request.kind != "text").then(|| "asset://material-safe".to_owned()),
                thumbnail_url: None,
                model_label: Some("server-model".to_owned()),
            })
        }
    }

    struct RecordingJournal {
        stages: Mutex<Vec<CanvasGenerationStage>>,
        fail_at: Option<CanvasGenerationStage>,
        cancel_at: Option<CanvasGenerationStage>,
        cancelled: Arc<AtomicBool>,
    }

    impl RecordingJournal {
        fn new(
            fail_at: Option<CanvasGenerationStage>,
            cancel_at: Option<CanvasGenerationStage>,
            cancelled: Arc<AtomicBool>,
        ) -> Self {
            Self {
                stages: Mutex::new(Vec::new()),
                fail_at,
                cancel_at,
                cancelled,
            }
        }

        fn stages(&self) -> Vec<CanvasGenerationStage> {
            self.stages.lock().unwrap().clone()
        }
    }

    impl CanvasGenerationJournal for RecordingJournal {
        fn transition(
            &self,
            stage: CanvasGenerationStage,
            _material_id: Option<&str>,
            _output_digest: Option<&str>,
        ) -> Result<(), CanvasAgentError> {
            self.stages.lock().unwrap().push(stage);
            if self.cancel_at == Some(stage) {
                self.cancelled.store(true, Ordering::SeqCst);
            }
            if self.fail_at == Some(stage) {
                return Err(CanvasAgentError::new("agent-run-ledger-unavailable"));
            }
            Ok(())
        }
    }

    fn fixture_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "luckyray-canvas-agent-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    fn write_fixture(root: &Path, canvas_id: &str) {
        let mut document = CanvasDocument {
            schema_version: 2,
            canvas_id: canvas_id.to_owned(),
            name: "Fixture".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            nodes: json!([{
                "id":"node-1",
                "type":"spike",
                "position":{"x":0.0,"y":0.0},
                "data":{"kind":"text","role":"text","label":"before","result":"before"}
            }]),
            edges: json!([]),
            viewport: json!({"x":0.0,"y":0.0,"zoom":1.0}),
            generation_history: json!([]),
            revision: 1,
            content_digest: String::new(),
            agent_receipts: Vec::new(),
        };
        document.content_digest = content_digest(&document).unwrap();
        let path = canvas_path(root, canvas_id).unwrap();
        fs::write(path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    }

    #[test]
    fn strict_mutation_parser_rejects_arbitrary_patch_and_caps_operations() {
        let error = parse_mutations(&json!({
            "requestId":"request-1",
            "operations":[{"op":"patch","path":"PRIVATE/path","value":"x"}]
        }))
        .unwrap_err();
        assert_eq!(error.code, "canvas-agent-input-invalid");

        let operations = (0..=MAX_OPERATIONS)
            .map(|index| json!({"op":"update","nodeId":format!("node-{index}"),"title":"x"}))
            .collect::<Vec<_>>();
        assert_eq!(
            parse_mutations(&json!({"requestId":"request-2","operations":operations}))
                .unwrap_err()
                .code,
            "canvas-agent-input-invalid"
        );
    }

    #[test]
    fn generation_never_accepts_model_owned_background_or_paths() {
        let error = parse_generation(&json!({
            "requestId":"request-1",
            "kind":"image",
            "prompt":"safe",
            "model":"safe-model",
            "background":true,
            "path":"C:\\PRIVATE"
        }))
        .unwrap_err();
        assert_eq!(error.code, "canvas-agent-input-invalid");
        assert_eq!(
            parse_generation(&json!({
                "requestId":"request-2",
                "kind":"image",
                "prompt":"safe",
                "model":"safe-model",
                "x":0,
                "y":0
            }))
            .unwrap_err()
            .code,
            "canvas-agent-input-invalid"
        );
    }

    #[test]
    fn canonical_digest_excludes_revision_and_updated_at() {
        let mut document = CanvasDocument {
            schema_version: 2,
            canvas_id: "c-safe".into(),
            name: "safe".into(),
            created_at: "a".into(),
            updated_at: "b".into(),
            nodes: json!([{"id":"n1","data":{"label":"safe","kind":"text"}}]),
            edges: json!([]),
            viewport: json!({"zoom":1,"x":0,"y":0}),
            generation_history: json!([]),
            revision: 1,
            content_digest: String::new(),
            agent_receipts: Vec::new(),
        };
        let first = content_digest(&document).unwrap();
        document.updated_at = "changed".into();
        document.revision = 999;
        document.content_digest = "forged".into();
        assert_eq!(content_digest(&document).unwrap(), first);
    }

    #[test]
    fn approved_mutation_commits_once_and_stale_revision_never_overwrites() {
        let root = fixture_root("cas");
        write_fixture(&root, "canvas-1");
        let service = CanvasAgentService::new(&root);
        service.activate("canvas-1").unwrap();
        let scope = service.current_scope().unwrap();
        let input = json!({
            "requestId":"request-1",
            "operations":[{"op":"update","nodeId":"node-1","title":"after","text":"after"}]
        });
        let prepared = service
            .prepare(
                scope,
                "canvas.mutate",
                &input,
                CanvasWriteScope {
                    local_turn_id: "turn-local".into(),
                    engine_session_id: "session-engine".into(),
                    engine_turn_id: "turn-engine".into(),
                    tool_call_id: "tool-call".into(),
                    generation: 1,
                },
                [7; 32],
            )
            .unwrap();
        let permit = TestPermit {
            binding: prepared.binding.clone(),
            consumed: AtomicBool::new(false),
        };
        let duplicate = prepared.clone();
        let operation_digest = duplicate.operation_digest.clone();
        let result = service.execute(scope, prepared, &permit).unwrap();
        assert_eq!(result["revision"], 2);
        assert_eq!(
            service
                .reconcile_artifact("canvas-1", &operation_digest, 1)
                .unwrap(),
            CanvasArtifactReconciliation::Committed
        );
        assert_eq!(
            service
                .validate_committed_artifact("canvas-1", &operation_digest)
                .unwrap(),
            "canvas-1"
        );
        let saved = load_document(&root, "canvas-1").unwrap();
        assert_eq!(saved.nodes[0]["data"]["label"], "after");
        assert_eq!(
            service.execute(scope, duplicate, &permit).unwrap_err().code,
            "canvas-agent-revision-conflict"
        );
        assert_eq!(load_document(&root, "canvas-1").unwrap().revision, 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normal_autosave_and_agent_commit_share_one_canvas_cas() {
        let root = fixture_root("normal-agent-cas");
        write_fixture(&root, "canvas-shared-save");
        let service = CanvasAgentService::new(&root);
        service.activate("canvas-shared-save").unwrap();
        let scope = service.current_scope().unwrap();
        let prepared = service
            .prepare(
                scope,
                "canvas.mutate",
                &json!({
                    "requestId":"request-agent-save",
                    "operations":[{"op":"update","nodeId":"node-1","title":"agent","text":"agent"}]
                }),
                CanvasWriteScope {
                    local_turn_id: "turn-local".into(),
                    engine_session_id: "session-engine".into(),
                    engine_turn_id: "turn-engine".into(),
                    tool_call_id: "tool-call".into(),
                    generation: 1,
                },
                [17; 32],
            )
            .unwrap();
        let (entered_tx, entered_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::sync_channel(0);
        let permit = Arc::new(BlockingPermit {
            binding: prepared.binding.clone(),
            consumed: AtomicBool::new(false),
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
        });
        let agent_service = service.clone();
        let agent_permit = permit.clone();
        let agent = std::thread::spawn(move || {
            agent_service.execute(scope, prepared, agent_permit.as_ref())
        });
        entered_rx.recv().unwrap();

        let mut normal = load_document(&root, "canvas-shared-save").unwrap();
        normal.nodes[0]["data"]["label"] = json!("normal");
        normal.nodes[0]["data"]["result"] = json!("normal");
        let normal_result = service.save_normal_canvas(normal).unwrap();
        assert_eq!(normal_result.revision, 2);

        release_tx.send(()).unwrap();
        assert_eq!(
            agent.join().unwrap().unwrap_err().code,
            "canvas-agent-revision-conflict"
        );
        let saved = load_document(&root, "canvas-shared-save").unwrap();
        assert_eq!(saved.nodes[0]["data"]["label"], "normal");
        assert!(saved.agent_receipts.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normal_rename_and_agent_commit_share_one_canvas_cas() {
        let root = fixture_root("rename-agent-cas");
        write_fixture(&root, "canvas-shared-rename");
        let service = CanvasAgentService::new(&root);
        service.activate("canvas-shared-rename").unwrap();
        let scope = service.current_scope().unwrap();
        let original = load_document(&root, "canvas-shared-rename").unwrap();
        let prepared = service
            .prepare(
                scope,
                "canvas.mutate",
                &json!({
                    "requestId":"request-agent-rename",
                    "operations":[{"op":"update","nodeId":"node-1","title":"agent","text":"agent"}]
                }),
                CanvasWriteScope {
                    local_turn_id: "turn-local".into(),
                    engine_session_id: "session-engine".into(),
                    engine_turn_id: "turn-engine".into(),
                    tool_call_id: "tool-call".into(),
                    generation: 1,
                },
                [18; 32],
            )
            .unwrap();
        let (entered_tx, entered_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::sync_channel(0);
        let permit = Arc::new(BlockingPermit {
            binding: prepared.binding.clone(),
            consumed: AtomicBool::new(false),
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
        });
        let agent_service = service.clone();
        let agent_permit = permit.clone();
        let agent = std::thread::spawn(move || {
            agent_service.execute(scope, prepared, agent_permit.as_ref())
        });
        entered_rx.recv().unwrap();

        let renamed = service
            .rename_normal_canvas(
                "canvas-shared-rename",
                "User rename",
                original.revision,
                &original.content_digest,
            )
            .unwrap();
        assert_eq!(renamed.name, "User rename");
        assert_eq!(renamed.revision, 2);

        release_tx.send(()).unwrap();
        assert_eq!(
            agent.join().unwrap().unwrap_err().code,
            "canvas-agent-revision-conflict"
        );
        let saved = load_document(&root, "canvas-shared-rename").unwrap();
        assert_eq!(saved.name, "User rename");
        assert_eq!(saved.nodes[0]["data"]["label"], "before");
        assert!(saved.agent_receipts.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn generation_calls_backend_executor_only_after_one_shot_permit() {
        let root = fixture_root("generation");
        write_fixture(&root, "canvas-generation");
        let service = CanvasAgentService::new(&root);
        let calls = Arc::new(AtomicUsize::new(0));
        service.set_generation_executor(Arc::new(TestGenerationExecutor {
            calls: calls.clone(),
        }));
        service.activate("canvas-generation").unwrap();
        let scope = service.current_scope().unwrap();
        let prepared = service
            .prepare(
                scope,
                "canvas.generate",
                &json!({
                    "requestId":"generation-request",
                    "kind":"text",
                    "prompt":"create a safe summary",
                    "x":20,
                    "y":30
                }),
                CanvasWriteScope {
                    local_turn_id: "turn-local".into(),
                    engine_session_id: "session-engine".into(),
                    engine_turn_id: "turn-engine".into(),
                    tool_call_id: "tool-call".into(),
                    generation: 1,
                },
                [8; 32],
            )
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let permit = TestPermit {
            binding: prepared.binding.clone(),
            consumed: AtomicBool::new(false),
        };
        service.execute(scope, prepared, &permit).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let saved = load_document(&root, "canvas-generation").unwrap();
        let generated = saved
            .nodes
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["data"]["generationKind"] == "text")
            .unwrap();
        assert_eq!(generated["data"]["label"], "generated text");
        assert_eq!(generated["data"]["generationModel"], "server-model");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn text_image_and_video_generation_publish_ordered_durable_stages() {
        for kind in ["text", "image", "video"] {
            let root = fixture_root(&format!("stages-{kind}"));
            let canvas_id = format!("canvas-{kind}");
            write_fixture(&root, &canvas_id);
            let service = CanvasAgentService::new(&root);
            service.set_generation_executor(Arc::new(StagedGenerationExecutor));
            service.activate(&canvas_id).unwrap();
            let scope = service.current_scope().unwrap();
            let prepared = service
                .prepare(
                    scope,
                    "canvas.generate",
                    &json!({
                        "requestId":format!("request-{kind}"),
                        "kind":kind,
                        "prompt":"safe prompt",
                        "x":20,
                        "y":30
                    }),
                    CanvasWriteScope {
                        local_turn_id: "turn-local".into(),
                        engine_session_id: "session-engine".into(),
                        engine_turn_id: "turn-engine".into(),
                        tool_call_id: "tool-call".into(),
                        generation: 1,
                    },
                    [9; 32],
                )
                .unwrap();
            let permit = TestPermit {
                binding: prepared.binding.clone(),
                consumed: AtomicBool::new(false),
            };
            let cancelled = Arc::new(AtomicBool::new(false));
            let journal = RecordingJournal::new(None, None, cancelled.clone());
            service
                .execute_with_cancel(
                    scope,
                    prepared,
                    &permit,
                    &|| cancelled.load(Ordering::SeqCst),
                    &journal,
                )
                .unwrap();
            let mut expected = vec![
                CanvasGenerationStage::ProviderRequested,
                CanvasGenerationStage::ProviderSucceeded,
            ];
            if kind != "text" {
                expected.extend([
                    CanvasGenerationStage::Materializing,
                    CanvasGenerationStage::MaterialCommitted,
                ]);
            }
            expected.extend([
                CanvasGenerationStage::CanvasAttaching,
                CanvasGenerationStage::CanvasCommitted,
            ]);
            assert_eq!(journal.stages(), expected);
            assert_eq!(load_document(&root, &canvas_id).unwrap().revision, 2);
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn stop_or_ledger_failure_cannot_start_the_next_dangerous_stage() {
        let root = fixture_root("stage-failures");
        write_fixture(&root, "canvas-stage-failures");
        let service = CanvasAgentService::new(&root);
        service.set_generation_executor(Arc::new(StagedGenerationExecutor));
        service.activate("canvas-stage-failures").unwrap();
        let scope = service.current_scope().unwrap();

        let prepare = |request_id: &str| {
            service
                .prepare(
                    scope,
                    "canvas.generate",
                    &json!({
                        "requestId":request_id,
                        "kind":"text",
                        "prompt":"safe prompt",
                        "x":20,
                        "y":30
                    }),
                    CanvasWriteScope {
                        local_turn_id: "turn-local".into(),
                        engine_session_id: "session-engine".into(),
                        engine_turn_id: format!("turn-{request_id}"),
                        tool_call_id: format!("tool-{request_id}"),
                        generation: 1,
                    },
                    [10; 32],
                )
                .unwrap()
        };

        let cancelled = Arc::new(AtomicBool::new(false));
        let prepared = prepare("request-stop");
        let permit = TestPermit {
            binding: prepared.binding.clone(),
            consumed: AtomicBool::new(false),
        };
        let stop_journal = RecordingJournal::new(
            None,
            Some(CanvasGenerationStage::ProviderSucceeded),
            cancelled.clone(),
        );
        assert_eq!(
            service
                .execute_with_cancel(
                    scope,
                    prepared,
                    &permit,
                    &|| cancelled.load(Ordering::SeqCst),
                    &stop_journal,
                )
                .unwrap_err()
                .code,
            "canvas-agent-cancelled"
        );
        assert_eq!(
            stop_journal.stages(),
            vec![
                CanvasGenerationStage::ProviderRequested,
                CanvasGenerationStage::ProviderSucceeded
            ]
        );
        assert_eq!(
            load_document(&root, "canvas-stage-failures")
                .unwrap()
                .revision,
            1
        );

        let cancelled = Arc::new(AtomicBool::new(false));
        let prepared = prepare("request-before-commit");
        let permit = TestPermit {
            binding: prepared.binding.clone(),
            consumed: AtomicBool::new(false),
        };
        let fail_before_commit = RecordingJournal::new(
            Some(CanvasGenerationStage::CanvasAttaching),
            None,
            cancelled.clone(),
        );
        assert_eq!(
            service
                .execute_with_cancel(
                    scope,
                    prepared,
                    &permit,
                    &|| cancelled.load(Ordering::SeqCst),
                    &fail_before_commit,
                )
                .unwrap_err()
                .code,
            "agent-run-ledger-unavailable"
        );
        assert_eq!(
            load_document(&root, "canvas-stage-failures")
                .unwrap()
                .revision,
            1
        );

        let cancelled = Arc::new(AtomicBool::new(false));
        let prepared = prepare("request-after-commit");
        let operation_digest = prepared.operation_digest.clone();
        let permit = TestPermit {
            binding: prepared.binding.clone(),
            consumed: AtomicBool::new(false),
        };
        let fail_after_commit = RecordingJournal::new(
            Some(CanvasGenerationStage::CanvasCommitted),
            None,
            cancelled.clone(),
        );
        let committed = service
            .execute_with_cancel(
                scope,
                prepared,
                &permit,
                &|| cancelled.load(Ordering::SeqCst),
                &fail_after_commit,
            )
            .unwrap();
        assert_eq!(committed["committedWarning"], true);
        assert_eq!(
            service
                .reconcile_artifact("canvas-stage-failures", &operation_digest, 1)
                .unwrap(),
            CanvasArtifactReconciliation::Committed
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inspect_is_bounded_and_never_projects_hidden_metadata() {
        let root = fixture_root("inspect");
        write_fixture(&root, "canvas-2");
        let path = canvas_path(&root, "canvas-2").unwrap();
        let mut document: CanvasDocument =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        document.nodes[0]["data"]["privatePath"] = json!("C:\\PRIVATE\\secret");
        document.nodes[0]["data"]["providerKey"] = json!("PRIVATE-KEY");
        document.content_digest = content_digest(&document).unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
        let service = CanvasAgentService::new(&root);
        service.activate("canvas-2").unwrap();
        let projected = service.inspect(service.current_scope().unwrap()).unwrap();
        let serialized = serde_json::to_string(&projected).unwrap();
        assert!(serialized.contains("before"));
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("secret"));
        let _ = fs::remove_dir_all(root);
    }
}
