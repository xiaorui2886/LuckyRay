/**
 * Test-only DSH 0.2.1-rc.2 module harness. The published Conversation and file
 * upload client factories are evaluated unchanged. The web shell is stopped
 * before its automatic application boot and its bundled static modules exposed.
 * Session projection/navigation and display-only registration are fixtures;
 * ConversationController, InputHub, SessionInputShell, Lexical, store, Cordis,
 * and FileUploadRuntime are the actual official implementations.
 * No submit, prompt, model, or external upload is performed by default.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

export const OFFICIAL_IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
});

export async function createOfficialAttachmentHarness(options = {}) {
  const runtimeNodeModules = resolve(options.runtimeNodeModules
    ?? process.env.DSH_OFFICIAL_NODE_MODULES
    ?? (process.env.DSH_M1_RUNTIME_ROOT ? join(process.env.DSH_M1_RUNTIME_ROOT, "host", "node_modules") : undefined)
    ?? "/workspace/scratch/754acb877f23/dsh-021-qualification-recovered/runtime-new-linux/host/node_modules");
  const jsdomModule = options.jsdomModule ?? process.env.DSH_TEST_JSDOM_MODULE
    ?? "/workspace/scratch/754acb877f23/r7-qa/node_modules/jsdom/lib/api.js";
  const { JSDOM } = await import(pathToFileURL(jsdomModule).href);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: options.baseUrl ?? "http://127.0.0.1/",
  });
  const originals = new Map();
  const install = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ["window", "document", "navigator", "MutationObserver", "Element", "HTMLElement", "Node", "localStorage", "getComputedStyle"])
    install(key, key === "window" ? dom.window : dom.window[key]);
  const restore = () => {
    dom.window.close();
    for (const [key, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  };

  let ctx;
  try {
    const scope = join(runtimeNodeModules, "@deepseek-ai");
    for (const name of ["dsh-client-ui-conversation", "dsh-client-file-upload", "dsh-web-frontend"]) {
      const metadata = JSON.parse(await readFile(join(scope, name, "package.json"), "utf8"));
      assert.equal(metadata.version, "0.2.1-rc.2", `${name} version`);
    }
    const assets = join(scope, "dsh-web-frontend", "dist", "assets");
    const assetNames = await readdir(assets);
    const entry = assetNames.find(name => /^index-.*\.js$/u.test(name));
    assert.ok(entry, "official web shell entry exists");
    let source = await readFile(join(assets, entry), "utf8");
    const stop = source.indexOf("const Ms=globalThis.dshDesktopBoot");
    assert.ok(stop > 0, "known 0.2.1-rc.2 automatic boot boundary");
    source = source.slice(0, stop).replaceAll(/"(\.\/vendor-[^"]+\.js)"/gu,
      (_match, relative) => JSON.stringify(pathToFileURL(join(assets, relative)).href));
    assert.match(source, /function SZ\(\)/u, "known 0.2.1-rc.2 static-module factory");
    const { staticModules } = await import(`data:text/javascript;base64,${Buffer.from(`${source};export const staticModules=SZ();`).toString("base64")}`);
    const factories = new Map();
    dom.window.__ModuleLoader__ = { load: ({ id, factory }) => factories.set(id, factory) };
    for (const name of ["dsh-client-ui-conversation", "dsh-client-file-upload"])
      vm.runInThisContext(await readFile(join(scope, name, "lib", "client.js"), "utf8"), { filename: `${name}/lib/client.js` });
    const modules = { ...staticModules };
    const requireOfficial = id => {
      if (Object.hasOwn(modules, id)) return modules[id];
      const factory = factories.get(id);
      assert.ok(factory, `official factory dependency available: ${id}`);
      return modules[id] = factory(requireOfficial);
    };
    const officialConversation = requireOfficial("@deepseek-ai/dsh-client-ui-conversation");
    const officialUploader = requireOfficial("@deepseek-ai/dsh-client-file-upload");
    const { Context } = staticModules["@deepseek-ai/cordis"];
    const { createSnapshotStore } = staticModules["@deepseek-ai/dsh-client-store"];
    const uploadedFiles = [];
    const forbiddenCalls = [];
    const failSubmission = (...args) => {
      forbiddenCalls.push(args);
      throw new Error("Qualification harness forbids submission/model actions");
    };
    install("__DSH_FILE_UPLOAD__", { fetch: async (path, init) => {
      const url = new URL(path, options.baseUrl ?? "http://127.0.0.1/");
      assert.equal(url.pathname, "/api/session/uploadFileBinary");
      assert.equal(init.method, "POST");
      assert.ok(init.body instanceof File, "official upload receives a real File");
      const capture = {
        sessionId: url.searchParams.get("sessionId"), name: url.searchParams.get("name"),
        type: init.body.type, size: init.body.size,
        bytes: Buffer.from(await init.body.arrayBuffer()), file: init.body,
        path, headers: init.headers,
      };
      uploadedFiles.push(capture);
      if (options.uploadFetch) return options.uploadFetch(path, init, capture);
      return Response.json({ ok: true, value: {
        receiptId: `receipt-${randomUUID()}`,
        file: { attachmentId: `attachment-${randomUUID()}`, name: capture.name, bytes: capture.size },
      } });
    } });
    ctx = new Context();
    const empty = createSnapshotStore(undefined);
    const selectedSession = createSnapshotStore({ key: options.sessionId ?? "qualification-session-one" });
    const bindings = new Map();
    const sessions = {
      list: createSnapshotStore({ phase: "ready", byId: {} }),
      scope: id => bindings.get(id)?.ctx,
      binding: id => bindings.get(id),
      sessionOf: actx => [...bindings.values()].find(binding => binding.ctx === actx)?.session,
    };
    const addSession = sessionId => {
      const actx = ctx.extend({});
      const imageLimits = createSnapshotStore(OFFICIAL_IMAGE_LIMITS);
      const session = {
        sessionId,
        projections: { faceOf: key => key === "imageLimits" ? imageLimits : empty },
        getSnapshot: () => ({ sessionId, blank: true, running: false }),
        prompt: failSubmission, beginSubmission: failSubmission,
      };
      const binding = { sessionId, session, ctx: actx };
      bindings.set(sessionId, binding);
      sessions.list.set({ phase: "ready", byId: Object.fromEntries([...bindings.keys()].map(id => [id, {}])) });
      return binding;
    };
    addSession(selectedSession.getSnapshot().key);
    addSession(options.otherSessionId ?? "qualification-session-two");
    const noop = () => {};
    const off = () => noop;
    // Presentation services are not rendered. Public apply still constructs
    // the actual InputHub and SessionInputShell used by the adapter.
    ctx.provide("sessions", sessions);
    ctx.provide("remote", {});
    ctx.provide("slots", { register: off, registerFactory: off, inject: off, entries: () => [], subscribe: off });
    ctx.provide("locale", { register: off, bind: () => key => key, subscribe: off });
    ctx.provide("configForms", { get: () => undefined, developerTools: { enabled: createSnapshotStore(false) } });
    ctx.provide("uiWorkspace", {});
    ctx.provide("uiSession", { provide: off, current: selectedSession });
    officialUploader.apply(ctx);
    officialConversation.apply(ctx, { maxConcurrentFileUploads: 2 });
    await new Promise(resolve => setImmediate(resolve));
    const conversation = ctx.get("conversation");
    assert.ok(conversation instanceof officialConversation.ConversationController);
    const inputFor = id => conversation.input.for(sessions.scope(id));
    const input = inputFor(selectedSession.getSnapshot().key);
    assert.equal(typeof input.addAttachments, "function");
    const waitForUploads = async () => {
      const deadline = Date.now() + (options.uploadTimeoutMs ?? 10000);
      while (Object.values(conversation.fileUploads.getSnapshot()).some(value => value.status === "uploading")) {
        if (Date.now() >= deadline) throw new Error("Official upload queue did not settle");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return conversation.fileUploads.getSnapshot();
    };
    return {
      ctx, dom, sessions, selectedSession, conversation, input, inputFor,
      uploadedFiles, forbiddenCalls, addSession, waitForUploads,
      boundary: options.uploadFetch ? "caller-supplied upload HTTP transport" : "synthetic upload receipt; real official upload and composer modules",
      versions: { conversation: "0.2.1-rc.2", uploader: "0.2.1-rc.2" },
      async dispose() { try { await ctx.fiber.dispose(); } finally { restore(); } },
    };
  } catch (error) {
    try { await ctx?.fiber.dispose(); } finally { restore(); }
    throw error;
  }
}
