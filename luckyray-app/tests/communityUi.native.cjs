// Real Community React UI + actual fixture IPC/domain services. Never connects to Main.
// Start the already-built --extension-community-fixture with CDP 4283, then run this file.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const out = process.env.COMMUNITY_UI_EVIDENCE || "./test-results/community-ui";
const report = { kind: "actual-native-community-fixture", checks: [], errors: [], screenshots: [], limitations: [] };
fs.mkdirSync(path.join(out, "screenshots"), { recursive: true });
(async () => {
  let portOccupied = false;
  try { portOccupied = (await fetch("http://127.0.0.1:4283/json/version", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
  assert.equal(portOccupied, false, "owned test port 4283 is already occupied; do not connect to another job");
  const child = spawn(path.join(out, "cache/native/debug/luckyray-app.exe"), ["--extension-community-fixture", path.join(root, "target/extension-community-fixture")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LUCKYRAY_APP_PROFILE: "", LUCKYRAY_FIXTURE_TIMEOUT_SECS: "900", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=4283" } });
  const hostLog = fs.createWriteStream(path.join(out, "native-ui-host.log")); child.stdout.pipe(hostLog); child.stderr.pipe(hostLog);
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch("http://127.0.0.1:4283/json/version")).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.connectOverCDP("http://127.0.0.1:4283");
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent("page", { timeout: 15000 });
  await page.waitForURL("http://fixture.localhost/**", { timeout: 15000 });
  assert.ok(page.url().startsWith("http://fixture.localhost/"), "only the owned fixture WebView may be tested");
  page.on("pageerror", error => report.errors.push(String(error)));
  const step = async (name, fn) => { await fn(); report.checks.push(name); console.log(`PASS ${name}`); };
  const shot = async name => { const file = `screenshots/${name}.png`; await page.screenshot({ path: path.join(out, file), fullPage: true }); report.screenshots.push(file); };
  const tab = key => page.evaluate(key => { location.hash = `#community?tab=${key}`; }, key);
  const ready = async () => { await page.waitForFunction(() => document.body.dataset.fixtureReady === "1"); await page.locator(".community-tabs").waitFor(); };
  const install = async file => {
    await page.locator('.community-install input[type="file"]').setInputFiles(path.join(root, file));
    await page.waitForFunction(() => document.querySelector('.community-install input').disabled === false);
  };
  const list = () => page.evaluate(async () => window.__fixtureInvoke("manage_extension_packages", { request: JSON.stringify({ op: "list" }) }));
  const setBase = async theme => { await page.evaluate(theme => { const settings = JSON.parse(localStorage.getItem("luckyray-settings-v1") || "{}"); settings["general.theme"] = theme; localStorage.setItem("luckyray-settings-v1", JSON.stringify(settings)); }, theme); await page.reload(); await ready(); };
  try {
    await ready();
    report.fixture = await page.evaluate(() => window.__fixture.status);
    assert.equal(report.fixture.pid, child.pid, "the connected native window must belong to this test process");
    report.knowledgeActivation = await page.evaluate(() => window.__fixture.knowledge);
    assert.match(report.fixture.identifier, /^com\.luckyray\.extensionfixture\.p/);
    assert.match(report.fixture.executable.replace(/\\/g, "/"), /_delivery\/community-ui-20261003\/cache\/native/);
    await page.reload(); await ready();
    await tab("extensions");
    await step("empty registry uses real empty state", async () => { await page.locator(".community-empty").waitFor(); assert.equal((await list()).packages.length, 0); });
    await shot("01-plugins-empty-native");
    for (const file of ["plugin-sdk/examples/material-manifest/example.material-manifest.lrpack.json", "plugin-sdk/examples/page-desk/example.page-desk.lrpack.json", "examples/extensions/paper-sage.lrpack.json", "examples/extensions/research-note.lrpack.json"]) await install(file);
    await step("four actual packages installed through production file input", async () => assert.equal((await list()).packages.length, 4));
    await tab("extensions");
    const card = name => page.locator(".plugin-card").filter({ hasText: name });
    await card("素材使用清单").waitFor();
    await shot("02-plugins-dark-native");
    await step("full ID search and clear use registry", async () => {
      await page.locator(".community-search input").fill("example.material-manifest"); assert.equal(await page.locator(".plugin-card").count(), 1);
      await page.locator(".community-search input").fill("no-matching-extension"); await page.locator(".community-empty").waitFor(); await shot("03-search-no-match-native");
      await page.getByRole("button", { name: "清除筛选", exact: true }).click(); assert.equal(await page.locator(".plugin-card").count(), 2);
    });
    await step("plugin drawer permissions, trap and Escape focus restore", async () => {
      const trigger = card("素材使用清单").getByRole("button", { name: "详情", exact: true }); await trigger.click();
      const drawer = page.locator(".community-drawer"); await drawer.waitFor(); await shot("04-plugin-detail-dark-native");
      await page.keyboard.press("Shift+Tab"); assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".community-drawer")), true);
      await drawer.getByRole("button", { name: "保存授权", exact: true }).click();
      await drawer.getByRole("button", { name: "启用", exact: true }).click();
      await page.waitForFunction(async () => (await window.__fixtureInvoke("manage_extension_packages", { request: JSON.stringify({ op: "list" }) })).packages.find(p => p.package.manifest.id === "example.material-manifest")?.enabled === true);
      assert.equal((await list()).packages.find(p => p.package.manifest.id === "example.material-manifest").enabled, true);
      await page.keyboard.press("Escape"); await drawer.waitFor({ state: "detached" }); await page.waitForTimeout(50); assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    });
    await step("real read-only plugin command executes on fixture materials", async () => {
      await card("素材使用清单").getByRole("button", { name: "生成素材清单", exact: true }).click();
      const dialog = page.locator(".plugin-dialog"); await dialog.waitFor();
      await dialog.locator('.plugin-pick:has-text("fixture-hero.png") input').check();
      await dialog.locator('.plugin-run-bar button').filter({ hasText: "运行" }).click();
      await dialog.locator(".plugin-output").waitFor({ timeout: 30000 }); await shot("05-plugin-real-result-native");
      assert.match(await dialog.locator(".plugin-output").innerText(), /fixture-hero/);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    });
    await step("page contributions still navigate to original main-area route", async () => {
      await card("页面示例台").getByRole("button", { name: "启用", exact: true }).click();
      await card("页面示例台").getByRole("button", { name: "示例看板", exact: true }).click();
      assert.match(await page.evaluate(() => location.hash), /^#plugin/);
      report.limitations.push("Native fixture does not mount full AppShell/PluginPageHost; page navigation tested here, page-session behavior covered by existing component contracts.");
      await tab("extensions");
    });
    await setBase("dark"); await tab("packages");
    const sage = page.locator(".ext-package-card").filter({ hasText: "Paper Sage" });
    await sage.waitFor(); await shot("06-themes-dark-native");
    await step("Sage thumbnail projects actual semantic package palette", async () => assert.equal(await sage.locator(".community-theme-thumbnail").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(237, 241, 232)"));
    await step("Sage preview base=light; Escape restores saved dark", async () => {
      await sage.getByRole("button", { name: "预览主题", exact: true }).click(); await page.waitForFunction(() => document.documentElement.dataset.extensionTheme === "active");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light"); await shot("07-sage-preview-native");
      await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.documentElement.dataset.extensionTheme); assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    });
    await step("theme preview cancel, tab exit and route exit all restore base", async () => {
      await sage.getByRole("button", { name: "预览主题", exact: true }).click(); await sage.getByRole("button", { name: "取消预览", exact: true }).click(); assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
      await sage.getByRole("button", { name: "预览主题", exact: true }).click(); await tab("templates"); await page.waitForFunction(() => !document.documentElement.dataset.extensionTheme);
      await tab("packages"); await sage.getByRole("button", { name: "预览主题", exact: true }).click(); await page.evaluate(() => location.hash = "#materials"); await page.waitForFunction(() => !document.documentElement.dataset.extensionTheme); assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    });
    await tab("packages");
    await step("theme confirmation persists in real registry and disable restores global dark", async () => {
      await sage.getByRole("button", { name: "预览主题", exact: true }).click();
      await sage.getByRole("button", { name: "确认启用", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.ext-package-card .ext-theme-preview-actions'));
      assert.equal((await list()).packages.find(p => p.package.manifest.type === "theme").enabled, true);
      await page.reload(); await ready(); await tab("packages");
      await page.waitForFunction(() => document.documentElement.dataset.extensionTheme === "active");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
      await sage.getByRole("button", { name: "禁用", exact: true }).click();
      await page.waitForFunction(() => !document.documentElement.dataset.extensionTheme);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    });
    await step("theme update invalidates owned preview; uninstall restores registry empty", async () => {
      await sage.getByRole("button", { name: "预览主题", exact: true }).click();
      await sage.getByRole("button", { name: "详情", exact: true }).click();
      const next = JSON.parse(fs.readFileSync(path.join(root, "examples/extensions/paper-sage.lrpack.json"), "utf8")); next.manifest.version = "1.1.0";
      await page.locator('.community-drawer .ext-package-update input').setInputFiles({ name: "paper-sage-1.1.lrpack.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(next)) });
      await page.waitForFunction(() => !document.documentElement.dataset.extensionTheme);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
      assert.equal((await list()).packages.find(p => p.package.manifest.type === "theme").package.manifest.version, "1.1.0");
      await page.getByRole("dialog").getByRole("button", { name: "卸载", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal((await list()).packages.filter(p => p.package.manifest.type === "theme").length, 0);
      await install("examples/extensions/paper-sage.lrpack.json");
    });
    await setBase("light"); await tab("extensions"); await shot("08-plugins-light-native");
    await tab("templates"); await shot("09-templates-light-native");
    await page.evaluate(() => { const invoke = window.__TAURI_INTERNALS__.invoke; window.__fixtureIpcErrors = []; window.__TAURI_INTERNALS__.invoke = async (...args) => { try { return await invoke(...args); } catch (error) { window.__fixtureIpcErrors.push({ command: args[0], error }); throw error; } }; });
    await step("template writes real new note and readback uses true documentRef", async () => {
      await page.locator(".community-note-template").filter({ hasText: "周报" }).getByRole("button", { name: "新建笔记", exact: true }).click();
      await page.locator("[data-fixture-readback]").waitFor({ timeout: 15000 });
      const readback = await page.evaluate(() => window.__fixture.readbacks[0]); assert.ok(readback.ref); assert.ok(readback.snapshot.content.includes("#")); assert.equal(readback.error, null); report.templateReadback = readback;
      assert.equal(fs.readFileSync(path.join(report.fixture.root, "vault", readback.ref.relativePath), "utf8"), readback.snapshot.content);
    });
    await tab("templates");
    await step("extension template uses prepared content and writes a real target note", async () => {
      const research = page.locator(".ext-package-card").filter({ hasText: "Research note" });
      await research.getByRole("button", { name: "启用", exact: true }).click();
      await research.getByRole("button", { name: "使用模板", exact: true }).click();
      const drawer = page.getByRole("dialog");
      await drawer.locator('.ext-template-field').filter({ hasText: "topic" }).locator("input").fill("Community review");
      await drawer.getByRole("button", { name: "创建新笔记", exact: true }).click();
      await drawer.locator(".ext-template-summary").waitFor();
      const prepared = await drawer.locator(".ext-template-preview").innerText();
      await shot("10-research-template-prepared-native");
      await drawer.getByRole("button", { name: "创建新笔记", exact: true }).click();
      await page.waitForFunction(() => window.__fixture.readbacks.length === 2);
      const readback = await page.evaluate(() => window.__fixture.readbacks[0]);
      assert.equal(readback.error, null); assert.equal(readback.snapshot.content, prepared);
      assert.equal(fs.readFileSync(path.join(report.fixture.root, "vault", readback.ref.relativePath), "utf8"), prepared);
      assert.ok(fs.existsSync(path.join(report.fixture.root, "vault", report.fixture.seeded.seedNote)));
      report.extensionTemplateReadback = readback;
    });
    await tab("templates");
    await step("production insertion IPC preserves existing body and rejects stale revision", async () => {
      const original = report.templateReadback.snapshot;
      const result = await page.evaluate(async original => {
        const invoke = window.__fixtureInvoke;
        const sourceEpoch = window.__fixture.knowledge.sourceEpoch;
        const session = await invoke("knowledge_begin_current_context_session", { sessionId: "community-native-insert", sourceEpoch });
        const order = { ...session, sourceEpoch };
        await invoke("knowledge_set_current_context", { input: { ...order, generation: 1, documentRef: original.documentRef, cursorOffset: 0, selection: null, expectedRevision: original.revision } });
        const marker = "<!-- community native insertion -->\n";
        const inserted = await invoke("knowledge_insert_current", { input: { text: marker, appendIfNoCursor: false }, sourceEpoch });
        let refusal = null;
        try { await invoke("knowledge_insert_document", { input: { documentRef: original.documentRef, offset: 0, text: "MUST NOT WRITE", expectedRevision: original.revision }, sourceEpoch }); }
        catch (error) { refusal = typeof error === "string" ? error : JSON.stringify(error); }
        await invoke("knowledge_clear_current_context", { input: { ...order, generation: 2 } });
        return { inserted, marker, refusal };
      }, original);
      assert.equal(result.inserted.document.content, result.marker + original.content);
      assert.match(result.refusal, /knowledge-revision-conflict/);
      assert.equal(fs.readFileSync(path.join(report.fixture.root, "vault", original.relativePath), "utf8"), result.inserted.document.content);
      report.insertion = { kind: "production-ipc-domain-check-not-editor-ui", documentRef: original.documentRef, preservedBody: true, staleRefused: true };
    });
    await step("no current clean editor accurately disables insertion", async () => assert.equal(await page.locator(".community-note-template").first().getByRole("button", { name: "插入当前笔记", exact: true }).isDisabled(), true));
    await tab("skills"); await shot("10-skills-native-service-unavailable");
    await tab("status"); await shot("11-tools-light-native");
    report.limitations.push("Native fixture deliberately does not start the local capability HTTP API. Skills/workflows/tools render truthful read failure; ready catalog tested separately with isolated component transport, not claimed as native service PASS.");
    for (const width of [768, 390, 320]) {
      const cdp = await page.context().newCDPSession(page); await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await tab("extensions"); await page.waitForTimeout(80);
      await step(`responsive ${width}px no whole-page horizontal overflow`, async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)));
      await shot(`12-plugins-${width}-native`);
      await card("素材使用清单").getByRole("button", { name: "详情", exact: true }).click(); await shot(`13-drawer-${width}-native`);
      await step(`drawer ${width}px actions remain reachable`, async () => { const footer = await page.locator(".community-drawer-footer").boundingBox(); assert.ok(footer.width <= width && footer.y + footer.height <= 901); });
      await page.keyboard.press("Escape"); await cdp.detach();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await card("素材使用清单").getByRole("button", { name: "详情", exact: true }).click();
    await step("reduced motion removes drawer translation", async () => assert.equal(await page.locator(".community-drawer").evaluate(el => getComputedStyle(el).animationName), "none"));
    await page.keyboard.press("Escape");
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) { report.ok = false; report.failure = String(error.stack || error); report.ipcErrors = await page.evaluate(() => window.__fixtureIpcErrors || []); console.log(JSON.stringify(report.ipcErrors)); await shot("FAILED-native-current"); throw error; }
  finally { fs.writeFileSync(path.join(out, "native-ui-verification.json"), JSON.stringify(report, null, 2)); await browser.close(); child.kill(); hostLog.end(); }
})().catch(error => { console.error(error); process.exit(1); });
