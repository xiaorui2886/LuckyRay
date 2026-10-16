// Fake LuckyRay LocalTransport for the S1 runtime fixture (Issue #13 §5B).
//
// Loopback-only HTTP servers that are minimally wire-compatible with
// browser-extension-prototype/local-transport-auth.js:
//   GET  /api/v1/health               -> service/protocol/extensionBootstrap
//   POST /api/v1/extension/bootstrap  -> actualPort/baseUrl/credential(64-hex)
//   POST /api/v1/proof                -> HMAC proof over origin+port+nonces
// plus protected fixture routes that require `Authorization: Bearer <credential>`.
//
// Security reporting contract (§5B / §6): the call log records only
// hasAuthorization (boolean), method, path, origin and a redacted body
// summary. The credential itself is never written to the log or to disk.
//
// Decoys cover the negative cases:
//   "bad-proof"    : compatible health + bootstrap, but the proof HMAC is wrong
//                    -> the extension must refuse to send protected traffic
//   "incompatible" : health advertises protocolVersion 99 -> skipped entirely

import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";

export const DISCOVERY_FIRST_PORT = 37418;
export const DISCOVERY_LAST_PORT = 37467;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;

export const WRITE_ROUTES = [
  "/collect",
  "/api/assets/import-image",
  "/api/assets/import-media",
  "/api/folders",
  "/api/notes",
  "/api/notes/capture",
  "/api/notes/attach-material",
  "/api/notes/current",
  "/api/video/record/save",
  "/api/collection/failures",
  "/api/media/transfers",
];

export function randomCredential() {
  return randomBytes(32).toString("hex");
}

export function randomNonce() {
  return randomBytes(32).toString("hex");
}

function hmacHex(credential, message) {
  return createHmac("sha256", Buffer.from(credential, "hex"))
    .update(message, "utf8")
    .digest("hex");
}

export function proofMessage(origin, port, clientNonce, serverNonce) {
  return `luckyray-local-transport-proof-v1\nprotocol:1\norigin:${origin}\nport:${port}\nclientNonce:${clientNonce}\nserverNonce:${serverNonce}`;
}

