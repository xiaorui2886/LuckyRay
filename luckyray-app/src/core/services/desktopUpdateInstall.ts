/** Native-owned update state. The renderer never handles package bytes or trust settings. */
export type InstallPhase = 'disabled' | 'idle' | 'checking' | 'current' | 'available'
  | 'downloading' | 'verifying' | 'ready' | 'scheduled' | 'preparing' | 'installing' | 'cancelled' | 'error';
export type InstallStatus = Readonly<{
  revision: number;
  phase: InstallPhase;
  version: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  errorCode: string | null;
  canCheck: boolean;
  canDownload: boolean;
  canCancel: boolean;
  canInstall: boolean;
}>;
export type InstallAction = 'status' | 'check' | 'download' | 'cancel' | 'install' | 'restart';
export interface UpdateTransport {
  request(action: InstallAction): Promise<unknown>;
  subscribe(notify: (status: unknown) => void): Promise<() => void>;
}
const phases = new Set<InstallPhase>(['disabled', 'idle', 'checking', 'current', 'available',
  'downloading', 'verifying', 'ready', 'scheduled', 'preparing', 'installing', 'cancelled', 'error']);
export function parseInstallStatus(value: unknown): InstallStatus {
  if (!value || typeof value !== 'object') throw new Error('update-status-invalid');
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0
    || !phases.has(v.phase as InstallPhase)
    || !Number.isSafeInteger(v.downloadedBytes) || (v.downloadedBytes as number) < 0
    || !(v.totalBytes === null || (Number.isSafeInteger(v.totalBytes) && (v.totalBytes as number) >= 0))
    || !(v.version === null || (typeof v.version === 'string' && /^\d+\.\d+\.\d+$/.test(v.version)))
    || !(v.errorCode === null || (typeof v.errorCode === 'string' && /^[a-z0-9-]{1,96}$/.test(v.errorCode)))
    || ['canCheck', 'canDownload', 'canCancel', 'canInstall'].some(key => typeof v[key] !== 'boolean')) {
    throw new Error('update-status-invalid');
  }
  if ((v.canInstall && v.phase !== 'ready')
    || (v.canDownload && v.phase !== 'available')
    || ((v.canInstall || v.canDownload) && !v.version)
    || (v.totalBytes !== null && (v.downloadedBytes as number) > (v.totalBytes as number))) {
    throw new Error('update-status-invalid');
  }
  return Object.freeze({ revision: v.revision, phase: v.phase, version: v.version,
    downloadedBytes: v.downloadedBytes, totalBytes: v.totalBytes, errorCode: v.errorCode,
    canCheck: v.canCheck, canDownload: v.canDownload, canCancel: v.canCancel,
    canInstall: v.canInstall }) as InstallStatus;
}

/** One app-session controller survives Settings unmounts. Native state remains the authority. */
export function createInstallSession(transport: UpdateTransport) {
  let current: InstallStatus | null = null;
  let connectionError: string | null = null;
  let attached: Promise<void> | null = null;
  let detach: (() => void) | null = null;
  let disposed = false;
  let checking: Promise<void> | null = null;
  const operations = new Map<InstallAction, Promise<void>>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  function accept(raw: unknown) {
    if (disposed) return;
    const next = parseInstallStatus(raw);
    if (current && next.revision < current.revision) return;
    current = next; connectionError = null; notify();
  }
  function fail() {
    if (disposed) return;
    connectionError = 'update-connection-failed'; notify();
  }
  function refresh() {
    return checking ??= transport.request('status').then(accept, fail)
      .catch(fail).finally(() => { checking = null; });
  }
  function connect() {
    if (disposed) return Promise.resolve();
    return attached ??= (async () => {
      try {
        // Subscribe before snapshot to close the operation-completion race.
        const off = await transport.subscribe(raw => { try { accept(raw); } catch { fail(); } });
        if (disposed) { off(); return; }
        detach = off;
        await refresh();
      } catch { attached = null; fail(); }
    })();
  }
  function action(op: Exclude<InstallAction, 'status'>) {
    if (disposed) return Promise.reject(new Error('update-session-disposed'));
    const pending = operations.get(op);
    if (pending) return pending;
    const allowed = current && !connectionError && ({check: current.canCheck, download: current.canDownload,
      cancel: current.canCancel, install: current.canInstall,
      restart: current.canInstall || current.phase === 'scheduled'})[op];
    if (!allowed) return Promise.reject(new Error('update-action-unavailable'));
    // Cancel is allowed alongside a still-pending download request.
    const promise = transport.request(op).then(accept).catch(error => {
      fail(); throw error;
    }).finally(() => { operations.delete(op); notify(); });
    operations.set(op, promise); notify();
    return promise;
  }
  return {
    connect, refresh, reconnect: async () => { await connect(); await refresh(); }, action,
    snapshot: () => ({status: current, connectionError, pending: new Set(operations.keys())}),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; detach?.(); detach = null; listeners.clear(); },
  };
}

let shared: ReturnType<typeof createInstallSession> | undefined;
export function desktopInstallSession() {
  return shared ??= createInstallSession({
    async request(action) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('desktop_application_update', { action });
    },
    async subscribe(notify) {
      const { listen } = await import('@tauri-apps/api/event');
      return listen('luckyray:desktop-update-status', event => notify(event.payload));
    },
  });
}
