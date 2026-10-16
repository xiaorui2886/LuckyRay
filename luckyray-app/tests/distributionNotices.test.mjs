import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const root=new URL('../third-party-notices/',import.meta.url);
const hash=b=>createHash('sha256').update(b).digest('hex');
test('bundled Deno2.9.4 exact-version notices and native closure are complete and unmodified',async()=>{
  const base=new URL('deno-2.9.4/',root);
  const index=JSON.parse(await readFile(new URL('INDEX.json',base),'utf8'));
  const native=JSON.parse(await readFile(new URL('NATIVE-INDEX.json',base),'utf8'));
  assert.equal(index.version,'2.9.4');
  assert.equal(index.sourceCommit,'14eea3160ae5834476aa3b9d317b8d41d991b982');
  assert.equal(index.packages.length,906);
  assert.deepEqual(index.gaps,[]);
  assert.equal(native.rustyV8,'150.2.0');
  assert.equal(native.v8Revision,'ac1e23989121713ca642f6650b34deff7b686896');
  assert.equal(native.rustGnScope.vendorCount,46);
  const notices=[...index.packages.flatMap(p=>{assert.ok(p.notices.length);return p.notices;}),...native.files];
  for(const notice of notices){
    assert.equal(notice.gap,undefined);
    assert.match(notice.sha256,/^[a-f0-9]{64}$/);
    const body=await readFile(new URL(`bodies/${notice.sha256}.txt`,base));
    assert.equal(body.length,notice.bytes);
    assert.equal(hash(body),notice.sha256);
  }
});
test('SeaHash notice is original same-version license-only omission correction',async()=>{
  const base=new URL('seahash-4.1.0/',root);
  const proof=JSON.parse(await readFile(new URL('PROVENANCE.json',base),'utf8'));
  assert.equal(proof.version,'4.1.0');
  assert.deepEqual(proof.proof.parents,['94b632aeac099031c373599313d5b5f0acbbaec0']);
  assert.deepEqual(proof.proof.files,[{filename:'LICENSE',status:'added',additions:23,deletions:0}]);
  assert.equal(hash(await readFile(new URL('LICENSE',base))),proof.licenseSha256);
  assert.match(await readFile(new URL('Cargo.toml',base),'utf8'),/^version\s*=\s*"4\.1\.0"/m);
});
test('formal resources include notices while projection is wired before the original authority gates',async()=>{
  const config=JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
  assert.equal(config.bundle.resources['../third-party-notices/'],'third-party-notices/');
  const gate=await readFile(new URL('../scripts/assert-package-readiness.ps1',import.meta.url),'utf8');
  assert.match(gate,/'\.\.\/third-party-notices\/' = 'third-party-notices\/'/);
  const prepare=await readFile(new URL('../scripts/prepare-dsh-runtime.ps1',import.meta.url),'utf8');
  assert.ok(prepare.indexOf("'project-distribution-metadata'")<prepare.indexOf('$partialAuthority = Invoke-DshStageAuthorityGates'));
  assert.match(prepare,/dsh-distribution-projection-failed/);
});
