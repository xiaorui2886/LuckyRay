import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyDirectorCamera, applyDirectorTransform, boundedDirectorCamera, buildDirectorObject, directorAspect, directorCaptureSize, directorTransformPatch, directorViewportSize, disposeDirectorObject } from '../src/features/canvas/director/directorGeometry.ts';
import type { DirectorObject } from '../src/core/canvas/director/types.ts';
const object = (kind: DirectorObject['kind'], pose: DirectorObject['pose'] = 'stand'): DirectorObject => ({ id: 'actor-1', name: 'Actor', kind, position: [1, 0, 2], rotation: [0, 90, 0], scale: [1, 1, 1], color: '#aa88cc', visible: true, locked: false, pose });
test('all production aspects preserve framing and cap export resolution', () => {
  for (const value of ['16:9', '9:16', '4:3', '1:1', '2.39:1'] as const) {
    const ratio = directorAspect(value), size = directorCaptureSize(ratio);
    assert.ok(Math.max(size.width, size.height) <= 1920);
    assert.ok(Math.abs(size.width / size.height - ratio) < 0.003);
    const view = directorViewportSize(800, 600, ratio);
    assert.ok(view.width <= 800 && view.height <= 600);
    assert.ok(Math.abs(view.width / view.height - ratio) < 0.0001);
  }
});
test('shot focal length and aspect genuinely change projection', () => {
  const camera = new THREE.PerspectiveCamera();
  const source = { position: [0, 2, 8], target: [0, 1, 0], focalLength: 35, aspect: '16:9' } as const;
  applyDirectorCamera(camera, { ...source, position: [...source.position], target: [...source.target] });
  const first = camera.projectionMatrix.clone(), wideFov = camera.fov;
  assert.equal(camera.filmGauge, 36);
  assert.ok(Math.abs(camera.getFocalLength() - 35) < 0.00001);
  applyDirectorCamera(camera, { ...source, position: [...source.position], target: [...source.target], focalLength: 85 });
  assert.ok(camera.fov < wideFov); assert.notDeepEqual(camera.projectionMatrix.elements, first.elements);
  applyDirectorCamera(camera, { ...source, position: [...source.position], target: [...source.target], aspect: '9:16' });
  assert.equal(camera.aspect, 9 / 16); assert.ok(camera.projectionMatrix.elements.every(Number.isFinite));
});
test('all built-in geometry has finite positive bounds and is shadow ready', () => {
  for (const kind of ['actor', 'box', 'sphere', 'cylinder', 'wall', 'platform'] as const) {
    const model = buildDirectorObject(object(kind));
    const bounds = new THREE.Box3().setFromObject(model), dimensions = bounds.getSize(new THREE.Vector3());
    assert.ok(dimensions.toArray().every(v => Number.isFinite(v) && v > 0));
    assert.equal(model.userData.directorId, 'actor-1');
    let hasShadow = false; model.traverse(child => { if (child instanceof THREE.Mesh && child.castShadow) hasShadow = true; }); assert.ok(hasShadow);
    assert.ok(Math.abs(model.rotation.y - Math.PI / 2) < 0.000001);
    disposeDirectorObject(model);
  }
});
test('actor poses change actual geometry, not just labels', () => {
  const standing = buildDirectorObject(object('actor', 'stand'));
  const sitting = buildDirectorObject(object('actor', 'sit'));
  const walking = buildDirectorObject(object('actor', 'walk'));
  const height = (model: THREE.Object3D) => new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y;
  assert.ok(height(sitting) < height(standing));
  const poses = (root: THREE.Object3D) => { root.updateMatrixWorld(true); const values: number[][] = []; root.traverse(p => { if (p instanceof THREE.Mesh && !p.userData.directorPoseHandle) values.push(p.getWorldPosition(new THREE.Vector3()).toArray()); }); return values; }; assert.notDeepEqual(poses(walking), poses(standing));
  [standing, sitting, walking].forEach(disposeDirectorObject);
});
test('transform commits use degrees and safe finite bounded positive scales', () => {
  const model = new THREE.Object3D();
  model.position.set(2000, NaN, -3000); model.rotation.y = Math.PI / 2; model.scale.set(-1, 0, 100);
  const patch = directorTransformPatch(model);
  assert.deepEqual(patch.position, [1000, 0, -1000]); assert.equal(patch.rotation[1], 90);
  assert.deepEqual(patch.scale, [0.05, 0.05, 100]);
});
test('owned geometries and shared materials disposed once', () => {
  const model = buildDirectorObject(object('actor'));
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  model.traverse(child => { if (child instanceof THREE.Mesh) { geometries.add(child.geometry); materials.add(child.material); } });
  let disposedGeometry = 0, disposedMaterial = 0;
  geometries.forEach(value => value.addEventListener('dispose', () => { disposedGeometry++; }));
  materials.forEach(value => value.addEventListener('dispose', () => { disposedMaterial++; }));
  disposeDirectorObject(model);
  assert.equal(disposedGeometry, geometries.size); assert.equal(disposedMaterial, materials.size);
});

test('bounded transforms are applied even if clamped commit equals stored state', () => {
  const source = object('box'); source.scale = [0.05, 1, 1];
  const model = buildDirectorObject(source); model.scale.x = -4;
  const patch = directorTransformPatch(model);
  assert.deepEqual(patch.scale, source.scale);
  applyDirectorTransform(model, { ...source, ...patch });
  assert.equal(model.scale.x, 0.05);
  disposeDirectorObject(model);
});
test('interactive camera clamp preserves finite distinct position and target', () => {
  const source = { position: [0, 2, 8], target: [0, 1, 0], focalLength: 35, aspect: '16:9' } as const;
  const camera = boundedDirectorCamera({ ...source, position: [...source.position], target: [...source.target] }, [2000, NaN, 2000], [3000, 2, 3000]);
  assert.ok([...camera.position, ...camera.target].every(v => Number.isFinite(v) && Math.abs(v) <= 1000));
  assert.ok(new THREE.Vector3(...camera.position).distanceTo(new THREE.Vector3(...camera.target)) >= 0.01);
  const projection = new THREE.PerspectiveCamera(); applyDirectorCamera(projection, camera);
  assert.ok(projection.matrixWorld.elements.every(Number.isFinite));
});
