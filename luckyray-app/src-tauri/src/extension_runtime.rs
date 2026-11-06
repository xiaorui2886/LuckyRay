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
    let _admission = crate::desktop_extension_runtime::lifecycle_gate().lock().map_err(|_|"plugin-host-lock")?;
    let mut broker = broker().lock().map_err(|_| "plugin-host-lock")?;
    let result = store::manage(root, host, request);
    broker.sweep(root, host);
    if let Ok(state) = &result { crate::extension_events::retain_current(state); crate::desktop_extension_runtime::retain_current(state); }
    result
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    AiSelection,
    ClaimEvent { token: String },
    DiscardEvent { token: String },
    EventSubscriptions { id: String },
    CancelEventSubscription { id: String, kind: String },
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
            let result = handle.dispatch(&root, env!("CARGO_PKG_VERSION"), veto.clone(), |s, call| {
                if matches!(call.method.as_str(), "ai.generate" | "ai.stream") {
                    crate::extension_ai::dispatch(&root, s, call)
                } else if matches!(call.method.as_str(), "events.subscribe" | "events.unsubscribe") {
                    crate::extension_events::dispatch(s, call)
                } else { crate::extension_domains::dispatch(&root, s, call) }
            });
            if let Ok(value) = &result {
                if matches!(value.get("method").and_then(Value::as_str),Some("events.unsubscribe"|"events.subscribe")) {
                    if let Some(kind)=value.get("response").and_then(|v|v.get("value")).and_then(|v|v.get("type")).and_then(Value::as_str) {
                        broker().lock().map_err(|_|"plugin-host-lock")?.cancel_event(handle.plugin_id(),kind);
                    }
                }
            }
            return result;
        }
        if let Operation::DiscardEvent { token } = &op { return crate::extension_events::discard(token).map(|_|Value::Null); }
        if let Operation::ClaimEvent { token } = &op {
            return crate::extension_events::claim(&root, env!("CARGO_PKG_VERSION"), token).map(|claim| json!(claim));
        }
        if let Operation::EventSubscriptions { id } = &op {
            return crate::extension_events::kinds(id).map(|kinds|json!(kinds));
        }
        let mut broker = broker().lock().map_err(|_| "plugin-host-lock")?;
        let host = env!("CARGO_PKG_VERSION");
        match op {
            Operation::AiSelection => crate::extension_ai::selection(&root).map(|value| json!(value)),
            Operation::Start { id, scope, event } => {
                if scope.event_delivery && !crate::extension_events::active(&id,&scope,&event) {
                    return Err("plugin-event-unavailable".into());
                }
                broker.start(
                    &root,
                    host,
                    &std::env::current_exe().map_err(|_| "plugin-executable")?,
                    &id,
                    scope,
                    event,
                )
                .map(|token| json!({"token":token}))
            },
            Operation::Poll { token } => broker.poll(&root, host, &token),
            Operation::Dispatch { .. } => unreachable!(),
            Operation::ClaimEvent { .. } => unreachable!(),
            Operation::DiscardEvent { .. } => unreachable!(),
            Operation::EventSubscriptions { .. } => unreachable!(),
            Operation::CancelEventSubscription { id, kind } => {
                crate::extension_events::cancel(&id,&kind)?;
                broker.cancel_event(&id,&kind);
                Ok(Value::Null)
            },
            Operation::Close { token } => {
                broker.close(&token);
                Ok(Value::Null)
            }
        }
    })
    .await
    .map_err(|_| "plugin-worker-failed")?
}
