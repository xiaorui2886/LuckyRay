use super::*;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};

const MAX_UPLOAD: u64 = 64 * 1024 * 1024;
const MAX_CHUNK: usize = 256 * 1024;

fn hex_digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

fn validate_begin(value: &Value) -> ServiceResult<()> {
    let obj = value.as_object().ok_or((400, "INPUT_INVALID"))?;
    if obj.keys().any(|key| !matches!(key.as_str(),
        "opId" | "kind" | "target" | "name" | "mimeType" | "sizeBytes" | "sha256" | "text" | "source")) {
        return Err((400, "INPUT_INVALID"));
    }
    if !value["opId"].as_str().is_some_and(valid_id)
        || !value["kind"].as_str().is_some_and(|kind| matches!(kind,
            "text" | "url" | "clipboard" | "image" | "video" | "file")) {
        return Err((400, "INPUT_INVALID"));
    }
    let name = value["name"].as_str().ok_or((400, "INPUT_INVALID"))?;
    if name.trim().is_empty() || name.len() > 255 || name.chars().any(char::is_control)
        || name.contains('/') || name.contains('\\') { return Err((400, "INPUT_INVALID")); }
    let mime = value["mimeType"].as_str().ok_or((400, "INPUT_INVALID"))?;
    if mime.is_empty() || mime.len() > 255 || mime.chars().any(char::is_control) || !mime.contains('/') {
        return Err((400, "INPUT_INVALID"));
    }
    let size = value["sizeBytes"].as_u64().ok_or((400, "INPUT_INVALID"))?;
    if !(1..=MAX_UPLOAD).contains(&size) { return Err((400, "INPUT_INVALID")); }
    let digest = value["sha256"].as_str().ok_or((400, "INPUT_INVALID"))?;
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err((400, "INPUT_INVALID"));
    }
    let kind = value["kind"].as_str().unwrap_or("");
    if matches!(kind, "text" | "url" | "clipboard") {
        let text = value["text"].as_str().filter(|text| !text.is_empty() && text.len() <= 4 * 1024 * 1024)
            .ok_or((400, "INPUT_INVALID"))?;
        if text.len() as u64 != size || hex_digest(text.as_bytes()) != digest
            || (kind == "url" && !sharable_page_url(text)) { return Err((400, "INPUT_INVALID")); }
    } else if obj.contains_key("text") { return Err((400, "INPUT_INVALID")); }
    let target = value["target"].as_object().ok_or((400, "INPUT_INVALID"))?;
    match value["target"]["domain"].as_str() {
        Some("materials") => {
            if target.keys().any(|key| !matches!(key.as_str(), "domain" | "folderId" | "libraryId"))
                || target.get("libraryId").is_some_and(|v| !v.is_null() && !v.as_str().is_some_and(valid_id))
                || target.get("folderId").is_some_and(|v| !v.is_null() && !v.as_str().is_some_and(valid_id)) {
                return Err((400, "INPUT_INVALID"));
            }
        }
        Some("knowledge") => {
            if target.len() != 3 || !value["target"]["vaultId"].as_str().is_some_and(valid_id)
                || !value["target"]["parentRelativePath"].as_str().is_some_and(safe_relative_path) {
                return Err((400, "INPUT_INVALID"));
            }
        }
        _ => return Err((400, "INPUT_INVALID")),
    }
    if let Some(source) = obj.get("source") {
        let source = source.as_object().ok_or((400, "INPUT_INVALID"))?;
        if source.keys().any(|key| !matches!(key.as_str(), "captureKind" | "pageKind" | "pageUrl" | "siteOrigin" | "capturedAt"))
            || !value["source"]["captureKind"].as_str().is_some_and(|v|
                matches!(v, "web" | "import" | "clipboard" | "unknown")) {
            return Err((400, "INPUT_INVALID"));
        }
        if let Some(kind) = source.get("pageKind") {
            if !kind.as_str().is_some_and(|v| matches!(v, "work-page" | "capture-page"))
                || (kind.as_str() == Some("work-page") && !value["source"]["pageUrl"].is_string()) {
                return Err((400, "INPUT_INVALID"));
            }
        }
        if let Some(url) = source.get("pageUrl") {
            if !url.as_str().is_some_and(sharable_page_url) { return Err((400, "INPUT_INVALID")); }
        }
        if let Some(origin) = source.get("siteOrigin") {
            let text = origin.as_str().ok_or((400, "INPUT_INVALID"))?;
            let parsed = reqwest::Url::parse(text).map_err(|_| (400, "INPUT_INVALID"))?;
            if !sharable_page_url(text) || parsed.origin().ascii_serialization() != text {
                return Err((400, "INPUT_INVALID"));
            }
        }
        if let Some(at) = source.get("capturedAt") {
            if !at.as_str().is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()) {
                return Err((400, "INPUT_INVALID"));
            }
        }
    }
    Ok(())
}

