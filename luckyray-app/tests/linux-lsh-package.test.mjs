import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkLinuxLshPackage, licenseResources } from '../scripts/linux/check-lsh-package.mjs';

const app = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(app, 'dsh-host/linux-x64/runtime-manifest.json'), 'utf8'));
const sealed = async () => ({ ...manifest, notices: 'n', packages: [] });

// Synthetic app root: the tracked records, host files and config, plus an empty dsh dir.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lsh-package-'));
  for (const path of ['dsh-host/linux-x64', 'src-tauri/dsh-host']) cpSync(join(app, path), join(root, path), { recursive: true });
  mkdirSync(join(root, 'src-tauri/src'), { recursive: true });
  for (const path of ['src-tauri/src/dsh_host.rs', 'src-tauri/tauri.linux.conf.json']) cpSync(join(app, path), join(root, path));
  return root;
}

test('sealed runtime, pinned host files and bundled records pass', async () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'src-tauri/dsh'));
    assert.deepEqual(await checkLinuxLshPackage({ appRoot: root, audit: sealed }), []);
    assert.equal(Object.keys(licenseResources).length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing runtime is refused', async () => {
  const root = fixture();
  try {
    assert.deepEqual(await checkLinuxLshPackage({ appRoot: root, audit: sealed }), ['sealed LSH runtime missing at src-tauri/dsh']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a runtime differing from the manifest is refused', async () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'src-tauri/dsh'));
    const changed = async () => ({ ...manifest, fileCount: manifest.fileCount + 1, notices: '', packages: [] });
    assert.match((await checkLinuxLshPackage({ appRoot: root, audit: changed })).join(), /does not match runtime-manifest/);
    const throwing = async () => { throw new Error('linux-lsh-closure-x'); };
    assert.match((await checkLinuxLshPackage({ appRoot: root, audit: throwing })).join(), /refused \(linux-lsh-closure-x\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changed records, host files or record mappings are refused', async () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'src-tauri/dsh'));
    writeFileSync(join(root, 'dsh-host/linux-x64/THIRD-PARTY-NOTICES.txt'), 'x', { flag: 'a' });
    writeFileSync(join(root, 'src-tauri/dsh-host/luckyray-dsh-host.mjs'), '\r\n', { flag: 'a' });
    const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.linux.conf.json'), 'utf8'));
    delete config.bundle.resources['../dsh-host/linux-x64/dependency-audit.json'];
    writeFileSync(join(root, 'src-tauri/tauri.linux.conf.json'), JSON.stringify(config));
    const problems = (await checkLinuxLshPackage({ appRoot: root, audit: sealed })).join('\n');
    assert.match(problems, /THIRD-PARTY-NOTICES.txt missing or changed/);
    assert.match(problems, /luckyray-dsh-host.mjs does not match HOST_SCRIPT_SHA256/);
    assert.match(problems, /dependency-audit.json not bundled/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
