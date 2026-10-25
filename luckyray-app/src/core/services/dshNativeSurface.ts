import { observeDshStartupInvoke } from "./dshStartupObservation";
import { runDshHostOperation, serializeDshHostInvoke } from "./dshHostOperations";

export type DshNativeSurfaceStatus = {
  ready: boolean;
  stage: "closed" | "carrier-ready" | "webview-created" | "client-ready" | "session-open" | "unavailable";
  coldJitMs: number | null;
  carrierBindMs: number | null;
  outerHostRssMb: number | null;
  luckyRayProcessHandleCount: number | null;
  ownedDirectProcessCount: number;
  message: string;
};

export type DshNativeSurfaceBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DshNativeSurfaceOpenIntent = {
  intentId: string;
  localResources: readonly Readonly<{
    kind: "material";
    assetId: string;
    canonicalPath: string;
    delivery: "image-attachment" | "file-attachment" | "path-reference";
  }>[];
  source: "materials" | "notes" | "collection" | "graph" | "search";
  text: string;
};

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type DshNativeSurfaceVisualClient = {
  show: (bounds: DshNativeSurfaceBounds) => Promise<unknown>;
  hide: () => Promise<unknown>;
};

type DshNativeSurfaceVisualAction =
  | { kind: "show"; client: DshNativeSurfaceVisualClient; bounds: DshNativeSurfaceBounds }
  | { kind: "hide"; client: DshNativeSurfaceVisualClient };

type DshNativeSurfaceVisibilityState = {
  generation: number;
  visible: boolean;
  action: DshNativeSurfaceVisualAction | null;
};

// The native child outlives React route mounts. This module-scoped intent is
// visual-only: it orders show/hide convergence without owning runtime/session truth.
let nextDshNativeSurfaceVisibilityGeneration = 0;
let latestDshNativeSurfaceVisibility: DshNativeSurfaceVisibilityState = {
  generation: 0,
  visible: false,
  action: null,
};
let pendingDshNativeSurfaceInitialOpen: Promise<void> | null = null;

async function reconcileDshNativeSurfaceVisibility(actualVisible: boolean): Promise<void> {
  const desired = latestDshNativeSurfaceVisibility;
  if (desired.visible === actualVisible || !desired.action) return;
  if (desired.visible && pendingDshNativeSurfaceInitialOpen) {
    // A late modal/route hide can settle while the sole cold open is still
    // creating the child. Showing that not-yet-created child is not a startup
    // failure. Join the existing operation, then re-read the latest intent;
    // never spawn/retry here or swallow a real open rejection.
    await pendingDshNativeSurfaceInitialOpen;
    await reconcileDshNativeSurfaceVisibility(true);
    return;
  }
  await runDshNativeSurfaceVisualAction(desired.action);
  await reconcileDshNativeSurfaceVisibility(desired.action.kind === "show");
}

function runDshNativeSurfaceVisualAction(action: DshNativeSurfaceVisualAction) {
  return action.kind === "show"
    ? action.client.show(action.bounds)
    : action.client.hide();
}

async function applyDshNativeSurfaceVisualAction(
  generation: number,
  action: DshNativeSurfaceVisualAction,
) {
  const visible = action.kind === "show";
  const intent = latestDshNativeSurfaceVisibility;
  if (intent.generation !== generation || intent.visible !== visible) {
    return false;
  }
  intent.action = action;
  await runDshNativeSurfaceVisualAction(action);
  await reconcileDshNativeSurfaceVisibility(visible);
  return latestDshNativeSurfaceVisibility.generation === generation
    && latestDshNativeSurfaceVisibility.visible === visible;
}

