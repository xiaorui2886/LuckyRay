const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Optional DOM tooling is external to the application and adds no production dependency.
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const { JSDOM } = requireTool('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas-agent.invalid' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator']) {
  Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
}
// Deterministic SHA-256 keeps existing hook scheduling tests independent of libuv timing.
const nativeCrypto = require('node:crypto');
const defaultDigest = async (_algorithm, bytes) => nativeCrypto.createHash('sha256').update(bytes).digest();
Object.defineProperty(global, 'crypto', { configurable: true, value: { randomUUID: nativeCrypto.randomUUID, subtle: { digest: defaultDigest } } });
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const appRoot = path.resolve(__dirname, '../../..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(appRoot, 'node_modules/vite'))] }));
const built = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'useCanvasAgent.ts')], bundle: true, write: false,
  platform: 'node', format: 'cjs', packages: 'external', external: ['../../core/services/canvasAgent'] });
const loaded = { exports: {} };
let dispatch, prepare;
new Function('module', 'exports', 'require', built.outputFiles[0].text)(loaded, loaded.exports, name => name === '../../core/services/canvasAgent'
  ? { canvasAgentClient: { dispatch: request => dispatch(request) }, prepareCanvasAgentHost: () => prepare() } : require(name));
const { useCanvasAgent } = loaded.exports;
const context = canvasId => ({ version: 1, canvasId, canvasName: canvasId, nodes: [], connections: [],
  generation: { imageModels: [], videoModels: [], imageReady: false, videoReady: false } });
const snapshot = (canvasId, status = 'idle', extra = {}) => ({ canvasId, conversationId: 'conversation-1', sessionId: null, runId: status === 'idle' ? null : 'run-1', status, messages: [], ...extra });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle(operation = () => {}) { await React.act(async () => { await operation(); }); }
async function mount(options = {}) {
  const calls = [];
  dispatch = async request => { calls.push(request); return options.dispatch ? options.dispatch(request) : snapshot(request.canvasId); };
  prepare = options.prepare || (async () => {});
  let value, props = { canvasId: 'canvas-a', enabled: true, getContext: async () => context(props.canvasId), ...options.props };
  const root = createRoot(document.getElementById('root'));
  function Host() { value = useCanvasAgent(props.canvasId, props.enabled, props.getContext, props.executeAction); return null; }
  const render=()=>options.strict?React.createElement(React.StrictMode,null,React.createElement(Host)):React.createElement(Host);
  await settle(() => root.render(render()));
  return { calls, get value() { return value; }, async update(next) { props = { ...props, ...next }; await settle(() => root.render(render())); },
    async unmount() { await settle(() => root.unmount()); } };
}

test('initial host failure stays unavailable until an explicit read-only reconnect succeeds', async () => {
  let offline = true;
  const app = await mount({ dispatch: request => {
    if (offline) throw Error('canvas-agent-not-ready');
    return snapshot(request.canvasId);
  } });
  try {
    assert.equal(app.value.availability, 'unavailable');
    assert.equal(app.value.checking, false);
    assert.equal(app.value.snapshot, null);
    assert.equal(app.value.error, 'canvas-agent-not-ready');
    offline = false;
    await settle(() => app.value.refresh());
    assert.equal(app.value.availability, 'ready');
    assert.equal(app.value.error, '');
    assert.ok(app.calls.every(request => ['status','models'].includes(request.op)), 'reconnect must not start a model turn');
  } finally { await app.unmount(); }
});

test('initial catalog and refresh wait for status on the single-operation Windows host', async () => {
  const models = { available: [{ provider: 'lsh', model: 'chosen', label: 'LSH chosen', inputModalities: ['text'] }],
    defaultModel: { provider: 'lsh', model: 'chosen' }, currentModel: null };
  let gate = deferred(), held = false, overlaps = 0;
  const app = await mount({ dispatch: async request => {
    if (held) { overlaps++; throw Error('canvas-agent-busy'); }
    held = true;
    try {
      if (request.op === 'status') await gate.promise;
      return snapshot(request.canvasId, 'idle', request.op === 'models' ? { models } : {});
    } finally { held = false; }
  } });
  try {
    assert.deepEqual(app.calls.map(request => request.op), ['status']);
    await settle(() => gate.resolve());
    assert.deepEqual(app.calls.map(request => request.op), ['status', 'models']);
    assert.deepEqual(app.value.models, models);
    gate = deferred();
    await settle(() => app.value.refresh());
    assert.deepEqual(app.calls.map(request => request.op), ['status', 'models', 'status']);
    await settle(() => gate.resolve());
    assert.deepEqual(app.calls.map(request => request.op), ['status', 'models', 'status', 'models']);
    assert.equal(app.value.modelsError, '');
    assert.equal(overlaps, 0);
    assert.ok(app.calls.every(request => ['status', 'models'].includes(request.op)));
  } finally { gate.resolve(); await app.unmount(); }
});

test('late status on a departed canvas cannot start its catalog read', async () => {
  const old = deferred();
  const app = await mount({ dispatch: request => request.canvasId === 'canvas-a' && request.op === 'status'
    ? old.promise : snapshot(request.canvasId) });
  try {
    await app.update({ canvasId: 'canvas-b' });
    await settle(() => old.resolve(snapshot('canvas-a')));
    assert.equal(app.calls.filter(request => request.canvasId === 'canvas-a' && request.op === 'models').length, 0);
    assert.equal(app.value.snapshot.canvasId, 'canvas-b');
  } finally { await app.unmount(); }
});

