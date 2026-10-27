import { Component, createRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { sanitizeDirectorScene } from '../../../core/canvas/director/model';
import { assertDirectorCapture } from '../../../core/canvas/director/integration';
import type { DirectorScene, DirectorViewportHandle } from '../../../core/canvas/director/types';
import { DirectorViewport } from './DirectorViewport';

class CaptureBoundary extends Component<{children:ReactNode;onFailure:(error:Error)=>void},{failed:boolean}> {
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error:Error){this.props.onFailure(error);}
 render(){return this.state.failed?null:this.props.children;}
}
const abortError=()=>new Error('director-capture-aborted');
/** Render a frozen scene with the SAME native viewport/capture path as the Director UI.
 * flushSync completes the viewport's layout-effect runtime initialization before capture;
 * capture itself synchronizes geometry and renders shotCamera. No timers simulate readiness,
 * no editor clicks, no mock/fallback image, and no callbacks can mutate the user's document.
 */
export async function captureDirectorScene(scene:DirectorScene,options:{signal:AbortSignal;english?:boolean}):Promise<string>{
 if(options.signal.aborted)throw abortError();
 const snapshot=sanitizeDirectorScene(scene);
 if(!snapshot)throw Error('invalid-director-scene');
 if(typeof document==='undefined'||!document.body)throw Error('director-renderer-unavailable');
 const host=document.createElement('div');
 host.dataset.directorCapture='true';host.setAttribute('aria-hidden','true');host.inert=true;
 Object.assign(host.style,{position:'fixed',left:'-10000px',top:'0',width:'960px',height:'540px',pointerEvents:'none',overflow:'hidden'});
 const viewport=createRef<DirectorViewportHandle>();
 let root:Root|undefined,failure:Error|undefined,abort:()=>void=()=>{};
 try{
  document.body.appendChild(host);root=createRoot(host);
  flushSync(()=>root!.render(<CaptureBoundary onFailure={error=>{failure=error;}}>
   <DirectorViewport ref={viewport} scene={snapshot} selectedId={null} selectedIds={[]} mode="camera" transform="translate" guides={false}
    onSelect={()=>{}} onSelectionChange={()=>{}} onTransform={()=>false} onTransforms={()=>false} onCameraChange={()=>false}
    cameraSelected={false} poseEditing={false} onError={message=>{if(message)failure=new Error(message);}} english={options.english}/>
  </CaptureBoundary>));
  if(options.signal.aborted)throw abortError();
  if(failure)throw failure;
  if(!viewport.current||!host.querySelector('canvas'))throw Error('director-renderer-unavailable');
  // Register first so cancellation cannot strand an asynchronous renderer implementation.
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(abortError());options.signal.addEventListener('abort',abort,{once:true});});
  const png=await Promise.race([viewport.current.capture(),cancelled]);
  if(options.signal.aborted)throw abortError();
  if(failure)throw failure;
  assertDirectorCapture(png);
  return png;
 }finally{
  options.signal.removeEventListener('abort',abort);
  try{if(root)flushSync(()=>root!.unmount());}finally{host.remove();}
 }
}
