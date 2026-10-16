//! Native recovery contains only grants/captured library identity, never drafts.
//! Renderer layout lives in its separately validated presentation-only storage.
use serde::{Serialize,Deserialize};
use std::{path::Path,sync::Mutex};
use crate::{knowledge::WorkspaceScopeRecord,workspace_windows::ViewGrant};
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedView {pub view:ViewGrant,pub scope:Option<WorkspaceScopeRecord>,#[serde(default)]pub catalog_library_id:Option<String>,#[serde(default)] pub attachments:Option<crate::workspace_attachments::AttachmentBaseline>}
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedWindow {pub id:String,pub closed:bool,#[serde(default)]pub integrated:bool,pub views:Vec<SavedView>}
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {version:u8,windows:Vec<SavedWindow>,main:Vec<SavedView>}
impl Default for Archive {fn default()->Self{Self{version:1,windows:vec![],main:vec![]}}}
#[derive(Default)]
pub(crate) struct RecoveryStore {data:Mutex<Option<Archive>>}
fn valid(archive:&Archive)->bool{
 let views_valid=|views:&[SavedView]|{let mut ids=std::collections::HashSet::new();views.len()<=100&&views.iter().all(|entry|{let view=&entry.view;entry.catalog_library_id.as_ref().is_none_or(|id|view.kind=="graph"&&!id.is_empty()&&id.len()<=256&&!id.chars().any(char::is_control))&&entry.attachments.as_ref().is_none_or(|baseline|baseline.valid_for(view))&&ids.insert(&view.id)&&matches!(view.kind.as_str(),"note"|"graph")&&!view.id.is_empty()&&view.id.len()<=128&&!view.library_id.is_empty()&&view.library_id.len()<=256&&view.title.len()<=1024&&(if view.kind=="graph"{view.resource_id.is_none()}else{view.resource_id.as_ref().is_some_and(|path|!path.is_empty()&&path.len()<=4096)})})};
 let mut labels=std::collections::HashSet::new();
 archive.version==1&&archive.windows.len()<=24&&views_valid(&archive.main)&&archive.windows.iter().all(|window|labels.insert(&window.id)&&window.id.starts_with("workspace-")&&window.id.len()<=64&&window.id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-')&&!window.views.is_empty()&&views_valid(&window.views))
}
fn load(root:&Path)->Result<Archive,String>{
 let path=root.join("workspace-windows-v1.json");if !path.exists(){return Ok(Archive::default());}
 for path in [path,root.join("workspace-windows-v1.backup.json")]{
  if std::fs::metadata(&path).map(|m|m.len()>4_000_000).unwrap_or(true){continue;}
  if let Ok(bytes)=std::fs::read(path){if let Ok(value)=serde_json::from_slice::<Archive>(&bytes){if valid(&value){return Ok(value);}}}
 }
 Err("workspace-recovery-corrupt-original-kept".into())
}
impl RecoveryStore {
 fn access<T>(&self,root:&Path,f:impl FnOnce(&mut Archive)->Result<T,String>)->Result<T,String>{
  let mut data=self.data.lock().map_err(|_|"workspace-recovery-lock")?;
  if data.is_none(){*data=Some(load(root)?);}f(data.as_mut().unwrap())
 }
 fn update(&self,root:&Path,f:impl FnOnce(&mut Archive)->Result<(),String>)->Result<(),String>{
  self.access(root,|current|{let mut next=current.clone();f(&mut next)?;if !valid(&next){return Err("workspace-invalid-recovery".into());}
   let before=serde_json::to_vec(current).map_err(|_|"workspace-recovery-encode")?;
   let after=serde_json::to_vec(&next).map_err(|_|"workspace-recovery-encode")?;if after.len()>4_000_000{return Err("workspace-recovery-limit".into());}
   crate::knowledge::atomic_write(&root.join("workspace-windows-v1.backup.json"),&before,true).map_err(crate::knowledge_error)?;
   crate::knowledge::atomic_write(&root.join("workspace-windows-v1.json"),&after,true).map_err(crate::knowledge_error)?;
   *current=next;Ok(())
  })
 }
 pub fn window(&self,root:&Path,id:&str)->Result<SavedWindow,String>{self.access(root,|data|data.windows.iter().find(|window|window.id==id).cloned().ok_or("workspace-recovery-missing".into()))}
 pub fn list(&self,root:&Path)->Result<Vec<SavedWindow>,String>{self.access(root,|data|Ok(data.windows.clone()))}
 pub fn save_window(&self,root:&Path,window:SavedWindow)->Result<(),String>{self.update(root,|data|{
  data.windows.retain(|old|old.id!=window.id);data.windows.push(window);
  while data.windows.len()>24{let index=data.windows.iter().position(|window|window.closed).ok_or("workspace-recovery-limit")?;data.windows.remove(index);}Ok(())
 })}
 pub fn save_main(&self,root:&Path,view:SavedView)->Result<(),String>{self.update(root,|data|{data.main.retain(|old|old.view.id!=view.view.id);data.main.push(view);Ok(())})}
 pub fn main_view(&self,root:&Path,view:&ViewGrant)->Result<Option<SavedView>,String>{self.access(root,|data|Ok(data.main.iter().find(|old|old.view==*view).cloned()))}
}

#[cfg(test)] mod tests {
 use super::*;
 fn window(id:&str)->SavedWindow{SavedWindow{id:id.into(),closed:true,integrated:false,views:vec![SavedView{view:ViewGrant{id:"v".into(),kind:"note".into(),library_id:"A".into(),resource_id:Some("a.md".into()),title:"A".into()},scope:None,catalog_library_id:None,attachments:None}]}}
 #[test] fn recovery_validates_attachment_baseline_identity_and_never_requires_legacy_grants(){
  let mut saved=window("workspace-a");
  assert!(valid(&Archive{windows:vec![saved.clone()],..Archive::default()}));
  let baseline=serde_json::json!({"view":saved.views[0].view,"references":[["image.png",true,"media/image.png"]]});
  saved.views[0].attachments=Some(serde_json::from_value(baseline.clone()).unwrap());
  assert!(valid(&Archive{windows:vec![saved.clone()],..Archive::default()}));
  for identity in ["/etc/passwd","C:/secret.png","../secret.png","a/../secret.png","a//secret.png"]{
   let mut forged=baseline.clone();forged["references"][0][2]=serde_json::json!(identity);
   saved.views[0].attachments=Some(serde_json::from_value(forged).unwrap());
   assert!(!valid(&Archive{windows:vec![saved.clone()],..Archive::default()}));
  }
  for field in ["id","libraryId","resourceId"]{
   let mut forged=baseline.clone();forged["view"][field]=serde_json::json!("foreign");
   saved.views[0].attachments=Some(serde_json::from_value(forged).unwrap());
   assert!(!valid(&Archive{windows:vec![saved.clone()],..Archive::default()}));
  }
  let mut oversized=baseline;oversized["references"]=serde_json::json!(vec![("image.png",true,"media/image.png");257]);
  saved.views[0].attachments=Some(serde_json::from_value(oversized).unwrap());
  assert!(!valid(&Archive{windows:vec![saved],..Archive::default()}));
 }
 #[test] fn saved_windows_survive_new_registry_and_corrupt_primary_uses_backup(){
  let root=tempfile::tempdir().unwrap();let store=RecoveryStore::default();
  store.save_window(root.path(),window("workspace-a")).unwrap();store.save_window(root.path(),window("workspace-b")).unwrap();
  assert_eq!(RecoveryStore::default().list(root.path()).unwrap().len(),2);
  std::fs::write(root.path().join("workspace-windows-v1.json"),b"broken").unwrap();
  let fresh=RecoveryStore::default();assert_eq!(fresh.list(root.path()).unwrap().len(),1);assert_eq!(fresh.list(root.path()).unwrap()[0].id,"workspace-a");
 }
 #[test] fn corrupt_primary_and_backup_are_preserved_and_history_is_bounded(){
  let root=tempfile::tempdir().unwrap();let store=RecoveryStore::default();
  for n in 0..30{store.save_window(root.path(),window(&format!("workspace-{n}"))).unwrap();}assert_eq!(store.list(root.path()).unwrap().len(),24);
  for name in ["workspace-windows-v1.json","workspace-windows-v1.backup.json"]{std::fs::write(root.path().join(name),b"broken").unwrap();}
  assert!(RecoveryStore::default().save_window(root.path(),window("workspace-new")).is_err());
  assert_eq!(std::fs::read(root.path().join("workspace-windows-v1.json")).unwrap(),b"broken");
 }
}
