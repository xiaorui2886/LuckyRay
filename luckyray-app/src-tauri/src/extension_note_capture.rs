use crate::{
    attachment_coordination, backend, knowledge, knowledge_error, local_transport, materials,
    publish_attachment_with_services, KnowledgePublishAttachmentInput,
};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteMaterialAttachRequest {
    request_id: String,
    asset_id: Option<String>,
    content: Option<String>,
    target: String,
    #[serde(default)]
    note_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    binding: NoteTargetBinding,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteTargetRequest {
    target: String,
    note_id: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteTargetBinding {
    activation: knowledge::KnowledgeUiSourceActivation,
    document_ref: Option<knowledge::KnowledgeDocumentRef>,
    revision: Option<String>,
    current_context: Option<knowledge::KnowledgeCurrentContext>,
}

fn prepare_target(
    service: &knowledge::KnowledgeService,
    request: NoteTargetRequest,
) -> Result<NoteTargetBinding, String> {
    let activation = service
        .active_ui_source_identity()
        .map_err(knowledge_error)?;
    let (document_ref, revision, current_context) = match request.target.as_str() {
        "current" => {
            let context = service
                .get_current_context()
                .map_err(knowledge_error)?
                .ok_or("knowledge-current-context-required: 请先打开笔记。")?;
            if request.note_id.as_deref()
                != Some(knowledge::KnowledgeService::document_id(&context.document_ref).as_str())
            {
                return Err("knowledge-current-context-changed: 当前笔记已变化。".into());
            }
            (
                Some(context.document_ref.clone()),
                Some(context.expected_revision.clone()),
                Some(context),
            )
        }
        "existing" => {
            let document_ref = knowledge::KnowledgeService::parse_document_id(
                request
                    .note_id
                    .as_deref()
                    .ok_or("note-material-target-invalid: 请选择笔记。")?,
            )
            .map_err(knowledge_error)?;
            if document_ref.vault_id != activation.vault_id {
                return Err("knowledge-target-not-current: 笔记不属于当前知识库。".into());
            }
            let snapshot = service
                .read_document(&document_ref)
                .map_err(knowledge_error)?;
            (Some(document_ref), Some(snapshot.revision), None)
        }
        "new" => (None, None, None),
        _ => return Err("note-material-target-invalid: 笔记目标无效。".into()),
    };
    let _source = service
        .lock_active_ui_source(activation.source_epoch, Some(&activation.vault_id))
        .map_err(knowledge_error)?;
    Ok(NoteTargetBinding {
        activation,
        document_ref,
        revision,
        current_context,
    })
}

pub(crate) fn note_target_response(
    backend: &backend::BackendServices,
    body: Option<&str>,
) -> local_transport::AdapterResponse {
    let result = body
        .and_then(|value| serde_json::from_str::<NoteTargetRequest>(value).ok())
        .ok_or_else(|| "note-material-input-invalid: 笔记目标请求无效。".to_owned())
        .and_then(|request| prepare_target(&backend.knowledge(), request))
        .and_then(|binding| {
            serde_json::to_value(binding)
                .map_err(|_| "note-material-input-invalid: 笔记目标编码失败。".to_owned())
        });
    response_from_result(result)
}

fn bounded_note_source_url(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.len() > 4096 || raw.chars().any(char::is_control) || raw.contains('\\') {
        return Err("note-material-source-invalid: 网页来源地址无效。".into());
    }
    let parsed =
        reqwest::Url::parse(raw).map_err(|_| "note-material-source-invalid: 网页来源地址无效。")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("note-material-source-invalid: 网页来源地址无效。".into());
    }
    Ok(Some(parsed.to_string()))
}

fn attach_material_to_note_with_services(
    service: &knowledge::KnowledgeService,
    catalog: &materials::MaterialCatalog,
    request: NoteMaterialAttachRequest,
) -> Result<serde_json::Value, String> {
    if request.asset_id.is_some() == request.content.is_some() {
        return Err("note-material-input-invalid: 请选择素材或正文之一。".into());
    }
    if let Some(id) = request.asset_id.as_deref() {
        if id.is_empty() || id.len() > 256 || id.trim() != id || id.chars().any(char::is_control) {
            return Err("note-material-asset-invalid: 素材标识无效。".into());
        }
    }
    if request
        .content
        .as_deref()
        .is_some_and(|text| text.trim().is_empty() || text.len() > 256 * 1024)
    {
        return Err("note-material-input-invalid: 正文为空或过长。".into());
    }
    let source_url = bounded_note_source_url(request.source_url.as_deref())?;
    let activation = service
        .active_ui_source_identity()
        .map_err(knowledge_error)?;
    if activation != request.binding.activation {
        return Err("knowledge-source-inactive: 知识库已切换或关闭。".into());
    }
    let prepared = prepare_target(
        service,
        NoteTargetRequest {
            target: request.target.clone(),
            note_id: request.note_id.clone(),
        },
    )?;
    if prepared.document_ref != request.binding.document_ref {
        return Err("knowledge-target-not-current: 保存目标已变化。".into());
    }
    if prepared.revision != request.binding.revision {
        return Err("knowledge-revision-conflict: 笔记内容已变化。".into());
    }
    if prepared.current_context != request.binding.current_context {
        return Err("knowledge-current-context-changed: 当前编辑位置已变化。".into());
    }
    let asset = if let Some(id) = request.asset_id.as_ref() {
        Some(
            catalog
                .get_assets(&[id.clone()])
                .map_err(|error| error.message)?
                .into_iter()
                .next()
                .ok_or("note-material-not-found: 素材不存在。")?,
        )
    } else {
        None
    };

    let (document_ref, revision, current_context, created) = match request.target.as_str() {
        "current" | "existing" => (
            prepared
                .document_ref
                .ok_or("note-material-target-invalid: 缺少笔记目标。")?,
            prepared
                .revision
                .ok_or("note-material-target-invalid: 缺少笔记版本。")?,
            prepared.current_context,
            false,
        ),
        "new" => {
            let title = request
                .title
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("浏览器收集");
            if title.len() > 240 || title.chars().any(char::is_control) {
                return Err("note-material-title-invalid: 笔记标题无效。".into());
            }
            let snapshot = create_capture_document(service, activation.source_epoch, title)?;
            (snapshot.summary.document_ref, snapshot.revision, None, true)
        }
        _ => return Err("note-material-target-invalid: 笔记目标无效。".into()),
    };

    let published = if let Some(asset) = asset {
        Some(
            match publish_attachment_with_services(
                service,
                catalog,
                KnowledgePublishAttachmentInput {
                    document_ref: document_ref.clone(),
                    source_epoch: activation.source_epoch,
                    expected_revision: revision.clone(),
                    name: asset.name,
                    bytes: None,
                    source_path: None,
                    material_id: request.asset_id,
                    handling_policy: None,
                },
            ) {
                Ok(published) => published,
                Err(_error) => {
                    if created {
                        let _ = service.delete_document_from_ui(
                            activation.source_epoch,
                            &knowledge::KnowledgeDeleteInput {
                                document_ref: document_ref.clone(),
                                expected_revision: revision.clone(),
                            },
                        );
                    }
                    return Err(
                        "capture-commit-partial: 附件发布未完成，请先在桌面端核对笔记和附件。"
                            .into(),
                    );
                }
            },
        )
    } else {
        None
    };
    let content = published
        .as_ref()
        .map(|attachment| attachment.markdown.clone())
        .or(request.content)
        .unwrap_or_default();
    let block = match source_url {
        Some(source_url) => format!("{content}\n\n来源：{source_url}"),
        None => content,
    };
    let mutation = (|| {
        if let Some(context) = current_context {
            let source = service
                .lock_active_ui_source(activation.source_epoch, Some(&document_ref.vault_id))
                .map_err(knowledge_error)?;
            service
                .insert_material_block_into_bound_current(&block, &context, &source)
                .map_err(knowledge_error)
        } else {
            service
                .append_document_from_ui(
                    activation.source_epoch,
                    &knowledge::KnowledgeWriteInput {
                        document_ref: document_ref.clone(),
                        content: block.clone(),
                        expected_revision: Some(revision.clone()),
                    },
                )
                .map_err(knowledge_error)
        }
    })();
    let mut result = match mutation {
        Ok(result) => result,
        Err(error) => {
            let rollback = if created {
                service
                    .delete_document_from_ui(
                        activation.source_epoch,
                        &knowledge::KnowledgeDeleteInput {
                            document_ref: document_ref.clone(),
                            expected_revision: revision,
                        },
                    )
                    .is_ok()
            } else {
                true
            };
            if published.is_none() && rollback {
                return Err(error);
            }
            return Err(
                "capture-commit-partial: 附件已发布，但笔记写入未完成，请先在桌面端核对。".into(),
            );
        }
    };
    if let Err(_message) =
        attachment_coordination::sync_note_attachment_index(service, catalog, &document_ref)
    {
        result.index_stale = true;
        result.index_warning = Some(knowledge::KnowledgeMutationWarning {
            code: "attachment-index-pending".into(),
            message: "附件索引等待同步。".into(),
        });
    }
    Ok(serde_json::json!({
        "noteId": knowledge::KnowledgeService::document_id(&document_ref),
        "documentRef": document_ref,
        "revision": result.document.revision,
        "position": result.position,
        "created": created,
        "attachment": published,
        "indexStale": result.index_stale,
        "indexWarning": result.index_warning,
    }))
}

pub(crate) fn note_material_attach_response(
    backend: &backend::BackendServices,
    principal: &local_transport::VerifiedTransportPrincipal,
    body: Option<&str>,
) -> local_transport::AdapterResponse {
    let request = match body.and_then(|body| serde_json::from_str::<NoteMaterialAttachRequest>(body).ok()) {
        Some(request) => request,
        None => {
            return local_transport::AdapterResponse {
                status: 400,
                body: serde_json::json!({"code":"note-material-input-invalid","message":"附件写入请求无效。"}).to_string(),
            }
        }
    };
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':'))
    {
        return response_from_result(Err("note-material-input-invalid: 请求标识无效。".into()));
    }
    let key = principal.capture_request_key(&request.request_id);
    let input = serde_json::to_vec(&request).expect("serializable capture input");
    run_with_receipt(
        &backend.app_data_dir().join("note-capture-receipts"),
        &key,
        &input,
        || {
            response_from_result(attach_material_to_note_with_services(
                &backend.knowledge(),
                &backend.material_catalog(),
                request,
            ))
        },
    )
}

