// Production adapter/page contracts. Native filesystem and DOM acceptance are
// separately exercised by the Mac application runner at the same source SHA.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createRealVaultDocumentSource, KnowledgeFolderOperationError } from "../src/features/notes/documentSource.ts";
import { folderContainsPath, remapFolderPath, remapFolderRecord } from "../src/features/notes/macFolderRuntime.ts";
import { NotesPaneViews } from "../src/features/notes/notesPaneViews.ts";
import type { MacFolderClient, MacFolderMutationInput, MacFolderMutationResult } from "../src/core/services/macFolderMutations.ts";

const vault = { id: "folder-fixture", name: "Fixture", rootPath: "/synthetic/vault", mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
const snapshot = { documentRef: { vaultId: vault.id, relativePath: "Folder/Note.md" }, title: "Note", content: "saved text",
  revision: "a".repeat(64), fileIdentity: "1:3", workspaceSourceId: `note-source-v1:${"b".repeat(64)}`, modifiedAt: null, size: 10 };
const receipt = (input: MacFolderMutationInput): MacFolderMutationResult => ({ operationId: "op-fixture", operation: input.operation, state: "completed",
  oldRelativePath: input.relativePath, newRelativePath: input.operation === "delete" ? null : input.operation === "rename" ? input.newName! : `${input.targetParentRelativePath}/${input.relativePath}`, message: null });
async function mac<T>(work: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });
  try { return await work(); } finally { if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete (globalThis as any).navigator; }
}
function fixture(overrides: Partial<MacFolderClient> = {}) {
  const calls: unknown[] = [];
  let source = { mode: "real-vault" as const, vaultId: vault.id, rootPath: vault.rootPath }, epoch = 41;
  const folders: MacFolderClient = {
    prepare: async (sourceEpoch, relativePath) => { calls.push(["prepare", sourceEpoch, relativePath]); return "opaque-selection"; },
    mutate: async input => { calls.push(["mutate", input]); return receipt(input); },
    list: async sourceEpoch => { calls.push(["list", sourceEpoch]); return []; },
    restore: async (sourceEpoch, operationId) => { calls.push(["restore", sourceEpoch, operationId]); return {
      operationId, operation: "restore", state: "completed", oldRelativePath: "Empty", newRelativePath: "Empty", message: null }; },
    ...overrides,
  };
  const adapter = createRealVaultDocumentSource({ vault, readSource: () => source,
    ensureSource: async () => ({ vaultId: vault.id, sourceEpoch: epoch }), folders,
    bridge: { renameNotesVaultFolder: async () => { throw new Error("legacy rename must not run"); },
      moveNotesVaultFolder: async () => { throw new Error("legacy move must not run"); },
      deleteNotesVaultEmptyFolder: async () => { throw new Error("legacy delete must not run"); } },
    documents: { read: async () => snapshot, replace: async () => { throw new Error("old path write must not run"); } } });
  return { adapter, calls, folders, changeSource: () => { source = { ...source }; }, changeEpoch: () => { epoch++; } };
}

test("Mac folder confirmation requires an earlier object selection and consumes it once", async () => mac(async () => {
  const f = fixture();
  await assert.rejects(f.adapter.renameFolder("Folder", "Renamed"), /重新打开文件夹操作菜单/);
  assert.deepEqual(f.calls, []);
  await f.adapter.prepareFolderMutation!("Folder");
  const folder = await f.adapter.renameFolder("Folder", "Renamed");
  assert.equal(folder.relativePath, "Renamed");
  assert.deepEqual(f.calls, [["prepare", 41, "Folder"], ["mutate", { sourceEpoch: 41, relativePath: "Folder", operation: "rename", expectedSelection: "opaque-selection", newName: "Renamed" }]]);
  await assert.rejects(f.adapter.renameFolder("Folder", "Again"), /重新打开文件夹操作菜单/);
}));

test("Mac move and empty delete use the captured selection with the original active epoch", async () => mac(async () => {
  const f = fixture();
  await f.adapter.prepareFolderMutation!("Folder");
  assert.equal((await f.adapter.moveFolder("Folder", "Destination")).relativePath, "Destination/Folder");
  await f.adapter.prepareFolderMutation!("Empty");
  const deleted = await f.adapter.deleteFolder("Empty");
  assert.equal(deleted.code, "deleted");
  assert.equal((deleted.raw as MacFolderMutationResult).operationId, "op-fixture");
  assert.equal((f.calls[1] as any[])[1].expectedSelection, "opaque-selection");
  assert.equal((f.calls[3] as any[])[1].sourceEpoch, 41);
}));

test("a source or epoch change while confirmation is open cannot reuse its selection", async () => mac(async () => {
  for (const change of ["changeSource", "changeEpoch"] as const) {
    const f = fixture();
    await f.adapter.prepareFolderMutation!("Folder"); f[change]();
    await assert.rejects(f.adapter.renameFolder("Folder", "Renamed"));
    assert.equal(f.calls.length, 1);
  }
}));

test("a native object replacement rejection never falls back to legacy rename", async () => mac(async () => {
  const f = fixture({ mutate: async () => { throw new Error("knowledge-folder-selection-changed: captured object was replaced"); } });
  await f.adapter.prepareFolderMutation!("Folder");
  await assert.rejects(f.adapter.renameFolder("Folder", "Renamed"), /selection-changed/);
}));

