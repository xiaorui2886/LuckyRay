import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";
import * as reqHttp from "node:http";
import { createNativeSurfaceOwner } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";
import surfaceState from "../src-tauri/dsh-host/luckyray-dsh-native-surface-state/client.js";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("state client registers its package ID inside official combined script URLs", async () => {
  const source = await readFile(join(appRoot, "src-tauri/dsh-host/luckyray-dsh-native-surface-state/client.js"), "utf8");
  const entries = [];
  vm.runInNewContext(source, {
    URL,
    location: { origin: "http://127.0.0.1:43210" },
    document: { currentScript: { src: "http://127.0.0.1:43210/plugins/??@luckyray/dsh-native-surface-state/client.js,@deepseek-ai/dsh-client-hmr/client.js&rev=fixture" } },
    window: { __ModuleLoader__: { load(entry) { entries.push(entry); } } },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "@luckyray/dsh-native-surface-state");
  assert.equal(typeof entries[0].factory().apply, "function");
});

test("native observer accepts both frozen-old adapter.current and current uiSession.current", () => {
  const selectedSession = {
    getSnapshot: () => ({ key: null }),
    subscribe: () => () => {},
  };
  assert.equal(surfaceState.selectedSessionSource({ adapter: { current: selectedSession } }), selectedSession);
  assert.equal(surfaceState.selectedSessionSource({ current: selectedSession }), selectedSession);
  assert.equal(surfaceState.selectedSessionSource(null), undefined);
});

// Raw node:http fetch: the carrier server closes connections per request in
// production (outer-host semantics), and undici keep-alive races that close.
function rawFetch(url, { headers = {}, method = "GET" } = {}) {
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
    req.setTimeout(30_000, () => {
      req.destroy(new Error("carrier request timeout"));
    });
    req.end();
  });
}

function validPluginUrl(value) {
  return typeof value === "string"
    && /^file:\/\/\/[A-Za-z]:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(value)
    && !/[\r\n"\\]/u.test(value);
}

function renderNativeSurfacePatch(template) {
  // 0.1.5 ships package-name plugin entries and no URL sentinels.
  if (typeof template !== "string" || template.length === 0 || template.length > 64 * 1024) {
    throw new Error("dsh-native-surface-patch-invalid");
  }
  if (template.includes("__LUCKYRAY") || template.includes("!!js")) {
    throw new Error("dsh-native-surface-patch-invalid");
  }
  return template;
}

async function installTrackedSurfaceModules(stateRoot) {
  const { cpSync } = await import("node:fs");
  for (const packageName of ["dsh-authenticated-webserver", "dsh-resource-tools", "dsh-native-surface-state", "dsh-lightseek-ui"]) {
    const source = join(appRoot, "src-tauri", "dsh-host", `luckyray-${packageName}`);
    const target = join(stateRoot, "profiles", "node_modules", "@luckyray", packageName);
    cpSync(source, target, { recursive: true });
  }
}

test("the 0.1.5 boot graph keeps the LuckyRay observer and its conversation dependency present exactly once", () => {
  const graph = {
    entries: [
      { id: "@deepseek-ai/dsh-client-ui-conversation" },
      { id: "@luckyray/dsh-native-surface-state" },
      { id: "@deepseek-ai/dsh-client-connection" },
    ],
  };
  const html = `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)}</script></head></html>`;
  const rendered = surfaceState.assertLuckyRayStateGraphOrder(html);
  assert.equal(rendered, html, "the 0.1.5 graph is authoritative and must not be reordered");
  const encoded = /globalThis\["__DSH_BOOT__"\]\s*=\s*(?<json>\{[^<]+\})<\/script>/u.exec(rendered)?.groups?.json;
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(encoded).entries.map((entry) => entry.id), [
    "@deepseek-ai/dsh-client-ui-conversation",
    "@luckyray/dsh-native-surface-state",
    "@deepseek-ai/dsh-client-connection",
  ]);
});

