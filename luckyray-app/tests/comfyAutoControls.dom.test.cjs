const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.SOURCE_ROOT||path.resolve(__dirname,'..');
const deps=process.env.TEST_DEPS_ROOT||path.join(root,'node_modules');
const ts=require(path.join(deps,'typescript'));
const React=require(path.join(deps,'react'));
const {JSDOM}=require(process.env.TEST_JSDOM_PATH||path.join(deps,'jsdom'));
function compile(relative,imports={}) {
 const code=ts.transpileModule(fs.readFileSync(path.join(root,relative),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 vm.runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:relative})(name=>name in imports?imports[name]:name.endsWith('.css')?{}:name==='./CanvasComfyPopover'?popovers:name==='./CanvasAspectOptions'?aspectOptions:name==='./CanvasComposerPopover'?placement:name.endsWith('/comfyLora')?lora:require(path.join(deps,name)),module,module.exports);
 return module.exports;
}
const placement=compile('src/features/canvas/CanvasComposerPopover.tsx',{'@xyflow/react':{useViewport:()=>({x:0,y:0,zoom:1})}});
const presentation=compile('src/core/canvas/mediaOptionPresentation.ts',{'./agnesImageLegacySpecs.json':{default:{}},'./mediaCapabilities':{}});
const aspectOptions=compile('src/features/canvas/CanvasAspectOptions.tsx',{'../../core/canvas/mediaOptionPresentation':presentation});
const popovers=compile('src/features/canvas/CanvasComfyPopover.tsx',{'./CanvasComposerPopover':placement});
async function open(label){const button=document.querySelector(`button[aria-label="${label}"]`);assert(button, label);if(button.getAttribute('aria-expanded')!=='true')await React.act(async()=>button.click());}
const lora=compile('src/core/canvas/comfyLora.ts');
const preset=compile('src/core/canvas/workFisherPreset.ts',{'./workFisherData.json':{default:JSON.parse(fs.readFileSync(path.join(root,'src/core/canvas/workFisherData.json'),'utf8'))},'./workFisherUpscaleData.json':{default:JSON.parse(fs.readFileSync(path.join(root,'src/core/canvas/workFisherUpscaleData.json'),'utf8'))}});
const workflow=compile('src/core/canvas/comfyWorkflow.ts',{'./workFisherPreset':preset});

