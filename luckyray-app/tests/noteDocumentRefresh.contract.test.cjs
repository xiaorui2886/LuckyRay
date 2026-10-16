const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const source = fs.readFileSync(root + '/src/features/notes/NotesPage.tsx', 'utf8').replace(/\r\n/g, '\n');
const coordinatorCode = esbuild.transformSync(fs.readFileSync(root + '/src/features/notes/noteDocumentReadCoordinator.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const coordinatorModule = { exports: {} };
new Function('module', 'exports', coordinatorCode)(coordinatorModule, coordinatorModule.exports);
const { NoteDocumentReadCoordinator } = coordinatorModule.exports;

function productionCallback(name, context) {
  const marker = `const ${name} = useCallback(`;
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf('\n  }, [', start) + 4;
  assert(start >= marker.length && end > start, `missing production callback ${name}`);
  const code = esbuild.transformSync('const callback = ' + source.slice(start, end), { loader: 'ts' }).code;
  return new Function('context', `with(context){${code};return callback;}`)(context);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('published disk hydration accepts user input without a timer-dependent dead zone', async () => {
  const f = fixture();
  const selecting = f.select('n.md', { syncGlobalTab: false });
  f.settleRead(0, 'heading');
  await selecting;
  assert.equal(f.context.realVaultDocumentReadsRef.current.isHydrating('n.md'), false);
});

test('navigation effect does not read a note again when typing replaces its callback', () => {
  const start = source.indexOf('  useEffect(() => {\n    if (!selectedNoteId) return;');
  assert(start >= 0);
  const end = source.indexOf('\n  }, [', start);
  const effect = source.slice(start, source.indexOf(');', end) + 2);
  const code = esbuild.transformSync(effect, {loader:'ts'}).code;
  let lastDeps, calls = 0;
  const context = { knowledgeStorageMode:'real-vault', selectedNoteId:'n.md', selectedNoteRef:{current:{id:'n.md'}}, isRealVaultNoteId:()=>true,
    realVaultDocumentReadsRef:{current:{isHydrating:()=>false}}, selectNoteForNavigationRef:{current:()=>calls++}, selectNote:()=>calls++,
    useEffect:(run,deps)=>{if(!lastDeps || deps.some((value,i)=>value!==lastDeps[i])) run();lastDeps=deps;}
  };
  const render = new Function('context', `with(context){${code}}`);
  render(context);
  for(let i=0;i<20;i++){ context.selectNote=()=>calls++;context.selectNoteForNavigationRef.current=context.selectNote;render(context); }
  assert.equal(calls,0,'an already open document is not a navigation request');
});

function fixture() {
  const state = { source: { vaultId: 'A' }, reads: [], applied: [], conflicts: [], timers: [] };
  const ref = (current) => ({ current });
  const noop = () => {};
  const context = {
    knowledgeStorageMode: 'real-vault', selectedNoteId: 'n.md', notes: [],
    isRealVaultNoteId: (id) => id === 'n.md', realVaultRelativePathFromNoteId: (id) => id,
    normalizeVaultRelativePath: (id) => id, realVaultNoteId: (id) => id,
    readActiveKnowledgeWriteSource: () => state.source,
    vaultSessionRef: ref({ latest: () => state.source, isCurrent: session => session === state.source }),
    prepareNoteMediaRef: ref(noop),
    realVaultDocumentReadsRef: ref(new NoteDocumentReadCoordinator()),
    // These legacy refs keep the same behavioral tests runnable against the old callback.
    realVaultHydratingNoteIdRef: ref(null), realVaultExternalCheckInFlightRef: ref(false),
    realVaultLastExternalCheckAtRef: ref(0), noteLoadRequestRef: ref(0),
    selectedNoteIdRef: ref('n.md'), selectedNoteRef: ref(null),
    realVaultSavedContentRef: ref(new Map([['n.md', 'heading']])),
    realVaultLatestContentRef: ref(new Map([['n.md', 'heading']])),
    realVaultUserDirtyRef: ref(new Set()), realVaultSaveInFlightRef: ref(new Set()),
    realVaultKeepEditingAfterConflictRef: ref(new Set()),
    pendingPatchNoteIdRef: ref(null), pendingPatchRef: ref({}),
    notesPaneDocumentCacheRef: ref(new Map()),
    realVaultDocumentSource: { openDocument: () => new Promise((resolve) => state.reads.push(resolve)) },
    noteFromKnowledgeDocument: (document) => document, noteTitle: () => 'n', t: (key) => key,
    setNotes: noop, setSelectedNoteId: noop, setSelectedNote: noop, setEditTitle: noop,
    setEditContent: (value) => state.applied.push(value), setSourceContentDraft: noop,
    setAutocomplete: noop, setAiPanelOpen: noop, setAiSuggestion: noop, setActiveEmptyTabId: noop,
    setStatus: noop, recheckAttachments: noop, syncNotesPaneDocumentAcrossPanes: noop,
    setRealVaultExternalConflict: (value) => { if (typeof value !== 'function') state.conflicts.push(value); },
    window: { dispatchEvent: noop, requestAnimationFrame: (run) => state.timers.push(run), setTimeout: (run) => state.timers.push(run) },
    CustomEvent: class {},
  };
  context.reloadCurrentRealVaultDocumentFromDisk = productionCallback('reloadCurrentRealVaultDocumentFromDisk', context);
  return {
    state, context,
    select: productionCallback('selectNote', context),
    check: productionCallback('checkCurrentRealVaultExternalChange', context),
    settleRead(index, content) { state.reads[index]({ id: 'n.md', title: 'n', contentText: content }); },
  };
}

test('a disk refresh superseding selection hydration still accepts the next external write', async () => {
  const f = fixture();
  const checking = f.check({ force: true, silent: true });
  await tick();
  const selecting = f.select('n.md', { syncGlobalTab: false });
  f.settleRead(0, 'heading\nimage');
  await tick();
  f.settleRead(1, 'heading');
  await selecting;
  f.settleRead(2, 'heading\nimage');
  await checking;
  const video = f.check({ force: true, silent: true });
  await tick();
  assert.equal(f.state.reads.length, 4, 'the superseded selection must not leave all future refreshes blocked');
  f.settleRead(3, 'heading\nimage\nvideo');
  await tick();
  f.settleRead(4, 'heading\nimage\nvideo');
  await video;
  assert.deepEqual(f.state.applied, ['heading\nimage', 'heading\nimage\nvideo']);
});

test('an observed change during an external read is drained after that read', async () => {
  const f = fixture();
  const first = f.check({ force: true, silent: true });
  await tick();
  const second = f.check({ force: true, silent: true });
  f.settleRead(0, 'heading');
  await tick();
  assert.equal(f.state.reads.length, 2, 'a new index version cannot be consumed while its read is discarded');
  f.settleRead(1, 'heading\nvideo');
  await tick();
  f.settleRead(2, 'heading\nvideo');
  await Promise.all([first, second]);
  assert.deepEqual(f.state.applied, ['heading\nvideo']);
});

test('a late read from a replaced source session cannot adopt its content as the new baseline', async () => {
  const f = fixture();
  const check = f.check({ force: true, silent: true });
  await tick();
  f.state.source = { vaultId: 'A' };
  f.settleRead(0, 'old session content');
  await tick();
  assert.equal(f.state.reads.length, 1, 'the old check must not start another read bound to the replacement session');
  await check;
  assert.deepEqual(f.state.applied, []);
});

test('a hydration owner cannot be released by an older completion', async () => {
  const reads = new NoteDocumentReadCoordinator();
  const old = reads.beginHydration('n.md');
  const current = reads.beginHydration('n.md');
  old();
  assert.equal(reads.isHydrating('n.md'), true);
  let calls = 0;
  const check = reads.requestExternalCheck(async () => { calls += 1; });
  await tick();
  assert.equal(calls, 0);
  current();
  await check;
  assert.equal(calls, 1);
  assert.equal(reads.isHydrating('n.md'), false);
});

test('an old watcher read cannot conflict with a save completed during that read', async () => {
  const f = fixture();
  const checking = f.check({ force: true });
  await tick();
  f.context.realVaultSavedContentRef.current.set('n.md', 'saved new text');
  f.context.realVaultLatestContentRef.current.set('n.md', 'saved new text');
  f.settleRead(0, 'heading');
  await checking;
  assert.deepEqual(f.state.applied, []);
  assert.deepEqual(f.state.conflicts, []);
  assert.equal(f.state.reads.length, 1);
});

test('typing while an external read is pending preserves the draft and reports the conflict', async () => {
  const f = fixture();
  const checking = f.check({ force: true, silent: true });
  await tick();
  f.context.realVaultUserDirtyRef.current.add('n.md');
  f.context.realVaultLatestContentRef.current.set('n.md', 'my unsaved draft');
  f.settleRead(0, 'external video');
  await checking;
  assert.deepEqual(f.state.applied, []);
  assert.equal(f.state.reads.length, 1);
  assert.equal(f.state.conflicts[0].noteId, 'n.md');
  assert.equal(f.context.realVaultLatestContentRef.current.get('n.md'), 'my unsaved draft');
});

test('typing or replacing the session during readback cannot update the editor baseline', async () => {
  for (const change of ['typing', 'session']) {
    const f = fixture();
    const checking = f.check({ force: true, silent: true });
    await tick();
    f.settleRead(0, 'external video');
    await tick();
    if (change === 'typing') f.context.realVaultLatestContentRef.current.set('n.md', 'late draft');
    else f.state.source = { vaultId: 'A' };
    f.settleRead(1, 'external video');
    await checking;
    assert.deepEqual(f.state.applied, []);
    assert.equal(f.context.realVaultSavedContentRef.current.get('n.md'), 'heading');
  }
});

test('refresh bursts keep one active read and only the latest trailing observation', async () => {
  const reads = new NoteDocumentReadCoordinator();
  const calls = [];
  let complete;
  const first = reads.requestExternalCheck(() => new Promise((resolve) => { calls.push('first'); complete = resolve; }));
  await tick();
  const old = reads.requestExternalCheck(async () => { calls.push('superseded'); });
  const current = reads.requestExternalCheck(async () => { calls.push('latest'); });
  assert.deepEqual(calls, ['first']);
  complete();
  await Promise.all([first, old, current]);
  assert.deepEqual(calls, ['first', 'latest']);
  await reads.requestExternalCheck(async () => { calls.push('next'); });
  assert.deepEqual(calls, ['first', 'latest', 'next']);
});

test('detaching a source drops its waiting observation and frees hydration for the next source', async () => {
  const reads = new NoteDocumentReadCoordinator();
  const old = reads.beginHydration('n.md');
  const calls = [];
  const pending = reads.requestExternalCheck(async () => { calls.push('old source'); });
  await tick();
  reads.cancelPending();
  await pending;
  const current = reads.beginHydration('n.md');
  old();
  assert.equal(reads.isHydrating('n.md'), true);
  current();
  await reads.requestExternalCheck(async () => { calls.push('new source'); });
  assert.deepEqual(calls, ['new source']);
});
