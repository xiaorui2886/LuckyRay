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
const source=fs.readFileSync(file,'utf8').replace('import { useI18n } from "../../core/i18n/index";','const useI18n = () => ({locale: "en-US"});');
const built=esbuild.buildSync({stdin:{contents:source,resolveDir:path.dirname(file),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',loader:{'.css':'empty'}});
const calls=[];let rejectGet=false;
const invoke=async(command,args)=>{calls.push({command,args});if(command==='canvas_comfyui_get_config'){if(rejectGet)throw Error('unavailable');return{baseUrl:'http://127.0.0.1:8188'};}if(command==='canvas_comfyui_set_config')return{baseUrl:args.baseUrl};if(command==='canvas_comfyui_test_connection')return{reachable:true,version:'synthetic-1'};if(command==='canvas_media_profile_list_models')return ['image-model-a','image-model-b'];throw Error(`unexpected command ${command}`);};
const loaded={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,id=>id==='@tauri-apps/api/core'?{invoke}:require(id));
const button=text=>[...document.querySelectorAll('button')].find(e=>e.textContent===text);
const click=async e=>{assert.ok(e);await React.act(async()=>e.click());};
async function edit(e,value){await React.act(async()=>{const proto=e.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
async function mount(snapshot=null,onChange=()=>{}){calls.length=0;const root=createRoot(document.getElementById('root'));await React.act(async()=>root.render(React.createElement(loaded.exports.CanvasMediaProfilesPanel,{snapshot,onChange})));return root;}
async function dispose(root){const cancel=button('Cancel');if(cancel&&!cancel.disabled)await click(cancel);await React.act(async()=>root.unmount());}

test('DOM: retired connections are absent, without deleting data or selecting another provider',async()=>{
 const api={id:'ark-api',name:'Ark official API',baseUrl:'https://example.test/v1',imageProtocol:'ark-image',videoProtocol:'ark-video',imageModel:'synthetic-image',videoModel:'synthetic-video',revision:1,apiKeyConfigured:true};
 const legacy={...api,id:'doubao-default',name:'Retired default'};
 const mixed={...api,id:'old-web-video',name:'Retired video',videoProtocol:'doubao-video'};
 const image={...api,id:'old-web-image',name:'Retired image',imageProtocol:'doubao-image'};
 const snapshot={version:1,activeProfileId:legacy.id,profiles:[legacy,mixed,image,api]};
 const original=JSON.stringify(snapshot);let root=await mount(snapshot);
 try{
  const select=document.querySelector('select[aria-label="Active generation connection"]');
  assert.deepEqual([...select.options].filter(o=>o.value).map(o=>o.value),[api.id]);
  assert.equal(select.value,'');assert.equal(select.options[select.selectedIndex].textContent,'Select a generation connection');
  assert.equal(button('Edit').disabled,true);assert.equal(button('Add connection').disabled,false);
  assert.equal(document.querySelector('.canvas-media-profile-summary'),null);
  assert.equal(JSON.stringify(snapshot),original);assert.equal(calls.some(c=>/activate|save|delete|generate/.test(c.command)),false);
  await React.act(async()=>root.unmount());root=await mount({version:1,activeProfileId:legacy.id,profiles:[legacy]});
  assert.equal(document.querySelector('select[aria-label="Active generation connection"]').value,'');
  assert.equal(button('Add connection').disabled,false);
  await click(button('Add connection'));assert.ok(document.querySelector('.canvas-media-profile-editor'));
  assert.equal(calls.some(c=>/activate|save|delete|generate/.test(c.command)),false);
 }finally{await dispose(root);}
 root=await mount({version:1,activeProfileId:api.id,profiles:[legacy,api]});
 try{assert.equal(document.querySelector('select[aria-label="Active generation connection"]').value,api.id);assert.equal(button('Edit').disabled,false);await click(button('Edit'));assert.ok(document.querySelector('.canvas-media-profile-editor'));}
 finally{await dispose(root);}
});
test('DOM: checkbox model picker keeps selections open; Escape and outside pointer close only its group',async()=>{
 const root=await mount();let escaped=0;const outside=()=>escaped++;document.addEventListener('keydown',outside);
 try {
  await click(button('Add connection'));
  const url=[...document.querySelectorAll('input')].find(e=>e.placeholder.includes('https://'));await edit(url,'https://example.test/v1');
  await click([...document.querySelectorAll('button')].find(e=>e.textContent==='Fetch models'&&!e.disabled));
  const input=document.querySelector('.canvas-model-picker input:not(:disabled)');await edit(input,'');
  const picker=input.closest('.canvas-model-picker'),group=()=>picker.querySelector('[role=group]');
  const toggle=picker.querySelector('.canvas-model-picker-toggle');
  await React.act(async()=>input.focus());assert.ok(group());
  const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});await React.act(async()=>input.dispatchEvent(escape));
  assert.equal(group(),null);assert.equal(escape.defaultPrevented,true);assert.equal(escaped,0);
  await click(toggle);assert.ok(group());
  const option=group().querySelector('input[type=checkbox]');await click(option);assert.equal(option.checked,true);assert.ok(group(),'checking a model keeps other choices available');
  await React.act(async()=>option.focus());
  const optionEscape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});await React.act(async()=>option.dispatchEvent(optionEscape));
  assert.equal(group(),null);assert.equal(optionEscape.defaultPrevented,true);assert.equal(escaped,0);
  await click(toggle);assert.ok(group());
  await React.act(async()=>document.body.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})));assert.equal(group(),null);
 } finally {document.removeEventListener('keydown',outside);await dispose(root);}
});

