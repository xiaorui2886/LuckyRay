const assert=require('node:assert/strict'),{JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid'});
for(const k of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','navigator'])Object.defineProperty(global,k,{value:dom.window[k],configurable:true});
global.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
const React=require('react'),{createRoot}=require('react-dom/client'),{flushSync}=require('react-dom'),{ReactFlowProvider}=require('@xyflow/react');
require.extensions['.css']=()=>{};
const {MaterialCompactComposer,I18nProvider}=require(require('node:path').resolve(process.argv[2]));
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const root=createRoot(document.getElementById('root'));
let submitted=0,removed=[];
const connectedInputs=[{edgeId:'text-edge',sourceNodeId:'text',role:'promptContext',reference:{id:'text',label:'镜头脚本',kind:'text',text:'雨夜，小屋灯火。'}},{edgeId:'image-edge',sourceNodeId:'image',role:'reference',reference:{id:'image',label:'场景',kind:'image',mediaUrl:'https://qa.invalid/reference.png',thumbnailUrl:'https://qa.invalid/reference.png'}}];
for(const kind of ['image','video']){
 flushSync(()=>root.render(React.createElement(I18nProvider,{locale:'zh-CN'},React.createElement(ReactFlowProvider,null,React.createElement(MaterialCompactComposer,{node:{id:kind,position:{x:0,y:0},data:{kind:'generator',label:'生成',generationKind:kind,generationPrompt:''}},onDataChange:()=>{},onAddReference:()=>{},onSubmit:()=>submitted++,connectedInputs,onRemoveConnectedInput:id=>removed.push(id),imageModels:['image-test'],videoModels:['video-test'],mediaProfile:{apiKeyConfigured:true,imageProtocol:'openai',videoProtocol:'openai'},embedded:true})))));
 eq(document.querySelectorAll('.canvas-prompt-context').length,0);eq(document.querySelectorAll('.canvas-prompt-starter').length,0);
 eq(document.querySelector('.canvas-reference-text-preview').textContent,'雨夜，小屋灯火。');
 eq(document.querySelectorAll('.canvas-composer-reference-item').length,2);
 eq(document.querySelector('.canvas-composer-submit').disabled,false);document.querySelector('.canvas-composer-submit').click();
 const textChip=[...document.querySelectorAll('.canvas-composer-reference-item')].find(el=>el.getAttribute('aria-label').startsWith('镜头脚本'));
 eq(textChip.getAttribute('tabindex'),'0');textChip.querySelector('.canvas-composer-reference-remove').click();
}
eq(submitted,2);eq(removed,['text-edge','text-edge']);root.unmount();console.log(`PASS ${checks} real composer assertions (image + video, no model requests)`);
