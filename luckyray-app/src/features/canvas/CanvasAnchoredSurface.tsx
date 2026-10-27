import {useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {useStore,useViewport} from '@xyflow/react';
import {placeCanvasSurface,type SurfaceRect,type SurfacePlacement} from '../../core/canvas/anchoredSurface';
import './canvasEditingSurfaces.css';
/** Image actions clear the rendered title, which scales with the node, not the toolbar. */
export function placeCanvasImageToolbar(node:SurfaceRect,header:{top:number;bottom:number},stage:{width:number;height:number},surface:{width:number;height:number},gap=12):SurfacePlacement{
 const headerTop=Math.min(node.y,header.top),headerBottom=Math.max(headerTop,header.bottom);
 const bounds={...node,y:headerTop,height:node.y+node.height-headerTop};
 const position=placeCanvasSurface(bounds,stage,surface,'top',gap,false,true);
 if(!position.visible)return position;
 const height=Math.min(surface.height,position.maxHeight);
 // Both vertical sides can be clipped at high zoom. Never clamp the toolbar onto
 // the title: use the first safe row below it (over the media only as a last resort).
 if(position.y+height+gap>headerTop&&position.y<headerBottom+gap){
  const y=Math.max(76,headerBottom+gap);
  if(y+height<=stage.height-56)return {...position,y,side:'bottom'};
  // A header at the bottom edge still leaves a safe row immediately above it.
  const above=headerTop-gap-height;
  if(above>=76)return {...position,y:above,side:'top'};
  return {...position,visible:false};
 }
 return position;
}
type Props={nodeId:string;stage:RefObject<HTMLDivElement|null>;width:number;preferred?:'top'|'bottom';className?:string;children:ReactNode;onClose?:()=>void;label?:string;gap?:number;reserveToolbar?:boolean;allowFlip?:boolean;closeLabel?:string;avoidNodeHeader?:boolean};
export function CanvasAnchoredSurface({nodeId,stage,width,preferred='bottom',className='',children,onClose,label,gap=12,reserveToolbar=false,allowFlip=true,closeLabel="关闭编辑区",avoidNodeHeader=false}:Props){
 const {x,y,zoom}=useViewport();
 const geometry=useStore(s=>{const n=s.nodeLookup.get(nodeId);return n?[n.internals.positionAbsolute.x,n.internals.positionAbsolute.y,n.measured.width??n.width??300,n.measured.height??n.height??220,n.hidden?1:0]:null;},(a,b)=>a===b||!!a&&!!b&&a.length===b.length&&a.every((v,i)=>v===b[i]));
 const panel=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
 const [extent,setExtent]=useState({width:0,height:0}),[height,setHeight]=useState(preferred==='top'?40:220);
 const extentCache=useRef(extent),heightCache=useRef(height);
 const [header,setHeader]=useState<{top:number;bottom:number}|null>(null);
 useLayoutEffect(()=>{
  if(!avoidNodeHeader||!stage.current)return;
  const node=Array.from(stage.current.querySelectorAll<HTMLElement>('.react-flow__node')).find(el=>el.dataset.id===nodeId);
  if(!node)return;
  const title=node.querySelector<HTMLElement>('.canvas-node-kind');
  const update=()=>{
   const rect=node.getBoundingClientRect(),label=title?.getBoundingClientRect();
   const next={top:label?(label.top-rect.top)/zoom:0,bottom:label?(label.bottom-rect.top)/zoom:0};
   setHeader(old=>old&&Math.abs(old.top-next.top)<.1&&Math.abs(old.bottom-next.bottom)<.1?old:next);
  };
  update();
  if(typeof ResizeObserver==='undefined')return;
  const observer=new ResizeObserver(update);observer.observe(node);if(title)observer.observe(title);
  return()=>observer.disconnect();
 },[avoidNodeHeader,nodeId,zoom,geometry?.[2],geometry?.[3],stage]);
 useLayoutEffect(()=>{const el=stage.current;if(!el)return;const update=()=>{const r=el.getBoundingClientRect();if(extentCache.current.width!==r.width||extentCache.current.height!==r.height){extentCache.current={width:r.width,height:r.height};setExtent(extentCache.current);}};update();if(typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(update);ro.observe(el);return()=>ro.disconnect();},[stage]);
 useLayoutEffect(()=>{const el=panel.current;if(!el)return;const update=()=>{const h=el.getBoundingClientRect().height;if(h>0&&Math.abs(heightCache.current-h)>=.5){heightCache.current=h;setHeight(h);}};update();if(typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(update);ro.observe(el);return()=>ro.disconnect();},[nodeId,extent.width,!!geometry,geometry?.[4]]);
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key!=='Escape'||e.defaultPrevented||e.isComposing||!close.current)return;const target=e.target instanceof Element?e.target:null;if(target?.closest('[role="dialog"],input,textarea,[contenteditable="true"]')&&!panel.current?.contains(target))return;e.preventDefault();close.current();};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[]);
 if(!geometry||geometry[4]||!stage.current)return null;
 const node={x:geometry[0]*zoom+x,y:geometry[1]*zoom+y,width:geometry[2]*zoom,height:geometry[3]*zoom};
 const position=avoidNodeHeader?placeCanvasImageToolbar(node,{top:node.y+(header?.top??0)*zoom,bottom:node.y+(header?.bottom??0)*zoom},extent,{width,height},gap):placeCanvasSurface(node,extent,{width,height},preferred,gap,reserveToolbar,allowFlip);
 if(avoidNodeHeader&&!header)position.visible=false;
 // Keep the editor mounted while its card leaves the viewport: draft & selection survive.
 return createPortal(<div ref={panel} className={`canvas-anchored-surface nodrag nopan nowheel ${className}`} data-node-id={nodeId} data-side={position.side} style={{left:position.x,top:position.y,width:position.width,maxHeight:position.maxHeight,overflowY:position.maxHeight<240?'auto':undefined,visibility:position.visible?'visible':'hidden',pointerEvents:position.visible?'auto':'none'}} onPointerDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()}>
  {label&&<div className="canvas-anchored-heading"><span title={label}>{label}</span>{onClose&&<button type="button" aria-label={closeLabel} title={closeLabel+" · Esc"} onClick={onClose}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button>}</div>}{children}
 </div>,stage.current);
}
