import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const legacy = fs.readFileSync(new URL('../src/canvas-spike-scroll.css', import.meta.url), 'utf8');
const editor = fs.readFileSync(new URL('../src/features/canvas/canvasPromptEditor.css', import.meta.url), 'utf8');
test('rich prompt keeps original transparent unboxed composer surface', () => {
  const base = editor.match(/\.canvas-prompt-editor\s*\{([^}]+)\}/)[1];
  assert.match(base, /background:\s*transparent\s*;/);
  assert.match(base, /border:\s*0\s*;/);
  assert.match(base, /padding:\s*5px 0\s*;/);
});
test('legacy textarea chrome cannot leak onto rich editor in any theme or state', () => {
  const selectors = [...legacy.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map(match => match[1]).filter(selector => selector.includes('.canvas-composer-prompt'));
  assert.ok(selectors.length >= 6, 'covers dark/light hover/focus/placeholder');
  for (const selector of selectors) {
    assert.ok(!/(?<!textarea)\.canvas-composer-prompt/.test(selector), selector);
  }
});