test("interrupted native operation keeps its operation ID and invalidates cached old-path writes", async () => mac(async () => {
  const f = fixture({ mutate: async input => ({ ...receipt(input), state: "recovery-required", message: "Inspect recovery" }) });
  await f.adapter.openDocument("Folder/Note.md");
  await f.adapter.prepareFolderMutation!("Folder");
  await assert.rejects(f.adapter.renameFolder("Folder", "Renamed"), error => error instanceof KnowledgeFolderOperationError
    && error.code === "knowledge-folder-recovery-required" && error.result?.operationId === "op-fixture");
  await assert.rejects(f.adapter.saveDocument("Folder/Note.md", "draft"), /Open the document before saving/);
}));

test("a completion after source switch reports original-vault recovery without adopting its path", async () => mac(async () => {
  const f = fixture();
  f.folders.mutate = async input => { f.changeSource(); return receipt(input); };
  await f.adapter.prepareFolderMutation!("Folder");
  await assert.rejects(f.adapter.renameFolder("Folder", "Renamed"), error => error instanceof KnowledgeFolderOperationError
    && error.result?.state === "completed" && /原知识库/.test(error.message));
}));

test("late old-path document reads cannot install authority after a folder move", async () => mac(async () => {
  const pending = Promise.withResolvers<typeof snapshot>();
  const f = fixture(), active = { mode: "real-vault" as const, vaultId: vault.id, rootPath: vault.rootPath };
  const source = createRealVaultDocumentSource({ vault, bridge: null, folders: f.folders, readSource: () => active,
    ensureSource: async () => ({ vaultId: vault.id, sourceEpoch: 41 }),
    documents: { read: () => pending.promise, replace: async () => { throw new Error("must not write"); } } });
  const read = source.openDocument("Folder/Note.md");
  await source.prepareFolderMutation!("Folder"); await source.renameFolder("Folder", "Renamed"); pending.resolve(snapshot);
  await assert.rejects(read, /文件夹已变更/);
  await assert.rejects(source.saveDocument("Folder/Note.md", "draft"), /Open the document before saving/);
}));

test("recovery listing and restore use the current epoch and exact operation ID", async () => mac(async () => {
  const f = fixture(); await f.adapter.listFolderRecoveries!(); await f.adapter.restoreFolder!("saved-operation");
  assert.deepEqual(f.calls, [["list", 41], ["restore", 41, "saved-operation"]]);
}));

test("folder path mapping observes path components and preserves sibling identities", () => {
  assert(folderContainsPath("Folder", "Folder/Note.md"));
  assert(!folderContainsPath("Folder", "Folder-other/Note.md"));
  assert.equal(remapFolderPath("Folder/Nested/Note.md", "Folder", "Destination/Renamed"), "Destination/Renamed/Nested/Note.md");
  assert.equal(remapFolderPath("folder/Note.md", "Folder", "Renamed"), "folder/Note.md");
  assert.deepEqual(remapFolderRecord({ "Folder/a": "one", "Folder-b/a": "two" }, id => remapFolderPath(id, "Folder", "New")), { "New/a": "one", "Folder-b/a": "two" });
});

