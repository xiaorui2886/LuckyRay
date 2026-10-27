use super::*;

pub(crate) fn event_authorized(gateway: &CompanionGateway, device: &PairedDevice) -> ServiceResult<()> {
    let catalog = granted(gateway, &device.device_id, "content.read", "catalog", "")?;
    let vault = if let Some((id, _)) = current_vault(gateway)? {
        granted(gateway, &device.device_id, "content.read", "vault", &id)?
    } else { false };
    if catalog || vault { Ok(()) } else { Err((403, "GRANT_REQUIRED")) }
}

fn high(gateway: &CompanionGateway, domain: &str, scope: &str) -> ServiceResult<u64> {
    if domain == "knowledge" {
        database(gateway)?.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM companion_content_change WHERE vault_key=?1",
            [scope], |row| row.get(0),
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))
    } else {
        // The durable material log is shared, while retained membership also
        // covers tombstones. Do not use the global high-water as a scope hint.
        let library = gateway.material_catalog().library_scope_key()
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        database(gateway)?.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM companion_service_change
             WHERE domain='materials' AND scope_id='' AND object_id IN
             (SELECT asset_id FROM material_library_asset_history WHERE library_id=?1)",
            [library], |row| row.get(0),
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))
    }
}

// Hints are scoped wake-ups, never an authorization or a content snapshot.
// A job created for a different selected library/vault must not be revealed
// merely because it belongs to the same paired device.
fn upload_matches_scope(manifest: &Value, material: Option<&str>, vault: Option<&str>) -> bool {
    match manifest["target"]["domain"].as_str() {
        Some("materials") => match (material, manifest["target"].get("libraryId")) {
            (Some(expected), Some(Value::String(actual))) => actual == expected,
            (None, None) | (None, Some(Value::Null)) => true,
            _ => false,
        },
        Some("knowledge") => vault.is_some_and(|expected|
            manifest["target"]["vaultId"].as_str() == Some(expected)),
        _ => false,
    }
}

