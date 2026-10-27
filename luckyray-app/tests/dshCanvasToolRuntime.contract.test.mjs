import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve,sep,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createCanvasAgentService} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs';
import {CREATION_SCHEMAS} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-creation-schema.mjs';

const revision='0123456789abcdef';
const context=()=>({version:1,canvasId:'canvas-tool-runtime',canvasName:'Synthetic only',nodes:[{id:'source',kind:'text',title:'Synthetic',text:'Synthetic text',editable:true,revision}],connections:[],generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}});
const creation=completion=>({version:1,revision,scope:'overview',offset:0,total:0,items:[],completion});
const edit=()=>({expectedRevision:revision,operation:{op:'shot.update',boardId:'board-1',shotId:'shot-1',fields:{title:'Synthetic',lighting:'Synthetic light',sound:'Synthetic sound',durationSeconds:5,framing:'medium'}}});
const plan=()=>({title:'Synthetic',summary:'No generation',steps:[{id:'text-1',kind:'text',title:'Synthetic',content:'Synthetic draft',references:[]}]});
const textOf=m=>(m?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const cases=[
 {name:'legal single operation executes unchanged through installed DSH',tool:'canvas_edit_creation',args:edit(),valid:true},
 {name:'legal mixed batch executes unchanged through installed DSH',tool:'canvas_edit_creation',args:{expectedRevision:revision,operations:[edit().operation,{op:'director.edit',boardId:'board-1',change:{action:'camera.update',patch:{position:[0,1,4]}}}]},valid:true},
 {name:'batch accepts its declared maximum of 64 operations',tool:'canvas_edit_creation',args:{expectedRevision:revision,operations:Array.from({length:64},()=>edit().operation)},valid:true},
 {name:'both operation selectors stay mutually exclusive',tool:'canvas_edit_creation',args:{...edit(),operations:[edit().operation]},issue:'$',rule:'oneOf'},
 {name:'neither operation selector stays rejected',tool:'canvas_edit_creation',args:{expectedRevision:revision},issue:'$',rule:'oneOf'},
 {name:'unexpected root field stays rejected without stripping',tool:'canvas_edit_creation',args:{...edit(),SECRET_API_KEY:'PRIVATE_VALUE'},issue:'$.*',rule:'additionalProperties'},
 {name:'unexpected nested field stays rejected without stripping',tool:'canvas_edit_creation',args:{...edit(),operation:{...edit().operation,fields:{title:'Synthetic',SECRET_API_KEY:'PRIVATE_VALUE'}}},issue:'$.operation.fields.*',rule:'additionalProperties'},
 {name:'malformed revision stays rejected before any host action',tool:'canvas_edit_creation',args:{...edit(),expectedRevision:'invalid'},issue:'$.expectedRevision',rule:'constraints'},
 {name:'empty batch stays rejected',tool:'canvas_edit_creation',args:{expectedRevision:revision,operations:[]},issue:'$.operations',rule:'itemCount'},
 {name:'batch over 64 operations stays rejected',tool:'canvas_edit_creation',args:{expectedRevision:revision,operations:Array.from({length:65},()=>edit().operation)},issue:'$.operations',rule:'itemCount'},
 {name:'plan mode cannot execute a valid single edit',tool:'canvas_edit_creation',args:edit(),mode:'plan',denied:'canvas-agent-execution-unauthorized'},
 {name:'plan mode cannot execute a valid batch',tool:'canvas_edit_creation',args:{expectedRevision:revision,operations:[edit().operation]},mode:'plan',denied:'canvas-agent-execution-unauthorized'},
 {name:'Gemini missing op is visible to provider and can be corrected',tool:'canvas_edit_creation',args:{expectedRevision:revision,operation:{type:'storyboard.create',name:'Synthetic'}},issue:'$.operation.op',rule:'required',corrected:{expectedRevision:revision,operation:{op:'storyboard.create',name:'Synthetic',nodeIds:[]}}},
 {name:'DeepSeek extra kind is visible to provider and can be corrected',tool:'canvas_edit_creation',args:{...edit(),operation:{...edit().operation,kind:'image'}},issue:'$.operation.kind',rule:'additionalProperties',corrected:edit()},
 {name:'batch missing op keeps field diagnostics and can be corrected',tool:'canvas_edit_creation',args:{expectedRevision:revision,operations:[{type:'storyboard.create',name:'Synthetic'}]},issue:'$.operations[].op',rule:'required',corrected:{expectedRevision:revision,operations:[{op:'storyboard.create',name:'Synthetic'}]}},
 {name:'Director missing action stays rejected with a precise correction hint',tool:'canvas_edit_creation',args:{expectedRevision:revision,operation:{op:'director.edit',boardId:'board-1',change:{patch:{position:[0,1,4]}}}},issue:'$.operation.change.action',rule:'required',corrected:{expectedRevision:revision,operation:{op:'director.edit',boardId:'board-1',change:{action:'camera.update',patch:{position:[0,1,4]}}}}},
 {name:'Director batch private keys remain redacted at the nested path',tool:'canvas_edit_creation',args:{expectedRevision:revision,operations:[{op:'director.edit',boardId:'board-1',change:{action:'camera.update',patch:{SECRET_API_KEY:'PRIVATE_VALUE'}}}]},issue:'$.operations[].change.patch.*',rule:'additionalProperties'},
 {name:'field type errors reach actual provider messages',tool:'canvas_edit_creation',args:{...edit(),operation:{...edit().operation,fields:{durationSeconds:'PRIVATE_VALUE'}}},issue:'$.operation.fields.durationSeconds',rule:'type'},
 {name:'unknown sensitive keys and values never enter actual tool feedback',tool:'canvas_edit_creation',args:{...edit(),operation:{...edit().operation,SECRET_API_KEY:'PRIVATE_VALUE'}},issue:'$.operation.*',rule:'additionalProperties'},
 {name:'read context business failure is a real tool error',tool:'canvas_read_context',args:{},failure:'canvas-agent-context-stale'},
 {name:'read creation business failure is a real tool error',tool:'canvas_read_creation',args:{scope:'shots',objectId:'board-1'},failure:'canvas-agent-creation-missing-board'},
 {name:'open delivery business failure is a real tool error',tool:'canvas_open_creation',args:{expectedRevision:revision,panel:'delivery'},failure:'canvas-agent-creation-select-media'},
 {name:'graph business failure is a real tool error',tool:'canvas_edit_graph',args:{operations:[{op:'move',nodeId:'source',x:10,y:20}]},failure:'canvas-agent-node-busy'},
 {name:'apply unknown failure does not reveal receipt prose',tool:'canvas_apply_plan',args:plan(),failure:'PRIVATE_VALUE',expectedCode:'canvas-agent-action-failed'},
 {name:'generate failed receipt blocks duplicate and changed retries',tool:'canvas_generate_plan',args:plan(),failure:'canvas-agent-context-stale',retry:true},
 {name:'applied unconfirmed sets handoff before throwing',tool:'canvas_edit_creation',args:{expectedRevision:revision,operation:{op:'storyboard.create',name:'Synthetic'}},unconfirmed:true},
 {name:'awaiting user remains a successful handoff not a completed export',tool:'canvas_open_creation',args:{expectedRevision:revision,panel:'storyboardExport'},waiting:true},
];

test('installed DSH 0.2.1-rc.2 serializes field diagnostics and business failures through its real tools loop',{
 skip:!process.env.DSH_CANVAS_TEST_NODE_MODULES,timeout:60000,
},async t=>{
 const modules=process.env.DSH_CANVAS_TEST_NODE_MODULES;
 const load=name=>import(pathToFileURL(join(modules,'@deepseek-ai',name,'lib/index.js')).href);
 assert.equal(JSON.parse(await readFile(join(modules,'@deepseek-ai/dsh-agent/package.json'),'utf8')).version,'0.2.1-rc.2');
 const {Context}=await load('cordis'),{LlmAdapter}=await load('dsh-llm');
 for(const scenario of cases)await t.test(scenario.name,async t=>{
  const root=await mkdtemp(join(tmpdir(),'canvas-tool-runtime-')),ctx=new Context();let service;
  t.after(async()=>{await service?.dispose();await ctx.fiber.dispose();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('canvas-tool-runtime-'));await rm(root,{recursive:true,force:true});});
  for(const name of ['dsh-llm','dsh-session','dsh-session-projection','dsh-agent','dsh-system-prompt','dsh-tools','dsh-agent-loop'])await ctx.plugin((await load(name)).default,{});
  await ctx.plugin(await load('dsh-session-persistence-jsonl'),{root:join(root,'sessions'),compression:'none'});
  ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'canvas-offline-contract',model:'synthetic'})});
  let cursor=0,providerFeedback=0,projectedCreationTool;const feedback=[];
  const commands=[{name:scenario.tool,args:scenario.args}];
  if(scenario.corrected)commands.push({name:scenario.tool,args:scenario.corrected});
  if(scenario.retry)commands.push({name:scenario.tool,args:scenario.args},{name:scenario.tool,args:{...plan(),summary:'A distinct synthetic intent'}});
  if(scenario.unconfirmed||scenario.waiting)commands.push({name:'canvas_read_creation',args:{scope:'overview'}});
  class Provider extends LlmAdapter{
   async listModels(provider){return[{provider,id:'synthetic',name:'Offline synthetic',inputModalities:['text']}];}
   async resolveModel(provider,id){return{provider,id,name:'Offline synthetic',inputModalities:['text']};}
   async *stream(options){
    assert.equal(options.provider,'canvas-offline-contract');assert.equal(options.model,'synthetic');
    projectedCreationTool ??= options.tools?.find(tool=>tool.name==='canvas_edit_creation');
    if(cursor>0){const message=options.messages.filter(m=>m.role==='tool').at(-1);assert.ok(message,'actual runtime must return its tool result to the next provider request');feedback.push(message);providerFeedback++;
     if(cursor===1){const text=textOf(message);
      if(scenario.issue){assert.equal(message.isError,true);assert.ok(text.includes(scenario.issue));assert.ok(text.includes(scenario.rule));assert.ok(!/PRIVATE_VALUE|SECRET_API_KEY/.test(text));}
      else if(scenario.waiting||scenario.valid){assert.equal(message.isError,false);assert.ok(text.includes(scenario.waiting?'awaiting-user':'applied'));}
      else{assert.equal(message.isError,true);assert.ok(text.includes(scenario.unconfirmed?'stop-await-user':scenario.denied||scenario.expectedCode||scenario.failure));assert.ok(!text.includes('PRIVATE_VALUE'));}
     }
    }
    const command=commands[cursor++];
    if(command){yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:'call-'+cursor,name:command.name,arguments:JSON.stringify(command.args)}};yield{type:'finish',reason:{kind:'tool-calls'}};}
    else{yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'Offline contract finished; no model or media request.'}};yield{type:'finish',reason:{kind:'stop'}};}
   }
  }
  ctx.llm.registerAdapter(['canvas-offline-contract'],new Provider());
  service=createCanvasAgentService(ctx,{stateDirectory:join(root,'canvas')});
  const canvasId='canvas-tool-runtime',conversationId='legacy-'+createHash('sha256').update(canvasId).digest('hex').slice(0,32);
  await service.dispatch({op:'start',canvasId,conversationId,requestId:'request-'+cases.indexOf(scenario),prompt:'Synthetic contract only',context:context(),execution:{mode:scenario.mode||'autonomous',allowGeneration:!!scenario.retry,maxMediaJobs:0}});
  const actions=[],seen=new Set();let state;
  const deadline=Date.now()+10000;
  do{
   state=await service.dispatch({op:'status',canvasId});
   if(state.pendingAction&&!seen.has(state.pendingAction.actionId)){
    const a=state.pendingAction;seen.add(a.actionId);actions.push(a.kind);
    if(scenario.valid)assert.deepEqual(a.creationEdit,scenario.args,'valid payload must reach the host unchanged');
    const failed=!!scenario.failure||scenario.unconfirmed;
    const result={status:failed?'failed':'completed',summary:scenario.failure||(scenario.unconfirmed?'PRIVATE_VALUE':'Synthetic receipt'),generatedJobs:0,context:context(),...(a.kind==='editCreation'?{creation:creation(scenario.unconfirmed?'applied-unconfirmed':'applied')}:scenario.waiting?{creation:creation('awaiting-user')}:{})};
    await service.dispatch({op:'actionResult',canvasId,runId:state.runId,actionId:a.actionId,result});
   }
   if(state.status!=='running'&&!service.hasActiveRuns())break;
   await new Promise(r=>setTimeout(r,5));
  }while(Date.now()<deadline);
  assert.equal(state.status,'completed');assert.equal(service.hasActiveRuns(),false);assert.equal(providerFeedback,commands.length);
  assert.ok(projectedCreationTool,'installed DSH must expose the creative editing tool to the provider');
  const schema=projectedCreationTool.parameters;
  assert.equal(schema.type,'object','DeepSeek requires an object-root model-facing declaration');
  assert.equal(Object.hasOwn(schema,'oneOf'),false,'do not combine type with a root oneOf');
  assert.deepEqual(Object.keys(schema.properties).sort(),['expectedRevision','operation','operations']);
  assert.deepEqual(schema.required,['expectedRevision']);assert.equal(schema.additionalProperties,false);
  assert.deepEqual(schema.properties.expectedRevision,CREATION_SCHEMAS.edit.oneOf[0].properties.expectedRevision);
  assert.deepEqual(schema.properties.operation,CREATION_SCHEMAS.edit.oneOf[0].properties.operation);
  assert.deepEqual(schema.properties.operations,CREATION_SCHEMAS.edit.oneOf[1].properties.operations);
  assert.match(schema.description,/exactly one of.*operation.*operations/i);
  const stored=await ctx.sessionPersistence.open(state.sessionId,'read');let events;try{events=(await stored.read()).events;}finally{await stored.close();}
  const results=events.filter(e=>e.type==='tool/result');assert.equal(results.length,commands.length);
  assert.equal(results[0].data.message.isError,!!(scenario.issue||scenario.failure||scenario.unconfirmed||scenario.denied));
  assert.equal(state.tools[0].status,scenario.waiting||scenario.valid?'completed':'failed');
  if(scenario.corrected){assert.equal(actions.length,1);assert.equal(results[1].data.message.isError,false);assert.equal(state.tools[1].status,'completed');}
  else if(scenario.issue||scenario.denied)assert.equal(actions.length,0,'bad input or denied permission must not execute a host action');
  else assert.equal(actions.length,1,'failed, duplicate or handed-off calls must not be resubmitted');
  if(scenario.retry||scenario.unconfirmed||scenario.waiting)assert.ok(results.slice(1).every(e=>e.data.message.isError));
  console.log('DSH_TOOL_RUNTIME '+JSON.stringify({case:scenario.name,session:state.sessionId,actions,providerFeedback,results:results.map(e=>({isError:e.data.message.isError,callId:e.data.message.toolCallId})),uiStatuses:state.tools.map(e=>e.status),networkCalls:0,mediaJobs:0}));
 });
});
