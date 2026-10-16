import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { knowledgeCommittedPaths, readKnowledgeCommittedCheckpoint, readKnowledgeMobileEditing } from '../src/core/services/knowledgeLiveSync.ts';
import { activateKnowledgeWritesForVault, clearActiveKnowledgeSource, readActiveKnowledgeWriteSource } from '../src/core/services/knowledgeSource.ts';
import { activateBackendCurrentKnowledgeUiSource, createActiveKnowledgeUiClient, deactivateKnowledgeUiSource, ensureActiveKnowledgeUiSource, knowledgeDocumentNoteId, parseKnowledgeDocumentNoteId } from '../src/core/services/knowledge.ts';
import { getVaultAttachmentWorkflow } from '../src/core/services/vaultAttachments.ts';
import { KnowledgeStore, loadKnowledgeStoreData } from '../src/core/services/knowledgeStore.ts';

async function productionEditingObserver() {
  const sourceText = (await readFile(new URL('../src/features/notes/NotesPage.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = sourceText.indexOf('  useEffect(() => {\n    const noteId = selectedNoteId;');
  const ending = '  }, [currentVault?.id, selectedNoteId, knowledgeStorageMode]);';
  const end = sourceText.indexOf(ending, start);
  const helperStart = sourceText.indexOf('function isRealVaultNoteId(');
  const helperEnd = sourceText.indexOf('function realVaultParentPath(', helperStart);
  assert(start >= 0 && end > start && helperStart >= 0 && helperEnd > helperStart,
    'exercise the actual NotesPage observer and UI ID helpers, not a copied controller');
  const helpers = new Function('REAL_VAULT_NOTE_PREFIX',
    stripTypeScriptTypes(sourceText.slice(helperStart, helperEnd))
    + '\nreturn { isRealVaultNoteId, realVaultRelativePathFromNoteId };')('real-vault:');
  return { helpers, run: new Function('useEffect', 'selectedNoteId', 'knowledgeStorageMode', 'currentVault',
    'readActiveKnowledgeWriteSource', 'setMobileEditingNoteId', 'readKnowledgeMobileEditing',
    'document', 'setInterval', 'clearInterval', 'isRealVaultNoteId', 'realVaultRelativePathFromNoteId',
    'knowledgeDocumentNoteId', 'parseKnowledgeDocumentNoteId', sourceText.slice(start, end + ending.length)) };
}

test('normal real-vault NotesPage IDs reach the actual editing reader without borrowing another vault', async () => {
  const { helpers, run } = await productionEditingObserver();
  const originalWindow = globalThis.window;
  const originalIsTauri = (globalThis as any).isTauri;
  const editingCalls: any[] = [];
  let editing = true;
  let dispose = () => {};
  let tick = async () => {};
  let visible: string | null = null;
  Object.assign(globalThis, { isTauri:true, window:{ dispatchEvent:() => {}, __TAURI_INTERNALS__:{
    invoke:async (command: string, args: any) => {
      if (command === 'knowledge_deactivate_ui_source') return;
      if (command === 'knowledge_activate_ui_source') return { vaultId:'editing-vault', sourceEpoch:11 };
      if (command === 'knowledge_companion_editing_status') { editingCalls.push(args); return { mobileEditing:editing }; }
      throw Error('unexpected IPC ' + command);
    },
  } } });
  const mount = async (noteId: string, vaultId = 'editing-vault') => {
    dispose();
    run((effect: () => (() => void)) => { dispose = effect() || (() => {}); }, noteId, 'real-vault', { id:vaultId },
      readActiveKnowledgeWriteSource, (value: string | null) => { visible = value; }, readKnowledgeMobileEditing,
      { hidden:false, addEventListener:() => {}, removeEventListener:() => {} },
      (check: () => Promise<void>) => { tick = check; return 1; }, () => {},
      helpers.isRealVaultNoteId, helpers.realVaultRelativePathFromNoteId, knowledgeDocumentNoteId, parseKnowledgeDocumentNoteId);
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    await deactivateKnowledgeUiSource();
    activateKnowledgeWritesForVault({ mode:'real-vault', vaultId:'editing-vault', rootPath:'C:/editing-fixture' });
    const noteId = 'real-vault:notes/手机.md';
    await mount(noteId);
    assert.equal(visible, noteId, 'a true native receipt must appear on the normal selected UI note');
    assert.deepEqual(editingCalls, [{ documentRef:{ vaultId:'editing-vault', relativePath:'notes/手机.md' }, sourceEpoch:11 }]);
    editing = false;
    await tick();
    assert.equal(visible, null, 'Done or background false receipt clears the advisory without writing content');
    editing = true;
    await tick();
    assert.equal(visible, noteId);
    const beforeRejected = editingCalls.length;
    await mount(noteId, 'other-vault');
    assert.equal(visible, null);
    assert.equal(editingCalls.length, beforeRejected, 'same relative path in another displayed Vault is not borrowed');
    for (const path of ['../n.md', '/n.md', 'C:/n.md', '.luckyray/n.md', 'n.png']) {
      await mount('real-vault:' + path);
      assert.equal(visible, null, path);
      assert.equal(editingCalls.length, beforeRejected, 'hostile UI paths never reach native editing IPC');
    }
    const canonical = knowledgeDocumentNoteId({ vaultId:'editing-vault', relativePath:'notes/手机.md' });
    await mount(canonical);
    assert.equal(visible, canonical, 'existing canonical callers remain supported');
  } finally {
    dispose();
    await deactivateKnowledgeUiSource(); clearActiveKnowledgeSource();
    Object.assign(globalThis, { window:originalWindow, isTauri:originalIsTauri });
  }
});

test('committed wake rejects another vault and hostile paths without borrowing file authority', () => {
  assert.deepEqual(knowledgeCommittedPaths({ vaultId: 'A', relativePaths: ['notes/甲.md', 'notes/甲.md'] }, 'A'), ['notes/甲.md']);
  assert.equal(knowledgeCommittedPaths({ vaultId: 'B', relativePaths: ['n.md'] }, 'A'), null);
  for (const path of ['/n.md', '../n.md', 'a/../n.md', 'C:/n.md', 'a\\n.md', '.luckyray/n.md', 'a//n.md', 'n.png']) {
    assert.equal(knowledgeCommittedPaths({ vaultId: 'A', relativePaths: [path] }, 'A'), null, path);
  }
  assert.equal(knowledgeCommittedPaths({ vaultId: 'A', relativePaths: [] }, 'A'), null);
});

test('production editing observer handles late source activation and retires same-vault late replies', async () => {
  const { helpers, run } = await productionEditingObserver();
  let owner: object | null = null;
  let tick: () => Promise<void> = async () => {};
  let dispose = () => {};
  let cleared = false;
  let visible: string | null = 'stale';
  const replies: Array<(value: boolean) => void> = [];
  run((run: () => (() => void)) => { dispose = run(); }, 'real-vault:n.md', 'real-vault', { id:'A' },
      () => owner, (value: string | null) => { visible = value; },
      () => new Promise<boolean>(resolve => replies.push(resolve)),
      { hidden:false, addEventListener:() => {}, removeEventListener:() => {} },
      (run: () => Promise<void>) => { tick = run; return 1; }, () => { cleared = true; },
      helpers.isRealVaultNoteId, helpers.realVaultRelativePathFromNoteId, knowledgeDocumentNoteId, parseKnowledgeDocumentNoteId);
  assert.equal(visible, null, 'source not activated yet never prevents future observation');
  owner = { vaultId:'A', session:1 };
  const old = tick();
  owner = { vaultId:'A', session:2 };
  replies.shift()!(true);
  await old;
  assert.equal(visible, null, 'a same-vault retired owner cannot leave old editing advice visible');
  const fresh = tick();
  replies.shift()!(true);
  await fresh;
  assert.equal(visible, 'real-vault:n.md', 'the replacement source is picked up without a note switch');
  const late = tick();
  dispose();
  visible = null;
  replies.shift()!(true);
  await late;
  assert.equal(visible, null, 'a retired note observer cannot update state');
  assert.equal(cleared, true);
});

test('five-second recovery checks a cheap marker, not an unchanged index, and retires on vault change', async () => {
  const original = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    document: globalThis.document, window: globalThis.window };
  let callback = async () => {};
  let period = 0;
  let cleared = false;
  const doc = { hidden: false };
  let marker: string | null = 'incarnation:0';
  let checks = 0;
  const store = new KnowledgeStore(undefined, undefined, undefined, async () => { checks++; return marker; });
  const internal = store as any;
  const reasons: string[] = [];
  try {
    Object.assign(globalThis, { document: doc, window: {},
      setInterval: (run: () => Promise<void>, delay: number) => { callback = run; period = delay; return 1; },
      clearInterval: () => { cleared = true; } });
    internal.snapshot = { ...store.getSnapshot(), vault: { id: 'A' }, status:'ready' };
    internal.invalidate = async ({ reason }: { reason: string }) => { reasons.push(reason); return store.getSnapshot(); };
    internal.startCommittedObservation({ id: 'A' }, 0);
    assert.equal(period, 5000);
    await callback();
    assert.deepEqual(reasons, ['knowledge-committed-fallback']);
    for (let i = 0; i < 120; i++) await callback();
    assert.equal(checks, 121);
    assert.equal(reasons.length, 1, 'ten virtual minutes unchanged cause no additional refresh');
    marker = 'incarnation:1';
    await callback();
    assert.equal(reasons.length, 2, 'lost native commit event recovered through marker');
    marker = 'replacement-process:0';
    await callback();
    assert.equal(reasons.length, 3, 'same-vault restarted instance is not baselined away');
    marker = 'replacement-source:0';
    await callback();
    assert.equal(reasons.length, 4, 'same-vault new source is rechecked');
    assert.deepEqual(internal.fileChanges.drain(), { observations: [], reconcileRequired: false }, 'a missing hint is no attachment change');
    doc.hidden = true;
    await callback();
    assert.equal(reasons.length, 4);
    doc.hidden = false;
    internal.snapshot = { ...store.getSnapshot(), vault: { id: 'B' } };
    await callback();
    assert.equal(reasons.length, 4);
    internal.stopVaultWatch();
    assert.equal(cleared, true);
    await new Promise(resolve => setImmediate(resolve));
  } finally { Object.assign(globalThis, original); }
});

test('actual store on a 10K-note fixture publishes nothing during 120 unchanged recovery checks', async (t) => {
  const vault = { id:'large-fixture', name:'Large', rootPath:'C:/isolated-fixture' };
  const documents = Array.from({ length:10000 }, (_, i) => ({ relativePath:`n-${i}.md`, fileName:`n-${i}.md`,
    title:`Note ${i}`, revision:`r${i}`, headings:[], wikiLinks:[], embeds:[], tags:[], frontmatterTags:[], inlineTags:[], plainText:'body', excerpt:'body', contentLength:4, modifiedAt:null, size:4 }));
  let version = 1;
  const index = () => ({ vaultId:vault.id, builtAt:'fixture', generation:1, version, stale:false,
    refreshError:null, changedPaths:[], removedPaths:[], errors:[], documents });
  const root = { kind:'folder', name:'Large', relativePath:'', absolutePath:vault.rootPath, mtime:null, size:0,
    children:documents.map(d => ({ kind:'file', name:d.fileName, relativePath:d.relativePath, absolutePath:`${vault.rootPath}/${d.relativePath}`, mtime:null, size:4 })) };
  const counts = { vaultIPC:0, treeIPC:0, indexIPC:0, checks:0, publications:0 };
  const bridge: any = { getCurrentNotesVault:async () => { counts.vaultIPC++; return vault; },
    listNotesVaultFiles:async () => { counts.treeIPC++; return root; } };
  let marker = 'source-1:process-1:0';
  let failLoad = false;
  const store = new KnowledgeStore(async (b) => {
    if (failLoad) throw new Error('temporary read failure');
    return loadKnowledgeStoreData(b, async () => { counts.indexIPC++; return index() as any; }, () => true);
  }, () => bridge, undefined, async () => { counts.checks++; return marker; });
  const internal = store as any;
  internal.ensureVaultWatch = () => {};
  const unsubscribe = store.subscribe(() => { counts.publications++; });
  await store.revalidate({ reason:'initial' });
  // Measure the removed unconditional path using the same production loader/store.
  const baseline = { ...counts };
  const oldStarted = performance.now();
  for (let i = 0; i < 12; i++) await store.revalidate({ reason:'old-unconditional-fallback' });
  t.diagnostic(`old fixture: 12 ticks, tree IPC=${counts.treeIPC-baseline.treeIPC}, full-index IPC=${counts.indexIPC-baseline.indexIPC}, snapshot publications=${counts.publications-baseline.publications}, elapsedMs=${(performance.now()-oldStarted).toFixed(2)}`);
  assert.equal(counts.treeIPC-baseline.treeIPC, 12);
  assert.equal(counts.indexIPC-baseline.indexIPC, 12);
  assert.equal(counts.publications-baseline.publications, 24);
  const original = { setInterval:globalThis.setInterval, clearInterval:globalThis.clearInterval,
    document:globalThis.document, window:globalThis.window };
  let tick = async () => {};
  try {
    Object.assign(globalThis, { document:{ hidden:false }, window:{},
      setInterval:(run:() => Promise<void>) => { tick = run; return 1; }, clearInterval:() => {} });
    internal.startCommittedObservation(vault, 0);
    await tick(); // Conservative initial baseline closes load/subscription race.
    const ready = { ...counts };
    const started = performance.now();
    for (let i = 0; i < 120; i++) await tick();
    assert.equal(counts.checks-ready.checks, 120);
    for (const key of ['treeIPC','indexIPC','vaultIPC','publications'] as const) assert.equal(counts[key]-ready[key], 0, key);
    t.diagnostic(`new fixture: 120 ticks, cheap checks=120, tree/full-index/vault IPC=0, snapshot publications=0, elapsedMs=${(performance.now()-started).toFixed(2)}`);
    marker = 'source-1:process-1:1'; version++;
    documents[0].revision = 'committed-without-event';
    await tick();
    assert.equal(store.getSnapshot().markdownIndex?.documents[0].revision, 'committed-without-event');
    assert.equal(counts.treeIPC-ready.treeIPC, 1, 'lost native event triggers existing authoritative load');
    marker = 'source-1:process-1:2'; failLoad = true;
    await tick();
    assert.equal(store.getSnapshot().status, 'error');
    failLoad = false;
    await tick();
    assert.equal(store.getSnapshot().status, 'ready', 'failed read cannot consume changed checkpoint');
    marker = 'source-2:process-1:2';
    await tick();
    assert.equal(counts.treeIPC-ready.treeIPC, 3, 'same-vault replacement source reconciles');
  } finally { internal.stopVaultWatch(); unsubscribe(); Object.assign(globalThis, original); }
});

test('actual checkpoint reader follows same-vault source replacement without repeat activation or attachment retirement', async () => {
  const originalWindow = globalThis.window;
  const originalIsTauri = (globalThis as any).isTauri;
  let epoch = 0;
  let activations = 0;
  let directRestores = 0;
  let nativeDirty = false;
  let nativeContext: string | null = null;
  let releaseRead: (() => void) | null = null;
  let holdRead = false;
  let holdRestore = false;
  let releaseRestore: (() => void) | null = null;
  const nonce = 'a'.repeat(32);
  const commands: string[] = [];
  Object.assign(globalThis, { isTauri:true, window:{ dispatchEvent:() => {}, __TAURI_INTERNALS__:{
    invoke:async (command: string, args: any) => {
      commands.push(command);
      if (command === 'knowledge_deactivate_ui_source') return;
      if (command === 'knowledge_activate_ui_source') {
        activations++; nativeDirty = false; nativeContext = null;
        return { vaultId:'reader-vault', sourceEpoch:++epoch };
      }
      if (command === 'knowledge_activate_current_ui_source') {
        directRestores++; nativeDirty = false; nativeContext = null;
        const result = { vaultId:'reader-vault', sourceEpoch:++epoch };
        if (holdRestore) { holdRestore = false; await new Promise<void>(resolve => { releaseRestore = resolve; }); }
        return result;
      }
      if (command === 'knowledge_companion_committed_checkpoint') {
        if (args.sourceEpoch !== epoch) throw Error('knowledge-source-inactive: retired epoch');
        const result = { vaultId:'reader-vault', checkpoint:`${nonce}:0` };
        if (holdRead) { holdRead = false; await new Promise<void>(resolve => { releaseRead = resolve; }); }
        return result;
      }
      if (command === 'knowledge_preview_attachment_conversion') return { files:[], issues:[], documentCount:0, copyBytes:0, backupBytes:0 };
      throw Error(`unexpected IPC ${command}`);
    },
  } } });
  try {
    await deactivateKnowledgeUiSource();
    activateKnowledgeWritesForVault({ mode:'real-vault', vaultId:'reader-vault', rootPath:'C:/reader-fixture' });
    assert.equal(await readKnowledgeCommittedCheckpoint('reader-vault'), `1:${nonce}:0`);
    nativeDirty = true; nativeContext = 'current-dirty-note';
    for (let i=0; i<100; i++) await readKnowledgeCommittedCheckpoint('reader-vault');
    assert.equal(activations, 1, 'healthy polling must not clear dirty/context with recurring activation');
    assert.equal(nativeDirty, true); assert.equal(nativeContext, 'current-dirty-note');
    holdRead = true;
    const old = readKnowledgeCommittedCheckpoint('reader-vault');
    while (!releaseRead) await new Promise(resolve => setImmediate(resolve));
    // Same-vault register/open retires native epoch and replaces actual source identity.
    epoch++;
    activateKnowledgeWritesForVault({ mode:'real-vault', vaultId:'reader-vault', rootPath:'C:/reader-fixture' });
    releaseRead!();
    assert.equal(await old, null, 'retired inflight owner cannot deliver its old marker');
    assert.equal(await readKnowledgeCommittedCheckpoint('reader-vault'), `3:${nonce}:0`);
    assert.equal(activations, 2, 'new owner activates once, not on every tick');
    nativeDirty = true; nativeContext = 'replacement-dirty-note';
    const workflow = getVaultAttachmentWorkflow('reader-vault');
    await workflow.collect(['n.md']);
    assert.equal(workflow.getSnapshot().phase, 'finished');
    assert.equal(directRestores, 0, 'attachment maintenance uses existing activation authority, not destructive direct restore');
    assert.equal(nativeDirty, true); assert.equal(nativeContext, 'replacement-dirty-note');
    assert.equal((await ensureActiveKnowledgeUiSource()).sourceEpoch, 3);
    for (let i=0; i<100; i++) assert.equal(await readKnowledgeCommittedCheckpoint('reader-vault'), `3:${nonce}:0`);
    assert.equal(activations, 2);
    const restored = await activateBackendCurrentKnowledgeUiSource();
    assert.equal(restored.sourceEpoch, 4);
    assert.equal(await readKnowledgeCommittedCheckpoint('reader-vault'), `4:${nonce}:0`);
    assert.equal(activations, 2, 'explicit restoration adopts actual epoch, not another activation');
    holdRestore = true;
    const lateRestore = activateBackendCurrentKnowledgeUiSource();
    const rejectedRestore = assert.rejects(lateRestore, /Knowledge source changed before restoration completed/);
    while (!releaseRestore) await new Promise(resolve => setImmediate(resolve));
    epoch++;
    activateKnowledgeWritesForVault({ mode:'real-vault', vaultId:'reader-vault', rootPath:'C:/reader-fixture' });
    const latestSource = readActiveKnowledgeWriteSource();
    releaseRestore!();
    await rejectedRestore;
    assert.equal(readActiveKnowledgeWriteSource(), latestSource, 'late restore never overwrites replacement owner');
    assert.equal(await readKnowledgeCommittedCheckpoint('reader-vault'), `7:${nonce}:0`);
    for (let i=0; i<100; i++) await readKnowledgeCommittedCheckpoint('reader-vault');
    assert.equal(activations, 3, 'replacement after late restore still activates only once');
    assert(!commands.includes('knowledge_refresh_index'));
    assert(!commands.includes('knowledge_index_snapshot'));
  } finally {
    await deactivateKnowledgeUiSource(); clearActiveKnowledgeSource();
    Object.assign(globalThis, { window:originalWindow, isTauri:originalIsTauri });
  }
});

test('actual activation client rejects same-vault retirement between ensure resolution and mutation continuation', async () => {
  let source = { mode:'real-vault' as const, vaultId:'continuation-vault' };
  let mutationChecks = 0;
  let armRetirement = false;
  let writes = 0;
  const client: any = { activateUiSource:async () => ({ vaultId:source.vaultId, sourceEpoch:1 }),
    deactivateUiSource:async () => {}, appendDocument:async () => { writes++; } };
  const ui = createActiveKnowledgeUiClient(client, () => {
    // requested, serialized-current, then final mutation check. Model a same-vault
    // newSession in the microtask gap without copying the production adapter.
    if (armRetirement && ++mutationChecks === 3) source = { ...source };
    return source;
  });
  await ui.ensureActive();
  armRetirement = true;
  await assert.rejects(ui.appendDocument({ vaultId:source.vaultId, relativePath:'n.md' }, 'must not write'), /active real Vault/);
  assert.equal(writes, 0);
});
