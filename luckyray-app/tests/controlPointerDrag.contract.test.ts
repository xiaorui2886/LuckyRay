import test from 'node:test';
import assert from 'node:assert/strict';
import {beginControlPointerDrag} from '../src/workspace/controlPointerDrag.ts';
class Target {
 listeners=new Map<string,Set<(event:any)=>void>>();hidden=false;
 addEventListener(type:string,listener:(event:any)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(listener);}
 removeEventListener(type:string,listener:(event:any)=>void){this.listeners.get(type)?.delete(listener);}
 emit(type:string,extra:Record<string,unknown>={}){const event={detail:1,pointerId:1,clientX:60,clientY:10,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){},...extra};for(const listener of [...this.listeners.get(type)??[]])listener(event);}
}
class Element extends Target {
 dataset:Record<string,string>={};group!:Element;children:Element[]=[];capture:number|null=null;
 classList={add:(_v:string)=>{},remove:(_v:string)=>{}};rect={left:0,right:180,top:0,bottom:40,width:180,height:40};
 contains(other:unknown){return other===this;}closest(){return this.group;}querySelectorAll(){return this.children;}getBoundingClientRect(){return this.rect;}
 setPointerCapture(id:number){this.capture=id;}hasPointerCapture(id:number){return this.capture===id;}releasePointerCapture(_id:number){this.capture=null;this.emit('lostpointercapture');}
}
function fixture(){const host=new Target(),document=new Target(),group=new Element(),source=new Element(),peer=new Element();group.dataset.controlAxis='horizontal';source.dataset.controlId='first';peer.dataset.controlId='second';source.group=group;peer.group=group;group.children=[source,peer];peer.rect={left:60,right:100,top:0,bottom:40,width:40,height:40};(globalThis as any).window=host;(globalThis as any).document=document;(globalThis as any).Node=Element;const moved:unknown[]=[];beginControlPointerDrag({button:0,pointerId:1,clientX:10,clientY:10,currentTarget:source as unknown as HTMLElement},(id,index)=>moved.push([id,index]));return {host,document,source,moved};}
test('control captures pointer after threshold; outside release cancels instead of stale commit',()=>{const f=fixture();f.host.emit('pointermove',{clientX:120});assert.equal(f.source.capture,1);f.host.emit('pointerup',{clientX:400});assert.deepEqual(f.moved,[]);assert.equal(f.source.capture,null);f.host.emit('pointermove',{clientX:120});f.host.emit('pointerup',{clientX:120});assert.deepEqual(f.moved,[]);});
test('lost capture cancels drag and removes stale listeners',()=>{const f=fixture();f.host.emit('pointermove',{clientX:120});f.source.emit('lostpointercapture');f.host.emit('pointerup',{clientX:120});assert.deepEqual(f.moved,[]);assert.equal(f.host.listeners.get('pointermove')?.size,0);});
test('foreign pointer cancellation does not cancel the active drag',()=>{const f=fixture();f.host.emit('pointermove',{clientX:120});f.host.emit('pointercancel',{pointerId:9});f.host.emit('pointerup',{clientX:120});assert.deepEqual(f.moved,[['first',1]]);});
test('visibility loss cancels instead of resuming on a later pointerup',()=>{const f=fixture();f.host.emit('pointermove',{clientX:120});f.document.hidden=true;f.document.emit('visibilitychange');f.host.emit('pointerup',{clientX:120});assert.deepEqual(f.moved,[]);});
