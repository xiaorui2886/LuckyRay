import {useEffect,useRef,type ReactNode} from 'react';
import {useCanvasReducedMotion} from './CanvasMotionContext';
import {CanvasDialogPortal} from './CanvasDialogScope';

/** Shared canvas-owned dialog. Pointer down AND up must be outside to dismiss.
 * Text selection ending outside never discards the panel; Escape respects IME. */
export function CanvasCreativeDialog({title,subtitle,children,onClose,english=false,compact=false,className="",dismissOnBackdrop=true}:{title:string;subtitle?:string;children:ReactNode;onClose:()=>void;english?:boolean;compact?:boolean;className?:string;dismissOnBackdrop?:boolean}) {
 const reduced = useCanvasReducedMotion();
 const panel=useRef<HTMLElement>(null),outside=useRef(false),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;
  panel.current?.querySelector<HTMLButtonElement>('[data-dialog-close]')?.focus();
  return()=>{if(previous?.isConnected)previous.focus();};
 },[]);
 return <CanvasDialogPortal><div className={`canvas-creative-overlay nodrag nopan${reduced ? " reduce-motion" : ""}`}
  onPointerDown={e=>{outside.current=e.target===e.currentTarget;e.stopPropagation();}}
  onPointerUp={e=>{if(dismissOnBackdrop&&outside.current&&e.target===e.currentTarget)close.current();outside.current=false;}}
  onPointerCancel={()=>{outside.current=false;}}
  onKeyDown={e=>{
   e.stopPropagation();if(e.nativeEvent.isComposing)return;
   if(e.key==='Escape'){e.preventDefault();close.current();}
   if(e.key==='Tab'){
    const items=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')||[]).filter(item=>{
      if(item.hidden || item.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      for(let ancestor=item.parentElement;ancestor && ancestor!==panel.current;ancestor=ancestor.parentElement){
       if(ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector('summary')?.contains(item)) return false;
      }
      return true;
    });
    const first=items[0],last=items[items.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
   }
  }}>
  <section ref={panel} className={`canvas-creative-dialog${compact ? " is-compact" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
   <header><div className="canvas-creative-heading"><strong>{title}</strong>{subtitle && <p>{subtitle}</p>}</div><button type="button" data-dialog-close aria-label={english?'Close':'关闭'} onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
   {children}
  </section>
 </div></CanvasDialogPortal>;
}

