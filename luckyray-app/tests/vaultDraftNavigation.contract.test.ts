import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {NoteDocumentReadCoordinator} from '../src/features/notes/noteDocumentReadCoordinator';
import {createVaultSessionAuthority} from '../src/features/notes/vaultSessionBarrier';

// Execute the actual real-Vault navigation body with its existing authorities.
// No browser, rendered fixture, second draft store or user files are involved.
const source = readFileSync(new URL('../src/features/notes/NotesPage.tsx', import.meta.url), 'utf8');
const begin = source.indexOf('    if (knowledgeStorageMode === "real-vault" || isRealVaultNoteId(noteId))', source.indexOf('const selectNote = useCallback'));
const end = source.indexOf('    if (!bridge?.getNote) return;', begin);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const navigate = new AsyncFunction('context', `with(context) { ${source.slice(begin, end)} }`);
const changeStart = source.indexOf('    setEditContent(value);', source.indexOf('const handleContentChange = useCallback'));
const changeEnd = source.indexOf('  }, [scheduleActiveNoteContext', changeStart);
const changeContent = new Function('context', `with(context) { ${source.slice(changeStart, changeEnd)} }`);

function fixture() {
  const vaultSession=createVaultSessionAuthority();vaultSession.begin('fixture-vault');
  const state: Record<string, any> = {
    liveEditorRef:{current:null}, mediaViewportLinesRef:{current:new Map()},
    realVaultDocumentReadsRef:{current:new NoteDocumentReadCoordinator()},
    vaultSessionRef:{current:vaultSession}, prepareNoteMediaRef:{current:()=>{}},
    noteId: 'A', options: {}, knowledgeStorageMode: 'real-vault', selectedNoteId: 'B', activeEmptyTabId: null,
    realVaultLatestContentRef: { current: new Map([['A', 'unsaved draft']]) },
    realVaultSavedContentRef: { current: new Map([['A', 'baseline']]) },
    realVaultUserDirtyRef: { current: new Set(['A']) },
    realVaultSaveInFlightRef: { current: new Set() },
    realVaultKeepEditingAfterConflictRef: { current: new Set() },
    selectedNoteIdRef: { current: 'B' }, selectedNoteRef: { current: null },
    noteLoadRequestRef: { current: 0 }, relationRequestRef: { current: 0 },
    realVaultHydratingNoteIdRef: { current: null },
    pendingPatchNoteIdRef: { current: null }, pendingPatchRef: { current: {} },
    notesInlineCommittedContentRef: { current: null }, saveTimerRef: { current: null },
    updateNoteLocal: () => {}, scheduleActiveNoteContext: () => {}, updateEditorAutocomplete: () => {},
    normalizeRealVaultEditorContentForDirtyCompare: (text:string) => text,
    scheduleSave: () => { state.scheduled = true; },
    commitCurrentEditorDraftRef: { current: () => {} }, flushPendingSaveRef: { current: () => {} },
    openTabsRef: { current: [] },
    notes: [{id:'A', title:'A', contentText:'unsaved draft'}],
    realVaultDocumentSource: { openDocument: async () => ({id:'A',title:'A',contentText:'baseline'}) },
    realVaultRelativePathFromNoteId: (id: string) => id,
    realVaultNoteId: (id: string) => id, isRealVaultNoteId: () => true,
    noteFromKnowledgeDocument: (doc: unknown) => ({...(doc as object)}), noteTitle: () => 'A',
    nextOpenTabsForNote: () => [], createEmptyNoteTab: () => ({ id: 'empty' }), isEmptyNoteTab: () => false,
    window: { requestAnimationFrame: () => {}, setTimeout: () => {}, dispatchEvent: () => {} },
    CustomEvent: class {}, t: (key: string) => key,
    setEditContent: (value: string) => { state.displayed = value; },
    setSelectedNoteId: (id: string) => { state.selectedNoteId = id; },
    setRealVaultExternalConflict: (value: unknown) => { if (typeof value !== 'function') state.conflict = value; },
    console: {warn:()=>{}},
  };
  const proxy = new Proxy(state, { has: () => true, get(target, key) {
    if (key === Symbol.unscopables) return undefined;
    if (key in target) return target[key as string];
    if (typeof key === 'string' && key.startsWith('set')) return () => {};
    return Reflect.get(globalThis, key);
  }});
  return { state, run: () => navigate(proxy), type: (value: string) => { state.value = value; changeContent(proxy); } };
}

