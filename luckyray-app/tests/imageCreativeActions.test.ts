import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { IMAGE_CREATIVE_ACTIONS, compileCreativeRecipePrompt, createCreativeRecipe, creativeRecipeRequiresImage, validateCreativeRecipeInput, normalizeCreativeRecipe, MAX_CREATIVE_USER_PROMPT_LENGTH } from '../src/core/canvas/imageCreativeActions.ts';

test('all nine actions create serializable deterministic prompt-only recipes', () => {
  assert.equal(IMAGE_CREATIVE_ACTIONS.length, 9);
  assert.equal(new Set(IMAGE_CREATIVE_ACTIONS.map((action) => action.id)).size, 9);
  for (const action of IMAGE_CREATIVE_ACTIONS) {
    const recipe = createCreativeRecipe(action.id);
    assert.ok(recipe);
    assert.deepEqual(normalizeCreativeRecipe(JSON.parse(JSON.stringify(recipe))), recipe);
    const original = JSON.stringify(recipe);
    const prompt = compileCreativeRecipePrompt('', recipe);
    assert.equal(prompt, compileCreativeRecipePrompt('', recipe));
    assert.equal(original, JSON.stringify(recipe));
    assert.match(prompt, /原始参考图/);
    assert.match(prompt, /主体的身份/);
    assert.match(prompt, /只生成一张输出图像/);
    assert.match(prompt, /不代表原生超分/);
  }
});
test('preserves optional user instructions verbatim including whitespace', () => {
  const user = '  保留人物 A\n\n  不要修改衣服。\t';
  assert.ok(compileCreativeRecipePrompt(user, createCreativeRecipe('story-grid')).endsWith(user));
  assert.throws(() => compileCreativeRecipePrompt('a'.repeat(MAX_CREATIVE_USER_PROMPT_LENGTH + 1), createCreativeRecipe('story-grid')));
  assert.doesNotThrow(() => compileCreativeRecipePrompt('a'.repeat(MAX_CREATIVE_USER_PROMPT_LENGTH), createCreativeRecipe('story-grid')));
});
test('grid layouts keep exact cell count and crop-safe left-to-right order', () => {
  for (const id of ['story-grid', 'blocking-board'] as const) {
    for (const [grid, count] of [['2x2', 4], ['3x3', 9], ['5x5', 25]] as const) {
      const prompt = compileCreativeRecipePrompt('', createCreativeRecipe(id, { grid }));
      assert.ok(prompt.includes(`${grid} 等分网格，共 ${count} 格`));
      assert.match(prompt, /从左到右、从上到下/);
      assert.match(prompt, /无格间留白、无边框、无黑边/);
    }
  }
  for (const id of ['multi-angle', 'character-sheet', 'scene-sheet', 'product-sheet'] as const) {
    assert.match(compileCreativeRecipePrompt('', createCreativeRecipe(id)), /3x3 等分网格，共 9 格/);
  }
});
test('time, lighting and color options affect only their explicit recipe instructions', () => {
  for (const direction of ['before', 'after'] as const) for (const seconds of [3, 5] as const) {
    const prompt = compileCreativeRecipePrompt('', createCreativeRecipe('time-shift', { direction, seconds }));
    assert.ok(prompt.includes(`发生${direction === 'before' ? '之前' : '之后'} ${seconds} 秒`));
    assert.match(prompt, /不是视频帧提取/);
  }
  const relight = ['soft-daylight', 'golden-hour', 'neon-night', 'studio'] as const;
  assert.equal(new Set(relight.map((lighting) => compileCreativeRecipePrompt('', createCreativeRecipe('relight', { lighting })))).size, 4);
  const tones = ['natural-film', 'warm-vintage', 'cool-suspense', 'black-white'] as const;
  assert.equal(new Set(tones.map((tone) => compileCreativeRecipePrompt('', createCreativeRecipe('cinematic-grade', { tone })))).size, 4);
});
test('invalid or future metadata fails closed; no implicit action substitution', () => {
  for (const value of [null, [], 'story-grid', {}, {version: 2, id:'story-grid'}, {version:1,id:'unknown'},
    {version:1,id:'story-grid', options:{grid:'4x4'}}, {version:1,id:'story-grid',options:{seconds:3}},
    {version:1,id:'story-grid', options:[]}, {version:1,id:'story-grid', extra:true},
    {version:1,id:'time-shift', options:{seconds:'3'}}, {version:1,id:'relight',options:{lighting:'x'.repeat(100000)}}]) {
    assert.equal(normalizeCreativeRecipe(value), null);
    assert.throws(() => compileCreativeRecipePrompt('', value), /无效或版本不受支持/);
  }
  assert.deepEqual(normalizeCreativeRecipe({version:1,id:'story-grid'}), createCreativeRecipe('story-grid'));
});

