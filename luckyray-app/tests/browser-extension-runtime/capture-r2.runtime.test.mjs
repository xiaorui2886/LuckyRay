import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBrowser, launchChromium, stopChromium } from "./lib/browser-launcher.mjs";
import { startFakeTransport, findFreePortsInRange } from "./lib/fake-local-transport.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright");
const sharp = require(process.env.LUCKYRAY_SHARP_MODULE || "sharp");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const article = `<!doctype html><html><head><meta charset="utf-8"><title>Capture R2 · 文章夹具</title><style>body{margin:0;background:#fff;color:#141414;font:18px/1.7 sans-serif}nav{height:48px;background:#ccc}article{width:75%;margin:40px auto}.ads{background:red}.css-hidden{display:none}.fixed{position:fixed;top:0;right:0;background:#ff0000;width:40px;height:40px}.tile{height:360px}.bottom{height:100px;background:#00aa00}</style></head><body><nav>导航 广告 不应该进入正文</nav><div class="fixed">固定</div><article><h1>正文提取标题</h1><p>这是一段常见文章正文，保留段落和 <strong>加粗内容</strong>，以及 <a href="/source?q=works#part">来源链接</a>。我们使用一篇足够长的文章来检查导航广告被移除，而正文保留原始结构。</p><h2>列表与引用</h2><ul><li>第一个条目</li><li>第二个条目<ul><li>嵌套条目</li></ul></li></ul><blockquote><p>引用段落与来源。</p></blockquote><pre><code class="language-js">const value = "safe";



  console.log(value);</code></pre><img loading="lazy" src="/image.png" alt="附图说明" width="160" height="80"><div class="ads">广告内容</div><p class="css-hidden">CSS隐藏付费正文不能泄露</p><a href="javascript:alert(1)">危险链接保留文字</a><img src="https://private.test/image?token=secret" alt="signed private image"><script>globalThis.fixtureScriptRan=true</script>${Array.from({ length: 9 }, (_, i) => `<p class="tile" id="tile-${i}" style="background:hsl(${i * 35} 50% 90%)">文章长页第 ${i + 1} 屏，用于检查整页拼接和懒加载图。正文段落在实际 DOM 中可见，采集操作不会获取任何 cookie 或登录资料。</p>`).join("")}</article><div class="bottom">底部完整性标记</div><footer>Footer噪音</footer></body></html>`;

