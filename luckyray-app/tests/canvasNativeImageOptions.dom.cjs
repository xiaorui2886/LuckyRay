require.extensions['.css']=()=>{};
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
const React=require('react'),{createRoot}=require('react-dom/client');
const {MaterialCompactComposer,I18nProvider,ReactFlowProvider}=require(process.argv[2]);
const delay=()=>new Promise(r=>setTimeout(r,35));let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
(async()=>{
 const root=createRoot(document.getElementById('root'));let events=[];
 function Fixture({model,protocol}){
  const [data,set]=React.useState({kind:'generator',generationKind:'image',generationModel:model,generationPrompt:'synthetic',generationAspect:'16:9',generationQuality:'high',generationResolution:'4K'});
  const profile={imageProtocol:protocol,videoProtocol:'disabled',baseUrl:'http://127.0.0.1:8317/v1'};
  return React.createElement(I18nProvider,{locale:'zh-CN'},React.createElement(ReactFlowProvider,null,React.createElement(MaterialCompactComposer,{node:{id:'qa',data},mediaProfile:profile,imageModels:[model],defaultImageModel:model,videoModels:[],embedded:true,onDataChange:p=>{events.push(p);set(old=>({...old,...p}));},onSubmit:()=>{},onAddReference:()=>{}})));
 }
 const open=async(model,protocol)=>{root.render(React.createElement(Fixture,{key:model,model,protocol}));await delay();document.querySelectorAll('.canvas-composer-anchor > button')[1].click();await delay();};
 const section=label=>[...document.querySelectorAll('.canvas-composer-setting')].find(s=>s.querySelector('small')?.textContent===label);
 const labels=s=>[...s.querySelectorAll('button')].map(b=>b.textContent);
 await open('gpt-image-2.5-flare','openai-image');
 eq(document.querySelectorAll('.canvas-aspect-glyph').length,16);
 eq(labels(section('分辨率')),['1K','2K','4K']);eq(labels(section('画质')),['低','标准','高','自动','更高','最高']);
 eq(document.querySelector('.canvas-media-pixel-readout strong').textContent,'3840 × 2160');
 [...section('画质').querySelectorAll('button')].find(b=>b.textContent==='最高').click();await delay();eq(events.at(-1),{generationQuality:'max'});
 await open('gpt-image-1.5','openai-image');eq(section('分辨率'),undefined);eq(document.querySelectorAll('.canvas-aspect-glyph').length,4);
 await open('gemini-3.1-flash-image-preview','gemini-image');
 eq(document.querySelectorAll('.canvas-aspect-glyph').length,14);eq(section('画质'),undefined);
 eq(labels(section('分辨率')),['1K','2K','4K','512px']);
 [...document.querySelector('.canvas-aspect-options').querySelectorAll('button')].find(b=>b.textContent==='8:1').click();await delay();eq(events.at(-1),{generationAspect:'8:1'});
 [...section('分辨率').querySelectorAll('button')].find(b=>b.textContent==='512px').click();await delay();eq(events.at(-1),{generationQuality:'512'});
 await open('gemini-2.5-flash-image','gemini-image');eq(section('分辨率'),undefined);eq(section('画质'),undefined);eq(document.querySelectorAll('.canvas-aspect-glyph').length,10);
 root.unmount();console.log(`Native model options production React component: ${checks} assertions PASS`);
})().catch(e=>{console.error(e);process.exitCode=1;});
