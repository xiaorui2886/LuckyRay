import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createDshHostClient, createDshHostStartupPreloader, ensureDshHostReady,
  readDshHostStatusAfterOperations, runDshHostDiagnostic, type DshHostStatus,
} from "../src/core/services/dshHost.ts";
import { createDshPluginCompatClient } from "../src/core/services/dshPluginCompat.ts";
import {
  claimDshNativeSurfaceVisibility, createDshNativeSurfaceClient,
  resetDshNativeSurfaceInitialOpenSingleFlight, runDshNativeSurfaceInitialOpenSingleFlight,
} from "../src/core/services/dshNativeSurface.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const bounds = { x: 100, y: 50, width: 600, height: 400 };

// Deterministic transport seam reproducing the backend's real cold compat
// contract: it creates a recovery-only host, leaves Unavailable, and shares
// the try_lock operation authority with probe/retry/native open.
function transport() {
  let stage: DshHostStatus["stage"] = "bundled-verified";
  let busy = false, closed = false, opened = false, visible = false;
  let failProbe = false;
  const calls: string[] = [];
  const holds = new Map<string, Promise<void>>();
  const status = () => ({
    stage, latestProbePassed: stage === "probe-completed", hostReusable: stage === "probe-completed",
    canProbe: stage === "bundled-verified" || stage === "probe-completed",
    canRetry: stage === "unavailable", shuttingDown: stage === "shutting-down",
    retryAttempt: 0, durationMs: null, message: "fixture",
  });
  const invoke = async <T>(command: string): Promise<T> => {
    calls.push(command);
    if (command === "dsh_host_status") return status() as T;
    if (command === "dsh_native_surface_status") return { stage: opened ? "client-ready" : "closed" } as T;
    if (command === "dsh_native_surface_show") {
      if (!opened) throw Error("dsh-native-surface-not-open");
      visible = true; return undefined as T;
    }
    if (command === "dsh_native_surface_hide") { visible = false; return undefined as T; }
    if (busy) throw Error("dsh-host-action-busy");
    busy = true;
    try {
      if (command === "dsh_host_probe" || command === "dsh_host_retry") {
        const allowed = command === "dsh_host_retry" ? stage === "unavailable" : status().canProbe;
        if (!allowed) throw Error("dsh-host-action-not-allowed");
        stage = "starting";
        await holds.get(command);
        if (closed) { stage = "shutting-down"; throw Error("dsh-host-shutting-down"); }
        if (failProbe) { stage = "unavailable"; throw Error("dsh-host-unavailable"); }
        stage = "probe-completed";
        return status() as T;
      }
      await holds.get(command);
      if (closed) throw Error("dsh-host-shutting-down");
      if (command === "dsh_plugin_compat_status") {
        if (stage === "bundled-verified") stage = "unavailable";
        return { manifestValid: true, plugins: [], compatMode: false } as T;
      }
      if (command === "dsh_native_surface_open") {
        if (stage !== "probe-completed") throw Error("dsh-native-surface-not-ready");
        opened = true; visible = true;
        return { ready: true, stage: "client-ready" } as T;
      }
      if (command === "dsh_native_surface_close") { opened = false; visible = false; }
      return { ready: false, stage: "closed" } as T;
    } finally { busy = false; }
  };
  return {
    calls, holds, status,
    host: createDshHostClient(invoke), compat: createDshPluginCompatClient(invoke),
    surface: createDshNativeSurfaceClient(invoke),
    closeApp() { closed = true; stage = "shutting-down"; },
    failProbe(value: boolean) { failProbe = value; },
    visible: () => visible,
  };
}

test("reproducer: cold Settings compat before any app preload poisons ordinary AI entry", async () => {
  const f = transport();
  await f.compat.status();
  assert.equal(f.status().stage, "unavailable");
  await assert.rejects(ensureDshHostReady(f.host));
  assert.equal(f.calls.includes("dsh_host_probe"), false);
  assert.equal(f.calls.includes("dsh_host_retry"), false);
});

test("Settings-first shares pending app preload with direct AI and repeated retry clicks", async () => {
  const f = transport(), probe = deferred(), compatHold = deferred();
  f.holds.set("dsh_host_probe", probe.promise);
  f.holds.set("dsh_plugin_compat_status", compatHold.promise);
  const preload = createDshHostStartupPreloader(async () => f.host);
  const app = preload("main");
  assert.ok(app instanceof Promise, "boot returns without awaiting the engine");
  const settings = f.compat.status();
  const diagnosisStatus = readDshHostStatusAfterOperations(f.host);
  const ai = ensureDshHostReady(f.host);
  assert.equal(ai, app);
  assert.equal(ensureDshHostReady(f.host, "retry"), app);
  assert.equal(preload("main"), app, "repeated startup never launches again");
  await tick();
  assert.deepEqual(f.calls, ["dsh_host_status", "dsh_host_probe"]);
  probe.resolve();
  await app;
  const opening = f.surface.open(bounds);
  await tick();
  assert.equal(f.calls.includes("dsh_native_surface_open"), false, "open waits for compat's operation lock");
  compatHold.resolve();
  const [, observed] = await Promise.all([settings, diagnosisStatus, ai, opening]);
  assert.equal(observed.stage, "probe-completed", "Settings never freezes on an in-progress snapshot");
  assert.equal(f.status().stage, "probe-completed");
  assert.equal(f.calls.filter(x => x === "dsh_host_probe").length, 1);
  assert.equal(f.calls.filter(x => x === "dsh_host_retry").length, 0);
  assert.equal(f.visible(), true);
});

