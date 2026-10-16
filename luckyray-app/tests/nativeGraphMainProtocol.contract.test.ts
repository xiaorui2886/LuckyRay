import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateGraphMainClaim } from '../src/workspace/nativeGraphMainProtocol.ts';
import { MaterialNativeDetailRegistry, sameMaterialDetailAsset } from '../src/features/materials/materialNativeDetailRegistry.ts';
const token = 'a'.repeat(64);
test('Main claims reject forged tokens, unsupported actions, invalid image bytes and oversized AI context', () => {
  const claim = { id: token, claimToken: token, remainingMs: 1000, action: { kind: 'screenshot' as const, mime: 'image/png' as const, bytes: [137,80,78,71,13,10,26,10] } };
  assert.doesNotThrow(() => validateGraphMainClaim(claim));
  for (const mutation of [{ id: 'fake' }, { remainingMs: 0 }, { action: { kind: 'opener', path: '/forged' } }, { action: { ...claim.action, bytes: [1,2,3] } }, { action: { ...claim.action, bytes: [137,80,78,71,13,10,26,10,256] } }, { action: { kind: 'composeAi', source: 'graph', text: 'x'.repeat(12289) } }]) assert.throws(() => validateGraphMainClaim({ ...claim, ...mutation } as any));
});
test('catalog detail registry has explicit view/library identity and compares whole asset rows', () => {
  const registry = new MaterialNativeDetailRegistry(), adapter = { binding: () => ({ viewId: 'main-materials', libraryId: 'captured', generation: 8, ready: true }), openDetail: async () => ({ viewId: 'main-materials', libraryId: 'captured', generation: 8, assetId: 'asset', assetRevision: 'r1' }) };
  assert.throws(() => registry.get('active'), /unavailable/); const stop = registry.register('main-materials', adapter);
  assert.equal(registry.get('main-materials'), adapter); assert.throws(() => registry.register('main-materials', adapter), /already-registered/); stop(); assert.throws(() => registry.get('main-materials'), /unavailable/);
  const asset = { id: 'a', name: 'A', updatedAt: 'now' } as any;
  assert.equal(sameMaterialDetailAsset(asset, { updatedAt: 'now', name: 'A', id: 'a' } as any), true);
  assert.equal(sameMaterialDetailAsset(asset, { ...asset, updatedAt: 'later' }), false);
});
test('production Main Graph consumer uses explicit library detail ACK and no download or legacy workspace fallback', () => {
  const source = readFileSync(new URL('../src/workspace/WorkspaceGraphMainActions.tsx', import.meta.url), 'utf8');
  for (const required of ["materialLibrarySession.select(action.libraryId)", "materialNativeDetailViews.get('main-materials')", 'await adapter.openDetail', 'ack.assetRevision !== action.assetRevision', "window.location.hash = '#materials'", 'await openDocumentRef.current(result.view)', "kind: 'saveScreenshot'", 'await navigator.clipboard.write', 'leaseToken']) assert.ok(source.includes(required), required);
  for (const forbidden of ['#workspace', 'createObjectURL', 'link.download', 'window.open(']) assert.equal(source.includes(forbidden), false, forbidden);
});
