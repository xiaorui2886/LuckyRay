import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ContextMenuSurface} from '../../components/ContextMenuSurface';
import type {LayoutCommand} from '../../core/canvas/selectionLayout';
import './canvasEditingSurfaces.css';
const layouts:Array<[LayoutCommand,string,string]>=[['left','左对齐','Align left'],['centerX','水平居中','Center horizontally'],['right','右对齐','Align right'],['top','顶端对齐','Align top'],['centerY','垂直居中','Center vertically'],['bottom','底端对齐','Align bottom'],['distributeX','水平等距','Distribute horizontally'],['distributeY','垂直等距','Distribute vertically']];
function Icon({kind}:{kind:LayoutCommand|'group'|'ungroup'|'copy'|'delete'|'layout'|'arrange'|'close'}){
 const vertical=['top','centerY','bottom','distributeY'].includes(kind);let shape;
 if(kind==='group'||kind==='ungroup')shape=<><rect x="3" y="3" width="14" height="14" rx="2" strokeDasharray={kind==='ungroup'?'2 2':undefined}/><path d="M6 6h4v4H6zM10 10h4v4h-4z"/></>;
 else if(kind==='copy')shape=<><rect x="6" y="6" width="11" height="11" rx="2"/><path d="M13 6V3H3v10h3"/></>;
 else if(kind==='delete')shape=<><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6"/></>;
 else if(kind==='close')shape=<path d="m6 6 8 8M14 6l-8 8"/>;
 else if(kind==='layout')shape=<><path d="M3 4h5v5H3zM12 4h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z"/></>;
 else if(kind==='arrange')shape=<><rect x="2" y="3" width="5" height="5" rx="1"/><rect x="13" y="3" width="5" height="5" rx="1"/><rect x="7.5" y="12" width="5" height="5" rx="1"/><path d="M7 5.5h6M10 8v4"/></>;
 else if(kind==='distributeX'||kind==='distributeY')shape=<g transform={vertical?'rotate(90 10 10)':undefined}><path d="M3 3v14M17 3v14M7 6h2v8H7zM11 4h2v12h-2z"/></g>;
 else {const edge=kind==='left'||kind==='top'?3:kind==='right'||kind==='bottom'?17:10;shape=<g transform={vertical?'rotate(90 10 10)':undefined}><path d={`M${edge} 2v16`}/><rect x={edge===3?5:edge===17?7:6} y="5" width="8" height="3" rx=".7"/><rect x={edge===3?5:edge===17?11:8} y="12" width="4" height="3" rx=".7"/></g>;}
 return <svg viewBox="0 0 20 20" aria-hidden="true">{shape}</svg>;
}
type Props={count:number;layoutCount:number;canGroup:boolean;canUngroup:boolean;canLayout:boolean;allowedLayouts?:LayoutCommand[];english:boolean;onGroup:()=>void;onUngroup:()=>void;onLayout:(mode:LayoutCommand)=>void;onArrange:()=>void;onDuplicate:()=>void;onDelete:()=>void;onClear:()=>void;context?:{x:number;y:number}|null;onDismissContext:()=>void};
export function CanvasSelectionToolbar(p:Props){
 const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null);
 useEffect(()=>{setOpen(false);},[p.count,p.context]);
 useEffect(()=>{const outside=(e:PointerEvent)=>{if(e.target instanceof Node&&!root.current?.contains(e.target)){setOpen(false);if(p.context)p.onDismissContext();}};const escape=(e:KeyboardEvent)=>{if(e.key!=='Escape'||e.defaultPrevented)return;if(open||p.context){e.preventDefault();setOpen(false);p.onDismissContext();}};document.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape);};},[open,p.context,p.onDismissContext]);
 const act=(fn:()=>void)=>{fn();setOpen(false);p.onDismissContext();};
 const item=p.context?{'role':'menuitem' as const,'data-context-menu-item':'root'}:{};
 const count=<span className="canvas-selection-count">{p.count}<small>{p.english?'selected':'项已选'}</small></span>;
 const actions=<>
  {p.canGroup&&<button type="button" {...item} onClick={()=>act(p.onGroup)} title={p.english?'Group':'编组'}><Icon kind="group"/><span>{p.english?'Group':'编组'}</span></button>}
  {p.canUngroup&&<button type="button" {...item} onClick={()=>act(p.onUngroup)} title={p.english?'Ungroup':'解除编组'}><Icon kind="ungroup"/><span>{p.english?'Ungroup':'解除编组'}</span></button>}
  <button type="button" {...item} onClick={()=>act(p.onArrange)} title={p.english?'Organize the whole canvas':'整理整个画布'}><Icon kind="arrange"/><span>{p.english?'Organize canvas':'整理画布'}</span></button>
  <div className="canvas-selection-layout-anchor" data-context-menu-entry={p.context?'root':undefined}><button type="button" {...item} onClick={()=>setOpen(v=>!v)} aria-expanded={open} aria-haspopup="dialog" disabled={!p.canLayout} title={!p.canLayout?(p.english?'Select objects in the same parent':'请选择同一层级的卡片或分组'):undefined}><Icon kind="layout"/><span>{p.english?'Arrange':'对齐排列'}</span></button>
   {open&&<div className="canvas-selection-layout-menu" role="dialog" aria-label={p.english?'Align and distribute':'对齐与分布'} onKeyDown={event=>{if(!p.context)return;event.stopPropagation();if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();setOpen(false);root.current?.querySelector<HTMLButtonElement>('.canvas-selection-layout-anchor>button')?.focus();}}}><div>{layouts.map(([kind,zh,en])=><button type="button" key={kind} disabled={(kind.startsWith('distribute')&&p.layoutCount<3)||(p.allowedLayouts&&!p.allowedLayouts.includes(kind))} onClick={()=>act(()=>p.onLayout(kind))} title={p.english?en:zh}><Icon kind={kind}/><span>{p.english?en:zh}</span></button>)}</div><small>{p.english?'Arrow keys: nudge · Shift: 10 px':'方向键微调 · Shift 加速'}</small></div>}
  </div>
  <button type="button" {...item} onClick={()=>act(p.onDuplicate)} title={p.english?'Duplicate selection':'复制选中项'}><Icon kind="copy"/><span>{p.english?'Duplicate':'复制'}</span></button>
  <button type="button" {...item} className="is-danger" onClick={()=>act(p.onDelete)} title={p.english?'Delete selection':'删除选中项'} aria-label={p.english?'Delete selection':'删除选中项'}><Icon kind="delete"/>{p.context&&<span>{p.english?'Delete selection':'删除选中项'}</span>}</button><i role={p.context?'separator':undefined}/>
  <button type="button" {...item} aria-label={p.english?'Clear selection':'取消选择'} onClick={()=>act(p.onClear)}><Icon kind="close"/>{p.context&&<span>{p.english?'Clear selection':'取消选择'}</span>}</button>
 </>;
 if(p.context)return createPortal(<div ref={root}><ContextMenuSurface x={p.context.x} y={p.context.y} className="canvas-selection-tools is-context nodrag nopan nowheel" label={p.english?'Selection actions':'多选操作'} onRequestClose={()=>{setOpen(false);p.onDismissContext();}}>{count}{actions}</ContextMenuSurface></div>,document.body);
 return <div ref={root} className="canvas-selection-tools nodrag nopan nowheel" role="toolbar" aria-label={p.english?'Selection actions':'多选操作'} onPointerDown={e=>e.stopPropagation()}>{count}<i/>{actions}</div>;
}
