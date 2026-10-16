import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type CSSProperties } from 'react';
import { dropEdge, groups, findGroup, measureLayout, reduceLayout, type DropEdge, type Rect, type ViewRef } from './layout';
import { LayoutStore } from './layoutStore';
import './workspace.css';
import {WORKSPACE_DRAG_TYPE,type WindowDragController,type WindowDropTarget} from './windowDrag';

export type WorkspaceViewContext = { visible: boolean; focused: boolean; windowId: string };
export type WorkspaceHostProps = {
  store: LayoutStore;
  renderView: (view: ViewRef, context: WorkspaceViewContext) => ReactNode;
  /** Domain owns flush/conflict confirmation. Failed close never removes its tab. */
  beforeClose?: (view: ViewRef) => Promise<boolean>;
  onNew?: (groupId: string) => void;
  onWindow?: (view: ViewRef, move: boolean) => void;
  onChooseWindow?: (view:ViewRef)=>void;
  nativeDrag?:WindowDragController;
  /** A scoped host must validate retained authority before restoring history. */
  onUndoLayout?:()=>void;
  onRedoLayout?:()=>void;
};
type Drag = { viewId: string; pointerId: number; x: number; y: number; started: boolean; target: { groupId: string; edge: DropEdge; index?: number } | null };
const rectStyle = (rect: Rect): CSSProperties => ({ position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height });
const labels: Record<DropEdge,string> = { center: '移到此标签组', left: '在左侧分屏', right: '在右侧分屏', top: '在上方分屏', bottom: '在下方分屏' };
function previewRect(rect:Rect,edge:DropEdge):Rect {
  if(edge==='left'||edge==='right')return {...rect,width:rect.width/2,left:rect.left+(edge==='right'?rect.width/2:0)};
  if(edge==='top'||edge==='bottom')return {...rect,height:rect.height/2,top:rect.top+(edge==='bottom'?rect.height/2:0)};
  return rect;
}

