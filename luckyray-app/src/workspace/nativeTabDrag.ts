/** The host must not enable this before packaged Windows acceptance. This client
 * carries an opaque gesture ticket, never paths, grant data or screen coords. */
export const PRODUCTION_PHYSICAL_TEAROUT_VERIFIED = false;
export type NativeDropIntent = {kind:'newWindow';physicalX:number;physicalY:number}|{kind:'existingWindow';label:string};
export type NativeTabGestureTransport={
 begin:(viewId:string)=>Promise<{ticket:string}>;
 finish:(ticket:string)=>Promise<NativeDropIntent>;
 cancel:(ticket:string)=>Promise<unknown>;
};
/** Call begin only from the actual primary tab pointerdown, cancel on Escape,
 * blur/pointercancel/lost capture, and release only from a real pointerup after
 * the local drag threshold. Neither lost capture nor dragend is a release. */
export function createNativeTabGesture(transport:NativeTabGestureTransport,enabled=PRODUCTION_PHYSICAL_TEAROUT_VERIFIED){
 let sequence=0;
 let active:{sequence:number;viewId:string;ready:Promise<{ticket:string}>}|null=null;
 const revoke=(pending:NonNullable<typeof active>)=>{void pending.ready.then(({ticket})=>transport.cancel(ticket)).catch(()=>{});};
 const cancel=()=>{sequence++;const pending=active;active=null;if(pending)revoke(pending);};
 return {
  begin(viewId:string){
   cancel();if(!enabled||!viewId)return false;
   const generation=sequence;
   const ready=transport.begin(viewId);
   const pending={sequence:generation,viewId,ready};active=pending;
   void ready.catch(()=>{if(active===pending)active=null;});
   return true;
  },
  cancel,
  async release(moved:boolean,onVerifiedDrop:(viewId:string,intent:NativeDropIntent)=>Promise<void>){
   const pending=active;
   if(!pending)return false;
   if(!moved){cancel();return false;}
   try{
    const {ticket}=await pending.ready;
    if(active!==pending||sequence!==pending.sequence){await transport.cancel(ticket);return false;}
    const intent=await transport.finish(ticket);
    if(active!==pending||sequence!==pending.sequence)return false;
    active=null;
    // This only hands a proven intent to the existing safe transfer owner.
    // The owner retains its source until mounted revision/flush ACK completes.
    await onVerifiedDrop(pending.viewId,intent);
    return true;
   }catch(error){if(active===pending)active=null;revoke(pending);throw error;}
  },
 };
}
