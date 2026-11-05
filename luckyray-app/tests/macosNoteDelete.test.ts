// Adapter contracts only. Native retention and filesystem authority require Mac tests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createRealVaultDocumentSource } from "../src/features/notes/documentSource.ts";
import { createActiveKnowledgeUiClient, createKnowledgeClient } from "../src/core/services/knowledge.ts";

const vault = { id: "synthetic", name: "Synthetic", rootPath: "/synthetic/vault", mode: "vault-bound",
  createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
const snapshot = { documentRef: { vaultId: vault.id, relativePath: "Delete.md" }, title: "Delete",
  content: "synthetic", revision: "a".repeat(64), fileIdentity: "1:2", modifiedAt: null, size: 9 };

async function withPlatform<T>(platform: string, work: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true });
  try { return await work(); }
  finally { if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete (globalThis as any).navigator; }
}
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const activeSource = { mode: "real-vault", vaultId: vault.id };
  const documents = { read: async () => { calls.push("read"); return snapshot; },
    replace: async () => { throw new Error("unexpected save"); },
    delete: async (...args: unknown[]) => { calls.push(["retained-delete", ...args]); }, ...overrides };
  const bridge = { deleteNotesVaultMarkdownFile: async () => {
    calls.push("legacy-delete"); return { message: "deleted", relativePath: "Delete.md", absolutePath: "/synthetic/vault/Delete.md" };
  } };
  return { calls, source: createRealVaultDocumentSource({ vault, bridge, documents: documents as any, readSource: () => activeSource as any }) };
}

test("Mac deletes an unopened note through the revisioned retained transaction", async () => withPlatform("MacIntel", async () => {
  const { source, calls } = fixture();
  assert.equal((await source.deleteDocument("Delete.md")).ok, true);
  assert.deepEqual(calls, ["read", ["retained-delete", snapshot.documentRef, snapshot.revision, snapshot.fileIdentity]]);
}));

test("Mac keeps an explicit revision and inode together without a later read", async () => withPlatform("MacIntel", async () => {
  const { source, calls } = fixture();
  await source.deleteDocument({ relativePath: "Delete.md", vaultId: vault.id, revision: "old-revision", fileIdentity: "9:10" });
  assert.deepEqual(calls, [["retained-delete", snapshot.documentRef, "old-revision", "9:10"]]);
}));

test("Mac refuses missing identity, mismatched vault and unavailable protected deletion", async () => withPlatform("MacIntel", async () => {
  for (const [ref, overrides] of [
    [{ relativePath: "Delete.md", revision: "known" }, {}],
    [{ relativePath: "Delete.md", vaultId: "other" }, {}],
    ["Delete.md", { delete: undefined }],
  ] as const) {
    const { source, calls } = fixture(overrides);
    await assert.rejects(source.deleteDocument(ref));
    assert(!calls.includes("legacy-delete"));
    assert(!calls.some(call => Array.isArray(call) && call[0] === "retained-delete"));
  }
}));

test("a failed protected deletion never falls back to the legacy file removal", async () => withPlatform("MacIntel", async () => {
  const { source, calls } = fixture({ delete: async () => { throw new Error("identity changed"); } });
  await assert.rejects(source.deleteDocument("Delete.md"), /identity changed/);
  assert(!calls.includes("legacy-delete"));
}));

test("switching away and back to the same vault during the preflight read cancels deletion", async () => withPlatform("MacIntel", async () => {
  let active = { mode: "real-vault", vaultId: vault.id };
  let deletes = 0;
  const source = createRealVaultDocumentSource({ vault, bridge: null, readSource: () => active as any,
    documents: { read: async () => { active = { ...active }; return snapshot; },
      replace: async () => { throw new Error("unexpected save"); },
      delete: async () => { deletes++; } } as any });
  await assert.rejects(source.deleteDocument("Delete.md"), /vault changed/i);
  assert.equal(deletes, 0);
}));

test("switching away and back to the same vault during the preflight read cancels a move", async () => withPlatform("MacIntel", async () => {
  let active = { mode: "real-vault", vaultId: vault.id };
  let moves = 0;
  const source = createRealVaultDocumentSource({ vault, bridge: null, readSource: () => active as any,
    documents: { read: async () => { active = { ...active }; return snapshot; },
      replace: async () => { throw new Error("unexpected save"); },
      move: async () => { moves++; return snapshot; } } as any });
  await assert.rejects(source.moveDocument("Delete.md", "Moved"), /vault changed/i);
  assert.equal(moves, 0);
}));

