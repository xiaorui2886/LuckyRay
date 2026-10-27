import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readCreation, creationRevision, applyCreation, type CreationState } from '../src/core/canvas/agent/creationEngine';
import { createDirectorDocument } from '../src/core/canvas/director/model';
import { directorObjectSpatialEvidence } from '../src/features/canvas/director/directorGeometry';
import { validateCreationResult } from '../src/core/canvas/agent/creationContract';
import { validateCanvasCreationPayload } from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs';

const seed=():CreationState=>({canvasId:'canvas',nodes:[{id:'board',type:'group',position:{x:0,y:0},data:{kind:'group',label:'Director',storyboard:{version:1},directorDocument:createDirectorDocument()}}] as any,edges:[],history:[]});
const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
test('actual canvas read branch loads geometry only for object inspection and rejects stale async completion',async()=>{
 const start=source.indexOf("        if(!action.creationQuery)throw Error('canvas-agent-creation-invalid');");
 const end=source.indexOf("      if(action.execution?.mode",start);assert.ok(start>0&&end>start);
 const body=source.slice(start,end).replace(/\n      }\s*$/,'').replace("await import('./features/canvas/director/directorGeometry')",'await loadGeometry()');
 const code=ts.transpileModule(`async function run(deps:any){const {action,readCreation,readState,creationRevision,stillCurrent,locale,loadGeometry}=deps;${body}}`,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
 const run=Function(`${code};return run;`)();let loads=0;const state=seed();
 const deps={action:{creationQuery:{scope:'directorObjects',objectId:'board'}},readCreation,readState:()=>state,creationRevision,stillCurrent:()=>{},locale:'en-US',loadGeometry:async()=>{loads++;return {directorObjectSpatialEvidence};}};
 const result=await run(deps);assert.equal(result.status,'completed');assert.equal(loads,1);
 assert.ok(result.creation.items[0].fields.some((field:any)=>field.name==='spatialEvidence'&&JSON.parse(field.value).source==='procedural-mesh-vertices'));
 await run({...deps,action:{creationQuery:{scope:'directorScene',objectId:'board'}}});assert.equal(loads,1);
 await assert.rejects(run({...deps,loadGeometry:async()=>{(state.nodes[0].data as any).directorDocument.scene.objects[0].position[1]=2;return {directorObjectSpatialEvidence};}}),/context-stale/);
 await assert.rejects(run({...deps,stillCurrent:()=>{throw Error('canvas-agent-canvas-changed');}}),/canvas-changed/);
});
test('Director scene and spatial readback remain within frontend and host wire contracts',()=>{
 const state=seed();
 for(const scope of ['directorScene','directorObjects'] as const){
  const result=readCreation(state,{scope,objectId:'board'},{spatialEvidence:directorObjectSpatialEvidence});
  assert.deepEqual(validateCreationResult(result),result);assert.deepEqual(validateCanvasCreationPayload(result,'result'),result);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<128*1024);
 }
 const plain=readCreation(state,{scope:'directorObjects',objectId:'board'});
 assert.equal(JSON.parse(plain.items[0].fields!.find(field=>field.name==='spatialEvidence')!.value).status,'not-computed');
});
test('saving a Director shot changes its scene document, not storyboard child count',()=>{
 const state=seed();let id=0;
 const saved=applyCreation(state,{expectedRevision:creationRevision(state),operation:{op:'director.edit',boardId:'board',change:{action:'shot.add',name:'Saved only',duration:5}}},{createId:()=>`id-${++id}`,origin:{x:0,y:0}});
 assert.equal(saved.nodes.length,1);assert.equal((saved.nodes[0].data as any).directorDocument.shots.length,1);
 assert.equal(saved.nodes.filter(node=>node.parentId==='board').length,0);
 const overview=readCreation({...state,nodes:saved.nodes},{scope:'overview'});
 assert.match(JSON.stringify(overview),/snapshots only, not storyboard cards/);
});
test('actual capture attachment creates a visible image child with storyboard content and provenance',async()=>{
 const {retainDirectorExport,directorShotDescription}=await import('../src/core/canvas/director/integration');
 const {storyboardShots,defaultShot}=await import('../src/core/canvas/storyboard');
 const {normalizeCanvasNodeCapabilityData}=await import('../src/core/canvas/nodeCapabilities');
 const {storyboardAppendY:directorStoryboardAppendY,storyboardBounds:directorStoryboardBounds,STORYBOARD_INSETS:DIRECTOR_STORYBOARD_INSETS}=await import('../src/core/canvas/storyboardLayout');
 const {canvasNodeSize}=await import('../src/core/canvas/canvasArrangement');
 const start=source.indexOf('        const storedImage=stored as string;',source.indexOf("const captureOp=edit.operation?.op==='director.capture'"));
 const end=source.indexOf('\n      })();',start);assert.ok(start>0&&end>start);
 const code=ts.transpileModule(`function run(deps:any){const {stored,nodesRef,captureOp,storyboardShots,genId,DIRECTOR_STORYBOARD_INSETS,directorStoryboardAppendY,normalizeCanvasNodeCapabilityData,shot,defaultShot,directorShotDescription,retainDirectorExport,directorStoryboardBounds,canvasNodeSize,edgesRef,generationHistoryRef,expected}=deps;${source.slice(start,end)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
 const run=Function(`${code};return run;`)(),state=seed(),before=structuredClone(state),doc=(state.nodes[0].data as any).directorDocument;
 const shot={id:'saved',name:'Published',duration:5,notes:'Synthetic',scene:structuredClone(doc.scene)};let id=0;
 const result=run({stored:'asset://synthetic-capture.png',nodesRef:{current:state.nodes},captureOp:{boardId:'board'},storyboardShots,genId:()=>`child-${++id}`,DIRECTOR_STORYBOARD_INSETS,directorStoryboardAppendY,normalizeCanvasNodeCapabilityData,shot,defaultShot,directorShotDescription,retainDirectorExport,directorStoryboardBounds,canvasNodeSize,edgesRef:{current:[]},generationHistoryRef:{current:[]},expected:creationRevision(state)});
 assert.deepEqual(state,before);assert.equal(result.nodes.length,2);
 const image=result.nodes[1];assert.equal(image.parentId,'board');assert.equal(image.data.kind,'image');assert.equal(image.data.refMediaUrl,'asset://synthetic-capture.png');
 assert.equal(image.data.storyboardShot.title,'Published');assert.equal(image.data.storyboardShot.durationSeconds,5);assert.equal(image.data.storyboardShot.chosenResult.kind,'image');
 assert.equal(image.data.directorShotSource.shotId,'saved');assert.equal(result.nodes[0].data.groupMemberCount,1);assert.equal(storyboardShots(result.nodes,'board').length,1);
 // This exercises attachment logic only, not GPU pixels or image-to-model transport.
});
