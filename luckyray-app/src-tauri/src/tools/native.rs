//! Native MCP/CLI product operations. The registry is the sole external input
//! validator; these adapters reuse the current Knowledge and Canvas owners.
//! No filesystem path, browser, shell, Agent turn, or generation authority.
use super::*;
use crate::knowledge::{KnowledgeInsertInput, KnowledgeMoveInput};

pub(super) const IDS: &[&str] = &[
    "knowledge.list",
    "knowledge.tags",
    "knowledge.relations",
    "knowledge.replace",
    "knowledge.insert",
    "knowledge.move",
    "canvas.list",
    "canvas.read",
    "canvas.create",
    "canvas.save",
    "canvas.rename",
];

pub(super) fn handles(id: &str) -> bool {
    IDS.contains(&id)
}

fn receipt_schema() -> Value {
    let document = object_schema(
        vec![
            ("committed", json!({"const":true})),
            ("document", document_output_schema()),
            ("position", string_schema(1, 32)),
            ("indexWarning", json!({"type":"any"})),
            ("indexStale", json!({"type":"boolean"})),
        ],
        &["committed", "document"],
    );
    let canvas = object_schema(
        vec![
            ("committed", json!({"const":true})),
            ("canvas", generic_output_schema()),
        ],
        &["committed", "canvas"],
    );
    let fallback = object_schema(
        vec![
            ("committed", json!({"const":true})),
            ("outputUnavailable", json!({"const":true})),
        ],
        &["committed", "outputUnavailable"],
    );
    json!({"oneOf":[document,canvas,fallback]})
}

fn page_schema() -> Value {
    object_schema(
        vec![
            ("offset", integer_schema(0, i64::MAX)),
            ("limit", integer_schema(1, 100)),
        ],
        &[],
    )
}

