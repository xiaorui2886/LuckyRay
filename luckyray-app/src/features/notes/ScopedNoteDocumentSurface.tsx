import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode,type KeyboardEvent as ReactKeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {useI18n} from '../../core/i18n';
import {resolveScopedShortcut} from '../../app/shortcuts';
import {applyEditorCommand,type EditorCommand,type EditorRange} from '../../core/services/editor';
import {getDraggedMaterialAsset,hasDraggedMaterialAsset} from '../../core/services/assetDrag';
import {materialBlockInsertion} from '../../core/markdown/materialBlockInsertion';
import {NoteDocumentSurface} from './NoteDocumentSurface';
import {NoteFilenameContext} from './editor/noteFilename';
import {EditorContextMenu,type TableEditorCommand} from './editor/EditorContextMenu';
import {extractClipboardImageSource,type ClipboardImageSource} from './editor/clipboardImages';
import type {LiveMarkdownEditorHandle,LiveEditorSessionSnapshot,LiveEditorTableContext,LiveEditorShortcutCommand} from './editor/LiveMarkdownEditor';
import type {LiveEditorTokenContext,LiveNote,LiveNoteOpenOptions} from './editor/types';
import {findSameNoteAnchorRange,getWikiAnchorCompletions,parseWikiAnchorQuery} from './editor/sameNoteAnchors';
import {applyEditableTableCommand,copyEditorTableColumnText,copyEditorTableRowText,parseEditableTableSource,resolveEditableTableRange,serializeEditableTableSource} from './editor/tableCommands';
import {applySourceListBackspace,applySourceListEnter,applySourceListIndent,autocompletePopupPosition,detectAutocompleteTrigger,findSourceEditorTokenAt,scoreAutocompleteLabel,sourceTextareaPositionFromPoint,toggleMarkdownTaskAtBodyLine,type AutocompleteItem,type AutocompleteState} from './sourceNoteEditor';
import {EditorAutocomplete} from './EditorAutocomplete';
import {InsertReferencePicker,type InsertPickerState} from './InsertReferencePicker';
import {assertNoteViewActionCurrent} from './noteViewActionGuard';
import {noteMediaWithEmbeddedNotes,noteRuntimeMissingActions,NoteRuntimeError,type NoteParentAction,type NoteActionValue,type NoteAuthority,type NoteMetadata,type NoteMedia,type NoteRuntime} from './NoteRuntime';
import type {NoteDocumentController} from './NoteDocumentController';
import {captureNoteMedia,captureNoteSource,captureNoteScroll,prepareNoteMediaRefresh,shouldReadNoteMetadata,inspectNotePresentationReferences,noteContentScrollElement,portableRetainedEditor,validateNoteViewPresentation,restoreNoteMedia,restoreNoteSource,restoreNotePresentationLayout,nextNotePresentationFrame,type NotePresentationHandle,type NoteViewPresentationSnapshot,type NoteSourcePresentation,type NoteMediaRefreshPlan} from './noteViewPresentation';
import './notes.css';
import './media/noteContent.css';
import '../../components/editorialContentChrome.css';

const emptyMetadata:NoteMetadata={notes:[],tags:[],links:[],backlinks:[],documentTags:[],favorite:false};
const emptyMedia:NoteMedia={assets:[],embeds:[]};
type ContextMenu={x:number;y:number;selection:EditorRange;token?:LiveEditorTokenContext|null;table?:LiveEditorTableContext|null;content:string};
export type ScopedNoteSurfacePanels={
  readiness?:()=>{complete:boolean;missing:string[]};
  index?:(input:{controller:NoteDocumentController;viewId:string;close:()=>void;interactionLocked:boolean;portalContainer?:HTMLElement|null;onNavigate?:(selection:EditorRange)=>void;requestAction?:(action:NoteParentAction)=>Promise<NoteActionValue>;getSelection?:()=>EditorRange})=>ReactNode;
  attachments?:(input:{controller:NoteDocumentController;viewId:string;close:()=>void;interactionLocked:boolean;portalContainer?:HTMLElement|null;requestAction?:(action:NoteParentAction)=>Promise<NoteActionValue>;getSelection?:()=>EditorRange})=>ReactNode;
  tags?:(input:{controller:NoteDocumentController;viewId:string;close:()=>void;interactionLocked:boolean;portalContainer?:HTMLElement|null;requestAction?:(action:NoteParentAction)=>Promise<NoteActionValue>;getSelection?:()=>EditorRange})=>ReactNode;
};
export type ScopedNoteDocumentSurfaceProps={
  viewId:string;controller:NoteDocumentController;runtime:NoteRuntime;title:string;visible?:boolean;onFocus?:()=>void;
  onRevisionReady?:(revision:string)=>void;onRevisionInvalidated?:()=>void;layoutRevision?:string;panels?:ScopedNoteSurfacePanels;localHeader?:ReactNode;
  /** Host-drained external changes may alter relations/media without changing the note body. */
  invalidationRevision?:number;
  /** The coordinator owns the transport lease across rendering/moves. Standalone
   * consumers retain the original surface-owned lease by default. */
  viewLease?:'surface'|'host';
  interactionLocked?:boolean;portalContainer?:HTMLElement|null;
  /** Keep this registration callback stable for the mounted view lifetime. */
  onPresentationHandle?:(viewId:string,handle:NotePresentationHandle|null)=>void;
  panelRequest?:{id:number;panel:'index'|'attachments'|'tags'};
  navigationRequest?:{id:number;heading?:string;blockId?:string};
  onActionResult?:(result:NoteActionValue,origin:{viewId:string;authority:NoteAuthority;revision:string;content:string})=>void|Promise<void>;
};
/** Native host adapter for the *same* production surface. It never mounts
 * NotesPage/App, discovers a global vault, or creates a second application.
 * The native host owns the controller registry and must await flushAll() before
 * quit/transfer. Every view owns its editor session independently. */
