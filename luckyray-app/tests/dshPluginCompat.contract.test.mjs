import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DSH_SURFACE_CLIENT_READY_TIMEOUT_MS,
  collectCoreProtectedEntryIds,
  createDshHostProtocol,
  createNativeSurfaceOwner,
  createPluginCompatService,
  OFFICIAL_PROFILE_BUNDLES,
  runBaselineSurfaceTrial,
  signCanonicalHostFrame,
} from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";
import {
  buildGuardPatch,
  computeCompositionCacheKey,
  parseBundlePatchEntries,
  parseProfileManifest,
  projectQuarantineSet,
  readCompatState,
  satisfiesRange,
  staticPluginVerdict,
  writeCompatState,
  writeGuardPatch,
} from "../src-tauri/dsh-host/luckyray-dsh-plugin-compat.mjs";

function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Minimal fake DSH web entry driven by a mode file in its cwd (surfaceHome). */
const FAKE_BIN = `
const fs = require("node:fs");
const mode = fs.readFileSync("fixture-mode", "utf8").trim();
function readAuthority() {
  let text = "";
  for (;;) {
    const chunk = Buffer.alloc(4096);
    let bytes;
    try { bytes = fs.readSync(3, chunk, 0, chunk.length); } catch { break; }
    if (bytes <= 0) break;
    text += chunk.toString("utf8", 0, bytes);
    if (text.includes("}")) break;
  }
  return JSON.parse(text.trim().split("\\n")[0] || "{}");
}
if (mode === "plugin-crash") {
  process.stderr.write("Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry better-sidebar (dsh-better-sidebar): The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'\\n");
  process.exit(1);
}
const authority = readAuthority();
const server = require("node:http").createServer(() => {});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync("fixture-child.pid", String(process.pid));
  const port = server.address().port;
  const ready = {
    type: "carrier-ready",
    generation: mode === "bad-handshake" ? authority.generation : authority.generation,
    port,
    bootstrapRef: mode === "bad-handshake" ? "0".repeat(64) : authority.bootstrapRef,
    bootstrapPath: authority.bootstrapPath,
  };
  fs.writeSync(4, JSON.stringify(ready) + "\\n");
  if (mode === "healthy") {
    setTimeout(() => {
      fs.writeSync(6, JSON.stringify({
        type: "surface-state", carrierGeneration: authority.generation, clientReady: true, sessionOpen: null,
      }) + "\\n");
    }, 40);
    const controlInput = require("node:readline").createInterface({
      input: fs.createReadStream(null, { fd: 5, encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    controlInput.on("line", (line) => {
      try {
        const command = JSON.parse(line);
        if (command.type === "binding-close" || command.type === "binding-open") {
          fs.writeSync(6, JSON.stringify({
            type: command.type + "-ack", seq: command.seq, outcome: "accepted",
          }) + "\\n");
        }
      } catch { /* control frames stay best-effort in the fixture */ }
    });
  }
  if (mode === "argv-record") {
    fs.writeFileSync("recorded-argv.json", JSON.stringify(process.argv.slice(2)));
  }
  setInterval(() => {}, 60000);
});
process.on("SIGTERM", () => process.exit(0));
`;

