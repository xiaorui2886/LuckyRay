//! Integrated production host commands. Core/legacy fixture wire shapes remain
//! separate. Every source is derived from an authenticated registered view.
use super::*;
use crate::workspace_actions::ActionCorrelation;
use crate::workspace_graph_actions::{GraphMainKind,GraphExecuteInput,GraphCompletion,CapturedCatalogResolver};
use crate::workspace_handoff::{HandoffIdentity,HandoffOffer,HandoffPhase};
use serde_json::{json,Value};
#[derive(Deserialize)]
#[serde(tag="op",rename_all="camelCase",deny_unknown_fields)]
pub(super) enum HostRequest {
 BindScoped {view:ViewGrant,#[serde(rename="materialLibraryId")] material_library_id:Option<String>},
 BeginHandoff {#[serde(rename="requestId")]request_id:String,#[serde(rename="viewId")]view_id:String,revision:String,#[serde(rename="sourceId")]source_id:String,presentation:Value,#[serde(rename="moveSource")]move_source:bool,#[serde(rename="targetLabel")]target_label:Option<String>},
 HandoffPending {},HandoffRead{id:String},HandoffFind{#[serde(rename="requestId")]request_id:String},HandoffCancelRequest{#[serde(rename="requestId")]request_id:String},HandoffSettled{id:String},
 HandoffApplied{id:String,#[serde(rename="targetViewId")]target_view_id:String,revision:String,#[serde(rename="presentationHash")]presentation_hash:String},
 HandoffCommit{id:String},HandoffCancel{id:String},
 IntegratedNotReady {#[serde(rename="viewId")]view_id:String},
 IntegratedReady {#[serde(rename="viewId")]view_id:String,revision:String,#[serde(rename="sourceId")]source_id:String,#[serde(rename="snapshotId")]snapshot_id:Option<String>},
 MainBindingCoverage {ready:Option<bool>,generation:Option<u64>},
 ReleaseScoped {#[serde(rename="viewId")]view_id:String},
 BoundDirty {#[serde(rename="viewId")]view_id:String,dirty:bool},
 GraphRead {#[serde(rename="viewId")]view_id:String,#[serde(default)]refresh:bool},
 GraphCapabilities {#[serde(rename="viewId")]view_id:String},
 GraphMutateTag {#[serde(rename="viewId")]view_id:String,#[serde(rename="snapshotId")]snapshot_id:String,#[serde(rename="sourceToken")]source_token:String,#[serde(rename="targetToken")]target_token:String,mode:crate::workspace_graph::GraphRelationMode},
 GraphNodeAction {#[serde(rename="viewId")]view_id:String,#[serde(rename="snapshotId")]snapshot_id:String,#[serde(rename="sourceId")]source_id:String,#[serde(rename="nodeToken")]node_token:String,#[serde(rename="requestId")]request_id:u64,action:crate::workspace_actions::GraphAction},
 GraphScreenshot {#[serde(rename="viewId")]view_id:String,#[serde(rename="snapshotId")]snapshot_id:String,#[serde(rename="sourceId")]source_id:String,revision:String,#[serde(rename="requestId")]request_id:u64,bytes:Vec<u8>},
 GraphActionStatus {#[serde(rename="viewId")]view_id:String,id:String,#[serde(rename="requestId")]request_id:u64,revision:String,generation:u64},
 GraphMainRegister{kinds:Vec<GraphMainKind>},
 GraphMainPending{#[serde(rename="leaseToken")]lease_token:String},
 GraphMainClaim{id:String,#[serde(rename="leaseToken")]lease_token:String},
 GraphMainValidate{id:String,#[serde(rename="claimToken")]claim_token:String,#[serde(rename="leaseToken")]lease_token:String},
 GraphMainExecute{id:String,#[serde(rename="claimToken")]claim_token:String,#[serde(rename="leaseToken")]lease_token:String,input:GraphExecuteInput},
 GraphMainComplete{id:String,#[serde(rename="claimToken")]claim_token:String,#[serde(rename="leaseToken")]lease_token:String,result:GraphCompletion},
}
fn value(value:impl Serialize)->Result<Value,String>{serde_json::to_value(value).map_err(|_|"workspace-serialize".into())}
fn update_main_coverage(coverage:&mut (u64,bool),ready:Option<bool>,generation:Option<u64>)->Result<(),String>{
 if ready==Some(true){if generation!=Some(coverage.0){return Err("workspace-main-bindings-changed".into());}coverage.1=true;}
 else if ready==Some(false){coverage.0=coverage.0.checked_add(1).ok_or("workspace-coverage-generation-limit")?;coverage.1=false;}
 Ok(())
}
#[cfg(test)]
mod coverage_tests {
 use super::*;
 #[test] fn r9_coverage_observation_does_not_revoke_and_stale_ready_is_rejected(){
  let mut coverage=(7,true);
  for _ in 0..20{update_main_coverage(&mut coverage,None,None).unwrap();assert_eq!(coverage,(7,true));}
  update_main_coverage(&mut coverage,Some(false),None).unwrap();assert_eq!(coverage,(8,false));
  assert!(update_main_coverage(&mut coverage,Some(true),Some(7)).is_err());assert_eq!(coverage,(8,false));
  assert!(update_main_coverage(&mut coverage,Some(true),None).is_err());
  update_main_coverage(&mut coverage,Some(true),Some(8)).unwrap();assert_eq!(coverage,(8,true));
  assert!(matches!(serde_json::from_value::<HostRequest>(json!({"op":"mainBindingCoverage"})).unwrap(),HostRequest::MainBindingCoverage{ready:None,generation:None}));
 }
}
fn identity(view:&ViewGrant,scope:&crate::knowledge::KnowledgeService)->Result<HandoffIdentity,String>{
 if view.kind=="note"{let authority=crate::workspace_notes_metadata::authority_for(scope,&note_ref(view)?)?;Ok(HandoffIdentity{source_id:authority.source_id,vault_id:authority.vault_id,document_id:Some(authority.document_id)})}
 else if view.kind=="graph"{Ok(HandoffIdentity{source_id:crate::workspace_graph::graph_source_id(&scope.current_target_identity().map_err(crate::knowledge_error)?)?,vault_id:view.library_id.clone(),document_id:None})}
 else{Err("workspace-view-not-supported".into())}
}
fn data_check(registry:&WorkspaceWindows,label:&str,view:&ViewGrant,scope:&crate::knowledge::KnowledgeService,revision:&str,source_id:&str)->Result<(),String>{
 require_live_view(registry,label,view)?;scope.workspace_recovery_record().map_err(crate::knowledge_error)?;
 if identity(view,scope)?.source_id!=source_id{return Err("workspace-handoff-source-changed".into());}
 if view.kind=="note"{if scope.read_document(&note_ref(view)?).map_err(crate::knowledge_error)?.revision!=revision{return Err("workspace-handoff-revision-changed".into());}}
 else{let catalog=captured_catalog(registry,label,&view.id)?;let resolver=CapturedCatalogResolver::capture(&catalog)?;crate::workspace_graph::WorkspaceGraphs::check_revision(scope,revision,|target|resolver.resolve(target))?;}
 if label!="main"&&registry.session(label)?.view(Some(&view.id))?.dirty{return Err("workspace-source-not-saved".into());}
 if label=="main"&&registry.main_dirty.lock().map_err(|_|"workspace-lock")?.get(&view.id).copied().unwrap_or(false){return Err("workspace-source-not-saved".into());}
 Ok(())
}
pub(super) fn validate_offer(registry:&WorkspaceWindows,offer:&HandoffOffer,require_target_ready:bool)->Result<(),String>{
 let (source,scope)=scoped_view(registry,&offer.source_window,Some(&offer.source_view.id))?;
 if source!=offer.source_view||identity(&source,&scope)?!=offer.proof.identity{return Err("workspace-handoff-source-changed".into());}
 data_check(registry,&offer.source_window,&source,&scope,&offer.proof.revision,&offer.proof.identity.source_id)?;
 let (target,target_scope)=scoped_view(registry,&offer.target_window,Some(&offer.target_view_id))?;
 if target.kind!=source.kind||target.library_id!=source.library_id||target.resource_id!=source.resource_id||identity(&target,&target_scope)?!=offer.proof.identity{return Err("workspace-handoff-target-changed".into());}
 data_check(registry,&offer.target_window,&target,&target_scope,&offer.proof.revision,&offer.proof.identity.source_id)?;
 if registry.admission_owners.lock().map_err(|_|"workspace-lock")?.get(&format!("{}/{}",offer.target_window,offer.target_view_id))!=Some(&offer.id){return Err("workspace-handoff-admission-changed".into());}
 if require_target_ready&&offer.target_window=="main"{if registry.main_ready.lock().map_err(|_|"workspace-lock")?.get(&offer.target_view_id)!=Some(&(offer.proof.revision.clone(),offer.proof.identity.source_id.clone())){return Err("workspace-handoff-target-not-rendered".into());}}
 if require_target_ready&&offer.target_window!="main"{let target=registry.session(&offer.target_window)?.view(Some(&offer.target_view_id))?;if !target.ready||target.rendered_revision.as_deref()!=Some(&offer.proof.revision){return Err("workspace-handoff-target-not-rendered".into());}}
 Ok(())
}
fn require_services(registry:&WorkspaceWindows,kind:&str)->Result<(),String>{
 if kind=="note"{let live=registry.note_queue.capabilities()?;for required in ["suggestAi","writeAi","pickAttachment","pickCatalog","importDocument","exportDocument","renameTag","manageKnowledge","composeAi","openTag"]{if !live.kinds.iter().any(|kind|kind==required){return Err("workspace-note-main-service-unavailable".into());}}}
 else{let live=registry.graph_actions.available()?;for required in [GraphMainKind::OpenDocument,GraphMainKind::OpenTag,GraphMainKind::CreateMissing,GraphMainKind::ComposeAi,GraphMainKind::FileOperation,GraphMainKind::OpenCatalogAsset,GraphMainKind::Screenshot]{if !live.contains(&required){return Err("workspace-graph-main-service-unavailable".into());}}}Ok(())
}
fn main_target(expected:&crate::knowledge::KnowledgeTargetIdentity)->Result<(),String>{if &crate::knowledge_service()?.current_target_identity().map_err(crate::knowledge_error)?!=expected{return Err("workspace-main-source-changed".into());}Ok(())}

fn prepare_cancel(registry:&WorkspaceWindows,offer:&HandoffOffer)->Result<(),String>{
 let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
 if registry.admission_owners.lock().map_err(|_|"workspace-lock")?.get(&format!("{}/{}",offer.target_window,offer.target_view_id))!=Some(&offer.id){return Ok(());}
 if offer.target_window=="main"{if registry.main_dirty.lock().map_err(|_|"workspace-lock")?.get(&offer.target_view_id).copied().unwrap_or(false){return Err("workspace-handoff-target-has-input".into());}}
 else{let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;if let Some(session)=entries.get_mut(&offer.target_window){if let Some(target)=session.views.iter_mut().find(|entry|entry.view.id==offer.target_view_id){if target.dirty{return Err("workspace-handoff-target-has-input".into());}target.open=false;target.ready=false;}session.reconcile();}}
 Ok(())
}
pub(super) fn retire_target(registry:&WorkspaceWindows,label:&str,id:&str,admission:Option<&str>)->Result<bool,String>{
 let key=format!("{label}/{id}");
 {let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
  registry.registration_available(label,id)?;
  if admission.is_some_and(|expected|registry.admission_owners.lock().map(|owners|owners.get(&key).map(String::as_str)!=Some(expected)).unwrap_or(true)){return Ok(false);}
  if label=="main"{
   if admission.is_none()&&!registry.main_views.lock().map_err(|_|"workspace-lock")?.contains_key(id){return Ok(false);}
   if registry.main_dirty.lock().map_err(|_|"workspace-lock")?.get(id).copied().unwrap_or(false){return Err("workspace-document-has-unsaved-input".into());}
   registry.main_views.lock().map_err(|_|"workspace-lock")?.remove(id);registry.main_dirty.lock().map_err(|_|"workspace-lock")?.remove(id);registry.main_ready.lock().map_err(|_|"workspace-lock")?.remove(id);
  }else{
   let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;
   if let Some(session)=entries.get_mut(label){
    if let Some(index)=session.views.iter().position(|entry|entry.view.id==id&&admission.is_none_or(|expected|entry.admission_id.as_deref()==Some(expected))){
     if session.views[index].dirty{return Err("workspace-handoff-target-has-input".into());}session.views.remove(index);session.reconcile();
    }
    if admission.is_some_and(|expected|session.handoff_id.as_deref()==Some(expected))&&session.views.is_empty(){session.closing=true;}
   }
  }
  registry.retiring_views.lock().map_err(|_|"workspace-lock")?.insert(key.clone());
  registry.admission_owners.lock().map_err(|_|"workspace-lock")?.remove(&key);
  registry.knowledge.lock().map_err(|_|"workspace-lock")?.remove(&key);registry.graph_catalogs.lock().map_err(|_|"workspace-lock")?.remove(&key);
 }
 // An equal-ID replacement cannot bind until all old transient routes retire.
 registry.attachments.remove_view(label,id);registry.notes_metadata.remove_view(label,id);registry.graphs.remove_view(label,id);registry.actions.remove_view(label,id);registry.note_queue.remove_view(label,id);registry.note_actions.remove_view(label,id);registry.graph_actions.remove_view(label,id);
 registry.retiring_views.lock().map_err(|_|"workspace-lock")?.remove(&key);Ok(true)
}
fn cleanup_cancel(app:&tauri::AppHandle,registry:&WorkspaceWindows,offer:&HandoffOffer)->Result<(),String>{
 retire_target(registry,&offer.target_window,&offer.target_view_id,Some(&offer.id))?;
 if offer.target_window!="main"{
  if let Ok(session)=registry.session(&offer.target_window){if session.handoff_id.as_deref()==Some(&offer.id)&&session.closing&&session.views.is_empty(){
   destroy_registered_window(app,registry,&offer.target_window,&session.incarnation,false)?;
  }}
 }
 let _=app.emit_to(&offer.target_window,"luckyray:workspace-views-changed",());let _=app.emit_to(&offer.target_window,"luckyray:workspace-handoff-cancelled",json!({"id":offer.id}));
 registry.handoffs.settle_unobserved_target(&offer.id)?;
 Ok(())
}

pub(super) async fn dispatch(app:&tauri::AppHandle,caller:&tauri::Webview,registry:&WorkspaceWindows,request:HostRequest)->Result<Value,String>{
 let label=caller.label();
 match request {
 HostRequest::BindScoped{view,material_library_id}=>{
  if label!="main"{return Err("workspace-main-required".into());}registry.accepting_views()?;
  let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
  registry.registration_available(label,&view.id)?;
  let scope=if let Ok((bound,scope))=scoped_view(registry,label,Some(&view.id)){if bound!=view{return Err("workspace-view-identity-changed".into());}scope}else{crate::knowledge_service()?.capture_workspace_scope(&view.library_id).map_err(crate::knowledge_error)?};
  validate_grant(&view,Some(&scope))?;
  if view.kind=="graph"{let root=crate::backend_services()?.material_catalog();let catalog=match &material_library_id{Some(id)=>root.for_library(id).map_err(crate::encode_material_catalog_command_error)?,None=>{let id=root.library_scope_key().map_err(crate::encode_material_catalog_command_error)?;root.for_library(&id).map_err(crate::encode_material_catalog_command_error)?}};registry.graph_catalogs.lock().map_err(|_|"workspace-lock")?.insert(format!("main/{}",view.id),catalog);}
  else{registry.attachments.outgoing_baseline("main",&view,&scope)?;}
  {let mut views=registry.main_views.lock().map_err(|_|"workspace-lock")?;if views.len()>=100&&!views.contains_key(&view.id){return Err("workspace-view-limit".into());}views.insert(view.id.clone(),view.clone());}
  registry.knowledge.lock().map_err(|_|"workspace-lock")?.insert(format!("main/{}",view.id),scope.clone());
  let registration=serde_json::to_value(scope.workspace_recovery_record().map_err(crate::knowledge_error)?).map_err(|_|"workspace-serialize")?.get("registration").cloned().ok_or("workspace-source-unavailable")?;
  if view.kind=="note"{let note=crate::workspace_notes_metadata::snapshot_for(&scope,scope.read_document(&note_ref(&view)?).map_err(crate::knowledge_error)?)?;Ok(json!({"view":view,"registration":registration,"note":note}))}
  else{let snapshot=read_graph(registry,label,&view,&scope)?;let captured=captured_catalog(registry,label,&view.id)?.library_scope_key().map_err(crate::encode_material_catalog_command_error)?;let legacy=crate::backend_services()?.material_catalog().library_state().map_err(crate::encode_material_catalog_command_error)?.0;Ok(json!({"view":view,"registration":registration,"snapshot":snapshot,"materialLibraryId":captured,"requestedMaterialLibraryId":material_library_id,"legacyMaterialLibraryId":legacy}))}
 },
 HostRequest::MainBindingCoverage{ready,generation}=>{
  if label!="main"{return Err("workspace-main-required".into());}
  let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
  let mut coverage=registry.main_binding_coverage.lock().map_err(|_|"workspace-lock")?;
  update_main_coverage(&mut coverage,ready,generation)?;
  Ok(json!({"generation":coverage.0,"ready":coverage.1}))
 },
 HostRequest::ReleaseScoped{view_id}=>{
  if label!="main"{return Err("workspace-main-required".into());}
  if main_view(registry,label,&view_id).is_err(){return Ok(Value::Null);}
  if registry.handoffs.blocks_close(label)||registry.note_queue.has_pending_window(label)?||registry.graph_actions.has_pending_window(label)?{return Err("workspace-operation-in-progress".into());}
  if registry.main_dirty.lock().map_err(|_|"workspace-lock")?.get(&view_id).copied().unwrap_or(false){return Err("workspace-document-has-unsaved-input".into());}
  retire_target(registry,label,&view_id,None)?;Ok(Value::Null)
 },
 HostRequest::BoundDirty{view_id,dirty}=>{let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;if label!="main"{return Err("workspace-main-required".into());}main_view(registry,label,&view_id)?;if dirty{registry.main_ready.lock().map_err(|_|"workspace-lock")?.remove(&view_id);}registry.main_dirty.lock().map_err(|_|"workspace-lock")?.insert(view_id,dirty);Ok(Value::Null)},
 HostRequest::BeginHandoff{request_id,view_id,revision,source_id,presentation,move_source,target_label}=>{
  registry.accepting_views()?;let(view,scope)=scoped_view(registry,label,Some(&view_id))?;require_services(registry,&view.kind)?;
  let previous=registry.handoffs.find_request(label,&request_id)?;
  if let Some(previous)=&previous{if previous.proof.identity.source_id!=source_id||target_label.as_ref().is_some_and(|target|target!=&previous.target_window){return Err("workspace-handoff-request-mismatch".into());}return value(registry.handoffs.begin(&request_id,label,&previous.target_window,&view,&previous.target_view_id,identity(&view,&scope)?,&revision,presentation,move_source)?);}
  data_check(registry,label,&view,&scope,&revision,&source_id)?;
  let target=target_label.unwrap_or_else(||format!("workspace-{:032x}",rand::random::<u128>()));if target==label{return Err("workspace-handoff-same-window".into());}
  let existing=target=="main"||registry.session(&target).is_ok();if target!="main"&&existing&&registry.handoffs.blocks_close(&target){return Err("workspace-handoff-target-busy".into());}
  let mut target_view=view.clone();target_view.id=if target=="main"&&view.kind=="graph"{format!("graph-native-{:032x}",rand::random::<u128>())}else if target=="main"{format!("notes-view-native-{:032x}",rand::random::<u128>())}else{format!("native-view-{:032x}",rand::random::<u128>())};
  let offer=registry.handoffs.begin(&request_id,label,&target,&view,&target_view.id,identity(&view,&scope)?,&revision,presentation,move_source)?;
  let prepared=registry.handoffs.prepare(label,&offer.id,|_|{
   let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
   registry.accepting_views()?;registry.registration_available(&target,&target_view.id)?;data_check(registry,label,&view,&scope,&revision,&source_id)?;
   if existing&&target!="main"{let session=registry.session(&target)?;if !session.integrated||session.closing||session.views.len()>=100{return Err("workspace-handoff-target-unavailable".into());}}
   registry.admission_owners.lock().map_err(|_|"workspace-lock")?.insert(format!("{target}/{}",target_view.id),offer.id.clone());
   if view.kind=="note"{let baseline=registry.attachments.outgoing_baseline(label,&view,&scope)?.for_view(&target_view)?;registry.attachments.register_baseline(&target,baseline)?;}
   if view.kind=="graph"{let catalog=captured_catalog(registry,label,&view.id)?;registry.graph_catalogs.lock().map_err(|_|"workspace-lock")?.insert(format!("{target}/{}",target_view.id),catalog);}
   registry.knowledge.lock().map_err(|_|"workspace-lock")?.insert(format!("{target}/{}",target_view.id),scope.clone());
   if target=="main"{registry.main_views.lock().map_err(|_|"workspace-lock")?.insert(target_view.id.clone(),target_view.clone());let _=app.emit_to("main","luckyray:workspace-handoff-available",json!({"id":offer.id}));crate::show_main_window(app);}
   else if existing{let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;let session=entries.get_mut(&target).ok_or("workspace-unregistered-window")?;if !session.integrated{return Err("workspace-handoff-legacy-target".into());}let mut incoming=WindowView::new(target_view.clone());incoming.transfer_pending=true;incoming.admission_id=Some(offer.id.clone());session.views.push(incoming);session.reconcile();drop(entries);let _=app.emit_to(&target,"luckyray:workspace-views-changed",json!({"viewId":target_view.id}));let _=app.emit_to(&target,"luckyray:workspace-handoff-available",json!({"id":offer.id}));}
   else{let mut session=WindowSession::new(target.clone(),target_view);session.integrated=true;session.handoff_id=Some(offer.id.clone());session.views[0].transfer_pending=true;session.views[0].admission_id=Some(offer.id.clone());registry.insert(session)?;}
   drop(_writes);
   if !existing{build_window(app,registry.session(&target)?)?;}
   Ok::<(),String>(())
  });
  if let Err(error)=prepared{let cancelled=registry.handoffs.cancel(label,&offer.id,|_|Ok(()))?;cleanup_cancel(app,registry,&cancelled)?;return Err(error);}
  value(offer)
 },
 HostRequest::HandoffPending {}=>{if label!="main"{registry.session(label)?;}let offers=registry.handoffs.pending_for(label)?;for offer in &offers{if offer.phase==HandoffPhase::Cancelled{cleanup_cancel(app,registry,offer)?;}}value(offers)},
 HostRequest::HandoffRead{id}=>{let offer=registry.handoffs.get(label,&id)?;if offer.phase==HandoffPhase::Cancelled{cleanup_cancel(app,registry,&offer)?;}value(offer)},
 HostRequest::HandoffFind{request_id}=>{let offer=registry.handoffs.find_request(label,&request_id)?;if let Some(offer)=&offer{if offer.phase==HandoffPhase::Cancelled{cleanup_cancel(app,registry,offer)?;}}value(offer)},
 HostRequest::HandoffSettled{id}=>{registry.handoffs.settled(label,&id)?;Ok(Value::Null)},
 HostRequest::HandoffCancelRequest{request_id}=>{let offer=registry.handoffs.cancel_request(label,&request_id,|offer|prepare_cancel(registry,offer))?;if let Some(offer)=&offer{cleanup_cancel(app,registry,offer)?;}Ok(json!({"requestId":request_id,"cancelled":true,"offer":offer}))},
 HostRequest::HandoffApplied{id,target_view_id,revision,presentation_hash}=>{let offer=registry.handoffs.get(label,&id)?;require_services(registry,&offer.source_view.kind)?;value(registry.handoffs.applied(label,&id,&target_view_id,&revision,&presentation_hash,|offer|{let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;validate_offer(registry,offer,true)} )?)},
 HostRequest::HandoffCommit{id}=>{
  let offer=registry.handoffs.get(label,&id)?;require_services(registry,&offer.source_view.kind)?;
  let mut transitioned=false;
  let committed=registry.handoffs.commit(label,&id,|offer|{
   let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
   validate_offer(registry,offer,true)?;
   if offer.target_window!="main"{let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;let target=entries.get_mut(&offer.target_window).ok_or("workspace-unregistered-window")?;target.views.iter_mut().find(|entry|entry.view.id==offer.target_view_id&&entry.open).ok_or("workspace-view-closed")?.transfer_pending=false;}
   registry.admission_owners.lock().map_err(|_|"workspace-lock")?.remove(&format!("{}/{}",offer.target_window,offer.target_view_id));
   if offer.move_source&&offer.source_window=="main"{registry.main_views.lock().map_err(|_|"workspace-lock")?.remove(&offer.source_view.id);registry.main_dirty.lock().map_err(|_|"workspace-lock")?.remove(&offer.source_view.id);registry.main_ready.lock().map_err(|_|"workspace-lock")?.remove(&offer.source_view.id);}
   if offer.move_source&&offer.source_window!="main"{let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;let source=entries.get_mut(&offer.source_window).ok_or("workspace-unregistered-window")?;let entry=source.views.iter_mut().find(|entry|entry.view==offer.source_view&&entry.open&&!entry.dirty).ok_or("workspace-handoff-source-changed")?;entry.open=false;entry.ready=false;source.reconcile();}
   transitioned=true;Ok(())
  })?;
  if !transitioned{return value(committed);}
  if committed.move_source{registry.actions.remove_view(label,&committed.source_view.id);registry.note_queue.remove_view(label,&committed.source_view.id);registry.note_actions.remove_view(label,&committed.source_view.id);registry.graph_actions.remove_view(label,&committed.source_view.id);}
  if committed.target_window!="main"{registry.persist_window(&committed.target_window,false)?;}
  let _=app.emit_to(&committed.target_window,"luckyray:workspace-handoff-committed",json!({"id":id}));value(committed)
 },
 HostRequest::HandoffCancel{id}=>{let cancelled=registry.handoffs.cancel(label,&id,|offer|prepare_cancel(registry,offer))?;cleanup_cancel(app,registry,&cancelled)?;value(cancelled)},
 HostRequest::IntegratedNotReady{view_id}=>{
  let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;
  let(view,_)=scoped_view(registry,label,Some(&view_id))?;require_live_view(registry,label,&view)?;
  if label=="main"{registry.main_ready.lock().map_err(|_|"workspace-lock")?.remove(&view_id);}
  else{let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;let session=entries.get_mut(label).ok_or("workspace-unregistered-window")?;let target=session.views.iter_mut().find(|entry|entry.view==view).ok_or("workspace-view-closed")?;target.ready=false;target.rendered_revision=None;session.reconcile();}Ok(Value::Null)
 },
 HostRequest::IntegratedReady{view_id,revision,source_id,snapshot_id}=>{
  let(view,scope)=scoped_view(registry,label,Some(&view_id))?;require_services(registry,&view.kind)?;let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;data_check(registry,label,&view,&scope,&revision,&source_id)?;
  if view.kind=="graph"&&registry.graphs.rendered_revision(label,&view_id,snapshot_id.as_deref().ok_or("workspace-graph-proof-required")?)?!=revision{return Err("workspace-graph-proof-stale".into());}
  if label=="main"{registry.main_ready.lock().map_err(|_|"workspace-lock")?.insert(view_id,(revision,source_id));}
  else{let mut entries=registry.entries.lock().map_err(|_|"workspace-lock")?;let session=entries.get_mut(label).ok_or("workspace-unregistered-window")?;let target=session.views.iter_mut().find(|entry|entry.view==view&&entry.open).ok_or("workspace-view-closed")?;target.ready=true;target.rendered_revision=Some(revision);session.reconcile();}Ok(Value::Null)
 },
 HostRequest::GraphRead{view_id,refresh:_}=>{let(view,scope)=scoped_view(registry,label,Some(&view_id))?;require_live_view(registry,label,&view)?;if view.kind!="graph"{return Err("workspace-graph-view-required".into());}let result=read_graph(registry,label,&view,&scope)?;require_live_view(registry,label,&view)?;value(result)},
 HostRequest::GraphCapabilities{view_id}=>{let(view,_)=scoped_view(registry,label,Some(&view_id))?;require_live_view(registry,label,&view)?;let kinds=registry.graph_actions.available()?;Ok(json!({"kinds":kinds,"expiresInMs":5000}))},
 HostRequest::GraphMutateTag{view_id,snapshot_id,source_token,target_token,mode}=>{let(view,scope)=scoped_view(registry,label,Some(&view_id))?;require_live_view(registry,label,&view)?;let result=registry.graphs.mutate_tag(label,&view_id,&snapshot_id,&source_token,&target_token,mode,&scope,Some(|reference:&crate::knowledge::KnowledgeDocumentRef|{let guard=guard_document_writes(registry,&scope,std::slice::from_ref(reference))?;require_live_view(registry,label,&view)?;Ok::<_,String>(guard)}))?;let _=app.emit("luckyray:workspace-note-changed",());let _=app.emit("luckyray:workspace-graph-changed",());Ok(result)},
 HostRequest::GraphNodeAction{view_id,snapshot_id,source_id,node_token,request_id,action}=>{let(view,scope)=scoped_view(registry,label,Some(&view_id))?;require_live_view(registry,label,&view)?;let receipt=registry.graph_actions.enqueue_node(label,&view,&scope,&captured_catalog(registry,label,&view_id)?,&registry.graphs,&snapshot_id,&source_id,&node_token,request_id,action)?;let _=app.emit_to("main","luckyray:workspace-graph-action-available",());value(receipt)},
 HostRequest::GraphScreenshot{view_id,snapshot_id,source_id,revision,request_id,bytes}=>{let(view,scope)=scoped_view(registry,label,Some(&view_id))?;require_live_view(registry,label,&view)?;let receipt=registry.graph_actions.enqueue_screenshot(label,&view,&scope,&captured_catalog(registry,label,&view_id)?,&registry.graphs,&snapshot_id,&source_id,&revision,request_id,bytes)?;let _=app.emit_to("main","luckyray:workspace-graph-action-available",());value(receipt)},
 HostRequest::GraphActionStatus{view_id,id,request_id,revision,generation}=>{let(view,_)=scoped_view(registry,label,Some(&view_id))?;registry.graph_actions.status(label,&view,&id,&ActionCorrelation{request_id,revision,generation},&registry.graphs,|owner,view,correlation|live_action(registry,owner,view,correlation))},
 HostRequest::GraphMainRegister{kinds}=>value(registry.graph_actions.register(label,kinds)?),
 HostRequest::GraphMainPending{lease_token}=>value(registry.graph_actions.pending(label,&lease_token)?),
 HostRequest::GraphMainClaim{id,lease_token}=>{let claim=registry.graph_actions.claim(label,&lease_token,&id,&registry.graphs,|owner,view,correlation|live_action(registry,owner,view,correlation))?;if let Err(error)=registry.graph_actions.validate_main_target(label,&lease_token,&id,&claim.claim_token,main_target){let _=registry.graph_actions.complete(label,&lease_token,&id,&claim.claim_token,GraphCompletion::Failed{code:"workspace-main-source-changed".into()},&registry.graphs,|owner,view,correlation|live_action(registry,owner,view,correlation));return Err(error);}value(claim)},
 HostRequest::GraphMainValidate{id,claim_token,lease_token}=>{registry.graph_actions.validate_main_target(label,&lease_token,&id,&claim_token,main_target)?;value(registry.graph_actions.validate_claim(label,&lease_token,&id,&claim_token,&registry.graphs,|owner,view,correlation|live_action(registry,owner,view,correlation))?)},
 HostRequest::GraphMainComplete{id,claim_token,lease_token,result}=>{if !matches!(&result,GraphCompletion::Failed{..}|GraphCompletion::Cancelled {}){registry.graph_actions.validate_main_target(label,&lease_token,&id,&claim_token,main_target)?;}registry.graph_actions.complete(label,&lease_token,&id,&claim_token,result,&registry.graphs,|owner,view,correlation|live_action(registry,owner,view,correlation))?;Ok(Value::Null)},
 HostRequest::GraphMainExecute{id,claim_token,lease_token,input}=>{
  if label!="main"{return Err("workspace-main-required".into());}let app=app.clone();let owner=label.to_string();
  tauri::async_runtime::spawn_blocking(move||{let registry=app.state::<WorkspaceWindows>();registry.graph_actions.execute(&owner,&lease_token,&id,&claim_token,input,&app,&registry.graphs,|owner,view,correlation|live_action(&registry,owner,view,correlation),|origin,source,scope,reference,title|{let _writes=registry.write_gate.lock().map_err(|_|"workspace-lock")?;require_live_view(&registry,origin,source)?;Ok(crate::workspace_actions::BoundDocument::OriginWindow{view_id:attach_scoped_note(&app,&registry,origin,scope,reference,title)?.id})},|scope,references|guard_document_writes(&registry,scope,references))}).await.map_err(|_|"workspace-graph-worker-failed")?
 },
 }
}
