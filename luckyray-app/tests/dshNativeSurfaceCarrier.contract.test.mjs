import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeCarrierPath,
  consumeCarrierBootstrap,
  createCarrierAuthorization,
  createOpenIntentSlot,
  evaluateHttpAuthorization,
  evaluateWebSocketAuthorization,
  isProtectedCarrierNamespace,
  renderIndexInjections,
} from "../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs";

const origin = "http://127.0.0.1:43210";
const host = "127.0.0.1:43210";

function encodedIntent(intentId, source = "notes", text = "请整理这段内容", localResources = []) {
  return Buffer.from(JSON.stringify({ intentId, localResources, source, text }), "utf8").toString("base64url");
}

test("authenticated carrier keeps one generation-bound intent until exact composer acknowledgement", () => {
  const slot = createOpenIntentSlot();
  slot.bind(5);
  const firstId = "intent-00000001-0000-4000-8000-000000000000";
  const latestId = "intent-00000002-0000-4000-8000-000000000000";
  assert.equal(slot.stage(5, encodedIntent(firstId)), firstId);
  assert.equal(slot.status(5, firstId), "pending");
  assert.throws(() => slot.stage(5, encodedIntent(latestId, "search", "解释搜索结果")), /dsh-open-intent-busy/u);
  assert.deepEqual(slot.read(5), {
    intentId: firstId,
    localResources: [],
    source: "notes",
    text: "请整理这段内容",
  });
  assert.equal(slot.acknowledge(5, latestId), false);
  assert.equal(slot.acknowledge(5, firstId), true);
  assert.equal(slot.status(5, firstId), "applied");
  assert.equal(slot.read(5), null);
  assert.throws(() => slot.stage(4, encodedIntent(firstId)), /dsh-open-intent-invalid/u);
  slot.stage(5, encodedIntent(latestId));
  slot.revoke();
  assert.equal(slot.read(5), null);
  assert.equal(slot.status(5, latestId), "unavailable");
  assert.throws(() => slot.stage(5, encodedIntent(firstId)), /dsh-open-intent-invalid/u);
});

test("authenticated carrier accepts typed user-selected material paths without weakening ordinary text", () => {
  const slot = createOpenIntentSlot();
  const intentId = "intent-00000003-0000-4000-8000-000000000000";
  const resources = [
    { kind: "material", assetId: "asset-1", canonicalPath: "C:\\素材 空间\\图像 #1 (`版`).png", delivery: "path-reference" },
    { kind: "material", assetId: "asset-2", canonicalPath: "D:\\第二张 (终稿).jpg", delivery: "path-reference" },
  ];
  slot.bind(7);
  slot.stage(7, encodedIntent(intentId, "materials", "请分析以下本地素材。", resources));
  assert.deepEqual(slot.read(7), { intentId, localResources: resources, source: "materials", text: "请分析以下本地素材。" });
  assert.throws(
    () => slot.stage(7, encodedIntent(intentId, "notes", "请读取 C:\\secret.txt", resources)),
    /dsh-open-intent-invalid/u,
  );
  assert.throws(() => slot.stage(7, encodedIntent(intentId, "notes", "请整理这段内容", resources)), /dsh-open-intent-conflict/u);
  assert.equal(slot.acknowledge(7, intentId), true);
  assert.throws(
    () => slot.stage(7, encodedIntent(intentId, "notes", "请整理这段内容", resources)),
    /dsh-open-intent-conflict/u,
    "an acknowledged identity cannot be rebound to different content",
  );
});

test("an acknowledged intent remains applied when its caller loses the result and retries", () => {
  const slot = createOpenIntentSlot();
  const intentId = "intent-00000008-0000-4000-8000-000000000000";
  const encoded = encodedIntent(intentId, "notes", "合成笔记引用");
  slot.bind(11);
  slot.stage(11, encoded);
  assert.equal(slot.acknowledge(11, intentId), true);
  assert.equal(slot.stage(11, encoded), intentId);
  assert.equal(slot.status(11, intentId), "applied");
  assert.equal(slot.read(11), null, "the authenticated carrier must not redeliver an applied intent");
  assert.throws(() => slot.stage(11, encodedIntent(intentId, "notes", "不同内容")), /dsh-open-intent-conflict/u);
  slot.bind(12);
  assert.throws(() => slot.stage(12, encoded), /dsh-open-intent-stale/u,
    "a retry cannot apply an old intent to a new surface generation");
});

