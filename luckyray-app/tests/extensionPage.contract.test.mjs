// EXT-PAGE-R1 contract test: pure helpers for plugin page identity, routing
// keys, sidebar preferences and the session cache. Node-only, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");

const shellNav = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/app/shellNav.ts", import.meta.url))],
  bundle: true, format: "esm", write: false,
});
const nav = await import(`data:text/javascript;base64,${Buffer.from(shellNav.outputFiles[0].text).toString("base64")}`);

test("plugin page paths round-trip and reject malformed input", () => {
  const path = nav.pluginPagePath("example.page-desk", "board");
  assert.equal(path, "plugins/example.page-desk/board");
  assert.deepEqual(nav.parsePluginPagePath(path), { packageId: "example.page-desk", pageId: "board" });
  // ids needing escaping survive
  const odd = nav.pluginPagePath("a.b/c d", "x y");
  assert.deepEqual(nav.parsePluginPagePath(odd), { packageId: "a.b/c d", pageId: "x y" });
  assert.equal(nav.parsePluginPagePath("plugins/only-one"), null);
  assert.equal(nav.parsePluginPagePath("plugins/a/b/c"), null);
  assert.equal(nav.parsePluginPagePath("notes"), null);
  assert.equal(nav.isPluginPageKey("plugins/a/b"), true);
  assert.equal(nav.isPluginPageKey("plugins"), true);
  assert.equal(nav.isPluginPageKey("notes"), false);
});

test("nav stack keeps A/page1, B/page1 and A/page2 as distinct entries", () => {
  let state = nav.createNavStack("notes");
  state = nav.navPush(state, nav.pluginPagePath("pkgA", "page1"));
  state = nav.navPush(state, nav.pluginPagePath("pkgB", "page1"));
  state = nav.navPush(state, nav.pluginPagePath("pkgA", "page2"));
  assert.deepEqual(state.stack, ["notes", "plugins/pkgA/page1", "plugins/pkgB/page1", "plugins/pkgA/page2"]);
  const back1 = nav.navBack(state);
  assert.equal(back1.key, "plugins/pkgB/page1");
  const back2 = nav.navBack(back1.next);
  assert.equal(back2.key, "plugins/pkgA/page1"); // same package, other page — distinct entry
  const fwd = nav.navForward(back2.next);
  assert.equal(fwd.key, "plugins/pkgB/page1");
  assert.equal(nav.navBack(nav.createNavStack("notes")).key, null);
  // pushing the current key is a no-op (re-click on the open page)
  assert.equal(nav.navPush(state, "plugins/pkgA/page2"), state);
  // pushing after going back truncates the forward branch like a browser
  let branched = nav.navBack(state).next;
  branched = nav.navPush(branched, "community");
  assert.deepEqual(branched.stack, ["notes", "plugins/pkgA/page1", "plugins/pkgB/page1", "community"]);
});

const pluginPagesBundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/features/community/pluginPages.ts", import.meta.url))],
  bundle: true, format: "esm", write: false,
  plugins: [{
    name: "stub-settings", setup(build) {
      build.onResolve({ filter: /^\.\.\/\.\.\/core\/extensions\/packages$|^\.\.\/settings\/useSettings$|^\.\.\/\.\.\/app\/shellNav$/ }, (args) => {
        if (args.path.endsWith("packages")) return { path: "packages", namespace: "stub" };
        if (args.path.endsWith("useSettings")) return { path: "settings", namespace: "stub" };
        return { path: "shellnav", namespace: "stub" };
      });
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
        if (args.path === "packages") return { contents: "export const extensionPackages = { snapshot: () => ({ revision: 1, hostVersion: '1.9.2', packages: [] }), subscribe: () => () => {} }; export const packageCompatibility = () => ({ compatible: true }); export default extensionPackages;", loader: "js" };
        if (args.path === "settings") return { contents: `const store = new Map(); globalThis.window = globalThis; globalThis.dispatchEvent = globalThis.dispatchEvent || (() => {}); globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }; export const readSavedSettings = () => Object.fromEntries(store); export const writeSavedSettingsPatch = (values) => { for (const [k, v] of Object.entries(values)) store.set(k, v); const settings = readSavedSettings(); globalThis.dispatchEvent(new globalThis.CustomEvent("luckyray:settings-change", { detail: { settings } })); return settings; };`, loader: "js" };
        return { contents: "export function pluginPagePath(a,b){return 'plugins/'+encodeURIComponent(a)+'/'+encodeURIComponent(b);}", loader: "js" };
      });
    },
  }],
});
const pages = await import(`data:text/javascript;base64,${Buffer.from(pluginPagesBundle.outputFiles[0].text).toString("base64")}`);

