const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
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
const prefix = "const importRealVaultDroppedPaths = useCallback(";
const start = source.indexOf(prefix) + prefix.length;
const code = esbuild.transformSync(
  "const callback = " +
    source.slice(start, source.indexOf("\n  }, [", start) + 4),
  { loader: "ts" },
).code;
function fixture(switchAt) {
  let owner = { vaultId: "A" };
  const calls = [];
  const finish = async (stage, value) => {
    calls.push(stage);
    if (stage === switchAt) {
      owner = { vaultId: "B" };
      owner = { vaultId: "A" }; // Same vault, new source session.
    }
    return value;
  };
  const result = { copiedCount: 1, failedCount: 0, errors: [] };
  const context = {
    currentVault: { id: "A" },
    bridge: {
      classifyDroppedPaths: () =>
        finish("classify", [
          { path: "n.md", isFile: true },
          { path: "folder", isDir: true },
        ]),
      importNotesVaultMarkdownFiles: () => finish("files", result),
      importNotesVaultMarkdownFolder: () => finish("folder", result),
    },
    readActiveKnowledgeWriteSource: () => owner,
    dedupeDroppedLocalPaths: (paths) => paths,
    normalizeVaultRelativePath: (path) => path,
    isMarkdownImportPath: (path) => path.endsWith(".md"),
    setStatus: (message) => calls.push("status:" + message),
    t: (key) => key,
    reportAttachmentImport: () => calls.push("notice"),
    loadRealVaultTree: () => finish("reload"),
    revealRealVaultImportTarget: () => calls.push("reveal"),
  };
  return {
    calls,
    run: new Function("context", `with(context){${code};return callback;}`)(
      context,
    ),
  };
}
for (const stage of ["classify", "files", "folder", "reload"]) {
  test(`drop source A→B→A at ${stage} stops subsequent requests and UI updates`, async () => {
    const { calls, run } = fixture(stage);
    await run(null, ["n.md", "folder"]);
    assert.equal(calls.at(-1), stage);
    assert.equal(calls.includes("reveal"), false);
  });
}
test("unchanged drop session completes both batches and reveals the import", async () => {
  const { calls, run } = fixture(null);
  await run(null, ["n.md", "folder"]);
  assert.deepEqual(
    calls.filter((call) =>
      ["classify", "files", "folder", "reload", "reveal"].includes(call),
    ),
    ["classify", "files", "folder", "reload", "reveal"],
  );
});
