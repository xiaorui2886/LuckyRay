//! Native end-to-end authority regressions. Run on the supported Windows target.
use super::*;

#[derive(Default)]
struct MemoryStore(Mutex<Option<Vec<u8>>>);
impl ProtectedIdentityStore for MemoryStore {
    fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>,GatewayError> { Ok(self.0.lock().unwrap().clone().map(Zeroizing::new)) }
    fn store(&self,value:&[u8])->Result<(),GatewayError>{*self.0.lock().unwrap()=Some(value.to_vec());Ok(())}
    fn remove(&self)->Result<(),GatewayError>{*self.0.lock().unwrap()=None;Ok(())}
}
struct Fixture { root: tempfile::TempDir, gateway:Arc<CompanionGateway>, device:PairedDevice, headers:HashMap<String,String>, generation:u64 }
impl Fixture {
    fn new() -> Self {
        let root=tempfile::tempdir().unwrap();
        let backend=Arc::new(BackendServices::initialize(root.path()).unwrap());
        let gateway=CompanionGateway::initialize_with_store(backend,Arc::new(MemoryStore::default()),GatewayPolicy::default());
        gateway.start("127.0.0.1",Some(0)).unwrap();
        let generation=gateway.generation.load(Ordering::SeqCst);
        let envelope=gateway.issue_pairing_authorized(AuthorizationMode::Trusted).unwrap();
        let pair=gateway.exchange_pairing(&serde_json::to_vec(&json!({"secret":envelope.secret,"fingerprint":envelope.certificate_fingerprint,"deviceLabel":"Scope regression"})).unwrap(),generation).unwrap();
        let headers=HashMap::from([("authorization".into(),format!("Bearer {}",pair["credential"].as_str().unwrap()))]);
        let device=gateway.authenticate_request(&HttpRequest{method:"GET".into(),path:"/v1/services".into(),headers:headers.clone(),body:vec![]}).unwrap();
        Self{root,gateway,device,headers,generation}
    }
    fn request(&self,method:&str,path:&str,body:Value,material:Option<&str>,vault:Option<&str>) -> HttpRequest {
        let mut headers=self.headers.clone();
        if let Some(id)=material {headers.insert("x-luckyray-material-library".into(),id.into());}
        if let Some(id)=vault {headers.insert("x-luckyray-knowledge-vault".into(),id.into());}
        HttpRequest{method:method.into(),path:path.into(),headers,body:serde_json::to_vec(&body).unwrap()}
    }
    fn call(&self,request:HttpRequest)->(u16,Value){
        self.gateway.authenticate_request(&request).unwrap();
        let mut bytes=vec![];
        if services::is_service_route(&request.path){ services::serve(&self.gateway,&request,&mut bytes,&self.device,self.generation).unwrap(); }
        else {content::serve(&self.gateway,&request,&mut bytes,&AtomicBool::new(false)).unwrap();}
        let split=bytes.windows(4).position(|s|s==b"\r\n\r\n").unwrap();
        let status=std::str::from_utf8(&bytes[..split]).unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        (status,serde_json::from_slice(&bytes[split+4..]).unwrap())
    }
}
impl Drop for Fixture {fn drop(&mut self){let _=self.gateway.stop();}}

