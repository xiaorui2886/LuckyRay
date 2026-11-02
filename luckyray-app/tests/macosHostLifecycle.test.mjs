// Real ordinary Node processes exercise only the wrapper's authenticated stdio
// lifecycle. No DSH server, native Mac group or model acceptance is simulated.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function wrapper(t) {
  const root = await mkdtemp(join(tmpdir(), "luckyray-host-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = join(root, "dsh-host");
  await cp(new URL("../src-tauri/dsh-host/", import.meta.url), host, { recursive: true });
  // This is the production Mac bundle mapping, without the 1.4 GB DSH payload.
  await cp(new URL("../src-tauri/macos-lsh/host-support.mjs", import.meta.url), join(host, "luckyray-dsh-macos.mjs"));
  const script = join(host, "luckyray-dsh-host.mjs");
  const protocol = await import(pathToFileURL(script).href);
  const child = spawn(process.execPath, [script], { env: {
    LUCKYRAY_DSH_RUNTIME_ROOT: root, LUCKYRAY_DSH_STATE_ROOT: root, LUCKYRAY_DSH_NATIVE_SURFACE_HOME: root,
  }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exit = once(child, "close");
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let inbound = 0, outbound = 0;
  const challenge = "a".repeat(64), generation = 7;
  child.stderr.resume();
  child.stdin.write(`${JSON.stringify({ type: "bootstrap", protocol: 1, generation, challenge })}\n`);
  async function frame(type) {
    const result = await lines.next();
    assert.equal(result.done, false);
    const { mac, ...value } = JSON.parse(result.value);
    assert.equal(value.type, type); assert.equal(value.generation, generation);
    assert.equal(value.seq, ++inbound);
    assert.equal(protocol.verifyCanonicalHostFrameMac(challenge, "child", value, mac), true);
  }
  function send(type, macOverride) {
    const value = { type, protocol: 1, generation, seq: ++outbound };
    const mac = macOverride ?? protocol.signCanonicalHostFrame(challenge, "parent", value);
    child.stdin.write(`${JSON.stringify({ ...value, mac })}\n`);
  }
  await frame("hello");
  return { child, exit, frame, send };
}

test("real wrapper acknowledges shutdown and exits zero while parent stdin stays open", { timeout: 5000 }, async t => {
  const host = await wrapper(t);
  host.send("ping"); await host.frame("pong");
  host.send("shutdown"); await host.frame("shutdown-ack");
  assert.deepEqual(await host.exit, [0, null]);
});

test("parent loss and a forged shutdown both finish without hanging the wrapper", { timeout: 5000 }, async t => {
  const lost = await wrapper(t);
  lost.child.stdin.end();
  assert.deepEqual(await lost.exit, [0, null]);
  const forged = await wrapper(t);
  forged.send("shutdown", "0".repeat(64));
  assert.deepEqual(await forged.exit, [70, null]);
});
