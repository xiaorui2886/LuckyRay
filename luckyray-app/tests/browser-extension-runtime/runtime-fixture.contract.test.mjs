// [BROWSER-EXT][S1] Isolated Chromium Runtime Fixture — Issue #13.
//
// Runs the REAL LuckyRay browser-extension prototype in a REAL Edge/Chrome
// binary under a fresh temporary profile, then verifies the boundary
// contract:
//
//   A. one-shot browser environment (temp user-data-dir, unpacked extension,
//      cleanup, refusal of real profile paths)
//   B. fake LocalTransport on loopback: health/bootstrap/proof + protected
//      GET/POST routes; wrong/incompatible candidates never see
//      Authorization or protected payloads
//   C. MV3 service-worker install -> first protected request -> forced
//      termination -> restart -> fresh in-memory session; credentials never
//      persisted in chrome.storage
//   D. MAIN-world spoof of `__luckyray_page_media_probe_v1__` and untrusted
//      synthetic contextmenu/mousemove must not reach the desktop as a
//      material/note write without a real user action
//   E. permission / origin baseline snapshot, asserted against the on-disk
//      manifest and config/release-extension-origins.json
//
// Scope guards (Issue #13 §3/§4): read-only over production extension JS/Rust;
// no AI Assistant Personal/Agent Browser; no real user profile; no real
// LuckyRay service; no Provider/API; credentials never logged.
//
// The RED -> GREEN evidence is in the git history: the parent commit proves
// the suite failed because no such fixture existed.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CdpConnection, attachSession, evaluate, getTargets } from "./lib/cdp-client.mjs";
import {
  assertNotRealProfileDir,
  discoverBrowser,
  launchChromium,
  stopChromium,
} from "./lib/browser-launcher.mjs";
import {
  DISCOVERY_FIRST_PORT,
  DISCOVERY_LAST_PORT,
  WRITE_ROUTES,
  findFreePortsInRange,
  protectedCallsOn,
  redactedCallSequence,
  scanRangeForLuckyRayService,
  startDecoy,
  startFakeTransport,
  writeCallsOn,
} from "./lib/fake-local-transport.mjs";
import { startFixturePageServer } from "./lib/fixture-page.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION_DIR = path.join(APP_ROOT, "browser-extension-prototype");
const MANIFEST_PATH = path.join(EXTENSION_DIR, "manifest.json");
const RELEASE_ORIGINS_PATH = path.join(APP_ROOT, "config", "release-extension-origins.json");
const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "permission-baseline.json",
);

const PROBE_WORLD_MARKER = "__LUCKYRAY_PAGE_MEDIA_PROBE_V1__";

// The only MV3 extension loaded is the fixture's (everything else is disabled
// via --disable-extensions-except), so the service worker is identified by its
// script URL rather than by a hard-coded id. Chromium products can differ in
// id derivation for unpacked builds (Edge honors the manifest key; some
// Chrome builds derive from the path), and the actual runtime id is asserted
// separately against the key derivation below.
const SW_URL_PATTERN = /^chrome-extension:\/\/[a-z]{32}\/background\.js$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 250, label = "condition" }) {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
    }
    await sleep(intervalMs);
  }
}

// Deterministic extension id from the manifest's public key (Chrome derives
// it the same way: SHA-256 of the DER SPKI, first 16 bytes, base32 a-p).
export function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (let index = 0; index < 16; index += 1) {
    id += alphabet[digest[index] >> 4] + alphabet[digest[index] & 0xf];
  }
  return id;
}

async function findServiceWorker(connection, timeoutMs = 20_000) {
  try {
    return await waitFor(async () => {
      const targets = await getTargets(connection);
      return targets.find((target) => (
        target.type === "service_worker" && SW_URL_PATTERN.test(String(target.url))
      )) || null;
    }, { timeoutMs, label: "extension service worker" });
  } catch (_) {
    return null;
  }
}

// Edge/Chrome can transiently stall a CDP command under load (observed on
// this host with Edge 151 headless). One retry recovers the evaluation while
// a genuinely dead browser still fails loudly after both attempts.
async function evaluateWithRetry(connection, sessionId, expression) {
  try {
    return await evaluate(connection, sessionId, expression);
  } catch (error) {
    if (!/timed out|unresponsive/i.test(String(error?.message || ""))) throw error;
    await sleep(500);
    return await evaluate(connection, sessionId, expression);
  }
}

// Isolation guard shared by the mandatory contract test and the negative test
// ([BROWSER-EXT-REVIEW][BLOCK] P1-1/P1-2). Detection is passive only —
// unauthenticated GET /api/v1/health. ANY non-fixture-owned LuckyRay
// LocalTransport in the discovery range is a HARD FAIL; the fixture never
// bootstraps/proofs against an external service, never reads a credential
// from it, and never skips the mandatory runtime contract.
async function assertDiscoveryRangeIsolated() {
  const external = await scanRangeForLuckyRayService();
  if (external.length > 0) {
    throw new Error(
      `Isolation guard failed: non-fixture-owned LuckyRay LocalTransport detected on port(s) `
      + `${external.join(", ")}. The S1 fixture requires a fully owned discovery range `
      + `(${DISCOVERY_FIRST_PORT}..${DISCOVERY_LAST_PORT}). Close/quit the real LuckyRay `
      + "desktop app (or isolate the external service) and re-run. Preflight performs passive, "
      + "unauthenticated health checks only; no bootstrap/proof/Authorization/protected payload "
      + "is ever sent to external services.",
    );
  }
}

// Assert a manifest object (runtime chrome.runtime.getManifest() or the
// on-disk manifest.json) against the fixed S1 permission baseline (P2-1).
function assertManifestMatchesBaseline(actual, baseline, label) {
  assert.deepEqual(
    (actual.permissions || []).slice().sort(),
    baseline.permissions.slice().sort(),
    `${label}: required permissions must equal the S1 baseline`,
  );
  assert.deepEqual(
    (actual.host_permissions || []).slice().sort(),
    baseline.host_permissions.slice().sort(),
    `${label}: host permissions must equal the S1 baseline`,
  );
  assert.deepEqual(
    (actual.optional_permissions || []).slice().sort(),
    (baseline.optional_permissions || []).slice().sort(),
    `${label}: optional permissions must equal the S1 baseline`,
  );
  assert.deepEqual(
    (actual.optional_host_permissions || []).slice().sort(),
    (baseline.optional_host_permissions || []).slice().sort(),
    `${label}: optional host permissions must equal the S1 baseline`,
  );
  assert.equal(
    (actual.content_scripts || []).length,
    baseline.content_scripts.length,
    `${label}: content script count must equal the S1 baseline`,
  );
  for (let index = 0; index < baseline.content_scripts.length; index += 1) {
    const expected = baseline.content_scripts[index];
    const entry = (actual.content_scripts || [])[index];
    assert.deepEqual(entry.matches, expected.matches, `${label}: content_scripts[${index}].matches`);
    assert.equal(entry.all_frames, expected.all_frames, `${label}: content_scripts[${index}].all_frames`);
    assert.equal(entry.match_about_blank, expected.match_about_blank, `${label}: content_scripts[${index}].match_about_blank`);
    assert.equal(entry.run_at, expected.run_at, `${label}: content_scripts[${index}].run_at`);
    assert.equal(entry.world, expected.world, `${label}: content_scripts[${index}].world`);
    assert.deepEqual(entry.js, expected.js, `${label}: content_scripts[${index}].js`);
  }
}

// Negative case (FIX-1 verification item 2): an external/non-owned service
// that answers ONLY compatible-looking health (never bootstrap) occupies a
// candidate port. The passive scan must detect it, the fixture preflight must
// hard-fail, and the external service must observe only unauthenticated
// health probes — never bootstrap/proof/Authorization/protected payload.
test("external LuckyRay transport must hard-fail the fixture preflight (negative)", async () => {
  const [port] = await findFreePortsInRange(1);
  const external = await startDecoy({ port, mode: "health-only" });
  try {
    const found = await scanRangeForLuckyRayService();
    assert.ok(
      found.includes(port),
      `external decoy on port ${port} must be detected by the passive health scan (found: ${found.join(", ") || "none"})`,
    );
    await assert.rejects(
      () => assertDiscoveryRangeIsolated(),
      /non-fixture-owned LuckyRay LocalTransport detected/,
      "fixture preflight must hard-fail (throw) when any external LuckyRay transport occupies the discovery range",
    );
    assert.ok(external.calls.length > 0, "the passive scan must have reached the external service");
    assert.ok(
      external.calls.every((call) => (
        call.method === "GET" && call.path === "/api/v1/health" && !call.hasAuthorization
      )),
      `external service must observe only unauthenticated health probes; saw `
      + JSON.stringify(redactedCallSequence(external.calls)),
    );
  } finally {
    await external.close();
  }
});

