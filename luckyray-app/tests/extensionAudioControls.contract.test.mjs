import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";
import "../browser-extension-prototype/audio-collection.js";
import "../browser-extension-prototype/extension-protocol.js";
import "../browser-extension-prototype/media-import-contract.js";
import "../browser-extension-prototype/capture-task.js";
const audio = globalThis.LuckyRayAudioCollection, media = globalThis.LuckyRayMediaImport;
const protocol = globalThis.LuckyRayExtensionProtocol;

test("only direct MP3/WAV is offered; video, credentials, streams and other formats are never silently relabelled", () => {
  for (const [url, mime, expected] of [["/track.MP3?x=1", "", true], ["/opaque", "audio/x-wav", true],
    ["/bad.mp3", "text/html", false], ["/a.m4a", "audio/mp4", false], ["/a.flac", "audio/flac", false],
    ["/a.ogg", "audio/ogg", false], ["/a.m3u8", "audio/mpegurl", false], ["blob:https://example.test/abc", "", false]]) {
    assert.equal(audio.classify(url, mime, "https://example.test/page", true)?.importable, expected, url);
  }
  for (const url of ["javascript:alert(1)", "data:audio/wav;base64,x", "https://name:secret@example.test/a.mp3", "/unrelated"])
    assert.equal(audio.classify(url, "", "https://example.test/page"), null);
  assert.equal(audio.classify("/clip.wav", "video/mp4", "https://example.test/page"), null);
  assert.equal(audio.classify("https://googlevideo.com/file.mp3", "audio/mpeg", "https://youtube.com/watch?v=x").importable, false);
  assert.equal(audio.classify("/live.mpd", "application/dash+xml", "https://example.test/page").reason, "stream");
});

test("DOM source discovery dedupes and EME protection wins over response hints", () => {
  const node = (src, type = "", sources = [], mediaKeys = null) => ({ currentSrc: src, mediaKeys,
    getAttribute: name => name === "src" ? src : type, querySelectorAll: () => sources });
  const source = node("/b.wav", "audio/wav");
  const doc = { contentType: "text/html", querySelectorAll: selector => selector === "audio"
    ? [node("/a.mp3", "audio/mpeg", [source]), node("/a.mp3", "audio/mpeg", [], {}), node("/a.mp3", "audio/mpeg")]
    : [{ href: "https://example.test/a.mp3", getAttribute: () => "audio/mpeg" }] };
  const found = audio.collect(doc, "https://example.test/page");
  assert.equal(found.length, 2);
  assert.equal(found[0].reason, "protected");
  assert.equal(audio.merge([...found, { url: "https://example.test/a.mp3", contentType: "audio/mpeg" }], "https://example.test/page")[0].importable, false);
});

test("audio failures never offer cookie authorization, recording, or claim completion", () => {
  for (const code of ["media-authentication-required", "site-auth-required", "media-drm-protected", "media-network-failed",
    "media-http-unavailable", "media-container-invalid", "media-needs-recording", "media-format-unsupported"])
    assert.doesNotMatch(protocol.formatMaterialImportFailure({ code }, "audio").message, /播放器右上角|允许 LuckyRay|图片|该视频|已入库/);
  assert.match(protocol.formatMaterialImportFailure({ code: "media-drm-protected" }, "audio").message, /不会绕过/);
});

test("direct audio resource documents are classified by MIME even without a filename extension", () => {
  const candidates = audio.collect({ contentType: "audio/wav", querySelectorAll: () => [] }, "https://example.test/opaque?signature=fixture");
  assert.equal(candidates.length, 1); assert.equal(candidates[0].importable, true); assert.equal(candidates[0].format, "wav");
  assert.equal(candidates[0].source, "document");
});

