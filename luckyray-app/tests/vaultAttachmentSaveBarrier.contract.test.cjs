const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  test = require("node:test");
const root = path.resolve(__dirname, "..");
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const source = fs.readFileSync(
  root + "/src/features/notes/NotesPage.tsx",
  "utf8",
);
function productionCallback(name) {
  const start =
    source.indexOf(`const ${name} = useCallback(`) +
    `const ${name} = useCallback(`.length;
  const end = source.indexOf("\n  }, [", start) + 4;
  const code = esbuild.transformSync(
    "const callback = " + source.slice(start, end),
    { loader: "ts" },
  ).code;
  return new Function("context", `with(context){${code};return callback;}`);
}
function fixture() {
  const state = {
    source: { vaultId: "A", rootPath: "root-A" },
    writes: [],
    filled: [],
    conflicts: [],
  };
  const context = {
    readActiveKnowledgeWriteSource: () => state.source,
    commitCurrentEditorDraftRef: { current: () => {} },
    realVaultNoteId: (path) => path,
    realVaultSaveCompletionRef: { current: new Map() },
    realVaultSaveInFlightRef: { current: new Set() },
    realVaultUserDirtyRef: { current: new Set(["n.md"]) },
    realVaultLatestContentRef: { current: new Map([["n.md", "draft"]]) },
    realVaultSavedContentRef: { current: new Map() },
    savePatch: async (patch, id) => {
      state.writes.push([id, patch.contentText]);
      context.realVaultUserDirtyRef.current.delete(id);
    },
    knowledgeStore: { invalidate: async () => ({ status: "ready" }) },
    realVaultDocumentSource: {
      openDocument: async () => ({ id: "n.md", contentText: "rewritten" }),
    },
    setRealVaultExternalConflict: (value) => state.conflicts.push(value),
    noteFromKnowledgeDocument: (value) => value,
    t: (value) => value,
    updateNoteLocal: (id, note) => state.filled.push([id, note.contentText]),
    syncNotesPaneDocumentAcrossPanes: () => {},
    selectedNoteIdRef: { current: null },
  };
  context.attachmentPathsAreDirty = (paths) =>
    paths.some(
      (path) =>
        context.realVaultUserDirtyRef.current.has(path) ||
        context.realVaultSaveInFlightRef.current.has(path),
    );
  return {
    state,
    context,
    save: productionCallback("saveAffectedAttachmentNotes")(context),
    refresh: productionCallback("refreshAffectedAttachmentNotes")(context),
  };
}
test("a failed index refresh blocks readback and can be retried without rewriting", async () => {
  const { state, context, refresh } = fixture();
  context.realVaultUserDirtyRef.current.clear();
  context.knowledgeStore.invalidate = async () => ({ status: "error" });
  await assert.rejects(refresh(["n.md"]), /索引暂未刷新/);
  assert.deepEqual(state.filled, []);
  context.knowledgeStore.invalidate = async () => ({ status: "ready" });
  await refresh(["n.md"]);
  assert.deepEqual(state.filled, [["n.md", "rewritten"]]);
  assert.deepEqual(state.writes, []);
});
test("barrier waits for the real save before reading and saving the latest draft", async () => {
  const { state, context, save } = fixture();
  let complete;
  context.realVaultSaveCompletionRef.current.set(
    "n.md",
    new Promise((resolve) => (complete = resolve)),
  );
  const operation = save(["n.md"]);
  await Promise.resolve();
  assert.deepEqual(state.writes, []);
  context.realVaultLatestContentRef.current.set("n.md", "newer draft");
  complete();
  await operation;
  assert.deepEqual(state.writes, [["n.md", "newer draft"]]);
});
test("A to B to A during a pending save never reads the new session draft", async () => {
  const { state, context, save } = fixture();
  let complete;
  context.realVaultSaveCompletionRef.current.set(
    "n.md",
    new Promise((resolve) => (complete = resolve)),
  );
  const operation = save(["n.md"]);
  state.source = { vaultId: "B" };
  state.source = { vaultId: "A", rootPath: "root-A" };
  context.realVaultLatestContentRef.current.set("n.md", "other session");
  complete();
  await assert.rejects(operation, /会话/);
  assert.deepEqual(state.writes, []);
});
test("save failure or typing during the save blocks reference execution", async () => {
  for (const scenario of ["failed", "typing"]) {
    const { context, save } = fixture();
    context.savePatch = async () => {
      if (scenario === "typing")
        context.realVaultLatestContentRef.current.set("n.md", "late typing");
    };
    await assert.rejects(save(["n.md"]), /尚未保存/);
  }
});
test("reference refresh never fills an old session or overwrites a late draft", async () => {
  for (const scenario of ["session", "typing"]) {
    const { state, context, refresh } = fixture();
    context.realVaultUserDirtyRef.current.clear();
    let complete;
    context.realVaultDocumentSource.openDocument = () =>
      new Promise((resolve) => (complete = resolve));
    const operation = refresh(["n.md"]);
    await Promise.resolve();
    await Promise.resolve();
    if (scenario === "session")
      state.source = { vaultId: "A", rootPath: "root-A" };
    else context.realVaultUserDirtyRef.current.add("n.md");
    complete({ id: "n.md", contentText: "old read" });
    await operation;
    assert.deepEqual(state.filled, []);
    if (scenario === "typing") assert.equal(state.conflicts.length, 1);
  }
});
