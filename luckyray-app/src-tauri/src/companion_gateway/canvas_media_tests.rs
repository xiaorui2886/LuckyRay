//! Native tests of the real projection and real MaterialCatalog adapter.
//! These are not executed by the JavaScript source-contract check.
use super::*;
use crate::canvas_agent::{normalize_document, CanvasDocument};
use crate::materials::{MaterialBytesInput, MaterialImportOptions};

fn session(byte: char) -> CanvasMediaSession {
    CanvasMediaSession::from_validated_session(CanvasSessionBinding {
        device_id: "phone-a".into(), desktop_instance: "desktop-a".into(),
        gateway_generation: 5, permission_revision: 8,
    }, &byte.to_string().repeat(64)).unwrap()
}
fn canonical() -> Value {
    json!({
        "schema_version": 2, "canvas_id": "canvas-a", "name": "画布",
        "created_at": "2026-11-04T12:00:00Z", "updated_at": "2026-11-04T12:00:00Z",
        "nodes": [{"id":"node-a","type":"spike","position":{"x":10,"y":20},
            "data":{"kind":"image","label":"图片"}}],
        "edges": [], "viewport":{"x":0,"y":0,"zoom":1},
        "generation_history": [], "revision":9, "content_digest":"", "agent_receipts":[],
        "unknownRoot":{"original":"DO_NOT_LEAK_ROOT"}
    })
}
fn normalized(value: &Value) -> CanvasDocument {
    normalize_document(serde_json::from_value(value.clone()).unwrap()).unwrap()
}
fn project_value(value: &Value, session: &CanvasMediaSession, catalog: &MaterialCatalog) -> CanvasProjection {
    let context = CanvasMediaContext::prepare(value, session, catalog).unwrap();
    project(value, &normalized(value), &context).unwrap()
}
fn image_asset(catalog: &MaterialCatalog) -> MaterialAsset {
    // A real small PNG, not an arbitrary file passed as a fake path grant.
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmN0AAAAASUVORK5CYII="
    ).unwrap();
    catalog.import_bytes(vec![MaterialBytesInput {
        name:"canvas-test.png".into(), original_path:"https://source.invalid/image.png".into(),
        mime_type:"image/png".into(), description:None, bytes,
    }], &MaterialImportOptions::default()).unwrap().value.assets.remove(0)
}
fn asset_document(asset: &MaterialAsset) -> Value {
    let mut value = canonical();
    value["nodes"][0]["data"]["payload"] = json!(format!("asset:{}", asset.id));
    value["nodes"][0]["data"]["refMediaUrl"] = json!(asset.library_path);
    value
}
fn media_id(projection: &CanvasProjection) -> String {
    projection.display_document()["nodes"][0]["data"]["refMediaUrl"].as_str().unwrap()
        .strip_prefix(MEDIA_PREFIX).unwrap().into()
}

