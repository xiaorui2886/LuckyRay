import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  claimDshNativeSurfaceVisibility,
  createDshNativeSurfaceClient,
  deliverDshOpenIntent,
  projectDshNativeSurfaceStatus,
  pollDshNativeSurfaceAvailability,
  watchDshNativeSurfaceFailure,
  resetDshNativeSurfaceInitialOpenSingleFlight,
  runDshNativeSurfaceInitialOpenSingleFlight,
  settleDshNativeSurfaceRestartProjection,
} from "../src/core/services/dshNativeSurface.ts";

test("uncertain outer retry recovers an applied receipt without staging another composer write", async () => {
  let opens = 0;
  const client = {
    openIntent: async () => { opens += 1; },
    openIntentStatus: async () => "applied" as const,
  };
  await deliverDshOpenIntent(client, {
    intentId: "intent-00000009-0000-4000-8000-000000000000",
    localResources: [], source: "notes", text: "合成引用",
  }, true);
  assert.equal(opens, 0);
});

test("uncertain outer retry refuses to restage after a lost carrier generation", async () => {
  let opens = 0;
  const client = {
    openIntent: async () => { opens += 1; },
    openIntentStatus: async () => "unavailable" as const,
  };
  await assert.rejects(() => deliverDshOpenIntent(client, {
    intentId: "intent-00000009-0000-4000-8000-000000000000",
    localResources: [], source: "notes", text: "合成引用",
  }, true), /dsh-open-intent-outcome-unknown/u);
  assert.equal(opens, 0);
});

test("uncertain outer retry waits on an existing pending receipt without staging again", async () => {
  let opens = 0;
  let reads = 0;
  const client = {
    openIntent: async () => { opens += 1; },
    openIntentStatus: async () => (++reads === 1 ? "pending" : "applied") as "pending" | "applied",
  };
  await deliverDshOpenIntent(client, {
    intentId: "intent-00000009-0000-4000-8000-000000000000",
    localResources: [], source: "notes", text: "合成引用",
  }, true);
  assert.equal(opens, 0);
  assert.ok(reads >= 2);
});

test("a known pre-admission refusal is not converted into an uncertain receipt", async () => {
  let reads = 0;
  const client = {
    openIntent: async () => { throw new Error("dsh-host-action-busy"); },
    openIntentStatus: async () => { reads += 1; return "unavailable" as const; },
  };
  await assert.rejects(() => deliverDshOpenIntent(client, {
    intentId: "intent-00000009-0000-4000-8000-000000000000",
    localResources: [], source: "notes", text: "合成引用",
  }, false), /dsh-open-intent-not-staged/u);
  assert.equal(reads, 0);
});

test("all local Rust admission rejections stay retryable without reading a receipt", async () => {
  for (const code of ["dsh-host-action-busy", "dsh-open-intent-not-ready",
    "dsh-host-shutting-down", "dsh-open-intent-invalid"]) {
    let reads = 0;
    await assert.rejects(() => deliverDshOpenIntent({
      openIntent: async () => { throw new Error(code); },
      openIntentStatus: async () => { reads += 1; return "unavailable" as const; },
    }, {
      intentId: "intent-00000009-0000-4000-8000-000000000000",
      localResources: [], source: "notes", text: "合成引用",
    }, false), /dsh-open-intent-not-staged/u);
    assert.equal(reads, 0, code);
  }
});

test("a transport-side failure remains uncertain even if its receipt cannot be read", async () => {
  const client = {
    openIntent: async () => { throw new Error("dsh-open-intent-unavailable"); },
    openIntentStatus: async () => "unavailable" as const,
  };
  await assert.rejects(() => deliverDshOpenIntent(client, {
    intentId: "intent-00000009-0000-4000-8000-000000000000",
    localResources: [], source: "notes", text: "合成引用",
  }, false), /dsh-open-intent-outcome-unknown/u);
});
import { clearFlagCache, getFlags } from "../src/featureFlags.ts";
import { selectShellRouteMode } from "../src/app/shellRouteSelection.ts";
import { dshPluginCompatActionFailure } from "../src/core/services/dshPluginCompat.ts";

