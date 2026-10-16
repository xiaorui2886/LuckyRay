import {
 assertNoteAuthority, NOTE_PRODUCTION_PARENT_ACTIONS, NoteRuntimeError, validateNoteParentAction,
 type NoteActionReply,type NoteActionRequest,type NoteActionValue,type NoteAuthority,type NoteParentAction,type NoteParentActionKind,type NoteRuntime,
} from '../features/notes/NoteRuntime';
import {nativeNoteDocumentId} from './nativeNoteRuntime';

export type NativeNoteFile={name:string;mimeType:string;bytes:number[]};
export type NativeNoteAction=Exclude<NoteParentAction,{kind:'insert-files'}>|{kind:'insert-files';files:NativeNoteFile[];selection:{start:number;end:number}};
export type NativeNoteActionCommand=
 | {op:'noteAction';viewId:string;authority:NoteAuthority;requestId:number;revision:string;generation:number;content:string;action:NativeNoteAction}
 | {op:'noteActionStatus';viewId:string;authority:NoteAuthority;requestId:number;revision:string;generation:number;id:string}
 | {op:'noteActionCapabilities';viewId:string};
export type NativeNoteActionStatus=
 | {state:'pending';id:string;requestId:number;viewId:string;revision:string;generation:number}
 | {state:'completed';result:NoteActionReply['result']};
export type NativeNoteActionServices={
 viewId:string;authority:NoteAuthority;command:<T>(request:NativeNoteActionCommand)=>Promise<T>;
 /** The actual live host/controller check, including lease, content and edit generation. */
 isCurrent:(request:NoteActionRequest)=>boolean;
 /** Installed backend routes returned by noteActionCapabilities, never a hardcoded parity claim. */
 capabilities:readonly NoteParentActionKind[];
 capabilityLeaseMs?:number;
 showPanel?:(panel:'index'|'attachments'|'tags',request:NoteActionRequest)=>void|Promise<void>;
 closeView?:(request:NoteActionRequest)=>void|Promise<void>;
 promptTitle?:(request:NoteActionRequest)=>string|null|Promise<string|null>;
 /** Freeze every duplicate view of the captured controller until commit/review
  * finishes. This complements the backend guard at the effect boundary. */
 freezeForAction?:(request:NoteActionRequest)=>Promise<()=>void>;
 wait?:(milliseconds:number)=>Promise<void>;
};
const localPanels={'browse-documents':'index','browse-attachments':'attachments','edit-document-tags':'tags'} as const;
const errorResult=(error:unknown):NoteActionReply['result']=>({ok:false,
 code:error instanceof NoteRuntimeError?error.code:/revision|expired|superseded|source-changed/.test(String(error))?'stale-result':/scope|not-granted|invalid-owner/.test(String(error))?'scope-mismatch':/unsupported|provider-required/.test(String(error))?'unsupported':'unavailable',
 message:error instanceof Error?error.message:String(error)});
const invalid=(message:string):never=>{throw new NoteRuntimeError('invalid-result',message);};
const MAX_FILE_BYTES=16*1024*1024,MAX_TOTAL_BYTES=32*1024*1024;

/** File payloads come only from an actual drop/picker. No path/property copied
 * from a renderer can become filesystem authority. */
export async function serializeNativeNoteAction(action:NoteParentAction):Promise<NativeNoteAction>{
 validateNoteParentAction(action);
 if(action.kind!=='insert-files')return action;
 if(!Array.isArray(action.files)||action.files.length<1||action.files.length>16)invalid('一次可插入 1–16 个文件。');
 let total=0;const files:NativeNoteFile[]=[];
 for(const file of action.files){
  if(typeof File==='undefined'||!(file instanceof File)||!file.name||file.name.length>255||/[\\/\0\r\n]/.test(file.name)||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE_BYTES)invalid('文件必须由文件选择器或拖放提供，每个文件不得超过 16 MB。');
  total+=file.size;if(total>MAX_TOTAL_BYTES)invalid('一次插入的文件总大小不得超过 32 MB。');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size)invalid('读取文件时大小发生变化。');
  files.push({name:file.name,mimeType:file.type.slice(0,128),bytes:Array.from(bytes)});
 }
 return {kind:action.kind,selection:{...action.selection},files};
}

