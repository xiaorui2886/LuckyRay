use crate::extension_broker::{Broker, Scope};
use crate::extension_packages_store::{self as store, Request, State};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;
fn broker() -> &'static Mutex<Broker> {
    static BROKER: OnceLock<Mutex<Broker>> = OnceLock::new();
    BROKER.get_or_init(|| Mutex::new(Broker::default()))
}
/// Retire every live session (fixture exit): workers are killed on drop, nothing is retried.
#[cfg(all(debug_assertions, feature = "extension-runtime-fixture"))]
pub(crate) fn close_all_sessions() {
    if let Ok(mut broker) = broker().lock() {
        broker.close_all();
    }
}
pub fn manage(root: &Path, host: &str, request: Request) -> Result<State, String> {
    let mut broker = broker().lock().map_err(|_| "plugin-host-lock")?;
    let result = store::manage(root, host, request);
    broker.sweep(root, host);
    result
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    Start {
        id: String,
        scope: Scope,
        event: Value,
    },
    Poll {
        token: String,
    },
    Dispatch {
        token: String,
        veto: Option<String>,
    },
    Close {
        token: String,
    },
}
#[tauri::command]
pub(crate) async fn extension_runtime(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    request: String,
) -> Result<Value, String> {
    // The host remains the main webview even while LSH shares its window.
    if caller.label() != "main" {
        return Err("plugin-host-window-required".into());
    }
    if request.len() > 40000 {
        return Err("plugin-input-limit".into());
    }
    let op: Operation = serde_json::from_str(&request).map_err(|_| "plugin-invalid-request")?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "plugin-storage-unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        // Slow domain I/O owns only its session, never the global management mutex.
        if let Operation::Dispatch { token, veto } = &op {
            let handle = broker()
                .lock()
                .map_err(|_| "plugin-host-lock")?
                .handle(token)?;
            return handle.dispatch(&root, env!("CARGO_PKG_VERSION"), veto.clone(), |s, call| {
                crate::extension_domains::dispatch(&root, s, call)
            });
        }
        let mut broker = broker().lock().map_err(|_| "plugin-host-lock")?;
        let host = env!("CARGO_PKG_VERSION");
        match op {
            Operation::Start { id, scope, event } => broker
                .start(
                    &root,
                    host,
                    &std::env::current_exe().map_err(|_| "plugin-executable")?,
                    &id,
                    scope,
                    event,
                )
                .map(|token| json!({"token":token})),
            Operation::Poll { token } => broker.poll(&root, host, &token),
            Operation::Dispatch { .. } => unreachable!(),
            Operation::Close { token } => {
                broker.close(&token);
                Ok(Value::Null)
            }
        }
    })
    .await
    .map_err(|_| "plugin-worker-failed")?
}
