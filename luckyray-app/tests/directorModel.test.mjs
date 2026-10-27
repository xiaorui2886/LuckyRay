import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTOR_LIMITS, createDirectorDocument, createDirectorObject, cloneScene, aspectNumber, focalLengthToVerticalFov, cameraPreset, lightingPreset, sanitizeDirectorDocument, addShot, restoreShot, updateShot, removeShot, reorderShot, directorDocumentJson, parseDirectorDocument } from '../src/core/canvas/director/model.ts';

test('new documents are valid, independent and use unique object identities', () => {
  const a = createDirectorDocument(), b = createDirectorDocument();
  assert.deepEqual(sanitizeDirectorDocument(a), a);
  assert.notEqual(a.scene.objects[0].id, b.scene.objects[0].id);
  a.scene.objects[0].position[0] = 999;
  assert.notEqual(b.scene.objects[0].position[0], 999);
  for (const kind of ['actor', 'box', 'sphere', 'cylinder', 'wall', 'platform']) {
    const doc = createDirectorDocument(); doc.scene.objects = [createDirectorObject(kind)];
    assert.ok(sanitizeDirectorDocument(doc));
  }
});
test('all presets are valid and camera projection responds to focal length and frame aspect', () => {
  for (const preset of ['wide', 'medium', 'close', 'overhead']) {
    const doc = createDirectorDocument(); doc.scene.camera = cameraPreset(preset); assert.ok(sanitizeDirectorDocument(doc));
  }
  for (const preset of ['studio', 'day', 'night']) {
    const doc = createDirectorDocument(); doc.scene.lighting = lightingPreset(preset); assert.ok(sanitizeDirectorDocument(doc));
  }
  assert.equal(aspectNumber('16:9'), 16 / 9);
  assert.equal(aspectNumber('9:16'), 9 / 16);
  assert.ok(focalLengthToVerticalFov(85, '16:9') < focalLengthToVerticalFov(35, '16:9'));
  assert.ok(focalLengthToVerticalFov(50, '9:16') > focalLengthToVerticalFov(50, '16:9'));
  assert.ok(Math.abs(focalLengthToVerticalFov(50, '1:1') - 39.5977527) < 0.00001);
});
test('scene clone owns all nested mutable arrays and objects', () => {
  const original = createDirectorDocument().scene, copy = cloneScene(original);
  copy.objects[0].position[1] = 7; copy.objects[0].rotation[0] = 25; copy.objects[0].scale[0] = 2;
  copy.camera.position[0] = 20; copy.camera.target[0] = 8; copy.lighting.intensity = 10;
  assert.notEqual(original.objects[0].position[1], 7); assert.notEqual(original.objects[0].rotation[0], 25);
  assert.notEqual(original.objects[0].scale[0], 2); assert.notEqual(original.camera.position[0], 20);
  assert.notEqual(original.camera.target[0], 8); assert.notEqual(original.lighting.intensity, 10);
});
test('shot restore recovers complete staging, camera, aspect, lights, visibility and pose', () => {
  const initial = createDirectorDocument(); initial.scene.objects[0].pose = 'sit'; initial.scene.objects[1].visible = false;
  initial.scene.camera.aspect = '9:16'; initial.scene.lighting = lightingPreset('night');
  const saved = addShot(initial, '夜景'); const expected = cloneScene(initial.scene);
  const changed = { ...saved, scene: createDirectorDocument().scene };
  const restored = restoreShot(changed, saved.shots[0].id);
  assert.deepEqual(restored.scene, expected);
  restored.scene.objects[0].position[0] = 42;
  assert.notEqual(saved.shots[0].scene.objects[0].position[0], 42);
  assert.equal(saved.shots[0].duration, 5); assert.equal(initial.shots.length, 0);
});
test('shot replacement is explicit and preserves shot name, notes, duration', () => {
  const doc = addShot(createDirectorDocument(), '镜头'); const id = doc.shots[0].id;
  doc.shots[0].duration = 12; doc.shots[0].notes = '备注'; doc.scene.lighting.intensity = 8;
  assert.notEqual(doc.shots[0].scene.lighting.intensity, 8);
  const updated = updateShot(doc, id);
  assert.equal(updated.shots[0].scene.lighting.intensity, 8);
  assert.equal(updated.shots[0].duration, 12); assert.equal(updated.shots[0].notes, '备注');
  assert.equal(updateShot(doc, 'missing'), doc);
});
test('shot reorder is immutable, clamps positions, deletion clears only active identity', () => {
  let doc = createDirectorDocument(); for (const name of ['A', 'B', 'C']) doc = addShot(doc, name);
  const [a,b,c] = doc.shots.map(s => s.id);
  assert.deepEqual(reorderShot(doc, a, 999).shots.map(s => s.id), [b,c,a]);
  assert.deepEqual(reorderShot(doc, c, -999).shots.map(s => s.id), [c,a,b]);
  assert.deepEqual(doc.shots.map(s => s.id), [a,b,c]);
  assert.equal(reorderShot(doc, a, NaN), doc); assert.equal(restoreShot(doc, 'missing'), doc);
  assert.equal(removeShot(doc, a).activeShotId, c); assert.equal(removeShot(doc, c).activeShotId, undefined);
  assert.deepEqual(removeShot(doc, c).scene, doc.scene);
});
test('malformed finite numbers and unstable camera geometry are rejected', () => {
  for (const value of [NaN, Infinity, -Infinity, '2', null]) {
    const doc = createDirectorDocument(); doc.scene.objects[0].position[0] = value;
    assert.equal(sanitizeDirectorDocument(doc), null);
  }
  for (const change of [d => d.scene.objects[0].scale[0] = 0, d => d.scene.camera.focalLength = 0, d => d.scene.camera.target = [...d.scene.camera.position], d => d.scene.lighting.intensity = -1, d => d.scene.lighting.color = 'url(https://external)', d => d.scene.camera.aspect = 'evil']) {
    const doc = createDirectorDocument(); change(doc); assert.equal(sanitizeDirectorDocument(doc), null);
  }
});
test('duplicate identities, unknown versions, missing required fields and dangling shot identity are rejected', () => {
  const doc = createDirectorDocument(); doc.scene.objects.push(doc.scene.objects[0]); assert.equal(sanitizeDirectorDocument(doc), null);
  const shotDoc = addShot(createDirectorDocument()); shotDoc.shots.push(shotDoc.shots[0]); assert.equal(sanitizeDirectorDocument(shotDoc), null);
  assert.equal(sanitizeDirectorDocument({ ...createDirectorDocument(), version: 2 }), null);
  assert.equal(sanitizeDirectorDocument({ ...createDirectorDocument(), activeShotId: 'missing' }), null);
  assert.equal(sanitizeDirectorDocument({ version: 1, shots: [] }), null);
});
test('object/shot/string/byte limits reject oversized imports without silent truncation', () => {
  const doc = createDirectorDocument(); doc.scene.objects = Array.from({length: 101}, (_, i) => createDirectorObject('box', `box-${i}`));
  assert.equal(sanitizeDirectorDocument(doc), null);
  let shotDoc = createDirectorDocument(); for (let i = 0; i < DIRECTOR_LIMITS.shots; i++) shotDoc = addShot(shotDoc);
  assert.equal(addShot(shotDoc), shotDoc); assert.ok(sanitizeDirectorDocument(shotDoc));
  assert.equal(sanitizeDirectorDocument({...shotDoc, shots: [...shotDoc.shots, {...shotDoc.shots[0], id: 'extra'}]}), null);
  const named = createDirectorDocument(); named.scene.objects[0].name = 'x'.repeat(121); assert.equal(sanitizeDirectorDocument(named), null);
  const notes = addShot(createDirectorDocument()); notes.shots[0].notes = 'x'.repeat(8001); assert.equal(sanitizeDirectorDocument(notes), null);
  const huge = createDirectorDocument(); huge.extra = '字'.repeat(700000); assert.equal(sanitizeDirectorDocument(huge), null);
});
test('safe JSON roundtrip strips unknown data and rejects cyclic/broken payloads', () => {
  const doc = addShot(createDirectorDocument()); doc.secret = 'ignored'; doc.scene.objects[0].url = 'https://external/model.glb';
  const safe = sanitizeDirectorDocument(doc); assert.equal(safe.secret, undefined); assert.equal(safe.scene.objects[0].url, undefined);
  assert.deepEqual(parseDirectorDocument(directorDocumentJson(doc)), safe);
  assert.equal(parseDirectorDocument('{broken'), null); assert.equal(parseDirectorDocument('x'.repeat(2000001)), null);
  const cyclic = createDirectorDocument(); cyclic.loop = cyclic; assert.equal(sanitizeDirectorDocument(cyclic), null);
  assert.throws(() => directorDocumentJson({version: 2}), /invalid-director-document/);
});
