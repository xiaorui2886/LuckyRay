import type { NativeBounds, NativeFilmTransport } from './nativeFilmTransport';
import { nativeVideoBackdrop } from './nativeVideoBackdrop';

/** Native lies BELOW the WebView; HTML owns all alpha and rounded UI. */
export function videoSurfaceBounds(surface: HTMLElement): NativeBounds {
  const r = surface.getBoundingClientRect(), scale = window.devicePixelRatio;
  return { x: Math.round(r.x * scale), y: Math.round(r.y * scale),
    width: Math.max(1, Math.round(r.width * scale)), height: Math.max(1, Math.round(r.height * scale)) };
}

export function observeVideoSurface(surface: HTMLElement, player: NativeFilmTransport, onError: (e: unknown) => void) {
  const backdrop = nativeVideoBackdrop(surface);
  let raf = 0, last = '', disposed = false;
  const update = () => {
    if (raf || disposed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (disposed) return;
      backdrop.update();
      const bounds = videoSurfaceBounds(surface), key = JSON.stringify(bounds);
      if (last === key) return;
      last = key;
      void player.bounds(bounds).catch(e => { if (!disposed) onError(e); });
    });
  };
  const size = new ResizeObserver(update); size.observe(surface);
  const dom = new MutationObserver(update);
  dom.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  const events = ['resize', 'scroll', 'fullscreenchange'];
  for (const event of events) window.addEventListener(event, update, true);
  update();
  return () => {
    disposed = true; cancelAnimationFrame(raf); size.disconnect(); dom.disconnect();
    for (const event of events) window.removeEventListener(event, update, true);
    backdrop.dispose();
  };
}

/** During a canvas move or card overlap, its decoded DOM frame shares the
 * card's normal stacking. A child HWND below the WebView cannot represent node
 * z-order. Reopen its hole only when uncovered and final bounds are acknowledged.
 * No bounds backlog, timer-based chase or position delay is applied to the card. */
export function observeCanvasVideoSurface(surface: HTMLElement, player: NativeFilmTransport, onError: (e: unknown) => void, onMoving: (moving: boolean) => void) {
  let hole: ReturnType<typeof nativeVideoBackdrop> | null = null;
  // Opening metadata may change the card's aspect ratio. A measured DOM size
  // is not proof that the native surface has already moved to that size.
  let ack = '', raf = 0, pending = false, disposed = false, moving = false;
  const dragging = () => !!surface.closest('.react-flow__node.dragging') || !!surface.closest('.react-flow')?.querySelector('.react-flow__pane.dragging');
  const needsDomPicture = () => {
    if (dragging()) return true;
    const flow = surface.closest('.react-flow'), picture = surface.getBoundingClientRect();
    for (const node of flow?.querySelectorAll<HTMLElement>('.react-flow__node') ?? []) {
      if (node.contains(surface) || node.closest('.react-flow') !== flow) continue;
      const other = node.getBoundingClientRect();
      if (other.width > 0 && other.height > 0 && other.left < picture.right && other.right > picture.left
        && other.top < picture.bottom && other.bottom > picture.top && getComputedStyle(node).visibility !== 'hidden') return true;
    }
    return false;
  };
  const detach = () => {
    hole?.dispose(); hole = null; surface.dataset.nativeVideoLive = 'false';
    if (!moving) {moving = true; onMoving(true);}
  };
  const attach = () => {
    if (!hole) hole = nativeVideoBackdrop(surface);
    hole.update(); surface.dataset.nativeVideoLive = 'true';
    if (moving) {moving = false; onMoving(false);}
  };
  const update = () => {
    if (disposed || pending) return;
    const bounds = videoSurfaceBounds(surface), key = JSON.stringify(bounds);
    if (needsDomPicture()) {detach(); return;}
    if (key === ack) {attach(); return;}
    detach(); pending = true;
    void player.bounds(bounds).then(() => {
      ack = key; pending = false;
      if (disposed) return;
      if (!needsDomPicture() && key === JSON.stringify(videoSurfaceBounds(surface))) attach();
      else signal();
    }).catch(error => {pending = false; if (!disposed) onError(error);});
  };
  const signal = () => {
    if (disposed) return;
    if (needsDomPicture() || JSON.stringify(videoSurfaceBounds(surface)) !== ack) detach();
    if (!raf) raf = requestAnimationFrame(() => {raf = 0; update();});
  };
  detach();
  const size = new ResizeObserver(signal); size.observe(surface);
  const dom = new MutationObserver(signal);
  dom.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden']});
  for (const event of ['resize', 'scroll', 'fullscreenchange']) window.addEventListener(event, signal, true);
  signal();
  return () => {
    disposed = true; cancelAnimationFrame(raf); size.disconnect(); dom.disconnect(); hole?.dispose();
    delete surface.dataset.nativeVideoLive; onMoving(false);
    for (const event of ['resize', 'scroll', 'fullscreenchange']) window.removeEventListener(event, signal, true);
  };
}