test('a late initial status cannot overwrite a new start or leave checking latched', async () => {
  const status = deferred();
  const app = await mount({ dispatch: request => request.op !== 'start' ? status.promise : snapshot(request.canvasId, 'completed', { requestId: request.requestId }) });
  try {
    assert.equal(app.value.checking, true);
    let pending;
    await settle(() => {pending=app.value.send('A campaign');});
    assert.equal(app.calls.filter(r=>r.op==='start').length,0,'conversation identity must be known before starting');
    await settle(() => status.resolve(snapshot('canvas-a')));
    await pending;
    assert.equal(app.value.snapshot.status, 'completed');
    assert.equal(app.value.checking, false);
  } finally { await app.unmount(); }
});

test('double sends are excluded before React commits the first response', async () => {
  const start = deferred();
  const app = await mount({ dispatch: request => request.op === 'start' ? start.promise : snapshot(request.canvasId) });
  try {
    let first;
    await settle(() => { first = app.value.send('One'); });
    await settle(() => assert.rejects(app.value.send('Two'), /canvas-agent-busy/));
    await settle(() => start.resolve(snapshot('canvas-a', 'running')));
    await first;
    assert.equal(app.calls.filter(request => request.op === 'start').length, 1);
    await settle(() => assert.rejects(app.value.send('Three'), /canvas-agent-busy/));
  } finally { await app.unmount(); }
});

test('a lost start without a matching receipt stays unresolved and never resubmits', async () => {
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') throw Error('lost-start-ack');
    return snapshot(request.canvasId);
  } });
  try {
    await settle(() => assert.rejects(app.value.send('One'), /lost-start-ack/));
    await settle(() => assert.rejects(app.value.send('One'), /canvas-agent-start-unconfirmed/));
    assert.equal(app.calls.filter(request => request.op === 'start').length, 1);
    assert.equal(app.value.modelSelectionLocked, true);
  } finally { await app.unmount(); }
});

test('cancel before host preparation resolves aborts context and never starts a remote request', async () => {
  const host = deferred(); let contexts = 0;
  const app = await mount({ prepare: () => host.promise, props: { getContext: async () => { contexts += 1; return context('canvas-a'); } } });
  try {
    let first;
    await settle(() => { first = app.value.send('One').catch(error => error); });
    await settle(() => app.value.cancel());
    await settle(() => host.resolve());
    assert.match((await first).message, /cancelled/);
    assert.equal(contexts, 0);
    assert.equal(app.calls.filter(request => request.op === 'start').length, 0);
    assert.equal(app.value.busy, false);
  } finally { await app.unmount(); }
});

test('lost-ACK cancel recovery reports failures instead of silently retaining inconsistent state', async () => {
  let statusReads = 0;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') throw Error('lost-start-ack');
    if (++statusReads === 1) return snapshot(request.canvasId);
    throw Error('status-unreachable');
  } });
  try {
    await settle(() => assert.rejects(app.value.send('One'), /lost-start-ack/));
    await settle(() => assert.rejects(app.value.cancel(), /canvas-agent-start-unconfirmed/));
    assert.equal(app.value.error, 'canvas-agent-start-unconfirmed');
    assert.equal(app.value.modelSelectionLocked, true, 'the unknown accepted request remains guarded');
    assert.equal(app.value.busy, false, 'read-only reconciliation stays available');
  } finally { await app.unmount(); }
});

test('switching canvases ignores old status successes and errors', async () => {
  const status = deferred();
  const app = await mount({ dispatch: request => request.canvasId === 'canvas-a' ? status.promise : snapshot(request.canvasId) });
  try {
    await app.update({ canvasId: 'canvas-b' });
    await settle(() => status.reject(Error('old-canvas-offline')));
    assert.equal(app.value.snapshot.canvasId, 'canvas-b');
    assert.equal(app.value.error, '');
    assert.equal(app.value.checking, false);
  } finally { await app.unmount(); }
});

test('a late start ACK is cancelled by its original canvas and run IDs after switching canvases', async () => {
  const start = deferred();
  const app = await mount({ dispatch: request => request.op === 'start' ? start.promise : snapshot(request.canvasId) });
  try {
    let first;
    await settle(() => { first = app.value.send('One'); });
    await app.update({ canvasId: 'canvas-b' });
    await settle(() => start.resolve(snapshot('canvas-a', 'running', { runId: 'old-run' })));
    assert.equal(await first, false);
    assert.deepEqual(app.calls.filter(request => request.op === 'cancel'), [{ op: 'cancel', canvasId: 'canvas-a', runId: 'old-run' }]);
    assert.equal(app.value.snapshot.canvasId, 'canvas-b');
  } finally { await app.unmount(); }
});

test('cancel recovery only cancels a snapshot matching the uncertain request identity', async () => {
  let reads = 0;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') throw Error('lost-start-ack');
    if (request.op === 'status' && ++reads > 1) return snapshot(request.canvasId, 'running', { requestId: 'unrelated', runId: 'unrelated-run' });
    return snapshot(request.canvasId);
  } });
  try {
    await settle(() => assert.rejects(app.value.send('One'), /lost-start-ack/));
    await settle(() => assert.rejects(app.value.cancel(), /canvas-agent-start-unconfirmed/));
    assert.deepEqual(app.calls.filter(request => request.op === 'cancel'), []);
  } finally { await app.unmount(); }
});

