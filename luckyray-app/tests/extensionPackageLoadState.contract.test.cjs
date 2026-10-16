const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(root + '/node_modules/typescript');
const source = root + '/src/core/extensions/packages.ts';
const compiled = new Module(source, module);
compiled.paths = Module._nodeModulePaths(path.dirname(source));
compiled._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, source);
const { createExtensionPackageService } = compiled.exports;
const empty = (revision = 0) => ({ revision, hostVersion: '1.9.4', packages: [] });
const theme = {
  package: { manifest: { schemaVersion: 0, id: 'test.theme', name: 'Test theme', version: '1.0.0', type: 'theme', entry: 'theme.json', minHostVersion: '1.9.2', apiVersion: 0, requiredModules: [], optionalModules: [] }, resource: { base: 'light', tokens: { '--theme-app-bg': '#edf1e8' } } },
  enabled: false, digest: 'test-only',
};

test('a pending first read stays unready and does not publish', async () => {
  let resolve;
  const service = createExtensionPackageService(() => new Promise(done => { resolve = done; }));
  let calls = 0;
  service.subscribe(() => calls++);
  const pending = service.refresh();
  assert.equal(service.snapshot().ready, false);
  assert.equal(calls, 0);
  resolve(empty());
  await pending;
});

test('first success publishes the ready package snapshot to every subscriber', async () => {
  const service = createExtensionPackageService(async () => ({ ...empty(3), packages: [theme] }));
  const first = [], second = [];
  service.subscribe(() => first.push(service.snapshot()));
  service.subscribe(() => second.push(service.snapshot()));
  const result = await service.refresh();
  assert.equal(first.length, 1);
  assert.equal(first[0].ready, true);
  assert.deepEqual(first[0], result);
  assert.deepEqual(second, first);
  first[0].packages[0].package.manifest.name = 'subscriber copy';
  assert.equal(service.snapshot().packages[0].package.manifest.name, 'Test theme');
});

test('a successful empty revision-zero library is published as ready', async () => {
  const service = createExtensionPackageService(async () => empty());
  const snapshots = [];
  service.subscribe(() => snapshots.push(service.snapshot()));
  const result = await service.refresh();
  assert.deepEqual(snapshots, [{ ...empty(), ready: true }]);
  assert.deepEqual(result, snapshots[0]);
});

test('first failure remains unready; a successful retry publishes ready once', async () => {
  let fail = true;
  const service = createExtensionPackageService(async () => { if (fail) throw Error('read-failed'); return empty(); });
  const snapshots = [];
  service.subscribe(() => snapshots.push(service.snapshot()));
  await assert.rejects(service.refresh(), /read-failed/);
  assert.equal(service.snapshot().ready, false);
  assert.deepEqual(snapshots, []);
  fail = false;
  const result = await service.refresh();
  assert.deepEqual(snapshots, [result]);
  assert.equal(snapshots[0].ready, true);
});

test('failure after success preserves the last published state and readiness', async () => {
  let fail = false;
  const service = createExtensionPackageService(async () => { if (fail) throw Error('read-failed'); return empty(4); });
  const snapshots = [];
  service.subscribe(() => snapshots.push(service.snapshot()));
  const first = await service.refresh();
  fail = true;
  await assert.rejects(service.refresh(), /read-failed/);
  assert.deepEqual(service.snapshot(), first);
  assert.deepEqual(snapshots, [first]);
  fail = false;
  assert.deepEqual(await service.refresh(), first);
  assert.deepEqual(snapshots, [first, first]);
});

test('repeated successful reads and unsubscribe preserve subscription consistency', async () => {
  const service = createExtensionPackageService(async () => empty());
  const snapshots = [];
  const unsubscribe = service.subscribe(() => snapshots.push(service.snapshot()));
  await service.refresh();
  await service.refresh();
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every(state => state.ready));
  unsubscribe();
  await service.refresh();
  assert.equal(snapshots.length, 2);
});

test('an older overlapping read cannot publish or restore an obsolete revision', async () => {
  const replies = [];
  const service = createExtensionPackageService(() => new Promise(resolve => replies.push(resolve)));
  const snapshots = [];
  service.subscribe(() => snapshots.push(service.snapshot()));
  const older = service.refresh(), newer = service.refresh();
  replies[1]({ ...empty(5), packages: [theme] });
  const result = await newer;
  replies[0](empty(4));
  assert.deepEqual(await older, result);
  assert.deepEqual(snapshots, [result]);
  assert.equal(snapshots[0].ready, true);
});

test('existing theme consumers see readiness and the matching theme on every publication', async () => {
  let revision = 1, enabled = false;
  const service = createExtensionPackageService(async request => {
    if (request.op === 'enable') { enabled = true; revision++; }
    return { ...empty(revision), packages: [{ ...theme, enabled }] };
  });
  const snapshots = [];
  service.subscribe(() => snapshots.push({ state: service.snapshot(), theme: service.activeTheme() }));
  await service.refresh();
  const dispose = service.previewTheme('test.theme');
  await service.confirmPreview(1);
  dispose();
  assert.ok(snapshots.every(entry => entry.state.ready));
  assert.equal(snapshots[0].theme, null);
  assert.deepEqual(snapshots[1].theme, theme.package.resource);
  assert.equal(snapshots.at(-1).state.packages[0].enabled, true);
  assert.deepEqual(snapshots.at(-1).theme, theme.package.resource);
});
