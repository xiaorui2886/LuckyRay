import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { directorObjectSpatialEvidence, buildDirectorObject, disposeDirectorObject } from '../src/features/canvas/director/directorGeometry';
import { createDirectorObject, createDirectorDocument } from '../src/core/canvas/director/model';
import { readDirectorDocument } from '../src/core/canvas/agent/directorAdapter';

const close = (actual:number, expected:number) => assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);
test('M4R8 unit box uses a bottom origin, not a centre origin',()=>{
 const box=createDirectorObject('box','box'); box.position=[1.8,.5,-.9];
 const before=structuredClone(box), evidence=directorObjectSpatialEvidence(box);
 close(evidence.bottomY,.5); assert.equal(evidence.groundRelation,'above-ground'); close(evidence.translationYToGround,-.5);
 evidence.size.forEach(value=>close(value,1)); assert.deepEqual(box,before);
 box.position[1]=0; assert.equal(directorObjectSpatialEvidence(box).groundRelation,'at-ground');
 box.position[1]=-.5; assert.equal(directorObjectSpatialEvidence(box).groundRelation,'below-ground');
});
test('rotations and nonuniform scale use world geometry, not position.y',()=>{
 const box=createDirectorObject('box','box'); box.position=[0,0,0]; box.scale=[2,3,4]; box.rotation=[0,0,90];
 const evidence=directorObjectSpatialEvidence(box);
 close(evidence.bottomY,-1); close(evidence.size[0],3);close(evidence.size[1],2);close(evidence.size[2],4);
 box.position[1]+=evidence.translationYToGround;close(directorObjectSpatialEvidence(box).bottomY,0);
 box.rotation=[0,0,45];box.scale=[1,1,1];box.position=[0,0,0];
 close(directorObjectSpatialEvidence(box).bottomY,-Math.SQRT1_2/2);
});
test('all procedural kinds support bounded evidence and do not allocate a renderer',()=>{
 for(const kind of ['box','sphere','cylinder','wall','platform','actor'] as const){
  const object=createDirectorObject(kind,kind),before=structuredClone(object),evidence=directorObjectSpatialEvidence(object);
  assert.equal(evidence.source,'procedural-mesh-vertices');assert.equal(evidence.units,'metres');
  assert.ok(evidence.min.every(Number.isFinite));assert.ok(evidence.size.every(v=>v>0));assert.deepEqual(object,before);
 }
});
test('actor pose helpers are excluded from body bounds and hidden objects stay identified',()=>{
 const object=createDirectorObject('actor','actor');object.visible=false;
 const evidence=directorObjectSpatialEvidence(object);assert.equal(evidence.visible,false);
 const root=buildDirectorObject(object),expected=new THREE.Box3(),point=new THREE.Vector3();
 try{
  root.updateMatrixWorld(true);
  root.traverse(child=>{
   const mesh=child as THREE.Mesh;if(!mesh.geometry||mesh.userData.directorPoseHandle)return;
   const position=mesh.geometry.getAttribute('position');
   for(let i=0;i<position.count;i++)expected.expandByPoint(point.fromBufferAttribute(position,i).applyMatrix4(mesh.matrixWorld));
  });
  assert.deepEqual(evidence.min,expected.min.toArray());assert.deepEqual(evidence.max,expected.max.toArray());
 }finally{disposeDirectorObject(root);}
});
test('object readback preserves eight-item pagination and exposes grounding evidence',()=>{
 const document=createDirectorDocument();document.scene.objects=Array.from({length:10},(_,index)=>{const object=createDirectorObject('box',`box-${index}`);object.position[1]=index/10;return object;});
 const first=readDirectorDocument(document,{scope:'objects'},{spatialEvidence:directorObjectSpatialEvidence}),second=readDirectorDocument(document,{scope:'objects',offset:8},{spatialEvidence:directorObjectSpatialEvidence});
 assert.equal(first.items.length,8);assert.equal(first.nextOffset,8);assert.equal(first.total,10);assert.equal(second.items.length,2);assert.equal(second.nextOffset,undefined);
 const value=JSON.parse(first.items[5].fields!.find(field=>field.name==='spatialEvidence')!.value);
 close(value.bottomY,.5);assert.equal(value.groundRelation,'above-ground');
 const scene=readDirectorDocument(document,{scope:'scene'}).items[0];
 assert.match(scene.fields!.find(field=>field.name==='coordinateConvention')!.value,/not its geometric centre/);
 assert.match(scene.fields!.find(field=>field.name==='workflow')!.value,/do not create storyboard cards/);
 assert.match(scene.fields!.find(field=>field.name==='workflow')!.value,/director.capture/);
});
test('invalid geometry fails closed instead of emitting non-finite evidence',()=>{
 const object=createDirectorObject('box','invalid');object.position[1]=Number.NaN;
 assert.throws(()=>directorObjectSpatialEvidence(object),/spatial-evidence-unavailable/);
});
test('read-only inspection disposes only its own temporary assets',()=>{
 const persistent=buildDirectorObject(createDirectorObject('actor','visible-stage'));
 let persistentDisposals=0;
 persistent.traverse(child=>{const mesh=child as THREE.Mesh;mesh.geometry?.addEventListener('dispose',()=>persistentDisposals++);});
 directorObjectSpatialEvidence(createDirectorObject('actor','inspection'));
 assert.equal(persistentDisposals,0);disposeDirectorObject(persistent);assert.ok(persistentDisposals>0);
});
