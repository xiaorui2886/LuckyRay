import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDshHostProtocol,
  createPluginCompatService,
  signCanonicalHostFrame,
} from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";
import { staticPluginVerdict } from "../src-tauri/dsh-host/luckyray-dsh-plugin-compat.mjs";

function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function buildFixture() {
  const surfaceHome = await tempDir("luckyray-i1-home-");
  const profileRoot = join(surfaceHome, "profiles", "web");
  const pluginDir = join(profileRoot, "node_modules", "fixture-plugin", "lib");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(profileRoot, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "fixture-plugin"] } },
  }, null, 2));
  const pkg = join(profileRoot, "node_modules", "fixture-plugin");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0", main: "lib/index.js" }));
  writeFileSync(join(pkg, "cordis.patch.yml"), "- insert:\n    - id: fixture-entry\n      name: fixture-plugin\n");
  const runtimeRoot = await tempDir("luckyray-i1-rt-");
  const settingsDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh-settings");
  mkdirSync(join(settingsDir, "lib"), { recursive: true });
  writeFileSync(join(settingsDir, "package.json"), JSON.stringify({ version: "0.1.5-rc.2", main: "lib/index.js" }));
  writeFileSync(join(settingsDir, "lib", "index.js"), "export const SettingsConflictError = 1;\n");
  const dshDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(dshDir, { recursive: true });
  writeFileSync(join(dshDir, "package.json"), JSON.stringify({ version: "0.1.5-rc.2" }));
  return { surfaceHome, runtimeRoot, profileRoot, entryFile: join(pluginDir, "index.js") };
}

/** Production frame protocol driving the REAL surface-open entry with a
 * pluginCompat service — proving the gate's plan result decides whether a
 * spawn may proceed (no fake success on incomplete input). */
function hostFor(pluginCompat, surfaceOpen) {
  const output = [];
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
    nativeSurface: {
      open: surfaceOpen ?? (async () => ({ stage: "surface-ready", outcome: "accepted", port: 48000, bootstrapPath: "/_luckyray/bootstrap", bootstrapRef: "a".repeat(64) })),
      close: async () => ({ stage: "surface-closed", outcome: "accepted" }),
    },
    pluginCompat,
  });
  return { host, output };
}

async function surfaceOpenViaFrame(host, output, challenge) {
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 5, challenge }));
  const frame = { type: "surface-open", protocol: 1, generation: 5, seq: 1, requestId: "so-1" };
  await host.accept(JSON.stringify({ ...frame, mac: signCanonicalHostFrame(challenge, "parent", frame) }));
  return output.at(-1);
}

