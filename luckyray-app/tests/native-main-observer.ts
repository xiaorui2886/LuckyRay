/** Explicit test import only. Observes the actual Main entry, never mounts a
 * fixture, edits an editor, flushes a draft, or manufactures readiness. */
import {EditorView} from '@codemirror/view';
import {getIdentifier} from '@tauri-apps/api/app';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {notesNativeViews} from '../src/features/notes/notesNativeViewRegistry';
import {knowledgeDocumentNoteId} from '../src/core/services/knowledge';
import {workspaceCommand} from '../src/workspace/nativeClient';

export const sha256=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const rect=(e:Element)=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
export async function observe(expected:{vaultId:string;relativePath:string;rootPath:string},readSaved=false){
 if(await getIdentifier()!=='com.luckyray.desktop.dev'||document.querySelector('.host-fixture-shell'))throw Error('Actual Main development identity required');
 if(!expected.rootPath.replaceAll('\\','/').includes('/native-main-integration-20261009/synthetic-vault'))throw Error('Only owned synthetic vault allowed');
 const label=getCurrentWindow().label;
 if(label!=='main'&&!location.pathname.endsWith('/workspace-child.html'))throw Error('Unexpected native entry');
 const statuses=Array.from(document.querySelectorAll('[role="alert"],.workspace-conflict,.editor-status-center')).filter(e=>e.getBoundingClientRect().height>0).map(e=>e.textContent||'');
 const bindings=label==='main'?notesNativeViews.list():[];
 const session:any=label==='main'?null:await workspaceCommand({op:'bootstrap'});
 if(session&&(session.label!==label||!session.incarnation||!Array.isArray(session.views)))throw Error('Missing child window identity');
 const views:any[]=[];
 for(const root of document.querySelectorAll<HTMLElement>(label==='main'?'[data-notes-view-id]':'[data-workspace-view]')){
  const viewId=label==='main'?root.dataset.notesViewId:root.dataset.workspaceView;
  const binding=bindings.filter(b=>b.viewId===viewId);
  const native=session?.views.filter((v:any)=>v.view.id===viewId);
  // Do not export, sample text, or read disk for unrelated user documents.
  if(label==='main'&&!(binding.length===1&&binding[0].vaultId===expected.vaultId&&binding[0].relativePath===expected.relativePath))continue;
  if(label!=='main'&&!(native?.length===1&&native[0].view.libraryId===expected.vaultId&&native[0].view.resourceId===expected.relativePath))throw Error('Child is not the owned synthetic document');
  const nodes=root.querySelectorAll<HTMLElement>('.cm-editor');if(!nodes.length)continue;
  const pane=root.querySelector<HTMLElement>('[data-notes-dock-pane]')?.dataset.notesDockPane;
  if(!viewId||nodes.length!==1||!pane)throw Error('Exact view/pane/editor mapping missing');
  const editor=EditorView.findFromDOM(nodes[0]);if(editor?.dom!==nodes[0])throw Error('Public EditorView state unavailable');
  const b=binding[0];
  if(label==='main'&&(root.dataset.notesViewPane!==pane||b.vault.rootPath.replaceAll('\\','/').replace(/^\/\/\?\//,'').toLowerCase()!==expected.rootPath.replaceAll('\\','/').replace(/^\/\/\?\//,'').toLowerCase()||b.vault.id!==expected.vaultId||b.resourceId!==expected.relativePath||b.documentId!==knowledgeDocumentNoteId(expected)||root.dataset.notesViewDocument!==`real-vault:${expected.relativePath}`||!b.workspaceSourceId||!Number.isInteger(b.generation)))throw Error('Exact Main authority mismatch');
  if(label!=='main'&&(pane!==viewId||root.querySelector<HTMLElement>('[data-scoped-note-surface]')?.dataset.scopedNoteSurface!==viewId||native[0].open!==true||typeof native[0].dirty!=='boolean'))throw Error('Exact child authority mismatch');
  const text=editor.state.doc.toString();
  const saved:any=readSaved?await workspaceCommand({op:label==='main'?'readBound':'readNote',viewId}):null;
  if(saved&&(typeof saved.content!=='string'||!saved.revision||saved.documentRef?.vaultId!==expected.vaultId||saved.documentRef.relativePath!==expected.relativePath))throw Error('Saved observation identity missing');
  if(saved&&label!=='main'&&(!saved.authority?.sourceId||saved.authority.documentId!==knowledgeDocumentNoteId(expected)))throw Error('Child saved authority missing');
  views.push({viewId,paneId:pane,tabDocumentId:root.dataset.notesViewDocument??null,binding:b??null,native:native?.[0]??null,text,sha256:await sha256(text),saved,
   textUnchangedDuringRead:editor.state.doc.toString()===text,selection:editor.state.selection.toJSON(),scroll:{top:editor.scrollDOM.scrollTop,left:editor.scrollDOM.scrollLeft},focused:editor.hasFocus,composing:editor.composing,
   dirty:label==='main'?notesNativeViews.get(viewId).isDirty():native[0].dirty,rect:rect(root),editorRect:rect(editor.dom)});
 }
 return {label,statuses,session,views,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},layout:Object.fromEntries(['.titlebar','.note-backlinks.open','.notes-titlebar-pane-group','[data-notes-dock-tabs]','.notes-split-workspace','.note-title-strip','.note-tags-bar'].map(s=>[s,Array.from(document.querySelectorAll(s)).filter(e=>e.getBoundingClientRect().width>0).map(rect)])),sampledAt:new Date().toISOString()};
}

/** Records real IPC acknowledgements without altering requests or responses.
 * Native normal-quit log + retained process exit code are separate witnesses. */
export function watchQuit(report:(event:unknown)=>void){
 const internals=(window as any).__TAURI_INTERNALS__,original=internals.invoke;
 internals.invoke=async function(command:string,args:any,...rest:any[]){
  const request=command==='workspace_window_command'&&args?.request?.op==='quitAck'?args.request:null;
  if(request)report({kind:'quitAck-sent',id:request.id,saved:request.saved,label:getCurrentWindow().label,time:Date.now()});
  const result=await original.call(this,command,args,...rest);
  if(request)report({kind:'quitAck-accepted',id:request.id,saved:request.saved,label:getCurrentWindow().label,time:Date.now()});
  return result;
 };
 return ()=>{internals.invoke=original;};
}
