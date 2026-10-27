// Isolated MV3 UI/queue fixture. Never a Desktop acceptance receipt.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = process.env.LUCKYRAY_QA_ARTIFACTS || path.join(root, "output/collector-audio-controls");
const calls = [], results = { kind: "ISOLATED_BROWSER_FIXTURE_NOT_DESKTOP", checks: [], officialDesktopAudioAcceptance: "NOT_RUN" };
let browser, child, profile, server, action;
let sequence = 0, outcome = "valid";
const transfers = new Map();
function wav() {
  const bytes = Buffer.alloc(16044); bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16000, 40);
  for (let i = 0; i < 8000; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 220 / 8000) * 1000), 44 + i * 2);
  return bytes;
}
const sound = wav();
const fixture = next => `<!doctype html><meta charset="utf-8"><title>Collector 采集验证</title><style>body{background:#25262d;color:#ddd;font:16px system-ui;padding:30px}video{display:block;width:600px;height:250px;background:#111;margin:20px 0}article{max-width:640px}audio{display:block;margin:12px 0}</style><article><h1>网页内容与音频参考</h1><p>${"这是独立验证页，保留正文和来源链接，采集入口与当前插件一致。".repeat(20)}</p></article><video id="video1" controls src="/clip.mp4"></video>${next ? "" : '<audio id="audio1" controls><source src="/tone.wav" type="audio/wav"></audio><audio controls src="/tone2.wav"></audio><a href="/linked.wav">直接音频资源</a><a href="/unsupported.flac">FLAC 音频</a>'}`;
function wireSnapshot(record, phase = "GET") {
  const value = { transferId: record.id, state: "completed", bytesReceived: sound.length, totalBytes: sound.length, mimeType: "audio/wav", fileName: record.body.fileName,
    assetId: "fixture-audio-asset", assetName: record.body.fileName, assetKind: "audio", skippedDuplicate: false,
    ...(record.body.libraryId ? { libraryId: record.body.libraryId, requestId: record.body.requestId,
      receipt: { consumerVersion: 1, libraryId: record.body.libraryId, requestId: record.body.requestId,
        assetId: "fixture-audio-asset", assetName: record.body.fileName,
        asset: { id: "fixture-audio-asset", name: record.body.fileName, kind: "audio" },
        disposition: "imported", organization: { state: "applied" }, atomic: false } } : {}) };
  if (record.outcome !== "valid" && phase === "POST") {
    value.state = "running"; value.bytesReceived = 0; value.assetId = value.assetName = value.assetKind = null; delete value.receipt;
  } else if (record.outcome === "wrong-kind") {
    value.assetKind = "video"; if (value.receipt) value.receipt.asset.kind = "video";
  } else if (["missing-id", "invalid-id"].includes(record.outcome)) {
    value.assetId = record.outcome === "missing-id" ? null : "bad/id";
    if (value.receipt) { value.receipt.assetId = value.assetId; value.receipt.asset.id = value.assetId; }
  } else if (record.outcome === "wrong-transfer") value.transferId = "media-ff-0000000000000002";
  return value;
}
async function popupClient(wsUrl, extensionId) {
  const socket = new WebSocket(wsUrl); await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let number = 0; const pending = new Map();
  socket.addEventListener("message", event => { const data = JSON.parse(event.data), entry = pending.get(data.id); if (entry) { pending.delete(data.id); clearTimeout(entry.timer); data.error ? entry.reject(new Error(JSON.stringify(data.error))) : entry.resolve(data.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++number, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out")); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  let attached, targetId;
  for (let i = 0; i < 80 && !attached; i++) {
    for (const target of (await send("Target.getTargets")).targetInfos.filter(target => target.url === `chrome-extension://${extensionId}/popup.html`)) {
      const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const result = await send("Runtime.evaluate", { expression: 'chrome.extension.getViews({type:"popup"}).includes(window)', returnByValue: true }, sessionId);
      if (result.result.value) { attached = sessionId; targetId = target.targetId; break; }
      await send("Target.detachFromTarget", { sessionId });
    }
    if (!attached) await pause(100);
  }
  if (!attached) { socket.close(); throw new Error("actual action popup missing"); }
  const evaluate = async expression => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, attached); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const click = async selector => {
    const rect = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:"nearest"});const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);
    assert(rect.w > 0 && rect.h > 0, selector);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, attached);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, attached);
    await pause(160);
  };
  return { evaluate, click, screenshot: async name => fs.writeFile(path.join(evidence, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" }, attached)).data, "base64")),
    close: async () => { await evaluate("setTimeout(()=>window.close(),0);true"); for (let i = 0; i < 40; i++) { if (!(await send("Target.getTargets")).targetInfos.some(target => target.targetId === targetId)) break; await pause(50); } socket.close(); } };
}
try {
  await fs.mkdir(evidence, { recursive: true });
  results.head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  results.sourceStatus = execFileSync("git", ["status", "--porcelain", "--", "browser-extension-prototype", "tests/collectorAudioControls.browser.mjs", "tests/collector-fixture-transport.js", "tests/extensionAudioControls.contract.test.mjs", "tests/extensionAudioReceiptSafety.contract.test.mjs", "tests/extensionCaptureTask.contract.test.mjs"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture"), chunks = []; for await (const chunk of request) chunks.push(chunk);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) {}
    if (url.pathname.startsWith("/api/")) calls.push({ method: request.method, path: url.pathname, body });
    response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Access-Control-Allow-Headers", "content-type,x-luckyray-source");
    if (request.method === "OPTIONS") { response.end(); return; }
    const json = data => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ok: true, data })); };
    if (["/tone.wav", "/tone2.wav", "/linked.wav"].includes(url.pathname)) { response.setHeader("Content-Type", "audio/wav"); response.setHeader("Content-Length", sound.length); response.end(sound); return; }
    if (url.pathname === "/clip.mp4") { response.setHeader("Content-Type", "video/mp4"); response.end(Buffer.from("fixture-video-not-playback")); return; }
    if (!url.pathname.startsWith("/api/")) { response.setHeader("Content-Type", "text/html;charset=utf-8"); response.end(fixture(url.pathname === "/next")); return; }
    if (url.pathname === "/api/v1/capabilities") { json({ namespaces: { materials: { mediaImport: { version: 1, available: true }, sourcePage: { version: 1, available: true } } } }); return; }
    if (url.pathname === "/api/material-libraries") { json({ consumerVersion: 1, legacyLibraryId: "lib-fixture", libraries: [{ libraryId: "lib-fixture", name: "验证素材库", visible: true, state: "ready", capabilities: { read: true, import: true, organize: true } }] }); return; }
    if (url.pathname === "/api/material-libraries/taxonomy") { json({ consumerVersion: 1, libraryId: body.libraryId, requestId: body.requestId, folders: [], tags: [] }); return; }
    if (url.pathname === "/api/notes/current") { json({ noteId: "fixture-note", cursorOffset: 0 }); return; }
    if (url.pathname === "/api/notes/capture-target") { json({ activation: { vaultId: "fixture-vault", sourceEpoch: 1 }, noteId: "fixture-note" }); return; }
    if (url.pathname === "/api/notes/capture") { json({ noteId: "fixture-note", inserted: true }); return; }
    if (url.pathname === "/api/folders") { json({ folders: [] }); return; }
    if (url.pathname === "/api/notes/recent") { json({ notes: [] }); return; }
    if (url.pathname === "/api/media/transfers" && request.method === "POST") {
      const downloaded = await fetch(body.url); assert.equal((await downloaded.arrayBuffer()).byteLength, sound.length);
      const id = `media-${(++sequence).toString(16)}-0000000000000001`, record = { id, body, outcome }; transfers.set(id, record); json(wireSnapshot(record, "POST")); return;
    }
    if (url.pathname.startsWith("/api/media/transfers/")) { json(wireSnapshot(transfers.get(url.pathname.split("/")[4]))); return; }
    if (url.pathname === "/api/material-libraries/media-receipt") {
      const record = [...transfers.values()].find(item => item.body.libraryId === body.libraryId && item.body.requestId === body.requestId);
      const confirmed = record && record.outcome === "valid";
      json({ receiptLookupVersion: 1, ...body, state: confirmed ? "completed" : "unknown", ...(confirmed ? { receipt: wireSnapshot(record).receipt } : {}) }); return;
    }
    json({});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port;
  results.fixturePort = port;
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "luckyray-audio-ui-"));
  const fixtureExtension = path.join(profile, "extension");
  await fs.cp(path.join(root, "browser-extension-prototype"), fixtureExtension, { recursive: true });
  const fixtureManifest = JSON.parse(await fs.readFile(path.join(fixtureExtension, "manifest.json"), "utf8"));
  fixtureManifest.version_name += ` / fixture-port:${port}`;
  await fs.writeFile(path.join(fixtureExtension, "manifest.json"), JSON.stringify(fixtureManifest, null, 2));
  await fs.copyFile(path.join(root, "tests/collector-fixture-transport.js"), path.join(fixtureExtension, "local-transport-auth.js"));
  results.fixtureSubstitutions = ["local-transport-auth.js (mock; no native messaging/discovery)", "manifest.version_name (fixture port)"];
  const executable = process.env.LUCKYRAY_TEST_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--mute-audio", "--remote-debugging-port=0", "--remote-allow-origins=*", "--window-size=1280,900", `--user-data-dir=${profile}`, `--disable-extensions-except=${fixtureExtension}`, `--load-extension=${fixtureExtension}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) { try { const [debugPort, socketPath] = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/); wsUrl = `ws://127.0.0.1:${debugPort}${socketPath}`; } catch (_) { await pause(100); } }
  assert(wsUrl); browser = await chromium.connectOverCDP(wsUrl); const context = browser.contexts()[0];
  await context.route(/^https?:\/\//, route => new URL(route.request().url()).origin === `http://127.0.0.1:${port}` ? route.continue() : route.abort("blockedbyclient"));
  let worker; for (let i = 0; i < 80 && !worker; i++) { worker = context.serviceWorkers().find(worker => worker.url().endsWith("/background.js")); if (!worker) await pause(100); }
  assert(worker);
  const source = context.pages()[0], url = `http://127.0.0.1:${port}/page`; await source.goto(url); await source.waitForLoadState("networkidle");
  await source.locator("#video1").hover(); await source.waitForSelector("[data-luckyray-video-capture]");
  const visibleHosts = () => source.locator("[data-luckyray-video-capture]").evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display !== "none").length);
  assert.equal(await visibleHosts(), 1); results.checks.push("initial overlay enabled");
  const extensionId = new URL(worker.url()).host;
  const open = async () => { await source.bringToFront(); await worker.evaluate(() => chrome.action.openPopup()); action = await popupClient(wsUrl, extensionId); await pause(500); };
  await open();
  assert.deepEqual(await action.evaluate('[...document.querySelectorAll(".lr-type span")].map(node=>node.textContent)'), ["图片", "视频", "正文", "音频"]);
  await action.click('[data-type="text"]');
  assert.equal(await action.evaluate('document.getElementById("lr-link-details").hidden'), true);
  await action.screenshot("01-text-link-collapsed.png");
  await action.click("#lr-add-link");
  assert.equal(await action.evaluate("state.type"), "link");
  assert.equal(await action.evaluate('document.querySelector(".lr-type.active").dataset.type'), "text");
  results.linkExpandedGeometry = await action.evaluate('(()=>{const node=el("lr-link-details"),r=node.getBoundingClientRect();return {hidden:node.hidden,display:getComputedStyle(node).display,height:r.height,top:r.top,bottom:r.bottom,viewport:innerHeight};})()');
  assert.equal(results.linkExpandedGeometry.hidden, false); assert(results.linkExpandedGeometry.height > 0);
  assert(results.linkExpandedGeometry.bottom <= results.linkExpandedGeometry.viewport);
  await action.screenshot("02-link-expanded.png");
  await action.close(); action = null; await open();
  assert.equal(await action.evaluate("state.type"), "link"); results.checks.push("link expansion and popup restore");
  await action.click("#lr-submit"); await pause(500);
  assert(calls.some(call => call.path === "/api/notes/capture" && call.body.content.includes(url))); results.checks.push("existing link save wire preserved (fixture note only)");
  await action.click("#lr-remove-link"); assert.equal(await action.evaluate("state.type"), "text");
  await action.click('[data-type="audio"]'); await pause(2800);
  assert.equal(await action.evaluate('document.querySelectorAll(".lr-audio-item:not(:disabled)").length'), 3);
  assert((await action.evaluate('el("lr-audio-candidates").textContent')).includes("linked.wav"));
  assert.equal(await action.evaluate('document.querySelectorAll(".lr-audio-item:disabled").length'), 1);
  await action.screenshot("03-audio-candidates.png");
  assert.equal(await action.evaluate('document.getElementById("lr-submit").disabled'), false);
  await action.click("#lr-more-options");
  assert.equal(await action.evaluate('el("lr-media-organize").hidden || el("lr-media-name").disabled'), false);
  await action.click("#lr-more-options"); results.checks.push("audio keeps existing library and organization controls");
  await action.click("#lr-submit"); await pause(800);
  const task = await action.evaluate("state.captureTask"); assert.equal(task.stage, "completed"); assert.equal(task.kind, "audio"); assert.equal(task.asset.kind, "audio");
  assert.equal(await action.evaluate('el("lr-capture-task-label").textContent'), "音频已入库");
  assert.equal(await action.evaluate('el("lr-transfer-progress-label").textContent'), "已入库");
  assert.equal(await action.evaluate('el("lr-transfer-progress-fill").style.width'), "100%");
  assert.equal(calls.filter(call => call.path === "/api/media/transfers" && call.method === "POST").length, 1);
  results.fixtureReceipt = { id: task.id, assetId: task.asset.id, kind: task.asset.kind, synthetic: true }; results.checks.push("queue wire downloads real synthetic WAV bytes and observes fixture audio receipt");
  await action.click('[data-type="video"]'); await pause(2800);
  assert((await action.evaluate("state.videoCandidates.length")) > 0);
  await action.click("#lr-video-overlays"); await pause(300); assert.equal(await visibleHosts(), 0);
  assert((await action.evaluate("state.videoCandidates.length")) > 0); await action.screenshot("04-video-overlay-off.png");
  await action.click("#lr-video-overlays"); await pause(200); assert.equal(await visibleHosts(), 1); results.checks.push("on-off-on leaves panel candidates available");
  await action.click("#lr-video-overlays"); await action.close(); action = null;
  await source.evaluate(() => { const video = document.createElement("video"); video.id = "video2"; video.src = "/clip.mp4"; document.body.prepend(video); });
  await source.locator("#video2").hover(); assert.equal(await visibleHosts(), 0);
  await worker.evaluate(() => LuckyRayVideoOverlayPreference.set(true)); await pause(200);
  assert.equal(await visibleHosts(), 1); assert.equal(await source.locator("[data-luckyray-video-capture]").count(), 2);
  await worker.evaluate(() => LuckyRayVideoOverlayPreference.set(false)); await source.goto(`http://127.0.0.1:${port}/next`); await source.waitForLoadState("networkidle");
  await source.locator("#video1").hover(); assert.equal(await source.locator("[data-luckyray-video-capture]").count(), 0);
  await worker.evaluate(() => LuckyRayVideoOverlayPreference.set(true)); await pause(200); assert.equal(await visibleHosts(), 1);
  for (let i = 0; i < 3; i++) { await worker.evaluate(() => LuckyRayVideoOverlayPreference.toggle()); await worker.evaluate(() => LuckyRayVideoOverlayPreference.toggle()); }
  await source.locator("#video1").hover(); assert.equal(await source.locator("[data-luckyray-video-capture]").count(), 1);
  await source.screenshot({ path: path.join(evidence, "05-overlay-restored.png"), fullPage: false });
  results.checks.push("dynamic video, navigation, persisted preference and repeated toggles have no duplicate hosts");
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/settings.html`);
  await settings.waitForSelector("#commands div"); assert((await settings.locator("#commands").textContent()).includes("切换视频悬浮按钮"));
  assert((await settings.locator("#commands").textContent()).includes("未设置"));
  await settings.locator("#video-overlays").uncheck(); await pause(100); assert.equal(await visibleHosts(), 0);
  await settings.locator("#video-overlays").check(); await pause(100); assert.equal(await visibleHosts(), 1);
  await settings.screenshot({ path: path.join(evidence, "06-settings.png"), fullPage: true });
  results.checks.push("settings preference and extension command registration");
  await source.goto(`http://127.0.0.1:${port}/next`); await source.waitForLoadState("networkidle");
  await source.evaluate(() => { const audio = document.createElement("audio"); audio.src = URL.createObjectURL(new Blob(["fixture"], { type: "audio/wav" })); document.body.append(audio); });
  await open(); await action.click('[data-type="audio"]'); await pause(400);
  assert.equal(await action.evaluate('document.querySelectorAll(".lr-audio-item:not(:disabled)").length'), 0);
  assert.equal(await action.evaluate('el("lr-submit").disabled'), true);
  assert((await action.evaluate('el("lr-audio-candidates").textContent')).includes("暂不支持 blob"));
  await action.screenshot("07-audio-unsupported-blob.png");
  results.checks.push("direct resource anchor discovered; blob audio explicitly unsupported and submit disabled");
  await action.close(); action = null;
  await source.goto(url); await source.waitForLoadState("networkidle"); await open();
  await action.click('[data-type="audio"]'); await pause(2800);
  results.negativeReceiptUiAssertions = [];
  for (const explicit of [true, false]) {
    await action.click("#lr-more-options");
    await action.evaluate(`(()=>{const select=el("lr-media-library");select.value=${JSON.stringify(explicit ? "lib-fixture" : "")};select.dispatchEvent(new Event("change",{bubbles:true}));return true;})()`);
    for (let i = 0; i < 60 && !await action.evaluate('!el("lr-submit").disabled'); i++) await pause(100);
    assert.equal(await action.evaluate('el("lr-submit").disabled'), false);
    assert.equal(await action.evaluate('LuckyRayMediaDestination.explicit()'), explicit);
    await action.click("#lr-more-options");
    for (const failure of ["wrong-kind", "missing-id", "invalid-id", "wrong-transfer"]) {
      outcome = failure; await action.click("#lr-submit");
      let view;
      for (let i = 0; i < 60; i++) {
        view = await action.evaluate('({task:state.captureTask,label:el("lr-capture-task-label").textContent,progress:el("lr-transfer-progress-label").textContent,fill:el("lr-transfer-progress-fill").style.width,toast:el("lr-toast").textContent,toastError:el("lr-toast").classList.contains("error")})');
        if (view.task?.stage === "uncertain" && view.toastError) break;
        await pause(100);
      }
      assert.equal(view.task?.stage, "uncertain"); assert.equal(view.task.asset, undefined);
      assert.equal(Boolean(view.task.mediaIdentity), explicit);
      for (const text of [view.label, view.progress, view.toast]) assert.doesNotMatch(text, /已入库|已存在|无需重复保存|已保存/);
      assert.notEqual(view.fill, "100%"); assert.equal(view.toastError, true);
      const record = [...transfers.values()].find(item => item.body.requestId === view.task.id);
      assert.equal(view.task.transferId, record.id); assert.equal(view.task.transfer.transferId, record.id);
      if (failure === "wrong-transfer") assert.equal(view.task.transfer.state, "running");
      results.negativeReceiptUiAssertions.push({ mode: explicit ? "library" : "legacy", failure, stage: view.task.stage,
        acceptedTransferId: record.id, observedTransferId: view.task.transfer.transferId, taskLabel: view.label, progressLabel: view.progress,
        progressFill: view.fill, toast: view.toast, toastError: view.toastError, noCanonicalAsset: !view.task.asset });
      if (explicit && failure === "wrong-kind") await action.screenshot("08-invalid-audio-receipt.png");
      if (!explicit && failure === "wrong-transfer") await action.screenshot("09-wrong-transfer-id.png");
      await action.click("#lr-capture-task-ack");
      assert.equal(await action.evaluate('el("lr-transfer-progress").style.display'), "none");
      assert.equal(await action.evaluate('el("lr-transfer-progress-label").textContent'), "");
      results.checks.push(`negative receipt UI: ${explicit ? "library" : "legacy"} ${failure}; no success task/toast/progress, acknowledgement clears strip`);
    }
  }
  outcome = "valid";
  results.nativeAudioDocument = "NOT_RUN: this Edge headless environment downloads WAV navigation (ERR_ABORTED); MIME-only document covered by unit contract, not browser PASS";
  results.keyboardDispatch = "NOT_RUN: no shortcut assigned in this fresh profile";
  results.status = "PASS";
} catch (error) { results.status = "FAIL"; results.error = error.stack; process.exitCode = 1;
  if (action) results.popupFailure = await action.evaluate('({type:state.type,gate:quickCollectGateState(),target:el("lr-target").value,linkHidden:el("lr-link-details").hidden,linkStyle:getComputedStyle(el("lr-link-details")).display,linkHeight:el("lr-link-details").getBoundingClientRect().height,linkParent:el("lr-link-details").parentElement.outerHTML,submitting:state.submitting,unresolved:state.unresolvedWrite})').catch(() => null);
}
finally {
  if (action) await action.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) { child.kill(); await pause(300); }
  if (server) await new Promise(resolve => server.close(resolve));
  if (profile) {
    const resolved = path.resolve(profile), temporary = path.resolve(os.tmpdir());
    if (!resolved.startsWith(temporary + path.sep) || !path.basename(resolved).startsWith("luckyray-audio-ui-")) throw new Error("unsafe temporary profile cleanup");
    await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
    results.temporaryProfileRemoved = !await fs.stat(resolved).then(() => true, () => false);
  }
  results.calls = calls; await fs.writeFile(path.join(evidence, "RESULT.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ status: results.status, checks: results.checks, error: results.error, evidence }, null, 2));
}
