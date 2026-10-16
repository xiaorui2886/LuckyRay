import type {NoteViewBaseline,NoteViewPresentationSnapshot} from './noteViewPresentation';
import {notesPaneIds,replaceNotesPane,type NotesOpenTab,type NotesPaneState} from './notesPaneModel';
import type {BridgeVaultMetadata} from '../../core/bridge/bridgeTypes';

export const NOTES_NATIVE_DETACH_EVENT='luckyray:notes-native-detach';
export type NotesNativeViewBinding={viewId:string;vaultId:string;vault:BridgeVaultMetadata;workspaceSourceId?:string;documentId:string;resourceId:string;relativePath:string;title:string;generation:number};
/** Main owns document writes. Transport receives only the exact mounted view. */
export interface NotesNativeViewAdapter {
  binding():NotesNativeViewBinding;
  isFrozen():boolean;
  isDirty():boolean;
  freeze():void;
  flush():Promise<boolean>;
  capture(expected:NoteViewBaseline):Promise<NoteViewPresentationSnapshot>;
  restore(expected:NoteViewBaseline,snapshot:NoteViewPresentationSnapshot):Promise<void>;
  /** Only after the destination has acknowledged the full presentation. */
  release():Promise<void>;
  commitRelease():Promise<void>;
  activate():Promise<void>;
  cancelIncoming():Promise<void>;
  /** Rollback only unlocks the existing view. It never closes or recreates it. */
  abort():Promise<void>;
}
export type NotesNativeIncomingView=Pick<NotesNativeViewBinding,'vaultId'|'documentId'|'relativePath'|'title'>&{viewId?:string};
export type NotesNativeManagementSection='vaults'|'settings'|'folders'|'attachments';
export type NotesNativeManagementReceiver={binding():{vaultId:string;generation:number};open(section:NotesNativeManagementSection):Promise<void>};
export function freezeNotesNativeView(composing:{live:boolean;source:boolean},freeze:()=>void){
  if(composing.live||composing.source)throw new Error('Finish composition before moving this note');
  freeze();
}
export function assertNotesNativeBaseline(binding:NotesNativeViewBinding,saved:{revision:string;content:string}|null,content:string,baseline:NoteViewBaseline){
  if(binding.vaultId!==baseline.authority.vaultId||binding.documentId!==baseline.authority.documentId||!binding.workspaceSourceId||binding.workspaceSourceId!==baseline.authority.sourceId||content!==baseline.content||saved?.content!==baseline.content||saved.revision!==baseline.revision)throw new Error('Main document does not match the authorized saved revision and actual read source');
}
export function advanceNotesSavedReadProof<T extends {generation:number;source:object;workspaceSourceId:string;content:string;revision:string}>(proof:T|undefined,saved:{content:string;revision:string},origin:{source:object|null;generation:number}):T|undefined{
  if(!proof)return undefined;
  if(!origin.source||proof.source!==origin.source||proof.generation!==origin.generation||!saved.revision)throw new Error('Saved note belongs to a changed source session');
  return {...proof,content:saved.content,revision:saved.revision};
}
/** Document identity is not view identity. Main tabs are document-keyed inside
 * each pane, so an incoming independent view always gets its own new pane. */
