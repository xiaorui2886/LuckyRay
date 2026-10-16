// Execute the production restore callback and its callers without mounting the desktop.
// TS AST extraction preserves production bodies; only UI setters, tree conversion and stores are fixtures.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [process.env.LUCKYRAY_TEST_MODULE_ROOT || root] }));
const source = fs.readFileSync(path.join(root, 'src/features/notes/NotesPage.tsx'), 'utf8');
const ast = ts.createSourceFile('NotesPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function extract(name) {
  let found;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `production declaration ${name}`);
  if (name === 'applyRealVaultStoreSnapshot') return `const ${name} = ((currentVault) => ${found.initializer.getText(ast)})(currentVault);`;
  return ts.isFunctionDeclaration(found) ? found.getText(ast) : `const ${found.getText(ast)};`;
}
const barrier = ts.transpileModule(fs.readFileSync(path.join(root, 'src/features/notes/vaultSessionBarrier.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const barrierContext = { exports: {} };
vm.runInNewContext(barrier, barrierContext);
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function harness() {
  const state = {};
  const context = {
    ...barrierContext.exports, sessionStorage: storage(), localStorage: storage(),
    currentVault: null, locale: 'en-US', t: key => key, useCallback: fn => fn,
    selectedNoteIdRef: { current: null }, openTabsRef: { current: [] },
    renamingNoteRef: { current: null },
    buildRealVaultUiTree: tree => ({ folders: [], notes: tree }), console,
  };
  for (const name of ['RealVaultTree', 'RealVaultMarkdownIndex', 'Notes', 'SelectedFolderId', 'ActiveEmptyTabId', 'SelectedNoteId', 'SelectedNote', 'EditTitle', 'EditContent', 'SourceContentDraft', 'OpenTabs', 'Loading', 'Status']) {
    context[`set${name}`] = value => { state[name] = typeof value === 'function' ? value(state[name]) : value; };
  }
  const declarations = ['normalizeSavedNoteTab', 'normalizeSavedNoteTabsPayload', 'readSavedNoteTabsState', 'filterSavedNoteTabs', 'createEmptyNoteTab', 'isEmptyNoteTab', 'applyRealVaultStoreSnapshot'].map(extract).join('\n');
  const code = ts.transpileModule(`const NOTE_TABS_STATE_KEY = 'luckyray-notes-tabs-state-v1'; const LEGACY_NOTE_TABS_STATE_KEY = 'luckyray.openNoteTabs.v1'; ${declarations}\nthis.apply = applyRealVaultStoreSnapshot; this.read = readSavedNoteTabsState;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, state, save(vault, ids, target = context.localStorage) { context.persistNoteTabsForVault(vault, JSON.stringify({ tabs: ids.map(id => ({ id, kind: 'note' })), activeId: ids[0] }), target); } };
}
const shared = 'real-vault:shared.md', second = 'real-vault:second.md';
const tree = [{ id: shared }, { id: second }];
const plain = value => JSON.parse(JSON.stringify(value));
test('initial null-vault production callback restores A, B and returning A independently', () => {
  const h = harness();
  h.save('A', [shared, second]);
  h.save('B', [second]);
  for (const [vault, expected] of [['A', [shared, second]], ['B', [second]], ['A', [shared, second]]]) {
    // The activation path clears these refs before loading the next vault.
    h.context.openTabsRef.current = [];
    h.context.selectedNoteIdRef.current = null;
    h.context.apply(tree, { version: 1 }, vault);
    assert.deepEqual(plain(h.state.OpenTabs).map(tab => tab.id), expected);
    assert.equal(h.state.SelectedNoteId, expected[0]);
  }
});
test('local scoped tabs outrank another vault legacy session tabs', () => {
  const h = harness();
  h.save('A', [shared]);
  h.save('B', [second], h.context.sessionStorage);
  assert.deepEqual(plain(h.context.read('A')).tabs.map(tab => tab.id), [shared]);
});
test('same-vault index refresh preserves live tabs and selection', () => {
  const h = harness();
  h.save('A', [second]);
  h.context.openTabsRef.current = [{ id: shared, kind: 'note' }];
  h.context.selectedNoteIdRef.current = shared;
  h.context.apply(tree, { version: 2 }, 'A');
  assert.deepEqual(plain(h.state.OpenTabs), [{ id: shared, kind: 'note' }]);
  assert.equal(h.context.selectedNoteIdRef.current, shared);
  assert.equal(h.state.SelectedNoteId, undefined);
  assert.equal(h.state.RealVaultMarkdownIndex.version, 2);
});
test('production cached and revalidated loaders pass snapshot identity', async () => {
  const h = harness();
  h.context.currentVault = { id: 'A' };
  h.save('A', [shared]); h.save('B', [second]);
  const snapshot = { loaded: true, mode: 'real-vault', vault: { id: 'A' }, tree, markdownIndex: { version: 1 } };
  h.context.knowledgeStore = { getSnapshot: () => snapshot, revalidate: async () => snapshot };
  vm.runInContext(ts.transpileModule(`${extract('loadRealVaultTree')} this.load = loadRealVaultTree;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h.context);
  await h.context.load({ cachedOnly: true });
  assert.deepEqual(plain(h.state.OpenTabs).map(tab => tab.id), [shared]);
  h.context.openTabsRef.current = [];
  snapshot.loaded = false;
  await h.context.load();
  assert.deepEqual(plain(h.state.OpenTabs).map(tab => tab.id), [shared]);
});

test('production knowledge-store subscription restores the emitted vault snapshot', () => {
  const h = harness();
  h.save('A', [shared]); h.save('B', [second]);
  const snapshot = { status: 'ready', mode: 'real-vault', vault: { id: 'A' }, tree, version: 1, markdownIndex: { version: 1 } };
  let listener;
  Object.assign(h.context, {
    currentVault: { id: 'A' }, knowledgeStorageMode: 'real-vault',
    realVaultStoreVersionRef: { current: { vaultId: null, snapshotVersion: 0, indexVersion: 0 } },
    knowledgeStore: { getSnapshot: () => snapshot, subscribe: fn => { listener = fn; return () => {}; } },
    useEffect: fn => fn(), checkCurrentRealVaultExternalChange: () => {}, normalizeVaultRelativePath: value => value,
  });
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('const syncFromStore =')) effect = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect);
  const declarations = ['decideRealVaultIndexDelta'].map(extract).join('\n');
  vm.runInContext(ts.transpileModule(`${declarations}\n${effect.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h.context);
  assert.deepEqual(plain(h.state.OpenTabs).map(tab => tab.id), [shared]);
  h.context.openTabsRef.current = [];
  snapshot.version = 2;
  listener();
  assert.deepEqual(plain(h.state.OpenTabs).map(tab => tab.id), [shared]);
});
test('scoped session wins over scoped local, and legacy remains first-open fallback', () => {
  const h = harness();
  h.save('A', [shared]); h.save('A', [second], h.context.sessionStorage);
  assert.deepEqual(plain(h.context.read('A')).tabs.map(tab => tab.id), [second]);
  assert.deepEqual(plain(h.context.read('new-vault')).tabs.map(tab => tab.id), [second]);
  h.context.sessionStorage.setItem(h.context.noteTabsStorageKey('A'), JSON.stringify({ tabs: [], activeId: null }));
  assert.equal(h.context.read('A'), null, 'an empty own slot must not resurrect legacy tabs');
});