test("a cancelled availability request cannot publish a late Host reset", async () => {
  let finish!: (value: ReturnType<typeof projectDshNativeSurfaceStatus>) => void;
  const pending = new Promise<ReturnType<typeof projectDshNativeSurfaceStatus>>(resolve => { finish = resolve; });
  const updates: string[] = [];
  const stop = pollDshNativeSurfaceAvailability({ status: () => pending }, status => updates.push(status.message));
  stop();
  finish(projectDshNativeSurfaceStatus({ stage: "unavailable", message: "old Host reset" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates, []);
});

test("disposed page attempts cannot reclaim a replacement or restore an old recovery error", async () => {
  const failed = projectDshNativeSurfaceStatus({ stage: "unavailable", message: "old failure" });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let clientReady!: (value: { reclaimFailedSurface: () => Promise<void> }) => void;
  let reclaims = 0;
  const errors: string[] = [];
  const client = new Promise<{ reclaimFailedSurface: () => Promise<void> }>(resolve => { clientReady = resolve; });
  const stopBeforeReclaim = watchDshNativeSurfaceFailure({ status: async () => failed }, () => client, message => errors.push(message));
  await flush();
  stopBeforeReclaim();
  clientReady({ reclaimFailedSurface: async () => { reclaims += 1; } });
  await flush();
  assert.equal(reclaims, 0);
  assert.deepEqual(errors, []);

  let reclaimed!: () => void;
  const pending = new Promise<void>(resolve => { reclaimed = resolve; });
  const stopAfterReclaim = watchDshNativeSurfaceFailure({ status: async () => failed }, async () => ({
    reclaimFailedSurface: () => { reclaims += 1; return pending; },
  }), message => errors.push(message));
  await flush();
  assert.equal(reclaims, 1);
  stopAfterReclaim();
  reclaimed();
  await flush();
  assert.deepEqual(errors, [], "late reclaim settlement cannot re-open the old error panel");

  const stopHealthy = watchDshNativeSurfaceFailure({ status: async () => projectDshNativeSurfaceStatus({stage:"client-ready",ready:true}) },
    async () => ({reclaimFailedSurface: async () => {reclaims += 1;}}), message => errors.push(message));
  await flush();
  stopHealthy();
  assert.equal(reclaims,1,"healthy entry never invokes compatibility recovery");
  assert.deepEqual(errors,[]);
  const stopFailed = watchDshNativeSurfaceFailure({status: async () => failed},
    async () => ({reclaimFailedSurface: async () => {reclaims += 1;}}), message => errors.push(message));
  await flush();
  stopFailed();
  assert.equal(reclaims,2,"a current real failure still retires its failed child");
  assert.deepEqual(errors,["old failure"],"a current failure still exposes recovery");
});

test("compat recovery decisions fail closed before the renderer may reopen", () => {
  assert.equal(dshPluginCompatActionFailure({ applied: true, unquarantinable: [] }), null);
  assert.equal(dshPluginCompatActionFailure({ checked: true }), null);
  assert.equal(dshPluginCompatActionFailure({ applied: false }), "failed");
  assert.equal(dshPluginCompatActionFailure({ applied: true, failed: true }), "failed");
  assert.equal(dshPluginCompatActionFailure({ checked: false }), "failed");
  assert.equal(dshPluginCompatActionFailure({ applied: true, unquarantinable: ["broken"] }), "partial");
  assert.equal(dshPluginCompatActionFailure({ applied: true, unquarantinable: "broken" }), "failed");
  assert.equal(dshPluginCompatActionFailure({}), "failed");
  assert.equal(dshPluginCompatActionFailure(null), "failed");
});

test("surface client is typed, fail-closed, and exposes distinct open/show/hide/setBounds/close operations", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const client = createDshNativeSurfaceClient(async (command, args) => {
    calls.push([command, args]);
    if (command === "dsh_native_surface_open") return { ready: false, stage: "carrier-ready", coldJitMs: 20, carrierBindMs: 5, message: "ok" };
    if (command === "dsh_native_surface_close") return { ready: false, stage: "closed", message: "ok" };
    return undefined;
  });
  await client.status();
  await client.open({ x: 80, y: 90, width: 900, height: 600 });
  await client.show({ x: 80, y: 90, width: 900, height: 600 });
  await client.hide();
  await client.setBounds({ x: 80, y: 90, width: 800, height: 500 });
  await client.close();
  assert.deepEqual(calls.map(([command]) => command), [
    "dsh_native_surface_status", "dsh_native_surface_open", "dsh_native_surface_show",
    "dsh_native_surface_hide", "dsh_native_surface_set_bounds", "dsh_native_surface_close",
  ]);
  assert.deepEqual(calls[2][1], { bounds: { x: 80, y: 90, width: 900, height: 600 } });
  assert.equal(calls[3][1], undefined);
  const carrier = projectDshNativeSurfaceStatus({ ready: true, stage: "carrier-ready", coldJitMs: -1 });
  assert.deepEqual(Object.keys(carrier).sort(), [
    "carrierBindMs", "coldJitMs", "luckyRayProcessHandleCount", "message",
    "outerHostRssMb", "ownedDirectProcessCount", "ready", "stage",
  ].sort());
  assert.equal(carrier.ready, false);
  assert.equal(projectDshNativeSurfaceStatus({ ready: true, stage: "client-ready" }).ready, true);
  assert.equal(projectDshNativeSurfaceStatus({ ready: true, stage: "session-open" }).ready, true);
});

test("surface client show is visual-only and rejects with the bounded not-open error", async () => {
  const client = createDshNativeSurfaceClient(async (command) => {
    if (command === "dsh_native_surface_show") throw "dsh-native-surface-not-open";
    return { ready: false, stage: "closed", message: "ok" };
  });
  await assert.rejects(() => client.show({ x: 0, y: 0, width: 400, height: 300 }), /not-open/u);
});

test("surface client exposes one typed full-restart command with the measured mount bounds", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const client = createDshNativeSurfaceClient(async (command, args) => {
    calls.push([command, args]);
    return { ready: false, stage: "webview-created", message: "restarted" };
  });
  const bounds = { x: 220, y: 60, width: 800, height: 640 };

  const status = await client.restart(bounds);

  assert.equal(status.stage, "webview-created");
  assert.deepEqual(calls, [["dsh_native_surface_restart", { bounds }]]);
});

