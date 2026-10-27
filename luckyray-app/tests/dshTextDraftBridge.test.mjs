import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createTextDraftStore, installTextDraftBridge, textDraftChange, TEXT_DRAFT_PATH } from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs';
import { openSyntheticCarrier } from './fixtures/dshAuthenticatedSyntheticCarrier.mjs';

const current = 'dsh.sessions.current';
const key = id => `dsh.conversation.${id}`;
const plain = value => JSON.parse(JSON.stringify(value));
function profile(t) {
  const root = mkdtempSync(join(tmpdir(), 'luckyray-text-drafts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function page(store, initial = {}, fault = {}) {
  const frames = [];
  const sandbox = { location: { hostname: '127.0.0.1' }, console, frames, initial,
    transport(method, frame) {
      frames.push(frame);
      if (method === 'GET') return store.begin();
      if (fault.before > 0) { fault.before--; throw new Error('synthetic-before-commit'); }
      const response = store.write(frame);
      if (fault.after > 0) { fault.after--; throw new Error('synthetic-lost-ack'); }
      return response;
    } };
  vm.createContext(sandbox);
  vm.runInContext(`
    class Storage {
      constructor() { this.data = new Map(Object.entries(initial)); }
      get length() { return this.data.size; }
      key(i) { return [...this.data.keys()][i] ?? null; }
      getItem(k) { return this.data.get(k) ?? null; }
      setItem(k,v) { this.data.set(k,v); }
      removeItem(k) { this.data.delete(k); }
      clear() { this.data.clear(); }
    }
    globalThis.Storage=Storage;
    globalThis.localStorage=new Storage();
    globalThis.sessionStorage=new Storage();
    globalThis.XMLHttpRequest=class {
      open(method,path,async) { if(async!==false) throw Error('must precede official first read'); this.method=method; }
      setRequestHeader() {}
      send(body) { this.responseText=JSON.stringify(transport(this.method,body===null?null:JSON.parse(body))); this.status=200; }
    };
    (${installTextDraftBridge.toString()})();
  `, sandbox);
  return { frames, run: code => vm.runInContext(code, sandbox), sandbox };
}

test('allowlist projects only official text and real selected session, never references, views or arbitrary storage', () => {
  assert.deepEqual(textDraftChange(current, '{"sessionId":"real-123","subagentAddress":"ignored"}'), { key: current, value: { sessionId: 'real-123' } });
  assert.deepEqual(textDraftChange(key('real-123'), JSON.stringify({ draft: { text: '测试🙂', references: [{ secret: 'ignored' }] }, view: 'ignored', attachments: ['ignored'] })), { key: key('real-123'), value: '测试🙂' });
  for (const ignored of ['auth', 'dsh.conversation', 'dsh.conversation.', key('../other'), key('__proto__')]) assert.equal(textDraftChange(ignored, '{}'), null);
  assert.throws(() => textDraftChange(key('real-123'), JSON.stringify({ draft: '字'.repeat(100000) })), /too-large/);
});

test('official synchronous writes survive immediate reopen, ordered final write and profile isolation', t => {
  const root = profile(t), store = createTextDraftStore(root), p = page(store);
  p.run(`localStorage.setItem('${current}', JSON.stringify({sessionId:'existing-123'}));`);
  for (let n = 0; n < 50; n++) p.run(`localStorage.setItem('${key('existing-123')}', JSON.stringify({draft:'末次文字-${n}🙂',view:null}));`);
  const reopened = page(createTextDraftStore(root));
  assert.equal(reopened.run(`JSON.parse(localStorage.getItem('${key('existing-123')}')).draft`), '末次文字-49🙂');
  assert.equal(reopened.run(`JSON.parse(localStorage.getItem('${current}')).sessionId`), 'existing-123');
  assert.deepEqual(createTextDraftStore(profile(t)).begin().state.drafts, {});
});

test('homepage uses official blank ID; restore precedes first read and never races newer input', t => {
  const root = profile(t), p = page(createTextDraftStore(root));
  p.run(`localStorage.setItem('${current}', JSON.stringify({sessionId:'official-blank-456'})); localStorage.setItem('${key('official-blank-456')}', JSON.stringify({draft:{text:'首页草稿',references:[]}}));`);
  const q = page(createTextDraftStore(root));
  assert.equal(q.run(`JSON.parse(localStorage.getItem('${key('official-blank-456')}')).draft`), '首页草稿');
  q.run(`localStorage.setItem('${key('official-blank-456')}', JSON.stringify({draft:'新输入'}));`);
  assert.equal(q.run(`JSON.parse(localStorage.getItem('${key('official-blank-456')}')).draft`), '新输入');
  assert.equal(q.frames.length, 2, 'no delayed restore, polling or unload writer');
});

for (const action of ['empty', 'remove', 'clear']) test(`${action} is durable; recycled origins and old page writes cannot resurrect text`, t => {
  const root = profile(t), store = createTextDraftStore(root), p = page(store);
  const stale = JSON.stringify({ draft: '旧文字', view: 'keep-local-view' });
  p.run(`localStorage.setItem('${key('existing-123')}', ${JSON.stringify(stale)});`);
  const q = page(store);
  const code = action === 'empty' ? `localStorage.setItem('${key('existing-123')}', '{"draft":""}');` : action === 'remove' ? `localStorage.removeItem('${key('existing-123')}');` : 'localStorage.clear();';
  q.run(code);
  assert.throws(() => p.run(`localStorage.setItem('${key('existing-123')}', '{"draft":"late stale"}');`), /stale-write/);
  const r = page(createTextDraftStore(root), { [key('existing-123')]: stale, unrelated: 'not-copied' });
  assert.equal(r.run(`JSON.parse(localStorage.getItem('${key('existing-123')}')).draft`), '');
  assert.equal(r.run(`JSON.parse(localStorage.getItem('${key('existing-123')}')).view`), 'keep-local-view');
  assert.equal(r.run(`localStorage.getItem('unrelated')`), 'not-copied');
});

test('no other localStorage or sessionStorage data is sent or copied; semantic draft becomes text only', t => {
  const root = profile(t), p = page(createTextDraftStore(root));
  p.run(`localStorage.setItem('auth','not-a-real-secret'); sessionStorage.setItem('${key('existing-123')}', '{"draft":"session-only"}'); localStorage.setItem('${key('existing-123')}', JSON.stringify({draft:{text:'only text',references:[{ref:'attachment-not-copied'}]},view:'not-copied',attachmentIds:['not-copied']}));`);
  assert.deepEqual(plain(p.frames[2].change), { key: key('existing-123'), value: 'only text' });
  assert.equal(p.frames.length, 3, 'GET, empty initial seed, official edit');
  const disk = readFileSync(join(root, 'luckyray-text-drafts-v1.json'), 'utf8');
  assert.equal(/not-copied|session-only|not-a-real-secret/.test(disk), false);
});

test('stale/out-of-order writes and unreadable persistence fail without committing a false success', t => {
  const root = profile(t), store = createTextDraftStore(root), lease = store.begin().lease;
  const frame = { lease, sequence: 2, change: { key: key('existing-123'), value: 'wrong order' } };
  assert.throws(() => store.write(frame), /stale-write/);
  store.write({ ...frame, sequence: 1 });
  assert.deepEqual(store.write({ ...frame, sequence: 1 }), { saved: true, sequence: 1 }, 'exact committed replay acknowledges without another write');
  assert.throws(() => store.write({ ...frame, sequence: 1, change: { ...frame.change, value: 'different' } }), /stale-write/);
  const file = join(root, 'luckyray-text-drafts-v1.json');
  writeFileSync(file, 'not-json');
  assert.throws(() => createTextDraftStore(root), SyntaxError);
});

test('official carrier authenticates the adapter and inserts it ahead of official boot; no cookie changes', { skip: !process.env.DSH_M1_RUNTIME_ROOT, timeout: 40000 }, async t => {
  const c = await openSyntheticCarrier();
  try {
    const html = (await c.raw('/')).bytes.toString('utf8');
    assert.ok(html.indexOf('installTextDraftBridge') >= 0);
    assert.ok(html.indexOf('installTextDraftBridge') < html.indexOf('__DSH_BOOT__'));
    const headers = { 'x-luckyray-text-drafts': '1' };
    assert.equal((await c.raw(TEXT_DRAFT_PATH)).status, 403);
    assert.equal((await c.raw(TEXT_DRAFT_PATH, { headers: { ...headers, cookie: '' } })).status, 403);
    assert.equal((await c.raw(TEXT_DRAFT_PATH, { headers: { ...headers, origin: 'https://invalid.example' } })).status, 403);
    const snapshot = await c.raw(TEXT_DRAFT_PATH, { headers });
    assert.equal(snapshot.status, 200);
    const { lease, initialized } = JSON.parse(snapshot.bytes);
    assert.equal(initialized, false);
    const seedBody = JSON.stringify({ lease, sequence: 1, initialize: { selection: null,
      drafts: { 'seed-a': 'a'.repeat(200 * 1024), 'seed-b': 'b'.repeat(200 * 1024), 'seed-c': 'c'.repeat(200 * 1024) } } });
    assert.ok(Buffer.byteLength(seedBody) > 512 * 1024, 'seed aggregation exceeds old per-edit HTTP bound');
    const seedRequest = { method: 'POST', headers, body: seedBody };
    assert.equal((await c.raw(TEXT_DRAFT_PATH, seedRequest)).status, 200);
    assert.equal((await c.raw(TEXT_DRAFT_PATH, seedRequest)).status, 200, 'exact HTTP replay is idempotent');
    const saved = await c.raw(TEXT_DRAFT_PATH, { method: 'POST', headers, body: JSON.stringify({ lease, sequence: 2, change: { key: key('synthetic-session'), value: '真实服务限定字段' } }) });
    assert.equal(saved.status, 200);
    const remoteHost = 'luckyray-companion.local:41946', remoteOrigin = `https://${remoteHost}`;
    await c.owner.setRemoteAuthority({ host: remoteHost, origin: remoteOrigin, gatewayGeneration: 7 });
    const minted = await c.owner.mintRemoteSession({ deviceId: 'device-00000000000000000000000000000001', gatewayGeneration: 7 });
    assert.equal((await c.raw(`/_luckyray/remote/bootstrap?ref=${minted.ref}`, { headers: { host: remoteHost, origin: remoteOrigin, cookie: '' } })).status, 302);
    assert.equal((await c.raw(TEXT_DRAFT_PATH, { headers: { ...headers, host: remoteHost, origin: remoteOrigin } })).status, 403, 'even an authorized companion cannot read desktop draft text');
    await c.owner.close(); await c.open();
    const reopened = await c.raw(TEXT_DRAFT_PATH, { headers });
    assert.equal(JSON.parse(reopened.bytes).state.drafts['synthetic-session'], '真实服务限定字段');
    t.diagnostic('official rc.2 carrier restarted on a fresh port; scoped text retained; auth fences intact');
  } finally { await c.dispose(); }
});



test('first use preserves current-origin official text and selection, without importing other fields', t => {
  const root = profile(t), store = createTextDraftStore(root);
  const existing = JSON.stringify({draft:{text:'首次已有草稿🙂', references:[{ref:'leave-local-only'}]},view:'leave-local-only'});
  const p = page(store, { [key('existing-123')]: existing,
    [current]: JSON.stringify({sessionId:'existing-123',subagentAddress:'leave-local-only'}),
    auth:'leave-local-only', [key('../invalid')]: '{"draft":"not-imported"}' });
  assert.equal(p.run(`localStorage.getItem('${key('existing-123')}')`), existing, 'no overwrite even of original semantic fields');
  assert.equal(p.run(`JSON.parse(localStorage.getItem('${current}')).sessionId`), 'existing-123');
  const disk = readFileSync(join(root,'luckyray-text-drafts-v1.json'),'utf8');
  assert.equal(/leave-local-only|not-imported/.test(disk), false);
  const q = page(createTextDraftStore(root));
  assert.equal(q.run(`JSON.parse(localStorage.getItem('${key('existing-123')}')).draft`), '首次已有草稿🙂');
  assert.equal(q.run(`JSON.parse(localStorage.getItem('${current}')).sessionId`), 'existing-123');
});

test('empty first use commits an initialized baseline; future recycled origin cannot import cleared text', t => {
  const root=profile(t); page(createTextDraftStore(root));
  const store=createTextDraftStore(root);
  assert.equal(store.begin().initialized,true);
  const p=page(store,{[key('old-session')]:'{"draft":"stale"}',[current]:'{"sessionId":"old-session"}'});
  assert.equal(p.run(`JSON.parse(localStorage.getItem('${key('old-session')}')).draft`),'');
  assert.equal(p.run(`localStorage.getItem('${current}')`),null);
});

test('first seed is atomic, cannot replace an initialized store and remains local on initialization failure', t => {
  const root=profile(t),store=createTextDraftStore(root),fault={before:2};
  const initial={ [key('existing-123')]:'{"draft":"old local"}', [current]:'{"sessionId":"existing-123"}'};
  const p=page(store,initial,fault);
  assert.equal(p.run(`localStorage.getItem('${key('existing-123')}')`), initial[key('existing-123')]);
  p.run(`localStorage.setItem('${key('existing-123')}', '{"draft":"new edit"}')`);
  const snapshot=store.begin();
  assert.equal(snapshot.state.drafts['existing-123'],'new edit');
  assert.equal(snapshot.state.selection.sessionId,'existing-123');
  assert.throws(()=>store.write({lease:snapshot.lease,sequence:1,initialize:{selection:null,drafts:{}}}), /initialize-invalid/);
});

for (const failure of ['before','after']) test(`${failure}-commit transient failure retries the identical frame and subsequent edits still persist`, t => {
  const root=profile(t),store=createTextDraftStore(root),fault={};
  const p=page(store,{},fault);
  fault[failure]=1;
  const start=p.frames.length;
  p.run(`localStorage.setItem('${key('existing-123')}', '{"draft":"first edit"}')`);
  assert.deepEqual(p.frames[start],p.frames[start+1]);
  p.run(`localStorage.setItem('${key('existing-123')}', '{"draft":"next edit"}')`);
  assert.equal(createTextDraftStore(root).begin().state.drafts['existing-123'],'next edit');
});

test('two lost acknowledgements keep the same pending write; next clear settles it then cannot resurrect text', t => {
  const root=profile(t),store=createTextDraftStore(root),fault={};
  const p=page(store,{},fault);
  fault.after=2;
  assert.throws(()=>p.run(`localStorage.setItem('${key('existing-123')}', '{"draft":"committed but unacknowledged"}')`), /lost-ack/);
  p.run(`localStorage.removeItem('${key('existing-123')}')`);
  assert.deepEqual(createTextDraftStore(root).begin().state.drafts,{});
});

test('lost seed acknowledgement is replay-safe and size/identity validation remain bounded', t => {
  const root=profile(t),store=createTextDraftStore(root);
  page(store,{[key('existing-123')]:'{"draft":"initial"}'},{after:1});
  assert.equal(createTextDraftStore(root).begin().state.drafts['existing-123'],'initial');
  const clean=createTextDraftStore(profile(t)),lease=clean.begin().lease;
  assert.throws(()=>clean.write({lease,sequence:1,initialize:{drafts:{'../invalid':'no'}}}), /initialize-invalid/);
  assert.throws(()=>clean.write({lease,sequence:1,initialize:{drafts:{valid:'x'.repeat(256*1024+1)}}}), /too-large/);
  assert.equal(clean.begin().initialized,false);
});