#[test]
fn explicit_schema_omits_configuration_errors_and_unknowns_but_keeps_user_text() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let mut value = canonical();
    let data = &mut value["nodes"][0]["data"];
    data["label"] = json!("用户正文 workflow/baseURL https://example.com /home/me/file 中文");
    data["generationComfyWorkflow"] = json!({"baseUrl":"DO_NOT_LEAK_BASE","workflow":{"secret":"DO_NOT_LEAK_WORKFLOW"}});
    data["generationProfileId"] = json!("DO_NOT_LEAK_PROFILE");
    data["generationComfyTemplate"] = json!({"unknown":"DO_NOT_LEAK_TEMPLATE"});
    data["unknown"] = json!({"safeLooking":{"url":"DO_NOT_LEAK_NESTED"}});
    data["generationTask"] = json!({"id":"task-a","version":1,"status":"failed","providerTaskId":"DO_NOT_LEAK_PROVIDER_ID",
        "error":{"code":"DO_NOT_LEAK_CODE","message":"DO_NOT_LEAK_ERROR","detail":"DO_NOT_LEAK_DETAIL"},
        "request":{"kind":"image","prompt":"用户提示词","model":"显示模型","references":[],
            "comfyui":{"baseUrl":"DO_NOT_LEAK_REQUEST_BASE"},"textProfileId":"DO_NOT_LEAK_TEXT_PROFILE",
            "doubaoAccountIds":["DO_NOT_LEAK_ACCOUNT"],"future":{"token":"DO_NOT_LEAK_FUTURE"}}});
    value["nodes"][0]["style"] = json!({"width":400,"height":200,"backgroundImage":"url(DO_NOT_LEAK_CSS)"});
    value["generation_history"] = json!([{"id":"history-a","errorMessage":"DO_NOT_LEAK_HISTORY_ERROR",
        "errorDetail":"DO_NOT_LEAK_HISTORY_DETAIL","outputText":"完整生成正文","request":{"references":[]}}]);
    let current = session('a'); let projection = project_value(&value, &current, &catalog);
    let display = projection.display_document(); let text = serde_json::to_string(display).unwrap();
    assert!(!text.contains("DO_NOT_LEAK"), "{text}");
    assert_eq!(display["remoteProjectionVersion"], 1);
    assert_eq!(display["nodes"][0]["data"]["label"], value["nodes"][0]["data"]["label"]);
    assert_eq!(display["generationHistory"][0]["outputText"], "完整生成正文");
    assert_eq!(display["nodes"][0]["style"], json!({"width":400,"height":200}));
    assert_eq!(display["revision"], 9);
    assert_eq!(display["contentDigest"], normalized(&value).content_digest);
    assert_eq!(projection.restore_unchanged(&current, display).unwrap(), value);
}

#[test]
fn every_known_media_slot_uses_the_same_session_scoped_opaque_identity() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let asset = image_asset(&catalog); let raw = asset.library_path.as_ref().unwrap(); let mut value = asset_document(&asset);
    let reference = json!({"id":format!("asset:{}",asset.id),"label":"参考","kind":"image","role":"reference","mediaUrl":raw,"thumbnailUrl":raw,"unknown":"DO_NOT_LEAK_REF"});
    let request = json!({"kind":"image","prompt":"保留提示词","model":"显示模型","references":[reference.clone()]});
    let data = &mut value["nodes"][0]["data"];
    for key in ["refThumbnailUrl","resultMediaUrl","resultThumbnailUrl","sourceGenerationMediaUrl"] { data[key] = json!(raw); }
    data["resultMediaItems"] = json!([{"url":raw,"thumbnailUrl":raw}]);
    data["generationReferences"] = json!([reference]);
    data["generationTask"] = json!({"request":request.clone()});
    data["materialGenerationProvenance"] = json!({"version":1,"request":request.clone()});
    data["storyboardShot"] = json!({"version":1,"chosenResult":{"key":"choice-a","kind":"image","url":raw,"thumbnailUrl":raw}});
    value["generation_history"] = json!([{"outputMediaUrl":raw,"outputThumbnailUrl":raw,"outputMediaItems":[{"url":raw,"thumbnailUrl":raw}],"request":request}]);
    value["edges"] = json!([{"id":"edge-a","source":"node-a","target":"node-a","data":{"referenceMediaUrl":raw}}]);
    let current = session('a'); let projection = project_value(&value, &current, &catalog); let display = projection.display_document();
    let expected = display["nodes"][0]["data"]["refMediaUrl"].as_str().unwrap();
    assert!(expected.starts_with(MEDIA_PREFIX)); assert!(hex_id(expected.strip_prefix(MEDIA_PREFIX).unwrap()));
    for pointer in [
        "/nodes/0/data/refThumbnailUrl", "/nodes/0/data/resultMediaUrl", "/nodes/0/data/resultThumbnailUrl",
        "/nodes/0/data/sourceGenerationMediaUrl", "/nodes/0/data/resultMediaItems/0/url", "/nodes/0/data/resultMediaItems/0/thumbnailUrl",
        "/nodes/0/data/generationReferences/0/mediaUrl", "/nodes/0/data/generationReferences/0/thumbnailUrl",
        "/nodes/0/data/generationTask/request/references/0/mediaUrl", "/nodes/0/data/generationTask/request/references/0/thumbnailUrl",
        "/nodes/0/data/materialGenerationProvenance/request/references/0/mediaUrl", "/nodes/0/data/materialGenerationProvenance/request/references/0/thumbnailUrl",
        "/nodes/0/data/storyboardShot/chosenResult/url", "/nodes/0/data/storyboardShot/chosenResult/thumbnailUrl",
        "/generationHistory/0/outputMediaUrl", "/generationHistory/0/outputThumbnailUrl", "/generationHistory/0/outputMediaItems/0/url",
        "/generationHistory/0/outputMediaItems/0/thumbnailUrl", "/generationHistory/0/request/references/0/mediaUrl",
        "/generationHistory/0/request/references/0/thumbnailUrl", "/edges/0/data/referenceMediaUrl",
    ] { assert_eq!(display.pointer(pointer).and_then(Value::as_str), Some(expected), "{pointer}"); }
    assert_eq!(display["nodes"][0]["data"]["storyboardShot"]["chosenResult"]["key"], json!(["node-a", "image", expected]).to_string());
    assert_eq!(display["remoteUnavailableMediaCount"], 0);
    assert_eq!(projection.sources.len(), 1); assert_eq!(projection.unavailable_media_count(), 0);
    let serialized = serde_json::to_string(display).unwrap(); assert!(!serialized.contains(raw)); assert!(!serialized.contains("DO_NOT_LEAK"));
    assert_eq!(projection.restore_unchanged(&current, display).unwrap(), value);
    assert_eq!(project_value(&value, &current, &catalog).display_document(), display);
    assert_ne!(project_value(&value, &session('b'), &catalog).display_document()["nodes"][0]["data"]["refMediaUrl"], expected);
}