test("I1-A: a manifest bundle whose package is MISSING must stop the load, not spawn the broken composition", async () => {
  const { surfaceHome, runtimeRoot, profileRoot, entryFile } = await buildFixture();
  writeFileSync(entryFile, "export const x = 1;\n");
  // Keep the missing entry IN the manifest — do not remove it for the happy path.
  const manifest = JSON.parse(readFileSync(join(profileRoot, "package.json"), "utf8"));
  manifest.dsh.profile.bundles.push("missing-plugin");
  writeFileSync(join(profileRoot, "package.json"), JSON.stringify(manifest));

  const stateRoot = await tempDir("luckyray-i1-a-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const status = await service.status();
  assert.ok(status.plugins.some((plugin) => plugin.packageName === "missing-plugin"), "placeholder stays visible");

  let spawns = 0;
  const { host, output } = hostFor(service, async () => {
    spawns += 1;
    return { stage: "surface-ready", outcome: "accepted", port: 48000, bootstrapPath: "/_luckyray/bootstrap", bootstrapRef: "a".repeat(64) };
  });
  const result = await surfaceOpenViaFrame(host, output, "b".repeat(64));
  assert.equal(spawns, 0, "the frame entry must not spawn while a configured package cannot be assessed");
  assert.equal(result.stage, "surface-failed", "the load must fail visibly instead of pretending a plan exists");
  assert.equal(result.reason, "plugin-compat-package-unreadable");
});

test("I1-B: recovery apply results that could not isolate mounts must stop reopen (auto and manual paths)", async () => {
  const { surfaceHome, runtimeRoot, entryFile } = await buildFixture();
  writeFileSync(entryFile, "export const x = 1;\n");
  const stateRoot = await tempDir("luckyray-i1-b-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  // Make the mount unresolvable: replace the patch declaration with an
  // unparsable one so the entry id cannot be located.
  const pkg = join(surfaceHome, "profiles", "web", "node_modules", "fixture-plugin");
  writeFileSync(join(pkg, "cordis.patch.yml"), "!!! not a parsable mount !!!\n");
  const applied = await service.apply({ kind: "compatible" });
  // applied must be honest: the plan could NOT be formed as claimed.
  assert.equal(applied.applied, false, "an apply that cannot isolate a configured mount must not claim success");
  assert.ok(Array.isArray(applied.unquarantinable) && applied.unquarantinable.length > 0);
  // And the frame entry must still refuse to spawn the unverifiable composition.
  let spawns = 0;
  const { host, output } = hostFor(service, async () => {
    spawns += 1;
    return { stage: "surface-ready", outcome: "accepted", port: 48000, bootstrapPath: "/_luckyray/bootstrap", bootstrapRef: "a".repeat(64) };
  });
  const result = await surfaceOpenViaFrame(host, output, "c".repeat(64));
  assert.equal(spawns, 0);
  assert.equal(result.stage, "surface-failed");
});

test("I1-C: a statically referenced but missing sub-module must not fresh-check into a new PASS", async () => {
  const runtimeRoot = await tempDir("luckyray-i1-c-rt-");
  const settingsDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh-settings");
  mkdirSync(join(settingsDir, "lib"), { recursive: true });
  writeFileSync(join(settingsDir, "package.json"), JSON.stringify({ version: "0.1.5-rc.2", main: "lib/index.js" }));
  writeFileSync(join(settingsDir, "lib", "index.js"), "export const SettingsConflictError = 1;\n");
  const pkg = await tempDir("luckyray-i1-c-");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", main: "lib/index.js" }));
  const entry = join(pkg, "lib", "index.js");
  // Entry statically references ./sub.js; the file does NOT exist.
  writeFileSync(entry, 'import "./sub.js";\nexport const x = 1;\n');
  const verdict = await staticPluginVerdict({ plugin: { packageDir: pkg }, runtimeRoot });
  assert.notEqual(verdict.outcome, "pass", "a missing statically-referenced module must not read as pass");
  assert.ok(verdict.outcome === "unknown" || verdict.outcome === "fail");
  assert.ok(verdict.findings.some((finding) => finding.kind === "scan-limited" && /missing/i.test(String(finding.reason ?? ""))),
    "the finding must name the missing reference");

  // The verdict must also be consumed by the REAL surface-open gate. A
  // package-level placeholder is not involved in this counterexample: the
  // configured package and entry both exist, only its static child is gone.
  const fixture = await buildFixture();
  writeFileSync(fixture.entryFile, 'import "./sub.js";\nexport const x = 1;\n');
  const stateRoot = await tempDir("luckyray-i1-c-state-");
  const service = createPluginCompatService({
    runtimeRoot: fixture.runtimeRoot,
    stateRoot,
    surfaceHome: fixture.surfaceHome,
  });
  const firstPlan = await service.ensureLoadPlan();
  assert.deepEqual(firstPlan.unverifiable, ["fixture-plugin"]);
  assert.equal(firstPlan.reason, "plugin-compat-static-module-missing");
  const persistedPlan = await service.ensureLoadPlan();
  assert.deepEqual(persistedPlan.unverifiable, ["fixture-plugin"], "the persisted unknown must remain admission-blocking");
  let spawns = 0;
  const { host, output } = hostFor(service, async () => {
    spawns += 1;
    return { stage: "surface-ready", outcome: "accepted", port: 48000, bootstrapPath: "/_luckyray/bootstrap", bootstrapRef: "a".repeat(64) };
  });
  const blocked = await surfaceOpenViaFrame(host, output, "d".repeat(64));
  assert.equal(spawns, 0, "the missing static child must block the production spawn boundary");
  assert.equal(blocked.stage, "surface-failed");
  assert.equal(blocked.reason, "plugin-compat-static-module-missing");

  // A legitimately empty JS module still passes (no false accusation).
  writeFileSync(join(pkg, "lib", "sub.js"), "\n");
  const okVerdict = await staticPluginVerdict({ plugin: { packageDir: pkg }, runtimeRoot });
  assert.equal(okVerdict.outcome, "pass");

  // The same empty-module boundary is legal in production too: changing the
  // scanned graph invalidates the old blocked record and allows the spawn.
  writeFileSync(join(fixture.surfaceHome, "profiles", "web", "node_modules", "fixture-plugin", "lib", "sub.js"), "\n");
  const repairedPlan = await service.ensureLoadPlan();
  assert.deepEqual(repairedPlan.unverifiable, []);
  let repairedSpawns = 0;
  const repairedHost = hostFor(service, async () => {
    repairedSpawns += 1;
    return { stage: "surface-ready", outcome: "accepted", port: 48000, bootstrapPath: "/_luckyray/bootstrap", bootstrapRef: "a".repeat(64) };
  });
  const repaired = await surfaceOpenViaFrame(repairedHost.host, repairedHost.output, "e".repeat(64));
  assert.equal(repairedSpawns, 1);
  assert.equal(repaired.stage, "surface-ready");
});
