// Included in the existing transport tests: real loopback parser/auth/dispatch,
// synthetic Catalogs only. No production grants or user credential reads.
struct MarkdownRetryFixture {
    handle: LocalTransportHandle,
    principal: VerifiedTransportPrincipal,
    service: KnowledgeService,
    _backend: Arc<BackendServices>,
    pair: Value,
    app_data: PathBuf,
    // Drop the real services/transport before deleting their disposable files.
    _root: tempfile::TempDir,
}
impl MarkdownRetryFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path().join("app");
        fs::create_dir_all(&app_data).unwrap();
        let app_data = PathBuf::from(fs::canonicalize(&app_data).unwrap()
            .to_string_lossy().trim_start_matches(r"\\?\").to_owned());
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let service = backend.knowledge();
        let vault_root = root.path().join("vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        fs::create_dir_all(vault_root.join("Sub")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "retry-test-vault".into(), name: "Synthetic retry test".into(),
            root_path: vault_root.to_string_lossy().into_owned(), mode: "vault-bound".into(),
            created_at: "2026-10-17T00:00:00Z".into(), last_opened_at: "2026-10-17T00:00:00Z".into(),
            schema_version: 1, link_update_policy: Default::default(),
        };
        fs::write(vault_root.join(".luckyray/vault.json"), serde_json::to_vec(&vault).unwrap()).unwrap();
        service.register_current_vault(&vault).unwrap();
        let scope = service.capture_workspace_scope(&vault.id).unwrap().workspace_recovery_record().unwrap();
        let library = backend.material_catalog().library_state().unwrap().0;
        let handle = start_server(ServerConfig::test(app_data.clone()), Arc::new(LegacyLocalTransportAdapter::new(backend.clone()))).unwrap();
        let pair = handle.pair_libraries(&library, &vault.id, scope).unwrap();
        let principal = authenticate(
            &HashMap::from([("authorization".into(), format!("Bearer {}", pair["credential"].as_str().unwrap()))]),
            None, &ServerConfig::test(app_data.clone()), &handle.auth, CapabilityTier::Dangerous,
        ).unwrap();
        Self { handle, principal, service, _backend: backend, pair, app_data, _root: root }
    }
    fn input(url: &str) -> Value {
        json!({"requestId":"synthetic-stable-retry-001","url":url,"fileName":"中文 合成.md"})
    }
    fn receipt(&self, suffix: &str) -> PathBuf {
        self.app_data.join("community-mcp-receipts").join(self.pair["clientId"].as_str().unwrap())
            .join(format!("{:x}.{suffix}.json", Sha256::digest(b"synthetic-stable-retry-001")))
    }
    fn import(&self, input: Value, content: &str) -> Result<Value, String> {
        crate::community_mcp_knowledge::test_import_with_download(&self.principal, &self.service, input, |_| Ok(content.as_bytes().to_vec()))
    }
}

