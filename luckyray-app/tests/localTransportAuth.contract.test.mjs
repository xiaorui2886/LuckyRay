import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const ORIGIN = "chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid";
const CREDENTIAL = "ab".repeat(32);
const nativeFetch = globalThis.fetch;

function bytesToHex(value) {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

async function hmac(credential, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(credential),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function startServer(calls, options = {}) {
  const credential = options.credential || CREDENTIAL;
  let protectedRejections = 0;
  let bootstrapAttempts = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
      body,
    });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Access-Control-Allow-Origin", ORIGIN);
    if (options.rejectProtectedOnce && request.url === "/collect" && protectedRejections++ === 0) {
      response.statusCode = 401;
      response.end(JSON.stringify({ code: "authentication-required", error: "Authentication is required" }));
      return;
    }
    if (request.url === "/api/v1/health") {
      response.end(JSON.stringify({ ok: true, data: {
        service: "luckyray-local-transport",
        protocolVersion: options.protocolVersion || 1,
        extensionBootstrap: options.extensionBootstrap !== false,
      } }));
      return;
    }
    if (request.url === "/api/v1/extension/bootstrap") {
      if (options.dropBootstrapAlways || (options.dropBootstrapOnce && bootstrapAttempts++ === 0)) {
        request.socket.destroy();
        return;
      }
      const port = server.address().port;
      response.end(JSON.stringify({ ok: true, data: {
        protocolVersion: 1,
        actualPort: port,
        baseUrl: `http://127.0.0.1:${port}`,
        credential,
      } }));
      return;
    }
    if (request.url === "/api/v1/proof") {
      const { clientNonce } = JSON.parse(body);
      const serverNonce = "cd".repeat(32);
      const port = server.address().port;
      const message = `luckyray-local-transport-proof-v1\nprotocol:1\norigin:${ORIGIN}\nport:${port}\nclientNonce:${clientNonce}\nserverNonce:${serverNonce}`;
      response.end(JSON.stringify({ ok: true, data: {
        protocolVersion: 1,
        port,
        clientNonce,
        serverNonce,
        proof: options.invalidProof ? "ef".repeat(32) : await hmac(credential, message),
      } }));
      return;
    }
    if ([
      "/collect",
      "/api/assets/import-image",
      "/api/assets/import-media",
      "/api/notes",
      "/api/notes/current",
      "/api/video/record/save",
    ].includes(request.url)) {
      if ((options.dropCollectResponse && request.url === "/collect")
        || (options.dropCurrentResponse && request.url === "/api/notes/current")) {
        request.socket.destroy();
        return;
      }
      response.end(JSON.stringify({ ok: true, id: "fixture" }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function installChrome(nativeHandler) {
  const storageWrites = [];
  let nativeCalls = 0;
  globalThis.chrome = {
    runtime: {
      getURL: () => `${ORIGIN}/`,
      lastError: null,
      sendNativeMessage(host, message, callback) {
        nativeCalls += 1;
        Promise.resolve(nativeHandler ? nativeHandler(host, message) : undefined).then(callback);
      },
    },
    storage: {
      local: {
        async get() { return {}; },
        async set(value) { storageWrites.push(value); },
        async remove(value) { storageWrites.push({ remove: value }); },
      },
    },
  };
  return { storageWrites, nativeCalls: () => nativeCalls };
}

function installBrowserFetch() {
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("Origin", ORIGIN);
    return nativeFetch(input, { ...init, headers });
  };
}

function usePorts(...ports) {
  globalThis.__LUCKYRAY_TEST_PORTS__ = ports;
}

async function loadHelper(tag) {
  await import(`../browser-extension-prototype/local-transport-auth.js?native=${tag}-${Date.now()}`);
  return globalThis.LuckyRayLocalTransport;
}

test("direct exact-Origin bootstrap verifies the server before one protected collect and never calls Native Messaging", async () => {
  const calls = [];
  const server = await startServer(calls);
  const port = server.address().port;
  const chromeFixture = installChrome(() => { throw new Error("Native Messaging must not run"); });
  installBrowserFetch();
  usePorts(port);
  try {
    const transport = await loadHelper("direct-bootstrap");
    const response = await transport.fetch(null, "/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", content: "fixture" }),
    });
    assert.equal(response.ok, true);
    assert.deepEqual(calls.map((call) => call.url), [
      "/api/v1/health",
      "/api/v1/extension/bootstrap",
      "/api/v1/proof",
      "/collect",
    ]);
    for (const call of calls.slice(0, 3)) {
      assert.equal(call.authorization, undefined);
      assert.equal(call.body.includes("fixture"), false);
      assert.equal(call.url.includes(CREDENTIAL), false);
    }
    assert.equal(calls[3].authorization, `Bearer ${CREDENTIAL}`);
    assert.equal(chromeFixture.nativeCalls(), 0);
    assert.equal(chromeFixture.storageWrites.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an old 404 listener is skipped and receives no Authorization or protected payload", async () => {
  const oldCalls = [];
  const oldServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    oldCalls.push({ url: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => oldServer.listen(0, "127.0.0.1", resolve));
  const realCalls = [];
  const realServer = await startServer(realCalls);
  const chromeFixture = installChrome();
  installBrowserFetch();
  usePorts(oldServer.address().port, realServer.address().port);
  try {
    const transport = await loadHelper("old-then-real");
    const response = await transport.fetch(null, "/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protected: "payload" }),
    });
    assert.equal(response.ok, true);
    assert.deepEqual(oldCalls.map((call) => call.url), ["/api/v1/health"]);
    assert.equal(oldCalls[0].authorization, undefined);
    assert.equal(oldCalls[0].body.includes("payload"), false);
    assert.equal(chromeFixture.nativeCalls(), 0);
  } finally {
    await new Promise((resolve) => oldServer.close(resolve));
    await new Promise((resolve) => realServer.close(resolve));
  }
});

test("invalid proof candidates receive control messages only and discovery continues to a real service", async () => {
  const fakeCalls = [];
  const fakeServer = await startServer(fakeCalls, { invalidProof: true, credential: "12".repeat(32) });
  const realCalls = [];
  const realServer = await startServer(realCalls);
  const chromeFixture = installChrome();
  installBrowserFetch();
  usePorts(fakeServer.address().port, realServer.address().port);
  try {
    const transport = await loadHelper("invalid-proof-then-real");
    await transport.fetch(null, "/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protected: "payload" }),
    });
    assert.deepEqual(fakeCalls.map((call) => call.url), [
      "/api/v1/health",
      "/api/v1/extension/bootstrap",
      "/api/v1/proof",
    ]);
    assert(fakeCalls.every((call) => call.authorization === undefined));
    assert(fakeCalls.every((call) => !call.body.includes("payload")));
    assert.equal(chromeFixture.nativeCalls(), 0);
  } finally {
    await new Promise((resolve) => fakeServer.close(resolve));
    await new Promise((resolve) => realServer.close(resolve));
  }
});

test("offline discovery is app-unavailable and never sends a protected request or Native message", async () => {
  const placeholder = createServer();
  await new Promise((resolve) => placeholder.listen(0, "127.0.0.1", resolve));
  const port = placeholder.address().port;
  await new Promise((resolve) => placeholder.close(resolve));
  const chromeFixture = installChrome();
  installBrowserFetch();
  usePorts(port);
  const transport = await loadHelper("offline");
  await assert.rejects(
    () => transport.fetch(null, "/collect", { method: "POST", body: "protected" }),
    (error) => error && error.code === "app-unavailable" && error.notDispatched === true,
  );
  assert.equal(chromeFixture.nativeCalls(), 0);
  assert.equal(chromeFixture.storageWrites.length, 0);
});

test("a cached service restart on a new port is rediscovered before the next protected payload", async () => {
  const firstCalls = [];
  const firstServer = await startServer(firstCalls);
  installChrome();
  installBrowserFetch();
  usePorts(firstServer.address().port);
  const transport = await loadHelper("restart");
  await transport.fetch(null, "/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generation: 1 }),
  });
  await new Promise((resolve) => firstServer.close(resolve));

  const secondCalls = [];
  const secondServer = await startServer(secondCalls);
  usePorts(secondServer.address().port);
  try {
    await transport.fetch(null, "/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 2 }),
    });
    assert.deepEqual(secondCalls.map((call) => call.url), [
      "/api/v1/health",
      "/api/v1/extension/bootstrap",
      "/api/v1/proof",
      "/collect",
    ]);
    assert.equal(secondCalls[3].body.includes("generation\":2"), true);
  } finally {
    await new Promise((resolve) => secondServer.close(resolve));
  }
});