fn safe_relative_path(path: &str) -> bool {
    path.len() <= 1024 && !path.starts_with('/') && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && !path.split('/').any(|component| component == ".." || component == ".")
        && !path.contains(':')
}

#[cfg(test)]
mod selected_library_validation_tests {
    use super::*;

    #[test]
    fn malformed_library_id_is_not_treated_as_legacy_default() {
        let mut request = json!({"opId":"library-validation", "kind":"text",
            "target":{"domain":"materials"}, "name":"fixture.txt", "mimeType":"text/plain",
            "sizeBytes":1, "sha256":hex_digest(b"x"), "text":"x"});
        assert!(validate_begin(&request).is_ok());
        for id in [json!(7), json!(true), json!({}), json!([]), json!(""), json!("../other")] {
            request["target"]["libraryId"] = id;
            assert_eq!(validate_begin(&request), Err((400, "INPUT_INVALID")));
        }
        for id in [Value::Null, json!("library-synthetic")] {
            request["target"]["libraryId"] = id;
            assert!(validate_begin(&request).is_ok());
        }
    }
}

fn authorized_target(gateway: &CompanionGateway, device: &PairedDevice, manifest: &Value) -> ServiceResult<()> {
    match manifest["target"]["domain"].as_str() {
        Some("materials") => {
            if manifest["target"].get("libraryId").and_then(Value::as_str) != gateway.material_scope_id() {
                return Err((409,"SCOPE_MISMATCH"));
            }
            if granted(gateway, &device.device_id, "ingest.write", "catalog", "")? { Ok(()) }
            else { Err((403, "GRANT_REQUIRED")) }
        }
        Some("knowledge") => {
            let vault = manifest["target"]["vaultId"].as_str().ok_or((400, "INPUT_INVALID"))?;
            if !granted(gateway, &device.device_id, "ingest.write", "vault", vault)? {
                return Err((403, "GRANT_REQUIRED"));
            }
            if current_vault(gateway)?.as_ref().map(|(id, _)| id.as_str()) != Some(vault) {
                return Err((503, "SERVICE_UNAVAILABLE"));
            }
            Ok(())
        }
        _ => Err((400, "INPUT_INVALID")),
    }
}

fn staging_file(gateway: &CompanionGateway, job_id: &str) -> ServiceResult<std::path::PathBuf> {
    if !valid_id(job_id) { return Err((404, "JOB_NOT_OWNED")); }
    let root = crate::materials::resolve_media_staging_root(
        &gateway.backend.app_data_dir().join("media-transfer-staging"),
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(root.join(format!("service-{job_id}.part")))
}

fn load_job(gateway: &CompanionGateway, device: &PairedDevice, job_id: &str)
    -> ServiceResult<(Value, u64, String, Option<Value>, String)> {
    if !valid_id(job_id) { return Err((404, "JOB_NOT_OWNED")); }
    let instance = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let row = database(gateway)?.query_row(
        "SELECT manifest,committed_bytes,stage,receipt,op_id FROM companion_service_upload
         WHERE job_id=?1 AND instance_id=?2 AND device_id=?3",
        params![job_id, instance, device.device_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?,
            row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?)),
    ).optional().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        .ok_or((404, "JOB_NOT_OWNED"))?;
    let manifest: Value = serde_json::from_str(&row.0).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    authorized_target(gateway, device, &manifest)?;
    let receipt = row.3.map(|r| serde_json::from_str(&r).map_err(|_| (503, "SERVICE_UNAVAILABLE")))
        .transpose()?;
    Ok((manifest, row.1, row.2, receipt, row.4))
}

fn job_value(job_id: &str, op_id: &str, stage: &str, committed: u64, receipt: Option<Value>) -> Value {
    // `committing` is a crash-recovery marker, not a Services V1 wire state.
    let public_state = if stage == "committing" { "staging" } else { stage };
    let mut value = json!({"jobId": job_id, "opId": op_id, "state": public_state, "committedBytes": committed});
    if let Some(receipt) = receipt { value["receipt"] = receipt; }
    value
}

