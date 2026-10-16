import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNativeSurfaceOwner } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * REAL parent -> child -> grandchild fixture where the DIRECT CHILD exits on
 * its own while the grandchild keeps living. This is the exact Windows
 * failure mode the task card pins: terminating a parent does not terminate
 * its children (learn.microsoft.com/win32/procthread/terminating-a-process).
 */
const ORPHAN_BIN = [
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
  'const spawn = require("node:child_process").spawn;',
  '// Grandchild OUTLIVES this process on purpose.',
  'const grand = spawn(process.execPath, ["-e", "require(\'node:fs\').writeFileSync(\'grand-alive\', \'1\'); setInterval(() => {}, 60000); process.on(\'SIGTERM\', () => process.exit(0));"], { stdio: "ignore", detached: true });',
  'fs.writeFileSync("fixture-child.pid", String(process.pid));',
  'fs.writeFileSync("fixture-grandchild.pid", String(grand.pid));',
  'grand.unref();',
  'const server = require("node:http").createServer(() => {});',
  'server.listen(0, "127.0.0.1", () => {',
  '  fs.writeSync(4, JSON.stringify({ type: "carrier-ready", generation: authority.generation, port: server.address().port, bootstrapRef: authority.bootstrapRef, bootstrapPath: authority.bootstrapPath }) + "\\n");',
  '  fs.writeFileSync("fixture-ready", "1");',
  '  // The direct child exits on its own shortly after ready.',
  '  setTimeout(() => process.exit(0), 250);',
  '});',
  'process.on("SIGTERM", () => process.exit(0));',
  "",
].join("\n");

async function buildOrphanRuntime() {
  const runtimeRoot = await tempDir("luckyray-r2c-rt-");
  mkdirSync(join(runtimeRoot, "node"), { recursive: true });
  mkdirSync(join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  copyFileSync(process.execPath, join(runtimeRoot, "node", "node.exe"));
  writeFileSync(join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), ORPHAN_BIN);
  return runtimeRoot;
}

function ownerFor(runtimeRoot, stateRoot, surfaceHome, hooks = {}) {
  return createNativeSurfaceOwner({
    runtimeRoot,
    stateRoot,
    surfaceHome,
    surfacePatch: join(surfaceHome, "surface.patch.yml"),
    onUnexpectedExit: () => {},
    clientReadyTimeoutMs: 60_000,
    ...hooks,
  });
}

test("R2-C RED: a self-exiting child with a living grandchild is NOT confirmed reclamation", async () => {
  const runtimeRoot = await buildOrphanRuntime();
  const surfaceHome = await tempDir("luckyray-r2c-home-");
  const stateRoot = await tempDir("luckyray-r2c-st-");
  const grandLives = join(surfaceHome, "grand-lives");
  const owner = ownerFor(runtimeRoot, stateRoot, surfaceHome);
  // surfaceHome is the fixture cwd; the grandchild writes its liveness file
  // to that directory via argv (argv[1] inside the fixture = process.argv[2]
  // of the spawned node -e, i.e. the path we pass here).
  // The wrapper passes [entry, "web", "--patch", patch, ...] so argv[2] is
  // "--patch" — instead, the fixture writes its own markers; we assert on the
  // grandchild PID file plus an OS-level liveness check below.
  const opened = await owner.open();
  assert.equal(opened.stage, "surface-ready");
  const readyFile = join(surfaceHome, "fixture-ready");
  const readyDeadline = Date.now() + 10_000;
  while (!existsSync(readyFile) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(readyFile), "fixture must reach ready");
  const grandPid = Number(readFileSync(join(surfaceHome, "fixture-grandchild.pid"), "utf8").trim());
  // Wait for the direct child to exit on its own.
  const childPid = Number(readFileSync(join(surfaceHome, "fixture-child.pid"), "utf8").trim());
  const childGone = Date.now() + 8_000;
  while (Date.now() < childGone) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch {
      break;
    }
  }
  // The grandchild must still be alive at this point (fixture design).
  let grandAlive = true;
  try {
    process.kill(grandPid, 0);
  } catch {
    grandAlive = false;
  }
  assert.equal(grandAlive, true, "fixture precondition: the grandchild outlives the direct child");
  writeFileSync(grandLives, "1");
  // Reclamation after the parent is gone: the owner must NOT report this as
  // confirmed, and the follow-up cold start must be blocked until the tree
  // is verifiably reclaimed. The watchdog will eventually fire (client never
  // becomes ready because the child died) — wait for the surface-lost path.
  const lost = new Promise((resolve) => {
    const ownerWithLoss = owner;
    // owner already created without onSurfaceLost; the child exit triggers
    // onUnexpectedExit instead. The observable contract under test: a NEW
    // cold open must not spawn while reclamation of the orphan tree is
    // unconfirmed.
    resolve(null);
  });
  await lost;
  const retried = await owner.open();
  assert.notEqual(retried.stage, "surface-ready",
    "a cold start after an orphaned-tree failure must be blocked/refused, not a fresh ready");
  // Cleanup: kill the orphan grandchild ourselves (test hygiene only).
  const { execFile } = await import("node:child_process");
  await new Promise((resolve) => execFile("taskkill.exe", ["/PID", String(grandPid), "/T", "/F"], () => resolve()));
});
