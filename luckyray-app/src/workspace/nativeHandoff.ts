import type {NativeViewGrant} from './nativeClient';

export type HandoffOffer={id:string;sourceWindow:string;targetWindow:string;sourceView:NativeViewGrant;targetViewId:string;
 proof:{kind:string;revision:string;identity:{sourceId:string;vaultId:string;documentId:string|null};presentationHash:string};
 phase:'pending'|'applied'|'committed'|'cancelled';presentation:unknown|null;moveSource:boolean};
export type HandoffCommand=<T>(request:unknown)=>Promise<T>;
export type HandoffSource={view:NativeViewGrant;freeze:()=>void|Promise<void>;flush:()=>Promise<boolean>;
 capture:()=>Promise<{revision:string;sourceId:string;presentation:unknown}>;
 release:()=>Promise<void>;commitRelease:()=>Promise<void>;activate:()=>Promise<void>;abort:()=>Promise<void>};
export type HandoffTarget={restore:(offer:HandoffOffer)=>Promise<{revision:string;sourceId:string;snapshotId?:string}>;
 activate:()=>Promise<void>;cancel:()=>Promise<void>;failed?:(error:unknown)=>void};
const settlements=new WeakMap<HandoffCommand,Set<string>>();
/** Native settlement is idempotent even after receipt pruning. Retry only the
 * acknowledgement; local activation/cleanup has already completed. */
const settle=(command:HandoffCommand,offer:HandoffOffer)=>{
 let pending=settlements.get(command);if(!pending){pending=new Set();settlements.set(command,pending);}if(pending.has(offer.id))return;pending.add(offer.id);
 let pause=100;const held=pending;
 const attempt=async()=>{
  try{await command({op:'handoffSettled',id:offer.id});held.delete(offer.id);}
  catch{const timer=setTimeout(()=>{void attempt();},pause);pause=Math.min(pause*2,2000);(timer as unknown as {unref?:()=>void}).unref?.();}
 };
 void Promise.resolve().then(attempt);
};
/** Holds only this terminal decision and its unfinished local reconciliation.
 * A retry cannot create a new admission or revoke a committed destination. */
export class NativeHandoffRecovery extends Error {
 readonly recoveryId:string;
 readonly receipt:HandoffOffer|null;
 private resume:()=>Promise<void>;
 private pending:Promise<void>|undefined;
 private complete=false;
 private completionListeners=new Set<()=>void>();
 constructor(id:string,receipt:HandoffOffer|null,resume:()=>Promise<void>,cause:unknown){super(`窗口状态尚未恢复，可重试：${cause instanceof Error?cause.message:String(cause)}`);this.name='NativeHandoffRecovery';this.recoveryId=id;this.receipt=receipt;this.resume=resume;}
 onComplete(listener:()=>void){if(this.complete){listener();return()=>{};}this.completionListeners.add(listener);return()=>{this.completionListeners.delete(listener);};}
 retry():Promise<void>{if(this.complete)return Promise.resolve();if(this.pending)return this.pending;this.pending=this.resume().then(()=>{this.complete=true;for(const listener of this.completionListeners)listener();this.completionListeners.clear();}).finally(()=>{this.pending=undefined;});return this.pending;}
}
async function finishLocal(command:HandoffCommand,receipt:HandoffOffer|null,id:string,action:()=>Promise<void>){
 const finish=async()=>{await action();if(receipt)settle(command,receipt);};
 try{await finish();}catch(error){throw new NativeHandoffRecovery(id,receipt,finish,error);}
}
/** Own local admissions by receipt, never by a reusable target view ID. A
 * terminal poll can resume an interrupted observer, but cannot compete with a
 * live observer or its explicit local recovery. */
