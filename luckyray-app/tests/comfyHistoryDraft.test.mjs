import test from 'node:test';
import assert from 'node:assert/strict';
import {buildHistoryDraft,historyResultContinuationMessage} from '../src/core/canvas/generationIteration.ts';
import {buildWorkFisherImage} from '../src/core/canvas/workFisherPreset.ts';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const entry=()=>({id:'history-1',taskId:'task-1',kind:'video',status:'succeeded',outputMediaUrl:'asset://video.mp4',request:{kind:'video',prompt:'A sailboat.',model:'local-h3',references:[],duration:10,comfyui:{baseUrl:'http://127.0.0.1:8188',workflowName:'H3',workflow:{'234':{class_type:'PrimitiveStringMultiline',inputs:{value:'A sailboat.'}}}}}});
test('historical local video pins source and a deep clone of the workflow',()=>{
 const source=entry();const before=JSON.stringify(source);
 for(const mode of ['parameters','result']) {
  const draft=buildHistoryDraft(source,mode);assert.equal(draft.generationSource,'comfyui');
  assert.deepEqual(draft.generationComfyWorkflow,source.request.comfyui);assert.notEqual(draft.generationComfyWorkflow,source.request.comfyui);
  draft.generationComfyWorkflow.workflow['234'].inputs.value='new';
  assert.equal(JSON.stringify(source),before);
 }
});
test('online history has no inherited Comfy source or workflow',()=>{
 const source=entry();delete source.request.comfyui;
 const draft=buildHistoryDraft(source,'parameters');assert.equal(draft.generationSource,undefined);assert.equal(draft.generationComfyWorkflow,undefined);
});
test('running historical tasks cannot become new local drafts',()=>{
 const source=entry();source.status='running';assert.equal(buildHistoryDraft(source,'parameters'),null);
});
test('local history preserves the actual edited MP and sampler steps without switching to API', async()=>{
 const {readFileSync}=await import('node:fs');
 const {parseComfyWorkflow,compileComfyWorkflow,getComfyWorkflowDefaults}=await import('../src/core/canvas/comfyWorkflow.ts');
 const workflow=parseComfyWorkflow(readFileSync(new URL('./fixtures/comfy-h3-t2va.api.json',import.meta.url),'utf8'),{id:'test',name:'H3'});
 const compiled=compileComfyWorkflow(workflow,{prompt:'A sailboat.',megapixels:.2,videoSteps:6,audioSteps:8});
 const source=entry();source.request.comfyui.workflow=compiled.prompt;
 const draft=buildHistoryDraft(source,'parameters');
 assert.equal(draft.generationSource,'comfyui');
 const defaults=getComfyWorkflowDefaults(parseComfyWorkflow(JSON.stringify(draft.generationComfyWorkflow.workflow),{id:'restored',name:'H3'}));
 assert.equal(defaults.megapixels,.2);assert.equal(defaults.videoSteps,6);assert.equal(defaults.audioSteps,8);
 assert.equal(draft.generationTask,undefined,'restoring parameters must not submit a job');
});
test('text-only character and scene outputs cannot create an unusable image-reference draft',()=>{
 for(const preset of ['work-fisher-character','work-fisher-scene']) {
  const graph=buildWorkFisherImage({preset,prompt:'original',referenceCount:0,width:512,height:768,seed:42});
  const source={...entry(),kind:'image',outputMediaUrl:'/result.png',request:{kind:'image',prompt:'original',model:'local',references:[],comfyui:{baseUrl:'http://127.0.0.1:8188',workflowName:preset,workflow:graph}}};
  const original=JSON.stringify(source);assert.match(historyResultContinuationMessage(source),/不能直接以结果图继续修改/);assert.equal(buildHistoryDraft(source,'result'),null);
  const parameters=buildHistoryDraft(source,'parameters');assert.equal(parameters.generationSource,'comfyui');assert.deepEqual(parameters.generationComfyWorkflow,source.request.comfyui);assert.notEqual(parameters.generationComfyWorkflow,source.request.comfyui);assert.equal(JSON.stringify(source),original);
 }
});
test('three-view results can still become a new local reference draft',()=>{
 const graph=buildWorkFisherImage({preset:'work-fisher-three-view',prompt:'original',referenceCount:1,seed:9});
 const source={...entry(),kind:'image',outputMediaUrl:'/result.png',request:{kind:'image',prompt:'original',model:'local',references:[{id:'old',kind:'image',role:'reference',label:'old',mediaUrl:'/input.png'}],comfyui:{baseUrl:'http://127.0.0.1:8188',workflowName:'views',workflow:graph}}};
 assert.equal(historyResultContinuationMessage(source),'');const draft=buildHistoryDraft(source,'result');assert.equal(draft.generationReferences[0].mediaUrl,'/result.png');assert.deepEqual(draft.generationComfyWorkflow,source.request.comfyui);assert.equal(draft.generationSource,'comfyui');
});
test('history entry blocks the unsupported draft before mutating the canvas and explains why',()=>{
 const graph=buildWorkFisherImage({preset:'work-fisher-character',prompt:'original',referenceCount:0});
 const sourceEntry={...entry(),kind:'image',outputMediaUrl:'/result.png',request:{kind:'image',prompt:'original',model:'local',references:[],comfyui:{baseUrl:'http://127.0.0.1:8188',workflowName:'character',workflow:graph}}};
 const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8'),start=source.indexOf('  const createGenerationDraft = useCallback('),end=source.indexOf('  const restoreGenerationHistoryResult',start);assert.ok(start>=0&&end>start);
 const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild');
 const code=transformSync(source.slice(start,end),{loader:'ts',target:'es2022'}).code;let notice='',mutations=0,builds=0;
 const env={useCallback:fn=>fn,currentCanvasIdRef:{current:'canvas'},loadingCanvas:false,generationHistoryRef:{current:[sourceEntry]},historyResultContinuationMessage,locale:'zh-CN',setGenerationHistoryNotice:value=>{notice=value;},uiSettings:{noteReferenceIncludeTitle:true},buildHistoryDraft:()=>{builds++;},t:()=>'',getViewportCreatePosition:()=>({x:0,y:0}),commitHistory:()=>{mutations++;},markDirty:()=>{mutations++;}};
 const create=Function('env',`const {${Object.keys(env).join(',')}}=env;${code};return createGenerationDraft;`)(env);
 assert.equal(create(sourceEntry,'result'),null);assert.match(notice,/不能直接以结果图继续修改/);assert.equal(builds,0);assert.equal(mutations,0);
});
