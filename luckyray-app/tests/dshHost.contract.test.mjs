import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createDeterministicProvider,
  createDshHostProtocol,
  createSurfaceControlChannel,
  minimalDshEnvironment,
  parseStrictHostFrame,
  runNativeDshProbe,
  signCanonicalHostFrame,
  validateNativeTurnEvidence,
  verifyCanonicalHostFrameMac,
} from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

test("DSH minimal Windows environment resolves the official PowerShell opener without ambient PATH", {
  skip: process.platform === "win32" ? false : "Windows opener contract",
}, async () => {
  const home = join(tmpdir(), "luckyray-dsh-system-path-contract");
  const environment = minimalDshEnvironment(home);
  const systemRoot = environment.SystemRoot;
  assert.equal(environment.PATH, [
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    join(systemRoot, "System32"),
    systemRoot,
  ].join(";"));
  assert.equal(environment.PATH.includes(process.env.PATH ?? "__ambient_path_absent__"), false);

  const nested = spawn(process.execPath, [
    "-e",
    [
      'const { execFile } = require("node:child_process");',
      'execFile("powershell.exe", ["-NoProfile", "-Command", "exit 0"], (error) => {',
      '  if (error) { console.error(error.code ?? "unknown"); process.exit(1); }',
      '  process.exit(0);',
      '});',
    ].join("\n"),
  ], {
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  nested.stderr.setEncoding("utf8");
  nested.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    nested.once("error", rejectExit);
    nested.once("exit", resolveExit);
  });
  assert.equal(exitCode, 0, stderr.trim());
});

test("DSH minimal environment projects only the explicit official search credential", () => {
  const home = join(tmpdir(), "luckyray-dsh-search-credential-contract");
  const environment = minimalDshEnvironment(home, {
    DEEPSEEK_API_KEY: "epoch225-fixture-secret",
    UNRELATED_AMBIENT_SECRET: "must-not-cross",
  });
  assert.equal(environment.DEEPSEEK_API_KEY, "epoch225-fixture-secret");
  assert.equal("UNRELATED_AMBIENT_SECRET" in environment, false);

  const absent = minimalDshEnvironment(home, { DEEPSEEK_API_KEY: "" });
  assert.equal("DEEPSEEK_API_KEY" in absent, false, "missing search credentials fail closed");
});

test("DSH host protocol rejects duplicate and unknown fields before authentication", () => {
  assert.throws(
    () => parseStrictHostFrame('{"type":"bootstrap","type":"probe","protocol":1,"generation":1,"challenge":"'.concat("a".repeat(64), '"}')),
    /dsh-host-frame-invalid/,
  );
  assert.throws(
    () => parseStrictHostFrame(JSON.stringify({
      type: "bootstrap",
      protocol: 1,
      generation: 1,
      challenge: "a".repeat(64),
      extra: true,
    })),
    /dsh-host-frame-invalid/,
  );
  assert.throws(() => parseStrictHostFrame("x".repeat(8 * 1024 + 1)), /dsh-host-frame-invalid/);
  assert.throws(() => parseStrictHostFrame("{\"type\":\"bootstrap\""), /dsh-host-frame-invalid/);
});

test("DSH host protocol advances only authenticated in-order frames for one generation", async () => {
  const output = [];
  let probes = 0;
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => {
      probes += 1;
      return { sessionReady: true, turnAccepted: true, durationMs: 7 };
    },
  });
  const challenge = "b".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 9, challenge }));
  assert.equal(output[0].stage, "protocol-authenticated");
  const probe = { type: "probe", protocol: 1, generation: 9, seq: 1, requestId: "probe-1" };
  await host.accept(JSON.stringify({
    ...probe,
    mac: signCanonicalHostFrame(challenge, "parent", probe),
  }));
  assert.deepEqual(output.slice(1).map((frame) => frame.stage), [
    "session-ready",
    "turn-accepted",
    "probe-completed",
  ]);
  assert.equal(probes, 1);
  const ping = { type: "ping", protocol: 1, generation: 9, seq: 2 };
  await host.accept(JSON.stringify({
    ...ping,
    mac: signCanonicalHostFrame(challenge, "parent", ping),
  }));
  assert.equal(output.at(-1).type, "pong");
  assert.equal(output.at(-1).stage, "protocol-authenticated");
  const secondProbe = { type: "probe", protocol: 1, generation: 9, seq: 3, requestId: "probe-2" };
  await host.accept(JSON.stringify({
    ...secondProbe,
    mac: signCanonicalHostFrame(challenge, "parent", secondProbe),
  }));
  assert.equal(probes, 2, "outer-host reuse must execute a fresh native probe");
  const forged = { type: "shutdown", protocol: 1, generation: 9, seq: 3 };
  await assert.rejects(
    host.accept(JSON.stringify({ ...forged, mac: "0".repeat(64) })),
    /dsh-host-frame-invalid/,
  );
  await assert.rejects(
    host.accept(JSON.stringify({
      ...probe,
      mac: signCanonicalHostFrame(challenge, "parent", probe),
    })),
    /dsh-host-frame-invalid/,
  );
  const staleGeneration = { type: "shutdown", protocol: 1, generation: 8, seq: 3 };
  await assert.rejects(
    host.accept(JSON.stringify({
      ...staleGeneration,
      mac: signCanonicalHostFrame(challenge, "parent", staleGeneration),
    })),
    /dsh-host-frame-invalid/,
  );
  assert.equal(probes, 2);
});

