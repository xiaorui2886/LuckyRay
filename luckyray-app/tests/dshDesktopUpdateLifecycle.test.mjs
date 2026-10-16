import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopUpdateLifecycle } from "../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs";
import surfaceState from "../src-tauri/dsh-host/luckyray-dsh-native-surface-state/client.js";

function harness(options) {
  const events = [];
  const listeners = new Map();
  const session = { id: "synthetic-session", seq: 3 };
  let busy = false;
  const agent = { session, id: session.id, status: "idle", inbox: { hasPending: false },
    runMaintenance(operation) {
      if (busy || this.status !== "idle") throw Error("agent-not-idle");
      busy = true;
      return operation(new AbortController().signal).finally(() => { busy = false; });
    } };
  const services = {
    agents: { list: () => [agent] },
    sessions: { list: () => [session], flush: async () => { events.push("session-flush"); return true; } },
    sessionPersistence: { flush: async () => events.push("persistence-flush") },
    jobs: { list: () => [] },
    schedule: { catalog: async () => [] },
  };
  const ctx = { get: key => services[key], on: (key, fn) => {
    listeners.set(key, fn); return () => listeners.delete(key);
  }, waterfall: async () => [], root: { fiber: { dispose: async () => events.push("disposed") } } };
  let clientResult = { ready: true };
  const lifecycle = createDesktopUpdateLifecycle(ctx, {
    checkClient: async () => clientResult,
    setPaused: paused => events.push(paused ? "hold" : "resume"),
    retireConnections: () => events.push("connections-retired"),
  }, options);
  return { lifecycle, events, services, agent, session, listeners, ctx,
    setClient: result => { clientResult = result; }, busy: () => busy };
}

test("an open but idle official session obtains real durability confirmation and a reversible maintenance hold", async () => {
  const h = harness();
  assert.deepEqual(await h.lifecycle.prepare("round-1"), { ready: true, saved: true, sessionCount: 1 });
  assert.equal(h.busy(), true);
  assert.deepEqual(h.events, ["hold", "session-flush", "persistence-flush"]);
  assert.throws(() => h.listeners.get("agent/created")(), /update-lsh-preparing/);
  await h.lifecycle.cancel("round-1");
  assert.equal(h.busy(), false);
  assert.equal(h.events.at(-1), "resume");
  assert.equal(h.listeners.has("agent/created"), false);
});

test("a running turn (including approval wait) refuses without cancelling the task or flushing over it", async () => {
  const h = harness();
  h.agent.status = "running";
  await assert.rejects(h.lifecycle.prepare("round-2"), /update-lsh-task-active/);
  assert.equal(h.agent.status, "running");
  assert.deepEqual(h.events, ["hold", "resume"]);
  h.agent.status = "idle";
  await h.lifecycle.prepare("round-3");
  await h.lifecycle.cancel("round-3");
});

test("queued input, background jobs and active schedules each refuse update without deleting their work", async () => {
  for (const family of ["inbox", "job", "schedule"]) {
    const h = harness();
    if (family === "inbox") h.agent.inbox.hasPending = true;
    if (family === "job") h.services.jobs.list = () => [{ status: "running" }];
    if (family === "schedule") h.services.schedule.catalog = async () => [{ status: "active" }];
    await assert.rejects(h.lifecycle.prepare(`round-${family}`), /update-lsh-(?:task|schedule)-active/);
    assert.equal(h.events.at(-1), "resume");
  }
});

test("missing durability participant, write failure and an uncommitted client input all fail closed and release admission", async () => {
  for (const failure of ["participant", "write", "composition", "draft"]) {
    const h = harness();
    if (failure === "participant") h.services.sessions.flush = async () => false;
    if (failure === "write") h.services.sessionPersistence.flush = async () => { throw Error("synthetic-write-failed"); };
    if (failure === "composition" || failure === "draft") h.setClient({ ready: false, reason: `update-lsh-${failure}-pending` });
    await assert.rejects(h.lifecycle.prepare(`round-${failure}`), /update-lsh-(?:save-failed|composition-pending|draft-pending)/);
    assert.equal(h.busy(), false);
    assert.equal(h.events.at(-1), "resume");
  }
});

test("only the exact saved round can commit; normal application disposal is awaited before exit is authorized", async () => {
  const h = harness();
  await h.lifecycle.prepare("round-4");
  await assert.rejects(h.lifecycle.commit("old-round"), /update-lsh-round-invalid/);
  assert.equal(h.busy(), true);
  assert.deepEqual(await h.lifecycle.commit("round-4"), { stopped: true, saved: true });
  assert.ok(h.events.indexOf("connections-retired") > h.events.indexOf("persistence-flush"));
  assert.ok(h.events.indexOf("connections-retired") < h.events.indexOf("disposed"));
  assert.ok(h.events.indexOf("persistence-flush") < h.events.indexOf("disposed"));
});

