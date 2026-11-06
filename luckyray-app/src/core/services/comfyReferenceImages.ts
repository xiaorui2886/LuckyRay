import {convertFileSrc} from '@tauri-apps/api/core';
import {readMediaBytes} from '../canvas/mediaDelivery';

const MAX_BYTES=12*1024*1024;
export function validateComfyImageDataUrl(value:string):string {
  if(!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length>Math.ceil(MAX_BYTES*4/3)+64) throw Error('COMFY_IMAGE_INVALID');
  return value;
}
function encode(bytes:Uint8Array):string {
  if(!bytes.length || bytes.length>MAX_BYTES) throw Error('COMFY_IMAGE_TOO_LARGE');
  const mime=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71?'image/png'
    :bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg'
      :String.fromCharCode(...bytes.subarray(0,4))==='RIFF'&&String.fromCharCode(...bytes.subarray(8,12))==='WEBP'?'image/webp':null;
  if(!mime)throw Error('COMFY_IMAGE_INVALID');
  let binary='';for(let index=0;index<bytes.length;index+=0x8000)binary+=String.fromCharCode(...bytes.subarray(index,index+0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
/** Only already-resolved canvas local originals; no remote URL or thumbnail fallback. */
export async function prepareComfyReferenceImage(value:string, signal?:AbortSignal):Promise<string> {
  if(value.startsWith('data:'))return validateComfyImageDataUrl(value);
  let path=value,assetSource:string|undefined;
  if(/^blob:/i.test(value)) {
    if(!value.startsWith(`blob:${location.origin}/`))throw Error('COMFY_IMAGE_LOCAL_REQUIRED');
    return readLocalImage(value,signal);
  }
  if(/^[a-z][a-z\d+.-]*:/i.test(value)&&! /^[A-Za-z]:[\\/]/.test(value)) {
    const url=new URL(value);
    if(!(url.protocol==='asset:'&&url.hostname==='localhost') && !(url.hostname==='asset.localhost'&&['http:','https:'].includes(url.protocol)))throw Error('COMFY_IMAGE_LOCAL_REQUIRED');
    if(url.username||url.password||url.port||url.search||url.hash)throw Error('COMFY_IMAGE_LOCAL_REQUIRED');
    path=decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/,'$1');
    // Windows canonical paths may contain //?/. Rebuilding a working asset URL
    // treats its routing slash as part of that file path and changes the target.
    if(url.protocol==='http:'||url.protocol==='https:')assetSource=value;
  }
  if(!/^(?:[A-Za-z]:[\\/]|\/)/.test(path) || path.split(/[\\/]/).some(part=>part==='..') || path.includes('\0'))throw Error('COMFY_IMAGE_LOCAL_REQUIRED');
  // Reuse the asset protocol already used by canvas previews/export. The host's
  // default fs capability does not grant stat/open/read; do not broaden it.
  return readLocalImage(assetSource??convertFileSrc(path),signal);
}
async function readLocalImage(source:string, signal?:AbortSignal):Promise<string> {
  try {return encode(await readMediaBytes(source,signal??AbortSignal.timeout(15000),MAX_BYTES));}
  catch(error) {
    if(signal?.aborted)throw error;
    const code=String(error);
    if(code.includes('too-large')||code.includes('COMFY_IMAGE_TOO_LARGE'))throw Error('COMFY_IMAGE_TOO_LARGE');
    if(code.includes('empty-media')||code.includes('COMFY_IMAGE_INVALID'))throw Error('COMFY_IMAGE_INVALID');
    throw Error('COMFY_IMAGE_LOCAL_READ_FAILED');
  }
}
