import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeGraphRuntime, loadNativeGraphRuntime, type NativeGraphRuntimeServices } from '../src/workspace/nativeGraphRuntime.ts';
import { isCurrentGraphDataProof } from '../src/features/graph/GraphRuntime.ts';
import type { ScopedGraphSnapshot } from '../src/workspace/scopedGraphRuntime.ts';
const sourceId = `graph-source-v1:${'a'.repeat(64)}`;
function dto(): ScopedGraphSnapshot { return {
  sourceId, snapshotId: 'snapshot-a', revision: 'graph-v1:content', vaultId: 'vault-a', version: 1, generatedAt: 'now',
  documents: [{ relativePath: 'A.md', fileName: 'A.md', title: 'A', revision: 'r1', wikiLinks: [{ raw: '[[New]]', target: 'New', alias: null, line: 1 }], embeds: [], frontmatterTags: ['one'], mtime: 'now' }],
  embeds: [{ sourceRelativePath: 'A.md', resolutions: [{ kind: 'library-asset', assetId: 'asset-a', assetName: 'Image' }, { kind: 'vault-asset', relativePath: 'img.png', label: 'Image' }] }],
  grants: [{ kind: 'document', token: 'document', relativePath: 'A.md' }, { kind: 'missing-document', token: 'missing', sourceRelativePath: 'A.md', relativePath: 'New.md', title: 'New' }, { kind: 'tag', token: 'tag', tag: 'one' }, { kind: 'library-asset', token: 'asset', assetId: 'asset-a' }, { kind: 'vault-asset', token: 'vault-asset', relativePath: 'img.png' }], completeness: { complete: true, missing: [] },
}; }
function fixture() { const calls: unknown[] = []; let next = dto(); const services: NativeGraphRuntimeServices = {
  capabilities: async () => ({kinds:['openDocument','createMissing','openTag','openCatalogAsset','composeAi','fileOperation','screenshot'],expiresInMs:30000}),
  command: async request => { calls.push(request); return structuredClone(next); },
  nodeAction: async request => { calls.push(request); }, mutateTag: async request => { calls.push(request); return { changed: false, message: 'unchanged' }; },
  exportScreenshot: async request => { calls.push(request); return 'saved'; },
  actions: ['open', 'createMissing', 'openDefault', 'reveal', 'askAi'],
  nodeActions: { document: ['open', 'openDefault', 'reveal', 'askAi'], tag: ['open', 'askAi'], 'missing-document': ['createMissing'], 'library-asset': ['open', 'openDefault', 'reveal', 'askAi'], 'vault-asset': ['open', 'openDefault', 'reveal', 'askAi'] },
}; return { services, calls, change: (value: ScopedGraphSnapshot) => { next = value; } }; }
test('native captured source uses every opaque ticket kind and explicit screenshot service', async () => {
  const f = fixture(), runtime = await loadNativeGraphRuntime('view', 'vault-a', 8, f.services), seed = await runtime.readSeed();
  assert.equal(f.calls.length, 1); assert.equal(isCurrentGraphDataProof(runtime, runtime.dataProof(seed), seed), true);
  for (const node of seed.nodes) for (const action of f.services.nodeActions![node.status === 'missing' ? 'missing-document' : node.type === 'note' ? 'document' : node.type === 'tag' ? 'tag' : node.entityId?.startsWith('real-vault-asset:') ? 'vault-asset' : 'library-asset']!) await runtime.act(action, node);
  const calls = f.calls.slice(1) as Array<Record<string, unknown>>;
  assert.ok(calls.every(request => request.op === 'graphNodeAction' && request.viewId === 'view' && request.snapshotId === 'snapshot-a' && typeof request.nodeToken === 'string' && !('relativePath' in request)));
  await runtime.exportScreenshot!(new Blob(['png'], { type: 'image/png' }));
  const screenshot = f.calls.at(-1) as any;
  assert.equal(screenshot.sourceId, sourceId); assert.equal(screenshot.generation, 8); assert.equal(screenshot.snapshotId, 'snapshot-a');
});
test('native parity requires exact material consumers and screenshot/mutation services', async () => {
  for (const missing of ['nodeAction', 'mutateTag', 'exportScreenshot', 'capabilities'] as const) {
    const f = fixture(); delete f.services[missing]; const runtime = await loadNativeGraphRuntime('view', 'vault-a', 0, f.services), seed = await runtime.readSeed();
    assert.equal(isCurrentGraphDataProof(runtime, runtime.dataProof(seed), seed), false, missing);
  }
});
test('same-vault source recreation, missing source, closed and frozen views fail closed', async () => {
  const f = fixture(), runtime = await loadNativeGraphRuntime('view', 'vault-a', 0, f.services), seed = await runtime.readSeed();
  runtime.setFrozen!(true); await assert.rejects(runtime.act('open', seed.nodes[0]), /frozen/); runtime.setFrozen!(false);
  f.change({ ...dto(), sourceId: `graph-source-v1:${'b'.repeat(64)}` }); await assert.rejects(runtime.readSeed({ refresh: true }), /scope-mismatch/);
  runtime.dispose(); assert.equal(runtime.dataProof(), null); assert.equal(runtime.completeness().complete, false);
  await assert.rejects(runtime.readSeed(), /closed/);
  assert.throws(() => createNativeGraphRuntime({ viewId: 'view', vaultId: 'vault-a', sourceId: '', generation: 0 }, f.services), /scope-mismatch/);
});
test('closing a loaded cached graph prevents subsequent reads and ACKs', async () => {
  const f = fixture(), runtime = await loadNativeGraphRuntime('view', 'vault-a', 0, f.services);
  await runtime.readSeed(); runtime.dispose(); await assert.rejects(runtime.readSeed(), /closed/);
  assert.equal(runtime.dataProof(), null);
});

test('pending native replies cannot revive a disposed graph', async () => {
  let finish!: (value: unknown) => void;
  const f = fixture(), runtime = createNativeGraphRuntime({ viewId: 'view', vaultId: 'vault-a', sourceId, generation: 0 }, { ...f.services, command: () => new Promise(resolve => { finish = resolve; }) });
  const read = runtime.readSeed(); runtime.dispose(); finish(dto()); await assert.rejects(read, /closed/); assert.equal(runtime.dataProof(), null);
});

test('mounted capability changes revoke readiness without replacing graph seed or snapshot tickets', async () => {
  const f = fixture(); let mounted = true;
  const all = await f.services.capabilities!(); f.services.capabilities = async () => mounted ? all : { kinds: [], expiresInMs: 0 };
  const runtime = await loadNativeGraphRuntime('view','vault-a',0,f.services), seed = await runtime.readSeed(), proof = runtime.dataProof(seed);
  let notices = 0; runtime.subscribeReadiness(() => notices++);
  mounted = false; await runtime.refreshCapabilities(); assert.equal(isCurrentGraphDataProof(runtime, proof, seed), false); assert.equal(runtime.capability('screenshot').available, false);
  await assert.rejects(runtime.act('open',seed.nodes[0]), /verified parent route/); assert.equal(notices,1);
  mounted = true; await runtime.refreshCapabilities(); assert.equal(isCurrentGraphDataProof(runtime, proof, seed), true); assert.equal(await runtime.readSeed(), seed);
  assert.equal(f.calls.length,1,'capability renewal never refreshes graph authority'); assert.equal(notices,2);runtime.dispose();
});
