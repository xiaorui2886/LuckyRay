//! Real native HTTP/SQLite paths against a synthetic loopback server; no GPU/profile.
use super::*;
use std::{io::{Read, Write}, net::TcpListener, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU8, Ordering}}, thread};

fn execution() -> Value {
    serde_json::json!({"format":"luckyray.comfy-execution","version":1,"images":[],"output":{"nodeId":"777","kind":"video"},"graph":{
        "501":{"class_type":"SyntheticVideo","inputs":{"prompt":"synthetic","width":608,"height":352,"frames":97,"seed":17,"steps":6}},
        "777":{"class_type":"VHS_VideoCombine","inputs":{"images":["501",0],"audio":["501",1],"frame_rate":24,"filename_prefix":"synthetic","format":"video/h264-mp4","save_output":true}}
    }})
}
fn info() -> Value {
    serde_json::json!({"SyntheticVideo":{"input":{"required":{"prompt":["STRING"],"width":["INT",{"min":64,"max":4096}],"height":["INT",{"min":64,"max":4096}],"frames":["INT",{"min":1,"max":1000}],"seed":["INT"],"steps":["INT",{"min":1,"max":50}]}},"output":["IMAGE","AUDIO"]},
        "VHS_VideoCombine":{"input":{"required":{"images":["IMAGE"],"audio":["AUDIO"],"frame_rate":["FLOAT",{"min":1,"max":60}],"filename_prefix":["STRING"],"format":[["video/h264-mp4"]],"save_output":["BOOLEAN"]}},"output":[]}})
}
#[derive(Default)]
struct Observed { calls: Vec<(String,String)>, prompts: Vec<Value> }
struct Server { base: String, phase: Arc<AtomicU8>, prompt_mode: Arc<AtomicU8>, observed: Arc<Mutex<Observed>>, stop: Arc<AtomicBool>, thread: Option<thread::JoinHandle<()>> }
impl Server {
    fn new() -> Self {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
        let base=format!("http://{}",listener.local_addr().unwrap());
        let phase=Arc::new(AtomicU8::new(0));let prompt_mode=Arc::new(AtomicU8::new(0));
        let observed=Arc::new(Mutex::new(Observed::default()));let stop=Arc::new(AtomicBool::new(false));
        let (p,m,o,s)=(phase.clone(),prompt_mode.clone(),observed.clone(),stop.clone());
        let thread=thread::spawn(move||while !s.load(Ordering::Relaxed) {
            let (mut stream,_)=match listener.accept(){Ok(v)=>v,Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{thread::sleep(Duration::from_millis(2));continue;},Err(e)=>panic!("{e}")};
            // Windows inherits the nonblocking listener mode on accepted sockets.
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request=Vec::new();let mut buffer=[0u8;4096];
            let header_end=loop {let n=stream.read(&mut buffer).unwrap();if n==0{break None;}request.extend_from_slice(&buffer[..n]);assert!(request.len()<256*1024);if let Some(i)=request.windows(4).position(|w|w==b"\r\n\r\n"){break Some(i+4);}};
            let Some(header_end)=header_end else{continue;};
            let header=String::from_utf8_lossy(&request[..header_end]).to_string();let mut parts=header.lines().next().unwrap().split_whitespace();
            let method=parts.next().unwrap().to_owned();let path=parts.next().unwrap().to_owned();
            let length=header.lines().find_map(|line|line.split_once(':').filter(|(k,_)|k.eq_ignore_ascii_case("content-length")).map(|(_,v)|v.trim().parse::<usize>().unwrap())).unwrap_or(0);
            while request.len()<header_end+length{let n=stream.read(&mut buffer).unwrap();assert!(n>0);request.extend_from_slice(&buffer[..n]);}
            o.lock().unwrap().calls.push((method.clone(),path.clone()));
            let mut code=200;let mut content_type="application/json";
            let body=if method=="POST"&&path=="/prompt" {
                o.lock().unwrap().prompts.push(serde_json::from_slice(&request[header_end..header_end+length]).unwrap());
                match m.load(Ordering::Relaxed){1=>continue,2=>{code=400;b"{}".to_vec()},_=>br#"{"prompt_id":"fixture-prompt"}"#.to_vec()}
            }else if p.load(Ordering::Relaxed)==3 {code=503;b"{}".to_vec()}
            else if path=="/object_info"{serde_json::to_vec(&info()).unwrap()}
            else if path=="/history/fixture-prompt"{
                let value=match p.load(Ordering::Relaxed){
                    2=>serde_json::json!({"fixture-prompt":{"outputs":{"999":{"gifs":[{"filename":"wrong.mp4","type":"output"}]},"777":{"gifs":[{"filename":"clip.mp4","subfolder":"synthetic","type":"output"}]}},"status":{"status_str":"success","completed":true}}}),
                    5=>serde_json::json!({"fixture-prompt":{"status":{"status_str":"error","messages":[["execution_error",{"exception_message":"synthetic failure"}]]}}}),
                    _=>serde_json::json!({})};serde_json::to_vec(&value).unwrap()
            }else if path=="/queue"{serde_json::to_vec(&match p.load(Ordering::Relaxed){0=>serde_json::json!({"queue_pending":[[0,"fixture-prompt"]],"queue_running":[]}),1=>serde_json::json!({"queue_pending":[],"queue_running":[[0,"fixture-prompt"]]}),_=>serde_json::json!({"queue_pending":[],"queue_running":[]})}).unwrap()}
            else if path.starts_with("/view?"){content_type="video/mp4";b"\x00\x00\x00\x18ftypisom0000".to_vec()}
            else{code=405;b"{}".to_vec()};
            let response=format!("HTTP/1.1 {code} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            let _=stream.write_all(response.as_bytes()).and_then(|_|stream.write_all(&body));
        });
        Self{base,phase,prompt_mode,observed,stop,thread:Some(thread)}
    }
    fn request(&self,id:&str,workflow:Value)->SubmitRequest {SubmitRequest{client_task_id:id.into(),base_url:self.base.clone(),workflow,images:vec![],image_sources:vec![],resume_only:false}}
    fn posts(&self)->usize{self.observed.lock().unwrap().prompts.len()}
}
impl Drop for Server{fn drop(&mut self){self.stop.store(true,Ordering::Relaxed);if self.thread.take().unwrap().join().is_err()&&!thread::panicking(){panic!("synthetic HTTP server failed");}}}
fn database()->tempfile::NamedTempFile{let db=tempfile::NamedTempFile::new().unwrap();Connection::open(db.path()).unwrap().execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").unwrap();db}

#[tokio::test]
async fn custom_video_http_mapping_disconnect_reopen_and_download_keep_one_identity(){
    let server=Server::new();let db=database();let graph=execution();
    assert!(preflight(&server.base,&graph).await.unwrap().ready);
    let job=submit(db.path(),server.request("template-recovery",graph.clone())).await.unwrap();assert_eq!(job.state,"queued");
    let sent=server.observed.lock().unwrap().prompts[0].clone();assert_eq!(sent["prompt"],graph["graph"]);assert_eq!(sent["client_id"],"luckyray-template-recovery");
    server.phase.store(1,Ordering::Relaxed);assert_eq!(status(db.path(),"template-recovery").await.unwrap().state,"running");
    server.phase.store(3,Ordering::Relaxed);assert!(status(db.path(),"template-recovery").await.is_err());
    assert_eq!(read_job(&ledger(db.path()).unwrap(),"template-recovery").unwrap().job.prompt_id.as_deref(),Some("fixture-prompt"));
    // Every native entry reopens SQLite; no in-memory task object is reused.
    server.phase.store(2,Ordering::Relaxed);
    assert_eq!(submit(db.path(),server.request("template-recovery",graph.clone())).await.unwrap().prompt_id.as_deref(),Some("fixture-prompt"));
    let dir=tempfile::tempdir().unwrap();let result=materialize(db.path(),"template-recovery",dir.path()).await.unwrap();
    assert_eq!(result.state,"succeeded");assert!(Path::new(result.video_path.as_deref().unwrap()).exists());
    let calls=server.observed.lock().unwrap().calls.len();
    assert_eq!(materialize(db.path(),"template-recovery",dir.path()).await.unwrap().video_path,result.video_path);
    assert_eq!(server.observed.lock().unwrap().calls.len(),calls,"durable materialized result needs no HTTP");
    let mut changed=graph;changed["graph"]["501"]["inputs"]["seed"]=serde_json::json!(99);
    assert_eq!(submit(db.path(),server.request("template-recovery",changed)).await.err(),Some("comfyui-submission-binding-changed"));
    assert_eq!(server.posts(),1);
    let observed=server.observed.lock().unwrap();assert!(observed.calls.iter().any(|(_,p)|p.contains("filename=clip.mp4")));
    assert!(!observed.calls.iter().any(|(m,p)|p.contains("wrong.mp4")||p=="/interrupt"||m=="DELETE"));
}

#[tokio::test]
async fn concurrent_template_submissions_claim_once(){
    let server=Server::new();let db=database();let graph=execution();
    let (a,b)=tokio::join!(submit(db.path(),server.request("template-duplicate",graph.clone())),submit(db.path(),server.request("template-duplicate",graph)));
    assert!(a.is_ok()&&b.is_ok());assert_eq!(server.posts(),1);
}

#[tokio::test]
async fn uncertain_or_missing_provider_task_is_never_reposted(){
    let server=Server::new();let db=database();server.prompt_mode.store(1,Ordering::Relaxed);
    let request=execution();let job=submit(db.path(),server.request("template-uncertain",request.clone())).await.unwrap();assert_eq!(job.state,"unknown");
    assert_eq!(status(db.path(),"template-uncertain").await.unwrap().state,"unknown");
    assert_eq!(submit(db.path(),server.request("template-uncertain",request)).await.unwrap().state,"unknown");assert_eq!(server.posts(),1);
    server.prompt_mode.store(0,Ordering::Relaxed);
    submit(db.path(),server.request("template-missing",execution())).await.unwrap();server.phase.store(4,Ordering::Relaxed);
    assert_eq!(status(db.path(),"template-missing").await.unwrap().state,"unknown");
    assert_eq!(submit(db.path(),server.request("template-missing",execution())).await.unwrap().state,"unknown");assert_eq!(server.posts(),2);
}

#[tokio::test]
async fn invalid_parameter_or_failed_execution_does_not_resubmit(){
    let server=Server::new();let db=database();let mut graph=execution();graph["graph"]["501"]["inputs"]["width"]=serde_json::json!(32);
    assert_eq!(submit(db.path(),server.request("template-invalid",graph)).await.err(),Some("comfyui-preflight-failed"));assert_eq!(server.posts(),0);
    submit(db.path(),server.request("template-failed",execution())).await.unwrap();server.phase.store(5,Ordering::Relaxed);
    assert_eq!(status(db.path(),"template-failed").await.unwrap().state,"failed");
    assert_eq!(submit(db.path(),server.request("template-failed",execution())).await.unwrap().state,"failed");assert_eq!(server.posts(),1);
}
