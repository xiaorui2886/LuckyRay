import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync,privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import {sealEvidence} from './encrypt-evidence.mjs';
import {installedApplicationEnvironment} from './runner-environment.mjs';
import {installedPaths} from './installed-paths.mjs';

test('prepared mixed-separator paths retain the exact installer and original runner profile identity',()=>{
  const local='C:\\Users\\runneradmin\\AppData\\Local';
  const input={install:'D:\\lr-formal-uat/安装 空格',profile:'C:\\Users\\runneradmin\\AppData\\Roaming/com.luckyray.desktop',local,tls:'D:\\lr-formal-uat/private/tls.json'};
  const paths=installedPaths(input);
  assert.equal(paths.install,'D:\\lr-formal-uat\\安装 空格');
  assert.equal(paths.profile,'C:\\Users\\runneradmin\\AppData\\Roaming\\com.luckyray.desktop');
  assert.equal(('/D='+paths.install).endsWith('/D=D:\\lr-formal-uat\\安装 空格'),true);
  assert.equal(input.install,'D:\\lr-formal-uat/安装 空格','input is not rewritten');
  assert.throws(()=>installedPaths({...input,install:'D:\\other'}));
  assert.throws(()=>installedPaths({...input,profile:'C:\\Users\\someone-else\\AppData\\Roaming\\com.luckyray.desktop'}));
});

test('installed app receives Windows basics and the approved process proxy, never CI credentials',()=>{
  const environment=installedApplicationEnvironment({SystemRoot:'C:\\Windows',Path:'C:\\Windows\\System32',APPDATA:'D:\\synthetic\\Roaming',ACTIONS_RUNTIME_TOKEN:'synthetic-runtime-secret',GITHUB_TOKEN:'synthetic-repo-secret',PRIVATE_TRANSFER_DOWNLOAD_URL:'synthetic-transfer-secret',NODE_OPTIONS:'--require unreviewed.js'},'http://127.0.0.1:12345');
  assert.equal(environment.SystemRoot,'C:\\Windows');assert.equal(environment.APPDATA,'D:\\synthetic\\Roaming');
  assert.equal(environment.HTTPS_PROXY,'http://127.0.0.1:12345');
  assert.equal(environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,'--remote-debugging-port=9391');
  for(const name of ['ACTIONS_RUNTIME_TOKEN','GITHUB_TOKEN','PRIVATE_TRANSFER_DOWNLOAD_URL','NODE_OPTIONS'])assert.equal(environment[name],undefined);
  assert.throws(()=>installedApplicationEnvironment({},'https://external.invalid'));
  assert.throws(()=>installedApplicationEnvironment({},'http://user:password@127.0.0.1:12345'));
});

test('synthetic evidence is recoverable only with the separate recipient key',()=>{
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const publicPem=publicKey.export({type:'spki',format:'pem'}),text=Buffer.from('synthetic evidence only 中文');
  const envelope=sealEvidence(text,publicPem);
  assert.equal(JSON.stringify(envelope).includes(text.toString()),false);
  const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
  const decrypt=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decrypt.setAuthTag(Buffer.from(envelope.tag,'base64'));
  assert.deepEqual(Buffer.concat([decrypt.update(Buffer.from(envelope.ciphertext,'base64')),decrypt.final()]),text);
  const wrong=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  assert.throws(()=>privateDecrypt({key:wrong,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64')));
  key.fill(0);
});
test('observer keeps genuine runner, actual installed versions and normal quit boundaries',async()=>{
  const engine=await readFile(new URL('./engine-chain.mjs',import.meta.url),'utf8'),chain=await readFile(new URL('./chain.mjs',import.meta.url),'utf8');
  assert.match(engine,/JSON\.parse\(localStorage\.getItem\('dsh.sessions.current'\)\)\?\.sessionId/);
  assert.match(engine,/assertOriginals\(oldFixture\)/);assert.match(engine,/old installed engine|old engine running/);
  assert.match(engine,/await invoke\('close_window'\)/);assert.match(engine,/\.keyboard\.insertText\(draft\)/);
  assert.doesNotMatch(engine,/localStorage\.setItem|process\.kill|\.kill\(/);
  assert.match(chain,/process\.env\.GITHUB_ACTIONS!=='true'/);assert.match(chain,/spec\.a\.version,'1\.9\.8'/);assert.match(chain,/spec\.b\.version,'1\.9\.9'/);
  assert.match(chain,/installer-owned automatic B reopen/);assert.match(chain,/runDshInstalledUpgrade/);
  assert.ok(chain.indexOf('const materialFixture=await seedInstalledMaterial')<chain.indexOf("stage='A_download'"));
  assert.match(chain,/B_preupgrade_material_preserved/);assert.match(engine,/verifyInstalledMaterial\(invoke,materialFixture\)/);
});
