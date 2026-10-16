import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// This is only the download location for immutable test inputs. The product
// continues to admit the canonical official version URL and production key.
export const TEST_RELEASE='test-updater-1.9.8-20261017';
export function validateFrozenInputs(spec) {
  assert.equal(spec.schemaVersion,2);
  assert.equal(spec.distributionReview.approved,true,'distribution review must finish before a runner changes trust or installs');
  assert.equal(spec.bootstrapIsPublishedStable,false,'the patched bootstrap is NOT the old shipped release');
  assert.equal(spec.testRelease,TEST_RELEASE);
  for(const [name,version]of [['a','1.9.7'],['b','1.9.8']]){
    const entry=spec[name];assert.equal(entry.version,version);
    assert.equal(entry.purpose,name==='a'?'patched-test-bootstrap':'release-candidate');
    assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.match(entry.installedExeSha256,/^[a-f0-9]{64}$/);
    assert.match(entry.publicSourceCommit,/^[a-f0-9]{40}$/);
    assert.ok(Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&entry.bytes<1024*1024*1024);
    assert.equal(entry.testInputUrl,`https://github.com/xiaorui2886/LuckyRay/releases/download/${TEST_RELEASE}/LuckyRay_${version}_x64-setup.exe`);
    assert.equal(entry.manifest.version,version);
    const artifact=entry.manifest.platforms['windows-x86_64-nsis'];
    assert.deepEqual(Object.keys(entry.manifest.platforms),['windows-x86_64-nsis']);
    assert.equal(artifact.url,`https://github.com/xiaorui2886/LuckyRay/releases/download/v${version}/LuckyRay_${version}_x64-setup.exe`);
    assert.equal(artifact.signature,entry.signature);
    assert.ok(typeof entry.signature==='string'&&entry.signature.length>100);
  }
  return {status:'PASS_FIXED_REVIEWED_PUBLIC_INPUTS',versions:[spec.a.version,spec.b.version],noSystemChanges:true,bootstrapIsPublishedStable:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const spec=JSON.parse(readFileSync(new URL('./frozen-inputs.json',import.meta.url),'utf8'));
  console.log(JSON.stringify(validateFrozenInputs(spec)));
}