pub(super) fn definitions(has_vault: bool) -> Vec<ToolDefinition> {
    let knowledge = if has_vault {
        available()
    } else {
        unavailable(
            "knowledge-vault-required",
            "Open a real Knowledge Vault before using this tool",
        )
    };
    // These existing owners require Windows replacement fences / exclusive
    // commits. Do not advertise successful operations on unsupported platforms.
    let guarded_knowledge = if !has_vault || cfg!(windows) {
        knowledge.clone()
    } else {
        unavailable(
            "knowledge-platform-unsupported",
            "This operation requires the Windows Knowledge owner",
        )
    };
    let mut insert = document_mutation_schema("text", string_schema(1, MAX_WRITE_CONTENT_BYTES));
    for branch in insert["oneOf"].as_array_mut().expect("identity branches") {
        branch["properties"]["offset"] = integer_schema(0, i64::MAX);
        branch["required"]
            .as_array_mut()
            .expect("required")
            .push(json!("offset"));
    }
    let canvas_cas = || {
        vec![
            ("canvasId", string_schema(1, 128)),
            ("expectedRevision", integer_schema(0, i64::MAX)),
            ("expectedContentDigest", string_schema(64, 64)),
            ("requestId", string_schema(1, 96)),
        ]
    };
    let node = json!({"type":"object","additionalProperties":true,"required":["id","position","data"],"properties":{
        "id":string_schema(1,128),
        "position":object_schema(vec![("x",json!({"type":"number"})),("y",json!({"type":"number"}))], &["x","y"]),
        "data":{"type":"object","additionalProperties":true,"required":["kind","label"],"properties":{
            "kind":enum_schema(&["text","image","video","noteRef","aiPrompt","aiResult","generator","group"]),
            "label":{"type":"string"}
        }}
    }});
    let edge = json!({"type":"object","additionalProperties":true,"required":["id","source","target"],"properties":{
        "id":string_schema(1,128),"source":string_schema(1,128),"target":string_schema(1,128)
    }});
    let mut save = canvas_cas();
    save.extend([
        (
            "nodes",
            json!({"type":"array","maxItems":2000,"items":node}),
        ),
        (
            "edges",
            json!({"type":"array","maxItems":4000,"items":edge}),
        ),
        (
            "viewport",
            object_schema(
                vec![
                    ("x", json!({"type":"number"})),
                    ("y", json!({"type":"number"})),
                    (
                        "zoom",
                        json!({"type":"number","minimum":0.01,"maximum":100}),
                    ),
                ],
                &["x", "y", "zoom"],
            ),
        ),
        ("generationHistory", json!({"type":"array","maxItems":2000})),
    ]);
    let mut rename = canvas_cas();
    rename.push(("name", string_schema(1, 1024)));
    vec![
        definition("knowledge.list","List Knowledge documents","Lists a bounded page of documents in the current real Vault. Use its vaultId and document references for writes.",ToolRisk::Read,page_schema(),generic_output_schema(),knowledge.clone(),"read-only",1024,MAX_TOOL_OUTPUT_BYTES),
        definition("knowledge.tags","List Knowledge tags","Lists a bounded page of tag counts in the current real Vault.",ToolRisk::Read,page_schema(),generic_output_schema(),guarded_knowledge.clone(),"read-only",1024,MAX_TOOL_OUTPUT_BYTES),
        definition("knowledge.relations","Read Knowledge relations","Reads headings, links, embeds, tags and backlinks for an identified current-Vault document. Fails rather than truncating an oversized result.",ToolRisk::Read,document_identity_schema(false),generic_output_schema(),guarded_knowledge.clone(),"read-only",4096,MAX_TOOL_OUTPUT_BYTES),
        definition("knowledge.replace","Replace Knowledge document","Replaces Markdown through the existing Knowledge owner with required Vault and revision checks. Import Markdown with knowledge.create; export its content with knowledge.read.",ToolRisk::Dangerous,document_mutation_schema("content",string_schema(0,MAX_WRITE_CONTENT_BYTES)),receipt_schema(),guarded_knowledge.clone(),"request-id-cas",MAX_WRITE_CONTENT_BYTES+8192,MAX_TOOL_OUTPUT_BYTES),
        definition("knowledge.insert","Insert into Knowledge document","Inserts literal text at a UTF-16 offset with required Vault and revision checks; does not target the active editor implicitly.",ToolRisk::Write,insert,receipt_schema(),guarded_knowledge.clone(),"request-id-cas",MAX_WRITE_CONTENT_BYTES+8192,MAX_TOOL_OUTPUT_BYTES),
        definition("knowledge.move","Move or rename Knowledge document","Moves a note to a relative Markdown path within the same current Vault, using the product attachment-aware move operation and revision check. The destination parent must already exist.",ToolRisk::Write,document_mutation_schema("relativePath",string_schema(1,512)),receipt_schema(),guarded_knowledge,"request-id-cas",8192,MAX_TOOL_OUTPUT_BYTES),
        definition("canvas.list","List saved Canvases","Lists a bounded page of saved Canvas metadata; does not activate an Agent turn.",ToolRisk::Read,page_schema(),generic_output_schema(),available(),"read-only",1024,MAX_TOOL_OUTPUT_BYTES),
        definition("canvas.read","Read saved Canvas","Reads the complete supported Canvas graph, viewport and generation history by ID. Oversized documents fail, never return a truncated graph suitable for saving.",ToolRisk::Read,object_schema(vec![("canvasId",string_schema(1,128))], &["canvasId"]),generic_output_schema(),available(),"read-only",1024,MAX_TOOL_OUTPUT_BYTES),
        definition("canvas.create","Create empty Canvas","Creates an empty ordinary Canvas through the same storage owner as the desktop UI. Does not execute generation.",ToolRisk::Write,object_schema(vec![("name",string_schema(1,1024)),("requestId",string_schema(1,96))], &["name","requestId"]),receipt_schema(),available(),"request-id",4096,MAX_TOOL_OUTPUT_BYTES),
        definition("canvas.save","Save Canvas graph","Replaces the complete graph, viewport and generation history with revision-and-digest CAS. Preserves server-owned identity, name, timestamps and Agent receipts; does not run nodes or generation.",ToolRisk::Dangerous,object_schema(save,&["canvasId","expectedRevision","expectedContentDigest","requestId","nodes","edges","viewport","generationHistory"]),receipt_schema(),available(),"request-id-cas",MAX_WRITE_CONTENT_BYTES+8192,MAX_TOOL_OUTPUT_BYTES),
        definition("canvas.rename","Rename saved Canvas","Renames a saved Canvas using the current storage owner and revision-and-digest CAS.",ToolRisk::Write,object_schema(rename,&["canvasId","expectedRevision","expectedContentDigest","requestId","name"]),receipt_schema(),available(),"request-id-cas",8192,MAX_TOOL_OUTPUT_BYTES),
    ]
}

pub(super) fn authorize(
    backend: &BackendServices,
    id: &str,
    input: &Value,
) -> Result<(), ToolError> {
    match id {
        "knowledge.list" | "knowledge.tags" => backend
            .knowledge()
            .current_vault_id()
            .map(|_| ())
            .map_err(ToolError::from_knowledge),
        "knowledge.relations" => require_live_vault(backend, &parse_document_ref(input)?.vault_id),
        "knowledge.replace" | "knowledge.insert" | "knowledge.move" => {
            require_expected_vault(input)?;
            require_live_vault(backend, required_string(input, "expectedVaultId")?)
        }
        id if id.starts_with("canvas.") && handles(id) => Ok(()),
        _ => Err(ToolError::new("tool-not-found", "Tool does not exist")),
    }
}

