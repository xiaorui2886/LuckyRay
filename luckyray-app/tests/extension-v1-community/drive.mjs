// Drives the isolated community fixture through the real product flow with the frozen
// SDK-only plugin. Automation attaches over CDP to the fixture's own WebView2 window
// (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) — it never touches other windows.
//
// node tests/extension-v1-community/drive.mjs [--exe <luckyray-app.exe>] [--assets <dir>]
//   [--plugin <zcode.material-manifest.lrpack.json>] [--out <evidence dir>] [--cdp 9333]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { snapshotDailyProfile } from "./profile-observation.mjs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const exe = path.resolve(arg("--exe", path.join(root, "target/extension-app/debug/luckyray-app.exe")));
const assets = path.resolve(arg("--assets", path.join(root, "target/extension-community-fixture")));
const plugin = path.resolve(arg("--plugin", "D:/codex/luckyray/_z2/sdk-only/material-manifest/zcode.material-manifest.lrpack.json"));
const out = path.resolve(arg("--out", path.join(root, "target/extension-community-evidence")));
const cdpPort = Number(arg("--cdp", "9333"));
fs.mkdirSync(out, { recursive: true });

const ps = command => execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true }).trim();
// SHA-256 of files this driver owns (fixture exe, frozen plugin package). Never applied to a daily profile.
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const environment = () => ({
  luckyrayProcesses: ps("Get-Process luckyray-app -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) $($_.StartTime.ToString('o')) $($_.Path)\" }").split(/\r?\n/).filter(Boolean),
  listeners: ps("Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' } | ForEach-Object { \"$($_.LocalPort):$($_.OwningProcess)\" } | Sort-Object -Unique").split(/\r?\n/).filter(Boolean),
  workers: ps("Get-CimInstance Win32_Process -Filter \"Name='luckyray-app.exe'\" | Where-Object { $_.CommandLine -like '*--extension-worker*' } | ForEach-Object { \"$($_.ProcessId) parent=$($_.ParentProcessId)\" }").split(/\r?\n/).filter(Boolean),
  // Daily profiles: existence/stat metadata only (see profile-observation.mjs); observations, NOT_PROVEN.
  realProfiles: { dev: snapshotDailyProfile("com.luckyray.desktop.dev"), prod: snapshotDailyProfile("com.luckyray.desktop") },
});

const summary = { startedAt: new Date().toISOString(), exe: { path: exe, sha256: sha(exe) }, assets, plugin: { path: plugin, sha256: sha(plugin) }, steps: [], before: environment() };
const record = (name, data) => { summary.steps.push({ name, at: new Date().toISOString(), ...data }); console.log(`[step] ${name}${data?.ok === false ? " FAILED" : ""}`); };
const save = () => fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));

let child, page, fixture, acceptor, dialogMode, dialogLog;
const dialogs = () => fs.existsSync(dialogLog) ? fs.readFileSync(dialogLog, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l.charCodeAt(0) === 0xFEFF ? l.slice(1) : l)) : [];
const shot = async name => { try { await page.screenshot({ path: path.join(out, `${String(summary.steps.length).padStart(2, "0")}-${name}.png`), fullPage: true }); } catch { /* window may be closing */ } };
async function step(name, fn) {
  try { const data = await fn(); record(name, { ok: true, ...(data || {}) }); await shot(name); }
  catch (error) { record(name, { ok: false, error: String(error?.stack || error) }); await shot(`${name}-failed`); save(); throw error; }
}
const manage = request => page.evaluate(async request => JSON.parse(JSON.stringify(await window.__fixtureInvoke("manage_extension_packages", { request: JSON.stringify(request) }))), request);
const card = () => page.locator('.plugin-card:has-text("素材使用清单")');
const dialog = () => page.locator(".plugin-dialog");
const pick = name => dialog().locator(`.plugin-pick:has-text("${name}") input`);