test('DOM: switching settings sections preserves the real connection draft and does not save a secret',async()=>{
 const root=await mount();const draftChanges=[];
 const render=async section=>React.act(async()=>root.render(React.createElement(loaded.exports.CanvasMediaProfilesPanel,{snapshot:null,onChange(){},section,onDraftChange:value=>draftChanges.push(value)})));
 try {
  const concurrency=document.querySelector('.canvas-generation-concurrency');
  assert.equal(concurrency.closest('.canvas-settings-profile-content').hidden,false);
  assert.equal(document.querySelector('.canvas-settings-connections-content .canvas-generation-concurrency'),null);
  concurrency.open=true;
  await click(button('Add connection'));
  const secret=document.querySelector('input[type=password]');await edit(secret,'synthetic-unsaved-key');
  await render('connections');assert.equal(document.querySelector('.canvas-settings-profile-content').hidden,true);assert.equal(document.querySelector('.canvas-settings-connections-content').hidden,false);
  await render('generation');assert.equal(document.querySelector('input[type=password]').value,'synthetic-unsaved-key');assert.equal(draftChanges.at(-1),true);
  assert.equal(document.querySelector('.canvas-generation-concurrency'),concurrency);assert.equal(concurrency.open,true);assert.equal(concurrency.closest('[hidden]'),null);
  assert.equal(calls.some(c=>c.command==='canvas_media_profile_save'),false);
  await click(button('Cancel'));assert.equal(document.querySelector('input[type=password]'),null);assert.equal(draftChanges.at(-1),false);
 } finally {await dispose(root);}
});

test('DOM: home-style editor unmount retains the connection draft in memory until explicit cancel',async()=>{
 let root=await mount();try{
  await click(button('Add connection'));
  await edit(document.querySelector('.canvas-media-profile-editor label input'),'QA home draft');
  await edit(document.querySelector('input[type=password]'),'synthetic-unsaved-only');
  await React.act(async()=>root.unmount());root=await mount();
  assert.equal(document.querySelector('.canvas-media-profile-editor label input')?.value,'QA home draft');
  assert.equal(document.querySelector('input[type=password]')?.value,'synthetic-unsaved-only');
  assert.equal(calls.some(call=>/save|upsert|activate/.test(call.command)),false);
  await click(button('Cancel'));await React.act(async()=>root.unmount());root=await mount();
  assert.equal(document.querySelector('.canvas-media-profile-editor'),null);
  assert.equal(document.querySelector('input[type=password]'),null);
 }finally{await dispose(root);}
});
