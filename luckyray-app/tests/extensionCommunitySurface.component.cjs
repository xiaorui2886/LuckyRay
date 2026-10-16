// Real-browser render of the EXT-Z1 community package surface. Bundles the
// production panel + template flow with React, serves a stub Tauri transport,
// and drives genuine interactions (click, file input, hover, theme preview) in
// headless Edge. Asserts rendered state and layout, not source strings.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const esbuild = require(require.resolve("esbuild", { paths: [fs.realpathSync(root + "/node_modules/vite")] }));
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
    "C:/Users/Administrator/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright",
);

const THEME_PACK = JSON.stringify({
  manifest: { schemaVersion: 0, id: "org.luckyray.paper-sage", name: "Paper Sage", version: "1.0.0", type: "theme", entry: "theme.json", minHostVersion: "1.9.2", apiVersion: 0, requiredModules: [], optionalModules: [] },
  resource: { base: "light", tokens: { "--theme-app-bg": "#edf1e8", "--theme-sidebar-bg": "#e2e9dd", "--text-primary": "#293b29", "--text-secondary": "#52664d" } },
});
const TEMPLATE_PACK = JSON.stringify({
  manifest: { schemaVersion: 0, id: "org.luckyray.research-note", name: "Research note", version: "1.0.0", type: "template", entry: "template.json", minHostVersion: "1.9.2", apiVersion: 0, requiredModules: ["knowledge"], optionalModules: ["assets"] },
  resource: { markdown: "# {{topic}}\n\n## Research question\n\n{{question}}\n", parameters: { topic: "Research note", question: "What do we need to learn?" } },
});
// A second theme, used to reproduce the preview-A-confirm-B and wrong-file-update
// defects the review found.
const THEME2_PACK = JSON.stringify({
  manifest: { schemaVersion: 0, id: "org.luckyray.second-theme", name: "Second Theme", version: "1.0.0", type: "theme", entry: "theme.json", minHostVersion: "1.9.2", apiVersion: 0, requiredModules: [], optionalModules: [] },
  resource: { base: "dark", tokens: { "--theme-app-bg": "#101014", "--text-primary": "#f0f0f5" } },
});
const THEME2_V2_PACK = JSON.stringify({
  manifest: { schemaVersion: 0, id: "org.luckyray.second-theme", name: "Second Theme", version: "2.0.0", type: "theme", entry: "theme.json", minHostVersion: "1.9.2", apiVersion: 0, requiredModules: [], optionalModules: [] },
  resource: { base: "dark", tokens: { "--theme-app-bg": "#08080c", "--text-primary": "#f8f8ff" } },
});
// A second template, used to reproduce "prepare A then switch to B still runs A".
const TEMPLATE2_PACK = JSON.stringify({
  manifest: { schemaVersion: 0, id: "org.luckyray.other-template", name: "Other Template", version: "1.0.0", type: "template", entry: "template.json", minHostVersion: "1.9.2", apiVersion: 0, requiredModules: ["knowledge"], optionalModules: [] },
  resource: { markdown: "# {{topic}}\n\nOther template body.\n", parameters: { topic: "Other topic" } },
});

