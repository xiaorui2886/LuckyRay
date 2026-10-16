use super::*;

pub(super) fn open(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64,
    request: &HttpRequest,
) -> ServiceResult<Value> {
    if request.body.len() > 4096 { return Err((400, "INPUT_INVALID")); }
    let (payload, hash) = canonical_body(&request.body)?;
    let object = payload.as_object().ok_or((400, "INPUT_INVALID"))?;
    if object.len() != 2 || !object.contains_key("opId") || !object.contains_key("target") {
        return Err((400, "INPUT_INVALID"));
    }
    let op_id = payload["opId"].as_str().filter(|id| valid_id(id)).ok_or((400, "INPUT_INVALID"))?;
    let target = payload["target"].as_object().ok_or((400, "INPUT_INVALID"))?;
    let (scope_kind, scope_id, target_key) = match payload["target"]["domain"].as_str() {
        Some("materials") if target.len() == 2 => {
            let asset_id = payload["target"]["assetId"].as_str().filter(|id| valid_id(id))
                .ok_or((400, "INPUT_INVALID"))?;
            ("catalog", "", format!("materials:{asset_id}"))
        }
        Some("knowledge") if target.len() == 3 => {
            let vault = payload["target"]["vaultId"].as_str().filter(|id| valid_id(id))
                .ok_or((400, "INPUT_INVALID"))?;
            let note = payload["target"]["noteId"].as_str().filter(|id| valid_id(id))
                .ok_or((400, "INPUT_INVALID"))?;
            ("vault", vault, format!("knowledge:{vault}:{note}"))
        }
        _ => return Err((400, "INPUT_INVALID")),
    };
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    if !granted(gateway, &device.device_id, "desktop.open", scope_kind, scope_id)?
        || !granted(gateway, &device.device_id, "content.read", scope_kind, scope_id)? {
        return Err((403, "GRANT_REQUIRED"));
    }
    let mut navigation_id = None;
    if scope_kind == "catalog" {
        let asset_id = payload["target"]["assetId"].as_str().unwrap_or("");
        gateway.backend.material_catalog().get_assets(&[asset_id.to_owned()])
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
            .into_iter().next().ok_or((404, "ENTITY_NOT_FOUND"))?;
    } else {
        if current_vault(gateway)?.as_ref().map(|(id, _)| id.as_str()) != Some(scope_id) {
            return Err((503, "SERVICE_UNAVAILABLE"));
        }
        let note_id = payload["target"]["noteId"].as_str().unwrap_or("");
        let legacy = HttpRequest { method: "GET".to_owned(),
            path: format!("/v1/notes/{note_id}?vault={scope_id}"),
            headers: request.headers.clone(), body: Vec::new() };
        let detail = content::read_notes_for_service(gateway, &legacy)
            .map_err(|(status, _)| if status == 404 { (404, "ENTITY_NOT_FOUND") }
                else { (503, "SERVICE_UNAVAILABLE") })?;
        let relative_path = detail["relativePath"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let registration_id = gateway.backend.knowledge().current_vault_id()
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        navigation_id = Some(crate::knowledge::KnowledgeService::document_id(
            &crate::knowledge::KnowledgeDocumentRef {
                vault_id: registration_id, relative_path: relative_path.to_owned(),
            }));
    }
    let instance = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let connection = database(gateway)?;
    if let Some(receipt) = replay_operation(&connection, &instance, &device.device_id,
        "presentation.open", op_id, &target_key, &hash)? { return Ok(receipt); }
    if gateway.backend.knowledge().companion_has_unsaved_draft()
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))? {
        return Err((503, "DESKTOP_DRAFT_BUSY"));
    }
    let sink = gateway.presentation_sink.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
        .ok_or((503, "SERVICE_UNAVAILABLE"))?;
    // Reserve the idempotency key before any local navigation can occur. If
    // the later receipt write fails, this pending row makes a retry fail
    // closed (410) instead of emitting a second presentation offer.
    let reserved_at = chrono::Utc::now().to_rfc3339();
    connection.execute(
        "INSERT INTO companion_service_operation(instance_id,device_id,operation_id,op_id,
            target_key,payload_sha256,stage,receipt,created_at,updated_at)
         VALUES(?1,?2,'presentation.open',?3,?4,?5,'pending',NULL,?6,?6)",
        params![instance, device.device_id, op_id, target_key, hash, reserved_at],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let request_id = random_hex(16);
    let (sender, receiver) = std::sync::mpsc::channel();
    let claim_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    gateway.presentation_pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(request_id.clone(), PendingPresentation {
            sender, claimed: false, device_id: device.device_id.clone(),
            deadline: claim_deadline,
        });
    let offered = sink(json!({"requestId": request_id, "target": payload["target"],
        "navigationId": navigation_id}));
    let mut handoff_started = false;
    let mut explicitly_rejected = false;
    let accepted = if offered { loop {
        match receiver.recv_timeout(std::time::Duration::from_millis(25)) {
            Ok(value) => {
                handoff_started = value;
                explicitly_rejected = !value;
                break value;
            },
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break false,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        if std::time::Instant::now() >= claim_deadline {
            // Claim and expiry arbitrate under the same mutex. The lease is
            // retired whether or not the renderer sent its observation ACK;
            // an expired claim can no longer authorize late navigation.
            let mut pending = gateway.presentation_pending.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            handoff_started = pending.remove(&request_id).is_some_and(|offer| offer.claimed);
            break false;
        }
    } } else { false };
    if !offered {
        gateway.presentation_pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&request_id);
    }
    if explicitly_rejected {
        // A false ACK is a refusal, but a route may have changed partially
        // before its callback failed. Retain the opId as expired so an
        // automatic retry cannot dispatch that local navigation twice.
        let retired = connection.execute(
            "UPDATE companion_service_operation SET stage='expired',updated_at=?1
             WHERE instance_id=?2 AND device_id=?3 AND operation_id='presentation.open'
               AND op_id=?4 AND stage='pending'",
            params![chrono::Utc::now().to_rfc3339(), instance, device.device_id, op_id],
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if retired != 1 { return Err((503, "SERVICE_UNAVAILABLE")); }
        return Err((409, "PRESENTATION_BUSY"));
    }
    if !handoff_started {
        let removed = connection.execute(
            "DELETE FROM companion_service_operation WHERE instance_id=?1 AND device_id=?2
             AND operation_id='presentation.open' AND op_id=?3 AND stage='pending'",
            params![instance, device.device_id, op_id],
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if removed != 1 { return Err((503, "SERVICE_UNAVAILABLE")); }
        return Err((409, "PRESENTATION_BUSY"));
    }
    if !granted(gateway, &device.device_id, "desktop.open", scope_kind, scope_id)?
        || !granted(gateway, &device.device_id, "content.read", scope_kind, scope_id)? {
        return Err((403, "SCOPE_DENIED"));
    }
    // Claim means the desktop handoff began, not that the main renderer
    // completed navigation. Preserve that uncertainty as a durable replay
    // receipt so a lost ACK cannot cause a duplicate navigation on retry.
    let receipt = json!({"opId": op_id,
        "state": if accepted { "accepted" } else { "handoffStarted" }});
    let settled = connection.execute(
        "UPDATE companion_service_operation SET stage='committed',receipt=?1,updated_at=?2
         WHERE instance_id=?3 AND device_id=?4 AND operation_id='presentation.open'
           AND op_id=?5 AND stage='pending'",
        params![receipt.to_string(), chrono::Utc::now().to_rfc3339(), instance,
            device.device_id, op_id],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if settled != 1 { return Err((503, "SERVICE_UNAVAILABLE")); }
    Ok(receipt)
}
