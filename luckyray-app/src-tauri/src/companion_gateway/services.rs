//! Services V1 adapter. Deliberately separate from strict Content V1 routes.
use super::*;
mod search;
mod ingest;
mod knowledge;
mod events;
mod presentation;
pub(crate) use events::{event_authorized, event_stream};

type ServiceResult<T> = Result<T, (u16, &'static str)>;

pub(super) fn is_service_route(path: &str) -> bool {
    let route = path.split('?').next().unwrap_or("");
    route == "/v1/services" || route.starts_with("/v1/services/")
}

fn database(gateway: &CompanionGateway) -> ServiceResult<Connection> {
    open_connection(gateway.backend.db_path()).map_err(|_| (503, "SERVICE_UNAVAILABLE"))
}

fn permission_revision(gateway: &CompanionGateway, device_id: &str) -> ServiceResult<u64> {
    database(gateway)?
        .query_row(
            "SELECT services_permission_revision FROM companion_device WHERE device_id=?1 AND revoked_at IS NULL",
            [device_id],
            |row| row.get(0),
        )
        .map_err(|_| (401, "AUTH_REVOKED"))
}

fn cursor_tag(gateway: &CompanionGateway, device_id: &str,
    domain: &str, scope: &str, permission: u64) -> ServiceResult<String> {
    let identity = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let tag = format!("{:x}", Sha256::digest(format!("{}|{}|{}|{}|{}",
        identity.instance_id, device_id, domain, scope, permission)));
    Ok(tag[..16].to_owned())
}

fn granted(
    gateway: &CompanionGateway,
    device_id: &str,
    grant_class: &str,
    scope_kind: &str,
    scope_id: &str,
) -> ServiceResult<bool> {
    let count: u32 = database(gateway)?
        .query_row(
            "SELECT COUNT(*) FROM companion_service_grant AS g
             JOIN companion_device AS d ON d.device_id=g.device_id AND d.revoked_at IS NULL
             WHERE g.device_id=?1 AND g.grant_class=?2 AND g.scope_kind=?3 AND g.scope_id=?4",
            params![device_id, grant_class, scope_kind, scope_id],
            |row| row.get(0),
        )
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(count > 0)
}

fn live_generation(gateway: &CompanionGateway, device: &PairedDevice, generation: u64) -> ServiceResult<u64> {
    let lifecycle = gateway.lifecycle.lock().expect("companion lifecycle mutex");
    if lifecycle.stopping_generation.is_some() || lifecycle.running.as_ref().is_none_or(|running|
        running.generation != generation || running.stop.load(Ordering::SeqCst)) {
        return Err((503, "SERVICE_UNAVAILABLE"));
    }
    drop(lifecycle);
    permission_revision(gateway, &device.device_id)
}

fn service_transition<'a>(gateway: &'a CompanionGateway, device: &PairedDevice,
    generation: u64, admission_permission: u64) -> ServiceResult<std::sync::MutexGuard<'a, ()>> {
    let guard = gateway.try_transition().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if live_generation(gateway, device, generation)? != admission_permission {
        return Err((403, "SCOPE_DENIED"));
    }
    Ok(guard)
}

fn current_vault(gateway: &CompanionGateway) -> ServiceResult<Option<(String, String)>> {
    let (vault_id, label) = match content::current_vault_for_service(gateway) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok(Some((vault_id, label)))
}

fn operation_implemented(id: &str, legacy: bool) -> bool {
    legacy || matches!(id, "services.discover" | "materials.detailV1" | "materials.metadataPatch" | "materials.removeRecord" | "materials.changes" | "materials.import" | "knowledge.vaults" | "knowledge.registeredList" | "knowledge.registeredChanges" | "knowledge.move" | "knowledge.createUnique" | "knowledge.editing" | "knowledge.editingOpen" | "knowledge.editingSet" | "knowledge.directories" | "knowledge.relations" | "knowledge.materialReferences" | "ingest.begin" | "ingest.status" | "ingest.chunk" | "ingest.complete" | "ingest.cancel" | "search.unified" | "changes.hints" | "presentation.open")
}

