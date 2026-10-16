export type PersonalBrowserStatus = {
  sessionId: string;
  status: "starting" | "idle" | "loading" | "loaded" | "error" | "closed";
  origin: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  generation: number;
  controlMode: "user-only";
  agentAutomation: "unavailable";
  networkIsolation: "top-level-only";
  privateSubresourcePrevention: "not-guaranteed";
};

export type PersonalBrowserViewport = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
};

export type PersonalBrowserTabsState = {
  ids: string[];
  activeId: string;
};

export type PersonalBrowserTabsAction =
  | { type: "add"; id: string }
  | { type: "select"; id: string }
  | { type: "close"; id: string; replacementId?: string };

export const PERSONAL_BROWSER_MAX_TABS = 8;

export function createPersonalBrowserTabsState(initialId: string): PersonalBrowserTabsState {
  return { ids: [initialId], activeId: initialId };
}

export function reducePersonalBrowserTabsState(
  state: PersonalBrowserTabsState,
  action: PersonalBrowserTabsAction,
): PersonalBrowserTabsState {
  if (action.type === "add") {
    if (state.ids.includes(action.id) || state.ids.length >= PERSONAL_BROWSER_MAX_TABS) return state;
    return { ids: [...state.ids, action.id], activeId: action.id };
  }
  if (action.type === "select") {
    return state.ids.includes(action.id) ? { ...state, activeId: action.id } : state;
  }
  if (!state.ids.includes(action.id)) return state;
  if (state.ids.length === 1 && action.replacementId && action.replacementId !== action.id) {
    return { ids: [action.replacementId], activeId: action.replacementId };
  }
  const closingIndex = state.ids.indexOf(action.id);
  const ids = state.ids.filter((id) => id !== action.id);
  if (state.activeId !== action.id) return { ...state, ids };
  return {
    ids,
    activeId: ids[Math.max(0, closingIndex - 1)] ?? ids[0] ?? "",
  };
}

type BrowserCommand = "back" | "forward" | "reload" | "stop" | "status";
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type PersonalBrowserLifecycleClient = Pick<
  ReturnType<typeof createPersonalBrowserClient>,
  "open" | "close"
>;

export type PersonalBrowserLifecycleObserver = {
  onStatus: (status: PersonalBrowserStatus) => void;
  onError: (reason: unknown) => void;
};

export type PersonalBrowserLifecycleOwner = {
  publish: (status: PersonalBrowserStatus) => boolean;
  fail: (reason: unknown) => boolean;
  isActive: () => boolean;
  release: () => void;
};

export function normalizePersonalBrowserAddress(input: string): string {
  const value = input.trim();
  if (!value || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("browser-navigation-invalid");
  }
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("browser-navigation-invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error("browser-navigation-invalid");
  }
  return parsed.toString();
}

export function createPersonalBrowserClient(invoke: Invoke = invokeTauri) {
  const execute = async (
    command: BrowserCommand,
    current: PersonalBrowserStatus,
  ): Promise<PersonalBrowserStatus> => invoke(`browser_personal_${command}`, {
    sessionId: current.sessionId,
    expectedGeneration: current.generation,
  });

  return {
    open: () => invoke<PersonalBrowserStatus>("browser_personal_open"),
    navigate: (current: PersonalBrowserStatus, input: string) => invoke<PersonalBrowserStatus>(
      "browser_personal_navigate",
      {
        sessionId: current.sessionId,
        expectedGeneration: current.generation,
        url: normalizePersonalBrowserAddress(input),
      },
    ),
    back: (current: PersonalBrowserStatus) => execute("back", current),
    forward: (current: PersonalBrowserStatus) => execute("forward", current),
    reload: (current: PersonalBrowserStatus) => execute("reload", current),
    stop: (current: PersonalBrowserStatus) => execute("stop", current),
    status: (current: PersonalBrowserStatus) => execute("status", current),
    close: (current: PersonalBrowserStatus) => invoke<PersonalBrowserStatus>("browser_personal_close", {
      sessionId: current.sessionId,
      expectedGeneration: current.generation,
    }),
  };
}

