import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorDocument, sanitizeDirectorDocument } from '../src/core/canvas/director/model';
import { createRigPose, RIG_LIMBS, rigJointWorldTransforms } from '../src/core/canvas/director/rig';
import { applyDirectorOperation, DIRECTOR_OPERATION_SCHEMA, readDirectorDocument, validateDirectorOperation } from '../src/core/canvas/agent/directorAdapter';
import type { DirectorOperation } from '../src/core/canvas/agent/directorAdapter';
let sequence=0;const id=()=>`test-${++sequence}`;
const edit=(d:ReturnType<typeof createDirectorDocument>,op:DirectorOperation)=>applyDirectorOperation(d,op,id);
test('strict typed operations reject unknown keys, malformed vectors, scripts and invalid IDs',()=>{
 const bad:unknown[]=[{action:'run',code:'evil()'},{action:'camera.update',patch:{focalLength:50,code:'evil()'}},{action:'camera.update',patch:{}},{action:'camera.update',patch:{position:[0,0]}},{action:'camera.update',patch:{focalLength:NaN}},{action:'camera.update',patch:{focalLength:201}},{action:'pose.ik',objectId:'actor',limb:'leftArm',target:[0,1,0],space:'world'},{action:'shot.remove',shotId:'../file'},{action:'shot.update',shotId:'s'},{action:'object.add',kind:'url',url:'https://example.com'},{action:'pose.joint',objectId:'a',joint:'__proto__',rotation:[0,0,0]}];
 for(const value of bad)assert.throws(()=>validateDirectorOperation(value));
 assert.equal(DIRECTOR_OPERATION_SCHEMA.oneOf?.length,16);
});
test('object creation and patch are bounded, immutable and preserve unrelated values',()=>{
 const source=createDirectorDocument(),before=structuredClone(source);
 const added=edit(source,{action:'object.add',kind:'box',name:'Block',position:[2,0,1]});
 assert.deepEqual(source,before);assert.equal(added.document.scene.objects.length,3);assert.equal(added.affectedIds.length,1);
 const objectId=added.affectedIds[0];const changed=edit(added.document,{action:'object.update',objectId,patch:{rotation:[0,30,0],scale:[2,1,1]}});
 assert.deepEqual(changed.document.scene.camera,source.scene.camera);assert.deepEqual(changed.document.scene.objects[2].position,[2,0,1]);
 assert.throws(()=>edit(source,{action:'object.update',objectId:'missing',patch:{name:'No'}}),/missing-object/);
 assert.throws(()=>applyDirectorOperation(source,{action:'object.add',kind:'box'},()=>source.scene.objects[0].id),/id-collision/);
});
test('locked objects reject pose/transform edits and explicit unlock is separate',()=>{
 const d=createDirectorDocument(),objectId=d.scene.objects[0].id;d.scene.objects[0].locked=true;
 assert.throws(()=>edit(d,{action:'object.update',objectId,patch:{position:[1,2,3]}}),/object-locked/);
 assert.throws(()=>edit(d,{action:'object.update',objectId,patch:{locked:false,position:[1,2,3]}}),/object-locked/);
 assert.throws(()=>edit(d,{action:'pose.preset',objectId,preset:'wave'}),/object-locked/);
 assert.equal(edit(d,{action:'object.update',objectId,patch:{locked:false}}).document.scene.objects[0].locked,false);
});
test('pose edits use native rig and report constrained angles and achieved IK residual',()=>{
 const d=createDirectorDocument(),objectId=d.scene.objects[0].id;
 const posed=edit(d,{action:'pose.preset',objectId,preset:'wave'});assert.deepEqual(posed.document.scene.objects[0].rig,createRigPose('wave'));
 const constrained=edit(d,{action:'pose.joint',objectId,joint:'leftShin',rotation:[-100,0,0]});assert.equal(constrained.details.constrained,true);assert.deepEqual(constrained.details.achievedRotation,[0,0,0]);
 const unreachable=edit(d,{action:'pose.ik',objectId,limb:'leftArm',space:'actor-local',target:[100,100,100]});assert.equal(unreachable.details.reached,false);assert.ok((unreachable.details.residualMetres as number)>100);assert.ok(sanitizeDirectorDocument(unreachable.document));
 const rig=createRigPose(),target=rigJointWorldTransforms(rig)[RIG_LIMBS.leftArm.end].position;
 const reachable=edit(d,{action:'pose.ik',objectId,limb:'leftArm',space:'actor-local',target});assert.ok((reachable.details.residualMetres as number)<.001);
 const mirrored=edit(posed.document,{action:'pose.mirror',objectId});assert.deepEqual(edit(mirrored.document,{action:'pose.mirror',objectId}).document,posed.document);
});
test('partial camera updates and shot roundtrip preserve up vector and exact scene',()=>{
 let d=createDirectorDocument();d.scene.camera.up=[.2,1,.1];const before=structuredClone(d);
 d=edit(d,{action:'camera.update',patch:{focalLength:85,aspect:'9:16'}}).document;assert.deepEqual(d.scene.camera.up,before.scene.camera.up);
 d=edit(d,{action:'camera.lookAt',target:[1,1,0]}).document;assert.deepEqual(d.scene.camera.up,before.scene.camera.up);
 const saved=edit(d,{action:'shot.add',name:'Portrait',notes:'Exact frame',duration:7});const shotId=saved.affectedIds[0];
 const modified=edit(saved.document,{action:'camera.update',patch:{focalLength:35}}).document;assert.equal(modified.shots[0].scene.camera.focalLength,85);
 assert.deepEqual(edit(modified,{action:'shot.restore',shotId}).document.scene,d.scene);
 assert.throws(()=>edit(d,{action:'camera.lookAt',target:[...d.scene.camera.position]}),/invalid-scene/);
 assert.deepEqual(before.scene.camera.focalLength,35);
});
test('shot overwrite is explicit, identity stays stable and removal clears active ID only',()=>{
 let d=createDirectorDocument();const added=edit(d,{action:'shot.add',name:'A'}),shotId=added.affectedIds[0];d=added.document;
 d=edit(d,{action:'camera.update',patch:{focalLength:100}}).document;
 const metadata=edit(d,{action:'shot.update',shotId,name:'B'}).document;assert.equal(metadata.shots[0].scene.camera.focalLength,35);
 const replaced=edit(metadata,{action:'shot.update',shotId,replaceScene:true}).document;assert.equal(replaced.shots[0].scene.camera.focalLength,100);assert.equal(replaced.shots[0].id,shotId);
 const removed=edit(replaced,{action:'shot.remove',shotId}).document;assert.equal(removed.activeShotId,undefined);assert.deepEqual(removed.scene,replaced.scene);
});
test('paged projections retain IDs and parseable complete per-object rig fields',()=>{
 let d=createDirectorDocument();for(let n=0;n<17;n++)d=edit(d,{action:'object.add',kind:'actor',name:`Actor ${n}`}).document;
 const ids:string[]=[];let offset=0;do{const page=readDirectorDocument(d,{scope:'objects',offset});assert.ok(page.items.length<=8);for(const item of page.items){ids.push(item.id);for(const f of item.fields??[]){assert.ok(f.value.length<=4000,`${f.name} too long`);if(['rig','jointLimits'].includes(f.name))assert.doesNotThrow(()=>JSON.parse(f.value));}}if(page.nextOffset===undefined)break;offset=page.nextOffset;}while(true);
 assert.deepEqual(ids,d.scene.objects.map(o=>o.id));assert.equal(new Set(ids).size,19);
 const scene=readDirectorDocument(d,{scope:'scene'});assert.equal(scene.total,1);assert.ok(scene.items[0].fields?.some(f=>f.name==='camera'));
 assert.throws(()=>readDirectorDocument(d,{scope:'objects',offset:-1}));
});
test('isolated failure does not mutate original state and object limits fail closed',()=>{
 const d=createDirectorDocument(),before=structuredClone(d);let working=edit(d,{action:'object.add',kind:'box'}).document;
 assert.throws(()=>edit(working,{action:'camera.update',patch:{up:[0,0,0]}}));assert.deepEqual(d,before);
 const full=createDirectorDocument();full.scene.objects=Array.from({length:100},(_,i)=>({...structuredClone(full.scene.objects[0]),id:`actor-${i}`}));assert.throws(()=>edit(full,{action:'object.add',kind:'box'}),/object-limit/);assert.equal(full.scene.objects.length,100);
});
test('every operation yields validated detached output; strict schema serializes portably',()=>{
 const d=createDirectorDocument(),objectId=d.scene.objects[0].id;d.scene.camera.up=[.2,1,.1];d.shots=[{id:'saved',name:'Saved',duration:5,notes:'',scene:structuredClone(d.scene)}];
 const operations:DirectorOperation[]=[
  {action:'object.add',kind:'box'}, {action:'object.update',objectId,patch:{name:'Changed'}},
  {action:'pose.preset',objectId,preset:'reach'}, {action:'pose.joint',objectId,joint:'head',rotation:[0,10,0]},
  {action:'pose.ik',objectId,limb:'rightArm',target:[.2,1,.3],space:'actor-local'}, {action:'pose.mirror',objectId},
  {action:'camera.update',patch:{focalLength:70}}, {action:'camera.preset',preset:'medium'}, {action:'camera.lookAt',target:[1,1,0]},
  {action:'lighting.update',patch:{intensity:2}}, {action:'lighting.preset',preset:'night'},
  {action:'presentation.update',mode:'clay',clayColor:'#cccccc'}, {action:'shot.add',name:'New'},
  {action:'shot.update',shotId:'saved',notes:'Updated'}, {action:'shot.restore',shotId:'saved'}, {action:'shot.remove',shotId:'saved'},
 ];
 assert.deepEqual(JSON.parse(JSON.stringify(DIRECTOR_OPERATION_SCHEMA)),DIRECTOR_OPERATION_SCHEMA);
 for(const operation of operations){const before=structuredClone(d),result=edit(d,operation);assert.ok(sanitizeDirectorDocument(result.document));result.document.scene.objects[0].position[0]=999;result.document.scene.camera.up![0]=.9;if(result.document.shots.length)result.document.shots[0].scene.objects[0].scale[0]=99;assert.deepEqual(d,before,operation.action);}
});
test('semantic validation rejects invalid scene atomically and readback never implies capture',()=>{
 const d=createDirectorDocument(),before=structuredClone(d);
 assert.throws(()=>edit(d,{action:'camera.update',patch:{up:[0,0,0]}}),/invalid-scene/);
 assert.deepEqual(d,before);
 const box=edit(d,{action:'object.add',kind:'box'});assert.throws(()=>edit(box.document,{action:'pose.preset',objectId:box.affectedIds[0],preset:'stand'}),/not-actor/);
 const read=readDirectorDocument(d,{scope:'scene'});assert.ok(read.items[0].fields?.some(f=>f.name==='capture'&&f.value.includes('actual renderer')));
});
test('IK receipt distinguishes actor-local and world residual under transformed actors',()=>{
 const d=createDirectorDocument(),actor=d.scene.objects[0];actor.position=[10,2,-4];actor.rotation=[0,90,0];actor.scale=[2,2,2];
 const result=edit(d,{action:'pose.ik',objectId:actor.id,limb:'leftArm',space:'actor-local',target:[100,100,100]});
 const local=result.details.achievedTarget as number[],world=result.details.achievedWorldTarget as number[];
 assert.ok(Math.abs(world[0]-(10+2*local[2]))<1e-8);assert.ok(Math.abs(world[1]-(2+2*local[1]))<1e-8);assert.ok(Math.abs(world[2]-(-4-2*local[0]))<1e-8);
 assert.ok(Math.abs((result.details.worldResidualMetres as number)-2*(result.details.residualMetres as number))<1e-8);
});
test('frontend and host agree on Director tool payloads and reject malformed edits',async()=>{
 const {validateCreationEdit}=await import('../src/core/canvas/agent/creationContract');
 // Host API is plain JavaScript; this checks the actual transport validator, not a copy.
 const {validateCanvasCreationPayload}=await import('../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs');
 const wrap=(change:unknown)=>({expectedRevision:'0123456789abcdef',operation:{op:'director.edit',boardId:'board-1',change}});
 const valid:unknown[]=[{action:'object.add',kind:'actor'},{action:'object.update',objectId:'actor',patch:{position:[1,2,3],color:'#112233'}},{action:'pose.preset',objectId:'actor',preset:'crouch'},{action:'pose.joint',objectId:'actor',joint:'head',rotation:[10,20,0]},{action:'pose.ik',objectId:'actor',limb:'rightArm',space:'actor-local',target:[0,1,0]},{action:'pose.mirror',objectId:'actor'},{action:'camera.update',patch:{focalLength:50,up:[1,0,0]}},{action:'camera.preset',preset:'overhead'},{action:'camera.lookAt',target:[1,1,1]},{action:'lighting.update',patch:{color:'#112233'}},{action:'lighting.preset',preset:'day'},{action:'presentation.update',mode:'clay',clayColor:'#eeeeee'},{action:'shot.add',name:'A'},{action:'shot.update',shotId:'shot',notes:'B'},{action:'shot.restore',shotId:'shot'},{action:'shot.remove',shotId:'shot'}];
 for(const change of valid){const payload=wrap(change);assert.deepEqual(validateCreationEdit(payload),payload);assert.deepEqual(validateCanvasCreationPayload(payload,'edit'),payload);}
 for(const change of [{action:'camera.update',patch:{}},{action:'camera.update',patch:{focalLength:300}},{action:'object.update',objectId:'actor',patch:{scale:[0,1,1]}},{action:'pose.ik',objectId:'actor',limb:'rightArm',space:'world',target:[0,1,0]},{action:'object.add',kind:'actor',script:'run'}]){assert.throws(()=>validateCreationEdit(wrap(change)));assert.throws(()=>validateCanvasCreationPayload(wrap(change),'edit'));}
});
test('long shot notes are losslessly reachable through UTF-16-safe paginated chunks',()=>{
 const d=createDirectorDocument();const text='x'.repeat(3999)+'🌞'+'y'.repeat(3999);
 for(let i=0;i<5;i++)d.shots.push({id:`shot-${i}`,name:`Shot ${i}`,duration:5,notes:text,scene:structuredClone(d.scene)});
 const chunks=new Map<string,{index:number;start:number;end:number;text:string}[]>();let offset=0,seen=0;
 do{const page=readDirectorDocument(d,{scope:'shots',offset});assert.equal(page.total,20);seen+=page.items.length;for(const item of page.items){const fields=Object.fromEntries((item.fields??[]).map(f=>[f.name,f.value]));if(item.kind==='directorShot'){assert.equal(fields.notes,undefined);assert.equal(fields.notesChunkCount,'3');}else{assert.equal(item.kind,'directorShotNotesChunk');const chunk={index:Number(fields.chunkIndex),start:Number(fields.start),end:Number(fields.end),text:fields.text};assert.ok(chunk.text.length<=4000);assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text));assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text));const prior=chunks.get(fields.shotId)??[];prior.push(chunk);chunks.set(fields.shotId,prior);}}if(page.nextOffset===undefined)break;offset=page.nextOffset;}while(true);
 assert.equal(seen,20);for(const shot of d.shots){const ordered=chunks.get(shot.id)!.sort((a,b)=>a.index-b.index);assert.equal(ordered.map(c=>c.text).join(''),text);assert.equal(ordered[0].start,0);assert.equal(ordered[0].end,ordered[1].start);assert.equal(ordered[1].end,ordered[2].start);assert.equal(ordered[2].end,text.length);}
});
test('Director note chunks use the actual creation revision and reject stale continuation',async()=>{
 const {readCreation,creationRevision}=await import('../src/core/canvas/agent/creationEngine');
 const d=createDirectorDocument();for(let i=0;i<5;i++)d.shots.push({id:`shot-${i}`,name:'Notes',duration:5,notes:'z'.repeat(8000),scene:structuredClone(d.scene)});
 const state:any={canvasId:'canvas',nodes:[{id:'board',type:'group',position:{x:0,y:0},data:{kind:'group',label:'Director',storyboard:{version:1},directorDocument:d}}],edges:[],history:[]};
 const revision=creationRevision(state);const first=readCreation(state,{scope:'directorShots',objectId:'board'});assert.equal(first.revision,revision);assert.equal(first.nextOffset,8);
 const second=readCreation(state,{scope:'directorShots',objectId:'board',offset:first.nextOffset,expectedRevision:revision});assert.equal(second.revision,revision);
 state.nodes[0].data.directorDocument.shots[0].notes='edited';assert.notEqual(creationRevision(state),revision);
 assert.throws(()=>readCreation(state,{scope:'directorShots',objectId:'board',offset:8,expectedRevision:revision}),/stale/);
});
test('actual capture is singular-only in frontend and host contracts',async()=>{
 const {validateCreationEdit}=await import('../src/core/canvas/agent/creationContract');
 const {validateCanvasCreationPayload}=await import('../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs');
 const operation={op:'director.capture',boardId:'board',shotId:'shot'};
 const single={expectedRevision:'0123456789abcdef',operation};assert.deepEqual(validateCreationEdit(single),single);assert.deepEqual(validateCanvasCreationPayload(single,'edit'),single);
 const batch={expectedRevision:'0123456789abcdef',operations:[operation]};assert.throws(()=>validateCreationEdit(batch));assert.throws(()=>validateCanvasCreationPayload(batch,'edit'));
});
