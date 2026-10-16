//! Host-owned invocation authority. Registry and session membership use the host mutex.
//! Domain I/O holds only its session lock; retirement does not wait for that lock.
use crate::extension_packages_store::{self as store, Installed, PluginData, Request};
use crate::extension_process::{Worker, WorkerControl};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    #[serde(default)]
    pub writes: bool,
    #[serde(default)]
    pub export_path: Option<String>,
    pub material_ids: Vec<String>,
    #[serde(default)]
    pub material_library_id: Option<String>,
    pub knowledge: Option<KnowledgeScope>,
    pub canvas_ids: Vec<String>,
    pub theme: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeScope {
    #[serde(default)]
    pub allow_create: bool,
    pub vault_id: String,
    pub source_epoch: u64,
    pub documents: Vec<String>,
    pub parent_relative_path: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rpc {
    pub method: String,
    pub params: Value,
}
pub struct Session {
    live: Arc<AtomicBool>,
    pub package: Installed,
    pub scope: Scope,
    pub images: BTreeMap<String, Value>,
    worker: Worker,
    pending: Option<Rpc>,
    started: Instant,
    pub receipts: Vec<Value>,
}
#[derive(Clone)]
pub struct SessionHandle {
    inflight: Arc<AtomicUsize>,
    session: Arc<Mutex<Session>>,
    live: Arc<AtomicBool>,
    control: WorkerControl,
    id: String,
    digest: String,
    epoch: u64,
    started: Instant,
}
impl SessionHandle {
    pub fn retire(&self) {
        self.live.store(false, Ordering::SeqCst);
        self.control.terminate();
    }
    pub fn dispatch<F>(
        &self,
        root: &Path,
        host: &str,
        veto: Option<String>,
        domain: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(&mut Session, &Rpc) -> Result<Value, String>,
    {
        let mut s = self.session.try_lock().map_err(|_| "plugin-session-busy")?;
        self.inflight
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                if n < 4 {
                    Some(n + 1)
                } else {
                    None
                }
            })
            .map_err(|_| "plugin-host-work-limit")?;
        struct Permit(Arc<AtomicUsize>);
        impl Drop for Permit {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _permit = Permit(self.inflight.clone());
        dispatch_session(&mut s, root, host, veto, domain)
    }
}
#[derive(Default)]
pub struct Broker {
    inflight: Arc<AtomicUsize>,
    sessions: BTreeMap<String, SessionHandle>,
}
impl Session {
    pub fn require_current(&self, root: &Path, host: &str) -> Result<(), String> {
        current(root, host, self)
    }
}

fn entry(root: &Path, host: &str, id: &str) -> Result<Installed, String> {
    store::manage(root, host, Request::List)?
        .packages
        .into_iter()
        .find(|p| p.package.manifest.id == id && p.package.manifest.kind == "script" && p.enabled)
        .ok_or("plugin-disabled".into())
}
fn current(root: &Path, host: &str, s: &Session) -> Result<(), String> {
    let now = entry(root, host, &s.package.package.manifest.id)?;
    if !s.live.load(Ordering::SeqCst)
        || now.digest != s.package.digest
        || now.epoch != s.package.epoch
        || s.started.elapsed() > Duration::from_secs(10)
    {
        return Err("plugin-retired".into());
    }
    Ok(())
}
fn id<'a>(rpc: &'a Rpc, key: &str) -> Result<&'a str, String> {
    rpc.params
        .get(key)
        .and_then(Value::as_str)
        .ok_or("plugin-parameters".into())
}
pub fn authorize(session: &Session, rpc: &Rpc) -> Result<(), String> {
    let keys: &[&str] = match rpc.method.as_str() {
        "data.get" | "ui.theme" | "materials.list" | "knowledge.selection" => &[],
        "materials.library.list" => &["libraryId", "requestId"],
        "materials.library.read" => &["libraryId", "requestId", "id"],
        "data.set" => &["schemaVersion", "revision", "settings", "cache"],
        "log" => &["message"],
        "materials.read" | "canvas.read" => &["id"],
        "materials.image.open" => &["id", "revision"],
        "materials.image.read" | "materials.image.release" => &["handle"],
        "materials.tags" => &["id", "revision", "tags"],
        "knowledge.read" => &["path"],
        "knowledge.create" => &["title", "content"],
        "knowledge.insert" => &["path", "revision", "offset", "text"],
        "canvas.export" => &["id", "digest"],
        _ => return Err("plugin-method-unavailable".into()),
    };
    if !rpc.params.is_object()
        || rpc
            .params
            .as_object()
            .unwrap()
            .keys()
            .any(|k| !keys.contains(&k.as_str()))
    {
        return Err("plugin-parameters".into());
    }

    let permission = match rpc.method.as_str() {
        "data.get" | "data.set" | "ui.theme" | "log" => return Ok(()),
        "materials.list" | "materials.read" | "materials.library.list" | "materials.library.read" => "materials.read",
        "materials.image.open" | "materials.image.read" | "materials.image.release" => {
            "materials.image"
        }
        "materials.tags" => "materials.tags",
        "knowledge.read" | "knowledge.selection" => "knowledge.read",
        "knowledge.create" => "knowledge.create",
        "knowledge.insert" => "knowledge.insert",
        "canvas.read" => "canvas.read",
        "canvas.export" => "canvas.export",
        _ => return Err("plugin-method-unavailable".into()),
    };
    if [
        "materials.tags",
        "knowledge.create",
        "knowledge.insert",
        "canvas.export",
    ]
    .contains(&rpc.method.as_str())
        && !session.scope.writes
    {
        return Err("plugin-write-confirmation-required".into());
    }
    if !session.package.grants.iter().any(|p| p == permission) {
        return Err("plugin-permission-denied".into());
    }
    if matches!(rpc.method.as_str(), "materials.library.list" | "materials.library.read") {
        let library = session.scope.material_library_id.as_deref().ok_or("plugin-object-denied")?;
        if id(rpc, "libraryId")? != library { return Err("plugin-object-denied".into()); }
    }
    if rpc.method.starts_with("materials.")
        && ![
            "materials.list",
            "materials.library.list",
            "materials.image.read",
            "materials.image.release",
        ]
        .contains(&rpc.method.as_str())
        && !session
            .scope
            .material_ids
            .iter()
            .any(|p| p == id(rpc, "id").unwrap_or(""))
    {
        return Err("plugin-object-denied".into());
    }
    if rpc.method.starts_with("canvas.")
        && !session
            .scope
            .canvas_ids
            .iter()
            .any(|p| p == id(rpc, "id").unwrap_or(""))
    {
        return Err("plugin-object-denied".into());
    }
    if rpc.method.starts_with("knowledge.") {
        let scope = session
            .scope
            .knowledge
            .as_ref()
            .ok_or("plugin-object-denied")?;
        if rpc.method == "knowledge.create" && !scope.allow_create {
            return Err("plugin-create-not-selected".into());
        }
        if rpc.method != "knowledge.create"
            && rpc.method != "knowledge.selection"
            && !scope
                .documents
                .iter()
                .any(|p| p == id(rpc, "path").unwrap_or(""))
        {
            return Err("plugin-object-denied".into());
        }
    }
    Ok(())
}

