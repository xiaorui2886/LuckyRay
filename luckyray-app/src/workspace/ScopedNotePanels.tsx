import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {NoteDocumentController} from '../features/notes/NoteDocumentController';
import {unwrapNoteResult,type NoteActionValue,type NoteMetadata,type NoteParentAction,type NoteTargetTicket} from '../features/notes/NoteRuntime';
import type {NativeNoteRuntime,NativeNoteAttachmentRow} from './nativeNoteRuntime';
import {workspaceOutline} from './noteOutline';
import {submitNoteTagSelection,type NoteTagSelectionBaseline} from '../features/notes/noteTagSelection';
import '../features/notes/noteAttachmentSidebar.css';

export type ScopedNotePanelProps={controller:NoteDocumentController;runtime:NativeNoteRuntime;viewId:string;close:()=>void;interactionLocked?:boolean;onNavigate?:(range:{start:number;end:number})=>void;getSelection?:()=>{start:number;end:number};requestAction?:(action:NoteParentAction)=>Promise<NoteActionValue>};
async function panelRequest(props:ScopedNotePanelProps,action:NoteParentAction){
 if(props.requestAction)return props.requestAction(action);
 const result=await props.controller.request(props.viewId,action);
 if(result.kind==='saved')props.controller.session.receive(result.snapshot);
 if(result.kind==='replace-range'){const state=props.controller.session.getSnapshot();props.controller.edit(state.content.slice(0,result.selection.start)+result.text+state.content.slice(result.selection.end));}
 return result;
}
const fail=(error:unknown)=>error instanceof Error?error.message:String(error);
export function scopedNotePanelReadiness(runtime:NativeNoteRuntime,services:{outline:boolean;management:boolean;attachments:boolean}){
 const missing=[...runtime.readiness().missing];
 if(!services.outline)missing.push('panel:outline-navigation');if(!services.management)missing.push('panel:main-knowledge-management');if(!services.attachments)missing.push('panel:current-attachments-and-main-catalog');
 if(typeof runtime.listNotes!=='function'||typeof runtime.queryNotes!=='function')missing.push('panel:ticketed-vault-index');
 return {complete:missing.length===0,missing};
}

/** Every row comes from the captured vault's native index; opening still needs
 * its per-view/revision ticket. The index never installs a library writer. */