// Claim only the additive shapes, before the generic registered-vault GET.
// The domain adapter validates identifiers/query/methods and current authority.
fn live_knowledge_route(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    if path == "/v1/services/knowledge/notes" { return true; }
    let shape = |prefix: &str, actions: &[&str]| {
        path.strip_prefix(prefix).and_then(|suffix| suffix.split_once('/'))
            .is_some_and(|(id, action)| !id.is_empty() && !id.contains('/') && actions.contains(&action))
    };
    shape("/v1/services/knowledge/notes/", &["editing", "relations"])
        || shape("/v1/services/knowledge/vaults/", &["directories"])
        || shape("/v1/services/knowledge/materials/", &["references"])
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn sharable_page_url(raw: &str) -> bool {
    // The #169 catalog validator is the source authority: it keeps ordinary
    // SPA fragments and rejects credential-bearing query/fragment fields.
    crate::materials::MaterialSourcePageInput::from_parts(raw, "capture-page", None).is_some()
}

fn material_detail(gateway: &CompanionGateway, device: &PairedDevice, asset_id: &str) -> ServiceResult<Value> {
    if !valid_id(asset_id) { return Err((400, "INPUT_INVALID")); }
    if !granted(gateway, &device.device_id, "content.read", "catalog", "")? {
        return Err((403, "GRANT_REQUIRED"));
    }
    let catalog = gateway.backend.material_catalog();
    let asset = catalog.get_assets(&[asset_id.to_owned()])
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        .into_iter().next().ok_or((404, "ENTITY_NOT_FOUND"))?;
    let revision = catalog.revision_for_asset(&asset).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let source = catalog.get_source_page(asset_id).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        .filter(|page| sharable_page_url(&page.page_url))
        .map(|page| {
            let origin = reqwest::Url::parse(&page.page_url)
                .map(|url| url.origin().ascii_serialization())
                .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
            Ok(json!({"captureKind": "web", "pageKind": page.page_kind,
                "pageUrl": page.page_url, "siteOrigin": origin}))
        }).transpose()?;
    if !granted(gateway, &device.device_id, "content.read", "catalog", "")? {
        return Err((403, "SCOPE_DENIED"));
    }
    let mut detail = json!({"assetId": asset.id, "name": asset.name,
        "kind": asset.kind, "mimeType": asset.mime_type,
        "sizeBytes": asset.size_bytes.unwrap_or(0).max(0),
        "revision": revision, "description": asset.description});
    if let Some(source) = source { detail["source"] = source; }
    Ok(detail)
}

fn strict_query(path: &str, allowed: &[&str]) -> ServiceResult<HashMap<String, String>> {
    let url = reqwest::Url::parse(&format!("https://fixture.invalid{path}"))
        .map_err(|_| (400, "INPUT_INVALID"))?;
    let mut values = HashMap::new();
    for (key, value) in url.query_pairs() {
        if !allowed.contains(&key.as_ref()) || values.insert(key.to_string(), value.to_string()).is_some() {
            return Err((400, "INPUT_INVALID"));
        }
    }
    Ok(values)
}

fn vaults(gateway: &CompanionGateway, device: &PairedDevice) -> ServiceResult<Value> {
    let Some((vault_id, label)) = current_vault(gateway)? else { return Err((503, "SERVICE_UNAVAILABLE")); };
    if !granted(gateway, &device.device_id, "content.read", "vault", &vault_id)? {
        return Err((403, "GRANT_REQUIRED"));
    }
    let write_granted = granted(gateway, &device.device_id, "content.write", "vault", &vault_id)?;
    if !granted(gateway, &device.device_id, "content.read", "vault", &vault_id)? {
        return Err((403, "SCOPE_DENIED"));
    }
    let revision = format!("{:x}", Sha256::digest(vault_id.as_bytes()));
    Ok(json!({"items": [{"vaultId": vault_id, "displayName": label,
        "activeInDesktop": true, "readGranted": true, "writeGranted": write_granted,
        "revision": revision}]}))
}

fn registered_notes(
    gateway: &CompanionGateway, device: &PairedDevice, vault_id: &str,
    query: &HashMap<String, String>, request: &HttpRequest,
) -> ServiceResult<Value> {
    if !valid_id(vault_id) { return Err((404, "ENTITY_NOT_FOUND")); }
    if !granted(gateway, &device.device_id, "content.read", "vault", vault_id)? {
        return Err((403, "GRANT_REQUIRED"));
    }
    let Some((current, _)) = current_vault(gateway)? else { return Err((503, "SERVICE_UNAVAILABLE")); };
    if vault_id != current { return Err((503, "SERVICE_UNAVAILABLE")); }
    let limit = query.get("limit").map(|value| value.parse::<u32>())
        .transpose().map_err(|_| (400, "INPUT_INVALID"))?.unwrap_or(50);
    if !(1..=100).contains(&limit) { return Err((400, "INPUT_INVALID")); }
    let after = query.get("afterId").map(String::as_str).unwrap_or("");
    if !after.is_empty() && !valid_id(after) { return Err((400, "INPUT_INVALID")); }
    let search = query.get("q").map(String::as_str).unwrap_or("");
    if search.len() > 200 || search.chars().any(char::is_control) { return Err((400, "INPUT_INVALID")); }
    let mut legacy_url = reqwest::Url::parse("https://fixture.invalid/v1/notes").map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    legacy_url.query_pairs_mut().append_pair("vault", vault_id).append_pair("limit", &limit.to_string());
    if !after.is_empty() { legacy_url.query_pairs_mut().append_pair("afterId", after); }
    if !search.is_empty() { legacy_url.query_pairs_mut().append_pair("q", search); }
    let legacy_request = HttpRequest { method: "GET".to_owned(),
        path: format!("/v1/notes?{}", legacy_url.query().unwrap_or("")),
        headers: request.headers.clone(), body: Vec::new() };
    let legacy = content::read_notes_for_service(gateway, &legacy_request)
        .map_err(|(status, _)| (status, if status == 410 { "CURSOR_TOO_OLD" } else { "SERVICE_UNAVAILABLE" }))?;
    let items = legacy["items"].as_array().ok_or((503, "SERVICE_UNAVAILABLE"))?
        .iter().map(|item| {
            let relative = item["relativePath"].as_str().unwrap_or("");
            json!({"vaultId": vault_id, "noteId": item["noteId"],
                "title": item["title"], "revision": item["revision"],
                "parentRelativePath": relative.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("")})
        }).collect::<Vec<_>>();
    let has_more = legacy["hasMore"].as_bool().unwrap_or(false);
    let next = if has_more { legacy["nextId"].clone() } else { Value::Null };
    if !granted(gateway, &device.device_id, "content.read", "vault", vault_id)? {
        return Err((403, "SCOPE_DENIED"));
    }
    Ok(json!({"items": items, "hasMore": has_more, "nextAfterId": next}))
}

fn registered_changes(
    gateway: &CompanionGateway, device: &PairedDevice, vault_id: &str,
    query: &HashMap<String, String>, request: &HttpRequest,
) -> ServiceResult<Value> {
    if !valid_id(vault_id) { return Err((404, "ENTITY_NOT_FOUND")); }
    if !granted(gateway, &device.device_id, "content.read", "vault", vault_id)? {
        return Err((403, "GRANT_REQUIRED"));
    }
    if current_vault(gateway)?.as_ref().map(|(id, _)| id.as_str()) != Some(vault_id) {
        return Err((503, "SERVICE_UNAVAILABLE"));
    }
    let revision = permission_revision(gateway, &device.device_id)?;
    let tag = cursor_tag(gateway, &device.device_id, "knowledge", vault_id, revision)?;
    let after = query.get("after").map(String::as_str).unwrap_or("k:0");
    let offset = if after == "k:0" { 0 } else {
        let rest = after.strip_prefix("k:").ok_or((400, "INPUT_INVALID"))?;
        let (presented, position) = rest.split_once(':').ok_or((400, "INPUT_INVALID"))?;
        if presented != tag { return Err((410, "CURSOR_TOO_OLD")); }
        position.parse::<u64>().map_err(|_| (400, "INPUT_INVALID"))?
    };
    let limit = query.get("limit").map(|value| value.parse::<u32>())
        .transpose().map_err(|_| (400, "INPUT_INVALID"))?.unwrap_or(50);
    if !(1..=100).contains(&limit) { return Err((400, "INPUT_INVALID")); }
    let mut legacy_url = reqwest::Url::parse("https://fixture.invalid/v1/sync/changes")
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    legacy_url.query_pairs_mut().append_pair("vault", vault_id)
        .append_pair("after", &offset.to_string()).append_pair("limit", &limit.to_string());
    let legacy_request = HttpRequest { method: "GET".to_owned(),
        path: format!("/v1/sync/changes?{}", legacy_url.query().unwrap_or("")),
        headers: request.headers.clone(), body: Vec::new() };
    let legacy = content::read_notes_for_service(gateway, &legacy_request)
        .map_err(|(status, _)| (status, if status == 410 { "CURSOR_TOO_OLD" } else { "SERVICE_UNAVAILABLE" }))?;
    let high: u64 = database(gateway)?.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM companion_content_change WHERE vault_key=?1",
        [vault_id], |row| row.get(0)
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let items = legacy["changes"].as_array().ok_or((503, "SERVICE_UNAVAILABLE"))?
        .iter().map(|item| {
            let seq = item["seq"].as_u64().unwrap_or(0);
            json!({"cursor": format!("k:{tag}:{seq}"), "vaultId": vault_id,
                "noteId": item["noteId"], "revision": item["revision"], "deleted": item["deleted"]})
        }).collect::<Vec<_>>();
    if !granted(gateway, &device.device_id, "content.read", "vault", vault_id)?
        || permission_revision(gateway, &device.device_id)? != revision {
        return Err((403, "SCOPE_DENIED"));
    }
    let next = legacy["cursor"].as_u64().unwrap_or(offset);
    Ok(json!({"items": items, "snapshotCursor": format!("k:{tag}:{high}"),
        "nextCursor": format!("k:{tag}:{next}"), "hasMore": legacy["hasMore"]}))
}

fn material_changes(
    gateway: &CompanionGateway, device: &PairedDevice,
    query: &HashMap<String, String>,
) -> ServiceResult<Value> {
    if !granted(gateway, &device.device_id, "content.read", "catalog", "")? {
        return Err((403, "GRANT_REQUIRED"));
    }
    let revision = permission_revision(gateway, &device.device_id)?;
    let tag = cursor_tag(gateway, &device.device_id, "materials", "catalog", revision)?;
    let after = query.get("after").map(String::as_str).unwrap_or("m:0");
    let offset = if after == "m:0" { 0 } else {
        let rest = after.strip_prefix("m:").ok_or((400, "INPUT_INVALID"))?;
        let (presented, position) = rest.split_once(':').ok_or((400, "INPUT_INVALID"))?;
        if presented != tag { return Err((410, "CURSOR_TOO_OLD")); }
        position.parse::<u64>().map_err(|_| (400, "INPUT_INVALID"))?
    };
    let limit = query.get("limit").map(|value| value.parse::<u32>())
        .transpose().map_err(|_| (400, "INPUT_INVALID"))?.unwrap_or(50);
    if !(1..=100).contains(&limit) { return Err((400, "INPUT_INVALID")); }
    let connection = database(gateway)?;
    let high: u64 = connection.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM companion_service_change WHERE domain='materials' AND scope_id=''",
        [], |row| row.get(0),
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if offset > high { return Err((410, "CURSOR_TOO_OLD")); }
    let mut statement = connection.prepare(
        "SELECT seq,object_id,revision,kind,tombstone FROM companion_service_change
         WHERE domain='materials' AND scope_id='' AND seq>?1 AND seq<=?2 AND object_id IN(SELECT h.asset_id FROM material_library_asset_history h JOIN material_library_state s ON h.library_id=s.legacy_id) ORDER BY seq LIMIT ?3"
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let rows = statement.query_map(params![offset, high, limit], |row| {
        Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?,
            row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?))
    }).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        .collect::<Result<Vec<_>, _>>().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let next = if rows.len()<limit as usize {high} else {rows.last().map(|row|row.0).unwrap_or(high)};
    let catalog = gateway.backend.material_catalog();
    let mut items = Vec::with_capacity(rows.len());
    for (seq, asset_id, stored_revision, kind, tombstone) in rows {
        // Local catalog triggers cannot calculate the catalog's composite
        // revision in SQL (it includes tags and managed-file identity). For
        // live objects project the same revision authority as detail/PATCH;
        // a deletion retains the pre-delete revision in its durable tombstone.
        let revision = if tombstone != 0 {
            stored_revision
        } else if let Some(asset) = catalog.get_assets(&[asset_id.clone()])
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.into_iter().next() {
            catalog.revision_for_asset(&asset).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        } else {
            stored_revision
        };
        items.push(json!({"cursor": format!("m:{tag}:{seq}"), "assetId": asset_id,
            "revision": revision, "kind": kind, "tombstone": tombstone != 0}));
    }
    if permission_revision(gateway, &device.device_id)? != revision
        || !granted(gateway, &device.device_id, "content.read", "catalog", "")? {
        return Err((403, "SCOPE_DENIED"));
    }
    Ok(json!({"items": items, "snapshotCursor": format!("m:{tag}:{high}"),
        "nextCursor": format!("m:{tag}:{next}"), "hasMore": next < high}))
}

