import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as crypto from 'node:crypto';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {continueKnownTestingNotice,clickEngineRestart} from './engine-chain.mjs';
import {preservationPolicy} from './preservation-policy.mjs';
const read=name=>readFile(new URL(name,import.meta.url),'utf8');

test('default full integration still requires and verifies actual grant and stored bytes',async()=>{
  assert.throws(()=>preservationPolicy({}),/real grant evidence/);
  const context={originalGrant:{scope:'synthetic'},originalAuthorityBytes:{file:'real-digest'},authorityFingerprints:async()=>({file:'real-digest'})};
  const policy=preservationPolicy(context);let calls=0;
  await policy.verify(async cmd=>{calls++;assert.equal(cmd,'community_mcp_status');return {authorized:true,grant:{scope:'synthetic'}};});
  assert.equal(calls,1);assert.equal(policy.result.settingsAndGrantPreserved,true);
  await assert.rejects(()=>policy.verify(async()=>({authorized:false,grant:context.originalGrant})));
  await assert.rejects(()=>policy.verify(async()=>({authorized:true,grant:{scope:'changed'}})));
  await assert.rejects(()=>preservationPolicy({...context,authorityFingerprints:async()=>({file:'changed'})}).verify(async()=>({authorized:true,grant:context.originalGrant})));
});
test('DSH-only refuses fake grant parameters, unknown modes and existing MCP state',async()=>{
  const local=await mkdtemp(join(tmpdir(),'dsh-policy-'));
  try{
    const context={evidenceMode:'dsh-only',paths:{local}};
    for(const key of ['originalGrant','originalAuthorityBytes','authorityFingerprints'])assert.throws(()=>preservationPolicy({...context,[key]:undefined}),/manufactured grant/);
    assert.throws(()=>preservationPolicy({...context,evidenceMode:'optional'}),/unknown evidence scope/);
    const policy=preservationPolicy(context);await policy.verify(()=>{throw Error('MCP must never be invoked');});
    assert.equal(policy.result.communityMcpAuthorization,'NOT_APPLICABLE_TO_DSH_ONLY');assert.equal(policy.result.desktopAtoB,'NOT_RUN');assert.equal(policy.result.settingsAndGrantPreserved,undefined);
    await mkdir(join(local,'com.luckyray.desktop/community-web-mcp-v1'),{recursive:true});await assert.rejects(()=>policy.verify(),/must not initialize/);
  }finally{await rm(local,{recursive:true,force:true});}
});
test('full-chain driver and preparation remain byte-identical to the fixed handoff',async()=>{
  const hashes={'chain.mjs':'aa88b7fab59e392466607860a487876b88850d48a59e82b0e71a0b0835d1ad70','prepare-fixture.mjs':'dbef6191a5d8104a004355859e6d8096017413f6e15efac327cc7cf5d5962d73'};
  for(const [name,sha]of Object.entries(hashes))assert.equal(createHash('sha256').update(await read(name)).digest('hex'),sha,name);
});
test('DSH-only preparation uses frozen B, real old-session/material helpers and no MCP authority path',async()=>{
  const source=await read('prepare-dsh-only.mjs');
  assert.match(source,/spec\.b\.installedExeSha256/);assert.match(source,/spec\.b\.version,'1\.9\.9'/);assert.match(source,/spec\.engine\.fromVersion,'0\.1\.7-rc\.2'/);
  for(const name of ['seedOldInstalledSession','seedInstalledMaterial','knowledge_create_document','close_window'])assert.ok(source.includes(name));
  assert.match(source,/installedApplicationEnvironment\(process.env,null\)/);
  assert.doesNotMatch(source,/community_mcp_action|credential\.dpapi|action:'authorize'|action:'install'|spec\.a\.|originalGrant|originalAuthorityBytes/);
});
test('DSH-only driver reuses genuine engine UI chain and cannot label desktop integration passed',async()=>{
  const source=await read('dsh-only.mjs'),engine=await read('engine-chain.mjs');
  assert.match(source,/runDshInstalledUpgrade\(\{evidenceMode:'dsh-only'/);
  assert.match(source,/requireCdpOwner\(B.pid\)/);assert.match(source,/PASS_DSH_ONLY_INSTALLED_ENGINE_UPGRADE/);
  assert.doesNotMatch(source,/desktop_application_update|spec\.a\.|originalGrant|originalAuthorityBytes|formal_manifest_request|formal_artifact_request/);
  for(const code of ['await policy.verify(invoke)','await assertOriginals(oldFixture)','await identity(spec.engine.fromVersion)','await identity(spec.engine.version)','await preserved()','cleared draft must not resurrect'])assert.ok(engine.includes(code));
  assert.doesNotMatch(engine,/localStorage\.setItem|process\.kill|\.kill\(/);
});
test('inline DSH-only job verifies B only, retains signature and encrypted evidence gates',async()=>{
  const workflow=(await read('../../../.github/workflows/updater-installed-acceptance.yml')).split('  dsh-only:')[1].split('  storage-diagnostic:')[0];
  assert.match(workflow,/test\/dsh021-only-ray-20261019/);assert.match(workflow,/foreach \(\$name in @\('b'\)\)/);
  assert.match(workflow,/luckyray-update-verify.exe/);assert.match(workflow,/verify-inputs.mjs/);assert.match(workflow,/-FilePath \$env:B_INSTALLER/);
  assert.match(workflow,/recipient-identity-invalid/);assert.match(workflow,/reviewed-evidence-recipient-required-before-test/);
  assert.match(workflow,/Prepare-ApprovedEphemeralHttps/);assert.match(workflow,/Remove-ApprovedEphemeralHttps/);assert.match(workflow,/ephemeral_trust_approved/);
  assert.match(workflow,/path: D:\/lr-formal-uat\/encrypted\/\*\.encrypted\.json/);
  assert.doesNotMatch(workflow,/spec\.a|1\.9\.8|community-mcp|unchanged-mcp|prepare-fixture\.mjs|recipient-public.pem\n/);
});

test('new observers use corrected native environment and record identity before CDP waits',async()=>{
  for(const name of ['dsh-only.mjs','prepare-dsh-only.mjs','engine-chain.mjs']){
    const source=await read(name);assert.match(source,/env:installedApplicationEnvironment\(process.env,null\)/,name);
  }
  const driver=await read('dsh-only.mjs'),engine=await read('engine-chain.mjs');
  assert.ok(driver.indexOf("event('DSH_only_B_observed_before_cdp'")<driver.indexOf('({browser,page}=await connect());'));
  assert.ok(engine.indexOf("event('engine_product_reopen_observed_before_cdp'")<engine.indexOf('({browser,page}=await connect());'));
  assert.match(driver,/uiVersion:'NOT_YET_VERIFIED'/);
  assert.doesNotMatch(driver,/github.com:443/);
});

test('all DSH-only reconnect transports are tracked before page acquisition and closed on failure',async()=>{
  const source=await read('dsh-only.mjs');
  assert.ok(source.indexOf('cdpConnections.add(browser)')<source.indexOf("const page=await wait('actual installed WebView page'"));
  assert.match(source,/finally\{[\s\S]*for\(const connection of cdpConnections\)await connection.close\(\)/);
});

test('DSH-only updater exit checks real child exit status before automatic reopen evidence',async()=>{
  const driver=await read('dsh-only.mjs'),engine=await read('engine-chain.mjs');
  assert.match(driver,/assert.equal\(BExit.code,0\);assert.equal\(BExit.signal,null\)/);
  assert.match(engine,/context.requireInitialNormalExit\(before.pid\)/);
  assert.match(engine,/assert.equal\(reopenedExit.code,0\);assert.equal\(reopenedExit.signal,null\)/);
});

test('registered workflow routes explicit DSH-only to a separate job without full-chain fallback',async()=>{
  const entry=await read('../../../.github/workflows/updater-installed-acceptance.yml');
  assert.match(entry,/inputs.dsh_only == true && inputs.storage_only != true/);
  const job=entry.split('  dsh-only:')[1].split('  storage-diagnostic:')[0];
  assert.match(job,/environment: dsh-only-ray-20261019/);assert.match(job,/runs-on: windows-2022/);
  assert.match(job,/PRIVATE_TRANSFER_DOWNLOAD_URL: \$\{\{ secrets.DSH_ONLY_TRANSFER_20261019 \}\}/);
  assert.doesNotMatch(job,/uses: \.\/\.github\/workflows|secrets: inherit/);
  assert.equal((entry.match(/inputs.dsh_only != true/g)||[]).length,2);
  assert.doesNotMatch(entry,/dsh-only-installed-acceptance.yml|workflow_call:/);
});

test('actual recipient preflight accepts escaped or literal PEM newlines and rejects private keys or wrong identity',async()=>{
  const workflow=(await read('../../../.github/workflows/updater-installed-acceptance.yml')).split('  dsh-only:')[1].split('  storage-diagnostic:')[0];
  const script=workflow.match(/^\s*node -e "(const c=require\('node:crypto'\).*?)"$/m)?.[1];assert.ok(script);
  const {publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const pem=publicKey.export({type:'spki',format:'pem'});
  const sha=crypto.createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
  const execute=(input,digest=sha)=>{
    const writes=[];
    runInNewContext(script,{process:{env:{EVIDENCE_RECIPIENT_PEM:input,EVIDENCE_RECIPIENT_SHA256:digest}},require:name=>{
      if(name==='node:crypto')return crypto;
      assert.equal(name,'node:fs');return {writeFileSync:(...args)=>writes.push(args)};
    }});
    assert.equal(writes.length,1);assert.equal(writes[0][0],'D:/lr-formal-uat/private/recipient-public.pem');
    assert.equal(writes[0][1],pem);assert.equal(writes[0][2].flag,'wx');
  };
  execute(pem);execute(pem.replaceAll('\n','\\n'));
  assert.throws(()=>execute(pem,'0'.repeat(64)),/recipient-identity-invalid/);
  assert.throws(()=>execute(pem.replace('PUBLIC KEY','PRIVATE KEY')),/public-recipient-only/);
  assert.throws(()=>execute(pem+'PRIVATE KEY'),/public-recipient-only/);
});

test('modal diagnosis observes real dialogs without dismissal and preserves engine failure evidence',async()=>{
  const source=await read('engine-chain.mjs');
  assert.ok(source.indexOf("snap('DSH-only-before-session-click',surface)")<source.indexOf('await row.click();'));
  assert.match(source,/visibleDialogs:dialogs/);
  assert.match(source,/\[role="dialog"\]:visible/);
  assert.match(source,/ENGINE-STOP-/);assert.match(source,/engine_failure_surface_capture/);
  assert.match(source,/captured\.screenshot=true/);assert.match(source,/captured\.dom=true/);
  assert.match(source,/throw error;/);
  assert.doesNotMatch(source,/force:true|\.press\('Escape'\)|\.remove\(|pointer-events:\s*none/);
});

test('observation-only dispatch cannot enter CA or engine steps and only reads actual LSH UI',async()=>{
  const workflow=await read('../../../.github/workflows/updater-installed-acceptance.yml');
  const job=workflow.split('  dsh-only:')[1].split('  storage-diagnostic:')[0];
  assert.match(workflow,/dsh_observe_only:\n\s+type: boolean\n\s+default: false/);
  assert.match(job,/temporary update-file HTTPS trust\n\s+if: inputs.dsh_observe_only != true/);
  assert.match(job,/genuine in-software engine upgrade and preservation\n\s+if: inputs.dsh_observe_only != true/);
  assert.match(job,/DSH_OBSERVE_ONLY: \$\{\{ inputs.dsh_observe_only \}\}/);
  const prepare=await read('prepare-dsh-only.mjs');
  const observe=prepare.split("if(process.env.DSH_OBSERVE_ONLY==='true'){")[1].split("stage='normal_preparation_quit'")[0];
  assert.match(observe,/OBSERVE-LSH-before-session-click/);assert.match(observe,/visibleDialogs:dialogs/);
  assert.doesNotMatch(observe,/\.click\(|\.press\(|\.accept\(|runDshInstalledUpgrade|proxyUrl|Prepare-ApprovedEphemeralHttps/);
  assert.match(prepare,/PASS_DSH_ONLY_SURFACE_OBSERVED_WITHOUT_CA/);
  assert.match(workflow.split('  installed-chain:')[1],/inputs.dsh_observe_only != true/);
  assert.match(prepare,/installedApplicationEnvironment\(process.env,null\)/);
});

const knownNoticeFixtures=[
  {
    "title": "Internal Testing Notice",
    "body": "DeepSeek Harness 0.1 remains in testing for Harness developers. Many areas need further improvement, and we welcome feedback from the developer community. DeepSeek Harness's core plugins and foundational APIs will continue to evolve rapidly over the coming months.\n\nWe look forward to exploring the limits of intelligence with developers around the world, building on open-source, open, reusable, and composable infrastructure. We welcome Harness developers everywhere to join the DSH plugin ecosystem.",
    "button": "Continue"
  },
  {
    "title": "内测声明",
    "body": "DeepSeek Harness 目前的 0.1 版本仍处在面向 Harness 开发者进行测试的阶段，还有许多地方需要持续改进和打磨，希望听取广大开发者的反馈建议。预计 DeepSeek Harness 的核心插件以及基础 API 都会在接下来的一段时间内快速迭代、持续演化。\n\n我们期待与全球开发者一起，在开源、开放、可复用、可组合的基础设施之上，共同探索智能上限。欢迎全球 Harness 开发者加入 DSH 插件生态。",
    "button": "继续"
  }
];

test('only exact official testing notice is continued through its one real UI action',async()=>{
  function surfaceFor(notice,{present=true,text,controls=0,buttons=1,staysVisible=false}={}){
    const state={visible:present,clicks:0,snapshots:[],events:[]};
    const dialog={isVisible:async()=>state.visible,innerText:async()=>text??notice.title+'\n'+notice.body+'\n'+notice.button,
      locator:()=>({count:async()=>controls}),getByRole:(_role,options)=>options?{click:async()=>{assert.equal(options.name,notice.button);assert.equal(options.exact,true);state.clicks++;if(!staysVisible)state.visible=false;}}:{count:async()=>buttons},
      waitFor:async options=>{assert.equal(options.state,'hidden');assert.equal(state.visible,false);}};
    const surface={getByRole:(role,options)=>{assert.equal(role,'dialog');assert.equal(options.exact,true);return options.name===notice.title?dialog:{isVisible:async()=>false};}};
    return {state,surface,hooks:{snap:async name=>state.snapshots.push(name),event:async name=>state.events.push(name)}};
  }
  for(const notice of knownNoticeFixtures){
    const f=surfaceFor(notice);assert.equal(await continueKnownTestingNotice(f.surface,f.hooks),true);
    assert.equal(f.state.clicks,1);assert.deepEqual(f.state.snapshots,['testing-notice-before','testing-notice-after']);
    assert.equal(await continueKnownTestingNotice(f.surface,f.hooks),false);assert.equal(f.state.clicks,1);
    for(const options of [{text:notice.title+' Accept terms Continue'},{controls:1},{buttons:2}]){
      const bad=surfaceFor(notice,options);await assert.rejects(()=>continueKnownTestingNotice(bad.surface,bad.hooks));assert.equal(bad.state.clicks,0);
    }
    const stuck=surfaceFor(notice,{staysVisible:true});await assert.rejects(()=>continueKnownTestingNotice(stuck.surface,stuck.hooks));assert.equal(stuck.state.events.length,0);
    const absent=surfaceFor(notice,{present:false});assert.equal(await continueKnownTestingNotice(absent.surface,absent.hooks),false);assert.equal(absent.state.clicks,0);
  }
  let unknownClicks=0;assert.equal(await continueKnownTestingNotice({getByRole:()=>({isVisible:async()=>false,click:async()=>unknownClicks++})},{snap:async()=>{},event:async()=>{}}),false);assert.equal(unknownClicks,0);
});

test('first-start navigation is exact, idempotent, and never starts credentials or collapses workspace',async()=>{
  const source=await read('engine-chain.mjs');
  const helper=source.split('export async function deferKnownCredentialPrompt')[1].split('export async function seedInstalledMaterial')[0];
  assert.match(helper,/key.inputValue\(\),''/);assert.match(helper,/isDisabled\(\),true/);
  assert.match(helper,/name:prompt.later,exact:true\}\).click/);
  assert.match(helper,/name:prompt.close,exact:true\}\).click/);
  assert.doesNotMatch(helper,/\.fill\(|name:prompt.(save|signIn|key),exact:true\}\).click/);
  assert.match(helper,/expanded==='false'\)\{await workspace.click/);
  assert.match(helper,/workspace:installed-upgrade/);assert.match(helper,/Open sidebar/);
  assert.match(helper,/Unrecognized dialog; no automatic action permitted/);
  assert.match(source,/const row=await revealOldSession\(surface,oldFixture,\{snap,event\}\)/);
});


test('restart observer accepts exact emitted confirmation but never requires a browser dialog',async()=>{
  for(const mode of ['no-dialog','known-dialog','unknown-dialog','exit-failed']){
    let listener,accepted=0,observed=0,removed=0;const events=[];
    const dialog={type:()=> 'confirm',message:()=>mode==='unknown-dialog'?'Accept unrelated terms':'LuckyRay will quit normally and reopen automatically to finish the engine switch. Save changes on other pages first. Restart now?',accept:async()=>{accepted++;}};
    const page={on:(name,fn)=>{assert.equal(name,'dialog');listener=fn;},off:(name,fn)=>{assert.equal(fn,listener);removed++;},getByRole:(role,options)=>({click:async()=>{
      assert.equal(role,'button');assert.match('Restart LuckyRay and finish update',options.name);
      if(mode.includes('dialog')&&mode!=='no-dialog')listener(dialog);
      await Promise.resolve();await Promise.resolve();
    }})};
    const run=()=>clickEngineRestart(page,{canRestart:true,event:async(_name,data)=>events.push(data),observeExit:async()=>{observed++;if(mode==='exit-failed')throw Error('nonzero exit');}});
    if(mode==='unknown-dialog'||mode==='exit-failed'){await assert.rejects(run);assert.equal(events.length,0);assert.equal(accepted,0);}
    else {await run();assert.equal(observed,1);assert.equal(accepted,mode==='known-dialog'?1:0);assert.equal(events[0].browserConfirmationCount,accepted);}
    assert.equal(removed,1);
  }
});

test('automatic reopen opens actual old session before frozen coordinator health verification',async()=>{
  const source=await read('engine-chain.mjs');
  const reopen=source.split("engine_product_reopen_observed_before_cdp")[1];
  assert.ok(reopen.indexOf('surface=await lshPage();await oldSession(surface)')<reopen.indexOf("pending engine local health check"));
  assert.match(reopen,/new engine session open before health check/);
  assert.doesNotMatch(source,/waitForEvent\('dialog'/);
});
