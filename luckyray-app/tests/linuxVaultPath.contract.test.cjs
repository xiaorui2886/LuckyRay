// Offline path regression: owned synthetic notes only; no desktop opener runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { stripTypeScriptTypes } = require('node:module');

const app = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(app, 'src/features/notes/NotesPage.tsx'), 'utf8');
const wiki = fs.readFileSync(path.join(app, 'src/core/markdown/wikiTargets.ts'), 'utf8');
const normalizerStart = wiki.indexOf('export function normalizeVaultRelativePath(');
const normalizerEnd = wiki.indexOf('\n}', normalizerStart) + 2;
const callbackStart = page.indexOf('  const vaultAbsolutePath = useCallback(');
const callbackEndMarker = '\n  }, [currentVault]);';
const callbackEnd = page.indexOf(callbackEndMarker, callbackStart) + callbackEndMarker.length;
assert(normalizerStart >= 0 && normalizerEnd > normalizerStart);
assert(callbackStart >= 0 && callbackEnd > callbackStart);
const code = stripTypeScriptTypes(wiki.slice(normalizerStart, normalizerEnd).replace('export ', '')
  + '\n' + page.slice(callbackStart, callbackEnd) + '\nvaultAbsolutePath;');
const vaultPath = rootPath => vm.runInNewContext(code, {
  currentVault: rootPath === null ? null : { rootPath }, useCallback: callback => callback,
});

test('Linux copy/reveal paths identify the real nested note and preserve literal root characters', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'luckyray-vault-path-'));
  try {
    for (const name of ['知识库 #100%', '末尾反斜杠\\']) {
      const root = path.join(fixture, name), directory = path.join(root, '项目');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const note = path.join(directory, '计划 #100%.md');
      fs.writeFileSync(note, 'synthetic note\n', { mode: 0o600 });
      const absolute = vaultPath(root + '/')('项目/计划 #100%.md');
      assert.equal(absolute, note);
      assert.equal(fs.readFileSync(absolute, 'utf8'), 'synthetic note\n');
      assert.equal(vaultPath(root + '/')('项目'), directory);
      assert.equal(vaultPath(root + '/')(''), root);
    }
    assert.equal(vaultPath('/')('项目/计划.md'), '/项目/计划.md');
    assert.equal(vaultPath('/')(''), '/');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('the existing Windows path spellings and absent-vault behavior stay unchanged', () => {
  for (const [root, expected] of [
    ['C:\\Vault\\', 'C:\\Vault\\项目\\计划.md'],
    ['C:/Vault/', 'C:/Vault\\项目\\计划.md'],
    ['\\\\server\\share\\Vault', '\\\\server\\share\\Vault\\项目\\计划.md'],
    ['//server/share/Vault', '//server/share/Vault\\项目\\计划.md'],
    ['\\\\?\\C:\\Vault', '\\\\?\\C:\\Vault\\项目\\计划.md'],
  ]) assert.equal(vaultPath(root)('项目/计划.md'), expected);
  assert.equal(vaultPath(null)('项目/计划.md'), '');
});