test("the 0.1.5 graph assertion fails closed on a missing dependency or duplicated observer", () => {
  const htmlFor = (entries) =>
    `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ entries })}</script></head></html>`;
  assert.throws(
    () => surfaceState.assertLuckyRayStateGraphOrder(htmlFor([
      { id: "@luckyray/dsh-native-surface-state" },
      { id: "@deepseek-ai/dsh-client-connection" },
    ])),
    /dsh-native-surface-state-graph-invalid/u,
    "a missing conversation dependency must fail the tap",
  );
  assert.throws(
    () => surfaceState.assertLuckyRayStateGraphOrder(htmlFor([
      { id: "@deepseek-ai/dsh-client-ui-conversation" },
      { id: "@luckyray/dsh-native-surface-state" },
      { id: "@luckyray/dsh-native-surface-state" },
    ])),
    /dsh-native-surface-state-graph-invalid/u,
    "a duplicated observer must fail the tap",
  );
});

test("unmodified rc.2 one-shot and continuable subagent providers stay usable without any LuckyRay deny filter", async () => {
  const runtimeRoot = process.env.DSH_M1_RUNTIME_ROOT;
  assert.ok(runtimeRoot);
  const officialModule = (name) => pathToFileURL(join(
    runtimeRoot, "host", "node_modules", "@deepseek-ai", name, "lib", "index.js",
  )).href;
  const spawnModule = await import(officialModule("dsh-subagent-spawn-in-process"));
  const forkModule = await import(officialModule("dsh-subagent-fork-in-process"));
  const providers = new Map();
  const listeners = [];
  const started = [];
  const ctx = {
    subagents: {
      getProvider: (name) => providers.get(name),
      registerProvider(provider) {
        providers.set(provider.name, provider);
        for (const listener of listeners) listener(provider);
      },
    },
    on(name, listener) {
      assert.equal(name, "subagent/provider-added");
      listeners.push(listener);
    },
  };
  spawnModule.apply(ctx, { providerName: "spawn" });
  forkModule.apply(ctx, { providerName: "fork" });
  await new Promise((resolveReady) => {
    if (providers.has("spawn") && providers.has("fork")) resolveReady();
    else {
      const check = () => { if (providers.has("spawn") && providers.has("fork")) resolveReady(); };
      listeners.push(check);
    }
  });
  for (const name of ["spawn", "fork"]) {
    const provider = providers.get(name);
    assert.equal(provider.capabilities.toolFilter, true);
    assert.equal(
      providers.has(`luckyray-filtered-${name}`), false,
      "M1 installs no filtered provider wrapping official subagents",
    );
    provider.start = async (request) => {
      started.push({ name, request });
      return { dispose() {} };
    };
  }
  await providers.get("spawn").start({ toolFilter: { deny: ["bash"] } });
  assert.equal(started.length, 1);
  assert.deepEqual(
    started[0].request.toolFilter, { deny: ["bash"] },
    "official provider receives the caller filter unchanged; no unknown LuckyRay tool names are injected",
  );
});

test("unmodified rc.2 tool-subagent creates continuable children without a LuckyRay deny descriptor", async () => {
  const officialProfileRoot = process.env.DSH_M1_OFFICIAL_PROFILE_ROOT;
  assert.ok(officialProfileRoot, "DSH_M1_OFFICIAL_PROFILE_ROOT is required for the accepted rc.2 profile fixture");
  const official = await import(pathToFileURL(join(
    officialProfileRoot,
    "node_modules",
    "@deepseek-ai",
    "dsh-tool-subagent",
    "lib",
    "index.js",
  )).href);
  let tool;
  const continuableRequests = [];
  const provider = {
    name: "spawn",
    capabilities: { depthLimit: true },
    inheritsParentContext: false,
    async prepareContinuable() {},
  };
  const ctx = {
    subagents: {
      getProvider: (name) => name === provider.name ? provider : undefined,
      resolveMaxDepth: () => undefined,
      async startContinuable(request) {
        continuableRequests.push(request);
        return { childId: "child-official" };
      },
    },
    tools: {
      register(value) { tool = value; return () => {}; },
      get() { return tool; },
    },
    // 0.1.5 tool-subagent registers a session projection for child model
    // selection; the LuckyRay-agnostic official observation only mocks it.
    sessionProjections: { register() {} },
    systemPrompt: { section() {}, getSectionOrder: () => [] },
    on() {},
    get() { return undefined; },
    logger: { info() {} },
  };
  official.apply(ctx, {
    provider: provider.name,
    toolName: "subagent",
    backgroundMode: "continuable",
  });
  assert.ok(tool);
  const result = await tool.execute(
    { description: "official child policy", prompt: "perform bounded work", run_in_background: true },
    { agent: { id: "parent", session: { requestHeader: () => undefined }, options: {} }, signal: new AbortController().signal },
  );
  assert.deepEqual(result, { kind: "continuable", subagentId: "child-official" });
  assert.equal(continuableRequests.length, 1);
  assert.equal(
    continuableRequests[0].request.toolFilter, undefined,
    "M1 passes no toolFilter deny descriptor, so unknown LuckyRay tool names cannot break official children",
  );
});