test('cancel keeps the send lock until a pending start ACK is cancelled, then uses a fresh request identity', async () => {
  const start = deferred(); let starts = 0, acceptedRequest;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') { acceptedRequest = request; return ++starts === 1 ? start.promise : snapshot(request.canvasId, 'completed', { requestId: request.requestId, runId: 'second-run' }); }
    if (request.op === 'cancel') return snapshot(request.canvasId, 'cancelled', { runId: request.runId, requestId: acceptedRequest.requestId });
    return snapshot(request.canvasId);
  } });
  try {
    let first, cancelled;
    await settle(() => { first = app.value.send('One'); });
    const request = app.calls.find(item => item.op === 'start');
    await settle(() => { cancelled = app.value.cancel(); });
    await settle(() => assert.rejects(app.value.send('One'), /canvas-agent-busy/));
    await settle(() => start.resolve(snapshot('canvas-a', 'running', { requestId: request.requestId, runId: 'first-run' })));
    await settle(() => cancelled);
    assert.equal(await first, false);
    assert.equal(app.value.snapshot.status, 'cancelled');
    assert.equal(app.calls.filter(item => item.op === 'cancel').length, 1);
    await settle(() => app.value.send('One'));
    const requests = app.calls.filter(item => item.op === 'start');
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].requestId, requests[1].requestId);
  } finally { await app.unmount(); }
});

test('a transport failure while polling keeps the run busy and automatically recovers terminal status', async () => {
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') return snapshot(request.canvasId, 'running', { requestId: request.requestId });
    return snapshot(request.canvasId);
  } });
  try {
    await settle(() => app.value.send('One'));
    let reads = 0;
    dispatch = async request => {
      app.calls.push(request);
      if(request.op==='models')return snapshot(request.canvasId);
      if (++reads === 1) throw Error('transient-disconnect');
      return snapshot(request.canvasId, 'completed');
    };
    await settle(() => app.value.refresh());
    assert.equal(app.value.busy, true);
    assert.equal(app.value.error, 'transient-disconnect');
    assert.equal(app.value.availability, 'ready', 'known active work must remain stoppable');
    await settle(() => new Promise(resolve => setTimeout(resolve, 1600)));
    assert.equal(reads, 2);
    assert.equal(app.value.busy, false);
    assert.equal(app.value.snapshot.status, 'completed');
    assert.equal(app.value.error, '');
  } finally { await app.unmount(); }
});

test('a rejected cancel ACK is recovered and retried only for its captured run', async () => {
  let cancelled = 0;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') return snapshot(request.canvasId, 'running', { requestId: request.requestId, runId: 'target-run' });
    if (request.op === 'cancel') {
      assert.equal(request.runId, 'target-run');
      if (++cancelled === 1) throw Error('cancel-ack-lost');
      return snapshot(request.canvasId, 'cancelled', { runId: request.runId });
    }
    return snapshot(request.canvasId);
  } });
  try {
    await settle(() => app.value.send('One'));
    await settle(() => assert.rejects(app.value.cancel(), /cancel-ack-lost/));
    assert.equal(app.value.busy, true);
    dispatch = async request => {
      app.calls.push(request);
      if (request.op === 'status') return snapshot(request.canvasId, 'running', { runId: 'target-run' });
      assert.equal(request.op, 'cancel');
      assert.equal(request.runId, 'target-run');
      cancelled += 1;
      return snapshot(request.canvasId, 'cancelled', { runId: request.runId });
    };
    await settle(() => app.value.refresh());
    assert.equal(cancelled, 2);
    assert.equal(app.value.snapshot.status, 'cancelled');
    assert.equal(app.value.busy, false);
    assert.equal(app.value.error, '');
  } finally { await app.unmount(); }
});

test('changed retry context reconciles uncertain remote work before submitting a new paid request', async () => {
  let reads = 0;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') throw Error('lost-start-ack');
    return ++reads === 1 ? snapshot(request.canvasId) : snapshot(request.canvasId, 'running', { runId: 'accepted-but-lost' });
  } });
  try {
    await settle(() => assert.rejects(app.value.send('One'), /lost-start-ack/));
    await app.update({ getContext: async () => ({ ...context('canvas-a'), canvasName: 'Renamed' }) });
    await settle(() => assert.rejects(app.value.send('One'), /canvas-agent-start-unconfirmed/));
    assert.equal(app.calls.filter(request => request.op === 'start').length, 1);
    assert.equal(app.value.snapshot.runId, 'accepted-but-lost');
    assert.equal(app.value.modelSelectionLocked, true);
  } finally { await app.unmount(); }
});

test('changing canvas while collecting context aborts its signal and cannot submit to the new canvas', async () => {
  const prepared = deferred(); let signal;
  const app = await mount({ props: { getContext: next => { signal = next; return prepared.promise; } } });
  try {
    let first;
    await settle(() => { first = app.value.send('One').catch(error => error); });
    await app.update({ canvasId: 'canvas-b' });
    assert.equal(signal.aborted, true);
    await settle(() => prepared.resolve(context('canvas-a')));
    assert.match((await first).message, /canvas-agent-canvas-changed/);
    assert.deepEqual(app.calls.filter(request => request.op === 'start'), []);
    assert.equal(app.value.snapshot.canvasId, 'canvas-b');
  } finally { await app.unmount(); }
});

test('unmount suppresses status updates and does not schedule continuing polls', async () => {
  const pending = deferred();
  const app = await mount({ dispatch: () => pending.promise });
  await app.unmount();
  await settle(() => pending.resolve(snapshot('canvas-a', 'running')));
  await settle(() => new Promise(resolve => setTimeout(resolve, 1000)));
  assert.equal(app.calls.filter(request=>request.op==='status').length, 1);
});