async function pageCallback(name: string, context: Record<string, unknown>) {
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
  const prefix = `  const ${name} = useCallback(`, start = page.indexOf(prefix);
  const blockEnd = page.indexOf("\n  }, [", start), expressionEnd = page.indexOf("\n  ), [", start);
  const expression = expressionEnd >= 0 && (blockEnd < 0 || expressionEnd < blockEnd), end = expression ? expressionEnd : blockEnd;
  assert(start >= 0 && end > start, name);
  const code = stripTypeScriptTypes(`(${page.slice(start + prefix.length, end)}\n  ${expression ? ")" : "}"})`, { mode: "strip" });
  return vm.runInNewContext(code, context);
}
function pageFixture() {
  let source = { mode: "real-vault", vaultId: vault.id, rootPath: vault.rootPath }, frozen = false;
  const oldId = "v:Folder/Note.md", newId = "v:Renamed/Note.md", events: any[] = [];
  const proof = { generation: 1, source, workspaceSourceId: snapshot.workspaceSourceId, fileIdentity: snapshot.fileIdentity, revision: snapshot.revision, content: snapshot.content };
  const context: any = {
    currentVault: vault, readActiveKnowledgeWriteSource: () => source,
    vaultSessionRef: { current: { latest: () => 1, isCurrent: (generation: number) => generation === 1 } },
    isRealVaultNoteId: (id: string) => id.startsWith("v:"), realVaultNoteId: (path: string) => `v:${path}`,
    realVaultRelativePathFromNoteId: (id: string) => id.slice(2), folderContainsPath, remapFolderPath,
    selectedNoteIdRef: { current: oldId }, selectedNoteRef: { current: { id: oldId, contentText: snapshot.content } },
    commitCurrentEditorDraftRef: { current: () => events.push("commit-draft") },
    realVaultFolderInFlightRef: { current: null }, realVaultFolderBlockedNotesRef: { current: new Set() },
    openTabsRef: { current: [{ id: oldId }] }, notesPaneTabs: { pane: [{ id: oldId }] }, notes: [{ id: oldId }],
    realVaultReadProofRef: { current: new Map([[oldId, proof]]) },
    realVaultSavedContentRef: { current: new Map([[oldId, snapshot.content]]) }, realVaultLatestContentRef: { current: new Map([[oldId, snapshot.content]]) },
    realVaultUserDirtyRef: { current: new Set() }, realVaultSaveInFlightRef: { current: new Set() }, realVaultMoveInFlightRef: { current: new Map() },
    pendingPatchNoteIdRef: { current: null }, pendingPatchRef: { current: {} },
    realVaultHasUnsavedChanges: (id: string) => context.realVaultUserDirtyRef.current.has(id),
    notesNativeViews: { notifyViews: () => {}, hasFrozenViews: () => frozen, list: () => [{ vaultId: vault.id, generation: 1, relativePath: "Folder/Note.md", viewId: "view-1" }],
      get: () => ({ isDirty: () => context.realVaultUserDirtyRef.current.has(oldId), isFrozen: () => frozen,
        freeze: () => { frozen = true; events.push("freeze"); }, abort: async () => { frozen = false; events.push("thaw"); } }) },
    noteLoadRequestRef: { current: 1 }, notesPaneLoadRequestRef: { current: new Map([["pane", 1]]) },
    setMacFolderBusy: (value: boolean) => events.push(["busy", value]), setMacFolderStage: (value: string) => events.push(["stage", value]),
    setMacFolderRecoveryMessage: (message: string) => events.push(["recovery", message]), setStatus: (message: string) => events.push(["status", message]),
    realVaultDocumentSource: { prepareFolderMutation: async () => events.push("prepare"),
      renameFolder: async () => { events.push("mutate"); return { id: "Renamed", relativePath: "Renamed" }; },
      moveFolder: async () => { events.push("mutate"); return { id: "Renamed", relativePath: "Renamed" }; },
      openDocument: async () => ({ id: "Renamed/Note.md", relativePath: "Renamed/Note.md", contentText: snapshot.content, title: "Note",
        fileIdentity: snapshot.fileIdentity, workspaceSourceId: snapshot.workspaceSourceId }) },
    flushSync: (fn: () => void) => fn(), rewriteMacFolderRuntimePaths: () => { events.push("remap"); context.selectedNoteIdRef.current = newId; return [newId]; },
    noteFromKnowledgeDocument: (document: any) => ({ ...document, id: `v:${document.relativePath}` }), noteTitle: (note: any) => note.title,
    updateNoteLocal: () => events.push("update-note"), notesPaneDocumentCacheRef: { current: new Map() }, syncNotesPaneDocumentAcrossPanes: () => events.push("update-panes"),
    setSelectedNote: () => {}, setEditTitle: () => {}, setEditContent: () => {}, setSourceContentDraft: () => {}, setRealVaultForceOpenFolderIds: () => {}, setSelectedFolderId: () => {},
    loadRealVaultTree: async () => events.push("tree"), recheckAttachments: () => events.push("attachments"), refreshMacFolderRecoveries: async () => events.push("recoveries"),
    KnowledgeFolderOperationError, t: (key: string) => key,
  };
  return { context, events, oldId, newId, isFrozen: () => frozen, changeSource: () => { source = { ...source }; } };
}

async function savePreparationFixture() {
  const f = pageFixture(), timers = new Map<number, () => void>(), writes: string[] = [];
  let sequence = 0;
  const acknowledged = (content: string) => ({ id: "Folder/Note.md", relativePath: "Folder/Note.md", title: "Note", contentText: content,
    revision: snapshot.revision, fileIdentity: snapshot.fileIdentity, workspaceSourceId: snapshot.workspaceSourceId });
  Object.assign(f.context, {
    isMacPlatform: () => true, realVaultExternalConflict: null, shouldPauseConflictAutosave: () => false,
    realVaultKeepEditingAfterConflictRef: { current: new Set() }, saveRequestRef: { current: 0 }, setSaving: () => {},
    realVaultDocumentReadsRef: { current: { isHydrating: () => false } }, selectedNote: { contentText: snapshot.content }, editContent: snapshot.content,
    realVaultSaveEpochRef: { current: new Map() }, realVaultSaveCompletionRef: { current: new Map() }, setRealVaultExternalConflict: () => {},
    knowledgeStore: { invalidate: async () => {} }, saveTimerRef: { current: null },
    setTimeout: (callback: () => void) => { const id = ++sequence; timers.set(id, callback); return id; }, clearTimeout: (id: number) => { timers.delete(id); },
    writeRealVaultDocumentIfAllowed: async (_reason: string, _document: unknown, content: string) => { writes.push(content); return acknowledged(content); },
    pageVisibleRef: { current: true }, resolveScopedShortcut: () => "knowledgeSave", editTitle: "Note",
    readActiveEditorValue: () => f.context.realVaultLatestContentRef.current.get(f.oldId) ?? snapshot.content,
    flushPendingSave: () => { throw new Error("The real-vault shortcut does not use the legacy flush branch"); },
    window: { dispatchEvent: () => {} }, CustomEvent: class { constructor(_type: string, _options: unknown) {} },
  });
  f.context.realVaultHasUnsavedChanges = await pageCallback("realVaultHasUnsavedChanges", f.context);
  f.context.retireAcknowledgedPendingSave = await pageCallback("retireAcknowledgedPendingSave", f.context);
  const save = await pageCallback("savePatch", f.context), saves: Promise<void>[] = [];
  f.context.savePatch = (...args: unknown[]) => { const promise = save(...args); saves.push(promise); return promise; };
  const schedule = await pageCallback("scheduleSave", f.context), prepare = await pageCallback("prepareMacFolderMutation", f.context);
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
  const end = page.indexOf("    const onBeforeUnload = () => flushPendingSave();");
  const start = page.lastIndexOf("    const onKeyDown = (event: KeyboardEvent) => {", end);
  assert(start >= 0 && end > start);
  const shortcut = vm.runInNewContext(stripTypeScriptTypes(`${page.slice(start, end)}\n;onKeyDown;`, { mode: "strip" }), f.context);
  const explicitSave = async () => {
    shortcut({ key: "s", metaKey: true, preventDefault() {} });
    await saves[saves.length - 1];
  };
  return { ...f, timers, writes, acknowledged, save, schedule, prepare, explicitSave };
}