test("DSH protocol MAC verifier accepts only exact 32-byte constant-time evidence", () => {
  const challenge = "c".repeat(64);
  const frame = { type: "ping", protocol: 1, generation: 7, seq: 1 };
  const mac = signCanonicalHostFrame(challenge, "parent", frame);
  assert.equal(verifyCanonicalHostFrameMac(challenge, "parent", frame, mac), true);
  for (const malformed of ["", "0".repeat(62), "0".repeat(66), "gg".repeat(32)]) {
    assert.equal(verifyCanonicalHostFrameMac(challenge, "parent", frame, malformed), false);
  }
  assert.equal(verifyCanonicalHostFrameMac(challenge, "parent", frame, "0".repeat(64)), false);
});

test("authenticated outer Host multiplexes generation-bound resource requests without a second transport", async () => {
  const output = [];
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
  });
  const challenge = "e".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 11, challenge }));
  const pending = host.requestResource("policy", { sessionId: "session-a", mode: "read-only" });
  const request = output.at(-1);
  assert.equal(request.type, "resource-request");
  assert.equal(request.generation, 11);
  assert.equal(verifyCanonicalHostFrameMac(challenge, "child", {
    ...request,
    mac: undefined,
  }, request.mac), true);
  assert.deepEqual(JSON.parse(Buffer.from(request.payload, "base64url").toString("utf8")), {
    type: "policy",
    payload: { sessionId: "session-a", mode: "read-only" },
  });
  const payload = Buffer.from(JSON.stringify({ ok: true, value: { accepted: true } }), "utf8")
    .toString("base64url");
  const response = {
    type: "resource-result", protocol: 1, generation: 11, seq: 1,
    requestId: request.requestId, payload,
  };
  await host.accept(JSON.stringify({
    ...response,
    mac: signCanonicalHostFrame(challenge, "parent", response),
  }));
  assert.deepEqual(await pending, { accepted: true });
});

test("authenticated outer Host reassembles a bounded multi-frame resource result", async () => {
  const output = [];
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
  });
  const challenge = "7".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 13, challenge }));
  const pending = host.requestResource("call", { callId: "large-result" });
  const requestId = output.at(-1).requestId;
  const encoded = Buffer.from(JSON.stringify({ ok: true, value: { body: "x".repeat(400 * 1024) } }), "utf8")
    .toString("base64url");
  const boundary = 180 * 1024;
  let seq = 0;
  for (let offset = 0; offset < encoded.length; offset += boundary) {
    seq += 1;
    const payload = encoded.slice(offset, offset + boundary);
    const frame = {
      type: offset + boundary >= encoded.length ? "resource-result" : "resource-result-chunk",
      protocol: 1,
      generation: 13,
      seq,
      requestId,
      payload,
    };
    await host.accept(JSON.stringify({
      ...frame,
      mac: signCanonicalHostFrame(challenge, "parent", frame),
    }));
  }
  const result = await pending;
  assert.equal(result.body.length, 400 * 1024);
});

test("authenticated Host shutdown rejects every unresolved resource request", async () => {
  const output = [];
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
  });
  const challenge = "f".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 12, challenge }));
  const pending = host.requestResource("call", { callId: "call-pending" });
  const shutdown = { type: "shutdown", protocol: 1, generation: 12, seq: 1 };
  await host.accept(JSON.stringify({
    ...shutdown,
    mac: signCanonicalHostFrame(challenge, "parent", shutdown),
  }));
  await assert.rejects(pending, (error) => error?.code === "dsh-resource-host-unavailable");
  assert.equal(output.at(-1).type, "shutdown-ack");
});

