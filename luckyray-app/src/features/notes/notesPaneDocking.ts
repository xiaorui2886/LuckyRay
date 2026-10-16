import type { PointerEvent as ReactPointerEvent } from "react";
import { suppressPointerActivation } from "../../workspace/pointerActivation";
import { notesDockZoneAt, type NotesDockTabRequest, type NotesDockZone } from "./notesPaneModel";

export const NOTES_DOCK_TAB_EVENT = "luckyray:notes-dock-tab";
export type { NotesDockTabRequest } from "./notesPaneModel";
let cancelCurrentDrag: (() => void) | null = null;

/** Shared by the native titlebar and nested pane strips. No HTML5 drag events:
 * Tauri's Windows file-drop handler consumes those, but pointer events work. */
export function beginNotesTabPointerDrag(
  event: ReactPointerEvent<HTMLElement>,
  source: { sourcePaneId: string; tabId: string; title: string },
) {
  if (event.button !== 0 || event.isPrimary === false || (event.target as Element).closest("button, input, textarea, [contenteditable=true]")) return;
  cancelCurrentDrag?.();
  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;
  const owner = event.currentTarget;
  let dragging = false;
  let target: NotesDockTabRequest | null = null;
  let overlay: HTMLDivElement | null = null;
  let ghost: HTMLDivElement | null = null;
  const draw = (rect: DOMRect, zone: NotesDockZone, strip = false) => {
    if (!overlay) return;
    let { left, top, width, height } = rect;
    if (zone === "left" || zone === "right") width /= 2;
    if (zone === "up" || zone === "down") height /= 2;
    if (zone === "right") left += width;
    if (zone === "down") top += height;
    overlay.className = `notes-dock-drop-overlay${strip ? " notes-dock-insertion-marker" : ""}`;
    Object.assign(overlay.style, { display: "block", left: `${left}px`, top: `${top}px`, width: `${Math.max(strip ? 3 : 0, width)}px`, height: `${height}px` });
  };
  const update = (x: number, y: number) => {
    target = null;
    if (overlay) overlay.style.display = "none";
    if (ghost) ghost.style.transform = `translate(${x + 14}px, ${y + 16}px)`;
    const under = document.elementFromPoint(x, y);
    if (!under || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return;
    const strip = under.closest<HTMLElement>("[data-notes-dock-tabs]");
    if (strip) {
      const targetPaneId = strip.dataset.notesDockTabs;
      if (!targetPaneId) return;
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-notes-dock-tab]"));
      const index = tabs.findIndex((tab) => x < tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2);
      const targetIndex = index < 0 ? tabs.length : index;
      const rect = strip.getBoundingClientRect();
      const boundary = tabs[targetIndex]?.getBoundingClientRect().left ?? tabs[tabs.length - 1]?.getBoundingClientRect().right ?? rect.left + 4;
      const marker = new DOMRect(Math.max(rect.left, Math.min(boundary, rect.right - 3)), rect.top + 4, 3, Math.max(0, rect.height - 8));
      draw(marker, "center", true);
      target = { ...source, targetPaneId, zone: "center", targetIndex };
      return;
    }
    const pane = under.closest<HTMLElement>("[data-notes-dock-pane]");
    const targetPaneId = pane?.dataset.notesDockPane;
    if (!pane || !targetPaneId) return;
    const rect = pane.getBoundingClientRect();
    const zone = notesDockZoneAt(rect, x, y);
    if (!zone) return;
    target = { sourcePaneId: source.sourcePaneId, tabId: source.tabId, targetPaneId, zone };
    draw(rect, zone);
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("visibilitychange", visibility);
    owner.removeEventListener("lostpointercapture", cancel);
    if (owner.hasPointerCapture?.(pointerId)) owner.releasePointerCapture(pointerId);
    owner.classList.remove("notes-dock-tab-dragging");
    document.body.classList.remove("notes-dock-dragging");
    overlay?.remove();
    ghost?.remove();
    if (cancelCurrentDrag === cancel) cancelCurrentDrag = null;
  };
  const cancel = () => { if (dragging) suppressPointerActivation(owner, pointerId); cleanup(); };
  const visibility = () => { if (document.hidden) cancel(); };
  const key = (keyboard: KeyboardEvent) => {
    if (keyboard.key !== "Escape") return;
    keyboard.preventDefault();
    keyboard.stopPropagation();
    cancel();
  };
  const move = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 6) return;
    if (!dragging) {
      dragging = true;
      owner.classList.add("notes-dock-tab-dragging");
      document.body.classList.add("notes-dock-dragging");
      overlay = document.createElement("div");
      overlay.setAttribute("aria-hidden", "true");
      ghost = document.createElement("div");
      ghost.className = "notes-dock-tab-ghost";
      ghost.textContent = source.title;
      ghost.setAttribute("aria-hidden", "true");
      document.body.append(overlay, ghost);
      owner.setPointerCapture?.(pointerId);
    }
    pointer.preventDefault();
    update(pointer.clientX, pointer.clientY);
  };
  const up = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    if (!dragging) { cleanup(); return; }
    pointer.preventDefault();
    update(pointer.clientX, pointer.clientY);
    const request = target;
    suppressPointerActivation(owner, pointerId, true);
    cleanup();
    if (request) window.dispatchEvent(new CustomEvent(NOTES_DOCK_TAB_EVENT, { detail: request }));
  };
  event.stopPropagation();
  cancelCurrentDrag = cancel;
  owner.addEventListener("lostpointercapture", cancel);
  window.addEventListener("pointermove", move, { capture: true, passive: false });
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", visibility);
}

export function cancelNotesTabPointerDrag() { cancelCurrentDrag?.(); }