export function claimDshNativeSurfaceVisibility() {
  const generation = ++nextDshNativeSurfaceVisibilityGeneration;
  latestDshNativeSurfaceVisibility = { generation, visible: true, action: null };
  return Object.freeze({
    isCurrentVisible: () => latestDshNativeSurfaceVisibility.generation === generation
      && latestDshNativeSurfaceVisibility.visible,
    show: (client: DshNativeSurfaceVisualClient, bounds: DshNativeSurfaceBounds) => (
      applyDshNativeSurfaceVisualAction(generation, { kind: "show", client, bounds })
    ),
    reconcileAfterOneShotOpen: async () => {
      await reconcileDshNativeSurfaceVisibility(true);
      return latestDshNativeSurfaceVisibility.generation === generation
        && latestDshNativeSurfaceVisibility.visible;
    },
    hide: async (clientPromise: Promise<DshNativeSurfaceVisualClient>) => {
      if (latestDshNativeSurfaceVisibility.generation !== generation
        || !latestDshNativeSurfaceVisibility.visible) return false;
      const hiddenGeneration = ++nextDshNativeSurfaceVisibilityGeneration;
      latestDshNativeSurfaceVisibility = { generation: hiddenGeneration, visible: false, action: null };
      const client = await clientPromise;
      return applyDshNativeSurfaceVisualAction(
        hiddenGeneration,
        { kind: "hide", client },
      );
    },
  });
}

export function runDshNativeSurfaceInitialOpenSingleFlight(
  open: () => Promise<unknown>,
) {
  if (pendingDshNativeSurfaceInitialOpen) return pendingDshNativeSurfaceInitialOpen;
  const pending = Promise.resolve().then(open).then(() => undefined);
  pendingDshNativeSurfaceInitialOpen = pending;
  void pending.then(
    () => {
      if (pendingDshNativeSurfaceInitialOpen === pending) {
        pendingDshNativeSurfaceInitialOpen = null;
      }
    },
    () => {
      // A failed cold open remains fail-closed until the existing Retry action
      // explicitly resets it; modal or route churn must not silently restart it.
    },
  );
  return pending;
}

export function resetDshNativeSurfaceInitialOpenSingleFlight() {
  pendingDshNativeSurfaceInitialOpen = null;
}

/** CSS dimensions can stay unchanged when Main moves across DPI scales. */
export function watchDshNativeSurfaceScaleChanges(
  onChange: () => void,
  viewport: Pick<Window, "devicePixelRatio" | "matchMedia"> = window,
) {
  let active = true;
  let media: MediaQueryList;
  const changed = () => {
    if (!active) return;
    media.removeEventListener("change", changed);
    // Each query watches the current scale. Rearm after every transition so
    // repeated monitor moves (including back to the original DPI) are seen.
    media = viewport.matchMedia(`(resolution: ${viewport.devicePixelRatio}dppx)`);
    media.addEventListener("change", changed);
    onChange();
  };
  media = viewport.matchMedia(`(resolution: ${viewport.devicePixelRatio}dppx)`);
  media.addEventListener("change", changed);
  return () => {
    active = false;
    media.removeEventListener("change", changed);
  };
}

/**
 * Availability watch for the post-ready freeze failure mode: the surface can
 * pass carrier-ready and later be reported unavailable by the host watchdog.
 * Polling lives here (not in the page) so page components stay timer-free;
 * callers cancel via the returned disposer or the abort signal.
 */
export function pollDshNativeSurfaceAvailability(
  client: { status: () => Promise<DshNativeSurfaceStatus> },
  onUpdate: (status: DshNativeSurfaceStatus) => void,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
) {
  const intervalMs = Number.isSafeInteger(options.intervalMs) && Number(options.intervalMs) >= 1000
    ? Number(options.intervalMs) : 5000;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const tick = async () => {
    if (cancelled) return;
    try {
      const status = await client.status();
      if (!cancelled) onUpdate(status);
    } catch {
      /* transient status errors are not surface failures */
    }
    if (!cancelled) {
      timer = setTimeout(() => { void tick(); }, intervalMs);
    }
  };
  void tick();
  return stop;
}