async function buildFakeRuntime() {
  const root = await tempDir("luckyray-compat-fake-runtime-");
  mkdirSync(join(root, "node"), { recursive: true });
  mkdirSync(join(root, "host", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  // Hardlinks into Program Files need privileges on this host; a per-fixture
  // copy of the test runner's own node binary keeps fixtures independent.
  const { copyFileSync } = await import("node:fs");
  copyFileSync(process.execPath, join(root, "node", "node.exe"));
  writeFileSync(join(root, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), FAKE_BIN);
  return root;
}

function ownerFor(runtimeRoot, stateRoot, surfaceHome, { onSurfaceLost, clientReadyTimeoutMs } = {}) {
  return createNativeSurfaceOwner({
    runtimeRoot,
    stateRoot,
    surfaceHome,
    surfacePatch: join(surfaceHome, "surface.patch.yml"),
    onUnexpectedExit: () => {},
    ...(onSurfaceLost ? { onSurfaceLost } : {}),
    ...(clientReadyTimeoutMs ? { clientReadyTimeoutMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// Group 1 — pure authority: guard patch, manifests, bundle patch entries.
// ---------------------------------------------------------------------------

test("guard patch disables quarantined entries, protects core ids, and official bundles never count as third-party", () => {
  assert.equal(buildGuardPatch(["better-sidebar"]).text, "- id: better-sidebar\n  disabled: true\n");
  assert.equal(buildGuardPatch([]).text, "");
  assert.equal(buildGuardPatch(["bad id", "ok-id", "ok-id"]).text, "- id: ok-id\n  disabled: true\n");
  const core = new Set(["system-prompt", "session-title-llm"]);
  const guarded = buildGuardPatch(["system-prompt", "better-sidebar"], core);
  assert.equal(guarded.text, "- id: better-sidebar\n  disabled: true\n");
  assert.deepEqual(guarded.skipped, ["system-prompt"]);
  assert.equal(OFFICIAL_PROFILE_BUNDLES.has("@deepseek-ai/dsh-base"), true);
  assert.equal(OFFICIAL_PROFILE_BUNDLES.has("dsh-better-sidebar"), false);
});

test("profile manifest parsing rejects malformed bundles but tolerates missing dependencies", () => {
  assert.deepEqual(
    parseProfileManifest('{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-better-sidebar"]}}}'),
    { bundles: ["@deepseek-ai/dsh-base", "dsh-better-sidebar"], dependencies: {} },
  );
  assert.throws(() => parseProfileManifest("{"), /plugin-compat-manifest-invalid/);
  assert.throws(() => parseProfileManifest('{"dsh":{"profile":{"bundles":"web"}}}'), /plugin-compat-manifest-invalid/);
});

test("bundle patch entry extraction maps package inserts to loader entry ids", () => {
  const entries = parseBundlePatchEntries(
    "# comment\n- insert:\n    - id: better-sidebar\n      name: 'dsh-better-sidebar'\n      config:\n        shell: /bin/zsh\n",
    "fallback",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entryId, "better-sidebar");
  assert.equal(entries[0].packageName, "dsh-better-sidebar");
  const fallback = parseBundlePatchEntries("nothing parseable", "fallback-pkg");
  assert.deepEqual(fallback, [{ entryId: "fallback-pkg", packageName: "fallback-pkg", resolved: false }]);
});

test("bundle patch extraction accepts flow-style inserts and never collects override rows", () => {
  const flow = parseBundlePatchEntries(
    "- insert: [{id: flow-plugin, name: flow-pkg}, {id: second-plugin}]\n",
    "fallback",
  );
  assert.deepEqual(flow.map((entry) => entry.entryId), ["flow-plugin", "second-plugin"]);
  assert.equal(flow[0].packageName, "flow-pkg");
  assert.equal(flow[1].packageName, "fallback", "unnamed flow entries fall back to the package scope");
  // Official-style override rows after an insert block must not be collected
  // as plugin entries: quarantining them would disable core functionality.
  const withOverrides = parseBundlePatchEntries(
    "- insert:\n    - id: better-sidebar\n      name: dsh-better-sidebar\n- id: session-title-llm\n  disabled: true\n",
    "fallback",
  );
  assert.deepEqual(withOverrides.map((entry) => entry.entryId), ["better-sidebar"]);
});

// ---------------------------------------------------------------------------
// Group 2 — semver authority incl. prerelease gating (no string compare).
// ---------------------------------------------------------------------------

test("semver satisfies implements npm prerelease gating and caret minor lock", () => {
  const cases = [
    ["0.1.5-rc.2", "^0.1.0", false],
    ["0.1.5-rc.2", "0.1.5-rc.2", true],
    ["0.1.5-rc.2", ">=0.1.5-rc.0 <0.1.6", true],
    ["0.1.5-rc.1", ">=0.1.5-rc.2", false],
    ["0.2.0", "^0.1.0", false],
    ["0.1.9", "^0.1.0", true],
    ["1.9.3", ">=1.9.0", true],
    ["not-a-version", "^1.0.0", null],
  ];
  for (const [version, range, expected] of cases) {
    assert.equal(satisfiesRange(version, range), expected, `${version} vs ${range}`);
  }
});

// ---------------------------------------------------------------------------
// Group 3 — static verdict reproduces the v1.9.3 incident class without
// executing any third-party code (synthetic regression fixture).
// ---------------------------------------------------------------------------

test("static verdict flags the removed settingsNamespace import as plugin-import failure", async () => {
  const runtimeRoot = await tempDir("luckyray-compat-rt-");
  const settingsDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh-settings");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-settings", version: "0.1.5-rc.2", main: "lib/index.js" }));
  mkdirSync(join(settingsDir, "lib"), { recursive: true });
  writeFileSync(join(settingsDir, "lib", "index.js"), "export const SettingsConflictError = class {};\nexport default null;\n");
  const pluginDir = await tempDir("luckyray-compat-plugin-");
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "fixture-old-plugin", version: "0.16.1", main: "lib/index.js" }));
  mkdirSync(join(pluginDir, "lib"), { recursive: true });
  writeFileSync(join(pluginDir, "lib", "index.js"), "import { SettingsConflictError, settingsNamespace } from \"@deepseek-ai/dsh-settings\";\nexport const value = settingsNamespace;\n");
  const verdict = await staticPluginVerdict({ plugin: { entryId: "fixture", packageName: "fixture-old-plugin", packageDir: pluginDir }, runtimeRoot });
  assert.equal(verdict.outcome, "fail");
  assert.ok(verdict.findings.some((finding) => finding.kind === "import-missing" && finding.name === "settingsNamespace"));
  const compatiblePluginDir = await tempDir("luckyray-compat-plugin2-");
  writeFileSync(join(compatiblePluginDir, "package.json"), JSON.stringify({ name: "fixture-ok", version: "1.0.0", main: "lib/index.js" }));
  mkdirSync(join(compatiblePluginDir, "lib"), { recursive: true });
  writeFileSync(join(compatiblePluginDir, "lib", "index.js"), "import { SettingsConflictError } from \"@deepseek-ai/dsh-settings\";\nexport const value = SettingsConflictError;\n");
  const ok = await staticPluginVerdict({ plugin: { entryId: "ok", packageName: "fixture-ok", packageDir: compatiblePluginDir }, runtimeRoot });
  assert.equal(ok.outcome, "pass");
});

// ---------------------------------------------------------------------------
// Group 4 — composition cache key: exact, code-sensitive, guard-sensitive.
// ---------------------------------------------------------------------------

test("composition cache key changes on plugin bytes, manifest, guard, and checker input", () => {
  const base = {
    runtimeDigest: "a".repeat(64),
    plugins: [{ packageName: "p", entryId: "e", version: "1.0.0", digest: "b".repeat(64) }],
    manifestText: "{}",
    guardEntryIds: [],
  };
  const key = computeCompositionCacheKey(base);
  assert.equal(key, computeCompositionCacheKey({ ...base }));
  assert.notEqual(key, computeCompositionCacheKey({ ...base, plugins: [{ packageName: "p", entryId: "e", version: "1.0.0", digest: "c".repeat(64) }] }), "same-version source edit must invalidate");
  assert.notEqual(key, computeCompositionCacheKey({ ...base, manifestText: '{"x":1}' }));
  assert.notEqual(key, computeCompositionCacheKey({ ...base, guardEntryIds: ["e"] }));
  assert.notEqual(key, computeCompositionCacheKey({ ...base, runtimeDigest: "d".repeat(64) }));
});

// ---------------------------------------------------------------------------
// Group 5 — host-owned state: atomic write, corruption recovery, quarantine
// projection intersected with the live manifest.
// ---------------------------------------------------------------------------

test("compat state recovers from corruption and quarantine set stays manifest-bound", async () => {
  const stateRoot = await tempDir("luckyray-compat-state-");
  const written = await writeCompatState(stateRoot, {
    plugins: [
      { entryId: "gone", packageName: "removed-plugin", outcome: "fail", quarantined: true },
      { entryId: "better-sidebar", packageName: "dsh-better-sidebar", outcome: "fail", quarantined: true },
      { entryId: "dependency-entry", packageName: "mounted-dependency", outcome: "unknown", quarantined: true },
    ],
  });
  assert.equal(written.plugins.length, 3);
  writeFileSync(join(stateRoot, "luckyray-plugin-compat-v1.json"), "{corrupt");
  const recovered = await readCompatState(stateRoot);
  assert.deepEqual(recovered.plugins, []);
  assert.equal(recovered.recovered, true);
  const livePlugins = [
    { entryId: "better-sidebar", packageName: "dsh-better-sidebar", resolved: true },
    // A bundle mounting ANOTHER package's loader keeps that record live.
    { entryId: "dependency-entry", packageName: "mounted-dependency", resolved: true },
  ];
  const guard = await writeGuardPatch(stateRoot, projectQuarantineSet(written, livePlugins));
  assert.equal(guard.guardPath !== null, true);
  assert.equal(
    readFileSync(guard.guardPath, "utf8"),
    "- id: better-sidebar\n  disabled: true\n- id: dependency-entry\n  disabled: true\n",
  );
});

// ---------------------------------------------------------------------------
// Group 6 — frame protocol: compat round-trips ride the authenticated
// envelope; malformed frames are rejected before dispatch.
// ---------------------------------------------------------------------------

test("compat frames round-trip through the authenticated host protocol and reject unknown fields", async () => {
  const output = [];
  const calls = [];
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
    nativeSurface: { open: async () => ({}), close: async () => ({}) },
    pluginCompat: {
      status: async () => ({ plugins: [{ entryId: "e", packageName: "p", outcome: "fail", quarantined: false }] }),
      check: async (request) => ({ checked: true, request }),
      apply: async (request) => ({ applied: true, request }),
    },
  });
  const challenge = "c".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 7, challenge }));
  const payload = Buffer.from(JSON.stringify({ kind: "compatible" }), "utf8").toString("base64url");
  for (const [seq, type, framePayload] of [[1, "compat-status", undefined], [2, "compat-check", payload], [3, "compat-apply", payload]]) {
    const frame = { type, protocol: 1, generation: 7, seq, requestId: `${type}-${seq}`, ...(framePayload ? { payload: framePayload } : {}) };
    await host.accept(JSON.stringify({ ...frame, mac: signCanonicalHostFrame(challenge, "parent", frame) }));
  }
  assert.deepEqual(output.slice(1).map((frame) => frame.type), ["compat-status-result", "compat-check-result", "compat-apply-result"]);
  const decoded = JSON.parse(Buffer.from(output[3].payload, "base64url").toString("utf8"));
  assert.deepEqual(decoded.request, { kind: "compatible" });
  const badFrame = { type: "compat-apply", protocol: 1, generation: 7, seq: 4, requestId: "bad", payload, extra: "field" };
  await assert.rejects(
    () => host.accept(JSON.stringify({ ...badFrame, mac: signCanonicalHostFrame(challenge, "parent", badFrame) })),
    /dsh-host-frame-invalid/,
  );
  const noService = createDshHostProtocol({
    writeFrame: () => {},
    nativeProbe: async () => ({}),
    nativeSurface: { open: async () => ({}), close: async () => ({}) },
  });
  await noService.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 1, challenge }));
  await assert.rejects(
    () => noService.accept(JSON.stringify({ type: "compat-status", protocol: 1, generation: 1, seq: 1, requestId: "x", mac: "0".repeat(64) })),
    /dsh-host-frame-invalid/,
  );
});

