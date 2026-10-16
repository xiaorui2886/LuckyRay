import test from 'node:test';
import assert from 'node:assert/strict';
import {suppressPointerActivation} from '../src/workspace/pointerActivation.ts';
class FakeNode {contains(target:unknown){return target===this;}}
class FakeWindow {
 listeners=new Map<string,Set<(event:any)=>void>>();
 addEventListener(type:string,listener:(event:any)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(listener);}
 removeEventListener(type:string,listener:(event:any)=>void){this.listeners.get(type)?.delete(listener);}
 emit(type:string,extra:Record<string,unknown>={}){const event={detail:1,pointerId:1,prevented:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){},...extra};for(const listener of [...this.listeners.get(type)??[]])listener(event);return event;}
}
const setup=()=>{const host=new FakeWindow();(globalThis as any).window=host;(globalThis as any).Node=FakeNode;return {host,source:new FakeNode() as unknown as HTMLElement};};
test('Escape while pointer remains held suppresses its later mouse activation',()=>{
 const {host,source}=setup();const clear=suppressPointerActivation(source,1);host.emit('pointerup',{pointerId:1});assert.equal(host.emit('click',{target:source}).prevented,true);clear();
});
test('terminal pointercancel cannot swallow a new physical gesture',()=>{
 const {host,source}=setup();const clear=suppressPointerActivation(source,1);host.emit('pointerdown',{pointerId:1});host.emit('pointerup',{pointerId:1});assert.equal(host.emit('click',{target:source}).prevented,false);clear();
});
test('keyboard and unrelated clicks remain available during cancelled held gesture',()=>{
 const {host,source}=setup();const clear=suppressPointerActivation(source,1);assert.equal(host.emit('click',{target:source,detail:0}).prevented,false);assert.equal(host.emit('click',{target:new FakeNode()}).prevented,false);assert.equal(host.emit('click',{target:source}).prevented,true);clear();
});
test('new pointerdown clears a stale guard after release outside the window',()=>{
 const {host,source}=setup();const clear=suppressPointerActivation(source,7);host.emit('pointerdown',{pointerId:2});assert.equal(host.emit('click',{target:source}).prevented,false);clear();
});