function headers(values = {}) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
}

test("rc.2 structured index injections retain official placement and escaping", () => {
  const html = "<!doctype html><html><head></head><body></body></html>";
  const rendered = renderIndexInjections(html, [
    { kind: "global", name: "boot<state", value: { marker: "<safe>" } },
    { kind: "script-src", placement: "head", src: "/plugins/a&b.js" },
    { kind: "html", placement: "body", html: "<main>ready</main>" },
  ]);
  assert.match(rendered, /globalThis\["boot\\u003cstate"\] = \{"marker":"\\u003csafe>"\}/u);
  assert.match(rendered, /<script src="\/plugins\/a&amp;b\.js"><\/script><\/head>/u);
  assert.match(rendered, /<body><main>ready<\/main>/u);
});

test("0.1.5 script preloads escape attributes in head and unknown injections still fail", () => {
  const html = "<html><head></head><body></body></html>";
  const rendered = renderIndexInjections(html, [
    { kind: "script-preload", src: '/plugins/a&b"<x>.js' },
  ]);
  assert.match(rendered, /<head><link rel="preload" as="script" href="\/plugins\/a&amp;b&quot;&lt;x&gt;\.js"><\/head>/u);
  assert.throws(() => renderIndexInjections(html, [{ kind: "unknown" }]), /dsh-native-carrier-index-injection-invalid/u);
});

test("HTTP auth owns identity/path but leaves method and schema to official handler", () => {
  const authority = createCarrierAuthorization({
    generation: 7,
    host,
    origin,
    cookieName: "__Host-luckyray-dsh-g7",
    cookieValue: "a".repeat(64),
    bootstrapRef: "b".repeat(64),
    exactPaths: ["/api/session"],
    prefixPaths: ["/plugins"],
    upgradePaths: ["/api/events", "/api/runtime"],
  });
  const accepted = evaluateHttpAuthorization(authority, {
    path: "/api/session",
    method: "TRACE",
    headers: headers({ host, cookie: `${authority.cookieName}=${authority.cookieValue}` }),
  });
  assert.deepEqual(accepted, { accepted: true, routeKind: "exact" });
  assert.equal(Object.hasOwn(accepted, "method"), false);
  assert.equal(Object.hasOwn(accepted, "schema"), false);

  assert.equal(evaluateHttpAuthorization(authority, {
    path: "/plugins/client.js",
    method: "GET",
    headers: headers({ host, cookie: `${authority.cookieName}=${authority.cookieValue}` }),
  }).accepted, true, "normal static fetch without Origin remains valid");

  for (const request of [
    { path: "/api/session", headers: headers({ host }) },
    { path: "/api/session", headers: headers({ host: "localhost:43210", cookie: `${authority.cookieName}=${authority.cookieValue}` }) },
    { path: "/api/session", headers: headers({ host, cookie: `${authority.cookieName}=stale` }) },
    { path: "/api/session", headers: headers({ host, cookie: `${authority.cookieName}=${authority.cookieValue}`, "sec-fetch-site": "cross-site" }) },
    { path: "/api/session", headers: headers({ host, cookie: `${authority.cookieName}=${authority.cookieValue}`, origin: "null" }) },
    { path: "/not-registered", headers: headers({ host, cookie: `${authority.cookieName}=${authority.cookieValue}` }) },
  ]) {
    assert.equal(evaluateHttpAuthorization(authority, request).accepted, false);
  }
});

