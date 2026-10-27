import assert from 'node:assert/strict';
import test from 'node:test';
import { CINEMATOGRAPHY_OPTIONS, createDefaultCinematographySettings, normalizeCinematographySettings, compileCinematographyPrompt, cinematographyHasDirections } from '../src/core/canvas/cinematography.ts';

test('default, disabled, all-auto and text generation preserve prompt exactly', () => {
  const prompt = '  User text\n[Camera direction]\nDo not erase this.  ';
  for (const settings of [undefined, createDefaultCinematographySettings(), { version: 1, enabled: true }, { version: 1, enabled: false, camera: 'imax' }]) {
    assert.equal(compileCinematographyPrompt(prompt, settings, 'image'), prompt);
  }
  assert.equal(compileCinematographyPrompt(prompt, { version: 1, enabled: true, camera: 'imax' }, 'text'), prompt);
});
test('malformed data is stripped, unknown versions fail closed, enabled is strict boolean', () => {
  for (const value of [null, [], 'camera', 5, { version: 2, enabled: true, camera: 'imax' }]) assert.deepEqual(normalizeCinematographySettings(value), createDefaultCinematographySettings());
  const clean = normalizeCinematographySettings({ version: 1, enabled: 'true', camera: 'injected instruction', lens: {}, focalLength: Infinity, aperture: 1.4, token: 'secret' });
  assert.deepEqual(clean, createDefaultCinematographySettings());
  assert.equal(JSON.stringify(clean).includes('secret'), false);
});
test('every allowlisted value survives normalization and compiles into bounded visual directions', () => {
  for (const [field, options] of Object.entries(CINEMATOGRAPHY_OPTIONS)) {
    for (const [value] of options) {
      const settings = normalizeCinematographySettings({ version: 1, enabled: true, [field]: value });
      assert.equal(settings[field as keyof typeof settings], value);
      const result = compileCinematographyPrompt('Original', settings, 'video');
      assert.equal(result.startsWith('Original'), true);
      assert.equal(result !== 'Original', value !== 'auto');
    }
  }
});
test('selected camera, lens, focal length, aperture, composition and video motion reach prompt', () => {
  const settings = { version: 1, enabled: true, camera: 'arri-alexa-35', lens: 'canon-k35', focalLength: '35', aperture: '1.4', framing: 'close-up', angle: 'low', movement: 'dolly-in' };
  const result = compileCinematographyPrompt('A portrait', settings, 'video');
  for (const expected of ['ARRI Alexa 35', 'Canon K35', '35 mm', 'f/1.4', 'shallow depth of field', 'Close-up', 'Low angle', 'Dolly in']) assert.ok(result.includes(expected));
  assert.equal(compileCinematographyPrompt(result, settings, 'video'), result);
});
test('image ignores motion, retaining it for future video use', () => {
  const settings = normalizeCinematographySettings({ version: 1, enabled: true, movement: 'handheld' });
  assert.equal(cinematographyHasDirections(settings, 'image'), false);
  assert.equal(compileCinematographyPrompt('Still image', settings, 'image'), 'Still image');
  assert.equal(cinematographyHasDirections(settings, 'video'), true);
  assert.ok(compileCinematographyPrompt('Video', settings, 'video').includes('Handheld'));
  assert.equal(settings.movement, 'handheld');
});
test('compilation does not strip user content that resembles an old camera block', () => {
  const prompt = 'Keep this\n\n[Camera direction]\nMy exact creative writing.';
  const result = compileCinematographyPrompt(prompt, { version: 1, enabled: true, camera: 'imax' }, 'image');
  assert.ok(result.startsWith(prompt));
  assert.equal((result.match(/\[Camera direction\]/g) ?? []).length, 2);
});