#[test]
fn existing_catalog_resource_is_readable_but_browser_paths_and_other_sessions_are_not() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let asset = image_asset(&catalog); let value = asset_document(&asset); let current = session('a');
    let projection = project_value(&value, &current, &catalog); let id = media_id(&projection);
    let mut media = projection.open_media(&current, &id).unwrap(); let mut bytes = Vec::new(); media.file.read_to_end(&mut bytes).unwrap();
    assert_eq!(media.mime, "image/png"); assert_eq!(bytes.len() as u64, media.length); assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    for bad in ["/etc/passwd", "../../secret", "?path=/etc/passwd", "https://127.0.0.1", "/canvas/media/id", "a%2fb"] {
        assert_eq!(projection.open_media(&current, bad).err(), Some(ProjectionError::MediaUnavailable));
    }
    assert_eq!(projection.open_media(&session('b'), &id).err(), Some(ProjectionError::SessionChanged));
    let mut changed = session('a'); changed.binding.permission_revision += 1;
    assert_eq!(projection.open_media(&changed, &id).err(), Some(ProjectionError::SessionChanged));
    drop(media); // Windows excludes in-place writes while the read handle is live.
    // Re-read the authoritative asset/file version; a formerly issued ID does
    // not silently select modified bytes.
    std::fs::write(asset.library_path.as_ref().unwrap(), b"not a PNG anymore").unwrap();
    assert_eq!(projection.open_media(&current, &id).err(), Some(ProjectionError::MediaUnavailable));
}

#[test]
fn paths_remote_urls_and_unimported_outputs_never_create_read_authority() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let asset = image_asset(&catalog); let mut value = canonical();
    let sources = [asset.library_path.as_ref().unwrap().as_str(), "/etc/passwd", "https://provider.invalid/result.png?token=secret",
        "http://127.0.0.1:8188/view?filename=x", "data:image/png;base64,aA==", "blob:desktop-secret", "C:\\Users\\person\\secret.png"];
    value["nodes"][0]["data"]["resultMediaItems"] = Value::Array(sources.iter().map(|url| json!({"url":url})).collect());
    value["unknownAssetId"] = json!(format!("asset:{}",asset.id));
    let projection = project_value(&value, &session('a'), &catalog);
    assert!(projection.sources.is_empty()); assert_eq!(projection.unavailable_media_count(), sources.len());
    assert_eq!(projection.display_document()["remoteUnavailableMediaCount"], sources.len());
    assert!(projection.display_document()["nodes"][0]["data"]["resultMediaItems"].as_array().unwrap().iter().all(|item| item["url"].is_null()));
    // Even a valid catalog ID with a mismatched stored path does not fall back
    // to the current asset's original just because payload names that asset.
    value["nodes"][0]["data"]["payload"] = json!(format!("asset:{}",asset.id));
    value["nodes"][0]["data"]["refMediaUrl"] = json!("/different/source.png");
    assert!(project_value(&value, &session('a'), &catalog).display_document()["nodes"][0]["data"]["refMediaUrl"].is_null());
}

