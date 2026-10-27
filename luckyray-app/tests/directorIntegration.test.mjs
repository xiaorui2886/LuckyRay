import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertDirectorCapture, directorSessionMatches, directorShotDescription } from '../src/core/canvas/director/integration.ts';
import { sanitizeCanvasNodesForPersistence } from '../src/features/canvas/canvasPersistence.ts';

test('director session is fenced by both canvas and load epoch', () => {
  const owner = { canvasId: 'a', epoch: 7 };
  assert.equal(directorSessionMatches(owner, { canvasId: 'a', epoch: 7 }), true);
  assert.equal(directorSessionMatches(owner, { canvasId: 'b', epoch: 7 }), false);
  assert.equal(directorSessionMatches(owner, { canvasId: 'a', epoch: 8 }), false);
  assert.equal(directorSessionMatches(owner, { canvasId: null, epoch: 7 }), false);
});
test('director accepts only bounded local PNG captures', () => {
  assert.doesNotThrow(() => assertDirectorCapture('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'));
  for (const data of ['https://example.com/image.png', 'data:image/svg+xml;base64,abc', 'data:image/png;base64,hello', '', null]) assert.throws(() => assertDirectorCapture(data));
  assert.throws(() => assertDirectorCapture('data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(24*1024*1024)));
});
test('director document survives durable sanitization without transient selection', () => {
  const document = { version: 1, scene: { objects: [] }, shots: [] };
  const source = { id: 'stage', selected: true, measured: { width: 1 }, data: { kind: 'group', directorDocument: document, storyboard: { version: 1 }, _newHighlight: true } };
  const result = sanitizeCanvasNodesForPersistence([source])[0];
  assert.deepEqual(result.data.directorDocument, document);
  assert.equal(result.selected, undefined);
  assert.equal(result.data._newHighlight, undefined);
  assert.equal(source.selected, true);
});
test('shot description keeps exact camera and lighting context for storyboard', () => {
  const text = directorShotDescription({ notes: 'test', scene: { camera: { focalLength: 50, aspect: '16:9', position: [1,2,3], target: [0,1,0] }, lighting: { preset: 'night' } } });
  assert.match(text, /50 mm · 16:9/); assert.match(text, /night/); assert.match(text, /1, 2, 3/);
});
test('canvas integration remains lazy and uses native persisted storyboard path', () => {
  const source = fs.readFileSync(new URL('../src/CanvasSpike.tsx', import.meta.url), 'utf8');
  assert.match(source, /lazy\(\(\) => import\("\.\/features\/canvas\/director\/DirectorWorkspace"\)/);
  const start = source.indexOf('const exportDirectorShot =');
  const section = source.slice(start, source.indexOf('const createStoryboard', start));
  assert.match(section, /await bridge\.storeCanvasImageSlice\(png\)/);
  assert.match(section, /if \(!stillCurrent\(\)\) throw Error\('canvas-changed'\)/);
  assert.match(section, /await persistCurrentCanvas\(\)/);
  assert.match(section, /chosenResult:/);
  assert.doesNotMatch(section, /aiImageGenerate|aiVideoGenerate/);
});

test('retained export keeps current draft and exact captured scene', async () => {
  const { retainDirectorExport } = await import('../src/core/canvas/director/integration.ts');
  const { createDirectorDocument, addShot } = await import('../src/core/canvas/director/model.ts');
  const draft = createDirectorDocument();
  const captured = addShot(draft).shots[0];
  draft.scene.camera.focalLength = 99;
  const result = retainDirectorExport(draft, captured);
  assert.equal(result.scene.camera.focalLength, 99);
  assert.notEqual(result.shots[0].scene.camera.focalLength, 99);
  assert.equal(draft.shots.length, 0);
  assert.throws(() => retainDirectorExport(null, captured));
  assert.equal(retainDirectorExport(result, captured).shots.length, 1);
  assert.throws(() => retainDirectorExport(result, { ...captured, notes: 'changed' }));
  const full = { ...draft, shots: Array.from({ length: 40 }, (_, index) => ({ ...captured, id: `s${index}` })) };
  assert.throws(() => retainDirectorExport(full, captured), /too-many-director-shots/);
});

test('exported image snapshot remains editable after workspace snapshot history is removed', async () => {
  const { readDirectorShotSource, directorFrameDraft } = await import('../src/core/canvas/director/integration.ts');
  const { createDirectorDocument, addShot } = await import('../src/core/canvas/director/model.ts');
  const draft = createDirectorDocument();
  const shot = addShot(draft).shots[0];
  const imageSource = { version: 1, shotId: shot.id, shot: structuredClone(shot) };
  draft.scene.camera.focalLength = 99;
  const opened = directorFrameDraft(draft, imageSource);
  assert.notEqual(opened.scene.camera.focalLength, 99);
  assert.equal(draft.scene.camera.focalLength, 99, 'opening does not overwrite persisted stage');
  assert.equal(opened.shots.length, 0, 'opening does not add a snapshot or consume capacity');
  opened.scene.camera.focalLength = 120;
  assert.notEqual(imageSource.shot.scene.camera.focalLength, 120, 'editor cannot mutate image source');
  assert.equal(readDirectorShotSource({ version: 1, shotId: 'wrong', shot }), null);
  assert.equal(readDirectorShotSource({ version: 1, shotId: shot.id }), null);
  const full = { ...draft, shots: Array.from({ length: 40 }, (_, index) => ({ ...shot, id: `s${index}` })) };
  assert.equal(directorFrameDraft(full, imageSource).shots.length, 40, 'full stage can inspect a frame without adding snapshots');
});
