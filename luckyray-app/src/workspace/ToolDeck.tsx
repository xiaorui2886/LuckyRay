import {useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore,type ReactNode,type CSSProperties} from 'react';
import type {LayoutStore} from './layoutStore';
import {groups} from './layout';
import {closeTool,emptyTools,moveTool,toolDocks,toolNames,type ToolDock,type ToolKind} from './toolLayout';
import {ToolRegistry} from './toolRegistry';
const dockNames:Record<ToolDock,string>={left:'左侧',right:'右侧',bottom:'底部',float:'浮动'};
export function ToolDeck({store,registry,children}:{store:LayoutStore;registry:ToolRegistry;children:ReactNode}){
 const layout=useSyncExternalStore(store.subscribe,store.getSnapshot);useSyncExternalStore(registry.subscribe,registry.getSnapshot);
 const tools=layout.tools??emptyTools();const root=useRef<HTMLDivElement>(null);const [size,setSize]=useState({width:0,height:0});
 const [drag,setDrag]=useState<{kind:ToolKind;pointer:number;startX:number;startY:number;x:number;y:number;active:boolean;dock:ToolDock}|null>(null);
 const dragRef=useRef(drag);dragRef.current=drag;
 const suppressClick=useRef(false);
 useLayoutEffect(()=>{const el=root.current!;const update=()=>setSize({width:el.clientWidth,height:el.clientHeight});update();const observer=new ResizeObserver(update);observer.observe(el);return()=>observer.disconnect();},[]);
 useEffect(()=>{const cancel=(event:Event)=>{if(event.type==='blur'||(event as KeyboardEvent).key==='Escape')setDrag(null);};window.addEventListener('keydown',cancel);window.addEventListener('blur',cancel);return()=>{window.removeEventListener('keydown',cancel);window.removeEventListener('blur',cancel);};},[]);
 const focused=groups(layout.root).find(g=>g.id===layout.focusedGroup)?.active??null;
 const used=(dock:ToolDock)=>tools.panels.some(p=>p.dock===dock);
 // Even at narrow sizes keep the content accessible; configured sizes survive resize.
 const left=used('left')?Math.min(tools.sizes.left,size.width*.28):0;
 const right=used('right')?Math.min(tools.sizes.right,size.width*.28):0;
 const bottom=used('bottom')?Math.min(tools.sizes.bottom,size.height*.4):0;
 const floating={width:Math.min(tools.floating.width,size.width),height:Math.min(tools.floating.height,size.height)};
 const floatX=Math.max(0,Math.min(tools.floating.x,size.width-floating.width));const floatY=Math.max(0,Math.min(tools.floating.y,size.height-floating.height));
 const rects:Record<ToolDock,CSSProperties>={left:{left:0,top:0,width:left,height:size.height-bottom},right:{right:0,top:0,width:right,height:size.height-bottom},bottom:{left:0,bottom:0,width:size.width,height:bottom},float:{left:floatX,top:floatY,...floating,zIndex:8}};
 const commit=(next:typeof tools)=>store.dispatch({type:'tools',tools:next});
 return <div className="workspace-tool-deck" ref={root}>
  <div className="workspace-tool-content" style={{left,right,bottom,top:0}}>{children}</div>
  {toolDocks.filter(used).map(dock=><div key={dock} className={`workspace-tool-group dock-${dock}`} style={rects[dock]}>
   <div role="tablist" aria-label={`${dockNames[dock]}工具面板`} className="workspace-tool-tabs">{tools.panels.filter(p=>p.dock===dock).map(panel=><button key={panel.kind} role="tab" aria-selected={tools.active[dock]===panel.kind}
    onClick={()=>{if(suppressClick.current){suppressClick.current=false;return;}commit({...tools,active:{...tools.active,[dock]:panel.kind}});}}
    onPointerDown={event=>{if(event.button!==0)return;event.currentTarget.setPointerCapture(event.pointerId);setDrag({kind:panel.kind,pointer:event.pointerId,startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,active:false,dock});}}
    onPointerMove={event=>{const current=dragRef.current;if(!current||current.pointer!==event.pointerId)return;const bounds=root.current!.getBoundingClientRect();const x=event.clientX-bounds.left,y=event.clientY-bounds.top;const target:ToolDock=x<70?'left':x>bounds.width-70?'right':y>bounds.height-70?'bottom':'float';setDrag({...current,x,y,dock:target,active:current.active||Math.hypot(event.clientX-current.startX,event.clientY-current.startY)>6});}}
    onPointerUp={()=>{const current=dragRef.current;dragRef.current=null;setDrag(null);if(!current?.active)return;suppressClick.current=true;let next=moveTool(tools,current.kind,current.dock);if(current.dock==='float')next={...next,floating:{...next.floating,x:Math.max(0,Math.min(current.x,size.width-220)),y:Math.max(0,Math.min(current.y,size.height-180))}};commit(next);}}
    onPointerCancel={()=>setDrag(null)}>{toolNames[panel.kind]}</button>)}</div>
  </div>)}
  {/* Flat keyed panel bodies never reparent when docked/grouped/floated. */}
  {tools.panels.map(panel=>{const dock=panel.dock,viewId=panel.pin?.viewId??focused;const view=viewId?layout.views[viewId]:null;const adapter=viewId&&view?registry.get(viewId):undefined;const selected=tools.active[dock]===panel.kind;
   const rect=rects[dock];return <section key={panel.kind} className={`workspace-tool-body dock-${dock}`} style={{...rect,visibility:selected?'visible':'hidden',pointerEvents:selected?'auto':'none'}} inert={!selected||undefined} aria-hidden={!selected} aria-label={toolNames[panel.kind]}>
    <header><span>{panel.pin?'固定 · ':''}{panel.pin?.objectId?adapter?.titleFor?.(panel.pin.objectId)??'固定对象':adapter?.title??'暂无适用对象'}</span><button aria-label={`关闭${toolNames[panel.kind]}`} onClick={()=>commit(closeTool(tools,panel.kind))}>×</button></header>
    <div className="workspace-tool-actions"><select aria-label={`${toolNames[panel.kind]}位置`} value={dock} onChange={event=>commit(moveTool(tools,panel.kind,event.target.value as ToolDock))}>{toolDocks.map(d=><option key={d} value={d}>{dockNames[d]}</option>)}</select>
     <button disabled={!panel.pin&&!adapter} aria-pressed={!!panel.pin} onClick={()=>commit({...tools,panels:tools.panels.map(p=>p.kind===panel.kind?{...p,pin:panel.pin?null:{viewId:viewId!,objectId:adapter?.captureObject?.(panel.kind)}}:p)})}>{panel.pin?'取消固定':'固定对象'}</button>
     <input type="range" aria-label={`${toolNames[panel.kind]}尺寸`} min={dock==='bottom'?140:180} max={800} value={dock==='float'?tools.floating.width:tools.sizes[dock]} onChange={event=>{const value=Number(event.target.value);commit(dock==='float'?{...tools,floating:{...tools.floating,width:Math.max(220,value)}}:{...tools,sizes:{...tools.sizes,[dock]:value}});}}/>
    </div>
    <div className="workspace-tool-scroll">{adapter&&adapter.kinds.includes(panel.kind)?adapter.render(panel.kind,panel.pin?.objectId):<p>{panel.pin?'固定的视图已关闭或不再可用。取消固定可跟随当前视图。':'此工具不适用于当前视图。'}</p>}</div>
   </section>;
  })}
  {drag?.active&&<div className="workspace-tool-drop" role="status">{drag.dock==='float'?'浮动此面板':`停靠到${dockNames[drag.dock]}，与该侧工具分组`}</div>}
 </div>;
}
