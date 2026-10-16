//! Capability-free QuickJS worker. No loader, std/os module, DOM, network or Tauri.
//! Only bounded JSON RPC crosses stdout/stdin; the parent binds all authority.
use rquickjs::{Context, Function, Runtime};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
const MAX_WIRE: u64 = 2_200_000;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invocation {
    source: String,
    event: Value,
}
fn read_message() -> Result<String, String> {
    let mut line = String::new();
    let count = io::stdin()
        .lock()
        .take(MAX_WIRE + 1)
        .read_line(&mut line)
        .map_err(|_| "worker-input")?;
    if count == 0 || count as u64 > MAX_WIRE || !line.ends_with('\n') {
        return Err("worker-wire-limit".into());
    }
    Ok(line)
}
fn emit(value: &Value) -> Result<(), String> {
    let encoded = serde_json::to_string(value).map_err(|_| "worker-json")?;
    if encoded.len() as u64 > MAX_WIRE {
        return Err("worker-wire-limit".into());
    }
    let mut out = io::stdout().lock();
    writeln!(out, "{encoded}").map_err(|_| "worker-output")?;
    out.flush().map_err(|_| "worker-output".into())
}
fn execute() -> Result<Value, String> {
    let request: Invocation = serde_json::from_str(&read_message()?).map_err(|_| "worker-input")?;
    if request.source.len() > 131072 {
        return Err("worker-source-limit".into());
    }
    let runtime = Runtime::new().map_err(|_| "worker-engine")?;
    runtime.set_memory_limit(32 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let started = Instant::now();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        started.elapsed() > Duration::from_secs(3)
    })));
    let context = Context::full(&runtime).map_err(|_| "worker-context")?;
    let count = Arc::new(AtomicUsize::new(0));
    context.with(|ctx| -> Result<Value,String> {
        let call=Function::new(ctx.clone(),move |request:String| -> String {
            if request.len()>65536 || count.fetch_add(1,Ordering::Relaxed)>=64 {return json!({"error":"plugin-request-limit"}).to_string();}
            let message=serde_json::from_str::<Value>(&request).map_err(|_|"worker-json".to_string()).and_then(|request|emit(&json!({"kind":"call","request":request}))).and_then(|_|read_message());
            message.unwrap_or_else(|_|json!({"error":"plugin-channel-closed"}).to_string())
        }).map_err(|_|"worker-bridge")?;
        ctx.globals().set("__lr_call",call).map_err(|_|"worker-bridge")?;
        ctx.eval::<(),_>(r#"
          (() => {
            const transport = globalThis.__lr_call; delete globalThis.__lr_call;
            let handler = null;
            const call = async (method, params = {}) => {
              const response = JSON.parse(transport(JSON.stringify({method, params})));
              if (response.error) throw new Error(String(response.error));
              return response.value;
            };
            Object.defineProperty(globalThis, 'LuckyRay', {value:Object.freeze({
              apiVersion:1, call,
              register(fn) { if (handler || typeof fn !== 'function') throw Error('plugin-handler'); handler=fn; }
            }), configurable:false, writable:false});
            globalThis.__lr_run = (event) => Promise.resolve().then(() => {
              if (!handler) throw Error('plugin-handler-missing'); return handler(event);
            }).then(value => {globalThis.__lr_result=JSON.stringify({ok:true,value:value ?? null});},
              error => {globalThis.__lr_result=JSON.stringify({ok:false,error:String(error).slice(0,500)});});
          })();
        "#).map_err(|_|"worker-bootstrap")?;
        ctx.eval::<(),_>(request.source).map_err(|_|"plugin-evaluation-failed")?;
        ctx.eval::<(),_>(format!("__lr_run({})",serde_json::to_string(&request.event).unwrap())).map_err(|_|"plugin-event-failed")?;
        while ctx.execute_pending_job() {}
        let result:String=ctx.globals().get("__lr_result").map_err(|_|"plugin-unresolved-promise")?;
        serde_json::from_str(&result).map_err(|_|"plugin-result-invalid".into())
    })
}
pub fn run_stdio() {
    let result = execute().unwrap_or_else(|error| json!({"ok":false,"error":error}));
    let _ = emit(&json!({"kind":"result","result":result}));
}