test("authenticated outer Host owns surface open and close on the existing generation", async () => {
  const output = [];
  const calls = [];
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
    nativeSurface: {
      open: async () => { calls.push("open"); return { stage: "surface-ready", outcome: "accepted", port: 49152, bootstrapPath: "/_luckyray/bootstrap", bootstrapRef: "c".repeat(64) }; },
      close: async () => { calls.push("close"); return { stage: "surface-closed", outcome: "accepted" }; },
    },
  });
  const challenge = "d".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 3, challenge }));
  for (const [seq, type] of [[1, "surface-open"], [2, "surface-close"]]) {
    const frame = { type, protocol: 1, generation: 3, seq, requestId: `${type}-${seq}` };
    await host.accept(JSON.stringify({ ...frame, mac: signCanonicalHostFrame(challenge, "parent", frame) }));
  }
  assert.deepEqual(calls, ["open", "close"]);
  assert.deepEqual(output.slice(1).map((frame) => [frame.type, frame.stage]), [
    ["surface-result", "surface-ready"], ["surface-result", "surface-closed"],
  ]);
  assert.equal(output[1].generation, 3, "surface does not mint a second lifecycle generation");
});

test("authenticated outer Host stages a bounded LightSeek intent through the existing surface owner", async () => {
  const output = [];
  const staged = [];
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
    nativeSurface: {
      open: async () => ({}),
      close: async () => ({}),
      stageIntent: async (payload) => { staged.push(payload); },
    },
  });
  const challenge = "d".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 10, challenge }));
  const payload = Buffer.from(JSON.stringify({
    intentId: "intent-00000001-0000-4000-8000-000000000000",
    source: "notes",
    text: "请整理这段内容",
  }), "utf8").toString("base64url");
  const intent = { type: "open-intent", protocol: 1, generation: 10, seq: 1, requestId: "open-intent-1", payload };
  await host.accept(JSON.stringify({
    ...intent,
    mac: signCanonicalHostFrame(challenge, "parent", intent),
  }));
  assert.deepEqual(staged, [payload]);
  assert.equal(output.at(-1).type, "open-intent-result");
  assert.equal(output.at(-1).requestId, "open-intent-1");
  assert.equal(verifyCanonicalHostFrameMac(challenge, "child", {
    ...output.at(-1),
    mac: undefined,
  }, output.at(-1).mac), true);
});

test("authenticated outer Host reports the carrier's real composer acknowledgement state", async () => {
  const output = [];
  const observed = [];
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
    nativeSurface: {
      open: async () => ({}), close: async () => ({}),
      intentStatus: async (id) => { observed.push(id); return { payload: "pending" }; },
    },
  });
  const challenge = "c".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 11, challenge }));
  const payload = "intent-00000001-0000-4000-8000-000000000000";
  const frame = { type: "open-intent-status", protocol: 1, generation: 11, seq: 1,
    requestId: "intent-status-1", payload };
  await host.accept(JSON.stringify({ ...frame, mac: signCanonicalHostFrame(challenge, "parent", frame) }));
  assert.deepEqual(observed, [payload]);
  assert.equal(output.at(-1).type, "open-intent-status-result");
  assert.equal(output.at(-1).payload, "pending");
  assert.equal(verifyCanonicalHostFrameMac(challenge, "child", {
    ...output.at(-1), mac: undefined,
  }, output.at(-1).mac), true);
});

test("authenticated outer Host projects one bounded provider directory on the existing surface owner", async () => {
  const output = [];
  const payload = Buffer.from(JSON.stringify({ outcome: "ready", defaultSourceIdentity: null, providers: [], secrets: [] }), "utf8")
    .toString("base64url");
  const host = createDshHostProtocol({
    writeFrame: (frame) => output.push(frame),
    nativeProbe: async () => ({ sessionReady: true, turnAccepted: true }),
    nativeSurface: {
      open: async () => ({}),
      close: async () => ({}),
      syncModel: async () => ({ payload }),
    },
  });
  const challenge = "9".repeat(64);
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: 1, generation: 6, challenge }));
  const request = { type: "model-sync", protocol: 1, generation: 6, seq: 1, requestId: "model-sync-1" };
  await host.accept(JSON.stringify({
    ...request,
    mac: signCanonicalHostFrame(challenge, "parent", request),
  }));
  const result = output.at(-1);
  assert.deepEqual({ type: result.type, requestId: result.requestId, payload: result.payload }, {
    type: "model-sync-result", requestId: "model-sync-1", payload,
  });
  assert.equal(verifyCanonicalHostFrameMac(challenge, "child", { ...result, mac: undefined }, result.mac), true);
});

