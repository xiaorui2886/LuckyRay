import type { MaterialAsset } from '../../core/services/materialCatalog';
export type MaterialNativeDetailBinding = { viewId: string; libraryId: string; generation: number; ready?: boolean };
export type MaterialNativeDetailAck = MaterialNativeDetailBinding & { assetId: string; assetRevision: string };
export type MaterialNativeDetailRequest = { libraryId: string; asset: MaterialAsset; assetRevision: string };
export interface MaterialNativeDetailAdapter {
  binding(): MaterialNativeDetailBinding;
  openDetail(request: MaterialNativeDetailRequest): Promise<MaterialNativeDetailAck>;
}
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value; }
export function sameMaterialDetailAsset(a: MaterialAsset, b: MaterialAsset) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
export class MaterialNativeDetailRegistry {
  private views = new Map<string, MaterialNativeDetailAdapter>();
  register(viewId: string, adapter: MaterialNativeDetailAdapter) {
    if (!viewId || this.views.has(viewId)) throw Error('workspace-graph-material-view-already-registered');
    this.views.set(viewId, adapter); return () => { if (this.views.get(viewId) === adapter) this.views.delete(viewId); };
  }
  get(viewId: string) { const adapter = this.views.get(viewId); if (!adapter || adapter.binding().viewId !== viewId) throw Error('workspace-graph-material-view-unavailable'); return adapter; }
}
export const materialNativeDetailViews = new MaterialNativeDetailRegistry();

export type MaterialDetailPaintState = {
  requestId: number; binding: MaterialNativeDetailBinding; asset: MaterialAsset | null;
  mode: string | null; element: HTMLElement | null;
};
export type MaterialDetailFramePort = {
  request(callback: () => void): number;
  cancel(frame: number): void;
  visible(element: HTMLElement): boolean;
};
const browserFrames: MaterialDetailFramePort = {
  request: callback => requestAnimationFrame(callback), cancel: frame => cancelAnimationFrame(frame),
  visible: element => {
    if (!element.isConnected || element.getClientRects().length === 0) return false;
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return true;
  },
};
/** Execute after this request's committed viewer render. The first frame binds
 * the exact instance; the second checks the frame that has now been presented. */
export function observeMaterialDetailPaint(
  requestId: number, expected: MaterialNativeDetailRequest, read: () => MaterialDetailPaintState | null,
  ready: (ack: MaterialNativeDetailAck) => void, failed: (error: Error) => void,
  frames: MaterialDetailFramePort = browserFrames,
) {
  let stopped = false, frame = 0;
  const checked = () => {
    const current = read();
    if (!current || current.requestId !== requestId) throw Error('workspace-graph-material-request-superseded');
    if (current.mode !== 'detail' || current.binding.libraryId !== expected.libraryId || !current.asset || !sameMaterialDetailAsset(current.asset, expected.asset)) throw Error('workspace-graph-material-paint-changed');
    return current;
  };
  const run = () => {
    if (stopped) return;
    try {
      const before = checked(), binding = { ...before.binding }, element = before.element, rect = element?.getBoundingClientRect();
      if (!element || !rect || !frames.visible(element) || rect.width <= 0 || rect.height <= 0) { frame = frames.request(run); return; }
      frame = frames.request(() => {
        if (stopped) return;
        try {
          const after = checked(), actual = element.getBoundingClientRect();
          if (after.element !== element || after.binding.viewId !== binding.viewId || after.binding.generation !== binding.generation
            || !frames.visible(element) || actual.width !== rect.width || actual.height !== rect.height || actual.left !== rect.left || actual.top !== rect.top) throw Error('workspace-graph-material-paint-changed');
          stopped = true; ready({ ...after.binding, assetId: expected.asset.id, assetRevision: expected.assetRevision });
        } catch (error) { stopped = true; failed(error instanceof Error ? error : Error(String(error))); }
      });
    } catch (error) { stopped = true; failed(error instanceof Error ? error : Error(String(error))); }
  };
  frame = frames.request(run);
  return () => { stopped = true; frames.cancel(frame); };
}