test('StrictMode status replay is read-only and cannot overwrite the latest canvas response', async () => {
  const first = deferred(); let reads = 0;
  const app = await mount({ strict: true, dispatch: request => request.op==='models'?snapshot(request.canvasId):++reads === 1 ? first.promise : snapshot(request.canvasId, 'completed') });
  try {
    assert.equal(reads, 1, 'stale StrictMode effect cannot dispatch after preparation');
    await settle(()=>app.value.refresh());
    assert.equal(reads, 2);
    await settle(() => first.resolve(snapshot('canvas-a', 'running', { runId: 'stale-run' })));
    assert.equal(app.value.snapshot.status, 'completed');
    assert.equal(app.value.checking, false);
    assert.equal(app.value.busy, false);
    assert.ok(app.calls.every(request => ['status','models'].includes(request.op)));
  } finally { await app.unmount(); }
});

test('a same-turn send after an accepted running ACK is rejected before a React render', async () => {
  const app = await mount({ dispatch: request => request.op === 'start' ? snapshot(request.canvasId, 'running') : snapshot(request.canvasId) });
  try {
    await settle(async () => {
      await app.value.send('One');
      await assert.rejects(app.value.send('Two'), /canvas-agent-busy/);
    });
    assert.equal(app.calls.filter(request => request.op === 'start').length, 1);
  } finally { await app.unmount(); }
});

test('a late cancellation result never replaces the newly selected canvas state', async () => {
  const cancelled = deferred();
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') return snapshot(request.canvasId, 'running');
    if (request.op === 'cancel') return cancelled.promise;
    return snapshot(request.canvasId);
  } });
  try {
    await settle(() => app.value.send('One'));
    let pending;
    await settle(() => { pending = app.value.cancel(); });
    await app.update({ canvasId: 'canvas-b' });
    await settle(() => cancelled.resolve(snapshot('canvas-a', 'cancelled')));
    await pending;
    assert.equal(app.value.snapshot.canvasId, 'canvas-b');
    assert.equal(app.value.snapshot.status, 'idle');
    assert.equal(app.value.busy, false);
    assert.equal(app.value.error, '');
  } finally { await app.unmount(); }
});

test('status recovery of a lost start ACK preserves idempotency for the retained draft retry', async () => {
  let accepted, starts = 0;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') {
      starts += 1;
      if (!accepted) { accepted = request; throw Error('lost-start-ack'); }
      assert.deepEqual(request, accepted);
      return snapshot(request.canvasId, 'completed', { requestId: request.requestId });
    }
    return accepted ? snapshot(request.canvasId, 'completed', { requestId: accepted.requestId }) : snapshot(request.canvasId);
  } });
  try {
    await settle(() => assert.rejects(app.value.send('One'), /lost-start-ack/));
    await settle(() => app.value.refresh());
    assert.equal(app.value.snapshot.status, 'completed');
    assert.equal(app.value.busy, false);
    await settle(() => app.value.send('One'));
    assert.equal(starts, 1, 'recovery reads the receipt without dispatching start again');
  } finally { await app.unmount(); }
});



test('per-canvas model selection reaches start and remains isolated across navigation', async () => {
  Object.defineProperty(global,'localStorage',{value:dom.window.localStorage,configurable:true});
  localStorage.clear();
  const models={available:[{provider:'lsh',model:'chosen',label:'LSH · chosen',inputModalities:['text']}],defaultModel:{provider:'lsh',model:'default'},currentModel:null};
  const app=await mount({dispatch:request=>snapshot(request.canvasId,request.op==='start'?'completed':'idle',{models})});
  try{
    await settle(()=>app.value.selectModel({provider:'lsh',model:'chosen'}));
    await settle(()=>app.value.send('Use my chosen model'));
    assert.deepEqual(app.calls.find(r=>r.op==='start').modelSelection,{provider:'lsh',model:'chosen'});
    await app.update({canvasId:'canvas-b'});assert.equal(app.value.selectedModel,null);
    await app.update({canvasId:'canvas-a'});assert.deepEqual(app.value.selectedModel,{provider:'lsh',model:'chosen'});
    models.available=[];await settle(()=>app.value.refresh());assert.equal(app.value.modelSelectionUnavailable,true);
    await settle(()=>app.value.selectModel(null));assert.equal(app.value.selectedModel,null);
  }finally{await app.unmount();localStorage.clear();}
});

test('an uncertain start locks model changes without losing its retry identity',async()=>{
 const app=await mount({dispatch:request=>{if(request.op==='start')throw Error('lost-ack');return snapshot(request.canvasId);}});
 try{
  await settle(()=>assert.rejects(app.value.send('One'),/lost-ack/));
  assert.equal(app.value.modelSelectionLocked,true);
  assert.throws(()=>app.value.selectModel({provider:'lsh',model:'other'}),/canvas-agent-busy/);
  assert.equal(app.value.selectedModel,null);
 }finally{await app.unmount();}
});

test('reasoning effort is persisted per canvas and sent exactly with its model',async()=>{
 Object.defineProperty(global,'localStorage',{value:dom.window.localStorage,configurable:true});localStorage.clear();
 const app=await mount({dispatch:request=>snapshot(request.canvasId,request.op==='start'?'completed':'idle')});
 try {
  const choice={provider:'lsh',model:'chosen',reasoningEffort:'max'};
  await settle(()=>app.value.selectModel(choice));
  await settle(()=>app.value.send('Reason deeply'));
  assert.deepEqual(app.calls.find(r=>r.op==='start').modelSelection,choice);
  assert.deepEqual(app.value.selectedModel,choice);
  await app.update({canvasId:'canvas-b'});assert.equal(app.value.selectedModel,null);
  await app.update({canvasId:'canvas-a'});assert.deepEqual(app.value.selectedModel,choice);
  await settle(()=>app.value.selectModel({provider:'lsh',model:'ordinary'}));
  assert.equal(Object.hasOwn(app.value.selectedModel,'reasoningEffort'),false);
 }finally{await app.unmount();localStorage.clear();}
});

