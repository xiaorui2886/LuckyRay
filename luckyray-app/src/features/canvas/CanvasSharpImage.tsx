import {useEffect,useRef,useState} from 'react';
import {useStore} from '@xyflow/react';
import {createImageUpgradeQueue} from '../../core/canvas/imageUpgradeQueue';
const upgrades=createImageUpgradeQueue(2);

type Props={source:string;preview?:string;alt:string;className?:string;selected?:boolean;fallback:string;onDimensions?:(width:number,height:number)=>void};
/** Sample zoom by quarter steps; retain the decoded original after upgrading. */
export function CanvasSharpImage(props:Props){
 const zoom=useStore(s=>Math.ceil(s.transform[2]*4)/4);
 return <SharpImageView key={props.source+'|'+(props.preview||'')} {...props} zoom={zoom}/>;
}
export function SharpImageView({source,preview,alt,className,selected=false,fallback,onDimensions,zoom}:{zoom:number}&Props){
 const image=useRef<HTMLImageElement>(null),dimensionCallback=useRef(onDimensions);dimensionCallback.current=onDimensions;
 const [width,setWidth]=useState(300),[previewWidth,setPreviewWidth]=useState(0),[near,setNear]=useState(false),[intent,setIntent]=useState(false);
 const [ready,setReady]=useState(false),[failed,setFailed]=useState(false),[previewFailed,setPreviewFailed]=useState(false),[wanted,setWanted]=useState(false);
 const hasPreview=!!preview&&preview!==source;
 useEffect(()=>{
  const el=image.current;if(!el)return;
  if(typeof ResizeObserver!=='undefined'){const ro=new ResizeObserver(()=>setWidth(el.clientWidth||300));ro.observe(el);return()=>ro.disconnect();}
 },[]);
 useEffect(()=>{
  const el=image.current;if(!el)return;
  if(typeof IntersectionObserver==='undefined'){setNear(true);return;}
  const io=new IntersectionObserver(entries=>setNear(entries.some(e=>e.isIntersecting)),{rootMargin:'160px'});io.observe(el);return()=>io.disconnect();
 },[]);
 useEffect(()=>{
  const demand=width*zoom*Math.max(1,globalThis.devicePixelRatio||1);
  if(source&&hasPreview&&(selected||intent||previewFailed||(near&&demand>=(previewWidth||512)*.65)))setWanted(true);
 },[source,hasPreview,selected,intent,near,width,zoom,previewWidth,previewFailed]);
 useEffect(()=>{
  if(!wanted||!source||!hasPreview)return;
  return upgrades.enqueue(done=>{
   let cancelled=false;const full=new Image();full.decoding='async';
   full.onload=async()=>{try{if(typeof full.decode==='function')await full.decode();if(!cancelled){setReady(true);dimensionCallback.current?.(full.naturalWidth,full.naturalHeight);}}catch{if(!cancelled)setFailed(true);}finally{done();}};
   full.onerror=()=>{if(!cancelled)setFailed(true);done();};full.src=source;
   return()=>{cancelled=true;full.onload=null;full.onerror=null;full.src='';};
  },selected||intent);
 },[wanted,source,hasPreview]);
 const displayed=ready||!hasPreview?source:preview!;
 if(!displayed||(failed&&(!hasPreview||previewFailed)))return <div className="canvas-node-media-fallback">{fallback}</div>;
 return <img ref={image} src={displayed} alt={alt} className={className} draggable={false} decoding="async"
  onPointerEnter={()=>setIntent(true)} data-image-detail={ready||!hasPreview?'original':'preview'}
  onLoad={event=>{const el=event.currentTarget;if(!ready&&hasPreview)setPreviewWidth(el.naturalWidth);else dimensionCallback.current?.(el.naturalWidth,el.naturalHeight);}}
  onError={()=>{if(ready||!hasPreview){setReady(false);setFailed(true);}else setPreviewFailed(true);}}/>;
}