// Never let a 64-hex credential, a "Bearer ..." token, a long hex blob or a
// Windows absolute user path escape into a report. Handles both raw and
// JSON-escaped (double backslash) path spellings.
export function redactSensitiveText(value) {
  return String(value || "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]")
    .replace(/[a-f0-9]{64}/gi, "[REDACTED:64HEX]")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[REDACTED:LONG]")
    .replace(/[a-zA-Z]:\\{1,2}(?:[^\\\s"'<>|?*]+\\{1,2})*[^\\\s"'<>|?*]*/g, "[REDACTED:PATH]");
}

function bodySummary(rawBody) {
  const text = String(rawBody || "").slice(0, 240);
  return redactSensitiveText(text);
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function listenOn(server, port, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

export async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

function isProtectedRoute(path) {
  return WRITE_ROUTES.includes(path) || path === "/api/media/probes";
}

// Port helpers ---------------------------------------------------------------

export async function portIsFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

// Ascending scan so the returned ports keep the extension's discovery order
// (the extension walks 37418 -> 37467 and stops at the first verified server).
export async function findFreePortsInRange(count, options = {}) {
  const first = options.first ?? DISCOVERY_FIRST_PORT;
  const last = options.last ?? DISCOVERY_LAST_PORT;
  const found = [];
  for (let port = first; port <= last && found.length < count; port += 1) {
    if (await portIsFree(port)) found.push(port);
  }
  if (found.length < count) {
    throw new Error(
      `Only ${found.length} free candidate port(s) in ${first}..${last}; need ${count}. `
      + "Close other services on that range and re-run.",
    );
  }
  return found;
}

// Pre-flight guard: refuse to run next to a real LuckyRay desktop transport.
//
// Passive detection ONLY (unauthenticated GET /api/v1/health) — per
// [BROWSER-EXT-REVIEW][BLOCK] P1-1 the fixture must never bootstrap/proof
// against, or read a credential from, a non-fixture-owned LuckyRay service.
// Any external service in the discovery range makes the fixture hard-fail.
//
// NOTE: the real desktop service drops connections under parallel load (it
// resets surplus sockets), so probing is done sequentially with retries —
// a parallel scan can silently miss a live service.
export async function scanRangeForLuckyRayService(options = {}) {
  const first = options.first ?? DISCOVERY_FIRST_PORT;
  const last = options.last ?? DISCOVERY_LAST_PORT;
  const found = [];
  for (let port = first; port <= last; port += 1) {
    let detected = false;
    for (let attempt = 0; attempt < 3 && !detected; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 600);
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
          signal: controller.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          const data = payload?.ok && payload.data;
          detected = data && data.service === "luckyray-local-transport";
        }
      } catch (_) {
        // Connection refused/reset — try once more, then move on.
      }
    }
    if (detected) found.push(port);
  }
  return found;
}

// Fake transport server ------------------------------------------------------

export async function startFakeTransport(options = {}) {
  const port = options.port;
  const credential = options.credential || randomCredential();
  const calls = [];
  let learnedOrigin = null;
  // M1-S4 QA fixture: scripted media-transfer lifecycle. Each created
  // transfer walks queued -> running -> importing -> completed on GET;
  // creating a transfer for an already-posted URL returns a completed
  // skippedDuplicate transfer (duplicate-save semantics).
  const mediaTransfers = new Map();
  const mediaTransferUrls = new Map();
  const mediaTotalBytes = 10 * 1024 * 1024;
  const transferSnapshot = (transferId) => {
    const record = mediaTransfers.get(transferId);
    const bytesReceived = record.state === "queued" ? 0
      : record.state === "running" ? Math.floor(mediaTotalBytes * 0.4)
        : mediaTotalBytes;
    return {
      transferId,
      state: record.state,
      bytesReceived,
      totalBytes: mediaTotalBytes,
      fileName: "fixture-video.mp4",
      mimeType: "video/mp4",
      ...(record.state === "completed"
        ? { assetId: "asset-video-1", assetName: "fixture-video.mp4", assetKind: "video" }
        : {}),
    };
  };

  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "authorization,content-type",
      });
      response.end();
      return;
    }
    const body = await readBody(request);
    const path = (request.url || "/").split("?")[0];
    const origin = String(request.headers.origin || "");
    if (origin) learnedOrigin = origin;
    const authorization = String(request.headers.authorization || "");
    const hasAuthorization = authorization.length > 0;
    const authValid = hasAuthorization && authorization === `Bearer ${credential}`;
    calls.push({
      at: Date.now(),
      port,
      method: request.method,
      path,
      origin,
      hasAuthorization,
      authValid,
      bodySummary: bodySummary(body),
      // Full request body for in-memory assertions only; redactedCallSequence
      // never emits it (credentials/siteAuth must stay out of logs).
      body: String(body || ""),
    });

    const respondProtected = (payload) => {
      if (!authValid) {
        sendJson(response, 401, {
          ok: false,
          code: "authentication-required",
          error: { code: "authentication-required", message: "Authentication is required" },
        });
        return;
      }
      sendJson(response, 200, payload);
    };

    if (path === "/api/v1/health") {
      sendJson(response, 200, { ok: true, data: {
        service: "luckyray-local-transport",
        protocolVersion: 1,
        extensionBootstrap: true,
      } });
      return;
    }
    if (path === "/api/v1/extension/bootstrap") {
      sendJson(response, 200, { ok: true, data: {
        protocolVersion: 1,
        actualPort: port,
        baseUrl: `http://127.0.0.1:${port}`,
        credential,
      } });
      return;
    }
    if (path === "/api/v1/proof") {
      const clientNonce = (() => {
        try {
          return String(JSON.parse(body).clientNonce || "");
        } catch (_) {
          return "";
        }
      })();
      const serverNonce = randomNonce();
      const proofOrigin = origin || learnedOrigin;
      const proof = proofOrigin
        ? hmacHex(credential, proofMessage(proofOrigin, port, clientNonce, serverNonce))
        : "00".repeat(32); // fail closed when no origin is knowable
      sendJson(response, 200, { ok: true, data: {
        protocolVersion: 1,
        port,
        clientNonce,
        serverNonce,
        proof,
      } });
      return;
    }
    // Domain-specific fixtures extend the already verified loopback transport,
    // without replacing production bootstrap/proof or exposing credentials.
    if (options.protectedRoute) {
      if (!authValid) { respondProtected(null); return; }
      const result = await options.protectedRoute({ path, method: request.method, body });
      if (result) {
        if (!authValid) { respondProtected(null); return; }
        sendJson(response, result.status || 200, result.payload);
        return;
      }
    }
    if (path === "/api/notes/current") {
      respondProtected({ ok: true, data: { note: { id: "fixture-note", text: "fixture" } } });
      return;
    }
    if (path === "/api/notes/recent") {
      respondProtected({ ok: true, data: { notes: [
        { id: "note-recent-1", title: "最近笔记一", updatedAt: "2026-08-12T10:00:00Z" },
        { id: "note-recent-2", title: "最近笔记二", updatedAt: "2026-08-12T09:00:00Z" },
      ] } });
      return;
    }
    if (path === "/api/notes/search") {
      // Deterministic fixture results so the popup QA can drive the search
      // flow: query containing "A" returns A, "X" returns X.
      const q = String(new URL(request.url, "http://127.0.0.1").searchParams.get("q") || "").toUpperCase();
      const notes = [];
      if (q.includes("A")) notes.push({ id: "note-search-a", title: "A 搜索命中", updatedAt: "2026-08-12T08:00:00Z" });
      if (q.includes("X")) notes.push({ id: "note-search-x", title: "X 搜索命中", updatedAt: "2026-08-12T07:00:00Z" });
      respondProtected({ ok: true, data: { notes } });
      return;
    }
    if (path === "/api/notes" && request.method === "POST") {
      respondProtected({ ok: true, data: { note: { id: "note-new-fixture", title: "fixture" } } });
      return;
    }
    if (path === "/api/notes/capture-target" && request.method === "POST") {
      respondProtected({ ok: true, data: { activation: { vaultId: "fixture-vault", sourceEpoch: 1 }, revision: "fixture-revision" } });
      return;
    }
    if (["/api/notes/capture", "/api/notes/attach-material"].includes(path) && request.method === "POST") {
      const input = JSON.parse(body);
      respondProtected({ ok: true, data: { noteId: input.noteId || "note-new-fixture", revision: "fixture-next-revision", indexStale: false } });
      return;
    }
    const appendMatch = path.match(/^\/api\/notes\/([a-z0-9-]+)\/append$/);
    if (appendMatch && request.method === "POST") {
      respondProtected({ ok: true, data: { note: { id: appendMatch[1] }, appended: true } });
      return;
    }
    if (path === "/api/media/transfers" && request.method === "POST") {
      let url = "";
      try { url = String(JSON.parse(body).url || ""); } catch (_) {}
      if (url && mediaTransferUrls.has(url)) {
        const duplicateId = mediaTransferUrls.get(url);
        respondProtected({ ok: true, data: {
          ...transferSnapshot(duplicateId),
          state: "completed",
          skippedDuplicate: true,
          assetId: "asset-video-1",
          assetName: "fixture-video.mp4",
          assetKind: "video",
        } });
        return;
      }
      const transferId = `media-${randomBytes(4).toString("hex")}-${randomBytes(8).toString("hex")}`;
      mediaTransfers.set(transferId, { state: "queued" });
      if (url) mediaTransferUrls.set(url, transferId);
      respondProtected({ ok: true, data: transferSnapshot(transferId) });
      return;
    }
    const transferRoute = path.match(/^\/api\/media\/transfers\/(media-[a-f0-9]+-[a-f0-9]{16})(?:\/(cancel))?$/);
    if (transferRoute) {
      const transferId = transferRoute[1];
      const record = mediaTransfers.get(transferId);
      if (!record) {
        sendJson(response, 404, { ok: false, code: "media-transfer-not-found" });
        return;
      }
      if (transferRoute[2] === "cancel") {
        record.state = "cancelled";
        respondProtected({ ok: true, data: transferSnapshot(transferId) });
        return;
      }
      if (request.method === "GET") {
        const order = ["queued", "running", "importing", "completed"];
        const index = order.indexOf(record.state);
        record.state = order[Math.min(index + 1, order.length - 1)];
      }
      respondProtected({ ok: true, data: transferSnapshot(transferId) });
      return;
    }
    if (path === "/api/assets/import-media") {
      // Canonical material-import response shape so popup flows reach the
      // success path (parseMaterialImportResponse expects disposition+asset).
      respondProtected({ ok: true, data: {
        disposition: "imported",
        asset: { id: "fixture-asset-1", name: "fixture-image.png", type: "image", status: "ready" },
      } });
      return;
    }
    if (path === "/api/collection/failures") {
      respondProtected({ ok: true, id: "fixture-failures" });
      return;
    }
    if (path === "/api/video/record/save") {
      respondProtected({ ok: true, id: "fixture-record" });
      return;
    }
    if (path === "/collect") {
      respondProtected({ ok: true, id: "fixture-collect" });
      return;
    }
    sendJson(response, 404, { ok: false, code: "not-found" });
  });

  await listenOn(server, port);
  return {
    port,
    credential,
    calls,
    close: () => closeServer(server),
  };
}

