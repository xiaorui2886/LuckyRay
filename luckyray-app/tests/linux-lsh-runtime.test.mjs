import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { safeRelative, closureDigest, auditLinuxClosure, sha256 } from '../scripts/linux/lsh-closure.mjs';
import { readRegular } from '../scripts/linux/stage-lsh-resources.mjs';
import { frozenLinuxInputs } from '../scripts/linux/acquire-lsh-inputs.mjs';
import { minimalDshEnvironment, runtimeNodeExecutable } from '../src-tauri/dsh-host/luckyray-dsh-host.mjs';

test('Linux selection resolves the exact frozen inputs and required native modules', async () => {
  const { selected } = await frozenLinuxInputs();
  assert.equal(selected.length, 564);
  for (const name of ['@deepseek-ai/dsh', '@koromix/koffi-linux-x64', '@img/sharp-linux-x64',
    '@img/sharp-libvips-linux-x64', 'node-pty', 'node-addon-require-builtin-linux-x64-gnu']) {
    assert.ok(selected.some(pkg => pkg.name === name), name);
  }
  assert.equal(selected.find(pkg => pkg.name === '@deepseek-ai/dsh').version, '0.2.1-rc.3');
  // The upstream dsh-win32-process JavaScript utility is a mandatory package;
  // platform-specific Windows native binaries are not part of this closure.
  assert.equal(selected.some(pkg => /(?:-win32-(?:x64|arm64|ia32)|experimental-ptc-runtime-python)/u.test(pkg.name)), false);
});

test('closure paths and identities refuse escapes, ambiguity and permission changes', () => {
  for (const path of ['/escape', '../escape', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\0b', 'e\u0301']) {
    assert.throws(() => safeRelative(path), /linux-lsh-path-invalid/u);
  }
  const files = [{ path: 'node/node', mode: 0o755, bytes: 3, sha256: sha256(Buffer.from('elf')) }];
  const good = closureDigest(files);
  assert.notEqual(closureDigest([{ ...files[0], mode: 0o644 }]), good);
  assert.notEqual(closureDigest([{ ...files[0], bytes: 4 }]), good);
  assert.throws(() => closureDigest([...files, ...files]), /manifest-entry-invalid/u);
});

test('Linux staging refuses symlinks, hardlinks, writable sources and special files', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-lsh-source-'));
  try {
    const regular = join(root, 'file');
    await writeFile(regular, 'synthetic', { mode: 0o644 });
    assert.equal((await readRegular(regular)).toString(), 'synthetic');
    const alias = join(root, 'alias');
    await symlink(regular, alias);
    await assert.rejects(readRegular(alias), { code: 'ELOOP' });
    await assert.rejects(auditLinuxClosure(root), /link-in-runtime/u);
    await rm(alias);
    await link(regular, alias);
    await assert.rejects(readRegular(regular), /source-file-invalid/u);
    await assert.rejects(auditLinuxClosure(root), /file-invalid/u);
    await rm(alias);
    await chmod(regular, 0o664);
    await assert.rejects(readRegular(regular), /source-file-invalid/u);
    await chmod(regular, 0o644);
    const real = join(root, 'real');
    await mkdir(real);
    await writeFile(join(real, 'child'), 'synthetic');
    await symlink(real, join(root, 'linked-parent'));
    await assert.rejects(readRegular(join(root, 'linked-parent/child')), /source-parent-invalid/u);
    await assert.rejects(readRegular('/dev/null'), /source-file-invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux host uses its actual Node executable and a private explicit environment', { skip: process.platform !== 'linux' }, () => {
  const home = '/synthetic/private-profile';
  assert.equal(runtimeNodeExecutable('/synthetic/runtime'), '/synthetic/runtime/node/node');
  const env = minimalDshEnvironment(home, { DEEPSEEK_API_KEY: 'synthetic-explicit-key', NODE_OPTIONS: '--unsafe', LD_PRELOAD: '/foreign' });
  assert.equal(env.PATH, [dirname(process.execPath), '/usr/bin', '/bin'].join(':'));
  assert.equal(env.HOME, home);
  assert.equal(env.XDG_CONFIG_HOME, join(home, '.config'));
  assert.equal(env.TMPDIR, join(home, '.tmp'));
  assert.equal(env.DEEPSEEK_API_KEY, 'synthetic-explicit-key');
  for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'HTTP_PROXY', 'SystemRoot', 'USERPROFILE']) assert.equal(env[key], undefined);
});