pub(crate) fn media_response_with_receipt(
    backend: &backend::BackendServices,
    principal: &local_transport::VerifiedTransportPrincipal,
    path: &str,
    body: Option<&str>,
    operation: impl FnOnce() -> local_transport::AdapterResponse,
) -> local_transport::AdapterResponse {
    let parsed = body.and_then(|body| serde_json::from_str::<serde_json::Value>(body).ok());
    let Some(request_id) = parsed
        .as_ref()
        .and_then(|value| value.get("requestId"))
        .and_then(serde_json::Value::as_str)
    else {
        return operation();
    };
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':'))
    {
        return response_from_result(Err("note-material-input-invalid: 请求标识无效。".into()));
    }
    let key = principal.capture_request_key(&format!("{path}:{request_id}"));
    let input = serde_json::to_vec(&parsed).expect("serializable media input");
    let response = run_with_receipt(
        &backend.app_data_dir().join("note-capture-receipts"),
        &key,
        &input,
        operation,
    );
    if path == "/api/media/transfers" && response.status == 202 {
        let current_job = serde_json::from_str::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|value| {
                value
                    .get("transferId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .and_then(|id| backend.media_transfer().status(&id).ok());
        if current_job.is_none() {
            return response_from_result(Err(
                "capture-commit-uncertain: 下载任务已不在当前桌面实例中，请先核对素材。".into(),
            ));
        }
    }
    response
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CaptureReceipt {
    status: u16,
    body: String,
}

// A capture always creates a new document: collision suffixes never overwrite
// an existing note. Each attempt rechecks the UI source epoch and uses the
// service's serialized, create-new write; other errors must not be retried.
fn create_capture_document(
    service: &knowledge::KnowledgeService,
    source_epoch: u64,
    title: &str,
) -> Result<knowledge::KnowledgeDocumentSnapshot, String> {
    let stem = if title.to_ascii_lowercase().ends_with(".md") { &title[..title.len() - 3] } else { title };
    for index in 0..1000 {
        let name = if index == 0 { title.to_owned() } else {
            let suffix = format!(" {index}");
            let mut end = stem.len().min(240 - suffix.len());
            while !stem.is_char_boundary(end) { end -= 1; }
            format!("{}{suffix}", &stem[..end])
        };
        match service.create_document_from_ui(source_epoch, &knowledge::KnowledgeCreateInput {
            title: name, parent_relative_path: None, content: String::new(),
        }) {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) if error.code == "knowledge-name-conflict" => continue,
            Err(error) => return Err(knowledge_error(error)),
        }
    }
    Err("knowledge-name-conflict: 同名笔记过多，请修改标题后重试。".into())
}

// Identity-only reconciliation for the existing durable ledger. This does not
// reserve an intent, execute an operation, create files, or infer zero writes
// from a missing result. Current domain authorization is checked by the caller.
pub(crate) fn read_media_receipt(
    backend: &backend::BackendServices,
    principal: &local_transport::VerifiedTransportPrincipal,
    path: &str,
    request_id: &str,
) -> Option<local_transport::AdapterResponse> {
    use std::io::Read;
    let key = principal.capture_request_key(&format!("{path}:{request_id}"));
    let directory = backend.app_data_dir().join("note-capture-receipts");
    let started = directory.join(format!("{key}.started"));
    let completed = directory.join(format!("{key}.result"));
    let lock = capture_lock(started.clone())?;
    // Do not block status polling behind an in-progress filesystem operation.
    let _guard = lock.try_lock().ok()?;
    let mut intent = String::new();
    std::fs::File::open(started).ok()?.take(65).read_to_string(&mut intent).ok()?;
    if intent.len() != 64 || !intent.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    const MAX_RECEIPT_BYTES: u64 = 256 * 1024;
    let mut bytes = Vec::new();
    std::fs::File::open(completed).ok()?.take(MAX_RECEIPT_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES { return None; }
    let receipt: CaptureReceipt = serde_json::from_slice(&bytes).ok()?;
    Some(local_transport::AdapterResponse { status: receipt.status, body: receipt.body })
}

fn capture_lock(path: std::path::PathBuf) -> Option<std::sync::Arc<std::sync::Mutex<()>>> {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex, OnceLock, Weak},
    };
    static LOCKS: OnceLock<Mutex<HashMap<std::path::PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().ok()?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) {
        return Some(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path, Arc::downgrade(&lock));
    Some(lock)
}

