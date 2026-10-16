import {useState} from 'react';
import {isReferencePack,packMembers,planReferencePack,type PackNode,type ReferencePackKind} from '../../core/canvas/creativeReview';
import type {CanvasSemanticEdge} from '../../core/canvas/edgeSemantics';
import {CanvasCreativeDialog} from './CanvasCreativeDialog';
import './canvasCreative.css';

export function CanvasReferencePacks({nodes,edges,selectedIds,resolveUrl,english=false,onCreate,onRename,onUnmark,onApply,onLocate,onClose}:{
 nodes:readonly PackNode[];edges:readonly CanvasSemanticEdge[];selectedIds:readonly string[];resolveUrl:(url:string)=>string;english?:boolean;
 onCreate:(name:string,kind:ReferencePackKind)=>string|null;onRename:(id:string,name:string)=>void;
 onUnmark:(id:string)=>void;onApply:(id:string,target:string)=>string|null;onLocate:(id:string)=>void;onClose:()=>void;
}){
 const [name,setName]=useState(''),[kind,setKind]=useState<ReferencePackKind>('character'),[notice,setNotice]=useState('');
 const [target,setTarget]=useState(()=>selectedIds.find(id=>nodes.find(n=>n.id===id)?.data.kind==='generator')||'');
 const [remove,setRemove]=useState<string|null>(null),[rename,setRename]=useState<{id:string;name:string}|null>(null);
 const packs=nodes.filter(isReferencePack),targets=nodes.filter(node=>node.data.kind==='generator');
 const categories:Record<ReferencePackKind,string>={character:english?'Character':'角色',product:english?'Product':'产品',style:english?'Style':'风格'};
 const errors:Record<string,string>={
  'missing-pack':english?'This pack no longer exists.':'参考包已不存在。',
  'empty-pack':english?'This pack has no members.':'参考包中没有内容。',
  'invalid-target':english?'Choose a generation card outside this pack.':'请选择包外的生成卡。',
  'missing-content':english?'A member is empty or unavailable. Fix it on the canvas first.':'包内有空白或不可用内容，请先在画布中补齐。',
  'too-many-inputs':english?'This would exceed the current four-input limit. Nothing was changed.':'会超过当前四项输入上限，未修改任何现有参考。',
  'invalid-selection':english?'Select at least two ungrouped references, or one existing group.':'先选中至少两张未分组参考卡，或一个现有分组。',
  'invalid-name':english?'Enter a name (up to 60 characters).':'请输入名称（不超过60字）。',
 };
 return <CanvasCreativeDialog title={english?'Reference packs':'参考包'} onClose={onClose} english={english} compact>
  <div className="canvas-pack-content">
   <p className="canvas-creative-hint">{english?'Keep related references together. Apply a pack to connect them to a generation card.':'把相关参考放在一起，应用时连接到生成卡。'}</p>
   <div className="canvas-pack-selection"><span>{english ? `${selectedIds.length} selected` : `已选 ${selectedIds.length} 项`}</span><button type="button" onClick={onClose}>{english ? 'Select on canvas' : '回画布选择'}</button></div>
   <form className="canvas-pack-create" onSubmit={e=>{e.preventDefault();const error=onCreate(name,kind);setNotice(error?errors[error]||error:english?'Pack saved. Choose a target below to reuse it.':'参考包已保存，选择下方生成卡即可复用。');if(!error)setName('');}}>
    <input aria-label={english?'Pack name':'参考包名称'} maxLength={60} placeholder={english?'E.g. hero / product identity':'如：主角设定 / 产品外观'} value={name} onChange={e=>setName(e.target.value)}/>
    <select aria-label={english?'Pack category':'参考包类别'} value={kind} onChange={e=>setKind(e.target.value as ReferencePackKind)}>{Object.entries(categories).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
    <button type="submit" className="is-primary" disabled={!name.trim()||!selectedIds.length}>{english?'Save selection':'将所选保存为参考包'}</button>
   </form>
   {packs.length ? <label className="canvas-pack-target">{english?'Apply to':'应用到'}<select aria-label={english?'Target generation card':'目标生成卡'} value={targets.some(n=>n.id===target)?target:''} onChange={e=>setTarget(e.target.value)}><option value="">{english?'Choose a generation card':'选择一张生成卡'}</option>{targets.map(n=><option key={n.id} value={n.id}>{n.data.label||n.id} · {n.id.slice(-6)}</option>)}</select></label> : null}
   {notice?<p className="canvas-creative-notice" role="status">{notice}</p>:null}
   <div className="canvas-pack-grid">{packs.map(pack=>{
    const members=packMembers(nodes,pack.id),plan=planReferencePack(nodes,edges,pack.id,target);
    return <article key={pack.id} className="canvas-pack-card">
     <header><span className="canvas-pack-category">{categories[pack.data.referencePack!.kind]}</span><small>{members.length} {english?'references':'项参考'}</small></header>
     {rename?.id===pack.id?<form onSubmit={e=>{e.preventDefault();if(!rename.name.trim())return;onRename(pack.id,rename.name.trim());setRename(null);}}><input aria-label={english?'Rename pack':'重命名参考包'} maxLength={60} value={rename.name} onChange={e=>setRename({...rename,name:e.target.value})}/><button type="submit">{english?'Save':'保存'}</button><button type="button" onClick={()=>setRename(null)}>{english?'Cancel':'取消'}</button></form>:<h3>{pack.data.label}</h3>}
     <div className="canvas-pack-preview-strip">{members.slice(0,4).map(member=><PackPreview key={member.id} member={member} resolveUrl={resolveUrl}/>)}</div>
     <ul>{members.map(member=><li key={member.id}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={member.data.kind==='noteRef'||member.data.kind==='text'?'M6 3h9l3 3v15H6ZM9 10h6M9 14h6M9 18h4':'M3 4h18v16H3ZM3 16l5-5 4 4 3-3 6 6M15 8h.01'}/></svg><span>{member.data.label||member.id}</span></li>)}</ul>
     {!members.length?<p>{english?'Add content to the group on the canvas.':'请在画布分组中补充内容。'}</p>:null}
     <footer><button type="button" className="is-primary" disabled={!plan.ok} title={!plan.ok?errors[plan.error]:undefined} onClick={()=>{const error=onApply(pack.id,target);setNotice(error?errors[error]||error:english?'References connected. Review the prompt and generate when ready.':'参考已连接，请确认提示词后自行生成。');}}>{plan.ok&&!plan.edges.length?(english?'Already connected':'已连接'):(english?'Use pack':'应用参考包')}</button>
      <button type="button" onClick={()=>{onLocate(pack.id);onClose();}}>{english?'Locate':'定位'}</button><button type="button" onClick={()=>setRename({id:pack.id,name:pack.data.label||''})}>{english?'Rename':'改名'}</button>
      <button type="button" onClick={()=>{if(remove===pack.id){onUnmark(pack.id);setRemove(null);}else setRemove(pack.id);}}>{remove===pack.id?(english?'Confirm unmark':'确认取消标记'):(english?'Unmark':'取消参考包')}</button></footer>
     {remove===pack.id?<p className="canvas-creative-hint">{english?'The group, content and connections will remain.':'只取消参考包标记，保留分组、内容和连线。'}<button type="button" onClick={()=>setRemove(null)}>{english?'Cancel':'取消'}</button></p>:null}
    </article>;
   })}</div>
   {!packs.length?<div className="canvas-creative-empty"><strong>{english?'Your first reference pack':'保存第一组参考'}</strong><span>{english?'Select two or more image/text cards, or an existing group. Name it here and save.':'在画布选中两张以上图片／说明卡，或一个现有分组，回来起名保存。'}</span></div>:null}
  </div>
 </CanvasCreativeDialog>;
}

function PackPreview({member,resolveUrl}:{member:PackNode;resolveUrl:(url:string)=>string}){
 const [broken,setBroken]=useState<string|null>(null);
 const url=member.data.refThumbnailUrl||member.data.resultThumbnailUrl||((member.data.kind==='image'||member.data.generationKind==='image')?(member.data.refMediaUrl||member.data.resultMediaUrl):null);
 return <div className="canvas-pack-preview" title={member.data.label}>{url&&broken!==url?<img src={resolveUrl(url)} alt={member.data.label||''} loading="lazy" onError={()=>setBroken(url)}/>:<svg viewBox="0 0 24 24" aria-hidden="true"><path d={member.data.kind==='text'||member.data.kind==='noteRef'?'M6 3h9l3 3v15H6ZM9 10h6M9 14h6M9 18h4':'M3 4h18v16H3ZM3 16l5-5 4 4 3-3 6 6M15 8h.01'}/></svg>}</div>;
}
