import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ReferenceEntry } from "../../core/canvas/referencePlan";
import { planReferenceReorder } from "../../core/canvas/referenceReorder";

// HTML drag/drop enters the native file-drag path in Windows WebView. Keep this
// entirely in the pointer stream, including release outside the reference tray.
export function useReferencePointerReorder(
  scope: string,
  entries: readonly ReferenceEntry[],
  reorder: ((from: string, to: string) => void) | undefined,
  closePreview: () => void,
) {
  const latest = useRef({ entries, reorder, closePreview });
  latest.current = { entries, reorder, closePreview };
  const stripRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const gesture = useRef<{
    key: string; pointerId: number; x: number; y: number;
    button: HTMLButtonElement; active: boolean;
  } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const finish = () => {
    const current = gesture.current;
    gesture.current = null;
    if (current?.button.hasPointerCapture?.(current.pointerId)) {
      current.button.releasePointerCapture(current.pointerId);
    }
    setDragKey(null);
    setDropKey(null);
  };
  const targetAt = (x: number, y: number, from: string) => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-reference-key]");
    const key = target?.dataset.referenceKey;
    return target && stripRef.current?.contains(target) && key &&
      planReferenceReorder(latest.current.entries, from, key) ? key : null;
  };
  useEffect(() => {
    const cancel = () => finish();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
      finish();
    };
  }, [scope]);

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>, key: string) => {
    if (event.button !== 0 || event.isPrimary === false || gesture.current) return;
    suppressClick.current = false;
    if (!latest.current.reorder) return;
    event.stopPropagation();
    gesture.current = { key, pointerId: event.pointerId, x: event.clientX, y: event.clientY, button: event.currentTarget, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
    event.preventDefault();
    if (!current.active) {
      current.active = true;
      suppressClick.current = true;
      latest.current.closePreview();
      setDragKey(current.key);
    }
    setDropKey(targetAt(event.clientX, event.clientY, current.key));
  };
  const pointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const target = current.active ? targetAt(event.clientX, event.clientY, current.key) : null;
    if (current.active) event.preventDefault();
    finish(); // Clear first: lostcapture/re-entrant updates cannot commit twice.
    if (target) latest.current.reorder?.(current.key, target);
  };
  const pointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.pointerId === event.pointerId) finish();
  };
  return { stripRef, suppressClick, dragKey, dropKey, pointerDown, pointerMove, pointerUp, pointerCancel };
}
