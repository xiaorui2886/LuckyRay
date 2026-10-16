import {
  ensureDshHostReady,
  preloadDshHostAtStartup,
  type DshHostClient,
} from "./dshHost";
import {
  createDefaultDshNativeSurfaceClient,
  resetDshNativeSurfaceInitialOpenSingleFlight,
  runDshNativeSurfaceInitialOpenSingleFlight,
  type DshNativeSurfaceStatus,
} from "./dshNativeSurface";

type PreparationClient = { preload: () => Promise<DshNativeSurfaceStatus | null> };
type StatusClient = { status: () => Promise<DshNativeSurfaceStatus> };

/** App-owned preparation, not a second host/session/readiness authority. */
export function createDshBackgroundPreloadCoordinator(
  preloadHost = preloadDshHostAtStartup,
  createSurface: () => Promise<PreparationClient> = createDefaultDshNativeSurfaceClient,
) {
  let started = false;
  let preparation: Promise<DshNativeSurfaceStatus | null> | null = null;
  let recovery: Promise<void> | null = null;

  const reset = () => {
    // Startup remains one-shot. Explicit recovery may allow a foreground open,
    // but a remount must never start another background preparation.
    preparation = null;
    resetDshNativeSurfaceInitialOpenSingleFlight();
  };
  return Object.freeze({
    start(nativeWindowLabel: string | null) {
      if (nativeWindowLabel !== "main") return null;
      if (!started) {
        started = true;
        const host = preloadHost(nativeWindowLabel);
        let prepared: DshNativeSurfaceStatus | null = null;
        // Both lanes are reserved before route imports or asynchronous client
        // creation. An immediate AI entry joins this same initial-open flight.
        const initialOpen = runDshNativeSurfaceInitialOpenSingleFlight(async () => {
          await host;
          prepared = await (await createSurface()).preload();
        });
        preparation = initialOpen.then(() => prepared);
        // Page entry observes failure and exposes the existing explicit Retry.
        // Unmounts, modal churn and later clicks cannot silently retry it.
        void preparation.catch(() => undefined);
      }
      return preparation;
    },
    async readyForAttach<T extends StatusClient>(
      host: DshHostClient,
      surface: T,
      action: "probe" | "retry" = "probe",
    ): Promise<T> {
      const prepared = await preparation;
      await ensureDshHostReady(host, action);
      const current = await surface.status();
      // A hidden child can fail after successful startup but before its first
      // route attachment. Do not show it or turn the lost child into an implicit
      // cold open; real native truth must lead to explicit recovery.
      if (prepared !== null && !current.ready) {
        throw new Error("dsh-native-surface-unavailable");
      }
      return surface;
    },
    reset,
    retry(reclaimFailedSurface: () => Promise<void>) {
      if (recovery) return recovery;
      const pending = Promise.resolve().then(async () => {
        // Retire only through the backend's authoritative failed-child check.
        // If it cannot confirm retirement, preserve the failure latch.
        await reclaimFailedSurface();
        reset();
      });
      recovery = pending;
      const clear = () => { if (recovery === pending) recovery = null; };
      void pending.then(clear, clear);
      return pending;
    },
  });
}

const background = createDshBackgroundPreloadCoordinator();
export const preloadDshBackgroundAtStartup = background.start;
export const prepareDshNativeSurfaceForAttach = background.readyForAttach;
export const resetDshBackgroundPreload = background.reset;
export const retryDshBackgroundPreload = background.retry;
