import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createCanvasAgentService} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs';
import {validateCanvasAgentResult} from '../src-tauri/dsh-host/luckyray-dsh-host.mjs';

test('installed 0.2.2 tool registry accepts the full Canvas setup without a model request', {
 skip:!process.env.DSH_M1_RUNTIME_ROOT, timeout:15000,
},async()=>{
 const packages=join(process.env.DSH_M1_RUNTIME_ROOT,'host/node_modules/@deepseek-ai');
 const load=name=>import(pathToFileURL(join(packages,name,'lib/index.js')).href);
 const [{Context},{default:SystemPrompt},{default:ToolsService},{createScope}]=await Promise.all([
  load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-scope')]);
 const root=new Context();
 const directory=await mkdtemp(join(tmpdir(),'lr-agent-022-setup-'));
 let service,agentCtx,setupComplete=false,followups=0,setupError;
 const savedArg=process.argv[1];
 try{
  root.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false});
  root.plugin(ToolsService,{});
  let ready;
  const available=new Promise(resolve=>{ready=resolve;});
  root.plugin({inject:['tools','systemPrompt'],apply(ctx){ready(ctx);}});
  const ctx=await Promise.race([available,new Promise((_,reject)=>setTimeout(()=>reject(Error('synthetic-services-not-ready')),3000))]);
  ctx.tools.register({name:'outside_canvas',description:'Synthetic forbidden global capability',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',properties:{},additionalProperties:false},render:()=>[{type:'text',text:'Synthetic'}]},execute:async()=>{throw Error('global tool must stay unavailable');}});
  const scope={};agentCtx=createScope(ctx,scope).ctx;
  const model={provider:'synthetic',id:'offline-model',name:'Offline',inputModalities:['text']};
  const services={sessionPersistence:{},sessions:{flush:async()=>{}},
   agentDefaultModel:{currentSelection:()=>({provider:'synthetic',model:model.id})},
   llm:{listProviders:()=>[{id:model.provider,name:'Synthetic'}],listModels:async()=>[model],resolveModelInfo:async()=>model},
   agents:{create:async options=>{
    const agent={id:options.sessionId,session:{id:options.sessionId},followup(){followups++;},cancel(){}};
    try{await options.setup(agentCtx,agent);setupComplete=true;}catch(error){setupError=error;throw error;}
    // Deliberately stop before followup: this fixture verifies real SDK setup,
    // not an invented provider or a credential-bearing model request.
    throw Error('Synthetic setup boundary reached');
   },resume:async()=>{throw Error('unexpected-resume');}}};
  process.argv[1]=join(packages,'dsh/lib/bin.js');
  service=createCanvasAgentService({get:name=>services[name]},{stateDirectory:directory});
  const canvasId='synthetic-022-setup';
  await service.dispatch({op:'start',canvasId,conversationId:'legacy-'+createHash('sha256').update(canvasId).digest('hex').slice(0,32),requestId:'setup-request',prompt:'Synthetic offline setup',context:{version:1,canvasId,canvasName:'Synthetic',nodes:[],connections:[],generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}}});
  for(let i=0;i<200&&service.hasActiveRuns();i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(setupComplete,true,setupError?.message);
  assert.equal(followups,0);
  const failed=await service.dispatch({op:'status',canvasId});
  assert.equal(failed.status,'failed');
  assert.equal(failed.errorDetail.message,'Synthetic setup boundary reached');
  const project=value=>validateCanvasAgentResult(Buffer.from(JSON.stringify(value)).toString('base64url'),canvasId);
  assert.equal(project(failed).status,'failed','the actual terminal receipt must reach the renderer');
  const cancelled=await service.dispatch({op:'cancel',canvasId,runId:failed.runId});
  assert.equal(project(cancelled).status,'failed','stopping an already failed run must acknowledge its terminal state');
  assert.equal(project(await service.dispatch({op:'models',canvasId})).status,'failed','read-only reconnect must preserve the receipt without restarting a task');
  assert.equal(followups,0);
  const definitions=ctx.tools.definitions(scope);
  assert(definitions.length>=10);
  assert(definitions.every(tool=>tool.name.startsWith('canvas_')));
  const schemas=ctx.tools.schemas(scope);
  assert.equal(schemas.length,definitions.length);
  const edit=schemas.find(tool=>tool.name==='canvas_edit_creation');
  assert.equal(edit.parameters.type,'object');
  assert.ok(edit.parameters.properties.operation&&edit.parameters.properties.operations);
  assert.equal(ctx.tools.get('outside_canvas',scope),undefined,'the global tool restriction remains in force');
  const read=await ctx.tools.execute({calls:[{id:'offline-read',name:'canvas_read_task_state',arguments:'{}'}],signal:new AbortController().signal,agent:scope});
  assert.equal(read.results.length,1);
  assert.equal(read.results[0].result.isError,false,JSON.stringify(read.results[0].result));
  assert.equal(typeof agentCtx.tools.presentAs,'undefined','real 0.2.2 removed this legacy method');
 }finally{process.argv[1]=savedArg;await service?.dispose();await root.fiber.dispose();await rm(directory,{recursive:true,force:true});}
});

test('authenticated carrier accepts only validated terminal public error details',()=>{
 const failed={canvasId:'synthetic',conversationId:'conversation-1',sessionId:null,runId:'run-1',status:'failed',messages:[],error:'canvas-agent-runtime-unavailable',errorDetail:{message:'Synthetic setup boundary reached'}};
 const check=value=>validateCanvasAgentResult(Buffer.from(JSON.stringify(value)).toString('base64url'),'synthetic');
 assert.deepEqual(check(failed),failed);
 for(const invalid of [
  {...failed,status:'running'},
  {...failed,errorDetail:{message:'Failed. token: PRIVATE_SENTINEL'}},
  {...failed,errorDetail:{message:'Failed',stack:'PRIVATE_SENTINEL'}},
  {...failed,errorDetail:{message:'x'.repeat(2001)}},
  {...failed,errorDetail:{message:'Failed. C:\\PRIVATE_SENTINEL\\file.txt'}},
 ])assert.throws(()=>check(invalid),/invalid-response/);
 const legacy={...failed};delete legacy.errorDetail;assert.deepEqual(check(legacy),legacy);
});