test("a move rejects a preflight snapshot for another path", async () => withPlatform("MacIntel", async () => {
  let moves = 0;
  const active = { mode: "real-vault", vaultId: vault.id };
  const source = createRealVaultDocumentSource({ vault, bridge: null, readSource: () => active as any,
    documents: { read: async () => ({ ...snapshot, documentRef: { ...snapshot.documentRef, relativePath: "Other.md" } }),
      replace: async () => { throw new Error("unexpected save"); },
      move: async () => { moves++; return snapshot; } } as any });
  await assert.rejects(source.moveDocument("Delete.md", "Moved"), /does not match/i);
  assert.equal(moves, 0);
}));

test("Mac never falls back to the legacy move when protected move is unavailable", async () => withPlatform("MacIntel", async () => {
  let legacyMoves = 0;
  const source = createRealVaultDocumentSource({ vault,
    bridge: { moveNotesVaultMarkdownFile: async () => { legacyMoves++; throw new Error("must not run"); } },
    documents: { read: async () => snapshot, replace: async () => { throw new Error("unexpected save"); } } });
  await assert.rejects(source.moveDocument("Delete.md", "Moved"), /protected note move is unavailable/i);
  assert.equal(legacyMoves, 0);
}));

test("Mac fails closed on note and destination paths that the native service would reinterpret", async () => withPlatform("MacIntel", async () => {
  let reads = 0, moves = 0, deletes = 0;
  const active = { mode: "real-vault", vaultId: vault.id };
  const source = createRealVaultDocumentSource({ vault, bridge: null, readSource: () => active as any,
    documents: { read: async () => { reads++; return snapshot; }, replace: async () => { throw new Error("unexpected save"); },
      move: async () => { moves++; return snapshot; }, delete: async () => { deletes++; } } as any });
  for (const path of ["Folder\\Delete.md", " Folder/Delete.md"]) {
    await assert.rejects(source.moveDocument(path, "Moved"), /ambiguous/i);
    await assert.rejects(source.deleteDocument(path), /ambiguous/i);
  }
  for (const folder of ["New\\Folder", " New"]) await assert.rejects(source.moveDocument("Delete.md", folder), /ambiguous/i);
  assert.deepEqual({ reads, moves, deletes }, { reads: 0, moves: 0, deletes: 0 });
}));

test("Windows keeps using the existing deletion bridge", async () => withPlatform("Win32", async () => {
  const { source, calls } = fixture();
  assert.equal((await source.deleteDocument("Delete.md")).ok, true);
  assert.deepEqual(calls, ["legacy-delete"]);
}));

test("Windows keeps using the existing note move bridge", async () => withPlatform("Win32", async () => {
  const calls: unknown[] = [];
  const source = createRealVaultDocumentSource({ vault,
    bridge: { moveNotesVaultMarkdownFile: async input => {
      calls.push(input);
      return { name: "Delete.md", relativePath: "Moved/Delete.md", absolutePath: "C:\\vault\\Moved\\Delete.md",
        contentText: "synthetic", mtime: null, size: 9 };
    } },
    documents: { read: async () => snapshot, replace: async () => { throw new Error("unexpected save"); },
      move: async () => { throw new Error("Windows must use its original move bridge"); } } as any,
  });
  const moved = await source.moveDocument("Delete.md", "Moved");
  assert.deepEqual(calls, [{ vault, relativePath: "Delete.md", targetParentRelativePath: "Moved" }]);
  assert.equal(moved.relativePath, "Moved/Delete.md");
  assert.equal(moved.contentText, "synthetic");
  assert.equal(Object.hasOwn(moved, "fileIdentity"), false);
}));

test("delete command carries the exact source epoch and observed file identity", async () => {
  const calls: unknown[] = [];
  const client = createKnowledgeClient({ isTauri: () => true, preview: {} as any,
    invoke: async (name, args) => { calls.push({ name, args }); return undefined as any; } });
  await client.deleteDocument(snapshot.documentRef, snapshot.revision, 7, snapshot.fileIdentity);
  assert.deepEqual(calls, [{ name: "knowledge_delete_document", args: {
    sourceEpoch: 7, input: { documentRef: snapshot.documentRef, expectedRevision: snapshot.revision, expectedFileIdentity: snapshot.fileIdentity },
  } }]);
});

test("legacy move and delete commands keep their existing source epoch positions and payloads", async () => {
  const calls: unknown[] = [];
  const client = createKnowledgeClient({ isTauri: () => true, preview: {} as any,
    invoke: async (name, args) => { calls.push({ name, args }); return undefined as any; } });
  await client.moveDocument(snapshot.documentRef, "Delete", snapshot.revision, "Moved", 7);
  await client.deleteDocument(snapshot.documentRef, snapshot.revision, 7);
  assert.deepEqual(calls, [
    { name: "knowledge_move_document", args: { sourceEpoch: 7, input: {
      documentRef: snapshot.documentRef, title: "Delete", expectedRevision: snapshot.revision, parentRelativePath: "Moved",
    } } },
    { name: "knowledge_delete_document", args: { sourceEpoch: 7, input: {
      documentRef: snapshot.documentRef, expectedRevision: snapshot.revision,
    } } },
  ]);
});

