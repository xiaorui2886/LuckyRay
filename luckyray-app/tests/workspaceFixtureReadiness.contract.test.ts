import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createFixtureDiagnostics} from './fixtures/workspace-native-diagnostics.ts';
import {verifyFixtureResult,REQUIRED,RUST_ASSERTIONS,MAIN_ASSERTIONS} from '../scripts/check-workspace-fixture-result.mjs';
const read=(path:string)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('child stage and failure use only the scoped dispatcher, never the denied direct report',async()=>{
 const calls:any[]=[];const invoke=async(name:string,args:any)=>{calls.push({name,args});return {accepted:true};};
 const child=createFixtureDiagnostics('workspace-real',invoke,'boot-a');
 await child.stage('bootstrap');await child.report({error:'native bootstrap denied'});
 assert.deepEqual(calls,[{name:'workspace_window_command',args:{request:{op:'fixtureReport',report:{stage:'bootstrap',bootId:'boot-a'}}}},{name:'workspace_window_command',args:{request:{op:'fixtureReport',report:{error:'native bootstrap denied',stage:'bootstrap',bootId:'boot-a'}}}}]);
 await assert.rejects(child.report(null),/fixture-poll-main-only/);assert.equal(calls.length,2);
});
test('main retains direct guarded report and poll, with deterministic stage',async()=>{
 const calls:any[]=[];const main=createFixtureDiagnostics('main',async(name,args)=>{calls.push({name,args});return {};},'main-boot');
 await main.stage('children-readiness');await main.report(null);await main.report({error:'children readiness timeout'});
 assert.equal(calls.every(call=>call.name==='workspace_fixture_report'),true);
 assert.deepEqual(calls[1].args,{report:null});assert.equal(calls[2].args.report.stage,'children-readiness');
});
test('the merged E0282 handler remains guarded and direct reporting stays Main-only',async()=>{
 const native=await read('src-tauri/src/workspace_fixture.rs');
 assert.match(native,/workspace_command_policy::guard\(tauri::generate_handler!\[[\s\S]*workspace_fixture_report,[\s\S]*workspace_fixture_legacy_probe/);
 assert.match(native,/move \|invoke: tauri::ipc::Invoke\| guarded\(invoke\)/);
 assert.doesNotMatch(native,/let report = tauri::generate_handler!|if invoke.message.command/);
 const direct=native.slice(native.indexOf('fn workspace_fixture_report'),native.indexOf('pub fn run()'));
 assert.match(direct,/caller.label\(\) != "main".*fixture-main-only/);
});
test('fixture-only scoped arm is compiled out without debug plus feature and needs live isolated state',async()=>{
 const source=await read('src-tauri/src/workspace_windows.rs');
 const cfg=/#\[cfg\(all\(debug_assertions, feature = "workspace-runtime-fixture"\)\)\]\s*/;
 assert.match(source,new RegExp(cfg.source+'FixtureReport \\{ report: serde_json::Value \\}'));
 assert.match(source,new RegExp(cfg.source+'WindowRequest::FixtureReport \\{ report \\} => crate::workspace_fixture::report_child\\(&app, &caller, report\\)'));
 const native=await read('src-tauri/src/workspace_fixture.rs');
 assert.match(native,/identifier == "com.luckyray.workspace.fixture" && state_present/);
 assert.match(native,/fixture_mode_allowed\(&app.config\(\).identifier, app.try_state::<Fixture>\(\).is_some\(\)\)/);
 assert.match(native,/caller.label\(\) != "main" && app.state::<crate::workspace_windows::WorkspaceWindows>\(\).session\(caller.label\(\)\).is_ok\(\)/);
 assert.match(native,/if !child_report_allowed\(registered, &report\)/);
 assert.match(native,/record_report\(app, caller.label\(\), report\)\?;\s*Ok\(json!\(\{"accepted":true\}\)\)/);
});
test('bootstrap records dependency failures and readiness waits for each child listener generation',async()=>{
 for(const entry of ['workspace-native.html','workspace-native-child.html']) assert.match(await read(`tests/fixtures/${entry}`),/src="\.\/workspace-native-bootstrap.ts"/);
 const bootstrap=await read('tests/fixtures/workspace-native-bootstrap.ts');
 assert.match(bootstrap,/stage\('js-entry'[\s\S]*import\('\.\/workspace-native'\)[\s\S]*catch\(fail\)/);
 assert.match(bootstrap,/window.addEventListener\('unhandledrejection'/);assert.match(bootstrap,/data-fixture-report-error/);
 const source=await read('tests/fixtures/workspace-native.tsx');
 assert.ok(source.indexOf("'child fixture listeners'")<source.indexOf("emitTo(b.label,'fixture:cross-window-attachment'"));
 assert.match(source,/r.report.bootId!==initialBoots.get\(a.label\)/);
 assert.ok(source.indexOf("'restored fixture listeners'")<source.indexOf("emitTo(a.label,'fixture:verify-recovery'"));
 assert.match(source,/\['workspace_fixture_report','workspace_fixture_legacy_probe'/);
});
test('runtime diagnostics never extend the deadline or mark five Rust checks as completion',async()=>{
 const native=await read('src-tauri/src/workspace_fixture.rs');
 assert.match(native,/Duration::from_secs\(100\)/);assert.match(native,/"status":status,"complete":status=="passed","exitCode":code/);
 assert.match(native,/"lastStageByWindow":stages,"missingAssertions":missing/);
 assert.match(native,/fixture.finished.load\(Ordering::SeqCst\).*fixture-already-finished/);
 assert.match(native,/if completed && !complete_reports\(&reports\)/);
 assert.match(native,/if timeout \{ Some\(124\) \} else if failure \{ Some\(1\) \}/);
 assert.match(native,/app.run_return/);assert.match(native,/std::process::exit\(if code == 0 \{ runtime_code \} else \{ code \}\)/);
 assert.match(native,/\.on_page_load/);
 assert.doesNotMatch(native,/\.inner_size\(\)\.ok\(\)|\.is_visible\(\)/);
 assert.match(native,/std::process::exit\(if code == 0 \{ 124 \} else \{ code \}\)/);
});
function success(){
 const reports=REQUIRED.map((key:string)=>({window:RUST_ASSERTIONS.includes(key)?'rust':MAIN_ASSERTIONS.includes(key)?'main':'workspace-a',report:{[key]:true}}));
 for(const window of ['workspace-a','workspace-b']) reports.push({window,report:{listenersReady:true,editorMounted:true,productionLegacyCommandsDenied:true,opaqueAttachmentRead:true,attachmentRangeRead:true,attachmentForgedScopeDenied:true}});
 return {schemaVersion:2,actualNative:true,status:'passed',complete:true,exitCode:0,reports,missingAssertions:[]};
}
test('result validator accepts only zero exit plus complete source-owned native assertions',()=>{
 assert.deepEqual(verifyFixtureResult(success(),0),{status:'passed',childReporters:2,assertions:REQUIRED.length});
 for(const exit of [1,124,125,undefined]) assert.throws(()=>verifyFixtureResult(success(),exit),/process exit/);
 for(const status of ['running','failed','timed_out']) assert.throws(()=>verifyFixtureResult({...success(),status},0),/verified completion/);
 assert.throws(()=>verifyFixtureResult({...success(),error:'children readiness timeout'},0),/contains an error/);
 const failed=success();failed.reports.push({window:'workspace-a',report:{error:'denied'} as any});assert.throws(()=>verifyFixtureResult(failed,0),/contains an error/);
 const missing=success();missing.reports=missing.reports.filter(entry=>!entry.report.writerCommitted);assert.throws(()=>verifyFixtureResult(missing,0),/writerCommitted/);
 const forged=success();forged.reports.forEach(entry=>{if(entry.window==='rust')entry.window='workspace-a';});assert.throws(()=>verifyFixtureResult(forged,0),/wrong source/);
 const single=success();single.reports=single.reports.filter(entry=>entry.window!=='workspace-b');assert.throws(()=>verifyFixtureResult(single,0),/two distinct/);
 assert.throws(()=>verifyFixtureResult({actualNative:true,reports:[{scopeIsolation:true,sameRelativePathDifferentVault:true,scopedGlobalSwitchDenied:true,recoveredScopeKeepsCapturedIdentity:true,recoveryCannotRetargetRoot:true}]},0),/verified completion/);
});
test('CLI and Rust completion requirements remain identical',async()=>{
 const native=await read('src-tauri/src/workspace_fixture.rs');
 for(const [name,expected] of Object.entries({REQUIRED,RUST_ASSERTIONS,MAIN_ASSERTIONS})){
  const array=native.match(new RegExp(`const ${name}: &\\[&str\\] = &(\\[[^;]+\\]);`))?.[1];assert.ok(array);assert.deepEqual(JSON.parse(array),expected);
 }
});
