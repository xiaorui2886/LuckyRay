/** Only the drag owner's scroll container is moved; never the whole page. */
export function dragEdgeVelocity(y: number, top: number, bottom: number): number {
  const band = Math.min(36, (bottom - top) / 3);
  if (band <= 0 || y < top || y > bottom) return 0;
  if (y < top + band) return -10 * (1 - (y - top) / band);
  if (y > bottom - band) return 10 * (1 - (bottom - y) / band);
  return 0;
}

export function createDragEdgeScroller() {
  let frame = 0;
  let point: { x: number; y: number; container: HTMLElement; onScroll?: () => void } | null = null;
  const stop = () => { cancelAnimationFrame(frame); frame = 0; point = null; };
  const tick = () => {
    frame = 0;
    if (!point?.container.isConnected) { stop(); return; }
    const { container, x, y, onScroll } = point;
    const box = container.getBoundingClientRect();
    if (x < box.left || x > box.right) { stop(); return; }
    const speed = dragEdgeVelocity(y, box.top, box.bottom);
    if (!speed) { stop(); return; }
    const before = container.scrollTop;
    container.scrollTop += speed;
    if (container.scrollTop !== before) onScroll?.();
    frame = requestAnimationFrame(tick);
  };
  return {
    stop,
    update(container: HTMLElement | null, x: number, y: number, onScroll?: () => void) {
      if (!container) { stop(); return; }
      point = { container, x, y, onScroll };
      if (!frame) frame = requestAnimationFrame(tick);
    },
  };
}
