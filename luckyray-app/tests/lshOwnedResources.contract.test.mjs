import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const slot = 'lr-lsh/199-1';
const owner = 'luckyray-lsh-layout-v1.txt';
const ownerText = 'com.luckyray.desktop|lr-lsh|v1';
const makensis = process.env.NSIS_MAKENSIS || join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe');

test('installed resource mapping, dev publication and native selection use the same owned slot', async () => {
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.bundle.resources['dsh/'], `${slot}/deepseek-harness/`);
  assert.equal(config.bundle.resources['dsh-host/'], `${slot}/dsh-host/`);
  const native = await readFile(join(root, 'src-tauri/src/dsh_host/installation.rs'), 'utf8');
  assert.ok(native.includes(`BUNDLE_SLOT: &str = "${slot}"`));
  const dev = await readFile(join(root, 'scripts/prepare-dsh-dev-runtime.ps1'), 'utf8');
  assert.ok(dev.includes('src-tauri\\target\\debug\\lr-lsh\\199-1\\deepseek-harness'));
  const ownership = await readFile(join(root, 'src-tauri/src/desktop_app_update/ownership.rs'), 'utf8');
  const nodeSuffix = '\\' + slot.replaceAll('/', '\\') + '\\deepseek-harness\\node\\node.exe';
  assert.ok(ownership.includes('format!(r"{}' + nodeSuffix + '", install)'));
});

test('real NSIS slot preparation retains legacy and prior/partial slots and rejects unknown or redirected ownership', { skip: process.platform !== 'win32' }, async (t) => {
  try { await access(makensis); } catch { t.skip('requires the pinned Tauri NSIS toolchain'); return; }
  const temp = await mkdtemp(join(tmpdir(), 'lr-owned-nsis-'));
  const exe = join(temp, 'prepare-only.exe');
  const script = join(temp, 'prepare-only.nsi');
  const macroSource = await readFile(join(root, 'src-tauri/windows/lsh-owned-resources.nsh'), 'utf8');
  const fixtureMacro = join(temp, 'owned-fixture.nsh');
  // Preserve each original branch; record only its fixed abort message so a
  // failing silent synthetic installer can identify the actual rejecting step.
  const failures = [];
  const instrumented = macroSource.replace(/Abort "([^"]+)"/gu, (_, reason) => {
    const name = `LR_Fixture_Reject_${failures.length}`;
    failures.push(`Function ${name}\nFileOpen $9 "$INSTDIR\\rejected.txt" w\nFileWrite $9 "${reason}"\nFileClose $9\nAbort "${reason}"\nFunctionEnd\n`);
    return `Call ${name}`; // One instruction, preserving relative NSIS jumps.
  });
  await writeFile(fixtureMacro, instrumented + '\n' + failures.join('\n'));
  await writeFile(script, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nAutoCloseWindow true\n!include "LogicLib.nsh"\n!include "${fixtureMacro}"\nOutFile "${exe}"\nSection\n!insertmacro LR_LSH_PREPARE_SLOT\nFileOpen $0 "$INSTDIR\\prepared.txt" w\nFileWrite $0 "prepared"\nFileClose $0\nSetErrorLevel 0\nSectionEnd\n`, 'utf8');
  const compile = spawnSync(makensis, ['/V2', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const install = async (name) => {
    const path = join(temp, name);
    await mkdir(path, { recursive: true });
    // NSIS /D is its own last-argument parser: it explicitly requires a raw,
    // unquoted remainder, including spaces. No shell is involved.
    const run = spawnSync(exe, ['/S', `/D=${path}`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 20000 });
    assert.equal(run.error, undefined, run.error?.message);
    return { path, code: run.status, reason: await readFile(join(path, 'rejected.txt'), 'utf8').catch(() => '') };
  };
  const primary = join(temp, '中文 非默认路径');
  await mkdir(join(primary, 'deepseek-harness'), { recursive: true });
  await writeFile(join(primary, 'deepseek-harness/old-user-kept.txt'), 'old-layout');
  const first = await install('中文 非默认路径');
  assert.equal(first.code, 0, first.reason);
  assert.equal(await readFile(join(primary, owner), 'utf8'), `${ownerText}\r\n`);
  await writeFile(join(primary, slot, 'old-owned-file.txt'), 'old-owned');
  const second = await install('中文 非默认路径');
  assert.equal(second.code, 0, second.reason);
  assert.equal(await readFile(join(primary, 'lr-lsh/199-1.saved-1/old-owned-file.txt'), 'utf8'), 'old-owned');
  assert.deepEqual(await readdir(join(primary, slot)), []);
  await writeFile(join(primary, slot, 'interrupted-partial.txt'), 'partial-extraction');
  const third = await install('中文 非默认路径');
  assert.equal(third.code, 0, third.reason);
  assert.equal(await readFile(join(primary, 'lr-lsh/199-1.saved-2/interrupted-partial.txt'), 'utf8'), 'partial-extraction');
  assert.equal(await readFile(join(primary, 'deepseek-harness/old-user-kept.txt'), 'utf8'), 'old-layout');

  const unknown = join(temp, 'unknown');
  await mkdir(join(unknown, slot), { recursive: true });
  await writeFile(join(unknown, slot, 'untouched.txt'), 'keep');
  const rejected = await install('unknown');
  assert.notEqual(rejected.code, 0);
  assert.deepEqual(await readdir(join(unknown, slot)), ['untouched.txt']);
  await assert.rejects(access(join(unknown, 'prepared.txt')));
  await writeFile(join(unknown, owner), `${ownerText}\r\nextra`);
  assert.notEqual((await install('unknown')).code, 0);
  assert.equal(await readFile(join(unknown, slot, 'untouched.txt'), 'utf8'), 'keep');

  const redirected = join(temp, 'redirected');
  const outside = join(temp, 'unrelated-target');
  await mkdir(redirected); await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'unrelated');
  await writeFile(join(redirected, owner), `${ownerText}\r\n`);
  await symlink(outside, join(redirected, 'lr-lsh'), 'junction');
  assert.notEqual((await install('redirected')).code, 0);
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  await assert.rejects(access(join(redirected, 'prepared.txt')));
});