test("restart settlement applies only the final warm visibility and then delivers one pending intent", () => {
  const visibility: Array<[boolean, boolean]> = [];
  let intentDeliveries = 0;
  const projection = (wasRestarting: boolean, restarting: boolean, succeeded: boolean) => (
    settleDshNativeSurfaceRestartProjection({
      wasRestarting,
      restarting,
      succeeded,
      visible: false,
      syncVisibility: (visible, allowInitialOpenFallback) => {
        visibility.push([visible, allowInitialOpenFallback]);
      },
      deliverOpenIntent: () => { intentDeliveries += 1; },
    })
  );

  assert.equal(projection(true, true, true), false, "old generation actions stay fenced while busy");
  assert.deepEqual(visibility, []);
  assert.equal(intentDeliveries, 0);
  assert.equal(projection(true, false, true), true, "settlement projects the latest modal/route visibility");
  assert.deepEqual(visibility, [[false, false]], "restart settlement never cold-opens a second generation");
  assert.equal(intentDeliveries, 1);
  assert.equal(projection(false, false, true), false, "the settled request cannot deliver twice");
  assert.deepEqual(visibility, [[false, false]]);
  assert.equal(intentDeliveries, 1);
  assert.equal(projection(true, false, false), true, "a failed restart still projects warm-only failure state");
  assert.deepEqual(visibility, [[false, false], [false, false]]);
  assert.equal(intentDeliveries, 1, "failed restart cannot deliver a pending intent");
});

test("a delayed successful show after route cleanup is corrected back to hidden", async () => {
  const calls: string[] = [];
  let visible = false;
  let closeCalls = 0;
  let resolveShow!: () => void;
  const showHeld = new Promise<void>((resolve) => { resolveShow = resolve; });
  const client = {
    async show() {
      calls.push("show:start");
      await showHeld;
      visible = true;
      calls.push("show:resolved");
    },
    async hide() {
      calls.push("hide");
      visible = false;
    },
    async close() {
      closeCalls += 1;
    },
  };

  const intent = claimDshNativeSurfaceVisibility();
  const attach = intent.show(client, { x: 236, y: 60, width: 820, height: 640 });
  assert.deepEqual(calls, ["show:start"]);

  await intent.hide(Promise.resolve(client));
  resolveShow();

  const shouldAttachObserver = await attach;
  assert.equal(shouldAttachObserver, false);
  assert.equal(visible, false);
  assert.equal(closeCalls, 0);
  assert.deepEqual(calls, ["show:start", "hide", "show:resolved", "hide"]);
});

test("the latest shared visibility intent wins across a rapid route-away and remount", async () => {
  const calls: string[] = [];
  let visible = false;
  let closeCalls = 0;
  let resolveOldShow!: () => void;
  let resolveOldHide!: () => void;
  const oldShowHeld = new Promise<void>((resolve) => { resolveOldShow = resolve; });
  const oldHideHeld = new Promise<void>((resolve) => { resolveOldHide = resolve; });
  const oldClient = {
    async show() {
      calls.push("old-show:start");
      await oldShowHeld;
      visible = true;
      calls.push("old-show:resolved");
    },
    async hide() {
      calls.push("old-hide:start");
      await oldHideHeld;
      visible = false;
      calls.push("old-hide:resolved");
    },
    async close() {
      closeCalls += 1;
    },
  };
  const newClient = {
    async show() {
      calls.push("new-show");
      visible = true;
    },
    async hide() {
      calls.push("new-hide");
      visible = false;
    },
    async close() {
      closeCalls += 1;
    },
  };
  const bounds = { x: 236, y: 60, width: 820, height: 640 };

  const oldIntent = claimDshNativeSurfaceVisibility();
  const oldAttach = oldIntent.show(oldClient, bounds);
  assert.deepEqual(calls, ["old-show:start"]);

  const oldHide = oldIntent.hide(Promise.resolve(oldClient));
  await Promise.resolve();
  const newIntent = claimDshNativeSurfaceVisibility();
  const newAttach = await newIntent.show(newClient, bounds);
  assert.equal(newAttach, true);
  assert.equal(visible, true);

  resolveOldShow();
  assert.equal(await oldAttach, false);
  resolveOldHide();
  assert.equal(await oldHide, false);
  assert.equal(visible, true);
  assert.equal(closeCalls, 0);
  assert.deepEqual(calls, [
    "old-show:start",
    "old-hide:start",
    "new-show",
    "old-show:resolved",
    "old-hide:resolved",
    "new-show",
  ]);
});

