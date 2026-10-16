// Collector instance-binding contract tests (2026-10-08, rework round).
//
// Part 1 drives the REAL local-transport-auth.js against two local HTTP
// fixture desktops with different credentials and the SAME library id.
// Part 2 loads the REAL background.js in a vm sandbox with the full
// importScripts chain and drives the popup/action message handlers.
// Part 3 is a source-level contract: no numeric-port, null-target or
// self-discovering dispatch may survive in production background.js.
//
// HARD ISOLATION GATE: the module-level fetch wrapper below is the ONLY
// network exit in this file. It admits exactly the loopback ports of the
// fixture servers this run itself started, forces redirect:"error" so a
// redirect can never widen the destination, and rejects everything else
// BEFORE any bytes are sent — so even a missing __LUCKYRAY_TEST_PORTS__ pin
// or a full production port scan can never reach a real Desktop
// (37418/37419/...) or any other host. Every rejection is recorded in the
// GLOBAL log (host:port:path only; never credentials, tokens or nonces);
// per-worker copies exist for attribution, and every test asserts both.
//
// Nothing here contacts a real Desktop, a user profile or real credentials.
// Negative assertions count EVERY business request the non-chosen instance
// receives.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = new URL("../browser-extension-prototype/", import.meta.url);
const ORIGIN = "chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid";
const CREDENTIAL_A = "ab".repeat(32);
const CREDENTIAL_B = "cd".repeat(32);
const CREDENTIAL_C = "ef".repeat(32);
const LIBRARY_ID = "lib-shared";
const tick = () => new Promise(resolve => setImmediate(resolve));
const hex = length => Array.from({ length }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

const nativeFetch = globalThis.fetch;
// Fetch's port-blocking rule (also present in this Node runtime's Undici).
// listen(0) is not guaranteed to avoid these ports on Windows. Allocate a
// different OWN fixture listener before registering it, never retry discovery
// or weaken the network gate to conceal a missing candidate.
const FETCH_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080]);
const fixturePorts = new Set();
const rejectedFetches = [];
function guardedFetch(input, init, sink) {
  const urlText = String(input instanceof Request ? input.url : input);
  let target;
  try { target = new URL(urlText); } catch (_) { target = null; }
  const port = Number(target?.port);
  const allowed = target !== null && target.protocol === "http:" && target.hostname === "127.0.0.1"
    && Number.isInteger(port) && fixturePorts.has(port);
  if (!allowed) {
    const record = { host: target?.hostname ?? urlText.slice(0, 64), port: Number.isInteger(port) ? port : null,
      path: (target?.pathname ?? "").slice(0, 96) };
    rejectedFetches.push(record);
    if (sink) sink.push(record);
    return Promise.reject(Object.assign(new TypeError("test-fetch-blocked: destination outside the fixture allowlist"), { testBlocked: true }));
  }
  // Redirects must never silently widen the destination of a test request.
  return nativeFetch(input, { ...init, redirect: "error" });
}

async function hmacHex(credential, message) {
  const key = await crypto.subtle.importKey("raw",
    Uint8Array.from(credential.match(/../g), pair => Number.parseInt(pair, 16)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

function receiptFor(record) {
  return { consumerVersion: 1, libraryId: record.libraryId, requestId: record.requestId,
    assetId: "fixture-asset", assetName: record.fileName, asset: { id: "fixture-asset", name: record.fileName, kind: record.kind },
    disposition: "imported", organization: { state: "applied" }, atomic: false };
}

function snapshotFor(record, state = "completed") {
  return { transferId: record.transferId, state, bytesReceived: state === "completed" ? 16044 : 0,
    totalBytes: 16044, fileName: record.fileName, mimeType: record.mimeType || "audio/wav",
    ...(state === "completed" ? { assetId: "fixture-asset", assetName: record.fileName, assetKind: record.kind, skippedDuplicate: false } : {}),
    libraryId: record.libraryId, requestId: record.requestId,
    ...(state === "completed" ? { receipt: receiptFor(record) } : {}) };
}

// One synthetic Desktop: stable per-instance credential + serverNonce, the
// real proof handshake, business routes that enforce the bearer credential,
// and scenario switches for failure injection. Receipts are DURABLE across
// restart() — that is the reconciliation surface the plugin must consult.
async function startDesktop({ credential, name, listenPort = 0 }) {
  const state = { name, credential, nonce: "aa".repeat(32), proofValid: true,
    dropWriteResponse: false, authRejectOnce: null, hideLibrary: false, unreachable: false,
    mediaReceiptError: false, holdRunning: false, sourcePageAvailable: false, recordingSaveError: false,
    holdRecordingSaveOnce: null, imageImportRejectOnce: false, imageDelayMs: 0, dropImageResponse: false,
    holdLibraryOnce: null, holdProbeOnce: null, probeError: false, pendingTransferIdOverride: null, restartAfterMediaReceipt: false,
    business: [], control: [], transfers: new Map(), receipts: new Map(), sequence: 0 };
  const json = (response, data) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(data)); };
  const rejectAuth = (response, style) => {
    response.statusCode = style === 403 ? 403 : 401;
    json(response, { ok: false, error: { code: style === 403 ? "extension-origin-forbidden" : "authentication-required" } });
  };
  const server = createServer(async (request, response) => {
    if (state.unreachable) { request.socket.destroy(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) {}
    const url = new URL(request.url, "http://127.0.0.1");
    const port = server.address().port;
    const isControl = ["/api/v1/health", "/api/v1/extension/bootstrap", "/api/v1/proof"].includes(url.pathname);
    (isControl ? state.control : state.business).push({ method: request.method, path: url.pathname, body });
    response.setHeader("Access-Control-Allow-Origin", ORIGIN);
    // Short-lived fixture servers can reuse an ephemeral port on Windows.
    // Do not let the client's pooled socket outlive one fixture's identity.
    response.setHeader("Connection", "close");
    if (url.pathname === "/redirect-evil") {
      response.statusCode = 302;
      response.setHeader("Location", "http://127.0.0.1:9/never-reached");
      response.end();
      return;
    }
    if (isControl) {
      if (url.pathname === "/api/v1/health") {
        json(response, { ok: true, data: { service: "luckyray-local-transport", protocolVersion: 1, extensionBootstrap: true } });
        return;
      }
      if (url.pathname === "/api/v1/extension/bootstrap") {
        json(response, { ok: true, data: { protocolVersion: 1, actualPort: port, baseUrl: `http://127.0.0.1:${port}`, credential } });
        return;
      }
      if (url.pathname === "/api/v1/proof") {
        const message = `luckyray-local-transport-proof-v1\nprotocol:1\norigin:${ORIGIN}\nport:${port}\nclientNonce:${body.clientNonce}\nserverNonce:${state.nonce}`;
        json(response, { ok: true, data: { protocolVersion: 1, port, clientNonce: body.clientNonce,
          serverNonce: state.nonce, proof: state.proofValid ? await hmacHex(credential, message) : "ef".repeat(32) } });
        return;
      }
      response.statusCode = 404; json(response, {}); return;
    }
    if (request.headers.authorization !== `Bearer ${credential}`) { rejectAuth(response, 401); return; }
    if (state.authRejectOnce) { const style = state.authRejectOnce; state.authRejectOnce = null; rejectAuth(response, style); return; }
    if (url.pathname === "/api/v1/capabilities") {
      json(response, { ok: true, data: { namespaces: { materials: { mediaImport: { version: 1, available: true },
        sourcePage: { version: 1, available: state.sourcePageAvailable } } } } });
      return;
    }
    if (url.pathname === "/api/video/record/save") {
      if (state.holdRecordingSaveOnce) {
        const gate = state.holdRecordingSaveOnce; state.holdRecordingSaveOnce = null; await gate;
      }
      if (state.recordingSaveError) {
        response.statusCode = 500;
        json(response, { ok: false, error: { code: "recording-save-failed" } });
      } else json(response, { ok: true, data: { disposition: "imported",
        asset: { id: "fixture-recording", name: body.title, kind: "video", sizeBytes: 16 } } });
      return;
    }
    if (url.pathname === "/api/collection/failures") { json(response, { ok: true, data: {} }); return; }
    if (url.pathname === "/api/media/probes") {
      if (state.holdProbeOnce) {
        const gate = state.holdProbeOnce; state.holdProbeOnce = null; await gate;
      }
      if (state.probeError) {
        response.statusCode = 422;
        json(response, { ok: false, error: { code: "media-no-formats" } });
      } else json(response, { ok: true, data: { probeId: `probe-${"1".repeat(32)}`, formats: [{
        formatId: `format-${"2".repeat(32)}`, label: "Fixture 1080p", extension: "mp4", videoCodec: "h264", audioCodec: "aac",
        width: 1920, height: 1080, fps: 30, estimatedBytes: 16044, bitrate: 1000000 }] } });
      return;
    }
    if (url.pathname === "/api/v1/extension/appearance") { json(response, { ok: true, data: {} }); return; }
    if (url.pathname === "/api/material-libraries" && state.holdLibraryOnce) {
      const gate = state.holdLibraryOnce;
      state.holdLibraryOnce = null;
      await gate;
    }
    if (url.pathname === "/api/material-libraries") {
      json(response, { ok: true, data: { consumerVersion: 1, legacyLibraryId: LIBRARY_ID,
        libraries: state.hideLibrary ? [] : [{ libraryId: LIBRARY_ID, name: `${name} 素材库`, visible: true, state: "ready",
          capabilities: { read: true, import: true, organize: true } }] } });
      return;
    }
    if (url.pathname === "/api/material-libraries/taxonomy") {
      json(response, { ok: true, data: { consumerVersion: 1, libraryId: body.libraryId, requestId: body.requestId, folders: [], tags: [] } });
      return;
    }
    if (url.pathname === "/api/media/transfers" && request.method === "POST") {
      state.sequence += 1;
      const record = { transferId: `media-${state.sequence.toString(16)}-${"1".repeat(16)}`,
        libraryId: body.libraryId, requestId: body.requestId, fileName: body.fileName || "tone.wav",
        mimeType: body.mimeType, kind: body.kind || (/\.(?:mp4|webm|mkv)$/i.test(body.fileName || "") ? "video" : "audio"), state: "running" };
      state.transfers.set(record.transferId, record);
      state.receipts.set(`${body.libraryId}:${body.requestId}`, record);
      if (state.dropWriteResponse) { request.socket.destroy(); return; }
      json(response, { ok: true, data: snapshotFor(record, "running") });
      return;
    }
    if (url.pathname === "/api/material-libraries/media-receipt" && request.method === "POST") {
      if (state.mediaReceiptError) {
        response.statusCode = 500;
        json(response, { ok: false, error: { code: "internal-error" } });
        return;
      }
      if (state.restartAfterMediaReceipt) {
        // Restart AFTER the receipt response is written: the client observed
        // the receipt under the old nonce, then the instance restarted.
        response.once("finish", () => { state.restartAfterMediaReceipt = false; state.nonce = hex(64); state.transfers.clear(); });
      }
      const record = state.receipts.get(`${body.libraryId}:${body.requestId}`);
      if (!record) { json(response, { ok: true, data: { receiptLookupVersion: 1, ...body, state: "unknown" } }); return; }
      if (state.pendingTransferIdOverride) {
        const pending = { ...snapshotFor(record, "running") };
        pending.transferId = state.pendingTransferIdOverride;
        json(response, { ok: true, data: { receiptLookupVersion: 1, ...body, state: "pending", transfer: pending } });
        return;
      }
      record.state = "completed";
      json(response, { ok: true, data: { receiptLookupVersion: 1, ...body, state: "completed", receipt: receiptFor(record) } });
      return;
    }
    const transferMatch = /^\/api\/media\/transfers\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (transferMatch) {
      const record = state.transfers.get(transferMatch[1]);
      if (!record) { response.statusCode = 404; json(response, { ok: false, error: { code: "media-transfer-not-found" } }); return; }
      if (transferMatch[2] === "/cancel") record.state = "cancelled";
      else record.state = state.holdRunning ? "running" : "completed";
      json(response, { ok: true, data: snapshotFor(record, record.state) });
      return;
    }
    if (url.pathname === "/api/notes/attach-material") { json(response, { ok: true, data: { noteId: "fixture-note" } }); return; }
    if (url.pathname === "/api/notes/current") { json(response, { ok: true, data: { noteId: "fixture-note", cursorOffset: 0 } }); return; }
    if (url.pathname === "/api/assets/import-media") {
      if (state.imageImportRejectOnce) {
        state.imageImportRejectOnce = false; response.statusCode = 400;
        json(response, { ok: false, error: { code: "consumer-input-invalid" } }); return;
      }
      const record = { libraryId: body.libraryId, requestId: body.requestId, fileName: body.name || "image.png", kind: "image" };
      state.receipts.set(`${body.libraryId}:${body.requestId}`, record);
      if (state.imageDelayMs) await new Promise(resolve => setTimeout(resolve, state.imageDelayMs));
      if (state.dropImageResponse) { request.socket.destroy(); return; }
      json(response, { ok: true, data: receiptFor(record) });
      return;
    }
    if (url.pathname === "/collect") { json(response, { ok: true, id: "fixture" }); return; }
    response.statusCode = 404; json(response, {});
  });
  if (listenPort) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(listenPort, "127.0.0.1", resolve);
        });
        break;
      } catch (error) {
        if (error?.code !== "EADDRINUSE" || attempt >= 40) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  } else {
    for (let attempt = 0; ; attempt += 1) {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      if (!FETCH_BLOCKED_PORTS.has(server.address().port)) break;
      await new Promise(resolve => server.close(resolve));
      assert.ok(attempt < 16, "could not allocate a Fetch-compatible fixture port");
    }
  }
  fixturePorts.add(server.address().port);
  return { server, state, port: server.address().port,
    stop: () => new Promise(resolve => {
      fixturePorts.delete(server.address().port);
      server.close(resolve);
    }),
    // A restart keeps the credential (install identity) but mints a new
    // instance nonce; in-memory transfers are gone, receipts stay durable.
    restart: () => { state.nonce = hex(64); state.transfers.clear(); } };
}

