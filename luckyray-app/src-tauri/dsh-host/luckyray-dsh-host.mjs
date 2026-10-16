import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { createChildResourceRouter } from "./luckyray-dsh-resource-tools/index.mjs";
import {
  COMPAT_CHECKER_VERSION,
  PLUGIN_COMPAT_GUARD_FILENAME,
  buildGuardPatch,
  computeCompositionCacheKey,
  parseBundlePatchEntries,
  parseProfileManifest,
  projectQuarantineSet,
  readCompatState,
  staticPluginVerdict,
  writeCompatState,
  writeGuardPatch,
} from "./luckyray-dsh-plugin-compat.mjs";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

export const DSH_HOST_PROTOCOL = 1;
export const DSH_HOST_MAX_FRAME_BYTES = 384 * 1024;
const DSH_HOST_MAX_PENDING_RESOURCE_CALLS = 128;
const DSH_HOST_MAX_RESOURCE_RESULT_BYTES = 12 * 1024 * 1024;
const DSH_NATIVE_PROBE_TEXT = "LUCKYRAY_DSH_NATIVE_PROBE";
const DSH_NATIVE_RESPONSE_TEXT = "DSH_NATIVE_ACCEPTED";
const DSH_NATIVE_PROBE_TIMEOUT_MS = 60_000;
const DSH_NATIVE_PROBE_PATCH = "- id: session-title-llm\n  disabled: true\n";
const DSH_SURFACE_READY_TIMEOUT_MS = 45_000;
const DSH_SURFACE_CHILD_EXIT_WAIT_MS = 4_000;
// carrier-ready only proves the carrier handshake. The web UI itself (loader
// tree, plugin imports, HTTP listener) settles later; the v1.9.3 incident was
// a post-ready plugin crash that froze silently. This watchdog reclaims that
// window instead of reporting a doomed surface as healthy.
export const DSH_SURFACE_CLIENT_READY_TIMEOUT_MS = 90_000;
const DSH_SURFACE_STDERR_RING_BYTES = 16 * 1024;

export const OFFICIAL_PROFILE_BUNDLES = Object.freeze(new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-acp-app",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-sdk-app",
  "@deepseek-ai/dsh-sdk-minimal",
]));

function isThirdPartyBundle(name) {
  return !OFFICIAL_PROFILE_BUNDLES.has(name);
}

const FRAME_FIELDS = Object.freeze({
  bootstrap: new Set(["type", "protocol", "generation", "challenge"]),
  probe: new Set(["type", "protocol", "generation", "seq", "requestId", "mac"]),
  ping: new Set(["type", "protocol", "generation", "seq", "mac"]),
  "surface-open": new Set(["type", "protocol", "generation", "seq", "requestId", "mac"]),
  "surface-close": new Set(["type", "protocol", "generation", "seq", "requestId", "mac"]),
  "update-prepare": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "update-cancel": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "update-stop": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "model-sync": new Set(["type", "protocol", "generation", "seq", "requestId", "mac"]),
  "open-intent": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "open-intent-status": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "compat-status": new Set(["type", "protocol", "generation", "seq", "requestId", "mac"]),
  "compat-check": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "compat-apply": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "resource-result": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "resource-result-chunk": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "remote-authority-set": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "remote-session-mint": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  "remote-session-drop": new Set(["type", "protocol", "generation", "seq", "requestId", "payload", "mac"]),
  shutdown: new Set(["type", "protocol", "generation", "seq", "mac"]),
});

function invalidFrame() {
  return new Error("dsh-host-frame-invalid");
}

function skipWhitespace(source, start) {
  let index = start;
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  return index;
}

function parseStringToken(source, start) {
  if (source[start] !== '"') throw invalidFrame();
  let index = start + 1;
  for (; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      if (index >= source.length) throw invalidFrame();
      if (source[index] === "u") {
        const digits = source.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/u.test(digits)) throw invalidFrame();
        index += 4;
      }
      continue;
    }
    if (source[index] === '"') {
      const raw = source.slice(start, index + 1);
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        throw invalidFrame();
      }
      if (typeof value !== "string") throw invalidFrame();
      return { value, next: index + 1 };
    }
    if (source.charCodeAt(index) < 0x20) throw invalidFrame();
  }
  throw invalidFrame();
}

function parsePrimitiveToken(source, start) {
  if (source[start] === '"') return parseStringToken(source, start);
  const rest = source.slice(start);
  const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(rest);
  if (!match) throw invalidFrame();
  let value;
  try {
    value = JSON.parse(match[0]);
  } catch {
    throw invalidFrame();
  }
  return { value, next: start + match[0].length };
}

function parseFlatObject(source) {
  let index = skipWhitespace(source, 0);
  if (source[index] !== "{") throw invalidFrame();
  index = skipWhitespace(source, index + 1);
  const value = Object.create(null);
  const keys = new Set();
  if (source[index] === "}") {
    index = skipWhitespace(source, index + 1);
    if (index !== source.length) throw invalidFrame();
    return value;
  }
  for (;;) {
    const keyToken = parseStringToken(source, index);
    if (keys.has(keyToken.value)) throw invalidFrame();
    keys.add(keyToken.value);
    index = skipWhitespace(source, keyToken.next);
    if (source[index] !== ":") throw invalidFrame();
    index = skipWhitespace(source, index + 1);
    const item = parsePrimitiveToken(source, index);
    value[keyToken.value] = item.value;
    index = skipWhitespace(source, item.next);
    if (source[index] === "}") {
      index = skipWhitespace(source, index + 1);
      if (index !== source.length) throw invalidFrame();
      return value;
    }
    if (source[index] !== ",") throw invalidFrame();
    index = skipWhitespace(source, index + 1);
  }
}

export function parseStrictHostFrame(line) {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > DSH_HOST_MAX_FRAME_BYTES) {
    throw invalidFrame();
  }
  const frame = parseFlatObject(line);
  const allowed = typeof frame.type === "string" ? FRAME_FIELDS[frame.type] : undefined;
  if (!allowed || Object.keys(frame).some((field) => !allowed.has(field))) throw invalidFrame();
  if (frame.protocol !== DSH_HOST_PROTOCOL || !Number.isSafeInteger(frame.generation) || frame.generation <= 0) {
    throw invalidFrame();
  }
  if (frame.type === "bootstrap") {
    if (Object.keys(frame).length !== 4 || typeof frame.challenge !== "string" || !/^[0-9a-f]{64}$/u.test(frame.challenge)) {
      throw invalidFrame();
    }
    return frame;
  }
  if (!Number.isSafeInteger(frame.seq) || frame.seq <= 0 || typeof frame.mac !== "string" || !/^[0-9a-f]{64}$/u.test(frame.mac)) {
    throw invalidFrame();
  }
  if (["probe", "surface-open", "surface-close", "model-sync", "open-intent", "open-intent-status", "compat-status", "compat-check", "compat-apply", "resource-result", "resource-result-chunk",
    "remote-authority-set", "remote-session-mint", "remote-session-drop", "update-prepare", "update-cancel", "update-stop"].includes(frame.type)
    && (typeof frame.requestId !== "string" || !/^[a-z0-9-]{1,64}$/u.test(frame.requestId))) {
    throw invalidFrame();
  }
  if (["open-intent", "open-intent-status", "compat-check", "compat-apply", "resource-result", "resource-result-chunk",
    "remote-authority-set", "remote-session-mint", "remote-session-drop"].includes(frame.type)
    && (typeof frame.payload !== "string" || Buffer.byteLength(frame.payload, "utf8") > 350 * 1024)) {
    throw invalidFrame();
  }
  return frame;
}

export function signCanonicalHostFrame(challenge, direction, frame) {
  if (!/^[0-9a-f]{64}$/u.test(challenge) || !/^(parent|child)$/u.test(direction)) throw invalidFrame();
  const fields = [
    String(frame.protocol),
    String(frame.generation),
    direction,
    String(frame.seq),
    String(frame.type),
    typeof frame.requestId === "string" ? frame.requestId : "",
    Number.isSafeInteger(frame.carrierGeneration) ? String(frame.carrierGeneration) : "",
    typeof frame.stage === "string" ? frame.stage : "",
    typeof frame.outcome === "string" ? frame.outcome : "",
    Number.isSafeInteger(frame.durationMs) ? String(frame.durationMs) : "",
    typeof frame.reason === "string" ? frame.reason : "",
    Number.isSafeInteger(frame.port) ? String(frame.port) : "",
    typeof frame.bootstrapPath === "string" ? frame.bootstrapPath : "",
    typeof frame.bootstrapRef === "string" ? frame.bootstrapRef : "",
    typeof frame.payload === "string" ? frame.payload : "",
    Number.isSafeInteger(frame.rssBytes) ? String(frame.rssBytes) : "",
    Number.isSafeInteger(frame.ownedProcessCount) ? String(frame.ownedProcessCount) : "",
  ];
  return createHmac("sha256", Buffer.from(challenge, "hex")).update(fields.join("\0"), "utf8").digest("hex");
}

function decodeExactMac(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) return null;
  const decoded = Buffer.from(value, "hex");
  return decoded.length === 32 && decoded.toString("hex") === value ? decoded : null;
}

