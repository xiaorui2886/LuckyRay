import {
  assertNoteAuthority, createScopedNoteRuntime, NoteRuntimeError, validateNoteMetadata, NOTE_PRODUCTION_PARENT_ACTIONS,
  validateNoteParentAction,
  type NoteActionReply, type NoteActionRequest, type NoteAuthority, type NoteAttachmentGrant,
  type NoteAttachmentReference, type NoteMetadata, type NoteMetadataSnapshot, type NoteParentAction,
  type NoteRuntime, type NoteRuntimeResult, type NoteRuntimeSnapshot, type NoteTargetTicket,
} from '../features/notes/NoteRuntime';

/** These are the only native entry-point operations used by this adapter. The
 * Tauri caller label is supplied by the host, never by a renderer argument. */
export type NativeNoteCommand =
  | {op:'noteAuthority';viewId:string}
  | {op:'readNote';viewId:string}
  | {op:'writeNote';viewId:string;content:string;revision:string}
  | {op:'noteMetadata';viewId:string;revision:string}
  | {op:'queryNoteMetadata';viewId:string;revision:string;query:string;limit:number}
  | {op:'noteIndex';viewId:string;revision:string;cursor:string|null;limit:number}
  | {op:'noteAttachmentReferences';viewId:string;revision:string}
  | {op:'resolveAttachment';viewId:string;revision:string;destination:string;wiki:boolean};
export type NativeNoteCompleteness = {
  complete:boolean;missing:string[];truncated:boolean;truncatedFields?:string[];
  scope:'linked-and-backlinked';noteSuggestions:'linked-and-backlinked';
};
type NativeNoteMetadataSnapshot = NoteMetadataSnapshot & {completeness:NativeNoteCompleteness};
type NativeNoteSnapshot = NoteRuntimeSnapshot & {documentRef:{vaultId:string;relativePath:string}};
export type NativeNoteQuerySnapshot = {
  authority:NoteAuthority;revision:string;query:string;
  notes:Array<{id:string;title:string;snippet:string;target:NoteTargetTicket}>;
  completeness:Omit<NativeNoteCompleteness,'scope'|'noteSuggestions'> & {scope:'title-query';noteSuggestions:'title-query'};
};
export type NativeNoteIndexSnapshot={authority:NoteAuthority;revision:string;notes:NativeNoteQuerySnapshot['notes'];total:number;nextCursor:string|null;completeness:{complete:boolean;missing:string[];truncated:boolean;scope:'vault-index-page';noteSuggestions:'vault-index-page'}};
export type NativeNoteAttachmentRow={target:string;wiki:boolean;label:string;status:'resolved'|'missing'|'ungranted'|'unsupported';token?:string;mediaKind?:'image'|'audio'|'video'|'file';version?:string};
export type NativeNoteAttachmentSnapshot={authority:NoteAuthority;revision:string;references:NativeNoteAttachmentRow[];complete:boolean;missing:string[]};
export const REQUIRED_NATIVE_NOTE_ACTIONS = NOTE_PRODUCTION_PARENT_ACTIONS;
export type NativeNoteRuntimeServices = {
  command:(request:NativeNoteCommand)=>Promise<unknown>;
  /** Convert only an already-validated token using workspace-attachment. */
  mediaUrl:(token:string)=>string;
  actions?:NoteRuntime['actions'];
  /** Installed routes, not merely visible controls. Missing routes block native
   * readiness; a limited surface must never be mistaken for production parity. */
  actionCapabilities?:readonly NoteParentAction['kind'][];
};
export type NativeNoteRuntime = NoteRuntime & {
  readonly viewId:string;
  readonly readiness:()=>{complete:boolean;missing:string[]};
  readonly readinessRevision:()=>number;
  readonly subscribeReadiness:(listener:()=>void)=>()=>void;
  readonly refreshCapabilities:()=>Promise<void>;
  readonly queryNotes:(query:string,revision:string,limit?:number)=>Promise<NoteRuntimeResult<NativeNoteQuerySnapshot>>;
  readonly listNotes:(revision:string,cursor?:string|null,limit?:number)=>Promise<NoteRuntimeResult<NativeNoteIndexSnapshot>>;
  readonly listAttachments:(revision:string)=>Promise<NoteRuntimeResult<NativeNoteAttachmentSnapshot>>;
  /** The host calls this before close/rebind; pending results cannot revive it. */
  readonly dispose:()=>void;
};
const opaqueToken=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validRevision=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128;
const unsupported=(message:string):NoteRuntimeResult<never>=>({ok:false,code:'unsupported',message});
function errorResult(error:unknown):NoteRuntimeResult<never>{
  if(error instanceof NoteRuntimeError)return {ok:false,code:error.code,message:error.message};
  const message=String(error);
  const code=/provider-required|unsupported/.test(message)?'unsupported':/revision-conflict|superseded|expired/.test(message)?'stale-result':/scope-mismatch|invalid-owner|not-granted/.test(message)?'scope-mismatch':'unavailable';
  return {ok:false,code,message};
}
function validateAuthority(value:NoteAuthority):NoteAuthority{
  if(!value||typeof value.vaultId!=='string'||!value.vaultId||typeof value.documentId!=='string'||!/^kdoc-(?:[a-f0-9]{2})+$/.test(value.documentId)
    ||typeof value.sourceId!=='string'||!/^note-source-v1:[a-f0-9]{64}$/.test(value.sourceId))throw new NoteRuntimeError('scope-mismatch','原生笔记授权无效。');
  return Object.freeze({...value});
}
/** No Knowledge service import: that production module contains global source
 * mutation helpers. The only identity computation here mirrors its pure codec. */
