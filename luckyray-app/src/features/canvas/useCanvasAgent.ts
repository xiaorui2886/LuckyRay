import {useCallback,useEffect,useRef,useState} from 'react';
import type {CanvasAgentContext,CanvasAgentRequest,CanvasAgentSnapshot,CanvasAgentModelSelection,CanvasAgentModels,CanvasAgentExecutionPolicy,CanvasAgentActionExecutor,CanvasAgentActionResult,CanvasAgentPendingAction,CanvasAgentConversation} from '../../core/canvas/agent/types';
import {canvasAgentClient,prepareCanvasAgentHost} from '../../core/services/canvasAgent';

type RotationRequest=Extract<CanvasAgentRequest,{op:'newConversation'|'resumeConversation'}>;
type StartRequest=Extract<CanvasAgentRequest,{op:'start'}>;
type PendingStart={request:StartRequest;promise:Promise<CanvasAgentSnapshot>;cancelled:boolean};
type Cancellation={canvasId:string;requestId?:string;runId?:string};
const selectionKey=(id:string)=>`luckyray.canvas-agent.model.${id}`;
const readSelection=(id:string|null):CanvasAgentModelSelection|null=>{
  try{const value=id?JSON.parse(localStorage.getItem(selectionKey(id))||'null'):null;
    return value&&typeof value.provider==='string'&&value.provider.length<=160&&typeof value.model==='string'&&value.model.length<=160?{provider:value.provider,model:value.model,...(typeof value.reasoningEffort==='string'&&value.reasoningEffort.length>0&&value.reasoningEffort.length<=160&&!/[\u0000-\u001f\u007f]/.test(value.reasoningEffort)?{reasoningEffort:value.reasoningEffort}:{})}:null;
  }catch{return null;}
};
const reason=(error:unknown)=>error instanceof Error?error.message:String(error);
// A receipt retry compares visible reference IDs/order and attachment bytes, not
// canvas name/revision/layout/text changes made automatically by the accepted task.
// A changed visible intent is preserved, never sent in the recovery invocation.
const visibleContextIntent=(value:CanvasAgentContext)=>value.nodes.map(node=>({id:node.id,kind:node.kind,image:node.image??null,imageUnavailable:!!node.imageUnavailable}));
type StartGuard=Pick<StartRequest,'canvasId'|'conversationId'|'requestId'>&{intentFingerprint:string};
const intentFingerprint=async(prompt:string,execution:CanvasAgentExecutionPolicy,model:CanvasAgentModelSelection|null,ctx:CanvasAgentContext)=>{
  try{
    const bytes=new TextEncoder().encode(JSON.stringify({prompt,execution,model,refs:visibleContextIntent(ctx)}));
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  }catch{throw Error('canvas-agent-intent-fingerprint-failed');}
};
const isStartReceipt=(next:CanvasAgentSnapshot,request:StartGuard)=>next.canvasId===request.canvasId&&next.conversationId===request.conversationId&&next.requestId===request.requestId;



