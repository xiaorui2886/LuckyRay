import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {convertFileSrc} from '@tauri-apps/api/core';
import {attachmentPreviewError,childAttachmentMedia,type ChildAttachmentResolution} from './attachmentMedia';
import {LiveMarkdownEditor,type LiveMarkdownEditorHandle,type LiveEditorTableContext} from '../features/notes/editor/LiveMarkdownEditor';
import type {LiveAsset,LiveNoteEmbed} from '../features/notes/editor/types';
import {standardMarkdownReferences} from '../core/markdown/realVaultEmbeds';
import {DocumentSession} from './documentSession';
import {workspaceCommand} from './nativeClient';
import type {ViewRef} from './layout';
import '../features/notes/notes.css';
import {useWorkspaceTools,type ToolAdapter} from './toolRegistry';
import {workspaceOutline} from './noteOutline';
import {BacklinksTool} from './BacklinksTool';
import {createPortal} from 'react-dom';
import {EditorContextMenu,type TableEditorCommand} from '../features/notes/editor/EditorContextMenu';
import {applyWorkspaceTableCommand} from './noteTableCommands';
import {applyWorkspaceNoteCommand} from './noteCommands';
import type {EditorCommand} from '../core/services/editor';

type Resolution={status:string;absolutePath:string|null;relativePath:string|null;version:string|null};
export function WorkspaceNoteView({view,session,child=false,onFocus,onRevisionReady,visible=true}:{view:ViewRef;session:DocumentSession;child?:boolean;onFocus?:()=>void;onRevisionReady?:(revision:string)=>void;visible?:boolean}){
 const state=useSyncExternalStore(session.subscribe,session.getSnapshot);
 const editor=useRef<LiveMarkdownEditorHandle>(null);
 const [media,setMedia]=useState<{assets:LiveAsset[];embeds:LiveNoteEmbed[]}>({assets:[],embeds:[]});
 const [compare,setCompare]=useState(false);
 const [attachmentError,setAttachmentError]=useState('');
 const [menu,setMenu]=useState<{x:number;y:number;selection:{start:number;end:number};table?:LiveEditorTableContext|null;content:string}|null>(null);
 const [commandError,setCommandError]=useState('');
 const runCommand=async(command:EditorCommand)=>{
  const selection=menu?.selection??editor.current?.getSelection();setMenu(null);setCommandError('');
  if(!editor.current||!selection)return;
  if(command==='insert-asset'){setCommandError('素材插入目标正在接入当前笔记，请暂从原知识库入口插入。');return;}
  try{await applyWorkspaceNoteCommand(editor.current,session,command,selection,navigator.clipboard);}catch(error){setCommandError(String(error));}
 };
 const runTableCommand=async(command:TableEditorCommand)=>{
  const current=menu;setMenu(null);setCommandError('');
  if(!editor.current||!current?.table)return;
  try{await applyWorkspaceTableCommand(editor.current,session,current.table,command,current.content,navigator.clipboard);}catch(error){setCommandError(String(error));}
 };
 const outline=useMemo(()=>workspaceOutline(state.content),[state.content]);
 const toolAdapter=useMemo<ToolAdapter>(()=>({title:view.title,kinds:['outline','backlinks'],render:kind=>kind==='outline'?<nav aria-label="笔记标题大纲" className="workspace-outline">{outline.length?outline.map(heading=><button key={heading.from} style={{paddingLeft:12+(heading.level-1)*12}} onClick={()=>{onFocus?.();editor.current?.setSelection({start:heading.from,end:heading.from});}}>{heading.text||'无标题'}</button>):<p>当前笔记没有标题。</p>}</nav>:<BacklinksTool viewId={view.id} child={child} revision={state.revision}/>}),[view.id,view.title,outline,child,state.revision,onFocus]);
 useWorkspaceTools(view.id,toolAdapter);
 useEffect(()=>{void session.load();},[session]);
 useEffect(()=>{
  if(!visible||!onRevisionReady||!state.revision||state.dirty||state.status!=='ready')return;
  const frame=requestAnimationFrame(()=>{if(editor.current?.getValue()===state.content)onRevisionReady(state.revision);});
  return()=>cancelAnimationFrame(frame);
 },[onRevisionReady,state.revision,state.content,state.dirty,state.status,visible]);
 useEffect(()=>{if(!state.dirty||state.status==='conflict'||state.status==='error')return;const timer=setTimeout(()=>{void session.flush();},500);return()=>clearTimeout(timer);},[session,state.content,state.dirty,state.status]);
 const targets=useMemo(()=>{
  const refs=standardMarkdownReferences(state.content).filter(ref=>ref.local&&ref.embedded).map(ref=>({target:ref.target,wiki:false}));
  for(const match of state.content.matchAll(/!\[\[([^\]\n]+)\]\]/g))refs.push({target:match[1].split('|')[0],wiki:true});
  return JSON.stringify([...new Map(refs.map(ref=>[`${ref.wiki}:${ref.target}`,ref])).values()]);
 },[state.content]);
 useEffect(()=>{
  let live=true;
  const refresh=async()=>{
   const failures:string[]=[];
   const values=await Promise.all((JSON.parse(targets) as {target:string;wiki:boolean}[]).map(async ref=>{
    try{
     const id=`workspace-attachment:${ref.target}`;
     if(child){
      const resolved=await workspaceCommand<ChildAttachmentResolution>({op:'resolveAttachment',viewId:view.id,revision:state.revision,destination:ref.target,wiki:ref.wiki});
      const {source,kind}=childAttachmentMedia(resolved,convertFileSrc);
      return {asset:{id,name:ref.target,kind,previewUrl:source,thumbnailUrl:source},embed:{targetName:ref.target,assetId:id,isMissing:0}};
     }
     const resolved=await workspaceCommand<Resolution>({op:'resolveAttachment',viewId:view.id,destination:ref.target,wiki:ref.wiki});
     if(!resolved.absolutePath)return null;
     const source=convertFileSrc(resolved.absolutePath)+(resolved.version?`?v=${encodeURIComponent(resolved.version)}`:'');
     const kind=/\.(mp4|mkv|webm|mov)$/i.test(resolved.absolutePath)?'video':/\.(mp3|wav|ogg)$/i.test(resolved.absolutePath)?'audio':'image';
     return {asset:{id,name:ref.target,kind,previewUrl:source,thumbnailUrl:source,originalPath:resolved.absolutePath,libraryPath:resolved.relativePath},embed:{targetName:ref.target,assetId:id,isMissing:0}};
    }catch(error){if(child)failures.push(attachmentPreviewError(error));return null;}
   }));
   if(live){const found=values.filter(value=>value!==null);setMedia({assets:found.map(value=>value.asset),embeds:found.map(value=>value.embed)});setAttachmentError([...new Set(failures)].join(' '));}
  };
  void refresh();
  // Refresh only the same baseline-authorized references. Media tokens expire
  // independently of document lifetime and never become unrestricted file URLs.
  const timer=child?setInterval(()=>void refresh(),5*60*1000):null;
  return()=>{live=false;if(timer!==null)clearInterval(timer);};
 },[targets,view.id,child,state.revision]);
 if(state.status==='loading')return <div className="workspace-empty">正在读取笔记…</div>;
 if(!state.revision)return <div role="alert" className="workspace-missing">笔记暂不可用。库可能尚未打开或文件已移动。<p>{state.error}</p><button onClick={()=>void session.load()}>重试</button></div>;
 return <div className="workspace-note" onFocusCapture={onFocus} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void session.flush();}}}>
  <div className="workspace-note-status"><span>{view.title}</span><span aria-live="polite">{state.status==='saving'?'正在保存…':state.status==='conflict'?'存在版本冲突':state.dirty?'尚未保存':'已保存'}</span></div>
  {attachmentError&&<div className="workspace-conflict" role="status">{attachmentError}</div>}
  {commandError&&<div className="workspace-conflict" role="alert">{commandError}<button onClick={()=>setCommandError('')}>关闭提示</button></div>}
  {(state.status==='error'||state.status==='conflict')&&<div className="workspace-conflict" role="alert"><span>{state.error} 输入仍保留。</span>
   {state.remote?<><button onClick={()=>setCompare(value=>!value)}>比较远端版本</button><button onClick={()=>{if(window.confirm('保留当前输入并替换已显示的远端版本？')){session.resolveConflict('keep-local');void session.flush();}}}>保留我的版本</button><button onClick={()=>{if(window.confirm('放弃当前未保存输入，使用远端版本？'))session.resolveConflict('remote');}}>使用远端版本</button></>:<button onClick={()=>void session.flush()}>重试保存</button>}
   {compare&&state.remote&&<pre>{state.remote.content}</pre>}
  </div>}
  <div className="workspace-trial-notice" role="note">支持正文、格式与表格编辑；重命名、插入附件和 AI 写作请使用原知识库入口。</div>
  <div className="note-live-editor-host workspace-note-editor"><LiveMarkdownEditor ref={editor} value={state.content} onChange={value=>session.edit(value)} currentNoteId={view.id} assets={media.assets} noteEmbeds={media.embeds} notes={[{id:view.id,title:view.title}]} noteLinks={[]} tags={[]}
   onContextMenu={(event,selection,_token,table)=>{event.preventDefault();setMenu({x:event.clientX,y:event.clientY,selection,table,content:editor.current?.getValue()??state.content});}}
   onCommand={command=>{if(['bold','italic','link','external-link'].includes(command))void runCommand(command as EditorCommand);}}
  /></div>
  {menu&&createPortal(<div className="workspace-note-menu-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget)setMenu(null);}} onKeyDown={event=>{if(event.key==='Escape'){setMenu(null);editor.current?.focus();}}}>
   <EditorContextMenu x={menu.x} y={menu.y} table={menu.table} aiBusy assetInsertionEnabled={false} onCommand={command=>void runCommand(command)} onTableCommand={command=>void runTableCommand(command)} onAiWrite={()=>{}} onOpenToken={()=>{}} onOpenNoteInNewTab={()=>{}} onOpenAssetDetail={()=>{}} onCopyToken={()=>{}} onCopyTokenLabel={()=>{}} onCopyTokenTarget={()=>{}} onEditNoteAlias={()=>{}} onRenameTag={()=>{}} onRemoveToken={()=>{}}/>
  </div>,document.body)}
 </div>;
}