// ---------------------------------------------------------------- Part 1
// The real transport module in Node, discovery ports pinned to the fixtures.

function installChrome() {
  globalThis.chrome = {
    runtime: { getURL: () => `${ORIGIN}/`, lastError: null, sendNativeMessage(host, message, callback) { callback(undefined); } },
    storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
  };
}

function installRoutingFetch() {
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("Origin", ORIGIN);
    return guardedFetch(input, { ...init, headers });
  };
}

function usePorts(...ports) { globalThis.__LUCKYRAY_TEST_PORTS__ = ports; }

async function loadTransport(tag) {
  globalThis.LuckyRayLocalTransport = undefined;
  await import(`../browser-extension-prototype/local-transport-auth.js?rework=${tag}-${Date.now()}-${Math.random()}`);
  return globalThis.LuckyRayLocalTransport;
}

async function withTwoDesktops(run) {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  installChrome();
  installRoutingFetch();
  usePorts(low.port, high.port);
  try {
    return await run({ low, high, transport: await loadTransport("two") });
  } finally {
    await low.stop(); await high.stop();
    globalThis.__LUCKYRAY_TEST_PORTS__ = undefined;
  }
}

bindingTest("discovery enumerates both verified instances; a bound task on the high port never contacts the low one", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const candidates = await transport.discoverCandidates();
    assert.equal(candidates.length, 2);
    assert.deepEqual([...candidates.map(candidate => candidate.port)].sort((a, b) => a - b), [low.port, high.port]);
    assert.equal(candidates[0].fingerprint, await sha256Hex(CREDENTIAL_A));
    assert.equal(candidates[1].fingerprint, await sha256Hex(CREDENTIAL_B));
    assert.equal(JSON.stringify(candidates).includes(CREDENTIAL_A), false);
    assert.equal(JSON.stringify(candidates).includes(CREDENTIAL_B), false);

    const binding = await transport.openBinding(high.port);
    assert.deepEqual(Object.keys(binding).sort(), ["fingerprint", "origin", "port", "serverNonce", "version"]);
    const lowBusinessBefore = low.state.business.length;
    const libraries = await transport.fetch(binding, "/api/material-libraries");
    assert.equal(libraries.ok, true);
    const save = await transport.fetch(binding, "/api/media/transfers", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryId: LIBRARY_ID, requestId: "popup:bind:high-save", url: "https://fixture.test/tone.wav", fileName: "tone.wav" }) });
    assert.equal(save.ok, true);
    const transferId = (await save.json()).data.transferId;
    const progress = await transport.fetch(binding, `/api/media/transfers/${transferId}`);
    assert.equal(progress.ok, true);
    // Same library id exists on the low instance; the bound task still never
    // asks it for anything, not even a health probe after binding.
    assert.equal(low.state.business.length - lowBusinessBefore, 0);
    assert.deepEqual(high.state.business.map(call => call.path),
      ["/api/material-libraries", "/api/media/transfers", `/api/media/transfers/${transferId}`]);
  });
});

bindingTest("a failed proof on the bound endpoint fails closed; the other instance receives no business request", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const binding = await transport.openBinding(high.port);
    high.state.proofValid = false;
    await assert.rejects(
      () => transport.fetch(binding, "/api/media/transfers", { method: "POST", body: "{}" }),
      error => error.code === "verification-unavailable" && error.notDispatched === true);
    assert.equal(low.state.business.length, 0);
    assert.equal(high.state.business.length, 0);
  });
});

bindingTest("warm selection re-verifies proof without repeating health/bootstrap for every read", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const original = await transport.openBinding(high.port);
    const controlBefore = high.state.control.length;
    for (let i = 0; i < 3; i++) {
      const binding = await transport.openBinding(high.port);
      assert.deepEqual(binding, original);
      assert.equal((await transport.fetch(binding, "/api/material-libraries")).ok, true);
    }
    assert.deepEqual(high.state.control.slice(controlBefore).map(call => call.path),
      Array(3).fill("/api/v1/proof"), "each selection still requires a fresh valid proof, not a new bootstrap");
    assert.equal(low.state.control.length, 0);
    assert.equal(low.state.business.length, 0);
    high.state.proofValid = false;
    await assert.rejects(() => transport.openBinding(high.port), error => error.code === "verification-unavailable");
    assert.equal(high.state.business.length, 3, "invalid proof cannot be served from cache");
  });
});

bindingTest("warm selection observes a new service nonce; old frozen writes remain blocked", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const original = await transport.openBinding(high.port);
    high.restart();
    const renewed = await transport.openBinding(high.port);
    assert.equal(renewed.fingerprint, original.fingerprint);
    assert.notEqual(renewed.serverNonce, original.serverNonce);
    await assert.rejects(() => transport.fetch(original, "/api/media/transfers", { method: "POST", body: "{}" }),
      error => error.code === "binding-service-restarted" && error.notDispatched === true);
    assert.equal(high.state.business.length, 0);
    assert.equal(low.state.business.length, 0);
  });
});

bindingTest("a 401 on the bound endpoint re-verifies the SAME port and replays once; it never switches instances", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const binding = await transport.openBinding(high.port);
    high.state.authRejectOnce = 401;
    const save = await transport.fetch(binding, "/api/media/transfers", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryId: LIBRARY_ID, requestId: "popup:bind:401", url: "https://fixture.test/t.wav", fileName: "t.wav" }) });
    assert.equal(save.ok, true);
    assert.equal(high.state.business.filter(call => call.path === "/api/media/transfers").length, 2);
    assert.equal(low.state.business.length, 0);
    assert.equal(low.state.control.filter(call => call.path === "/api/v1/health").length, 0);
  });
});

bindingTest("a 403 authentication-style rejection follows the same same-endpoint recovery", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const binding = await transport.openBinding(high.port);
    high.state.authRejectOnce = 403;
    const save = await transport.fetch(binding, "/api/media/transfers", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryId: LIBRARY_ID, requestId: "popup:bind:403", url: "https://fixture.test/t.wav", fileName: "t.wav" }) });
    assert.equal(save.ok, true);
    assert.equal(low.state.business.length, 0);
  });
});

bindingTest("a lost write response stays explicitly unknown and is never replayed or moved", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const binding = await transport.openBinding(high.port);
    high.state.dropWriteResponse = true;
    await assert.rejects(
      () => transport.fetch(binding, "/api/media/transfers", { method: "POST", body: "{}" }),
      error => error.code === "request-outcome-unknown" && error.notDispatched !== true);
    assert.equal(high.state.business.length, 1);
    assert.equal(low.state.business.length, 0);
    high.state.dropWriteResponse = false;
    const progress = await transport.fetch(binding, "/api/material-libraries");
    assert.equal(progress.ok, true);
    assert.equal(high.state.business.filter(call => call.path === "/api/media/transfers").length, 1);
    assert.equal(low.state.business.length, 0);
  });
});

bindingTest("port reuse by a different credential fails closed as an identity mismatch", async () => {
  const original = await startDesktop({ credential: CREDENTIAL_A, name: "original" });
  installChrome(); installRoutingFetch(); usePorts(original.port);
  const transport = await loadTransport("reuse");
  const binding = await transport.openBinding(original.port);
  assert.equal(binding.fingerprint, await sha256Hex(CREDENTIAL_A));
  await original.stop();
  const reuser = await startDesktop({ credential: CREDENTIAL_B, name: "reuser", listenPort: original.port });
  try {
    await assert.rejects(
      () => transport.fetch(binding, "/api/media/transfers", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryId: LIBRARY_ID, requestId: "popup:bind:reuse", url: "https://fixture.test/t.wav", fileName: "t.wav" }) }),
      error => error.code === "binding-identity-mismatch" && error.notDispatched === true);
    assert.equal(reuser.state.business.length, 0);
  } finally {
    await reuser.stop();
    globalThis.__LUCKYRAY_TEST_PORTS__ = undefined;
  }
});

bindingTest("no HTTP response unlocks a restarted binding; only confirmBinding after a verified receipt does", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const binding = await transport.openBinding(high.port);
    const nonceBefore = binding.serverNonce;
    const save = await transport.fetch(binding, "/api/media/transfers", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryId: LIBRARY_ID, requestId: "popup:bind:restart", url: "https://fixture.test/t.wav", fileName: "t.wav" }) });
    assert.equal(save.ok, true);
    // Even a successful write no longer refreshes the recorded nonce.
    assert.equal(binding.serverNonce, nonceBefore);
    high.restart();
    await assert.rejects(
      () => transport.fetch(binding, "/api/media/transfers", { method: "POST", body: "{}" }),
      error => error.code === "binding-service-restarted" && error.restarted === true && error.notDispatched === true);
    // An HTTP 500 receipt answer must not unlock either.
    high.state.mediaReceiptError = true;
    const failed = await transport.fetch(binding, "/api/material-libraries/media-receipt", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryId: LIBRARY_ID, requestId: "popup:bind:restart" }) });
    assert.equal(failed.ok, false);
    assert.equal(binding.serverNonce, nonceBefore);
    await assert.rejects(
      () => transport.fetch(binding, "/api/media/transfers", { method: "POST", body: "{}" }),
      error => error.code === "binding-service-restarted");
    // Explicit confirmation re-verifies identity and records the new nonce.
    high.state.mediaReceiptError = false;
    const confirmed = await transport.confirmBinding(binding);
    assert.equal(confirmed.ok, true);
    assert.equal(binding.serverNonce, high.state.nonce);
    const next = await transport.fetch(binding, "/api/media/transfers", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryId: LIBRARY_ID, requestId: "popup:bind:restart-2", url: "https://fixture.test/t.wav", fileName: "t.wav" }) });
    assert.equal(next.ok, true);
    assert.equal(low.state.business.length, 0);
  });
});

