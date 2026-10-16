import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDshBackgroundPreloadCoordinator } from "../src/core/services/dshBackgroundPreload.ts";
import { createDshHostClient, createDshHostStartupPreloader } from "../src/core/services/dshHost.ts";
import { createDshPluginCompatClient } from "../src/core/services/dshPluginCompat.ts";
import {
  claimDshNativeSurfaceVisibility, createDshNativeSurfaceClient,
  deliverDshOpenIntent,
  resetDshNativeSurfaceInitialOpenSingleFlight, runDshNativeSurfaceInitialOpenSingleFlight,
} from "../src/core/services/dshNativeSurface.ts";

const bounds = { x: 230, y: 60, width: 900, height: 650 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Only native transport is simulated. All reservation, operation ordering,
// projection, failure latching and visibility leases are production services.
function fixture(enabled = true) {
  resetDshNativeSurfaceInitialOpenSingleFlight();
  const calls: string[] = [];
  const holds = new Map<string, Promise<void>>();
  let hostReady = false, shuttingDown = false, busy = false;
  let opened = false, visible = false, generation = 0, retired = 0;
  let failPreload = false, failReclaim = false;
  let surfaceStage = "closed";
  const hostStatus = () => ({
    stage: shuttingDown ? "shutting-down" : hostReady ? "probe-completed" : "bundled-verified",
    canProbe: !shuttingDown, canRetry: false, shuttingDown,
    latestProbePassed: hostReady && !shuttingDown, hostReusable: hostReady && !shuttingDown,
  });
  const surfaceStatus = () => ({ stage: surfaceStage, ready: surfaceStage === "client-ready" });
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(command);
    if (command === "dsh_host_status") return hostStatus() as T;
    if (command === "dsh_native_surface_status") return surfaceStatus() as T;
    if (command === "dsh_native_surface_hide") { visible = false; return undefined as T; }
    if (command === "dsh_native_surface_show") {
      if (!opened) throw Error("dsh-native-surface-not-open");
      if (surfaceStage === "unavailable") throw Error("dsh-native-surface-unavailable");
      visible = true; return undefined as T;
    }
    assert.equal(busy, false, `renderer must serialize ${command}`);
    busy = true;
    try {
      if (shuttingDown) throw Error("dsh-host-shutting-down");
      if (command === "dsh_host_probe") {
        await holds.get(command);
        if (shuttingDown) throw Error("dsh-host-shutting-down");
        hostReady = true; return hostStatus() as T;
      }
      if (command === "dsh_native_surface_preload" || command === "dsh_native_surface_open") {
        assert.equal(hostReady, true);
        if (command === "dsh_native_surface_preload") {
          assert.equal(args, undefined, "preload sends no bounds, prompt or model request");
          if (!enabled) return null as T;
        }
        assert.equal(opened, false, "one native generation at a time");
        opened = true; visible = false; generation += 1; surfaceStage = "webview-created";
        await holds.get(command);
        if (failPreload || shuttingDown) {
          opened = false; retired += 1; surfaceStage = "unavailable";
          throw Error(shuttingDown ? "dsh-host-shutting-down" : "dsh-surface-failed:surface-ready-timeout");
        }
        if (command === "dsh_native_surface_preload") surfaceStage = "client-ready";
        return surfaceStatus() as T;
      }
      await holds.get(command);
      if (command === "dsh_plugin_compat_reclaim_surface") {
        if (failReclaim) throw Error("dsh-native-surface-close-unsettled");
        // The real backend rechecks truth while holding its operation lock.
        if (surfaceStage === "unavailable") { opened = false; visible = false; retired += 1; }
        return undefined as T;
      }
      if (command === "dsh_plugin_compat_status") return { plugins: [], manifestValid: true } as T;
      throw Error(`unexpected command ${command}`);
    } finally { busy = false; }
  };
  const host = createDshHostClient(invoke), surface = createDshNativeSurfaceClient(invoke);
  const compat = createDshPluginCompatClient(invoke);
  const background = createDshBackgroundPreloadCoordinator(createDshHostStartupPreloader(async () => host), async () => surface);
  return { calls, holds, host, surface, compat, background,
    state: () => ({ opened, visible, generation, retired, surfaceStage }),
    fail() { failPreload = true; }, recover() { failPreload = false; },
    loseSurface() { surfaceStage = "unavailable"; },
    blockReclaim() { failReclaim = true; }, allowReclaim() { failReclaim = false; },
    shutdown() { shuttingDown = true; },
  };
}