try {
  await step("spawn-fixture", async () => {
    child = spawn(exe, ["--extension-community-fixture", assets], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`, LUCKYRAY_FIXTURE_TIMEOUT_SECS: "900", LUCKYRAY_APP_PROFILE: "" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: false,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("exit", code => { summary.fixtureExit = { code, at: new Date().toISOString() }; });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture did not report ready\n${stdout}\n${stderr}`)), 60000);
      const poll = setInterval(() => { const line = stdout.split(/\r?\n/).find(l => l.includes('"community-fixture-ready"')); if (line) { clearInterval(poll); clearTimeout(timer); resolve(JSON.parse(line)); } if (child.exitCode !== null) { clearInterval(poll); clearTimeout(timer); reject(new Error(`fixture exited ${child.exitCode}\n${stdout}\n${stderr}`)); } }, 200);
    });
    fixture = { pid: child.pid, ...ready };
    summary.fixture = fixture;
    // Native confirm dialogs (tauri-plugin-dialog) belong to the fixture process; a helper
    // clicks their own OK/Cancel button via SendMessage — no input injection, no focus change.
    dialogMode = path.join(out, "dialog-mode.txt"); dialogLog = path.join(out, "confirm-dialogs.jsonl");
    fs.writeFileSync(dialogMode, "accept"); fs.writeFileSync(dialogLog, "");
    acceptor = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "accept-dialogs.ps1"), "-OwnerPid", String(child.pid), "-ModeFile", dialogMode, "-LogFile", dialogLog, "-TimeoutSec", "900"], { stdio: "ignore", windowsHide: true });
    return { pid: child.pid, identifier: ready.identifier, root: ready.root };
  });

  await step("attach-cdp", async () => {
    let browser, lastError;
    for (let attempt = 0; attempt < 40 && !browser; attempt++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); } catch (error) { lastError = error; await new Promise(r => setTimeout(r, 500)); }
    }
    if (!browser) throw lastError;
    const pages = browser.contexts().flatMap(c => c.pages());
    // Only the fixture's own page qualifies; never fall back to a foreign browser that happens to expose CDP on this port.
    page = pages.find(p => { try { const u = new URL(p.url()); return u.hostname === "fixture.localhost" || u.protocol === "fixture:"; } catch { return false; } });
    if (!page) throw new Error(`no fixture page over CDP (pages: ${pages.map(p => p.url()).join(", ")})`);
    page.on("dialog", d => { summary.steps.push({ name: "confirm-dialog", at: new Date().toISOString(), message: d.message() }); void d.accept(); });
    await page.waitForSelector('body[data-fixture-ready="1"]', { timeout: 60000 });
    const status = await page.evaluate(() => JSON.parse(JSON.stringify(window.__fixture)));
    if (status.status.pid !== child.pid) throw new Error(`attached page belongs to pid ${status.status.pid}, expected fixture ${child.pid}`);
    summary.fixtureStatus = status.status; summary.knowledgeActivation = status.knowledge;
    return { url: page.url(), identifier: status.status.identifier, seeded: status.status.seeded };
  });

  await step("open-extensions-tab", async () => {
    await page.locator('button[role="tab"]:has-text("扩展/插件")').click();
    await page.locator(".plugin-section").waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const violations = await page.evaluate(() => window.__fixture.violations.length);
    return { cspViolationsSoFar: violations };
  });

  await step("install-frozen-plugin", async () => {
    await page.locator('.plugin-section-head input[type="file"]').setInputFiles(plugin);
    await card().waitFor({ timeout: 15000 });
    const status = await card().locator(".plugin-status").innerText();
    const state = await manage({ op: "list" });
    const entry = state.packages.find(p => p.package.manifest.id === "zcode.material-manifest");
    if (!entry) throw new Error("registry has no zcode.material-manifest after install");
    return { cardStatus: status, registry: { enabled: entry.enabled, grants: entry.grants ?? [], digest: entry.digest, version: entry.package.manifest.version } };
  });

  await step("consent-and-enable", async () => {
    await card().locator(".plugin-permission:not(.is-required) input[type=checkbox]").check();
    await card().locator('button:has-text("保存授权")').click();
    await page.locator('.plugin-notice:has-text("已保存")').waitFor({ timeout: 10000 });
    await card().locator('button:has-text("启用")').click();
    await card().locator('.plugin-status:has-text("已启用")').waitFor({ timeout: 10000 });
    const state = await manage({ op: "list" });
    const entry = state.packages.find(p => p.package.manifest.id === "zcode.material-manifest");
    return { registry: { enabled: entry.enabled, grants: entry.grants } };
  });

  await step("run-manifest-readonly", async () => {
    await card().locator('.plugin-entry:has-text("生成素材清单")').click();
    await dialog().waitFor({ timeout: 10000 });
    await pick("fixture-hero.png").waitFor({ timeout: 15000 });
    await pick("fixture-hero.png").check();
    await pick("fixture-logo.png").check();
    await dialog().locator('.plugin-run-bar button:has-text("运行")').click();
    await dialog().locator(".plugin-output").waitFor({ timeout: 30000 });
    const title = await dialog().locator(".plugin-output h3").innerText();
    const text = await dialog().locator(".plugin-output-text").innerText();
    const round = await dialog().locator(".plugin-round").innerText();
    if (!text.includes("共 2 项素材")) throw new Error(`unexpected manifest text: ${text}`);
    return { title, text, round };
  });

  await step("save-settings", async () => {
    await dialog().locator('.plugin-dialog-head button:has-text("关闭")').click();
    await card().locator('.plugin-entry:has-text("清单设置")').click();
    await dialog().waitFor({ timeout: 10000 });
    await dialog().locator('.plugin-run-bar button:has-text("运行")').click();
    await dialog().locator(".plugin-field input").first().waitFor({ timeout: 30000 });
    await dialog().locator(".plugin-field input").nth(0).fill("storage");
    await dialog().locator(".plugin-field input").nth(1).fill("隔离清单");
    await dialog().locator('.plugin-actions button:has-text("保存清单偏好")').click();
    await dialog().locator('.plugin-round li.is-confirmed:has-text("已保存插件自有设置")').waitFor({ timeout: 30000 });
    const echoed = await dialog().locator(".plugin-field input").nth(1).inputValue();
    const state = await manage({ op: "list" });
    const entry = state.packages.find(p => p.package.manifest.id === "zcode.material-manifest");
    return { echoedTitle: echoed, ownedData: entry.data ?? null };
  });

  await step("rerun-with-saved-settings", async () => {
    await dialog().locator('.plugin-dialog-head button:has-text("关闭")').click();
    await card().locator('.plugin-entry:has-text("生成素材清单")').click();
    await dialog().waitFor({ timeout: 10000 });
    await pick("fixture-hero.png").waitFor({ timeout: 15000 });
    await pick("fixture-hero.png").check();
    await pick("fixture-logo.png").check();
    await pick("fixture-linked.png").check();
    await dialog().locator('.plugin-run-bar button:has-text("运行")').click();
    await dialog().locator(".plugin-output").waitFor({ timeout: 30000 });
    const title = await dialog().locator(".plugin-output h3").innerText();
    const text = await dialog().locator(".plugin-output-text").innerText();
    if (title !== "隔离清单" || !text.includes("按存储模式")) throw new Error(`saved settings not applied: ${title} / ${text}`);
    return { title, text };
  });

  await step("write-confirmation-cancel-refuses-run", async () => {
    fs.writeFileSync(dialogMode, "cancel");
    const before = dialogs().length;
    await dialog().locator('.plugin-run-consents label:has-text("允许本次写入") input').check();
    await dialog().locator('.plugin-run-bar button:has-text("运行")').click();
    await new Promise(r => setTimeout(r, 5000));
    const cancelled = dialogs().slice(before).filter(d => d.mode === "cancel");
    const roundState = await dialog().locator(".plugin-round").getAttribute("class");
    const previousTitle = await dialog().locator(".plugin-output h3").innerText();
    const busy = await dialog().locator(".plugin-running").count();
    fs.writeFileSync(dialogMode, "accept");
    if (!cancelled.length || !cancelled[0].buttons.includes("取消") || cancelled[0].clicked !== "取消") throw new Error(`no cancelled write confirmation recorded: ${JSON.stringify(cancelled)}`);
    if (!/is-done/.test(roundState || "") || busy !== 0) throw new Error(`run started despite cancelled confirmation: round=${roundState} busy=${busy}`);
    return { cancelledDialog: cancelled[0], roundState, previousResultStillShown: previousTitle };
  });

  await step("create-note-with-explicit-consent", async () => {
    await dialog().locator('.plugin-run-consents label:has-text("允许在当前知识库创建笔记") input').check();
    await dialog().locator('.plugin-run-consents label:has-text("允许本次写入") input').check();
    await dialog().locator('.plugin-run-bar button:has-text("运行")').click();
    await dialog().locator(".plugin-output").waitFor({ timeout: 30000 });
    await dialog().locator('.plugin-actions button:has-text("生成素材清单笔记")').click();
    await dialog().locator('.plugin-round li.is-confirmed:has-text("已创建笔记")').waitFor({ timeout: 30000 });
    await dialog().locator(".plugin-round.is-done").waitFor({ timeout: 30000 });
    await shot("create-note-round-done");
    const round = await dialog().locator(".plugin-round").innerText();
    const accepted = dialogs().filter(d => d.mode === "accept" && d.clicked === "确定");
    if (accepted.length < 2) throw new Error(`expected accepted write confirmations for run + action, got ${accepted.length}`);
    const relativePath = (await dialog().locator(".plugin-round li.is-confirmed code").first().innerText()).trim();
    const file = path.join(fixture.root, "vault", relativePath);
    if (!fs.existsSync(file)) throw new Error(`created note not on disk: ${file}`);
    summary.createdNote = { relativePath, file, bytes: fs.statSync(file).size, head: fs.readFileSync(file, "utf8").slice(0, 200) };
    return { round, file: summary.createdNote };
  });

  await step("locate-readback", async () => {
    await dialog().locator('.plugin-round button:has-text("定位")').click();
    await page.locator("[data-fixture-readback]").waitFor({ timeout: 15000 });
    const readback = await page.evaluate(() => JSON.parse(JSON.stringify(window.__fixture.readbacks[0])));
    if (!readback?.snapshot || readback.snapshot.relativePath !== summary.createdNote.relativePath) throw new Error(`readback mismatch: ${JSON.stringify(readback)}`);
    return { readback: { ...readback, snapshot: { ...readback.snapshot, content: readback.snapshot.content.slice(0, 300) } } };
  });

  const r2Package = (id, body) => JSON.stringify({ manifest: { schemaVersion: 1, apiVersion: 1, id, name: `R2 ${id}`, version: "1.0.0", type: "script", entry: "main.js", minHostVersion: "1.9.2", requiredModules: [], optionalModules: [] }, resource: { code: `LuckyRay.register(async()=>{const d=await LuckyRay.call('data.get');await LuckyRay.call('data.set',{schemaVersion:1,revision:d.revision+1,settings:{runs:(d.settings.runs||0)+1},cache:{}});${body}});`, requiredPermissions: [], optionalPermissions: [], dataVersion: 1, contributions: [{ id: "run", label: "R2 run", kind: "panel" }] } });
  for (const [id, body, expectCode] of [["fixture.r2-throw", "throw new Error('after-write-failed');", "after-write-failed"], ["fixture.r2-badui", "return {title:99};", "plugin-ui-invalid"]]) {
    await step(`r2-real-host-${id}`, async () => {
      const file = path.join(out, `${id}.lrpack.json`);
      fs.writeFileSync(file, r2Package(id, body));
      if (await dialog().count()) await dialog().locator('.plugin-dialog-head button:has-text("关闭")').click();
      await page.locator('.plugin-section-head input[type="file"]').setInputFiles(file);
      const r2card = page.locator(`.plugin-card:has-text("R2 ${id}")`);
      await r2card.waitFor({ timeout: 15000 });
      await r2card.locator('button:has-text("启用")').click();
      await r2card.locator('.plugin-status:has-text("已启用")').waitFor({ timeout: 10000 });
      const runs = [];
      for (let round = 1; round <= 2; round++) {
        await r2card.locator('.plugin-entry:has-text("R2 run")').click();
        await dialog().waitFor({ timeout: 10000 });
        await dialog().locator('.plugin-run-bar button:has-text("运行")').click();
        await dialog().locator(".plugin-round.is-failed").waitFor({ timeout: 30000 });
        await shot(`${id}-round${round}-failed-panel`);
        const notice = await dialog().locator(".plugin-notice").innerText();
        const record = await dialog().locator(".plugin-round").innerText();
        const oldUi = await dialog().locator(".plugin-output").count();
        const logs = (await dialog().locator(".plugin-logs pre").textContent()) || "";
        if (!record.includes("已保存插件自有设置")) throw new Error(`confirmed write missing from round record: ${record}`);
        if (/重试/.test(notice)) throw new Error(`notice suggests retry: ${notice}`);
        if (oldUi !== 0) throw new Error("a previous round's UI is shown after failure");
        if (!logs.includes(expectCode)) throw new Error(`raw code ${expectCode} not in logs: ${logs}`);
        runs.push({ round, notice, record, logsTail: logs.split("\n").slice(-3) });
        await dialog().locator('.plugin-dialog-head button:has-text("关闭")').click();
      }
      const state = await manage({ op: "list" });
      const entry = state.packages.find(p => p.package.manifest.id === id);
      if (entry?.data?.settings?.runs !== 2) throw new Error(`expected exactly 2 committed data.set writes, registry says ${JSON.stringify(entry?.data)}`);
      return { runs, ownedData: entry.data };
    });
  }

  await step("disable-and-uninstall-keeps-user-files", async () => {
    await card().locator('button:has-text("停用")').click();
    await card().locator('.plugin-status:has-text("已停用")').waitFor({ timeout: 10000 });
    await card().locator('button:has-text("卸载")').click();
    await page.waitForFunction(() => !document.querySelector('.plugin-card') || !document.querySelector('.plugin-card')?.textContent?.includes("素材使用清单"), null, { timeout: 15000 });
    const state = await manage({ op: "list" });
    const gone = !state.packages.some(p => p.package.manifest.id === "zcode.material-manifest");
    const noteStillThere = fs.existsSync(summary.createdNote.file);
    if (!gone || !noteStillThere) throw new Error(`uninstall wrong: gone=${gone} note=${noteStillThere}`);
    return { registryIds: state.packages.map(p => p.package.manifest.id), noteStillOnDisk: noteStillThere };
  });

  await step("collect-fixture-evidence", async () => {
    const violations = await page.evaluate(() => JSON.parse(JSON.stringify(window.__fixture.violations)));
    const during = environment();
    summary.during = during;
    for (const name of ["fixture-manifest.json", "csp-violations.log"]) { const f = path.join(fixture.root, name); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(out, name)); }
    const reports = path.join(fixture.root, "reports"); if (fs.existsSync(reports)) for (const f of fs.readdirSync(reports)) fs.copyFileSync(path.join(reports, f), path.join(out, `report-${f}`));
    const fixtureListeners = during.listeners.filter(l => l.endsWith(`:${fixture.pid}`));
    // Gate: the fixture host must not expose any listening port (no LocalTransport/gateway).
    if (fixtureListeners.length) throw new Error(`fixture process owns listening ports: ${fixtureListeners.join(", ")}`);
    // Gate: the daily backend fallback must have been refused by the CSP, not served.
    if (!violations.some(v => String(v.blockedURI).includes("127.0.0.1:37418"))) throw new Error("no CSP refusal recorded for the daily backend fallback request");
    return { cspViolations: violations, fixtureListeners, workersNow: during.workers, gates: { noFixtureListeners: true, dailyBackendFallbackBlocked: true } };
  });

  await step("finish-fixture", async () => {
    // Asking the fixture to exit closes its own page; the answer often cannot come back. That is success.
    try { await page.evaluate(() => window.__fixtureInvoke("extension_fixture_done", { report: { ok: true, by: "tests/extension-v1-community/drive.mjs" } }).catch(() => {})); } catch { /* page closed by the fixture exiting */ }
    await new Promise(resolve => { const t = setInterval(() => { if (child.exitCode !== null) { clearInterval(t); resolve(); } }, 200); setTimeout(() => { clearInterval(t); resolve(); }, 20000); });
    if (child.exitCode === null) { child.kill(); }
    try { acceptor?.kill(); } catch { /* ignore */ }
    summary.confirmDialogs = dialogs();
    await new Promise(r => setTimeout(r, 1500));
    summary.after = environment();
    // Gates (asserted): the fixture exited cleanly and left no worker of its own. Workers of other
    // lanes (different parent pid) are reported, never counted as this fixture's leftovers.
    const ownWorkers = summary.after.workers.filter(w => w.endsWith(`parent=${fixture.pid}`));
    const otherLaneWorkers = summary.after.workers.filter(w => !w.endsWith(`parent=${fixture.pid}`));
    const stillRunning = summary.after.luckyrayProcesses.some(l => l.startsWith(`${fixture.pid} `));
    if (!summary.fixtureExit || summary.fixtureExit.code !== 0) throw new Error(`fixture exit code ${summary.fixtureExit?.code ?? "none"}`);
    if (stillRunning) throw new Error("fixture process still running after exit");
    if (ownWorkers.length) throw new Error(`fixture left ${ownWorkers.length} worker(s): ${ownWorkers.join(", ")}`);
    // Observations (not proofs): a running daily instance rewrites its own database, so size/mtime/hash
    // comparison cannot attribute a change to or away from this fixture. Reported as-is, NOT_PROVEN.
    const devSame = JSON.stringify(summary.before.realProfiles.dev) === JSON.stringify(summary.after.realProfiles.dev);
    const prodSame = JSON.stringify(summary.before.realProfiles.prod) === JSON.stringify(summary.after.realProfiles.prod);
    const mainDevSame = JSON.stringify(summary.before.luckyrayProcesses.filter(l => !l.startsWith(`${fixture.pid} `))) === JSON.stringify(summary.after.luckyrayProcesses);
    return {
      fixtureExit: summary.fixtureExit,
      gates: { exitCodeZero: true, fixtureProcessGone: true, noOwnWorkersLeft: true },
      observations: { otherLaneWorkers, realDevDbSameStats: devSame, realProdDbSameStats: prodSame, otherLuckyRayProcessesUnchanged: mainDevSame, provenance: "NOT_PROVEN: file stats cannot attribute daily-profile changes; the fixture uses its own root and the only outbound request was CSP-blocked" },
    };
  });
  summary.ok = true;
} catch (error) {
  summary.ok = false; summary.error = String(error?.stack || error);
  try { child?.kill(); } catch { /* ignore */ }
  try { acceptor?.kill(); } catch { /* ignore */ }
} finally {
  summary.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ ok: summary.ok, steps: summary.steps.map(s => `${s.name}:${s.ok === false ? "FAIL" : "ok"}`), out }, null, 2));
  process.exit(summary.ok ? 0 : 1);
}
