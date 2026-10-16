/** Synthetic, deterministic Services V1 request/response harness. Never import in production. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createKnowledgeFixture } from './knowledge-fixture.mjs';

const inventory = JSON.parse(readFileSync(new URL('./operations.json', import.meta.url), 'utf8'));
const operations = inventory.operations;
const operationById = new Map(operations.map(op => [op.id, op]));
const LIMITS = Object.freeze({ pageSize: 100, batchItems: 100, noteBytes: 4194304,
  uploadBytes: 67108864, uploadChunkBytes: 262144, concurrentUploads: 2, searchResults: 50 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (key, entry) =>
  entry && !Array.isArray(entry) && typeof entry === 'object'
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const clone = value => structuredClone(value);
const ok = (body, status = 200) => ({ status, body: clone(body) });
const fail = (status, code) => ({ status, body: { code } });
const ident = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const validRelative = value => typeof value === 'string' && value.length <= 1024 &&
  !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') &&
  value.split('/').every(segment => segment !== '..' && segment !== '.');
const safeWebUrl = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 ||
    value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    const secretKey = key => key.toLowerCase().startsWith('x-amz-') ||
      ['access_token', 'api_key', 'apikey', 'auth', 'authorization', 'bearer',
        'cookie', 'secret', 'sig', 'signature', 'token'].includes(key.toLowerCase());
    let fragment = url.hash.slice(1);
    for (let index = 0; index < 2; index += 1) fragment = decodeURIComponent(fragment);
    return url.href.length <= 2048 && ['http:', 'https:'].includes(url.protocol) &&
      !url.username && !url.password &&
      !/\.(avif|gif|jpe?g|m3u8|mp4|mpd|png|webm|webp)$/i.test(url.pathname) &&
      ![...url.searchParams.keys()].some(secretKey) &&
      !fragment.split(/[?&;]/).some(part => secretKey(part.split('=')[0]));
  } catch { return false; }
};
const safeSource = source => source === undefined || (source && typeof source === 'object' &&
  ['web', 'import', 'clipboard', 'unknown'].includes(source.captureKind) &&
  (source.pageKind === undefined || ['work-page', 'capture-page'].includes(source.pageKind)) &&
  (source.pageKind !== 'work-page' || source.pageUrl !== undefined) &&
  (source.pageUrl === undefined || safeWebUrl(source.pageUrl)) &&
  (source.siteOrigin === undefined || (safeWebUrl(source.siteOrigin) && new URL(source.siteOrigin).origin === source.siteOrigin)));
const knownQuery = (url, names) => [...url.searchParams.keys()].every(key => names.includes(key)) &&
  names.every(key => url.searchParams.getAll(key).length <= 1);
const cursorTag = (state, deviceId, domain, scope) => sha(`${state.desktopInstanceId}|${deviceId}|${domain}|${scope}|${state.permissionRevision}`).slice(0, 16);
const cursorOffset = (value, prefix, tag) => {
  if (value === `${prefix}:0`) return 0;
  const match = new RegExp(`^${prefix}:([a-f0-9]{16}):(\\d+)$`).exec(value);
  if (!match) return null;
  return match[1] === tag ? Number(match[2]) : -1;
};

const seed = () => ({
  desktopInstanceId: 'fixture-desktop-1', gatewayGeneration: 7, permissionRevision: 1,
  devices: {
    'device-a': { revoked: false, grants: ['content.read', 'content.write', 'ingest.write', 'desktop.open'], vaults: ['vault-1'] },
    'device-read': { revoked: false, grants: ['content.read'], vaults: ['vault-1'] },
    'device-revoked': { revoked: true, grants: ['content.read'], vaults: ['vault-1'] }
  },
  currentVaultId: 'vault-1', busy: false, presentationAck: true, materialFloor: 0, noteFloor: 0,
  assets: [{ assetId: 'asset-1', name: 'Blue train', kind: 'image', mimeType: 'image/jpeg', sizeBytes: 2048,
    revision: 'asset-r1', description: null, source: { captureKind: 'web', pageKind: 'work-page', pageUrl: 'https://www.pinterest.com/pin/700591285831031728/', siteOrigin: 'https://www.pinterest.com' } }],
  notes: [{ vaultId: 'vault-1', noteId: 'note-1', title: 'Travel', content: 'Blue train', revision: 'note-r1', parentRelativePath: 'Trips' }],
  materialChanges: [{ cursor: 'm:1', assetId: 'asset-1', revision: 'asset-r1', kind: 'created', tombstone: false }],
  noteChanges: [{ cursor: 'k:1', vaultId: 'vault-1', noteId: 'note-1', revision: 'note-r1', deleted: false }],
  jobs: {}, receipts: {}, searchSnapshots: {}, hints: [{ kind: 'materialChanged', cursor: 'm:1' }],
  assetCounter: 1, noteCounter: 1, searchCounter: 0
});

export function createFixture(snapshot) {
  const state = snapshot ? clone(snapshot) : seed();
  const device = id => state.devices[id];
  const op = id => operationById.get(id);
  const auth = (id, operationId, vaultId) => {
    const d = device(id);
    if (!d) return fail(401, 'PAIRING_REQUIRED');
    if (d.revoked) return fail(401, 'AUTH_REVOKED');
    const map = op(operationId);
    if (!map) return fail(404, 'ENTITY_NOT_FOUND');
    if (map.atFreeze === 'unsupported') return fail(503, 'SERVICE_UNAVAILABLE');
    if (map.grant && !d.grants.includes(map.grant)) return fail(403, 'GRANT_REQUIRED');
    if (vaultId && !d.vaults.includes(vaultId)) return fail(403, 'SCOPE_DENIED');
    return null;
  };
  const replay = (deviceId, operationId, opId, payload, create) => {
    if (!ident(opId)) return fail(400, 'INPUT_INVALID');
    const key = `${state.desktopInstanceId}|${deviceId}|${operationId}|${opId}`;
    const digest = sha(canonical(payload));
    const prior = state.receipts[key];
    if (prior) return prior.digest === digest ? ok(prior.receipt) : fail(409, 'OP_ID_REUSED');
    const response = create();
    if (response.status >= 200 && response.status < 300) state.receipts[key] = { digest, receipt: clone(response.body) };
    return response;
  };
  const priorReplay = (deviceId, operationId, opId, payload) => {
    if (!ident(opId)) return fail(400, 'INPUT_INVALID');
    const key = `${state.desktopInstanceId}|${deviceId}|${operationId}|${opId}`;
    const prior = state.receipts[key];
    if (!prior) return null;
    return prior.digest === sha(canonical(payload)) ? ok(prior.receipt) : fail(409, 'OP_ID_REUSED');
  };
  const addMaterialChange = (assetId, revision, kind, tombstone = false) => {
    const cursor = `m:${state.materialChanges.length + 1}`;
    state.materialChanges.push({ cursor, assetId, revision, kind, tombstone });
    state.hints.push({ kind: 'materialChanged', cursor });
  };
  const addNoteChange = (vaultId, noteId, revision, deleted = false) => {
    const cursor = `k:${state.noteChanges.length + 1}`;
    state.noteChanges.push({ cursor, vaultId, noteId, revision, deleted });
    state.hints.push({ kind: 'knowledgeChanged', vaultId, cursor });
  };
  const catalog = deviceId => {
    const d = device(deviceId);
    const statuses = Object.fromEntries(operations.map(map => {
      let stateValue = map.atFreeze === 'unsupported' ? 'unsupported' : 'implemented';
      if (map.id === 'lsh.session') stateValue = 'temporarilyUnavailable';
      if (stateValue === 'implemented' && map.grant && !d.grants.includes(map.grant)) stateValue = 'notGranted';
      if (map.scope?.includes('Vault') && d.vaults.length === 0) stateValue = 'notGranted';
      if (map.id === 'knowledge.materialReferences' && d.catalogRead === false) stateValue = 'notGranted';
      return [map.id, { state: stateValue, capability: map.capability, grant: map.grant, scope: map.scope }];
    }));
    const summaries = Object.fromEntries(['materials', 'knowledge', 'ingest', 'search', 'changes', 'presentation', 'lsh']
      .map(domain => [domain, { version: 1, available: true, granted: operations.some(map => map.domain === domain && statuses[map.id].state === 'implemented') }]));
    return { catalogVersion: 1, bundleRevision: inventory.bundleRevision, desktopInstanceId: state.desktopInstanceId,
      gatewayGeneration: state.gatewayGeneration, permissionRevision: state.permissionRevision,
      services: summaries, operations: statuses, limits: LIMITS };
  };
  const ownedJob = (jobId, deviceId) => {
    const job = state.jobs[jobId];
    return job && job.deviceId === deviceId && job.instanceId === state.desktopInstanceId ? job : null;
  };
  const knowledge = createKnowledgeFixture({ state, auth, replay, addNoteChange, cursorTag });

  function request({ deviceId = 'device-a', method = 'GET', path, body = null, headers = {} }) {
    if (typeof path !== 'string' || !path.startsWith('/v1/')) return fail(404, 'ENTITY_NOT_FOUND');
    let url;
    try { url = new URL(path, 'https://fixture.invalid'); } catch { return fail(400, 'INPUT_INVALID'); }
    if ([...url.searchParams.keys()].some(key => /token|secret|credential|key/i.test(key))) return fail(400, 'INPUT_INVALID');
    const route = url.pathname;
    const baseAuth = auth(deviceId, 'services.discover');
    if (baseAuth) return baseAuth;
    const knowledgeResult = knowledge.request({ deviceId, method, url, body });
    if (knowledgeResult) return knowledgeResult;

    if (method === 'GET' && route === '/v1/services') {
      if (!knownQuery(url, [])) return fail(400, 'INPUT_INVALID');
      return ok(catalog(deviceId));
    }
    if (method === 'GET' && route === '/v1/services/materials/changes') {
      const denied = auth(deviceId, 'materials.changes'); if (denied) return denied;
      if (!knownQuery(url, ['after', 'limit'])) return fail(400, 'INPUT_INVALID');
      const after = url.searchParams.get('after') ?? 'm:0';
      const tag = cursorTag(state, deviceId, 'materials', 'catalog');
      const offset = cursorOffset(after, 'm', tag);
      if (offset === null) return fail(400, 'INPUT_INVALID');
      if (offset < state.materialFloor) return fail(410, 'CURSOR_TOO_OLD');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) return fail(400, 'INPUT_INVALID');
      const items = state.materialChanges.slice(offset, offset + limit)
        .map((item, index) => ({ ...item, cursor: `m:${tag}:${offset + index + 1}` }));
      const next = offset + items.length;
      return ok({ items, snapshotCursor: `m:${tag}:${state.materialChanges.length}`, nextCursor: `m:${tag}:${next}`, hasMore: next < state.materialChanges.length });
    }
    if (route.startsWith('/v1/services/materials/assets/')) {
      const assetId = route.slice('/v1/services/materials/assets/'.length);
      if (!ident(assetId) || !knownQuery(url, [])) return fail(400, 'INPUT_INVALID');
      if (!['GET', 'PATCH', 'DELETE'].includes(method)) return fail(405, 'METHOD_NOT_ALLOWED');
      const operationId = method === 'GET' ? 'materials.detailV1' : method === 'PATCH' ? 'materials.metadataPatch' : 'materials.removeRecord';
      const denied = auth(deviceId, operationId); if (denied) return denied;
      if (method !== 'GET') {
        const prior = priorReplay(deviceId, operationId, body?.opId, { assetId, body });
        if (prior) return prior;
      }
      const asset = state.assets.find(item => item.assetId === assetId);
      if (!asset) return fail(404, 'ENTITY_NOT_FOUND');
      if (method === 'GET') return ok(asset);
      if (!body || !ident(body.opId) || body.expectedRevision !== asset.revision) return fail(409, 'REVISION_CONFLICT');
      if (method === 'PATCH') {
        if (!('name' in body) && !('description' in body)) return fail(400, 'INPUT_INVALID');
        if (Object.keys(body).some(key => !['opId', 'expectedRevision', 'name', 'description'].includes(key))) return fail(400, 'INPUT_INVALID');
        if (('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255)) ||
          ('description' in body && body.description !== null && (typeof body.description !== 'string' || body.description.length > 4096))) return fail(400, 'INPUT_INVALID');
        return replay(deviceId, operationId, body.opId, { assetId, body }, () => {
          if ('name' in body) asset.name = body.name;
          if ('description' in body) asset.description = body.description;
          asset.revision = `asset-r${state.materialChanges.length + 1}`;
          addMaterialChange(assetId, asset.revision, 'updated');
          return ok({ opId: body.opId, assetId, revision: asset.revision, disposition: 'updated' });
        });
      }
      if (body.mode !== 'removeRecord' || Object.keys(body).some(key => !['opId', 'expectedRevision', 'mode'].includes(key))) return fail(400, 'INPUT_INVALID');
      return replay(deviceId, operationId, body.opId, { assetId, body }, () => {
        state.assets = state.assets.filter(item => item.assetId !== assetId);
        addMaterialChange(assetId, asset.revision, 'removed', true);
        return ok({ opId: body.opId, assetId, revision: asset.revision, disposition: 'removed' });
      });
    }
    if (method === 'GET' && route === '/v1/services/knowledge/vaults') {
      const denied = auth(deviceId, 'knowledge.vaults'); if (denied) return denied;
      if (!knownQuery(url, [])) return fail(400, 'INPUT_INVALID');
      if (device(deviceId).vaults.length === 0) return fail(403, 'SCOPE_DENIED');
      return ok({ items: device(deviceId).vaults.includes('vault-1') ? [{ vaultId: 'vault-1', displayName: 'Fixture vault', activeInDesktop: true,
        readGranted: device(deviceId).vaults.includes('vault-1'),
        writeGranted: device(deviceId).vaults.includes('vault-1') && device(deviceId).grants.includes('content.write'), revision: 'vault-r1' }] : [] });
    }
    if (method === 'GET' && /^\/v1\/services\/knowledge\/vaults\/[^/]+\/notes$/.test(route)) {
      const vaultId = route.split('/')[5]; const denied = auth(deviceId, 'knowledge.registeredList', vaultId); if (denied) return denied;
      if (vaultId !== state.currentVaultId) return fail(503, 'SERVICE_UNAVAILABLE');
      if (!knownQuery(url, ['limit', 'afterId', 'q'])) return fail(400, 'INPUT_INVALID');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) return fail(400, 'INPUT_INVALID');
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const after = url.searchParams.get('afterId') ?? '';
      const matches = state.notes.filter(note => note.vaultId === vaultId && note.noteId > after && (!q || `${note.title} ${note.content}`.toLowerCase().includes(q)));
      return ok({ items: matches.slice(0, limit).map(({ vaultId, noteId, title, revision, parentRelativePath }) =>
        ({ vaultId, noteId, title, revision, parentRelativePath })), hasMore: matches.length > limit,
        nextAfterId: matches.length > limit ? matches[limit - 1].noteId : null });
    }
    if (method === 'GET' && /^\/v1\/services\/knowledge\/vaults\/[^/]+\/changes$/.test(route)) {
      const vaultId = route.split('/')[5];
      const denied = auth(deviceId, 'knowledge.registeredChanges', vaultId); if (denied) return denied;
      if (!knownQuery(url, ['after', 'limit'])) return fail(400, 'INPUT_INVALID');
      const tag = cursorTag(state, deviceId, 'knowledge', vaultId);
      const offset = cursorOffset(url.searchParams.get('after') ?? 'k:0', 'k', tag);
      if (offset === null) return fail(400, 'INPUT_INVALID');
      if (offset < state.noteFloor) return fail(410, 'CURSOR_TOO_OLD');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) return fail(400, 'INPUT_INVALID');
      const all = state.noteChanges.filter(item => item.vaultId === vaultId);
      const items = all.slice(offset, offset + limit).map((item, index) =>
        ({ ...item, cursor: `k:${tag}:${offset + index + 1}` }));
      const next = offset + items.length;
      return ok({ items, snapshotCursor: `k:${tag}:${all.length}`, nextCursor: `k:${tag}:${next}`, hasMore: next < all.length });
    }
    if (method === 'PATCH' && /^\/v1\/services\/knowledge\/notes\/[^/]+\/move$/.test(route)) {
      const noteId = route.split('/')[5]; const vaultId = body?.vaultId;
      const denied = auth(deviceId, 'knowledge.move', vaultId); if (denied) return denied;
      if (!ident(noteId) || !validRelative(body?.parentRelativePath) || !ident(body?.opId)) return fail(400, 'INPUT_INVALID');
      const prior = priorReplay(deviceId, 'knowledge.move', body.opId, { noteId, body });
      if (prior) return prior;
      const note = state.notes.find(item => item.noteId === noteId && item.vaultId === vaultId);
      if (!note) return fail(404, 'ENTITY_NOT_FOUND');
      if (note.revision !== body.expectedRevision) return fail(409, 'REVISION_CONFLICT');
      if (state.busy) return fail(503, 'DESKTOP_DRAFT_BUSY');
      return replay(deviceId, 'knowledge.move', body.opId, { noteId, body }, () => {
        note.parentRelativePath = body.parentRelativePath;
        note.revision = `note-r${state.noteChanges.length + 1}`;
        addNoteChange(vaultId, noteId, note.revision);
        return ok({ opId: body.opId, vaultId, noteId, revision: note.revision, parentRelativePath: note.parentRelativePath });
      });
    }
    if (method === 'GET' && route === '/v1/services/search') {
      const denied = auth(deviceId, 'search.unified'); if (denied) return denied;
      if (!knownQuery(url, ['q', 'domains', 'limit', 'cursor'])) return fail(400, 'INPUT_INVALID');
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (!q || q.length > 200) return fail(400, 'INPUT_INVALID');
      const domains = (url.searchParams.get('domains') ?? 'materials,knowledge').split(',');
      if (domains.some(d => !['materials', 'knowledge'].includes(d))) return fail(400, 'INPUT_INVALID');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.searchResults) return fail(400, 'INPUT_INVALID');
      const cursor = url.searchParams.get('cursor');
      if (cursor && !/^s:[a-f0-9]{24}:\d+$/.test(cursor)) return fail(400, 'INPUT_INVALID');
      if (!cursor) {
        const existing = Object.entries(state.searchSnapshots).find(([, snapshot]) =>
          snapshot.deviceId === deviceId && snapshot.q === q &&
          canonical(snapshot.domains) === canonical(domains) &&
          snapshot.permissionRevision === state.permissionRevision);
        if (existing) {
          const [oldKey, snapshot] = existing;
          const nextCursor = limit < snapshot.items.length ? `s:${oldKey}:${limit}` : null;
          if (nextCursor === null) delete state.searchSnapshots[oldKey];
          return ok({ items: snapshot.items.slice(0, limit), nextCursor });
        }
      }
      const all = [
        ...state.assets.filter(a => domains.includes('materials') && `${a.name} ${a.description ?? ''}`.toLowerCase().includes(q))
          .map(a => ({ domain: 'materials', assetId: a.assetId, title: a.name,
            ...(a.description ? { subtitle: a.description } : {}) })),
        ...state.notes.filter(n => domains.includes('knowledge') && device(deviceId).vaults.includes(n.vaultId) && `${n.title} ${n.content}`.toLowerCase().includes(q))
          .map(n => ({ domain: 'knowledge', vaultId: n.vaultId, noteId: n.noteId, title: n.title, path: n.parentRelativePath }))
      ];
      let [key, position] = cursor ? cursor.slice(2).split(':') : [null, '0'];
      if (!cursor && all.length > 5000) return fail(400, 'INPUT_INVALID');
      if (!cursor && all.length <= limit) return ok({ items: all, nextCursor: null });
      if (!cursor) {
        key = sha(canonical({ desktop: state.desktopInstanceId, deviceId, q, domains,
          permissionRevision: state.permissionRevision, sequence: ++state.searchCounter })).slice(0, 24);
        const encoded = Buffer.byteLength(JSON.stringify(all), 'utf8');
        if (encoded > 4 * 1024 * 1024) return fail(429, 'RATE_LIMITED');
        while (true) {
          const own = Object.entries(state.searchSnapshots).filter(([, snapshot]) => snapshot.deviceId === deviceId);
          const ownBytes = own.reduce((sum, [, snapshot]) => sum + Buffer.byteLength(JSON.stringify(snapshot.items), 'utf8'), 0);
          const global = Object.values(state.searchSnapshots);
          const globalBytes = global.reduce((sum, snapshot) => sum + Buffer.byteLength(JSON.stringify(snapshot.items), 'utf8'), 0);
          if (own.length < 4 && global.length < 32 && ownBytes + encoded <= 4 * 1024 * 1024 &&
            globalBytes + encoded <= 32 * 1024 * 1024) break;
          if (!own.length) return fail(429, 'RATE_LIMITED');
          delete state.searchSnapshots[own[0][0]];
        }
        state.searchSnapshots[key] = { deviceId, q, domains, permissionRevision: state.permissionRevision, items: clone(all) };
      }
      const snapshot = state.searchSnapshots[key];
      if (!snapshot || snapshot.deviceId !== deviceId || snapshot.q !== q ||
        canonical(snapshot.domains) !== canonical(domains) || snapshot.permissionRevision !== state.permissionRevision) return fail(410, 'CURSOR_TOO_OLD');
      const offset = Number(position);
      const items = snapshot.items;
      const nextCursor = offset + limit < items.length ? `s:${key}:${offset + limit}` : null;
      if (nextCursor === null) delete state.searchSnapshots[key];
      return ok({ items: items.slice(offset, offset + limit), nextCursor });
    }
    if (method === 'POST' && route === '/v1/services/presentation/open') {
      const denied = auth(deviceId, 'presentation.open', body?.target?.vaultId); if (denied) return denied;
      if (!ident(body?.opId) || !['materials', 'knowledge'].includes(body?.target?.domain)) return fail(400, 'INPUT_INVALID');
      const readDenied = auth(deviceId, body.target.domain === 'materials' ? 'materials.detailV1' : 'knowledge.registeredList', body.target.vaultId);
      if (readDenied) return readDenied;
      const prior = priorReplay(deviceId, 'presentation.open', body.opId, body);
      if (prior) return prior;
      if (state.busy) return fail(503, 'DESKTOP_DRAFT_BUSY');
      const target = body.target;
      const exists = target.domain === 'materials' ? state.assets.some(a => a.assetId === target.assetId) :
        state.notes.some(n => n.vaultId === target.vaultId && n.noteId === target.noteId);
      if (!exists) return fail(404, 'ENTITY_NOT_FOUND');
      return replay(deviceId, 'presentation.open', body.opId, body, () => ok({ opId: body.opId,
        state: state.presentationAck ? 'accepted' : 'handoffStarted' }));
    }
    if (method === 'GET' && route === '/v1/lsh/remote/state') {
      return ok({ granted: device(deviceId).grants.includes('lsh.remote'), runtimeAvailable: false });
    }
    if (method === 'POST' && route === '/v1/lsh/remote/session') {
      const denied = auth(deviceId, 'lsh.session'); if (denied) return denied;
      return fail(503, 'SERVICE_UNAVAILABLE');
    }
    if (route === '/v1/services/events/stream') return fail(426, 'VERSION_UNSUPPORTED');
    if (method === 'POST' && route === '/v1/services/ingest/jobs') {
      const denied = auth(deviceId, 'ingest.begin', body?.target?.vaultId); if (denied) return denied;
      if (!body || !ident(body.opId) || !['materials', 'knowledge'].includes(body.target?.domain) ||
        !['text', 'url', 'image', 'video', 'file', 'clipboard'].includes(body.kind) ||
        !Number.isInteger(body.sizeBytes) || body.sizeBytes < 1 || body.sizeBytes > LIMITS.uploadBytes ||
        !/^[a-f0-9]{64}$/.test(body.sha256 ?? '') || !body.name || !safeSource(body.source)) return fail(400, 'INPUT_INVALID');
      const inline = ['text', 'url', 'clipboard'].includes(body.kind);
      if (inline && (typeof body.text !== 'string' || !body.text ||
        (body.kind === 'url' && !safeWebUrl(body.text)) ||
        body.sizeBytes !== Buffer.byteLength(body.text, 'utf8') ||
        body.sha256 !== sha(Buffer.from(body.text, 'utf8')))) return fail(400, 'INPUT_INVALID');
      if (!inline && body.text !== undefined) return fail(400, 'INPUT_INVALID');
      if (body.target.domain === 'knowledge' && (body.target.vaultId !== state.currentVaultId || !validRelative(body.target.parentRelativePath))) return fail(503, 'SERVICE_UNAVAILABLE');
      const jobId = `job-${sha(`${state.desktopInstanceId}|${deviceId}|${body.opId}`).slice(0, 32)}`;
      const prior = ownedJob(jobId, deviceId);
      if (prior) return prior.manifestDigest === sha(canonical(body)) ? ok(publicJob(prior)) : fail(409, 'OP_ID_REUSED');
      if (Object.values(state.jobs).filter(j => j.deviceId === deviceId && j.state === 'staging').length >= LIMITS.concurrentUploads) return fail(429, 'RATE_LIMITED');
      const textBytes = body.text === undefined ? Buffer.alloc(0) : Buffer.from(body.text, 'utf8');
      if (textBytes.length > body.sizeBytes) return fail(400, 'INPUT_INVALID');
      const job = { jobId, opId: body.opId, deviceId, instanceId: state.desktopInstanceId,
        manifest: clone(body), manifestDigest: sha(canonical(body)), state: 'staging', bytes: textBytes.toString('base64'), committedBytes: textBytes.length };
      state.jobs[jobId] = job; state.hints.push({ kind: 'ingestChanged', jobId });
      return ok(publicJob(job), 201);
    }
    const jobMatch = /^\/v1\/services\/ingest\/jobs\/([^/]+)(?:\/(chunks|complete|cancel))?$/.exec(route);
    if (jobMatch) {
      const [, jobId, action] = jobMatch;
      const operationId = !action ? 'ingest.status' : `ingest.${action === 'chunks' ? 'chunk' : action}`;
      const job = ownedJob(jobId, deviceId); if (!job) return fail(404, 'JOB_NOT_OWNED');
      const denied = auth(deviceId, operationId, job.manifest.target.vaultId); if (denied) return denied;
      if (!action && method === 'GET') return ok(publicJob(job));
      if (action === 'cancel' && method === 'POST') {
        if (job.state === 'completed') return fail(409, 'OP_ID_REUSED');
        job.state = 'cancelled'; job.bytes = ''; job.committedBytes = 0;
        state.hints.push({ kind: 'ingestChanged', jobId });
        return ok(publicJob(job));
      }
      if (action === 'complete' && method === 'POST' && job.state === 'completed') return ok(publicJob(job));
      if (job.state !== 'staging') return fail(409, 'OP_ID_REUSED');
      if (action === 'chunks' && method === 'PUT') {
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? []);
        const offset = Number(headers['x-chunk-offset']);
        if (!Number.isInteger(offset) || offset < 0 || offset > job.committedBytes) return fail(409, 'UPLOAD_OFFSET_MISMATCH');
        if (bytes.length < 1 || bytes.length > LIMITS.uploadChunkBytes || offset + bytes.length > job.manifest.sizeBytes) return fail(413, 'PAYLOAD_TOO_LARGE');
        if (headers['x-chunk-sha256'] !== sha(bytes)) return fail(409, 'UPLOAD_HASH_MISMATCH');
        const stored = Buffer.from(job.bytes, 'base64');
        if (offset < job.committedBytes) {
          return stored.subarray(offset, offset + bytes.length).equals(bytes) ? ok(publicJob(job)) : fail(409, 'UPLOAD_OFFSET_MISMATCH');
        }
        job.bytes = Buffer.concat([stored, bytes]).toString('base64'); job.committedBytes += bytes.length;
        return ok(publicJob(job));
      }
      if (action === 'complete' && method === 'POST') {
        const bytes = Buffer.from(job.bytes, 'base64');
        if (bytes.length !== job.manifest.sizeBytes) return fail(409, 'UPLOAD_INCOMPLETE');
        if (sha(bytes) !== job.manifest.sha256) return fail(409, 'UPLOAD_HASH_MISMATCH');
        const target = job.manifest.target;
        if (target.domain === 'materials') {
          const assetId = `asset-${++state.assetCounter}`;
          const asset = { assetId, name: job.manifest.name, kind: job.manifest.kind,
            mimeType: job.manifest.mimeType, sizeBytes: bytes.length, revision: `asset-r${state.materialChanges.length + 1}`,
            description: null, ...(job.manifest.source ? { source: {
              ...clone(job.manifest.source),
              pageKind: job.manifest.source.pageKind ?? 'capture-page',
              ...(job.manifest.source.pageUrl ? { siteOrigin: new URL(job.manifest.source.pageUrl).origin } :
                job.manifest.source.siteOrigin ? { pageUrl: new URL(job.manifest.source.siteOrigin).href } : {})
            } } : {}) };
          state.assets.push(asset); addMaterialChange(assetId, asset.revision, 'created');
          job.receipt = { domain: 'materials', assetId, revision: asset.revision };
        } else {
          const noteId = `note-${++state.noteCounter}`;
          const note = { vaultId: target.vaultId, noteId, title: job.manifest.name,
            content: bytes.toString('utf8'), revision: `note-r${state.noteChanges.length + 1}`, parentRelativePath: target.parentRelativePath };
          state.notes.push(note); addNoteChange(target.vaultId, noteId, note.revision);
          job.receipt = { domain: 'knowledge', vaultId: target.vaultId, noteId, revision: note.revision };
        }
        job.state = 'completed'; job.bytes = ''; state.hints.push({ kind: 'ingestChanged', jobId });
        return ok(publicJob(job));
      }
      return fail(405, 'METHOD_NOT_ALLOWED');
    }
    return fail(404, 'ENTITY_NOT_FOUND');
  }
  const publicJob = job => ({ jobId: job.jobId, opId: job.opId, state: job.state,
    committedBytes: job.committedBytes, ...(job.receipt ? { receipt: clone(job.receipt) } : {}) });
  return {
    request,
    snapshot: () => clone(state),
    reconnect: () => { state.gatewayGeneration += 1; return state.gatewayGeneration; },
    revoke: deviceId => { if (state.devices[deviceId]) { state.devices[deviceId].revoked = true; state.permissionRevision += 1; state.hints.push({ kind: 'servicesChanged', permissionRevision: state.permissionRevision }); } },
    grant: (deviceId, grantClass, enabled) => { const grants = new Set(state.devices[deviceId].grants); enabled ? grants.add(grantClass) : grants.delete(grantClass); state.devices[deviceId].grants = [...grants]; state.permissionRevision += 1; state.hints.push({ kind: 'servicesChanged', permissionRevision: state.permissionRevision }); },
    setBusy: value => { state.busy = !!value; },
    expireSearch: () => { state.searchSnapshots = {}; },
    advanceEditing: milliseconds => knowledge.advance(milliseconds),
    setCursorFloor: (domain, floor) => { if (domain === 'materials') state.materialFloor = floor; else state.noteFloor = floor; },
    hints: (deviceId = 'device-a') => state.hints.map(hint => {
      if (hint.kind === 'materialChanged') return { ...hint,
        cursor: `m:${cursorTag(state, deviceId, 'materials', 'catalog')}:${hint.cursor.split(':')[1]}` };
      if (hint.kind === 'knowledgeChanged') return { ...hint,
        cursor: `k:${cursorTag(state, deviceId, 'knowledge', hint.vaultId)}:${hint.cursor.split(':')[1]}` };
      return clone(hint);
    })
  };
}
