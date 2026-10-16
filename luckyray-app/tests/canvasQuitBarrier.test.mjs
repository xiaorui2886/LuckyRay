import test from 'node:test';
import assert from 'node:assert/strict';
import {flushCanvasBeforeQuit} from '../src/features/canvas/canvasQuitBarrier.ts';

test('hidden dirty canvas waits for its existing writer and exact durable generation', async () => {
  let state = {canvasId:'synthetic',loadEpoch:4,editing:7,saved:6,writing:false,blocked:false};
  let finish, calls=0;
  const pending = flushCanvasBeforeQuit(() => state, async () => {
    calls++; state={...state,writing:true};
    await new Promise(resolve => {finish=resolve;});
    state={...state,saved:7,writing:false};
  });
  assert.equal(calls,1);
  let complete=false; pending.then(() => {complete=true;});
  await Promise.resolve(); assert.equal(complete,false);
  finish(); assert.equal(await pending,true);
});

test('clean canvas needs no write, but active generation or loading blocks without cancellation', async () => {
  let state={canvasId:'synthetic',loadEpoch:1,editing:2,saved:2,writing:false,blocked:false};
  let writes=0;
  const persist=async()=>{writes++;};
  assert.equal(await flushCanvasBeforeQuit(()=>state,persist),true);
  state={...state,blocked:true};
  assert.equal(await flushCanvasBeforeQuit(()=>state,persist),false);
  assert.equal(writes,0);
});

test('failure, stale completion, identity change and work starting during IO cannot authorize exit', async () => {
  for (const outcome of ['failure','stale','identity','epoch','writing','task']) {
    let state={canvasId:'synthetic',loadEpoch:1,editing:2,saved:1,writing:false,blocked:false};
    const persist=async()=>{
      if(outcome==='failure')throw Error('controlled save failure');
      state={...state,saved:2};
      if(outcome==='stale')state.editing++;
      if(outcome==='identity')state.canvasId='different';
      if(outcome==='epoch')state.loadEpoch++;
      if(outcome==='writing')state.writing=true;
      if(outcome==='task')state.blocked=true;
    };
    assert.equal(await flushCanvasBeforeQuit(()=>state,persist),false,outcome);
  }
});
