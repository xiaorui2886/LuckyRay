const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const helper = fs.readFileSync(path.join(root, 'src/core/services/shellFilePath.ts'), 'utf8');
const exportsObject = {};
new Function('exports', ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(exportsObject);
const shellFilePath = path => exportsObject.shellFilePath(path, 'Win32');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8').replaceAll('\r\n', '\n');
function bridge(name, mocks) {
  const start = app.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const end = app.indexOf('\n}\n', start) + 2;
  assert.ok(end > start);
  const code = ts.transpileModule(app.slice(start, end), {}).outputText;
  return new Function('context', `with(context) { ${code}; return ${name}; }`)({ shellFilePath, ...mocks });
}

test('catalog verbatim disk and UNC paths retain their identity for the native opener', () => {
  assert.equal(shellFilePath('//?/C:/素材/中文 image (2).png'), '\\\\?\\C:\\素材\\中文 image (2).png');
  assert.equal(shellFilePath('//?/UNC/server/share/中文 image.png'), '\\\\?\\UNC\\server\\share\\中文 image.png');
  assert.equal(shellFilePath('\\\\?\\C:\\素材/image.png'), '\\\\?\\C:\\素材\\image.png');
  const longPath = '//?/C:/' + 'long/'.repeat(80) + 'image.png';
  assert.equal(shellFilePath(longPath), longPath.replaceAll('/', '\\'));
});

test('ordinary paths, URLs and POSIX filenames are not rewritten or decoded', () => {
  for (const input of ['C:/素材/image (2).png', '\\\\server\\share\\x.png', '//server/share/x.png', '/tmp/a?b.png', '/tmp/a\\b.png', 'https://example.test/a%20b', 'C:/a%20b.png']) {
    assert.equal(shellFilePath(input), input);
  }
});

test('POSIX double-slash question-mark filenames remain unchanged on non-Windows', () => {
  for (const platform of ['Linux x86_64', 'MacIntel', '']) {
    assert.equal(exportsObject.shellFilePath('//?/tmp/file', platform), '//?/tmp/file');
  }
});

for (const name of ['revealAssetPath', 'openFilePath']) {
  test(`${name} passes the normalized path through the actual App bridge`, async () => {
    const calls = [];
    const operation = bridge(name, { isTauri: () => true, revealItemInDir: async p => calls.push(p), openPath: async p => calls.push(p) });
    assert.equal(await operation('//?/C:/素材/image (2).png'), true);
    assert.deepEqual(calls, ['\\\\?\\C:\\素材\\image (2).png']);
  });
}

test('reveal failure remains failure and does not launch a second action', async () => {
  let calls = 0;
  const operation = bridge('revealAssetPath', { isTauri: () => true, console: { warn() {} }, revealItemInDir: async () => { calls++; throw new Error('synthetic shell failure'); } });
  assert.equal(await operation('//?/C:/image.png'), false);
  assert.equal(calls, 1);
  assert.equal(await operation('browser:synthetic'), false);
  assert.equal(calls, 1);
});

test('default-app fallback retains its original native path contract', async () => {
  const calls = [];
  const operation = bridge('openFilePath', { isTauri: () => true, console: { warn() {} }, openPath: async () => { throw new Error('synthetic'); }, invoke: async (...args) => calls.push(args) });
  assert.equal(await operation('//?/C:/image.png'), true);
  assert.deepEqual(calls, [['open_existing_local_file_with_default_app', { path: '//?/C:/image.png' }]]);
});