// Persist intent before the first side effect, and the result before replying.
// An interrupted operation is never silently executed a second time.
fn run_with_receipt(
    directory: &std::path::Path,
    key: &str,
    input: &[u8],
    operation: impl FnOnce() -> local_transport::AdapterResponse,
) -> local_transport::AdapterResponse {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let unavailable = || local_transport::AdapterResponse {
        status: 503,
        body: r#"{"code":"capture-receipt-unavailable"}"#.into(),
    };
    let uncertain = || {
        local_transport::AdapterResponse { status: 409, body: r#"{"code":"capture-commit-uncertain","message":"请先在桌面端核对笔记，此请求不会重复写入。"}"#.into() }
    };
    if std::fs::create_dir_all(directory).is_err() {
        return unavailable();
    }
    let started = directory.join(format!("{key}.started"));
    let completed = directory.join(format!("{key}.result"));
    let Some(lock) = capture_lock(started.clone()) else {
        return unavailable();
    };
    let Ok(_guard) = lock.lock() else {
        return uncertain();
    };
    let fingerprint = format!("{:x}", Sha256::digest(input));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&started)
    {
        Ok(mut file) => {
            if file
                .write_all(fingerprint.as_bytes())
                .and_then(|_| file.sync_all())
                .is_err()
            {
                return unavailable();
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let Ok(previous) = std::fs::read_to_string(&started) else {
                return uncertain();
            };
            if previous != fingerprint {
                return local_transport::AdapterResponse {
                    status: 409,
                    body: r#"{"code":"request-id-conflict"}"#.into(),
                };
            }
            return std::fs::read(&completed)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<CaptureReceipt>(&bytes).ok())
                .map(|receipt| local_transport::AdapterResponse {
                    status: receipt.status,
                    body: receipt.body,
                })
                .unwrap_or_else(uncertain);
        }
        Err(_) => return unavailable(),
    }
    let response = operation();
    let receipt = CaptureReceipt {
        status: response.status,
        body: response.body.clone(),
    };
    let persisted = serde_json::to_vec(&receipt).ok().and_then(|bytes| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(completed)
            .ok()?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).ok()
    });
    if persisted.is_none() {
        return uncertain();
    }
    response
}

