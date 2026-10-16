import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixture.mjs';
import { verifyKnowledge } from './verify-knowledge.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const parse = name => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const names = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name !== 'SHA256SUMS.json')
  .map(entry => entry.name).sort();
for (const name of names) assert.ok(!name.includes('\\') && basename(name) === name);
const hashes = Object.fromEntries(names.map(name => [name, sha(readFileSync(join(dir, name)))]));
if (!process.argv.includes('--preseal')) {
  const seal = parse('SHA256SUMS.json');
  assert.deepEqual(seal.files, hashes, 'file set and hashes must be exact');
  const lines = names.map(name => `${name}\0${hashes[name]}\n`).join('');
  assert.equal(seal.bundleDigest, sha(Buffer.from(lines, 'utf8')), 'bundle digest');
}
const bundleManifest = parse('manifest.json');
const inventory = parse('operations.json');
const schema = parse('schema.json');
assert.equal(inventory.bundleRevision, bundleManifest.bundleRevision, 'operations bundle revision');
assert.equal(schema.$id, `https://luckyray.local/companion/services-v1/${bundleManifest.bundleRevision}/schema.json`,
  'schema revision identifier');
const operations = inventory.operations;
assert.equal(new Set(operations.map(o => o.id)).size, operations.length, 'unique operation IDs');
for (const operation of operations) {
  assert.ok(operation.capability && operation.scope && 'grant' in operation);
  if (operation.atFreeze === 'unsupported') assert.equal(operation.path, null);
  else assert.ok(operation.path?.startsWith('/v1/'));
}
const golden = parse('golden.json');
assert.equal(golden.revision, bundleManifest.bundleRevision);
for (const example of golden.cases) {
  const result = createFixture().request(example.request);
  assert.equal(result.status, example.status, example.name);
  if (example.body) assert.deepEqual(result.body, example.body, example.name);
  for (const [key, value] of Object.entries(example.contains ?? {})) assert.deepEqual(result.body[key], value, example.name);
}
const fixture = createFixture();
const query = (path, rest = {}) => fixture.request({ path, ...rest });
const patch = { opId: 'rename-1', expectedRevision: 'asset-r1', name: 'Blue coastal train' };
const initial = query('/v1/services/materials/assets/asset-1', { method: 'PATCH', body: patch });
assert.equal(initial.status, 200);
assert.deepEqual(query('/v1/services/materials/assets/asset-1', { method: 'PATCH', body: patch }), initial, 'lost response replay');
assert.equal(query('/v1/services/materials/assets/asset-1', { method: 'PATCH', body: { ...patch, name: 'Other' } }).body.code, 'OP_ID_REUSED');
assert.equal(query('/v1/services/materials/assets/asset-1', { method: 'PATCH', body: { ...patch, opId: 'rename-2' } }).body.code, 'REVISION_CONFLICT');
fixture.reconnect();
assert.deepEqual(query('/v1/services/materials/assets/asset-1', { method: 'PATCH', body: patch }), initial, 'generation change replay');
assert.equal(query('/v1/services').body.gatewayGeneration, 8);
assert.equal(query('/v1/services/materials/changes?after=m:0').body.items.length, 2);
const hintCursor = fixture.hints().find(hint => hint.kind === 'materialChanged').cursor;
assert.equal(query(`/v1/services/materials/changes?after=${hintCursor}`).status, 200, 'hint cursor uses same scope encoding');
const oldCursor = query('/v1/services/materials/changes?after=m:0').body.nextCursor;
fixture.grant('device-a', 'content.read', false);
fixture.grant('device-a', 'content.read', true);
assert.equal(query(`/v1/services/materials/changes?after=${oldCursor}`).body.code, 'CURSOR_TOO_OLD');
fixture.setCursorFloor('materials', 1);
assert.equal(query('/v1/services/materials/changes?after=m:0').body.code, 'CURSOR_TOO_OLD');
const remove = { opId: 'remove-1', expectedRevision: initial.body.revision, mode: 'removeRecord' };
const removed = query('/v1/services/materials/assets/asset-1', { method: 'DELETE', body: remove });
assert.equal(removed.status, 200);
assert.deepEqual(query('/v1/services/materials/assets/asset-1', { method: 'DELETE', body: remove }), removed);
assert.equal(query('/v1/services/materials/assets/asset-1').status, 404);
const moved = { opId: 'move-1', vaultId: 'vault-1', expectedRevision: 'note-r1', parentRelativePath: 'Places/Coast' };
const move = query('/v1/services/knowledge/notes/note-1/move', { method: 'PATCH', body: moved });
assert.equal(move.status, 200);
assert.deepEqual(query('/v1/services/knowledge/notes/note-1/move', { method: 'PATCH', body: moved }), move);
assert.equal(query('/v1/services/knowledge/notes/note-1/move', { method: 'PATCH', body: { ...moved, opId: 'move-2', parentRelativePath: '../escape' } }).status, 400);
assert.equal(query('/v1/services/knowledge/vaults/vault-2/notes').status, 403);
const bytes = Buffer.from('hello-fixture');
const manifest = { opId: 'import-1', kind: 'file', target: { domain: 'knowledge', vaultId: 'vault-1', parentRelativePath: 'Inbox' },
  name: 'Captured', mimeType: 'text/plain', sizeBytes: bytes.length, sha256: sha(bytes) };