test("Mac move command carries source epoch and file identity in their independent fields", async () => {
  const calls: unknown[] = [];
  const client = createKnowledgeClient({ isTauri: () => true, preview: {} as any,
    invoke: async (name, args) => { calls.push({ name, args }); return undefined as any; } });
  await client.moveDocument(snapshot.documentRef, "Delete", snapshot.revision, "Moved", 7, snapshot.fileIdentity);
  assert.deepEqual(calls, [{ name: "knowledge_move_document", args: { sourceEpoch: 7, input: {
    documentRef: snapshot.documentRef, title: "Delete", expectedRevision: snapshot.revision,
    parentRelativePath: "Moved", expectedFileIdentity: snapshot.fileIdentity,
  } } }]);
});

test("active Mac move forwards the observed inode with the newly activated epoch", async () => {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const source = { mode: "real-vault" as const, vaultId: vault.id, rootPath: vault.rootPath };
  const client = createKnowledgeClient({ isTauri: () => true, preview: {} as any,
    invoke: async (name, args) => {
      calls.push({ name, args });
      return (name === "knowledge_activate_ui_source" ? { vaultId: vault.id, sourceEpoch: 7 } : snapshot) as any;
    } });
  const active = createActiveKnowledgeUiClient(client, () => source);
  await active.moveDocument(snapshot.documentRef, "Delete", snapshot.revision, "Moved", snapshot.fileIdentity);
  assert.deepEqual(calls, [
    { name: "knowledge_activate_ui_source", args: { vaultId: vault.id } },
    { name: "knowledge_move_document", args: { sourceEpoch: 7, input: {
      documentRef: snapshot.documentRef, title: "Delete", expectedRevision: snapshot.revision,
      parentRelativePath: "Moved", expectedFileIdentity: snapshot.fileIdentity,
    } } },
  ]);
});

test("preview move and delete retain the old argument count without inode proof", async () => {
  const calls: unknown[][] = [];
  const client = createKnowledgeClient({ isTauri: () => false,
    invoke: async () => { throw new Error("unexpected native invoke"); },
    preview: { listDocuments: async () => [], moveDocument: async (...args: unknown[]) => {
      calls.push(args); return snapshot;
    }, deleteDocument: async (...args: unknown[]) => { calls.push(args); } } as any });
  await client.moveDocument(snapshot.documentRef, "Delete", snapshot.revision, "Moved", 7);
  await client.deleteDocument(snapshot.documentRef, snapshot.revision, 7);
  assert.deepEqual(calls, [[snapshot.documentRef, "Delete", snapshot.revision, "Moved"],
    [snapshot.documentRef, snapshot.revision]]);
});

