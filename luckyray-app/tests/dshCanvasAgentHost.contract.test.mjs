import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CANVAS_AGENT_MAX_JSON_BYTES, CANVAS_AGENT_MAX_ENCODED_BYTES,
  createDshHostProtocol, createSurfaceControlChannel, createNativeSurfaceOwner,
  decodeCanvasAgentPayload, validateCanvasAgentRequest,
  signCanonicalHostFrame, verifyCanonicalHostFrameMac,
} from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

const challenge = "c".repeat(64);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const snapshot = status => ({canvasId: "canvas-1", conversationId: "conversation-test", sessionId: null, runId: status === "idle" ? null : "run-1", status, messages: []});
const start = () => ({op: "start", canvasId: "canvas-1", conversationId: "conversation-test", requestId: "request-1", prompt: "Make a plan", context: {
  version: 1, canvasId: "canvas-1", canvasName: "Canvas", nodes: [], connections: [],
  generation: {imageModels: [], videoModels: [], imageReady: false, videoReady: false},
}});
function signed(type, seq, extra = {}) {
  const frame = {type, protocol: 1, generation: 4, seq, ...(type === "ping" ? {} : {requestId: `canvas-${seq}`}), ...extra};
  return JSON.stringify({...frame, mac: signCanonicalHostFrame(challenge, "parent", frame)});
}
async function setup(nativeSurface = {}) {
  const output = [];
  const host = createDshHostProtocol({writeFrame: frame => output.push(frame), nativeSurface});
  await host.accept(JSON.stringify({type: "bootstrap", protocol: 1, generation: 4, challenge}));
  return {host, output};
}

test("canvas wire is bounded canonical base64url JSON and rejects malformed UTF-8", () => {
  assert.equal(CANVAS_AGENT_MAX_JSON_BYTES, 2 * 1024 * 1024);
  assert.equal(CANVAS_AGENT_MAX_ENCODED_BYTES, Math.ceil(2 * 1024 * 1024 / 3) * 4);
  assert.deepEqual(decodeCanvasAgentPayload(encode(start())), start());
  for (const payload of ["", "=", "ew==", "ew+", "_w", "a".repeat(CANVAS_AGENT_MAX_ENCODED_BYTES + 1), encode("x".repeat(CANVAS_AGENT_MAX_JSON_BYTES))]) {
    assert.throws(() => decodeCanvasAgentPayload(payload), /canvas-agent-invalid-request/);
  }
});

test("canvas request supports exactly status/models/start/cancel with bounded identity and context", () => {
  for (const request of [{op: "status", canvasId: "canvas-1"}, {op:"models",canvasId:"canvas-1"}, {...start(),modelSelection:{provider:"configured",model:"chosen"}}, start(), {op: "cancel", canvasId: "canvas-1", runId: "run-1"}]) {
    assert.equal(validateCanvasAgentRequest(request), request);
  }
  for (const request of [
    null, [], {op: "shell", canvasId: "canvas-1"}, {op: "status", canvasId: "../../escape"},
    {op: "status", canvasId: "canvas-1", path: "/tmp/other"},
    {op: "cancel", canvasId: "canvas-1", runId: ""},
    {...start(), prompt: " "}, {...start(), prompt: "你".repeat(48001)},
    {...start(), context: {...start().context, canvasId: "canvas-2"}},
    {...start(), context: {...start().context, nodes: Array(17).fill({})}},
    {...start(), context: {...start().context, connections: Array(65).fill({})}},
    {...start(),modelSelection:{provider:"configured",model:"chosen",apiKey:"secret"}},
    {...start(), credential: "must-not-cross"},
  ]) assert.throws(() => validateCanvasAgentRequest(request), /canvas-agent-invalid-request/);
});

