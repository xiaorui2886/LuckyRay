/** Wire-level smoke of the independent loopback-only synthetic fixture server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const child = spawn(process.execPath, ['fixture-server.mjs', '--port', '0'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture start timeout: ${stderr}`)), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', chunk => {
      clearTimeout(timer);
      const match = /SYNTHETIC ONLY (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString('utf8'));
      match ? resolve(match[1]) : reject(new Error(`unexpected fixture banner: ${chunk}`));
    });
  });
  const call = async (path, { token = 'fixture-device-a', method = 'GET', body } = {}) => {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const discovery = await call('/v1/services');
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.bundleRevision, '2026-09-30.1');
  assert.equal((await call('/v1/services/knowledge/vaults/vault-1/changes?after=k:0')).body.items.length, 1);
  assert.equal(discovery.body.operations['knowledge.editingOpen'].state, 'implemented');
  const editing = '/v1/services/knowledge/notes/note-1/editing';
  const opened = await call(editing, { method: 'POST', body: { vaultId: 'vault-1' } });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.editing, false);
  const lease = { vaultId: 'vault-1', sessionId: opened.body.sessionId, generation: 1, editing: true };
  assert.equal((await call(editing, { method: 'PUT', body: lease })).status, 200);
  assert.equal((await call(`${editing}?vault=vault-1`, { token: 'fixture-device-read' })).body.mobileEditing, true);
  assert.equal((await call('/__fixture/control', { token: 'fixture-control-test-only', method: 'POST',
    body: { action: 'advance-editing', milliseconds: 15000 } })).status, 200);
  assert.equal((await call(editing, { method: 'PUT', body: { ...lease, generation: 2 } })).status, 410);
  assert.equal((await call('/v1/services/knowledge/vaults/vault-1/directories?limit=1')).body.items[0].parentRelativePath, '');
  assert.equal((await call('/v1/services/knowledge/notes/note-1/relations?vault=vault-1')).status, 200);
  const uniquePayload = { opId: 'http-unique', noteId: 'http-note', vaultId: 'vault-1', kind: 'create', title: 'HTTP note', content: 'Exact HTTP text', expectedRevision: '' };
  const unique = await call('/v1/services/knowledge/notes', { method: 'POST', body: uniquePayload });
  assert.equal(unique.status, 200);
  assert.deepEqual(await call('/v1/services/knowledge/notes', { method: 'POST', body: uniquePayload }), unique);
  assert.equal((await call('/v1/services/knowledge/materials/asset-1/references?vault=vault-1')).status, 200);
  assert.equal((await call('/v1/services/materials/assets/asset-1', { token: 'fixture-device-read', method: 'PATCH',
    body: { opId: 'denied', expectedRevision: 'asset-r1', name: 'No' } })).status, 403);
  assert.equal((await call('/__fixture/control', { token: 'fixture-control-test-only', method: 'POST',
    body: { action: 'cursor-floor', domain: 'materials', floor: 1 } })).status, 200);
  assert.equal((await call('/v1/services/materials/changes?after=m:0')).status, 410);
  const search = await call('/v1/services/search?q=Blue&limit=1');
  assert.equal(search.status, 200);
  assert.ok(search.body.nextCursor);
  await call('/__fixture/control', { token: 'fixture-control-test-only', method: 'POST', body: { action: 'expire-search' } });
  assert.equal((await call(`/v1/services/search?q=Blue&limit=1&cursor=${search.body.nextCursor}`)).status, 410);
  for (let round = 0; round < 5; round += 1) {
    const first = await call('/v1/services/search?q=Blue&limit=1');
    assert.equal(first.status, 200);
    const last = await call(`/v1/services/search?q=Blue&limit=1&cursor=${first.body.nextCursor}`);
    assert.equal(last.status, 200);
    assert.equal(last.body.nextCursor, null);
    assert.equal((await call(`/v1/services/search?q=Blue&limit=1&cursor=${first.body.nextCursor}`)).status, 410,
      'completed cursor retry must report 410');
  }
  await call('/__fixture/control', { token: 'fixture-control-test-only', method: 'POST', body: { action: 'reconnect' } });
  assert.equal((await call('/v1/services')).body.gatewayGeneration, 8);
  await call('/__fixture/control', { token: 'fixture-control-test-only', method: 'POST', body: { action: 'revoke', deviceId: 'device-a' } });
  assert.equal((await call('/v1/services')).body.code, 'AUTH_REVOKED');
  console.log('services-v1 HTTP fixture: PASS (loopback, auth, scope, cursor floor, reconnect, revoke)');
} finally {
  child.kill();
}
