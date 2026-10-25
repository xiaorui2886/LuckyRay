const assert = require('node:assert/strict'), path = require('node:path'), { createRequire } = require('node:module'), test = require('node:test');
const base = path.resolve(__dirname, '../../..'), req = createRequire(base + '/package.json');
const tool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : req;
const { JSDOM } = tool('jsdom'), dom = new JSDOM('<div id="root"></div>', { url: 'https://test.invalid', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator']) Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = req('react'), { createRoot } = req('react-dom/client'), esbuild = req('esbuild');
const bundled = esbuild.buildSync({ entryPoints: [base + '/src/features/canvas/CanvasImageCropOverlay.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' });
const moduleObject = { exports: {} }; new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(moduleObject, moduleObject.exports, req);
const { CanvasImageCropOverlay } = moduleObject.exports;
let draws = [], captures = new Map(), releases = [];
window.HTMLCanvasElement.prototype.getContext = function () { return { translate() {}, scale() {}, rotate() {}, drawImage: (...args) => draws.push({ width: this.width, height: this.height, args }) }; };
window.HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200 }; };
window.HTMLElement.prototype.setPointerCapture = function (id) { captures.set(id, this); };
window.HTMLElement.prototype.hasPointerCapture = function (id) { return captures.get(id) === this; };
window.HTMLElement.prototype.releasePointerCapture = function (id) { captures.delete(id); releases.push(id); };
const full = { x: 0, y: 0, width: 1, height: 1 }, selection = { x: .2, y: .2, width: .5, height: .5 };
const handle = name => document.querySelector(`[data-crop-handle="${name}"]`);
const stage = () => document.querySelector('.canvas-image-crop-stage');
function pointer(target, type, x, y, id = 7, extra = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extra });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: extra.isPrimary ?? true } });
  target.dispatchEvent(event); return event;
}
function key(target, key, extra = {}) { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(event); return event; }
function closeEnough(actual, expected) { for (const name of Object.keys(expected)) assert.ok(Math.abs(actual[name] - expected[name]) < 1e-10, `${name}: ${actual[name]} != ${expected[name]}`); }
async function harness(initial = selection, extra = {}) {
  draws = []; captures = new Map(); releases = [];
  const root = createRoot(document.querySelector('#root')), changes = [];
  let props = { source: { naturalWidth: 2000, naturalHeight: 1000 }, sourceSize: { width: 2000, height: 1000 }, turns: 0, flipX: false, flipY: false, sessionKey: 'a:0', english: true, ...extra };
  let current, setCrop;
  function Harness() {
    const [crop, setter] = React.useState(initial); current = crop; setCrop = setter;
    return React.createElement(CanvasImageCropOverlay, { ...props, crop, onChange(next) { changes.push(next); setter(next); } });
  }
  async function render(next = {}) { props = { ...props, ...next }; await React.act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness)))); }
  await render();
  return { root, changes, render, crop: () => current, set: async next => React.act(() => setCrop(next)), unmount: async () => React.act(() => root.unmount()) };
}

test('R7C crop: move uses normalized deltas, capture, focus and lightweight overlay only', async () => {
  const h = await harness(), beforeDraws = draws.length;
  assert.equal(document.querySelectorAll('[data-crop-handle]').length, 9);
  assert.deepEqual(draws.at(-1) && [draws.at(-1).width, draws.at(-1).height], [1000, 500]);
  await React.act(() => pointer(handle('move'), 'pointerdown', 120, 70));
  assert.equal(captures.get(7), handle('move')); assert.equal(document.activeElement, handle('move'));
  await React.act(() => pointer(stage(), 'pointermove', 160, 50));
  closeEnough(h.crop(), { x: .3, y: .1, width: .5, height: .5 });
  const box = document.querySelector('.canvas-image-crop-selection');
  assert.ok(Math.abs(parseFloat(box.style.left) - 30) < 1e-10); assert.equal(box.style.width, '50%');
  assert.equal(draws.length, beforeDraws, 'pointer moves do not redraw the source');
  await React.act(() => pointer(stage(), 'pointerup', 160, 50)); assert.equal(captures.size, 0); assert.deepEqual(releases, [7]);
  await h.unmount();
});

test('R7C crop: all eight resize handles change only their edges and stay within source', async () => {
  const h = await harness();
  for (const name of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    await h.set(selection);
    await React.act(() => pointer(handle(name), 'pointerdown', 100, 50));
    await React.act(() => pointer(stage(), 'pointermove', 120, 60));
    const crop = h.crop();
    if (name.includes('w')) closeEnough(crop, { x: .25, width: .45 });
    else if (name.includes('e')) closeEnough(crop, { x: .2, width: .55 });
    else closeEnough(crop, { x: .2, width: .5 });
    if (name.includes('n')) closeEnough(crop, { y: .25, height: .45 });
    else if (name.includes('s')) closeEnough(crop, { y: .2, height: .55 });
    else closeEnough(crop, { y: .2, height: .5 });
    await React.act(() => pointer(stage(), 'pointerup', 120, 60));
  }
  await h.unmount();
});

test('R7C crop: aspect-locked resizing measures source pixels, not display pixels', async () => {
  const h = await harness({ x: .2, y: .2, width: .25, height: .5 }, { aspectRatio: 1 });
  await React.act(() => pointer(handle('se'), 'pointerdown', 120, 70));
  await React.act(() => pointer(stage(), 'pointermove', 100, 70));
  closeEnough(h.crop(), { x: .2, y: .2, width: .2, height: .4 });
  assert.equal(h.crop().width * 2000, h.crop().height * 1000);
  await React.act(() => pointer(stage(), 'pointerup', 100, 70)); await h.unmount();
});

