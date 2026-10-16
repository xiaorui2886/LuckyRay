import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, unlink, utimes, stat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { cachedStage, withPreparationLock } from '../scripts/dev-startup-cache.mjs';
import { checkoutIdentity, frontendStatus } from '../scripts/dev-frontend.mjs';

test('unchanged startup and frontend-only edits reuse qualified output; backend, environment and content edits invalidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-dev-cache-'));
  const input = join(root, 'backend.rs'), output = join(root, 'node.exe'), receiptPath = join(root, 'receipt.json');
  await writeFile(input, 'source1');
  let runs = 0;
  const options = { name: 'runtime', inputs: [input], outputs: [output], receiptPath, log() {}, run: async () => { runs++; await writeFile(output, 'signed-by-original-qualification'); } };
  assert.equal((await cachedStage(options)).cache, 'qualified');
  const before = await stat(output);
  await writeFile(join(root, 'frontend.tsx'), 'HMR edit');
  assert.equal((await cachedStage(options)).cache, 'hit');
  assert.equal((await stat(output)).mtimeMs, before.mtimeMs);
  assert.equal(runs, 1);
  await writeFile(input, 'source2');
  assert.equal((await cachedStage(options)).cache, 'qualified');
  assert.equal((await cachedStage({ ...options, context: { origins: 'changed' } })).cache, 'qualified');
  await cachedStage(options);
  const meta = await stat(output);
  await writeFile(output, 'tamper-by-original-qualification');
  await utimes(output, meta.atime, meta.mtime);
  assert.equal((await cachedStage(options)).cache, 'qualified');
  await unlink(output);
  assert.equal((await cachedStage(options)).cache, 'qualified');
});

test('failed or concurrently edited qualification leaves no reusable receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-dev-failure-'));
  const input = join(root, 'authority'), output = join(root, 'runtime'), receiptPath = join(root, 'receipt');
  await writeFile(input, 'before');
  const base = { name: 'runtime', inputs: [input], outputs: [output], receiptPath, log() {} };
  await assert.rejects(cachedStage({ ...base, run: async () => { throw Error('qualification-refused'); } }), /qualification-refused/);
  await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
  await assert.rejects(cachedStage({ ...base, run: async () => { await writeFile(input, 'during'); await writeFile(output, 'result'); } }), /input-changed/);
  await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
});

test('concurrent preparation is refused and exception releases the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-dev-lock-'));
  const path = join(root, 'preparation.lock');
  await assert.rejects(withPreparationLock(path, async () => {
    await assert.rejects(withPreparationLock(path, async () => assert.fail('second writer ran')), /dev-preparation-busy/);
    throw Error('stage failed');
  }), /stage failed/);
  assert.equal(await withPreparationLock(path, async () => 'released'), 'released');
});

test('frontend reuse requires exact checkout and rejects an unrelated healthy listener', async t => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-frontend-'));
  let identity = 'other-checkout';
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ checkout: identity })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal(await frontendStatus(root, port), 'occupied');
  identity = checkoutIdentity(root);
  assert.equal(await frontendStatus(root, port), 'ready');
  await new Promise(resolve => server.close(resolve));
  assert.equal(await frontendStatus(root, port), 'free');
});

test('bare Tauri hook refuses even with a leftover development environment marker', () => {
  const result = spawnSync(process.execPath, ['scripts/dev-frontend.mjs', '--reject-bare'], { encoding: 'utf8', env: { ...process.env, LUCKYRAY_APP_PROFILE: 'development' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pnpm.cmd dev:desktop/);
});

test('physical profile guard accepts real paths and refuses redirected file handles', { skip: process.platform !== 'win32' }, async () => {
  const fixtures = join(process.cwd(), 'src-tauri/target/.dev-profile-guard-tests');
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, 'profile-'));
  const actual = join(root, 'actual'), alias = join(root, 'redirected');
  await mkdir(actual);
  await writeFile(join(actual, 'luckyray.db'), 'read-only fixture');
  const run = profile => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/assert-dev-physical-profile.ps1', '-ProfileRoot', profile], { encoding: 'utf8', windowsHide: true });
  const direct = run(actual);
  assert.equal(direct.status, 0, direct.stderr);
  await symlink(actual, alias, 'junction');
  const redirected = run(alias);
  assert.notEqual(redirected.status, 0);
  assert.match(redirected.stderr, /luckyray-development-profile-redirected/);
  assert.equal(await readFile(join(actual, 'luckyray.db'), 'utf8'), 'read-only fixture');
});
