import assert from 'node:assert/strict';
import { createFixture } from './fixture.mjs';

export function verifyKnowledge() {
  const f = createFixture();
  const call = (path, options = {}) => f.request({ path, ...options });
  const path = '/v1/services/knowledge/notes/note-1/editing';
  const payload = { opId: 'unique-1', noteId: 'unique-note-1', vaultId: 'vault-1', kind: 'create', title: 'Travel', content: 'retained exact bytes', expectedRevision: '' };
  const created = call('/v1/services/knowledge/notes', { method: 'POST', body: payload });
  assert.equal(created.status, 200);
  assert.equal(created.body.document.relativePath, 'Travel.md'); // Original Travel is in Trips.
  const duplicate = call('/v1/services/knowledge/notes', { method: 'POST', body: { ...payload, opId: 'unique-2', noteId: 'unique-note-2' } });
  assert.equal(duplicate.body.document.relativePath, 'Travel（副本）.md');
  assert.deepEqual(call('/v1/services/knowledge/notes', { method: 'POST', body: payload }), created);
  assert.equal(call('/v1/services/knowledge/notes', { method: 'POST', body: { ...payload, expectedRevision: null } }).body.code, 'OP_ID_REUSED');
  const restarted = createFixture(f.snapshot());
  assert.deepEqual(restarted.request({ path: '/v1/services/knowledge/notes', method: 'POST', body: payload }), created);
  const reading = `${path}?vault=vault-1`;
  const post = () => call(path, { method: 'POST', body: { vaultId: 'vault-1' } });
  const write = (sessionId, generation, editing) => call(path, { method: 'PUT', body: { vaultId: 'vault-1', sessionId, generation, editing } });
  assert.equal(write('caller-forged', 1, true).status, 410);
  assert.equal(post().body.editing, false);
  assert.equal(call(reading, { deviceId: 'device-read' }).body.mobileEditing, false);
  const token = post().body.sessionId;
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(write(token, 1, true).body.editing, true);
  assert.equal(call(reading).body.mobileEditing, false, 'requester is excluded');
  assert.equal(call(reading, { deviceId: 'device-read' }).body.mobileEditing, true);
  f.advanceEditing(10000);
  assert.equal(write(token, 1, false).body.editing, true, 'stale generation cannot release');
  f.advanceEditing(5000);
  assert.equal(write(token, 2, true).status, 410, 'equal generation did not renew');
  const replacement = post().body.sessionId;
  assert.equal(write(replacement, 1, true).status, 200);
  assert.equal(write(replacement, 2, false).status, 200);
  assert.equal(write(replacement, 3, true).status, 410, 'released token cannot revive');
  for (let index = 0; index < 1000; index += 1) {
    const opened = post(); assert.equal(opened.status, 200);
    assert.equal(write(opened.body.sessionId, 1, false).status, 200);
  }
  f.advanceEditing(15000);
  for (let index = 0; index < 512; index += 1) assert.equal(post().status, 200);
  assert.equal(post().status, 503);
  f.advanceEditing(15000);
  assert.equal(post().status, 200, 'expired reservations reclaim capacity');
  assert.equal(call(path, { method: 'POST', body: { vaultId: 'vault-1', sessionId: 'client' } }).status, 400);
  assert.equal(call(`${path}?vault=vault-1`, { method: 'POST', body: { vaultId: 'vault-1' } }).status, 400);
  assert.equal(write(post().body.sessionId, 9007199254740992, true).status, 400);
  assert.equal(call('/v1/services/knowledge/vaults/vault-1/directories?limit=1').body.nextAfterPath, '');
  assert.ok(call('/v1/services/knowledge/vaults/vault-1/directories?afterPath=').body.items.every(item => item.parentRelativePath !== ''));
  assert.equal(call('/v1/services/knowledge/vaults/vault-1/directories?afterPath=..%2Fescape').status, 400);
  assert.equal(call(`${reading}&vault=vault-1`).status, 400);
  f.revoke('device-a');
  assert.equal(post().status, 401);

  const state = createFixture().snapshot();
  state.notes[0].content = '[[Travel]]\n[[Missing]]\n![[attachments/train.png]]';
  state.noteBindings = [{ vaultId: 'vault-1', noteId: 'note-1', assetId: 'asset-1', target: 'attachments/train.png' },
    { vaultId: 'vault-1', noteId: 'note-1', assetId: 'asset-1', target: 'attachments/stale.png' }];
  state.devices['device-read'].catalogRead = false;
  const relations = createFixture(state);
  const relPath = '/v1/services/knowledge/notes/note-1/relations?vault=vault-1';
  const first = relations.request({ path: `${relPath}&limit=1` });
  assert.equal(first.body.items[0].kind, 'wikiLink');
  assert.equal(first.body.items[0].status, 'resolved');
  const all = relations.request({ path: relPath });
  assert.ok(all.body.items.some(item => item.kind === 'backlink'));
  assert.equal(all.body.items.filter(item => item.kind === 'material').length, 1, 'omit stale binding');
  assert.ok(relations.request({ path: relPath, deviceId: 'device-read' }).body.items.every(item => item.kind !== 'material'));
  const reverse = '/v1/services/knowledge/materials/asset-1/references?vault=vault-1';
  assert.equal(relations.request({ path: reverse }).body.items.length, 1);
  assert.equal(relations.request({ path: reverse, deviceId: 'device-read' }).status, 403);
  assert.equal(relations.request({ path: '/v1/services', deviceId: 'device-read' }).body.operations['knowledge.materialReferences'].state, 'notGranted');
  assert.equal(relations.request({ path: `${relPath}&after=${encodeURIComponent(first.body.nextAfter)}`, deviceId: 'device-read' }).status, 410);
  relations.grant('device-a', 'content.read', true);
  assert.equal(relations.request({ path: `${relPath}&after=${encodeURIComponent(first.body.nextAfter)}` }).status, 410);
  const inactive = createFixture({ ...state, currentVaultId: 'retired-vault' });
  assert.equal(inactive.request({ path: relPath }).status, 503);
  console.log('knowledge additive contract: PASS unique immutable replay, server lease/capacity, directories, relation grants/cursors; synthetic only');
}
if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll('\\', '/'))) verifyKnowledge();
