//! Workspace windows are explicitly registered capabilities, not a label-prefix exemption.
//! Existing main-only commands retain their guards. Only this small command surface
//! permits registered children, with an exact view/library/resource grant.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Mutex, Condvar}};
use tauri::{Emitter, Manager};
#[path="workspace_note_dispatch.rs"]
mod note_dispatch;
#[path="workspace_host_dispatch.rs"]
mod host_dispatch;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ViewGrant {
    pub id: String,
    pub kind: String,
    pub library_id: String,
    pub resource_id: Option<String>,
    pub title: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowView { pub view:ViewGrant,pub open:bool,pub transfer_pending:bool,pub admission_id:Option<String>,pub ready:bool,pub dirty:bool,pub rendered_revision:Option<String> }
impl WindowView { fn new(view:ViewGrant)->Self{Self{view,open:true,transfer_pending:false,admission_id:None,ready:false,dirty:false,rendered_revision:None}} }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowSession { pub label: String,pub incarnation:String,pub closing:bool,pub removing:bool,pub destroy_claim:bool,pub destroy_accepted:bool,pub destroyed:bool, pub integrated:bool, pub handoff_id:Option<String>, pub view: ViewGrant, pub ready: bool, pub dirty: bool, pub rendered_revision:Option<String>,pub views:Vec<WindowView> }
impl WindowSession {
    fn new(label:String,view:ViewGrant)->Self{Self{label,incarnation:format!("{:032x}",rand::random::<u128>()),closing:false,removing:false,destroy_claim:false,destroy_accepted:false,destroyed:false,integrated:false,handoff_id:None,view:view.clone(),ready:false,dirty:false,rendered_revision:None,views:vec![WindowView::new(view)]}}
    fn reconcile(&mut self){if let Some(first)=self.views.iter().find(|view|view.open).or(self.views.first()){self.view=first.view.clone();self.rendered_revision=first.rendered_revision.clone();}self.ready=self.views.iter().filter(|view|view.open).all(|view|view.ready);self.dirty=self.views.iter().any(|view|view.dirty);}
    fn view(&self,id:Option<&str>)->Result<WindowView,String>{self.views.iter().find(|view|view.view.id==id.unwrap_or(&self.view.id)).cloned().ok_or_else(||"workspace-view-not-bound".into())}
}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct MergeOffer { id:String,source:String,source_view_id:String,view:ViewGrant,accepted:bool,revision:String }
#[derive(Default)]
pub(crate) struct WorkspaceWindows {
    entries: Mutex<HashMap<String, WindowSession>>,
    knowledge: Mutex<HashMap<String, crate::knowledge::KnowledgeService>>,
    main_views: Mutex<HashMap<String, ViewGrant>>,
    main_dirty: Mutex<HashMap<String,bool>>,
    main_ready: Mutex<HashMap<String,(String,String)>>,
    admission_owners: Mutex<HashMap<String,String>>,
    retiring_views: Mutex<std::collections::HashSet<String>>,
    main_binding_coverage: Mutex<(u64,bool)>,
    write_gate: Mutex<()>,
    quit: Mutex<Option<QuitRound>>,
    quit_changed: Condvar,
    merges:Mutex<HashMap<String,MergeOffer>>,
    drags:Mutex<crate::workspace_drag::WorkspaceDrags>,
    recovery:crate::workspace_recovery::RecoveryStore,
    pub(crate) attachments: crate::workspace_attachments::WorkspaceAttachments,
    pub(crate) graphs: crate::workspace_graph::WorkspaceGraphs,
    pub(crate) notes_metadata: crate::workspace_notes_metadata::WorkspaceNotesMetadata,
    pub(crate) actions: crate::workspace_actions::WorkspaceActions,
    tearout: Mutex<crate::workspace_tearout::WorkspaceTearout>,
    handoffs: crate::workspace_handoff::WorkspaceHandoffs,
    note_actions: crate::workspace_note_actions::WorkspaceNoteActions,
    note_queue: crate::workspace_note_actions::NoteActionStore,
    graph_actions: crate::workspace_graph_actions::WorkspaceGraphActions,
    graph_catalogs: Mutex<HashMap<String,crate::materials::MaterialCatalog>>,
}
struct QuitRound { id: String, responses: HashMap<String, Option<bool>> }
impl WorkspaceWindows {
    pub(crate) fn guard_main_document_read(&self)->Result<std::sync::MutexGuard<'_,()>,String>{
        let gate=self.write_gate.lock().map_err(|_|"workspace-lock")?;
        let mut coverage=self.main_binding_coverage.lock().map_err(|_|"workspace-lock")?;
        coverage.0=coverage.0.checked_add(1).ok_or("workspace-coverage-generation-limit")?;coverage.1=false;
        Ok(gate)
    }
    pub(crate) fn guard_main_document_retirement(&self,scope:&crate::knowledge::KnowledgeService,reference:&crate::knowledge::KnowledgeDocumentRef)->Result<std::sync::MutexGuard<'_,()>,String>{
        let record=scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
        let relative=crate::knowledge::safe_markdown_relative_path(&reference.relative_path).map_err(crate::knowledge_error)?;
        self.guard_main_path_retirement(record.root_path(),&relative,false)
    }
    pub(crate) fn guard_main_path_retirement(&self,root:&std::path::Path,relative:&std::path::Path,directory:bool)->Result<std::sync::MutexGuard<'_,()>,String>{
        let gate=self.write_gate.lock().map_err(|_|"workspace-lock")?;
        let root=root.canonicalize().map_err(|_|"workspace-source-unavailable")?;
        let peers={let entries=self.entries.lock().map_err(|_|"workspace-lock")?;entries.iter().flat_map(|(label,window)|window.views.iter().filter(move|entry|entry.open&&entry.view.kind=="note"&&entry.view.resource_id.as_ref().and_then(|path|crate::knowledge::safe_markdown_relative_path(path).ok()).is_some_and(|path|if directory{path.starts_with(relative)}else{path==relative})).map(move|entry|format!("{label}/{}",entry.view.id))).collect::<Vec<_>>()};
        for key in peers{
            let scope=self.knowledge(&key)?;
            // A stale captured incarnation cannot own a newly recreated root.
            if scope.current_target_identity().is_err(){continue;}
            let record=scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
            if record.root_path().canonicalize().ok().as_ref()==Some(&root){return Err("workspace-note-open-in-child-window: 请先关闭引用此笔记的独立窗口标签，再重命名、移动或删除笔记。".into());}
        }
        Ok(gate)
    }
    fn claim_destroy<T>(&self,label:&str,incarnation:&str,lookup:impl FnOnce()->Option<T>)->Result<Option<(Option<T>,bool)>,String>{
        let _gate=self.write_gate.lock().map_err(|_|"workspace-lock")?;
        let mut entries=self.entries.lock().map_err(|_|"workspace-lock")?;
        let Some(session)=entries.get_mut(label).filter(|session|session.incarnation==incarnation) else{return Ok(None);};
        if session.destroy_claim||session.destroy_accepted||session.removing{return Err("workspace-window-destroy-in-progress".into());}
        if session.dirty||session.views.iter().any(|entry|entry.open&&entry.transfer_pending){return Err("workspace-target-kept-open".into());}
        let was_closing=session.closing;session.closing=true;session.destroy_claim=true;
        Ok(Some((lookup(),was_closing)))
    }
    fn finish_destroy(&self,label:&str,incarnation:&str,was_closing:bool,restore_on_error:bool,accepted:bool,missing:bool)->Result<bool,String>{
        let _gate=self.write_gate.lock().map_err(|_|"workspace-lock")?;
        let mut entries=self.entries.lock().map_err(|_|"workspace-lock")?;
        let Some(session)=entries.get_mut(label).filter(|session|session.incarnation==incarnation) else{return Ok(false);};
        session.destroy_claim=false;
        if accepted{session.destroy_accepted=true;Ok(missing||session.destroyed)}
        else if session.destroyed{Ok(true)}
        else{if restore_on_error{session.closing=was_closing;}Ok(false)}
    }
    fn registration_available(&self,label:&str,id:&str)->Result<(),String>{
        if self.retiring_views.lock().map_err(|_|"workspace-lock")?.contains(&format!("{label}/{id}")){return Err("workspace-view-retirement-in-progress".into());}Ok(())
    }
    fn persist_window(&self,label:&str,closed:bool)->Result<(),String>{
        self.persist_window_at(label,closed,crate::backend_services()?.app_data_dir())
    }
    fn persist_window_at(&self,label:&str,closed:bool,root:&std::path::Path)->Result<(),String>{
        let session=self.session(label)?;
        let previous=match self.recovery.window(root,label){Ok(saved)=>Some(saved),Err(error) if error=="workspace-recovery-missing"=>None,Err(error)=>return Err(error)};
        let views=session.views.iter().filter(|entry|entry.open&&!entry.transfer_pending).map(|entry|crate::workspace_recovery::SavedView{
            view:entry.view.clone(),
            catalog_library_id:captured_catalog(self,label,&entry.view.id).ok().and_then(|catalog|catalog.library_scope_key().ok()).or_else(||previous.as_ref().and_then(|saved|saved.views.iter().find(|old|old.view==entry.view).and_then(|old|old.catalog_library_id.clone()))),
            scope:self.knowledge(&format!("{label}/{}",entry.view.id)).ok().and_then(|scope|scope.workspace_recovery_record().ok()).or_else(||previous.as_ref().and_then(|saved|saved.views.iter().find(|old|old.view==entry.view).and_then(|old|old.scope.clone()))),
            attachments:self.attachments.saved_baseline(label,&entry.view).ok().flatten().or_else(||previous.as_ref().and_then(|saved|saved.views.iter().find(|old|old.view==entry.view).and_then(|old|old.attachments.clone()))),
        }).collect::<Vec<_>>();
        if views.is_empty(){
            // The last view was merged/closed. Retain its existing captured
            // history for explicit recovery, but never auto-open it on restart.
            // A still-open pending transfer is not a committed close.
            if !session.views.iter().any(|entry|entry.open){if let Some(mut saved)=previous{saved.closed=true;return self.recovery.save_window(root,saved);}}
            return Ok(());
        }
        self.recovery.save_window(root,crate::workspace_recovery::SavedWindow{id:label.into(),closed,integrated:session.integrated,views})
    }
    fn persist_main(&self,id:&str)->Result<(),String>{
        let view=main_view(self,"main",id)?;let scope=self.knowledge(&format!("main/{id}"))?.workspace_recovery_record().map_err(crate::knowledge_error)?;
        self.recovery.save_main(crate::backend_services()?.app_data_dir(),crate::workspace_recovery::SavedView{catalog_library_id:captured_catalog(self,"main",id).ok().and_then(|catalog|catalog.library_scope_key().ok()),attachments:self.attachments.saved_baseline("main",&view)?,view,scope:Some(scope)})
    }
    fn accepting_views(&self) -> Result<(), String> {
        if self.quit.lock().map_err(|_|"workspace-lock")?.is_some() {return Err("workspace-quit-in-progress".into());} Ok(())
    }
    fn acknowledge_quit(&self, label:&str, id:&str, saved:bool) -> Result<(),String> {
        let mut quit=self.quit.lock().map_err(|_|"workspace-lock")?;
        let round=quit.as_mut().filter(|round|round.id==id).ok_or("workspace-quit-expired")?;
        let response=round.responses.get_mut(label).ok_or("workspace-quit-unregistered-window")?;
        if response.is_some(){return Err("workspace-quit-already-acknowledged".into());}
        *response=Some(saved);self.quit_changed.notify_all();Ok(())
    }
    fn insert(&self, session: WindowSession) -> Result<(), String> {
        let quit=self.quit.lock().map_err(|_|"workspace-lock")?;
        if quit.is_some(){return Err("workspace-quit-in-progress".into());}
        let mut entries = self.entries.lock().map_err(|_| "workspace-lock")?;
        if entries.len() >= 12 || entries.contains_key(&session.label) { return Err("workspace-window-limit".into()); }
        entries.insert(session.label.clone(), session); Ok(())
    }
    pub(crate) fn attachment_scope(&self, label: &str, view_id: &str) -> Result<(ViewGrant, crate::knowledge::KnowledgeService), String> {
        if label == "main" { return Err("workspace-attachment-child-required".into()); }
        let session=self.session(label)?;if session.closing{return Err("workspace-window-closing".into());}
        let selected = session.view(Some(view_id))?;
        if !selected.open || selected.view.kind != "note" { return Err("workspace-attachment-view-unavailable".into()); }
        let service = self.knowledge(&format!("{label}/{view_id}"))?;
        Ok((selected.view, service))
    }
    fn remove(&self,label:&str){if let Ok(session)=self.session(label){self.remove_if(label,&session.incarnation);}}
    fn remove_if(&self,label:&str,incarnation:&str){
        {let Ok(_gate)=self.write_gate.lock() else{return;};let Ok(mut entries)=self.entries.lock() else{return;};let Some(session)=entries.get_mut(label).filter(|session|session.incarnation==incarnation) else{return;};if session.destroy_claim{session.destroyed=true;return;}if session.removing{return;}session.removing=true;session.closing=true;}
        self.handoffs.remove_window(label);
        self.note_actions.remove_window(label);
        self.note_queue.remove_window(label);
        self.graph_actions.remove_window(label);
        self.actions.remove_window(label);
        self.graphs.remove_window(label);
        self.notes_metadata.remove_window(label);
        if let Ok(mut gestures)=self.tearout.lock(){gestures.remove_window(label);}
        self.attachments.remove_window(label);
        if let Ok(mut offers)=self.merges.lock(){offers.retain(|_,offer|offer.source!=label);}
        if let Ok(mut drags)=self.drags.lock(){drags.remove_window(label);}
        {let Ok(_gate)=self.write_gate.lock() else{return;};let Ok(mut entries)=self.entries.lock() else{return;};if entries.get(label).is_none_or(|session|session.incarnation!=incarnation){return;}entries.remove(label);
        if let Ok(mut scopes)=self.knowledge.lock(){scopes.retain(|key,_|key!=label&&!key.starts_with(&format!("{label}/")));}
        if let Ok(mut catalogs)=self.graph_catalogs.lock(){catalogs.retain(|key,_|!key.starts_with(&format!("{label}/")));}
        if let Ok(mut owners)=self.admission_owners.lock(){owners.retain(|key,_|!key.starts_with(&format!("{label}/")));}}

    }
    fn knowledge(&self, label: &str) -> Result<crate::knowledge::KnowledgeService, String> {
        self.knowledge.lock().map_err(|_| "workspace-lock")?.get(label).cloned().ok_or_else(|| "workspace-note-scope-missing".into())
    }
    pub(crate) fn session(&self, label: &str) -> Result<WindowSession, String> {
        self.entries.lock().map_err(|_| "workspace-lock")?.get(label).cloned().ok_or_else(|| "workspace-unregistered-window".into())
    }
    fn authorize(&self, label: &str, grant: &ViewGrant) -> Result<(), String> {
        if label == "main" { return Ok(()); }
        let session=self.session(label)?;if session.closing{return Err("workspace-window-closing".into());}let selected=session.view(Some(&grant.id))?;
        if !selected.open{return Err("workspace-view-closed".into());}
        if selected.view != *grant { return Err("workspace-view-scope-mismatch".into()); } Ok(())
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum DispatchRequest {
    Host(host_dispatch::HostRequest),
    Note(note_dispatch::NoteRequest),
    Core(WindowRequest),
}

const PRODUCT_WINDOWS_WITHDRAWN: &str = "workspace-independent-windows-withdrawn";

// Keep the verified candidate/fixture implementation, but withdraw its product
// authority before dispatch (and therefore before filesystem or recovery work).
// Main still uses the existing saved-draft acknowledgement on normal exit.
fn fixture_windows_enabled(identifier: &str) -> bool {
    cfg!(all(debug_assertions, feature = "workspace-runtime-fixture"))
        && identifier == "com.luckyray.workspace.fixture"
}

fn product_request_allowed(request: &DispatchRequest, fixture: bool) -> bool {
    fixture || matches!(request, DispatchRequest::Core(WindowRequest::QuitAck { .. }))
}
// Keep no-payload variants as empty structs: Serde's internally tagged unit
// visitor discards extra fields instead of applying deny_unknown_fields.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum WindowRequest {
    #[cfg(all(debug_assertions, feature = "workspace-runtime-fixture"))]
    FixtureReport { report: serde_json::Value },
    Open { view: ViewGrant }, Attach { label:String,view:ViewGrant }, Bootstrap {},
    Ready { revision:String,#[serde(rename="viewId")] view_id:Option<String> }, List {},
    ReadNote { #[serde(rename="viewId")] view_id:Option<String> },
    NoteAuthority { #[serde(rename="viewId")] view_id:String },
    NoteMetadata { #[serde(rename="viewId")] view_id:String, revision:String },
    QueryNoteMetadata { #[serde(rename="viewId")] view_id:String, revision:String, query:String, limit:usize },
    WriteNote { revision: String, content: String,#[serde(rename="viewId")] view_id:Option<String> },
    Bind { view: ViewGrant },
    ReadBound { #[serde(rename="viewId")] view_id: String },
    WriteBound { #[serde(rename="viewId")] view_id: String, revision: String, content: String },
    ResolveAttachment { #[serde(rename="viewId")] view_id: Option<String>, revision: Option<String>, destination: String, wiki: bool },
    Dirty { dirty: bool,#[serde(rename="viewId")] view_id:Option<String> }, Close { label: Option<String> },
    SetOpenViews { ids:Vec<String>,known:Vec<String> },
    BeginDrag { id:String,view:ViewGrant }, ClaimDrag { id:String }, CancelDrag { id:String },
    NativeGestureSupport {},
    BeginNativeGesture { #[serde(rename="viewId")] view_id:String },
    FinishNativeGesture { ticket:String }, CancelNativeGesture { ticket:String },
    RecoverableWindows {}, RestoreWindow { id:String },
    QuitAck { id:String, saved:bool },
    OfferToMain { #[serde(rename="viewId")] view_id:Option<String> }, PendingMerges {}, AcceptMerge { id:String,revision:String }, MergeStatus { id:String }, CancelMerge { id:String },
    RestorePlacement { x:i32,y:i32,width:f64,height:f64,maximized:bool },
    Backlinks { #[serde(rename="viewId")] view_id:Option<String> },
}

/// Called on the existing quit worker before any service is drained. All
/// registered editors freeze and flush; no response or one failure keeps the
/// process alive. No filesystem/user draft is copied into layout persistence.
fn quit_participants(mut children: Vec<String>, main_open: bool) -> Vec<String> {
    // Main's production NotesPage can own drafts without ever binding a
    // workspace view. Binding count is not evidence that it is safe to exit.
    if main_open { children.push("main".into()); }
    children.sort();
    children.dedup();
    children
}

pub(crate) fn prepare_application_quit(app:&tauri::AppHandle) -> bool {
    let registry=app.state::<WorkspaceWindows>();
    if registry.handoffs.blocks_close("main")||registry.note_queue.has_pending_window("main").unwrap_or(true)||registry.graph_actions.has_pending_window("main").unwrap_or(true){return false;}
    let children=match registry.entries.lock(){Ok(entries)=>entries.keys().cloned().collect::<Vec<_>>(),Err(_)=>return false};
    let labels=quit_participants(children, app.get_webview_window("main").is_some());
    if labels.iter().any(|label|registry.handoffs.blocks_close(label)){return false;}
    let mut quit=match registry.quit.lock(){Ok(quit)=>quit,Err(_)=>return false};
    if quit.is_some(){return false;}
    let id=format!("{:032x}",rand::random::<u128>());
    *quit=Some(QuitRound{id:id.clone(),responses:labels.iter().map(|label|(label.clone(),None)).collect()});
    drop(quit);
    for label in &labels {if app.emit_to(label,"luckyray:workspace-quit-prepare",serde_json::json!({"id":id})).is_err(){let _=registry.acknowledge_quit(label,&id,false);}}
    let quit=match registry.quit.lock(){Ok(quit)=>quit,Err(_)=>return false};
    let (mut quit, _)=match registry.quit_changed.wait_timeout_while(quit,std::time::Duration::from_secs(15),|quit|{
        quit.as_ref().is_some_and(|round| !round.responses.values().any(|value|*value==Some(false)) && round.responses.values().any(Option::is_none))
    }){Ok(result)=>result,Err(_)=>return false};
    let saved=quit.as_ref().is_some_and(|round|round.responses.values().all(|value|*value==Some(true)));
    if !saved { *quit=None; }
    drop(quit);
    // All exact participants acknowledged saved:true. Only now does normal
    // quit proceed to native player / companion / LSH service shutdown.
    let phase=if saved {"luckyray:workspace-quit-draining"} else {"luckyray:workspace-quit-cancelled"};
    for label in labels {let _=app.emit_to(&label,phase,serde_json::json!({"id":id}));}
    saved
}

pub(crate) fn cancel_prepared_application_quit(app:&tauri::AppHandle){
    let registry=app.state::<WorkspaceWindows>();
    let round=registry.quit.lock().unwrap_or_else(|error|error.into_inner()).take();
    if let Some(round)=round {for label in round.responses.keys(){let _=app.emit_to(label,"luckyray:workspace-quit-cancelled",serde_json::json!({"id":round.id}));}}
}

#[cfg(all(debug_assertions, feature="workspace-runtime-fixture"))]
pub(crate) fn finish_quit_probe(app:&tauri::AppHandle){
    cancel_prepared_application_quit(app);
}

fn main_view(registry: &WorkspaceWindows, caller: &str, id: &str) -> Result<ViewGrant, String> {
    if caller != "main" { return Err("workspace-main-binding-required".into()); }
    registry.main_views.lock().map_err(|_| "workspace-lock")?.get(id).cloned().ok_or_else(|| "workspace-view-not-bound".into())
}

fn scoped_view(registry:&WorkspaceWindows,caller:&str,id:Option<&str>)->Result<(ViewGrant,crate::knowledge::KnowledgeService),String>{
    let view=if caller=="main"{main_view(registry,caller,id.ok_or("workspace-view-required")?)?}else{let session=registry.session(caller)?;if session.closing{return Err("workspace-window-closing".into());}let selected=session.view(id)?;if !selected.open{return Err("workspace-view-closed".into());}selected.view};
    let service=registry.knowledge(&format!("{caller}/{}",view.id))?;
    Ok((view,service))
}
fn outgoing_scope(registry:&WorkspaceWindows,caller:&str,view:&ViewGrant)->Result<crate::knowledge::KnowledgeService,String>{
    registry.authorize(caller,view)?;
    if view.kind!="note"{return Err("workspace-view-not-yet-supported".into());}
    if caller=="main"&&main_view(registry,caller,&view.id).is_err(){return saved_or_current_scope(registry,view);}
    let (bound,scope)=scoped_view(registry,caller,Some(&view.id))?;
    if bound!=*view{return Err("workspace-view-identity-changed".into());}Ok(scope)
}

fn saved_or_current_scope(registry:&WorkspaceWindows,view:&ViewGrant)->Result<crate::knowledge::KnowledgeService,String>{
    let service=crate::knowledge_service()?;
    match service.capture_workspace_scope(&view.library_id){Ok(scope)=>Ok(scope),Err(error)=>{
        let saved=registry.recovery.main_view(crate::backend_services()?.app_data_dir(),view)?;
        if let Some(scope)=saved.and_then(|saved|saved.scope){service.restore_workspace_scope(&scope).map_err(crate::knowledge_error)}else{Err(crate::knowledge_error(error))}
    }}
}
fn validate_grant(view: &ViewGrant, knowledge: Option<&crate::knowledge::KnowledgeService>) -> Result<(), String> {
    if view.id.is_empty() || view.id.len() > 128 || view.library_id.is_empty() || view.library_id.len() > 256 || view.title.len() > 1024 {
        return Err("workspace-invalid-view".into());
    }
    match view.kind.as_str() {
        "note" => {
            let reference = note_ref(view)?;
            // This validates current registered authority without activating/switching any Vault.
            knowledge.ok_or("workspace-note-scope-missing")?.read_document(&reference).map_err(crate::knowledge_error)?;
        }
        "graph" => { let scope=knowledge.ok_or("workspace-note-scope-missing")?;scope.workspace_recovery_record().map_err(crate::knowledge_error)?;if scope.current_vault_id().map_err(crate::knowledge_error)?!=view.library_id||view.resource_id.is_some(){return Err("workspace-invalid-graph-view".into());} }
        "materials" => { crate::backend_services()?.material_catalog().for_library(&view.library_id).map_err(crate::encode_material_catalog_command_error)?; }
        _ => return Err("workspace-view-not-yet-supported".into()),
    }
    Ok(())
}
fn note_ref(view: &ViewGrant) -> Result<crate::knowledge::KnowledgeDocumentRef, String> {
    if view.kind != "note" { return Err("workspace-not-a-note".into()); }
    let path = view.resource_id.as_deref().filter(|path| !path.is_empty() && path.len() <= 4096).ok_or("workspace-resource-missing")?;
    Ok(crate::knowledge::KnowledgeDocumentRef { vault_id: view.library_id.clone(), relative_path: path.into() })
}

/// Capture the native handle while the exact registry incarnation is reserved.
/// The UI callback records destruction but cannot release a claimed label. A
/// successful asynchronous destroy keeps its reservation until that callback.
fn destroy_registered_window(app:&tauri::AppHandle,registry:&WorkspaceWindows,label:&str,incarnation:&str,restore_on_error:bool)->Result<(),String>{
    let Some((window,was_closing))=registry.claim_destroy(label,incarnation,||app.get_webview_window(label))? else{return Ok(());};
    let missing=window.is_none();
    let result=window.map(|window|window.destroy().map_err(|_|"workspace-window-close-failed".to_owned())).unwrap_or(Ok(()));
    if registry.finish_destroy(label,incarnation,was_closing,restore_on_error,result.is_ok(),missing)?{registry.remove_if(label,incarnation);}
    result
}

fn spawn_window(app:&tauri::AppHandle,session:WindowSession)->Result<serde_json::Value,String>{
    let label=session.label.clone();let incarnation=session.incarnation.clone();let result=build_window(app,session);
    if result.is_err(){app.state::<WorkspaceWindows>().remove_if(&label,&incarnation);}result
}
fn build_window(app:&tauri::AppHandle,session:WindowSession)->Result<serde_json::Value,String>{
    if !fixture_windows_enabled(&app.config().identifier) {
        return Err(PRODUCT_WINDOWS_WITHDRAWN.into());
    }
    let registry=app.state::<WorkspaceWindows>();let label=session.label.clone();let view=session.view.clone();
            let page = "tests/fixtures/workspace-native-child.html#workspace";
            let dev_url = app.config().build.dev_url.clone();
            let builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(page.into()))
                .disable_drag_drop_handler()
                .title(format!("{} — LuckyRay", view.title)).inner_size(960., 720.).min_inner_size(480., 360.);
            #[cfg(all(debug_assertions, feature = "workspace-runtime-fixture"))]
            let builder = if let Some(fixture) = app.try_state::<crate::workspace_fixture::Fixture>() {
                builder.data_directory(fixture.root.join(&label))
            } else { builder };
            let created = builder
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_navigation(move |url| {
                    // Same-origin Main navigation would drop the child CSP, so
                    // only this exact dedicated entry and hash may remain loaded.
                    crate::workspace_attachments::fixture_navigation_allowed(url, dev_url.as_ref())
                }).build();
            match created {
                Ok(window) => {
                    let handle = (*app).clone(); let closed = label.clone();let incarnation=session.incarnation.clone();
                    window.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            // Never wait for the handoff mutex on the native UI
                            // callback: window creation may be waiting for this thread.
                            let handle=handle.clone();let closed=closed.clone();let incarnation=incarnation.clone();
                            tauri::async_runtime::spawn_blocking(move||handle.state::<WorkspaceWindows>().remove_if(&closed,&incarnation));
                        }
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            // Renderer must flush or explicitly resolve its conflict before
                            // this window can be destroyed. An unresponsive view stays safe.
                            api.prevent_close();
                            let _=handle.emit_to(&closed,"luckyray:workspace-close-requested",());
                        }
                    });
                    registry.persist_window(&label,false)?;
                    serde_json::to_value(session).map_err(|_| "workspace-serialize".into())
                }
                Err(_) => Err("workspace-window-create-failed-source-retained".into())
            }
}

fn native_gestures_enabled()->bool{
    cfg!(windows) && (crate::workspace_tearout::PRODUCTION_PHYSICAL_TEAROUT_VERIFIED || cfg!(all(debug_assertions,feature="workspace-runtime-fixture")))
}
fn gesture_grant(view:&ViewGrant,scope:&crate::knowledge::KnowledgeService)->Result<String,String>{
    use sha2::{Digest,Sha256};
    let identity=scope.current_target_identity().map_err(crate::knowledge_error)?;
    let bytes=serde_json::to_vec(&(view,&identity.target_id,&identity.identity_digest)).map_err(|_|"workspace-serialize")?;
    Ok(format!("{:x}",Sha256::digest(bytes)))
}
fn native_window_bounds(window:&tauri::WebviewWindow)->Result<crate::workspace_tearout::NativeWindowBounds,String>{
    #[cfg(windows)]{
        let position=window.outer_position().map_err(|_|"workspace-window-bounds-unavailable")?;
        let size=window.outer_size().map_err(|_|"workspace-window-bounds-unavailable")?;
        let native_id=window.hwnd().map_err(|_|"workspace-window-handle-unavailable")?.0 as isize;
        Ok(crate::workspace_tearout::NativeWindowBounds{label:window.label().into(),native_id,x:position.x,y:position.y,width:size.width,height:size.height,scale:window.scale_factor().map_err(|_|"workspace-window-scale-unavailable")?})
    }
    #[cfg(not(windows))]{let _=window;Err("workspace-native-gesture-unsupported".into())}
}

fn planned_closed_views(session:&WindowSession,ids:&[String],known:&[String])->Result<Vec<String>,String>{
    if ids.len()>100||known.len()>100||ids.iter().any(|id|!known.contains(id))||known.iter().any(|id|!session.views.iter().any(|entry|&entry.view.id==id)){return Err("workspace-view-not-bound".into());}
    if session.views.iter().any(|entry|known.contains(&entry.view.id)&&entry.open&&!ids.contains(&entry.view.id)&&entry.dirty){return Err("workspace-source-not-saved".into());}
    Ok(session.views.iter().filter(|entry|known.contains(&entry.view.id)&&entry.open&&!ids.contains(&entry.view.id)).map(|entry|entry.view.id.clone()).collect())
}
fn require_live_view(registry:&WorkspaceWindows,caller:&str,view:&ViewGrant)->Result<(),String>{
    let current=if caller=="main"{main_view(registry,caller,&view.id)?}else{
        let session=registry.session(caller)?;if session.closing{return Err("workspace-window-closing".into());}
        let entry=session.view(Some(&view.id))?;
        if !entry.open{return Err("workspace-view-closed".into());}entry.view
    };
    if current!=*view{return Err("workspace-view-identity-changed".into());}Ok(())
}

fn scoped_note_snapshot_value(service:&crate::knowledge::KnowledgeService,document:crate::knowledge::KnowledgeDocumentSnapshot)->Result<serde_json::Value,String>{
    let authority=crate::workspace_notes_metadata::authority_for(service,&document.summary.document_ref)?;
    let mut value=serde_json::to_value(document).map_err(|_|"workspace-serialize")?;
    value.as_object_mut().ok_or("workspace-serialize")?.insert("authority".into(),serde_json::to_value(authority).map_err(|_|"workspace-serialize")?);
    Ok(value)
}

#[tauri::command]
pub(crate) async fn workspace_window_command(app: tauri::AppHandle, caller: tauri::Webview, request: DispatchRequest) -> Result<serde_json::Value, String> {
    if !product_request_allowed(&request, fixture_windows_enabled(&app.config().identifier)) {
        return Err(PRODUCT_WINDOWS_WITHDRAWN.into());
    }
    let registry = app.state::<WorkspaceWindows>();
    let request=match request {
        DispatchRequest::Host(request)=>return host_dispatch::dispatch(&app,&caller,&registry,request).await,
        DispatchRequest::Note(request)=>return note_dispatch::dispatch(&app,&caller,&registry,request).await,
        DispatchRequest::Core(request)=>request,
    };
    match request {
        #[cfg(all(debug_assertions, feature = "workspace-runtime-fixture"))]
        WindowRequest::FixtureReport { report } => crate::workspace_fixture::report_child(&app, &caller, report),
        WindowRequest::NativeGestureSupport {} => Ok(serde_json::json!({"enabled":native_gestures_enabled(),"physicalWindowsVerified":crate::workspace_tearout::PRODUCTION_PHYSICAL_TEAROUT_VERIFIED})),
        WindowRequest::BeginNativeGesture {view_id} => {
            if !native_gestures_enabled(){return Err("workspace-physical-gesture-not-verified-use-detach-action".into());}
            let (view,scope)=scoped_view(&registry,caller.label(),Some(&view_id))?;
            if caller.label()!="main"&&!registry.session(caller.label())?.view(Some(&view_id))?.open{return Err("workspace-view-closed".into());}
            let window=app.get_webview_window(caller.label()).ok_or("workspace-window-unavailable")?;
            let bounds=native_window_bounds(&window)?;
            let observed=crate::workspace_tearout::observe_native()?;
            let ticket=registry.tearout.lock().map_err(|_|"workspace-lock")?.begin(bounds,view_id,gesture_grant(&view,&scope)?,observed)?;
            Ok(serde_json::json!({"ticket":ticket}))
        }
        WindowRequest::FinishNativeGesture {ticket} => {
            if !native_gestures_enabled(){return Err("workspace-physical-gesture-not-verified-use-detach-action".into());}
            let view_id=registry.tearout.lock().map_err(|_|"workspace-lock")?.view(caller.label(),&ticket)?;
            let (view,scope)=scoped_view(&registry,caller.label(),Some(&view_id))?;
            if caller.label()!="main"&&!registry.session(caller.label())?.view(Some(&view_id))?.open{return Err("workspace-view-closed".into());}
            let source=native_window_bounds(&app.get_webview_window(caller.label()).ok_or("workspace-window-unavailable")?)?;
            let mut windows=Vec::new();
            for window in app.webview_windows().values(){
                if window.is_visible().map_err(|_|"workspace-window-bounds-unavailable")?&&!window.is_minimized().map_err(|_|"workspace-window-bounds-unavailable")?{windows.push(native_window_bounds(window)?);}
            }
            let observed=crate::workspace_tearout::observe_native()?;
            let proof=registry.tearout.lock().map_err(|_|"workspace-lock")?.finish(caller.label(),&ticket,&gesture_grant(&view,&scope)?,&source,&windows,observed)?;
            if let crate::workspace_tearout::NativeDropIntent::ExistingWindow{label}=&proof{if label!="main"{registry.session(label)?;}}
            serde_json::to_value(proof).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::CancelNativeGesture {ticket} => {registry.tearout.lock().map_err(|_|"workspace-lock")?.cancel(caller.label(),&ticket);Ok(serde_json::Value::Null)}
        WindowRequest::RecoverableWindows {} => {
            if caller.label()!="main"{return Err("workspace-main-required".into());}
            let saved=registry.recovery.list(crate::backend_services()?.app_data_dir())?;
            Ok(serde_json::Value::Array(saved.into_iter().filter(|window|registry.session(&window.id).is_err()).map(|window|serde_json::json!({"id":window.id,"closed":window.closed,"title":window.views.first().map(|entry|entry.view.title.clone()),"tabs":window.views.len()})).collect()))
        }
        WindowRequest::RestoreWindow { id } => {
            let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
            if caller.label()!="main"{return Err("workspace-main-required".into());}registry.accepting_views()?;
            let saved=registry.recovery.window(crate::backend_services()?.app_data_dir(),&id)?;
            let first=saved.views.first().ok_or("workspace-recovery-empty")?;
            let mut session=WindowSession::new(id.clone(),first.view.clone());session.integrated=saved.integrated;session.views=saved.views.iter().map(|entry|WindowView::new(entry.view.clone())).collect();session.reconcile();
            registry.insert(session.clone())?;
            for entry in &saved.views { if let Some(record) = &entry.scope { if let Ok(scope) = crate::knowledge_service()?.restore_workspace_scope(record) {
                // Restore only the original persisted grant. Legacy recovery
                // cannot recapture authority from child-edited Markdown.
                if let Some(baseline) = &entry.attachments { registry.attachments.register_baseline(&id, baseline.clone())?; }
                if entry.view.kind=="graph"{if let Some(library)=&entry.catalog_library_id{if let Ok(catalog)=crate::backend_services()?.material_catalog().for_library(library){registry.graph_catalogs.lock().map_err(|_|"workspace-lock")?.insert(format!("{id}/{}",entry.view.id),catalog);}}}
                registry.knowledge.lock().map_err(|_|"workspace-lock")?.insert(format!("{id}/{}",entry.view.id),scope);
            } } }
            // Missing libraries/files keep their tabs as closable placeholders.
            // Recovery does not activate a Vault or reinterpret a captured root.
            drop(_writes);spawn_window(&app,session)
        }
        WindowRequest::BeginDrag { id,view } => {
            registry.accepting_views()?;let scope=outgoing_scope(&registry,caller.label(),&view)?;validate_grant(&view,Some(&scope))?;
            registry.drags.lock().map_err(|_|"workspace-lock")?.begin(id,caller.label().into(),view)?;
            Ok(serde_json::Value::Null)
        }
        WindowRequest::ClaimDrag { id } => {
            registry.accepting_views()?;if caller.label()!="main"{registry.session(caller.label())?;}
            let ticket=registry.drags.lock().map_err(|_|"workspace-lock")?.claim(&id,caller.label())?;
            // This sends intent only. The source still flushes and waits for the
            // ordinary rendered-revision handshake before removing anything.
            app.emit_to(&ticket.source,"luckyray:workspace-drag-claimed",serde_json::json!({"id":id,"target":caller.label()})).map_err(|_|"workspace-drag-source-unavailable")?;
            Ok(serde_json::json!({"viewId":ticket.view.id,"source":ticket.source}))
        }
        WindowRequest::CancelDrag { id } => {
            registry.drags.lock().map_err(|_|"workspace-lock")?.cancel(&id,caller.label());Ok(serde_json::Value::Null)
        }
        WindowRequest::Backlinks { view_id } => {
            let (view,service)=scoped_view(&registry,caller.label(),view_id.as_deref())?;
            require_live_view(&registry,caller.label(),&view)?;
            let reference=note_ref(&view)?;
            let result=tauri::async_runtime::spawn_blocking(move||service.backlinks(&reference).map_err(crate::knowledge_error)).await.map_err(|_|"workspace-backlinks-worker-failed")??;
            require_live_view(&registry,caller.label(),&view)?;
            serde_json::to_value(result).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::RestorePlacement { x,y,width,height,maximized } => {
            registry.session(caller.label())?;
            if !width.is_finite()||!height.is_finite()||!(100.0..=30000.0).contains(&width)||!(100.0..=30000.0).contains(&height)||x.unsigned_abs()>1_000_000||y.unsigned_abs()>1_000_000{return Err("workspace-invalid-placement".into());}
            // No target label parameter: a child can only place its own registered window.
            let window=app.get_webview_window(caller.label()).ok_or("workspace-window-missing")?;
            window.set_size(tauri::LogicalSize::new(width,height)).map_err(|_|"workspace-size-failed")?;
            window.set_position(tauri::PhysicalPosition::new(x,y)).map_err(|_|"workspace-position-failed")?;
            if maximized {window.maximize().map_err(|_|"workspace-maximize-failed")?;}
            Ok(serde_json::Value::Null)
        }
        WindowRequest::OfferToMain { view_id } => {
            let source=registry.session(caller.label())?.view(view_id.as_deref())?;
            if !source.ready||source.dirty{return Err("workspace-source-not-saved".into());}
            let (_,scope)=scoped_view(&registry,caller.label(),Some(&source.view.id))?;
            let revision=scope.read_document(&note_ref(&source.view)?).map_err(crate::knowledge_error)?.revision;
            let source_baseline=registry.attachments.outgoing_baseline(caller.label(), &source.view, &scope)?;
            let quit=registry.quit.lock().map_err(|_|"workspace-lock")?;
            if quit.is_some(){return Err("workspace-quit-in-progress".into());}
            let mut pending=registry.merges.lock().map_err(|_|"workspace-lock")?;
            // Reuse an in-flight offer; clicking twice never creates two target tabs.
            if let Some(offer)=pending.values().find(|offer|offer.source==caller.label()&&offer.source_view_id==source.view.id&&!offer.accepted){return serde_json::to_value(offer).map_err(|_|"workspace-serialize".into());}
            if pending.len()>=32{return Err("workspace-transfer-limit".into());}
            let id=format!("merge-{:032x}",rand::random::<u128>());
            let source_view_id=source.view.id.clone();
            let view=ViewGrant{id:id.clone(),..source.view};
            registry.attachments.register_baseline("main", source_baseline.for_view(&view)?)?;
            let mut views=registry.main_views.lock().map_err(|_|"workspace-lock")?;
            if views.len()>=100{return Err("workspace-view-limit".into());}
            registry.knowledge.lock().map_err(|_|"workspace-lock")?.insert(format!("main/{id}"),scope);
            views.insert(id.clone(),view.clone());
            let offer=MergeOffer{id:id.clone(),source:caller.label().into(),source_view_id,view,accepted:false,revision};
            pending.insert(id,offer.clone());drop(views);drop(pending);drop(quit);
            registry.persist_main(&offer.view.id)?;
            if let Some(main)=app.get_webview_window("main"){let _=main.show();let _=main.unminimize();let _=main.set_focus();}
            let _=app.emit_to("main","luckyray:workspace-merge-available",());
            serde_json::to_value(offer).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::PendingMerges {} => {
            if caller.label()!="main"{return Err("workspace-main-required".into());}
            let pending=registry.merges.lock().map_err(|_|"workspace-lock")?;
            serde_json::to_value(pending.values().filter(|offer|!offer.accepted).cloned().collect::<Vec<_>>()).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::AcceptMerge { id,revision } => {
            if caller.label()!="main"{return Err("workspace-main-required".into());}
            registry.accepting_views()?;
            let mut pending=registry.merges.lock().map_err(|_|"workspace-lock")?;
            let offer=pending.get_mut(&id).ok_or("workspace-transfer-expired")?;
            if registry.session(&offer.source)?.view(Some(&offer.source_view_id))?.dirty{return Err("workspace-source-not-saved".into());}
            if revision!=offer.revision||scoped_view(&registry,&offer.source,Some(&offer.source_view_id))?.1.read_document(&note_ref(&offer.view)?).map_err(crate::knowledge_error)?.revision!=revision{return Err("workspace-transfer-revision-changed".into());}
            offer.accepted=true;Ok(serde_json::Value::Null)
        }
        WindowRequest::MergeStatus { id } => {
            let pending=registry.merges.lock().map_err(|_|"workspace-lock")?;
            let offer=pending.get(&id).ok_or("workspace-transfer-expired")?;
            if caller.label()!=offer.source{return Err("workspace-window-scope-mismatch".into());}
            serde_json::to_value(offer).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::CancelMerge { id } => {
            let mut pending=registry.merges.lock().map_err(|_|"workspace-lock")?;
            let offer=pending.get(&id).ok_or("workspace-transfer-expired")?;
            if caller.label()!=offer.source{return Err("workspace-window-scope-mismatch".into());}
            if offer.accepted{return Err("workspace-target-already-received".into());}
            pending.remove(&id);Ok(serde_json::Value::Null)
        }
        WindowRequest::Open { view } => {
            let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
            registry.accepting_views()?;
            let knowledge=outgoing_scope(&registry,caller.label(),&view)?;
            validate_grant(&view, Some(&knowledge))?;
            let attachment_baseline = if view.kind == "note" { Some(registry.attachments.outgoing_baseline(caller.label(), &view, &knowledge)?) } else { None };
            if caller.label() == "main" && main_view(&registry, "main", &view.id).is_ok() { registry.persist_main(&view.id)?; }
            let label = format!("workspace-{:032x}", rand::random::<u128>());
            let session = WindowSession::new(label.clone(),view.clone());
            registry.insert(session.clone())?;
            if let Some(baseline) = attachment_baseline { registry.attachments.register_baseline(&label, baseline)?; }
            registry.knowledge.lock().map_err(|_| "workspace-lock")?.insert(format!("{label}/{}",view.id), knowledge);
            {drop(_writes);spawn_window(&app,session)}
        }
        WindowRequest::Bootstrap {} => serde_json::to_value(registry.session(caller.label())?).map_err(|_| "workspace-serialize".into()),
        WindowRequest::Ready { revision,view_id } => {
            let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
            let (view,service)=scoped_view(&registry,caller.label(),view_id.as_deref())?;
            if service.read_document(&note_ref(&view)?).map_err(crate::knowledge_error)?.revision!=revision{return Err("workspace-rendered-revision-stale".into());}
            let mut entries = registry.entries.lock().map_err(|_| "workspace-lock")?;
            let session = entries.get_mut(caller.label()).ok_or("workspace-unregistered-window")?;
            let target=session.views.iter_mut().find(|target|target.view.id==view.id&&target.open).ok_or("workspace-view-closed")?;
            if target.dirty{return Err("workspace-rendered-revision-stale".into());}
            target.ready = true;target.rendered_revision=Some(revision);session.reconcile();
            let snapshot = session.clone(); drop(entries);
            let _ = app.emit_to("main", "luckyray:workspace-window-ready", &snapshot);
            serde_json::to_value(snapshot).map_err(|_| "workspace-serialize".into())
        }
        WindowRequest::List {} => {
            if caller.label() != "main" { registry.session(caller.label())?; }
            let entries = registry.entries.lock().map_err(|_| "workspace-lock")?;
            serde_json::to_value(entries.values().cloned().collect::<Vec<_>>()).map_err(|_| "workspace-serialize".into())
        }
        WindowRequest::NoteAuthority {view_id} => {
            let (view,service)=scoped_view(&registry,caller.label(),Some(&view_id))?;
            require_live_view(&registry,caller.label(),&view)?;
            let authority=crate::workspace_notes_metadata::authority_for(&service,&note_ref(&view)?)?;
            require_live_view(&registry,caller.label(),&view)?;
            serde_json::to_value(authority).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::NoteMetadata {view_id,revision} => {
            let (view,service)=scoped_view(&registry,caller.label(),Some(&view_id))?;
            require_live_view(&registry,caller.label(),&view)?;
            let reference=note_ref(&view)?;
            let metadata=registry.notes_metadata.read(caller.label(),&view_id,&service,&reference,&revision,|authority|{
                let connection=crate::backend_services()?.open_read().map_err(|_|"workspace-favorite-unavailable")?;
                let legacy=format!("real-vault:{}",reference.relative_path);
                let (canonical,unscoped):(bool,bool)=connection.query_row("SELECT EXISTS(SELECT 1 FROM favorite_item WHERE item_type='note' AND item_id=?1), EXISTS(SELECT 1 FROM favorite_item WHERE item_type='note' AND item_id=?2)",rusqlite::params![authority.document_id,legacy],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|"workspace-favorite-unavailable")?;
                // A legacy path-only key has no vault owner. Never project a
                // different vault's favorite into this captured document.
                if !canonical&&unscoped{return Err("workspace-note-legacy-favorite-authority-unavailable".into());}
                Ok(crate::workspace_notes_metadata::NoteFavoriteStatus::Known(canonical))
            })?;
            require_live_view(&registry,caller.label(),&view)?;
            serde_json::to_value(metadata).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::QueryNoteMetadata {view_id,revision,query,limit} => {
            let (view,service)=scoped_view(&registry,caller.label(),Some(&view_id))?;
            require_live_view(&registry,caller.label(),&view)?;
            let result=registry.notes_metadata.query(caller.label(),&view_id,&service,&note_ref(&view)?,&revision,&query,limit)?;
            require_live_view(&registry,caller.label(),&view)?;
            serde_json::to_value(result).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::ReadNote { view_id } => {
            let (view,service)=scoped_view(&registry,caller.label(),view_id.as_deref())?;
            require_live_view(&registry,caller.label(),&view)?;
            let document = service.read_document(&note_ref(&view)?).map_err(crate::knowledge_error)?;
            require_live_view(&registry,caller.label(),&view)?;
            scoped_note_snapshot_value(&service,document)
        }
        WindowRequest::WriteNote { revision, content,view_id } => {
            let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
            let (view,service)=scoped_view(&registry,caller.label(),view_id.as_deref())?;
            require_live_view(&registry,caller.label(),&view)?;
            if revision.is_empty() || revision.len() > 128 || content.len() > 8 * 1024 * 1024 { return Err("workspace-invalid-note-write".into()); }
            // The production knowledge writer holds the file mutation lock and performs
            // revision comparison. No last-writer-wins path or global active-source change.
            let reference = note_ref(&view)?;
            let result = service.with_companion_draft_guard(&reference, || service.replace_document(&crate::knowledge::KnowledgeWriteInput {
                document_ref: reference.clone(), content, expected_revision: Some(revision),
            })).map_err(crate::knowledge_error)?;
            let peers = registry.entries.lock().map_err(|_| "workspace-lock")?.values().filter(|peer| peer.views.iter().any(|entry|entry.view.library_id == view.library_id && entry.view.resource_id == view.resource_id)).map(|peer| peer.label.clone()).collect::<Vec<_>>();
            // Events are invalidation hints, never document bodies. Even an
            // unrelated global event listener cannot read another view's data.
            for peer in peers { let _ = app.emit_to(&peer, "luckyray:workspace-note-changed", ()); }
            let _=app.emit_to("main","luckyray:workspace-note-changed",());
            let _=app.emit("luckyray:workspace-graph-changed",());
            scoped_note_snapshot_value(&service,result.document)
        }
        WindowRequest::Bind { view } => {
            let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
            registry.registration_available("main",&view.id)?;
            registry.accepting_views()?;
            if caller.label() != "main" { return Err("workspace-main-binding-required".into()); }
            if view.kind != "note" { return Err("workspace-not-a-note".into()); }
            if let Ok(existing) = main_view(&registry, "main", &view.id) {
                if existing != view { return Err("workspace-view-identity-changed".into()); }
            } else {
                let scope = saved_or_current_scope(&registry,&view)?;
                validate_grant(&view, Some(&scope))?;
                if let Some(baseline) = registry.recovery.main_view(crate::backend_services()?.app_data_dir(), &view)?.and_then(|saved|saved.attachments) { registry.attachments.register_baseline("main", baseline)?; }
                let quit=registry.quit.lock().map_err(|_|"workspace-lock")?;
                if quit.is_some(){return Err("workspace-quit-in-progress".into());}
                let mut views=registry.main_views.lock().map_err(|_| "workspace-lock")?;
                if views.len()>=100 { return Err("workspace-view-limit".into()); }
                registry.knowledge.lock().map_err(|_| "workspace-lock")?.insert(format!("main/{}",view.id),scope);
                views.insert(view.id.clone(),view.clone());
                drop(views);drop(quit);registry.persist_main(&view.id)?;
            }
            let document=registry.knowledge(&format!("main/{}",view.id))?.read_document(&note_ref(&view)?).map_err(crate::knowledge_error)?;
            serde_json::to_value(document).map_err(|_| "workspace-serialize".into())
        }
        WindowRequest::ReadBound { view_id } => {
            let view=main_view(&registry,caller.label(),&view_id)?;
            let document=registry.knowledge(&format!("main/{view_id}"))?.read_document(&note_ref(&view)?).map_err(crate::knowledge_error)?;
            serde_json::to_value(document).map_err(|_| "workspace-serialize".into())
        }
        WindowRequest::WriteBound { view_id, revision, content } => {
            let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
            let view=main_view(&registry,caller.label(),&view_id)?;
            if revision.is_empty()||revision.len()>128||content.len()>8*1024*1024 { return Err("workspace-invalid-note-write".into()); }
            let service=registry.knowledge(&format!("main/{view_id}"))?;
            let reference=note_ref(&view)?;
            let result=service.with_companion_draft_guard(&reference,||service.replace_document(&crate::knowledge::KnowledgeWriteInput{document_ref:reference.clone(),content,expected_revision:Some(revision)})).map_err(crate::knowledge_error)?;
            let _=app.emit("luckyray:workspace-note-changed",());
            let _=app.emit("luckyray:workspace-graph-changed",());
            serde_json::to_value(result.document).map_err(|_| "workspace-serialize".into())
        }
        WindowRequest::ResolveAttachment { view_id, revision, destination, wiki } => {
            if destination.len()>8192 { return Err("workspace-invalid-attachment".into()); }
            if caller.label() != "main" {
                let result = crate::workspace_attachments::issue(&registry, caller.label(), view_id.as_deref().ok_or("workspace-view-required")?, revision.as_deref().ok_or("workspace-attachment-revision-required")?, &destination, wiki)?;
                return serde_json::to_value(result).map_err(|_| "workspace-serialize".into());
            }
            // Main keeps its existing attachment transport and permissions.
            let (view,service)=scoped_view(&registry,caller.label(),view_id.as_deref())?;
            let result=service.resolve_vault_attachment(&note_ref(&view)?,&destination,wiki).map_err(crate::knowledge_error)?;
            serde_json::to_value(result).map_err(|_| "workspace-serialize".into())
        }
        WindowRequest::Dirty { dirty,view_id } => {
            let id={
                let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
                let mut entries=registry.entries.lock().map_err(|_| "workspace-lock")?;
                let session=entries.get_mut(caller.label()).ok_or("workspace-unregistered-window")?;
                if session.closing{return Err("workspace-window-closing".into());}
                let id=view_id.as_deref().unwrap_or(&session.view.id).to_owned();
                let target=session.views.iter_mut().find(|target|target.view.id==id&&target.open).ok_or("workspace-view-closed")?;
                target.dirty=dirty;if dirty{target.ready=false;target.rendered_revision=None;}session.reconcile();id
            };
            // Brokers acquire their lock before the write gate. Never reverse
            // that order from a renderer lifecycle notification.
            if dirty {registry.actions.remove_view(caller.label(),&id);}
            Ok(serde_json::Value::Null)
        }
        WindowRequest::Attach { label,view } => {
            let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
            let attached_id=view.id.clone();
            registry.registration_available(&label,&view.id)?;
            registry.accepting_views()?;
            let scope=outgoing_scope(&registry,caller.label(),&view)?;
            validate_grant(&view,Some(&scope))?;
            let attachment_baseline = if view.kind == "note" { Some(registry.attachments.outgoing_baseline(caller.label(), &view, &scope)?) } else { None };
            if caller.label() == "main" && main_view(&registry, "main", &view.id).is_ok() { registry.persist_main(&view.id)?; }
            let quit=registry.quit.lock().map_err(|_|"workspace-lock")?;
            if quit.is_some(){return Err("workspace-quit-in-progress".into());}
            let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;
            let target=entries.get_mut(&label).ok_or("workspace-unregistered-window")?;
            if target.closing{return Err("workspace-window-closing".into());}
            if let Some(existing)=target.views.iter_mut().find(|entry|entry.view.id==view.id){
                if existing.view!=view{return Err("workspace-view-identity-changed".into());}
                existing.ready=false;existing.rendered_revision=None;existing.open=true;
            }else{
                if target.views.len()>=100{return Err("workspace-view-limit".into());}
                registry.knowledge.lock().map_err(|_|"workspace-lock")?.insert(format!("{label}/{}",view.id),scope);
                target.views.push(WindowView::new(view));
            }
            target.reconcile();
            let snapshot=target.clone();drop(entries);drop(quit);
            if let Some(baseline) = attachment_baseline { registry.attachments.register_baseline(&label, baseline)?; }
            registry.persist_window(&label,false)?;
            let _=app.emit_to(&label,"luckyray:workspace-views-changed",serde_json::json!({"viewId":attached_id}));
            if let Some(window)=app.get_webview_window(&label){let _=window.show();let _=window.set_focus();}
            serde_json::to_value(snapshot).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::SetOpenViews { ids,known } => {
            registry.accepting_views()?;
            if registry.handoffs.blocks_close(caller.label())||registry.note_queue.has_pending_window(caller.label())?||registry.graph_actions.has_pending_window(caller.label())? {return Err("workspace-operation-in-progress".into());}
            let (snapshot,closed)=registry.actions.commit_view_closes(caller.label(),||{
                let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
                let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;
                let session=entries.get_mut(caller.label()).ok_or("workspace-unregistered-window")?;
                if session.closing{return Err("workspace-window-closing".into());}
                let closed=planned_closed_views(session,&ids,&known)?;
                // Retain closed document grants for layout undo; revoke only
                // transient capabilities for the views this client actually closed.
                for entry in &mut session.views{if known.contains(&entry.view.id){entry.open=ids.contains(&entry.view.id);}}
                session.reconcile();Ok((session.clone(),closed))
            })?;
            for id in &closed{registry.notes_metadata.remove_view(caller.label(),id);registry.graphs.remove_view(caller.label(),id);registry.note_queue.remove_view(caller.label(),id);registry.note_actions.remove_view(caller.label(),id);registry.graph_actions.remove_view(caller.label(),id);}
            registry.persist_window(caller.label(),false)?;
            serde_json::to_value(snapshot).map_err(|_|"workspace-serialize".into())
        }
        WindowRequest::Close { label } => {
            registry.accepting_views()?;
            let label=label.unwrap_or_else(||caller.label().into());
            if caller.label()!=label && caller.label()!="main" {return Err("workspace-window-scope-mismatch".into());}
            if registry.handoffs.blocks_close(&label)||registry.note_queue.has_pending_window(&label)?||registry.graph_actions.has_pending_window(&label)? {return Err("workspace-operation-in-progress".into());}
            let session={
                let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
                let session=registry.session(&label)?;
                if session.dirty || (caller.label()=="main" && session.ready) {return Err("workspace-target-kept-open".into());}
                registry.persist_window(&label,true)?;session
            };
            destroy_registered_window(&app,&registry,&label,&session.incarnation,true)?;
            Ok(serde_json::Value::Null)
        }
        WindowRequest::QuitAck { id,saved } => {
            registry.acknowledge_quit(caller.label(),&id,saved)?;Ok(serde_json::Value::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn withdrawn_product_refuses_creation_restoration_transfer_and_service_dispatch() {
        let requests = vec![
            DispatchRequest::Core(WindowRequest::Open { view: view() }),
            DispatchRequest::Core(WindowRequest::Attach { label: "workspace-old".into(), view: view() }),
            DispatchRequest::Core(WindowRequest::Bootstrap {}),
            DispatchRequest::Core(WindowRequest::List {}),
            DispatchRequest::Core(WindowRequest::RecoverableWindows {}),
            DispatchRequest::Core(WindowRequest::RestoreWindow { id: "workspace-old".into() }),
            DispatchRequest::Core(WindowRequest::BeginDrag { id: "drag".into(), view: view() }),
            DispatchRequest::Core(WindowRequest::NativeGestureSupport {}),
            DispatchRequest::Core(WindowRequest::OfferToMain { view_id: Some("v1".into()) }),
            DispatchRequest::Core(WindowRequest::WriteBound { view_id: "v1".into(), revision: "r".into(), content: "synthetic".into() }),
            DispatchRequest::Host(host_dispatch::HostRequest::HandoffPending {}),
            DispatchRequest::Host(host_dispatch::HostRequest::BeginHandoff { request_id: "request".into(), view_id: "v1".into(), revision: "r".into(), source_id: "source".into(), presentation: serde_json::Value::Null, move_source: false, target_label: None }),
            DispatchRequest::Note(note_dispatch::NoteRequest::NoteMainPending {}),
        ];
        for request in requests {
            assert!(!product_request_allowed(&request, false));
            assert!(product_request_allowed(&request, true), "verified fixture source remains available separately");
        }
    }
    #[test]
    fn withdrawn_product_preserves_saved_and_failed_normal_exit_acknowledgements() {
        for saved in [true, false] {
            let request = DispatchRequest::Core(WindowRequest::QuitAck { id: "exact-quit-round".into(), saved });
            assert!(product_request_allowed(&request, false));
        }
        // A dispatch exception does not weaken identity or wire-shape validation.
        rejects_extra_fields::<DispatchRequest>(serde_json::json!({"op":"quitAck","id":"round","saved":false}));
        let registry = WorkspaceWindows::default();
        assert!(registry.acknowledge_quit("main", "missing-round", true).is_err());
    }
    #[test]
    fn withdrawn_product_cannot_enable_windows_using_a_development_identity() {
        for identifier in ["com.luckyray.desktop.dev", "com.luckyray.desktop", "com.luckyray.workspace.fixture.other", ""] {
            assert!(!fixture_windows_enabled(identifier));
        }
        assert_eq!(fixture_windows_enabled("com.luckyray.workspace.fixture"), cfg!(all(debug_assertions, feature = "workspace-runtime-fixture")));
    }
    fn rejects_extra_fields<T:serde::de::DeserializeOwned>(clean:serde_json::Value){
        assert!(serde_json::from_value::<T>(clean.clone()).is_ok(),"canonical payload: {clean}");
        for(field,value)in[("path",serde_json::json!("/private")),("caller",serde_json::json!("main")),("windowLabel",serde_json::json!("main")),("command",serde_json::json!("sh"))]{
            let mut forged=clean.clone();forged[field]=value;
            assert!(serde_json::from_value::<T>(forged.clone()).is_err(),"unexpected field accepted: {forged}");
        }
    }
    fn rejects_nested_extra_fields(clean:serde_json::Value,key:&str){
        assert!(serde_json::from_value::<DispatchRequest>(clean.clone()).is_ok(),"canonical dispatch: {clean}");
        for(field,value)in[("path",serde_json::json!("/private")),("caller",serde_json::json!("main")),("command",serde_json::json!("sh"))]{
            let mut forged=clean.clone();forged[key][field]=value;
            assert!(serde_json::from_value::<DispatchRequest>(forged.clone()).is_err(),"nested field accepted: {forged}");
        }
    }
    #[test] fn empty_native_dispatch_variants_reject_extra_fields(){
        for op in["handoffPending","noteMainPending","bootstrap","list","nativeGestureSupport","recoverableWindows","pendingMerges"]{
            rejects_extra_fields::<DispatchRequest>(serde_json::json!({"op":op}));
        }
    }
    #[test] fn empty_native_actions_reject_nested_fields_without_dispatch_fallback(){
        for kind in["browse-attachments","edit-document-tags","ask-ai","suggest-ai","import-document","close-view"]{
            let action=serde_json::json!({"kind":kind});rejects_extra_fields::<note_dispatch::NoteAction>(action.clone());
            rejects_nested_extra_fields(serde_json::json!({"op":"noteAction","viewId":"v","authority":{"vaultId":"vault","sourceId":"source","documentId":"doc"},"requestId":1,"revision":"r","generation":1,"content":"saved","action":action}),"action");
        }
        let screenshot=serde_json::json!({"kind":"saveScreenshot"});
        rejects_extra_fields::<crate::workspace_graph_actions::GraphExecuteInput>(screenshot.clone());
        rejects_nested_extra_fields(serde_json::json!({"op":"graphMainExecute","id":"receipt","claimToken":"claim","leaseToken":"lease","input":screenshot}),"input");
    }
    #[test] fn empty_native_completions_keep_wire_shape_and_reject_nested_fields(){
        use crate::workspace_graph_actions::GraphCompletion;
        for result in[GraphCompletion::Acknowledged {},GraphCompletion::Cancelled {}]{
            let clean=serde_json::to_value(&result).unwrap();
            let expected=if matches!(result,GraphCompletion::Acknowledged {}){"acknowledged"}else{"cancelled"};
            assert_eq!(clean,serde_json::json!({"kind":expected}));
            rejects_extra_fields::<GraphCompletion>(clean.clone());
            rejects_nested_extra_fields(serde_json::json!({"op":"graphMainComplete","id":"receipt","claimToken":"claim","leaseToken":"lease","result":clean}),"result");
        }
        let cancelled=serde_json::json!({"kind":"cancelled"});
        rejects_extra_fields::<crate::workspace_note_actions::NoteMainCompletion>(cancelled.clone());
        rejects_nested_extra_fields(serde_json::json!({"op":"noteMainComplete","id":"receipt","claimToken":"claim","result":cancelled}),"result");
    }
    #[test] fn note_pending_still_uses_the_native_caller(){
        let store=crate::workspace_note_actions::NoteActionStore::default();
        assert!(store.pending("workspace-child").is_err());
        assert!(store.pending("main").is_ok());
    }
    #[test]
    fn workspace_fixture_request_is_absent_without_debug_and_feature() {
        let request = serde_json::from_value::<WindowRequest>(serde_json::json!({"op":"fixtureReport","report":{"stage":"bootstrap"}}));
        #[cfg(all(debug_assertions, feature = "workspace-runtime-fixture"))]
        assert!(request.is_ok());
        #[cfg(not(all(debug_assertions, feature = "workspace-runtime-fixture")))]
        assert!(request.is_err());
    }
    fn view() -> ViewGrant { ViewGrant { id:"v1".into(),kind:"note".into(),library_id:"vault-a".into(),resource_id:Some("a.md".into()),title:"A".into() } }
    #[test] fn close_plan_rejects_dirty_invalid_and_ignores_unknown_new_views(){
        let mut session=WindowSession::new("workspace-test".into(),view());
        let mut later=view();later.id="later".into();session.views.push(WindowView::new(later));
        assert_eq!(planned_closed_views(&session,&[],&["v1".into()]).unwrap(),vec!["v1"]);
        assert!(planned_closed_views(&session,&["foreign".into()],&["v1".into()]).is_err());
        session.views[0].dirty=true;
        assert!(planned_closed_views(&session,&[],&["v1".into()]).is_err());
        assert!(session.views.iter().all(|entry|entry.open));
    }
    #[test] fn main_participates_in_quit_without_workspace_bindings() {
        assert_eq!(quit_participants(Vec::new(), true), vec!["main"]);
        assert_eq!(quit_participants(vec!["workspace-one".into()], true), vec!["main", "workspace-one"]);
        assert_eq!(quit_participants(vec!["workspace-one".into()], false), vec!["workspace-one"]);
    }
    #[test] fn quit_ack_requires_exact_round_and_participant_and_freezes_new_views(){
        let registry=WorkspaceWindows::default();
        *registry.quit.lock().unwrap()=Some(QuitRound{id:"r1".into(),responses:HashMap::from([("main".into(),None),("workspace-real".into(),None)])});
        assert!(registry.acknowledge_quit("workspace-forged","r1",true).is_err());
        assert!(registry.acknowledge_quit("main","old-round",true).is_err());
        assert!(registry.accepting_views().is_err());
        assert!(registry.insert(WindowSession::new("workspace-new".into(),view())).is_err());
        registry.acknowledge_quit("main","r1",true).unwrap();
        assert!(registry.acknowledge_quit("main","r1",false).is_err());
        registry.acknowledge_quit("workspace-real","r1",false).unwrap();
        assert!(registry.quit.lock().unwrap().as_ref().unwrap().responses.values().any(|value|*value==Some(false)));
    }
    #[test] fn main_document_read_revokes_coverage_before_returning_a_guard(){
        let registry=WorkspaceWindows::default();*registry.main_binding_coverage.lock().unwrap()=(3,true);
        {let _read=registry.guard_main_document_read().unwrap();assert_eq!(*registry.main_binding_coverage.lock().unwrap(),(4,false));assert!(registry.write_gate.try_lock().is_err());}
        assert!(registry.write_gate.try_lock().is_ok());
    }
    #[test] fn closeout_merged_empty_window_is_not_automatically_restored(){
        let root=tempfile::tempdir().unwrap();let registry=WorkspaceWindows::default();
        let mut session=WindowSession::new("workspace-merged".into(),view());
        registry.insert(session.clone()).unwrap();registry.persist_window_at(&session.label,false,root.path()).unwrap();
        for entry in &mut session.views{entry.open=false;}session.reconcile();
        registry.entries.lock().unwrap().insert(session.label.clone(),session.clone());
        registry.persist_window_at(&session.label,false,root.path()).unwrap();
        registry.persist_window_at(&session.label,true,root.path()).unwrap();
        let saved=crate::workspace_recovery::RecoveryStore::default().window(root.path(),&session.label).unwrap();
        assert!(saved.closed,"Merged/closed last pane must not leave an auto-restorable window");
        assert_eq!(saved.views.len(),1);assert_eq!(saved.views[0].view,view());
    }
    #[test] fn closeout_pending_transfer_keeps_original_window_recoverable(){
        let root=tempfile::tempdir().unwrap();let registry=WorkspaceWindows::default();
        let mut session=WindowSession::new("workspace-pending".into(),view());
        registry.insert(session.clone()).unwrap();registry.persist_window_at(&session.label,false,root.path()).unwrap();
        session.views[0].transfer_pending=true;session.reconcile();
        registry.entries.lock().unwrap().insert(session.label.clone(),session.clone());
        registry.persist_window_at(&session.label,false,root.path()).unwrap();
        let saved=crate::workspace_recovery::RecoveryStore::default().window(root.path(),&session.label).unwrap();
        assert!(!saved.closed);assert_eq!(saved.views[0].view,view());
    }
    fn note_scope_fixture()->(tempfile::TempDir,crate::knowledge::KnowledgeService){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("vault");std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let registration=crate::knowledge::KnowledgeVaultRegistration{id:"vault-a".into(),name:"Synthetic".into(),root_path:root.to_string_lossy().into(),mode:"vault-bound".into(),created_at:"2026-10-06T00:00:00Z".into(),last_opened_at:"2026-10-06T00:00:00Z".into(),schema_version:1,link_update_policy:Default::default()};
        std::fs::write(root.join(".luckyray/vault.json"),serde_json::to_vec(&registration).unwrap()).unwrap();std::fs::write(root.join("a.md"),"# synthetic").unwrap();
        let global=crate::knowledge::KnowledgeService::initialize(temp.path().join("app")).unwrap();global.register_current_vault(&registration).unwrap();let scope=global.capture_workspace_scope("vault-a").unwrap();(temp,scope)
    }
    #[test] fn rename_rejects_clean_duplicate_main_view_and_incomplete_binding_coverage(){
        let (_temp,scope)=note_scope_fixture();let registry=WorkspaceWindows::default();let v=view();registry.insert(WindowSession::new("workspace-origin".into(),v.clone())).unwrap();registry.knowledge.lock().unwrap().insert("workspace-origin/v1".into(),scope.clone());
        assert!(guard_note_rename(&registry,"workspace-origin",&v,&scope).is_err());
        *registry.main_binding_coverage.lock().unwrap()=(1,true);
        assert!(guard_note_rename(&registry,"workspace-origin",&v,&scope).is_ok());
        let mut peer=v.clone();peer.id="main-peer".into();registry.main_views.lock().unwrap().insert(peer.id.clone(),peer);registry.knowledge.lock().unwrap().insert("main/main-peer".into(),scope.clone());
        assert_eq!(guard_note_rename(&registry,"workspace-origin",&v,&scope).err().unwrap(),"workspace-note-rename-other-view-open");
        registry.main_views.lock().unwrap().remove("main-peer");assert!(guard_note_rename(&registry,"workspace-origin",&v,&scope).is_ok());
    }
    #[test] fn document_mutation_guard_preserves_other_window_dirty_input(){
        let (_temp,scope)=note_scope_fixture();let registry=WorkspaceWindows::default();let v=view();let mut session=WindowSession::new("workspace-peer".into(),v.clone());session.views[0].dirty=true;registry.insert(session).unwrap();
        assert_eq!(guard_document_writes(&registry,&scope,&[note_ref(&v).unwrap()]).err().unwrap(),"workspace-document-has-unsaved-input");
        registry.entries.lock().unwrap().get_mut("workspace-peer").unwrap().views[0].dirty=false;
        assert!(guard_document_writes(&registry,&scope,&[note_ref(&v).unwrap()]).is_ok());
    }
    #[test] fn closed_child_grant_cannot_read_or_copy_until_explicit_reopen(){
        let (_temp,scope)=note_scope_fixture();let registry=WorkspaceWindows::default();let v=view();registry.insert(WindowSession::new("workspace-child".into(),v.clone())).unwrap();registry.knowledge.lock().unwrap().insert("workspace-child/v1".into(),scope);
        assert!(scoped_view(&registry,"workspace-child",Some("v1")).is_ok());
        registry.entries.lock().unwrap().get_mut("workspace-child").unwrap().views[0].open=false;
        assert!(scoped_view(&registry,"workspace-child",Some("v1")).is_err());assert!(outgoing_scope(&registry,"workspace-child",&v).is_err());
        registry.entries.lock().unwrap().get_mut("workspace-child").unwrap().views[0].open=true;
        assert!(scoped_view(&registry,"workspace-child",Some("v1")).is_ok());
    }
    #[test] fn main_path_retirement_vetoes_exact_child_document_and_folder_only(){
        let (temp,scope)=note_scope_fixture();let registry=WorkspaceWindows::default();let mut v=view();v.resource_id=Some("folder/a.md".into());registry.insert(WindowSession::new("workspace-child".into(),v)).unwrap();registry.knowledge.lock().unwrap().insert("workspace-child/v1".into(),scope.clone());
        let record=scope.workspace_recovery_record().unwrap();let root=record.root_path();
        assert_eq!(root,temp.path().join("vault").canonicalize().unwrap().as_path());
        assert!(registry.guard_main_path_retirement(root,std::path::Path::new("folder/a.md"),false).is_err());
        assert!(registry.guard_main_path_retirement(root,std::path::Path::new("folder"),true).is_err());
        assert!(registry.guard_main_path_retirement(root,std::path::Path::new("folder-b"),true).is_ok());
        let other=temp.path().join("other");std::fs::create_dir_all(&other).unwrap();assert!(registry.guard_main_path_retirement(&other,std::path::Path::new("folder"),true).is_ok());
        registry.entries.lock().unwrap().get_mut("workspace-child").unwrap().views[0].open=false;
        assert!(registry.guard_main_path_retirement(root,std::path::Path::new("folder"),true).is_ok());
    }
    #[test] fn main_target_requires_an_exact_live_render_proof(){
        let (_temp,scope)=note_scope_fixture();let registry=WorkspaceWindows::default();let v=view();registry.insert(WindowSession::new("workspace-source".into(),v.clone())).unwrap();registry.knowledge.lock().unwrap().insert("workspace-source/v1".into(),scope.clone());
        let mut target=v.clone();target.id="main-incoming".into();registry.main_views.lock().unwrap().insert(target.id.clone(),target.clone());registry.knowledge.lock().unwrap().insert("main/main-incoming".into(),scope.clone());
        let authority=crate::workspace_notes_metadata::authority_for(&scope,&note_ref(&v).unwrap()).unwrap();let revision=scope.read_document(&note_ref(&v).unwrap()).unwrap().revision;
        let offer=registry.handoffs.begin("cccccccccccccccccccccccccccccccc","workspace-source","main",&v,&target.id,crate::workspace_handoff::HandoffIdentity{source_id:authority.source_id.clone(),vault_id:authority.vault_id,document_id:Some(authority.document_id)},&revision,serde_json::json!({"version":1}),true).unwrap();
        registry.admission_owners.lock().unwrap().insert("main/main-incoming".into(),offer.id.clone());
        assert!(host_dispatch::validate_offer(&registry,&offer,true).is_err());
        registry.main_ready.lock().unwrap().insert(target.id.clone(),(revision.clone(),authority.source_id.clone()));assert!(host_dispatch::validate_offer(&registry,&offer,true).is_ok());
        registry.main_ready.lock().unwrap().remove(&target.id);assert!(host_dispatch::validate_offer(&registry,&offer,true).is_err());
    }
    #[test] fn cancelled_cleanup_cannot_remove_a_new_admission_with_equal_labels_and_view_ids(){
        let registry=WorkspaceWindows::default();let v=view();let mut first=WindowSession::new("workspace-target".into(),v.clone());first.views[0].admission_id=Some("A".into());let old_incarnation=first.incarnation.clone();registry.insert(first).unwrap();registry.admission_owners.lock().unwrap().insert("workspace-target/v1".into(),"A".into());
        assert!(host_dispatch::retire_target(&registry,"workspace-target","v1",Some("A")).unwrap());
        let mut replacement=WindowSession::new("workspace-target".into(),v.clone());replacement.views[0].admission_id=Some("B".into());registry.entries.lock().unwrap().insert("workspace-target".into(),replacement);registry.admission_owners.lock().unwrap().insert("workspace-target/v1".into(),"B".into());
        assert!(!host_dispatch::retire_target(&registry,"workspace-target","v1",Some("A")).unwrap());
        registry.remove_if("workspace-target",&old_incarnation);
        assert_eq!(registry.session("workspace-target").unwrap().views[0].admission_id.as_deref(),Some("B"));
        assert_eq!(registry.admission_owners.lock().unwrap().get("workspace-target/v1").map(String::as_str),Some("B"));
    }
    #[test] fn main_retirement_uses_the_writer_normalized_document_path(){
        let (_temp,scope)=note_scope_fixture();let registry=WorkspaceWindows::default();let v=view();registry.insert(WindowSession::new("workspace-child".into(),v.clone())).unwrap();registry.knowledge.lock().unwrap().insert("workspace-child/v1".into(),scope.clone());
        let mut reference=note_ref(&v).unwrap();reference.relative_path=" a.md ".into();assert!(registry.guard_main_document_retirement(&scope,&reference).is_err());
    }
    #[test] fn native_destroy_claim_captures_old_handle_and_reserves_label_until_completion(){
        let registry=WorkspaceWindows::default();let first=WindowSession::new("workspace-target".into(),view());let old=first.incarnation.clone();registry.insert(first).unwrap();
        let (captured,was_closing)=registry.claim_destroy("workspace-target",&old,||Some("native-X")).unwrap().unwrap();assert_eq!(captured,Some("native-X"));
        registry.remove_if("workspace-target",&old); // Native Destroyed during the claimed operation.
        assert!(registry.session("workspace-target").unwrap().destroyed);
        assert!(registry.claim_destroy("workspace-target",&old,||Some("must-not-look-up-again")).is_err());
        assert!(registry.insert(WindowSession::new("workspace-target".into(),view())).is_err());
        assert!(registry.finish_destroy("workspace-target",&old,was_closing,true,true,false).unwrap());registry.remove_if("workspace-target",&old);
        let next=WindowSession::new("workspace-target".into(),view());let fresh=next.incarnation.clone();registry.insert(next).unwrap();
        assert!(!registry.finish_destroy("workspace-target",&old,false,true,false,false).unwrap());registry.remove_if("workspace-target",&old);
        assert_eq!(registry.session("workspace-target").unwrap().incarnation,fresh);
    }
    #[test] fn accepted_destroy_waits_for_callback_and_failure_rollback_is_exact(){
        let registry=WorkspaceWindows::default();let first=WindowSession::new("workspace-target".into(),view());let id=first.incarnation.clone();registry.insert(first).unwrap();
        registry.claim_destroy("workspace-target",&id,||Some(1)).unwrap();assert!(!registry.finish_destroy("workspace-target",&id,false,true,false,false).unwrap());assert!(!registry.session("workspace-target").unwrap().closing);
        registry.claim_destroy("workspace-target",&id,||Some(1)).unwrap();assert!(!registry.finish_destroy("workspace-target",&id,false,true,true,false).unwrap());assert!(registry.insert(WindowSession::new("workspace-target".into(),view())).is_err());
        registry.remove_if("workspace-target",&id);assert!(registry.session("workspace-target").is_err());
    }
    #[test] fn prefix_does_not_grant_access_and_resource_scope_is_exact() {
        let registry=WorkspaceWindows::default(); let v=view();
        assert!(registry.authorize("workspace-forged",&v).is_err());
        registry.insert(WindowSession::new("workspace-real".into(),v.clone())).unwrap();
        assert!(registry.authorize("workspace-real",&v).is_ok());
        let mut other=v.clone();other.library_id="vault-b".into();assert!(registry.authorize("workspace-real",&other).is_err());
        other=v.clone();other.resource_id=Some("b.md".into());assert!(registry.authorize("workspace-real",&other).is_err());
        registry.remove("workspace-real");assert!(registry.authorize("workspace-real",&v).is_err());
    }
}

