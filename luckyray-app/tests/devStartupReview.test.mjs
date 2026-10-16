import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, unlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getStartupStages } from '../scripts/prepare-dev-startup.mjs';
import { cachedStage } from '../scripts/dev-startup-cache.mjs';
import { classifyFrontendBindError, frontendDiagnostic } from '../scripts/dev-frontend.mjs';

test('Windows PowerShell startup decodes the UTF-8 production extension manifest without opening a profile', { skip: process.platform !== 'win32' }, async () => {
  const manifest = JSON.parse(await readFile('browser-extension-prototype/manifest.json', 'utf8'));
  assert.match(manifest.commands['capture-page'].description, /[\u4e00-\u9fff]/, 'exercise the real non-ASCII manifest');
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
  const alphabet = 'abcdefghijklmnop';
  const extensionId = [...digest.subarray(0, 16)].map(byte => alphabet[byte >> 4] + alphabet[byte & 15]).join('');
  const environment = { ...process.env };
  delete environment.LUCKYRAY_DEV_EXTENSION_ORIGINS; // Do not skip the production manifest read with an override.
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    'scripts/start-luckyray-dev.ps1', '-PlanOnly'], { env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.identifier, 'com.luckyray.desktop.dev');
  assert.equal(plan.profile, 'development');
  assert.deepEqual(plan.extensionOrigins, ['chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid',
    `chrome-extension://${extensionId}`].filter((origin, index, all) => all.indexOf(origin) === index).sort());
});

test('production sidecars configuration fingerprints release contract changes, deletion and creation without requiring it in dev', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-sidecars-config-'));
  await mkdir(join(root, 'dsh-host'));
  // Import the exact production stage, including its input/output projection.
  // Only its costly compiler/preparation command is replaced with a fixture.
  const stage = (await getStartupStages(root)).find(stage => stage.name === 'sidecars');
  const origin = join(root, 'src-tauri/binaries/luckyray-sidecars.origin.identity.json');
  const debugCli = join(root, 'src-tauri/target/debug/luckyray-cli.exe');
  assert.ok(stage.optionalOutputs.includes(origin));
  assert.ok(stage.outputs.includes(debugCli));
  for (const path of stage.inputs) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'source fixture'); }
  let preparations = 0;
  const run = async () => {
    preparations++;
    for (const output of stage.outputs) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, 'dev output'); }
    // Production debug preparation never creates the Release-only contract.
  };
  const cached = () => cachedStage({ ...stage, run, log() {} });
  assert.equal((await cached()).cache, 'qualified');
  assert.equal((await cached()).cache, 'hit', 'clean dev must not perpetually rebuild a missing release file');
  await writeFile(origin, 'release-one');
  assert.equal((await cached()).cache, 'qualified');
  assert.equal((await cached()).cache, 'hit');
  const before = await stat(origin);
  await writeFile(origin, 'release-two');
  await utimes(origin, before.atime, before.mtime);
  assert.equal((await cached()).cache, 'qualified', 'same-size, restored-time contract change must invalidate the actual stage');
  await unlink(origin);
  assert.equal((await cached()).cache, 'qualified', 'contract deletion must invalidate the actual stage');
  assert.equal((await cached()).cache, 'hit', 'absence is stable after one requalification');
  await unlink(debugCli);
  assert.equal((await cached()).cache, 'qualified', 'the CLI executable consumed beside the app is required');
  assert.equal(preparations, 5);
});

test('frontend error classification preserves occupied, OS denial and unknown failures', () => {
  for (const [code, status, exitCode] of [['EADDRINUSE','occupied',4],['EACCES','denied',5],['EADDRNOTAVAIL','unavailable',6]]) {
    assert.equal(classifyFrontendBindError({ code }), status);
    assert.equal(frontendDiagnostic(status).exitCode, exitCode);
  }
  assert.match(frontendDiagnostic('occupied').message, /do not stop an unidentified process/);
  assert.match(frontendDiagnostic('denied').message, /does not establish.*administrator/);
});

test('production PowerShell caller distinguishes frontend exit codes without launching anything', { skip: process.platform !== 'win32' }, () => {
  const run = status => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/assert-dev-frontend-status.ps1', '-Status', String(status)], { encoding: 'utf8', windowsHide: true });
  assert.equal(run(0).status, 0);
  assert.equal(run(3).status, 0);
  const occupied = run(4), denied = run(5), unknown = run(6);
  assert.notEqual(occupied.status, 0);
  assert.notEqual(denied.status, 0);
  assert.notEqual(unknown.status, 0);
  assert.match(occupied.stderr, /frontend-occupied/);
  assert.match(denied.stderr, /frontend-bind-denied/);
  assert.match(unknown.stderr, /frontend-probe-failed/);
});
