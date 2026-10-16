import type {DocumentSnapshot} from '../../workspace/documentSession';
import type {AiWriteAction, EditorRange} from '../../core/services/editor';
import type {LiveAsset, LiveNote, LiveNoteEmbed, LiveNoteLink, LiveNoteOpenOptions, LiveTag} from './editor/types';

/** sourceId is the backend-issued vault incarnation, not a display name/path.
 * documentId is the real document identity, never a workspace view id. */
export type NoteAuthority = Readonly<{vaultId:string; sourceId:string; documentId:string}>;
export type NoteRuntimeErrorCode = 'unsupported'|'scope-mismatch'|'stale-result'|'invalid-result'|'unavailable';
export class NoteRuntimeError extends Error {
  readonly code:NoteRuntimeErrorCode;
  constructor(code:NoteRuntimeErrorCode,message:string){super(message);this.name='NoteRuntimeError';this.code=code;}
}
export type NoteRuntimeResult<T> = {ok:true;value:T}|{ok:false;code:NoteRuntimeErrorCode;message:string};
export type NoteRuntimeSnapshot = DocumentSnapshot & {authority:NoteAuthority};
export type NoteTargetTicket = Readonly<{ticket:string;documentId:string;title:string}>;
export type NoteMetadataCompleteness = {
  complete:boolean;missing:string[];truncated:boolean;
  scope:'linked-and-backlinked';noteSuggestions:'linked-and-backlinked';
};
export type NoteMetadata = {
  completeness?:NoteMetadataCompleteness;
  notes: Array<Pick<LiveNote,'id'|'title'|'snippet'> & {target:NoteTargetTicket}>;
  tags: Array<LiveTag & {ticket:string}>;
  links:LiveNoteLink[];
  backlinks:Array<{target:NoteTargetTicket;snippet:string}>;
  documentTags:string[];
  favorite:boolean;
  noteEmbeds?:Array<{target:string;wiki:boolean;note:NoteTargetTicket}>;
};
export type NoteMetadataSnapshot = {authority:NoteAuthority;revision:string;metadata:NoteMetadata;completeness:NoteMetadataCompleteness};
export type NoteAttachmentReference = Readonly<{target:string;wiki:boolean}>;
export type NoteAttachmentGrant = {
  target:string; wiki:boolean; token:string; version:string; mediaKind:'image'|'audio'|'video'|'file';
};
export type NoteMedia = {assets:LiveAsset[];embeds:LiveNoteEmbed[];bindings?:Array<{reference:NoteAttachmentReference;assetId:string;version:string;token:string}>};
/** All cross-document/global effects are parent-mediated, with finite typed
 * payloads. No arbitrary command, path, SQL, bridge or filesystem escape hatch. */
export type NoteParentAction =
 | {kind:'rename-document';title:string}
 | {kind:'open-note';target:NoteTargetTicket;options?:LiveNoteOpenOptions;newTab?:boolean}
 | {kind:'create-note';title:string;options?:LiveNoteOpenOptions}
 | {kind:'browse-documents';section?:'vaults'|'settings'|'folders'|'attachments'}
 | {kind:'browse-attachments'}
 | {kind:'set-favorite';favorite:boolean}
 | {kind:'edit-document-tags'}
 | {kind:'remove-document-tag';tagId:string}
 | {kind:'apply-document-tags';names:string[];mode?:'replace'|'merge'}
 | {kind:'open-tag';tagId:string;ticket:string}
 | {kind:'create-tag';name:string}
 | {kind:'rename-tag';tagId:string;ticket:string;name:string}
 | {kind:'open-attachment';token:string}
 | {kind:'open-external';url:string}
 | {kind:'ask-ai'}
 | {kind:'suggest-ai'}
 | {kind:'write-ai';action:AiWriteAction;selection:EditorRange}
 | {kind:'insert-attachment';selection:EditorRange}
 | {kind:'insert-files';files:File[];selection:EditorRange}
 | {kind:'insert-clipboard-image';source:{kind:'data-url'|'remote-url';value:string};selection:EditorRange}
 | {kind:'insert-existing-attachment';assetId:string;selection:EditorRange}
 | {kind:'export-document';format:'markdown'|'pdf'}
 | {kind:'import-document'}
 | {kind:'close-view'};