test("the same open helper restores a cached read across restart and then writes only once", async () => {
  const firstCalls = [];
  const firstServer = await startServer(firstCalls);
  installChrome();
  installBrowserFetch();
  usePorts(firstServer.address().port);
  const transport = await loadHelper("restart-read");
  await transport.bootstrap();
  await new Promise((resolve) => firstServer.close(resolve));

  const secondCalls = [];
  const secondServer = await startServer(secondCalls, { credential: "34".repeat(32) });
  usePorts(secondServer.address().port);
  try {
    assert.equal((await transport.fetch(null, "/api/notes/current")).ok, true);
    assert.equal((await transport.fetch(null, "/collect", { method: "POST", body: "saved after restart" })).ok, true);
    assert.equal(secondCalls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 1);
    assert.equal(secondCalls.filter((call) => call.url === "/api/notes/current").length, 1);
    assert.equal(secondCalls.filter((call) => call.url === "/collect").length, 1);
    assert.equal(secondCalls.at(-1).authorization, `Bearer ${"34".repeat(32)}`);
  } finally {
    await new Promise((resolve) => secondServer.close(resolve));
  }
});

test("an interrupted bootstrap is retried before sending a business request", async () => {
  const calls = [];
  const server = await startServer(calls, { dropBootstrapOnce: true });
  installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("bootstrap-interrupted");
    assert.equal((await transport.fetch(null, "/collect", { method: "POST", body: "protected-once" })).ok, true);
    assert.equal(calls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 2);
    assert.equal(calls.filter((call) => call.url === "/api/v1/proof").length, 1);
    assert.equal(calls.filter((call) => call.url === "/collect").length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bootstrap interruption recovery is bounded and never dispatches an unverified write", async () => {
  const calls = [];
  const server = await startServer(calls, { dropBootstrapAlways: true });
  installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("bootstrap-interrupted-always");
    await assert.rejects(
      () => transport.fetch(null, "/collect", { method: "POST", body: "protected-never" }),
      (error) => error.code === "verification-unavailable",
    );
    assert.equal(calls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 2);
    assert.equal(calls.filter((call) => call.url === "/collect").length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a read that keeps losing its response attempts recovery only once", async () => {
  const calls = [];
  const server = await startServer(calls, { dropCurrentResponse: true });
  installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("read-interrupted-always");
    await assert.rejects(
      () => transport.fetch(null, "/api/notes/current"),
      (error) => error.code === "app-unavailable",
    );
    assert.equal(calls.filter((call) => call.url === "/api/notes/current").length, 2);
    assert.equal(calls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 2);
    assert.equal(calls.filter((call) => call.url === "/collect").length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a lost write response is unknown and is never replayed by connection recovery", async () => {
  const calls = [];
  const server = await startServer(calls, { dropCollectResponse: true });
  installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("lost-write-response");
    await assert.rejects(
      () => transport.fetch(null, "/collect", { method: "POST", body: "potentially-published" }),
      (error) => error.code === "request-outcome-unknown" && error.notDispatched !== true,
    );
    assert.equal(calls.filter((call) => call.url === "/collect").length, 1);
    assert.equal(calls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 1);
    assert.equal((await transport.fetch(null, "/api/notes/current")).ok, true);
    assert.equal(calls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 2);
    assert.equal(calls.filter((call) => call.url === "/collect").length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an authenticated request rejected before dispatch reboots once and sends the protected payload exactly twice", async () => {
  const calls = [];
  const server = await startServer(calls, { rejectProtectedOnce: true });
  installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("auth-refresh");
    const response = await transport.fetch(null, "/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generation: "protected-once" }),
    });
    assert.equal(response.ok, true);
    assert.equal(calls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 2);
    assert.equal(calls.filter((call) => call.url === "/api/v1/proof").length, 2);
    assert.equal(calls.filter((call) => call.url === "/collect").length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a new service-worker helper instance obtains a fresh in-memory config without storage or Native Messaging", async () => {
  const calls = [];
  const server = await startServer(calls);
  const chromeFixture = installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const first = await loadHelper("worker-a");
    await first.bootstrap();
    const second = await loadHelper("worker-b");
    await second.bootstrap();
    assert.equal(calls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 2);
    assert.equal(chromeFixture.nativeCalls(), 0);
    assert.equal(chromeFixture.storageWrites.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("concurrent callers share one direct bootstrap discovery", async () => {
  const calls = [];
  const server = await startServer(calls);
  const chromeFixture = installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("concurrent-bootstrap");
    const [first, second] = await Promise.all([transport.bootstrap(), transport.bootstrap()]);
    assert.equal(first, second);
    assert.equal(calls.filter((call) => call.url === "/api/v1/health").length, 1);
    assert.equal(calls.filter((call) => call.url === "/api/v1/extension/bootstrap").length, 1);
    assert.equal(calls.filter((call) => call.url === "/api/v1/proof").length, 1);
    assert.equal(chromeFixture.nativeCalls(), 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a verified in-memory session does not repeat the proof handshake before every progress request", async () => {
  const calls = [];
  const server = await startServer(calls);
  installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("progress-session");
    await transport.bootstrap();
    assert.equal((await transport.fetch(null, "/api/notes/current", { method: "GET" })).ok, true);
    assert.equal((await transport.fetch(null, "/api/notes/current", { method: "GET" })).ok, true);
    assert.equal(calls.filter((call) => call.url === "/api/v1/proof").length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("protocol mismatch is actionable and manual pairing APIs remain absent", async () => {
  const calls = [];
  const server = await startServer(calls, { protocolVersion: 99 });
  installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("protocol");
    await assert.rejects(
      () => transport.bootstrap(),
      (error) => error && error.code === "protocol-incompatible",
    );
    assert.equal(transport.beginPairing, undefined);
    assert.equal(transport.completePairing, undefined);
    assert.equal(transport.clearStoredCredential, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("collection, image, media, notes and recording share the direct verified adapter", async () => {
  const calls = [];
  const server = await startServer(calls);
  const chromeFixture = installChrome();
  installBrowserFetch();
  usePorts(server.address().port);
  try {
    const transport = await loadHelper("all-business-routes");
    for (const route of [
      "/collect",
      "/api/assets/import-image",
      "/api/assets/import-media",
      "/api/notes",
      "/api/notes/current",
      "/api/video/record/save",
    ]) {
      const response = await transport.fetch(null, route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixture: route }),
      });
      assert.equal(response.ok, true);
    }
    assert.equal(chromeFixture.nativeCalls(), 0);
    assert.equal(chromeFixture.storageWrites.length, 0);
    for (const call of calls.filter((call) => call.url.startsWith("/api/v1/"))) {
      assert.equal(call.authorization, undefined);
    }
    for (const call of calls.filter((call) => !call.url.startsWith("/api/v1/"))) {
      assert.equal(call.authorization, `Bearer ${CREDENTIAL}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