export function appendIncomingNotesPane(state:NotesPaneState,tab:NotesOpenTab,paneId:string,splitId:string):NotesPaneState{
  const panes=notesPaneIds(state.layout);
  if(!panes.includes(state.activePaneId)||!paneId||panes.includes(paneId)||!splitId||tab.kind==='empty'||!tab.id)throw new Error('Incoming note requires a new exact pane');
  return {
    layout:replaceNotesPane(state.layout,state.activePaneId,{kind:'split',id:splitId,orientation:'row',ratio:.5,first:{kind:'pane',id:state.activePaneId},second:{kind:'pane',id:paneId}}),
    tabs:{...state.tabs,[paneId]:[{...tab}]},
    activeTabs:{...state.activeTabs,[paneId]:tab.id},
    activePaneId:paneId,
  };
}
export class NotesNativeViewRegistry {
  private views=new Map<string,NotesNativeViewAdapter>();
  private incoming=new Map<string,symbol>();
  private insertedIncoming=new Map<string,()=>Promise<void>>();
  private coverageEpoch=0;
  private pendingReads=0;
  private pendingAdmissions=0;
  private coverageProviders=new Set<()=>boolean>();
  coverageGeneration(){return this.coverageEpoch;}
  coverageReady(){
    if(this.pendingReads||this.pendingAdmissions||(this.views.size>0&&!this.coverageProviders.size))return false;
    try{return [...this.coverageProviders].every(provider=>provider());}catch{return false;}
  }
  registerCoverage(provider:()=>boolean){this.coverageProviders.add(provider);this.notifyViews();return()=>{this.coverageProviders.delete(provider);this.notifyViews();};}
  beginRead(){
    this.pendingReads++;this.notifyViews();let finished=false;
    return()=>{if(finished)return;finished=true;this.pendingReads--;this.notifyViews();};
  }
  private viewListeners=new Set<()=>void>();
  private unregisterListeners=new Set<(viewId:string,adapter:NotesNativeViewAdapter)=>void>();
  subscribeViews(listener:()=>void){this.viewListeners.add(listener);return()=>{this.viewListeners.delete(listener);};}
  subscribe(listener:()=>void){return this.subscribeViews(listener);}
  notifyViews(){this.coverageEpoch++;for(const listener of this.viewListeners)listener();}
  onUnregister(listener:(viewId:string,adapter:NotesNativeViewAdapter)=>void){this.unregisterListeners.add(listener);return()=>{this.unregisterListeners.delete(listener);};}
  private dirtySubscriptions=new Set<{adapter:NotesNativeViewAdapter;listener:(dirty:boolean)=>void;last:boolean}>();
  subscribeDirty(viewId:string,listener:(dirty:boolean)=>void){
    const adapter=this.get(viewId),subscription={adapter,listener,last:adapter.isDirty()};
    this.dirtySubscriptions.add(subscription);
    return ()=>{this.dirtySubscriptions.delete(subscription);};
  }
  /** Called by actual draft/save/IME transitions, never by a polling timer. */
  notifyDirty(){
    for(const subscription of this.dirtySubscriptions){
      const dirty=subscription.adapter.isDirty();
      if(dirty!==subscription.last){subscription.last=dirty;subscription.listener(dirty);}
    }
  }
  private receiver:((incoming:NotesNativeIncomingView)=>Promise<NotesNativeViewAdapter>)|null=null;
  private managementProvider:(()=>NotesNativeManagementReceiver)|null=null;
  registerManagement(provider:()=>NotesNativeManagementReceiver){
    if(this.managementProvider)throw new Error('Main note management is already mounted');
    this.managementProvider=provider;return()=>{if(this.managementProvider===provider)this.managementProvider=null;};
  }
  management():NotesNativeManagementReceiver{
    if(!this.managementProvider)throw new Error('Main note management is not mounted');
    return this.managementProvider();
  }
  registerReceiver(receiver:(incoming:NotesNativeIncomingView)=>Promise<NotesNativeViewAdapter>){
    if(this.receiver)throw new Error('Main note receiver is already mounted');
    this.receiver=receiver;return()=>{if(this.receiver===receiver)this.receiver=null;};
  }
  markIncoming(viewId:string){
    if(!viewId||this.views.has(viewId)||this.incoming.has(viewId))throw new Error('Incoming note view identity is already reserved');
    this.incoming.set(viewId,Symbol(viewId));
  }
  isIncoming(viewId:string){return this.incoming.has(viewId);}
  incomingToken(viewId:string):symbol|undefined{return this.incoming.get(viewId);}
  stageIncoming(viewId:string,cancel:()=>Promise<void>){
    if(!this.isIncoming(viewId))throw new Error('Incoming note reservation is missing');
    this.insertedIncoming.set(viewId,cancel);this.notifyViews();
  }
  async cancelIncoming(viewId:string,expectedToken?:symbol){
    const token=this.incomingToken(viewId);
    if(!token||(expectedToken!==undefined&&expectedToken!==token))return;
    const adapter=this.views.get(viewId);
    if(adapter){await adapter.cancelIncoming();return;}
    const cancel=this.insertedIncoming.get(viewId);
    if(cancel){await cancel();if(this.incomingToken(viewId)===token)throw new Error('Incoming note layout removal is not acknowledged');return;}
    if(this.pendingAdmissions)throw new Error('Incoming note preparation is still pending');
    this.finishIncoming(viewId);
  }
  finishIncoming(viewId:string,expectedToken?:symbol){if(expectedToken!==undefined&&this.incomingToken(viewId)!==expectedToken)return;this.incoming.delete(viewId);this.insertedIncoming.delete(viewId);}
  async prepareIncoming(incoming:NotesNativeIncomingView):Promise<NotesNativeViewAdapter>{
    if(!this.receiver)return Promise.reject(new Error('Main note receiver is not mounted'));
    this.pendingAdmissions++;this.notifyViews();
    let reservation:symbol|undefined;
    try{
      if(incoming.viewId){this.markIncoming(incoming.viewId);reservation=this.incomingToken(incoming.viewId);}
      const adapter=await this.receiver(incoming),viewId=adapter.binding().viewId;
      if((incoming.viewId&&(viewId!==incoming.viewId||this.incomingToken(viewId)!==reservation))||!this.isIncoming(viewId)||!adapter.isFrozen())throw new Error('Incoming Main view was not admitted frozen under its exact identity');
      return adapter;
    }catch(error){if(incoming.viewId&&reservation&&this.incomingToken(incoming.viewId)===reservation&&!this.views.has(incoming.viewId)&&!this.insertedIncoming.has(incoming.viewId))this.finishIncoming(incoming.viewId);throw error;}
    finally{this.pendingAdmissions--;this.notifyViews();}
  }
  register(viewId:string,adapter:NotesNativeViewAdapter){
    if(!viewId||this.views.has(viewId))throw new Error('Note view is already registered');
    if(adapter.binding().viewId!==viewId)throw new Error('Note view registration identity changed');
    if(this.isIncoming(viewId))adapter.freeze();
    this.views.set(viewId,adapter);
    this.notifyViews();
    return ()=>{if(this.views.get(viewId)===adapter){
      this.views.delete(viewId);this.finishIncoming(viewId);
      for(const listener of this.unregisterListeners)listener(viewId,adapter);
      this.notifyViews();
    }};
  }
  get(viewId:string):NotesNativeViewAdapter {
    const adapter=this.views.get(viewId);
    if(!adapter)throw new Error('Exact note view is not mounted');
    if(adapter.binding().viewId!==viewId)throw new Error('Note view identity changed');
    return adapter;
  }
  list():NotesNativeViewBinding[]{return [...this.views.values()].flatMap(view=>{try{return [view.binding()];}catch{return [];}});}
  isFrozen(viewId:string):boolean{return this.views.get(viewId)?.isFrozen()===true;}
  hasFrozenViews():boolean{return this.incoming.size>0||[...this.views.values()].some(view=>view.isFrozen());}
}
export const notesNativeViews=new NotesNativeViewRegistry();
/** The event has no document or authority supplied by a caller. */
export function requestNotesNativeDetach(viewId:string,move:boolean=true){
  const view=notesNativeViews.get(viewId);if(view.isFrozen())throw new Error('Note view is already moving');
  window.dispatchEvent(new CustomEvent(NOTES_NATIVE_DETACH_EVENT,{detail:{viewId,move}}));
}
