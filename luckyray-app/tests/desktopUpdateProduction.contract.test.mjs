import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
test('approved formal updater trust is enabled, versioned and never a fixture key or feed', async () => {
  const trust = JSON.parse(await read('../src-tauri/src/desktop_app_update/trust.json'));
  assert.equal(trust.enabled, true);
  assert.equal(trust.identifier, 'com.luckyray.desktop');
  assert.equal(trust.manifestUrl, 'https://github.com/xiaorui2886/LuckyRay/releases/latest/download/latest.json');
  const decoded = Buffer.from(trust.publicKey, 'base64');
  assert.equal(decoded.toString('base64'), trust.publicKey);
  assert.equal(createHash('sha256').update(decoded).digest('hex'), 'f9ac827fb51ae4aae081ab8bba535095372ce98c6bdd3fc8387f5aa312481957');
  assert.match(decoded.toString(), /^untrusted comment: minisign public key: [A-F0-9]{16}\nRW[A-Za-z0-9+/=]+\n$/);
  assert.equal(Buffer.from(decoded.toString().trim().split('\n')[1], 'base64').length, 42);
});

test('formal trust does not bypass debug/NSIS restrictions or saved-exit admission', async () => {
  const source = await read('../src-tauri/src/desktop_app_update/windows.rs');
  assert.match(source, /production_nsis = !cfg!\(debug_assertions\)/);
  assert.match(source, /BundleType::Nsis/);
  assert.match(source, /trust\.enabled\s*&& production_nsis/);
  assert.match(source, /verify_package\(/);
  assert.match(source, /confirm_release/);
  const tauri = JSON.parse(await read('../src-tauri/tauri.conf.json'));
  assert.equal(tauri.identifier, 'com.luckyray.desktop');
  assert.ok(!('createUpdaterArtifacts' in tauri.bundle), 'sign only final audited installer offline');
});

test('offline signing never places a private key on argv or in build credentials', async () => {
  const generate = await read('../scripts/New-DesktopUpdateSigningKey.ps1');
  const sign = await read('../scripts/Sign-DesktopUpdate.ps1');
  assert.match(generate, /UserApprovedProductionTrust/);
  assert.match(generate, /ProtectedData\]::Protect/);
  assert.match(generate, /CurrentUser/);
  assert.match(generate, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(generate, /FileMode\]::CreateNew/);
  assert.doesNotMatch(generate, /signer generate[^\r\n]*--write-keys/);
  assert.match(sign, /EnvironmentVariables\['TAURI_SIGNING_PRIVATE_KEY'\]/);
  assert.doesNotMatch(sign, /Arguments\s*=.*--private-key/);
  assert.match(sign, /signature-already-exists/);
  assert.match(sign, /installer-changed-during-signing/);
});