pub(super) fn begin(gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, body: &[u8]) -> ServiceResult<(u16, Value)> {
    if body.len() > 4 * 1024 * 1024 + 4096 { return Err((413, "PAYLOAD_TOO_LARGE")); }
    let (mut manifest, _) = canonical_body(body)?;
    validate_begin(&manifest)?;
    if manifest["target"]["domain"] == "materials" {
        if let Some(supplied) = manifest["target"].get("libraryId") {
            if supplied.as_str() != gateway.material_scope_id() { return Err((409,"SCOPE_MISMATCH")); }
        }
        if let Some(scope) = gateway.material_scope_id() { manifest["target"]["libraryId"] = json!(scope); }
    }
    let hash = hex_digest(&serde_json::to_vec(&manifest).map_err(|_| (400,"INPUT_INVALID"))?);
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    authorized_target(gateway, device, &manifest)?;
    let op_id = manifest["opId"].as_str().ok_or((400, "INPUT_INVALID"))?;
    let instance = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let connection = database(gateway)?;
    let previous = connection.query_row(
        "SELECT job_id,manifest,committed_bytes,stage,receipt FROM companion_service_upload
         WHERE instance_id=?1 AND device_id=?2 AND op_id=?3",
        params![instance, device.device_id, op_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?,
            row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?)),
    ).optional().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if let Some((job_id, old, offset, stage, receipt)) = previous {
        let old: Value = serde_json::from_str(&old).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        let old_hash = hex_digest(&serde_json::to_vec(&old).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?);
        if old_hash != hash { return Err((409, "OP_ID_REUSED")); }
        let receipt = receipt.map(|r| serde_json::from_str(&r).map_err(|_| (503, "SERVICE_UNAVAILABLE")))
            .transpose()?;
        return Ok((200, job_value(&job_id, op_id, &stage, offset, receipt)));
    }
    let active: u64 = connection.query_row(
        "SELECT COUNT(*) FROM companion_service_upload WHERE instance_id=?1 AND device_id=?2 AND stage IN ('staging','committing')",
        params![instance, device.device_id], |row| row.get(0),
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if active >= 2 { return Err((429, "RATE_LIMITED")); }
    let mut random = [0u8; 16]; OsRng.fill_bytes(&mut random);
    let job_id = random.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let path = staging_file(gateway, &job_id)?;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let committed = if let Some(text) = manifest["text"].as_str() {
        file.write_all(text.as_bytes()).and_then(|_| file.sync_all())
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        text.len() as u64
    } else { 0 };
    drop(file);
    let inserted = connection.execute(
        "INSERT INTO companion_service_upload(job_id,instance_id,device_id,op_id,manifest,
            committed_bytes,stage,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'staging',?7)",
        params![job_id, instance, device.device_id, op_id, manifest.to_string(), committed,
            chrono::Utc::now().to_rfc3339()],
    );
    if inserted.is_err() {
        let _ = std::fs::remove_file(path);
        return Err((503, "SERVICE_UNAVAILABLE"));
    }
    Ok((201, job_value(&job_id, op_id, "staging", committed, None)))
}

pub(super) fn status(gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, job_id: &str) -> ServiceResult<Value> {
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    let (_manifest, offset, stage, receipt, op_id) = load_job(gateway, device, job_id)?;
    Ok(job_value(job_id, &op_id, &stage, offset, receipt))
}

