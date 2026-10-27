import {readMediaBytes} from '../mediaDelivery';
import type {CanvasAgentImage} from './types';

/** Send a bounded visual reference, not a filename pretending to be an image. */
export async function prepareAgentImage(source:string,signal:AbortSignal):Promise<CanvasAgentImage>{
  const readController=new AbortController();
  const abort=()=>readController.abort();signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,15000);
  let bytes:Uint8Array;
  try{bytes=await readMediaBytes(source,readController.signal,12*1024*1024);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
  if(signal.aborted)throw Error('canvas-agent-cancelled');
  const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  try{
    if(!bitmap.width||!bitmap.height)throw Error('canvas-agent-image-unavailable');
    const scale=Math.min(1,1280/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext('2d');if(!ctx)throw Error('canvas-agent-image-unavailable');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    for(const quality of [.75,.55,.35]){
      const data=canvas.toDataURL('image/jpeg',quality).split(',')[1];
      if(data&&data.length<=Math.floor(128*1024/3)*4){if(signal.aborted)throw Error('canvas-agent-cancelled');return {mimeType:'image/jpeg',data};}
    }
    const reduced=document.createElement('canvas');reduced.width=Math.max(1,Math.round(canvas.width*.6));reduced.height=Math.max(1,Math.round(canvas.height*.6));reduced.getContext('2d')?.drawImage(canvas,0,0,reduced.width,reduced.height);
    const data=reduced.toDataURL('image/jpeg',.45).split(',')[1];if(!data||data.length>174764)throw Error('canvas-agent-image-unavailable');return {mimeType:'image/jpeg',data};
  }finally{bitmap.close();}
}
