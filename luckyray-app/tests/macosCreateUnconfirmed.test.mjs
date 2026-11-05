// Host-side callback test; it does not substitute for a Mac native run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { editorNotesStatusEnUS, editorNotesStatusZhCN } from "../src/core/i18n/notesStatusMessages.ts";

async function invokeCreate(code, messages) {
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
  const start = page.indexOf("  const createNote = useCallback(");
  const end = page.indexOf("  const openCreateDocumentDialog = useCallback(", start);
  assert(start >= 0 && end > start);
  const compiled = stripTypeScriptTypes(`${page.slice(start, end)}\n;createNote;`, { mode: "strip" });
  let calls = 0; let status = "";
  const context = {
    Error, useCallback: fn => fn, selectedFolderId: null,
    readActiveKnowledgeWriteSource: () => "synthetic-source",
    createKnowledgeDocument: async () => { calls++; throw Object.assign(new Error("synthetic failure"), { code }); },
    loadRealVaultTree: async () => {}, selectNote: async () => {},
    setEditorMode: () => {}, setNamingNoteId: () => {}, realVaultNoteId: value => value,
    setStatus: value => { status = value; }, t: key => messages[key] ?? key,
    console: { warn: () => {} },
  };
  const createNote = vm.runInNewContext(compiled, context);
  await createNote();
  return { calls, status };
}

test("unconfirmed creation tells the user to inspect the original vault without retrying", async () => {
  for (const messages of [editorNotesStatusZhCN, editorNotesStatusEnUS]) {
    const result = await invokeCreate("knowledge-create-unconfirmed", messages);
    assert.equal(result.calls, 1);
    assert.equal(result.status, messages["editor.notes.status.markdownCreateUnconfirmed"]);
  }
  assert.match(editorNotesStatusZhCN["editor.notes.status.markdownCreateUnconfirmed"], /检查原知识库/);
  assert.match(editorNotesStatusEnUS["editor.notes.status.markdownCreateUnconfirmed"], /Check the original vault before retrying/);
});

test("other create failures keep their existing display", async () => {
  const result = await invokeCreate("knowledge-other-failure", editorNotesStatusZhCN);
  assert.deepEqual(result, { calls: 1, status: "synthetic failure" });
});
