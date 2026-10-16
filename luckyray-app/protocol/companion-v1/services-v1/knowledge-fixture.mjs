/** Synthetic contract vectors only. Production uses the existing Knowledge/Catalog authorities. */
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const ok = body => ({ status: 200, body: structuredClone(body) });
const fail = (status, code) => ({ status, body: { code } });
const ident = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const relative = value => typeof value === 'string' && Buffer.byteLength(value) <= 1024 &&
  !value.startsWith('/') && !/[\\:\u0000-\u001f\u007f]/.test(value) &&
  value.split('/').every(part => part !== '.' && part !== '..');
let incarnation = 0;

export function createKnowledgeFixture({ state, auth, replay, addNoteChange, cursorTag }) {
  const leases = new Map(); // Deliberately not included in durable fixture snapshots.
  const instance = ++incarnation;
  let clock = 0, counter = 0;
  const purge = () => { for (const [key, lease] of leases) if (lease.until <= clock) leases.delete(key); };
  const notes = vault => state.notes.filter(note => note.vaultId === vault && !note.deleted);
  const catalogRead = device => state.devices[device].catalogRead !== false && state.devices[device].grants.includes('content.read');
  const query = (url, allowed) => [...url.searchParams.keys()].every(key => allowed.includes(key)) &&
    allowed.every(key => url.searchParams.getAll(key).length <= 1);
  const limit = url => {
    const raw = url.searchParams.get('limit');
    const value = raw === null ? 100 : /^\d+$/.test(raw) ? Number(raw) : 0;
    return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : null;
  };
  const bindings = vault => (state.noteBindings ?? []).filter(binding => binding.vaultId === vault &&
    relative(binding.target) && binding.target && notes(vault).some(note => note.noteId === binding.noteId &&
      (note.content.includes(`![[${binding.target}]]`) || note.content.includes(`](${binding.target})`))));
  const paginate = (deviceId, url, vault, scope, version, items) => {
    const count = limit(url);
    if (count === null) return fail(400, 'INPUT_INVALID');
    const tag = sha(`${cursorTag(state, deviceId, scope, vault)}:${version}:${JSON.stringify(items)}`);
    const after = url.searchParams.get('after') ?? '';
    let offset = 0;
    if (after) {
      const match = /^([a-f0-9]{64}):(\d+)$/.exec(after);
      if (!match) return fail(400, 'INPUT_INVALID');
      if (match[1] !== tag) return fail(410, 'CURSOR_TOO_OLD');
      offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset > items.length) return fail(400, 'INPUT_INVALID');
    }
    const hasMore = items.length - offset > count;
    return { items: items.slice(offset, offset + count), nextAfter: hasMore ? `${tag}:${offset + count}` : null, hasMore };
  };
  const relations = (deviceId, vault, note) => {
    const items = [];
    for (const source of notes(vault)) for (const [index, line] of source.content.split('\n').entries()) {
      for (const match of line.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)) {
        const target = match[1].split('|')[0];
        if (!relative(target) || !target) continue;
        const found = notes(vault).filter(candidate => candidate.title === target ||
          `${candidate.parentRelativePath ? `${candidate.parentRelativePath}/` : ''}${candidate.title}.md` === target);
        const link = { target, line: index + 1, status: found.length > 1 ? 'ambiguous' : found.length ? 'resolved' : 'unresolved', noteIds: found.map(candidate => candidate.noteId) };
        if (source.noteId === note.noteId) items.push({ kind: 'wikiLink', ...link });
        if (found.some(candidate => candidate.noteId === note.noteId)) items.push({ kind: 'backlink', sourceNoteId: source.noteId, ...link });
      }
    }
    if (catalogRead(deviceId)) for (const binding of bindings(vault)) if (binding.noteId === note.noteId)
      items.push({ kind: 'material', assetId: binding.assetId, target: binding.target });
    return items;
  };

  function request({ deviceId, method, url, body }) {
    const path = url.pathname;
    const create = path === '/v1/services/knowledge/notes';
    const directories = /^\/v1\/services\/knowledge\/vaults\/([^/]+)\/directories$/.exec(path);
    const references = /^\/v1\/services\/knowledge\/materials\/([^/]+)\/references$/.exec(path);
    const action = /^\/v1\/services\/knowledge\/notes\/([^/]+)\/(editing|relations)$/.exec(path);
    if (!create && !directories && !references && !action) return null;
    const editing = action?.[2] === 'editing';
    if ((create && method !== 'POST') || (!create && !editing && method !== 'GET') ||
      (editing && !['GET', 'POST', 'PUT'].includes(method))) return fail(405, 'METHOD_NOT_ALLOWED');
    const operation = create ? 'createUnique' : directories ? 'directories' : references ? 'materialReferences' :
      editing ? method === 'POST' ? 'editingOpen' : method === 'PUT' ? 'editingSet' : 'editing' : 'relations';
    const allowed = create || (editing && method !== 'GET') ? [] : directories ? ['limit', 'afterPath'] : editing ? ['vault'] : ['vault', 'limit', 'after'];
    if (!query(url, allowed)) return fail(400, 'INPUT_INVALID');
    const vault = create || (editing && method !== 'GET') ? body?.vaultId : directories ? directories[1] : url.searchParams.get('vault');
    if (!ident(vault)) return fail(400, 'INPUT_INVALID');
    const denial = auth(deviceId, `knowledge.${operation}`, vault);
    if (denial) return denial;
    if (references && !catalogRead(deviceId)) return fail(403, 'GRANT_REQUIRED');
    if (vault !== state.currentVaultId) return fail(503, 'SERVICE_UNAVAILABLE');
    if (create) {
      if (!object(body) || Object.keys(body).some(key => !['opId', 'noteId', 'vaultId', 'kind', 'expectedRevision', 'title', 'content', 'parentRelativePath'].includes(key)) ||
        body.kind !== 'create' || !ident(body.opId) || (body.noteId !== undefined && !ident(body.noteId)) ||
        ![undefined, null, ''].includes(body.expectedRevision) || typeof body.title !== 'string' || !body.title.trim() ||
        !relative(body.title) || body.title.includes('/') || !relative(body.parentRelativePath ?? '') ||
        (body.content != null && typeof body.content !== 'string')) return fail(400, 'INPUT_INVALID');
      if (Buffer.byteLength(body.content ?? '') > 4194304) return fail(413, 'NOTE_TOO_LARGE');
      return replay(deviceId, 'knowledge.createUnique', body.opId, body, () => {
        if (state.busy) return fail(503, 'DESKTOP_DRAFT_BUSY');
        const noteId = body.noteId ?? `note-${++state.noteCounter}`;
        if (state.notes.some(note => note.vaultId === vault && note.noteId === noteId)) return fail(409, 'REVISION_CONFLICT');
        const parent = body.parentRelativePath ?? '';
        let title = body.title.trim(), suffix = 0;
        while (notes(vault).some(note => note.title === title && note.parentRelativePath === parent)) {
          suffix += 1; title = `${body.title.trim()}（副本${suffix > 1 ? ` ${suffix}` : ''}）`;
          if (suffix > 1000) return fail(503, 'SERVICE_UNAVAILABLE');
        }
        const note = { vaultId: vault, noteId, title, content: body.content ?? '', parentRelativePath: parent, revision: `note-r${state.noteChanges.length + 1}` };
        state.notes.push(note); addNoteChange(vault, noteId, note.revision);
        const { parentRelativePath, ...document } = note;
        return ok({ opId: body.opId, document: { ...document, relativePath: `${parent ? `${parent}/` : ''}${title}.md`, resources: [] } });
      });
    }
    if (directories) {
      const count = limit(url), after = url.searchParams.get('afterPath');
      if (count === null || (after !== null && !relative(after))) return fail(400, 'INPUT_INVALID');
      const all = [...new Set(['', ...(state.directories ?? []), ...notes(vault).map(note => note.parentRelativePath)])]
        .filter(path => relative(path) && (after === null || path > after)).sort();
      const items = all.slice(0, count).map(parentRelativePath => ({ parentRelativePath }));
      const hasMore = all.length > count;
      return ok({ vaultId: vault, items, nextAfterPath: hasMore ? items.at(-1).parentRelativePath : null, hasMore });
    }
    if (references) {
      const assetId = references[1];
      if (!ident(assetId)) return fail(400, 'INPUT_INVALID');
      if (!state.assets.some(asset => asset.assetId === assetId)) return fail(404, 'ENTITY_NOT_FOUND');
      const items = bindings(vault).filter(binding => binding.assetId === assetId).map(({ noteId, target }) => ({ noteId, target }));
      const page = paginate(deviceId, url, vault, `material:${assetId}`, state.noteChanges.length, items);
      return page.status ? page : ok({ vaultId: vault, assetId, ...page });
    }
    const noteId = action[1];
    if (!ident(noteId)) return fail(404, 'ENTITY_NOT_FOUND');
    const note = notes(vault).find(note => note.noteId === noteId);
    if (!note) return fail(404, 'ENTITY_NOT_FOUND');
    if (!editing) {
      const page = paginate(deviceId, url, vault, `note:${noteId}`, state.noteChanges.length, relations(deviceId, vault, note));
      return page.status ? page : ok({ vaultId: vault, noteId, revision: note.revision, ...page });
    }
    purge();
    if (method === 'GET') return ok({ vaultId: vault, noteId, desktopEditing: state.busy,
      mobileEditing: [...leases.values()].some(lease => lease.vaultId === vault && lease.noteId === noteId && lease.deviceId !== deviceId && lease.editing), leaseMs: 15000 });
    if (!object(body) || Object.keys(body).length !== (method === 'POST' ? 1 : 4) ||
      Object.keys(body).some(key => !(method === 'POST' ? ['vaultId'] : ['vaultId', 'sessionId', 'generation', 'editing']).includes(key))) return fail(400, 'INPUT_INVALID');
    if (method === 'POST') {
      if (leases.size >= 512) return fail(503, 'SERVICE_UNAVAILABLE');
      const sessionId = sha(`${instance}:${++counter}`).slice(0, 32);
      leases.set(sessionId, { deviceId, vaultId: vault, noteId, generation: 0, editing: false, until: clock + 15000 });
      return ok({ vaultId: vault, noteId, sessionId, generation: 0, editing: false, leaseMs: 15000 });
    }
    if (!ident(body.sessionId) || !Number.isSafeInteger(body.generation) || body.generation <= 0 || typeof body.editing !== 'boolean') return fail(400, 'INPUT_INVALID');
    const lease = leases.get(body.sessionId);
    if (!lease || lease.deviceId !== deviceId || lease.vaultId !== vault || lease.noteId !== noteId) return fail(410, 'CURSOR_TOO_OLD');
    if (body.generation > lease.generation) {
      lease.generation = body.generation; lease.editing = body.editing;
      if (body.editing) lease.until = clock + 15000; else leases.delete(body.sessionId);
    }
    return ok({ vaultId: vault, noteId, sessionId: body.sessionId, generation: lease.generation, editing: lease.editing, leaseMs: 15000 });
  }
  return { request, advance: milliseconds => { clock += milliseconds; purge(); } };
}
