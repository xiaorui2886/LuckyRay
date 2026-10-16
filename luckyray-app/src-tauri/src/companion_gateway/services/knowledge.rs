use super::*;

fn domain_error((status, code): (u16, &'static str)) -> (u16, &'static str) {
    match code {
        "OP_ID_REUSED" | "REVISION_CONFLICT" | "DESKTOP_DRAFT_BUSY" => (status, code),
        "NOTE_INPUT_INVALID" | "OP_ID_INVALID" | "INVALID_QUERY" => (400, "INPUT_INVALID"),
        "NOTE_TOO_LARGE" => (413, "NOTE_TOO_LARGE"),
        "NOTE_DELETED" => (404, "ENTITY_NOT_FOUND"),
        _ => (503, "SERVICE_UNAVAILABLE"),
    }
}

fn safe_relation_target(target: &str) -> bool {
    !target.is_empty() && target.len() <= 1024 && !target.starts_with('/')
        && !target.starts_with('\\') && !target.contains(':') && !target.chars().any(char::is_control)
}

fn page_limit(query: &HashMap<String, String>) -> ServiceResult<usize> {
    let limit = query.get("limit").map(|value| value.parse::<usize>()).transpose()
        .map_err(|_| (400, "INPUT_INVALID"))?.unwrap_or(100);
    if (1..=100).contains(&limit) { Ok(limit) } else { Err((400, "INPUT_INVALID")) }
}

fn relation_page(items: Vec<Value>, query: &HashMap<String, String>, scope: &str,
    version: &str) -> ServiceResult<(Vec<Value>, Option<String>, bool)> {
    let tag = format!("{:x}", Sha256::digest(format!("{scope}:{version}:{}", serde_json::to_string(&items)
        .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?)));
    let after = query.get("after").map(String::as_str).unwrap_or("");
    let offset = if after.is_empty() { 0 } else {
        let (presented, offset) = after.split_once(':').ok_or((400, "INPUT_INVALID"))?;
        if presented != tag { return Err((410, "CURSOR_TOO_OLD")); }
        offset.parse::<usize>().map_err(|_| (400, "INPUT_INVALID"))?
    };
    if offset > items.len() { return Err((400, "INPUT_INVALID")); }
    let limit = page_limit(query)?;
    let has_more = items.len().saturating_sub(offset) > limit;
    let next = if has_more { Some(format!("{tag}:{}", offset + limit)) } else { None };
    Ok((items.into_iter().skip(offset).take(limit).collect(), next, has_more))
}

/// Called by the sole shared route assembler, after authenticated Services admission.
/// All new operations keep generation/permission fencing and existing grant authority.
pub(super) fn route(gateway: &CompanionGateway, device: &PairedDevice,
    generation: u64, admission_permission: u64, request: &HttpRequest) -> ServiceResult<Value> {
    let path = request.path.split('?').next().unwrap_or("");
    if let Some(asset) = path.strip_prefix("/v1/services/knowledge/materials/").and_then(|suffix| suffix.strip_suffix("/references")) {
        if request.method != "GET" { return Err((405, "METHOD_NOT_ALLOWED")); }
        if !valid_id(asset) { return Err((400, "INPUT_INVALID")); }
        let query = strict_query(&request.path, &["vault", "limit", "after"])?;
        let vault = query.get("vault").filter(|vault| valid_id(vault)).ok_or((400, "INPUT_INVALID"))?;
        let _transition = service_transition(gateway, device, generation, admission_permission)?;
        for (scope, key) in [("vault", vault.as_str()), ("catalog", "")] {
            if !granted(gateway, &device.device_id, "content.read", scope, key)? { return Err((403, "GRANT_REQUIRED")); }
        }
        let (target, ids) = content::notes::service_vault_note_paths(gateway, vault).map_err(domain_error)?;
        let knowledge = gateway.backend.knowledge();
        let registration = knowledge.current_vault_id().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        let snapshot = knowledge.refresh_index_for_target(&target).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if snapshot.stale { return Err((503, "SERVICE_UNAVAILABLE")); }
        let details = gateway.backend.material_catalog().attachment_details(asset).map_err(|error|
            if error.code == "not-found" { (404, "ENTITY_NOT_FOUND") } else { (503, "SERVICE_UNAVAILABLE") })?;
        let items = details.references.into_iter().filter_map(|binding| {
            if binding.vault_id != registration || !safe_relation_target(&binding.target) { return None; }
            let document = snapshot.documents.iter().find(|document| document.relative_path == binding.note_path)?;
            if !document.embeds.iter().any(|embed| embed.target == binding.target) { return None; }
            let note = ids.get(&binding.note_path)?;
            Some(json!({"noteId":note,"target":binding.target}))
        }).collect();
        let cursor_scope = cursor_tag(gateway, &device.device_id, "knowledge-material-references", vault, admission_permission)?;
        let (items, next, has_more) = relation_page(items, &query, &format!("{cursor_scope}:material:{asset}"), &snapshot.version.to_string())?;
        return knowledge.with_current_target_response_lease(&target,
            || json!({"vaultId":vault,"assetId":asset,"items":items,"nextAfter":next,"hasMore":has_more}))
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"));
    }
    if path == "/v1/services/knowledge/notes" {
        if request.method != "POST" { return Err((405, "METHOD_NOT_ALLOWED")); }
        strict_query(&request.path, &[])?;
        if request.body.len() > 4 * 1024 * 1024 + 4096 { return Err((413, "NOTE_TOO_LARGE")); }
        let payload: Value = serde_json::from_slice(&request.body).map_err(|_| (400, "INPUT_INVALID"))?;
        let vault = payload["vaultId"].as_str().filter(|value| valid_id(value)).ok_or((400, "INPUT_INVALID"))?;
        let _transition = service_transition(gateway, device, generation, admission_permission)?;
        if !granted(gateway, &device.device_id, "content.write", "vault", vault)? { return Err((403, "GRANT_REQUIRED")); }
        if current_vault(gateway)?.as_ref().map(|(id, _)| id.as_str()) != Some(vault) { return Err((503, "SERVICE_UNAVAILABLE")); }
        let legacy = HttpRequest { method: "POST".into(), path: "/v1/notes".into(), headers: request.headers.clone(), body: request.body.clone() };
        return content::notes::mutate_unique_route(gateway, &legacy).map_err(domain_error);
    }
    if let Some(vault) = path.strip_prefix("/v1/services/knowledge/vaults/").and_then(|suffix| suffix.strip_suffix("/directories")) {
        if request.method != "GET" { return Err((405, "METHOD_NOT_ALLOWED")); }
        if !valid_id(vault) { return Err((400, "INPUT_INVALID")); }
        let query = strict_query(&request.path, &["limit", "afterPath"])?;
        let limit = page_limit(&query)?;
        if query.get("afterPath").is_some_and(|path| !relative_parent(path)) { return Err((400, "INPUT_INVALID")); }
        let _transition = service_transition(gateway, device, generation, admission_permission)?;
        if !granted(gateway, &device.device_id, "content.read", "vault", vault)? { return Err((403, "GRANT_REQUIRED")); }
        let (target, current) = content::notes::target(gateway).map_err(domain_error)?;
        if current != vault { return Err((503, "SERVICE_UNAVAILABLE")); }
        let paths = gateway.backend.knowledge().companion_directories_for_target(&target).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        let paths = paths.into_iter().filter(|path| query.get("afterPath").is_none_or(|after| path > after)).take(limit + 1).collect::<Vec<_>>();
        let has_more = paths.len() > limit;
        let items = paths.into_iter().take(limit).map(|path| json!({"parentRelativePath":path})).collect::<Vec<_>>();
        let next = if has_more { items.last().map(|item| item["parentRelativePath"].clone()).unwrap_or(Value::Null) } else { Value::Null };
        return Ok(json!({"vaultId":vault,"items":items,"nextAfterPath":next,"hasMore":has_more}));
    }
    let suffix = path.strip_prefix("/v1/services/knowledge/notes/").ok_or((404, "ENTITY_NOT_FOUND"))?;
    let (note, action) = suffix.split_once('/').ok_or((404, "ENTITY_NOT_FOUND"))?;
    if !valid_id(note) || !matches!(action, "editing" | "relations") { return Err((404, "ENTITY_NOT_FOUND")); }
    let (vault, query, payload) = if action == "editing" && matches!(request.method.as_str(), "PUT" | "POST") {
        strict_query(&request.path, &[])?;
        if request.body.len() > 4096 { return Err((400, "INPUT_INVALID")); }
        let payload: Value = serde_json::from_slice(&request.body).map_err(|_| (400, "INPUT_INVALID"))?;
        let object = payload.as_object().ok_or((400, "INPUT_INVALID"))?;
        if request.method == "POST" {
            if object.len() != 1 || !object.contains_key("vaultId") { return Err((400, "INPUT_INVALID")); }
        } else if object.len() != 4 || object.keys().any(|key| !matches!(key.as_str(), "vaultId" | "sessionId" | "generation" | "editing")) { return Err((400, "INPUT_INVALID")); }
        (payload["vaultId"].as_str().ok_or((400, "INPUT_INVALID"))?.to_owned(), HashMap::new(), payload)
    } else if request.method == "GET" {
        let query = strict_query(&request.path, if action == "relations" { &["vault", "limit", "after"] } else { &["vault"] })?;
        (query.get("vault").ok_or((400, "INPUT_INVALID"))?.clone(), query, Value::Null)
    } else { return Err((405, "METHOD_NOT_ALLOWED")); };
    if !valid_id(&vault) { return Err((400, "INPUT_INVALID")); }
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    let grant = if request.method != "GET" { "content.write" } else { "content.read" };
    if !granted(gateway, &device.device_id, grant, "vault", &vault)? { return Err((403, "GRANT_REQUIRED")); }
    if current_vault(gateway)?.as_ref().map(|(id, _)| id.as_str()) != Some(&vault) { return Err((503, "SERVICE_UNAVAILABLE")); }
    let (target, reference) = content::notes::service_note_reference(gateway, &vault, note).map_err(domain_error)?;
    let knowledge = gateway.backend.knowledge();
    let result = if action == "editing" {
        let mut result = if request.method == "GET" {
            serde_json::to_value(knowledge.companion_editing_status(&target, &reference, Some(&device.device_id))
                .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        } else if request.method == "POST" {
            serde_json::to_value(knowledge.companion_open_editing(&target, &reference, &device.device_id)
                .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        } else {
            let session = payload["sessionId"].as_str().filter(|value| valid_id(value)).ok_or((400, "INPUT_INVALID"))?;
            let generation = payload["generation"].as_u64().filter(|value| *value > 0 && *value <= 9_007_199_254_740_991).ok_or((400, "INPUT_INVALID"))?;
            let editing = payload["editing"].as_bool().ok_or((400, "INPUT_INVALID"))?;
            serde_json::to_value(knowledge.companion_set_editing(&target, &reference, &device.device_id, session, generation, editing)
                .map_err(|error| if error.code == "knowledge-presence-expired" { (410, "CURSOR_TOO_OLD") } else { (503, "SERVICE_UNAVAILABLE") })?).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?
        };
        result["vaultId"] = json!(vault); result["noteId"] = json!(note);
        result
    } else {
        let (document_target, document, revision) = content::notes::service_note_context(gateway, &vault, note, request).map_err(domain_error)?;
        if document_target != target { return Err((503, "SERVICE_UNAVAILABLE")); }
        let snapshot = knowledge.refresh_index_for_target(&target).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if snapshot.stale { return Err((503, "SERVICE_UNAVAILABLE")); }
        let ids = content::notes::service_note_paths(gateway, &vault).map_err(domain_error)?;
        let current = snapshot.documents.iter().find(|item| item.relative_path == document.summary.relative_path).ok_or((404, "ENTITY_NOT_FOUND"))?;
        let mut items = Vec::new();
        for source in &snapshot.documents {
            for link in &source.wiki_links {
                if !safe_relation_target(&link.target) { continue; }
                let resolution = crate::knowledge::resolve_wiki_target(&snapshot, &source.document_ref, &link.target);
                let targets = resolution.candidates.iter().filter_map(|candidate| ids.get(&candidate.relative_path).cloned()).collect::<Vec<_>>();
                if source.relative_path == current.relative_path {
                    items.push(json!({"kind":"wikiLink","target":link.target,"line":link.line,"status":resolution.status,"noteIds":targets}));
                }
                if resolution.candidates.iter().any(|candidate| candidate.relative_path == current.relative_path) {
                    if let Some(source_id) = ids.get(&source.relative_path) { items.push(json!({"kind":"backlink","sourceNoteId":source_id,"target":link.target,"line":link.line,"status":resolution.status,"noteIds":targets})); }
                }
            }
        }
        if granted(gateway, &device.device_id, "content.read", "catalog", "")? {
            for binding in gateway.backend.material_catalog().note_attachment_refs(&document.summary.document_ref.vault_id, &document.summary.relative_path)
                .map_err(|_| (503, "SERVICE_UNAVAILABLE"))? {
                if safe_relation_target(&binding.target) && current.embeds.iter().any(|embed| embed.target == binding.target) {
                    items.push(json!({"kind":"material","assetId":binding.asset_id,"target":binding.target}));
                }
            }
        }
        let cursor_scope = cursor_tag(gateway, &device.device_id, "knowledge-relations", &vault, admission_permission)?;
        let (items, next, has_more) = relation_page(items, &query, &format!("{cursor_scope}:note:{note}"), &snapshot.version.to_string())?;
        json!({"vaultId":vault,"noteId":note,"revision":revision,"items":items,"nextAfter":next,"hasMore":has_more})
    };
    knowledge.with_current_target_response_lease(&target, || result).map_err(|_| (503, "SERVICE_UNAVAILABLE"))
}

fn relative_parent(path: &str) -> bool {
    path.len() <= 1024 && !path.starts_with('/') && !path.contains('\\')
        && !path.chars().any(char::is_control) && !path.contains(':')
        && !path.split('/').any(|segment| matches!(segment, "." | ".."))
}

#[cfg(test)]
mod live_sync_tests {
    use super::*;
    use crate::knowledge::KnowledgeVaultRegistration;

    #[derive(Default)]
    struct MemoryIdentity(Mutex<Option<Vec<u8>>>);
    impl ProtectedIdentityStore for MemoryIdentity {
        fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, GatewayError> { Ok(self.0.lock().unwrap().clone().map(Zeroizing::new)) }
        fn store(&self, bytes: &[u8]) -> Result<(), GatewayError> { *self.0.lock().unwrap() = Some(bytes.to_vec()); Ok(()) }
        fn remove(&self) -> Result<(), GatewayError> { *self.0.lock().unwrap() = None; Ok(()) }
    }

    #[test]
    fn production_knowledge_routes_create_presence_directory_relations_and_revoke() {
        let root = tempfile::tempdir().unwrap();
        let vault_root = root.path().join("vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        fs::create_dir_all(vault_root.join("empty/nested")).unwrap();
        let registration = KnowledgeVaultRegistration { id: "live-sync-vault".into(), name: "Synthetic Vault".into(),
            root_path: vault_root.to_string_lossy().into(), mode: "vault-bound".into(), created_at: "2026-09-30T00:00:00Z".into(),
            last_opened_at: "2026-09-30T00:00:00Z".into(), schema_version: 1, link_update_policy: Default::default() };
        fs::write(vault_root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        let backend = Arc::new(BackendServices::initialize(&root.path().join("app")).unwrap());
        backend.knowledge().register_current_vault(&registration).unwrap();
        let gateway = CompanionGateway::initialize_with_store(backend.clone(), Arc::new(MemoryIdentity::default()), GatewayPolicy::default());
        gateway.start("127.0.0.1", Some(0)).unwrap();
        let generation = gateway.lifecycle.lock().unwrap().running.as_ref().unwrap().generation;
        let envelope = gateway.issue_pairing().unwrap();
        let pairing = gateway.exchange_pairing(&serde_json::to_vec(&json!({"secret":envelope.secret,"fingerprint":envelope.certificate_fingerprint,"deviceLabel":"Knowledge synthetic test"})).unwrap(), generation).unwrap();
        let credential = pairing["credential"].as_str().unwrap();
        let device_id = pairing["deviceId"].as_str().unwrap();
        let (_, vault) = content::notes::target(&gateway).unwrap();
        for grant in ["content.read", "content.write"] { gateway.set_service_grant(device_id, grant, "vault", &vault, true).unwrap(); }
        let make = |method: &str, path: &str, payload: Value| HttpRequest { method: method.into(), path:path.into(),
            headers:HashMap::from([("authorization".into(),format!("Bearer {credential}"))]), body: serde_json::to_vec(&payload).unwrap() };
        let send = |request: &HttpRequest| {
            let device = gateway.authenticate_request(request).unwrap();
            route(&gateway, &device, generation, permission_revision(&gateway, device_id).unwrap(), request)
        };
        let create = |id: &str, title: &str, text: &str| send(&make("POST", "/v1/services/knowledge/notes", json!({"opId":format!("create-{id}"),"noteId":id,"kind":"create","vaultId":vault,"title":title,"content":text,"expectedRevision":""}))).unwrap();
        let target = create("kn-target", "Target", "target body");
        let source = create("kn-source", "Source", "[[Target]]\n[[Missing]]\n");
        let copied = create("kn-copy", "Target", "other body");
        assert_eq!(copied["document"]["relativePath"], "Target（副本）.md");
        let fixture: Value = serde_json::from_str(include_str!("../../../../tests/fixtures/knowledgeLiveSync.consumer.json")).unwrap();
        for case in fixture["readCases"].as_array().unwrap() {
            let path = case["path"].as_str().unwrap().replace("{vault}", &vault);
            let result = send(&make(case["method"].as_str().unwrap(), &path, Value::Null));
            if let Some(code) = case["errorCode"].as_str() {
                assert_eq!(result.unwrap_err(), (case["status"].as_u64().unwrap() as u16, code), "{}", case["name"]);
            } else {
                let value = result.unwrap();
                for (key, expected) in case["expected"].as_object().unwrap() { assert_eq!(&value[key], expected, "{}", case["name"]); }
            }
        }
        let editing_path = "/v1/services/knowledge/notes/kn-target/editing";
        let reading_path = format!("{editing_path}?vault={vault}");
        assert_eq!(send(&make("GET", &reading_path, Value::Null)).unwrap()["desktopEditing"], false);
        let activation = backend.knowledge().activate_ui_source(&registration.id).unwrap();
        backend.knowledge().companion_set_desktop_drafts(activation.source_epoch, 1, vec!["Target.md".into()]).unwrap();
        assert_eq!(send(&make("GET", &reading_path, Value::Null)).unwrap()["desktopEditing"], true);
        let mut open_request = fixture["editingOpenRequest"].clone();
        open_request["vaultId"] = json!(vault);
        let opened = send(&make("POST", editing_path, open_request)).unwrap();
        for (key, expected) in fixture["editingOpenExpected"].as_object().unwrap() { assert_eq!(&opened[key], expected); }
        let session = opened["sessionId"].as_str().unwrap();
        let lease = |session: &str, generation, editing| make("PUT", editing_path, json!({"vaultId":vault,"sessionId":session,"generation":generation,"editing":editing}));
        for name in ["editingSetRequest", "releaseRequest"] {
            let mut request = fixture[name].clone(); request["vaultId"] = json!(vault); request["sessionId"] = json!(session);
            assert_eq!(send(&make("PUT", editing_path, request.clone())).unwrap()["editing"], request["editing"]);
        }
        assert_eq!(send(&lease(session,2,true)).unwrap_err(), (410,"CURSOR_TOO_OLD"));
        assert_eq!(send(&make("GET", &reading_path, Value::Null)).unwrap()["mobileEditing"], false);
        let update = make("PATCH", "/v1/notes/kn-target", json!({"opId":"target-update","noteId":"kn-target","vaultId":vault,"kind":"update",
            "expectedRevision":target["document"]["revision"],"content":"updated target"}));
        assert_eq!(content::notes::mutate_route(&gateway, &update).unwrap_err(), (503,"DESKTOP_DRAFT_BUSY"));
        assert_eq!(fs::read_to_string(vault_root.join("Target.md")).unwrap(), "target body", "busy draft veto preserves original bytes");
        backend.knowledge().companion_set_desktop_drafts(activation.source_epoch, 2, vec![]).unwrap();
        let fresh = send(&make("POST", editing_path, json!({"vaultId":vault}))).unwrap();
        assert_eq!(send(&lease(fresh["sessionId"].as_str().unwrap(),1,true)).unwrap()["editing"], true);
        let checkpoint_before = backend.knowledge().companion_committed_checkpoint_from_ui(activation.source_epoch, &registration.id).unwrap().checkpoint;
        assert!(content::notes::mutate_route(&gateway, &update).is_ok(), "presence is not a write lock");
        let checkpoint_after = backend.knowledge().companion_committed_checkpoint_from_ui(activation.source_epoch, &registration.id).unwrap().checkpoint;
        assert_ne!(checkpoint_before, checkpoint_after, "real durable Content mutation advances wake marker without any native listener");
        content::notes::mutate_route(&gateway, &update).unwrap();
        assert_eq!(checkpoint_after, backend.knowledge().companion_committed_checkpoint_from_ui(activation.source_epoch, &registration.id).unwrap().checkpoint, "durable receipt replay is not another commit");
        let native_target = backend.knowledge().current_target_identity().unwrap();
        let native_read = backend.knowledge().read_document_for_target(&native_target, &crate::knowledge::KnowledgeDocumentRef {
            vault_id:registration.id.clone(), relative_path:"Target.md".into(),
        }).unwrap();
        assert_eq!(native_read.content, "updated target", "desktop domain sees the committed phone save, not a copied sync body");
        let directories = send(&make("GET", &format!("/v1/services/knowledge/vaults/{vault}/directories?limit=1"), Value::Null)).unwrap();
        assert_eq!(directories["items"][0]["parentRelativePath"], "");
        assert_eq!(directories["nextAfterPath"], "");
        let more = send(&make("GET", &format!("/v1/services/knowledge/vaults/{vault}/directories?limit=100&afterPath="), Value::Null)).unwrap();
        assert_eq!(more["items"].as_array().unwrap().len(), 2);
        let relation_path = format!("/v1/services/knowledge/notes/kn-source/relations?vault={vault}&limit=1");
        let first = send(&make("GET", &relation_path, Value::Null)).unwrap();
        assert_eq!(first["items"][0]["kind"], "wikiLink");
        assert_eq!(first["items"][0]["noteIds"][0], "kn-target");
        let after = first["nextAfter"].as_str().unwrap();
        let second = send(&make("GET", &format!("{relation_path}&after={after}"), Value::Null)).unwrap();
        assert_eq!(second["items"][0]["status"], "unresolved");
        let backlinks = send(&make("GET", &format!("/v1/services/knowledge/notes/kn-target/relations?vault={vault}"), Value::Null)).unwrap();
        assert_eq!(backlinks["items"][0]["sourceNoteId"], "kn-source");
        let attachment = vault_root.join("linked.png");
        fs::write(&attachment, b"synthetic attachment").unwrap();
        let asset = backend.material_catalog().register_note_attachment(&attachment, &registration.id, None).unwrap();
        backend.material_catalog().replace_note_attachment_refs(&registration.id, "Source.md", &[
            crate::materials::NoteAttachmentRefInput { asset_id:asset.id.clone(), target:"linked.png".into() },
            crate::materials::NoteAttachmentRefInput { asset_id:asset.id.clone(), target:"stale.png".into() },
        ]).unwrap();
        // Catalog bindings alone do not invent live Markdown references.
        let material_path = format!("/v1/services/knowledge/materials/{}/references?vault={vault}", asset.id);
        assert_eq!(send(&make("GET", &material_path, Value::Null)).unwrap_err(), (403,"GRANT_REQUIRED"));
        gateway.set_service_grant(device_id, "content.read", "catalog", "", true).unwrap();
        assert!(send(&make("GET", &material_path, Value::Null)).unwrap()["items"].as_array().unwrap().is_empty());
        assert_eq!(send(&make("GET", &format!("{relation_path}&after={after}"), Value::Null)).unwrap_err(), (410,"CURSOR_TOO_OLD"), "even unchanged items cannot reuse a retired permission namespace");
        let fresh_page = send(&make("GET", &relation_path, Value::Null)).unwrap();
        let after = fresh_page["nextAfter"].as_str().unwrap();
        let changed = make("PATCH", "/v1/notes/kn-source", json!({"opId":"source-update","noteId":"kn-source","vaultId":vault,"kind":"update",
            "expectedRevision":source["document"]["revision"],"content":"[[Target]]\n![linked](linked.png)\n"}));
        content::notes::mutate_route(&gateway, &changed).unwrap();
        assert_eq!(send(&make("GET", &format!("{relation_path}&after={after}"), Value::Null)).unwrap_err(), (410,"CURSOR_TOO_OLD"));
        let reverse = send(&make("GET", &material_path, Value::Null)).unwrap();
        assert_eq!(reverse["items"], json!([{"noteId":"kn-source","target":"linked.png"}]));
        assert!(!reverse.to_string().contains("absolute"));
        let forward = send(&make("GET", &format!("/v1/services/knowledge/notes/kn-source/relations?vault={vault}"), Value::Null)).unwrap();
        assert_eq!(forward["items"].as_array().unwrap().iter().filter(|item| item["kind"] == "material").collect::<Vec<_>>(),
            vec![&json!({"kind":"material","assetId":asset.id,"target":"linked.png"})]);
        assert_eq!(send(&make("GET", &format!("{material_path}&limit=0"), Value::Null)).unwrap_err(), (400,"INPUT_INVALID"));
        assert_eq!(send(&make("GET", &format!("{material_path}&unexpected=1"), Value::Null)).unwrap_err(), (400,"INPUT_INVALID"));
        let request = make("GET", &reading_path, Value::Null);
        let device = gateway.authenticate_request(&request).unwrap();
        let admitted = permission_revision(&gateway, device_id).unwrap();
        gateway.set_service_grant(device_id, "content.read", "vault", &vault, false).unwrap();
        assert_eq!(route(&gateway, &device, generation, admitted, &request).unwrap_err(), (403,"SCOPE_DENIED"));
        assert_eq!(send(&request).unwrap_err(), (403,"GRANT_REQUIRED"));
        gateway.stop().unwrap();
    }
}

pub(super) fn move_note(
    gateway: &CompanionGateway, device: &PairedDevice, generation: u64,
    admission_permission: u64, note_id: &str,
    body: &[u8], request: &HttpRequest,
) -> ServiceResult<Value> {
    if !valid_id(note_id) || body.len() > 4096 { return Err((400, "INPUT_INVALID")); }
    let (payload, hash) = canonical_body(body)?;
    let obj = payload.as_object().ok_or((400, "INPUT_INVALID"))?;
    if obj.len() != 4 || obj.keys().any(|key| !matches!(key.as_str(),
        "opId" | "vaultId" | "expectedRevision" | "parentRelativePath")) {
        return Err((400, "INPUT_INVALID"));
    }
    let op_id = payload["opId"].as_str().filter(|id| valid_id(id)).ok_or((400, "INPUT_INVALID"))?;
    let vault_id = payload["vaultId"].as_str().filter(|id| valid_id(id)).ok_or((400, "INPUT_INVALID"))?;
    let expected = payload["expectedRevision"].as_str().filter(|v| !v.is_empty() && v.len() <= 160)
        .ok_or((400, "INPUT_INVALID"))?;
    let parent = payload["parentRelativePath"].as_str().filter(|path| relative_parent(path))
        .ok_or((400, "INPUT_INVALID"))?;
    let _transition = service_transition(gateway, device, generation, admission_permission)?;
    if !granted(gateway, &device.device_id, "content.write", "vault", vault_id)? {
        return Err((403, "GRANT_REQUIRED"));
    }
    if current_vault(gateway)?.as_ref().map(|(id, _)| id.as_str()) != Some(vault_id) {
        return Err((503, "SERVICE_UNAVAILABLE"));
    }
    let instance = gateway.identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?.instance_id.clone();
    let target_key = format!("{vault_id}:{note_id}");
    let connection = database(gateway)?;
    let existing: Option<(String, String, String, Option<String>)> = connection.query_row(
        "SELECT target_key,payload_sha256,stage,receipt FROM companion_service_operation
         WHERE instance_id=?1 AND device_id=?2 AND operation_id='knowledge.move' AND op_id=?3",
        params![instance, device.device_id, op_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    if let Some((stored_target, stored_hash, stage, stored_receipt)) = existing {
        if stored_target != target_key || stored_hash != hash { return Err((409, "OP_ID_REUSED")); }
        if stage == "committed" {
            return stored_receipt.as_deref().and_then(|text| serde_json::from_str(text).ok())
                .ok_or((503, "SERVICE_UNAVAILABLE"));
        }
        if stage != "pending" { return Err((410, "RECEIPT_EXPIRED")); }
        let intent: Value = stored_receipt.as_deref().and_then(|text| serde_json::from_str(text).ok())
            .ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let planned = intent["plannedPath"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let before_path = intent["beforePath"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let after_file = intent["expectedAfterFileRevision"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let registration_id = intent["registrationId"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
        let knowledge = gateway.backend.knowledge();
        let target = knowledge.current_target_identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        let original_ref = crate::knowledge::KnowledgeDocumentRef {
            vault_id: registration_id.to_owned(), relative_path: before_path.to_owned(),
        };
        match knowledge.read_document_for_target(&target, &original_ref) {
            Err(error) if error.code == "knowledge-not-found" => {}
            _ => return Err((503, "SERVICE_UNAVAILABLE")),
        }
        let moved_ref = crate::knowledge::KnowledgeDocumentRef {
            vault_id: registration_id.to_owned(), relative_path: planned.to_owned(),
        };
        let observed = knowledge.read_document_for_target(&target, &moved_ref)
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        if observed.revision != after_file { return Err((503, "SERVICE_UNAVAILABLE")); }
        let revision = content::remap_moved_note_for_service(gateway, vault_id, note_id, planned, &observed.revision)
            .map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        let receipt = json!({"opId": op_id, "vaultId": vault_id, "noteId": note_id,
            "revision": revision, "parentRelativePath": parent});
        connection.execute(
            "UPDATE companion_service_operation SET stage='committed',receipt=?1,updated_at=?2
             WHERE instance_id=?3 AND device_id=?4 AND operation_id='knowledge.move' AND op_id=?5 AND stage='pending'",
            params![receipt.to_string(), chrono::Utc::now().to_rfc3339(), instance, device.device_id, op_id],
        ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        return Ok(receipt);
    }
    let legacy = HttpRequest { method: "GET".to_owned(),
        path: format!("/v1/notes/{note_id}?vault={vault_id}"),
        headers: request.headers.clone(), body: Vec::new() };
    let detail = content::read_notes_for_service(gateway, &legacy)
        .map_err(|(status, _)| if status == 404 { (404, "ENTITY_NOT_FOUND") } else { (503, "SERVICE_UNAVAILABLE") })?;
    if detail["revision"] != expected { return Err((409, "REVISION_CONFLICT")); }
    let relative_path = detail["relativePath"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
    let title = detail["title"].as_str().ok_or((503, "SERVICE_UNAVAILABLE"))?;
    let knowledge = gateway.backend.knowledge();
    let target = knowledge.current_target_identity().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let document_ref = crate::knowledge::KnowledgeDocumentRef {
        vault_id: knowledge.current_vault_id().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?,
        relative_path: relative_path.to_owned(),
    };
    let snapshot = knowledge.read_document_for_target(&target, &document_ref)
        .map_err(|_| (409, "REVISION_CONFLICT"))?;
    let observed = format!("{:x}", Sha256::digest(format!("{}:{}{}",
        relative_path.len(), relative_path, snapshot.revision)));
    if observed != expected { return Err((409, "REVISION_CONFLICT")); }
    let file_name = crate::knowledge::companion_note_name(title)
        .map_err(|_| (400, "INPUT_INVALID"))?;
    let planned_path = if parent.is_empty() { file_name.clone() }
        else { format!("{parent}/{file_name}") };
    if planned_path == relative_path {
        let receipt = json!({"opId": op_id, "vaultId": vault_id, "noteId": note_id,
            "revision": expected, "parentRelativePath": parent});
        record_operation(&connection, &instance, &device.device_id,
            "knowledge.move", op_id, &target_key, &hash, &receipt)?;
        return Ok(receipt);
    }
    let planned_ref = crate::knowledge::KnowledgeDocumentRef {
        vault_id: document_ref.vault_id.clone(), relative_path: planned_path.clone(),
    };
    match knowledge.read_document_for_target(&target, &planned_ref) {
        Ok(_) => return Err((409, "REVISION_CONFLICT")),
        Err(error) if error.code == "knowledge-not-found" => {}
        Err(_) => return Err((503, "SERVICE_UNAVAILABLE")),
    }
    let move_input = crate::knowledge::KnowledgeMoveInput {
        document_ref: document_ref.clone(), title: title.to_owned(),
        expected_revision: snapshot.revision.clone(), parent_relative_path: Some(parent.to_owned()),
    };
    let expected_after = knowledge.companion_expected_move_revision_for_target(
        &target, &move_input, &planned_path,
    ).map_err(|error| match error.code {
        "knowledge-revision-conflict" | "knowledge-name-conflict" => (409, "REVISION_CONFLICT"),
        _ => (503, "SERVICE_UNAVAILABLE"),
    })?;
    let intent = json!({"plannedPath": planned_path, "beforePath": relative_path,
        "beforeFileRevision": snapshot.revision, "expectedAfterFileRevision": expected_after,
        "registrationId": document_ref.vault_id});
    connection.execute(
        "INSERT INTO companion_service_operation(instance_id,device_id,operation_id,op_id,
            target_key,payload_sha256,stage,receipt,created_at,updated_at)
         VALUES(?1,?2,'knowledge.move',?3,?4,?5,'pending',?6,?7,?7)",
        params![instance, device.device_id, op_id, target_key, hash, intent.to_string(),
            chrono::Utc::now().to_rfc3339()],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let moved = knowledge.with_companion_draft_guard(&document_ref, ||
        knowledge.move_document_for_target(&target, &move_input));
    let moved = match moved {
        Ok(moved) => moved,
        Err(error) => {
            if matches!(error.code, "knowledge-desktop-draft-busy" | "knowledge-revision-conflict" | "knowledge-name-conflict") {
                let _ = connection.execute(
                    "DELETE FROM companion_service_operation WHERE instance_id=?1 AND device_id=?2
                     AND operation_id='knowledge.move' AND op_id=?3 AND stage='pending'",
                    params![instance, device.device_id, op_id],
                );
            }
            return Err(match error.code {
                "knowledge-desktop-draft-busy" => (503, "DESKTOP_DRAFT_BUSY"),
                "knowledge-revision-conflict" | "knowledge-name-conflict" => (409, "REVISION_CONFLICT"),
                _ => (503, "SERVICE_UNAVAILABLE"),
            });
        }
    };
    let new_path = moved.summary.relative_path;
    let revision = content::remap_moved_note_for_service(
        gateway, vault_id, note_id, &new_path, &moved.revision,
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    let receipt = json!({"opId": op_id, "vaultId": vault_id, "noteId": note_id,
        "revision": revision, "parentRelativePath": parent});
    connection.execute(
        "UPDATE companion_service_operation SET stage='committed',receipt=?1,updated_at=?2
         WHERE instance_id=?3 AND device_id=?4 AND operation_id='knowledge.move' AND op_id=?5 AND stage='pending'",
        params![receipt.to_string(), chrono::Utc::now().to_rfc3339(), instance, device.device_id, op_id],
    ).map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
    Ok(receipt)
}
