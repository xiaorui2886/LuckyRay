//! Native MCP/CLI material adapter over the explicit-library Consumer boundary.
//! No raw paths, active-library fallback, new grants, or original-file authority.
use super::*;
use crate::local_transport::VerifiedTransportPrincipal;
use crate::materials::consumer::{
    ConsumerBytesInput, ConsumerMetadataPatch, ConsumerOrganization, ConsumerTarget,
    MaterialConsumer,
};

const IDS: [&str; 8] = [
    "materials.libraries",
    "materials.list",
    "materials.detail",
    "materials.library_taxonomy",
    "materials.library_preview",
    "materials.import_bytes",
    "materials.update",
    "materials.organize",
];

pub(super) fn handles(id: &str) -> bool {
    IDS.contains(&id)
}

fn target_schema(mut fields: Vec<(&str, Value)>, required: &[&str], write: bool) -> Value {
    fields.insert(0, ("libraryId", string_schema(1, 160)));
    let mut required_fields = vec!["libraryId"];
    required_fields.extend_from_slice(required);
    if write {
        fields.push(("requestId", string_schema(1, 96)));
        required_fields.push("requestId");
    }
    object_schema(fields, &required_fields)
}

fn read_result_schema() -> Value {
    json!({"type":"object","additionalProperties":true,"maxProperties":32,
        "required":["consumerVersion"],"properties":{"consumerVersion":{"const":1}}})
}

fn write_result_schema() -> Value {
    json!({"oneOf":[
        {"type":"object","additionalProperties":true,"maxProperties":32,
            "required":["consumerVersion","libraryId","requestId","committed"],
            "properties":{"consumerVersion":{"const":1},"libraryId":{"type":"string","minLength":1,"maxLength":160},
                "requestId":{"type":"string","minLength":1,"maxLength":96},"committed":{"const":true}}},
        {"type":"object","additionalProperties":false,"required":["committed","outputUnavailable"],
            "properties":{"committed":{"const":true},"outputUnavailable":{"const":true}}}
    ]})
}

fn filter_schema() -> Value {
    object_schema(
        vec![
            ("query", string_schema(0, 1024)),
            (
                "kinds",
                json!({"type":"array","maxItems":8,"items":{"type":"string","maxLength":32}}),
            ),
            (
                "tagIds",
                json!({"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":160}}),
            ),
            ("folderId", nullable_string_schema(160)),
            ("recentOnly", json!({"type":"boolean"})),
            ("ratingMin", integer_schema(0, 5)),
            ("limit", integer_schema(1, 100)),
        ],
        &[],
    )
}

fn organize_schema() -> Value {
    let asset_id = || string_schema(1, 160);
    let revision = || string_schema(64, 64);
    json!({"oneOf":[
        object_schema(vec![("op",json!({"const":"set_tags"})),("assetId",asset_id()),("expectedRevision",revision()),
            ("tagIds",json!({"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":160}}))],
            &["op","assetId","expectedRevision","tagIds"]),
        object_schema(vec![("op",json!({"const":"categorize"})),("assetId",asset_id()),("expectedRevision",revision()),
            ("folderId",nullable_string_schema(160))], &["op","assetId","expectedRevision","folderId"]),
        object_schema(vec![("op",json!({"const":"create_folder"})),("name",string_schema(1,120)),
            ("parentId",nullable_string_schema(160))], &["op","name"]),
        object_schema(vec![("op",json!({"const":"create_tag"})),("name",string_schema(1,80)),
            ("color",nullable_string_schema(64))], &["op","name"])
    ]})
}

pub(super) fn definitions() -> Vec<ToolDefinition> {
    let read = |id: &str, title: &str, description: &str, input| {
        definition(
            id,
            title,
            description,
            ToolRisk::Read,
            input,
            read_result_schema(),
            available(),
            "read-only-bounded",
            8192,
            MAX_TOOL_OUTPUT_BYTES,
        )
    };
    let write = |id: &str, title: &str, description: &str, input, max_input| {
        definition(
            id,
            title,
            description,
            ToolRisk::Write,
            input,
            write_result_schema(),
            available(),
            "process-request-id",
            max_input,
            MAX_TOOL_OUTPUT_BYTES,
        )
    };
    vec![
        read("materials.libraries", "List material libraries",
            "Lists registered material-library identities and existing capabilities, without roots or local paths. Select an explicit libraryId for every subsequent operation.",
            object_schema(vec![], &[])),
        read("materials.list", "List library materials",
            "Pages at most 100 metadata records in one authorized visible library. Follow nextOffset until null. Pages use current catalog order, not a frozen snapshot. Never uses the UI-selected library or returns local paths.",
            target_schema(vec![("filter", filter_schema()), ("offset", integer_schema(0, i64::MAX - 101))], &[], false)),
        read("materials.detail", "Read library material metadata",
            "Reads one ordinary material's safe metadata and CAS revision from the specified library.",
            target_schema(vec![("assetId", string_schema(1,160))], &["assetId"], false)),
        read("materials.library_taxonomy", "Read library categories and tags",
            "Lists categories and tags belonging to the specified authorized library, without filesystem paths.",
            target_schema(vec![], &[], false)),
        read("materials.library_preview", "Preview library material",
            "Reads at most 16 KiB of safe UTF-8 text from a catalog-owned material, otherwise metadata. Reports truncation; this is not an original-file export or arbitrary file read.",
            target_schema(vec![("assetId", string_schema(1,160))], &["assetId"], false)),
        write("materials.import_bytes", "Import bounded material content",
            "Imports validated PNG or UTF-8 .md/.txt bytes into one explicit library using the existing managed importer and duplicate-preserving receipt. Base64 content is bounded to 480 KiB; no arbitrary paths or new file grants.",
            target_schema(vec![
                ("name",string_schema(1,240)),("mimeType",enum_schema(&["image/png","text/markdown","text/plain"])),
                ("bytesBase64",string_schema(1,480*1024)),("targetFolderId",nullable_string_schema(160)),
                ("newFolderName",nullable_string_schema(120)),
                ("tagIds",json!({"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":160}})),
                ("tagNames",json!({"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":80}})),
                ("description",nullable_string_schema(8192)),
            ], &["name","mimeType","bytesBase64"], true), 512*1024),
        write("materials.update", "Update library material metadata",
            "Updates only a material's display name, description, rating or dominant color under its current revision. Cannot change original paths, storage mode, file bytes or other libraries.",
            target_schema(vec![
                ("assetId",string_schema(1,160)),("expectedRevision",string_schema(64,64)),
                ("patch",object_schema(vec![("name",string_schema(1,240)),("description",string_schema(0,64*1024)),
                    ("rating",nullable_integer_schema(0,5)),("dominantColor",nullable_string_schema(64))], &[])),
            ], &["assetId","expectedRevision","patch"], true), 80*1024),
        write("materials.organize", "Organize library materials",
            "Sets tags or a category with a material CAS revision, or creates a category/tag inside the explicit authorized library. Existing catalog operations own membership, transactions and change publication; no file moves or deletes.",
            target_schema(vec![("action",organize_schema())], &["action"], true), 16*1024),
    ]
}

