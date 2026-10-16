import {useMemo,useState,useEffect,useRef} from 'react';
import type {CanvasGenerationHistoryEntry} from '../../core/canvas/generationHistory';
import {reviewImages,comparisonParameters,type ReviewImage} from '../../core/canvas/creativeReview';
import {CanvasCreativeDialog} from './CanvasCreativeDialog';
import './canvasCreative.css';

export function CanvasVersionReview({history,initialId,resolveUrl,onPick,onRestore,onClose,english=false}:{
 history:readonly CanvasGenerationHistoryEntry[];initialId?:string;resolveUrl:(url:string)=>string;
 onPick:(entryId:string,index:number)=>void;onRestore:(entry:CanvasGenerationHistoryEntry)=>void;onClose:()=>void;english?:boolean;
}) {
 const choices=useMemo(()=>reviewImages(history),[history]);
 const [leftKey,setLeft]=useState(()=>choices.find(item=>item.entry.id===initialId)?.key||choices[0]?.key||'');
 const [rightKey,setRight]=useState(()=>choices.find(item=>item.entry.id!==initialId)?.key||choices[1]?.key||'');
 const [mode,setMode]=useState<'side'|'slider'>('side'),[split,setSplit]=useState(50),[zoom,setZoom]=useState(1);
 const [pan,setPan]=useState({x:0,y:0}),[onlyPicks,setOnlyPicks]=useState(false);
 const drag=useRef<{x:number;y:number;px:number;py:number;width:number;height:number}|null>(null);
 const options=choices.filter(item=>!onlyPicks||item.entry.preferredImageIndexes?.includes(item.index));
 const left=options.find(item=>item.key===leftKey)||options[0];
 const right=options.find(item=>item.key===rightKey&&item.key!==left?.key)||options.find(item=>item.key!==left?.key);
 useEffect(()=>{setZoom(1);setPan({x:0,y:0});},[left?.key,right?.key]);
 const label=(item:ReviewImage)=>`${item.entry.model|| (english?'Default model':'默认模型')} · ${new Date(item.entry.createdAt).toLocaleString(english?'en-US':'zh-CN')} · #${item.index+1}`;
 const image=(item:ReviewImage)=> <ReviewMedia key={item.key} url={resolveUrl(item.url)} label={label(item)} zoom={zoom} pan={pan} english={english}/>;
 const viewportProps={onPointerDown:(e:React.PointerEvent<HTMLDivElement>)=>{
  if(e.button!==0||zoom<=1)return;const rect=e.currentTarget.getBoundingClientRect();
  drag.current={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y,width:rect.width,height:rect.height};e.currentTarget.setPointerCapture(e.pointerId);
 },onPointerMove:(e:React.PointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d)return;
  const limit=50*(zoom-1);setPan({x:Math.max(-limit,Math.min(limit,d.px+(e.clientX-d.x)/Math.max(1,d.width)*100)),y:Math.max(-limit,Math.min(limit,d.py+(e.clientY-d.y)/Math.max(1,d.height)*100))});
 },onPointerUp:()=>{drag.current=null;},onPointerCancel:()=>{drag.current=null;}};
 const select=(item:ReviewImage|undefined,change:(v:string)=>void,side:string)=><label className="canvas-review-select"><span>{side}</span><select aria-label={side} value={item?.key||''} onChange={e=>change(e.target.value)}>{options.map(choice=><option key={choice.key} value={choice.key}>{label(choice)}</option>)}</select></label>;
 const actions=(item:ReviewImage|undefined)=>item?<div className="canvas-review-actions"><button type="button" aria-pressed={!!item.entry.preferredImageIndexes?.includes(item.index)} onClick={()=>onPick(item.entry.id,item.index)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L2 9.6l6.2-.9Z"/></svg>{english?'Keep':'优选'}</button><button type="button" onClick={()=>onRestore({...item.entry,outputMediaUrl:item.url,outputMediaItems:[{url:item.url}]})}>{english?'Add this image to canvas':'这张放回画布'}</button></div>:null;
 return <CanvasCreativeDialog title={english?'Version comparison':'版本对比'} onClose={onClose} english={english}>
  <div className="canvas-creative-tools"><div className="canvas-creative-segments"><button type="button" aria-pressed={mode==='side'} onClick={()=>setMode('side')}>{english?'Side by side':'并排'}</button><button type="button" aria-pressed={mode==='slider'} disabled={!right} onClick={()=>setMode('slider')}>{english?'Wipe':'滑杆'}</button></div>
   <label><input type="checkbox" checked={onlyPicks} onChange={e=>setOnlyPicks(e.target.checked)}/>{english?'Picks only':'只看优选'}</label>
   <label>{english?'Zoom':'同步缩放'}<input aria-label={english?'Synchronized zoom':'同步缩放'} type="range" min="1" max="4" step=".1" value={zoom} onChange={e=>{setZoom(Number(e.target.value));setPan({x:0,y:0});}}/></label><button type="button" onClick={()=>{setZoom(1);setPan({x:0,y:0});setSplit(50);}}>{english?'Fit':'适应画面'}</button>
  </div>
  {!left?<div className="canvas-creative-empty">{english?'No completed images here yet. Generate an image or turn off the picks filter.':'这里还没有可对比的图片。先生成图片，或关闭“只看优选”。'}</div>:<>
   <div className="canvas-review-selectors">{select(left,setLeft,english?'Image A':'版本 A')}{select(right,setRight,english?'Image B':'版本 B')}</div>
   <div className={`canvas-review-stage is-${mode}`}>
    {mode==='slider'&&right?<div className="canvas-review-viewport" {...viewportProps}>
      {image(left)}<div className="canvas-review-wipe" style={{clipPath:`inset(0 ${100-split}% 0 0)`}}>{image(right)}</div><div className="canvas-review-divider" style={{left:`${split}%`}}/>
      <span className="canvas-review-badge">B / A</span>
     </div>:<><div className="canvas-review-viewport" {...viewportProps}>{image(left)}<span className="canvas-review-badge">A</span></div><div className="canvas-review-viewport" {...viewportProps}>{right?image(right):<span>{english?'One more completed image is needed':'再完成一张图片即可对比'}</span>}<span className="canvas-review-badge">B</span></div></>}
   </div>
   {mode==='slider'&&right?<label className="canvas-review-range">{english?'Reveal B':'显示 B'}<input aria-label={english?'Comparison divider':'对比分隔位置'} type="range" min="0" max="100" value={split} onChange={e=>setSplit(Number(e.target.value))}/></label>:null}
   <div className="canvas-review-action-grid">{actions(left)}{actions(right)}</div>
   <p className="canvas-creative-hint">{english?'Images are fitted without stretching. Different aspect ratios may have margins; drag after zooming to inspect both views.':'按原比例适应画面，不拉伸；不同尺寸可能留白。放大后拖动可同步查看细节。'}</p>
   <div className="canvas-review-parameters">{[left,right].map((item,i)=>item?<section key={i} aria-label={i?'B parameters':'A parameters'}>{comparisonParameters(item.entry).map(([key,value])=><div key={key}><small>{({prompt:english?'Prompt':'提示词',model:english?'Model':'模型',aspect:english?'Aspect':'比例',quality:english?'Quality':'画质／分辨率',resolution:english?'Resolution':'分辨率',count:english?'Batch':'批次数量',references:english?'References':'参考数量'} as Record<string,string>)[key]}</small><span data-changed={!!right&&comparisonParameters(left.entry).find(([k])=>k===key)?.[1]!==comparisonParameters(right.entry).find(([k])=>k===key)?.[1]}>{value||'—'}</span></div>)}</section>:<section key={i}/>)}</div>
  </>}
 </CanvasCreativeDialog>;
}
function ReviewMedia({url,label,zoom,pan,english}:{url:string;label:string;zoom:number;pan:{x:number;y:number};english:boolean}){
 const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[url]);
 return failed?<span className="canvas-review-media-error">{english?'Image unavailable. The saved result is unchanged.':'图片暂不可用，已保存的结果不会被修改。'}</span>:<img src={url} alt={label} draggable={false} onError={()=>setFailed(true)} style={{transform:`translate(${pan.x}%,${pan.y}%) scale(${zoom})`}}/>;
}
