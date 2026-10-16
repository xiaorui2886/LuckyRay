//! Host adapter only: caller has already authenticated the local transport and
//! derived per-library rights. No unverified dispatch or body-supplied grants.
use super::consumer::*;
use crate::{
    backend::BackendServices,
    local_transport::{AdapterResponse, VerifiedTransportPrincipal},
};
use serde_json::{json, Value};
struct CapturePermit;
static CAPTURES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
impl CapturePermit {
    fn acquire() -> Option<Self> {
        CAPTURES
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |n| (n < 2).then_some(n + 1),
            )
            .ok()
            .map(|_| Self)
    }
}
impl Drop for CapturePermit {
    fn drop(&mut self) {
        CAPTURES.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

pub(crate) fn handles(path: &str) -> bool {
    matches!(
        path,
        "/api/material-libraries"
            | "/api/material-libraries/taxonomy"
            | "/api/material-libraries/import-bytes"
            | "/api/material-libraries/capture-receipt"
            | "/api/material-libraries/query"
            | "/api/material-libraries/detail"
    )
}
pub(crate) fn response(result: super::MaterialResult<Value>) -> AdapterResponse {
    match result {
        Ok(value) => AdapterResponse {
            status: 200,
            body: value.to_string(),
        },
        Err(error) => {
            let (status, message) = match error.code.as_str() {
                "consumer-library-denied"
                | "consumer-folder-denied"
                | "consumer-tag-denied"
                | "material-library-scope" => (403, "此素材库或分类标签未获授权"),
                "consumer-asset-not-found" | "not-found" => (404, "素材不存在于目标库"),
                "library-unavailable" | "library-offline" => {
                    (409, "素材库已移除或位置不可用，请重新选择")
                }
                "consumer-capture-too-large" => (413, "素材超过12MiB"),
                "consumer-input-invalid" | "library-invalid" => (400, "请求字段或截图正文内容无效"),
                _ => (503, "素材服务暂不可用，请核对目标库后重试"),
            };
            AdapterResponse {
                status,
                body: json!({"code":error.code,"message":message}).to_string(),
            }
        }
    }
}
pub(crate) fn route<G>(
    backend: &BackendServices,
    principal: &VerifiedTransportPrincipal,
    authorization: ConsumerAuthorization,
    method: &str,
    path: &str,
    body: Option<&str>,
    before_write: impl FnOnce(&ConsumerTarget) -> super::MaterialResult<G>,
) -> Option<AdapterResponse> {
    if !handles(path) {
        return None;
    }
    let service = MaterialConsumer::new(backend.material_catalog(), authorization);
    let expected = if path == "/api/material-libraries" {
        "GET"
    } else {
        "POST"
    };
    if method != expected {
        return Some(AdapterResponse {
            status: 405,
            body: json!({"code":"METHOD_NOT_ALLOWED"}).to_string(),
        });
    }
    if path == "/api/material-libraries" {
        return Some(response(service.libraries()));
    }
    let Some(body) = body else {
        return Some(response(Err(super::MaterialError::new(
            "consumer-input-invalid",
            "请求缺少正文",
        ))));
    };
    if path == "/api/material-libraries/capture-receipt" {
        return Some(response((|| {
            let target = serde_json::from_str::<ConsumerTarget>(body)
                .map_err(|_| super::MaterialError::new("consumer-input-invalid", "请求字段无效"))?;
            // The original import and this read require the same read/import
            // scope. A cached receipt never overrides current availability,
            // authentication, permission or the explicit target library.
            service.authorize_import(&target)?;
            let _current = before_write(&target)?;
            let stored = crate::extension_note_capture::read_media_receipt(
                backend, principal, "/api/material-libraries/import-bytes", &target.request_id);
            let receipt = stored.filter(|value| value.status == 200)
                .and_then(|value| serde_json::from_str::<Value>(&value.body).ok())
                .filter(|value| value["consumerVersion"] == CONSUMER_VERSION
                    && value["libraryId"] == target.library_id && value["requestId"] == target.request_id
                    && value["assetId"].as_str().is_some_and(|id| !id.is_empty())
                    && matches!(value["disposition"].as_str(), Some("imported" | "duplicate")));
            Ok(json!({"receiptLookupVersion":1,"libraryId":target.library_id,"requestId":target.request_id,
                "state":if receipt.is_some() { "completed" } else { "unknown" }, "receipt":receipt}))
        })()));
    }
    if path == "/api/material-libraries/import-bytes" {
        let input = match serde_json::from_str::<ConsumerBytesInput>(body) {
            Ok(input) => input,
            Err(_) => {
                return Some(response(Err(super::MaterialError::new(
                    "consumer-input-invalid",
                    "请求字段无效",
                ))))
            }
        };
        let target = ConsumerTarget {
            library_id: input.library_id.clone(),
            request_id: input.request_id.clone(),
        };
        // Cached results never bypass current library authorization/availability.
        if let Err(error) = service.authorize_import(&target) {
            return Some(response(Err(error)));
        }
        // Admission precedes durable intent: a busy response may retry the same
        // operation after another capture completes without storing a failure.
        let Some(_permit) = CapturePermit::acquire() else {
            return Some(AdapterResponse {
                status: 429,
                body: json!({"code":"consumer-capture-busy"}).to_string(),
            });
        };
        return Some(crate::extension_note_capture::media_response_with_receipt(
            backend,
            principal,
            path,
            Some(body),
            || response(service.import_bytes_checked(&input, || before_write(&target))),
        ));
    }
    if path == "/api/material-libraries/taxonomy" {
        return Some(response(
            serde_json::from_str::<ConsumerTarget>(body)
                .map_err(|_| super::MaterialError::new("consumer-input-invalid", "请求字段无效"))
                .and_then(|target| service.taxonomy(&target)),
        ));
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Read {
        library_id: String,
        request_id: String,
        #[serde(default)]
        asset_id: Option<String>,
        #[serde(default)]
        filter: super::MaterialFilter,
    }
    let parsed = serde_json::from_str::<Read>(body)
        .map_err(|_| super::MaterialError::new("consumer-input-invalid", "请求字段无效"));
    Some(response(parsed.and_then(|read| {
        let target = ConsumerTarget {
            library_id: read.library_id,
            request_id: read.request_id,
        };
        if path.ends_with("/query") {
            service.list(&target, &read.filter)
        } else {
            service.detail(
                &target,
                read.asset_id.as_deref().ok_or_else(|| {
                    super::MaterialError::new("consumer-input-invalid", "缺少素材身份")
                })?,
            )
        }
    })))
}