bindingTest("a bound read on a dead endpoint does not fail over to another instance", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const binding = await transport.openBinding(high.port);
    high.state.unreachable = true;
    await assert.rejects(
      () => transport.fetch(binding, "/api/material-libraries"),
      error => error.code === "binding-connection-lost");
    assert.equal(low.state.business.length, 0);
    high.state.unreachable = false;
  });
});

bindingTest("malformed binding descriptors are rejected before any dispatch", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    for (const bad of [
      { version: 2, port: high.port, origin: ORIGIN, fingerprint: await sha256Hex(CREDENTIAL_B) },
      { version: 1, port: 70000, origin: ORIGIN, fingerprint: await sha256Hex(CREDENTIAL_B) },
      { version: 1, port: high.port, origin: "chrome-extension://other", fingerprint: await sha256Hex(CREDENTIAL_B) },
      { version: 1, port: high.port, origin: ORIGIN, fingerprint: "short" },
      { version: 1, port: high.port, origin: ORIGIN, fingerprint: await sha256Hex(CREDENTIAL_B), serverNonce: "zz" },
    ]) {
      await assert.rejects(() => transport.fetch(bad, "/api/material-libraries"),
        error => error.code === "protocol-incompatible");
    }
    assert.equal(low.state.business.length + high.state.business.length, 0);
  });
});

bindingTest("a fixture redirect can never widen a test request's destination", async () => {
  await withTwoDesktops(async ({ low, high, transport }) => {
    const binding = await transport.openBinding(high.port);
    await assert.rejects(() => transport.fetch(binding, "/redirect-evil"),
      error => error instanceof TypeError || error?.code === "binding-connection-lost" || error?.transportFailure === "TypeError");
    // The gate never even attempted the redirect target.
    assert.deepEqual(rejectedFetches, []);
    assert.equal(high.state.business.some(call => call.path === "/redirect-evil"), true);
  });
});

// ---------------------------------------------------------------- Part 2
// The real background.js in a vm sandbox: explicit selection, task-log
// binding, stale-selection fail-closed, service-worker restart, and old
// logs failing closed.

const SCRIPT_NAMES = ["extension-protocol.js", "video-overlay-preference.js", "audio-collection.js",
  "local-transport-auth.js", "media-import-contract.js", "capture-task.js", "appearance.js",
  "material-library-consumer.js", "capture-controller.js", "capture-surface.js",
  "collection-input.js", "collection-batch.js"];

async function loadBackgroundWorker({ stores, desktops, browser = {}, extensionId = "bckeanklmbjhjjomobmfkfjmeokdcfid" }) {
  const origin = `chrome-extension://${extensionId}`;
  const sources = {};
  for (const name of SCRIPT_NAMES) sources[name] = await readFile(new URL(name, EXTENSION_DIR), "utf8");
  const backgroundSource = await readFile(new URL("background.js", EXTENSION_DIR), "utf8");
  const localStore = stores.local, sessionStore = stores.session;
  const messageListeners = [];
  const actionClickListeners = [];
  // Every rejection this worker triggers is recorded BOTH here and in the
  // global log, so attribution never hides an attempt.
  const workerRejected = [];
  const timers = new Set();
  const inflight = new Set();
  const postDisposeStorage = [];
  const protocolRef = { version: 0 };
  const storageCopy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  let closed = false;
  const chromeApi = {
    runtime: {
      id: extensionId, lastError: null,
      getURL: (suffix = "") => `${origin}/${suffix}`,
      onMessage: { addListener: listener => messageListeners.push(listener) },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onConnect: { addListener() {} },
      sendMessage: (message, callback) => {
        const response = Promise.resolve(browser.runtimeMessage?.(message) || {});
        if (typeof callback === "function") response.then(callback);
        return response;
      },
    },
    storage: {
      local: {
        async get(key) { const out = {}; for (const name of [].concat(key)) out[name] = storageCopy(localStore.get(name)); return out; },
        async set(values) {
          if (closed) { postDisposeStorage.push({ area: "local", keys: Object.keys(values) }); return; }
          for (const [key, value] of Object.entries(values)) localStore.set(key, storageCopy(value));
        },
      },
      session: {
        async get(key) { const out = {}; for (const name of [].concat(key)) out[name] = storageCopy(sessionStore.get(name)); return out; },
        async set(values) {
          if (closed) { postDisposeStorage.push({ area: "session", keys: Object.keys(values) }); return; }
          for (const [key, value] of Object.entries(values)) sessionStore.set(key, storageCopy(value));
        },
        async remove(key) {
          if (closed) { postDisposeStorage.push({ area: "session", keys: [].concat(key) }); return; }
          for (const name of [].concat(key)) sessionStore.delete(name);
        },
        async setAccessLevel() {},
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: {
      query: async () => [], get: async id => ({ url: "https://page.test/article", title: "Fixture article", ...browser.tab, id }),
      sendMessage: (tabId, message, options, callback) => {
        const respond = value => {
          if (typeof callback === "function") { callback(value); return true; }
          return Promise.resolve(value);
        };
        const custom = browser.tabMessage?.(tabId, message, { protocolVersion: protocolRef.version });
        if (custom !== undefined) {
          if (typeof callback === "function") Promise.resolve(custom).then(callback);
          return Promise.resolve(custom);
        }
        if (message?.type === "luckyray-get-audio-candidates") {
          return respond({ ok: true, captureProtocolVersion: protocolRef.version, pageUrl: "https://page.test/article",
            documentToken: "doc-token-1",
            candidates: [{ url: "https://fixture.test/tone.wav", contentType: "audio/wav", importable: true, fileName: "tone.wav" }] });
        }
        if (message?.type === "luckyray-get-page-context") {
          return respond({ ok: true, captureProtocolVersion: protocolRef.version, pageUrl: "https://page.test/article",
            url: "https://page.test/article", title: "Fixture article", content: "正文内容", contentKind: "summary" });
        }
        return respond({});
      },
      onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    scripting: { executeScript: async () => {} },
    contextMenus: { removeAll: async () => {}, create() {}, onClicked: { addListener() {} } },
    action: { onClicked: { addListener: listener => actionClickListeners.push(listener) }, openPopup: async () => {} },
    webRequest: { onHeadersReceived: { addListener() {} }, onBeforeRequest: { addListener() {} },
      onResponseStarted: { addListener() {} }, onErrorOccurred: { addListener() {} } },
    notifications: { create() {} },
    ...(browser.offscreen ? { offscreen: browser.offscreen } : {}),
    ...(browser.tabCapture ? { tabCapture: browser.tabCapture } : {}),
  };
  const sandbox = {
    URL, URLSearchParams, Date, Math, JSON, Promise, Map, Set, WeakSet,
    navigator: { userAgent: "Mozilla/5.0 Fixture" },
    setTimeout: (callback, milliseconds, ...args) => {
      const handle = setTimeout(callback, milliseconds, ...args);
      timers.add(handle);
      return handle;
    },
    clearTimeout: handle => { timers.delete(handle); clearTimeout(handle); },
    setInterval: (callback, milliseconds, ...args) => {
      const handle = setInterval(callback, milliseconds, ...args);
      timers.add(handle);
      return handle;
    },
    clearInterval: handle => { timers.delete(handle); clearInterval(handle); },
    console: { log() {}, warn() {}, error() {} },
    crypto: globalThis.crypto,
    AbortController, Headers, TextEncoder, TextDecoder,
    Response: globalThis.Response, Request: globalThis.Request,
    fetch: async (input, init = {}) => {
      if (closed) {
        const record = { host: "disposed-worker", port: null, path: String(input).slice(0, 96) };
        workerRejected.push(record);
        throw Object.assign(new TypeError("worker-disposed"), { testBlocked: true });
      }
      const attempt = (async () => {
        const urlText = String(input instanceof Request ? input.url : input);
        if (urlText.startsWith("https://fixture.test/")) {
          // Browser-side source bytes are synthetic; no external fetch is made.
          return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
            { status: 200, headers: { "content-type": "image/png" } });
        }
        // Everything else must pass the SAME hard gate (recorded, pre-send).
        const headers = new Headers(init.headers || {});
        headers.set("Origin", origin);
        return guardedFetch(input, { ...init, headers }, workerRejected);
      })();
      inflight.add(attempt);
      try { return await attempt; } finally { inflight.delete(attempt); }
    },
    chrome: chromeApi,
    importScripts: (...names) => {
      for (const name of names) {
        if (!sources[name]) throw new Error(`importScripts: unknown script ${name}`);
        vm.runInContext(sources[name], sandbox, { filename: name });
      }
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // The worker must never run the production 37418..37467 scan: that range
  // can host real Desktop instances on this machine. Discovery is pinned to
  // the fixture ports of this test run only — and even if this pin were
  // lost, the module-level guardedFetch would reject before any send.
  sandbox.process = { versions: { node: process.versions.node } };
  sandbox.__LUCKYRAY_TEST_PORTS__ = desktops.map(desktop => desktop.port);
  vm.createContext(sandbox);
  vm.runInContext(backgroundSource, sandbox, { filename: "background.js" });
  protocolRef.version = vm.runInContext("LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION", sandbox);
  const send = message => new Promise((resolve, reject) => {
    let keepAliveAny = false;
    try {
      for (const listener of messageListeners) {
        const keepAlive = listener(message, { id: extensionId, url: `${origin}/popup.html` }, value => resolve(value));
        if (keepAlive === true) keepAliveAny = true;
      }
    } catch (error) { reject(error); return; }
    if (!keepAliveAny) resolve(undefined);
  });
  const sendFromForeignSender = message => new Promise(resolve => {
    let keepAliveAny = false;
    for (const listener of messageListeners) {
      const keepAlive = listener(message, { id: "other-extension", url: "https://page.test/" }, value => resolve(value));
      if (keepAlive === true) keepAliveAny = true;
    }
    if (!keepAliveAny) resolve(undefined);
  });
  const clickAction = async tab => {
    for (const listener of actionClickListeners) await listener(tab);
  };
  const dispose = async () => {
    // Stop every timer, wait for every in-flight request to actually settle
    // (a fixed tick count is NOT quiescence), refuse and record any late
    // request, and forbid storage side effects after this point.
    closed = true;
    for (const handle of [...timers]) { clearTimeout(handle); clearInterval(handle); }
    timers.clear();
    if (inflight.size) await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    for (let i = 0; i < 12; i++) await tick();
    return { rejected: workerRejected, storage: postDisposeStorage };
  };
  const sendFromContentScript = message => new Promise((resolve, reject) => {
    let keepAliveAny = false;
    try {
      for (const listener of messageListeners) {
        const tab = { id: 7, url: "https://page.test/article", title: "Fixture article", ...browser.tab };
        const keepAlive = listener(message, { id: extensionId, url: tab.url, tab, frameId: 0 }, value => resolve(value));
        if (keepAlive === true) keepAliveAny = true;
      }
    } catch (error) { reject(error); return; }
    if (!keepAliveAny) resolve(undefined);
  });
  return { sandbox, send, sendFromForeignSender, sendFromContentScript, clickAction, dispose, rejected: workerRejected, storage: postDisposeStorage };
}

function audioTaskInput(requestId, extra = {}) {
  // Mirrors the popup's library-mode payload: audio preparation rebuilds the
  // request from the fresh candidate and keeps the library binding through
  // the destination object, exactly like an explicit media destination.
  return { kind: "audio", tabId: 7, pageUrl: "https://page.test/article", documentToken: "doc-token-1",
    destination: { libraryId: LIBRARY_ID },
    request: { requestId, url: "https://fixture.test/tone.wav", fileName: "tone.wav", libraryId: LIBRARY_ID },
    ...extra };
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("condition never reached within 5 seconds");
}

// Every test must end with an empty out-of-allowlist attempt log: not a
// single request may even be attempted against anything but this run's own
// fixture ports. The assertion is kept out of the failure path so it adds
// evidence instead of masking the original error.
function bindingTest(name, fn) {
  test(name, async t => {
    rejectedFetches.length = 0;
    try {
      return await fn(t);
    } finally {
      if (rejectedFetches.length) assert.deepEqual(rejectedFetches, [],
        "network gate: destinations outside the fixture allowlist were attempted");
    }
  });
}

const storedBindingOf = stores => stores.session.get("luckyrayConnectionBindingV1") || null;

const waitForRegression = until;

// Browser/Desktop boundaries only: the production recording coordinator,
// protocol and transport remain intact. No real tab capture is started.
function recordingBrowser({ restored = false } = {}) {
  const state = { document: restored, active: restored, recordingId: restored ? "old-recording" : "", calls: [] };
  return { state,
    offscreen: { hasDocument: async () => state.document,
      createDocument: async () => { state.document = true; },
      closeDocument: async () => { state.document = false; state.active = false; } },
    tabCapture: { getMediaStreamId: (_options, callback) => callback("synthetic-stream") },
    runtimeMessage: message => {
      state.calls.push(message);
      if (message.type === "luckyray-offscreen-record-status") return { ok: true, active: state.active, recordingId: state.recordingId, tabId: 7 };
      if (message.type === "luckyray-offscreen-record-start") {
        state.active = true; state.recordingId = message.recordingId; return { ok: true };
      }
      if (["luckyray-offscreen-record-stop", "luckyray-offscreen-record-cancel"].includes(message.type)) {
        state.active = false; return { ok: true, base64: "Zml4dHVyZQ==", size: 7 };
      }
      return {};
    } };
}

async function withRegressionWorker(browser, run) {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "recording-A" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "other-B" });
  const stores = { local: new Map(), session: new Map() }, workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high], browser });
    workers.push(worker);
    const choices = await worker.send({ type: "luckyray-popup-get-port" });
    assert.equal(choices.code, "multiple-instances", JSON.stringify({ code: choices.code, port: choices.port,
      candidates: choices.candidates?.map(candidate => candidate.port), fixtures: [low.port, high.port] }));
    const choose = async desktop => {
      const result = await worker.send({ type: "luckyray-popup-select-connection",
        candidate: choices.candidates.find(candidate => candidate.port === desktop.port) });
      assert.equal(result.ok, true); return result;
    };
    await choose(low);
    await run({ worker, low, high, stores, choose, workers });
  } finally {
    try {
      for (const worker of workers) {
        const leftover = await worker.dispose();
        assert.deepEqual(leftover.rejected, [], "late requests after dispose");
        assert.deepEqual(leftover.storage, [], "storage writes after dispose");
      }
    } finally { await low.stop(); await high.stop(); }
  }
}

