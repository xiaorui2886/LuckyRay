const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const { JSDOM } = requireTool('jsdom');
const dom = new JSDOM('<div id="canvas"><button id="other">Another control</button><div id="root"></div></div>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator']) {
  Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.resolve(__dirname, '../../../node_modules/vite'))] }));
const built = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'CanvasCreativeRail.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' });
const loaded = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(loaded, loaded.exports, require);
const { CanvasCreativeRail } = loaded.exports;
const pointer = async target => React.act(() => target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
const click = async target => React.act(() => target.click());
async function mount(alwaysVisible = false) {
  const root = createRoot(document.getElementById('root')), actions = [];
  await React.act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(CanvasCreativeRail, { alwaysVisible, english: true, onAction: action => actions.push(action) }))));
  return { actions, handle: document.querySelector('.canvas-creative-rail-handle'), async unmount() { await React.act(() => root.unmount()); } };
}

test('pinned creation rail closes on blank canvas even when canvas stops event bubbling', async () => {
  const canvas = document.getElementById('canvas'), stop = event => event.stopPropagation();
  const app = await mount(); canvas.addEventListener('pointerdown', stop);
  try {
    await click(app.handle); assert.equal(app.handle.getAttribute('aria-expanded'), 'true');
    await pointer(canvas); assert.equal(app.handle.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(app.actions, []);
  } finally { canvas.removeEventListener('pointerdown', stop); await app.unmount(); }
});

test('another control dismisses the rail; internal action is not swallowed or invoked twice', async () => {
  const app = await mount();
  try {
    await click(app.handle); await pointer(document.getElementById('other'));
    assert.equal(app.handle.getAttribute('aria-expanded'), 'false');
    await click(app.handle);
    const action = document.querySelector('nav button'); await pointer(action);
    assert.equal(app.handle.getAttribute('aria-expanded'), 'true');
    await click(action); assert.deepEqual(app.actions, ['packs']);
    assert.equal(app.handle.getAttribute('aria-expanded'), 'false');
  } finally { await app.unmount(); }
});

test('outside dismissal preserves explicit always-visible preference', async () => {
  const app = await mount(true);
  try { await pointer(document.getElementById('canvas')); assert.equal(app.handle.getAttribute('aria-expanded'), 'true'); }
  finally { await app.unmount(); }
});


test('keyboard opens, moves between five tools and Escape restores the handle without reopening', async () => {
  const app = await mount();
  try {
    const press = async (target, key) => React.act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    await press(app.handle, 'ArrowDown');
    const actions = [...document.querySelectorAll('nav button')];
    assert.equal(actions.length, 5); assert.equal(document.activeElement, actions[0]);
    await press(actions[0], 'End'); assert.equal(document.activeElement, actions[4]);
    await press(actions[4], 'ArrowDown'); assert.equal(document.activeElement, actions[0]);
    await press(actions[0], 'Escape'); assert.equal(document.activeElement, app.handle); assert.equal(app.handle.getAttribute('aria-expanded'), 'false');
    for (let i = 0; i < 10; i++) { await click(app.handle); await pointer(document.getElementById('other')); }
    assert.equal(app.handle.getAttribute('aria-expanded'), 'false'); assert.deepEqual(app.actions, []);
  } finally { await app.unmount(); }
});
