import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { checkoutIdentity } from '../scripts/dev-frontend.mjs';

test('explicit development port keeps the window URL and readiness hook aligned without changing profile', { skip: process.platform !== 'win32' }, () => {
  const run = args => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    'scripts/start-luckyray-dev.ps1', '-PlanOnly', ...args], { encoding: 'utf8', windowsHide: true });
  const result = run(['-FrontendPort', '14320', '-LshBackgroundPreload']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.identifier, 'com.luckyray.desktop.dev');
  assert.equal(plan.frontendPort, 14320);
  assert.equal(plan.frontendBuild.devUrl, 'http://127.0.0.1:14320');
  assert.match(plan.frontendBuild.beforeDevCommand, /assert-runtime-profile.ps1/);
  assert.match(plan.frontendBuild.beforeDevCommand, /dev-frontend.mjs --port 14320$/);
  assert.ok(plan.command.includes('lsh-background-surface-preload'));
  assert.equal(JSON.parse(run([]).stdout).frontendPort, 1420);
  for (const port of ['0', '65536', 'bad']) assert.notEqual(run(['-FrontendPort', port]).status, 0);
});

test('CLI readiness probes the explicit port and still verifies checkout identity', async t => {
  let identity = checkoutIdentity(process.cwd());
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ checkout: identity })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const probe = () => new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/dev-frontend.mjs', '--status', '--port', String(port)], { windowsHide: true });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    child.on('close', code => resolve({ code, output }));
  });
  assert.deepEqual(await probe(), { code: 0, output: '[dev] frontend: ready\n' });
  identity = 'another-checkout';
  assert.equal((await probe()).code, 4);
});
