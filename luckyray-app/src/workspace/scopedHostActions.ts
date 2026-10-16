import {
  assertNoteAuthority, NOTE_PRODUCTION_PARENT_ACTIONS, NoteRuntimeError, validateNoteParentAction,
  type NoteActionReply, type NoteActionRequest, type NoteAuthority, type NoteParentAction,
  type NoteParentActionKind, type NoteRuntime,
} from '../features/notes/NoteRuntime';

export type ScopedHostActionRequest<K extends NoteParentActionKind> = Omit<NoteActionRequest,'action'> & {
  readonly action:Extract<NoteParentAction,{kind:K}>;
};
export type ScopedHostActionHandler<K extends NoteParentActionKind> = (
  request:ScopedHostActionRequest<K>,
) => NoteActionReply['result'] | Promise<NoteActionReply['result']>;
/** Each route is explicit. Installing a function is the only way to advertise it. */
export type ScopedHostActionHandlers = {
  readonly [K in NoteParentActionKind]?:ScopedHostActionHandler<K>;
};
export type ScopedHostActions = NoteRuntime['actions'] & {readonly dispose:()=>void};
export type ScopedHostActionsOptions = {
  viewId:string;
  authority:NoteAuthority;
  /** Must compare the captured request with this grant's live view, source,
   * revision, generation and content. Never resolve through the active tab. */
  isCurrent:(request:NoteActionRequest)=>boolean;
  handlers:ScopedHostActionHandlers;
};

function failure(error:unknown):NoteActionReply['result'] {
  if(error instanceof NoteRuntimeError)return {ok:false,code:error.code,message:error.message};
  return {ok:false,code:'unavailable',message:'当前笔记操作暂时无法完成。'};
}

/** Copy only in-memory payload containers. In particular, File objects retain
 * their identity and are never encoded into JSON or forwarded to a global API. */
function captureAction(input:NoteParentAction):NoteParentAction {
  const action={...input};
  if('selection' in action)action.selection=Object.freeze({...action.selection});
  if('options' in action&&action.options)action.options=Object.freeze({...action.options});
  if(action.kind==='open-note')action.target=Object.freeze({...action.target});
  if(action.kind==='insert-clipboard-image')action.source=Object.freeze({...action.source});
  if(action.kind==='insert-files'){
    action.files=[...action.files];Object.freeze(action.files);
  }
  if(action.kind==='apply-document-tags'){
    action.names=[...action.names];Object.freeze(action.names);
  }
  return Object.freeze(action);
}

function validateResult(result:NoteActionReply['result'],request:NoteActionRequest):NoteActionReply['result'] {
  const invalid=()=>{throw new NoteRuntimeError('invalid-result','笔记操作返回了无效结果。');};
  if(!result||typeof result.ok!=='boolean')return invalid();
  if(!result.ok){
    if(!['unsupported','scope-mismatch','stale-result','invalid-result','unavailable'].includes(result.code)||typeof result.message!=='string')return invalid();
    return {ok:false,code:result.code,message:result.message};
  }
  const value=result.value;
  if(!value)return invalid();
  switch(value.kind){
    case 'acknowledged':
      if(value.message!==undefined&&typeof value.message!=='string')return invalid();
      return {ok:true,value:{kind:value.kind,...(value.message===undefined?{}:{message:value.message})}};
    case 'suggestion':
      if(!Array.isArray(value.tags)||value.tags.some(tag=>typeof tag!=='string')||(value.summary!==undefined&&typeof value.summary!=='string'))return invalid();
      return {ok:true,value:{kind:value.kind,tags:[...value.tags],...(value.summary===undefined?{}:{summary:value.summary})}};
    case 'replace-range':
      if(!value.selection||!Number.isSafeInteger(value.selection.start)||!Number.isSafeInteger(value.selection.end)
        ||value.selection.start<0||value.selection.end<value.selection.start||value.selection.end>request.content.length||typeof value.text!=='string')return invalid();
      return {ok:true,value:{kind:value.kind,selection:{start:value.selection.start,end:value.selection.end},text:value.text}};
    case 'renamed':
      if(typeof value.title!=='string'||!value.title||typeof value.documentId!=='string'||!value.documentId)return invalid();
      return {ok:true,value:{kind:value.kind,title:value.title,documentId:value.documentId}};
    default:return invalid();
  }
}

