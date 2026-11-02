// Execute the real hook/normalizer with controlled React and transport seams.
// This is not evidence of native Tauri event delivery or a GUI import.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { stripTypeScriptTypes } = require('node:module');

const root = path.resolve(__dirname, '..');
const paths = fs.readFileSync(path.join(root, 'src/features/notes/externalDropPaths.ts'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'src/features/notes/useVaultFileDrop.ts'), 'utf8')
  .replace(/^import[^\n]*\n/gm, '')
  .replaceAll('import.meta.env.DEV', 'false')
  .replaceAll('import("@tauri-apps/api/webview")', 'Promise.resolve(webviewApi)')
  .replaceAll('import("@tauri-apps/api/core")', 'Promise.resolve(coreApi)');
const code = stripTypeScriptTypes((paths + '\n' + hook).replace(/^export /gm, '')) + '\nuseVaultFileDrop;';
const settle = () => new Promise(resolve => setImmediate(resolve));
const selected = ['/synthetic/Note.md', '/synthetic/note.md'];

async function fixture(options = {}) {
  const state = { callback: null, calls: [], diagnostics: [], rejected: false, inside: true, ...options };
  const target = { closest: () => ({ dataset: { folderDropId: '__root__' } }) };
  const page = { contains: value => value === target };
  const useDrop = vm.runInNewContext(code, {
    URL, Promise,
    useRef: value => ({ current: value }),
    useEffect: effect => { state.dispose = effect(); },
    window: { devicePixelRatio: 2 },
    sessionStorage: { getItem: () => state.diagnosticOptIn === false ? null : '1' },
    document: { getElementById: () => page, elementFromPoint: (x, y) => state.inside && x === 10 && y === 20 ? target : null },
    webviewApi: { getCurrentWebview: () => ({ onDragDropEvent: async callback => {
      state.callback = callback;
      return () => { state.callback = null; };
    } }) },
    coreApi: { invoke: async (command, payload) => { state.diagnostics.push({ command, ...payload }); } },
  });
  const own = {
    enabled: true, owner: {}, defaultParent: null,
    classify: async input => {
      state.calls.push(['classify', Array.from(input)]);
      if (state.classifyFailure) throw new Error('hunter2');
      if (state.changeOwner) own.owner = {};
      return input.map(path => ({ path, isFile: true, isDir: false }));
    },
    importPaths: async (parent, input) => { state.calls.push(['import', parent, Array.from(input)]); },
    insertFiles: () => { throw new Error('unexpected-media-route'); },
    rejected: () => { state.rejected = true; },
  };
  useDrop(own);
  await settle();
  state.emit = type => state.callback({ payload: { type, paths: selected, position: { x: 20, y: 40 } } });
  return state;
}

test('the real listener routes one case-distinct POSIX gesture to classification and root import', async () => {
  const state = await fixture();
  state.emit('enter');
  state.emit('drop');
  await settle();
  assert.deepEqual(state.calls, [['classify', selected], ['import', null, selected]]);
  for (const stage of ['listener-ready', 'enter', 'drop', 'classify-start', 'classified-files', 'import-route-start', 'import-route-complete']) {
    assert(state.diagnostics.some(item => item.stage === stage));
  }
  assert(state.diagnostics.some(item => item.stage === 'classified-files' && item.count === 2));
  const silent = await fixture({ diagnosticOptIn: false });
  silent.emit('drop');
  await settle();
  assert.deepEqual(silent.calls, [['classify', selected], ['import', null, selected]]);
  assert.deepEqual(silent.diagnostics, []);
});

test('the real listener ignores a point outside Notes and a changed source owner', async () => {
  for (const option of [{ inside: false }, { changeOwner: true }]) {
    const state = await fixture(option);
    state.emit('drop');
    await settle();
    assert.equal(state.calls.some(call => call[0] === 'import'), false);
    if (!state.inside) assert.deepEqual(state.calls, []);
    assert(state.diagnostics.some(item => item.stage === (!state.inside ? 'drop' : 'owner-stale') && item.hit === false));
  }
});

test('classification failure is rejected without importing or putting the private error in diagnostics', async () => {
  const state = await fixture({ classifyFailure: true });
  state.emit('drop');
  await settle();
  assert.equal(state.rejected, true);
  assert.equal(state.calls.some(call => call[0] === 'import'), false);
  assert.equal(JSON.stringify(state.diagnostics).includes('hunter2'), false);
  assert(state.diagnostics.some(item => item.stage === 'drop-rejected'));
});
