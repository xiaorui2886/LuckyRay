import assert from "node:assert/strict";
import test from "node:test";
import { dshStartupReason, observeDshStartupInvoke } from "../src/core/services/dshStartupObservation.ts";

test("startup observation never sends raw errors, arguments or result content", async () => {
  const records: Record<string, unknown>[] = [];
  const wrapped = observeDshStartupInvoke(async <T>() => {
    throw new Error("private path, conversation and key");
  }, record => records.push(record));
  await assert.rejects(() => wrapped("dsh_native_surface_open", { private: "not logged" }));
  assert.equal(records.length, 2);
  assert.equal(records[1].reason, "unclassified");
  assert.doesNotMatch(JSON.stringify(records), /private|conversation|key|logged/u);
  assert.equal(dshStartupReason("dsh-host-action-busy"), "dsh-host-action-busy");
  assert.equal(dshStartupReason("dsh-surface-failed:surface-ready-timeout"), "surface-ready-timeout");
});

test("diagnostic sink rejection cannot affect startup truth or retry it", async () => {
  let commands = 0;
  const wrapped = observeDshStartupInvoke(async <T>(command: string) => {
    commands += 1;
    return { ready: false, stage: "webview-created" } as T;
  }, () => { throw new Error("observation unavailable"); });
  assert.deepEqual(await wrapped("dsh_native_surface_open"), { ready: false, stage: "webview-created" });
  assert.equal(commands, 1);
});

test("non-startup calls are not observed or mutated", async () => {
  const calls: string[] = [];
  const wrapped = observeDshStartupInvoke(async <T>(command: string) => { calls.push(command); return "applied" as T; });
  assert.equal(await wrapped("dsh_native_surface_open_intent_status"), "applied");
  assert.deepEqual(calls, ["dsh_native_surface_open_intent_status"]);
});

test("startup failure retains exact rejection identity and sends no additional native request", async () => {
  const failure = new Error("dsh-surface-failed:surface-ready-timeout");
  let nativeCalls = 0;
  const wrapped = observeDshStartupInvoke(async () => { nativeCalls += 1; throw failure; }, () => {});
  await assert.rejects(wrapped("dsh_native_surface_open"), error => error === failure);
  assert.equal(nativeCalls, 1);
});

test("only known result stages are projected, never payload or unknown text", async () => {
  const records: Record<string, unknown>[] = [];
  const result = { stage: "initializing", secret: "not logged" };
  const wrapped = observeDshStartupInvoke(async <T>() => result as T, record => records.push(record));
  assert.equal(await wrapped("dsh_host_status"), result);
  assert.equal(records[1].stage, "initializing");
  assert.doesNotMatch(JSON.stringify(records), /secret|not logged/u);
  result.stage = "private path";
  await wrapped("dsh_host_status");
  assert.equal(records[3].stage, undefined);
});

test("default console evidence is bounded per renderer lifetime", async () => {
  const original = console.info;
  let logs = 0;
  console.info = () => { logs += 1; };
  try {
    const wrapped = observeDshStartupInvoke(async <T>() => ({ stage: "closed" }) as T);
    for (let index = 0; index < 70; index += 1) await wrapped("dsh_native_surface_show");
    assert.equal(logs, 128);
  } finally { console.info = original; }
});

test("an unexpected result accessor cannot let observation reject a successful invoke", async () => {
  const result = { get stage() { throw new Error("unexpected accessor"); } };
  const wrapped = observeDshStartupInvoke(async <T>() => result as T, () => {});
  assert.equal(await wrapped("dsh_host_status"), result);
});

test("full hidden preparation is observed without logging content or treating null as readiness", async () => {
  const records: Record<string, unknown>[] = [];
  const wrapped = observeDshStartupInvoke(async <T>() => null as T, record => records.push(record));
  assert.equal(await wrapped("dsh_native_surface_preload"), null);
  assert.deepEqual(records.map(record => [record.phase, record.outcome]), [
    ["dsh_native_surface_preload", "started"], ["dsh_native_surface_preload", "completed"],
  ]);
  assert.equal(records[1].stage, undefined);
});
