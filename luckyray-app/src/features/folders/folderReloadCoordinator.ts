export type FolderBridgeReadiness = {
  generation: number;
  bridgeInstalled: boolean;
  databaseReady: boolean;
  error?: string | null;
};

type FolderBridge<TFolder> = {
  listFolders(scope: "materials" | "notes"): Promise<TFolder[]>;
};

const sharedFolderLoads = new WeakMap<object, Map<"materials" | "notes", Promise<unknown[]>>>();

function loadFoldersShared<TFolder>(bridge: FolderBridge<TFolder>, scope: "materials" | "notes") {
  let byScope = sharedFolderLoads.get(bridge);
  if (!byScope) {
    byScope = new Map();
    sharedFolderLoads.set(bridge, byScope);
  }
  const existing = byScope.get(scope) as Promise<TFolder[]> | undefined;
  if (existing) return existing;
  let request: Promise<TFolder[]>;
  request = Promise.resolve()
    .then(() => bridge.listFolders(scope))
    .finally(() => {
      if (byScope?.get(scope) === request) byScope.delete(scope);
    });
  byScope.set(scope, request as Promise<unknown[]>);
  return request;
}

type FolderReloadCoordinatorOptions<TFolder> = {
  scope: "materials" | "notes";
  events: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  getBridge(): FolderBridge<TFolder> | null;
  getReadiness(): FolderBridgeReadiness | null;
  onResult(folders: TFolder[]): void;
  onLoading?(loading: boolean): void;
  onError?(error: unknown): void;
};

export type FolderReloadCoordinator = {
  start(): void;
  reload(): Promise<void>;
  whenIdle(): Promise<void>;
  dispose(): void;
};

export function createFolderReloadCoordinator<TFolder>(
  options: FolderReloadCoordinatorOptions<TFolder>,
): FolderReloadCoordinator {
  let active = false;
  let running: Promise<void> | null = null;
  let pending = false;
  let lastBridge: FolderBridge<TFolder> | null = null;
  let lastReadinessKey: string | null = null;
  let lastLoadFailed = false;

  const bridgeSignalChanged = () => {
    const bridge = options.getBridge();
    const readiness = options.getReadiness();
    const readinessKey = readiness
      ? `${readiness.generation}:${readiness.bridgeInstalled ? 1 : 0}:${readiness.databaseReady ? 1 : 0}:${readiness.error || ""}`
      : null;
    const changed = bridge !== lastBridge || readinessKey !== lastReadinessKey;
    lastBridge = bridge;
    lastReadinessKey = readinessKey;
    return changed;
  };

  const run = () => {
    pending = true;
    if (running) return running;
    running = (async () => {
      options.onLoading?.(true);
      while (active && pending) {
        pending = false;
        const bridge = options.getBridge();
        if (!bridge?.listFolders) break;
        try {
          const folders = await loadFoldersShared(bridge, options.scope);
          lastLoadFailed = false;
          if (active && !pending) options.onResult(Array.isArray(folders) ? folders : []);
        } catch (error) {
          lastLoadFailed = true;
          if (active && !pending) options.onError?.(error);
        }
      }
    })().finally(() => {
      if (active) options.onLoading?.(false);
      running = null;
    });
    return running;
  };

  const onBridgeReady = () => {
    if (!bridgeSignalChanged() && !lastLoadFailed) return;
    void run();
  };

  const onFoldersChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ scope?: string }>).detail;
    if (detail?.scope && detail.scope !== options.scope) return;
    void run();
  };

  return {
    start() {
      if (active) return;
      active = true;
      options.events.addEventListener("luckyray:bridge-ready", onBridgeReady);
      options.events.addEventListener("luckyray:folders-changed", onFoldersChanged);
      bridgeSignalChanged();
      void run();
    },
    reload: run,
    whenIdle() {
      return running || Promise.resolve();
    },
    dispose() {
      if (!active) return;
      active = false;
      pending = false;
      options.events.removeEventListener("luckyray:bridge-ready", onBridgeReady);
      options.events.removeEventListener("luckyray:folders-changed", onFoldersChanged);
    },
  };
}