export function verifyCanonicalHostFrameMac(challenge, direction, frame, receivedMac) {
  try {
    const expected = decodeExactMac(signCanonicalHostFrame(challenge, direction, frame));
    const received = decodeExactMac(receivedMac);
    return expected !== null && received !== null && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

function encodeResultPayload(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createDshHostProtocol({ writeFrame, nativeProbe, nativeSurface, pluginCompat = null, failureProbe = null }) {
  let challenge;
  let generation;
  let inboundSeq = 0;
  let outboundSeq = 0;
  let busy = false;
  let shuttingDown = false;
  let resourceRequestIndex = 0;
  const pendingResources = new Map();

  function rejectPendingResources(code = "dsh-resource-host-unavailable") {
    for (const pending of pendingResources.values()) {
      const error = new Error(code);
      error.code = code;
      pending.reject(error);
    }
    pendingResources.clear();
  }

  function emit(type, payload = {}) {
    if (!challenge || !generation) throw invalidFrame();
    outboundSeq += 1;
    const unsigned = {
      type,
      protocol: DSH_HOST_PROTOCOL,
      generation,
      seq: outboundSeq,
      ...payload,
    };
    writeFrame({
      ...unsigned,
      mac: signCanonicalHostFrame(challenge, "child", unsigned),
    });
  }

  async function accept(line) {
    const frame = parseStrictHostFrame(line);
    if (!challenge) {
      if (frame.type !== "bootstrap") throw invalidFrame();
      challenge = frame.challenge;
      generation = frame.generation;
      emit("hello", { stage: "protocol-authenticated" });
      return;
    }
    if (shuttingDown || frame.type === "bootstrap" || frame.generation !== generation
      || frame.seq !== inboundSeq + 1) {
      throw invalidFrame();
    }
    const unsigned = { ...frame };
    delete unsigned.mac;
    if (!verifyCanonicalHostFrameMac(challenge, "parent", unsigned, frame.mac)) throw invalidFrame();
    inboundSeq = frame.seq;
    if (["resource-result", "resource-result-chunk"].includes(frame.type)) {
      const pending = pendingResources.get(frame.requestId);
      if (!pending || typeof frame.payload !== "string") throw invalidFrame();
      pending.size += Buffer.byteLength(frame.payload, "utf8");
      if (pending.size > DSH_HOST_MAX_RESOURCE_RESULT_BYTES) throw invalidFrame();
      pending.chunks.push(frame.payload);
      if (frame.type === "resource-result-chunk") return;
      pendingResources.delete(frame.requestId);
      let payload;
      try {
        payload = JSON.parse(Buffer.from(pending.chunks.join(""), "base64url").toString("utf8"));
      } catch {
        pending.reject(invalidFrame());
        throw invalidFrame();
      }
      if (payload?.ok === true) pending.resolve(payload.value);
      else {
        const code = typeof payload?.code === "string" ? payload.code : "dsh-resource-call-failed";
        const error = new Error(code);
        error.code = code;
        pending.reject(error);
      }
      return;
    }
    if (frame.type === "shutdown") {
      shuttingDown = true;
      rejectPendingResources();
      emit("shutdown-ack", { stage: "shutting-down" });
      return;
    }
    if (frame.type === "ping") {
      emit("pong", { stage: "protocol-authenticated" });
      return;
    }
    if (["update-prepare", "update-cancel", "update-stop"].includes(frame.type)) {
      if (busy || typeof nativeSurface?.update !== "function") throw invalidFrame();
      busy = true;
      try {
        let result;
        try {
          result = await nativeSurface.update(frame.type, JSON.parse(Buffer.from(frame.payload, "base64url").toString("utf8")));
        } catch {
          result = { ready: false, reason: "update-lsh-control-timeout" };
        }
        emit(`${frame.type}-result`, { requestId: frame.requestId, payload: encodeResultPayload(result) });
      } finally { busy = false; }
      return;
    }
    if (["surface-open", "surface-close", "model-sync", "open-intent", "open-intent-status"].includes(frame.type)) {
      if (busy || typeof nativeSurface?.open !== "function" || typeof nativeSurface?.close !== "function") throw invalidFrame();
      busy = true;
      try {
        if (frame.type === "model-sync") {
          if (typeof nativeSurface?.syncModel !== "function") throw invalidFrame();
          const result = await nativeSurface.syncModel();
          emit("model-sync-result", { requestId: frame.requestId, payload: result.payload });
          return;
        }
        if (frame.type === "open-intent") {
          if (typeof nativeSurface?.stageIntent !== "function") throw invalidFrame();
          await nativeSurface.stageIntent(frame.payload);
          emit("open-intent-result", { requestId: frame.requestId });
          return;
        }
        if (frame.type === "open-intent-status") {
          if (!/^intent-[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(frame.payload)) throw invalidFrame();
          const result = await nativeSurface.intentStatus(frame.payload);
          emit("open-intent-status-result", { requestId: frame.requestId, payload: result.payload });
          return;
        }
        if (frame.type === "surface-open" && typeof pluginCompat?.ensureLoadPlan === "function") {
          // Pre-load compatibility gate at the real spawn boundary: refresh
          // verdicts for the current composition and auto-quarantine static
          // failures into the guard BEFORE the loader can import anything.
          // The plan is CONSUMED: an invalid manifest stops the load here
          // instead of pretending a plan exists.
          const plan = await pluginCompat.ensureLoadPlan();
          if (plan && plan.planValid === false) {
            emit("surface-result", {
              requestId: frame.requestId,
              carrierGeneration: 0,
              stage: "surface-failed",
              outcome: "dsh-surface-plan-invalid",
              reason: typeof plan.reason === "string" ? plan.reason : "dsh-surface-plan-invalid",
            });
            return;
          }
          if (plan && Array.isArray(plan.unverifiable) && plan.unverifiable.length > 0) {
            // A configured package that cannot be assessed is an incomplete
            // input: the load is RESTRICTED, not successful. The broken
            // composition must not spawn under a clean-plan pretense.
            emit("surface-result", {
              requestId: frame.requestId,
              carrierGeneration: 0,
              stage: "surface-failed",
              outcome: "dsh-surface-plan-unverifiable",
              reason: typeof plan.reason === "string" ? plan.reason : "plugin-compat-package-unreadable",
            });
            return;
          }
        }
        const result = frame.type === "surface-open"
          ? await nativeSurface.open()
          : await nativeSurface.close();
        if (frame.type === "surface-open" && failureProbe) {
          // Record the attribution of a failed boot; a successful boot clears
          // it so the next failure never reuses a stale diagnostic.
          failureProbe.diagnostic = result.stage === "surface-failed"
            ? (result.diagnostic ?? null)
            : null;
        }
        emit("surface-result", {
          requestId: frame.requestId,
          carrierGeneration: result.carrierGeneration,
          stage: result.stage,
          outcome: result.outcome,
          port: result.port,
          bootstrapPath: result.bootstrapPath,
          bootstrapRef: result.bootstrapRef,
          rssBytes: result.rssBytes,
          ownedProcessCount: result.ownedProcessCount,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        });
      } finally {
        busy = false;
      }
      return;
    }
    if (["remote-authority-set", "remote-session-mint", "remote-session-drop"].includes(frame.type)) {
      if (busy || typeof nativeSurface?.setRemoteAuthority !== "function") throw invalidFrame();
      busy = true;
      try {
        let request = null;
        try {
          request = JSON.parse(Buffer.from(String(frame.payload), "base64url").toString("utf8"));
        } catch { throw invalidFrame(); }
        if (frame.type === "remote-authority-set") {
          const applied = await nativeSurface.setRemoteAuthority(request);
          emit("remote-authority-set-result", { requestId: frame.requestId, payload: encodeResultPayload(applied) });
          return;
        }
        if (frame.type === "remote-session-mint") {
          const minted = await nativeSurface.mintRemoteSession(request);
          emit("remote-session-mint-result", { requestId: frame.requestId, payload: encodeResultPayload(minted) });
          return;
        }
        const dropped = await nativeSurface.dropRemoteSessions(request);
        emit("remote-session-drop-result", { requestId: frame.requestId, payload: encodeResultPayload(dropped) });
      } finally {
        busy = false;
      }
      return;
    }
    if (["compat-status", "compat-check", "compat-apply"].includes(frame.type)) {
      if (busy || typeof pluginCompat?.status !== "function") throw invalidFrame();
      busy = true;
      try {
        let result;
        if (frame.type === "compat-status") {
          result = await pluginCompat.status();
        } else {
          let request = null;
          try {
            request = JSON.parse(Buffer.from(String(frame.payload), "base64url").toString("utf8"));
          } catch { throw invalidFrame(); }
          result = frame.type === "compat-check"
            ? await pluginCompat.check(request)
            : await pluginCompat.apply(request);
        }
        emit(`${frame.type}-result`, {
          requestId: frame.requestId,
          payload: Buffer.from(JSON.stringify(result), "utf8").toString("base64url"),
        });
      } catch (error) {
        // Recovery/diagnostic actions must never kill a healthy host tree:
        // IO and logic failures converge to structured failed results.
        const reason = typeof error?.code === "string" && /^[A-Za-z0-9-]{1,96}$/u.test(error.code)
          ? error.code
          : "plugin-compat-service-failed";
        emit(`${frame.type}-result`, {
          requestId: frame.requestId,
          payload: Buffer.from(JSON.stringify({ failed: true, reason }), "utf8").toString("base64url"),
        });
      } finally {
        busy = false;
      }
      return;
    }
    if (frame.type !== "probe" || busy) throw invalidFrame();
    busy = true;
    try {
      const result = await nativeProbe();
      if (!result || result.sessionReady !== true || result.turnAccepted !== true) {
        emit("probe-result", {
          requestId: frame.requestId,
          stage: "unavailable",
          outcome: "native-evidence-missing",
        });
        return;
      }
      emit("probe-stage", { requestId: frame.requestId, stage: "session-ready" });
      emit("probe-stage", { requestId: frame.requestId, stage: "turn-accepted" });
      emit("probe-result", {
        requestId: frame.requestId,
        stage: "probe-completed",
        outcome: "accepted",
        durationMs: Number.isSafeInteger(result.durationMs) && result.durationMs >= 0
          ? Math.min(result.durationMs, 600_000)
          : 0,
      });
    } finally {
      busy = false;
    }
  }

  function publishSurfaceStage(carrierGeneration, stage) {
    if (shuttingDown || !Number.isSafeInteger(carrierGeneration) || carrierGeneration <= 0
      || !["client-ready", "session-open"].includes(stage)) {
      throw invalidFrame();
    }
    emit("surface-stage", { carrierGeneration, stage });
  }

  function publishSurfaceFailure(reason) {
    if (shuttingDown || typeof reason !== "string" || reason.length === 0 || reason.length > 64) {
      return;
    }
    emit("surface-failed", { reason });
  }

  function requestResource(type, payload) {
    if (shuttingDown || !["policy", "call"].includes(type)
      || pendingResources.size >= DSH_HOST_MAX_PENDING_RESOURCE_CALLS) {
      return Promise.reject(invalidFrame());
    }
    resourceRequestIndex += 1;
    const requestId = `resource-${resourceRequestIndex}`;
    const encoded = Buffer.from(JSON.stringify({ type, payload }), "utf8").toString("base64url");
    return new Promise((resolveRequest, rejectRequest) => {
      pendingResources.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest,
        chunks: [],
        size: 0,
      });
      emit("resource-request", { requestId, payload: encoded });
    });
  }

  return Object.freeze({ accept, publishSurfaceStage, publishSurfaceFailure, requestResource, rejectPendingResources });
}

export async function runDshHostMain({ runtimeRoot, stateRoot, input = process.stdin, output = process.stdout } = {}) {
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0
    || typeof stateRoot !== "string" || !isAbsolute(stateRoot)) throw probeFailure();
  let shutdownAccepted = false;
  let protocol;
  const failureProbe = { diagnostic: null };
  const nativeSurface = createNativeSurfaceOwner({
    runtimeRoot,
    stateRoot,
    onUnexpectedExit: () => process.exit(71),
    onSurfaceLost: (reason) => {
      try {
        protocol?.publishSurfaceFailure(reason);
      } catch { /* a lost surface must never take down the host loop */ }
    },
    onSurfaceStage: (carrierGeneration, stage) => {
      protocol?.publishSurfaceStage(carrierGeneration, stage);
    },
    resourceRequest: (type, payload) => protocol?.requestResource(type, payload),
  });
  protocol = createDshHostProtocol({
    writeFrame: (frame) => {
      output.write(`${JSON.stringify(frame)}\n`);
      if (frame.type === "shutdown-ack") shutdownAccepted = true;
    },
    nativeProbe: () => runNativeDshProbe({ runtimeRoot, stateRoot }),
    nativeSurface,
    failureProbe,
    pluginCompat: createPluginCompatService({
      runtimeRoot,
      stateRoot: resolve(stateRoot),
      surfaceHome: process.env.LUCKYRAY_DSH_NATIVE_SURFACE_HOME,
      failureProbe,
    }),
  });
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    await protocol.accept(line);
    if (shutdownAccepted) break;
  }
  protocol.rejectPendingResources();
  await nativeSurface.shutdown();
}