fn canonical_body(body: &[u8]) -> ServiceResult<(Value, String)> {
    let value: Value = serde_json::from_slice(body).map_err(|_| (400, "INPUT_INVALID"))?;
    if !value.is_object() { return Err((400, "INPUT_INVALID")); }
    let canonical = serde_json::to_vec(&value).map_err(|_| (400, "INPUT_INVALID"))?;
    Ok((value, format!("{:x}", Sha256::digest(canonical))))
}

fn replay_operation(
    connection: &Connection, instance_id: &str, device_id: &str,
    operation_id: &str, op_id: &str, target_key: &str, payload_hash: &str,
) -> ServiceResult<Option<Value>> {
    let stored = connection.query_row(
        "SELECT target_key,payload_sha256,stage,receipt FROM companion_service_operation
         WHERE instance_id=?1 AND device_id=?2 AND operation_id=?3 AND op_id=?4",
        params![instance_id, device_id, operation_id, op_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
            row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
    ).optional().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let Some((stored_target, stored_hash, stage, receipt)) = stored else { return Ok(None); };
    if stored_target != target_key || stored_hash != payload_hash { return Err((409, "OP_ID_REUSED")); }
    if stage != "committed" { return Err((410, "RECEIPT_EXPIRED")); }
    let receipt = receipt.ok_or((410, "RECEIPT_EXPIRED"))?;
    let value = serde_json::from_str(&receipt).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(Some(value))
}

fn record_operation(
    connection: &Connection, instance_id: &str, device_id: &str,
    operation_id: &str, op_id: &str, target_key: &str, payload_hash: &str,
    receipt: &Value,
) -> ServiceResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    connection.execute(
        "INSERT INTO companion_service_operation(instance_id,device_id,operation_id,op_id,
            target_key,payload_sha256,stage,receipt,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,'committed',?7,?8,?8)",
        params![instance_id, device_id, operation_id, op_id, target_key, payload_hash,
            receipt.to_string(), now],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(())
}

