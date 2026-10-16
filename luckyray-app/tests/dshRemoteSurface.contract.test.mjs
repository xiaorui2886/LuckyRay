// LSH Remote Surface (M1) — real-runtime contract tests.
// Boots the UNMODIFIED official @deepseek-ai/dsh 0.1.5-rc.2 web composition
// through the app-owned authenticated carrier (same as
// dshNativeSurfaceOfficial.contract.test.mjs) and drives the REMOTE surface:
// the companion gateway would tunnel raw bytes for a granted device to the
// carrier's loopback port, so these tests speak plain HTTP/WS to the carrier
// with the ADVERTISED remote Host exactly as the tunneled WebView would.
// Requires the verified production runtime fixtures:
//   DSH_M1_RUNTIME_ROOT (sealed 0.1.5-rc.2 runtime), DSH_M1_STATE_ROOT (scratch).
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import crypto from "node:crypto";
import { createNativeSurfaceOwner } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REMOTE_HOST = "luckyray-companion.local";
const REMOTE_GATEWAY_PORT = 41946; // fixture value; the carrier accepts any advertised hostname:port
const REMOTE_ORIGIN = `https://${REMOTE_HOST}:${REMOTE_GATEWAY_PORT}`;

// (real implementation — the placeholder above is replaced below)
import * as reqHttp from "node:http";
function rawFetchReal(url, { headers = {}, method = "GET" } = {}) {
  const { request: httpRequest } = reqHttp;
  return new Promise((resolveRequest, rejectRequest) => {
    const target = new URL(url);
    const req = httpRequest(
      target,
      { method, headers: { host: target.host, connection: "close", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolveRequest({
            status: res.statusCode,
            headers: res.headers,
            text: () => body.toString("utf8"),
            body,
          });
        });
      },
    );
    req.on("error", rejectRequest);
    req.setTimeout(30_000, () => req.destroy(new Error("carrier request timeout")));
    req.end();
  });
}

/** Speaks one raw-socket HTTP request with an OVERRIDDEN Host header —
 * exactly what the companion tunnel delivers to the carrier. */
function tunnelRequest(port, requestTarget, { host = `${REMOTE_HOST}:${REMOTE_GATEWAY_PORT}`, headers = {}, method = "GET" } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect(port, REMOTE_HOST === "__never__" ? "127.0.0.1" : "127.0.0.1");
    const head = [
      `${method} ${requestTarget} HTTP/1.1`,
      `Host: ${host}`,
      `Connection: close`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n");
    const chunks = [];
    let raw = "";
    socket.on("connect", () => socket.write(head));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      raw += chunk.toString("latin1");
      if (raw.includes("\r\n\r\n")) {
        const [headText, ...rest] = raw.split("\r\n\r\n");
        const statusLine = headText.split("\r\n")[0];
        const status = Number(statusLine.split(" ")[1]);
        const responseHeaders = {};
        for (const line of headText.split("\r\n").slice(1)) {
          const at = line.indexOf(":");
          if (at > 0) {
            const name = line.slice(0, at).trim().toLowerCase();
            const value = line.slice(at + 1).trim();
            responseHeaders[name] = responseHeaders[name] === undefined ? value : `${responseHeaders[name]}, ${value}`;
          }
        }
        const body = Buffer.concat(rest.map((piece) => Buffer.from(piece, "latin1")));
        const contentLength = Number(responseHeaders["content-length"] ?? 0);
        if (body.length >= contentLength || contentLength === 0 && !headText.includes("content-length")) {
          socket.end();
          resolveRequest({ status, headers: responseHeaders, text: () => body.toString("utf8"), raw: Buffer.concat(chunks) });
        }
      }
    });
    socket.on("error", rejectRequest);
    socket.setTimeout(30_000, () => { socket.destroy(new Error("tunnel timeout")); });
  });
}

function firstCookie(headers) {
  const raw = headers["set-cookie"];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(";", 1)[0];
}

async function installTrackedSurfaceModules(stateRoot) {
  const { cpSync } = await import("node:fs");
  for (const packageName of ["dsh-authenticated-webserver", "dsh-resource-tools", "dsh-native-surface-state", "dsh-lightseek-ui"]) {
    const source = join(appRoot, "src-tauri", "dsh-host", `luckyray-${packageName}`);
    const target = join(stateRoot, "profiles", "node_modules", "@luckyray", packageName);
    cpSync(source, target, { recursive: true });
  }
}

