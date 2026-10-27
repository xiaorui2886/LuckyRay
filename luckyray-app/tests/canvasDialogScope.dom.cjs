const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const tools = createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json'));
const { JSDOM } = tools('jsdom');
const dom = new JSDOM('<button id="origin">Origin</button><div id="root"></div>', { pretendToBeVisual: true });
for (const key of ['window','document','HTMLElement','HTMLDetailsElement','Node','Event','MouseEvent','KeyboardEvent','navigator']) Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react'), { createRoot } = require('react-dom/client');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.resolve(__dirname, '../node_modules/vite'))] }));
const entry = `export {CanvasDialogPortal,CanvasDialogScopeProvider} from './src/features/canvas/CanvasDialogScope';export {CanvasCreativeDialog} from './src/features/canvas/CanvasCreativeDialog';`;
const built = esbuild.buildSync({ stdin: { contents: entry, resolveDir: path.resolve(__dirname, '..'), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' } });
const mod = { exports: {} }; new Function('module','exports','require',built.outputFiles[0].text)(mod,mod.exports,require);
const { CanvasDialogScopeProvider: Provider, CanvasCreativeDialog: Dialog } = mod.exports;
const observers = [];
global.ResizeObserver = class { constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); } observe(element) { this.element = element; } disconnect() { this.disconnected = true; } };

test('body portal follows canvas bounds, resize and shell offsets; hidden canvas retains draft; listeners clean up', async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  let rect = { left: 240, top: 70, right: 1000, bottom: 740 };
  host.getBoundingClientRect = () => rect;
  const hostRef = { current: host }, root = createRoot(document.querySelector('#root'));
  let closed = 0, mounts = 0;
  function Draft() { React.useEffect(() => { mounts++; }, []); return React.createElement('input', { defaultValue: 'unsaved draft' }); }
  const render = active => root.render(React.createElement(Provider, { host: hostRef, active }, React.createElement(Dialog, { title: 'Scope', onClose() { closed++; } }, React.createElement(Draft))));
  const origin = document.querySelector('#origin'); origin.focus();
  await React.act(() => render(true));
  try {
    const scope = document.querySelector('.canvas-dialog-scope');
    assert.equal(scope.parentElement, document.body, 'no canvas transform/stacking ancestor');
    assert.equal(scope.dataset.dialogScope, 'canvas');
    assert.deepEqual([scope.style.left,scope.style.top,scope.style.width,scope.style.height], ['240px','70px','760px','670px']);
    const input = scope.querySelector('input'); input.value = 'keep this draft';
    rect = { left: 80, top: 70, right: 1000, bottom: 700 };
    await React.act(() => observers.at(-1).callback());
    assert.equal(scope.style.left, '80px'); assert.equal(scope.style.width, '920px');
    assert.equal(input.value, 'keep this draft'); assert.equal(mounts, 1);
    rect = { left: -50, top: -20, right: 1400, bottom: 1200 };
    await React.act(() => window.dispatchEvent(new Event('resize')));
    assert.deepEqual([scope.style.left,scope.style.top,scope.style.width,scope.style.height], ['0px','0px',`${window.innerWidth}px`,`${window.innerHeight}px`]);
    await React.act(() => render(false)); assert.equal(scope.style.display, 'none');
    await React.act(() => render(true)); assert.notEqual(scope.style.display, 'none');
    assert.equal(input.value, 'keep this draft'); assert.equal(mounts, 1);
    await React.act(() => scope.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })));
    assert.equal(closed, 0);
    await React.act(() => scope.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(closed, 1);
  } finally { await React.act(() => root.unmount()); host.remove(); }
  assert.equal(document.querySelector('.canvas-dialog-scope'), null);
  assert.ok(observers.every(observer => observer.disconnected));
  assert.equal(document.activeElement, origin);
});