bindingTest("R11 recording: stop clears active state but saves with the start connection after selecting another instance", async () => {
  const browser = recordingBrowser();
  await withRegressionWorker(browser, async ({ worker, low, high, choose }) => {
    low.state.sourcePageAvailable = true;
    assert.equal((await worker.send({ type: "luckyray-record-start", tabId: 7,
      pageUrl: "https://page.test/article", pageTitle: "Fixture recording" })).ok, true);
    await choose(high);
    let releaseSave;
    low.state.holdRecordingSaveOnce = new Promise(resolve => { releaseSave = resolve; });
    const saving = worker.send({ type: "luckyray-record-stop" });
    let result;
    try {
      await waitForRegression(() => low.state.business.some(call => call.path === "/api/video/record/save"));
      assert.equal((await worker.send({ type: "luckyray-record-status" })).active, false,
        "live state is cleared before the Desktop save response arrives");
    } finally { releaseSave(); result = await saving; }
    assert.equal(result.ok, true);
    assert.equal(result.assetId, "fixture-recording");
    assert.equal(result.kind, "video");
    assert.equal(result.sourcePageUnsupported, false);
    assert.equal((await worker.send({ type: "luckyray-record-status" })).active, false);
    assert.equal(browser.state.active, false);
    const saves = low.state.business.filter(call => call.path === "/api/video/record/save");
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.sourcePageUrl, "https://page.test/article");
    assert.equal(saves[0].body.sourcePageKind, "capture-page");
    assert.equal(low.state.business.filter(call => call.path === "/api/v1/capabilities").length, 1);
    assert.equal(high.state.business.length, 0, "re-selected instance receives zero business requests");
  });
});

bindingTest("R11 recording failure: a rejected save and its failure history stay on the original instance", async () => {
  await withRegressionWorker(recordingBrowser(), async ({ worker, low, high, choose }) => {
    low.state.recordingSaveError = true;
    assert.equal((await worker.send({ type: "luckyray-record-start", tabId: 7,
      pageUrl: "https://page.test/article", pageTitle: "Rejected fixture" })).ok, true);
    await choose(high);
    const result = await worker.send({ type: "luckyray-record-stop" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "recording-save-failed");
    assert.equal((await worker.send({ type: "luckyray-record-status" })).active, false);
    assert.equal(low.state.business.filter(call => call.path === "/api/video/record/save").length, 1);
    const failures = low.state.business.filter(call => call.path === "/api/collection/failures");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].body.reason, "recording-save-failed");
    assert.equal(high.state.business.length, 0);
  });
});

bindingTest("R11 recording recovery: an offscreen recording without its original binding cannot save or report to the current selection", async () => {
  await withRegressionWorker(recordingBrowser({ restored: true }), async ({ worker, low, high, choose }) => {
    await choose(high);
    const result = await worker.send({ type: "luckyray-record-stop" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "recording-save-failed");
    assert.equal((await worker.send({ type: "luckyray-record-status" })).active, false);
    assert.equal(low.state.business.length, 0);
    assert.equal(high.state.business.length, 0, "missing binding must not resolve the selected instance");
  });
});

bindingTest("R11 recording callback: cancel clears state but offscreen failure history uses the original snapshot", async () => {
  const browser = recordingBrowser();
  await withRegressionWorker(browser, async ({ worker, low, high, choose }) => {
    assert.equal((await worker.send({ type: "luckyray-record-start", tabId: 7 })).ok, true);
    await choose(high);
    const id = browser.state.recordingId;
    assert.equal((await worker.send({ type: "luckyray-record-fail", recordingId: "different-recording", code: "recording-size-limit" })).ok, true);
    assert.equal(browser.state.active, true, "late failure of another recording is ignored");
    assert.equal((await worker.send({ type: "luckyray-record-fail", recordingId: id, code: "recording-size-limit" })).ok, true);
    assert.equal((await worker.send({ type: "luckyray-record-status" })).active, false);
    assert.equal(low.state.business.filter(call => call.path === "/api/collection/failures").length, 1);
    assert.equal(low.state.business.some(call => call.path === "/api/video/record/save"), false);
    assert.equal(high.state.business.length, 0);
  });
});

bindingTest("R12 drag video: a non-Pinterest player keeps its entry connection through an async menu and transfer", async () => {
  const browser = recordingBrowser();
  browser.state.document = true;
  let releaseMenu;
  const menuGate = new Promise(resolve => { releaseMenu = resolve; });
  const respond = browser.runtimeMessage;
  browser.runtimeMessage = async message => {
    const result = respond(message);
    if (message.type === "luckyray-offscreen-record-status") await menuGate;
    return result;
  };
  await withRegressionWorker(browser, async ({ worker, low, high, choose, stores }) => {
    low.state.sourcePageAvailable = true;
    const saving = worker.sendFromContentScript({ type: "luckyray-drag-collect", mediaType: "video", resolveVideo: true,
      libraryId: LIBRARY_ID, actionId: "fixture-direct", capturePageUrl: "https://page.test/article",
      playerCandidates: [{ url: "https://fixture.test/card.mp4", contentType: "video/mp4", width: 1920, height: 1080 }] });
    let result;
    try {
      await until(() => browser.state.calls.some(call => call.type === "luckyray-offscreen-record-status"));
      await choose(high);
    } finally { releaseMenu(); result = await saving; }
    assert.equal(result.ok, true);
    assert.equal(result.transfer.state, "running");
    assert.equal(result.sourcePageUnsupported, false);
    const saves = low.state.business.filter(call => call.path === "/api/media/transfers");
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.url, "https://fixture.test/card.mp4");
    assert.equal(saves[0].body.materialSourcePageUrl, "https://page.test/article");
    const recorded = stores.session.get("luckyrayMediaTransferBindingsV1").find(item => item.transferId === result.transfer.transferId);
    assert.equal(recorded.connection.port, low.port);
    const context = { type: "luckyray-video-overlay-action", sessionId: recorded.sessionId, candidateId: recorded.candidateId };
    assert.equal((await worker.sendFromContentScript({ ...context, action: "media-transfer-status" })).ok, true);
    assert.equal(high.state.business.length, 0, "all drag preparation/status traffic stays with the entry binding");
  });
});

for (const scenario of ["slow", "lost-reply"]) bindingTest(`drag image ${scenario}: one original import reaches its canonical receipt without an early failure`, async () => {
  await withRegressionWorker({}, async ({ worker, low, high }) => {
    low.state.sourcePageAvailable = true;
    low.state.imageDelayMs = scenario === "slow" ? 5200 : 0;
    low.state.dropImageResponse = scenario === "lost-reply";
    const result = await worker.sendFromContentScript({ type: "luckyray-drag-collect", mediaType: "image",
      url: "https://fixture.test/image.png", libraryId: LIBRARY_ID, actionId: `fixture-image-${scenario}`,
      capturePageUrl: "https://page.test/article" });
    assert.equal(result.ok, true, "a delayed/lost reply is not proof that the import failed");
    assert.equal(result.asset.id, "fixture-asset");
    assert.equal(result.asset.kind, "image");
    assert.equal(low.state.business.filter(call => call.path === "/api/assets/import-media").length, 1,
      "receipt reconciliation must never resend the original import");
    const lookups = low.state.business.filter(call => call.path === "/api/material-libraries/media-receipt");
    assert.equal(lookups.length, scenario === "lost-reply" ? 1 : 0);
    if (lookups.length) {
      const submitted = low.state.business.find(call => call.path === "/api/assets/import-media").body;
      assert.deepEqual(lookups[0].body, { libraryId: submitted.libraryId, requestId: submitted.requestId, operation: "image" });
    }
    assert.equal(high.state.business.length, 0);
  });
});