test('cold entry prepares in background before any status without sending a model request',async()=>{
 const gate=deferred();let prepares=0;
 const app=await mount({prepare:()=>{prepares++;return gate.promise;}});
 try{assert.equal(app.value.availability,'checking');assert.equal(app.calls.length,0);assert.equal(prepares,1);
 await settle(()=>gate.resolve());assert.equal(app.value.availability,'ready');assert.deepEqual(app.calls.map(r=>r.op),['status','models']);}
 finally{await app.unmount();}
});
test('a stale failed startup promise does not hide independently recovered host status',async()=>{
 let offline=true;const app=await mount({prepare:async()=>{throw Error('old-startup-failure');},dispatch:r=>{if(offline)throw Error('canvas-agent-not-ready');return snapshot(r.canvasId);}});
 try{assert.equal(app.value.availability,'unavailable');offline=false;await settle(()=>app.value.refresh());assert.equal(app.value.availability,'ready');assert.equal(app.calls.filter(r=>r.op==='start').length,0);}
 finally{await app.unmount();}
});
test('lost new-conversation ACK retains exact rotation identity and blocks sends until retry',async()=>{
 let rotations=0;const app=await mount({dispatch:r=>{if(r.op==='newConversation'){if(++rotations===1)throw Error('lost-ack');return snapshot(r.canvasId,'idle',{conversationId:'conversation-2',requestId:r.requestId});}return snapshot(r.canvasId);}});
 try{await settle(()=>assert.rejects(app.value.newConversation(),/lost-ack/));assert.equal(app.value.rotationPending,true);
 await settle(()=>assert.rejects(app.value.send('must not send'),/busy/));assert.equal(app.value.snapshot.conversationId,'conversation-1');
 await settle(()=>app.value.newConversation());const requests=app.calls.filter(r=>r.op==='newConversation');assert.deepEqual(requests[0],requests[1]);assert.equal(app.value.rotationPending,false);assert.equal(app.value.snapshot.conversationId,'conversation-2');assert.equal(app.calls.filter(r=>r.op==='start').length,0);}
 finally{await app.unmount();}
});
test('definite rotation conflict reconciles and allows a fresh explicit new conversation',async()=>{
 let identity='conversation-1',rotations=0;const app=await mount({dispatch:r=>{if(r.op==='newConversation'){if(++rotations===1){identity='conversation-2';throw Error('canvas-agent-conversation-conflict');}identity='conversation-3';}return snapshot(r.canvasId,'idle',{conversationId:identity});}});
 try{await settle(()=>assert.rejects(app.value.newConversation(),/conflict/));assert.equal(app.value.rotationPending,false);assert.equal(app.value.snapshot.conversationId,'conversation-2');await settle(()=>app.value.newConversation());const requests=app.calls.filter(r=>r.op==='newConversation');assert.notEqual(requests[0].requestId,requests[1].requestId);assert.equal(requests[1].expectedConversationId,'conversation-2');}
 finally{await app.unmount();}
});
test('active run rejects new conversation before invoking transport',async()=>{
 const app=await mount({dispatch:r=>snapshot(r.canvasId,'running')});try{await settle(()=>assert.rejects(app.value.newConversation(),/busy/));assert.equal(app.calls.filter(r=>r.op==='newConversation').length,0);}finally{await app.unmount();}
});
test('send recovery finding active run preserves the active cancellation identity',async()=>{
 let failedPreparation=false;const app=await mount({prepare:async()=>{if(failedPreparation)throw Error('stale');},dispatch:r=>r.op==='cancel'?snapshot(r.canvasId,'cancelled',{runId:r.runId}):snapshot(r.canvasId,failedPreparation?'running':'idle')});
 try{failedPreparation=true;await settle(()=>assert.rejects(app.value.send('blocked'),/busy/));assert.equal(app.calls.filter(r=>r.op==='start').length,0);await settle(()=>app.value.cancel());assert.equal(app.calls.find(r=>r.op==='cancel').runId,'run-1');assert.equal(app.value.busy,false);}
 finally{await app.unmount();}
});
test('stale start rejection reconciles conversation and does not freeze new conversation',async()=>{
 let identity='conversation-1';const app=await mount({dispatch:r=>{if(r.op==='start'){identity='conversation-2';throw Error('canvas-agent-conversation-conflict');}if(r.op==='newConversation')identity='conversation-3';return snapshot(r.canvasId,'idle',{conversationId:identity});}});
 try{await settle(()=>assert.rejects(app.value.send('old identity'),/conflict/));assert.equal(app.value.busy,false);assert.equal(app.value.snapshot.conversationId,'conversation-2');await settle(()=>app.value.newConversation());assert.equal(app.value.snapshot.conversationId,'conversation-3');}
 finally{await app.unmount();}
});

