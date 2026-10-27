import test from 'node:test';
import assert from 'node:assert/strict';
import { canApplyCompanionPresentationScope, type PresentationScopeSnapshot } from '../src/app/companionPresentationScope.ts';
const snapshot = (): PresentationScopeSnapshot => ({
  material: { libraryId: 'material-a', status: 'ready', generation: 2 },
  knowledge: { vaultId: 'vault-a', status: 'ready', loaded: true, source: {}, transitionGeneration: 1, transitioning: false, confirmedVaultId: 'vault-a' },
});

test('material presentation accepts exact current scope and rejects switch while native claim waits', () => {
  const before = snapshot();
  const offer = { expectedMaterialLibraryId: 'material-a' };
  assert.equal(canApplyCompanionPresentationScope('materials', offer, before, before), true);
  for (const material of [
    { ...before.material, libraryId: 'material-b' },
    { ...before.material, status: 'switching' },
    { ...before.material, generation: 4 },
    { ...before.material, libraryId: null },
  ]) assert.equal(canApplyCompanionPresentationScope('materials', offer, before, { ...before, material }), false);
});

test('knowledge presentation rejects other vault, unloaded store, and retired or replaced source', () => {
  const before = snapshot();
  const offer = { expectedKnowledgeVaultId: 'vault-a' };
  assert.equal(canApplyCompanionPresentationScope('knowledge', offer, before, before), true);
  for (const knowledge of [
    { ...before.knowledge, vaultId: 'vault-b' },
    { ...before.knowledge, status: 'refreshing' },
    { ...before.knowledge, loaded: false },
    { ...before.knowledge, source: null },
    { ...before.knowledge, source: {} },
    { ...before.knowledge, transitioning: true },
    { ...before.knowledge, transitionGeneration: 2 },
    { ...before.knowledge, confirmedVaultId: 'vault-b' },
  ]) assert.equal(canApplyCompanionPresentationScope('knowledge', offer, before, { ...before, knowledge }), false);
});

test('missing or unknown native scope proof is fail closed, never switches desktop', () => {
  const state = snapshot();
  for (const domain of ['materials', 'knowledge'] as const) {
    assert.equal(canApplyCompanionPresentationScope(domain, {}, state, state), false);
    assert.equal(canApplyCompanionPresentationScope(domain, { expectedMaterialLibraryId: 'other', expectedKnowledgeVaultId: 'other' }, state, state), false);
    assert.equal(canApplyCompanionPresentationScope(domain, { expectedMaterialLibraryId: null, expectedKnowledgeVaultId: 1 }, state, state), false);
  }
});
