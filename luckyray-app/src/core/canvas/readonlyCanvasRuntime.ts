import type { BridgeCanvasFile, BridgeCanvasListEntry } from "../bridge/bridgeTypes";

/** Only these reads cross the remote CanvasSpike runtime boundary. This is not
 * a desktop BridgeApi substitute and has no editing or native command surface. */
export type CanvasRemoteReadBridge = {
  listCanvases(signal?: AbortSignal): Promise<BridgeCanvasListEntry[]>;
  loadCanvas(canvasId: string, signal?: AbortSignal): Promise<BridgeCanvasFile>;
};

export function readonlyCanvasMediaUrl(value: string | null | undefined): string {
  return typeof value === "string" && /^\/canvas\/media\/[0-9a-f]{64}$/.test(value) ? value : "";
}

/** Preserve the desktop document, including running/queued task state. Never
 * recover, acknowledge, enqueue, migrate, create, or persist from this reader. */
export async function loadReadonlyCanvasSnapshot(
  bridge: CanvasRemoteReadBridge,
  preferredCanvasId: string | null,
  signal: AbortSignal,
  options: { document?: BridgeCanvasFile | null; force?: boolean } = {},
): Promise<{ canvases: BridgeCanvasListEntry[]; document: BridgeCanvasFile | null }> {
  const active = () => { if (signal.aborted) throw new DOMException("Aborted", "AbortError"); };
  active();
  const canvases = await bridge.listCanvases(signal);
  active();
  if (!Array.isArray(canvases)) throw new Error("canvas-remote-invalid-list");
  const canvasId = preferredCanvasId ?? canvases[0]?.id;
  if (!canvasId) return { canvases, document: null };
  // A revoked/deleted selected canvas must not silently open another document.
  if (!canvases.some(canvas => canvas.id === canvasId)) throw new Error("canvas-remote-unavailable");
  const cached = options.document;
  const entry = canvases.find(canvas => canvas.id === canvasId)!;
  if (!options.force && cached?.canvasId === canvasId && cached.revision === entry.revision
      && typeof cached.contentDigest === "string" && cached.contentDigest === entry.contentDigest) {
    return { canvases: structuredClone(canvases), document: cached };
  }
  const document = await bridge.loadCanvas(canvasId, signal);
  active();
  if (document.canvasId !== canvasId || !Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
    throw new Error("canvas-remote-invalid-document");
  }
  // React Flow gets its own presentation copy, never a mutable server snapshot.
  return { canvases: structuredClone(canvases), document: structuredClone(document) };
}

/** One read at a time, with the next poll scheduled after settlement. Hiding
 * aborts the request and invalidates its result even if a bridge ignores abort.
 * No generation/runtime/DB authority is available to this observer. */
export function watchReadonlyCanvas<T>(options: {
  read(signal: AbortSignal, force: boolean): Promise<T>;
  onSnapshot(snapshot: T): void;
  onError(error: unknown): void;
  onLoading(loading: boolean): void;
}, clock: { set(callback: () => void, delay: number): unknown; clear(handle: unknown): void } = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}) {
  let visible = false, disposed = false, busy = false, again = false, forceNext = true, epoch = 0;
  let timer: unknown;
  let request: AbortController | null = null;
  const clearTimer = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; };
  const run = () => {
    if (!visible || disposed || busy) return;
    clearTimer();
    busy = true;
    again = false;
    const token = ++epoch;
    const force = forceNext; forceNext = false;
    const controller = new AbortController();
    request = controller;
    const current = () => !disposed && visible && epoch === token && !controller.signal.aborted;
    options.onLoading(true);
    void Promise.resolve().then(() => {
      if (!current()) throw new DOMException("Aborted", "AbortError");
      return options.read(controller.signal, force);
    }).then(snapshot => {
      if (current()) options.onSnapshot(snapshot);
    }).catch(error => { if (current()) options.onError(error); }).finally(() => {
      busy = false;
      request = null;
      if (current()) options.onLoading(false);
      if (disposed || !visible) return;
      if (again) run();
      else timer = clock.set(run, 2000);
    });
  };
  return {
    setVisible(next: boolean) {
      if (disposed || visible === next) return;
      visible = next;
      if (!visible) {
        ++epoch;
        clearTimer();
        request?.abort();
        options.onLoading(false);
      } else { again = true; forceNext = true; run(); }
    },
    refresh() { if (!disposed && visible) { again = true; forceNext = true; run(); } },
    dispose() { disposed = true; ++epoch; clearTimer(); request?.abort(); },
  };
}
