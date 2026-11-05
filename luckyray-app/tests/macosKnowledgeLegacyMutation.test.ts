import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { knowledgeDocumentNoteId } from "../src/core/services/knowledge.ts";
import { createKnowledgeLegacyBridgeAdapter, knowledgeFolderIdentity } from "../src/core/services/knowledgeLegacyBridge.ts";
import { clearActiveKnowledgeSource, setActiveKnowledgeSource } from "../src/core/services/knowledgeSource.ts";

const reference = { vaultId: "synthetic-vault", relativePath: "Note.md" };
const source = { mode: "real-vault" as const, vaultId: reference.vaultId, rootPath: "/synthetic" };
const snapshot = { documentRef: reference, title: "Note", relativePath: reference.relativePath,
  modifiedAt: null, size: 4, content: "text", revision: "a".repeat(64), fileIdentity: "1:2" };
const noteId = knowledgeDocumentNoteId(reference);
const folderId = knowledgeFolderIdentity(reference.vaultId, "Moved");

async function withPlatform(platform: string, work: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true });
  setActiveKnowledgeSource(source, true);
  try { await work(); }
  finally {
    clearActiveKnowledgeSource();
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete (globalThis as any).navigator;
  }
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const adapter = createKnowledgeLegacyBridgeAdapter({
    listDocuments: async () => [], readDocument: async () => snapshot,
    createDocument: async () => snapshot, replaceDocument: async (...args: unknown[]) => {
      calls.push(["replace", ...args]); return { document: snapshot };
    },
    moveDocument: async (...args: unknown[]) => { calls.push(["move", ...args]); return snapshot; },
    deleteDocument: async (...args: unknown[]) => { calls.push(["delete", ...args]); },
    indexSnapshot: async () => ({ documents: [] }), setDocumentTags: async () => ({ document: snapshot }),
    ...overrides,
  } as any);
  return { adapter, calls };
}

test("Mac legacy bridge forwards the observed file identity for move and delete", async () => withPlatform("MacIntel", async () => {
  const { adapter, calls } = fixture();
  await adapter.moveNoteToFolder({ noteId, folderId });
  await adapter.deleteNote(noteId);
  assert.deepEqual(calls, [
    ["move", reference, "Note", snapshot.revision, "Moved", snapshot.fileIdentity],
    ["delete", reference, snapshot.revision, snapshot.fileIdentity],
  ]);
}));

test("Mac legacy bridge stops a same-vault session switch during the actual read", async () => withPlatform("MacIntel", async () => {
  const { adapter, calls } = fixture({ readDocument: async () => {
    setActiveKnowledgeSource(source, true); return snapshot;
  } });
  await assert.rejects(adapter.deleteNote(noteId), /vault or document changed/i);
  assert.deepEqual(calls, []);
}));

test("Mac legacy bridge rejects missing identity and a read for another path", async () => withPlatform("MacIntel", async () => {
  const missing = fixture({ readDocument: async () => ({ ...snapshot, fileIdentity: undefined }) });
  await assert.rejects(missing.adapter.moveNoteToFolder({ noteId, folderId }), /reopen the note/i);
  assert.deepEqual(missing.calls, []);
  const wrong = fixture({ readDocument: async () => ({ ...snapshot, documentRef: { ...reference, relativePath: "Other.md" } }) });
  await assert.rejects(wrong.adapter.deleteNote(noteId), /vault or document changed/i);
  assert.deepEqual(wrong.calls, []);
}));

test("Mac legacy bridge does not save a moved draft after the vault session changes", async () => withPlatform("MacIntel", async () => {
  const { adapter, calls } = fixture({ moveDocument: async (...args: unknown[]) => {
    calls.push(["move", ...args]); setActiveKnowledgeSource(source, true); return snapshot;
  } });
  await assert.rejects(adapter.updateNote(noteId, { title: "Renamed", contentText: "changed" }), /vault changed/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "move");
}));

test("Windows legacy bridge retains its existing argument counts", async () => withPlatform("Win32", async () => {
  const { adapter, calls } = fixture();
  await adapter.moveNoteToFolder({ noteId, folderId });
  await adapter.deleteNote(noteId);
  assert.deepEqual(calls, [
    ["move", reference, "Note", snapshot.revision, "Moved"],
    ["delete", reference, snapshot.revision],
  ]);
}));

test("Mac native move and delete commands reject missing file identity before accessing the service", async () => {
  const native = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const name of ["knowledge_move_document", "knowledge_delete_document"]) {
    const start = native.indexOf(`fn ${name}(`), guard = native.indexOf("input.expected_file_identity", start);
    const service = native.indexOf("let service=knowledge_service()", start);
    assert(start >= 0 && guard > start && service > guard);
    assert(native.slice(start, guard).includes('#[cfg(target_os = "macos")]'));
  }
});
