import {useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {useApplicationModalSurface} from '../app/applicationModalIsolation';
import {captureIntegratedLayouts,restoreIntegratedLayouts} from './integratedLayoutRegistry';
import {IntegratedPresets,type IntegratedPreset} from './integratedPresets';
import {defaultPresentation} from './presentation';
import {navigationRouteHidden,resolveNavigationPresentation} from './navigationVisibility';
import {readSavedSettings} from '../features/settings/useSettings';
import type {LayoutStore} from './layoutStore';

export function IntegratedLayoutManager({store,route,onClose}:{store:LayoutStore;route:string;onClose:()=>void}){
 const library=useMemo(()=>new IntegratedPresets(localStorage),[]);
 const initial=useMemo(()=>{try{return {items:library.list(),error:''};}catch(error){return {items:[] as IntegratedPreset[],error:String(error)};}},[library]);
 const [items,setItems]=useState(initial.items),[error,setError]=useState(initial.error),[name,setName]=useState(''),[busy,setBusy]=useState(false);
 const busyRef=useRef(false);
 const [confirmation,setConfirmation]=useState<{kind:'remove'|'update';id:string}|null>(null);
 const surface=useApplicationModalSurface<HTMLElement>(true,onClose,{closeOnEscape:!busy,closeOnBackdrop:!busy});
 const layout=useSyncExternalStore(store.subscribe,store.getSnapshot);
 const presentation=resolveNavigationPresentation(layout.presentation??defaultPresentation(),readSavedSettings()["general.showCollectionNav"]===true);
 const hiddenCount=presentation.navigation.space.hidden.length+presentation.navigation.filters.hidden.length+(presentation.materialsToolbar?.hidden.length??0);
 const showHiddenControls=()=>{if(!store.applyPresentation({...presentation,navigation:{space:{...presentation.navigation.space,hidden:[]},filters:{...presentation.navigation.filters,hidden:[]}},...(presentation.materialsToolbar?{materialsToolbar:{...presentation.materialsToolbar,hidden:[]}}:{})}))setError(store.storageError??'布局未保存。');else onClose();};
 const save=(item?:IntegratedPreset)=>{
  if(busyRef.current)return;
  try{
   // Updating a row retains that row's name. The input is exclusively save-as.
   library.save({name:item?.name??name,route:route==='workspace'?'notes':route,presentation:resolveNavigationPresentation(store.getSnapshot().presentation??defaultPresentation(),readSavedSettings()["general.showCollectionNav"]===true),pages:captureIntegratedLayouts()},item?.id);
   setItems(library.list());if(!item)setName('');setError('');setConfirmation(null);
  }catch(error){setError(String(error));}
 };
 const restore=async(item:IntegratedPreset)=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');setConfirmation(null);
  try{
   const current=library.list().find(row=>row.id===item.id);if(!current)throw Error('此布局已不存在。');
   const restoredPresentation=resolveNavigationPresentation(current.presentation,readSavedSettings()["general.showCollectionNav"]===true);
   await restoreIntegratedLayouts(current.pages,()=>{
    if(!store.applyPresentation(restoredPresentation))throw Error(store.storageError??'布局未保存。');
   });
   const target=navigationRouteHidden(current.route,{presentation:restoredPresentation,pluginKeys:[]})?'settings':current.route;
   window.location.hash=`#${target}`;onClose();
  }catch(error){setError(String(error));}finally{busyRef.current=false;setBusy(false);}
 };
 return createPortal(<div className="integrated-layout-backdrop" onPointerDown={surface.onBackdropPointerDown}>
  <section ref={surface.surfaceRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="integrated-layout-title" className="integrated-layout-manager" onKeyDown={surface.onSurfaceKeyDown}>
   <header><h2 id="integrated-layout-title">管理布局</h2><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}>×</button></header>
   <form onSubmit={event=>{event.preventDefault();save();}}><input data-modal-initial-focus aria-label="新布局名称" maxLength={64} placeholder="输入新布局名称…" value={name} onChange={event=>setName(event.target.value)} disabled={busy}/><button type="submit" disabled={busy||!name.trim()}>另存为新布局</button></form>
   {error&&<p role="alert" className="integrated-layout-error">{error}</p>}
   {items.length>0&&<div className="integrated-layout-list">{items.map(item=><div className="integrated-layout-row" key={item.id}>
    <div className="integrated-layout-details"><span title={item.name}>{item.name}</span><small>{new Date(item.savedAt).toLocaleDateString()}</small></div>
    {confirmation?.id===item.id?<div className="integrated-layout-confirm"><span>{confirmation.kind==='remove'?`移除“${item.name}”？`:`用当前布局覆盖“${item.name}”？`}</span><button type="button" disabled={busy} onClick={()=>{if(confirmation.kind==='update')save(item);else try{library.remove(item.id);setItems(library.list());setConfirmation(null);setError('');}catch(error){setError(String(error));}}}>{confirmation.kind==='update'?'确认覆盖':'确认移除'}</button><button type="button" disabled={busy} onClick={()=>setConfirmation(null)}>取消</button></div>:<div className="integrated-layout-actions"><button type="button" disabled={busy} aria-label={`应用布局 ${item.name}`} onClick={()=>void restore(item)}>应用</button><button type="button" disabled={busy} aria-label={`更新布局 ${item.name}`} onClick={()=>setConfirmation({kind:'update',id:item.id})}>更新此布局</button><button type="button" disabled={busy} aria-label={`移除布局 ${item.name}`} onClick={()=>setConfirmation({kind:'remove',id:item.id})}>×</button></div>}
   </div>)}</div>}
   <footer>直接拖动导航与工具可调整顺序。Alt + 方向键也可移动。{hiddenCount>0&&<button type="button" disabled={busy} onClick={showHiddenControls}>显示隐藏的导航与工具</button>}</footer>
  </section>
 </div>,document.body);
}
