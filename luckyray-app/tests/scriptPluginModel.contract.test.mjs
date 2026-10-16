import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/features/community/scriptPluginModel.ts", import.meta.url))],
  bundle: true, format: "esm", write: false,
  plugins: [{ name: "no-tauri", setup(b) { b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "transport", namespace: "fixture" })); b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const invoke=()=>Promise.reject(new Error('no-tauri'))" })); } }],
});
const model = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { describeScriptPackage, nextGrants, sameStrings, pluginChanged, scopeSignature, describeOutcomes, mergeFieldValues, filterByQuery, PICK_LIMITS } = model;

const entry = (overrides = {}, resource = {}) => ({
  package: {
    manifest: { schemaVersion: 1, id: "example.demo", name: "Demo", version: "1.0.0", type: "script", entry: "main.js", minHostVersion: "1.9.2", apiVersion: 1, requiredModules: ["materials"], optionalModules: ["knowledge"] },
    resource: { code: "", requiredPermissions: ["materials.read"], optionalPermissions: ["knowledge.create", "materials.read"], dataVersion: 1, contributions: [{ id: "run", label: "Run", kind: "command" }], ...resource },
  },
  enabled: false, digest: "d1", epoch: 3, grants: [], ...overrides,
});

test("status: consent needed until every required permission is granted, then disabled, then enabled", () => {
  assert.equal(describeScriptPackage(entry(), "1.9.2").status, "needs-consent");
  const granted = describeScriptPackage(entry({ grants: ["materials.read"] }), "1.9.2");
  assert.equal(granted.status, "disabled");
  assert.deepEqual(granted.missingRequired, []);
  assert.equal(describeScriptPackage(entry({ grants: ["materials.read"], enabled: true }), "1.9.2").status, "enabled");
});

test("status: incompatible host wins over consent, and optional never repeats a required permission", () => {
  const view = describeScriptPackage(entry({ grants: ["materials.read"], enabled: true }), "1.9.1");
  assert.equal(view.status, "incompatible");
  assert.equal(view.compatible, false);
  assert.deepEqual(view.optional, ["knowledge.create"]);
});

test("grants: required permissions are always saved, optional ones only when ticked", () => {
  const view = describeScriptPackage(entry(), "1.9.2");
  assert.deepEqual(nextGrants(view, []), ["materials.read"]);
  assert.deepEqual(nextGrants(view, ["knowledge.create", "materials.tags"]), ["materials.read", "knowledge.create"]);
  assert.equal(sameStrings(["a", "b"], ["b", "a"]), true);
  assert.equal(sameStrings(["a"], ["a", "a"]), false);
});

test("a view acted on must match the installed digest and epoch", () => {
  const view = describeScriptPackage(entry(), "1.9.2");
  assert.equal(pluginChanged(view, entry()), false);
  assert.equal(pluginChanged(view, entry({ digest: "d2" })), true);
  assert.equal(pluginChanged(view, entry({ epoch: 4 })), true);
  assert.equal(pluginChanged(view, undefined), true);
});

test("scope signature ignores order and the write toggle but tracks every object dimension", () => {
  const base = { materialIds: ["m1", "m2"], documents: [], canvasIds: [], allowCreate: false, writes: false };
  assert.equal(scopeSignature(base), scopeSignature({ ...base, materialIds: ["m2", "m1"] }));
  assert.equal(scopeSignature(base), scopeSignature({ ...base, writes: true }), "allowing writes keeps the preview valid");
  for (const change of [{ materialIds: ["m1"] }, { documents: ["n"] }, { canvasIds: ["c"] }, { allowCreate: true }]) {
    assert.notEqual(scopeSignature(base), scopeSignature({ ...base, ...change }), JSON.stringify(change));
  }
  assert.deepEqual(PICK_LIMITS, { materials: 32, notes: 32, canvases: 8 });
});

test("outcomes come from host response values, never from plugin text", () => {
  const views = describeOutcomes([
    { method: "knowledge.create", value: { documentRef: { vaultId: "v", relativePath: "notes/a.md" }, title: "A", content: "", revision: "1" }, exportPath: null },
    { method: "knowledge.insert", value: { document: { documentRef: { vaultId: "v", relativePath: "notes/b.md" }, title: "B" }, indexStale: false }, exportPath: null },
    { method: "materials.tags", value: { id: "m", name: "hero.png", tagIds: ["t1", "t2"] }, exportPath: null },
    { method: "canvas.export", value: { format: "svg", bytes: 1234, nodes: 5, edges: 4 }, exportPath: "C:/out/c.svg" },
    { method: "data.set", value: { schemaVersion: 1, revision: 2 }, exportPath: null },
    { method: "materials.list", value: [], exportPath: null },
  ]);
  assert.deepEqual(views.map(v => v.key), ["noteCreated", "noteInserted", "tagsAdded", "exported", "dataSaved"]);
  assert.deepEqual(views[0].documentRef, { vaultId: "v", relativePath: "notes/a.md" });
  assert.equal(views[1].params.title, "B");
  assert.deepEqual(views[2].params, { name: "hero.png", count: "2" });
  assert.deepEqual(views[3].params, { nodes: "5", edges: "4", bytes: "1234", path: "C:/out/c.svg" });
});

test("malformed host values degrade to safe text instead of throwing", () => {
  const [view] = describeOutcomes([{ method: "knowledge.create", value: "not-an-object", exportPath: null }]);
  assert.equal(view.key, "noteCreated");
  assert.equal(view.documentRef, null);
  assert.deepEqual(view.params, { title: "", path: "" });
});

test("theme re-render keeps user-edited fields and drops fields the plugin no longer returns", () => {
  const current = { name: "typed by user", other: "old" };
  const incoming = [{ id: "name", label: "Name", value: "plugin default" }, { id: "fresh", label: "F", value: "x" }];
  assert.deepEqual(mergeFieldValues(current, incoming, new Set(["name"])), { name: "typed by user", fresh: "x" });
  assert.deepEqual(mergeFieldValues(current, incoming, new Set()), { name: "plugin default", fresh: "x" });
  assert.deepEqual(mergeFieldValues(current, undefined, new Set(["name"])), {});
});

test("query filter is case-insensitive and capped", () => {
  const items = [{ name: "Hero.png" }, { name: "logo.svg" }, { name: "hero-2.png" }];
  assert.deepEqual(filterByQuery(items, "HERO", 10).map(i => i.name), ["Hero.png", "hero-2.png"]);
  assert.equal(filterByQuery(items, "", 2).length, 2);
});
