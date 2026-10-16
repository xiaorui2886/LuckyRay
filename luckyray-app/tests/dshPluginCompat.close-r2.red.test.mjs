import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPluginCompatService,
} from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Same profile/runtime fixture shape as the main matrix. */
async function buildFixture() {
  const surfaceHome = await tempDir("luckyray-r2-home-");
  const profileRoot = join(surfaceHome, "profiles", "web");
  const pluginDir = join(profileRoot, "node_modules", "fixture-old-plugin", "lib");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(profileRoot, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dependencies: { "fixture-old-plugin": "^0.16.0" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "fixture-old-plugin"] } },
  }, null, 2));
  const pkg = join(profileRoot, "node_modules", "fixture-old-plugin");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-old-plugin", version: "0.16.1", main: "lib/index.js" }));
  writeFileSync(join(pkg, "cordis.patch.yml"), "- insert:\n    - id: old-fixture\n      name: fixture-old-plugin\n");
  const runtimeRoot = await tempDir("luckyray-r2-rt-");
  const settingsDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh-settings");
  mkdirSync(join(settingsDir, "lib"), { recursive: true });
  writeFileSync(join(settingsDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-settings", version: "0.1.5-rc.2", main: "lib/index.js" }));
  writeFileSync(join(settingsDir, "lib", "index.js"), "export const SettingsConflictError = 1;\n");
  const dshDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(dshDir, { recursive: true });
  writeFileSync(join(dshDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.2" }));
  return { surfaceHome, runtimeRoot, entryFile: join(pluginDir, "index.js") };
}

test("R2-A RED: a recorded-but-unquarantined fail must still be admitted by the load gate", async () => {
  const { surfaceHome, runtimeRoot, entryFile } = await buildFixture();
  writeFileSync(entryFile, 'import { settingsNamespace } from "@deepseek-ai/dsh-settings";\nexport const x = settingsNamespace;\n');
  const stateRoot = await tempDir("luckyray-r2-a-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  // check() reports fail WITHOUT quarantining (documented semantics).
  const check = await service.check({});
  assert.equal(check.plugins[0].outcome, "fail");
  assert.equal(check.plugins[0].quarantined, false);
  // The load gate on the SAME bytes must not skip the known failure.
  const plan = await service.ensureLoadPlan();
  assert.deepEqual(
    plan.quarantinedNow,
    ["old-fixture"],
    "a recorded fail with no quarantine must still be quarantined before load",
  );
  assert.equal(plan.guardActive, true);
});

test("R2-A RED: unreadable/missing bundle packages must not vanish into a valid empty plan", async () => {
  const { surfaceHome, runtimeRoot, entryFile } = await buildFixture();
  writeFileSync(entryFile, "export const x = 1;\n");
  // The bundle lists a package whose directory does not exist on disk.
  const profileRoot = join(surfaceHome, "profiles", "web");
  const manifest = JSON.parse(readFileSync(join(profileRoot, "package.json"), "utf8"));
  manifest.dsh.profile.bundles.push("missing-plugin");
  writeFileSync(join(profileRoot, "package.json"), JSON.stringify(manifest));
  const stateRoot = await tempDir("luckyray-r2-a2-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const status = await service.status();
  const missing = status.plugins.find((plugin) => plugin.packageName === "missing-plugin");
  assert.ok(missing, "a bundle entry with no readable package must stay visible in inventory");
  assert.notEqual(missing.outcome, "pass");
  // Clean first boot (no missing packages) must stay valid.
  writeFileSync(join(profileRoot, "package.json"), JSON.stringify({ ...manifest, dsh: { profile: { bundles: manifest.dsh.profile.bundles.filter((b) => b !== "missing-plugin") } } }));
  const cleanState = await tempDir("luckyray-r2-a3-");
  const cleanService = createPluginCompatService({ runtimeRoot, stateRoot: cleanState, surfaceHome });
  const cleanPlan = await cleanService.ensureLoadPlan();
  assert.equal(cleanPlan.planValid, true, "a clean first boot keeps its normal path");
});

test("R2-B RED: changing ONLY a scanned sub-module invalidates the recorded pass", async () => {
  const { surfaceHome, runtimeRoot, entryFile } = await buildFixture();
  const subFile = join(entryFile, "..", "sub.js");
  // Entry imports a sub-module; sub starts clean.
  writeFileSync(entryFile, 'import "./sub.js";\nexport const x = 1;\n');
  writeFileSync(subFile, "export const y = 2;\n");
  const stateRoot = await tempDir("luckyray-r2-b-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const first = await service.check({});
  assert.equal(first.plugins[0].outcome, "pass");
  // ONLY sub.js changes — entry, manifest and version stay identical.
  writeFileSync(subFile, 'import { settingsNamespace } from "@deepseek-ai/dsh-settings";\nexport const y = settingsNamespace;\n');
  const status = await service.status();
  assert.notEqual(status.plugins[0].outcome, "pass", "status must not project the stale pass onto changed sub-module bytes");
  const second = await service.check({});
  assert.equal(second.cached, undefined, "check must not reuse the cache across sub-module changes");
  assert.equal(second.plugins[0].outcome, "fail");
  const plan = await service.ensureLoadPlan();
  assert.deepEqual(plan.quarantinedNow, ["old-fixture"], "the gate must judge the new content and quarantine");
});

test("R2-B regression guard: profile-layer mounts join the composition (cache miss on new inventory)", async () => {
  const { surfaceHome, runtimeRoot, entryFile } = await buildFixture();
  writeFileSync(entryFile, "export const x = 1;\n");
  const profileRoot = join(surfaceHome, "profiles", "web");
  const stateRoot = await tempDir("luckyray-r2-b2-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  await service.check({});
  // Only the profile user-layer patch changes (adds a manual mount).
  writeFileSync(join(profileRoot, "cordis.patch.yml"), "- insert:\n    - id: extra-mount\n      name: fixture-old-plugin\n");
  const second = await service.check({});
  assert.equal(second.cached, undefined, "an effective-config change must not reuse the cache");
});

test("R2-B RED: deleting a scanned sub-module invalidates the recorded pass", async () => {
  const { surfaceHome, runtimeRoot, entryFile } = await buildFixture();
  const subFile = join(entryFile, "..", "sub.js");
  writeFileSync(entryFile, 'import "./sub.js";\nexport const x = 1;\n');
  writeFileSync(subFile, "export const y = 2;\n");
  const stateRoot = await tempDir("luckyray-r2-b3-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  await service.check({});
  rmSync(subFile, { force: true });
  const status = await service.status();
  assert.notEqual(status.plugins[0].outcome, "pass", "deleting a scanned module must invalidate the recorded pass");
});
test("R2-B RED: changing only the package's bundle-patch bytes invalidates the recorded pass", async () => {
  const { surfaceHome, runtimeRoot, entryFile } = await buildFixture();
  writeFileSync(entryFile, "export const x = 1;\n");
  const pkg = join(surfaceHome, "profiles", "web", "node_modules", "fixture-old-plugin");
  const stateRoot = await tempDir("luckyray-r2-b4-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });
  const first = await service.check({});
  assert.equal(first.plugins[0].outcome, "pass");
  // ONLY the package patch changes — entry, manifest and version stay identical.
  const patchFile = join(pkg, "cordis.patch.yml");
  writeFileSync(patchFile, readFileSync(patchFile, "utf8") + "# mount config edit\n");
  const status = await service.status();
  assert.notEqual(status.plugins[0].outcome, "pass", "a patch edit must invalidate the recorded pass");
  const second = await service.check({});
  assert.equal(second.cached, undefined, "check must not reuse the cache across a patch edit");
});