fn map_error(error: crate::materials::MaterialError) -> ToolError {
    // Material errors can contain filesystem diagnostics. Native tools return
    // the stable code, not those internal paths or SQL details.
    let code = match error.code.as_str() {
        "consumer-library-denied" => "consumer-library-denied",
        "consumer-folder-denied" => "consumer-folder-denied",
        "consumer-tag-denied" => "consumer-tag-denied",
        "consumer-input-invalid" => "consumer-input-invalid",
        "consumer-asset-not-found" => "consumer-asset-not-found",
        "consumer-capture-too-large" => "consumer-capture-too-large",
        "material-library-scope" => "material-library-scope",
        "material-revision-conflict" => "material-revision-conflict",
        "library-unavailable" => "library-unavailable",
        "library-offline" => "library-offline",
        "library-invalid" => "library-invalid",
        "library-not-found" => "library-not-found",
        "not-found" => "consumer-asset-not-found",
        "agent-preview-unavailable" => "material-preview-unavailable",
        _ => "material-catalog-error",
    };
    ToolError::new(code, "Material operation failed; check library availability and revision")
}

fn target(input: &Value) -> Result<ConsumerTarget, ToolError> {
    Ok(ConsumerTarget {
        library_id: required_string(input, "libraryId")?.to_owned(),
        request_id: input
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("native-read")
            .to_owned(),
    })
}

fn service(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
) -> Result<MaterialConsumer, ToolError> {
    let catalog = backend.material_catalog();
    let authorization = principal
        .material_authorization(&catalog)
        .map_err(map_error)?;
    Ok(MaterialConsumer::new(catalog, authorization))
}

pub(super) fn authorize(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
    id: &str,
    input: &Value,
) -> Result<(), ToolError> {
    let service = service(backend, principal)?;
    match id {
        "materials.libraries" => service.libraries().map(|_| ()).map_err(map_error),
        "materials.import_bytes" => service.authorize_import(&target(input)?).map_err(map_error),
        "materials.update" | "materials.organize" => service
            .authorize_organize(&target(input)?)
            .map_err(map_error),
        _ if handles(id) => service.authorize_read(&target(input)?).map_err(map_error),
        _ => Err(ToolError::new("tool-not-found", "Tool does not exist")),
    }
}

pub(super) fn execute(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
    id: &str,
    input: &Value,
) -> Result<Value, ToolError> {
    let service = service(backend, principal)?;
    // Native admission is server-owned and retained across mutations. Revocation
    // cannot race a commit. Library availability is checked by each Consumer op.
    let _admission = principal.material_admission().map_err(map_error)?;
    let decoded = || ToolError::new("tool-input-invalid", "Material input does not match schema");
    let result = match id {
        "materials.libraries" => service.libraries(),
        "materials.list" => {
            let filter =
                serde_json::from_value(input.get("filter").cloned().unwrap_or_else(|| json!({})))
                    .map_err(|_| decoded())?;
            service.list_page(&target(input)?, &filter, input.get("offset").and_then(Value::as_u64).unwrap_or(0))
        }
        "materials.detail" => service.detail(&target(input)?, required_string(input, "assetId")?),
        "materials.library_taxonomy" => service.taxonomy(&target(input)?),
        "materials.library_preview" => {
            service.preview(&target(input)?, required_string(input, "assetId")?)
        }
        "materials.import_bytes" => {
            let content: ConsumerBytesInput =
                serde_json::from_value(input.clone()).map_err(|_| decoded())?;
            service.import_bytes(&content).map(|mut receipt| {
                receipt["committed"] = json!(true);
                receipt
            })
        }
        "materials.update" => {
            let patch: ConsumerMetadataPatch =
                serde_json::from_value(input["patch"].clone()).map_err(|_| decoded())?;
            service.update_metadata(
                &target(input)?,
                required_string(input, "assetId")?,
                required_string(input, "expectedRevision")?,
                patch,
            )
        }
        "materials.organize" => {
            let action: ConsumerOrganization =
                serde_json::from_value(input["action"].clone()).map_err(|_| decoded())?;
            service.organize(&target(input)?, action)
        }
        _ => return Err(ToolError::new("tool-not-found", "Tool does not exist")),
    };
    result.map_err(map_error)
}

#[cfg(test)]
#[path = "native_materials_tests.rs"]
mod tests;
