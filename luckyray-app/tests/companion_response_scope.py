"""Compile production response/scope methods against synthetic authority seams.
Exercises real HTTP serialization and URL/JSON scope checks, not native TLS/UI.
"""
from pathlib import Path
import os, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
base=root/'src-tauri/src'
gateway=(base/'companion_gateway.rs').read_text();content=(base/'companion_gateway/content.rs').read_text();scopes=(base/'companion_gateway/scopes.rs').read_text()
write_json=gateway[gateway.index('fn write_json('):gateway.index('fn lsh_remote_status(')]
transition=gateway[gateway.index('    fn try_transition(&self)'):gateway.index('    pub(crate) fn issue_pairing(')]
selection=scopes[scopes.index('    pub(super) fn validate_request_scope'):scopes.index('    /// Existing presentation sink')]
validator=scopes[scopes.index('fn valid_scope_id'):]
byte_range=content[content.index('fn byte_range('):content.index('fn mime(')]
resource_arm=content[content.index('        Ok(Some((mut file, mime, version))) => {')+len('        Ok(Some((mut file, mime, version))) => {'):content.index('        Ok(None) => match json_route')].rstrip()
assert resource_arm.endswith('}');resource_arm=resource_arm[:-1]
prelude=r'''
use std::collections::HashMap;
use std::sync::{Arc, Mutex, TryLockError, atomic::{AtomicUsize, AtomicBool, Ordering}};
use std::io::{self, Read, Write, Seek, SeekFrom, ErrorKind};
use serde_json::{Value, json};
mod reqwest { pub use url::Url; }
struct Zeroizing<T>(T); impl<T> Zeroizing<T> { fn new(value:T)->Self {Self(value)} }
impl<T> std::ops::Deref for Zeroizing<T> {type Target=T;fn deref(&self)->&T {&self.0}}
#[derive(Debug)] struct GatewayError {code: &'static str}
impl GatewayError {fn new(code: &'static str,_message:&str)->Self {Self{code}}}
type ContentResult<T>=Result<T,(u16,&'static str)>;
#[derive(Clone)] struct FakeScope;
impl FakeScope {fn for_library(&self,id:&str)->Result<Self,()> {if id=="missing" {Err(())} else {Ok(self.clone())}}
fn for_saved_scope(&self,id:&str)->Result<Self,()> {self.for_library(id)}}
#[derive(Clone)] struct FakeBackend;
impl FakeBackend {fn material_catalog(&self)->FakeScope {FakeScope} fn knowledge(&self)->FakeScope {FakeScope}}
#[derive(Clone)] struct CompanionGateway {backend:FakeBackend,request_material_catalog:Option<FakeScope>,request_material_scope:Option<String>,request_knowledge:Option<FakeScope>,request_vault_scope:Option<String>,pending_controls:Arc<AtomicUsize>,transition:Arc<Mutex<()>>,allowed:Arc<AtomicBool>}
impl CompanionGateway {fn material_scope_id(&self)->Option<&str>{self.request_material_scope.as_deref()}}
#[derive(Default)] struct HttpRequest {method:String,path:String,headers:HashMap<String,String>,body:Vec<u8>}
fn access(g:&CompanionGateway,_:&HttpRequest)->ContentResult<()> {if g.allowed.load(Ordering::SeqCst){Ok(())} else {Err((403,"SCOPE_DENIED"))}}
mod notes {use super::*;pub fn resource_source_current(_:&CompanionGateway,_:&HttpRequest)->bool {true}}
fn fixture()->CompanionGateway{CompanionGateway {backend:FakeBackend,request_material_catalog:None,request_material_scope:Some("fixture".into()),request_knowledge:None,request_vault_scope:None,pending_controls:Arc::new(AtomicUsize::new(0)),transition:Arc::new(Mutex::new(())),allowed:Arc::new(AtomicBool::new(true))}}
'''
code=prelude+f'#[path="{(base / "companion_gateway/diagnostics.rs").as_posix()}"] mod diagnostics;\nimpl CompanionGateway {{\n'+transition+selection+'}\n'+validator+write_json+byte_range+'\nfn resource_reply(gateway:&CompanionGateway,request:&HttpRequest,stream:&mut impl Write,stop:&AtomicBool,mut file:std::fs::File,mime:String,version:String)->io::Result<()> {\n'+resource_arm+'}\n'+r'''
#[test] fn scope_validation_still_rejects_invalid_header_query_route_and_body() {
    let g=fixture();
    let request=|path:&str,body:Value,vault:&str| HttpRequest {method:"GET".into(),path:path.into(),headers:HashMap::from([("x-luckyray-knowledge-vault".into(),vault.into())]),body:serde_json::to_vec(&body).unwrap()};
    assert!(matches!(g.scope_for_request(&request("/v1/notes",Value::Null,"bad/path")),Err((400,"SCOPE_INVALID"))));
    assert!(matches!(g.scope_for_request(&request("/v1/notes?vault=other",Value::Null,"selected")),Err((409,"SCOPE_MISMATCH"))));
    assert!(matches!(g.scope_for_request(&request("/v1/services/knowledge/vaults/other/notes",Value::Null,"selected")),Err((409,"SCOPE_MISMATCH"))));
    for body in [json!({"vaultId":"other"}),json!({"target":{"vaultId":"other"}})] {
        assert!(matches!(g.scope_for_request(&request("/v1/services/knowledge/notes",body,"selected")),Err((409,"SCOPE_MISMATCH"))));
    }
    assert!(matches!(g.scope_for_request(&request("/v1/notes",Value::Null,"missing")),Err((409,"SCOPE_UNAVAILABLE"))));
    let selected=g.scope_for_request(&request("/v1/notes?vault=selected",json!({"vaultId":"selected"}),"selected")).unwrap();
    assert_eq!(selected.request_vault_scope.as_deref(),Some("selected")); assert_eq!(g.request_vault_scope,None);
}
fn file()->std::fs::File {static NEXT:AtomicUsize=AtomicUsize::new(0);let p=std::env::temp_dir().join(format!("lr-synthetic-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::SeqCst)));std::fs::write(&p,b"SYNTHETIC").unwrap();let f=std::fs::File::open(&p).unwrap();std::fs::remove_file(&p).unwrap();f}
fn request()->HttpRequest{HttpRequest{method:"GET".into(),path:"/v1/assets/synthetic/file".into(),..Default::default()}}
#[test] fn pre_header_failures_write_one_real_http_error_without_resource_bytes() {
    let g=fixture(); let _r=diagnostics::begin();diagnostics::enable(Some("synthetic"));
    let guard=g.transition.lock().unwrap();let mut out=vec![];
    resource_reply(&g,&request(),&mut out,&AtomicBool::new(false),file(),"text/plain".into(),"v1".into()).unwrap();
    let reply=String::from_utf8(out).unwrap();assert!(reply.starts_with("HTTP/1.1 503"));assert_eq!(reply.matches("HTTP/1.1").count(),1);assert!(reply.ends_with("{\"code\":\"CONTENT_UNAVAILABLE\"}"));assert!(!reply.contains("SYNTHETIC"));assert!(!reply.contains("Scope-Protocol"));drop(guard);
    g.allowed.store(false,Ordering::SeqCst);let mut out=vec![];
    resource_reply(&g,&request(),&mut out,&AtomicBool::new(false),file(),"text/plain".into(),"v1".into()).unwrap();
    let reply=String::from_utf8(out).unwrap();assert!(reply.starts_with("HTTP/1.1 403"));assert_eq!(reply.matches("HTTP/1.1").count(),1);assert!(!reply.contains("Scope-Protocol"));
}
#[test] fn successful_scope_marker_and_midstream_revocation_never_double_write() {
    let g=fixture();let _r=diagnostics::begin();diagnostics::enable(None);let mut out=vec![];
    resource_reply(&g,&request(),&mut out,&AtomicBool::new(false),file(),"text/plain".into(),"v1".into()).unwrap();
    let reply=String::from_utf8(out).unwrap();assert!(reply.starts_with("HTTP/1.1 200"));assert!(reply.contains("X-LuckyRay-Scope-Protocol: 1\r\n"));assert!(reply.ends_with("SYNTHETIC"));
    struct RevokeAtHeaders{out:Vec<u8>,allowed:Arc<AtomicBool>}
    impl Write for RevokeAtHeaders {fn write(&mut self,bytes:&[u8])->io::Result<usize>{self.out.extend_from_slice(bytes);if self.out.ends_with(b"\r\n\r\n"){self.allowed.store(false,Ordering::SeqCst);}Ok(bytes.len())}fn flush(&mut self)->io::Result<()>{Ok(())}}
    let mut out=RevokeAtHeaders{out:vec![],allowed:Arc::clone(&g.allowed)};
    assert_eq!(resource_reply(&g,&request(),&mut out,&AtomicBool::new(false),file(),"text/plain".into(),"v1".into()).unwrap_err().kind(),ErrorKind::PermissionDenied);
    let reply=String::from_utf8(out.out).unwrap();assert_eq!(reply.matches("HTTP/1.1").count(),1);assert!(!reply.contains("SYNTHETIC"));
}
'''
with tempfile.TemporaryDirectory(prefix='lr-response-') as tmp:
    p=Path(tmp);(p/'src').mkdir();(p/'src/lib.rs').write_text('#[cfg(test)] mod synthetic {\n'+code+'\n}')
    (p/'Cargo.toml').write_text('[package]\nname="companion-response-synthetic"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nserde_json="=1.0.150"\nurl="=2.5.8"\n')
    subprocess.run([os.environ.get('CARGO','cargo'),'test','--manifest-path',str(p/'Cargo.toml')],check=True)