test('image controls default to random and upscale, use size presets, and bind LoRA choices without generating',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'}),saved=new Map();
 for(const key of ['window','document','Node','HTMLElement','Event','MouseEvent']){saved.set(key,Object.getOwnPropertyDescriptor(global,key));Object.defineProperty(global,key,{configurable:true,writable:true,value:dom.window[key]});}
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=require(path.join(deps,'react-dom/client'));let value,checks=0;
 const controls=compile('src/features/canvas/CanvasComfyUiControls.tsx',{'../../core/canvas/comfyWorkflow':workflow,'../../core/canvas/workFisherPreset':preset,'../../core/services/canvasComfyUi':{canvasComfyUiClient:{preflight:async()=>{checks++;return {missingClasses:[],missingModels:[],invalidInputs:[],installedLoraModels:['Synthetic.safetensors']};}}}});
 function Harness(){const [current,setCurrent]=React.useState({});value=current;return React.createElement(controls.CanvasComfyUiImageControls,{config:{baseUrl:'http://127.0.0.1:8188'},preset:'work-fisher-character',value:current,onChange:patch=>setCurrent(v=>({...v,...patch})),imageCount:0,english:false});}
 const host=document.querySelector('#root'),app=createRoot(host);
 const choose=async(label,next)=>{if(label==='图片尺寸'){await open(label);const item=next==='custom'?document.querySelector('.canvas-comfy-size-grid button:last-child'):document.querySelector(`.canvas-comfy-size-grid button[aria-label^="${({wide:'16:9',square:'1:1'})[next]} ·"]`);assert(item);await React.act(async()=>item.click());return;}const select=host.querySelector(`select[aria-label="${label}"]`);assert(select);await React.act(async()=>{select.value=next;select.dispatchEvent(new Event('change',{bubbles:true}));});};
 try{
  await React.act(async()=>app.render(React.createElement(Harness)));
  assert.equal(host.querySelector('[role=dialog]'),null);await open('调整');assert.equal(host.querySelector('select[aria-label="生成后种子"]').value,'randomize');
  assert.equal(host.querySelector('input[aria-label="SeedVR2 放大"]').checked,true);
  assert.equal(host.querySelector('input[aria-label="宽"]'),null,'numeric sizes are hidden for presets');
  await choose('图片尺寸','wide');assert.equal(value.width,1280);assert.equal(value.height,720);
  assert.equal(host.querySelector('.canvas-comfy-size-grid small'),null,'ratio tiles omit duplicate numeric dimensions');
  await choose('图片尺寸','custom');assert.equal(value.sizePreset,'custom');assert(host.querySelector('input[aria-label="宽"]'));assert(host.querySelector('input[aria-label="高"]'));
  await choose('图片尺寸','square');assert.equal(value.width,1024);assert.equal(host.querySelector('input[aria-label="宽"]'),null);
  await open('LoRA');await React.act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='读取已安装 LoRA').click());assert.equal(checks,1);
  await choose('LoRA模型 240','Synthetic.safetensors');assert.equal(value.loras['240'].name,'Synthetic.safetensors');
  await React.act(async()=>host.querySelector('input[aria-label="启用 LoRA 1"]').click());assert.equal(value.loras['240'].enabled,false);
  await open('调整');await choose('放大短边','2048');assert.equal(value.upscaleResolution,2048);
  const compiled=preset.buildWorkFisherImage({...value,preset:'work-fisher-character',prompt:'Synthetic shape',referenceCount:0,upscale:value.upscale??true});
  assert.equal(compiled['237'].inputs.value,2048);assert.equal(compiled['240'].inputs.strength_model,0);assert.equal(compiled['240'].inputs.lora_name,'Synthetic.safetensors');
  await React.act(async()=>host.querySelector('input[aria-label="SeedVR2 放大"]').click());assert.equal(value.upscale,false);
  assert.equal(preset.buildWorkFisherImage({...value,preset:'work-fisher-character',prompt:'Synthetic shape',referenceCount:0})['231'],undefined);
 }finally{await React.act(async()=>app.unmount());dom.window.close();delete global.IS_REACT_ACT_ENVIRONMENT;for(const [key,descriptor]of saved)descriptor?Object.defineProperty(global,key,descriptor):delete global[key];}
});

