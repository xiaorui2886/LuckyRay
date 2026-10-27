const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Reuse the existing optional DOM test toolchain; no application dependency is added.
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const { JSDOM } = requireTool('jsdom');
const dom = new JSDOM('<button id="opener">Search</button><div id="root"></div>', { url: 'https://canvas-test.invalid', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator']) {
  Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const appRoot = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(appRoot, 'node_modules/vite'))] }));
const built = esbuild.buildSync({
  entryPoints: [path.join(appRoot, 'src/features/canvas/CanvasNodeSearchPanel.tsx')],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' },
});
const loaded = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(loaded, loaded.exports, require);
const { CanvasNodeSearchPanel, canvasNodeSearchKind, filterCanvasNodeSearchRows } = loaded.exports;

const rows = [
  { id: 'photo', label: 'Blue studio', kind: 'image', thumbnailUrl: 'https://canvas-test.invalid/watch.png', snippet: 'A silver watch on woven blue fabric' },
  { id: 'clip', label: 'Orbit shot', kind: 'video', thumbnailUrl: 'https://canvas-test.invalid/poster.jpg', snippet: 'Camera slowly moves around the watch' },
  { id: 'text', label: 'Opening', kind: 'text', snippet: 'The story begins at dawn.' },
  { id: 'note', label: 'Research notes', kind: 'note', snippet: 'Reference notes from the material study.' },
  { id: 'group', label: 'Scene 1', kind: 'group', snippet: 'Three shots' },
];
const options = () => [...document.querySelectorAll('[role="option"]')];
const input = () => document.querySelector('[role="combobox"]');
const click = async element => React.act(() => element.click());
const key = async (value, init = {}, target = input()) => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  await React.act(() => target.dispatchEvent(event));
  return event;
};
const edit = async value => React.act(() => {
  const field = input();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
});
const active = () => document.querySelector('[role="option"][aria-selected="true"]');
const filter = label => [...document.querySelectorAll('.canvas-search-filters button')].find(button => button.textContent === label);

async function mount(initial = {}) {
  document.getElementById('opener').focus();
  const root = createRoot(document.getElementById('root'));
  const selected = [], changed = [];
  let closed = 0, settings = initial;
  const Controller = () => {
    const [query, setQuery] = React.useState(settings.query || '');
    return React.createElement(React.StrictMode, null, React.createElement(CanvasNodeSearchPanel, {
      rows, english: true, ...settings, query,
      onQueryChange: value => { changed.push(value); setQuery(value); },
      onSelect: id => selected.push(id), onClose: () => { closed += 1; },
    }));
  };
  await React.act(() => root.render(React.createElement(Controller)));
  return {
    selected, changed, get closed() { return closed; },
    async update(next) { settings = { ...settings, ...next }; await React.act(() => root.render(React.createElement(Controller))); },
    async unmount() { await React.act(() => root.unmount()); },
  };
}

test('normalizes generation/result categories without mutating node data', () => {
  const data = Object.freeze({ kind: 'generator', generationKind: 'video' });
  assert.equal(canvasNodeSearchKind(data), 'video');
  assert.equal(canvasNodeSearchKind({ kind: 'generator' }), 'image');
  assert.equal(canvasNodeSearchKind({ kind: 'aiResult', resultKind: 'image' }), 'image');
  assert.equal(canvasNodeSearchKind({ kind: 'aiResult' }), 'text');
  assert.equal(canvasNodeSearchKind({ kind: 'aiPrompt' }), 'text');
  assert.equal(canvasNodeSearchKind({ kind: 'noteRef' }), 'note');
  assert.equal(canvasNodeSearchKind({ kind: 'image', refKind: 'audio' }), 'audio');
  assert.equal(canvasNodeSearchKind({ kind: 'group' }), 'group');
  assert.equal(canvasNodeSearchKind({ kind: 'futureType' }), 'other');
});

