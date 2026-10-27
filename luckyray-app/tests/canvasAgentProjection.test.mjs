import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCanvasContext, acknowledgeProjectionImages, markProjectionImagesUnavailable } from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-projection.mjs';

const node = (id, text = 'source '.repeat(100), image) => ({ id, title: id, kind: image ? 'image' : 'text', text, editable: true, revision: `rev-${text.length}`, ...(image ? { image } : {}) });
const context = (nodes, extra = {}) => ({ version: 1, canvasId: 'canvas', canvasName: 'Canvas', snapshotRevision: '0000000000000001', nodes, connections: [], generation: { imageModels: [], videoModels: [], imageReady: false, videoReady: false }, ...extra });
const known = { epoch: 'run-1:step-1:context-window-1', baselineKnown: true };
const project = (value, previous, options = {}) => projectCanvasContext(value, previous, { ...known, ...options });
const ack = result => acknowledgeProjectionImages(result.baseline, result.images.map(n => n.id));

test('full first baseline, unchanged, revision-aware delta and replacement metadata', () => {
  const original = context([node('a'), node('b')]);
  const first = project(original); assert.equal(first.projection.mode, 'full');
  assert.equal(project(original, ack(first)).projection.mode, 'unchanged');
  const next = context([node('a', 'updated'), node('b')], { snapshotRevision: '0000000000000002', connections: [{ source: 'a', target: 'b' }], selectedNodeIds: ['b'] });
  const delta = project(next, ack(first)).projection;
  assert.equal(delta.mode, 'delta'); assert.deepEqual(delta.nodes.map(n => n.id), ['a']);
  assert.equal(delta.baseRevision, original.snapshotRevision);
  assert.deepEqual(delta.connections, next.connections); assert.deepEqual(delta.selectedNodeIds, ['b']);
  assert.equal(delta.coverage.complete, false);
});

test('unknown cache, resume, compaction and explicit full read restore all evidence', () => {
  const value = context([node('a'), node('b')]); const first = project(value);
  for (const options of [{ baselineKnown: false }, { epoch: 'resume' }, { epoch: 'after-compaction' }, { full: true }, { forceFull: true }]) {
    const result = project(value, ack(first), options);
    assert.equal(result.projection.mode, 'full'); assert.equal(result.projection.nodes.length, 2);
  }
  assert.equal(projectCanvasContext(value, ack(first)).projection.mode, 'full');
  assert.equal(project(value, { ...first.baseline, version: 0 }).projection.mode, 'full');
  assert.equal(project(value, { version: 1, epoch: known.epoch, canvasId: 'canvas' }).projection.mode, 'full');
  assert.equal(project(value, null).projection.mode, 'full');
});

test('working-set eviction never masquerades as deletion; explicit verified tombstones do', () => {
  const first = project(context([node('a'), node('b')]));
  const omitted = project(context([node('a')]), ack(first)).projection;
  assert.deepEqual(omitted.removedFromWorkingSet, ['b']); assert.deepEqual(omitted.deletedNodeIds, []);
  const deleted = project(context([node('a')]), ack(first), { coverage: { complete: true, totalNodes: 1 } }).projection;
  assert.deepEqual(deleted.deletedNodeIds, ['b']); assert.deepEqual(deleted.removedFromWorkingSet, []);
  assert.deepEqual(project(context([node('a')]), ack(first), { deletedNodeIds: ['b'] }).projection.deletedNodeIds, ['b']);
  assert.throws(() => project(context([node('a')]), ack(first), { deletedNodeIds: ['a'] }), /conflicting-tombstone/);
});