test("authenticated canvas dispatch returns immediate snapshots and does not own model lifetime", async () => {
  const requests = [];
  let status = "idle";
  const {host, output} = await setup({canvasAgent: async payload => {
    const request = decodeCanvasAgentPayload(payload); requests.push(request);
    if (request.op === "start") status = "running";
    if (request.op === "cancel") status = "cancelled";
    return {payload: encode(snapshot(status))};
  }});
  for (const [i, request] of [start(), {op: "status", canvasId: "canvas-1"}, {op: "cancel", canvasId: "canvas-1", runId: "run-1"}].entries()) {
    await host.accept(signed("canvas-agent", i + 1, {payload: encode(request)}));
    const result = output.at(-1);
    assert.equal(result.type, "canvas-agent-result");
    assert.equal(result.requestId, `canvas-${i + 1}`);
    assert.equal(result.outcome, "accepted");
    assert.equal(decodeCanvasAgentPayload(result.payload).status, i === 2 ? "cancelled" : "running");
    assert.equal(verifyCanonicalHostFrameMac(challenge, "child", result, result.mac), true);
  }
  assert.equal(requests.length, 3);
  await host.accept(signed("ping", 4));
  assert.equal(output.at(-1).type, "pong");
});

test("invalid canvas requests and model errors are bounded replies; official host remains alive", async () => {
  let calls = 0;
  const {host, output} = await setup({canvasAgent: async () => { calls += 1; throw new Error("SECRET arbitrary runtime stack"); }});
  const invalid = ["not+base64", encode({...start(), shell: "evil"}), encode({...start(), context: {}}), undefined];
  let seq = 0;
  for (const payload of invalid) {
    await host.accept(signed("canvas-agent", ++seq, {payload}));
    assert.equal(output.at(-1).outcome, "rejected");
    assert.equal(output.at(-1).reason, "canvas-agent-invalid-request");
  }
  assert.equal(calls, 0);
  await host.accept(signed("canvas-agent", ++seq, {payload: encode(start())}));
  assert.equal(output.at(-1).reason, "canvas-agent-unavailable");
  assert.equal(JSON.stringify(output).includes("SECRET"), false);
  await host.accept(signed("ping", ++seq));
  assert.equal(output.at(-1).type, "pong");
});

test("canvas authentication, unknown frame fields and replays remain fail-closed", async () => {
  const {host} = await setup({canvasAgent: async () => ({payload: encode(snapshot("idle"))})});
  const good = signed("canvas-agent", 1, {payload: encode({op: "status", canvasId: "canvas-1"})});
  await assert.rejects(host.accept(good.replace(/"mac":"[a-f0-9]{64}"/u, `"mac":"${"0".repeat(64)}"`)), /dsh-host-frame-invalid/);
  await assert.rejects(host.accept(signed("canvas-agent", 1, {payload: encode(start()), path: "other"})), /dsh-host-frame-invalid/);
  await host.accept(good);
  await assert.rejects(host.accept(good), /dsh-host-frame-invalid/);
});

test("canvas results reject cross-canvas or extra authority fields without exposing payload", async () => {
  for (const value of [{...snapshot("idle"), canvasId: "canvas-2"}, {...snapshot("idle"), credential: "SECRET"}, {error: "SECRET"}]) {
    const {host, output} = await setup({canvasAgent: async () => ({payload: encode(value)})});
    await host.accept(signed("canvas-agent", 1, {payload: encode({op: "status", canvasId: "canvas-1"})}));
    assert.equal(output.at(-1).outcome, "rejected");
    assert.equal(JSON.stringify(output).includes("SECRET"), false);
    await host.accept(signed("ping", 2));
    assert.equal(output.at(-1).type, "pong");
  }
});

test("snapshot may return bounded approved context but never image bytes or cross-canvas context", async () => {
  const context = start().context;
  for (const [valid, returnedContext] of [[true, context], [false, {...context, canvasId: "canvas-2"}],
    [false, {...context, nodes: [{id: "node-1", image: {mimeType: "image/png", data: "SECRET"}}]}]]) {
    const {host, output} = await setup({canvasAgent: async () => ({payload: encode({...snapshot("idle"), requestId: "request-1", context: returnedContext})})});
    await host.accept(signed("canvas-agent", 1, {payload: encode({op: "status", canvasId: "canvas-1"})}));
    assert.equal(output.at(-1).outcome, valid ? "accepted" : "rejected");
    if (valid) assert.deepEqual(decodeCanvasAgentPayload(output.at(-1).payload).context, context);
    else assert.equal(JSON.stringify(output).includes("SECRET"), false);
  }
});

