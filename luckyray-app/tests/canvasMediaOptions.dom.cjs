require.extensions[".css"]=()=>{};
const assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
const React=require('react'),{createRoot}=require('react-dom/client');
const {MaterialCompactComposer,I18nProvider,ReactFlowProvider}=require(process.argv[2]);
const delay=()=>new Promise(r=>setTimeout(r,30));let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const ok=v=>{assert.ok(v);checks++;};
(async()=>{
 const root=createRoot(document.getElementById('root'));let setData,events=[];
 const profile={imageProtocol:'openai-image',videoProtocol:'12ai-task',baseUrl:'https://new.12ai.org'};
 function Fixture({model='gpt-image-2.5-flare',kind='image'}){
  const [data,set]=React.useState({kind:'generator',generationKind:kind,generationModel:model,generationPrompt:'synthetic',generationAspect:'16:9',generationQuality:'high',generationResolution:'4K'});setData=set;
  return React.createElement(I18nProvider,{locale:'zh-CN'},React.createElement(ReactFlowProvider,null,React.createElement(MaterialCompactComposer,{node:{id:'qa',data},mediaProfile:profile,imageModels:[model],videoModels:[model],defaultImageModel:model,defaultVideoModel:model,embedded:true,onDataChange:p=>{events.push(p);set(old=>({...old,...p}));},onSubmit:()=>{},onAddReference:()=>{}})));
 }
 root.render(React.createElement(Fixture,{}));await delay();
 const settings=()=>document.querySelectorAll('.canvas-composer-anchor > button')[1];settings().click();await delay();
 eq(document.querySelectorAll('.canvas-aspect-glyph').length,13);
 const group=()=>document.querySelector('.canvas-aspect-options');
 eq(group().querySelector('[aria-pressed=true]').textContent,'16:9');
 [...group().querySelectorAll('button')].find(b=>b.textContent==='9:16').click();await delay();eq(events.at(-1),{generationAspect:'9:16'});
 let sections=[...document.querySelectorAll('.canvas-composer-setting')];const section=label=>sections.find(s=>s.querySelector('small')?.textContent===label);
 ok(section('分辨率'));ok(section('画质'));eq(section('画质').querySelectorAll('button').length,6);
 eq(document.querySelector('.canvas-media-pixel-readout strong').textContent,'2160 × 3840');
 [...section('分辨率').querySelectorAll('button')].find(b=>b.textContent==='2K').click();await delay();eq(events.at(-1),{generationResolution:'2K'});
 eq(document.querySelector('.canvas-media-pixel-readout strong').textContent,'1440 × 2560');
 [...group().querySelectorAll('button')].find(b=>b.textContent==='自动').click();await delay();sections=[...document.querySelectorAll('.canvas-composer-setting')];eq(section('分辨率'),undefined);eq(document.querySelector('.canvas-media-pixel-readout strong').textContent,'自动');
 // Reset the real component for a Gemini capability profile, not a hand-built mock menu.
 root.render(React.createElement(Fixture,{key:'gemini',model:'gemini-3.1-flash-image'}));await delay();settings().click();await delay();sections=[...document.querySelectorAll('.canvas-composer-setting')];eq(section('画质'),undefined);eq([...section('分辨率').querySelectorAll('button')].map(b=>b.textContent),['1K','2K','4K','512px']);
 // Save actual rendered markup for separate Chromium visual inspection (never private content).
 fs.writeFileSync('/tmp/r4-options-gemini-dom.html',document.getElementById('root').innerHTML);
 root.render(React.createElement(Fixture,{key:'video',model:'seedance-2.0',kind:'video'}));await delay();settings().click();await delay();sections=[...document.querySelectorAll('.canvas-composer-setting')];ok(document.querySelectorAll('.canvas-aspect-glyph').length>0);eq(section('画质'),undefined);eq(section('分辨率').querySelector('button').textContent,'720p');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await delay();eq(document.querySelector('.canvas-composer-settings-popover'),null);
 root.unmount();console.log(`Media options production React component: ${checks} assertions PASS`);
})().catch(e=>{console.error(e);process.exitCode=1;});