test("CAPTURE-R2 isolated MV3: article and permission boundary; native screenshot supplement is opt-in", { timeout: 180000 }, async () => {
  let launched, browser, server, transport, panel;
  const evidence = process.env.LUCKYRAY_QA_ARTIFACTS || path.join(root, "output/playwright/capture-r2");
  const saved = [], receipts = new Map();
  let offline = false;
  try {
    await fs.mkdir(evidence, { recursive: true });
    const png = await sharp({ create: { width: 160, height: 80, channels: 3, background: "#4788dd" } }).png().toBuffer();
    server = createServer((req, res) => {
      if (req.url === "/image.png") { res.setHeader("Content-Type", "image/png"); res.end(png); return; }
      res.setHeader("Content-Type", "text/html;charset=utf-8");
      res.end(req.url === "/empty" ? "<!doctype html><title>无正文</title><nav><a href='/'>只有导航链接</a></nav>" : req.url === "/huge" ? "<!doctype html><title>Huge</title><div style='height:90000px'>超长页面</div>" : article);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const sourceUrl = `http://127.0.0.1:${server.address().port}/article`;
    const [port] = await findFreePortsInRange(1);
    transport = await startFakeTransport({ port, protectedRoute: async ({ path: route, method, body }) => {
      if (!route.startsWith("/api/material-libraries")) return null;
      if (offline) return { status: 503, payload: { ok: false, error: { code: "app-unavailable" } } };
      const input = body ? JSON.parse(body) : {};
      const output = route === "/api/material-libraries" ? { consumerVersion: 1, legacyLibraryId: "lib-A", libraries: ["A", "B"].map(id => ({ libraryId: `lib-${id}`, name: `素材库 ${id}`, state: "ready", visible: true, capabilities: { read: true, import: true, organize: true, files: false } })) }
        : route.endsWith("/taxonomy") ? { consumerVersion: 1, libraryId: input.libraryId, requestId: input.requestId, folders: [{ id: `${input.libraryId}-folder`, name: "网页参考" }], tags: [{ id: `${input.libraryId}-tag`, name: "参考" }] }
        : { consumerVersion: 1, libraryId: input.libraryId, requestId: input.requestId, assetId: `fixture-${saved.length}`, assetName: input.name, disposition: "imported", changed: true, view: { available: false } };
      if (route.endsWith("/import-bytes")) {
        assert.equal(method, "POST"); assert.equal(input.mimeType, "image/png");
        assert(input.libraryId === "lib-A" || input.libraryId === "lib-B");
        const bytes = Buffer.from(input.bytesBase64, "base64");
        const info = await sharp(bytes).metadata(); assert(info.width > 0 && info.height > 0);
        if (receipts.has(input.requestId)) return { payload: { ok: true, data: receipts.get(input.requestId) } };
        saved.push({ ...input, bytes, width: info.width, height: info.height }); receipts.set(input.requestId, output);
      }
      return { payload: { ok: true, data: output } };
    } });
    launched = await launchChromium({ browser: discoverBrowser(), extensionPath: path.join(root, "browser-extension-prototype"), headless: process.env.LUCKYRAY_QA_VISIBLE !== "1" });
    browser = await chromium.connectOverCDP(launched.wsUrl.replace(/^http:/, "ws:"));
    const context = browser.contexts()[0];
    let worker;
    for (let i = 0; i < 160 && !worker; i++) { for (const w of context.serviceWorkers()) if (w.url().endsWith("/background.js") && await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => "") === "LuckyRay Collector") worker = w; if (!worker) await sleep(100); }
    assert(worker, "production extension worker loads");
    // Main development stays running. Keep the real bootstrap/proof/fetch
    // implementation, but deny network access to every non-fixture loopback
    // port BEFORE any panel subscribes or issues protected requests.
    await worker.evaluate(port => {
      const network = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.protocol !== "data:" && !(url.hostname === "127.0.0.1" && Number(url.port) === port)) return Promise.resolve(new Response("isolated test port only", { status: 503 }));
        return network(input, init);
      };
      const nativeCapture = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
      chrome.tabs.captureVisibleTab = async (...args) => { try { return await nativeCapture(...args); } catch (error) { globalThis.qaCaptureError = error.message; throw error; } };
    }, port);
    const extensionId = new URL(worker.url()).host;
    const source = context.pages()[0] || await context.newPage();
    await source.goto(sourceUrl); await source.bringToFront();
    const sourceTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), sourceUrl);
    assert(sourceTab?.id);
    // A dedicated extension window preserves the active source tab needed by
    // captureVisibleTab. This is the same window creation used by the popup.
    if (process.env.LUCKYRAY_QA_VISIBLE === "1") {
      console.log("ACTION WINDOW READY: Capture R2 · 文章夹具. Invoke native Alt+Shift+L once to grant existing activeTab.");
      const began = Date.now();
      while (!panel && Date.now() - began < 90000) { panel = context.pages().find(p => p.url().includes("capture.html")); if (!panel) await sleep(300); }
    } else {
      await worker.evaluate(async ({ extensionId, tabId }) => chrome.windows.create({ url: `chrome-extension://${extensionId}/capture.html?tabId=${tabId}&mode=article`, type: "popup", width: 760, height: 840 }), { extensionId, tabId: sourceTab.id });
      panel = context.pages().find(p => p.url().includes("capture.html")) || await context.waitForEvent("page", { predicate: p => p.url().includes("capture.html") });
    }
    assert(panel); await panel.waitForLoadState();
    const errors = []; panel.on("pageerror", error => errors.push(error.message));
    await panel.locator("#start").click(); await panel.locator("#preview").waitFor({ state: "visible", timeout: 12000 }).catch(async error => { console.log("panel", await panel.locator("#status").textContent(), await panel.evaluate(() => send({ type: "luckyray-capture-libraries" })), await worker.evaluate(() => ({ worker: chrome.runtime.getManifest().name, controller: typeof pageCapture })), "routes", transport.calls.map(c => `${c.method} ${c.path} ${c.authValid}`)); throw error; });
    const markdown = await panel.locator("#article-preview").textContent();
    assert.match(markdown, /## 列表与引用/); assert.match(markdown, /- 第一个条目/); assert.match(markdown, /> 引用段落/); assert.match(markdown, /```js\nconst value/);
    assert.match(markdown, /const value = "safe";\n\n\n\n  console.log\(value\);/, "code whitespace is not collapsed with paragraph spacing");
    assert.match(markdown, /source\?q=works#part/); assert.match(markdown, /!\[附图说明\]/);
    assert(!markdown.includes("广告内容") && !markdown.includes("CSS隐藏付费正文") && !markdown.includes("javascript:") && !markdown.includes("token=secret") && !markdown.includes("fixtureScriptRan"));
    await panel.locator("#title").fill("正文剪藏验收");
    await panel.screenshot({ path: path.join(evidence, "01-article-preview.png") });
    await panel.locator("#save").click(); await panel.locator("#receipt").waitFor({ state: "visible" });
    assert.match(await panel.locator("#receipt-text").textContent(), /已写入知识库 fixture-vault/);
    const noteCalls = transport.calls.filter(c => c.path === "/api/notes/capture");
    assert.equal(noteCalls.length, 1); const note = JSON.parse(noteCalls[0].body);
    assert.equal(note.content, markdown); assert.equal(note.title, "正文剪藏验收"); assert.equal(note.binding.activation.vaultId, "fixture-vault");

    async function start(mode, library = "lib-A") {
      if (await panel.locator("#receipt").isVisible()) await panel.locator("#again").click();
      if (await panel.locator("#mode").isDisabled()) {
        await panel.locator("#restart").click();
      }
      await panel.locator("#mode").selectOption(mode);
      if (mode !== "article") await panel.locator("#library").selectOption(library);
      await source.bringToFront(); await panel.bringToFront(); await panel.locator("#start").click();
    }
    async function preview() { await panel.locator("#image-preview").waitFor({ state: "visible", timeout: 15000 }).catch(async error => { console.log("screenshot error", await panel.evaluate(() => ({ stage: draft?.stage, code: draft?.code })), await worker.evaluate(() => globalThis.qaCaptureError)); throw error; }); await panel.waitForFunction(() => draft?.stage === "preview" && !document.getElementById("save").disabled); }
    async function savePng(file) {
      const img = await panel.locator("#image-preview").getAttribute("src");
      const bytes = Buffer.from(img.split(",")[1], "base64"); await fs.writeFile(path.join(evidence, file), bytes);
      await panel.locator("#title").fill(file.replace(/\.png$/, "")); await panel.locator("#save").click(); await panel.locator("#receipt").waitFor({ state: "visible" });
      return sharp(bytes).metadata();
    }
    if (process.env.LUCKYRAY_QA_VISIBLE !== "1") {
      // Headless opening is not a native user invocation. Assert denial, never
      // add <all_urls>, fake an activeTab grant, or fabricate screenshot success.
      await source.evaluate(() => { const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(document.querySelector("blockquote")); selection.removeAllRanges(); selection.addRange(range); });
      await start("article"); await panel.locator("#preview").waitFor({ state: "visible" });
      assert.equal(await panel.locator("#article-preview").textContent(), "引用段落与来源。");
      await source.evaluate(() => getSelection().removeAllRanges());
      await source.goto(`http://127.0.0.1:${server.address().port}/empty`); await start("article");
      await panel.locator("#link-fallback").waitFor({ state: "visible" }); assert.equal(await panel.locator("#save").isDisabled(), true);
      await panel.locator("#as-link").check(); await panel.locator("#save").click(); await panel.locator("#receipt").waitFor({ state: "visible" });
      await source.goto(sourceUrl); await start("visible", "lib-B");
      await panel.waitForFunction(() => draft?.stage === "failed");
      assert.equal(await panel.evaluate(() => draft.code), "capture-user-invocation-required");
      assert.equal(saved.length, 0, "no screenshot import after missing native grant");
      assert.equal(await source.evaluate(() => typeof globalThis.chrome?.runtime?.sendMessage), "undefined");
      assert.deepEqual(errors, []);
      await fs.writeFile(path.join(evidence, "runtime-results.json"), JSON.stringify({ browser: launched.product, source: "synthetic-local-page", transport: "HMAC-verified fixture, not desktop storage", cases: ["article-markdown-safe", "note-fixture-receipt", "visible-selection-fallback", "empty-link-fallback", "native-invocation-required-zero-write"], screenshots: "NOT ACCEPTED: native activeTab/DPR/region/element/full-page and real material storage require separate acceptance" }, null, 2));
      return;
    }
    await start("visible", "lib-B"); await preview();
    await panel.locator("#folder").selectOption("lib-B-folder"); await panel.locator("#tags input").check();
    await panel.screenshot({ path: path.join(evidence, "02-visible-preview.png") });
    const viewport = await savePng("03-visible.png");
    assert.equal(saved.at(-1).libraryId, "lib-B"); assert.equal(saved.at(-1).targetFolderId, "lib-B-folder"); assert.deepEqual(saved.at(-1).tagIds, ["lib-B-tag"]);
    assert.equal(saved.at(-1).sourcePageUrl, sourceUrl);
    const cdp = await context.newCDPSession(source);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 2, mobile: false });
    await start("region");
    await source.locator("[data-luckyray-page-picker]").waitFor({ state: "visible" });
    await source.mouse.move(100, 120); await source.mouse.down(); await source.mouse.move(380, 340, { steps: 12 }); await source.mouse.up();
    await preview(); const region = await savePng("04-region-dpr2.png"); assert.equal(region.width, 560); assert.equal(region.height, 440);
    await start("element"); await source.locator("[data-luckyray-page-picker]").waitFor({ state: "visible" }); await source.mouse.move(200, 280); await source.mouse.click(200, 280); await preview(); const element = await savePng("05-element-dpr2.png"); assert(element.width > 0 && element.height > 0);
    await start("region"); await source.locator("[data-luckyray-page-picker]").waitFor({ state: "visible" }); await source.keyboard.press("Escape"); await panel.waitForFunction(() => draft?.stage === "failed");
    assert.match(await panel.locator("#status").textContent(), /取消/);
    assert.equal(await source.locator("body > div").count(), 1, "picker is removed after Esc (fixed fixture stays)");
    await source.evaluate(() => window.scrollTo(0, 420));
    const pageHeight = await source.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    await start("full"); await preview(); const full = await savePng("06-full-dpr2.png");
    assert.equal(full.width, 1800); assert.equal(full.height, pageHeight * 2); assert.equal(await source.evaluate(() => scrollY), 420);
    assert.equal(await source.locator(".fixed").evaluate(n => n.style.visibility), "");
    const raw = await sharp(saved.at(-1).bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const bottom = (raw.info.height - 20) * raw.info.width * raw.info.channels;
    assert(raw.data[bottom + 1] > 100 && raw.data[bottom] < 30, "last row reaches the real green page footer without silent truncation");
    await source.goto(`http://127.0.0.1:${server.address().port}/huge`); await start("full");
    await panel.waitForFunction(() => draft?.stage === "failed"); assert.match(await panel.locator("#status").textContent(), /上限/);
    await source.goto(`http://127.0.0.1:${server.address().port}/empty`); await start("article");
    await panel.locator("#link-fallback").waitFor({ state: "visible" }); assert.equal(await panel.locator("#save").isDisabled(), true);
    await panel.locator("#as-link").check(); await panel.locator("#save").click(); await panel.locator("#receipt").waitFor({ state: "visible" });
    await source.goto(sourceUrl); await start("visible"); await preview(); await source.goto(sourceUrl + "?changed=1");
    const before = saved.length; await panel.locator("#save").click(); await panel.waitForFunction(() => draft?.stage === "failed"); assert.equal(saved.length, before);
    await source.goto(sourceUrl); offline = true; await start("visible"); await panel.waitForFunction(() => draft?.stage === "preview");
    await panel.waitForFunction(() => document.getElementById("status").textContent.includes("分类信息读取失败")); assert.equal(await panel.locator("#save").isDisabled(), true); offline = false;
    // Untrusted MAIN-page and content-script messages cannot launch or commit.
    assert.equal(await source.evaluate(() => typeof globalThis.chrome?.runtime?.sendMessage), "undefined");
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(evidence, "runtime-results.json"), JSON.stringify({ browser: launched.product, source: "synthetic-local-page", transport: "HMAC-verified fixture", cases: ["article-markdown-safe", "note-receipt", "visible", "region-dpr2", "element-dpr2", "esc-cancel", "full-dpr2-bottom-scroll-restore", "size-limit", "link-fallback", "navigation-zero-write", "offline-taxonomy-zero-write"], saved: saved.map(s => ({ libraryId: s.libraryId, requestId: s.requestId, name: s.name, width: s.width, height: s.height, size: s.bytes.length })) }, null, 2));
  } finally {
    if (panel && !panel.isClosed()) await panel.screenshot({ path: path.join(evidence, "last-panel.png") }).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (launched) await stopChromium(launched);
    if (transport) await transport.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