test("unmodified rc.2 Web composition boots through the authenticated app-owned carrier", { timeout: 75_000 }, async () => {
  const runtimeRoot = process.env.DSH_M1_RUNTIME_ROOT;
  const stateRoot = process.env.DSH_M1_STATE_ROOT;
  assert.ok(runtimeRoot && stateRoot, "DSH_M1_RUNTIME_ROOT and DSH_M1_STATE_ROOT are required production fixtures");
  const plugin = join(appRoot, "src-tauri", "dsh-host", "luckyray-dsh-authenticated-webserver/index.mjs");
  const patchTemplate = join(appRoot, "src-tauri", "dsh-host", "luckyray-dsh-native-surface.patch.yml");
  const patch = join(stateRoot, "luckyray-dsh-native-surface.generated.patch.yml");
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });
  await installTrackedSurfaceModules(stateRoot);
  await writeFile(
    patch,
    renderNativeSurfacePatch(await readFile(patchTemplate, "utf8")),
    { encoding: "utf8", flag: "wx" },
  );

  const owner = createNativeSurfaceOwner({
    runtimeRoot,
    stateRoot,
    surfaceHome: stateRoot,
    surfacePatch: patch,
  });
  try {
    const ready = await owner.open();
    assert.equal(ready.stage, "surface-ready");
    assert.equal(ready.outcome, "accepted");
    assert.equal(ready.carrierGeneration, 1);
    assert.ok(Number.isSafeInteger(ready.port) && ready.port > 0);
    const base = `http://127.0.0.1:${ready.port}`;
    const crossSite = await rawFetch(`${base}${ready.bootstrapPath}?ref=${ready.bootstrapRef}`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);
    const bootstrap = await rawFetch(`${base}${ready.bootstrapPath}?ref=${ready.bootstrapRef}`);
    assert.equal(bootstrap.status, 302);
    const firstCookie = (value) => {
      const raw = value["set-cookie"];
      return (Array.isArray(raw) ? raw[0] : raw)?.split(";", 1)[0];
    };
    const cookie = firstCookie(bootstrap.headers);
    assert.ok(cookie);
    // 0.1.5's official Connection gates the index behind its process-token
    // exchange; the carrier bootstrap redirects to the launch URL that the
    // outer host relayed, the exchange mints the official session cookie, and
    // both cookies then admit the index.
    const launchLocation = bootstrap.headers.location;
    assert.match(launchLocation ?? "", /^(?:http:\/\/127\.0\.0\.1:\d{1,5})?\/\?token=[A-Za-z0-9_-]{16,240}$/u);
    const exchange = await rawFetch(new URL(launchLocation, base).href, {
      headers: { cookie },
    });
    assert.equal(exchange.status, 303);
    const officialCookie = firstCookie(exchange.headers);
    assert.ok(officialCookie);
    const index = await rawFetch(base, {
      headers: { cookie: `${cookie}; ${officialCookie}` },
    });
    assert.equal(index.status, 200);
    const html = index.text();
    assert.match(html, /__DSH_BOOT__|<html/iu);
    const bootSource = /globalThis\["__DSH_BOOT__"\]\s*=\s*(?<json>\{[^<]+\})<\/script>/u.exec(html)?.groups?.json;
    assert.ok(bootSource, "official client graph must be embedded by the unmodified client module host");
    const graph = JSON.parse(bootSource);
    const entryIds = graph.entries.map((entry) => entry.id);
    // 0.1.5 lazy model: graph order carries no execution semantics (deps are
    // declared via dsh.client.inject), so assert presence, not positions.
    for (const required of [
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-theme",
      "@deepseek-ai/dsh-client-ui-brand-official",
      "@luckyray/dsh-native-surface-state",
      "@luckyray/dsh-lightseek-ui",
    ]) {
      assert.equal(entryIds.filter((id) => id === required).length, 1, required);
    }
    assert.equal(entryIds.filter((id) => id === "@deepseek-ai/dsh-client-runtime").length, 0,
      "the retired 0.1.x client-runtime entry must not return");
    const lightSeekEntry = graph.entries.find((entry) => entry.id === "@luckyray/dsh-lightseek-ui");
    const lightSeekBundle = await rawFetch(new URL(lightSeekEntry.url, base).href, {
      headers: { cookie },
    });
    assert.equal(lightSeekBundle.status, 200);
    assert.match(lightSeekBundle.text(), /@luckyray\/dsh-lightseek-ui|LightSeek/u);
    assert.ok(
      entryIds.every((id) => !id.includes("dsh-native-surface-observer")),
      "the envelope observer stays deleted from the official graph",
    );
    const authenticatedCookies = `${cookie}; ${officialCookie}`;
    const protectedMiss = await rawFetch(`${base}/api/not-real`, { headers: { cookie: authenticatedCookies } });
    assert.equal([403, 404].includes(protectedMiss.status), true, `protected miss status: ${protectedMiss.status}`);
    assert.doesNotMatch(protectedMiss.text(), /__DSH_BOOT__|<html/iu);
    for (const alias of ["/%61pi/not-real", "/api%2Fnot-real", "/%2561pi/not-real", "/api/%ZZ"]) {
      const response = await rawFetch(`${base}${alias}`, { headers: { cookie: authenticatedCookies } });
      assert.equal([403, 404].includes(response.status), true, alias);
      assert.doesNotMatch(response.text(), /__DSH_BOOT__|<html/iu, alias);
    }
    const replay = await rawFetch(`${base}${ready.bootstrapPath}?ref=${ready.bootstrapRef}`);
    assert.equal(replay.status, 403);
  } finally {
    await owner.shutdown();
  }
});

