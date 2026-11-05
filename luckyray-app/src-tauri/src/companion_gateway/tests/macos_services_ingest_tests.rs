//! Real TLS Services routes with disposable app data and a synthetic vault.
use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

struct Fixture {
    _root: tempfile::TempDir,
    backend: Arc<BackendServices>,
    gateway: Arc<CompanionGateway>,
    port: u16,
    credential: String,
    device: String,
    vault_id: String,
    vault_root: PathBuf,
}
impl Fixture {
    fn new(label: &str) -> Self {
        Self::with_policy(label,GatewayPolicy::default())
    }
    fn with_policy(label: &str, policy: GatewayPolicy) -> Self {
        let root = fixture_root(label);
        let app_root = std::fs::canonicalize(root.path()).unwrap();
        let backend = Arc::new(BackendServices::initialize(&app_root).unwrap());
        let store = Arc::new(MemoryIdentityStore::default());
        let gateway = CompanionGateway::initialize_with_store(Arc::clone(&backend), store, policy);
        let vault_root = app_root.join("vault");
        std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let registration = crate::knowledge::KnowledgeVaultRegistration {
            id: "fixture-vault".into(), name: "Fixture Vault".into(),
            root_path: vault_root.to_string_lossy().into(), mode: "vault-bound".into(),
            created_at: "2026-09-23T00:00:00Z".into(), last_opened_at: "2026-09-23T00:00:00Z".into(),
            schema_version: 1, link_update_policy: Default::default(),
        };
        std::fs::write(vault_root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
        backend.knowledge().register_current_vault(&registration).unwrap();
        let port = match gateway.start("127.0.0.1", Some(0)).unwrap() {
            GatewayStatus::Running { port, .. } => port, status => panic!("unexpected status: {status:?}"),
        };
        let envelope = gateway.issue_pairing().unwrap();
        let paired = gateway.exchange_legacy_pairing_fixture(&serde_json::to_vec(&json!({
            "secret":envelope.secret,"fingerprint":envelope.certificate_fingerprint,"deviceLabel":"Mac services fixture"
        })).unwrap(), running_generation(&gateway)).unwrap();
        let credential = paired["credential"].as_str().unwrap().to_owned();
        let device = paired["deviceId"].as_str().unwrap().to_owned();
        let vault_id = content::current_vault_for_service(&gateway).unwrap().0;
        gateway.set_service_grant(&device, "ingest.write", "vault", &vault_id, true).unwrap();
        Self { _root:root, backend, gateway, port, credential, device, vault_id, vault_root }
    }
    fn send(&self, method: &str, path: &str, body: &str, extra: &str) -> String {
        pinned_http_response(&self.gateway, self.port, &format!(
          "{method} {path} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
          self.credential,body.len()))
    }
    fn manifest(&self, op: &str, bytes: &str) -> Value {
        json!({"opId":op,"kind":"file","target":{"domain":"knowledge","vaultId":self.vault_id,
          "parentRelativePath":""},"name":"Service Attachment.bin","mimeType":"application/octet-stream",
          "sizeBytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes.as_bytes()))})
    }
    fn begin(&self, manifest: &Value) -> String {
        let started=self.send("POST","/v1/services/ingest/jobs",&manifest.to_string(),"Content-Type: application/json\r\n");
        assert!(started.starts_with("HTTP/1.1 201"),"{started}");
        serde_json::from_str::<Value>(started.split("\r\n\r\n").nth(1).unwrap()).unwrap()["jobId"].as_str().unwrap().to_owned()
    }
    fn chunk(&self, id: &str, offset: usize, bytes: &str) -> String {
        self.send("PUT",&format!("/v1/services/ingest/jobs/{id}/chunks"),bytes,
          &format!("X-Chunk-Offset: {offset}\r\nX-Chunk-SHA256: {:x}\r\n",Sha256::digest(bytes.as_bytes())))
    }
    fn stop(&self) { self.gateway.stop().unwrap(); }
}

#[test]
fn macos_services_knowledge_chunks_and_lost_receipt_recover_via_real_routes() {
    let f=Fixture::new("macos-service-chunks");
    let bytes="fixture-attachment-content";
    let manifest=f.manifest("service-attachment",bytes);
    let id=f.begin(&manifest);
    assert!(f.chunk(&id,0,&bytes[..8]).starts_with("HTTP/1.1 200"));
    assert!(f.chunk(&id,0,&bytes[..8]).starts_with("HTTP/1.1 200"));
    assert!(f.chunk(&id,8,&bytes[8..]).starts_with("HTTP/1.1 200"));
    assert!(f.chunk(&id,5,&bytes[5..13]).starts_with("HTTP/1.1 200"));
    assert!(f.chunk(&id,5,"bad-data").contains("UPLOAD_OFFSET_MISMATCH"));
    let connection=Connection::open(f.backend.db_path()).unwrap();
    // Refuse the last receipt update, after the note and its attachment were
    // committed, to model a process loss at precisely that service boundary.
    connection.execute_batch("CREATE TRIGGER synthetic_receipt_loss BEFORE UPDATE OF stage ON companion_service_upload
      WHEN NEW.stage='completed' BEGIN SELECT RAISE(FAIL,'synthetic receipt loss'); END;").unwrap();
    let path=format!("/v1/services/ingest/jobs/{id}/complete");
    let lost=f.send("POST",&path,"","");
    assert!(lost.starts_with("HTTP/1.1 503"),"{lost}");
    assert!(f.vault_root.join("Service Attachment.bin.md").exists());
    let staging=f.backend.app_data_dir().join("media-transfer-staging/macos-service-knowledge");
    let retained_bytes:u64=std::fs::read_dir(&staging).unwrap().map(|entry|entry.unwrap().metadata().unwrap().len()).sum();
    assert_eq!(retained_bytes,bytes.len() as u64,"lost Services receipt must retain its recoverable source");
    connection.execute_batch("DROP TRIGGER synthetic_receipt_loss").unwrap();
    let completed=f.send("POST",&path,"","");
    assert!(completed.starts_with("HTTP/1.1 200"),"{completed}");
    assert_eq!(f.send("POST",&path,"",""),completed);
    let receipt:Value=serde_json::from_str(completed.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(receipt["state"],"completed");
    assert_eq!(receipt["receipt"]["domain"],"knowledge");
    assert_eq!(std::fs::read(f.vault_root.join("attachments/Service Attachment.bin")).unwrap(),bytes.as_bytes());
    assert!(std::fs::read_to_string(f.vault_root.join("Service Attachment.bin.md")).unwrap().contains("Service%20Attachment.bin"));
    let content_segments:u64=connection.query_row("SELECT COUNT(*) FROM macos_companion_upload_segment WHERE op_id=?1",
        [format!("sv-{id}-file")],|row|row.get(0)).unwrap();
    assert_eq!(content_segments,0,"Services should not create a second Content staging copy");
    let service_chunks:u64=connection.query_row("SELECT COUNT(*) FROM companion_macos_service_chunk WHERE job_id=?1",[&id],|row|row.get(0)).unwrap();
    assert_eq!(service_chunks,0,"durably released chunks no longer need ownership rows");
    let retained_bytes:u64=std::fs::read_dir(&staging).unwrap().map(|entry|entry.unwrap().metadata().unwrap().len()).sum();
    assert_eq!(retained_bytes,0,"successful upload releases staging data capacity");
    f.stop();
}

#[test]
fn macos_services_replays_content_receipt_loss_with_existing_partial_content_stage() {
    let f=Fixture::new("macos-service-content-receipt");
    let bytes="saved phone attachment";
    let directory=f.vault_root.join("attachments");
    std::fs::create_dir_all(&directory).unwrap();
    let unrelated=directory.join("unrelated-equal.bin");
    std::fs::write(&unrelated,bytes).unwrap();
    let id=f.begin(&f.manifest("service-content-retry",bytes));
    assert!(f.chunk(&id,0,bytes).starts_with("HTTP/1.1 200"));
    let connection=Connection::open(f.backend.db_path()).unwrap();
    connection.execute_batch("CREATE TRIGGER synthetic_content_receipt_loss BEFORE UPDATE OF receipt ON companion_content_upload
      WHEN NEW.receipt IS NOT NULL BEGIN SELECT RAISE(FAIL,'synthetic receipt loss'); END;").unwrap();
    let complete=format!("/v1/services/ingest/jobs/{id}/complete");
    assert!(f.send("POST",&complete,"","").starts_with("HTTP/1.1 503"));
    let published=f.vault_root.join("attachments/Service Attachment.bin");
    assert_eq!(std::fs::read(&published).unwrap(),bytes.as_bytes());
    connection.execute_batch("DROP TRIGGER synthetic_content_receipt_loss").unwrap();
    // Model a pre-upgrade or interrupted Content upload which already wrote a
    // partial segment. The Services retry must keep the same Content op and
    // journal, consume its own durable source, and finish with the full offset.
    let note_id:String=connection.query_row("SELECT note_id FROM companion_content_operation WHERE op_id=?1",
        [format!("sv-{id}-create")],|row|row.get(0)).unwrap();
    f.gateway.set_service_grant(&f.device,"content.write","vault",&f.vault_id,true).unwrap();
    let upload=format!("/v1/notes/{note_id}/attachments/sv-{id}-file");
    let prefix=&bytes.as_bytes()[..3];
    let partial=json!({"vaultId":f.vault_id,"offset":0,"data":BASE64.encode(prefix),
        "sha256":format!("{:x}",Sha256::digest(prefix))}).to_string();
    assert!(f.send("PUT",&upload,&partial,"Content-Type: application/json\r\n").starts_with("HTTP/1.1 200"));
    let partial_name:String=connection.query_row("SELECT name FROM macos_companion_upload_segment WHERE op_id=?1",[format!("sv-{id}-file")],|row|row.get(0)).unwrap();
    let partial_path=f.backend.app_data_dir().join("media-transfer-staging/macos-companion-content-v1").join(partial_name);
    // A lost receipt authorizes only the journaled object, even when an
    // unrelated replacement has exactly the same bytes at its old pathname.
    let original=f.vault_root.join("recorded-service-original");
    let replacement=f.vault_root.join("unrelated-service-replacement");
    std::fs::rename(&published,&original).unwrap();
    std::fs::write(&published,bytes).unwrap();
    content::notes::macos_forget_live_uploads_for_test(&f.gateway);
    let uncertain=f.send("POST",&complete,"","");
    assert!(uncertain.starts_with("HTTP/1.1 409"),"{uncertain}");
    assert_eq!(std::fs::read(&published).unwrap(),bytes.as_bytes());
    assert_eq!(std::fs::read(&unrelated).unwrap(),bytes.as_bytes());
    std::fs::rename(&published,&replacement).unwrap();
    std::fs::rename(&original,&published).unwrap();
    let done=f.send("POST",&complete,"","");
    assert!(done.starts_with("HTTP/1.1 200"),"{done}");
    assert_eq!(f.send("POST",&complete,"",""),done);
    assert_eq!(std::fs::read(&published).unwrap(),bytes.as_bytes());
    let (committed,receipt):(u64,String)=connection.query_row("SELECT committed_bytes,receipt FROM companion_content_upload WHERE op_id=?1",
        [format!("sv-{id}-file")],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!(committed,bytes.len() as u64);
    let receipt:Value=serde_json::from_str(&receipt).unwrap();
    assert_eq!(receipt["offset"],bytes.len());
    assert_eq!(receipt["publication"]["reused"],false);
    assert_eq!(std::fs::read(&unrelated).unwrap(),bytes.as_bytes());
    assert_eq!(std::fs::read(&replacement).unwrap(),bytes.as_bytes());
    assert_eq!(std::fs::read_dir(f.vault_root.join("attachments")).unwrap().count(),2);
    assert_eq!(std::fs::metadata(&partial_path).unwrap().len(),0,"successful bridge also releases an older partial Content segment");
    f.stop();
}

#[test]
fn macos_services_success_receipt_survives_pending_reclaim_and_recovery() {
    let f=Fixture::new("macos-service-reclaim-recovery");
    let bytes="durable published attachment";
    let id=f.begin(&f.manifest("service-reclaim",bytes));
    assert!(f.chunk(&id,0,bytes).starts_with("HTTP/1.1 200"));
    let connection=Connection::open(f.backend.db_path()).unwrap();
    let name:String=connection.query_row("SELECT name FROM companion_macos_service_chunk WHERE job_id=?1",[&id],|row|row.get(0)).unwrap();
    let staging=f.backend.app_data_dir().join("media-transfer-staging/macos-service-knowledge").join(name);
    // Readable source can still publish, while changed staging permissions
    // deliberately block the narrower reclamation authority.
    std::fs::set_permissions(&staging,std::fs::Permissions::from_mode(0o400)).unwrap();
    let path=format!("/v1/services/ingest/jobs/{id}/complete");
    let completed=f.send("POST",&path,"","");
    assert!(completed.starts_with("HTTP/1.1 200"),"{completed}");
    assert_eq!(f.send("POST",&path,"",""),completed);
    assert_eq!(std::fs::read(&staging).unwrap(),bytes.as_bytes());
    let pending:u64=connection.query_row("SELECT COUNT(*) FROM companion_macos_service_chunk WHERE job_id=?1",[&id],|row|row.get(0)).unwrap();
    assert_eq!(pending,1,"blocked cleanup must retain the original identity row");
    assert_eq!(std::fs::read(f.vault_root.join("attachments/Service Attachment.bin")).unwrap(),bytes.as_bytes());
    std::fs::set_permissions(&staging,std::fs::Permissions::from_mode(0o600)).unwrap();
    services::macos_recover_completed_uploads(&f.gateway).unwrap();
    assert_eq!(std::fs::metadata(&staging).unwrap().len(),0);
    let pending:u64=connection.query_row("SELECT COUNT(*) FROM companion_macos_service_chunk WHERE job_id=?1",[&id],|row|row.get(0)).unwrap();
    assert_eq!(pending,0);
    assert_eq!(f.send("POST",&path,"",""),completed);
    f.stop();
}

#[test]
fn macos_services_grant_revoked_after_source_read_prevents_attachment_then_retries() {
    let gate=TestOneShotGate::new();
    let mut policy=GatewayPolicy::default();
    policy.services_before_knowledge_attachment_commit_gate=Some(Arc::clone(&gate));
    let f=Fixture::with_policy("macos-service-post-read-revoke",policy);
    let bytes="post read permission gate";
    let id=f.begin(&f.manifest("post-read-permission",bytes));
    assert!(f.chunk(&id,0,bytes).starts_with("HTTP/1.1 200"));
    let complete=format!("/v1/services/ingest/jobs/{id}/complete");
    let request=format!("POST {complete} HTTP/1.1\r\nHost: luckyray-companion.local\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",f.credential);
    gate.armed.store(true,Ordering::SeqCst);
    let gateway=Arc::clone(&f.gateway);let port=f.port;
    let worker=thread::spawn(move || pinned_http_response_allow_close(&gateway,port,&request));
    let deadline=Instant::now()+Duration::from_secs(5);
    while !gate.entered.load(Ordering::SeqCst) && Instant::now()<deadline {thread::sleep(Duration::from_millis(5));}
    assert!(gate.entered.load(Ordering::SeqCst),"service did not finish reading staged data");
    f.gateway.set_service_grant(&f.device,"ingest.write","vault",&f.vault_id,false).unwrap();
    gate.release.store(true,Ordering::SeqCst);
    let denied=worker.join().unwrap();
    assert!(denied.starts_with("HTTP/1.1 403"),"{denied}");
    assert!(!f.vault_root.join("attachments/Service Attachment.bin").exists());
    let db=Connection::open(f.backend.db_path()).unwrap();
    let (stage,receipt):(String,Option<String>)=db.query_row("SELECT stage,receipt FROM companion_service_upload WHERE job_id=?1",[&id],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!(stage,"committing");assert!(receipt.is_none());
    f.gateway.set_service_grant(&f.device,"ingest.write","vault",&f.vault_id,true).unwrap();
    let finished=f.send("POST",&complete,"","");
    assert!(finished.starts_with("HTTP/1.1 200"),"{finished}");
    assert_eq!(std::fs::read(f.vault_root.join("attachments/Service Attachment.bin")).unwrap(),bytes.as_bytes());
    assert_eq!(std::fs::read_dir(f.vault_root.join("attachments")).unwrap().count(),1);
    f.stop();
}

#[test]
fn macos_services_changed_source_or_revoked_grant_never_publishes_note() {
    let f=Fixture::new("macos-service-staged-check");
    let bytes="payload before tampering";
    let first=f.begin(&f.manifest("changed-stage",bytes));
    assert!(f.chunk(&first,0,bytes).starts_with("HTTP/1.1 200"));
    let db=Connection::open(f.backend.db_path()).unwrap();
    let name:String=db.query_row("SELECT name FROM companion_macos_service_chunk WHERE job_id=?1",[&first],|row|row.get(0)).unwrap();
    let chunk=f.backend.app_data_dir().join("media-transfer-staging/macos-service-knowledge").join(name);
    std::fs::write(&chunk,vec![b'x';bytes.len()]).unwrap();
    let failed=f.send("POST",&format!("/v1/services/ingest/jobs/{first}/complete"),"","");
    assert!(failed.starts_with("HTTP/1.1 503"),"{failed}");
    assert_eq!(std::fs::read(&chunk).unwrap(),vec![b'x';bytes.len()]);
    assert!(!f.vault_root.join("Service Attachment.bin.md").exists());

    let second=f.begin(&f.manifest("revoked-before-publish","valid"));
    assert!(f.chunk(&second,0,"valid").starts_with("HTTP/1.1 200"));
    f.gateway.set_service_grant(&f.device,"ingest.write","vault",&f.vault_id,false).unwrap();
    let denied=f.send("POST",&format!("/v1/services/ingest/jobs/{second}/complete"),"","");
    assert!(denied.starts_with("HTTP/1.1 403"),"{denied}");
    assert!(!f.vault_root.join("Service Attachment.bin.md").exists());
    f.stop();
}

#[test]
fn macos_clear_retires_legacy_knowledge_quota_without_touching_old_parts() {
    let f=Fixture::new("macos-service-legacy-clear");
    let connection=Connection::open(f.backend.db_path()).unwrap();
    let instance=f.gateway.identity().unwrap().instance_id.clone();
    let first=f.manifest("legacy-staging","a");
    let second=f.manifest("legacy-committing","b");
    for (job,op,stage,manifest) in [("legacy-one","legacy-staging","staging",&first),
        ("legacy-two","legacy-committing","committing",&second)] {
        connection.execute("INSERT INTO companion_service_upload(job_id,instance_id,device_id,op_id,manifest,committed_bytes,stage,updated_at) VALUES(?1,?2,?3,?4,?5,0,?6,'now')",
            params![job,instance,f.device,op,manifest.to_string(),stage]).unwrap();
    }
    let completed=f.manifest("legacy-completed","d");
    let old_receipt=json!({"domain":"knowledge","noteId":"preserved-note"});
    connection.execute("INSERT INTO companion_service_upload(job_id,instance_id,device_id,op_id,manifest,committed_bytes,stage,receipt,updated_at) VALUES('legacy-done',?1,?2,'legacy-completed',?3,1,'completed',?4,'now')",
        params![instance,f.device,completed.to_string(),old_receipt.to_string()]).unwrap();
    let directory=f.backend.app_data_dir().join("media-transfer-staging");
    std::fs::create_dir_all(&directory).unwrap();
    let part=directory.join("service-legacy-one.part");std::fs::write(&part,b"old pending bytes").unwrap();
    let foreign=f.vault_root.join("foreign-legacy-service");std::fs::write(&foreign,b"leave intact").unwrap();
    let linked=directory.join("service-legacy-two.part");symlink(&foreign,&linked).unwrap();
    let blocked=f.send("POST","/v1/services/ingest/jobs",&f.manifest("legacy-next","c").to_string(),"Content-Type: application/json\r\n");
    assert!(blocked.starts_with("HTTP/1.1 429"),"{blocked}");
    services::macos_retire_staging_for_clear(&f.gateway).unwrap();
    let old=f.send("POST","/v1/services/ingest/jobs",&second.to_string(),"Content-Type: application/json\r\n");
    assert!(old.starts_with("HTTP/1.1 503"),"{old}");
    let replay=f.send("POST","/v1/services/ingest/jobs",&completed.to_string(),"Content-Type: application/json\r\n");
    assert!(replay.starts_with("HTTP/1.1 200"),"{replay}");
    assert_eq!(serde_json::from_str::<Value>(replay.split("\r\n\r\n").nth(1).unwrap()).unwrap()["receipt"],old_receipt);
    f.gateway.set_service_grant(&f.device,"ingest.write","catalog","",true).unwrap();
    let material=json!({"opId":"legacy-material-next","kind":"file","target":{"domain":"materials"},
        "name":"fixture.txt","mimeType":"text/plain","sizeBytes":1,"sha256":format!("{:x}",Sha256::digest(b"x"))});
    let begun=f.send("POST","/v1/services/ingest/jobs",&material.to_string(),"Content-Type: application/json\r\n");
    assert!(begun.starts_with("HTTP/1.1 201"),"{begun}");
    let retired:Vec<String>=connection.prepare("SELECT prior_stage FROM companion_macos_service_retired ORDER BY job_id").unwrap()
        .query_map([],|row|row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(retired,vec!["staging","committing"]);
    assert_eq!(std::fs::read(part).unwrap(),b"old pending bytes");
    assert!(std::fs::symlink_metadata(linked).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read(foreign).unwrap(),b"leave intact");
    f.stop();
}

#[test]
fn macos_services_retired_knowledge_jobs_do_not_block_material_upload_capacity() {
    let f=Fixture::new("macos-service-clear-quota");
    let connection=Connection::open(f.backend.db_path()).unwrap();
    let instance=f.gateway.identity().unwrap().instance_id.clone();
    // Simulate two committing jobs whose staging was explicitly cleared.
    let first=f.begin(&f.manifest("clear-one","a"));
    let second=f.begin(&f.manifest("clear-two","b"));
    connection.execute("UPDATE companion_service_upload SET stage='committing' WHERE job_id IN (?1,?2)",params![first,second]).unwrap();
    connection.execute("UPDATE companion_macos_service_session SET clear_uncertain=1 WHERE job_id IN (?1,?2)",params![first,second]).unwrap();
    let stale=f.send("GET",&format!("/v1/services/ingest/jobs/{first}"),"","");
    assert!(stale.starts_with("HTTP/1.1 503"),"{stale}");
    f.gateway.set_service_grant(&f.device,"ingest.write","catalog","",true).unwrap();
    let material=json!({"opId":"material-after-clear","kind":"file","target":{"domain":"materials"},
        "name":"fixture.txt","mimeType":"text/plain","sizeBytes":1,"sha256":format!("{:x}",Sha256::digest(b"x"))});
    let begun=f.send("POST","/v1/services/ingest/jobs",&material.to_string(),"Content-Type: application/json\r\n");
    assert!(begun.starts_with("HTTP/1.1 201"),"{begun}");
    let preserved:u64=connection.query_row("SELECT COUNT(*) FROM companion_service_upload WHERE instance_id=?1 AND job_id IN (?2,?3) AND stage='committing'",
        params![instance,first,second],|row|row.get(0)).unwrap();
    assert_eq!(preserved,2);
    f.stop();
}

#[test]
fn macos_services_cancel_and_legacy_path_staging_are_safe_on_real_routes() {
    let f=Fixture::new("macos-service-old");
    let bytes="hello legacy";
    let id=f.begin(&f.manifest("new-cancel",bytes));
    assert!(f.chunk(&id,0,"hello").starts_with("HTTP/1.1 200"));
    let cancel=format!("/v1/services/ingest/jobs/{id}/cancel");
    let first=f.send("POST",&cancel,"","");
    assert!(first.starts_with("HTTP/1.1 200"),"{first}");
    assert_eq!(f.send("POST",&cancel,"",""),first);
    let directory=f.backend.app_data_dir().join("media-transfer-staging/macos-service-knowledge");
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(),1);
    let legacy=f.manifest("legacy-op",bytes);
    let conn=Connection::open(f.backend.db_path()).unwrap();
    let instance=f.gateway.identity().unwrap().instance_id.clone();
    conn.execute("INSERT INTO companion_service_upload(job_id,instance_id,device_id,op_id,manifest,committed_bytes,stage,updated_at)
      VALUES('legacyjob',?1,?2,'legacy-op',?3,0,'staging','now')",params![instance,f.device,legacy.to_string()]).unwrap();
    let unrelated=f.vault_root.join("do-not-touch.txt");
    std::fs::write(&unrelated,"preserve").unwrap();
    let old=f.backend.app_data_dir().join("media-transfer-staging/service-legacyjob.part");
    symlink(&unrelated,&old).unwrap();
    assert!(f.send("POST","/v1/services/ingest/jobs",&legacy.to_string(),"Content-Type: application/json\r\n").starts_with("HTTP/1.1 503"));
    assert!(f.send("GET","/v1/services/ingest/jobs/legacyjob","","").starts_with("HTTP/1.1 503"));
    assert!(f.chunk("legacyjob",0,"hello").starts_with("HTTP/1.1 503"));
    assert!(f.send("POST","/v1/services/ingest/jobs/legacyjob/cancel","","").starts_with("HTTP/1.1 503"));
    assert_eq!(std::fs::read_to_string(&unrelated).unwrap(),"preserve");
    assert!(std::fs::symlink_metadata(&old).unwrap().file_type().is_symlink());
    f.stop();
}

#[test]
fn macos_services_permission_loss_prevents_further_knowledge_writes() {
    let f=Fixture::new("macos-service-revoke");
    let bytes="guarded attachment";
    let id=f.begin(&f.manifest("permission-revoke",bytes));
    f.gateway.set_service_grant(&f.device,"ingest.write","vault",&f.vault_id,false).unwrap();
    let response=f.chunk(&id,0,bytes);
    assert!(response.starts_with("HTTP/1.1 403"),"{response}");
    let connection=Connection::open(f.backend.db_path()).unwrap();
    let committed:u64=connection.query_row("SELECT committed_bytes FROM companion_service_upload WHERE job_id=?1",[id],|r|r.get(0)).unwrap();
    assert_eq!(committed,0);
    assert!(!f.vault_root.join("Service Attachment.bin.md").exists());
    f.stop();
}
