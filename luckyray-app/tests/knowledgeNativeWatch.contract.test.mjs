import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the resolved desktop dependency graph compiles the native filesystem watch command', () => {
  // Frontend watch() and fs:allow-watch are insufficient if the optional Rust
  // command is absent. Inspect Cargo's resolved features, not a manifest string.
  const graph = spawnSync('cargo', [
    'tree', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--offline',
    '--edges', 'features', '--invert', 'tauri-plugin-fs', '--prefix', 'none',
    '--format', '{p} [{f}]',
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.equal(graph.status, 0, graph.stderr || graph.error?.message);
  const resolved = graph.stdout.match(/^tauri-plugin-fs v[^\s]+ \[([^\]]*)\]/m);
  assert(resolved, 'Cargo must resolve the desktop filesystem plugin');
  const features = new Set(resolved[1].split(','));
  for (const feature of ['watch', 'notify', 'notify-debouncer-full']) {
    assert(features.has(feature), `Native filesystem observation requires resolved ${feature}: ${resolved[0]}`);
  }
});
