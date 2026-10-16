#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {MaterialTransport,MaterialError} from './transport.mjs';
import {Materials,TOOLS} from './materials.mjs';
const protocols=['2025-11-25','2025-06-18'];
export async function serve(materials,input=process.stdin,output=process.stdout){
 let pending=Buffer.alloc(0),initialized=false,negotiated=false,seen=new Set(),queue=[],working=false,closed=false;
 const send=value=>output.write(JSON.stringify(value)+'\n');
 const drain=async()=>{if(working)return;working=true;try{while(queue.length){const line=queue.shift();let r;try{r=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue;}
  if(r?.jsonrpc!=='2.0'||typeof r.method!=='string'){send({jsonrpc:'2.0',id:r?.id??null,error:{code:-32600,message:'Invalid request'}});continue;}
  if(r.id===undefined){if(r.method==='notifications/initialized'&&negotiated)initialized=true;continue;}
  if(!['string','number'].includes(typeof r.id)||String(r.id).length>128){send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid id'}});continue;}
  const key=typeof r.id+String(r.id);if(seen.has(key)){send({jsonrpc:'2.0',id:r.id,error:{code:-32600,message:'Duplicate request id'}});continue;}if(seen.size>=100000){input.destroy();closed=true;break;}seen.add(key);
  let result;
  try{
   if(r.method==='initialize'){negotiated=true;initialized=false;result={protocolVersion:protocols.includes(r.params?.protocolVersion)?r.params.protocolVersion:protocols[0],capabilities:{tools:{}},serverInfo:{name:'luckyray-materials-mcp',version:'0.1.0-candidate.4'}};}
   else if(r.method==='ping')result={};
   else if(!initialized){send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Initialize first'}});continue;}
   else if(r.method==='tools/list')result={tools:TOOLS};
   else if(r.method==='tools/call'){const value=await materials.run(r.params?.name,r.params?.arguments??{});result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}
   else{send({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Method not found'}});continue;}
   send({jsonrpc:'2.0',id:r.id,result});
  }catch(e){const code=e instanceof MaterialError?e.code:'operation-failed';send({jsonrpc:'2.0',id:r.id,result:{isError:true,content:[{type:'text',text:code}]}});}
 }}finally{working=false;if(closed&&queue.length===0)output.end?.();}};
 input.on('data',chunk=>{pending=Buffer.concat([pending,Buffer.from(chunk)]);if(pending.length>1048576){input.destroy();closed=true;return;}let end;while((end=pending.indexOf(10))>=0){const line=pending.subarray(0,end).toString('utf8');pending=pending.subarray(end+1);if(!line.trim())continue;if(queue.length>=16){input.destroy();closed=true;return;}queue.push(line);}void drain();});
 input.on('end',()=>{closed=true;if(!working)output.end?.();});
}
async function main(){
 if(process.argv.includes('--help')){console.log('luckyray-materials-mcp --config <absolute-config.json> [--check]\nLocal stdio only. Client launches this process on demand. No service, tunnel or autostart.');return;}
 const index=process.argv.indexOf('--config');if(index<0||!process.argv[index+1])throw new MaterialError('configuration-required');
 let config;try{config=JSON.parse((await readFile(process.argv[index+1],'utf8')).replace(/^\uFEFF/,''));}catch{throw new MaterialError('configuration-invalid');}
 const transport=new MaterialTransport(config);if(process.argv.includes('--check')){console.log(JSON.stringify(await transport.status()));return;}
 await serve(new Materials(transport));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{process.stderr.write((e instanceof MaterialError?e.code:'startup-failed')+'\n');process.exitCode=1;});