/** Pure host mediation for an already-issued view grant. This does not install
 * native routes, poll Main, perform transport, or provide production parity.
 * Hosts must dispose the old adapter before closing or regranting a view. */
export function createScopedHostActions(options:ScopedHostActionsOptions):ScopedHostActions {
  const {viewId,isCurrent}=options;
  if(typeof viewId!=='string'||!viewId||viewId.length>128||/[\0\r\n]/.test(viewId)
    ||!options.authority||[options.authority.vaultId,options.authority.sourceId,options.authority.documentId].some(value=>typeof value!=='string'||!value))
    throw new NoteRuntimeError('scope-mismatch','需要明确的笔记视图和来源授权。');
  const authority=Object.freeze({...options.authority});
  const handlers:ScopedHostActionHandlers={};
  const installed:NoteParentActionKind[]=[];
  for(const kind of NOTE_PRODUCTION_PARENT_ACTIONS){
    // Ignore inherited methods and accessors; capability discovery executes no provider code.
    const descriptor=Object.getOwnPropertyDescriptor(options.handlers,kind);
    if(descriptor&&typeof descriptor.value==='function'){
      Object.defineProperty(handlers,kind,{value:descriptor.value,enumerable:true});
      installed.push(kind);
    }
  }
  Object.freeze(handlers);
  const capabilities=Object.freeze(installed);
  let active=true,lastRequestId=0;
  const checkCurrent=(request:NoteActionRequest)=>{
    if(!active||!isCurrent(request))throw new NoteRuntimeError('stale-result','笔记视图已关闭、重新授权或发生变化。');
  };
  async function dispatch<K extends NoteParentActionKind>(request:ScopedHostActionRequest<K>):Promise<NoteActionReply['result']>{
    const handler=handlers[request.action.kind as K];
    if(!handler)return {ok:false,code:'unsupported',message:'此笔记操作尚未安装受限主窗口处理程序。'};
    try{
      const result=await handler(request);
      checkCurrent(request);
      return validateResult(result,request);
    }catch(error){
      // A provider rejection cannot conceal a close/regrant during its await.
      checkCurrent(request);
      throw error;
    }
  }
  return Object.freeze({
    capabilities,
    dispose:()=>{active=false;},
    request:async(input:NoteActionRequest):Promise<NoteActionReply>=>{
      // Capture correlation before awaiting or invoking provider code. Reply
      // envelopes never come from a handler and never include document/File payloads.
      const correlation={requestId:input.requestId,viewId:input.viewId,authority:Object.freeze({...input.authority}),revision:input.revision,generation:input.generation};
      const reply=(result:NoteActionReply['result']):NoteActionReply=>({...correlation,result});
      try{
        if(!active)throw new NoteRuntimeError('stale-result','笔记视图已关闭或重新授权。');
        assertNoteAuthority(input.authority,authority);
        if(input.viewId!==viewId)throw new NoteRuntimeError('scope-mismatch','笔记操作属于其他视图。');
        if(!Number.isSafeInteger(input.requestId)||input.requestId<1||!Number.isSafeInteger(input.generation)||input.generation<0
          ||typeof input.revision!=='string'||!input.revision||input.revision.length>128||typeof input.content!=='string'
          ||!input.action||!NOTE_PRODUCTION_PARENT_ACTIONS.includes(input.action.kind))
          throw new NoteRuntimeError('invalid-result','笔记操作缺少有效的请求标识、版本或内容。');
        if(input.requestId<=lastRequestId)throw new NoteRuntimeError('stale-result','笔记操作请求标识已使用或过期。');
        validateNoteParentAction(input.action);
        if('selection' in input.action&&input.action.selection.end>input.content.length)throw new NoteRuntimeError('invalid-result','编辑范围超出当前笔记。');
        const request=Object.freeze({...correlation,content:input.content,action:captureAction(input.action)});
        checkCurrent(request);
        lastRequestId=request.requestId;
        const result=await dispatch(request);
        checkCurrent(request);
        return reply(result);
      }catch(error){return reply(failure(error));}
    },
  });
}