#[test]
fn community_markdown_retry_verifies_bytes_not_temporary_download_url() {
    let f = MarkdownRetryFixture::new();
    let (principal, service, pair, app_data) = (&f.principal, &f.service, &f.pair, &f.app_data);
    let content = "---\r\ntitle: 合成\r\n---\r\n# 内容 ✅\r\n```txt\r\n保留空行\r\n```\r\n";
    let input = |url: &str| json!({"requestId":"synthetic-stable-retry-001","url":url,"fileName":"中文 合成.md"});
    let url_a = "https://files.example.com/synthetic.md?signature=FIRST_SYNTHETIC";
    let url_b = "https://files.example.com/synthetic.md?signature=SECOND_SYNTHETIC";
    let imported = crate::community_mcp_knowledge::test_import_with_download(&principal, &service, input(url_a), |actual| {
        assert_eq!(actual, url_a, "do not strip or normalize the temporary URL");
        Ok(content.as_bytes().to_vec())
    }).unwrap();
    assert_eq!(imported["disposition"], "imported");
    let receipt_dir = app_data.join("community-mcp-receipts").join(pair["clientId"].as_str().unwrap());
    let key = format!("{:x}", Sha256::digest(b"synthetic-stable-retry-001"));
    let pending_before = fs::read(receipt_dir.join(format!("{key}.pending.json"))).unwrap();
    let complete_before = fs::read(receipt_dir.join(format!("{key}.complete.json"))).unwrap();
    let legacy: Value = serde_json::from_slice(&complete_before).unwrap();
    assert_eq!(legacy.as_object().unwrap().len(), 6, "retain the old six-field receipt format");
    assert_eq!(legacy["requestDigest"], format!("{:x}", Sha256::digest(serde_json::to_vec(&json!([url_a,"中文 合成.md",null])).unwrap())));
    let downloads = std::cell::Cell::new(0);
    let duplicate = crate::community_mcp_knowledge::test_import_with_download(&principal, &service, input(url_b), |actual| {
        downloads.set(downloads.get()+1);
        assert_eq!(actual, url_b, "new full URL must pass through the guarded downloader");
        Ok(content.as_bytes().to_vec())
    }).unwrap();
    assert_eq!(downloads.get(), 1, "verify bytes, never trust only an attachment ID");
    assert_eq!(duplicate["disposition"], "duplicate");
    assert_eq!(duplicate["noteId"], imported["noteId"]);
    assert_eq!(duplicate["vaultId"], imported["vaultId"]);
    assert_eq!(duplicate["contentSha256"], imported["contentSha256"]);
    let reference = KnowledgeService::parse_document_id(imported["noteId"].as_str().unwrap()).unwrap();
    let target = service.current_target_identity().unwrap();
    let read = service.read_document_for_target(&target, &reference).unwrap();
    assert_eq!(read.content.as_bytes(), content.as_bytes());
    assert_eq!(service.search_documents("内容",20).unwrap().len(), 1);
    assert_eq!(fs::read(receipt_dir.join(format!("{key}.pending.json"))).unwrap(), pending_before);
    assert_eq!(fs::read(receipt_dir.join(format!("{key}.complete.json"))).unwrap(), complete_before);
}

#[test]
fn community_markdown_retry_rejects_changed_bytes_or_destination_without_mutation() {
    let f = MarkdownRetryFixture::new();
    let input = MarkdownRetryFixture::input("https://files.example.com/x.md?signature=SAME");
    let content = "# immutable original\n中文 ✅\n";
    let first = f.import(input.clone(), content).unwrap();
    let pending = fs::read(f.receipt("pending")).unwrap();
    let complete = fs::read(f.receipt("complete")).unwrap();
    assert_eq!(f.import(input.clone(), "# genuinely different content\n").unwrap_err(), "request-id-conflict");
    for (key, value) in [("fileName", "other.md"), ("folder", "Sub")] {
        let mut other = input.clone();
        other[key] = json!(value);
        assert_eq!(crate::community_mcp_knowledge::test_import_with_download(&f.principal, &f.service, other, |_| {
            panic!("a different destination must fail before downloading")
        }).unwrap_err(), "request-id-conflict");
    }
    assert_eq!(f.import(input, content).unwrap()["noteId"], first["noteId"]);
    assert_eq!(f.service.search_documents("", 20).unwrap().len(), 1);
    let reference = KnowledgeService::parse_document_id(first["noteId"].as_str().unwrap()).unwrap();
    assert_eq!(f.service.read_document_for_target(&f.service.current_target_identity().unwrap(), &reference).unwrap().content, content);
    assert_eq!(fs::read(f.receipt("pending")).unwrap(), pending);
    assert_eq!(fs::read(f.receipt("complete")).unwrap(), complete);
}

#[test]
fn community_markdown_retry_pending_remains_unknown_without_network_or_rewrite() {
    let f = MarkdownRetryFixture::new();
    let path = f.receipt("pending");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = serde_json::to_vec(&json!({"requestDigest":"a".repeat(64)})).unwrap();
    fs::write(&path, &original).unwrap();
    let mut input = MarkdownRetryFixture::input("https://files.example.com/x.md?signature=ROTATED");
    input["folder"] = json!("Missing");
    assert_eq!(crate::community_mcp_knowledge::test_import_with_download(&f.principal, &f.service, input, |_| {
        panic!("never retry a pending-only unknown outcome")
    }).unwrap_err(), "import-outcome-unknown");
    assert_eq!(fs::read(path).unwrap(), original);
    assert!(!f.receipt("complete").exists());
    assert_eq!(f.service.search_documents("", 20).unwrap().len(), 0);
}