export function createSurfaceControlChannel({
  stream,
  onState,
  onInvalid,
}) {
  if (!stream || typeof stream.on !== "function" || typeof onState !== "function"
    || typeof onInvalid !== "function") throw probeFailure();
  const pending = new Map();
  let bindingGeneration = 0;
  let invalid = false;
  const lines = createInterface({ input: stream, crlfDelay: Infinity, terminal: false });
  const rejectAll = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(probeFailure());
    }
    pending.clear();
  };
  const invalidate = () => {
    if (invalid) return;
    invalid = true;
    rejectAll();
    lines.close();
    onInvalid();
  };
  lines.on("line", (line) => {
    try {
      if (invalid || Buffer.byteLength(line, "utf8") > 352 * 1024) throw probeFailure();
      const frame = JSON.parse(line);
      if (!frame || typeof frame.type !== "string") throw probeFailure();
      if (frame.type === "surface-state") {
        const fields = Object.keys(frame).sort().join(",");
        if (fields !== "carrierGeneration,clientReady,sessionOpen,type"
          || frame.carrierGeneration !== bindingGeneration
          || frame.clientReady !== true
          || frame.sessionOpen !== null && (typeof frame.sessionOpen !== "string"
            || frame.sessionOpen.length === 0 || frame.sessionOpen.length > 128)) throw probeFailure();
        onState(frame.carrierGeneration, frame.sessionOpen);
        return;
      }
      const fields = Object.keys(frame).sort().join(",");
      const resultShape = (["model-sync-result", "open-intent-status-result", "remote-session-mint-result",
        "update-prepare-result", "update-cancel-result", "update-stop-result"].includes(frame.type))
        && fields === "outcome,payload,seq,type"
        && typeof frame.payload === "string"
        && Buffer.byteLength(frame.payload, "utf8") <= 350 * 1024;
      if ((!resultShape && fields !== "outcome,seq,type") || !Number.isSafeInteger(frame?.seq)) throw probeFailure();
      const item = pending.get(frame.seq);
      if (!item || frame.type !== item.type) throw probeFailure();
      // A rejected outcome is a valid, resolved answer for the frames that
      // model availability (the remote surface may simply be unavailable);
      // anything else still invalidates the channel.
      if (frame.outcome !== "accepted" && item.acceptsRejected !== true) throw probeFailure();
      pending.delete(frame.seq);
      clearTimeout(item.timeout);
      item.resolve(frame);
    } catch {
      invalidate();
    }
  });
  lines.once("error", invalidate);
  lines.once("close", () => { if (!invalid && pending.size > 0) invalidate(); });
  return Object.freeze({
    setBinding(generation) {
      if (invalid || !Number.isSafeInteger(generation) || generation <= 0) throw probeFailure();
      bindingGeneration = generation;
    },
    revokeBinding() {
      bindingGeneration = 0;
    },
    waitAck(seq, type, timeoutMs = 5_000, options = {}) {
      if (invalid || !Number.isSafeInteger(seq) || seq <= 0 || pending.has(seq)
        || !["binding-open-ack", "binding-close-ack", "model-sync-result", "open-intent-result", "open-intent-status-result",
          "remote-authority-ack", "remote-session-mint-result", "remote-session-drop-ack",
          "update-prepare-result", "update-cancel-result", "update-stop-result"].includes(type)) {
        return Promise.reject(probeFailure());
      }
      return new Promise((resolveAck, rejectAck) => {
        const timeout = setTimeout(() => {
          if (options.preserveOnTimeout !== true) pending.delete(seq);
          rejectAck(probeFailure());
          if (options.preserveOnTimeout !== true) invalidate();
        }, timeoutMs);
        pending.set(seq, {
          type, resolve: resolveAck, reject: rejectAck, timeout,
          acceptsRejected: options.acceptsRejected === true,
        });
      });
    },
    close() {
      invalid = true;
      rejectAll();
      lines.close();
    },
  });
}

export function minimalDshEnvironment(home, launchEnvironment = process.env) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const deepSeekSearchCredential = typeof launchEnvironment?.DEEPSEEK_API_KEY === "string"
    && launchEnvironment.DEEPSEEK_API_KEY.length > 0
    ? launchEnvironment.DEEPSEEK_API_KEY
    : undefined;
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: [
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
      join(systemRoot, "System32"),
      systemRoot,
    ].join(";"),
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: "1",
    ...(deepSeekSearchCredential === undefined ? {} : {
      DEEPSEEK_API_KEY: deepSeekSearchCredential,
    }),
  };
}

function surfaceFailure(reason, diagnostic = null) {
  const error = new Error("dsh-native-surface-start-failed");
  error.reason = reason;
  error.diagnostic = diagnostic;
  return error;
}

/**
 * Verifiable reclamation of one owned child AND its descendant tree.
 * Windows never terminates descendants with their parent, so while the
 * direct child is still alive we ALWAYS sweep with taskkill /T /F (the
 * parent-child tree is enumerable only during the child's lifetime) and then
 * confirm the direct child's exit. An already-exited child leaves any
 * orphaned descendants unenumerable — that is reported as unconfirmed, and
 * the caller must refuse to start a new surface until cleanup succeeds.
 */
async function killOwnedChildTree(child, waitMs = 8_000) {
  if (!child || child.pid === undefined || child.pid === null) {
    return { confirmed: true, sweep: "no-child" };
  }
  const stillAlive = child.exitCode === null;
  if (stillAlive) {
    const exited = new Promise((resolveExit) => {
      child.once("exit", () => resolveExit(true));
    });
    // /T walks the live process tree; /F is the bounded forced termination.
    // The exit code is consumed: a failed sweep is never "confirmed".
    const sweepOutcome = await new Promise((resolveSweep) => {
      const killer = execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], (error) => {
        resolveSweep({ timedOut: false, failed: error !== null && error.code !== 0 });
      });
      const bound = setTimeout(() => {
        killer.kill();
        resolveSweep({ timedOut: true, failed: true });
      }, 5_000);
      killer.once("close", () => clearTimeout(bound));
    });
    const confirmedExit = await Promise.race([
      exited,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), Math.max(1_000, waitMs - 5_000))),
    ]);
    const exitedNow = confirmedExit === true || child.exitCode !== null;
    if (sweepOutcome.failed || !exitedNow) {
      return { confirmed: false, sweep: sweepOutcome.timedOut ? "tree-kill-timeout" : "tree-kill-failed" };
    }
    return { confirmed: true, sweep: "tree-kill-issued" };
  }
  // Child already exited on its own: Windows does not terminate descendants
  // with their parent, and a dead pid cannot enumerate its orphans. This is
  // NOT a confirmed reclamation — the caller must block new starts and, via
  // the host frame, request an escalation to whole-tree recovery.
  return { confirmed: false, sweep: "child-predeceased" };
}

/**
 * Bounded stderr ring + verifiable failure classification. Raw stderr never
 * leaves the wrapper: only matched, structure-level facts are surfaced.
 */
export function createSurfaceDiagnostics() {
  let tail = "";
  let drained = Promise.resolve();
  return {
    attach(stream) {
      if (!stream || typeof stream.on !== "function") return;
      drained = new Promise((resolveDrain) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolveDrain();
        };
        stream.once("end", finish);
        stream.once("close", finish);
        stream.once("error", finish);
      });
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        tail = (tail + chunk).slice(-DSH_SURFACE_STDERR_RING_BYTES);
      });
    },
    async settle(timeoutMs = 500) {
      await Promise.race([
        drained,
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
      ]);
    },
    classify() {
      const importFailure = /failed to import loader entry ([^\s(]+) \(([^)]+)\)/u.exec(tail);
      if (importFailure) {
        return { kind: "plugin-import", entry: importFailure[1], source: importFailure[2] };
      }
      const missingExport = /module "([^"]+)" does not provide an export named "([^"]+)"/u.exec(tail)
        ?? /'([^']+)' does not provide an export named '([^']+)'/u.exec(tail);
      if (missingExport) {
        return { kind: "plugin-import", module: missingExport[1], name: missingExport[2] };
      }
      const pluginTree = /plugin tree failed to load/u.exec(tail);
      if (pluginTree) {
        return { kind: "plugin-config" };
      }
      const missingModule = /(?:Cannot find module|Cannot find package) '([^']+)'/u.exec(tail);
      if (missingModule) {
        return { kind: "dependency", module: missingModule[1] };
      }
      const peerFailure = /(?:peer dep|ERESOLVE|Unsupported engine|EBADENGINE)/iu.exec(tail);
      if (peerFailure) {
        return { kind: "dependency" };
      }
      return { kind: "unknown" };
    },
    tailLength() {
      return tail.length;
    },
  };
}