export function validateNativeNoteActionValue(value:NoteActionValue,request:NoteActionRequest):NoteActionValue{
 if(!value||typeof value!=='object')invalid('操作没有返回有效结果。');
 switch(value.kind){
  case 'acknowledged':if(value.message!==undefined&&typeof value.message!=='string')invalid('操作说明无效。');break;
  case 'suggestion':if(request.action.kind!=='suggest-ai'||!Array.isArray(value.tags)||value.tags.length>32||value.tags.some(tag=>typeof tag!=='string'||tag.length>120)||(value.summary!==undefined&&(typeof value.summary!=='string'||value.summary.length>4000)))invalid('AI 标签建议无效。');break;
  case 'replace-range':if(!value.selection||!Number.isSafeInteger(value.selection.start)||!Number.isSafeInteger(value.selection.end)||value.selection.start<0||value.selection.end<value.selection.start||value.selection.end>request.content.length||typeof value.text!=='string'||new TextEncoder().encode(value.text).length>8*1024*1024)invalid('操作返回了无效编辑范围。');break;
  case 'saved':assertNoteAuthority(value.snapshot?.authority,request.authority);if(!value.snapshot.revision||typeof value.snapshot.content!=='string')invalid('保存响应缺少版本或正文。');break;
  case 'renamed':{
   const grant=value.viewGrant,authority=value.authority,snapshot=value.snapshot;
   if(request.action.kind!=='rename-document'||!grant||grant.kind!=='note'||grant.id!==request.viewId||grant.libraryId!==request.authority.vaultId||!grant.resourceId||!authority||authority.sourceId!==request.authority.sourceId||authority.vaultId!==request.authority.vaultId||authority.documentId!==value.documentId||!snapshot||snapshot.authority.documentId!==value.documentId||!snapshot.revision||typeof snapshot.content!=='string')invalid('重命名未返回经过验证的新笔记授权。');
   assertNoteAuthority(snapshot!.authority,authority!);
   if(nativeNoteDocumentId({vaultId:grant!.libraryId,relativePath:grant!.resourceId!})!==authority!.documentId||!value.title||value.title!==grant!.title)invalid('重命名授权与实际文档标识不匹配。');break;
  }
  default:invalid('未知笔记操作结果。');
 }
 // Inline AI must produce its real result; opening a composer is not completion.
 if(request.action.kind==='suggest-ai'&&value.kind!=='suggestion')invalid('AI 建议尚未生成。');
 if(request.action.kind==='write-ai'&&value.kind!=='replace-range'&&!(value.kind==='acknowledged'&&value.message==='已取消 AI 写作预览。'))invalid('AI 写作尚未生成经过确认的替换。');
 return value;
}

/** Native transport installed per captured view. It has no bridge, filesystem,
 * SQL, current-vault, AI provider or global navigation import. */
