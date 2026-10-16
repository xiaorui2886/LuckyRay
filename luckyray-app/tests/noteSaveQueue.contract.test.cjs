const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
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
const prefix = "const savePatch = useCallback(";
const start = source.indexOf(prefix) + prefix.length;
const end = source.indexOf("\n  }, [", start) + 4;
const code = esbuild.transformSync(
  "const savePatch = " + source.slice(start, end),
  { loader: "ts" },
).code;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const draftStart = source.indexOf("class NotesNativeDraftSet extends");
const draftEnd = source.indexOf("class NotesNativeSaveSet extends", draftStart);
const draftCode = esbuild.transformSync(source.slice(draftStart, draftEnd), { loader: "ts" }).code;
function fixture() {
  const writes = [],
    indexRequests = [],
    completions = [],
    statuses = [];
  const source = {};
  let viewChanges = 0, dirtyChanges = 0;
  const views = { notifyViews: () => { viewChanges++; }, notifyDirty: () => { dirtyChanges++; } };
  const DraftSet = new Function("KnowledgeDraftSet", "notesNativeViews", `${draftCode};return NotesNativeDraftSet;`)(Set, views);
  const dirty = new DraftSet(["A", "B"]);
  dirtyChanges = 0;
  const context = {
    notesNativeViews: views,
    selectedNoteIdRef: { current: "A" },
    selectedNote: { contentText: "A1" },
    editContent: "A1",
    saveRequestRef: { current: 0 },
    realVaultDocumentReadsRef: { current: { isHydrating: () => false } },
    realVaultSaveInFlightRef: { current: new Set() },
    realVaultSaveCompletionRef: { current: new Map() },
    realVaultSavedContentRef: {
      current: new Map([
        ["A", "A0"],
        ["B", "B0"],
      ]),
    },
    realVaultLatestContentRef: {
      current: new Map([
        ["A", "A1"],
        ["B", "B1"],
      ]),
    },
    realVaultUserDirtyRef: { current: dirty },
    realVaultKeepEditingAfterConflictRef: { current: new Set() },
    pendingPatchNoteIdRef: { current: "B" },
    pendingPatchRef: { current: { contentText: "B1" } },
    saveTimerRef: { current: null },
    readActiveKnowledgeWriteSource: () => source,
    isRealVaultNoteId: () => true,
    realVaultRelativePathFromNoteId: (id) => id,
    setSaving: () => {},
    setStatus: (value) => statuses.push(value),
    setRealVaultExternalConflict: () => {},
    t: (value) => value,
    updateNoteLocal: () => {},
    refreshRealVaultMarkdownIndex: async () => {},
    knowledgeStore: { invalidate: async request => { indexRequests.push(request); } },
    noteFromKnowledgeDocument: (document) => document,
    writeRealVaultDocumentIfAllowed: (_, document, text) => {
      writes.push([document.id, text]);
      return new Promise((resolve, reject) =>
        completions.push({ resolve, reject, text }),
      );
    },
    window: { setTimeout, dispatchEvent: () => {} },
    clearTimeout,
    CustomEvent: class {},
  };
  const save = new Function(
    "context",
    `with(context){${code};return savePatch;}`,
  )(context);
  return { context, save, writes, completions, statuses, indexRequests, viewChanges: () => viewChanges, dirtyChanges: () => dirtyChanges };
}
test("explicit save of the acknowledged full text clears only that note's dirty flag and publishes it", async () => {
  const f = fixture();
  f.context.realVaultSavedContentRef.current.set("A", "A1\n");
  f.context.realVaultLatestContentRef.current.set("A", "A1\n");
  await f.save({ contentText: "A1\n" }, "A", "explicit-save");
  assert.equal(f.writes.length, 0, "No redundant write of identical saved content");
  assert.equal(f.context.realVaultUserDirtyRef.current.has("A"), false);
  assert.equal(f.context.realVaultUserDirtyRef.current.has("B"), true);
  assert.equal(f.dirtyChanges(), 1, "Existing dirty lifecycle publishes dirty -> clean");
  assert.equal(f.viewChanges(), 0, "An unchanged binding must not revoke coverage");
});
test("a late save drains only its note and preserves another note pending debounce", async () => {
  const f = fixture();
  const first = f.save({ contentText: "A1" }, "A");
  f.context.selectedNoteIdRef.current = "B";
  f.context.realVaultLatestContentRef.current.set("A", "A2");
  f.completions[0].resolve({ contentText: "A1" });
  await first;
  await tick();
  assert.deepEqual(f.writes, [
    ["A", "A1"],
    ["A", "A2"],
  ]);
  assert.equal(f.context.pendingPatchNoteIdRef.current, "B");
  assert.deepEqual(f.context.pendingPatchRef.current, { contentText: "B1" });
  f.completions[1].resolve({ contentText: "A2" });
  await tick();
  assert.equal(f.context.realVaultSavedContentRef.current.get("A"), "A2");
  assert(f.context.realVaultUserDirtyRef.current.has("B"));
  assert.deepEqual(f.indexRequests, [{reason:'notes-save',modifiedPaths:['A']},{reason:'notes-save',modifiedPaths:['A']}]);
});
test("failed writes retain the draft and permit explicit retry without a tight retry loop", async () => {
  const f = fixture();
  const first = f.save({ contentText: "A1" }, "A");
  f.completions[0].reject(new Error("fixture disk full"));
  await first;
  assert.equal(f.writes.length, 1);
  assert(f.context.realVaultUserDirtyRef.current.has("A"));
  assert(f.statuses.includes("editor.notes.status.saveFailed"));
  const retry = f.save({ contentText: "A1" }, "A", "explicit-save");
  f.completions[1].resolve({ contentText: "A1" });
  await retry;
  assert.equal(f.context.realVaultSavedContentRef.current.get("A"), "A1");
  assert(!f.context.realVaultUserDirtyRef.current.has("A"));
});
