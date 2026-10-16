import {availableMonitors,currentMonitor,getCurrentWindow} from '@tauri-apps/api/window';
import {workspaceCommand} from './nativeClient';
import {decodePlacement,recoverPlacement,type WindowPlacement} from './windowPlacement';
import type {ViewRef} from './layout';

/** Only registered content windows call this. Main geometry remains owned by
 * its existing lifecycle; we never reposition unrelated windows. */
export async function trackWorkspaceWindowPlacement(view:ViewRef,onError:(message:string)=>void){
 const window=getCurrentWindow();if(!window.label.startsWith('workspace-'))return ()=>{};
 const key=`luckyray-workspace-window-position-v1:${JSON.stringify([view.kind,view.library.id,view.resourceId])}`;
 let last:WindowPlacement|null=null;
 try{const raw=localStorage.getItem(key);last=raw?decodePlacement(JSON.parse(raw)):null;}catch{/* Invalid placement does not affect the document. */}
 if(last){
  const monitors=await availableMonitors();const recovered=recoverPlacement(last,monitors.map(m=>({name:m.name,x:m.workArea.position.x,y:m.workArea.position.y,width:m.workArea.size.width,height:m.workArea.size.height,scale:m.scaleFactor})));
  if(recovered){await workspaceCommand({op:'restorePlacement',x:recovered.x,y:recovered.y,width:recovered.width,height:recovered.height,maximized:recovered.maximized});last=recovered;}
 }
 let disposed=false;let timer:ReturnType<typeof setTimeout>|undefined;let running=false;let pending=false;
 const save=async()=>{
  if(disposed)return;if(running){pending=true;return;}running=true;
  try{
   if(await window.isMinimized())return;
   const maximized=await window.isMaximized();
   if(maximized&&last){last={...last,maximized};}
   else if(!maximized){const [position,size,scale,monitor]=await Promise.all([window.outerPosition(),window.innerSize(),window.scaleFactor(),currentMonitor()]);
    last={x:position.x,y:position.y,width:size.width/scale,height:size.height/scale,scale,monitor:monitor?.name??null,maximized:false};}
   if(last&&!disposed)localStorage.setItem(key,JSON.stringify(last));
  }catch{if(!disposed)onError('窗口位置暂未保存，笔记内容不受影响。');}
  finally{running=false;if(pending){pending=false;void save();}}
 };
 const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void save(),250);};
 const listeners=await Promise.all([window.onMoved(schedule),window.onResized(schedule),window.onScaleChanged(schedule)]);
 await save();return()=>{disposed=true;clearTimeout(timer);listeners.forEach(stop=>stop());};
}
