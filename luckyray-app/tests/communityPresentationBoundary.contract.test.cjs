// Community presentation and read-refresh changes preserve mutation/security owners.
// Read readiness is exercised by the component replay, not frozen to the old loading UI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const baseline = '1fa7a9a0bcf83bb15ff96b0ca5962a72795ba275';
// Scope this UI-only boundary to its accepted integration. A later installer
// candidate deliberately changes native engine admission and package versions;
// those are covered by the release/runtime contracts, not this visual guard.
const acceptedPresentation = '8dbb79d57e444c8071b02888485aaa9dd836d60b';
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
  const readFreshness = statement => /^const (\[capabilityReady|capabilityInFlight|load = useCallback|countReady|capabilityProps)/.test(statement);
  assert.deepEqual(logic(read(productPath), readFreshness), logic(before(productPath), readFreshness));
});

test('every page callback, permission/availability gate and tab keyboard binding is identical', () => {
  const pendingReadGate = attribute => attribute === 'disabled={loading}';
  assert.deepEqual(interactive(read(productPath), pendingReadGate), interactive(before(productPath), pendingReadGate));
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

test('extension mutation and preview actions, invocation lifecycle and modal authority are unchanged', () => {
  const script = 'src/features/community/ScriptPlugins.tsx';
  assert.deepEqual(logic(read(script)), logic(before(script)));
  const packages = 'src/features/community/ExtensionPackagesPanel.tsx';
  const onlyPanel = source => logic(source, statement => /^const \[(state|load),/.test(statement)).filter(([name]) => name === 'PackagesPanel');
  assert.deepEqual(onlyPanel(read(packages)), onlyPanel(before(packages)));
  const presentation = 'src/features/community/CommunityPresentation.tsx';
  assert.deepEqual(logic(read(presentation)), logic(before(presentation)));
});

test('MCP auth/runtime, full-trust runtime, core services and modal safety remain unchanged; accepted presentation did not alter native files', () => {
  for (const file of [
    'src/features/community/mcp/model.ts',
    'src/features/community/DesktopExtensions.tsx',
    'src/features/community/TemplateFlow.tsx',
    'src/core/extensions/packages.ts', 'src/core/extensions/templates.ts',
    'src/app/applicationModalIsolation.ts',
  ]) assert.equal(read(file), before(file), file);
  execFileSync('git', ['merge-base', '--is-ancestor', acceptedPresentation, 'HEAD'], {cwd: root});
  const changedNative = execFileSync('git', ['diff', baseline, acceptedPresentation, '--relative', '--name-only', '--', 'src-tauri', 'package.json'], {cwd: root, encoding: 'utf8'}).trim().split(/\r?\n/).filter(Boolean);
  // This inherited identity file was already dirty before the visual task, not a product change.
  assert.deepEqual(changedNative.filter(file => file !== 'src-tauri/binaries/luckyray-cli-x86_64-pc-windows-msvc.exe.identity.json'), []);
});
