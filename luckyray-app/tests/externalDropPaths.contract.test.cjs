// Run the real path helper against owned synthetic files; no desktop import runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { stripTypeScriptTypes } = require('node:module');
const { pathToFileURL } = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '../src/features/notes/externalDropPaths.ts'), 'utf8');
const api = vm.runInNewContext(stripTypeScriptTypes(source.replace(/^export /gm, ''))
  + '\n({ normalizeDroppedLocalPath, dedupeDroppedLocalPaths });', { URL });
const linuxFilesystem = { skip: process.platform !== 'linux' };

test('POSIX native drops and local file URIs still identify the owned file', linuxFilesystem, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luckyray-note-drop-'));
  try {
    const names = ['笔记 #100%.md', 'literal%20.md', 'literal\\name.md'];
    for (const name of names) {
      const file = path.join(root, name);
      fs.writeFileSync(file, name, { mode: 0o600 });
      for (const input of [file, pathToFileURL(file).href]) {
        const actual = api.normalizeDroppedLocalPath(input);
        assert.equal(actual, file);
        assert.equal(fs.readFileSync(actual, 'utf8'), name);
      }
    }
    assert.equal(api.normalizeDroppedLocalPath('file://localhost/tmp/note%20%23.md'), '/tmp/note #.md');
    assert.equal(api.normalizeDroppedLocalPath('/'), '/');
    assert.equal(api.normalizeDroppedLocalPath('/tmp/name '), '/tmp/name ');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POSIX drops retain distinct case-sensitive names and remove exact URI duplicates', linuxFilesystem, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luckyray-note-drop-case-'));
  try {
    const upper = path.join(root, 'Note.md'), lower = path.join(root, 'note.md');
    fs.writeFileSync(upper, 'upper', { mode: 0o600 });
    fs.writeFileSync(lower, 'lower', { mode: 0o600 });
    const actual = Array.from(api.dedupeDroppedLocalPaths([
      upper, lower, pathToFileURL(upper).href, upper, null, '',
    ]));
    assert.deepEqual(actual, [upper, lower]);
    assert.deepEqual(actual.map(file => fs.readFileSync(file, 'utf8')), ['upper', 'lower']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing Windows drive, UNC, file-URI and duplicate normalization stays intact', () => {
  for (const [input, expected] of [
    [' C:/Vault/Note.md ', 'C:\\Vault\\Note.md'],
    ['C:\\\\Vault\\\\Note.md', 'C:\\Vault\\Note.md'],
    ['C:/', 'C:\\'],
    ['file:///C:/Vault/Note%20%23.md', 'C:\\Vault\\Note #.md'],
    ['file:///C|/Vault/Note.md', 'C:\\Vault\\Note.md'],
    ['file://server/share/Note%20%23.md', '\\\\server\\share\\Note #.md'],
    ['//server/share/Note.md', '\\\\server\\share\\Note.md'],
    ['\\\\?\\C:\\Vault\\Note.md', 'C:\\Vault\\Note.md'],
    ['\\\\?\\UNC\\server\\share\\Note.md', '\\\\server\\share\\Note.md'],
  ]) assert.equal(api.normalizeDroppedLocalPath(input), expected);
  assert.deepEqual(Array.from(api.dedupeDroppedLocalPaths([
    'C:/Vault/Note.md', 'c:\\vault\\note.md', 'file:///C:/Vault/Note.md',
    '\\\\SERVER\\share\\Note.md', '//server/share/note.md', undefined,
  ])), ['C:\\Vault\\Note.md', '\\\\SERVER\\share\\Note.md']);
});