export function createEmbeddedPersonalBrowserClient(
  getViewport: () => PersonalBrowserViewport | null,
  invoke: Invoke = invokeTauri,
) {
  const client = createPersonalBrowserClient(invoke);
  return {
    ...client,
    open: () => {
      const viewport = getViewport();
      if (!viewport) return Promise.reject(new Error("browser-viewport-unavailable"));
      return invoke<PersonalBrowserStatus>("browser_personal_open", { viewport });
    },
    setViewport: (current: PersonalBrowserStatus, viewport: PersonalBrowserViewport) => (
      invoke<PersonalBrowserStatus>("browser_personal_set_viewport", {
        sessionId: current.sessionId,
        expectedGeneration: current.generation,
        viewport,
      })
    ),
  };
}

export function createLatestBrowserStatusGate(
  publish: (status: PersonalBrowserStatus) => void,
) {
  let epoch = 0;
  let disposed = false;
  return {
    begin() {
      epoch += 1;
      return epoch;
    },
    publish(requestEpoch: number, status: PersonalBrowserStatus) {
      if (!disposed && requestEpoch === epoch) publish(status);
    },
    invalidate() {
      epoch += 1;
    },
    dispose() {
      disposed = true;
      epoch += 1;
    },
  };
}

export function createPersonalBrowserLifecycleCoordinator(
  client: PersonalBrowserLifecycleClient,
) {
  let nextOwnerId = 0;
  let activeOwnerId: number | null = null;
  let current: PersonalBrowserStatus | null = null;
  let opening: Promise<PersonalBrowserStatus> | null = null;
  let closing: Promise<unknown> | null = null;
  let closeTicket = 0;
  const owners = new Map<number, PersonalBrowserLifecycleObserver>();

  const notifyActive = (status: PersonalBrowserStatus) => {
    if (activeOwnerId === null) return;
    owners.get(activeOwnerId)?.onStatus(status);
  };

  const closeWhenUnowned = () => {
    if (owners.size !== 0 || !current) return;
    const ticket = ++closeTicket;
    queueMicrotask(() => {
      if (ticket !== closeTicket || owners.size !== 0 || !current) return;
      const closingStatus = current;
      current = null;
      closing = client.close(closingStatus).catch(() => undefined).finally(() => {
        closing = null;
        if (owners.size !== 0) ensureOpen();
      });
    });
  };

  const ensureOpen = () => {
    closeTicket += 1;
    if (current) {
      notifyActive(current);
      return;
    }
    if (opening || owners.size === 0) return;
    if (closing) {
      void closing.finally(() => ensureOpen());
      return;
    }
    const pending = client.open();
    opening = pending;
    void pending.then((status) => {
      if (opening !== pending) return;
      opening = null;
      current = status;
      if (owners.size === 0) closeWhenUnowned();
      else notifyActive(status);
    }).catch((reason) => {
      if (opening !== pending) return;
      opening = null;
      if (activeOwnerId !== null) owners.get(activeOwnerId)?.onError(reason);
    });
  };

  return {
    acquire(observer: PersonalBrowserLifecycleObserver): PersonalBrowserLifecycleOwner {
      const ownerId = ++nextOwnerId;
      let released = false;
      owners.set(ownerId, observer);
      activeOwnerId = ownerId;
      ensureOpen();

      const isActive = () => !released && activeOwnerId === ownerId && owners.has(ownerId);
      return {
        publish(status) {
          if (!isActive() || !current || status.sessionId !== current.sessionId) return false;
          current = status;
          observer.onStatus(status);
          return true;
        },
        fail(reason) {
          if (!isActive()) return false;
          observer.onError(reason);
          return true;
        },
        isActive,
        release() {
          if (released) return;
          released = true;
          owners.delete(ownerId);
          if (activeOwnerId === ownerId) {
            const remainingOwnerIds = Array.from(owners.keys());
            activeOwnerId = remainingOwnerIds.length === 0
              ? null
              : remainingOwnerIds[remainingOwnerIds.length - 1] ?? null;
            if (activeOwnerId !== null && current) notifyActive(current);
          }
          closeWhenUnowned();
        },
      };
    },
  };
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}