test('image and video share persisted seed modes without changing the current seed or submitting',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'}),saved=new Map();
 for(const key of ['window','document','Node','HTMLElement','Event','MouseEvent']){saved.set(key,Object.getOwnPropertyDescriptor(global,key));Object.defineProperty(global,key,{configurable:true,writable:true,value:dom.window[key]});}
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=require(path.join(deps,'react-dom/client'));let calls=0,value,kind='image';
 const controls=compile('src/features/canvas/CanvasComfyUiControls.tsx',{'../../core/canvas/comfyWorkflow':workflow,'../../core/canvas/workFisherPreset':preset,'../../core/services/canvasComfyUi':{canvasComfyUiClient:{preflight:async()=>{calls++;return {};}}}});
 const fixture=fs.readFileSync(path.join(root,'tests/fixtures/comfy-h3-t2va.api.json'),'utf8'),config={baseUrl:'http://127.0.0.1:8188',workflowJson:fixture,workflowName:'Synthetic H3',revision:1};
 function Harness(){const [current,setCurrent]=React.useState({seed:42,seedMode:'fixed',preset:'work-fisher-character'});value=current;
  const props={config,value:current,onChange:patch=>setCurrent(v=>({...v,...patch})),english:false,imageCount:0};
  return kind==='image'?React.createElement(controls.CanvasComfyUiImageControls,{...props,preset:'work-fisher-character'}):React.createElement(controls.CanvasComfyUiControls,props);}
 const host=document.querySelector('#root'),app=createRoot(host);
 try{
  await React.act(async()=>app.render(React.createElement(Harness)));
  await open('调整');for(const next of ['randomize','increment','decrement','fixed']){
   const select=host.querySelector('select[aria-label="生成后种子"]');assert(select);
   await React.act(async()=>{select.value=next;select.dispatchEvent(new Event('change',{bubbles:true}));});
   assert.equal(value.seedMode,next);assert.equal(value.seed,42,'selecting a policy does not rewrite the current seed');
  }
  kind='video';await React.act(async()=>app.render(React.createElement(Harness)));
  await React.act(async()=>host.querySelector('button[aria-label="调整"]').click());
  const select=host.querySelector('select[aria-label="生成后种子"]');assert.equal(select.value,'fixed');
  await React.act(async()=>{select.value='randomize';select.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(value.seedMode,'randomize');assert.equal(value.seed,42);
  assert.equal(calls,0,'policy edits never check the environment or submit generation');
 }finally{await React.act(async()=>app.unmount());dom.window.close();delete global.IS_REACT_ACT_ENVIRONMENT;for(const [key,descriptor]of saved)descriptor?Object.defineProperty(global,key,descriptor):delete global[key];}
});
test('real React controls automatically follow images and apply changed model to compiled request',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
 const saved=new Map();
 for(const key of ['window','document','Node','HTMLElement','Event','MouseEvent']){saved.set(key,Object.getOwnPropertyDescriptor(global,key));Object.defineProperty(global,key,{configurable:true,writable:true,value:dom.window[key]});}
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=require(path.join(deps,'react-dom/client'));
 const controls=compile('src/features/canvas/CanvasComfyUiControls.tsx',{'../../core/canvas/comfyWorkflow':workflow,'../../core/canvas/workFisherPreset':preset,'../../core/services/canvasComfyUi':{canvasComfyUiClient:{preflight:async()=>({installedUnetModels:['minimax_h3_fl2va_pruned_int8_convrot.safetensors','minimax_h3_ref2va_int8_convrot.safetensors']})}}});
 const fixture=fs.readFileSync(path.join(root,'tests/fixtures/comfy-h3-t2va.api.json'),'utf8');
 const parsed=workflow.parseComfyWorkflow(fixture,{id:'test',name:'Test H3'});
 const config={baseUrl:'http://127.0.0.1:8188',workflowJson:fixture,workflowName:'Test H3',revision:1};
 let imageCount=2,latest;
 function Harness(){const [value,setValue]=React.useState({mode:'text',duration:4,megapixels:.2});
  latest=workflow.compileComfyWorkflow(parsed,{...value,prompt:'Synthetic sphere.',references:Array.from({length:imageCount},(_,i)=>({kind:'image',mediaUrl:`C:/${i}.png`}))});
  return React.createElement(controls.CanvasComfyUiControls,{config,value,imageCount,onChange:patch=>setValue(v=>({...v,...patch}))});}
 const host=document.querySelector('#root'),app=createRoot(host);
 try{
  await React.act(async()=>app.render(React.createElement(Harness)));
  assert.equal(host.querySelector('.canvas-comfy-modes'),null);
  assert.equal(latest.prompt['307'].inputs.task_type,'auto');
  assert.equal(Object.values(latest.prompt).filter(n=>n.class_type==='LoadImage').length,2);
  assert.doesNotMatch(host.textContent,/请选择已安装的 Ref2VA/);
  await React.act(async()=>host.querySelector('button[aria-label="调整"]').click());
  await open('模型与连接');await React.act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='读取已安装模型').click());
  const model=host.querySelector('select[aria-label="模型"]');
  for(const selected of ['minimax_h3_fl2va_pruned_int8_convrot.safetensors','minimax_h3_ref2va_int8_convrot.safetensors']){
   await React.act(async()=>{model.value=selected;model.dispatchEvent(new Event('change',{bubbles:true}));});
   assert.equal(latest.summary.model,selected);
  }
  await open('调整');for(const count of [9,0,1]){imageCount=count;await React.act(async()=>app.render(React.createElement(Harness)));assert.equal(Object.values(latest.prompt).filter(n=>n.class_type==='LoadImage').length,count);assert.equal(!!host.querySelector('select[aria-label="参考图精度"]'),count>0);}
 }finally{await React.act(async()=>app.unmount());dom.window.close();delete global.IS_REACT_ACT_ENVIRONMENT;for(const [key,descriptor]of saved)descriptor?Object.defineProperty(global,key,descriptor):delete global[key];}
});

