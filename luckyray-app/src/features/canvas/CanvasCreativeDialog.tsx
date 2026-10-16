import {useEffect,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

/** Shared canvas-owned dialog. Pointer down AND up must be outside to dismiss.
 * Text selection ending outside never discards the panel; Escape respects IME. */
export function CanvasCreativeDialog({title,children,onClose,english=false,compact=false,className=""}:{title:string;children:ReactNode;onClose:()=>void;english?:boolean;compact?:boolean;className?:string}) {
 const panel=useRef<HTMLElement>(null),outside=useRef(false),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;
  panel.current?.querySelector<HTMLButtonElement>('[data-dialog-close]')?.focus();
  return()=>{if(previous?.isConnected)previous.focus();};
 },[]);
 return createPortal(<div className="canvas-creative-overlay nodrag nopan"
  onPointerDown={e=>{outside.current=e.target===e.currentTarget;e.stopPropagation();}}
  onPointerUp={e=>{if(outside.current&&e.target===e.currentTarget)close.current();outside.current=false;}}
  onPointerCancel={()=>{outside.current=false;}}
  onKeyDown={e=>{
   e.stopPropagation();if(e.nativeEvent.isComposing)return;
   if(e.key==='Escape'){e.preventDefault();close.current();}
   if(e.key==='Tab'){
    const items=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')||[]).filter(item=>!item.hidden);
    const first=items[0],last=items[items.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
   }
  }}>
  <section ref={panel} className={`canvas-creative-dialog${compact ? " is-compact" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
   <header><strong>{title}</strong><button type="button" data-dialog-close aria-label={english?'Close':'关闭'} onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
   {children}
  </section>
 </div>,document.body);
}
