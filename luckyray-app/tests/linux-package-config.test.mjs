import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const base = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
const linux = JSON.parse(readFileSync(new URL('../src-tauri/tauri.linux.conf.json', import.meta.url)));

test('Linux packaging selects deb and AppImage without replacing shared release resources', () => {
  assert.deepEqual(linux.bundle.targets, ['deb', 'appimage']);
  assert.equal(linux.bundle.linux.appimage.bundleMediaFramework, true);
  // T55: the only Linux-specific resource is the verified Agent Browser engine.
  assert.deepEqual(linux.bundle.resources, { 'agent-browser/': 'agent-browser/' });
  assert.equal(Object.hasOwn(linux.bundle, 'externalBin'), false);
  assert.deepEqual(Object.keys(base.bundle.resources).sort(), ['../third-party-notices/', 'dsh-host/', 'dsh/', 'media-engine/']);
  assert.deepEqual(base.bundle.externalBin, [
    'binaries/luckyray-native-host', 'binaries/luckyray-cli',
    'binaries/luckyray-mcp', 'binaries/luckyray-browser-host',
  ]);
});

test('Linux build preparation refuses unresolved release inputs', () => {
  assert.equal(linux.build.beforeBuildCommand, 'node scripts/linux/prepare-tauri-build.mjs');
  const script = fileURLToPath(new URL('../scripts/linux/prepare-tauri-build.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr.toString(), /separately sealed Linux LSH resources/);
    assert.match(error.stderr.toString(), /browser-host native messaging revocation/);
    assert.match(error.stderr.toString(), /Agent Browser: agent-browser bundle missing/);
    return true;
  });
});