#[test]
fn community_markdown_retry_concurrent_completion_returns_original_note() {
    let f = MarkdownRetryFixture::new();
    let input = MarkdownRetryFixture::input("https://files.example.com/x.md?signature=OUTER");
    let content = "# one concurrent note\n中文\n";
    let mut inner = None;
    let duplicate = crate::community_mcp_knowledge::test_import_with_download(&f.principal, &f.service, input, |_| {
        inner = Some(f.import(MarkdownRetryFixture::input("https://files.example.com/x.md?signature=INNER"), content).unwrap());
        Ok(content.as_bytes().to_vec())
    }).unwrap();
    let imported = inner.unwrap();
    assert_eq!(imported["disposition"], "imported");
    assert_eq!(duplicate["disposition"], "duplicate");
    assert_eq!(duplicate["noteId"], imported["noteId"]);
    assert_eq!(f.service.search_documents("", 20).unwrap().len(), 1);
}

#[test]
fn community_markdown_retry_revocation_during_download_blocks_commit() {
    let f = MarkdownRetryFixture::new();
    let error = crate::community_mcp_knowledge::test_import_with_download(&f.principal, &f.service,
        MarkdownRetryFixture::input("https://files.example.com/x.md"), |_| {
            f.handle.revoke_materials(f.pair["clientId"].as_str().unwrap()).unwrap();
            Ok(b"# must not be saved\n".to_vec())
        }).unwrap_err();
    assert_eq!(error, "library-grant-invalid");
    assert!(!f.receipt("pending").exists());
    assert!(!f.receipt("complete").exists());
    assert_eq!(f.service.search_documents("", 20).unwrap().len(), 0);
}

#[test]
fn community_markdown_retry_download_failure_is_prewrite_and_does_not_seal_intent() {
    let f = MarkdownRetryFixture::new();
    let input = MarkdownRetryFixture::input("https://files.example.com/x.md");
    assert_eq!(crate::community_mcp_knowledge::test_import_with_download(&f.principal, &f.service, input.clone(), |_| {
        Err("markdown-download-failed".into())
    }).unwrap_err(), "markdown-download-failed");
    assert!(!f.receipt("pending").exists());
    assert!(!f.receipt("complete").exists());
    assert_eq!(f.import(input, "# saved once after confirmed prewrite failure\n").unwrap()["disposition"], "imported");
    assert_eq!(f.service.search_documents("", 20).unwrap().len(), 1);
}

#[test]
fn community_markdown_retry_does_not_overwrite_a_user_edited_import() {
    let f = MarkdownRetryFixture::new();
    let input = MarkdownRetryFixture::input("https://files.example.com/x.md");
    let content = "# original\n";
    let first = f.import(input.clone(), content).unwrap();
    let reference = KnowledgeService::parse_document_id(first["noteId"].as_str().unwrap()).unwrap();
    let target = f.service.current_target_identity().unwrap();
    f.service.replace_document_for_target(&target, &crate::knowledge::KnowledgeWriteInput {
        document_ref: reference.clone(), content: "# actual user edit\n".into(),
        expected_revision: Some(first["contentSha256"].as_str().unwrap().into()),
    }).unwrap();
    let complete = fs::read(f.receipt("complete")).unwrap();
    assert_eq!(f.import(input, content).unwrap_err(), "imported-note-changed");
    assert_eq!(f.service.read_document_for_target(&target, &reference).unwrap().content, "# actual user edit\n");
    assert_eq!(fs::read(f.receipt("complete")).unwrap(), complete);
}

