import test from "node:test";
import assert from "node:assert/strict";
import { loadBackgroundSandbox } from "./lib/background-script-sandbox.mjs";

// Synthetic browser bitmap/host scheduling only. The controller, frozen SDK,
// background request adapter and proof/auth/timeout implementation are real.
// No network connection, user profile, real credentials or actual save replay.
async function captureTransportFixture({ responseDelayMs = 0, pngBytes = 4_278_190, responseKind = "receipt", receiptOverrides = {}, failWritePreflight = false, receiptLookup = false, lookupOverrides = {}, failCleanup = false, networkEvent = null } = {}) {
  const fixture = await loadBackgroundSandbox();
  const { sandbox } = fixture;
  const networkListeners = {};
  for (const name of ["onBeforeRequest", "onResponseStarted", "onErrorOccurred"]) {
    sandbox.chrome.webRequest[name] = { addListener(listener, filter, extra) {
      assert.deepEqual(Array.from(filter.urls), ["http://127.0.0.1/api/material-libraries/import-bytes"]);
      assert.equal(extra, undefined, "diagnostics must not request headers or body access");
      networkListeners[name] = listener;
    } };
  }
  sandbox.importScripts("local-transport-auth.js");
  const proofFetch = sandbox.fetch;
  const writes = [];
  const timers = [];
  const commits = [];
  const lookups = [];
  let controlUnavailable = false;
  let writePreflightArmed = false;
  let lookupEnabled = receiptLookup;
  const allLookups = [];
  if (failCleanup) {
    const writeStorage = sandbox.chrome.storage.local.set;
    sandbox.chrome.storage.local.set = async values => {
      if (values["luckyray.pageCapture.pending.v1"]?.length === 0) throw new Error("Synthetic cleanup storage failure");
      return writeStorage(values);
    };
  }
  const metrics = { ok: true, documentToken: "synthetic-doc", url: "https://page.test/capture", x: 0, y: 0,
    width: 3828, height: 1911, dpr: 1, visualScale: 1, pageWidth: 3828, pageHeight: 1911 };
  // Speed up only the business HTTP deadlines; keep real HMAC proof intact.
  // Twenty milliseconds below models a 20-second host result, deterministically
  // beyond the current 5-second default and below the panel's 120-second bound.
  sandbox.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds >= 5000 && milliseconds <= 120000) {
      timers.push(milliseconds);
      return setTimeout(callback, milliseconds / 1000, ...args);
    }
    return setTimeout(callback, milliseconds, ...args);
  };
  sandbox.process = { versions: { node: process.versions.node } };
  sandbox.__LUCKYRAY_TEST_PORTS__ = [37420];
  sandbox.btoa = btoa;
  sandbox.Uint8Array = Uint8Array;
  sandbox.createImageBitmap = async () => ({ width: metrics.width, height: metrics.height, close() {} });
  sandbox.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob() {
      return { size: pngBytes, arrayBuffer: async () => new Uint8Array(pngBytes).buffer };
    }
  };
  const jsonResponse = payload => ({ ok: true, status: 200, clone() { return this; }, json: async () => payload });
  sandbox.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.startsWith("data:image/")) return { blob: async () => ({}) };
    if (controlUnavailable && /\/api\/v1\/(?:proof|health|extension\/bootstrap)$/.test(path)) {
      throw new TypeError("Synthetic control connection unavailable before business dispatch");
    }
    if (path.endsWith("/api/material-libraries")) {
      // Fail the write's proof, not the prerequisite readonly library check.
      // Instance-bound transport now verifies both; blocking the first one
      // would exercise a different (preview-only) refusal than this test names.
      if (writePreflightArmed) controlUnavailable = true;
      return jsonResponse({ consumerVersion: 1, libraries: [
        { libraryId: "synthetic-lib-B", state: "ready", visible: true, capabilities: { read: true, import: true, organize: true } },
      ] });
    }
    if (path.endsWith("/api/material-libraries/capture-receipt")) allLookups.push(JSON.parse(init.body).requestId);
    if (path.endsWith("/api/material-libraries/capture-receipt") && lookupEnabled) {
      const target = JSON.parse(init.body);
      lookups.push(target);
      return jsonResponse({ receiptLookupVersion: 1, libraryId: target.libraryId, requestId: target.requestId,
        state: "completed", receipt: commits.at(-1), ...lookupOverrides });
    }
    if (path.endsWith("/api/material-libraries/import-bytes")) {
      if (networkEvent) {
        const detail = { url: path, method: "POST", requestId: "network-only-id",
          initiator: sandbox.chrome.runtime.getURL("").replace(/\/$/, ""), ...networkEvent };
        networkListeners.onBeforeRequest?.(detail);
        networkListeners.onErrorOccurred?.(detail);
      }
      const body = JSON.parse(init.body);
      writes.push({ requestId: body.requestId, libraryId: body.libraryId, encodedBytes: body.bytesBase64.length });
      const receipt = { consumerVersion: 1, libraryId: body.libraryId, requestId: body.requestId,
        assetId: "synthetic-asset", disposition: "imported", changed: true, ...receiptOverrides };
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException("Synthetic response timeout", "AbortError"));
        init.signal.addEventListener("abort", onAbort, { once: true });
        if (init.signal.aborted) onAbort();
        setTimeout(() => {
          commits.push(receipt);
          init.signal.removeEventListener("abort", onAbort);
          if (responseKind === "disconnected") reject(new TypeError("Synthetic lost connection"));
          else if (responseKind === "malformed") resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("Synthetic malformed receipt"); } });
          else if (responseKind === "partial-error") resolve({ ok: false, status: 503,
            json: async () => ({ code: "consumer-storage-failed", writeOutcome: "unknown" }) });
          else if (responseKind === "preflight-lookalike") resolve({ ok: false, status: 503,
            json: async () => ({ code: "app-unavailable", notDispatched: true }) });
          else resolve(jsonResponse(receipt));
        }, responseDelayMs);
      });
    }
    return proofFetch(url, init);
  };
  sandbox.chrome.tabs.get = async () => ({ id: 11, windowId: 4, active: true, url: metrics.url, title: "Synthetic screenshot" });
  sandbox.chrome.tabs.captureVisibleTab = async () => "data:image/png;base64,SYNTHETIC";
  sandbox.chrome.windows = { update: async () => {} };
  const controller = sandbox.LuckyRayPageCaptureController.create({ chromeApi: sandbox.chrome,
    page: async () => ({ ...metrics }), request: (...args) => sandbox.requestCaptureApi(...args), delay: async () => {} });
  const started = await controller.start({ mode: "visible", tabId: 11, libraryId: "synthetic-lib-B" });
  assert.equal(started.ok, true);
  for (let i = 0; controller.status(started.draft.id).draft.stage === "capturing" && i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const preview = controller.status(started.draft.id).draft;
  assert.equal(preview.stage, "preview");
  assert.equal(preview.width, 3828); assert.equal(preview.height, 1911); assert.equal(preview.sizeBytes, pngBytes);
  writePreflightArmed = failWritePreflight;
  return { controller, id: started.draft.id, writes, timers, commits, lookups, allLookups,
    seedPending: async records => sandbox.chrome.storage.local.set({ "luckyray.pageCapture.pending.v1": records }),
    restoreControl: () => { controlUnavailable = false; writePreflightArmed = false; },
    enableReceiptLookup: () => { lookupEnabled = true; },
    restartController: () => sandbox.LuckyRayPageCaptureController.create({ chromeApi: sandbox.chrome,
      page: async () => ({ ...metrics }), request: (...args) => sandbox.requestCaptureApi(...args), delay: async () => {} }),
    request: (...args) => sandbox.requestCaptureApi(...args) };
}