const begun = query('/v1/services/ingest/jobs', { method: 'POST', body: manifest });
assert.equal(begun.status, 201);
const jobPath = `/v1/services/ingest/jobs/${begun.body.jobId}`;
assert.equal(query(jobPath, { deviceId: 'device-read' }).status, 404);
assert.equal(query(`${jobPath}/complete`, { method: 'POST' }).body.code, 'UPLOAD_INCOMPLETE');
const headers = { 'x-chunk-offset': '0', 'x-chunk-sha256': sha(bytes) };
assert.equal(query(`${jobPath}/chunks`, { method: 'PUT', body: bytes, headers }).status, 200);
assert.equal(query(`${jobPath}/chunks`, { method: 'PUT', body: bytes, headers }).status, 200, 'duplicate chunk');
assert.equal(query(`${jobPath}/chunks`, { method: 'PUT', body: Buffer.from('bad'), headers }).body.code, 'UPLOAD_HASH_MISMATCH');
const completed = query(`${jobPath}/complete`, { method: 'POST' });
assert.equal(completed.status, 200);
assert.deepEqual(query(`${jobPath}/complete`, { method: 'POST' }), completed, 'complete replay');
assert.equal(query('/v1/services/ingest/jobs', { method: 'POST', body: manifest }).body.state, 'completed');
const restored = createFixture(fixture.snapshot());
assert.deepEqual(restored.request({ method: 'POST', path: `${jobPath}/complete` }), completed, 'restart replay');
fixture.revoke('device-a');
assert.equal(query(jobPath).body.code, 'AUTH_REVOKED');
assert.equal(query('/v1/services').body.code, 'AUTH_REVOKED');
assert.ok(fixture.hints().some(hint => hint.kind === 'servicesChanged'));
assert.equal(createFixture().request({ path: '/v1/services', deviceId: 'unknown' }).body.code, 'PAIRING_REQUIRED');
const safety = createFixture();
const invoke = (path, rest = {}) => safety.request({ path, ...rest });
assert.equal(invoke('/v1/services/materials/assets/asset-1', { method: 'POST',
  body: { opId: 'wrong-method', expectedRevision: 'asset-r1', mode: 'removeRecord' } }).body.code, 'METHOD_NOT_ALLOWED');
assert.equal(invoke('/v1/services/materials/assets/asset-1').status, 200);
assert.equal(invoke('/v1/services/materials/assets/asset-1', { method: 'PATCH',
  body: { opId: 'wrong-type', expectedRevision: 'asset-r1', name: 42 } }).status, 400);
const unsafe = { opId: 'unsafe-1', kind: 'image', target: { domain: 'materials' }, name: 'x.jpg',
  mimeType: 'image/jpeg', sizeBytes: 1, sha256: sha(Buffer.from('x')),
  source: { captureKind: 'web', pageUrl: 'https://user:pass@example.com/image?token=private' } };
