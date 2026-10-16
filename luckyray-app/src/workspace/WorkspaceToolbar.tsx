import {useState,useSyncExternalStore} from 'react';
import type {LayoutStore} from './layoutStore';
import {groups} from './layout';
import {arrangeControls,defaultPresentation} from './presentation';
import {CustomizeControls} from './CustomizeControls';
import {emptyTools,moveTool,toolNames,type ToolKind} from './toolLayout';
const items=[{id:'open-note',label:'打开笔记'},{id:'open-graph',label:'添加图谱'},{id:'open-materials',label:'添加素材'},{id:'layouts',label:'命名布局'},{id:'windows',label:'恢复窗口'},{id:'tools',label:'工具面板'}];
export function WorkspaceToolbar({store,onAction}:{store:LayoutStore;onAction:(id:string)=>void}){
 const layout=useSyncExternalStore(store.subscribe,store.getSnapshot);const presentation=layout.presentation??defaultPresentation();const [customizing,setCustomizing]=useState(false);
 return <div className="workspace-toolbar"><strong>工作区体验</strong>{arrangeControls(items,presentation.toolbar).map(item=>item.id==='tools'?<select key={item.id} aria-label="打开工具面板" value="" onChange={event=>{if(event.target.value)store.dispatch({type:'tools',tools:moveTool(layout.tools??emptyTools(),event.target.value as ToolKind,'right')});}}><option value="">工具面板…</option>{Object.entries(toolNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>:<button key={item.id} onClick={()=>onAction(item.id)}>{item.label}</button>)}
  <button aria-label="自定义工具栏" title="自定义工具栏" onClick={()=>setCustomizing(true)}>☷</button><span>{groups(layout.root).length} 个标签组</span>
  {customizing&&<CustomizeControls title="自定义工具栏" groups={[{id:'toolbar',label:'工作区快捷工具',items,value:presentation.toolbar}]} onApply={value=>{store.dispatch({type:'presentation',presentation:{...presentation,toolbar:value.toolbar}});if(store.storageError)throw Error(store.storageError);}} onClose={()=>setCustomizing(false)}/>}
 </div>;
}
