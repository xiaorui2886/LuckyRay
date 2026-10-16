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