// Decoy servers ---------------------------------------------------------------
//
// Modes:
//   "bad-proof"    : compatible health + bootstrap, but the proof HMAC is wrong
//                    -> the extension must refuse to send protected traffic
//   "incompatible" : health advertises protocolVersion 99 -> skipped entirely
//   "health-only"  : compatible-looking health, everything else 404 — simulates
//                    an external/non-owned LuckyRay service (like a real
//                    desktop whose bootstrap endpoint is not reachable); the
//                    fixture must refuse to run next to it and never send it
//                    anything beyond an unauthenticated health probe
export async function startDecoy(options = {}) {
  const port = options.port;
  const mode = options.mode; // "bad-proof" | "incompatible" | "health-only"
  const credential = randomCredential();
  const calls = [];
  let learnedOrigin = null;

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = (request.url || "/").split("?")[0];
    const origin = String(request.headers.origin || "");
    if (origin) learnedOrigin = origin;
    const authorization = String(request.headers.authorization || "");
    calls.push({
      at: Date.now(),
      port,
      method: request.method,
      path,
      origin,
      hasAuthorization: authorization.length > 0,
      authValid: false,
      bodySummary: bodySummary(body),
    });

    if (path === "/api/v1/health") {
      sendJson(response, 200, { ok: true, data: {
        service: "luckyray-local-transport",
        protocolVersion: mode === "incompatible" ? 99 : 1,
        extensionBootstrap: mode === "incompatible" ? false : true,
      } });
      return;
    }
    if (mode === "bad-proof" && path === "/api/v1/extension/bootstrap") {
      sendJson(response, 200, { ok: true, data: {
        protocolVersion: 1,
        actualPort: port,
        baseUrl: `http://127.0.0.1:${port}`,
        credential,
      } });
      return;
    }
    if (mode === "bad-proof" && path === "/api/v1/proof") {
      const clientNonce = (() => {
        try {
          return String(JSON.parse(body).clientNonce || "");
        } catch (_) {
          return "";
        }
      })();
      sendJson(response, 200, { ok: true, data: {
        protocolVersion: 1,
        port,
        clientNonce,
        serverNonce: randomNonce(),
        proof: "00".repeat(32), // deliberately wrong HMAC
      } });
      return;
    }
    sendJson(response, 404, { ok: false, code: "not-found" });
  });

  await listenOn(server, port);
  return {
    port,
    mode,
    calls,
    close: () => closeServer(server),
  };
}

// Report helpers --------------------------------------------------------------

// Redacted call sequence for the test report: no Authorization values, no
// credential, only presence booleans and sanitized summaries.
export function redactedCallSequence(calls) {
  return calls.map((call) => ({
    port: call.port,
    method: call.method,
    path: call.path,
    hasAuthorization: call.hasAuthorization,
    origin: call.origin,
    bodySummary: call.bodySummary,
  }));
}

export function protectedCallsOn(calls, port) {
  return calls.filter((call) => call.port === port && isProtectedRoute(call.path));
}

export function writeCallsOn(calls, port) {
  return calls.filter((call) => call.port === port && WRITE_ROUTES.includes(call.path));
}

export function hasCredentialShape(value) {
  return typeof value === "string" && SECRET_PATTERN.test(value);
}
