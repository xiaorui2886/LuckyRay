//! Native services for explicitly fully-trusted desktop extensions.
//! Identity/lease checks prevent stale calls; main-realm code is NOT isolated from other trusted code.
use crate::extension_packages_store::{self as store,State};
use base64::{engine::general_purpose::STANDARD as B64,Engine as _};
use serde_json::{json,Value};
use std::{collections::{BTreeMap,HashMap,VecDeque},fs,io::{Read,Write},path::{Path,PathBuf},sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,Ordering}},time::Duration};
use tauri::{Manager,Emitter};
#[cfg(all(windows,feature="browser-host-runtime"))]
use std::sync::atomic::AtomicU64;
const IO_LIMIT:usize=16*1024*1024;
struct Lease { id:String,digest:String,epoch:u64,live:AtomicBool,requests:Mutex<HashMap<String,Arc<AtomicBool>>>,cancelled:Mutex<VecDeque<String>>,
 #[cfg(all(windows,feature="browser-host-runtime"))] processes:Mutex<HashMap<String,Arc<Mutex<DesktopProcess>>>>,
 #[cfg(all(windows,feature="browser-host-runtime"))] terminals:Mutex<TerminalCache>,
}
#[cfg(all(windows,feature="browser-host-runtime"))]
#[derive(Default)]
struct TerminalCache { entries: VecDeque<(String,u64,Value)> }
#[cfg(all(windows,feature="browser-host-runtime"))]
impl TerminalCache {
 fn get(&self,handle:&str)->Option<&Value>{self.entries.iter().find(|(key,_,_)|key==handle).map(|(_,_,value)|value)}
 fn insert(&mut self,handle:String,finished_at:u64,value:Value){
  // A concurrent duplicate poll must neither refresh nor duplicate a result.
  if self.entries.iter().any(|(key,_,_)|key==&handle){return;}
  let position=self.entries.iter().position(|(_,time,_)|*time>finished_at).unwrap_or(self.entries.len());
  self.entries.insert(position,(handle,finished_at,value));
  if self.entries.len()>128{self.entries.pop_front();}
 }
}
pub(crate) fn lifecycle_gate()->&'static Mutex<()>{static G:OnceLock<Mutex<()>>=OnceLock::new();G.get_or_init(||Mutex::new(()))}
fn leases()->&'static Mutex<HashMap<String,Arc<Lease>>>{static S:OnceLock<Mutex<HashMap<String,Arc<Lease>>>>=OnceLock::new();S.get_or_init(Default::default)}
fn token()->String{rand::random::<[u8;16]>().iter().map(|b|format!("{b:02x}")).collect()}
fn string<'a>(v:&'a Value,key:&str)->Result<&'a str,String>{v.get(key).and_then(Value::as_str).ok_or_else(||"desktop-extension-parameters".into())}
fn active(l:&Lease,state:&State)->bool{l.live.load(Ordering::Acquire)&&state.packages.iter().any(|e|e.package.manifest.id==l.id&&e.package.manifest.kind=="desktop"&&e.enabled&&store::compatible(&e.package,env!("CARGO_PKG_VERSION"))&&e.digest==l.digest&&e.epoch==l.epoch&&e.grants.iter().any(|g|g=="desktop.fullTrust"))}
impl Lease {
 fn retire(&self){self.live.store(false,Ordering::Release);if let Ok(requests)=self.requests.lock(){for flag in requests.values(){flag.store(true,Ordering::Release);}}
  #[cfg(all(windows,feature="browser-host-runtime"))]
  if let Ok(mut processes)=self.processes.lock(){for (_,p) in processes.drain(){if let Ok(mut p)=p.lock(){p.stop();}}}
 }
}
impl Drop for Lease{fn drop(&mut self){self.retire();}}
pub(crate) fn retain_current(state:&State){let retired=if let Ok(mut all)=leases().lock(){let keys:Vec<_>=all.iter().filter(|(_,l)|!active(l,state)).map(|(k,_)|k.clone()).collect();keys.into_iter().filter_map(|k|all.remove(&k)).collect::<Vec<_>>()}else{vec![]};for l in retired{l.retire();}}
pub(crate) fn close_all(){let old=leases().lock().map(|mut a|a.drain().map(|(_,v)|v).collect::<Vec<_>>()).unwrap_or_default();for l in old{l.retire();}}
fn authorized(root:&Path,key:&str)->Result<Arc<Lease>,String>{let l=leases().lock().map_err(|_|"desktop-extension-lock")?.get(key).cloned().ok_or("desktop-extension-retired")?;let state=store::manage(root,env!("CARGO_PKG_VERSION"),store::Request::List)?;if !active(&l,&state){l.retire();return Err("desktop-extension-retired".into());}Ok(l)}
fn path(v:&Value,key:&str)->Result<PathBuf,String>{let s=string(v,key)?;if s.contains('\0')||s.len()>32760{return Err("desktop-extension-path".into());}let p=PathBuf::from(s);if !p.is_absolute(){return Err("desktop-extension-absolute-path-required".into());}Ok(p)}
#[tauri::command]
pub(crate) async fn desktop_extension_runtime(app:tauri::AppHandle,caller:tauri::Webview,request:String)->Result<Value,String>{
 if caller.label()!="main"{return Err("desktop-extension-main-required".into());}
 if request.len()>IO_LIMIT*2{return Err("desktop-extension-input-limit".into());}
 let v:Value=serde_json::from_str(&request).map_err(|_|"desktop-extension-parameters")?;
 let root=app.path().app_data_dir().map_err(|_|"desktop-extension-storage")?;
 let op=string(&v,"op")?.to_string();
 if op=="resetMain"{let _admission=lifecycle_gate().lock().map_err(|_|"desktop-extension-lock")?;close_all();return Ok(Value::Null);}
 if op=="open"{
  let _admission=lifecycle_gate().lock().map_err(|_|"desktop-extension-lock")?;
  let state=store::manage(&root,env!("CARGO_PKG_VERSION"),store::Request::List)?;
  let l=Arc::new(Lease{id:string(&v,"id")?.into(),digest:string(&v,"digest")?.into(),epoch:v["epoch"].as_u64().ok_or("desktop-extension-parameters")?,live:AtomicBool::new(true),requests:Mutex::new(HashMap::new()),cancelled:Mutex::new(VecDeque::new()),
   #[cfg(all(windows,feature="browser-host-runtime"))] processes:Mutex::new(HashMap::new()),
   #[cfg(all(windows,feature="browser-host-runtime"))] terminals:Mutex::new(TerminalCache::default()),
  });
  if !active(&l,&state){return Err("desktop-extension-trust-required".into());}
  let mut all=leases().lock().map_err(|_|"desktop-extension-lock")?;
  if all.values().any(|old|old.id==l.id&&old.live.load(Ordering::Acquire)){return Err("desktop-extension-already-running".into());}
  let key=token();all.insert(key.clone(),l);return Ok(json!(key));
 }
 let key=string(&v,"lease")?;
 if op=="close"{let l=leases().lock().map_err(|_|"desktop-extension-lock")?.remove(key);if let Some(l)=l{l.retire();}return Ok(Value::Null);}
 let lease=authorized(&root,key)?;
 if op=="cancelRequest"{
  let id=string(&v,"requestId")?.to_string();if let Some(flag)=lease.requests.lock().map_err(|_|"desktop-extension-lock")?.get(&id){flag.store(true,Ordering::Release);}
  let mut cancelled=lease.cancelled.lock().map_err(|_|"desktop-extension-lock")?;cancelled.push_back(id);while cancelled.len()>256{cancelled.pop_front();}return Ok(Value::Null);
 }
 if op=="request"{return http_request(lease,v).await;}
 if op=="aiGenerate"{return ai_generate(app,lease,root,v).await;}
 tauri::async_runtime::spawn_blocking(move||dispatch_blocking(&lease,&op,&v)).await.map_err(|_|"desktop-extension-worker".to_string())?
}
async fn http_request(l:Arc<Lease>,v:Value)->Result<Value,String>{
 let id=string(&v,"requestId")?.to_string();if id.len()>80{return Err("desktop-extension-parameters".into());}
 let url=reqwest::Url::parse(string(&v,"url")?).map_err(|_|"desktop-extension-url")?;
 if !matches!(url.scheme(),"http"|"https")||!url.username().is_empty()||url.password().is_some(){return Err("desktop-extension-url".into());}
 let cancel=Arc::new(AtomicBool::new(false));
 {let mut requests=l.requests.lock().map_err(|_|"desktop-extension-lock")?;if requests.len()>=16||requests.contains_key(&id){return Err("desktop-extension-request-limit".into());}requests.insert(id.clone(),cancel.clone());}
 if l.cancelled.lock().map_err(|_|"desktop-extension-lock")?.contains(&id){cancel.store(true,Ordering::Release);}
 if !l.live.load(Ordering::Acquire)||cancel.load(Ordering::Acquire){if let Ok(mut requests)=l.requests.lock(){requests.remove(&id);}return Err("desktop-extension-cancelled".into());}
 let operation=async{
  let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_millis(v["timeoutMs"].as_u64().unwrap_or(60000).clamp(100,300000))).build().map_err(|_|"desktop-extension-network")?;
  let method=reqwest::Method::from_bytes(v["method"].as_str().unwrap_or("GET").as_bytes()).map_err(|_|"desktop-extension-method")?;
  let mut request=client.request(method,url);
  if let Some(headers)=v["headers"].as_object(){if headers.len()>128{return Err("desktop-extension-header-limit".to_string());}for(k,value)in headers{request=request.header(k,string_value(value)?);}}
  if let Some(body)=v["body"].as_str(){if body.len()>IO_LIMIT{return Err("desktop-extension-input-limit".into());}request=request.body(body.to_owned());}
  let mut response=request.send().await.map_err(|_|"desktop-extension-network")?;
  let status=response.status().as_u16();let headers:BTreeMap<_,_>=response.headers().iter().filter_map(|(k,v)|v.to_str().ok().map(|v|(k.as_str().to_string(),v.to_string()))).collect();
  let mut body=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"desktop-extension-network")?{if body.len()+chunk.len()>IO_LIMIT{return Err("desktop-extension-response-limit".into());}body.extend_from_slice(&chunk);}
  Ok(json!({"status":status,"headers":headers,"body":B64.encode(body)}))
 };
 let cancelled=async{loop{if !l.live.load(Ordering::Acquire)||cancel.load(Ordering::Acquire){return;}tokio::time::sleep(Duration::from_millis(20)).await;}};
 let result=tokio::select!{r=operation=>r,_=cancelled=>Err("desktop-extension-cancelled".into())};
 if let Ok(mut requests)=l.requests.lock(){requests.remove(&id);}result
}
fn string_value(v:&Value)->Result<&str,String>{v.as_str().ok_or_else(||"desktop-extension-parameters".into())}
fn dispatch_blocking(l:&Arc<Lease>,op:&str,v:&Value)->Result<Value,String>{
 if !l.live.load(Ordering::Acquire){return Err("desktop-extension-retired".into());}
 match op{
  "readFile"=>{let mut file=fs::File::open(path(v,"path")?).map_err(|_|"desktop-extension-read")?;let mut bytes=Vec::new();Read::by_ref(&mut file).take((IO_LIMIT+1)as u64).read_to_end(&mut bytes).map_err(|_|"desktop-extension-read")?;if bytes.len()>IO_LIMIT{return Err("desktop-extension-file-limit".into());}Ok(json!({"base64":B64.encode(bytes)}))},
  "writeFile"=>{let p=path(v,"path")?;let bytes=B64.decode(string(v,"base64")?).map_err(|_|"desktop-extension-base64")?;if bytes.len()>IO_LIMIT{return Err("desktop-extension-file-limit".into());}let overwrite=v["overwrite"].as_bool().unwrap_or(false);let mut f=fs::OpenOptions::new().write(true).create(overwrite).create_new(!overwrite).truncate(overwrite).open(p).map_err(|_|"desktop-extension-write")?;f.write_all(&bytes).and_then(|_|f.sync_all()).map_err(|_|"desktop-extension-write")?;Ok(Value::Null)},
  "listDirectory"=>{let mut rows=Vec::new();for entry in fs::read_dir(path(v,"path")?).map_err(|_|"desktop-extension-read")?{let e=entry.map_err(|_|"desktop-extension-read")?;if rows.len()>=20000{return Err("desktop-extension-directory-limit".into());}rows.push(json!({"name":e.file_name().to_string_lossy(),"directory":e.file_type().map_err(|_|"desktop-extension-read")?.is_dir()}));}Ok(json!(rows))},
  "createDirectory"=>{fs::create_dir(path(v,"path")?).map_err(|_|"desktop-extension-mkdir")?;Ok(Value::Null)},
  "rename"=>{rename_no_replace(&path(v,"from")?,&path(v,"to")?)?;Ok(Value::Null)},
  "removeFile"=>{fs::remove_file(path(v,"path")?).map_err(|_|"desktop-extension-remove")?;Ok(Value::Null)},
  "spawn"|"poll"|"stdin"|"closeInput"|"kill"=>process_operation(l,op,v),
  _=>Err("desktop-extension-operation".into()),
 }
}
#[cfg(not(all(windows,feature="browser-host-runtime")))]
fn process_operation(_: &Arc<Lease>,_:&str,_:&Value)->Result<Value,String>{Err("desktop-extension-process-platform-unsupported".into())}
#[cfg(all(windows,feature="browser-host-runtime"))]
struct Output {events:VecDeque<Value>,bytes:usize,sequence:u64,overflow:bool,readers:u8}
#[cfg(all(windows,feature="browser-host-runtime"))]
struct DesktopProcess {process:crate::owned_process::OwnedProcess,job:Arc<crate::owned_process::OwnedJob>,input:Option<Arc<Mutex<fs::File>>>,output:Arc<Mutex<Output>>,observed_finish:Option<u64>}
// This sequence is when the host first observes the whole job and its output
// readers settled. Closely spaced completions can be observed in either order;
// it must not be presented as an exact OS-recorded job exit time.
#[cfg(all(windows,feature="browser-host-runtime"))]
static FINISH_SEQUENCE:AtomicU64=AtomicU64::new(1);
#[cfg(all(windows,feature="browser-host-runtime"))]
fn observe_finished(process:&mut DesktopProcess)->Option<u64>{
 if process.observed_finish.is_some(){return process.observed_finish;}
 if !matches!(process.process.exit_code(),Ok(Some(_)))||!process.job.settled(){return None;}
 let readers=process.output.lock().ok()?.readers;
 if readers!=0{return None;}
 let order=FINISH_SEQUENCE.fetch_add(1,Ordering::Relaxed);process.observed_finish=Some(order);Some(order)
}
// The observer holds only a weak reference between checks, so retiring a lease
// still tears down its owned process; it never consumes stdout/stderr.
#[cfg(all(windows,feature="browser-host-runtime"))]
fn start_finish_observer(process:&Arc<Mutex<DesktopProcess>>)->std::io::Result<()>{
 let weak=Arc::downgrade(process);
 std::thread::Builder::new().name("desktop-extension-finish".into()).spawn(move||loop{
  let done={let Some(process)=weak.upgrade() else {break};let result=match process.lock(){Ok(mut p)=>observe_finished(&mut p).is_some(),Err(_)=>true};result};
  if done{break;}std::thread::sleep(Duration::from_millis(25));
 }).map(|_|())
}
#[cfg(all(windows,feature="browser-host-runtime"))]
impl DesktopProcess{fn stop(&mut self)->bool{self.input.take();self.job.terminate_and_wait(Duration::from_secs(2))}}
#[cfg(all(windows,feature="browser-host-runtime"))]
impl Drop for DesktopProcess{fn drop(&mut self){self.stop();}}
#[cfg(all(windows,feature="browser-host-runtime"))]
fn read_output(mut file:fs::File,name:&'static str,out:Arc<Mutex<Output>>,job:Arc<crate::owned_process::OwnedJob>){std::thread::spawn(move||{
 let mut bytes=[0;8192];loop{match file.read(&mut bytes){Ok(0)|Err(_)=>break,Ok(n)=>{
  let mut o=match out.lock(){Ok(o)=>o,Err(_)=>break};if o.bytes+n>4*1024*1024{o.overflow=true;drop(o);job.terminate();break;}
  o.sequence+=1;let sequence=o.sequence;o.bytes+=n;o.events.push_back(json!({"sequence":sequence,"stream":name,"base64":B64.encode(&bytes[..n])}));
 }}}
 if let Ok(mut o)=out.lock(){o.readers=o.readers.saturating_sub(1);}
});}
#[cfg(all(windows,feature="browser-host-runtime"))]
fn inherited_process_environment(entries:impl IntoIterator<Item=(std::ffi::OsString,std::ffi::OsString)>)->BTreeMap<std::ffi::OsString,std::ffi::OsString>{
 use std::os::windows::ffi::OsStrExt;
 // Windows can expose per-drive working-directory pseudo-entries beginning
 // with '='. They are not valid ordinary environment names for our encoder.
 // Explicit extension overrides still pass through its strict validation.
 entries.into_iter().filter(|(key,value)|{
  let key:Vec<u16>=key.encode_wide().collect();
  !key.is_empty()&&!key.contains(&0)&&!key.contains(&(b'=' as u16))&&!value.encode_wide().any(|unit|unit==0)
 }).collect()
}
#[cfg(all(windows,feature="browser-host-runtime"))]
fn process_operation(l:&Arc<Lease>,op:&str,v:&Value)->Result<Value,String>{
 if op=="spawn"{
  let executable=path(v,"executable")?;let cwd=path(v,"cwd")?;
  if !executable.is_file()||!cwd.is_dir(){return Err("desktop-extension-process-path".into());}
  let args=v.get("args").and_then(Value::as_array).cloned().unwrap_or_default();if args.len()>256{return Err("desktop-extension-argument-limit".into());}
  let args:Vec<std::ffi::OsString>=args.iter().map(|v|string_value(v).map(Into::into)).collect::<Result<_,_>>()?;
  let mut environment=inherited_process_environment(std::env::vars_os());
  if let Some(env)=v.get("env").and_then(Value::as_object){if env.len()>256{return Err("desktop-extension-env-limit".into());}for(k,v)in env{environment.insert(k.into(),string_value(v)?.into());}}
  // Serialize admission through spawn/publication only; no wait for user child I/O.
  let mut processes=l.processes.lock().map_err(|_|"desktop-extension-lock")?;
  if processes.len()>=16||!l.live.load(Ordering::Acquire){return Err("desktop-extension-process-limit".into());}
  let spawned=crate::owned_process::spawn_in_owned_job_with_argv_detailed(&executable,&args,&cwd,environment.into_iter().collect(),false).map_err(|e|match e.code{Some(code)=>format!("desktop-extension-spawn:{}:{code}",e.stage),None=>format!("desktop-extension-spawn:{}",e.stage)})?;
  let job=Arc::new(spawned.job);let output=Arc::new(Mutex::new(Output{events:VecDeque::new(),bytes:0,sequence:0,overflow:false,readers:2}));
  let mut process=DesktopProcess{process:spawned.process,job:job.clone(),input:Some(Arc::new(Mutex::new(spawned.stdin))),output:output.clone(),observed_finish:None};
  read_output(spawned.stdout,"stdout",output.clone(),job.clone());read_output(spawned.stderr,"stderr",output,job);
  if !l.live.load(Ordering::Acquire){process.stop();return Err("desktop-extension-retired".into());}
  let handle=token();let process=Arc::new(Mutex::new(process));
  if start_finish_observer(&process).is_err(){return Err("desktop-extension-observer-start".into());}
  processes.insert(handle.clone(),process);return Ok(json!(handle));
 }
 let handle=string(v,"handle")?;
 // A caller may poll completed jobs in reverse order. Observe all currently
 // tracked jobs before looking up this handle, without draining their output.
 if op=="poll"{let tracked=l.processes.lock().map_err(|_|"desktop-extension-lock")?.values().cloned().collect::<Vec<_>>();
  for entry in tracked {if let Ok(mut process)=entry.try_lock(){observe_finished(&mut process);}}
 }
 if let Some(terminal)=l.terminals.lock().map_err(|_|"desktop-extension-lock")?.get(handle).cloned(){return match op {"poll"=>Ok(terminal),"kill"|"closeInput"=>Ok(Value::Null),_=>Err("desktop-extension-input-closed".into())};}
 let found={l.processes.lock().map_err(|_|"desktop-extension-lock")?.get(handle).cloned()};
 let p=match found{Some(p)=>p,None=>{
  // Another poll may have moved the result into the cache after our first lookup.
  if let Some(terminal)=l.terminals.lock().map_err(|_|"desktop-extension-lock")?.get(handle).cloned(){return match op{"poll"=>Ok(terminal),"kill"|"closeInput"=>Ok(Value::Null),_=>Err("desktop-extension-input-closed".into())};}
  return Err("desktop-extension-process-unavailable".into());
 }};
 if op=="stdin"{let bytes=B64.decode(string(v,"base64")?).map_err(|_|"desktop-extension-base64")?;if bytes.len()>65536{return Err("desktop-extension-input-limit".into());}
  let input=p.lock().map_err(|_|"desktop-extension-lock")?.input.clone().ok_or("desktop-extension-input-closed")?;
  input.lock().map_err(|_|"desktop-extension-lock")?.write_all(&bytes).map_err(|_|"desktop-extension-input-closed")?;return Ok(Value::Null);
 }
 let mut process=p.lock().map_err(|_|"desktop-extension-lock")?;
 match op{
  "closeInput"=>{process.input.take();Ok(Value::Null)},
  "kill"=>{let settled=process.stop();drop(process);if !settled{return Err("desktop-extension-process-not-settled".into());}l.processes.lock().map_err(|_|"desktop-extension-lock")?.remove(handle);Ok(Value::Null)},
  "poll"=>{
   let observed_finish=observe_finished(&mut process);
   let exit=process.process.exit_code().map_err(|_|"desktop-extension-exit")?;
   let mut out=process.output.lock().map_err(|_|"desktop-extension-lock")?;
   let settled=observed_finish.is_some()&&out.readers==0;let overflow=out.overflow;
   let finished_at=if settled&&exit.is_some(){observed_finish}else{None};
   let events:Vec<_>=out.events.drain(..).collect();out.bytes=0;
   let result=json!({"events":events,"exitCode":exit,"settled":settled,"overflow":overflow});
   drop(out);drop(process);
   if let Some(finished_at)=finished_at{
    let mut terminals=l.terminals.lock().map_err(|_|"desktop-extension-lock")?;
    terminals.insert(handle.to_string(),finished_at,json!({"events":[],"exitCode":exit,"settled":true,"overflow":overflow}));drop(terminals);
    l.processes.lock().map_err(|_|"desktop-extension-lock")?.remove(handle);
   }
   Ok(result)
  },
  _=>Err("desktop-extension-operation".into()),
 }
}