export function ScopedNoteDocumentSurface({viewId,controller,runtime,title,visible=true,onFocus,onRevisionReady,onRevisionInvalidated,layoutRevision,invalidationRevision=0,panels,localHeader,viewLease='surface',interactionLocked=false,portalContainer,onPresentationHandle,panelRequest,navigationRequest,onActionResult}:ScopedNoteDocumentSurfaceProps){
  const {t,locale}=useI18n();
  const state=useSyncExternalStore(controller.session.subscribe,controller.session.getSnapshot);
  const documentId=controller.authority.documentId;
  const invalidationRef=useRef(invalidationRevision);invalidationRef.current=invalidationRevision;
  const metadataSequence=useRef(0);
  const [capabilityRevision,setCapabilityRevision]=useState(0);
  useEffect(()=>runtime.actions.subscribeCapabilities?.(()=>{setCapabilityRevision(value=>value+1);onRevisionInvalidated?.();}),[runtime,onRevisionInvalidated]);
  const missingParentActions=useMemo(()=>noteRuntimeMissingActions(runtime),[runtime,capabilityRevision]);
  const actionsReady=missingParentActions.length===0;
  const panelsReady=Boolean(panels?.index&&panels?.attachments&&(!panels.readiness||panels.readiness().complete));
  const live=useRef<LiveMarkdownEditorHandle|null>(null),source=useRef<HTMLTextAreaElement|null>(null),content=useRef<HTMLDivElement|null>(null);
  const surfaceRoot=useRef<HTMLDivElement|null>(null);
  const sourceWasMeasurable=useRef(true),contentScroll=useRef<{top:number;left:number}>({top:0,left:0});
  const editorSession=useRef<LiveEditorSessionSnapshot|null>(null);
  const sourcePresentation=useRef<NoteSourcePresentation|undefined>(undefined);
  const mediaRef=useRef<NoteMedia>(emptyMedia),rawMediaRef=useRef<NoteMedia>(emptyMedia);
  const mediaRefreshSequence=useRef(0),pendingMediaRefresh=useRef<NoteMediaRefreshPlan>({playback:[]});
  const frozen=useRef(false);const [locallyFrozen,setLocallyFrozen]=useState(false);
  const actionFrozen=useRef(false),externalLock=useRef(interactionLocked);externalLock.current=interactionLocked;
  const capturedPlayback=useRef<NoteViewPresentationSnapshot|null>(null);
  const rollbackPresentation=useRef<NoteViewPresentationSnapshot|null>(null);
  const restoreEpoch=useRef(0);const [restoring,setRestoring]=useState(false);
  const [mode,setMode]=useState<'live'|'source'|'preview'>('live');
  const modeRef=useRef(mode);modeRef.current=mode;
  const [panelOpen,setPanelOpen]=useState(false),[attachmentsOpen,setAttachmentsOpen]=useState(false),[tagsOpen,setTagsOpen]=useState(false);
  useEffect(()=>{if(!panelRequest)return;if(panelRequest.panel==='index')setPanelOpen(true);else if(panelRequest.panel==='attachments')setAttachmentsOpen(true);else setTagsOpen(true);},[panelRequest?.id,panelRequest?.panel]);
  const [metadata,setMetadata]=useState<NoteMetadata>(emptyMetadata),[rawMedia,setMedia]=useState<NoteMedia>(emptyMedia);
  const media=useMemo(()=>noteMediaWithEmbeddedNotes(rawMedia,metadata),[rawMedia,metadata]);
  const [status,setStatus]=useState(''),[attachmentProblem,setAttachmentProblem]=useState(''),[metadataProblem,setMetadataProblem]=useState('');
  const [metadataReady,setMetadataReady]=useState<{revision:string;runtime:NoteRuntime;invalidationRevision:number}|null>(null),[attachmentsReady,setAttachmentsReady]=useState<{revision:string;runtime:NoteRuntime;invalidationRevision:number}|null>(null);
  const metadataCheckpoint=useRef({ready:metadataReady,value:metadata});metadataCheckpoint.current={ready:metadataReady,value:metadata};
  const captureMediaReadiness=useRef({revision:attachmentsReady?.revision,runtime:attachmentsReady?.runtime,invalidationRevision:attachmentsReady?.invalidationRevision,problem:attachmentProblem});
  captureMediaReadiness.current={revision:attachmentsReady?.revision,runtime:attachmentsReady?.runtime,invalidationRevision:attachmentsReady?.invalidationRevision,problem:attachmentProblem};
  const [menu,setMenu]=useState<ContextMenu|null>(null),[autocomplete,setAutocomplete]=useState<AutocompleteState|null>(null);
  const [insertPicker,setInsertPicker]=useState<(InsertPickerState & {content:string;epoch:number})|null>(null);
  const [ai,setAi]=useState<{busy:boolean;open:boolean;summary?:string;auto_tags:string[];error?:string}>({busy:false,open:false,auto_tags:[]});
  const [selectedAiTags,setSelectedAiTags]=useState<string[]>([]);
  const [compare,setCompare]=useState(false);
  const [renaming,setRenaming]=useState(false);
  mediaRef.current=media;rawMediaRef.current=rawMedia;
  const interactionLockedRef=useRef(interactionLocked);interactionLockedRef.current=interactionLocked||locallyFrozen||restoring;
  const [compositionEpoch,setCompositionEpoch]=useState(0);
  const composing=useRef(false),epoch=useRef(0),bindingEpoch=useRef(0),alive=useRef(true);
  useEffect(()=>{alive.current=true;bindingEpoch.current++;const release=viewLease==='surface'?controller.attachView(viewId,runtime):()=>{};void controller.load();return()=>{alive.current=false;epoch.current++;bindingEpoch.current++;release();};},[controller,runtime,viewId,viewLease]);
  useEffect(()=>{if(interactionLocked)epoch.current++;},[interactionLocked]);
  useEffect(()=>{epoch.current++;if(!visible){setMenu(null);setAutocomplete(null);setInsertPicker(null);}},[visible]);
  const setEditorMode=useCallback((next:'live'|'source'|'preview')=>{
    if(modeRef.current==='live')editorSession.current=live.current?.captureSession()||editorSession.current;
    if(modeRef.current==='source')sourcePresentation.current=captureNoteSource(source.current,sourcePresentation.current);
    epoch.current++;setAutocomplete(null);setMenu(null);setInsertPicker(null);setMode(next);
  },[]);
  useEffect(()=>{
    if(!onPresentationHandle)return;
    const baseline=()=>({authority:controller.authority,revision:controller.session.getSnapshot().revision,content:controller.session.getSnapshot().content});
    const assertReady=()=>{const snapshot=controller.session.getSnapshot();if(!alive.current||composing.current||live.current?.isComposing()||pendingMediaRefresh.current.playback.length>0||snapshot.dirty||snapshot.status!=='ready'||!snapshot.revision)throw new Error('Note view is not ready for presentation handoff');};
    const handle:NotePresentationHandle={
      freeze(){if(frozen.current||actionFrozen.current)throw new Error('Note view is already moving or handling an action');if(composing.current||live.current?.isComposing())throw new Error('Finish composition before moving this note');sourceWasMeasurable.current=Boolean(content.current?.clientHeight);frozen.current=true;rollbackPresentation.current=null;epoch.current++;if(surfaceRoot.current)surfaceRoot.current.inert=true;setLocallyFrozen(true);},
      freezeAction(){
        assertReady();if(frozen.current||actionFrozen.current||externalLock.current)throw new Error('Note view is already moving or handling an action');
        actionFrozen.current=true;interactionLockedRef.current=true;if(surfaceRoot.current)surfaceRoot.current.inert=true;setLocallyFrozen(true);
        let released=false;return()=>{if(released)return;released=true;actionFrozen.current=false;const locked=externalLock.current||frozen.current;interactionLockedRef.current=locked;if(surfaceRoot.current)surfaceRoot.current.inert=locked;setLocallyFrozen(frozen.current);};
      },
      async capture(){
        assertReady();const expected=baseline(),mode=modeRef.current;
        if(captureMediaReadiness.current.revision!==expected.revision||captureMediaReadiness.current.runtime!==runtime||captureMediaReadiness.current.invalidationRevision!==invalidationRef.current||captureMediaReadiness.current.problem)throw new Error('Note attachments have not acknowledged this saved revision');
        if(mode==='source'&&source.current?.value!==expected.content)throw new Error('Source editor content differs from its saved revision');
        if(frozen.current&&capturedPlayback.current)return validateNoteViewPresentation(capturedPlayback.current,expected);
        const liveSnapshot=mode==='live'?live.current?.capturePortableSession()||null:portableRetainedEditor(editorSession.current?.state,expected.content,{top:editorSession.current?.scrollTop||0,left:editorSession.current?.scrollLeft||0});
        const snapshot=validateNoteViewPresentation({version:1,...expected,mode,live:liveSnapshot,...captureNoteSource(source.current,sourcePresentation.current),contentScroll:captureNoteScroll(noteContentScrollElement(content.current),contentScroll.current),media:captureNoteMedia(content.current,mediaRef.current,expected.content)},expected);
        if(frozen.current){capturedPlayback.current=snapshot;content.current?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(item=>item.pause());}
        return snapshot;
      },
      async restore(input){
        assertReady();const expected=baseline(),snapshot=validateNoteViewPresentation(input,expected),restore=++restoreEpoch.current;
        const assertCurrent=()=>{assertReady();const current=baseline();if(restore!==restoreEpoch.current||current.revision!==expected.revision||current.content!==expected.content)throw new Error('Note changed during presentation restore');};
        if(!rollbackPresentation.current)rollbackPresentation.current=await handle.capture();assertCurrent();
        setRestoring(true);
        try{
          // Restore CM while mounted, then switch to the captured display mode.
          if(snapshot.live){setEditorMode('live');await nextNotePresentationFrame();assertCurrent();if(!live.current)throw new Error('Live editor did not mount');await live.current.restorePortableSession(snapshot.live);assertCurrent();editorSession.current=live.current.captureSession();}
          setEditorMode(snapshot.mode);await nextNotePresentationFrame();assertCurrent();
          sourcePresentation.current={sourceSelection:snapshot.sourceSelection,sourceScroll:snapshot.sourceScroll};restoreNoteSource(source.current,snapshot);
          const scroll=noteContentScrollElement(content.current);if(!scroll)throw new Error('Note view did not mount');scroll.scrollTop=snapshot.contentScroll.top;scroll.scrollLeft=snapshot.contentScroll.left;
          await restoreNoteMedia(()=>content.current,()=>mediaRef.current,expected.content,snapshot.media,assertCurrent);assertCurrent();
          await restoreNotePresentationLayout(snapshot,{source:()=>source.current,content:()=>content.current,liveScroll:()=>live.current?.getScrollElement()||null},assertCurrent);assertCurrent();capturedPlayback.current=snapshot;
        }finally{setRestoring(false);}
      },
      async activate(){assertReady();if(capturedPlayback.current)validateNoteViewPresentation(capturedPlayback.current,baseline());rollbackPresentation.current=null;capturedPlayback.current=null;frozen.current=false;setLocallyFrozen(false);},
      async abort(){
        restoreEpoch.current++;const playback=capturedPlayback.current,rollback=rollbackPresentation.current;
        try{if(rollback)await handle.restore(rollback);else if(playback){const check=()=>{assertReady();validateNoteViewPresentation(playback,baseline());};await restoreNoteMedia(()=>content.current,()=>mediaRef.current,playback.content,playback.media,check);if(sourceWasMeasurable.current)await restoreNotePresentationLayout(playback,{source:()=>source.current,content:()=>content.current,liveScroll:()=>live.current?.getScrollElement()||null},check);}}
        catch(error){rollbackPresentation.current=rollback;capturedPlayback.current=playback;frozen.current=true;if(surfaceRoot.current)surfaceRoot.current.inert=true;setLocallyFrozen(true);throw error;}
        rollbackPresentation.current=null;capturedPlayback.current=null;frozen.current=false;setLocallyFrozen(false);
      },
    };
    onPresentationHandle(viewId,handle);return()=>{restoreEpoch.current++;onPresentationHandle(viewId,null);};
  },[controller,runtime,viewId,onPresentationHandle,setEditorMode]);
  useEffect(()=>{
    if(!state.dirty||state.status==='conflict'||state.status==='error'||composing.current)return;
    const timer=setTimeout(()=>{if(!composing.current)void controller.flush();},500);return()=>clearTimeout(timer);
  },[controller,state.content,state.dirty,state.status]);
  const refreshMetadata=useCallback(async()=>{
    const current=bindingEpoch.current,revision=controller.session.getSnapshot().revision,invalidation=invalidationRef.current,sequence=++metadataSequence.current;
    if(!revision)return;
    const isCurrent=()=>alive.current&&current===bindingEpoch.current&&sequence===metadataSequence.current&&invalidation===invalidationRef.current&&revision===controller.session.getSnapshot().revision;
    const previous=metadataCheckpoint.current;
    const retainsProof=previous.ready?.revision===revision&&previous.ready.runtime===runtime;
    if(!retainsProof){onRevisionInvalidated?.();setMetadataReady(null);}
    try{
      const value=await controller.metadata(viewId);
      if(isCurrent()){
        if(retainsProof&&(!value.completeness?.complete||JSON.stringify(value)!==JSON.stringify(previous.value)))onRevisionInvalidated?.();
        setMetadata(value);setMetadataProblem('');
        setMetadataReady(value.completeness?.complete?{revision,runtime,invalidationRevision:invalidation}:null);
      }
    }catch(error){
      if(isCurrent()&&!(error instanceof NoteRuntimeError&&error.code==='stale-result')){
        onRevisionInvalidated?.();setMetadataProblem(error instanceof Error?error.message:String(error));setMetadataReady(null);
      }
    }
  },[controller,viewId,runtime,onRevisionInvalidated]);
  useEffect(()=>{pendingMediaRefresh.current={playback:[]};setMetadata(emptyMetadata);setMedia(emptyMedia);setMetadataReady(null);setAttachmentsReady(null);},[controller,runtime,viewId]);
  useEffect(()=>{if(shouldReadNoteMetadata({revision:state.revision,dirty:state.dirty,actionsReady,readyRevision:metadataReady?.revision,readyRuntimeMatches:metadataReady?.runtime===runtime,invalidationRevision,readyInvalidationRevision:metadataReady?.invalidationRevision}))void refreshMetadata();},[refreshMetadata,state.revision,state.dirty,capabilityRevision,actionsReady,invalidationRevision]);
  const referenceInspection=useMemo(()=>inspectNotePresentationReferences(state.content),[state.content]);
  const unsupportedReferences=JSON.stringify(referenceInspection.unsupported);
  const references=useMemo(()=>{
    const items=referenceInspection.references;
    const noteTargets=new Set((metadata.noteEmbeds||[]).map(embed=>JSON.stringify([embed.target,embed.wiki])));
    return JSON.stringify([...new Map(items.filter(ref=>!noteTargets.has(JSON.stringify([ref.target,ref.wiki]))).map(ref=>[JSON.stringify([ref.target,ref.wiki]),ref])).values()]);
  },[referenceInspection.references,metadata.noteEmbeds]);
  useEffect(()=>{
    let current=true;
    const resolve=async()=>{
      if(!state.revision)return;
      const sequence=++mediaRefreshSequence.current;
      const previous=captureMediaReadiness.current;
      const retainsProof=previous.revision===state.revision&&previous.runtime===runtime&&!previous.problem;
      if(!retainsProof){onRevisionInvalidated?.();setAttachmentsReady(null);}
      if(referenceInspection.unsupported.length){setAttachmentProblem(`本窗口无法完整读取此笔记的附件引用：${referenceInspection.unsupported[0].target.slice(0,160)}`);return;}
      try{
        const value=await controller.media(JSON.parse(references),state.revision,viewId);
        if(!current||sequence!==mediaRefreshSequence.current||invalidationRevision!==invalidationRef.current)return;
        if(retainsProof&&JSON.stringify(value)!==JSON.stringify(rawMediaRef.current)){onRevisionInvalidated?.();setAttachmentsReady(null);}
        const savedContent=controller.session.getSnapshot().content,capturedMode=modeRef.current;
        const assertCurrent=()=>{const snapshot=controller.session.getSnapshot();if(!current||sequence!==mediaRefreshSequence.current||invalidationRevision!==invalidationRef.current||!alive.current||snapshot.revision!==state.revision||snapshot.content!==savedContent||modeRef.current!==capturedMode)throw new NoteRuntimeError('stale-result','笔记在媒体恢复期间已变化。');};
        let plan:NoteMediaRefreshPlan;
        try{plan=capturedMode==='source'?{playback:[]}:prepareNoteMediaRefresh(content.current,mediaRef.current,value,savedContent,pendingMediaRefresh.current);}
        catch(error){setMedia(value);throw error;}
        pendingMediaRefresh.current=plan;
        // Always install this revision's newly issued grants. Old URLs never
        // become a fallback, even when restoring playback is rejected.
        setMedia(value);await nextNotePresentationFrame();assertCurrent();
        const commitDeadline=Date.now()+2000;
        while(rawMediaRef.current!==value){if(Date.now()>=commitDeadline)throw new Error('新媒体授权未完成渲染。');await nextNotePresentationFrame();assertCurrent();}
        await restoreNoteMedia(()=>content.current,()=>mediaRef.current,savedContent,plan.playback.map(item=>item.state),assertCurrent);assertCurrent();
        pendingMediaRefresh.current={playback:[]};setAttachmentProblem('');setAttachmentsReady({revision:state.revision,runtime,invalidationRevision});
      }catch(error){
        if(current&&sequence===mediaRefreshSequence.current){onRevisionInvalidated?.();if(!(error instanceof NoteRuntimeError&&error.code==='stale-result'))setAttachmentProblem(String(error));setAttachmentsReady(null);}
      }
    };
    void resolve();const timer=setInterval(()=>{void resolve();},5*60*1000);
    return()=>{current=false;clearInterval(timer);};
  },[controller,references,state.revision,viewId,runtime,onRevisionInvalidated,mode,unsupportedReferences,invalidationRevision]);
  useEffect(()=>{
    if(restoring||!actionsReady||!panelsReady||!visible||composing.current||!onRevisionReady||!state.revision||state.dirty||state.status!=='ready'||metadataReady?.revision!==state.revision||metadataReady.runtime!==runtime||attachmentsReady?.revision!==state.revision||attachmentsReady.runtime!==runtime){onRevisionInvalidated?.();return;}
    // Do not publish a new ACK from a pending check, but do not withdraw an
    // unchanged, already-rendered proof merely because a hint is being checked.
    if(metadataReady.invalidationRevision!==invalidationRevision||attachmentsReady.invalidationRevision!==invalidationRevision)return;
    const frame=requestAnimationFrame(()=>{
      const actual=mode==='live'?live.current?.getValue():mode==='source'?source.current?.value:state.content;
      if(!composing.current&&invalidationRef.current===invalidationRevision&&actual===state.content)onRevisionReady(state.revision);else onRevisionInvalidated?.();
    });return()=>{cancelAnimationFrame(frame);};
  },[restoring,mode,onRevisionReady,onRevisionInvalidated,layoutRevision,invalidationRevision,compositionEpoch,capabilityRevision,state.content,state.dirty,state.revision,state.status,visible,metadataReady,attachmentsReady,runtime,actionsReady,panelsReady]);
  // Revocation belongs to a real surface/mode lifetime, not cleanup of an
  // otherwise unchanged periodic renderer-check effect.
  useEffect(()=>()=>{onRevisionInvalidated?.();},[controller,runtime,viewId,mode,onRevisionInvalidated]);
  const value=()=>modeRef.current==='live'?live.current?.getValue()??controller.session.getSnapshot().content:source.current?.value??controller.session.getSnapshot().content;
  const selection=():EditorRange=>modeRef.current==='live'?live.current?.getSelection()||{start:0,end:0}:{start:source.current?.selectionStart||0,end:source.current?.selectionEnd||0};
  const focus=()=>modeRef.current==='live'?live.current?.focus():source.current?.focus();
  const setSelection=(range:EditorRange)=>{if(modeRef.current==='live')live.current?.setSelection(range);else source.current?.setSelectionRange(range.start,range.end);};
  const replaceRange=(text:string,range:EditorRange)=>{
    if(modeRef.current==='live'){live.current?.replaceRange(text,range);return;}
    const before=value(),next=before.slice(0,range.start)+text+before.slice(range.end);
    controller.edit(next);requestAnimationFrame(()=>{setSelection({start:range.start+text.length,end:range.start+text.length});focus();});
  };
  const applyContent=(next:string,range?:EditorRange)=>{
    const before=value();let from=0,to=before.length,end=next.length;
    while(from<to&&from<end&&before[from]===next[from])from++;
    while(to>from&&end>from&&before[to-1]===next[end-1]){to--;end--;}
    if(next!==before)replaceRange(next.slice(from,end),{start:from,end:to});
    if(range)requestAnimationFrame(()=>{setSelection(range);focus();});
  };
  const navigationApplied=useRef<number|null>(null);
  useEffect(()=>{
    if(!navigationRequest||navigationApplied.current===navigationRequest.id||state.status!=='ready'||interactionLockedRef.current)return;
    const range=findSameNoteAnchorRange(state.content,{headingPath:navigationRequest.heading,blockId:navigationRequest.blockId});
    navigationApplied.current=navigationRequest.id;
    if(!range){setStatus('未找到请求的标题或块。');return;}
    if(modeRef.current!=='live')setEditorMode('live');
    const revision=state.revision;requestAnimationFrame(()=>{if(alive.current&&controller.session.getSnapshot().revision===revision&&!interactionLockedRef.current){setSelection({start:range.from,end:range.to});focus();}});
  },[navigationRequest,state.status,state.revision,interactionLocked,locallyFrozen,restoring,controller,setEditorMode]);
  const request=async(action:NoteParentAction)=>{
    if(interactionLockedRef.current)throw new NoteRuntimeError('stale-result','视图正在安全移动或关闭，请稍后重试。');
    const current=epoch.current;
    const captured={epoch:current,mode:modeRef.current,selection:selection()};
    try{
      const result=await controller.request(viewId,action);
      if(!alive.current||interactionLockedRef.current)throw new NoteRuntimeError('stale-result','视图已关闭或正在移动。');
      if(result.kind!=='acknowledged')assertNoteViewActionCurrent(action,captured,{epoch:epoch.current,mode:modeRef.current,selection:selection()});
      const currentState=controller.session.getSnapshot(),origin={viewId,authority:controller.authority,revision:currentState.revision,content:currentState.content};
      if(result.kind==='replace-range')replaceRange(result.text,result.selection);
      else if(result.kind==='saved'){controller.session.receive(result.snapshot);setStatus(result.message||'');void refreshMetadata();}
      else if(result.kind==='suggestion'){setAi({busy:false,open:true,summary:result.summary,auto_tags:result.tags});setSelectedAiTags(result.tags);}
      else if(result.kind==='acknowledged'){setStatus(result.message||'');void refreshMetadata();}
      // A rename changes authority. Only the host may validate/rebind that grant;
      // never silently write the new target from a child.
      else setStatus(`已重命名为 ${result.title}，正在等待主窗口更新笔记授权。`);
      await onActionResult?.(result,origin);
      return result;
    }catch(error){if(alive.current&&epoch.current===current)setStatus(error instanceof Error?error.message:String(error));throw error;}
  };
  const run=(action:NoteParentAction)=>{void request(action).catch(()=>{});};
  const runCommand=async(command:EditorCommand,range=menu?.selection||selection())=>{
    setMenu(null);setAutocomplete(null);
    if(command==='insert-asset'){run({kind:'insert-attachment',selection:range});return;}
    const before=value(),current=epoch.current,selected=before.slice(range.start,range.end);
    if(command==='link'||command==='wiki-link'){
      setInsertPicker({kind:'note',query:selected.trim(),selectedIndex:0,selection:range,alias:selected.trim()||undefined,content:before,epoch:current});
      setStatus(t('editor.notes.status.selectNoteLink'));return;
    }
    if(command==='external-link'){
      const trimmed=selected.trim(),selectedIsUrl=/^https?:\/\//i.test(trimmed);
      const label=selectedIsUrl?t('editor.notes.insert.externalLinkTitle'):selected||t('editor.notes.insert.externalLinkTitle');
      const url=selectedIsUrl?trimmed:'https://',replacement=`[${label}](${url})`;
      replaceRange(replacement,range);
      const titleStart=range.start+1,titleEnd=titleStart+label.length,urlStart=titleEnd+2;
      requestAnimationFrame(()=>{setSelection(selectedIsUrl||!selected?{start:titleStart,end:titleEnd}:{start:urlStart,end:urlStart+url.length});focus();});
      setStatus(t('editor.notes.status.externalLinkInserted'));return;
    }
    try{
      const result=await applyEditorCommand(command,{content:before,selectionStart:range.start,selectionEnd:range.end,clipboard:navigator.clipboard});
      if(!alive.current||epoch.current!==current||value()!==before||controller.session.getSnapshot().content!==before)throw new NoteRuntimeError('stale-result','操作期间笔记内容已变化，请重试。');
      applyContent(result.content,result.selection);if(result.status)setStatus(result.status);
    }catch(error){setStatus(String(error));}
  };
  const runTable=async(command:TableEditorCommand)=>{
    const current=menu;setMenu(null);if(!current?.table)return;
    try{
      const before=value();if(before!==current.content||controller.session.getSnapshot().content!==before)throw Error('表格已变化，请重新选择。');
      const range=resolveEditableTableRange(before,current.table);if(!range)throw Error('无法定位表格。');
      const table=parseEditableTableSource(before.slice(range.from,range.to));if(!table)throw Error('无法读取表格。');
      if(command==='row-copy'||command==='column-copy'){await navigator.clipboard.writeText(command==='row-copy'?copyEditorTableRowText(table,current.table):copyEditorTableColumnText(table,current.table));return;}
      replaceRange(serializeEditableTableSource(applyEditableTableCommand(table,current.table,command)),{start:range.from,end:range.to});focus();
    }catch(error){setStatus(String(error));}
  };
  const notes:LiveNote[]=useMemo(()=>[...metadata.notes.filter(note=>note.id!==documentId),{id:documentId,title,contentText:state.content}], [metadata.notes,documentId,title,state.content]);
  const openNote=(id:string,options?:LiveNoteOpenOptions,newTab=false)=>{
    if(id===documentId&&!newTab){
      const range=findSameNoteAnchorRange(value(),options||{});if(range){if(modeRef.current==='preview')setEditorMode('live');requestAnimationFrame(()=>{setSelection({start:range.from,end:range.to});focus();});}return;
    }
    const target=metadata.notes.find(note=>note.id===id)?.target||metadata.backlinks.find(link=>link.target.documentId===id)?.target;
    if(!target){setStatus('笔记目标未获得主窗口授权。');return;}
    run({kind:'open-note',target,options,newTab});
  };
  const openAsset=(id:string)=>{
    const embedded=metadata.noteEmbeds?.find(embed=>`note-embed:${embed.note.documentId}`===id);
    if(embedded){run({kind:'open-note',target:embedded.note});return;}
    const asset=media.assets.find(item=>item.id===id);if(!asset){setStatus('附件授权已失效，请重试。');return;}
    const binding=media.bindings?.find(binding=>binding.assetId===id);if(!binding){setStatus('附件授权已失效，请重试。');return;}
    run({kind:'open-attachment',token:binding.token});
  };
  const openTag=(id:string)=>{const tag=metadata.tags.find(item=>item.id===id);if(!tag){setStatus('标签目标未验证。');return;}run({kind:'open-tag',tagId:id,ticket:tag.ticket});};
  const insertClipboard=(image:ClipboardImageSource,range:EditorRange)=>run({kind:'insert-clipboard-image',source:{kind:image.value.startsWith('data:')?'data-url':'remote-url',value:image.value},selection:range});
  const createNote=(name:string,options?:LiveNoteOpenOptions)=>run({kind:'create-note',title:name,options});
  const liveCommand=(command:LiveEditorShortcutCommand)=>{
    if(command==='toggle-preview')setEditorMode(modeRef.current==='preview'?'live':'preview');
    else if(command==='toggle-source')setEditorMode(modeRef.current==='source'?'live':'source');
    else if(command==='ai-write-menu'){const position=live.current?.getSelectionCoords();setMenu({x:position?.x||100,y:position?.y||100,selection:selection(),content:value()});}
    else void runCommand(command);
  };
  const updateAutocomplete=(text:string,cursor:number)=>{
    if(composing.current||!source.current){setAutocomplete(null);return;}
    const trigger=detectAutocompleteTrigger(text,cursor);if(!trigger){setAutocomplete(null);return;}
    let items:AutocompleteItem[]=[];
    if(trigger.kind==='anchor'){
      const anchor=parseWikiAnchorQuery(trigger.query);
      if(anchor&&(!anchor.noteTitle||anchor.noteTitle.toLocaleLowerCase()===title.toLocaleLowerCase())) items=getWikiAnchorCompletions(text,trigger.query).map(item=>({id:`${item.kind}:${item.from}`,label:item.label,meta:item.detail,insertText:`[[${item.insertText}]]`}));
    }else if(trigger.kind==='note')items=metadata.notes.map(note=>({id:note.id,label:note.title,snippet:note.snippet}));
    else if(trigger.kind==='tag')items=metadata.tags.map(tag=>({id:tag.id,label:tag.name}));
    else items=media.assets.map(asset=>({...asset,label:asset.name}));
    if(trigger.kind!=='anchor')items=items.filter(item=>scoreAutocompleteLabel(item.label,trigger.query)<1000).sort((a,b)=>scoreAutocompleteLabel(a.label,trigger.query)-scoreAutocompleteLabel(b.label,trigger.query)).slice(0,20);
    setAutocomplete(items.length?{...trigger,...autocompletePopupPosition(source.current,text,cursor,trigger.kind),items,selectedIndex:0}:null);
  };
  const insertCompletion=(item:AutocompleteItem)=>{
    if(!autocomplete)return;const {kind,start,end}=autocomplete;
    const replacement=item.insertText||(kind==='tag'?`#${item.label}`:`${kind==='asset'?'!':''}[[${item.label}]]`);
    const before=value();const insertion=kind==='asset'?materialBlockInsertion(before,replacement,{start,end}):replacement;
    replaceRange(insertion,{start,end});setAutocomplete(null);
  };
  const sourceKeyDown=(event:ReactKeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.nativeEvent.isComposing||composing.current)return;
    if(autocomplete&&['Enter','Tab','Escape','ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault();event.stopPropagation();
      if(event.key==='Escape')setAutocomplete(null);
      else if(event.key==='ArrowDown'||event.key==='ArrowUp')setAutocomplete({...autocomplete,selectedIndex:(autocomplete.selectedIndex+(event.key==='ArrowDown'?1:-1)+autocomplete.items.length)%autocomplete.items.length});
      else insertCompletion(autocomplete.items[autocomplete.selectedIndex]);return;
    }
    const command=resolveScopedShortcut(event.nativeEvent,'knowledge',undefined,{ids:['knowledgeBold','knowledgeItalic','knowledgeLink','knowledgeExternalLink','knowledgePreview','knowledgeSource','knowledgeAiWrite','knowledgeAutocomplete']});
    if(command){event.preventDefault();event.stopPropagation();
      if(command==='knowledgeAutocomplete')updateAutocomplete(event.currentTarget.value,event.currentTarget.selectionStart);
      else if(command==='knowledgePreview')liveCommand('toggle-preview');else if(command==='knowledgeSource')liveCommand('toggle-source');
      else if(command==='knowledgeAiWrite')setMenu({x:100,y:100,selection:selection(),content:value()});
      else void runCommand(command==='knowledgeBold'?'bold':command==='knowledgeItalic'?'italic':command==='knowledgeLink'?'link':'external-link');return;
    }
    if(event.ctrlKey||event.metaKey||event.altKey||!['Tab','Backspace','Enter'].includes(event.key)||(event.shiftKey&&event.key!=='Tab'))return;
    const area=event.currentTarget;
    const result=event.key==='Tab'?applySourceListIndent(area.value,area.selectionStart,area.selectionEnd,event.shiftKey?'outdent':'indent'):event.key==='Enter'?applySourceListEnter(area.value,area.selectionStart,area.selectionEnd):applySourceListBackspace(area.value,area.selectionStart,area.selectionEnd);
    if(result){event.preventDefault();applyContent(result.value,{start:result.selectionStart,end:result.selectionEnd});setAutocomplete(null);}
  };
  const sourceContext=(event:React.MouseEvent<HTMLTextAreaElement>)=>{
    event.preventDefault();event.stopPropagation();const area=event.currentTarget,position=sourceTextareaPositionFromPoint(area,event.clientX,event.clientY);
    const token=findSourceEditorTokenAt(area.value,position,{assets:media.assets,currentNoteId:documentId,noteEmbeds:media.embeds,noteLinks:metadata.links,notes,tags:metadata.tags});
    const range=token?{start:token.from,end:token.to}:position>=area.selectionStart&&position<=area.selectionEnd?{start:area.selectionStart,end:area.selectionEnd}:{start:position,end:position};
    area.setSelectionRange(range.start,range.end);setMenu({x:event.clientX,y:event.clientY,selection:range,token,content:area.value});
  };
  const tokenAction=(token:LiveEditorTokenContext)=>{
    setMenu(null);
    if(token.kind==='note'){if(token.noteId)openNote(token.noteId,token.openOptions);else if(token.createTitle)createNote(token.createTitle,token.openOptions);}
    else if(token.kind==='asset'&&token.assetId)openAsset(token.assetId);
    else if(token.kind==='tag'){if(token.tagId)openTag(token.tagId);else run({kind:'create-tag',name:token.label});}
    else if(token.kind==='external'&&token.href)run({kind:'open-external',url:token.href});
  };
  const checkedToken=(token:LiveEditorTokenContext,perform:(text:string)=>void)=>{
    if(!menu||value()!==menu.content){setMenu(null);setStatus('笔记已变化，请重新选择。');return;}
    perform(menu.content.slice(token.from,token.to));setMenu(null);
  };
  const titleActions={rename:async(id:string,name:string)=>{
    if(id!==documentId)throw new NoteRuntimeError('scope-mismatch','文件名与当前笔记不匹配。');
    setRenaming(true);try{await request({kind:'rename-document',title:name});}finally{setRenaming(false);}
  },namingId:null,busyId:renaming?documentId:null,finish:()=>{},focusBody:focus};
  const ready=Boolean(state.revision);
  const statusText=state.status==='saving'?t('editor.notes.status.saving'):state.status==='error'?t('editor.notes.status.saveFailed'):status;
  return <NoteFilenameContext.Provider value={titleActions}>
    <div ref={surfaceRoot} className="editor-row" data-scoped-note-surface={viewId} inert={interactionLocked||locallyFrozen||restoring}>
      <NoteDocumentSurface viewId={viewId} paneId={viewId} selectedNote={ready?{id:documentId}:null} selectedNoteId={documentId} editTitle={title}
        editorMode={mode} selectedNoteFavorite={metadata.favorite} favoriteAvailable={ready} filenameTitle attachmentProblem={attachmentProblem} attachmentSidebarOpen={attachmentsOpen}
        activeNoteTags={metadata.documentTags} tagDialogOpen={tagsOpen} aiPanelOpen={ai.open} aiBusy={ai.busy} aiSuggestion={ai} aiSuggestionTags={ai.auto_tags} selectedAiTags={selectedAiTags}
        panelOpen={panelOpen} wordCount={state.content.trim().length} lineCount={state.content?state.content.split(/\r?\n/).length:1} activeRealVaultExternalConflict={state.status==='conflict'}
        status={statusText} mobileEditingNoteId={null} locale={locale} viewRefs={{live,source,content}} localHeader={localHeader}
        areaEvents={{onFocusCapture:onFocus,onPointerDownCapture:onFocus,onCompositionStartCapture:()=>{composing.current=true;controller.setComposing(viewId,true);onRevisionInvalidated?.();setCompositionEpoch(value=>value+1);},onCompositionEndCapture:()=>{composing.current=false;controller.setComposing(viewId,false);setCompositionEpoch(value=>value+1);setTimeout(()=>{if(alive.current&&!composing.current)void controller.flush();},0);},onKeyDownCapture:event=>{
          if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopPropagation();if(!composing.current)void controller.flush();}
        },onMouseDownCapture:event=>{
          const external=(event.target as Element).closest<HTMLElement>('[data-lr-token-kind="external"]');
          if(external&&(event.ctrlKey||event.metaKey)){event.preventDefault();event.stopPropagation();const url=external.dataset.lrTokenHref;const embed=media.embeds.find(item=>item.targetName===url);if(embed?.assetId)openAsset(embed.assetId);else if(url)run({kind:'open-external',url});}
        }}}
        contentEvents={{onScrollCapture:event=>{if(event.target instanceof HTMLElement&&event.target.matches('.note-preview'))contentScroll.current=captureNoteScroll(event.target,contentScroll.current);}}}
        sourceEditor={{value:state.content,readOnly:!ready||interactionLocked||locallyFrozen||restoring,disabled:!ready,placeholder:t('editor.notes.writePlaceholder'),onChange:event=>{controller.edit(event.target.value);updateAutocomplete(event.target.value,event.target.selectionStart);},onKeyDown:sourceKeyDown,onContextMenu:sourceContext,
          onSelect:event=>updateAutocomplete(event.currentTarget.value,event.currentTarget.selectionStart),onCompositionStart:()=>{composing.current=true;setAutocomplete(null);},onCompositionEnd:event=>{composing.current=false;controller.edit(event.currentTarget.value);updateAutocomplete(event.currentTarget.value,event.currentTarget.selectionStart);},
          onPaste:event=>{const range={start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd};if(event.clipboardData.files.length){event.preventDefault();run({kind:'insert-files',files:Array.from(event.clipboardData.files),selection:range});return;}const image=extractClipboardImageSource(event.clipboardData);if(image){event.preventDefault();insertClipboard(image,range);}},
          onDragOver:event=>{if(hasDraggedMaterialAsset(event.dataTransfer)||event.dataTransfer.files.length){event.preventDefault();event.dataTransfer.dropEffect='copy';}},
          onDrop:event=>{const asset=getDraggedMaterialAsset(event.dataTransfer),files=event.dataTransfer.files;if(!asset&&!files.length)return;event.preventDefault();const range={start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd};if(asset)run({kind:'insert-existing-attachment',assetId:asset.id,selection:range});else run({kind:'insert-files',files:Array.from(files),selection:range});}}}
        liveEditor={{value:state.content,readOnly:!ready||interactionLocked||locallyFrozen||restoring,disabled:!ready,placeholderText:t('editor.notes.writePlaceholder'),currentNoteId:documentId,assets:media.assets,noteEmbeds:media.embeds,noteLinks:metadata.links,notes,tags:metadata.tags,
          restoreSession:editorSession.current,onSessionCapture:snapshot=>{editorSession.current=snapshot;},onChange:controller.edit,onFocus,onCommand:liveCommand,
          onContextMenu:(event,range,token,table)=>{event.preventDefault();event.stopPropagation();setMenu({x:event.clientX,y:event.clientY,selection:range,token,table,content:value()});},
          onOpenNote:openNote,onCreateNote:createNote,onOpenAsset:openAsset,onOpenTag:openTag,onCreateTag:name=>run({kind:'create-tag',name}),
          onInsertFiles:(files,range)=>run({kind:'insert-files',files:Array.from(files),selection:range}),onInsertClipboardImage:insertClipboard,onInsertAssetReference:(asset,range)=>run({kind:'insert-existing-attachment',assetId:asset.id,selection:range})}}
        preview={{text:state.content,currentNoteId:documentId,onOpenExternal:url=>run({kind:'open-external',url}),noteLinks:metadata.links,noteEmbeds:media.embeds,assets:media.assets,notes,tags:metadata.tags,onOpenNote:openNote,onCreateNote:createNote,onOpenAsset:openAsset,onOpenTag:openTag,onCreateTag:name=>run({kind:'create-tag',name}),onToggleTask:line=>controller.edit(toggleMarkdownTaskAtBodyLine(state.content,line))}}
        tagName={id=>metadata.tags.find(tag=>tag.id===id)?.name||id}
        actions={{changeTitle:name=>{void titleActions.rename(documentId,name).catch(()=>{});},askAi:()=>run({kind:'ask-ai'}),toggleFavorite:()=>run({kind:'set-favorite',favorite:!metadata.favorite}),toggleAttachments:()=>{if(panels?.attachments)setAttachmentsOpen(value=>!value);else run({kind:'browse-attachments'});},
          createDocument:()=>run({kind:'create-note',title:''}),browseDocuments:()=>run({kind:'browse-documents'}),closeTab:()=>run({kind:'close-view'}),removeTag:tagId=>run({kind:'remove-document-tag',tagId}),editTags:()=>run({kind:'edit-document-tags'}),
          suggestAi:()=>{const current=epoch.current;setAi({...ai,open:true,busy:true});void request({kind:'suggest-ai'}).then(result=>{if(alive.current&&epoch.current===current&&result.kind==='acknowledged')setAi(previous=>({...previous,busy:false}));}).catch(error=>{if(alive.current&&epoch.current===current)setAi(previous=>({...previous,open:true,busy:false,error:String(error)}));});},toggleAiTag:tag=>setSelectedAiTags(tags=>tags.includes(tag)?tags.filter(item=>item!==tag):[...tags,tag]),applyAiTags:()=>{if(!selectedAiTags.length){setStatus('请先选择要添加的标签。');return;}run({kind:'apply-document-tags',names:selectedAiTags,mode:'merge'});},
          toggleIndex:()=>{if(panels?.index)setPanelOpen(value=>!value);else run({kind:'browse-documents'});},reloadConflict:()=>{if(window.confirm('放弃当前未保存输入，使用已显示的远端版本？'))controller.session.resolveConflict('remote');},keepConflict:()=>{if(window.confirm('保留当前输入并替换已显示的远端版本？')){controller.session.resolveConflict('keep-local');void controller.flush();}},retrySave:()=>{void controller.flush();},togglePreview:()=>setEditorMode(mode==='preview'?'live':'preview'),toggleSource:()=>setEditorMode(mode==='source'?'live':'source')}}
      />
      {panelOpen&&panels?.index?.({controller,viewId,close:()=>setPanelOpen(false),interactionLocked:interactionLocked||locallyFrozen||restoring,portalContainer,requestAction:request,getSelection:selection,onNavigate:range=>{if(interactionLockedRef.current)return;setEditorMode('live');requestAnimationFrame(()=>{setSelection(range);focus();});}})}
      {attachmentsOpen&&panels?.attachments?.({controller,viewId,close:()=>setAttachmentsOpen(false),interactionLocked:interactionLocked||locallyFrozen||restoring,portalContainer,requestAction:request,getSelection:selection})}
      {tagsOpen&&panels?.tags?.({controller,viewId,close:()=>setTagsOpen(false),interactionLocked:interactionLocked||locallyFrozen||restoring,portalContainer,requestAction:request,getSelection:selection})}
    </div>
    {!ready&&<div role="status" className="workspace-missing">{state.status==='loading'?'正在读取笔记…':`笔记无法读取：${state.error||'来源不可用'}`}<button onClick={()=>void controller.load()}>重试</button></div>}
    {!panelsReady&&<div role="status" className="workspace-note-status">此窗口的完整索引或附件面板尚未接入，暂不能完成转移。</div>}
    {!actionsReady&&<div role="status" className="workspace-note-status">本窗口还有 {missingParentActions.length} 项笔记操作尚未接入主窗口，暂不能完成转移。</div>}
    {metadata.completeness&&<div role="note" className="workspace-note-status">补全与反向链接限于已链接和反向链接的笔记。{metadata.completeness.truncated&&'结果已达到此窗口的上限。'}{!metadata.completeness.complete&&` 部分服务尚未就绪：${metadata.completeness.missing.join('、')}`}</div>}
    {metadataProblem&&<div role="alert" className="workspace-note-status">{metadataProblem}<button onClick={()=>void refreshMetadata()}>重试元数据</button></div>}
    {(status||state.error||attachmentProblem)&&<div role="status" className="workspace-note-status">{status||state.error||attachmentProblem}</div>}
    {state.remote&&<div className="workspace-conflict"><button onClick={()=>setCompare(value=>!value)}>比较远端版本</button>{compare&&<pre>{state.remote.content}</pre>}</div>}
    {!interactionLocked&&insertPicker&&createPortal(<InsertReferencePicker state={insertPicker}
      items={metadata.notes.map(note=>({id:note.id,label:note.title,snippet:note.snippet})).filter(item=>scoreAutocompleteLabel(item.label,insertPicker.query)<1000).sort((a,b)=>scoreAutocompleteLabel(a.label,insertPicker.query)-scoreAutocompleteLabel(b.label,insertPicker.query))}
      onQueryChange={query=>setInsertPicker({...insertPicker,query,selectedIndex:0})} onSelectIndex={selectedIndex=>setInsertPicker({...insertPicker,selectedIndex})}
      onCancel={()=>{setInsertPicker(null);focus();}} onInsert={item=>{
        if(insertPicker.epoch!==epoch.current||insertPicker.content!==value()){setInsertPicker(null);setStatus('笔记或视图已变化，请重新插入。');return;}
        const alias=(insertPicker.alias||'').trim();replaceRange(alias&&alias!==item.label?`[[${item.label}|${alias}]]`:`[[${item.label}]]`,insertPicker.selection);
        setInsertPicker(null);setStatus(t('editor.notes.status.insertedNoteLink'));focus();
      }}/>,portalContainer??document.body)}
    {!interactionLocked&&autocomplete&&createPortal(<EditorAutocomplete state={autocomplete} onHover={selectedIndex=>setAutocomplete({...autocomplete,selectedIndex})} onSelect={insertCompletion}/>,portalContainer??document.body)}
    {!interactionLocked&&menu&&createPortal(<div className="workspace-note-menu-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget)setMenu(null);}} onKeyDown={event=>{if(event.key==='Escape'){setMenu(null);focus();}}}>
      <EditorContextMenu x={menu.x} y={menu.y} aiBusy={ai.busy} token={menu.token} table={menu.table} onCommand={command=>void runCommand(command)} onTableCommand={command=>void runTable(command)}
        onAiWrite={action=>{const range=menu.selection;setMenu(null);run({kind:'write-ai',action,selection:range});}} onOpenToken={tokenAction} onOpenNoteInNewTab={token=>{setMenu(null);if(token.noteId)openNote(token.noteId,token.openOptions,true);}} onOpenAssetDetail={openAsset}
        onCopyToken={token=>checkedToken(token,text=>{void navigator.clipboard.writeText(text).catch(error=>setStatus(String(error)));})}
        onCopyTokenLabel={token=>checkedToken(token,()=>{void navigator.clipboard.writeText(token.label).catch(error=>setStatus(String(error)));})}
        onCopyTokenTarget={token=>checkedToken(token,text=>{const target=token.href||/^\[\[([^|\]]+)/.exec(text)?.[1]||text;void navigator.clipboard.writeText(target).catch(error=>setStatus(String(error)));})}
        onRemoveToken={token=>checkedToken(token,()=>replaceRange('',{start:token.from,end:token.to}))}
        onEditNoteAlias={token=>checkedToken(token,text=>{const alias=window.prompt('显示文字',token.label);if(alias===null)return;const next=token.kind==='external'?`[${alias}](${token.href})`:`[[${text.slice(2,-2).split('|')[0]}|${alias}]]`;replaceRange(next,{start:token.from,end:token.to});})}
        onRenameTag={token=>{setMenu(null);const tag=metadata.tags.find(item=>item.id===token.tagId);if(!tag){setStatus('标签目标未验证。');return;}const name=window.prompt('标签名称',tag.name);if(name?.trim())run({kind:'rename-tag',tagId:tag.id,ticket:tag.ticket,name:name.trim()});}}
      />
    </div>,portalContainer??document.body)}
  </NoteFilenameContext.Provider>;
}