test("Main startup reserves the sole initial-open flight and fully prepares one hidden child", async () => {
  const f = fixture(), probe = deferred(), ready = deferred();
  f.holds.set("dsh_host_probe", probe.promise);
  f.holds.set("dsh_native_surface_preload", ready.promise);
  const startup = f.background.start("main")!;
  let duplicateOpens = 0, finished = false;
  const sameInitial = runDshNativeSurfaceInitialOpenSingleFlight(async () => { duplicateOpens += 1; });
  const immediateEntry = f.background.readyForAttach(f.host, f.surface);
  void startup.then(() => { finished = true; });
  await tick();
  assert.deepEqual(f.calls, ["dsh_host_status", "dsh_host_probe"]);
  probe.resolve(); await tick();
  assert.equal(f.state().surfaceStage, "webview-created");
  assert.equal(finished, false, "native creation alone is never preload success");
  assert.equal(f.state().visible, false);
  const settings = f.compat.status();
  await tick();
  assert.equal(f.calls.includes("dsh_plugin_compat_status"), false, "compat waits for native preparation lock");
  ready.resolve();
  await Promise.all([startup, sameInitial, immediateEntry, settings]);
  assert.equal(duplicateOpens, 0);
  assert.equal(f.state().generation, 1);
  assert.equal(f.state().visible, false, "neither startup nor attach-readiness changes visibility");
  assert.equal(f.calls.filter(x => x === "dsh_host_probe").length, 1);
  assert.equal(f.calls.filter(x => x === "dsh_native_surface_preload").length, 1);
  assert.equal(f.calls.includes("dsh_native_surface_open"), false);
  assert.equal(f.calls.some(x => /open_intent|retry/u.test(x)), false);
  const lease = claimDshNativeSurfaceVisibility();
  assert.equal(await lease.show(f.surface, bounds), true);
  assert.equal(f.state().visible, true);
  await lease.hide(Promise.resolve(f.surface));
  await f.background.readyForAttach(f.host, f.surface);
  assert.equal(await claimDshNativeSurfaceVisibility().show(f.surface, bounds), true);
  assert.equal(f.state().generation, 1, "a later click reuses the prepared child");
  assert.equal(f.background.start("main"), startup);
});

test("queued user content is not staged when its route becomes hidden before native admission", async () => {
  const calls: string[] = [];
  const held = deferred();
  const invoke = async <T>(command: string): Promise<T> => {
    calls.push(command);
    if (command === "dsh_native_surface_preload") {
      await held.promise;
      return { stage: "client-ready", ready: true } as T;
    }
    throw Error(`unexpected command ${command}`);
  };
  const client = createDshNativeSurfaceClient(invoke);
  const pending = client.preload();
  let visible = true;
  const delivery = deliverDshOpenIntent(client, {
    intentId: "intent-00000009-0000-4000-8000-000000000000",
    localResources: [], source: "notes", text: "must remain pending",
  }, false, () => visible);
  const notStaged = assert.rejects(delivery, /dsh-open-intent-not-staged/u);
  visible = false;
  held.resolve();
  await Promise.all([pending, notStaged]);
  assert.deepEqual(calls, ["dsh_native_surface_preload"]);
});