// Shared dispatch helpers never infer a renderer's source from Main's active UI.
fn captured_catalog(registry:&WorkspaceWindows,label:&str,view_id:&str)->Result<crate::materials::MaterialCatalog,String>{
 registry.graph_catalogs.lock().map_err(|_|"workspace-lock")?.get(&format!("{label}/{view_id}")).cloned().ok_or("workspace-graph-catalog-scope-required".into())
}
fn read_graph(registry:&WorkspaceWindows,label:&str,view:&ViewGrant,scope:&crate::knowledge::KnowledgeService)->Result<crate::workspace_graph::GraphSnapshot,String>{
 if view.kind!="graph"{return Err("workspace-graph-view-required".into());}
 let resolver=crate::workspace_graph_actions::CapturedCatalogResolver::capture(&captured_catalog(registry,label,&view.id)?)?;
 registry.graphs.read(label,&view.id,scope,|target|resolver.resolve(target))
}
fn live_action(registry:&WorkspaceWindows,label:&str,view:&ViewGrant,correlation:&crate::workspace_actions::ActionCorrelation)->Result<(),String>{
 if correlation.request_id==0||correlation.request_id>9_007_199_254_740_991||correlation.generation>9_007_199_254_740_991||correlation.revision.is_empty(){return Err("workspace-action-invalid-request".into());}
 require_live_view(registry,label,view)?;
 if label!="main"&&registry.session(label)?.view(Some(&view.id))?.dirty{return Err("workspace-source-not-saved".into());}
 if label=="main"&&registry.main_dirty.lock().map_err(|_|"workspace-lock")?.get(&view.id).copied().unwrap_or(false){return Err("workspace-source-not-saved".into());}
 Ok(())
}
fn guard_document_writes<'a>(registry:&'a WorkspaceWindows,scope:&crate::knowledge::KnowledgeService,references:&[crate::knowledge::KnowledgeDocumentRef])->Result<std::sync::MutexGuard<'a,()>,String>{
 let gate=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
 if references.is_empty()||references.len()>64||references.iter().any(|reference|reference.vault_id!=scope.current_vault_id().unwrap_or_default()){return Err("workspace-write-target-invalid".into());}
 let matches=|view:&ViewGrant|view.kind=="note"&&references.iter().any(|reference|view.library_id==reference.vault_id&&view.resource_id.as_deref()==Some(&reference.relative_path));
 // Do not hold registry entries while entering KnowledgeService's mutation
 // lock: actions validate lifecycle from inside its own exact-file guard.
 {let entries=registry.entries.lock().map_err(|_|"workspace-lock")?;if entries.values().any(|window|window.views.iter().any(|view|view.open&&view.dirty&&matches(&view.view))){return Err("workspace-document-has-unsaved-input".into());}}
 {let dirty=registry.main_dirty.lock().map_err(|_|"workspace-lock")?;let views=registry.main_views.lock().map_err(|_|"workspace-lock")?;if views.values().any(|view|matches(view)&&dirty.get(&view.id).copied().unwrap_or(false)){return Err("workspace-document-has-unsaved-input".into());}}
 Ok(gate)
}
fn guard_note_rename<'a>(registry:&'a WorkspaceWindows,origin:&str,view:&ViewGrant,scope:&crate::knowledge::KnowledgeService)->Result<std::sync::MutexGuard<'a,()>,String>{
 let gate=guard_document_writes(registry,scope,&[note_ref(view)?])?;
 if !registry.main_binding_coverage.lock().map_err(|_|"workspace-lock")?.1{return Err("workspace-main-note-bindings-not-ready".into());}
 require_live_view(registry,origin,view)?;
 let identity=scope.current_target_identity().map_err(crate::knowledge_error)?;
 let same=|other:&ViewGrant|other.kind=="note"&&other.library_id==view.library_id&&other.resource_id==view.resource_id;
 let mut peers=registry.main_views.lock().map_err(|_|"workspace-lock")?.values().filter(|other|same(other)&&!(origin=="main"&&other.id==view.id)).map(|other|("main".to_owned(),other.id.clone())).collect::<Vec<_>>();
 {let entries=registry.entries.lock().map_err(|_|"workspace-lock")?;for(label,window)in entries.iter(){for entry in &window.views{if entry.open&&same(&entry.view)&&!(label==origin&&entry.view.id==view.id){peers.push((label.clone(),entry.view.id.clone()));}}}}
 for(label,id)in peers{if registry.knowledge(&format!("{label}/{id}"))?.current_target_identity().map_err(crate::knowledge_error)?==identity{return Err("workspace-note-rename-other-view-open".into());}}
 // Until every duplicate controller can migrate atomically, a duplicate is an
 // explicit veto, including clean Main views. No file is changed before this.
 Ok(gate)
}
fn attach_scoped_note(app:&tauri::AppHandle,registry:&WorkspaceWindows,origin:&str,scope:&crate::knowledge::KnowledgeService,reference:&crate::knowledge::KnowledgeDocumentRef,title:&str)->Result<ViewGrant,String>{attach_note_inner(app,registry,origin,scope,reference,title,true)}
fn attach_scoped_note_without_attachments(app:&tauri::AppHandle,registry:&WorkspaceWindows,origin:&str,scope:&crate::knowledge::KnowledgeService,reference:&crate::knowledge::KnowledgeDocumentRef,title:&str)->Result<ViewGrant,String>{attach_note_inner(app,registry,origin,scope,reference,title,false)}
fn attach_note_inner(app:&tauri::AppHandle,registry:&WorkspaceWindows,origin:&str,scope:&crate::knowledge::KnowledgeService,reference:&crate::knowledge::KnowledgeDocumentRef,title:&str,capture_attachments:bool)->Result<ViewGrant,String>{
 registry.accepting_views()?;scope.read_document(reference).map_err(crate::knowledge_error)?;
 if reference.vault_id!=scope.current_vault_id().map_err(crate::knowledge_error)?{return Err("workspace-note-scope-mismatch".into());}
 let view=ViewGrant{id:format!("native-note-{:032x}",rand::random::<u128>()),kind:"note".into(),library_id:reference.vault_id.clone(),resource_id:Some(reference.relative_path.clone()),title:title.chars().take(512).collect()};
 registry.registration_available(origin,&view.id)?;
 let baseline=baseline_for_note_open(registry,scope,&view,capture_attachments)?;
 registry.attachments.register_baseline(origin,baseline)?;
 registry.knowledge.lock().map_err(|_|"workspace-lock")?.insert(format!("{origin}/{}",view.id),scope.clone());
 if origin=="main"{registry.main_views.lock().map_err(|_|"workspace-lock")?.insert(view.id.clone(),view.clone());}
 else{let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;let window=entries.get_mut(origin).ok_or("workspace-unregistered-window")?;if window.closing{return Err("workspace-window-closing".into());}if window.views.len()>=100{return Err("workspace-view-limit".into());}window.views.push(WindowView::new(view.clone()));window.reconcile();}
 let _=app.emit_to(origin,"luckyray:workspace-views-changed",serde_json::json!({"viewId":view.id}));
 Ok(view)
}
fn rebind_scoped_note(registry:&WorkspaceWindows,origin:&str,old:&ViewGrant,snapshot:&crate::knowledge::KnowledgeDocumentSnapshot)->Result<ViewGrant,String>{
 require_live_view(registry,origin,old)?;
 let scope=registry.knowledge(&format!("{origin}/{}",old.id))?;
 if snapshot.summary.document_ref.vault_id!=old.library_id{return Err("workspace-note-scope-mismatch".into());}
 let new=ViewGrant{id:old.id.clone(),kind:"note".into(),library_id:old.library_id.clone(),resource_id:Some(snapshot.summary.document_ref.relative_path.clone()),title:snapshot.summary.title.clone()};
 registry.attachments.rebind_after_rename(origin,old,&new,&scope,&snapshot.revision)?;
 if origin=="main"{registry.main_views.lock().map_err(|_|"workspace-lock")?.insert(old.id.clone(),new.clone());}
 else{let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;let session=entries.get_mut(origin).ok_or("workspace-unregistered-window")?;let entry=session.views.iter_mut().find(|entry|entry.open&&entry.view==*old).ok_or("workspace-view-closed")?;entry.view=new.clone();entry.ready=false;entry.rendered_revision=None;session.reconcile();}
 registry.notes_metadata.remove_view(origin,&old.id);
 // The origin applies and validates the returned grant before publishing its
 // rename event; no runtime is disposed ahead of the correlated action reply.
 Ok(new)
}

