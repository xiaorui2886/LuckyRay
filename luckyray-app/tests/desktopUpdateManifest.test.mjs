import test from 'node:test';
import assert from 'node:assert/strict';
import {buildManifest} from '../scripts/build-desktop-update-manifest.mjs';
const input={version:'2.0.0',installerName:'LuckyRay_2.0.0_x64-setup.exe',notes:'改进更新体验',publishedAt:'2026-10-10T00:00:00Z',
  signature:Buffer.from('untrusted comment: fixture\nFAKE\ntrusted comment: timestamp:1\tfile:LuckyRay_2.0.0_x64-setup.exe\nFAKE\n').toString('base64')};
test('manifest uses exact production repository, stable version and NSIS platform',()=>{
  const manifest=buildManifest(input);
  assert.deepEqual(Object.keys(manifest.platforms),['windows-x86_64-nsis']);
  assert.equal(manifest.platforms['windows-x86_64-nsis'].url,'https://github.com/xiaorui2886/LuckyRay/releases/download/v2.0.0/LuckyRay_2.0.0_x64-setup.exe');
});
test('rejects stale/missing signed version, unsafe filename, prerelease and invalid date',()=>{
  for(const override of [{version:'2.0.0-rc.1'},{version:'02.0.0'},{installerName:'../app.exe'},
    {signature:Buffer.from('trusted comment: timestamp:1\tfile:LuckyRay_1.0.0_x64-setup.exe\n').toString('base64')},
    {signature:Buffer.from('trusted comment: timestamp:1\tfile:app.exe\n').toString('base64')},
    {publishedAt:'yesterday'},{notes:'a'.repeat(32769)}])assert.throws(()=>buildManifest({...input,...override}));
});

test('trusted comment grammar matches native verification exactly',()=>{
  for(const trusted of ['timestamp:1 file:LuckyRay_2.0.0_x64-setup.exe','file:LuckyRay_2.0.0_x64-setup.exe\tfile:LuckyRay_2.0.0_x64-setup.exe']) {
    const signature=Buffer.from(`untrusted comment: fixture\nFAKE\ntrusted comment: ${trusted}\nFAKE\n`).toString('base64');
    assert.throws(()=>buildManifest({...input,signature}));
  }
});