export function ScopedNoteIndexPanel(props:ScopedNotePanelProps){
 const {controller,runtime,viewId,close,interactionLocked=false,onNavigate}=props;
 const state=useSyncExternalStore(controller.session.subscribe,controller.session.getSnapshot);
 const [query,setQuery]=useState(''),[items,setItems]=useState<Array<{id:string;title:string;snippet:string;target:NoteTargetTicket}>>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[limited,setLimited]=useState(false);
 const [tab,setTab]=useState<'notes'|'relations'|'outline'|'assets'>('notes'),[metadata,setMetadata]=useState<NoteMetadata|null>(null),[sort,setSort]=useState<'title-asc'|'title-desc'>('title-asc');
 const serial=useRef(0);
 const load=async(append=false)=>{
  if(!state.revision||state.dirty)return;const request=++serial.current,revision=state.revision;setBusy(true);setError('');
  try{const result=query.trim()?unwrapNoteResult(await runtime.queryNotes(query,revision,64)):unwrapNoteResult(await runtime.listNotes(revision,append?cursor:null));
   if(request!==serial.current||controller.session.getSnapshot().revision!==revision)return;
   // Native pagination rotates page tickets. Never leave old clickable rows
   // on screen after those tickets have been revoked.
   setItems(result.notes);setCursor('nextCursor' in result?result.nextCursor:null);setLimited(result.completeness.truncated);
  }catch(cause){if(request===serial.current)setError(fail(cause));}finally{if(request===serial.current)setBusy(false);}
 };
 useEffect(()=>{setItems([]);setCursor(null);const timer=setTimeout(()=>void load(),query?180:0);return()=>{clearTimeout(timer);serial.current++;};},[runtime,state.revision,state.dirty,query]);
 useEffect(()=>{let live=true;void controller.metadata(viewId).then(value=>{if(live)setMetadata(value);}).catch(cause=>{if(live)setError(fail(cause));});return()=>{live=false;};},[controller,viewId,state.revision]);
 const run=async(action:NoteParentAction)=>{try{await panelRequest(props,action);}catch(cause){setError(fail(cause));}};
 return <aside className="notes-index-panel" aria-label="当前知识库笔记索引"><header><strong>笔记索引</strong><button type="button" onClick={close}>关闭</button></header>
  <div className="notes-vault-row"><span className="notes-vault-title">{controller.authority.vaultId}</span><button type="button" disabled={interactionLocked} onClick={()=>void run({kind:'browse-documents',section:'vaults'})}>主窗口知识库</button><button type="button" disabled={interactionLocked} onClick={()=>void run({kind:'browse-documents',section:'settings'})}>知识库设置</button></div>
  <div className="notes-index-tools"><button type="button" disabled={interactionLocked} onClick={()=>{const title=window.prompt('新笔记名称');if(title?.trim())void run({kind:'create-note',title:title.trim()});}}>新建笔记</button><button type="button" disabled={interactionLocked} onClick={()=>void run({kind:'import-document'})}>导入 Markdown</button><button type="button" disabled={interactionLocked} onClick={()=>void run({kind:'export-document',format:'markdown'})}>导出当前笔记</button></div>
  <button type="button" disabled={interactionLocked} onClick={()=>void run({kind:'browse-documents',section:'folders'})}>在主窗口新建、移动或管理文件夹…</button>
  <div className="backlinks-tabs" role="tablist" aria-label="索引内容">{([['relations','关系'],['outline','大纲'],['notes','笔记'],['assets','附件']] as const).map(([id,label])=><button key={id} type="button" role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
  {tab==='notes'&&<>
  <input aria-label="搜索笔记标题" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索此知识库的笔记…" maxLength={120}/>
  <select aria-label="本页排序" value={sort} onChange={event=>setSort(event.target.value as typeof sort)}><option value="title-asc">本页标题升序</option><option value="title-desc">本页标题降序</option></select>
  {state.dirty&&<p role="status">保存当前输入后更新索引。</p>}{error&&<p role="alert">{error}<button type="button" onClick={()=>void load()}>重试</button></p>}
  <ul className="notes-local-search-results">{[...items].sort((a,b)=>a.title.localeCompare(b.title)*(sort==='title-asc'?1:-1)).map(item=><li key={item.id}><button type="button" disabled={interactionLocked||state.dirty} onClick={()=>void run({kind:'open-note',target:item.target,newTab:true})}><strong>{item.title}</strong><span>{item.snippet}</span></button></li>)}</ul>
  {busy&&<p role="status">正在读取笔记索引…</p>}{!busy&&!error&&!items.length&&<p>没有匹配的笔记。</p>}{cursor&&<button type="button" disabled={busy||interactionLocked} onClick={()=>void load(true)}>下一页</button>}{limited&&!cursor&&query.trim()&&<p>匹配结果超过 64 项，请缩小搜索范围。</p>}
  </>}
  {tab==='outline'&&<section aria-label="当前笔记大纲">{workspaceOutline(state.content).map((heading,index)=><button key={`${heading.from}:${index}`} type="button" disabled={!onNavigate||interactionLocked} style={{display:'block',paddingInlineStart:8+(heading.level-1)*12}} onClick={()=>onNavigate?.({start:heading.from,end:heading.from})}>{heading.text}</button>)}{!workspaceOutline(state.content).length&&<p>当前笔记没有标题。</p>}{!onNavigate&&<p role="alert">此视图尚未接入大纲定位。</p>}</section>}
  {tab==='relations'&&<section aria-label="当前笔记关系"><h3>引用的笔记</h3>{metadata?.links.filter(link=>!link.isMissing).map((link,index)=>{const target=metadata.notes.find(note=>note.id===link.toNoteId)?.target;return <button key={`${link.targetTitle}:${index}`} type="button" disabled={!target||interactionLocked} onClick={()=>target&&void run({kind:'open-note',target,newTab:true})}>{link.targetTitle}</button>;})}<h3>缺失的笔记</h3>{metadata?.links.filter(link=>link.isMissing).map((link,index)=><button key={`${link.targetTitle}:${index}`} type="button" disabled={interactionLocked} onClick={()=>void run({kind:'create-note',title:link.targetTitle})}>创建 {link.targetTitle}</button>)}<h3>反向链接</h3>{metadata?.backlinks.map(link=><button key={link.target.ticket} type="button" disabled={interactionLocked} onClick={()=>void run({kind:'open-note',target:link.target,newTab:true})}>{link.target.title}<span>{link.snippet}</span></button>)}<button type="button" disabled={interactionLocked} onClick={()=>void run({kind:'browse-documents',section:'folders'})}>在主窗口查看完整关系和未链接提及</button></section>}
  {tab==='assets'&&<ScopedNoteAttachmentsPanel {...props} close={()=>setTab('notes')}/>}
 </aside>;
}

/** Current-note references plus explicit Main catalog/file selection. Missing
 * or newly typed references are visible, but never silently become grants. */
export function ScopedNoteAttachmentsPanel(props:ScopedNotePanelProps){
 const {controller,runtime,viewId,close,interactionLocked=false}=props;
 const state=useSyncExternalStore(controller.session.subscribe,controller.session.getSnapshot);
 const [rows,setRows]=useState<NativeNoteAttachmentRow[]>([]),[query,setQuery]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),[kind,setKind]=useState('');
 const [noteEmbeds,setNoteEmbeds]=useState<NonNullable<NoteMetadata['noteEmbeds']>>([]);
 useEffect(()=>{let live=true;if(!state.revision||state.dirty)return;setBusy(true);setError('');void Promise.all([runtime.listAttachments(state.revision).then(unwrapNoteResult),controller.metadata(viewId)]).then(([value,metadata])=>{if(live){setRows(value.references);setNoteEmbeds(metadata.noteEmbeds||[]);if(!value.complete)setError(value.missing.join('、')||'附件列表尚未完整。');}}).catch(cause=>{if(live)setError(fail(cause));}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[runtime,controller,viewId,state.revision,state.dirty,reload]);
 const run=async(action:NoteParentAction)=>{try{await panelRequest(props,action);setReload(value=>value+1);}catch(cause){setError(fail(cause));}};
 const selection=()=>props.getSelection?.()||{start:state.content.length,end:state.content.length};
 const noteKeys=new Set(noteEmbeds.map(embed=>JSON.stringify([embed.target,embed.wiki])));
 const filtered=rows.filter(row=>!noteKeys.has(JSON.stringify([row.target,row.wiki]))&&(!query||row.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))&&(!kind||row.mediaKind===kind));
 const filteredNotes=[...new Map(noteEmbeds.map(embed=>[JSON.stringify([embed.target,embed.wiki]),embed])).values()].filter(embed=>(!kind||kind==='file')&&(!query||embed.note.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
 const status={resolved:'',missing:'附件缺失',ungranted:'需要在主窗口明确选择此附件',unsupported:'此文件通过主窗口打开'};
 return <aside className="note-attachment-sidebar" aria-label="当前笔记附件"><header><strong>当前笔记附件</strong><button type="button" onClick={close}>关闭</button></header>
  <div className="note-attachment-toolbar"><button type="button" disabled={interactionLocked||state.dirty} onClick={()=>void run({kind:'insert-attachment',selection:selection()})}>从文件选择并插入</button><button type="button" disabled={interactionLocked||state.dirty} onClick={()=>void run({kind:'insert-existing-attachment',assetId:'',selection:selection()})}>从主窗口素材库选择</button><button type="button" disabled={busy} onClick={()=>setReload(value=>value+1)}>刷新</button></div>
  <input aria-label="筛选当前笔记附件" placeholder="搜索附件…" value={query} onChange={event=>setQuery(event.target.value)}/><select aria-label="附件类型" value={kind} onChange={event=>setKind(event.target.value)}><option value="">全部类型</option><option value="image">图片</option><option value="audio">音频</option><option value="video">视频</option><option value="file">文档与文件</option></select>
  {error&&<p role="alert">{error}</p>}{state.dirty&&<p role="status">请先保存当前笔记再插入附件。</p>}{busy&&<p role="status">正在读取附件…</p>}
  <div className="note-attachment-grid">{filteredNotes.map(embed=><div className="note-attachment-card" key={`note:${embed.target}`}><button type="button" className="note-attachment-thumb" disabled={interactionLocked} onClick={()=>void run({kind:'open-note',target:embed.note})}><span className="note-attachment-file">笔记</span></button><div className="note-attachment-caption">{embed.note.title}</div></div>)}{filtered.map((row,index)=><div className="note-attachment-card" key={JSON.stringify([row.target,row.wiki,index])}>
   <button type="button" className="note-attachment-thumb" disabled={interactionLocked||!row.token} onClick={()=>row.token&&void run({kind:'open-attachment',token:row.token})}>
    {row.status==='resolved'&&row.token&&row.mediaKind==='image'?<img src={runtime.attachments.mediaUrl(row.token)} alt="" loading="lazy" decoding="async"/>:<span className="note-attachment-file">{row.mediaKind==='audio'?'音频':row.mediaKind==='video'?'视频':'附件'}</span>}
   </button><div className="note-attachment-caption"><span title={row.target}>{row.label}</span></div>{status[row.status]&&<p>{status[row.status]}</p>}
  </div>)}</div>{!busy&&!filtered.length&&!filteredNotes.length&&<p>当前笔记没有匹配的附件引用。</p>}
 </aside>;
}

export function ScopedNoteTagsPanel(props:ScopedNotePanelProps){
 const {controller,viewId,close,interactionLocked=false}=props,state=useSyncExternalStore(controller.session.subscribe,controller.session.getSnapshot);
 const [metadata,setMetadata]=useState<NoteMetadata|null>(null),[selected,setSelected]=useState<string[]>([]),[name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[baseline,setBaseline]=useState<NoteTagSelectionBaseline|null>(null),[reload,setReload]=useState(0);
 useEffect(()=>{let live=true;const before=controller.session.getSnapshot();setBaseline(null);setError('');
  void controller.metadata(viewId).then(value=>{if(!live)return;const current=controller.session.getSnapshot();if(current.revision!==before.revision||current.content!==before.content||current.dirty)throw Error('读取标签期间笔记已变化，请重新载入并核对。');setMetadata(value);setSelected(value.tags.filter(tag=>value.documentTags.includes(tag.id)).map(tag=>tag.name));setBaseline({revision:before.revision,content:before.content,authority:controller.authority,viewId});
  }).catch(cause=>{if(live)setError(fail(cause));});return()=>{live=false;};},[controller,viewId,reload]);
 const stale=!!baseline&&(state.revision!==baseline.revision||state.content!==baseline.content||state.dirty);
 const apply=async()=>{if(!baseline)return;setBusy(true);setError('');try{await submitNoteTagSelection(controller.session.getSnapshot,baseline,selected,action=>panelRequest(props,action),{authority:controller.authority,viewId});close();}catch(cause){setError(fail(cause));}finally{setBusy(false);}};
 return <aside role="dialog" aria-label="编辑当前笔记标签" className="tag-dialog-react"><header><strong>笔记标签</strong><button type="button" onClick={close}>关闭</button></header>{error&&<p role="alert">{error}</p>}
  {[...new Set([...(metadata?.tags.map(tag=>tag.name)||[]),...selected])].map(tag=><label key={tag}><input type="checkbox" checked={selected.includes(tag)} disabled={interactionLocked||busy} onChange={()=>setSelected(previous=>previous.includes(tag)?previous.filter(item=>item!==tag):[...previous,tag])}/>{tag}</label>)}
  {stale&&<p role="alert">笔记已变化，当前选择尚未提交。请重新载入标签并核对。</p>}<button type="button" disabled={busy||interactionLocked} onClick={()=>setReload(value=>value+1)}>重新载入标签并核对</button>
  <input aria-label="新标签名称" value={name} maxLength={120} onChange={event=>setName(event.target.value)}/><button type="button" disabled={!name.trim()||busy||interactionLocked} onClick={()=>{setSelected(previous=>[...new Set([...previous,name.trim()])]);setName('');}}>添加标签</button><button type="button" disabled={busy||interactionLocked||!metadata||!baseline||stale} onClick={()=>void apply()}>保存当前笔记标签</button>
 </aside>;
}
