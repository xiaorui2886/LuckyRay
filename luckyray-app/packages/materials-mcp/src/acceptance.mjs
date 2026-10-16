#!/usr/bin/env node
// This runner talks to the installed server over real stdio. Desktop operations are never mocked.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
const config=process.argv.includes('--config')?arg('--config'):null;
const report={mode:process.argv.includes('--import-fixtures')?'REAL_IMPORT':process.argv.includes('--expect-revoked')?'EXPECT_REVOKED':'READ_ONLY',steps:[],pass:false};
let child;
try{
 if(!config)throw Error('configuration-required');
 child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url)),'--config',config],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let next=0,stderrSeen=false;const pending=new Map();
 child.stderr.on('data',()=>{stderrSeen=true;});
 createInterface({input:child.stdout}).on('line',line=>{try{const value=JSON.parse(line),p=pending.get(value.id);if(p){pending.delete(value.id);clearTimeout(p.timer);p.resolve(value);}}catch{}});
 child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(stderrSeen?'client-startup-failed':'client-exited'));}pending.clear();});
 child.on('error',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('client-startup-failed'));}pending.clear();});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('acceptance-timeout'));},150000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const call=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});if(r.error)throw Error('rpc-failed');if(r.result?.isError){const code=r.result.content?.[0]?.text;throw Error(/^[a-z-]{1,80}$/.test(code)?code:'tool-failed');}return r.result?.structuredContent;};
 await rpc('initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'LuckyRay local acceptance',version:'0.1.0-candidate.4'},capabilities:{}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 if(report.mode==='EXPECT_REVOKED'){
  try{await call('connection_status');throw Error('revocation-not-effective');}catch(e){if(e.message!=='not-authorized')throw e;report.steps.push({step:'fresh-stdio-after-revoke',result:'DENIED'});}
 }else{
  const status=await call('connection_status');report.steps.push({step:'paired-stdio',result:'PASS',pid:status.pid,port:status.port,libraryId:status.libraryId,expiresAt:status.expiresAt});
  await call('search_assets',{query:'MCP-UAT-',limit:10});report.steps.push({step:'search',result:'PASS'});
  await call('list_folders');report.steps.push({step:'folders',result:'PASS'});
  if(report.mode==='REAL_IMPORT'){
   const fixtures=JSON.parse(await readFile(new URL('../examples/acceptance-fixtures.json',import.meta.url),'utf8'));
   for(const fixture of fixtures){
    const first=await call('import_file',{url:fixture.url,fileName:fixture.fileName});
    const inspected=await call('get_asset',{assetId:first.assetId});
    const search=await call('search_assets',{query:fixture.fileName,limit:50});
    const duplicate=await call('import_file',{url:fixture.url,fileName:fixture.fileName});
    if(first.libraryId!==status.libraryId||first.assetName!==fixture.fileName||inspected.name!==fixture.fileName||!fixture.allowedKinds.includes(first.kind)||inspected.kind!==first.kind||!search.assets.some(a=>a.assetId===first.assetId)||duplicate.assetId!==first.assetId||duplicate.disposition!=='duplicate')throw Error('import-acceptance-mismatch');
    report.steps.push({step:fixture.fileName,result:'PASS',assetId:first.assetId,assetName:first.assetName,kind:first.kind,libraryId:first.libraryId,bytes:first.sizeBytes,duplicateSameAssetId:true});
   }
  }
 }
 report.pass=true;
}catch(e){report.failureCode=/^[a-z-]{1,80}$/.test(e.message)?e.message:'acceptance-failed';process.exitCode=1;}
finally{child?.stdin.end();if(child&&!child.killed){const timer=setTimeout(()=>child.kill(),3000);timer.unref();child.on('exit',()=>clearTimeout(timer));}}
report.completedUtc=new Date().toISOString();
if(process.argv.includes('--report')){try{await writeFile(arg('--report'),JSON.stringify(report,null,2),{flag:'wx'});}catch{process.stderr.write('report-not-written-existing-or-unavailable\n');process.exitCode=1;}}
process.stdout.write(JSON.stringify(report,null,2)+'\n');