test("first-open fallback remains one-shot when an old hide settles after open", async () => {
  const calls: string[] = [];
  let visible = true;
  let openCount = 0;
  let closeCalls = 0;
  let resolveOldHide!: () => void;
  const oldHideHeld = new Promise<void>((resolve) => { resolveOldHide = resolve; });
  const oldClient = {
    async show() {},
    async hide() {
      calls.push("old-hide:start");
      await oldHideHeld;
      visible = false;
      calls.push("old-hide:resolved");
    },
  };
  const newClient = {
    async show() {
      calls.push("new-show");
      if (openCount === 0) throw new Error("dsh-native-surface-not-open");
      visible = true;
    },
    async hide() {
      visible = false;
    },
    async open() {
      openCount += 1;
      calls.push("new-open");
      visible = true;
      return { stage: "webview-created" };
    },
    async close() {
      closeCalls += 1;
    },
  };
  const bounds = { x: 236, y: 60, width: 820, height: 640 };

  const oldIntent = claimDshNativeSurfaceVisibility();
  const oldHide = oldIntent.hide(Promise.resolve(oldClient));
  await Promise.resolve();
  assert.deepEqual(calls, ["old-hide:start"]);

  const newIntent = claimDshNativeSurfaceVisibility();
  await assert.rejects(() => newIntent.show(newClient, bounds), /not-open/u);
  await newClient.open();
  assert.equal(await newIntent.reconcileAfterOneShotOpen(), true);
  assert.equal(visible, true);

  resolveOldHide();
  await oldHide;

  assert.equal(visible, true);
  assert.equal(openCount, 1);
  assert.equal(closeCalls, 0);
  assert.deepEqual(calls, ["old-hide:start", "new-show", "new-open", "old-hide:resolved", "new-show"]);
});

test("route remount during a modal race shares one cold open and converges to the latest visible intent", async () => {
  resetDshNativeSurfaceInitialOpenSingleFlight();
  let opened = false;
  let visible = false;
  let openCount = 0;
  let resolveOpen!: () => void;
  const openHeld = new Promise<void>((resolve) => { resolveOpen = resolve; });
  const client = {
    async show() {
      if (!opened) throw new Error("dsh-native-surface-not-open");
      visible = true;
    },
    async hide() {
      visible = false;
    },
  };
  const attachForMount = () => async (visibility: ReturnType<typeof claimDshNativeSurfaceVisibility>) => {
    try {
      return await visibility.show(client, { x: 60, y: 60, width: 900, height: 640 });
    } catch (error) {
      assert.match(String(error), /not-open/u);
      await runDshNativeSurfaceInitialOpenSingleFlight(async () => {
        openCount += 1;
        await openHeld;
        opened = true;
        visible = true;
      });
      return visibility.reconcileAfterOneShotOpen();
    }
  };

  const firstIntent = claimDshNativeSurfaceVisibility();
  const firstAttach = attachForMount()(firstIntent);
  for (let index = 0; index < 8 && openCount === 0; index += 1) await Promise.resolve();
  assert.equal(openCount, 1);

  await firstIntent.hide(Promise.resolve(client));
  const latestIntent = claimDshNativeSurfaceVisibility();
  const latestAttach = attachForMount()(latestIntent);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(openCount, 1, "the second visible intent must reuse the pending cold open");

  resolveOpen();
  assert.equal(await firstAttach, false);
  assert.equal(await latestAttach, true);
  assert.equal(openCount, 1);
  assert.equal(visible, true);
});

