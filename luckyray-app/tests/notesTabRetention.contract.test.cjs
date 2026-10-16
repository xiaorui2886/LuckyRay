// Direct production effect-body contracts. The separate component test runs
// these same bodies under real React Activity and StrictMode in a browser.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const ast = ts.createSourceFile('NotesPage.tsx', fs.readFileSync(path.join(root, 'src/features/notes/NotesPage.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function extract(predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1);
  return matches[0].getText(ast);
}
const declaration = name => 'const ' + extract(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name) + ';';
const effect = marker => extract(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes(marker)) + ';';

function harness(tabs, activeId) {
  const effects = [], events = [], flushes = [];
  const draft = { text: 'unsaved body', selection: 17, undo: ['initial'], owner: {} };
  const context = {
    useRef: value => ({ current: value }), useCallback: fn => fn,
    useEffect: setup => effects.push(setup),
    notesPaneLayout: null, notesPaneViewsRef: { current: { get: (paneId, tabId) => paneId + ":" + tabId } },
    openTabs: tabs, selectedNoteId: tabs.find(tab => tab.id === activeId)?.kind === 'empty' ? null : activeId,
    activeEmptyTabId: tabs.find(tab => tab.id === activeId)?.kind === 'empty' ? activeId : null,
    notes: [{ id: 'A', title: 'Alpha' }, { id: 'B', title: 'Beta' }],
    editTitle: 'Fallback', noteTitle: note => note.title, t: key => key,
    flushPendingSaveRef: { current: () => flushes.push(draft.text) }, notesExitTitleRef: { current: 'Knowledge' },
    window: { dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule([
    declaration('publishedTabsRef'), declaration('publishTabs'),
    effect('publishTabs(openTabs, selectedNoteId || activeEmptyTabId)'),
    effect('title: notesExitTitleRef.current'),
    'this.publish = publishTabs;',
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  let cleanup;
  return {
    context, draft, flushes,
    mount() { effects[0](); cleanup = effects[1](); },
    hide() { cleanup(); },
    strip() { return events.filter(event => event.type === 'luckyray:notes-tabs').at(-1)?.detail; },
    count() { return events.filter(event => event.type === 'luckyray:notes-tabs').length; },
  };
}
const plain = value => JSON.parse(JSON.stringify(value));
for (const [label, tabs, activeId] of [
  ['single note', [{ id: 'A', kind: 'note' }], 'A'],
  ['multiple notes', [{ id: 'A', kind: 'note' }, { id: 'B', kind: 'note' }], 'B'],
  ['empty note', [{ id: 'empty-1', kind: 'empty' }], 'empty-1'],
  ['fully closed strip', [], null],
]) {
  test(`${label}: exit clears only the projection and next setup republishes retained tabs`, () => {
    const h = harness(tabs, activeId);
    h.mount();
    const initial = plain(h.strip());
    const owner = h.draft.owner;
    for (let i = 0; i < 3; i++) {
      h.hide();
      assert.deepEqual(plain(h.strip()), { tabs: [], activeId: null });
      h.mount();
      assert.deepEqual(plain(h.strip()), initial);
    }
    assert.equal(h.draft.owner, owner);
    assert.deepEqual(h.draft, { text: 'unsaved body', selection: 17, undo: ['initial'], owner });
    assert.deepEqual(h.flushes, ['unsaved body', 'unsaved body', 'unsaved body']);
    assert.equal(h.context.openTabs, tabs, 'publication must not replace the tab array');
  });
}
test('unchanged visible publications stay deduplicated; explicit close and reopen survive exit', () => {
  const h = harness([{ id: 'A', kind: 'note' }], 'A');
  h.mount();
  const count = h.count();
  for (let i = 0; i < 10; i++) h.context.publish(h.context.openTabs, 'A');
  assert.equal(h.count(), count);
  h.context.openTabs = [];
  h.context.selectedNoteId = null;
  h.context.publish([], null);
  h.hide(); h.mount();
  assert.deepEqual(plain(h.strip()), { tabs: [], activeId: null });
  h.context.openTabs = [{ id: 'B', kind: 'note' }];
  h.context.selectedNoteId = 'B';
  h.context.publish(h.context.openTabs, 'B');
  h.hide(); h.mount();
  assert.deepEqual(plain(h.strip()).tabs.map(tab => tab.id), ['B']);
  assert.equal(h.strip().activeId, 'B');
});
