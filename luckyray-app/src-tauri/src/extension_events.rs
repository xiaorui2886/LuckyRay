//! Bridges committed host operations to the scoped, non-blocking event queue.
use crate::extension_broker::{Rpc, Session};
use crate::extension_event_hub::{Claim, EventHub, SourceEvent};
use crate::extension_packages_store::{self as store, Request, State};
use serde_json::{json, Value};
use std::{path::Path, sync::{Mutex, OnceLock}};
use tauri::Emitter;

fn hub()->&'static Mutex<EventHub> { static HUB:OnceLock<Mutex<EventHub>>=OnceLock::new(); HUB.get_or_init(||Mutex::new(EventHub::default())) }
pub fn retain_current(state:&State) { if let Ok(mut hub)=hub().lock() { hub.retain_current(state); } }
pub fn dispatch(session:&Session, rpc:&Rpc)->Result<Value,String> {
    let kind=rpc.params.get("type").and_then(Value::as_str).ok_or("plugin-parameters")?;
    let mut hub=hub().lock().map_err(|_|"plugin-event-unavailable")?;
    match rpc.method.as_str() {
        "events.subscribe" => hub.subscribe(&session.package,&session.scope,&session.contribution,kind)?,
        "events.unsubscribe" => hub.unsubscribe(&session.package.package.manifest.id,kind)?,
        _ => return Err("plugin-method-unavailable".into()),
    }
    Ok(json!({"type":kind,"subscribed":rpc.method == "events.subscribe"}))
}
pub fn claim(root:&Path,host:&str,token:&str)->Result<Claim,String> {
    if token.len()!=32 || !token.bytes().all(|c|c.is_ascii_hexdigit()) {return Err("plugin-event-unavailable".into());}
    let state=store::manage(root,host,Request::List)?;
    hub().lock().map_err(|_|"plugin-event-unavailable")?.claim(token,&state)
}
pub fn kinds(id:&str)->Result<Vec<String>,String> {
    hub().lock().map_err(|_|"plugin-event-unavailable".to_string()).map(|hub|hub.kinds(id))
}
pub fn cancel(id:&str,kind:&str)->Result<(),String> {
    hub().lock().map_err(|_|"plugin-event-unavailable")?.unsubscribe(id,kind)
}
pub fn active(id:&str,scope:&crate::extension_broker::Scope,event:&Value)->bool {
    let Some(digest)=scope.event_digest.as_deref() else {return false};
    let Some(epoch)=scope.event_epoch else {return false};
    let Some(contribution)=event.get("contribution").and_then(Value::as_str) else {return false};
    let Some(kind)=event.get("notification").and_then(|v|v.get("type")).and_then(Value::as_str) else {return false};
    hub().lock().is_ok_and(|hub|hub.active_generation(id,digest,epoch,contribution,kind,scope.event_subscription_generation.as_deref()))
}
fn emit(app:&tauri::AppHandle, source:SourceEvent<'_>) {
    let id=rand::random::<[u8;16]>().iter().map(|b|format!("{b:02x}")).collect::<String>();
    // Never delay or fail a completed save/import because a plugin is busy.
    let tokens=match hub().try_lock() { Ok(mut hub)=>hub.publish(&id,source),Err(_)=>return };
    for token in tokens {
        if app.emit_to("main","luckyray-plugin-event",token.clone()).is_err() {
            if let Ok(mut hub)=hub().try_lock() { hub.discard(&token); }
        }
    }
}
fn add_desktop_origins(payload:&mut Value,origins:Option<&[String]>) {
    let Some(origins)=origins else {return};
    // This is delivery metadata, never a reason to fail a completed write.
    let valid=origins.len()<=64 && origins.iter().all(|id| id=="*" || (!id.is_empty() && id.len()<=80 && id.bytes().all(|c|c.is_ascii_alphanumeric() || matches!(c,b'.'|b'_'|b'-'))));
    payload["__luckyrayEventOrigins"]=if valid {json!(origins)} else {json!(["*"])};
}
pub fn knowledge_saved(app:&tauri::AppHandle, document:&crate::knowledge::KnowledgeDocumentRef,origins:Option<&[String]>) {
    let mut payload=json!({"documentRef":{"vaultId":document.vault_id,"relativePath":document.relative_path}});
    add_desktop_origins(&mut payload,origins);
    let _=app.emit_to("main","luckyray:desktop:knowledge-saved",payload);
    emit(app,SourceEvent::Knowledge {vault_id:&document.vault_id,relative_path:&document.relative_path});
}
pub fn materials_imported(app:&tauri::AppHandle,library_id:&str,ids:&[String],origins:Option<&[String]>) {
    if !ids.is_empty() {
        let mut payload=json!({"libraryId":library_id,"ids":ids.iter().take(4096).collect::<Vec<_>>(),"truncated":ids.len()>4096});
        add_desktop_origins(&mut payload,origins);
        let _=app.emit_to("main","luckyray:desktop:materials-imported",payload);
        emit(app,SourceEvent::Materials {library_id,ids});
    }
}

pub fn discard(token:&str)->Result<(),String>{if token.len()!=32||!token.bytes().all(|b|b.is_ascii_hexdigit()){return Err("plugin-event-unavailable".into());}hub().lock().map_err(|_|"plugin-event-unavailable")?.discard(token);Ok(())}

#[cfg(test)]
mod desktop_origin_tests {
    use super::*;
    #[test]
    fn preserves_ordinary_payload_and_bounds_extension_origins() {
        let mut ordinary=json!({"documentRef":{"vaultId":"synthetic","relativePath":"note.md"}});
        add_desktop_origins(&mut ordinary,None);
        assert!(ordinary.get("__luckyrayEventOrigins").is_none());
        let mut from_extension=ordinary.clone();
        add_desktop_origins(&mut from_extension,Some(&["test.a".into(),"test.b".into()]));
        assert_eq!(from_extension["__luckyrayEventOrigins"],json!(["test.a","test.b"]));
        let mut oversized=ordinary.clone();
        add_desktop_origins(&mut oversized,Some(&vec!["test.a".into();65]));
        assert_eq!(oversized["__luckyrayEventOrigins"],json!(["*"]));
        let mut invalid=ordinary;
        add_desktop_origins(&mut invalid,Some(&["contains/path".into()]));
        assert_eq!(invalid["__luckyrayEventOrigins"],json!(["*"]));
    }
}
