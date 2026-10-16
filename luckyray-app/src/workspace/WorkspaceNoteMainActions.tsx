// @refresh reset
// This native queue consumer owns timers and a broker registration. During a
// development hot update, retire that service instance instead of retaining
// closures from its old module; the document/editor subtree is not remounted.
import {useEffect,useRef,useState} from 'react';
import {listen} from '@tauri-apps/api/event';
import {useApplicationModalSurface} from '../app/applicationModalIsolation';
import {getLuckyRayBridge} from '../core/bridge/luckyRayBridge';
import {materialLibrarySession} from '../core/services/materialLibraryContext';
import type {MaterialAsset} from '../core/services/materialCatalog';
import {notesNativeViews} from '../features/notes/notesNativeViewRegistry';
import {focusEntity} from '../core/services/context';
import {knowledgeTagIdentity} from '../core/services/knowledge';
import {readActiveKnowledgeSource} from '../core/services/knowledgeSource';
import {openInLightSeek,waitForOpenInLightSeekIntent} from '../core/services/openInLightSeek';
import {workspaceCommand} from './nativeClient';
import {registerWorkspaceFlush} from './windowLifecycle';
import {serializeNativeNoteAction} from './nativeNoteActions';
import {generateScopedNoteSuggestion,generateScopedNoteWrite,NOTE_MAIN_HANDLER_KINDS,validateNoteMainClaim,type NoteMainClaim,type NoteMainCompletion,type NoteMainAction} from './nativeNoteMainProtocol';
import './WorkspaceNoteMainActions.css';

type Review={claim:NoteMainClaim;title:string;body?:string;original?:string;assets?:MaterialAsset[];libraryId?:string;selected?:string[];finish:(value:unknown)=>void};
/** Mounted once in Main. Child effects reach it only through authenticated
 * native claims. Registering is a renewable handler lease, never a ready flag. */
