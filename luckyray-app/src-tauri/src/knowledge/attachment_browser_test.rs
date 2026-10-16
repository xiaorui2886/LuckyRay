//! Synthetic Windows filesystem + production KnowledgeService + production React components.
//! HTTP replaces only Tauri IPC transport. No user profile or running app is involved.
use super::*;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;

#[test]
#[ignore = "requires isolated headless Edge, Node, esbuild and FFmpeg; run explicitly"]
fn attachment_native_frontend_combination() {
    let (service, root, registration) = super::attachment_tests::fixture("native-browser");
    let catalog = crate::materials::MaterialCatalog::new_for_test_at(root.parent().unwrap().join("catalog"));
    let active = service.activate_ui_source(&registration.id).unwrap();
    // This held reader made the old implementation fail every native resolve.
    let (_, guard, _) = service.capture_current_target().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = stop.clone();
    let server_service = service.clone();
    let thread = std::thread::spawn(move || {
        let mut workers = Vec::new();
        while !stop_worker.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let service = server_service.clone();
                    let catalog = catalog.clone();
                    workers.push(std::thread::spawn(move || {
                        stream.set_nonblocking(false).unwrap();
                        stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        let mut length = 0;
                        loop {
                            let mut line = String::new();
                            reader.read_line(&mut line).unwrap();
                            if line == "\r\n" || line.is_empty() { break; }
                            if let Some(value) = line.to_lowercase().strip_prefix("content-length:") { length = value.trim().parse::<usize>().unwrap(); }
                        }
                        assert!(length < 1024 * 1024);
                        let mut body = vec![0; length];
                        reader.read_exact(&mut body).unwrap();
                        let input: Value = serde_json::from_slice(&body).unwrap();
                        let args = &input["args"];
                        let string = |key: &str| args[key].as_str().unwrap();
                        let result: Result<Value, KnowledgeError> = (|| {
                            Ok(match input["command"].as_str().unwrap() {
                                "knowledge_resolve_attachment" => {
                                    let document: KnowledgeDocumentRef=serde_json::from_value(args["documentRef"].clone()).unwrap();
                                    let approved=catalog.approved_vault_attachment_paths(&document.vault_id).map_err(|failure|error("fixture-catalog",failure.message))?;
                                    serde_json::to_value(service.resolve_attachment_with_approved_paths(&document,string("destination"),args["wiki"].as_bool().unwrap(),&approved)?).unwrap()
                                },
                                "knowledge_get_attachment_handling_policy" => serde_json::to_value(service.attachment_handling_policy(string("vaultId"))?).unwrap(),
                                "knowledge_set_attachment_handling_policy" => serde_json::to_value(service.set_attachment_handling_policy(string("vaultId"),args["sourceEpoch"].as_u64().unwrap(),string("policy"))?).unwrap(),
                                "knowledge_preview_external_attachment_changes" => serde_json::to_value(service.preview_external_attachment_changes(string("vaultId"), &serde_json::from_value::<Vec<String>>(args["paths"].clone()).unwrap(), args["incomplete"].as_bool().unwrap_or(false))?).unwrap(),
                                "knowledge_get_attachment_link_update_policy" => serde_json::to_value(service.attachment_link_update_policy(string("vaultId"))?).unwrap(),
                                "knowledge_set_attachment_link_update_policy" => serde_json::to_value(service.set_attachment_link_update_policy(string("vaultId"), args["sourceEpoch"].as_u64().unwrap(), serde_json::from_value(args["policy"].clone()).unwrap())?).unwrap(),
                                "knowledge_execute_attachment_operation" => {
                                    let plan: AttachmentOperationPlan = serde_json::from_value(args["plan"].clone()).unwrap();
                                    let attempt = service.begin_attachment_attempt(&plan.vault_id, string("requestId"))?;
                                    serde_json::to_value(service.execute_attachment_attempt(args["sourceEpoch"].as_u64().unwrap(), &plan, attempt)?).unwrap()
                                },
                                "knowledge_attachment_context" => {
                                    let reference: KnowledgeDocumentRef=serde_json::from_value(args["documentRef"].clone()).unwrap();
                                    serde_json::to_value((service.active_ui_source_identity()?,service.read_document(&reference)?)).unwrap()
                                },
                                "knowledge_publish_attachment" => serde_json::to_value(crate::publish_attachment_with_services(&service,&catalog,serde_json::from_value(args["input"].clone()).unwrap()).map_err(|message|error("fixture-publication",message))?).unwrap(),
                                "knowledge_insert_material_current" => serde_json::to_value(crate::insert_material_current_with_services(&service,&catalog,string("assetId"),args["sourceEpoch"].as_u64().unwrap()).map_err(|message|error("fixture-current-material",message))?).unwrap(),
                                "fixture_current" => {
                                    let document: KnowledgeDocumentRef=serde_json::from_value(args["documentRef"].clone()).unwrap();
                                    let active=service.active_ui_source_identity()?;
                                    let session=service.begin_current_context_session(active.source_epoch,"fixture-material-current")?;
                                    serde_json::to_value(service.set_current_context(&KnowledgeCurrentContextInput{source_epoch:active.source_epoch,session_id:session.session_id,session_epoch:session.session_epoch,generation:1,document_ref:document,cursor_offset:Some(0),selection:None,expected_revision:Some(string("revision").into())})?).unwrap()
                                },
                                "fixture_create" => serde_json::to_value(service.create_document(&serde_json::from_value(args.clone()).unwrap())?).unwrap(),
                                "fixture_save" => {
                                    let result=service.replace_document(&serde_json::from_value(args.clone()).unwrap())?;
                                    crate::attachment_coordination::sync_note_attachment_index(&service,&catalog,&result.document.summary.document_ref).map_err(|message|error("fixture-projection",message))?;
                                    serde_json::to_value(result).unwrap()
                                },
                                "fixture_attachment_details" => serde_json::to_value(catalog.attachment_details(string("assetId")).map_err(|failure|error("fixture-catalog",failure.message))?).unwrap(),
                                "fixture_material" => serde_json::to_value(catalog.import_paths(&[PathBuf::from(string("path"))],&serde_json::from_value::<crate::materials::MaterialImportOptions>(args["options"].as_object().map(|_|args["options"].clone()).unwrap_or_else(||json!({}))).unwrap()).map_err(|failure|error("fixture-material",failure.message))?.value).unwrap(),
                                "fixture_read" => serde_json::to_value(service.read_document(&serde_json::from_value(args["documentRef"].clone()).unwrap())?).unwrap(),
                                "fixture_refresh" => serde_json::to_value(service.refresh_index()?).unwrap(),
                                "fixture_import_files" => {
                                    let vault: crate::NotesVaultMetadata = serde_json::from_value(args["vault"].clone()).unwrap();
                                    let result=crate::import_markdown_files_with_service(&service,&catalog,&vault,serde_json::from_value(args["paths"].clone()).unwrap(),args["parent"].as_str().unwrap_or("").into()).map_err(|message| error("fixture-import",message))?;
                                    serde_json::to_value(result).unwrap()
                                },
                                "fixture_import_folder" => {
                                    let vault: crate::NotesVaultMetadata = serde_json::from_value(args["vault"].clone()).unwrap();
                                    let result=crate::import_markdown_folder_with_service(&service,&catalog,&vault,Path::new(&vault.root_path),string("source").into(),args["parent"].as_str().unwrap_or("").into()).map_err(|message| error("fixture-import",message))?;
                                    serde_json::to_value(result).unwrap()
                                },
                                other => panic!("Unexpected fixture command {other}"),
                            })
                        })();
                        let payload = serde_json::to_vec(&match result { Ok(value) => json!({"value":value}), Err(error) => json!({"error":{"code":error.code,"message":error.message}}) }).unwrap();
                        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len()).unwrap();
                        stream.write_all(&payload).unwrap();
                    }));
                },
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(error) => panic!("fixture listener failed: {error}"),
            }
        }
        for worker in workers { worker.join().unwrap(); }
    });
    let app = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = std::process::Command::new("node")
        .arg(app.join(if std::env::var_os("LUCKYRAY_IMPORT_COMBINATION").is_some() {"tests/vaultImportProduction.component.cjs"} else {"tests/vaultAttachmentProduction.component.cjs"}))
        .current_dir(app)
        .env("LUCKYRAY_NATIVE_FIXTURE_URL", format!("http://{address}"))
        .env("LUCKYRAY_NATIVE_FIXTURE_ROOT", &root)
        .env("LUCKYRAY_NATIVE_FIXTURE_ID", &registration.id)
        .env("LUCKYRAY_NATIVE_FIXTURE_EPOCH", active.source_epoch.to_string())
        .output().unwrap();
    stop.store(true, Ordering::Relaxed);
    thread.join().unwrap();
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    eprintln!("{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "production frontend combination failed");
    guard.verify_current_path(&root).unwrap();
}
