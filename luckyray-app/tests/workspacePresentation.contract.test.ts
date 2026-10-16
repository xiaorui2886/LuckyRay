import {test} from 'node:test';
import assert from 'node:assert/strict';
import {arrangeControls,decodeOrder,decodePresentation,defaultPresentation,reorderControl} from '../src/workspace/presentation.ts';
import {LayoutStore} from '../src/workspace/layoutStore.ts';
import {NamedLayouts} from '../src/workspace/namedLayouts.ts';
test('configuration only reorders known controls and appends new version controls',()=>{
 assert.deepEqual(decodeOrder({order:['old-removed','b','a'],hidden:['b','unknown']},['a','b','new']),{order:['b','a','new'],hidden:['b']});
 assert.deepEqual(arrangeControls([{id:'a'},{id:'b'},{id:'new'}],{order:['b','a'],hidden:['b']}),[{id:'a'},{id:'new'}]);
 assert.equal(decodeOrder({order:['a','a'],hidden:[]},['a']),null);assert.equal(decodeOrder({order:['a'],hidden:[null]},['a']),null);
});
test('order moves preserve visibility and reject unknown/invalid drops',()=>{
 const value={order:['a','b','c'],hidden:['b']};assert.deepEqual(reorderControl(value,'c',0),{order:['c','a','b'],hidden:['b']});assert.equal(reorderControl(value,'foreign',1),value);assert.equal(reorderControl(value,'a',NaN),value);
});
test('presentation participates in named layouts/undo without leaking unrecognized fields',()=>{
 const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
 const store=new LayoutStore('main',storage),presentation=defaultPresentation();presentation.toolbar.hidden=['open-graph'];presentation.navigation.space.order.reverse();
 store.dispatch({type:'presentation',presentation});const library=new NamedLayouts('main',storage);const saved=library.save('编辑',store.getSnapshot());store.dispatch({type:'presentation',presentation:defaultPresentation()});store.restore(saved.layout);
 assert.deepEqual(store.getSnapshot().presentation?.toolbar.hidden,['open-graph']);store.undo();assert.deepEqual(store.getSnapshot().presentation?.toolbar.hidden,[]);
 assert.ok(!JSON.stringify(decodePresentation({...presentation,token:'SECRET'})).includes('SECRET'));
});
