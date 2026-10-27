import {request} from 'node:http';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export class MaterialError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new MaterialError(code);};
const normalize=value=>resolve(value).replaceAll('\\','/').toLowerCase();
export function validateConfig(config){
 if(!config||config.version!==1||typeof config.desktopExe!=='string'||!isAbsolute(config.desktopExe)||typeof config.profileRoot!=='string'||!isAbsolute(config.profileRoot))fail('configuration-required');
 if([config.desktopExe,config.profileRoot].some(p=>p.startsWith('\\\\')||p.startsWith('//')))fail('configuration-invalid');
 const fields=['version','desktopExe','profileRoot','authKind','baseUrl','clientId','clientName','libraryId','expiresAt','scope','credentialFile','profileProofVersion'];
 if(config.profileProofVersion!==undefined&&config.profileProofVersion!==2)fail('configuration-invalid');
 if(Object.keys(config).some(k=>!fields.includes(k)))fail('configuration-invalid');
 if(config.authKind!=='materials-mcp-scoped-v1')fail('scoped-pairing-required');
 if(![config.clientId,config.clientName,config.libraryId].every(v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v)))fail('configuration-invalid');
 if(!Number.isSafeInteger(config.expiresAt)||config.expiresAt<=0)fail('configuration-invalid');
 const scope=['materials.search','materials.inspect','folders.read','materials.import'];
 if(!Array.isArray(config.scope)||config.scope.length!==scope.length||!scope.every(s=>config.scope.includes(s)))fail('configuration-invalid');
 let url;try{url=new URL(config.baseUrl);}catch{fail('configuration-invalid');}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||Number(url.port)<37418||Number(url.port)>37468)fail('configuration-invalid');
 if(typeof config.credentialFile!=='string'||!isAbsolute(config.credentialFile)||config.credentialFile.startsWith('\\\\')||config.credentialFile.startsWith('//'))fail('configuration-invalid');
 return Object.freeze({...config,scope:Object.freeze([...config.scope])});
}
export async function inventory(deps={}){
 if(process.platform!=='win32')fail('platform-unsupported');
 // Node decodes stdout as UTF-8. Windows PowerShell otherwise emits the local
 // code page, corrupting non-ASCII executable paths before exact identity checks.
 const command=`[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); @((Get-CimInstance Win32_Process -Filter "Name='luckyray-app.exe'") | ForEach-Object {$p=$_; [PSCustomObject]@{pid=$p.ProcessId;exe=$p.ExecutablePath;created=$p.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress -Depth 4`;
 try{
  const root=process.env.SystemRoot;
  if(!root||!isAbsolute(root))fail('instance-inventory-unavailable');
  const run=deps.exec||exec;
  // Numeric OS listener ownership avoids loading NetTCPIP's slow CIM provider.
  // No cache or name-based port assumption: retain PID/EXE/creation snapshots,
  // v3 signed proof and the second fresh ownership check in bind().
  const [{stdout:processes},{stdout:sockets}]=await Promise.all([
   run(resolve(root,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000,maxBuffer:1048576}),
   run(resolve(root,'System32/netstat.exe'),['-ano','-p','tcp'],{windowsHide:true,timeout:15000,maxBuffer:1048576}),
  ]);
  const data=JSON.parse(processes.trim()||'[]'),items=Array.isArray(data)?data:[data];
  const owned=new Map();
  for(const line of sockets.split(/\r?\n/)){
   const match=/^\s*TCP\s+127\.0\.0\.1:([0-9]{1,5})\s+0\.0\.0\.0:0\s+LISTEN(?:ING)?\s+([0-9]+)\s*$/i.exec(line);
   if(!match)continue;
   const port=Number(match[1]),pid=Number(match[2]);
   if(!Number.isSafeInteger(pid)||pid<=0||port<=0||port>65535)continue;
   if(!owned.has(pid))owned.set(pid,new Set());
   owned.get(pid).add(port);
  }
  return items.map(item=>({...item,ports:[...(owned.get(item.pid)||[])]}));
 }catch{fail('instance-inventory-unavailable');}
}
export function selectTarget(config,items){
 const matches=items.filter(item=>typeof item.exe==='string'&&normalize(item.exe)===normalize(config.desktopExe));
 if(!matches.length)fail('target-not-running');if(matches.length!==1)fail('target-ambiguous');
 return matches[0];
}
export async function verifyProfile(config){
 try{await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./verify-profile.ps1',import.meta.url)),'-ProfileRoot',config.profileRoot],{windowsHide:true,timeout:15000,maxBuffer:65536});}catch{fail('profile-identity-unverified');}
}
export async function scopedCredential(config){
 let pair;
 try{const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./read-credential.ps1',import.meta.url)),'-Path',config.credentialFile],{windowsHide:true,timeout:15000,maxBuffer:32768});pair=JSON.parse(stdout);}catch{fail('authorization-unavailable');}
 return credentialForConfig(config,pair);
}
export function credentialForConfig(config,pair){
 if(!pair||!/^[a-f0-9]{64}$/.test(pair.credential||''))fail('credential-unusable');
 const {credential,...metadata}=pair;const sealed=validateConfig({...metadata,credentialFile:config.credentialFile});
 for(const key of Object.keys(config)){if(JSON.stringify(config[key])!==JSON.stringify(sealed[key]))fail('pairing-binding-mismatch');}
 return credential;
}
export function httpJson(port,path,{body,credential,timeout=15000}={}){
 return new Promise((accept,reject)=>{
  const payload=body===undefined?null:Buffer.from(JSON.stringify(body));if(payload&&payload.length>1048576){reject(new MaterialError('input-too-large'));return;}
  const req=request({hostname:'127.0.0.1',port,path,method:payload?'POST':'GET',headers:{Connection:'close',...(credential?{Authorization:'Bearer '+credential}:{}),...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}},res=>{
   const chunks=[];let length=0;
   res.on('data',chunk=>{length+=chunk.length;if(length>1048576)req.destroy(new MaterialError('response-too-large'));else chunks.push(chunk);});
   res.on('end',()=>{try{accept({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(new MaterialError('response-invalid'));}});
   res.on('error',()=>reject(new MaterialError('transport-disconnected')));
  });
  const timer=setTimeout(()=>req.destroy(new MaterialError('request-timeout')),timeout);req.on('close',()=>clearTimeout(timer));
  req.on('error',e=>reject(e instanceof MaterialError?e:new MaterialError('transport-disconnected')));req.end(payload);
 });
}
const safeEqual=(a,b)=>/^[a-f0-9]{64}$/i.test(a||'')&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
export class MaterialTransport {
 constructor(config,deps={}){this.config=validateConfig(config);this.inventory=deps.inventory||inventory;this.credential=deps.credential||scopedCredential;this.verifyProfile=deps.verifyProfile||verifyProfile;this.http=deps.http||httpJson;this.now=deps.now||(()=>Date.now()/1000);}
 async bind(){
  const c=this.config;if(c.expiresAt<=this.now())fail('pairing-expired');
  const target=selectTarget(this.config,await this.inventory());
  const ports=[...new Set(target.ports.filter(p=>Number.isInteger(p)&&p>=37418&&p<=37468))];
  if(!ports.length)fail('port-not-ready');
  // v1 keeps its original local physical-path gate. v2 relocates that gate to
  // the desktop which owns the DB and authenticates both physical identities.
  // The selected protocol is sealed with the credential; no downgrade fallback.
  if(c.profileProofVersion!==2)await this.verifyProfile(c);
  const credential=await this.credential(c);if(!/^[a-f0-9]{64}$/.test(credential))fail('credential-unusable');
  const verified=[];let invalid=false,unsupported=false,denied=false;
  for(const port of ports){
   const nonce=randomBytes(32).toString('hex');let response;
   try{response=await this.http(port,'/api/v1/materials/proof',{body:{clientId:c.clientId,clientNonce:nonce,...(c.profileProofVersion===2?{profileProofVersion:2}:{})},timeout:2000});}catch{continue;}
   const d=response.body?.data;
   if(response.status===401||response.status===403){denied=true;continue;}
   const version=c.profileProofVersion===2?2:1;
   if(response.status!==200||response.body?.ok!==true||d?.protocolVersion!==version){unsupported=true;continue;}
   if(version===2&&(typeof d.profileRoot!=='string'||typeof d.desktopExe!=='string'||normalize(d.profileRoot)!==normalize(c.profileRoot)||normalize(d.desktopExe)!==normalize(c.desktopExe))){invalid=true;continue;}
   const expected=createHmac('sha256',Buffer.from(credential,'hex')).update(['luckyray-local-transport-credential-v1','materials-mcp-proof','v'+version,c.clientId,c.libraryId,c.expiresAt,port,nonce,d.serverNonce,...(version===2?[d.profileRoot,d.desktopExe]:[])].join('\0')).digest('hex');
   if(d.clientId!==c.clientId||d.libraryId!==c.libraryId||d.expiresAt!==c.expiresAt||d.port!==port||d.clientNonce!==nonce||!/^[a-f0-9]{64}$/.test(d.serverNonce||'')||!safeEqual(d.proof,expected)){invalid=true;continue;}
   verified.push({target,port,credential});
  }
  if(invalid)fail('wrong-instance');if(verified.length>1)fail('target-ambiguous');
  if(!verified.length)fail(denied?'not-authorized':unsupported?'version-unsupported':'port-not-ready');
  const current=selectTarget(this.config,await this.inventory());if(current.pid!==target.pid||current.created!==target.created||!current.ports.includes(verified[0].port))fail('target-changed');
  if(c.expiresAt<=this.now())fail('pairing-expired');
  return verified[0];
 }
 async call(path,body){
  if(!['/api/v1/tools/run','/api/v1/assets/import-file','/api/v1/folders'].includes(path))fail('operation-denied');
  if(path==='/api/v1/tools/run'&&!['materials.search','materials.inspect'].includes(body?.toolId))fail('operation-denied');
  const binding=await this.bind();let out;
  try{out=await this.http(binding.port,path,{body,credential:binding.credential,timeout:path.endsWith('import-file')?135000:30000});}catch(e){if(path.endsWith('import-file'))fail('import-outcome-unknown');throw e;}
  if(out.status===401||out.status===403)fail('not-authorized');if(out.status===404||out.status===405||out.body?.error?.code==='tool-unavailable'||out.body?.error?.code==='tool-not-found')fail('version-unsupported');
  if(out.status>=300||out.body?.ok!==true)fail(path.endsWith('import-file')?'import-rejected':'desktop-request-failed');
  if(['/api/v1/folders','/api/v1/assets/import-file'].includes(path)&&out.body.data?.libraryId!==this.config.libraryId)fail('response-library-mismatch');
  return out.body.data;
 }
 async status(){const b=await this.bind();return {ready:true,protocolVersion:this.config.profileProofVersion??1,pid:b.target.pid,port:b.port,libraryId:this.config.libraryId,expiresAt:this.config.expiresAt,scope:this.config.scope,authentication:this.config.authKind};}
}
