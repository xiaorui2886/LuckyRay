const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { test, before } = require('node:test');
const root = path.resolve(__dirname, '..');
const req = createRequire(root + '/package.json');
const tool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : req;
const { JSDOM } = tool('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://test.invalid', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator', 'localStorage']) Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = function () {};
const React = req('react');
const { createRoot } = req('react-dom/client');
const esbuild = req('esbuild');
let Home, Provider, model, images;
function evaluate(code) { const module = { exports: {} }; new Function('module', 'exports', 'require', code)(module, module.exports, req); return module.exports; }
before(async () => {
  const build = await esbuild.build({ stdin: { contents: 'export { default } from "./src/features/canvas/CanvasHomePage"; export { I18nProvider } from "./src/core/i18n/index";', resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty', '.svg': 'text' }, plugins: [{ name: 'test-boundaries', setup(build) {
    build.onResolve({ filter: /luckyRayBridge$|useFavoriteItems$/ }, args => ({ path: args.path, namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path.endsWith('luckyRayBridge') ? 'export const getLuckyRayBridgeSync = () => globalThis.__canvasBridge; export const getLuckyRayBridge = async () => globalThis.__canvasBridge;' : 'export const useFavoriteItems = () => globalThis.__favorites;' }));
  } }] });
  ({ default: Home, I18nProvider: Provider } = evaluate(build.outputFiles[0].text));
  for (const [file, save] of [['src/features/canvas/canvasHomeTemplates.ts', value => model = value], ['src/core/canvas/imageEditing.ts', value => images = value]]) {
    const result = esbuild.buildSync({ entryPoints: [root + '/' + file], bundle: true, write: false, platform: 'node', format: 'cjs' }); save(evaluate(result.outputFiles[0].text));
  }
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = label => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
const entry = (id, name = id) => ({ id, name, createdAt: '', updatedAt: '', nodeCount: 0, edgeCount: 0, coverVersion: 1, coverKind: null, coverUrl: null, coverPoster: null });
async function setup(overrides = {}) {
  const opened = [], saved = [], deleted = [], favorites = [];
  global.__favorites = { byId: new Map(), toggle: async id => { favorites.push(id); return { favorited: true }; } };
  global.__canvasBridge = {
    listCanvases: async () => [entry('a', 'Alpha'), entry('b', 'Beta')],
    getCanvasStorageDir: async () => '',
    createCanvas: async name => entry('created', name),
    loadCanvas: async id => ({ canvasId: id, name: id, createdAt: '', updatedAt: '', revision: 7, contentDigest: 'protected-baseline', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: .7 }, generationHistory: [] }),
    saveCanvas: async value => { saved.push(value); return entry(value.canvasId); },
    deleteCanvas: async id => deleted.push(id), ...overrides,
  };
  const instance = createRoot(document.querySelector('#root'));
  await React.act(async () => { instance.render(React.createElement(Provider, { locale: 'zh-CN' }, React.createElement(Home, { onOpenCanvas: id => opened.push(id) }))); await tick(); });
  return { instance, opened, saved, deleted, favorites };
}
async function click(label) { assert.ok(button(label), label); await React.act(async () => { button(label).click(); await tick(); }); }

test('quick starts are distinct real graphs without fake media or provider calls', () => {
  for (const kind of ['material', 'note', 'ai']) {
    let id = 0; const graph = model.buildHomeTemplate(kind, false, () => `node-${++id}`);
    assert.ok(graph.nodes.length >= 3);
    assert.equal(new Set(graph.nodes.map(node => node.id)).size, graph.nodes.length);
    const ids = new Set(graph.nodes.map(node => node.id));
    for (const edge of graph.edges) assert.ok(ids.has(edge.source) && ids.has(edge.target));
    for (const node of graph.nodes) { assert.equal(node.data.resultMediaUrl, undefined); assert.equal(node.data.refNoteId, undefined); assert.equal(node.data.generationStatus, undefined); }
    if (kind === 'material') assert.equal(graph.nodes[0].data.referencePack.kind, 'style');
    if (kind === 'ai') assert.equal(graph.nodes.filter(node => node.data.kind === 'generator').length, 3);
  }
  assert.deepEqual(model.buildHomeTemplate('blank'), { nodes: [], edges: [] });
});