export type NoteParentActionKind=NoteParentAction['kind'];
const productionParentActions:Record<NoteParentActionKind,true>={
  'rename-document':true,'open-note':true,'create-note':true,'browse-documents':true,'browse-attachments':true,
  'set-favorite':true,'edit-document-tags':true,'remove-document-tag':true,'apply-document-tags':true,
  'open-tag':true,'create-tag':true,'rename-tag':true,'open-attachment':true,'open-external':true,
  'ask-ai':true,'suggest-ai':true,'write-ai':true,'insert-attachment':true,'insert-files':true,
  'insert-clipboard-image':true,'insert-existing-attachment':true,'export-document':true,'import-document':true,'close-view':true,
};
export const NOTE_PRODUCTION_PARENT_ACTIONS:readonly NoteParentActionKind[]=Object.freeze(Object.keys(productionParentActions) as NoteParentActionKind[]);
export function noteRuntimeMissingActions(runtime:NoteRuntime):NoteParentActionKind[]{
  const installed=new Set(runtime.actions.capabilities||[]);
  return NOTE_PRODUCTION_PARENT_ACTIONS.filter(kind=>!installed.has(kind));
}
export type NoteActionRequest = Readonly<{
  requestId:number; viewId:string; authority:NoteAuthority; revision:string; generation:number;
  content:string; action:NoteParentAction;
}>;
/** A replacement is a proposed local editor transaction, not a second writer.
 * Only the exact revision/generation that requested it may apply it. */
export type NoteActionValue =
 | {kind:'acknowledged';message?:string}
 | {kind:'suggestion';summary?:string;tags:string[]}
 | {kind:'replace-range';selection:EditorRange;text:string}
 | {kind:'saved';snapshot:NoteRuntimeSnapshot;message?:string}
 | {kind:'renamed';title:string;documentId:string;authority?:NoteAuthority;snapshot?:NoteRuntimeSnapshot;viewGrant?:{id:string;kind:string;libraryId:string;resourceId?:string;title:string}};
