import { createContext, useContext, useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import './canvasDialogScope.css';

type Scope = { host: RefObject<HTMLElement | null>; active: boolean };
const Context = createContext<Scope | null>(null);
type Bounds = { left: number; top: number; width: number; height: number };

/** React context follows body portals; canvas transforms must not contain them. */
export function CanvasDialogScopeProvider({ host, active, children }: Scope & { children: ReactNode }) {
  return <Context.Provider value={{ host, active }}>{children}</Context.Provider>;
}

/** Keep dialogs outside retained editor stacking contexts, but cover only their
 * owning canvas. Resize changes geometry only, never remounts a tool's draft. */
export function CanvasDialogPortal({ children, layer = 1200 }: { children: ReactNode; layer?: number }) {
  const scope = useContext(Context);
  const host = scope?.host, active = scope?.active;
  const [bounds, setBounds] = useState<Bounds | null>(null);
  useLayoutEffect(() => {
    if (!host || !active || !host.current) return;
    const element = host.current;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const next = { left, top, width: Math.max(0, Math.min(window.innerWidth, rect.right) - left), height: Math.max(0, Math.min(window.innerHeight, rect.bottom) - top) };
      setBounds(previous => previous && Object.keys(next).every(key => previous[key as keyof Bounds] === next[key as keyof Bounds]) ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    document.addEventListener('fullscreenchange', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); document.removeEventListener('fullscreenchange', update); };
  }, [host, active]);
  const style: CSSProperties = { zIndex: layer, ...(scope ? {
    inset: 'auto', left: bounds?.left ?? 0, top: bounds?.top ?? 0,
    width: bounds?.width ?? 0, height: bounds?.height ?? 0,
    display: active && bounds && bounds.width > 0 && bounds.height > 0 ? undefined : 'none',
  } : {}) };
  return createPortal(<div className="canvas-dialog-scope" data-dialog-scope={scope ? 'canvas' : 'viewport'} style={style}>{children}</div>, document.body);
}
