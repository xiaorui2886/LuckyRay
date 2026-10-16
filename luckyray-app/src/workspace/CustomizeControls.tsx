import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {reorderControl,type ControlOrder} from './presentation';
import './customization.css';
export type ControlGroup={id:string;label:string;items:{id:string;label:string}[];value:ControlOrder};
export function CustomizeControls({title,groups,onApply,onClose}:{title:string;groups:ControlGroup[];onApply:(value:Record<string,ControlOrder>)=>void;onClose:()=>void}){
 const [draft,setDraft]=useState(()=>Object.fromEntries(groups.map(g=>[g.id,g.value])));const [error,setError]=useState('');
 const dialog=useRef<HTMLElement>(null);const previous=useRef(document.activeElement as HTMLElement|null);
 useEffect(()=>()=>{if(previous.current?.isConnected)previous.current.focus();},[]);
 const move=(group:string,id:string,index:number)=>setDraft(current=>({...current,[group]:reorderControl(current[group],id,index)}));
 return createPortal(<div className="workspace-customize-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={dialog} role="dialog" aria-modal="true" aria-label={title} className="workspace-customize" onKeyDown={event=>{
  if(event.key==='Escape'){event.stopPropagation();onClose();}
  if(event.key==='Tab'){const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')??[]);const index=items.indexOf(document.activeElement as HTMLElement);if(event.shiftKey&&index===0){event.preventDefault();items[items.length-1]?.focus();}else if(!event.shiftKey&&index===items.length-1){event.preventDefault();items[0]?.focus();}}
 }}>
  <header><h2>{title}</h2><button onClick={onClose}>取消</button></header><p>拖动条目或用上下按钮排序；取消勾选可隐藏。设置和自定义入口始终保留。</p>
  <div className="workspace-customize-list">{groups.map(group=><section key={group.id}><h3>{group.label}</h3>{draft[group.id].order.map((id,index)=>{const item=group.items.find(item=>item.id===id);if(!item)return null;return <div className="workspace-customize-row" key={id} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-luckyray-control-order',JSON.stringify({group:group.id,id}));}} onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-luckyray-control-order')){event.preventDefault();event.dataTransfer.dropEffect='move';}}} onDrop={event=>{try{const data=JSON.parse(event.dataTransfer.getData('application/x-luckyray-control-order'));if(data.group!==group.id||!group.items.some(item=>item.id===data.id))return;event.preventDefault();move(group.id,data.id,index);}catch{/* An unrelated file/material drag cannot configure UI. */}}}>
    <span aria-hidden="true">⠿</span><label><input type="checkbox" checked={!draft[group.id].hidden.includes(id)} onChange={event=>setDraft(current=>({...current,[group.id]:{...current[group.id],hidden:event.target.checked?current[group.id].hidden.filter(value=>value!==id):[...current[group.id].hidden,id]}}))}/>{item.label}</label>
    <button aria-label={`上移${item.label}`} disabled={index===0} onClick={()=>move(group.id,id,index-1)}>↑</button><button aria-label={`下移${item.label}`} disabled={index===draft[group.id].order.length-1} onClick={()=>move(group.id,id,index+1)}>↓</button>
  </div>;})}</section>)}</div>
  {error&&<p role="alert">{error}</p>}<footer><button onClick={()=>setDraft(Object.fromEntries(groups.map(g=>[g.id,{order:g.items.map(item=>item.id),hidden:[]}])))}>恢复默认</button><button autoFocus onClick={()=>{try{onApply(draft);onClose();}catch(error){setError(String(error));}}}>应用</button></footer>
 </section></div>,document.body);
}
