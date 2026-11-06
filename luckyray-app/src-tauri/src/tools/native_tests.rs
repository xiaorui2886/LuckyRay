//! Production registry tests: real synthetic backend, real native credential
//! binding, and ordinary Knowledge/Canvas storage. Never opens a user profile.
use super::*;
use crate::knowledge::KnowledgeVaultRegistration;

fn fixture(
    label: &str,
) -> (
    tempfile::TempDir,
    BackendServices,
    ToolCallContext,
    KnowledgeVaultRegistration,
) {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("app");
    let vault_root = root.path().join("vault");
    std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
    let vault = KnowledgeVaultRegistration {
        id: format!("vault-native-{label}"),
        name: label.into(),
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
    let backend = BackendServices::initialize(&app).unwrap();
    backend.knowledge().register_current_vault(&vault).unwrap();
    let context =
        crate::local_transport::VerifiedTransportPrincipal::native_tool_test_principal(&app)
            .tool_context();
    (root, backend, context, vault)
}
fn run(
    backend: &BackendServices,
    context: &ToolCallContext,
    id: &str,
    input: Value,
) -> Result<Value, ToolError> {
    backend
        .run_tool(context, ToolRunRequest::read(id.into(), input))
        .map(|r| r.result)
}

#[test]
fn native_catalog_and_direct_dispatch_do_not_expand_agent_or_extension_rights() {
    let (_root, backend, native, _vault) = fixture("boundaries");
    let catalog = backend.list_tools(&native).unwrap();
    let additions = native::IDS
        .iter()
        .map(|id| (*id).to_owned())
        .chain(native_materials::definitions().into_iter().map(|d| d.id))
        .collect::<Vec<_>>();
    assert_eq!(catalog.len(), 26);
    for id in &additions {
        assert!(catalog.iter().any(|d| &d.id == id), "{id}");
    }
    assert_eq!(
        catalog.iter().find(|d| d.id == "canvas.save").unwrap().risk,
        ToolRisk::Dangerous
    );
    assert_eq!(
        catalog
            .iter()
            .find(|d| d.id == "knowledge.replace")
            .unwrap()
            .risk,
        ToolRisk::Dangerous
    );
    for context in [
        ToolCallContext::local_transport_verified([19; 32]),
        ToolCallContext::agent_read([20; 32]),
    ] {
        let listed = backend.list_tools(&context).unwrap();
        for id in &additions {
            assert!(
                !listed.iter().any(|d| &d.id == id),
                "non-native listed {id}"
            );
            assert_eq!(
                run(&backend, &context, id, json!({"native":true}))
                    .unwrap_err()
                    .code,
                "tool-not-found"
            );
        }
    }
}

#[test]
#[cfg(windows)]
fn native_notes_dispatch_reuses_revision_checked_product_operations() {
    let (_root, backend, context, vault) = fixture("notes");
    assert_eq!(
        run(&backend, &context, "knowledge.list", json!({})).unwrap()["total"],
        0
    );
    let made=run(&backend,&context,"knowledge.create",json!({"expectedVaultId":vault.id,"relativePath":"One.md","content":"abc","requestId":"native-note-create"})).unwrap();
    let revision = made["revision"].as_str().unwrap();
    let reference = made["documentRef"].clone();
    let replaced = json!({"expectedVaultId":vault.id,"documentRef":reference,"expectedRevision":revision,"content":"hello","requestId":"native-note-replace"});
    let result = run(&backend, &context, "knowledge.replace", replaced.clone()).unwrap();
    assert_eq!(
        run(&backend, &context, "knowledge.replace", replaced).unwrap(),
        result,
        "same request returns receipt, not a second write"
    );
    let mut stale = json!({"expectedVaultId":vault.id,"documentRef":reference,"expectedRevision":revision,"content":"stale","requestId":"native-note-stale"});
    assert_eq!(
        run(&backend, &context, "knowledge.replace", stale.clone())
            .unwrap_err()
            .code,
        "knowledge-revision-conflict"
    );
    stale["expectedVaultId"] = json!("other-vault");
    stale["requestId"] = json!("native-note-wrong-vault");
    assert_eq!(
        run(&backend, &context, "knowledge.replace", stale)
            .unwrap_err()
            .code,
        "knowledge-vault-not-current"
    );
    let inserted=run(&backend,&context,"knowledge.insert",json!({"expectedVaultId":vault.id,"documentRef":reference,"expectedRevision":result["document"]["revision"],"text":"!","offset":5,"requestId":"native-note-insert"})).unwrap();
    assert_eq!(
        run(
            &backend,
            &context,
            "knowledge.read",
            json!({"documentRef":reference})
        )
        .unwrap()["content"],
        "hello!"
    );
    let moved=run(&backend,&context,"knowledge.move",json!({"expectedVaultId":vault.id,"documentRef":reference,"expectedRevision":inserted["document"]["revision"],"relativePath":"Renamed.md","requestId":"native-note-move"})).unwrap();
    assert_eq!(
        moved["document"]["documentRef"]["relativePath"],
        "Renamed.md"
    );
    assert!(!std::path::Path::new(&vault.root_path)
        .join("One.md")
        .exists());
    assert_eq!(
        run(&backend, &context, "knowledge.list", json!({"limit":1})).unwrap()["total"],
        1
    );
    assert!(run(&backend, &context, "knowledge.tags", json!({})).unwrap()["tags"].is_array());
    assert!(run(
        &backend,
        &context,
        "knowledge.relations",
        json!({"documentRef":moved["document"]["documentRef"]})
    )
    .unwrap()["backlinks"]
        .is_array());
}

#[test]
fn native_canvas_dispatch_preserves_complete_graph_and_rejects_invalid_or_stale_save() {
    let (_root, backend, context, _vault) = fixture("canvas");
    let create = json!({"name":"Native fixture","requestId":"native-canvas-create"});
    let created = run(&backend, &context, "canvas.create", create.clone()).unwrap();
    assert_eq!(
        run(&backend, &context, "canvas.create", create).unwrap(),
        created
    );
    let id = created["canvas"]["canvasId"].as_str().unwrap();
    let read = run(&backend, &context, "canvas.read", json!({"canvasId":id})).unwrap();
    let save = json!({"canvasId":id,"expectedRevision":read["revision"],"expectedContentDigest":read["contentDigest"],"requestId":"native-canvas-save",
        "nodes":[{"id":"n1","type":"spike","position":{"x":10,"y":20},"data":{"kind":"text","label":"safe","preservedExtension":{"key":"value"}}}],
        "edges":[],"viewport":{"x":0,"y":0,"zoom":1},"generationHistory":[]});
    let saved = run(&backend, &context, "canvas.save", save.clone()).unwrap();
    assert_eq!(
        run(&backend, &context, "canvas.save", save.clone()).unwrap(),
        saved
    );
    let next = run(&backend, &context, "canvas.read", json!({"canvasId":id})).unwrap();
    assert_eq!(
        next["nodes"][0]["data"]["preservedExtension"]["key"],
        "value"
    );
    let disk = backend
        .app_data_dir()
        .join("canvases")
        .join(format!("{id}.json"));
    let before = std::fs::read(&disk).unwrap();
    for (i, nodes) in [
        json!([null]),
        json!([{}]),
        json!([{"id":"x","position":{"x":0,"y":0},"data":{"kind":"text"}}]),
    ]
    .into_iter()
    .enumerate()
    {
        let mut invalid = save.clone();
        invalid["nodes"] = nodes;
        invalid["requestId"] = json!(format!("invalid-canvas-{i}"));
        assert_eq!(
            run(&backend, &context, "canvas.save", invalid)
                .unwrap_err()
                .code,
            "tool-input-invalid"
        );
        assert_eq!(std::fs::read(&disk).unwrap(), before);
    }
    let mut invalid = save.clone();
    invalid["edges"] = json!([{"id":"e1","source":"n1","target":"missing"}]);
    invalid["requestId"] = json!("invalid-edge");
    assert_eq!(
        run(&backend, &context, "canvas.save", invalid)
            .unwrap_err()
            .code,
        "tool-input-invalid"
    );
    let mut stale = save;
    stale["requestId"] = json!("stale-canvas");
    assert_eq!(
        run(&backend, &context, "canvas.save", stale)
            .unwrap_err()
            .code,
        "canvas-agent-revision-conflict"
    );
    assert_eq!(std::fs::read(&disk).unwrap(), before);
    let renamed=run(&backend,&context,"canvas.rename",json!({"canvasId":id,"expectedRevision":next["revision"],"expectedContentDigest":next["contentDigest"],"name":"Renamed","requestId":"native-canvas-rename"})).unwrap();
    assert_eq!(renamed["canvas"]["name"], "Renamed");
    assert_eq!(
        run(&backend, &context, "canvas.list", json!({})).unwrap()["total"],
        1
    );
}

#[test]
fn native_canvas_read_fails_instead_of_returning_a_truncated_graph() {
    let (_root, backend, context, _vault) = fixture("canvas-size");
    let created = run(
        &backend,
        &context,
        "canvas.create",
        json!({"name":"Large","requestId":"large-create"}),
    )
    .unwrap();
    let id = created["canvas"]["canvasId"].as_str().unwrap();
    let mut document = backend.canvas_agent().read_normal_canvas(id).unwrap();
    document.nodes = json!([{"id":"n","position":{"x":0,"y":0},"data":{"kind":"text","label":"a".repeat(MAX_TOOL_OUTPUT_BYTES+1)}}]);
    backend.canvas_agent().save_normal_canvas(document).unwrap();
    assert_eq!(
        run(&backend, &context, "canvas.read", json!({"canvasId":id}))
            .unwrap_err()
            .code,
        "tool-output-too-large"
    );
}
