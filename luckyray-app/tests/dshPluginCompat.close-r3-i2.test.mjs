import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNativeSurfaceOwner,
  createPluginCompatService,
} from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * I2 chain fixture: a synthetic plugin that PASSES the static check (its
 * imports are fine) but whose dsh web child CRASHES at boot with a
 * classified plugin failure, producing an unconfirmed tree (a detached
 * grandchild keeps living). This reproduces the exact user sequence the
 * card pins: static pass -> runtime early-exit -> unconfirmed descendants.
 */
const I2_BIN = [
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
  '// Guarded mode: a quarantined plugin is disabled by the CLI overlay, so a',
  '// guarded boot runs the healthy path. Unguarded boot reproduces the',
  '// runtime failure: a detached grandchild is spawned, then the child',
  '// crashes with a classified plugin-import error before ready.',
  'const guarded = process.argv.includes("--luckyray-i2-guarded-marker");',
  '// The guard arrives as an extra --patch file; detect it by argv content.',
  'const hasGuardPatch = process.argv.some((a) => String(a).includes("luckyray-plugin-compat-guard"));',
  'if (!hasGuardPatch) {',
  '  const spawn = require("node:child_process").spawn;',
  '  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000); process.on(\'SIGTERM\', () => process.exit(0));"], { stdio: "ignore", detached: true });',
  '  fs.writeFileSync("fixture-orphan.pid", String(orphan.pid));',
  '  fs.writeSync(2, "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry i2-plugin (fixture-i2-plugin): The requested module \'@deepseek-ai/dsh-settings\' does not provide an export named \'i2Missing\'\\n");',
  '  process.exit(1);',
  '}',
  'const server = require("node:http").createServer(() => {});',
  'server.listen(0, "127.0.0.1", () => {',
  '  fs.writeSync(4, JSON.stringify({ type: "carrier-ready", generation: authority.generation, port: server.address().port, bootstrapRef: authority.bootstrapRef, bootstrapPath: authority.bootstrapPath }) + "\\n");',
  '  setTimeout(() => {',
  '    fs.writeSync(6, JSON.stringify({ type: "surface-state", carrierGeneration: authority.generation, clientReady: true, sessionOpen: null }) + "\\n");',
  '  }, 40);',
  '  const controlInput = require("node:readline").createInterface({ input: fs.createReadStream(null, { fd: 5, encoding: "utf8" }), crlfDelay: Infinity });',
  '  controlInput.on("line", (line) => {',
  '    try {',
  '      const command = JSON.parse(line);',
  '      if (command.type === "binding-close" || command.type === "binding-open") {',
  '        fs.writeSync(6, JSON.stringify({ type: command.type + "-ack", seq: command.seq, outcome: "accepted" }) + "\\n");',
  '      }',
  '    } catch {}',
  '  });',
  '  setInterval(() => {}, 60000);',
  '});',
  'process.on("SIGTERM", () => process.exit(0));',
  "",
].join("\n");

async function buildI2Runtime() {
  const runtimeRoot = await tempDir("luckyray-i2-rt-");
  mkdirSync(join(runtimeRoot, "node"), { recursive: true });
  mkdirSync(join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  copyFileSync(process.execPath, join(runtimeRoot, "node", "node.exe"));
  writeFileSync(join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), I2_BIN);
  return runtimeRoot;
}

async function buildI2Profile() {
  const surfaceHome = await tempDir("luckyray-i2-home-");
  const profileRoot = join(surfaceHome, "profiles", "web");
  const pkg = join(profileRoot, "node_modules", "fixture-i2-plugin");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(profileRoot, "package.json"), JSON.stringify({
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "fixture-i2-plugin"] } },
  }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-i2-plugin", version: "1.0.0", main: "lib/index.js" }));
  writeFileSync(join(pkg, "cordis.patch.yml"), "- insert:\n    - id: i2-plugin\n      name: fixture-i2-plugin\n");
  // Static check passes: the import is fine against the runtime fixture.
  writeFileSync(join(pkg, "lib", "index.js"), 'import { SettingsConflictError } from "@deepseek-ai/dsh-settings";\nexport const x = SettingsConflictError;\n');
  const runtimeRoot = await buildI2Runtime();
  const settingsDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh-settings");
  mkdirSync(join(settingsDir, "lib"), { recursive: true });
  writeFileSync(join(settingsDir, "package.json"), JSON.stringify({ version: "0.1.5-rc.2", main: "lib/index.js" }));
  writeFileSync(join(settingsDir, "lib", "index.js"), "export const SettingsConflictError = 1;\n");
  const dshDir = join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh");
  writeFileSync(join(dshDir, "package.json"), JSON.stringify({ version: "0.1.5-rc.2" }));
  return { surfaceHome, runtimeRoot };
}