// ---------------------------------------------------------------------------
// Group 7 — the real startup chain against a fake DSH web entry: early exit,
// handshake rejection, post-ready freeze watchdog, healthy lifecycle, and
// guard overlay injection. These call the production owner directly.
// ---------------------------------------------------------------------------

test("surface owner reclaims a pre-ready plugin crash and reports a classified failure", async () => {
  const runtimeRoot = await buildFakeRuntime();
  const surfaceHome = await tempDir("luckyray-compat-home-");
  const stateRoot = await tempDir("luckyray-compat-state2-");
  writeFileSync(join(surfaceHome, "fixture-mode"), "plugin-crash");
  const owner = ownerFor(runtimeRoot, stateRoot, surfaceHome);
  const result = await owner.open();
  assert.equal(result.stage, "surface-failed");
  assert.equal(result.reason, "plugin-surface-plugin-import");
  assert.match(JSON.stringify(result.diagnostic), /better-sidebar|dsh-settings/);
  await owner.shutdown();
});

test("surface owner rejects a forged handshake and still reclaims the child", async () => {
  const runtimeRoot = await buildFakeRuntime();
  const surfaceHome = await tempDir("luckyray-compat-home-");
  const stateRoot = await tempDir("luckyray-compat-state3-");
  writeFileSync(join(surfaceHome, "fixture-mode"), "bad-handshake");
  const owner = ownerFor(runtimeRoot, stateRoot, surfaceHome);
  const result = await owner.open();
  assert.equal(result.stage, "surface-failed");
  assert.equal(result.outcome, "surface-handshake-invalid");
  await owner.shutdown();
});