test('cold navigation after failed save preserves existing draft and dirty authority', async () => {
  const {state, run} = fixture();
  await run();
  assert.equal(state.displayed, 'unsaved draft');
  assert.equal(state.realVaultLatestContentRef.current.get('A'), 'unsaved draft');
  assert.equal(state.realVaultUserDirtyRef.current.has('A'), true);
});

test('external revision conflict preserves draft and baseline; failed reads do not delete it', async () => {
  const {state, run} = fixture();
  state.realVaultDocumentSource.openDocument = async () => ({id:'A',title:'A',contentText:'external'});
  await run();
  assert.equal(state.displayed, 'unsaved draft');
  assert.equal(state.realVaultSavedContentRef.current.get('A'), 'baseline');
  assert.equal(state.conflict?.noteId, 'A');
  state.realVaultDocumentSource.openDocument = async () => { throw new Error('unavailable'); };
  await run();
  assert.equal(state.realVaultLatestContentRef.current.get('A'), 'unsaved draft');
  assert.equal(state.realVaultUserDirtyRef.current.has('A'), true);
});

test('five intervening notes do not erase the evicted document draft', async () => {
  const {state, run} = fixture();
  for (const id of ['B','C','D','E','F']) {
    state.noteId = id;
    state.realVaultDocumentSource.openDocument = async () => ({id,title:id,contentText:`saved ${id}`});
    await run();
  }
  state.noteId = 'A';
  state.realVaultDocumentSource.openDocument = async () => ({id:'A',title:'A',contentText:'baseline'});
  await run();
  assert.equal(state.displayed, 'unsaved draft');
  assert.equal(state.realVaultUserDirtyRef.current.has('A'), true);
});

test('late disk response cannot overwrite newer edits or a superseding navigation', async () => {
  const {state, run} = fixture();
  let resolve!: (doc: unknown) => void;
  state.realVaultDocumentSource.openDocument = () => new Promise((done) => { resolve = done; });
  const pending = run();
  state.realVaultLatestContentRef.current.set('A', 'newer draft');
  resolve({id:'A',title:'A',contentText:'baseline'});
  await pending;
  assert.equal(state.displayed, 'newer draft');
  const stale = run();
  state.noteLoadRequestRef.current++;
  state.displayed = 'other Vault document';
  resolve({id:'A',title:'A',contentText:'stale disk'});
  await stale;
  assert.equal(state.displayed, 'other Vault document');
  assert.equal(state.realVaultLatestContentRef.current.get('A'), 'newer draft');
});

test('clean navigation accepts external content', async () => {
  const {state, run} = fixture();
  state.realVaultUserDirtyRef.current.clear();
  state.realVaultDocumentSource.openDocument = async () => ({id:'A',title:'A',contentText:'external clean'});
  await run();
  assert.equal(state.displayed, 'external clean');
  assert.equal(state.realVaultSavedContentRef.current.get('A'), 'external clean');
});

test('real input while draft disk verification is pending stays dirty and schedules save', async () => {
  const {state, run, type} = fixture();
  let resolve!: (doc: unknown) => void;
  state.realVaultDocumentSource.openDocument = () => new Promise((done) => { resolve = done; });
  const pending = run();
  type('typed while awaiting disk');
  assert.equal(state.realVaultUserDirtyRef.current.has('A'), true);
  assert.equal(state.scheduled, true);
  resolve({id:'A',title:'A',contentText:'baseline'});
  await pending;
  assert.equal(state.displayed, 'typed while awaiting disk');
});

test('a save completing during an earlier read does not roll back the committed draft', async () => {
  const {state, run} = fixture();
  let resolve!: (doc: unknown) => void;
  state.realVaultDocumentSource.openDocument = () => new Promise((done) => { resolve = done; });
  const pending = run();
  state.realVaultSavedContentRef.current.set('A', 'unsaved draft');
  state.realVaultUserDirtyRef.current.delete('A');
  resolve({id:'A',title:'A',contentText:'baseline'});
  await pending;
  assert.equal(state.displayed, 'unsaved draft');
  assert.equal(state.realVaultLatestContentRef.current.get('A'), 'unsaved draft');
});

test('missing index metadata and failed disk reads still display the owned draft', async () => {
  const {state, run}=fixture();state.notes=[];
  state.realVaultDocumentSource.openDocument=async()=>{throw new Error('file removed externally');};
  await run();
  assert.equal(state.displayed,'unsaved draft');
  assert.equal(state.selectedNoteRef.current.id,'A');
  assert.equal(state.realVaultUserDirtyRef.current.has('A'),true);
});
