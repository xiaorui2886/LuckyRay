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
        database(gateway)?.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM companion_service_change WHERE domain=?1 AND scope_id=?2",
            params![domain, scope], |row| row.get(0),
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))
    }
}

fn upload_hints(gateway: &CompanionGateway, device: &PairedDevice,
    seen: &mut HashMap<String, String>) -> ServiceResult<Vec<Value>> {
    let instance = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let connection = database(gateway)?;
    let mut statement = connection.prepare(
        "SELECT job_id,updated_at FROM companion_service_upload
         WHERE instance_id=?1 AND device_id=?2 ORDER BY updated_at DESC LIMIT 32",
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let rows = statement.query_map(params![instance, device.device_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        .collect::<Result<Vec<_>, _>>().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let mut hints = Vec::new();
    for (job_id, updated) in rows {
        if seen.get(&job_id) != Some(&updated) {
            hints.push(json!({"kind":"ingestChanged","jobId":job_id}));
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
    let mut permission = match permission_revision(gateway, &device.device_id) {
        Ok(value) => value,
        Err(_) => return,
    };
    let mut next_poll = Instant::now();
    let mut next_heartbeat = Instant::now();
    let heartbeat = generation.to_be_bytes();
    let mut awaiting_pong = false;
    let mut material_seq = 0u64;
    let mut knowledge_seq = 0u64;
    let mut vault_id = String::new();
    let mut seen_uploads = HashMap::new();
    let mut lsh_state: Option<(bool, bool)> = None;
    while !stop.load(Ordering::SeqCst) {
        if Instant::now() >= next_poll {
            let current_permission = match permission_revision(gateway, &device.device_id) {
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
                if let Ok(seq) = high(gateway, "materials", "") {
                    if seq > material_seq {
                        if let Ok(tag) = cursor_tag(gateway, &device.device_id, "materials", "catalog", permission) {
                            if write_ws_text_frame(stream, &json!({"kind":"materialChanged",
                                "cursor":format!("m:{tag}:{seq}")})).is_err() { break; }
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
