import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphSeed } from '../src/core/services/graph.ts';
import type { GraphRuntime } from '../src/features/graph/GraphRuntime.ts';
import { createGraphViewPresentation, createGraphViewPresentationRegistry, validateGraphViewPresentation, type GraphViewIdentity } from '../src/workspace/graphViewPresentation.ts';
import type { GraphSessionSnapshot } from '../src/features/graph/graphSessionStore.ts';

const identity: GraphViewIdentity = { viewId: 'view-a', vaultId: 'vault-a', sourceId: 'graph-source-v1:source-a', generation: 3 };
function fixture(source = identity) {
  let seed: GraphSeed = { source: 'real', nodes: [{ id: 0, key: 'note:a', type: 'note', label: 'A' }], edges: [] };
  const proof = { kind: 'graph' as const, snapshotId: `snapshot-${source.generation}`, revision: 'r1', sourceId: source.sourceId };
  let state: GraphSessionSnapshot = { camera: { scale: 1.4, panX: 52, panY: -31 }, view: { spatialVersion: 3, filters: { note: true, material: false, tag: true, web: false }, colorGroups: [{ query: 'A', color: '#aabbcc' }] }, positions: [{ key: 'note:a', x: 10, y: 20, vx: 0, vy: 0 }], focusedKey: 'note:a', relationSourceKey: null, searchQuery: 'my query', searchScope: { kind: 'document', label: 'A', nodeKeys: ['note:a'] }, sideOpen: true };
  let frozen = false, paints = 0;
  const runtime: GraphRuntime = { kind: 'scoped', allowWorker: false, vaultId: source.vaultId, readSeed: async () => seed, subscribe: () => () => {}, capability: () => ({ available: true }), completeness: () => ({ complete: true, missing: [] }), renderedRevision: () => proof.revision, dataProof: value => !value || value === seed ? { ...proof } : null, mutateRelation: async () => ({ changed: false, message: '' }), act: async () => {}, exportScreenshot: async () => 'saved', contextNodeKey: () => null, publishContext: () => {} };
  const controller = createGraphViewPresentation(source, runtime);
  const detach = controller.attach({ scene: () => ({ seed, proof }), capture: () => structuredClone(state), restore: next => { state = structuredClone(next); }, flush: () => true, freeze: value => { frozen = value; }, requestPaint: () => { paints++; } });
  return { controller, runtime, proof, detach, get seed() { return seed; }, refresh: () => { seed = { ...seed }; }, get state() { return state; }, get frozen() { return frozen; }, get paints() { return paints; } };
}
test('full per-view state roundtrips independently and requires exact expected backend proof', async () => {
  const a = fixture(), b = fixture({ ...identity, generation: 4 });
  const snapshot = a.controller.capture(a.proof);
  assert.equal(validateGraphViewPresentation(snapshot), true);
  assert.throws(() => a.controller.capture({ ...a.proof, sourceId: 'recreated-source' }), /proof-mismatch/);
  snapshot.state.camera.panX = 180;
  assert.equal(a.state.camera.panX, 52);
  const applied = b.controller.apply(snapshot, identity);
  assert.equal(b.frozen, true); assert.equal(b.paints, 1);
  let resolved = false; void applied.then(() => { resolved = true; }); await Promise.resolve(); assert.equal(resolved, false);
  assert.equal(b.controller.painted({ ...b.seed }, b.proof), false);
  assert.equal(b.controller.painted(b.seed, { ...b.proof, snapshotId: 'old' }), false);
  assert.equal(b.controller.painted(b.seed, b.proof), true);
  const ack = await applied;
  assert.deepEqual(ack.source, identity); assert.equal(ack.target.generation, 4);
  assert.equal(ack.captureId, snapshot.captureId); assert.equal(ack.sourceProof.snapshotId, a.proof.snapshotId); assert.equal(ack.proof.snapshotId, b.proof.snapshotId);
  assert.deepEqual(b.state, snapshot.state); assert.equal(a.state.camera.panX, 52);
  assert.equal(b.frozen, true); b.controller.release(); assert.equal(b.frozen, false);
});
test('wrong view, same-ID source recreation, generation, revision, forged positions and shape reject without mutation', async () => {
  const a = fixture(), snapshot = a.controller.capture(a.proof);
  for (const mutate of [
    (s: any) => { s.source.viewId = 'other'; }, (s: any) => { s.source.sourceId = 'recreated'; },
    (s: any) => { s.source.generation++; }, (s: any) => { s.proof.revision = 'r2'; },
    (s: any) => { s.state.positions[0].key = 'note:other'; }, (s: any) => { s.state.positions = []; },
    (s: any) => { s.state.camera.scale = Infinity; }, (s: any) => { s.state.searchScope.nodeKeys = ['note:other']; },
    (s: any) => { s.extra = true; },
  ]) {
    const input = structuredClone(snapshot); mutate(input); await assert.rejects(a.controller.apply(input, identity));
    assert.deepEqual(a.controller.capture(a.proof).state, snapshot.state); assert.equal(a.frozen, false);
  }
});
test('apply rejects stale exact seed, cancellation, unmount, refreshed proof and partially restored presentation', async () => {
  for (const mode of ['refresh', 'invalidate', 'abort', 'detach', 'dispose', 'tamper'] as const) {
    const a = fixture(), snapshot = a.controller.capture(a.proof), seed = a.seed;
    const applied = a.controller.apply(snapshot, identity);
    const rejected = assert.rejects(applied, /invalidated|aborted|detached|closed|mismatch/);
    if (mode === 'refresh') { a.refresh(); assert.equal(a.controller.painted(seed, a.proof), false); a.controller.invalidate(); }
    if (mode === 'invalidate') a.controller.invalidate();
    if (mode === 'abort') a.controller.abort();
    if (mode === 'detach') a.detach();
    if (mode === 'dispose') a.controller.dispose();
    if (mode === 'tamper') { a.state.camera.panX++; assert.equal(a.controller.painted(a.seed, a.proof), false); }
    await rejected;
  }
});
test('Main registry selects stable view IDs and never substitutes its active view', async () => {
  const a = fixture(), b = fixture({ ...identity, viewId: 'view-b' }), registry = createGraphViewPresentationRegistry();
  const releaseA = registry.register(a.controller); registry.register(b.controller);
  assert.throws(() => registry.capture('unknown', a.proof), /not-registered/);
  assert.throws(() => registry.register(a.controller), /already-registered/);
  assert.equal(await registry.flush('view-a'), true);
  registry.freeze('view-b'); assert.equal(b.frozen, true); assert.equal(a.frozen, false);
  registry.abort('view-b'); assert.equal(b.frozen, false);
  releaseA(); assert.throws(() => registry.get('view-a'), /not-registered/); assert.equal(registry.get('view-b'), b.controller);
});