test('recipe module has no generation, network, persistence or UI side effects', () => {
  const source = readFileSync(new URL('../src/core/canvas/imageCreativeActions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:^|\n)import\s/);
  assert.doesNotMatch(source, /\b(?:fetch|invoke|setTimeout|setInterval|XMLHttpRequest|WebSocket|localStorage)\b/);
  assert.doesNotMatch(source, /generationRunner|generationAdapter|submitGeneration|react|@tauri/);
});


test('draft recipes require a real prompt or image; only three recipes mandate an image', () => {
  const imageOnly = ['time-shift', 'relight', 'cinematic-grade'];
  for (const action of IMAGE_CREATIVE_ACTIONS) {
    const recipe = createCreativeRecipe(action.id);
    const requiresImage = imageOnly.includes(action.id);
    assert.equal(action.requiresImage, requiresImage);
    assert.equal(creativeRecipeRequiresImage(recipe), requiresImage);
    assert.equal(validateCreativeRecipeInput(recipe, { hasImageReference: false, hasPrompt: false }), requiresImage ? 'image-required' : 'prompt-required');
    assert.equal(validateCreativeRecipeInput(recipe, { hasImageReference: false, hasPrompt: true }), requiresImage ? 'image-required' : null);
    assert.equal(validateCreativeRecipeInput(recipe, { hasImageReference: true, hasPrompt: false }), null);
  }
  assert.equal(creativeRecipeRequiresImage({ version: 2, id: 'story-grid' }), true);
  assert.equal(validateCreativeRecipeInput({ version: 2, id: 'story-grid' }, { hasImageReference: true, hasPrompt: true }), 'invalid-recipe');
});

test('text-first drafts compile all six supported presets without inventing a reference image', () => {
  const user = '  一位穿蓝色雨衣的旅人在玻璃温室里寻找一株发光的植物。\n  保持服装一致。\t';
  for (const action of IMAGE_CREATIVE_ACTIONS.filter(action => !action.requiresImage)) {
    const recipe = createCreativeRecipe(action.id);
    const original = JSON.stringify(recipe);
    const prompt = compileCreativeRecipePrompt(user, recipe, { hasImageReference: false });
    assert.match(prompt, /根据用户提供的文字描述创作/);
    assert.doesNotMatch(prompt, /参考图|原图|原始参考/);
    assert.match(prompt, /只生成一张输出图像/);
    assert.ok(prompt.endsWith(user));
    assert.equal(prompt, compileCreativeRecipePrompt(user, recipe, { hasImageReference: false }));
    assert.equal(JSON.stringify(recipe), original);
    for (const empty of ['', '  \n\t']) {
      assert.throws(() => compileCreativeRecipePrompt(empty, recipe, { hasImageReference: false }), /请先描述/);
    }
  }
});

test('image-edit recipes fail closed without a source image while legacy image prompts stay compatible', () => {
  for (const action of IMAGE_CREATIVE_ACTIONS) {
    const recipe = createCreativeRecipe(action.id);
    assert.equal(compileCreativeRecipePrompt('Keep identity', recipe), compileCreativeRecipePrompt('Keep identity', recipe, { hasImageReference: true }));
    if (action.requiresImage) {
      assert.throws(() => compileCreativeRecipePrompt('Do the edit', recipe, { hasImageReference: false }), /需要参考图片/);
    }
  }
});


test('connected text can satisfy text-first input without being duplicated in recipe instructions', () => {
  for (const action of IMAGE_CREATIVE_ACTIONS.filter(action => !action.requiresImage)) {
    const recipe = createCreativeRecipe(action.id);
    const prompt = compileCreativeRecipePrompt('', recipe, { hasImageReference: false, hasPrompt: true });
    assert.match(prompt, /根据用户提供的文字描述创作/);
    assert.doesNotMatch(prompt, /用户补充要求|参考图|原图/);
  }
  assert.throws(() => compileCreativeRecipePrompt('', createCreativeRecipe('relight'), { hasImageReference: false, hasPrompt: true }), /需要参考图片/);
});
