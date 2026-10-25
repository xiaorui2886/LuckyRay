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
