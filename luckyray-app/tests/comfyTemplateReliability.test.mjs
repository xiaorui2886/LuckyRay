import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {compileComfyTemplate,readComfyTemplate} from '../src/core/canvas/comfyTemplate.ts';
import {createCanvasGenerationTask,resumeCanvasVideoGenerationTask,canRetryCanvasGenerationTask,transitionCanvasGenerationTask} from '../src/core/canvas/generationTasks.ts';

const template=()=>readComfyTemplate({format:'luckyray.comfy-template',version:1,id:'tpl-video-reliability',name:'Synthetic custom video',
  graph:{'501':{class_type:'SyntheticEncoder',inputs:{text:'original',width:608,height:352,frames:97,seed:19,steps:6,audio_steps:8}},
    '777':{class_type:'VHS_VideoCombine',inputs:{images:['501',0],audio:['501',1],frame_rate:24,format:'video/h264-mp4',filename_prefix:'fixture',save_output:true}},
    '999':{class_type:'SaveImage',inputs:{images:['501',0],filename_prefix:'unselected'}}},
  prompt:{nodeId:'501',input:'text'},images:[],parameters:[['501','width','宽度'],['501','height','高度'],['501','frames','帧数'],['501','seed','种子'],['501','steps','采样步数'],['777','frame_rate','帧率']].map(([nodeId,input,label])=>({nodeId,input,label})),output:{nodeId:'777',kind:'video'}});

test('custom video keeps explicit numeric bindings, audio and the selected output branch',()=>{
  const t=template(),original=JSON.stringify(t);
  const result=compileComfyTemplate(t,'Synthetic connected text and note',0,{'501:width':512,'501:height':288,'501:frames':81,'501:seed':42,'501:steps':4,'777:frame_rate':20});
  assert.deepEqual(result.graph['501'].inputs,{text:'Synthetic connected text and note',width:512,height:288,frames:81,seed:42,steps:4,audio_steps:8});
  assert.equal(result.graph['777'].inputs.frame_rate,20);assert.deepEqual(result.graph['777'].inputs.audio,['501',1]);
  assert.deepEqual(result.output,{nodeId:'777',kind:'video'});assert.equal(result.graph['999'],undefined);
  assert.equal(JSON.stringify(t),original,'author workflow and unbound settings never mutate');
  assert.throws(()=>compileComfyTemplate(t,'x',0,{'501:frames':'81'}),/格式/);
});

test('saved custom video request stays frozen and resumes the same task/node/output after disconnect',()=>{
  const t=template(),execution=compileComfyTemplate(t,'Synthetic',0,{'501:seed':42});
  const task=createCanvasGenerationTask({id:'synthetic-template-task',sourceNodeId:'source-card',resultNodeId:'result-card',createdAt:'2026-01-01T00:00:00Z',request:{kind:'video',prompt:'Synthetic',model:t.name,references:[],comfyui:{baseUrl:'http://127.0.0.1:8188',workflowName:t.name,workflow:execution,template:t}}});
  execution.graph['501'].inputs.seed=999;t.graph['501'].inputs.width=4096;
  const saved=JSON.parse(JSON.stringify({...task,status:'failed',providerTaskId:'original-prompt',error:{code:'COMFY_OBSERVATION_INTERRUPTED',message:'Synthetic disconnect',retryable:true}}));
  const resumed=resumeCanvasVideoGenerationTask(saved,'2026-01-01T00:01:00Z');
  assert.equal(resumed.id,task.id);assert.equal(resumed.providerTaskId,'original-prompt');assert.equal(resumed.sourceNodeId,'source-card');assert.equal(resumed.resultNodeId,'result-card');
  assert.equal(resumed.request.comfyui.workflow.graph['501'].inputs.seed,42);assert.equal(resumed.request.comfyui.template.graph['501'].inputs.width,608);
  for(const code of ['SUBMISSION_UNKNOWN','VIDEO_SUBMISSION_UNKNOWN','SUBMISSION_BINDING_CHANGED'])assert.equal(canRetryCanvasGenerationTask({...saved,error:{...saved.error,code}}),false);
  assert.equal(resumeCanvasVideoGenerationTask({...saved,error:{...saved.error,code:'COMFY_EXECUTION_FAILED'}},saved.updatedAt),null);
});

test('actual Canvas reload reconciliation keeps original custom-video identity and schedules once',()=>{
  const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8').replaceAll('\r\n','\n');
  const start=source.lastIndexOf('  useEffect(() => {',source.indexOf('    const recoveredTasks = new Map<string, CanvasGenerationTask>();'));
  const end=source.indexOf('\n  const openNodeReference',start);
  assert.ok(start>0&&end>start);
  const require=createRequire(import.meta.url),esbuild=createRequire(require.resolve('vite'))('esbuild');
  const code=esbuild.transformSync(source.slice(start,end),{loader:'ts'}).code;
  const t=template(),request={kind:'video',prompt:'Synthetic',model:t.name,references:[],comfyui:{baseUrl:'http://127.0.0.1:8188',workflowName:t.name,workflow:compileComfyTemplate(t,'Synthetic',0),template:t}};
  const old=createCanvasGenerationTask({id:'original-task',sourceNodeId:'source',resultNodeId:'result',createdAt:'2026-01-01T00:00:00Z',request});
  let nodes=[{id:'source',data:{generationTask:{...old,status:'running',providerTaskId:'provider-original'}}}],executed=[];
  const reserved=new Set(),reconciled=new Set();
  const env={useEffect:fn=>fn(),currentCanvasId:'synthetic-canvas',currentCanvasIdRef:{current:'synthetic-canvas'},loadingCanvas:false,
    generationSchedulerRef:{current:{has:id=>reserved.has(id),reserve:slot=>{if(reserved.has(slot.id))return false;reserved.add(slot.id);return true;},nextWakeDelay:()=>undefined}},
    runningGenerationTaskIdsRef:{current:new Set()},reconciledGenerationTaskIdsRef:{current:reconciled},generationTaskCanvasIdsRef:{current:new Map()},generationSessionStartedAtRef:{current:Date.parse('2026-11-03T00:00:00Z')},
    bridge:{},locale:'zh-CN',t:x=>x,transitionCanvasGenerationTask,markDirty:()=>{},recordGenerationTask:()=>{},setNodes:fn=>{nodes=fn(nodes);},
    queuedGenerationTasks:tasks=>tasks.filter(t=>t?.status==='queued'),generationSlot:task=>({id:task.id}),generationConcurrencyPolicy:{},
    executeGenerationTask:task=>executed.push(task),uiSettings:{},mediaProfiles:null,generationSchedulerVersion:0,setGenerationSchedulerVersion:()=>{}};
  const render=()=>vm.runInNewContext(code,{...env,nodes});
  render();assert.equal(nodes[0].data.generationTask.status,'queued');render();render();
  assert.equal(executed.length,1);assert.equal(executed[0].id,'original-task');assert.equal(executed[0].providerTaskId,'provider-original');
  assert.deepEqual(JSON.parse(JSON.stringify(executed[0].request)),JSON.parse(JSON.stringify(request)));
  assert.equal(executed[0].sourceNodeId,'source');assert.equal(executed[0].resultNodeId,'result');
  nodes=[{...nodes[0],data:{generationTask:{...old,status:'failed',error:{code:'SUBMISSION_UNKNOWN'}}}}];render();assert.equal(executed.length,1,'terminal uncertain tasks cannot restart themselves');
});