test('image admission fingerprints include bytes and revision, explicit reread always attaches', () => {
  const image = { mimeType: 'image/png', data: 'first-pixels' };
  const value = context([node('a', 'caption', image)]); const first = project(value);
  assert.equal(first.images.length, 1);
  assert.equal(project(value, first.baseline).images.length, 1, 'failed admission must not mark image delivered');
  const baseline = ack(first); assert.equal(project(value, baseline).images.length, 0);
  for (const options of [{ includeImages: true }, { explicitVisualRead: true }, { requiredVisualNodeIds: ['a'] }, { full: true }]) assert.equal(project(value, baseline, options).images.length, 1);
  assert.equal(project(context([{ ...value.nodes[0], revision: 'new-revision' }]), baseline).images.length, 1);
  const changedPixels = project(context([node('a', 'caption', { ...image, data: 'new-pixels' })]), baseline);
  assert.equal(changedPixels.images.length, 1); assert.equal(changedPixels.projection.mode, 'delta');
  assert.deepEqual(changedPixels.projection.nodes.map(n => n.id), ['a']);
  const unavailable = markProjectionImagesUnavailable(first.projection, ['a']);
  assert.equal(unavailable.nodes[0].imageAttached, undefined); assert.equal(unavailable.nodes[0].imageUnavailable, true);
  assert.deepEqual(unavailable.imageCoverage.attachedNodeIds, []);
  assert.deepEqual(project(context([]), baseline, { requiredVisualNodeIds: ['a'] }).projection.imageCoverage.missingRequiredNodeIds, ['a']);
});

test('projection cannot promote failed save or uncertain receipt to success', () => {
  const value = context([node('a')]);
  for (const receipt of [
    { status: 'failed', summary: 'save failed' },
    { status: 'failed', creation: { completion: 'applied-unconfirmed', revision: 'draft-revision' } },
    { status: 'cancelled', summary: 'cancelled' },
  ]) {
    const before = JSON.stringify(receipt);
    const result = { ...receipt, context: project(value).projection };
    assert.equal(result.status, receipt.status); assert.deepEqual(result.creation, receipt.creation);
    assert.equal(JSON.stringify(receipt), before);
  }
});

test('same synthetic task measures JSON bytes, image count and unchanged tool round trips only', t => {
  const image = { mimeType: 'image/png', data: 'p'.repeat(4096) };
  const base = context(Array.from({ length: 300 }, (_, i) => node(`node-${i}`, 'long evidence '.repeat(90), i < 8 ? image : undefined)));
  const task = [base, base, context(base.nodes.map((n, i) => i === 299 ? { ...n, text: 'changed', revision: 'new' } : n), { snapshotRevision: '0000000000000002' }), base];
  let baseline; let projectedBytes = 0; let projectedImageCount = 0;
  let baselineBytes = 0; let baselineImageCount = 0;
  for (const value of task) {
    const legacy = { ...value, nodes: value.nodes.map(({ image: pixels, ...n }) => ({ ...n, ...(pixels ? { imageAttached: true } : {}) })) };
    const images = value.nodes.filter(n => n.image).map(n => n.image);
    baselineBytes += Buffer.byteLength(JSON.stringify({ context: legacy, images })); baselineImageCount += images.length;
    const result = project(value, baseline); baseline = ack(result);
    projectedBytes += Buffer.byteLength(JSON.stringify({ context: result.projection, images: result.images.map(n => n.image) }));
    projectedImageCount += result.images.length;
    assert.equal(result.projection.counts.supplied, 300, 'no first-256 truncation');
  }
  assert.ok(projectedBytes < baselineBytes); assert.equal(baselineImageCount, 32); assert.equal(projectedImageCount, 8);
  // The same acceptance condition is deliberately RED for the faithfully
  // reconstructed legacy full-context/full-image result path and GREEN for
  // the verified-baseline projection. This is not a provider integration test.
  const noRepeatedUnchangedImages = count => assert.equal(count, 8, 'unchanged images should be admitted only once in a verified context window');
  assert.throws(() => noRepeatedUnchangedImages(baselineImageCount), /unchanged images/);
  noRepeatedUnchangedImages(projectedImageCount);
  t.diagnostic(JSON.stringify({ fixture: 'same-300-node-task-known-consumer-baseline', baseline: { serializedPayloadBytes: baselineBytes, imageCount: baselineImageCount, toolRoundTrips: task.length }, projected: { serializedPayloadBytes: projectedBytes, imageCount: projectedImageCount, toolRoundTrips: task.length }, interpretation: 'Offline transport bytes only; no token, provider latency, capability or quality claim. Production savings depend on verified consumer continuity.' }));
});