assert.equal(invoke('/v1/services/ingest/jobs', { method: 'POST', body: unsafe }).status, 400);
const sourceFixture = createFixture();
const sourceText = 'source-probe';
const sourceBase = { kind: 'text', target: { domain: 'materials' }, name: 'Provenance',
  mimeType: 'text/plain', text: sourceText, sizeBytes: Buffer.byteLength(sourceText), sha256: sha(Buffer.from(sourceText)) };
for (const [id, source, expectedKind, expectedUrl] of [
  ['capture', { captureKind: 'web', pageKind: 'capture-page', pageUrl: 'https://example.test/search?q=train#slide-3' }, 'capture-page', 'https://example.test/search?q=train#slide-3'],
  ['work', { captureKind: 'web', pageKind: 'work-page', pageUrl: 'https://example.test/#/work/42' }, 'work-page', 'https://example.test/#/work/42'],
  ['legacy', { captureKind: 'web', pageUrl: 'https://example.test/collection?id=42' }, 'capture-page', 'https://example.test/collection?id=42'],
  ['origin', { captureKind: 'web', siteOrigin: 'https://example.test' }, 'capture-page', 'https://example.test/']
]) {
  const begun = sourceFixture.request({ method: 'POST', path: '/v1/services/ingest/jobs', body: { ...sourceBase, opId: `source-${id}`, source } });
  assert.equal(begun.status, 201, id);
  const receipt = sourceFixture.request({ method: 'POST', path: `/v1/services/ingest/jobs/${begun.body.jobId}/complete` });
  assert.equal(receipt.status, 200, id);
  const detail = sourceFixture.request({ path: `/v1/services/materials/assets/${receipt.body.receipt.assetId}` });
  assert.equal(detail.body.source.pageKind, expectedKind, id);
  assert.equal(detail.body.source.pageUrl, expectedUrl, id);
}
for (const [id, pageUrl] of [
  ['secret-fragment', 'https://example.test/#/work?token=secret'],
  ['encoded-secret', 'https://example.test/#/work%3Ftoken%3Dsecret'],
  ['secret-query', 'https://example.test/work?api_key=secret'],
  ['direct-media', 'https://example.test/image.jpg']
]) {
  assert.equal(sourceFixture.request({ method: 'POST', path: '/v1/services/ingest/jobs',
    body: { ...sourceBase, opId: `source-${id}`, source: { captureKind: 'web', pageKind: 'work-page', pageUrl } } }).status, 400, id);
}
assert.equal(sourceFixture.request({ method: 'POST', path: '/v1/services/ingest/jobs',
  body: { ...sourceBase, opId: 'source-no-work-url', source: { captureKind: 'web', pageKind: 'work-page', siteOrigin: 'https://example.test' } } }).status, 400);
const inlineText = 'https://example.com/work?id=123';
const inline = { opId: 'url-1', kind: 'url', target: { domain: 'knowledge', vaultId: 'vault-1', parentRelativePath: 'Inbox' },
  name: 'Work link', mimeType: 'text/uri-list', text: inlineText, sizeBytes: Buffer.byteLength(inlineText), sha256: sha(Buffer.from(inlineText)) };
const inlineJob = invoke('/v1/services/ingest/jobs', { method: 'POST', body: inline });
assert.equal(inlineJob.status, 201);
assert.equal(inlineJob.body.committedBytes, inline.sizeBytes);
assert.equal(invoke(`/v1/services/ingest/jobs/${inlineJob.body.jobId}/complete`, { method: 'POST' }).status, 200);
assert.equal(invoke('/v1/services/ingest/jobs', { method: 'POST', body: { ...inline, opId: 'url-no-text', text: undefined } }).status, 400);
const sharedOp = { ...manifest, opId: 'shared-id' };
const firstDevice = invoke('/v1/services/ingest/jobs', { method: 'POST', body: sharedOp });
const secondDevice = invoke('/v1/services/ingest/jobs', { method: 'POST', deviceId: 'device-read', body: sharedOp });
assert.equal(firstDevice.status, 201);
assert.equal(secondDevice.status, 403);
const privateDevice = safety.snapshot();
privateDevice.devices['device-b'] = { revoked: false, grants: ['content.read', 'ingest.write'], vaults: ['vault-1'] };
const isolated = createFixture(privateDevice);
const b = isolated.request({ path: '/v1/services/ingest/jobs', method: 'POST', deviceId: 'device-b', body: sharedOp });
assert.equal(b.status, 201);
assert.notEqual(b.body.jobId, firstDevice.body.jobId, 'job ownership must bind device');
assert.equal(invoke('/v1/services/presentation/open', { method: 'POST', deviceId: 'device-read',
  body: { opId: 'read-only-open', target: { domain: 'materials', assetId: 'asset-1' } } }).status, 403);