test("Mac save acknowledgement retires its exact debounce slot before immediate folder preparation", async () => {
  const f = await savePreparationFixture(), content = `${snapshot.content}\nUnsaved folder draft preserved.\n`;
  f.schedule({ contentText: content });
  assert.equal(f.context.realVaultHasUnsavedChanges(f.oldId), true);
  await f.explicitSave();
  assert.deepEqual(f.writes, [content]); assert.equal(f.context.realVaultSavedContentRef.current.get(f.oldId), content);
  assert.equal(f.context.realVaultUserDirtyRef.current.has(f.oldId), false); assert.equal(f.context.realVaultSaveInFlightRef.current.has(f.oldId), false);
  assert.equal(f.context.pendingPatchNoteIdRef.current, null); assert.equal(Object.keys(f.context.pendingPatchRef.current).length, 0); assert.equal(f.timers.size, 0);
  await f.prepare("Folder"); assert(f.events.includes("prepare"));
});

test("Mac acknowledgement of already saved bytes retires the redundant queue without another write", async () => {
  const f = await savePreparationFixture(); f.schedule({ contentText: snapshot.content });
  await f.explicitSave();
  assert.deepEqual(f.writes, []); assert.equal(f.timers.size, 0); assert.equal(f.context.realVaultHasUnsavedChanges(f.oldId), false);
  await f.prepare("Folder"); assert(f.events.includes("prepare"));
});

test("Mac save acknowledgement preserves another note's slot and a title it did not acknowledge", async () => {
  for (const otherNote of [true, false]) {
    const f = await savePreparationFixture(), content = `${snapshot.content}\nSaved edit.\n`;
    f.schedule({ contentText: content }); f.context.realVaultUserDirtyRef.current.add(f.oldId);
    if (otherNote) { f.context.pendingPatchNoteIdRef.current = "v:Other/Note.md"; f.context.pendingPatchRef.current = { contentText: "other draft" }; }
    else f.context.pendingPatchRef.current.title = "Unacknowledged title";
    const pending = f.context.pendingPatchRef.current, owner = f.context.pendingPatchNoteIdRef.current;
    await f.save({ contentText: content, title: "Note" }, f.oldId, "explicit-save");
    assert.equal(f.context.pendingPatchRef.current, pending); assert.equal(f.context.pendingPatchNoteIdRef.current, owner); assert.equal(f.timers.size, 1);
    if (!otherNote) await assert.rejects(f.prepare("Folder"), /saveBeforeFileAction/);
  }
});

test("Mac save acknowledgement cannot clear newer input queued while its native write was pending", async () => {
  const f = await savePreparationFixture(), first = Promise.withResolvers<any>(), second = Promise.withResolvers<any>();
  const oldContent = `${snapshot.content}\nFirst edit.\n`, newContent = `${snapshot.content}\nNewer edit.\n`;
  let count = 0;
  f.context.writeRealVaultDocumentIfAllowed = () => ++count === 1 ? first.promise : second.promise;
  f.schedule({ contentText: oldContent }); f.context.realVaultUserDirtyRef.current.add(f.oldId);
  const saving = f.save({ contentText: oldContent }, f.oldId, "explicit-save");
  f.schedule({ contentText: newContent });
  first.resolve(f.acknowledged(oldContent)); await saving;
  assert.equal(f.context.pendingPatchRef.current.contentText, newContent); assert.equal(f.context.pendingPatchNoteIdRef.current, f.oldId);
  assert.equal(f.context.realVaultLatestContentRef.current.get(f.oldId), newContent); assert.equal(f.timers.size, 1);
  assert.equal(f.context.realVaultHasUnsavedChanges(f.oldId), true); await assert.rejects(f.prepare("Folder"), /saveBeforeFileAction/);
  const completion = f.context.realVaultSaveCompletionRef.current.get(f.oldId);
  assert(completion); second.resolve(f.acknowledged(newContent)); await completion;
  assert.equal(f.context.realVaultSavedContentRef.current.get(f.oldId), newContent); assert.equal(f.timers.size, 0);
  await f.prepare("Folder");
});

