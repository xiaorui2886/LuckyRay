import assert from 'node:assert/strict';
import test from 'node:test';
import '../plugin-sdk/material-library-consumer.js';
const { create }=globalThis.LuckyRayMaterialLibraries;
const A='library-A', B='library-B';
const pending=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=(target,extra={})=>({consumerVersion:1,...target,...extra});
test('taxonomy late A/B/A cannot overwrite current selection',async()=>{
  const calls=[];const client=create((method,path,body)=>{const wait=pending();calls.push({...wait,body});return wait.promise;});
  client.select(A);const old=client.taxonomy('request-old');const rejected=assert.rejects(old,{code:'consumer-stale-result'});
  client.select(B);client.select(A);const latest=client.taxonomy('request-new');
  calls[1].resolve(response(calls[1].body,{folders:[{id:'new'}]}));assert.equal((await latest).folders[0].id,'new');
  calls[0].resolve(response(calls[0].body,{folders:[{id:'old'}]}));await rejected;
});
test('same-library reads are ordered by kind and operation',async()=>{
  const calls=[];const client=create((method,path,body)=>{const wait=pending();calls.push({...wait,body});return wait.promise;});client.select(A);
  const first=client.taxonomy('first');const rejected=assert.rejects(first,{code:'consumer-stale-result'});const second=client.taxonomy('second');
  calls[1].resolve(response(calls[1].body));await second;calls[0].resolve(response(calls[0].body));await rejected;
});
test('capture target and payload survive UI switching and exact retry',async()=>{
  const calls=[];const client=create(async(method,path,body)=>{calls.push({method,path,body});return response(body,{disposition:'imported',assetId:'saved'});});client.select(A);
  const input={requestId:'popup:uuid',name:'shot.png',mimeType:'image/png',bytesBase64:'aGVsbG8=',tagNames:['截图']};
  const operation=client.prepareCapture(input);input.name='mutated';input.tagNames.push('mutated');client.select(B);client.select(A);
  assert.equal((await client.save(operation)).current,false);assert.equal((await client.save(operation)).current,false);
  assert.deepEqual(calls[0].body,calls[1].body);assert.equal(calls[0].body.libraryId,A);assert.equal(calls[0].body.name,'shot.png');assert.deepEqual(calls[0].body.tagNames,['截图']);
  assert.throws(()=>client.prepareCapture({...input,libraryId:B}),{code:'consumer-target-changed'});
  await assert.rejects(client.save({...operation}),{code:'consumer-operation-unbound'});
});
test('foreign responses and unsupported capability never fallback to legacy',async()=>{
  const calls=[];const client=create(async(method,path,body)=>{calls.push(path);return response({...body,libraryId:B});});client.select(A);
  await assert.rejects(client.taxonomy('identity'),{code:'consumer-response-identity'});assert.deepEqual(calls,['/api/material-libraries/taxonomy']);
  const unavailable=create(async()=>({}));await assert.rejects(unavailable.libraries(),{code:'consumer-contract-unavailable'});
});
test('enumeration alone cannot prepare a target; failed save keeps same operation for retry',async()=>{
  let fail=true;const client=create(async(method,path,body)=>{if(method==='GET')return response(null,{libraries:[{libraryId:A,capabilities:{files:false}}]});if(fail){fail=false;throw Error('transport lost');}return response(body,{disposition:'duplicate'});});
  await client.libraries();assert.throws(()=>client.prepareCapture({requestId:'popup:x'}),{code:'consumer-target-required'});client.select(A);
  const operation=client.prepareCapture({requestId:'popup:x',name:'x.md',mimeType:'text/markdown',bytesBase64:'eA=='});
  await assert.rejects(client.save(operation),/transport lost/);assert.equal((await client.save(operation)).receipt.requestId,'popup:x');
});

test('late read failure is stale, save failure carries original operation identity',async()=>{
  const waits=[];const client=create(()=>{const wait=pending();waits.push(wait);return wait.promise;});client.select(A);
  const read=client.taxonomy('old-failure');const stale=assert.rejects(read,{code:'consumer-stale-result'});client.select(B);waits[0].reject(Error('late error'));await stale;
  client.select(A);const operation=client.prepareCapture({requestId:'popup:failure',name:'x.md',mimeType:'text/markdown',bytesBase64:'eA=='});
  const save=client.save(operation);const bound=assert.rejects(save,error=>error.libraryId===A && error.requestId==='popup:failure' && error.current===false);client.select(B);waits[1].reject(Error('uncertain result'));await bound;
});