fn page(input: &Value, len: usize) -> (usize, usize, Option<usize>) {
    let offset = optional_u64(input, "offset")
        .unwrap_or(0)
        .min(usize::MAX as u64) as usize;
    let limit = optional_u64(input, "limit").unwrap_or(50) as usize;
    let end = offset.saturating_add(limit).min(len);
    (offset, limit, (end < len).then_some(end))
}
fn canvas_summary(entry: crate::canvas_agent::CanvasIndexEntry) -> Value {
    json!({"canvasId":entry.id,"name":entry.name,"createdAt":entry.created_at,
        "updatedAt":entry.updated_at,"nodeCount":entry.node_count,"edgeCount":entry.edge_count,
        "revision":entry.revision,"contentDigest":entry.content_digest})
}

// Schema validation already establishes shapes. These are the graph identity
// relationships React Flow needs; do not normalize or discard caller fields.
fn validate_graph_identity(input: &Value) -> Result<(), ToolError> {
    let invalid = || {
        ToolError::new(
            "tool-input-invalid",
            "Canvas node and edge identities must be unique and endpoints must exist",
        )
    };
    let mut nodes = std::collections::HashSet::new();
    for node in input["nodes"].as_array().ok_or_else(invalid)? {
        let id = node["id"].as_str().ok_or_else(invalid)?;
        if !nodes.insert(id) {
            return Err(invalid());
        }
    }
    let mut edges = std::collections::HashSet::new();
    for edge in input["edges"].as_array().ok_or_else(invalid)? {
        if !edges.insert(edge["id"].as_str().ok_or_else(invalid)?)
            || !nodes.contains(edge["source"].as_str().ok_or_else(invalid)?)
            || !nodes.contains(edge["target"].as_str().ok_or_else(invalid)?)
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(super) fn execute(
    backend: &BackendServices,
    id: &str,
    input: &Value,
) -> Result<Value, ToolError> {
    match id {
        "knowledge.list" => {
            let snapshot = backend
                .knowledge()
                .refresh_index()
                .map_err(ToolError::from_knowledge)?;
            let (offset, limit, next) = page(input, snapshot.documents.len());
            let documents = snapshot
                .documents
                .iter()
                .skip(offset)
                .take(limit)
                .map(|doc| {
                    json!({
                        "id":crate::knowledge::KnowledgeService::document_id(&doc.document_ref),
                        "documentRef":doc.document_ref,"title":doc.title,"revision":doc.revision,
                        "excerpt":doc.excerpt,
                    })
                })
                .collect::<Vec<_>>();
            Ok(
                json!({"vaultId":snapshot.vault_id,"generation":snapshot.generation,"stale":snapshot.stale,
                "warning":snapshot.refresh_error.map(|warning|json!({"code":warning.code})),
                "documents":documents,"total":snapshot.documents.len(),"nextOffset":next}),
            )
        }
        "knowledge.tags" => {
            let vault_id = backend
                .knowledge()
                .current_vault_id()
                .map_err(ToolError::from_knowledge)?;
            let scope = backend
                .knowledge()
                .capture_workspace_scope(&vault_id)
                .map_err(ToolError::from_knowledge)?;
            let tags = scope.tag_summary().map_err(ToolError::from_knowledge)?;
            let (offset, limit, next) = page(input, tags.len());
            Ok(
                json!({"vaultId":vault_id,"total":tags.len(),"nextOffset":next,
                "tags":tags.into_iter().skip(offset).take(limit).collect::<Vec<_>>()}),
            )
        }
        "knowledge.relations" => {
            let document_ref = parse_document_ref(input)?;
            let scope = backend
                .knowledge()
                .capture_workspace_scope(&document_ref.vault_id)
                .map_err(ToolError::from_knowledge)?;
            let relations = scope
                .document_relations(&document_ref)
                .map_err(ToolError::from_knowledge)?;
            let backlinks = scope
                .backlinks(&document_ref)
                .map_err(ToolError::from_knowledge)?;
            Ok(json!({"documentRef":document_ref,"relations":relations,"backlinks":backlinks}))
        }
        "knowledge.replace" => {
            let mutation = backend
                .knowledge()
                .replace_document(&KnowledgeWriteInput {
                    document_ref: parse_document_ref(input)?,
                    content: required_string(input, "content")?.into(),
                    expected_revision: Some(required_string(input, "expectedRevision")?.into()),
                })
                .map_err(ToolError::from_knowledge)?;
            Ok(mutation_value(&mutation))
        }
        "knowledge.insert" => {
            let offset = usize::try_from(
                optional_u64(input, "offset")
                    .ok_or_else(|| ToolError::new("tool-input-invalid", "offset is invalid"))?,
            )
            .map_err(|_| ToolError::new("tool-input-invalid", "offset is invalid"))?;
            let mutation = backend
                .knowledge()
                .insert_document(&KnowledgeInsertInput {
                    document_ref: parse_document_ref(input)?,
                    offset,
                    text: required_string(input, "text")?.into(),
                    expected_revision: Some(required_string(input, "expectedRevision")?.into()),
                })
                .map_err(ToolError::from_knowledge)?;
            Ok(mutation_value(&mutation))
        }
        "knowledge.move" => {
            let (parent, title) = split_markdown_path(required_string(input, "relativePath")?)?;
            let document = backend
                .knowledge()
                .move_document(&KnowledgeMoveInput {
                    document_ref: parse_document_ref(input)?,
                    title,
                    expected_revision: required_string(input, "expectedRevision")?.into(),
                    // Explicit empty parent means Vault root; None means keep source parent.
                    parent_relative_path: Some(parent.unwrap_or_default()),
                })
                .map_err(ToolError::from_knowledge)?;
            Ok(json!({"committed":true,"document":document_value(&document,false)}))
        }
        "canvas.list" => {
            let entries = backend
                .canvas_agent()
                .list_normal_canvases()
                .map_err(ToolError::from_canvas)?;
            let (offset, limit, next) = page(input, entries.len());
            Ok(json!({"total":entries.len(),"nextOffset":next,
                "canvases":entries.into_iter().skip(offset).take(limit).map(canvas_summary).collect::<Vec<_>>()}))
        }
        "canvas.read" => {
            let doc = backend
                .canvas_agent()
                .read_normal_canvas(required_string(input, "canvasId")?)
                .map_err(ToolError::from_canvas)?;
            Ok(
                json!({"canvasId":doc.canvas_id,"name":doc.name,"createdAt":doc.created_at,"updatedAt":doc.updated_at,
                "nodes":doc.nodes,"edges":doc.edges,"viewport":doc.viewport,"generationHistory":doc.generation_history,
                "revision":doc.revision,"contentDigest":doc.content_digest}),
            )
        }
        "canvas.create" => {
            let now = chrono::Utc::now().to_rfc3339();
            let doc = crate::canvas_agent::CanvasDocument {
                schema_version: 2,
                canvas_id: crate::make_canvas_id(),
                name: required_string(input, "name")?.trim().into(),
                created_at: now.clone(),
                updated_at: now,
                nodes: json!([]),
                edges: json!([]),
                viewport: json!({"x":0,"y":0,"zoom":1}),
                generation_history: json!([]),
                revision: 0,
                content_digest: String::new(),
                agent_receipts: Vec::new(),
            };
            if doc.name.is_empty() {
                return Err(ToolError::new(
                    "tool-input-invalid",
                    "Canvas name must not be blank",
                ));
            }
            let entry = backend
                .canvas_agent()
                .create_normal_canvas(doc)
                .map_err(ToolError::from_canvas)?;
            Ok(json!({"committed":true,"canvas":canvas_summary(entry)}))
        }
        "canvas.rename" => {
            let entry = backend
                .canvas_agent()
                .rename_normal_canvas(
                    required_string(input, "canvasId")?,
                    required_string(input, "name")?,
                    optional_u64(input, "expectedRevision").unwrap_or_default(),
                    required_string(input, "expectedContentDigest")?,
                )
                .map_err(ToolError::from_canvas)?;
            Ok(json!({"committed":true,"canvas":canvas_summary(entry)}))
        }
        "canvas.save" => {
            validate_graph_identity(input)?;
            let mut doc = backend
                .canvas_agent()
                .read_normal_canvas(required_string(input, "canvasId")?)
                .map_err(ToolError::from_canvas)?;
            if doc.revision != optional_u64(input, "expectedRevision").unwrap_or_default()
                || doc.content_digest != required_string(input, "expectedContentDigest")?
            {
                return Err(ToolError::new(
                    "canvas-agent-revision-conflict",
                    "Canvas changed since it was read",
                ));
            }
            doc.nodes = input["nodes"].clone();
            doc.edges = input["edges"].clone();
            doc.viewport = input["viewport"].clone();
            doc.generation_history = input["generationHistory"].clone();
            doc.updated_at = chrono::Utc::now().to_rfc3339();
            let entry = backend
                .canvas_agent()
                .save_normal_canvas(doc)
                .map_err(ToolError::from_canvas)?;
            Ok(json!({"committed":true,"canvas":canvas_summary(entry)}))
        }
        _ => Err(ToolError::new("tool-not-found", "Tool does not exist")),
    }
}