/** Watch one attached page attempt; disposed attempts cannot reclaim or report. */
export function watchDshNativeSurfaceFailure(
  client: { status: () => Promise<DshNativeSurfaceStatus> },
  getCompatClient: () => Promise<{ reclaimFailedSurface: () => Promise<void> }>,
  onFailure: (message: string) => void,
) {
  let active = true;
  let reclaiming = false;
  const stop = pollDshNativeSurfaceAvailability(client, (status) => {
    if (!active || reclaiming || status.stage !== "unavailable") return;
    reclaiming = true;
    void (async () => {
      try {
        const compat = await getCompatClient();
        if (!active) return;
        await compat.reclaimFailedSurface();
      } catch {
        // The observed failure still needs its outer recovery panel.
      } finally {
        if (active) onFailure(status.message);
      }
    })();
  });
  return () => {
    active = false;
    stop();
  };
}

export function settleDshNativeSurfaceRestartProjection({
  wasRestarting,
  restarting,
  succeeded,
  visible,
  syncVisibility,
  deliverOpenIntent,
}: {
  wasRestarting: boolean;
  restarting: boolean;
  succeeded: boolean;
  visible: boolean;
  syncVisibility: (visible: boolean, allowInitialOpenFallback: boolean) => void;
  deliverOpenIntent: () => void;
}) {
  if (restarting || !wasRestarting) return false;
  // A settled restart may be observed by a fresh route mount. Reconcile only
  // against the child just created by the authoritative restart; never turn a
  // failed restart into an implicit second cold open.
  syncVisibility(visible, false);
  if (succeeded) deliverOpenIntent();
  return true;
}

export function projectDshNativeSurfaceStatus(value: unknown): DshNativeSurfaceStatus {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const duration = (field: string) => Number.isSafeInteger(row[field]) && Number(row[field]) >= 0
    ? Number(row[field]) : null;
  const stages = new Set(["closed", "carrier-ready", "webview-created", "client-ready", "session-open", "unavailable"]);
  const stage = typeof row.stage === "string" && stages.has(row.stage)
    ? row.stage as DshNativeSurfaceStatus["stage"] : "unavailable";
  return Object.freeze({
    ready: row.ready === true
      && (stage === "client-ready" || stage === "session-open"),
    stage,
    coldJitMs: duration("coldJitMs"),
    carrierBindMs: duration("carrierBindMs"),
    outerHostRssMb: duration("outerHostRssMb"),
    luckyRayProcessHandleCount: duration("luckyRayProcessHandleCount"),
    ownedDirectProcessCount: Number.isSafeInteger(row.ownedDirectProcessCount) && Number(row.ownedDirectProcessCount) >= 0
      ? Math.min(8, Number(row.ownedDirectProcessCount)) : 0,
    message: typeof row.message === "string" && row.message.length <= 120
      ? row.message : "官方 DeepSeek Harness 界面暂不可用。",
  });
}