const visible = invoke('/v1/services/presentation/open', { method: 'POST',
  body: { opId: 'open-1', target: { domain: 'materials', assetId: 'asset-1' } } });
safety.setBusy(true);
assert.deepEqual(invoke('/v1/services/presentation/open', { method: 'POST',
  body: { opId: 'open-1', target: { domain: 'materials', assetId: 'asset-1' } } }), visible);
const noVault = safety.snapshot();
noVault.devices['device-read'].vaults = [];
const noVaultFixture = createFixture(noVault);
assert.equal(noVaultFixture.request({ deviceId: 'device-read', path: '/v1/services/knowledge/vaults' }).status, 403);
const scoped = safety.snapshot();
scoped.devices['device-a'].vaults = [];
const scopedFixture = createFixture(scoped);
assert.equal(scopedFixture.request({ path: `/v1/services/ingest/jobs/${firstDevice.body.jobId}` }).status, 403);
assert.equal(scopedFixture.request({ method: 'POST', path: `/v1/services/ingest/jobs/${firstDevice.body.jobId}/complete` }).status, 403);
const searchFixture = createFixture();
for (let index = 0; index < 6; index += 1) {
  assert.equal(searchFixture.request({ path: '/v1/services/search?q=NoSuchMaterial' }).status, 200);
  assert.equal(searchFixture.request({ path: '/v1/services/search?q=Travel' }).body.nextCursor, null);
}
assert.equal(Object.keys(searchFixture.snapshot().searchSnapshots).length, 0, 'complete answers need no lease');
const pageOne = searchFixture.request({ path: '/v1/services/search?q=Blue&limit=1' }).body;
assert.ok(pageOne.nextCursor);
assert.equal(searchFixture.request({ path: '/v1/services/search?q=Travel' }).status, 200,
  'new complete query must not evict an active cursor');
const separate = searchFixture.snapshot();
separate.devices['device-b'] = { revoked: false, grants: ['content.read'], vaults: ['vault-1'] };
const otherDevice = createFixture(separate);
assert.equal(otherDevice.request({ deviceId: 'device-b', path: `/v1/services/search?q=Blue&limit=1&cursor=${pageOne.nextCursor}` }).status, 410);
assert.equal(otherDevice.request({ deviceId: 'device-b', path: '/v1/services/search?q=Blue&limit=1' }).status, 200,
  'a second paired device owns a separate snapshot budget');
const cappedState = searchFixture.snapshot();
cappedState.assets = Array.from({ length: 5001 }, (_, index) => ({
  assetId: `wide-${index}`, name: `Wide ${index}`, description: null }));
const capped = createFixture(cappedState);
assert.equal(capped.request({ path: '/v1/services/search?q=Wide&domains=materials' }).status, 400,
  'over-5000 result set must fail rather than create a partial cursor');
const boundedState = searchFixture.snapshot();
boundedState.searchSnapshots = {};
boundedState.assets = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].flatMap(group =>
  Array.from({ length: 3 }, (_, index) => ({ assetId: `${group}-${index}`, name: `${group} ${index}`,
    description: null })));
const bounded = createFixture(boundedState);
const oldest = bounded.request({ path: '/v1/services/search?q=Alpha&limit=1&domains=materials' }).body.nextCursor;
assert.equal(bounded.request({ path: '/v1/services/search?q=Alpha&limit=1&domains=materials' }).body.nextCursor, oldest,
  'same-query retry must reuse the snapshot');
