import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as crypto from 'node:crypto';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
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
test('separate workflow verifies B only, retains signature and encrypted evidence gates',async()=>{
  const workflow=await read('../../../.github/workflows/dsh-only-installed-acceptance.yml');
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
  assert.match(entry,/uses: .\/.github\/workflows\/dsh-only-installed-acceptance.yml/);
  assert.equal((entry.match(/inputs.dsh_only != true/g)||[]).length,2);
  assert.match(await read('../../../.github/workflows/dsh-only-installed-acceptance.yml'),/workflow_call:/);
});

test('actual recipient preflight accepts escaped or literal PEM newlines and rejects private keys or wrong identity',async()=>{
  const workflow=await read('../../../.github/workflows/dsh-only-installed-acceptance.yml');
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
