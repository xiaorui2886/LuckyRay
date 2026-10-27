import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAX_DSH_CLOSURE_FILE_COUNT, validateQualifiedDshRuntimeAuthority } from '../scripts/dsh-supply-chain.mjs';
const authority = JSON.parse(await readFile(new URL('../dsh-host/runtime-authority.json', import.meta.url)));
test('the measured 0.2.1 Windows closure fits an exact bounded host budget', () => {
  assert.equal(authority.dependencyClosure.releaseLayout.fileCount, 35_173);
  assert.equal(MAX_DSH_CLOSURE_FILE_COUNT, 40_000);
  for (const count of [35_173, 40_000]) {
    const input = structuredClone(authority);
    input.dependencyClosure.releaseLayout.fileCount = count;
    assert.equal(validateQualifiedDshRuntimeAuthority(input).dependencyClosure.releaseLayout.fileCount, count);
  }
  for (const count of [0, -1, 40_001, Number.MAX_SAFE_INTEGER, 35_173.5]) {
    const input = structuredClone(authority);
    input.dependencyClosure.releaseLayout.fileCount = count;
    assert.throws(() => validateQualifiedDshRuntimeAuthority(input), /qualified-authority-invalid/);
  }
});
test('native tree and metadata counts share the same cap; archive, byte and security limits remain', async () => {
  const native = await readFile(new URL('../src-tauri/src/dsh_engine_update.rs', import.meta.url), 'utf8');
  const tar = await readFile(new URL('../scripts/dsh-npm-tar-policy.mjs', import.meta.url), 'utf8');
  const maintenance = await readFile(new URL('../scripts/dsh-production-maintenance.mjs', import.meta.url), 'utf8');
  assert.match(native, /const MAX_CLOSURE_FILE_COUNT: u32 = 40_000;/);
  assert.match(native, /files\.len\(\) >= MAX_CLOSURE_FILE_COUNT as usize/);
  assert.match(native, /candidate\.closure_file_count > MAX_CLOSURE_FILE_COUNT/);
  assert.match(native, /const MAX_ARTIFACT_BYTES: u64 = 1024 \* 1024 \* 1024;/);
  assert.match(maintenance, /candidate\.closureFileCount > MAX_DSH_CLOSURE_FILE_COUNT/);
  assert.match(tar, /maxFiles = 30_000/);
  assert.equal(authority.policy.allowInstallScripts, false);
  assert.equal(authority.policy.allowSystemNodeFallback, false);
  assert.equal(authority.packageManager.installPolicy.minimumReleaseAge, 1440);
});
test('native load probes pin the actual new audited versions, not old package identities', async () => {
  const source = await readFile(new URL('../scripts/dsh-supply-chain.mjs', import.meta.url), 'utf8');
  const audit = JSON.parse(await readFile(new URL('../dsh-host/records/dependency-audit.json', import.meta.url)));
  const body = source.slice(source.indexOf('export async function probeDshNativeModules('),
    source.indexOf('export function buildPublishedDshRecords('));
  const expected = ['koffi@3.1.1', 'node-pty@1.2.0-beta.15', 'sharp@0.35.5', 'node-addon-require-builtin@0.1.9'];
  const declarations = [...body.matchAll(/^\s+"([^"\r\n]+@[0-9][^"\r\n]*)",$/gm)].map(value => value[1]);
  assert.deepEqual(declarations, expected);
  for (const identity of expected) assert.ok(audit.packages.some(pkg => `${pkg.name}@${pkg.version}` === identity));
  assert.match(body, /byIdentity\.get\(identity\)/);
  assert.match(body, /createRequire\(pathToFileURL/);
});