test("private carrier ACK supports the bounded canvas result without relaxing other frame schemas", async () => {
  const stream = new PassThrough(); let invalid = 0;
  const channel = createSurfaceControlChannel({stream, onState() {}, onInvalid() { invalid += 1; }});
  const result = channel.waitAck(1, "canvas-agent-result", 1000);
  stream.write(JSON.stringify({type: "canvas-agent-result", seq: 1, outcome: "accepted", payload: encode(snapshot("idle"))}) + "\n");
  assert.equal((await result).seq, 1);
  assert.equal(invalid, 0);
  const later = channel.waitAck(2, "canvas-agent-result", 5, {preserveOnTimeout: true});
  await assert.rejects(later);
  assert.equal(invalid, 0, "snapshot timeout cannot tear down unrelated LSH");
  stream.write(JSON.stringify({type: "canvas-agent-result", seq: 2, outcome: "accepted", payload: encode(snapshot("idle"))}) + "\n");
  assert.equal(invalid, 0, "exact late ACK is consumed");
  const wrong = channel.waitAck(3, "canvas-agent-result", 1000);
  stream.write(JSON.stringify({type: "canvas-agent-result", seq: 3, outcome: "accepted", payload: "x", unknown: true}) + "\n");
  await assert.rejects(wrong); assert.equal(invalid, 1);
  channel.close(); stream.destroy();
});

test("an unavailable owner never spawns a second host or opens a WebView for canvas status", async () => {
  const owner = createNativeSurfaceOwner({runtimeRoot: "/unused", stateRoot: "/unused"});
  await assert.rejects(owner.canvasAgent(encode({op: "status", canvasId: "canvas-1"})), /canvas-agent-unavailable/);
  await owner.shutdown();
});