test("AI-first and rapid route returns reread truth without extra probes", async () => {
  const f = transport();
  const preload = createDshHostStartupPreloader(async () => f.host);
  await Promise.all([preload("main"), ensureDshHostReady(f.host)]);
  for (let visit = 0; visit < 5; visit += 1) {
    await f.compat.status();
    await ensureDshHostReady(f.host);
  }
  assert.equal(f.calls.filter(x => x === "dsh_host_probe").length, 1);
  assert.equal(f.calls.includes("dsh_host_retry"), false);
});

test("failed preload releases recovery and one explicit Retry joins behind pending compat", async () => {
  const f = transport(), inspect = deferred();
  f.failProbe(true);
  const preload = createDshHostStartupPreloader(async () => f.host);
  await assert.rejects(preload("main")!);
  f.holds.set("dsh_plugin_compat_status", inspect.promise);
  const recovery = f.compat.status();
  await tick();
  f.failProbe(false);
  const retry = ensureDshHostReady(f.host, "retry");
  assert.equal(ensureDshHostReady(f.host, "retry"), retry);
  assert.equal(ensureDshHostReady(f.host), retry);
  await tick();
  assert.equal(f.calls.includes("dsh_host_retry"), false);
  inspect.resolve();
  await Promise.all([recovery, retry]);
  assert.equal(f.calls.filter(x => x === "dsh_host_retry").length, 1);
  await assert.rejects(preload("main")!, "startup is one attempt, not a remount recovery loop");
  assert.equal(f.calls.filter(x => x === "dsh_host_probe").length, 1);
});

test("explicit Settings diagnostics serialize with preload and compat without deadlock", async () => {
  const f = transport(), firstProbe = deferred();
  f.holds.set("dsh_host_probe", firstProbe.promise);
  const startup = createDshHostStartupPreloader(async () => f.host)("main");
  const diagnostic = runDshHostDiagnostic(f.host, false);
  const compat = f.compat.status();
  await tick();
  firstProbe.resolve();
  await Promise.all([startup, diagnostic, compat]);
  assert.equal(f.calls.filter(x => x === "dsh_host_probe").length, 2, "one preload plus one explicitly requested diagnostic");
  assert.equal(f.status().stage, "probe-completed");
});

test("closing app during pending preload cannot publish ready or launch a replacement", async () => {
  const f = transport(), probe = deferred();
  f.holds.set("dsh_host_probe", probe.promise);
  const preload = createDshHostStartupPreloader(async () => f.host);
  const started = preload("main")!;
  await tick();
  f.closeApp(); probe.resolve();
  await assert.rejects(started);
  await assert.rejects(ensureDshHostReady(f.host, "retry"));
  assert.equal(f.status().stage, "shutting-down");
  assert.equal(f.calls.filter(x => x === "dsh_host_probe").length, 1);
  assert.equal(f.calls.includes("dsh_host_retry"), false);
});

test("route close while native open is queued settles hidden without a duplicate open", async () => {
  resetDshNativeSurfaceInitialOpenSingleFlight();
  const f = transport(), inspect = deferred();
  await createDshHostStartupPreloader(async () => f.host)("main");
  f.holds.set("dsh_plugin_compat_status", inspect.promise);
  const settings = f.compat.status();
  const visibility = claimDshNativeSurfaceVisibility();
  await assert.rejects(visibility.show(f.surface, bounds), /not-open/);
  const opening = runDshNativeSurfaceInitialOpenSingleFlight(() => f.surface.open(bounds));
  await tick();
  await visibility.hide(Promise.resolve(f.surface));
  inspect.resolve();
  await Promise.all([settings, opening]);
  assert.equal(await visibility.reconcileAfterOneShotOpen(), false);
  assert.equal(f.visible(), false);
  assert.equal(f.calls.filter(x => x === "dsh_native_surface_open").length, 1);
  resetDshNativeSurfaceInitialOpenSingleFlight();
});

test("browser, workspace children and unknown native identities never preload", async () => {
  let created = 0;
  const f = transport();
  const preload = createDshHostStartupPreloader(async () => { created += 1; return f.host; });
  for (const label of [null, "", "workspace-123", "dsh-native-surface-m1", "other", "Main"]) {
    assert.equal(preload(label), null);
  }
  assert.equal(created, 0);
  assert.deepEqual(f.calls, []);
  await preload("main");
  assert.equal(created, 1);
});

test("startup wiring reserves main preload before route imports without awaiting it", async () => {
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  const host = await readFile(new URL("../src/core/services/dshHost.ts", import.meta.url), "utf8");
  const preload = main.indexOf("void preloadDshBackgroundAtStartup(nativeWindowLabel)");
  assert.ok(preload > main.indexOf("nativeWorkspaceWindowRole(nativeWindowLabel)"));
  assert.ok(preload > main.indexOf("render(<WorkspaceWindow/>);return"));
  assert.ok(preload < main.indexOf('await import("./app/AppShell")'));
  assert.doesNotMatch(main, /await preloadDshBackgroundAtStartup/);
  assert.doesNotMatch(host, /setInterval|setTimeout|engine_update|download|native_surface_open/);
  assert.match(host, /if \(nativeWindowLabel !== "main"\) return null/);
});