test("surface private channel multiplexes exact ACKs and ordered official state lines", async () => {
  const stream = new PassThrough();
  const states = [];
  let invalid = 0;
  const channel = createSurfaceControlChannel({
    stream,
    onState: (generation, sessionOpen) => states.push([generation, sessionOpen]),
    onInvalid: () => { invalid += 1; },
  });
  channel.setBinding(7);
  const waiting = channel.waitAck(1, "binding-open-ack");
  stream.write(`${JSON.stringify({ type: "binding-open-ack", seq: 1, outcome: "accepted" })}
`);
  await waiting;
  for (const sessionOpen of [null, "session-official-1"]) {
    stream.write(`${JSON.stringify({
      type: "surface-state", carrierGeneration: 7, clientReady: true, sessionOpen,
    })}
`);
  }
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(states, [[7, null], [7, "session-official-1"]]);
  assert.equal(invalid, 0);

  stream.write(`${JSON.stringify({
    type: "surface-state", carrierGeneration: 6, clientReady: true, sessionOpen: null,
  })}
`);
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(invalid, 1, "state from a stale carrier generation invalidates the owned carrier");
  channel.close();
});

test("surface private channel rejects mismatched control acknowledgements", async () => {
  const stream = new PassThrough();
  let invalid = 0;
  const channel = createSurfaceControlChannel({
    stream,
    onState() {},
    onInvalid: () => { invalid += 1; },
  });
  channel.setBinding(1);
  const waiting = channel.waitAck(1, "binding-close-ack");
  stream.write(`${JSON.stringify({
    type: "binding-close-ack", seq: 1, outcome: "rejected",
  })}
`);
  await assert.rejects(waiting, /dsh-native-probe-failed/);
  assert.equal(invalid, 1);
});

test("surface private channel rejects unrequested launch acknowledgements", async () => {
  for (const extra of [{}, { launchUrl: "http://127.0.0.1:43210/?token=fixture" }]) {
    const stream = new PassThrough();
    let invalid = 0;
    const channel = createSurfaceControlChannel({ stream, onState() {}, onInvalid() { invalid += 1; } });
    stream.write(`${JSON.stringify({ type: "launch-url-ack", seq: 1, outcome: "accepted", ...extra })}\n`);
    await new Promise((done) => setImmediate(done));
    assert.equal(invalid, 1, "one-way launch notification has no valid ACK or pending request");
    channel.close();
  }
});

test("surface private channel accepts one correlated provider directory within the bounded control frame", async () => {
  const stream = new PassThrough();
  let invalid = 0;
  const channel = createSurfaceControlChannel({
    stream,
    onState() {},
    onInvalid: () => { invalid += 1; },
  });
  channel.setBinding(3);
  const waiting = channel.waitAck(1, "model-sync-result");
  const payload = "a".repeat(200 * 1024);
  stream.write(`${JSON.stringify({
    type: "model-sync-result", seq: 1, outcome: "accepted", payload,
  })}\n`);
  assert.equal((await waiting).payload, payload);
  assert.equal(invalid, 0);
  channel.close();
});

test("surface private channel treats a missing control ACK as an unsettled owned generation", async () => {
  const stream = new PassThrough();
  let invalid = 0;
  const channel = createSurfaceControlChannel({
    stream,
    onState() {},
    onInvalid: () => { invalid += 1; },
  });
  channel.setBinding(2);
  await assert.rejects(channel.waitAck(1, "binding-close-ack", 20), /dsh-native-probe-failed/u);
  assert.equal(invalid, 1);
  await assert.rejects(channel.waitAck(2, "binding-open-ack", 20), /dsh-native-probe-failed/u);
});

