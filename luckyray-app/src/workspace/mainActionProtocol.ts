import type {NativeViewGrant} from './nativeClient';
/** Main-only DTOs. Children receive an opaque receipt and correlated status. */
export type WorkspaceMainAction =
  | {kind:'openDocument';vaultId:string;title:string}
  | {kind:'createMissing';vaultId:string;title:string;relativePath:string}
  | {kind:'openTag';vaultId:string;name:string}
  | {kind:'composeAi';source:'notes'|'graph';text:string}
  | {kind:'fileOperation';mode:'open'|'reveal';label:string};
export type WorkspaceActionOffer={id:string;title:string;viewId:string};
export type WorkspaceActionClaim={id:string;claimToken:string;remainingMs:number;action:WorkspaceMainAction};
export type WorkspaceActionExecution={kind:'acknowledged'}|{kind:'openView';view:NativeViewGrant}|{kind:'openedInOrigin';viewId:string};
export type WorkspaceActionCompletion='performed'|'cancelled'|'failed';
export type WorkspaceMainActionTransport={
 pending():Promise<WorkspaceActionOffer[]>;
 claim(id:string):Promise<WorkspaceActionClaim>;
 validate(id:string,claimToken:string):Promise<number>;
 execute(id:string,claimToken:string,confirmed:boolean):Promise<WorkspaceActionExecution>;
 complete(id:string,claimToken:string,completion:WorkspaceActionCompletion):Promise<void>;
 cancel(id:string):Promise<void>;
};
export type WorkspaceMainActionServices={
 now():number; alive():boolean;
 /** Captured before the claim; compare object identity before using global Tags. */
 knowledgeSource():{vaultId?:string|null}|null;
 confirmCreate(action:Extract<WorkspaceMainAction,{kind:'createMissing'}>):boolean|Promise<boolean>;
 openBoundNote(view:NativeViewGrant):void;
 openTag(vaultId:string,name:string):void;
 /** Stages the existing Main LightSeek composer only. No send API exists here. */
 compose(request:{source:'notes'|'graph';text:string}):void|Promise<void>;
};
const requireClaim=(claim:WorkspaceActionClaim)=>{
 if(!/^[a-f0-9]{32}$/.test(claim.id)||!/^[a-f0-9]{32}$/.test(claim.claimToken)
   ||!Number.isFinite(claim.remainingMs)||claim.remainingMs<=0||claim.remainingMs>120_000)throw Error('workspace-action-invalid-claim');
};

/** Serial, at-most-once presentation consumer. An event is only a wake-up;
 * action data must always be fetched from the authenticated backend queue. */
export function createWorkspaceMainActionConsumer(transport:WorkspaceMainActionTransport,services:WorkspaceMainActionServices){
 let running:Promise<void>|null=null;
 const seen=new Set<string>();
 const process=async(offer:WorkspaceActionOffer)=>{
  if(!services.alive()||seen.has(offer.id))return;
  seen.add(offer.id);
  let claim:WorkspaceActionClaim|null=null;
  const source=services.knowledgeSource(),started=services.now();
  try{
   const received=await transport.claim(offer.id);requireClaim(received);
   if(received.id!==offer.id)throw Error('workspace-action-invalid-claim');
   claim=received;
   const guard=()=>{
    if(!services.alive()||services.now()-started>=claim!.remainingMs)throw Error('workspace-action-expired');
   };
   guard();
   const action=claim.action;
   if(action.kind==='createMissing'){
    const confirmed=await services.confirmCreate(action);guard();
    if(!confirmed){await transport.complete(claim.id,claim.claimToken,'cancelled');return;}
   }
   if(action.kind==='composeAi'||action.kind==='openTag'){
    const remaining=await transport.validate(claim.id,claim.claimToken);
    guard();if(!Number.isFinite(remaining)||remaining<=0)throw Error('workspace-action-expired');
    if(action.kind==='composeAi'){
     if((action.source!=='notes'&&action.source!=='graph')||!action.text||new TextEncoder().encode(action.text).length>12*1024)throw Error('workspace-action-invalid-context');
     await services.compose({source:action.source,text:action.text});guard();
    }else{
     if(!source||source!==services.knowledgeSource()||source.vaultId!==action.vaultId)throw Error('workspace-action-scoped-tag-destination-required');
     services.openTag(action.vaultId,action.name);
    }
   }else if(action.kind==='openDocument'||action.kind==='createMissing'||action.kind==='fileOperation'){
    const execution=await transport.execute(claim.id,claim.claimToken,action.kind==='createMissing');guard();
    if(action.kind==='fileOperation'){
     if(execution.kind!=='acknowledged')throw Error('workspace-action-invalid-execution');
    }else{
     if(execution.kind==='openedInOrigin'){
      if(!execution.viewId||execution.viewId.length>128)throw Error('workspace-action-invalid-execution');
      // Backend already attached and notified the captured originating window.
     }else{
      if(execution.kind!=='openView'||execution.view.kind!=='note'||execution.view.libraryId!==action.vaultId||!execution.view.resourceId)throw Error('workspace-action-invalid-execution');
      services.openBoundNote(execution.view);
     }
    }
   }else throw Error('workspace-action-unsupported');
   await transport.complete(claim.id,claim.claimToken,'performed');
  }catch(error){
   // No retry after an uncertain stage/execute. Backend claims are single-use.
   if(claim)await transport.complete(claim.id,claim.claimToken,'failed').catch(()=>{});
   else await transport.cancel(offer.id).catch(()=>{});
   throw error;
  }
 };
 return {
  drain(onError:(error:unknown)=>void=()=>{}){
   if(running)return running;
   running=(async()=>{
    const offers=await transport.pending();
    if(offers.length>64)throw Error('workspace-action-capacity');
    for(const offer of offers){if(!services.alive())return;try{await process(offer);}catch(error){onError(error);}}
    // At most 64 bounded receipts arrive in one listing. The backend does not
    // re-offer claimed/completed IDs; local de-duplication needn't grow forever.
    if(seen.size>256)seen.clear();
   })().finally(()=>{running=null;});
   return running;
  },
 };
}
