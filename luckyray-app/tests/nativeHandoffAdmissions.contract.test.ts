import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeHandoffAdmissions,NativeHandoffRecovery,type HandoffOffer,type HandoffTarget} from '../src/workspace/nativeHandoff.ts';
const offer=(phase:HandoffOffer['phase']='pending'):HandoffOffer=>({id:'admission',sourceWindow:'source',targetWindow:'target',sourceView:{id:'source-view',kind:'note',libraryId:'vault',resourceId:'A.md',title:'A'},targetViewId:'target-view',proof:{kind:'note',revision:'r1',identity:{sourceId:'scope',vaultId:'vault',documentId:'doc'},presentationHash:'a'.repeat(64)},phase,presentation:phase==='cancelled'?null:{body:'saved'},moveSource:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('lost Pending reply followed by Cancelled settles without starting a local admission',async()=>{
 const calls:unknown[]=[],owner=new NativeHandoffAdmissions(async request=>{calls.push(request);return undefined as never;},'target');
 await owner.cancelled(offer('cancelled'));await tick();
 assert.deepEqual(calls,[{op:'handoffSettled',id:'admission'}]);assert.equal(owner.owns('admission'),true);
});
test('late renderer boot never interprets a Cancelled target ID as a local ordinary view to close',async()=>{
 const ordinary={id:'target-view',draft:'newer ordinary view',closed:false};let calls=0;
 const owner=new NativeHandoffAdmissions(async()=>{calls++;return undefined as never;},'target');
 await owner.receive(offer('cancelled'),{restore:async()=>{throw Error('must not restore');},activate:async()=>{throw Error('must not activate');},cancel:async()=>{ordinary.closed=true;}});await tick();
 assert.equal(ordinary.closed,false);assert.equal(ordinary.draft,'newer ordinary view');assert.equal(calls,1);
});
test('live observer retains sole cancellation ownership when Cancelled appears in the pending poll',async()=>{
 let cancel=0,settled=0,restore!:()=>void;
 const owner=new NativeHandoffAdmissions(async(request:any)=>{if(request.op==='handoffSettled')settled++;return offer('cancelled') as never;},'target');
 const receiving=owner.receive(offer(),{restore:async()=>{await new Promise<void>(resolve=>{restore=resolve;});throw Error('cancelled during restore');},activate:async()=>{},cancel:async()=>{cancel++;}}).catch(error=>error);
 await owner.cancelled(offer('cancelled'));assert.equal(cancel,0);assert.equal(settled,0);restore();await receiving;await tick();assert.equal(cancel,1);assert.equal(settled,1);
});
test('interrupted observer retains only its exact local cleanup for a later Cancelled receipt',async()=>{
 let alive=true,cancel=0,settled=0;
 const owner=new NativeHandoffAdmissions(async(request:any)=>{if(request.op==='handoffSettled')settled++;return undefined as never;},'target');
 await assert.rejects(owner.receive(offer(),{restore:async()=>{alive=false;throw Error('renderer unmounted');},activate:async()=>{},cancel:async()=>{cancel++;}},()=>alive),/unmounted/);
 assert.equal(owner.owns('admission'),false);await owner.cancelled(offer('cancelled'));await tick();assert.equal(cancel,1);assert.equal(settled,1);
});
test('interrupted cancellation cleanup retains recovery ownership and settles after successful retry',async()=>{
 let cancel=0,settled=0;
 const owner=new NativeHandoffAdmissions(async(request:any)=>{if(request.op==='handoffSettled')settled++;return undefined as never;},'target');
 const target:HandoffTarget={restore:async()=>{throw Error('unmounted');},activate:async()=>{},cancel:async()=>{if(++cancel===1)throw Error('layout acknowledgement pending');}};
 await assert.rejects(owner.receive(offer(),target,()=>false),/unmounted/);
 const recovery=await owner.cancelled(offer('cancelled')).catch(error=>error);assert.ok(recovery instanceof NativeHandoffRecovery);assert.equal(owner.owns('admission'),true);
 await owner.cancelled(offer('cancelled'));assert.equal(cancel,1);assert.equal(settled,0);await recovery.retry();await tick();assert.equal(cancel,2);assert.equal(settled,1);
});
test('cancelled receipt must match the retained admission and authenticated target window',async()=>{
 let cancel=0;const owner=new NativeHandoffAdmissions(async()=>undefined as never,'target');
 await assert.rejects(owner.receive(offer(),{restore:async()=>{throw Error('unmounted');},activate:async()=>{},cancel:async()=>{cancel++;}},()=>false));
 await assert.rejects(owner.cancelled({...offer('cancelled'),targetViewId:'replacement'}),/receipt-mismatch/);
 await assert.rejects(owner.cancelled({...offer('cancelled'),targetWindow:'elsewhere'}),/cancellation-mismatch/);assert.equal(cancel,0);
});
test('cleanup rejection after consumer unmount is retained and retried by the next Cancelled observer',async()=>{
 let alive=true,cancel=0,settled=0,rejectCleanup!:(error:Error)=>void;const visible:unknown[]=[];
 const owner=new NativeHandoffAdmissions(async(request:any)=>{if(request.op==='handoffSettled')settled++;return offer('cancelled') as never;},'target');
 const receiving=owner.receive(offer(),{restore:async()=>{throw Error('render failed');},activate:async()=>{},cancel:async()=>{if(++cancel===1)await new Promise<void>((_,reject)=>{rejectCleanup=reject;});}},()=>alive).catch(error=>{if(alive)visible.push(error);return error;});
 await tick();assert.equal(owner.owns('admission'),true);alive=false;assert.equal(owner.owns('admission'),true);rejectCleanup(Error('late cleanup ACK failed'));const recovery=await receiving;
 assert.ok(recovery instanceof NativeHandoffRecovery);assert.equal(visible.length,0);assert.equal(owner.owns('admission'),false);assert.equal(settled,0);
 await owner.cancelled(offer('cancelled'),()=>true);await tick();assert.equal(cancel,2);assert.equal(settled,1);assert.equal(owner.owns('admission'),true);
});
test('new consumer re-exposes the same retained recovery when its exact retry still fails',async()=>{
 let alive=false,cancel=0;const owner=new NativeHandoffAdmissions(async()=>undefined as never,'target');
 await assert.rejects(owner.receive(offer(),{restore:async()=>{throw Error('unmounted');},activate:async()=>{},cancel:async()=>{cancel++;throw Error('needs renderer acknowledgement');}},()=>alive));
 const first=await owner.cancelled(offer('cancelled'),()=>alive).catch(error=>error);assert.ok(first instanceof NativeHandoffRecovery);assert.equal(owner.owns('admission'),false);
 const next=await owner.cancelled(offer('cancelled'),()=>true).catch(error=>error);assert.equal(next,first);assert.equal(cancel,2);assert.equal(owner.owns('admission'),true);
});
test('lost target settlement retries only the terminal acknowledgement after local cleanup',async()=>{
 let attempts=0,cleanups=0;const owner=new NativeHandoffAdmissions(async(request:any)=>{if(request.op==='handoffSettled'&&++attempts===1)throw Error('settlement reply lost');return offer('cancelled') as never;},'target');
 await assert.rejects(owner.receive(offer(),{restore:async()=>{throw Error('restore rejected');},activate:async()=>{},cancel:async()=>{cleanups++;}}));
 assert.equal(cleanups,1);assert.equal(owner.owns('admission'),true);await owner.cancelled(offer('cancelled'));await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(attempts,2);assert.equal(cleanups,1);
});
