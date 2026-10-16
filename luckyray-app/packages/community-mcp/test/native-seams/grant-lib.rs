//! Isolated contract harness: actual grant module, minimal host authority fixture.
#![allow(dead_code,unused_imports)]
mod knowledge {
 use serde::{Serialize,Deserialize};
 #[derive(Clone,Serialize,Deserialize)]pub struct WorkspaceScopeRecord{pub vault:String}
}
mod materials{
 pub type MaterialResult<T>=Result<T,MaterialError>;
 pub struct MaterialError;impl MaterialError{pub fn new(_:&str,_:&str)->Self{Self}}
 pub mod consumer{pub fn valid_consumer_id(v:&str)->bool{!v.is_empty()&&v.len()<128}}
}
mod local_transport{
 use serde::{Serialize,Deserialize};use serde_json::{Value,json};use sha2::{Digest,Sha256};
 use std::{fs,io::ErrorKind,path::{Path,PathBuf},collections::BTreeSet,time::{SystemTime,UNIX_EPOCH},sync::{Mutex,MutexGuard,Arc}};
 #[path="__GRANT_SOURCE__"]mod materials_grants;
 use materials_grants::MaterialsGrant;
 const AUTH_FILE_NAME:&str="auth.json";
 struct PersistedAuth{master_secret:String}
 struct AuthState{path:PathBuf,persisted:PersistedAuth,materials_grants:Vec<MaterialsGrant>,materials_grants_error:Option<String>}
 fn random_hex(n:usize)->String{(0..n).map(|_|format!("{:02x}",rand::random::<u8>())).collect()}
 fn is_strict_secret(s:&str)->bool{s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit())}
 fn constant_time_eq(a:&[u8],b:&[u8])->bool{a==b}
 fn derive_credential(key:&str,context:&str)->Result<String,String>{
  use hmac::{Hmac,Mac};
  let bytes=(0..key.len()).step_by(2).map(|i|u8::from_str_radix(&key[i..i+2],16).unwrap()).collect::<Vec<_>>();
  let mut h=Hmac::<Sha256>::new_from_slice(&bytes).unwrap();h.update(format!("luckyray-local-transport-credential-v1\0{context}").as_bytes());Ok(format!("{:x}",h.finalize().into_bytes()))
 }
 fn persist_auth_record(p:&Path,v:&impl Serialize)->Result<(),String>{fs::write(p,serde_json::to_vec(v).unwrap()).map_err(|e|e.to_string())}
 impl AuthState{
  fn load_or_create(root:&Path)->Result<Self,String>{fs::create_dir_all(root).unwrap();let p=root.join(AUTH_FILE_NAME);let key=match fs::read_to_string(&p){Ok(k)=>k,Err(_)=>{let k=random_hex(32);fs::write(&p,&k).unwrap();k}};let mut s=Self{path:p,persisted:PersistedAuth{master_secret:key},materials_grants:vec![],materials_grants_error:None};s.initialize_materials_grants();Ok(s)}
  fn native_credential(&self)->Result<String,String>{derive_credential(&self.persisted.master_secret,"native")}
  fn rotate_master(&mut self)->Result<(),String>{self.persisted.master_secret=random_hex(32);fs::write(&self.path,&self.persisted.master_secret).unwrap();Ok(())}
 }
 struct LocalTransportHandle{auth:Arc<Mutex<AuthState>>}impl LocalTransportHandle{fn base_url(&self)->String{"http://127.0.0.1:37419".into()}}
 struct Binding{materials_grant_id:Option<String>,auth:Arc<Mutex<AuthState>>}
 struct VerifiedTransportPrincipal{material_binding:Option<Binding>}
 struct Admission<'a>{_auth:MutexGuard<'a,AuthState>}
 impl VerifiedTransportPrincipal{fn material_admission(&self)->crate::materials::MaterialResult<Admission<'_>>{Ok(Admission{_auth:self.material_binding.as_ref().unwrap().auth.lock().unwrap()})}}
 #[derive(Debug)]struct TransportFailure{status:u16,code:String}impl TransportFailure{fn new(status:u16,code:&str,_:&str)->Self{Self{status,code:code.into()}}}
 #[test]fn unified_atomic_grant_redacts_scope_and_denies_downgrade(){
  let root=std::env::temp_dir().join(format!("lr-unified-{}",random_hex(8)));let state=AuthState::load_or_create(&root).unwrap();fs::write(root.join("luckyray.db"),b"fixture").unwrap();
  let host=LocalTransportHandle{auth:Arc::new(Mutex::new(state))};
  let legacy=host.pair_materials("Existing Codex", "material-legacy").unwrap();
  let legacy_bytes=fs::read(root.join("local-transport-materials-grants-v1.json")).unwrap();
  let pair=host.pair_libraries("material-1","vault-1",crate::knowledge::WorkspaceScopeRecord{vault:"private-vault-root".into()}).unwrap();
  assert_eq!(fs::read(root.join("local-transport-materials-grants-v1.json")).unwrap(),legacy_bytes);
  assert!(root.join("local-transport-web-library-grants-v1.json").exists());
  let id=pair["clientId"].as_str().unwrap();let token=pair["credential"].as_str().unwrap();
  let state=host.auth.lock().unwrap();assert_eq!(state.matching_materials_grant(token).as_deref(),Some(id));
  let public=state.materials_grants.iter().find(|g|g.id==id).unwrap().public_metadata().to_string();assert!(!public.contains("private-vault-root"));assert!(!public.contains("credential"));
  for v in [1,2]{assert_eq!(state.materials_proof(&json!({"clientId":id,"clientNonce":random_hex(32),"profileProofVersion":v}).to_string(),37419,&random_hex(32)).unwrap_err().status,401);}
  let proof=state.materials_proof(&json!({"clientId":id,"clientNonce":random_hex(32),"profileProofVersion":3}).to_string(),37419,&random_hex(32)).unwrap();assert_eq!(proof["vaultId"],"vault-1");drop(state);
  let p=VerifiedTransportPrincipal{material_binding:Some(Binding{materials_grant_id:Some(id.into()),auth:host.auth.clone()})};
  assert!(p.check_materials_route("POST","/api/v1/library-mcp/knowledge/import-markdown",None).is_ok());
  assert!(p.check_materials_route("POST","/api/v1/knowledge/delete",None).is_err());
  host.revoke_materials(id).unwrap();assert!(host.auth.lock().unwrap().matching_materials_grant(token).is_none());
  assert_eq!(fs::read(root.join("local-transport-materials-grants-v1.json")).unwrap(),legacy_bytes);
  assert!(host.auth.lock().unwrap().matching_materials_grant(legacy["credential"].as_str().unwrap()).is_some());
  fs::remove_dir_all(root).unwrap();
 }
}