export function nativeNoteDocumentId(reference:{vaultId:string;relativePath:string}):string{
  if(!reference||typeof reference.vaultId!=='string'||!reference.vaultId||typeof reference.relativePath!=='string'
    ||!reference.relativePath.toLowerCase().endsWith('.md')||/[\\:\0\r\n]/.test(reference.relativePath)
    ||reference.relativePath.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.luckyray'))throw new NoteRuntimeError('scope-mismatch','笔记引用无效。');
  const bytes=new TextEncoder().encode(JSON.stringify({vaultId:reference.vaultId,relativePath:reference.relativePath}));
  return `kdoc-${Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('')}`;
}
function requireCompleteness(value:NativeNoteCompleteness){
  if(!value||value.scope!=='linked-and-backlinked'||value.noteSuggestions!=='linked-and-backlinked'
    ||typeof value.complete!=='boolean'||typeof value.truncated!=='boolean'||!Array.isArray(value.missing)
    ||value.missing.some(item=>typeof item!=='string'))throw new NoteRuntimeError('invalid-result','笔记元数据缺少范围说明。');
  if(!value.complete||value.truncated||value.missing.length)throw new NoteRuntimeError('unsupported',`当前笔记元数据尚不完整：${[...value.missing,...(value.truncatedFields||[])].join('、')||'范围已截断'}`);
}

function validateNativeMetadata(value:NoteMetadata,authority:NoteAuthority):NoteMetadata{
  const result=validateNoteMetadata(value);
  const validateTarget=(target:NoteTargetTicket)=>{
    if(!opaqueToken(target.ticket)||typeof target.title!=='string'||!/^kdoc-(?:[a-f0-9]{2})+$/.test(target.documentId))throw new NoteRuntimeError('invalid-result','笔记目标未获得原生授权。');
    try{
      const hex=target.documentId.slice(5),bytes=new Uint8Array(hex.length/2);
      for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);
      const reference=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as {vaultId:string;relativePath:string};
      if(reference.vaultId!==authority.vaultId||nativeNoteDocumentId(reference)!==target.documentId)throw Error('scope');
    }catch{throw new NoteRuntimeError('scope-mismatch','笔记目标属于其他来源。');}
  };
  for(const note of result.notes)validateTarget(note.target);
  for(const backlink of result.backlinks)validateTarget(backlink.target);
  for(const embed of result.noteEmbeds||[])validateTarget(embed.note);
  for(const tag of result.tags){
    const expected=`real-vault-tag:${encodeURIComponent(authority.vaultId)}:${encodeURIComponent(tag.name.trim().normalize('NFC').toLowerCase())}`;
    if(!opaqueToken(tag.ticket)||tag.id!==expected)throw new NoteRuntimeError('invalid-result','标签目标未获得原生授权。');
  }
  if(result.documentTags.some(id=>!result.tags.some(tag=>tag.id===id)))throw new NoteRuntimeError('invalid-result','当前标签缺少原生授权。');
  return result;
}

/** Call only with authority from noteAuthority, never a persisted layout epoch.
 * Documents reuse readNote/writeNote's exact-note CAS. No Main/bridge fallback. */