const scriptEntry = (id, contributions, enabled = true, digest = `d-${id}`) => ({
  package: {
    manifest: { schemaVersion: 1, id, name: id, version: "1.0.0", type: "script", entry: "main.js", minHostVersion: "1.9.2", apiVersion: 1, requiredModules: [], optionalModules: [] },
    resource: { code: "//", requiredPermissions: [], optionalPermissions: [], dataVersion: 1, contributions },
  },
  enabled, digest, epoch: 1, grants: [],
});

test("collectPluginPages: enabled+compatible packages only, multi-page, same page id across packages stays distinct", () => {
  const list = pages.collectPluginPages([
    scriptEntry("pkgA", [{ id: "home", label: "A 首页", kind: "page" }, { id: "stats", label: "A 统计", kind: "page" }, { id: "run", label: "运行", kind: "command" }]),
    scriptEntry("pkgB", [{ id: "home", label: "B 首页", kind: "page" }]),
    scriptEntry("pkgC", [{ id: "home", label: "C 已停用", kind: "page" }], false),
    scriptEntry("pkgD", [{ id: "panel", label: "D 面板", kind: "panel" }]),
  ], "1.9.2");
  assert.deepEqual(list.map((page) => page.key), ["pkgA/home", "pkgA/stats", "pkgB/home"]);
  assert.deepEqual(list.map((page) => page.path), ["plugins/pkgA/home", "plugins/pkgA/stats", "plugins/pkgB/home"]);
  assert.equal(list[0].label, "A 首页");
});

test("sidebar preferences: default off, toggle persists as a primitive settings value, prune removes stale keys only", () => {
  assert.equal(pages.pageVisibleInSidebar("pkgA/home"), false);
  pages.writeSidebarPref("pkgA/home", true);
  pages.writeSidebarPref("pkgB/home", true);
  assert.equal(pages.pageVisibleInSidebar("pkgA/home"), true);
  const raw = pages.readSidebarPrefs();
  assert.deepEqual(raw, ["pkgA/home", "pkgB/home"]);
  pages.writeSidebarPref("pkgA/home", false);
  assert.deepEqual(pages.readSidebarPrefs(), ["pkgB/home"]);
  // prune against installed page KEYS (enabled or not — disable must keep prefs)
  const kept = pages.pruneSidebarPrefs(["pkgB/home"]);
  assert.deepEqual(kept, ["pkgB/home"]);
  const pruned = pages.pruneSidebarPrefs([]);
  assert.deepEqual(pruned, []);
  // disabled-but-installed pages must keep their preference
  pages.writeSidebarPref("pkgB/home", true);
  assert.deepEqual(pages.pruneSidebarPrefs(["pkgB/home"]), ["pkgB/home"]);
  assert.deepEqual(pages.readSidebarPrefs(), ["pkgB/home"]);
});

test("page session cache: restore only for the same build, LRU bounded, per-package drop", () => {
  pages.savePageSession("pkgA/home", { digest: "d1", epoch: 1, ui: { title: "看板", fields: [{ id: "note", label: "备注", value: "draft" }] }, fields: { note: "draft" }, edited: ["note"], materialIds: ["m1"], documents: [], canvasIds: [] });
  const restored = pages.restorePageSession("pkgA/home", "d1", 1);
  assert.equal(restored?.fields.note, "draft");
  assert.equal(restored?.ui?.title, "看板", "session carries the last rendered UI for instant redraw");
  assert.equal(pages.restorePageSession("pkgA/home", "d2", 1), null, "digest change invalidates");
  assert.equal(pages.restorePageSession("pkgA/home", "d1", 2), null, "epoch change invalidates");
  for (let i = 0; i < 10; i++) pages.savePageSession(`pkg/other-${i}`, { digest: "d", epoch: 1, ui: null, fields: {}, edited: [], materialIds: [], documents: [], canvasIds: [] });
  assert.equal(pages.restorePageSession("pkgA/home", "d1", 1), null, "LRU evicted the old entry");
  pages.savePageSession("pkgB/home", { digest: "d", epoch: 1, ui: null, fields: {}, edited: [], materialIds: [], documents: [], canvasIds: [] });
  pages.dropPageSessions("pkgB");
  assert.equal(pages.restorePageSession("pkgB/home", "d", 1), null);
});

test('visibility changes use stable page identities and preserve other preferences at the limit',()=>{
 const full=Array.from({length:64},(_,index)=>`pkg-${index}/home`);
 assert.deepEqual(pages.withSidebarPref(full,'pkg-5/home',false),full.filter(key=>key!=='pkg-5/home'));
 assert.equal(pages.withSidebarPref(full,'pkg-5/home',true).length,64);
 assert.throws(()=>pages.withSidebarPref(full,'new/home',true),/64/);
 const renamed=scriptEntry('pkg-a',[{id:'home',label:'Renamed',kind:'page'}]);
 assert.equal(pages.collectPluginPages([renamed],'1.9.2')[0].key,'pkg-a/home');
});