fn upload_hints(gateway: &CompanionGateway, device: &PairedDevice,
    seen: &mut HashMap<String, String>) -> ServiceResult<Vec<Value>> {
    let instance = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let material = gateway.material_scope_id();
    let vault = current_vault(gateway)?.map(|(id, _)| id);
    let connection = database(gateway)?;
    let mut statement = connection.prepare(
        "SELECT job_id,updated_at,manifest FROM companion_service_upload
         WHERE instance_id=?1 AND device_id=?2 AND CASE WHEN json_valid(manifest) THEN
           ((json_extract(manifest,'$.target.domain')='materials' AND
             ((?3 IS NULL AND COALESCE(json_type(manifest,'$.target.libraryId'),'null')='null')
               OR (?3 IS NOT NULL AND json_extract(manifest,'$.target.libraryId')=?3)))
             OR (json_extract(manifest,'$.target.domain')='knowledge' AND ?4 IS NOT NULL
               AND json_extract(manifest,'$.target.vaultId')=?4))
           ELSE 0 END
         ORDER BY updated_at DESC LIMIT 32",
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let rows = statement.query_map(params![instance, device.device_id, material, vault.as_deref()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        .collect::<Result<Vec<_>, _>>().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let mut hints = Vec::new();
    for (job_id, updated, raw_manifest) in rows {
        let manifest: Value = match serde_json::from_str(&raw_manifest) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !upload_matches_scope(&manifest, material, vault.as_deref()) { continue; }
        let allowed = match manifest["target"]["domain"].as_str() {
            Some("materials") => granted(gateway, &device.device_id, "ingest.write", "catalog", material.unwrap_or(""))?,
            Some("knowledge") => granted(gateway, &device.device_id, "ingest.write", "vault", vault.as_deref().unwrap_or(""))?,
            _ => false,
        };
        if !allowed { continue; }
        if seen.get(&job_id) != Some(&updated) {
            let mut hint = json!({"kind":"ingestChanged","jobId":job_id});
            if manifest["target"]["domain"].as_str() == Some("materials") {
                if let Some(id) = material { hint["materialLibraryId"] = json!(id); }
            } else if let Some(id) = vault.as_deref() { hint["vaultId"] = json!(id); }
            hints.push(hint);
            seen.insert(job_id, updated);
        }
    }
    Ok(hints)
}

pub(crate) fn event_stream(
    gateway: &CompanionGateway,
    stream: &mut StreamOwned<ServerConnection, TcpStream>,
    stop: &AtomicBool,
    device: &PairedDevice,
    generation: u64,
) {
    let _ = stream.sock.set_read_timeout(Some(Duration::from_millis(100)));
    // A slow reader must not hold the revocation/control gate indefinitely.
    if stream.sock.set_write_timeout(Some(Duration::from_millis(100))).is_err() { return; }
    let mut permission = match permission_revision(gateway, &device.device_id) {
        Ok(value) => value,
        Err(_) => return,
    };
    let mut next_poll = Instant::now();
    let mut next_heartbeat = Instant::now();
    let heartbeat = generation.to_be_bytes();
    let mut awaiting_pong = false;
    let mut material_seq = 0u64;
    let material_scope = gateway.material_scope_id().unwrap_or("").to_owned();
    let material_cursor_scope = if material_scope.is_empty() { "catalog" } else { &material_scope };
    let mut knowledge_seq = 0u64;
    let mut vault_id = String::new();
    let mut seen_uploads = HashMap::new();
    let mut lsh_state: Option<(bool, bool)> = None;
    while !stop.load(Ordering::SeqCst) {
        if Instant::now() >= next_poll {
            // Never wait here: gateway stop joins workers under this same gate.
            // Linearize the bounded hint batch before a revoke/control change.
            let _transition = match gateway.try_transition() { Ok(guard) => guard, Err(_) => break };
            if gateway.validate_request_scope().is_err() { break; }
            let current_permission = match live_generation(gateway, device, generation) {
                Ok(value) => value,
                Err(_) => break,
            };
            if current_permission != permission {
                let _ = write_ws_text_frame(stream, &json!({"kind":"servicesChanged",
                    "permissionRevision":current_permission}));
                permission = current_permission;
                break;
            }
            let catalog = granted(gateway, &device.device_id, "content.read", "catalog", "").unwrap_or(false);
            let active_vault = current_vault(gateway).ok().flatten().map(|(id, _)| id);
            let vault = active_vault.as_ref().and_then(|id|
                granted(gateway, &device.device_id, "content.read", "vault", id).ok()
                    .filter(|granted| *granted).map(|_| id.as_str()));
            if !catalog && vault.is_none() { break; }
            if catalog {
                if let Ok(seq) = high(gateway, "materials", &material_scope) {
                    if seq > material_seq {
                        if let Ok(tag) = cursor_tag(gateway, &device.device_id, "materials", material_cursor_scope, permission) {
                            let mut hint = json!({"kind":"materialChanged", "cursor":format!("m:{tag}:{seq}")});
                            if !material_scope.is_empty() { hint["materialLibraryId"] = json!(material_scope); }
                            if write_ws_text_frame(stream, &hint).is_err() { break; }
                        }
                        material_seq = seq;
                    }
                }
            }
            if let Some(vault) = vault {
                if vault != vault_id {
                    vault_id = vault.to_owned();
                    knowledge_seq = 0;
                }
                if let Ok(seq) = high(gateway, "knowledge", vault) {
                    if seq > knowledge_seq {
                        if let Ok(tag) = cursor_tag(gateway, &device.device_id, "knowledge", vault, permission) {
                            if write_ws_text_frame(stream, &json!({"kind":"knowledgeChanged",
                                "vaultId":vault,"cursor":format!("k:{tag}:{seq}")})).is_err() { break; }
                        }
                        knowledge_seq = seq;
                    }
                }
            }
            if let Ok(hints) = upload_hints(gateway, device, &mut seen_uploads) {
                for hint in hints {
                    if write_ws_text_frame(stream, &hint).is_err() { return; }
                }
            }
            let next_lsh = (
                gateway.lsh_remote_granted(&device.device_id).unwrap_or(false),
                gateway.lsh_remote_host().is_some_and(|host| host.remote_surface_available()),
            );
            if lsh_state.is_some_and(|old| old != next_lsh)
                && write_ws_text_frame(stream, &json!({"kind":"lshStateChanged"})).is_err() { break; }
            lsh_state = Some(next_lsh);
            next_poll = Instant::now() + Duration::from_millis(500);
        }
        if Instant::now() >= next_heartbeat {
            if awaiting_pong { let _ = write_ws_frame(stream, 0x8, &1002u16.to_be_bytes()); break; }
            if write_ws_frame(stream, 0x9, &heartbeat).is_err() { break; }
            awaiting_pong = true;
            next_heartbeat = Instant::now() + gateway.policy.heartbeat_interval;
        }
        match read_ws_frame(stream) {
            Ok(Some((0x8, payload))) => { let _ = write_ws_frame(stream, 0x8, &payload); break; }
            Ok(Some((0x9, payload))) => { if write_ws_frame(stream, 0xA, &payload).is_err() { break; } }
            Ok(Some((0xA, payload))) if payload == heartbeat => awaiting_pong = false,
            Ok(Some((0xA, _))) | Ok(Some((_ , _))) => {
                let _ = write_ws_frame(stream, 0x8, &1003u16.to_be_bytes()); break;
            }
            Ok(None) => {}
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
    }
}


#[cfg(test)]
mod library_hint_tests {
    use super::*;

    #[test]
    fn upload_hints_never_cross_material_scope() {
        let a = json!({"target":{"domain":"materials","libraryId":"library-a"}});
        assert!(upload_matches_scope(&a, Some("library-a"), None));
        assert!(!upload_matches_scope(&a, Some("library-b"), None));
        assert!(!upload_matches_scope(&a, None, None));
        let legacy = json!({"target":{"domain":"materials"}});
        assert!(upload_matches_scope(&legacy, None, None));
        assert!(!upload_matches_scope(&legacy, Some("library-a"), None));
        assert!(!upload_matches_scope(&json!({"target":{"domain":"materials","libraryId":7}}), None, None));
    }

    #[test]
    fn upload_hints_never_cross_knowledge_scope_or_invalid_target() {
        let a = json!({"target":{"domain":"knowledge","vaultId":"vault-a"}});
        assert!(upload_matches_scope(&a, Some("library-b"), Some("vault-a")));
        assert!(!upload_matches_scope(&a, None, Some("vault-b")));
        assert!(!upload_matches_scope(&a, None, None));
        assert!(!upload_matches_scope(&json!({"target":{"domain":"knowledge"}}), None, Some("vault-a")));
        assert!(!upload_matches_scope(&json!({}), None, None));
        assert!(!upload_matches_scope(&json!({"target":{"domain":"other"}}), None, None));
    }
}