test("native canvas command uses the existing main-origin guard, nonblocking host admission and narrow method", () => {
  const rust = readFileSync(new URL("../src-tauri/src/dsh_host.rs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const command = lib.slice(lib.indexOf("async fn canvas_agent_dispatch("), lib.indexOf("async fn dsh_native_surface_open_intent_status("));
  assert.match(command, /require_main_caller\(&caller\)\?/u);
  assert.match(command, /spawn_blocking\(move \|\| owned\.canvas_agent_dispatch\(request\)\)/u);
  assert.doesNotMatch(command, /open_native_surface\(|create_dsh_native_surface_child\(|DSH_NATIVE_SURFACE_LIFECYCLE\.lock/u);
  const method = rust.slice(rust.indexOf("pub(crate) fn canvas_agent_dispatch("), rust.indexOf("pub(crate) fn open_intent_status("));
  assert.match(method, /self\.operation\.try_lock\(\)/u);
  assert.doesNotMatch(method, /self\.fail_surface_generation\(|self\.terminate_current\(|open_native_surface\(/u);
  assert.match(rust, /&self\.frames, &mut self\.expired_canvas_requests, Duration::from_secs\(6\)/u);
  assert.match(rust, /"dsh-authenticated-webserver", "luckyray-dsh-canvas-agent\.mjs", 12usize/u);
  assert.match(rust, /const CANVAS_AGENT_SHA256: &str =/u);
});


test("native late-ACK isolation is exact, bounded, deadline-preserving and shared by ordinary reads", () => {
  const rust = readFileSync(new URL("../src-tauri/src/dsh_host.rs", import.meta.url), "utf8");
  const reader = rust.slice(rust.indexOf("fn read_authenticated_host_frame("), rust.indexOf("struct ResourceRequestEnvelope"));
  const ledger = rust.slice(rust.indexOf("struct ExpiredCanvasRequests"), rust.indexOf("enum HostFrameReadError"));
  const dispatchStart = rust.indexOf("fn canvas_agent_dispatch(&mut self");
  const dispatchEnd = rust.indexOf("fn close_surface(&mut self", dispatchStart);
  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart, "inspect only the canvas dispatch method");
  const dispatch = rust.slice(dispatchStart, dispatchEnd);
  assert.match(rust, /const MAX_EXPIRED_CANVAS_REQUESTS: usize = 8;/u);
  assert.match(ledger, /if frame.kind != "canvas-agent-result"/u);
  assert.match(ledger, /expired == request_id/u);
  assert.match(ledger, /self.ids.remove\(index\)/u);
  assert.doesNotMatch(ledger, /pop_front|retain|clear\(/u);
  assert.match(reader, /deadline.saturating_duration_since\(Instant::now\(\)\)/u);
  assert.match(reader, /frames.recv_timeout\(remaining\)/u);
  assert.match(reader, /expired_canvas.consume\(&frame\)/u);
  assert.match(rust, /fn read\(&mut self, timeout: Duration\)[\s\S]*?read_authenticated_host_frame\(&self.frames, &mut self.expired_canvas_requests, timeout\)/u);
  assert.match(dispatch, /if !self.expired_canvas_requests.has_capacity\(\)/u);
  assert.match(dispatch, /Err\(HostFrameReadError::TimedOut\) => \{[\s\S]*?self.expired_canvas_requests.record\(request_id\)/u);
  assert.doesNotMatch(dispatch, /fail_surface_generation|terminate_current/u);
});

test("new conversation and stale-conversation errors cross the narrow authenticated contract", async () => {
  const reset = { op: "newConversation", canvasId: "canvas-1", requestId: "rotation-1", expectedConversationId: "conversation-test" };
  assert.equal(validateCanvasAgentRequest(reset), reset);
  for (const bad of [{ ...reset, sessionId: "arbitrary" }, { ...reset, expectedConversationId: "" }, { ...start(), conversationId: undefined }])
    assert.throws(() => validateCanvasAgentRequest(bad), /invalid-request/);
  const { host, output } = await setup({ canvasAgent: async () => ({ payload: encode({ error: "canvas-agent-conversation-conflict" }) }) });
  await host.accept(signed("canvas-agent", 1, { payload: encode(reset) }));
  assert.equal(output.at(-1).reason, "canvas-agent-conversation-conflict");
});

test("activity projection rejects arbitrary labels, private fields and invalid timing", async () => {
  const entry = { id: "activity-1", kind: "phase", label: "waiting-model", status: "running", startedAt: 1 };
  for (const [valid, activity] of [[true, [entry]], [false, [{ ...entry, label: "SECRET" }]], [false, [{ ...entry, arguments: "SECRET" }]],
    [false, [{ ...entry, endedAt: 0 }]], [false, Array(25).fill(entry)]]) {
    const { host, output } = await setup({ canvasAgent: async () => ({ payload: encode({ ...snapshot("running"), activity }) }) });
    await host.accept(signed("canvas-agent", 1, { payload: encode({ op: "status", canvasId: "canvas-1" }) }));
    assert.equal(output.at(-1).outcome, valid ? "accepted" : "rejected");
    assert.equal(JSON.stringify(output).includes("SECRET"), false);
  }
});

test("only the exact late ACK invokes recovery and another canvas call may follow", async () => {
  const stream = new PassThrough(); let invalid = 0, recovered = 0;
  const channel = createSurfaceControlChannel({ stream, onState() {}, onInvalid() { invalid++; } });
  await assert.rejects(channel.waitAck(101, "canvas-agent-result", 5, { preserveOnTimeout: true, onLateAck: () => { recovered++; } }));
  assert.equal(recovered, 0); assert.equal(invalid, 0);
  stream.write(JSON.stringify({ type: "canvas-agent-result", seq: 101, outcome: "accepted", payload: encode(snapshot("idle")) }) + "\n");
  assert.equal(recovered, 1);
  const next = channel.waitAck(102, "canvas-agent-result", 1000);
  stream.write(JSON.stringify({ type: "canvas-agent-result", seq: 102, outcome: "accepted", payload: encode(snapshot("idle")) }) + "\n");
  assert.equal((await next).seq, 102); assert.equal(invalid, 0);
  channel.close(); stream.destroy();
});