test('R5 resumes the actual selected conversation using a guarded request identity',async()=>{
 const app=await mount({dispatch:request=>request.op==='history'?snapshot(request.canvasId,'idle',{conversations:[{conversationId:'old',sessionId:'session-old',title:'Old work',updatedAt:1,messageCount:2}]}):request.op==='resumeConversation'?snapshot(request.canvasId,'completed',{conversationId:'old',sessionId:'session-old'}):snapshot(request.canvasId)});
 try{await settle(()=>app.value.loadConversations());assert.equal(app.value.conversations[0].sessionId,'session-old');await settle(()=>app.value.selectConversation('old'));assert.equal(app.value.snapshot.sessionId,'session-old');const request=app.calls.find(r=>r.op==='resumeConversation');assert.equal(request.expectedConversationId,'conversation-1');assert.ok(request.requestId);}finally{await app.unmount();}
});
test('R5 lost action result acknowledgement resends receipt without repeating canvas execution',async()=>{
 let executions=0,receipts=0,completed=false;
 const action={actionId:'action-1',runId:'run-1',kind:'readContext'};
 const app=await mount({props:{executeAction:async()=>{executions++;return {status:'completed',summary:'Read',generatedJobs:0};}},dispatch:request=>{
  if(request.op==='actionResult'){receipts++;if(receipts===1)throw Error('canvas-agent-transport-busy');completed=true;return snapshot(request.canvasId,'completed');}
  if(request.op==='models')return snapshot(request.canvasId);
  return completed?snapshot(request.canvasId,'completed'):snapshot(request.canvasId,'running',{pendingAction:action});
 }});
 try{await settle(()=>new Promise(resolve=>setTimeout(resolve,450)));assert.equal(executions,1);assert.ok(receipts>=2);assert.equal(app.value.snapshot.status,'completed');}finally{await app.unmount();}
});
test('R5 cancellation aborts active canvas execution as well as the engine',async()=>{
 let aborted=false;const gate=deferred();
 const app=await mount({props:{executeAction:async(_a,signal)=>{signal.addEventListener('abort',()=>{aborted=true;gate.resolve({status:'cancelled',summary:'Stopped',generatedJobs:0});});return gate.promise;}},dispatch:request=>request.op==='cancel'?snapshot(request.canvasId,'cancelled'):request.op==='models'?snapshot(request.canvasId):snapshot(request.canvasId,'running',{pendingAction:{actionId:'action-1',runId:'run-1',kind:'readContext'}})});
 try{await settle();await settle(()=>app.value.cancel());assert.equal(aborted,true);assert.equal(app.value.snapshot.status,'cancelled');}finally{gate.resolve({status:'cancelled',summary:'Stopped',generatedJobs:0});await app.unmount();}
});

test('R7B completed lost ACK with automatic context changes never creates a second media request', async () => {
  let accepted;
  const node = { id: 'ref-1', kind: 'text', title: 'Before', text: 'Before', editable: true, revision: 'v1' };
  const app = await mount({ props: { getContext: async () => ({ ...context('canvas-a'), snapshotRevision: 'v1', nodes: [node] }) }, dispatch: request => {
    if (request.op === 'start') { accepted = request; throw Error('lost-start-ack'); }
    return accepted ? snapshot(request.canvasId, 'completed', { requestId: accepted.requestId }) : snapshot(request.canvasId);
  } });
  try {
    const policy = { mode: 'autonomous', allowGeneration: true, maxMediaJobs: 1 };
    await settle(() => assert.rejects(app.value.send('Generate one', policy), /lost-start-ack/));
    await app.update({ getContext: async () => ({ ...context('canvas-a'), canvasName: 'Renamed by activity', snapshotRevision: 'v2', nodes: [{ ...node, title: 'Updated', text: 'Generated result', revision: 'v2', layout: { x: 20, y: 30 } }], connections: [{ source: 'a', target: 'b' }] }) });
    await settle(() => app.value.refresh());
    assert.equal(app.value.error, 'canvas-agent-start-recovered');
    let result;
    await settle(async () => { result = await app.value.send('Generate one', policy); });
    assert.equal(result, true);
    assert.equal(app.calls.filter(r => r.op === 'start').length, 1);
    assert.equal(app.value.modelSelectionLocked, false);
  } finally { await app.unmount(); }
});

test('R7B a changed draft is preserved after receipt recovery and requires a distinct next send', async () => {
  let accepted, starts = 0;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') { starts++; if (!accepted) { accepted = request; throw Error('lost-start-ack'); } return snapshot(request.canvasId, 'completed', { requestId: request.requestId }); }
    return accepted ? snapshot(request.canvasId, 'completed', { requestId: accepted.requestId }) : snapshot(request.canvasId);
  } });
  try {
    await settle(() => assert.rejects(app.value.send('Original'), /lost-start-ack/));
    await settle(() => assert.rejects(app.value.send('My new draft'), /canvas-agent-previous-request-recovered/));
    assert.equal(starts, 1);
    assert.equal(app.value.busy, false);
    await settle(() => app.value.send('My new draft'));
    assert.equal(starts, 2);
    const requests = app.calls.filter(r => r.op === 'start');
    assert.notEqual(requests[0].requestId, requests[1].requestId);
    assert.equal(requests[1].prompt, 'My new draft');
  } finally { await app.unmount(); }
});

test('R7B changed media permission or attachments do not consume the new intent on receipt recovery', async () => {
  for (const change of ['permission', 'attachment', 'reference']) {
    let accepted;
    const original = { ...context('canvas-a'), nodes: [{ id: 'image-1', kind: 'image', title: 'Image', text: '', editable: true, revision: 'v1', image: { mimeType: 'image/png', data: 'old-image' } }] };
    const app = await mount({ props: { getContext: async () => original }, dispatch: request => {
      if (request.op === 'start') { accepted = request; throw Error('lost-start-ack'); }
      return accepted ? snapshot(request.canvasId, 'completed', { requestId: accepted.requestId }) : snapshot(request.canvasId);
    } });
    try {
      const policy = { mode: 'autonomous', allowGeneration: false, maxMediaJobs: 0 };
      await settle(() => assert.rejects(app.value.send('Same prompt', policy), /lost-start-ack/));
      if (change !== 'permission') await app.update({ getContext: async () => ({ ...original, nodes: original.nodes.map(node => change === 'attachment' ? { ...node, image: { ...node.image, data: 'different-image' } } : { ...node, id: 'image-2' }) }) });
      await settle(() => assert.rejects(app.value.send('Same prompt', change === 'permission' ? { ...policy, allowGeneration: true, maxMediaJobs: 1 } : policy), /canvas-agent-previous-request-recovered/));
      assert.equal(app.calls.filter(r => r.op === 'start').length, 1, change);
      assert.equal(app.value.busy, false, change);
    } finally { await app.unmount(); }
  }
});

