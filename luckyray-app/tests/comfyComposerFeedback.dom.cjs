// Real composer + real request compiler, with a synthetic frozen image graph.
require.extensions['.css']=()=>{};
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require(process.env.TEST_JSDOM_PATH||'jsdom');
const {buildSync}=require('node:module').createRequire(require.resolve('vite'))('esbuild');
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://qa.invalid',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','Element','Node','Event','InputEvent','MouseEvent','KeyboardEvent','localStorage','navigator','getComputedStyle'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.ResizeObserver=class{observe(){}disconnect(){}};
window.__TAURI_INTERNALS__={convertFileSrc:p=>p,invoke:async()=>{throw Error('fixture-host-unavailable');}};
const React=require('react'),{createRoot}=require('react-dom/client'),{flushSync}=require('react-dom');
const file=path.resolve('src/CanvasSpike.tsx');
const build=buildSync({stdin:{contents:fs.readFileSync(file,'utf8')+'\nexport {MaterialCompactComposer,I18nProvider,ReactFlowProvider,buildWorkFisherImage,buildWorkFisherVideo};',resolveDir:path.dirname(file),loader:'tsx'},bundle:true,write:false,outdir:'fixture-output',platform:'node',format:'cjs',jsx:'automatic',external:['react','react-dom','react-dom/*','@xyflow/react'],loader:{'.css':'empty'},logLevel:'silent'});
const moduleBox={exports:{}};new Function('module','exports','require',build.outputFiles[0].text)(moduleBox,moduleBox.exports,require);
const {MaterialCompactComposer,I18nProvider,ReactFlowProvider,buildWorkFisherImage,buildWorkFisherVideo}=moduleBox.exports;
const root=createRoot(document.querySelector('#root'));let renderId=0,submissions=0,lastPatch;
const click=async element=>{assert(element);flushSync(()=>element.click());await new Promise(resolve=>setTimeout(resolve,0));};
async function footerOptions(){
 const footer=document.querySelector('.canvas-composer-footer'),controls=document.querySelector('.canvas-comfy-controls');
 for(const label of ['调整','LoRA','模型与连接']){
  const button=footer.querySelector(`button[aria-label="${label}"]`);
  assert(button,'all local workflow options live beside camera/creative icons');assert(button.querySelector('svg'));assert.equal(button.textContent.trim(),'');assert.equal(button.title,label);
  assert.equal(controls.querySelector(`button[aria-label="${label}"]`),null,'no duplicate inline option row');
  await click(button);assert.equal(document.querySelectorAll('.canvas-comfy-popover').length,1);assert(document.querySelector('.canvas-comfy-popover.canvas-cinematography'));
 }
 const camera=footer.querySelector('button[aria-label="摄影机与镜头"]');await click(camera);
 assert.equal(document.querySelector('.canvas-comfy-popover'),null,'opening existing camera guidance closes local options');
 assert(document.querySelector('section[aria-label="摄影指导"]'));
 await click(footer.querySelector('button[aria-label="调整"]'));
 assert.equal(document.querySelector('section[aria-label="摄影指导"]'),null,'opening local options also closes existing guidance');
 assert.equal(document.querySelectorAll('.canvas-comfy-popover').length,1);
}
const graph=buildWorkFisherImage({preset:'work-fisher-character',prompt:'synthetic',referenceCount:0,seed:42});
const base={kind:'generator',generationKind:'image',generationSource:'comfyui',generationPrompt:'',generationComfy:{preset:'work-fisher-character',seed:42},generationComfyWorkflow:{baseUrl:'http://127.0.0.1:8188',workflowName:'Synthetic character',workflow:graph}};
async function render(patch={}){
 lastPatch=undefined;
 flushSync(()=>root.render(React.createElement(I18nProvider,{locale:'zh-CN'},React.createElement(ReactFlowProvider,null,React.createElement(MaterialCompactComposer,{key:++renderId,node:{id:'synthetic-card',position:{x:0,y:0},data:{...base,...patch}},connectedInputs:[],onDataChange:patch=>lastPatch=patch,onAddReference:()=>{},onSubmit:()=>submissions++,embedded:true})))));
 await new Promise(resolve=>setTimeout(resolve,30));
}
(async()=>{
 await render();
 assert.equal(document.querySelector('.canvas-prompt-reference-error'),null,'empty draft has no red validation line');
 assert.equal(document.querySelector('.canvas-creative-input-hint'),null,'empty draft stays quiet');
 assert.equal(document.querySelector('.canvas-composer-submit').disabled,true,'validation still blocks an empty submission');
 await render({generationPrompt:'Synthetic character',generationComfy:{preset:'work-fisher-character',seed:-1}});
 assert.equal(document.querySelector('.canvas-composer-submit').disabled,true);
 assert.equal(document.querySelector('.canvas-prompt-reference-error'),null,'ordinary parameter guidance is not a red task failure');
 assert.match(document.querySelector('.canvas-creative-input-hint[role="status"]').textContent,/种子/);
 await render({generationPrompt:'Synthetic character'});
 assert.equal(document.querySelector('.canvas-composer-submit').disabled,false);
 assert.equal(document.querySelector('.canvas-creative-input-hint'),null);
 assert.equal(document.querySelector('.canvas-comfy-prompt-preview'),null,'image composer has no final-prompt disclosure');
 await footerOptions();
 for(const workflow of [buildWorkFisherVideo({prompt:'synthetic',referenceCount:1}),JSON.parse(fs.readFileSync('tests/fixtures/comfy-h3-t2va.api.json','utf8'))]){
   await render({generationKind:'video',generationPrompt:'synthetic',generationComfy:{},generationComfyWorkflow:{baseUrl:'http://127.0.0.1:8188',workflowName:'Synthetic video',workflow}});
   assert.equal(document.querySelector('.canvas-comfy-prompt-preview'),null,'all ComfyUI video composers hide the final-prompt disclosure');
   await footerOptions();
 }
 const template={format:'luckyray.comfy-template',version:1,id:'tpl-test',name:'自定义生图',graph:{'1':{class_type:'ImageSource',inputs:{seed:7}},'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'synthetic'}}},images:[],prompt:null,parameters:[{nodeId:'1',input:'seed',label:'种子'}],output:{nodeId:'2',kind:'image'}};
 await render({generationComfyTemplate:template,generationComfy:undefined,generationComfyWorkflow:{baseUrl:'http://127.0.0.1:8188',workflowName:template.name,template,workflow:{format:'luckyray.comfy-execution',version:1,graph:template.graph,images:[],output:template.output}}});
 assert.equal(document.querySelector('.canvas-composer-submit').disabled,false,'template with original prompt/no prompt input remains runnable');
 assert.equal(document.querySelector('.canvas-template-picker'),null,'workflow switching no longer occupies its own row');
 assert.equal(document.querySelector('select[aria-label="工作流模板"]'),null);
 assert(!document.querySelector('.canvas-generation-composer').textContent.includes('无需参考图'),'zero-reference templates stay quiet');
 const workflowButton=document.querySelector('.canvas-composer-footer button[aria-label="工作流模板"]');
 assert(workflowButton.querySelector('svg'));assert.equal(workflowButton.textContent.trim(),'');assert.equal(workflowButton.title,template.name);
 await click(workflowButton);
 assert.match(document.querySelector('.canvas-composer-workflow-popover button[aria-pressed="true"]').textContent,/自定义生图 · 当前快照/);
 await click([...document.querySelectorAll('.canvas-composer-workflow-popover button')].find(button=>button.textContent==='内置工作流'));
 assert.equal(lastPatch.generationComfyTemplate,undefined);assert.equal(lastPatch.generationComfyWorkflow,undefined);
 assert.equal(document.querySelector('.canvas-composer-workflow-popover'),null,'selecting closes the popup without submitting');
 await click(workflowButton);await click(document.querySelector('.canvas-composer-footer button[aria-label="摄影机与镜头"]'));
 assert.equal(document.querySelector('.canvas-composer-workflow-popover'),null,'workflow and camera menus are exclusive');
 assert.equal(document.querySelector('button[aria-label="插入提示词模板"]'),null);
 await click(document.querySelector('button[aria-label="模板参数"]'));assert(document.querySelector('.canvas-template-values'));
 assert.equal(document.querySelector('section[aria-label="摄影指导"]'),null);
 localStorage.setItem('luckyray.canvas.comfy-templates.v1',JSON.stringify([template]));
 await render({generationPrompt:'Keep my prompt'});
 await click(document.querySelector('.canvas-composer-footer button[aria-label="工作流模板"]'));
 assert.match(document.querySelector('.canvas-composer-workflow-popover button[aria-pressed="true"]').textContent,/内置工作流/);
 await click(document.querySelector('.canvas-composer-workflow-popover button[aria-pressed="true"]'));
 assert.equal(lastPatch,undefined,'selecting the current built-in workflow preserves all current settings');
 await click(document.querySelector('.canvas-composer-footer button[aria-label="工作流模板"]'));
 await click([...document.querySelectorAll('.canvas-composer-workflow-popover button')].find(button=>button.textContent===template.name));
 assert.deepEqual(lastPatch.generationComfyTemplate,template);assert.equal(lastPatch.generationKind,'image');
 assert(!Object.hasOwn(lastPatch,'generationPrompt'),'switching preserves an existing prompt');
 await render({generationComfyTemplate:template,generationComfyTemplateValues:{'1.seed':99},resultKind:'image',resultMediaUrl:'synthetic://saved-image'});
 await click(document.querySelector('.canvas-composer-footer button[aria-label="工作流模板"]'));
 await click(document.querySelector('.canvas-composer-workflow-popover button[aria-pressed="true"]'));
 assert.equal(lastPatch,undefined,'selecting the current template keeps its saved snapshot and parameter values');
 await click(document.querySelector('.canvas-composer-footer button[aria-label="工作流模板"]'));
 await click([...document.querySelectorAll('.canvas-composer-workflow-popover button')].find(button=>button.textContent==='内置工作流'));
 assert.equal(lastPatch.generationKind,'image');assert.equal(lastPatch.generationComfy.preset,'work-fisher-character','saved image cards keep their original output type');
 assert.equal(submissions,0);
 console.log('PASS production composer feedback: blank draft quiet and blocked; invalid filled draft has neutral guidance; valid draft enabled; zero generation.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{flushSync(()=>root.unmount());dom.window.close();});