test("post-ready freeze triggers the client-ready watchdog and reports surface loss", async () => {
  const runtimeRoot = await buildFakeRuntime();
  const surfaceHome = await tempDir("luckyray-compat-home-");
  const stateRoot = await tempDir("luckyray-compat-state4-");
  writeFileSync(join(surfaceHome, "fixture-mode"), "freeze-after-ready");
  let surfaceLost = null;
  const owner = ownerFor(runtimeRoot, stateRoot, surfaceHome, {
    onSurfaceLost: (reason) => { surfaceLost = reason; },
    clientReadyTimeoutMs: 350,
  });
  const result = await owner.open();
  assert.equal(result.stage, "surface-ready", "carrier handshake still succeeds first");
  const deadline = Date.now() + 8000;
  while (surfaceLost === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(surfaceLost, "surface-client-stuck");
  await owner.shutdown();
});

test("healthy surface reaches ready, disarms the watchdog via client-ready, and closes cleanly", async () => {
  const runtimeRoot = await buildFakeRuntime();
  const surfaceHome = await tempDir("luckyray-compat-home-");
  const stateRoot = await tempDir("luckyray-compat-state5-");
  writeFileSync(join(surfaceHome, "fixture-mode"), "healthy");
  let surfaceLost = null;
  const owner = ownerFor(runtimeRoot, stateRoot, surfaceHome, {
    onSurfaceLost: (reason) => { surfaceLost = reason; },
    clientReadyTimeoutMs: 2_000,
  });
  const opened = await owner.open();
  assert.equal(opened.stage, "surface-ready");
  assert.ok(opened.port > 0);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(surfaceLost, null, "client-ready must disarm the watchdog");
  const closed = await owner.close();
  assert.equal(closed.stage, "surface-closed");
  await owner.shutdown();
  assert.equal(surfaceLost, null);
});

test("quarantine guard file is injected as an extra --patch overlay after the surface patch", async () => {
  const runtimeRoot = await buildFakeRuntime();
  const surfaceHome = await tempDir("luckyray-compat-home-");
  const stateRoot = await tempDir("luckyray-compat-state6-");
  writeFileSync(join(surfaceHome, "fixture-mode"), "argv-record");
  writeFileSync(join(surfaceHome, "surface.patch.yml"), "[]\n");
  // Without a guard: single official patch only.
  const plain = ownerFor(runtimeRoot, stateRoot, surfaceHome);
  await plain.open();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const plainArgs = JSON.parse(readFileSync(join(surfaceHome, "recorded-argv.json"), "utf8"));
  assert.deepEqual(plainArgs.filter((arg) => arg === "--patch").length, 1);
  await plain.shutdown();
  rmSync(join(surfaceHome, "recorded-argv.json"));
  // With a quarantined entry: the guard overlay rides along as the LAST
  // patch — CLI overlays apply after every bundle/user layer.
  await writeGuardPatch(stateRoot, ["better-sidebar"]);
  const guarded = ownerFor(runtimeRoot, stateRoot, surfaceHome);
  await guarded.open();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const guardedArgs = JSON.parse(readFileSync(join(surfaceHome, "recorded-argv.json"), "utf8"));
  const patchFlags = guardedArgs.filter((arg) => arg === "--patch").length;
  assert.equal(patchFlags, 2, "guard overlay must be applied at spawn time");
  const guardPath = join(stateRoot, "luckyray-plugin-compat-guard.patch.yml");
  assert.ok(guardedArgs.includes(guardPath));
  const surfacePatchIndex = guardedArgs.indexOf(join(surfaceHome, "surface.patch.yml"));
  const guardIndex = guardedArgs.indexOf(guardPath);
  assert.ok(surfacePatchIndex > 0 && guardIndex > surfacePatchIndex, "guard must overlay after the surface patch");
  await guarded.shutdown();
});

// ---------------------------------------------------------------------------
// Group 8 — the compatibility service against a synthetic user profile:
// status -> static check (fail) -> compatible apply writes guard -> restore
// removes it -> bundle reconciliation keeps the guard manifest-bound.
// ---------------------------------------------------------------------------

async function buildProfileFixture() {
  const surfaceHome = await tempDir("luckyray-compat-profile-home-");
  const profileRoot = join(surfaceHome, "profiles", "web");
  mkdirSync(join(profileRoot, "node_modules", "fixture-old-plugin", "lib"), { recursive: true });
  writeFileSync(join(profileRoot, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dependencies: { "fixture-old-plugin": "^0.16.0" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "fixture-old-plugin"] } },
  }, null, 2));
  writeFileSync(join(profileRoot, "node_modules", "fixture-old-plugin", "package.json"), JSON.stringify({ name: "fixture-old-plugin", version: "0.16.1", main: "lib/index.js" }));
  writeFileSync(join(profileRoot, "node_modules", "fixture-old-plugin", "lib", "index.js"), "import { settingsNamespace } from \"@deepseek-ai/dsh-settings\";\nexport const x = settingsNamespace;\n");
  writeFileSync(join(profileRoot, "node_modules", "fixture-old-plugin", "cordis.patch.yml"), "- insert:\n    - id: old-fixture\n      name: fixture-old-plugin\n");
  const runtimeRoot = await tempDir("luckyray-compat-rt2-");
  const settingsDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh-settings");
  mkdirSync(join(settingsDir, "lib"), { recursive: true });
  writeFileSync(join(settingsDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-settings", version: "0.1.5-rc.2", main: "lib/index.js" }));
  writeFileSync(join(settingsDir, "lib", "index.js"), "export const SettingsConflictError = 1;\n");
  const dshDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(dshDir, { recursive: true });
  writeFileSync(join(dshDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.2" }));
  return { surfaceHome, runtimeRoot };
}

test("compat service: static fail quarantines via compatible mode and restore reopens the loader entry", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-compat-state7-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const status = await service.status();
  assert.equal(status.plugins.length, 1);
  assert.equal(status.plugins[0].entryId, "old-fixture");
  assert.equal(status.plugins[0].outcome, "unchecked");
  const check = await service.check({ baseline: false });
  assert.equal(check.checked, true);
  assert.equal(check.plugins[0].outcome, "fail");
  assert.match(check.plugins[0].reason, /import-missing/);
  assert.equal(check.plugins[0].quarantined, false, "check reports, it does not quarantine");
  assert.equal(check.dynamicTrial, "environment-limited");
  // Exact-composition cache: an unchanged composition reuses the recorded
  // verdicts; a same-version entry-byte edit invalidates the key.
  const cached = await service.check({ baseline: false });
  assert.equal(cached.cached, true, JSON.stringify(cached));
  assert.equal(cached.plugins[0].outcome, "fail");
  const entryFile = join(surfaceHome, "profiles", "web", "node_modules", "fixture-old-plugin", "lib", "index.js");
  writeFileSync(entryFile, readFileSync(entryFile, "utf8") + "\n// same-version byte edit\n");
  const invalidated = await service.check({ baseline: false });
  assert.notEqual(invalidated.cached, true, "entry byte edit must force a rescan");
  assert.equal(invalidated.plugins[0].outcome, "fail");
  const applied = await service.apply({ kind: "compatible" });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.quarantineSet, ["old-fixture"]);
  assert.equal(existsSync(join(stateRoot, "luckyray-plugin-compat-guard.patch.yml")), true);
  // Reconciliation: removing the bundle from the live manifest drops it from
  // the effective guard set even though the record stays quarantined.
  const restored = await service.apply({ kind: "restore", entryId: "old-fixture" });
  assert.equal(restored.applied, true);
  assert.deepEqual(restored.quarantineSet, []);
  assert.equal(existsSync(join(stateRoot, "luckyray-plugin-compat-guard.patch.yml")), false);
  const invalid = await service.apply({ kind: "bogus" });
  assert.equal(invalid.applied, false);
});

test("compat service: require()-based plugins read unknown, never pass", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-compat-state9-");
  const entryFile = join(surfaceHome, "profiles", "web", "node_modules", "fixture-old-plugin", "lib", "index.js");
  writeFileSync(entryFile, 'const { settingsNamespace } = require("@deepseek-ai/dsh-settings");\nmodule.exports = { settingsNamespace };\n');
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const check = await service.check({ baseline: false });
  assert.equal(check.checked, true);
  assert.equal(check.plugins[0].outcome, "unknown", "non-static module loading must read unverified");
  assert.ok(check.plugins[0].reason?.includes("scan-limited"));
});

