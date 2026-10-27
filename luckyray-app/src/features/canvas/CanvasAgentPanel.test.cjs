const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// This isolated harness uses the existing optional DOM toolchain, not a new app dependency.
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const { JSDOM } = requireTool('jsdom');
const dom = new JSDOM('<!doctype html><button id="canvas-node">Canvas node</button><div id="root"></div>', { url: 'https://canvas-agent.invalid', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLImageElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CompositionEvent', 'DOMParser', 'navigator']) {
  Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
}
// This DOM suite exercises the existing SVG fallback; real WebGL belongs to the browser suite.
dom.window.HTMLCanvasElement.prototype.getContext = () => null;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const appRoot = path.resolve(__dirname, '../../..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(appRoot, 'node_modules/vite'))] }));
const built = esbuild.buildSync({
  stdin: { contents: `export { CanvasAgentPanel } from './CanvasAgentPanel'; export { CanvasMotionProvider } from './CanvasMotionContext'; export { CanvasCreativeDialog } from './CanvasCreativeDialog';`, resolveDir: __dirname, loader: 'tsx' }, bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@tauri-apps/*'], nodePaths: process.env.LR_DSH_DEPS ? [process.env.LR_DSH_DEPS] : [], loader: { '.module.css': 'empty', '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
});
const loaded = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(loaded, loaded.exports, require);
const { CanvasAgentPanel, CanvasMotionProvider, CanvasCreativeDialog } = loaded.exports;
const snapshot = { canvasId: 'canvas-1', sessionId: 'session-1', runId: 'run-1', status: 'completed', messages: [
  { role: 'user', text: 'A cohesive watch campaign' }, { role: 'assistant', text: 'Here is a visual direction for the campaign.' },
] };
const plan = { version: 1, id: 'plan-1', canvasId: 'canvas-1', runId: 'run-1', title: 'Quiet precision', summary: 'Three related product scenes in soft studio light.', steps: [
  { id: 'step-1', kind: 'text', title: 'Campaign treatment', content: 'A calm, restrained story.', references: [] },
  { id: 'step-2', kind: 'image', title: 'Hero image', content: 'A brushed silver watch on a blue background.', references: ['reference-1'] },
  { id: 'step-3', kind: 'video', title: 'Orbit film', content: 'A slow orbit shot around the watch.', references: ['step-2'] },
] };
const chips = [
  { id: 'reference-1', title: 'Watch photograph', kind: 'image', thumbnailUrl: 'https://canvas-agent.invalid/watch.jpg' },
  { id: 'reference-2', title: 'Product film', kind: 'video', thumbnailUrl: 'https://canvas-agent.invalid/poster.jpg' },
];
const query = selector => document.querySelector(selector);
// DSH mounts expanded bodies lazily and renders an aria-hidden decorative shimmer copy.
const disclosureHeader = root => root.querySelector('[data-disclosure-row]');
const reasoningScroll = root => root.querySelector('.canvas-dsh-reasoning-scroll');
const realElements = selector => [...document.querySelectorAll(selector)].filter(element => !element.closest('[aria-hidden="true"]'));
const buttons = () => [...document.querySelectorAll('button')];
const button = name => buttons().find(element => element.getAttribute('aria-label') === name || element.textContent === name);
const input = () => query('textarea');
const click = async element => React.act(async () => { element.click(); });
const key = async (value, init = {}, target = input()) => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  await React.act(async () => { target.dispatchEvent(event); });
  return event;
};
const edit = async value => React.act(() => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), value);
  input().dispatchEvent(new Event('input', { bubbles: true }));
});
async function mount(initial = {}) {
  const root = createRoot(document.getElementById('root'));
  const sent = [], applied = [], located = [], removed = [], executionLocated = [];
  let closed = 0, cancelled = 0, selectionAdded = 0;
  let props = { canvasName: 'Watch campaign', snapshot: null, contextChips: [], execution: null, busy: false, english: true,
    onSend: async value => { sent.push(value); }, onApply: async (...args) => { applied.push(args); },
    onCancel: () => { cancelled += 1; }, onLocate: id => { located.push(id); }, onLocateExecution: (execution, id) => { executionLocated.push([execution, id]); if (id) located.push(id); }, onRemoveContext: id => { removed.push(id); },
    onAddSelection: () => { selectionAdded += 1; }, onClose: () => { closed += 1; }, ...initial,
  };
  const render = () => React.createElement(React.StrictMode, null, React.createElement(CanvasMotionProvider, {reduced: !!props.testReducedMotion}, React.createElement(CanvasAgentPanel, props)));
  await React.act(() => root.render(render()));
  return { sent, applied, located, removed, executionLocated, get closed() { return closed; }, get cancelled() { return cancelled; }, get selectionAdded() { return selectionAdded; },
    async update(next) { props = { ...props, ...next }; await React.act(() => root.render(render())); },
    async unmount() { await React.act(() => root.unmount()); },
  };
}

test('panel layout stays independent when the legacy canvas agent stylesheet loads later', async () => {
  const style = document.createElement('style');
  const legacy = fs.readFileSync(path.join(appRoot, 'src/canvas-spike-scroll.css'), 'utf8');
  const legacyAgentRules = legacy.match(/[^{}]*\.canvas-agent-(?:panel|composer)[^{}]*\{[^{}]*\}/g) || [];
  assert.ok(legacyAgentRules.length > 0, 'exercise the legacy rules present in the application');
  style.textContent = fs.readFileSync(path.join(__dirname, 'canvasAgentPanel.css'), 'utf8') + '\n' + legacyAgentRules.join('\n');
  document.head.append(style);
  const app = await mount();
  try {
    const composer = query('form');
    const mark = query('.canvas-r1-agent-mark');
    assert.equal(window.getComputedStyle(composer).display, 'block', 'textarea must sit above the action row');
    assert.equal(window.getComputedStyle(mark).flexBasis, '32px', 'legacy header spans must not stretch the icon');
    assert.equal(query('.canvas-agent-panel, .canvas-agent-composer'), null);
    assert.equal(window.getComputedStyle(input()).width, '100%');
  } finally { await app.unmount(); style.remove(); }
});

test('empty panel is nonmodal and offers three editable, non-sending creative starters', async () => {
  const app = await mount();
  try {
    assert.equal(query('[role="dialog"]'), null);
    assert.equal(query('[aria-modal]'), null);
    assert.equal(query('.canvas-r1-agent-starters').children.length, 3);
    assert.match(query('.canvas-r1-agent-canvas-label').textContent, /Watch campaign/);
    assert.equal(button('Send request').disabled, true);
    await click(button('Develop a storyScript, scenes and pacing↗'));
    assert.match(input().value, /story, script and shot list/);
    assert.equal(document.activeElement, input());
    assert.deepEqual(app.sent, []);
    document.getElementById('canvas-node').focus();
    assert.equal(document.activeElement.id, 'canvas-node');
    assert.equal((await key('Tab')).defaultPrevented, false, 'nonmodal panel must not trap tab');
  } finally { await app.unmount(); }
});

test('user bubbles show only message text, without You/你 labels in either language', async () => {
  const app = await mount({snapshot});
  try {
    for (const english of [true, false]) {
      await app.update({english});
      const message = query('.canvas-r1-agent-message.is-user');
      assert.equal(message.querySelector('.canvas-r1-agent-message-label'), null);
      assert.equal(message.querySelector('p').textContent, snapshot.messages[0].text);
      assert.ok(message.querySelector('.canvas-agent-message-actions'));
      assert.equal(query('.canvas-agent-turn > .canvas-r1-agent-message-label').textContent, 'Agent');
    }
    assert.deepEqual(app.sent, []);
  } finally { await app.unmount(); }
});

test('IME Enter and Shift+Enter do not send; plain Enter sends the trimmed draft once', async () => {
  const app = await mount();
  let leaked = 0;
  const listener = () => { leaked += 1; };
  document.addEventListener('keydown', listener);
  try {
    await edit('  设计一组海报  ');
    assert.equal((await key('Enter', { shiftKey: true })).defaultPrevented, false);
    await key('Enter', { isComposing: true });
    await key('Enter', { keyCode: 229 });
    await React.act(() => input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await key('Enter'); await key('Escape');
    assert.equal(app.closed, 0);
    assert.deepEqual(app.sent, []);
    await React.act(() => input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    assert.equal((await key('Enter')).defaultPrevented, true);
    assert.deepEqual(app.sent, ['设计一组海报']);
    assert.equal(input().value, '');
    assert.equal(leaked, 0);
  } finally { document.removeEventListener('keydown', listener); await app.unmount(); }
});

test('failure keeps the draft and successful retry clears it', async () => {
  let attempts = 0;
  const app = await mount({ onSend: async () => { attempts += 1; if (attempts === 1) throw new Error('LSH is offline'); } });
  try {
    await edit('Keep this precise creative brief');
    await click(button('Send request'));
    assert.equal(input().value, 'Keep this precise creative brief');
    assert.match(query('[role="alert"]').textContent, /LSH is offline/);
    assert.equal(button('Send request').disabled, false);
    await click(button('Send request'));
    assert.equal(input().value, '');
    assert.equal(query('[role="alert"]'), null);
    assert.equal(attempts, 2);
  } finally { await app.unmount(); }
});

test('a declined start retains its draft; typing while a pending start resolves is never erased', async () => {
  const app = await mount({ onSend: async () => false });
  try {
    await edit('Original brief');
    await click(button('Send request'));
    assert.equal(input().value, 'Original brief');
    let resolve;
    let count = 0;
    await app.update({ onSend: () => { count += 1; return new Promise(done => { resolve = done; }); } });
    await click(button('Send request'));
    await key('Enter');
    assert.equal(count, 1);
    await edit('My next idea');
    await React.act(async () => { resolve(true); });
    assert.equal(input().value, 'My next idea');
  } finally { await app.unmount(); }
});

test('context chips show real thumbnails, recover broken images, and emit removals without mutation', async () => {
  const immutableChips = Object.freeze(chips.map(chip => Object.freeze({ ...chip })));
  const app = await mount({ contextChips: immutableChips });
  try {
    const first = query('.canvas-r1-agent-context-list li');
    assert.equal(first.querySelector('img').src, chips[0].thumbnailUrl);
    assert.equal(query('.canvas-r1-agent-video-badge') !== null, true);
    await React.act(() => first.querySelector('img').dispatchEvent(new Event('error')));
    assert.equal(first.querySelector('.canvas-r1-agent-context-locate img'), null);
    assert.ok(first.querySelector('svg'));
    await click(button('Remove reference Watch photograph'));
    assert.deepEqual(app.removed, ['reference-1']);
    assert.equal(query('.canvas-r1-agent-context-list').children.length, 2);
    assert.equal(button('Add selection'), undefined, 'selection is captured on canvas without an extra button');
    assert.equal(query('.canvas-r1-agent-auto-reference-hint'), null);
    await app.update({ contextChips: [{ ...chips[0], thumbnailUrl: 'https://canvas-agent.invalid/new.jpg' }] });
    assert.equal(query('.canvas-r1-agent-context-list img').src, 'https://canvas-agent.invalid/new.jpg');
  } finally { await app.unmount(); }
});

test('structured plans show readable details and never expose raw plan JSON', async () => {
  const app = await mount({ snapshot: { ...snapshot, plan, messages: [...snapshot.messages, { role: 'assistant', text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }] } });
  try {
    assert.equal(query('.canvas-r1-agent-plan h3').textContent, plan.title);
    assert.equal(query('.canvas-r1-agent-plan-steps').children.length, 3);
    assert.match(query('.canvas-r1-agent-plan').textContent, /A brushed silver watch/);
    assert.doesNotMatch(query('.canvas-r1-agent-messages').textContent, /"version"|"runId"/);
    assert.match(query('.canvas-r1-agent-messages').textContent, /visual direction/);
    await click(button('Add to canvas'));
    assert.deepEqual(app.applied, [[plan, false]]);
    assert.equal(button('Added to canvas').disabled, true);
    assert.equal(button('Add & generate').disabled, true);
    await click(button('Add & generate'));
    assert.equal(app.applied.length, 1);
  } finally { await app.unmount(); }
});

test('apply and generate require an explicit click and are protected from repeated clicks', async () => {
  let finish;
  const applied = [];
  const app = await mount({ snapshot: { ...snapshot, plan }, onApply: (...args) => { applied.push(args); return new Promise(resolve => { finish = resolve; }); } });
  try {
    assert.equal(applied.length, 0);
    const generate = button('Add & generate');
    await React.act(() => { generate.click(); generate.click(); });
    assert.deepEqual(applied, [[plan, true]]);
    assert.equal(button('Add to canvas').disabled, true);
    await React.act(async () => { finish(true); });
    assert.equal(button('Added to canvas').disabled, true);
    await app.update({ snapshot: { ...snapshot, plan: { ...plan, id: 'new-plan' } } });
    assert.equal(button('Add to canvas').disabled, false);
  } finally { await app.unmount(); }
});

test('failed apply unlocks retry, while an execution already on canvas prevents replay', async () => {
  const app = await mount({ snapshot: { ...snapshot, plan }, onApply: async () => { throw new Error('No configured image model'); } });
  try {
    await click(button('Add & generate'));
    assert.match(query('[role="alert"]').textContent, /No configured image model/);
    assert.equal(button('Add to canvas').disabled, false);
    await app.update({ execution: { planId: plan.id, status: 'draft', steps: [] } });
    assert.equal(button('Added to canvas').disabled, true);
    assert.equal(button('Add & generate').disabled, true);
  } finally { await app.unmount(); }
});

test('execution uses actual step statuses, locates created nodes, and exposes failures', async () => {
  const execution = { planId: plan.id, status: 'running', steps: [
    { id: 'a', nodeId: 'node-a', title: 'Treatment', kind: 'text', status: 'draft' },
    { id: 'b', nodeId: 'node-b', title: 'Hero image', kind: 'image', status: 'succeeded' },
    { id: 'c', nodeId: 'node-c', title: 'Orbit film', kind: 'video', status: 'failed', error: 'Provider rejected this aspect ratio' },
    { id: 'd', nodeId: 'node-d', title: 'Final film', kind: 'video', status: 'queued' },
  ] };
  const app = await mount({ snapshot: { ...snapshot, plan }, execution, executionNodeIds: execution.steps.map(step => step.nodeId) });
  try {
    assert.deepEqual([...document.querySelectorAll('.canvas-r1-agent-step-status')].map(element => element.textContent), ['On canvas', 'Completed', 'Failed', 'Queued']);
    assert.match(query('.canvas-r1-agent-section-heading').textContent, /1\/4 complete/);
    assert.match(query('.canvas-r1-agent-execution').textContent, /Provider rejected this aspect ratio/);
    assert.equal(query('progress'), null);
    await click(button('Locate Hero image'));
    assert.deepEqual(app.located, ['node-b']);
    await click(button('Stop current task'));
    assert.equal(app.cancelled, 1);
    assert.match(query('.canvas-r1-agent-working').textContent, /Stopping/);
    assert.equal(button('Cancelling').disabled, true);
    assert.match(query('.canvas-r1-agent-section-heading').textContent, /1\/4 complete/, 'cancellation is not optimistically declared finished');
    await app.update({ execution: { ...execution, status: 'cancelled', steps: execution.steps.map(step => step.status === 'queued' ? { ...step, status: 'cancelled' } : step) } });
    assert.equal(query('.canvas-r1-agent-working'), null);
    assert.match(query('.canvas-r1-agent-section-heading').textContent, /Cancelled/);
  } finally { await app.unmount(); }
});

test('collapse preserves draft and reference selection; Escape collapses without cancelling', async () => {
  const app = await mount({ contextChips: chips });
  try {
    await edit('Do not lose this thought');
    await click(button('Collapse Agent'));
    assert.equal(query('.canvas-r1-agent-body').hidden, true);
    assert.equal(button('Expand Agent').getAttribute('aria-expanded'), 'false');
    await click(button('Expand Agent'));
    assert.equal(query('.canvas-r1-agent-body').hidden, false);
    assert.equal(input().value, 'Do not lose this thought');
    assert.equal(query('.canvas-r1-agent-context-list').children.length, 2);
    await key('Escape');
    assert.equal(app.closed, 0);
    assert.equal(query('.canvas-r1-agent-body').hidden, true);
    assert.equal(app.cancelled, 0);
  } finally { await app.unmount(); }
});

test('unavailable and checking states explain the connection and block new requests without a key form', async () => {
  const app = await mount({ availability: 'unavailable', availabilityMessage: 'Connect the existing LSH instance in Settings.' });
  try {
    await edit('Keep this for later');
    assert.equal(button('Send request').disabled, true);
    assert.match(query('.canvas-r1-agent-availability').textContent, /existing LSH instance/);
    assert.equal(query('input[type="password"]'), null);
    await app.update({ availability: 'checking' });
    assert.match(query('.canvas-r1-agent-availability').textContent, /Connecting to Agent/);
    await app.update({ availability: 'ready' });
    assert.equal(query('.canvas-r1-agent-availability'), null);
    assert.equal(input().value, 'Keep this for later');
    assert.equal(button('Send request').disabled, false);
  } finally { await app.unmount(); }
});

test('Chinese UI includes explicit review actions and truthful model use', async () => {
  const app = await mount({ english: false, snapshot: { ...snapshot, plan } });
  try {
    assert.ok(button('放入画布'));
    assert.ok(button('放入并生成'));
    assert.match(query('.canvas-r1-agent-plan-note').textContent, /画布已配置的模型/);
    assert.equal(button('加入当前选择'), undefined);
    assert.equal(query('.canvas-r1-agent-auto-reference-hint'), null);
    await edit('新的故事');
    await click(button('发送要求'));
    assert.deepEqual(app.sent, ['新的故事']);
  } finally { await app.unmount(); }
});

test('per-canvas drafts survive closing and never leak across canvas IDs', async () => {
  let app = await mount({ draftKey: 'draft-canvas-a' });
  await edit('A quiet mountain landscape');
  assert.equal(window.localStorage.getItem('luckyray.canvasAgent.draft.v1:draft-canvas-a'), 'A quiet mountain landscape');
  await app.unmount();
  app = await mount({ draftKey: 'draft-canvas-a' });
  try {
    assert.equal(input().value, 'A quiet mountain landscape');
    await app.update({ draftKey: 'draft-canvas-b' });
    assert.equal(input().value, '');
    await edit('A city at night');
    await app.update({ draftKey: 'draft-canvas-a' });
    assert.equal(input().value, 'A quiet mountain landscape');
    await click(button('Send request'));
    assert.equal(window.localStorage.getItem('luckyray.canvasAgent.draft.v1:draft-canvas-a'), null);
    await app.update({ draftKey: 'draft-canvas-b' });
    assert.equal(input().value, 'A city at night');
  } finally { await app.unmount(); }
});

test('unavailable browser storage still retains a bounded in-memory draft across reopening', async () => {
  const original = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = () => { throw new Error('Storage disabled'); };
  let app;
  try {
    app = await mount({ draftKey: 'private-canvas' });
    await edit('Keep my draft without storage');
    await app.unmount();
    app = await mount({ draftKey: 'private-canvas' });
    assert.equal(input().value, 'Keep my draft without storage');
  } finally { window.Storage.prototype.setItem = original; if (app) await app.unmount(); }
});

test('editing existing nodes previews the full replacement and can locate before approval', async () => {
  const editPlan = { ...plan, steps: [{ ...plan.steps[1], targetNodeId: 'existing-image', content: 'The entire new image prompt, with no omitted detail.' }] };
  const app = await mount({ snapshot: { ...snapshot, plan: editPlan } });
  try {
    assert.match(query('.canvas-r1-agent-plan-steps summary').textContent, /Edit existing node/);
    assert.equal(query('details').open, false);
    await click(query('summary'));
    assert.equal(query('details').open, true);
    assert.match(query('.canvas-r1-agent-step-detail').textContent, /Full replacement content/);
    assert.match(query('.canvas-r1-agent-step-detail').textContent, /The entire new image prompt, with no omitted detail/);
    await click(button('Locate existing node'));
    assert.deepEqual(app.located, ['existing-image']);
    assert.deepEqual(app.applied, []);
  } finally { await app.unmount(); }
});

test('cancel failure unlocks retry and never claims that work stopped', async () => {
  let attempts = 0;
  const app = await mount({ snapshot: { ...snapshot, status: 'running' }, onCancel: async () => { attempts += 1; throw new Error('Cancel transport failed'); } });
  try {
    await click(button('Stop current task'));
    assert.match(query('[role="alert"]').textContent, /Cancel transport failed/);
    assert.equal(button('Stop current task').disabled, false);
    assert.equal(query('.canvas-agent-turn').getAttribute('aria-busy'), 'true');
    await click(button('Stop current task'));
    assert.equal(attempts, 2);
  } finally { await app.unmount(); }
});

test('reference chips locate nodes without removing context, including during an active run', async () => {
  const app = await mount({ contextChips: chips, snapshot: { ...snapshot, status: 'running' } });
  try {
    await click(button('Locate reference Watch photograph'));
    assert.deepEqual(app.located, ['reference-1']);
    assert.deepEqual(app.removed, []);
    assert.equal(button('Remove reference Watch photograph').disabled, true);
  } finally { await app.unmount(); }
});

test('reconnect re-reads session state without sending or applying a plan', async () => {
  let refreshes = 0;
  const app = await mount({ error: 'The status connection was interrupted.', snapshot: { ...snapshot, status: 'running' }, onRefresh: () => { refreshes += 1; } });
  try {
    await click(button('Reconnect'));
    assert.equal(refreshes, 1);
    assert.deepEqual(app.sent, []);
    assert.deepEqual(app.applied, []);
    assert.match(query('[role="alert"]').textContent, /interrupted/, 'does not optimistically claim the connection recovered');
    await app.update({ error: '', availability: 'unavailable', snapshot: null });
    await click(button('Reconnect'));
    assert.equal(refreshes, 2);
  } finally { await app.unmount(); }
});

test('closing during send clears only an accepted draft and retains an interrupted request', async () => {
  let finish;
  let app = await mount({ draftKey: 'pending-close', onSend: () => new Promise(resolve => { finish = resolve; }) });
  await edit('A request still being sent');
  await click(button('Send request'));
  await app.unmount();
  await React.act(async () => { finish(true); });
  app = await mount({ draftKey: 'pending-close', onSend: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(input().value, '');
  await edit('A request that will be declined');
  await click(button('Send request'));
  await app.unmount();
  await React.act(async () => { finish(false); });
  app = await mount({ draftKey: 'pending-close' });
  try { assert.equal(input().value, 'A request that will be declined'); } finally { await app.unmount(); }
});


test('collapsed orb expands, preserving draft and references', async () => {
  const changed=[]; const app=await mount({contextChips:chips,onCollapsedChange:value=>changed.push(value)});
  try {
    await edit('A retained idea');
    await click(button('Collapse Agent'));
    assert.equal(query('.canvas-r1-agent-body').hidden,true);
    await click(query('.canvas-agent-orb'));
    assert.equal(query('.canvas-r1-agent-body').hidden,false);
    assert.equal(input().value,'A retained idea');
    assert.equal(query('.canvas-r1-agent-context-list').children.length,2);
    assert.deepEqual(changed,[true,false]); assert.deepEqual(app.sent,[]);
  } finally {await app.unmount();}
});

const modelCatalog={available:[{provider:'Provider A',model:'text-one',label:'Provider A · text-one',inputModalities:['text']},{provider:'Provider B',model:'vision-two',label:'Provider B · vision-two',inputModalities:['text','image']}],defaultModel:{provider:'Provider A',model:'text-one'},currentModel:null};
test('live default model is visible before first send and exact selection callback is emitted', async()=>{
  const picked=[];const app=await mount({models:modelCatalog,onSelectModel:m=>picked.push(m)});
  try{
    assert.match(query('.canvas-agent-model-trigger').textContent,/text-one/);
    await click(query('.canvas-agent-model-trigger'));
    assert.equal(query('[role=listbox]').children.length,3);
    await click(query('[role=listbox]').children[2]);
    assert.deepEqual(picked,[{provider:'Provider B',model:'vision-two'}]);
    assert.equal(query('[role=listbox]'),null);assert.equal(document.activeElement,query('.canvas-agent-model-trigger'));
    await app.update({selectedModel:picked[0]});
    assert.match(query('.canvas-agent-model-trigger').textContent,/vision-two/);
    assert.deepEqual(app.sent,[]);
  }finally{await app.unmount();}
});
test('model picker Escape closes only model list; busy model changes and stale-model sends are blocked',async()=>{
  const app=await mount({models:modelCatalog,onSelectModel:()=>{}});
  try{
    await click(query('.canvas-agent-model-trigger'));
    await key('ArrowDown',{},document.activeElement);
    assert.equal(document.activeElement.getAttribute('role'),'option');
    await key('Escape',{},document.activeElement);
    assert.equal(query('[role=listbox]'),null);assert.equal(app.closed,0);
    await edit('Do not send with missing model');
    await app.update({selectedModel:{provider:'gone',model:'missing'},modelSelectionUnavailable:true});
    assert.equal(button('Send request').disabled,true);
    await click(query('.canvas-agent-model-trigger'));
    assert.match(query('.canvas-agent-model-notice').textContent,/unavailable/);
    await app.update({busy:true});assert.equal(query('[role=listbox]'),null);assert.equal(query('.canvas-agent-model-trigger').disabled,true);
  }finally{await app.unmount();}
});


test('compact composer groups starters with model picker and embeds thumbnail references', async()=>{
  const app=await mount({contextChips:[...chips,{id:'text-1',title:'Scene notes',kind:'text',previewText:'A slow pan across the room.'}], models:modelCatalog,onSelectModel:()=>{}});
  try {
    assert.equal(query('.canvas-r1-agent-context-heading'),null);
    assert.equal(query('.canvas-r1-agent-composer-hint'),null);
    assert.ok(query('.canvas-r1-agent-composer-bottom .canvas-agent-model-picker'));
    assert.equal(query('form .canvas-r1-agent-context-list').children.length,3);
    assert.match(query('.canvas-r1-agent-context-list').textContent,/slow pan/);
    const menu=query('.canvas-r1-agent-creation-menu');
    await click(menu.querySelector('.canvas-agent-popover-trigger')); assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'),true);
    await click([...menu.querySelectorAll('button')].find(b=>b.textContent==='Script'));
    assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'),false); assert.match(input().value,/story, script and shot list/); assert.deepEqual(app.sent,[]);
  }finally{await app.unmount();}
});
test('pick control reflects mode without a UI-only reference cap, and collapsed orb preserves running session',async()=>{
  let picks=0;
  const app=await mount({contextChips:chips,onPickContext:()=>{picks++},pickingContext:true});
  try {
    await click(button('Click canvas to add references'));assert.equal(picks,1);
    assert.equal(button('Click canvas to add references').getAttribute('aria-pressed'),'true');
    await app.update({contextChips:Array.from({length:16},(_,i)=>({...chips[0],id:String(i)}))});
    assert.equal(button('Click canvas to add references').disabled,false);
    assert.equal(query('.canvas-r1-agent-reference-limit'),null);
    await app.update({busy:true}); await click(button('Collapse Agent'));
    assert.ok(query('.canvas-agent-orb.is-busy')); assert.equal(query('.canvas-r1-agent-header').hidden,true);
    assert.equal(button('Close Agent'),undefined);
    await app.update({busy:false,snapshot}); await click(button('Expand Agent'));
    assert.match(query('[role=log]').textContent,/visual direction/); assert.equal(app.cancelled,0);
  }finally{await app.unmount();}
});

test('strength options are capability-driven and emit exact effort without inventing unsupported choices',async()=>{
  const picked=[];const capable={...modelCatalog,available:modelCatalog.available.map((entry,i)=>i?entry:{...entry,reasoning:{efforts:[{id:'low',name:'Low'},{id:'max',name:'Maximum'}]}})};
  const app=await mount({models:capable,onSelectModel:m=>picked.push(m)});
  try {
    const select=query('button[aria-label="Reasoning strength"]'); assert.ok(select);
    assert.equal(query('select[aria-label="Reasoning strength"]'),null,'use an in-window menu, never the OS select popup');
    await click(select);
    assert.deepEqual([...query('[role=listbox]').children].map(o=>o.dataset.effort),['','low','max']);
    await click(query('[data-effort="max"]'));
    assert.deepEqual(picked[0],{provider:'Provider A',model:'text-one',reasoningEffort:'max'});
    assert.equal(query('[role=listbox]'),null); assert.equal(document.activeElement,select);
    await app.update({selectedModel:picked[0]});
    await click(select); await click(query('[data-effort=""]'));
    assert.deepEqual(picked[1],{provider:'Provider A',model:'text-one'});
    await app.update({modelSelectionLocked:true}); assert.equal(select.disabled,true);
    await app.update({modelSelectionLocked:false,selectedModel:{provider:'Provider B',model:'vision-two'}});
    assert.equal(query('[aria-label="Reasoning strength"]'),null);
  }finally{await app.unmount();}
});

test('media reference hover contains only content; text reference still shows its real body',async()=>{
  const app=await mount({contextChips:[{...chips[0],previewText:'PRIVATE IMAGE GENERATION PROMPT'}, {...chips[1],previewText:'VIDEO GENERATION PROMPT'}, {id:'note-1',title:'Real note',kind:'note',previewText:'The actual note body.'}]});
  try {
    const image=query('.canvas-r1-agent-reference-preview.is-image'), video=query('.canvas-r1-agent-reference-preview.is-video');
    assert.ok(image.querySelector('img')); assert.ok(video.querySelector('img'));
    assert.equal(image.textContent,'Image'); assert.equal(video.textContent,'Video');
    assert.match(query('.canvas-r1-agent-reference-preview.is-note').textContent,/The actual note body\./);
    assert.equal(button('Locate reference Watch photograph').getAttribute('aria-label'),'Locate reference Watch photograph');
    assert.deepEqual(app.sent,[]);
  } finally {await app.unmount();}
});

test('reference hover renders full image with thumbnail fallback, without changing the chip or reference', async()=>{
  const original='https://canvas-agent.invalid/full-image.jpg';
  const app=await mount({contextChips:[{...chips[0],previewUrl:original,previewText:'DO NOT SHOW THE GENERATION PROMPT'}]});
  try {
    const thumbnail=query('.canvas-r1-agent-context-locate img');
    assert.equal(thumbnail.src,chips[0].thumbnailUrl,'small card keeps its thumbnail');
    const preview=query('.canvas-r1-agent-reference-preview.is-image');
    assert.equal(preview.querySelector('img').src,original,'hover prefers the full original rather than a cropped thumbnail');
    await React.act(()=>preview.querySelector('img').dispatchEvent(new Event('error')));
    assert.equal(preview.querySelector('img').src,chips[0].thumbnailUrl,'failed original falls back once');
    await React.act(()=>preview.querySelector('img').dispatchEvent(new Event('error')));
    assert.equal(preview.querySelector('img'),null);assert.doesNotMatch(preview.textContent,/GENERATION PROMPT/);
    assert.equal(thumbnail.src,chips[0].thumbnailUrl);assert.deepEqual(app.sent,[]);assert.deepEqual(app.removed,[]);
  }finally{await app.unmount();}
});

test('reference hover renders text/note body once and a compact type footer for all kinds',async()=>{
  const body='Only this actual body should be shown.';
  const app=await mount({contextChips:[...chips,{id:'text-body',kind:'text',title:body,previewText:body},{id:'note-body',kind:'note',title:'A title that must not be rendered',previewText:body}]});
  try {
    for(const [kind,label] of [['image','Image'],['video','Video'],['text','Text'],['note','Note']]){
      const preview=query(`.canvas-r1-agent-reference-preview.is-${kind}`);
      assert.equal(preview.querySelector('.canvas-r1-agent-reference-kind').textContent,label);
      assert.equal(preview.querySelector('strong'),null);
      if(kind==='text'||kind==='note'){
        assert.equal(preview.querySelector('p').textContent,body);
        assert.equal(preview.textContent.split(body).length-1,1);
        assert.equal(preview.querySelector('.canvas-r1-agent-text-thumbnail'),null);
      }
    }
    await app.update({english:false});
    assert.deepEqual([...document.querySelectorAll('.canvas-r1-agent-reference-kind')].map(el=>el.textContent),['图片','视频','文本','笔记']);
    assert.deepEqual(app.sent,[]);assert.deepEqual(app.located,[]);
  }finally{await app.unmount();}
});

test('video source is hover-only, muted and looped; leave/switch/collapse release it without changing inputs',async()=>{
  const prototype=window.HTMLMediaElement.prototype, methods={play:prototype.play,pause:prototype.pause,load:prototype.load};
  const actions=[];
  prototype.play=function(){actions.push(['play',this]);return Promise.resolve();};
  prototype.pause=function(){actions.push(['pause',this]);};prototype.load=function(){};
  const film={...chips[1],videoUrl:'https://canvas-agent.invalid/film.mp4'};
  const app=await mount({contextChips:[chips[0],film]});
  const hover=element=>React.act(()=>element.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})));
  const leave=element=>React.act(()=>element.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.getElementById('canvas-node')})));
  try{
    await edit('Retain my existing draft');
    assert.equal(query('video'),null,'no hidden background decoder for every reference');
    let item=query('.canvas-r1-agent-context-list li:nth-child(2)');await hover(item);
    let video=query('video');assert.equal(video.src,film.videoUrl);assert.equal(video.muted,true);assert.equal(video.loop,true);assert.equal(video.hasAttribute('playsinline'),true);
    await leave(item);assert.equal(query('video'),null);assert.equal(video.getAttribute('src'),null);assert.ok(actions.some(([action,el])=>action==='pause'&&el===video));
    await hover(item);video=query('video');await hover(query('.canvas-r1-agent-context-list li:first-child'));assert.equal(query('video'),null);assert.equal(video.getAttribute('src'),null);
    await hover(item);video=query('video');await click(button('Collapse Agent'));assert.equal(query('video'),null);assert.equal(video.getAttribute('src'),null);
    await click(button('Expand Agent'));assert.equal(query('video'),null);assert.equal(input().value,'Retain my existing draft');
    assert.deepEqual(app.sent,[]);assert.deepEqual(app.removed,[]);assert.deepEqual(app.located,[]);
  }finally{await app.unmount();Object.assign(prototype,methods);}
});

test('hover decoder survives StrictMode, closes an old source and shows a failed source honestly',async()=>{
  const prototype=window.HTMLMediaElement.prototype, methods={play:prototype.play,pause:prototype.pause,load:prototype.load};
  const played=[];prototype.play=function(){played.push(this.getAttribute('src'));return Promise.resolve();};prototype.pause=function(){};prototype.load=function(){};
  const app=await mount({contextChips:[{id:'film',kind:'video',title:'No poster',videoUrl:'https://canvas-agent.invalid/one.mp4'}]});
  try{
    await React.act(()=>query('.canvas-r1-agent-context-list li').dispatchEvent(new MouseEvent('mouseover',{bubbles:true})));
    const old=query('video');assert.ok(played.every(source=>source==='https://canvas-agent.invalid/one.mp4'),'StrictMode cleanup cannot erase the remounted source');
    await app.update({contextChips:[{id:'film',kind:'video',title:'No poster',videoUrl:'https://canvas-agent.invalid/two.mp4'}]});
    assert.equal(old.getAttribute('src'),null);assert.equal(query('video').src,'https://canvas-agent.invalid/two.mp4');
    await React.act(()=>query('video').dispatchEvent(new Event('error')));assert.match(query('.canvas-r1-agent-reference-preview').textContent,/Preview unavailable/);
    assert.equal(input().value,'');assert.deepEqual(app.sent,[]);
  }finally{await app.unmount();Object.assign(prototype,methods);}
});

test('reasoning menu switches exclusively with model menu and closes outside without leaking Escape',async()=>{
  const picked=[]; const capable={...modelCatalog,available:modelCatalog.available.map((entry,i)=>i?entry:{...entry,reasoning:{efforts:[{id:'low',name:'Low'},{id:'max',name:'Maximum'}]}})};
  const app=await mount({models:capable,selectedModel:{provider:'Provider A',model:'text-one',reasoningEffort:'retired'},onSelectModel:m=>picked.push(m)});
  try {
    const strength=button('Reasoning strength'); await click(strength);
    assert.equal(query('[data-effort="retired"]').disabled,true);
    assert.equal(query('[role=listbox] [aria-selected=true]').disabled,true);
    await key('End',{},document.activeElement); assert.equal(document.activeElement.dataset.effort,'max');
    await key('Escape',{},document.activeElement); assert.equal(query('[role=listbox]'),null);
    assert.equal(document.activeElement,strength); assert.equal(button('Expand Agent'),undefined);
    await click(strength); await click(query('.canvas-agent-model-trigger'));
    assert.equal(query('.canvas-agent-strength-popover'),null); assert.ok(query('.canvas-agent-model-popover'));
    const node=document.getElementById('canvas-node'), stop=event=>event.stopPropagation(); node.addEventListener('pointerdown',stop);
    try {await React.act(()=>node.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})));}
    finally {node.removeEventListener('pointerdown',stop);}
    assert.equal(query('[role=listbox]'),null); assert.deepEqual(picked,[]); assert.deepEqual(app.sent,[]);
  } finally {await app.unmount();}
});


test('keyboard collapse and expand transfer focus without stealing focus on initial mount',async()=>{
  const canvasNode=document.getElementById('canvas-node'); canvasNode.focus();
  const app=await mount();
  try {
    assert.equal(document.activeElement,canvasNode);
    await edit('Keep keyboard context'); input().focus();
    await key('Escape');
    assert.equal(document.activeElement,button('Expand Agent'));
    await click(button('Expand Agent'));
    assert.equal(document.activeElement,input()); assert.equal(input().value,'Keep keyboard context');
    button('Collapse Agent').focus(); await click(button('Collapse Agent'));
    assert.equal(document.activeElement,button('Expand Agent'));
    assert.equal(app.closed,0); assert.equal(app.cancelled,0);
  }finally{await app.unmount();}
});


test('compact working row shares the decorative black hole and follows real phase state', async () => {
  const app = await mount({ english: false, busy: true });
  try {
    const row = () => query('.canvas-r1-agent-working');
    assert.equal(row().textContent, '运行中…');
    assert.equal(row().getAttribute('role'), 'status');
    assert.equal(row().getAttribute('aria-live'), 'polite');
    assert.equal(row().getAttribute('aria-atomic'), 'true');
    assert.equal(row().querySelectorAll('canvas').length, 1);
    assert.equal(row().querySelector('.canvas-r1-agent-working-indicator').getAttribute('aria-hidden'), 'true');
    assert.equal(row().querySelector('button'), null);
    assert.ok(query('.canvas-r1-agent-mark canvas'), 'header shares the same decorative mark');
    await app.update({ busy: false, execution: { planId: 'p', status: 'running', steps: [] } });
    assert.equal(row().textContent, '正在生成…');
    await click(button('停止当前任务'));
    assert.equal(row().textContent, '正在停止…');
    assert.equal(app.cancelled, 1);
    await app.update({ execution: null });
    assert.equal(row(), null, 'idle has no misleading loading row');
  } finally { await app.unmount(); }
});

test('adding phase is compact and remains pending until apply resolves', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = await mount({ english: false, snapshot: { ...snapshot, plan }, onApply: () => pending });
  try {
    await click(button('放入画布'));
    assert.equal(query('.canvas-r1-agent-working').textContent, '正在添加…');
    await React.act(async () => finish(true));
    assert.equal(query('.canvas-r1-agent-working'), null);
  } finally { await app.unmount(); }
});


test('completion, failure and cancellation remove the compact loading row', async () => {
  const app = await mount({ snapshot: { ...snapshot, status: 'running' } });
  try {
    for (const status of ['completed', 'failed', 'cancelled']) {
      await app.update({ snapshot: { ...snapshot, status: 'running' } });
      assert.equal(query('.canvas-agent-turn').getAttribute('aria-busy'), 'true');
      await app.update({ snapshot: { ...snapshot, status, ...(status === 'failed' ? { error: 'Synthetic failure' } : {}) } });
      assert.equal(query('.canvas-r1-agent-working'), null);
      if (status === 'failed') assert.match(query('[role="alert"]').textContent, /Synthetic failure/);
    }
  } finally { await app.unmount(); }
});

test('new conversation waits for ACK and retains draft edits made during the request',async()=>{
 let resolve;const gate=new Promise(done=>{resolve=done;});let calls=0;
 const app=await mount({snapshot:{...snapshot,conversationId:'old-conversation'},draftKey:'rotation-draft-test',onNewConversation:()=>{calls++;return gate;}});
 try{await edit('old draft');await click(button('New conversation'));assert.equal(calls,1);assert.equal(input().value,'old draft');assert.equal(button('Creating conversation…').disabled,true);
 await edit('newly typed draft');await React.act(async()=>resolve(true));assert.equal(input().value,'newly typed draft');assert.equal(app.sent.length,0);assert.equal(window.localStorage.getItem('luckyray.canvasAgent.draft.v1:rotation-draft-test:old-conversation'),'old draft');}
 finally{await app.unmount();}
});
test('failed new conversation preserves transcript and draft; unknown rotation disables sending',async()=>{
 const app=await mount({snapshot:{...snapshot,conversationId:'old-conversation'},onNewConversation:async()=>{throw Error('lost reset ACK');}});
 try{await edit('keep me');await click(button('New conversation'));assert.equal(input().value,'keep me');assert.ok(query('[role="log"]').textContent.includes(snapshot.messages[0].text));await app.update({rotationPending:true});assert.equal(button('Send request').disabled,true);assert.equal(button('New conversation').disabled,false);}
 finally{await app.unmount();}
});
test('copy reports success only after clipboard ACK, and reuse never sends or executes',async()=>{
 let resolve;const gate=new Promise(done=>{resolve=done;});let copied;
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied=text;await gate;}}});
 const app=await mount({snapshot});
 try{await click(button('Copy message'));assert.equal(copied,snapshot.messages[0].text);assert.equal(button('Copy message').textContent,'');await React.act(async()=>resolve());assert.equal(button('Copy message').getAttribute('title'),'Copied');await click(button('Edit & reuse'));assert.equal(input().value,snapshot.messages[0].text);assert.equal(app.sent.length,0);assert.equal(app.applied.length,0);}
 finally{await app.unmount();}
});
test('clipboard failure is honest and activity reflects only supplied bounded events',async()=>{
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}});
 const app=await mount({snapshot:{...snapshot,activity:[{id:'t1',kind:'tool',label:'reading-context',status:'completed',startedAt:100,endedAt:350}]}});
 try{await click(button('Copy message'));assert.ok(document.body.textContent.includes('Copy failed'));assert.equal(button('Copy message').textContent,'');assert.ok(query('.canvas-agent-activity').textContent.includes('Read canvas references'));assert.ok(query('.canvas-agent-activity').textContent.includes('<1s'));assert.ok(!query('.canvas-agent-activity').textContent.includes('reasoning for'));}
 finally{await app.unmount();}
});


test('R5 welcome scroll never shows a latest-message control, and transcript scrolling alone does not create unread messages', async () => {
  const app = await mount();
  try {
    const transcript = query('.canvas-r1-agent-transcript');
    Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 200 } });
    await React.act(() => { transcript.scrollTop = 0; transcript.dispatchEvent(new Event('scroll', { bubbles: true })); });
    assert.equal(query('.canvas-agent-back-bottom'), null);
    await app.update({ snapshot });
    await React.act(() => { transcript.scrollTop = 0; transcript.dispatchEvent(new Event('scroll', { bubbles: true })); });
    // Clear any unread signal from the first actual incoming transcript.
    if (query('.canvas-agent-back-bottom')) await click(query('.canvas-agent-back-bottom'));
    await React.act(() => { transcript.scrollTop = 0; transcript.dispatchEvent(new Event('scroll', { bubbles: true })); });
    assert.equal(query('.canvas-agent-back-bottom'), null);
    await app.update({ snapshot: { ...snapshot, messages: [...snapshot.messages, { role: 'assistant', text: 'A fresh result' }] } });
    const latest = query('.canvas-agent-back-bottom');
    assert.ok(latest);
    assert.ok(!transcript.contains(latest), 'unread control reserves its own rail instead of overlaying content');
    await click(latest);
    assert.equal(query('.canvas-agent-back-bottom'), null);
    assert.equal(transcript.scrollTop, transcript.scrollHeight);
  } finally { await app.unmount(); }
});

test('R5 history restores the selected conversation only after ACK, retaining current transcript and draft on failure', async () => {
  let resolve; const gate = new Promise(done => { resolve = done; }); const calls = []; let loads = 0;
  const app = await mount({ snapshot: { ...snapshot, conversationId: 'current' }, conversations: [
    { conversationId: 'current', sessionId: 'session-1', title: 'Current campaign', updatedAt: 1000, messageCount: 2 },
    { conversationId: 'old', sessionId: 'session-old', title: 'Earlier campaign', updatedAt: 500, messageCount: 4 },
  ], onLoadConversations: () => { loads++; }, onSelectConversation: id => { calls.push(id); return gate; } });
  try {
    await edit('keep until restored'); await click(button('Conversation history'));
    assert.equal(loads, 1); assert.equal(query('[aria-current=true]').textContent.includes('Current campaign'), true);
    await click(buttons().find(item => item.textContent.includes('Earlier campaign')));
    assert.deepEqual(calls, ['old']); assert.equal(input().value, 'keep until restored');
    assert.ok(query('[role=log]').textContent.includes(snapshot.messages[0].text));
    await React.act(() => resolve(false));
    assert.equal(input().value, 'keep until restored'); assert.ok(query('.canvas-agent-history-popover'));
  } finally { await app.unmount(); }
});

test('R5 message actions are icons only with accessible labels and clipboard acknowledgement', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  const app = await mount({ snapshot });
  try {
    for (const item of document.querySelectorAll('.canvas-agent-message-actions button')) { assert.equal(item.textContent, ''); assert.ok(item.getAttribute('aria-label')); assert.ok(item.querySelector('svg')); }
    await click(button('Copy message')); assert.equal(button('Copy message').title, 'Copied');
    assert.ok(query('.canvas-agent-sr-only[role=status]'));
  } finally { await app.unmount(); }
});

test('R5 public runtime tool events, progress and streaming update without inventing reasoning text', async () => {
  const live = { ...snapshot, status: 'running', messages: [{ role: 'user', text: 'Create a storyboard' }], stream: { attemptId: 'attempt', text: 'First', status: 'streaming', reasoning: true },
    tools: [{ callId: 'call-1', name: 'canvas_read_context', status: 'completed', startedAt: 100, endedAt: 400, summary: 'Read 3 canvas nodes' }],
    progress: [{ id: 'progress-1', summary: 'Arranging the storyboard', createdAt: 500 }] };
  const app = await mount({ snapshot: live });
  try {
    assert.equal(queryAllCount('.canvas-r1-agent-message.is-assistant'), 1);
    assert.ok(query('.canvas-dsh-phase').textContent.includes('Thinking'));
    assert.ok(query('.canvas-agent-turn-process').textContent.includes('Arranging the storyboard'));
    const progress=query('.canvas-dsh-progress'),progressHeader=disclosureHeader(progress);
    assert.equal(progressHeader.getAttribute('aria-expanded'),'false');
    assert.equal(progress.querySelector('.canvas-dsh-think-body'),null);
    await click(progressHeader);assert.equal(progressHeader.getAttribute('aria-expanded'),'true');
    assert.equal(progress.querySelector('.canvas-dsh-think-body p').textContent,'Arranging the storyboard');
    assert.equal(query('.canvas-agent-model-reasoning'),null,'progress text is not model reasoning');
    const message = query('.canvas-r1-agent-message.is-assistant');
    await app.update({ snapshot: { ...live, stream: { ...live.stream, text: 'First scene with soft light', reasoning: false } } });
    assert.equal(query('.canvas-r1-agent-message.is-assistant'), message, 'stream deltas preserve message component identity');
    assert.equal(query('.canvas-dsh-phase'), null);
    await app.update({ snapshot: { ...live, status: 'completed', messages: [...live.messages, { role: 'assistant', text: 'First scene with soft light' }], stream: { ...live.stream, text: 'First scene with soft light', status: 'settled', reasoning: false } } });
    assert.equal(queryAllCount('.canvas-r1-agent-message.is-assistant'), 1);
    assert.equal(query('.canvas-agent-stream-caret'), null);
  } finally { await app.unmount(); }
});
function queryAllCount(selector) { return document.querySelectorAll(selector).length; }

test('R5 autonomous defaults prohibit media jobs and generation permission is single-request', async () => {
  const sent = [];
  const app = await mount({ onSend: async (...args) => { sent.push(args); return true; } });
  try {
    await edit('Arrange my canvas'); await click(button('Send request'));
    assert.deepEqual(sent[0][1], { mode: 'autonomous', allowGeneration: false, maxMediaJobs: 0 });
    const permission = query('.canvas-agent-generation-permission input');
    await click(permission); await edit('Generate one image'); await click(button('Send request'));
    assert.deepEqual(sent[1][1], { mode: 'autonomous', allowGeneration: true, maxMediaJobs: 1 });
    assert.equal(permission.checked, false);
    await edit('Refine the layout'); await click(button('Send request'));
    assert.equal(sent[2][1].allowGeneration, false);
  } finally { await app.unmount(); }
});

test('R5 real supplied reasoning uses the official default-collapsed disclosure', async () => {
  const text = 'Synthetic public model reasoning for this UI test.';
  const app = await mount({ snapshot: { ...snapshot, messages: [{ role: 'user', text: 'A visual story' }, { role: 'assistant', text: 'The proposal is ready.', reasoningText: text }] } });
  try {
    const reasoning = query('.canvas-agent-model-reasoning'), header = disclosureHeader(reasoning);
    assert.ok(reasoning); assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(reasoning.hasAttribute('data-expanded'), false);
    assert.equal(reasoningScroll(reasoning), null, 'official collapsed bodies are not mounted');
    assert.equal(reasoning.querySelector('.canvas-agent-reasoning-preview').textContent, text);
    await click(header); assert.equal(header.getAttribute('aria-expanded'), 'true');
    assert.equal(reasoning.getAttribute('data-expanded'), 'true');
    assert.equal(reasoningScroll(reasoning).querySelector('p').textContent, text);
    await app.update({ snapshot }); assert.equal(query('.canvas-agent-model-reasoning'), null);
  } finally { await app.unmount(); }
});

test('R5 history success restores saved draft without sending a model request', async () => {
  const draftKey = 'history-success';
  window.localStorage.setItem(`luckyray.canvasAgent.draft.v1:${draftKey}:older`, 'Older conversation draft');
  const app = await mount({ draftKey, snapshot: { ...snapshot, conversationId: 'current' }, conversations: [{ conversationId: 'older', sessionId: 'old-session', title: 'Older session', updatedAt: 500, messageCount: 2 }], onSelectConversation: async () => true });
  try {
    await edit('Current draft'); await click(button('Conversation history'));
    await click(buttons().find(item => item.textContent.includes('Older session')));
    assert.equal(input().value, 'Older conversation draft');
    assert.equal(window.localStorage.getItem(`luckyray.canvasAgent.draft.v1:${draftKey}:current`), 'Current draft');
    assert.equal(query('.canvas-agent-history-popover'), null); assert.equal(app.sent.length, 0);
  } finally { await app.unmount(); }
});

test('R5 history dismisses on outside pointerdown even inside the canvas event-isolated panel', async () => {
  const app = await mount({ snapshot: { ...snapshot, conversationId: 'current' }, onSelectConversation: async () => true });
  try {
    await click(button('Conversation history')); assert.ok(query('.canvas-agent-history-popover'));
    await React.act(() => input().dispatchEvent(new Event('pointerdown', { bubbles: true })));
    assert.equal(query('.canvas-agent-history-popover'), null);
    await click(button('Conversation history')); await key('Escape');
    assert.equal(query('.canvas-agent-history-popover'), null); assert.equal(query('.canvas-r1-agent-panel').classList.contains('is-collapsed'), false);
  } finally { await app.unmount(); }
});


test('R6 one turn owns reasoning, tools and response, while old turn tools keep their owner', async()=>{
 const app=await mount({snapshot:{...snapshot,messages:[{role:'user',text:'one'},{role:'assistant',text:'First response',turnId:'r1',createdAt:10},{role:'user',text:'two'},{role:'assistant',text:'',reasoningText:'Public analysis',turnId:'r2',createdAt:30},{role:'assistant',text:'Second response',turnId:'r2',createdAt:50}],tools:[{callId:'old',turnId:'r1',name:'canvas_read_context',status:'completed',startedAt:5,endedAt:9,summary:'Old receipt'},{callId:'new',turnId:'r2',name:'canvas_apply_plan',status:'completed',startedAt:40,endedAt:45,summary:'New receipt'}]}});
 try{const turns=[...document.querySelectorAll('.canvas-agent-turn')];assert.equal(turns.length,2);assert.equal(turns[1].querySelectorAll('.canvas-r1-agent-message-label').length,1);assert.ok(turns[0].textContent.includes('Old receipt'));assert.ok(!turns[1].textContent.includes('Old receipt'));assert.ok(turns[1].textContent.includes('Public analysis'));assert.ok(turns[1].textContent.includes('Second response'));const process=turns[1].querySelector('.canvas-agent-turn-process');assert.ok(process.textContent.indexOf('Public analysis')<process.textContent.indexOf('New receipt'));assert.ok(!process.textContent.includes('Second response'));}finally{await app.unmount();}
});
test('R6 user actions are outside bubble and remain icon-only focusable buttons',async()=>{
 const app=await mount({snapshot});try{const message=query('.canvas-r1-agent-message.is-user');const bubble=message.querySelector('.canvas-agent-user-bubble');assert.equal(bubble.textContent,snapshot.messages[0].text);assert.equal(bubble.querySelector('button'),null);const actions=message.querySelector('.canvas-agent-message-actions');assert.equal(actions.parentElement,message);for(const b of actions.querySelectorAll('button')){assert.ok(b.getAttribute('aria-label'));assert.equal(b.textContent,'');b.focus();assert.equal(document.activeElement,b);}}finally{await app.unmount();}
});
test('R6 permissions are in the model row, preserve generation opt-in, close on Escape',async()=>{
 const app=await mount();try{const menu=query('.canvas-agent-run-settings');assert.equal(menu.parentElement.className,'canvas-r1-agent-composer-bottom');assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'),false);await click(menu.querySelector('.canvas-agent-popover-trigger'));assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'),true);assert.equal(menu.querySelector('input[type=checkbox]').checked,false);await key('Escape',{},menu.querySelector('select'));assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'),false);assert.equal(document.activeElement,menu.querySelector('.canvas-agent-popover-trigger'));}finally{await app.unmount();}
});
test('R6 missing reasoning never invents a reasoning block and running avatar uses shared black hole',async()=>{
 const app=await mount({snapshot:{...snapshot,status:'running',messages:[{role:'user',text:'go'}],stream:{turnId:'run-1',attemptId:'a1',text:'Visible answer',status:'streaming',reasoning:false}}});try{assert.equal(query('.canvas-agent-model-reasoning'),null);assert.ok(query('.canvas-agent-turn-mark .canvas-agent-orb-visual'));assert.equal(query('.canvas-agent-turn').getAttribute('aria-busy'),'true');}finally{await app.unmount();}
});

test('R6 legacy reasoning-only chunks form one official Markdown disclosure without losing paragraphs',async()=>{
 const chunks=Array.from({length:9},(_,i)=>({role:'assistant',text:'',reasoningText:`Visible paragraph ${i}`}));
 const app=await mount({snapshot:{...snapshot,messages:[{role:'user',text:'go'},...chunks,{role:'assistant',text:'Done'}]}});
 try{
  assert.equal(queryAllCount('.canvas-agent-turn'),1);assert.equal(queryAllCount('.canvas-agent-model-reasoning'),1);
  const row=query('.canvas-agent-model-reasoning');assert.equal(reasoningScroll(row),null);
  await click(disclosureHeader(row));
  assert.deepEqual([...reasoningScroll(row).querySelectorAll('p')].map(p=>p.textContent),chunks.map(x=>x.reasoningText));
 }finally{await app.unmount();}
});

test('R6 permission popup closes on nonfocusable outside pointer without changing authorization',async()=>{
 const app=await mount();try{const menu=query('.canvas-agent-run-settings');await click(menu.querySelector('.canvas-agent-popover-trigger'));assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'),true);await React.act(()=>document.getElementById('root').dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'),false);assert.equal(menu.querySelector('input[type=checkbox]').checked,false);}finally{await app.unmount();}
});

test('R6 a new reasoning-only attempt is not suppressed by the previous empty-text durable message',async()=>{
 const app=await mount({snapshot:{...snapshot,status:'running',messages:[{role:'user',text:'go'},{role:'assistant',text:'',reasoningText:'First phase',turnId:'run-1',attemptId:'a1'}],stream:{turnId:'run-1',attemptId:'a2',text:'',reasoningText:'Second phase',reasoning:true,status:'streaming'}}});
 try{
  const rows=[...document.querySelectorAll('.canvas-agent-model-reasoning')];assert.equal(rows.length,2);
  assert.ok(query('.canvas-agent-turn').textContent.includes('First phase'));
  assert.equal(rows[1].querySelector('.canvas-agent-reasoning-preview').textContent,'','official active preview waits for a complete first line');
  for(const row of rows)await click(disclosureHeader(row));
  assert.deepEqual(rows.map(row=>reasoningScroll(row).textContent),['First phase','Second phase']);
  assert.equal(queryAllCount('.canvas-agent-turn'),1);
 }finally{await app.unmount();}
});

test('R6 quiet actions include focus/touch escape hatches and model interiors share ratio tokens',()=>{
 const panelCss=fs.readFileSync(path.join(__dirname,'canvasAgentPanel.css'),'utf8');
 assert.match(panelCss,/canvas-agent-message-actions \{[^}]*opacity:0;[^}]*pointer-events:none/s);
 assert.match(panelCss,/:is\(:hover,:focus-within\)/);
 assert.match(panelCss,/@media \(hover:none\)[^}]*canvas-agent-message-actions[^}]*opacity:1/s);
 const css=fs.readFileSync(path.join(appRoot,'src/canvas-spike-scroll.css'),'utf8');
 assert.match(css,/:root \.canvas-composer-popover\.canvas-composer-model-popover > button,:root \.canvas-composer-popover \.canvas-composer-setting button \{ background:var\(--canvas-option-bg\)/);
 assert.match(css,/--canvas-option-selected:rgba\(34,34,38,\.98\)/);
});

test('R6 settled reasoning is historical content, not an active thinking signal',async()=>{
 const app=await mount({snapshot:{...snapshot,status:'running',messages:[{role:'user',text:'go'},{role:'assistant',text:'',turnId:'run-1',attemptId:'a',reasoningText:'Published reasoning'}],stream:{attemptId:'a',turnId:'run-1',text:'',reasoningText:'Published reasoning',status:'settled',reasoning:true},tools:[{callId:'tool',turnId:'run-1',name:'canvas_read_context',status:'running',startedAt:1}]}});try{assert.equal(query('.canvas-agent-turn-process > summary').textContent,'Task activity');assert.match(query('.canvas-agent-live-wordmark').textContent,/Read canvas/);assert.equal(query('.canvas-dsh-phase'),null);assert.ok(query('.canvas-agent-model-reasoning'));}finally{await app.unmount();}
});
test('R6 previous failed or cancelled turns become neutral history, never fabricated completed outcomes',async()=>{
 for(const status of ['failed','cancelled']){const first={...snapshot,status,messages:[{role:'user',text:'old'},{role:'assistant',text:'old response',reasoningText:'Old analysis',turnId:'old'}]};const app=await mount({snapshot:first});try{assert.ok(query('.canvas-agent-turn-process > summary').textContent.includes(status==='failed'?'Interrupted':'Stopped'));await app.update({snapshot:{...first,status:'running',messages:[...first.messages,{role:'user',text:'new'},{role:'assistant',text:'new response',turnId:'new'}]}});assert.equal(query('.canvas-agent-turn-process > summary').textContent,'Activity');}finally{await app.unmount();}}
});

test('R6 official event sequence orders tool and reasoning even in the same millisecond',async()=>{
 const app=await mount({snapshot:{...snapshot,messages:[{role:'user',text:'go'},{role:'assistant',text:'',reasoningText:'After tool',turnId:'r',createdAt:100,eventSeq:8},{role:'assistant',text:'Final answer',turnId:'r',createdAt:100,eventSeq:9}],tools:[{callId:'tool',turnId:'r',name:'canvas_read_context',status:'completed',startedAt:100,endedAt:100,eventSeq:7,summary:'Before analysis'}]}});try{const process=query('.canvas-agent-turn-process');assert.ok(process.textContent.indexOf('Before analysis')<process.textContent.indexOf('After tool'));}finally{await app.unmount();}
});

test('R7 repeated generation opt-in keeps the StrictMode panel mounted and does not send', async () => {
  const app = await mount({ draftKey: 'r7-permission-repeat' });
  try {
    await edit('Do not lose this draft');
    const menu = query('.canvas-agent-run-settings');
    await click(menu.querySelector('.canvas-agent-popover-trigger'));
    for (let index = 0; index < 50; index++) {
      const permission = menu.querySelector('input[type="checkbox"]');
      await click(permission);
      assert.equal(permission.checked, index % 2 === 0);
      assert.equal(!menu.querySelector('input[type="number"]').parentElement.hidden, index % 2 === 0);
      assert.equal(input().value, 'Do not lose this draft');
      assert.ok(query('.canvas-r1-agent-panel'));
    }
    assert.deepEqual(app.sent, []);
  } finally { await app.unmount(); }
});

test('R7 permission switching, budget focus removal and outside dismissal preserve a safe authorization', async () => {
  const app = await mount();
  try {
    const menu = query('.canvas-agent-run-settings');
    const permission = () => menu.querySelector('input[type="checkbox"]');
    await click(menu.querySelector('.canvas-agent-popover-trigger'));
    await click(permission());
    const budget = menu.querySelector('input[type="number"]');
    budget.focus();
    await click(permission());
    assert.equal(permission().checked, false);
    const mode = menu.querySelector('select');
    await click(permission());
    await React.act(() => { mode.value = 'plan'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(permission().checked, false);
    assert.equal(permission().disabled, true);
    await React.act(() => { mode.value = 'autonomous'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(permission().checked, false, 'returning to auto must not restore generation permission');
    await click(permission());
    await app.update({ busy: true });
    assert.equal(permission().disabled, true);
    await click(permission());
    assert.equal(permission().checked, true, 'disabled controls cannot change the current authorization');
    await app.update({ busy: false });
    await React.act(() => permission().focus());
    await React.act(() => { document.getElementById('canvas-node').focus(); document.dispatchEvent(new KeyboardEvent('keyup', {key: 'Tab', bubbles: true})); });
    assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'), false);
    assert.deepEqual(app.sent, []);
  } finally { await app.unmount(); }
  await React.act(() => document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  const reopened = await mount();
  try { assert.equal(query('.canvas-agent-generation-permission input').checked, false); }
  finally { await reopened.unmount(); }
});

test('R7 rapid batched permission toggles and unmount do not leak listeners or authorization', async () => {
  const app = await mount();
  const menu = query('.canvas-agent-run-settings');
  await click(menu.querySelector('.canvas-agent-popover-trigger'));
  await React.act(() => {
    for (let i = 0; i < 100; i++) menu.querySelector('input[type="checkbox"]').click();
  });
  assert.equal(menu.querySelector('input[type="checkbox"]').checked, false);
  assert.ok(query('.canvas-r1-agent-panel'));
  await app.unmount();
  await React.act(() => { document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
  assert.equal(query('.canvas-r1-agent-panel'), null);
});

test('R7 Agent render failure is isolated, keeps the draft and resets generation consent on recovery', async () => {
  const oldError = console.error, oldWarn = console.warn;
  const warnings = [];
  console.error = () => {}; console.warn = (...values) => warnings.push(values);
  let cancelCount = 0;
  const app = await mount({ draftKey: 'r7-boundary-draft', onCancel: () => { cancelCount += 1; } });
  try {
    await edit('Keep this private draft');
    await click(query('.canvas-agent-generation-permission input'));
    await app.update({ busy: true, snapshot: { ...snapshot, messages: [{ role: 'assistant', text: {} }] } });
    assert.ok(query('.canvas-agent-recovery'));
    assert.ok(document.getElementById('canvas-node'), 'the canvas host survives');
    assert.match(query('[role="alert"]').textContent, /LR_CANVAS_UI_TYPE/);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0].slice(0,2), ['[LuckyRay Canvas Agent]', 'LR_CANVAS_UI_TYPE']);
    assert.equal(warnings[0][2].message, 'Value is not a function');
    assert.equal(warnings[0][2].phase, 'running');
    assert.equal(warnings[0][2].hasSession, true);
    assert.equal(warnings[0][2].allowGeneration, true);
    assert.ok(warnings[0][2].componentStack.includes('CanvasAgentPanelContent'));
    assert.equal(JSON.stringify(warnings).includes('session-1'), false);
    assert.equal(JSON.stringify(warnings).includes('private draft'), false);
    await click(button('Stop current task'));
    assert.equal(cancelCount, 1);
    await app.update({ busy: false, snapshot: null });
    assert.ok(query('.canvas-agent-recovery'), 'prop updates do not auto-retry a broken view');
    await click(button('Restore conversation'));
    assert.equal(query('.canvas-agent-recovery'), null);
    assert.equal(input().value, 'Keep this private draft');
    assert.equal(query('.canvas-agent-generation-permission input').checked, false);
    assert.deepEqual(app.sent, []);
  } finally { await app.unmount(); console.error = oldError; console.warn = oldWarn; }
});

test('R7 settings ignore malformed values and retain popup for non-Node focus destinations', async () => {
  const app = await mount();
  try {
    const menu = query('.canvas-agent-run-settings');
    await click(menu.querySelector('.canvas-agent-popover-trigger'));
    await click(menu.querySelector('input[type="checkbox"]'));
    const budget = menu.querySelector('input[type="number"]');
    for (const value of ['', '0', '-1', '1.5', '1001']) {
      await React.act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(budget, value);
        budget.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await React.act(() => {
      budget.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: window }));
    });
    assert.equal((menu.querySelector('.canvas-agent-popover-trigger').getAttribute('aria-expanded') === 'true'), true);
    assert.ok(query('.canvas-r1-agent-panel'));
    assert.equal(query('.canvas-agent-recovery'), null);
    const mode = menu.querySelector('select');
    await React.act(() => { mode.value = 'invalid'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    await edit('Verify permission shape');
    const sent = [];
    await app.update({ onSend: async (...args) => { sent.push(args); } });
    await click(button('Send request'));
    assert.deepEqual(sent[0][1], { mode: 'autonomous', allowGeneration: true, maxMediaJobs: 1 });
  } finally { await app.unmount(); }
});

test('R7 activity retains its quiet outer disclosure and official tool title with truthful duration', async () => {
  const app = await mount({ snapshot: {...snapshot, tools:[{callId:'precise',name:'canvas_apply_plan',status:'completed',startedAt:10,endedAt:310,displayTitle:'编辑晨光分镜',displayTitleEn:'Edit morning storyboard',summary:'Saved one node'}]} });
  try {
    assert.equal(query('.canvas-agent-turn-process').open, false);
    const tool=query('.canvas-dsh-tool[data-call-id="precise"]'), header=disclosureHeader(tool);
    assert.match(header.textContent,/Edit morning storyboard/);
    assert.match(header.textContent,/<1s/);assert.equal(header.getAttribute('aria-expanded'),'false');
    assert.equal(tool.querySelector('[data-state]').getAttribute('data-state'),'ok');
    await click(query('.canvas-agent-turn-process > summary'));
    assert.equal(query('.canvas-agent-turn-process').open, true);
    await click(header);assert.equal(header.getAttribute('aria-expanded'),'true');
    assert.ok(tool.textContent.includes('OUTSaved one node'));
  } finally { await app.unmount(); }
});

test('R7 completed thought uses recorded duration, exposes literal excerpt and does not invent old timings', async () => {
  const message = {role:'assistant', text:'Final',reasoningText:'A literal public thought about a morning scene.',reasoningStartedAt:100,reasoningEndedAt:4100,reasoningDurationMs:2100};
  const app = await mount({snapshot:{...snapshot,messages:[snapshot.messages[0],message]}});
  try {
    const row=query('.canvas-agent-model-reasoning');
    assert.equal(row.querySelector('.canvas-agent-reasoning-caption').textContent,'Thought 2s');
    assert.equal(row.querySelector('.canvas-agent-reasoning-preview').textContent,message.reasoningText);
    assert.equal(reasoningScroll(row),null);await click(disclosureHeader(row));
    assert.equal(reasoningScroll(row).querySelector('p').textContent,message.reasoningText);
    await app.update({snapshot:{...snapshot,messages:[snapshot.messages[0],{role:'assistant',text:'Old final',reasoningText:'Legacy public text'}]}});
    assert.equal(query('.canvas-agent-reasoning-caption').textContent,'Thought');
    assert.equal(query('.canvas-agent-turn-process > summary').textContent,'Completed');
    assert.equal(query('.canvas-agent-turn-process > summary svg.canvas-agent-trace-chevron').getAttribute('viewBox'),'0 0 16 16');
  } finally { await app.unmount(); }
});

test('R7 live thought time adds only the active segment and leaves disclosure open choice alone', async () => {
  const now = Date.now();
  const stream = {attemptId:'timed',turnId:'run-1',startedAt:now-9000,status:'streaming',text:'',reasoning:true,reasoningText:'Live literal text',reasoningStartedAt:now-9000,reasoningDurationMs:2000,reasoningActiveStartedAt:now-1000};
  const app = await mount({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0]],stream}});
  try {
    assert.match(query('.canvas-agent-reasoning-caption').textContent,/Thinking 3s/);
    assert.equal(query('.canvas-agent-turn-process').open,true);
    assert.ok(query('.canvas-agent-live-wordmark').textContent.includes('Thinking'));
    await click(query('.canvas-agent-turn-process > summary'));
    await click(query('.canvas-agent-turn-process > summary'));
    await app.update({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0]],stream:{...stream,reasoningText:'Live literal text updated\n'}}});
    assert.equal(query('.canvas-agent-turn-process').open,true);
    assert.ok(query('.canvas-agent-reasoning-preview').textContent.includes('updated'));
  } finally { await app.unmount(); }
});
test('R7 official thinking preview truncates in CSS without clipping the supplied source',async()=>{
  const text='A public sentence. '.repeat(100);
  const app=await mount({snapshot:{...snapshot,messages:[snapshot.messages[0],{role:'assistant',text:'Done',reasoningText:text}]}});
  try{
    const row=query('.canvas-agent-model-reasoning'),preview=row.querySelector('.canvas-agent-reasoning-preview');
    assert.equal(preview.textContent,text,'CSS truncation must not delete source characters');
    assert.ok(preview.textContent.length>140);assert.equal(reasoningScroll(row),null);
    const css=fs.readFileSync(path.join(__dirname,'canvasAgentPanel.css'),'utf8');
    assert.match(css,/\.canvas-dsh-summary\{[^}]*white-space:nowrap[^}]*overflow:hidden/);
    assert.match(css,/\.canvas-dsh-summary-text\{[^}]*text-overflow:ellipsis[^}]*overflow:hidden/);
    await click(disclosureHeader(row));assert.equal(reasoningScroll(row).querySelector('p').textContent,text.trimEnd());
  }finally{await app.unmount();}
});

test('R7 model stays grouped with strength and motion has explicit reduced-motion fallback',()=>{
 const css=fs.readFileSync(path.join(__dirname,'canvasAgentPanel.css'),'utf8');
 assert.match(css,/canvas-agent-model-picker \{ flex:0 1 auto; margin-left:auto/);
 assert.match(css,/canvas-agent-strength \{ margin-left:0/);
 assert.match(css,/prefers-reduced-motion:reduce[^}]*canvas-agent-live-wordmark[^}]*animation:none/s);
 const source=fs.readFileSync(path.join(__dirname,'CanvasAgentBlackHole.tsx'),'utf8');
 assert.ok(!source.includes("if (!animated) { canvas.dataset.ready = 'false'; return; }"));
});
test('R7 different reasoning attempts never merge completed duration into active reasoning',async()=>{
 const now=Date.now();const app=await mount({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0],{role:'assistant',text:'',turnId:'run-1',attemptId:'first',reasoningText:'First public reasoning',reasoningDurationMs:5000}],stream:{turnId:'run-1',attemptId:'second',text:'',status:'streaming',reasoning:true,reasoningText:'Second public reasoning',reasoningStartedAt:now-10000,reasoningDurationMs:0,reasoningActiveStartedAt:now-10000}}});
 try{const captions=realElements('.canvas-agent-reasoning-caption').map(e=>e.textContent);assert.deepEqual(captions,['Thought 5s','Thinking 10s']);assert.equal(queryAllCount('.canvas-agent-model-reasoning'),2);}finally{await app.unmount();}
});

test('R7 application motion preference reaches historical and live black holes and portaled dialogs', async () => {
  const app=await mount({snapshot});
  try {
    assert.ok([...document.querySelectorAll('.canvas-agent-orb-visual')].every(mark=>mark.dataset.motion==='flow'));
    await app.update({testReducedMotion:true});
    assert.ok([...document.querySelectorAll('.canvas-agent-orb-visual')].every(mark=>mark.dataset.motion==='still'));
    await app.update({testReducedMotion:false});
    assert.ok([...document.querySelectorAll('.canvas-agent-orb-visual')].every(mark=>mark.dataset.motion==='flow'));
  } finally { await app.unmount(); }
  const root=createRoot(document.getElementById('root'));
  try {
    await React.act(()=>root.render(React.createElement(CanvasMotionProvider,{reduced:true},React.createElement(CanvasCreativeDialog,{title:'Test',onClose:()=>{}},'Content'))));
    assert.ok(document.body.querySelector('.canvas-creative-overlay.reduce-motion'));
    assert.equal(document.getElementById('root').querySelector('.canvas-creative-overlay'),null,'dialog remains a real body portal');
  } finally { await React.act(()=>root.unmount()); }
});
test('R7B interrupted reasoning with unknown timing keeps literal text without a precise duration',async()=>{
 const app=await mount({snapshot:{...snapshot,status:'cancelled',activity:[{id:'start',kind:'phase',label:'preparing',status:'failed',startedAt:100},{id:'read',kind:'phase',label:'reading-context',status:'completed',startedAt:150,endedAt:300}],tools:[{callId:'offline',name:'canvas_apply_plan',status:'failed',startedAt:400}],messages:[snapshot.messages[0]],stream:{turnId:'run-1',attemptId:'recovered',status:'interrupted',text:'',reasoning:true,reasoningText:'Preserved published reasoning before restart'}}});
 try{assert.equal(query('.canvas-agent-reasoning-caption').textContent,'Thought');await click(disclosureHeader(query('.canvas-agent-model-reasoning')));assert.equal(reasoningScroll(query('.canvas-agent-model-reasoning')).querySelector('p').textContent,'Preserved published reasoning before restart');assert.match(query('.canvas-agent-process-label').textContent,/Stopped/);assert.doesNotMatch(query('.canvas-agent-process-label').textContent,/\d/);}finally{await app.unmount();}
});

test('R7B uncertain receipt is a small recoverable status, not a disconnected alert',async()=>{
 let refresh=0;const app=await mount({snapshot,error:'canvas-agent-start-unconfirmed',formatError:()=> 'Receipt is uncertain',onRefresh:()=>{refresh++}});
 try{assert.equal(query('.canvas-r1-agent-error'),null);assert.match(query('.canvas-agent-receipt-notice').textContent,/Receipt is uncertain/);await click(button('Check status'));assert.equal(refresh,1);assert.equal(button('Reconnect'),undefined);await click(button('Stop previous task'));assert.equal(app.cancelled,1);await app.update({error:'canvas-agent-previous-request-recovered'});assert.equal(button('Check status'),undefined);assert.equal(query('.canvas-r1-agent-error'),null);}finally{await app.unmount();}
});
test('R7B confirmed cancellation clears per-request media consent but keeps unsent edits',async()=>{
 const app=await mount({error:'canvas-agent-start-unconfirmed',onCancel:async()=>true});
 try{await edit('Keep my next edit');await click(query('.canvas-agent-generation-permission input'));assert.equal(query('.canvas-agent-generation-permission input').checked,true);await click(button('Stop previous task'));assert.equal(query('.canvas-agent-generation-permission input').checked,false);assert.equal(input().value,'Keep my next edit');assert.deepEqual(app.sent,[]);}finally{await app.unmount();}
});


test('result icons use verified live IDs, select-all sends the execution only, and removed results disable quietly', async () => {
  const execution = {planId:'results',owner:{canvasId:'canvas-1',loadEpoch:1},status:'completed',steps:[
    {id:'s1',nodeId:'a',title:'First draft',kind:'image',status:'draft'},
    {id:'s2',nodeId:'b',title:'Edited text',kind:'text',status:'succeeded'},
    {id:'s3',nodeId:'a',title:'Same result',kind:'image',status:'succeeded'},
    {id:'s4',nodeId:'deleted',title:'Deleted result',kind:'video',status:'failed'},
  ]};
  const app = await mount({execution,executionNodeIds:['a','b','a']});
  try {
    const all = button('Select and locate all results');
    assert.equal(all.textContent,'','select-all stays icon-only');
    assert.equal(all.disabled,false);
    const tooltip = document.getElementById(all.getAttribute('aria-describedby'));
    assert.equal(tooltip.getAttribute('role'),'tooltip');
    assert.equal(tooltip.textContent,'Select and locate 2 result nodes');
    await click(all);
    assert.deepEqual(app.executionLocated,[[execution,undefined]]);
    assert.equal(button('Locate Deleted result').disabled,true);
    await click(button('Locate Deleted result'));
    assert.equal(app.executionLocated.length,1);
    await click(button('Locate Edited text'));
    assert.deepEqual(app.executionLocated[1],[execution,'b']);
    await app.update({executionNodeIds:['b']});
    assert.equal(button('Locate First draft').disabled,true);
    assert.equal(button('Locate Edited text').disabled,false);
    await app.update({executionNodeIds:[]});
    assert.equal(button('Select and locate all results').disabled,true);
    assert.match(query('.canvas-r1-agent-section-heading [role=tooltip]').textContent,/No results are available/);
    await click(button('Select and locate all results'));
    assert.equal(app.executionLocated.length,2);
    await app.update({english:false});
    assert.equal(button('选中并定位全部结果').disabled,true);
    assert.match(query('.canvas-r1-agent-section-heading [role=tooltip]').textContent,/暂无可定位/);
    assert.deepEqual(app.sent,[]);assert.deepEqual(app.applied,[]);assert.equal(app.cancelled,0);
  } finally { await app.unmount(); }
});

test('results without a verified navigation integration never fall back to unguarded locate', async () => {
  const app = await mount({execution:{planId:'unverified',status:'draft',steps:[{id:'s',nodeId:'unverified-node',title:'Unverified',kind:'text',status:'draft'}]},executionNodeIds:['unverified-node'],onLocateExecution:undefined});
  try {
    assert.equal(button('Locate Unverified').disabled,true);
    assert.equal(button('Select and locate all results').disabled,true);
    await click(button('Locate Unverified'));
    assert.deepEqual(app.located,[]);
  } finally { await app.unmount(); }
});

test('hit-test regression: settings retains its subtree through pointer down and null blur, dismisses on completed outside click', async () => {
  const app = await mount();
  try {
    const menu = query('.canvas-agent-run-settings');
    const trigger = menu.querySelector('.canvas-agent-popover-trigger');
    const content = document.getElementById(trigger.getAttribute('aria-controls'));
    assert.equal(menu.tagName, 'DIV'); assert.equal(menu.querySelector('summary, details'), null);
    assert.equal(content.hidden, true);
    await click(trigger);
    const checkbox = menu.querySelector('input[type=checkbox]');
    const budget = menu.querySelector('input[type=number]');
    checkbox.focus();
    for (let i = 0; i < 30; i++) {
      await React.act(() => {
        checkbox.parentElement.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        checkbox.parentElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        checkbox.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      });
      assert.equal(content.hidden, false);
      await React.act(() => checkbox.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
      await click(checkbox.parentElement);
      assert.equal(checkbox.checked, i % 2 === 0, 'label click changes real authorization');
      assert.equal(menu.querySelector('input[type=number]'), budget, 'stable budget node');
      assert.equal(content.hidden, false);
    }
    const outside = document.getElementById('canvas-node');
    await React.act(() => {
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      outside.focus();
    });
    assert.equal(content.hidden, false, 'no teardown in mouse-down/focus chain');
    await click(outside);
    assert.equal(content.hidden, true); assert.equal(document.activeElement, outside);
    assert.deepEqual(app.sent, []); assert.deepEqual(app.applied, []);
  } finally { await app.unmount(); }
});

test('hit-test regression: both popovers support Escape and completed keyboard Tab without collapsing Agent', async () => {
  const app = await mount();
  try {
    for (const selector of ['.canvas-agent-run-settings', '.canvas-r1-agent-creation-menu']) {
      const menu = query(selector), trigger = menu.querySelector('.canvas-agent-popover-trigger');
      const content = document.getElementById(trigger.getAttribute('aria-controls'));
      assert.equal(menu.tagName, 'DIV'); assert.equal(menu.querySelector('summary, details'), null);
      await click(trigger); trigger.focus();
      await key('Escape', {}, trigger);
      assert.equal(content.hidden, true); assert.equal(document.activeElement, trigger);
      assert.equal(query('.canvas-r1-agent-body').hidden, false);
      for (const shiftKey of [false, true]) {
        await click(trigger);
        const outside = document.getElementById('canvas-node'); outside.focus();
        await React.act(() => outside.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', shiftKey, bubbles: true })));
        assert.equal(content.hidden, true); assert.equal(document.activeElement, outside);
      }
    }
    await click(query('.canvas-agent-run-settings .canvas-agent-popover-trigger'));
    await click(button('Creative starters'));
    assert.equal(query('.canvas-agent-run-settings').hasAttribute('data-open'), false);
    const starter = query('.canvas-r1-agent-creation-options button');
    await click(starter);
    assert.equal(query('.canvas-r1-agent-creation-options').hidden, true);
    assert.equal(document.activeElement, input()); assert.ok(input().value.length > 0);
    assert.deepEqual(app.sent, []); assert.deepEqual(app.applied, []);
  } finally { await app.unmount(); }
});

test('R8 request rail indexes users, previews actual replies, and never counts tools as requests', async () => {
  const messages = [
    { role:'user',text:'Morning scene' }, { role:'assistant',text:'Use a quiet sunrise.',turnId:'first' },
    { role:'assistant',text:'With a blue palette.',turnId:'first' },
    { role:'user',text:'Evening scene' }, { role:'assistant',text:'Use warm evening light.' },
  ];
  const app = await mount({snapshot:{...snapshot,messages,tools:[{callId:'one',name:'canvas_read_context',status:'completed',startedAt:1,endedAt:21}]}});
  try {
    const marks = [...document.querySelectorAll('.canvas-agent-turn-marks button')];
    assert.equal(marks.length,2); assert.equal(document.querySelectorAll('[data-agent-query]').length,2);
    assert.equal(query('.canvas-r1-agent-transcript').tabIndex,0);
    await React.act(() => marks[0].focus());
    const preview = query('.canvas-agent-turn-preview');
    assert.equal(preview.querySelector('strong').textContent,'Morning scene');
    assert.ok(preview.querySelector('p').textContent.includes('quiet sunrise'));
    assert.ok(preview.querySelector('p').textContent.includes('blue palette'));
    assert.equal(marks[0].getAttribute('aria-describedby'),preview.id);
    await key('Escape',{},marks[0]); assert.equal(query('.canvas-agent-turn-preview'),null);
    assert.equal(app.sent.length,0); assert.equal(app.applied.length,0);
  } finally { await app.unmount(); }
});

test('R8 jumping to a request does not make later streaming steal the reading position', async () => {
  const messages = [{role:'user',text:'First question'},{role:'assistant',text:'First answer'},{role:'user',text:'Next question'},{role:'assistant',text:'Next answer'}];
  const app = await mount({snapshot:{...snapshot,messages}});
  try {
    const host = query('.canvas-r1-agent-transcript');
    Object.defineProperties(host,{scrollHeight:{configurable:true,value:1600},clientHeight:{configurable:true,value:300}});
    host.getBoundingClientRect = () => ({top:50});
    query('[data-agent-query]').getBoundingClientRect = () => ({top:250});
    host.scrollTop = 100;
    await click(query('.canvas-agent-turn-marks button'));
    assert.equal(host.scrollTop,288);
    await app.update({snapshot:{...snapshot,messages:[...messages,{role:'assistant',text:'Streaming continuation.'}]}});
    assert.equal(host.scrollTop,288);
    assert.ok(query('.canvas-agent-back-bottom'));
    assert.ok(!host.contains(query('.canvas-agent-turn-rail')));
  } finally { await app.unmount(); }
});

test('R8 long conversations bound navigation marks and keyboard still reaches unsampled requests', async () => {
  const messages = Array.from({length:120},(_,i)=>[{role:'user',text:`Question ${i}`},{role:'assistant',text:`Answer ${i}`}]).flat();
  const app = await mount({snapshot:{...snapshot,messages}});
  try {
    assert.ok(document.querySelectorAll('.canvas-agent-turn-marks button').length <= 72);
    assert.equal(document.querySelectorAll('[data-agent-query]').length,120,'sampling never drops transcript messages');
    await key('Home',{},query('.canvas-agent-turn-marks button'));
    await React.act(async () => new Promise(resolve => window.setTimeout(resolve,25)));
    let mark = query('.canvas-agent-turn-marks [data-turn-index="0"]');
    await key('ArrowDown',{},mark);
    await React.act(async () => new Promise(resolve => window.setTimeout(resolve,25)));
    mark = query('.canvas-agent-turn-marks [data-turn-index="1"]');
    assert.ok(mark); assert.equal(document.activeElement,mark);
    await key('End',{},mark);
    await React.act(async () => new Promise(resolve => window.setTimeout(resolve,25)));
    assert.equal(document.activeElement.getAttribute('data-turn-index'),'119');
  } finally { await app.unmount(); }
});

test('R8 official tool rows retain prose summaries and full lazy output cards, including failures', async () => {
  const raw = JSON.stringify({summary:'Created two image nodes',nodeIds:['one','two']});
  const app = await mount({snapshot:{...snapshot,tools:[
    {callId:'success',name:'canvas_apply_plan',status:'completed',startedAt:10,endedAt:310,summary:raw},
    {callId:'failure',name:'canvas_generate_plan',status:'failed',startedAt:100,endedAt:400,summary:'Budget exhausted; nothing generated.'},
  ]}});
  try {
    const success=query('.canvas-dsh-tool[data-call-id="success"]'), failure=query('.canvas-dsh-tool[data-call-id="failure"]');
    assert.ok(disclosureHeader(success).textContent.includes('Created two image nodes'));
    assert.ok(!success.textContent.includes('nodeIds'),'raw result is lazily mounted, not repeated in the summary');
    assert.equal(disclosureHeader(success).getAttribute('aria-expanded'),'false');
    await click(disclosureHeader(success));
    assert.ok(success.textContent.includes(`OUT${raw}`),'official output card retains the exact result, including IDs');
    assert.equal(success.querySelector('.canvas-agent-tool-technical'),null,'do not recreate the simplified technical-details card');
    assert.equal(failure.querySelector('[data-state]').getAttribute('data-state'),'error');
    assert.ok(failure.textContent.includes('Failed'));assert.ok(disclosureHeader(failure).textContent.includes('nothing generated'));
    await click(disclosureHeader(failure));
    assert.equal(failure.querySelector('[data-error]').textContent,'Budget exhausted; nothing generated.');
    assert.equal(app.sent.length,0);assert.equal(app.applied.length,0);
    await click(disclosureHeader(success));assert.ok(!success.textContent.includes('nodeIds'),'closing releases the result card');
    assert.equal(disclosureHeader(failure).getAttribute('aria-expanded'),'true','sibling disclosure remains independent');
  } finally { await app.unmount(); }
});

test('R8 reduced-motion scope and inline disclosure styles preserve accessible touch/focus fallbacks', async () => {
  const app = await mount({snapshot,testReducedMotion:true});
  try { assert.ok(query('.canvas-r1-agent-panel.reduce-motion')); }
  finally { await app.unmount(); }
  const css = fs.readFileSync(path.join(__dirname,'canvasAgentPanel.css'),'utf8');
  const r8 = css.slice(css.indexOf('/* R8:'));
  assert.ok(r8.includes('margin-left:0; opacity:0'));
  assert.ok(r8.includes('summary:focus-visible > .canvas-agent-trace-chevron'));
  assert.ok(r8.includes('@media(hover:none),(pointer:coarse)'));
  assert.ok(r8.includes('@media(prefers-reduced-motion:reduce)'));
  assert.ok(r8.includes('.reduce-motion .canvas-agent-turn-process'));
  assert.ok(r8.includes('scrollbar-width:none'));
  assert.ok(r8.includes('.reduce-motion .canvas-agent-stream-caret { animation:none; }'));
});


test('R8 rail preview follows real light/dark semantic surfaces and failure colors survive hover', () => {
  const css = fs.readFileSync(path.join(__dirname,'canvasAgentPanel.css'),'utf8');
  const themes = fs.readFileSync(path.join(__dirname,'../../core/theme/themeTokens.css'),'utf8');
  const light = themes.slice(themes.indexOf(':root[data-theme="light"]'));
  assert.ok(light.includes('--theme-surface-raised: #ffffff'));
  assert.ok(light.includes('--theme-surface-panel: #f0f1f4'));
  assert.ok(css.includes('background:var(--theme-surface-raised,var(--theme-surface-panel,var(--bg-elevated,#25252b)))'));
  assert.ok(!css.includes('--theme-bg-elevated'));
  assert.ok(css.includes('li.is-failed > details > summary:focus-visible:not(:where(.canvas-dsh-tool *, .canvas-dsh-progress *)) { color:var(--danger,var(--rose,#ce9d8a)); }'));
});

test('LSH failed request shows its actual detail as plain text and stays sendable without reconnect',async()=>{
 const detail='LSH: quota exceeded <img src=x onerror="alert(1)">';
 const failed={...snapshot,status:'failed',error:'canvas-agent-unavailable',errorDetail:{message:detail}};
 const app=await mount({snapshot:failed,error:failed.error,availability:'ready',formatError:()=> 'Generic Agent unavailable',onRefresh:()=>{}});
 try{
  assert.equal(query('[role="alert"] span').textContent,detail);
  assert.equal(query('[role="alert"] img'),null);
  assert.equal(button('Reconnect'),undefined);
  assert.ok(!document.body.textContent.includes('Generic Agent unavailable'));
  await edit('Try another model');assert.equal(button('Send request').disabled,false);
  await app.update({snapshot:{...snapshot,status:'failed',error:'canvas-agent-unavailable'},error:'canvas-agent-unavailable'});
  assert.match(query('[role="alert"]').textContent,/No specific error reason was received/);
  await app.update({snapshot:failed,error:'canvas-agent-not-ready',formatError:message=>message});
  assert.match(query('[role="alert"]').textContent,/canvas-agent-not-ready/);
  assert.ok(!query('[role="alert"]').textContent.includes('quota exceeded'));
  assert.ok(button('Reconnect'));
  await app.update({snapshot:{...snapshot,status:'cancelled'},error:''});
  assert.equal(query('[role="alert"]'),null);
 }finally{await app.unmount();}
});

test('R12 stable process across pending, streaming attempts, tools, final completion and manual review', async () => {
  const user={role:'user',text:'Create'};
  const base={...snapshot,conversationId:'stable',status:'running',messages:[user]};
  const app=await mount({snapshot:base});
  try {
    const process=query('.canvas-agent-turn-process'); assert.ok(process);assert.equal(process.open,true);
    const first={attemptId:'a',turnId:'run-1',status:'streaming',text:'',reasoningText:'Thought',reasoning:true};
    const tool={callId:'one',turnId:'run-1',name:'canvas_read_context',status:'running',startedAt:10};
    const done={...tool,status:'completed',endedAt:20};
    for(const patch of [{stream:first},{stream:{...first,status:'settled'},tools:[tool]},{tools:[done]}]){
      await app.update({snapshot:{...base,...patch}});assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true);
    }
    await click(process.querySelector('summary'));assert.equal(process.open,false);
    await app.update({snapshot:{...base,stream:{...first,attemptId:'b'},tools:[done]}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,false);
    await click(process.querySelector('summary'));assert.equal(process.open,true);
    await app.update({snapshot:{...base,stream:{...first,attemptId:'b',text:'Final answer',reasoning:false},tools:[done]}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true);
    const final={role:'assistant',turnId:'run-1',attemptId:'b',text:'Final answer',reasoningText:'Thought'};
    await app.update({snapshot:{...base,messages:[user,final],tools:[done]}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true);
    await app.update({snapshot:{...base,status:'completed',messages:[user,final],tools:[done]}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,false);
    await click(process.querySelector('summary'));assert.equal(process.open,true);
    await app.update({snapshot:{...base,status:'completed',messages:[user,final],tools:[{...done,endedAt:21}]}});
    assert.equal(process.open,true);
    await app.update({snapshot:{...base,runId:'run-2',messages:[user,final,{role:'user',text:'Continue'}],tools:[]}});
    const all=[...document.querySelectorAll('.canvas-agent-turn-process')];assert.equal(all.length,2);assert.equal(all[0],process);assert.equal(all[0].open,true);assert.equal(all[1].open,true);
  }finally{await app.unmount();}
});
test('R12 errors and cancellations preserve disclosure; switching conversations isolates state',async()=>{
  const base={...snapshot,conversationId:'a',status:'running',messages:[{role:'user',text:'Task'}],activity:[{id:'p',kind:'phase',label:'preparing',status:'running',startedAt:1}]};
  const app=await mount({snapshot:base});try{
    const process=query('.canvas-agent-turn-process');
    for(const status of ['failed','cancelled']){await app.update({snapshot:{...base,status}});assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true);}
    await click(process.querySelector('summary'));assert.equal(process.open,false);
    await app.update({snapshot:{...base,conversationId:'b'}});assert.notEqual(query('.canvas-agent-turn-process'),process);assert.equal(query('.canvas-agent-turn-process').open,true);
  }finally{await app.unmount();}
});

test('R12 send preparation hands its disclosure state to the accepted run without a remount',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);
  const app=await mount({snapshot:{...snapshot,conversationId:'send'},onSend:()=>pending});
  try{
    await edit('New task');await click(button('Send request'));
    const process=[...document.querySelectorAll('.canvas-agent-turn-process')].at(-1);
    assert.ok(process);assert.equal(process.open,true);assert.match(process.textContent,/Preparing/);
    await click(process.querySelector('summary'));assert.equal(process.open,false);
    await app.update({snapshot:{...snapshot,conversationId:'send',runId:'accepted',status:'running',messages:[...snapshot.messages,{role:'user',text:'New task',turnId:'accepted'}]}});
    await React.act(async()=>resolve(true));
    assert.equal([...document.querySelectorAll('.canvas-agent-turn-process')].at(-1),process);assert.equal(process.open,false);
  }finally{await app.unmount();}
});
test('R12 durable run key survives history trimming and loss of the user anchor',async()=>{
  const user={role:'user',text:'New task',turnId:'new'};
  const response={role:'assistant',text:'Working',turnId:'new',attemptId:'first'};
  const base={...snapshot,conversationId:'trim',runId:'new',status:'running',messages:[...snapshot.messages,user,response]};
  const app=await mount({snapshot:base});try{
    const process=[...document.querySelectorAll('.canvas-agent-turn-process')].at(-1);
    await click(process.querySelector('summary'));assert.equal(process.open,false);
    for(const messages of [[user,response],[response,{role:'assistant',text:'Next',turnId:'new',attemptId:'next'}]]){
      await app.update({snapshot:{...base,messages}});assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,false);
    }
  }finally{await app.unmount();}
});

test('R12 first conversation and trimmed accepted history both retain pending disclosure identity',async()=>{
  for(const initial of [null,{...snapshot,conversationId:'trim-send'}]){
    let resolve;const pending=new Promise(r=>resolve=r);
    const app=await mount({snapshot:initial,draftKey:'canvas-first',onSend:()=>pending});
    try{
      await edit('New task');await click(button('Send request'));
      const process=[...document.querySelectorAll('.canvas-agent-turn-process')].at(-1);
      await click(process.querySelector('summary'));
      if (!initial) { await app.update({snapshot:{...snapshot,conversationId:'created',runId:null,status:'idle',messages:[]}}); assert.equal([...document.querySelectorAll('.canvas-agent-turn-process')].at(-1),process); assert.equal(process.open,false); }
      await app.update({snapshot:{...snapshot,conversationId:initial?.conversationId || 'created',runId:'accepted',status:'running',messages:[{role:'user',text:'New task',turnId:'accepted'}]}});
      assert.equal([...document.querySelectorAll('.canvas-agent-turn-process')].at(-1),process);
      assert.equal(process.open,false);
      assert.equal([...document.querySelectorAll('[data-agent-query]')].filter(e=>e.textContent.includes('New task')).length,1);
      await React.act(async()=>resolve(true));
      assert.equal([...document.querySelectorAll('.canvas-agent-turn-process')].at(-1),process);
    }finally{await app.unmount();}
  }
});

test('R14 active reasoning starts collapsed, then follows only when explicitly opened and resumes on request', async () => {
 const stream={attemptId:'live',turnId:'run-1',status:'streaming',text:'',reasoning:true,reasoningText:'First public paragraph'};
 const base={...snapshot,status:'running',messages:[snapshot.messages[0]],stream};
 const app=await mount({snapshot:base});
 try {
  const row=query('.canvas-agent-model-reasoning'),header=disclosureHeader(row);
  assert.equal(query('.canvas-agent-turn-process').open,true,'R12 outer process still starts open');
  assert.equal(header.getAttribute('aria-expanded'),'false');assert.equal(reasoningScroll(row),null);
  await key('Enter',{},header);assert.equal(header.getAttribute('aria-expanded'),'true');
  const scroll=reasoningScroll(row);
  Object.defineProperties(scroll,{scrollHeight:{configurable:true,value:600},clientHeight:{configurable:true,value:120}});
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:'First public paragraph\n\nNew live paragraph'}}});
  assert.equal(scroll.scrollTop,600);
  scroll.scrollTop=100;
  await React.act(async()=>scroll.dispatchEvent(new Event('scroll',{bubbles:true})));
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:'First public paragraph\n\nNew live paragraph continues'}}});
  assert.equal(scroll.scrollTop,100,'new tokens never steal manual reading position');
  assert.ok(query('.canvas-agent-reasoning-follow'));await click(query('.canvas-agent-reasoning-follow'));
  assert.equal(scroll.scrollTop,600);assert.equal(query('.canvas-agent-reasoning-follow'),null);
  await key(' ',{},header);assert.equal(header.getAttribute('aria-expanded'),'false');
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:'More public text'}}});
  assert.equal(header.getAttribute('aria-expanded'),'false','manual collapse survives new tokens');
  assert.equal(reasoningScroll(row),null,'official collapsed body is unmounted');
 } finally {await app.unmount();}
});

test('R14 explicitly opened reasoning retains disclosure and reading position through durable commit', async()=>{
 const stream={attemptId:'live',turnId:'run-1',status:'streaming',text:'',reasoning:true,reasoningText:'Published thought'};
 const app=await mount({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0]],stream}});
 try{
  const row=query('.canvas-agent-model-reasoning');await click(disclosureHeader(row));
  const scroll=reasoningScroll(row);
  Object.defineProperties(scroll,{scrollHeight:{configurable:true,value:600},clientHeight:{configurable:true,value:120}});
  scroll.scrollTop=100;await React.act(async()=>scroll.dispatchEvent(new Event('scroll',{bubbles:true})));
  await app.update({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0],{role:'assistant',attemptId:'live',turnId:'run-1',text:'',reasoningText:'Published thought',reasoningDurationMs:3000}],stream:{...stream,status:'settled',reasoning:false}}});
  assert.equal(query('.canvas-agent-model-reasoning'),row);assert.equal(disclosureHeader(row).getAttribute('aria-expanded'),'true');
  assert.equal(reasoningScroll(row),scroll);assert.equal(scroll.scrollTop,100,'commit does not steal paused scroll');
  assert.ok(row.querySelector('.canvas-agent-reasoning-follow'));
  assert.equal(row.querySelector('.canvas-agent-reasoning-caption').textContent,'Thought 3s');
 }finally{await app.unmount();}
});

test('R14 absence of published reasoning never invents thought content or thought duration',async()=>{
 const app=await mount({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0]],tools:[{callId:'t',name:'canvas_read_context',status:'running',startedAt:Date.now()-4000}]}});
 try{
  assert.equal(query('.canvas-agent-model-reasoning'),null);assert.doesNotMatch(query('.canvas-agent-turn').textContent,/Thought|Thinking/);
  const tool=query('.canvas-dsh-tool[data-call-id="t"]');
  assert.equal(tool.querySelector('[data-state]').getAttribute('data-state'),'running');
  assert.match(disclosureHeader(tool).textContent,/Running.*4s/);
  assert.equal(disclosureHeader(tool).hasAttribute('aria-expanded'),false,'no output means no invented expandable result card');
 }finally{await app.unmount();}
});

test('R14 live summary advances only after a complete first line, while full Markdown preserves paragraphs',async()=>{
 const text='**Inspect the reference**\nDetailed first line\n\n**Compose the scene**\nDetailed next line';
 const stream={attemptId:'live',turnId:'run-1',status:'streaming',text:'',reasoning:true,reasoningText:text};
 const base={...snapshot,status:'running',messages:[snapshot.messages[0]],stream};
 const app=await mount({snapshot:base});
 try{
  const row=query('.canvas-agent-model-reasoning');
  assert.equal(disclosureHeader(row).getAttribute('aria-expanded'),'false');
  assert.equal(row.querySelector('.canvas-agent-reasoning-preview').textContent,'Compose the scene');
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:text+'\n\nUnfinished heading'}}});
  assert.equal(row.querySelector('.canvas-agent-reasoning-preview').textContent,'Compose the scene','partial heading does not replace the last completed summary');
  await click(disclosureHeader(row));
  assert.deepEqual([...reasoningScroll(row).querySelectorAll('strong')].map(node=>node.textContent),['Inspect the reference','Compose the scene']);
  assert.deepEqual([...reasoningScroll(row).querySelectorAll('p')].map(node=>node.textContent),['Inspect the reference\nDetailed first line','Compose the scene\nDetailed next line','Unfinished heading']);
 }finally{await app.unmount();}
});

test('R14 reopening the outer process follows already-received text in an explicitly opened reasoning row',async()=>{
 const stream={attemptId:'live',turnId:'run-1',status:'streaming',text:'',reasoning:true,reasoningText:'Public thought'};
 const base={...snapshot,status:'running',messages:[snapshot.messages[0]],stream};
 const app=await mount({snapshot:base});
 try{
  const outer=query('.canvas-agent-turn-process'),row=query('.canvas-agent-model-reasoning');await click(disclosureHeader(row));
  const scroll=reasoningScroll(row);
  Object.defineProperties(scroll,{scrollHeight:{configurable:true,value:600},clientHeight:{configurable:true,value:120}});
  await click(outer.querySelector(':scope > summary'));
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:'Public thought updated'}}});
  assert.equal(scroll.scrollTop,0,'hidden parent does not perform a meaningless scroll');
  await click(outer.querySelector(':scope > summary'));
  assert.equal(scroll.scrollTop,600,'reveal restores tail without waiting for a token');
  assert.equal(disclosureHeader(row).getAttribute('aria-expanded'),'true');
 }finally{await app.unmount();}
});

test('R14 separate runs may reuse an attempt ID without suppressing the new stream or duplicating its commit',async()=>{
 const older={role:'assistant',turnId:'older-run',attemptId:'shared-attempt',text:'Old durable answer',reasoningText:'Old published reasoning'};
 const user={role:'user',turnId:'newer-run',text:'New request'};
 const stream={turnId:'newer-run',attemptId:'shared-attempt',status:'streaming',text:'New streaming answer',reasoningText:'New published reasoning\n',reasoning:true};
 const base={...snapshot,runId:'newer-run',status:'running',messages:[{role:'user',turnId:'older-run',text:'Old request'},older,user],stream};
 const app=await mount({snapshot:base});
 try{
  const turns=[...document.querySelectorAll('.canvas-agent-turn')];assert.equal(turns.length,2);
  assert.ok(turns[0].textContent.includes('Old durable answer'));assert.ok(!turns[0].textContent.includes('New streaming answer'));
  assert.ok(turns[1].textContent.includes('New streaming answer'),'deduplication must match both turnId and attemptId');
  const row=turns[1].querySelector('.canvas-agent-model-reasoning');assert.ok(row);await click(disclosureHeader(row));
  assert.equal(reasoningScroll(row).textContent,'New published reasoning');
  assert.equal(turns[0].querySelector('.canvas-agent-model-reasoning').hasAttribute('data-expanded'),false,'new run does not open old reasoning');
  await app.update({snapshot:{...base,messages:[...base.messages,{role:'assistant',turnId:'newer-run',attemptId:'shared-attempt',text:'New streaming answer',reasoningText:'New published reasoning\n'}]}});
  assert.equal(turns[1].querySelectorAll('.canvas-agent-model-reasoning').length,1,'matching durable commit suppresses only its own stream copy');
  assert.equal(turns[1].querySelectorAll('.canvas-r1-agent-message.is-assistant').length,1);
  assert.equal(turns[1].querySelector('.canvas-agent-model-reasoning'),row);
  assert.equal(disclosureHeader(row).getAttribute('aria-expanded'),'true');
  assert.equal(app.sent.length,0);assert.equal(app.applied.length,0);
 }finally{await app.unmount();}
});

test('LSH failed request shows its actual detail as plain text and stays sendable without reconnect',async()=>{
 const detail='LSH: quota exceeded <img src=x onerror="alert(1)">';
 const failed={...snapshot,status:'failed',error:'canvas-agent-unavailable',errorDetail:{message:detail}};
 const app=await mount({snapshot:failed,error:failed.error,availability:'ready',formatError:()=> 'Generic Agent unavailable',onRefresh:()=>{}});
 try{
  assert.equal(query('[role="alert"] span').textContent,detail);
  assert.equal(query('[role="alert"] img'),null);
  assert.equal(button('Reconnect'),undefined);
  assert.ok(!document.body.textContent.includes('Generic Agent unavailable'));
  await edit('Try another model');assert.equal(button('Send request').disabled,false);
  await app.update({snapshot:{...snapshot,status:'failed',error:'canvas-agent-unavailable'},error:'canvas-agent-unavailable'});
  assert.match(query('[role="alert"]').textContent,/No specific error reason was received/);
  await app.update({snapshot:failed,error:'canvas-agent-not-ready',formatError:message=>message});
  assert.match(query('[role="alert"]').textContent,/canvas-agent-not-ready/);
  assert.ok(!query('[role="alert"]').textContent.includes('quota exceeded'));
  assert.ok(button('Reconnect'));
  await app.update({snapshot:{...snapshot,status:'cancelled'},error:''});
  assert.equal(query('[role="alert"]'),null);
 }finally{await app.unmount();}
});

test('R12 stable process across pending, streaming attempts, tools, final completion and manual review', async () => {
  const user={role:'user',text:'Create'};
  const base={...snapshot,conversationId:'stable',status:'running',messages:[user]};
  const app=await mount({snapshot:base});
  try {
    const process=query('.canvas-agent-turn-process'); assert.ok(process);assert.equal(process.open,true);
    const first={attemptId:'a',turnId:'run-1',status:'streaming',text:'',reasoningText:'Thought',reasoning:true};
    const tool={callId:'one',turnId:'run-1',name:'canvas_read_context',status:'running',startedAt:10};
    const done={...tool,status:'completed',endedAt:20};
    for(const patch of [{stream:first},{stream:{...first,status:'settled'},tools:[tool]},{tools:[done]}]){
      await app.update({snapshot:{...base,...patch}});assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true);
    }
    await click(process.querySelector('summary'));assert.equal(process.open,false);
    await app.update({snapshot:{...base,stream:{...first,attemptId:'b'},tools:[done]}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,false);
    await click(process.querySelector('summary'));assert.equal(process.open,true);
    await app.update({snapshot:{...base,stream:{...first,attemptId:'b',text:'Final answer',reasoning:false},tools:[done]}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true);
    const final={role:'assistant',turnId:'run-1',attemptId:'b',text:'Final answer',reasoningText:'Thought'};
    await app.update({snapshot:{...base,messages:[user,final],tools:[done]}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true);
    await app.update({snapshot:{...base,status:'completed',messages:[user,final],tools:[done]}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,false);
    await click(process.querySelector('summary'));assert.equal(process.open,true);
    await app.update({snapshot:{...base,status:'completed',messages:[user,final],tools:[{...done,endedAt:21}]}});
    assert.equal(process.open,true);
    await app.update({snapshot:{...base,runId:'run-2',messages:[user,final,{role:'user',text:'Continue'}],tools:[]}});
    const all=[...document.querySelectorAll('.canvas-agent-turn-process')];assert.equal(all.length,2);assert.equal(all[0],process);assert.equal(all[0].open,true);assert.equal(all[1].open,true);
  }finally{await app.unmount();}
});
test('R12 errors and cancellations preserve disclosure; switching conversations isolates state',async()=>{
  const base={...snapshot,conversationId:'a',status:'running',messages:[{role:'user',text:'Task'}],activity:[{id:'p',kind:'phase',label:'preparing',status:'running',startedAt:1}]};
  const app=await mount({snapshot:base});try{
    const process=query('.canvas-agent-turn-process');
    for(const status of ['failed','cancelled']){await app.update({snapshot:{...base,status}});assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true);}
    await click(process.querySelector('summary'));assert.equal(process.open,false);
    await app.update({snapshot:{...base,conversationId:'b'}});assert.notEqual(query('.canvas-agent-turn-process'),process);assert.equal(query('.canvas-agent-turn-process').open,true);
  }finally{await app.unmount();}
});

test('R12 send preparation hands its disclosure state to the accepted run without a remount',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);
  const app=await mount({snapshot:{...snapshot,conversationId:'send'},onSend:()=>pending});
  try{
    await edit('New task');await click(button('Send request'));
    const process=[...document.querySelectorAll('.canvas-agent-turn-process')].at(-1);
    assert.ok(process);assert.equal(process.open,true);assert.match(process.textContent,/Preparing/);
    await click(process.querySelector('summary'));assert.equal(process.open,false);
    await app.update({snapshot:{...snapshot,conversationId:'send',runId:'accepted',status:'running',messages:[...snapshot.messages,{role:'user',text:'New task',turnId:'accepted'}]}});
    await React.act(async()=>resolve(true));
    assert.equal([...document.querySelectorAll('.canvas-agent-turn-process')].at(-1),process);assert.equal(process.open,false);
  }finally{await app.unmount();}
});
test('R12 durable run key survives history trimming and loss of the user anchor',async()=>{
  const user={role:'user',text:'New task',turnId:'new'};
  const response={role:'assistant',text:'Working',turnId:'new',attemptId:'first'};
  const base={...snapshot,conversationId:'trim',runId:'new',status:'running',messages:[...snapshot.messages,user,response]};
  const app=await mount({snapshot:base});try{
    const process=[...document.querySelectorAll('.canvas-agent-turn-process')].at(-1);
    await click(process.querySelector('summary'));assert.equal(process.open,false);
    for(const messages of [[user,response],[response,{role:'assistant',text:'Next',turnId:'new',attemptId:'next'}]]){
      await app.update({snapshot:{...base,messages}});assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,false);
    }
  }finally{await app.unmount();}
});

test('R12 first conversation and trimmed accepted history both retain pending disclosure identity',async()=>{
  for(const initial of [null,{...snapshot,conversationId:'trim-send'}]){
    let resolve;const pending=new Promise(r=>resolve=r);
    const app=await mount({snapshot:initial,draftKey:'canvas-first',onSend:()=>pending});
    try{
      await edit('New task');await click(button('Send request'));
      const process=[...document.querySelectorAll('.canvas-agent-turn-process')].at(-1);
      await click(process.querySelector('summary'));
      if (!initial) { await app.update({snapshot:{...snapshot,conversationId:'created',runId:null,status:'idle',messages:[]}}); assert.equal([...document.querySelectorAll('.canvas-agent-turn-process')].at(-1),process); assert.equal(process.open,false); }
      await app.update({snapshot:{...snapshot,conversationId:initial?.conversationId || 'created',runId:'accepted',status:'running',messages:[{role:'user',text:'New task',turnId:'accepted'}]}});
      assert.equal([...document.querySelectorAll('.canvas-agent-turn-process')].at(-1),process);
      assert.equal(process.open,false);
      assert.equal([...document.querySelectorAll('[data-agent-query]')].filter(e=>e.textContent.includes('New task')).length,1);
      await React.act(async()=>resolve(true));
      assert.equal([...document.querySelectorAll('.canvas-agent-turn-process')].at(-1),process);
    }finally{await app.unmount();}
  }
});

test('R12 completed status waits for the last streamed message and only collapses once', async()=>{
  const user={role:'user',text:'Stream boundary',turnId:'stream-run'};
  const stream={attemptId:'last',turnId:'stream-run',status:'streaming',text:'Final response',reasoning:false};
  const tool={callId:'read',turnId:'stream-run',name:'canvas_read_context',status:'completed',startedAt:10,endedAt:20};
  const base={...snapshot,conversationId:'stream-boundary',runId:'stream-run',status:'running',messages:[user],tools:[tool],stream};
  const app=await mount({snapshot:base});try{
    const process=query('.canvas-agent-turn-process');assert.equal(process.open,true);
    await app.update({snapshot:{...base,status:'completed'}});
    assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,true,'completed status alone must not hide a live final stream');
    await app.update({snapshot:{...base,status:'completed',stream:{...stream,text:'More final response'}}});
    assert.equal(process.open,true);
    const done={...base,status:'completed',stream:{...stream,status:'settled'},messages:[user,{role:'assistant',turnId:'stream-run',attemptId:'last',text:'Final response'}]};
    await app.update({snapshot:done});assert.equal(process.open,false);
    await click(process.querySelector('summary'));assert.equal(process.open,true);
    await app.update({snapshot:{...done,updatedAt:1001}});assert.equal(process.open,true,'a completed snapshot refresh must not close historical review again');
  }finally{await app.unmount();}
});

test('R12 manually collapsed process remains collapsed after failure or cancellation',async()=>{
  for(const terminal of ['failed','cancelled']){
    const base={...snapshot,conversationId:`manual-${terminal}`,runId:'manual-run',status:'running',messages:[{role:'user',turnId:'manual-run',text:'Scoped synthetic task'}],tools:[{callId:'read',turnId:'manual-run',name:'canvas_read_context',status:'running',startedAt:1}]};
    const app=await mount({snapshot:base});try{
      const process=query('.canvas-agent-turn-process');await click(process.querySelector('summary'));assert.equal(process.open,false);
      await app.update({snapshot:{...base,status:terminal,tools:[{...base.tools[0],status:'failed',endedAt:2}]}});
      assert.equal(query('.canvas-agent-turn-process'),process);assert.equal(process.open,false);
      await click(process.querySelector('summary'));assert.equal(process.open,true);
      await app.update({snapshot:{...base,status:terminal,updatedAt:3}});assert.equal(process.open,true);
    }finally{await app.unmount();}
  }
});

test('R13 reading/follow guarantees survive R14 independently collapsed official disclosure', async () => {
 const stream={attemptId:'live',turnId:'run-1',status:'streaming',text:'',reasoning:true,reasoningText:'First public paragraph'};
 const base={...snapshot,status:'running',messages:[snapshot.messages[0]],stream};
 const app=await mount({snapshot:base});
 try {
  const row=query('.canvas-agent-model-reasoning');
  assert.equal(disclosureHeader(row).getAttribute('aria-expanded'),'false');
  assert.equal(reasoningScroll(row),null);
  await click(disclosureHeader(row));
  const p=reasoningScroll(row);
  assert.equal(disclosureHeader(row).getAttribute('aria-expanded'),'true');
  Object.defineProperties(p,{scrollHeight:{configurable:true,value:600},clientHeight:{configurable:true,value:120}});
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:'First public paragraph\n\nNew live paragraph'}}});
  assert.equal(p.scrollTop,600);
  p.scrollTop=100;
  await React.act(async()=>p.dispatchEvent(new Event('scroll',{bubbles:true})));
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:'First public paragraph\n\nNew live paragraph continues'}}});
  assert.equal(p.scrollTop,100,'new tokens never steal manual reading position');
  assert.ok(query('.canvas-agent-reasoning-follow'));
  await click(query('.canvas-agent-reasoning-follow'));
  assert.equal(p.scrollTop,600);
  assert.equal(query('.canvas-agent-reasoning-follow'),null);
  await click(disclosureHeader(row));
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:'More public text'}}});
  assert.equal(disclosureHeader(row).getAttribute('aria-expanded'),'false','manual collapse survives new tokens');
 } finally {await app.unmount();}
});

test('R13 durable reasoning retains disclosure and reading position through commit', async()=>{
 const stream={attemptId:'live',turnId:'run-1',status:'streaming',text:'',reasoning:true,reasoningText:'Published thought'};
 const app=await mount({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0]],stream}});
 try{
  const row=query('.canvas-agent-model-reasoning');
  await click(disclosureHeader(row));
  const p=reasoningScroll(row);
  Object.defineProperties(p,{scrollHeight:{configurable:true,value:600},clientHeight:{configurable:true,value:120}});
  p.scrollTop=100;
  await React.act(async()=>p.dispatchEvent(new Event('scroll',{bubbles:true})));
  await app.update({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0],{role:'assistant',attemptId:'live',turnId:'run-1',text:'',reasoningText:'Published thought',reasoningDurationMs:3000}],stream:{...stream,status:'settled',reasoning:false}}});
  assert.equal(query('.canvas-agent-model-reasoning'),row);
  assert.equal(disclosureHeader(row).getAttribute('aria-expanded'),'true');
  assert.equal(reasoningScroll(row).scrollTop,100,'commit does not steal paused scroll');
  assert.ok(row.querySelector('.canvas-agent-reasoning-follow'));
  assert.equal(row.querySelector('.canvas-agent-reasoning-caption').textContent,'Thought 3s');
 }finally{await app.unmount();}
});

test('R13 absence of published reasoning never invents thought content or thought duration',async()=>{
 const app=await mount({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0]],tools:[{callId:'t',name:'canvas_read_context',status:'running',startedAt:Date.now()-4000}]}});
 try{
  assert.equal(query('.canvas-agent-model-reasoning'),null);
  assert.doesNotMatch(query('.canvas-agent-turn').textContent,/Thought|Thinking/);
  assert.match(disclosureHeader(query('.canvas-dsh-tool')).textContent,/4s/);
  assert.ok(query('.canvas-dsh-tool [data-shimmer]'),'real running tool uses official running shimmer');
 }finally{await app.unmount();}
});

test('R13 live summary moves to an actual new paragraph without clipping from arbitrary character tail',async()=>{
 const text='**Inspect the reference**\nDetailed first line\n\n**Compose the scene**\nDetailed next line';
 const app=await mount({snapshot:{...snapshot,status:'running',messages:[snapshot.messages[0]],stream:{attemptId:'live',turnId:'run-1',status:'streaming',text:'',reasoning:true,reasoningText:text}}});
 try{
  const row=query('.canvas-agent-model-reasoning');
  assert.equal(row.querySelector('.canvas-agent-reasoning-preview').textContent,'Compose the scene');
  await click(disclosureHeader(row));
  assert.match(reasoningScroll(row).textContent,/Inspect the reference.*Detailed first line.*Compose the scene.*Detailed next line/s,'full thought is rendered by official Markdown rather than truncated to the preview');
 }finally{await app.unmount();}
});


test('R13 reopening the outer process follows already-received live text without another delta',async()=>{
 const stream={attemptId:'live',turnId:'run-1',status:'streaming',text:'',reasoning:true,reasoningText:'Public thought'};
 const base={...snapshot,status:'running',messages:[snapshot.messages[0]],stream};
 const app=await mount({snapshot:base});
 try{
  const outer=query('.canvas-agent-turn-process');
  await click(disclosureHeader(query('.canvas-agent-model-reasoning')));
  const p=query('.canvas-dsh-reasoning-scroll');
  Object.defineProperties(p,{scrollHeight:{configurable:true,value:600},clientHeight:{configurable:true,value:120}});
  await click(outer.querySelector(':scope > summary'));
  await app.update({snapshot:{...base,stream:{...stream,reasoningText:'Public thought updated'}}});
  assert.equal(p.scrollTop,0,'hidden parent does not perform a meaningless scroll');
  await click(outer.querySelector(':scope > summary'));
  assert.equal(p.scrollTop,600,'reveal restores tail without waiting for a token');
 }finally{await app.unmount();}
});
