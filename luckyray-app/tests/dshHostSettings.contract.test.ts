import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createDshHostClient,
  describeDshHostStartupError,
  ensureDshHostReady,
  projectDshHostStatus,
} from "../src/core/services/dshHost.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const bundled = {
  stage: "bundled-verified" as const,
  latestProbePassed: false,
  hostReusable: false,
  canProbe: true,
  canRetry: false,
  shuttingDown: false,
  retryAttempt: 0,
  durationMs: null,
  message: "DeepSeek Harness 已验证，可进行诊断。",
};

const ready = {
  ...bundled,
  stage: "probe-completed" as const,
  latestProbePassed: true,
  hostReusable: true,
  durationMs: 11,
  message: "诊断已通过",
};

test("DSH Settings client consumes only the three diagnostic commands", async () => {
  const calls: string[] = [];
  const client = createDshHostClient(async (command) => {
    calls.push(command);
    return {
      stage: "probe-completed",
      latestProbePassed: true,
      hostReusable: true,
      canProbe: true,
      canRetry: false,
      shuttingDown: false,
      retryAttempt: 0,
      durationMs: 14,
      message: "诊断已通过",
      path: "forbidden",
      pid: 42,
      challenge: "forbidden",
    };
  });
  const status = await client.status();
  await client.probe();
  await client.retry();
  assert.deepEqual(calls, ["dsh_host_status", "dsh_host_probe", "dsh_host_retry"]);
  assert.equal(status.latestProbePassed, true);
  assert.equal(JSON.stringify(status).includes("forbidden"), false);
});

test("invalid or partial DSH readiness fails closed", () => {
  assert.deepEqual(projectDshHostStatus({ stage: "process-alive", latestProbePassed: true, hostReusable: true }), {
    stage: "process-alive",
    latestProbePassed: false,
    hostReusable: false,
    canProbe: false,
    canRetry: false,
    shuttingDown: false,
    retryAttempt: 0,
    durationMs: null,
    message: "DeepSeek Harness 诊断暂不可用。",
  });
  assert.equal(projectDshHostStatus({ stage: "ready", latestProbePassed: true }).latestProbePassed, false);
});

test("pending resource admission queues one probe but never reports early readiness", async () => {
  const pending = projectDshHostStatus({ ...ready, stage: "initializing", canProbe: true });
  assert.equal(pending.stage, "initializing");
  assert.equal(pending.latestProbePassed, false);
  assert.equal(pending.hostReusable, false);
  assert.equal(pending.canRetry, false);
  assert.equal(pending.canProbe, true);
  const admitted = deferred<typeof ready>();
  let probeCalls = 0;
  const client = {
    async status() { return pending; },
    async probe() { probeCalls += 1; return admitted.promise; },
    async retry() { throw new Error("unexpected retry"); },
  };
  const startup = ensureDshHostReady(client);
  const remount = ensureDshHostReady(client);
  await Promise.resolve();
  assert.equal(probeCalls, 1);
  admitted.resolve(ready);
  assert.deepEqual(await Promise.all([startup, remount]), [ready, ready]);
});

test("AI startup readiness is one in-memory single-flight and ready remount is status-only", async () => {
  const probe = deferred<typeof ready>();
  let current = bundled;
  let statusCalls = 0;
  let probeCalls = 0;
  const client = {
    async status() { statusCalls += 1; return current; },
    async probe() {
      probeCalls += 1;
      const result = await probe.promise;
      current = result;
      return result;
    },
    async retry() { throw new Error("unexpected retry"); },
  };

  const first = ensureDshHostReady(client);
  const strictModeRemount = ensureDshHostReady(client);
  await Promise.resolve();
  assert.equal(statusCalls, 1);
  assert.equal(probeCalls, 1);
  probe.resolve(ready);
  assert.deepEqual(await Promise.all([first, strictModeRemount]), [ready, ready]);

  assert.equal((await ensureDshHostReady(client)).stage, "probe-completed");
  assert.equal(statusCalls, 2, "a remount rereads Backend truth");
  assert.equal(probeCalls, 1, "a ready remount never probes or restarts");
});

test("failed startup clears single-flight and explicit retry is the only retry action", async () => {
  let statusCalls = 0;
  let probeCalls = 0;
  let retryCalls = 0;
  let failProbe = true;
  const unavailable = {
    ...bundled,
    stage: "unavailable" as const,
    canProbe: false,
    canRetry: true,
    message: "DeepSeek Harness 诊断暂不可用。",
  };
  const client = {
    async status() {
      statusCalls += 1;
      return failProbe ? bundled : unavailable;
    },
    async probe() {
      probeCalls += 1;
      throw new Error("private diagnostic detail");
    },
    async retry() { retryCalls += 1; return ready; },
  };

  await assert.rejects(ensureDshHostReady(client));
  await assert.rejects(ensureDshHostReady(client));
  assert.equal(probeCalls, 2, "a rejected single-flight is cleared for the next attempt");
  assert.equal(describeDshHostStartupError(new Error("private diagnostic detail")), "AI 助手启动失败，请重试。");

  failProbe = false;
  await assert.rejects(ensureDshHostReady(client));
  assert.equal(retryCalls, 0, "entry never silently retries an unavailable runtime");
  assert.equal((await ensureDshHostReady(client, "retry")).stage, "probe-completed");
  assert.equal(retryCalls, 1);
  assert.ok(statusCalls >= 4);
});

test("Settings only observes pending admission and never polls probes or wires an Agent", async () => {
  const settings = await readFile(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/core/services/dshHost.ts", import.meta.url), "utf8");
  const rustLib = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(settings, /t\("settings\.ai\.dsh\.(?:group|label)"\)/u);
  assert.match(settings, /t\("settings\.ai\.dsh\.description"\)/u);
  assert.doesNotMatch(settings, /createDefaultDshNativeSurfaceClient|dshNativeSurfaceStatus|#ai\/native-m1/u);
  assert.equal(client.includes("setInterval("), false);
  assert.equal(client.includes("setTimeout("), false);
  assert.equal(client.includes("sharedAgentEngineLifecycle"), false);
  assert.equal(client.includes("localStorage"), false);
  assert.equal(client.includes("sessionStorage"), false);
  for (const command of ["dsh_host_status", "dsh_host_probe", "dsh_host_retry"]) {
    const commandStart = rustLib.indexOf(`fn ${command}(`);
    assert.notEqual(commandStart, -1, command);
    assert.match(
      rustLib.slice(commandStart, commandStart + 500),
      /require_main_caller\(&caller\)\?/u,
    );
  }
});