test("baseline trial proves the official boot path against the real pinned runtime", {
  skip: process.env.DSH_TEST_RUNTIME_ROOT ? false : "requires the verified DSH-0 runtime fixture",
}, async () => {
  const result = await runBaselineSurfaceTrial({ runtimeRoot: process.env.DSH_TEST_RUNTIME_ROOT });
  assert.equal(result.outcome, "pass", JSON.stringify(result));
  assert.ok(result.port > 0);
});

test("exported watchdog default stays above the slowest observed official cold start", () => {
  assert.ok(DSH_SURFACE_CLIENT_READY_TIMEOUT_MS >= 90_000);
});

// ---------------------------------------------------------------------------
// Group 9 — no ambient authority leakage from the compat module surface.
// ---------------------------------------------------------------------------

test("compat module keeps the production boundary: no eval, no dynamic import of plugin code", async () => {
  const source = readFileSync(new URL("../src-tauri/dsh-host/luckyray-dsh-plugin-compat.mjs", import.meta.url), "utf8");
  assert.match(source, /Nothing here executes third-party code/u);
  assert.equal(/eval\(|new Function\(|await import\(/u.test(source), false, "static layer must not execute plugin code");
});

test("owner shutdown verifiably reclaims the owned child process tree", async () => {
  const runtimeRoot = await buildFakeRuntime();
  const surfaceHome = await tempDir("luckyray-compat-home-");
  const stateRoot = await tempDir("luckyray-compat-state8-");
  writeFileSync(join(surfaceHome, "fixture-mode"), "healthy");
  const owner = ownerFor(runtimeRoot, stateRoot, surfaceHome, { clientReadyTimeoutMs: 60_000 });
  const opened = await owner.open();
  assert.equal(opened.stage, "surface-ready");
  // The fixture records its own pid; after shutdown, the OS must confirm the
  // process is gone — a real reclamation check, not a directory listing.
  const childPidFile = join(surfaceHome, "fixture-child.pid");
  assert.ok(existsSync(childPidFile), "fixture must record its pid");
  const childPid = Number(readFileSync(childPidFile, "utf8").trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  await owner.shutdown();
  const deadline = Date.now() + 8000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, "owned dsh web child must be verifiably exited after shutdown");
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(surfaceHome, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLOSE-R1 groups A–E: the real recovery paths the first round skipped.
// ---------------------------------------------------------------------------

test("A: first failure, NO prior check — compatible apply still builds the plan from the live composition", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-close-a1-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  // No check() call first: the state file does not even exist yet.
  assert.equal(existsSync(join(stateRoot, "luckyray-plugin-compat-v1.json")), false);
  const applied = await service.apply({ kind: "compatible" });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.quarantineSet, ["old-fixture"], JSON.stringify(applied));
  assert.equal(applied.guardActive, true);
  assert.equal(
    readFileSync(join(stateRoot, "luckyray-plugin-compat-guard.patch.yml"), "utf8"),
    "- id: old-fixture\n  disabled: true\n",
  );
  const status = await service.status();
  assert.equal(status.plugins[0].outcome, "fail");
  assert.equal(status.plugins[0].quarantined, true);
});

test("A: pre-load gate quarantines a statically failing plugin before the loader ever imports it", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-close-a2-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const plan = await service.ensureLoadPlan();
  assert.equal(plan.planValid, true);
  assert.deepEqual(plan.quarantinedNow, ["old-fixture"]);
  assert.equal(plan.guardActive, true);
  const again = await service.ensureLoadPlan();
  assert.deepEqual(again.quarantinedNow, []);
});

test("A: baseline compatibility also suspends statically-passing plugins, and a still-bad restore is re-quarantined by the gate", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-close-a3-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const entryFile = join(surfaceHome, "profiles", "web", "node_modules", "fixture-old-plugin", "lib", "index.js");
  writeFileSync(entryFile, "const value = 1;\nexport const ok = value;\n");
  const applied = await service.apply({ kind: "compatible" });
  assert.deepEqual(applied.quarantineSet, ["old-fixture"], "a passing plugin is still suspended in baseline compatibility");
  const restored = await service.apply({ kind: "restore", entryId: "old-fixture" });
  assert.equal(restored.applied, true);
  assert.deepEqual(restored.quarantineSet, []);
  writeFileSync(entryFile, 'import { settingsNamespace } from "@deepseek-ai/dsh-settings";\nexport const x = settingsNamespace;\n');
  const plan = await service.ensureLoadPlan();
  assert.deepEqual(plan.quarantinedNow, ["old-fixture"], "a restored plugin whose bytes are bad again must not reload");
});

test("A: auto recovery uses the verifiable attribution when present, baseline compatibility otherwise", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-close-a4-");
  const probe = { diagnostic: null };
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome, failureProbe: probe });
  probe.diagnostic = { kind: "plugin-import", entry: "old-fixture" };
  const attributed = await service.apply({ kind: "auto" });
  assert.deepEqual(attributed.quarantineSet, ["old-fixture"]);
  await service.apply({ kind: "normal" });
  probe.diagnostic = null;
  const unattributed = await service.apply({ kind: "auto" });
  assert.deepEqual(unattributed.quarantineSet, ["old-fixture"], "no attribution falls back to baseline compatibility");
});