test('preset selection keeps the imported workflow and shows image and video options without submitting',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'}),saved=new Map();
 for(const key of ['window','document','Node','HTMLElement','Event','MouseEvent']){saved.set(key,Object.getOwnPropertyDescriptor(global,key));Object.defineProperty(global,key,{configurable:true,writable:true,value:dom.window[key]});}
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=require(path.join(deps,'react-dom/client'));let checks=0;
 const controls=compile('src/features/canvas/CanvasComfyUiControls.tsx',{'../../core/canvas/comfyWorkflow':workflow,'../../core/canvas/workFisherPreset':preset,'../../core/services/canvasComfyUi':{canvasComfyUiClient:{preflight:async()=>{checks++;return {missingClasses:['MissingSyntheticNode'],missingModels:[],invalidInputs:[],installedUnetModels:[]};}}}});
 const fixture=fs.readFileSync(path.join(root,'tests/fixtures/comfy-h3-t2va.api.json'),'utf8');const config={baseUrl:'http://127.0.0.1:8188',workflowJson:fixture,workflowName:'Original H3',revision:1};
 let selected,lockedKind;
 function Harness(){const [value,setValue]=React.useState({});selected=value;const onChange=patch=>setValue(v=>({...v,...patch}));
  return preset.isWorkFisherImagePreset(value.preset)?React.createElement(controls.CanvasComfyUiImageControls,{config,preset:value.preset,value,onChange,imageCount:1,english:false,lockedKind}):React.createElement(controls.CanvasComfyUiControls,{config,value,onChange,imageCount:2,lockedKind});}
 const host=document.querySelector('#root'),app=createRoot(host);
 const choose=async value=>{const select=host.querySelector('select[aria-label="工作流预设"]');await React.act(async()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});};
 try {
  await React.act(async()=>app.render(React.createElement(Harness)));assert.equal(checks,0);
  await choose('work-fisher-video');assert.equal(selected.preset,'work-fisher-video');assert.match(host.textContent,/短剧 · 有声视频/);
  await React.act(async()=>host.querySelector('button[aria-label="调整"]').click());
  await open('LoRA');const mystic=host.querySelector('select[aria-label="LoRA模型 288"]').closest('.canvas-comfy-lora-row');assert.equal(mystic.querySelector('input[type=checkbox]').checked,false);
  await choose('work-fisher-character');assert.match(host.textContent,/短剧 · 角色图/);assert.equal(checks,0);
  await choose('work-fisher-three-view');assert.match(host.textContent,/短剧 · 三视图/);assert.equal(checks,0);
  await open('模型与连接');await React.act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='检查环境').click());
  assert.equal(checks,1);assert.match(host.textContent,/MissingSyntheticNode/);
  await choose('configured');assert.equal(selected.preset,'configured');assert.equal(config.workflowJson,fixture);assert.equal(host.querySelector('select[aria-label="工作流预设"]').value,'configured');assert.equal(host.querySelector('.canvas-comfy-selected'),null);
  lockedKind='video';await React.act(async()=>app.render(React.createElement(Harness)));
  assert.equal(host.querySelector('option[value="work-fisher-character"]').disabled,true);
  await choose('work-fisher-character');assert.equal(selected.preset,'configured');
  await choose('work-fisher-video');assert.equal(selected.preset,'work-fisher-video');
  lockedKind=undefined;await React.act(async()=>app.render(React.createElement(Harness)));await choose('work-fisher-character');
  lockedKind='image';await React.act(async()=>app.render(React.createElement(Harness)));
  assert.equal(host.querySelector('option[value="work-fisher-video"]').disabled,true);
  await choose('work-fisher-video');assert.equal(selected.preset,'work-fisher-character');
  await choose('work-fisher-scene');assert.equal(selected.preset,'work-fisher-scene');
 } finally {await React.act(async()=>app.unmount());dom.window.close();delete global.IS_REACT_ACT_ENVIRONMENT;for(const [key,descriptor] of saved)descriptor?Object.defineProperty(global,key,descriptor):delete global[key];}
});


