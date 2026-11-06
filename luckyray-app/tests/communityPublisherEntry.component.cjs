// Real CommunityPage in a local headless browser; package store and dialogs are synthetic.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', {paths:[fs.realpathSync(path.join(root,'node_modules/vite'))]}));
const {chromium} = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-publisher-entry-'));
const fixture = `
import {createRoot} from 'react-dom/client';
import CommunityPage from './src/features/community/CommunityPage';
import {I18nProvider} from './src/core/i18n/index';
import {ApplicationModalIsolationProvider,createApplicationModalIsolationStore} from './src/app/applicationModalIsolation';
import './src/core/theme/themeTokens.css';
import './src/app/appShell.css';
window.registry={revision:1,hostVersion:'1.9.8',packages:[]};
window.dialogs=[];window.writes=[];window.failures=[];window.decision='Cancel';window.advanceDuringConfirm=false;
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
 if(command==='plugin:dialog|message'){
  window.dialogs.push(args.message);
  if(window.advanceDuringConfirm){window.registry.revision++;window.advanceDuringConfirm=false;}
  return window.decision;
 }
 if(command==='manage_extension_packages'){
  const r=JSON.parse(args.request);if(r.op==='list')return structuredClone(window.registry);
  try{
   if(r.expectedRevision!==window.registry.revision)throw Error('extension-revision-conflict');
   const prior=window.registry.packages.find(e=>e.package.manifest.id===r.package.manifest.id);
   const candidate=r.package.signature?.publicKey;
   if((prior && !(prior.trustedPublisher && prior.trustedPublisher===candidate) || !prior && candidate) && !r.publisherApproved)throw Error('extension-publisher-approval-required');
   window.writes.push({op:r.op,approved:r.publisherApproved,id:r.package.manifest.id,version:r.package.manifest.version});
   const entry={package:r.package,enabled:false,grants:[],digest:r.package.manifest.version,epoch:window.registry.revision+1,trustedPublisher:candidate};
   window.registry.packages=window.registry.packages.filter(e=>e.package.manifest.id!==r.package.manifest.id).concat(entry);window.registry.revision++;
   return structuredClone(window.registry);
  }catch(e){window.failures.push(String(e));throw e;}
 }
 if(command==='get_local_transport_client_config')return {baseUrl:'http://127.0.0.1:1',credential:'',protocolVersion:1};
 if(command==='get_collection_server_base_url')return 'http://127.0.0.1:1';
 if(command==='knowledge_get_current_context')return null;
 throw Error('synthetic-only command '+command);
}};
window.fetch=async()=>new Response(JSON.stringify({capabilities:[]}),{status:200,headers:{'Content-Type':'application/json'}});
location.hash='#community?tab=extensions';
createRoot(document.getElementById('root')).render(<I18nProvider locale='zh-CN'><ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><CommunityPage/></ApplicationModalIsolationProvider></I18nProvider>);
`;
function pkg(id,version,key){return {manifest:{schemaVersion:2,apiVersion:2,type:'desktop',entry:'main.js',id,name:'Synthetic publisher',version,minHostVersion:'1.9.8',requiredModules:['workspace'],optionalModules:[]},resource:{code:'export function activate() {}',css:'',assets:{},dataVersion:1,contributions:[]},...(key?{signature:{version:1,publicKey:key,signature:'synthetic-proof'}}:{})};}
(async()=>{
 await esbuild.build({stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.svg':'dataurl','.png':'dataurl','.woff':'dataurl','.woff2':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},outfile:path.join(out,'app.js'),logLevel:'silent'});
 const server=http.createServer((req,res)=>{if(req.url==='/app.js'||req.url==='/app.css'){res.setHeader('Content-Type',req.url.endsWith('css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(out,req.url.slice(1))));}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage();
 const origin='http://127.0.0.1:'+server.address().port;
 await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
 const upload=async value=>{await page.getByLabel('安装本地扩展',{exact:true}).setInputFiles({name:'synthetic.lrpack.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});};
 try{
  await page.goto(origin);await page.getByLabel('安装本地扩展',{exact:true}).waitFor();
  await upload(pkg('test.signed','1.0.0','synthetic-key-a'));
  await page.waitForFunction(()=>window.dialogs.length+window.failures.length>0);
  assert.equal(await page.evaluate(()=>window.dialogs.length),1,'signed install must ask before backend mutation');
  assert.equal(await page.evaluate(()=>window.writes.length),0,'cancelled install must not write');
  await page.evaluate(()=>window.decision='Ok');await upload(pkg('test.signed','1.0.0','synthetic-key-a'));
  await page.waitForFunction(()=>window.writes.length===1);
  assert.equal(await page.evaluate(()=>window.writes[0].approved),true);
  const dialogs=await page.evaluate(()=>window.dialogs.length);
  await upload(pkg('test.signed','1.0.1','synthetic-key-a'));await page.waitForFunction(()=>window.writes.length===2);
  assert.equal(await page.evaluate(()=>window.dialogs.length),dialogs,'continuous publisher must not prompt again');
  await page.evaluate(()=>window.decision='Cancel');await upload(pkg('test.signed','1.0.2','synthetic-key-b'));await page.waitForFunction(n=>window.dialogs.length>n,dialogs);
  assert.match(await page.evaluate(()=>window.dialogs.at(-1)),/脚本或完整扩展/);
  assert.equal(await page.evaluate(()=>window.writes.length),2,'cancelled changed identity must not write');
  await page.evaluate(()=>window.decision='Ok');await upload(pkg('test.signed','1.0.2','synthetic-key-b'));await page.waitForFunction(()=>window.writes.length===3);
  assert.equal(await page.evaluate(()=>window.writes[2].approved),true);
  await upload(pkg('test.legacy','1.0.0',null));await page.waitForFunction(()=>window.writes.length===4);
  await page.evaluate(()=>window.decision='Cancel');const before=await page.evaluate(()=>window.dialogs.length);
  await upload(pkg('test.legacy','1.0.1',null));await page.waitForFunction(n=>window.dialogs.length>n,before);
  assert.equal(await page.evaluate(()=>window.writes.length),4,'cancelled unsigned update must not write');
  await page.evaluate(()=>{window.decision='Ok';window.advanceDuringConfirm=true;});
  await upload(pkg('test.legacy','1.0.1',null));await page.waitForFunction(()=>window.failures.some(x=>x.includes('revision-conflict')));
  assert.equal(await page.evaluate(()=>window.writes.length),4,'revision change during confirmation must not write');
  await upload(pkg('test.legacy','1.0.1',null));await page.waitForFunction(()=>window.writes.length===5);
  assert.equal(await page.evaluate(()=>window.writes[4].approved),true,'explicitly approved legacy update must proceed');
  assert.equal(await page.evaluate(()=>window.registry.packages.find(e=>e.package.manifest.id==='test.legacy').enabled),false);
  console.log('PASS community entry: signed install, continuity, changed identity, legacy cancel and revision conflict');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
