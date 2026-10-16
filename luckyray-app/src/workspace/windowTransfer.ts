import type {ViewRef} from './layout';
export type TransferTarget={label:string;viewId:string};
export type TransferPort={
  flush:(view:ViewRef)=>Promise<boolean>;
  open:(view:ViewRef)=>Promise<TransferTarget>;
  waitReady:(target:TransferTarget,signal:AbortSignal)=>Promise<boolean>;
  revision:()=>string|null;
  waitRevision:(target:TransferTarget,revision:string,signal:AbortSignal)=>Promise<boolean>;
  removeSource:(view:ViewRef)=>void|Promise<void>;
  cancelTarget:(target:TransferTarget)=>Promise<void>;
};
/** Two-phase handoff. No source removal on an unacknowledged or canceled target.
 * Source version checks are supplied by flush and the caller's transfer lease.
 */
export async function transferView(view:ViewRef,move:boolean,port:TransferPort,signal:AbortSignal):Promise<{ok:boolean;error?:string}>{
 let target:TransferTarget|undefined;
 try{
  if(signal.aborted||!await port.flush(view))return {ok:false,error:'原标签尚未保存，已保留。'};
  if(signal.aborted)return {ok:false,error:'已取消，原标签仍在。'};
  target=await port.open(view);
  if(signal.aborted||!await port.waitReady(target,signal)||signal.aborted)throw Error('目标窗口尚未确认接收，原标签仍在。');
  if(move){
   if(!await port.flush(view)||signal.aborted)throw Error('新的输入尚未保存，原标签仍在。');
   const revision=port.revision();
   if(!revision||!await port.waitRevision(target,revision,signal)||signal.aborted||port.revision()!==revision)throw Error('目标窗口尚未显示最后一次保存，原标签仍在。');
   await port.removeSource(view);
  }
  return {ok:true};
 }catch(error){if(target){try{await port.cancelTarget(target);}catch{/* An initialized target can remain open; never discard source for cleanup failure. */}}return {ok:false,error:String(error)};}
}
