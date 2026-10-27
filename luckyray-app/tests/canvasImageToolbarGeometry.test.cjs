const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules/vite'))] }));
const built = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/features/canvas/CanvasAnchoredSurface.tsx')],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  loader: { '.css': 'empty' },
});
const loaded = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(loaded, loaded.exports, require);
const { placeCanvasImageToolbar } = loaded.exports;
const stage = { width: 1200, height: 900 };
const surface = { width: 350, height: 40 };
function clearTitle(position, header, label) {
  assert.equal(position.visible, true, label);
  assert.ok(position.y + surface.height <= header.top - 12 + .01 || position.y >= header.bottom + 12 - .01, label);
  assert.ok(position.y >= 76 && position.y + surface.height <= stage.height - 56, label);
}
for (const zoom of [.25, .5, 1, 1.5, 2, 3]) {
  test(`toolbar clears scaled header with exactly 12 screen pixels at ${zoom}x`, () => {
    const node = { x: 300, y: 300, width: 300 * zoom, height: 200 * zoom };
    const header = { top: node.y - 23 * zoom, bottom: node.y - 9 * zoom };
    const position = placeCanvasImageToolbar(node, header, stage, surface);
    clearTitle(position, header, `${zoom}x`);
    assert.equal(position.side, 'top');
    assert.equal(header.top - position.y - surface.height, 12);
  });
}
test('top-edge node flips below rather than clamping over title', () => {
  const node = { x: 300, y: 110, width: 300, height: 200 };
  const header = { top: 87, bottom: 101 };
  const position = placeCanvasImageToolbar(node, header, stage, surface);
  clearTitle(position, header, 'top edge');
  assert.equal(position.y, 322);
  assert.equal(position.side, 'bottom');
});
test('oversized node uses safe row below header when neither vertical side fits', () => {
  const node = { x: 200, y: 130, width: 900, height: 900 };
  const header = { top: 84, bottom: 112 };
  const position = placeCanvasImageToolbar(node, header, stage, surface);
  clearTitle(position, header, 'both sides clipped');
  assert.equal(position.y, 124);
});
test('zoom and pan sweep never crosses the title', () => {
  for (const zoom of [.25, .5, 1, 2, 3]) for (const y of [-200, 0, 70, 100, 140, 200, 600, 850]) {
    const node = { x: 200, y, width: 300 * zoom, height: 400 * zoom };
    const header = { top: y - 23 * zoom, bottom: y - 9 * zoom };
    const position = placeCanvasImageToolbar(node, header, stage, surface);
    if (position.visible) clearTitle(position, header, `${zoom}x y=${y}`);
  }
});
test('offscreen and invalid nodes stay hidden', () => {
  for (const node of [{ x: -1000, y: 300, width: 100, height: 100 }, { x: 200, y: NaN, width: 100, height: 100 }]) {
    assert.equal(placeCanvasImageToolbar(node, { top: node.y - 23, bottom: node.y - 9 }, stage, surface).visible, false);
  }
});
