import { aspectFrame } from '../../core/canvas/mediaOptionPresentation';

export function CanvasAspectOptions({options,value,onChange,label}:{options:readonly string[];value:string|undefined;onChange:(value:string)=>void;label:string}) {
  return <div className="canvas-aspect-options" role="group" aria-label={label}>
    {options.map(option=>{
      const frame=aspectFrame(option),selected=value===option;
      return <button type="button" key={option} className={selected?'is-selected is-active':''} aria-pressed={selected} aria-label={option==='auto'?'自动比例':option} onClick={()=>onChange(option)}>
        <svg className="canvas-aspect-glyph" viewBox="0 0 36 28" aria-hidden="true" focusable="false">
          <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx="1.5" strokeDasharray={frame.automatic?'3 3':undefined}/>
        </svg>
        <span>{option==='auto'?'自动':option}</span>
      </button>;
    })}
  </div>;
}