bindingTest("lost direct-video start reply stays unknown, not failed, and never starts another job", async () => {
  await withRegressionWorker({}, async ({ worker, low, high }) => {
    low.state.dropWriteResponse = true;
    const result = await worker.sendFromContentScript({ type: "luckyray-drag-collect", mediaType: "video",
      url: "https://fixture.test/card.mp4", contentType: "video/mp4", libraryId: LIBRARY_ID,
      actionId: "fixture-video-lost", capturePageUrl: "https://page.test/article" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "request-outcome-unknown");
    assert.match(result.message, /核对/);
    assert.doesNotMatch(result.message, /失败.*重试/);
    assert.equal(low.state.business.filter(call => call.path === "/api/media/transfers").length, 1);
    assert.equal(high.state.business.length, 0);
  });
});

bindingTest("lost drag-image reply with unavailable receipt stays unknown and cannot report success or resend", async () => {
  await withRegressionWorker({}, async ({ worker, low, high }) => {
    low.state.dropImageResponse = true;
    low.state.mediaReceiptError = true;
    const result = await worker.sendFromContentScript({ type: "luckyray-drag-collect", mediaType: "image",
      url: "https://fixture.test/image.png", libraryId: LIBRARY_ID, actionId: "fixture-image-unconfirmed",
      capturePageUrl: "https://page.test/article" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "request-outcome-unknown");
    assert.equal(result.asset, undefined);
    assert.match(result.message, /核对/);
    assert.equal(low.state.business.filter(call => call.path === "/api/assets/import-media").length, 1);
    assert.equal(low.state.business.filter(call => call.path === "/api/material-libraries/media-receipt").length, 1);
    assert.equal(high.state.business.length, 0);
  });
});

for (const probeError of [false, true]) bindingTest(`R12 Pinterest drag: ${probeError ? "failed probe keeps the exact card fallback" : "resolved format upgrade"} stays on the entry connection`, async () => {
  const browser = { tab: { url: "https://www.pinterest.com/", title: "Fixture card" } };
  await withRegressionWorker(browser, async ({ worker, low, high, choose, stores }) => {
    low.state.sourcePageAvailable = true;
    low.state.probeError = probeError;
    let releaseProbe;
    low.state.holdProbeOnce = new Promise(resolve => { releaseProbe = resolve; });
    const saving = worker.sendFromContentScript({ type: "luckyray-drag-collect", mediaType: "video", resolveVideo: true,
      libraryId: LIBRARY_ID, actionId: "fixture-pinterest", capturePageUrl: browser.tab.url,
      resolverPageUrl: "https://www.pinterest.com/pin/123456789/",
      sourcePageUrl: "https://www.pinterest.com/pin/123456789/", sourcePageKind: "work-page",
      playerCandidates: [{ url: "https://v.pinimg.com/videos/card.cmfv", contentType: "video/mp4", width: 360, height: 640 }] });
    let result;
    try {
      await until(() => low.state.business.some(call => call.path === "/api/media/probes"));
      await choose(high);
    } finally { releaseProbe(); result = await saving; }
    assert.equal(result.ok, true);
    assert.equal(result.sourcePageUnsupported, false);
    const probes = low.state.business.filter(call => call.path === "/api/media/probes");
    assert.equal(probes.length, 1);
    assert.equal(probes[0].body.url, "https://www.pinterest.com/pin/123456789/");
    const saves = low.state.business.filter(call => call.path === "/api/media/transfers");
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.url, probeError ? "https://v.pinimg.com/videos/card.cmfv" : "https://www.pinterest.com/pin/123456789/");
    assert.equal(saves[0].body.materialSourcePageUrl, "https://www.pinterest.com/pin/123456789/");
    assert.equal(saves[0].body.sourcePageKind, "work-page");
    assert.equal(Boolean(saves[0].body.probeId), !probeError);
    const recorded = stores.session.get("luckyrayMediaTransferBindingsV1").find(item => item.transferId === result.transfer.transferId);
    assert.equal(recorded.connection.port, low.port);
    assert.equal(high.state.business.length, 0, "probe, capability, destination and transfer never follow the new selection");
  });
});

bindingTest("R12 Pinterest adaptive drag: the bound master skips the optional probe and preserves its original connection", async () => {
  const browser = { tab: { url: "https://www.pinterest.com/", title: "Fixture master" } };
  await withRegressionWorker(browser, async ({ worker, low, high, choose }) => {
    low.state.sourcePageAvailable = true;
    let releaseLibrary;
    low.state.holdLibraryOnce = new Promise(resolve => { releaseLibrary = resolve; });
    const saving = worker.sendFromContentScript({ type: "luckyray-drag-collect", mediaType: "video", resolveVideo: true,
      libraryId: LIBRARY_ID, actionId: "fixture-master", capturePageUrl: browser.tab.url,
      resolverPageUrl: "https://www.pinterest.com/pin/123456789/",
      playerCandidates: [{ url: "https://v.pinimg.com/videos/card.cmfv", contentType: "video/mp4", width: 360, height: 640 },
        { url: "https://v.pinimg.com/videos/card.m3u8", contentType: "application/vnd.apple.mpegurl", width: 0, height: 0 }] });
    let result;
    try {
      await until(() => low.state.business.some(call => call.path === "/api/material-libraries"));
      await choose(high);
    } finally { releaseLibrary(); result = await saving; }
    assert.equal(result.ok, true);
    const saves = low.state.business.filter(call => call.path === "/api/media/transfers");
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.url, "https://v.pinimg.com/videos/card.m3u8");
    assert.equal(low.state.business.filter(call => call.path === "/api/media/probes").length, 0);
    assert.equal(high.state.business.length, 0);
  });
});

function imageBrowser(count = 2) {
  const pageUrl = "https://page.test/article", session = "fixture-image-document";
  const candidates = Array.from({ length: count }, (_, index) => ({ id: `${session}:${index + 1}`,
    url: `https://fixture.test/image-${index + 1}.png`, name: `Image ${index + 1}`,
    binding: { documentToken: session, targetToken: `image-target-${index + 1}`, linkUrl: null } }));
  const state = { renewals: [], holdRenew: null };
  return { state,
    tabMessage: async (_tabId, message, { protocolVersion }) => {
      if (message.type === "luckyray-image-collection") return { ok: true, pageUrl, session, documentToken: session,
        candidates, captureProtocolVersion: protocolVersion };
      if (message.type !== "luckyray-image-renew") return { captureProtocolVersion: protocolVersion };
      state.renewals.push(message);
      if (state.holdRenew) await state.holdRenew(message);
      const item = candidates.find(candidate => candidate.id === message.id && candidate.url === message.url);
      return { ok: Boolean(item), pageUrl, captureProtocolVersion: protocolVersion,
        ...(item ? { descriptor: { url: item.url, ...item.binding } } : {}) };
    } };
}

async function batchFixtureInput(worker) {
  const images = await worker.send({ type: "luckyray-popup-images", tabId: 7, pageUrl: "https://page.test/article" });
  assert.equal(images.ok, true);
  return { source: { session: images.session, tabId: 7, pageUrl: images.pageUrl },
    target: { mode: "asset:root", destination: { libraryId: LIBRARY_ID }, namePrefix: "Fixture images" },
    items: images.candidates.map(({ id, url, name, binding }) => ({ id, url, name, binding })) };
}

bindingTest("R13 image batch: renewal, capability, destination and every item keep the persisted entry connection after a new selection", async () => {
  const browser = imageBrowser();
  await withRegressionWorker(browser, async ({ worker, low, high, choose, stores }) => {
    low.state.sourcePageAvailable = true;
    let releaseRenew;
    const renewGate = new Promise(resolve => { releaseRenew = resolve; });
    browser.state.holdRenew = () => renewGate;
    const started = await worker.send({ type: "luckyray-image-batch", action: "start", input: await batchFixtureInput(worker) });
    assert.equal(started.ok, true);
    try {
      await waitForRegression(() => browser.state.renewals.length > 0);
      await choose(high);
    } finally { releaseRenew(); }
    await waitForRegression(() => ["completed", "partial", "paused", "unknown"].includes(stores.local.get("luckyrayImageBatchV1")?.stage));
    const finished = (await worker.send({ type: "luckyray-image-batch", action: "status" })).batch;
    assert.equal(finished.stage, "completed", JSON.stringify(finished.items.map(item => ({ state: item.state, errorCode: item.errorCode }))));
    const saves = low.state.business.filter(call => call.path === "/api/assets/import-media");
    assert.equal(saves.length, 2, "every queued import must go to the original instance");
    assert.equal(new Set(saves.map(call => call.body.requestId)).size, 2);
    assert.ok(saves.every(call => call.body.sourcePageUrl === "https://page.test/article"));
    assert.ok(saves.every(call => call.body.sourcePageTitle === "Fixture article"));
    assert.ok(finished.items.every(item => item.state === "saved" && item.asset.id === "fixture-asset" && item.asset.kind === "image"));
    assert.equal(finished.connection.port, low.port);
    assert.equal(JSON.stringify(finished.connection), JSON.stringify(started.batch.connection));
    assert.equal(started.batch.connection.generation, finished.connection.generation);
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").connection.port, low.port);
    assert.equal(stores.local.get("luckyrayImageBatchV1").connection.port, low.port);
    assert.equal(JSON.stringify(stores.local.get("luckyrayImageBatchV1")).includes(CREDENTIAL_A), false);
    assert.ok(stores.local.get("luckyrayImageBatchV1").items.every(item => !("url" in item)), "source URLs remain session-only");
    assert.equal(high.state.business.length, 0, "capabilities, destinations and imports never follow the new selection");
  });
});

bindingTest("R13 batch recovery: pause and service-worker restart retain the original binding without re-importing a saved item", async () => {
  const browser = imageBrowser();
  await withRegressionWorker(browser, async ({ worker, low, high, choose, stores, workers }) => {
    low.state.sourcePageAvailable = true;
    let releaseSecond;
    const gate = new Promise(resolve => { releaseSecond = resolve; });
    browser.state.holdRenew = message => message.index === 2 ? gate : undefined;
    const started = await worker.send({ type: "luckyray-image-batch", action: "start", input: await batchFixtureInput(worker) });
    assert.equal(started.ok, true);
    try {
      await waitForRegression(() => browser.state.renewals.length === 2);
      await choose(high);
      assert.equal((await worker.send({ type: "luckyray-image-batch", action: "stop", id: started.batch.id })).ok, true);
    } finally { releaseSecond(); }
    await waitForRegression(() => stores.local.get("luckyrayImageBatchV1").stage === "paused");
    const paused = (await worker.send({ type: "luckyray-image-batch", action: "status" })).batch;
    assert.equal(paused.items[0].state, "saved");
    assert.equal(paused.items[1].state, "queued");
    assert.equal(low.state.business.filter(call => call.path === "/api/assets/import-media").length, 1);
    const persisted = JSON.stringify([...stores.local]);
    const leftover = await worker.dispose();
    workers.splice(workers.indexOf(worker), 1);
    assert.deepEqual(leftover.rejected, []);
    assert.deepEqual(leftover.storage, []);
    assert.equal(JSON.stringify([...stores.local]), persisted, "old worker is quiescent before recovery");
    const recovered = await loadBackgroundWorker({ stores, desktops: [low, high], browser });
    workers.push(recovered);
    assert.equal((await recovered.send({ type: "luckyray-popup-get-port" })).port, high.port, "selection B survived the worker restart");
    assert.equal((await recovered.send({ type: "luckyray-image-batch", action: "resume", id: paused.id })).ok, true);
    await waitForRegression(() => stores.local.get("luckyrayImageBatchV1").stage === "completed");
    const finished = (await recovered.send({ type: "luckyray-image-batch", action: "status" })).batch;
    assert.deepEqual(finished.items.map(item => item.requestId), paused.items.map(item => item.requestId));
    assert.ok(finished.items.every(item => item.state === "saved" && item.asset.kind === "image"));
    const saves = low.state.business.filter(call => call.path === "/api/assets/import-media");
    assert.equal(saves.length, 2);
    assert.deepEqual(saves.map(call => call.body.requestId), paused.items.map(item => item.requestId));
    assert.equal(finished.connection.port, low.port);
    assert.equal(JSON.stringify(finished.connection), JSON.stringify(started.batch.connection));
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").connection.port, low.port);
    assert.equal(high.state.business.length, 0);
  });
});