#[test]
fn legacy_payload_and_exact_convert_file_src_spellings_use_catalog_evidence() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let asset = image_asset(&catalog); let mut value = asset_document(&asset);
    value["nodes"][0]["data"]["payload"] = json!(asset.id);
    let path = asset.library_path.as_ref().unwrap();
    let encoded: String = path.bytes().map(|byte| format!("%{byte:02X}")).collect();
    value["nodes"][0]["data"]["refMediaUrl"] = json!(format!("http://asset.localhost/{encoded}"));
    let projection = project_value(&value, &session('a'), &catalog);
    assert_eq!(projection.sources.len(), 1); assert!(hex_id(&media_id(&projection)));
    for raw in ["http://asset.localhost.evil/C%3A%5Csecret", "http://asset.localhost/C%3A%5Csecret?path=x", "file:///etc/passwd",
        "//server/share/file", "C:/folder/../secret", "C:/secret:stream", "A汉invalid", "asset://localhost/%FF", "asset://localhost/%00"] {
        assert_eq!(local_alias(raw), None, "{raw}");
    }
    assert_eq!(local_alias("http://asset.localhost/C%3A%5CUsers%5Ca%20b.png"), Some("C:/Users/a b.png".into()));
    assert_eq!(local_alias("asset://localhost/%2Fhome%2Fimage.png"), Some("/home/image.png".into()));
}

#[test]
fn hidden_fields_roundtrip_exactly_and_any_browser_edit_is_rejected() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let mut value = canonical();
    value["nodes"][0]["data"]["refMediaUrl"] = json!("https://private.invalid/signed?token=secret");
    value["nodes"][0]["data"]["unknownFuture"] = json!({"nested":[1,2,{"workflow":"preserve-exactly"}]});
    let current = session('a'); let projection = project_value(&value, &current, &catalog);
    assert_eq!(projection.restore_unchanged(&current, projection.display_document()).unwrap(), value);
    for (pointer, replacement) in [("/name",json!("changed")),("/nodes/0/position/x",json!(11)),
        ("/nodes/0/data/refMediaUrl",json!("/canvas/media/forged")),("/remoteProjectionVersion",json!(2))] {
        let mut edited = projection.display_document().clone(); *edited.pointer_mut(pointer).unwrap() = replacement;
        assert_eq!(projection.restore_unchanged(&current, &edited).err(), Some(ProjectionError::ReadOnly));
    }
    let mut forged = projection.display_document().clone(); forged["unknown"] = json!("injected");
    assert_eq!(projection.restore_unchanged(&current, &forged).err(), Some(ProjectionError::ReadOnly));
    assert_eq!(projection.restore_unchanged(&session('b'), projection.display_document()).err(), Some(ProjectionError::SessionChanged));
}