test('searches real prompts and bodies with stable name ranking and Unicode normalization', () => {
  const values = [
    { id: 'body', kind: 'image', label: 'Different', snippet: 'BLUE\n  studio shot' },
    { id: 'partial', kind: 'text', label: 'My blue studio', snippet: '' },
    { id: 'prefix', kind: 'image', label: 'Blue studio lighting', snippet: '' },
    { id: 'exact', kind: 'image', label: 'Blue studio', snippet: '' },
    { id: 'same', kind: 'image', label: 'Ｂｌｕｅ studio', snippet: '' },
  ];
  assert.deepEqual(filterCanvasNodeSearchRows(values, '  blue studio ').map(row => row.id), ['exact', 'same', 'prefix', 'partial', 'body']);
  assert.deepEqual(filterCanvasNodeSearchRows(rows, 'material study').map(row => row.id), ['note']);
  assert.deepEqual(filterCanvasNodeSearchRows(values, 'blue studio', 'text').map(row => row.id), ['partial']);
});

test('shows actual thumbnails and body snippets in a correctly connected combobox', async () => {
  const app = await mount();
  try {
    assert.equal(document.activeElement, input());
    assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
    assert.equal(document.getElementById(input().getAttribute('aria-controls')).getAttribute('role'), 'listbox');
    assert.equal(document.getElementById(input().getAttribute('aria-activedescendant')), active());
    assert.equal(options()[0].querySelector('img').src, rows[0].thumbnailUrl);
    assert.equal(options()[1].querySelector('img').src, rows[1].thumbnailUrl);
    assert.equal(options()[0].querySelector('small').textContent, rows[0].snippet);
    assert.equal(options()[3].querySelector('small').textContent, rows[3].snippet);
    assert.equal(options()[0].querySelector('.canvas-search-preview > svg'), null);
    assert.equal(document.querySelector('.canvas-search-count').textContent, '5 nodes');
  } finally { await app.unmount(); }
  assert.equal(document.activeElement.id, 'opener');
});

test('filters the complete canvas, including a matching node after the first ten', async () => {
  const many = Array.from({ length: 25 }, (_, index) => ({ id: `image-${index}`, label: `Photo ${index}`, kind: 'image', snippet: 'Image body' })).concat(rows[1]);
  const app = await mount({ rows: many });
  try {
    assert.equal(options().length, 26);
    await click(filter('Video'));
    assert.equal(options().length, 1);
    assert.equal(options()[0].querySelector('strong').textContent, 'Orbit shot');
    assert.equal(filter('Video').getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, input());
    await key('Enter');
    assert.deepEqual(app.selected, ['clip']);
    await click(filter('All'));
    assert.equal(options().length, 26);
  } finally { await app.unmount(); }
});

test('arrows wrap and Enter selects the active row without leaking canvas shortcuts', async () => {
  const app = await mount();
  let leaked = 0;
  const listener = () => { leaked += 1; };
  document.addEventListener('keydown', listener);
  try {
    assert.equal((await key('ArrowDown')).defaultPrevented, true);
    assert.equal(active().querySelector('strong').textContent, 'Orbit shot');
    await key('Enter');
    assert.deepEqual(app.selected, ['clip']);
    await key('ArrowUp');
    await key('ArrowUp');
    assert.equal(active().querySelector('strong').textContent, 'Scene 1');
    await key('ArrowDown');
    assert.equal(active().querySelector('strong').textContent, 'Blue studio');
    assert.equal(leaked, 0);
    await key('Escape');
    assert.equal(app.closed, 1);
  } finally { document.removeEventListener('keydown', listener); await app.unmount(); }
});

test('IME Enter and Escape never locate nodes or close search', async () => {
  const app = await mount();
  try {
    await key('Enter', { isComposing: true });
    await key('Escape', { isComposing: true });
    await key('Enter', { keyCode: 229 });
    assert.deepEqual(app.selected, []);
    assert.equal(app.closed, 0);
    await key('Enter');
    assert.deepEqual(app.selected, ['photo']);
  } finally { await app.unmount(); }
});