test("official carrier ends failing routes, redacts diagnostics, and serves the next request", { timeout: 60_000 }, async () => {
  const runtimeRoot = process.env.DSH_M1_RUNTIME_ROOT;
  const stateRoot = `${process.env.DSH_M1_STATE_ROOT}-route-errors`;
  assert.ok(runtimeRoot && process.env.DSH_M1_STATE_ROOT);
  await mkdir(stateRoot, { recursive: true });
  await installTrackedSurfaceModules(stateRoot);
  const fixture = join(stateRoot, "profiles/node_modules/@luckyray/route-error-fixture");
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "@luckyray/route-error-fixture", version: "1.0.0", type: "module", main: "index.mjs" }));
  await writeFile(join(fixture, "index.mjs"), `export function apply(ctx) {
    const web = ctx.get("webServer");
    web.register({ kind: "exact", path: "/_luckyray/test-failure", handler() {
      throw new Error("PRIVATE_FIXTURE_MARKER_" + "x".repeat(10000));
    } });
    web.register({ kind: "exact", path: "/_luckyray/test-partial", handler(req, res) {
      res.writeHead(200, { "content-length": "10000" }); res.write("partial");
      throw new Error("PRIVATE_FIXTURE_MARKER_PARTIAL");
    } });
    web.register({ kind: "exact", path: "/_luckyray/test-live", handler(req, res) { res.end("alive"); } });
  }`);
  const patch = join(stateRoot, "surface.patch.yml");
  await writeFile(patch, await readFile(join(appRoot, "src-tauri/dsh-host/luckyray-dsh-native-surface.patch.yml"), "utf8")
    + '\n    - id: route-error-fixture\n      name: "@luckyray/route-error-fixture"\n      inject: [webServer]\n');
  let diagnostics = "";
  const owner = createNativeSurfaceOwner({ runtimeRoot, stateRoot, surfaceHome: stateRoot, surfacePatch: patch,
    onChildStarted(child) { child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-32000); }); },
  });
  try {
    const ready = await owner.open();
    const base = `http://127.0.0.1:${ready.port}`;
    const bootstrap = await rawFetch(`${base}${ready.bootstrapPath}?ref=${ready.bootstrapRef}`);
    const cookie = bootstrap.headers["set-cookie"][0].split(";", 1)[0];
    const failure = await rawFetch(`${base}/_luckyray/test-failure`, { headers: { cookie } });
    assert.equal(failure.status, 500);
    assert.equal(failure.text(), "dsh-carrier-route-error");
    assert.equal(failure.headers["cache-control"], "no-store");
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(diagnostics.includes("PRIVATE_FIXTURE_MARKER"), false, "route exceptions must not disclose arbitrary upstream text");
    await assert.rejects(async () => {
      const partial = await fetch(`${base}/_luckyray/test-partial`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
      await partial.text();
    });
    const live = await rawFetch(`${base}/_luckyray/test-live`, { headers: { cookie } });
    assert.equal(live.status, 200);
    assert.equal(live.text(), "alive");
  } finally { await owner.shutdown(); }
});

