import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs";

// Use the real carrier with only synthetic authority and a fresh, retained
// fixture directory. No installed profile, model or network service is used.
test("Fetch resources preserve carrier authorization and the admitted peer", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fetch-resource-"));
  const oldHome = process.env.DSH_HOME;
  const fds = [], disposers = [];
  const seen = [];
  let service, emittedPeer;
  try {
    process.env.DSH_HOME = home;
    const fd = (name, contents) => {
      const file = join(home, name);
      writeFileSync(file, contents);
      const handle = openSync(file, "r+");
      fds.push(handle);
      return handle;
    };
    await apply({
      provide(name, value) { if (name === "webServer") service = value; },
      get() {},
      effect(fn) { disposers.push(fn()); },
      emit(name, _table, peer) { if (name === "webserver/index-inject") emittedPeer = peer; },
    }, {
      authorityFd: fd("authority", JSON.stringify({ protocol: 1, generation: 1,
        cookieName: "native", cookieValue: "x".repeat(32), bootstrapRef: "y".repeat(32),
        bootstrapPath: "/_luckyray/bootstrap" })),
      readyFd: fd("ready", ""), controlFd: fd("control", ""), controlLineFd: fd("reply", ""),
    });
    const resource = async (req, peer) => {
      seen.push({ method: req.method, path: new URL(req.url).pathname, peer });
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "fixture-a=1; Path=/");
      headers.append("set-cookie", "fixture-b=2; Path=/");
      return new Response("fixture-resource", { status: 200, headers });
    };
    service.register({ kind: "prefix", path: "/plugins/fixture", resource });
    service.registerFallback({ resource: async () => new Response("fixture-fallback") });
    assert.throws(() => service.register({ kind: "exact", path: "/ambiguous", handler() {}, resource }),
      /dsh-native-carrier-route-invalid/u);
    const origin = `http://127.0.0.1:${service.port}`;
    const raw = (path, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
      const req = request(`${origin}${path}`, { method, headers }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.setTimeout(5_000, () => req.destroy(new Error("synthetic-fetch-resource-timeout")));
      req.end();
    });
    const cookie = `native=${"x".repeat(32)}`;
    assert.equal((await raw("/plugins/fixture/item")).status, 403);
    assert.equal(seen.length, 0, "a resource must not run before carrier admission");
    const result = await raw("/plugins/fixture/item", { headers: { cookie } });
    assert.equal(result.status, 200);
    assert.equal(result.body, "fixture-resource");
    assert.equal(result.headers["set-cookie"].length, 2);
    assert.equal(seen[0].peer, undefined, "HTTP resources do not receive an implicit peer");
    const head = await raw("/plugins/fixture/item", { method: "HEAD", headers: { cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    const beforePost = seen.length;
    const post = await raw("/plugins/fixture/item", { method: "POST", headers: { cookie, origin } });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
    assert.equal(seen.length, beforePost);
    assert.equal((await raw("/_luckyray/not-registered", { headers: { cookie } })).status, 403);
    assert.equal((await raw("/plugins/fixture/item", { headers: { cookie, origin: "http://127.0.0.1:1" } })).status, 403);

    const peer = { id: "admitted-fixture" };
    const internal = await service.readResource(new Request(`${origin}/plugins/fixture/item`), peer);
    assert.equal(await internal.text(), "fixture-resource");
    assert.equal(seen.at(-1).peer, peer);
    const internalHead = await service.readResource(new Request(`${origin}/plugins/fixture/item`, { method: "HEAD" }), peer);
    assert.equal(internalHead.status, 200);
    assert.equal(await internalHead.text(), "");
    assert.equal((await service.readResource(new Request(`${origin}/plugins/fixture/item`, { method: "POST" }), peer)).status, 405);
    assert.equal((await service.readResource(new Request(`${origin}/api/not-registered`), peer)).status, 404);
    service.renderIndex("<html><head></head><body></body></html>", peer);
    assert.equal(emittedPeer, peer);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    await new Promise(resolve => setImmediate(resolve));
    for (const handle of fds) closeSync(handle);
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
  }
});