pub(super) fn chunk(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, job_id: &str,
    request: &HttpRequest,
) -> ServiceResult<Value> {
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    let (manifest, committed, stage, _receipt, op_id) = load_job(gateway, device, job_id)?;
    if stage != "staging" { return Err((409, "OP_ID_REUSED")); }
    if manifest["text"].is_string() { return Err((400, "INPUT_INVALID")); }
    let bytes = &request.body;
    if bytes.is_empty() || bytes.len() > MAX_CHUNK { return Err((413, "PAYLOAD_TOO_LARGE")); }
    let offset = request.headers.get("x-chunk-offset")
        .ok_or((400, "INPUT_INVALID"))?.parse::<u64>().map_err(|_| (400, "INPUT_INVALID"))?;
    let declared_hash = request.headers.get("x-chunk-sha256").ok_or((400, "INPUT_INVALID"))?;
    if declared_hash.len() != 64 || !declared_hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err((400, "INPUT_INVALID"));
    }
    if declared_hash != &hex_digest(bytes) { return Err((409, "UPLOAD_HASH_MISMATCH")); }
    let total = manifest["sizeBytes"].as_u64().ok_or((503, "SERVICE_UNAVAILABLE"))?;
    if offset.checked_add(bytes.len() as u64).is_none_or(|end| end > total) {
        return Err((409, "UPLOAD_OFFSET_MISMATCH"));
    }
    let path = staging_file(gateway, job_id)?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() < committed {
        return Err((503, "SERVICE_UNAVAILABLE"));
    }
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(&path)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    file.set_len(committed).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if offset < committed {
        if offset + bytes.len() as u64 > committed { return Err((409, "UPLOAD_OFFSET_MISMATCH")); }
        let mut existing = vec![0u8; bytes.len()];
        file.seek(SeekFrom::Start(offset)).and_then(|_| file.read_exact(&mut existing))
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if existing != *bytes { return Err((409, "UPLOAD_OFFSET_MISMATCH")); }
        return Ok(job_value(job_id, &op_id, "staging", committed, None));
    }
    if offset != committed { return Err((409, "UPLOAD_OFFSET_MISMATCH")); }
    file.seek(SeekFrom::Start(committed)).and_then(|_| file.write_all(bytes))
        .and_then(|_| file.sync_all()).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    drop(file);
    authorized_target(gateway, device, &manifest)?;
    let next = committed + bytes.len() as u64;
    let connection = database(gateway)?;
    let changed = connection.execute(
        "UPDATE companion_service_upload SET committed_bytes=?1,updated_at=?2
         WHERE job_id=?3 AND device_id=?4 AND committed_bytes=?5 AND stage='staging'",
        params![next, chrono::Utc::now().to_rfc3339(), job_id, device.device_id, committed],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if changed != 1 { return Err((409, "UPLOAD_OFFSET_MISMATCH")); }
    Ok(job_value(job_id, &op_id, "staging", next, None))
}

fn finish_material(gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64,
    manifest: &Value, path: &std::path::Path) -> ServiceResult<Value> {
    let catalog = gateway.material_catalog();
    let page = manifest["source"].get("pageUrl").and_then(Value::as_str)
        .or_else(|| manifest["source"].get("siteOrigin").and_then(Value::as_str));
    let page_kind = if manifest["source"]["pageUrl"].is_string() {
        manifest["source"]["pageKind"].as_str().unwrap_or("capture-page")
    } else { "capture-page" };
    let source = page.map(|url| crate::materials::MaterialSourcePageInput::from_parts(
        url, page_kind, None,
    ).ok_or((400, "INPUT_INVALID"))).transpose()?;
    let input = crate::materials::MaterialStagedFileInput {
        path: path.to_path_buf(),
        name: manifest["name"].as_str().ok_or((400, "INPUT_INVALID"))?.to_owned(),
        original_source: page.unwrap_or("").to_owned(),
        mime_type: manifest["mimeType"].as_str().ok_or((400, "INPUT_INVALID"))?.to_owned(),
        description: None,
        expected_size_bytes: manifest["sizeBytes"].as_u64().ok_or((400, "INPUT_INVALID"))?,
        expected_sha256: manifest["sha256"].as_str().ok_or((400, "INPUT_INVALID"))?.to_owned(),
    };
    let options = crate::materials::MaterialImportOptions {
        folder_id: manifest["target"]["folderId"].as_str().map(str::to_owned),
        ..Default::default()
    };
    let imported = crate::materials::import_staged_download_with_source_checked(
        &catalog, input, &options, source.as_ref(), || {
            #[cfg(test)]
            if let Some(gate) = gateway.policy.services_before_material_commit_gate.as_ref() {
                gate.pause_if_armed();
            }
            let guard = service_transition(gateway, device, generation, admission_permission)
                .map_err(|_| crate::materials::MaterialError::new(
                    "service-admission-denied", "Gateway generation or grant retired"))?;
            authorized_target(gateway, device, manifest)
                .map_err(|_| crate::materials::MaterialError::new(
                    "service-admission-denied", "Device ingest permission retired"))?;
            Ok(guard)
        })
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let asset = imported.asset;
    let revision = catalog.revision_for_asset(&asset).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(json!({"domain": "materials", "assetId": asset.id, "revision": revision}))
}

