/** Offline packaging helper. Never generates keys, signs files, uploads, or publishes. */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {basename, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function buildManifest({version, installerName, signature, notes='', publishedAt}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('update-version-invalid');
  if (installerName!==`LuckyRay_${version}_x64-setup.exe`) throw Error('update-installer-name-invalid');
  if (typeof signature!=='string'||signature.length<40||signature.length>16384||!/^[A-Za-z0-9+/=\r\n]+$/.test(signature)) throw Error('update-signature-format-invalid');
  // The Tauri .sig is base64 encoded minisign text. Require a canonical version-bound file in its
  // trusted comment, but do not claim that parsing it authenticates the file.
  const text=Buffer.from(signature.trim(),'base64').toString('utf8');
  const trusted=text.split(/\r?\n/).find(line=>line.startsWith('trusted comment: '));
  const fields=trusted?.slice('trusted comment: '.length).split('\t').filter(field=>field.startsWith('file:'))??[];
  const bound=fields.length===1?fields[0].slice('file:'.length):undefined;
  if (bound!==installerName) throw Error('update-signed-version-missing-or-mismatch');
  if (typeof notes!=='string'||Buffer.byteLength(notes)>32768) throw Error('update-notes-too-large');
  if (typeof publishedAt!=='string'||!Number.isFinite(Date.parse(publishedAt))) throw Error('update-published-at-invalid');
  return {
    version, notes, pub_date:new Date(publishedAt).toISOString(),
    platforms:{'windows-x86_64-nsis':{
      signature:signature.trim(),
      url:`https://github.com/xiaorui2886/LuckyRay/releases/download/v${version}/${installerName}`,
    }},
  };
}
async function main(args) {
  const [version,installerPath,signaturePath,notesPath,outputPath]=args;
  if(args.length!==5)throw Error('usage: VERSION INSTALLER SIG NOTES OUTPUT_JSON');
  const info=await stat(installerPath);
  if(!info.isFile()||info.size===0||info.size>1024*1024*1024)throw Error('update-installer-empty');
  const verifier=process.env.LUCKYRAY_UPDATE_VERIFIER;
  if(!verifier)throw Error('update-release-verifier-required');
  const trustPath=fileURLToPath(new URL('../src-tauri/src/desktop_app_update/trust.json',import.meta.url));
  const verified=JSON.parse(execFileSync(verifier,[resolve(installerPath),resolve(signaturePath),trustPath,version],{encoding:'utf8',timeout:120000,maxBuffer:32768}));
  if(verified.verified!==true||verified.version!==version)throw Error('update-signature-verification-failed');
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(installerPath))hash.update(chunk);
  const sha256=hash.digest('hex');
  if(sha256!==verified.sha256)throw Error('update-installer-changed-after-verification');
  const signature=await readFile(signaturePath,'utf8');
  if(createHash('sha256').update(signature).digest('hex')!==verified.signatureSha256)throw Error('update-signature-changed-after-verification');
  const manifest=buildManifest({version,installerName:basename(installerPath),
    signature,notes:await readFile(notesPath,'utf8'),
    publishedAt:new Date().toISOString()});
  // Exclusive write prevents silently replacing another release's feed.
  await writeFile(outputPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({output:resolve(outputPath),installerBytes:info.size,
    sha256,
    signatureVerification:'VERIFIED_WITH_APPROVED_PUBLIC_KEY_AND_SIGNED_VERSION'},null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
