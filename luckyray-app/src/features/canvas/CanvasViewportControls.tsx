import {useEffect, useRef, useState, type RefObject, type MutableRefObject} from 'react';
import {useReactFlow, useStore} from '@xyflow/react';
import {CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM, createCanvasZoomMotion, parseCanvasZoomPercent, wheelZoomFactor, type CanvasViewport} from '../../core/canvas/viewportNavigation';
import './canvasViewportControls.css';
const INTERACTIVE = '.nowheel, .react-flow__panel, .react-flow__minimap, input, textarea, select, button, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]';
type Props = {stage: RefObject<HTMLDivElement | null>; motionActive: MutableRefObject<boolean>; cancelMotion?: MutableRefObject<(() => void) | null>; reducedMotion: boolean; scrollToPan: boolean; english: boolean; onSettled: (viewport: CanvasViewport) => void};
export function CanvasViewportControls({stage, motionActive, cancelMotion, reducedMotion, scrollToPan, english, onSettled}: Props) {
  const flow = useReactFlow();
  const zoom = useStore(s => s.transform[2]);
  const selected = useStore(s => s.nodes.some(n => n.selected));
  const root = useRef<HTMLDivElement>(null), callbacks = useRef({onSettled, reducedMotion, scrollToPan});
  callbacks.current = {onSettled, reducedMotion, scrollToPan};
  const [open, setOpen] = useState(false), [draft, setDraft] = useState('100'), [invalid, setInvalid] = useState(false);
  const motion = useRef<ReturnType<typeof createCanvasZoomMotion> | null>(null);
  const stopAll = useRef<(() => void) | null>(null);
  const center = () => { const r = stage.current?.querySelector('.react-flow')?.getBoundingClientRect(); return {x: (r?.width ?? 0)/2, y: (r?.height ?? 0)/2}; };
  const fit = (selection = false) => {
    stopAll.current?.(); setOpen(false);
    const nodes = selection ? flow.getNodes().filter(n => n.selected) : flow.getNodes();
    if (!nodes.length) { motion.current?.zoomTo(1, center(), callbacks.current.reducedMotion); return; }
    void flow.fitView({nodes, padding: .2, minZoom: CANVAS_MIN_ZOOM, maxZoom: 1, duration: callbacks.current.reducedMotion ? 0 : 180});
  };
  const fitRef = useRef(fit); fitRef.current = fit;
  useEffect(() => {
    const pane = stage.current?.querySelector<HTMLElement>('.react-flow'); if (!pane) return;
    const camera = createCanvasZoomMotion({read: () => flow.getViewport(), write: v => { void flow.setViewport(v, {duration: 0}).then(ok => { if (!ok) camera.cancel(false); }).catch(() => camera.cancel(false)); }, requestFrame: callback => window.requestAnimationFrame(callback), cancelFrame: id => window.cancelAnimationFrame(id),
      onActive: value => { motionActive.current = value; }, onSettled: v => callbacks.current.onSettled(v)});
    motion.current = camera;
    const stop = () => { camera.cancel(); void flow.setViewport(flow.getViewport(), {duration: 0}); };
    stopAll.current = stop; if (cancelMotion) cancelMotion.current = stop;
    const wheel = (event: WheelEvent) => {
      if (!(event.target instanceof Element) || event.buttons) return;
      if (event.target.closest('.react-flow__minimap')) { camera.cancel(); return; }
      if (event.target.closest('.react-flow__panel')) { if (event.ctrlKey || event.metaKey) event.preventDefault(); return; }
      if (event.target.closest(INTERACTIVE)) {
        // Keep native editor scrolling, but do not let ReactFlow's bubble listener pan/zoom it.
        event.stopPropagation(); if (event.ctrlKey || event.metaKey) event.preventDefault(); return;
      }
      if (callbacks.current.scrollToPan && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pane.clientHeight : 1;
        camera.pan((event.shiftKey ? event.deltaY : event.deltaX) * factor, event.shiftKey ? 0 : event.deltaY * factor, callbacks.current.reducedMotion);
        return;
      }
      if (!event.deltaY) return;
      event.preventDefault(); event.stopPropagation();
      const rect = pane.getBoundingClientRect();
      camera.wheel(wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey), {x: event.clientX-rect.left, y: event.clientY-rect.top}, callbacks.current.reducedMotion);
    };
    const interrupt = (event: Event) => { if (event.target instanceof Element && event.target.closest('.canvas-zoom-controls')) { void flow.setViewport(flow.getViewport(), {duration: 0}); return; } stop(); };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !stage.current || stage.current.offsetParent === null) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"]')) return;
      // Only the focused/hovered canvas owns shortcuts, never settings or another editor.
      if (!stage.current.contains(document.activeElement) && !pane.matches(':hover')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && ['+','=','-','0','1'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === '0') fitRef.current(false);
        else if (event.key === '1') camera.zoomTo(1, center(), callbacks.current.reducedMotion);
        else camera.step(event.key === '-' ? -1 : 1, center(), callbacks.current.reducedMotion);
      } else if (event.shiftKey && !modifier && (event.key === '1' || event.code === 'Digit1')) { event.preventDefault(); fitRef.current(false); }
      else if (event.shiftKey && !modifier && (event.key === '2' || event.code === 'Digit2')) { event.preventDefault(); fitRef.current(true); }
    };
    pane.addEventListener('wheel', wheel, {capture: true, passive: false});
    document.addEventListener('pointerdown', interrupt, true);
    window.addEventListener('blur', interrupt);
    window.addEventListener('keydown', key);
    return () => { pane.removeEventListener('wheel',wheel,true); document.removeEventListener('pointerdown',interrupt,true); window.removeEventListener('blur',interrupt); window.removeEventListener('keydown',key); camera.cancel(false); motion.current = null; stopAll.current = null; if (cancelMotion?.current === stop) cancelMotion.current = null; };
  }, [flow, stage, motionActive, cancelMotion]);
  useEffect(() => { stopAll.current?.(); }, [reducedMotion, scrollToPan]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.canvas-zoom-percentage')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',escape); };
  }, [open]);
  const apply = () => { const value = parseCanvasZoomPercent(draft); if (value === null) { setInvalid(true); return; } motion.current?.zoomTo(value, center(), reducedMotion); setOpen(false); };
  const set = (value: number) => { motion.current?.zoomTo(value,center(),reducedMotion); setOpen(false); };
  return <div className="canvas-zoom-controls nodrag nopan nowheel" ref={root}>
    <button type="button" aria-label={english?'Zoom out':'缩小'} title={english?'Zoom out · Ctrl −':'缩小 · Ctrl −'} disabled={zoom <= CANVAS_MIN_ZOOM+.0001} onClick={() => motion.current?.step(-1,center(),reducedMotion)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12"/></svg></button>
    <button type="button" className="canvas-zoom-percentage" aria-label={english?'Zoom options':'缩放选项'} aria-haspopup="dialog" aria-expanded={open} onClick={() => {setDraft(String(Math.round(zoom*100))); setInvalid(false); setOpen(v=>!v);}}>{Math.round(zoom*100)}<span>%</span></button>
    <button type="button" aria-label={english?'Zoom in':'放大'} title={english?'Zoom in · Ctrl +':'放大 · Ctrl +'} disabled={zoom >= CANVAS_MAX_ZOOM-.0001} onClick={() => motion.current?.step(1,center(),reducedMotion)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M10 4v12"/></svg></button>
    {open && <div className="canvas-zoom-menu" role="dialog" aria-label={english?'Canvas zoom':'画布缩放'}>
      <form onSubmit={e=>{e.preventDefault();apply();}}><label><span>{english?'Zoom':'缩放比例'}</span><div><input aria-label={english?'Zoom percentage':'缩放百分比'} aria-invalid={invalid} inputMode="decimal" value={draft} onChange={e=>{setDraft(e.target.value);setInvalid(false);}} autoFocus onFocus={e=>e.target.select()}/><span>%</span></div></label><button type="submit">{english?'Apply':'应用'}</button></form>
      {invalid && <p role="alert">{english?'Enter a number from 8 to 800.':'请输入 8–800 之间的数字。'}</p>}
      <div className="canvas-zoom-presets">{[.25,.5,1,2,4,8].map(z=><button type="button" key={z} aria-pressed={Math.abs(zoom-z)<.005} onClick={()=>set(z)}>{z*100}%</button>)}</div>
      <button type="button" className="canvas-zoom-command" onClick={()=>fit()}><span>{english?'Fit all':'显示全部内容'}</span><kbd>Ctrl 0</kbd></button>
      <button type="button" className="canvas-zoom-command" disabled={!selected} onClick={()=>fit(true)}><span>{english?'Fit selection':'聚焦所选内容'}</span><kbd>Shift 2</kbd></button>
      <button type="button" className="canvas-zoom-command" onClick={()=>set(1)}><span>{english?'Actual size':'回到 100%'}</span><kbd>Ctrl 1</kbd></button>
      <small>{english ? (scrollToPan?'Scroll to pan · Ctrl + scroll to zoom':'Scroll to zoom · Space + drag to pan') : (scrollToPan?'滚轮平移 · Ctrl＋滚轮缩放':'滚轮缩放 · 空格＋拖动平移')}</small>
    </div>}
  </div>;
}
