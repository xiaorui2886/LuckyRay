import {createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {CanvasComposerPopover} from './CanvasComposerPopover';
import {createPortal} from 'react-dom';
import './CanvasCinematography.css';

const Group = createContext<{active: string | null; setActive: (id: string | null) => void; owner: string; floating: boolean} | null>(null);

/** One local menu at a time; its contents never increase the composer's height. */
export function ComfyPopoverGroup({owner = 'comfy-controls', floating = false, children, onOpen}: {owner?: string; floating?: boolean; children: ReactNode; onOpen?: () => void}) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {setActive(null);}, [owner]);
  return <Group.Provider value={{active, setActive: id => {if(id) onOpen?.();setActive(id);}, owner, floating}}>{children}</Group.Provider>;
}

/** Keep the control state beside its workflow, but put option icons in the
 * existing composer footer. No duplicate controls or hidden UI copies. */
export function ComfyOptionRow({target, children}: {target?: HTMLElement | null; children: ReactNode}) {
  const row=<div className="canvas-comfy-option-row">{children}</div>;
  return target === undefined ? row : target ? createPortal(row,target) : null;
}

function OptionIcon({type}: {type: 'adjust' | 'lora' | 'connection'}) {
  return <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {type==='adjust'?<><path d="M3 5h5m4 0h5M3 10h9m4 0h1M3 15h1m4 0h9"/><circle cx="10" cy="5" r="2"/><circle cx="14" cy="10" r="2"/><circle cx="6" cy="15" r="2"/></>:type==='lora'?<><path d="m10 2 7 4-7 4-7-4 7-4Zm-7 9 7 4 7-4M3 15l7 4 7-4"/></>:<><path d="M7 4v3m6-3v3M5 7h10v2a5 5 0 0 1-10 0V7Zm5 7v4M6 18h8"/></>}
  </svg>;
}

export function ComfyPopover({label, summary, disabled, width = 380, children, className = '', english = false, icon}: {
  label: string; summary?: ReactNode; disabled?: boolean; width?: number; children: ReactNode; className?: string; english?: boolean; icon?: 'adjust' | 'lora' | 'connection';
}) {
  const group = useContext(Group)!;
  const id = useId(), open = group.active === id;
  const root = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement>(null), portal = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
  const mountPanel = useCallback((node: HTMLDivElement | null) => {panel.current = node; node?.focus({preventScroll: true});}, []);
  const close = (focus = false) => {
    // Commit a valid number draft before unmounting its input.
    if (document.activeElement instanceof HTMLElement && panel.current?.contains(document.activeElement)) document.activeElement.blur();
    group.setActive(null);
    if (focus) anchor.current?.focus({preventScroll: true});
  };
  useEffect(() => {if (disabled && open) group.setActive(null);}, [disabled, open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !portal.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !root.current?.getClientRects().length || portal.current?.style.visibility === 'hidden') return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    // Click, rather than pointerdown, allows an outside button to receive its
    // original pointerup/click. The portal has no effect on editor geometry.
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {document.removeEventListener('click', outside, true); document.removeEventListener('keydown', escape, true);};
  }, [open]);
  return <div ref={root} className={`canvas-comfy-popover-anchor ${icon?'canvas-composer-anchor is-icon':''} ${className}`}>
    <button ref={anchor} type="button" className={`${icon?'':'canvas-comfy-option'} ${open?'is-active':''}`} title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => group.setActive(open ? null : id)}>
      {icon?<OptionIcon type={icon}/>:<><span>{summary ?? label}</span><svg className="canvas-comfy-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.25 3.5 3.5 3.5-3.5"/></svg></>}
    </button>
    {open ? <CanvasComposerPopover enabled={group.floating} owner={group.owner} anchor={anchor} composer={root} portal={portal} width={width}>
      <div ref={mountPanel} id={id} role="dialog" aria-label={label} tabIndex={-1} className="canvas-cinematography canvas-comfy-popover nodrag nopan nowheel" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
        <div className="canvas-cinema-heading canvas-comfy-popover-heading"><strong>{label}</strong><button type="button" className="canvas-cinema-reset" aria-label={english ? 'Close options' : '关闭选项'} onClick={() => close(true)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div>
        {children}
      </div>
    </CanvasComposerPopover> : null}
  </div>;
}