test('quick-start saves graph with current revision before opening, same-tick click creates once', async () => {
  let creates = 0; const env = await setup({ createCanvas: async name => { creates++; return entry('created', name); } });
  const card = document.querySelectorAll('.canvas-home-template-card')[3];
  await React.act(async () => { card.click(); card.click(); await tick(); });
  assert.equal(creates, 1); assert.equal(env.saved.length, 1); assert.equal(env.saved[0].revision, 7); assert.equal(env.saved[0].contentDigest, 'protected-baseline');
  assert.equal(env.saved[0].nodes.filter(n => n.data.kind === 'generator').length, 3); assert.deepEqual(env.opened, ['created']);
  await React.act(() => env.instance.unmount());
});

test('failed template persistence never opens an empty canvas as a completed template', async () => {
  const env = await setup({ saveCanvas: async () => { throw Error('disk-full'); } });
  await React.act(async () => { document.querySelectorAll('.canvas-home-template-card')[1].click(); await tick(); });
  assert.deepEqual(env.opened, []); assert.ok(document.querySelector('.canvas-home-message'));
  await React.act(() => env.instance.unmount());
});

test('card rightclick and ellipsis share keyboard-accessible viewport menu', async () => {
  const env = await setup(); const card = document.querySelector('article');
  await React.act(() => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 700 })));
  let menu = document.querySelector('[role="menu"]'); assert.ok(menu); assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 6);
  const labels = menu.textContent;
  await React.act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role="menu"]'), null);
  await React.act(() => document.querySelector('.canvas-home-card-menu-trigger').click());
  menu = document.querySelector('[role="menu"]'); assert.equal(menu.textContent, labels);
  await React.act(() => env.instance.unmount());
});

test('multiselect does not open cards; partial batch deletion retains only failed selection', async () => {
  const deleted = []; const env = await setup({ deleteCanvas: async id => { if (id === 'b') throw Error('busy'); deleted.push(id); } });
  await click('多选');
  await React.act(() => document.querySelectorAll('.canvas-home-list-open').forEach(element => element.click()));
  assert.deepEqual(env.opened, []); assert.equal(document.querySelectorAll('[role="checkbox"][aria-checked="true"]').length, 2);
  await click('删除所选'); assert.equal(deleted.length, 0, 'confirmation required');
  await click('删除'); assert.deepEqual(deleted, ['a']);
  assert.equal(document.querySelectorAll('article').length, 1); assert.equal(document.querySelector('[role="checkbox"]').getAttribute('aria-checked'), 'true');
  await React.act(() => env.instance.unmount());
});

test('color adjustments validate finite bounds and use the same output pipeline', () => {
  assert.equal(images.imageAdjustmentFilter(), 'none');
  assert.equal(images.imageAdjustmentFilter({ brightness: 20, contrast: -10, saturation: -100 }), 'brightness(1.2) contrast(0.9) saturate(0)');
  for (const value of [NaN, Infinity, -101, 101]) assert.throws(() => images.imageAdjustmentFilter({ brightness: value, contrast: 0, saturation: 0 }));
  const contexts = []; const makeCanvas = () => { const ctx = { translate(){}, scale(){}, rotate(){}, drawImage(){} }; contexts.push(ctx); return { getContext: () => ctx }; };
  images.renderImageEdit({}, 100, 100, { turns: 0, flipX: false, flipY: false, crop: { x: 0, y: 0, width: 1, height: 1 }, width: 100, height: 100, adjustments: { brightness: 20, contrast: 0, saturation: 0 } }, makeCanvas);
  assert.equal(contexts[0].filter, 'brightness(1.2) contrast(1) saturate(1)');
  const overlay = fs.readFileSync(root + '/src/features/canvas/CanvasImageCropOverlay.tsx', 'utf8'); assert.match(overlay, /context\.filter = imageAdjustmentFilter\(adjustments\)/);
});

test('batch favorite is idempotent for favorites and freezes card selection while saving', async () => {
  const env = await setup(); let release;
  global.__favorites.byId.set('a', {});
  global.__favorites.toggle = async id => { env.favorites.push(id); await new Promise(resolve => { release = resolve; }); return { favorited: true }; };
  await click('多选'); await click('全选当前结果');
  await React.act(() => button('收藏所选').click());
  assert.deepEqual(env.favorites, ['b']);
  await React.act(() => document.querySelector('.canvas-home-list-open').click());
  assert.equal(document.querySelectorAll('[role="checkbox"][aria-checked="true"]').length, 2);
  await React.act(async () => { release(); await tick(); });
  assert.equal(document.querySelectorAll('[role="checkbox"][aria-checked="true"]').length, 0);
  await React.act(() => env.instance.unmount());
});