test('connection settings show the built-in suite and imported H3 separately without submitting',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'}),saved=new Map();
 for(const key of ['window','document','Node','HTMLElement','Event','MouseEvent','localStorage']){saved.set(key,Object.getOwnPropertyDescriptor(global,key));Object.defineProperty(global,key,{configurable:true,writable:true,value:dom.window[key]});}
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=require(path.join(deps,'react-dom/client'));let writes=0,checks=0;
 const fixture=fs.readFileSync(path.join(root,'tests/fixtures/comfy-h3-t2va.api.json'),'utf8');
 const config={baseUrl:'http://127.0.0.1:8188',workflowJson:fixture,workflowName:'Original H3',revision:1};
 const client={subscribeCanvasComfyUiConfig:()=>()=>{},canvasComfyUiClient:{get:async()=>config,saveWorkflow:async()=>{writes++;return config;},preflight:async()=>{checks++;return {ready:true,missingClasses:[],missingModels:[],invalidInputs:[]};}}};
 const templateCore=compile('src/core/canvas/comfyTemplate.ts');
 const templateStore=compile('src/core/canvas/comfyTemplateStore.ts',{'./comfyTemplate':templateCore});
 const templates=compile('src/features/canvas/CanvasComfyTemplates.tsx',{'../../core/canvas/comfyTemplate':templateCore,'../../core/canvas/comfyTemplateStore':templateStore,'../../core/services/canvasComfyUi':client});
 const settings=compile('src/features/canvas/CanvasComfyUiSettings.tsx',{'../../core/canvas/comfyWorkflow':workflow,'../../core/services/canvasComfyUi':client,'./CanvasComfyTemplates':templates});
 const host=document.querySelector('#root'),app=createRoot(host);
 try{
  await React.act(async()=>app.render(React.createElement(settings.CanvasComfyUiSettings,{en:false})));
  const cards=host.querySelectorAll('.canvas-comfy-workflow-card');assert.equal(cards.length,2);
  assert.match(cards[0].textContent,/短剧制作/);assert.match(cards[0].textContent,/有声视频/);assert.doesNotMatch(cards[0].textContent,/Original H3/);
  assert.match(cards[1].textContent,/通用 H3/);assert.match(cards[1].textContent,/Original H3/);
  assert.match(host.querySelector('.canvas-template-library').textContent,/我的工作流/);
  assert.equal(checks,0);assert.equal(writes,0);
  await React.act(async()=>[...cards[1].querySelectorAll('button')].find(b=>b.textContent==='检查环境').click());assert.equal(checks,1);assert.equal(writes,0);
  assert.doesNotMatch(host.textContent,/2–3|Ref2VA/);
 }finally{await React.act(async()=>app.unmount());dom.window.close();delete global.IS_REACT_ACT_ENVIRONMENT;for(const [key,descriptor]of saved)descriptor?Object.defineProperty(global,key,descriptor):delete global[key];}
});

