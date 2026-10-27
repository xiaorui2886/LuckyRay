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
const built=esbuild.buildSync({stdin:{contents:source,resolveDir:path.dirname(file),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
const calls=[];let rejectGet=false;
const invoke=async(command,args)=>{calls.push({command,args});if(command==='canvas_comfyui_get_config'){if(rejectGet)throw Error('unavailable');return{baseUrl:'http://127.0.0.1:8188'};}if(command==='canvas_comfyui_set_config')return{baseUrl:args.baseUrl};if(command==='canvas_comfyui_test_connection')return{reachable:true,version:'synthetic-1'};throw Error(`unexpected command ${command}`);};
const loaded={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,id=>id==='@tauri-apps/api/core'?{invoke}:require(id));
const button=text=>[...document.querySelectorAll('button')].find(e=>e.textContent===text);
const click=async e=>{assert.ok(e);await React.act(async()=>e.click());};
async function edit(e,value){await React.act(async()=>{const proto=e.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
async function mount(){calls.length=0;const root=createRoot(document.getElementById('root'));await React.act(async()=>root.render(React.createElement(loaded.exports.CanvasMediaProfilesPanel,{snapshot:null,onChange(){}})));return root;}
test('DOM: ComfyUI reads once, tests without save, saves explicitly, never generates',async()=>{
 const root=await mount();assert.deepEqual(calls.map(x=>x.command),['canvas_comfyui_get_config']);
 const input=document.querySelector('[aria-label="ComfyUI local endpoint"]');assert.equal(input.value,'http://127.0.0.1:8188');
 await edit(input,'http://127.0.0.1:9001');await click(button('Test read-only connection'));
 assert.deepEqual(calls.at(-1),{command:'canvas_comfyui_test_connection',args:{baseUrl:'http://127.0.0.1:9001'}});
 assert.match(document.body.textContent,/generation is not enabled/);
 await click(button('Save address'));assert.deepEqual(calls.at(-1),{command:'canvas_comfyui_set_config',args:{baseUrl:'http://127.0.0.1:9001'}});
 assert.equal(calls.length,3);await React.act(async()=>root.unmount());
});
test('DOM: config read failure allows explicit address repair without overwriting automatically',async()=>{
 rejectGet=true;const root=await mount();assert.match(document.body.textContent,/nothing is overwritten automatically/);
 const input=document.querySelector('[aria-label="ComfyUI local endpoint"]');assert.equal(input.disabled,false);assert.equal(calls.length,1);
 await click(button('Save address'));assert.equal(calls.at(-1).command,'canvas_comfyui_set_config');await React.act(async()=>root.unmount());rejectGet=false;
});
test('DOM: Flash preset locks free model and does not fetch, save or generate automatically',async()=>{
 const root=await mount();await click(button('Add connection'));
 const preset=[...document.querySelectorAll('select')].find(e=>[...e.options].some(o=>o.value==='bigmodel'));assert.ok(preset);
 await edit(preset,'bigmodel');const model=[...document.querySelectorAll('input')].find(e=>e.value==='cogvideox-flash');assert.ok(model);assert.equal(model.disabled,true);
 assert.match(document.body.textContent,/no automatic switch to paid models/);assert.equal(calls.length,1);
 await edit(preset,'genericVideo');assert.match(document.body.textContent,/not just chat compatibility/);
 assert.equal(calls.length,1);await React.act(async()=>root.unmount());
});
