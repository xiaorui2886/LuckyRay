//! Authenticated ordinary-media v1 adapter; reuses the original downloader,
//! async transfer service and durable principal/request ledger.
use super::{
    consumer::{media::*, *},
    consumer_transport::response,
    *,
};
use crate::{
    backend::BackendServices,
    local_transport::{AdapterResponse, VerifiedTransportPrincipal},
};
use serde_json::{json, Value};
use std::sync::Arc;

const IMAGE: &str = "/api/assets/import-media";
const VIDEO: &str = "/api/media/transfers";
const RECEIPT: &str = "/api/material-libraries/media-receipt";

pub(crate) fn explicit_request(path: &str, body: Option<&str>) -> bool {
    if !matches!(path, IMAGE | VIDEO) {
        return false;
    }
    body.and_then(|body| serde_json::from_str::<Value>(body).ok())
        .is_some_and(|body| {
            ["libraryId", "tagIds", "tagNames"]
                .iter()
                .any(|key| body.get(key).is_some())
                || (path == IMAGE && body.get("name").is_some())
        })
}

fn invalid() -> MaterialError {
    MaterialError::new("consumer-input-invalid", "媒体请求字段无效")
}
fn denied() -> AdapterResponse {
    response(Err(MaterialError::new(
        "consumer-library-denied",
        "媒体任务未获授权",
    )))
}

fn destination(body: &Value, video: bool) -> MaterialResult<MediaDestination> {
    let mut selected = serde_json::Map::new();
    for key in [
        "libraryId",
        "requestId",
        "targetFolderId",
        "newFolderName",
        "parentFolderId",
        "tagIds",
        "tagNames",
    ] {
        if let Some(value) = body.get(key) {
            selected.insert(key.into(), value.clone());
        }
    }
    if let Some(name) = body.get(if video { "fileName" } else { "name" }) {
        selected.insert("name".into(), name.clone());
    }
    serde_json::from_value(Value::Object(selected)).map_err(|_| invalid())
}

fn service(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
) -> MaterialResult<MaterialConsumer> {
    let catalog = backend.material_catalog();
    let authorization = principal.material_authorization(&catalog)?;
    Ok(MaterialConsumer::new(catalog, authorization))
}

fn bind_response(mut result: AdapterResponse, target: &ConsumerTarget) -> AdapterResponse {
    // Bind definite stored errors to their original library as well as successes.
    if let Ok(Value::Object(mut body)) = serde_json::from_str::<Value>(&result.body) {
        body.insert("libraryId".into(), json!(target.library_id));
        body.insert("requestId".into(), json!(target.request_id));
        result.body = Value::Object(body).to_string();
    }
    result
}

pub(crate) fn scoped_job(backend: &BackendServices, path: &str) -> bool {
    transfer_id(path).is_some_and(|(id, _)| {
        backend
            .media_transfer()
            .destination_scope(id)
            .ok()
            .flatten()
            .is_some()
    })
}

fn transfer_id(path: &str) -> Option<(&str, bool)> {
    let tail = path.strip_prefix("/api/media/transfers/")?;
    let (id, cancel) = tail
        .strip_suffix("/cancel")
        .map(|id| (id, true))
        .unwrap_or((tail, false));
    (!id.is_empty() && !id.contains('/')).then_some((id, cancel))
}