/** Hosts are flat keyed siblings. A new split never reparents/remounts the domain view. */
export function WorkspaceHost({ store, renderView, beforeClose, onNew, onWindow,onChooseWindow,nativeDrag,onUndoLayout,onRedoLayout }: WorkspaceHostProps) {
  const layout = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const container = useRef<HTMLDivElement>(null);
  const [size,setSize] = useState({width:0,height:0});
  const [drag,setDrag] = useState<Drag|null>(null);
  const [externalDrop,setExternalDrop]=useState<WindowDropTarget|null>(null);
  const dragRef = useRef<Drag|null>(null);
  const [menu,setMenu] = useState<{viewId:string;x:number;y:number}|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [closing,setClosing] = useState(new Set<string>());
  const pendingClose = useRef(new Set<string>());
  const [resizing,setResizing]=useState<{splitId:string;ratio:number}|null>(null);
  const displayed=resizing?reduceLayout(layout,{type:'resize',...resizing}):layout;
  const geometry = measureLayout(displayed.root,size.width,size.height);
  const geometryRef = useRef(geometry); geometryRef.current=geometry;
  useLayoutEffect(()=>{
    const element=container.current; if(!element)return;
    const measure=()=>setSize({width:element.clientWidth,height:element.clientHeight}); measure();
    const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[]);
  const cancelDrag=()=>{dragRef.current=null;setDrag(null);setExternalDrop(null);};
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){cancelDrag();setMenu(null);}};
    window.addEventListener('keydown',onKey);window.addEventListener('blur',cancelDrag);
    return()=>{window.removeEventListener('keydown',onKey);window.removeEventListener('blur',cancelDrag);};
  },[]);
  const move=(viewId:string,targetGroup:string,edge:DropEdge,index?:number)=>{
    store.dispatch({type:'move',viewId,targetGroup,edge,index,groupId:crypto.randomUUID(),splitId:crypto.randomUUID()}); setMenu(null);
  };
  const close=async(viewId:string)=>{
    const view=store.getSnapshot().views[viewId];if(!view||pendingClose.current.has(viewId))return;
    pendingClose.current.add(viewId);setClosing(new Set(pendingClose.current));setMenu(null);
    try { if(!beforeClose || await beforeClose(view))store.dispatch({type:'close',viewId}); }
    catch {setError('此标签尚未安全保存，已保留在原处。');}
    finally{pendingClose.current.delete(viewId);setClosing(new Set(pendingClose.current));}
  };
  const selectTab=(groupId:string,viewId:string,delta:number)=>{
    const group=groups(layout.root).find(item=>item.id===groupId);if(!group)return;
    const index=group.tabs.indexOf(viewId), next=group.tabs[(index+delta+group.tabs.length)%group.tabs.length];
    store.dispatch({type:'activate',viewId:next});
    container.current?.querySelector<HTMLButtonElement>(`[data-workspace-tab="${CSS.escape(next)}"]`)?.focus();
  };
  return <div className="workspace-host" ref={container} data-workspace-window={layout.windowId}
    onDragOver={event=>{if(!nativeDrag||!event.dataTransfer.types.includes(WORKSPACE_DRAG_TYPE))return;event.preventDefault();event.dataTransfer.dropEffect='move';const bounds=container.current!.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top;
      for(const [groupId,rect] of geometry.groups){if(x>=rect.left&&x<=rect.left+rect.width&&y>=rect.top&&y<=rect.top+rect.height){const tab=(event.target as HTMLElement).closest<HTMLElement>('[data-workspace-tab-wrap]');const index=tab?groups(layout.root).find(group=>group.id===groupId)?.tabs.indexOf(tab.dataset.workspaceTabWrap!):undefined;setExternalDrop({groupId,edge:y-rect.top<34?'center':dropEdge(rect,x,y),index});return;}}setExternalDrop(null);}}
    onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setExternalDrop(null);}}
    onDrop={event=>{if(!nativeDrag||!event.dataTransfer.types.includes(WORKSPACE_DRAG_TYPE))return;event.preventDefault();event.stopPropagation();if(externalDrop)nativeDrag.drop(event.dataTransfer,externalDrop);setExternalDrop(null);}}>
    {groups(layout.root).map(group=>{
      const rect=geometry.groups.get(group.id)!;
      return <section className={`workspace-group${group.id===layout.focusedGroup?' is-focused':''}`} key={group.id} data-workspace-group={group.id} style={rectStyle(rect)}>
        <div className="workspace-tabs" role="tablist" aria-label="工作区标签">
          {group.tabs.map(id=><div className="workspace-tab-wrap" key={id} data-workspace-tab-wrap={id}>
            <button type="button" role="tab" aria-selected={group.active===id} aria-controls={`workspace-view-${id}`} tabIndex={group.active===id?0:-1}
              data-workspace-tab={id} title={layout.views[id].title} className="workspace-tab"
              draggable={!!nativeDrag&&layout.views[id].kind==='note'}
              onDragStart={event=>{if(!nativeDrag)return;try{nativeDrag.start(layout.views[id],event.dataTransfer);}catch(error){event.preventDefault();setError(String(error));}}}
              onDragEnd={()=>{nativeDrag?.end();cancelDrag();}}
              onClick={()=>store.dispatch({type:'activate',viewId:id})}
              onContextMenu={event=>{event.preventDefault();const bounds=container.current!.getBoundingClientRect();setMenu({viewId:id,x:Math.max(0,Math.min(event.clientX-bounds.left,size.width-224)),y:Math.max(0,Math.min(event.clientY-bounds.top,size.height-300))});}}
              onKeyDown={event=>{if(event.nativeEvent.isComposing)return;
                if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();const delta=event.key==='ArrowRight'?1:-1;if(event.ctrlKey&&event.shiftKey)move(id,group.id,'center',group.tabs.indexOf(id)+delta);else selectTab(group.id,id,delta);}
                if(event.key==='Delete'){event.preventDefault();void close(id);}
                if(event.key==='F10'&&event.shiftKey){event.preventDefault();setMenu({viewId:id,x:rect.left,y:rect.top+34});}
              }}
              onPointerDown={event=>{if(event.button!==0||(nativeDrag&&layout.views[id].kind==='note'))return;event.currentTarget.setPointerCapture(event.pointerId);const next:Drag={viewId:id,pointerId:event.pointerId,x:event.clientX,y:event.clientY,started:false,target:null};dragRef.current=next;}}
              onPointerMove={event=>{const current=dragRef.current;if(!current||current.pointerId!==event.pointerId)return;
                if(!current.started&&Math.hypot(event.clientX-current.x,event.clientY-current.y)<6)return;
                const bounds=container.current!.getBoundingClientRect(), x=event.clientX-bounds.left,y=event.clientY-bounds.top;
                let target:Drag['target']=null;
                for(const [groupId,area] of geometryRef.current.groups){if(x>=area.left&&x<=area.left+area.width&&y>=area.top&&y<=area.top+area.height){
                  const tab=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-workspace-tab-wrap]');
                  const tabs=groups(store.getSnapshot().root).find(item=>item.id===groupId)?.tabs.filter(tabId=>tabId!==current.viewId)??[];
                  const index=tab?tabs.indexOf(tab.dataset.workspaceTabWrap!):undefined;
                  target={groupId,edge:y-area.top<34?'center':dropEdge(area,x,y),index:index!==undefined&&index>=0?index:undefined};break;}}
                const next={...current,started:true,target};dragRef.current=next;setDrag(next);
              }}
              onPointerUp={event=>{const current=dragRef.current;if(!current||current.pointerId!==event.pointerId)return;cancelDrag();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(current.started&&current.target)move(current.viewId,current.target.groupId,current.target.edge,current.target.index);}}
              onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>{layout.views[id].title || '未命名'}</button>
            <button type="button" className="workspace-tab-close" aria-label={`关闭 ${layout.views[id].title}`} disabled={closing.has(id)} onClick={()=>void close(id)}>×</button>
          </div>)}
          {onNew&&<button className="workspace-new" type="button" aria-label="新建标签" onClick={()=>onNew(group.id)}>+</button>}
          <button className="workspace-new" type="button" aria-label="撤销布局移动" onClick={()=>{if(onUndoLayout)onUndoLayout();else store.undo();}}>↶</button>
          <button className="workspace-new" type="button" aria-label="重做布局移动" onClick={()=>{if(onRedoLayout)onRedoLayout();else store.redo();}}>↷</button>
        </div>
        {!group.tabs.length&&<div className="workspace-empty">在这里打开笔记、图谱或素材</div>}
      </section>;
    })}
    {store.retainedViews().map(view=>{
      const group=findGroup(layout,view.id), visible=!!group&&group.active===view.id;
      const rect=group?geometry.groups.get(group.id)!:{left:0,top:0,width:0,height:0};
      return <div key={view.id} id={`workspace-view-${view.id}`} role="tabpanel" data-workspace-view={view.id} hidden={!visible}
        className="workspace-view" style={{...rectStyle({...rect,top:rect.top+34,height:Math.max(0,rect.height-34)}),display:visible?undefined:'none'}}
        onFocusCapture={()=>{if(group&&layout.focusedGroup!==group.id)store.dispatch({type:'activate',viewId:view.id});}}>
        {renderView(view,{visible,focused:visible&&group?.id===layout.focusedGroup,windowId:layout.windowId})}
      </div>;
    })}
    {geometry.dividers.map(divider=><WorkspaceDivider key={divider.id} divider={divider} store={store} onPreview={setResizing}/>)}
    {drag?.started&&drag.target&&<div className="workspace-drop-preview" style={rectStyle(previewRect(geometry.groups.get(drag.target.groupId)!,drag.target.edge))} role="status"><span>{labels[drag.target.edge]}</span></div>}
    {externalDrop&&<div className="workspace-drop-preview" style={rectStyle(previewRect(geometry.groups.get(externalDrop.groupId)!,externalDrop.edge))} role="status"><span>{labels[externalDrop.edge]}</span></div>}
    {menu&&<div role="menu" aria-label="标签操作" className="workspace-tab-menu" style={{left:menu.x,top:menu.y}}>
      {(['left','right','top','bottom'] as const).map(edge=><button key={edge} role="menuitem" onClick={()=>move(menu.viewId,findGroup(layout,menu.viewId)!.id,edge)}>{labels[edge]}</button>)}
      {groups(layout.root).filter(group=>!group.tabs.includes(menu.viewId)).map((group,index)=><button key={group.id} role="menuitem" onClick={()=>move(menu.viewId,group.id,'center')}>移到标签组 {index+1}</button>)}
      {onWindow&&layout.views[menu.viewId]?.kind==='note'&&<><button role="menuitem" onClick={()=>{onWindow(layout.views[menu.viewId],false);setMenu(null);}}>在新窗口打开</button><button role="menuitem" onClick={()=>{onWindow(layout.views[menu.viewId],true);setMenu(null);}}>移到新窗口</button></>}
      {onChooseWindow&&layout.views[menu.viewId]?.kind==='note'&&<button role="menuitem" onClick={()=>{onChooseWindow(layout.views[menu.viewId]);setMenu(null);}}>移到其他窗口…</button>}
      <button role="menuitem" onClick={()=>{if(onUndoLayout)onUndoLayout();else store.undo();setMenu(null);}}>撤销布局移动</button>
      <button role="menuitem" onClick={()=>void close(menu.viewId)}>关闭标签</button>
      <button role="menuitem" onClick={()=>setMenu(null)}>取消</button>
    </div>}
    {(error||store.storageError)&&<div role="alert" className="workspace-error">{error||store.storageError}<button onClick={()=>setError(null)}>关闭提示</button></div>}
  </div>;
}