test("failed acknowledgements and mounted composition still block Mac folder preparation", async () => {
  const failed = await savePreparationFixture(), content = `${snapshot.content}\nDraft.\n`;
  failed.schedule({ contentText: content }); failed.context.writeRealVaultDocumentIfAllowed = async () => null;
  await failed.explicitSave();
  assert.equal(failed.context.pendingPatchRef.current.contentText, content); assert.equal(failed.timers.size, 1);
  await assert.rejects(failed.prepare("Folder"), /saveBeforeFileAction/);
  const composing = await savePreparationFixture(); composing.schedule({ contentText: content }); await composing.explicitSave();
  const view = composing.context.notesNativeViews.get();
  composing.context.notesNativeViews.get = () => ({ ...view, isDirty: () => true });
  await assert.rejects(composing.prepare("Folder"), /saveBeforeFileAction/);
  assert(!composing.events.includes("prepare"));
});

test("the Mac save acknowledgement change leaves the existing Windows debounce behavior unchanged", async () => {
  const f = await savePreparationFixture(); f.context.isMacPlatform = () => false;
  const content = `${snapshot.content}\nSaved edit.\n`; f.schedule({ contentText: content }); await f.explicitSave();
  assert.deepEqual(f.writes, [content]); assert.equal(f.context.pendingPatchRef.current.contentText, content); assert.equal(f.timers.size, 1);
});

test("the production preparation callback refuses drafts before showing a confirmation or issuing native prepare", async () => {
  const f = pageFixture(); f.context.realVaultUserDirtyRef.current.add(f.oldId);
  const prepare = await pageCallback("prepareMacFolderMutation", f.context);
  await assert.rejects(prepare("Folder"), /saveBeforeFileAction/);
  assert(!f.events.includes("prepare")); assert(f.context.realVaultUserDirtyRef.current.has(f.oldId));
  assert(f.events.some(event => Array.isArray(event) && event[0] === "stage" && event[1] === "blocked-draft"));
});

test("the production transaction freezes exact views, retires old authority and updates paths before reopening", async () => {
  const f = pageFixture(), pending = Promise.withResolvers<any>();
  f.context.realVaultDocumentSource.renameFolder = async () => { f.events.push("mutate"); return pending.promise; };
  const run = await pageCallback("runMacFolderOperation", f.context), completed = run("Folder", "rename", "Renamed");
  await Promise.resolve(); assert(f.isFrozen()); assert.equal(f.context.realVaultReadProofRef.current.has(f.oldId), false);
  assert(f.context.realVaultFolderInFlightRef.current);
  pending.resolve({ id: "Renamed", relativePath: "Renamed" }); await completed;
  assert(f.events.indexOf("freeze") < f.events.indexOf("mutate")); assert(f.events.indexOf("remap") < f.events.indexOf("update-panes"));
  assert(f.events.includes("tree")); assert(f.events.includes("attachments")); assert(f.events.includes("recoveries"));
  assert.equal(f.context.selectedNoteIdRef.current, f.newId); assert.equal(f.context.realVaultFolderInFlightRef.current, null); assert(!f.isFrozen());
});

test("the production transaction refuses an in-flight save without mutating or clearing the draft", async () => {
  const f = pageFixture(); f.context.realVaultSaveInFlightRef.current.add(f.oldId);
  const run = await pageCallback("runMacFolderOperation", f.context); await run("Folder", "rename", "Renamed");
  assert(!f.events.includes("mutate")); assert(!f.events.includes("freeze"));
  assert.equal(f.context.realVaultLatestContentRef.current.get(f.oldId), snapshot.content);
});

test("a source switch during the production transaction cannot remap the new vault UI", async () => {
  const f = pageFixture(); f.context.realVaultDocumentSource.renameFolder = async () => { f.changeSource(); return { id: "Renamed" }; };
  const run = await pageCallback("runMacFolderOperation", f.context); await run("Folder", "rename", "Renamed");
  assert(!f.events.includes("remap")); assert(!f.events.includes("tree")); assert(!f.isFrozen());
});

test("a child note replaced during a completed folder move cannot inherit the old editor write authority", async () => {
  const f = pageFixture(); f.context.realVaultDocumentSource.openDocument = async () => ({ relativePath: "Renamed/Note.md", fileIdentity: "9:9", workspaceSourceId: snapshot.workspaceSourceId });
  const run = await pageCallback("runMacFolderOperation", f.context); await run("Folder", "rename", "Renamed");
  assert(f.events.includes("remap")); assert(!f.events.includes("update-note"));
  assert(f.context.realVaultFolderBlockedNotesRef.current.has(f.newId)); assert(!f.context.realVaultReadProofRef.current.has(f.newId));
  assert(f.events.some(event => Array.isArray(event) && event[0] === "status" && event[1].includes("操作已完成")));
});

test("completed index warnings keep the committed path and remain visible without a retry mutation", async () => {
  const f = pageFixture();
  f.context.realVaultDocumentSource.renameFolder = async () => ({ id: "Renamed", folderOperation: { message: "附件索引待更新" } });
  const run = await pageCallback("runMacFolderOperation", f.context); await run("Folder", "rename", "Renamed");
  assert(f.events.includes("remap")); assert(!f.context.realVaultFolderBlockedNotesRef.current.size);
  assert(f.events.some(event => Array.isArray(event) && event[0] === "status" && event[1].includes("附件索引待更新")));
});

