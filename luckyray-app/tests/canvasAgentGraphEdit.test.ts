import test from 'node:test';
import assert from 'node:assert/strict';
import {editCanvasAgentGraph,type CanvasAgentGraphOperation} from '../src/core/canvas/agent/graphEdit.ts';
import {agentNodeRevision} from '../src/core/canvas/agent/context.ts';
import type {CanvasAgentContext} from '../src/core/canvas/agent/types.ts';
const nodes=()=>['a','b','c'].map((id,index)=>({id,position:{x:index*100,y:index*50},data:{kind:'text',label:id},width:100,height:80}));
const context=(ns:ReturnType<typeof nodes>,connections:{source:string;target:string}[]=[]):CanvasAgentContext=>({version:1,canvasId:'canvas',canvasName:'Test',nodes:ns.map(node=>({id:node.id,title:node.id,kind:'text',text:node.id,editable:true,revision:agentNodeRevision(node)})),connections,generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}});
const options={canvasId:'canvas',createId:()=>String(Math.random()),makeEdge:(source:{id:string},target:{id:string},id:string)=>({id,source:source.id,target:target.id})};
test('batch arrange and connect produce one new graph without mutating input',()=>{
 const ns=nodes(),before=structuredClone(ns);const result=editCanvasAgentGraph(context(ns),ns,[],[{op:'arrange',nodeIds:['a','b','c'],layout:'horizontal'},{op:'connect',source:'a',target:'b'}],options);
 assert.deepEqual(ns,before);assert.deepEqual(result.nodes.map(n=>n.position),[{x:0,y:0},{x:180,y:0},{x:360,y:0}]);assert.equal(result.edges.length,1);
});
test('invalid later operation cannot partially mutate earlier moved nodes',()=>{
 const ns=nodes(),before=structuredClone(ns);
 assert.throws(()=>editCanvasAgentGraph(context(ns),ns,[],[{op:'move',nodeId:'a',x:50,y:50},{op:'move',nodeId:'missing',x:0,y:0}],options),/context-stale/);assert.deepEqual(ns,before);
});
test('cycles across existing and newly connected edges are rejected atomically',()=>{
 const ns=nodes(),edges=[{id:'e',source:'a',target:'b'}];
 assert.throws(()=>editCanvasAgentGraph(context(ns,edges),ns,edges,[{op:'connect',source:'b',target:'c'},{op:'connect',source:'c',target:'a'}],options),/cycle/);assert.equal(edges.length,1);
});
test('foreign context nodes, invalid coordinates and stale edges fail closed',()=>{
 const ns=nodes();const ctx=context(ns);ctx.nodes=ctx.nodes.filter(n=>n.id!=='c');
 assert.throws(()=>editCanvasAgentGraph(ctx,ns,[],[{op:'move',nodeId:'c',x:1,y:1}],options),/stale/);
 for(const x of [Infinity,NaN,1_000_001])assert.throws(()=>editCanvasAgentGraph(context(ns),ns,[],[{op:'move',nodeId:'a',x,y:0}],options),/invalid/);
 assert.throws(()=>editCanvasAgentGraph(context(ns),ns,[{id:'e',source:'a',target:'b'}],[{op:'move',nodeId:'a',x:1,y:1}],options),/stale/);
});
test('disconnect only removes specified relationship and grouping is not implied',()=>{
 const ns=nodes(),edges=[{id:'e1',source:'a',target:'b'},{id:'e2',source:'b',target:'c'}];
 const result=editCanvasAgentGraph(context(ns,edges),ns,edges,[{op:'disconnect',source:'a',target:'b'}],options);assert.deepEqual(result.edges,[edges[1]]);
 assert.throws(()=>editCanvasAgentGraph(context(ns),ns,[],[{op:'delete',nodeId:'a'} as unknown as CanvasAgentGraphOperation],options),/invalid/);
});
test('concurrent node moves invalidate revision, and grouped-coordinate moves are refused',()=>{
 const ns=nodes(),ctx=context(ns);ns[0].position.x=99;
 assert.throws(()=>editCanvasAgentGraph(ctx,ns,[],[{op:'move',nodeId:'a',x:2,y:2}],options),/stale/);
 const grouped=nodes().map((node,index)=>({...node,...(index===0?{parentId:'group'}:{})}));
 assert.throws(()=>editCanvasAgentGraph(context(grouped),grouped,[],[{op:'arrange',nodeIds:['a','b'],layout:'grid'}],options),/invalid/);
});