export function validateNoteParentAction(action:NoteParentAction){
  if(action.kind==='open-external'&&!/^https?:\/\//i.test(action.url))throw new NoteRuntimeError('invalid-result','只能打开明确的 HTTP 或 HTTPS 链接。');
  if(action.kind==='open-attachment'&&!/^[a-f0-9]{64}$/.test(action.token))throw new NoteRuntimeError('invalid-result','附件授权无效。');
  if(action.kind==='open-note'&&(!action.target.ticket||!action.target.documentId))throw new NoteRuntimeError('invalid-result','笔记目标未验证。');
  if((action.kind==='open-tag'||action.kind==='rename-tag')&&(!action.tagId||!action.ticket))throw new NoteRuntimeError('invalid-result','标签目标未验证。');
  if('selection' in action&&(!Number.isSafeInteger(action.selection.start)||!Number.isSafeInteger(action.selection.end)||action.selection.start<0||action.selection.end<action.selection.start))throw new NoteRuntimeError('invalid-result','编辑范围无效。');
}
export type NoteActionReply = {
  requestId:number;viewId:string;authority:NoteAuthority;revision:string;generation:number;
  result:NoteRuntimeResult<NoteActionValue>;
};
export interface NoteRuntime {
  readonly kind:'main'|'scoped';
  readonly authority:NoteAuthority;
  readonly documents:{read:()=>Promise<NoteRuntimeSnapshot>;write:(content:string,revision:string)=>Promise<NoteRuntimeSnapshot>};
  readonly metadata:{read:(revision:string)=>Promise<NoteRuntimeResult<NoteMetadataSnapshot>>};
  readonly attachments:{resolve:(references:readonly NoteAttachmentReference[],revision:string)=>Promise<NoteRuntimeResult<NoteAttachmentGrant[]>>;mediaUrl:(token:string)=>string};
  readonly actions:{capabilities?:readonly NoteParentActionKind[];subscribeCapabilities?:(listener:()=>void)=>()=>void;refreshCapabilities?:()=>Promise<readonly NoteParentActionKind[]>;request:(request:NoteActionRequest)=>Promise<NoteActionReply>};
}
export const noteAuthorityKey=(authority:NoteAuthority)=>JSON.stringify([authority.sourceId,authority.vaultId,authority.documentId]);
export function assertNoteAuthority(actual:NoteAuthority,expected:NoteAuthority){
  if(!actual||noteAuthorityKey(actual)!==noteAuthorityKey(expected))throw new NoteRuntimeError('scope-mismatch','笔记来源已变化，请重新打开。');
}
export function unwrapNoteResult<T>(result:NoteRuntimeResult<T>):T{
  if(!result.ok)throw new NoteRuntimeError(result.code,result.message);return result.value;
}
export function validateNoteMetadataCompleteness(value:NoteMetadataCompleteness):NoteMetadataCompleteness{
  if(!value||typeof value.complete!=='boolean'||typeof value.truncated!=='boolean'||value.scope!=='linked-and-backlinked'||value.noteSuggestions!=='linked-and-backlinked'||!Array.isArray(value.missing)||value.missing.length>16||value.missing.some(item=>typeof item!=='string'||item.length>128))
    throw new NoteRuntimeError('invalid-result','笔记元数据范围说明无效。');
  return {complete:value.complete&&value.missing.length===0&&!value.truncated,missing:[...value.missing],truncated:value.truncated,scope:value.scope,noteSuggestions:value.noteSuggestions};
}
export function validateNoteMetadata(value:NoteMetadata):NoteMetadata{
  if(value.notes.length>256||value.tags.length>256||value.backlinks.length>128||value.links.length>512||value.documentTags.length>256||(value.noteEmbeds?.length||0)>256)
    throw new NoteRuntimeError('invalid-result','笔记元数据超出授权范围。');
  return {
    notes:value.notes.map(note=>{
      if(!note.target?.ticket||note.target.documentId!==note.id)throw new NoteRuntimeError('invalid-result','笔记目标未验证。');
      return {id:note.id,title:note.title,snippet:(note.snippet||'').slice(0,240),target:{ticket:note.target.ticket,documentId:note.target.documentId,title:note.target.title}};
    }),
    tags:value.tags.map(tag=>{
      if(!tag.ticket)throw new NoteRuntimeError('invalid-result','标签目标未验证。');
      return {id:tag.id,name:tag.name,ticket:tag.ticket,noteCount:tag.noteCount,assetCount:tag.assetCount};
    }),
    backlinks:value.backlinks.map(link=>{
      if(!link.target?.ticket)throw new NoteRuntimeError('invalid-result','反向链接目标未验证。');
      return {target:{ticket:link.target.ticket,documentId:link.target.documentId,title:link.target.title},snippet:link.snippet.slice(0,240)};
    }),
    links:value.links.map(link=>({targetTitle:link.targetTitle,toNoteId:link.toNoteId,isMissing:link.isMissing})),
    documentTags:[...value.documentTags],favorite:value.favorite===true,
    ...(value.noteEmbeds?{noteEmbeds:value.noteEmbeds.map(embed=>{
      if(typeof embed.target!=='string'||!embed.target||embed.target.length>8192||embed.wiki!==true||!embed.note?.ticket||!embed.note.documentId||typeof embed.note.title!=='string')throw new NoteRuntimeError('invalid-result','内嵌笔记目标未验证。');
      return {target:embed.target,wiki:embed.wiki,note:{ticket:embed.note.ticket,documentId:embed.note.documentId,title:embed.note.title}};
    })}:{}),
  };
}
/** Match production's document-chip rendering for ![[note]]. An embed does
 * not grant a note body, attachment URL, or filesystem opener. */
export function noteMediaWithEmbeddedNotes(media:NoteMedia,metadata:NoteMetadata):NoteMedia{
 const assets=new Map(media.assets.map(asset=>[asset.id,asset])),embeds=[...media.embeds];
 for(const embed of metadata.noteEmbeds||[]){const id=`note-embed:${embed.note.documentId}`;assets.set(id,{id,name:embed.note.title,kind:'document'});embeds.push({targetName:embed.target,assetId:id,isMissing:0,resolutionStatus:'resolved'});}
 return {...media,assets:[...assets.values()],embeds};
}
/** Scoped rendering accepts only opaque baseline-authorized capabilities. */
export function noteMediaFromGrants(runtime:NoteRuntime,grants:readonly NoteAttachmentGrant[],references:readonly NoteAttachmentReference[]):NoteMedia{
  const permitted=new Set(references.map(ref=>JSON.stringify([ref.target,ref.wiki])));
  const assets:LiveAsset[]=[],embeds:LiveNoteEmbed[]=[],bindings:NonNullable<NoteMedia['bindings']>=[];
  if(grants.length!==references.length||grants.length>256||permitted.size!==references.length)throw new NoteRuntimeError('invalid-result','附件响应未完整覆盖当前笔记的请求。');
  for(const grant of grants){
    if(!permitted.has(JSON.stringify([grant.target,grant.wiki]))||!(/^[a-f0-9]{64}$/).test(grant.token)||!['image','audio','video','file'].includes(grant.mediaKind))
      throw new NoteRuntimeError('invalid-result','附件授权无效。');
    if(grant.mediaKind==='file'&&/\.(?:md|markdown)$/i.test(grant.target.split(/[?#|]/)[0]))throw new NoteRuntimeError('unsupported','内嵌笔记需要独立的文档引用服务。');
    permitted.delete(JSON.stringify([grant.target,grant.wiki]));
    const source=grant.mediaKind==='file'?undefined:runtime.attachments.mediaUrl(grant.token);
    if(runtime.kind==='scoped'&&source!==undefined&&!/^((workspace-attachment:\/\/localhost\/)|(https?:\/\/workspace-attachment\.localhost\/))[a-f0-9]{64}$/.test(source))
      throw new NoteRuntimeError('invalid-result','附件不是受限媒体地址。');
    const id=`note-attachment:${JSON.stringify([grant.target,grant.wiki])}`;
    assets.push({id,name:grant.target,kind:grant.mediaKind==='file'?'document':grant.mediaKind,previewUrl:source,thumbnailUrl:grant.mediaKind==='image'?source:undefined});
    embeds.push({targetName:grant.wiki?grant.target:`md:${grant.target}`,assetId:id,isMissing:0});
    bindings.push({reference:{target:grant.target,wiki:grant.wiki},assetId:id,version:grant.version,token:grant.token});
  }
  return {assets,embeds,bindings};
}
export type ScopedNoteRuntimeServices = Omit<NoteRuntime,'kind'|'authority'|'metadata'|'actions'> & {
  metadata?:NoteRuntime['metadata']; actions?:NoteRuntime['actions'];
};
/** Absence never falls through to Main's singleton services. */
export function createScopedNoteRuntime(authority:NoteAuthority,services:ScopedNoteRuntimeServices):NoteRuntime{
  if(!authority.vaultId||!authority.sourceId||!authority.documentId)throw new NoteRuntimeError('scope-mismatch','需要明确的笔记授权。');
  const identity=Object.freeze({...authority});
  const unsupported={ok:false as const,code:'unsupported' as const,message:'此操作需要主窗口为当前笔记提供授权。'};
  const check=async(result:Promise<NoteRuntimeSnapshot>)=>{
    const snapshot=await result;assertNoteAuthority(snapshot.authority,identity);
    if(!snapshot.revision||typeof snapshot.content!=='string')throw new NoteRuntimeError('invalid-result','笔记版本无效。');
    return snapshot;
  };
  return Object.freeze({kind:'scoped' as const,authority:identity,
    documents:{read:()=>check(services.documents.read()),write:(content:string,revision:string)=>{
      if(!revision)return Promise.reject(new NoteRuntimeError('invalid-result','保存必须携带原始版本。'));
      return check(services.documents.write(content,revision)).then(snapshot=>{
        if(snapshot.content!==content)throw new NoteRuntimeError('invalid-result','保存响应与提交正文不匹配。');
        return snapshot;
      });
    }},
    metadata:services.metadata||{read:async()=>unsupported},
    attachments:services.attachments,
    actions:services.actions||{request:async(request:NoteActionRequest)=>({...request,result:unsupported})},
  });
}
