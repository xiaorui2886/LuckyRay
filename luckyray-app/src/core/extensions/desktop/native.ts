import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
export type DesktopIdentity={id:string;digest:string;epoch:number};
export async function openDesktopLease(identity:DesktopIdentity){return invoke<string>('desktop_extension_runtime',{request:JSON.stringify({op:'open',...identity})});}
export async function desktopNative<T>(lease:string,op:string,input:Record<string,unknown>={}){return invoke<T>('desktop_extension_runtime',{request:JSON.stringify({op,lease,...input})});}
export function createDesktopNativeApi(lease:string,own:(dispose:()=>void)=>(()=>void)){
 const cancelled=new Set<string>();
 const network={request:async(input:{url:string;method?:string;headers?:Record<string,string>;body?:string;timeoutMs?:number},signal?:AbortSignal)=>{
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  const requestId=crypto.randomUUID();
  const abort=()=>{cancelled.add(requestId);void desktopNative(lease,'cancelRequest',{requestId}).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});const release=own(abort);
  try{const r=await desktopNative<{status:number;headers:Record<string,string>;body:string}>(lease,'request',{...input,requestId});if(cancelled.has(requestId))throw new DOMException('Aborted','AbortError');return r;}finally{release();signal?.removeEventListener('abort',abort);cancelled.delete(requestId);}
 }};
 const files={
  read:(path:string)=>desktopNative<{base64:string}>(lease,'readFile',{path}),
  write:(path:string,base64:string,options:{overwrite?:boolean}={})=>desktopNative<void>(lease,'writeFile',{path,base64,overwrite:options.overwrite===true}),
  list:(path:string)=>desktopNative<{name:string;directory:boolean}[]>(lease,'listDirectory',{path}),
  mkdir:(path:string)=>desktopNative<void>(lease,'createDirectory',{path}),
  rename:(from:string,to:string)=>desktopNative<void>(lease,'rename',{from,to}),
  remove:(path:string)=>desktopNative<void>(lease,'removeFile',{path}),
 };
 const process={spawn:async(input:{executable:string;args?:string[];cwd:string;env?:Record<string,string>})=>{
  const handle=await desktopNative<string>(lease,'spawn',input);
  const stop=()=>{void desktopNative(lease,'kill',{handle}).catch(()=>{});};const release=own(stop);
  return {handle,write:(base64:string)=>desktopNative<void>(lease,'stdin',{handle,base64}),closeInput:()=>desktopNative<void>(lease,'closeInput',{handle}),poll:async()=>{const r=await desktopNative<{events:{sequence:number;stream:string;base64:string}[];exitCode:number|null;settled:boolean;overflow:boolean}>(lease,'poll',{handle});if(r.settled)release();return r;},kill:async()=>{await desktopNative<void>(lease,'kill',{handle});release();}};
 }};
 const ai={generate:async(prompt:string,options:{signal?:AbortSignal;onChunk?:(text:string)=>void}={})=>{
  const {signal,onChunk}=options;if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  let live=true;const requestId=crypto.randomUUID();const abort=()=>{live=false;void desktopNative(lease,'cancelRequest',{requestId}).catch(()=>{});};const release=own(abort);
  let off:(()=>void)|undefined;
  try{
   if(onChunk)off=await listen<{requestId:string;delta:string}>('luckyray:desktop:ai-delta',e=>{if(live&&e.payload.requestId===requestId&&!signal?.aborted)onChunk(e.payload.delta);});
   if(!live||signal?.aborted)throw new DOMException('Aborted','AbortError');signal?.addEventListener('abort',abort,{once:true});
   const result=await desktopNative<{text:string}>(lease,'aiGenerate',{requestId,prompt,stream:!!onChunk});if(!live)throw new DOMException('Aborted','AbortError');return result;
  }finally{release();off?.();signal?.removeEventListener('abort',abort);}
 }};
 return {network,files,process,ai};
}
