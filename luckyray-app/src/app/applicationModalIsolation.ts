import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export type ApplicationModalIsolationLease = Readonly<{
  release: () => void;
}>;

export type ApplicationModalIsolationStore = Readonly<{
  acquire: () => ApplicationModalIsolationLease;
  getSnapshot: () => boolean;
  subscribe: (listener: () => void) => () => void;
}>;

const ApplicationModalIsolationContext = createContext<Pick<ApplicationModalIsolationStore, "acquire"> | null>(null);

export function createApplicationModalIsolationStore(): ApplicationModalIsolationStore {
  const owners = new Set<symbol>();
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return Object.freeze({
    acquire: () => {
      const owner = Symbol("application-modal-owner");
      const wasActive = owners.size > 0;
      owners.add(owner);
      if (!wasActive) publish();
      let released = false;
      return Object.freeze({
        release: () => {
          if (released) return;
          released = true;
          const wasPresent = owners.delete(owner);
          if (wasPresent && owners.size === 0) publish();
        },
      });
    },
    getSnapshot: () => owners.size > 0,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export function ApplicationModalIsolationProvider({
  store,
  children,
}: Readonly<{
  store: ApplicationModalIsolationStore;
  children: ReactNode;
}>) {
  return createElement(ApplicationModalIsolationContext.Provider, { value: store }, children);
}

export function useApplicationModalIsolationSnapshot(store: ApplicationModalIsolationStore): boolean {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useApplicationModalIsolationLease(active: boolean): void {
  const store = useContext(ApplicationModalIsolationContext);
  useLayoutEffect(() => {
    if (!active) return undefined;
    if (!store) throw new Error("application-modal-isolation-provider-required");
    const lease = store.acquire();
    return lease.release;
  }, [active, store]);
}

const APPLICATION_MODAL_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const activeApplicationModalSurfaces: HTMLElement[] = [];

// Removing a modal also releases the shell's inert lease. Focus must wait for
// that render when the opener was in the isolated navigation/background.
function restoreApplicationModalFocus(target: HTMLElement | null): void {
  if (!target?.isConnected) return;
  const restore = () => {
    const top = activeApplicationModalSurfaces[activeApplicationModalSurfaces.length - 1];
    if (!target.isConnected || target.closest("[inert], [hidden], [aria-hidden='true']") || top && !top.contains(target)) return;
    target.focus({ preventScroll: true });
  };
  if (target.closest("[inert], [aria-hidden='true']")) requestAnimationFrame(restore);
  else restore();
}

function isApplicationModalFocusCandidate(candidate: HTMLElement, surface: HTMLElement): boolean {
  const blockedAncestor = typeof candidate.closest === "function"
    ? candidate.closest<HTMLElement>("[hidden], [aria-hidden='true'], [inert]")
    : null;
  return !candidate.hidden
    && candidate.getAttribute("aria-hidden") !== "true"
    && !candidate.hasAttribute("disabled")
    && !(typeof candidate.matches === "function" && candidate.matches(":disabled"))
    && !(blockedAncestor && surface.contains(blockedAncestor))
    && candidate.tabIndex >= 0
    && (typeof candidate.getClientRects !== "function" || candidate.getClientRects().length > 0);
}

export function getApplicationModalFocusCandidates(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(APPLICATION_MODAL_FOCUSABLE))
    .filter((candidate) => isApplicationModalFocusCandidate(candidate, surface));
}

export function resolveApplicationModalTabTarget(
  surface: HTMLElement,
  activeElement: Element | null,
  backwards: boolean,
): HTMLElement | null {
  const candidates = getApplicationModalFocusCandidates(surface);
  if (candidates.length === 0) return surface;
  const activeIndex = activeElement ? candidates.indexOf(activeElement as HTMLElement) : -1;
  if (activeIndex < 0) return backwards ? candidates[candidates.length - 1] : candidates[0];
  if (backwards && activeIndex === 0) return candidates[candidates.length - 1];
  if (!backwards && activeIndex === candidates.length - 1) return candidates[0];
  return null;
}

export type ApplicationModalSurfaceOptions = Readonly<{
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}>;

export function useApplicationModalSurface<T extends HTMLElement>(
  active: boolean,
  onClose: () => void,
  options: ApplicationModalSurfaceOptions = {},
) {
  useApplicationModalIsolationLease(active);
  const surfaceRef = useRef<T | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeOnBackdrop = options.closeOnBackdrop ?? true;
  const closeOnEscape = options.closeOnEscape ?? true;

  useLayoutEffect(() => {
    if (!active) return undefined;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = surfaceRef.current;
    if (surface) {
      activeApplicationModalSurfaces.push(surface);
      const candidates = getApplicationModalFocusCandidates(surface);
      const requested = surface.querySelector<HTMLElement>("[autofocus], [data-modal-initial-focus]");
      const preferred = requested && candidates.includes(requested) ? requested : candidates[0] || surface;
      preferred.focus({ preventScroll: true });

      const containFocus = (event: FocusEvent) => {
        if (activeApplicationModalSurfaces[activeApplicationModalSurfaces.length - 1] !== surface) return;
        if (!surface.isConnected || surface.contains(event.target as Node)) return;
        const target = resolveApplicationModalTabTarget(surface, null, false) || surface;
        target.focus({ preventScroll: true });
      };
      document.addEventListener("focusin", containFocus, true);
      // Async content can remove the focused action (for example replacing
      // “connect” with a QR). Browsers then leave focus on body without focusin.
      const mutations = new MutationObserver(() => {
        if (activeApplicationModalSurfaces[activeApplicationModalSurfaces.length - 1] !== surface
          || !surface.isConnected || surface.contains(document.activeElement)) return;
        const target = resolveApplicationModalTabTarget(surface, null, false) || surface;
        target.focus({ preventScroll: true });
      });
      mutations.observe(surface, { childList: true, subtree: true });

      return () => {
        mutations.disconnect();
        document.removeEventListener("focusin", containFocus, true);
        const surfaceIndex = activeApplicationModalSurfaces.lastIndexOf(surface);
        if (surfaceIndex >= 0) activeApplicationModalSurfaces.splice(surfaceIndex, 1);
        const returnTarget = returnFocusRef.current;
        returnFocusRef.current = null;
        restoreApplicationModalFocus(returnTarget);
      };
    }
    return () => {
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      restoreApplicationModalFocus(returnTarget);
    };
  }, [active]);

  const onSurfaceKeyDown = useCallback((event: ReactKeyboardEvent<T>) => {
    if (activeApplicationModalSurfaces[activeApplicationModalSurfaces.length - 1] !== surfaceRef.current) return;
    if (event.key === "Escape" && closeOnEscape) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const target = resolveApplicationModalTabTarget(event.currentTarget, document.activeElement, event.shiftKey);
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  }, [closeOnEscape, onClose]);

  const onBackdropPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!closeOnBackdrop || event.target !== event.currentTarget) return;
    event.preventDefault();
    onClose();
  }, [closeOnBackdrop, onClose]);

  return { surfaceRef, onSurfaceKeyDown, onBackdropPointerDown } as const;
}
