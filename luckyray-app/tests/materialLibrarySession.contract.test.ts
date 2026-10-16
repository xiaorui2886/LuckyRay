import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MaterialLibrarySession, materialLibrarySession, writeMaterialLibraryPreference, type MaterialLibraryRegistry, type MaterialLibraryRequest, type MaterialLibraryTransport } from "../src/core/services/materialLibraryContext.ts";

const registry = (activeId = "A"): MaterialLibraryRegistry => ({ legacyId: "A", activeId, libraries: ["A", "B"].map(id => ({ id, name: id, rootPath: id === "A" ? null : "D:/B", storageMode: "managed", visible: true, state: "ready", version: 0, preferences: {} })) });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const view = "luckyray-materials-view-v1";
const sort = "luckyray-materials-sort-v1";
function preferenceFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const cache = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => { cache.set(key, value); },
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  const durable = registry();
  let nextRegistry: ReturnType<typeof deferred<MaterialLibraryRegistry>> | null = null;
  const writes: { id: string; value: Record<string, unknown>; response: ReturnType<typeof deferred<void>> }[] = [];
  const session = new MaterialLibrarySession(async <T,>(request: MaterialLibraryRequest) => {
    if (request.action.op === "select") { durable.activeId = request.libraryId!; return null as T; }
    if (request.action.op === "preferences") {
      const write = { id: request.libraryId!, value: structuredClone(request.action.value) as Record<string, unknown>, response: deferred<void>() };
      writes.push(write); await write.response.promise;
      durable.libraries.find(library => library.id === write.id)!.preferences = structuredClone(write.value);
      return null as T;
    }
    if (nextRegistry) { const pending = nextRegistry; nextRegistry = null; return await pending.promise as T; }
    return structuredClone({ ...durable, libraries: durable.libraries.filter(library => request.action.include_hidden || library.visible) }) as T;
  });
  return { session, durable, writes, cache, delayRegistry: () => { nextRegistry = deferred<MaterialLibraryRegistry>(); return nextRegistry; } };
}

test("late preference writes serialize per library, merge newer keys, and clean only the latest acknowledged batch", async t => {
  const { session, durable, writes, cache } = preferenceFixture(t); await session.initialize();
  session.writePreference(view, "grid", "A"); t.mock.timers.tick(220); await settle();
  session.writePreference(sort, "name", "A"); t.mock.timers.tick(220); await settle();
  assert.equal(writes.length, 1, "a second request cannot overtake the first in-flight save");
  writes[0].response.resolve(); await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].value, { [view]: "grid", [sort]: "name" });
  await session.refresh(); assert.equal(cache.get(`${sort}:A`), "name", "first ACK cannot clear a newer pending batch");
  writes[1].response.resolve(); await settle();
  assert.deepEqual(durable.libraries[0].preferences, { [view]: "grid", [sort]: "name" });
  durable.libraries[0].preferences[view] = "list"; await session.refresh();
  assert.equal(cache.get(`${view}:A`), "list", "completed queue no longer blocks registry authority");
  session.writePreference("luckyray-materials-zoom-v1", "90", "A"); t.mock.timers.tick(180); await settle();
  assert.deepEqual(writes[2].value, { [view]: "list", [sort]: "name", "luckyray-materials-zoom-v1": "90" });
  writes[2].response.resolve(); await settle();
});

test("a failed preference save stays dirty, reports failure, and retries all retained updates on the next change", async t => {
  const { session, durable, writes, cache } = preferenceFixture(t); durable.libraries[0].preferences[view] = "old";
  await session.initialize(); session.writePreference(view, "grid", "A"); t.mock.timers.tick(180); await settle();
  writes[0].response.reject(new Error("database locked")); await settle();
  assert.equal(durable.libraries[0].preferences[view], "old"); assert.match(session.getSnapshot().error!, /database locked/);
  await session.refresh(); assert.equal(cache.get(`${view}:A`), "grid"); assert.match(session.getSnapshot().error!, /重试/);
  session.writePreference(sort, "name", "A"); t.mock.timers.tick(180); await settle();
  assert.deepEqual(writes[1].value, { [view]: "grid", [sort]: "name" });
  writes[1].response.resolve(); await settle(); assert.equal(session.getSnapshot().error, null);
  assert.deepEqual(durable.libraries[0].preferences, writes[1].value);
});

