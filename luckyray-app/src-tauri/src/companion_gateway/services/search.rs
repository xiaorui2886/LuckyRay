use super::*;

const MAX_SNAPSHOT_HITS: usize = 5000;
const MAX_ACTIVE_SNAPSHOTS_PER_DEVICE: i64 = 4;
const MAX_ACTIVE_SNAPSHOT_BYTES_PER_DEVICE: i64 = 4 * 1024 * 1024;
const MAX_ACTIVE_SNAPSHOTS_GLOBAL: i64 = 32;
const MAX_ACTIVE_SNAPSHOT_BYTES_GLOBAL: i64 = 32 * 1024 * 1024;

fn reuse_live_snapshot(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, instance_id: &str, query_key: &str,
    permission: u64, now: i64, limit: usize,
) -> ServiceResult<Option<Value>> {
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    let connection = database(gateway)?;
    let existing: Option<(String, String)> = connection.query_row(
        "SELECT snapshot_id,items_json FROM companion_service_search_snapshot
         WHERE instance_id=?1 AND device_id=?2 AND query_key=?3
           AND permission_revision=?4 AND expires_at>?5 ORDER BY rowid DESC LIMIT 1",
        params![instance_id, device.device_id, query_key, permission, now],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let Some((id, encoded)) = existing else { return Ok(None); };
    let items: Vec<Value> = serde_json::from_str(&encoded)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let end = limit.min(items.len());
    let next = if end < items.len() {
        Some(format!("s:{id}:{end}"))
    } else {
        connection.execute("DELETE FROM companion_service_search_snapshot WHERE snapshot_id=?1", [&id])
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        None
    };
    Ok(Some(json!({"items": &items[..end], "nextCursor": next})))
}

pub(super) fn search(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64,
    request: &HttpRequest, query: &HashMap<String, String>,
) -> ServiceResult<Value> {
    let q = query.get("q").map(|value| value.trim().to_lowercase()).unwrap_or_default();
    if q.is_empty() || q.len() > 200 || q.chars().any(char::is_control) {
        return Err((400, "INPUT_INVALID"));
    }
    let domain_value = query.get("domains").map(String::as_str).unwrap_or("materials,knowledge");
    let domains = domain_value.split(',').collect::<Vec<_>>();
    if domains.is_empty() || domains.len() > 2 || domains.iter().any(|d| !matches!(*d, "materials" | "knowledge"))
        || (domains.len() == 2 && domains[0] == domains[1]) {
        return Err((400, "INPUT_INVALID"));
    }
    let limit = query.get("limit").map(|value| value.parse::<usize>())
        .transpose().map_err(|_| (400, "INPUT_INVALID"))?.unwrap_or(20);
    if !(1..=50).contains(&limit) { return Err((400, "INPUT_INVALID")); }
    let catalog_allowed = granted(gateway, &device.device_id, "content.read", "catalog", "")?;
    let vault = current_vault(gateway)?;
    let vault_allowed = if let Some((id, _)) = vault.as_ref() {
        granted(gateway, &device.device_id, "content.read", "vault", id)?
    } else { false };
    if !catalog_allowed && !vault_allowed { return Err((403, "GRANT_REQUIRED")); }
    let permission = permission_revision(gateway, &device.device_id)?;
    if permission != admission_permission { return Err((403, "SCOPE_DENIED")); }
    let instance_id = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let visible_vault = if domains.contains(&"knowledge") && vault_allowed {
        vault.as_ref().map(|(id, _)| id.as_str()).unwrap_or("")
    } else { "" };
    let mut query_scope = format!("{}|{}|{}|{}",q,domain_value,catalog_allowed && domains.contains(&"materials"),visible_vault);
    if let Some(library) = gateway.material_scope_id() { query_scope.push_str(&format!("|materials:{library}")); }
    let query_key = format!("{:x}", Sha256::digest(query_scope));
    let now = chrono::Utc::now().timestamp();
    if !query.contains_key("cursor") {
        if let Some(page) = reuse_live_snapshot(gateway, device, generation, admission_permission,
            &instance_id, &query_key, permission, now, limit)? { return Ok(page); }
    }
    let (snapshot_id, offset, items) = if let Some(cursor) = query.get("cursor") {
        let rest = cursor.strip_prefix("s:").ok_or((400, "INPUT_INVALID"))?;
        let (id, offset) = rest.split_once(':').ok_or((400, "INPUT_INVALID"))?;
        if id.len() != 24 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err((400, "INPUT_INVALID"));
        }
        let offset = offset.parse::<usize>().map_err(|_| (400, "INPUT_INVALID"))?;
        let stored = database(gateway)?.query_row(
            "SELECT instance_id,device_id,query_key,permission_revision,expires_at,items_json
             FROM companion_service_search_snapshot WHERE snapshot_id=?1",
            [id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, String>(2)?, row.get::<_, u64>(3)?, row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?)),
        ).optional().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
            .ok_or((410, "CURSOR_TOO_OLD"))?;
        if stored.0 != instance_id || stored.1 != device.device_id || stored.2 != query_key
            || stored.3 != permission || stored.4 <= now { return Err((410, "CURSOR_TOO_OLD")); }
        let items: Vec<Value> = serde_json::from_str(&stored.5).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if offset > items.len() { return Err((410, "CURSOR_TOO_OLD")); }
        (id.to_owned(), offset, items)
    } else {
        let mut items = Vec::new();
        if domains.contains(&"materials") && catalog_allowed {
            let escaped = q.replace('"', "\"\"");
            let fts = format!("\"{escaped}\"");
            let hits = gateway.material_catalog().search_assets_scoped(
                &fts, MAX_SNAPSHOT_HITS + 1, &crate::materials::MaterialQueryScope::default(),
            ).map_err(|_| (400, "INPUT_INVALID"))?;
            if hits.len() > MAX_SNAPSHOT_HITS { return Err((400, "INPUT_INVALID")); }
            items.extend(hits.into_iter().map(|hit| json!({
                "domain": "materials", "assetId": hit.asset.id, "title": hit.asset.name,
                "subtitle": hit.asset.description
            })));
        }
        if domains.contains(&"knowledge") && vault_allowed {
            let (vault_id, _) = vault.as_ref().ok_or((503, "SERVICE_UNAVAILABLE"))?;
            let mut after = String::new();
            loop {
                let mut qmap = HashMap::from([("q".to_owned(), q.clone()),
                    ("limit".to_owned(), "100".to_owned())]);
                if !after.is_empty() { qmap.insert("afterId".to_owned(), after.clone()); }
                let page = registered_notes(gateway, device, vault_id, &qmap, request)?;
                for item in page["items"].as_array().ok_or((503, "SERVICE_UNAVAILABLE"))? {
                    items.push(json!({"domain": "knowledge", "vaultId": vault_id,
                        "noteId": item["noteId"], "title": item["title"],
                        "path": item["parentRelativePath"]}));
                }
                if items.len() > MAX_SNAPSHOT_HITS { return Err((400, "INPUT_INVALID")); }
                if page["hasMore"] != true { break; }
                let next = page["nextAfterId"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
                if next.is_empty() || next == after { return Err((503, "SERVICE_UNAVAILABLE")); }
                after = next.to_owned();
            }
        }
        // A fully delivered answer has no cursor to lease. Persisting it for
        // ten minutes made the fifth ordinary one-page/empty lookup hit the
        // four-snapshot protection despite no client being able to use it.
        if items.len() <= limit {
            if permission_revision(gateway, &device.device_id)? != permission {
                return Err((403, "SCOPE_DENIED"));
            }
            return Ok(json!({"items": items, "nextCursor": Value::Null}));
        }
        let mut bytes = [0u8; 12];
        OsRng.fill_bytes(&mut bytes);
        let id = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let encoded = serde_json::to_string(&items).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if encoded.len() as i64 > MAX_ACTIVE_SNAPSHOT_BYTES_PER_DEVICE {
            return Err((429, "RATE_LIMITED"));
        }
        let _transition = service_transition(gateway, device, generation, admission_permission)?;
        if permission_revision(gateway, &device.device_id)? != permission {
            return Err((403, "SCOPE_DENIED"));
        }
        let mut connection = database(gateway)?;
        let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        transaction.execute("DELETE FROM companion_service_search_snapshot WHERE expires_at<=?1", [now])
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        // A fresh request for the same query is a retry of its still-live
        // immutable snapshot, not another ten-minute slot.
        let existing: Option<(String, String)> = transaction.query_row(
            "SELECT snapshot_id,items_json FROM companion_service_search_snapshot
             WHERE instance_id=?1 AND device_id=?2 AND query_key=?3
               AND permission_revision=?4 AND expires_at>?5 ORDER BY rowid DESC LIMIT 1",
            params![instance_id, device.device_id, query_key, permission, now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if let Some((existing_id, existing_json)) = existing {
            let existing_items: Vec<Value> = serde_json::from_str(&existing_json)
                .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
            let end = limit.min(existing_items.len());
            let next = if end < existing_items.len() {
                Some(format!("s:{existing_id}:{end}"))
            } else {
                transaction.execute("DELETE FROM companion_service_search_snapshot WHERE snapshot_id=?1",
                    [&existing_id]).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
                None
            };
            transaction.commit().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
            return Ok(json!({"items": &existing_items[..end], "nextCursor": next}));
        }
        loop {
            let (active, bytes): (i64, i64) = transaction.query_row(
                "SELECT COUNT(*),COALESCE(SUM(LENGTH(CAST(items_json AS BLOB))),0) FROM companion_service_search_snapshot
                 WHERE instance_id=?1 AND device_id=?2 AND expires_at>?3",
                params![instance_id, device.device_id, now], |row| Ok((row.get(0)?, row.get(1)?)),
            ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
            let (global_active, global_bytes): (i64, i64) = transaction.query_row(
                "SELECT COUNT(*),COALESCE(SUM(LENGTH(CAST(items_json AS BLOB))),0) FROM companion_service_search_snapshot
                 WHERE instance_id=?1 AND expires_at>?2",
                params![instance_id, now], |row| Ok((row.get(0)?, row.get(1)?)),
            ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
            if active < MAX_ACTIVE_SNAPSHOTS_PER_DEVICE
                && bytes.saturating_add(encoded.len() as i64) <= MAX_ACTIVE_SNAPSHOT_BYTES_PER_DEVICE
                && global_active < MAX_ACTIVE_SNAPSHOTS_GLOBAL
                && global_bytes.saturating_add(encoded.len() as i64) <= MAX_ACTIVE_SNAPSHOT_BYTES_GLOBAL {
                break;
            }
            // A replacement may reclaim only this device's oldest lease.
            // Other devices' cursors and the hard count/byte caps remain
            // untouched. Reclaimed cursors fail explicitly with 410.
            let oldest: Option<String> = transaction.query_row(
                "SELECT snapshot_id FROM companion_service_search_snapshot
                 WHERE instance_id=?1 AND device_id=?2 AND expires_at>?3
                 ORDER BY rowid ASC LIMIT 1",
                params![instance_id, device.device_id, now], |row| row.get(0),
            ).optional().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
            let Some(oldest) = oldest else { return Err((429, "RATE_LIMITED")); };
            transaction.execute("DELETE FROM companion_service_search_snapshot WHERE snapshot_id=?1", [oldest])
                .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        }
        transaction.execute(
            "INSERT INTO companion_service_search_snapshot(snapshot_id,instance_id,device_id,query_key,
                permission_revision,expires_at,items_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, instance_id, device.device_id, query_key, permission,
                now + 600, encoded],
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        transaction.commit().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        (id, 0, items)
    };
    if permission_revision(gateway, &device.device_id)? != permission { return Err((403, "SCOPE_DENIED")); }
    let end = offset.saturating_add(limit).min(items.len());
    let next = if end < items.len() { Some(format!("s:{snapshot_id}:{end}")) } else { None };
    if next.is_none() {
        // The final page exhausts this lease. Retire it before responding so
        // five normal two-page searches never masquerade as five concurrent
        // cursors. A lost final response retries as explicit 410, never as a
        // silently shifted live query or a second quota-consuming snapshot.
        let _transition = service_transition(gateway, device, generation, admission_permission)?;
        let removed = database(gateway)?.execute(
            "DELETE FROM companion_service_search_snapshot WHERE snapshot_id=?1 AND instance_id=?2
             AND device_id=?3 AND query_key=?4 AND permission_revision=?5 AND expires_at>?6",
            params![snapshot_id, instance_id, device.device_id, query_key, permission, now],
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if removed == 0 { return Err((410, "CURSOR_TOO_OLD")); }
    }
    Ok(json!({"items": &items[offset..end], "nextCursor": next}))
}