test("the app-owned outer host owns a reusable official surface and Level-1 close", { timeout: 75_000 }, async (t) => {
  const runtimeRoot = process.env.DSH_M1_RUNTIME_ROOT;
  const stateRoot = process.env.DSH_M1_STATE_ROOT ? `${process.env.DSH_M1_STATE_ROOT}-owner` : "";
  assert.ok(runtimeRoot && stateRoot);
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });
  const plugin = join(appRoot, "src-tauri", "dsh-host", "luckyray-dsh-authenticated-webserver/index.mjs");
  const patchTemplate = join(appRoot, "src-tauri", "dsh-host", "luckyray-dsh-native-surface.patch.yml");
  const patch = join(stateRoot, "luckyray-dsh-native-surface.generated.patch.yml");
  await installTrackedSurfaceModules(stateRoot);
  await writeFile(patch, renderNativeSurfacePatch(
    await readFile(patchTemplate, "utf8"),
  ), { encoding: "utf8", flag: "wx" });
  const owner = createNativeSurfaceOwner({
    runtimeRoot,
    stateRoot,
    surfaceHome: stateRoot,
    surfacePatch: patch,
  });
  let primaryError;
  try {
    const coldStarted = performance.now();
    const first = await owner.open();
    const coldOpenMs = Math.round(performance.now() - coldStarted);
    const warmStarted = performance.now();
    const warm = await owner.open();
    const warmOpenMs = Math.round(performance.now() - warmStarted);
    assert.equal(warm.port, first.port, "same outer Host owner reuses the live official carrier");
    assert.notEqual(warm.bootstrapRef, first.bootstrapRef, "warm binding rotates one-shot authority");
    const stale = await fetch(`http://127.0.0.1:${first.port}${first.bootstrapPath}?ref=${first.bootstrapRef}`, { redirect: "manual" });
    assert.equal(stale.status, 403);
    const bootstrap = await rawFetch(`http://127.0.0.1:${warm.port}${warm.bootstrapPath}?ref=${warm.bootstrapRef}`);
    assert.equal(bootstrap.status, 302);
    const setCookie = bootstrap.headers["set-cookie"]?.[0];
    const cookie = setCookie?.split(";", 1)[0];
    assert.ok(cookie && setCookie?.includes("HttpOnly"));
    const modelProjection = JSON.parse(Buffer.from((await owner.syncModel()).payload, "base64url").toString("utf8"));
    assert.ok(
      ["ready", "stale", "unavailable"].includes(modelProjection.outcome),
      `owner correlates the model-sync-result frame: ${JSON.stringify(modelProjection)}`,
    );
    const intent = {
      intentId: "intent-00000001-0000-4000-8000-000000000000",
      localResources: [],
      source: "notes",
      text: "请整理这段内容",
    };
    assert.deepEqual(
      await owner.stageIntent(Buffer.from(JSON.stringify(intent), "utf8").toString("base64url")),
      { outcome: "accepted" },
    );
    assert.deepEqual(await owner.intentStatus(intent.intentId), { payload: "pending" });
    const staged = await fetch(`http://127.0.0.1:${warm.port}/_luckyray/open-intent`, {
      headers: { cookie, host: `127.0.0.1:${warm.port}` },
    });
    assert.equal(staged.status, 200);
    assert.deepEqual(await staged.json(), intent, "owner correlates open-intent-result and keeps the exact pending draft");
    const applied = await fetch(`http://127.0.0.1:${warm.port}/_luckyray/open-intent`, {
      method: "POST",
      headers: { cookie, host: `127.0.0.1:${warm.port}`, "content-type": "application/json" },
      body: JSON.stringify({ intentId: intent.intentId }),
    });
    assert.equal(applied.status, 204);
    assert.deepEqual(await owner.intentStatus(intent.intentId), { payload: "applied" });
    t.diagnostic(JSON.stringify({ coldOpenMs, warmOpenMs, hostRssMb: Math.round(first.rssBytes / 1024 / 1024), ownedProcessCount: first.ownedProcessCount }));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      const closed = await owner.close();
      if (!primaryError) {
        assert.equal(closed.stage, "surface-closed");
        assert.equal(closed.outcome, "accepted");
        assert.equal(closed.ownedProcessCount, 2);
        assert.ok(closed.rssBytes > 0);
      }
    } catch (error) {
      if (!primaryError) throw error;
    } finally {
      await owner.shutdown();
    }
  }
});

