/** Suppress only the activation belonging to a drag, including an Escape press
 * while the physical pointer remains down. Keyboard clicks stay available. */
export function suppressPointerActivation(source:HTMLElement,pointerId:number,released=false){
 let timer:ReturnType<typeof setTimeout>|undefined;
 const clear=()=>{if(timer)clearTimeout(timer);window.removeEventListener('click',click,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);window.removeEventListener('pointerdown',clear,true);};
 const click=(event:MouseEvent)=>{
  if(event.detail!==0 && event.target instanceof Node && (source.contains(event.target)||event.target===source)){
   event.preventDefault();event.stopImmediatePropagation();clear();
  }
 };
 const up=(event:PointerEvent)=>{if(event.pointerId===pointerId)timer=setTimeout(clear,0);};
 window.addEventListener('click',click,true);
 // A fresh physical gesture can never be the activation from this cancelled drag.
 window.addEventListener('pointerdown',clear,true);
 if(released)timer=setTimeout(clear,0);
 else{window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);}
 return clear;
}
