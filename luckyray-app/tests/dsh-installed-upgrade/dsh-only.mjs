import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,stat} from 'node:fs/promises';
import {createReadStream,existsSync} from 'node:fs';
import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {runDshInstalledUpgrade} from './engine-chain.mjs';
import {installedApplicationEnvironment} from './runner-environment.mjs';
import {installedPaths} from './installed-paths.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.GITHUB_REPOSITORY!=='xiaorui2886/LuckyRay')throw Error('disposable-public-runner-only');
const run=promisify(execFile), root='D:\\lr-formal-uat';
const paths=installedPaths(JSON.parse((await readFile(join(root,'private/paths.json'),'utf8')).replace(/^\uFEFF/,'')));
const tls=JSON.parse((await readFile(paths.tls,'utf8')).replace(/^\uFEFF/,''));
const spec=JSON.parse(await readFile(process.env.UPGRADE_SPEC,'utf8'));
const fixture=JSON.parse(await readFile(join(root,'private/dsh-only-fixture.json'),'utf8'));
assert.equal(spec.b.version,'1.9.9');assert.equal(spec.engine.fromVersion,'0.1.7-rc.2');
assert.equal(spec.reviewedPrivateTransfer,true);
assert.equal(fixture.schema,1);assert.equal(fixture.evidenceMode,'dsh-only');
assert.equal(fixture.preparedWithVersion,spec.b.version);assert.equal(fixture.preparedExeSha256,spec.b.installedExeSha256);
assert.equal(fixture.profile,paths.profile);assert.equal(fixture.install,paths.install);
assert.equal(fixture.preparationExit.code,0);assert.equal(fixture.preparationExit.signal,null);
const {oldFixture,materialFixture,base,reference,notePath,settingsBefore}=fixture;
const evidence=join(root,'evidence'), trace=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
const event=async(kind,value={})=>{const row={atUtc:new Date().toISOString(),kind,...value};trace.push(row);await appendFile(join(evidence,'timeline.jsonl'),JSON.stringify(row)+'\n');};
const requireCdpOwner=async expectedPid=>{
  assert.ok(Number.isSafeInteger(expectedPid));
  const script="$owners=@(Get-NetTCPConnection -LocalPort 9391 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); if($owners.Count -ne 1){throw 'cdp-owner-not-unique'}; $chain=@(); $lrProbePid=$owners[0]; for($i=0;$i -lt 8 -and $lrProbePid -gt 0;$i++){ $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$lrProbePid\"; if(-not $p){break};$chain+=[int]$p.ProcessId;$lrProbePid=[int]$p.ParentProcessId }; @{listenerPid=$owners[0];parentChain=$chain}|ConvertTo-Json -Compress";
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:installedApplicationEnvironment(process.env,null),windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:32768});
  const owner=JSON.parse(stdout);assert.ok(owner.parentChain.includes(expectedPid),'CDP must belong to this actual installed process');
  await event('actual_cdp_owner',{expectedAppPid:expectedPid,...owner});
};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(label,fn,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await delay(300);}throw Error(label+' timed out');};
const installerFile=resolve(process.env.B_INSTALLER);
assert.equal(hash(await readFile(installerFile)),spec.b.sha256);
const dshPaths=new Map();
for(const input of spec.engine.replayFiles){
  const url=new URL(input.url);
  assert.ok(['raw.githubusercontent.com','registry.npmjs.org','nodejs.org'].includes(url.hostname));
  assert.equal(url.protocol,'https:');assert.equal(url.search,'');
  const file=join(root,'private/input',input.file);
  assert.equal(hash(await readFile(file)),input.sha256);
  assert.equal((await stat(file)).size,input.bytes);
  assert.equal(dshPaths.has(url.href),false);dshPaths.set(url.href,{...input,file});
}
const replay=httpsServer({pfx:await readFile(tls.pfx),passphrase:tls.password},async(req,res)=>{
  // No header/cookie/token is logged. Only exact public protocol paths are served.
  if(req.method!=='GET'||req.headers.authorization||req.headers.cookie){res.writeHead(502);res.end();return;}
  const url=new URL(req.url,'https://'+req.headers.host);
  const engine=dshPaths.get(url.href);
  if(engine){
    await event('approved_engine_input',{sha256:engine.sha256,bytes:engine.bytes});
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':engine.bytes});createReadStream(engine.file).pipe(res);return;
  }
  res.writeHead(502);res.end();
});
const proxy=httpServer((_req,res)=>{res.writeHead(502);res.end();});
const replayTunnels=new Set();
proxy.on('connect',(req,socket,head)=>{
  if(!['raw.githubusercontent.com:443','registry.npmjs.org:443','nodejs.org:443'].includes(req.url)){socket.end('HTTP/1.1 502 Denied\r\n\r\n');return;}
  replayTunnels.add(socket);socket.once('close',()=>replayTunnels.delete(socket));
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if(head.length)socket.unshift(head);
  replay.emit('connection',socket);
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const proxyUrl='http://127.0.0.1:'+proxy.address().port;
const {chromium}=await import(pathToFileURL(join(process.env.UI_TOOLS,'node_modules/playwright-core/index.mjs')));
const installedEnvironment=installedApplicationEnvironment(process.env,proxyUrl);
const B=spawn(join(paths.install,'luckyray-app.exe'),[],{cwd:paths.install,windowsHide:false,env:installedEnvironment});
B.stdout.resume(); // Drain without logging; never let an unconsumed pipe block normal exit.
const native=[];
B.stderr.setEncoding('utf8');B.stderr.on('data',chunk=>{
  for(const line of chunk.split(/\r?\n/))if(/^\[(dsh-update-exit|workspace)\]/.test(line)&&!/(token|key|credential|secret)/i.test(line))native.push({atUtc:new Date().toISOString(),line});
});
let BExit;
B.on('exit',(code,signal)=>{BExit={atUtc:new Date().toISOString(),code,signal};void event('B_process_exit',BExit);});
const cdpConnections=new Set();
const connect=async()=>{
  await wait('CDP endpoint',async()=>{try{const r=await fetch('http://127.0.0.1:9391/json/version');return r.ok;}catch{return false;}});
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9391');
  cdpConnections.add(browser); // Includes partial connects and every engine/draft reopen.
  const page=await wait('actual installed WebView page',async()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost|^tauri:\/\//.test(p.url())));
  await page.waitForFunction(()=>Boolean(window.__TAURI__?.core?.invoke));
  return {browser,page};
};
let browser,page,stage='DSH_only_B_start';
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
try{
  const identityScript=`[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Get-CimInstance Win32_Process -Filter "ProcessId=${B.pid}" | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;exe=$_.ExecutablePath} } | ConvertTo-Json -Compress`;
  const observed=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',identityScript],{env:installedApplicationEnvironment(process.env,null),windowsHide:true,encoding:'utf8',timeout:15000})).stdout);
  assert.equal(observed.pid,B.pid);assert.equal(observed.exe.toLowerCase(),join(paths.install,'luckyray-app.exe').toLowerCase());
  await event('DSH_only_B_observed_before_cdp',{...observed,exeSha256:hash(await readFile(observed.exe)),installMarker:(await readFile(join(paths.install,'luckyray-install-complete.txt'),'utf8')).trim(),expectedHostVersion:spec.b.version,uiVersion:'NOT_YET_VERIFIED'});
  ({browser,page}=await connect());await requireCdpOwner(B.pid);
  assert.equal(hash(await readFile(join(paths.install,'luckyray-app.exe'))),spec.b.installedExeSha256);
  assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),spec.b.version);
  assert.equal((await readFile(join(paths.install,'luckyray-install-complete.txt'),'utf8')).trim(),'com.luckyray.desktop|'+spec.b.version);
  assert.equal(existsSync(join(paths.install,'luckyray-install-in-progress.txt')),false);
  const note=await invoke('knowledge_read_document',{documentRef:reference});assert.equal(note.content,base);assert.deepEqual(note.documentRef,reference);
  await event('DSH_only_direct_B_start',{pid:B.pid,version:spec.b.version,exeSha256:spec.b.installedExeSha256,desktopAtoB:'NOT_RUN'});
  stage='B_engine_upgrade';
  const requireInitialNormalExit=async pid=>{assert.equal(pid,B.pid);await wait('B normal updater exit result',()=>BExit);assert.equal(BExit.code,0);assert.equal(BExit.signal,null);await event('B_normal_updater_exit_verified',BExit);};
  const engineResult=await runDshInstalledUpgrade({evidenceMode:'dsh-only',requireInitialNormalExit,root,paths,spec,event,oldFixture,materialFixture,browser,page,connect,requireCdpOwner,settingsBefore,notePath,documentRef:reference,expected:base,installedEnvironment});
  await writeFile(join(evidence,'RESULT.json'),JSON.stringify({status:'PASS_DSH_ONLY_INSTALLED_ENGINE_UPGRADE',engineResult,testSourceSha:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,desktopAtoB:'NOT_RUN',communityMcpAuthorization:'NOT_APPLICABLE_TO_DSH_ONLY',productionFeedAvailability:'NOT_RUN: approved exact-URL HTTPS replay',realIME:'NOT_RUN',externalWebTunnel:'NOT_RUN'},null,2)+'\n');
}catch(error){
  await event('stopped',{stage,error:error.message});
  await writeFile(join(evidence,'RESULT.json'),JSON.stringify({status:'FAIL_OR_BLOCKED_DSH_ONLY',stage,error:error.message,BPid:B.pid,BExit,trace,desktopAtoB:'NOT_RUN',communityMcpAuthorization:'NOT_APPLICABLE_TO_DSH_ONLY',noForcedTermination:true},null,2)+'\n');process.exitCode=1;
}finally{
  await writeFile(join(evidence,'native-quit-lines.json'),JSON.stringify(native,null,2)+'\n');
  for(const connection of cdpConnections)await connection.close().catch(()=>{}); // Disconnect only; never terminate an app.
  B.stdout.unref?.();B.stderr.unref?.();B.unref();
  for(const socket of replayTunnels)socket.destroy();
  proxy.closeAllConnections();proxy.close();replay.closeAllConnections();replay.close();
}