for (const group of ['Bravo', 'Charlie', 'Delta', 'Echo']) {
  assert.equal(bounded.request({ path: `/v1/services/search?q=${group}&limit=1&domains=materials` }).status, 200);
  assert.ok(Object.keys(bounded.snapshot().searchSnapshots).length <= 4, 'hard snapshot cap');
}
assert.equal(bounded.request({ path: `/v1/services/search?q=Alpha&limit=1&domains=materials&cursor=${oldest}` }).status, 410,
  'reclaimed cursor must report 410');
const globallyFullState = boundedState;
globallyFullState.searchSnapshots = Object.fromEntries(Array.from({ length: 32 }, (_, index) =>
  [`foreign-${index}`, { deviceId: `foreign-device-${index}`, q: 'Elsewhere', domains: ['materials'],
    permissionRevision: globallyFullState.permissionRevision, items: [{ title: 'Elsewhere' }] }]));
const globallyFull = createFixture(globallyFullState);
assert.equal(globallyFull.request({ path: '/v1/services/search?q=Alpha&limit=1&domains=materials' }).status, 429,
  'global capacity owned by other devices cannot be evicted');
assert.equal(Object.keys(globallyFull.snapshot().searchSnapshots).length, 32);
const oversizedState = createFixture().snapshot();
oversizedState.assets = Array.from({ length: 1100 }, (_, index) => ({
  assetId: `heavy-${index}`, name: `Heavy ${index}`, description: 'x'.repeat(4000) }));
assert.equal(createFixture(oversizedState).request({ path: '/v1/services/search?q=Heavy&limit=1&domains=materials' }).status, 429,
  'single oversized snapshot cannot bypass the per-device byte bound');
const completedSearch = createFixture();
for (let round = 0; round < 5; round += 1) {
  const start = completedSearch.request({ path: '/v1/services/search?q=Blue&limit=1' });
  assert.equal(start.status, 200);
  const finish = completedSearch.request({ path: `/v1/services/search?q=Blue&limit=1&cursor=${start.body.nextCursor}` });
  assert.equal(finish.status, 200);
  assert.equal(finish.body.nextCursor, null);
  assert.equal(completedSearch.request({ path: `/v1/services/search?q=Blue&limit=1&cursor=${start.body.nextCursor}` }).status, 410,
    'lost final-page response must retry as 410');
}
assert.equal(Object.keys(completedSearch.snapshot().searchSnapshots).length, 0);
searchFixture.request({ method: 'PATCH', path: '/v1/services/materials/assets/asset-1',
  body: { opId: 'rename-search', expectedRevision: 'asset-r1', name: 'No match' } });
assert.equal(searchFixture.request({ path: '/v1/services/search?q=Blue&limit=1' }).body.nextCursor,
  pageOne.nextCursor, 'same-query retry must reuse the snapshot after live catalog changes');
const pageTwo = searchFixture.request({ path: `/v1/services/search?q=Blue&limit=1&cursor=${pageOne.nextCursor}` }).body;
assert.ok(pageTwo.items.length === 1 && pageTwo.items[0].domain === 'knowledge', 'search cursor must preserve snapshot');
assert.equal(searchFixture.request({ path: `/v1/services/search?q=Blue&limit=1&cursor=${pageOne.nextCursor}` }).body.code, 'CURSOR_TOO_OLD');
const noAckState = safety.snapshot();
noAckState.presentationAck = false;
noAckState.busy = false;
const noAckFixture = createFixture(noAckState);
const noAckOpen = { opId: 'open-no-ack', target: { domain: 'materials', assetId: 'asset-1' } };
const started = noAckFixture.request({ method: 'POST', path: '/v1/services/presentation/open', body: noAckOpen });
assert.equal(started.body.state, 'handoffStarted');
assert.deepEqual(noAckFixture.request({ method: 'POST', path: '/v1/services/presentation/open', body: noAckOpen }), started,
  'missing ACK must not re-navigate on retry');
verifyKnowledge();
console.log(`services-v1: PASS ${golden.cases.length} golden, operations, replay/revision/upload/scope/revoke/restart; ${names.length} files`);
