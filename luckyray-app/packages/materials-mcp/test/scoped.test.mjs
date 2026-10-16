import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {resolve} from 'node:path';
import {MaterialTransport,MaterialError,validateConfig,credentialForConfig} from '../src/transport.mjs';
import {pairingConfig} from '../src/pairing.mjs';

const scope=['materials.search','materials.inspect','folders.read','materials.import'];
const config={version:1,authKind:'materials-mcp-scoped-v1',desktopExe:resolve('fixture/desktop.exe'),profileRoot:resolve('fixture/profile'),baseUrl:'http://127.0.0.1:37418',clientId:'test-client',clientName:'Synthetic only',libraryId:'test-library',expiresAt:4102444800,scope,credentialFile:resolve('fixture/credential.dpapi')};
const secret='a'.repeat(64),target={exe:config.desktopExe,pid:42,created:'generation-1',ports:[37418]};
const error=code=>e=>e instanceof MaterialError&&e.code===code;
function fixture({mutate=d=>d,proofStatus=200,bodyData={libraryId:config.libraryId},profileFail=false}={}){
 const requests=[];let credentialReads=0;
 const client=new MaterialTransport(config,{inventory:async()=>[target],verifyProfile:async()=>{if(profileFail)throw new MaterialError('profile-identity-unverified');},credential:async()=>{credentialReads++;return secret;},http:async(port,path,opts)=>{
  requests.push({path,port,authorized:!!opts.credential});
  if(path.endsWith('/proof')){
   assert.equal(opts.credential,undefined);assert.deepEqual(Object.keys(opts.body).sort(),['clientId','clientNonce']);
   const d=mutate({protocolVersion:1,clientId:config.clientId,libraryId:config.libraryId,expiresAt:config.expiresAt,port,clientNonce:opts.body.clientNonce,serverNonce:'b'.repeat(64)});
   d.proof=createHmac('sha256',Buffer.from(secret,'hex')).update(['luckyray-local-transport-credential-v1','materials-mcp-proof','v1',d.clientId,d.libraryId,d.expiresAt,d.port,d.clientNonce,d.serverNonce].join('\0')).digest('hex');
   return {status:proofStatus,body:{ok:proofStatus===200,data:d}};
  }
  return {status:200,body:{ok:true,data:bodyData}};
 }});
 return {client,requests,credentialReads:()=>credentialReads};
}
test('old native config, extra secret fields, invalid scope, and non-loopback base URL cannot configure',()=>{
 for(const change of [{authKind:'native'},{token:'secret'},{scope:['materials.search']},{scope:[...scope,'terminal.run']},{baseUrl:'http://localhost:37418'},{baseUrl:'http://127.0.0.1:37418/redirect'},{baseUrl:'http://user:password@127.0.0.1:37418'}])assert.throws(()=>validateConfig({...config,...change}));
});
test('pairing import emits public metadata only and rejects expired or unexpected fields',()=>{
 const {credentialFile,...metadata}=config;const pair={...metadata,credential:secret};
 const out=pairingConfig(pair,credentialFile);assert.equal(JSON.stringify(out).includes(secret),false);assert.equal(out.libraryId,config.libraryId);
 assert.throws(()=>pairingConfig({...pair,expiresAt:1},credentialFile),error('pairing-expired'));
 assert.throws(()=>pairingConfig({...pair,masterSecret:secret},credentialFile),error('configuration-invalid'));
});
test('encrypted pairing metadata prevents public config from relabelling profile, EXE or library',()=>{
 const {credentialFile,...metadata}=config;const pair={...metadata,credential:secret};
 assert.equal(credentialForConfig(config,pair),secret);
 for(const change of [{profileRoot:resolve('other/profile')},{desktopExe:resolve('other/desktop.exe')},{libraryId:'foreign'},{baseUrl:'http://127.0.0.1:37419'}])assert.throws(()=>credentialForConfig(validateConfig({...config,...change}),pair),error('pairing-binding-mismatch'));
});
test('expiry and physical profile rejection occur before any credential read or network send',async()=>{
 let f=fixture();f.client.now=()=>4102444801;await assert.rejects(f.client.status(),error('pairing-expired'));assert.equal(f.credentialReads(),0);assert.equal(f.requests.length,0);
 f=fixture({profileFail:true});await assert.rejects(f.client.status(),error('profile-identity-unverified'));assert.equal(f.credentialReads(),0);assert.equal(f.requests.length,0);
});
test('signed proof must match exact client, library, expiry, port and fresh nonce',async()=>{
 for(const change of [{clientId:'other-client'},{libraryId:'other-library'},{expiresAt:4102444700},{port:37419},{clientNonce:'0'.repeat(64)},{serverNonce:'bad'}]){
  const f=fixture({mutate:d=>({...d,...change})});await assert.rejects(f.client.call('/api/v1/folders'),error('wrong-instance'));assert.equal(f.requests.some(r=>r.authorized),false);
 }
});
test('revoked or master-rotated pair is denied without bearer and recovers only after valid proof',async()=>{
 const f=fixture({proofStatus:401});await assert.rejects(f.client.status(),error('not-authorized'));assert.equal(f.requests.some(r=>r.authorized),false);
 const g=fixture();assert.equal((await g.client.status()).libraryId,config.libraryId);
});
test('multiple authenticated transport listeners fail closed',async()=>{
 const f=fixture();f.client.inventory=async()=>[{...target,ports:[37418,37419]}];await assert.rejects(f.client.status(),error('target-ambiguous'));assert.equal(f.requests.some(r=>r.authorized),false);
});
test('folder and import receipts cannot silently switch library',async()=>{
 for(const path of ['/api/v1/folders','/api/v1/assets/import-file']){const f=fixture({bodyData:{libraryId:'foreign'}});await assert.rejects(f.client.call(path),error('response-library-mismatch'));}
});
test('expiry during proof prevents business send',async()=>{
 const f=fixture();let checks=0;f.client.now=()=>++checks===1?1:4102444801;await assert.rejects(f.client.call('/api/v1/folders'),error('pairing-expired'));assert.equal(f.requests.some(r=>r.authorized),false);
});
