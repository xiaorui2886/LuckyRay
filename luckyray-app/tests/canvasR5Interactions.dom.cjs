require.extensions['.css']=()=>{};
const assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<button id="outside">Outside</button><div id="root"></div>',{url:'https://qa.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
const React=require('react'),{createRoot}=require('react-dom/client');
const {SpikeNodeView,CanvasMediaProfilesPanel,canvasMediaProfilesClient,useCanvasHistoryPopover,I18nProvider,ReactFlowProvider}=require(require('node:path').resolve(process.argv[2]));
const delay=()=>new Promise(r=>setTimeout(r,35));let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const ok=v=>{assert.ok(v);checks++;};
const button=t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
const click=async n=>{ok(n);n.click();await delay();};
(async()=>{
const root=createRoot(document.getElementById('root'));const wrap=node=>React.createElement(I18nProvider,{locale:'zh-CN'},React.createElement(ReactFlowProvider,null,node));
const profile={id:'p',name:'Local',baseUrl:'http://127.0.0.1:8317/v1',imageProtocol:'openai-image',imageModel:'gemini-3.1-flash-image',videoProtocol:'disabled',videoModel:'',imageModels:['gemini-3.1-flash-image','other-image'],revision:1,apiKeyConfigured:true};
const snapshot={version:1,activeProfileId:'p',profiles:[profile,{...profile,id:'q'}]};let saved,removed;
canvasMediaProfilesClient.save=async p=>{saved=p;return snapshot;};canvasMediaProfilesClient.remove=async(id,revision)=>{removed={id,revision};return {...snapshot,profiles:[snapshot.profiles[1]],activeProfileId:'q'};};
root.render(wrap(React.createElement(CanvasMediaProfilesPanel,{snapshot,onChange:()=>{}})));await delay();await click(button('编辑'));
const bar=document.querySelector('.canvas-media-profile-command-bar');ok(bar.contains(button('保存配置')));ok(bar.contains(button('取消')));ok(bar.contains(button('删除')));ok(!document.querySelector('.canvas-media-profile-editor').contains(button('保存配置')));
let resolveModels;
canvasMediaProfilesClient.listModels=()=>new Promise(resolve=>{resolveModels=resolve;});
await click(button('获取模型'));await click(button('改用 Gemini Images'));resolveModels(['stale-image']);await delay();ok(!document.querySelector('.canvas-model-picker-status'));
await click(button('删除'));ok(bar.contains(document.querySelector('[role=alert]')));ok(button('确认删除').classList.contains('is-danger'));ok(button('确认删除').parentNode===button('保留').parentNode);await click(button('保留'));eq(document.querySelector('.canvas-media-profile-delete-confirm'),null);
const protocol=[...document.querySelectorAll('select')].find(s=>s.parentNode.textContent.includes('图片协议'));eq(protocol.value,'gemini-image');eq(document.querySelector('input[placeholder^="https:"]').value,profile.baseUrl);eq(document.querySelector('input[type=password]').value,'');await click(button('保存配置'));eq(saved.imageProtocol,'gemini-image');eq(saved.imageModel,profile.imageModel);eq(saved.baseUrl,profile.baseUrl);eq(saved.apiKey,'');eq(saved.expectedRevision,1);eq(saved.imageModels,profile.imageModels);
await click(button('编辑'));
let rejectModels;canvasMediaProfilesClient.listModels=()=>new Promise((_,reject)=>{rejectModels=reject;});
await click(button('获取模型'));await click(button('取消'));await click(button('编辑'));rejectModels(new Error('stale-provider-error'));await delay();ok(!document.querySelector('.canvas-settings-error'));
await click(button('删除'));await click(button('确认删除'));eq(removed,{id:'p',revision:1});
await click(button('添加配置'));const presets=[...document.querySelectorAll('select')].find(s=>s.querySelector('option[value=easycli]'));ok(presets);Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(presets,'easycli');presets.dispatchEvent(new Event('change',{bubbles:true}));await delay();eq(document.querySelector('input[placeholder^="https:"]').value,'http://127.0.0.1:8317/v1');eq(document.querySelector('input[type=password]').value,'');await click(button('取消'));
// Real history lifecycle hook: non-focusable outside, selection drag, Escape/IME, timer cleanup.
let control;const originalTimeout=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms===3500?120:ms,...args);
function History(){const[open,setOpen]=React.useState(true),[notice,setNotice]=React.useState('Deleted');control={setOpen,setNotice};const ref=useCanvasHistoryPopover(open,notice,()=>setOpen(false),()=>setNotice(''));return React.createElement('div',{ref},open?React.createElement('section',{'data-history':true},React.createElement('input'),React.createElement('span',{'data-notice':true},notice)):null);}
root.render(React.createElement(History));await delay();document.querySelector('input').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0}));document.body.dispatchEvent(new MouseEvent('pointerup',{bubbles:true,button:0}));await delay();ok(document.querySelector('[data-history]'));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}));await delay();ok(document.querySelector('[data-history]'));await new Promise(r=>setTimeout(r,140));eq(document.querySelector('[data-notice]').textContent,'');
control.setNotice('Again');await delay();document.body.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0}));await delay();eq(document.querySelector('[data-history]'),null);control.setOpen(true);await delay();eq(document.querySelector('[data-notice]').textContent,'');document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await delay();eq(document.querySelector('[data-history]'),null);
window.setTimeout=originalTimeout;
// Actual generator nodes, both image/video. Empty icon is absent while queued/running and returns on failure.
for(const kind of ['image','video'])for(const status of ['queued','running','failed']){
root.render(wrap(React.createElement(SpikeNodeView,{id:'qa',selected:false,data:{kind:'generator',label:'Synthetic',generationKind:kind,generationTask:{status,request:{kind},progress:20}}})));await delay();eq(!!document.querySelector('.canvas-generator-output-empty'),status==='failed');eq(!!document.querySelector('.canvas-generator-process'),status!=='failed');}
root.unmount();console.log(`R5 production interactions: ${checks} assertions PASS`);dom.window.close();
})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1;});