fn material_patch(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, asset_id: &str, body: &[u8],
) -> ServiceResult<Value> {
    if !valid_id(asset_id) || body.len() > 8192 { return Err((400, "INPUT_INVALID")); }
    if !granted(gateway, &device.device_id, "content.write", "catalog", "")? {
        return Err((403, "GRANT_REQUIRED"));
    }
    let permission_at_start = admission_permission;
    let (payload, hash) = canonical_body(body)?;
    let object = payload.as_object().ok_or((400, "INPUT_INVALID"))?;
    if object.keys().any(|key| !matches!(key.as_str(), "opId" | "expectedRevision" | "name" | "description"))
        || (!object.contains_key("name") && !object.contains_key("description")) {
        return Err((400, "INPUT_INVALID"));
    }
    let op_id = payload["opId"].as_str().filter(|id| valid_id(id)).ok_or((400, "INPUT_INVALID"))?;
    let expected = payload["expectedRevision"].as_str().filter(|v| !v.is_empty() && v.len() <= 160)
        .ok_or((400, "INPUT_INVALID"))?;
    let name = match object.get("name") {
        Some(Value::String(value)) if !value.trim().is_empty() && value.len() <= 255 => Some(value.trim()),
        Some(_) => return Err((400, "INPUT_INVALID")),
        None => None,
    };
    let description = match object.get("description") {
        Some(Value::String(value)) if value.len() <= 4096 => Some(Some(value.as_str())),
        Some(Value::Null) => Some(None),
        Some(_) => return Err((400, "INPUT_INVALID")),
        None => None,
    };
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    let instance_id = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let mut connection = database(gateway)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if let Some(receipt) = replay_operation(&transaction, &instance_id, &device.device_id,
        "materials.metadataPatch", op_id, asset_id, &hash)? { return Ok(receipt); }
    let current = crate::materials::asset_revision_by_id_in(&transaction, asset_id)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.ok_or((404, "ENTITY_NOT_FOUND"))?;
    if current != expected { return Err((409, "REVISION_CONFLICT")); }
    if permission_revision(gateway, &device.device_id)? != permission_at_start
        || !granted(gateway, &device.device_id, "content.write", "catalog", "")? {
        return Err((403, "SCOPE_DENIED"));
    }
    let now = chrono::Utc::now().to_rfc3339();
    transaction.execute(
        "UPDATE asset SET name=COALESCE(?1,name),description=CASE WHEN ?2 THEN ?3 ELSE description END,
            updated_at=?4 WHERE id=?5",
        params![name, description.is_some(), description.flatten(), now, asset_id],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let revision = crate::materials::asset_revision_by_id_in(&transaction, asset_id)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.ok_or((503, "SERVICE_UNAVAILABLE"))?;
    let receipt = json!({"opId": op_id, "assetId": asset_id, "revision": revision, "disposition": "updated"});
    record_operation(&transaction, &instance_id, &device.device_id,
        "materials.metadataPatch", op_id, asset_id, &hash, &receipt)?;
    transaction.commit().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(receipt)
}

fn material_remove(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, asset_id: &str, body: &[u8],
) -> ServiceResult<Value> {
    if !valid_id(asset_id) || body.len() > 4096 { return Err((400, "INPUT_INVALID")); }
    if !granted(gateway, &device.device_id, "content.write", "catalog", "")? {
        return Err((403, "GRANT_REQUIRED"));
    }
    let permission_at_start = admission_permission;
    let (payload, hash) = canonical_body(body)?;
    let object = payload.as_object().ok_or((400, "INPUT_INVALID"))?;
    if object.len() != 3 || !object.contains_key("opId")
        || !object.contains_key("expectedRevision") || payload["mode"] != "removeRecord" {
        return Err((400, "INPUT_INVALID"));
    }
    let op_id = payload["opId"].as_str().filter(|id| valid_id(id)).ok_or((400, "INPUT_INVALID"))?;
    let expected = payload["expectedRevision"].as_str().filter(|v| !v.is_empty() && v.len() <= 160)
        .ok_or((400, "INPUT_INVALID"))?;
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    let instance_id = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let mut connection = database(gateway)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if let Some(receipt) = replay_operation(&transaction, &instance_id, &device.device_id,
        "materials.removeRecord", op_id, asset_id, &hash)? { return Ok(receipt); }
    let current = crate::materials::asset_revision_by_id_in(&transaction, asset_id)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.ok_or((404, "ENTITY_NOT_FOUND"))?;
    if current != expected { return Err((409, "REVISION_CONFLICT")); }
    let referenced: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM material_note_ref WHERE asset_id=?1)",
        [asset_id], |row| row.get(0),
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if referenced { return Err((409, "REVISION_CONFLICT")); }
    if permission_revision(gateway, &device.device_id)? != permission_at_start
        || !granted(gateway, &device.device_id, "content.write", "catalog", "")? {
        return Err((403, "SCOPE_DENIED"));
    }
    transaction.execute("DELETE FROM item_tag WHERE item_type='asset' AND item_id=?1", [asset_id])
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    transaction.execute("DELETE FROM asset WHERE id=?1", [asset_id])
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    crate::materials::publish_change_metadata(&transaction, "companion-remove-record",
        vec![asset_id.to_owned()], false).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    transaction.execute(
        "UPDATE companion_service_change SET revision=?1 WHERE seq=(
           SELECT MAX(seq) FROM companion_service_change WHERE domain='materials' AND object_id=?2 AND tombstone=1)",
        params![expected, asset_id],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let receipt = json!({"opId": op_id, "assetId": asset_id,
        "revision": expected, "disposition": "removed"});
    record_operation(&transaction, &instance_id, &device.device_id,
        "materials.removeRecord", op_id, asset_id, &hash, &receipt)?;
    transaction.commit().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(receipt)
}

