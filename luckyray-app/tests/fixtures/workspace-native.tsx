import {createRoot} from 'react-dom/client';
import {invoke,convertFileSrc} from '@tauri-apps/api/core';
import {label,report,stage,fail} from './workspace-native-bootstrap';
import {listen,emitTo} from '@tauri-apps/api/event';
import {WorkspaceWindowContent} from '../../src/workspace/WorkspaceWindow';
import {DocumentSession,DocumentSessions} from '../../src/workspace/documentSession';
import {LayoutStore} from '../../src/workspace/layoutStore';
import {WorkspaceHost} from '../../src/workspace/WorkspaceHost';
import {WorkspaceNoteView} from '../../src/workspace/NoteView';
import {noteTransport} from '../../src/workspace/nativeClient';
import {receiveNoteMerge} from '../../src/workspace/mergeReceiver';
import {installWorkspaceLifecycle,registerWorkspaceFlush} from '../../src/workspace/windowLifecycle';
import {WORKSPACE_DRAG_TYPE} from '../../src/workspace/windowDrag';
import {I18nProvider} from '../../src/core/i18n/index';
import '../../src/core/theme/themeTokens.css';
import '../../src/features/notes/notes.css';

const root=createRoot(document.getElementById('root')!);
const command=(request:unknown)=>invoke<any>('workspace_window_command',{request});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>Promise<boolean>,name:string){for(let i=0;i<160;i++){if(await check())return;await sleep(150);}throw Error(`${name} timeout`);}
async function run(){
 await stage('renderer-module-loaded');
 if(label==='main'){
   await stage('main-lifecycle');
   await installWorkspaceLifecycle();
   if(await invoke<number>('workspace_fixture_legacy_probe')!==1)throw Error('Main legacy command dispatch changed');
   let quitAllowed=false;registerWorkspaceFlush(async()=>quitAllowed);
   root.render(<h2>真实 Tauri 双窗口 / 合成笔记 / 不访问用户资料</h2>);
   const base={kind:'note',libraryId:'workspace-test-vault',resourceId:'shared.md',title:'双窗口修订测试'};
   await command({op:'bind',view:{...base,id:'main-bound'}});
   let identityDenied=false;try{await command({op:'bind',view:{...base,id:'main-bound',resourceId:'other.md'}});}catch{identityDenied=true;}
   if(!identityDenied)throw Error('binding retargeted');
   await stage('children-opening');
   const a=await command({op:'open',view:{...base,id:'writer'}});
   const b=await command({op:'open',view:{...base,id:'observer'}});
   await stage('children-readiness');
   for(let i=0;i<120;i++){const windows=await command({op:'list'});if(windows.length===2&&windows.every((w:any)=>w.ready))break;if(i===119)throw Error('children readiness timeout');await sleep(250);}
   await stage('children-listeners');
   await until(async()=>{const state=await report(null);return [a.label,b.label].every(label=>state.reports.some((r:any)=>r.window===label&&r.report?.listenersReady));},'child fixture listeners');
   const initialBoots=new Map<string,string>((await report(null)).reports.filter((r:any)=>r.report?.listenersReady).map((r:any)=>[r.window,r.report.bootId]));
   await stage('attachment-probes');
   await until(async()=>(await report(null)).reports.filter((r:any)=>r.report?.opaqueAttachmentRead).length===2,'opaque attachment readers');
   const writerToken=(await report(null)).reports.find((r:any)=>r.window===a.label&&r.report?.opaqueAttachmentRead).report.attachmentToken;
   await emitTo(b.label,'fixture:cross-window-attachment',{token:writerToken});
   await until(async()=>(await report(null)).reports.some((r:any)=>r.report?.attachmentCrossWindowDenied),'cross-window token rejection');
   const mainAttachment=await command({op:'resolveAttachment',viewId:'main-bound',destination:'fixture-picture.png',wiki:true});
   if(!mainAttachment.absolutePath)throw Error('Main attachment resolution changed');
   await emitTo(a.label,'fixture:attachment-isolation',{rawAssetUrl:convertFileSrc(mainAttachment.absolutePath)});
   await until(async()=>(await report(null)).reports.some((r:any)=>r.report?.attachmentSelfExpansionDenied),'attachment child isolation');
   await stage('multi-tab');
   await command({op:'attach',label:a.label,view:{...base,id:'extra',resourceId:'second.md',title:'第二个标签'}});
   await until(async()=>{const window=(await command({op:'list'})).find((w:any)=>w.label===a.label);return window?.views.some((v:any)=>v.view.id==='extra'&&v.ready&&v.open);},'second native tab readiness');
   await emitTo(a.label,'fixture:multi-tab',{});
   await until(async()=>(await report(null)).reports.some((r:any)=>r.report?.multiTabRetainedUndo),'multi-tab close and undo');
   await stage('cross-window-drag');
   await emitTo(a.label,'fixture:start-drag',{});
   await until(async()=>(await report(null)).reports.some((r:any)=>r.report?.dragTicket),'drag ticket');
   const ticket=(await report(null)).reports.find((r:any)=>r.report?.dragTicket).report.dragTicket;
   await emitTo(b.label,'fixture:drop-drag',{ticket});
   await until(async()=>{const windows=await command({op:'list'});return !windows.find((w:any)=>w.label===a.label)?.views.find((v:any)=>v.view.id==='extra')?.open&&windows.find((w:any)=>w.label===b.label)?.views.some((v:any)=>v.view.id==='extra'&&v.open&&v.ready);},'cross-window drag handoff');
   await emitTo(b.label,'fixture:finish-drag',{ticket});
   await until(async()=>(await report(null)).reports.some((r:any)=>r.report?.crossWindowDragHandshake),'drag target verification');
   await stage('write-and-stale-rejection');
   await emitTo(a.label,'fixture:write',{});
   for(let i=0;i<100;i++){const state=await report(null);if(state.reports.some((r:any)=>r.report?.writerCommitted))break;if(i===99)throw Error('writer timeout');await sleep(150);}
   await emitTo(b.label,'fixture:stale-write',{});
   for(let i=0;i<100;i++){const state=await report(null);if(state.reports.some((r:any)=>r.report?.staleRejected)){
      await report({twoNativeWindowsReady:true,mainBindingIdentityDenied:true});
      let readyCloseDenied=false;try{await command({op:'close',label:a.label});}catch{readyCloseDenied=true;}
      if(!readyCloseDenied)throw Error('ready receiver closed by source');
      await stage('dirty-close-and-flush');
      await emitTo(a.label,'fixture:edit-before-close',{});
      await until(async()=>{const state=await report(null);return state.reports.some((r:any)=>r.report?.dirtyCloseDenied);},'dirty close rejection');
      await emitTo(a.label,'luckyray:workspace-close-requested',{});
      await until(async()=>!(await command({op:'list'})).some((w:any)=>w.label===a.label),'flush close');
      const saved=await command({op:'readBound',viewId:'main-bound'});
      if(!saved.content.includes('关闭前最后输入'))throw Error('close lost draft');
      const archive=await command({op:'recoverableWindows'});if(!archive.some((w:any)=>w.id===a.label&&w.closed))throw Error('closed window absent from recovery');
      if(JSON.stringify(archive).includes('rootPath'))throw Error('recovery leaked native scope');
      await stage('restore-window');
      await command({op:'restoreWindow',id:a.label});
      await until(async()=>(await command({op:'list'})).some((w:any)=>w.label===a.label&&w.ready),'restored window readiness');
      await until(async()=>(await report(null)).reports.some((r:any)=>r.window===a.label&&r.report?.listenersReady&&r.report.bootId!==initialBoots.get(a.label)),'restored fixture listeners');
      await emitTo(a.label,'fixture:verify-recovery',{});
      await until(async()=>(await report(null)).reports.some((r:any)=>r.report?.reopenedWindowKeepsLatestDocument),'reopened content');
      await emitTo(a.label,'luckyray:workspace-close-requested',{});
      await until(async()=>!(await command({op:'list'})).some((w:any)=>w.label===a.label),'reclosed restored window');
      await stage('quit-barrier');
      const refused=await invoke<boolean>('workspace_fixture_quit_probe');
      if(refused)throw Error('quit ignored unsaved window');
      await sleep(200);quitAllowed=true;
      const allowed=await invoke<boolean>('workspace_fixture_quit_probe');
      if(!allowed)throw Error('saved windows did not acknowledge quit');
      await sleep(200);
      if(document.getElementById('root')?.inert)throw Error('cancelled quit left Main frozen');
      await stage('merge-into-main');
      await emitTo(b.label,'fixture:merge',{});
      await until(async()=>(await command({op:'pendingMerges'})).length===1,'merge offer');
      const [offer]=await command({op:'pendingMerges'});
      let staleMergeDenied=false;try{await command({op:'acceptMerge',id:offer.id,revision:'stale-revision'});}catch{staleMergeDenied=true;}
      if(!staleMergeDenied)throw Error('merge acknowledged stale revision');
      const mergeStore=new LayoutStore('main');const documents=new DocumentSessions();
      root.render(<I18nProvider locale="zh-CN"><WorkspaceHost store={mergeStore} renderView={view=><WorkspaceNoteView view={view} session={documents.get({libraryId:view.library.id,resourceId:view.resourceId!},()=>noteTransport(view,false))}/>}/></I18nProvider>);
      await receiveNoteMerge(offer,mergeStore,documents);
      await until(async()=>!(await command({op:'list'})).some((w:any)=>w.label===b.label),'merge close after mounted receiver');
      const merged=await command({op:'readBound',viewId:offer.view.id});
      if(!merged.content.includes('关闭前最后输入'))throw Error('merged view lost latest revision');
      if(await invoke<number>('workspace_fixture_legacy_probe')!==2)throw Error('child reached guarded legacy command side effect');
      await stage('completion');
      const result=await report({complete:true,productionWindowComponent:true,guardedLegacyProbeNotExecuted:true,dirtyCloseGuard:true,closeFlushedDraft:true,staleWriteRejected:true,sourceCannotCloseReadyReceiver:true,allWindowQuitBarrier:true,cancelledQuitUnfreezes:true,mergeIntoMountedMain:true,mergeSourceClosedAfterAck:true,staleMergeDenied});root.render(<pre>{JSON.stringify(result,null,2)}</pre>);return;
   }if(i===99)throw Error('stale rejection timeout');await sleep(150);}
 }else{
   await stage('bootstrap');
   const session=await command({op:'bootstrap'});
   await stage('read-note');
   const initial=await command({op:'readNote'});
   await stage('legacy-command-denial');
   // The fixture wraps a real production read command and a harmless command
   // with an observable side effect in the exact production dispatch policy.
   // Check the specific boundary error, not just any rejection/unknown command.
   for(const name of ['workspace_fixture_report','workspace_fixture_legacy_probe','knowledge_read_document','get_local_transport_client_config','write_notes_vault_markdown_file','knowledge_activate_ui_source','material_catalog_list_assets','close_window']){
     let denied=false;
     try{await invoke(name,{documentRef:{vaultId:session.view.libraryId,relativePath:session.view.resourceId}});}catch(error){denied=String(error)==='workspace-command-not-allowed';}
     if(!denied)throw Error(`production command gate did not reject ${name}`);
   }
   await report({productionLegacyCommandsDenied:true});
   let staleReadyDenied=false;try{await command({op:'ready',revision:'not-rendered'});}catch{staleReadyDenied=true;}
   if(!staleReadyDenied)throw Error('stale readiness acknowledged');
   await stage('mount-editor');
   const model=new DocumentSession({read:()=>command({op:'readNote'}),write:(content,revision)=>command({op:'writeNote',revision,content})});
   root.render(<I18nProvider locale="zh-CN"><WorkspaceWindowContent initial={session} documentSession={model}/></I18nProvider>);
   await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
   await stage('opaque-attachment');
   const attachment=await command({op:'resolveAttachment',viewId:session.view.id,revision:initial.revision,destination:'fixture-picture.png',wiki:true});
   if(!/^[a-f0-9]{64}$/.test(attachment.token)||JSON.stringify(attachment).includes('absolutePath')||JSON.stringify(attachment).includes('rootPath'))throw Error('attachment capability leaked a path');
   const attachmentUrl=convertFileSrc(attachment.token,'workspace-attachment');
   const response=await fetch(attachmentUrl);if(!response.ok)throw Error('opaque attachment unreadable');
   const bytes=new Uint8Array(await response.arrayBuffer());if(bytes[0]!==137||bytes[1]!==80)throw Error('wrong synthetic attachment bytes');
   const range=await fetch(attachmentUrl,{headers:{Range:'bytes=0-3'}});
   if(range.status!==206||(await range.arrayBuffer()).byteLength!==4||range.headers.get('Content-Range')!==`bytes 0-3/${bytes.length}`)throw Error('attachment range mismatch');
   let forgedScopeDenied=true;
   for(const forged of [{viewId:'other-view'},{label:'main'},{revision:'stale'},{destination:'fixture-secret.png'},{destination:'../fixture-secret.png'}]){
    let denied=false;try{await command({op:'resolveAttachment',viewId:session.view.id,revision:initial.revision,destination:'fixture-picture.png',wiki:true,...forged});}catch{denied=true;}forgedScopeDenied&&=denied;
   }
   if(!forgedScopeDenied)throw Error('forged attachment scope accepted');
   const unreadable=async(url:string)=>{try{const response=await fetch(url);return !response.ok;}catch{return true;}};
   if(!await unreadable(convertFileSrc('0'.repeat(64),'workspace-attachment'))||!await unreadable(`${attachmentUrl}?label=main`))throw Error('forged attachment URI accepted');
   await stage('install-fixture-listeners');
   await listen<{token:string}>('fixture:cross-window-attachment',async event=>{try{
    if(!await unreadable(convertFileSrc(event.payload.token,'workspace-attachment')))throw Error('foreign window token was readable');
    await report({attachmentCrossWindowDenied:true});
   }catch(error){await report({error:String(error)});}},{target:{kind:'WebviewWindow',label}});
   await listen<{rawAssetUrl:string}>('fixture:attachment-isolation',async event=>{try{
    let blockedAsset=false;
    const violation=(event:SecurityPolicyViolationEvent)=>{if(event.blockedURI.startsWith('asset:')||/^https?:\/\/asset\.localhost/.test(event.blockedURI))blockedAsset=true;};
    document.addEventListener('securitypolicyviolation',violation);
    if(!await unreadable(event.payload.rawAssetUrl))throw Error('child read the unrestricted asset scheme');
    await sleep(100);document.removeEventListener('securitypolicyviolation',violation);
    if(!blockedAsset)throw Error('asset request was not blocked by enforced CSP');
    const before=location.href;
    location.assign(new URL('/index.html#workspace',location.href).href);await sleep(150);
    if(location.href!==before)throw Error('child escaped its CSP entry');
    // Native acceptance gate (not represented by a source-test success): on an
    // isolated Windows run, also click a synthetic download link and verify the
    // child on_download handler cancels Requested without a file/save dialog.
    const popup=window.open(new URL('/index.html',location.href).href,'_blank');await sleep(100);
    if(popup&&!popup.closed){popup.close();throw Error('child popup escaped navigation isolation');}
    model.edit(model.getSnapshot().content+'\n![[fixture-secret.png]]\n');if(!await model.flush())throw Error('synthetic child edit failed');
    const saved=model.getSnapshot();
    let expansionDenied=false;try{await command({op:'resolveAttachment',viewId:session.view.id,revision:saved.revision,destination:'fixture-secret.png',wiki:true});}catch(error){expansionDenied=String(error).includes('workspace-attachment-main-grant-required');}
    if(!expansionDenied)throw Error('child expanded read authority by saving a new reference');
    if(!await unreadable(attachmentUrl))throw Error('stale revision token survived save');
    const refreshed=await command({op:'resolveAttachment',viewId:session.view.id,revision:saved.revision,destination:'fixture-picture.png',wiki:true});
    if(!refreshed.token)throw Error('existing authorized attachment lost on ordinary note save');
    await report({attachmentSelfExpansionDenied:true,attachmentStaleTokenDenied:true,childAssetCspBlocked:true,childNavigationPinned:true,childPopupDenied:true});
   }catch(error){await report({error:String(error)});}},{target:{kind:'WebviewWindow',label}});
   await report({opaqueAttachmentRead:true,attachmentRangeRead:true,attachmentForgedScopeDenied:true,attachmentToken:attachment.token});

   await listen('fixture:write',async()=>{try{model.edit(model.getSnapshot().content+'\n窗口 A 的中文写入\n');if(!await model.flush())throw Error('flush failed');await report({writerCommitted:true,revision:model.getSnapshot().revision});}catch(e){await report({error:String(e)});}},{target:{kind:'WebviewWindow',label}});
   await listen('fixture:stale-write',async()=>{let rejected=false;try{await command({op:'writeNote',revision:initial.revision,content:'旧版本不应覆盖'});}catch{rejected=true;}const current=await command({op:'readNote'});await report({staleRejected:rejected&&current.content.includes('窗口 A 的中文写入'),view:session.view.id});},{target:{kind:'WebviewWindow',label}});
   await listen('fixture:edit-before-close',async()=>{model.edit(model.getSnapshot().content+'\n关闭前最后输入\n');await command({op:'dirty',dirty:true});let denied=false;try{await command({op:'close',label:null});}catch{denied=true;}await report({dirtyCloseDenied:denied});},{target:{kind:'WebviewWindow',label}});
   await listen('fixture:merge',()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='合并到主窗口');if(!button)throw Error('merge button missing');button.click();},{target:{kind:'WebviewWindow',label}});
   await listen('fixture:verify-recovery',async()=>{try{
    if(!model.getSnapshot().content.includes('关闭前最后输入'))throw Error('reopen lost saved content');
    const current=await command({op:'readNote',viewId:session.view.id});
    let baselinePreserved=false;try{await command({op:'resolveAttachment',viewId:session.view.id,revision:current.revision,destination:'fixture-secret.png',wiki:true});}catch(error){baselinePreserved=String(error).includes('workspace-attachment-main-grant-required');}
    if(!baselinePreserved)throw Error('recovery widened original attachment baseline');
    await command({op:'resolveAttachment',viewId:session.view.id,revision:current.revision,destination:'fixture-picture.png',wiki:true});
    await report({reopenedWindowKeepsLatestDocument:true,restoredStableWindowIdentity:true,attachmentRecoveryBaselinePreserved:true});
   }catch(error){await report({error:String(error)});}},{target:{kind:'WebviewWindow',label}});
   await listen('fixture:start-drag',async()=>{try{
    document.querySelector<HTMLButtonElement>('[aria-label="撤销布局移动"]')?.click();
    await until(async()=>!!document.querySelector('[data-workspace-tab="extra"]'),'reopen drag source');
    const data=new DataTransfer();document.querySelector('[data-workspace-tab="extra"]')!.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));
    await sleep(250);await report({dragTicket:data.getData(WORKSPACE_DRAG_TYPE)});
   }catch(error){await report({error:String(error)});}},{target:{kind:'WebviewWindow',label}});
   await listen<{ticket:string}>('fixture:drop-drag',async event=>{try{
    const host=document.querySelector<HTMLElement>('.workspace-host')!,rect=host.getBoundingClientRect(),data=new DataTransfer();data.setData(WORKSPACE_DRAG_TYPE,event.payload.ticket);
    const options={bubbles:true,cancelable:true,dataTransfer:data,clientX:rect.right-8,clientY:rect.top+rect.height*.6};
    host.dispatchEvent(new DragEvent('dragover',options));await new Promise(requestAnimationFrame);host.dispatchEvent(new DragEvent('drop',options));
   }catch(error){await report({error:String(error)});}},{target:{kind:'WebviewWindow',label}});
   await listen<{ticket:string}>('fixture:finish-drag',async event=>{try{
    if(document.querySelectorAll('.workspace-group').length!==2)throw Error('drop did not split target');
    const current=await command({op:'readNote',viewId:'extra'});if(!current.content.includes('独立内容'))throw Error('drag received wrong document');
    let replayDenied=false;try{await command({op:'claimDrag',id:event.payload.ticket});}catch{replayDenied=true;}if(!replayDenied)throw Error('drag ticket replay allowed');
    document.querySelector<HTMLButtonElement>('[data-workspace-tab-wrap="extra"] .workspace-tab-close')?.click();
    await until(async()=>!(await command({op:'bootstrap'})).views.find((v:any)=>v.view.id==='extra')?.open,'close dragged tab');
    await report({crossWindowDragHandshake:true,dragTargetSplit:true,dragReplayDenied:replayDenied,syntheticDomDragNotPhysicalGesture:true});
   }catch(error){await report({error:String(error)});}},{target:{kind:'WebviewWindow',label}});
   await listen('fixture:multi-tab',async()=>{try{
     const tab=()=>document.querySelector<HTMLElement>('[data-workspace-tab-wrap="extra"]');
     const editors=[...document.querySelectorAll('.cm-editor')];if(editors.length!==2)throw Error('second editor not mounted');
     const second=await command({op:'readNote',viewId:'extra'});if(!second.content.includes('独立内容'))throw Error('view scope incorrect');
     let unboundDenied=false;try{await command({op:'readNote',viewId:'not-granted'});}catch{unboundDenied=true;}if(!unboundDenied)throw Error('unbound read allowed');
     const nativeOpen=async()=>{const current=await command({op:'bootstrap'});return current.views.find((v:any)=>v.view.id==='extra')?.open;};
     tab()?.querySelector<HTMLButtonElement>('.workspace-tab-close')?.click();await until(async()=>!tab()&&!await nativeOpen(),'tab close');
     document.querySelector<HTMLButtonElement>('[aria-label="撤销布局移动"]')?.click();await until(async()=>!!tab()&&await nativeOpen(),'tab undo');
     if(editors.some(editor=>!editor.isConnected))throw Error('tab undo remounted editor');
     tab()?.querySelector<HTMLButtonElement>('.workspace-tab-close')?.click();await until(async()=>!tab()&&!await nativeOpen(),'tab reclose');
     await report({multiTabRetainedUndo:true,explicitViewScope:true,unboundDenied});
   }catch(error){await report({error:String(error)});}},{target:{kind:'WebviewWindow',label}});
   await until(async()=>!!document.querySelector('.cm-editor'),'editor mount');
   await report({editorMounted:true,productionWindowComponent:true,view:session.view.id});
   await stage('listeners-ready',{listenersReady:true});
 }
}
void run().catch(fail);
