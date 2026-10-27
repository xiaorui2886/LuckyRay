import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CanvasAgentBlackHole } from './CanvasAgentBlackHole';
import { clampOrbPoint, decodeOrbPosition, encodeOrbPosition, ORB_DRAG_THRESHOLD, type OrbBounds, type OrbPoint } from './canvasAgentOrbPlacement';
import { useCanvasAgentOrbPlacement } from './useCanvasAgentOrbPlacement';
import './canvasAgentOrb.css';

type Props = { busy: boolean; unavailable: boolean; english: boolean; controls?: string; onOpen: () => void };
type Gesture = { pointerId: number; startClient: OrbPoint; start: OrbPoint; point: OrbPoint; moved: boolean };
/** Launcher placement belongs to the canvas viewport, never the transformed ReactFlow layer. */
export function CanvasAgentOrb({ busy, unavailable, english, controls, onOpen }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const { placement, update, saveFailed } = useCanvasAgentOrbPlacement();
  const [bounds, setBounds] = useState<OrbBounds | null>(null);
  const [origin, setOrigin] = useState<OrbPoint>({ x: 0, y: 0 });
  const [preview, setPreview] = useState<OrbPoint | null>(null);
  const status = busy ? english ? 'Working' : '正在处理' : unavailable ? english ? 'Connection unavailable' : '连接暂不可用' : english ? 'Ready' : '就绪';
  const container = () => button.current?.closest<HTMLElement>('.canvas-editor-body') ?? button.current?.parentElement;
  const geometry = () => {
    const parent = container(), target = button.current;
    if (!parent || !target) return null;
    const rect = parent.getBoundingClientRect();
    const width = parent.clientWidth || rect.width, height = parent.clientHeight || rect.height;
    if (width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0) return null;
    // client coordinates are CSS pixels; account for an outer CSS transform without devicePixelRatio.
    const scaleX = rect.width / (parent.offsetWidth || width), scaleY = rect.height / (parent.offsetHeight || height);
    const orb = target.getBoundingClientRect();
    const local = target.parentElement;
    const localRect = local?.getBoundingClientRect();
    const origin = local && local !== parent && localRect ? { x: (localRect.left - rect.left) / scaleX - parent.clientLeft + local.clientLeft, y: (localRect.top - rect.top) / scaleY - parent.clientTop + local.clientTop } : { x: 0, y: 0 };
    return { bounds: { width, height }, origin, scaleX, scaleY, point: { x: (orb.left - rect.left) / scaleX - parent.clientLeft, y: (orb.top - rect.top) / scaleY - parent.clientTop } };
  };
  useLayoutEffect(() => {
    const parent = container();
    if (!parent) return;
    const measure = () => { const current = geometry(); if (current) { setBounds(previous => previous?.width === current.bounds.width && previous?.height === current.bounds.height ? previous : current.bounds); setOrigin(previous => previous.x === current.origin.x && previous.y === current.origin.y ? previous : current.origin); } };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(parent); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const cancel = () => {
    const active = gesture.current; gesture.current = null; setPreview(null);
    if (active?.moved) suppressClick.current = true;
    if (active && button.current?.hasPointerCapture?.(active.pointerId)) button.current.releasePointerCapture(active.pointerId);
  };
  useEffect(() => { if (placement.locked) cancel(); }, [placement.locked]);
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const current = geometry(); if (!current) { cancel(); return; }
    const dx = (event.clientX - active.startClient.x) / current.scaleX, dy = (event.clientY - active.startClient.y) / current.scaleY;
    if (!active.moved && Math.hypot(dx, dy) < ORB_DRAG_THRESHOLD) return;
    event.preventDefault(); active.moved = true;
    active.point = clampOrbPoint({ x: active.start.x + dx, y: active.start.y + dy }, current.bounds);
    setBounds(current.bounds); setOrigin(current.origin); setPreview(active.point);
  };
  const point = preview && bounds ? clampOrbPoint(preview, bounds) : placement.position && bounds ? decodeOrbPosition(placement.position, bounds) : null;
  const help = english ? 'Drag to reposition; arrow keys move, Shift for fine adjustment. Lock in Canvas settings.' : '拖动调整位置；方向键移动，Shift 精细调整。可在画布设置中锁定。';
  return <button ref={button} type="button" className={`canvas-agent-orb nodrag nopan${busy ? ' is-busy' : ''}${unavailable ? ' is-unavailable' : ''}${placement.locked ? ' is-position-locked' : ' is-draggable'}${preview ? ' is-dragging' : ''}`}
    style={point ? { left: point.x - origin.x, top: point.y - origin.y, right: 'auto', bottom: 'auto' } : undefined}
    aria-label={english ? 'Expand Agent' : '展开 Agent'} aria-description={placement.locked ? (english ? 'Position locked' : '位置已锁定') : help} aria-expanded="false" aria-controls={controls}
    title={`Agent · ${status}${placement.locked ? '' : ` · ${english ? 'Drag to move' : '可拖动'}`}`}
    onPointerDown={event => {
      event.stopPropagation(); suppressClick.current = false;
      if (placement.locked || event.button !== 0 || event.isPrimary === false || gesture.current) return;
      const current = geometry(); if (!current) return;
      gesture.current = { pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, start: current.point, point: current.point, moved: false };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { gesture.current = null; }
    }} onPointerMove={move}
    onPointerUp={event => {
      const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return;
      event.stopPropagation(); gesture.current = null;
      if (active.moved) {
        event.preventDefault(); suppressClick.current = true;
        const current = geometry(); if (current) update({ position: encodeOrbPosition(active.point, current.bounds) });
      }
      setPreview(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={event => { if (gesture.current?.pointerId === event.pointerId) { event.stopPropagation(); cancel(); } }}
    onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) cancel(); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
      if (placement.locked || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const current = geometry(); if (!current) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 1 : 10;
      const start = placement.position ? decodeOrbPosition(placement.position, current.bounds) : current.point;
      update({ position: encodeOrbPosition(clampOrbPoint({ x: start.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), y: start.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }, current.bounds), current.bounds) });
    }} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; event.preventDefault(); return; } suppressClick.current = false; onOpen(); }}>
    <CanvasAgentBlackHole busy={busy} unavailable={unavailable} />
    <span className="canvas-agent-orb-status" aria-hidden="true" />
    <span className="canvas-r1-agent-sr-only" role="status">{saveFailed ? english ? 'Position could not be saved' : '位置未能保存' : status}</span>
  </button>;
}
