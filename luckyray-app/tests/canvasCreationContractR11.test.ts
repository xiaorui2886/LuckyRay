import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CREATION_SCHEMAS,validCreationPayload} from '../src/core/canvas/agent/creationContract.ts';
import {createCanvasActionLedger} from '../src/core/canvas/agent/actionLedger.ts';
import {agentNodeRevision,agentGraphRevision} from '../src/core/canvas/agent/context.ts';
import {projectCanvasAgentSnapshot} from '../src/core/services/canvasAgent.ts';
const rev='0123456789abcdef';
const context={version:1,canvasId:'canvas-1',canvasName:'test',nodes:[],connections:[],generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}};
const policy={mode:'autonomous' as const,allowGeneration:false,maxMediaJobs:0};
test('R11 exact schema agrees across frontend, pinned adapter, carrier import and Rust',()=>{
 const carrier=readFileSync('src-tauri/dsh-host/luckyray-dsh-host.mjs','utf8');
 assert.match(carrier,/import \{ validCreationPayload \} from "\.\/luckyray-dsh-authenticated-webserver\/luckyray-dsh-canvas-agent\.mjs";/);
 assert.doesNotMatch(carrier,/const CREATION_SCHEMAS = /,'carrier must reuse the pinned validator, not exceed its byte limit');
 for(const path of ['src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs']){
  const source=readFileSync(path,'utf8').replaceAll('\r\n','\n');const match=source.match(/const CREATION_SCHEMAS = (.*);\n/)!;
  assert.deepEqual(JSON.parse(match[1]),CREATION_SCHEMAS,path);
 }
 const rust=readFileSync('src-tauri/src/dsh_host.rs','utf8').match(/const CANVAS_CREATION_SCHEMAS_JSON: &str = r###"(.*?)"###;/)!;
 assert.deepEqual(JSON.parse(rust[1]),CREATION_SCHEMAS);
});
test('R11 full snapshot projection preserves only the correct typed creative action',()=>{
 const common={actionId:'action-1',runId:'run-1',context,execution:policy};
 for(const action of [{kind:'readCreation',creationQuery:{scope:'overview'}},{kind:'editCreation',creationEdit:{expectedRevision:rev,operation:{op:'storyboard.create',name:'Test'}}},{kind:'openCreation',creationOpen:{expectedRevision:'0123456789abcdef',panel:'imageTools',nodeIds:['image-1'],imageIndex:0}}]) {
  const snapshot={canvasId:'canvas-1',conversationId:'conversation-1',sessionId:null,runId:'run-1',status:'running',messages:[],pendingAction:{...common,...action}};
  assert.deepEqual(projectCanvasAgentSnapshot(snapshot,'canvas-1').pendingAction,snapshot.pendingAction);
  for(const patch of [{generate:false},{kind:'readContext'},{creationQuery:{scope:'overview'},creationEdit:{expectedRevision:rev,operation:{op:'storyboard.create',name:'Test'}}}])assert.throws(()=>projectCanvasAgentSnapshot({...snapshot,pendingAction:{...snapshot.pendingAction,...patch}},'canvas-1'));
 }
});
test('R11 creative action ledger enforces permission, run policy and at-most-once execution',async()=>{
 for(const kind of ['editCreation','openCreation']) {
  const ledger=createCanvasActionLedger<number>();let writes=0;
  const action={actionId:'action',runId:'run',kind,execution:policy};
  await assert.rejects(ledger.run({...action,execution:undefined},async()=>++writes),/authorized/);
  await assert.rejects(ledger.run({...action,execution:{...policy,mode:'plan'}},async()=>++writes),/authorized/);
  const a=ledger.run(action,async()=>++writes),b=ledger.run(action,async()=>++writes);assert.equal(a,b);assert.equal(await a,1);
  await assert.rejects(ledger.run({...action,actionId:'other',execution:{...policy,maxMediaJobs:1}},async()=>++writes),/policy-changed/);
  await assert.rejects(ledger.run({...action,actionId:'generate',generate:true},async()=>++writes),/authorized/);
  assert.equal(writes,1);assert.equal(ledger.reserved('run'),0);
 }
});
test('R11 context revisions include creative metadata, dimensions and reference semantics',()=>{
 const node={id:'n',position:{x:0,y:0},data:{kind:'group',label:'n'}};
 const base=agentNodeRevision(node);
 for(const data of [{referencePack:{version:1,kind:'style'}},{storyboard:{version:1,sourceScript:'changed'}},{storyboardShot:{version:1,title:'updated'}}])assert.notEqual(agentNodeRevision({...node,data:{...node.data,...data}}),base);
 assert.notEqual(agentNodeRevision({...node,style:{width:200}}),base);
 assert.notEqual(agentGraphRevision([node],[{source:'a',target:'b',data:{role:'reference'}}]),agentGraphRevision([node],[{source:'a',target:'b',data:{role:'firstFrame'}}]));
});
test('R11 transform limits, page revision and operation-specific recipe options fail closed',()=>{
 const imageEdit={turns:0,flipX:false,flipY:false,crop:{x:0,y:0,width:1,height:1},width:100,height:100};
 assert.ok(validCreationPayload({expectedRevision:'0123456789abcdef',panel:'imageTools',imageIndex:63,imageEdit},'open'));
 for(const value of [{expectedRevision:'0123456789abcdef',panel:'imageTools',imageIndex:64},{expectedRevision:'0123456789abcdef',panel:'delivery',imageIndex:0},{expectedRevision:'0123456789abcdef',panel:'imageTools',imageEdit:{...imageEdit,width:8192,height:8192}},{expectedRevision:'0123456789abcdef',panel:'imageTools',imageEdit:{...imageEdit,crop:{x:.9,y:0,width:.5,height:1}}}])assert.equal(validCreationPayload(value,'open'),false);
 assert.equal(validCreationPayload({scope:'review',offset:32},'read'),false);
 assert.ok(validCreationPayload({scope:'review',offset:32,expectedRevision:rev},'read'));
 assert.equal(validCreationPayload({expectedRevision:rev,operation:{op:'generator.recipe',nodeId:'n',recipe:{version:1,id:'relight',options:{grid:'2x2'}}}},'edit'),false);
});
test('R11 complete script readback requires an explicit board and revision-bound continuation',()=>{
 assert.ok(validCreationPayload({scope:'scriptText',objectId:'board-1'},'read'));
 assert.ok(validCreationPayload({scope:'scriptText',objectId:'board-1',offset:32,expectedRevision:'0123456789abcdef'},'read'));
 assert.equal(validCreationPayload({scope:'scriptText'},'read'),false);
 assert.equal(validCreationPayload({scope:'scriptText',objectId:'board-1',offset:32},'read'),false);
});