bindingTest("R13 batch retry: a definite item failure retries only on the batch's original instance", async () => {
  const browser = imageBrowser(1);
  await withRegressionWorker(browser, async ({ worker, low, high, choose, stores }) => {
    low.state.imageImportRejectOnce = true;
    const started = await worker.send({ type: "luckyray-image-batch", action: "start", input: await batchFixtureInput(worker) });
    assert.equal(started.ok, true);
    await waitForRegression(() => stores.local.get("luckyrayImageBatchV1").stage === "partial");
    const failed = (await worker.send({ type: "luckyray-image-batch", action: "status" })).batch;
    assert.equal(failed.items[0].state, "failed");
    await choose(high);
    assert.equal((await worker.send({ type: "luckyray-image-batch", action: "retry", id: failed.id })).ok, true);
    await waitForRegression(() => stores.local.get("luckyrayImageBatchV1").stage === "completed");
    const finished = (await worker.send({ type: "luckyray-image-batch", action: "status" })).batch;
    assert.notEqual(finished.items[0].requestId, failed.items[0].requestId, "definite failure retains the established new-action retry semantics");
    assert.equal(finished.items[0].asset.kind, "image");
    assert.equal(finished.connection.port, low.port);
    assert.equal(low.state.business.filter(call => call.path === "/api/assets/import-media").length, 2);
    assert.equal(high.state.business.length, 0);
  });
});

for (const badBinding of [null, { version: 1, port: 0, fingerprint: "not-a-binding" }]) bindingTest(
  `R13 legacy batch: ${badBinding ? "malformed" : "missing"} original connection fails closed on worker recovery`, async () => {
  const browser = imageBrowser(1);
  await withRegressionWorker(browser, async ({ worker, low, high, choose, stores, workers }) => {
    const input = await batchFixtureInput(worker);
    await choose(high);
    const leftover = await worker.dispose();
    workers.splice(workers.indexOf(worker), 1);
    assert.deepEqual(leftover.rejected, []);
    assert.deepEqual(leftover.storage, []);
    // Fixture input representing a pre-binding/malformed durable journal,
    // loaded by the production reader at a normal worker restart.
    const batchId = "fixture-legacy-batch", requestId = "popup:batch:legacy";
    const { url, ...item } = input.items[0];
    stores.local.set("luckyrayImageBatchV1", { version: 1, id: batchId, stage: "paused", source: input.source,
      target: input.target, items: [{ ...item, index: 1, requestId, state: "queued" }],
      ...(badBinding ? { connection: badBinding } : {}) });
    stores.session.set("luckyrayImageBatchUrlsV1", { batchId, urls: { [requestId]: url } });
    const recovered = await loadBackgroundWorker({ stores, desktops: [low, high], browser });
    workers.push(recovered);
    assert.equal((await recovered.send({ type: "luckyray-image-batch", action: "resume", id: batchId })).ok, true);
    await waitForRegression(() => stores.local.get("luckyrayImageBatchV1").stage === "partial");
    const result = (await recovered.send({ type: "luckyray-image-batch", action: "status" })).batch;
    assert.equal(result.items[0].state, "failed");
    assert.equal(result.items[0].errorCode, "capture-task-binding-missing");
    assert.equal(stores.local.has("luckyrayCaptureTaskV1"), false);
    assert.equal(browser.state.renewals.length, 0);
    assert.equal(low.state.business.length, 0);
    assert.equal(high.state.business.length, 0, "legacy queue never acquires the new global selection");
  });
});

