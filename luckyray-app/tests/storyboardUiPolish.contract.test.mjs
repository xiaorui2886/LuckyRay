import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../src/features/canvas/canvasStoryboardTable.css',import.meta.url),'utf8');
test('native storyboard menus use opaque theme options without changing control geometry',()=>{
  assert.match(css,/\.canvas-storyboard-dialog select\{color-scheme:inherit\}/);
  assert.match(css,/\.canvas-storyboard-dialog select :is\(option,optgroup\)\{background-color:var\(--theme-surface-raised\);color:var\(--text-primary\)\}/);
});

test('saved-script focus ring stays inside the control without changing its layout',()=>{
  assert.match(css,/\.canvas-storyboard-dialog \.canvas-storyboard-library select:focus-visible\{[^}]*outline:2px solid var\(--accent\)[^}]*outline-offset:-2px/);
});
test('storyboard scroll owner stays scrollable while both scrollbar renderers are hidden',()=>{
  assert.match(css,/\.canvas-storyboard-dialog \.canvas-storyboard-workspace\{[^}]*overflow:auto[^}]*scrollbar-width:none[^}]*scrollbar-gutter:auto/);
  assert.match(css,/\.canvas-storyboard-dialog \.canvas-storyboard-workspace::\-webkit-scrollbar\{[^}]*display:none[^}]*width:0[^}]*height:0/);
});
test('slightly stronger separators are local to the storyboard dialog and preserve one-pixel geometry',()=>{
  assert.match(css,/\.canvas-creative-dialog\.canvas-storyboard-dialog\{[^}]*--canvas-storyboard-divider:color-mix\(in srgb,var\(--text-primary\) 10%,transparent\)/);
  assert.match(css,/\.canvas-shot-table-scroll\{[^}]*border-top:1px solid var\(--canvas-storyboard-divider\)/);
  assert.match(css,/\.canvas-shot-table th,\.canvas-shot-table td\{[^}]*border-bottom:1px solid var\(--canvas-storyboard-divider\)/);
  assert.match(css,/\.canvas-storyboard-dialog \.canvas-storyboard-main :is\(\.canvas-storyboard-shot,\.canvas-storyboard-generation,\.canvas-storyboard-footer,\.canvas-storyboard-script-shot\)\{border-color:var\(--canvas-storyboard-divider\)\}/);
  assert.doesNotMatch(css,/:root\{[^}]*--canvas-storyboard-divider/);
});
