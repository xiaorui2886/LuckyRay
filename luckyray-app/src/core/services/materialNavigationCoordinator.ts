export const MATERIAL_NAVIGATION_STORAGE_KEY = "luckyray:material-navigation-intent";

const LEGACY_NAV_FOCUS_KEY = "luckyray:nav-focus";

export type MaterialNavigationAction = "focus" | "focus-only" | "detail";
export type MaterialNavigationPhase =
  | "received"
  | "snapshot-ready"
  | "filter-resolved"
  | "element-ready"
  | "scroll-settled"
  | "spotlight"
  | "optional-detail";

export type MaterialNavigationIntent = {
  requestId: string;
  assetId: string;
  action: MaterialNavigationAction;
  source?: string;
  createdAt: number;
  phase: MaterialNavigationPhase;
  retry: number;
  epoch: number;
  filterFallbackApplied: boolean;
  revalidationPending: boolean;
};

export type MaterialNavigationReport =
  | "snapshot-ready"
  | "filter-resolved"
  | "element-ready"
  | "scroll-settled"
  | "spotlight-applied"
  | "detail-opened"
  | "not-found"
  | "timeout";

type IntentListener = () => void;

function createRequestId(epoch: number) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `asset-${epoch}-${crypto.randomUUID()}`;
  }
  return `asset-${epoch}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readStorage(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeStorage(key: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(key);
  } catch {}
}

function isAction(value: unknown): value is MaterialNavigationAction {
  return value === "focus" || value === "focus-only" || value === "detail";
}

function parseStoredIntent(raw: string | null): MaterialNavigationIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MaterialNavigationIntent>;
    if (typeof value.requestId !== "string" || !value.requestId || typeof value.assetId !== "string" || !value.assetId) return null;
    return {
      requestId: value.requestId,
      assetId: value.assetId,
      action: isAction(value.action) ? value.action : "focus",
      source: typeof value.source === "string" ? value.source : undefined,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
      // A restored page must re-establish its data and DOM facts before acting.
      phase: "received",
      retry: typeof value.retry === "number" ? value.retry : 0,
      epoch: typeof value.epoch === "number" ? value.epoch : 0,
      filterFallbackApplied: Boolean(value.filterFallbackApplied),
      revalidationPending: false,
    };
  } catch {
    return null;
  }
}

class MaterialNavigationCoordinator {
  private current: MaterialNavigationIntent | null = null;
  private epoch = 0;
  private listeners = new Set<IntentListener>();

  subscribe(listener: IntentListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCurrentIntent() {
    return this.current;
  }

  restorePendingFocus() {
    if (this.current) return this.current;

    const stored = parseStoredIntent(readStorage(MATERIAL_NAVIGATION_STORAGE_KEY));
    if (stored) {
      this.epoch = Math.max(this.epoch, stored.epoch);
      this.current = stored;
      this.persist();
      return this.current;
    }

    // Migrate only stale asset intents written by the previous generic facade.
    const legacy = readStorage(LEGACY_NAV_FOCUS_KEY);
    try {
      const focus = legacy ? JSON.parse(legacy) as { type?: unknown; id?: unknown; action?: unknown; source?: unknown; ts?: unknown } : null;
      if (focus?.type === "asset" && typeof focus.id === "string" && focus.id) {
        removeStorage(LEGACY_NAV_FOCUS_KEY);
        return this.requestAssetFocus({
          assetId: focus.id,
          action: isAction(focus.action) ? focus.action : "focus",
          source: typeof focus.source === "string" ? focus.source : undefined,
          createdAt: typeof focus.ts === "number" ? focus.ts : undefined,
        });
      }
    } catch {}

    return null;
  }

  requestAssetFocus(input: {
    assetId: string;
    action?: MaterialNavigationAction;
    source?: string;
    createdAt?: number;
  }) {
    const assetId = input.assetId.trim();
    if (!assetId) return null;
    const epoch = ++this.epoch;
    this.current = {
      requestId: createRequestId(epoch),
      assetId,
      action: input.action ?? "focus",
      source: input.source,
      createdAt: input.createdAt ?? Date.now(),
      phase: "received",
      retry: 0,
      epoch,
      filterFallbackApplied: false,
      revalidationPending: false,
    };
    this.persist();
    this.emit();
    return this.current;
  }

  isCurrent(requestId: string) {
    return this.current?.requestId === requestId;
  }

  retrySnapshot(requestId: string) {
    if (!this.isCurrent(requestId) || !this.current || this.current.revalidationPending) return false;
    this.current = { ...this.current, retry: this.current.retry + 1, revalidationPending: true };
    this.persist();
    this.emit();
    return true;
  }

  completeSnapshotRetry(requestId: string) {
    if (!this.isCurrent(requestId) || !this.current || !this.current.revalidationPending) return false;
    this.current = { ...this.current, revalidationPending: false };
    this.persist();
    this.emit();
    return true;
  }

  reportFocusStage(requestId: string, report: MaterialNavigationReport, options?: { filterFallbackApplied?: boolean }) {
    if (!this.isCurrent(requestId) || !this.current) return false;

    if (report === "not-found" || report === "timeout") {
      this.finish();
      return true;
    }

    const intent = this.current;
    let next: MaterialNavigationIntent | null = null;
    if (report === "snapshot-ready" && intent.phase === "received") {
      next = { ...intent, phase: "snapshot-ready" };
    } else if (report === "filter-resolved" && (intent.phase === "received" || intent.phase === "snapshot-ready")) {
      next = { ...intent, phase: "filter-resolved", filterFallbackApplied: Boolean(options?.filterFallbackApplied) || intent.filterFallbackApplied };
    } else if (report === "element-ready" && intent.phase === "filter-resolved") {
      next = { ...intent, phase: "element-ready" };
    } else if (report === "scroll-settled" && (intent.phase === "filter-resolved" || intent.phase === "element-ready")) {
      next = { ...intent, phase: "scroll-settled" };
    } else if (report === "spotlight-applied" && intent.phase === "scroll-settled") {
      if (intent.action === "detail") {
        next = { ...intent, phase: "optional-detail" };
      } else {
        this.finish();
        return true;
      }
    } else if (report === "detail-opened" && intent.phase === "optional-detail") {
      this.finish();
      return true;
    }

    if (!next) return false;
    this.current = next;
    this.persist();
    this.emit();
    return true;
  }

  releasePage(requestId: string) {
    if (!this.isCurrent(requestId) || !this.current) return false;
    this.current = { ...this.current, phase: "received", revalidationPending: false };
    this.persist();
    this.emit();
    return true;
  }

  cancelFocus(requestId?: string) {
    if (!this.current || (requestId && this.current.requestId !== requestId)) return false;
    this.finish();
    return true;
  }

  private persist() {
    if (typeof window === "undefined" || !this.current) return;
    try {
      sessionStorage.setItem(MATERIAL_NAVIGATION_STORAGE_KEY, JSON.stringify(this.current));
    } catch {}
  }

  private finish() {
    this.current = null;
    removeStorage(MATERIAL_NAVIGATION_STORAGE_KEY);
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("luckyray:material-navigation-intent"));
    }
  }
}

export const materialNavigationCoordinator = new MaterialNavigationCoordinator();