#[test]
fn community_mcp_unified_grant_uses_formal_vault_and_revokes_both_over_tcp() {
    let root = tempfile::tempdir().unwrap();
    let app_data = root.path().join("app");
    fs::create_dir(&app_data).unwrap();
    let app_data = PathBuf::from(fs::canonicalize(&app_data).unwrap()
        .to_string_lossy().trim_start_matches(r"\\?\").to_owned());
    let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
    let service = backend.knowledge();
    let make_vault = |id: &str| {
        let path = root.path().join(id);
        fs::create_dir_all(path.join(".luckyray")).unwrap();
        let registration = KnowledgeVaultRegistration {
            id: id.into(), name: id.into(), root_path: path.to_string_lossy().into_owned(),
            mode: "vault-bound".into(), created_at: "2026-10-15T00:00:00Z".into(),
            last_opened_at: "2026-10-15T00:00:00Z".into(), schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(path.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        (path, registration)
    };
    let (vault_root, vault) = make_vault("web-bound-vault");
    let (other_root, other_vault) = make_vault("web-foreign-vault");
    let markdown = "\u{feff}---\r\ntitle: 中文\r\n---\r\n# 网页验收\r\n```js\r\nlet x=1\r\n```\r\n";
    fs::write(vault_root.join("中文参考.md"), markdown).unwrap();
    fs::write(other_root.join("foreign.md"), "foreign private note").unwrap();
    service.register_current_vault(&vault).unwrap();
    let scope = service.capture_workspace_scope(&vault.id).unwrap().workspace_recovery_record().unwrap();
    let catalog = backend.material_catalog();
    let library = catalog.library_state().unwrap().0;
    let handle = start_server(ServerConfig::test(app_data.clone()), Arc::new(LegacyLocalTransportAdapter::new(backend.clone()))).unwrap();
    let local = handle.pair_materials("Existing local MCP", &library).unwrap();
    let original_grants = fs::read(app_data.join("local-transport-materials-grants-v1.json")).unwrap();
    let pair = handle.pair_libraries(&library, &vault.id, scope).unwrap();
    let token = pair["credential"].as_str().unwrap();
    assert_eq!(original_grants, fs::read(app_data.join("local-transport-materials-grants-v1.json")).unwrap());
    let proof = materials_request(&handle, "", "POST", "/api/v1/materials/proof",
        json!({"clientId":pair["clientId"],"clientNonce":random_hex(32),"profileProofVersion":3}));
    assert_eq!(status(&proof), 200, "{proof}");
    assert_eq!(body(&proof)["data"]["protocolVersion"], 3);
    assert_eq!(body(&proof)["data"]["vaultId"], vault.id);
    let search = materials_request(&handle, token, "POST", "/api/v1/library-mcp/knowledge/search", json!({"query":"中文","limit":20}));
    assert_eq!(status(&search), 200, "{search}");
    let note_id = body(&search)["data"]["notes"][0]["noteId"].as_str().unwrap_or_else(|| panic!("formal vault search did not return the synthetic fixture: {search}")).to_owned();
    let read = materials_request(&handle, token, "POST", "/api/v1/library-mcp/knowledge/read", json!({"noteId":note_id}));
    assert_eq!(status(&read), 200, "{read}");
    assert_eq!(body(&read)["data"]["content"], markdown.trim_start_matches('\u{feff}'));
    assert_eq!(body(&read)["data"]["revision"], format!("{:x}", Sha256::digest(markdown.as_bytes())));
    let bad_extension = materials_request(&handle, token, "POST", "/api/v1/library-mcp/knowledge/import-markdown",
        json!({"requestId":"fixture-invalid-extension","url":"https://example.com/file.md","fileName":"bad.txt"}));
    assert_eq!(status(&bad_extension), 400, "{bad_extension}");
    assert_eq!(body(&bad_extension)["error"]["code"], "markdown-file-required");
    // A missing knowledge directory is a confirmed pre-write rejection, not an
    // indeterminate import. The URL is intentionally non-downloadable: reject the
    // parent before fetching or creating a durable intent, without relaxing SSRF.
    let missing_parent = materials_request(&handle, token, "POST", "/api/v1/library-mcp/knowledge/import-markdown",
        json!({"requestId":"fixture-missing-parent-001","url":"https://127.0.0.1/never-fetch.md","fileName":"目录检查.md","folder":"不存在的目录"}));
    assert_eq!(status(&missing_parent), 400, "{missing_parent}");
    assert_eq!(body(&missing_parent)["error"]["code"], "knowledge-parent-missing");
    assert!(!app_data.join("community-mcp-receipts").exists());
    assert!(!vault_root.join("不存在的目录").exists());
    // Old uncertain outcomes stay opaque even when today's parent preflight
    // would fail. Preserve intent bytes instead of deleting/reclassifying them.
    let old_id = "fixture-old-pending-parent-001";
    let receipt_dir = app_data.join("community-mcp-receipts").join(pair["clientId"].as_str().unwrap());
    fs::create_dir_all(&receipt_dir).unwrap();
    let pending_path = receipt_dir.join(format!("{:x}.pending.json", Sha256::digest(old_id.as_bytes())));
    let pending_bytes = serde_json::to_vec(&json!({"requestDigest":"a".repeat(64)})).unwrap();
    fs::write(&pending_path, &pending_bytes).unwrap();
    let old_unknown = materials_request(&handle, token, "POST", "/api/v1/library-mcp/knowledge/import-markdown",
        json!({"requestId":old_id,"url":"https://127.0.0.1/never-fetch.md","fileName":"目录检查.md","folder":"不存在的目录"}));
    assert_eq!(status(&old_unknown), 409, "{old_unknown}");
    assert_eq!(body(&old_unknown)["error"]["code"], "import-outcome-unknown");
    assert_eq!(fs::read(&pending_path).unwrap(), pending_bytes);
    // Changing the visible vault cannot retarget the grant or expose a foreign note.
    service.register_current_vault(&other_vault).unwrap();
    let search = materials_request(&handle, token, "POST", "/api/v1/library-mcp/knowledge/search", json!({"query":"中文","limit":20}));
    assert_eq!(status(&search), 200, "{search}");
    assert_eq!(body(&search)["data"]["vaultId"], vault.id);
    assert!(!search.contains("foreign private note"));
    let denied = materials_request(&handle, local["credential"].as_str().unwrap(), "POST", "/api/v1/library-mcp/knowledge/search", json!({"query":""}));
    assert_eq!(status(&denied), 403, "old materials grant must not gain knowledge access: {denied}");
    handle.revoke_materials(pair["clientId"].as_str().unwrap()).unwrap();
    for path in ["/api/v1/library-mcp/knowledge/search", "/api/v1/tools/run"] {
        let denied = materials_request(&handle, token, "POST", path, json!({"toolId":"materials.search","input":{"query":""}}));
        assert_eq!(status(&denied), 401, "revoked unified grant must fail both scopes: {denied}");
    }
    let unchanged = materials_request(&handle, local["credential"].as_str().unwrap(), "POST", "/api/v1/tools/run", json!({"toolId":"materials.search","input":{"query":"","limit":1}}));
    assert_eq!(status(&unchanged), 200, "{unchanged}");
    assert_eq!(original_grants, fs::read(app_data.join("local-transport-materials-grants-v1.json")).unwrap());
}

fn materials_request(
    handle: &LocalTransportHandle,
    token: &str,
    method: &str,
    path: &str,
    payload: Value,
) -> String {
    let body = if method == "GET" {
        String::new()
    } else {
        payload.to_string()
    };
    request(handle.port, &format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",handle.port,body.len()))
}

#[test]
fn materials_mcp_tcp_grant_reads_only_its_library_rejects_control_and_revokes() {
    let app_data = PathBuf::from(fs::canonicalize(temp_dir("materials-mcp-scoped")).unwrap()
        .to_string_lossy().trim_start_matches(r"\\?\").to_owned());
    let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
    let catalog = backend.material_catalog();
    let target_root = app_data.join("target-materials");
    fs::create_dir(&target_root).unwrap();
    let library = catalog
        .create_library("Synthetic target", &target_root, "managed")
        .unwrap();
    let target = catalog.for_library(&library.id).unwrap();
    let make_asset = |catalog: &crate::materials::MaterialCatalog, name: &str| {
        crate::materials::import_downloaded_material(
            catalog,
            crate::materials::MaterialBytesInput {
                name: name.into(),
                original_path: name.into(),
                mime_type: "application/octet-stream".into(),
                bytes: name.as_bytes().to_vec(),
                description: None,
            },
            &crate::materials::MaterialImportOptions {
                storage_mode: "managed".into(),
                ..Default::default()
            },
        )
        .unwrap()
        .asset
    };
    let allowed = make_asset(&target, "scoped.bin");
    let foreign = make_asset(&catalog, "foreign.bin");
    let handle = start_server(
        ServerConfig::test(app_data.clone()),
        Arc::new(LegacyLocalTransportAdapter::new(backend)),
    )
    .unwrap();
    let pairing = handle.pair_materials("Synthetic MCP", &library.id).unwrap();
    let token = pairing["credential"].as_str().unwrap();
    let search = materials_request(
        &handle,
        token,
        "POST",
        "/api/v1/tools/run",
        json!({"toolId":"materials.search","input":{"query":"","limit":50}}),
    );
    assert_eq!(status(&search), 200, "{search}");
    let assets = body(&search)["data"]["result"]["assets"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0]["id"], allowed.id);
    assert!(assets[0].get("originalPath").is_none());
    assert!(assets[0].get("libraryPath").is_none());
    let inspect = materials_request(
        &handle,
        token,
        "POST",
        "/api/v1/tools/run",
        json!({"toolId":"materials.inspect","input":{"assetId":foreign.id}}),
    );
    assert_eq!(status(&inspect), 403, "Catalog rejects an explicit foreign-library id: {inspect}");
    assert_eq!(body(&inspect)["error"]["code"], "material-library-scope");
    for (method, path, payload) in [
        ("GET", "/api/v1/capabilities", json!({})),
        (
            "POST",
            "/api/v1/native/bootstrap",
            json!({"extensionOrigin":EDGE_DEV_EXTENSION_ORIGIN}),
        ),
        (
            "POST",
            "/api/v1/tools/run",
            json!({"toolId":"agent.run","input":{}}),
        ),
        (
            "POST",
            "/api/v1/tools/run",
            json!({"toolId":"terminal.execute","input":{}}),
        ),
        ("POST", "/api/v1/collection", json!({})),
        (
            "POST",
            "/api/v1/material-libraries/detail",
            json!({"libraryId":library.id,"assetId":allowed.id}),
        ),
    ] {
        let response = materials_request(&handle, token, method, path, payload);
        assert_eq!(status(&response), 403, "{path}: {response}");
    }
    // Even an otherwise allowed route cannot override the server-side binding.
    let override_attempt = materials_request(
        &handle,
        token,
        "POST",
        "/api/v1/assets/import-file",
        json!({"url":"https://example.com/a.png","fileName":"a.png","libraryId":"foreign"}),
    );
    assert_eq!(status(&override_attempt), 400, "{override_attempt}");
    let grant_id = pairing["clientId"].as_str().unwrap();
    let nonce = random_hex(32);
    let proof = materials_request(
        &handle,
        "",
        "POST",
        "/api/v1/materials/proof",
        json!({"clientId":grant_id,"clientNonce":nonce}),
    );
    assert_eq!(status(&proof), 200, "{proof}");
    let payload = body(&proof)["data"].clone();
    assert_eq!(
        payload["proof"],
        derive_credential(
            token,
            &format!(
                "materials-mcp-proof\0v1\0{}\0{}\0{}\0{}\0{}\0{}",
                grant_id,
                library.id,
                pairing["expiresAt"].as_u64().unwrap(),
                handle.port,
                nonce,
                payload["serverNonce"].as_str().unwrap()
            )
        )
        .unwrap()
    );
    // v2 checks the DB-owning desktop's physical profile, then binds it and the
    // EXE into the scoped proof. Packaged clients never open the database.
    let proof2 = materials_request(&handle,"","POST","/api/v1/materials/proof",
        json!({"clientId":grant_id,"clientNonce":nonce,"profileProofVersion":2}));
    assert_eq!(status(&proof2),200,"{proof2}");
    let p2=body(&proof2)["data"].clone();
    assert_eq!(p2["protocolVersion"],2);
    assert_eq!(p2["profileRoot"],app_data.to_string_lossy().as_ref());
    assert_eq!(p2["proof"],derive_credential(token,&format!(
        "materials-mcp-proof\0v2\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
        grant_id,library.id,pairing["expiresAt"].as_u64().unwrap(),handle.port,nonce,
        p2["serverNonce"].as_str().unwrap(),p2["profileRoot"].as_str().unwrap(),p2["desktopExe"].as_str().unwrap()
    )).unwrap());
    // Restarting the transport does not rotate bindings or follow active UI state.
    let owned_token = token.to_owned();
    let owned_id = grant_id.to_owned();
    drop(handle);
    let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
    let handle = start_server(
        ServerConfig::test(app_data.clone()),
        Arc::new(LegacyLocalTransportAdapter::new(backend)),
    )
    .unwrap();
    assert_eq!(
        status(&materials_request(
            &handle,
            &owned_token,
            "GET",
            "/api/v1/folders",
            json!({})
        )),
        200
    );
    handle.revoke_materials(&owned_id).unwrap();
    assert_eq!(
        status(&materials_request(
            &handle,
            &owned_token,
            "GET",
            "/api/v1/folders",
            json!({})
        )),
        401
    );
    assert_eq!(
        status(&authorized_request(
            &handle,
            "GET",
            "/api/v1/capabilities",
            None,
            None
        )),
        200
    );
    drop(handle);
    fs::remove_dir_all(app_data).unwrap();
}

#[test]
fn materials_mcp_commit_preserves_target_names_kinds_dedupe_and_stale_grants_cannot_write() {
    use crate::assets_import_file::{classify_zip_central_directory, sniff_magic, PreparedImport};
    use crate::materials::{
        mcp_transport::{commit_prepared_import, ImportInput},
        MaterialFilter,
    };
    let app_data = temp_dir("materials-mcp-commit");
    let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
    let root = backend.material_catalog();
    let legacy = root.library_state().unwrap().0;
    let target_path = app_data.join("target");
    fs::create_dir(&target_path).unwrap();
    let library = root
        .create_library("Synthetic import", &target_path, "managed")
        .unwrap();
    let handle = start_server(
        ServerConfig::test(app_data.clone()),
        Arc::new(LegacyLocalTransportAdapter::new(backend)),
    )
    .unwrap();
    let pairing = handle
        .pair_materials("Synthetic importer", &library.id)
        .unwrap();
    let principal = authenticate(
        &HashMap::from([(
            "authorization".into(),
            format!("Bearer {}", pairing["credential"].as_str().unwrap()),
        )]),
        None,
        &ServerConfig::test(app_data.clone()),
        &handle.auth,
        CapabilityTier::Write,
    )
    .unwrap();
    let make_input = |name: &str| ImportInput {
        url: "https://example.com/synthetic".into(),
        file_name: name.into(),
        folder_id: None,
        new_folder_name: None,
    };
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("[Content_Types].xml", options).unwrap();
    zip.write_all(b"<Types/>").unwrap();
    zip.start_file("ppt/presentation.xml", options).unwrap();
    zip.write_all(b"<presentation/>").unwrap();
    let pptx = zip.finish().unwrap().into_inner();
    for (name, mime, bytes, expected_kind) in [
        ("合成图片.png", "image/png", png.into_inner(), "image"),
        (
            "合成演示.pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            pptx,
            "document",
        ),
    ] {
        let make_prepared = || PreparedImport {
            name: name.into(),
            mime: mime.into(),
            bytes: bytes.clone(),
            magic: sniff_magic(&bytes),
            ooxml: if name.ends_with("pptx") {
                Some(classify_zip_central_directory(&bytes).unwrap())
            } else {
                None
            },
        };
        // Simulates switching the UI after download but before commit.
        root.select_library(&legacy).unwrap();
        let imported =
            commit_prepared_import(&root, &principal, make_input(name), make_prepared()).unwrap();
        assert_eq!(imported["libraryId"], library.id);
        assert_eq!(imported["assetName"], name);
        assert_eq!(imported["kind"], expected_kind);
        assert_eq!(imported["disposition"], "imported");
        assert!(imported.get("asset").is_none());
        let duplicate =
            commit_prepared_import(&root, &principal, make_input(name), make_prepared()).unwrap();
        assert_eq!(duplicate["disposition"], "duplicate");
        assert_eq!(duplicate["assetId"], imported["assetId"]);
    }
    assert!(root
        .for_library(&legacy)
        .unwrap()
        .list_assets(&MaterialFilter::default())
        .unwrap()
        .is_empty());
    let target = root.for_library(&library.id).unwrap();
    let before = target.list_assets(&MaterialFilter::default()).unwrap();
    assert_eq!(before.len(), 2);
    handle
        .revoke_materials(pairing["clientId"].as_str().unwrap())
        .unwrap();
    let mut input = make_input("revoke.bin");
    input.new_folder_name = Some("must-not-create".into());
    let result = commit_prepared_import(
        &root,
        &principal,
        input,
        PreparedImport {
            name: "revoke.bin".into(),
            mime: "application/octet-stream".into(),
            bytes: b"revoked".to_vec(),
            magic: None,
            ooxml: None,
        },
    );
    assert!(
        result.is_err(),
        "principal captured before revoke must not commit after revoke"
    );
    assert_eq!(
        target
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .len(),
        before.len()
    );
    assert!(!serde_json::to_string(&target.list_folders().unwrap())
        .unwrap()
        .contains("must-not-create"));
    drop(handle);
    fs::remove_dir_all(app_data).unwrap();
}