#[test]
fn canonical_revision_binding_and_budgets_fail_closed_without_truncation() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let value = canonical(); let current = session('a'); let context = CanvasMediaContext::prepare(&value, &current, &catalog).unwrap();
    let mut typed = normalized(&value); typed.revision += 1;
    assert_eq!(project(&value, &typed, &context).err(), Some(ProjectionError::CanonicalChanged));
    let mut changed = value.clone(); changed["unknownRoot"] = json!("new");
    assert_eq!(project(&changed, &normalized(&changed), &context).err(), Some(ProjectionError::CanonicalChanged));
    let mut deep = Value::Null; for _ in 0..=MAX_DEPTH { deep = json!([deep]); }
    let mut oversize = value.clone(); oversize["unknown"] = deep;
    assert_eq!(CanvasMediaContext::prepare(&oversize, &current, &catalog).err(), Some(ProjectionError::TooLarge));
    let mut oversize = value.clone(); oversize["unknown"] = json!("x".repeat(MAX_DOCUMENT_BYTES));
    assert_eq!(CanvasMediaContext::prepare(&oversize, &current, &catalog).err(), Some(ProjectionError::TooLarge));
    let mut long_text = value; long_text["nodes"][0]["data"]["label"] = json!("字".repeat(MAX_TEXT));
    let context = CanvasMediaContext::prepare(&long_text, &current, &catalog).unwrap();
    assert_eq!(project(&long_text, &normalized(&long_text), &context).err(), Some(ProjectionError::TooLarge));
}

#[test]
fn svg_html_and_unknown_media_types_are_not_served_as_browser_content() {
    assert_eq!(sniff_media(b"<svg><script>secret()</script></svg>", "image"), None);
    assert_eq!(sniff_media(b"<!doctype html><script>alert(1)</script>", "image"), None);
    assert_eq!(sniff_media(b"\x89PNG\r\n\x1a\n", "video"), None);
    assert_eq!(sniff_media(b"RIFF1234WEBP", "image"), Some("image/webp"));
}

#[test]
fn scope_is_frozen_and_references_do_not_search_other_libraries() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let other_root = tempfile::tempdir().unwrap();
    let library = catalog.create_library("Other", other_root.path(), "managed").unwrap();
    let other = catalog.for_library(&library.id).unwrap();
    let asset = image_asset(&other); let value = asset_document(&asset); let current = session('a');
    assert!(project_value(&value, &current, &catalog).sources.is_empty());
    let projection = project_value(&value, &current, &other);
    assert_eq!(projection.sources.len(), 1);
    catalog.select_library(&library.id).unwrap();
    // The legacy/default context is not silently upgraded to the active UI library.
    assert!(project_value(&value, &current, &catalog).sources.is_empty());
    assert!(projection.open_media(&current, &media_id(&projection)).is_ok());
}

#[test]
fn groups_keep_the_existing_group_renderer_and_missing_labels_are_display_only_defaults() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let mut value = canonical();
    value["nodes"][0]["type"] = json!("group");
    value["nodes"][0]["data"] = json!({"kind":"group","storyboard":{"version":1,"sourceScript":"分镜原文"}});
    let current = session('a'); let projection = project_value(&value, &current, &catalog);
    assert_eq!(projection.display_document()["nodes"][0]["type"], "group");
    assert_eq!(projection.display_document()["nodes"][0]["data"]["label"], "");
    assert_eq!(projection.display_document()["nodes"][0]["data"]["storyboard"]["sourceScript"], "分镜原文");
    assert_eq!(projection.restore_unchanged(&current, projection.display_document()).unwrap(), value);
}

#[test]
fn unavailable_catalog_keeps_canvas_text_readable_without_granting_media() {
    let root = tempfile::tempdir().unwrap();
    let catalog = MaterialCatalog::new(root.path().join("missing.db"), root.path());
    let mut value = canonical();
    value["nodes"][0]["data"]["label"] = json!("仍可读的正文");
    value["nodes"][0]["data"]["payload"] = json!("asset:missing");
    value["nodes"][0]["data"]["refMediaUrl"] = json!("/private/missing.png");
    let projection = project_value(&value, &session('a'), &catalog);
    assert_eq!(projection.display_document()["nodes"][0]["data"]["label"], "仍可读的正文");
    assert_eq!(projection.display_document()["remoteUnavailableMediaCount"], 1);
    assert!(projection.display_document()["nodes"][0]["data"]["refMediaUrl"].is_null());
    assert!(projection.sources.is_empty());
}

