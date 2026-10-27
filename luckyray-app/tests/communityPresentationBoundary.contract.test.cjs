// A visual-only change must not alter the production handlers, hooks or security owners.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const baseline = 'e60bac08c98e86199a3f6ec0b5b28516fd8d0c1e';
const productPath = 'src/features/community/CommunityPage.tsx';
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const before = file => execFileSync('git', ['show', `${baseline}:luckyray-app/${file}`], { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n');
const parse = source => ts.createSourceFile(productPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const tokens = source => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source);
  const result = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push(scanner.getTokenText());
  return result;
};

const logic = (source, omit = () => false) => {
    const file = parse(source);
    return file.statements.filter(ts.isFunctionDeclaration).map(node => {
      const statements = node.body?.statements ?? [];
      const returnIndex = statements.findLastIndex(ts.isReturnStatement);
      return [node.name?.text, tokens(statements.slice(0, returnIndex < 0 ? statements.length : returnIndex).map(statement => statement.getText(file)).filter(statement => !omit(statement)).join('\n'))];
    });
};
const interactive = (source, omit = () => false) => {
  const file = parse(source), result = [];
  const visit = node => {
    if (ts.isJsxAttribute(node) && (/^on[A-Z]/.test(node.name.getText(file)) || ['disabled', 'aria-selected', 'aria-controls', 'tabIndex'].includes(node.name.getText(file))) && !omit(node.getText(file))) {
      result.push(tokens(node.getText(file)));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
};

test('Community page retains its hooks, subscriptions, lifecycle and install/template actions', () => {
  assert.deepEqual(logic(read(productPath)), logic(before(productPath)));
});

test('every page callback, permission/availability gate and tab keyboard binding is identical', () => {
  assert.deepEqual(interactive(read(productPath)), interactive(before(productPath)));
});

test('MCP drawer redesign preserves every hook, action callback and disabled gate', () => {
  const file = 'src/features/community/mcp/OfficialMcpCard.tsx';
  assert.deepEqual(logic(read(file)), logic(before(file)));
  assert.deepEqual(interactive(read(file)), interactive(before(file)));
});

test('Settings removes only the migrated collection observer and refresh action', () => {
  const file = 'src/features/settings/SettingsPage.tsx';
  const collectionObserver = statement => /collectionTransportReady|refreshRuntimeStatus/.test(statement);
  assert.deepEqual(logic(read(file)), logic(before(file), collectionObserver));
  assert.deepEqual(interactive(read(file)), interactive(before(file), attribute => attribute.includes('refreshRuntimeStatus')));
  assert.doesNotMatch(read(file), /collectionTransportReady|refreshRuntimeStatus|settings\.general\.collection\.service/);
});

test('MCP auth/runtime, extension actions, modal safety and native files are byte-equivalent to the accepted baseline', () => {
  for (const file of [
    'src/features/community/mcp/model.ts',
    'src/features/community/ScriptPlugins.tsx', 'src/features/community/ExtensionPackagesPanel.tsx',
    'src/features/community/TemplateFlow.tsx', 'src/features/community/CommunityPresentation.tsx',
    'src/core/extensions/packages.ts', 'src/core/extensions/templates.ts',
    'src/app/applicationModalIsolation.ts',
  ]) assert.equal(read(file), before(file), file);
  const changedNative = execFileSync('git', ['diff', baseline, '--relative', '--name-only', '--', 'src-tauri', 'package.json'], {cwd: root, encoding: 'utf8'}).trim().split(/\r?\n/).filter(Boolean);
  // This inherited identity file was already dirty before the visual task, not a product change.
  assert.deepEqual(changedNative.filter(file => file !== 'src-tauri/binaries/luckyray-cli-x86_64-pc-windows-msvc.exe.identity.json'), []);
});