export function WorkspaceNoteMainActions(){
 const [review,setReview]=useState<Review|null>(null),[error,setError]=useState(''),[working,setWorking]=useState(false),[query,setQuery]=useState('');
 const held=useRef<Review|null>(null);held.current=review;
 const modal=useApplicationModalSurface<HTMLElement>(!!review,()=>held.current?.finish(null));
 useEffect(()=>{
  let active=true,running=false,stop:(()=>void)|undefined,pendingReview:((value:unknown)=>void)|null=null;
  const releaseFlush=registerWorkspaceFlush(async()=>!running&&!pendingReview);
  const alive=()=>{if(!active)throw Error('workspace-note-main-unmounted');};
  const validate=async(claim:NoteMainClaim)=>{alive();await workspaceCommand({op:'noteMainValidate',id:claim.id,claimToken:claim.claimToken});alive();};
  const complete=(claim:NoteMainClaim,result:NoteMainCompletion)=>workspaceCommand({op:'noteMainComplete',id:claim.id,claimToken:claim.claimToken,result});
  const execute=(claim:NoteMainClaim,input:unknown)=>workspaceCommand({op:'noteMainExecute',id:claim.id,claimToken:claim.claimToken,input});
  const ask=(claim:NoteMainClaim,value:Omit<Review,'claim'|'finish'>)=>new Promise<unknown>(resolve=>{
   const finish=(answer:unknown)=>{pendingReview=null;if(active){setReview(null);setQuery('');}resolve(answer);};pendingReview=finish;setReview({...value,claim,finish});
  });
  const provider=async(messages:Parameters<Awaited<ReturnType<typeof getLuckyRayBridge>>['aiChatComplete']>[0],options:Parameters<Awaited<ReturnType<typeof getLuckyRayBridge>>['aiChatComplete']>[1])=>(await getLuckyRayBridge()).aiChatComplete(messages,options);
  const process=async(id:string)=>{
   let claim:NoteMainClaim|undefined,finished=false;
   try{
    claim=await workspaceCommand<NoteMainClaim>({op:'noteMainClaim',id});validateNoteMainClaim(claim);await validate(claim);
    // Discovery/lease renewal is background work, not a user action. Publish
    // progress only after the broker grants and validates an actual request.
    setWorking(true);
    const action=claim.action;
    if(action.kind==='composeAi'){
     if(!action.text||new TextEncoder().encode(action.text).length>12*1024)throw Error('workspace-note-ai-context-invalid');
     const intent=openInLightSeek({source:'notes',text:action.text});await waitForOpenInLightSeekIntent(intent.intentId);await validate(claim);
     await complete(claim,{kind:'acknowledged',message:'笔记内容已放入主窗口 AI 输入框，尚未发送。'});finished=true;
    }else if(action.kind==='openTag'){
     const source=readActiveKnowledgeSource();if(!source||source.vaultId!==action.vaultId)throw Error('主窗口知识库与标签来源不同。');await validate(claim);
     if(readActiveKnowledgeSource()!==source)throw Error('主窗口知识库已切换。');
     focusEntity('tag',knowledgeTagIdentity(action.vaultId,action.name),{source:'workspace-note-action'});window.location.hash='#tags';
     await complete(claim,{kind:'acknowledged',message:'已在主窗口打开标签。'});finished=true;
    }else if(action.kind==='suggestAi'){
     const suggestion=await generateScopedNoteSuggestion(action,provider);await validate(claim);await complete(claim,suggestion);finished=true;
    }else if(action.kind==='writeAi'){
     const replacement=await generateScopedNoteWrite(action,provider);await validate(claim);
     const answer=await ask(claim,{title:'检查 AI 写作预览',original:action.content.slice(replacement.selection.start,replacement.selection.end),body:replacement.text});await validate(claim);
     await complete(claim,answer===true?replacement:{kind:'cancelled'});finished=true;
    }else if(action.kind==='pickAttachment'||action.kind==='importDocument'){
     const answer=await ask(claim,{title:action.kind==='importDocument'?'选择要导入的 Markdown 文件':'选择要插入此笔记的附件'});await validate(claim);
     if(!Array.isArray(answer)||!answer.length){await complete(claim,{kind:'cancelled'});finished=true;return;}
     const actionPayload=await serializeNativeNoteAction({kind:'insert-files',files:answer as File[],selection:action.kind==='pickAttachment'?action.selection:{start:0,end:0}});await validate(claim);
     if(actionPayload.kind!=='insert-files')throw Error('workspace-note-file-payload-invalid');
     await execute(claim,{kind:action.kind==='importDocument'?'documents':'files',files:actionPayload.files});finished=true;
    }else if(action.kind==='pickCatalog'){
     const context=materialLibrarySession.capture();if(!context.libraryId)throw Error('请先在主窗口打开素材库。');
     const assets=await materialLibrarySession.request<MaterialAsset[]>({op:'list'},context.libraryId);await validate(claim);
     if(!materialLibrarySession.isCurrent(context))throw Error('素材库已切换，请重新选择。');
     const selected=await ask(claim,{title:'选择要插入此笔记的素材',assets,libraryId:context.libraryId});await validate(claim);
     if(typeof selected!=='string'){await complete(claim,{kind:'cancelled'});finished=true;return;}
     if(!materialLibrarySession.isCurrent(context)||!assets.some(asset=>asset.id===selected))throw Error('素材选择已失效。');
     await execute(claim,{kind:'catalog',libraryId:context.libraryId,assetId:selected});finished=true;
    }else if(action.kind==='renameTag'){
     const selected=await ask(claim,{title:`将标签「${action.review.oldName}」改为「${action.review.name}」`,selected:action.review.notes.map(note=>note.documentId)});await validate(claim);
     if(!Array.isArray(selected)||!selected.length){await complete(claim,{kind:'cancelled'});finished=true;return;}
     await execute(claim,{kind:'tagRename',reviewId:action.review.id,documentIds:selected});finished=true;
    }else if(action.kind==='exportDocument'){
     if(action.format!=='markdown')throw Error('当前生产笔记服务只支持 Markdown 导出。');
     const answer=await ask(claim,{title:'导出当前笔记为 Markdown',body:action.content});await validate(claim);
     if(answer!==true){await complete(claim,{kind:'cancelled'});finished=true;return;}
     await execute(claim,{kind:'export',format:action.format});finished=true;
    }else if(action.kind==='manageKnowledge'){
     // Native validation additionally compares Main's current incarnation for
     // this action. The UI receiver pins its own source/session before opening.
     window.location.hash='#notes';
     const readReceiver=()=>{try{return notesNativeViews.management();}catch{return null;}};
     let receiver=readReceiver();const started=performance.now();
     while(!receiver&&performance.now()-started<5000){await new Promise(resolve=>setTimeout(resolve,50));alive();receiver=readReceiver();}
     if(!receiver)throw Error('主窗口笔记管理尚未就绪。');
     const binding=receiver.binding();if(binding.vaultId!==action.vaultId)throw Error('主窗口知识库与请求来源不同，请先明确选择对应知识库。');
     await validate(claim);await receiver.open(action.section);await validate(claim);
     const current=notesNativeViews.management().binding();if(current.vaultId!==binding.vaultId||current.generation!==binding.generation||receiver.binding().generation!==binding.generation)throw Error('主窗口知识库会话已变化。');
     await complete(claim,{kind:'acknowledged',message:'已在主窗口打开此知识库的管理界面。'});finished=true;
    }else throw Error('workspace-note-main-unsupported');
   }catch(cause){
    if(active)setError(cause instanceof Error?cause.message:String(cause));
    if(claim&&!finished)await complete(claim,{kind:'failed',code:'workspace-note-main-failed'}).catch(()=>{});
   }
  };
  const drain=async()=>{if(running||!active)return;running=true;try{const pending=await workspaceCommand<Array<{id:string}>>({op:'noteMainPending'});if(pending.length>64)throw Error('workspace-note-action-capacity');for(const offer of pending){if(!active)break;await process(offer.id);}}catch(cause){if(active)setError(String(cause));}finally{running=false;if(active)setWorking(false);}};
  const register=()=>workspaceCommand({op:'noteMainRegister',kinds:[...NOTE_MAIN_HANDLER_KINDS]}).then(()=>drain()).catch(cause=>{if(active)setError(String(cause));});
  void register();void listen('luckyray:workspace-note-action-available',()=>void drain()).then(unlisten=>{if(active)stop=unlisten;else unlisten();}).catch(cause=>{if(active)setError(String(cause));});
  const heartbeat=setInterval(()=>void register(),5000),poll=setInterval(()=>void drain(),1500);
  const expiry=setInterval(()=>{const current=held.current;if(current)void validate(current.claim).catch(cause=>{current.finish(null);if(active)setError(String(cause));});},3000);
  return()=>{active=false;releaseFlush();stop?.();clearInterval(heartbeat);clearInterval(poll);clearInterval(expiry);pendingReview?.(null);void workspaceCommand({op:'noteMainRegister',kinds:[]}).catch(()=>{});};
 },[]);
 const action:NoteMainAction|undefined=review?.claim.action;
 return <>{error&&<div role="alert" className="workspace-conflict">{error}<button type="button" onClick={()=>setError('')}>关闭提示</button></div>}
  {working&&!review&&<div role="status" className="workspace-note-main-status">正在处理工作区笔记请求…</div>}
  {review&&<div className="modal-overlay-react" onPointerDown={modal.onBackdropPointerDown}><section ref={modal.surfaceRef} role="dialog" aria-modal="true" aria-label={review.title} tabIndex={-1} onKeyDown={modal.onSurfaceKeyDown} className="modal-box-react"><div className="modal-header-react"><strong>{review.title}</strong><button type="button" onClick={()=>review.finish(null)}>取消</button></div>
   {review.claim.source&&<p>目标知识库：{review.claim.source.vaultId} · 笔记：{review.claim.source.title||review.claim.source.viewId}</p>}
   {(action?.kind==='pickAttachment'||action?.kind==='importDocument')&&<><p>只会把本次选择的文件插入或导入发起请求的知识库。{action.kind==='importDocument'?'请选择 .md 文件；同名文件会另存。':''}</p><input type="file" multiple accept={action.kind==='importDocument'?'.md':undefined} aria-label="选择文件" onChange={event=>{const files=Array.from(event.currentTarget.files||[]);if(files.length)review.finish(files);}}/></>}
   {action?.kind==='pickCatalog'&&<><input value={query} aria-label="筛选素材" placeholder="搜索素材…" onChange={event=>setQuery(event.target.value)}/><ul>{review.assets?.filter(asset=>asset.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,200).map(asset=><li key={asset.id}><button type="button" onClick={()=>review.finish(asset.id)}>{asset.name}</button></li>)}</ul><p>选择后只复制选中素材到发起请求的知识库。</p></>}
   {action?.kind==='renameTag'&&<><p>仅更新勾选笔记的文档属性标签。行内标签不会被更改。{action.review.inlineOnlyCount>0?`另有 ${action.review.inlineOnlyCount} 篇仅含行内引用。`:''}</p>{action.review.notes.map(note=><label key={note.documentId}><input type="checkbox" checked={review.selected?.includes(note.documentId)||false} onChange={()=>setReview(current=>current?{...current,selected:current.selected?.includes(note.documentId)?current.selected.filter(id=>id!==note.documentId):[...(current.selected||[]),note.documentId]}:null)}/>{note.title}</label>)}<button type="button" disabled={!review.selected?.length} onClick={()=>review.finish(review.selected)}>确认更新所选笔记</button></>}
   {review.original!==undefined&&<><h3>原文</h3><pre style={{whiteSpace:'pre-wrap',maxHeight:'25vh',overflow:'auto'}}>{review.original}</pre></>}
   {review.body!==undefined&&<><h3>{action?.kind==='writeAi'?'生成结果':'当前笔记'}</h3><pre style={{whiteSpace:'pre-wrap',maxHeight:'40vh',overflow:'auto'}}>{review.body}</pre><button type="button" onClick={()=>review.finish(true)}>{action?.kind==='writeAi'?'应用到原笔记选区':'选择导出位置'}</button></>}
  </section></div>}
 </>;
}
