import { useLayoutEffect, useRef, type RefObject } from "react";

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; right: number; bottom: number };
const interactive = '[data-asset-id],button,input,select,textarea,a,video,audio,[contenteditable]:not([contenteditable="false"]),[draggable="true"],[role="button"],[role="checkbox"],[role="slider"]';

/** Blank-space selection shares the page's existing batch selection. Card
 * gestures remain owned by the native material drag/detail controls. */
export function useMaterialMarquee({ hostRef, selectedIds, onSelect, context, enabled }: {
  hostRef: RefObject<HTMLDivElement | null>;
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  context: unknown;
  enabled: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ selectedIds, onSelect });
  latest.current = { selectedIds, onSelect };

  useLayoutEffect(() => {
    const host = hostRef.current;
    const overlay = overlayRef.current;
    if (!enabled || !host || !overlay) return;
    const doc = host.ownerDocument;
    const win = doc.defaultView!;
    let gesture: {
      pointerId: number; origin: Point; client: Point; startClient: Point;
      initial: Set<string>; mode: "replace" | "add" | "toggle"; active: boolean;
    } | null = null;
    let frame = 0;
    let lastFrame = 0;
    let consumeClick = false;
    let boundsDirty = true;
    let cards: (Bounds & { id: string })[] = [];

    const viewport = () => {
      const rect = host.getBoundingClientRect();
      return { left: rect.left + host.clientLeft, top: rect.top + host.clientTop,
        right: rect.left + host.clientLeft + host.clientWidth,
        bottom: rect.top + host.clientTop + host.clientHeight };
    };
    const contentPoint = (client: Point, view: Bounds): Point => ({
      x: Math.max(view.left, Math.min(view.right, client.x)) - view.left + host.scrollLeft,
      y: Math.max(view.top, Math.min(view.bottom, client.y)) - view.top + host.scrollTop,
    });
    const invalidate = () => { boundsDirty = true; };
    const finish = (restore: boolean) => {
      const previous = gesture;
      gesture = null;
      win.cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
      overlay.hidden = true;
      host.classList.remove("materials-marquee-active");
      if (previous) {
        consumeClick = previous.active;
        if (host.hasPointerCapture(previous.pointerId)) host.releasePointerCapture(previous.pointerId);
        if (restore && previous.active) latest.current.onSelect(previous.initial);
      }
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", cancel);
      win.removeEventListener("keydown", keyDown, true);
      win.removeEventListener("blur", cancel);
      doc.removeEventListener("visibilitychange", visibilityChange);
      host.removeEventListener("lostpointercapture", cancel);
      host.removeEventListener("load", invalidate, true);
      resize.disconnect();
    };
    const render = (time: number, autoScroll: boolean) => {
      if (!gesture?.active) return;
      const view = viewport();
      if (autoScroll) {
        const edge = Math.min(32, host.clientHeight / 4);
        const y = gesture.client.y;
        const speed = y < view.top + edge ? -Math.min(1, (view.top + edge - y) / edge)
          : y > view.bottom - edge ? Math.min(1, (y - view.bottom + edge) / edge) : 0;
        const elapsed = lastFrame ? Math.min(32, time - lastFrame) : 16;
        if (speed) host.scrollTop += speed * elapsed * 0.8;
      }
      lastFrame = time;
      const end = contentPoint(gesture.client, view);
      const rect = { left: Math.min(end.x, gesture.origin.x), top: Math.min(end.y, gesture.origin.y),
        right: Math.max(end.x, gesture.origin.x), bottom: Math.max(end.y, gesture.origin.y) };
      if (boundsDirty) {
        cards = Array.from(host.querySelectorAll<HTMLElement>("[data-asset-id]")).flatMap(card => {
          const box = card.getBoundingClientRect();
          if (!box.width || !box.height) return [];
          return [{ id: card.dataset.assetId!, left: box.left - view.left + host.scrollLeft,
            top: box.top - view.top + host.scrollTop, right: box.right - view.left + host.scrollLeft,
            bottom: box.bottom - view.top + host.scrollTop }];
        });
        boundsDirty = false;
      }
      Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
      const next = gesture.mode === "replace" ? new Set<string>() : new Set(gesture.initial);
      if (rect.right > rect.left && rect.bottom > rect.top) for (const card of cards) {
        if (card.right <= rect.left || card.left >= rect.right || card.bottom <= rect.top || card.top >= rect.bottom) continue;
        if (gesture.mode === "toggle" && gesture.initial.has(card.id)) next.delete(card.id);
        else next.add(card.id);
      }
      const current = latest.current.selectedIds;
      if (next.size !== current.size || Array.from(next).some(id => !current.has(id))) latest.current.onSelect(next);
    };
    const tick = (time: number) => {
      frame = 0;
      if (!gesture?.active) return;
      render(time, true);
      frame = win.requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (!(event.buttons & 1)) { finish(false); return; }
      gesture.client = { x: event.clientX, y: event.clientY };
      if (!gesture.active) {
        if (Math.hypot(event.clientX - gesture.startClient.x, event.clientY - gesture.startClient.y) < 6) return;
        gesture.active = true;
        boundsDirty = true;
        host.classList.add("materials-marquee-active");
        overlay.hidden = false;
      }
      event.preventDefault();
      if (!frame) frame = win.requestAnimationFrame(tick);
    };
    const up = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture.client = { x: event.clientX, y: event.clientY };
      render(win.performance.now(), false);
      finish(false);
    };
    const cancel = (event: Event) => {
      if (event instanceof win.PointerEvent && gesture && event.pointerId !== gesture.pointerId) return;
      finish(true);
    };
    const visibilityChange = () => { if (doc.hidden) finish(true); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
    };
    const resize = new ResizeObserver(invalidate);
    const down = (event: PointerEvent) => {
      consumeClick = false;
      if (gesture || event.button !== 0 || !event.isPrimary || event.pointerType !== "mouse") return;
      if (!(event.target instanceof Element) || event.target.closest(interactive)) return;
      const view = viewport();
      // Native scrollbars and anything outside this list keep their own gestures.
      if (event.clientX < view.left || event.clientX >= view.right || event.clientY < view.top || event.clientY >= view.bottom) return;
      event.preventDefault();
      host.focus({ preventScroll: true });
      gesture = { pointerId: event.pointerId, origin: contentPoint({ x: event.clientX, y: event.clientY }, view),
        client: { x: event.clientX, y: event.clientY }, startClient: { x: event.clientX, y: event.clientY },
        initial: new Set(latest.current.selectedIds), mode: event.ctrlKey || event.metaKey ? "toggle" : event.shiftKey ? "add" : "replace", active: false };
      host.setPointerCapture(event.pointerId);
      win.addEventListener("pointermove", move, { passive: false });
      win.addEventListener("pointerup", up);
      win.addEventListener("pointercancel", cancel);
      win.addEventListener("keydown", keyDown, true);
      win.addEventListener("blur", cancel);
      doc.addEventListener("visibilitychange", visibilityChange);
      host.addEventListener("lostpointercapture", cancel);
      host.addEventListener("load", invalidate, true);
      resize.observe(host);
      if (host.firstElementChild) resize.observe(host.firstElementChild);
    };
    const click = (event: MouseEvent) => {
      if (!consumeClick) return;
      consumeClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    host.addEventListener("pointerdown", down);
    host.addEventListener("click", click, true);
    // A scope/layout change retires the gesture without restoring a selection
    // from the old folder or library into its replacement.
    return () => {
      finish(false);
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("click", click, true);
    };
  }, [hostRef, context, enabled]);

  return overlayRef;
}