test("DSH native evidence accepts one exact ordered turn and rejects mixed evidence", () => {
  const prompt = "LUCKYRAY_DSH_NATIVE_PROBE";
  const response = "DSH_NATIVE_ACCEPTED";
  const provider = {
    requestCount: 1,
    exactTurnRequestCount: 1,
    auxiliaryRequestCount: 0,
    exactPrompt: true,
    exactResponse: true,
  };
  const valid = [
    { type: "session", id: "session-test-12345678" },
    { seq: 1, type: "turn/start", data: { turn: 4 } },
    { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: prompt } },
    { seq: 3, type: "assistant/message", data: { turn: 4, message: { content: response } } },
    { seq: 4, type: "turn/end", data: { turn: 4, reason: { kind: "completed" } } },
  ];
  assert.deepEqual(validateNativeTurnEvidence(valid, provider), { turn: 4 });

  const invalid = [
    [...valid, { seq: 5, type: "turn/start", data: { turn: 5 } }],
    [valid[0], valid[1], valid[3], valid[2], valid[4]],
    [valid[0], valid[1], valid[2], { ...valid[3], data: { ...valid[3].data, turn: 9 } }, valid[4]],
    [valid[0], valid[1], valid[2], valid[3], { ...valid[4], data: { ...valid[4].data, turn: 9 } }],
    [valid[0], valid[1], valid[2], valid[3], valid[3], valid[4]],
  ];
  for (const events of invalid) {
    assert.throws(() => validateNativeTurnEvidence(events, provider), /dsh-native-probe-failed/);
  }
  assert.throws(
    () => validateNativeTurnEvidence(valid, {
      requestCount: 1,
      exactTurnRequestCount: 1,
      exactPrompt: true,
      exactResponse: false,
    }),
    /dsh-native-probe-failed/,
  );
  assert.throws(
    () => validateNativeTurnEvidence(valid, { ...provider, exactTurnRequestCount: 2 }),
    /dsh-native-probe-failed/,
  );
  assert.throws(
    () => validateNativeTurnEvidence(valid, { ...provider, requestCount: 2 }),
    /dsh-native-probe-failed/,
  );
  assert.throws(
    () => validateNativeTurnEvidence(valid, {
      ...provider,
      requestCount: 2,
      auxiliaryRequestCount: 1,
    }),
    /dsh-native-probe-failed/,
  );
});

