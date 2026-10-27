import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const read = file => readFileSync(new URL(`../src/features/canvas/${file}`, import.meta.url), 'utf8');
const css = read('canvasCreative.css');
const start = css.indexOf('/* R16:');
assert.notEqual(start, -1);
const end = css.indexOf('/* End R16 dialog detail dividers. */', start);
assert.ok(end > start);
const root = postcss.parse(css.slice(start, end));
const declaration = (selector, property) => {
  let value;
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(property, decl => { value = decl.value; });
  });
  return value;
};
const compact = value => value.replace(/\s/g, '');
const token = '--canvas-creative-detail-divider';

test('detail dividers reuse accepted storyboard 10% primary-text separator', () => {
  const storyboard = postcss.parse(read('canvasStoryboardTable.css'));
  let reference;
  storyboard.walkDecls('--canvas-storyboard-divider', decl => { reference = decl.value; });
  assert.equal(compact(declaration('.canvas-image-tools-dialog', token)), compact(reference));
  assert.equal(compact(declaration('.canvas-packs-dialog', token)), compact(reference));
});

test('refinement crop and output sections use consistent one-pixel separators', () => {
  assert.equal(declaration('.canvas-image-tools-dialog .canvas-image-crop-heading', 'border-top-color'), `var(${token})`);
  assert.equal(declaration('.canvas-image-tools-dialog fieldset > strong', 'border-top'), `1px solid var(${token})`);
  assert.match(css, /\.canvas-image-crop-heading\{[^}]*border-top:1px solid/);
});

test('crop and output input outlines are visible without changing geometry', () => {
  for (const selector of ['.canvas-image-tools-dialog .canvas-image-tools-layout input[type=number]', '.canvas-image-tools-dialog label select']) {
    assert.equal(declaration(selector, 'border-color'), `var(${token})`);
    assert.equal(declaration(`${selector}:enabled:hover:not(:focus-visible)`, 'border-color'), 'color-mix(in srgb, var(--text-primary) 16%, transparent)');
    assert.equal(declaration(`${selector}:focus-visible`, 'border-color'), 'var(--accent)');
  }
  assert.match(css, /\.canvas-creative-dialog :focus-visible\{outline:2px solid var\(--accent\)/);
});

test('reference pack creation, saved cards and empty section share the same boundary', () => {
  for (const selector of ['.canvas-packs-dialog .canvas-pack-create-disclosure', '.canvas-packs-dialog .canvas-pack-card', '.canvas-packs-dialog .canvas-creative-empty']) {
    assert.equal(declaration(selector, 'border-color'), `var(${token})`);
  }
  assert.equal(declaration('.canvas-packs-dialog input:not([type=range]):not([type=checkbox])', 'border-color'), `var(${token})`);
  assert.equal(declaration('.canvas-packs-dialog select', 'border-color'), `var(${token})`);
  for (const selector of ['.canvas-packs-dialog input', '.canvas-packs-dialog select']) {
    const focusSelector = selector.endsWith(' input') ? `${selector}:not([type=range]):not([type=checkbox]):focus-visible` : `${selector}:focus-visible`;
    assert.equal(declaration(focusSelector, 'border-color'), 'var(--accent)');
    assert.equal(declaration(`${selector}:enabled:hover:not(:focus-visible)`, 'border-color'), 'color-mix(in srgb, var(--text-primary) 16%, transparent)');
  }
});

test('polish stays scoped and preserves disablement, focus, scrolling and motion contracts', () => {
  root.walkRules(rule => {
    for (const selector of rule.selectors) assert.match(selector, /^\.canvas-(?:image-tools|packs)-dialog(?:[\s:.#[]|$)/);
    rule.walkDecls(decl => assert.ok(['--canvas-creative-detail-divider', 'border-top-color', 'border-top', 'padding-top', 'border-color'].includes(decl.prop), `Unexpected behavior/geometry change: ${decl.prop}`));
  });
  assert.match(css, /\.canvas-creative-dialog button:disabled\{opacity:\.4;cursor:default\}/);
  assert.match(css, /\.canvas-image-tools-dialog fieldset\{[^}]*overflow-y:auto/);
});