test("newer changes queued during a failed save remain merged and run after that failure", async t => {
  const { session, durable, writes } = preferenceFixture(t); await session.initialize();
  session.writePreference(view, "grid", "A"); t.mock.timers.tick(180); await settle();
  session.writePreference(view, "list", "A"); session.writePreference(sort, "name", "A");
  t.mock.timers.tick(180); await settle(); assert.equal(writes.length, 1);
  writes[0].response.reject(new Error("first failed")); await settle();
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].value, { [view]: "list", [sort]: "name" });
  writes[1].response.resolve(); await settle(); assert.equal(session.getSnapshot().error, null);
  assert.deepEqual(durable.libraries[0].preferences, writes[1].value);
});

test("a blocked A preference write does not block B or change either frozen target", async t => {
  const { session, durable, writes } = preferenceFixture(t); await session.initialize();
  session.writePreference(view, "grid", "A"); t.mock.timers.tick(180); await settle();
  await session.select("B"); session.writePreference(view, "list"); t.mock.timers.tick(180); await settle();
  assert.deepEqual(writes.map(write => write.id), ["A", "B"]);
  writes[1].response.resolve(); await settle(); assert.equal(durable.libraries[1].preferences[view], "list");
  assert.deepEqual(durable.libraries[0].preferences, {});
  session.writePreference(sort, "name", "A"); t.mock.timers.tick(180); await settle();
  assert.equal(writes.length, 2);
  writes[0].response.resolve(); await settle(); assert.equal(writes[2].id, "A");
  writes[2].response.resolve(); await settle();
  assert.deepEqual(durable.libraries[0].preferences, { [view]: "grid", [sort]: "name" });
  assert.deepEqual(durable.libraries[1].preferences, { [view]: "list" });
});

test("a registry response begun before a preference ACK cannot restore the stale snapshot", async t => {
  const { session, durable, writes, cache, delayRegistry } = preferenceFixture(t); await session.initialize();
  session.writePreference(view, "grid", "A"); t.mock.timers.tick(180); await settle();
  const stale = delayRegistry();
  const old = structuredClone(durable); const refresh = session.refresh();
  writes[0].response.resolve(); await settle(); stale.resolve(old); await refresh;
  assert.equal(cache.get(`${view}:A`), "grid"); assert.equal(session.getSnapshot().registry!.libraries[0].preferences[view], "grid");
});

test("a frozen hidden-library preference target loads its authority instead of replacing unrelated keys", async t => {
  const { session, durable, writes } = preferenceFixture(t);
  durable.libraries[1].visible = false; durable.libraries[1].preferences = { [view]: "list", [sort]: "name" };
  await session.initialize(); assert.equal(session.getSnapshot().registry!.libraries.length, 1);
  session.writePreference("luckyray-material-watch-status-v1", "done", "B"); t.mock.timers.tick(180); await settle();
  assert.equal(writes[0].id, "B"); assert.deepEqual(writes[0].value, { [view]: "list", [sort]: "name", "luckyray-material-watch-status-v1": "done" });
  writes[0].response.resolve(); await settle();
  assert.equal(durable.libraries[1].visible, false); assert.equal(session.getSnapshot().libraryId, "A");
});

