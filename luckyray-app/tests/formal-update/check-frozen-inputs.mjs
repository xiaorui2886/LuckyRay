import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const spec=JSON.parse(readFileSync(new URL('./frozen-inputs.json',import.meta.url),'utf8'));
assert.equal(spec.schemaVersion,1);
assert.equal(spec.distributionReview.approved,true,'distribution review must finish before a runner changes trust or installs');
for(const [name,version]of [['a','1.9.16'],['b','1.9.17']]){
 const entry=spec[name];assert.equal(entry.version,version);
 assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.match(entry.installedExeSha256,/^[a-f0-9]{64}$/);
 assert.match(entry.publicSourceCommit,/^[a-f0-9]{40}$/);
 assert.ok(Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&entry.bytes<1024*1024*1024);
 assert.equal(entry.testInputUrl,`https://github.com/xiaorui2886/LuckyRay/releases/download/v${version}/LuckyRay_${version}_x64-setup.exe`);
 assert.equal(entry.manifest.version,version);
 const artifact=entry.manifest.platforms['windows-x86_64-nsis'];
 assert.deepEqual(Object.keys(entry.manifest.platforms),['windows-x86_64-nsis']);
 assert.equal(artifact.url,entry.testInputUrl);assert.equal(artifact.signature,entry.signature);
 assert.ok(typeof entry.signature==='string'&&entry.signature.length>100);
}
console.log(JSON.stringify({status:'PASS_FIXED_REVIEWED_PUBLIC_INPUTS',versions:[spec.a.version,spec.b.version],noSystemChanges:true}));
