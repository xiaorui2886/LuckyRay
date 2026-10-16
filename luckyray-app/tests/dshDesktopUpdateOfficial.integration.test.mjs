import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createNativeSurfaceOwner } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";
import { installReadOnlyLifecycleObservation } from "./fixtures/dshUpdateReadOnlyObservation.mjs";

test("the frozen official runtime refuses a real running Agent, then flushes and exits its idle session through the signed host lifecycle", { timeout: 90_000 }, async t => {
  const runtime = process.env.DSH_UPDATE_RUNTIME_ROOT;
  assert.ok(runtime, "an explicit verified frozen runtime is required");
  const home = await mkdtemp(join(tmpdir(), "luckyray-update-official-"));
  const timeline = [];
  const record = async (stage, result) => { timeline.push({ stage, result, atUtc: new Date().toISOString() }); await writeFile(join(home, "timeline.json"), JSON.stringify(timeline, null, 2)); };
  const hostSource = resolve("src-tauri/dsh-host");
  for (const name of ["authenticated-webserver", "resource-tools", "native-surface-state", "lightseek-ui"]) {
    await cp(join(hostSource, `luckyray-dsh-${name}`), join(home, "profiles/node_modules/@luckyray", `dsh-${name}`), { recursive: true });
  }
  const fixture = join(home, "profiles/node_modules/@luckyray/update-fixture");
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "@luckyray/update-fixture", type: "module", main: "index.mjs" }));
  const official = name => pathToFileURL(join(runtime, "host/node_modules/@deepseek-ai", name, "lib/index.js")).href;
  await writeFile(join(fixture, "index.mjs"), `
import { LlmAdapter, createUserMessage } from ${JSON.stringify(official("dsh-llm"))};
import { appendFileSync } from "node:fs";
export async function apply(ctx) {
  if (${process.env.DSH_UPDATE_TRACE_FIBERS === "1"}) (${installReadOnlyLifecycleObservation.toString()})(ctx, appendFileSync, ${JSON.stringify(join(home, "fiber-states.jsonl"))});
  let release, entered = false, openStream;
  const completion = new Promise(resolve => { release = resolve; });
  class Controlled extends LlmAdapter {
    async *stream() {
      entered = true; await completion;
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "Synthetic task complete" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "Synthetic task complete" } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  ctx.llm.registerAdapter(["update-fixture"], new Controlled());
  const handle = await ctx.agents.create({ sessionId: "update-official-synthetic", meta: { cwd: ${JSON.stringify(home)} },
    agentOptions: { provider: "update-fixture", model: "controlled" } });
  const agent = handle.agent;
  ctx.webServer.register({ kind: "exact", path: "/_luckyray/update-fixture", async handler(req, res) {
    if (req.method === "POST" && req.url.endsWith("?start")) agent.followup(createUserMessage({ content: [{ type: "text", text: "Synthetic bounded update task" }], source: { kind: "user" } }));
    if (req.method === "POST" && req.url.endsWith("?finish")) { release?.(); await agent.whenIdle(); }
    if (req.url.endsWith("?probe-stream") && openStream && !openStream.destroyed) openStream.write("data: alive after cancel\\n\\n");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: agent.status, entered, seq: agent.session.seq, streamOpen: Boolean(openStream && !openStream.destroyed) }));
  } });
  ctx.webServer.register({ kind: "exact", path: "/_luckyray/update-fixture-stream", handler(_req, res) {
    openStream = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: synthetic owned transport\\n\\n");
  } });
}`);
  const patch = join(home, "surface.patch.yml");
  await writeFile(patch, await readFile(join(hostSource, "luckyray-dsh-native-surface.patch.yml"), "utf8")
    + '\n    - id: update-fixture\n      name: "@luckyray/update-fixture"\n      inject: [webServer, agents, sessions, sessionPersistence, jobs, llm]\n');
  let child;
  let browser;
  let page;
  let streamAbort;
  let streamReader;
  let diagnostics = "";
  const owner = createNativeSurfaceOwner({ runtimeRoot: runtime, stateRoot: home, surfaceHome: home, surfacePatch: patch,
    onChildStarted(value) { child = value; value.stdout.resume(); value.stderr.on("data", bytes => {
      diagnostics = (diagnostics + bytes.toString("utf8")).slice(-12_000);
    }); } });
  let completed = false;
  try {
    // The tested Agent uses only Controlled. Do not project any ambient paid
    // provider credential into this disposable runtime (including auxiliaries).
    const inheritedProviderKey = process.env.DEEPSEEK_API_KEY;
    let opened;
    delete process.env.DEEPSEEK_API_KEY;
    try { opened = await owner.open(); }
    finally {
      if (inheritedProviderKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = inheritedProviderKey;
    }
    await record("carrier-open");
    assert.equal(opened.outcome, "accepted");
    const base = `http://127.0.0.1:${opened.port}`;
    let cookie;
    if (process.env.DSH_UPDATE_UI_TOOLS) {
      const { chromium } = await import(pathToFileURL(join(process.env.DSH_UPDATE_UI_TOOLS, "node_modules/playwright-core/index.mjs")));
      browser = await chromium.launch({ channel: "msedge", headless: true });
      page = await browser.newPage();
      await page.goto(`${base}${opened.bootstrapPath}?ref=${opened.bootstrapRef}`)
        .catch(() => { throw Error("actual-browser-bootstrap-failed; private bootstrap reference omitted"); });
      await page.getByRole("textbox").first().waitFor();
      await page.screenshot({ path: join(home, "real-client-before-hold.png") });
      cookie = (await page.context().cookies(base)).map(item => `${item.name}=${item.value}`).join("; ");
      await record("actual-browser-client-loaded", { productClientAsset: true, simulatedIME: false });
    } else {
      const boot = await fetch(`${base}${opened.bootstrapPath}?ref=${opened.bootstrapRef}`, { redirect: "manual" });
      cookie = boot.headers.get("set-cookie").split(";", 1)[0];
    }
    const request = (path, options = {}) => fetch(base + path, { signal: AbortSignal.timeout(10_000), ...options, headers: { cookie, ...options.headers } });
    const wait = async fn => {
      for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
      throw Error("official fixture did not settle");
    };
    await wait(async () => (await request("/_luckyray/update-fixture")).status === 200);
    await record("official-agent-created");
    await request("/_luckyray/update-fixture?start", { method: "POST" });
    await wait(async () => (await (await request("/_luckyray/update-fixture")).json()).entered);
    await record("real-task-running");
    const busy = await owner.update("update-prepare", { id: "real-busy" });
    assert.equal(busy.ready, false);
    assert.equal(busy.reason, "update-lsh-task-active");
    await record("busy-refused-without-cancel");
    const running = await (await request("/_luckyray/update-fixture")).json();
    assert.equal(running.status, "running", "the real official task was not cancelled");
    await request("/_luckyray/update-fixture?finish", { method: "POST" });
    await record("real-task-completed");
    if (process.env.DSH_UPDATE_HTTP_STREAM === "1") {
      streamAbort = new AbortController();
      const stream = await fetch(base + "/_luckyray/update-fixture-stream", { signal: streamAbort.signal, headers: { cookie } });
      assert.equal(stream.status, 200);
      streamReader = stream.body.getReader();
      assert.match(new TextDecoder().decode((await streamReader.read()).value), /synthetic owned transport/);
      await record("real-owned-http-stream-open", { contentType: stream.headers.get("content-type") });
    }
    const prepare = async id => {
      const pending = owner.update("update-prepare", { id });
      if (page) return pending; // The actual packaged client must ACK itself.
      const ticket = await wait(async () => {
        const response = await request("/_luckyray/desktop-update");
        return response.status === 200 ? response.json() : null;
      });
      // This is an explicitly controlled client boundary, not real browser/IME
      // acceptance. The installed continuous chains exercise the actual client.
      assert.equal((await request("/_luckyray/desktop-update", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ticket, ready: true, reason: null }) })).status, 204);
      return pending;
    };
    const first = await prepare("real-idle-cancel");
    await record("prepared-idle", first);
    assert.equal(first.ready, true); assert.equal(first.saved, true); assert.ok(first.sessionCount >= 1);
    assert.equal((await owner.update("update-cancel", { id: "real-idle-cancel" })).cancelled, true);
    await record("cancelled");
    assert.equal((await request("/_luckyray/update-fixture")).status, 200, "cancellation restores actual HTTP admission");
    if (streamReader) {
      assert.equal((await (await request("/_luckyray/update-fixture?probe-stream")).json()).streamOpen, true);
      assert.match(new TextDecoder().decode((await streamReader.read()).value), /alive after cancel/);
      await record("owned-http-stream-preserved-through-cancel");
    }
    if (page) {
      await page.waitForFunction(() => document.body.inert === false);
      await record("actual-browser-cancel-interaction-restored");
    }
    const second = await prepare("real-idle-stop");
    await record("prepared-again");
    assert.equal(second.saved, true);
    const stopped = await owner.update("update-stop", { id: "real-idle-stop" });
    await record("graceful-stop-result", stopped);
    assert.equal(stopped.stopped, true, JSON.stringify(stopped)); assert.equal(stopped.saved, true);
    assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
    completed = true;
    t.diagnostic(`Frozen runtime 0.1.7-rc.2: real turn blocked/preserved, idle flush/cancel/normal exit0; ${page ? "actual product browser ACK" : "controlled client boundary"}; synthetic home retained ${home}`);
  } finally {
    // Save the failed state BEFORE test transport cleanup can release it.
    await writeFile(join(home, "synthetic-startup.stderr.txt"), diagnostics);
    const out = process.env.DSH_UPDATE_EVIDENCE_ROOT;
    if (out) {
      await mkdir(out, { recursive: true });
      for (const name of ["timeline.json", "fiber-states.jsonl", "synthetic-startup.stderr.txt", "real-client-before-hold.png"]) {
        try { await cp(join(home, name), join(out, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await writeFile(join(out, "runtime-result.json"), JSON.stringify({ completed, runtime, pid: child?.pid,
        browserClient: Boolean(page), ownedHttpStream: Boolean(streamAbort), observationOnly: true,
        noForcedTermination: true, home }, null, 2));
    }
    if (!completed) t.diagnostic(diagnostics.slice(-5000));
    streamAbort?.abort(); // Only the test's own synthetic request, after evidence.
    await browser?.close();
    if (!completed && child?.exitCode === null) {
      t.diagnostic(`Failed isolated official runtime retained without forced termination: ${home}; PID ${child.pid}`);
      for (const stream of child.stdio) stream?.unref?.();
      child.unref();
    }
  }
});