test("the exported preference helper uses the production native session save queue", async t => {
  preferenceFixture(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const writes: { value: Record<string, unknown>; response: ReturnType<typeof deferred<void>> }[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (_command: string, { request }: { request: MaterialLibraryRequest }) => {
      if (request.action.op === "registry") return registry();
      const write = { value: structuredClone(request.action.value) as Record<string, unknown>, response: deferred<void>() };
      writes.push(write); await write.response.promise; return null;
    },
  } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });
  await materialLibrarySession.initialize();
  writeMaterialLibraryPreference(view, "grid", "A"); t.mock.timers.tick(180); await settle();
  writeMaterialLibraryPreference(sort, "name", "A"); t.mock.timers.tick(180); await settle();
  assert.equal(writes.length, 1); writes[0].response.resolve(); await settle();
  assert.deepEqual(writes[1].value, { [view]: "grid", [sort]: "name" });
  writes[1].response.resolve(); await settle();
});

test("simultaneous startup consumers share one registry request", async () => {
  const response = deferred<MaterialLibraryRegistry>(); let reads = 0;
  const session = new MaterialLibrarySession(async <T,>() => { reads++; return await response.promise as T; });
  const app = session.initialize(); const page = session.initialize();
  assert.equal(reads, 1); response.resolve(registry()); await Promise.all([app, page]);
  assert.equal(session.getSnapshot().generation, 1);
});