export class NativeHandoffAdmissions {
 private admissions=new Map<string,{offer:HandoffOffer;observing:boolean;alive:()=>boolean;cancel:()=>Promise<void>;recovery?:NativeHandoffRecovery}>();
 private finished=new Set<string>();
 private command:HandoffCommand;
 private targetWindow:string;
 constructor(command:HandoffCommand,targetWindow:string){this.command=command;this.targetWindow=targetWindow;}
 owns(id:string){const admission=this.admissions.get(id);return this.finished.has(id)||!!(admission?.observing&&(!admission.recovery||admission.alive()));}
 async receive(initial:HandoffOffer,target:HandoffTarget,alive:()=>boolean=()=>true){
  const offer=validateHandoff(initial);if(offer.targetWindow!==this.targetWindow)throw Error('workspace-handoff-target-window-mismatch');
  if(offer.phase==='cancelled')return this.cancelled(offer,alive);
  if(this.finished.has(offer.id)||this.admissions.has(offer.id))return;
  const admission:{offer:HandoffOffer;observing:boolean;alive:()=>boolean;cancel:()=>Promise<void>;recovery?:NativeHandoffRecovery}={offer,observing:true,alive,cancel:target.cancel};this.admissions.set(offer.id,admission);
  const complete=()=>{if(this.admissions.get(offer.id)===admission)this.admissions.delete(offer.id);this.finished.add(offer.id);};
  let recovering=false;
  try{return await receiveNativePresentation(this.command,offer,{...target,
   activate:async()=>{await target.activate();complete();},cancel:async()=>{await target.cancel();complete();},
  },alive);}catch(error){recovering=error instanceof NativeHandoffRecovery;if(recovering)admission.recovery=error as NativeHandoffRecovery;throw error;}
  finally{if(!recovering)admission.observing=false;}
 }
 async cancelled(initial:HandoffOffer,alive:()=>boolean=()=>true){
  const offer=validateHandoff(initial);if(offer.targetWindow!==this.targetWindow||offer.phase!=='cancelled')throw Error('workspace-handoff-cancellation-mismatch');
  if(this.owns(offer.id))return;
  const admission=this.admissions.get(offer.id);if(admission)exactHandoff(admission.offer,offer);
  // No local admission is also a valid outcome: the Pending reply may have
  // been lost, or this renderer may have booted after native target cleanup.
  if(admission){admission.observing=true;admission.alive=alive;}
  // A consumer can disappear while its cleanup awaits a renderer ACK. Keep
  // the exact retry object so the next consumer can resume or re-expose it.
  if(admission?.recovery){try{await admission.recovery.retry();return;}catch{throw admission.recovery;}}
  try{await finishLocal(this.command,offer,offer.id,async()=>{
   await admission?.cancel();
   if(this.admissions.get(offer.id)===admission)this.admissions.delete(offer.id);
   this.finished.add(offer.id);
  });}catch(error){if(admission&&error instanceof NativeHandoffRecovery)admission.recovery=error;throw error;}
 }
}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const text=(value:unknown,max=256):value is string=>typeof value==='string'&&!!value&&value.length<=max&&!/[\0\r\n]/.test(value);
export function validateHandoff(value:HandoffOffer):HandoffOffer{
 if(!value||!text(value.id,128)||!text(value.sourceWindow,128)||!text(value.targetWindow,128)||value.sourceWindow===value.targetWindow
  ||!text(value.targetViewId,128)||!text(value.sourceView?.id,128)||!['note','graph'].includes(value.sourceView.kind)
  ||value.proof?.kind!==value.sourceView.kind||value.proof.identity?.vaultId!==value.sourceView.libraryId
  ||!text(value.proof.identity.sourceId)||!text(value.proof.revision)||!/^[a-f0-9]{64}$/.test(value.proof.presentationHash)
  ||!['pending','applied','committed','cancelled'].includes(value.phase)||typeof value.moveSource!=='boolean')throw Error('workspace-handoff-invalid-receipt');
 return value;
}
/** A status is useful only for the exact admission that we opened. */
export function exactHandoff(expected:HandoffOffer,value:HandoffOffer):HandoffOffer{
 validateHandoff(value);
 if(value.id!==expected.id||value.sourceWindow!==expected.sourceWindow||value.targetWindow!==expected.targetWindow
  ||value.targetViewId!==expected.targetViewId||JSON.stringify(value.sourceView)!==JSON.stringify(expected.sourceView)
  ||JSON.stringify(value.proof)!==JSON.stringify(expected.proof)||value.moveSource!==expected.moveSource)throw Error('workspace-handoff-receipt-mismatch');
 return value;
}
/** Transport failure is not a terminal receipt. Keep the exact admission
 * alive until the broker can answer; identity mismatch still fails closed. */
