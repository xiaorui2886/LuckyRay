const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', {paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium} = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
  const built = await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React,{useMemo,useState} from 'react';import{createRoot}from'react-dom/client';
import{useVaultAttachmentResolution}from'./src/features/notes/useVaultAttachmentResolution';
import{activateKnowledgeWritesForVault}from'./src/core/services/knowledgeSource';
activateKnowledgeWritesForVault({mode:'real-vault',vaultId:'v',rootPath:'C:/v'});
window.calls=[];window.failure=false;window.missing=false;window.pending=[];window.defer=false;
window.invoke=async(command,args)=>{if(command!=='knowledge_resolve_attachment')throw Error(command);window.calls.push(args);
 if(window.defer)await new Promise(r=>window.pending.push(r));if(window.failure)throw Error('附件暂时不可读');
 return {status:window.missing?'missing':'resolved',candidates:window.missing?[]:['image.png'],relativePath:'image.png',absolutePath:'C:/v/image.png',version:String(window.version||1)};};
function Fixture(){const [tick,setTick]=useState(0),[generation,setGeneration]=useState(0),[recheck,setRecheck]=useState(0),[vaultId,setVaultId]=useState('v');
 const [matches,setMatches]=useState({}),[error,setError]=useState('');
 const vault=useMemo(()=>({id:vaultId,rootPath:'C:/'+vaultId}),[tick,vaultId]);
 const lookups=useMemo(()=>[{key:'image',noteRelativePath:'a.md',target:'image.png',wiki:false},{key:'image',noteRelativePath:'a.md',target:'image.png',wiki:false}],[tick]);
 const batch=useMemo(()=>generation?{vaultId,rootPath:'C:/'+vaultId,session:1,generation,observations:[{type:{modify:{kind:'any'}},paths:['C:/'+vaultId+'/'+(window.changedPath||'a.md')]}],reconcileRequired:false}:null,[generation,vaultId]);
 window.bump=()=>setTick(t=>t+1);window.changed=()=>setGeneration(t=>t+1);window.retry=()=>setRecheck(t=>t+1);
 window.switchVault=()=>{activateKnowledgeWritesForVault({mode:'real-vault',vaultId:'b',rootPath:'C:/b'});setVaultId('b');};
 useVaultAttachmentResolution({vault,lookups,batch,recheck,setMatches,setError});window.result={matches,error};return <div>{error}</div>;
}createRoot(document.getElementById('root')).render(<Fixture/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',plugins:[{name:'native-port',setup(b){b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'native',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const invoke=(...args)=>window.invoke(...args);export const convertFileSrc=p=>p;'}));}}]});
  const server=http.createServer((q,r)=>{r.setHeader('content-type',q.url==='/app.js'?'text/javascript':'text/html');r.end(q.url==='/app.js'?built.outputFiles[0].text:'<meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});
  try{const page=await browser.newPage();page.on('pageerror',e=>console.error(e));await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>window.result?.matches.image);
    assert.equal(await page.evaluate(()=>window.calls.length),1,'duplicate references share one lookup');
    for(let i=0;i<30;i++){await page.evaluate(()=>window.bump());await page.evaluate(()=>new Promise(requestAnimationFrame));}
    for(let i=0;i<5;i++){await page.evaluate(()=>window.changed());await page.evaluate(()=>new Promise(requestAnimationFrame));}
    assert.equal(await page.evaluate(()=>window.calls.length),1,'text/index object refreshes and Markdown save echoes do not resolve unchanged targets');
    await page.evaluate(()=>{window.changedPath='image.png';window.missing=true;window.changed();});
    await page.waitForFunction(()=>window.result.matches.image?.length===0);
    await page.evaluate(()=>{window.missing=false;window.version=2;window.changed();});
    await page.waitForFunction(()=>window.result.matches.image?.[0]?.version.startsWith('2'));
    await page.evaluate(()=>{window.failure=true;window.retry();});await page.waitForFunction(()=>window.result.error);
    const calls=await page.evaluate(()=>window.calls.length);await page.evaluate(()=>window.bump());await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await page.evaluate(()=>window.calls.length),calls,'ordinary typing does not clear/retry a stable failure');
    assert.ok(await page.evaluate(()=>window.result.error));assert.ok(await page.evaluate(()=>window.result.matches.image.length),'transient read failure retains last success');
    await page.evaluate(()=>{window.failure=false;window.defer=true;window.retry();});await page.waitForFunction(()=>window.pending.length===1);
    await page.evaluate(()=>window.switchVault());await page.waitForFunction(()=>window.pending.length===2);
    await page.evaluate(()=>window.pending.shift()());await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.deepEqual(await page.evaluate(()=>window.result.matches),{},'stale old-vault result cannot populate new source');
    await page.evaluate(()=>{window.defer=false;window.pending.shift()();});await page.waitForFunction(()=>window.result.matches.image?.length);
    console.log('PASS: dedup, 30 input/index refreshes, 5 save echoes, missing/recovery, stable error/retry, late Vault response');
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
