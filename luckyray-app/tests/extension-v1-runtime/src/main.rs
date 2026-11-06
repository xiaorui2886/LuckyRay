#[path = "../../../src-tauri/src/extension_worker.rs"]
mod extension_worker;
fn main() {
    extension_worker::run_stdio();
}

#[path = "../../../src-tauri/src/extension_process.rs"]
mod extension_process;
#[path = "../../../src-tauri/src/extension_ai_redactor.rs"]
mod extension_ai_redactor;
// Real plugin AI bridge with a strictly synthetic host/provider seam. The
// production model transport is never called by this standalone fixture.
#[cfg(test)] extern crate self as tauri;
#[cfg(test)] pub mod async_runtime {
    pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(future)
    }
}
#[cfg(test)] #[path = "../../../src-tauri/src/extension_ai.rs"] mod extension_ai;
#[cfg(test)]
struct AiModelConfig { provider:String, protocol:String, api_key:String, model:String, custom_url:Option<String> }
#[cfg(test)]
fn load_ai_model_config_read_only(path:&std::path::Path) -> Result<AiModelConfig,String> {
    let db = rusqlite::Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "fixture-db")?;
    let read = |key:&str| -> Option<String> { db.query_row("SELECT value FROM settings WHERE key=?1",[key],|r|r.get(0)).ok() };
    let stored = read("aiApiKey").unwrap_or_default();
    let api_key = if stored.is_empty() { String::new() } else { stored.strip_prefix("synthetic-protected:").ok_or("unprotected")?.to_string() };
    Ok(AiModelConfig { provider:read("aiProvider").unwrap_or_else(||"fixture".into()), protocol:"fixture".into(), api_key, model:read("aiModel").unwrap_or_else(||"fixture-model".into()), custom_url:Some("https://synthetic.invalid".into()) })
}
#[cfg(test)]
mod ai_secret_store { pub fn write(db:&rusqlite::Connection,key:&str,value:&str)->Result<(),String> { db.execute("INSERT OR REPLACE INTO settings VALUES(?1,?2)",rusqlite::params![key,format!("synthetic-protected:{value}")]).map(|_|()).map_err(|e|e.to_string()) } }
#[cfg(test)] fn normalize_ai_api_key(value:&str)->String {value.trim().to_string()}
#[cfg(test)] struct AiChatRequestMessage { role:String, content:serde_json::Value }
#[cfg(test)] struct AiChatRequest { messages:Vec<AiChatRequestMessage>, system_prompt:Option<String>, temperature:Option<f64>, max_tokens:Option<u32>, model:Option<String> }
#[cfg(test)] struct AiChatResponse { success:bool, content:Option<String>, error_kind:Option<String> }
#[cfg(test)] struct AiChatStreamRequest { stream_id:String, messages:Vec<AiChatRequestMessage>, system_prompt:Option<String>, temperature:Option<f64>, max_tokens:Option<u32> }
#[cfg(test)] struct AiStreamEvent { delta:Option<String> }
#[cfg(test)] struct AiStreamTerminalResult { success:bool, content:Option<String>, error_kind:Option<String> }
#[cfg(test)] static MOCK_AI_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(test)] static MOCK_EVENT_AI_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)] async fn ai_chat_complete_transport(config:AiModelConfig,request:AiChatRequest,_fallback:Option<Vec<(String,bool)>>,_timeout:Option<std::time::Duration>,pinned:bool)->Result<AiChatResponse,String> {
    assert!(pinned); assert_eq!(request.messages[0].role,"user");
    if request.messages[0].content.as_str() == Some("synthetic import event") {
        MOCK_EVENT_AI_CALLS.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
    }
    if request.messages[0].content.as_str() == Some("fixture-hang") {
        MOCK_AI_STARTED.store(true,std::sync::atomic::Ordering::SeqCst);
        std::future::pending::<()>().await;
    }
    Ok(AiChatResponse { success:true,content:Some(format!("synthetic {}",config.api_key)),error_kind:None })
}
#[cfg(test)] async fn plugin_ai_complete_transport(config:AiModelConfig,request:AiChatRequest,timeout:std::time::Duration)->Result<AiChatResponse,String>{
    ai_chat_complete_transport(config,request,Some(Vec::new()),Some(timeout),true).await
}
#[cfg(test)] async fn ai_chat_stream_with_config(config:AiModelConfig,request:AiChatStreamRequest,pinned:bool,mut emit:impl FnMut(AiStreamEvent))->Result<AiStreamTerminalResult,String> {
    assert!(pinned); assert_eq!(request.messages[0].role,"user");
    let text = format!("synthetic {}",config.api_key);
    let split = text.find("protected").unwrap_or(text.len());
    emit(AiStreamEvent {delta:Some(text[..split].to_string())});
    emit(AiStreamEvent {delta:Some(text[split..].to_string())});
    Ok(AiStreamTerminalResult {success:true,content:Some(text),error_kind:None})
}
#[path = "../../../src-tauri/src/extension_event_hub.rs"]
mod extension_event_hub;
// The standalone worker fixture does not link the full material catalog. Keep
// this scope-validation seam aligned with materials::consumer::valid_consumer_id.
mod materials {
    pub mod consumer {
        pub fn valid_consumer_id(value: &str) -> bool {
            !value.is_empty() && value.len() <= 160 && value.trim() == value
                && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::extension_process::Worker;
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    fn exe() -> PathBuf {
        PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").expect("fixture exe path"))
    }
    fn finish(worker: &Worker) -> Result<Value, String> {
        let start = Instant::now();
        loop {
            if let Some(v) = worker.poll()? {
                return Ok(v);
            }
            assert!(start.elapsed() < Duration::from_secs(6));
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn real_engine_has_no_ambient_host_capabilities() {
        let w=Worker::launch(&exe(),"LuckyRay.register(()=>[typeof process,typeof require,typeof fetch,typeof document,typeof __TAURI_INTERNALS__,typeof Worker,typeof os]);",&json!({}),Duration::from_secs(4)).unwrap();
        let v = finish(&w).unwrap();
        assert_eq!(
            v["result"]["value"],
            json!([
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "undefined"
            ])
        );
    }
    #[test]
    fn real_parent_roundtrip_supports_logic() {
        let mut w = Worker::launch(
            &exe(),
            "LuckyRay.register(async()=> (await LuckyRay.call('data.get')).n + 2);",
            &json!({}),
            Duration::from_secs(4),
        )
        .unwrap();
        assert_eq!(finish(&w).unwrap()["request"]["method"], "data.get");
        w.reply(&json!({"value":{"n":3}})).unwrap();
        assert_eq!(finish(&w).unwrap()["result"]["value"], 5);
    }
    #[test]
    fn worker_streams_synthetic_chunks_and_host_wait_does_not_consume_js_budget() {
        let mut w = Worker::launch(&exe(), "LuckyRay.register(async()=>{let s='';const r=await LuckyRay.stream('ai.generate',{prompt:'fixture'},d=>s+=d);return {chunks:s,final:r.text}});", &json!({}), Duration::from_secs(8)).unwrap();
        assert_eq!(finish(&w).unwrap()["request"]["method"], "ai.stream");
        std::thread::sleep(Duration::from_millis(3200));
        w.reply(&json!({"delta":"one "})).unwrap();
        w.reply(&json!({"delta":"two"})).unwrap();
        w.reply(&json!({"value":{"text":"one two"}})).unwrap();
        let result = finish(&w).unwrap();
        assert_eq!(result["result"]["value"],json!({"chunks":"one two","final":"one two"}));
    }
    #[test]
    fn parent_kills_infinite_code_and_blocked_rpc() {
        for source in ["while(true){}","LuckyRay.register(()=>LuckyRay.call('never.replied'));","LuckyRay.register(()=>{function again(){Promise.resolve().then(again)}again();return new Promise(()=>{});});"] {let start=Instant::now();let w=Worker::launch(&exe(),source,&json!({}),Duration::from_millis(150)).unwrap();loop{match finish(&w){Ok(v) if v["kind"]=="call"=>continue,_=>break}}drop(w);assert!(start.elapsed()<Duration::from_secs(3));}
    }
    #[test]
    fn memory_and_output_are_bounded() {
        for source in [
            "const a=[];while(true)a.push(new Array(100000).fill('x'));",
            "LuckyRay.register(()=> 'x'.repeat(200000));",
        ] {
            let w = Worker::launch(&exe(), source, &json!({}), Duration::from_secs(4)).unwrap();
            let v = finish(&w);
            assert!(v.is_err() || v.unwrap()["result"]["ok"] == false);
        }
    }
}

#[path = "../../../src-tauri/src/extension_broker.rs"]
mod extension_broker;
#[path = "../../../src-tauri/src/extension_packages_store.rs"]
mod extension_packages_store;
#[cfg(test)]
mod authorization_tests {
    use super::{
        extension_broker::{Broker, Scope},
        extension_packages_store::{self as store, Request},
    };
    use serde_json::json;
    use std::{
        path::PathBuf,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    fn root() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "lr-v1-authority-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn package(id: &str, code: &str) -> store::Package {
        serde_json::from_value(json!({"manifest":{"schemaVersion":1,"apiVersion":1,"id":id,"name":"fixture","version":"1.0.0","type":"script","entry":"main.js","minHostVersion":"1.9.2","requiredModules":["materials"],"optionalModules":[]},"resource":{"code":code,"requiredPermissions":["materials.read"],"optionalPermissions":[],"dataVersion":1,"contributions":[{"id":"run","label":"Run","kind":"command"}]}})).unwrap()
    }
    fn enable(root: &PathBuf, id: &str, code: &str) {
        let s = store::manage(root, "1.9.2", Request::List).unwrap();
        let s = store::manage(
            root,
            "1.9.2",
            Request::Install {
                package: package(id, code),
                publisher_approved: false,
                expected_revision: s.revision,
            },
        )
        .unwrap();
        assert!(store::manage(
            root,
            "1.9.2",
            Request::Enable {
                id: id.into(),
                expected_revision: s.revision
            }
        )
        .is_err());
        let s = store::manage(
            root,
            "1.9.2",
            Request::Grant {
                id: id.into(),
                grants: vec!["materials.read".into()],
                expected_revision: s.revision,
            },
        )
        .unwrap();
        store::manage(
            root,
            "1.9.2",
            Request::Enable {
                id: id.into(),
                expected_revision: s.revision,
            },
        )
        .unwrap();
    }
    fn start(b: &mut Broker, root: &PathBuf, id: &str) -> String {
        b.start(
            root,
            "1.9.2",
            &PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap()),
            id,
            Scope {
                material_ids: vec!["allowed".into()],
                ..Scope::default()
            },
            json!({"contribution":"run"}),
        )
        .unwrap()
    }
    fn pending(b: &mut Broker, root: &PathBuf, t: &str) {
        for _ in 0..500 {
            let v = b.poll(root, "1.9.2", t).unwrap();
            if v["kind"] == "call" {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("no request");
    }
    #[test]
    fn ai_requires_saved_grant_and_per_run_selection_then_delivers_only_mock_output() {
        let root = root();
        let mut pkg = package("test.ai", "LuckyRay.register(async()=>{let s='';const r=await LuckyRay.stream('ai.generate',{prompt:'fixture'},d=>s+=d);return {title:s,text:r.text}});");
        pkg.manifest.required_modules = vec!["ai".into()];
        pkg.resource["requiredPermissions"] = json!(["ai.generate"]);
        let s = store::manage(&root,"1.9.2",Request::Install {package:pkg,publisher_approved:false,expected_revision:0}).unwrap();
        let s = store::manage(&root,"1.9.2",Request::Grant {id:"test.ai".into(),grants:vec!["ai.generate".into()],expected_revision:s.revision}).unwrap();
        store::manage(&root,"1.9.2",Request::Enable {id:"test.ai".into(),expected_revision:s.revision}).unwrap();
        let exe = PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap());
        let mut broker = Broker::default();
        let no_selection = broker.start(&root,"1.9.2",&exe,"test.ai",Scope::default(),json!({"contribution":"run"})).unwrap();
        pending(&mut broker,&root,&no_selection);
        let denied = broker.dispatch(&root,"1.9.2",&no_selection,None,|_,_| panic!("no model was chosen")).unwrap();
        assert_eq!(denied["response"]["error"],"plugin-ai-not-selected");
        broker.close(&no_selection);
        let chosen = Scope { ai_selection: Some(super::extension_broker::AiSelection { provider:"fixture".into(),model:"mock".into(),fingerprint:"a".repeat(64) }), ..Scope::default() };
        let token = broker.start(&root,"1.9.2",&exe,"test.ai",chosen,json!({"contribution":"run"})).unwrap();
        pending(&mut broker,&root,&token);
        let response = broker.dispatch(&root,"1.9.2",&token,None,|s,rpc| {
            assert_eq!(rpc.method,"ai.stream");
            s.stream_chunk("synthetic ")?;
            s.stream_chunk("result")?;
            Ok(json!({"text":"synthetic result"}))
        }).unwrap();
        assert_eq!(response["response"]["value"]["text"],"synthetic result");
        let mut output = None;
        for _ in 0..500 {
            let next = broker.poll(&root,"1.9.2",&token).unwrap();
            if next["kind"] == "result" { output = Some(next); break; }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(output.unwrap()["result"]["value"],json!({"title":"synthetic result","text":"synthetic result"}));
        let mut ungranted = package("test.no-ai", "LuckyRay.register(()=>LuckyRay.call('ai.generate',{prompt:'fixture'}));");
        ungranted.manifest.required_modules = vec!["ai".into()];
        ungranted.resource["requiredPermissions"] = json!([]);
        ungranted.resource["optionalPermissions"] = json!(["ai.generate"]);
        let state = store::manage(&root,"1.9.2",Request::List).unwrap();
        let state = store::manage(&root,"1.9.2",Request::Install {package:ungranted,publisher_approved:false,expected_revision:state.revision}).unwrap();
        store::manage(&root,"1.9.2",Request::Enable {id:"test.no-ai".into(),expected_revision:state.revision}).unwrap();
        let chosen = Scope { ai_selection: Some(super::extension_broker::AiSelection { provider:"fixture".into(),model:"mock".into(),fingerprint:"a".repeat(64) }), ..Scope::default() };
        let no_grant = broker.start(&root,"1.9.2",&exe,"test.no-ai",chosen,json!({"contribution":"run"})).unwrap();
        pending(&mut broker,&root,&no_grant);
        let denied = broker.dispatch(&root,"1.9.2",&no_grant,None,|_,_| panic!("no AI grant")).unwrap();
        assert_eq!(denied["response"]["error"],"plugin-permission-denied");
        broker.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn real_ai_bridge_pins_selection_and_redacts_the_mock_provider_stream() {
        let root = root();
        std::fs::create_dir_all(&root).unwrap();
        let db = rusqlite::Connection::open(root.join("luckyray.db")).unwrap();
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").unwrap();
        super::ai_secret_store::write(&db,"aiApiKey","synthetic-protected-key").unwrap();
        let chosen = super::extension_ai::selection(&root).unwrap();
        let mut pkg = package("test.ai-bridge", "LuckyRay.register(async()=>{let s='';const r=await LuckyRay.stream('ai.generate',{prompt:'fixture'},d=>s+=d);return {title:s,text:r.text}});");
        pkg.manifest.required_modules = vec!["ai".into()];
        pkg.resource["requiredPermissions"] = json!(["ai.generate"]);
        let state = store::manage(&root,"1.9.2",Request::Install {package:pkg,publisher_approved:false,expected_revision:0}).unwrap();
        let state = store::manage(&root,"1.9.2",Request::Grant {id:"test.ai-bridge".into(),grants:vec!["ai.generate".into()],expected_revision:state.revision}).unwrap();
        store::manage(&root,"1.9.2",Request::Enable {id:"test.ai-bridge".into(),expected_revision:state.revision}).unwrap();
        let exe = PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap());
        let mut broker = Broker::default();
        let token = broker.start(&root,"1.9.2",&exe,"test.ai-bridge",Scope {ai_selection:Some(chosen),..Scope::default()},json!({"contribution":"run"})).unwrap();
        pending(&mut broker,&root,&token);
        db.execute("INSERT INTO settings VALUES('aiModel','changed')",[]).unwrap();
        let denied = broker.dispatch(&root,"1.9.2",&token,None,|s,c|super::extension_ai::dispatch(&root,s,c)).unwrap();
        assert_eq!(denied["response"]["error"],"plugin-ai-selection-changed");
        broker.close(&token);
        let chosen = super::extension_ai::selection(&root).unwrap();
        let token = broker.start(&root,"1.9.2",&exe,"test.ai-bridge",Scope {ai_selection:Some(chosen),..Scope::default()},json!({"contribution":"run"})).unwrap();
        pending(&mut broker,&root,&token);
        let response = broker.dispatch(&root,"1.9.2",&token,None,|s,c|super::extension_ai::dispatch(&root,s,c)).unwrap();
        assert_eq!(response["response"]["value"]["text"],"synthetic [redacted]");
        let mut output = None;
        for _ in 0..500 {
            let next = broker.poll(&root,"1.9.2",&token).unwrap();
            if next["kind"] == "result" { output = Some(next); break; }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(output.unwrap()["result"]["value"],json!({"title":"synthetic [redacted]","text":"synthetic [redacted]"}));
        broker.close_all();
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn disabling_plugin_cancels_a_hung_mock_ai_call() {
        let root = root();
        std::fs::create_dir_all(&root).unwrap();
        let db = rusqlite::Connection::open(root.join("luckyray.db")).unwrap();
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").unwrap();
        super::ai_secret_store::write(&db,"aiApiKey","synthetic-protected-key").unwrap();
        let mut pkg = package("test.ai-cancel", "LuckyRay.register(()=>LuckyRay.call('ai.generate',{prompt:'fixture-hang'}));");
        pkg.manifest.required_modules = vec!["ai".into()];
        pkg.resource["requiredPermissions"] = json!(["ai.generate"]);
        let state = store::manage(&root,"1.9.2",Request::Install {package:pkg,publisher_approved:false,expected_revision:0}).unwrap();
        let state = store::manage(&root,"1.9.2",Request::Grant {id:"test.ai-cancel".into(),grants:vec!["ai.generate".into()],expected_revision:state.revision}).unwrap();
        let state = store::manage(&root,"1.9.2",Request::Enable {id:"test.ai-cancel".into(),expected_revision:state.revision}).unwrap();
        let exe = PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap());
        let mut broker = Broker::default();
        let token = broker.start(&root,"1.9.2",&exe,"test.ai-cancel",Scope {ai_selection:Some(super::extension_ai::selection(&root).unwrap()),..Scope::default()},json!({"contribution":"run"})).unwrap();
        pending(&mut broker,&root,&token);
        let handle = broker.handle(&token).unwrap();
        let job_root = root.clone();
        super::MOCK_AI_STARTED.store(false,std::sync::atomic::Ordering::SeqCst);
        let job = std::thread::spawn(move || handle.dispatch(&job_root,"1.9.2",None,|s,c|super::extension_ai::dispatch(&job_root,s,c)));
        for _ in 0..200 {
            if super::MOCK_AI_STARTED.load(std::sync::atomic::Ordering::SeqCst) { break; }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(super::MOCK_AI_STARTED.load(std::sync::atomic::Ordering::SeqCst));
        let start = std::time::Instant::now();
        store::manage(&root,"1.9.2",Request::Disable {id:"test.ai-cancel".into(),expected_revision:state.revision}).unwrap();
        broker.sweep(&root,"1.9.2");
        assert!(job.join().unwrap().is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        broker.close_all(); drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn foreign_objects_and_methods_do_not_reach_domain() {
        let root = root();
        enable(
            &root,
            "test.one",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'foreign'}));",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.one");
        pending(&mut b, &root, &t);
        let result = b
            .dispatch(&root, "1.9.2", &t, None, |_, _| {
                panic!("must not reach domain")
            })
            .unwrap();
        assert_eq!(result["response"]["error"], "plugin-object-denied");
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn event_invocation_cannot_write_or_create_recursive_subscriptions() {
        let root = root();
        let mut pkg = package("test.event-guard", "LuckyRay.register(async()=>{try{await LuckyRay.call('events.subscribe',{type:'materials.imported'})}catch(_){};return LuckyRay.call('materials.tags',{id:'allowed',revision:'r1',tags:['x']})});");
        pkg.manifest.required_modules = vec!["events".into(),"materials".into()];
        pkg.resource["requiredPermissions"] = json!(["events.subscribe","materials.tags"]);
        let state=store::manage(&root,"1.9.2",Request::Install {package:pkg,publisher_approved:false,expected_revision:0}).unwrap();
        let state=store::manage(&root,"1.9.2",Request::Grant {id:"test.event-guard".into(),grants:vec!["events.subscribe".into(),"materials.tags".into()],expected_revision:state.revision}).unwrap();
        let state=store::manage(&root,"1.9.2",Request::Enable {id:"test.event-guard".into(),expected_revision:state.revision}).unwrap();
        let mut b=Broker::default();
        let token=b.start(&root,"1.9.2",&PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap()),"test.event-guard",Scope {event_delivery:true,event_digest:Some(state.packages[0].digest.clone()),event_epoch:Some(state.packages[0].epoch),writes:true,material_ids:vec!["allowed".into()],events_allowed:vec!["materials.imported".into()],..Scope::default()},json!({"contribution":"run","notification":{"type":"materials.imported"}})).unwrap();
        pending(&mut b,&root,&token);
        let response=b.dispatch(&root,"1.9.2",&token,None,|_,_|panic!("recursive registration reached host")).unwrap();
        assert_eq!(response["response"]["error"],"plugin-event-recursion-denied");
        pending(&mut b,&root,&token);
        let response=b.dispatch(&root,"1.9.2",&token,None,|_,_|panic!("event write reached host")).unwrap();
        assert_eq!(response["response"]["error"],"plugin-write-confirmation-required");
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelling_an_event_stops_its_worker_without_stopping_a_manual_run() {
        let root=root();
        enable(&root,"test.event-cancel","LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));");
        let state=store::manage(&root,"1.9.2",Request::List).unwrap();
        let executable=PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap());
        let mut b=Broker::default();
        let event=b.start(&root,"1.9.2",&executable,"test.event-cancel",Scope {event_delivery:true,event_digest:Some(state.packages[0].digest.clone()),event_epoch:Some(state.packages[0].epoch),material_ids:vec!["allowed".into()],..Scope::default()},json!({"contribution":"run","notification":{"type":"knowledge.saved"}})).unwrap();
        pending(&mut b,&root,&event);
        let manual=start(&mut b,&root,"test.event-cancel"); pending(&mut b,&root,&manual);
        b.cancel_event("test.event-cancel","knowledge.saved");
        assert!(b.poll(&root,"1.9.2",&event).is_err());
        assert_eq!(b.poll(&root,"1.9.2",&manual).unwrap()["kind"],"call");
        b.close_all();std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn synthetic_import_reaches_scoped_worker_once_and_stops_after_disable() {
        let root = root();
        let code = "LuckyRay.register(async e=>e.input.action==='event'?{title:e.input.notification.type,text:e.objects.materials.join(',')}:(await LuckyRay.call('events.subscribe',{type:'materials.imported'}),{title:'ready'}));";
        let mut pkg = package("test.event-flow",code);
        pkg.manifest.required_modules = vec!["events".into(),"materials".into()];
        pkg.resource["requiredPermissions"] = json!(["events.subscribe","materials.read"]);
        let state=store::manage(&root,"1.9.2",Request::Install {package:pkg,publisher_approved:false,expected_revision:0}).unwrap();
        let state=store::manage(&root,"1.9.2",Request::Grant {id:"test.event-flow".into(),grants:vec!["events.subscribe".into(),"materials.read".into()],expected_revision:state.revision}).unwrap();
        let state=store::manage(&root,"1.9.2",Request::Enable {id:"test.event-flow".into(),expected_revision:state.revision}).unwrap();
        let executable=PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap());
        let mut b=Broker::default(); let mut hub=super::extension_event_hub::EventHub::default();
        let token=b.start(&root,"1.9.2",&executable,"test.event-flow",Scope {events_allowed:vec!["materials.imported".into()],event_material_library_id:Some("library-fixture".into()),..Scope::default()},json!({"contribution":"run","action":"run"})).unwrap();
        pending(&mut b,&root,&token);
        b.dispatch(&root,"1.9.2",&token,None,|session,rpc| {
            hub.subscribe(&session.package,&session.scope,&session.contribution,rpc.params["type"].as_str().unwrap())?;
            Ok(json!({"subscribed":true}))
        }).unwrap();
        let mut ready=false;
        for _ in 0..500 { if b.poll(&root,"1.9.2",&token).unwrap()["kind"]=="result" {ready=true;break;} std::thread::sleep(Duration::from_millis(5)); }
        assert!(ready);
        let ids=vec!["synthetic-asset".to_string()];
        let tokens=hub.publish("synthetic-import",super::extension_event_hub::SourceEvent::Materials {library_id:"library-fixture",ids:&ids});
        assert_eq!(tokens.len(),1);
        assert!(hub.publish("synthetic-import",super::extension_event_hub::SourceEvent::Materials {library_id:"library-fixture",ids:&ids}).is_empty());
        let claim=hub.claim(&tokens[0],&state).unwrap();
        let token=b.start(&root,"1.9.2",&executable,&claim.id,claim.scope,claim.event).unwrap();
        let mut result=None;
        for _ in 0..500 { let value=b.poll(&root,"1.9.2",&token).unwrap(); if value["kind"]=="result" {result=Some(value);break;} std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(result.unwrap()["result"]["value"],json!({"title":"materials.imported","text":"synthetic-asset"}));
        let state=store::manage(&root,"1.9.2",Request::Disable {id:"test.event-flow".into(),expected_revision:state.revision}).unwrap();
        hub.retain_current(&state);
        assert!(hub.publish("later-import",super::extension_event_hub::SourceEvent::Materials {library_id:"library-fixture",ids:&ids}).is_empty());
        b.close_all(); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn synthetic_plugin_subscribes_calls_mock_ai_displays_result_and_stops() {
        let root = root(); std::fs::create_dir_all(&root).unwrap();
        let db=rusqlite::Connection::open(root.join("luckyray.db")).unwrap();
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").unwrap();
        super::ai_secret_store::write(&db,"aiApiKey","synthetic-protected-key").unwrap();
        let code="LuckyRay.register(async e=>e.input.action==='event'?{title:'Import handled',text:(await LuckyRay.call('ai.generate',{prompt:'synthetic import event'})).text}:(await LuckyRay.call('events.subscribe',{type:'materials.imported'}),{title:'Subscribed'}));";
        let mut pkg=package("test.combined",code);
        pkg.manifest.required_modules=vec!["events".into(),"materials".into(),"ai".into()];
        pkg.resource["requiredPermissions"]=json!(["events.subscribe","materials.read","ai.generate"]);
        let state=store::manage(&root,"1.9.2",Request::Install {package:pkg,publisher_approved:false,expected_revision:0}).unwrap();
        let state=store::manage(&root,"1.9.2",Request::Grant {id:"test.combined".into(),grants:vec!["events.subscribe".into(),"materials.read".into(),"ai.generate".into()],expected_revision:state.revision}).unwrap();
        let state=store::manage(&root,"1.9.2",Request::Enable {id:"test.combined".into(),expected_revision:state.revision}).unwrap();
        let executable=PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap());
        let mut broker=Broker::default(); let mut hub=super::extension_event_hub::EventHub::default();
        let scope=Scope {events_allowed:vec!["materials.imported".into()],event_material_library_id:Some("fixture-library".into()),ai_selection:Some(super::extension_ai::selection(&root).unwrap()),event_allow_ai:true,..Scope::default()};
        let token=broker.start(&root,"1.9.2",&executable,"test.combined",scope,json!({"contribution":"run","action":"run"})).unwrap();
        pending(&mut broker,&root,&token);
        broker.dispatch(&root,"1.9.2",&token,None,|s,rpc|{hub.subscribe(&s.package,&s.scope,&s.contribution,rpc.params["type"].as_str().unwrap())?;Ok(json!({"subscribed":true}))}).unwrap();
        let mut ready=false; for _ in 0..500 {if broker.poll(&root,"1.9.2",&token).unwrap()["kind"]=="result"{ready=true;break} std::thread::sleep(Duration::from_millis(5));} assert!(ready);
        let ids=vec!["synthetic-asset".into()]; let tokens=hub.publish("fixture-event",super::extension_event_hub::SourceEvent::Materials {library_id:"fixture-library",ids:&ids});
        let claim=hub.claim(&tokens[0],&state).unwrap();
        let token=broker.start(&root,"1.9.2",&executable,&claim.id,claim.scope,claim.event).unwrap();
        pending(&mut broker,&root,&token);
        super::MOCK_EVENT_AI_CALLS.store(0,std::sync::atomic::Ordering::SeqCst);
        broker.dispatch(&root,"1.9.2",&token,None,|s,c|super::extension_ai::dispatch(&root,s,c)).unwrap();
        let mut result=None;for _ in 0..500 {let v=broker.poll(&root,"1.9.2",&token).unwrap();if v["kind"]=="result"{result=Some(v);break}std::thread::sleep(Duration::from_millis(5));}
        assert_eq!(result.unwrap()["result"]["value"],json!({"title":"Import handled","text":"synthetic [redacted]"}));
        let state=store::manage(&root,"1.9.2",Request::Disable {id:"test.combined".into(),expected_revision:state.revision}).unwrap(); hub.retain_current(&state);
        assert!(hub.publish("fixture-event-after-disable",super::extension_event_hub::SourceEvent::Materials {library_id:"fixture-library",ids:&ids}).is_empty());
        assert_eq!(super::MOCK_EVENT_AI_CALLS.load(std::sync::atomic::Ordering::SeqCst),1);
        broker.close_all();drop(db);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn revoke_rejects_pending_write_and_reenable_does_not_revive_token() {
        let root = root();
        enable(
            &root,
            "test.one",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.one");
        pending(&mut b, &root, &t);
        let s = store::manage(&root, "1.9.2", Request::List).unwrap();
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Disable {
                id: "test.one".into(),
                expected_revision: s.revision,
            },
        )
        .unwrap();
        store::manage(
            &root,
            "1.9.2",
            Request::Enable {
                id: "test.one".into(),
                expected_revision: s.revision,
            },
        )
        .unwrap();
        assert!(b
            .dispatch(&root, "1.9.2", &t, None, |_, _| panic!("retired"))
            .is_err());
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn permission_expansion_disables_and_keeps_data() {
        let root = root();
        enable(&root, "test.one", "LuckyRay.register(()=>null);");
        let s = store::manage(&root, "1.9.2", Request::List).unwrap();
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Data {
                id: "test.one".into(),
                expected_revision: s.revision,
                data: store::PluginData {
                    schema_version: 1,
                    revision: 1,
                    settings: json!({"keep":true}),
                    cache: json!({}),
                },
            },
        )
        .unwrap();
        let mut next = package("test.one", "LuckyRay.register(()=>null);");
        next.manifest.version = "1.1.0".into();
        next.resource["optionalPermissions"] = json!(["materials.tags"]);
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Update {
                package: next,
                publisher_approved: true,
                expected_revision: s.revision,
            },
        )
        .unwrap();
        assert!(!s.packages[0].enabled);
        assert!(s.packages[0].grants.is_empty());
        assert_eq!(s.packages[0].data.as_ref().unwrap().settings["keep"], true);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn close_does_not_wait_for_blocked_domain_and_final_check_rejects_it() {
        let root = root();
        enable(
            &root,
            "test.slow",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.slow");
        pending(&mut b, &root, &t);
        let handle = b.handle(&t).unwrap();
        let cloned = root.clone();
        let (entered, wait_enter) = std::sync::mpsc::channel();
        let (resume, wait_resume) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            handle.dispatch(&cloned, "1.9.2", None, |s, _| {
                entered.send(()).unwrap();
                wait_resume.recv().unwrap();
                s.require_current(&cloned, "1.9.2")?;
                panic!("retired operation must not commit")
            })
        });
        wait_enter.recv_timeout(Duration::from_secs(2)).unwrap();
        let now = std::time::Instant::now();
        b.close(&t);
        assert!(now.elapsed() < Duration::from_secs(1));
        resume.send(()).unwrap();
        assert!(thread.join().unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn selected_document_does_not_grant_create_and_forged_identity_is_rejected() {
        let root = root();
        let mut pkg = package(
            "test.scope",
            "LuckyRay.register(()=>LuckyRay.call('knowledge.create',{title:'No',content:'No'}));",
        );
        pkg.manifest.required_modules = vec!["knowledge".into()];
        pkg.resource["requiredPermissions"] = json!(["knowledge.create"]);
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Install {
                package: pkg,
                publisher_approved: false,
                expected_revision: 0,
            },
        )
        .unwrap();
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Grant {
                id: "test.scope".into(),
                grants: vec!["knowledge.create".into()],
                expected_revision: s.revision,
            },
        )
        .unwrap();
        store::manage(
            &root,
            "1.9.2",
            Request::Enable {
                id: "test.scope".into(),
                expected_revision: s.revision,
            },
        )
        .unwrap();
        let mut b = Broker::default();
        let t = b
            .start(
                &root,
                "1.9.2",
                &PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap()),
                "test.scope",
                Scope {
                    writes: true,
                    knowledge: Some(super::extension_broker::KnowledgeScope {
                        allow_create: false,
                        vault_id: "v".into(),
                        source_epoch: 1,
                        documents: vec!["selected.md".into()],
                        parent_relative_path: None,
                    }),
                    ..Scope::default()
                },
                json!({"contribution":"run"}),
            )
            .unwrap();
        pending(&mut b, &root, &t);
        let response = b
            .dispatch(&root, "1.9.2", &t, None, |_, _| panic!("no create grant"))
            .unwrap();
        assert_eq!(response["response"]["error"], "plugin-create-not-selected");
        b.close_all();
        enable(
            &root,
            "test.forge",
            "LuckyRay.register(()=>LuckyRay.call('data.get',{pluginId:'test.scope'}));",
        );
        let t = start(&mut b, &root, "test.forge");
        pending(&mut b, &root, &t);
        let response = b
            .dispatch(&root, "1.9.2", &t, None, |_, _| panic!())
            .unwrap();
        assert_eq!(response["response"]["error"], "plugin-parameters");
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retired_blocked_work_keeps_its_host_capacity_until_completion() {
        let root = root();
        enable(
            &root,
            "test.cap",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));",
        );
        let mut b = Broker::default();
        let mut jobs = Vec::new();
        for _ in 0..4 {
            let t = start(&mut b, &root, "test.cap");
            pending(&mut b, &root, &t);
            let h = b.handle(&t).unwrap();
            let r = root.clone();
            let (entered, wait) = std::sync::mpsc::channel();
            let (resume, paused) = std::sync::mpsc::channel();
            let job = std::thread::spawn(move || {
                h.dispatch(&r, "1.9.2", None, |_, _| {
                    entered.send(()).unwrap();
                    paused.recv().unwrap();
                    Ok(json!({}))
                })
            });
            wait.recv_timeout(Duration::from_secs(2)).unwrap();
            b.close(&t);
            jobs.push((resume, job));
        }
        let t = start(&mut b, &root, "test.cap");
        pending(&mut b, &root, &t);
        assert_eq!(
            b.dispatch(&root, "1.9.2", &t, None, |_, _| panic!("capacity bypass"))
                .unwrap_err(),
            "plugin-host-work-limit"
        );
        for (resume, job) in jobs {
            resume.send(()).unwrap();
            assert!(job.join().unwrap().is_err());
        }
        assert!(b
            .dispatch(&root, "1.9.2", &t, None, |_, _| Ok(json!({})))
            .is_ok());
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn already_admitted_write_can_finish_after_retirement_without_retry() {
        let root = root();
        enable(
            &root,
            "test.accept",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.accept");
        pending(&mut b, &root, &t);
        let h = b.handle(&t).unwrap();
        let r = root.clone();
        let (accepted, wait) = std::sync::mpsc::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        let effect = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mark = effect.clone();
        let job = std::thread::spawn(move || {
            h.dispatch(&r, "1.9.2", None, |s, _| {
                s.require_current(&r, "1.9.2")?;
                accepted.send(()).unwrap();
                paused.recv().unwrap();
                mark.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(json!({}))
            })
        });
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        b.close(&t);
        resume.send(()).unwrap();
        assert!(job.join().unwrap().is_err());
        assert_eq!(effect.load(std::sync::atomic::Ordering::SeqCst), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn committed_write_whose_reply_cannot_be_delivered_still_reports_its_receipt() {
        // R2: a write admitted and finished by the domain must not vanish when the
        // lease ends before the worker can be answered. The dispatch result carries
        // the response plus deliveryError instead of hiding the receipt behind Err.
        let root = root();
        let package: store::Package = serde_json::from_value(json!({"manifest":{"schemaVersion":1,"apiVersion":1,"id":"test.deliver","name":"fixture","version":"1.0.0","type":"script","entry":"main.js","minHostVersion":"1.9.2","requiredModules":["materials"],"optionalModules":[]},"resource":{"code":"LuckyRay.register(()=>LuckyRay.call('materials.tags',{id:'allowed',revision:'r1',tags:['x']}));","requiredPermissions":["materials.read","materials.tags"],"optionalPermissions":[],"dataVersion":1,"contributions":[{"id":"run","label":"Run","kind":"command"}]}})).unwrap();
        let s = store::manage(&root, "1.9.2", Request::List).unwrap();
        let s = store::manage(&root, "1.9.2", Request::Install { package, publisher_approved: false, expected_revision: s.revision }).unwrap();
        let s = store::manage(&root, "1.9.2", Request::Grant { id: "test.deliver".into(), grants: vec!["materials.read".into(), "materials.tags".into()], expected_revision: s.revision }).unwrap();
        store::manage(&root, "1.9.2", Request::Enable { id: "test.deliver".into(), expected_revision: s.revision }).unwrap();
        let mut b = Broker::default();
        let t = b
            .start(
                &root,
                "1.9.2",
                &PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap()),
                "test.deliver",
                Scope { material_ids: vec!["allowed".into()], writes: true, ..Scope::default() },
                json!({"contribution":"run"}),
            )
            .unwrap();
        pending(&mut b, &root, &t);
        let h = b.handle(&t).unwrap();
        let r = root.clone();
        let (accepted, wait) = std::sync::mpsc::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        let effect = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mark = effect.clone();
        let job = std::thread::spawn(move || {
            h.dispatch(&r, "1.9.2", None, |s, _| {
                s.require_current(&r, "1.9.2")?;
                accepted.send(()).unwrap();
                paused.recv().unwrap();
                mark.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(json!({"id":"allowed","name":"allowed.png","tagIds":["x"],"revision":"r2"}))
            })
        });
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        b.close(&t);
        resume.send(()).unwrap();
        let delivered = job.join().unwrap().expect("committed write must report its receipt");
        assert_eq!(delivered["method"], "materials.tags");
        assert_eq!(delivered["deliveryError"], "plugin-retired");
        assert_eq!(delivered["response"]["value"]["revision"], "r2");
        assert_eq!(effect.load(std::sync::atomic::Ordering::SeqCst), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn owned_data_does_not_cross_plugin_namespaces() {
        let root = root();
        enable(&root,"test.owner","LuckyRay.register(()=>LuckyRay.call('data.set',{schemaVersion:1,revision:1,settings:{secret:'owner'},cache:{}}));");
        enable(
            &root,
            "test.other",
            "LuckyRay.register(()=>LuckyRay.call('data.get')); ",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.owner");
        pending(&mut b, &root, &t);
        b.dispatch(&root, "1.9.2", &t, None, |_, _| panic!())
            .unwrap();
        b.close(&t);
        let t = start(&mut b, &root, "test.other");
        pending(&mut b, &root, &t);
        let response = b
            .dispatch(&root, "1.9.2", &t, None, |_, _| panic!())
            .unwrap();
        assert_eq!(response["response"]["value"]["settings"], json!({}));
        assert_eq!(response["response"]["value"]["revision"], 0);
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
}
