import { suppressPointerActivation } from '../../workspace/pointerActivation';
import { graphSessionStore } from './graphSessionStore';
import {graphNativeViews} from './graphNativeViewRegistry';

type StartPointer = { button: number; pointerId: number; clientX: number; clientY: number; currentTarget: EventTarget | null; target?: EventTarget | null; preventDefault: () => void; stopPropagation: () => void };
type Target = { kind: 'tabs'; groupId: string; index: number; rect: DOMRect; markerX: number } | { kind: 'pane'; groupId: string; edge: 'center' | 'left' | 'right' | 'top' | 'bottom'; rect: DOMRect };
let cancelCurrent: (() => void) | null = null;

/** Local pointer DND only. It never installs or disables HTML drag-and-drop. */
export function beginGraphTabPointerDrag(event: StartPointer, tab: { tabId: string; title: string }) {
  if (graphNativeViews.hasFrozenViews()) return;
  if (event.button !== 0 || !graphSessionStore.getSnapshot().views[tab.tabId]) return;
  if (event.target instanceof Element && event.target.closest('[data-graph-tab-close], .graph-tab-close-react')) return;
  cancelCurrent?.();
  const source = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const pointerId = event.pointerId, startX = event.clientX, startY = event.clientY;
  let dragging = false, target: Target | null = null, ghost: HTMLDivElement | null = null, preview: HTMLDivElement | null = null;
  const findTarget = (x: number, y: number): Target | null => {
    const hit = document.elementFromPoint(x, y);
    const strip = hit?.closest<HTMLElement>('[data-graph-tab-strip]');
    if (strip) {
      const groupId = strip.dataset.graphTabStrip!;
      const group = graphSessionStore.getSnapshot().groups.find(item => item.id === groupId);
      if (!group) return null;
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-graph-tab-id]')).filter(item => item.dataset.graphTabId !== tab.tabId);
      const before = tabs.find(item => { const rect = item.getBoundingClientRect(); return x < rect.left + rect.width / 2; });
      const index = before ? group.tabIds.filter(id => id !== tab.tabId).indexOf(before.dataset.graphTabId!) : group.tabIds.filter(id => id !== tab.tabId).length;
      const rect = strip.getBoundingClientRect();
      const markerX = before ? before.getBoundingClientRect().left : tabs[tabs.length - 1]?.getBoundingClientRect().right || rect.left;
      return { kind: 'tabs', groupId, index, rect, markerX };
    }
    const pane = hit?.closest<HTMLElement>('[data-graph-drop-group]');
    if (!pane) return null;
    const rect = pane.getBoundingClientRect(), dx = x - rect.left, dy = y - rect.top;
    const nx = dx / Math.max(1, rect.width), ny = dy / Math.max(1, rect.height);
    const distances = [{ edge: 'left' as const, distance: nx }, { edge: 'right' as const, distance: 1 - nx }, { edge: 'top' as const, distance: ny }, { edge: 'bottom' as const, distance: 1 - ny }].sort((a, b) => a.distance - b.distance);
    const edge = distances[0].distance < .24 ? distances[0].edge : 'center';
    const groupId = pane.dataset.graphDropGroup!;
    const group = graphSessionStore.getSnapshot().groups.find(item => item.id === groupId);
    if (!group || (edge !== 'center' && group.tabIds.length === 1 && group.tabIds[0] === tab.tabId)) return null;
    return { kind: 'pane', groupId, edge, rect };
  };
  const renderPreview = () => {
    if (!preview) return;
    preview.style.display = target ? 'block' : 'none';
    if (!target) return;
    const rect = target.rect;
    if (target.kind === 'tabs') {
      Object.assign(preview.style, { left: `${target.markerX - 1}px`, top: `${rect.top + 4}px`, width: '3px', height: `${rect.height - 8}px` });
      preview.className = 'graph-tab-drop-preview insertion';
    } else {
      let { left, top, width, height } = rect;
      if (target.edge === 'left' || target.edge === 'right') { width /= 2; if (target.edge === 'right') left += width; }
      if (target.edge === 'top' || target.edge === 'bottom') { height /= 2; if (target.edge === 'bottom') top += height; }
      Object.assign(preview.style, { left: `${left + 3}px`, top: `${top + 3}px`, width: `${Math.max(0, width - 6)}px`, height: `${Math.max(0, height - 6)}px` });
      preview.className = 'graph-tab-drop-preview';
    }
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
    source?.removeEventListener('lostpointercapture', cancel);
    if (source?.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId);
    ghost?.remove(); preview?.remove();
    document.documentElement.classList.remove('graph-tab-dragging');
    cancelCurrent = null;
  };
  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    if(graphNativeViews.hasFrozenViews()){cancel();return;}
    if (!dragging && Math.hypot(next.clientX - startX, next.clientY - startY) < 5) return;
    next.preventDefault();
    if (!dragging) {
      dragging = true;
      source?.setPointerCapture(pointerId);
      source?.addEventListener('lostpointercapture', cancel);
      ghost = document.createElement('div'); ghost.className = 'graph-tab-drag-ghost'; ghost.textContent = tab.title;
      preview = document.createElement('div'); preview.className = 'graph-tab-drop-preview';
      document.body.append(preview, ghost);
      document.documentElement.classList.add('graph-tab-dragging');
    }
    Object.assign(ghost!.style, { left: `${next.clientX + 13}px`, top: `${next.clientY + 13}px` });
    target = findTarget(next.clientX, next.clientY); renderPreview();
  };
  const cancel = () => { if (dragging && source) suppressPointerActivation(source, pointerId); cleanup(); };
  const key = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); next.stopPropagation(); cancel(); } };
  const end = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    if(graphNativeViews.hasFrozenViews()){cancel();return;}
    if (dragging) {
      next.preventDefault(); next.stopPropagation();
      target = findTarget(next.clientX, next.clientY);
      if (source) suppressPointerActivation(source, pointerId, true);
      if (target?.kind === 'tabs') graphSessionStore.move(tab.tabId, target.groupId, target.index);
      else if (target?.kind === 'pane') {
        if (target.edge === 'center') graphSessionStore.move(tab.tabId, target.groupId);
        else graphSessionStore.split(tab.tabId, target.edge === 'left' || target.edge === 'right' ? 'row' : 'column', { move: true, before: target.edge === 'left' || target.edge === 'top', targetGroupId: target.groupId });
      }
    }
    cleanup();
  };
  window.addEventListener('pointermove', move, { capture: true, passive: false });
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
  cancelCurrent = cancel;
}
