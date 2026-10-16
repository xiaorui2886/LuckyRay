import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {copyFile, mkdir, mkdtemp, rmdir, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, normalize} from 'node:path';
import {inventory, selectTarget} from '../src/transport.mjs';

test('Windows process discovery preserves the exact Chinese/Unicode install path and owner', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luckyray-mcp-inventory-'));
  const directory = join(root, '素材库 软件-é-😀');
  const executable = join(directory, 'luckyray-app.exe');
  await mkdir(directory);
  // A disposable Node process, not the real desktop: no profile, credentials,
  // library, network service other than its own ephemeral loopback listener.
  await copyFile(process.execPath, executable);
  const child = spawn(executable, ['-e', `
    const server = require('node:net').createServer();
    process.stdin.resume();
    process.stdin.on('end', () => server.close());
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(JSON.stringify({port: server.address().port}) + '\\n');
    });
  `], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.stdin.end();
    await exited;
    // Exact files/directories created above; no recursive deletion or real
    // desktop process termination is needed for this fixture.
    await unlink(executable);
    await rmdir(directory);
    await rmdir(root);
  });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) {
        try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); }
      }
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('disposable inventory fixture exited before readiness')));
  });
  const target = selectTarget({desktopExe: executable}, await inventory());
  assert.equal(target.pid, child.pid, 'must match the exact owned fixture, not another running desktop');
  assert.equal(normalize(target.exe).toLowerCase(), normalize(executable).toLowerCase());
  assert.ok(target.ports.includes(ready.port), 'listener must belong to the same process');
  assert.ok(Number.isFinite(Date.parse(target.created)), 'creation generation is retained');
});
