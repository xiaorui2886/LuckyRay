// Behavior contract for the EXT-Z1 community package surface. It bundles the
// production adapters plus the panel/flow components and drives them with a
// fake transport + a real theme target, asserting observed state transitions
// (not source strings). No desktop window, user profile or native host needed.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));

const REACT = root + '/node_modules/react';
const REACT_DOM = root + '/node_modules/react-dom';

async function loadAdapters() {
  const out = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'luckyray-ext-z1-')), 'bundle.cjs');
  await esbuild.build({
    stdin: {
      contents: `
        export * as packages from './src/core/extensions/packages';
        export { renderPackageTemplate } from './src/core/extensions/templates';
        export { probeTemplateTarget } from './src/core/extensions/templates';
        export { createExtensionTemplateActions } from './src/core/extensions/templates';
        export { applyPackageTheme } from './src/core/extensions/theme';
        export { PackagesPanel, extensionErrorCopyKey } from './src/features/community/ExtensionPackagesPanel';
        export { TemplateFlow } from './src/features/community/TemplateFlow';
        export { EXT_PACKAGE_MESSAGES, EXTENSION_ERROR_COPY } from './src/features/community/extensionMessages';
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    alias: { react: REACT, 'react-dom': REACT_DOM },
    plugins: [{
      name: 'stub-tauri-core',
      setup(build) {
        build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
          path: 'tauri-core',
          namespace: 'tauri-stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'tauri-stub' }, () => ({
          contents: 'export const invoke = async () => ({ revision: 0, hostVersion: "1.9.2", packages: [] });',
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  return require(out);
}

const themeTarget = () => {
  const styles = new Map();
  return {
    dataset: {},
    style: {
      setProperty: (k, v) => styles.set(k, v),
      removeProperty: (k) => styles.delete(k),
      getPropertyValue: (k) => styles.get(k) || '',
    },
    styles,
  };
};

// A minimal in-memory transport that mirrors the native store semantics the UI
// depends on: revision monotonicity, id conflict, version conflict, enable flags.
function fakeTransport() {
  let revision = 0;
  const packages = new Map();
  const state = () => ({
    revision,
    hostVersion: '1.9.2',
    packages: [...packages.values()].map((p) => ({ ...p })),
  });
  const bump = () => { revision += 1; };
  return async (request) => {
    if (request.op === 'list') return state();
    if (request.op === 'install') {
      const manifest = request.package.manifest;
      if (request.expectedRevision !== revision) throw Object.assign(new Error('revision-conflict'), { code: 'revision-conflict' });
      const existing = packages.get(manifest.id);
      if (existing && JSON.stringify(existing.package) !== JSON.stringify(request.package)) throw Object.assign(new Error('id-conflict'), { code: 'id-conflict' });
      if (!existing) packages.set(manifest.id, { package: request.package, enabled: false, digest: `d${revision}` });
      bump();
      return state();
    }
    if (request.op === 'enable' || request.op === 'disable') {
      if (request.expectedRevision !== revision) throw Object.assign(new Error('revision-conflict'), { code: 'revision-conflict' });
      const entry = packages.get(request.id);
      if (!entry) throw Object.assign(new Error('not-installed'), { code: 'not-installed' });
      entry.enabled = request.op === 'enable';
      bump();
      return state();
    }
    if (request.op === 'uninstall') {
      if (request.expectedRevision !== revision) throw Object.assign(new Error('revision-conflict'), { code: 'revision-conflict' });
      packages.delete(request.id);
      bump();
      return state();
    }
    if (request.op === 'update') {
      const manifest = request.package.manifest;
      if (request.expectedRevision !== revision) throw Object.assign(new Error('revision-conflict'), { code: 'revision-conflict' });
      const entry = packages.get(manifest.id);
      if (!entry) throw Object.assign(new Error('not-installed'), { code: 'not-installed' });
      const before = entry.package.manifest;
      const cmp = (a, b) => a.split('.').map(Number).reduce((acc, v, i) => acc || v - b.split('.').map(Number)[i], 0);
      if (manifest.type !== before.type) throw Object.assign(new Error('unsupported-type'), { code: 'unsupported-type' });
      if (cmp(manifest.version, before.version) <= 0) throw Object.assign(new Error('version-conflict'), { code: 'version-conflict' });
      packages.set(manifest.id, { package: request.package, enabled: entry.enabled, digest: `d${revision}` });
      bump();
      return state();
    }
    throw new Error('unexpected op ' + request.op);
  };
}

const THEME = JSON.stringify({
  manifest: { schemaVersion: 0, id: 'org.test.sage', name: 'Sage', version: '1.0.0', type: 'theme', entry: 'theme.json', minHostVersion: '1.9.2', apiVersion: 0, requiredModules: [], optionalModules: [] },
  resource: { base: 'light', tokens: { '--theme-app-bg': '#edf1e8', '--text-primary': '#293b29' } },
});

test('package service install/enable/disable/uninstall drive real state transitions', async () => {
  const adapters = await loadAdapters();
  const service = adapters.packages.createExtensionPackageService(fakeTransport());
  assert.equal(service.snapshot().packages.length, 0);

  let after = await service.install(THEME, service.snapshot().revision);
  assert.equal(after.packages.length, 1);
  assert.equal(after.packages[0].enabled, false, 'a freshly installed package is disabled');

  after = await service.enable('org.test.sage', after.revision);
  assert.equal(after.packages[0].enabled, true);

  // revision conflict is surfaced, not swallowed
  await assert.rejects(() => service.enable('org.test.sage', after.revision - 1), /revision-conflict/);

  after = await service.disable('org.test.sage', after.revision);
  assert.equal(after.packages[0].enabled, false);

  after = await service.uninstall('org.test.sage', after.revision);
  assert.equal(after.packages.length, 0);

  // unknown id is a stable, typed failure
  await assert.rejects(() => service.enable('org.test.sage', after.revision), /not-installed/);
});

test('id conflict, version conflict and stale revisions are distinguished', async () => {
  const adapters = await loadAdapters();
  const service = adapters.packages.createExtensionPackageService(fakeTransport());
  await service.install(THEME, 0);
  const conflicting = JSON.parse(THEME);
  conflicting.resource.tokens['--theme-app-bg'] = '#000000';
  await assert.rejects(() => service.install(JSON.stringify(conflicting), service.snapshot().revision), /id-conflict/);

  const v2 = JSON.parse(THEME);
  v2.manifest.version = '2.0.0';
  const updated = await service.update(JSON.stringify(v2), service.snapshot().revision);
  assert.equal(updated.packages[0].package.manifest.version, '2.0.0');

  const v1 = JSON.parse(THEME);
  await assert.rejects(() => service.update(JSON.stringify(v1), updated.revision), /version-conflict/);
});

test('theme preview overlays only allowlisted tokens and full restore clears them', async () => {
  const adapters = await loadAdapters();
  const service = adapters.packages.createExtensionPackageService(fakeTransport());
  await service.install(THEME, 0);

  const target = themeTarget();
  const stop = service.previewTheme('org.test.sage');
  adapters.applyPackageTheme(service.activeTheme(), target);
  assert.equal(target.dataset.theme, 'light');
  assert.equal(target.dataset.extensionTheme, 'active');
  assert.equal(target.style.getPropertyValue('--theme-app-bg'), '#edf1e8');
  assert.equal(target.style.getPropertyValue('--text-primary'), '#293b29');

  // cancel restores the pre-existing settings exactly
  stop();
  adapters.applyPackageTheme(service.activeTheme(), target);
  assert.equal(target.dataset.extensionTheme, undefined);
  assert.equal(target.style.getPropertyValue('--theme-app-bg'), '');
});

test('a superseded preview disposer cannot clear a later preview', async () => {
  const adapters = await loadAdapters();
  const service = adapters.packages.createExtensionPackageService(fakeTransport());
  await service.install(THEME, 0);
  const second = JSON.parse(THEME);
  second.manifest.id = 'org.test.slate';
  second.manifest.name = 'Slate';
  second.resource.base = 'dark';
  await service.install(JSON.stringify(second), service.snapshot().revision);

  const stopFirst = service.previewTheme('org.test.sage');
  const stopSecond = service.previewTheme('org.test.slate');
  assert.equal(service.activeTheme().base, 'dark');
  stopFirst(); // stale disposer must be inert
  assert.equal(service.activeTheme().base, 'dark', 'a stale disposer must not cancel the active preview');
  stopSecond();
  assert.equal(service.activeTheme(), null);
});

test('disabling an actively previewed theme drops the preview', async () => {
  const adapters = await loadAdapters();
  const service = adapters.packages.createExtensionPackageService(fakeTransport());
  let state = await service.install(THEME, 0);
  state = await service.enable('org.test.sage', state.revision);
  service.previewTheme('org.test.sage');
  assert.ok(service.activeTheme());
  await service.disable('org.test.sage', state.revision);
  assert.equal(service.activeTheme(), null, 'disabling the previewed theme ends the preview');
});

test('confirmPreview enables exactly the previewed theme, never a later one (R1)', async () => {
  const adapters = await loadAdapters();
  const service = adapters.packages.createExtensionPackageService(fakeTransport());
  await service.install(THEME, 0);
  const second = JSON.parse(THEME);
  second.manifest.id = 'org.test.slate';
  second.manifest.name = 'Slate';
  second.resource.base = 'dark';
  await service.install(JSON.stringify(second), service.snapshot().revision);

  const stopA = service.previewTheme('org.test.sage');
  assert.equal(service.activeTheme().base, 'light');
  // Supersede the preview with B, then confirm: the enabled theme must be B.
  service.previewTheme('org.test.slate');
  assert.equal(service.activeTheme().base, 'dark');
  stopA(); // the superseded disposer must be inert
  assert.equal(service.activeTheme().base, 'dark', 'a stale disposer cannot cancel the live preview');
  await service.confirmPreview(service.snapshot().revision);
  const enabled = service.snapshot().packages.find((p) => p.enabled);
  assert.equal(enabled.package.manifest.id, 'org.test.slate', 'confirm enables the actually-previewed theme');
  assert.equal(service.activeTheme().base, 'dark');
  assert.equal(service.enabledThemeId(), 'org.test.slate', 'enabledThemeId reports the active extension theme');
});

test('enabledThemeId is null with no enabled theme and tracks enable/disable (R1b)', async () => {
  const adapters = await loadAdapters();
  const service = adapters.packages.createExtensionPackageService(fakeTransport());
  assert.equal(service.enabledThemeId(), null);
  let state = await service.install(THEME, 0);
  assert.equal(service.enabledThemeId(), null, 'installed but not enabled is not active');
  state = await service.enable('org.test.sage', state.revision);
  assert.equal(service.enabledThemeId(), 'org.test.sage');
  state = await service.disable('org.test.sage', state.revision);
  assert.equal(service.enabledThemeId(), null, 'switching back to a built-in theme clears the extension theme');
});

test('template rendering substitutes parameters once and escapes markdown', async () => {
  const adapters = await loadAdapters();
  const resource = {
    markdown: '# {{topic}}\n\n{{body}}\n',
    parameters: { topic: 'Title', body: 'default' },
  };
  const out = adapters.renderPackageTemplate(resource, { topic: 'A *starred* title', body: '# hello' });
  assert.match(out, /^# A \\\*starred\\\* title/m);
  assert.match(out, /\\# hello/);
  assert.doesNotMatch(out, /\{\{/, 'no placeholder may survive substitution');
  assert.throws(() => adapters.renderPackageTemplate(resource, { nope: 'x' }), /extension-unknown-parameter/);
});

test('error codes map to stable copy keys and unknown codes stay neutral', async () => {
  const adapters = await loadAdapters();
  assert.equal(adapters.extensionErrorCopyKey({ code: 'id-conflict' }), 'pack.error.conflict');
  assert.equal(adapters.extensionErrorCopyKey({ code: 'revision-conflict' }), 'pack.error.revision');
  assert.equal(adapters.extensionErrorCopyKey({ code: 'totally-unknown' }), 'pack.error.unknown');
  assert.equal(adapters.extensionErrorCopyKey(null), 'pack.error.unknown');
  // every mapped key must exist in the catalog so copy never renders a raw key
  for (const key of Object.values(adapters.EXTENSION_ERROR_COPY)) {
    assert.ok(adapters.EXT_PACKAGE_MESSAGES[key], `missing catalog entry for ${key}`);
  }
});

test('probeTemplateTarget refuses insert when the live editor session is dirty (B)', async () => {
  const adapters = await loadAdapters();
  const SOURCE = { vaultId: 'demo' };
  const context = { documentRef: { vaultId: 'demo', relativePath: 'notes/current.md' }, expectedRevision: 'r1', cursorOffset: 12 };
  const clean = await adapters.probeTemplateTarget({
    source: () => SOURCE,
    context: async () => context,
    draft: () => ({ dirty: () => false }),
  });
  assert.equal(clean.insertAvailable, true, 'a clean mounted editor session allows insert');

  const dirty = await adapters.probeTemplateTarget({
    source: () => SOURCE,
    context: async () => context,
    draft: () => ({ dirty: () => true }),
  });
  assert.equal(dirty.insertAvailable, false, 'a dirty editor session must not advertise insert');
  assert.equal(dirty.target.documentRefRelativePath, null);
});

test('probeTemplateTarget refuses insert when the source switches during the context await (B)', async () => {
  const adapters = await loadAdapters();
  const A = { vaultId: 'vault-a' };
  const B = { vaultId: 'vault-b' };
  let current = A;
  let resolveContext;
  const pending = new Promise((r) => { resolveContext = r; });
  const probe = adapters.probeTemplateTarget({
    source: () => current,
    context: () => pending,
    draft: () => ({ dirty: () => false }),
  });
  // The active source swaps while context() is still in flight.
  current = B;
  resolveContext({ documentRef: { vaultId: 'vault-a', relativePath: 'notes/a.md' }, expectedRevision: 'r1', cursorOffset: 5 });
  const result = await probe;
  assert.equal(result.insertAvailable, false, 'a source change during the await must not offer insert');
  assert.equal(result.target, null, 'the probe reports no target rather than a stale one');
});

test('createExtensionTemplateActions.probeTarget surfaces failures without throwing (B)', async () => {
  const adapters = await loadAdapters();
  const service = adapters.packages.createExtensionPackageService(fakeTransport());
  const actions = adapters.createExtensionTemplateActions(service, {
    source: () => ({ vaultId: 'demo' }),
    context: async () => { throw new Error('context unavailable'); },
    draft: () => ({ dirty: () => false }),
  });
  // A failing context must resolve to "unavailable", never reject.
  const probe = await actions.probeTarget().catch((error) => ({ threw: String(error) }));
  assert.equal(probe.threw, undefined, 'probeTarget must not reject');
  assert.equal(probe.insertAvailable, false);
});