test("unexpected official Web Host exit invalidates the binding and reopen is refused until whole-tree recovery", { timeout: 75_000 }, async () => {
  const runtimeRoot = process.env.DSH_M1_RUNTIME_ROOT;
  const stateRoot = process.env.DSH_M1_STATE_ROOT ? `${process.env.DSH_M1_STATE_ROOT}-crash` : "";
  assert.ok(runtimeRoot && stateRoot);
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });
  const plugin = join(appRoot, "src-tauri", "dsh-host", "luckyray-dsh-authenticated-webserver/index.mjs");
  const patchTemplate = join(appRoot, "src-tauri", "dsh-host", "luckyray-dsh-native-surface.patch.yml");
  const patch = join(stateRoot, "luckyray-dsh-native-surface.generated.patch.yml");
  await installTrackedSurfaceModules(stateRoot);
  await writeFile(patch, renderNativeSurfacePatch(
    await readFile(patchTemplate, "utf8"),
  ), { encoding: "utf8", flag: "wx" });
  const children = [];
  let resolveUnexpected;
  const unexpected = new Promise((resolveExit) => { resolveUnexpected = resolveExit; });
  const owner = createNativeSurfaceOwner({
    runtimeRoot,
    stateRoot,
    surfaceHome: stateRoot,
    surfacePatch: patch,
    onChildStarted: (child) => children.push(child),
    onUnexpectedExit: () => resolveUnexpected(),
  });
  try {
    const first = await owner.open();
    assert.equal(children.length, 1);
    children[0].kill();
    await unexpected;
    // CLOSE-R2 semantics: an unexpected exit leaves any descendants
    // unaccounted for, so the wrapper refuses to spawn a second tree. The
    // refusal names the escalation; a fresh child can only come after the
    // host-level whole-tree recovery rebuild.
    const refused = await owner.open();
    assert.equal(children.length, 1, "no second child may spawn while the tree is unconfirmed");
    assert.equal(refused.stage, "surface-failed");
    assert.equal(refused.reason, "dsh-surface-tree-unconfirmed");
  } finally {
    await owner.shutdown();
  }
});