test('R7B wrong receipt or offline status retains identity until original receipt becomes available', async () => {
  for (const mode of ['wrong-id', 'wrong-conversation', 'offline']) {
    let accepted, restored = false;
    const app = await mount({ dispatch: request => {
      if (request.op === 'start') { accepted = request; throw Error('lost-start-ack'); }
      if (!accepted) return snapshot(request.canvasId);
      if (restored) return snapshot(request.canvasId, 'completed', { requestId: accepted.requestId });
      if (mode === 'offline') throw Error('host-offline');
      return snapshot(request.canvasId, 'completed', { requestId: mode === 'wrong-id' ? 'other-request' : accepted.requestId, conversationId: mode === 'wrong-conversation' ? 'other-conversation' : accepted.conversationId });
    } });
    try {
      await settle(() => assert.rejects(app.value.send('One'), /lost-start-ack/));
      await settle(() => assert.rejects(app.value.send('Changed intent'), /canvas-agent-start-unconfirmed/));
      assert.equal(app.value.modelSelectionLocked, true);
      await settle(() => app.value.refresh());
      assert.equal(app.calls.filter(r => r.op === 'start').length, 1);
      restored = true; // A restarted host rehydrates the accepted disk receipt.
      await settle(() => app.value.refresh());
      await settle(() => app.value.send('One'));
      assert.equal(app.calls.filter(r => r.op === 'start').length, 1);
      assert.equal(app.value.modelSelectionLocked, false);
    } finally { await app.unmount(); }
  }
});

test('R7B cancel cannot release an unknown receipt or allow a paid replay', async () => {
  for (const mode of ['wrong-id', 'wrong-conversation', 'offline']) {
    let accepted;
    const app = await mount({ dispatch: request => {
      if (request.op === 'start') { accepted = request; throw Error('lost-start-ack'); }
      if (!accepted) return snapshot(request.canvasId);
      if (mode === 'offline') throw Error('host-offline');
      return snapshot(request.canvasId, 'running', { runId: 'unrelated-run', requestId: mode === 'wrong-id' ? 'different-request' : accepted.requestId, conversationId: mode === 'wrong-conversation' ? 'different-conversation' : accepted.conversationId });
    } });
    try {
      await settle(() => assert.rejects(app.value.send('One'), /lost-start-ack/));
      await settle(() => assert.rejects(app.value.cancel(), /canvas-agent-start-unconfirmed/));
      assert.equal(app.value.modelSelectionLocked, true, mode);
      await settle(() => assert.rejects(app.value.send('One'), /canvas-agent-start-unconfirmed/));
      await settle(() => app.value.refresh());
      assert.equal(app.calls.filter(r => r.op === 'cancel').length, 0, mode);
      assert.equal(app.calls.filter(r => r.op === 'start').length, 1, mode);
    } finally { await app.unmount(); }
  }
});

test('R7B failed receipt acknowledges acceptance so the caller can clear one-shot media permission', async () => {
  let accepted;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') { accepted = request; throw Error('lost-start-ack'); }
    return accepted ? snapshot(request.canvasId, 'failed', { requestId: accepted.requestId, error: 'provider-failed' }) : snapshot(request.canvasId);
  } });
  try {
    const policy = { mode: 'autonomous', allowGeneration: true, maxMediaJobs: 1 };
    await settle(() => assert.rejects(app.value.send('Generate one', policy), /lost-start-ack/));
    let confirmed = false;
    await settle(async () => { confirmed = await app.value.send('Generate one', policy); });
    assert.equal(confirmed, true, 'acceptance resolves successfully and triggers Panel draft/permission reset');
    assert.equal(app.value.snapshot.error, 'provider-failed');
    assert.equal(app.value.error, 'provider-failed');
    assert.equal(app.calls.filter(r => r.op === 'start').length, 1);
    assert.equal(app.value.modelSelectionLocked, false);
  } finally { await app.unmount(); }
});

test('R7B matching running receipt acknowledges the old request without replay or losing stop', async () => {
  let accepted;
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') { accepted = request; throw Error('lost-start-ack'); }
    if (request.op === 'cancel') return snapshot(request.canvasId, 'cancelled', { requestId: accepted.requestId, runId: request.runId });
    return accepted ? snapshot(request.canvasId, 'running', { requestId: accepted.requestId, runId: 'accepted-run' }) : snapshot(request.canvasId);
  } });
  try {
    await settle(() => assert.rejects(app.value.send('One'), /lost-start-ack/));
    await settle(() => app.value.refresh());
    assert.equal(app.value.busy, true);
    let acceptedResult;
    await settle(async () => { acceptedResult = await app.value.send('One'); });
    assert.equal(acceptedResult, true);
    assert.equal(app.calls.filter(r => r.op === 'start').length, 1);
    await settle(() => app.value.cancel());
    assert.equal(app.calls.filter(r => r.op === 'cancel')[0].runId, 'accepted-run');
    assert.equal(app.value.busy, false);
  } finally { await app.unmount(); }
});