test("I2 chain: static pass -> runtime crash with orphan -> direct compatible recovery boots the guarded composition", async () => {
  const { surfaceHome, runtimeRoot } = await buildI2Profile();
  const stateRoot = await tempDir("luckyray-i2-st-");
  const service = createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome });

  // (1) Pre-load gate: the plugin passes statically — no quarantine.
  const plan = await service.ensureLoadPlan();
  assert.deepEqual(plan.quarantinedNow, []);
  assert.deepEqual(plan.unverifiable ?? [], []);

  // (2) Real boot through the production owner: unguarded composition
  // crashes with a classified error and an orphaned detached grandchild.
  const owner = createNativeSurfaceOwner({
    runtimeRoot,
    stateRoot,
    surfaceHome,
    surfacePatch: join(surfaceHome, "surface.patch.yml"),
    onUnexpectedExit: () => {},
    onSurfaceLost: () => {},
    clientReadyTimeoutMs: 2_000,
  });
  let recoveredOwner = null;
  try {
    const boot = await owner.open();
    assert.equal(boot.stage, "surface-failed");
    assert.equal(boot.reason, "plugin-surface-plugin-import", "the classified attribution survives");
    assert.equal(boot.reclaim.confirmed, false, "the orphaned tree is honestly unconfirmed");

    // (3) The owner now refuses a plain re-open (whole-tree recovery needed).
    const refused = await owner.open();
    assert.equal(refused.reason, "dsh-surface-tree-unconfirmed");

    // (4) DIRECT compatible recovery — no plain retry first: the recovery
    // action must still work although the old control state is "blocked".
    const applied = await service.apply({ kind: "auto" });
    assert.equal(applied.applied, true, "recovery applies via the baseline fallback (no failureProbe wiring in this service instance; production attribution runs in the wrapper)");
    assert.deepEqual(applied.quarantineSet, ["i2-plugin"]);

    // (5) The guarded composition boots: the CLI overlay disables the crashing
    // plugin and the healthy path reaches ready + client-ready.
    recoveredOwner = createNativeSurfaceOwner({
      runtimeRoot,
      stateRoot,
      surfaceHome,
      surfacePatch: join(surfaceHome, "surface.patch.yml"),
      onUnexpectedExit: () => {},
      onSurfaceLost: () => {},
      clientReadyTimeoutMs: 20_000,
    });
    const recovered = await recoveredOwner.open();
    assert.equal(recovered.stage, "surface-ready", "the guarded composition reaches ready");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const closed = await recoveredOwner.close();
    assert.equal(closed.stage, "surface-closed");
    await recoveredOwner.shutdown();
    recoveredOwner = null;

    // (6) The recovery state persists for the settings surface.
    const status = await service.status();
    const record = status.plugins.find((plugin) => plugin.entryId === "i2-plugin");
    assert.equal(record.quarantined, true);
    assert.match(String(record.quarantineReason ?? ""), /attribution|compat/);
  } finally {
    await recoveredOwner?.shutdown().catch(() => {});
    await owner.shutdown().catch(() => {});
    // Test hygiene: reclaim the deliberately-orphaned grandchild. Product-level
    // recovery of it is the Rust whole-Job path, not this wrapper test.
    const orphanPidFile = join(surfaceHome, "fixture-orphan.pid");
    if (existsSync(orphanPidFile)) {
      const orphanPid = Number(readFileSync(orphanPidFile, "utf8").trim());
      const { execFile } = await import("node:child_process");
      await new Promise((resolve) => execFile("taskkill.exe", ["/PID", String(orphanPid), "/T", "/F"], () => resolve()));
    }
  }
});