fn catalog(gateway: &CompanionGateway, device: &PairedDevice, generation: u64) -> ServiceResult<Value> {
    let map: Value = serde_json::from_str(include_str!("../../../protocol/companion-v1/services-v1/operations.json"))
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let bundle_revision = map["bundleRevision"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
    let vault = current_vault(gateway)?;
    let revision = permission_revision(gateway, &device.device_id)?;
    let mut statuses = serde_json::Map::new();
    let mut summary: HashMap<&str, (bool, bool)> = HashMap::new();
    for operation in map["operations"].as_array().ok_or((503, "SERVICE_UNAVAILABLE"))? {
        let id = operation["id"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let domain = operation["domain"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let legacy = operation["legacy"].as_bool().unwrap_or(false);
        let mut state = if operation_implemented(id, legacy) { "implemented" } else { "unsupported" };
        if id == "lsh.session" {
            state = if !gateway.lsh_remote_granted(&device.device_id).map_err(|_| (503, "SERVICE_UNAVAILABLE"))? {
                "notGranted"
            } else if gateway.lsh_remote_host().is_some_and(|host| host.remote_surface_available()) {
                "implemented"
            } else { "temporarilyUnavailable" };
        }
        if id == "presentation.open" && gateway.presentation_sink.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner).is_none() {
            state = "temporarilyUnavailable";
        }
        // Legacy Content V1 is paired-device access, not retroactively gated
        // by the new explicit Services grants. A legacy mapping's grant field
        // is classification only, as specified in routes.md.
        if !legacy && state == "implemented" && domain == "knowledge" && vault.is_none() {
            state = "temporarilyUnavailable";
        }
        if !legacy && state == "implemented" {
            if let Some(class) = operation["grant"].as_str() {
                let scope = operation["scope"].as_str().unwrap_or("");
                let allowed = if id == "knowledge.materialReferences" {
                    granted(gateway, &device.device_id, class, "catalog", "")?
                        && if let Some((id, _)) = vault.as_ref() {
                            granted(gateway, &device.device_id, class, "vault", id)?
                        } else { false }
                } else if matches!(scope, "visibleCatalogAndVaults" | "targetCatalogOrVault" | "ownedJob" | "typedAssetOrVaultNote") {
                    granted(gateway, &device.device_id, class, "catalog", "")?
                        || if let Some((id, _)) = vault.as_ref() {
                            granted(gateway, &device.device_id, class, "vault", id)?
                        } else { false }
                } else if scope.contains("Vault") || scope == "registeredVaults" {
                    if let Some((id, _)) = vault.as_ref() { granted(gateway, &device.device_id, class, "vault", id)? } else { false }
                } else {
                    granted(gateway, &device.device_id, class, "catalog", "")?
                };
                if !allowed { state = "notGranted"; }
            }
        }
        if id == "presentation.open" && state == "implemented" {
            let catalog_pair = granted(gateway, &device.device_id, "desktop.open", "catalog", "")?
                && granted(gateway, &device.device_id, "content.read", "catalog", "")?;
            let vault_pair = if let Some((id, _)) = vault.as_ref() {
                granted(gateway, &device.device_id, "desktop.open", "vault", id)?
                    && granted(gateway, &device.device_id, "content.read", "vault", id)?
            } else { false };
            if !catalog_pair && !vault_pair { state = "notGranted"; }
        }
        let flags = summary.entry(domain).or_insert((false, false));
        if state != "unsupported" { flags.0 = true; }
        if state == "implemented" { flags.1 = true; }
        statuses.insert(id.to_owned(), json!({
            "state": state, "capability": operation["capability"],
            "grant": operation["grant"], "scope": operation["scope"]
        }));
    }
    let services = ["materials", "knowledge", "ingest", "search", "changes", "presentation", "lsh"]
        .into_iter()
        .map(|domain| {
            let (available, granted) = summary.get(domain).copied().unwrap_or((false, false));
            (domain.to_owned(), json!({"version": 1, "available": available, "granted": granted}))
        })
        .collect::<serde_json::Map<String, Value>>();
    Ok(json!({
        "catalogVersion": 1,
        "bundleRevision": bundle_revision,
        "desktopInstanceId": gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id,
        "gatewayGeneration": generation,
        "permissionRevision": revision,
        "services": services,
        "operations": statuses,
        "limits": {"pageSize": 100, "batchItems": 100, "noteBytes": 4194304,
            "uploadBytes": 67108864, "uploadChunkBytes": 262144,
            "concurrentUploads": 2, "searchResults": 50}
    }))
}

pub(super) fn serve(
    gateway: &CompanionGateway,
    request: &HttpRequest,
    stream: &mut impl Write,
    device: &PairedDevice,
    generation: u64,
) -> io::Result<()> {
    let admission_permission = match live_generation(gateway, device, generation) {
        Ok(permission) => permission,
        Err((status, code)) => return write_json(stream, status, &json!({"code": code})),
    };
    #[cfg(test)]
    if let Some(gate) = gateway.policy.services_after_auth_gate.as_ref() {
        gate.pause_if_armed();
    }
    if request.method == "POST" && request.path == "/v1/services/ingest/jobs" {
        return match ingest::begin(gateway, device, generation, admission_permission, &request.body) {
            Ok((status, value)) => write_json(stream, status, &value),
            Err((status, code)) => write_json(stream, status, &json!({"code": code})),
        };
    }
    let result = if request.method == "GET" && request.path == "/v1/services" {
        catalog(gateway, device, generation)
    } else if live_knowledge_route(&request.path) {
        knowledge::route(gateway, device, generation, admission_permission, request)
    } else if request.method == "GET" && request.path == "/v1/services/knowledge/vaults" {
        vaults(gateway, device)
    } else if request.method == "GET" && request.path.split('?').next() == Some("/v1/services/materials/changes") {
        strict_query(&request.path, &["after", "limit"])
            .and_then(|query| material_changes(gateway, device, &query))
    } else if request.method == "GET" && request.path.split('?').next() == Some("/v1/services/search") {
        strict_query(&request.path, &["q", "domains", "limit", "cursor"])
            .and_then(|query| search::search(gateway, device, generation, admission_permission, request, &query))
    } else if request.method == "POST" && request.path == "/v1/services/presentation/open" {
        presentation::open(gateway, device, generation, admission_permission, request)
    } else if request.path.starts_with("/v1/services/ingest/jobs/") && !request.path.contains('?') {
        let route = request.path.trim_start_matches("/v1/services/ingest/jobs/");
        if request.method == "GET" && !route.contains('/') {
            ingest::status(gateway, device, generation, admission_permission, route)
        } else if request.method == "PUT" && route.ends_with("/chunks") {
            ingest::chunk(gateway, device, generation, admission_permission, route.trim_end_matches("/chunks"), request)
        } else if request.method == "POST" && route.ends_with("/complete") {
            ingest::complete(gateway, device, generation, admission_permission, route.trim_end_matches("/complete"), request)
        } else if request.method == "POST" && route.ends_with("/cancel") {
            ingest::cancel(gateway, device, generation, admission_permission, route.trim_end_matches("/cancel"))
        } else if !route.is_empty() && (route.split('/').count() == 1
            || ["chunks", "complete", "cancel"].iter().any(|suffix|
                route.strip_suffix(&format!("/{suffix}")).is_some_and(|id| !id.is_empty() && !id.contains('/')))) {
            Err((405, "METHOD_NOT_ALLOWED"))
        } else { Err((404, "ENTITY_NOT_FOUND")) }
    } else if request.method == "GET" && request.path.starts_with("/v1/services/knowledge/vaults/") {
        let route = request.path.split('?').next().unwrap_or("");
        if let Some(vault_id) = route.strip_prefix("/v1/services/knowledge/vaults/").and_then(|value| value.strip_suffix("/notes")) {
            strict_query(&request.path, &["limit", "afterId", "q"])
                .and_then(|query| registered_notes(gateway, device, vault_id, &query, request))
        } else if let Some(vault_id) = route.strip_prefix("/v1/services/knowledge/vaults/").and_then(|value| value.strip_suffix("/changes")) {
            strict_query(&request.path, &["after", "limit"])
                .and_then(|query| registered_changes(gateway, device, vault_id, &query, request))
        } else { Err((404, "ENTITY_NOT_FOUND")) }
    } else if request.method == "PATCH" && request.path.starts_with("/v1/services/knowledge/notes/")
        && request.path.ends_with("/move") && !request.path.contains('?') {
        let note_id = request.path.trim_start_matches("/v1/services/knowledge/notes/").trim_end_matches("/move");
        knowledge::move_note(gateway, device, generation, admission_permission, note_id, &request.body, request)
    } else if request.path.starts_with("/v1/services/materials/assets/")
        && !request.path.contains('?') {
        let asset_id = request.path.trim_start_matches("/v1/services/materials/assets/");
        if !valid_id(asset_id) { Err((400, "INPUT_INVALID")) } else { match request.method.as_str() {
            "GET" => material_detail(gateway, device, asset_id),
            "PATCH" => material_patch(gateway, device, generation, admission_permission, asset_id, &request.body),
            "DELETE" => material_remove(gateway, device, generation, admission_permission, asset_id, &request.body),
            _ => Err((405, "METHOD_NOT_ALLOWED")),
        } }
    } else if request.path.contains('?') && request.path.split('?').next() == Some("/v1/services") {
        Err((400, "INPUT_INVALID"))
    } else {
        Err((404, "ENTITY_NOT_FOUND"))
    };
    match result {
        Ok(value) => write_json(stream, 200, &value),
        Err((status, code)) => write_json(stream, status, &json!({"code": code})),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceGrantChange {
    pub grant_class: String,
    pub scope_kind: String,
    pub scope_id: String,
    pub enabled: bool,
}

impl CompanionGateway {
    /// Existing single switches retain their semantics, including revoking a
    /// remembered non-current vault. New grants still require the current target.
    pub(crate) fn set_service_grant(
        &self, device_id: &str, grant_class: &str, scope_kind: &str, scope_id: &str, enabled: bool,
    ) -> Result<(), GatewayError> {
        self.apply_service_grants(device_id, &[ServiceGrantChange {
            grant_class: grant_class.into(), scope_kind: scope_kind.into(), scope_id: scope_id.into(), enabled,
        }], None)
    }

    /// Desktop-only explicit consent: all changes or none, fenced by the exact
    /// permission revision displayed for this device. No wildcard/future scopes.
    pub(crate) fn set_service_grants(
        &self, device_id: &str, changes: &[ServiceGrantChange], expected_permission_revision: u64,
        expected_current_vault_id: Option<&str>,
    ) -> Result<(), GatewayError> {
        self.apply_service_grants(device_id, changes, Some((expected_permission_revision, expected_current_vault_id)))
    }

    fn apply_service_grants(
        &self, device_id: &str, changes: &[ServiceGrantChange], expected: Option<(u64, Option<&str>)>,
    ) -> Result<(), GatewayError> {
        let invalid = || GatewayError::new("companion-service-grant-invalid", "Invalid service permission scope");
        let stale = || GatewayError::new("permission-state-changed", "Review the current device permissions and vault");
        if changes.is_empty() || changes.len() > 512 { return Err(invalid()); }
        let _transition = self.control_transition()?;
        let grants_vault = changes.iter().any(|change| change.enabled && change.scope_kind == "vault");
        let reviewed_vault = if grants_vault { current_vault(self).map_err(|_| stale())?.map(|(id, _)| id) } else { None };
        if grants_vault && expected.is_some_and(|(_, vault)| vault != reviewed_vault.as_deref()) { return Err(stale()); }
        let mut seen = BTreeSet::new();
        for change in changes {
            if !matches!(change.grant_class.as_str(), "content.read" | "content.write" | "ingest.write" | "desktop.open")
                || !seen.insert((&change.grant_class, &change.scope_kind, &change.scope_id))
                || match change.scope_kind.as_str() {
                    "catalog" => !change.scope_id.is_empty(),
                    "vault" => !valid_id(&change.scope_id) || (change.enabled && reviewed_vault.as_deref() != Some(change.scope_id.as_str())),
                    _ => true,
                } { return Err(invalid()); }
        }
        let mut connection = open_connection(self.backend.db_path())?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GatewayError::new("companion-database-unavailable", "Permission store unavailable"))?;
        let revision: u64 = transaction.query_row(
            "SELECT services_permission_revision FROM companion_device WHERE device_id=?1 AND revoked_at IS NULL",
            [device_id], |row| row.get(0)
        ).map_err(|_| GatewayError::new("companion-device-unknown", "Paired device unavailable"))?;
        // The revision comparison belongs inside this write transaction: a
        // concurrent view cannot approve against stale read-before-write state.
        if expected.is_some_and(|(expected_revision, _)| expected_revision != revision) { return Err(stale()); }
        let mut changed = 0;
        let now = chrono::Utc::now().to_rfc3339();
        for change in changes {
            changed += if change.enabled {
                transaction.execute(
                    "INSERT OR IGNORE INTO companion_service_grant(device_id,grant_class,scope_kind,scope_id,granted_at)
                     VALUES(?1,?2,?3,?4,?5)",
                    params![device_id, change.grant_class, change.scope_kind, change.scope_id, now]
                )
            } else {
                transaction.execute(
                    "DELETE FROM companion_service_grant WHERE device_id=?1 AND grant_class=?2 AND scope_kind=?3 AND scope_id=?4",
                    params![device_id, change.grant_class, change.scope_kind, change.scope_id]
                )
            }.map_err(|_| GatewayError::new("companion-database-unavailable", "Permission update failed"))?;
        }
        if changed > 0 {
            transaction.execute(
                "UPDATE companion_device SET services_permission_revision=services_permission_revision+1 WHERE device_id=?1",
                [device_id]
            ).map_err(|_| GatewayError::new("companion-database-unavailable", "Permission revision failed"))?;
        }
        // Recheck exact target identity immediately before commit. Knowledge
        // switches use their own lock; this is not a serialized switch lease.
        // A switch after this check can only retain the explicitly reviewed
        // target's grant, never grant the new/current target or clone rights.
        if grants_vault && current_vault(self).map_err(|_| stale())?.map(|(id, _)| id) != reviewed_vault { return Err(stale()); }
        transaction.commit().map_err(|_| GatewayError::new("companion-database-unavailable", "Permission commit failed"))?;
        if changed > 0 { self.retire_presentation_offers(Some(device_id)); }
        Ok(())
    }

    pub(crate) fn service_grant_state(&self, device_id: &str) -> Result<Value, GatewayError> {
        let mut connection = open_connection(self.backend.db_path())?;
        let transaction = connection.transaction()
            .map_err(|_| GatewayError::new("companion-database-unavailable", "Permission read unavailable"))?;
        let revision: u64 = transaction.query_row(
            "SELECT services_permission_revision FROM companion_device WHERE device_id=?1 AND revoked_at IS NULL",
            [device_id], |row| row.get(0)
        ).map_err(|_| GatewayError::new("companion-device-unknown", "Paired device unavailable"))?;
        let mut statement = transaction.prepare(
            "SELECT grant_class,scope_kind,scope_id FROM companion_service_grant WHERE device_id=?1 ORDER BY grant_class,scope_kind,scope_id"
        ).map_err(|_| GatewayError::new("companion-database-unavailable", "Permission store unavailable"))?;
        let grants = statement.query_map([device_id], |row| {
            Ok(json!({"grantClass": row.get::<_, String>(0)?, "scopeKind": row.get::<_, String>(1)?, "scopeId": row.get::<_, String>(2)?}))
        }).map_err(|_| GatewayError::new("companion-database-unavailable", "Permission read failed"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| GatewayError::new("companion-database-unavailable", "Permission read failed"))?;
        let vault = current_vault(self).ok().flatten().map(|(vault_id, label)| json!({"vaultId": vault_id, "label": label}));
        Ok(json!({"permissionRevision": revision, "grants": grants, "currentVault": vault}))
    }
}
