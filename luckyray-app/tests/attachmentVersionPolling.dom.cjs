// Exercise the production hook with a retained, hidden NotesPage and deferred IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require(process.env.TEST_JSDOM_PATH || 'jsdom');
const { buildSync } = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://qa.invalid' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'navigator']) {
  Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
}
const React = require('react');
const { createRoot } = require('react-dom/client');
const { flushSync } = require('react-dom');
let source = { vaultId: 'synthetic-a' }, calls = 0, changed = 0, invalidations = 0;
let finish;
const timers = new Map();
let nextTimer = 1;
const mocks = {
  '@tauri-apps/api/core': { invoke: (command, args) => {
    assert.equal(command, 'knowledge_attachment_versions');
    assert.equal(args.vaultId, source.vaultId);
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } },
  '../../core/services/materialStore': { materialStore: { invalidate: async () => { invalidations++; } } },
  '../../core/services/knowledgeSource': { readActiveKnowledgeWriteSource: () => source },
};
const built = buildSync({ entryPoints: ['src/features/notes/useAttachmentFileVersions.ts'], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['react', ...Object.keys(mocks)] });
const box = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(box, box.exports, name => mocks[name] || require(name));
const root = createRoot(document.getElementById('root'));
const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
let pageVisible = true;
Object.defineProperty(document, 'visibilityState', { get: () => pageVisible ? 'visible' : 'hidden', configurable: true });
global.setTimeout = callback => { const id = nextTimer++; timers.set(id, callback); return id; };
global.clearTimeout = id => timers.delete(id);
const recheck = () => { changed++; };
function Fixture({ visible }) { box.exports.useAttachmentFileVersions(source.vaultId, recheck, visible); return null; }
const render = visible => flushSync(() => root.render(React.createElement(Fixture, { visible })));
const settle = async versions => { finish({ versions }); for (let n = 0; n < 6; n++) await Promise.resolve(); };
const fireTimer = async () => {
  assert.equal(timers.size, 1, 'only one periodic read may be scheduled');
  const [id, callback] = timers.entries().next().value; timers.delete(id); callback();
  await Promise.resolve();
};
(async () => {
  render(false);
  assert.equal(calls, 0, 'hidden retained notes must not start native attachment work');
  render(true); assert.equal(calls, 1);
  await settle([{ path: 'synthetic-file', version: '1' }]);
  assert.equal(changed, 0, 'first successful read is a quiet baseline');
  render(false); assert.equal(timers.size, 0);
  render(true); assert.equal(calls, 2, 'returning to notes immediately rechecks');
  await settle([{ path: 'synthetic-file', version: '2' }]);
  assert.equal(changed, 1, 'hidden/visible transitions retain the last version baseline');
  assert.equal(invalidations, 1);
  pageVisible = false; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 0, 'hidden application pages stop periodic work');
  pageVisible = true; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 3);
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 3, 'resume events cannot overlap an in-flight native read');
  await settle([{ path: 'synthetic-file', version: '2' }]);
  await fireTimer(); assert.equal(calls, 4);
  const stale = finish;
  source = { vaultId: 'synthetic-b' }; render(true);
  assert.equal(calls, 5, 'new vault starts its own baseline');
  stale({ versions: [{ path: 'synthetic-file', version: 'stale' }] });
  await settle([{ path: 'synthetic-b-file', version: '1' }]);
  assert.equal(changed, 1, 'late old-vault replies are discarded');
  await fireTimer(); assert.equal(calls, 6);
  flushSync(() => root.unmount());
  await settle([{ path: 'synthetic-b-file', version: '2' }]);
  assert.equal(changed, 1); assert.equal(timers.size, 0, 'unmount cannot resurrect polling');
  const native = fs.readFileSync('src-tauri/src/attachment_coordination.rs', 'utf8').replaceAll('\r\n', '\n');
  const command = native.split('#[tauri::command]\npub(super) async fn knowledge_attachment_versions')[1];
  assert(command, 'native IPC command must be asynchronous');
  assert.match(command.split('#[tauri::command]')[0], /spawn_blocking\(move \|\|/,
    'file/database verification must leave the native window thread');
  console.log('PASS attachment polling: hidden route/page, immediate resume, preserved versions, one flight/timer, vault switch, unmount, async native dispatch');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; dom.window.close();
});