test('query changes reset active selection and empty results cannot select stale nodes', async () => {
  const app = await mount();
  try {
    await key('ArrowDown');
    await edit('material study');
    assert.equal(options().length, 1);
    assert.equal(active().querySelector('strong').textContent, 'Research notes');
    await key('Enter');
    assert.deepEqual(app.selected, ['note']);
    await edit('missing phrase');
    assert.equal(options().length, 0);
    assert.equal(input().hasAttribute('aria-activedescendant'), false);
    assert.match(document.querySelector('.canvas-search-empty').textContent, /No matching nodes/);
    await key('ArrowDown'); await key('ArrowUp'); await key('Enter');
    assert.deepEqual(app.selected, ['note']);
    await click(document.querySelector('.canvas-search-clear'));
    assert.equal(input().value, '');
    assert.equal(options().length, rows.length);
    assert.equal(active().querySelector('strong').textContent, 'Blue studio');
  } finally { await app.unmount(); }
});

test('removing an active row never leaves Enter pointing at a deleted node', async () => {
  const app = await mount();
  try {
    await key('ArrowDown');
    await app.update({ rows: rows.filter(row => row.id !== 'clip') });
    await key('Enter');
    assert.deepEqual(app.selected, ['photo']);
  } finally { await app.unmount(); }
});

test('broken preview falls back once, and a new URL gets a fresh preview', async () => {
  const app = await mount({ rows: [rows[0]] });
  try {
    await React.act(() => options()[0].querySelector('img').dispatchEvent(new Event('error')));
    assert.equal(options()[0].querySelector('img'), null);
    assert.ok(options()[0].querySelector('.canvas-search-preview > svg'));
    await app.update({ rows: [{ ...rows[0], thumbnailUrl: 'https://canvas-test.invalid/new.png' }] });
    assert.equal(options()[0].querySelector('img').src, 'https://canvas-test.invalid/new.png');
    await click(options()[0]);
    assert.deepEqual(app.selected, ['photo']);
  } finally { await app.unmount(); }
});

test('backdrop requires both pointer endpoints outside and Tab stays in the dialog', async () => {
  const app = await mount();
  const pointer = async (element, type) => React.act(() => element.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })));
  try {
    const overlay = document.querySelector('.canvas-search-overlay');
    await pointer(input(), 'pointerdown'); await pointer(overlay, 'pointerup');
    assert.equal(app.closed, 0);
    await pointer(overlay, 'pointerdown'); await pointer(input(), 'pointerup');
    assert.equal(app.closed, 0);
    await key('Tab', { shiftKey: true });
    assert.equal(document.activeElement, filter('Groups'));
    await key('Tab', {}, document.activeElement);
    assert.equal(document.activeElement, input());
    await pointer(overlay, 'pointerdown'); await pointer(overlay, 'pointerup');
    assert.equal(app.closed, 1);
  } finally { await app.unmount(); }
});

test('Chinese empty-canvas message differs from no query matches', async () => {
  const app = await mount({ rows: [], english: false });
  try {
    assert.match(document.querySelector('.canvas-search-empty').textContent, /画布中还没有节点/);
    assert.equal(document.querySelector('.canvas-search-count').textContent, '0 个节点');
    assert.equal(input().placeholder, '搜索节点…');
  } finally { await app.unmount(); }
});

test('canvas portal escapes the transformed toolbar and follows the supplied viewport host', async () => {
  const host = document.createElement('div');
  host.className = 'canvas-editor-body';
  document.body.append(host);
  const app = await mount({portalHost: host});
  try {
    const overlay = document.querySelector('.canvas-search-overlay');
    assert.equal(overlay.parentElement, host);
    assert.ok(overlay.classList.contains('is-canvas-relative'));
    assert.ok(overlay.classList.contains('canvas-panel-overlay'));
    assert.equal(document.activeElement, input());
    await key('Escape');
    assert.equal(app.closed, 1);
  } finally { await app.unmount(); host.remove(); }
});