test("restoring a moved directory uses its current location for view retirement and remaps reopened documents", async () => {
  const f = pageFixture();
  f.context.realVaultDocumentSource.restoreFolder = async (id: string) => {
    f.events.push(["restore", id]);
    return { operationId: id, operation: "restore", state: "completed", oldRelativePath: "Folder", newRelativePath: "Renamed", message: null };
  };
  const run = await pageCallback("runMacFolderOperation", f.context); await run("Folder", "restore", "saved-operation");
  assert(f.events.includes("freeze")); assert(f.events.includes("remap")); assert(f.events.includes("update-panes"));
  assert.equal(f.context.selectedNoteIdRef.current, f.newId);
  assert(f.events.some(event => Array.isArray(event) && event[0] === "status" && event[1].includes("文件夹已恢复")));
});

test("the actual Mac path callback updates every open pane and runtime cache while preserving view identities", async () => {
  const oldId = "v:Folder/Nested/Note.md", nextId = "v:Destination/Renamed/Nested/Note.md", siblingId = "v:Folder-other/Note.md";
  const states: any = { openTabs: [{ id: oldId }, { id: siblingId }], notesPaneTabs: { first: [{ id: oldId }], second: [{ id: oldId }, { id: siblingId }] },
    notesPaneActiveTabs: { first: oldId, second: siblingId }, notesPaneDocuments: { first: { [oldId]: { contentText: "saved" } } },
    notesPaneAiStates: { first: { [oldId]: { suggestion: "preserved" } } }, notes: [{ id: oldId, folderId: "Folder/Nested" }, { id: siblingId, folderId: "Folder-other" }],
    selectedNote: { id: oldId, folderId: "Folder/Nested", contentText: "saved" }, selectedNoteId: oldId, namingNoteId: oldId,
    selectedFolderId: "Folder/Nested", realVaultForceOpenFolderIds: ["Folder/Nested", "Folder-other"], folderDocumentReveal: { documentId: oldId, nonce: 1 } };
  const ref = (value: any) => ({ current: value }), renameEvents: any[] = [], views = new NotesPaneViews();
  const firstView = views.get("first", oldId), secondView = views.get("second", oldId), siblingView = views.get("second", siblingId);
  const context: any = {
    isRealVaultNoteId: (id: string) => id.startsWith("v:"), realVaultNoteId: (path: string) => `v:${path}`,
    realVaultRelativePathFromNoteId: (id: string) => id.slice(2), realVaultParentPath: (path: string) => path.slice(0, path.lastIndexOf("/")),
    remapFolderPath, remapFolderRecord, notesPaneViewsRef: ref(views),
    realVaultSavedContentRef: ref(new Map([[oldId, "saved"]])), realVaultLatestContentRef: ref(new Map([[oldId, "saved"]])),
    realVaultUserDirtyRef: ref(new Set()), realVaultReadProofRef: ref(new Map([[oldId, { revision: "old-proof" }]])), realVaultFolderBlockedNotesRef: ref(new Set()),
    notesPaneDocumentCacheRef: ref(new Map([[oldId, { contentText: "saved" }]])), mediaViewportLinesRef: ref(new Map([[oldId, { from: 5, to: 9 }]])),
    notesPaneEditorSessionsRef: ref(new Map([[`first:${oldId}`, { undo: "preserved" }]])), notesPaneScrollPositionsRef: ref(new Map([[`second:${oldId}`, 170]])), notesPaneScrollRestoreKeyRef: ref("old"),
    liveEditorRef: ref({ renameDocument: (...args: any[]) => renameEvents.push(args) }),
    notesViewRefsRef: ref(new Map([[firstView, { noteId: oldId, live: ref({ renameDocument: (...args: any[]) => renameEvents.push(args) }) }]])),
    openTabsRef: ref(states.openTabs), selectedNoteRef: ref(states.selectedNote), selectedNoteIdRef: ref(oldId), notesNativeViews: { notifyViews: () => {} },
    moveRealVaultRuntimeEntry: (before: string, after: string) => {
      for (const key of ["realVaultSavedContentRef", "realVaultLatestContentRef"]) {
        const cache = context[key].current; if (cache.has(before)) { cache.set(after, cache.get(before)); cache.delete(before); }
      }
    },
  };
  for (const key of Object.keys(states)) context[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value: any) => { states[key] = typeof value === "function" ? value(states[key]) : value; };
  const rewrite = await pageCallback("rewriteMacFolderRuntimePaths", context);
  assert.deepEqual(Array.from(rewrite("Folder", "Destination/Renamed", [oldId, siblingId])), [nextId]);
  assert.equal(states.selectedNoteId, nextId); assert.equal(context.selectedNoteIdRef.current, nextId); assert.equal(context.selectedNoteRef.current.id, nextId);
  assert.equal(states.selectedFolderId, "Destination/Renamed/Nested"); assert.equal(states.folderDocumentReveal.documentId, nextId);
  assert.equal(states.notesPaneTabs.first[0].id, nextId); assert.equal(states.notesPaneTabs.second[0].id, nextId); assert.equal(states.notesPaneTabs.second[1].id, siblingId);
  assert.equal(states.notesPaneActiveTabs.first, nextId); assert.equal(states.notesPaneActiveTabs.second, siblingId);
  assert.equal(states.notesPaneDocuments.first[nextId].contentText, "saved"); assert.equal(states.notesPaneAiStates.first[nextId].suggestion, "preserved");
  assert.equal(context.realVaultReadProofRef.current.size, 0); assert.equal(context.realVaultSavedContentRef.current.get(nextId), "saved");
  assert.equal(context.notesPaneEditorSessionsRef.current.get(`first:${nextId}`).undo, "preserved");
  assert.equal(context.notesPaneScrollPositionsRef.current.get(`second:${nextId}`), 170); assert.equal(context.notesViewRefsRef.current.get(firstView).noteId, nextId);
  assert.equal(views.get("first", nextId), firstView); assert.equal(views.get("second", nextId), secondView); assert.equal(views.get("second", siblingId), siblingView);
  assert(renameEvents.some(event => event[0] === oldId && event[1] === nextId));
});

