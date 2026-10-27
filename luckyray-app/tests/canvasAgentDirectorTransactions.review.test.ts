import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCreation, creationRevision, readCreation, type CreationState } from '../src/core/canvas/agent/creationEngine';
import { createDirectorDocument } from '../src/core/canvas/director/model';
import { completeCreationMutation } from '../src/core/canvas/agent/creationCommit';
import { createCanvasActionLedger } from '../src/core/canvas/agent/actionLedger';
const seed=():CreationState=>({canvasId:'canvas',nodes:[{id:'board',type:'group',position:{x:0,y:0},data:{kind:'group',label:'Director',storyboard:{version:1},directorDocument:createDirectorDocument()}}] as any,edges:[],history:[]});
const ports={createId:()=> 'new-id',origin:{x:0,y:0}};
const director=(change:any)=>({op:'director.edit' as const,boardId:'board',change});
test('batch preflights every semantic operation on detached state before any live mutation',()=>{
 const source=seed(),before=structuredClone(source);
 assert.throws(()=>applyCreation(source,{expectedRevision:creationRevision(source),operations:[director({action:'camera.update',patch:{focalLength:85}}),director({action:'object.update',objectId:'missing',patch:{name:'No'}})]},ports),/missing-object/);
 assert.deepEqual(source,before);
 const edited=applyCreation(source,{expectedRevision:creationRevision(source),operations:[director({action:'camera.update',patch:{focalLength:85}}),director({action:'lighting.preset',preset:'night'})]},ports);
 assert.deepEqual(source,before);
 const doc=(edited.nodes[0].data as any).directorDocument;
 assert.equal(doc.scene.camera.focalLength,85);assert.equal(doc.scene.lighting.preset,'night');assert.deepEqual(edited.affectedIds,['board']);
});
test('Director scene, shot and export changes invalidate creation revision',()=>{
 const source=seed(),revision=creationRevision(source);
 for(const field of ['scene','shot','export']){
  const changed=structuredClone(source),data=changed.nodes[0].data as any;
  if(field==='scene')data.directorDocument.scene.camera.focalLength=90;
  if(field==='shot')data.directorDocument.shots.push({id:'shot',name:'A',duration:5,notes:'',scene:structuredClone(data.directorDocument.scene)});
  if(field==='export')data.directorShotSource={version:1,shotId:'saved',shot:{id:'saved',name:'Saved',duration:5,notes:'',scene:structuredClone(data.directorDocument.scene)}};
  assert.notEqual(creationRevision(changed),revision);
  assert.throws(()=>applyCreation(changed,{expectedRevision:revision,operations:[director({action:'lighting.preset',preset:'night'})]},ports),/context-stale/);
 }
});
test('same action id executes one transaction and cannot be repurposed for generation',async()=>{
 const ledger=createCanvasActionLedger<number>();let count=0;
 const action={actionId:'action',runId:'run',kind:'editCreation',execution:{mode:'autonomous' as const,allowGeneration:false,maxMediaJobs:0}};
 const execute=async()=>++count;
 assert.deepEqual(await Promise.all([ledger.run(action,execute),ledger.run(action,execute)]),[1,1]);assert.equal(count,1);
 await assert.rejects(ledger.run({...action,generate:true},execute),/conflict/);
 await assert.rejects(ledger.run({...action,actionId:'other',generate:true},execute),/not-authorized/);assert.equal(count,1);assert.equal(ledger.reserved('run'),0);
});
test('post-persistence different creation revision must not claim applied success',async()=>{
 const applied=readCreation(seed(),{scope:'overview'});let persists=0;
 const receipt=await completeCreationMutation({applied,summary:'Edited native scene',affectedIds:['board'],assertCurrent:()=>{},persist:async()=>{persists++;},readAfter:async()=>({creation:{...applied,revision:applied.revision==='aaaaaaaaaaaaaaaa'?'bbbbbbbbbbbbbbbb':'aaaaaaaaaaaaaaaa'},context:{} as any})});
 assert.equal(persists,1);assert.equal(receipt.status,'failed');assert.equal(receipt.creation?.completion,'applied-unconfirmed');
});
test('batch retains per-operation IK achieved targets and residual instead of generic success only',()=>{
 const source=seed(),actor=(source.nodes[0].data as any).directorDocument.scene.objects[0].id;
 const result=applyCreation(source,{expectedRevision:creationRevision(source),operations:[director({action:'pose.ik',objectId:actor,limb:'leftArm',space:'actor-local',target:[100,100,100]}),director({action:'camera.update',patch:{focalLength:85}})]},ports);
 assert.equal(result.operationReceipts?.length,2);assert.equal(result.operationReceipts?.[0].index,0);
 assert.match(result.operationReceipts![0].summary,/residualMetres/);assert.match(result.operationReceipts![0].summary,/worldResidualMetres/);assert.match(result.operationReceipts![0].summary,/"reached":false/);
});
test('revision change during asynchronous context refresh reports uncertain completion',async()=>{
 const applied=readCreation(seed(),{scope:'overview'});let revision=applied.revision;
 const receipt=await completeCreationMutation({applied,summary:'Edited native scene',affectedIds:['board'],assertCurrent:()=>{if(revision!==applied.revision)throw Error('canvas-agent-context-stale');},persist:async()=>{},readAfter:async()=>{const creation={...applied};await Promise.resolve();revision='changed';return {creation,context:{} as any};}});
 assert.equal(receipt.status,'failed');assert.equal(receipt.creation?.completion,'applied-unconfirmed');
});
test('actual CanvasSpike capture preflight rejects predictable errors before renderer or storage',async()=>{
 const {readFileSync}=await import('node:fs');
 const ts=await import('typescript');
 const {sanitizeDirectorDocument}=await import('../src/core/canvas/director/model');
 const {retainDirectorExport}=await import('../src/core/canvas/director/integration');
 const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 const start=source.indexOf('        const expected=edit.expectedRevision;',source.indexOf("const captureOp=edit.operation?.op==='director.capture'"));
 const end=source.indexOf("        const {captureDirectorScene}=await import",start);
 assert.ok(start>0&&end>start);
 // Execute the actual production preflight statements, not a rewritten model.
 // Renderer/storage intentionally outside this extracted prefix; no pixel claims.
 const code=ts.transpileModule(`function preflight(deps:any){const {edit,stillCurrent,creationRevision,readState,nodesRef,captureOp,isStoryboard,sanitizeDirectorDocument,storyboardShots,SHOT_LIMIT,genId,retainDirectorExport}=deps;${source.slice(start,end)}return shot;}`,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
 const preflight=Function(`${code};return preflight;`)();
 const run=(state:CreationState,op:any,count=0)=>preflight({edit:{expectedRevision:creationRevision(state)},stillCurrent:()=>{},creationRevision,readState:()=>state,nodesRef:{current:state.nodes},captureOp:op,isStoryboard:()=>true,sanitizeDirectorDocument,storyboardShots:()=>Array.from({length:count}),SHOT_LIMIT:64,genId:()=> 'new-shot',retainDirectorExport});
 const state=seed(),doc=(state.nodes[0].data as any).directorDocument;
 doc.shots=[{id:'saved',name:'Original',duration:5,notes:'',scene:structuredClone(doc.scene)}];
 assert.throws(()=>run(state,{boardId:'board',shotId:'saved',name:'Changed'}),/invalid-shot/);
 assert.throws(()=>run(state,{boardId:'board',shotId:'missing'}),/missing-shot/);
 assert.throws(()=>run(state,{boardId:'missing'}),/missing-board/);
 assert.throws(()=>run(state,{boardId:'board'},64),/shot-limit/);
 doc.shots=Array.from({length:40},(_,i)=>({...structuredClone(doc.shots[0]),id:`saved-${i}`}));
 assert.throws(()=>run(state,{boardId:'board'}),/too-many-director-shots/);
 assert.equal(run(state,{boardId:'board',shotId:'saved-0'}).id,'saved-0');
});
test('actual capture storage branch preserves ambiguous outcomes without attachment or false success',async()=>{
 const {readFileSync}=await import('node:fs'),ts=await import('typescript');
 const {sanitizeDirectorDocument}=await import('../src/core/canvas/director/model');
 const {retainDirectorExport,assertDirectorCapture}=await import('../src/core/canvas/director/integration');
 const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 const start=source.indexOf('        const expected=edit.expectedRevision;',source.indexOf("const captureOp=edit.operation?.op==='director.capture'"));
 const end=source.indexOf('        const storedImage=stored as string;',start);assert.ok(start>0&&end>start);
 const body=source.slice(start,end).replace("const {captureDirectorScene}=await import('./features/canvas/director/captureDirectorScene');",'await Promise.resolve();');
 const code=ts.transpileModule(`async function execute(deps:any){const {edit,stillCurrent,creationRevision,readState,nodesRef,captureOp,isStoryboard,sanitizeDirectorDocument,storyboardShots,SHOT_LIMIT,genId,retainDirectorExport,captureDirectorScene,signal,locale,assertDirectorCapture,readCreation,bridge,action}=deps;${body}return {passedStorage:true};}`,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
 const execute=Function(`${code};return execute;`)();
 for(const mode of ['stored-stale','rejected','invalid-shot']){
  const state=seed(),before=structuredClone(state),doc=(state.nodes[0].data as any).directorDocument;
  let renders=0,stores=0;
  if(mode==='invalid-shot')doc.shots=[{id:'saved',name:'Original',duration:5,notes:'',scene:structuredClone(doc.scene)}];
  const expected=creationRevision(state);
  const call=execute({edit:{expectedRevision:expected},stillCurrent:()=>{},creationRevision,readState:()=>state,nodesRef:{current:state.nodes},captureOp:mode==='invalid-shot'?{boardId:'board',shotId:'saved',name:'Changed'}:{boardId:'board'},isStoryboard:()=>true,sanitizeDirectorDocument,storyboardShots:()=>[],SHOT_LIMIT:64,genId:()=> 'new-shot',retainDirectorExport,captureDirectorScene:async()=>{renders++;return 'data:image/png;base64,iVBORw0KGgoTEST-ONLY';},signal:new AbortController().signal,locale:'en-US',assertDirectorCapture,readCreation,bridge:{storeCanvasImageSlice:async()=>{stores++;if(mode==='rejected')throw Error('unknown storage failure');doc.scene.camera.focalLength=90;return 'private-stored-image';}},action:{actionId:'recovery-test'}});
  if(mode==='invalid-shot'){await assert.rejects(call,/invalid-shot/);assert.equal(renders,0);assert.equal(stores,0);}
  else{const result=await call;assert.equal(result.recoveryReceipt.status,'failed');assert.equal(result.recoveryReceipt.creation.completion,'applied-unconfirmed');assert.match(result.recoveryReceipt.summary,/Recovery action recovery-test/);assert.match(result.recoveryReceipt.summary,mode==='stored-stale'?/PNG was stored/:/outcome is unknown/);assert.equal(renders,1);assert.equal(stores,1);assert.equal(state.nodes.length,before.nodes.length);assert.equal(result.nodes,undefined);if(mode==='stored-stale')assert.equal(doc.scene.camera.focalLength,90);}
 }
});
test('host business error and task ledger do not promote storage recovery to completed',async()=>{
 const {assertCanvasToolBusinessResult,validateCanvasCreationPayload}=await import('../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs');
 const {beginTaskContext,recordTaskReceipt}=await import('../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-task-state.mjs');
 const summary='Director PNG was stored but not attached. Recovery action recovery-test. Do not retry automatically.';
 const creation={...readCreation(seed(),{scope:'overview'}),completion:'applied-unconfirmed',notice:summary};
 const result={status:'failed',summary,creation,generatedJobs:0};
 assert.doesNotThrow(()=>validateCanvasCreationPayload(creation,'result'));
 assert.throws(()=>assertCanvasToolBusinessResult(result),(error:any)=>{assert.match(error.message,/stop-await-user/);assert.match(error.message,/stored but not attached/);assert.match(error.message,/Recovery action recovery-test/);return true;});
 const task=recordTaskReceipt(beginTaskContext(null,{canvasId:'canvas',conversationId:'conversation',prompt:'Capture scene'}),{actionId:'recovery-test',kind:'editCreation'},result);
 assert.equal(task.receipts[0].status,'failed');assert.equal(task.receipts[0].completion,'applied-unconfirmed');assert.deepEqual(task.receipts[0].nodeIds,[]);assert.equal(task.receipts[0].summary,summary);
});