const snapshot = (state = "completed", kind = "audio", disposition = "imported") => ({
  transferId: "media-1-0000000000000001", state, bytesReceived: 16044, totalBytes: 16044,
  fileName: "tone.wav", mimeType: "audio/wav", assetId: "asset-audio-1", assetName: "tone.wav", assetKind: kind,
  skippedDuplicate: disposition === "duplicate",
});
const input = libraryId => ({ kind: "audio", request: { requestId: "popup:audio:original", url: "https://example.test/tone.wav", fileName: "tone.wav",
  ...(libraryId ? { libraryId } : {}) }, sourceUrl: "https://example.test/tone.wav?signature=fixture-secret" });
const receipt = (kind = "audio") => ({ consumerVersion: 1, libraryId: "lib-1", requestId: "popup:audio:original", assetId: "asset-audio-1",
  assetName: "tone.wav", asset: { id: "asset-audio-1", name: "tone.wav", kind }, disposition: "imported", organization: { state: "applied" }, atomic: false });
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(handler, saved = null) {
  let stored = saved; const calls = [];
  const controller = globalThis.LuckyRayCaptureTask.create({ protocol, media, read: async () => stored, write: async task => { stored = structuredClone(task); },
    delay: async () => {}, request: async (method, path, body) => { calls.push({ method, path, body }); return handler(method, path, body); } });
  return { controller, calls, stored: () => stored };
}
async function settled(h) { for (let i = 0; i < 40; i++) { await tick(); if (h.stored() && !["starting", "transferring", "checking"].includes(h.stored().stage)) return h.stored(); } assert.fail("not settled"); }
test("audio reuses formal queue, persists acceptance, requires actual audio assetId and distinguishes duplicate", async () => {
  for (const disposition of ["imported", "duplicate"]) {
    const h = harness(async () => ({ ok: true, data: snapshot("completed", "audio", disposition) }));
    assert.equal((await h.controller.start(input())).ok, true);
    assert.equal((await settled(h)).asset.kind, "audio");
    assert.equal(h.stored().disposition, disposition);
    assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
    assert.equal(h.calls[0].path, "/api/media/transfers");
    assert.equal(JSON.stringify(h.stored()).includes("tone.wav\""), true);
    assert.equal(JSON.stringify(h.stored()).includes("https://example.test/tone.wav"), false);
    assert.equal(JSON.stringify(h.stored()).includes("fixture-secret"), false);
  }
});
test("completed wire state is NOT success without audio type and valid assetId", async () => {
  for (const data of [snapshot("completed", "video"), { ...snapshot(), assetId: null }, { ...snapshot(), assetId: "bad/id" }]) {
    const h = harness(async () => ({ ok: true, data })); await h.controller.start(input());
    assert.equal((await settled(h)).stage, "uncertain"); assert.equal(h.stored().asset, undefined);
  }
});
test("explicit library audio is checked by the existing endpoint receipt identity", async () => {
  const h = harness(async () => ({ ok: true, data: { ...snapshot(), libraryId: "lib-1", requestId: "popup:audio:original", receipt: receipt() } }));
  await h.controller.start(input("lib-1"));
  const task = await settled(h);
  assert.equal(task.stage, "completed"); assert.equal(task.kind, "audio"); assert.equal(task.asset.kind, "audio");
  assert.equal(task.mediaIdentity.operation, "video");
});
test("lost audio start is uncertain; restart looks up the SAME receipt and never resends bytes", async () => {
  const first = harness(async () => ({ ok: false, errorObject: { code: "request-outcome-unknown" } }));
  await first.controller.start(input("lib-1")); assert.equal((await settled(first)).stage, "uncertain");
  const restored = harness(async (_method, path, body) => {
    assert.equal(path, "/api/material-libraries/media-receipt"); assert.equal(body.requestId, "popup:audio:original");
    return { ok: true, data: { receiptLookupVersion: 1, ...body, state: "completed", receipt: receipt() } };
  }, first.stored());
  await restored.controller.status(); assert.equal((await settled(restored)).stage, "completed");
  assert.equal(restored.calls.some(c => c.path === "/api/media/transfers"), false);
});
test("known transfer cancellation uses only the accepted id, while download failures stay failures", async () => {
  let cancelled = false, release;
  const h = harness(async (method, path) => {
    if (path.endsWith("/cancel")) { cancelled = true; release?.(); return { ok: true, data: snapshot("cancelled") }; }
    if (method === "POST") return { ok: true, data: snapshot("running") };
    if (!cancelled) await new Promise(resolve => { release = resolve; });
    return { ok: true, data: snapshot(cancelled ? "cancelled" : "running") };
  });
  await h.controller.start(input()); await tick();
  assert.equal((await h.controller.cancel("other-task")).ok, false);
  assert.equal((await h.controller.cancel("popup:audio:original")).ok, true);
  assert.equal((await settled(h)).stage, "failed");
  const failure = harness(async () => ({ ok: false, status: 403, errorObject: { code: "media-authentication-required" } }));
  await failure.controller.start(input()); assert.equal((await settled(failure)).stage, "failed");
});

