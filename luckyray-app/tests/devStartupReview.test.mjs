import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, unlink, stat, utimes, copyFile, link } from 'node:fs/promises';
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
  const stagedBrowser = join(root, 'src-tauri/binaries/luckyray-browser-host-x86_64-pc-windows-msvc.exe');
  const debugBrowser = join(root, 'src-tauri/target/debug/luckyray-browser-host.exe');
  assert.ok(stage.outputs.includes(stagedBrowser));
  assert.ok(stage.outputs.includes(debugBrowser));
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
  await copyFile(stagedBrowser, debugBrowser);
  assert.equal((await cached()).cache, 'hit', 'Tauri copying identical staged browser bytes stays reusable');
  await writeFile(stagedBrowser, 'tampered!!');
  assert.equal((await cached()).cache, 'qualified', 'modified staged browser bytes must invalidate the cache');
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
  assert.equal(preparations, 6);
  for (const input of ['config/dsh-host-compatibility.json', 'config/secondary-lsh-recovery-qualification.json']) {
    const path = join(root, input);
    assert.ok(stage.inputs.includes(path));
    const before = await stat(path);
    await writeFile(path, 'changed source');
    await utimes(path, before.atime, before.mtime);
    assert.equal((await cached()).cache, 'qualified', 'compiled recovery inputs must invalidate cached sidecars');
    assert.equal((await cached()).cache, 'hit');
  }
  assert.equal(preparations, 8);
});

test('detaching a generated sidecar preserves Cargo hardlink bytes when the top-level copy is replaced', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-sidecar-links-'));
  const backing = join(root, 'cargo-deps.exe'), target = join(root, 'debug-sidecar.exe');
  await writeFile(backing, 'synthetic Cargo output');
  await link(backing, target);
  assert.equal((await stat(target)).nlink, 2);
  const script = `
    $ErrorActionPreference='Stop'
    Import-Module "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1"
    $errors=$null; $tokens=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile($env:LR_TEST_SCRIPT,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'script-parse-failed' }
    $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Detach-DevSidecar'},$true)
    Invoke-Expression $fn.Extent.Text
    Detach-DevSidecar $env:LR_TEST_TARGET
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, LR_TEST_SCRIPT: join(process.cwd(), 'scripts/prepare-dev-sidecars.ps1'), LR_TEST_TARGET: target }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(target)).nlink, 1);
  assert.equal(await readFile(target, 'utf8'), 'synthetic Cargo output');
  await writeFile(target, 'Tauri replacement');
  assert.equal(await readFile(backing, 'utf8'), 'synthetic Cargo output');
});

test('sidecar validation accepts a real PE and rejects the MZ-only debug placeholder', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-sidecar-pe-'));
  const placeholder = join(root, 'placeholder.exe');
  await writeFile(placeholder, 'MZ\nLuckyRay debug sidecar placeholder. Run pnpm.cmd build:sidecars before bundling.\n');
  const script = `
    $ErrorActionPreference='Stop'
    $errors=$null; $tokens=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile($env:LR_TEST_SCRIPT,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'script-parse-failed' }
    $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-WindowsPe'},$true)
    Invoke-Expression $fn.Extent.Text
    Assert-WindowsPe $env:LR_TEST_REAL 'real'
    $rejected=$false
    try { Assert-WindowsPe $env:LR_TEST_PLACEHOLDER 'placeholder' } catch { $rejected=$true }
    if (-not $rejected) { throw 'placeholder-accepted' }
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, LR_TEST_SCRIPT: join(process.cwd(), 'scripts/prepare-native-host.ps1'), LR_TEST_REAL: process.execPath, LR_TEST_PLACEHOLDER: placeholder }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
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
