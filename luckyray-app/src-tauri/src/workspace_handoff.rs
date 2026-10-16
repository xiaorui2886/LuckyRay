//! Ephemeral, caller-bound two-phase view-state handoff. No state is a grant:
//! callers/targets and document/graph revisions are validated by the dispatcher.
//! Presentation JSON is bounded, hashed and never written to layout/recovery.
use crate::workspace_windows::ViewGrant;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
const TTL: Duration = Duration::from_secs(90);
const MAX_RECEIPTS: usize = 128;
const MAX_PENDING: usize = 24;
const MAX_PRESENTATION_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct HandoffIdentity {
 pub source_id:String,pub vault_id:String,pub document_id:Option<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub(crate) struct HandoffProof {
 pub kind:String,pub revision:String,pub identity:HandoffIdentity,pub presentation_hash:String,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub(crate) enum HandoffPhase { Pending, Applied, Committed, Cancelled }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct HandoffOffer {
 pub id:String,pub source_window:String,pub target_window:String,pub source_view:ViewGrant,
 pub target_view_id:String,pub proof:HandoffProof,pub phase:HandoffPhase,
 pub presentation:Option<Value>,pub move_source:bool,
}
#[derive(Clone)]
struct Entry { offer:HandoffOffer,expires:Instant,source_settled:bool,target_settled:bool,prepared:bool,target_observed:bool }
#[derive(Default)]
pub(crate) struct WorkspaceHandoffs { entries:Mutex<HashMap<String,Entry>>, requests:Mutex<HashMap<(String,String),Option<String>>> }
fn valid_string(value:&str,max:usize)->bool{!value.is_empty()&&value.len()<=max&&!value.chars().any(char::is_control)}
fn owner(offer:&HandoffOffer,caller:&str)->bool{caller==offer.source_window||caller==offer.target_window}
fn digest(value:&Value)->Result<String,String>{
 let bytes=serde_json::to_vec(value).map_err(|_|"workspace-handoff-invalid-state")?;
 if bytes.len()>MAX_PRESENTATION_BYTES||!value.is_object(){return Err("workspace-handoff-state-limit".into());}
 Ok(format!("{:x}",Sha256::digest(&bytes)))
}
impl WorkspaceHandoffs {
 fn expire(entries:&mut HashMap<String,Entry>){
  let now=Instant::now();
  for entry in entries.values_mut(){if entry.expires<=now&&matches!(entry.offer.phase,HandoffPhase::Pending|HandoffPhase::Applied){entry.offer.phase=HandoffPhase::Cancelled;entry.offer.presentation=None;}}
  // Terminal decisions survive outages until both actual participants have
  // reconciled their local surfaces. Capacity failure is safer than forgetting.
  entries.retain(|_,entry|!(entry.source_settled&&entry.target_settled));
 }
 pub(crate) fn settled(&self,caller:&str,id:&str)->Result<(),String>{
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;Self::expire(&mut entries);
  let Some(entry)=entries.get_mut(id) else{return Ok(());};
  if !owner(&entry.offer,caller){return Err("workspace-handoff-scope-mismatch".into());}
  if !matches!(entry.offer.phase,HandoffPhase::Committed|HandoffPhase::Cancelled){return Err("workspace-handoff-not-terminal".into());}
  if caller==entry.offer.source_window{entry.source_settled=true;}else{entry.target_settled=true;}
  Self::expire(&mut entries);Ok(())
 }

 pub(crate) fn begin(&self,request_id:&str,source:&str,target:&str,view:&ViewGrant,target_view_id:&str,identity:HandoffIdentity,revision:&str,presentation:Value,move_source:bool)->Result<HandoffOffer,String>{
  if !valid_string(source,128)||!valid_string(target,128)||source==target||!valid_string(target_view_id,128)||!valid_string(revision,256)
   ||!valid_string(&identity.source_id,256)||identity.vault_id!=view.library_id||!matches!(view.kind.as_str(),"note"|"graph")
   ||(view.kind=="note"&&identity.document_id.as_ref().is_none_or(|id|!valid_string(id,16384))){return Err("workspace-handoff-invalid-binding".into());}
  let presentation_hash=digest(&presentation)?;
  if !(32..=64).contains(&request_id.len())||!request_id.bytes().all(|ch|ch.is_ascii_hexdigit()){return Err("workspace-handoff-invalid-request".into());}
  let mut requests=self.requests.lock().map_err(|_|"workspace-handoff-lock")?;
  let key=(source.to_owned(),request_id.to_owned());
  if let Some(existing)=requests.get(&key){
   let id=existing.as_ref().ok_or("workspace-handoff-request-cancelled")?;
   let offer=self.get(source,id)?;
   if offer.source_view!=*view||offer.target_window!=target||offer.target_view_id!=target_view_id||offer.proof.identity!=identity||offer.proof.revision!=revision||offer.proof.presentation_hash!=presentation_hash||offer.move_source!=move_source{return Err("workspace-handoff-request-mismatch".into());}
   return Ok(offer);
  }
  if requests.len()>=4096{return Err("workspace-handoff-request-capacity".into());}
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;
  let now=Instant::now();Self::expire(&mut entries);
  if entries.len()>=MAX_RECEIPTS||entries.values().filter(|entry|matches!(entry.offer.phase,HandoffPhase::Pending|HandoffPhase::Applied)).count()>=MAX_PENDING||entries.values().any(|entry|matches!(entry.offer.phase,HandoffPhase::Pending|HandoffPhase::Applied)&&(owner(&entry.offer,source)||owner(&entry.offer,target))){return Err("workspace-handoff-busy".into());}
  let id=format!("{:032x}",rand::random::<u128>());
  let offer=HandoffOffer{id:id.clone(),source_window:source.into(),target_window:target.into(),source_view:view.clone(),target_view_id:target_view_id.into(),proof:HandoffProof{kind:view.kind.clone(),revision:revision.into(),identity,presentation_hash},phase:HandoffPhase::Pending,presentation:Some(presentation),move_source};
  requests.insert(key,Some(id.clone()));entries.insert(id,Entry{offer:offer.clone(),expires:now+TTL,source_settled:false,target_settled:false,prepared:false,target_observed:false});Ok(offer)
 }
 pub(crate) fn prepare<T>(&self,caller:&str,id:&str,prepare:impl FnOnce(&HandoffOffer)->Result<T,String>)->Result<T,String>{
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;Self::expire(&mut entries);
  let entry=entries.get(id).filter(|entry|entry.offer.source_window==caller&&entry.offer.phase==HandoffPhase::Pending).ok_or("workspace-handoff-admission-cancelled")?;
  // Keep admission and cancellation serialized until native target registration
  // and window creation finish. The callback must not reenter this store.
  let result=prepare(&entry.offer)?;
  entries.get_mut(id).ok_or("workspace-handoff-unavailable")?.prepared=true;
  Ok(result)
 }
 pub(crate) fn find_request(&self,caller:&str,request_id:&str)->Result<Option<HandoffOffer>,String>{
  if !(32..=64).contains(&request_id.len())||!request_id.bytes().all(|ch|ch.is_ascii_hexdigit()){return Err("workspace-handoff-invalid-request".into());}
  let requests=self.requests.lock().map_err(|_|"workspace-handoff-lock")?;
  match requests.get(&(caller.to_owned(),request_id.to_owned())){Some(Some(id))=>self.get(caller,id).map(Some),_=>Ok(None)}
 }
 pub(crate) fn cancel_request(&self,caller:&str,request_id:&str,check:impl FnOnce(&HandoffOffer)->Result<(),String>)->Result<Option<HandoffOffer>,String>{
  if !(32..=64).contains(&request_id.len())||!request_id.bytes().all(|ch|ch.is_ascii_hexdigit()){return Err("workspace-handoff-invalid-request".into());}
  let mut requests=self.requests.lock().map_err(|_|"workspace-handoff-lock")?;
  let key=(caller.to_owned(),request_id.to_owned());
  match requests.get(&key){
   Some(Some(id))=>self.cancel(caller,id,check).map(Some),
   Some(None)=>Ok(None),
   None=>{if requests.len()<4096{requests.insert(key,None);}/* A permanently full request map also fences every unknown request. */Ok(None)},
  }
 }
 pub(crate) fn get(&self,caller:&str,id:&str)->Result<HandoffOffer,String>{
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;Self::expire(&mut entries);
  let entry=entries.get_mut(id).filter(|entry|owner(&entry.offer,caller)).ok_or("workspace-handoff-unavailable")?;
  if caller==entry.offer.target_window&&matches!(entry.offer.phase,HandoffPhase::Pending|HandoffPhase::Applied){if !entry.prepared{return Err("workspace-handoff-target-not-prepared".into());}entry.target_observed=true;}
  let mut offer=entry.offer.clone();if offer.phase!=HandoffPhase::Pending {offer.presentation=None;}Ok(offer)
 }
 pub(crate) fn pending_for(&self,caller:&str)->Result<Vec<HandoffOffer>,String>{
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;Self::expire(&mut entries);
  let mut offers=Vec::new();
  for entry in entries.values_mut(){
   if entry.offer.target_window!=caller||entry.target_settled{continue;}
   if entry.offer.phase==HandoffPhase::Cancelled{offers.push(entry.offer.clone());}
   else if entry.prepared&&matches!(entry.offer.phase,HandoffPhase::Pending|HandoffPhase::Applied){entry.target_observed=true;offers.push(entry.offer.clone());}
  }
  Ok(offers)
 }
 pub(crate) fn settle_unobserved_target(&self,id:&str)->Result<(),String>{
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;
  if let Some(entry)=entries.get_mut(id){if entry.offer.phase==HandoffPhase::Cancelled&&!entry.target_observed{entry.target_settled=true;}}
  Self::expire(&mut entries);Ok(())
 }
 /// The target may ACK only its precise restored presentation/revision. The
 /// dispatcher validates both live scopes and the target's actual rendered state
 /// in `validate`, without recursively entering this handoff registry.
 pub(crate) fn applied(&self,caller:&str,id:&str,target_view_id:&str,revision:&str,presentation_hash:&str,validate:impl FnOnce(&HandoffOffer)->Result<(),String>)->Result<HandoffOffer,String>{
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;
  Self::expire(&mut entries);let entry=entries.get_mut(id).ok_or("workspace-handoff-unavailable")?;
  let offer=&mut entry.offer;
  if caller!=offer.target_window||target_view_id!=offer.target_view_id||revision!=offer.proof.revision||presentation_hash!=offer.proof.presentation_hash||!matches!(offer.phase,HandoffPhase::Pending|HandoffPhase::Applied){return Err("workspace-handoff-target-proof-mismatch".into());}
  validate(offer)?;offer.phase=HandoffPhase::Applied;entry.target_observed=true;Ok(offer.clone())
 }
 /// This closure is the atomic native source/target check and source-grant
 /// retirement. Frontend parks its surface until this committed receipt exists.
 pub(crate) fn commit(&self,caller:&str,id:&str,commit:impl FnOnce(&HandoffOffer)->Result<(),String>)->Result<HandoffOffer,String>{
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;
  Self::expire(&mut entries);let entry=entries.get_mut(id).ok_or("workspace-handoff-unavailable")?;
  if caller!=entry.offer.source_window{return Err("workspace-handoff-source-required".into());}
  if entry.offer.phase==HandoffPhase::Committed{return Ok(entry.offer.clone());}
  if entry.offer.phase!=HandoffPhase::Applied{return Err("workspace-handoff-target-not-applied".into());}
  commit(&entry.offer)?;entry.offer.phase=HandoffPhase::Committed;entry.offer.presentation=None;Ok(entry.offer.clone())
 }
 pub(crate) fn cancel(&self,caller:&str,id:&str,close_target:impl FnOnce(&HandoffOffer)->Result<(),String>)->Result<HandoffOffer,String>{
  let mut entries=self.entries.lock().map_err(|_|"workspace-handoff-lock")?;
  let entry=entries.get_mut(id).ok_or("workspace-handoff-unavailable")?;
  if caller!=entry.offer.source_window{return Err("workspace-handoff-source-required".into());}
  if entry.offer.phase==HandoffPhase::Committed{return Err("workspace-handoff-already-committed".into());}
  if entry.offer.phase==HandoffPhase::Cancelled{return Ok(entry.offer.clone());}
  close_target(&entry.offer)?;entry.offer.phase=HandoffPhase::Cancelled;entry.offer.presentation=None;Ok(entry.offer.clone())
 }
 pub(crate) fn blocks_close(&self,caller:&str)->bool{
  self.entries.lock().map(|mut entries|{Self::expire(&mut entries);entries.values().any(|entry|owner(&entry.offer,caller)&&matches!(entry.offer.phase,HandoffPhase::Pending|HandoffPhase::Applied))}).unwrap_or(true)
 }
 /// A destroyed target makes pending offers fail instead of acknowledging them.
 /// Committed tombstones remain available to resolve an uncertain source reply.
 pub(crate) fn remove_window(&self,label:&str){if let Ok(mut entries)=self.entries.lock(){for entry in entries.values_mut(){if owner(&entry.offer,label){if entry.offer.phase!=HandoffPhase::Committed {entry.offer.phase=HandoffPhase::Cancelled;entry.offer.presentation=None;}if label==entry.offer.source_window{entry.source_settled=true;}else{entry.target_settled=true;}}}Self::expire(&mut entries);}}
}
#[cfg(test)] mod tests {
 use super::*;use serde_json::json;
 fn view()->ViewGrant{ViewGrant{id:"view-a".into(),kind:"note".into(),library_id:"vault-a".into(),resource_id:Some("A.md".into()),title:"A".into()}}
 fn offer(store:&WorkspaceHandoffs)->HandoffOffer{let offer=store.begin("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","main","workspace-target",&view(),"view-a",HandoffIdentity{source_id:"source-a".into(),vault_id:"vault-a".into(),document_id:Some("doc-a".into())},"r1",json!({"version":1,"selection":[1,2]}),true).unwrap();store.prepare("main",&offer.id,|_|Ok(())).unwrap();offer}
 #[test]fn workspace_handoff_rejects_wrong_caller_revision_state_and_unapplied_commit(){let s=WorkspaceHandoffs::default();let o=offer(&s);assert!(s.get("workspace-other",&o.id).is_err());assert!(s.commit("main",&o.id,|_|Ok(())).is_err());for (caller,revision,hash) in [("main","r1",o.proof.presentation_hash.as_str()),("workspace-target","r0",o.proof.presentation_hash.as_str()),("workspace-target","r1","forged")]{assert!(s.applied(caller,&o.id,"view-a",revision,hash,|_|Ok(())).is_err());}}
 #[test]fn workspace_handoff_commit_is_once_and_cannot_be_cancelled_after_success(){let s=WorkspaceHandoffs::default();let o=offer(&s);s.applied("workspace-target",&o.id,"view-a","r1",&o.proof.presentation_hash,|_|Ok(())).unwrap();assert!(s.commit("workspace-target",&o.id,|_|Ok(())).is_err());let done=s.commit("main",&o.id,|_|Ok(())).unwrap();assert_eq!(done.phase,HandoffPhase::Committed);assert!(done.presentation.is_none());s.commit("main",&o.id,|_|panic!("must not commit twice")).unwrap();assert!(s.cancel("main",&o.id,|_|Ok(())).is_err());}
 #[test]fn workspace_handoff_failed_live_checks_keep_source_recoverable(){let s=WorkspaceHandoffs::default();let o=offer(&s);assert!(s.applied("workspace-target",&o.id,"view-a","r1",&o.proof.presentation_hash,|_|Err("target-gone".into())).is_err());assert_eq!(s.get("main",&o.id).unwrap().phase,HandoffPhase::Pending);s.cancel("main",&o.id,|_|Ok(())).unwrap();assert!(!s.blocks_close("main"));}
 #[test]fn workspace_handoff_state_bound_and_duplicate_source_rejected(){let s=WorkspaceHandoffs::default();let o=offer(&s);assert!(s.begin("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","main","workspace-other",&view(),"view-a",o.proof.identity.clone(),"r1",json!({"v":1}),true).is_err());assert!(WorkspaceHandoffs::default().begin("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","main","workspace-target",&view(),"view-a",o.proof.identity,"r1",json!({"large":"x".repeat(MAX_PRESENTATION_BYTES)}),true).is_err());}
 #[test]fn workspace_handoff_target_death_never_becomes_success(){let s=WorkspaceHandoffs::default();let o=offer(&s);s.remove_window("workspace-target");assert_eq!(s.get("main",&o.id).unwrap().phase,HandoffPhase::Cancelled);assert!(s.commit("main",&o.id,|_|Ok(())).is_err());}
 #[test]fn workspace_handoff_expiry_is_an_explicit_recoverable_cancel(){let s=WorkspaceHandoffs::default();let o=offer(&s);s.entries.lock().unwrap().get_mut(&o.id).unwrap().expires=Instant::now()-Duration::from_secs(1);assert_eq!(s.get("main",&o.id).unwrap().phase,HandoffPhase::Cancelled);assert!(!s.blocks_close("main"));s.settled("main",&o.id).unwrap();assert_eq!(s.get("workspace-target",&o.id).unwrap().phase,HandoffPhase::Cancelled);s.settled("workspace-target",&o.id).unwrap();assert!(s.get("main",&o.id).is_err());}
 #[test]fn workspace_handoff_terminal_receipt_does_not_expire_before_reconciliation(){let s=WorkspaceHandoffs::default();let o=offer(&s);s.applied("workspace-target",&o.id,"view-a","r1",&o.proof.presentation_hash,|_|Ok(())).unwrap();s.commit("main",&o.id,|_|Ok(())).unwrap();s.entries.lock().unwrap().get_mut(&o.id).unwrap().expires=Instant::now()-Duration::from_secs(6000);assert_eq!(s.get("main",&o.id).unwrap().phase,HandoffPhase::Committed);assert!(s.settled("foreign",&o.id).is_err());}

 #[test]fn workspace_handoff_cancel_request_fences_late_initial_admission(){let s=WorkspaceHandoffs::default();let request="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";assert!(s.cancel_request("main",request,|_|Ok(())).unwrap().is_none());assert!(s.begin(request,"main","workspace-target",&view(),"view-a",HandoffIdentity{source_id:"source-a".into(),vault_id:"vault-a".into(),document_id:Some("doc-a".into())},"r1",json!({"x":1}),true).is_err());}
 #[test]fn workspace_handoff_lost_begin_can_find_and_cancel_exact_attempt(){let s=WorkspaceHandoffs::default();let o=offer(&s);assert_eq!(s.find_request("main","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap().unwrap().id,o.id);assert!(s.find_request("foreign","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap().is_none());assert_eq!(s.cancel_request("main","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",|_|Ok(())).unwrap().unwrap().phase,HandoffPhase::Cancelled);}

 #[test]fn workspace_handoff_same_target_is_serialized_and_cancel_prevents_prepare(){let s=WorkspaceHandoffs::default();let o=offer(&s);let mut second=view();second.id="view-b".into();assert!(s.begin("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","workspace-other","workspace-target",&second,"view-b",o.proof.identity.clone(),"r1",json!({"a":1}),true).is_err());s.cancel("main",&o.id,|_|Ok(())).unwrap();assert!(s.prepare::<()>("main",&o.id,|_|panic!("cancelled admission cannot create a window")).is_err());}

 #[test]fn workspace_handoff_a_window_cannot_be_source_and_target_concurrently(){let s=WorkspaceHandoffs::default();let o=offer(&s);let mut second=view();second.id="view-b".into();assert!(s.begin("dddddddddddddddddddddddddddddddd","workspace-other","main",&second,"view-b",o.proof.identity,"r1",json!({"a":1}),true).is_err());}

 #[test]fn workspace_handoff_expired_admission_remains_visible_for_target_cleanup(){let s=WorkspaceHandoffs::default();let o=offer(&s);s.entries.lock().unwrap().get_mut(&o.id).unwrap().expires=Instant::now()-Duration::from_secs(1);let pending=s.pending_for("workspace-target").unwrap();assert_eq!(pending.len(),1);assert_eq!(pending[0].phase,HandoffPhase::Cancelled);s.settle_unobserved_target(&o.id).unwrap();assert!(s.pending_for("workspace-target").unwrap().is_empty());assert_eq!(s.get("main",&o.id).unwrap().phase,HandoffPhase::Cancelled);}
 #[test]fn workspace_handoff_failed_unobserved_preparation_does_not_exhaust_receipts(){let s=WorkspaceHandoffs::default();for n in 1..150u128{let o=s.begin(&format!("{n:032x}"),"main","workspace-target",&view(),"view-a",HandoffIdentity{source_id:"source-a".into(),vault_id:"vault-a".into(),document_id:Some("doc-a".into())},"r1",json!({"x":1}),true).unwrap();assert!(s.pending_for("workspace-target").unwrap().is_empty());s.cancel("main",&o.id,|_|Ok(())).unwrap();s.settle_unobserved_target(&o.id).unwrap();s.settled("main",&o.id).unwrap();}assert!(s.entries.lock().unwrap().is_empty());}

}
