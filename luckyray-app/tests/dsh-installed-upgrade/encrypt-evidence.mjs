// Only ciphertext leaves the disposable runner. The recipient private key is
// generated locally, DPAPI protected, and is never an Actions input or asset.
import {readFile,writeFile,readdir,lstat,mkdir} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {createHash,randomBytes,createPublicKey,publicEncrypt,createCipheriv,constants} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function sealEvidence(plaintext,recipient){
  const key=randomBytes(32),iv=randomBytes(12);
  try{
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
    return {schema:1,algorithm:'RSA-OAEP-SHA256/AES-256-GCM',recipientSha256:createHash('sha256').update(createPublicKey(recipient).export({type:'spki',format:'der'})).digest('hex'),wrappedKey:publicEncrypt({key:recipient,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
  }finally{key.fill(0);}
}
async function main(){
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.GITHUB_REPOSITORY!=='xiaorui2886/LuckyRay')throw Error('disposable-public-runner-only');
  const root='D:\\lr-formal-uat',evidence=join(root,'evidence'),files=[];
  let total=0;
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name),metadata=await lstat(path);
    if(metadata.isSymbolicLink())throw Error('evidence-link-refused');
    if(metadata.isDirectory()){await walk(path);continue;}
    const name=relative(evidence,path).replaceAll('\\','/');
    if(!metadata.isFile()||/(?:^|\/)(?:private|tls|credentials?)(?:\.|\/|$)/i.test(name)||/\.(?:pem|pfx|p12|key|dpapi)$/i.test(name))throw Error('non-evidence-file-refused');
    total+=metadata.size;if(total>128*1024*1024||files.length>=1000)throw Error('evidence-size-limit');
    const bytes=await readFile(path);files.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')});
  }}
  await walk(evidence);files.sort((a,b)=>a.name.localeCompare(b.name));
  const recipient=await readFile(resolve(process.argv[2]),'utf8');
  const payload=Buffer.from(JSON.stringify({schema:1,repository:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,source:process.env.GITHUB_SHA,files}));
  const envelope=sealEvidence(payload,recipient);payload.fill(0);
  await mkdir(join(root,'encrypted'),{recursive:true});
  await writeFile(join(root,'encrypted','installed-upgrade-evidence.encrypted.json'),JSON.stringify(envelope)+'\n',{flag:'wx'});
  console.log('evidence-encrypted; no plaintext artifact permitted');
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'.')).href)await main();
