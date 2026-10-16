#![allow(dead_code,unused_imports)]
mod community_mcp;mod community_mcp_package;mod community_mcp_knowledge;mod community_mcp_process;
mod tauri{
 #[derive(Clone)]pub struct AppHandle; pub struct Webview;
 pub trait Manager{fn state<T:Default>(&self)->T;}
 impl Manager for AppHandle{fn state<T:Default>(&self)->T{T::default()}}
 impl AppHandle{pub fn path(&self)->PathResolver{PathResolver}}
 pub struct PathResolver;impl PathResolver{pub fn app_local_data_dir(&self)->Result<std::path::PathBuf,String>{Ok(std::env::temp_dir())}}
 pub mod async_runtime{pub async fn spawn_blocking<T>(f:impl FnOnce()->T)->Result<T,String>{Ok(f())}}
}
fn require_main_caller(_: &tauri::Webview)->Result<(),String>{Ok(())}
fn knowledge_service()->Result<knowledge::KnowledgeService,String>{Ok(knowledge::KnowledgeService)}
struct Catalog;struct Library{id:String,name:String,visible:bool}
fn material_catalog_for_app(_: &tauri::AppHandle)->Result<Catalog,String>{Ok(Catalog)}
impl Catalog{fn list_libraries(&self,_:bool)->Result<Vec<Library>,String>{Ok(vec![])}fn for_library(&self,_:&str)->Result<(),String>{Ok(())}}
mod materials_mcp_gui{pub fn run(_: &std::path::Path,_:&[String],_:Option<&[u8]>,_:u64)->Result<(bool,String,String),String>{Ok((true,String::new(),String::new()))}}
mod assets_import_file{
 pub struct DownloadLimits{pub max_bytes:u64,pub total_timeout:std::time::Duration,pub max_redirects:usize}
 pub fn download_with_limits(_:&str,_:&DownloadLimits)->Result<Vec<u8>,String>{Err("stub".into())}
 pub fn validate_file_name(s:&str)->Result<String,String>{if s.contains(['/', '\\', ':']){Err("invalid".into())}else{Ok(s.into())}}
}
mod knowledge{
 use serde::{Serialize,Deserialize};
 pub struct KnowledgeService;pub struct WorkspaceScopeRecord;
 #[derive(PartialEq,Eq)]pub struct KnowledgeTargetIdentity{pub label:String}
 pub struct KnowledgeError{pub code:&'static str}
 #[derive(Serialize)]pub struct KnowledgeDocumentRef{pub vault_id:String}
 pub struct Summary{pub document_ref:KnowledgeDocumentRef,pub title:String,pub relative_path:String}
 pub struct Document{pub summary:Summary,pub content:String,pub revision:String}
 pub struct KnowledgeCreateInput{pub title:String,pub parent_relative_path:Option<String>,pub content:String}
 pub struct Mutation{pub document:Document,pub index_stale:bool}
 impl KnowledgeService{
  pub fn capture_workspace_scope(&self,_:&str)->Result<Self,KnowledgeError>{Ok(Self)}
  pub fn workspace_recovery_record(&self)->Result<WorkspaceScopeRecord,KnowledgeError>{Ok(WorkspaceScopeRecord)}
  pub fn restore_workspace_scope(&self,_:&WorkspaceScopeRecord)->Result<Self,KnowledgeError>{Ok(Self)}
  pub fn current_vault_id(&self)->Result<String,KnowledgeError>{Ok("fixture".into())}
  pub fn current_target_identity(&self)->Result<KnowledgeTargetIdentity,KnowledgeError>{Ok(KnowledgeTargetIdentity{label:"fixture".into()})}
  pub fn parse_document_id(_:&str)->Result<KnowledgeDocumentRef,KnowledgeError>{Ok(KnowledgeDocumentRef{vault_id:"fixture".into()})}
  pub fn document_id(_:&KnowledgeDocumentRef)->String{"note-1".into()}
  pub fn read_document_for_target(&self,_:&KnowledgeTargetIdentity,_:&KnowledgeDocumentRef)->Result<Document,KnowledgeError>{Err(KnowledgeError{code:"stub"})}
  pub fn create_document_for_target(&self,_:&KnowledgeTargetIdentity,_:&KnowledgeCreateInput)->Result<Mutation,KnowledgeError>{Err(KnowledgeError{code:"stub"})}
  pub fn search_documents(&self,_:&str,_:usize)->Result<Vec<Summary>,KnowledgeError>{Ok(vec![])}
 }
}
mod local_transport{
 use serde_json::{Value,json};
 pub struct AdapterResponse{pub status:u16,pub body:String}
 pub struct VerifiedTransportPrincipal;
 impl VerifiedTransportPrincipal{pub fn with_knowledge_mcp<T>(&self,f:impl FnOnce(&crate::knowledge::WorkspaceScopeRecord,&str,&std::path::Path)->Result<T,String>)->Result<T,String>{f(&crate::knowledge::WorkspaceScopeRecord,"fixture",&std::env::temp_dir())}}
 #[derive(Default)]pub struct LocalTransportHandle;
 pub struct Grant{pub id:String}
 impl Grant{pub fn public_metadata(&self)->Value{json!({})}}
 impl LocalTransportHandle{
  pub fn list_materials_grants(&self)->Result<Vec<Grant>,String>{Ok(vec![])}
  pub fn revoke_materials(&self,_:&str)->Result<(),String>{Ok(())}
  pub fn pair_libraries(&self,_:&str,_:&str,_:crate::knowledge::WorkspaceScopeRecord)->Result<Value,String>{Ok(json!({}))}
  pub fn materials_profile_root(&self)->Result<String,String>{Ok("fixture".into())}
 }
}