export function createDshNativeSurfaceClient(invoke: Invoke) {
  const nativeInvoke = invoke;
  invoke = serializeDshHostInvoke(invoke);
  return Object.freeze({
    status: async () => projectDshNativeSurfaceStatus(await invoke("dsh_native_surface_status")),
    // Exact null is the native feature/unsupported-platform fallback. A child
    // being created is not readiness, and must never become a cached success.
    preload: async (): Promise<DshNativeSurfaceStatus | null> => {
      const result = await invoke("dsh_native_surface_preload");
      if (result === null) return null;
      const status = projectDshNativeSurfaceStatus(result);
      if (!status.ready) throw new Error("dsh-native-surface-not-ready");
      return status;
    },
    open: async (bounds: DshNativeSurfaceBounds) => projectDshNativeSurfaceStatus(
      await invoke("dsh_native_surface_open", { bounds }),
    ),
    restart: async (bounds: DshNativeSurfaceBounds) => projectDshNativeSurfaceStatus(
      await invoke("dsh_native_surface_restart", { bounds }),
    ),
    // Visual-only route visibility. `show` rejects with the bounded
    // "not-open" error when no child exists so callers fall back to `open`.
    show: (bounds: DshNativeSurfaceBounds) => invoke<void>("dsh_native_surface_show", { bounds }),
    hide: () => invoke<void>("dsh_native_surface_hide"),
    setBounds: (bounds: DshNativeSurfaceBounds) => invoke<void>("dsh_native_surface_set_bounds", { bounds }),
    openIntent: (intent: DshNativeSurfaceOpenIntent, isCurrent: () => boolean = () => true) => (
      runDshHostOperation(() => {
        // Modal/route changes can happen while another host operation owns
        // the lane. Recheck immediately before transmitting any user content.
        if (!isCurrent()) throw new Error("dsh-open-intent-not-ready");
        return nativeInvoke<void>("dsh_native_surface_open_intent", { intent });
      })
    ),
    openIntentStatus: async (intentId: string) => {
      const status = await invoke<string>("dsh_native_surface_open_intent_status", { intentId });
      if (status !== "pending" && status !== "applied" && status !== "unavailable") {
        throw new Error("dsh-open-intent-status-invalid");
      }
      return status;
    },
    close: async () => projectDshNativeSurfaceStatus(await invoke("dsh_native_surface_close")),
  });
}

export async function waitForDshOpenIntentApplied(
  client: { openIntentStatus: (intentId: string) => Promise<"pending" | "applied" | "unavailable"> },
  intentId: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const deadline = Date.now() + 31_000;
  while (isCurrent() && Date.now() < deadline) {
    let status: "pending" | "applied" | "unavailable";
    try {
      status = await client.openIntentStatus(intentId);
    } catch (error) {
      if (String(error).includes("dsh-host-action-busy")) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw error;
    }
    if (status === "applied" && isCurrent()) return;
    if (status === "unavailable") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("dsh-open-intent-outcome-unknown");
}

/**
 * Once an outer result is uncertain, only the authenticated receipt may
 * resolve it. Restaging into a new carrier generation would duplicate a
 * composer write that may already have been ACKed by the old generation.
 */
export async function deliverDshOpenIntent(
  client: {
    openIntent: (intent: DshNativeSurfaceOpenIntent, isCurrent?: () => boolean) => Promise<unknown>;
    openIntentStatus: (intentId: string) => Promise<"pending" | "applied" | "unavailable">;
  },
  intent: DshNativeSurfaceOpenIntent,
  recoveryOnly: boolean,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (recoveryOnly) {
    const status = await client.openIntentStatus(intent.intentId);
    if (status === "applied" && isCurrent()) return;
    if (status === "unavailable" || !isCurrent()) {
      throw new Error("dsh-open-intent-outcome-unknown");
    }
  } else {
    // Staging may succeed even when the subsequent webview wake fails. The
    // authenticated carrier receipt, not that wake call, decides delivery.
    try {
      if (!isCurrent()) throw new Error("dsh-open-intent-not-ready");
      await client.openIntent(intent, isCurrent);
    } catch (error) {
      // These Rust rejections happen before the wrapper is asked to
      // stage anything. Transport/write/read failures are not proof of that.
      const code = String(error).replace(/^Error: /u, "");
      if (code === "dsh-host-action-busy" || code === "dsh-open-intent-not-ready"
        || code === "dsh-host-shutting-down" || code === "dsh-open-intent-invalid") {
        throw new Error("dsh-open-intent-not-staged");
      }
      // Staging could have succeeded before this result was lost. Resolve by
      // the generation-bound carrier receipt, never by a new intent ID.
    }
  }
  await waitForDshOpenIntentApplied(client, intent.intentId, isCurrent);
}

export async function createDefaultDshNativeSurfaceClient() {
  const { invoke } = await import("@tauri-apps/api/core");
  return createDshNativeSurfaceClient(observeDshStartupInvoke(invoke as Invoke));
}