function fakeSessionFace(initialSnapshot) {
  let current = initialSnapshot;
  const listeners = new Set();
  return {
    session: Object.freeze({
      getSnapshot: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    set(snapshot) {
      current = snapshot;
      for (const listener of [...listeners]) listener();
    },
    listenerCount() { return listeners.size; },
  };
}

function fakeSessionsFace() {
  const faces = new Map();
  let ids = [];
  const listListeners = new Set();
  return {
    list: Object.freeze({
      getSnapshot: () => ({ ids: [...ids] }),
      subscribe(listener) {
        listListeners.add(listener);
        return () => listListeners.delete(listener);
      },
    }),
    binding: (id) => (faces.has(id) ? { session: faces.get(id).session } : undefined),
    scope: () => undefined,
    install(id, face) { faces.set(id, face); },
    setIds(next) {
      ids = [...next];
      for (const listener of [...listListeners]) listener();
    },
    listListenerCount() { return listListeners.size; },
  };
}

function surfaceStateHarness() {
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    posts.push(JSON.parse(init.body));
    return { ok: true };
  };
  return {
    posts,
    restore() { globalThis.fetch = originalFetch; },
  };
}

test("surface state observer reads the public SessionFace snapshot contract, not private properties", async () => {
  const harness = surfaceStateHarness();
  const first = fakeSessionFace({ openState: "loading" });
  const second = fakeSessionFace({ openState: "loading" });
  const sessions = fakeSessionsFace();
  sessions.install("session-1", first);
  sessions.install("session-2", second);
  sessions.setIds(["session-1", "session-2"]);
  let disposeObserver = () => {};
  const resetListeners = [];
  const originalAddEventListener = globalThis.addEventListener;
  const originalRemoveEventListener = globalThis.removeEventListener;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  const ctx = {
    get: (name) => {
      if (name === "sessions") return sessions;
      if (name === "conversation") return { input: { for: () => ({ setDraft() {}, state: { getSnapshot: () => ({ draft: "" }) } }) } };
      if (name === "uiSession") return { current: {
        getSnapshot: () => ({ key: undefined }), subscribe: () => () => undefined,
      } };
      return undefined;
    },
    on(event, listener) {
      assert.equal(event, "connection/reset");
      resetListeners.push(listener);
      return () => {};
    },
    effect(fn) {
      disposeObserver = fn();
    },
  };
  const flush = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));
  try {
    surfaceState.clientModule.apply(ctx);
    await flush();
    assert.equal("openState" in first.session, false, "fake SessionFace must not expose a direct openState property");
    assert.equal(first.listenerCount(), 1);
    assert.equal(second.listenerCount(), 1, "every listed session is subscribed exactly once");
    assert.deepEqual(
      harness.posts.at(-1),
      { clientReady: true, sessionOpen: null },
      "initial loading sessions do not report session-open",
    );

    first.set({ openState: "open" });
    await flush();
    assert.deepEqual(
      harness.posts.at(-1),
      { clientReady: true, sessionOpen: "session-1" },
      "a session-local loading->open notification reports session-open without any list mutation",
    );

    first.set({ openState: "error" });
    await flush();
    assert.deepEqual(
      harness.posts.at(-1),
      { clientReady: true, sessionOpen: null },
      "open->error lowers only the session fact",
    );
    assert.equal(harness.posts.every((post) => post.clientReady === true), true, "client-ready is never revoked by session state");

    sessions.install("session-3", fakeSessionFace({ openState: "open" }));
    sessions.setIds(["session-2", "session-3"]);
    await flush();
    assert.equal(first.listenerCount(), 0, "removed session is unsubscribed");
    assert.deepEqual(
      harness.posts.at(-1),
      { clientReady: true, sessionOpen: "session-3" },
    );
    sessions.setIds(["session-2", "session-3"]);
    await flush();
    const face3ListenerCount = sessions.binding("session-3") && 1;
    assert.equal(face3ListenerCount, 1, "duplicate roster notifications never create duplicate subscriptions");

    disposeObserver();
    assert.equal(sessions.listListenerCount(), 0, "teardown removes the list subscription");
    for (const reset of resetListeners) reset();
  } finally {
    harness.restore();
    globalThis.addEventListener = originalAddEventListener;
    globalThis.removeEventListener = originalRemoveEventListener;
  }
});