(async () => {
  const cssText = fs.readFileSync(root + "/src/features/community/community.css", "utf8");
  const script = await esbuild.build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { useMemo, useState } from "react";
        import { createExtensionPackageService } from "./src/core/extensions/packages";
        import { createExtensionTemplateActions } from "./src/core/extensions/templates";
        import { applyPackageTheme } from "./src/core/extensions/theme";
        import { PackagesPanel } from "./src/features/community/ExtensionPackagesPanel";
        import { TemplateFlow } from "./src/features/community/TemplateFlow";
        import { EXT_PACKAGE_MESSAGES } from "./src/features/community/extensionMessages";
        import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from "./src/app/applicationModalIsolation";
        import { I18nProvider } from "./src/core/i18n/index";
        const modalStore = createApplicationModalIsolationStore();

        const THEME = ${JSON.stringify(THEME_PACK)};
        const TEMPLATE = ${JSON.stringify(TEMPLATE_PACK)};

        let revision = 0;
        const store = new Map();
        const state = () => ({ revision, hostVersion: "1.9.2", packages: [...store.values()].map((p) => ({ ...p })) });
        const transport = async (request) => {
          if (request.op === "list") return state();
          const manifest = request.package?.manifest;
          if (request.op === "install") {
            const existing = store.get(manifest.id);
            if (existing && JSON.stringify(existing.package) !== JSON.stringify(request.package)) throw Object.assign(new Error("id-conflict"), { code: "id-conflict" });
            if (!existing) store.set(manifest.id, { package: request.package, enabled: false, digest: "d" + revision });
            revision += 1; return state();
          }
          if (request.op === "enable" || request.op === "disable") {
            const entry = store.get(request.id); if (!entry) throw Object.assign(new Error("not-installed"), { code: "not-installed" });
            entry.enabled = request.op === "enable"; revision += 1; window.__mutations = (window.__mutations || 0) + 1; return state();
          }
          if (request.op === "uninstall") { store.delete(request.id); revision += 1; return state(); }
          if (request.op === "update") {
            const entry = store.get(manifest.id);
            if (!entry) throw Object.assign(new Error("not-installed"), { code: "not-installed" });
            entry.package = request.package; entry.digest = "d" + revision;
            revision += 1; return state();
          }
          throw new Error("op " + request.op);
        };
        const service = createExtensionPackageService(transport);
        const locale = "zh-CN";
        const t = (key, vars = {}) => Object.prototype.hasOwnProperty.call(EXT_PACKAGE_MESSAGES, key)
          ? EXT_PACKAGE_MESSAGES[key][locale].replace(/\\{([a-zA-Z][\\w]*)\\}/g, (m, n) => (n in vars ? String(vars[n]) : m))
          : key;
        // R5: a stable source object is required — the production prepare()
        // compares source identity across awaits. A fresh object per call would
        // always be judged stale (the previous false positive).
        const SOURCE = Object.freeze({ vaultId: "demo" });
        window.__executed = 0;
        window.__executedTargets = [];
        const templateActions = createExtensionTemplateActions(service, {
          ensureActive: async () => { if (window.__prepareDelay) await new Promise((r) => setTimeout(r, window.__prepareDelay)); return { vaultId: "demo", sourceEpoch: 1 }; },
          context: async () => ({ documentRef: { vaultId: "demo", relativePath: "notes/current.md" }, expectedRevision: "r1", cursorOffset: 12 }),
          source: () => SOURCE,
          draft: () => ({ dirty: () => false, refresh: async () => {} }),
          writes: {
            createDocument: async (input) => {
              window.__writeStarted = (window.__writeStarted || 0) + 1;
              if (window.__writeDelay) await new Promise((r) => setTimeout(r, window.__writeDelay));
              window.__executed += 1;
              window.__executedTargets.push({ kind: "create", title: input.title });
              return { documentRef: { vaultId: "demo", relativePath: "notes/created.md" }, title: input.title, content: input.content, revision: "r2" };
            },
            insertDocument: async () => { window.__executed += 1; window.__executedTargets.push({ kind: "insert" }); return { document: { documentRef: { vaultId: "demo", relativePath: "notes/current.md" } }, position: "cursor" }; },
          },
        });

        window.__panel = { service, applyPackageTheme, templateActions, t };

        function Host() {
          const [openTemplate, setOpenTemplate] = useState(null);
          return (
            <div id="host">
              <PackagesPanel service={service} copy={{ t, locale }} onMessage={() => {}} renderTemplateActions={(pkg) => (
                <button className="lr-cap-run secondary" data-template-open={pkg.id} onClick={(e) => {
                  const entry = service.snapshot().packages.find((i) => i.package.manifest.id === pkg.id);
                  if (entry?.enabled) setOpenTemplate({ id: pkg.id, name: pkg.name, resource: entry.package.resource });
                }}>使用模板</button>
              )} />
              {openTemplate && <div id="template-host">
                <button className="lr-cap-run secondary" id="close-template" onClick={() => setOpenTemplate(null)}>返回</button>
                <TemplateFlow key={openTemplate.id + "::" + openTemplate.name} actions={templateActions} templateId={openTemplate.id} templateName={openTemplate.name} resource={openTemplate.resource} t={t} onLocate={(o) => { window.__located = o; }} onMessage={() => {}} />
              </div>}
            </div>
          );
        }
        createRoot(document.getElementById("root")).render(<I18nProvider locale="zh-CN"><ApplicationModalIsolationProvider store={modalStore}><Host /></ApplicationModalIsolationProvider></I18nProvider>);
      `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    outfile: "app.js",
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "stub-tauri-core",
      setup(build) {
        build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "tauri-core", namespace: "tauri-stub" }));
        build.onLoad({ filter: /.*/, namespace: "tauri-stub" }, () => ({ contents: "export const invoke = async () => ({ revision: 0, hostVersion: '1.9.2', packages: [] });", loader: "js" }));
      },
    }],
    logLevel: "silent",
  });
  const appJs = script.outputFiles[0].text;

  const server = http.createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(appJs); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<meta charset="utf-8"><style>:root{--bg-active:#ececf0;--bg-elevated:#fff;--bg-panel:#f6f6f9;--bg-input:#fff;--border:#dcdce4;--border-strong:#c8c8d4;--text-primary:#1c1c22;--text-secondary:#4c4c58;--text-tertiary:#8a8a96;--accent:#4f6ef7;--accent-text:#3b53c9;--danger:#c0554d;--radius-md:10px;--radius-sm:6px;--font-mono:ui-monospace,monospace;--fs-xs:10px;--fs-sm:11px;--fs-md:12px;--fs-lg:14px;--space-2:6px;--space-3:8px;--space-4:10px;--space-5:12px;--space-6:14px;--space-7:16px;--transition:120ms ease}body{margin:24px;background:#fafafc;color:var(--text-primary);font:13px/1.5 system-ui,sans-serif}main{max-width:760px}${cssText}</style><main id="root"></main><script src="/app.js"></script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.waitForFunction(() => !!(window.__panel)); await page.locator(".ext-packages").waitFor().catch(async (e) => { console.error("PAGE ERRORS:", errors); throw e; });

    // Standalone panel exposes both truthful category empty states after the read.
    await page.waitForFunction(() => document.querySelectorAll('.community-loading').length === 0);
    assert.equal(await page.locator(".community-empty").count(), 2, "each category has an honest empty state after successful read");
    assert.equal(await page.locator(".community-loading").count(), 0, "loading does not linger once ready");
    assert.equal(await page.locator('[role="alert"]').count(), 0, "no error banner on a successful read");

    // install the theme via the file input; the filename must NOT be used as
    // the display name — the manifest name is authoritative.
    await page.setInputFiles('.ext-install input[type="file"]', { name: "totally-unrelated-filename.json", mimeType: "application/json", buffer: Buffer.from(THEME_PACK) });
    await page.locator(".ext-package-card", { hasText: "Paper Sage" }).waitFor();
    assert.equal(await page.locator('.ext-package-card:has-text("Paper Sage") .ext-package-state').innerText(), "已禁用", "new package starts disabled");
    assert.equal(await page.getByText("totally-unrelated-filename", { exact: false }).count(), 0, "the filename is never shown as the package name");

    // preview a DISABLED theme, then cancel → overlay fully restored
    await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("预览主题")').click();
    await page.locator('.ext-theme-preview-actions').waitFor();
    const previewed = await page.evaluate(() => {
      const root = document.documentElement;
      window.__panel.applyPackageTheme(window.__panel.service.activeTheme(), root);
      return { ext: root.dataset.extensionTheme, bg: root.style.getPropertyValue("--theme-app-bg") };
    });
    assert.equal(previewed.ext, "active", "preview applies the extension-theme marker");
    assert.equal(previewed.bg, "#edf1e8", "preview applies allowlisted tokens");
    await page.locator('button:has-text("取消预览")').last().click();
    const restored = await page.evaluate(() => {
      const root = document.documentElement;
      window.__panel.applyPackageTheme(window.__panel.service.activeTheme(), root);
      return { ext: root.dataset.extensionTheme, bg: root.style.getPropertyValue("--theme-app-bg") };
    });
    assert.equal(restored.ext, undefined, "cancel clears the extension-theme marker");
    assert.equal(restored.bg, "", "cancel restores the pre-existing token state");

    // enable it once and confirm the state chip flips
    await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("启用")').click();
    await page.locator('.ext-package-card:has-text("Paper Sage") .ext-package-state.is-on').waitFor();

    // an immediate second click while the first is settling must be ignored by
    // the in-flight guard: no extra enable mutation reaches the store.
    await page.evaluate(() => { window.__mutations = 0; });
    await page.evaluate(() => {
      const button = document.querySelector('.ext-package-card button');
      // fire two clicks in the same task before React can re-render
      const disable = [...document.querySelectorAll('.ext-package-card button')].find((b) => b.textContent.includes('禁用'));
      if (disable) { disable.click(); disable.click(); }
    });
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => window.__mutations) <= 1, "the in-flight guard prevents a duplicate mutation");

    // enable it and confirm the state chip flips, then enable-persistence holds
    await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("启用")').click();
    await page.locator('.ext-package-card:has-text("Paper Sage") .ext-package-state.is-on').waitFor();
    assert.equal(await page.locator('.ext-package-card:has-text("Paper Sage") .ext-package-state').innerText(), "已启用");
    const enabled = await page.evaluate(() => {
      const root = document.documentElement;
      window.__panel.applyPackageTheme(window.__panel.service.activeTheme(), root);
      return { ext: root.dataset.extensionTheme, bg: root.style.getPropertyValue("--theme-app-bg") };
    });
    assert.equal(enabled.ext, "active", "an enabled theme keeps applying without a preview");

    // disabling the active theme restores the original state
    await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("禁用")').click();
    await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("启用")').waitFor();
    const disabled = await page.evaluate(() => {
      const root = document.documentElement;
      window.__panel.applyPackageTheme(window.__panel.service.activeTheme(), root);
      return { ext: root.dataset.extensionTheme, bg: root.style.getPropertyValue("--theme-app-bg") };
    });
    assert.equal(disabled.ext, undefined, "disabling restores the original settings");
    assert.equal(disabled.bg, "");
    // leave Paper Sage disabled so the R1 preview-binding regression can run

    // --- R1 regression: preview A then B, then confirm A must enable A (not B) ---
    await page.setInputFiles('.ext-install input[type="file"]', { name: "second-theme.lrpack.json", mimeType: "application/json", buffer: Buffer.from(THEME2_PACK) });
    await page.locator('.ext-package-card:has-text("Second Theme")').waitFor();
    await page.evaluate(() => { window.__panel.service.snapshot(); });
    // preview A (Paper Sage), then preview B (Second Theme)
    await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("预览主题")').click();
    await page.locator('.ext-package-card:has-text("Second Theme") button:has-text("预览主题")').click();
    // After switching preview, only the B card may own the confirmation controls.
    assert.equal(await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("确认启用")').count(), 0, "A no longer owns the confirmation");
    assert.equal(await page.locator('.ext-package-card:has-text("Second Theme") button:has-text("确认启用")').count(), 1, "B owns the confirmation");
    // Confirm B, and assert the enabled theme is B — never A.
    await page.locator('.ext-package-card:has-text("Second Theme") button:has-text("确认启用")').click();
    await page.locator('.ext-package-card:has-text("Second Theme") .ext-package-state.is-on').waitFor();
    const enabledId = await page.evaluate(() => window.__panel.service.enabledThemeId());
    assert.equal(enabledId, "org.luckyray.second-theme", "the confirmed theme is the one the user previewed (B), not A");
    assert.equal(await page.locator('.ext-package-card:has-text("Paper Sage") .ext-package-state.is-on').count(), 0, "A stays disabled");

    // --- R2 regression: updating A with B's file must be rejected ---
    await page.evaluate(() => { window.__panel.rejected = 0; });
    await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("详情")').click();
    await page.setInputFiles('.community-drawer .ext-package-update input[type="file"]', { name: "second-theme.lrpack.json", mimeType: "application/json", buffer: Buffer.from(THEME2_V2_PACK) });
    await page.waitForTimeout(300);
    // B's version must be unchanged (the wrong-file update was rejected before mutate)
    const bVersion = await page.evaluate(() => window.__panel.service.snapshot().packages.find((p) => p.package.manifest.id === "org.luckyray.second-theme").package.manifest.version);
    assert.equal(bVersion, "1.0.0", "a mismatched update file did not modify another package");
    assert.match(await page.locator('.community-drawer [role="alert"]').innerText(), /Paper Sage/, "a rejected update is visible inside the open drawer");
    // A correct update to A itself is accepted
    await page.setInputFiles('.community-drawer .ext-package-update input[type="file"]', { name: "paper-sage-v2.lrpack.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...JSON.parse(THEME_PACK), manifest: { ...JSON.parse(THEME_PACK).manifest, version: "1.1.0" } })) });
    await page.waitForFunction(() => window.__panel.service.snapshot().packages.find((p) => p.package.manifest.id === "org.luckyray.paper-sage")?.package.manifest.version === "1.1.0", null, { timeout: 5000 });
    await page.getByRole('button', {name: '关闭', exact: true}).click();

    // install + enable the template, then open the flow
    await page.setInputFiles('.ext-install input[type="file"]', { name: "research-note.lrpack.json", mimeType: "application/json", buffer: Buffer.from(TEMPLATE_PACK) });
    await page.locator('.ext-package-card:has-text("Research note")').waitFor();
    await page.locator('.ext-package-card:has-text("Research note") button:has-text("启用")').click();
    await page.locator('[data-template-open="org.luckyray.research-note"]').click();
    await page.locator(".ext-template-flow").waitFor();

    // parameter edit must flow into the live preview
    await page.locator('.ext-template-field:has-text("topic") input').fill("量子计算");
    assert.match(await page.locator(".ext-template-preview").innerText(), /量子计算/, "preview reflects edited parameters");

    // create → prepare stage. The prepared confirmation must render the target
    // from the prepared result and the same content that will be written (R4).
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click();
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').waitFor();
    assert.match(await page.locator('.ext-template-summary').innerText(), /demo/, "the prepared target is shown");
    assert.match(await page.locator(".ext-template-preview").innerText(), /量子计算/, "the confirmation shows the prepared content");

    // Confirm the run and assert the writer actually executed exactly once and
    // produced a real locate outcome from the returned document reference (R3/R5).
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click();
    await page.waitForFunction(() => window.__executed === 1, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__executed), 1, "createDocument ran exactly once");
    const located = await page.evaluate(() => window.__located);
    assert.ok(located && located.documentRef && located.documentRef.relativePath === "notes/created.md", "locate uses the writer's real documentRef");
    assert.equal(await page.locator('.ext-template-field:has-text("topic") input').count(), 1, "the flow returns to the form after a confirmed create");

    // detail dialog opens with module info
    await page.locator('.ext-package-card:has-text("Research note") button:has-text("详情")').click();
    await page.locator(".ext-package-detail").waitFor();
    assert.match(await page.locator(".ext-package-detail").innerText(), /knowledge/, "required module is shown");
    assert.match(await page.locator(".ext-package-detail").innerText(), /assets/, "optional module is shown");
    await page.getByRole('button', {name: '关闭', exact: true}).click();

    // --- A regression: prepare template A, then switch to template B ---
    // Install + enable a second template.
    await page.setInputFiles('.ext-install input[type="file"]', { name: "other-template.lrpack.json", mimeType: "application/json", buffer: Buffer.from(TEMPLATE2_PACK) });
    await page.locator('.ext-package-card:has-text("Other Template")').waitFor();
    await page.locator('.ext-package-card:has-text("Other Template") button:has-text("启用")').click();
    await page.locator('.ext-package-card:has-text("Other Template") .ext-package-state.is-on').waitFor();

    // Open A (Research note), edit its topic, and prepare it (confirmation shows A).
    await page.locator('[data-template-open="org.luckyray.research-note"]').click();
    await page.locator('.ext-template-field:has-text("topic") input').fill("A-TOPIC");
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click();
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').waitFor();
    assert.match(await page.locator(".ext-template-preview").innerText(), /A-TOPIC/, "A is prepared and shown");

    // Switch to B: the panel must reset to B's form — no A confirmation remains.
    await page.locator('[data-template-open="org.luckyray.other-template"]').click();
    await page.locator('.ext-template-field:has-text("topic") input').waitFor();
    assert.equal(await page.locator('.ext-template-actions button:has-text("创建新笔记")').filter({ hasText: "创建新笔记" }).count(), 1, "B shows the plain form action");
    assert.doesNotMatch(await page.locator(".ext-template-preview").innerText(), /A-TOPIC/, "B's form never shows A's prepared content");
    assert.match(await page.locator(".ext-template-preview").innerText(), /Other template body/, "B renders its own preview");

    // Confirming B must write B's content under B's title, not A's.
    await page.evaluate(() => { window.__executed = 0; window.__executedTargets = []; window.__located = null; });
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click();
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').waitFor();
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click();
    await page.waitForFunction(() => window.__executed === 1, null, { timeout: 5000 });
    const target = await page.evaluate(() => window.__executedTargets[0]);
    assert.equal(target.title, "Other Template", "the execution uses B's title, never A's");
    assert.doesNotMatch(JSON.stringify(await page.evaluate(() => window.__executedTargets)), /A-TOPIC/, "A's parameters never reach B's write");

    // --- A regression (delayed): prepare A, switch to B before A's prepare returns ---
    await page.evaluate(() => { window.__executed = 0; window.__executedTargets = []; window.__located = null; window.__prepareDelay = 500; });
    await page.locator('[data-template-open="org.luckyray.research-note"]').click();
    await page.locator('.ext-template-field:has-text("topic") input').fill("DELAYED-A");
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click(); // prepare A (slow)
    // Immediately switch to B while A's prepare is still in flight.
    await page.locator('[data-template-open="org.luckyray.other-template"]').click();
    await page.waitForTimeout(800); // A's prepare resolves here
    assert.equal(await page.locator('.ext-template-field:has-text("topic") input').count(), 1, "B remains on its own form");
    assert.doesNotMatch(await page.locator(".ext-template-preview").innerText(), /DELAYED-A/, "A's late prepare result never lands on B");
    assert.match(await page.locator(".ext-template-preview").innerText(), /Other template body/, "B keeps its own preview");
    await page.evaluate(() => { window.__prepareDelay = 0; });

    // --- A regression (in-flight write): start A's write, then switch to B ---
    // The write must still complete exactly once, but its late locate/success
    // callback must not touch B (no focus steal, no toast change on the new UI).
    await page.evaluate(() => { window.__executed = 0; window.__executedTargets = []; window.__located = null; window.__writeStarted = 0; window.__writeDelay = 700; });
    await page.locator('[data-template-open="org.luckyray.research-note"]').click();
    await page.locator('.ext-template-field:has-text("topic") input').fill("INFLIGHT-A");
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click(); // prepare A
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').waitFor();
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click(); // run A (slow write)
    await page.waitForFunction(() => window.__writeStarted === 1, null, { timeout: 5000 }); // write has started
    await page.locator('[data-template-open="org.luckyray.other-template"]').click(); // switch to B mid-write
    await page.waitForTimeout(1000); // A's write resolves here
    assert.equal(await page.evaluate(() => window.__executed), 1, "the in-flight write still completes exactly once");
    assert.equal(await page.evaluate(() => window.__located), null, "A's late locate callback does not fire after switching to B");
    assert.equal(await page.locator('.ext-template-field:has-text("topic") input').count(), 1, "B remains on its own form");
    assert.doesNotMatch(await page.locator(".ext-template-preview").innerText(), /INFLIGHT-A/, "A's in-flight write never rewrites B's view");

    // --- A regression (in-flight write): start A's write, then close the flow ---
    await page.evaluate(() => { window.__executed = 0; window.__executedTargets = []; window.__located = null; window.__writeStarted = 0; });
    await page.locator('[data-template-open="org.luckyray.research-note"]').click();
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click();
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').waitFor();
    await page.locator('.ext-template-actions button:has-text("创建新笔记")').click(); // run A (slow write)
    await page.waitForFunction(() => window.__writeStarted === 1, null, { timeout: 5000 });
    await page.locator('#close-template').click(); // close the flow while writing (outer back)
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(() => window.__executed), 1, "the write completes exactly once after closing");
    assert.equal(await page.evaluate(() => window.__located), null, "no late locate after the flow is closed");
    assert.equal(await page.locator('#template-host').count(), 0, "the closed flow stays closed");
    await page.evaluate(() => { window.__writeDelay = 0; });

    // --- C regression: search with no match differs from empty; success toast fades ---
    await page.locator('.ext-packages-search').fill("zzz-no-such-package");
    await page.locator(".community-empty").first().waitFor();
    assert.match(await page.locator(".community-empty").first().innerText(), /没有找到匹配/, "a no-match search shows the no-match copy, not 'not installed'");
    await page.locator('.ext-packages-search').fill("");

    // narrow viewport still lays out without horizontal overflow
    await page.setViewportSize({ width: 520, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal overflow at 520px (got ${overflow})`);

    assert.deepEqual(errors, [], "no uncaught page errors");
    console.log("PASS package surface render: install/enable/preview-cancel/template/detail/responsive");
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
