import {useEffect,useRef,useState} from 'react';
import {workspaceCommand,type NativeWindowSession} from './nativeClient';
export function WindowChooser({current,onChoose,onClose,onMain}:{current:string;onChoose:(label:string)=>void;onClose:()=>void;onMain?:()=>void}){
 const [windows,setWindows]=useState<NativeWindowSession[]>([]),[error,setError]=useState('');const dialog=useRef<HTMLElement>(null);const previous=useRef(document.activeElement as HTMLElement|null);
 useEffect(()=>{let alive=true;void workspaceCommand<NativeWindowSession[]>({op:'list'}).then(value=>{if(alive)setWindows(value.filter(window=>window.label!==current));}).catch(error=>setError(String(error)));return()=>{alive=false;if(previous.current?.isConnected)previous.current.focus();};},[current]);
 return <div className="workspace-picker-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={dialog} className="workspace-picker" role="dialog" aria-modal="true" aria-label="选择目标窗口" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}if(event.key==='Tab'){const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')??[]);if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items[items.length-1]?.focus();}else if(!event.shiftKey&&document.activeElement===items[items.length-1]){event.preventDefault();items[0]?.focus();}}}}>
  <header>移到其他窗口<button autoFocus onClick={onClose}>取消</button></header><p>目标窗口确认收到最新内容后，才移除原标签。</p>
  {error&&<p role="alert">{error}</p>}{onMain&&<button onClick={onMain}>主窗口</button>}
  {windows.map(window=><button key={window.label} onClick={()=>onChoose(window.label)}>{window.view.title}<small>{window.views?.filter(view=>view.open).length??1} 个标签 · {window.view.libraryId}</small></button>)}
  {!windows.length&&!onMain&&<p>没有其他工作区窗口。可从标签菜单选择“移到新窗口”。</p>}
 </section></div>;
}