test("B: multi-line flow inserts, custom patch paths, and profile-layer mounts all resolve real entry ids", async () => {
  const flow = parseBundlePatchEntries("- insert: [\n    {id: multi-flow, name: multi-pkg},\n    {id: second-flow}\n  ]\n", "fallback");
  assert.deepEqual(flow.map((entry) => [entry.entryId, entry.resolved]), [["multi-flow", true], ["second-flow", true]]);
  assert.equal(flow[0].packageName, "multi-pkg");

  const surfaceHome = await tempDir("luckyray-close-b1-");
  const profileRoot = join(surfaceHome, "profiles", "web");
  mkdirSync(join(profileRoot, "node_modules", "custom-plugin", "lib"), { recursive: true });
  writeFileSync(join(profileRoot, "package.json"), JSON.stringify({
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "custom-plugin"] } },
  }));
  const customDir = join(profileRoot, "node_modules", "custom-plugin");
  writeFileSync(join(customDir, "package.json"), JSON.stringify({
    name: "custom-plugin", version: "1.0.0", main: "lib/index.js",
    dsh: { bundle: { patch: "./patch/custom-mount.yml" } },
  }));
  mkdirSync(join(customDir, "patch"), { recursive: true });
  writeFileSync(join(customDir, "patch", "custom-mount.yml"), "- insert:\n    - id: custom-entry\n      name: custom-plugin\n");
  writeFileSync(join(customDir, "lib", "index.js"), "export const ok = 1;\n");
  const depDir = join(profileRoot, "node_modules", "patch-mounted-dep");
  mkdirSync(join(depDir, "lib"), { recursive: true });
  writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: "patch-mounted-dep", version: "0.9.0", main: "lib/index.js" }));
  writeFileSync(join(depDir, "lib", "index.js"), "export const ok = 2;\n");
  writeFileSync(join(profileRoot, "cordis.patch.yml"), "- insert:\n    - id: dep-entry\n      name: patch-mounted-dep\n");

  const runtimeRoot = await tempDir("luckyray-close-b1-rt-");
  const stateRoot = await tempDir("luckyray-close-b1-st-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const status = await service.status();
  const byEntry = new Map(status.plugins.map((plugin) => [plugin.entryId, plugin]));
  assert.equal(byEntry.get("custom-entry")?.packageName, "custom-plugin", "custom patch path is inventoried");
  assert.equal(byEntry.get("dep-entry")?.packageName, "patch-mounted-dep", "profile-layer mounts are inventoried");
  assert.equal(status.plugins.every((plugin) => plugin.resolved), true);
  const applied = await service.apply({ kind: "quarantine", entryIds: ["custom-entry", "dep-entry"] });
  assert.deepEqual(applied.quarantineSet, ["custom-entry", "dep-entry"]);
});

test("B: core protected ids are gathered from the official bundles and refused by the guard", async () => {
  const runtimeRoot = await tempDir("luckyray-close-b2-rt-");
  const baseDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh-base");
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, "cordis.patch.yml"), "- id: system-prompt\n  config: {}\n- id: approval-gate\n  config: {}\n");
  const protectedIds = await collectCoreProtectedEntryIds(runtimeRoot);
  assert.equal(protectedIds.has("system-prompt"), true);
  assert.equal(protectedIds.has("approval-gate"), true);
  const stateRoot = await tempDir("luckyray-close-b2-st-");
  const guard = await writeGuardPatch(stateRoot, ["approval-gate", "safe-entry"], protectedIds);
  assert.deepEqual(guard.entryIds, ["safe-entry"]);
  assert.deepEqual(guard.skippedEntryIds, ["approval-gate"]);
});