async function recoverHandoff(command:HandoffCommand,offer:HandoffOffer,alive:()=>boolean=()=>true):Promise<HandoffOffer>{
 let pause=100;
 while(alive()){
  try{return exactHandoff(offer,await command<HandoffOffer>({op:'handoffRead',id:offer.id}));}
  catch(error){if(/workspace-handoff-(?:invalid-receipt|receipt-mismatch)/.test(String(error)))throw error;await delay(pause);pause=Math.min(pause*2,1000);}
 }
 throw Error('workspace-handoff-owner-unmounted');
}
/** No source unmount is permitted until a certain committed receipt. An
 * uncertain commit/cancel keeps the frozen source mounted for recovery. */
export async function transferNativePresentation(command:HandoffCommand,source:HandoffSource,moveSource=true,targetLabel?:string){
 let offer:HandoffOffer|undefined,committing=false,committed=false,beginAttempted=false;
 const requestId=globalThis.crypto.randomUUID().replace(/-/g,'');
 await source.freeze();
 try{
  if(!await source.flush())throw Error('workspace-handoff-save-or-ime-blocked');
  const captured=await source.capture();
  beginAttempted=true;
  offer=validateHandoff(await command<HandoffOffer>({op:'beginHandoff',requestId,viewId:source.view.id,revision:captured.revision,sourceId:captured.sourceId,presentation:captured.presentation,moveSource,targetLabel:targetLabel??null}));
  if(offer.sourceView.id!==source.view.id||offer.sourceView.kind!==source.view.kind||offer.sourceView.libraryId!==source.view.libraryId
   ||offer.proof.revision!==captured.revision||offer.proof.identity.sourceId!==captured.sourceId||offer.moveSource!==moveSource
   ||(targetLabel&&offer.targetWindow!==targetLabel))throw Error('workspace-handoff-source-receipt-mismatch');
  const until=Date.now()+85_000;
  while(offer.phase==='pending'){
   if(Date.now()>until)throw Error('workspace-handoff-target-restore-timeout');
   await delay(80);offer=await recoverHandoff(command,offer);
  }
  if(offer.phase!=='applied')throw Error('workspace-handoff-target-cancelled');
  if(moveSource)await source.release();
  committing=true;
  try{offer=exactHandoff(offer,await command<HandoffOffer>({op:'handoffCommit',id:offer.id}));}
  catch{
   // A lost reply is never evidence of failure. Query the same receipt.
   offer=await recoverHandoff(command,offer);
  }
  committed=offer.phase==='committed';
  if(!committed)throw Error('workspace-handoff-not-committed');
  await finishLocal(command,offer,offer.id,()=>moveSource?source.commitRelease():source.activate());
  return offer;
 }catch(error){
  if(error instanceof NativeHandoffRecovery||committed)throw error; // Local cleanup may be retried; never revoke target.
  if(!offer){
   if(beginAttempted){
    // Fence this nonce even when the initial begin is still executing. A null
    // lookup alone cannot prove that a delayed begin will not create a target.
    let pause=100;
    for(;;){
     let receipt:{requestId:string;cancelled:boolean;offer:HandoffOffer|null};
     try{receipt=await command({op:'handoffCancelRequest',requestId});}
     catch{await delay(pause);pause=Math.min(pause*2,1000);continue;}
     if(receipt?.requestId!==requestId||receipt.cancelled!==true)throw Error('workspace-handoff-begin-cancel-unconfirmed-source-retained');
     if(receipt.offer){const cancelled=validateHandoff(receipt.offer);if(cancelled.phase!=='cancelled'||cancelled.sourceView.id!==source.view.id||cancelled.sourceView.kind!==source.view.kind||cancelled.sourceView.libraryId!==source.view.libraryId)throw Error('workspace-handoff-begin-cancel-receipt-mismatch');await finishLocal(command,cancelled,requestId,()=>source.abort());}
     else await finishLocal(command,null,requestId,()=>source.abort());
     break;
    }
   }else await finishLocal(command,null,requestId,()=>source.abort());
   throw error;
  }
  let status:HandoffOffer;
  try{status=await recoverHandoff(command,offer);}
  catch{if(committing)throw Error('workspace-handoff-commit-unconfirmed-source-retained');throw Error('workspace-handoff-status-unconfirmed-source-retained');}
  if(status.phase==='committed'){await finishLocal(command,status,status.id,()=>moveSource?source.commitRelease():source.activate());return status;}
  let cancelPause=100;
  while(status.phase==='pending'||status.phase==='applied'){
   try{status=exactHandoff(offer,await command<HandoffOffer>({op:'handoffCancel',id:offer.id}));}
   catch{status=await recoverHandoff(command,offer);}
   // The cancellation may have failed before native mutation. A successful
   // nonterminal read is still unresolved: retain this admission and retry it.
   if(status.phase==='pending'||status.phase==='applied'){await delay(cancelPause);cancelPause=Math.min(cancelPause*2,1000);}
  }
  if(status.phase==='committed'){await finishLocal(command,status,status.id,()=>moveSource?source.commitRelease():source.activate());return status;}
  await finishLocal(command,status,status.id,()=>source.abort());throw error;
 }
}