export function useCanvasAgent(canvasId:string|null,enabled:boolean,getContext:(signal:AbortSignal)=>Promise<CanvasAgentContext>,executeAction?:CanvasAgentActionExecutor) {
  const [snapshot,setSnapshot]=useState<CanvasAgentSnapshot|null>(null),[error,setError]=useState('');
  const [models,setModels]=useState<CanvasAgentModels|null>(null),[modelsError,setModelsError]=useState('');
  const [selectedModel,setSelectedModel]=useState<CanvasAgentModelSelection|null>(()=>readSelection(canvasId));
  const selection=useRef<CanvasAgentModelSelection|null>(selectedModel),modelEpoch=useRef(0);
  const [busy,setBusy]=useState(false),[checking,setChecking]=useState(false);
  const preparing=useRef<AbortController|null>(null),epoch=useRef(0);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const active=useRef(canvasId),context=useRef(getContext),latest=useRef<CanvasAgentSnapshot|null>(null);
  const guards=useRef(new Map<string,StartGuard>());
  const flight=useRef(false),retry=useRef<StartGuard|null>(null),pendingStart=useRef<PendingStart|null>(null);
  const cancellation=useRef<Cancellation|null>(null);
  const connecting=useRef<Promise<void>|null>(null),rotation=useRef<RotationRequest|null>(null);
  const [rotationPending,setRotationPending]=useState(false);
  const [conversations,setConversations]=useState<CanvasAgentConversation[]>([]),[historyLoading,setHistoryLoading]=useState(false),[historyError,setHistoryError]=useState('');
  const executor=useRef(executeAction);executor.current=executeAction;
  const actions=useRef(new Map<string,{controller:AbortController;result?:CanvasAgentActionResult;promise?:Promise<void>;delivered:boolean}>());
  const runAction=useRef<(action:CanvasAgentPendingAction,id:string,token:number)=>void>(()=>{});
  const abortActions=()=>{for(const entry of actions.current.values())entry.controller.abort();};
  active.current=canvasId;context.current=getContext;
  const current=(id:string,token:number)=>epoch.current===token&&active.current===id;
  const running=()=>latest.current?.status==='running';
  const clearGuard=()=>{
    const guard=retry.current;
    if(guard&&guards.current.get(guard.canvasId)?.requestId===guard.requestId)guards.current.delete(guard.canvasId);
    retry.current=null;
  };
  const publish=(next:CanvasAgentSnapshot)=>{
    // Keep the guard synchronous: another caller may send before React commits.
    if(next.conversations)setConversations(next.conversations);
    if(next.models)setModels(previous=>previous?{...previous,currentModel:next.models!.currentModel}:next.models!);
    latest.current=next;setSnapshot(next);setBusy(next.status==='running');setError(next.error||'');
  };
  const matches=(next:CanvasAgentSnapshot,intent:Cancellation)=>next.canvasId===intent.canvasId
    && (intent.runId?next.runId===intent.runId:!!intent.requestId&&next.requestId===intent.requestId)
    && (!retry.current||retry.current.requestId!==intent.requestId||isStartReceipt(next,retry.current));
  const poll=useRef<(id:string,token:number)=>Promise<void>>(async()=>{});
  const schedule=(id:string,token:number,delay=180)=>{
    clearTimeout(timer.current);
    timer.current=setTimeout(()=>void poll.current(id,token),delay);
  };
  poll.current=async(id,token)=>{
    try{
      let next=await canvasAgentClient.dispatch({op:'status',canvasId:id});
      if(!current(id,token))return;
      const intent=cancellation.current;
      if(intent&&matches(next,intent)&&next.status==='running'&&next.runId){
        next=await canvasAgentClient.dispatch({op:'cancel',canvasId:id,runId:next.runId});
        if(!current(id,token))return;
      }
      publish(next);setChecking(false);
      if(retry.current&&!cancellation.current)setError(isStartReceipt(next,retry.current)?'canvas-agent-start-recovered':'canvas-agent-start-unconfirmed');
      if(next.pendingAction&&!cancellation.current)runAction.current(next.pendingAction,id,token);
      if(next.status!=='running')abortActions();
      // Keep an uncertain start identity until send acknowledges it (or cancel
      // clears it). Status recovery alone must not make a retained draft replay
      // create a second paid model turn.
      if(intent&&(next.status!=='running'||!matches(next,intent))){
        cancellation.current=null;
        if(retry.current&&retry.current.requestId===intent.requestId&&isStartReceipt(next,retry.current))clearGuard();
        else if(retry.current)setError('canvas-agent-start-unconfirmed');
      }
      if(next.status==='running')schedule(id,token);
    }catch(caught){
      if(!current(id,token))return;
      setChecking(false);setError(retry.current&&!cancellation.current?'canvas-agent-start-unconfirmed':reason(caught));
      const unresolved=running()||!!retry.current||!!cancellation.current;
      setBusy(running()||!!cancellation.current);
      // A transient status failure is not evidence that an accepted run stopped.
      if(unresolved)schedule(id,token,1500);
    }
  };
  runAction.current=(action,id,token)=>{
    if(!current(id,token)||cancellation.current||latest.current?.runId!==action.runId)return;
    const key=`${id}:${action.runId}:${action.actionId}`;
    let entry=actions.current.get(key);
    if(entry?.promise||entry?.delivered)return;
    if(!entry){entry={controller:new AbortController(),delivered:false};actions.current.set(key,entry);}
    const owned=entry;
    owned.promise=(async()=>{
      if(!owned.result){
        try{owned.result=executor.current?await executor.current(action,owned.controller.signal):{status:'failed',summary:'Canvas execution surface unavailable; no actions were performed.',generatedJobs:0};}
        catch(caught){owned.result={status:owned.controller.signal.aborted?'cancelled':'failed',summary:reason(caught).slice(0,2000),generatedJobs:0};}
      }
      if(!current(id,token)||latest.current?.runId!==action.runId||cancellation.current)return;
      try{
        const next=await canvasAgentClient.dispatch({op:'actionResult',canvasId:id,runId:action.runId,actionId:action.actionId,result:owned.result},()=>current(id,token));
        owned.delivered=true;
        if(current(id,token)&&latest.current?.runId===action.runId){publish(next);if(next.status==='running')schedule(id,token,80);}
      }catch(caught){if(current(id,token))setError(reason(caught));/* Retain receipt, never re-execute on lost acknowledgement. */}
    })().finally(()=>{owned.promise=undefined;});
  };
  const refreshModels=useCallback(async()=>{
    const id=active.current;if(!id)return;
    const token=++modelEpoch.current;
    try{
      const next=await canvasAgentClient.dispatch({op:'models',canvasId:id});
      if(active.current!==id||modelEpoch.current!==token)return;
      setModels(next.models?{...next.models,currentModel:latest.current?.models?.currentModel??next.models.currentModel}:null);setModelsError(next.models?'':'canvas-agent-model-unavailable');
    }catch(caught){if(active.current===id&&modelEpoch.current===token){setModels(null);setModelsError(reason(caught));}}
  },[]);
  const selectModel=useCallback((next:CanvasAgentModelSelection|null)=>{
    if(flight.current||running()||retry.current||rotation.current)throw Error('canvas-agent-busy');
    const id=active.current;if(!id)return;
    selection.current=next?{provider:next.provider,model:next.model,...(next.reasoningEffort?{reasoningEffort:next.reasoningEffort}:{})}:null;setSelectedModel(selection.current);
    try{if(next)localStorage.setItem(selectionKey(id),JSON.stringify(selection.current));else localStorage.removeItem(selectionKey(id));}catch{/* Session choice still applies if storage is unavailable. */}
  },[]);
  useEffect(()=>{
    abortActions();actions.current.clear();setConversations([]);setHistoryError('');setHistoryLoading(false);
    modelEpoch.current++;setModels(null);setModelsError('');selection.current=readSelection(canvasId);setSelectedModel(selection.current);
    epoch.current++;preparing.current?.abort();clearTimeout(timer.current);
    latest.current=null;setSnapshot(null);setError('');setBusy(false);setChecking(false);
    retry.current=canvasId?guards.current.get(canvasId)??null:null;pendingStart.current=null;cancellation.current=null;flight.current=false;connecting.current=null;rotation.current=null;setRotationPending(false);
    return()=>{abortActions();modelEpoch.current++;epoch.current++;preparing.current?.abort();clearTimeout(timer.current);};
  },[canvasId]);
  const connect=async(id:string,token:number)=>{
    const preparation=connecting.current??prepareCanvasAgentHost();connecting.current=preparation;
    try{
      await preparation.catch(()=>undefined); // A stale one-shot failure must not hide recovered native status.
      if(!current(id,token))return;
      await poll.current(id,token);
      if(current(id,token)&&latest.current)await refreshModels();
    }catch(caught){if(current(id,token)){setChecking(false);setError(reason(caught));}}
    finally{if(connecting.current===preparation)connecting.current=null;}
  };
  useEffect(()=>{
    if(!enabled||!canvasId||flight.current)return;
    clearTimeout(timer.current);const token=++epoch.current;setChecking(true);
    // Join background preparation without opening a foreground LSH chat.
    void connect(canvasId,token);
  },[enabled,canvasId]);
  const send=useCallback(async(prompt:string,execution:CanvasAgentExecutionPolicy={mode:'autonomous',allowGeneration:false,maxMediaJobs:0})=>{
    const id=active.current;
    if(!id||!prompt.trim())return false;
    if(flight.current||(running()&&!retry.current)||cancellation.current||rotation.current)throw Error('canvas-agent-busy');
    const token=++epoch.current,controller=new AbortController();
    flight.current=true;preparing.current=controller;setBusy(true);setChecking(false);setError('');clearTimeout(timer.current);
    try{
      let prepared=true;
      await prepareCanvasAgentHost().catch(()=>{prepared=false;});
      if(!current(id,token))throw Error('canvas-agent-cancelled');
      const unresolved=retry.current;
      if(unresolved){
        // Never replay a possibly accepted start, even when the canvas has since changed.
        // Status is the only operation in this recovery branch; a new request needs another send.
        let recovered:CanvasAgentSnapshot;
        try{recovered=await canvasAgentClient.dispatch({op:'status',canvasId:id});}
        catch{throw Error('canvas-agent-start-unconfirmed');}
        if(!current(id,token))throw Error('canvas-agent-cancelled');
        publish(recovered);
        if(!isStartReceipt(recovered,unresolved))throw Error('canvas-agent-start-unconfirmed');
        const ctx=await context.current(controller.signal);
        if(!current(id,token))throw Error('canvas-agent-canvas-changed');
        const fingerprint=await intentFingerprint(prompt,execution,selection.current,ctx);
        if(!current(id,token))throw Error('canvas-agent-canvas-changed');
        const unchanged=unresolved.intentFingerprint===fingerprint;
        clearGuard();
        if(recovered.status==='running')schedule(id,token);
        if(!unchanged)throw Error('canvas-agent-previous-request-recovered');
        // A failed task was still accepted. Let the caller clear the old draft
        // and one-shot media grant; the snapshot retains the actual task error.
        return true;
      }
      if(!latest.current||!prepared){
        const initial=await canvasAgentClient.dispatch({op:'status',canvasId:id});
        if(!current(id,token))throw Error('canvas-agent-cancelled');
        publish(initial);
        if(initial.status==='running'){schedule(id,token);throw Error('canvas-agent-busy');}
      }
      const conversationId=latest.current!.conversationId;
      if(!conversationId)throw Error('canvas-agent-response-invalid');
      const ctx=await context.current(controller.signal);
      if(!current(id,token))throw Error('canvas-agent-canvas-changed');
      const modelSelection=selection.current;
      const fingerprint=await intentFingerprint(prompt,execution,modelSelection,ctx);
      if(!current(id,token))throw Error('canvas-agent-canvas-changed');
      const request:StartRequest={op:'start',conversationId,canvasId:id,requestId:crypto.randomUUID(),prompt,context:ctx,execution,...(modelSelection?{modelSelection}:{})};
      const guard:StartGuard={canvasId:id,conversationId,requestId:request.requestId,intentFingerprint:fingerprint};
      guards.current.set(id,guard);retry.current=guard;
      const pending:PendingStart={request,promise:canvasAgentClient.dispatch(request,()=>current(id,token)&&latest.current?.conversationId===conversationId),cancelled:false};
      pendingStart.current=pending;
      let next:CanvasAgentSnapshot;
      try{next=await pending.promise;}finally{if(pendingStart.current===pending)pendingStart.current=null;}
      if(!current(id,token)){
        // Cancel owns late ACKs when explicitly requested. Navigation/unmount
        // still cleans up a start whose identity was not available beforehand.
        if(!pending.cancelled&&next.status==='running'&&next.runId)
          await canvasAgentClient.dispatch({op:'cancel',canvasId:id,runId:next.runId}).catch(()=>undefined);
        return false;
      }
      publish(next);clearGuard();
      if(next.status==='running')schedule(id,token,600);
      if(next.status==='failed')throw Error(next.error||'canvas-agent-model-failed');
      return true;
    }catch(caught){
      if(current(id,token)){
        if(['canvas-agent-conversation-conflict','canvas-agent-request-conflict','canvas-agent-request-already-used','canvas-agent-busy'].includes(reason(caught))){
          // Authoritative rejection is not a lost ACK. Do not keep a rejected
          // request identity that would make cancellation target the wrong run.
          clearGuard();await poll.current(id,token);
        }
        if(current(id,token)){
          setBusy(running()||!!cancellation.current);setError(reason(caught));
          if(retry.current||running())schedule(id,token);
        }
      }
      throw caught;
    }finally{if(current(id,token))flight.current=false;}
  },[]);
  const cancel=useCallback(async()=>{
    abortActions();preparing.current?.abort();const token=++epoch.current;clearTimeout(timer.current);setChecking(false);
    const id=active.current;if(!id){flight.current=false;setBusy(false);return;}
    const pending=pendingStart.current,pendingRequest=retry.current;
    let next=latest.current;
    const intent:Cancellation={canvasId:id,...(pendingRequest?.canvasId===id?{requestId:pendingRequest.requestId}:next?.runId?{runId:next.runId}:{})};
    cancellation.current=intent;flight.current=true;
    try{
      if(pending?.request.canvasId===id){
        // Do not release the send lock while its start acknowledgement is still
        // in flight, or a retry could accidentally reuse the run being stopped.
        pending.cancelled=true;setBusy(true);
        try{next=await pending.promise;}catch{next=null;}
      }
      if((!next?.runId||next.status!=='running'||!matches(next,intent))&&pendingRequest?.canvasId===id)
        next=await canvasAgentClient.dispatch({op:'status',canvasId:id});
      if(pendingRequest&&(!next||!isStartReceipt(next,pendingRequest)))throw Error('canvas-agent-start-unconfirmed');
      if(next?.runId&&next.status==='running'&&matches(next,intent))
        next=await canvasAgentClient.dispatch({op:'cancel',canvasId:id,runId:next.runId});
      if(!current(id,token))return;
      if(pendingRequest&&(!next||!isStartReceipt(next,pendingRequest)))throw Error('canvas-agent-start-unconfirmed');
      clearGuard();
      if(next)publish(next);else {setBusy(false);setError('');}
      if(next?.status==='running'){
        if(!matches(next,intent))cancellation.current=null;
        schedule(id,token,600);
      }else cancellation.current=null;
    }catch(caught){
      if(current(id,token)){
        if(pendingRequest){
          // Unknown is not cancelled: preserve the paid-request guard and allow
          // read-only reconciliation without cancelling a different conversation.
          cancellation.current=null;setError('canvas-agent-start-unconfirmed');setBusy(running());
        }else {setError(reason(caught));setBusy(true);}
        schedule(id,token,1500);
      }
      throw pendingRequest?Error('canvas-agent-start-unconfirmed'):caught;
    }finally{if(current(id,token))flight.current=false;}
  },[]);
  const refresh=useCallback(()=>{
    const id=active.current;
    if(id&&!flight.current){clearTimeout(timer.current);setChecking(true);const token=++epoch.current;
      void connect(id,token);}
  },[]);
  const rotateConversation=useCallback(async(targetConversationId?:string)=>{
    const id=active.current;
    if(!id||flight.current||running()||retry.current||cancellation.current)throw Error('canvas-agent-busy');
    const expected=latest.current?.conversationId;
    if(!expected)throw Error('canvas-agent-not-ready');
    const token=++epoch.current;clearTimeout(timer.current);flight.current=true;setChecking(false);setBusy(true);setError('');
    const request:RotationRequest=rotation.current??(targetConversationId?{op:'resumeConversation',canvasId:id,requestId:crypto.randomUUID(),expectedConversationId:expected,conversationId:targetConversationId}:{op:'newConversation',canvasId:id,requestId:crypto.randomUUID(),expectedConversationId:expected});
    rotation.current=request;setRotationPending(true);
    try{
      const next=await canvasAgentClient.dispatch(request,()=>current(id,token));
      if(!current(id,token))return false;
      abortActions();actions.current.clear();publish(next);rotation.current=null;setRotationPending(false);
      return true;
    }catch(caught){
      if(current(id,token)){
        setError(reason(caught));setBusy(false);
        if(reason(caught)==='canvas-agent-conversation-conflict'){
          // The host definitively rejected this stale identity, so it cannot be
          // replayed. Reconcile only; a fresh rotation needs another user click.
          rotation.current=null;setRotationPending(false);await poll.current(id,token);
        }
      }
      throw caught;
    }
    finally{if(current(id,token))flight.current=false;}
  },[]);
  const newConversation=useCallback(()=>rotateConversation(),[rotateConversation]);
  const selectConversation=useCallback((id:string)=>rotateConversation(id),[rotateConversation]);
  const loadConversations=useCallback(async()=>{
    const id=active.current;if(!id)return;const token=epoch.current;setHistoryLoading(true);setHistoryError('');
    try{const next=await canvasAgentClient.dispatch({op:'history',canvasId:id});if(current(id,token))setConversations(next.conversations||[]);}
    catch(caught){if(current(id,token))setHistoryError(reason(caught));}
    finally{if(current(id,token))setHistoryLoading(false);}
  },[]);
  // An initial status failure is not readiness. Keep a known running session
  // stoppable during a transient transport failure, but do not enable a first
  // send against a host which has never acknowledged this canvas.
  const availability:'checking'|'unavailable'|'ready'=checking?'checking':error&&!snapshot?'unavailable':'ready';
  const modelSelectionUnavailable=!!selectedModel&&!!models&&!models.available.some(item=>item.provider===selectedModel.provider&&item.model===selectedModel.model);
  return {conversations,historyLoading,historyError,loadConversations,selectConversation,snapshot,error,busy,checking,availability,send,cancel,refresh,newConversation,rotationPending,models,modelsError,selectedModel,selectModel,modelSelectionUnavailable,modelSelectionLocked:busy||!!retry.current||rotationPending};
}