export function createNativeNoteActions(services:NativeNoteActionServices):NoteRuntime['actions']&{dispose():void;refreshCapabilities():Promise<readonly NoteParentActionKind[]>}{
 const identity=Object.freeze({...services.authority}),viewId=services.viewId;
 let active=true,lastRequest=0,capabilityRequest=0;
 let backendKinds=new Set(services.capabilities),leaseUntil=services.capabilityLeaseMs===undefined?Infinity:Date.now()+Math.max(0,services.capabilityLeaseMs);
 const capabilityListeners=new Set<()=>void>();let expiryTimer:ReturnType<typeof setTimeout>|undefined;
 const notifyCapabilities=()=>{for(const listener of capabilityListeners)listener();};
 const scheduleExpiry=()=>{
  if(expiryTimer!==undefined)clearTimeout(expiryTimer);
  if(Number.isFinite(leaseUntil)&&active)expiryTimer=setTimeout(()=>{expiryTimer=undefined;notifyCapabilities();},Math.max(0,leaseUntil-Date.now())+1);
 };
 scheduleExpiry();
 const installed=()=>{
  const advertised=new Set(Date.now()<leaseUntil?backendKinds:[]);
  for(const kind of Object.keys(localPanels) as (keyof typeof localPanels)[])if(services.showPanel)advertised.add(kind);else advertised.delete(kind);
  if(services.closeView)advertised.add('close-view');else advertised.delete('close-view');
  return Object.freeze(NOTE_PRODUCTION_PARENT_ACTIONS.filter(kind=>advertised.has(kind)));
 };
 const check=(request:NoteActionRequest)=>{if(!active||!services.isCurrent(request))throw new NoteRuntimeError('stale-result','笔记或视图已变化，旧操作不会继续。');};
 return Object.freeze({get capabilities(){return active?installed():[];},subscribeCapabilities:(listener:()=>void)=>{capabilityListeners.add(listener);return()=>{capabilityListeners.delete(listener);};},dispose:()=>{active=false;if(expiryTimer!==undefined)clearTimeout(expiryTimer);notifyCapabilities();capabilityListeners.clear();},refreshCapabilities:async()=>{
  if(!active)throw new NoteRuntimeError('stale-result','笔记视图已关闭。');
  const refreshRequest=++capabilityRequest;
  const response=await services.command<{actions:NoteParentActionKind[];expiresInMs?:number}>({op:'noteActionCapabilities',viewId});
  if(!active)throw new NoteRuntimeError('stale-result','笔记视图已关闭。');
  // An overlapping, newer check owns publication. A late positive reply must
  // not restore a permission it revoked or renew its lease with stale data.
  if(refreshRequest!==capabilityRequest)return installed();
  if(!Array.isArray(response.actions)||response.actions.length>NOTE_PRODUCTION_PARENT_ACTIONS.length||response.actions.some(kind=>!NOTE_PRODUCTION_PARENT_ACTIONS.includes(kind))||(response.expiresInMs!==undefined&&(!Number.isFinite(response.expiresInMs)||response.expiresInMs<0||response.expiresInMs>15000)))invalid('笔记处理程序授权无效。');
  // Renewing an unexpired, identical action set changes only its lease deadline.
  // Publishing it as a capability change needlessly retires the rendered proof
  // and waits for another animation frame (which hidden WebViews may defer).
  // Expiry/revocation/restoration remain real changes and retain the safety gate.
  const expired=Date.now()>=leaseUntil,before=installed();
  backendKinds=new Set(response.actions);leaseUntil=response.expiresInMs===undefined?Infinity:Date.now()+response.expiresInMs;scheduleExpiry();
  const after=installed();
  if(expired||before.length!==after.length||before.some((kind,index)=>kind!==after[index]))notifyCapabilities();
  return after;
 },request:async(request:NoteActionRequest):Promise<NoteActionReply>=>{
  const envelope={requestId:request.requestId,viewId:request.viewId,authority:request.authority,revision:request.revision,generation:request.generation};
  let release:(()=>void)|undefined;
  try{
   assertNoteAuthority(request.authority,identity);
   if(request.viewId!==viewId||!Number.isSafeInteger(request.requestId)||request.requestId<=lastRequest||typeof request.revision!=='string'||!request.revision||request.revision.length>128||!Number.isSafeInteger(request.generation)||request.generation<0||typeof request.content!=='string'||new TextEncoder().encode(request.content).length>8*1024*1024)throw new NoteRuntimeError('scope-mismatch','笔记操作的视图、版本或请求标识无效。');
   validateNoteParentAction(request.action);check(request);
   if(request.action.kind==='export-document'&&request.action.format!=='markdown')throw new NoteRuntimeError('unsupported','当前生产笔记服务只支持 Markdown 导出。');
   if(request.action.kind==='write-ai'&&!['rewrite','shorten','expand','continue'].includes(request.action.action))throw new NoteRuntimeError('unsupported','当前笔记 AI 写作只支持改写、精简、扩写和续写。');
   if(!installed().includes(request.action.kind))throw new NoteRuntimeError('unsupported','此笔记操作尚未接入完整的受限服务。');
   lastRequest=request.requestId;
   if(request.action.kind in localPanels&&!(request.action.kind==='browse-documents'&&request.action.section)){await services.showPanel!(localPanels[request.action.kind as keyof typeof localPanels],request);check(request);return {...envelope,result:{ok:true,value:{kind:'acknowledged'}}};}
   if(request.action.kind==='close-view'){await services.closeView!(request);return {...envelope,result:{ok:true,value:{kind:'acknowledged'}}};}
   if(services.freezeForAction){release=await services.freezeForAction(request);check(request);}
   let action=await serializeNativeNoteAction(request.action);check(request);
   if(action.kind==='create-note'&&!action.title.trim()){
    if(!services.promptTitle)throw new NoteRuntimeError('unsupported','此视图尚未接入新笔记名称对话框。');
    const title=await services.promptTitle(request);check(request);
    if(title===null)return {...envelope,result:{ok:true,value:{kind:'acknowledged',message:'已取消新建笔记。'}}};
    if(!title.trim()||title.length>512||/[\0\r\n]/.test(title))invalid('笔记名称无效。');
    action={...action,title:title.trim()};
   }
   let status=await services.command<NativeNoteActionStatus>({...envelope,op:'noteAction',content:request.content,action});check(request);
   const started=Date.now();let receipt:string|null=null;
   while(status.state==='pending'){
    if(!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(status.id)||status.requestId!==request.requestId||status.viewId!==viewId||status.revision!==request.revision||status.generation!==request.generation||(receipt!==null&&receipt!==status.id))invalid('主窗口操作凭据无效。');
    receipt=status.id;if(Date.now()-started>180000)throw new NoteRuntimeError('stale-result','主窗口操作已过期，请重新执行。');
    await (services.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(200);check(request);
    status=await services.command<NativeNoteActionStatus>({...envelope,op:'noteActionStatus',id:receipt});check(request);
   }
   if(status.state!=='completed'||!status.result||typeof status.result.ok!=='boolean')invalid('主窗口未返回完成状态。');
   const result=status.result.ok?{ok:true as const,value:validateNativeNoteActionValue(status.result.value,request)}:status.result;
   return {...envelope,result};
  }catch(error){return {...envelope,result:errorResult(error)};}finally{release?.();}
 }});
}