test("an unavailable active root refreshes its physical state without falling back to another library", async () => {
  let offline = false;
  const session = new MaterialLibrarySession(async <T,>(request: MaterialLibraryRequest) => {
    if (request.action.op === "list") { offline = true; throw new Error("library-unavailable"); }
    const result = registry("B"); if (offline) result.libraries[1].state = "offline";
    return result as T;
  });
  await session.initialize(); await assert.rejects(session.request({ op: "list" }), /unavailable/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(session.getSnapshot().libraryId, "B");
  assert.equal(session.getSnapshot().registry?.libraries[1].state, "offline");
});

test("A→B→A invalidates the original A request and serializes the durable selection", async () => {
  const first = deferred<unknown>(); const writes: string[] = []; let active = "A";
  const transport: MaterialLibraryTransport = async <T,>(request: MaterialLibraryRequest) => {
    if (request.action.op === "select") { writes.push(request.libraryId!); if (writes.length === 1) await first.promise; active = request.libraryId!; return null as T; }
    return registry(active) as T;
  };
  const session = new MaterialLibrarySession(transport); await session.initialize(); const original = session.capture();
  const b = session.select("B"); const a = session.select("A");
  assert.equal(session.isCurrent(original), false); assert.equal(session.getSnapshot().status, "switching");
  first.resolve(null); await Promise.all([b, a]);
  assert.deepEqual(writes, ["B", "A"]); assert.equal(active, "A"); assert.equal(session.getSnapshot().libraryId, "A"); assert.equal(session.isCurrent(original), false);
});

test("a running import retains its captured library through picker IO and switching", async () => {
  const calls: MaterialLibraryRequest[] = [];
  let active = "A";
  const transport: MaterialLibraryTransport = async <T,>(request: MaterialLibraryRequest) => { calls.push(request); if (request.action.op === "select") active = request.libraryId!; return (request.action.op === "registry" ? registry(active) : null) as T; };
  const session = new MaterialLibrarySession(transport); await session.initialize(); const context = session.capture();
  const picker = deferred<string[]>(); const operation = picker.promise.then(paths => session.request({ op: "importPaths", paths }, context.libraryId));
  await session.select("B"); picker.resolve(["D:/source.png"]); await operation;
  assert.equal(calls.find(call => call.action.op === "importPaths")?.libraryId, "A"); assert.equal(session.getSnapshot().libraryId, "B");
});

test("a committed selection followed by registry failure keeps the durable identity and retries the read", async () => {
  let active = "A"; let fail = false; let selections = 0;
  const session = new MaterialLibrarySession(async <T,>(request: MaterialLibraryRequest) => {
    if (request.action.op === "select") { active = request.libraryId!; fail = true; selections++; return null as T; }
    if (fail) throw new Error("registry unavailable"); return registry(active) as T;
  });
  await session.initialize(); await assert.rejects(session.select("B"), /registry unavailable/);
  assert.equal(active, "B"); assert.equal(session.getSnapshot().libraryId, "B");
  assert.equal(session.getSnapshot().registry!.activeId, "B"); assert.equal(session.getSnapshot().status, "error");
  fail = false; await session.initialize();
  assert.equal(selections, 1); assert.equal(session.getSnapshot().status, "ready");
  assert.equal(session.getSnapshot().registry!.activeId, "B"); assert.equal(session.getSnapshot().error, null);
});

test("a superseded selection ACK remains authoritative when the newer queued selection fails", async () => {
  const first = deferred<void>(); let active = "A";
  const session = new MaterialLibrarySession(async <T,>(request: MaterialLibraryRequest) => {
    if (request.action.op === "select") {
      if (request.libraryId === "A") throw new Error("A offline");
      await first.promise; active = request.libraryId!; return null as T;
    }
    return registry(active) as T;
  });
  await session.initialize(); const b = session.select("B"); const a = session.select("A");
  const rejected = assert.rejects(a, /A offline/); first.resolve(); await b; await rejected;
  assert.equal(active, "B"); assert.equal(session.getSnapshot().libraryId, "B");
  assert.equal(session.getSnapshot().registry!.activeId, "B"); assert.equal(session.getSnapshot().status, "ready");
});

test("a refresh begun before the selection commit rereads instead of restoring the pre-commit activeId", async () => {
  const selection = deferred<void>(); const stale = deferred<MaterialLibraryRegistry>(); let active = "A"; let reads = 0;
  const session = new MaterialLibrarySession(async <T,>(request: MaterialLibraryRequest) => {
    if (request.action.op === "select") { await selection.promise; active = request.libraryId!; return null as T; }
    reads++; if (reads === 2) return await stale.promise as T;
    if (reads === 3) throw new Error("post-selection registry failed");
    return registry(active) as T;
  });
  await session.initialize(); const selected = session.select("B"); const failed = assert.rejects(selected, /post-selection/);
  const refresh = session.refresh(); selection.resolve(); await failed;
  assert.equal(session.getSnapshot().libraryId, "B");
  stale.resolve(registry("A")); await refresh;
  assert.equal(reads, 4, "the stale response triggers a fresh authority read");
  assert.equal(session.getSnapshot().libraryId, "B"); assert.equal(session.getSnapshot().registry!.activeId, "B");
  assert.equal(session.getSnapshot().status, "ready");
});

test("failed selection returns to the previous identity with an actionable error and a new generation", async () => {
  const session = new MaterialLibrarySession(async <T,>(request: MaterialLibraryRequest) => { if (request.action.op === "select") throw new Error("library-offline"); return registry() as T; });
  await session.initialize(); const original = session.capture(); await assert.rejects(session.select("B"), /offline/);
  assert.equal(session.getSnapshot().libraryId, "A"); assert.equal(session.getSnapshot().status, "ready"); assert.match(session.getSnapshot().error!, /offline/); assert.equal(session.isCurrent(original), false);
});

test("an old registry refresh cannot overwrite a newer selected-library registry", async () => {
  const stale = deferred<MaterialLibraryRegistry>(); let reads = 0; let active = "A";
  const session = new MaterialLibrarySession(async <T,>(request: MaterialLibraryRequest) => {
    if (request.action.op === "select") { active = request.libraryId!; return null as T; }
    return (++reads === 2 ? await stale.promise : registry(active)) as T;
  });
  await session.initialize(); const refresh = session.refresh(); await session.select("B"); stale.resolve(registry("A")); await refresh;
  assert.equal(session.getSnapshot().registry?.activeId, "B"); assert.equal(session.getSnapshot().libraryId, "B");
});