bindingTest("two instances force an explicit choice; the pick binds every later task and the other instance sees no business traffic", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const state = await worker.send({ type: "luckyray-popup-get-port" });
    assert.equal(state.port, null, JSON.stringify({ lowPort: low.port, highPort: high.port, code: state.code,
      selectedPort: state.port, lowControl: low.state.control.map(call => call.path), highControl: high.state.control.map(call => call.path) }));
    assert.equal(state.code, "multiple-instances");
    assert.equal(state.candidates.length, 2);
    assert.deepEqual([...state.candidates.map(candidate => candidate.port)].sort((a, b) => a - b), [low.port, high.port]);

    // A foreign sender cannot select the connection, and neither can a
    // port-only pick: the full descriptor the user saw is required.
    const foreign = await worker.sendFromForeignSender({ type: "luckyray-popup-select-connection", candidate: { version: 1, port: low.port, origin: ORIGIN, fingerprint: await sha256Hex(CREDENTIAL_A) } });
    assert.equal(foreign.ok, false);
    const portOnly = await worker.send({ type: "luckyray-popup-select-connection", port: low.port });
    assert.equal(portOnly.ok, false);
    assert.equal(portOnly.code, "connection-select-invalid");

    // Explicitly choose the HIGH port while the low one also answers.
    const highDescriptor = state.candidates.find(candidate => candidate.port === high.port);
    const picked = await worker.send({ type: "luckyray-popup-select-connection", candidate: highDescriptor });
    assert.equal(picked.ok, true);
    assert.equal(picked.port, high.port);
    assert.equal(picked.fingerprint, await sha256Hex(CREDENTIAL_B));
    assert.equal(picked.serverNonce, high.state.nonce);

    const again = await worker.send({ type: "luckyray-popup-get-port" });
    assert.equal(again.port, high.port);
    assert.equal(again.serverNonce, high.state.nonce);

    const started = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:choose-high") });
    assert.equal(started.ok, true);
    const stored = stores.local.get("luckyrayCaptureTaskV1");
    assert.equal(stored.connection.port, high.port);
    assert.equal(stored.connection.fingerprint, await sha256Hex(CREDENTIAL_B));
    assert.equal(JSON.stringify(stored).includes(CREDENTIAL_B), false);
    await until(() => ["completed", "partial", "uncertain", "paused", "failed"].includes(stores.local.get("luckyrayCaptureTaskV1").stage));
    const finished = stores.local.get("luckyrayCaptureTaskV1");
    assert.equal(finished.stage, "completed");
    assert.equal(finished.asset.id, "fixture-asset");
    // The low instance shares the same libraryId but must stay untouched.
    assert.equal(low.state.business.length, 0);
    assert.ok(high.state.business.some(call => call.path === "/api/media/transfers"));
    assert.deepEqual(worker.rejected, []);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("R1: a vanished selection stays recorded and every later dispatch fails closed until an explicit re-selection", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    let port = await worker.send({ type: "luckyray-popup-get-port" });
    const lowDescriptor = port.candidates.find(candidate => candidate.port === low.port);
    await worker.send({ type: "luckyray-popup-select-connection", candidate: lowDescriptor });
    const businessBefore = low.state.business.length;
    assert.ok(businessBefore >= 0);

    // The chosen instance disappears while the other one offers the SAME
    // libraryId. Nothing may silently move to it.
    low.state.unreachable = true;
    const stalePort = await worker.send({ type: "luckyray-popup-get-port" });
    assert.equal(stalePort.port, null);
    assert.equal(stalePort.code, "connection-selection-stale");
    assert.equal(stalePort.stale.port, low.port);
    assert.ok(stalePort.candidates.every(candidate => candidate.port !== low.port));

    const started = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:r1") });
    assert.equal(started.ok, false);
    // The stale selection is KEPT, not cleared and not re-bound to the other.
    assert.equal(storedBindingOf(stores)?.port, low.port);
    assert.equal(storedBindingOf(stores)?.fingerprint, await sha256Hex(CREDENTIAL_A));
    assert.equal(high.state.business.length, 0);
    // Note-reads and icon-collect fail closed on the same stale selection.
    const note = await worker.send({ type: "luckyray-popup-get-current-note" });
    assert.equal(note.noteId, null);
    assert.equal(note.hasCursor, false);
    await worker.clickAction({ id: 7, url: "https://page.test/article" });
    // collectPage swallows transport failures into a clipboard fallback, so
    // the observable contract is that NO business request left for anyone.
    assert.equal(high.state.business.some(call => call.path === "/collect"), false);
    assert.equal(high.state.business.length, 0);

    // An explicit re-selection of the remaining instance unblocks the funnel.
    const reselected = await worker.send({ type: "luckyray-popup-select-connection",
      candidate: stalePort.candidates.find(candidate => candidate.port === high.port) });
    assert.equal(reselected.ok, true);
    const restarted = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:r1-after") });
    assert.equal(restarted.ok, true);
    await until(() => ["completed", "partial", "uncertain", "paused", "failed"].includes(stores.local.get("luckyrayCaptureTaskV1").stage));
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").stage, "completed");
    assert.ok(high.state.business.some(call => call.path === "/api/media/transfers" && call.body.requestId === "popup:bind:r1-after"));
    assert.deepEqual(worker.rejected, []);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("R3: after a restart the task reconciles through the durable receipt; a 500 answer never unlocks", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    await worker.send({ type: "luckyray-popup-select-connection",
      candidate: port.candidates.find(candidate => candidate.port === high.port) });
    high.state.holdRunning = true;
    const started = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:r3") });
    assert.equal(started.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "transferring");
    const nonceBefore = stores.local.get("luckyrayCaptureTaskV1").connection.serverNonce;

    // Same credential, new instance nonce, in-memory transfers gone; the
    // durable receipts survive.
    high.restart();
    await until(() => ["uncertain", "paused"].includes(stores.local.get("luckyrayCaptureTaskV1").stage));

    // A failing receipt answer keeps the task explicitly unknown and does
    // NOT refresh the recorded nonce.
    high.state.mediaReceiptError = true;
    stores.local.get("luckyrayCaptureTaskV1").stage = "paused";
    stores.local.get("luckyrayCaptureTaskV1").errorCode = null;
    const resume500 = await worker.send({ type: "luckyray-capture-task", action: "resume", id: "popup:bind:r3" });
    assert.equal(resume500.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "uncertain");
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").connection.serverNonce, nonceBefore);

    // The verified durable receipt confirms the original action; only then
    // the recorded nonce advances and the task completes.
    high.state.mediaReceiptError = false;
    stores.local.get("luckyrayCaptureTaskV1").stage = "paused";
    stores.local.get("luckyrayCaptureTaskV1").errorCode = null;
    const resumed = await worker.send({ type: "luckyray-capture-task", action: "resume", id: "popup:bind:r3" });
    assert.equal(resumed.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "completed");
    const finished = stores.local.get("luckyrayCaptureTaskV1");
    assert.equal(finished.asset.id, "fixture-asset");
    assert.equal(finished.connection.serverNonce, high.state.nonce);
    assert.notEqual(finished.connection.serverNonce, nonceBefore);
    assert.equal(low.state.business.length, 0);
    assert.deepEqual(worker.rejected, []);
  } finally {
    high.state.holdRunning = false;
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("R4: a selection for a port whose identity changed after display is rejected field-by-field", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    const seenLow = port.candidates.find(candidate => candidate.port === low.port);
    // Between display and click, the low port is re-occupied by a DIFFERENT
    // identity: the displayed descriptor must not select it by port alone.
    await low.stop();
    const replacement = await startDesktop({ credential: CREDENTIAL_C, name: "replacement", listenPort: low.port });
    try {
      const stalePick = await worker.send({ type: "luckyray-popup-select-connection", candidate: seenLow });
      assert.equal(stalePick.ok, false);
      assert.equal(stalePick.code, "connection-select-stale");
      assert.equal(storedBindingOf(stores), null);
      assert.equal(replacement.state.business.length, 0);
      // The surviving displayed instance can still be chosen explicitly.
      const ok = await worker.send({ type: "luckyray-popup-select-connection",
        candidate: port.candidates.find(candidate => candidate.port === high.port) });
      assert.equal(ok.ok, true);
      assert.equal(storedBindingOf(stores).port, high.port);
      assert.deepEqual(worker.rejected, []);
    } finally {
      await replacement.stop();
    }
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await high.stop();
  }
});

bindingTest("R2: note reads and icon page-collect ride the chosen binding; the other instance is never contacted", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    await worker.send({ type: "luckyray-popup-select-connection",
      candidate: port.candidates.find(candidate => candidate.port === high.port) });

    const note = await worker.send({ type: "luckyray-popup-get-current-note" }); assert.equal(note.noteId, "fixture-note");
    assert.equal(high.state.business.some(call => call.path === "/api/notes/current"), true);

    await worker.clickAction({ id: 7, url: "https://page.test/article" });
    assert.equal(high.state.business.some(call => call.path === "/collect"), true);
    assert.equal(low.state.business.length, 0);
    assert.deepEqual(worker.rejected, []);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("a bound task whose instance dies pauses or reports unknown and never switches; cancel/resume/status stay on the bound endpoint", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    await worker.send({ type: "luckyray-popup-select-connection",
      candidate: port.candidates.find(candidate => candidate.port === high.port) });
    high.state.holdRunning = true;
    const started = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:dies") });
    assert.equal(started.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "transferring");
    high.state.unreachable = true;
    await worker.send({ type: "luckyray-capture-task", action: "status" });
    await until(() => ["paused", "uncertain"].includes(stores.local.get("luckyrayCaptureTaskV1").stage));
    assert.equal(["paused", "uncertain"].includes(stores.local.get("luckyrayCaptureTaskV1").stage), true);
    const cancelled = await worker.send({ type: "luckyray-capture-task", action: "cancel", id: "popup:bind:dies" });
    assert.equal(cancelled.ok, false);
    assert.equal(low.state.business.length, 0);
    high.state.unreachable = false;
    const retried = await worker.send({ type: "luckyray-capture-task", action: "cancel", id: "popup:bind:dies" });
    assert.equal(retried.ok, true);
    assert.equal(low.state.business.length, 0);
    assert.deepEqual(worker.rejected, []);
  } finally {
    high.state.holdRunning = false;
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("a service-worker restart reloads the persisted binding and keeps dispatching to the same instance", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const first = await loadBackgroundWorker({ stores, desktops: [low, high] });
    const port = await first.send({ type: "luckyray-popup-get-port" });
    await first.send({ type: "luckyray-popup-select-connection",
      candidate: port.candidates.find(candidate => candidate.port === high.port) });
    high.state.holdRunning = true;
    const started = await first.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:sw-restart") });
    assert.equal(started.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "transferring");

    // Dispose the old worker BEFORE the new one exists: exactly one live
    // writer at any moment, no orphaned pollers.
    assert.deepEqual(first.rejected, []);
    const sessionSnapshot = JSON.stringify([...stores.session.entries()]);
    const localSnapshot = JSON.stringify([...stores.local.entries()]);
    const firstLeftover = await first.dispose();
    assert.deepEqual(firstLeftover.rejected, []);
    // Effects are forbidden: the shared stores are byte-identical after the
    // old worker settles. Bounded ATTEMPTS are tolerated only for the dying
    // task's own log tail — never the selection or transfer bindings.
    assert.equal(JSON.stringify([...stores.session.entries()]), sessionSnapshot);
    assert.equal(JSON.stringify([...stores.local.entries()]), localSnapshot);
    for (const attempt of firstLeftover.storage) {
      assert.deepEqual(attempt.keys, ["luckyrayCaptureTaskV1"]);
    }
    workers.length = 0;

    const second = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(second);
    const portAgain = await second.send({ type: "luckyray-popup-get-port" });
    assert.equal(portAgain.port, high.port);
    assert.equal(portAgain.code, null);
    const resumed = await second.send({ type: "luckyray-capture-task", action: "status" });
    assert.equal(resumed.ok, true);
    high.state.holdRunning = false;
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "completed");
    assert.equal(low.state.business.length, 0);
    assert.deepEqual(second.rejected, []);
  } finally {
    high.state.holdRunning = false;
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("an old task log without a binding fails closed on both instances after a worker restart", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  stores.local.set("luckyrayCaptureTaskV1", { version: 1, id: "popup:legacy:unbound", kind: "audio", stage: "paused",
    transferId: "media-ff-0000000000000001", mediaIdentity: { libraryId: LIBRARY_ID, requestId: "popup:legacy:unbound", operation: "video" } });
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const status = await worker.send({ type: "luckyray-capture-task", action: "status" });
    assert.equal(status.ok, true);
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").stage, "paused");
    assert.equal(low.state.business.length, 0);
    assert.equal(high.state.business.length, 0);
    const resumed = await worker.send({ type: "luckyray-capture-task", action: "resume", id: "popup:legacy:unbound" });
    assert.equal(resumed.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "uncertain");
    const task = stores.local.get("luckyrayCaptureTaskV1");
    assert.equal(task.errorCode, "capture-task-binding-missing");
    assert.deepEqual(worker.rejected, []);
    assert.equal(low.state.business.length, 0);
    assert.equal(high.state.business.length, 0);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("a disappeared library on the chosen instance blocks the save instead of falling back to another library or instance", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    await worker.send({ type: "luckyray-popup-select-connection",
      candidate: port.candidates.find(candidate => candidate.port === high.port) });
    high.state.hideLibrary = true;
    const started = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:lib-gone") });
    assert.equal(started.ok, false);
    assert.equal(started.code, "media-library-denied");
    assert.equal(low.state.business.length, 0);
    assert.equal(high.state.business.some(call => call.path === "/api/media/transfers"), false);
    assert.deepEqual(worker.rejected, []);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("one verified instance binds automatically with no chooser and serves the funnel", async () => {
  const solo = await startDesktop({ credential: CREDENTIAL_B, name: "solo" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [solo] });
    workers.push(worker);
    const state = await worker.send({ type: "luckyray-popup-get-port" });
    assert.equal(state.port, solo.port);
    assert.equal(state.candidates, undefined);
    const started = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:solo") });
    assert.equal(started.ok, true);
    await until(() => ["completed", "partial", "uncertain", "paused", "failed"].includes(stores.local.get("luckyrayCaptureTaskV1").stage));
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").stage, "completed");
    assert.deepEqual(worker.rejected, []);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await solo.stop();
  }
});

// ---------------------------------------------------------------- Part 3
// Source-level contract: production dispatch must never regress to a
// numeric port, a null target or an in-place re-discovery.

bindingTest("background.js dispatches only through resolved bindings (no numeric/null leftovers)", async () => {
  const source = await readFile(new URL("../browser-extension-prototype/background.js", import.meta.url), "utf8");
  assert.equal(/lastWorkingPort|scanPorts\s*\(/.test(source), false,
    "numeric-port dispatch state must not return");
  assert.equal(/LuckyRayLocalTransport\.fetch\(\s*null/.test(source), false,
    "null-target dispatch must not return");
  assert.equal(/LuckyRayLocalTransport\.discover\(\s*\)/.test(source), false,
    "background must not run free port discovery on its own");
  // Every remaining transport call site passes a binding object.
  const callSites = source.split("\n").map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(entry => /LuckyRayLocalTransport\.fetch\(/.test(entry.line));
  assert.ok(callSites.length > 0);
  for (const entry of callSites) {
    assert.match(entry.line, /LuckyRayLocalTransport\.fetch\(\s*(resolved\.binding|binding|frozen\.binding|recordingBinding)\b/,
      `background.js:${entry.number} must pass a binding descriptor`);
  }
});

async function runAll() { /* node --test drives the file; nothing to orchestrate */ }
await runAll();

// ---------------------------------------------------------------- Round 2
// Second-review counterexamples (R6-R10): frozen submission contexts,
// recorded direct-transfer bindings, confirm ordering, full-descriptor
// selection with the instance nonce, and dispose quiescence.

bindingTest("R6: an in-flight library response cannot retarget a submission after an explicit re-selection", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    const lowDescriptor = port.candidates.find(candidate => candidate.port === low.port);
    const highDescriptor = port.candidates.find(candidate => candidate.port === high.port);
    await worker.send({ type: "luckyray-popup-select-connection", candidate: lowDescriptor });

    // Hold A's library validation in flight while the user re-selects B.
    let releaseLibraries = () => {};
    low.state.holdLibraryOnce = new Promise(resolve => { releaseLibraries = resolve; });
    const startPromise = worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:r6") });
    await until(() => low.state.business.some(call => call.path === "/api/material-libraries"));

    const reselected = await worker.send({ type: "luckyray-popup-select-connection", candidate: highDescriptor });
    assert.equal(reselected.ok, true);
    assert.equal(storedBindingOf(stores).port, high.port);

    releaseLibraries();
    const started = await startPromise;
    assert.equal(started.ok, true);
    const task = stores.local.get("luckyrayCaptureTaskV1");
    // The submission stays on the connection it was FROZEN under.
    assert.equal(task.connection.port, low.port);
    await until(() => ["completed", "partial", "uncertain", "paused", "failed"].includes(stores.local.get("luckyrayCaptureTaskV1").stage));
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").stage, "completed");
    assert.ok(low.state.business.some(call => call.path === "/api/media/transfers" && call.body.requestId === "popup:bind:r6"));
    // The newly selected instance received nothing from the old submission.
    assert.equal(high.state.business.length, 0);
    assert.deepEqual(worker.rejected, []);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("R7: direct transfers keep their recorded binding; old records without one fail closed", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  const seedTransfer = { transferId: "media-ff-0000000000000001", libraryId: LIBRARY_ID,
    requestId: "video:seed", fileName: "seed.mp4", mimeType: "video/mp4", kind: "video", state: "running" };
  low.state.transfers.set(seedTransfer.transferId, seedTransfer);
  low.state.receipts.set(`${LIBRARY_ID}:video:seed`, seedTransfer);
  // Seed the session-persisted transfer records BEFORE the worker loads:
  // the background hydrates them at service-worker start, exactly like a
  // worker restart finding an existing record.
  stores.session.set("luckyrayMediaTransferBindingsV1", [
    { sessionId: "sess-old", candidateId: "cand-old", transferId: seedTransfer.transferId,
      tabId: 7, frameId: 0, documentId: null, state: "running", updatedAt: Date.now() }]);
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    const lowDescriptor = port.candidates.find(candidate => candidate.port === low.port);
    const highDescriptor = port.candidates.find(candidate => candidate.port === high.port);
    await worker.send({ type: "luckyray-popup-select-connection", candidate: lowDescriptor });
    const oldStatus = await worker.sendFromContentScript({ type: "luckyray-video-overlay-action",
      action: "media-transfer-status", sessionId: "sess-old", candidateId: "cand-old" });
    assert.equal(oldStatus.ok, false);
    assert.equal(oldStatus.code, "media-transfer-binding-missing");
    assert.equal(low.state.business.length, 0);
    assert.equal(high.state.business.length, 0);

    // (b) a recorded transfer keeps ITS binding even after re-selection:
    // swap the hydrated store to the binding-bearing record via a worker
    // restart (the sanctioned path for session-persisted records).
    workers.length = 0;
    const firstLeftover = await worker.dispose();
    assert.deepEqual(firstLeftover.rejected, []);
    stores.session.set("luckyrayMediaTransferBindingsV1", [
      { sessionId: "sess-new", candidateId: "cand-new", transferId: seedTransfer.transferId,
        tabId: 7, frameId: 0, documentId: null, state: "running", updatedAt: Date.now(),
        connection: { version: 1, port: low.port, origin: ORIGIN,
          fingerprint: await sha256Hex(CREDENTIAL_A), serverNonce: low.state.nonce } }]);
    const worker2 = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker2);
    const port2 = await worker2.send({ type: "luckyray-popup-get-port" });
    assert.equal(port2.port, low.port);
    // high has not restarted, so its descriptor from the first enumeration
    // (port/origin/fingerprint/serverNonce) is still the live identity.
    await worker2.send({ type: "luckyray-popup-select-connection", candidate: highDescriptor });
    const status = await worker2.sendFromContentScript({ type: "luckyray-video-overlay-action",
      action: "media-transfer-status", sessionId: "sess-new", candidateId: "cand-new" });
    assert.equal(status.ok, true);
    assert.ok(low.state.business.some(call => call.path.endsWith(`/api/media/transfers/${seedTransfer.transferId}`)));
    assert.equal(high.state.business.length, 0);
    assert.deepEqual(worker.rejected, []);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("R8: wrong-transferId receipts never unlock; a restart between receipt and confirmation re-reconciles", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    await worker.send({ type: "luckyray-popup-select-connection",
      candidate: port.candidates.find(candidate => candidate.port === high.port) });
    high.state.holdRunning = true;
    const started = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:r8") });
    assert.equal(started.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "transferring");
    const nonceAtCreation = stores.local.get("luckyrayCaptureTaskV1").connection.serverNonce;
    high.restart();
    await until(() => ["uncertain", "paused"].includes(stores.local.get("luckyrayCaptureTaskV1").stage));

    // (a) pending answer carrying a WRONG transferId: identity is parsed
    // before any confirmation, so the recorded nonce never moves.
    high.state.pendingTransferIdOverride = "media-ee-" + "2".repeat(16);
    let resumed = await worker.send({ type: "luckyray-capture-task", action: "resume", id: "popup:bind:r8" });
    assert.equal(resumed.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "uncertain");
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").errorCode, "media-transfer-identity");
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").connection.serverNonce, nonceAtCreation);

    // (b) a valid receipt observed under N2, then the service restarts to
    // N3 before confirmation: the confirmation is refused — the latest
    // nonce is never accepted as a substitute.
    high.state.pendingTransferIdOverride = null;
    high.state.restartAfterMediaReceipt = true;
    resumed = await worker.send({ type: "luckyray-capture-task", action: "resume", id: "popup:bind:r8" });
    assert.equal(resumed.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "uncertain");
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").errorCode, "binding-restart-mismatch");
    assert.equal(stores.local.get("luckyrayCaptureTaskV1").connection.serverNonce, nonceAtCreation);
    assert.equal(low.state.business.length, 0);

    // (c) the next resume re-reconciles against the new instance: the
    // receipt is re-observed under N3, only then confirmation succeeds.
    high.state.holdRunning = false;
    resumed = await worker.send({ type: "luckyray-capture-task", action: "resume", id: "popup:bind:r8" });
    assert.equal(resumed.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "completed");
    const finished = stores.local.get("luckyrayCaptureTaskV1");
    assert.equal(finished.asset.id, "fixture-asset");
    assert.equal(finished.connection.serverNonce, high.state.nonce);
    assert.notEqual(finished.connection.serverNonce, nonceAtCreation);
    assert.deepEqual(worker.rejected, []);
  } finally {
    high.state.holdRunning = false;
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

bindingTest("R9a: a same-credential restart invalidates a displayed descriptor via its nonce", async () => {
  const low = await startDesktop({ credential: CREDENTIAL_A, name: "low" });
  const high = await startDesktop({ credential: CREDENTIAL_B, name: "high" });
  const stores = { local: new Map(), session: new Map() };
  const workers = [];
  try {
    const worker = await loadBackgroundWorker({ stores, desktops: [low, high] });
    workers.push(worker);
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    const seenHigh = port.candidates.find(candidate => candidate.port === high.port);
    // Same credential (same fingerprint), NEW instance nonce. Let any probe
    // connections from the enumeration settle first.
    high.restart();
    for (let i = 0; i < 4; i++) await tick();
    const stalePick = await worker.send({ type: "luckyray-popup-select-connection", candidate: seenHigh });
    assert.equal(stalePick.ok, false);
    assert.equal(stalePick.code, "connection-select-stale");
    assert.equal(storedBindingOf(stores), null);
    // The refreshed descriptor (new nonce) selects fine.
    const again = await worker.send({ type: "luckyray-popup-get-port" });
    const freshHigh = again.candidates.find(candidate => candidate.port === high.port);
    assert.notEqual(freshHigh.serverNonce, seenHigh.serverNonce);
    const ok = await worker.send({ type: "luckyray-popup-select-connection", candidate: freshHigh });
    assert.equal(ok.ok, true);
    assert.deepEqual(worker.rejected, []);
  } finally {
    for (const w of workers) {
      const leftover = await w.dispose();
      assert.deepEqual(leftover.rejected, [], "late requests after dispose");
      assert.deepEqual(leftover.storage, [], "storage writes after dispose");
    }
    await low.stop(); await high.stop();
  }
});

async function popupChoiceHarness() {
  const nodes = new Map();
  const classes = () => { const set = new Set();
    return { toggle(name, on) { if (on) set.add(name); else set.delete(name); },
      add(name) { set.add(name); }, remove(name) { set.delete(name); },
      contains(name) { return set.has(name); } }; };
  const element = () => { const list = { children: [] };
    return { style: {}, textContent: "", value: "", disabled: false, hidden: false, type: "", className: "",
      title: "", options: [], selectedOptions: [], classList: classes(),
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
      append(child) { list.children.push(child); },
      replaceChildren() { list.children.length = 0; },
      addEventListener(kind, handler) { this._handler = handler; },
      get childElementCount() { return list.children.length; },
      get firstChild() { return list.children[0] || null; } };
  };
  const documentStub = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement() { return element(); },
    addEventListener() {}, documentElement: element(),
  };
  const sent = [];
  const sandbox = {
    LuckyRayLocalTransport: Object.freeze({ runtimeOrigin: () => ORIGIN,
      // Minimal data-plane stub so the re-selected popup can finish its
      // post-selection refresh without a real endpoint.
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { folders: [], notes: [] } }) }) }),
    document: documentStub, location: { search: "" }, URLSearchParams,
    setTimeout: () => 0, clearTimeout() {},
    chrome: { runtime: { lastError: null,
      sendMessage(message, callback) {
        sent.push(message);
        callback(message?.type === "luckyray-popup-select-connection"
          ? { ok: true, port: 41000, fingerprint: "a".repeat(64), origin: ORIGIN, serverNonce: "b".repeat(64) }
          : {});
      } },
      tabs: { query: async () => [], sendMessage: async () => ({}) }, storage: { local: { async get() { return {}; }, async set() {} }, session: { async get() { return {}; }, async set() {} } } },
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  const protocolSource = await readFile(new URL("../browser-extension-prototype/extension-protocol.js", import.meta.url), "utf8");
  vm.runInContext(protocolSource, sandbox, { filename: "extension-protocol.js" });
  const popupSource = await readFile(new URL("../browser-extension-prototype/popup.js", import.meta.url), "utf8");
  vm.runInContext(popupSource, sandbox, { filename: "popup.js" });
  return { sandbox, nodes, sent };
}

bindingTest("R9b: the popup offers an explicit re-selection UI even for a single remaining candidate", async () => {
  const ui = await popupChoiceHarness();
  const candidate = { version: 1, port: 41000, origin: ORIGIN, fingerprint: "a".repeat(64), serverNonce: "b".repeat(64) };
  ui.sandbox.testState = { port: null, code: "connection-selection-stale", candidates: [candidate] };
  vm.runInContext("applyConnectionState(testState); renderConnectionChoices();", ui.sandbox);
  const host = ui.nodes.get("lr-connection-choices");
  assert.equal(host.hidden, false);
  assert.equal(host.childElementCount, 1);
  const button = host.firstChild;
  assert.match(button.textContent, /重新选择/);
  assert.match(button.textContent, /41000/);
  await button._handler();
  assert.equal(ui.sent.length, 1);
  assert.equal(ui.sent[0].type, "luckyray-popup-select-connection");
  // The submitted pick carries the FULL descriptor, nonce included.
  assert.equal(ui.sent[0].candidate.version, 1);
  assert.equal(ui.sent[0].candidate.port, candidate.port);
  assert.equal(ui.sent[0].candidate.origin, candidate.origin);
  assert.equal(ui.sent[0].candidate.fingerprint, candidate.fingerprint);
  assert.equal(ui.sent[0].candidate.serverNonce, candidate.serverNonce);
});

bindingTest("R10: a disposed worker refuses network and storage effects", async () => {
  const solo = await startDesktop({ credential: CREDENTIAL_B, name: "solo" });
  const stores = { local: new Map(), session: new Map() };
  const worker = await loadBackgroundWorker({ stores, desktops: [solo] });
  try {
    const port = await worker.send({ type: "luckyray-popup-get-port" });
    assert.equal(port.port, solo.port);
    solo.state.holdRunning = true;
    const started = await worker.send({ type: "luckyray-capture-task", action: "start", input: audioTaskInput("popup:bind:r10") });
    assert.equal(started.ok, true);
    await until(() => stores.local.get("luckyrayCaptureTaskV1").stage === "transferring");
    // Settle the production polling operation before disposal. Disposing
    // while it is sleeping can cancel its timer with `running` still held;
    // a status-only wake-up then correctly does nothing, making this harness
    // assertion depend on when a fixed tick loop happened to observe it.
    solo.state.unreachable = true;
    await until(() => ["paused", "uncertain"].includes(stores.local.get("luckyrayCaptureTaskV1").stage));
    const leftover = await worker.dispose();
    assert.deepEqual(leftover.rejected, []);
    // Snapshot AFTER dispose settled its in-flight requests.
    const businessAtDispose = solo.state.business.length;
    // A late message wake-up after dispose: the dispatch must be refused
    // before the network and any storage write must be refused and recorded.
    const status = await worker.send({ type: "luckyray-capture-task", action: "resume", id: started.task.id });
    assert.equal(status.ok, true);
    for (let i = 0; i < 300 && (worker.rejected.length === 0 || worker.storage.length === 0); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(worker.rejected.some(record => record.host === "disposed-worker"), "network refused after dispose");
    assert.ok(worker.storage.some(attempt => attempt.keys.includes("luckyrayCaptureTaskV1")), "storage refused after dispose");
    // No bytes left the machine after dispose.
    assert.equal(solo.state.business.length, businessAtDispose);
  } finally {
    solo.state.holdRunning = false;
    await worker.dispose();
    await solo.stop();
  }
});
