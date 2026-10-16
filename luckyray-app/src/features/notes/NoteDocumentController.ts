import {DocumentSession} from '../../workspace/documentSession';
import {assertNoteAuthority, noteAuthorityKey, NoteRuntimeError, unwrapNoteResult, validateNoteMetadata, validateNoteMetadataCompleteness, noteMediaFromGrants, validateNoteParentAction} from './NoteRuntime';
import type {NoteRuntime, NoteAuthority, NoteActionReply, NoteActionRequest, NoteActionValue, NoteParentAction, NoteMetadata, NoteAttachmentReference, NoteMedia} from './NoteRuntime';

/** One draft/CAS owner per document authority. Selections, folding, history,
 * scroll and mode deliberately stay in each mounted surface, not this owner. */
export class NoteDocumentController {
  readonly authority:NoteAuthority;
  readonly session:DocumentSession;
  private runtime:NoteRuntime;
  private generation=0;
  private requestSequence=0;
  private metadataSequence=new Map<string,number>();
  private currentContent='';
  private viewLeases=new Map<string,symbol>();
  private viewRuntimes=new Map<string,NoteRuntime>();
  private hadView=false;
  private composingViews=new Set<string>();
  private requests=new Map<number,symbol>();
  constructor(runtime:NoteRuntime){
    this.runtime=runtime;this.authority=Object.freeze({...runtime.authority});
    this.session=new DocumentSession({
      read:async()=>{const runtime=this.documentRuntime(),value=await runtime.documents.read();if(runtime!==this.documentRuntime())throw new NoteRuntimeError('stale-result','笔记授权已更新，请重试读取。');assertNoteAuthority(value.authority,this.authority);return value;},
      write:async(content,revision)=>{const runtime=this.documentRuntime(),value=await runtime.documents.write(content,revision);if(runtime!==this.documentRuntime())throw new NoteRuntimeError('stale-result','保存期间笔记授权已更新，请核对版本。');assertNoteAuthority(value.authority,this.authority);return value;},
    });
    this.session.subscribe(()=>{const {content}=this.session.getSnapshot();if(content!==this.currentContent){this.currentContent=content;this.generation++;}});
  }
  /** Regrant only this document, preserving all draft/CAS ownership. The host
   * passes a view id for view-specific grants; no active-view/global fallback. */
  replaceRuntime(runtime:NoteRuntime,viewId?:string){
    assertNoteAuthority(runtime.authority,this.authority);
    if(viewId){
      if(!this.viewLeases.has(viewId))throw new NoteRuntimeError('scope-mismatch','笔记视图已关闭。');
      this.viewRuntimes.set(viewId,runtime);this.metadataSequence.delete(viewId);return;
    }
    if(this.runtime!==runtime){
      const old=this.runtime;this.runtime=runtime;
      for(const [id,bound] of this.viewRuntimes)if(bound===old)this.viewRuntimes.set(id,runtime);
      this.metadataSequence.clear();
    }
  }
  private documentRuntime():NoteRuntime{
    const runtime=this.viewRuntimes.values().next().value;
    if(runtime)return runtime;
    if(!this.hadView)return this.runtime;
    throw new NoteRuntimeError('unavailable','笔记已没有有效视图授权，输入仍保留。');
  }
  private runtimeForView(viewId?:string):NoteRuntime{
    if(!viewId)return this.documentRuntime();
    const runtime=this.viewRuntimes.get(viewId);
    if(!runtime)throw new NoteRuntimeError('scope-mismatch','笔记视图已关闭。');
    return runtime;
  }
  attachView(viewId:string,runtime:NoteRuntime=this.runtime){
    assertNoteAuthority(runtime.authority,this.authority);
    if(this.viewLeases.has(viewId))throw new NoteRuntimeError('scope-mismatch','视图标识已被使用。');
    const lease=Symbol(viewId);this.hadView=true;this.viewLeases.set(viewId,lease);this.viewRuntimes.set(viewId,runtime);
    return ()=>{if(this.viewLeases.get(viewId)===lease){this.viewLeases.delete(viewId);this.viewRuntimes.delete(viewId);this.metadataSequence.delete(viewId);this.composingViews.delete(viewId);}};
  }
  setComposing(viewId:string,composing:boolean){
    if(!this.viewLeases.has(viewId))return;
    if(composing)this.composingViews.add(viewId);else this.composingViews.delete(viewId);
  }
  isComposing=()=>this.composingViews.size>0;
  /** Installed effect handlers must call this at their commit boundary too;
   * rejecting a late reply cannot undo an already-performed external mutation. */
  isActionCurrent(request:NoteActionRequest){
    const lease=this.viewLeases.get(request.viewId),state=this.session.getSnapshot();
    return noteAuthorityKey(request.authority)===noteAuthorityKey(this.authority)&&!!lease
      &&this.requests.get(request.requestId)===lease&&this.generation===request.generation
      &&state.revision===request.revision&&state.content===request.content&&!state.dirty&&!this.isComposing();
  }
  edit=(content:string)=>this.session.edit(content);
  load=()=>this.session.load();
  flush=()=>this.composingViews.size?Promise.resolve(false):this.session.flush();
  flushForClose=()=>this.composingViews.size?Promise.resolve(false):this.session.flushForClose();
  async metadata(viewId?:string):Promise<NoteMetadata>{
    const key=viewId||'document',lease=viewId?this.viewLeases.get(viewId):undefined;
    if(viewId&&!lease)throw new NoteRuntimeError('scope-mismatch','笔记视图已关闭。');
    const runtime=this.runtimeForView(viewId),revision=this.session.getSnapshot().revision,generation=this.generation,sequence=(this.metadataSequence.get(key)||0)+1;
    this.metadataSequence.set(key,sequence);
    if(!revision)throw new NoteRuntimeError('unavailable','笔记尚未读取。');
    const snapshot=unwrapNoteResult(await runtime.metadata.read(revision));
    assertNoteAuthority(snapshot.authority,this.authority);
    if(snapshot.revision!==revision)throw new NoteRuntimeError('scope-mismatch','元数据与笔记版本不匹配。');
    if(runtime!==this.runtimeForView(viewId)||sequence!==this.metadataSequence.get(key)||(viewId&&this.viewLeases.get(viewId)!==lease)||generation!==this.generation||revision!==this.session.getSnapshot().revision)
      throw new NoteRuntimeError('stale-result','元数据请求已被新的笔记状态替代。');
    return {...validateNoteMetadata(snapshot.metadata),completeness:validateNoteMetadataCompleteness(snapshot.completeness)};
  }
  async media(references:readonly NoteAttachmentReference[],revision:string,viewId?:string):Promise<NoteMedia>{
    if(references.length>256)throw new NoteRuntimeError('invalid-result','当前笔记的附件引用超过此窗口的授权上限。');
    if(!revision||revision!==this.session.getSnapshot().revision)throw new NoteRuntimeError('stale-result','附件读取版本已变化。');
    const runtime=this.runtimeForView(viewId),lease=viewId?this.viewLeases.get(viewId):undefined;
    const grants=unwrapNoteResult(await runtime.attachments.resolve(references,revision));
    if(revision!==this.session.getSnapshot().revision||runtime!==this.runtimeForView(viewId)||(viewId&&lease!==this.viewLeases.get(viewId)))throw new NoteRuntimeError('stale-result','附件读取版本已变化。');
    return noteMediaFromGrants(runtime,grants,references);
  }
  async request(viewId:string,action:NoteParentAction):Promise<NoteActionValue>{
    validateNoteParentAction(action);
    const runtime=this.runtimeForView(viewId);
    const lease=this.viewLeases.get(viewId);
    if(!lease)throw new NoteRuntimeError('scope-mismatch','笔记视图已关闭。');
    const {content,dirty}=this.session.getSnapshot();
    let {revision}=this.session.getSnapshot();
    if(!revision&&action.kind!=='close-view')throw new NoteRuntimeError('unavailable','请先等待笔记读取完成。');
    if('selection' in action&&action.selection.end>content.length)throw new NoteRuntimeError('invalid-result','编辑范围超出当前笔记。');
    const generation=this.generation,requestId=++this.requestSequence;
    if(dirty){
      if(!await this.flush())throw new NoteRuntimeError('unavailable','当前输入尚未安全保存，请先处理保存或版本冲突。');
      if(this.generation!==generation||this.session.getSnapshot().content!==content||this.viewLeases.get(viewId)!==lease||this.runtimeForView(viewId)!==runtime)
        throw new NoteRuntimeError('stale-result','保存期间笔记或视图已变化，请重新执行操作。');
      revision=this.session.getSnapshot().revision;
    }
    this.requests.set(requestId,lease);
    try {
      const reply=await runtime.actions.request({requestId,viewId,authority:this.authority,revision,generation,content,action});
      if(runtime!==this.runtimeForView(viewId))throw new NoteRuntimeError('stale-result','笔记授权已更新，旧操作结果未应用。');
      this.assertReply(reply,{requestId,viewId,revision,generation,lease});
      const result=unwrapNoteResult(reply.result);
      if(result.kind==='replace-range'&&(!Number.isSafeInteger(result.selection.start)||!Number.isSafeInteger(result.selection.end)||result.selection.start<0||result.selection.end<result.selection.start||result.selection.end>content.length))
        throw new NoteRuntimeError('invalid-result','返回的编辑范围无效。');
      return result;
    } finally {this.requests.delete(requestId);}
  }
  private assertReply(reply:NoteActionReply,expected:{requestId:number;viewId:string;revision:string;generation:number;lease:symbol}){
    assertNoteAuthority(reply.authority,this.authority);
    if(reply.requestId!==expected.requestId||reply.viewId!==expected.viewId||reply.revision!==expected.revision||reply.generation!==expected.generation)
      throw new NoteRuntimeError('scope-mismatch','操作响应与笔记请求不匹配。');
    if(this.viewLeases.get(expected.viewId)!==expected.lease||this.requests.get(expected.requestId)!==expected.lease||this.generation!==expected.generation||this.session.getSnapshot().revision!==expected.revision)
      throw new NoteRuntimeError('stale-result','操作期间笔记或视图已变化，输入已保留。');
  }
}
export class NoteDocumentControllers {
  private owners=new Map<string,NoteDocumentController>();
  get(runtime:NoteRuntime){
    const key=noteAuthorityKey(runtime.authority);let owner=this.owners.get(key);
    if(!owner){owner=new NoteDocumentController(runtime);this.owners.set(key,owner);}
    return owner;
  }
  /** Native quit/dock/transfer must await all owners, including inactive tabs. */
  async flushAll(){return (await Promise.all([...this.owners.values()].map(owner=>owner.flushForClose()))).every(Boolean);}
  hasDirty(){return [...this.owners.values()].some(owner=>owner.session.getSnapshot().dirty);}
}