export function createNativeNoteRuntime(viewId:string,authority:NoteAuthority,services:NativeNoteRuntimeServices):NativeNoteRuntime{
  if(!viewId||viewId.length>128||/[\0\r\n]/.test(viewId))throw new NoteRuntimeError('scope-mismatch','笔记视图无效。');
  const identity=validateAuthority(authority);
  const parentActions=services.actions;
  const actionCapabilities=()=>parentActions?.subscribeCapabilities?parentActions.capabilities||[]:services.actionCapabilities||parentActions?.capabilities||[];
  const transport=services.command,convertMedia=services.mediaUrl;
  let active=true,epoch=0;
  let readinessRevision=0;const readinessListeners=new Set<()=>void>();
  const changed=()=>{readinessRevision++;for(const listener of readinessListeners)listener();};
  const stopCapabilities=parentActions?.subscribeCapabilities?.(changed);
  const checkLive=(expected=epoch)=>{if(!active||expected!==epoch)throw new NoteRuntimeError('stale-result','笔记视图已关闭或重新绑定。');};
  const command=async<T>(request:NativeNoteCommand):Promise<T>=>{checkLive();const generation=epoch;const value=await transport(request);checkLive(generation);return value as T;};
  const readiness=()=>{
    const capabilities=new Set(actionCapabilities());
    const missing=REQUIRED_NATIVE_NOTE_ACTIONS.filter(kind=>!parentActions||!capabilities.has(kind)).map(kind=>`parent-action:${kind}`);
    return {complete:active&&missing.length===0,missing:active?missing:['view-closed',...missing]};
  };
  const checkSnapshot=(snapshot:NativeNoteSnapshot):NoteRuntimeSnapshot=>{
    assertNoteAuthority(snapshot?.authority,identity);
    if(nativeNoteDocumentId(snapshot.documentRef)!==identity.documentId||snapshot.documentRef.vaultId!==identity.vaultId)throw new NoteRuntimeError('scope-mismatch','返回了未经授权的笔记。');
    if(!validRevision(snapshot.revision)||typeof snapshot.content!=='string')throw new NoteRuntimeError('invalid-result','笔记响应缺少已提交版本。');
    return {authority:identity,revision:snapshot.revision,content:snapshot.content,title:snapshot.title};
  };
  const resolve=async(references:readonly NoteAttachmentReference[],revision:string):Promise<NoteRuntimeResult<NoteAttachmentGrant[]>>=>{
    try{
      checkLive();
      if(!validRevision(revision)||references.length>256)throw new NoteRuntimeError('invalid-result','附件请求必须携带已提交版本并限制引用数量。');
      const unique=new Map<string,NoteAttachmentReference>();
      for(const reference of references){
        if(typeof reference.target!=='string'||!reference.target||reference.target.length>8192||/[\0\r\n]/.test(reference.target)||typeof reference.wiki!=='boolean')throw new NoteRuntimeError('invalid-result','附件引用无效。');
        const key=JSON.stringify([reference.target,reference.wiki]);
        if(unique.has(key))throw new NoteRuntimeError('invalid-result','附件请求包含重复引用。');
        unique.set(key,reference);
      }
      const grants:NoteAttachmentGrant[]=[];
      // Bounded sequential issuance avoids flooding the capability registry.
      for(const reference of unique.values()){
        const result=await command<{status:string;token:string;version:string;mediaKind:NoteAttachmentGrant['mediaKind']}>({op:'resolveAttachment',viewId,revision,destination:reference.target,wiki:reference.wiki});
        if(result.status!=='resolved'||!opaqueToken(result.token)||!result.version||!['image','audio','video','file'].includes(result.mediaKind))throw new NoteRuntimeError('invalid-result','附件服务未返回受限媒体授权。');
        grants.push({...reference,token:result.token,version:result.version,mediaKind:result.mediaKind});
      }
      return {ok:true,value:grants};
    }catch(error){return errorResult(error);}
  };
  const subscribeReadiness=(listener:()=>void)=>{readinessListeners.add(listener);return()=>{readinessListeners.delete(listener);};};
  const refreshCapabilities=async()=>{
    checkLive();
    const before=[...actionCapabilities()].sort().join('\0'),observed=readinessRevision;
    await parentActions?.refreshCapabilities?.();checkLive();
    // A subscribed provider publishes revocation/expiry itself. Do not emit a
    // second invalidation for an identical lease extension. Legacy providers
    // without notifications still publish actual effective capability changes.
    if(readinessRevision===observed&&before!==[...actionCapabilities()].sort().join('\0'))changed();
  };
  const actions={get capabilities(){return active&&parentActions?actionCapabilities():[];},subscribeCapabilities:subscribeReadiness,refreshCapabilities:async()=>{await refreshCapabilities();return actionCapabilities();},request:async(request:NoteActionRequest):Promise<NoteActionReply>=>{
    const reply=(result:NoteActionReply['result']):NoteActionReply=>({requestId:request.requestId,viewId:request.viewId,authority:request.authority,revision:request.revision,generation:request.generation,result});
    try{
      checkLive();assertNoteAuthority(request.authority,identity);validateNoteParentAction(request.action);
      if(request.viewId!==viewId||!validRevision(request.revision)||!Number.isSafeInteger(request.requestId)||request.requestId<1||!Number.isSafeInteger(request.generation)||request.generation<0)throw new NoteRuntimeError('scope-mismatch','笔记操作与当前视图不匹配。');
      if(!parentActions||!actionCapabilities().includes(request.action.kind))return reply(unsupported('此笔记操作尚未接入经过验证的主窗口服务。'));
      const generation=epoch,value=await parentActions.request(request);checkLive(generation);
      assertNoteAuthority(value.authority,identity);
      if(value.viewId!==viewId||value.requestId!==request.requestId||value.revision!==request.revision||value.generation!==request.generation)throw new NoteRuntimeError('scope-mismatch','笔记操作响应已过期。');
      return value;
    }catch(error){return reply(errorResult(error));}
  }};
  const runtime=createScopedNoteRuntime(identity,{
    documents:{
      read:async()=>checkSnapshot(await command<NativeNoteSnapshot>({op:'readNote',viewId})),
      write:async(content,revision)=>{
        if(!validRevision(revision))throw new NoteRuntimeError('invalid-result','保存必须携带已提交版本。');
        return checkSnapshot(await command<NativeNoteSnapshot>({op:'writeNote',viewId,content,revision}));
      },
    },
    metadata:{read:async(revision)=>{
      try{
        checkLive();
        if(!validRevision(revision))throw new NoteRuntimeError('invalid-result','元数据请求缺少版本。');
        const routes=readiness();
        if(!routes.complete)return unsupported(`原生笔记服务尚未完整接入：${routes.missing.join('、')}`);
        const snapshot=await command<NativeNoteMetadataSnapshot>({op:'noteMetadata',viewId,revision});
        assertNoteAuthority(snapshot.authority,identity);
        if(snapshot.revision!==revision)throw new NoteRuntimeError('stale-result','笔记元数据版本已变化。');
        requireCompleteness(snapshot.completeness);
        return {ok:true,value:{authority:identity,revision,metadata:validateNativeMetadata(snapshot.metadata,identity),completeness:snapshot.completeness}};
      }catch(error){return errorResult(error);}
    }},
    attachments:{resolve,mediaUrl:token=>{
      checkLive();if(!opaqueToken(token))throw new NoteRuntimeError('invalid-result','附件授权无效。');
      const url=convertMedia(token);
      if(!/^((workspace-attachment:\/\/localhost\/)|(https?:\/\/workspace-attachment\.localhost\/))[a-f0-9]{64}$/.test(url)||!url.endsWith(`/${token}`))throw new NoteRuntimeError('invalid-result','附件不能回退到文件路径。');
      return url;
    }},actions,
  });
  return Object.freeze({...runtime,viewId,readiness,readinessRevision:()=>readinessRevision,subscribeReadiness,refreshCapabilities,dispose:()=>{active=false;epoch++;stopCapabilities?.();changed();readinessListeners.clear();},listNotes:async(revision:string,cursor:string|null=null,limit=64):Promise<NoteRuntimeResult<NativeNoteIndexSnapshot>>=>{
    try{
      if(!validRevision(revision)||!Number.isInteger(limit)||limit<1||limit>64||(cursor!==null&&(!opaqueToken(cursor))))throw new NoteRuntimeError('invalid-result','笔记索引分页参数无效。');
      const result=await command<NativeNoteIndexSnapshot>({op:'noteIndex',viewId,revision,cursor,limit});
      assertNoteAuthority(result.authority,identity);
      if(result.revision!==revision)throw new NoteRuntimeError('stale-result','笔记索引版本已变化。');
      if(!result.completeness||result.completeness.scope!=='vault-index-page'||result.completeness.noteSuggestions!=='vault-index-page'||result.completeness.complete!==true||result.completeness.truncated!==false||!Array.isArray(result.completeness.missing)||result.completeness.missing.length||!Array.isArray(result.notes)||result.notes.length>limit||!Number.isSafeInteger(result.total)||result.total<result.notes.length||result.total>100000||(result.nextCursor!==null&&!opaqueToken(result.nextCursor)))throw new NoteRuntimeError('invalid-result','笔记索引未返回完整的授权分页。');
      const notes=validateNativeMetadata({notes:result.notes,tags:[],links:[],backlinks:[],documentTags:[],favorite:false},identity).notes.map(note=>({...note,snippet:note.snippet||''}));
      return {ok:true,value:{authority:identity,revision,notes,total:result.total,nextCursor:result.nextCursor,completeness:{complete:true,missing:[],truncated:false,scope:'vault-index-page',noteSuggestions:'vault-index-page'}}};
    }catch(error){return errorResult(error);}
  },listAttachments:async(revision:string):Promise<NoteRuntimeResult<NativeNoteAttachmentSnapshot>>=>{
    try{
      if(!validRevision(revision))throw new NoteRuntimeError('invalid-result','附件列表缺少已保存版本。');
      const result=await command<NativeNoteAttachmentSnapshot>({op:'noteAttachmentReferences',viewId,revision});assertNoteAuthority(result.authority,identity);
      if(result.revision!==revision)throw new NoteRuntimeError('stale-result','附件列表版本已变化。');
      if(typeof result.complete!=='boolean'||!Array.isArray(result.missing)||result.missing.length>16||result.missing.some(item=>typeof item!=='string'||item.length>128)||!Array.isArray(result.references)||result.references.length>256)throw new NoteRuntimeError('invalid-result','附件列表超出范围。');
      const references:NativeNoteAttachmentRow[]=[],seen=new Set<string>();
      for(const item of result.references){
        const key=JSON.stringify([item.target,item.wiki]);
        if(typeof item.target!=='string'||!item.target||item.target.length>8192||typeof item.wiki!=='boolean'||typeof item.label!=='string'||item.label.length>1024||!['resolved','missing','ungranted','unsupported'].includes(item.status)||(item.token!==undefined&&!opaqueToken(item.token))||(item.status==='resolved'&&!item.token)||(item.mediaKind!==undefined&&!['image','audio','video','file'].includes(item.mediaKind))||(item.version!==undefined&&(typeof item.version!=='string'||item.version.length>256))||seen.has(key))throw new NoteRuntimeError('invalid-result','附件列表包含未经验证的目标。');
        seen.add(key);references.push({target:item.target,wiki:item.wiki,label:item.label,status:item.status,...(item.token?{token:item.token}:{}),...(item.mediaKind?{mediaKind:item.mediaKind}:{}),...(item.version?{version:item.version}:{})});
      }
      return {ok:true,value:{authority:identity,revision,references,complete:result.complete&&result.missing.length===0,missing:[...result.missing]}};
    }catch(error){return errorResult(error);}
  },queryNotes:async(query:string,revision:string,limit=32):Promise<NoteRuntimeResult<NativeNoteQuerySnapshot>>=>{
    try{
      if(!validRevision(revision)||!query.trim()||Array.from(query).length>120||/[\0\r\n]/.test(query)||!Number.isInteger(limit)||limit<1||limit>64)throw new NoteRuntimeError('invalid-result','笔记查询超出允许范围。');
      const result=await command<NativeNoteQuerySnapshot>({op:'queryNoteMetadata',viewId,revision,query,limit});
      assertNoteAuthority(result.authority,identity);
      if(result.revision!==revision||result.query!==query)throw new NoteRuntimeError('stale-result','笔记查询响应已过期。');
      if(!result.completeness||result.completeness.scope!=='title-query'||result.completeness.noteSuggestions!=='title-query'||!Array.isArray(result.completeness.missing)||result.completeness.missing.length||typeof result.completeness.complete!=='boolean'||typeof result.completeness.truncated!=='boolean'||result.completeness.complete===result.completeness.truncated)throw new NoteRuntimeError('unsupported','笔记查询索引尚不完整。');
      if(!Array.isArray(result.notes)||result.notes.length>limit||result.notes.some(note=>!opaqueToken(note.target?.ticket)||note.id!==note.target.documentId||typeof note.title!=='string'||typeof note.snippet!=='string'||Array.from(note.snippet).length>240))throw new NoteRuntimeError('invalid-result','笔记查询返回了未经授权的目标。');
      const notes=validateNativeMetadata({notes:result.notes,tags:[],backlinks:[],links:[],documentTags:[],favorite:false},identity).notes.map(note=>({...note,snippet:note.snippet||''}));
      return {ok:true,value:{authority:identity,revision,query,completeness:result.completeness,notes}};
    }catch(error){return errorResult(error);}
  }});
}
export async function loadNativeNoteRuntime(viewId:string,services:NativeNoteRuntimeServices):Promise<NativeNoteRuntime>{
  const authority=await services.command({op:'noteAuthority',viewId}) as NoteAuthority;
  return createNativeNoteRuntime(viewId,authority,services);
}