#[test]
fn rfc3339_positive_zero_and_negative_offsets_survive_the_real_projection() {
    use chrono::TimeZone;
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let current = session('a');
    for offset in [8 * 60 * 60, 0, -7 * 60 * 60] {
        // The same chrono RFC3339 serialization used by create_canvas, including
        // +08:00/+00:00, must not pass through the opaque identity whitelist.
        let timestamp = chrono::FixedOffset::east_opt(offset).unwrap()
            .with_ymd_and_hms(2026, 11, 4, 12, 30, 45).unwrap().to_rfc3339();
        let mut value = canonical();
        value["created_at"] = json!(timestamp); value["updated_at"] = json!(timestamp);
        value["nodes"][0]["data"]["refUpdatedAt"] = json!(timestamp);
        value["nodes"][0]["data"]["generationTask"] = json!({"createdAt":timestamp,"updatedAt":timestamp});
        value["generation_history"] = json!([{"createdAt":timestamp,"updatedAt":timestamp}]);
        let projection = project_value(&value, &current, &catalog); let display = projection.display_document();
        for pointer in ["/createdAt", "/updatedAt", "/nodes/0/data/refUpdatedAt",
            "/nodes/0/data/generationTask/createdAt", "/nodes/0/data/generationTask/updatedAt",
            "/generationHistory/0/createdAt", "/generationHistory/0/updatedAt"] {
            assert_eq!(display.pointer(pointer).and_then(Value::as_str), Some(timestamp.as_str()), "{pointer}");
        }
        assert!(validate_display_contract(display).is_ok());
        assert_eq!(projection.restore_unchanged(&current, display).unwrap(), value);
    }
    assert!(!identity("2026-11-04T12:30:45+08:00")); // General IDs were not broadened.
    assert!(rfc3339_timestamp("2026-11-04T12:30:45.123456789Z"));
    for invalid in ["", "+08:00", "2026-11-04", "not-a-timestamp", "2026-11-04T12:30:45+99:00",
        "2026-11-04T12:30:45Z\n", "2026-11-04T12:30:45Z?secret=hidden"] {
        assert!(!rfc3339_timestamp(invalid), "{invalid:?}");
    }
}

#[test]
fn missing_or_invalid_required_source_values_fail_instead_of_emitting_partial_details() {
    let root = tempfile::tempdir().unwrap(); let catalog = MaterialCatalog::new_for_test_at(root.path());
    let baseline = canonical(); let current = session('a');
    let assert_rejected = |value: Value| {
        let typed = serde_json::from_value::<CanvasDocument>(value.clone()).ok()
            .and_then(|document| normalize_document(document).ok()).unwrap_or_else(|| normalized(&baseline));
        let result = CanvasMediaContext::prepare(&value, &current, &catalog)
            .and_then(|context| project(&value, &typed, &context));
        assert!(result.is_err(), "unexpectedly accepted invalid source: {value}");
    };
    for key in ["canvas_id", "name", "created_at", "updated_at", "nodes", "edges", "viewport"] {
        let mut value = baseline.clone(); value.as_object_mut().unwrap().remove(key); assert_rejected(value);
    }
    for (key, invalid) in [("created_at", json!("")), ("updated_at", json!("2026-11-04")),
        ("name", Value::Null), ("nodes", Value::Null), ("edges", Value::Null),
        ("revision", json!(MAX_JS_SAFE_INTEGER + 1)), ("content_digest", json!("bad-digest"))] {
        let mut value = baseline.clone(); value[key] = invalid; assert_rejected(value);
    }
    for invalid_zoom in [0, -1] {
        let mut value = baseline.clone(); value["viewport"]["zoom"] = json!(invalid_zoom); assert_rejected(value);
    }
    let projection = project_value(&baseline, &current, &catalog);
    for key in ["remoteProjectionVersion", "remoteUnavailableMediaCount", "schemaVersion", "canvasId", "name",
        "createdAt", "updatedAt", "revision", "contentDigest", "nodes", "edges", "generationHistory", "viewport"] {
        let mut partial = projection.display_document().clone(); partial.as_object_mut().unwrap().remove(key);
        assert_eq!(validate_display_contract(&partial), Err(ProjectionError::InvalidDocument), "{key}");
    }
}
