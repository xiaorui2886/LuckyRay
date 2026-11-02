// Offline bridge regression with controlled native/source seams; no GUI proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const start = source.indexOf('async function importNotesVaultMarkdownFiles(');
const end = source.indexOf('\nasync function exportNotesVaultMarkdownFile(', start);
const helperStart = source.indexOf('async function ensureNotesVaultImportSource(');
assert(start >= 0 && end > start);
const code = stripTypeScriptTypes((helperStart >= 0 ? source.slice(helperStart, start) : '')
  + source.slice(start, end));
const vault = { id: 'synthetic-vault', rootPath: '/synthetic/vault' };
const originalSource = () => ({ mode: 'real-vault', vaultId: vault.id, rootPath: vault.rootPath });

function fixture(options = {}) {
  const state = { source: originalSource(), backendActive: false, calls: [], ...options };
  const api = vm.runInNewContext(code + `
    if (helperGap) {
      const checkedEnsure = ensureNotesVaultImportSource;
      ensureNotesVaultImportSource = (...args) => checkedEnsure(...args).then(result => {
        queueMicrotask(afterHelperResolved);
        return result;
      });
    }
    ({ importNotesVaultMarkdownFiles, importNotesVaultMarkdownFolder });`, {
    helperGap: state.helperGap === true,
    queueMicrotask,
    afterHelperResolved: () => state.afterHelperResolved(),
    isTauri: () => state.native !== false,
    readActiveKnowledgeWriteSource: () => state.source,
    diagnoseNotesDrop: () => {},
    KnowledgeServiceError: class extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
    open: async () => state.select?.() ?? null,
    ensureActiveKnowledgeUiSource: async () => {
      state.calls.push('activate');
      if (state.activationFailure) throw new Error('activation-rejected');
      const active = { vaultId: state.source?.vaultId, sourceEpoch: 1 };
      state.backendActive = true;
      state.afterActivation?.();
      return state.activationReply || active;
    },
    invoke: async (command, input) => {
      state.calls.push(command);
      assert(state.backendActive, 'knowledge-source-inactive');
      assert.equal(input.vault.id, vault.id);
      return { copiedCount: 1, files: [], errors: [] };
    },
  });
  return { state, api };
}

const imports = [
  ['importNotesVaultMarkdownFiles', { sourcePaths: ['/synthetic/incoming/Note.md'] }, 'import_notes_vault_markdown_files'],
  ['importNotesVaultMarkdownFolder', { sourceDirectoryPath: '/synthetic/incoming' }, 'import_notes_vault_markdown_folder'],
];

for (const [method, selection, command] of imports) {
  test(`${method} activates a fresh current source before the native import`, async () => {
    const { state, api } = fixture();
    const result = await api[method]({ vault, targetParentRelativePath: '', ...selection });
    assert.equal(result.copiedCount, 1);
    assert.deepEqual(state.calls, ['activate', command]);
  });
}

test('imports reject a missing or mismatched current Vault without activation or native writes', async () => {
  for (const [method, selection] of imports) {
    for (const current of [null, { ...originalSource(), vaultId: 'other' }, { ...originalSource(), rootPath: '/other/root' }]) {
      const { state, api } = fixture({ source: current });
      await assert.rejects(api[method]({ vault, targetParentRelativePath: '', ...selection }), { code: 'knowledge-source-inactive' });
      assert.deepEqual(state.calls, []);
    }
  }
});

test('activation failure or another-Vault reply never reaches the native import', async () => {
  for (const [method, selection] of imports) {
    for (const options of [{ activationFailure: true }, { activationReply: { vaultId: 'other', sourceEpoch: 2 } }]) {
      const { state, api } = fixture(options);
      await assert.rejects(api[method]({ vault, targetParentRelativePath: '', ...selection }));
      assert.deepEqual(state.calls, ['activate']);
    }
  }
});

test('a new source session during the picker is rejected before activation', async () => {
  for (const [method, selection] of imports) {
    const { state, api } = fixture();
    state.select = () => {
      state.source = originalSource(); // Same Vault identity, different editing session.
      return selection.sourcePaths || selection.sourceDirectoryPath;
    };
    await assert.rejects(api[method]({ vault, targetParentRelativePath: '' }), { code: 'knowledge-source-inactive' });
    assert.deepEqual(state.calls, []);
  }
});

test('a source session replaced while activation is pending never imports', async () => {
  for (const [method, selection] of imports) {
    const { state, api } = fixture();
    state.afterActivation = () => { state.source = originalSource(); };
    await assert.rejects(api[method]({ vault, targetParentRelativePath: '', ...selection }), { code: 'knowledge-source-inactive' });
    assert.deepEqual(state.calls, ['activate']);
  }
});

test('a source switched in the microtask gap after the helper resolves never imports', async () => {
  for (const [method, selection] of imports) {
    for (const next of [originalSource(), { mode: 'real-vault', vaultId: 'other', rootPath: '/other/root' }]) {
      const { state, api } = fixture({ helperGap: true });
      state.afterHelperResolved = () => {
        state.source = next;
        state.calls.push('session-switch');
      };
      await assert.rejects(api[method]({ vault, targetParentRelativePath: '', ...selection }), { code: 'knowledge-source-inactive' });
      assert.deepEqual(state.calls, ['activate', 'session-switch']);
    }
  }
});

test('cancelled pickers and non-native previews do not activate or import', async () => {
  for (const [method] of imports) {
    for (const options of [{ select: () => null }, { native: false }]) {
      const { state, api } = fixture(options);
      const result = await api[method]({ vault, targetParentRelativePath: '' });
      assert.equal(result.copiedCount, 0);
      assert.deepEqual(state.calls, []);
    }
  }
});
