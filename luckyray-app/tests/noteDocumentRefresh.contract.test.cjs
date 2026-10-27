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
  const state = { source: { vaultId: 'A' }, reads: [], applied: [], conflicts: [], timers: [], status: '', conflict: null };
  const ref = (current) => ({ current });
  const noop = () => {};
  const context = {
    notesNativeViews: { hasFrozenViews: () => false },
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
    realVaultSaveCompletionRef: ref(new Map()), realVaultSaveEpochRef: ref(new Map()),
    realVaultKeepEditingAfterConflictRef: ref(new Set()),
    pendingPatchNoteIdRef: ref(null), pendingPatchRef: ref({}),
    notesPaneDocumentCacheRef: ref(new Map()),
    realVaultDocumentSource: { openDocument: () => new Promise((resolve) => state.reads.push(resolve)) },
    noteFromKnowledgeDocument: (document) => document, noteTitle: () => 'n', t: (key) => key,
    setNotes: noop, setSelectedNoteId: noop, setSelectedNote: noop, setEditTitle: noop,
    setEditContent: (value) => state.applied.push(value), setSourceContentDraft: noop,
    setAutocomplete: noop, setAiPanelOpen: noop, setAiSuggestion: noop, setActiveEmptyTabId: noop,
    setStatus: value => { state.status = typeof value === 'function' ? value(state.status) : value; }, recheckAttachments: noop, syncNotesPaneDocumentAcrossPanes: noop,
    setRealVaultExternalConflict: (value) => { state.conflict = typeof value === 'function' ? value(state.conflict) : value; if (typeof value !== 'function') state.conflicts.push(value); },
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

test('own write starting during a watcher read waits for ACK and rereads instead of reporting conflict', async () => {
  const f = fixture();
  f.context.realVaultUserDirtyRef.current.add('n.md');
  const checking = f.check({ force: true });
  await tick();
  let acknowledge;
  f.context.realVaultSaveEpochRef.current.set('n.md', 1);
  f.context.realVaultSaveCompletionRef.current.set('n.md', new Promise(resolve => { acknowledge = resolve; }));
  f.settleRead(0, 'own saved content');
  await tick();
  assert.equal(f.state.reads.length, 1);
  assert.deepEqual(f.state.conflicts, []);
  f.context.realVaultSavedContentRef.current.set('n.md', 'own saved content');
  f.context.realVaultSaveCompletionRef.current.delete('n.md');
  acknowledge();
  await tick();
  f.settleRead(1, 'own saved content');
  await checking;
  assert.deepEqual(f.state.conflicts, []);
  assert.deepEqual(f.state.applied, []);
});

test('a complete own write during a watcher read still invalidates that read; genuine later external edit is retained', async () => {
  const f = fixture();
  f.context.realVaultUserDirtyRef.current.add('n.md');
  const checking = f.check({ force: true });
  await tick();
  f.context.realVaultSaveEpochRef.current.set('n.md', 1);
  f.context.realVaultSavedContentRef.current.set('n.md', 'own saved content');
  f.settleRead(0, 'heading');
  await tick();
  assert.equal(f.state.reads.length, 2);
  f.settleRead(1, 'genuine external content');
  await checking;
  assert.equal(f.state.conflicts[0].noteId, 'n.md');
  assert.deepEqual(f.state.applied, []);
});

test('disk returning to baseline clears only the stale conflict message, preserving unrelated errors', async () => {
  for (const status of ['editor.notes.status.diskChanged', 'editor.notes.status.saveFailed']) {
    const f = fixture();
    f.state.status = status;
    f.state.conflict = { noteId: 'n.md' };
    const checking = f.check({ force: true });
    await tick();
    f.settleRead(0, 'heading');
    await checking;
    assert.equal(f.state.conflict, null);
    assert.equal(f.state.status, status.endsWith('diskChanged') ? '' : status);
  }
});

test('IME composition defers observed changes until commit without polling or losing the dirty conflict', async () => {
  const f = fixture();
  const reads = f.context.realVaultDocumentReadsRef.current;
  reads.setComposing('n.md', true);
  await f.check({ force: true });
  assert.equal(f.state.reads.length, 0);
  assert.equal(reads.setComposing('n.md', false), true);
  f.context.realVaultUserDirtyRef.current.add('n.md');
  const checking = f.check({ force: true });
  await tick();
  f.settleRead(0, 'external content');
  await checking;
  assert.equal(f.state.conflicts[0].noteId, 'n.md');
  assert.deepEqual(f.state.applied, []);
  reads.setComposing('n.md', true);
  assert.equal(reads.setComposing('n.md', false), false, 'ordinary IME commits do not add disk reads');
});

test('composition starting during either disk read cannot replace the editor value', async () => {
  for (const phase of ['watcher', 'reload']) {
    const f = fixture();
    const reads = f.context.realVaultDocumentReadsRef.current;
    const checking = f.check({ force: true });
    await tick();
    if (phase === 'reload') {
      f.settleRead(0, 'external content');
      await tick();
    }
    reads.setComposing('n.md', true);
    f.settleRead(phase === 'watcher' ? 0 : 1, 'external content');
    await checking;
    assert.deepEqual(f.state.applied, []);
    assert.equal(reads.setComposing('n.md', false), true);
    assert.equal(f.context.realVaultSavedContentRef.current.get('n.md'), 'heading');
  }
});

test('source teardown cancels a deferred IME read', () => {
  const reads = new NoteDocumentReadCoordinator();
  reads.setComposing('n.md', true);
  reads.deferIfComposing('n.md');
  reads.cancelPending();
  assert.equal(reads.setComposing('n.md', false), false);
});

test('TSF commit releases one deferred read after the editor publishes input, not on ordinary commits', async () => {
  const f = fixture();
  const reads = f.context.realVaultDocumentReadsRef.current;
  const observed = [];
  f.context.checkCurrentRealVaultExternalChange = async () => observed.push(f.context.realVaultLatestContentRef.current.get('n.md'));
  const finish = productionCallback('finishRealVaultComposition', f.context);
  reads.setComposing('n.md', true);
  reads.deferIfComposing('n.md');
  finish('n.md');
  assert.deepEqual(observed, []);
  f.context.realVaultLatestContentRef.current.set('n.md', 'committed Chinese');
  await tick();
  assert.deepEqual(observed, ['committed Chinese']);
  finish('n.md');
  await tick();
  assert.equal(observed.length, 1);
});

test('focused clean editor defers external replacement until blur even without composition events', async () => {
  const f = fixture();
  const reads = f.context.realVaultDocumentReadsRef.current;
  reads.setFocused('n.md', true);
  const checking = f.check({force:true});
  await tick();
  f.settleRead(0, 'external content');
  await checking;
  assert.deepEqual(f.state.applied, []);
  assert.equal(reads.setFocused('n.md', false), true);
  const blurred = f.check({force:true});
  await tick();
  f.settleRead(1, 'external content');
  await tick();
  f.settleRead(2, 'external content');
  await blurred;
  assert.deepEqual(f.state.applied, ['external content']);
});

test('focus arriving during reload protects the editor and dirty focused notes still report genuine conflict', async () => {
  const f = fixture();
  const checking = f.check({force:true});
  await tick();
  f.settleRead(0, 'external content');
  await tick();
  f.context.realVaultDocumentReadsRef.current.setFocused('n.md', true);
  f.settleRead(1, 'external content');
  await checking;
  assert.deepEqual(f.state.applied, []);
  f.context.realVaultUserDirtyRef.current.add('n.md');
  const dirty = f.check({force:true});
  await tick();
  f.settleRead(2, 'external content');
  await dirty;
  assert.equal(f.state.conflicts[0].noteId, 'n.md');
});
