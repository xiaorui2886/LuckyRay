import {useLayoutEffect,useState,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {useViewport} from '@xyflow/react';
/** Portaled submenus remain outside a short editor's scroll clip, inside canvas theme. */
export function CanvasComposerPopover({enabled,owner,anchor,composer,portal,width,children}:{enabled:boolean;owner:string;anchor:RefObject<HTMLElement|null>;composer:RefObject<HTMLDivElement|null>;portal:RefObject<HTMLDivElement|null>;width:number;children:ReactNode}){
 const viewport=useViewport();
 const [placement,setPlacement]=useState<{root:HTMLElement;x:number;y:number;width:number;maxHeight:number;visible:boolean;bottom:number|undefined}|null>(null);
 useLayoutEffect(()=>{
  if(!enabled)return;
  const target=anchor.current,root=composer.current?.closest<HTMLElement>('.canvas-editor-stage');if(!target||!root)return;
  const update=()=>{const a=target.getBoundingClientRect(),r=root.getBoundingClientRect();const w=Math.min(width,Math.max(0,r.width-24));const availableAbove=Math.max(0,a.top-r.top-20),availableBelow=Math.max(0,r.bottom-a.bottom-20);const above=availableAbove>=Math.min(300,availableBelow)||availableAbove>=availableBelow;const h=Math.max(0,Math.min(520,above?availableAbove:availableBelow));const x=Math.max(12,Math.min(r.width-w-12,a.left-r.left));const y=above?Math.max(12,a.top-r.top-h-8):a.bottom-r.top+8;const bottom=above?r.bottom-a.top+8:undefined;const visible=w>=80&&h>=48&&a.bottom>r.top&&a.top<r.bottom&&composer.current?.closest<HTMLElement>('.canvas-anchored-surface')?.style.visibility!=='hidden';setPlacement(old=>old?.root===root&&old.x===x&&old.y===y&&old.width===w&&old.maxHeight===h&&old.visible===visible&&old.bottom===bottom?old:{root,x,y,width:w,maxHeight:h,visible,bottom});};
  update();
  // Aspect/prompt changes can move or flip the editor without moving the camera.
  const surface=composer.current?.closest<HTMLElement>('.canvas-anchored-surface');
  const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update);
  resize?.observe(root);resize?.observe(target);if(composer.current)resize?.observe(composer.current);
  const movement=typeof MutationObserver==='undefined'?null:new MutationObserver(update);
  if(surface)movement?.observe(surface,{attributes:true,attributeFilter:['style']});
  window.addEventListener('resize',update);root.addEventListener('scroll',update,true);
  return()=>{resize?.disconnect();movement?.disconnect();window.removeEventListener('resize',update);root.removeEventListener('scroll',update,true);};
 },[enabled,anchor,composer,width,viewport.x,viewport.y,viewport.zoom]);
 if(!enabled)return <>{children}</>;
 if(!placement)return null;
 return createPortal(<div ref={portal} className="canvas-composer-floating-layer nodrag nopan nowheel" data-canvas-composer-owner={owner} style={{left:placement.x,top:placement.bottom===undefined?placement.y:undefined,bottom:placement.bottom,width:placement.width,maxHeight:placement.maxHeight,visibility:placement.visible?'visible':'hidden'}} onPointerDown={e=>e.stopPropagation()}>{children}</div>,placement.root);
}
