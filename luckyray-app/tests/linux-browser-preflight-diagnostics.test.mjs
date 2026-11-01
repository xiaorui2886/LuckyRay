// Offline control-flow simulation only: no Chromium process, user namespace or network is started.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const client = fileURLToPath(new URL("./lib/linux-browser-chromium-client.mjs", import.meta.url));
const original = fs.readFileSync(client, "utf8");
const body = original.replace(/^import .*;\n/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(new URL("./lib/linux-browser-chromium-client.mjs", import.meta.url).href));
const CANARY = "PRIVATE_CANARY_cookie_bearer_profile_7c494e";

async function simulate(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luckyray-preflight-offline-"));
  const executable = path.join(root, CANARY);
  fs.writeFileSync(executable, Buffer.from([127, 69, 76, 70, 1, 2, 3, 4]));
  let stdout = "", stderr = "", fatalMonitor, clock = 0, child, spawns = 0;
  const processMock = {
    argv: ["node", client, "--browser", executable, "--mode", "preflight"],
    platform: "linux", getuid: () => 1000, env: {},
    stdout: { write: value => { stdout += value; return true; } },
    stderr: { write: value => { stderr += value; return true; } },
    once: (event, callback) => { assert.equal(event, "uncaughtExceptionMonitor"); fatalMonitor = callback; },
  };
  const fsMock = new Proxy(fs, { get(target, key) {
    if (key === "statSync") return (...args) => {
      const metadata = target.statSync(...args);
      return new Proxy(metadata, { get(value, field) {
        if (field === "uid") return 1000;
        return typeof value[field] === "function" ? value[field].bind(value) : value[field];
      } });
    };
    if (key === "readFileSync") return (...args) => {
      if (scenario === "extension-identity" && String(args[0]).endsWith("/manifest.json")) throw new Error(CANARY);
      return target.readFileSync(...args);
    };
    if (key === "mkdtempSync" && scenario === "synthetic-profile") return () => { throw new Error(CANARY); };
    return target[key];
  } });
  const spawn = (_binary, args) => {
    spawns++;
    assert(!args.some(value => /no-sandbox|disable.*sandbox|single-process|in-process-gpu|disable-web-security/i.test(value)));
    child = new EventEmitter();
    child.exitCode = scenario === "early-exit" ? 23 : null;
    child.signalCode = scenario === "signal-exit" ? "SIGTRAP" : null;
    child.kill = signal => {
      if (scenario !== "cleanup") { child.signalCode = signal; child.emit("exit"); }
      return true;
    };
    if (scenario === "spawn") child.on = (event, listener) => {
      if (event === "error") listener(Object.assign(new Error(CANARY), { code: "EACCES" }));
      return child;
    };
    if (!["spawn", "early-exit", "signal-exit", "devtools-timeout"].includes(scenario)) {
      const profile = args.find(value => value.startsWith("--user-data-dir=")).split("=").slice(1).join("=");
      fs.writeFileSync(path.join(profile, "DevToolsActivePort"), "12345\n/devtools/browser/offline-only\n");
    }
    return child;
  };
  const connection = {
    send: async method => {
      if (method === "Target.createTarget" && scenario === "sandbox-page") throw new Error(CANARY);
      if (method === "Browser.close" && scenario !== "cleanup") { child.exitCode = 0; child.emit("exit"); }
      return { targetId: "offline-sandbox" };
    },
    close: async () => {},
  };
  const CdpConnection = { connect: async () => {
    if (scenario === "cdp-connect") throw Object.assign(new Error(CANARY), { code: "ECONNREFUSED" });
    return connection;
  } };
  const evaluate = async () => {
    if (scenario === "observation-error") throw new Error(CANARY);
    if (scenario === "observation-timeout") return {};
    const values = { "Namespace Sandbox": "Yes", "PID namespaces": "Yes", "Network namespaces": "Yes", "Seccomp-BPF sandbox": "Yes" };
    const failed = { namespace: "Namespace Sandbox", pid: "PID namespaces", network: "Network namespaces", seccomp: "Seccomp-BPF sandbox" }[scenario];
    if (failed) values[failed] = "No";
    return { evaluation: scenario === "evaluation" ? CANARY : "You are adequately sandboxed.", rows: Object.entries(values) };
  };
  try {
    try {
      await vm.runInNewContext("(async () => {\n" + body + "\n})()", {
        assert, spawn,
        execFileSync: () => {
          if (scenario === "browser-identity") throw new Error(CANARY);
          return "Chromium 146.0.1.2 " + CANARY;
        },
        createHash, randomUUID, fs: fsMock, os: { tmpdir: () => root }, path, readline, fileURLToPath,
        CdpConnection, attachSession: async () => {
          if (scenario === "sandbox-attach") throw new Error(CANARY);
          return "offline-session";
        },
        evaluate, getTargets: async () => [],
        process: processMock, URL, Buffer,
        Date: class extends Date { static now() { clock += 5000; return clock; } },
        setTimeout: callback => { queueMicrotask(callback); return 0; },
      }, { timeout: 1000 });
    } catch (error) {
      assert(fatalMonitor, "initialization failure must have a diagnostic observer");
      fatalMonitor(error);
      processMock.exitCode = 1; // Node's default fatal behavior, preserved by the monitor.
    }
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 1, "preflight must emit one terminal JSON, including cleanup failures");
    assert(!stdout.includes(CANARY), "exported report contains private data");
    assert(stdout.length < 2048, "exported diagnostic is not bounded");
    return { report: JSON.parse(lines[0]), exitCode: processMock.exitCode ?? 0, spawns, stderr };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const failures = [
  ["browser-identity", "browser-identity", "browser-identity-invalid"],
  ["extension-identity", "extension-identity", "extension-identity-invalid"],
  ["synthetic-profile", "synthetic-profile", "synthetic-profile-invalid"],
  ["spawn", "browser-start", "browser-start-failed"],
  ["early-exit", "browser-start", "browser-exited-before-devtools"],
  ["signal-exit", "browser-start", "devtools-start-timeout"],
  ["devtools-timeout", "browser-start", "devtools-start-timeout"],
  ["cdp-connect", "cdp-connect", "cdp-connect-failed"],
  ["sandbox-page", "sandbox-page", "sandbox-page-failed"],
  ["sandbox-attach", "sandbox-page", "sandbox-page-failed"],
  ["observation-error", "sandbox-observation", "sandbox-observation-failed"],
  ["observation-timeout", "sandbox-observation", "sandbox-observation-timeout"],
  ["namespace", "sandbox-assertion", "namespace-sandbox-required"],
  ["pid", "sandbox-assertion", "pid-namespaces-required"],
  ["network", "sandbox-assertion", "network-namespaces-required"],
  ["seccomp", "sandbox-assertion", "seccomp-bpf-required"],
  ["evaluation", "sandbox-assertion", "adequate-sandbox-required"],
  ["cleanup", "browser-cleanup", "browser-cleanup-failed"],
];
for (const [scenario, phase, code] of failures) {
  test("offline failure classification: " + scenario, async () => {
    const { report, exitCode, spawns } = await simulate(scenario);
    assert.equal(exitCode, 1);
    assert.equal(report.status, "FAIL");
    assert.deepEqual(report.failure, { phase, code, ...(
      scenario === "spawn" ? { osError: "EACCES" } : scenario === "cdp-connect" ? { osError: "ECONNREFUSED" } : {}),
      ...(["browser-identity", "extension-identity", "synthetic-profile"].includes(scenario) ? {}
        : { browserExitCode: scenario === "early-exit" ? 23 : null }),
      ...(scenario === "signal-exit" ? { browserSignal: "SIGTRAP" } : {}) });
    assert.equal(spawns, ["browser-identity", "extension-identity", "synthetic-profile"].includes(scenario) ? 0 : 1);
    if (scenario === "browser-identity") assert.equal(report.browser, undefined);
    else assert.equal(report.browser.version, "Chromium 146.0.1.2");
  });
}
test("offline success is emitted only after cleanup", async () => {
  const { report, exitCode } = await simulate("success");
  assert.equal(exitCode, 0);
  assert.equal(report.status, "PASS");
  assert.equal(report.failure, undefined);
  assert.equal(report.sandbox.adequatelySandboxed, true);
});
test("actual Node fatal observer exports a redacted identity failure without launching Chromium", () => {
  const result = spawnSync(process.execPath, [client, "--mode", "preflight", "--browser",
    path.join(os.tmpdir(), CANARY, "does-not-exist")], { encoding: "utf8", timeout: 3000, maxBuffer: 65536 });
  assert.equal(result.status, 1);
  assert(!result.stdout.includes(CANARY));
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "FAIL");
  assert.deepEqual(report.failure, { phase: "browser-identity", code: "browser-identity-invalid", osError: "ENOENT" });
  assert.equal(report.browser, undefined);
});
