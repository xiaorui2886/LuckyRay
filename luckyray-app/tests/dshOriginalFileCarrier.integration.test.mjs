import assert from 'node:assert/strict';
import test from 'node:test';
import { open, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openSyntheticCarrier } from './fixtures/dshAuthenticatedSyntheticCarrier.mjs';
import { createOpenIntentSlot, resolveOpenIntentFileResource } from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/index.mjs';

const id = n => `intent-${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
const resourcePath = (intent,index) => `/_luckyray/open-intent-resource/${intent.intentId}/${index}`;
test('official 0.2.1 carrier serves exact saved MD/document/video/image bytes and revokes them after ACK', {timeout:30000}, async () => {
  const c = await openSyntheticCarrier();
  try {
    const fixtures=[['已保存 笔记.md',Buffer.from('# 已保存 Markdown\n原文🙂\n'),'file-attachment','application/octet-stream'],
      ['文档.pdf',Buffer.from('%PDF-1.7\nsynthetic\n'),'file-attachment','application/octet-stream'],
      ['视频.mp4',Buffer.from([0,0,0,20,102,116,121,112,109,112,52,50,255]),'file-attachment','application/octet-stream'],
      ['图像.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),'image-attachment','image/png']];
    const resources=[];
    for(let i=0;i<fixtures.length;i++){const [name,bytes,delivery]=fixtures[i],path=join(c.root,name);await writeFile(path,bytes);resources.push({kind:'material',assetId:`synthetic-${i}`,libraryId:'synthetic-owned-library',canonicalPath:await realpath(path),delivery});}
    const intent={intentId:id(101),source:'notes',text:'',localResources:resources};await c.stage(intent);
    const got=await c.raw('/_luckyray/open-intent');assert.equal(got.status,200);assert.deepEqual(JSON.parse(got.bytes),intent);
    for(let i=0;i<fixtures.length;i++){const r=await c.raw(resourcePath(intent,i));assert.equal(r.status,200);assert.deepEqual(r.bytes,fixtures[i][1]);assert.equal(r.headers['content-type'],fixtures[i][3]);assert.equal(Number(r.headers['content-length']),fixtures[i][1].length);}
    assert.equal((await c.raw(resourcePath(intent,0),{headers:{cookie:''}})).status,403);
    assert.equal((await c.raw(resourcePath(intent,0),{headers:{origin:'https://invalid.example'}})).status,403);
    assert.equal((await c.raw(resourcePath(intent,9))).status,403);
    assert.equal((await c.raw(resourcePath({...intent,intentId:id(999)},0))).status,403);
    assert.equal((await c.raw('/_luckyray/open-intent-resource?path='+encodeURIComponent(resources[0].canonicalPath))).status,403);
    const ack=await c.raw('/_luckyray/open-intent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intentId:intent.intentId})});assert.equal(ack.status,204);
    assert.equal((await c.raw('/_luckyray/open-intent')).status,204);
    assert.equal((await c.owner.intentStatus(intent.intentId)).payload,'applied');
    for(let i=0;i<fixtures.length;i++)assert.equal((await c.raw(resourcePath(intent,i))).status,403);
    await c.stage(intent);assert.equal((await c.raw('/_luckyray/open-intent')).status,204,'same consumed intent cannot be restaged');
    const later={...intent,intentId:id(102)};await c.stage(later);await c.owner.close();await c.open();
    assert.equal((await c.raw('/_luckyray/open-intent')).status,204);assert.equal((await c.raw(resourcePath(later,0))).status,403,'new generation revokes previous staged resources');
  } finally {await c.dispose();}
});

test('original-file resolver enforces exact canonical resource and inclusive 200 MiB cap',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const root=await mkdtemp(join(tmpdir(),'dsh021-size-'));
  try{
    const file=join(root,'large.bin');const handle=await open(file,'w');await handle.truncate(200*1024*1024);await handle.close();
    const slot=createOpenIntentSlot();slot.bind(1);const intent={intentId:id(103),source:'materials',text:'',localResources:[{kind:'material',assetId:'size-test',canonicalPath:await realpath(file),delivery:'file-attachment'}]};
    slot.stage(1,Buffer.from(JSON.stringify(intent)).toString('base64url'));assert.equal(resolveOpenIntentFileResource(slot,1,intent.intentId,0).bytes,200*1024*1024);
    const larger=await open(file,'r+');await larger.truncate(200*1024*1024+1);await larger.close();assert.throws(()=>resolveOpenIntentFileResource(slot,1,intent.intentId,0),/unavailable/);
    await rm(file);assert.throws(()=>resolveOpenIntentFileResource(slot,1,intent.intentId,0),/unavailable/);
    const target=join(root,'real.md');await writeFile(target,'saved');await symlink(target,file);assert.throws(()=>resolveOpenIntentFileResource(slot,1,intent.intentId,0),/unavailable/);
  }finally{await rm(root,{recursive:true,force:true});}
});
