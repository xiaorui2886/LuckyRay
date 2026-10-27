const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');

const app = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(app, 'src/features/notes/NotesPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
function block(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `missing production block: ${start}`);
  return source.slice(first, last);
}
const sidebarStart = 'onInsert={async asset => {';
const sidebarBody = block(sidebarStart, '\n                    }}').slice(sidebarStart.length);
const queueSource = fs.readFileSync(path.join(app, 'src/features/notes/editor/serialAttachmentInserts.ts'), 'utf8').replace('export function', 'function');
const queueJavascript = ts.transpileModule(queueSource, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
const sameSelection = block('function sameAttachmentSelection(', '\n}\n') + '\n}';
const production = [
  sameSelection,
  block('const [activeNotesSplitPane, setActiveNotesSplitPaneState]', 'const [editTitle'),
  block('const [editorMode, setEditorModeState]', 'const [sourceContentDraft'),
  block('const materialInsertionUiRef = useRef(', '// All material pickers'),
  block('const publishExistingAssetMarkdown = useCallback(', 'const rememberPublishedAttachment'),
  block('const insertDroppedFilesAsAssets = useCallback(', 'const insertClipboardImageAsAsset'),
  block('const insertExistingAssetReference = useCallback(', 'const createLinkedNote'),
  `const sidebarInsert = async asset => {${sidebarBody}\n};`,
  'return { setEditorMode, editorModeSessionRef, setActiveNotesSplitPane, attachmentPaneEpochRef, enqueue: serialAttachmentInsertsRef.current, fileInsert: insertDroppedFilesAsAssets, dragInsert: insertExistingAssetReference, sidebarInsert };',
].join('\n');
const javascript = queueJavascript + ts.transpileModule(production, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.ReactJSX}}).outputText;
new vm.Script(`(function(){${javascript}})`, {filename: 'extracted-NotesPage-handlers.js'});

function fixture() {
  const state = {
    content: 'abc', selection: {start: 3, end: 3}, source: {mode: 'real-vault', vaultId: 'v1'},
    copied: 0, committed: 0, errors: [], noteId: 'qa', noteRequest: 1,
    beforePublish: null, beforeContext: null, beforePrepare: null,
    contextStarted: 0, prepareStarted: 0, failNext: false, afterCommit: null,
  };
  const refs = {
    noteLoadRequestRef: {get current() { return state.noteRequest; }},
    selectedNoteIdRef: {get current() { return state.noteId; }},
  };
  const args = {
    useState: initial => [initial, () => {}], useRef: initial => ({current: initial}), useEffect: () => {}, useCallback: callback => callback,
    insertPicker: null, autocomplete: null, ...refs,
    selectedNote: {id: 'qa'}, isRealVaultNoteId: () => true,
    readActiveKnowledgeWriteSource: () => state.source,
    readActiveEditorValue: () => state.content,
    readActiveEditorSelection: () => ({...state.selection}),
    replaceEditorContent: (content, replacement, range) => ({
      content: content.slice(0, range.start) + replacement + content.slice(range.end),
      selection: {start: range.start + replacement.length, end: range.start + replacement.length},
    }),
    replaceEditorRange: (replacement, range) => {
      const result = args.replaceEditorContent(state.content, replacement, range);
      state.content = result.content; state.selection = result.selection; state.committed += 1;
      if (state.afterCommit) state.afterCommit();
    },
    readActiveKnowledgeSource: () => state.source,
    captureAttachmentContext: async () => { state.contextStarted += 1; if (state.beforeContext) await state.beforeContext(); return {}; },
    realVaultRelativePathFromNoteId: () => 'qa.md', attachmentContextIsCurrent: () => true,
    publishVaultAttachment: async () => {
      state.copied += 1;
      if (state.beforePublish) await state.beforePublish();
      if (state.failNext) { state.failNext = false; throw new Error('publication failed'); }
      return {markdown: '![[x.png]]'};
    },
    preparePublishedAttachment: async (_context, result) => { state.prepareStarted += 1; if (state.beforePrepare) await state.beforePrepare(); return {markdown: result.markdown}; },
    materialBlockInsertion: (_before, markdown) => markdown,
    materialBlockSelection: (_before, replacement, range) => ({start: range.start + replacement.length, end: range.start + replacement.length}),
    setStatus: status => { state.errors.push(status); },
    allAssets: [], bridge: null, buildDroppedAssetMarkdown: () => '', t: key => key,
    currentVault: {id: 'v1'},
  };
  const make = new Function(...Object.keys(args), javascript);
  return {state, api: make(...Object.values(args))};
}
const file = () => ({name: 'x.png', type: 'image/png', size: 1, arrayBuffer: async () => new ArrayBuffer(1)});
const selection = {start: 3, end: 3};
const pause = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return {promise, release}; };

async function queuedInvalidation(name, mutate, insert = api => api.fileInsert([file()], selection)) {
  const {state, api} = fixture();
  const gate = pause();
  const blocker = api.enqueue(() => true, () => gate.promise);
  await Promise.resolve();
  const pending = insert(api);
  mutate(state, api);
  gate.release();
  await blocker; await pending.catch(() => {});
  assert.equal(state.copied, 0, `${name}: no copy after invalidation while queued`);
  assert.equal(state.committed, 0, `${name}: no commit after invalidation while queued`);
}

