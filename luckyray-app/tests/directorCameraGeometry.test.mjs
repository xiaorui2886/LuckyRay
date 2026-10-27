import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDirectorDocument, cloneScene, sanitizeDirectorDocument, directorDocumentJson, parseDirectorDocument, addShot, restoreShot } from '../src/core/canvas/director/model.ts';
import { buildDirectorCameraHelper, syncDirectorCameraHelper, cameraFromDirectorHelper } from '../src/features/canvas/director/directorCameraGeometry.ts';
import { applyDirectorCamera, disposeDirectorObject } from '../src/features/canvas/director/directorGeometry.ts';
const close = (a, b) => assert.ok(new THREE.Vector3(...a).distanceTo(new THREE.Vector3(...b)) < 1e-8, `${a} != ${b}`);

test('camera helper translation preserves direction and target distance', () => {
  const source = createDirectorDocument().scene.camera;
  const root = buildDirectorCameraHelper(); syncDirectorCameraHelper(root, source);
  root.position.add(new THREE.Vector3(2, -1, 3));
  const result = cameraFromDirectorHelper(root, source);
  close(result.position, source.position.map((n, i) => n + [2, -1, 3][i]));
  close(result.target, source.target.map((n, i) => n + [2, -1, 3][i]));
  assert.ok(root.getObjectByName('director-camera-pick').userData.directorCamera);
  disposeDirectorObject(root);
});
test('camera helper rotation and roll survive camera application, JSON and shot snapshots', () => {
  const doc = createDirectorDocument();
  const root = buildDirectorCameraHelper(); syncDirectorCameraHelper(root, doc.scene.camera);
  root.quaternion.setFromEuler(new THREE.Euler(.4, .8, .9));
  doc.scene.camera = cameraFromDirectorHelper(root, doc.scene.camera);
  const camera = new THREE.PerspectiveCamera(); applyDirectorCamera(camera, doc.scene.camera);
  assert.ok(1 - Math.abs(camera.quaternion.dot(root.quaternion)) < 1e-10);
  const loaded = parseDirectorDocument(directorDocumentJson(doc));
  assert.deepEqual(loaded.scene.camera.up, doc.scene.camera.up);
  const saved = addShot(loaded); const restored = restoreShot(saved, saved.shots[0].id);
  assert.deepEqual(restored.scene.camera.up, doc.scene.camera.up);
  const cloned = cloneScene(doc.scene); cloned.camera.up[0] += 1;
  assert.notEqual(cloned.camera.up[0], doc.scene.camera.up[0]);
  disposeDirectorObject(root);
});
test('legacy up defaults to Y and invalid explicit orientation is rejected', () => {
  for (const up of [[0,0,0], [NaN,1,0], [0,Infinity,0], [1,2], null]) {
    const doc = createDirectorDocument(); doc.scene.camera.up = up;
    assert.equal(sanitizeDirectorDocument(doc), null);
  }
  const doc = createDirectorDocument();
  doc.scene.camera.up = doc.scene.camera.target.map((n,i) => n - doc.scene.camera.position[i]);
  assert.equal(sanitizeDirectorDocument(doc), null);
  delete doc.scene.camera.up;
  assert.ok(sanitizeDirectorDocument(doc));
  const camera = new THREE.PerspectiveCamera(); camera.up.set(1,0,0);
  applyDirectorCamera(camera, doc.scene.camera); close(camera.up.toArray(), [0,1,0]);
});
test('camera helper frustum reflects lens and aspect without accumulating geometry', () => {
  const source = createDirectorDocument().scene.camera, root = buildDirectorCameraHelper();
  syncDirectorCameraHelper(root, source);
  const geometry = root.getObjectByName('director-camera-frustum').geometry;
  const width = Math.abs(geometry.getAttribute('position').getX(1));
  syncDirectorCameraHelper(root, { ...source, focalLength: 100 });
  assert.ok(Math.abs(geometry.getAttribute('position').getX(1)) < width);
  assert.equal(root.getObjectByName('director-camera-frustum').geometry, geometry);
  disposeDirectorObject(root);
});