const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
const nativeSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const legacyStart = nativeSource.indexOf("fn delete_notes_vault_markdown_file("), legacyEnd = nativeSource.indexOf("fn delete_notes_vault_empty_folder(", legacyStart);
assert(legacyStart >= 0 && legacyEnd > legacyStart);
const legacyDelete = nativeSource.slice(legacyStart, legacyEnd);
test("Mac legacy deletion is rejected before the old unlink; other platforms retain the existing handler", () => {
  assert.match(legacyDelete, /if cfg!\(target_os = "macos"\)\s*\{[\s\S]*?return Err\(/);
  assert(legacyDelete.indexOf('cfg!(target_os = "macos")') < legacyDelete.indexOf("std::fs::remove_file(&target)"));
});
const start = page.indexOf("  const deleteNote = useCallback("), end = page.indexOf("  const moveNote = useCallback(", start);
assert(start >= 0 && end > start);
const pageDelete = stripTypeScriptTypes(`${page.slice(start, end)}\n;deleteNote;`, { mode: "strip" });

function pageHarness(deleteDocument: (ref: unknown) => Promise<void>, withProof = true) {
  const events: string[] = [], active = { mode: "real-vault", vaultId: vault.id }, noteId = "real-vault:Delete.md";
  const state = { active, generation: 1, selected: noteId, dirty: false, frozen: false, requested: null as unknown };
  const view = { isFrozen: () => state.frozen, isDirty: () => state.dirty,
    freeze: () => { state.frozen = true; events.push("freeze"); },
    abort: async () => { state.frozen = false; events.push("abort"); } };
  const proof = { generation: 1, source: active, workspaceSourceId: "proof", revision: snapshot.revision,
    fileIdentity: snapshot.fileIdentity, content: snapshot.content };
  const context: any = { useCallback: (fn: unknown) => fn, isRealVaultNoteId: (id: string) => id.startsWith("real-vault:"),
    isMacPlatform: () => true, selectedNoteIdRef: { get current() { return state.selected; } },
    commitCurrentEditorDraftRef: { current: () => events.push("commit") },
    blockRealVaultDocumentOperationIfDirty: () => state.dirty,
    setConfirmDelete: () => events.push("confirm"), setStatus: (s: string) => events.push(`status:${s}`),
    currentVault: vault, vaultSessionRef: { current: { latest: () => state.generation,
      isCurrent: (generation: number, id?: string) => generation === state.generation && (!id || id === vault.id) } },
    readActiveKnowledgeWriteSource: () => state.active, realVaultSaveInFlightRef: { current: new Set() },
    realVaultMoveInFlightRef: { current: new Map() }, realVaultReadProofRef: { current: new Map(withProof ? [[noteId, proof]] : []) },
    notesNativeViews: { list: () => [{ viewId: "v", vaultId: vault.id, relativePath: "Delete.md", generation: 1 }], get: () => view },
    realVaultDocumentSource: { deleteDocument: async (ref: unknown) => { state.requested = ref; await deleteDocument(ref); } },
    realVaultRelativePathFromNoteId: (id: string) => id.slice("real-vault:".length),
    realVaultSavedContentRef: { current: new Map([[noteId, "saved"]]) }, realVaultLatestContentRef: { current: new Map([[noteId, "saved"]]) },
    realVaultUserDirtyRef: { current: new Set() }, realVaultKeepEditingAfterConflictRef: { current: new Set() },
    setRealVaultExternalConflict: () => events.push("conflict"), setNotes: () => events.push("notes"),
    setOpenTabs: () => events.push("tabs"), loadRealVaultTree: async () => events.push("tree"),
    showEmptyTab: () => events.push("empty"), createEmptyNoteTab: () => ({ id: "empty" }),
    bridge: null, loadNotes: () => {}, notes: [], selectNote: () => {}, selectedNoteId: noteId,
    t: (key: string) => key, console };
  return { state, events, view, context, run: vm.runInNewContext(pageDelete, context) as (note: { id: string }) => Promise<void> };
}

test("the real page freezes its matching view and releases it after protected deletion", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const h = pageHarness(async () => pending);
  const running = h.run({ id: "real-vault:Delete.md" });
  assert.equal(h.state.frozen, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.requested)), { relativePath: "Delete.md", vaultId: vault.id,
    revision: snapshot.revision, fileIdentity: snapshot.fileIdentity });
  finish(); await running;
  assert.equal(h.state.frozen, false);
  assert(h.events.includes("tree")); assert(h.events.includes("abort"));
});

test("a late deletion result cannot clear the same note in a newly switched vault session", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const h = pageHarness(async () => pending);
  const running = h.run({ id: "real-vault:Delete.md" });
  h.state.generation = 2; h.state.active = { ...h.state.active };
  finish(); await running;
  assert.equal(h.context.realVaultLatestContentRef.current.get("real-vault:Delete.md"), "saved");
  assert(!h.events.includes("notes")); assert(!h.events.includes("tree"));
  assert(h.events.includes("abort"));
});

test("a selected note without an observed inode is not deleted", async () => {
  const h = pageHarness(async () => { throw new Error("must not run"); }, false);
  await h.run({ id: "real-vault:Delete.md" });
  assert.equal(h.state.requested, null); assert.equal(h.state.frozen, false);
  assert(h.events.includes("status:editor.notes.status.reopenBeforeDelete"));
});

test("a selected note without a freezeable view is not deleted", async () => {
  const h = pageHarness(async () => { throw new Error("must not run"); });
  h.context.notesNativeViews.list = () => [];
  await h.run({ id: "real-vault:Delete.md" });
  assert.equal(h.state.requested, null);
  assert(h.events.includes("status:editor.notes.status.reopenBeforeDelete"));
});

test("input appearing while freezing a view cancels deletion and unlocks the view", async () => {
  const h = pageHarness(async () => { throw new Error("must not run"); });
  h.view.freeze = () => { h.state.frozen = true; h.state.dirty = true; h.events.push("freeze"); };
  await h.run({ id: "real-vault:Delete.md" });
  assert.equal(h.state.requested, null); assert.equal(h.state.frozen, false);
  assert(h.events.includes("abort"));
});
