const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const tools=process.env.LR_TEST_TOOLS?createRequire(path.join(process.env.LR_TEST_TOOLS,'package.json')):require;
const {JSDOM}=tools('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://synthetic.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{createRoot}=require('react-dom/client');
const repo=path.resolve(__dirname,'..'),file=path.join(repo,'src/features/materials/MaterialFilePreview.tsx');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(path.join(repo,'node_modules/vite'))]}));
const source=fs.readFileSync(file,'utf8').replace('import { useMaterialViewScope } from "./MaterialViewContext";','const useMaterialViewScope = () => globalThis.__previewScope;').replace('import "./materialFilePreview.css";','');
const built=esbuild.buildSync({stdin:{contents:source,resolveDir:path.dirname(file),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
const pending=[],calls=[];const invoke=(command,args)=>new Promise((resolve,reject)=>{calls.push({command,args});pending.push({resolve,reject,args});});
const loaded={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,id=>id==='@tauri-apps/api/core'?{invoke}:require(id));
const {MaterialFilePreview,materialFileFormat}=loaded.exports;
const asset=(id,name='notes.txt')=>({id,name,kind:'document',updatedAt:'rev1',importedAt:'old',sizeBytes:65});
async function settle(value){const p=pending.shift();assert.ok(p);await React.act(async()=>p.resolve(value));}
async function flush(){await React.act(async()=>{await Promise.resolve();});}
test('actual file preview text/detail, original action, identity, fallback and bounded shared requests',async()=>{
 global.__previewScope={libraryId:'one',visible:true};let opened=0,doubled=0;const a=asset('text');const unchanged=JSON.stringify(a);const root=createRoot(document.getElementById('root'));
 const render=async(props)=>React.act(async()=>root.render(React.createElement('div',{onDoubleClick:()=>doubled++},React.createElement(MaterialFilePreview,props))));
 try{
  await render({asset:a,variant:'detail',onOpen:()=>opened++});assert.equal(calls[0].args.detail,true);assert.equal(calls[0].args.libraryId,'one');
  await settle({kind:'text',text:'<script>never execute</script>\n完整短文本',truncated:false});assert.equal(document.querySelector('script'),null);assert.match(document.querySelector('pre').textContent,/完整短文本/);assert.equal(document.querySelector('.material-file-preview-note'),null);
  await React.act(async()=>document.querySelector('pre').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));assert.equal(doubled,0);
  await React.act(async()=>document.querySelector('button').click());assert.equal(opened,1);assert.equal(JSON.stringify(a),unchanged);
  await render({asset:a,variant:'detail'});assert.equal(calls.length,1,'equivalent re-render uses result, not repeated IO');
  global.__previewScope={libraryId:'two',visible:true};await render({asset:a,variant:'detail'});assert.equal(document.querySelector('pre'),null,'old library text not displayed');assert.equal(calls.length,2);
  await settle({kind:'text',text:'new library text',truncated:true});assert.match(document.querySelector('.material-file-preview-note').textContent,/64 KB/);
  await render({asset:asset('unsupported','bundle.zip'),variant:'detail',onOpen:()=>opened++});await settle(null);assert.equal(document.querySelector('.material-file-format').textContent,'ZIP');assert.match(document.body.textContent,/没有可用预览/);
  await render({asset:asset('cover','slides.pptx'),variant:'grid'});await settle({kind:'image',previewUri:'data:image/png;base64,synthetic',truncated:false});assert.equal(document.querySelector('img').getAttribute('src'),'data:image/png;base64,synthetic');
  const prior=calls.length;await React.act(async()=>root.render(React.createElement(React.Fragment,null,...Array.from({length:5},(_,i)=>React.createElement(MaterialFilePreview,{key:i,asset:asset('queue'+i),variant:'card'})))));assert.equal(calls.length-prior,2,'only two native extraction jobs active');
  for(let i=0;i<5;i++)await settle(null);await flush();assert.equal(calls.length-prior,5);
  const repeated=calls.length;await React.act(async()=>root.render(React.createElement(MaterialFilePreview,{asset:asset('queue0'),variant:'list'})));assert.equal(calls.length,repeated,'unavailable cached for same revision, no retry storm');
  global.__previewScope={libraryId:'two',visible:false};await render({asset:asset('hidden'),variant:'detail'});assert.equal(calls.length,repeated,'hidden view starts no read');
  global.__previewScope=null;
  await render({asset:asset('explicit'),variant:'detail',libraryId:'selected-normal-library'});assert.equal(calls.at(-1).args.libraryId,'selected-normal-library');await settle(null);
  await render({asset:asset('attachment'),variant:'detail',vaultId:'vault-1'});assert.equal(calls.at(-1).args.libraryId,null);assert.equal(calls.at(-1).args.vaultId,'vault-1');await settle(null);
  await render({asset:asset('transient'),variant:'detail'});let failing=pending.shift();await React.act(async()=>failing.reject(Error('temporary')));assert.match(document.body.textContent,/读取失败/);const beforeRetry=calls.length;await React.act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='重试预览').click());assert.equal(calls.length,beforeRetry+1);await settle({kind:'text',text:'recovered',truncated:false});assert.match(document.body.textContent,/recovered/);
  const beforeStale=calls.length;await React.act(async()=>root.render(React.createElement(React.Fragment,null,...Array.from({length:5},(_,i)=>React.createElement(MaterialFilePreview,{key:i,asset:asset('retired'+i),variant:'card'})))));assert.equal(calls.length,beforeStale+2);
  await render({asset:asset('current-detail'),variant:'detail'});await settle(null);await settle(null);await settle(null);assert.equal(calls.length,beforeStale+3,'retired queued cards never reach native');

  assert.equal(materialFileFormat(asset('a','README')),'文档');assert.equal(materialFileFormat(asset('a','中文.PDF')),'PDF');
 }finally{await React.act(async()=>root.unmount());}
});
test('production page wires all three layouts and details without changing originals',()=>{
 const page=fs.readFileSync(path.join(repo,'src/features/materials/MaterialsPage.tsx'),'utf8');
 assert.match(page,/<MaterialFilePreview asset=\{asset\} libraryId=\{previewLibraryId\}/);for(const variant of ['grid','list','detail','cover'])assert.match(page,new RegExp(`MaterialFilePreview asset=\\{asset\\} variant="${variant}"`));
 assert.match(page,/onOpen=\{\(\) => onOpenOriginal\(asset\)\}/);assert.match(page,/<audio[\s\S]*?src=\{videoPreviewUrl \|\| undefined\}/);
 assert.match(page,/materials\.detail\.format[\s\S]{0,200}materialFileFormat\(asset\)/);
 assert.match(page,/previewVaultId: attachmentCollection \? attachmentVaultId/);
 const css=fs.readFileSync(path.join(repo,'src/features/materials/materialFilePreview.css'),'utf8');assert.match(css,/material-file-preview--detail\{pointer-events:auto/);
});
