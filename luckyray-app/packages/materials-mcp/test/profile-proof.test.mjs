import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {resolve} from 'node:path';
import {MaterialTransport} from '../src/transport.mjs';
const c={version:1,authKind:'materials-mcp-scoped-v1',profileProofVersion:2,desktopExe:resolve('fixture/desktop.exe'),profileRoot:resolve('fixture/profile'),baseUrl:'http://127.0.0.1:37418',clientId:'test',clientName:'Synthetic',libraryId:'library',expiresAt:4102444800,scope:['materials.search','materials.inspect','folders.read','materials.import'],credentialFile:resolve('fixture/credential.dpapi')};
function client(change={}){
 let sentBearer=false;
 const transport=new MaterialTransport(c,{inventory:async()=>[{exe:c.desktopExe,pid:8,created:'one',ports:[37418]}],credential:async()=>'a'.repeat(64),verifyProfile:async()=>{throw Error('v2 must not open a client-side DB');},http:async(port,path,options)=>{
  if(path.endsWith('/proof')){assert.equal(options.body.profileProofVersion,2);assert.equal(options.credential,undefined);
   const d={protocolVersion:2,clientId:c.clientId,libraryId:c.libraryId,expiresAt:c.expiresAt,port,clientNonce:options.body.clientNonce,serverNonce:'b'.repeat(64),profileRoot:c.profileRoot,desktopExe:c.desktopExe,...change};
   d.proof=createHmac('sha256',Buffer.from('a'.repeat(64),'hex')).update(['luckyray-local-transport-credential-v1','materials-mcp-proof','v2',d.clientId,d.libraryId,d.expiresAt,d.port,d.clientNonce,d.serverNonce,d.profileRoot,d.desktopExe].join('\0')).digest('hex');
   return {status:200,body:{ok:true,data:d}};
  }sentBearer=true;return {status:200,body:{ok:true,data:{libraryId:c.libraryId}}};
 }});
 return {transport,sent:()=>sentBearer};
}
test('sealed v2 uses desktop physical-profile proof before bearer without opening client DB',async()=>{const f=client();await f.transport.call('/api/v1/folders');assert.equal(f.sent(),true);});
test('v2 cannot downgrade or accept another signed profile or EXE',async()=>{
 for(const change of [{protocolVersion:1},{profileRoot:resolve('wrong/profile')},{desktopExe:resolve('other.exe')},{clientNonce:'c'.repeat(64)}]){const f=client(change);await assert.rejects(f.transport.call('/api/v1/folders'));assert.equal(f.sent(),false);}
});
