import { useLayoutEffect, useState, type RefObject } from 'react';

/** Measured against the host toolbar, not a fixed top offset (DPI/compact windows). */
export function CanvasFocusStatus({ host, busy, status, onExit, english = false }: {
  host: RefObject<HTMLDivElement | null>; busy: boolean; status: string; onExit: () => void; english?: boolean;
}) {
  const [top, setTop] = useState(92);
  useLayoutEffect(() => {
    const body = host.current;
    const toolbar = body?.querySelector<HTMLElement>('.canvas-editor-floating-toolbar');
    if (!body || !toolbar) return;
    const measure = () => setTop(Math.max(12, toolbar.getBoundingClientRect().bottom - body.getBoundingClientRect().top + 12));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(toolbar); observer?.observe(body);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [host]);
  return <div className="canvas-focus-status nodrag nopan" style={{ top }} role="status" aria-live="polite" aria-busy={busy}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/><circle cx="10" cy="10" r="3"/></svg>
    <strong>{english ? 'Focus edit' : '焦点编辑'}</strong><span>{status}</span>
    <button type="button" onClick={onExit} aria-label={english ? 'Exit focus mode' : '退出聚焦模式'}>{english ? 'Exit · Esc' : '退出 · Esc'}</button>
  </div>;
}
