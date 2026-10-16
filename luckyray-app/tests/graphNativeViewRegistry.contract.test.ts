import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphNativeViewRegistry, graphNativeViews, requestGraphNativeDetach, isNativeGraphAdmission, sameNativeGraphSeed, type GraphNativeViewBinding } from '../src/features/graph/graphNativeViewRegistry.ts';
import { buildScopedGraphSeed, type ScopedGraphSnapshot } from '../src/workspace/scopedGraphRuntime.ts';
import { createGraphSessionStore } from '../src/features/graph/graphSessionStore.ts';
const sourceId = `graph-source-v1:${'a'.repeat(64)}`;
const snapshot: ScopedGraphSnapshot = { sourceId, snapshotId: 's1', revision: 'graph1', vaultId: 'vault-a', version: 1, generatedAt: 'now', documents: [{ relativePath: 'A.md', fileName: 'A.md', title: 'A', revision: 'r1', wikiLinks: [], embeds: [], frontmatterTags: [], mtime: 'now' }], embeds: [], grants: [{ kind: 'document', token: 'doc', relativePath: 'A.md' }], completeness: { complete: true, missing: [] } };
const vault = { id: 'vault-a', name: 'Vault', rootPath: '/exact/captured', mode: 'local', createdAt: 'created', lastOpenedAt: 'opened', schemaVersion: 1 };
const binding: GraphNativeViewBinding = { viewId: 'graph-1', vaultId: 'vault-a', title: 'Graph', generation: 1, vault, materialLibraryId: 'library-a', materialLibraryGeneration: 3, materialSourceVersion: 11 };
test('Main source admission compares complete topology and saved document revisions', () => {
  const seed = buildScopedGraphSeed(snapshot), provenance = { vault, materialLibraryId: 'library-a', materialLibraryGeneration: 3, materialSourceVersion: 11, documentRevisions: [{ relativePath: 'A.md', revision: 'r1' }] };
  assert.equal(isNativeGraphAdmission(seed, provenance, snapshot), true);
  assert.equal(isNativeGraphAdmission(seed, provenance, { ...snapshot, documents: [{ ...snapshot.documents[0], revision: 'r2' }] }), false, 'same visual topology cannot launder a different saved-content proof');
  assert.equal(isNativeGraphAdmission(seed, provenance, { ...snapshot, sourceId: undefined }), false);
  assert.equal(isNativeGraphAdmission(seed, { ...provenance, vault: { ...vault, id: 'other' } }, snapshot), false);
  assert.equal(sameNativeGraphSeed({ ...seed, nodes: seed.nodes.map(node => ({ ...node, label: 'forged' })) }, snapshot), false);
});
test('Main verifier receives only captured binding; missing and replaced verifiers fail closed', async () => {
  const registry = new GraphNativeViewRegistry(); await assert.rejects(registry.verifySource(binding), /unavailable/);
  let seen: GraphNativeViewBinding | undefined;
  const dispose = registry.installSourceVerifier(async value => { seen = value; return snapshot; });
  await registry.verifySource(binding); assert.deepEqual(seen, binding); assert.notEqual(seen!.vault, vault);
  assert.throws(() => registry.installSourceVerifier(async () => snapshot), /already-installed/); dispose();
  let finish!: (value: ScopedGraphSnapshot) => void;
  const stop = registry.installSourceVerifier(() => new Promise(resolve => { finish = resolve; }));
  const pending = registry.verifySource(binding); stop(); finish(snapshot); await assert.rejects(pending, /source-mismatch/);
});
test('native import reserves exact graph ID and native release can move the last view safely', () => {
  const store = createGraphSessionStore(); assert.equal(store.releaseNative('graph-1'), true);
  assert.equal(store.getSnapshot().views['graph-1'], undefined); assert.equal(Object.keys(store.getSnapshot().views).length, 1);
  store.openNative('graph-20', 'Received'); assert.equal(store.getSnapshot().activeTabId, 'graph-20');
  assert.throws(() => store.openNative('graph-20', 'collision'), /id-conflict/);
  assert.throws(() => store.openNative('random-path', 'forged'), /id-conflict/);
  assert.equal(store.add(), 'graph-21');
});

test('frozen source tracking notifies route/quit guards through release, abort, commit and unmount', async () => {
  const registry = new GraphNativeViewRegistry(); let notices = 0; registry.subscribe(() => notices++);
  const adapter = { binding: () => binding, freeze: () => {}, flush: async () => true, capture: async () => { throw Error('unused'); }, restore: async () => { throw Error('unused'); }, release: async () => {}, commitRelease: async () => {}, activate: async () => {}, abort: async () => {} };
  const stop = registry.register(binding.viewId, adapter);
  assert.equal(registry.hasFrozenViews(), false); const selected = registry.get(binding.viewId);
  selected.freeze(); assert.equal(registry.hasFrozenViews(), true); assert.equal(notices, 1);
  await selected.release(); assert.equal(registry.hasFrozenViews(), true); await selected.abort(); assert.equal(registry.hasFrozenViews(), false);
  selected.freeze(); await selected.activate(); assert.equal(registry.hasFrozenViews(), false);
  selected.freeze(); await selected.commitRelease(); assert.equal(registry.hasFrozenViews(), false);
  selected.freeze(); stop(); assert.equal(registry.hasFrozenViews(), false);
});


test('normal Graph detach requests carry only exact view ID and explicit copy/move intent', () => {
  const messages: any[] = [], previous = (globalThis as any).window;
  (globalThis as any).window = { dispatchEvent: (event: any) => { messages.push(event); } };
  const stop = graphNativeViews.register(binding.viewId, { binding: () => binding, freeze: () => {}, flush: async () => true, capture: async () => { throw Error('unused'); }, restore: async () => { throw Error('unused'); }, release: async () => {}, commitRelease: async () => {}, activate: async () => {}, abort: async () => {} });
  try {
    requestGraphNativeDetach(binding.viewId, false); requestGraphNativeDetach(binding.viewId, true);
    assert.deepEqual(messages.map(event => event.detail), [{ viewId: 'graph-1', move: false }, { viewId: 'graph-1', move: true }]);
    assert.throws(() => requestGraphNativeDetach('unknown', true), /not-mounted/);
    assert.throws(() => requestGraphNativeDetach(binding.viewId, null as any), /mode-invalid/);
  } finally { stop(); (globalThis as any).window = previous; }
});
