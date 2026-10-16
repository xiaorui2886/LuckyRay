/** WebView2 native file-drop mode disables HTML5 dragstart. Start the existing
 * native drag from a bounded pointer gesture instead; keep native drop enabled. */
export function createMaterialDragGesture(target: EventTarget, start: () => void) {
  let origin: { pointerId: number; x: number; y: number } | null = null;
  const clear = () => {
    origin = null;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", clear);
    target.removeEventListener("pointercancel", clear);
  };
  const move = (event: Event) => {
    const pointer = event as PointerEvent;
    if (!origin || pointer.pointerId !== origin.pointerId) return;
    if (!(pointer.buttons & 1)) { clear(); return; }
    if (Math.hypot(pointer.clientX - origin.x, pointer.clientY - origin.y) < 6) return;
    clear();
    event.preventDefault();
    start();
  };
  return {
    clear,
    arm(pointer: Pick<PointerEvent, "button" | "pointerId" | "clientX" | "clientY">) {
      clear();
      if (pointer.button !== 0) return;
      origin = { pointerId: pointer.pointerId, x: pointer.clientX, y: pointer.clientY };
      target.addEventListener("pointermove", move, { passive: false });
      target.addEventListener("pointerup", clear, { once: true });
      target.addEventListener("pointercancel", clear, { once: true });
    },
  };
}
