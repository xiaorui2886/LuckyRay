// EXT-V1/Z2-CLOSE-R1: real-browser render of the production plugin dialog
// (PluginEntryMenu → PluginInvocation) with a scripted extension_runtime
// transport. Asserts what the user actually sees for unknown / refused /
// confirmed writes, multiple same-method calls, cancelled confirmations, stopped
// runs and preflight interleaving. Controlled DOM fault injection — not native.
//
// node tests/extensionPluginRound.component.cjs [--only <scenario>] [--json <out.json>]
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
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const only = arg("--only");
const jsonOut = arg("--json");

const PACKAGE = {
  package: {
    manifest: { schemaVersion: 1, id: "test.round", name: "Round plugin", version: "1.0.0", type: "script", entry: "main.js", minHostVersion: "1.9.2", apiVersion: 1, requiredModules: ["materials"], optionalModules: ["knowledge"] },
    resource: { code: "// fixture", requiredPermissions: ["materials.read", "materials.tags"], optionalPermissions: ["knowledge.create"], dataVersion: 1, contributions: [{ id: "run", label: "Run round", kind: "panel" }, { id: "settings", label: "Round settings", kind: "settings" }] },
  },
  enabled: true, digest: "d-round", epoch: 1, grants: ["materials.read", "materials.tags", "knowledge.create"],
};
const TAGS = (id) => ({ id, name: `asset-${id}.png`, tagIds: ["blue"], revision: "r2" });

