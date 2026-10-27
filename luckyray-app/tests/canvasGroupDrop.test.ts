import test from 'node:test';
import assert from 'node:assert/strict';
import {snapCanvasGroupDrop} from '../src/core/canvas/canvasArrangement';
const group=(id:string,x:number,y:number)=>({id,data:{kind:'group'},position:{x,y},style:{width:500,height:400}});
test('drop aligns the group once while retaining child-local positions and data',()=>{
 const parent=group('group',103,151),child={id:'child',parentId:'group',data:{kind:'image',refMediaUrl:'/slice.png'},position:{x:32,y:56}};
 const nodes=[parent,child],next=snapCanvasGroupDrop(nodes,'group',['group','child'],[28,28]);
 assert.deepEqual(next[0].position,{x:112,y:140});assert.equal(next[1],child);assert.equal(nodes[0],parent);assert.deepEqual(parent.position,{x:103,y:151});
});
test('co-selected roots retain their relative spacing, including nested children',()=>{
 const a=group('a',103,151),b=group('b',411,199),child={id:'nested',parentId:'a',data:{kind:'image'},position:{x:21,y:31}},leaf={...child,id:'leaf',parentId:'nested'};
 const next=snapCanvasGroupDrop([a,b,child,leaf],'a',['a','b','leaf'],[28,28]);
 assert.equal(next[1].position.x-next[0].position.x,b.position.x-a.position.x);assert.equal(next[1].position.y-next[0].position.y,b.position.y-a.position.y);assert.equal(next[2],child);assert.equal(next[3],leaf);
});
test('co-selected constrained nodes cannot be snapped outside their parent',()=>{
 const a=group('a',103,151),parent=group('p',600,0),child={id:'c',parentId:'p',extent:'parent',data:{kind:'image'},style:{width:100,height:100},position:{x:398,y:0}};
 const next=snapCanvasGroupDrop([a,parent,child],'a',['a','c'],[28,28]);
 assert.ok(next[2].position.x<=400&&next[2].position.y>=0);assert.equal(next[0].position.x-a.position.x,next[2].position.x-child.position.x);
});
test('already aligned group and non-group drags remain no-ops',()=>{
 const nodes=[group('group',112,140)];assert.equal(snapCanvasGroupDrop(nodes,'group',['group'],[28,28]),nodes);
 const ordinary=[{id:'image',position:{x:13,y:17},data:{kind:'image'}}];assert.equal(snapCanvasGroupDrop(ordinary,'image',['image'],[28,28]),ordinary);
});