#[test]
fn original_file_mime_uses_persisted_format_and_keeps_scoped_range_reads() {
    let f = Fixture::new();
    let catalog = f.gateway.backend.material_catalog();
    let root = f.root.path().join("mime-library");
    fs::create_dir(&root).unwrap();
    let library = catalog.create_library("MIME fixture", &root, "managed").unwrap();
    let scoped = catalog.for_library(&library.id).unwrap();
    let db = Connection::open(f.gateway.backend.db_path()).unwrap();
    let response = |request: HttpRequest| {
        let mut bytes = vec![];
        content::serve(&f.gateway, &request, &mut bytes, &AtomicBool::new(false)).unwrap();
        let split = bytes.windows(4).position(|s| s == b"\r\n\r\n").unwrap();
        (String::from_utf8(bytes[..split].to_vec()).unwrap(), bytes[split + 4..].to_vec())
    };
    for (file_name, display_name, stored_mime, expected) in [
        ("normal.png", "normal.png", "image/png", "image/png"),
        ("generated.png", "Generated picture", "image/png", "image/png"),
        ("renamed.png", "Misleading.mp4", "IMAGE/PNG", "image/png"),
        ("normal.mp4", "normal.mp4", "video/mp4", "video/mp4"),
        ("generated.mp4", "Generated movie", "video/mp4", "video/mp4"),
        ("old.mp4", "Legacy movie", "", "video/mp4"),
        ("old.png", "Legacy picture", "application/octet-stream", "image/png"),
        ("generated.mp3", "Generated sound", "audio/mpeg", "audio/mpeg"),
        ("unknown.bin", "Unrecognized", "application/octet-stream", "application/octet-stream"),
        ("untrusted.bin", "Misleading.png", "text/html\r\nX-Injected: yes", "application/octet-stream"),
    ] {
        // The payload tests the real file/HTTP contract, not decoding validity.
        let payload = format!("synthetic-resource-{file_name}").into_bytes();
        let asset = scoped.import_bytes(vec![crate::materials::MaterialBytesInput {
            name: file_name.into(), original_path: "https://example.test/synthetic".into(),
            mime_type: "application/octet-stream".into(), bytes: payload.clone(), description: None,
        }], &crate::materials::MaterialImportOptions::default()).unwrap().value.assets.remove(0);
        db.execute("UPDATE asset SET name=?1,mime_type=?2 WHERE id=?3", params![display_name, stored_mime, asset.id]).unwrap();
        let route = format!("/v1/assets/{}/file", asset.id);
        let request = || f.request("GET", &route, Value::Null, Some(&library.id), None);
        let (headers, body) = response(request());
        assert!(headers.starts_with("HTTP/1.1 200"), "{headers}");
        assert!(headers.lines().any(|line| line == format!("Content-Type: {expected}")), "{file_name}: {headers}");
        assert!(!headers.contains("X-Injected"));
        assert!(headers.contains("X-Content-Type-Options: nosniff"));
        assert_eq!(body, payload);
        let etag = headers.lines().find_map(|line| line.strip_prefix("ETag: ")).unwrap();
        let mut range = request(); range.headers.insert("range".into(), "bytes=2-8".into());
        let (headers, body) = response(range);
        assert!(headers.starts_with("HTTP/1.1 206"));
        assert!(headers.lines().any(|line| line == format!("Content-Type: {expected}")));
        assert_eq!(body, payload[2..=8]);
        // Older clients may revalidate the pre-fix octet-stream response. Its
        // old format-only ETag must not preserve the wrong cached media type.
        let (record, file) = scoped.companion_resource(&asset.id, false).unwrap();
        let metadata = file.metadata().unwrap();
        let old_etag = format!("\"{:x}\"", Sha256::digest(format!("{}:{}:{}:{}", asset.id,
            record.updated_at, metadata.len(), metadata.modified().unwrap()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        let mut old_cached = request(); old_cached.headers.insert("if-none-match".into(), old_etag);
        assert!(response(old_cached).0.starts_with("HTTP/1.1 200"), "Revalidate a pre-fix cached response");
        let mut cached = request(); cached.headers.insert("if-none-match".into(), etag.into());
        assert!(response(cached).0.starts_with("HTTP/1.1 304"));
        assert!(response(f.request("GET", &route, Value::Null, None, None)).0.starts_with("HTTP/1.1 404"), "No fallback to a different library");
    }
    f.gateway.revoke_device(&f.device.device_id).unwrap();
    let request = f.request("GET", "/v1/assets/unknown/file", Value::Null, Some(&library.id), None);
    assert!(response(request).0.starts_with("HTTP/1.1 401"));
}

#[test]
fn file_text_preview_keeps_saved_scope_and_rechecks_device_authority() {
    let f = Fixture::new();
    let catalog = f.gateway.backend.material_catalog();
    let active = catalog.library_state().unwrap().1;
    let root = f.root.path().join("preview-selected");
    fs::create_dir(&root).unwrap();
    let library = catalog.create_library("Preview selected", &root, "managed").unwrap();
    let scoped = catalog.for_library(&library.id).unwrap();
    let asset = scoped.import_bytes(vec![crate::materials::MaterialBytesInput {
        name: "preview.txt".into(), original_path: "https://example.test/synthetic".into(),
        mime_type: "text/plain".into(), bytes: "合成预览".repeat(1800).into_bytes(), description: None,
    }], &crate::materials::MaterialImportOptions::default()).unwrap().value.assets.remove(0);
    let route = format!("/v1/assets/{}/preview", asset.id);
    let request = || f.request("GET", &route, Value::Null, Some(&library.id), None);
    let (status, value) = f.call(request());
    assert_eq!(status, 200, "{value}");
    assert_eq!(value.as_object().unwrap().len(), 3);
    assert_eq!(value["kind"], "text");
    assert_eq!(value["text"].as_str().unwrap().chars().count(), 600);
    assert_eq!(value["truncated"], true);
    assert_eq!(f.call(f.request("GET", &route, Value::Null, None, None)).0, 404);
    assert_eq!(catalog.library_state().unwrap().1, active);

    let response = |request: HttpRequest| {
        let mut bytes = vec![];
        content::serve(&f.gateway, &request, &mut bytes, &AtomicBool::new(false)).unwrap();
        let split = bytes.windows(4).position(|s| s == b"\r\n\r\n").unwrap();
        let status: u16 = std::str::from_utf8(&bytes[..split]).unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_slice::<Value>(&bytes[split + 4..]).unwrap())
    };
    let mut anonymous = request(); anonymous.headers.remove("authorization");
    assert_eq!(response(anonymous), (401, json!({"code":"PAIRING_REQUIRED"})));
    let db = open_connection(f.gateway.backend.db_path()).unwrap();
    db.execute("UPDATE companion_device SET revoked_at='2026-10-30T00:00:00Z' WHERE device_id=?1", [&f.device.device_id]).unwrap();
    assert_eq!(response(request()), (401, json!({"code":"AUTH_REVOKED"})));
}

#[test]
fn file_thumbnail_preserves_png_etag_and_unavailable_format_contract() {
    let f = Fixture::new();
    let catalog = f.gateway.backend.material_catalog();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(768, 384).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let import = |name: &str, mime: &str, bytes: Vec<u8>| catalog.import_bytes(vec![crate::materials::MaterialBytesInput {
        name: name.into(), original_path: "https://example.test/synthetic".into(),
        mime_type: mime.into(), bytes, description: None,
    }], &crate::materials::MaterialImportOptions::default()).unwrap().value.assets.remove(0);
    let asset = import("preview.png", "image/png", png.into_inner());
    let route = format!("/v1/assets/{}/thumbnail", asset.id);
    let response = |request: HttpRequest| {
        let mut bytes = vec![];
        content::serve(&f.gateway, &request, &mut bytes, &AtomicBool::new(false)).unwrap();
        let split = bytes.windows(4).position(|s| s == b"\r\n\r\n").unwrap();
        (String::from_utf8(bytes[..split].to_vec()).unwrap(), bytes[split + 4..].to_vec())
    };
    let (headers, body) = response(f.request("GET", &route, Value::Null, None, None));
    assert!(headers.starts_with("HTTP/1.1 200"));
    assert!(headers.contains("Content-Type: image/png"));
    let decoded = image::load_from_memory(&body).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (384, 192));
    let etag = headers.lines().find_map(|line| line.strip_prefix("ETag: ")).unwrap();
    let mut cached = f.request("GET", &route, Value::Null, None, None);
    cached.headers.insert("if-none-match".into(), etag.into());
    let (headers, body) = response(cached);
    assert!(headers.starts_with("HTTP/1.1 304")); assert!(body.is_empty());
    let unsupported = import("archive.zip", "application/zip", b"synthetic original".to_vec());
    let (status, value) = f.call(f.request("GET", &format!("/v1/assets/{}/thumbnail", unsupported.id), Value::Null, None, None));
    assert_eq!((status, value), (404, json!({"code":"PREVIEW_UNAVAILABLE"})));
}

#[test]
fn saved_material_http_mutation_ingest_and_op_ids_stay_in_selected_scope(){
    let f=Fixture::new();let catalog=f.gateway.backend.material_catalog();let active=catalog.library_state().unwrap().1;
    let root=f.root.path().join("second");fs::create_dir(&root).unwrap();let second=catalog.create_library("Second",&root,"managed").unwrap();
    let scoped=catalog.for_library(&second.id).unwrap();
    let asset=scoped.import_bytes(vec![crate::materials::MaterialBytesInput{name:"scope.txt".into(),original_path:"https://example.test/source".into(),mime_type:"text/plain".into(),bytes:b"scope".to_vec(),description:None}],&crate::materials::MaterialImportOptions::default()).unwrap().value.assets.remove(0);
    let route=format!("/v1/services/materials/assets/{}",asset.id);
    let(status,detail)=f.call(f.request("GET",&route,Value::Null,Some(&second.id),None));assert_eq!(status,200,"{detail}");
    let mutation=json!({"opId":"scope-patch","expectedRevision":detail["revision"],"name":"changed.txt"});
    let(status,receipt)=f.call(f.request("PATCH",&route,mutation.clone(),Some(&second.id),None));assert_eq!(status,200,"{receipt}");
    let(status,replay)=f.call(f.request("PATCH",&route,mutation.clone(),Some(&second.id),None));assert_eq!(status,200);assert_eq!(replay,receipt);
    let(status,_)=f.call(f.request("PATCH",&route,mutation,None,None));assert_eq!(status,409,"same op cannot replay into a different library");
    assert_eq!(f.call(f.request("GET",&route,Value::Null,None,None)).0,404);
    assert_eq!(catalog.get_assets(&[asset.id.clone()]).unwrap_err().code, "material-library-scope");
    let text="imported selected text";let digest=format!("{:x}",Sha256::digest(text.as_bytes()));
    let begin=json!({"opId":"scope-ingest","kind":"text","target":{"domain":"materials","folderId":null},"name":"import.txt","mimeType":"text/plain","sizeBytes":text.len(),"sha256":digest,"text":text});
    let(status,job)=f.call(f.request("POST","/v1/services/ingest/jobs",begin.clone(),Some(&second.id),None));assert!(status==200||status==201,"{job}");
    let job_path=format!("/v1/services/ingest/jobs/{}",job["jobId"].as_str().unwrap());
    assert_eq!(f.call(f.request("GET",&job_path,Value::Null,None,None)).0,409);
    assert_eq!(f.call(f.request("POST","/v1/services/ingest/jobs",begin,None,None)).0,409);
    let(status,done)=f.call(f.request("POST",&format!("{job_path}/complete"),json!({}),Some(&second.id),None));assert_eq!(status,200,"{done}");
    let id=done["receipt"]["assetId"].as_str().unwrap();assert_eq!(scoped.get_assets(&[id.into()]).unwrap().len(),1);assert_eq!(catalog.get_assets(&[id.into()]).unwrap_err().code,"material-library-scope");
    assert_eq!(catalog.library_state().unwrap().1,active);
    let(status,discovery)=f.call(f.request("GET","/v1/services/libraries",Value::Null,None,None));assert_eq!(status,200);assert_eq!(discovery["scopeSelectionVersion"],1);
}

#[cfg(windows)]
#[test]
fn saved_knowledge_http_create_read_conflict_and_replay_leave_main_unchanged(){
    let f=Fixture::new();let knowledge=f.gateway.backend.knowledge();
    let registration=|id:&str|{let root=f.root.path().join(id);fs::create_dir_all(root.join(".luckyray")).unwrap();let record=crate::knowledge::KnowledgeVaultRegistration{id:id.into(),name:id.into(),root_path:root.to_string_lossy().into(),mode:"vault-bound".into(),created_at:"2026-10-23T00:00:00Z".into(),last_opened_at:"2026-10-23T00:00:00Z".into(),schema_version:1,link_update_policy:Default::default()};fs::write(root.join(".luckyray/vault.json"),serde_json::to_vec(&record).unwrap()).unwrap();record};
    let a=registration("scope-a");knowledge.register_current_vault(&a).unwrap();let a_key=content::current_vault_for_service(&f.gateway).unwrap().0;
    let b=registration("scope-b");knowledge.register_current_vault(&b).unwrap();let b_key=content::current_vault_for_service(&f.gateway).unwrap().0;
    let body=json!({"opId":"scope-note-create","kind":"create","vaultId":a_key,"title":"Phone note","content":"selected vault content"});
    let(status,created)=f.call(f.request("POST","/v1/services/knowledge/notes",body.clone(),None,Some(&a_key)));assert_eq!(status,200,"{created}");
    let(status,replay)=f.call(f.request("POST","/v1/services/knowledge/notes",body.clone(),None,Some(&a_key)));assert_eq!(status,200);assert_eq!(replay,created);
    assert_eq!(f.call(f.request("POST","/v1/services/knowledge/notes",body,None,Some(&b_key))).0,409);
    let id=created["document"]["noteId"].as_str().unwrap();let route=format!("/v1/notes/{id}?vault={a_key}");
    let(status,read)=f.call(f.request("GET",&route,Value::Null,None,Some(&a_key)));assert_eq!(status,200);assert_eq!(read["content"],"selected vault content");
    assert_eq!(knowledge.current_vault_id().unwrap(),b.id);
    assert!(!std::path::Path::new(&b.root_path).join("Phone note.md").exists());
    assert_eq!(f.call(f.request("GET",&route,Value::Null,None,Some(&b_key))).0,409);
}