test("a cancellation response for another transfer cannot mutate the accepted audio task", async () => {
  const saved = { version: 1, kind: "audio", id: "popup:audio:original", stage: "paused", transferId: snapshot().transferId };
  const h = harness(async () => ({ ok: true, data: { ...snapshot("cancelled"), transferId: "media-2-0000000000000002" } }), saved);
  assert.equal((await h.controller.cancel(saved.id)).ok, false);
  assert.equal((await h.controller.status()).task.stage, "paused");
  assert.equal((await h.controller.status()).task.transferId, saved.transferId);
});
test("preference persists false, ignores stale startup read and serializes command toggles", async () => {
  const listeners = new Set(); let value = false, resolveRead;
  const chrome = { storage: { local: { get: async () => ({ luckyrayVideoOverlayEnabledV1: value }), set: async change => { value = change.luckyrayVideoOverlayEnabledV1;
    for (const listener of listeners) listener({ luckyrayVideoOverlayEnabledV1: { newValue: value } }, "local"); } },
    onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  const sandbox = { chrome, module: { exports: {} } }; vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(new URL("../browser-extension-prototype/video-overlay-preference.js", import.meta.url), "utf8"), sandbox);
  const preference = sandbox.module.exports, seen = [];
  assert.equal(await preference.read(), false);
  chrome.storage.local.get = () => new Promise(resolve => { resolveRead = resolve; });
  const dispose = preference.subscribe(v => seen.push(v));
  await preference.set(true); resolveRead({ luckyrayVideoOverlayEnabledV1: false }); await tick();
  assert.deepEqual(seen, [true]);
  chrome.storage.local.get = async () => ({ luckyrayVideoOverlayEnabledV1: value });
  await Promise.all([preference.toggle(), preference.toggle()]); assert.equal(value, true);
  await preference.set(false); assert.equal(value, false); dispose(); assert.equal(listeners.size, 0);
  let command;
  sandbox.chrome.commands = { onCommand: { addListener: fn => { command = fn; } } };
  sandbox.getActiveTab = () => { throw new Error("overlay command must not require or capture a tab"); };
  sandbox.notify = () => { throw new Error("preference should save"); };
  const background = await fs.readFile(new URL("../browser-extension-prototype/background.js", import.meta.url), "utf8");
  vm.runInContext(background.match(/chrome.commands\?\.onCommand.addListener\([\s\S]*?\n\}\);/)[0], sandbox);
  await command("toggle-video-overlays"); assert.equal(value, true);
  await command("toggle-video-overlays"); assert.equal(value, false);
});
test("manifest permissions unchanged; command deliberately has no default shortcut", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../browser-extension-prototype/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, ["contextMenus", "activeTab", "scripting", "notifications", "storage", "nativeMessaging", "tabCapture", "offscreen", "webRequest"]);
  assert.deepEqual(manifest.optional_permissions, ["cookies"]);
  assert.equal(manifest.commands["toggle-video-overlays"].suggested_key, undefined);
  assert.equal(protocol.buildCaptureTargetPolicy("audio").allowedTargets.some(v => v.startsWith("note:")), false);
});