export function createNativeSurfaceOwner({
  runtimeRoot,
  stateRoot,
  surfaceHome = process.env.LUCKYRAY_DSH_NATIVE_SURFACE_HOME,
  surfacePatch = process.env.LUCKYRAY_DSH_NATIVE_SURFACE_PATCH,
  onUnexpectedExit = null,
  onSurfaceLost = null,
  onChildStarted = null,
  onSurfaceStage = null,
  resourceRequest = null,
  clientReadyTimeoutMs = DSH_SURFACE_CLIENT_READY_TIMEOUT_MS,
}) {
  let current = null;
  let index = 0;
  let armedWatchdog = null;
  // A surface whose owned tree could not be verifiably reclaimed blocks new
  // cold starts until the failed sweep settles or shutdown() proves clean.
  let cleanupBlocked = false;
  let lastUnconfirmedChild = null;
  const control = async (owned, command) => {
    owned.controlSeq += 1;
    const frame = { ...command, seq: owned.controlSeq };
    const replyType = command.type.startsWith("update-") ? `${command.type}-result`
      : command.type === "model-sync" ? "model-sync-result"
      : command.type === "open-intent" ? "open-intent-result"
        : command.type === "open-intent-status" ? "open-intent-status-result"
        : command.type === "remote-session-mint" ? "remote-session-mint-result"
          : `${command.type}-ack`;
    const acknowledged = owned.router.waitAck(owned.controlSeq, replyType, command.type.startsWith("update-") ? 20_000 : 5_000, {
      acceptsRejected: command.type === "remote-session-mint",
      preserveOnTimeout: command.type.startsWith("update-"),
    });
    owned.child.stdio[5].write(`${JSON.stringify(frame)}\n`);
    return acknowledged;
  };
  let remoteAuthorityState = null;
  const normalizeRemoteAuthority = (request) => {
    if (!request || typeof request !== "object") return null;
    const keys = Object.keys(request).sort().join(",");
    // Clear: {gatewayGeneration} (a bare {} is also tolerated as a clear).
    if (keys === "gatewayGeneration" || keys === "") {
      return { gatewayGeneration: Number(request.gatewayGeneration ?? 0) || 0 };
    }
    // Set: host + origin + gatewayGeneration.
    if (keys !== "gatewayGeneration,host,origin") return null;
    if (!Number.isSafeInteger(request.gatewayGeneration) || request.gatewayGeneration <= 0) return null;
    return {
      gatewayGeneration: request.gatewayGeneration,
      host: request.host,
      origin: request.origin,
    };
  };
  const nextBinding = () => {
    index += 1;
    return {
      protocol: 1,
      generation: index,
      // One browser slot; binding authority still rotates its secret and
      // generation. A cookie name is not the permission boundary.
      cookieName: "luckyray_dsh_surface",
      cookieValue: randomBytes(32).toString("hex"),
      bootstrapPath: "/_luckyray/bootstrap",
      bootstrapRef: randomBytes(32).toString("hex"),
      exactPaths: [], prefixPaths: [], upgradePaths: [],
      remoteAuthority: remoteAuthorityState === null ? null : { ...remoteAuthorityState },
    };
  };
  const pushRemoteAuthorityToLiveBinding = async (owned) => {
    if (owned?.child.exitCode !== null || !owned?.bindingGeneration) return;
    const frame = remoteAuthorityState === null
      ? { type: "remote-authority", gatewayGeneration: remoteAuthorityState?.gatewayGeneration ?? 0 }
      : {
        type: "remote-authority",
        host: remoteAuthorityState.host,
        origin: remoteAuthorityState.origin,
        gatewayGeneration: remoteAuthorityState.gatewayGeneration,
      };
    await control(owned, frame);
  };
  return Object.freeze({
    async update(kind, request) {
      if (!request || Object.keys(request).join(",") !== "id" || typeof request.id !== "string"
        || request.id.length === 0 || request.id.length > 160) throw invalidFrame();
      const owned = current;
      if (!owned || owned.child.exitCode !== null || owned.bindingGeneration <= 0) {
        return { ready: false, reason: "update-lsh-surface-unavailable" };
      }
      if (kind === "update-stop") owned.updateStopping = true;
      const result = await control(owned, { type: kind, id: request.id });
      const decoded = JSON.parse(Buffer.from(result.payload, "base64url").toString("utf8"));
      if (kind === "update-stop" && decoded.stopped === true && decoded.saved === true) {
        // An owned graceful exit is not an unexpected surface loss. No taskkill
        // or Job termination is permitted in this update protocol.
        clearTimeout(armedWatchdog);
        // The Windows fd-backed read streams may have a blocking ReadFile in
        // flight even after their JS stream is disposed. After the exact saved
        // stop ACK, half-close our private command/response writers so those
        // owned reads receive EOF and the drained official CLI can exit0.
        // No EOF is sent before a successful save + whole-tree disposal ACK.
        owned.child.stdio[5].end();
        owned.child.stdio[9].end();
        const exited = owned.child.exitCode === 0 || await new Promise(resolveExit => {
          const timer = setTimeout(() => resolveExit(false), 8_000);
          owned.child.once("exit", (code, signal) => { clearTimeout(timer); resolveExit(code === 0 && signal === null); });
        });
        if (!exited) return { stopped: false, reason: "update-lsh-exit-timeout",
          observedExitCode: owned.child.exitCode, observedSignal: owned.child.signalCode };
        current = null;
        owned.router.close(); owned.resourceRouter.close();
      }
      if (kind === "update-stop" && decoded.reason !== "update-lsh-exit-timeout") owned.updateStopping = false;
      return { ...decoded, carrierProcessId: owned.child.pid };
    },
    async setRemoteAuthority(request) {
      const normalized = normalizeRemoteAuthority(request);
      if (normalized === null) {
        // Malformed requests (unknown shapes) stay protocol errors; an
        // explicit {gatewayGeneration} clear is normalized, not an error.
        if (request && typeof request === "object"
          && Object.keys(request).sort().join(",") === "gatewayGeneration") {
          remoteAuthorityState = null;
          await pushRemoteAuthorityToLiveBinding(current);
          return { applied: current?.bindingGeneration !== undefined && current?.bindingGeneration > 0 };
        }
        throw invalidFrame();
      }
      if (normalized.host !== undefined
        && (typeof normalized.host !== "string" || typeof normalized.origin !== "string"
          || normalized.origin !== `https://${normalized.host}`
          || /^(?:127\.|localhost$|\[::1\])/iu.test(normalized.host))) {
        throw invalidFrame();
      }
      remoteAuthorityState = normalized;
      await pushRemoteAuthorityToLiveBinding(current);
      return { applied: Boolean(current?.bindingGeneration) };
    },
    async mintRemoteSession(request) {
      if (!request || typeof request.deviceId !== "string"
        || !/^device-[0-9a-f]{32}$/u.test(request.deviceId)
        || !Number.isSafeInteger(request.gatewayGeneration) || request.gatewayGeneration <= 0) {
        throw invalidFrame();
      }
      if (current?.child.exitCode !== null || typeof current?.bindingGeneration !== "number"
        || current.bindingGeneration <= 0) {
        return { outcome: "rejected" };
      }
      const ack = await control(current, {
        type: "remote-session-mint",
        deviceId: request.deviceId,
        gatewayGeneration: request.gatewayGeneration,
      });
      if (ack.outcome !== "accepted" || typeof ack.payload !== "string") {
        return { outcome: "rejected" };
      }
      return {
        outcome: "accepted",
        ...JSON.parse(Buffer.from(ack.payload, "base64url").toString("utf8")),
        carrierGeneration: current.bindingGeneration,
      };
    },
    async dropRemoteSessions(request) {
      if (!request || typeof request.deviceId !== "string"
        || !/^device-[0-9a-f]{32}$/u.test(request.deviceId)) {
        throw invalidFrame();
      }
      if (current?.child.exitCode !== null || typeof current?.bindingGeneration !== "number"
        || current.bindingGeneration <= 0) {
        return { dropped: 0 };
      }
      await control(current, { type: "remote-session-drop", deviceId: request.deviceId });
      // The carrier does not report per-device counts; absence of error means
      // the drop (sessions + sockets) was applied.
      return { dropped: "applied" };
    },
    async open() {
      if (current?.updateStopping) throw stateError("update-lsh-exit-pending");
      if (current?.child.exitCode === null) {
        const authority = nextBinding();
        current.router.setBinding(authority.generation);
        const ack = await control(current, { type: "binding-open", authority });
        current.bindingGeneration = authority.generation;
        current.ready = Object.freeze({
          stage: "surface-ready", outcome: "accepted", port: current.port,
          carrierGeneration: authority.generation,
          bootstrapPath: authority.bootstrapPath, bootstrapRef: authority.bootstrapRef,
          rssBytes: process.memoryUsage().rss, ownedProcessCount: 2,
        });
        return current.ready;
      }
      const root = resolve(runtimeRoot);
      const home = resolve(surfaceHome ?? "");
      const patch = resolve(surfacePatch ?? "");
      if (!isAbsolute(home) || !isAbsolute(patch)) throw probeFailure();
      if (cleanupBlocked) {
        // A blocked state after an unconfirmed sweep can only be resolved by
        // an escalation to whole-tree recovery (the host terminates and
        // rebuilds its owned job), never by observing the direct child exit.
        return Object.freeze({
          stage: "surface-failed",
          outcome: "dsh-surface-tree-unconfirmed",
          reason: "dsh-surface-tree-unconfirmed",
          carrierGeneration: 0,
        });
      }
      const node = join(root, "node", "node.exe");
      const entry = join(root, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      await mkdir(home, { recursive: true });
      await mkdir(join(home, "AppData", "Roaming"), { recursive: true });
      await mkdir(join(home, "AppData", "Local"), { recursive: true });
      // Host-owned quarantine guard: applied as the LAST patch overlay on
      // every spawn, so plugin-manager bundle reconciliation or user edits
      // can never resurrect a quarantined loader entry for this boot.
      const guardPatch = join(resolve(stateRoot), PLUGIN_COMPAT_GUARD_FILENAME);
      // Read-side protection: even a guard file written by an older build (or
      // before an official patch grew a protected id) is re-filtered here so
      // core entries can never be disabled by a stale file.
      const guardActive = await access(guardPatch).then(async () => {
        const guardBytes = await readFile(guardPatch).catch(() => null);
        if (!guardBytes || guardBytes.length > 64 * 1024) return false;
        const guardedIds = [...guardBytes.toString("utf8").matchAll(/^- id: ([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/gmu)]
          .map((match) => match[1]);
        const protectedIds = await collectCoreProtectedEntryIds(runtimeRoot);
        const filtered = guardedIds.filter((id) => !protectedIds.has(id));
        if (filtered.length === guardedIds.length) return true;
        const { text: filteredText } = buildGuardPatch(filtered, protectedIds);
        if (filteredText === "") {
          await rm(guardPatch, { force: true });
          return false;
        }
        const temporary = `${guardPatch}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(temporary, filteredText, "utf8");
        await rename(temporary, guardPatch);
        return true;
      }, () => false);
      const spawnArgs = [entry, "web", "--patch", patch];
      if (guardActive) spawnArgs.push("--patch", guardPatch);
      spawnArgs.push("--no-open", "--host", "127.0.0.1", "--port", "0");
      const authority = nextBinding();
      const resourceAuthority = {
        protocol: 1,
        generation: authority.generation,
        secret: randomBytes(32).toString("hex"),
      };
      const diagnostics = createSurfaceDiagnostics();
      let watchdogTimer = null;
      const child = spawn(node, spawnArgs, {
        cwd: home,
        env: minimalDshEnvironment(home),
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      if (typeof onChildStarted === "function") onChildStarted(child);
      // Spawn-time ownership: a synchronous spawn failure, an early exit, or
      // a broken pipe must resolve the ready wait — never leak a pending child.
      const spawnExit = new Promise((resolveExit) => {
        child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
        child.once("exit", (code, signal) => resolveExit({ code, signal, error: null }));
      });
      spawnExit.then(() => { clearTimeout(watchdogTimer); });
      const router = createSurfaceControlChannel({
        stream: child.stdio[6],
        onState: (carrierGeneration, sessionOpen) => {
          // Any settled surface state (client-ready or the stronger
          // session-open) disarms the post-ready health watchdog: the loader
          // tree proved itself.
          clearTimeout(watchdogTimer);
          if (typeof onSurfaceStage === "function") {
            onSurfaceStage(carrierGeneration, sessionOpen === null ? "client-ready" : "session-open");
          }
        },
        onInvalid: () => {
          // A graceful whole-application disposal closes its private pipes.
          // During update stop, a pipe loss is refusal/unknown, never authority
          // to kill a possibly-saving runtime. Exact stop ACK + exit0 decide.
          if (current?.child === child && current.updateStopping) return;
          void killOwnedChildTree(child);
        },
      });
      const resourceRouter = createChildResourceRouter({
        authority: resourceAuthority,
        request: child.stdio[8],
        response: child.stdio[9],
        forward: (type, payload) => {
          if (typeof resourceRequest !== "function") throw new Error("dsh-resource-broker-unavailable");
          return resourceRequest(type, payload);
        },
        onInvalid: () => {
          if (current?.child === child && current.updateStopping) return;
          void killOwnedChildTree(child);
        },
      });
      router.setBinding(authority.generation);
      child.stdio[3].end(JSON.stringify(authority));
      child.stdio[7].end(JSON.stringify(resourceAuthority));
      // Relay the official launch URL (printed once the official loader
      // settles) to the carrier so its bootstrap redirect mints the official
      // browser session required by the 0.1.5 Connection index fence.
      let launchUrlSeq = 0;
      const launchLines = createInterface({ input: child.stdio[1], crlfDelay: Infinity, terminal: false });
      // Diagnostics stay in a bounded ring inside the wrapper; only verified
      // structure-level facts are ever surfaced to the host.
      diagnostics.attach(child.stdio[2]);
      launchLines.on("line", (line) => {
        const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d{1,5}\/\?token=[A-Za-z0-9_-]{16,240})/u.exec(line);
        if (!match || child.exitCode !== null) return;
        launchUrlSeq += 1;
        child.stdio[5].write(`${JSON.stringify({ type: "launch-url", seq: launchUrlSeq, launchUrl: match[1] })}\n`);
      });
      let readyLine = null;
      let startFailure = null;
      const readyWait = lineFromStream(child.stdio[4], DSH_SURFACE_READY_TIMEOUT_MS);
      const earlyExit = spawnExit.then((outcome) => (outcome.error ? "surface-spawn-error" : "surface-early-exit"));
      const settled = await Promise.race([
        readyWait.then((line) => ({ line }), (error) => ({ error })),
        earlyExit.then((reason) => ({ reason })),
      ]);
      if (settled.reason !== undefined) {
        startFailure = settled.reason;
      } else if (settled.error !== undefined) {
        startFailure = "surface-ready-timeout";
      } else if (settled.line !== undefined) {
        readyLine = settled.line;
      }
      if (startFailure !== null) {
        const reclaim = await killOwnedChildTree(child);
        if (reclaim.confirmed !== true) { cleanupBlocked = true; lastUnconfirmedChild = child; }
        router.close();
        resourceRouter.close();
        // The exit event can beat the final stderr data event. Wait for the
        // bounded pipe-drain signal before classifying instead of sleeping
        // for an arbitrary grace period.
        await diagnostics.settle();
        const diagnostic = diagnostics.classify();
        return Object.freeze({
          stage: "surface-failed",
          outcome: reclaim.confirmed === true
            ? startFailure
            : "surface-reclaim-unconfirmed",
          reason: diagnostic.kind === "unknown" ? startFailure : `plugin-surface-${diagnostic.kind}`,
          diagnostic,
          reclaim,
          carrierGeneration: 0,
        });
      }
      let ready = null;
      try {
        ready = JSON.parse(readyLine);
      } catch { ready = null; }
      if (ready?.type !== "carrier-ready" || ready.generation !== authority.generation
        || !Number.isSafeInteger(ready.port) || ready.port <= 0
        || ready.bootstrapRef !== authority.bootstrapRef) {
        const reclaim = await killOwnedChildTree(child);
        if (reclaim.confirmed !== true) { cleanupBlocked = true; lastUnconfirmedChild = child; }
        router.close();
        resourceRouter.close();
        await diagnostics.settle();
        const diagnostic = diagnostics.classify();
        return Object.freeze({
          stage: "surface-failed",
          outcome: reclaim.confirmed === true
            ? "surface-handshake-invalid"
            : "surface-reclaim-unconfirmed",
          reason: diagnostic.kind === "unknown" ? "surface-handshake-invalid" : `plugin-surface-${diagnostic.kind}`,
          diagnostic,
          reclaim,
          carrierGeneration: 0,
        });
      }
      const projection = Object.freeze({
        stage: "surface-ready", outcome: "accepted", port: ready.port,
        carrierGeneration: authority.generation,
        bootstrapPath: ready.bootstrapPath, bootstrapRef: ready.bootstrapRef,
        rssBytes: process.memoryUsage().rss, ownedProcessCount: 2,
      });
      current = {
        child, ready: projection, port: ready.port, controlSeq: 0,
        router, resourceRouter, bindingGeneration: authority.generation,
      };
      // Post-ready health watchdog: carrier-ready alone does not prove the
      // loader tree or the HTTP listener came up. A frozen surface (the
      // v1.9.3 failure mode) is reclaimed and reported here.
      watchdogTimer = setTimeout(() => {
        void (async () => {
          const owned = current;
          if (!owned || owned.child !== child || child.exitCode !== null) return;
          // Claim the loss BEFORE killing: the exit listener must not treat
          // this owned reclamation as an unexpected exit.
          current = null;
          const reclaim = await killOwnedChildTree(child);
          if (reclaim.confirmed !== true) { cleanupBlocked = true; lastUnconfirmedChild = child; }
          if (typeof onSurfaceLost === "function") {
            onSurfaceLost(reclaim.confirmed === true ? "surface-client-stuck" : "surface-tree-unconfirmed");
          }
        })();
      }, clientReadyTimeoutMs);
      armedWatchdog = watchdogTimer;
      if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();
      child.once("exit", (code, signal) => {
        clearTimeout(watchdogTimer);
        router.close();
        resourceRouter.close();
        if (current?.child !== child) return;
        if (current.updateStopping) return;
        current = null;
        // An unexpected exit leaves any descendants (e.g. detached helpers)
        // alive and unenumerable from here: this owned tree is NOT confirmed
        // reclaimed. Block cold starts; the next open reports the escalation
        // reason and the host tears down and rebuilds its whole owned job.
        cleanupBlocked = true;
        lastUnconfirmedChild = child;
        if (typeof onUnexpectedExit === "function") onUnexpectedExit();
      });
      return projection;
    },
    async close() {
      const owned = current;
      const carrierGeneration = owned?.bindingGeneration;
      clearTimeout(armedWatchdog);
      if (owned?.child.exitCode === null) {
        owned.router.revokeBinding();
        await control(owned, { type: "binding-close" });
        owned.bindingGeneration = 0;
      }
      return Object.freeze({
        stage: "surface-closed", outcome: "accepted",
        carrierGeneration,
        rssBytes: process.memoryUsage().rss, ownedProcessCount: owned?.child.exitCode === null ? 2 : 1,
      });
    },
    async syncModel() {
      const owned = current;
      if (owned?.child.exitCode !== null || owned.bindingGeneration <= 0) throw probeFailure();
      const result = await control(owned, { type: "model-sync" });
      return Object.freeze({ payload: result.payload });
    },
    async stageIntent(payload) {
      const owned = current;
      if (owned?.child.exitCode !== null || owned.bindingGeneration <= 0
        || typeof payload !== "string" || payload.length === 0 || Buffer.byteLength(payload, "utf8") > 376 * 1024) {
        throw probeFailure();
      }
      await control(owned, { type: "open-intent", payload });
      return Object.freeze({ outcome: "accepted" });
    },
    async intentStatus(intentId) {
      const owned = current;
      if (owned?.child.exitCode !== null || owned.bindingGeneration <= 0
        || typeof intentId !== "string" || !/^intent-[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(intentId)) {
        throw probeFailure();
      }
      const result = await control(owned, { type: "open-intent-status", intentId });
      if (!["pending", "applied", "unavailable"].includes(result.payload)) throw probeFailure();
      return Object.freeze({ payload: result.payload });
    },
    async shutdown() {
      const owned = current;
      current = null;
      clearTimeout(armedWatchdog);
      if (owned?.child.exitCode === null) {
        owned.router.close();
        owned.resourceRouter.close();
        const reclaim = await killOwnedChildTree(owned.child);
        if (reclaim.confirmed !== true) {
          cleanupBlocked = true;
          lastUnconfirmedChild = owned.child;
        } else {
          cleanupBlocked = false;
          lastUnconfirmedChild = null;
        }
      }
      // When the direct child already exited, its descendants (if any) were
      // never enumerable from here; an existing unconfirmed block stays.
    },
  });
}

/**
 * L1 baseline trial: boots the SAME target DSH web entry with official
 * bundles only inside a throwaway temp home and proves the loader tree +
 * HTTP listener actually settle (official launch URL + answered request).
 * No third-party code runs here, no user data is copied, and the trial root
 * is removed afterwards. This is a baseline boot proof, not a claim that any
 * plugin combination was exercised.
 */
export async function runBaselineSurfaceTrial({ runtimeRoot, timeoutMs = 90_000 }) {
  const { mkdtemp } = await import("node:fs/promises");
  const root = resolve(runtimeRoot);
  const node = join(root, "node", "node.exe");
  const entry = join(root, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const home = await mkdtemp(join(tmpdir(), "luckyray-compat-trial-"));
  let child = null;
  try {
    await mkdir(join(home, "AppData", "Roaming"), { recursive: true });
    await mkdir(join(home, "AppData", "Local"), { recursive: true });
    child = spawn(node, [entry, "web", "--no-open", "--host", "127.0.0.1", "--port", "0"], {
      cwd: home,
      env: minimalDshEnvironment(home),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // An unconsumed stderr pipe fills its OS buffer and deadlocks the child's
    // boot logging before the launch URL is ever printed. Drain it.
    child.stderr.resume();
    const urlPattern = /^dsh web: http:\/\/127\.0\.0\.1:(\d{1,5})\//u;
    const launchPort = await new Promise((resolvePort, rejectPort) => {
      let pending = "";
      const timer = setTimeout(() => rejectPort(new Error("baseline-trial-timeout")), timeoutMs);
      const finish = (value) => {
        clearTimeout(timer);
        child.stdout.removeListener("data", onData);
        value instanceof Error ? rejectPort(value) : resolvePort(value);
      };
      const onData = (chunk) => {
        // Line-anchored: boot may print other diagnostics before the URL.
        pending = (pending + chunk.toString("utf8")).slice(-8192);
        for (const line of pending.split(/\r?\n/u)) {
          const match = urlPattern.exec(line);
          if (match) {
            finish(Number(match[1]));
            return;
          }
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.once("exit", () => finish(new Error("baseline-trial-exit")));
      child.once("error", () => finish(new Error("baseline-trial-spawn-error")));
    });
    let answered = false;
    let httpStatus = 0;
    try {
      const response = await fetch(`http://127.0.0.1:${launchPort}/`, { signal: AbortSignal.timeout(10_000) });
      httpStatus = response.status;
      answered = true;
    } catch {
      answered = false;
    }
    if (!answered) throw new Error("baseline-trial-http-unanswered");
    return { outcome: "pass", evidence: "baseline-boot+http", port: launchPort, httpStatus };
  } catch (error) {
    return {
      outcome: "fail",
      evidence: "baseline-boot+http",
      reason: error instanceof Error ? error.message : "baseline-trial-failed",
    };
  } finally {
    if (child && child.exitCode === null) {
      await killOwnedChildTree(child).catch(() => {});
    }
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

async function runtimeCompositionDigest(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const manifest = await readFile(join(root, "host", "node_modules", "@deepseek-ai", "dsh", "package.json")).catch(() => null);
  if (!manifest) return null;
  // Composition identity includes the host adapter itself and the exact node
  // runtime, not just the DSH package: adapter behavior changes must
  // invalidate verdicts recorded for an older bridge.
  const adapter = await readFile(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")).catch(() => null);
  const digest = createHash("sha256");
  digest.update(manifest);
  digest.update(COMPAT_CHECKER_VERSION.toString());
  digest.update(process.version);
  if (adapter) digest.update(adapter);
  return digest.digest("hex");
}

/** Entry ids owned by official bundles (core/auth/approval/bridge loaders).
 * Guard emission refuses these ids so a third-party id collision or a
 * mis-parsed patch can never disable core functionality. */
export async function collectCoreProtectedEntryIds(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const protectedIds = new Set();
  for (const bundleName of OFFICIAL_PROFILE_BUNDLES) {
    if (!bundleName.startsWith("@deepseek-ai/")) continue;
    const patchBytes = await readFile(join(root, "host", "node_modules", bundleName, "cordis.patch.yml")).catch(() => null);
    if (!patchBytes || patchBytes.length > 256 * 1024) continue;
    for (const match of patchBytes.toString("utf8").matchAll(/^\s*-?\s*id\s*:\s*['"]?([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})['"]?\s*$/gmu)) {
      protectedIds.add(match[1]);
    }
  }
  return protectedIds;
}

/**
 * Host-owned compatibility authority exposed over the frame protocol. All
 * reads of user profile data are read-only; writes only touch LuckyRay-owned
 * state/guard files in the surface state root.
 */
export function createPluginCompatService({ runtimeRoot, stateRoot, surfaceHome, failureProbe = null }) {
  const profileRoot = join(resolve(surfaceHome), "profiles", "web");
  const manifestPath = join(profileRoot, "package.json");

  async function readManifest() {
    const bytes = await readFile(manifestPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw stateError("plugin-compat-manifest-unreadable");
    });
    if (bytes === null) {
      return { missing: true, valid: false, manifest: { bundles: [], dependencies: {} }, text: "" };
    }
    const text = bytes.toString("utf8");
    try {
      return { missing: false, valid: true, manifest: parseProfileManifest(text), text };
    } catch {
      return { missing: false, valid: false, manifest: { bundles: [], dependencies: {} }, text };
    }
  }

  /** One third-party package as actually loaded: bundle provenance, the
   * package's own mount declaration (default or dsh.bundle.patch path),
   * resolved loader entry ids, and its exact entry digest. */
  async function inspectThirdPartyPackage(bundleName, mountSource) {
    const packageDir = join(profileRoot, "node_modules", ...bundleName.split("/"));
    const manifestBytes = await readFile(join(packageDir, "package.json")).catch(() => null);
    if (!manifestBytes || manifestBytes.length > 64 * 1024) return null;
    let packageManifest = null;
    try {
      packageManifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch { packageManifest = null; }
    const version = packageManifest?.version ?? null;
    // Packages may declare a custom bundle-patch path; default is
    // cordis.patch.yml at the package root.
    const declaredPatchPath = typeof packageManifest?.dsh?.bundle?.patch === "string"
      && packageManifest.dsh.bundle.patch.length > 0
      && !packageManifest.dsh.bundle.patch.includes("..")
      ? packageManifest.dsh.bundle.patch.replace(/^[./]+/u, "")
      : "cordis.patch.yml";
    const rawPatchBytes = await readFile(join(packageDir, declaredPatchPath)).catch(() => null);
    const patchBytes = rawPatchBytes && rawPatchBytes.length <= 128 * 1024 ? rawPatchBytes : null;
    // Composition digest covers manifest + the actually-scanned module
    // graph + the declared patch bytes — identical formula (including the
    // 128KB bound) to staticPluginVerdict so a recorded verdict and the live
    // inventory always agree on what "these bytes" means.
    const scan = await scanPluginStaticImportsForDigest(packageDir, packageManifest);
    const entryDigest = createHash("sha256")
      .update(manifestBytes)
      .update(scan ?? "")
      .update(patchBytes ?? Buffer.alloc(0))
      .digest("hex");
    const entries = patchBytes && patchBytes.length <= 128 * 1024
      ? parseBundlePatchEntries(patchBytes.toString("utf8"), bundleName)
      : [{ entryId: bundleName, packageName: bundleName, resolved: false }];
    return { packageDir, version, entryDigest, entries, mountSource };
  }

  async function scanPluginStaticImportsForDigest(packageDir, packageManifest) {
    const { scanPluginStaticImports } = await import("./luckyray-dsh-plugin-compat.mjs");
    const result = await scanPluginStaticImports(packageDir, packageManifest);
    return result.ok ? result.graphDigest : null;
  }

  /**
   * Inventory every third-party loader the effective composition can load:
   * manifest bundles, the profile's own user patch layer, and the home-level
   * patch — each preserving bundle→entry→package identity. Mount entries
   * that name a non-official package (a bundle mounting a dependency's
   * loader) keep that dependency live for quarantine purposes.
   */
  async function collectPlugins(manifest) {
    const byEntry = new Map();
    const absorb = (bundleName, mountSource) => {
      const existing = byEntry.get(`${bundleName}|${mountSource}`);
      if (existing) return existing;
      const record = { promise: inspectThirdPartyPackage(bundleName, mountSource) };
      byEntry.set(`${bundleName}|${mountSource}`, record);
      return record;
    };
    const layerMounts = [];
    for (const bundleName of manifest.bundles) {
      if (!isThirdPartyBundle(bundleName)) continue;
      absorb(bundleName, "bundle");
    }
    // Profile user patch layer + home-level patch: manual mounts of
    // third-party loaders that never appear in the bundle list. The ENTRY
    // DECLARATION lives in the layer patch itself — the mounted package only
    // contributes identity (version/digest/dir), never its own patch.
    for (const patchLayer of [join(profileRoot, "cordis.patch.yml"), join(resolve(surfaceHome), "cordis.patch.yml")]) {
      const patchBytes = await readFile(patchLayer).catch(() => null);
      if (!patchBytes || patchBytes.length > 128 * 1024) continue;
      for (const entry of parseBundlePatchEntries(patchBytes.toString("utf8"), "")) {
        const target = entry.packageName ?? entry.entryId;
        if (!target || OFFICIAL_PROFILE_BUNDLES.has(target) || target.startsWith("@deepseek-ai/")) continue;
        layerMounts.push({ target, entry });
        absorb(target, "patch-layer");
      }
    }
    const layerEntriesByTarget = new Map();
    for (const mount of layerMounts) {
      if (!layerEntriesByTarget.has(mount.target)) layerEntriesByTarget.set(mount.target, []);
      layerEntriesByTarget.get(mount.target).push(mount.entry);
    }
    const plugins = [];
    for (const [key, record] of byEntry) {
      const inspected = await record.promise;
      if (!inspected) {
        // A bundle the manifest loads but whose package cannot be read must
        // stay visible as an unverifiable placeholder — it never silently
        // disappears from inventory or reads as a clean plan.
        const [bundleName, mountSource] = key.split("|");
        plugins.push({
          entryId: bundleName,
          packageName: bundleName,
          bundleName,
          mountSource,
          resolved: false,
          unreadable: true,
          version: null,
          packageDir: null,
          entryDigest: null,
        });
        continue;
      }
      const [bundleName, mountSource] = key.split("|");
      if (mountSource === "patch-layer") {
        for (const entry of layerEntriesByTarget.get(bundleName) ?? []) {
          plugins.push({
            entryId: entry.entryId,
            packageName: entry.packageName ?? bundleName,
            bundleName,
            mountSource,
            resolved: entry.resolved === true,
            version: inspected.version,
            packageDir: inspected.packageDir,
            entryDigest: inspected.entryDigest,
          });
        }
        continue;
      }
      for (const entry of inspected.entries) {
        plugins.push({
          entryId: entry.entryId,
          packageName: entry.packageName ?? bundleName,
          bundleName,
          mountSource,
          resolved: entry.resolved === true,
          version: inspected.version,
          packageDir: inspected.packageDir,
          entryDigest: inspected.entryDigest,
        });
      }
    }
    return plugins;
  }

  async function status() {
    const [state, manifestInfo, runtimeDigest] = await Promise.all([
      readCompatState(stateRoot),
      readManifest(),
      runtimeCompositionDigest(runtimeRoot),
    ]);
    const plugins = manifestInfo.valid ? await collectPlugins(manifestInfo.manifest) : [];
    // Installed dependencies are not necessarily enabled bundles. Keep this
    // read-only inventory separate from the effective loader/quarantine set.
    const inactiveDependencies = await Promise.all(Object.keys(manifestInfo.manifest.dependencies)
      .filter((name) => /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(name)
        && !name.startsWith("@deepseek-ai/") && isThirdPartyBundle(name)
        && !plugins.some((plugin) => plugin.bundleName === name || plugin.packageName === name))
      .slice(0, 64).map(async (packageName) => {
        const info = await inspectThirdPartyPackage(packageName, "dependency-only");
        return { packageName, version: info?.version ?? null, installed: info !== null };
      }));
    const runtimePackage = await readFile(join(runtimeRoot, "host", "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8")
      .then((text) => JSON.parse(text)).catch(() => null);
    const runtimeVersion = typeof runtimePackage?.version === "string"
      && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u.test(runtimePackage.version)
      ? runtimePackage.version : null;
    const patchLayers = await Promise.all([
      ["profile", join(profileRoot, "cordis.patch.yml")],
      ["home", join(resolve(surfaceHome), "cordis.patch.yml")],
    ].map(async ([layer, path]) => {
      try {
        const bytes = await readFile(path);
        return { layer, state: bytes.length > 128 * 1024 ? "too-large" : "read" };
      } catch (error) { return { layer, state: error?.code === "ENOENT" ? "absent" : "unreadable" }; }
    }));
    const quarantineSet = projectQuarantineSet(state, plugins);
    const cacheKey = computeCompositionCacheKey({
      runtimeDigest,
      plugins: plugins.map((plugin) => ({
        ...plugin,
        digest: plugin.entryDigest,
      })),
      manifestText: manifestInfo.text,
      guardEntryIds: quarantineSet,
    });
    return {
      manifestMissing: manifestInfo.missing,
      manifestValid: manifestInfo.valid,
      runtimeVersion,
      inactiveDependencies,
      patchLayers,
      historicalQuarantine: state.plugins.filter((record) => record.quarantined
        && !plugins.some((plugin) => plugin.entryId === record.entryId && plugin.packageName === record.packageName))
        .map(({ entryId, packageName, version }) => ({ entryId, packageName, version })),
      bundles: manifestInfo.manifest.bundles,
      plugins: plugins.map((plugin) => {
        const record = validRecordOf(state, plugin);
        return {
          entryId: plugin.entryId,
          packageName: plugin.packageName,
          version: plugin.version,
          resolved: plugin.resolved,
          outcome: record?.outcome ?? "unchecked",
          reason: record?.reason ?? null,
          quarantined: record?.quarantined === true,
          quarantineReason: record?.quarantineReason ?? null,
        };
      }),
      quarantineSet,
      cacheKey,
      checkerVersion: COMPAT_CHECKER_VERSION,
      dynamicTrial: "environment-limited",
    };
  }

  function stateRecordOf(state, plugin) {
    // Exact pair match only: an entry id colliding with another package's
    // name must never borrow that record's verdict or quarantine state.
    return state.plugins.find((record) => (
      record.entryId === plugin.entryId && record.packageName === plugin.packageName
    )) ?? null;
  }

  /** A record only represents the plugin on disk when its recorded digest
   * matches the live entry digest — a stale record (upgraded plugin, edited
   * entry) must never project its old verdict onto the new bytes. */
  function validRecordOf(state, plugin) {
    if (state.checkerVersion !== COMPAT_CHECKER_VERSION) return null;
    const record = stateRecordOf(state, plugin);
    if (!record) return null;
    if (!plugin.entryDigest || !record.digest || record.digest !== plugin.entryDigest) {
      return null;
    }
    return record;
  }

  async function check(request = {}) {
    const state = await readCompatState(stateRoot);
    const manifestInfo = await readManifest();
    if (!manifestInfo.valid) {
      return { checked: false, reason: "plugin-compat-manifest-invalid", plugins: [] };
    }
    const plugins = await collectPlugins(manifestInfo.manifest);
    const runtimeDigest = await runtimeCompositionDigest(runtimeRoot);
    // Exact-composition cache: when the recorded verdicts were produced for
    // this very composition (runtime+adapter+node, manifests, entry bytes,
    // guard), a normal re-check reuses them. Any relevant byte change alters
    // the key — and stale-digest records never count as coverage.
    const candidateKey = computeCompositionCacheKey({
      runtimeDigest,
      plugins: plugins.map((plugin) => ({ ...plugin, digest: plugin.entryDigest })),
      manifestText: manifestInfo.text,
      guardEntryIds: projectQuarantineSet(state, plugins),
    });
    if (state.cacheKey === candidateKey && plugins.length > 0
      && plugins.every((plugin) => {
        const record = validRecordOf(state, plugin);
        return record && record.outcome !== "unchecked";
      })) {
      return {
        checked: true,
        cached: true,
        plugins: plugins.map((plugin) => {
          const record = validRecordOf(state, plugin);
          return {
            entryId: plugin.entryId,
            packageName: plugin.packageName,
            version: plugin.version,
            resolved: plugin.resolved,
            outcome: record.outcome,
            reason: record.reason,
            quarantined: record.quarantined === true,
            quarantineReason: record.quarantineReason ?? null,
          };
        }),
        baseline: null,
        dynamicTrial: "environment-limited",
        note: "exact composition cache hit; static rescan and baseline trial skipped",
      };
    }
    const findings = [];
    for (const plugin of plugins) {
      if (!plugin.packageDir) {
        // Unreadable placeholder: record it as unknown instead of throwing
        // and poisoning the whole check.
        findings.push({
          entryId: plugin.entryId,
          packageName: plugin.packageName,
          version: null,
          resolved: false,
          digest: null,
          outcome: "unknown",
          reason: "plugin-compat-package-unreadable",
          evidence: "static",
          findings: [],
        });
        continue;
      }
      const verdict = await staticPluginVerdict({ plugin, runtimeRoot });
      findings.push({
        entryId: plugin.entryId,
        packageName: plugin.packageName,
        version: plugin.version,
        resolved: plugin.resolved,
        digest: verdict.digest,
        outcome: verdict.outcome,
        reason: verdict.reason,
        evidence: verdict.evidence,
        findings: verdict.findings,
      });
    }
    let baseline = null;
    if (request?.baseline === true) {
      baseline = await runBaselineSurfaceTrial({ runtimeRoot });
    }
    const merged = new Map(state.plugins.map((record) => [`${record.packageName}|${record.entryId}`, record]));
    for (const finding of findings) {
      const key = `${finding.packageName}|${finding.entryId}`;
      const previous = merged.get(key);
      merged.set(key, {
        entryId: finding.entryId,
        packageName: finding.packageName,
        version: finding.version,
        digest: finding.digest,
        resolved: finding.resolved !== false,
        outcome: finding.outcome,
        reason: finding.reason,
        evidence: finding.evidence,
        findings: finding.findings,
        quarantined: previous?.quarantined === true,
        quarantinedAt: previous?.quarantinedAt ?? null,
        quarantineReason: previous?.quarantineReason ?? null,
      });
    }
    const nextState = { plugins: [...merged.values()].slice(0, 64), cacheKey: candidateKey, runtimeDigest };
    const written = await writeCompatState(stateRoot, nextState);
    const quarantineSet = projectQuarantineSet(written, plugins);
    const protectedIds = await collectCoreProtectedEntryIds(runtimeRoot);
    await writeGuardPatch(stateRoot, quarantineSet, protectedIds);
    return {
      checked: true,
      plugins: written.plugins.map(({ entryId, packageName, version, resolved, outcome, reason, quarantined, quarantineReason }) => ({
        entryId, packageName, version, resolved: resolved !== false, outcome, reason, quarantined, quarantineReason,
      })),
      baseline,
      dynamicTrial: "environment-limited",
      note: "static manifest/import verification plus optional official-bundle baseline boot; third-party dynamic trial not executed in this environment",
    };
  }

  /**
   * Pre-load gate wired into the real spawn boundary (surface-open): for the
   * current effective composition, establish verdicts for anything without a
   * valid record (first run, changed bytes, new adapter) and auto-quarantine
   * statically failing third-party entries before the loader ever imports
   * them. Bounded: static reads only, no baseline trial, cache reuse.
   */
  async function ensureLoadPlan() {
    const state = await readCompatState(stateRoot);
    const manifestInfo = await readManifest();
    if (!manifestInfo.valid) {
      // A present-but-unparseable manifest is a broken effective config: the
      // plan is invalid and the frame entry stops the load. A MISSING
      // manifest is a fresh DSH home (the official boot creates it): the
      // normal first boot proceeds with nothing to check.
      return {
        planValid: manifestInfo.missing === true,
        checked: false,
        reason: manifestInfo.missing === true ? null : "plugin-compat-manifest-invalid",
        quarantinedNow: [],
      };
    }
    const plugins = await collectPlugins(manifestInfo.manifest);
    if (plugins.length === 0) {
      return { planValid: true, checked: true, quarantinedNow: [], cacheKey: state.cacheKey ?? null };
    }
    const runtimeDigest = await runtimeCompositionDigest(runtimeRoot);
    const runtimeChanged = plugins.length > 0
      && typeof state.runtimeDigest === "string"
      && state.runtimeDigest !== runtimeDigest;
    const merged = new Map(state.plugins.map((record) => [`${record.packageName}|${record.entryId}`, record]));
    const quarantinedNow = [];
    for (const plugin of plugins) {
      const key = `${plugin.packageName}|${plugin.entryId}`;
      const valid = runtimeChanged ? null : validRecordOf(state, plugin);
      if (valid && valid.outcome !== "unchecked" && valid.outcome !== "fail") continue;
      if (valid && valid.outcome === "fail" && valid.quarantined === true) continue;
      // An unreadable placeholder cannot be statically judged: it stays
      // visible and unverifiable instead of being skipped as "checked".
      if (plugin.unreadable === true) {
        if (!merged.has(key)) {
          merged.set(key, {
            entryId: plugin.entryId,
            packageName: plugin.packageName,
            version: null,
            digest: null,
            resolved: false,
            outcome: "unknown",
            reason: "plugin-compat-package-unreadable",
            evidence: "static",
            findings: [],
            quarantined: false,
            quarantinedAt: null,
            quarantineReason: null,
          });
        }
        continue;
      }
      const verdict = await staticPluginVerdict({ plugin, runtimeRoot });
      const previous = merged.get(key);
      merged.set(key, {
        entryId: plugin.entryId,
        packageName: plugin.packageName,
        version: plugin.version,
        digest: verdict.digest,
        resolved: plugin.resolved !== false,
        outcome: verdict.outcome,
        reason: verdict.reason,
        evidence: verdict.evidence,
        findings: verdict.findings,
        quarantined: previous?.quarantined === true,
        quarantinedAt: previous?.quarantinedAt ?? null,
        quarantineReason: previous?.quarantineReason ?? null,
      });
      if (verdict.outcome === "fail" && !(previous?.quarantined === true)) {
        const record = merged.get(key);
        record.quarantined = true;
        record.quarantinedAt = new Date().toISOString();
        record.quarantineReason = "auto-precheck";
        quarantinedNow.push(plugin.entryId);
      }
    }
    // Dynamic loading and bounded-scan uncertainty stay ordinary `unknown`.
    // Known incomplete inputs are different: a configured package/entry or a
    // statically referenced local module is missing/unreadable, so the exact
    // composition cannot be admitted until it is repaired or quarantined.
    const restrictions = plugins.map((plugin) => {
      if (plugin.unreadable === true || plugin.resolved === false) {
        return { packageName: plugin.packageName, reason: "plugin-compat-package-unreadable" };
      }
      const record = merged.get(`${plugin.packageName}|${plugin.entryId}`);
      if (record?.outcome !== "unknown") return null;
      const reasons = [record.reason, ...(record.findings ?? []).map((finding) => finding?.reason)]
        .filter((reason) => typeof reason === "string");
      const reason = reasons.find((candidate) => (
        candidate === "plugin-compat-package-unreadable"
        || candidate === "plugin-compat-package-invalid"
        || candidate === "plugin-compat-entry-unreadable"
        || candidate === "plugin-compat-entry-bytes-unreadable"
        || candidate.startsWith("plugin-compat-static-module-missing:")
      ));
      if (!reason) return null;
      return {
        packageName: plugin.packageName,
        reason: reason.startsWith("plugin-compat-static-module-missing:")
          ? "plugin-compat-static-module-missing"
          : reason,
      };
    }).filter(Boolean);
    const restrictedSet = [...new Set(restrictions.map((item) => item.packageName))];
    const restrictedReason = restrictions[0]?.reason ?? null;
    if (quarantinedNow.length === 0 && merged.size === state.plugins.length && !runtimeChanged) {
      return {
        planValid: true,
        checked: true,
        quarantinedNow: [],
        cacheKey: state.cacheKey ?? null,
        unverifiable: restrictedSet,
        reason: restrictedReason,
      };
    }
    const written = await writeCompatState(stateRoot, { plugins: [...merged.values()].slice(0, 64), runtimeDigest });
    const quarantineSet = projectQuarantineSet(written, plugins);
    const protectedIds = await collectCoreProtectedEntryIds(runtimeRoot);
    const guard = await writeGuardPatch(stateRoot, quarantineSet, protectedIds);
    return {
      planValid: true,
      checked: true,
      quarantinedNow,
      quarantineSet,
      guardActive: guard.guardPath !== null,
      unverifiable: restrictedSet,
      reason: restrictedReason,
      cacheKey: null,
    };
  }

  async function apply(request = {}) {
    const state = await readCompatState(stateRoot);
    const manifestInfo = await readManifest();
    if (!manifestInfo.valid) {
      return { applied: false, reason: "plugin-compat-manifest-invalid" };
    }
    // Decisions are built from the CURRENT effective composition, never from
    // stale records alone: a first run with no state at all still produces a
    // correct plan.
    const plugins = await collectPlugins(manifestInfo.manifest);
    const knownByEntry = new Map(plugins.map((plugin) => [plugin.entryId, plugin]));
    const merged = new Map(state.plugins.map((record) => [`${record.packageName}|${record.entryId}`, record]));
    const protectedIds = await collectCoreProtectedEntryIds(runtimeRoot);
    const ensureRecord = (plugin) => {
      const key = `${plugin.packageName}|${plugin.entryId}`;
      let record = merged.get(key);
      const valid = record && plugin.entryDigest && record.digest === plugin.entryDigest;
      if (!valid) {
        // No record or a stale one: establish the verdict for the bytes that
        // are actually about to load before deciding anything.
        const verdict = plugin.packageDir
          ? { pending: staticPluginVerdict({ plugin, runtimeRoot }) }
          : { pending: null };
        record = {
          entryId: plugin.entryId,
          packageName: plugin.packageName,
          version: plugin.version,
          digest: null,
          resolved: plugin.resolved !== false,
          outcome: "unchecked",
          reason: null,
          evidence: null,
          findings: [],
          quarantined: false,
          quarantinedAt: null,
          quarantineReason: null,
        };
        merged.set(key, record);
        return { record, verdict };
      }
      return { record, verdict: null };
    };
    let note = null;
    const unquarantinable = [];
    const unreadableTargets = plugins.filter((plugin) => plugin.unreadable === true).map((plugin) => plugin.packageName);
    for (const target of unreadableTargets) {
      unquarantinable.push(target);
    }
    let applied = unquarantinable.length === 0;
    const markQuarantined = (record, reason) => {
      record.quarantined = true;
      record.quarantinedAt = new Date().toISOString();
      record.quarantineReason = record.quarantineReason ?? reason;
    };
    if (request?.kind === "normal") {
      for (const record of merged.values()) {
        record.quarantined = false;
        record.quarantinedAt = null;
        record.quarantineReason = null;
      }
    } else if (request?.kind === "compatible") {
      // Baseline compatibility: suspend EVERY third-party loader of the
      // current composition (verdicts are still recorded for the UI), while
      // official bundles, auth, approval and the bridge keep loading.
      for (const plugin of plugins) {
        const { record, verdict } = ensureRecord(plugin);
        if (verdict?.pending) {
          const resolved = await verdict.pending.catch(() => null);
          if (resolved) {
            record.digest = resolved.digest;
            record.outcome = resolved.outcome;
            record.reason = resolved.reason;
            record.evidence = resolved.evidence;
            record.findings = resolved.findings;
            record.version = plugin.version;
          }
        }
        if (plugin.resolved === false) {
          unquarantinable.push(plugin.packageName);
          continue;
        }
        markQuarantined(record, "compat-mode");
      }
    } else if (request?.kind === "auto") {
      // Post-failure recovery: a verifiable attribution (the classified
      // diagnostic of the failed boot) quarantines exactly that entry;
      // anything less attributes to no single package and falls back to the
      // baseline compatibility path.
      const attribution = typeof request?.entryId === "string"
        ? request.entryId
        : (typeof failureProbe?.diagnostic?.entry === "string" ? failureProbe.diagnostic.entry : null);
      if (attribution && knownByEntry.has(attribution)) {
        const plugin = knownByEntry.get(attribution);
        if (plugin.resolved === false) {
          unquarantinable.push(plugin.packageName);
          note = "plugin-compat-entry-unresolvable";
        } else {
          const { record } = ensureRecord(plugin);
          markQuarantined(record, "startup-failure-attribution");
        }
      } else {
        for (const plugin of plugins) {
          const { record, verdict } = ensureRecord(plugin);
          if (verdict?.pending) {
            const resolved = await verdict.pending.catch(() => null);
            if (resolved) {
              record.digest = resolved.digest;
              record.outcome = resolved.outcome;
              record.reason = resolved.reason;
              record.evidence = resolved.evidence;
              record.findings = resolved.findings;
              record.version = plugin.version;
            }
          }
          if (plugin.resolved === false) {
            unquarantinable.push(plugin.packageName);
            continue;
          }
          markQuarantined(record, "compat-mode-unattributed");
        }
      }
    } else if (request?.kind === "quarantine" && Array.isArray(request.entryIds)) {
      for (const entryId of request.entryIds.slice(0, 32)) {
        if (typeof entryId !== "string") continue;
        const plugin = knownByEntry.get(entryId);
        if (!plugin) continue;
        if (plugin.resolved === false) {
          unquarantinable.push(plugin.packageName);
          continue;
        }
        const { record } = ensureRecord(plugin);
        markQuarantined(record, typeof request.reason === "string" && request.reason.length <= 128
          ? request.reason : "manual");
      }
    } else if (request?.kind === "restore" && typeof request.entryId === "string") {
      const plugin = knownByEntry.get(request.entryId);
      const key = plugin ? `${plugin.packageName}|${plugin.entryId}` : null;
      const record = key ? merged.get(key) : null;
      if (record) {
        record.quarantined = false;
        record.quarantinedAt = null;
        record.quarantineReason = null;
        // A restore requires re-verification of the current bytes before the
        // next load; the pre-load gate re-runs the static verdict then.
        record.outcome = "unchecked";
        record.reason = null;
        record.digest = plugin.entryDigest;
      } else {
        applied = false;
        note = "plugin-compat-entry-unknown";
      }
    } else {
      return { applied: false, reason: "plugin-compat-action-invalid" };
    }
    // Quarantine failures discovered inside the action branches must be
    // reflected in the final honesty of the result.
    applied = applied && unquarantinable.length === 0;
    const written = await writeCompatState(stateRoot, {
      plugins: [...merged.values()].slice(0, 64),
      runtimeDigest: state.runtimeDigest ?? (await runtimeCompositionDigest(runtimeRoot)),
    });
    const quarantineSet = projectQuarantineSet(written, plugins);
    const guard = await writeGuardPatch(stateRoot, quarantineSet, protectedIds);
    return {
      applied,
      quarantineSet,
      guardActive: guard.guardPath !== null,
      skippedEntryIds: guard.skippedEntryIds,
      unquarantinable: [...new Set(unquarantinable)],
      note,
    };
  }

  return Object.freeze({ status, check, apply, ensureLoadPlan });
}

function stateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function lineFromStream(stream, timeoutMs) {
  return new Promise((resolveLine, reject) => {
    let value = "";
    const timeout = setTimeout(() => reject(probeFailure()), timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      value += chunk;
      const at = value.indexOf("\n");
      if (at < 0) return;
      clearTimeout(timeout);
      resolveLine(value.slice(0, at));
    });
    stream.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function probeFailure() {
  return new Error("dsh-native-probe-failed");
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw probeFailure();
  return address.port;
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

function isExactProbeProviderRequest(payload) {
  if (!Array.isArray(payload?.messages)) return false;
  if (payload.messages.some((message) => typeof message?.content === "string")) {
    return payload.messages.filter((message) =>
      message?.role === "user" && message.content === DSH_NATIVE_PROBE_TEXT).length === 1;
  }
  if (payload.messages.length !== 1) return false;
  const [message] = payload.messages;
  if (message?.role !== "user") return false;
  if (message.content === DSH_NATIVE_PROBE_TEXT) return true;
  return Array.isArray(message.content)
    && (message.content.length === 2 || message.content.length === 3)
    && message.content[0]?.type === "text"
    && message.content[0].text === DSH_NATIVE_PROBE_TEXT
    && message.content[1]?.type === "text"
    && typeof message.content[1].text === "string"
    && message.content[1].text.startsWith("Current runtime context.")
    && (message.content.length === 2 || (
      message.content[2]?.type === "text"
      && typeof message.content[2].text === "string"
      && message.content[2].text.startsWith("<system-reminder>\nA skill is a reusable set of task-specific instructions.")
      && message.content[2].text.endsWith("</system-reminder>")
    ));
}

export function createDeterministicProvider() {
  const evidence = {
    requestCount: 0,
    exactTurnRequestCount: 0,
    auxiliaryRequestCount: 0,
    exactPrompt: false,
    exactResponse: false,
  };
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !["/chat/completions", "/v1/messages"].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    let byteCount = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      byteCount += chunk.length;
      if (byteCount > 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      evidence.requestCount += 1;
      const exactTurnPrompt = isExactProbeProviderRequest(payload);
      if (exactTurnPrompt && evidence.requestCount === 1) {
        evidence.exactTurnRequestCount += 1;
        evidence.exactPrompt = true;
      } else {
        evidence.auxiliaryRequestCount += 1;
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "diagnostic request rejected" } }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "close",
      });
      const common = {
        id: "luckyray-dsh-native-probe",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash",
      };
      if (exactTurnPrompt) evidence.exactResponse = true;
      if (request.url === "/v1/messages") {
        for (const event of [
          { type: "message_start", message: { id: "luckyray-dsh-native-probe", type: "message", role: "assistant", model: payload.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: DSH_NATIVE_RESPONSE_TEXT } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
        return;
      }
      response.write(`data: ${JSON.stringify({
        ...common,
        choices: [{ index: 0, delta: { role: "assistant", content: DSH_NATIVE_RESPONSE_TEXT }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        ...common,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return { server, evidence };
}

function strictEventSequence(events) {
  let previous = -1;
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq) || event.seq <= previous) throw probeFailure();
    previous = event.seq;
  }
}

export function validateNativeTurnEvidence(events, providerEvidence) {
  if (!Array.isArray(events)
    || !Number.isSafeInteger(providerEvidence?.requestCount)
    || providerEvidence.requestCount !== 1
    || providerEvidence.exactTurnRequestCount !== 1
    || providerEvidence.auxiliaryRequestCount !== 0
    || providerEvidence.exactPrompt !== true
    || providerEvidence.exactResponse !== true) throw probeFailure();
  const sessions = events.filter((event) => event?.type === "session");
  if (sessions.length !== 1 || events[0] !== sessions[0]
    || typeof sessions[0].id !== "string"
    || !/^session-[a-z0-9-]{8,100}$/u.test(sessions[0].id)) throw probeFailure();
  strictEventSequence(events.slice(1));
  const starts = events.filter((event) => event?.type === "turn/start");
  const ends = events.filter((event) => event?.type === "turn/end");
  const users = events.filter((event) => event?.type === "user/message"
    && event.data?.source?.kind === "user");
  const assistants = events.filter((event) => event?.type === "assistant/message");
  if (starts.length !== 1 || ends.length !== 1 || users.length !== 1 || assistants.length !== 1) {
    throw probeFailure();
  }
  const [started, user, assistant, ended] = [starts[0], users[0], assistants[0], ends[0]];
  const turn = started.data?.turn;
  if (!Number.isSafeInteger(turn) || turn < 0
    || assistant.data?.turn !== turn
    || ended.data?.turn !== turn
    || ended.data?.reason?.kind !== "completed"
    || !JSON.stringify(user).includes(DSH_NATIVE_PROBE_TEXT)
    || !JSON.stringify(assistant).includes(DSH_NATIVE_RESPONSE_TEXT)
    || !(started.seq < user.seq && user.seq < assistant.seq && assistant.seq < ended.seq)) {
    throw probeFailure();
  }
  return { turn };
}

function splitZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== 0xfd2fb528) throw probeFailure();
    offset += 4;
    const descriptor = buffer[offset];
    offset += 1;
    if ((descriptor & 0x18) !== 0) throw probeFailure();
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < headerBytes) throw probeFailure();
    offset += headerBytes;
    for (;;) {
      if (buffer.length - offset < 3) throw probeFailure();
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const last = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw probeFailure();
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) throw probeFailure();
      offset += payloadBytes;
      if (last) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw probeFailure();
      offset += 4;
    }
    frames.push(buffer.subarray(start, offset));
    if (frames.length > 4096) throw probeFailure();
  }
  return frames;
}

async function listSessionLogs(root) {
  const output = [];
  async function visit(directory, depth) {
    if (depth > 8) throw probeFailure();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zstd"))) output.push(target);
    }
  }
  try {
    await visit(root, 0);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return output.sort();
}

async function collectSessionLog(path) {
  const bytes = await readFile(path);
  let decoded = bytes;
  if (path.endsWith(".zstd")) {
    decoded = Buffer.concat(splitZstdFrames(bytes).map((frame) => zstdDecompressSync(frame)));
  }
  const text = decoded.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > 8 * 1024 * 1024) throw probeFailure();
  const events = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line);
    if (record && typeof record === "object" && typeof record.type === "string") events.push(record);
  }
  return events;
}

function runChild(executable, args, options, onSpawned = null) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(executable, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (typeof onSpawned === "function") onSpawned(child);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const consume = (kind) => (chunk) => {
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > 256 * 1024) child.kill();
    };
    child.stdout.on("data", consume("stdout"));
    child.stderr.on("data", consume("stderr"));
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveChild({
      code,
      signal,
    }));
  });
}

export async function runNativeDshProbe({ runtimeRoot, stateRoot, observeEvents = null }) {
  const startedAt = performance.now();
  const root = resolve(runtimeRoot);
  const node = join(root, "node", "node.exe");
  const entry = join(root, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const home = resolve(stateRoot);
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || home !== stateRoot) throw probeFailure();
  const workspace = join(home, "workspace");
  const probePatch = join(home, "luckyray-native-probe.patch.yml");
  const { server, evidence } = createDeterministicProvider();
  let timeout;
  let probeChild = null;
  try {
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    try {
      await writeFile(probePatch, DSH_NATIVE_PROBE_PATCH, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw probeFailure();
      if (await readFile(probePatch, "utf8") !== DSH_NATIVE_PROBE_PATCH) {
        // This is an app-owned deterministic probe input, not user/session
        // state. A previous LuckyRay version may have left older exact bytes.
        await rm(probePatch, { force: true });
        await writeFile(probePatch, DSH_NATIVE_PROBE_PATCH, { encoding: "utf8", flag: "wx" });
      }
    }
    if (await readFile(probePatch, "utf8") !== DSH_NATIVE_PROBE_PATCH) throw probeFailure();
    const roaming = join(home, "AppData", "Roaming");
    const local = join(home, "AppData", "Local");
    await mkdir(roaming, { recursive: true });
    await mkdir(local, { recursive: true });
    const port = await listen(server);
    const priorSessionLogs = new Set(await listSessionLogs(join(home, "sessions")));
    const environment = {
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
      TEMP: process.env.TEMP ?? tmpdir(),
      TMP: process.env.TMP ?? tmpdir(),
      HOME: home,
      USERPROFILE: home,
      APPDATA: roaming,
      LOCALAPPDATA: local,
      XDG_CONFIG_HOME: join(home, ".config"),
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: "1",
      DSH_TOOLS_MODE: "native",
      DSH_PERMISSION_MODE: "read-only",
      DEEPSEEK_API_KEY: "luckyray-local-probe",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
    };

    const childResult = await Promise.race([
      runChild(node, [entry, "--profile", "headless", "--patch", probePatch, DSH_NATIVE_PROBE_TEXT], {
        cwd: workspace,
        env: environment,
      }, (child) => { probeChild = child; }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(probeFailure()), DSH_NATIVE_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (childResult.code !== 0 || childResult.signal !== null) throw probeFailure();
    const newSessionLogs = (await listSessionLogs(join(home, "sessions")))
      .filter((path) => !priorSessionLogs.has(path));
    if (newSessionLogs.length !== 1) throw probeFailure();
    const events = await collectSessionLog(newSessionLogs[0]);
    if (typeof observeEvents === "function") observeEvents(events, { ...evidence });
    validateNativeTurnEvidence(events, evidence);
    return {
      sessionReady: true,
      turnAccepted: true,
      probeCompleted: true,
      nativeEventEvidence: true,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (probeChild && probeChild.exitCode === null) {
      await killOwnedChildTree(probeChild).catch(() => {});
    }
    await closeServer(server).catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runDshHostMain({
    runtimeRoot: process.env.LUCKYRAY_DSH_RUNTIME_ROOT,
    stateRoot: process.env.LUCKYRAY_DSH_STATE_ROOT,
  }).then(
    () => process.exit(0),
    () => process.exit(70),
  );
}
