import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFrozenInputs,TEST_RELEASE} from './check-frozen-inputs.mjs';
const entry=(version,purpose)=>({version,purpose,bytes:123,sha256:'a'.repeat(64),installedExeSha256:'b'.repeat(64),publicSourceCommit:'c'.repeat(40),signature:'synthetic-shape-only-'.repeat(10),testInputUrl:`https://github.com/xiaorui2886/LuckyRay/releases/download/${TEST_RELEASE}/LuckyRay_${version}_x64-setup.exe`,manifest:{version,platforms:{'windows-x86_64-nsis':{url:`https://github.com/xiaorui2886/LuckyRay/releases/download/v${version}/LuckyRay_${version}_x64-setup.exe`,signature:'synthetic-shape-only-'.repeat(10)}}}});
const fixture=()=>({schemaVersion:2,bootstrapIsPublishedStable:false,testRelease:TEST_RELEASE,distributionReview:{approved:true},a:entry('1.9.7','patched-test-bootstrap'),b:entry('1.9.8','release-candidate')});
test('isolated transport and strict production URL remain separate',()=>{
 const s=fixture();assert.equal(validateFrozenInputs(s).status,'PASS_FIXED_REVIEWED_PUBLIC_INPUTS');
 assert.notEqual(s.b.testInputUrl,s.b.manifest.platforms['windows-x86_64-nsis'].url);
});
test('unreviewed or falsely labelled bootstrap never starts a runner',()=>{
 for(const modify of [s=>s.distributionReview.approved=false,s=>s.bootstrapIsPublishedStable=true,s=>s.a.purpose='release-candidate']){
  const s=fixture();modify(s);assert.throws(()=>validateFrozenInputs(s));
 }
});
test('test location is an exact allowlist, not an arbitrary download escape',()=>{
 for(const bad of ['https://example.com/test.exe',fixture().b.testInputUrl+'?token=secret',fixture().b.testInputUrl.replace('LuckyRay/releases','other/releases'),fixture().b.testInputUrl.replace(TEST_RELEASE,'v1.9.8')]){
  const s=fixture();s.b.testInputUrl=bad;assert.throws(()=>validateFrozenInputs(s));
 }
});
test('production path, version, platform and matching signature remain strict',()=>{
 for(const modify of [s=>s.b.version='1.9.8-rc.1',s=>s.b.manifest.platforms['windows-x86_64-nsis'].url=s.b.testInputUrl,s=>s.b.manifest.platforms['windows-x86_64-nsis'].signature='different',s=>s.b.manifest.platforms.extra={}]){
  const s=fixture();modify(s);assert.throws(()=>validateFrozenInputs(s));
 }
});
