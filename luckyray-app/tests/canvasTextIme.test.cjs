const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), { createRequire } = require('node:module');
const app = path.resolve(__dirname, '..'), req = createRequire(path.join(app, 'package.json'));
const tools = process.env.LR_TEST_TOOLS ? createRequire(path.resolve(process.env.LR_TEST_TOOLS, 'package.json')) : req;
const { JSDOM } = tools('jsdom');
const dom = new JSDOM('<div id="root"></div><div id="flow"><div class="react-flow__renderer"></div></div>', { pretendToBeVisual: true, url: 'https://synthetic.invalid' });
for (const key of ['window', 'Window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator', 'MutationObserver', 'DOMRect', 'Range', 'Text']) {
  Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
const React = req('react'), { createRoot } = req('react-dom/client'), { EditorView } = req('@codemirror/view');
const { ReactFlowProvider, useStoreApi } = req('@xyflow/react');
global.ResizeObserver = class { observe() {} disconnect() {} };
function FlowHarness({ children }) {
  const store = useStoreApi();
  React.useLayoutEffect(() => { store.setState({ width: 1200, height: 800, transform: [0, 0, 1], domNode: document.getElementById('flow'),
    nodeLookup: new Map([['synthetic-ime', { id: 'synthetic-ime', position: { x: 300, y: 300 }, data: {}, measured: { width: 400, height: 200 }, selected: true, internals: { positionAbsolute: { x: 300, y: 300 }, z: 1 } }]]) }); }, [store]);
  return children;
}
const esbuild = req(req.resolve('esbuild', { paths: [fs.realpathSync(path.join(app, 'node_modules/vite'))] }));
const bundle = esbuild.buildSync({ entryPoints: [path.join(app, 'src/features/canvas/CanvasTextDocument.tsx')], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', loader: { '.css': 'empty' } });
const loaded = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(loaded, loaded.exports, req);
const { CanvasTextDocument } = loaded.exports;

test('uncommitted IME composition blocks text commands before its first document change, then permits formatting and undo', async () => {
  let value = '原正文', editing = true, finishes = 0;
  const root = createRoot(document.getElementById('root'));
  const render = () => root.render(React.createElement(ReactFlowProvider, null, React.createElement(FlowHarness, null, React.createElement(CanvasTextDocument, {
    nodeId: 'synthetic-ime', value, selected: true, editing, english: true,
    onChange: next => { value = next; render(); },
    onStartEditing: () => { editing = true; render(); },
    onFinishEditing: () => { finishes++; editing = false; render(); },
  }))));
  const button = label => document.querySelector(`button[aria-label="${label}"]`);
  await React.act(render);
  await React.act(() => button('Focus editor').click());
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
  await React.act(() => view.dispatch({ selection: { anchor: value.length } }));
  // EditContext starts composition before the first text mutation. `composing`
  // stays false at this boundary; the public `compositionStarted` is true.
  assert.equal(view.composing, false);
  await React.act(() => view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
  assert.equal(view.composing, false);
  assert.equal(view.compositionStarted, true);
  await React.act(() => button('Bold').click());
  assert.equal(value, '原正文', 'formatting must not insert empty markers into an active native composition');
  await React.act(() => button('Close focused editor').click());
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(finishes, 0);
  await React.act(() => view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
  await React.act(() => view.dispatch({ selection: { anchor: 0, head: 1 } }));
  const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await React.act(() => button('Bold').dispatchEvent(mouseDown));
  assert.equal(mouseDown.defaultPrevented, false, 'toolbar must allow native focus/IME handoff');
  await React.act(() => button('Bold').focus());
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), '原');
  await React.act(() => button('Bold').click());
  assert.equal(value, '**原**正文');
  await React.act(() => button('Undo').click());
  assert.equal(value, '原正文');
  await React.act(() => button('Close focused editor').click());
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(finishes, 1);
  await React.act(() => root.unmount());
});

test('expanded text Escape returns to canvas even after focus falls back to body, without losing text', async () => {
  let value = '合成 Esc 检查', editing = true, finishes = 0;
  const root = createRoot(document.getElementById('root'));
  const render = () => root.render(React.createElement(ReactFlowProvider, null, React.createElement(FlowHarness, null, React.createElement(CanvasTextDocument, {
    nodeId: 'synthetic-ime', value, selected: true, editing, english: true,
    onChange: next => { value = next; render(); },
    onStartEditing: () => { editing = true; render(); },
    onFinishEditing: () => { finishes++; editing = false; render(); },
  }))));
  try {
    await React.act(render);
    await React.act(() => document.querySelector('button[aria-label="Focus editor"]').click());
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    await React.act(() => view.dispatch({ changes: { from: value.length, insert: '：未发送' } }));
    document.body.tabIndex = -1;
    await React.act(() => document.body.focus());
    assert.equal(document.activeElement, document.body);
    await React.act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(!!document.querySelector('.canvas-text-focus-backdrop'), false, 'Escape closes the expanded editor after body focus');
    assert.equal(finishes, 1);
    assert.equal(value, '合成 Esc 检查：未发送');
  } finally {
    await React.act(() => root.unmount());
    document.body.removeAttribute('tabindex');
  }
});

test('expanded text Escape from editor and toolbar finishes once, while IME and template dismissal stay local', async () => {
  for (const from of ['editor', 'toolbar']) {
    let editing = true, finishes = 0;
    const root = createRoot(document.getElementById('root'));
    const render = () => root.render(React.createElement(ReactFlowProvider, null, React.createElement(FlowHarness, null, React.createElement(CanvasTextDocument, {
      nodeId: 'synthetic-ime', value: '合成正文', selected: true, editing, english: true, onChange: () => {},
      onStartEditing: () => { editing = true; render(); },
      onFinishEditing: () => { finishes++; editing = false; render(); },
    }))));
    try {
      await React.act(render);
      await React.act(() => document.querySelector('button[aria-label="Focus editor"]').click());
      const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
      await React.act(() => view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
      await React.act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })));
      assert.ok(document.querySelector('.canvas-text-focus-backdrop'));
      assert.equal(finishes, 0);
      await React.act(() => view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
      await React.act(() => document.querySelector('button[aria-label="Add script structure"]').click());
      const button = document.querySelector('button[aria-label="Add script structure"]');
      await React.act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      assert.equal(!!document.querySelector('.canvas-text-template-confirm'), false);
      assert.ok(document.querySelector('.canvas-text-focus-backdrop'));
      const target = from === 'editor' ? view.contentDOM : document.querySelector('button[aria-label="Bold"]');
      await React.act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      assert.equal(!!document.querySelector('.canvas-text-focus-backdrop'), false);
      assert.equal(finishes, 1);
    } finally { await React.act(() => root.unmount()); }
  }
});