pub(crate) fn route(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Option<AdapterResponse> {
    if path == RECEIPT {
        return Some(if method != "POST" {
            AdapterResponse {
                status: 405,
                body: json!({"code":"METHOD_NOT_ALLOWED"}).to_string(),
            }
        } else {
            principal.material_delivery_response(response(read_receipt(backend, principal, body)))
        });
    }
    if let Some((id, cancel)) = transfer_id(path) {
        if let Some((library_id, request_id, owner)) = backend
            .media_transfer()
            .destination_scope(id)
            .ok()
            .flatten()
        {
            if method != if cancel { "POST" } else { "GET" } {
                return Some(AdapterResponse {
                    status: 405,
                    body: "{}".into(),
                });
            }
            if principal.media_owner_key().ok().as_deref() != Some(&owner) {
                return Some(denied());
            }
            let target = ConsumerTarget {
                library_id,
                request_id,
            };
            if service(backend, principal)
                .and_then(|s| s.authorize_import(&target))
                .is_err()
            {
                return Some(denied());
            }
            let result = if cancel {
                // Revocation cannot race a cancellation side effect.
                let Ok(_guard) = principal.material_admission() else {
                    return Some(denied());
                };
                backend.media_transfer().cancel(id)
            } else {
                backend.media_transfer().status(id)
            };
            let (status, body) = match result {
                Ok(snapshot) => crate::serialize_media_transfer_snapshot(200, snapshot),
                Err(error) => crate::media_transfer_error_response(error),
            };
            return Some(principal.material_delivery_response(AdapterResponse { status, body }));
        }
    }
    if !explicit_request(path, body) {
        return None;
    }
    if method != "POST" {
        return Some(AdapterResponse {
            status: 405,
            body: "{}".into(),
        });
    }
    let parsed = body
        .and_then(|body| serde_json::from_str::<Value>(body).ok())
        .ok_or_else(invalid);
    let preflight = parsed.and_then(|value| {
        let destination = destination(&value, path == VIDEO)?;
        service(backend, principal)?.validate_media_destination(&destination)?;
        Ok((value, destination))
    });
    let (value, destination) = match preflight {
        Ok(v) => v,
        Err(e) => return Some(response(Err(e))),
    };
    let target = destination.target();
    let result = crate::extension_note_capture::media_response_with_receipt(
        backend,
        principal,
        path,
        body,
        || {
            let result = if path == IMAGE {
                import_image(backend, principal, &value, &destination)
            } else {
                start_video(backend, principal, &value, &destination)
            };
            bind_response(result, &target)
        },
    );
    Some(principal.material_delivery_response(result))
}

fn import_image(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
    body: &Value,
    destination: &MediaDestination,
) -> AdapterResponse {
    let allowed = [
        "url",
        "mediaType",
        "libraryId",
        "requestId",
        "name",
        "targetFolderId",
        "newFolderName",
        "parentFolderId",
        "tagIds",
        "tagNames",
        "sourcePageUrl",
        "sourcePageKind",
        "sourcePageTitle",
        "captureSource",
    ];
    if body["mediaType"] != "image"
        || body
            .as_object()
            .is_none_or(|v| v.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return response(Err(invalid()));
    }
    if body.get("sourcePageTitle").is_some() && body.get("sourcePageUrl").is_none() {
        return response(Err(invalid()));
    }
    let (input, source) = match crate::download_api_media(body, Some(MAX_ORIGINAL_IMAGE_BYTES)) {
        Ok(value) => value,
        Err(failure) => {
            return AdapterResponse {
                status: failure.status,
                body: failure.json().to_string(),
            }
        }
    };
    response(service(backend, principal).and_then(|service| {
        service.import_original_image_checked(destination, input, source.as_ref(), || {
            principal.material_admission()
        })
    }))
}

fn start_video(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
    body: &Value,
    destination: &MediaDestination,
) -> AdapterResponse {
    let mut legacy = body.clone();
    for key in ["libraryId", "tagIds", "tagNames"] {
        legacy.as_object_mut().expect("parsed object").remove(key);
    }
    let request: crate::MediaTransferApiRequest = match serde_json::from_value(legacy) {
        Ok(value) => value,
        Err(_) => return response(Err(invalid())),
    };
    let source = if let Some(kind) = request.source_page_kind.as_deref() {
        match MaterialSourcePageInput::from_parts(
            request
                .material_source_page_url
                .as_deref()
                .unwrap_or_default(),
            kind,
            request.source_page_title.as_deref(),
        ) {
            Some(source) => Some(source),
            None => return response(Err(invalid())),
        }
    } else {
        if request.material_source_page_url.is_some() || request.source_page_title.is_some() {
            return response(Err(invalid()));
        }
        None
    };
    let owner_key = match principal.media_owner_key() {
        Ok(v) => v,
        Err(e) => return response(Err(e)),
    };
    let catalog = backend.material_catalog();
    let commit_principal = principal.clone();
    let commit_destination = destination.clone();
    let scope = crate::media_transfer::MediaTransferDestination {
        library_id: destination.library_id.clone(),
        request_id: destination.request_id.clone(),
        owner_key,
        commit: Arc::new(move |input, source| {
            let authorization = commit_principal.material_authorization(&catalog)?;
            let consumer = MaterialConsumer::new(catalog.clone(), authorization);
            consumer.import_original_video_checked(&commit_destination, input, source, || {
                commit_principal.material_admission()
            })
        }),
    };
    // Authorization is held through admission/spawn, then rechecked by the
    // worker after download and held through all commit/organization effects.
    let admitted =
        service(backend, principal).and_then(|s| s.validate_media_destination(destination));
    if let Err(error) = admitted {
        return response(Err(error));
    }
    let Ok(_guard) = principal.material_admission() else {
        return denied();
    };
    let (status, body) = match backend.media_transfer().start_selected_with_destination(
        request.transfer,
        request.probe_id.as_deref(),
        request.format_id.as_deref(),
        source,
        Some(scope),
    ) {
        Ok(snapshot) => crate::serialize_media_transfer_snapshot(202, snapshot),
        Err(error) => crate::media_transfer_error_response(error),
    };
    AdapterResponse { status, body }
}

fn read_receipt(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
    body: Option<&str>,
) -> MaterialResult<Value> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Lookup {
        library_id: String,
        request_id: String,
        operation: String,
    }
    let lookup: Lookup = serde_json::from_str(body.ok_or_else(invalid)?).map_err(|_| invalid())?;
    let path = match lookup.operation.as_str() {
        "image" => IMAGE,
        "video" => VIDEO,
        _ => return Err(invalid()),
    };
    let target = ConsumerTarget {
        library_id: lookup.library_id,
        request_id: lookup.request_id,
    };
    service(backend, principal)?.authorize_import(&target)?;
    let owner = principal.media_owner_key()?;
    let _guard = principal.material_admission()?;
    let mut result = json!({"receiptLookupVersion":1,"libraryId":target.library_id,"requestId":target.request_id,"state":"unknown"});
    let Some(stored) = crate::extension_note_capture::read_media_receipt(
        backend,
        principal,
        path,
        &target.request_id,
    ) else {
        return Ok(result);
    };
    let Ok(value) = serde_json::from_str::<Value>(&stored.body) else {
        return Ok(result);
    };
    if value["libraryId"] != target.library_id || value["requestId"] != target.request_id {
        return Ok(result);
    }
    if path == IMAGE && stored.status == 200 && valid_asset_receipt(&value) {
        result["state"] = json!("completed");
        result["receipt"] = value;
    } else if path == VIDEO && stored.status == 202 {
        if let Some(id) = value["transferId"].as_str() {
            if backend
                .media_transfer()
                .destination_scope(id)
                .ok()
                .flatten()
                != Some((target.library_id.clone(), target.request_id.clone(), owner))
            {
                return Ok(result);
            }
            if let Ok(snapshot) = backend.media_transfer().status(id) {
                use crate::media_transfer::MediaTransferState::*;
                match snapshot.state {
                    Completed => {
                        if let Some(receipt) = &snapshot.receipt {
                            if valid_asset_receipt(receipt)
                                && receipt["libraryId"] == target.library_id
                                && receipt["requestId"] == target.request_id
                            {
                                result["state"] = json!("completed");
                                result["receipt"] = receipt.clone();
                            }
                        }
                    }
                    Failed => result["state"] = json!("failed"),
                    Cancelled => result["state"] = json!("cancelled"),
                    _ => result["state"] = json!("pending"),
                }
                result["transfer"] = serde_json::to_value(snapshot).expect("serializable snapshot");
            }
        }
    } else if stored.status >= 400
        && value["writeOutcome"] != "unknown"
        && !matches!(
            value["code"].as_str(),
            Some(
                "capture-commit-uncertain"
                    | "capture-receipt-unavailable"
                    | "consumer-delivery-denied"
            )
        )
    {
        result["state"] = json!("rejected");
        result["response"] = json!({"status":stored.status,"body":value});
    }
    Ok(result)
}

fn valid_asset_receipt(value: &Value) -> bool {
    value["consumerVersion"] == 1
        && value["assetId"].as_str().is_some_and(|id| !id.is_empty())
        && matches!(
            value["disposition"].as_str(),
            Some("imported" | "duplicate")
        )
}