(async () => {
  await queuedInvalidation('preview', (_s, api) => api.setEditorMode('preview'));
  await queuedInvalidation('source', (_s, api) => api.setEditorMode('source'));
  await queuedInvalidation('away and back', (_s, api) => { api.setEditorMode('preview'); api.setEditorMode('live'); });
  await queuedInvalidation('different note', s => { s.noteId = 'other'; s.noteRequest += 1; });
  await queuedInvalidation('different Vault', s => { s.source = {mode: 'real-vault', vaultId: 'v2'}; });
  await queuedInvalidation('different pane', (_s, api) => api.setActiveNotesSplitPane('notes-pane-2'));
  await queuedInvalidation('pane away and back', (_s, api) => { api.setActiveNotesSplitPane('notes-pane-2'); api.setActiveNotesSplitPane('notes-pane-1'); });
  await queuedInvalidation('cursor moved by user', s => { s.selection = {start: 1, end: 1}; });
  await queuedInvalidation('dragged material', (_s, api) => api.setEditorMode('preview'), api => api.dragInsert({id: 'asset', name: 'x.png'}, selection));
  await queuedInvalidation('sidebar material', (_s, api) => api.setEditorMode('preview'), api => api.sidebarInsert({id: 'asset', name: 'x.png'}));

  for (const [name, insert] of [
    ['file paste', api => api.fileInsert([file()], selection)],
    ['material drag', api => api.dragInsert({id: 'asset', name: 'x.png'}, selection)],
    ['attachment sidebar', api => api.sidebarInsert({id: 'asset', name: 'x.png'})],
  ]) {
    for (const nextMode of ['preview', 'source']) {
      const {state, api} = fixture();
      const gate = pause();
      state.beforePublish = () => gate.promise;
      const pending = insert(api);
      while (state.copied === 0) await Promise.resolve();
      api.setEditorMode(nextMode);
      gate.release(); await pending.catch(() => {});
      assert.equal(state.copied, 1, `${name}/${nextMode}: publication was already in flight`);
      assert.equal(state.committed, 0, `${name}/${nextMode}: no stale commit after publication`);
    }
  }
  for (const [name, mutate] of [
    ['different note', (state) => { state.noteId = 'other'; state.noteRequest += 1; }],
    ['different Vault', (state) => { state.source = {mode: 'real-vault', vaultId: 'v2'}; }],
    ['different pane', (_state, api) => api.setActiveNotesSplitPane('notes-pane-2')],
  ]) {
    const {state, api} = fixture();
    const gate = pause();
    state.beforePublish = () => gate.promise;
    const pending = api.fileInsert([file()], selection);
    while (state.copied === 0) await Promise.resolve();
    mutate(state, api);
    gate.release(); await pending;
    assert.equal(state.committed, 0, `${name}: in-flight publication cannot write into a new session`);
  }

  for (const [stage, setup, started, insert] of [
    ['context capture', s => { const gate = pause(); s.beforeContext = () => gate.promise; return gate; }, s => s.contextStarted > 0, api => api.fileInsert([file()], selection)],
    ['prepared resolution', s => { const gate = pause(); s.beforePrepare = () => gate.promise; return gate; }, s => s.prepareStarted > 0, api => api.fileInsert([file()], selection)],
  ]) {
    const {state, api} = fixture();
    const gate = setup(state);
    const pending = insert(api);
    while (!started(state)) await Promise.resolve();
    api.setEditorMode('preview');
    gate.release(); await pending;
    assert.equal(state.committed, 0, `${stage}: no stale editor commit`);
    if (stage !== 'prepared resolution') assert.equal(state.copied, 0, `${stage}: no attachment copy after mode switch`);
  }
  {
    const {state, api} = fixture();
    const gate = pause();
    let byteReadStarted = false;
    const pending = api.fileInsert([{...file(), arrayBuffer: () => { byteReadStarted = true; return gate.promise.then(() => new ArrayBuffer(1)); }}], selection);
    while (!byteReadStarted) await Promise.resolve();
    api.setEditorMode('preview');
    gate.release(); await pending;
    assert.equal(state.copied, 0, 'after asynchronous file read, mode changes before copy');
    assert.equal(state.committed, 0, 'after asynchronous file read, no stale commit');
  }

  {
    const {state, api} = fixture();
    const first = api.fileInsert([file()], selection);
    const second = api.fileInsert([file()], selection);
    await Promise.all([first, second]);
    assert.equal(state.copied, 2, 'both consecutive publications run');
    assert.equal(state.committed, 2, 'both consecutive publications commit once');
    assert.equal(state.content, 'abc![[x.png]]![[x.png]]', 'second insert follows the first legal caret move');
  }
  {
    const {state, api} = fixture();
    state.afterCommit = () => { state.selection = {start: 0, end: 0}; };
    const first = api.fileInsert([file()], selection);
    const second = api.fileInsert([file()], selection);
    await Promise.all([first, second]);
    assert.equal(state.copied, 1, 'user movement after first legal commit prevents queued copy');
    assert.equal(state.committed, 1, 'queued request does not follow an unrelated cursor');
  }
  {
    const {state, api} = fixture();
    state.failNext = true;
    await api.fileInsert([file()], selection);
    await api.fileInsert([file()], selection);
    assert.equal(state.copied, 2, 'failed publication does not poison the queue');
    assert.equal(state.committed, 1, 'next legal insertion still commits');
  }
  console.log('PASS: production NotesPage queued file/drag/sidebar handlers block stale sessions and preserve ordered insertion');
})().catch(error => { console.error(error); process.exitCode = 1; });
