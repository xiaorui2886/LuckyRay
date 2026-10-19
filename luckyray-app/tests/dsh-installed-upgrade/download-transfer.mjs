// The URL exists only in this step's environment. Never print requests,
// redirects, exceptions, query parameters, headers or credentials.
import {readFile,open,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
try{
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.GITHUB_REPOSITORY!=='xiaorui2886/LuckyRay')throw Error();
  const expected=JSON.parse(await readFile(new URL('./expected.json',import.meta.url),'utf8'));
  let url=new URL(process.env.PRIVATE_TRANSFER_DOWNLOAD_URL);
  const allowed=new Set(['release-assets.githubusercontent.com','objects.githubusercontent.com']);
  let response;
  for(let count=0;count<4;count++){
    if(url.protocol!=='https:'||!allowed.has(url.hostname)||url.username||url.password||url.hash)throw Error();
    response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(180000)});
    if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),url);continue;}
    break;
  }
  if(!response?.ok||!response.body||Number(response.headers.get('content-length'))!==expected.transferBytes)throw Error();
  await mkdir('D:\\lr-formal-uat\\private',{recursive:true});
  const file=await open('D:\\lr-formal-uat\\private\\transfer.zip','wx');
  const hash=createHash('sha256');let bytes=0;
  try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>expected.transferBytes)throw Error();hash.update(chunk);await file.write(chunk);}await file.sync();}finally{await file.close();}
  if(bytes!==expected.transferBytes||hash.digest('hex')!==expected.transferSha256)throw Error();
  console.log('private-transfer-verified; no address or credential logged');
}catch{console.error('private-transfer-failed; address and credential withheld');process.exitCode=1;}
