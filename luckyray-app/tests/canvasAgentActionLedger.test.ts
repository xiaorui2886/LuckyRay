import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvasActionLedger} from '../src/core/canvas/agent/actionLedger.ts';
const policy={mode:'autonomous' as const,allowGeneration:true,maxMediaJobs:2};
const action={actionId:'a1',runId:'r1',kind:'applyPlan',generate:true,plan:{steps:[{kind:'image'}]},execution:policy};
test('lost acknowledgement returns same promise, never executes a paid action twice',async()=>{
 const ledger=createCanvasActionLedger<number>(); let count=0;
 const first=ledger.run(action,async()=>++count),second=ledger.run(action,async()=>++count);
 assert.equal(first,second);assert.equal(await first,1);assert.equal(count,1);
});
test('uncertain failed work retains reservation and cannot exceed run budget',async()=>{
 const ledger=createCanvasActionLedger<number>();
 await assert.rejects(ledger.run({...action,execution:{...policy,maxMediaJobs:1}},async()=>{throw Error('lost provider response');}));
 assert.equal(ledger.reserved('r1'),1);
 await assert.rejects(ledger.run({...action,actionId:'a2',execution:{...policy,maxMediaJobs:1}},async()=>42),/budget/);
});
test('read works without edit permission, edits and generation require explicit scope',async()=>{
 const ledger=createCanvasActionLedger<number>();
 assert.equal(await ledger.run({actionId:'read',runId:'r1',kind:'readContext'},async()=>1),1);
 await assert.rejects(ledger.run({...action,execution:undefined},async()=>2),/not-authorized/);
 await assert.rejects(ledger.run({...action,execution:{...policy,allowGeneration:false}},async()=>2),/budget/);
});
test('same action identifier with different arguments is rejected',async()=>{
 const ledger=createCanvasActionLedger<number>();await ledger.run(action,async()=>1);
 await assert.rejects(ledger.run({...action,generate:false},async()=>2),/conflict/);
});

test('authorization budget cannot grow during a run',async()=>{
 const ledger=createCanvasActionLedger<number>();await ledger.run(action,async()=>1);
 await assert.rejects(ledger.run({...action,actionId:'a2',execution:{...policy,maxMediaJobs:20}},async()=>2),/policy-changed/);
});
