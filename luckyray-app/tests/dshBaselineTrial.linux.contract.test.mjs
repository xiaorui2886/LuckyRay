// T23: the optional compatibility baseline trial on Linux must boot the
// official bundle in a throwaway home, get an HTTP answer, and leave no
// process of its own group behind -- without ever reaching the live carrier's
// group. Everything here is synthetic: a fake `bin.js` stands in for the pinned
// runtime and the "carrier" is another detached Node process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = new URL("../src-tauri/dsh-host/luckyray-dsh-host.mjs", import.meta.url);
const { runBaselineSurfaceTrial } = await import(HOST);

const BOOT_OK = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("synthetic");
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("dsh web: http://127.0.0.1:" + server.address().port + "/\\n");
});
`;
const BOOT_SILENT = `setInterval(() => {}, 1000);\n`;
const BOOT_EXIT = `process.stderr.write("synthetic boot failure\\n"); process.exit(3);\n`;
const BOOT_URL_NO_HTTP = `process.stdout.write("dsh web: http://127.0.0.1:9/\\n"); setInterval(() => {}, 1000);\n`;

/** A synthetic runtime root: node/node plus a fake official bin.js. */
function runtimeRoot(binSource) {
  const root = mkdtempSync(join(tmpdir(), "luckyray-trial-runtime-"));
  mkdirSync(join(root, "node"), { recursive: true });
  mkdirSync(join(root, "host", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  // A symlink, not a copy: the fixture only needs the pinned runtime's identity,
  // and copying an executable is refused in some sandboxes.
  symlinkSync(process.execPath, join(root, "node", "node"));
  writeFileSync(join(root, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), binSource);
  return root;
}

/** A stand-in for the live carrier: its own session and group. */
function startedCarrier() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
}

function trialHomes() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("luckyray-compat-trial-"));
}

/** Processes whose command line mentions this fixture, i.e. trial residue. */
function trialResidue(root) {
  return readdirSync("/proc").filter((name) => {
    if (!/^\d+$/u.test(name)) return false;
    try {
      return readFileSync(`/proc/${name}/cmdline`, "utf8").includes(root);
    } catch {
      return false;
    }
  });
}

test("baseline trial boots the bundle, answers HTTP and removes its temp home", async () => {
  const root = runtimeRoot(BOOT_OK);
  const before = new Set(trialHomes());
  try {
    const result = await runBaselineSurfaceTrial({ runtimeRoot: root, timeoutMs: 20_000 });
    assert.equal(result.outcome, "pass", JSON.stringify(result));
    assert.equal(result.evidence, "baseline-boot+http");
    assert.ok(result.port > 0);
    assert.equal(result.httpStatus, 200);
    assert.deepEqual(trialHomes().filter((name) => !before.has(name)), [],
      "the one-shot temp home must be removed");
    assert.deepEqual(trialResidue(root), [], "no trial process may survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout, early exit and an unanswered URL keep their own codes", async () => {
  for (const [bin, code, timeoutMs] of [[BOOT_SILENT, "baseline-trial-timeout", 1_500],
                                        [BOOT_EXIT, "baseline-trial-exit", 20_000],
                                        [BOOT_URL_NO_HTTP, "baseline-trial-http-unanswered", 20_000]]) {
    const root = runtimeRoot(bin);
    try {
      const result = await runBaselineSurfaceTrial({ runtimeRoot: root, timeoutMs });
      assert.equal(result.outcome, "fail", JSON.stringify(result));
      assert.equal(result.reason, code);
      assert.deepEqual(trialResidue(root), [], `${code}: no trial process may survive`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the sweep reclaims the trial's own group and leaves a carrier in another group alive", async () => {
  const root = runtimeRoot(BOOT_SILENT);
  const carrier = startedCarrier();
  try {
    const result = await runBaselineSurfaceTrial({ runtimeRoot: root, timeoutMs: 1_500 });
    assert.equal(result.outcome, "fail");
    assert.equal(result.reason, "baseline-trial-timeout");
    // A different session/group can never be reached by the trial's sweep.
    assert.equal(carrier.exitCode, null, "the live carrier must survive the trial");
    assert.equal(carrier.signalCode, null);
    assert.deepEqual(trialResidue(root), [], "the trial's own group must be empty");
  } finally {
    try { process.kill(-carrier.pid, "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