test("actual folder and note rename events confirm the typed name before any React effect", async () => {
  const tree = await readFile(new URL("../src/features/folders/FolderTree.tsx", import.meta.url), "utf8");
  const start = tree.indexOf("  const finishInlineRename = async ("), end = tree.indexOf("  const setFolderOpen = useCallback(", start);
  assert(start >= 0 && end > start);
  const code = stripTypeScriptTypes(`${tree.slice(start, end)}\n;({ renameInputProps });`, { mode: "strip" });
  for (const kind of ["folder", "document"]) {
    const original = { kind, id: "Folder", name: "Folder", originalName: "Folder" }, calls: unknown[] = [];
    const context = { inlineRenameRef: { current: original }, inlineInputRef: { current: null },
      // Do not simulate another render/effect. A real input and Enter (or blur)
      // may arrive before those queued updates have run.
      setInlineRename: () => {}, onRename: async (...args: unknown[]) => { calls.push(["folder", ...args]); },
      onRenameDocument: async (...args: unknown[]) => { calls.push(["document", ...args]); } };
    const { renameInputProps } = vm.runInNewContext(code, context);
    const input = renameInputProps(original);
    input.onChange({ currentTarget: { value: "Renamed" } });
    input.onKeyDown({ key: "Enter", preventDefault() {} });
    input.onBlur();
    await Promise.resolve();
    assert.deepEqual(calls, [[kind, "Folder", "Renamed"]]);
    assert.equal(context.inlineRenameRef.current, null);
  }
});

test("the actual snapshot projection retains folder views until path migration and rejects a late old-path tree", async () => {
  const source = { mode: "real-vault", vaultId: vault.id }, oldId = "v:Folder/Note.md", newId = "v:Renamed/Note.md", effects: string[] = [];
  const token = { source, generation: 1, relativePath: "Folder", uiPathsReady: false };
  let active = source;
  const context: any = {
    buildRealVaultUiTree: (tree: any[]) => ({ folders: [], notes: tree }), locale: "zh-CN", t: (key: string) => key,
    selectedNoteIdRef: { current: oldId }, realVaultFolderInFlightRef: { current: token }, readActiveKnowledgeWriteSource: () => active,
    vaultSessionRef: { current: { isCurrent: () => true } }, renamingNoteRef: { current: null },
    shouldRetainBlockedFolderDraft: () => false,
    readSavedNoteTabsState: () => null, filterSavedNoteTabs: () => null, openTabsRef: { current: [{ id: oldId, kind: "note" }] },
    isEmptyNoteTab: (tab: any) => tab?.kind === "empty", createEmptyNoteTab: () => ({ id: "empty", kind: "empty" }),
    setRealVaultTree: () => effects.push("tree"), setRealVaultMarkdownIndex: () => {}, setNotes: () => {}, setSelectedFolderId: () => {},
    setActiveEmptyTabId: () => {}, setSelectedNoteId: () => effects.push("clear-selection"), setSelectedNote: () => {},
    setEditTitle: () => {}, setEditContent: () => {}, setSourceContentDraft: () => {}, setOpenTabs: () => effects.push("tabs"),
  };
  const apply = await pageCallback("applyRealVaultStoreSnapshot", context);
  assert.equal(apply([{ id: newId }], null, vault.id), undefined);
  assert.deepEqual(effects, []); assert.equal(context.openTabsRef.current[0].id, oldId);
  token.uiPathsReady = true; context.selectedNoteIdRef.current = newId; context.openTabsRef.current = [{ id: newId, kind: "note" }];
  assert.equal(apply([{ id: oldId }], null, vault.id), undefined);
  assert.deepEqual(effects, []);
  assert(apply([{ id: newId }], null, vault.id)); assert.deepEqual(effects, ["tree", "tabs"]);
  effects.length = 0;
  assert(apply([{ id: "v:Other.md" }], null, vault.id, true));
  assert(effects.includes("tree")); assert(effects.includes("clear-selection"));
  effects.length = 0;
  context.selectedNoteIdRef.current = oldId; context.openTabsRef.current = [{ id: oldId, kind: "note" }];
  context.shouldRetainBlockedFolderDraft = (id: string) => id === oldId;
  let retainedNotes = [{ id: oldId, contentText: "unsaved text stays" }];
  context.setNotes = (value: any) => { retainedNotes = typeof value === "function" ? value(retainedNotes) : value; };
  assert(apply([{ id: newId }], null, vault.id, true));
  assert.equal(context.openTabsRef.current[0].id, oldId);
  assert.equal(retainedNotes.find(note => note.id === oldId)?.contentText, "unsaved text stays");
  assert(!effects.includes("clear-selection"));
  context.shouldRetainBlockedFolderDraft = () => false;
  effects.length = 0; token.uiPathsReady = false; active = { ...source };
  assert(apply([{ id: "v:Other.md" }], null, vault.id));
  assert(effects.includes("tree")); assert(effects.includes("clear-selection"));
});