test('R7C crop: arrows nudge one source pixel; Shift nudges ten; handle keys resize', async () => {
  const h = await harness(), beforeDraws = draws.length;
  await React.act(() => key(handle('move'), 'ArrowRight'));
  closeEnough(h.crop(), { x: .2005 });
  await React.act(() => key(handle('move'), 'ArrowDown', { shiftKey: true }));
  closeEnough(h.crop(), { y: .21 });
  await React.act(() => key(handle('e'), 'ArrowLeft', { shiftKey: true }));
  closeEnough(h.crop(), { width: .495 });
  assert.match(document.querySelector('[role="status"]').textContent, /990 by 500 pixels/);
  assert.equal(draws.length, beforeDraws);
  for (const element of document.querySelectorAll('[data-crop-handle]')) { assert.ok(element.getAttribute('aria-label')); assert.ok(element.getAttribute('aria-describedby')); }
  await h.unmount();
});

test('R7C crop: Escape and pointer cancellation roll back only the active gesture', async () => {
  const h = await harness(); let escaped;
  await React.act(() => pointer(handle('move'), 'pointerdown', 100, 50));
  await React.act(() => pointer(stage(), 'pointermove', 150, 50));
  await React.act(() => { escaped = key(handle('move'), 'Escape'); });
  assert.equal(escaped.defaultPrevented, true); closeEnough(h.crop(), selection); assert.equal(captures.size, 0);
  const count = h.changes.length;
  await React.act(() => pointer(stage(), 'pointermove', 300, 150)); assert.equal(h.changes.length, count);
  await React.act(() => pointer(handle('se'), 'pointerdown', 100, 50));
  await React.act(() => pointer(stage(), 'pointermove', 150, 70));
  await React.act(() => pointer(stage(), 'pointercancel', 150, 70)); closeEnough(h.crop(), selection);
  await React.act(() => pointer(handle('e'), 'pointerdown', 100, 50));
  await React.act(() => pointer(stage(), 'pointermove', 140, 50));
  await React.act(() => pointer(stage(), 'lostpointercapture', 140, 50)); closeEnough(h.crop(), selection);
  await h.unmount();
});

test('R7C crop: source/orientation, ratio and busy changes invalidate old captured events', async () => {
  const h = await harness();
  for (const next of [{ sessionKey: 'b:0' }, { sessionKey: 'b:1', turns: 1, sourceSize: { width: 1000, height: 2000 } }, { sessionKey: 'b:1:flip', flipX: true }, { aspectRatio: 1 }, { disabled: true }]) {
    await React.act(() => pointer(handle('move'), 'pointerdown', 100, 50));
    await React.act(() => pointer(stage(), 'pointermove', 120, 50));
    const count = h.changes.length, latest = { ...h.crop() };
    await h.render(next); assert.equal(captures.size, 0);
    await React.act(() => { pointer(stage(), 'pointermove', 300, 150); pointer(stage(), 'pointercancel', 300, 150); });
    assert.equal(h.changes.length, count); closeEnough(h.crop(), latest);
  }
  const count = h.changes.length;
  await React.act(() => { pointer(handle('move'), 'pointerdown', 100, 50); pointer(stage(), 'pointermove', 200, 50); key(handle('move'), 'ArrowLeft'); });
  assert.equal(h.changes.length, count); assert.equal(handle('move').disabled, true);
  await h.unmount();
});

test('R7C crop: secondary pointers are ignored and unmount releases capture', async () => {
  const h = await harness();
  await React.act(() => pointer(handle('move'), 'pointerdown', 100, 50, 9, { isPrimary: false })); assert.equal(captures.size, 0);
  await React.act(() => pointer(handle('move'), 'pointerdown', 100, 50, 9, { button: 2 })); assert.equal(captures.size, 0);
  await React.act(() => pointer(handle('move'), 'pointerdown', 100, 50));
  await React.act(() => pointer(stage(), 'pointermove', 200, 50, 8)); closeEnough(h.crop(), selection);
  await h.unmount(); assert.equal(captures.size, 0); assert.deepEqual(releases, [7]);
});

test('R7C crop: impossible tiny-source ratios preserve the crop and announce instead of throwing', async () => {
  const h = await harness(full, { source: { naturalWidth: 1, naturalHeight: 1 }, sourceSize: { width: 1, height: 1 }, aspectRatio: 16 / 9 });
  await React.act(() => key(handle('e'), 'ArrowLeft'));
  closeEnough(h.crop(), full); assert.equal(h.changes.length, 0);
  assert.match(document.querySelector('[role="status"]').textContent, /cannot be made smaller/);
  await h.unmount();
});

test('R7C crop: a 64-megapixel source allocates only a 1000px preview canvas', async () => {
  const h = await harness(full, { source: { naturalWidth: 8000, naturalHeight: 8000 }, sourceSize: { width: 8000, height: 8000 } });
  assert.ok(draws.length); assert.ok(draws.every(draw => draw.width === 1000 && draw.height === 1000));
  const before = draws.length;
  await h.set(selection); await h.render({ sourceSize: { width: 8000, height: 8000 } });
  assert.equal(draws.length, before, 'equal source dimensions do not invalidate cached pixels');
  await h.unmount();
});