#[cfg(windows)]
fn rename_no_replace(from:&Path,to:&Path)->Result<(),String>{
 use std::os::windows::ffi::OsStrExt;
 use windows::core::PCWSTR;
 let from:Vec<u16>=from.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
 let to:Vec<u16>=to.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
 unsafe{windows::Win32::Storage::FileSystem::MoveFileW(PCWSTR(from.as_ptr()),PCWSTR(to.as_ptr())).map_err(|_|"desktop-extension-rename-target-or-io".to_string())}
}
#[cfg(not(windows))]
fn rename_no_replace(_from:&Path,_to:&Path)->Result<(),String>{Err("desktop-extension-rename-platform-unsupported".into())}

async fn ai_generate(app:tauri::AppHandle,l:Arc<Lease>,root:PathBuf,v:Value)->Result<Value,String>{
 let id=string(&v,"requestId")?.to_string();let prompt=string(&v,"prompt")?.to_string();
 if id.len()>80||prompt.trim().is_empty()||prompt.len()>16000{return Err("desktop-extension-ai-input".into());}
 let cancel=Arc::new(AtomicBool::new(false));
 {let mut requests=l.requests.lock().map_err(|_|"desktop-extension-lock")?;if requests.len()>=16||requests.contains_key(&id){return Err("desktop-extension-request-limit".into());}requests.insert(id.clone(),cancel.clone());}
 if l.cancelled.lock().map_err(|_|"desktop-extension-lock")?.contains(&id){cancel.store(true,Ordering::Release);}
 if !l.live.load(Ordering::Acquire)||cancel.load(Ordering::Acquire){if let Ok(mut requests)=l.requests.lock(){requests.remove(&id);}return Err("desktop-extension-cancelled".into());}
 let operation=async{
  let config=crate::load_ai_model_config_read_only(&root.join("luckyray.db")).map_err(|_|"desktop-extension-ai-unavailable")?;
  let secret=crate::normalize_ai_api_key(&config.api_key);
  let message=crate::AiChatRequestMessage{role:"user".into(),content:json!(prompt)};
  let text=if v["stream"].as_bool().unwrap_or(false){
   let request=crate::AiChatStreamRequest{stream_id:format!("desktop-{id}"),messages:vec![message],system_prompt:None,temperature:None,max_tokens:Some(4096)};
   let mut redactor=crate::extension_ai_redactor::Redactor::new(secret.clone());
   let mut total=0usize;
   let result=crate::ai_chat_stream_with_config(config,request,true,|event|{if let Some(delta)=event.delta{total=total.saturating_add(delta.len());if total>IO_LIMIT{cancel.store(true,Ordering::Release);return;}let delta=redactor.push(&delta,false);if !delta.is_empty(){let _=app.emit_to("main","luckyray:desktop:ai-delta",json!({"requestId":id,"delta":delta}));}}}).await.map_err(|_|"desktop-extension-ai-failed")?;
   if !result.success{return Err("desktop-extension-ai-failed".to_string());}
   let tail=redactor.push("",true);if !tail.is_empty(){let _=app.emit_to("main","luckyray:desktop:ai-delta",json!({"requestId":id,"delta":tail}));}
   result.content.unwrap_or_default()
  }else{
   let request=crate::AiChatRequest{messages:vec![message],system_prompt:None,temperature:None,max_tokens:Some(4096),model:None};
   let result=crate::plugin_ai_complete_transport(config,request,Duration::from_secs(60)).await.map_err(|_|"desktop-extension-ai-failed")?;
   if !result.success{return Err("desktop-extension-ai-failed".to_string());}result.content.unwrap_or_default()
  };
  if text.len()>IO_LIMIT{return Err("desktop-extension-ai-output-limit".into());}
  Ok(json!({"text":if secret.is_empty(){text}else{text.replace(&secret,"[redacted]")}}))
 };
 let cancelled=async{loop{if !l.live.load(Ordering::Acquire)||cancel.load(Ordering::Acquire){return;}tokio::time::sleep(Duration::from_millis(20)).await;}};
 let result=tokio::select!{r=operation=>r,_=cancelled=>Err("desktop-extension-cancelled".into()),_=tokio::time::sleep(Duration::from_secs(65))=>Err("desktop-extension-ai-timeout".into())};
 if let Ok(mut requests)=l.requests.lock(){requests.remove(&id);}result
}

#[cfg(test)]
mod acceptance;
