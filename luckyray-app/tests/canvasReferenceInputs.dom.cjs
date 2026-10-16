require.extensions['.css']=()=>{};
const assert=require('node:assert/strict');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
window.__TAURI_INTERNALS__={convertFileSrc:(path)=>'http://asset.localhost/'+encodeURIComponent(path)};
const React=require('react'),{createRoot}=require('react-dom/client');
const {MaterialCompactComposer,createGenerationRequestSnapshot:compile,I18nProvider,ReactFlowProvider}=require(require('node:path').resolve(process.argv[2]));
const root=createRoot(document.getElementById('root'));
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
async function waitFor(test){for(let n=0;n<100;n++){if(test())return;await new Promise(r=>setTimeout(r,10));}throw Error('DOM condition timeout');}
const profile={id:'qa',revision:1,apiKeyConfigured:true,imageProtocol:'openai-images',videoProtocol:'agnes-video',imageModel:'gpt-image-1',videoModel:'agnes-video-v2.0'};
const text=(id,content)=>({edgeId:'edge-'+id,sourceNodeId:id,role:'promptContext',reference:{id:'node:'+id,label:'Text '+id,kind:'text',text:content}});
let patch,props,submits=0;
async function render(data,inputs=[],more={}){
 props={node:{id:'n',data},connectedInputs:inputs,mediaProfile:profile,imageModels:[profile.imageModel],defaultImageModel:profile.imageModel,videoModels:[profile.videoModel],defaultVideoModel:profile.videoModel,embedded:true,onDataChange:p=>patch=p,onSubmit:()=>submits++,onAddReference:()=>{},...more};
 root.render(React.createElement(I18nProvider,{locale:'zh-CN'},React.createElement(ReactFlowProvider,null,React.createElement(MaterialCompactComposer,{key:checks,...props}))));
 await new Promise(r=>setTimeout(r,35));await waitFor(()=>document.querySelector('.canvas-composer-submit'));
}
const snapshot=()=>compile(props.node,props.connectedInputs,[],'',props.imageModels,profile.imageModel,props.videoModels,profile.videoModel,props.mediaProfile);
(async()=>{
 for(const kind of ['image','video']){
  await render({kind,generationPrompt:''},[text('a','真实上游内容')]);eq(document.querySelector('.canvas-composer-submit').disabled,false);assert.match(snapshot().prompt,/真实上游内容/);checks++;
  await render({kind,generationPrompt:'本节点要求'},[text('a','上游 A'),text('b','上游 B')]);const p=snapshot().prompt;eq(p.indexOf('本节点要求')<p.indexOf('上游 A')&&p.indexOf('上游 A')<p.indexOf('上游 B'),true);eq(document.querySelector('.canvas-prompt-context pre').textContent,p);
  await render({kind,generationPrompt:''},[text('a','')]);eq(document.querySelector('.canvas-composer-submit').disabled,true);eq(snapshot().prompt,'');
  await render({kind,generationPrompt:''},[]);eq(document.querySelector('.canvas-composer-submit').disabled,true);
  await render({kind,generationPrompt:'独立生成'},[]);eq(document.querySelector('.canvas-composer-submit').disabled,false);
  await render({kind,generationPrompt:'独立生成'},[],{mediaProfile:{...profile,apiKeyConfigured:false}});eq(document.querySelector('.canvas-composer-submit').disabled,true);
  await render({kind,generationPrompt:'独立生成'},[],{imageModels:[],videoModels:[]});eq(document.querySelector('.canvas-composer-submit').disabled,true);
  await render({kind,generationPrompt:'生成中',generationTask:{status:'running'}},[]);eq(document.querySelector('.canvas-composer-submit').disabled,true);
 }
 const refs=[{id:'a',kind:'image',label:'A',thumbnailUrl:'C:\\fixture\\a-thumb.png',mediaUrl:'C:\\fixture\\a.png'},{id:'b',kind:'image',label:'B',mediaUrl:'C:\\fixture\\b.png'}];
 await render({kind:'image',generationPrompt:'',generationReferences:refs});eq(document.querySelector('.canvas-composer-submit').disabled,false);
 eq([...document.querySelectorAll('.canvas-reference-number')].map(x=>x.textContent),['1','2']);eq(snapshot().references.map(x=>x.id),['a','b']);
 const image=document.querySelector('.canvas-composer-reference-item img');eq(image.getAttribute('src'),'http://asset.localhost/'+encodeURIComponent(refs[0].thumbnailUrl));image.dispatchEvent(new Event('error'));await waitFor(()=>document.querySelector('img').getAttribute('src').endsWith(encodeURIComponent(refs[0].mediaUrl)));checks++;
 document.querySelector('img').dispatchEvent(new Event('error'));await waitFor(()=>document.querySelector('.canvas-reference-unavailable'));eq(document.querySelector('.canvas-reference-unavailable').textContent,'图片失效');
 document.querySelector('.canvas-reference-order button:last-child').click();await waitFor(()=>patch);eq(patch.generationReferences.map(x=>x.id),['b','a']);
 await render({kind:'image',generationPrompt:'',generationReferences:JSON.parse(JSON.stringify(patch.generationReferences))});eq(snapshot().references.map(x=>x.id),['b','a']);
 patch=null;document.querySelector('.canvas-composer-reference-remove').click();await waitFor(()=>patch);eq(patch.generationReferences.map(x=>x.id),['a']);
 const first={...refs[0],role:'firstFrame'},last={...refs[1],role:'lastFrame'};await render({kind:'video',generationPrompt:'',generationReferences:[last,first]});eq(snapshot().references.map(x=>x.id),['a','b']);eq([...document.querySelectorAll('.canvas-composer-reference-item img')].map(x=>x.alt),['A','B']);
 root.unmount();console.log(`Canvas reference/prompt production DOM: ${checks} assertions PASS`);
})().catch(e=>{console.error(e);root.unmount();process.exitCode=1;});
