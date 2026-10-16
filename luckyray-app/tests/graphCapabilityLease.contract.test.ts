import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphCapabilityLease, type GraphCapabilitySnapshot } from '../src/workspace/graphCapabilityLease.ts';
const all: GraphCapabilitySnapshot = { kinds: ['openDocument','createMissing','openTag','openCatalogAsset','composeAi','fileOperation','screenshot'], expiresInMs: 30000 };
function clock() { let now=0, sequence=0; const queued=new Map<number,()=>void>(); return { clock:{now:()=>now,set:(cb:()=>void,_delay:number)=>{queued.set(++sequence,cb);return sequence;},clear:(id:unknown)=>{queued.delete(id as number);}}, advance:(ms:number)=>{now+=ms;},fire:()=>{const callbacks=[...queued.values()];queued.clear();callbacks.forEach(cb=>cb());},queued }; }
test('lease is unavailable before reply, expires synchronously, and revokes readiness once', async()=>{
 const c=clock();const lease=createGraphCapabilityLease(async()=>all,c.clock);let notifications=0;lease.subscribe(()=>notifications++);
 assert.equal(lease.has('openDocument'),false);await lease.refresh();assert.equal(lease.has('openDocument'),true);assert.equal(notifications,1);
 c.advance(30001);assert.equal(lease.has('openDocument'),false,'deadline guards callers even before a delayed timer');c.fire();assert.equal(notifications,2);
 await lease.refresh();assert.equal(lease.has('openDocument'),true);assert.equal(notifications,3);lease.dispose();assert.equal(notifications,4);assert.equal(c.queued.size,0);
});
test('renewal preserves readiness, counts network latency, and rejects malformed or failed leases',async()=>{
 const c=clock();let response:GraphCapabilitySnapshot=all;let fail=false;
 const lease=createGraphCapabilityLease(async()=>{if(fail)throw Error('offline');return response;},c.clock);let notifications=0;lease.subscribe(()=>notifications++);
 await lease.refresh();c.advance(10000);await lease.refresh();assert.equal(notifications,1,'renewal does not invalidate an already painted scene');
 fail=true;await assert.rejects(lease.refresh(),/offline/);assert.equal(lease.has('screenshot'),false);assert.equal(notifications,2);
 fail=false;response={...all,expiresInMs:30001};await assert.rejects(lease.refresh(),/invalid/);assert.equal(lease.current().length,0);
 let finish!:(value:GraphCapabilitySnapshot)=>void;const delayed=createGraphCapabilityLease(()=>new Promise(resolve=>{finish=resolve;}),c.clock);
 const pending=delayed.refresh();c.advance(30001);finish(all);await pending;assert.equal(delayed.has('openTag'),false);
 lease.dispose();delayed.dispose();
});
test('superseded or disposed capability replies cannot resurrect service coverage',async()=>{
 const c=clock(), replies:Array<(value:GraphCapabilitySnapshot)=>void>=[];
 const lease=createGraphCapabilityLease(()=>new Promise(resolve=>replies.push(resolve)),c.clock);
 const old=lease.refresh(),fresh=lease.refresh();replies[1]({kinds:['screenshot'],expiresInMs:1000});await fresh;replies[0](all);await old;
 assert.deepEqual(lease.current(),['screenshot']);const last=lease.refresh();lease.dispose();replies[2](all);await last;assert.deepEqual(lease.current(),[]);
});
