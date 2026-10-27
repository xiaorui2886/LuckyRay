"""Compile extracted production admission/transition code with synthetic state.
Not a full gateway/TLS/Windows integration build.
"""
from pathlib import Path
import os, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
src=(root/'src-tauri/src/companion_gateway.rs').read_text()
diag=root/'src-tauri/src/companion_gateway/diagnostics.rs'
def extract(start,end):
    return src[src.index(start):src.index(end,src.index(start))]
budget=extract('struct AuthenticatedRequestWindow {','struct ConnectionRecord {')
transition=extract('    fn try_transition(&self)', '    pub(crate) fn issue_pairing(')
services=(root/'src-tauri/src/companion_gateway/services.rs').read_text()
service_transition=services[services.index("fn service_transition<'a>"):services.index('fn current_vault(')]
memo=services[services.index('    let mut grants = HashMap'):services.index('    let mut statuses = serde_json::Map::new();')]
code='''use std::collections::HashMap;
use std::time::{Duration, Instant};
use std::sync::{Mutex, TryLockError, atomic::{AtomicUsize, AtomicU64, AtomicBool, Ordering}};
#[derive(Debug)] struct GatewayError { code: &'static str }
impl GatewayError { fn new(code: &'static str, _message: &str) -> Self { Self { code } } }
struct GatewayPolicy { authenticated_request_limit: usize, authenticated_request_window: Duration }
struct CompanionGateway { request_vault_scope: Option<String>, pending_controls: AtomicUsize, transition: Mutex<()>, permission: AtomicU64, allowed: AtomicBool, reads: AtomicUsize }
impl CompanionGateway {
    fn material_scope_id(&self) -> Option<&str> { Some("synthetic-scope") }
    fn validate_request_scope(&self) -> Result<(),(u16,&'static str)> { Ok(()) }
}
struct PairedDevice { device_id: String }
type ServiceResult<T> = Result<T,(u16,&'static str)>;
fn live_generation(gateway: &CompanionGateway, _: &PairedDevice, _: u64) -> ServiceResult<u64> {
    Ok(gateway.permission.load(Ordering::SeqCst))
}
fn granted(gateway: &CompanionGateway, _: &str, _: &str, _: &str, _: &str) -> ServiceResult<bool> {
    gateway.reads.fetch_add(1,Ordering::SeqCst); Ok(gateway.allowed.load(Ordering::SeqCst))
}
fn fixture() -> CompanionGateway { CompanionGateway { request_vault_scope:None, pending_controls:AtomicUsize::new(0),transition:Mutex::new(()),permission:AtomicU64::new(1),allowed:AtomicBool::new(true),reads:AtomicUsize::new(0) } }
'''+f'#[path = "{diag.as_posix()}"] mod diagnostics;\n'+budget+'\nimpl CompanionGateway {\n'+transition+'}\n'+service_transition+'\nfn catalog_grants(gateway: &CompanionGateway, device: &PairedDevice) -> ServiceResult<bool> {\n'+memo+'let first=grant("content.read","catalog","")?; let second=grant("content.read","catalog","")?; assert_eq!(first,second); Ok(first) }\n'+r'''
#[test] fn budget_keeps_limit_and_reports_remaining_window() {
    let p=GatewayPolicy { authenticated_request_limit:2, authenticated_request_window:Duration::from_secs(60) };
    let mut budget=AuthenticatedRequestBudget::default();
    let _r=diagnostics::begin(); diagnostics::enable(Some("synthetic"));
    budget.admit(&p,"device-a").unwrap(); budget.admit(&p,"device-a").unwrap();
    assert_eq!(budget.admit(&p,"device-a").unwrap_err().code,"AUTH_RATE_LIMITED");
    assert!(diagnostics::response_headers(429).contains("Retry-After: 60\r\n"));
    assert!(diagnostics::response_headers(429).contains("rate-window"));
    budget.admit(&p,"device-b").unwrap();
    budget.devices.get_mut("device-a").unwrap().started_at=Instant::now()-Duration::from_secs(61);
    budget.admit(&p,"device-a").unwrap();
    assert_eq!(budget.devices["device-a"].accepted,1);
}
#[test] fn transition_reasons_preserve_guard_refusal() {
    let g=fixture(); g.pending_controls.store(1,Ordering::SeqCst);
    let _r=diagnostics::begin(); diagnostics::enable(Some("synthetic"));
    assert_eq!(g.try_transition().unwrap_err().code,"gateway-transition-in-progress");
    assert!(diagnostics::response_headers(503).contains("control-pending"));
    g.pending_controls.store(0,Ordering::SeqCst);
    let lock=g.transition.lock().unwrap();
    assert_eq!(g.try_transition().unwrap_err().code,"gateway-transition-in-progress");
    assert!(diagnostics::response_headers(503).contains("transition-busy"));
    drop(lock); assert!(g.try_transition().is_ok());
}
#[test] fn catalog_memo_is_request_local_and_final_revision_rejects_stale_grants() {
    let g=fixture(); let d=PairedDevice { device_id:"synthetic".into() };
    assert!(catalog_grants(&g,&d).unwrap()); assert_eq!(g.reads.load(Ordering::SeqCst),1);
    g.allowed.store(false,Ordering::SeqCst); g.permission.store(2,Ordering::SeqCst);
    assert_eq!(service_transition(&g,&d,1,1).unwrap_err(),(403,"SCOPE_DENIED"));
    assert!(!catalog_grants(&g,&d).unwrap()); assert_eq!(g.reads.load(Ordering::SeqCst),2);
    assert!(service_transition(&g,&d,1,2).is_ok());
}
#[test] fn stage_boundary_does_not_blame_handled_error() {
    let _r=diagnostics::begin(); diagnostics::enable(Some("synthetic"));
    diagnostics::reason(diagnostics::Reason::DatabaseUnavailable);
    diagnostics::stage(diagnostics::Stage::Commit);
    assert!(!diagnostics::response_headers(403).contains("database-unavailable"));
}
'''
with tempfile.TemporaryDirectory(prefix='lr-diagnostics-') as tmp:
    source=Path(tmp)/'test.rs'; source.write_text(code); binary=Path(tmp)/'test'
    subprocess.run([os.environ.get('RUSTC','rustc'),'--edition','2021','--test',str(source),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
# Structural response-boundary guards complement the executable extracted tests.
content=(root/'src-tauri/src/companion_gateway/content.rs').read_text()
pre,post=content.split('drop(header_guard);',1)
assert 'return write_json(stream,503,&json!({"code":"CONTENT_UNAVAILABLE"}))' in pre
assert 'return write_json(stream,status,&json!({"code":code}))' in pre
assert 'let _chunk_guard = gateway.try_transition()' in post
assert 'access(gateway,request).map_err' in post
assert 'notes::resource_source_current(gateway, request)' in post
assert src.count('services::serve(self, &request, &mut tls, &device, generation)')==1
print('PASS: pre-header HTTP error boundary and unchanged post-header authorization/source checks (structural)')
