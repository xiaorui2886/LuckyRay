import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinWorkflows, captureWorkflow, instantiateWorkflow, parseWorkflow, validateWorkflow, type WorkflowTemplate } from '../src/core/canvas/workflowTemplates.ts';
import { createDefaultCinematographySettings, normalizeCinematographySettings } from '../src/core/canvas/cinematography.ts';
import { createCreativeRecipe } from '../src/core/canvas/imageCreativeActions.ts';
const base = (): WorkflowTemplate => builtinWorkflows()[0];
const cinema = () => normalizeCinematographySettings({ version: 1, enabled: true, camera: 'sony-venice', lens: 'canon-k35', focalLength: '35', movement: 'dolly-in' });
const recipe = () => createCreativeRecipe('story-grid', { grid: '3x3' })!;
function inserted(value: unknown) { let id = 0; return instantiateWorkflow(value, { x: 10, y: 20 }, () => `fresh-${++id}`); }

test('legacy version-one workflows remain identical and do not add camera or recipe metadata', () => {
  for (const original of builtinWorkflows()) {
    assert.deepEqual(parseWorkflow(JSON.stringify(original)), original);
    for (const node of inserted(original).nodes) {
      assert.equal('generationCinematography' in node.data, false);
      assert.equal('generationCreativeRecipe' in node.data, false);
    }
  }
});
test('capture, JSON and instantiate round-trip only portable creative settings', () => {
  const raw = { id: 'original', position: { x: 30, y: 50 }, data: { kind: 'generator' as const, generationKind: 'image' as const, generationPrompt: 'User text only', generationCinematography: { ...cinema(), apiKey: 'NEVER_EXPORT', hardware: 'NOT_HARDWARE' }, generationCreativeRecipe: recipe(), generationProfileId: 'PRIVATE_PROFILE', resultMediaUrl: 'https://private.invalid/result' } };
  const exported = captureWorkflow([raw], [], ['original'], 'Camera workflow').template;
  const json = JSON.stringify(exported);
  for (const forbidden of ['NEVER_EXPORT', 'NOT_HARDWARE', 'PRIVATE_PROFILE', 'private.invalid', 'apiKey', 'hardware', 'resultMediaUrl']) assert.equal(json.includes(forbidden), false);
  const parsed = parseWorkflow(json);
  assert.deepEqual(parsed.nodes[0].cinematography, cinema());
  assert.deepEqual(parsed.nodes[0].creativeRecipe, recipe());
  const restored = inserted(parsed).nodes[0].data;
  assert.deepEqual(restored.generationCinematography, cinema());
  assert.deepEqual(restored.generationCreativeRecipe, recipe());
  assert.equal(restored.generationPrompt, 'User text only');
  assert.notEqual(restored.generationCreativeRecipe, parsed.nodes[0].creativeRecipe);
});
test('disabled defaults stay off across export and insertion', () => {
  const value = base(); value.nodes[0].cinematography = createDefaultCinematographySettings();
  const settings = inserted(parseWorkflow(JSON.stringify(value))).nodes[0].data.generationCinematography;
  assert.deepEqual(settings, createDefaultCinematographySettings());
});
test('untrusted camera versions, options, missing required fields and extra fields are rejected', () => {
  for (const invalid of [{ ...cinema(), version: 2 }, { ...cinema(), enabled: 'yes' }, { ...cinema(), camera: 'unknown' }, { ...cinema(), focalLength: 35 }, { ...cinema(), apiKey: 'secret' }, { version: 1, enabled: true }, null, []]) {
    const value: any = base(); value.nodes[0].cinematography = invalid;
    assert.throws(() => validateWorkflow(value));
  }
});
test('untrusted recipes reject unknown ids, versions, options, defaults and metadata', () => {
  for (const invalid of [{ ...recipe(), version: 2 }, { ...recipe(), id: 'unknown' }, { ...recipe(), apiKey: 'secret' }, { ...recipe(), options: { grid: '4x4' } }, { ...recipe(), options: {} }, { ...recipe(), options: { grid: '3x3', profile: 'secret' } }, null]) {
    const value: any = base(); value.nodes[0].creativeRecipe = invalid;
    assert.throws(() => validateWorkflow(value));
  }
});
test('only generators accept metadata, video supports camera but rejects image recipes', () => {
  const video = base(); video.nodes[0].generationKind = 'video'; video.nodes[0].cinematography = cinema();
  assert.deepEqual(validateWorkflow(video).nodes[0].cinematography, cinema());
  video.nodes[0].creativeRecipe = recipe(); assert.throws(() => validateWorkflow(video));
  for (const kind of ['text', 'group', 'image', 'video']) for (const key of ['cinematography', 'creativeRecipe']) {
    const value: any = base(); value.nodes[0] = { id: 'x', kind, label: '', position: { x: 0, y: 0 }, [key]: key === 'cinematography' ? cinema() : recipe() };
    assert.throws(() => validateWorkflow(value));
  }
});
test('creative metadata never bypasses pinned-media or storyboard export refusal', () => {
  const node = { id: 'g', position: { x: 0, y: 0 }, data: { kind: 'generator' as const, generationKind: 'image' as const, generationCinematography: cinema(), generationCreativeRecipe: recipe() } };
  assert.throws(() => captureWorkflow([node], [{ source: 'outside', target: 'g', data: { referenceMediaUrl: 'https://private.invalid/pin' } }], ['g'], 'Pinned'), /stored-references/);
  assert.throws(() => captureWorkflow([{ ...node, data: { ...node.data, storyboardShot: { version: 1 } } }], [], ['g'], 'Shot'), /storyboard-unsupported/);
});