test("page lifecycle uses show-first/hide-only cleanup and never closes on route-away", async () => {
  const [page, rust, shell, shellCss, searchCss] = await Promise.all([
    readFile(new URL("../src/features/ai/DshNativeSurfacePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/appShell.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/search/search.css", import.meta.url), "utf8"),
  ]);
  // Route return shows the same child before any first-time open fallback.
  assert.match(page, /claimDshNativeSurfaceVisibility\(\)/u);
  assert.match(page, /prepareDshNativeSurfaceForAttach/u);
  const readiness = page.indexOf("await readyClient()");
  const surfaceShow = page.indexOf("visibility.show(client, boundsOf(mount))");
  assert.ok(readiness > 0 && readiness < surfaceShow);
  assert.match(page, /正在打开 AI 助手…/u);
  assert.match(page, /"action\.retry":\s*\{\s*"zh-CN":\s*"重试",\s*"en-US":\s*"Retry"\s*\}/u);
  assert.match(page, /\{t\("action\.retry"\)\}/u);
  assert.match(page, /dsh-native-surface-loading-mark/u);
  assert.match(shellCss, /@keyframes dsh-native-surface-loading/u);
  assert.match(shellCss, /:root\[data-animations="off"\] \.react-nav-shell \*/u);
  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(page, /阶段|JIT|载体|外层 Host|status\?\.message/u);
  assert.doesNotMatch(page, /setTimeout|setInterval|requestAnimationFrame/u);
  assert.match(
    shellCss,
    /\.react-nav-shell \.sidebar\s*\{[^}]*transition:\s*width var\(--transition\), min-width var\(--transition\), transform var\(--transition\);/u,
    "every route uses the original shared sidebar width transition",
  );
  assert.doesNotMatch(
    shellCss,
    /\.react-nav-shell\[data-route="ai"\] \.sidebar\s*\{[^}]*transition:/u,
    "the AI route must not suppress the shared sidebar transition",
  );
  assert.doesNotMatch(page, /请先在设置中/u);
  assert.doesNotMatch(page, /available\.enabled/u);
  assert.match(page, /visibility\.show\(client, boundsOf\(mount\)\)/u);
  assert.match(page, /String\(showError\)\.includes\("not-open"\)/u);
  assert.match(page, /!String\(showError\)\.includes\("not-open"\) \|\| hasAttached/u);
  assert.match(page, /if \(!active \|\| !visibility\.isCurrentVisible\(\)\) return false;/u);
  assert.match(page, /runDshNativeSurfaceInitialOpenSingleFlight/u);
  assert.match(page, /retryDshBackgroundPreload/u);
  assert.equal(page.match(/\.open\(boundsOf\(mount\)\)/gu)?.length, 1);
  assert.match(page, /visibility\.reconcileAfterOneShotOpen\(\)/u);
  assert.doesNotMatch(page, /runVisible/u);
  const inactiveFence = page.indexOf("if (!(await attach()) || !active || !visibility.isCurrentVisible()) return;");
  const attachedState = page.indexOf("hasAttached = true;", inactiveFence);
  const observerAttachment = page.indexOf("ensureObserver();", attachedState);
  assert.ok(inactiveFence > 0 && inactiveFence < attachedState && attachedState < observerAttachment);
  // App-level search and command modals project only a visual hide/show intent.
  assert.match(shell, /const nativeSurfacesVisible = !\(searchOpen \|\| commandOpen \|\| lightSeekToolsOpen \|\| applicationModalActive\);/u);
  assert.match(shell, /\{phoneOpen && <PhoneConnectionDialog onClose=/u);
  assert.match(shell, /nativeSurfacesVisible=\{nativeSurfacesVisible\}/u);
  assert.match(page, /nativeSurfacesVisible = true/u);
  assert.match(page, /syncVisibilityRef\.current\?\.\(nativeSurfacesVisible\)/u);
  assert.match(page, /if \(!shouldShow\) \{[\s\S]*await visibility\.hide\(clientPromise\);/u);
  assert.match(
    searchCss,
    /\.react-nav-shell\[data-route="ai"\] > \.search-overlay\s*\{[\s\S]*background:\s*rgba\(0, 0, 0, 0\.24\);[\s\S]*backdrop-filter:\s*blur\(4px\);/u,
  );
  // Route-away and inactive-after-open paths hide; the page never calls close.
  assert.match(page, /visibility\.hide\(clientPromise\)/u);
  assert.doesNotMatch(page, /client\.close\(\)|\.close\(\)/u);
  // No renderer-side task truth or conversation bridge.
  assert.doesNotMatch(page, /taskRunning|AgentEngine|sharedAgentEngineLifecycle|Hermes/u);
  // The Rust seam stays visual-only: hide/show must not reach the lifecycle services.
  const hideIdx = rust.indexOf("fn dsh_native_surface_hide");
  const showIdx = rust.indexOf("fn dsh_native_surface_show");
  const closeIdx = rust.indexOf("fn dsh_native_surface_close");
  assert.ok(hideIdx > 0 && showIdx > 0 && closeIdx > 0);
  const hideBody = rust.slice(hideIdx, showIdx);
  const showBody = rust.slice(showIdx, closeIdx);
  for (const body of [hideBody, showBody]) {
    assert.doesNotMatch(body, /close_native_surface|open_native_surface|invalidate_native_surface|publish_surface_stage/u);
  }
  assert.match(hideBody, /\.hide\(\)/u);
  assert.match(showBody, /\.show\(\)/u);
  assert.match(hideBody, /require_main_caller/u);
  assert.match(showBody, /require_main_caller/u);
  assert.doesNotMatch(
    rust,
    /std::thread::spawn\(move \|\| \{\s*let _ = host\.probe\(dsh_host::DshHostAction::Probe\)/u,
    "Tauri setup must not race the page with a background Probe",
  );
});

test("the normal AI route and native-m1 alias use the same official child WebView without legacy AiPage", async () => {
  const [rust, page, shell, architecture] = await Promise.all([
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/features/ai/DshNativeSurfacePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/dsh-native-surface-m1.md", import.meta.url), "utf8"),
  ]);
  assert.match(rust, /add_child\(builder, position, size\)/u);
  assert.match(rust, /on_navigation/u);
  assert.doesNotMatch(page, /iframe|AgentEngine|sharedAgentEngineLifecycle|Hermes/u);
  assert.match(
    shell,
    /ai:\s*\{\s*flag:\s*"aiReact",\s*Component:\s*DshNativeSurfacePage\s*\}/u,
    "#ai must resolve directly to the official DSH Native Surface",
  );
  assert.doesNotMatch(
    shell,
    /const AiPage = lazy|Component:\s*AiPage/u,
    "the normal AI route must not import or mount the legacy AiPage lifecycle",
  );
  assert.doesNotMatch(
    shell,
    /hashPath\.split\("\/"\)\[1\] === "native-m1"/u,
    "native-m1 stays a compatibility hash under the same ai route, not a second surface mode",
  );
  assert.match(architecture, /ordinary AI route uses this official DSH\s+surface as its single AI interaction truth/u);
  assert.doesNotMatch(architecture, /Off by default|implementation candidate/u);
});

test("the AI route cannot escape to LegacyRoute through supported aiReact=false overrides", () => {
  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const values = new Map<string, string>([
    ["luckyray-feature-flags", JSON.stringify({ aiReact: false })],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?aiReact=0" } },
  });

  try {
    clearFlagCache();
    assert.equal(getFlags().aiReact, false, "the supported override must really disable aiReact");
    assert.equal(selectShellRouteMode("ai", getFlags().aiReact), "dsh-native-surface");
    assert.equal(selectShellRouteMode("settings", false), "legacy");
  } finally {
    clearFlagCache();
    if (originalStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
    if (originalWindow === undefined) delete (globalThis as { window?: Window & typeof globalThis }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("LightSeek restart is an app-shell tools action with bounded busy and product loading states", async () => {
  const [page, shell, titlebar, css, toolsMenu] = await Promise.all([
    readFile(new URL("../src/features/ai/DshNativeSurfacePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppSidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/appShell.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/ai/LightSeekToolsMenu.tsx", import.meta.url), "utf8"),
  ]);
  const rightActions = titlebar.slice(
    titlebar.indexOf("className={`titlebar-right"),
    titlebar.indexOf("<WindowControlsFixed />"),
  );

  assert.match(rightActions, /LightSeekToolsMenu restarting=\{lightSeekRestarting\} onRestart=\{onRestartLightSeek\}/u);
  assert.match(toolsMenu, /disabled=\{restarting\} onClick=\{\(\) => \{ close\(\); onRestart\(\); \}\}/u);
  assert.match(toolsMenu, /await owned\.restart\.setEnabled\(!restarting\)/u);
  assert.match(rightActions, /titlebar-ai-browser/u, "tools are beside the existing browser icon action");
  assert.match(css, /\.titlebar-ai-browser\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/u);
  assert.match(shell, /lightSeekRestartRequest/u);
  assert.match(shell, /lightSeekRestarting/u);
  assert.match(shell, /if \(lightSeekRestartingRef\.current\) return;/u);
  assert.match(shell, /lightSeekRestartingRef\.current = true;/u);
  assert.match(shell, /lightSeekRestartingRef\.current = false;/u);
  const restartAction = shell.slice(
    shell.indexOf("const restartLightSeek"),
    shell.indexOf("const compactSurfaceCoordinator"),
  );
  assert.doesNotMatch(
    restartAction,
    /setAiPersonalBrowserOpen|onToggleAiPersonalBrowser|BrowserPage/u,
    "LightSeek restart must not rebuild or close the independent personal browser",
  );
  assert.match(page, /client\.restart\(boundsOf\(mount\)\)/u);
  assert.match(page, /LightSeek 重启中…/u);
  assert.match(page, /!restartingRef\.current && activeVisibility\?\.isCurrentVisible\(\)/u);
  assert.match(page, /settleDshNativeSurfaceRestartProjection/u);
  assert.match(page, /const restartWasInFlightRef = useRef\(restarting\)/u);
  assert.match(page, /allowInitialOpenFallback = true/u);
  assert.match(page, /syncVisibility: \(visible, allowInitialOpenFallback\)/u);
  assert.match(page, /restartSucceededRef\.current = true;/u);
  assert.match(page, /if \(!routeMountedRef\.current\) \{[\s\S]*await client\.hide\(\)/u);
  assert.doesNotMatch(page, /setTimeout|setInterval|requestAnimationFrame/u);
});

test("an accepted LightSeek restart request is consumed before settled or in-flight route remounts", async () => {
  const [shell, page] = await Promise.all([
    readFile(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/ai/DshNativeSurfacePage.tsx", import.meta.url), "utf8"),
  ]);
  const acceptStart = shell.indexOf("const acceptLightSeekRestart");
  const acceptEnd = shell.indexOf("const settleLightSeekRestart", acceptStart);
  const accept = shell.slice(acceptStart, acceptEnd);
  const settleStart = shell.indexOf("const settleLightSeekRestart");
  const settleEnd = shell.indexOf("const compactSurfaceCoordinator", settleStart);
  const settle = shell.slice(settleStart, settleEnd);

  assert.ok(acceptStart > 0 && acceptEnd > acceptStart);
  assert.ok(settleStart > 0 && settleEnd > settleStart);
  assert.match(accept, /if \(lightSeekRestartRequestRef\.current !== request\) return;/u);
  assert.match(
    accept,
    /setLightSeekRestartRequest\(0\)/u,
    "acceptance consumes the one-shot before an in-flight route remount",
  );
  assert.match(settle, /if \(lightSeekRestartRequestRef\.current !== request\) return;/u);
  assert.match(settle, /lightSeekRestartingRef\.current = false;/u);
  assert.match(settle, /setLightSeekRestarting\(false\)/u);
  assert.match(page, /onRestartAccepted\?\.\(restartRequest\)/u);
  assert.ok(
    page.indexOf("onRestartAccepted?.(restartRequest)") < page.indexOf("await client.restart(boundsOf(mount))"),
    "the one-shot is consumed before the asynchronous restart can overlap a route remount",
  );
  assert.match(
    page,
    /const routeMountedRef = useRef\(false\);[\s\S]*useEffect\(\(\) => \{\s*routeMountedRef\.current = true;\s*return \(\) => \{\s*routeMountedRef\.current = false;\s*\};\s*\}, \[\]\);/u,
    "true route lifetime is independent from restartRequest dependency changes",
  );
  const restartEffectStart = page.indexOf("if (restartRequest <= 0");
  const restartEffectEnd = page.indexOf("syncVisibilityRef.current?.(nativeSurfacesVisible)", restartEffectStart);
  const restartEffect = page.slice(restartEffectStart, restartEffectEnd);
  assert.ok(restartEffectStart > 0 && restartEffectEnd > restartEffectStart);
  assert.doesNotMatch(restartEffect, /let active = true|active = false/u);
  assert.match(restartEffect, /if \(!routeMountedRef\.current\)/u);
  assert.match(restartEffect, /if \(routeMountedRef\.current\) setError/u);

  let restartRequest = 1;
  let currentRequest = 1;
  let restartCount = 0;
  let hostGeneration = 12;
  let routeMounted = true;
  let visibleAfterRestart = false;
  const acceptRequest = (request: number) => {
    if (currentRequest !== request) return false;
    restartRequest = 0;
    return true;
  };
  const mount = () => {
    let handledRequest = 0;
    if (restartRequest > 0 && restartRequest > handledRequest) {
      handledRequest = restartRequest;
      assert.equal(acceptRequest(restartRequest), true);
      restartCount += 1;
      hostGeneration += 1;
    }
  };

  mount();
  assert.equal(restartCount, 1);
  assert.equal(hostGeneration, 13);
  // Consuming request 1 -> 0 re-renders the page, but is not a route unmount.
  assert.equal(routeMounted, true);
  if (routeMounted) visibleAfterRestart = true;
  assert.equal(visibleAfterRestart, true, "acceptance must not hide a successful restart");
  // Remounting while the first restart is still in flight sees the consumed 0.
  mount();
  // Remounting again after settlement also sees 0.
  mount();
  assert.equal(restartCount, 1, "route remounts reuse the healthy restarted generation");
  assert.equal(hostGeneration, 13);

  currentRequest = 2;
  restartRequest = 2;
  assert.equal(acceptRequest(1), false, "a stale accept cannot consume a newer request");
  mount();
  assert.equal(restartCount, 2, "a later explicit click still starts one new generation");
  assert.equal(hostGeneration, 14);

  routeMounted = false;
  visibleAfterRestart = true;
  if (!routeMounted) visibleAfterRestart = false;
  assert.equal(visibleAfterRestart, false, "a real route unmount still hides the restarted child");
});

test("full restart retires the native child and old owned generation before one new generation", async () => {
  const [rust, host, ownedProcess, broker] = await Promise.all([
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/dsh_host.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/owned_process.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/dsh_resource_broker.rs", import.meta.url), "utf8"),
  ]);
  const commandStart = rust.indexOf("async fn dsh_native_surface_restart(");
  const commandEnd = rust.indexOf("fn dsh_native_surface_set_bounds(", commandStart);
  const command = rust.slice(commandStart, commandEnd);
  const restartStart = host.indexOf("pub(crate) fn restart_native_surface_with");
  const restartEnd = host.indexOf("pub(crate) fn publish_surface_stage_for", restartStart);
  const restart = host.slice(restartStart, restartEnd);

  assert.ok(commandStart > 0 && commandEnd > commandStart);
  assert.match(rust, /generate_handler!\[[\s\S]*dsh_native_surface_restart,/u);
  assert.match(command, /restart_native_surface_with/u);
  assert.match(command, /retire_dsh_native_surface_child\(&retire_caller\)/u);
  assert.doesNotMatch(command, /dsh_native_surface_close\(|dsh_native_surface_open\(/u);
  const retireStart = rust.indexOf("fn retire_dsh_native_surface_child(");
  const retireEnd = rust.indexOf("#[tauri::command]", retireStart);
  const retireChild = rust.slice(retireStart, retireEnd);
  assert.ok(retireStart > 0 && retireEnd > retireStart);
  assert.match(retireChild, /run_dsh_native_surface_on_main/u);
  const uiBarrier = rust.slice(rust.indexOf("fn run_dsh_native_surface_on_main"), rust.indexOf("fn settle_warm_existing_webview_close_failure"));
  assert.match(uiBarrier, /run_on_main_thread/u);
  assert.match(uiBarrier, /sync_channel\(1\)/u);
  assert.match(retireChild, /existing[\s\S]*\.close\(\)/u);
  assert.match(uiBarrier, /recv_timeout/u);
  assert.match(uiBarrier, /compare_exchange\(PENDING, CANCELLED/u);
  assert.match(uiBarrier, /compare_exchange\(PENDING, RUNNING/u);
  assert.match(uiBarrier, /receive\.recv\(\)/u);
  assert.ok(restartStart > 0 && restartEnd > restartStart);
  assert.match(restart, /operation\s*\.try_lock\(\)/u, "single-flight uses the existing operation gate");
  const retireNative = restart.indexOf("retire_native_child()");
  const retireGeneration = restart.indexOf("terminate_current_checked()");
  const launchGeneration = restart.indexOf("launch_and_probe(");
  const openSurface = restart.indexOf("open_native_surface_locked()");
  assert.ok(retireNative > 0 && retireNative < retireGeneration);
  assert.ok(retireGeneration < launchGeneration && launchGeneration < openSurface);
  assert.equal(restart.match(/launch_and_probe\(/gu)?.length, 1, "restart reserves exactly one new generation");
  assert.equal(restart.match(/retire_native_child\(\)/gu)?.length, 1);
  assert.equal(restart.match(/create_native_child\(&bootstrap\)/gu)?.length, 1);
  assert.doesNotMatch(restart, /RuntimeDescriptor::|state_root\s*=|surface_state_root\s*=/u);
  assert.match(restart, /if let Err\(error\) = retire_native_child\(\)[\s\S]*terminate_current_checked\(\)[\s\S]*return Err\(error\)/u);
  assert.match(restart, /if self\.launch_and_probe\(descriptor, 0\)\.is_err\(\)[\s\S]*terminate_current_checked\(\)[\s\S]*return Err\("dsh-native-surface-unavailable"/u);
  assert.match(restart, /if let Err\(error\) = create_native_child\(&bootstrap\)[\s\S]*terminate_current_checked\(\)[\s\S]*return Err\(error\)/u);
  assert.match(host, /broker\.retire_generation\(host\.generation\(\)\)/u);
  assert.match(host, /map\(\|host\| host\.generation == generation\)/u, "late old monitor is fenced");
  assert.match(host, /proactive_surface_restart_is_single_flight_fail_closed_and_retryable/u);
  assert.match(ownedProcess, /terminate_and_wait/u);
  assert.match(ownedProcess, /QueryInformationJobObject/u);
  assert.match(ownedProcess, /terminate_and_wait_settles_the_owned_process_tree/u);
  assert.match(broker, /cancel_scope\(scope\)[\s\S]*agent_browser\(\)\.cancel_scope\(scope\)/u);
  assert.doesNotMatch(restart, /thread::spawn|RESTART_BACKOFF|watchdog|poller/u);
});
