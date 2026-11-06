use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

fn fixture() -> (BackendServices, ToolCallContext, String, String) {
    let root = std::env::temp_dir().join(format!(
        "luckyray-native-material-tools-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let backend = BackendServices::initialize(&root).unwrap();
    let principal = VerifiedTransportPrincipal::native_tool_test_principal(&root);
    let catalog = backend.material_catalog();
    let library = |name: &str| {
        let path = root.join(name);
        std::fs::create_dir(&path).unwrap();
        catalog.create_library(name, &path, "managed").unwrap().id
    };
    let first = library("first");
    let other = library("other");
    (backend, principal.tool_context(), first, other)
}

fn run(
    backend: &BackendServices,
    context: &ToolCallContext,
    id: &str,
    input: Value,
) -> Result<Value, ToolError> {
    let request_id = input
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    backend
        .run_tool(
            context,
            ToolRunRequest {
                tool_id: id.to_owned(),
                input,
                request_id,
            },
        )
        .map(|result| result.result)
}

fn import(library: &str, request: &str, text: &[u8]) -> Value {
    json!({"libraryId":library,"requestId":request,"name":"fixture.md","mimeType":"text/markdown","bytesBase64":STANDARD.encode(text)})
}

#[test]
fn native_material_registry_dispatch_keeps_explicit_target_and_import_replay() {
    let (backend, context, library, other) = fixture();
    let catalog = backend.material_catalog();
    catalog.select_library(&other).unwrap();
    let libraries = run(&backend, &context, "materials.libraries", json!({})).unwrap();
    assert!(!libraries.to_string().contains("rootPath"));
    assert!(libraries["libraries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["capabilities"]["files"] == false));
    let input = import(&library, "native.import.1", b"# Native bounded import");
    let imported = run(&backend, &context, "materials.import_bytes", input.clone()).unwrap();
    assert_eq!(imported["libraryId"], library);
    assert_eq!(imported["committed"], true);
    assert_eq!(
        run(&backend, &context, "materials.import_bytes", input).unwrap(),
        imported
    );
    assert!(catalog
        .for_library(&other)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap()
        .is_empty());
    let listed = run(
        &backend,
        &context,
        "materials.list",
        json!({"libraryId":library}),
    )
    .unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert!(listed["nextOffset"].is_null());
    let beyond = run(&backend, &context, "materials.list", json!({"libraryId":library,"offset":1,"filter":{"limit":1}})).unwrap();
    assert_eq!(beyond["items"], json!([]));
    assert!(beyond["nextOffset"].is_null());
    let asset = imported["assetId"].as_str().unwrap();
    let preview = run(
        &backend,
        &context,
        "materials.library_preview",
        json!({"libraryId":library,"assetId":asset}),
    )
    .unwrap();
    assert_eq!(preview["content"], "# Native bounded import");
    assert_eq!(preview["truncated"], false);
    for key in ["rootPath", "originalPath", "libraryPath"] {
        assert!(!preview.to_string().contains(key));
    }
    assert!(run(
        &backend,
        &context,
        "materials.detail",
        json!({"libraryId":other,"assetId":asset})
    )
    .is_err());
    catalog.set_library_visible(&library, false).unwrap();
    assert!(run(
        &backend,
        &context,
        "materials.library_preview",
        json!({"libraryId":library,"assetId":asset})
    )
    .is_err());
}

#[test]
fn native_material_registry_organize_is_revision_checked_and_library_bound() {
    let (backend, context, library, other) = fixture();
    let imported = run(
        &backend,
        &context,
        "materials.import_bytes",
        import(&library, "edit-import", b"# Organize"),
    )
    .unwrap();
    let id = imported["assetId"].as_str().unwrap();
    let revision = imported["asset"]["revision"].as_str().unwrap();
    let foreign = backend
        .material_catalog()
        .for_library(&other)
        .unwrap()
        .create_tag("foreign", None)
        .unwrap()
        .value;
    let refused = run(
        &backend,
        &context,
        "materials.organize",
        json!({"libraryId":library,"requestId":"foreign-tags","action":{
            "op":"set_tags","assetId":id,"expectedRevision":revision,"tagIds":[foreign.id]
        }}),
    );
    assert!(refused.is_err());
    assert!(backend
        .material_catalog()
        .for_library(&library)
        .unwrap()
        .get_asset_tags(id)
        .unwrap()
        .is_empty());
    let tag = run(&backend, &context, "materials.organize", json!({"libraryId":library,"requestId":"create-tag","action":{"op":"create_tag","name":"native"}})).unwrap();
    let folder = run(&backend, &context, "materials.organize", json!({"libraryId":library,"requestId":"create-folder","action":{"op":"create_folder","name":"examples"}})).unwrap();
    let tagged = run(
        &backend,
        &context,
        "materials.organize",
        json!({"libraryId":library,"requestId":"set-tags","action":{
            "op":"set_tags","assetId":id,"expectedRevision":revision,"tagIds":[tag["tag"]["id"]]
        }}),
    )
    .unwrap();
    assert_eq!(tagged["committed"], true);
    let stale = run(
        &backend,
        &context,
        "materials.update",
        json!({"libraryId":library,"assetId":id,"expectedRevision":revision,"requestId":"stale-update","patch":{"description":"must not commit"}}),
    );
    assert_eq!(stale.unwrap_err().code, "material-revision-conflict");
    let categorized = run(&backend, &context, "materials.organize", json!({"libraryId":library,"requestId":"categorize","action":{
        "op":"categorize","assetId":id,"expectedRevision":tagged["asset"]["revision"],"folderId":folder["folder"]["id"]
    }})).unwrap();
    assert_eq!(categorized["asset"]["folderId"], folder["folder"]["id"]);
    let updated = run(&backend, &context, "materials.update", json!({"libraryId":library,"assetId":id,"expectedRevision":categorized["asset"]["revision"],"requestId":"metadata-update","patch":{"name":"renamed display","description":"safe metadata","rating":4}})).unwrap();
    assert_eq!(updated["asset"]["name"], "renamed display");
    let taxonomy = run(
        &backend,
        &context,
        "materials.library_taxonomy",
        json!({"libraryId":library}),
    )
    .unwrap();
    assert_eq!(taxonomy["tags"].as_array().unwrap().len(), 1);
    assert_eq!(taxonomy["folders"].as_array().unwrap().len(), 1);
}

#[test]
fn native_material_registry_refuses_path_bytes_and_forged_scope_before_writes() {
    let (backend, context, library, _) = fixture();
    let initial = backend
        .material_catalog()
        .for_library(&library)
        .unwrap()
        .read_library_change()
        .unwrap()
        .version;
    let mut invalid = import(&library, "unknown-field", b"safe");
    invalid["originalPath"] = json!("/private/forbidden.md");
    assert_eq!(
        run(&backend, &context, "materials.import_bytes", invalid)
            .unwrap_err()
            .code,
        "tool-input-invalid"
    );
    let mut invalid = import(&library, "bad-type", b"not image data");
    invalid["name"] = json!("fixture.png");
    invalid["mimeType"] = json!("image/png");
    assert!(run(&backend, &context, "materials.import_bytes", invalid).is_err());
    let mut invalid = import(&library, "path-name", b"safe");
    invalid["name"] = json!("../escape.md");
    assert!(run(&backend, &context, "materials.import_bytes", invalid).is_err());
    assert!(run(
        &backend,
        &context,
        "materials.list",
        json!({"libraryId":"unknown-library"})
    )
    .is_err());
    assert_eq!(
        backend
            .material_catalog()
            .for_library(&library)
            .unwrap()
            .read_library_change()
            .unwrap()
            .version,
        initial
    );
    assert!(backend
        .material_catalog()
        .for_library(&library)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap()
        .is_empty());
}
