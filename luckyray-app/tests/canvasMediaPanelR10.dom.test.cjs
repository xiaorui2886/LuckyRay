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
const calls=[];let rejectGet=false;let savedProfile;
const modelProfile={id:'connection-a',name:'Connection A',baseUrl:'https://synthetic.invalid/v1',imageProtocol:'openai-image',videoProtocol:'openai-video',textProtocol:'openai-chat',imageModel:'image-a',imageModels:['image-a'],videoModel:'video-a',videoModels:['video-a'],textModel:'text-a',textModels:['text-a'],revision:1,apiKeyConfigured:true};
const invoke=async(command,args)=>{calls.push({command,args});if(command==='canvas_media_profile_list_models')return ['image-a','image-b','text-b','video-b'];if(command==='canvas_media_profile_upsert'){savedProfile=args.profile;return {version:1,activeProfileId:modelProfile.id,profiles:[{...modelProfile,...args.profile,revision:2,apiKeyConfigured:true}]};}if(command==='canvas_comfyui_get_config'){if(rejectGet)throw Error('unavailable');return{baseUrl:'http://127.0.0.1:8188',revision:1};}if(command==='canvas_comfyui_set_config')return{baseUrl:args.baseUrl,revision:2};if(command==='canvas_comfyui_test_connection')return{reachable:true,version:'synthetic-1'};throw Error(`unexpected command ${command}`);};
const loaded={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,id=>id==='@tauri-apps/api/core'?{invoke}:require(id));
const button=text=>[...document.querySelectorAll('button')].find(e=>e.textContent===text);
const click=async e=>{assert.ok(e);await React.act(async()=>e.click());};
async function edit(e,value){await React.act(async()=>{const proto=e.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
async function mount(snapshot=null){calls.length=0;const root=createRoot(document.getElementById('root'));await React.act(async()=>root.render(React.createElement(loaded.exports.CanvasMediaProfilesPanel,{snapshot,onChange(){}})));return root;}
test('DOM: ComfyUI reads once, tests without save, saves explicitly, never generates',async()=>{
 const root=await mount();assert.deepEqual(calls.map(x=>x.command),['canvas_comfyui_get_config']);
 const input=document.querySelector('.canvas-comfy-field input');assert.equal(input.value,'http://127.0.0.1:8188');
 await edit(input,'http://127.0.0.1:9001');await click(button('Test connection'));
 assert.deepEqual(calls.at(-1),{command:'canvas_comfyui_test_connection',args:{baseUrl:'http://127.0.0.1:9001'}});
 assert.match(document.body.textContent,/Save this address before generating/);
 await click(button('Save address'));assert.deepEqual(calls.at(-1),{command:'canvas_comfyui_set_config',args:{baseUrl:'http://127.0.0.1:9001'}});
 assert.equal(calls.length,3);await React.act(async()=>root.unmount());
});
test('DOM: config read failure allows explicit address repair without overwriting automatically',async()=>{
 rejectGet=true;const root=await mount();assert.match(document.body.textContent,/Could not read local configuration/);
 const input=document.querySelector('.canvas-comfy-field input');assert.equal(input.disabled,false);assert.equal(calls.length,1);
 assert.equal(button('Save address').disabled,true);rejectGet=false;await click(button('Reload configuration'));await click(button('Save address'));assert.equal(calls.at(-1).command,'canvas_comfyui_set_config');await React.act(async()=>root.unmount());
});
test('DOM: Flash preset locks free model and does not fetch, save or generate automatically',async()=>{
 const root=await mount();await click(button('Add connection'));
 const preset=[...document.querySelectorAll('select')].find(e=>[...e.options].some(o=>o.value==='bigmodel'));assert.ok(preset);
 await edit(preset,'bigmodel');const model=[...document.querySelectorAll('input')].find(e=>e.value==='cogvideox-flash');assert.ok(model);assert.equal(model.disabled,true);
 assert.match(document.body.textContent,/no automatic switch to paid models/);assert.equal(calls.length,1);
 await edit(preset,'genericVideo');assert.match(document.body.textContent,/not just chat compatibility/);
 assert.equal(calls.length,1);await click(button('Cancel'));await React.act(async()=>root.unmount());
});


test('DOM: discovered models require explicit per-kind checks; saving preserves exactly the selected lists',async()=>{
 const root=await mount({version:1,activeProfileId:modelProfile.id,profiles:[modelProfile]});
 await click(button('Edit'));
 const pickers=()=>[...document.querySelectorAll('.canvas-model-picker')];
 const image=pickers()[1];await click([...image.querySelectorAll('button')].find(e=>e.textContent==='Fetch models'));
 assert.equal(calls.filter(c=>c.command==='canvas_media_profile_list_models').length,1);
 assert.equal(image.querySelectorAll('input[type="checkbox"]:checked').length,1);
 const choice=(picker,id)=>[...picker.querySelectorAll('.canvas-model-check-option')].find(e=>e.textContent===id)?.querySelector('input');
 await click(choice(image,'image-b'));await click(choice(image,'image-a'));
 assert.equal(choice(image,'image-b').checked,true);assert.equal(choice(image,'image-a').checked,false);
 // Manual model IDs are added explicitly, without selecting unrelated discovered entries.
 await edit(pickers()[0].querySelector('input'),'manual-text');await click([...pickers()[0].querySelectorAll('button')].find(e=>e.textContent.includes('manual-text')));
 await click(button('Save connection'));
 assert.deepEqual(savedProfile.imageModels,['image-b']);assert.equal(savedProfile.imageModel,'image-b');
 assert.deepEqual(savedProfile.textModels,['text-a','manual-text']);assert.deepEqual(savedProfile.videoModels,['video-a']);
 assert.equal(savedProfile.clearApiKey,false);assert.equal(savedProfile.apiKey,'');
 assert.equal(calls.filter(c=>c.command==='canvas_media_profile_upsert').length,1);
 assert.ok(calls.every(c=>!c.command.includes('generate')&&!c.command.includes('activate')));
 await React.act(async()=>root.unmount());
 const restored=await mount({version:1,activeProfileId:modelProfile.id,profiles:[{...modelProfile,...savedProfile,revision:2}]});await click(button('Edit'));
 await click(pickers()[1].querySelector('.canvas-model-picker-toggle'));
 assert.equal(choice(pickers()[1],'image-b').checked,true);assert.equal(choice(pickers()[1],'image-a'),undefined);
 await click(button('Cancel'));await React.act(async()=>restored.unmount());
});
