import test from 'node:test';
import assert from 'node:assert/strict';
import {transferNativePresentation,receiveNativePresentation,type HandoffOffer,type HandoffSource} from '../src/workspace/nativeHandoff.ts';
const view={id:'source-view',kind:'note',libraryId:'vault',resourceId:'A.md',title:'A'};
const offer=(phase:HandoffOffer['phase']='pending'):HandoffOffer=>({id:'offer-1',sourceWindow:'main',targetWindow:'workspace-child',sourceView:view,targetViewId:'different-target-id',proof:{kind:'note',revision:'r1',identity:{sourceId:'source',vaultId:'vault',documentId:'doc'},presentationHash:'a'.repeat(64)},phase,presentation:{version:1,selection:[2,3]},moveSource:true});
function source(calls:string[]):HandoffSource{return {view,freeze:()=>{calls.push('freeze');},flush:async()=>{calls.push('flush');return true;},capture:async()=>{calls.push('capture');return {revision:'r1',sourceId:'source',presentation:{version:1,selection:[2,3]}};},release:async()=>{calls.push('park');},commitRelease:async()=>{calls.push('destroy-source');},activate:async()=>{calls.push('activate-source');},abort:async()=>{calls.push('restore-source');}};}
test('source parks only after exact target applied and destroys only after commit',async()=>{
 const calls:string[]=[];const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return (request.op==='beginHandoff'?offer():request.op==='handoffRead'?offer('applied'):offer('committed')) as T;};
 const done=await transferNativePresentation(command,source(calls));assert.equal(done.targetViewId,'different-target-id');assert.deepEqual(calls,['freeze','flush','capture','beginHandoff','handoffRead','park','handoffCommit','destroy-source','handoffSettled']);
});
test('lost commit reply polls exact status and does not cancel a committed target',async()=>{
 const calls:string[]=[];let committed=false;const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);if(request.op==='handoffCommit'){committed=true;throw Error('reply lost');}return (request.op==='beginHandoff'?offer():offer(committed?'committed':'applied')) as T;};
 await transferNativePresentation(command,source(calls));assert.equal(calls.includes('handoffCancel'),false);assert.equal(calls.filter(call=>call!=='handoffSettled').at(-1),'destroy-source');assert.equal(calls.filter(op=>op==='handoffCommit').length,1);
});
test('failed local release cancels only its admission and restores source',async()=>{
 const calls:string[]=[];const owner=source(calls);owner.release=async()=>{calls.push('park-failed');throw Error('park failed');};
 const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return (request.op==='beginHandoff'?offer():offer(request.op==='handoffCancel'?'cancelled':'applied')) as T;};
 await assert.rejects(transferNativePresentation(command,owner),/park failed/);assert.equal(calls.includes('destroy-source'),false);assert.equal(calls.includes('handoffCommit'),false);assert.equal(calls.filter(call=>call!=='handoffSettled').at(-1),'restore-source');
});
test('copy commits presentation while retaining and reactivating source',async()=>{
 const calls:string[]=[];const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return {...offer(request.op==='beginHandoff'?'pending':request.op==='handoffRead'?'applied':'committed'),moveSource:false} as T;};
 await transferNativePresentation(command,source(calls),false);assert.equal(calls.includes('park'),false);assert.equal(calls.includes('destroy-source'),false);assert.equal(calls.filter(call=>call!=='handoffSettled').at(-1),'activate-source');
});
test('forged target receipt never retires or unlocks source on uncertain cleanup',async()=>{
 const calls:string[]=[];const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return (request.op==='beginHandoff'?offer():{...offer('committed'),targetViewId:'wrong-target'}) as T;};
 await assert.rejects(transferNativePresentation(command,source(calls)),/unconfirmed/);assert.equal(calls.includes('destroy-source'),false);assert.equal(calls.includes('restore-source'),false);
});
test('target awaits real presentation restore before ready/applied and remains frozen until commit',async()=>{
 const calls:string[]=[];let restore!:()=>void;const restored=new Promise<void>(resolve=>restore=resolve);
 const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return offer(request.op==='handoffApplied'?'applied':'committed') as T;};
 const work=receiveNativePresentation(command,offer(),{restore:async()=>{calls.push('restore-start');await restored;calls.push('restore-painted');return {revision:'r1',sourceId:'source'};},activate:async()=>{calls.push('activate');},cancel:async()=>{calls.push('cancel');}});
 await Promise.resolve();assert.deepEqual(calls,['restore-start']);restore();await work;assert.deepEqual(calls,['restore-start','restore-painted','integratedReady','handoffApplied','handoffRead','activate','handoffSettled']);
});
test('target wrong revision cannot emit readiness or applied ACK',async()=>{
 const calls:string[]=[];const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return offer('cancelled') as T;};
 await assert.rejects(receiveNativePresentation(command,offer(),{restore:async()=>({revision:'wrong',sourceId:'source'}),activate:async()=>{calls.push('activate');},cancel:async()=>{calls.push('cancel');}}),/proof-mismatch/);
 assert.equal(calls.includes('integratedReady'),false);assert.equal(calls.includes('handoffApplied'),false);assert.equal(calls.includes('activate'),false);
});
test('an applied admission reload restores and re-proves presentation without a second applied transition',async()=>{
 const calls:string[]=[];const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return offer('committed') as T;};
 await receiveNativePresentation(command,offer('applied'),{restore:async()=>{calls.push('restore');return {revision:'r1',sourceId:'source'};},activate:async()=>{calls.push('activate');},cancel:async()=>{calls.push('cancel');}});
 assert.deepEqual(calls,['restore','integratedReady','handoffRead','activate','handoffSettled']);
});
test('failed target restore still observes source cancellation and cleans only admitted target',async()=>{
 const calls:string[]=[];const command=async<T>(request:any):Promise<T>=>{calls.push(`${request.op}:${request.id}`);return offer('cancelled') as T;};
 await assert.rejects(receiveNativePresentation(command,offer(),{restore:async()=>{throw Error('media restore failed');},failed:()=>{calls.push('report');},activate:async()=>{calls.push('activate');},cancel:async()=>{calls.push('cancel-own-admission');}}),/media restore failed/);
 assert.deepEqual(calls,['report','handoffRead:offer-1','cancel-own-admission','handoffSettled:offer-1']);
});
test('target recovers a transient post-applied status failure and activates certain commit',async()=>{
 const calls:string[]=[];let reads=0;const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);if(request.op==='handoffRead'&&++reads===1)throw Error('temporary transport failure');return offer(request.op==='handoffApplied'?'applied':'committed') as T;};
 await receiveNativePresentation(command,offer(),{restore:async()=>({revision:'r1',sourceId:'source'}),activate:async()=>{calls.push('activate');},cancel:async()=>{calls.push('cancel');}});
 assert.equal(reads,2);assert.equal(calls.filter(call=>call!=='handoffSettled').at(-1),'activate');assert.equal(calls.includes('cancel'),false);
});
test('target recovers transient post-applied status failure and removes cancelled admission',async()=>{
 const calls:string[]=[];let reads=0;const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);if(request.op==='handoffRead'&&++reads===1)throw Error('temporary transport failure');return offer(request.op==='handoffApplied'?'applied':'cancelled') as T;};
 await receiveNativePresentation(command,offer(),{restore:async()=>({revision:'r1',sourceId:'source'}),activate:async()=>{calls.push('activate');},cancel:async()=>{calls.push('cancel');}});
 assert.equal(reads,2);assert.equal(calls.filter(call=>call!=='handoffSettled').at(-1),'cancel');assert.equal(calls.includes('activate'),false);
});
test('lost initial admission reply fences exact request before unfreezing the retained source',async()=>{
 const calls:string[]=[];let nonce='';const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);if(request.op==='beginHandoff'){nonce=request.requestId;assert.match(nonce,/^[a-f0-9]{32}$/);throw Error('begin reply lost');}if(request.op==='handoffCancelRequest'){assert.equal(request.requestId,nonce);return {requestId:nonce,cancelled:true,offer:offer('cancelled')} as T;}return undefined as T;};
 await assert.rejects(transferNativePresentation(command,source(calls)),/begin reply lost/);assert.deepEqual(calls,['freeze','flush','capture','beginHandoff','handoffCancelRequest','restore-source','handoffSettled']);assert.equal(calls.includes('destroy-source'),false);
});
test('lost initial admission cancellation receipt retries exact nonce while source stays frozen',async()=>{
 const calls:string[]=[];let nonce='',cancels=0;const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);if(request.op==='beginHandoff'){nonce=request.requestId;throw Error('begin reply lost');}if(request.op==='handoffCancelRequest'){assert.equal(request.requestId,nonce);assert.equal(calls.includes('restore-source'),false);if(++cancels===1)throw Error('cancel reply lost');return {requestId:nonce,cancelled:true,offer:null} as T;}return undefined as T;};
 await assert.rejects(transferNativePresentation(command,source(calls)),/begin reply lost/);assert.equal(cancels,2);assert.equal(calls.at(-1),'restore-source');
});
test('committed copy with failed local activation retains exact decision and retries no native admission',async()=>{
 const calls:string[]=[];let activations=0;const local=source(calls);local.activate=async()=>{calls.push('activate-source');if(++activations===1)throw Error('media needs user gesture');};
 const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return {...offer(request.op==='beginHandoff'?'pending':request.op==='handoffRead'?'applied':'committed'),moveSource:false} as T;};
 const recovery=await transferNativePresentation(command,local,false).catch(error=>error);assert.equal(recovery.name,'NativeHandoffRecovery');assert.equal(recovery.receipt.phase,'committed');assert.equal(calls.includes('handoffSettled'),false);await recovery.retry();await Promise.resolve();
 assert.equal(activations,2);assert.equal(calls.filter(call=>call==='beginHandoff').length,1);assert.equal(calls.includes('handoffCancel'),false);assert.equal(calls.at(-1),'handoffSettled');
});
test('cancelled target local cleanup failure is retryable without re-admission or early settlement',async()=>{
 const calls:string[]=[];let attempts=0;const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);return offer(request.op==='handoffApplied'?'applied':'cancelled') as T;};
 const recovery=await receiveNativePresentation(command,offer(),{restore:async()=>({revision:'r1',sourceId:'source'}),activate:async()=>{calls.push('activate');},cancel:async()=>{calls.push('cancel');if(++attempts===1)throw Error('local release pending');}}).catch(error=>error);
 assert.equal(recovery.name,'NativeHandoffRecovery');assert.equal(recovery.receipt.phase,'cancelled');assert.equal(calls.includes('handoffSettled'),false);await recovery.retry();await Promise.resolve();assert.equal(attempts,2);assert.equal(calls.at(-1),'handoffSettled');
});
test('cancel failure before native mutation retries exact applied admission before source rollback',async()=>{
 const calls:string[]=[];let cancels=0;const local=source(calls);local.release=async()=>{calls.push('park-failed');throw Error('park failed');};
 const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);if(request.op==='beginHandoff')return offer() as T;if(request.op==='handoffCancel'){assert.equal(request.id,'offer-1');assert.equal(calls.includes('restore-source'),false);if(++cancels===1)throw Error('cancel transport failed before mutation');return offer('cancelled') as T;}if(request.op==='handoffRead'){assert.equal(request.id,'offer-1');return offer('applied') as T;}return undefined as T;};
 await assert.rejects(transferNativePresentation(command,local),/park failed/);assert.equal(cancels,2);assert.equal(calls.filter(call=>call==='beginHandoff').length,1);assert.equal(calls.filter(call=>call==='restore-source').length,1);assert.equal(calls.includes('destroy-source'),false);assert.equal(calls.includes('handoffCommit'),false);assert.equal(calls.at(-1),'handoffSettled');
});
test('lost source settlement retries only acknowledgement without repeating commit or source destruction',async()=>{
 const calls:string[]=[];let settlements=0;const command=async<T>(request:any):Promise<T>=>{calls.push(request.op);if(request.op==='handoffSettled'&&++settlements===1)throw Error('settlement transport lost');return offer(request.op==='beginHandoff'?'pending':request.op==='handoffRead'?'applied':'committed') as T;};
 await transferNativePresentation(command,source(calls));await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(settlements,2);assert.equal(calls.filter(call=>call==='destroy-source').length,1);assert.equal(calls.filter(call=>call==='handoffCommit').length,1);assert.equal(calls.filter(call=>call==='beginHandoff').length,1);
});