test("native preload uses a hidden fixed-parent container and cancellable lifecycle barriers", async () => {
  const [native, rust, cargo, launcher] = await Promise.all([
    readFile(new URL("../src-tauri/src/dsh_native_container.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-luckyray-dev.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(cargo, /^default = \["sidecar-binaries"\]$/mu);
  assert.match(cargo, /^lsh-background-surface-preload = \["browser-host-runtime"\]$/mu);
  assert.match(launcher, /\[switch\]\$LshBackgroundPreload/u);
  assert.match(launcher, /if \(\$LshBackgroundPreload\) \{[\s\S]*?\$tauriArgs \+= @\("--features", "lsh-background-surface-preload"\)/u);
  assert.match(launcher, /& pnpm\.cmd @tauriArgs/u);
  assert.match(native, /WindowBuilder::new[\s\S]*?\.parent_raw\([\s\S]*?\.visible\(false\)[\s\S]*?\.focused\(false\)/u);
  for (const method of ["decorations", "resizable", "maximizable", "minimizable", "closable", "shadow"]) {
    assert.ok(native.includes(`.${method}(false)`), method);
  }
  assert.match(native, /verify_hidden\(&container_owned\)\?;[\s\S]*container\.add_child/u);
  assert.match(native, /GetAncestor\(hwnd, GA_PARENT\) == main_hwnd/u);
  assert.match(native, /GetWindowLongW\(hwnd, GWL_STYLE\) as u32 & WS_CHILD\.0/u);
  assert.match(native, /let child_position = webview\.position\(\)/u);
  assert.match(native, /let child_size = webview\.size\(\)/u);
  assert.doesNotMatch(native, /\.reparent\(|SetParent\(|WebviewWindowBuilder|\.set_focus\(/u);
  const reclaim = rust.slice(rust.indexOf("async fn dsh_plugin_compat_reclaim_surface"), rust.indexOf("async fn dsh_plugin_compat_apply"));
  assert.match(reclaim, /DSH_NATIVE_SURFACE_LIFECYCLE\.lock\(\)[\s\S]*reclaim_failed_native_surface_with/u);
  const preload = rust.slice(rust.indexOf("async fn dsh_native_surface_preload"), rust.indexOf("async fn dsh_native_surface_restart"));
  assert.match(preload, /native_surface_binding_matches/u);
  assert.match(preload, /status\.ready && matches!\(status\.stage/u);
  assert.match(preload, /retire_dsh_native_surface_child[\s\S]*settle_warm_existing_webview_close_failure/u);
  assert.match(preload, /if surface_host\.native_surface_binding_matches\(binding\.0, binding\.1\) \{\s*let _ = surface_host\.close_native_surface/u);
  const intent = rust.slice(rust.indexOf("async fn dsh_native_surface_open_intent("), rust.indexOf("async fn dsh_engine_update_status"));
  assert.match(intent, /spawn_blocking\(move \|\| \{[\s\S]*visible_for_intent[\s\S]*native_surface_binding_matches[\s\S]*owned\.stage_open_intent/u);
});

test("modal/route close while preparation is pending never exposes or replaces the child", async () => {
  for (const reason of ["modal", "route-away"]) {
    const f = fixture(), ready = deferred();
    f.holds.set("dsh_native_surface_preload", ready.promise);
    const startup = f.background.start("main")!;
    const old = claimDshNativeSurfaceVisibility();
    const entry = f.background.readyForAttach(f.host, f.surface).then(client => old.show(client, bounds));
    await tick();
    await old.hide(Promise.resolve(f.surface));
    ready.resolve();
    await startup;
    assert.equal(await entry, false, reason);
    assert.equal(f.state().visible, false, reason);
    assert.equal(f.calls.includes("dsh_native_surface_show"), false);
    assert.equal(f.state().generation, 1);
  }
});

test("failed startup stays latched across page entries; explicit Retry reclaims before one foreground open", async () => {
  const f = fixture(); f.fail();
  const failed = f.background.start("main")!;
  await assert.rejects(failed, /surface-ready-timeout/u);
  f.recover();
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(f.background.readyForAttach(f.host, f.surface), /surface-ready-timeout/u);
  }
  assert.equal(f.calls.filter(x => x === "dsh_native_surface_preload").length, 1);
  const retry = f.background.retry(() => f.compat.reclaimFailedSurface());
  assert.equal(f.background.retry(() => { throw Error("duplicate reclaim"); }), retry);
  await retry;
  const client = await f.background.readyForAttach(f.host, f.surface, "retry");
  const lease = claimDshNativeSurfaceVisibility();
  await assert.rejects(lease.show(client, bounds), /not-open/u);
  const open = runDshNativeSurfaceInitialOpenSingleFlight(() => client.open(bounds));
  assert.equal(runDshNativeSurfaceInitialOpenSingleFlight(() => { throw Error("duplicate open"); }), open);
  await open;
  assert.equal(f.state().visible, false, "explicit feature-enabled creation is also hidden");
  assert.equal(await lease.reconcileAfterOneShotOpen(), true);
  assert.equal(await lease.show(client, bounds), true);
  assert.equal(f.state().visible, true);
  assert.equal(f.state().generation, 2);
  assert.equal(f.calls.filter(x => x === "dsh_native_surface_open").length, 1);
  assert.ok(f.calls.indexOf("dsh_plugin_compat_reclaim_surface") < f.calls.indexOf("dsh_native_surface_open"));
  assert.equal(f.background.start("main"), null, "explicit recovery does not rerun app startup");
});

test("a preloaded child lost before first attachment requires recovery and never gets shown stale", async () => {
  const f = fixture();
  await f.background.start("main");
  f.loseSurface();
  await assert.rejects(f.background.readyForAttach(f.host, f.surface), /surface-unavailable/u);
  assert.equal(f.state().opened, true, "hidden failed child has not been mistaken for healthy readiness");
  assert.equal(f.calls.includes("dsh_native_surface_show"), false);
  f.blockReclaim();
  await assert.rejects(f.background.retry(() => f.compat.reclaimFailedSurface()), /close-unsettled/u);
  await assert.rejects(f.background.readyForAttach(f.host, f.surface), /surface-unavailable/u);
  f.allowReclaim();
  await f.background.retry(() => f.compat.reclaimFailedSurface());
  assert.equal(f.state().opened, false);
  await f.background.readyForAttach(f.host, f.surface, "retry");
  await runDshNativeSurfaceInitialOpenSingleFlight(() => f.surface.open(bounds));
  assert.equal(f.state().generation, 2);
});

test("authoritative retry reclaim never retires a healthy replacement", async () => {
  const f = fixture();
  await f.background.start("main");
  await f.background.retry(() => f.compat.reclaimFailedSurface());
  await f.background.readyForAttach(f.host, f.surface, "retry");
  await claimDshNativeSurfaceVisibility().show(f.surface, bounds);
  assert.equal(f.state().retired, 0);
  assert.equal(f.state().generation, 1);
});

test("exact default-null preserves host-only startup and first-page cold-open fallback", async () => {
  const f = fixture(false);
  assert.equal(await f.background.start("main"), null);
  assert.equal(f.state().generation, 0);
  await f.background.readyForAttach(f.host, f.surface);
  const lease = claimDshNativeSurfaceVisibility();
  await assert.rejects(lease.show(f.surface, bounds), /not-open/u);
  await runDshNativeSurfaceInitialOpenSingleFlight(() => f.surface.open(bounds));
  await lease.reconcileAfterOneShotOpen();
  await lease.show(f.surface, bounds);
  assert.equal(f.state().generation, 1);
  assert.equal(f.calls.filter(x => x === "dsh_host_probe").length, 1);
});

test("undefined, carrier-ready and webview-created preload results fail closed", async () => {
  for (const result of [undefined, {}, { ready: true, stage: "carrier-ready" }, { ready: true, stage: "webview-created" }]) {
    const surface = createDshNativeSurfaceClient(async <T>() => result as T);
    await assert.rejects(surface.preload(), /not-ready/u);
  }
  for (const stage of ["client-ready", "session-open"]) {
    const surface = createDshNativeSurfaceClient(async <T>() => ({ stage, ready: true }) as T);
    assert.equal((await surface.preload())?.stage, stage);
  }
});

test("shutdown during hidden preparation cannot publish readiness or open another generation", async () => {
  const f = fixture(), ready = deferred();
  f.holds.set("dsh_native_surface_preload", ready.promise);
  const startup = f.background.start("main")!;
  const rejected = assert.rejects(startup, /shutting-down/u);
  await tick();
  f.shutdown(); ready.resolve();
  await rejected;
  await assert.rejects(f.background.readyForAttach(f.host, f.surface), /shutting-down/u);
  assert.equal(f.state().visible, false);
  assert.equal(f.state().opened, false);
  assert.equal(f.state().generation, 1);
  assert.equal(f.calls.includes("dsh_native_surface_open"), false);
});

test("browser, workspace, native child and unknown roles never reserve or invoke preparation", async () => {
  const f = fixture();
  for (const role of [null, "", "workspace-123", "dsh-native-surface-m1", "unknown", "Main"]) {
    assert.equal(f.background.start(role), null);
  }
  assert.deepEqual(f.calls, []);
  await f.background.start("main");
  assert.equal(f.state().generation, 1);
});

test("page gates hidden content, reclaims before Retry, and shows cold creation using its current lease", async () => {
  const page = await readFile(new URL("../src/features/ai/DshNativeSurfacePage.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(!active \|\| !hasAttached \|\| restartingRef\.current\s*\|\| !activeVisibility\?\.isCurrentVisible\(\) \|\| !nativeSurfacesVisibleRef\.current\) return;/u);
  assert.match(page, /if \(!active \|\| restartingRef\.current \|\| !activeVisibility\?\.isCurrentVisible\(\)\s*\|\| !nativeSurfacesVisibleRef\.current\) return false;/u);
  assert.match(page, /if \(delivered\) completeOpenInLightSeekIntent/u);
  assert.match(page, /retryDshBackgroundPreload\(async \(\) => \{[\s\S]*?await compat\.reclaimFailedSurface\(\)/u);
  assert.match(page, /onClick=\{retrySurface\}/u);
  assert.match(page, /reconcileAfterOneShotOpen\(\)\)\) return false;[\s\S]*?return await visibility\.show\(client, boundsOf\(mount\)\)/u);
});

test("DPI-only changes resync bounds at every scale and the observer disposes cleanly", async () => {
  const { watchDshNativeSurfaceScaleChanges } = await import("../src/core/services/dshNativeSurface.ts");
  const queries: string[] = [];
  const listeners = new Set<() => void>();
  let updates = 0;
  const viewport = {
    devicePixelRatio: 1,
    matchMedia(query: string) {
      queries.push(query);
      return {
        addEventListener(_event: string, listener: () => void) { listeners.add(listener); },
        removeEventListener(_event: string, listener: () => void) { listeners.delete(listener); },
      } as unknown as MediaQueryList;
    },
  };
  const stop = watchDshNativeSurfaceScaleChanges(() => { updates += 1; }, viewport);
  for (const ratio of [1.25, 2, 1]) {
    viewport.devicePixelRatio = ratio;
    for (const listener of [...listeners]) listener();
    assert.equal(listeners.size, 1, "each scale replaces its old listener");
  }
  assert.deepEqual(queries, ["(resolution: 1dppx)", "(resolution: 1.25dppx)", "(resolution: 2dppx)", "(resolution: 1dppx)"]);
  assert.equal(updates, 3);
  stop(); assert.equal(listeners.size, 0);
  const page = await readFile(new URL("../src/features/ai/DshNativeSurfacePage.tsx", import.meta.url), "utf8");
  assert.match(page, /watchDshNativeSurfaceScaleChanges\(syncBounds\)/u);
  assert.match(page, /stopScaleWatch\?\.\(\)/u);
});