fn baseline_for_note_open(registry:&WorkspaceWindows,scope:&crate::knowledge::KnowledgeService,view:&ViewGrant,capture_new:bool)->Result<crate::workspace_attachments::AttachmentBaseline,String>{
 let expected=scope.current_target_identity().map_err(crate::knowledge_error)?;
 let same=|other:&ViewGrant|other.kind=="note"&&other.library_id==view.library_id&&other.resource_id==view.resource_id;
 let mut held=registry.main_views.lock().map_err(|_|"workspace-lock")?.values().filter(|other|same(other)).map(|other|("main".to_string(),other.clone())).collect::<Vec<_>>();
 {let windows=registry.entries.lock().map_err(|_|"workspace-lock")?;for(label,window)in windows.iter(){for entry in &window.views{if same(&entry.view){held.push((label.clone(),entry.view.clone()));}}}}
 for(label,other)in held{if let Ok(captured)=registry.knowledge(&format!("{label}/{}",other.id)){if captured.current_target_identity().map_err(crate::knowledge_error)?==expected{if let Some(baseline)=registry.attachments.saved_baseline(&label,&other)?{return baseline.for_view(view);}}}}
 // Closed-view recovery retains an imported/previously-authorized baseline.
 // Reopening under a new view ID must not rescan child-authored links.
 for window in registry.recovery.list(crate::backend_services()?.app_data_dir())?{for saved in window.views{if !same(&saved.view){continue;}if let(Some(record),Some(baseline))=(saved.scope,saved.attachments){if let Ok(captured)=crate::knowledge_service()?.restore_workspace_scope(&record){if captured.current_target_identity().map_err(crate::knowledge_error)?==expected{return baseline.for_view(view);}}}}}
 if capture_new{registry.attachments.outgoing_baseline("main",view,scope)}else{serde_json::from_value(serde_json::json!({"view":view,"references":[]})).map_err(|_|"workspace-attachment-invalid-baseline".into())}
}