test("the actual store observer defers the native removed event until the directory reply maps the UI", async () => {
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
  const start = page.indexOf("    const syncFromStore = () => {"), end = page.indexOf("\n    const unsubscribe = knowledgeStore.subscribe(syncFromStore);", start);
  assert(start >= 0 && end > start);
  const code = stripTypeScriptTypes(`${page.slice(start, end)}\n;syncFromStore;`, { mode: "strip" });
  const source = { mode: "real-vault", vaultId: vault.id }, oldId = "v:Folder/Note.md", newId = "v:Renamed/Note.md", calls: string[] = [];
  const snapshot = { status: "ready", mode: "real-vault", vault, version: 2, tree: [{ id: newId }],
    markdownIndex: { version: 2, changedPaths: ["Renamed/Note.md"], removedPaths: ["Folder/Note.md"] } };
  const context: any = {
    knowledgeStore: { getSnapshot: () => snapshot }, realVaultFolderInFlightRef: { current: { source, generation: 1, relativePath: "Folder", uiPathsReady: false } },
    readActiveKnowledgeWriteSource: () => source, vaultSessionRef: { current: { isCurrent: () => true } },
    knowledgeStorageMode: "real-vault", currentVault: vault, realVaultStoreVersionRef: { current: { vaultId: vault.id, snapshotVersion: 1, indexVersion: 1 } },
    selectedNoteIdRef: { current: oldId }, isRealVaultNoteId: (id: string) => id.startsWith("v:"), realVaultRelativePathFromNoteId: (id: string) => id.slice(2),
    normalizeVaultRelativePath: (path: string) => path, decideRealVaultIndexDelta: (input: any) => input.currentPath === "Folder/Note.md" ? "removed" : "none",
    applyRealVaultStoreSnapshot: () => calls.push("apply"), realVaultSavedContentRef: { current: new Map([[oldId, "saved"]]) },
    realVaultLatestContentRef: { current: new Map([[oldId, "saved"]]) }, realVaultUserDirtyRef: { current: new Set([oldId]) }, realVaultKeepEditingAfterConflictRef: { current: new Set() },
    setRealVaultExternalConflict: () => {}, setStatus: () => calls.push("status"), checkCurrentRealVaultExternalChange: () => calls.push("check"), t: (key: string) => key,
    shouldRetainBlockedFolderDraft: () => false,
  };
  const sync = vm.runInNewContext(code, context); sync();
  assert.deepEqual(calls, []); assert.equal(context.realVaultStoreVersionRef.current.snapshotVersion, 1);
  assert.equal(context.realVaultLatestContentRef.current.get(oldId), "saved"); assert(context.realVaultUserDirtyRef.current.has(oldId));
  context.realVaultFolderInFlightRef.current.uiPathsReady = true; context.selectedNoteIdRef.current = newId; sync();
  assert.deepEqual(calls, ["apply"]); assert.equal(context.realVaultStoreVersionRef.current.snapshotVersion, 2);
  calls.length = 0; context.realVaultFolderInFlightRef.current = null;
  context.realVaultStoreVersionRef.current.snapshotVersion = 1; context.selectedNoteIdRef.current = oldId;
  context.shouldRetainBlockedFolderDraft = () => true; sync();
  assert.deepEqual(calls, ["apply", "status"]);
  assert.equal(context.realVaultLatestContentRef.current.get(oldId), "saved"); assert(context.realVaultUserDirtyRef.current.has(oldId));
});

test("failed folder dispatch clears its gate and drains the deferred snapshot without retrying the mutation", async () => {
  for (const operation of ["rename", "restore"]) {
    const f = pageFixture(); let attempted = 0;
    const reject = async () => { attempted++; throw new Error("captured folder changed"); };
    f.context.realVaultDocumentSource.renameFolder = reject; f.context.realVaultDocumentSource.restoreFolder = reject;
    f.context.loadRealVaultTree = async (options: any) => {
      assert.equal(f.context.realVaultFolderInFlightRef.current, null); assert.equal(options.fresh, true); assert.equal(options.acceptFolderResult, true);
      assert.equal(options.cachedOnly, undefined); f.events.push("deferred-tree");
    };
    const run = await pageCallback("runMacFolderOperation", f.context); await run("Folder", operation, operation === "restore" ? "operation-id" : "Renamed");
    assert.equal(attempted, 1); assert.equal(f.context.realVaultFolderInFlightRef.current, null); assert(!f.isFrozen());
    assert(f.events.includes("deferred-tree")); assert(f.context.realVaultFolderBlockedNotesRef.current.has(f.oldId));
    assert.equal(f.context.realVaultLatestContentRef.current.get(f.oldId), snapshot.content);
  }
});