test("proof/bootstrap failure before the PNG request is dispatched is a retryable zero-write failure, not pending", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64, failWritePreflight: true });
  const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
  assert.equal(fixture.writes.length, 0, "auth control failure did not dispatch the business POST");
  assert.equal(fixture.commits.length, 0);
  assert.equal(result.draft.stage, "failed", `zero dispatch became ${result.draft.stage}/${result.code}`);
  assert.equal(result.draft.notCommitted, true);
  assert.equal((await fixture.controller.pendingStatus()).pending.length, 0);
  fixture.restoreControl();
  const next = await fixture.controller.start({ mode: "visible", tabId: 11, libraryId: "synthetic-lib-B" });
  assert.equal(next.ok, true, "a definite zero-write failure must not require manual acknowledgement");
});

test("save diagnostic preserves only correlated browser network error, without replay or sensitive fields", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64, responseKind: "disconnected",
    networkEvent: { error: "net::ERR_CONNECTION_RESET", requestBody: { secret: "PRIVATE_BYTES" },
      responseHeaders: [{ name: "Authorization", value: "PRIVATE_TOKEN" }] } });
  const result = await fixture.controller.save(fixture.id, { title: "Private title" });
  assert.equal(result.draft.stage, "uncertain");
  const pending = (await fixture.restartController().pendingStatus()).pending[0];
  assert.equal(pending.diagnostic.network?.error, "net::ERR_CONNECTION_RESET");
  assert.equal(pending.diagnostic.network?.event, "error");
  assert.equal(pending.diagnostic.network?.port, 37420);
  assert.doesNotMatch(JSON.stringify(pending), /PRIVATE|Private title|network-only-id|http:/);
  assert.equal(fixture.writes.length, 1);
});