test('floating Comfy options stay canvas-bound, mutually exclusive, and preserve edits on close',async()=>{
 const dom=new JSDOM('<div class="canvas-editor-stage"><div id="root"></div></div><button id="outside">Outside</button>',{url:'http://localhost',pretendToBeVisual:true}),saved=new Map();
 for(const key of ['window','document','Node','HTMLElement','Event','MouseEvent','KeyboardEvent']){saved.set(key,Object.getOwnPropertyDescriptor(global,key));Object.defineProperty(global,key,{configurable:true,writable:true,value:dom.window[key]});}
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=require(path.join(deps,'react-dom/client'));let value,checks=0,stageWidth=760,stageHeight=620;
 const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON(){}});
 dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('canvas-editor-stage')?rect(90,80,stageWidth,stageHeight):rect(90+stageWidth-130,80+stageHeight-80,110,30);};
 dom.window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
 const controls=compile('src/features/canvas/CanvasComfyUiControls.tsx',{'../../core/canvas/comfyWorkflow':workflow,'../../core/canvas/workFisherPreset':preset,'../../core/services/canvasComfyUi':{canvasComfyUiClient:{preflight:async()=>{checks++;return {};}}}});
 function Harness(){const [current,setCurrent]=React.useState({seed:42,seedMode:'fixed'});value=current;return React.createElement(controls.CanvasComfyUiImageControls,{config:{baseUrl:'http://127.0.0.1:8188'},preset:'work-fisher-character',value:current,onChange:p=>setCurrent(v=>({...v,...p})),imageCount:0,english:false,floating:true,owner:'synthetic-card'});}
 const host=document.querySelector('#root'),app=createRoot(host);
 try {
  await React.act(async()=>app.render(React.createElement(Harness)));
  assert.equal(host.querySelector('[role=dialog]'),null);
  await open('调整');assert.equal(document.querySelectorAll('[role=dialog]').length,1);assert.equal(host.querySelector('[role=dialog]'),null,'the options are portaled outside the composer scroll clip');
  const input=document.querySelector('input[aria-label="种子"]');
  await React.act(async()=>{const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;setter.call(input,'75');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();});
  await React.act(async()=>document.querySelector('#outside').click());
  assert.equal(value.seed,75,'outside close commits the current numeric draft');assert.equal(document.querySelector('[role=dialog]'),null);
  await open('调整');await open('LoRA');assert.equal(document.querySelectorAll('[role=dialog]').length,1);assert.equal(document.querySelector('[role=dialog]').getAttribute('aria-label'),'LoRA');
  await open('图片尺寸');assert.equal(document.querySelectorAll('[role=dialog]').length,1);
  assert.equal(document.querySelector('select[aria-label="图片尺寸"]'),null,'the size chooser cannot open a white native option menu');
  assert.equal(document.querySelectorAll('.canvas-comfy-size-grid button svg rect').length,9,'workflow, seven real presets and custom have ratio glyphs');
  await React.act(async()=>document.querySelector('.canvas-comfy-size-grid button[aria-label^="16:9 ·"]').click());
  assert.equal(value.width,1280);assert.equal(value.height,720);assert.equal(document.querySelector('.canvas-comfy-size-grid button[aria-pressed=true]').getAttribute('aria-label'),'16:9 · 1280 × 720');
  stageWidth=270;stageHeight=270;await React.act(async()=>window.dispatchEvent(new Event('resize')));
  const layer=document.querySelector('.canvas-composer-floating-layer');assert.equal(layer.dataset.canvasComposerOwner,'synthetic-card');
  assert.equal(parseFloat(layer.style.width),246);assert(parseFloat(layer.style.left)>=12);assert(parseFloat(layer.style.maxHeight)<=stageHeight-24);
  let dragged=false;document.body.addEventListener('pointerdown',()=>dragged=true);
  await React.act(async()=>document.querySelector('[role=dialog]').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})));assert.equal(dragged,false);
  await React.act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(document.activeElement.getAttribute('aria-label'),'图片尺寸');
  await open('调整');assert.equal(document.querySelector('input[aria-label="种子"]').value,'75');
  assert.equal(checks,0,'opening and editing menus does not probe, write configuration, or generate');
 } finally {await React.act(async()=>app.unmount());dom.window.close();delete global.IS_REACT_ACT_ENVIRONMENT;for(const [key,descriptor]of saved)descriptor?Object.defineProperty(global,key,descriptor):delete global[key];}
});
