import test from 'node:test';import assert from 'node:assert/strict';
import {beginTaskContext,recordTaskReceipt,validTaskContext,taskContextForModel} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-task-state.mjs';
test('exact goal constraints survive while receipts preserve pending/uncertain completion',()=>{
 let task=beginTaskContext(null,{canvasId:'c',conversationId:'v',prompt:'Make 3 shots. Do not generate media. Preserve camera roll.'});
 task=recordTaskReceipt(task,{actionId:'a',kind:'openCreation'},{status:'completed',summary:'Panel open only',creation:{completion:'awaiting-user',revision:'0123456789abcdef'}});
 task=recordTaskReceipt(task,{actionId:'b',kind:'editCreation'},{status:'failed',summary:'Changed in memory; save unknown',creation:{completion:'applied-unconfirmed',revision:'0123456789abcdef'}});
 assert.equal(task.receipts[0].completion,'awaiting-user');assert.equal(task.receipts[1].completion,'applied-unconfirmed');assert.equal(validTaskContext(task,'c','v'),true);assert.equal(taskContextForModel(task).goal,task.goal);
 assert.equal(beginTaskContext(task,{canvasId:'c',conversationId:'new',prompt:'New task'}).receipts.length,0);
 const resumed=beginTaskContext(task,{canvasId:'c',conversationId:'v',prompt:'Continue, but do not capture'});assert.equal(resumed.receipts.length,2);assert.equal(resumed.goal,'Continue, but do not capture');
});
test('receipt aid is bounded, deduplicated and marks clipped summaries, never claims model generation',()=>{
 let task=beginTaskContext(null,{canvasId:'c',conversationId:'v',prompt:'Goal'});
 for(let i=0;i<40;i++)task=recordTaskReceipt(task,{actionId:'a'+i,kind:'editCreation'},{status:'completed',summary:'x'.repeat(1400),nodes:[{id:'node'}]});
 assert.equal(task.receipts.length,32);assert.equal(task.receipts[0].summaryTruncated,true);assert.equal(task.receipts[0].summary.length,1200);assert.equal(task.receipts[0].generatedJobs,undefined);
 task=recordTaskReceipt(task,{actionId:'a39',kind:'editCreation'},{status:'failed',summary:'No commit'});assert.equal(task.receipts.length,32);assert.equal(task.receipts.at(-1).status,'failed');
});
