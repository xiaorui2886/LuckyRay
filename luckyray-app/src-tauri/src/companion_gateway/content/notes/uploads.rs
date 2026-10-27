use super::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    vault_id: String,
    expected_revision: String,
    name: String,
    mime: String,
    size_bytes: u64,
    sha256: String,
}

pub(super) fn route(gateway: &CompanionGateway, request: &HttpRequest) -> ContentResult<Value> {
    let path = request.path.split('?').next().unwrap_or("");
    let (note, rest) = path
        .strip_prefix("/v1/notes/")
        .and_then(|s| s.split_once("/attachments/"))
        .ok_or((404, "NOT_FOUND"))?;
    let (op, complete) = rest
        .strip_suffix("/complete")
        .map(|s| (s, true))
        .unwrap_or((rest, false));
    if !valid_id(note) || !valid_id(op) {
        return Err((400, "OP_ID_INVALID"));
    }
    let device = presented_device_id(request).ok_or((401, "PAIRING_REQUIRED"))?;
    let (target, vault) = target(gateway)?;
    let q = query(
        &request.path,
        if request.method == "GET" {
            &["vault"]
        } else {
            &[]
        },
    )?;
    let input: Value = if request.method == "GET" {
        json!({"vaultId":q.get("vault")})
    } else {
        serde_json::from_slice(&request.body).map_err(|_| (400, "ATTACHMENT_INPUT_INVALID"))?
    };
    if input["vaultId"] != vault {
        return Err((409, "VAULT_CHANGED"));
    }
    let _state = gateway
        .content_state
        .lock()
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    let db = database(gateway)?;
    let stored:Option<(String,String,String,u64,Option<String>)>=db.query_row("SELECT vault_key,note_id,manifest,committed_bytes,receipt FROM companion_content_upload WHERE device_id=?1 AND op_id=?2",params![device,op],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(db_error)?;
    let (manifest, offset, receipt) = if let Some((
        stored_vault,
        stored_note,
        manifest,
        offset,
        receipt,
    )) = stored
    {
        if stored_vault != vault || stored_note != note {
            return Err((409, "OP_ID_REUSED"));
        }
        let manifest: Manifest =
            serde_json::from_str(&manifest).map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"))?;
        if request.method == "POST" && !complete {
            let proposed: Manifest = serde_json::from_value(input.clone())
                .map_err(|_| (400, "ATTACHMENT_INPUT_INVALID"))?;
            if serde_json::to_string(&proposed).unwrap()
                != serde_json::to_string(&manifest).unwrap()
            {
                return Err((409, "OP_ID_REUSED"));
            }
        }
        (manifest, offset, receipt)
    } else {
        if request.method != "POST" || complete {
            return Err((404, "UPLOAD_NOT_FOUND"));
        }
        let manifest: Manifest =
            serde_json::from_value(input.clone()).map_err(|_| (400, "ATTACHMENT_INPUT_INVALID"))?;
        if manifest.size_bytes == 0
            || manifest.size_bytes > 64 * 1024 * 1024
            || manifest.name.len() > 512
            || manifest.sha256.len() != 64
            || !manifest.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err((400, "ATTACHMENT_INPUT_INVALID"));
        }
        let doc = current_document(gateway, &target, &vault, note)?;
        if revision(&doc.summary.relative_path, &doc.revision) != manifest.expected_revision {
            return Err((409, "REVISION_CONFLICT"));
        }
        let count:u64=db.query_row("SELECT COUNT(*) FROM companion_content_upload WHERE device_id=?1 AND receipt IS NULL",[device],|r|r.get(0)).map_err(db_error)?;
        if count >= 16 {
            return Err((429, "UPLOAD_LIMIT"));
        }
        db.execute("INSERT INTO companion_content_upload(device_id,op_id,vault_key,note_id,manifest) VALUES(?1,?2,?3,?4,?5)",params![device,op,vault,note,serde_json::to_string(&manifest).unwrap()]).map_err(db_error)?;
        (manifest, 0, None)
    };
    if let Some(receipt) = receipt {
        return serde_json::from_str(&receipt).map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"));
    }
    let root = gateway
        .backend
        .app_data_dir()
        .join("companion-upload-staging");
    fs::create_dir_all(&root).map_err(|_| (503, "UPLOAD_STORAGE_UNAVAILABLE"))?;
    let key = format!("{:x}", Sha256::digest(format!("{device}:{op}")));
    let staged = root.join(format!("{key}.part"));
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&staged)
        .map_err(|_| (503, "UPLOAD_STORAGE_UNAVAILABLE"))?;
    if file
        .metadata()
        .map_err(|_| (503, "UPLOAD_STORAGE_UNAVAILABLE"))?
        .len()
        < offset
    {
        return Err((409, "UPLOAD_STAGING_LOST"));
    }
    // Discard an uncommitted partial chunk after a crash; the client retries it.
    file.set_len(offset)
        .map_err(|_| (503, "UPLOAD_STORAGE_UNAVAILABLE"))?;
    if request.method == "PUT" && !complete {
        if input.as_object().is_none_or(|o| {
            o.keys()
                .any(|key| !matches!(key.as_str(), "vaultId" | "offset" | "data" | "sha256"))
        }) {
            return Err((400, "ATTACHMENT_INPUT_INVALID"));
        }
        let start = input["offset"]
            .as_u64()
            .ok_or((400, "ATTACHMENT_INPUT_INVALID"))?;
        let encoded = input["data"]
            .as_str()
            .filter(|s| s.len() <= 350_000)
            .ok_or((400, "CHUNK_TOO_LARGE"))?;
        let bytes = BASE64
            .decode(encoded)
            .map_err(|_| (400, "ATTACHMENT_INPUT_INVALID"))?;
        if bytes.is_empty()
            || bytes.len() > 256 * 1024
            || start.saturating_add(bytes.len() as u64) > manifest.size_bytes
        {
            return Err((400, "CHUNK_TOO_LARGE"));
        }
        if input["sha256"] != format!("{:x}", Sha256::digest(&bytes)) {
            return Err((400, "CHUNK_CHECKSUM_MISMATCH"));
        }
        if start < offset {
            if start + bytes.len() as u64 > offset {
                return Err((409, "UPLOAD_OFFSET_MISMATCH"));
            }
            file.seek(SeekFrom::Start(start))
                .map_err(|_| (503, "UPLOAD_STORAGE_UNAVAILABLE"))?;
            let mut existing = vec![0; bytes.len()];
            file.read_exact(&mut existing)
                .map_err(|_| (503, "UPLOAD_STORAGE_UNAVAILABLE"))?;
            if existing != bytes {
                return Err((409, "OP_ID_REUSED"));
            }
            return Ok(json!({"opId":op,"offset":offset,"complete":false}));
        }
        if start != offset {
            return Err((409, "UPLOAD_OFFSET_MISMATCH"));
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| (503, "UPLOAD_STORAGE_UNAVAILABLE"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| (503, "UPLOAD_STORAGE_UNAVAILABLE"))?;
        let next = offset + bytes.len() as u64;
        db.execute("UPDATE companion_content_upload SET committed_bytes=?3 WHERE device_id=?1 AND op_id=?2",params![device,op,next]).map_err(db_error)?;
        return Ok(json!({"opId":op,"offset":next,"complete":false}));
    }
    if complete && request.method == "POST" {
        if offset != manifest.size_bytes {
            return Err((409, "UPLOAD_INCOMPLETE"));
        }
        drop(file);
        let doc = current_document(gateway, &target, &vault, note)?;
        if revision(&doc.summary.relative_path, &doc.revision) != manifest.expected_revision {
            return Err((409, "REVISION_CONFLICT"));
        }
        let publication = gateway.knowledge()
            .publish_companion_attachment(
                &target,
                &doc.summary.document_ref,
                &doc.revision,
                &manifest.name,
                &staged,
                manifest.size_bytes,
                &manifest.sha256,
            )
            .map_err(knowledge_error)?;
        let receipt = json!({"opId":op,"offset":offset,"complete":true,"publication":publication});
        db.execute(
            "UPDATE companion_content_upload SET receipt=?3 WHERE device_id=?1 AND op_id=?2",
            params![device, op, receipt.to_string()],
        )
        .map_err(db_error)?;
        let _ = fs::remove_file(&staged);
        gateway.knowledge().notify_companion_committed(&doc.summary.document_ref.vault_id, vec![doc.summary.relative_path.clone()]);
        return Ok(receipt);
    }
    if complete || !matches!(request.method.as_str(), "GET" | "POST") {
        return Err((405, "METHOD_NOT_ALLOWED"));
    }
    Ok(json!({"opId":op,"offset":offset,"complete":false,"maxChunkBytes":256*1024}))
}