/// Runs only from the existing opt-in native fixture, using its real Broker Session/worker.
#[cfg(all(debug_assertions, feature = "extension-runtime-fixture"))]
pub(crate) fn verify_material_authorization_fixture(root: &Path, executable: &Path) {
    let mut broker = Broker::default();
    let token = broker.start(root, "1.9.2", executable, "example.palette", Scope {
        material_library_id: Some("library-fixture".into()),
        material_ids: vec!["asset-fixture".into()],
        ..Default::default()
    }, json!({"contribution":"palette","action":"run","fields":{}})).unwrap();
    {
        let handle = broker.handle(&token).unwrap();
        let mut session = handle.session.lock().unwrap();
        session.require_current(root, "1.9.2").unwrap();
        let list = Rpc { method: "materials.library.list".into(),
            params: json!({"libraryId":"library-fixture","requestId":"broker-list"}) };
        let read = Rpc { method: "materials.library.read".into(),
            params: json!({"libraryId":"library-fixture","requestId":"broker-read","id":"asset-fixture"}) };
        assert_eq!(authorize(&session, &list), Ok(()));
        assert_eq!(authorize(&session, &read), Ok(()));
        for method in ["materials.library.list", "materials.library.read"] {
            let foreign = Rpc { method: method.into(), params: if method.ends_with("read") {
                json!({"libraryId":"foreign-library","requestId":"foreign","id":"asset-fixture"})
            } else { json!({"libraryId":"foreign-library","requestId":"foreign"}) } };
            assert_eq!(authorize(&session, &foreign), Err("plugin-object-denied".into()));
        }
        assert_eq!(authorize(&session, &Rpc { method: "materials.library.read".into(),
            params: json!({"libraryId":"library-fixture","requestId":"unselected","id":"unselected-asset"}) }),
            Err("plugin-object-denied".into()));
        session.scope.material_library_id = None; // Historical host scope is not promoted to a library grant.
        assert_eq!(authorize(&session, &list), Err("plugin-object-denied".into()));
        assert_eq!(authorize(&session, &read), Err("plugin-object-denied".into()));
        assert_eq!(authorize(&session, &Rpc { method: "materials.read".into(), params: json!({"id":"asset-fixture"}) }), Ok(()));
        session.scope.material_library_id = Some("library-fixture".into());
        session.package.grants.retain(|grant| grant != "materials.read"); // Fixture Session only.
        assert_eq!(authorize(&session, &list), Err("plugin-permission-denied".into()));
        assert_eq!(authorize(&session, &read), Err("plugin-permission-denied".into()));
    }
    broker.close(&token); // Normal lifecycle for the fixture-owned worker, never an app/profile process.
    println!("SHARED_MATERIAL_BROKER_AUTHORIZE_PASS actualSession=true legacyScopeDenied=true foreignLibraryDenied=true unselectedAssetDenied=true explicitScopeGranted=true missingGrantDenied=true");
}
impl Broker {
    pub fn start(
        &mut self,
        root: &Path,
        host: &str,
        executable: &Path,
        id: &str,
        scope: Scope,
        event: Value,
    ) -> Result<String, String> {
        self.sweep(root, host);
        if self.sessions.len() >= 4 {
            return Err("plugin-concurrency-limit".into());
        }
        if scope.material_library_id.as_deref().is_some_and(|id| !crate::materials::consumer::valid_consumer_id(id)) {
            return Err("plugin-scope".into());
        }
        if scope.material_ids.len() > 32
            || scope.canvas_ids.len() > 8
            || scope
                .knowledge
                .as_ref()
                .is_some_and(|k| k.documents.len() > 32)
            || serde_json::to_vec(&scope)
                .map_err(|_| "plugin-scope")?
                .len()
                > 16000
            || serde_json::to_vec(&event)
                .map_err(|_| "plugin-event")?
                .len()
                > 16000
        {
            return Err("plugin-scope-limit".into());
        }
        let package = entry(root, host, id)?;
        if !store::compatible(&package.package, host) {
            return Err("plugin-incompatible".into());
        }
        let resource = store::script(&package.package)?;
        if !resource
            .contributions
            .iter()
            .any(|c| Some(c.id.as_str()) == event.get("contribution").and_then(Value::as_str))
        {
            return Err("plugin-contribution-unavailable".into());
        }
        if !resource
            .required_permissions
            .iter()
            .all(|p| package.grants.contains(p))
        {
            return Err("plugin-consent-required".into());
        }
        let token = rand::random::<[u8; 16]>()
            .iter()
            .map(|n| format!("{n:02x}"))
            .collect::<String>();
        let event = json!({"input":event,"capabilities":package.grants,"objects":{"materials":scope.material_ids,"materialLibraryId":scope.material_library_id,"knowledge":scope.knowledge.as_ref().map(|s|json!({"documents":s.documents,"vaultId":s.vault_id})),"canvases":scope.canvas_ids},"theme":scope.theme});
        let worker = Worker::launch(executable, &resource.code, &event, Duration::from_secs(10))?;
        let live = Arc::new(AtomicBool::new(true));
        let started = Instant::now();
        let control = worker.control();
        let handle = SessionHandle {
            inflight: self.inflight.clone(),
            live: live.clone(),
            control,
            id: package.package.manifest.id.clone(),
            digest: package.digest.clone(),
            epoch: package.epoch,
            started,
            session: Arc::new(Mutex::new(Session {
                live,
                package,
                scope,
                images: BTreeMap::new(),
                worker,
                pending: None,
                started,
                receipts: Vec::new(),
            })),
        };
        self.sessions.insert(token.clone(), handle);
        Ok(token)
    }
    pub fn sweep(&mut self, root: &Path, host: &str) {
        self.sessions.retain(|_, s| {
            let valid = s.started.elapsed() < Duration::from_secs(10)
                && entry(root, host, &s.id)
                    .is_ok_and(|p| p.digest == s.digest && p.epoch == s.epoch);
            if !valid {
                s.retire();
            }
            valid
        });
    }
    pub fn handle(&self, token: &str) -> Result<SessionHandle, String> {
        self.sessions
            .get(token)
            .cloned()
            .ok_or("plugin-retired".into())
    }
    pub fn close(&mut self, token: &str) {
        if let Some(s) = self.sessions.remove(token) {
            s.retire();
        }
    }
    pub fn close_all(&mut self) {
        for s in self.sessions.values() {
            s.retire();
        }
        self.sessions.clear();
    }
    pub fn poll(&mut self, root: &Path, host: &str, token: &str) -> Result<Value, String> {
        let result = (|| {
            let handle = self.sessions.get(token).ok_or("plugin-retired")?;
            let Ok(mut guard) = handle.session.try_lock() else {
                return Ok(json!({"kind":"pending"}));
            };
            let s = &mut *guard;
            current(root, host, s)?;
            if let Some(call) = &s.pending {
                return Ok(json!({"kind":"call","request":call,"scope":s.scope}));
            }
            let Some(message) = s.worker.poll()? else {
                return Ok(json!({"kind":"pending"}));
            };
            match message.get("kind").and_then(Value::as_str) {
                Some("call") => {
                    let call: Rpc = serde_json::from_value(
                        message.get("request").cloned().ok_or("plugin-protocol")?,
                    )
                    .map_err(|_| "plugin-protocol")?;
                    if !call.params.is_object() {
                        return Err("plugin-parameters".into());
                    }
                    s.pending = Some(call.clone());
                    Ok(json!({"kind":"call","request":call,"scope":s.scope}))
                }
                Some("result") => Ok(
                    json!({"kind":"result","result":message.get("result"),"receipts":s.receipts}),
                ),
                _ => Err("plugin-protocol".into()),
            }
        })();
        if result.as_ref().is_err() || result.as_ref().is_ok_and(|v| v["kind"] == "result") {
            self.close(token);
        }
        result
    }
    pub fn dispatch<F>(
        &mut self,
        root: &Path,
        host: &str,
        token: &str,
        veto: Option<String>,
        domain: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(&mut Session, &Rpc) -> Result<Value, String>,
    {
        self.handle(token)?.dispatch(root, host, veto, domain)
    }
}
fn dispatch_session<F>(
    s: &mut Session,
    root: &Path,
    host: &str,
    veto: Option<String>,
    domain: F,
) -> Result<Value, String>
where
    F: FnOnce(&mut Session, &Rpc) -> Result<Value, String>,
{
    current(root, host, s)?;
    let call = s.pending.take().ok_or("plugin-no-pending-call")?;
    let result = (|| {
        if veto.is_some() {
            return Err("plugin-host-veto".into());
        }
        authorize(s, &call)?;
        match call.method.as_str() {
            "ui.theme" => Ok(json!(s.scope.theme)),
            "log" => {
                let text = call
                    .params
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or("plugin-parameters")?;
                if text.len() > 1000 {
                    return Err("plugin-log-limit".into());
                }
                Ok(Value::Null)
            }
            "data.get" => Ok(json!(entry(root, host, &s.package.package.manifest.id)?
                .data
                .unwrap_or(PluginData {
                    schema_version: 1,
                    revision: 0,
                    settings: json!({}),
                    cache: json!({})
                }))),
            "data.set" => {
                let data: PluginData = serde_json::from_value(call.params.clone())
                    .map_err(|_| "plugin-data-invalid")?;
                let state = store::manage(root, host, Request::List)?;
                current(root, host, s)?;
                store::manage(
                    root,
                    host,
                    Request::Data {
                        id: s.package.package.manifest.id.clone(),
                        data: data.clone(),
                        expected_revision: state.revision,
                    },
                )?;
                Ok(json!(data))
            }
            _ => domain(s, &call),
        }
    })();
    let committed = result.is_ok()
        && [
            "data.set",
            "materials.tags",
            "knowledge.create",
            "knowledge.insert",
            "canvas.export",
        ]
        .contains(&call.method.as_str());
    if committed {
        s.receipts
            .push(json!({"method":call.method,"committed":true}));
    }
    // Deliver reads only while the lease remains valid. A committed write is never retried.
    let response = match &result {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"error":error}),
    };
    let delivery = current(root, host, s).and_then(|_| s.worker.reply(&response));
    if let Err(error)=delivery {
        if committed {return Ok(json!({"method":call.method,"response":response,"deliveryError":error}));}
        return Err(error);
    }
    Ok(json!({"method":call.method,"response":response}))
}
