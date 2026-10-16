import {useEffect,useMemo,useRef,useState} from 'react';
import {NamedLayouts,type NamedLayout} from './namedLayouts';
import type {LayoutStore} from './layoutStore';
export function LayoutLibrary({store,beforeRestore,onClose}:{store:LayoutStore;beforeRestore:()=>Promise<boolean>;onClose:()=>void}){
  const library=useMemo(()=>new NamedLayouts(store.windowId,localStorage),[store]);
  const initial=useMemo(()=>{try{return {items:library.list(),error:''};}catch(error){return {items:[] as NamedLayout[],error:String(error)};}},[library]);
  const [items,setItems]=useState<NamedLayout[]>(initial.items);
  const [name,setName]=useState('');const [error,setError]=useState(initial.error);const [busy,setBusy]=useState(false);
  const dialog=useRef<HTMLElement>(null);
  const previous=useRef(document.activeElement as HTMLElement|null);
  useEffect(()=>()=>{if(previous.current?.isConnected)previous.current.focus();},[]);
  const save=(id?:string)=>{try{library.save(name,store.getSnapshot(),id);setItems(library.list());setError('');setName('');}catch(error){setError(String(error));}};
  const restore=async(item:NamedLayout)=>{
    if(busy)return;setBusy(true);setError('');
    try{if(!await beforeRestore())throw Error('当前笔记尚未安全保存，布局未替换。');
      const current=library.list().find(row=>row.id===item.id);if(!current||!store.restore(current.layout))throw Error('该布局已失效，当前窗口保持不变。');onClose();
    }catch(error){setError(String(error));}finally{setBusy(false);}
  };
  return <div className="workspace-picker-backdrop" onPointerDown={event=>{if(!busy&&event.target===event.currentTarget)onClose();}}><section ref={dialog} className="workspace-picker" role="dialog" aria-modal="true" aria-label="命名布局" onKeyDown={event=>{
    if(event.key==='Escape'&&!busy){event.stopPropagation();onClose();}
    if(event.key==='Tab'){
      const elements=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')??[]);
      const first=elements[0],last=elements[elements.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }}>
    <header>命名布局<button onClick={onClose} disabled={busy}>关闭</button></header>
    <p>仅保存当前窗口的标签与分屏安排，不复制笔记内容。上次会话仍会自动恢复；应用布局后可撤销。</p>
    <input autoFocus aria-label="布局名称" maxLength={64} placeholder="布局名称" value={name} onChange={event=>setName(event.target.value)}/>
    <button disabled={!name.trim()||busy} onClick={()=>save()}>保存为新布局</button>
    {error&&<p role="alert">{error}</p>}
    <div>{items.map(item=><section key={item.id} className="workspace-preset-row"><strong>{item.name}</strong><small>{new Date(item.savedAt).toLocaleString()}</small><div>
      <button disabled={busy} onClick={()=>void restore(item)}>应用到此窗口</button>
      <button disabled={busy||!name.trim()} onClick={()=>{if(window.confirm(`用当前布局替换“${item.name}”？`))save(item.id);}}>替换并使用上方名称</button>
      <button disabled={busy} onClick={()=>{if(!window.confirm(`移除已保存的布局“${item.name}”？笔记不会删除。`))return;try{library.remove(item.id);setItems(library.list());}catch(error){setError(String(error));}}}>移除</button>
    </div></section>)}{!items.length&&<p>尚未保存命名布局。</p>}</div>
  </section></div>;
}
