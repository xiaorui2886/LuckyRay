import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function verifyInputs(directory,expected){
  const root=resolve(directory);
  const file=async(relative)=>{
    assert.match(relative,/^[A-Za-z0-9_.\/-]+$/);assert.equal(relative.split('/').some(part=>!part||part==='.'||part==='..'),false);
    const path=resolve(root,relative);assert.ok(path.startsWith(root+sep));const metadata=await lstat(path);assert.equal(metadata.isSymbolicLink(),false);assert.equal(metadata.isFile(),true);
    return readFile(path);
  };
  const specBytes=await file('spec.json');assert.equal(hash(specBytes),expected.specSha256);
  const spec=JSON.parse(specBytes);assert.equal(spec.reviewedPrivateTransfer,true);
  assert.equal(spec.a.version,'1.9.8');assert.equal(spec.a.sha256,'2aa1d70187b706e523c576ddbdde2e981a84c31a59e9c003e155d1e766aa5a7e');assert.equal(spec.b.version,'1.9.9');
  assert.equal(spec.b.sha256,expected.bSha256);assert.equal(hash(await file(spec.b.file)),spec.b.sha256);
  assert.equal(spec.b.manifest.version,spec.b.version);assert.equal(spec.b.manifest.platforms['windows-x86_64-nsis'].url,'https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.9/LuckyRay_1.9.9_x64-setup.exe');
  assert.equal(spec.engine.fromVersion,'0.1.7-rc.2');assert.equal(spec.engine.version,'0.2.1-rc.2');
  const trust=JSON.parse(await readFile(new URL('../../config/dsh-production-update-source.json',import.meta.url),'utf8'));
  assert.equal(trust.fingerprintSha256,'ce08b1e8a9bdda216188602d39a2007cf635a2b46e5ae44f4d8a08aa23d98336');
  const envelopeBytes=await file('catalog.signed.json'),envelope=JSON.parse(envelopeBytes);
  assert.equal(hash(envelopeBytes),expected.engineEnvelopeSha256);
  assert.deepEqual(Object.keys(envelope).sort(),['payload','signature']);
  const payload=Buffer.from(envelope.payload,'base64url'),signature=Buffer.from(envelope.signature,'base64url');
  assert.equal(payload.toString('base64url'),envelope.payload);assert.equal(signature.length,64);
  const raw=Buffer.from(trust.publicKey,'base64url');assert.equal(hash(raw),trust.fingerprintSha256);
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'});
  assert.equal(verify(null,payload,key,signature),true,'unchanged formal DSH signing root');
  assert.equal(hash(payload),expected.enginePayloadSha256);
  const candidate=JSON.parse(payload),description=await file('qualified-description.json');
  assert.equal(JSON.parse(description).packages.length,expected.officialPackageCount);
  assert.equal(spec.engine.replayFiles.length+3,expected.inputFileCount);
  assert.equal(candidate.hostVersion,spec.b.version);assert.equal(candidate.version,spec.engine.version);assert.ok(candidate.fromVersions.includes(spec.engine.fromVersion));
  assert.equal(candidate.artifactSha256,hash(description));assert.equal(candidate.artifactBytes,description.length);assert.equal(candidate.artifactSha256,spec.engine.descriptorSha256);
  assert.equal(candidate.closureFileCount,35173);assert.ok(candidate.compatibility.requiredCapabilities.includes('closure-budget-40000-v1'));assert.ok(candidate.compatibility.requiredCapabilities.includes('loader-login-relay-ready-v1'));
  assert.ok(candidate.expiresAt>Math.floor(Date.now()/1000));assert.equal(candidate.dataCompatibility,'no-migration');
  const urls=new Set();
  for(const input of spec.engine.replayFiles){
    const url=new URL(input.url);assert.equal(url.protocol,'https:');assert.equal(url.username+url.password+url.hash+url.search,'');
    assert.ok(['raw.githubusercontent.com','nodejs.org','registry.npmjs.org'].includes(url.hostname));
    assert.equal(urls.has(url.href),false);urls.add(url.href);
    const bytes=await file(input.file);assert.equal(bytes.length,input.bytes);assert.equal(hash(bytes),input.sha256);
    if(url.hostname==='raw.githubusercontent.com')assert.ok(url.href===trust.feedUrl||url.href===candidate.artifactUrl);
    if(url.hostname==='nodejs.org')assert.equal(url.href,'https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip');
    if(url.hostname==='registry.npmjs.org')assert.match(url.pathname,/^\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/-\/[a-z0-9._-]+-[0-9][a-zA-Z0-9.-]*\.tgz$/);
  }
  assert.ok(urls.has(trust.feedUrl));assert.ok(urls.has(candidate.artifactUrl));
  return {spec,replayFileCount:urls.size,enginePayloadSha256:hash(payload),formalRootSha256:trust.fingerprintSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const expected=JSON.parse(await readFile(new URL('./expected.json',import.meta.url),'utf8'));
  const result=await verifyInputs(process.argv[2],expected);console.log(JSON.stringify({status:'PASS_FIXED_REVIEWED_INPUTS',replayFileCount:result.replayFileCount,formalRootSha256:result.formalRootSha256}));
}