async function bootOwner(stateSuffix) {
  const runtimeRoot = process.env.DSH_M1_RUNTIME_ROOT;
  const stateRoot = `${process.env.DSH_M1_STATE_ROOT}${stateSuffix}`;
  assert.ok(runtimeRoot && process.env.DSH_M1_STATE_ROOT, "production fixtures required");
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });
  await installTrackedSurfaceModules(stateRoot);
  const patch = join(stateRoot, "luckyray-dsh-native-surface.generated.patch.yml");
  await writeFile(
    patch,
    await readFile(join(appRoot, "src-tauri", "dsh-host", "luckyray-dsh-native-surface.patch.yml"), "utf8"),
    { encoding: "utf8", flag: "wx" },
  );
  const owner = createNativeSurfaceOwner({
    runtimeRoot,
    stateRoot,
    surfaceHome: stateRoot,
    surfacePatch: patch,
  });
  const ready = await owner.open();
  assert.equal(ready.stage, "surface-ready");
  return { owner, ready };
}

test("remote surface: bootstrap settles the official token server-side and never leaks it", { timeout: 90_000 }, async () => {
  const { owner, ready } = await bootOwner("-remote");
  try {
    const base = `http://127.0.0.1:${ready.port}`;
    // The companion gateway advertises exactly one remote origin.
    const applied = await owner.setRemoteAuthority({ host: `${REMOTE_HOST}:${REMOTE_GATEWAY_PORT}`, origin: REMOTE_ORIGIN, gatewayGeneration: 7 });
    assert.equal(applied.applied, true);

    const deviceId = `device-${crypto.randomBytes(16).toString("hex")}`;
    const mint = await owner.mintRemoteSession({ deviceId, gatewayGeneration: 7 });
    assert.equal(mint.outcome, "accepted");
    assert.match(mint.ref, /^[0-9a-f]{64}$/u);
    assert.equal(mint.bootstrapPath, "/_luckyray/remote/bootstrap");
    assert.ok(mint.expiresAtMs > Date.now());

    // Bootstrap through the "tunnel": remote Host, one-time ref. The official
    // loader settles asynchronously; a 503 leaves the ref retryable.
    let bootstrap = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mint.ref}`);
    for (let attempt = 0; bootstrap.status === 503 && attempt < 20; attempt += 1) {
      await new Promise((done) => setTimeout(done, 500));
      bootstrap = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mint.ref}`);
    }
    assert.equal(bootstrap.status, 302);
    assert.equal(bootstrap.headers.location, "/");
    const remoteSetCookie = bootstrap.headers["set-cookie"] ?? "";
    assert.match(remoteSetCookie, /^luckyray_dsh_remote_g\d+=[0-9a-f]{64}/u);
    assert.match(remoteSetCookie, /HttpOnly/iu);
    assert.match(remoteSetCookie, /Secure/iu);
    assert.match(remoteSetCookie, /SameSite=Strict/iu);
    // The official launch token NEVER appears in the remote response.
    assert.doesNotMatch(bootstrap.headers.location ?? "", /token=/iu);
    assert.doesNotMatch(remoteSetCookie, /dsh-auth-/u);

    const remoteCookie = firstCookie(bootstrap.headers);
    assert.ok(remoteCookie);

    // Replay the same ref: single use.
    const replay = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mint.ref}`);
    assert.equal(replay.status, 403);

    // No cookie: denied.
    const anonymous = await tunnelRequest(ready.port, "/");
    assert.equal(anonymous.status, 403);

    // Index through the remote session: the OFFICIAL fence (dsh-auth cookie)
    // was settled SERVER-SIDE, so the remote client only presents its own
    // remote cookie and still receives the real official index.
    const index = await tunnelRequest(ready.port, "/", { headers: { cookie: remoteCookie } });
    assert.equal(index.status, 200);
    assert.match(index.text(), /__DSH_BOOT__|<html/iu);
    // Token discipline on the served page and headers:
    assert.doesNotMatch(index.text(), /\?token=[A-Za-z0-9_-]{16,240}/u);
    assert.ok(!(index.headers["set-cookie"] ?? "").includes("dsh-auth-"));

    // The remote cookie must NOT work on the Desktop authority host: the two
    // cookie namespaces are disjoint (the carrier fence denies it before the
    // official fence is ever reached).
    const desktopConfusion = await rawFetchReal(`${base}/`, {
      headers: { cookie: `${remoteCookie}` },
    });
    assert.equal(desktopConfusion.status, 403);

    // Cookie namespace isolation the other way: a DESKTOP carrier cookie must
    // not authenticate the remote branch. (Use a syntactically valid but
    // non-issued value — the carrier must deny it.)
    const forged = await tunnelRequest(ready.port, "/", {
      headers: { cookie: `${remoteCookie.split("=")[0]}=${"0".repeat(64)}` },
    });
    assert.equal(forged.status, 403);

    // /api is reachable through the remote session (proxy injected the
    // upstream official cookie; the official API fence answered itself).
    const apiMiss = await tunnelRequest(ready.port, "/api/not-real", { headers: { cookie: remoteCookie } });
    assert.equal([403, 404].includes(apiMiss.status), true, `remote api miss status: ${apiMiss.status}`);

    // Device A drop: sessions and sockets die immediately.
    await owner.dropRemoteSessions({ deviceId });
    const afterDrop = await tunnelRequest(ready.port, "/", { headers: { cookie: remoteCookie } });
    assert.equal(afterDrop.status, 403);

    // Device B can still mint and load after A's revocation.
    const deviceB = `device-${crypto.randomBytes(16).toString("hex")}`;
    const mintB = await owner.mintRemoteSession({ deviceId: deviceB, gatewayGeneration: 7 });
    assert.equal(mintB.outcome, "accepted");
    let bootstrapB = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mintB.ref}`);
    for (let attempt = 0; bootstrapB.status === 503 && attempt < 20; attempt += 1) {
      await new Promise((done) => setTimeout(done, 500));
      bootstrapB = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mintB.ref}`);
    }
    assert.equal(bootstrapB.status, 302);
    const cookieB = firstCookie(bootstrapB.headers);
    const indexB = await tunnelRequest(ready.port, "/", { headers: { cookie: cookieB } });
    assert.equal(indexB.status, 200);
  } finally {
    await owner.shutdown();
  }
});

test("remote surface WS upgrade: real /api/remote.mux handshake under the remote origin, killed on revoke", { timeout: 90_000 }, async () => {
  const { owner, ready } = await bootOwner("-remote-ws");
  try {
    await owner.setRemoteAuthority({ host: `${REMOTE_HOST}:${REMOTE_GATEWAY_PORT}`, origin: REMOTE_ORIGIN, gatewayGeneration: 7 });
    const deviceId = `device-${crypto.randomBytes(16).toString("hex")}`;
    const mint = await owner.mintRemoteSession({ deviceId, gatewayGeneration: 7 });
    assert.equal(mint.outcome, "accepted");
    let bootstrap = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mint.ref}`);
    for (let attempt = 0; bootstrap.status === 503 && attempt < 20; attempt += 1) {
      await new Promise((done) => setTimeout(done, 500));
      bootstrap = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mint.ref}`);
    }
    assert.equal(bootstrap.status, 302);
    const remoteCookie = firstCookie(bootstrap.headers);

    // Real WS upgrade through the "tunnel": Origin must equal the remote
    // origin (the carrier's upgrade fence) and the official mux must accept
    // the server-side settled upstream session.
    const wsResult = await new Promise((resolveWs) => {
      const socket = connect(ready.port, "127.0.0.1");
      const key = crypto.randomBytes(16).toString("base64");
      const head = [
        "GET /api/remote.mux HTTP/1.1",
        `Host: ${REMOTE_HOST}:${REMOTE_GATEWAY_PORT}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Origin: ${REMOTE_ORIGIN}`,
        `Cookie: ${remoteCookie}`,
        "",
        "",
      ].join("\r\n");
      let raw = "";
      const fail = (error) => resolveWs({ error });
      socket.on("connect", () => socket.write(head));
      socket.on("data", (chunk) => {
        raw += chunk.toString("latin1");
        if (raw.startsWith("HTTP/1.1 101")) {
          resolveWs({ status: 101, socket, raw });
        } else if (raw.includes("\r\n\r\n")) {
          resolveWs({ status: Number(raw.split(" ")[1]), raw });
        }
      });
      socket.on("error", fail);
      socket.setTimeout(20_000, () => { socket.destroy(); fail({ error: new Error("ws timeout") }); });
    });
    assert.equal(wsResult.status, 101, `upgrade status: ${JSON.stringify(wsResult.raw ?? wsResult.error)}`);

    // Revoking the device must tear down the OPEN WebSocket, not just cookies.
    const closed = new Promise((done) => wsResult.socket.once("close", done));
    await owner.dropRemoteSessions({ deviceId });
    await Promise.race([closed, new Promise((done) => setTimeout(done, 5000))]);
    assert.equal(wsResult.socket.destroyed || wsResult.socket.readyState === "closed", true, "upgraded socket must be destroyed on device drop");
    if (!wsResult.socket.destroyed) wsResult.socket.destroy();
  } finally {
    await owner.shutdown();
  }
});

test("remote authority change invalidates every previous remote session; desktop channel unaffected", { timeout: 90_000 }, async () => {
  const { owner, ready } = await bootOwner("-remote-rotate");
  try {
    const base = `http://127.0.0.1:${ready.port}`;
    await owner.setRemoteAuthority({ host: `${REMOTE_HOST}:${REMOTE_GATEWAY_PORT}`, origin: REMOTE_ORIGIN, gatewayGeneration: 7 });
    const deviceId = `device-${crypto.randomBytes(16).toString("hex")}`;
    const mint = await owner.mintRemoteSession({ deviceId, gatewayGeneration: 7 });
    let bootstrap = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mint.ref}`);
    for (let attempt = 0; bootstrap.status === 503 && attempt < 20; attempt += 1) {
      await new Promise((done) => setTimeout(done, 500));
      bootstrap = await tunnelRequest(ready.port, `/_luckyray/remote/bootstrap?ref=${mint.ref}`);
    }
    assert.equal(bootstrap.status, 302);
    const remoteCookie = firstCookie(bootstrap.headers);
    const before = await tunnelRequest(ready.port, "/", { headers: { cookie: remoteCookie } });
    assert.equal(before.status, 200);

    // Rotate the advertised origin: all prior remote sessions must die.
    const rotated = await owner.setRemoteAuthority({
      host: `${REMOTE_HOST}:${REMOTE_GATEWAY_PORT + 1}`,
      origin: `https://${REMOTE_HOST}:${REMOTE_GATEWAY_PORT + 1}`,
      gatewayGeneration: 8,
    });
    assert.equal(rotated.applied, true);
    const afterRotate = await tunnelRequest(ready.port, "/", {
      headers: { cookie: remoteCookie },
      host: `${REMOTE_HOST}:${REMOTE_GATEWAY_PORT + 1}`,
    });
    assert.equal(afterRotate.status, 403, "old sessions must not survive an authority rotation");

    // The DESKTOP webview channel is untouched by any of it.
    const desktopReady = await owner.open();
    const desktopBootstrap = await rawFetchReal(
      `http://127.0.0.1:${desktopReady.port}${desktopReady.bootstrapPath}?ref=${desktopReady.bootstrapRef}`,
    );
    assert.equal(desktopBootstrap.status, 302);
    const desktopCookie = firstCookie(desktopBootstrap.headers);
    const launchLocation = desktopBootstrap.headers.location;
    const exchange = await rawFetchReal(new URL(launchLocation, `http://127.0.0.1:${desktopReady.port}`).href, {
      headers: { cookie: desktopCookie },
    });
    assert.equal(exchange.status, 303);
    const officialCookie = firstCookie(exchange.headers);
    const desktopIndex = await rawFetchReal(`http://127.0.0.1:${desktopReady.port}/`, {
      headers: { cookie: `${desktopCookie}; ${officialCookie}` },
    });
    assert.equal(desktopIndex.status, 200);
  } finally {
    await owner.shutdown();
  }
});