test('destination view ID may differ while source generation and backend presentation hash remain exact', async () => {
  const source = fixture(), target = fixture({ ...identity, viewId: 'graph-target', generation: 12 });
  const captured = source.controller.capture(source.proof), hash = 'handoff-v1:exact-backend-hash';
  const result = target.controller.apply(captured, identity, hash);
  assert.equal(target.controller.painted(target.seed, target.proof), true);
  const ack = await result;
  assert.equal(ack.source.viewId, 'view-a'); assert.equal(ack.target.viewId, 'graph-target'); assert.equal(ack.target.generation, 12); assert.equal(ack.presentationHash, hash);
});

test('pending target can freeze before renderer mount; attachment receives the queued state', () => {
  const f = fixture(); const controller = createGraphViewPresentation(identity, f.runtime); let frozen = false;
  controller.freeze(); assert.equal(controller.isFrozen(), true); assert.throws(() => controller.capture(f.proof), /unavailable/);
  const detach = controller.attach({ scene: () => ({ seed: f.seed, proof: f.proof }), capture: () => f.state, restore: () => {}, flush: () => true, freeze: value => { frozen = value; }, requestPaint: () => {} });
  assert.equal(frozen, true); detach(); controller.abort(); assert.equal(controller.isFrozen(), false);
});
