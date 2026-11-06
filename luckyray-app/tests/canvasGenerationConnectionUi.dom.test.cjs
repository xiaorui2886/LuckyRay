// Synthetic jsdom component tests. No native bridge, browser or provider calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const tools=process.env.LR_TEST_TOOLS?createRequire(path.join(process.env.LR_TEST_TOOLS,'package.json')):require;
const {JSDOM}=tools('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://synthetic.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{createRoot}=require('react-dom/client');
const repo=path.resolve(__dirname,'..'),file=path.join(repo,'src/features/canvas/CanvasMediaProfilesPanel.tsx');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(path.join(repo,'node_modules/vite'))]}));
// Locale seam only; real panel, real client serialization and preset data are bundled.
const source=fs.readFileSync(file,'utf8').replace('import { useI18n } from "../../core/i18n/index";','const useI18n = () => ({locale: globalThis.__testLocale || "en-US"});');
const built=esbuild.buildSync({stdin:{contents:source,resolveDir:path.dirname(file),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
Object.defineProperty(global,'localStorage',{value:window.localStorage,configurable:true});
const calls=[];
const invoke=async(command,args)=>{calls.push({command,args});if(command==='canvas_comfyui_get_config')return{baseUrl:'http://127.0.0.1:8188'};throw Error(`unexpected command ${command}`);};
const loaded={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,id=>id==='@tauri-apps/api/core'?{invoke}:require(id));
const button=text=>[...document.querySelectorAll('button')].find(e=>e.textContent===text);
const click=async e=>{assert.ok(e);await React.act(async()=>e.click());};
async function edit(e,value){await React.act(async()=>{const proto=e.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
async function mount(){calls.length=0;const root=createRoot(document.getElementById('root'));await React.act(async()=>root.render(React.createElement(loaded.exports.CanvasMediaProfilesPanel,{snapshot:null,onChange(){}})));return root;}
async function dispose(root){const cancel=button('Cancel');if(cancel&&!cancel.disabled)await click(cancel);await React.act(async()=>root.unmount());}

test('DOM: Agent Plan exposes exact editable IDs and never model discovery or text proxy',async()=>{
 const root=await mount();await click(button('Add connection'));
 const preset=[...document.querySelectorAll('select')].find(e=>[...e.options].some(o=>o.value==='arkPlan'));await edit(preset,'arkPlan');
 assert.ok([...document.querySelectorAll('input')].some(e=>e.value==='https://ark.cn-beijing.volces.com/api/plan/v3'));
 assert.equal([...document.querySelectorAll('button')].filter(e=>e.textContent==='Fetch models').every(e=>e.disabled),true);
 assert.equal([...document.querySelectorAll('option')].some(e=>e.value==='openai-chat'),false);
 assert.equal(calls.some(c=>c.command==='canvas_media_profile_list_models'),false);
 await dispose(root);
});

test('DOM: API setup has no retired account preset or connector controls',async()=>{
 const root=await mount();
 try {
  await click(button('Add connection'));
  assert.equal([...document.querySelectorAll('option')].some(o=>o.value.startsWith('doubao')),false);
  assert.ok(document.querySelector('input[type=password]'));
  assert.equal(button('Open Doubao Web'),undefined);
  assert.equal(document.querySelector('[aria-label="Doubao parallel tasks"]'),null);
  assert.equal(calls.some(c=>c.command.startsWith('doubao_')),false);
 } finally {await dispose(root);}
});

test('DOM: a saved retired profile remains visible but cannot be edited or silently replaced',async()=>{
 calls.length=0;const root=createRoot(document.getElementById('root'));let changed=0;
 const snapshot={version:1,activeProfileId:'doubao-default',profiles:[{id:'doubao-default',name:'Legacy connection',baseUrl:'https://www.doubao.com',imageProtocol:'doubao-image',videoProtocol:'doubao-video',imageModel:'old-image',videoModel:'old-video',revision:1}]};
 try {
  await React.act(async()=>root.render(React.createElement(loaded.exports.CanvasMediaProfilesPanel,{snapshot,onChange(){changed++}})));
  assert.match(document.body.textContent,/connection is retired/);
  assert.equal(document.querySelector('select').value,'doubao-default');
  assert.equal(document.querySelector('select option').disabled,true);
  assert.equal(button('Edit').disabled,true);
  assert.equal(changed,0);assert.deepEqual(calls.map(c=>c.command),['canvas_comfyui_get_config']);
 } finally {await dispose(root);}
});

test('DOM: API concurrency retains five explicit limits without any account connector call',async()=>{
 const root=await mount();
 try {
  const inputs=[...document.querySelectorAll('input[type=number]')];assert.equal(inputs.length,5);
  await edit(inputs[0],'2');assert.equal(JSON.parse(localStorage.getItem('luckyray.generationConcurrency.v1')).global,2);
  assert.equal(calls.some(c=>c.command.startsWith('doubao_')),false);
 } finally {await dispose(root);localStorage.clear();}
});