test("C: missing import packages block, unreadable entries read unknown, and relative submodules are scanned", async () => {
  const runtimeRoot = await tempDir("luckyray-close-c1-rt-");
  const settingsDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh-settings");
  mkdirSync(join(settingsDir, "lib"), { recursive: true });
  writeFileSync(join(settingsDir, "package.json"), JSON.stringify({ version: "0.1.5-rc.2", main: "lib/index.js" }));
  writeFileSync(join(settingsDir, "lib", "index.js"), "export const SettingsConflictError = 1;\n");

  const missingPkg = await tempDir("luckyray-close-c1-a-");
  mkdirSync(join(missingPkg, "lib"), { recursive: true });
  writeFileSync(join(missingPkg, "package.json"), JSON.stringify({ name: "p1", version: "1.0.0", main: "lib/index.js" }));
  writeFileSync(join(missingPkg, "lib", "index.js"), 'import { anything } from "@deepseek-ai/dsh-absent";\nexport const x = anything;\n');
  const missing = await staticPluginVerdict({ plugin: { packageDir: missingPkg }, runtimeRoot });
  assert.equal(missing.outcome, "fail");
  assert.match(missing.reason, /import-package-missing/);

  const unreadable = await tempDir("luckyray-close-c1-b-");
  mkdirSync(join(unreadable, "lib"), { recursive: true });
  writeFileSync(join(unreadable, "package.json"), JSON.stringify({ name: "p2", version: "1.0.0", main: "lib/index.js" }));
  const unread = await staticPluginVerdict({ plugin: { packageDir: unreadable }, runtimeRoot });
  assert.equal(unread.outcome, "unknown");
  assert.match(unread.reason, /scan-limited|entry/);

  const nested = await tempDir("luckyray-close-c1-c-");
  mkdirSync(join(nested, "lib"), { recursive: true });
  writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "p3", version: "1.0.0", main: "lib/index.js" }));
  writeFileSync(join(nested, "lib", "index.js"), 'import "./sub.js";\nexport const x = 1;\n');
  writeFileSync(join(nested, "lib", "sub.js"), 'import { settingsNamespace } from "@deepseek-ai/dsh-settings";\nexport const y = settingsNamespace;\n');
  const nestedVerdict = await staticPluginVerdict({ plugin: { packageDir: nested }, runtimeRoot });
  assert.equal(nestedVerdict.outcome, "fail", JSON.stringify(nestedVerdict.findings));
  assert.ok(nestedVerdict.findings.some((finding) => finding.kind === "import-missing" && finding.name === "settingsNamespace"));
});

test("C: semver prerelease identifiers compare numerically and tilde upper bounds are exact", () => {
  assert.equal(satisfiesRange("0.1.5-rc.10", ">=0.1.5-rc.2"), true, "rc.10 > rc.2 numerically");
  assert.equal(satisfiesRange("0.1.5-rc.2", ">=0.1.5-rc.10"), false);
  assert.equal(satisfiesRange("1.3.1", "~1.2.3"), false, "1.3.1 exceeds the 1.3.0 tilde ceiling");
  assert.equal(satisfiesRange("1.2.9", "~1.2.3"), true);
});

test("C: a stale digest never projects an old verdict onto new bytes", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-close-c2-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  await service.check({});
  const entryFile = join(surfaceHome, "profiles", "web", "node_modules", "fixture-old-plugin", "lib", "index.js");
  writeFileSync(entryFile, "// benign replacement\nexport const x = 1;\n");
  const status = await service.status();
  assert.equal(status.plugins[0].outcome, "unchecked", "changed bytes must not reuse the recorded fail");
  const next = await service.check({});
  assert.equal(next.cached, undefined);
  assert.equal(next.plugins[0].outcome, "pass");
});

test("D: a frozen surface's grandchildren are verifiably reclaimed with the tree kill", async () => {
  const runtimeRoot = await tempDir("luckyray-close-d1-rt-");
  mkdirSync(join(runtimeRoot, "node"), { recursive: true });
  mkdirSync(join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  const { copyFileSync } = await import("node:fs");
  copyFileSync(process.execPath, join(runtimeRoot, "node", "node.exe"));
  const grandchildFixture = [
    'const fs = require("node:fs");',
    'function readAuthority() {',
    '  let text = "";',
    '  for (;;) {',
    '    const chunk = Buffer.alloc(4096);',
    '    let bytes;',
    '    try { bytes = fs.readSync(3, chunk, 0, chunk.length); } catch { break; }',
    '    if (bytes <= 0) break;',
    '    text += chunk.toString("utf8", 0, bytes);',
    '    if (text.includes("}")) break;',
    '  }',
    '  return JSON.parse(text.trim().split("\\n")[0] || "{}");',
    '}',
    'const authority = readAuthority();',
    'fs.writeFileSync("fixture-child.pid", String(process.pid));',
    'const spawn = require("node:child_process").spawn;',
    'const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000); process.on(\'SIGTERM\', () => process.exit(0));"], { stdio: "ignore" });',
    'fs.writeFileSync("fixture-grandchild.pid", String(grand.pid));',
    'const server = require("node:http").createServer(() => {});',
    'server.listen(0, "127.0.0.1", () => {',
    '  fs.writeSync(4, JSON.stringify({ type: "carrier-ready", generation: authority.generation, port: server.address().port, bootstrapRef: authority.bootstrapRef, bootstrapPath: authority.bootstrapPath }) + "\\n");',
    '  fs.writeFileSync("fixture-ready", "1");',
    '});',
    'setInterval(() => {}, 60000);',
    'process.on("SIGTERM", () => process.exit(0));',
    "",
  ].join("\n");
  writeFileSync(join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), grandchildFixture);
  const surfaceHome = await tempDir("luckyray-close-d1-home-");
  const stateRoot = await tempDir("luckyray-close-d1-st-");
  const owner = ownerFor(runtimeRoot, stateRoot, surfaceHome, { clientReadyTimeoutMs: 120_000 });
  const opened = await owner.open();
  assert.equal(opened.stage, "surface-ready");
  const readyFile = join(surfaceHome, "fixture-ready");
  const readyDeadline = Date.now() + 10_000;
  while (!existsSync(readyFile) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(readyFile), "fixture must be serving");
  const childPid = Number(readFileSync(join(surfaceHome, "fixture-child.pid"), "utf8").trim());
  const grandPid = Number(readFileSync(join(surfaceHome, "fixture-grandchild.pid"), "utf8").trim());
  await owner.shutdown();
  const waitGone = async (pid) => {
    const limit = Date.now() + 8_000;
    while (Date.now() < limit) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch {
        return true;
      }
    }
    return false;
  };
  assert.equal(await waitGone(childPid), true, "direct child reclaimed");
  assert.equal(await waitGone(grandPid), true, "grandchild reclaimed with the tree kill");
});