test("DSH diagnostic Provider answers only the one exact probe request", async () => {
  const { server, evidence } = createDeterministicProvider();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address();
    const exact = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "LUCKYRAY_DSH_NATIVE_PROBE" }],
      }),
    });
    const exactBody = await exact.text();
    assert.equal(exact.status, 200);
    assert.match(exactBody, /DSH_NATIVE_ACCEPTED/u);

    const auxiliary = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Generate a title" }],
      }),
    });
    const auxiliaryBody = await auxiliary.text();
    assert.equal(auxiliary.status, 422);
    assert.equal(auxiliaryBody.includes("DSH_NATIVE_ACCEPTED"), false);
    assert.deepEqual(evidence, {
      requestCount: 2,
      exactTurnRequestCount: 1,
      auxiliaryRequestCount: 1,
      exactPrompt: true,
      exactResponse: true,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const secondProvider = createDeterministicProvider();
  await new Promise((resolve, reject) => {
    secondProvider.server.once("error", reject);
    secondProvider.server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = secondProvider.server.address();
    for (const content of ["Generate a title", "LUCKYRAY_DSH_NATIVE_PROBE"]) {
      const response = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content }] }),
      });
      const body = await response.text();
      assert.equal(response.status, 422, "auxiliary-first poisons the diagnostic attempt");
      assert.equal(body.includes("DSH_NATIVE_ACCEPTED"), false);
    }
    assert.deepEqual(secondProvider.evidence, {
      requestCount: 2,
      exactTurnRequestCount: 0,
      auxiliaryRequestCount: 2,
      exactPrompt: false,
      exactResponse: false,
    });
  } finally {
    await new Promise((resolve) => secondProvider.server.close(resolve));
  }

  const duplicateProvider = createDeterministicProvider();
  await new Promise((resolve, reject) => {
    duplicateProvider.server.once("error", reject);
    duplicateProvider.server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = duplicateProvider.server.address();
    const statuses = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "LUCKYRAY_DSH_NATIVE_PROBE" }],
        }),
      });
      const body = await response.text();
      statuses.push(response.status);
      if (index === 1) assert.equal(body.includes("DSH_NATIVE_ACCEPTED"), false);
    }
    assert.deepEqual(statuses, [200, 422]);
    assert.deepEqual(duplicateProvider.evidence, {
      requestCount: 2,
      exactTurnRequestCount: 1,
      auxiliaryRequestCount: 1,
      exactPrompt: true,
      exactResponse: true,
    });
  } finally {
    await new Promise((resolve) => duplicateProvider.server.close(resolve));
  }

  const messagesProvider = createDeterministicProvider();
  await new Promise((resolve, reject) => {
    messagesProvider.server.once("error", reject);
    messagesProvider.server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = messagesProvider.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: [
        { type: "text", text: "LUCKYRAY_DSH_NATIVE_PROBE" },
        { type: "text", text: "Current runtime context. Synthetic diagnostic only." },
      ] }] }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: message_start/u);
    assert.match(body, /event: message_stop/u);
    assert.match(body, /DSH_NATIVE_ACCEPTED/u);
    assert.deepEqual(messagesProvider.evidence, {
      requestCount: 1, exactTurnRequestCount: 1, auxiliaryRequestCount: 0,
      exactPrompt: true, exactResponse: true,
    });
  } finally {
    await new Promise((resolve) => messagesProvider.server.close(resolve));
  }

  // The 0.2 official profile adds a skills catalog beside the unchanged probe.
  const skillsProvider = createDeterministicProvider();
  await new Promise((resolve) => skillsProvider.server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${skillsProvider.server.address().port}/v1/messages`;
    const request = (thirdText) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: [
        { type: "text", text: "LUCKYRAY_DSH_NATIVE_PROBE" },
        { type: "text", text: "Current runtime context. Synthetic diagnostic only." },
        { type: "text", text: thirdText },
      ] }] }),
    });
    const accepted = await request("<system-reminder>\nA skill is a reusable set of task-specific instructions. Synthetic catalog.\n</system-reminder>");
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /DSH_NATIVE_ACCEPTED/u);
    const unexpected = await request("Generate a title or run another task");
    assert.equal(unexpected.status, 422);
    assert.equal((await unexpected.text()).includes("DSH_NATIVE_ACCEPTED"), false);
    assert.equal(skillsProvider.evidence.exactTurnRequestCount, 1);
    assert.equal(skillsProvider.evidence.auxiliaryRequestCount, 1);
  } finally {
    await new Promise((resolve) => skillsProvider.server.close(resolve));
  }
});

test("DSH production host boundary has zero Agent and product authority imports", async () => {
  const rust = await readFile(new URL("../src-tauri/src/dsh_host.rs", import.meta.url), "utf8");
  const host = await readFile(new URL("../src-tauri/dsh-host/luckyray-dsh-host.mjs", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/core/services/dshHost.ts", import.meta.url), "utf8");
  const combined = `${rust}\n${host}\n${client}`;
  for (const forbidden of [
    "crate::agent_engine",
    "AgentChild",
    "RunCoordinator",
    "sharedAgentEngineLifecycle",
    "ToolRegistry",
    "WorkspaceGrant",
    "KnowledgeRunScope",
    "Agent Browser",
    "Canvas",
    "setInterval(",
  ]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
  assert.match(host, /timingSafeEqual\(expected, received\)/u);
  assert.match(rust, /verify_slice\(&received\)/u);
});

test("DSH native probe derives readiness from rc.2 session and inbox evidence", {
  skip: process.env.DSH_TEST_RUNTIME_ROOT ? false : "requires the verified DSH-0 runtime fixture",
  timeout: 90_000,
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "luckyray-dsh-rc2-state-contract-"));
  const observedSessionIds = [];
  try {
    await writeFile(
      join(stateRoot, "luckyray-native-probe.patch.yml"),
      "- id: legacy-probe-patch\n  disabled: true\n",
      "utf8",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let observedEvidence;
      const result = await runNativeDshProbe({
        runtimeRoot: process.env.DSH_TEST_RUNTIME_ROOT,
        stateRoot,
        observeEvents: (events, evidence) => {
          observedSessionIds.push(events.find((event) => event?.type === "session")?.id);
          observedEvidence = evidence;
        },
      });
      assert.equal(result.sessionReady, true);
      assert.equal(result.turnAccepted, true);
      assert.equal(result.probeCompleted, true);
      assert.equal(result.nativeEventEvidence, true);
      assert.equal(
        await readFile(join(stateRoot, "luckyray-native-probe.patch.yml"), "utf8"),
        "- id: session-title-llm\n  disabled: true\n",
        "the deterministic app-owned probe patch replaces stale prior-version bytes",
      );
      assert.deepEqual(observedEvidence, {
        requestCount: 1,
        exactTurnRequestCount: 1,
        auxiliaryRequestCount: 0,
        exactPrompt: true,
        exactResponse: true,
      });
    }
    assert.equal(new Set(observedSessionIds).size, 2);
    assert.ok((await readdir(join(stateRoot, "sessions"), { recursive: true })).length >= 2);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