(async () => {
  const cssText = fs.readFileSync(root + "/src/features/community/community.css", "utf8") + fs.readFileSync(root + "/src/features/community/scriptPlugins.css", "utf8");
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { I18nProvider } from "./src/core/i18n/index";
        import { PluginEntryMenu, openPlugin } from "./src/features/community/ScriptPlugins";
        import { extensionPackages } from "./src/core/extensions/packages";
        window.__TAURI_INTERNALS__ = {};
        window.__dispatches = 0;
        window.__deferred = {};
        // Scripted broker: scenario decides poll messages and dispatch answers.
        const call = (method, params) => ({ kind: "call", request: { method, params } });
        const ok = (ui, receipts = []) => ({ kind: "result", result: { ok: true, value: ui }, receipts });
        const fail = (error) => ({ kind: "result", result: { ok: false, error } });
        const tagsCall = (id) => call("materials.tags", { id, revision: "r1", tags: ["blue"] });
        const tagsValue = (id) => ({ id, name: "asset-" + id + ".png", tagIds: ["blue"], revision: "r2" });
        const scenarios = {
          "ipc-broken": { polls: [tagsCall("m1"), ok({ title: "done" })], dispatch: [() => { throw new Error("ipc-broken"); }] },
          "unknown-native": { polls: [tagsCall("m1"), ok({ title: "done" })], dispatch: [() => ({ response: { error: "plugin-export-write-failed" } })] },
          "refused": { polls: [tagsCall("m1"), ok({ title: "done" })], dispatch: [() => ({ response: { error: "plugin-permission-denied" } })] },
          "committed-then-throw": { polls: [tagsCall("m1"), fail("Error: after-write-failed")], dispatch: [() => ({ response: { value: tagsValue("m1") } })] },
          "committed-then-invalid-ui": { polls: [tagsCall("m1"), ok({ title: 99 })], dispatch: [() => ({ response: { value: tagsValue("m1") } })] },
          "committed-delivery-error": { polls: [tagsCall("m1"), { kind: "pending" }], dispatch: [() => ({ response: { value: tagsValue("m1") }, deliveryError: "plugin-retired" })] },
          "committed-then-abort": { polls: [tagsCall("m1"), { kind: "pending" }, { kind: "pending" }], pendingForever: true, dispatch: [() => ({ response: { value: tagsValue("m1") } })] },
          "mixed": { polls: [tagsCall("m1"), tagsCall("m2"), tagsCall("m3"), ok({ title: "mixed" })], dispatch: [() => ({ response: { value: tagsValue("m1") } }), () => ({ response: { error: "plugin-export-write-failed" } }), () => ({ response: { error: "plugin-permission-denied" } })] },
          "readonly-ok": { polls: [ok({ title: "first", text: "first run" })], dispatch: [] },
          "second-ok": { polls: [ok({ title: "B", text: "second run" })], dispatch: [] },
          "name-conflict": { polls: [call("knowledge.create", { title: "T", content: "" }), ok({ title: "done" })], dispatch: [() => ({ response: { error: JSON.stringify({ code: "knowledge-name-conflict", message: "A document with this name already exists" }) } })] },
          "settings-form": { polls: [ok({ title: "Round settings", fields: [{ id: "title", label: "Title", value: "before" }], actions: [{ id: "save", label: "Save" }] }), call("data.set", { schemaVersion: 1, revision: 1, settings: { title: "after" }, cache: {} }), ok({ title: "Round settings", text: "saved", fields: [{ id: "title", label: "Title", value: "after" }], actions: [{ id: "save", label: "Save" }] })], dispatch: [() => ({ response: { value: { schemaVersion: 1, revision: 1 } } })] },
          "deferred-write": { polls: [call("data.set", { schemaVersion: 1, revision: 1, settings: {}, cache: {} }), { kind: "pending" }], pendingForever: true, dispatch: [() => new Promise(resolve => { window.__deferred.dispatch = () => resolve({ response: { value: { schemaVersion: 1, revision: 1 } } }); })] },
        };
        let current = null; let polls = 0; let dispatches = 0;
        window.__useScenario = (name) => { current = scenarios[name]; polls = 0; dispatches = 0; if (!current) throw new Error("unknown scenario " + name); };
        window.__invoke = async (cmd, args) => {
          if (cmd === "manage_extension_packages") return { revision: 1, hostVersion: "1.9.2", packages: [${JSON.stringify(PACKAGE)}] };
          if (cmd === "list_canvases") return [];
          if (cmd !== "extension_runtime") throw new Error("unexpected " + cmd);
          const req = JSON.parse(args.request);
          if (req.op === "start") return { token: "t" };
          if (req.op === "close") return {};
          if (req.op === "poll") { const m = current.polls[polls]; if (m === undefined) { return current.pendingForever ? { kind: "pending" } : fail("scenario-exhausted"); } if (m.kind !== "pending") polls++; else if (!current.pendingForever) polls++; return m; }
          if (req.op === "dispatch") { window.__dispatches++; const fn = current.dispatch[dispatches++]; if (!fn) throw new Error("no dispatch scripted"); return await fn(); }
          return {};
        };
        window.__confirmMode = "true";
        window.__confirm = (message) => { window.__confirmCalls = (window.__confirmCalls || 0) + 1; if (window.__confirmMode === "defer") return new Promise(r => { window.__resolveConfirm = r; }); return Promise.resolve(window.__confirmMode === "true"); };
        await extensionPackages.refresh();
        createRoot(document.getElementById("root")).render(<I18nProvider locale="zh-CN"><PluginEntryMenu /></I18nProvider>);
        window.__open = () => openPlugin("test.round", "run");
        window.__openSettings = () => openPlugin("test.round", "settings");
        document.body.dataset.ready = "1";
      `,
      resolveDir: root, loader: "tsx",
    },
    bundle: true, platform: "browser", format: "esm", jsx: "automatic", outfile: "app.js", write: false, logLevel: "silent",
    loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "stubs", setup(b) {
        const map = new Map([
          ["@tauri-apps/api/core", "export const invoke = (cmd, args) => window.__invoke(cmd, args);"],
          ["@tauri-apps/plugin-dialog", "export const confirm = (m) => window.__confirm(m); export const save = async () => 'C:/out/c.svg';"],
          ["../../core/services/materials", "export const listLegacyMaterialAssets = async () => [{ id: 'm1', name: 'asset-m1.png', kind: 'image', mimeType: 'image/png', revision: 'r1', storageMode: 'managed', tagIds: [] }, { id: 'm2', name: 'asset-m2.png', kind: 'image', mimeType: 'image/png', revision: 'r1', storageMode: 'managed', tagIds: [] }, { id: 'm3', name: 'asset-m3.png', kind: 'image', mimeType: 'image/png', revision: 'r1', storageMode: 'managed', tagIds: [] }]; export const listLegacyFilteredMaterialAssets = listLegacyMaterialAssets;"],
          ["../../core/services/knowledge", "export const listKnowledgeDocuments = async () => []; export const searchKnowledgeDocuments = async () => []; export const ensureActiveKnowledgeUiSource = async () => ({ vaultId: 'v', sourceEpoch: 1 }); export const knowledgeDocumentNoteId = (ref) => 'kdoc-' + ref.relativePath;"],
          ["../../core/services/knowledgeSource", "const source = { mode: 'real-vault', vaultId: 'v' }; export const readActiveKnowledgeWriteSource = () => source;"],
          ["../../core/services/context", "export const focusEntity = () => {};"],
        ]);
        b.onResolve({ filter: /^(@tauri-apps\/api\/core|@tauri-apps\/plugin-dialog|\.\.\/\.\.\/core\/services\/(materials|knowledge|knowledgeSource|context))$/ }, (args) => map.has(args.path) ? { path: args.path, namespace: "stub" } : null);
        b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: map.get(args.path), loader: "js" }));
      },
    }],
  });
  const appJs = built.outputFiles[0].text;
  const TOKENS = ":root{--bg-elevated:#fff;--bg-base:#fff;--bg-hover:#f0f0f4;--border:#dcdce4;--text-primary:#1c1c22;--text-secondary:#4c4c58;--accent:#4f6ef7;--accent-muted:#e6eaff;--warning:#b57f24;--danger:#c0554d;--radius-md:10px;--radius-sm:6px;--fs-xs:10px;--fs-sm:11px;--fs-md:12px;--fs-lg:14px;--space-2:6px;--space-3:8px;--space-4:10px;--space-5:12px;--space-6:14px;--space-7:16px;--space-8:20px}body{margin:16px;font:13px system-ui}";
  const server = http.createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(appJs); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<meta charset="utf-8"><style>${TOKENS}${cssText}</style><div id="root"></div><script type="module" src="/app.js"></script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const results = [];
  const dialog = (page) => page.locator(".plugin-dialog");
  const round = (page) => page.locator(".plugin-round");
  const text = async (loc) => (await loc.count()) ? (await loc.allInnerTexts()).join("\n") : "";

  async function openRun(page, scenario, { writes = false, pick = ["asset-m1.png"] } = {}) {
    await page.evaluate((name) => window.__useScenario(name), scenario);
    if (!(await dialog(page).count())) { await page.evaluate(() => window.__open()); await dialog(page).waitFor(); }
    for (const name of pick) { const box = dialog(page).locator(`.plugin-pick:has-text("${name}") input`); await box.waitFor(); if (!(await box.isChecked())) await box.check(); }
    const writesBox = dialog(page).locator('.plugin-run-consents label:has-text("允许本次写入") input');
    if ((await writesBox.isChecked()) !== writes) await writesBox.click();
    await dialog(page).locator('.plugin-run-bar button:has-text("运行")').click();
  }
  async function scenario(name, fn) {
    if (only && only !== name) return;
    const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
    try {
      await page.goto(base); await page.waitForSelector('body[data-ready="1"]');
      await fn(page);
      results.push({ scenario: name, ok: true }); console.log(`[ok]   ${name}`);
    } catch (error) {
      results.push({ scenario: name, ok: false, error: String(error?.message || error), round: await text(round(page)), notice: await text(page.locator(".plugin-notice")) });
      console.log(`[FAIL] ${name}: ${String(error?.message || error).split("\n")[0]}`);
    } finally { await page.close(); }
  }

  // 1. transport failure on a write: unknown, never "not performed", no auto retry
  await scenario("ipc-broken-write-is-unknown-not-refused", async (page) => {
    await openRun(page, "ipc-broken", { writes: true });
    await round(page).waitFor(); await page.waitForFunction(() => !document.querySelector(".plugin-running"));
    const unknown = round(page).locator("li.is-unconfirmed");
    assert.equal(await unknown.count(), 1, "one unknown entry for the write");
    assert.match(await unknown.innerText(), /宿主未回报结果|结果未知/);
    assert.match(await unknown.innerText(), /ipc-broken/, "raw diagnostic stays visible with the unknown entry");
    assert.doesNotMatch(await text(round(page)), /未执行|not performed/, "an unknown write must not also be shown as not performed");
    assert.doesNotMatch(await text(page.locator(".plugin-notice")), /重试/);
    assert.equal(await page.evaluate(() => window.__dispatches), 1, "no automatic retry of the write");
  });
  // 2. unknown native error code: conservative unknown
  await scenario("unknown-native-error-stays-unknown", async (page) => {
    await openRun(page, "unknown-native", { writes: true });
    await round(page).waitFor(); await page.waitForFunction(() => !document.querySelector(".plugin-running"));
    assert.equal(await round(page).locator("li.is-unconfirmed").count(), 1);
    assert.match(await round(page).locator("li.is-unconfirmed").innerText(), /plugin-export-write-failed/);
    assert.doesNotMatch(await text(round(page)), /未执行|not performed/);
  });
  // 3. proven pre-execution refusal: not performed + reason, nothing confirmed
  await scenario("refused-write-shows-not-performed-with-reason", async (page) => {
    await openRun(page, "refused", { writes: true });
    await round(page).waitFor(); await page.waitForFunction(() => !document.querySelector(".plugin-running"));
    assert.equal(await round(page).locator("li.is-failed").count(), 1);
    assert.match(await round(page).locator("li.is-failed").innerText(), /未执行/);
    assert.match(await round(page).locator("li.is-failed").innerText(), /未被授权/);
    assert.equal(await round(page).locator("li.is-unconfirmed").count(), 0);
    assert.equal(await round(page).locator("li.is-confirmed").count(), 0);
  });
  // 4. committed then plugin throw / invalid UI / deliveryError / abort: confirmed record kept
  for (const [name, expectRoundClass] of [["committed-then-throw", "is-failed"], ["committed-then-invalid-ui", "is-failed"], ["committed-delivery-error", "is-failed"]]) {
    await scenario(`${name}-keeps-confirmed-write`, async (page) => {
      await openRun(page, name, { writes: true });
      await round(page).waitFor(); await page.waitForFunction(() => !document.querySelector(".plugin-running"));
      assert.ok((await round(page).getAttribute("class")).includes(expectRoundClass), `round is ${expectRoundClass}`);
      assert.equal(await round(page).locator("li.is-confirmed").count(), 1, "the committed write stays listed");
      assert.match(await round(page).locator("li.is-confirmed").innerText(), /asset-m1\.png/);
      assert.doesNotMatch(await text(round(page)), /没有写入|未执行/);
      assert.equal(await dialog(page).locator(".plugin-output").count(), 0, "no stale plugin UI for a failed round");
      assert.doesNotMatch(await text(page.locator(".plugin-notice")), /重试/);
    });
  }
  await scenario("committed-then-abort-keeps-confirmed-write", async (page) => {
    await openRun(page, "committed-then-abort", { writes: true });
    await round(page).locator("li.is-confirmed").waitFor();
    await dialog(page).locator('.plugin-run-bar button:has-text("终止")').click();
    await page.waitForFunction(() => document.querySelector(".plugin-round.is-cancelled"));
    assert.equal(await round(page).locator("li.is-confirmed").count(), 1);
    assert.doesNotMatch(await text(round(page)), /没有写入|未执行/);
  });
  // 5. same method, three calls: confirmed + unknown + refused each visible
  await scenario("mixed-same-method-calls-keep-each-result", async (page) => {
    await openRun(page, "mixed", { writes: true, pick: ["asset-m1.png", "asset-m2.png", "asset-m3.png"] });
    await round(page).waitFor(); await page.waitForFunction(() => !document.querySelector(".plugin-running"));
    assert.equal(await round(page).locator("li.is-confirmed").count(), 1, "m1 confirmed");
    assert.equal(await round(page).locator("li.is-unconfirmed").count(), 1, "m2 unknown");
    assert.equal(await round(page).locator("li.is-failed").count(), 1, "m3 refused");
    assert.match(await round(page).locator("li.is-unconfirmed").innerText(), /asset-m2\.png|m2/);
    assert.doesNotMatch(await round(page).locator("li.is-unconfirmed").innerText(), /未执行/);
  });
  // 6a. cancelled confirmation: no new round, previous result kept
  await scenario("cancelled-confirmation-keeps-previous-round", async (page) => {
    await openRun(page, "readonly-ok");
    await dialog(page).locator(".plugin-output h3").waitFor();
    await page.evaluate(() => { window.__confirmMode = "false"; });
    await openRun(page, "ipc-broken", { writes: true });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__confirmCalls), 1, "confirmation was asked once");
    assert.equal(await dialog(page).locator(".plugin-output h3").innerText(), "first", "previous result stays");
    assert.ok((await round(page).getAttribute("class")).includes("is-done"), "previous round stays done");
    assert.equal(await page.evaluate(() => window.__dispatches), 0, "nothing was dispatched");
  });
  // 6b. stopped run: its late dispatch result must not touch the next round
  await scenario("stopped-run-late-result-does-not-touch-next-round", async (page) => {
    await openRun(page, "deferred-write");
    await dialog(page).locator(".plugin-running").waitFor();
    await dialog(page).locator('.plugin-run-bar button:has-text("终止")').click();
    await page.waitForFunction(() => !document.querySelector(".plugin-running"));
    await openRun(page, "second-ok");
    await page.waitForFunction(() => document.querySelector(".plugin-output h3")?.textContent === "B");
    await page.evaluate(() => window.__deferred.dispatch());
    await page.waitForTimeout(600);
    assert.equal(await dialog(page).locator(".plugin-output h3").innerText(), "B", "run B's UI survives run A's late result");
    assert.ok((await round(page).getAttribute("class")).includes("is-done"), "run B's round stays done");
    assert.equal(await round(page).locator("li.is-confirmed").count(), 0, "run A's late outcome is not attributed to run B");
  });
  // 6b2. CANCEL1: stop during a pending preflight and start NOTHING afterwards — the late
  // preflight answer must not continue the UI: no new dialog, no round reset, no dispatch,
  // and the previous round's result and host record stay exactly as they were.
  await scenario("stopped-preflight-without-successor-keeps-previous-round", async (page) => {
    await openRun(page, "readonly-ok");
    await dialog(page).locator(".plugin-output h3").waitFor();
    await page.waitForFunction(() => document.querySelector(".plugin-round.is-done"));
    await page.evaluate(() => { window.__confirmMode = "defer"; });
    await openRun(page, "ipc-broken", { writes: true });
    await page.waitForFunction(() => typeof window.__resolveConfirm === "function" && !!document.querySelector(".plugin-running"));
    await dialog(page).locator('.plugin-run-bar button:has-text("终止")').click();
    await page.waitForFunction(() => !document.querySelector(".plugin-running"));
    const roundClassBefore = await round(page).getAttribute("class");
    await page.evaluate(() => window.__resolveConfirm(true));
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.__confirmCalls), 1, "no further confirmation popped after the stop");
    assert.equal(await page.evaluate(() => window.__dispatches), 0, "the stopped run never reaches runPlugin");
    assert.equal(await dialog(page).locator(".plugin-output h3").innerText(), "first", "previous round's UI must not be cleared");
    assert.equal(await round(page).getAttribute("class"), roundClassBefore, "round state must be untouched (no reset, no cancelled flip)");
    assert.equal(await round(page).locator("li.is-confirmed").count(), 0, "no phantom round record appears");
  });
  // 6c. preflight interleave: run A stopped while its confirmation is pending; run B completes; A's confirmation resolves later
  await scenario("stopped-preflight-cannot-reset-next-round", async (page) => {
    await page.evaluate(() => { window.__confirmMode = "defer"; });
    await openRun(page, "ipc-broken", { writes: true });
    await page.waitForFunction(() => typeof window.__resolveConfirm === "function");
    await dialog(page).locator('.plugin-run-bar button:has-text("终止")').click();
    await page.waitForFunction(() => !document.querySelector(".plugin-running"));
    await page.evaluate(() => { window.__confirmMode = "true"; });
    await openRun(page, "second-ok", { writes: false });
    await page.waitForFunction(() => document.querySelector(".plugin-output h3")?.textContent === "B");
    await page.evaluate(() => window.__resolveConfirm(true));
    await page.waitForTimeout(700);
    assert.equal(await dialog(page).locator(".plugin-output h3").count(), 1, "run B's UI must not be cleared by run A's late preflight");
    assert.equal(await dialog(page).locator(".plugin-output h3").innerText(), "B");
    assert.ok((await round(page).getAttribute("class")).includes("is-done"), "run B's round must not be reset to running");
    assert.equal(await page.evaluate(() => window.__dispatches), 0, "stopped run A never dispatches its write");
  });

  // 7. a definite native refusal delivered as a JSON-shaped domain error (knowledge-name-conflict) must read as not performed, in Chinese, never as unknown or raw JSON
  await scenario("json-domain-refusal-reads-as-not-performed", async (page) => {
    await page.evaluate((name) => window.__useScenario(name), "name-conflict");
    await page.evaluate(() => window.__open()); await dialog(page).waitFor();
    await dialog(page).locator('.plugin-run-consents label:has-text("允许在当前知识库创建笔记") input').check();
    await dialog(page).locator('.plugin-run-consents label:has-text("允许本次写入") input').check();
    await dialog(page).locator('.plugin-run-bar button:has-text("运行")').click();
    await round(page).waitFor(); await page.waitForFunction(() => !document.querySelector(".plugin-running"));
    assert.equal(await round(page).locator("li.is-failed").count(), 1, "name conflict is a refusal");
    assert.match(await round(page).locator("li.is-failed").innerText(), /未执行/);
    assert.match(await round(page).locator("li.is-failed").innerText(), /同名/);
    assert.equal(await round(page).locator("li.is-unconfirmed").count(), 0, "not shown as unknown");
    assert.doesNotMatch(await text(round(page)), /\{"code"/, "no raw JSON in the round record");
  });
  // 8. a settings entry shows its form immediately (no object pickers, no run button), and saving works
  await scenario("settings-entry-shows-form-without-run-ceremony", async (page) => {
    await page.evaluate((name) => window.__useScenario(name), "settings-form");
    await page.evaluate(() => window.__openSettings()); await dialog(page).waitFor();
    await dialog(page).locator(".plugin-field input").waitFor({ timeout: 8000 });
    assert.equal(await dialog(page).locator(".plugin-picker").count(), 0, "settings need no object pickers");
    assert.equal(await dialog(page).locator('.plugin-run-bar button:has-text("运行")').count(), 0, "settings need no run button");
    assert.equal(await dialog(page).locator(".plugin-field input").inputValue(), "before");
    await dialog(page).locator(".plugin-field input").fill("after");
    await dialog(page).locator('.plugin-actions button:has-text("Save")').click();
    await round(page).locator("li.is-confirmed").waitFor({ timeout: 8000 });
    assert.match(await round(page).locator("li.is-confirmed").innerText(), /已保存插件自有设置/);
    assert.equal(await dialog(page).locator(".plugin-field input").inputValue(), "after", "saved value echoed");
  });

  await browser.close(); server.close();
  const failed = results.filter((r) => !r.ok);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.scenario) }));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
