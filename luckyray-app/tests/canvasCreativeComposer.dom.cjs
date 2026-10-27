// Exercises the real MaterialCompactComposer and request compiler exported by
// tests/build-canvas-reference-plan-fixture.mjs, not a replacement component.
require.extensions['.css'] = () => {};
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const tool = process.env.LR_TEST_TOOLS ? createRequire(process.env.LR_TEST_TOOLS + '/package.json') : require;
const { JSDOM } = tool('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://qa.invalid', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'InputEvent', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'navigator']) {
  Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
}
global.ResizeObserver = class { observe() {} disconnect() {} };
window.__TAURI_INTERNALS__ = { convertFileSrc: path => 'http://asset.localhost/' + encodeURIComponent(path) };
const React = require('react');
const { createRoot } = require('react-dom/client');
const { flushSync } = require('react-dom');
const {
  MaterialCompactComposer,
  createGenerationRequestSnapshot: compile,
  REFERENCE_TEST_PROFILE: profile,
  I18nProvider,
  ReactFlowProvider,
} = require(require('node:path').resolve(process.argv[2]));
const root = createRoot(document.getElementById('root'));
const delay = () => new Promise(resolve => setTimeout(resolve, 25));
const textRecipes = ['story-grid', 'blocking-board', 'multi-angle', 'character-sheet', 'scene-sheet', 'product-sheet'];
const imageRecipes = ['time-shift', 'relight', 'cinematic-grade'];
const recipe = (id, options = {}) => ({ version: 1, id, options });
const reference = { id: 'node:original', kind: 'image', label: 'Original image', role: 'reference', mediaUrl: 'https://fixture.invalid/original.png' };
const linkedImage = { edgeId: 'original-edge', sourceNodeId: 'original', role: 'reference', reference };
const camera = { version: 1, enabled: true, camera: 'arri-alexa-35', lens: 'canon-k35', focalLength: '35', framing: 'close-up', angle: 'low', movement: 'auto' };
let checks = 0, props, renderId = 0, patches = [], derived = [], submits = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const submitButton = () => document.querySelector('.canvas-composer-submit');
const menu = () => document.querySelector('.canvas-image-creative-menu');
const creativeButton = () => document.querySelector('[aria-label="图像创作工具"]');
async function paint() {
  flushSync(() => root.render(React.createElement(React.StrictMode, null,
    React.createElement(I18nProvider, { locale: 'zh-CN' },
      React.createElement(ReactFlowProvider, null,
        React.createElement(MaterialCompactComposer, { key: renderId, ...props }))))));
  await delay();
}
async function render(data = {}, inputs = [], extra = {}) {
  renderId++; patches = []; derived = []; submits = 0;
  props = {
    node: { id: 'unchanged-image-card', position: { x: 15, y: 20 }, data: { label: 'Image draft', kind: 'generator', generationKind: 'image', generationPrompt: '', ...data } },
    connectedInputs: inputs,
    mediaProfile: profile,
    imageModels: [profile.imageModel], defaultImageModel: profile.imageModel,
    videoModels: [profile.videoModel], defaultVideoModel: profile.videoModel,
    embedded: true,
    onDataChange: patch => patches.push(patch),
    onSubmit: () => submits++,
    onAddReference: () => {},
    ...extra,
  };
  await paint();
}
async function applyPatch() {
  check(patches.length > 0, 'an explicit edit produces a patch');
  props = { ...props, node: { ...props.node, data: { ...props.node.data, ...patches.at(-1) } } };
  await paint();
}
async function openMenu(fromChip = false) {
  const button = fromChip ? document.querySelector('.canvas-creative-recipe-switch') : creativeButton();
  check(button && !button.disabled, 'creative tools remain available before adding content');
  button.click(); await delay();
  check(menu(), 'creative menu opens');
  eq(menu().querySelectorAll('[data-creative-action]').length, 9, 'all nine presets are discoverable');
}
async function choose(id, fromChip = false) {
  await openMenu(fromChip);
  const button = menu().querySelector(`[data-creative-action="${id}"]`);
  check(!button.disabled, 'missing input does not prevent choosing a draft preset');
  button.click(); button.click(); await delay();
  eq(menu(), null, 'selection closes the menu');
}
async function typePrompt(text) {
  const editor = document.querySelector('[contenteditable="true"]');
  editor.focus(); editor.textContent = text;
  const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  await delay(); await applyPatch();
}
function snapshot() {
  return compile(props.node, props.connectedInputs, [], '', props.imageModels, profile.imageModel,
    props.videoModels, profile.videoModel, props.mediaProfile, props.includeNoteTitles, props.resolvedStoredReferences);
}
function unchangedExceptRecipe(before) {
  const { generationCreativeRecipe: ignoredBefore, ...previous } = before;
  const { generationCreativeRecipe: ignoredAfter, ...current } = props.node.data;
  eq(current, previous, 'recipe edits preserve prompt, references, model, camera, output and task metadata');
  eq(props.node.id, 'unchanged-image-card', 'the current node identity is retained');
  eq(document.querySelectorAll('.canvas-generation-composer').length, 1, 'no second composer is created');
}
(async () => {
  for (const id of textRecipes) {
    await render();
    check(submitButton().disabled, 'blank draft cannot Generate');
    const before = structuredClone(props.node.data);
    await choose(id);
    eq(patches.length, 1, 'repeated selection dispatches one patch');
    eq(Object.keys(patches[0]), ['generationCreativeRecipe'], 'selection changes only recipe metadata');
    eq(patches[0].generationCreativeRecipe.id, id, 'selected preset is stored on the current card');
    await applyPatch(); unchangedExceptRecipe(before);
    check(submitButton().disabled, 'recipe boilerplate alone cannot enable Generate');
    check(document.querySelector('.canvas-creative-input-hint[role="status"]'), 'missing input is a quiet status hint');
    eq(document.querySelector('[role="alert"]'), null, 'expected missing input is not a red error');
    eq(submits, 0, 'choosing a preset never generates automatically');
    await typePrompt('A blue-coated traveler in a glass greenhouse');
    check(!submitButton().disabled, 'real user prompt enables a text-first recipe');
    check(snapshot().prompt.includes('A blue-coated traveler in a glass greenhouse'), 'actual request keeps the user prompt');
    eq(document.querySelector('.canvas-creative-input-hint'), null, 'hint clears when the draft is ready');
    eq(submits, 0, 'editing the prompt never submits automatically');
  }

  for (const id of textRecipes) for (const kind of ['text', 'note']) {
    const input = { edgeId: 'context-edge', sourceNodeId: 'context', role: 'promptContext', reference: { id: 'node:context', kind, label: 'Title is not the subject', text: 'A copper robot tending a rooftop garden' } };
    await render({ generationCreativeRecipe: recipe(id) }, [input]);
    check(!submitButton().disabled, 'connected text body enables ' + id + ' without an image');
    check(snapshot().prompt.includes(input.reference.text), 'compiled request includes the connected body');
    eq(submits, 0, 'connected inputs do not auto-submit');
  }
  await render({ generationCreativeRecipe: recipe('story-grid'), generationCinematography: camera }, [{ edgeId: 'empty', sourceNodeId: 'empty', role: 'promptContext', reference: { id: 'node:empty', kind: 'note', label: 'Title alone must not count', text: '' } }]);
  check(submitButton().disabled, 'camera direction and empty note title do not count as user content');
  check(document.querySelector('.canvas-creative-input-hint'), 'empty linked content keeps the draft hint');
  props = { ...props, node: { ...props.node, data: { ...props.node.data, generationPrompt: '[[lr-ref:empty]]' } } };
  await paint();
  check(submitButton().disabled, 'an empty note token cannot substitute for real prompt content');
  check(document.querySelector('.canvas-creative-input-hint'), 'an alias-only prompt keeps the missing-input hint');

  for (const id of imageRecipes) {
    await render({ generationPrompt: 'Please transform this scene' });
    await choose(id); await applyPatch();
    check(submitButton().disabled, 'image editing recipe requires an image even with a text prompt');
    check(document.querySelector('.canvas-creative-input-hint')?.textContent.includes('参考图片'), 'image requirement is explained');
    eq(submits, 0, 'image-required preset selection remains manual');
  }
  for (const id of [...textRecipes, ...imageRecipes]) {
    await render({ generationCreativeRecipe: recipe(id) }, [linkedImage]);
    check(!submitButton().disabled, 'linked image enables ' + id + ' without supplemental text');
    eq(snapshot().references[0].mediaUrl, reference.mediaUrl, 'actual request retains the linked image');
    eq(submits, 0, 'ready drafts still await an explicit Generate');
  }
  submitButton().click(); await delay();
  eq(submits, 1, 'a ready creative draft submits only after the explicit Generate click');
  eq(patches, [], 'Generate does not overwrite draft metadata');

  const richData = {
    generationPrompt: 'Keep my exact prompt.\nSecond line.', generationModel: profile.imageModel,
    generationAspect: '16:9', generationQuality: 'high', generationCount: 1,
    generationReferences: [reference], generationInputOrder: ['original-edge'],
    generationCreativeRecipe: recipe('story-grid', { grid: '5x5' }), generationCinematography: camera,
    resultMediaUrl: 'https://fixture.invalid/result.png', resultMediaItems: [{ url: 'https://fixture.invalid/result.png' }],
    generationTask: { id: 'completed', status: 'succeeded' }, sourceGenerationTaskId: 'source-task',
  };
  await render(richData, [], { onCreateCreative: value => derived.push(value) });
  const before = structuredClone(props.node.data);
  await openMenu(true);
  eq(menu().querySelector('[data-creative-action="story-grid"]').getAttribute('aria-pressed'), 'true', 'current recipe is marked');
  menu().querySelector('[data-creative-action="story-grid"]').click(); await delay();
  eq(patches, [], 'choosing the same preset does not overwrite custom options');
  eq(props.node.data.generationCreativeRecipe.options.grid, '5x5', 'same-id selection preserves the 5x5 layout');
  eq(derived, [], 'existing recipe on a completed card never derives another node');
  await choose('relight', true); await applyPatch();
  eq(props.node.data.generationCreativeRecipe.id, 'relight', 'chip switch changes the recipe');
  unchangedExceptRecipe(before); eq(derived, [], 'switch remains in place even for completed results');
  check(!submitButton().disabled, 'stored image reference makes the switched edit preset valid');
  const previousPrompt = snapshot().prompt;
  document.querySelector('[aria-label="移除创作预设"]').click(); await delay(); await applyPatch();
  eq(props.node.data.generationCreativeRecipe, undefined, 'remove clears the preset metadata');
  eq(document.querySelector('.canvas-creative-recipe'), null, 'removed chip disappears');
  unchangedExceptRecipe(before);
  check(previousPrompt.includes('图像创意预设') && !snapshot().prompt.includes('图像创意预设'), 'removing the recipe removes its request instructions');
  eq(submits, 0, 'switching and removing never auto-submit');

  await render({ generationPrompt: 'Source prompt', resultMediaUrl: 'https://fixture.invalid/source.png', generationTask: { id: 'source-done', status: 'succeeded' } }, [], { onCreateCreative: value => derived.push(value) });
  const sourceBefore = structuredClone(props.node);
  await choose('character-sheet');
  eq(derived.length, 1, 'completed source without a preset requests exactly one linked draft');
  eq(derived[0].id, 'character-sheet', 'derived draft gets the selected recipe');
  eq(patches, [], 'source image metadata is untouched by derivation');
  eq(props.node, sourceBefore, 'completed source remains intact');
  eq(submits, 0, 'deriving a draft does not generate');

  await render();
  await openMenu();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await delay();
  eq(menu(), null, 'Escape dismisses without applying a preset'); eq(patches, [], 'Escape does not mutate the card');
  await openMenu(); document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); await delay();
  eq(menu(), null, 'outside pointer dismisses the menu'); eq(patches, [], 'outside dismissal does not mutate the card');
  await render({ generationKind: 'video' }); eq(creativeButton(), null, 'image creative presets do not leak into video controls');
  let cancels=0;
  for(const status of ['queued','running']) {
    await render({generationPrompt:'A new image',generationTask:{id:'active',status}},[],{onCancel:()=>cancels++});
    check(!submitButton().disabled,'active task stop remains available');
    check(submitButton().querySelector('rect'),'stop uses a compact square in the send slot');
    check(submitButton().getAttribute('aria-label').includes('取消'),'stop has an accessible cancellation label');
    submitButton().click(); await delay();
    eq(submits,0,'stop never submits another task');
    eq(document.querySelector('.canvas-result-actions'),null,'no extra active generation footer');
  }
  eq(cancels,2,'queued and running stop route to cancellation');
  await render({generationPrompt:'A new image',generationTask:{id:'done',status:'succeeded'}},[],{onCancel:()=>cancels++});
  check(!submitButton().querySelector('rect'),'completed task returns to send arrow');
  submitButton().click(); await delay();eq(submits,1,'completed same-node result can generate again');
  root.unmount(); dom.window.close();
  console.log(`Production creative composer: ${checks} assertions PASS`);
})().catch(error => { console.error(error); root.unmount(); dom.window.close(); process.exitCode = 1; });