fn response_from_result(
    result: Result<serde_json::Value, String>,
) -> local_transport::AdapterResponse {
    match result {
        Ok(value) => local_transport::AdapterResponse {
            status: 200,
            body: value.to_string(),
        },
        Err(error) => {
            let encoded = serde_json::from_str::<serde_json::Value>(&error).ok();
            let split = error.split_once(": ").filter(|(code, _)| {
                code.chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
            });
            let code = encoded
                .as_ref()
                .and_then(|value| value.get("code"))
                .and_then(serde_json::Value::as_str)
                .or_else(|| split.map(|(code, _)| code))
                .unwrap_or("note-material-attach-failed");
            let message = encoded
                .as_ref()
                .and_then(|value| value.get("message"))
                .and_then(serde_json::Value::as_str)
                .or_else(|| split.map(|(_, message)| message))
                .unwrap_or("附件写入失败，请重试。");
            let status = if code.ends_with("not-found") {
                404
            } else if code.ends_with("invalid") {
                400
            } else {
                409
            };
            local_transport::AdapterResponse {
                status,
                body: serde_json::json!({"code":code,"message":message}).to_string(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn capture_titles_preserve_existing_notes_and_retry_only_name_conflicts() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("vault");
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let vault = knowledge::KnowledgeVaultRegistration {
            id: "r7-capture".into(), name: "R7".into(), root_path: root.to_string_lossy().into(),
            mode: "vault-bound".into(), created_at: "2026-10-04T00:00:00Z".into(),
            last_opened_at: "2026-10-04T00:00:00Z".into(), schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&vault).unwrap()).unwrap();
        let service = knowledge::KnowledgeService::initialize(&directory.path().join("app")).unwrap();
        service.register_current_vault(&vault).unwrap();
        let activation = service.activate_ui_source(&vault.id).unwrap();
        std::fs::write(root.join("新笔记.md"), "original content").unwrap();
        let named = create_capture_document(&service, activation.source_epoch, "扩展上下文额度变化").unwrap();
        assert_eq!(named.summary.document_ref.relative_path, "扩展上下文额度变化.md");
        for (title, expected) in [("新笔记", "新笔记 1.md"), ("新笔记.md", "新笔记 2.md")] {
            let created = create_capture_document(&service, activation.source_epoch, title).unwrap();
            assert_eq!(created.summary.document_ref.relative_path, expected);
        }
        assert_eq!(std::fs::read_to_string(root.join("新笔记.md")).unwrap(), "original content");
        service.deactivate_ui_source().unwrap();
        assert!(create_capture_document(&service, activation.source_epoch, "must not exist").is_err());
        assert!(!root.join("must not exist.md").exists());
    }

    #[test]
    fn capture_receipt_interruption_never_reexecutes_the_operation() {
        let directory = std::env::temp_dir().join(format!(
            "lr-capture-receipt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("interrupted.started"),
            format!("{:x}", Sha256::digest(b"input")),
        )
        .unwrap();
        let response = run_with_receipt(&directory, "interrupted", b"input", || {
            panic!("must not replay an uncertain write")
        });
        assert_eq!(response.status, 409);
        assert!(response.body.contains("capture-commit-uncertain"));
        std::fs::write(directory.join("interrupted.result"), b"partial JSON").unwrap();
        let response = run_with_receipt(&directory, "interrupted", b"input", || {
            panic!("must not replay with a damaged receipt")
        });
        assert_eq!(response.status, 409);
        assert!(response.body.contains("capture-commit-uncertain"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn capture_receipt_replays_the_original_success_after_reopening_storage() {
        let directory = std::env::temp_dir().join(format!(
            "lr-capture-receipt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = run_with_receipt(&directory, "completed", b"input", || {
            local_transport::AdapterResponse {
                status: 200,
                body: r#"{"noteId":"one-note"}"#.into(),
            }
        });
        let second = run_with_receipt(&directory, "completed", b"input", || {
            panic!("must reuse durable receipt")
        });
        assert_eq!(first.body, second.body);
        assert_eq!(second.status, 200);
        let conflict = run_with_receipt(&directory, "completed", b"changed", || {
            panic!("conflicting input must not execute")
        });
        assert_eq!(conflict.status, 409);
        assert!(conflict.body.contains("request-id-conflict"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn capture_receipt_concurrent_requests_execute_once() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let directory = std::env::temp_dir().join(format!(
            "lr-capture-concurrent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let count = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let directory = directory.clone();
                let count = count.clone();
                std::thread::spawn(move || {
                    run_with_receipt(&directory, "same-request", b"input", || {
                        count.fetch_add(1, Ordering::SeqCst);
                        local_transport::AdapterResponse {
                            status: 200,
                            body: "one-result".into(),
                        }
                    })
                })
            })
            .collect();
        for thread in threads {
            let result = thread.join().unwrap();
            assert_eq!(result.status, 200);
            assert_eq!(result.body, "one-result");
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn capture_transfer_receipt_does_not_revive_a_job_after_backend_restart() {
        use crate::local_transport::TransportAdapter;
        let directory = std::env::temp_dir().join(format!(
            "lr-capture-restart-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let principal = local_transport::VerifiedTransportPrincipal::capture_test_principal();
        let input =
            r#"{"requestId":"restart-video","url":"file:///invalid.mp4","fileName":"test.mp4"}"#;
        let backend =
            std::sync::Arc::new(backend::BackendServices::initialize(&directory).unwrap());
        let adapter = crate::LegacyLocalTransportAdapter::new(backend);
        let first =
            adapter.dispatch_verified(&principal, "POST", "/api/media/transfers", Some(input));
        assert_eq!(first.status, 202, "{}", first.body);
        let restarted =
            std::sync::Arc::new(backend::BackendServices::initialize(&directory).unwrap());
        let restarted_adapter = crate::LegacyLocalTransportAdapter::new(restarted);
        let replay = restarted_adapter.dispatch_verified(
            &principal,
            "POST",
            "/api/media/transfers",
            Some(input),
        );
        assert_eq!(replay.status, 409);
        assert!(replay.body.contains("capture-commit-uncertain"));
    }
}