fn recover_material(gateway: &CompanionGateway, manifest: &Value) -> ServiceResult<Value> {
    let catalog = gateway.material_catalog();
    let digest = manifest["sha256"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
    let asset = catalog.find_managed_asset_by_hash(digest)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.ok_or((410, "RECEIPT_EXPIRED"))?;
    let revision = catalog.revision_for_asset(&asset).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(json!({"domain": "materials", "assetId": asset.id, "revision": revision}))
}

fn map_note_error((status, code): (u16, &'static str)) -> (u16, &'static str) {
    match code {
        "DESKTOP_DRAFT_BUSY" => (503, "DESKTOP_DRAFT_BUSY"),
        "REVISION_CONFLICT" | "KNOWLEDGE_CHANGED" | "VAULT_CHANGED" => (409, "REVISION_CONFLICT"),
        "OP_ID_REUSED" => (409, "OP_ID_REUSED"),
        "NOTE_INPUT_INVALID" | "ATTACHMENT_INPUT_INVALID" => (400, "INPUT_INVALID"),
        _ if status == 404 => (404, "ENTITY_NOT_FOUND"),
        _ => (503, "SERVICE_UNAVAILABLE"),
    }
}

fn note_request(request: &HttpRequest, method: &str, path: String, body: Value) -> HttpRequest {
    HttpRequest { method: method.to_owned(), path, headers: request.headers.clone(),
        body: body.to_string().into_bytes() }
}

fn mutate_knowledge(gateway: &CompanionGateway, device: &PairedDevice,
    generation: u64, admission_permission: u64, manifest: &Value, request: &HttpRequest) -> ServiceResult<Value> {
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    authorized_target(gateway, device, manifest)?;
    content::mutate_notes_for_service(gateway, request).map_err(map_note_error)
}

fn finish_knowledge(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, manifest: &Value,
    job_id: &str, path: &std::path::Path, request: &HttpRequest,
) -> ServiceResult<Value> {
    let vault = manifest["target"]["vaultId"].as_str().ok_or((400, "INPUT_INVALID"))?;
    let kind = manifest["kind"].as_str().ok_or((400, "INPUT_INVALID"))?;
    let inline = matches!(kind, "text" | "url" | "clipboard");
    let content = if inline {
        manifest["text"].as_str().ok_or((400, "INPUT_INVALID"))?.to_owned()
    } else { String::new() };
    let created = mutate_knowledge(gateway, device, generation, admission_permission, manifest, &note_request(request, "POST",
        "/v1/notes".to_owned(), json!({
            "opId": format!("sv-{job_id}-create"), "vaultId": vault, "kind": "create",
            "title": manifest["name"], "content": content,
            "parentRelativePath": manifest["target"]["parentRelativePath"]
        })))?;
    let note_id = created["document"]["noteId"].as_str().filter(|id| valid_id(id))
        .ok_or((503, "SERVICE_UNAVAILABLE"))?;
    let mut revision = created["document"]["revision"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?.to_owned();
    if !inline {
        let upload_op = format!("sv-{job_id}-file");
        let upload_path = format!("/v1/notes/{note_id}/attachments/{upload_op}");
        let started = mutate_knowledge(gateway, device, generation, admission_permission, manifest, &note_request(request, "POST",
            upload_path.clone(), json!({"vaultId": vault, "expectedRevision": revision,
                "name": manifest["name"], "mime": manifest["mimeType"],
                "sizeBytes": manifest["sizeBytes"], "sha256": manifest["sha256"]})))?;
        let publication = if started["complete"] == true {
            started["publication"].clone()
        } else {
            let mut offset = started["offset"].as_u64().ok_or((503, "SERVICE_UNAVAILABLE"))?;
            let mut file = std::fs::File::open(path).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
            file.seek(SeekFrom::Start(offset)).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
            let mut buffer = vec![0u8; MAX_CHUNK];
            while offset < manifest["sizeBytes"].as_u64().unwrap_or(0) {
                let count = file.read(&mut buffer).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
                if count == 0 { return Err((409, "UPLOAD_INCOMPLETE")); }
                let chunk = mutate_knowledge(gateway, device, generation, admission_permission, manifest, &note_request(request, "PUT",
                    upload_path.clone(), json!({"vaultId": vault, "offset": offset,
                        "data": BASE64.encode(&buffer[..count]),
                        "sha256": hex_digest(&buffer[..count])})))?;
                offset = chunk["offset"].as_u64().ok_or((503, "SERVICE_UNAVAILABLE"))?;
            }
            let completed = mutate_knowledge(gateway, device, generation, admission_permission, manifest, &note_request(request, "POST",
                format!("{upload_path}/complete"), json!({"vaultId": vault})))?;
            completed["publication"].clone()
        };
        let markdown = publication["markdown"].as_str().filter(|s| !s.is_empty())
            .ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let updated = mutate_knowledge(gateway, device, generation, admission_permission, manifest, &note_request(request, "PATCH",
            format!("/v1/notes/{note_id}"), json!({
                "opId": format!("sv-{job_id}-embed"), "vaultId": vault, "kind": "update",
                "expectedRevision": revision, "content": markdown
            })))?;
        revision = updated["document"]["revision"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?.to_owned();
    }
    Ok(json!({"domain": "knowledge", "vaultId": vault, "noteId": note_id, "revision": revision}))
}

pub(super) fn complete(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, job_id: &str, request: &HttpRequest,
) -> ServiceResult<Value> {
    if live_generation(gateway, device, generation)? != admission_permission {
        return Err((403, "SCOPE_DENIED"));
    }
    let (manifest, committed, stage, receipt, op_id) = load_job(gateway, device, job_id)?;
    if stage == "completed" { return Ok(job_value(job_id, &op_id, &stage, committed, receipt)); }
    if !matches!(stage.as_str(), "staging" | "committing") { return Err((410, "RECEIPT_EXPIRED")); }
    let total = manifest["sizeBytes"].as_u64().ok_or((503, "SERVICE_UNAVAILABLE"))?;
    if committed != total { return Err((409, "UPLOAD_INCOMPLETE")); }
    let path = staging_file(gateway, job_id)?;
    if stage == "committing" && manifest["target"]["domain"] == "materials" && !path.exists() {
        let _transition = service_transition(gateway, device, generation, admission_permission)?;
        authorized_target(gateway, device, &manifest)?;
        let receipt = recover_material(gateway, &manifest)?;
        database(gateway)?.execute(
            "UPDATE companion_service_upload SET stage='completed',receipt=?1,updated_at=?2
             WHERE job_id=?3 AND device_id=?4 AND stage='committing'",
            params![receipt.to_string(), chrono::Utc::now().to_rfc3339(), job_id, device.device_id],
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        return Ok(job_value(job_id, &op_id, "completed", committed, Some(receipt)));
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() < committed {
        return Err((503, "SERVICE_UNAVAILABLE"));
    }
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(&path)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    file.set_len(committed).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    file.seek(SeekFrom::Start(0)).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    if format!("{:x}", hasher.finalize()) != manifest["sha256"].as_str().unwrap_or("") {
        return Err((409, "UPLOAD_HASH_MISMATCH"));
    }
    drop(file);
    authorized_target(gateway, device, &manifest)?;
    if stage == "staging" {
        let _transition = service_transition(gateway, device, generation, admission_permission)?;
        authorized_target(gateway, device, &manifest)?;
        database(gateway)?.execute(
            "UPDATE companion_service_upload SET stage='committing',updated_at=?1
             WHERE job_id=?2 AND device_id=?3 AND stage='staging'",
            params![chrono::Utc::now().to_rfc3339(), job_id, device.device_id],
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    }
    let receipt = match manifest["target"]["domain"].as_str() {
        Some("materials") => finish_material(gateway, device, generation, admission_permission, &manifest, &path)?,
        Some("knowledge") => finish_knowledge(gateway, device, generation, admission_permission, &manifest, job_id, &path, request)?,
        _ => return Err((400, "INPUT_INVALID")),
    };
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    let connection = database(gateway)?;
    connection.execute(
        "UPDATE companion_service_upload SET stage='completed',receipt=?1,updated_at=?2
         WHERE job_id=?3 AND device_id=?4 AND stage='committing'",
        params![receipt.to_string(), chrono::Utc::now().to_rfc3339(), job_id, device.device_id],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let _ = std::fs::remove_file(&path);
    Ok(job_value(job_id, &op_id, "completed", committed, Some(receipt)))
}

pub(super) fn cancel(gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, job_id: &str) -> ServiceResult<Value> {
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    let (_manifest, _committed, stage, _receipt, op_id) = load_job(gateway, device, job_id)?;
    if stage == "completed" { return Err((409, "OP_ID_REUSED")); }
    if stage == "cancelled" { return Ok(job_value(job_id, &op_id, &stage, 0, None)); }
    if stage != "staging" { return Err((503, "SERVICE_UNAVAILABLE")); }
    database(gateway)?.execute(
        "UPDATE companion_service_upload SET stage='cancelled',committed_bytes=0,updated_at=?1 WHERE job_id=?2 AND device_id=?3 AND stage='staging'",
        params![chrono::Utc::now().to_rfc3339(), job_id, device.device_id],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let _ = std::fs::remove_file(staging_file(gateway, job_id)?);
    Ok(job_value(job_id, &op_id, "cancelled", 0, None))
}
