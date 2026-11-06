#![allow(dead_code, unused_imports)]
//! Compiles the actual native adapter plus real Knowledge/Canvas owners.
//! Full registry authentication/cache and HTTP are NOT replaced or claimed here.
mod knowledge {
    include!(concat!(env!("OUT_DIR"), "/knowledge_owner.rs"));
}
#[path = "../../../src-tauri/src/agent_workspace.rs"]
mod agent_workspace;
#[path = "../../../src-tauri/src/canvas_agent.rs"]
mod canvas_agent;
#[path = "../../../src-tauri/src/materials/models.rs"]
mod materials;
#[path = "../../../src-tauri/src/workspace_graph.rs"]
mod workspace_graph;
mod attachment_file_moves {
    use crate::materials;
    include!(concat!(env!("OUT_DIR"), "/material_move_dto.rs"));
}
fn knowledge_error(error: knowledge::KnowledgeError) -> String {
    serde_json::json!({"code":error.code,"message":error.message}).to_string()
}
fn make_canvas_id() -> String {
    format!("c-proof-{:032x}", rand::random::<u128>())
}
struct BackendServices {
    knowledge: knowledge::KnowledgeService,
    canvas: canvas_agent::CanvasAgentService,
}
impl BackendServices {
    fn knowledge(&self) -> knowledge::KnowledgeService {
        self.knowledge.clone()
    }
    fn canvas_agent(&self) -> canvas_agent::CanvasAgentService {
        self.canvas.clone()
    }
}
mod tools {
    use super::*;
    use knowledge::{KnowledgeDocumentRef, KnowledgeWriteInput};
    use serde_json::{json, Map, Value};
    const MAX_JSON_DEPTH: usize = 16;
    const MAX_JSON_NODES: usize = 20_000;
    const MAX_READ_CONTENT_BYTES: usize = 256 * 1024;
    const MAX_WRITE_CONTENT_BYTES: usize = 512 * 1024;
    const MAX_TOOL_OUTPUT_BYTES: usize = 512 * 1024;
    #[derive(Clone, Copy, Debug, PartialEq, PartialOrd, serde::Serialize)]
    enum ToolRisk {
        Read,
        Write,
        Dangerous,
    }
    #[derive(Debug)]
    struct ToolError {
        code: &'static str,
        message: String,
    }
    impl ToolError {
        fn new(code: &'static str, message: impl Into<String>) -> Self {
            Self {
                code,
                message: message.into(),
            }
        }
        fn from_knowledge(error: knowledge::KnowledgeError) -> Self {
            Self::new(error.code, error.message)
        }
        fn from_canvas(error: canvas_agent::CanvasAgentError) -> Self {
            Self::new(error.code, "Canvas capability operation failed")
        }
    }
    include!(concat!(env!("OUT_DIR"), "/registry_helpers.rs"));
    fn run(backend: &BackendServices, id: &str, input: Value) -> Result<Value, ToolError> {
        let definition = native::definitions(true)
            .into_iter()
            .find(|d| d.id == id)
            .unwrap();
        if serde_json::to_vec(&input).unwrap().len() > definition.max_input_bytes {
            return Err(ToolError::new("tool-input-too-large", "too large"));
        }
        validate_json_limits(&input)?;
        validate_schema(&definition.input_schema, &input, "input")?;
        if definition.risk >= ToolRisk::Write {
            validate_request_id(required_string(&input, "requestId")?)?;
        }
        native::authorize(backend, id, &input)?;
        let result = native::execute(backend, id, &input)?;
        validate_schema(&definition.output_schema, &result, "output")?;
        if serde_json::to_vec(&result).unwrap().len() > definition.max_output_bytes {
            return Err(ToolError::new("tool-output-too-large", "too large"));
        }
        Ok(result)
    }
    pub(super) fn proof(
        backend: &BackendServices,
        vault: &knowledge::KnowledgeVaultRegistration,
        root: &std::path::Path,
    ) {
        validate_definitions(&native::definitions(true)).unwrap();
        let document = backend
            .knowledge()
            .create_document(&knowledge::KnowledgeCreateInput {
                title: "One".into(),
                parent_relative_path: None,
                content: "abc".into(),
            })
            .unwrap();
        let reference = document.summary.document_ref;
        let before = std::fs::read(root.join("vault/One.md")).unwrap();
        assert_eq!(run(backend,"knowledge.replace",json!({"expectedVaultId":vault.id,"documentRef":reference,"expectedRevision":document.revision,"content":"hello","requestId":"replace"})).unwrap_err().code,"knowledge-exclusive-commit-unsupported");
        assert_eq!(run(backend,"knowledge.insert",json!({"expectedVaultId":vault.id,"documentRef":reference,"expectedRevision":document.revision,"text":"!","offset":3,"requestId":"insert"})).unwrap_err().code,"knowledge-exclusive-commit-unsupported");
        assert_eq!(run(backend,"knowledge.move",json!({"expectedVaultId":vault.id,"documentRef":reference,"expectedRevision":document.revision,"relativePath":"Moved.md","requestId":"move"})).unwrap_err().code,"knowledge-exclusive-write-unsupported");
        assert_eq!(std::fs::read(root.join("vault/One.md")).unwrap(), before);
        assert_eq!(
            run(backend, "knowledge.list", json!({"limit":1})).unwrap()["total"],
            1
        );
        assert_eq!(
            run(backend, "knowledge.tags", json!({})).unwrap_err().code,
            "knowledge-vault-unavailable"
        );
        assert_eq!(
            run(
                backend,
                "knowledge.relations",
                json!({"documentRef":reference})
            )
            .unwrap_err()
            .code,
            "knowledge-vault-unavailable"
        );
        println!("PASS actual native note listing + existing non-Windows guarded-read/mutation fail-closed with unchanged bytes (Windows guarded-read/mutation success NOT_RUN)");
        let created = run(
            backend,
            "canvas.create",
            json!({"name":"Fixture","requestId":"create"}),
        )
        .unwrap();
        let id = created["canvas"]["canvasId"].as_str().unwrap();
        let read = run(backend, "canvas.read", json!({"canvasId":id})).unwrap();
        let save = json!({"canvasId":id,"expectedRevision":read["revision"],"expectedContentDigest":read["contentDigest"],"requestId":"save","nodes":[{"id":"n1","position":{"x":0,"y":0},"data":{"kind":"text","label":"safe","unknownPreserved":42}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"generationHistory":[]});
        let _saved = run(backend, "canvas.save", save.clone()).unwrap();
        let read = run(backend, "canvas.read", json!({"canvasId":id})).unwrap();
        assert_eq!(read["nodes"][0]["data"]["unknownPreserved"], 42);
        let path = root.join("app/canvases").join(format!("{id}.json"));
        let before = std::fs::read(&path).unwrap();
        for nodes in [
            json!([null]),
            json!([{}]),
            json!([{"id":"bad","position":{"x":0,"y":0},"data":{"kind":"text"}}]),
        ] {
            let mut bad = save.clone();
            bad["nodes"] = nodes;
            assert_eq!(
                run(backend, "canvas.save", bad).unwrap_err().code,
                "tool-input-invalid"
            );
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
        let mut bad = save.clone();
        bad["edges"] = json!([{"id":"e1","source":"n1","target":"missing"}]);
        assert_eq!(
            run(backend, "canvas.save", bad).unwrap_err().code,
            "tool-input-invalid"
        );
        assert_eq!(
            run(backend, "canvas.save", save).unwrap_err().code,
            "canvas-agent-revision-conflict"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let renamed=run(backend,"canvas.rename",json!({"canvasId":id,"name":"Renamed","expectedRevision":read["revision"],"expectedContentDigest":read["contentDigest"],"requestId":"rename"})).unwrap();
        assert_eq!(renamed["canvas"]["name"], "Renamed");
        assert_eq!(run(backend, "canvas.list", json!({})).unwrap()["total"], 1);
        println!("PASS actual native Canvas list/read/create/save/rename, preserved graph fields, CAS, malformed graph refusal with unchanged bytes");
        let mut large = backend.canvas_agent().read_normal_canvas(id).unwrap();
        large.nodes = json!([{"id":"n1","position":{"x":0,"y":0},"data":{"kind":"text","label":"a".repeat(MAX_TOOL_OUTPUT_BYTES+1)}}]);
        backend.canvas_agent().save_normal_canvas(large).unwrap();
        assert_eq!(
            run(backend, "canvas.read", json!({"canvasId":id}))
                .unwrap_err()
                .code,
            "tool-output-too-large"
        );
        println!("PASS oversized complete Canvas read fails rather than returning truncated graph");
        for id in ["knowledge.replace", "canvas.save"] {
            assert_eq!(
                native::definitions(true)
                    .into_iter()
                    .find(|d| d.id == id)
                    .unwrap()
                    .risk,
                ToolRisk::Dangerous
            );
        }
        for definition in native::definitions(true)
            .into_iter()
            .filter(|d| d.risk >= ToolRisk::Write)
        {
            validate_schema(
                &definition.output_schema,
                &json!({"committed":true,"outputUnavailable":true}),
                "output",
            )
            .unwrap();
        }
        println!(
            "PASS replacement risk + every native write's unambiguous committed fallback schema"
        );
    }
}
fn main() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("app");
    let vault_root = root.path().join("vault");
    std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
    let vault = knowledge::KnowledgeVaultRegistration {
        id: "native-proof-vault".into(),
        name: "proof".into(),
        root_path: vault_root.to_string_lossy().into(),
        mode: "vault-bound".into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        last_opened_at: "2026-10-29T00:00:00Z".into(),
        schema_version: 1,
        link_update_policy: Default::default(),
    };
    std::fs::write(
        vault_root.join(".luckyray/vault.json"),
        serde_json::to_vec(&vault).unwrap(),
    )
    .unwrap();
    let knowledge = knowledge::KnowledgeService::initialize(&app).unwrap();
    knowledge.register_current_vault(&vault).unwrap();
    let backend = BackendServices {
        knowledge,
        canvas: canvas_agent::CanvasAgentService::new(&app),
    };
    tools::proof(&backend, &vault, root.path());
    println!("4 actual native adapter/domain proof groups passed; full registry/transport/GUI not claimed");
}