test("D: a stale watchdog callback cannot fail a newer generation", async () => {
  const runtimeRoot = await buildFakeRuntime();
  const surfaceHome = await tempDir("luckyray-close-d2-home-");
  const stateRoot = await tempDir("luckyray-close-d2-st-");
  writeFileSync(join(surfaceHome, "fixture-mode"), "healthy");
  const losses = [];
  const owner = ownerFor(runtimeRoot, stateRoot, surfaceHome, {
    onSurfaceLost: (reason) => losses.push(reason),
    clientReadyTimeoutMs: 400,
  });
  const first = await owner.open();
  assert.equal(first.stage, "surface-ready");
  await owner.close();
  const second = await owner.open();
  assert.equal(second.stage, "surface-ready");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.deepEqual(losses, [], "no stale watchdog loss may leak across generations");
  await owner.shutdown();
});

test("E: compat commands run off the UI thread and failed results never read as success", async () => {
  const libSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(libSource, /async fn dsh_plugin_compat_status[\s\S]*?spawn_blocking/u);
  assert.match(libSource, /async fn dsh_plugin_compat_check[\s\S]*?spawn_blocking/u);
  assert.match(libSource, /async fn dsh_plugin_compat_apply[\s\S]*?spawn_blocking/u);
  const pageSource = readFileSync(new URL("../src/features/ai/DshNativeSurfacePage.tsx", import.meta.url), "utf8");
  assert.match(pageSource, /dshPluginCompatActionFailure\(result\)/u, "structured failures must gate reopen");
  const clientSource = readFileSync(new URL("../src/core/services/dshPluginCompat.ts", import.meta.url), "utf8");
  assert.match(clientSource, /row\.failed === true \|\| row\.applied === false \|\| row\.checked === false/u,
    "failed, unapplied, and unchecked control results must all fail closed");
  assert.match(clientSource, /row\.applied !== true && row\.checked !== true/u,
    "ambiguous control results must not reopen");
  assert.match(pageSource, /watchDshNativeSurfaceFailure\(/u, "the page subscribes to service-owned failure recovery");
  const surfaceSource = readFileSync(new URL("../src/core/services/dshNativeSurface.ts", import.meta.url), "utf8");
  assert.match(surfaceSource, /await compat\.reclaimFailedSurface\(\)/u, "the frozen native child is retired by the service so the panel is reachable");
  const settingsSource = readFileSync(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(settingsSource, /DshPluginCompatSettingsCard/u, "a persistent host-side entry exists outside the error panel");
  // Pin the production auto-recovery wiring so it cannot silently regress to
  // the all-or-nothing path again.
  const rustSource = readFileSync(new URL("../src-tauri/src/dsh_host.rs", import.meta.url), "utf8");
  assert.match(rustSource, /"compatible", "auto", "quarantine", "restore"/u, "the apply whitelist admits auto");
  assert.match(rustSource, /json!\(\{ "kind": "auto" \}\)/u, "the automatic retry requests attributed recovery");
});

test("C: a runtime-generation change invalidates recorded verdicts even after UI check/apply writes", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-close-c3-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  // check() writes the state — the generation marker must survive it.
  await service.check({});
  const afterCheck = JSON.parse(readFileSync(join(stateRoot, "luckyray-plugin-compat-v1.json"), "utf8"));
  assert.match(afterCheck.runtimeDigest, /^[0-9a-f]{64}$/u, "check() persists the runtime generation");
  // apply() writes the state too — the marker must survive that as well.
  await service.apply({ kind: "normal" });
  const afterApply = JSON.parse(readFileSync(join(stateRoot, "luckyray-plugin-compat-v1.json"), "utf8"));
  assert.match(afterApply.runtimeDigest ?? "", /^[0-9a-f]{64}$/u, "apply() keeps the runtime generation");
  // With the marker intact, a changed runtime forces a full re-verdict on
  // the load path (simulated by hand-editing the marker to a foreign value).
  afterApply.runtimeDigest = "f".repeat(64);
  writeFileSync(join(stateRoot, "luckyray-plugin-compat-v1.json"), JSON.stringify(afterApply));
  const plan = await service.ensureLoadPlan();
  assert.deepEqual(plan.quarantinedNow, ["old-fixture"], "a foreign generation forces re-verdict and re-quarantine");
});

test("inventory distinguishes disabled dependency and historical quarantine from active loaders", async () => {
  const { surfaceHome, runtimeRoot } = await buildProfileFixture();
  const stateRoot = await tempDir("luckyray-inventory-state-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  await service.apply({ kind: "compatible" });
  const manifestPath = join(surfaceHome, "profiles", "web", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== "fixture-old-plugin");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = readFileSync(manifestPath, "utf8");
  const status = await service.status();
  assert.equal(status.runtimeVersion, "0.1.5-rc.2");
  assert.equal(status.plugins.length, 0);
  assert.deepEqual(status.inactiveDependencies, [{ packageName: "fixture-old-plugin", version: "0.16.1", installed: true }]);
  assert.equal(status.historicalQuarantine[0].packageName, "fixture-old-plugin");
  assert.equal(status.quarantineSet.length, 0, "inactive inventory never invents an effective quarantine");
  assert.equal(readFileSync(manifestPath, "utf8"), before, "status does not enable/reinstall an old package");
  mkdirSync(join(surfaceHome, "cordis.patch.yml"));
  assert.equal((await service.status()).patchLayers.find(layer => layer.layer === "home").state, "unreadable");
  rmSync(join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  assert.equal((await service.status()).runtimeVersion, null, "missing version must not be fabricated");
});
