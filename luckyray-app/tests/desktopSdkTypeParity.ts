import type {DesktopExtensionApi as Implementation} from '../src/core/extensions/desktop/runtime';
import type {DesktopExtensionApi as Public, NoteRef} from '../plugin-sdk/desktop';
export function publicDesktopApi(api:Implementation):Public{return api;}
export async function eventWriteContextTypecheck(api:Public){
 await api.events.on<{documentRef:NoteRef}>('knowledge.saved',async(event,context)=>{
  if(!context)return;
  await Promise.resolve();
  await context.knowledge.append(event.documentRef,'synthetic');
  await context.materials.library('synthetic').importAssets({paths:['synthetic']});
 });
 await api.events.on('legacy.event',()=>{});
}
