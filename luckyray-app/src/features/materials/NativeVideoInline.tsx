import { useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { NativeFilmTransport, nativeFilmAvailable, transientNativeVideoError } from "./nativeFilmTransport";
import { nativeVideoMetadata } from "./nativeVideoPreview";
import { observeVideoSurface } from "./nativeVideoSurface";
import { filmTime } from "./materialFilmTools";
import "./nativeVideoInline.css";
import {useMaterialViewScope} from './MaterialViewContext';

/** Same local player as cinema mode, with ordinary preview controls/inspector. */
export function NativeVideoInline({libraryId,assetId,poster,style,onClaim,onDimensions}:{libraryId:string;assetId:string;poster?:string;style?:CSSProperties;onClaim:(claimed:boolean)=>void;onDimensions:(width:number,height:number)=>void}) {
  const scope=useMaterialViewScope();const visible=scope?.visible??true;
  const retainedPosition=useRef<number|null>(null);
  const surface=useRef<HTMLDivElement>(null), player=useRef<NativeFilmTransport|null>(null);
  const callbacks=useRef({onClaim,onDimensions});callbacks.current={onClaim,onDimensions};
  const [claimed,setClaimed]=useState(true),[ready,setReady]=useState(false),[failure,setFailure]=useState("");
  const [state,setState]=useState({time:0,duration:0,paused:true}),[muted,setMuted]=useState(true);
  useEffect(()=>{
    if(!visible)return;
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;const abort=new AbortController();let transport:NativeFilmTransport|null=null;
    let stopSurface:(()=>void)|undefined;setReady(false);
    void nativeFilmAvailable().then(async available=>{
      if(disposed)return;
      if(!available){setClaimed(false);callbacks.current.onClaim(false);return;}
      // A cached metadata reply can settle before React commits the claimed
      // renderer. Native window creation needs its real, mounted rectangle.
      flushSync(()=>{setClaimed(true);callbacks.current.onClaim(true)});
      try{
        const metadata=await nativeVideoMetadata(libraryId,assetId,abort.signal,true);
        if(disposed)return;callbacks.current.onDimensions(metadata.width,metadata.height);
        // React has mounted the surface by the time metadata returns.
        const rect=surface.current?.getBoundingClientRect();if(!rect)throw Error("native-video-surface-unavailable");
        const dpr=window.devicePixelRatio;
        transport=new NativeFilmTransport(e=>{if(!disposed)setFailure(String(e))});
        await transport.open(libraryId,assetId,metadata.sourceRevision,{x:Math.max(0,Math.round(rect.x*dpr)),y:Math.max(0,Math.round(rect.y*dpr)),width:Math.max(1,Math.round(rect.width*dpr)),height:Math.max(1,Math.round(rect.height*dpr))});
        if(disposed){transport.close();return}
        player.current=transport;transport.muted=true;setReady(true);
        if(surface.current)stopSurface=observeVideoSurface(surface.current,transport,e=>{if(!disposed)setFailure(String(e))});
        if(retainedPosition.current!==null){transport.currentTime=retainedPosition.current;transport.pause();}
        else await transport.play();
        const poll=async()=>{if(disposed||!transport)return;try{const snapshot=await transport.snapshot();if(!disposed)setState(snapshot)}catch(e){if(!transientNativeVideoError(e)){if(!disposed)setFailure(`视频会话已停止：${String(e)}`);return}}if(!disposed)timer=setTimeout(()=>void poll(),80)};
        void poll();
      }catch(e){transport?.close();if(!disposed)setFailure(`此视频暂时无法预览：${String(e)}`);}
    });
    return()=>{disposed=true;abort.abort();clearTimeout(timer);stopSurface?.();if(transport&&scope)retainedPosition.current=transport.currentTime;transport?.close();player.current=null};
  },[libraryId,assetId,visible]);
  const play=()=>{const p=player.current;if(!p)return;if(p.paused)void p.play().catch(e=>setFailure(String(e)));else p.pause()};
  if(!claimed)return null;
  return <div className={`native-video-inline${ready?' ready':''}`} style={style} tabIndex={0} aria-label="视频预览" onPointerDown={e=>{e.stopPropagation();if(!(e.target as HTMLElement).closest('input,button'))e.currentTarget.focus()}} onKeyDown={e=>{if((e.key===' '||e.key.toLowerCase()==='k')&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();if(!e.repeat)play()}}}>
    <div ref={surface} className="native-video-inline-picture" onClick={play}>{!ready&&<>{poster&&<img src={poster} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'contain'}}/>}{(failure||!poster)&&<span style={{position:'relative'}}>{failure||'正在打开视频…'}</span>}</>}</div>
    {ready&&<div className="native-video-inline-controls"><button aria-label={state.paused?'播放视频':'暂停视频'} onClick={play}>{state.paused?'▶':'Ⅱ'}</button><span>{filmTime(state.time)} / {filmTime(state.duration)}</span><input aria-label="视频预览时间线" type="range" min={0} max={state.duration||1} step={.01} value={state.time} onChange={e=>{if(player.current)player.current.currentTime=Number(e.target.value)}}/><button aria-label={muted?'取消静音':'静音'} onClick={()=>{setMuted(!muted);if(player.current)player.current.muted=!muted}}>{muted?'静音':'声音'}</button></div>}
    {ready&&failure&&<div role="status" className="native-video-inline-error">{failure}</div>}
  </div>;
}