test("a stalled save times out without authorizing exit, releases the hold, and late completion cannot revive the round", { timeout: 300 }, async () => {
  const h = harness({ timeoutMs: 20 });
  let finish;
  h.services.sessionPersistence.flush = () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(h.lifecycle.prepare("round-timeout"), /update-lsh-save-timeout/);
  assert.equal(h.busy(), false);
  assert.equal(h.events.at(-1), "resume");
  finish();
  await assert.rejects(h.lifecycle.commit("round-timeout"), /update-lsh-round-invalid/);
});

test("service replacement and late queued input cannot turn a saved observation into exit permission", async () => {
  for (const kind of ["identity", "queued"]) {
    const h = harness();
    h.services.sessionPersistence.flush = async () => {
      if (kind === "identity") h.services.agents = { list: () => [h.agent] };
      else h.agent.inbox.hasPending = true;
    };
    await assert.rejects(h.lifecycle.prepare(`late-${kind}`), /update-lsh-(?:identity-changed|task-active)/);
    assert.equal(h.busy(), false);
    assert.equal(h.events.at(-1), "resume");
  }
});

test("a newer official Session revision after prepare refuses commit and permits cancellation, not a stale saved ACK", async () => {
  const h = harness();
  await h.lifecycle.prepare("saved-revision");
  h.session.seq += 1;
  await assert.rejects(h.lifecycle.commit("saved-revision"), /update-lsh-content-changed/);
  assert.equal(h.events.includes("connections-retired"), false);
  assert.equal(h.events.includes("disposed"), false);
  await h.lifecycle.cancel("saved-revision");
  assert.equal(h.busy(), false);
  assert.equal(h.events.at(-1), "resume");
});

test("an unconfirmed official exit times out without granting install permission; late disposal cannot revive that failed attempt", async () => {
  const h = harness({ timeoutMs: 20 });
  let finish;
  h.ctx.root.fiber.dispose = () => new Promise(resolve => { finish = resolve; });
  await h.lifecycle.prepare("exit-timeout");
  await assert.rejects(h.lifecycle.commit("exit-timeout"), /update-lsh-exit-timeout/);
  assert.equal(h.busy(), false);
  assert.ok(h.events.indexOf("connections-retired") > h.events.indexOf("persistence-flush"));
  // Unknown real teardown cannot safely be called idle or forcibly killed.
  // The updater reports failure, keeps the app open and can cancel its intent;
  // this old failed stop must never later authorize installation by itself.
  finish();
  await assert.rejects(h.lifecycle.commit("exit-timeout"), /update-lsh-round-invalid/);
});

test("the actual client guard reports controlled composition and drafts, then restores only its own inert state on cancel", async () => {
  const document = new EventTarget(); document.body = { inert: false };
  let ticket = { id: "client-round", generation: 9 };
  let draft = "";
  const acknowledgements = [];
  let catalogPhase = "ready";
  let references = 1;
  const sessions = {
    list: { getSnapshot: () => ({ ids: ["synthetic"], byId: { synthetic: {} }, phase: catalogPhase }) },
    scope: () => references ? {} : undefined,
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: references }) }),
    sessionOf: () => ({ getSnapshot: () => ({ sessionId: "synthetic", openState: "open", running: false, pendingSubmissions: [] }) }),
  };
  let phase = "plain";
  const conversation = { input: { for: () => ({ state: { getSnapshot: () => ({ draft, attachmentIds: [], phase }) } }) } };
  const client = surfaceState.createUpdateClient(sessions, conversation, async (_path, options) => {
    if (options?.method === "POST") { acknowledgements.push(JSON.parse(options.body)); return { ok: true }; }
    return ticket ? { ok: true, status: 200, json: async () => ticket } : { ok: true, status: 204 };
  }, document);
  document.dispatchEvent(new Event("compositionstart"));
  await client.poll();
  assert.equal(acknowledgements.at(-1).reason, "update-lsh-composition-pending");
  document.dispatchEvent(new Event("compositionend"));
  draft = "合成未发送输入";
  await client.poll();
  assert.equal(acknowledgements.at(-1).reason, "update-lsh-draft-pending");
  draft = "";
  phase = undefined;
  await client.poll();
  assert.equal(acknowledgements.at(-1).ready, false, "a missing official submit phase cannot authorize exit");
  assert.equal(acknowledgements.at(-1).reason, "update-lsh-client-unavailable");
  phase = "plain";
  await client.poll();
  assert.equal(acknowledgements.at(-1).ready, true);
  references = 0;
  await client.poll();
  assert.equal(acknowledgements.at(-1).ready, true, "a catalog-only session owns no live browser draft");
  catalogPhase = "pending";
  await client.poll();
  assert.equal(acknowledgements.at(-1).ready, false, "an empty-looking list still loading is not idle evidence");
  catalogPhase = "ready";
  const historical = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`history-${i}`, {}]));
  sessions.list.getSnapshot = () => ({ ids: Object.keys(historical), byId: historical, phase: "ready" });
  await client.poll();
  assert.equal(acknowledgements.at(-1).ready, true, "historical catalog size is not a count of resident editors or busy tasks");
  assert.equal(document.body.inert, true);
  ticket = null;
  await client.poll();
  assert.equal(document.body.inert, false);
  client.dispose();
});
