const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [require('node:fs').realpathSync(path.join(root, 'node_modules/vite'))] }));
const source = process.env.LUCKYRAY_BASELINE_REF
  ? execFileSync('git', ['show', `${process.env.LUCKYRAY_BASELINE_REF}:luckyray-app/src/App.tsx`], {cwd: root, encoding: 'utf8'})
  : readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
// Execute the actual production adapter functions, with only platform/identity dependencies supplied.
const adapter = source.slice(source.indexOf('function normalizeAsset(asset:'), source.indexOf('function normalizeFolder('));
const context = vm.createContext({
  createId: () => 'fixture', filenameFromPath: p => p, kindFromName: () => 'video', normalizeRating: v => v ?? null, normalizeDominantColor: v => v ?? null,
  normalizeAssetStorageMode: v => v || 'linked', isTauri: () => true,
  convertFileSrc: p => `http://asset.localhost/${encodeURIComponent(p)}`,
});
if (adapter.includes('adaptMaterialAssetMedia(')) {
  const mediaSource = process.env.LUCKYRAY_BASELINE_REF
    ? execFileSync('git', ['show', `${process.env.LUCKYRAY_BASELINE_REF}:luckyray-app/src/core/services/materialAssetAdapter.ts`], {cwd: root, encoding: 'utf8'})
    : readFileSync(path.join(root, 'src/core/services/materialAssetAdapter.ts'), 'utf8');
  const mediaModule = { exports: {} };
  const mediaContext = vm.createContext({
    module: mediaModule,
    exports: mediaModule.exports,
    require(name) {
      assert.equal(name, '@tauri-apps/api/core', 'only the native URL boundary is supplied by the fixture');
      return { isTauri: context.isTauri, convertFileSrc: context.convertFileSrc };
    },
  });
  vm.runInContext(esbuild.transformSync(mediaSource, {loader: 'ts', format: 'cjs'}).code, mediaContext);
  context.adaptMaterialAssetMedia = mediaModule.exports.adaptMaterialAssetMedia;
}
vm.runInContext(esbuild.transformSync(adapter, {loader: 'ts', format: 'cjs'}).code, context);
const convert = p => `http://asset.localhost/${encodeURIComponent(p)}`;
for (const storageMode of ['linked', 'managed', 'source']) {
  test(`${storageMode} Catalog video keeps the playable file separate from its JPEG poster`, () => {
    const originalPath = '//?/C:/fixture/中文 空格 (1) 100%.mp4';
    const libraryPath = storageMode === 'linked' ? null : '//?/C:/fixture/library/video.mp4';
    const poster = convert('C:/fixture/poster.jpg');
    const result = context.normalizeAsset({id: 'video', name: 'video.mp4', kind: 'video', storageMode, originalPath, libraryPath, thumbnailUrl: poster});
    assert.equal(result.previewUrl, convert(libraryPath || originalPath));
    assert.equal(result.thumbnailUrl, poster);
  });
}
test('explicit browser playback URL remains authoritative, and image thumbnails are preserved', () => {
  const result = context.normalizeAsset({kind: 'video', previewUrl: 'blob:fixture', originalPath: 'browser:video', thumbnailUrl: 'data:image/jpeg;base64,fixture'});
  assert.equal(result.previewUrl, 'blob:fixture');
  assert.equal(result.thumbnailUrl, 'data:image/jpeg;base64,fixture');
  const image = context.normalizeAsset({kind: 'image', storageMode: 'managed', libraryPath: 'C:/image.png', thumbnailUrl: 'data:image/png;base64,fixture'});
  assert.equal(image.previewUrl, convert('C:/image.png'));
  assert.equal(image.thumbnailUrl, 'data:image/png;base64,fixture');
});
test('missing file stays a file request; no thumbnail substitution or guessed alternate path', () => {
  const result = context.normalizeAsset({kind: 'video', storageMode: 'linked', originalPath: 'C:/fixture/missing.mp4', thumbnailUrl: convert('C:/poster.jpg')});
  assert.equal(result.previewUrl, convert('C:/fixture/missing.mp4'));
});


test('linked original path wins even when a stale library path is present', () => {
  const result = context.normalizeAsset({kind:'video',storageMode:'linked',originalPath:'C:/original.mp4',libraryPath:'C:/stale.mp4'});
  assert.equal(result.previewUrl,convert('C:/original.mp4'));
});