function WorkspaceDivider({divider,store,onPreview}:{divider:ReturnType<typeof measureLayout>['dividers'][number];store:LayoutStore;onPreview:(value:{splitId:string;ratio:number}|null)=>void}){
  const drag=useRef<{id:number;ratio:number}|null>(null);
  const cancel=()=>{drag.current=null;onPreview(null);};
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')cancel();};window.addEventListener('keydown',escape);window.addEventListener('blur',cancel);return()=>{window.removeEventListener('keydown',escape);window.removeEventListener('blur',cancel);};},[]);
  return <div className={`workspace-divider axis-${divider.axis}`} style={rectStyle(divider.rect)} role="separator" tabIndex={0}
    aria-label="调整分屏尺寸" aria-orientation={divider.axis==='row'?'vertical':'horizontal'} aria-valuenow={Math.round(divider.ratio*100)} aria-valuemin={8} aria-valuemax={92}
    onKeyDown={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();store.dispatch({type:'resize',splitId:divider.id,ratio:divider.ratio+(event.key==='ArrowLeft'||event.key==='ArrowUp'?-.05:.05)});}}}
    onPointerDown={event=>{if(event.button!==0)return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:event.pointerId,ratio:divider.ratio};}}
    onPointerMove={event=>{if(drag.current?.id!==event.pointerId)return;const bounds=event.currentTarget.parentElement!.getBoundingClientRect(),rect=divider.container;
      const next=divider.axis==='row'?(event.clientX-bounds.left-rect.left)/Math.max(1,rect.width-6):(event.clientY-bounds.top-rect.top)/Math.max(1,rect.height-6);drag.current.ratio=Math.max(.08,Math.min(.92,next));onPreview({splitId:divider.id,ratio:drag.current.ratio});}}
    onPointerUp={event=>{if(drag.current?.id!==event.pointerId)return;const ratio=drag.current.ratio;cancel();store.dispatch({type:'resize',splitId:divider.id,ratio});if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
    onPointerCancel={cancel} onLostPointerCapture={cancel}/>
}
