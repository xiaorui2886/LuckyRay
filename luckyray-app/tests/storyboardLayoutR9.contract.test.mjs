import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../src/features/canvas/${path}`, import.meta.url), 'utf8');
const table = read('CanvasStoryboardTable.tsx');
const board = read('CanvasStoryboard.tsx');
const css = read('canvasStoryboardTable.css');
test('R9 script workspace has one scroll owner and no wide-table minimum', () => {
  assert.match(css, /\.canvas-storyboard-dialog \.canvas-storyboard-workspace\{[^}]*overflow:auto/);
  for (const selector of ['canvas-storyboard-library', 'canvas-storyboard-main', 'canvas-storyboard-list']) {
    assert.match(css, new RegExp(`\\.canvas-storyboard-dialog \\.${selector}\\{[^}]*overflow:visible`));
  }
  assert.match(css, /\.canvas-shot-table-scroll\{[^}]*overflow:visible/);
  assert.match(css, /\.canvas-shot-table\{[^}]*min-width:0[^}]*table-layout:fixed/);
  assert.doesNotMatch(css, /min-width:\s*(?:1480|1200|1100)px/);
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /grid-template-columns:44px 70px minmax\(0,1fr\)/);
});
test('R9 main row has one description editor, number-only identity, and seven columns', () => {
  assert.equal((table.match(/field\("description"/g) || []).length, 1);
  assert.doesNotMatch(table, /field\("title"/);
  assert.doesNotMatch(table, /<span>\{s.durationSeconds\}s<\/span>/);
  assert.match(table, /colSpan=\{7\}/);
  assert.doesNotMatch(table, /horizontally scrollable|可横向滚动/);
  for (const callback of ['onPatch', 'onMove', 'onDuplicate', 'onRemoveReference', 'onEditReferences', 'onLocate']) assert.match(table, new RegExp(`props\\.${callback}`));
});
test('R9 secondary detail rendering retains optional name and production controls without main-field duplicates', () => {
  assert.match(board, /renderDetails=\{\(node, index\) => renderShot\(node, index, true\)\}/);
  assert.match(board, /镜头名称（可选）/);
  assert.match(board, /!secondary \? <Field[\s\S]*?Visual description/);
  assert.match(board, /!secondary \? <Field[\s\S]*?Dialogue \/ narration/);
  for (const key of ['lighting', 'sound', 'cameraMovement', 'action']) assert.match(board, new RegExp(`onPatch\\(\\{ ${key} \\}\\)`));
  for (const control of ['CanvasStoryboardCandidates', 'onChooseResult', 'onClearResult', 'onBuildPrompt', 'onGenerate', 'onPrompt', 'onExportBoard', 'onUndo', 'onRedo']) assert.ok(board.includes(control));
  assert.match(board, /脚本与分镜/);
  assert.match(board, /切换脚本/);
});