test("network evidence from a different initiator or endpoint cannot be attributed to this save", async () => {
  for (const changed of [{ initiator: "https://other.test" }, { url: "http://127.0.0.1:37420/api/notes/capture" },
    { method: "OPTIONS" }, { url: "http://127.0.0.1:37421/api/material-libraries/import-bytes" }]) {
    const fixture = await captureTransportFixture({ pngBytes: 64, responseKind: "disconnected",
      networkEvent: { error: "net::ERR_CONNECTION_RESET", ...changed } });
    await fixture.controller.save(fixture.id, { title: "Synthetic" });
    const pending = (await fixture.controller.pendingStatus()).pending[0];
    assert.equal(pending.diagnostic.network?.event, "unobserved");
    assert.equal(pending.diagnostic.network?.error, null);
  }
});

test("a committed PNG with a lost response is automatically confirmed by its existing receipt, without another save", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64, responseKind: "disconnected", receiptLookup: true });
  const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
  assert.equal(result.draft.stage, "saved");
  assert.equal(result.ok, true);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.lookups.length, 1);
  assert.deepEqual(Object.keys(fixture.lookups[0]).sort(), ["libraryId", "requestId"]);
  assert.equal((await fixture.controller.pendingStatus()).pending.length, 0);
});

test("receipt readback cannot confirm a different library, operation, contract, or incomplete receipt", async () => {
  for (const lookupOverrides of [{ libraryId: "other-library" }, { requestId: "popup:other" },
    { receiptLookupVersion: 2 }, { receipt: { assetId: "without-identities", disposition: "imported" } }]) {
    const fixture = await captureTransportFixture({ pngBytes: 64, responseKind: "disconnected", receiptLookup: true, lookupOverrides });
    const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
    assert.equal(result.draft.stage, "uncertain");
    assert.equal((await fixture.controller.pendingStatus()).pending.length, 1);
    assert.equal(fixture.writes.length, 1);
  }
});

test("worker restart automatically reads a completed PNG receipt using journal identities only", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64, responseKind: "disconnected" });
  assert.equal((await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" })).draft.stage, "uncertain");
  fixture.enableReceiptLookup();
  const restarted = fixture.restartController();
  const status = await restarted.pendingStatus();
  assert.equal(status.pending.length, 0);
  assert.equal(status.recovered[0].requestId, fixture.id);
  assert.equal(status.recovered[0].receipt.assetId, "synthetic-asset");
  assert.equal(fixture.writes.length, 1);
});

test("an old unknown PNG does not lock a new capture, including after worker restart; original save cannot replay", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64, responseKind: "disconnected" });
  assert.equal((await fixture.controller.save(fixture.id, { title: "First" })).draft.stage, "uncertain");
  for (const controller of [fixture.controller, fixture.restartController()]) {
    const started = await controller.start({ mode: "visible", tabId: 11, libraryId: "synthetic-lib-B" });
    assert.equal(started.ok, true, "historic unknown must not lock a different explicit capture");
    for (let i = 0; controller.status(started.draft.id).draft.stage === "capturing" && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal((await controller.save(started.draft.id, { title: "New explicit capture" })).draft.stage, "uncertain");
    assert.equal((await controller.pendingStatus()).pending.some(record => record.requestId === fixture.id), true);
  }
  assert.equal(fixture.writes.length, 3);
  await fixture.controller.save(fixture.id, { title: "Do not resend first" });
  assert.equal(fixture.writes.length, 3);
});

test("receipt queries rotate across old unknowns and preserve the bounded journal on restart", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64 });
  const records = Array.from({ length: 32 }, (_, i) => ({ requestId: `popup:old-${i}`, libraryId: "synthetic-lib-B", mode: "visible" }));
  await fixture.seedPending(records);
  const restarted = fixture.restartController();
  for (let i = 0; i < 3; i++) await restarted.pendingStatus();
  assert.deepEqual(fixture.allLookups, records.slice(0, 3).map(record => record.requestId));
  const result = await restarted.start({ mode: "visible", tabId: 11, libraryId: "synthetic-lib-B" });
  assert.equal(result.code, "capture-journal-full");
  assert.equal((await restarted.pendingStatus()).pending.length, 32);
  assert.equal(fixture.writes.length, 0);
});

test("unknown results retain safe first-failure stage and HTTP status separately from receipt lookup", async () => {
  for (const [responseKind, phase, status, errorKind] of [["partial-error", "http-response", 503, null],
    ["malformed", "response-json", 200, "invalid-json"], ["disconnected", "transport", null, "TypeError"]]) {
    const fixture = await captureTransportFixture({ pngBytes: 64, responseKind });
    const result = await fixture.controller.save(fixture.id, { title: "Private title is not diagnostic" });
    assert.equal(result.draft.stage, "uncertain");
    const pending = (await fixture.restartController().pendingStatus()).pending[0];
    assert.equal(pending.diagnostic.phase, phase);
    assert.equal(pending.diagnostic.status, status);
    assert.equal(pending.diagnostic.errorKind, errorKind);
    assert(pending.lookupDiagnostic);
    assert.doesNotMatch(JSON.stringify(pending), /Private title|bytesBase64|Bearer|https:|Synthetic lost/);
  }
});

