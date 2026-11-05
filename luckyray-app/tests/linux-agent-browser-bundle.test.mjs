import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bundleDigest, checkAgentBrowserBundle } from '../scripts/linux/check-agent-browser-bundle.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const realPin = JSON.parse(readFileSync(join(appRoot, 'tools/linux-agent-browser/pin.json'), 'utf8'));
const shellPy = join(appRoot, 'tools/linux-agent-browser/shell.py');
const sha = text => createHash('sha256').update(text).digest('hex');

function syntheticBundle() {
  const dir = mkdtempSync(join(tmpdir(), 't55-bundle-'));
  const engine = join(dir, 'chrome-headless-shell-linux64');
  mkdirSync(engine);
  writeFileSync(join(engine, 'chrome-headless-shell'), 'synthetic engine');
  chmodSync(join(engine, 'chrome-headless-shell'), 0o755);
  for (const name of ['LICENSE.headless_shell', 'ABOUT']) {
    writeFileSync(join(engine, name), `synthetic ${name}`);
    chmodSync(join(engine, name), 0o644);
  }
  const { digest, files } = bundleDigest(dir);
  const pin = { ...realPin, bundleSha256: digest, bundleFileCount: files, executableSha256: sha('synthetic engine') };
  return { dir, engine, pin };
}

test('the gate accepts exactly the pinned bundle and agrees with shell.py bundle-digest', () => {
  const { dir, pin } = syntheticBundle();
  try {
    assert.equal(pin.bundleFileCount, 3);
    assert.deepEqual(checkAgentBrowserBundle({ appRoot, pin, bundleDir: dir }), []);
    const python = execFileSync('python3', [shellPy, 'bundle-digest', dir]).toString().trim();
    assert.equal(python, `bundle-sha256=${pin.bundleSha256} files=3`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the gate refuses a missing, mutated, extended, symlinked or unlicensed bundle', () => {
  const missing = checkAgentBrowserBundle({ appRoot, pin: realPin, bundleDir: join(tmpdir(), 't55-no-such-bundle') });
  assert.ok(missing.includes('agent-browser bundle missing: stage it with shell.py stage'));
  const cases = {
    mutated: ({ engine }) => writeFileSync(join(engine, 'chrome-headless-shell'), 'tampered engine'),
    extra: ({ engine }) => { writeFileSync(join(engine, 'extra.so'), 'x'); chmodSync(join(engine, 'extra.so'), 0o644); },
    mode: ({ engine }) => chmodSync(join(engine, 'ABOUT'), 0o664),
    symlink: ({ engine }) => symlinkSync('/etc/hostname', join(engine, 'link')),
    licence: ({ engine }) => rmSync(join(engine, 'ABOUT')),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const bundle = syntheticBundle();
    try {
      mutate(bundle);
      const problems = checkAgentBrowserBundle({ appRoot, pin: bundle.pin, bundleDir: bundle.dir });
      assert.ok(problems.length > 0, name);
    } finally { rmSync(bundle.dir, { recursive: true, force: true }); }
  }
  const { dir, pin } = syntheticBundle();
  try {
    assert.deepEqual(checkAgentBrowserBundle({ appRoot, pin: { ...pin, bundleSha256: 'f'.repeat(64) }, bundleDir: dir }),
      ['agent-browser bundle digest does not match pin.json']);
    assert.deepEqual(checkAgentBrowserBundle({ appRoot, pin: { ...pin, bundleSha256: undefined }, bundleDir: dir }),
      ['pin.json is incomplete']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the deb AppArmor profile grants only userns to the installed engine path', () => {
  const profile = readFileSync(join(appRoot, 'src-tauri/linux/apparmor/luckyray-agent-browser'), 'utf8');
  assert.match(profile, /^profile luckyray-agent-browser \/usr\/lib\/LuckyRay\/agent-browser\/chrome-headless-shell-linux64\/chrome-headless-shell flags=\(unconfined\) \{$/m);
  const rules = profile.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(rules, /no-sandbox|apparmor_restrict_unprivileged_userns=0|\/home|\/tmp|\*\*/);
  const postinst = readFileSync(join(appRoot, 'src-tauri/linux/deb/postinst'), 'utf8')
    .split('\n').filter(line => !line.startsWith('#')).join('\n');
  assert.match(postinst, /\/etc\/apparmor\.d\/abi\/4\.0/);
  assert.match(postinst, /apparmor_parser -r "\/etc\/apparmor\.d\/\$profile"/);
  assert.doesNotMatch(postinst, /sysctl|no-sandbox|chmod [0-7]*[4-7][0-7]{3}/);
  assert.match(readFileSync(join(appRoot, 'src-tauri/linux/deb/postrm'), 'utf8'), /apparmor_parser -R/);
  // Copy elsewhere and point the profile at a user-writable path: refused.
  const copy = mkdtempSync(join(tmpdir(), 't55-app-'));
  const { dir, pin } = syntheticBundle();
  try {
    for (const part of ['src-tauri/tauri.linux.conf.json', 'src-tauri/linux', 'src-tauri/src/browser_host_poc/mod.rs']) {
      cpSync(join(appRoot, part), join(copy, part), { recursive: true });
    }
    assert.deepEqual(checkAgentBrowserBundle({ appRoot: copy, pin, bundleDir: dir }), []);
    const path = join(copy, 'src-tauri/linux/apparmor/luckyray-agent-browser');
    writeFileSync(path, readFileSync(path, 'utf8').replace('/usr/lib/LuckyRay/', '/tmp/LuckyRay/'));
    assert.deepEqual(checkAgentBrowserBundle({ appRoot: copy, pin, bundleDir: dir }),
      ['AppArmor profile is not exactly the userns grant for the installed engine path']);
  } finally {
    rmSync(copy, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
