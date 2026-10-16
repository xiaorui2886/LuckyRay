import test from 'node:test';import assert from 'node:assert/strict';
import {transferView,type TransferPort} from '../src/workspace/windowTransfer.ts';
const view={id:'v',kind:'note' as const,title:'N',library:{kind:'knowledge' as const,id:'A'},resourceId:'n.md'};
for(const failure of ['flush','open','ready','second-flush','cancel','cleanup','revision','ack','changed-during-ack'])test(`transfer retains source on ${failure}`,async()=>{
 const calls:string[]=[];const controller=new AbortController();let flushes=0;
 let revision='r1';
 const port:TransferPort={revision:()=>failure==='revision'?null:revision,waitRevision:async()=>{if(failure==='changed-during-ack')revision='r2';return failure!=='ack';},flush:async()=>{calls.push('flush');flushes++;return failure!=='flush'&&!(failure==='second-flush'&&flushes===2);},open:async()=>{calls.push('open');if(failure==='open')throw Error('window failed');return {label:'w',viewId:'v'};},waitReady:async()=>{calls.push('ready');if(failure==='cancel')controller.abort();return !['ready','cleanup'].includes(failure);},removeSource:()=>{calls.push('remove');},cancelTarget:async()=>{calls.push('cancelTarget');if(failure==='cleanup')throw Error('already closed');}};
 assert.equal((await transferView(view,true,port,controller.signal)).ok,false);assert.ok(!calls.includes('remove'));
});
test('successful move removes source only after readiness and final flush',async()=>{
 const calls:string[]=[];const port:TransferPort={revision:()=> 'r1',waitRevision:async(_target,revision)=>{assert.equal(revision,'r1');calls.push('ack');return true;},flush:async()=>{calls.push('flush');return true;},open:async()=>{calls.push('open');return {label:'w',viewId:'v'};},waitReady:async()=>{calls.push('ready');return true;},removeSource:()=>{calls.push('remove');},cancelTarget:async()=>{throw Error('not expected');}};
 assert.equal((await transferView(view,true,port,new AbortController().signal)).ok,true);assert.deepEqual(calls,['flush','open','ready','flush','ack','remove']);calls.length=0;await transferView(view,false,port,new AbortController().signal);assert.ok(!calls.includes('remove'));
});
test('native move waits for asynchronous source-close confirmation and reports refusal',async()=>{
 let finish:()=>void=()=>{};let settled=false;
 const port:TransferPort={revision:()=> 'r1',waitRevision:async()=>true,flush:async()=>true,open:async()=>({label:'w',viewId:'v'}),waitReady:async()=>true,removeSource:()=>new Promise<void>(resolve=>{finish=resolve;}),cancelTarget:async()=>{}};
 const moving=transferView(view,true,port,new AbortController().signal).then(result=>{settled=true;return result;});
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(settled,false);finish();assert.equal((await moving).ok,true);
 port.removeSource=async()=>{throw Error('native close refused');};
 const refused=await transferView(view,true,port,new AbortController().signal);assert.equal(refused.ok,false);assert.match(refused.error!,/native close refused/);
});