test("a confirmed receipt remains saved if journal cleanup fails, and still blocks another write", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64, responseKind: "disconnected", receiptLookup: true, failCleanup: true });
  const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
  assert.equal(result.draft.stage, "saved");
  assert.equal(result.draft.journalCleanupPending, true);
  assert.equal((await fixture.controller.pendingStatus()).pending.length, 1);
  await fixture.controller.save(fixture.id, { title: "Do not replay" });
  assert.equal(fixture.writes.length, 1);
});

test("a server error cannot impersonate the local zero-dispatch flag after a business POST", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64, responseKind: "preflight-lookalike" });
  const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
  assert.equal(result.draft.stage, "uncertain");
  assert.notEqual(result.draft.notCommitted, true);
  assert.equal((await fixture.controller.pendingStatus()).pending.length, 1);
  assert.equal(fixture.writes.length, 1);
});

test("real capture transport receives an immediate matching PNG receipt without pending", async () => {
  const fixture = await captureTransportFixture();
  const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
  assert.equal(result.ok, true);
  assert.equal(result.draft.stage, "saved");
  assert.equal(fixture.writes.length, 1);
  assert.equal((await fixture.controller.pendingStatus()).pending.length, 0);
});

test("real capture transport must accept a valid PNG commit receipt later than the generic request deadline", async () => {
  const fixture = await captureTransportFixture({ responseDelayMs: 20 });
  const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fixture.commits.length, 1, "synthetic host completed exactly one accepted write");
  assert.equal(fixture.writes.length, 1, "no write replay during timeout");
  assert.equal(result.draft.stage, "saved", `late receipt became ${result.draft.stage}/${result.code}; pending retained:${(await fixture.controller.pendingStatus()).pending.length}`);
  assert(fixture.timers.at(-1) > 5000 && fixture.timers.at(-1) < 120000, "save uses its own bound below the panel deadline");
  assert.equal(result.ok, true);
  assert.equal((await fixture.controller.pendingStatus()).pending.length, 0);
});

test("longer PNG save budget does not confirm mismatched library, request, or contract receipts", async () => {
  for (const receiptOverrides of [{ libraryId: "synthetic-other-lib" }, { requestId: "popup:other-operation" }, { consumerVersion: 2 }]) {
    const fixture = await captureTransportFixture({ pngBytes: 64, receiptOverrides });
    const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
    assert.equal(result.ok, false);
    assert.equal(result.draft.stage, "uncertain");
    assert.equal((await fixture.controller.pendingStatus()).pending.length, 1);
    await fixture.controller.save(fixture.id, { title: "Do not replay" });
    assert.equal(fixture.writes.length, 1);
  }
});

test("lost, malformed, and partial-error PNG results still retain pending and never replay", async () => {
  for (const responseKind of ["disconnected", "malformed", "partial-error"]) {
    const fixture = await captureTransportFixture({ pngBytes: 64, responseKind });
    const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
    assert.equal(result.ok, false);
    assert.equal(result.draft.stage, "uncertain");
    assert.notEqual(result.draft.notCommitted, true);
    assert.equal((await fixture.controller.pendingStatus()).pending.length, 1);
    await fixture.controller.save(fixture.id, { title: "Do not replay" });
    assert.equal(fixture.writes.length, 1);
  }
});

test("a PNG result beyond its bounded save deadline remains uncertain, even if the host later commits", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64, responseDelayMs: 110 });
  const result = await fixture.controller.save(fixture.id, { title: "Synthetic screenshot" });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(result.draft.stage, "uncertain");
  assert.equal(fixture.commits.length, 1);
  assert.equal((await fixture.controller.pendingStatus()).pending.length, 1);
  await fixture.controller.save(fixture.id, { title: "Do not replay" });
  assert.equal(fixture.writes.length, 1);
});

test("the PNG save budget does not lengthen discovery, library reads, or unrelated writes", async () => {
  const fixture = await captureTransportFixture({ pngBytes: 64 });
  for (const [method, path, body] of [["GET", "/api/material-libraries"],
    ["POST", "/api/material-libraries/taxonomy", { requestId: "popup:read", libraryId: "synthetic-lib-B" }],
    ["POST", "/api/notes/capture", { requestId: "popup:unrelated", title: "Synthetic" }]]) {
    await fixture.request(method, path, body);
    assert.equal(fixture.timers.at(-1), 5000);
  }
});