/** Restoring portable presentation and renderer/service readiness are distinct
 * requirements. The target stays frozen after applied, until commit is read. */
export async function receiveNativePresentation(command:HandoffCommand,initial:HandoffOffer,target:HandoffTarget,alive:()=>boolean=()=>true){
 const offer=validateHandoff(initial);
 if(!['pending','applied'].includes(offer.phase)||!offer.presentation)throw Error('workspace-handoff-presentation-unavailable');
 let status:HandoffOffer,restored=false;
 try{
  const rendered=await target.restore(offer);
  if(!alive()||rendered.revision!==offer.proof.revision||rendered.sourceId!==offer.proof.identity.sourceId)throw Error('workspace-handoff-target-proof-mismatch');
  await command({op:'integratedReady',viewId:offer.targetViewId,...rendered,snapshotId:rendered.snapshotId??null});restored=true;
  try{status=offer.phase==='applied'?await recoverHandoff(command,offer,alive):exactHandoff(offer,await command<HandoffOffer>({op:'handoffApplied',id:offer.id,targetViewId:offer.targetViewId,revision:rendered.revision,presentationHash:offer.proof.presentationHash}));}
  catch{status=await recoverHandoff(command,offer,alive);if(status.phase!=='applied'&&status.phase!=='committed')throw Error('workspace-handoff-apply-unconfirmed');}
 }catch(error){
  target.failed?.(error);
  // Only the source can cancel. Continue observing this exact admission so a
  // failed restore does not strand a cancelled target in an existing window.
  while(alive()){
   let current:HandoffOffer;
   current=await recoverHandoff(command,offer,alive);
   if(current.phase==='cancelled'){await finishLocal(command,current,current.id,()=>target.cancel());throw error;}
   if(current.phase==='committed'){
    await finishLocal(command,current,current.id,async()=>{
     if(!restored){const rendered=await target.restore(offer);if(rendered.revision!==offer.proof.revision||rendered.sourceId!==offer.proof.identity.sourceId)throw Error('workspace-handoff-target-proof-mismatch');await command({op:'integratedReady',viewId:offer.targetViewId,...rendered,snapshotId:rendered.snapshotId??null});restored=true;}
     await target.activate();
    });return current;
   }
   await delay(150);
  }
  throw error;
 }
 while(alive()){
  if(status.phase==='committed'){await finishLocal(command,status,status.id,()=>target.activate());return status;}
  if(status.phase==='cancelled'){await finishLocal(command,status,status.id,()=>target.cancel());return status;}
  await delay(100);
  status=await recoverHandoff(command,offer,alive);
 }
 throw Error('workspace-handoff-target-unmounted');
}
