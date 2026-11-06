// Real composer, synthetic profiles only. No provider or native business requests.
require.extensions['.css']=()=>{};
const assert=require('node:assert/strict'),{createRequire}=require('node:module');
const tools=process.env.LR_TEST_TOOLS?createRequire(process.env.LR_TEST_TOOLS+'/package.json'):require;
const {JSDOM}=tools('jsdom'),dom=new JSDOM('<div id="root"></div>',{url:'https://synthetic.invalid',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
const bridgeCalls=[];
window.__TAURI_INTERNALS__={convertFileSrc:path=>'https://synthetic.invalid/'+encodeURIComponent(path),invoke:async command=>{bridgeCalls.push(command);if(command==='canvas_comfyui_get_config')return{baseUrl:'http://127.0.0.1:8188',revision:0};throw Error('unavailable in synthetic fixture');}};
const React=require('react'),{createRoot}=require('react-dom/client'),{flushSync}=require('react-dom');
const {MaterialCompactComposer,I18nProvider,ReactFlowProvider}=require(require('node:path').resolve(process.argv[2]));
const a={id:'a',name:'Connection A',imageModel:'gpt-image-1',imageModels:['gpt-image-1','image-a'],videoModel:'sora-2',videoModels:['sora-2'],textProtocol:'openai-chat',textModel:'text-a',textModels:['text-a'],imageProtocol:'openai-image',videoProtocol:'openai-video',baseUrl:'https://a.invalid/v1',revision:3,apiKeyConfigured:true};
const b={...a,id:'b',name:'Connection B',imageModels:['gpt-image-1','image-b'],textModel:'text-b',textModels:['text-b'],revision:7};
let profiles=[a,b],data={kind:'generator',generationKind:'image',generationPrompt:'Synthetic draft',generationModel:'gpt-image-1',generationAspect:'16:9',generationQuality:'high'},checks=0;
const root=createRoot(document.getElementById('root')),delay=()=>new Promise(resolve=>setTimeout(resolve,35));
function Fixture(){return React.createElement(I18nProvider,{locale:'zh-CN'},React.createElement(ReactFlowProvider,null,React.createElement(MaterialCompactComposer,{node:{id:'card',data},mediaProfile:a,mediaProfiles:profiles,textModels:['text-a'],textModelsReady:true,imageModels:a.imageModels,defaultImageModel:a.imageModel,videoModels:a.videoModels,defaultVideoModel:a.videoModel,embedded:true,onDataChange:patch=>{data={...data,...patch};paint();},onAddReference:()=>{},onSubmit:()=>{throw Error('generation prohibited in fixture');}})));}
function check(value,message){assert.ok(value,message);checks++;}
function paint(){flushSync(()=>root.render(React.createElement(Fixture)));}
async function open(){document.querySelector('.canvas-composer-options .canvas-composer-anchor > button').click();await delay();}
const choices=()=>[...document.querySelectorAll('.canvas-composer-model-popover > button')];
(async()=>{
 paint();await delay();await open();
 check(choices().length===4,'all configured image models are visible, including inactive connection');
 check(choices().filter(button=>button.querySelector('strong')?.textContent==='gpt-image-1').length===2,'same model on two connections is not conflated');
 choices().find(button=>button.textContent.includes('Connection B')&&button.querySelector('strong')?.textContent==='gpt-image-1').click();await delay();
 check(data.generationProfileId==='b'&&data.generationModel==='gpt-image-1','card stores model and selected connection together');
 check(a.id==='a'&&data.generationPrompt==='Synthetic draft'&&data.generationAspect==='16:9','selection preserves defaults, prompt and parameter draft');
 await open();check(choices().find(button=>button.getAttribute('aria-pressed')==='true')?.textContent.includes('Connection B'),'only the selected connection/model is checked');
 const search=document.querySelector('.canvas-composer-model-search');Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(search,'image-b');search.dispatchEvent(new Event('input',{bubbles:true}));await delay();
 check(choices().length===1&&choices()[0].textContent.includes('image-b'),'model and provider search filters the combined catalog');
 choices()[0].click();await delay();
 const saved=JSON.parse(JSON.stringify(data));flushSync(()=>root.render(null));data=saved;paint();await delay();
 check(data.generationProfileId==='b'&&document.querySelector('.canvas-composer-options strong')?.textContent==='image-b','remount keeps connection/model choice');
 profiles=[a];paint();await delay();check(document.querySelector('.canvas-composer-submit').disabled,'removed selected connection cannot silently fall back to another API');
 profiles=[a,b];data={...data,generationKind:'text',generationProfileId:'b',generationModel:'text-b'};paint();await delay();await open();
 check(choices().length===2&&choices().some(button=>button.textContent.includes('text-b')),'text cards include explicit models from all saved API connections');
 choices().find(button=>button.textContent.includes('text-a')).click();await delay();
 data={...data,generationKind:'video',generationProfileId:'a',generationModel:'sora-2'};paint();await delay();await open();
 check(choices().length===2&&choices().every(button=>button.textContent.includes('sora-2')),'video catalog is separated from image/text models');
 check(!bridgeCalls.some(command=>/generate|upsert|activate/.test(command)),'selection does not generate or mutate the global profile');
 root.unmount();console.log(JSON.stringify({checks,providerRequests:0,generationRequests:0,globalProfileWrites:0}));
})().catch(error=>{console.error(error);process.exitCode=1;root.unmount();});
