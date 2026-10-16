// EXT-PAGE-R1-STATE-CLOSE: real-browser test of the production initialization
// hook AppShell uses (usePluginSidebarPages) against a controlled transport.
// Covers the P1-PREF-BOOT behaviours: a cold start whose first refresh is still
// in flight must NOT clear stored sidebar preferences; a failing first refresh
// keeps them too; successful empty/uninstalled registries retain stable-ID
// visibility choices so a later reinstall restores the entry. The harness renders first and
// lets the hook bootstrap its own refresh — no manual prune, no await-then-render.
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

const pagePkg = (id, name) => ({
  package: {
    manifest: { schemaVersion: 1, id, name, version: "1.0.0", type: "script", entry: "main.js", minHostVersion: "1.9.2", apiVersion: 1, requiredModules: [], optionalModules: [] },
    resource: { code: "//", requiredPermissions: [], optionalPermissions: [], dataVersion: 1, contributions: [{ id: "home", label: name + " 首页", kind: "page" }] },
  },
  enabled: true, digest: `d-${id}`, epoch: 1, grants: [],
});

(async () => {
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { useEffect, useState } from "react";
        import { usePluginSidebarPages } from "./src/app/usePluginSidebarPages";
        import { readSavedSettings } from "./src/features/settings/useSettings";
        import { writeSidebarPref } from "./src/features/community/pluginPages";
        window.__writePref = (key, on) => writeSidebarPref(key, on);
        import { extensionPackages } from "./src/core/extensions/packages";
        window.__snapshot = () => { const s = extensionPackages.snapshot(); return { ready: s.ready, n: s.packages.length, host: s.hostVersion }; };
        window.__refresh = () => extensionPackages.refresh();
        // Controlled transport: the FIRST manage_extension_packages call follows __firstMode
        // ("pending" never settles, "reject" fails, "delay" resolves after 600ms); later calls
        // return the current registry. __firstMode is set before this module boots.
        window.__firstDone = false;
        window.__registry = [${JSON.stringify(pagePkg("alpha.desk", "甲插件"))}];
        window.__invoke = async (cmd) => {
          if (cmd !== "manage_extension_packages") return { revision: 1, hostVersion: "1.9.2", packages: [] };
          if (!window.__firstDone) {
            window.__firstDone = true;
            const mode = window.__firstMode || "ok";
            if (mode === "pending") await new Promise(() => {});
            if (mode === "reject") throw new Error("backend-down");
            if (mode === "delay") await new Promise((resolve) => setTimeout(resolve, 600));
          }
          return { revision: 9, hostVersion: "1.9.2", packages: structuredClone(window.__registry) };
        };
        function Harness() {
          const [settings, setSettings] = useState(readSavedSettings);
          useEffect(() => {
            const onSettings = () => setSettings(readSavedSettings());
            window.addEventListener("luckyray:settings-change", onSettings);
            return () => window.removeEventListener("luckyray:settings-change", onSettings);
          }, []);
          const pages = usePluginSidebarPages(settings);
          return <div data-pages={pages.map((p) => p.key).join(",")} data-count={pages.length}>{pages.map((p) => <span key={p.key}>{p.label}</span>)}</div>;
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
          ["@tauri-apps/api/core", "export const invoke = (cmd) => window.__invoke(cmd); export const isTauri = () => true;"],
        ]);
        b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, (args) => ({ path: args.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: map.get(args.path), loader: "js" }));
      },
    }],
  });
  const appJs = built.outputFiles[0].text;
  const server = http.createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(appJs); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<meta charset="utf-8"><div id="root"></div><script type="module" src="/app.js"></script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const results = [];
  const readPrefs = (page) => page.evaluate(() => {
    const settings = JSON.parse(window.localStorage.getItem("luckyray-settings-v1") || "{}");
    return JSON.parse(settings["extensions.sidebarPages"] || "[]");
  });
  async function step(name, fn) {
    try { await fn(); results.push({ step: name, ok: true }); console.log(`[ok]   ${name}`); }
    catch (error) { results.push({ step: name, ok: false, error: String(error?.message || error) }); console.log(`[FAIL] ${name}: ${String(error?.message || error).split("\n")[0]}`); throw error; }
  }
  // fresh storage per scenario
  async function fresh(firstMode) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript((mode) => { window.__firstMode = mode; }, firstMode);
    await page.goto(base);
    await page.waitForSelector('body[data-ready="1"]');
    await page.evaluate(() => window.localStorage.clear());
    return { context, page };
  }

  try {
    await step("cold start: first refresh still in flight keeps the stored preference", async () => {
      const { context, page } = await fresh("pending");
      await page.evaluate(() => window.__writePref("alpha.desk/home", true));
      await page.waitForTimeout(1200);
      const prefs = await readPrefs(page);
      assert.deepEqual(prefs, ["alpha.desk/home"], `pending load must not prune: ${prefs}`);
      assert.equal(await page.locator("[data-count]").getAttribute("data-count"), "0", "no entries projected before load");
      await context.close();
    });
    await step("first refresh fails: preference survives, state stays recoverable", async () => {
      const { context, page } = await fresh("reject");
      await page.evaluate(() => window.__writePref("alpha.desk/home", true));
      await page.waitForTimeout(1200);
      assert.deepEqual(await readPrefs(page), ["alpha.desk/home"], "failed first load must not prune");
      await context.close();
    });
    await step("successful load projects the entry; empty load preserves its choice and reinstall restores it", async () => {
      const { context, page } = await fresh("delay");
      await page.evaluate(() => window.__writePref("alpha.desk/home", true));
      await page.waitForSelector("[data-count='1'] span", { timeout: 8000 });
      assert.equal(await page.locator("span").innerText(), "甲插件 首页");
      assert.deepEqual(await readPrefs(page), ["alpha.desk/home"], "successful load retains the preference");
      // uninstall everything and let the hook's subscription drive another successful refresh
      // A real registry change reaches the UI through a service refresh (as panels do).
      await page.evaluate(() => { window.__registry = []; });
      await page.evaluate(() => window.__refresh());
      // empty projection renders no spans: assert on the attribute, not visibility
      await page.waitForFunction(() => document.querySelector("[data-count]")?.getAttribute("data-count") === "0", null, { timeout: 8000 });
      assert.deepEqual(await readPrefs(page), ["alpha.desk/home"], "empty library preserves the visibility choice");
      await page.evaluate((pkg) => { window.__registry = [pkg]; }, pagePkg("alpha.desk", "甲插件"));
      await page.evaluate(() => window.__refresh());
      await page.waitForSelector("[data-count='1'] span", { timeout: 8000 });
      assert.deepEqual(await readPrefs(page), ["alpha.desk/home"], "reinstall restores the same stable page choice");
      await context.close();
    });
  } finally {
    if (process.argv.includes("--json")) fs.writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    await browser.close(); server.close();
  }
  console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }));
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
