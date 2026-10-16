//! Scoped adapter for the existing MCP routes. Never falls through to legacy
//! native dispatch, UI-selected libraries, or the general tool executor.
use super::{consumer::*, *};
use crate::{
    backend::BackendServices,
    local_transport::{AdapterResponse, VerifiedTransportPrincipal},
};
use serde::Deserialize;
use serde_json::{json, Value};

fn invalid() -> MaterialError {
    MaterialError::new("consumer-input-invalid", "素材请求字段无效")
}
fn parse<T: serde::de::DeserializeOwned>(body: Option<&str>) -> MaterialResult<T> {
    serde_json::from_str(body.unwrap_or("")).map_err(|_| invalid())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolInput {
    tool_id: String,
    input: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchInput {
    #[serde(default)]
    query: String,
    #[serde(default = "default_limit")]
    limit: u32,
}
fn default_limit() -> u32 {
    10
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectInput {
    asset_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportInput {
    pub(crate) url: String,
    pub(crate) file_name: String,
    pub(crate) folder_id: Option<String>,
    pub(crate) new_folder_name: Option<String>,
}

// Same production commit seam after validated download; tests can control the
// revoke/switch-library boundary without weakening network guards.
pub(crate) fn commit_prepared_import(
    root: &MaterialCatalog,
    principal: &VerifiedTransportPrincipal,
    input: ImportInput,
    prepared: crate::assets_import_file::PreparedImport,
) -> MaterialResult<Value> {
    let library_id = principal.materials_library_id()?;
    let service = MaterialConsumer::new(root.clone(), principal.material_authorization(root)?);
    let target = ConsumerTarget {
        library_id: library_id.clone(),
        request_id: "materials-mcp".into(),
    };
    let admission = principal.material_admission()?;
    service.authorize_import(&target)?;
    let catalog = root.for_library(&library_id)?;
    let folder_id = if let Some(name) = input.new_folder_name {
        let created = catalog.create_folder(MaterialFolderInput {
            name,
            parent_id: None,
        })?;
        crate::publish_catalog_change_global(&created.change);
        Some(created.value.id)
    } else {
        input.folder_id
    };
    let imported = super::adapters::import_consumer_material_with_source(
        &catalog,
        MaterialBytesInput {
            name: prepared.name,
            original_path: input.url,
            mime_type: prepared.mime,
            bytes: prepared.bytes,
            description: None,
        },
        &MaterialImportOptions {
            folder_id,
            storage_mode: "managed".into(),
            ..Default::default()
        },
        None,
    )?;
    crate::publish_catalog_change_global(&imported.change);
    let mut receipt = canonical_import_response(&imported);
    // Scoped MCP receives metadata, never embedded filesystem paths.
    receipt
        .as_object_mut()
        .expect("canonical object")
        .remove("asset");
    receipt["libraryId"] = json!(library_id);
    drop(admission);
    Ok(receipt)
}

pub(crate) fn route(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> AdapterResponse {
    if !backend.status().ready {
        return AdapterResponse {
            status: 503,
            body: json!({"code":"backend-not-ready","message":"素材服务尚未就绪"}).to_string(),
        };
    }
    let result = (|| -> MaterialResult<Value> {
        let root = backend.material_catalog();
        let authorization = principal.material_authorization(&root)?;
        let library_id = principal.materials_library_id()?;
        let service = MaterialConsumer::new(root.clone(), authorization);
        let target = ConsumerTarget {
            library_id: library_id.clone(),
            request_id: "materials-mcp".into(),
        };
        service.authorize_read(&target)?;
        match (method, path) {
            ("GET", "/api/folders") => {
                let value = service.taxonomy(&target)?;
                Ok(json!({"folders":value["folders"],"libraryId":library_id}))
            }
            ("POST", "/api/tools/run") => {
                let request: ToolInput = parse(body)?;
                let result = match request.tool_id.as_str() {
                    "materials.search" => {
                        let input: SearchInput =
                            serde_json::from_value(request.input).map_err(|_| invalid())?;
                        if input.query.len() > 4000 || !(1..=50).contains(&input.limit) {
                            return Err(invalid());
                        }
                        let result = service.list(
                            &target,
                            &MaterialFilter {
                                query: Some(input.query),
                                limit: Some(input.limit),
                                ..Default::default()
                            },
                        )?;
                        json!({"assets":result["items"],"libraryId":library_id})
                    }
                    "materials.inspect" => {
                        let input: InspectInput =
                            serde_json::from_value(request.input).map_err(|_| invalid())?;
                        service.detail(&target, &input.asset_id)?
                    }
                    _ => {
                        return Err(MaterialError::new(
                            "consumer-library-denied",
                            "工具未获授权",
                        ))
                    }
                };
                Ok(json!({"result":result}))
            }
            ("POST", "/api/assets/import-file") => {
                let input: ImportInput = parse(body)?;
                let url = reqwest::Url::parse(&input.url).map_err(|_| invalid())?;
                if url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
                    || url.port_or_known_default() != Some(443)
                {
                    return Err(invalid());
                }
                if input.folder_id.is_some() && input.new_folder_name.is_some() {
                    return Err(invalid());
                }
                service.authorize_import(&target)?;
                // Reuse the same SSRF, limits, filename validation and sniffing as
                // the ordinary importer. No auth lock is held across network I/O.
                let prepared = crate::assets_import_file::prepare_import(
                    &input.url,
                    Some(&input.file_name),
                    &crate::assets_import_file::PRODUCTION_LIMITS,
                )
                .map_err(|e| MaterialError::new(e.code, "文件下载或校验失败"))?;
                // Revocation and expiry are checked again before the first write.
                // This guard linearizes commit against revoke; UI library changes
                // cannot redirect the fixed grant target.
                commit_prepared_import(&root, principal, input, prepared)
            }
            _ => Err(MaterialError::new(
                "consumer-library-denied",
                "入口未获素材授权",
            )),
        }
    })();
    let response = match result {
        Err(error) if matches!(error.code.as_str(), "invalid-param" | "import-failed") => {
            AdapterResponse {
                status: if error.code == "invalid-param" {
                    400
                } else {
                    500
                },
                body: json!({"code":error.code,"message":"文件下载或校验失败"}).to_string(),
            }
        }
        other => super::consumer_transport::response(other),
    };
    principal.material_delivery_response(response)
}
