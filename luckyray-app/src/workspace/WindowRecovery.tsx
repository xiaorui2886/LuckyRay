import {useEffect,useRef,useState} from 'react';
import {workspaceCommand} from './nativeClient';
export type RecoverableWindow={id:string;closed:boolean;title:string;tabs:number};
export async function restorePreviousWindows(){
 const windows=await workspaceCommand<RecoverableWindow[]>({op:'recoverableWindows'});
 const errors:string[]=[];for(const window of windows.filter(window=>!window.closed))try{await workspaceCommand({op:'restoreWindow',id:window.id});}catch(error){errors.push(`${window.title}: ${String(error)}`);}
 if(errors.length)throw Error(errors.join('\n'));
}
export function WindowRecovery({onClose}:{onClose:()=>void}){
 const [items,setItems]=useState<RecoverableWindow[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const dialog=useRef<HTMLElement>(null),previous=useRef(document.activeElement as HTMLElement|null);
 useEffect(()=>()=>{if(previous.current?.isConnected)previous.current.focus();},[]);
 const refresh=()=>workspaceCommand<RecoverableWindow[]>({op:'recoverableWindows'}).then(setItems);
 useEffect(()=>{void refresh().catch(error=>setError(String(error)));},[]);
 const restore=async(id:string)=>{setBusy(true);setError('');try{await workspaceCommand({op:'restoreWindow',id});await refresh();}catch(error){setError(String(error));}finally{setBusy(false);}};
 return <div className="workspace-picker-backdrop" onPointerDown={event=>{if(!busy&&event.target===event.currentTarget)onClose();}}><section ref={dialog} className="workspace-picker" role="dialog" aria-modal="true" aria-label="恢复工作区窗口" onKeyDown={event=>{if(event.key==='Escape'&&!busy)onClose();if(event.key==='Tab'){const items=Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
  <header>恢复工作区窗口<button autoFocus disabled={busy} onClick={onClose}>关闭</button></header><p>恢复原来的标签、分屏和工具布局；不复制或覆盖笔记内容。暂不可用的库会保留占位标签。</p>
  {error&&<p role="alert">{error}</p>}{items.map(item=><button disabled={busy} key={item.id} onClick={()=>void restore(item.id)}>{item.title}<small>{item.tabs} 个标签 · {item.closed?'最近关闭':'上次会话'}</small></button>)}{!items.length&&<p>没有待恢复的窗口。</p>}
 </section></div>;
}
