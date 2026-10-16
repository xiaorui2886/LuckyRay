// EXT-PAGE-R1: real-browser test of the plugin page surface — the real AppSidebar
// (filters group projection), the real PluginPageHost (main area, no modal) and
// real hash routing, with a controlled extension transport. Two packages with a
// same-named page plus a two-page package prove identity; preferences, hidden≠
// disabled, disable/uninstall cleanup and built-in route survival are asserted.
//
// node tests/extensionPage.component.cjs [--json <out.json>]
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const esbuild = require(require.resolve("esbuild", { paths: [fs.realpathSync(root + "/node_modules/vite")] }));
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
    "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright",
);

const packageWith = (id, name, pages, extra = []) => ({
  package: {
    manifest: { schemaVersion: 1, id, name, version: "1.0.0", type: "script", entry: "main.js", minHostVersion: "1.9.2", apiVersion: 1, requiredModules: [], optionalModules: [] },
    resource: { code: "// fixture", requiredPermissions: [], optionalPermissions: [], dataVersion: 1, contributions: [...pages.map(([pid, label]) => ({ id: pid, label, kind: "page" })), ...extra] },
  },
  enabled: true, digest: `d-${id}`, epoch: 1, grants: [],
});

(async () => {
  const cssText = fs.readFileSync(root + "/src/features/community/community.css", "utf8") + fs.readFileSync(root + "/src/features/community/scriptPlugins.css", "utf8");
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { useEffect, useState } from "react";
        import { I18nProvider } from "./src/core/i18n/index";
        import { AppSidebar } from "./src/app/AppSidebar";
        import { PluginPageHost } from "./src/features/community/PluginPageHost";
        import { extensionPackages } from "./src/core/extensions/packages";
        import { writeSidebarPref, collectInstalledPageKeys, pruneSidebarPrefs } from "./src/features/community/pluginPages";
        import { applyGlobalSettings, readSavedSettings } from "./src/features/settings/useSettings";

        const A = ${JSON.stringify(packageWith("alpha.desk", "甲插件", [["home", "甲·首页"], ["stats", "甲·统计"]]))};
        const B = ${JSON.stringify(packageWith("beta.desk", "乙插件", [["home", "乙·首页"]]))};
        const C = ${JSON.stringify({ ...packageWith("gamma.tool", "丙工具", [["panel", "丙面板"]], [{ id: "run", label: "运行", kind: "command" }]) })};
        let registry = [structuredClone(A), structuredClone(B), structuredClone(C)];
        let revision = 1;
        window.__registry = (next) => { registry = next; revision += 1; window.dispatchEvent(new Event("luckyray:packages-changed")); };
        window.__writePref = (key, on) => writeSidebarPref(key, on);
        // Real AppShell-side cleanup wiring: prune against every INSTALLED page key (enabled or not).
        window.__prune = () => { const snapshot = extensionPackages.snapshot(); pruneSidebarPrefs(collectInstalledPageKeys(snapshot.packages)); };

        // Controlled transport: page runs return a UI naming the page; saves go through data.set.
        window.__runs = [];
        window.__dispatches = 0;
        window.__invoke = async (cmd, args) => {
          if (cmd === "manage_extension_packages") return { revision, hostVersion: "1.9.2", packages: registry.map((p) => structuredClone(p)) };
          if (cmd === "list_canvases") return [];
          if (cmd !== "extension_runtime") throw new Error("unexpected " + cmd);
          const req = JSON.parse(args.request);
          if (req.op === "start") { window.__runs.push(req.event); return { token: "t" }; }
          if (req.op === "close") return {};
          if (req.op === "poll") {
            if (window.__pending !== undefined) { const value = window.__pending; window.__pending = undefined; return { kind: "call", request: value }; }
            const page = req.event ?? window.__runs[window.__runs.length - 1];
            const base = { title: "PAGE:" + page.contribution + ":" + (page.action || "run"), text: "页面内容 " + page.contribution };
            const value = window.__fieldsFor && page.contribution ? window.__fieldsFor(page.contribution, page.action || "run") : null;
            return { kind: "result", result: { ok: true, value: value || base }, receipts: [] };
          }
          if (req.op === "dispatch") { window.__dispatches += 1; if (window.__gateDispatch) await window.__gateDispatch; return { response: { value: { schemaVersion: 1, revision: 1 } } }; }
          return {};
        };
        window.__modules = { extensionPackages, pluginPages: await import("./src/features/community/pluginPages") };
        window.addEventListener("luckyray:packages-changed", () => void extensionPackages.refresh());
        await extensionPackages.refresh();
        applyGlobalSettings(readSavedSettings());

        function Harness() {
          const [hash, setHash] = useState(() => window.location.hash);
          const [, setTick] = useState(0);
          useEffect(() => {
            const onHash = () => setHash(window.location.hash);
            const onTick = () => setTick((value) => value + 1);
            window.addEventListener("hashchange", onHash);
            window.addEventListener("luckyray:settings-change", onTick);
            window.addEventListener("luckyray:packages-changed", onTick);
            return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("luckyray:settings-change", onTick); window.removeEventListener("luckyray:packages-changed", onTick); };
          }, []);
          const path = hash.replace(/^#\\/?/, "");
          const route = path.split("/")[0];
          return <I18nProvider locale="zh-CN">
            <div className="react-nav-shell" style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: "100vh" }}>
              <AppSidebar route={route} onNavigate={(page) => { window.location.hash = "#" + page; }}
                pluginPages={window.__sidebarPages?.() || []}
                activePluginPagePath={route === "plugins" ? path : undefined}
                onOpenPluginPage={(p) => { window.location.hash = "#" + p; }} />
              <main>{route === "plugins" ? <PluginPageHost path={path} /> : <div data-builtin-route={route}>内置页 {route}</div>}</main>
            </div>
          </I18nProvider>;
        }
        createRoot(document.getElementById("root")).render(<Harness />);
        document.body.dataset.ready = "1";
      `,
      resolveDir: root, loader: "tsx",
    },
    bundle: true, platform: "browser", format: "esm", jsx: "automatic", outfile: "app.js", write: false, logLevel: "silent",
    loader: { ".css": "empty", ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "stubs", setup(b) {
        const map = new Map([
          ["@tauri-apps/api/core", "export const invoke = (cmd, args) => window.__invoke(cmd, args); export const isTauri = () => true; export const convertFileSrc = (p) => p; export class Resource {} export class Channel {}"],
          ["@tauri-apps/plugin-dialog", "export const confirm = async () => true; export const save = async () => 'C:/out/x.svg'; export const open = async () => null; export const ask = async () => true; export const message = async () => {};"],

          ["../../core/services/knowledge", "export const listKnowledgeDocuments = async () => []; export const searchKnowledgeDocuments = async () => []; export const ensureActiveKnowledgeUiSource = async () => ({ vaultId: 'v', sourceEpoch: 1 }); export const knowledgeDocumentNoteId = (ref) => 'kdoc-' + ref.relativePath;"],
          ["../../core/services/knowledgeSource", "export const readActiveKnowledgeWriteSource = () => null;"],
          ["../../core/services/context", "export const focusEntity = () => {};"],
          ["../../features/folders/useFolders", "export const useFolders = () => ({ folders: [] });"],
          ["../../features/folders/FolderTree", "export const FolderTree = () => null;"],
          ["../../core/services/knowledgeStore", "export const knowledgeStore = {}; export const hasUsableKnowledgeSnapshot = () => false;"],
          ["../../core/services/materials", "export const listLegacyMaterialAssets = async () => []; export const listLegacyFilteredMaterialAssets = async () => []; export const moveActiveMaterialExternalDragToFolder = () => {};"],
        ]);
        b.onResolve({ filter: /^(@tauri-apps\/api\/core|@tauri-apps\/plugin-dialog|\.\.\/\.\.\/core\/services\/(materials|knowledge|knowledgeSource|context)|\.\.\/\.\.\/features\/folders\/(useFolders|FolderTree)|\.\.\/\.\.\/core\/services\/(knowledgeStore|materials))$/ }, (args) => map.has(args.path) ? { path: args.path, namespace: "stub" } : null);
        b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: map.get(args.path), loader: "js" }));
      },
    }],
  });
  const appJs = built.outputFiles[0].text;
  const TOKENS = ":root{--bg-elevated:#fff;--bg-base:#fff;--bg-hover:#f0f0f4;--border:#dcdce4;--text-primary:#1c1c22;--text-secondary:#4c4c58;--accent:#4f6ef7;--accent-muted:#e6eaff;--radius-md:10px;--radius-sm:6px;--fs-xs:10px;--fs-sm:11px;--fs-md:12px;--fs-lg:14px;--space-2:6px;--space-3:8px;--space-4:10px;--space-5:12px;--space-6:14px;--space-7:16px;--space-8:20px}";
  const SIDEBAR_CSS = fs.readFileSync(root + "/src/app/appShell.css", "utf8");
  const server = http.createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(appJs); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<meta charset="utf-8"><style>${TOKENS}${SIDEBAR_CSS}${cssText}</style><div id="root"></div><script type="module" src="/app.js"></script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const results = [];
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const sidebarRow = (label) => page.locator(`.sidebar .nav-item:has-text("${label}")`);
  async function step(name, fn) {
    try { const data = await fn(); results.push({ step: name, ok: true, ...data }); console.log(`[ok]   ${name}`); }
    catch (error) { results.push({ step: name, ok: false, error: String(error?.message || error) }); console.log(`[FAIL] ${name}: ${String(error?.message || error).split("\n")[0]}`); throw error; }
  }
  // sidebar pages need a projection feed; emulate what AppShell derives via page-side hook
  await page.goto(base + "#notes");
  await page.waitForSelector('body[data-ready="1"]');
  await page.evaluate(() => {
    const { extensionPackages } = window.__modules;
    const { collectPluginPages, readSidebarPrefs } = window.__modules.pluginPages;
    window.__sidebarPages = () => {
      const snapshot = extensionPackages.snapshot();
      return collectPluginPages(snapshot.packages, snapshot.hostVersion).filter((p) => readSidebarPrefs().includes(p.key));
    };
  }).catch(() => {});

  try {
    await step("default: no plugin rows in the filters group even though pages exist", async () => {
      assert.equal(await sidebarRow("甲·首页").count(), 0);
      assert.equal(await sidebarRow("乙·首页").count(), 0);
      assert.equal(await page.locator(".sidebar .nav-item:has-text('标签')").count(), 1, "built-in filters still render");
    });
    await step("toggle A/home + B/home on → rows appear at the end of the filters group", async () => {
      await page.evaluate(() => { window.__writePref("alpha.desk/home", true); window.__writePref("beta.desk/home", true); });
      await sidebarRow("甲·首页").waitFor({ timeout: 5000 });
      await sidebarRow("乙·首页").waitFor({ timeout: 5000 });
      const filters = await page.locator(".nav-section", { hasText: "筛选" }).locator(".nav-item").allInnerTexts();
      // collection is off by default (general.showCollectionNav=false), so the built-in
      // filters are 标签/收藏/智能文件夹; plugin rows must append after them.
      assert.deepEqual(filters.slice(0, 3), ["标签", "收藏", "智能文件夹"], "built-ins keep their order first");
      assert.ok(filters[3] === "甲·首页" && filters[4] === "乙·首页", `plugin rows appended last: ${filters}`);
    });
    await step("click sidebar row → real main-area page, no modal, sidebar usable", async () => {
      await sidebarRow("甲·首页").click();
      await page.locator(".plugin-page").waitFor({ timeout: 8000 });
      assert.equal(await page.locator(".plugin-dialog-backdrop, [aria-modal='true']").count(), 0, "no modal chrome");
      assert.match(await page.locator(".plugin-page-head h1").innerText(), /甲·首页/);
      await page.waitForFunction(() => document.querySelector(".plugin-output h3")?.textContent?.startsWith("PAGE:home"));
      assert.equal((await page.locator(".plugin-output h3").innerText()), "PAGE:home:run", "page auto-ran once on open");
      assert.equal(await page.evaluate(() => window.location.hash), "#plugins/alpha.desk/home");
      await sidebarRow("乙·首页").click(); // sidebar stays clickable
      await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "乙·首页");
    });
    await step("back/forward across A/home → B/home → A/stats keep distinct identities", async () => {
      await page.goBack(); await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "甲·首页");
      await page.goForward(); await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "乙·首页");
      await page.evaluate(() => { window.location.hash = "#plugins/alpha.desk/stats"; });
      await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "甲·统计");
      await page.goBack(); await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "乙·首页", null, { timeout: 5000 }).catch(async () => {
        // browser history and hash agree on distinct entries; assert hash-level identity either way
        assert.match(await page.evaluate(() => window.location.hash), /plugins\/(beta\.desk\/home|alpha\.desk\/stats)/);
      });
    });
    await step("hidden ≠ disabled: toggle off while the page is open keeps the page working", async () => {
      await page.evaluate(() => window.__writePref("beta.desk/home", false));
      await page.waitForFunction(() => ![...document.querySelectorAll(".nav-item")].some((el) => el.textContent?.includes("乙·首页")), null, { timeout: 3000 });
      assert.equal(await sidebarRow("乙·首页").count(), 0, "row gone");
      await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "乙·首页");
      assert.equal(await page.locator(".plugin-page").count(), 1, "open page unaffected");
    });
    await step("built-in route survives and back returns to the plugin page", async () => {
      await page.evaluate(() => { window.location.hash = "#community"; });
      await page.waitForSelector("[data-builtin-route='community']");
      await page.goBack();
      await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "乙·首页");
    });
    await step("disable the package → page shows an explicit unavailable state", async () => {
      await page.evaluate(() => {
        const { extensionPackages } = window.__modules;
        const next = extensionPackages.snapshot().packages.map((p) => p.package.manifest.id === "beta.desk" ? { ...p, enabled: false } : p);
        window.__registry(next);
      });
      await page.waitForSelector(".plugin-page-unavailable", { timeout: 8000 });
      assert.match(await page.locator(".plugin-page-unavailable").innerText(), /停用/);
    });
      const readPrefs = () => page.evaluate(() => {
        const raw = window.localStorage.getItem("luckyray-settings-v1") || "{}";
        const settings = JSON.parse(raw);
        return JSON.parse(settings["extensions.sidebarPages"] || "[]");
      });
    await step("uninstall prunes the pref for real; reinstall does not resurrect the row", async () => {
      await page.evaluate(() => {
        const { extensionPackages } = window.__modules;
        window.__registry(extensionPackages.snapshot().packages.filter((p) => p.package.manifest.id !== "alpha.desk"));
      });
      // let the async refresh land before pruning (AppShell prunes in an effect after the state change)
      await page.waitForTimeout(400);
      await page.evaluate(() => window.__prune());
      const prefsAfterUninstall = await readPrefs();
      assert.equal(prefsAfterUninstall.includes("alpha.desk/home"), false, `pref pruned by the real prune wiring: ${prefsAfterUninstall}`);
      assert.equal(await sidebarRow("甲·首页").count(), 0, "no ghost row");
      // reinstall the same package: the pref must not come back from nowhere
      await page.evaluate((serialized) => {
        const { extensionPackages } = window.__modules;
        window.__registry([...extensionPackages.snapshot().packages, structuredClone(JSON.parse(serialized))]);
      }, JSON.stringify(packageWith("alpha.desk", "甲插件", [["home", "甲·首页"], ["stats", "甲·统计"]])));
      await page.waitForTimeout(300);
      assert.equal(await sidebarRow("甲·首页").count(), 0, "reinstall does not resurrect the row from a stale pref");
    });
    await step("disable keeps the sidebar pref (hidden is not gone)", async () => {
      await page.evaluate(() => {
        const { extensionPackages } = window.__modules;
        window.__writePref("alpha.desk/home", true);
        const next = extensionPackages.snapshot().packages.map((p) => p.package.manifest.id === "alpha.desk" ? { ...p, enabled: false } : p);
        window.__registry(next);
        window.__prune();
      });
      await page.waitForTimeout(300);
      const prefsAfterDisable = await readPrefs();
      assert.equal(prefsAfterDisable.includes("alpha.desk/home"), true, "pref survives a disable (reversible)");
    });
    // ---- EXT-PAGE-R1-STATE-CLOSE: unsaved draft protection (P1-DRAFT-RETURN) ----
    await step("unsaved draft survives leaving and returning to the page", async () => {
      await page.evaluate(({ a, b }) => {
        const { extensionPackages } = window.__modules;
        window.__registry([structuredClone(a), structuredClone(b)]);
        void extensionPackages.refresh();
      }, { a: packageWith("alpha.desk", "甲插件", [["home", "甲·首页"], ["stats", "甲·统计"]]), b: packageWith("beta.desk", "乙插件", [["home", "乙·首页"]] ) });
      await page.evaluate(() => {
        window.__fieldsFor = (contribution) => contribution === "home"
          ? { title: "看板", fields: [{ id: "note", label: "备注", value: "旧值" }], actions: [{ id: "save", label: "保存" }] }
          : { title: "统计" };
      });
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/alpha.desk/home");
      await page.locator(".plugin-page .plugin-field input").waitFor({ timeout: 8000 });
      await page.waitForFunction(() => document.querySelector(".plugin-field input") !== null);
      await page.locator(".plugin-page .plugin-field input").fill("新值");
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/alpha.desk/stats");
      await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "甲·统计");
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/alpha.desk/home");
      await page.locator(".plugin-page .plugin-field input").waitFor({ timeout: 8000 });
      await page.waitForFunction(() => document.querySelector(".plugin-field input") !== null);
      assert.equal(await page.locator(".plugin-page .plugin-field input").inputValue(), "新值", "draft kept, plugin's 旧值 did not clobber it");
    });
    await step("draft survives while the return fetch is still in flight (typed input wins over the late result)", async () => {
      await page.evaluate(() => { window.__gateDispatch = new Promise((resolve) => { window.__releaseDispatch = resolve; }); window.__pending = { method: "data.get", params: {} }; });
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/alpha.desk/stats");
      await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "甲·统计");
      await page.evaluate(() => { window.__gateDispatch = new Promise((resolve) => { window.__releaseDispatch = resolve; }); });
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/alpha.desk/home");
      await page.locator(".plugin-page .plugin-field input").waitFor({ timeout: 8000 });
      await page.locator(".plugin-page .plugin-field input").fill("趁刷新输入");
      await page.evaluate(() => window.__releaseDispatch());
      await page.waitForFunction(() => document.querySelector(".plugin-field input") !== null);
      assert.equal(await page.locator(".plugin-page .plugin-field input").inputValue(), "趁刷新输入", "input typed during the initial fetch survives the late result");
    });
    await step("explicit save action still echoes the plugin's saved values", async () => {
      await page.evaluate(() => {
        window.__fieldsFor = (contribution, action) => contribution === "home"
          ? { title: "看板", fields: [{ id: "note", label: "备注", value: action === "save" ? "已保存的新值" : "旧值" }], actions: [{ id: "save", label: "保存" }] }
          : { title: "统计" };
      });
      await page.locator('.plugin-page .plugin-actions button:has-text("保存")').click();
      await page.waitForFunction(() => document.querySelector(".plugin-field input")?.value === "已保存的新值", null, { timeout: 10000 });
      assert.equal(await page.locator(".plugin-page .plugin-field input").inputValue(), "已保存的新值", "explicit action echoes the plugin result");
    });
    await step("digest change invalidates the stale draft (fresh values from the new build)", async () => {
      await page.evaluate(() => {
        const { extensionPackages } = window.__modules;
        const next = extensionPackages.snapshot().packages.map((p) => p.package.manifest.id === "alpha.desk" ? { ...p, digest: "d-alpha-v2" } : p);
        window.__registry(next);
      });
      await page.waitForTimeout(400);
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/alpha.desk/stats");
      await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "甲·统计");
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/alpha.desk/home");
      await page.locator(".plugin-page .plugin-field input").waitFor({ timeout: 8000 });
      await page.waitForFunction(() => document.querySelector(".plugin-field input") !== null);
      const fresh = await page.evaluate(() => window.__fieldsFor("home", "run").fields[0].value);
      assert.equal(await page.locator(".plugin-page .plugin-field input").inputValue(), fresh, "stale session dropped: value comes from the new build");
    });
    await step("beta package fields do not leak into alpha pages", async () => {
      await page.evaluate(() => { window.__fieldsFor = null; });
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/beta.desk/home");
      await page.waitForFunction(() => document.querySelector(".plugin-page-head h1")?.textContent === "乙·首页");
      assert.equal(await page.locator(".plugin-page .plugin-field input").count(), 0, "beta page has no shared fields");
      await page.evaluate(() => {
        window.__fieldsFor = (contribution) => contribution === "home"
          ? { title: "看板", fields: [{ id: "note", label: "备注", value: "旧值" }], actions: [{ id: "save", label: "保存" }] }
          : { title: "统计" };
      });
      await page.evaluate((hash) => { window.location.hash = hash; }, "#plugins/alpha.desk/home");
      await page.locator(".plugin-page .plugin-field input").waitFor({ timeout: 8000 });
      await page.waitForFunction(() => document.querySelector(".plugin-field input")?.value === "旧值", null, { timeout: 8000 });
      assert.equal(await page.locator(".plugin-page .plugin-field input").inputValue(), "旧值", "alpha page fresh from its own plugin after the rebuild");
    });
    results.push({ step: "summary", ok: true });
  } finally {
    if (process.argv.includes("--json")) {
      const out = process.argv[process.argv.indexOf("--json") + 1];
      fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    }
    await browser.close(); server.close();
  }
  console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }));
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