test("S1 isolated Chromium runtime fixture (Issue #13)", async () => {
  const report = {
    phases: [],
    browser: null,
    browserMode: null,
    extensionId: null,
    profile: { enabled: false, cleaned: false, dir: null },
    workerLifecycle: { install: null, firstBootstrap: null, restart: null },
    spoofNegative: null,
    snapshot: null,
    notes: [],
    transport: { calls: [], writeRouteCalls: [] },
  };
  const phase = (name) => report.phases.push({ name, at: Date.now() });

  let connection = null;
  let launched = null;
  let pageSession = null;
  let pageTargetId = null;
  let fake = null;
  let badProofDecoy = null;
  let incompatibleDecoy = null;
  let pageServer = null;
  let swSessionCache = new Map();
  const explicitProtectedRequests = [];

  const evalSw = async (expression) => {
    const targets = await getTargets(connection);
    const target = targets.find((item) => item.type === "service_worker"
      && SW_URL_PATTERN.test(String(item.url)));
    if (!target) throw new Error("service worker target not found");
    let sessionId = swSessionCache.get(target.targetId);
    if (!sessionId) {
      sessionId = await attachSession(connection, target.targetId);
      swSessionCache.set(target.targetId, sessionId);
    }
    return evaluateWithRetry(connection, sessionId, expression);
  };

  const evalPage = (expression) => {
    if (!pageSession) throw new Error("fixture page session is not ready");
    return evaluateWithRetry(connection, pageSession, expression);
  };

  try {
    // ---------------------------------------------------------------- preflight
    phase("preflight");
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const keyDerivedId = extensionIdFromKey(manifest.key);
    report.extensionId = keyDerivedId;
    const releaseOrigins = JSON.parse(fs.readFileSync(RELEASE_ORIGINS_PATH, "utf8")).origins;
    assert.ok(
      releaseOrigins.includes(`chrome-extension://${keyDerivedId}`),
      `release-extension-origins.json must include chrome-extension://${keyDerivedId}`,
    );

    const browser = discoverBrowser();
    report.browser = { product: browser.product, executable: browser.executable };

    // Isolation guard (P1-1/P1-2): passive health scan only. ANY external
    // LuckyRay LocalTransport in the discovery range is a HARD FAIL — the
    // fixture never bootstraps against it, never reads a credential from it,
    // and mandatory runtime/security assertions are never skipped.
    await assertDiscoveryRangeIsolated();

    // Ports: bad-proof decoy is the LOWEST candidate so the extension walks
    // through it first (proving the proof gate), then the real fake transport.
    const [badProofPort, fakePort, incompatiblePort] = await findFreePortsInRange(3);
    badProofDecoy = await startDecoy({ port: badProofPort, mode: "bad-proof" });
    fake = await startFakeTransport({ port: fakePort });
    incompatibleDecoy = await startDecoy({ port: incompatiblePort, mode: "incompatible" });
    pageServer = await startFixturePageServer();
    report.transport.servers = {
      badProofPort,
      fakePort,
      incompatiblePort,
      fixturePagePort: pageServer.port,
    };
    assert.notEqual(
      pageServer.port,
      fakePort,
      "fixture page port must never collide with the fake desktop port",
    );

    // ------------------------------------------------------------ launch browser
    phase("browser-launch");
    const modeAttempts = ["headless", "headed"];
    for (const mode of modeAttempts) {
      launched = await launchChromium({
        browser,
        extensionPath: EXTENSION_DIR,
        headless: mode === "headless",
      });
      report.browserMode = mode;
      report.profile.enabled = true;
      report.profile.dir = launched.profileDir;
      assertNotRealProfileDir(launched.profileDir);
      connection = await CdpConnection.connect(launched.wsUrl);
      const version = await connection.send("Browser.getVersion");
      report.browser.version = version.product;
      const sw = await findServiceWorker(connection, mode === "headless" ? 25_000 : 35_000);
      if (sw) {
        const runtimeId = String(sw.url).match(/^chrome-extension:\/\/([a-z]{32})\/background\.js$/)?.[1];
        if (runtimeId) {
          report.extensionId = runtimeId;
          report.keyDerivedId = keyDerivedId;
        }
        break;
      }
      report.notes.push(`${mode} mode: extension service worker did not appear — trying next mode`);
      await connection.close();
      connection = null;
      await stopChromium(launched);
      launched = null;
    }
    assert.ok(
      launched && connection,
      "failed to launch Edge/Chrome with the extension service worker. On Windows the fixture "
      + "prefers installed Microsoft Edge (works with --load-extension in this Chromium build); "
      + "if a Chrome fallback refused to load even a minimal unpacked extension, use Edge instead.",
    );
    assert.ok(
      report.profile.enabled && fs.existsSync(report.profile.dir),
      "temp profile must exist while the browser is running",
    );

    // ------------------------------------------------------- A. install + worker
    phase("worker-install");
    report.workerLifecycle.install = "PASS";

    // ----------------------------------------- open the MAIN-world fixture page
    phase("fixture-page");
    const { targetId } = await connection.send("Target.createTarget", { url: pageServer.pageUrl });
    pageTargetId = targetId;
    await waitFor(async () => {
      const targets = await getTargets(connection);
      const page = targets.find((item) => item.targetId === targetId);
      return page && String(page.url).includes("/spoof-page.html");
    }, { timeoutMs: 15_000, label: "fixture page load" });
    pageSession = await attachSession(connection, targetId);
    await waitFor(async () => {
      try {
        return await evalPage("typeof window.__lrSpoof === 'function'");
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "fixture page script" });
    // The MAIN-world probe content script must actually be installed on the
    // page (real manifest, real injection) before the spoof phase can be
    // meaningful.
    await waitFor(async () => {
      try {
        return await evalPage(`Boolean(window.${PROBE_WORLD_MARKER})`);
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "MAIN-world probe marker" });

    // ------------------------------------- B. first protected request + proof
    phase("first-bootstrap");
    const first = await evalSw(`(async () => {
      const port = await LuckyRayLocalTransport.discover();
      const response = await LuckyRayLocalTransport.fetch(port, "/api/notes/current", { method: "GET" });
      const body = await response.json().catch(() => null);
      return { port, status: response.status, ok: response.ok, body };
    })()`);
    assert.equal(first.status, 200, `first protected GET must succeed, got ${first.status}`);
    assert.equal(first.port, fakePort, "extension must pair with the fake transport port");
    explicitProtectedRequests.push("GET /api/notes/current");

    const realCalls = () => fake.calls.filter((call) => call.port === fakePort);
    assert.ok(realCalls().some((call) => call.path === "/api/v1/extension/bootstrap"), "bootstrap observed");
    assert.ok(realCalls().some((call) => call.path === "/api/v1/proof"), "proof observed");
    const notesCurrent = realCalls().find((call) => call.path === "/api/notes/current");
    assert.ok(notesCurrent && notesCurrent.hasAuthorization, "protected GET must carry Authorization");
    report.workerLifecycle.firstBootstrap = "PASS";

    // Wrong/incompatible candidates must never receive Authorization or
    // protected payloads (Issue #13 §5B).
    const badProofProtected = protectedCallsOn(badProofDecoy.calls, badProofPort);
    assert.equal(badProofProtected.length, 0, "bad-proof decoy must never receive protected payloads");
    assert.ok(
      badProofDecoy.calls.every((call) => !call.hasAuthorization),
      "bad-proof decoy must never see an Authorization header",
    );
    assert.ok(
      badProofDecoy.calls.some((call) => call.path === "/api/v1/extension/bootstrap"),
      "bad-proof decoy must be probed and rejected at the proof step",
    );
    assert.ok(
      incompatibleDecoy.calls.every((call) => !call.hasAuthorization && call.path === "/api/v1/health"),
      "incompatible decoy must only ever see an unauthenticated health probe",
    );

    // ----------------------------------------- C. protected POST re-proves
    phase("protected-post");
    const beforePost = realCalls().length;
    const post = await evalSw(`(async () => {
      const port = await LuckyRayLocalTransport.discover();
      const response = await LuckyRayLocalTransport.fetch(port, "/api/assets/import-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: "image", url: "https://example.com/fixture.png", captureSource: "popup" }),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, body };
    })()`);
    assert.equal(post.status, 200, `protected POST must succeed, got ${post.status}`);
    const postCalls = realCalls().slice(beforePost);
    assert.ok(
      postCalls.some((call) => call.path === "/api/v1/proof"),
      "mutating requests must re-prove before sending Authorization",
    );
    const importCall = postCalls.find((call) => call.path === "/api/assets/import-media");
    assert.ok(importCall && importCall.hasAuthorization, "protected POST must carry Authorization");
    explicitProtectedRequests.push("POST /api/assets/import-media");

    // --------------------------------------- D. credential storage hygiene
    phase("storage-hygiene");
    const storage = await evalSw(`(async () => {
      const areas = { local: null, sync: null, session: null };
      for (const area of Object.keys(areas)) {
        areas[area] = await chrome.storage[area].get(null);
      }
      const findings = [];
      for (const [area, values] of Object.entries(areas)) {
        for (const [key, value] of Object.entries(values)) {
          const strings = [];
          const walk = (item) => {
            if (typeof item === "string") strings.push(item);
            else if (item && typeof item === "object") Object.values(item).forEach(walk);
          };
          walk(value);
          const suspiciousKey = /credential|authorization|bearer|secret|token/i.test(key);
          const suspiciousValue = strings.some((item) => (
            /^[a-f0-9]{64}$/i.test(item) || /Bearer\\s+[A-Za-z0-9]{16,}/i.test(item)
          ));
          if (suspiciousKey || suspiciousValue) findings.push({ area, key, suspiciousKey, suspiciousValue });
        }
      }
      return {
        findings,
        keyCounts: {
          local: Object.keys(areas.local).length,
          sync: Object.keys(areas.sync).length,
          session: Object.keys(areas.session).length,
        },
      };
    })()`);
    assert.deepEqual(storage.findings, [], "no credential-like value may be persisted in chrome.storage");
    report.storageKeyCounts = storage.keyCounts;

    // ------------------------------- E. forced worker termination + restart
    phase("worker-restart");
    const swBefore = await findServiceWorker(connection, 5_000);
    assert.ok(swBefore, "service worker target must exist before termination");
    try {
      await connection.send("ServiceWorker.stopAllWorkers");
    } catch (error) {
      report.notes.push(`ServiceWorker.stopAllWorkers unavailable (${error.message}) — using Target.closeTarget`);
      await connection.send("Target.closeTarget", { targetId: swBefore.targetId });
    }
    await sleep(750);
    // Wake the worker through a real page event: the isolated content script
    // publishes a context-kind runtime message, which restarts the MV3 SW.
    await evalPage(`(() => {
      const video = document.getElementById("fixture-video");
      const rect = video.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, clientX: Math.round(rect.left + 1), clientY: Math.round(rect.top + 1),
      }));
      return true;
    })()`);
    swSessionCache = new Map();
    await waitFor(async () => {
      try {
        return await evalSw("typeof LuckyRayLocalTransport === 'object'") === true;
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 25_000, label: "restarted service worker" });

    const beforeRestartCalls = fake.calls.length;
    const restarted = await evalSw(`(async () => {
      const port = await LuckyRayLocalTransport.discover();
      const response = await LuckyRayLocalTransport.fetch(port, "/api/notes/current", { method: "GET" });
      return { port, status: response.status, ok: response.ok };
    })()`);
    assert.equal(restarted.status, 200, `post-restart protected GET must succeed, got ${restarted.status}`);
    const restartCalls = fake.calls.slice(beforeRestartCalls);
    assert.ok(
      restartCalls.some((call) => call.path === "/api/v1/extension/bootstrap"),
      "restarted worker must re-run bootstrap (no stale in-memory session)",
    );
    assert.ok(
      restartCalls.some((call) => call.path === "/api/v1/proof"),
      "restarted worker must re-run proof",
    );
    assert.ok(
      restartCalls.filter((call) => call.port === fakePort).some((call) => (
        call.path === "/api/notes/current" && call.hasAuthorization
      )),
      "restarted worker must send a fresh Authorization to the verified server",
    );
    assert.ok(
      [...badProofDecoy.calls, ...incompatibleDecoy.calls].every((call) => !call.hasAuthorization),
      "after restart no old Authorization may reach unverified candidates",
    );
    explicitProtectedRequests.push("GET /api/notes/current");
    report.workerLifecycle.restart = "PASS";

    // ---------------------------------- F. MAIN-world spoof negative case
    phase("spoof-negative");
    const spoofStart = Date.now();
    await evalPage("window.__lrSpoof()");
    // Give any (buggy) pipeline time to fire requests.
    await sleep(4_000);

    const callsAfterSpoof = fake.calls.filter((call) => call.at >= spoofStart);
    assert.equal(
      callsAfterSpoof.length,
      0,
      `page spoofs must not trigger any desktop transport call; observed: ${JSON.stringify(redactedCallSequence(callsAfterSpoof))}`,
    );
    const decoyCallsAfterSpoof = [...badProofDecoy.calls, ...incompatibleDecoy.calls]
      .filter((call) => call.at >= spoofStart);
    assert.equal(decoyCallsAfterSpoof.length, 0, "page spoofs must not touch decoy candidates either");

    const writeCalls = writeCallsOn(fake.calls, fakePort)
      .map((call) => `${call.method} ${call.path}`)
      .sort();
    assert.deepEqual(
      writeCalls,
      explicitProtectedRequests.slice().sort(),
      `only the explicit test-driven requests may reach desktop write routes; got ${writeCalls.join(", ")}`,
    );
    report.transport.writeRouteCalls = writeCalls;

    // Non-vacuous check: the isolated content receiver DID process the spoofed
    // page events (in-memory candidate state only) — the desktop write gate is
    // what kept them from becoming requests.
    const captureState = await evalSw(`(() => {
      try {
        return {
          tabs: recentCapturesByTab.size,
          kinds: Array.from(recentCapturesByTab.values()).flatMap((entry) => Object.keys(entry)),
        };
      } catch (error) {
        return { error: String(error && error.message || error) };
      }
    })()`);
    assert.ok(
      !captureState.error && captureState.tabs > 0,
      `spoofed page events must be processed as untrusted candidates; state=${JSON.stringify(captureState)}`,
    );
    report.spoofNegative = {
      result: "PASS",
      candidateTabs: captureState.tabs,
      candidateKinds: captureState.kinds,
      transportCallsAfterSpoof: 0,
    };

    // ------------------------------ G. permission / origin baseline snapshot
    phase("permission-snapshot");
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const runtimeManifest = await evalSw("JSON.parse(JSON.stringify(chrome.runtime.getManifest()))");
    const runtimeId = await evalSw("chrome.runtime.id");
    const runtimeOrigin = await evalSw(`chrome.runtime.getURL("").replace(/\\/$/, "")`);
    const snapshot = {
      id: runtimeId,
      origin: runtimeOrigin,
      permissions: runtimeManifest.permissions,
      host_permissions: runtimeManifest.host_permissions,
      optional_permissions: runtimeManifest.optional_permissions,
      optional_host_permissions: runtimeManifest.optional_host_permissions,
      content_scripts: runtimeManifest.content_scripts.map((entry) => ({
        matches: entry.matches,
        all_frames: entry.all_frames,
        match_about_blank: entry.match_about_blank,
        run_at: entry.run_at,
        world: entry.world,
        js: entry.js,
      })),
    };
    report.snapshot = snapshot;

    // Fixed S1 baseline (P2-1): both the runtime manifest and the on-disk
    // manifest.json must equal permission-baseline.json. A future permission
    // change therefore requires an explicit baseline update, visible in the
    // diff and routed through the corresponding permission/architecture
    // review — runtime-vs-disk self-comparison would not gate that.
    assert.equal(
      baseline.extensionId,
      keyDerivedId,
      "baseline extension id must match the manifest key derivation",
    );
    assert.equal(baseline.origin, `chrome-extension://${keyDerivedId}`, "baseline origin must match");
    assert.equal(
      runtimeId,
      baseline.extensionId,
      "runtime extension id must equal the S1 baseline (unpacked build origin)",
    );
    assert.equal(
      runtimeOrigin,
      baseline.origin,
      "runtime extension origin must equal the S1 baseline",
    );
    assertManifestMatchesBaseline(runtimeManifest, baseline, "runtime manifest");
    assertManifestMatchesBaseline(manifest, baseline, "on-disk manifest.json");
    assert.ok(
      releaseOrigins.includes(runtimeOrigin),
      "release-extension-origins.json must contain the runtime extension origin",
    );
    report.phases.push({ name: "all-assertions", at: Date.now(), result: "PASS" });
  } finally {
    // ----------------------------------------------------------------- teardown
    phase("teardown");
    try {
      if (connection) {
        try {
          await connection.send("Browser.close");
        } catch (_) {
          // Browser may already be gone; process kill below is the fallback.
        }
      }
    } catch (_) {
      // Ignore teardown failures and continue cleaning up.
    }
    if (launched) {
      report.profile.cleaned = await stopChromium(launched);
    } else {
      report.profile.cleaned = true;
    }
    await Promise.all([
      fake?.close?.(),
      badProofDecoy?.close?.(),
      incompatibleDecoy?.close?.(),
      pageServer?.close?.(),
    ]);
    await connection?.close?.();

    // ------------------------------------------------------- redacted report
    const callLog = redactedCallSequence([
      ...(badProofDecoy?.calls || []),
      ...(fake?.calls || []),
      ...(incompatibleDecoy?.calls || []),
    ]);
    report.transport.calls = callLog;
    const notes = report.notes.length ? report.notes : ["none"];
    console.log("[browser-extension-runtime] ================= S1 report =================");
    console.log(`[browser-extension-runtime] browser            : ${report.browser?.product} ${report.browser?.version || ""} (${report.browserMode})`);
    console.log(`[browser-extension-runtime] temp profile       : enabled=${report.profile.enabled} cleaned=${report.profile.cleaned} dir=<temp-profile>`);
    console.log(`[browser-extension-runtime] extension id       : ${report.extensionId}${report.keyDerivedId && report.keyDerivedId !== report.extensionId ? ` (manifest-key derivation would be ${report.keyDerivedId})` : ""}`);
    console.log(`[browser-extension-runtime] worker lifecycle   : install=${report.workerLifecycle.install} firstBootstrap=${report.workerLifecycle.firstBootstrap} restart=${report.workerLifecycle.restart}`);
    console.log(`[browser-extension-runtime] transport sequence : ${callLog.map((call) => `${call.port}:${call.method} ${call.path}${call.hasAuthorization ? " [auth]" : ""}`).join(" | ") || "(none)"}`);
    console.log(`[browser-extension-runtime] write route calls  : ${Array.isArray(report.transport.writeRouteCalls) ? (report.transport.writeRouteCalls.join(", ") || "(none)") : String(report.transport.writeRouteCalls)}`);
    console.log(`[browser-extension-runtime] spoof negative     : ${report.spoofNegative?.result} (transportCallsAfterSpoof=${report.spoofNegative?.transportCallsAfterSpoof}, candidateTabs=${report.spoofNegative?.candidateTabs}, kinds=${JSON.stringify(report.spoofNegative?.candidateKinds)})`);
    console.log(`[browser-extension-runtime] permission snapshot: ${JSON.stringify(report.snapshot)}`);
    console.log(`[browser-extension-runtime] storage key counts : ${JSON.stringify(report.storageKeyCounts)}`);
    console.log(`[browser-extension-runtime] notes               : ${notes.join("; ")}`);
    console.log(`[browser-extension-runtime] skipped cases      : none (mandatory contract always executes; environment conflicts hard-fail)`);
    console.log(`[browser-extension-runtime] credential logged  : false (hasAuthorization booleans only)`);
    console.log("[browser-extension-runtime] =============================================");
  }
});

// [BROWSER-EXT][M1-S2] Quick Collect popup QA (Issue #18 §8) — real popup page
// automated on the S1 isolated Chromium base. The popup page is opened as a
// BACKGROUND tab (active tab stays the fixture page) and driven through its
// own DOM, so popup open/init, advanced toggle, type switching and a single
// explicit submit are verified against the fake LocalTransport:
//   - compact default first screen (advanced collapsed, type chip, target
//     summary, primary submit);
//   - popup open/init, toggle and type switches produce 0 desktop writes and
//     0 transport calls;
//   - advanced controls (type switch) still work after progressive disclosure;
//   - one explicit submit produces exactly one import-media write;
//   - no web content / credential persists to chrome.storage.local/sync.
test("M1-S2 popup Quick Collect explicit-commit QA (isolated)", async () => {
  const browser = discoverBrowser();
  await assertDiscoveryRangeIsolated();
  const [fakePort] = await findFreePortsInRange(1);
  const fake = await startFakeTransport({ port: fakePort });
  const pageServer = await startFixturePageServer();
  // Desktop WRITES only: non-GET calls on write-route paths. Popup open/init
  // legitimately performs read calls (GET /api/folders, GET /api/notes/current
  // via the background) that share those path names — reads are not writes.
  const mutatingWrites = () => fake.calls.filter((call) => (
    call.port === fakePort && call.method !== "GET" && WRITE_ROUTES.includes(call.path)
  ));
  let launched = null;
  let connection = null;
  let swSession = null;
  let pageSession = null;
  let popupSession = null;
  try {
    launched = await launchChromium({ browser, extensionPath: EXTENSION_DIR, headless: true });
    connection = await CdpConnection.connect(launched.wsUrl);
    const sw = await findServiceWorker(connection, 30_000);
    assert.ok(sw, "extension service worker must be present for the popup QA");
    const runtimeId = String(sw.url).match(/^chrome-extension:\/\/([a-z]{32})\/background\.js$/)?.[1];
    assert.ok(runtimeId, "runtime extension id must be derivable from the service worker URL");
    swSession = await attachSession(connection, sw.targetId);

    // Fixture page becomes the ACTIVE tab; a hover over its <img> makes the
    // background remember an image capture so the popup auto-resolves to
    // image with a deterministic media URL (same mechanism as real usage).
    const { targetId: pageTargetId } = await connection.send("Target.createTarget", { url: pageServer.pageUrl });
    await waitFor(async () => {
      const targets = await getTargets(connection);
      const page = targets.find((item) => item.targetId === pageTargetId);
      return page && String(page.url).includes("/spoof-page.html");
    }, { timeoutMs: 15_000, label: "fixture page load (popup QA)" });
    pageSession = await attachSession(connection, pageTargetId);
    await waitFor(async () => {
      try {
        return await evaluate(connection, pageSession, "typeof window.__lrSpoof === 'function'");
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "fixture page script (popup QA)" });
    await evaluate(connection, pageSession, `(() => {
      const img = document.getElementById("fixture-image");
      const rect = img.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      }));
      return true;
    })()`);
    await waitFor(async () => {
      try {
        return await evaluate(connection, swSession, "recentCapturesByTab.size") > 0;
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "hover image remembered by the background" });

    // Open the popup page as a background tab (active tab stays the page).
    const { targetId: popupTargetId } = await connection.send("Target.createTarget", {
      url: `chrome-extension://${runtimeId}/popup.html`,
      background: true,
    });
    popupSession = await attachSession(connection, popupTargetId);

    // Wait for the Quick Collect UI to settle into its final connected state.
    const popupState = await waitFor(async () => {
      try {
        const value = await evaluate(connection, popupSession, `(() => {
          const summary = document.getElementById("lr-target-summary");
          const advanced = document.getElementById("lr-advanced");
          const submit = document.getElementById("lr-submit");
          const qcType = document.getElementById("lr-qc-type");
          const status = document.getElementById("lr-status");
          const actionSummary = document.getElementById("lr-action-summary");
          if (!summary || !advanced || !submit || !qcType || !status || !actionSummary) return null;
          const typeLabel = qcType.querySelector("span");
          return {
            summary: summary.textContent,
            advancedHidden: advanced.hidden,
            submitDisabled: submit.disabled,
            qcType: typeLabel ? typeLabel.textContent : "",
            status: status.textContent,
            actionSummary: actionSummary.textContent,
          };
        })()`);
        if (!value || value.status !== "已连接" || value.actionSummary === "准备收集当前内容") return null;
        return value;
      } catch (_) {
        return null;
      }
    }, { timeoutMs: 25_000, label: "popup Quick Collect settled (connected + auto type + target summary)" });

    assert.equal(popupState.advancedHidden, true, "advanced options must be collapsed by default (compact Quick Collect)");
    assert.equal(popupState.status, "已连接", `popup must connect to the fake transport (got "${popupState.status}")`);
    assert.equal(popupState.qcType, "图片", `auto capture type must resolve to 图片 (got "${popupState.qcType}")`);
    assert.equal(popupState.summary, "素材库根目录", `default target summary must be 素材库根目录 (got "${popupState.summary}")`);
    assert.equal(popupState.submitDisabled, false, "submit must be enabled for connected+ready+complete state");
    assert.equal(
      mutatingWrites().length,
      0,
      "popup open/init must not produce any desktop write (reads on shared path names are allowed)",
    );

    // Advanced toggle: display-only, zero transport calls, zero writes.
    const callsBeforeToggle = fake.calls.length;
    await evaluate(connection, popupSession, `document.getElementById("lr-more-options").click(); true`);
    await sleep(600);
    const afterToggle = await evaluate(connection, popupSession, `(() => ({
      advancedHidden: document.getElementById("lr-advanced").hidden,
      expanded: document.getElementById("lr-more-options").getAttribute("aria-expanded"),
    }))()`);
    assert.equal(afterToggle.advancedHidden, false, "advanced options must expand on toggle");
    assert.equal(afterToggle.expanded, "true", "more-options aria-expanded must reflect the expanded state");
    assert.equal(fake.calls.length, callsBeforeToggle, "advanced toggle must not trigger any transport call");
    assert.equal(mutatingWrites().length, 0, "advanced toggle must not produce desktop writes");

    // Advanced controls still work: switch video -> image (render only).
    await evaluate(connection, popupSession, `document.querySelector('.lr-type[data-type="video"]').click(); true`);
    await sleep(500);
    const videoState = await evaluate(connection, popupSession, `(() => ({
      summary: document.getElementById("lr-target-summary").textContent,
      submitDisabled: document.getElementById("lr-submit").disabled,
      videoSectionDisplay: document.getElementById("lr-video-section").style.display,
    }))()`);
    assert.equal(videoState.summary, "素材库根目录", "video default target must stay asset:root");
    assert.equal(videoState.videoSectionDisplay, "", "video candidates section must be visible for video type");
    await evaluate(connection, popupSession, `document.querySelector('.lr-type[data-type="image"]').click(); true`);
    await sleep(500);
    const imageState = await evaluate(connection, popupSession, `(() => ({
      summary: document.getElementById("lr-target-summary").textContent,
      submitDisabled: document.getElementById("lr-submit").disabled,
    }))()`);
    assert.equal(imageState.summary, "素材库根目录", "back to image: target summary must be 素材库根目录");
    assert.equal(imageState.submitDisabled, false, "submit must be enabled again after switching back to image");
    assert.equal(fake.calls.length, callsBeforeToggle, "advanced type switching must not trigger transport calls");

    // Collapse again (display only).
    await evaluate(connection, popupSession, `document.getElementById("lr-more-options").click(); true`);
    await sleep(400);
    assert.equal(
      await evaluate(connection, popupSession, `document.getElementById("lr-advanced").hidden`),
      true,
      "advanced options must collapse again",
    );

    // Explicit submit -> exactly one desktop write (image -> asset:root).
    // Re-hover the image first: hover captures carry a short TTL, and the
    // popup interactions above can outlive it — a fresh hover makes the
    // submitted media URL deterministic.
    await evaluate(connection, pageSession, `(() => {
      const img = document.getElementById("fixture-image");
      const rect = img.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      }));
      return true;
    })()`);
    const callsBeforeSubmit = fake.calls.length;
    await evaluate(connection, popupSession, `document.getElementById("lr-submit").click(); true`);
    await waitFor(async () => mutatingWrites().length >= 1, {
      timeoutMs: 15_000,
      label: "submit write observed on the fake transport",
    });
    await sleep(800);
    const importCalls = fake.calls.filter((call) => (
      call.port === fakePort && call.path === "/api/assets/import-media"
    ));
    assert.equal(
      importCalls.length,
      1,
      `one explicit submit must produce exactly one import-media write (got ${importCalls.length})`,
    );
    assert.ok(importCalls.every((call) => call.hasAuthorization), "import-media write must carry Authorization");
    assert.equal(
      mutatingWrites().length,
      1,
      "the only desktop write across the whole QA must be the single import-media",
    );
    assert.ok(fake.calls.length > callsBeforeSubmit, "submit must produce transport activity");
    // Success feedback toast (canonical import response).
    const toast = await waitFor(async () => {
      const text = await evaluate(connection, popupSession, `document.getElementById("lr-toast").textContent`);
      return text ? text : null;
    }, { timeoutMs: 10_000, label: "popup success toast" });
    assert.match(toast, /已入库/, `success toast must confirm the import (got "${toast}")`);

    // ---- FIX-1 P1 regression: note:recent / note:search mode isolation ----
    // Drive the real popup through the note flows against fixture notes on
    // the fake transport. A stale/hidden selectedNoteId must never pass the
    // commit gate nor receive a write. UI transitions are polled to their
    // stable end state (the search round trip is async), not fixed sleeps.
    const appendPaths = () => fake.calls
      .filter((call) => call.path === "/api/notes/capture" && JSON.parse(call.body).target === "existing")
      .map((call) => ({ ...call, noteId: JSON.parse(call.body).noteId }));
    const waitPopup = (expression, label, timeoutMs = 12_000) => waitFor(async () => {
      try {
        return await evaluate(connection, popupSession, expression) || null;
      } catch (_) {
        return null;
      }
    }, { timeoutMs, label });
    await evaluate(connection, popupSession, `document.getElementById("lr-more-options").click(); true`);
    await sleep(300);
    await evaluate(connection, popupSession, `document.querySelector('.lr-type[data-type="text"]').click(); true`);
    await sleep(400);

    // note:search without any search-result selection: gate must stay
    // disabled — the recent-note preload default must not be inherited.
    await evaluate(connection, popupSession, `(() => {
      const select = document.getElementById("lr-target");
      select.value = "note:search";
      select.dispatchEvent(new Event("change"));
      return true;
    })()`);
    const searchGateBlocked = await waitPopup(
      `(() => {
        const disabled = document.getElementById("lr-submit").disabled;
        const summary = document.getElementById("lr-action-summary").textContent;
        return disabled && summary.includes("保存位置") ? { summary } : null;
      })()`,
      "note:search gate blocked without selection",
    );
    assert.match(
      searchGateBlocked.summary,
      /保存位置/,
      "incomplete-target guidance must be shown for note:search",
    );

    // Type query "A": results appear but nothing selected -> still disabled.
    await evaluate(connection, popupSession, `(() => {
      const input = document.getElementById("lr-note-q");
      input.value = "A";
      input.dispatchEvent(new Event("input"));
      return true;
    })()`);
    const queryAResults = await waitPopup(
      `(() => {
        const items = Array.from(document.querySelectorAll("#lr-note-list .lr-list-item"))
          .map((item) => item.textContent);
        const disabled = document.getElementById("lr-submit").disabled;
        return items.some((text) => text.includes("A 搜索命中")) && disabled ? { results: items } : null;
      })()`,
      "query A results listed with submit disabled",
    );
    assert.ok(
      queryAResults.results.some((text) => text.includes("A 搜索命中")),
      `search results for query A must be listed (got ${JSON.stringify(queryAResults.results)})`,
    );

    // Select result A -> gate enables; visible selection is A.
    await evaluate(connection, popupSession, `document.querySelector("#lr-note-list .lr-list-item").click(); true`);
    const selectedA = await waitPopup(
      `(() => {
        const selected = document.querySelector("#lr-note-list .lr-list-item.selected")?.textContent || "";
        const disabled = document.getElementById("lr-submit").disabled;
        return selected.includes("A 搜索命中") && !disabled ? { selected } : null;
      })()`,
      "search result A selected and submit enabled",
    );
    assert.ok(selectedA.selected.includes("A 搜索命中"), `visible selected search result must be A (got "${selectedA.selected}")`);

    // ---- FIX-2 P1 race: query change must invalidate synchronously ----
    // Editing the query must clear the previous search selection IMMEDIATELY
    // (no 250ms debounce window where a stale enabled submit could write the
    // old note), and onSubmit() must revalidate the commit gate before any
    // write path. RED on the pre-fix code: the stale submit writes A.
    const raceState = await evaluate(connection, popupSession, `(() => {
      const input = document.getElementById("lr-note-q");
      input.value = "X";
      input.dispatchEvent(new Event("input"));
      const submitDisabledAfterInput = document.getElementById("lr-submit").disabled;
      document.getElementById("lr-submit").click();
      return { submitDisabledAfterInput };
    })()`);
    assert.equal(
      raceState.submitDisabledAfterInput,
      true,
      "search input change must invalidate the previous selection synchronously (no debounce window)",
    );
    await sleep(1_200);
    assert.equal(
      appendPaths().length,
      0,
      `a submit attempted inside the debounce window must write nothing (got ${appendPaths().length} append(s))`,
    );
    assert.equal(
      appendPaths().filter((call) => call.noteId === "note-search-a").length,
      0,
      "the old search note A must never receive a write from a stale submit",
    );

    // Change the query -> the previous selection is invalidated.
    await evaluate(connection, popupSession, `(() => {
      const input = document.getElementById("lr-note-q");
      input.value = "X";
      input.dispatchEvent(new Event("input"));
      return true;
    })()`);
    const queryXInvalidated = await waitPopup(
      `(() => {
        const items = Array.from(document.querySelectorAll("#lr-note-list .lr-list-item"))
          .map((item) => item.textContent);
        const selected = document.querySelector("#lr-note-list .lr-list-item.selected")?.textContent || "";
        const disabled = document.getElementById("lr-submit").disabled;
        return items.some((text) => text.includes("X 搜索命中")) && !selected && disabled
          ? { selected: selected || "(none)" } : null;
      })()`,
      "query change invalidates the previous selection",
    );
    assert.equal(
      queryXInvalidated.selected,
      "(none)",
      "no result may stay marked selected after a query change",
    );

    // Select result X, then switch to note:recent: the hidden search id must
    // not authorize anything; the visible recent default rules the commit.
    await evaluate(connection, popupSession, `document.querySelector("#lr-note-list .lr-list-item").click(); true`);
    const selectedX = await waitPopup(
      `(() => {
        const selected = document.querySelector("#lr-note-list .lr-list-item.selected")?.textContent || "";
        const disabled = document.getElementById("lr-submit").disabled;
        return selected.includes("X 搜索命中") && !disabled ? { selected } : null;
      })()`,
      "search result X selected and submit enabled",
    );
    assert.ok(selectedX.selected.includes("X 搜索命中"), `visible selected search result must be X (got "${selectedX.selected}")`);

    // One explicit submit with the fresh X selection writes exactly X — and
    // never the previously selected A.
    const appendsBeforeX = appendPaths().length;
    await evaluate(connection, popupSession, `document.getElementById("lr-submit").click(); true`);
    await waitFor(async () => appendPaths().length > appendsBeforeX, {
      timeoutMs: 15_000,
      label: "X note append write observed",
    });
    await sleep(500);
    const xAppends = appendPaths();
    assert.equal(xAppends.length, 1, `exactly one append for the fresh X selection (got ${xAppends.length})`);
    assert.equal(
      xAppends[0].noteId,
      "note-search-x",
      "the write must target the visible X search result",
    );
    assert.ok(xAppends[0].hasAuthorization, "X append must carry Authorization");
    const xToast = await waitFor(async () => {
      const text = await evaluate(connection, popupSession, `document.getElementById("lr-toast").textContent`);
      return text && text.includes("已写入") ? text : null;
    }, { timeoutMs: 10_000, label: "X note write success toast" });
    assert.ok(xToast, "X append must confirm with a success toast");
    // Clear the toast so the recent-submit feedback below is distinguishable.
    await evaluate(connection, popupSession, `document.getElementById("lr-toast").textContent = ""; true`);

    // Switch to note:recent: the hidden search id must not authorize
    // anything; the visible recent default rules the commit.
    await evaluate(connection, popupSession, `(() => {
      const select = document.getElementById("lr-target");
      select.value = "note:recent";
      select.dispatchEvent(new Event("change"));
      return true;
    })()`);
    const recentDefault = await waitPopup(
      `(() => {
        const selected = document.querySelector("#lr-recent-list .lr-list-item.selected")?.textContent || "";
        const disabled = document.getElementById("lr-submit").disabled;
        return selected.includes("最近笔记一") && !disabled ? { selected } : null;
      })()`,
      "visible recent default selected and submit enabled",
    );
    assert.ok(
      recentDefault.selected.includes("最近笔记一"),
      `the visible selected recent note must be 最近笔记一 (got "${recentDefault.selected}")`,
    );

    // One explicit submit writes to exactly the visible recent note — the
    // delta over the earlier legitimate X submit.
    const appendBefore = appendPaths().length;
    await evaluate(connection, popupSession, `document.getElementById("lr-submit").click(); true`);
    await waitFor(async () => appendPaths().length > appendBefore, {
      timeoutMs: 15_000,
      label: "note append write observed",
    });
    await sleep(600);
    const appends = appendPaths();
    assert.equal(appends.length, appendBefore + 1, `exactly one more note append write (got ${appends.length})`);
    assert.equal(
      appends[appends.length - 1].noteId,
      "note-recent-1",
      "the write must target the visible recent note (note-recent-1)",
    );
    assert.ok(appends[appends.length - 1].hasAuthorization, "note append must carry Authorization");
    assert.equal(
      appendPaths().filter((call) => call.noteId === "note-search-a").length,
      0,
      "the stale search note A must never receive a write in any scenario",
    );
    assert.equal(
      appendPaths().filter((call) => call.noteId === "note-search-x").length,
      1,
      "the search note X receives exactly the one legitimate explicit write",
    );
    const noteToast = await waitFor(async () => {
      const text = await evaluate(connection, popupSession, `document.getElementById("lr-toast").textContent`);
      return text && text.includes("已写入") ? text : null;
    }, { timeoutMs: 10_000, label: "note write success toast" });
    assert.ok(noteToast, "note append must confirm with a success toast");

    // Task recovery intentionally persists one safe record. No transfer
    // request, page body, site authorization or transport credential may join
    // it, and nothing is synced. Existing session caches are also scanned for
    // credentials without changing their established retention contract.
    const storage = await evaluate(connection, swSession, `(async () => {
      const local = await chrome.storage.local.get(null);
      const sync = await chrome.storage.sync.get(null);
      const session = await chrome.storage.session.get(null);
      const strings = [];
      const walk = (item) => {
        if (typeof item === "string") strings.push(item);
        else if (item && typeof item === "object") Object.values(item).forEach(walk);
      };
      walk(local);
      walk(sync);
      walk(session);
      const leaks = strings.filter((item) => (
        /^[a-f0-9]{64}$/i.test(item) || /Bearer\\s+[A-Za-z0-9]{16,}/i.test(item)
      ));
      return {
        localKeys: Object.keys(local),
        syncKeys: Object.keys(sync).length,
        leakCount: leaks.length,
        task: local.luckyrayCaptureTaskV1,
      };
    })()`);
    assert.deepEqual(
      { localKeys: storage.localKeys, syncKeys: storage.syncKeys, leakCount: storage.leakCount },
      { localKeys: ["luckyrayCaptureTaskV1"], syncKeys: 0, leakCount: 0 },
      "only the named recovery record is local; credentials remain absent from every storage area",
    );
    assert.deepEqual(Object.keys(storage.task).sort(), [
      "asset", "createdAt", "disposition", "id", "kind", "noteRequest", "sourceUrl", "stage", "version",
    ], "a recovery record must not persist raw requests, source media URLs, page text or authorization fields");
    assert.deepEqual(storage.task.asset, {
      id: "fixture-asset-1", name: "fixture-image.png", type: "image", status: "ready",
    });
    assert.equal(storage.task.id, JSON.parse(importCalls[0].body).requestId, "recovery keeps the same explicit action identity");
    assert.equal(storage.task.stage, "completed");
    assert.equal(storage.task.kind, "image");
    assert.equal(storage.task.disposition, "imported");
    assert.equal(storage.task.noteRequest, null, "an asset-only task must not retain unrelated note targets or content");
    assert.equal(storage.task.sourceUrl, pageServer.pageUrl, "only the selected page attribution is retained");
    assert.equal(storage.task.version, 1);
    assert.ok(Number.isSafeInteger(storage.task.createdAt));
    console.log("[browser-extension-runtime] popup QA           : PASS (compact default, zero-write toggle/type, single explicit submit write)");
  } finally {
    try {
      if (connection) {
        try {
          await connection.send("Browser.close");
        } catch (_) {
          // Browser may already be gone.
        }
      }
    } catch (_) {
      // Ignore teardown failures and continue cleaning up.
    }
    if (launched) await stopChromium(launched);
    await Promise.all([fake?.close?.(), pageServer?.close?.()]);
    await connection?.close?.();
  }
});

// [BROWSER-EXT][M1-S3] Hover target precision QA (Issue #21 §8) — real
// Chromium hover fixture on the S1 isolated base. Synthetic mousemove over
// each visual case must resolve to the browser-displayed resource with
// resolver provenance (source/targetKind), while the fake desktop observes
// ZERO transport calls — hover/pointer observation is candidate-only and
// forged events never write.
test("M1-S3 hover target resolution & zero-write QA (isolated)", async () => {
  const browser = discoverBrowser();
  await assertDiscoveryRangeIsolated();
  const [fakePort] = await findFreePortsInRange(1);
  const fake = await startFakeTransport({ port: fakePort });
  const pageServer = await startFixturePageServer();
  let launched = null;
  let connection = null;
  let swSession = null;
  let pageSession = null;
  try {
    launched = await launchChromium({ browser, extensionPath: EXTENSION_DIR, headless: true });
    connection = await CdpConnection.connect(launched.wsUrl);
    const sw = await findServiceWorker(connection, 30_000);
    assert.ok(sw, "extension service worker must be present for the hover QA");
    swSession = await attachSession(connection, sw.targetId);

    const { targetId: pageTargetId } = await connection.send("Target.createTarget", {
      url: `${pageServer.pageUrl.replace("/spoof-page.html", "/hover-page.html")}`,
    });
    await waitFor(async () => {
      const targets = await getTargets(connection);
      const page = targets.find((item) => item.targetId === pageTargetId);
      return page && String(page.url).includes("/hover-page.html");
    }, { timeoutMs: 15_000, label: "hover fixture page load" });
    pageSession = await attachSession(connection, pageTargetId);
    await waitFor(async () => {
      try {
        return await evaluate(connection, pageSession, "Boolean(window.__lrHoverPage) && Boolean(window.__LUCKYRAY_PAGE_MEDIA_PROBE_V1__)");
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "hover fixture page + MAIN-world probe ready" });
    // Let images load so currentSrc is populated by the real browser.
    await sleep(1_500);

    const hoverAt = (selector) => evaluate(connection, pageSession, `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const rect = node.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      }));
      return true;
    })()`);
    // M1-S3 FIX-2: assert through the REAL production consumer — the SW's
    // getBestContextImage() (the popup path) queries the content script over
    // the luckyray-get-hover-image message with the remembered frame/document
    // binding, and the content script re-resolves the visual target through
    // the shared strict resolver. No direct SW-cache reads here.
    const consumerGetImage = () => evaluate(connection, swSession, `(async () => {
      const tabs = await chrome.tabs.query({});
      const page = tabs.find((tab) => tab.url && tab.url.includes("hover-page"));
      if (!page) return null;
      const descriptor = await getBestContextImage(page);
      if (!descriptor) return null;
      return { url: descriptor.url, source: descriptor.source, targetKind: descriptor.targetKind };
    })()`);
    const hoverExpect = async (selector, expectedPath, expectedSource, expectedKind) => {
      await hoverAt(selector);
      const capture = await waitFor(async () => {
        const value = await consumerGetImage();
        return value && String(value.url).endsWith(expectedPath) ? value : null;
      }, { timeoutMs: 12_000, label: `hover candidate ${expectedPath}` });
      assert.equal(capture.source, expectedSource, `source for ${expectedPath}`);
      assert.equal(capture.targetKind, expectedKind, `targetKind for ${expectedPath}`);
      return capture;
    };

    // 1) plain img -> currentSrc
    await hoverExpect("#h-plain", "/plain.jpg", "currentSrc", "img");
    // 2) picture/srcset -> same-target best safe candidate from the bound source
    await hoverExpect("#h-picture-img", "/pic-1200.jpg", "currentSrc", "img");
    // 3) lazy image without standard resource -> validated data-src fallback
    await hoverExpect("#h-lazy", "/lazy-real.jpg", "data-src", "img");
    // 4) placeholder + allowlisted original -> same-target HD original wins
    await hoverExpect("#h-placeholder", "/original.jpg", "data-original", "img");
    // 5) CSS background card via its child -> bounded ancestor background
    await hoverExpect("#h-card-child", "/card-bg.png", "background", "background");
    // 6) overlay-covered image -> nearest visual media target
    await hoverExpect("#h-overlay", "/under.jpg", "currentSrc", "img");
    // 7) video poster -> image-like candidate, never the video file
    await hoverExpect("#h-video", "/poster.jpg", "poster", "video-poster");
    // 8) SVG <image href> -> image candidate
    await hoverExpect("#h-svg-image", "/svg-target.png", "svg-href", "svg-image");
    // 9) same-origin iframe image -> all_frames frame-bound candidate via the
    //    real consumer path (getBestContextImage uses the remembered
    //    frame/document binding to query the frame's content script).
    await evaluate(connection, pageSession, `(() => {
      const frame = document.getElementById("h-frame");
      const img = frame && frame.contentDocument && frame.contentDocument.getElementById("f-img");
      if (!img) return false;
      const rect = img.getBoundingClientRect();
      frame.contentDocument.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      }));
      return true;
    })()`);
    await waitFor(async () => {
      const value = await consumerGetImage();
      return value && String(value.url).endsWith("/frame-img.png") ? value : null;
    }, { timeoutMs: 12_000, label: "iframe image hover candidate" });

    // Forged page event (untrusted contextmenu over the plain image) must not
    // produce a write — candidate state only.
    await evaluate(connection, pageSession, `(() => {
      const node = document.getElementById("h-plain");
      const rect = node.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
        button: 2,
      }));
      return true;
    })()`);
    await sleep(1_200);

    // Hover/pointer/forged observation: zero desktop transport calls at all.
    assert.equal(
      fake.calls.length,
      0,
      `hover/pointer/forged observation must produce zero desktop transport calls (got ${fake.calls.length})`,
    );
    assert.equal(
      writeCallsOn(fake.calls, fakePort).length,
      0,
      "hover candidates must never produce desktop writes",
    );
    console.log("[browser-extension-runtime] hover QA           : PASS (9 visual cases resolved, 0 transport calls, forged event 0 write)");
  } finally {
    try {
      if (connection) {
        try {
          await connection.send("Browser.close");
        } catch (_) {
          // Browser may already be gone.
        }
      }
    } catch (_) {
      // Ignore teardown failures and continue cleaning up.
    }
    if (launched) await stopChromium(launched);
    await Promise.all([fake?.close?.(), pageServer?.close?.()]);
    await connection?.close?.();
  }
});

// [BROWSER-EXT][M1-S4] Unified video capture state & save flow QA (Issue #25
// §9) — real popup driven on the S1 isolated base with a scripted fake
// transfer lifecycle: 0 write before any explicit action, one explicit save
// starts exactly one transfer, unified progress labels follow the backend
// fixture, duplicate saves read as "already exists", blob candidates project
// to record-fallback and never write.
test("M1-S4 unified video state & save-flow QA (isolated)", async () => {
  const browser = discoverBrowser();
  await assertDiscoveryRangeIsolated();
  const [fakePort] = await findFreePortsInRange(1);
  const fake = await startFakeTransport({ port: fakePort });
  const pageServer = await startFixturePageServer();
  const transferPosts = () => fake.calls.filter((call) => (
    call.port === fakePort && call.method === "POST" && call.path === "/api/media/transfers"
  ));
  let launched = null;
  let connection = null;
  let swSession = null;
  let pageSession = null;
  let popupSession = null;
  try {
    launched = await launchChromium({ browser, extensionPath: EXTENSION_DIR, headless: true });
    connection = await CdpConnection.connect(launched.wsUrl);
    const sw = await findServiceWorker(connection, 30_000);
    assert.ok(sw, "extension service worker must be present for the video QA");
    const runtimeId = String(sw.url).match(/^chrome-extension:\/\/([a-z]{32})\/background\.js$/)?.[1];
    assert.ok(runtimeId, "runtime extension id");
    swSession = await attachSession(connection, sw.targetId);

    await waitFor(async () => {
      try {
        return await evaluate(connection, swSession,
          "videoCandidateCacheHydrated === true && typeof recentCapture === 'function'");
      } catch (_) { return false; }
    }, { timeoutMs: 15_000, label: "video QA background initialized" });

    // A MAIN-world fixture marker does not establish extension readiness.
    // Wait for navigation and the real isolated receiver before hovering;
    // navigation's loading/url events otherwise clear the background capture.
    const readySourceTab = (pageUrl) => waitFor(async () => evaluate(connection, swSession, `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(item => item.url === ${JSON.stringify(pageUrl)} && item.status === 'complete');
      if (!tab) return null;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'luckyray-get-context-kind' });
        return response?.captureProtocolVersion === LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION
          ? tab.id : null;
      } catch (_) { return null; }
    })()`), { timeoutMs: 15_000, label: `video QA source receiver ready (${new URL(pageUrl).pathname})` });
    const waitCapturedVideo = (tabId, expectedUrl) => waitFor(async () => evaluate(connection, swSession, `(() => {
      const capture = recentCapture(${tabId}, 'video');
      return capture?.url === ${JSON.stringify(expectedUrl)} ? { url: capture.url, ageMs: Date.now() - capture.capturedAt } : null;
    })()`), { timeoutMs: 5_000, label: "video hover observed by the background before opening popup" });

    const hoverVideo = (selector) => evaluate(connection, pageSession, `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const rect = node.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      }));
      return true;
    })()`);
    const popupState = () => evaluate(connection, popupSession, `(() => {
      const banner = document.getElementById("lr-video-state");
      const submit = document.getElementById("lr-submit");
      const status = document.getElementById("lr-status");
      const progressLabel = document.getElementById("lr-transfer-progress-label");
      if (!banner || !submit || !status || !progressLabel) return null;
      return {
        banner: banner.textContent,
        bannerState: banner.dataset.state,
        submitDisabled: submit.disabled,
        status: status.textContent,
        progressLabel: progressLabel.textContent,
      };
    })()`);

    // Phase 1: a blob-only page (the spoof fixture has a pure blob video, no
    // network media) -> popup video mode -> unified record-fallback, and a
    // submit there never starts a transfer.
    const { targetId: spoofTargetId } = await connection.send("Target.createTarget", {
      url: pageServer.pageUrl,
    });
    await waitFor(async () => {
      const targets = await getTargets(connection);
      const page = targets.find((item) => item.targetId === spoofTargetId);
      return page && String(page.url).includes("/spoof-page.html");
    }, { timeoutMs: 15_000, label: "spoof page load (video QA)" });
    const spoofSession = await attachSession(connection, spoofTargetId);
    await waitFor(async () => {
      try {
        return await evaluate(connection, spoofSession, "typeof window.__lrSpoof === 'function'");
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "spoof page ready (video QA)" });
    const spoofTabId = await readySourceTab(pageServer.pageUrl);
    const blobUrl = await evaluate(connection, spoofSession, "document.getElementById('fixture-video').src");
    assert.match(blobUrl, /^blob:/, "record fallback fixture must own a real blob URL");
    await evaluate(connection, spoofSession, `(() => {
      const node = document.getElementById("fixture-video");
      const rect = node.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      }));
      return true;
    })()`);
    await waitCapturedVideo(spoofTabId, blobUrl);
    const openPopup = async (expectedSourceUrl, expectedVideoUrl) => {
      const { targetId: popupTargetId } = await connection.send("Target.createTarget", {
        url: `chrome-extension://${runtimeId}/popup.html`,
        background: true,
      });
      popupSession = await attachSession(connection, popupTargetId);
      await waitFor(async () => {
        try {
          const value = await popupState();
          const source = await evaluate(connection, popupSession,
            "({ url: state.page?.url, videoUrl: state.page?.videoUrl, type: state.type })");
          // Connection status is rendered before ensurePage finishes. Clicking
          // a type then races its final source/type assignment.
          return value && value.status === "已连接" && value.banner !== ""
            && source.url === expectedSourceUrl && source.videoUrl === expectedVideoUrl
            && source.type === "video" ? value : null;
        } catch (_) {
          return null;
        }
      }, { timeoutMs: 25_000, label: "popup video mode ready" });
      await evaluate(connection, popupSession, `document.querySelector('.lr-type[data-type="video"]').click(); true`);
      return popupTargetId;
    };
    const closePopup = async (popupTargetId) => {
      await connection.send("Target.closeTarget", { targetId: popupTargetId });
      popupSession = null;
      await sleep(300);
    };
    const popupTargetId1 = await openPopup(pageServer.pageUrl, blobUrl);
    const recordState = await waitFor(async () => {
      const value = await popupState();
      return value && value.bannerState === "record-fallback" ? value : null;
    }, { timeoutMs: 15_000, label: "video state record-fallback" }).catch(async (error) => {
      error.message += `; visible state: ${JSON.stringify(await popupState())}`;
      error.message += `; source binding: ${JSON.stringify(await evaluate(connection, popupSession,
        "({ sourceUrl: state.page?.url, videoUrl: state.page?.videoUrl, type: state.type, tabId: state.tab?.id })"))}`;
      throw error;
    });
    assert.equal(recordState.banner, "需要录制", "blob candidate must show the unified record-fallback label");
    await evaluate(connection, popupSession, `document.getElementById("lr-submit").click(); true`);
    await sleep(1_000);
    assert.equal(
      transferPosts().length,
      0,
      "a submit on a record-fallback candidate must never start a transfer",
    );
    await closePopup(popupTargetId1);

    // Phase 2: the hover fixture's direct video -> unified ready-direct,
    // one explicit save -> exactly one transfer -> unified progress.
    const { targetId: pageTargetId } = await connection.send("Target.createTarget", {
      url: `${pageServer.pageUrl.replace("/spoof-page.html", "/hover-page.html")}`,
    });
    await waitFor(async () => {
      const targets = await getTargets(connection);
      const page = targets.find((item) => item.targetId === pageTargetId);
      return page && String(page.url).includes("/hover-page.html");
    }, { timeoutMs: 15_000, label: "hover fixture page load (video QA)" });
    pageSession = await attachSession(connection, pageTargetId);
    await waitFor(async () => {
      try {
        return await evaluate(connection, pageSession, "Boolean(window.__lrHoverPage)");
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "hover fixture page ready (video QA)" });
    const directPageUrl = pageServer.pageUrl.replace("/spoof-page.html", "/hover-page.html");
    const directTabId = await readySourceTab(directPageUrl);
    const directUrl = await evaluate(connection, pageSession, "document.getElementById('h-video').src");
    await hoverVideo("#h-video");
    await waitCapturedVideo(directTabId, directUrl);
    const popupTargetId2 = await openPopup(directPageUrl, directUrl);
    const directState = await waitFor(async () => {
      const value = await popupState();
      return value && value.bannerState === "ready-direct" ? value : null;
    }, { timeoutMs: 15_000, label: "video state ready-direct" });
    assert.equal(directState.banner, "可直接保存", "direct candidate must show the unified ready-direct label");

    // 0 desktop write before any explicit save (hover + popup open + refresh
    // + the record-fallback submit attempt above).
    assert.equal(
      transferPosts().length,
      0,
      "hover / popup open / candidate refresh must not start any transfer",
    );
    assert.equal(
      fake.calls.filter((call) => call.method !== "GET" && WRITE_ROUTES.includes(call.path)).length,
      0,
      "no desktop write before the explicit save",
    );

    // 3) one explicit save -> exactly one transfer -> unified progress.
    await evaluate(connection, popupSession, `document.getElementById("lr-submit").click(); true`);
    await waitFor(async () => transferPosts().length >= 1, {
      timeoutMs: 15_000,
      label: "transfer started",
    });
    await sleep(400);
    assert.equal(transferPosts().length, 1, "one explicit save must start exactly one transfer");
    const seenLabels = new Set();
    const completedLabel = await waitFor(async () => {
      const value = await popupState();
      if (value) seenLabels.add(value.progressLabel);
      return value && value.progressLabel === "已入库" ? value.progressLabel : null;
    }, { timeoutMs: 20_000, label: "transfer completed progress label" });
    assert.equal(completedLabel, "已入库", "completed transfer must show 已入库");
    assert.ok(
      Array.from(seenLabels).some((label) => label === "等待入库" || label.includes("正在下载") || label === "正在写入素材库"),
      `progress must transition through the unified states (seen: ${Array.from(seenLabels).join(", ")})`,
    );
    const importToast = await waitFor(async () => {
      const text = await evaluate(connection, popupSession, `document.getElementById("lr-toast").textContent`);
      return text && text.includes("已入库") ? text : null;
    }, { timeoutMs: 10_000, label: "video import success toast" });
    assert.ok(importToast, "completed save must confirm with a success toast");

    // 4) duplicate save of the same URL -> 已存在, no new transfer.
    await evaluate(connection, popupSession, `document.getElementById("lr-toast").textContent = ""; true`);
    await evaluate(connection, popupSession, `document.getElementById("lr-submit").click(); true`);
    const duplicateToast = await waitFor(async () => {
      const text = await evaluate(connection, popupSession, `document.getElementById("lr-toast").textContent`);
      return text && text.includes("已存在") ? text : null;
    }, { timeoutMs: 15_000, label: "duplicate save toast" });
    assert.ok(duplicateToast, "duplicate save must read as 已存在/素材已存在");
    assert.equal(transferPosts().length, 2, "duplicate save posts once and resolves via skippedDuplicate");

    // 5) forged page event must not authorize a write.
    await evaluate(connection, pageSession, `(() => {
      const node = document.getElementById("h-video");
      const rect = node.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
        button: 2,
      }));
      return true;
    })()`);
    await sleep(1_000);
    assert.equal(
      fake.calls.filter((call) => call.method !== "GET" && WRITE_ROUTES.includes(call.path)).length,
      2,
      "forged events must not add any desktop write (the two transfer posts are the only writes)",
    );
    console.log("[browser-extension-runtime] video QA           : PASS (ready-direct / duplicate / record-fallback / single-transfer / progress / 0 pre-action write)");
  } finally {
    try {
      if (connection) {
        try {
          await connection.send("Browser.close");
        } catch (_) {
          // Browser may already be gone.
        }
      }
    } catch (_) {
      // Ignore teardown failures and continue cleaning up.
    }
    if (launched) await stopChromium(launched);
    await Promise.all([fake?.close?.(), pageServer?.close?.()]);
    await connection?.close?.();
  }
});

// [BROWSER-EXT][M1-S4][FIX-1][P1-2] The player overlay must project the same
// unified user-level video state as the popup for EVERY render — empty AND
// non-empty candidates — through the real content-script overlay (closed
// shadow DOM, read via the CDP DOM domain) and the real background video
// session. Row actions and the record affordance must stay intact.
test("M1-S4 FIX-1 player overlay unified-state DOM QA (isolated)", async () => {
  const browser = discoverBrowser();
  await assertDiscoveryRangeIsolated();
  const [fakePort] = await findFreePortsInRange(1);
  const fake = await startFakeTransport({ port: fakePort });
  const pageServer = await startFixturePageServer();
  let launched = null;
  let connection = null;
  let pageSession = null;
  try {
    launched = await launchChromium({ browser, extensionPath: EXTENSION_DIR, headless: true });
    connection = await CdpConnection.connect(launched.wsUrl);
    const sw = await findServiceWorker(connection, 30_000);
    assert.ok(sw, "extension service worker must be present for the overlay QA");

    const { targetId: pageTargetId } = await connection.send("Target.createTarget", {
      url: `${pageServer.pageUrl.replace("/spoof-page.html", "/overlay-page.html")}`,
    });
    await waitFor(async () => {
      const targets = await getTargets(connection);
      const page = targets.find((item) => item.targetId === pageTargetId);
      return page && String(page.url).includes("/overlay-page.html");
    }, { timeoutMs: 15_000, label: "overlay fixture page load" });
    pageSession = await attachSession(connection, pageTargetId);
    await waitFor(async () => {
      try {
        return await evaluate(connection, pageSession, "Boolean(window.__lrOverlayPage)");
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "overlay fixture page ready" });
    // Let the video elements request their sources so the network candidates
    // settle before the overlay sessions are opened.
    await sleep(1_800);

    // The overlay host uses a CLOSED shadow root: the page world cannot reach
    // chip/panel, but the CDP DOM domain reads the browser's real tree.
    // Overlays are created in first-hover order, so the newest host is the
    // overlay of the currently hovered video.
    // Tag every CDP DOM call with its method name so an Invalid parameters
    // error pinpoints the exact call (Edge 151 differs from the protocol doc).
    const domSend = async (method, params) => {
      try {
        return await connection.send(method, params, pageSession);
      } catch (error) {
        throw new Error(`CDP ${method} failed: ${error.message}`);
      }
    };
    // CDP Node.attributes is a FLAT array [name1, value1, name2, value2, ...].
    const flatAttr = (node, name) => {
      const attrs = node?.attributes || [];
      for (let index = 0; index + 1 < attrs.length; index += 2) {
        if (attrs[index] === name) return String(attrs[index + 1]);
      }
      return "";
    };
    const overlayHostNodeIds = async () => {
      // Hosts live in light DOM; a plain querySelectorAll finds them even in
      // a depth-1 document snapshot.
      const { root } = await domSend("DOM.getDocument", { depth: 1, pierce: true });
      const { nodeIds } = await domSend("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "[data-luckyray-video-capture]",
      });
      return nodeIds || [];
    };
    const describeHostTree = async (hostId) => {
      const { node } = await domSend("DOM.describeNode", { nodeId: hostId, pierce: true, depth: 50 });
      return node;
    };
    const overlayPanelHtml = async () => {
      const nodeIds = await overlayHostNodeIds();
      if (!nodeIds.length) return null;
      const hostNode = await describeHostTree(nodeIds[nodeIds.length - 1]);
      const panels = [];
      const visit = (node) => {
        if (!node) return;
        if (flatAttr(node, "class").split(/\s+/).includes("lr-panel")) panels.push(node);
        for (const child of node.children || []) visit(child);
        for (const shadow of node.shadowRoots || []) visit(shadow);
      };
      visit(hostNode);
      const panel = panels[panels.length - 1];
      if (!panel) return null;
      // describeNode-tree ids are not usable for other DOM calls on Edge;
      // backendNodeId is stable across the DOM agent.
      const { outerHTML } = await domSend("DOM.getOuterHTML", {
        backendNodeId: panel.backendNodeId,
      });
      return outerHTML;
    };
    const clickNewestChip = async () => {
      const nodeIds = await overlayHostNodeIds();
      if (!nodeIds.length) return false;
      // The chip lives in a CLOSED shadow root — page JS cannot reach it, but
      // the CDP DOM domain can resolve the real node and invoke a genuine
      // DOM click() on it (Edge 151 rejects Input.dispatchMouseEvent here).
      // The chip to click lives inside the NEWEST overlay host only (each
      // video owns one host, created in first-hover order).
      const hostNode = await describeHostTree(nodeIds[nodeIds.length - 1]);
      let chip = null;
      const findChip = (node) => {
        if (!node || chip) return;
        if (flatAttr(node, "class").split(/\s+/).includes("lr-chip")) chip = node;
        for (const child of node.children || []) findChip(child);
        for (const shadow of node.shadowRoots || []) findChip(shadow);
      };
      findChip(hostNode);
      if (!chip || !chip.backendNodeId) return false;
      const { object } = await domSend("DOM.resolveNode", { backendNodeId: chip.backendNodeId });
      if (!object || !object.objectId) return false;
      await connection.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function () { this.click(); }",
        awaitPromise: true,
      }, pageSession);
      return true;
    };
    // Hover the video (real chip appears), click its chip with a real input
    // event, wait for the panel to render, return the panel's outer HTML.
    const openOverlayFor = async (selector) => {
      // The chip hides ~220ms after the last mousemove (schedule-hide timer),
      // and Edge's DOM.getBoxModel rejects a display:none host (-32602).
      // Re-hover a few times so the chip stays visible through the click.
      const hoverAt = async () => {
        await evaluate(connection, pageSession, `(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          // The rows are stacked vertically; bring the target into the
          // viewport so elementsFromPoint resolves it (chip creation depends
          // on the hit test, not just the synthetic event).
          node.scrollIntoView({ block: "center" });
          const rect = node.getBoundingClientRect();
          document.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true,
            clientX: Math.round(rect.left + rect.width / 2),
            clientY: Math.round(rect.top + rect.height / 2),
          }));
          return true;
        })()`);
        await sleep(120);
      };
      for (let index = 0; index < 4; index += 1) await hoverAt();
      // The chip is the overlay host's shadow sibling of the panel; wait for
      // the host to exist before resolving and clicking its chip.
      await waitFor(async () => {
        const nodeIds = await overlayHostNodeIds();
        return nodeIds.length > 0;
      }, { timeoutMs: 15_000, label: `overlay chip for ${selector}` });
      await hoverAt();
      const clicked = await clickNewestChip();
      if (!clicked) {
        await hoverAt();
        await clickNewestChip();
      }
      // Wait for the panel to be open AND the unified banner to have rendered
      // (render() completes only after the real background session answers).
      return await waitFor(async () => {
        const html = await overlayPanelHtml();
        return html && html.includes('data-open="true"') && html.includes("lr-state") ? html : null;
      }, { timeoutMs: 20_000, label: `overlay panel open for ${selector}` }).catch(async (error) => {
        const html = await overlayPanelHtml();
        throw new Error(`${error.message} | panel html: ${String(html || "").slice(0, 400)}`);
      });
    };

    // 1) one direct item -> ready-direct / 可直接保存, row action intact.
    let html = await openOverlayFor("#ov-direct");
    assert.match(html, /data-state="ready-direct"/,
      `direct overlay must expose the unified ready-direct state (got: ${String(html).slice(0, 900)})`);
    assert.ok(html.includes("可直接保存"), "direct overlay must show the unified label");
    assert.ok(html.includes("lr-action"), "direct overlay must keep its row save action");

    // 2) multiple saveable formats -> choose-quality / 选择清晰度, all rows kept.
    html = await openOverlayFor("#ov-multi");
    assert.match(html, /data-state="choose-quality"/, "multi-quality overlay must expose choose-quality");
    assert.ok(html.includes("选择清晰度"), "multi-quality overlay must show the unified label");
    assert.ok(html.includes("lr-action"), "multi-quality overlay must keep every row action");

    // 3) one site-resolver item -> needs-resolve / 需要解析. The resolver
    //    page anchor scan walks up to <body>, so this case needs its own page
    //    (a youtube link on the shared page would leak into every session).
    const { targetId: resolveTargetId } = await connection.send("Target.createTarget", {
      url: `${pageServer.pageUrl.replace("/spoof-page.html", "/resolve-page.html")}`,
    });
    await waitFor(async () => {
      const targets = await getTargets(connection);
      const page = targets.find((item) => item.targetId === resolveTargetId);
      return page && String(page.url).includes("/resolve-page.html");
    }, { timeoutMs: 15_000, label: "resolve fixture page load" });
    const resolveSession = await attachSession(connection, resolveTargetId);
    await waitFor(async () => {
      try {
        return await evaluate(connection, resolveSession, "Boolean(window.__lrResolvePage)");
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "resolve fixture page ready" });
    await sleep(1_200);
    const prevPageSession = pageSession;
    pageSession = resolveSession;
    html = await openOverlayFor("#rv-video");
    pageSession = prevPageSession;
    assert.match(html, /data-state="needs-resolve"/, "site-resolver overlay must expose needs-resolve");
    assert.ok(html.includes("需要解析"), "site-resolver overlay must show the unified label");
    assert.ok(html.includes("选择清晰度"), "site-resolver row action (probe formats) must stay");

    // 4) empty + canRecord -> record-fallback / 需要录制, and the existing
    //    record affordance stays visible right below (PRESERVE-FIRST P1-1).
    html = await openOverlayFor("#ov-blob");
    assert.match(html, /data-state="record-fallback"/, "blob-only overlay must expose record-fallback");
    assert.ok(html.includes("需要录制"), "blob-only overlay must show the unified label");
    assert.ok(html.includes("lr-record"), "blob-only overlay must keep the 录制当前标签页 affordance");
    assert.ok(html.includes("lr-empty"), "blob-only overlay must keep the empty guidance block");
    assert.ok(!html.includes("先播放几秒"), "record-fallback must never contradict with needs-play text");

    // Forged page event (untrusted contextmenu over a video) must not open a
    // session or produce any desktop write.
    await evaluate(connection, pageSession, `(() => {
      const node = document.getElementById("ov-direct");
      const rect = node.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
        button: 2,
      }));
      return true;
    })()`);
    await sleep(1_000);
    assert.equal(
      fake.calls.filter((call) => call.method !== "GET" && WRITE_ROUTES.includes(call.path)).length,
      0,
      "overlay hover/open/forged events must never produce desktop writes",
    );
    console.log("[browser-extension-runtime] overlay QA        : PASS (ready-direct / choose-quality / needs-resolve / record-fallback + actions intact, 0 write)");
  } finally {
    try {
      if (connection) {
        try {
          await connection.send("Browser.close");
        } catch (_) {
          // Browser may already be gone.
        }
      }
    } catch (_) {
      // Ignore teardown failures and continue cleaning up.
    }
    if (launched) await stopChromium(launched);
    await Promise.all([fake?.close?.(), pageServer?.close?.()]);
    await connection?.close?.();
  }
});

// [BROWSER-EXT][M1-S4][FIX-1][P1-3] Explicit candidate identity: an explicit
// user pick must survive refresh by identity; when the picked candidate
// disappears from the refreshed list, the selection is cleared and NO
// candidate is silently committed as its replacement until the user picks a
// visible candidate again. Real popup DOM driven against the real background:
//   1. load A+B+C (network-observed fetches on the retarget fixture);
//   2. user explicitly selects B (1080p row);
//   3. B is removed from the persisted session cache and the SW is restarted,
//      so the next refresh observes A(720p)+C(480p) without B;
//   4. no row is silently selected, submit stays blocked, 0 transfers;
//   5. explicit pick C -> exactly one save targets C.
test("M1-S4 FIX-1 popup explicit-selection identity QA (isolated)", async () => {
  const browser = discoverBrowser();
  await assertDiscoveryRangeIsolated();
  const [fakePort] = await findFreePortsInRange(1);
  const fake = await startFakeTransport({ port: fakePort });
  const pageServer = await startFixturePageServer();
  const transferPosts = () => fake.calls.filter((call) => (
    call.port === fakePort && call.method === "POST" && call.path === "/api/media/transfers"
  ));
  let launched = null;
  let connection = null;
  let swSession = null;
  let pageSession = null;
  let popupSession = null;
  try {
    launched = await launchChromium({ browser, extensionPath: EXTENSION_DIR, headless: true });
    connection = await CdpConnection.connect(launched.wsUrl);
    const sw = await findServiceWorker(connection, 30_000);
    assert.ok(sw, "extension service worker must be present for the retarget QA");
    const runtimeId = String(sw.url).match(/^chrome-extension:\/\/([a-z]{32})\/background\.js$/)?.[1];
    assert.ok(runtimeId, "runtime extension id");
    swSession = await attachSession(connection, sw.targetId);

    await waitFor(async () => {
      try { return await evaluate(connection, swSession, "videoCandidateCacheHydrated === true && typeof getVideoCandidatesForTab === 'function'"); }
      catch (_) { return false; }
    }, { timeoutMs: 15_000, label: "retarget background initialized" });
    const { targetId: pageTargetId } = await connection.send("Target.createTarget", {
      url: `${pageServer.pageUrl.replace("/spoof-page.html", "/retarget-page.html")}`,
    });
    await waitFor(async () => {
      const targets = await getTargets(connection);
      const page = targets.find((item) => item.targetId === pageTargetId);
      return page && String(page.url).includes("/retarget-page.html");
    }, { timeoutMs: 15_000, label: "retarget fixture page load" });
    pageSession = await attachSession(connection, pageTargetId);
    await waitFor(async () => {
      try {
        return await evaluate(connection, pageSession, "typeof window.__lrEmitRetargetCandidates === 'function'");
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15_000, label: "retarget fixture page ready" });
    const retargetTabId = await waitFor(async () => evaluate(connection, swSession, `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(t => String(t.url || '').includes('/retarget-page.html') && t.status === 'complete');
      return tab?.id || null;
    })()`), { timeoutMs: 15_000, label: "retarget navigation complete" });
    await evaluate(connection, pageSession, "window.__lrEmitRetargetCandidates()");
    await waitFor(async () => evaluate(connection, swSession, `(async () => {
      const memory = getVideoCandidatesForTab(${retargetTabId});
      const saved = await chrome.storage.session.get(VIDEO_CANDIDATE_SESSION_KEY);
      return memory.length === 3 && saved[VIDEO_CANDIDATE_SESSION_KEY]?.[${retargetTabId}]?.length === 3;
    })()`), { timeoutMs: 15_000, label: "three candidates observed and persisted before popup" });

    const popupState = () => evaluate(connection, popupSession, `(() => {
      const banner = document.getElementById("lr-video-state");
      const toast = document.getElementById("lr-toast");
      const submit = document.getElementById("lr-submit");
      const status = document.getElementById("lr-status");
      if (!banner || !toast || !submit || !status) return null;
      return {
        bannerState: banner.dataset.state,
        banner: banner.textContent,
        rows: Array.from(document.querySelectorAll(".lr-candidate")).map((row) =>
          row.querySelector("strong")?.textContent || ""),
        selected: Array.from(document.querySelectorAll(".lr-candidate.selected")).map((row) =>
          row.querySelector("strong")?.textContent || ""),
        toast: toast.textContent,
        submitDisabled: submit.disabled,
        status: status.textContent,
      };
    })()`);
    const { targetId: popupTargetId } = await connection.send("Target.createTarget", {
      url: `chrome-extension://${runtimeId}/popup.html`,
      background: true,
    });
    popupSession = await attachSession(connection, popupTargetId);
    await waitFor(async () => {
      try {
        const value = await popupState();
        return value !== null ? value : null;
      } catch (_) {
        return null;
      }
    }, { timeoutMs: 25_000, label: "popup ready" });
    // ensurePage() settles state.type via choosePopupCaptureType AFTER any
    // early type click would be overwritten; wait for the boot to finish
    // (retarget-page has no hover media -> deterministic "text") before
    // switching to video mode.
    await waitFor(async () => {
      const booted = await evaluate(connection, popupSession, `(() => ({
        type: state.type,
        target: document.getElementById("lr-target").value,
      }))()`);
      return booted && booted.type === "text" ? booted : null;
    }, { timeoutMs: 25_000, label: "popup booted (type settled)" });
    await evaluate(connection, popupSession, `document.querySelector('.lr-type[data-type="video"]').click(); true`);
    const initial = await waitFor(async () => {
      const value = await popupState();
      return value && value.bannerState === "choose-quality" && value.rows.length === 3 ? value : null;
    }, { timeoutMs: 20_000, label: "initial candidate rows A/B/C" }).catch(async (error) => {
      error.message += `; visible state: ${JSON.stringify(await popupState())}`;
      error.message += `; source binding: ${JSON.stringify(await evaluate(connection, popupSession,
        `({ tabId: state.tab?.id, sourcePath: new URL(state.tab?.url || 'about:blank').pathname, candidates: state.videoCandidates.length })`))}`;
      throw error;
    });
    assert.deepEqual(initial.rows, ["1080p · MP4", "720p · MP4", "480p · MP4"],
      "the three network candidates must render quality-ordered");

    // 2) user explicitly selects B (the 1080p row).
    await evaluate(connection, popupSession, `(() => {
      const row = Array.from(document.querySelectorAll(".lr-candidate"))
        .find((node) => node.textContent.includes("1080p"));
      row.click();
      return true;
    })()`);
    const afterPick = await waitFor(async () => {
      const value = await popupState();
      return value && value.selected.length === 1 ? value : null;
    }, { timeoutMs: 10_000, label: "explicit B selection" });
    assert.deepEqual(afterPick.selected, ["1080p · MP4"], "the explicit pick must mark B selected");

    // 3) drop B from the persisted session cache, restart the SW so the next
    //    refresh hydrates A+C only (B is gone, A/C remain).
    const rewrite = await evaluate(connection, swSession, `(async () => {
      const tabs = await chrome.tabs.query({});
      const page = tabs.find((tab) => String(tab.url || "").includes("retarget-page"));
      const tabId = page ? page.id : null;
      if (!Number.isInteger(tabId)) return null;
      const all = await chrome.storage.session.get(null);
      const key = Object.keys(all).find((name) => all[name] && typeof all[name] === "object"
        && Array.isArray(all[name][String(tabId)]));
      if (!key) return null;
      const kept = all[key][String(tabId)].filter((item) => !String(item.url || "").includes("movie-1080p.mp4"));
      await chrome.storage.session.set({ [key]: { ...all[key], [String(tabId)]: kept } });
      return { tabId, before: all[key][String(tabId)].length, after: kept.length };
    })()`);
    assert.ok(rewrite && rewrite.after === rewrite.before - 1,
      `session cache must drop exactly B (got ${JSON.stringify(rewrite)})`);
    const swBefore = await findServiceWorker(connection, 5_000);
    await connection.send("Target.closeTarget", { targetId: swBefore.targetId });
    await sleep(750);

    // 4) refresh -> A+C; NO candidate may be silently committed as B's
    //    replacement; submit stays blocked; 0 transfers.
    const refreshUntil = async (check, label) => await waitFor(async () => {
      await evaluate(connection, popupSession, `document.getElementById("lr-video-refresh").click(); true`);
      const value = await popupState();
      return check(value) ? value : null;
    }, { timeoutMs: 30_000, label });
    const refreshed = await refreshUntil(
      (value) => value && value.bannerState === "choose-quality" && value.rows.length === 2,
      "refresh observes A+C without B",
    );
    assert.deepEqual(refreshed.rows, ["720p · MP4", "480p · MP4"], "refresh must keep A and C, drop B");
    assert.deepEqual(refreshed.selected, [],
      "a vanished explicit pick must NOT silently retarget to a remaining candidate");

    // EXT-R1-REPAIR-2 contract C: the visible submit gate now equals the final
    // write gate — after the explicit pick vanished, Save must stay DISABLED
    // with the re-pick reason (clicking a stale enabled control must not be
    // the first place the user learns about the invalidation).
    await waitFor(async () => {
      const value = await popupState();
      return value && value.submitDisabled === true ? value : null;
    }, { timeoutMs: 15_000, label: "submit disabled after invalidation" }).catch(async (error) => {
      const gate = await evaluate(connection, popupSession, `(() => {
        try {
          return {
            target: document.getElementById("lr-target").value,
            port: state.port,
            type: state.type,
            gate: quickCollectGateState(),
            pageType: state.page?.type,
          };
        } catch (e) { return { threw: String(e) }; }
      })()`);
      throw new Error(`${error.message} | gate debug: ${JSON.stringify(gate)}`);
    });
    const actionSummaryText = await evaluate(connection, popupSession,
      `String(document.getElementById("lr-action-summary")?.textContent || "")`);
    assert.ok(actionSummaryText.includes("重新选择") || actionSummaryText.includes("选择"),
      `the disabled control must show the re-pick reason (action summary: "${actionSummaryText}")`);
    await evaluate(connection, popupSession, `document.getElementById("lr-submit").click(); true`);
    await sleep(700);
    const blocked = await popupState();
    assert.equal(transferPosts().length, 0, "submit without an explicit re-pick must not write");
    assert.ok(blocked.toast.includes("重新选择") || blocked.submitDisabled === true,
      `submit must ask for an explicit re-pick (toast: "${blocked.toast}", banner: ${blocked.bannerState}, submitDisabled: ${blocked.submitDisabled}, status: "${blocked.status}")`);

    // 5) explicit pick C -> exactly one save targets C.
    await evaluate(connection, popupSession, `(() => {
      const row = Array.from(document.querySelectorAll(".lr-candidate"))
        .find((node) => node.textContent.includes("480p"));
      row.click();
      return true;
    })()`);
    const picked = await waitFor(async () => {
      const value = await popupState();
      return value && value.selected.length === 1 ? value : null;
    }, { timeoutMs: 10_000, label: "explicit C selection" });
    assert.deepEqual(picked.selected, ["480p · MP4"], "explicit pick C must mark C selected");
    await evaluate(connection, popupSession, `document.getElementById("lr-submit").click(); true`);
    await waitFor(async () => transferPosts().length >= 1, {
      timeoutMs: 15_000,
      label: "C transfer started",
    });
    await sleep(400);
    assert.equal(transferPosts().length, 1, "exactly one save must target C");
    const body = JSON.parse(transferPosts()[0].body || "{}");
    assert.ok(String(body.url || "").endsWith("movie-480p.mp4?t=1"),
      `the single transfer must target C (got "${body.url}")`);
    await waitFor(async () => {
      const value = await popupState();
      return value && value.toast.includes("已入库") ? value.toast : null;
    }, { timeoutMs: 20_000, label: "C save completion" });
    console.log("[browser-extension-runtime] retarget QA      : PASS (explicit pick survives refresh, vanished pick cleared, no silent retarget, pick C saves exactly C)");
  } finally {
    try {
      if (connection) {
        try {
          await connection.send("Browser.close");
        } catch (_) {
          // Browser may already be gone.
        }
      }
    } catch (_) {
      // Ignore teardown failures and continue cleaning up.
    }
    if (launched) await stopChromium(launched);
    await Promise.all([fake?.close?.(), pageServer?.close?.()]);
    await connection?.close?.();
  }
});