test('R7B same hook A to B to A preserves only per-canvas receipt guards and isolates starts', async () => {
  const accepted = new Map();
  const app = await mount({ dispatch: request => {
    if (request.op === 'start') { accepted.set(request.canvasId, request); throw Error('lost-start-ack'); }
    const old = accepted.get(request.canvasId);
    return old ? snapshot(request.canvasId, 'completed', { requestId: old.requestId }) : snapshot(request.canvasId);
  } });
  try {
    await settle(() => assert.rejects(app.value.send('A task'), /lost-start-ack/));
    await app.update({ canvasId: 'canvas-b' });
    assert.equal(app.value.modelSelectionLocked, false);
    await settle(() => assert.rejects(app.value.send('B task'), /lost-start-ack/));
    await app.update({ canvasId: 'canvas-a' });
    assert.equal(app.value.modelSelectionLocked, true);
    await settle(() => app.value.send('A task'));
    await app.update({ canvasId: 'canvas-b' });
    await settle(() => app.value.send('B task'));
    assert.equal(app.calls.filter(r => r.op === 'start' && r.canvasId === 'canvas-a').length, 1);
    assert.equal(app.calls.filter(r => r.op === 'start' && r.canvasId === 'canvas-b').length, 1);
    assert.equal(app.value.modelSelectionLocked, false);
  } finally { await app.unmount(); }
});

test('R7B navigation during digest cannot install a guard or start on the wrong canvas', async () => {
  const digest = deferred();
  crypto.subtle.digest = () => digest.promise;
  const app = await mount();
  try {
    let first;
    await settle(() => { first = app.value.send('A task').catch(error => error); });
    await app.update({ canvasId: 'canvas-b' });
    await settle(() => digest.resolve(new Uint8Array(32)));
    assert.match((await first).message, /canvas-agent-canvas-changed/);
    assert.equal(app.calls.filter(r => r.op === 'start').length, 0);
    await app.update({ canvasId: 'canvas-a' });
    assert.equal(app.value.modelSelectionLocked, false);
  } finally { crypto.subtle.digest = defaultDigest; await app.unmount(); }
});

test('failed LSH receipt keeps detail and ready connection through refresh and history, clearing on next run',async()=>{
 const failure={error:'canvas-agent-unavailable',errorDetail:{message:'LSH: quota exceeded'}};
 let state=snapshot('canvas-a','failed',failure);
 const app=await mount({dispatch:request=>{
  if(request.op==='start')state=snapshot(request.canvasId,'failed',{...failure,requestId:request.requestId});
  if(request.op==='resumeConversation')state={...state,conversationId:request.conversationId};
  if(request.op==='newConversation')state=snapshot(request.canvasId,'idle',{conversationId:'new-conversation',requestId:request.requestId});
  return state;
 }});
 try{
  assert.equal(app.value.availability,'ready');assert.deepEqual(app.value.snapshot.errorDetail,failure.errorDetail);
  await settle(()=>assert.rejects(app.value.send('Try'),/canvas-agent-unavailable/));
  assert.equal(app.value.availability,'ready');assert.deepEqual(app.value.snapshot.errorDetail,failure.errorDetail);
  await settle(()=>app.value.refresh());assert.deepEqual(app.value.snapshot.errorDetail,failure.errorDetail);
  await settle(()=>app.value.selectConversation('history-conversation'));assert.deepEqual(app.value.snapshot.errorDetail,failure.errorDetail);
  await settle(()=>app.value.newConversation());assert.equal(app.value.snapshot.errorDetail,undefined);assert.equal(app.value.error,'');
 }finally{await app.unmount();}
});

test('late failed receipt from an old canvas cannot leak its error detail into the current canvas',async()=>{
 const pending=deferred();let started;
 const app=await mount({dispatch:request=>{
  if(request.op==='start'){started=request;return pending.promise;}
  return snapshot(request.canvasId);
 }});
 try{
  let sending;await settle(()=>{sending=app.value.send('Old canvas');});
  assert.ok(started);await app.update({canvasId:'canvas-b'});
  await settle(async()=>{pending.resolve(snapshot('canvas-a','failed',{requestId:started.requestId,error:'canvas-agent-model-failed',errorDetail:{message:'Old model quota failure'}}));assert.equal(await sending,false);});
  assert.equal(app.value.snapshot.canvasId,'canvas-b');assert.equal(app.value.snapshot.errorDetail,undefined);assert.equal(app.value.error,'');assert.equal(app.value.availability,'ready');
 }finally{await app.unmount();}
});

test('R7B concurrent sends during digest cannot race to create two starts', async () => {
  const digest = deferred();
  crypto.subtle.digest = () => digest.promise;
  const app = await mount({ dispatch: request => snapshot(request.canvasId, request.op === 'start' ? 'completed' : 'idle', request.op === 'start' ? { requestId: request.requestId } : {}) });
  try {
    let first;
    await settle(() => { first = app.value.send('One'); });
    await settle(() => assert.rejects(app.value.send('Two'), /canvas-agent-busy/));
    await settle(() => digest.resolve(new Uint8Array(32)));
    assert.equal(await first, true);
    assert.equal(app.calls.filter(r => r.op === 'start').length, 1);
  } finally { crypto.subtle.digest = defaultDigest; await app.unmount(); }
});

test('R7B digest failure is explicit and cannot start with an empty fingerprint', async () => {
  crypto.subtle.digest = async () => { throw Error('digest-unavailable'); };
  const app = await mount();
  try {
    await settle(() => assert.rejects(app.value.send('One'), /canvas-agent-intent-fingerprint-failed/));
    assert.equal(app.calls.filter(r => r.op === 'start').length, 0);
    assert.equal(app.value.modelSelectionLocked, false);
  } finally { crypto.subtle.digest = defaultDigest; await app.unmount(); }
});
