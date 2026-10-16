import test from 'node:test';
import assert from 'node:assert/strict';
import {beginNotesTabPointerDrag,cancelNotesTabPointerDrag,NOTES_DOCK_TAB_EVENT} from '../src/features/notes/notesPaneDocking';
class Rect { left:number;top:number;width:number;height:number;constructor(left=0,top=0,width=0,height=0){Object.assign(this,{left,top,width,height});} get right(){return this.left+this.width;}get bottom(){return this.top+this.height;} }
class TargetStub extends EventTarget {
 addEventListener(type:string,callback:any,options:any=false){super.addEventListener(type,callback,typeof options === 'boolean'?{capture:options}:options);}
 removeEventListener(type:string,callback:any,options:any=false){super.removeEventListener(type,callback,typeof options === 'boolean'?{capture:options}:options);}
}
class ElementStub extends TargetStub {
 dataset:Record<string,string>={};style:Record<string,string>={};className='';textContent='';removed=false;captured=false;
 classes=new Set<string>();classList={add:(name:string)=>this.classes.add(name),remove:(name:string)=>this.classes.delete(name)};
 rect=new Rect(100,100,800,600);tabs:ElementStub[]=[];button=false;strip:ElementStub|null=null;pane:ElementStub|null=null;
 closest(selector:string){if(selector.startsWith('button'))return this.button?this:null;if(selector.includes('dock-tabs'))return this.strip;if(selector.includes('dock-pane'))return this.pane;return null;}
 getBoundingClientRect(){return this.rect;}querySelectorAll(){return this.tabs;}setAttribute(){}remove(){this.removed=true;}
 hasPointerCapture(){return this.captured;}setPointerCapture(){this.captured=true;}releasePointerCapture(){this.captured=false;}contains(node:unknown){return node===this;}
}
function fixture(){
 const previous=Object.fromEntries(['window','document','HTMLElement','Element','Node','DOMRect','CustomEvent'].map(key=>[key,(globalThis as any)[key]]));
 const win:any=new TargetStub();win.innerWidth=1200;win.innerHeight=900;win.setTimeout=(fn:()=>void,ms:number)=>setTimeout(()=>{const current=(globalThis as any).window;(globalThis as any).window=win;try{fn();}finally{(globalThis as any).window=current;}},ms);
 const body:any=new ElementStub();body.children=[];body.append=(...nodes:any[])=>body.children.push(...nodes);
 const doc:any=new TargetStub();doc.body=body;doc.hidden=false;doc.createElement=()=>new ElementStub();let hit:any=null;doc.elementFromPoint=()=>hit;
 Object.assign(globalThis,{window:win,document:doc,HTMLElement:ElementStub,Element:ElementStub,Node:ElementStub,DOMRect:Rect,CustomEvent:class extends Event{detail:any;constructor(type:string,options:any){super(type);this.detail=options.detail;}}});
 const source=new ElementStub();source.rect=new Rect(100,20,160,40);const pane=new ElementStub();pane.dataset.notesDockPane='right';pane.pane=pane;hit=pane;
 const requests:any[]=[];win.addEventListener(NOTES_DOCK_TAB_EVENT,(event:any)=>requests.push(event.detail));
 const fire=(type:string,props:any={})=>{const event=new Event(type,{cancelable:true});Object.assign(event,{pointerId:7,clientX:110,clientY:30,button:0,...props});win.dispatchEvent(event);return event;};
 const start=()=>beginNotesTabPointerDrag({button:0,isPrimary:true,pointerId:7,clientX:110,clientY:30,currentTarget:source,target:source,stopPropagation(){}} as any,{sourcePaneId:'root',tabId:'note',title:'Note'});
 return {win,body,source,pane,requests,fire,start,setHit(value:any){hit=value;},async cleanup(){cancelNotesTabPointerDrag();fire('pointerup');await new Promise(resolve=>setTimeout(resolve,5));Object.assign(globalThis,previous);}};
}
test('pointer threshold preserves click; directional pointer drop commits once without HTML5 drag',async()=>{
 const f=fixture();try{
  f.start();f.fire('pointermove',{clientX:112,clientY:31});f.fire('pointerup');assert.equal(f.requests.length,0);assert.equal(f.body.children.length,0);
  f.start();f.fire('pointermove',{clientX:895,clientY:400});assert.equal(f.body.children.length,2);f.fire('pointerup',{clientX:895,clientY:400});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].zone,'right');assert.equal(f.requests[0].tabId,'note');assert.ok(f.body.children.every((e:any)=>e.removed));
 }finally{await f.cleanup();}
});
test('Escape while pointer remains held suppresses its later activation and leaves layout unchanged',async()=>{
 const f=fixture();try{
  f.start();f.fire('pointermove',{clientX:500,clientY:400});f.fire('keydown',{key:'Escape'});
  await new Promise(resolve=>setTimeout(resolve,20));
  f.fire('pointerup',{clientX:110,clientY:30});
  const click=new Event('click',{cancelable:true});Object.defineProperties(click,{detail:{value:1},target:{value:f.source}});f.win.dispatchEvent(click);
  assert.equal(click.defaultPrevented,true);assert.equal(f.requests.length,0);assert.ok(f.body.children.every((e:any)=>e.removed));
 }finally{await new Promise(resolve=>setTimeout(resolve,5));await f.cleanup();}
});
test('pointer cancel, lost capture, blur and outside release never commit docking',async()=>{
 for(const cancel of ['pointercancel','blur','lostpointercapture','outside']){
  const f=fixture();try{f.start();f.fire('pointermove',{clientX:500,clientY:400});
   if(cancel==='lostpointercapture')f.source.dispatchEvent(new Event('lostpointercapture'));
   else if(cancel==='outside'){f.setHit(null);f.fire('pointerup',{clientX:-10,clientY:400});}
   else f.fire(cancel);
   assert.equal(f.requests.length,0,cancel);assert.ok(f.body.children.every((e:any)=>e.removed),cancel);
  }finally{await f.cleanup();}
 }
});
