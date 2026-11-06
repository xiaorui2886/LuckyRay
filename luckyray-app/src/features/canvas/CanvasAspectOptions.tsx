import { aspectFrame } from '../../core/canvas/mediaOptionPresentation';

export const COMFY_IMAGE_SIZES=[['square','1:1',1024,1024],['wide','16:9',1280,720],['tall','9:16',720,1280],['photo','3:2',1152,768],['portrait','2:3',768,1152],['standard','4:3',1024,768],['poster','3:4',768,1024]] as const;

export function CanvasAspectGlyph({value}: {value: string}) {
  const frame=aspectFrame(value);
  return <svg className="canvas-aspect-glyph" viewBox="0 0 36 28" aria-hidden="true" focusable="false"><rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx="1.5" strokeDasharray={frame.automatic?'3 3':undefined}/></svg>;
}

export function CanvasAspectOptions({options,value,onChange,label}:{options:readonly string[];value:string|undefined;onChange:(value:string)=>void;label:string}) {
  return <div className="canvas-aspect-options" role="group" aria-label={label}>
    {options.map(option=>{
      const selected=value===option;
      return <button type="button" key={option} className={selected?'is-selected is-active':''} aria-pressed={selected} aria-label={option==='auto'?'自动比例':option} onClick={()=>onChange(option)}>
        <CanvasAspectGlyph value={option}/>
        <span>{option==='auto'?'自动':option}</span>
      </button>;
    })}
  </div>;
}
