import {useEffect, useRef} from 'react';

/** Dismiss on gesture start, never on text-selection release or focus movement. */
export function useCanvasHistoryPopover(open:boolean, notice:string, close:()=>void, clearNotice:()=>void) {
  const anchorRef=useRef<HTMLDivElement>(null);
  const callbacks=useRef({close,clearNotice});callbacks.current={close,clearNotice};
  useEffect(()=>{
    if(!open){callbacks.current.clearNotice();return;}
    const outside=(event:PointerEvent)=>{
      if(event.button!==0||event.isPrimary===false)return;
      if(anchorRef.current&&!event.composedPath().includes(anchorRef.current))callbacks.current.close();
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing)callbacks.current.close();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);};
  },[open]);
  useEffect(()=>{
    if(!notice||!open)return;
    const timer=window.setTimeout(()=>callbacks.current.clearNotice(),3500);
    return()=>window.clearTimeout(timer);
  },[notice,open]);
  return anchorRef;
}