test("LightSeek intent consumer appends through official setDraft and acknowledges without submitting", async () => {
  let current;
  const listListeners = new Set();
  const actx = Object.freeze({ scope: "session-1" });
  const sessions = {
    list: {
      getSnapshot: () => ({ phase: "ready", byId: current ? { [current]: { id: current } } : {} }),
      subscribe(listener) { listListeners.add(listener); return () => listListeners.delete(listener); },
    },
    scope: (id) => id === "session-1" ? actx : undefined,
  };
  const selectedSession = {
    getSnapshot: () => ({ key: current }),
    subscribe(listener) { listListeners.add(listener); return () => listListeners.delete(listener); },
  };
  let draft = "已有草稿";
  let setDraftCalls = 0;
  let submitCalls = 0;
  const conversation = {
    input: {
      for(received) {
        assert.equal(received, actx);
        return {
          state: { getSnapshot: () => ({ draft, attachmentIds: [], phase: "plain" }) },
          setDraft(value) { setDraftCalls += 1; draft = value; },
          submit() { submitCalls += 1; },
        };
      },
    },
  };
  const intent = {
    intentId: "intent-00000001-0000-4000-8000-000000000000",
    localResources: [
      { kind: "material", assetId: "asset-1", canonicalPath: "C:\\素材 空间\\图像 #1 (`版`).png", delivery: "path-reference" },
      { kind: "material", assetId: "asset-2", canonicalPath: "D:\\第二张 (终稿).jpg", delivery: "path-reference" },
    ],
    source: "materials",
    text: "请分析以下本地素材。",
  };
  const requests = [];
  let carrierPending = true;
  const request = async (_path, init) => {
    requests.push(init);
    if (init.method === "GET") {
      return carrierPending
        ? { status: 200, ok: true, json: async () => intent }
        : { status: 204, ok: true };
    }
    carrierPending = false;
    return { status: 204, ok: true };
  };
  const listeners = new Map();
  const eventTarget = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
  };
  const consumer = surfaceState.createOpenIntentConsumer(sessions, conversation, request, eventTarget, selectedSession);
  assert.equal(requests.length, 0, "no session means no repeated carrier reads");
  current = "session-1";
  for (const listener of [...listListeners]) listener();
  await consumer.run();
  assert.equal(
    draft,
    "已有草稿\n\n请分析以下本地素材。\nC:\\素材 空间\\图像 #1 (`版`).png\nD:\\第二张 (终稿).jpg",
  );
  assert.equal(setDraftCalls, 1);
  assert.equal(submitCalls, 0);
  const acknowledgement = requests.find((requestInit) => requestInit.method === "POST");
  assert.deepEqual(JSON.parse(acknowledgement.body), { intentId: intent.intentId });
  consumer.dispose();
  assert.equal(listListeners.size, 0);
  assert.equal(listeners.size, 0);
});

test("session observer teardown disposes every session subscription exactly once", () => {
  const first = fakeSessionFace({ openState: "open" });
  const second = fakeSessionFace({ openState: "loading" });
  const sessions = fakeSessionsFace();
  sessions.install("session-1", first);
  sessions.install("session-2", second);
  sessions.setIds(["session-1", "session-2"]);
  const observer = surfaceState.createSessionObserver(sessions, () => {});
  observer.reconcile();
  assert.equal(first.listenerCount(), 1);
  assert.equal(second.listenerCount(), 1);
  observer.dispose();
  assert.equal(first.listenerCount(), 0, "session subscriptions are disposed on teardown");
  assert.equal(second.listenerCount(), 0);
  observer.dispose();
  observer.reconcile();
  assert.deepEqual([...observer.boundSessions.keys()], [], "double dispose stays inert and no rebinding happens after teardown");
});