test("both official websocket paths require exact Host, Origin, cookie, and generation", () => {
  const authority = createCarrierAuthorization({
    generation: 9,
    host,
    origin,
    cookieName: "__Host-luckyray-dsh-g9",
    cookieValue: "c".repeat(64),
    bootstrapRef: "d".repeat(64),
    exactPaths: [],
    prefixPaths: [],
    upgradePaths: ["/api/events", "/api/runtime"],
  });
  for (const path of authority.upgradePaths) {
    assert.equal(evaluateWebSocketAuthorization(authority, {
      path,
      headers: headers({ host, origin, cookie: `${authority.cookieName}=${authority.cookieValue}` }),
    }).accepted, true);
    for (const hostile of [
      headers({ host, cookie: `${authority.cookieName}=${authority.cookieValue}` }),
      headers({ host, origin: "null", cookie: `${authority.cookieName}=${authority.cookieValue}` }),
      headers({ host, origin, cookie: `${authority.cookieName}=wrong` }),
      headers({ host: "localhost:43210", origin, cookie: `${authority.cookieName}=${authority.cookieValue}` }),
    ]) {
      assert.equal(evaluateWebSocketAuthorization(authority, { path, headers: hostile }).accepted, false);
    }
  }
});

test("bootstrap is exact-host, generation-bound, and one-shot", () => {
  const authority = createCarrierAuthorization({
    generation: 11,
    host,
    origin,
    cookieName: "__Host-luckyray-dsh-g11",
    cookieValue: "e".repeat(64),
    bootstrapRef: "f".repeat(64),
    exactPaths: [],
    prefixPaths: [],
    upgradePaths: [],
  });
  assert.equal(authority.consumeBootstrap({ host, ref: "f".repeat(64), origin: undefined }).accepted, true);
  assert.equal(authority.consumeBootstrap({ host, ref: "f".repeat(64), origin: undefined }).accepted, false);
});

test("retired carrier bindings reject an otherwise unconsumed bootstrap", () => {
  const authority = createCarrierAuthorization({
    generation: 12,
    host,
    origin,
    cookieName: "__Host-luckyray-dsh-g12",
    cookieValue: "a".repeat(64),
    bootstrapRef: "b".repeat(64),
    exactPaths: [], prefixPaths: [], upgradePaths: [],
  });
  assert.equal(consumeCarrierBootstrap({ ...authority, active: false }, {
    host, ref: "b".repeat(64), origin: undefined,
  }).accepted, false);
  assert.equal(consumeCarrierBootstrap(authority, {
    host, ref: "b".repeat(64), origin: undefined,
  }).accepted, true);
});

test("cross-site bootstrap and protected namespace misses fail before SPA fallback", () => {
  const authority = createCarrierAuthorization({
    generation: 12,
    host,
    origin,
    cookieName: "__Host-luckyray-dsh-g12",
    cookieValue: "a".repeat(64),
    bootstrapRef: "b".repeat(64),
    exactPaths: [], prefixPaths: [], upgradePaths: [],
  });
  assert.equal(authority.consumeBootstrap({
    host, ref: "b".repeat(64), origin: undefined, secFetchSite: "cross-site",
  }).accepted, false);
  for (const path of ["/api/missing", "/plugins/missing", "/_luckyray/unknown"]) {
    assert.equal(isProtectedCarrierNamespace(path), true);
  }
  assert.equal(isProtectedCarrierNamespace("/assets/app.js"), false);
});

test("canonical carrier paths decode once and deny protected aliases before fallback", () => {
  assert.deepEqual(canonicalizeCarrierPath("/assets/%E4%BD%A0%E5%A5%BD.js"), {
    accepted: true,
    path: "/assets/你好.js",
    protected: false,
  });
  assert.deepEqual(canonicalizeCarrierPath("/%61pi/missing"), {
    accepted: true,
    path: "/api/missing",
    protected: true,
  });
  for (const hostile of [
    "/api%2Fmissing",
    "/api%5Cmissing",
    "/api/%252e%252e",
    "/api/%",
    "/api/%C0%AF",
    "/api\\missing",
  ]) {
    assert.equal(canonicalizeCarrierPath(hostile).accepted, false, hostile);
  }
});
