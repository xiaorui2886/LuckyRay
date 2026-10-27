import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, '..');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const file = path.join(os.tmpdir(), `rig-geometry-${process.pid}.cjs`);
await esbuild.build({ stdin: { contents: `export * from './src/features/canvas/director/directorGeometry'; export * from './src/features/canvas/director/directorRigGeometry'; export * from './src/core/canvas/director/rig'; export * as THREE from 'three';`, resolveDir: repo }, outfile: file, bundle: true, platform: 'node', format: 'cjs' });
try {
  const a = require(file), T = a.THREE;
  const source = { id: 'actor', name: 'Actor', kind: 'actor', pose: 'stand', color: '#e57c52', visible: true, locked: false, position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] };
  for (const preset of a.RIG_PRESETS) {
    const pose = a.createRigPose(preset.id), root = a.buildDirectorObject({...source, rig: pose}), rig = a.getDirectorRig(root), math = a.rigJointWorldTransforms(pose);
    assert.equal(rig.bones.size, 19);
    for (const [id, bone] of rig.bones) { assert.ok(bone.isBone); assert.ok(bone.getWorldPosition(new T.Vector3()).distanceTo(new T.Vector3(...math[id].position)) < 1e-8, id); }
    const box = a.directorRenderableBounds(root); assert.ok(box.min.toArray().concat(box.max.toArray()).every(Number.isFinite));
    let actualMinY = Infinity;
    const vertex = new T.Vector3();
    root.updateMatrixWorld(true);
    root.traverse(mesh => { if (!mesh.isMesh || mesh.userData.directorPoseHandle) return; const positions = mesh.geometry?.getAttribute('position'); if (!positions) return; for (let i=0;i<positions.count;i++) actualMinY=Math.min(actualMinY,vertex.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).y); });
    assert.ok(Math.abs(actualMinY) <= .001, `${preset.id} actual vertices must touch ground, not float: ${actualMinY}`);
    root.traverse(mesh => { if (mesh.geometry?.type === 'LatheGeometry') { const points = mesh.geometry.parameters.points; assert.ok(points.slice(1,-1).every(p => p.x > 0)); assert.ok(points[10].x > .02); } });
    a.disposeDirectorObject(root);
  }
  const root = a.buildDirectorObject(source, '#d5d5d2'), rig = a.getDirectorRig(root), ids = [];
  root.traverse(m => { if(m.geometry) ids.push(m.geometry.uuid); });
  const originalRight = a.directorJointWorldPosition(root, 'rightHand'), originalLeft = a.directorJointWorldPosition(root, 'leftHand');
  const changed = a.setJointRotation(a.getObjectRigPose(source), 'leftUpperArm', [-80,0,0]);
  for(let i=0;i<60;i++) a.applyDirectorRigPose(root, changed);
  assert.ok(a.directorJointWorldPosition(root,'leftHand').distanceTo(originalLeft) > .1); assert.ok(a.directorJointWorldPosition(root,'rightHand').distanceTo(originalRight) < 1e-9);
  const after=[]; root.traverse(m=>{if(m.geometry)after.push(m.geometry.uuid);}); assert.deepEqual(ids,after); assert.equal(source.color,'#e57c52');
  a.setDirectorRigHelpers(root,true,'head'); assert.ok(rig.markers.every(m=>m.visible));
  const box = a.directorRenderableBounds(root); rig.markers.forEach(m=>m.scale.setScalar(1000)); assert.deepEqual(a.directorRenderableBounds(root),box);
  a.setDirectorRigHelpers(root,false); assert.ok(rig.markers.every(m=>!m.visible));
  root.rotation.set(.2,.8,.1); root.scale.set(1.5,.8,2); root.position.set(2,0,-1); root.updateMatrixWorld(true);
  const local = new T.Vector3(.3,1,.2); assert.ok(root.worldToLocal(root.localToWorld(local.clone())).distanceTo(local)<1e-9);
  const geometries=new Set(), materials=new Set();root.traverse(m=>{if(m.geometry)geometries.add(m.geometry);if(m.material)materials.add(m.material);});let g=0,m=0;geometries.forEach(x=>x.addEventListener('dispose',()=>g++));materials.forEach(x=>x.addEventListener('dispose',()=>m++));a.disposeDirectorObject(root);assert.equal(g,geometries.size);assert.equal(m,materials.size);
  console.log('PASS reconstructed production rig geometry: 7 grounded presets, actual bone/math parity, positive limb profiles, retained geometry, independent limbs, helper exclusion and disposal.');
} finally { fs.rmSync(file,{force:true}); }
