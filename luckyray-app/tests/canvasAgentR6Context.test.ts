import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {agentContextNodes,agentContextWorkingSet,agentGraphRevision,validateAgentContextCurrent} from '../src/core/canvas/agent/context.ts';
import {validateCanvasAgentPlan} from '../src/core/canvas/agent/plan.ts';
import {editCanvasAgentGraph} from '../src/core/canvas/agent/graphEdit.ts';
import type {CanvasAgentContext} from '../src/core/canvas/agent/types.ts';
const node=(id:string,label=id)=>({id,position:{x:0,y:0},data:{kind:'text',label}});
const makeContext=(nodes:ReturnType<typeof node>[],ids:string[],edges:{source:string;target:string}[]=[]):CanvasAgentContext=>({version:1,canvasId:'canvas',canvasName:'Canvas',snapshotRevision:agentGraphRevision(nodes,edges),nodes:agentContextNodes(nodes,ids),connections:edges.filter(e=>ids.includes(e.source)&&ids.includes(e.target)),generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}});
test('R6 single-node update keeps another known editable ID with freshly read revision',()=>{
 const before=[node('a'),node('b')];const initial=makeContext(before,['a','b']);
 const after=[node('a','updated'),node('b')];const ids=agentContextWorkingSet(after,['a'],initial.nodes.map(n=>n.id));
 const context=makeContext(after,ids);assert.deepEqual(ids,['a','b']);assert.notEqual(context.nodes[0].revision,initial.nodes[0].revision);
 assert.doesNotThrow(()=>validateCanvasAgentPlan({version:1,id:'p',canvasId:'canvas',runId:'r',title:'Edit B',summary:'',steps:[{id:'edit',kind:'text',targetNodeId:'b',title:'B',content:'changed',references:[]}]},context,'r'));
 assert.throws(()=>validateAgentContextCurrent(initial,after,'canvas'),/stale/);
});
test('R6 fresh working set forgets deleted retained nodes and induced links',()=>{
 const live=[node('a'),node('c')];const ids=agentContextWorkingSet(live,['c'],['a','b']);assert.deepEqual(ids,['c','a']);
 const c=makeContext(live,ids,[{source:'a',target:'b'},{source:'a',target:'c'}]);assert.deepEqual(c.connections,[{source:'a',target:'c'}]);
 assert.throws(()=>agentContextWorkingSet(live,['b'],['a']),/stale/);
});
test('R6 new page always wins over old working set; eviction is bounded and deterministic',()=>{
 const nodes=Array.from({length:600},(_,i)=>node(`n${i}`));const old=nodes.slice(0,256).map(n=>n.id),page=nodes.slice(256,512).map(n=>n.id);
 assert.deepEqual(agentContextWorkingSet(nodes,page,old),page);
 assert.deepEqual(agentContextWorkingSet(nodes,['n599'],old),['n599',...old.slice(0,255)]);
 assert.throws(()=>agentContextWorkingSet(nodes,nodes.slice(0,257).map(n=>n.id)),/limit/);
});
test('R6 snapshot identity detects text, geometry, deletion, order and links',()=>{
 const nodes=[node('a'),node('b')],edges=[{source:'a',target:'b'}];const revision=agentGraphRevision(nodes,edges);
 for(const [n,e] of [[ [node('a','changed'),node('b')],edges ],[ [{...node('a'),position:{x:10,y:0}},node('b')],edges ],[nodes.slice(0,1),[]],[nodes.slice().reverse(),edges],[nodes,[]]] as const)assert.notEqual(agentGraphRevision(n,e),revision);
 assert.equal(agentGraphRevision(nodes,edges),revision);
});
test('R6 refreshed edges preserve graph links and stale connections still reject writes',()=>{
 const nodes=[node('a'),node('b')],edges=[{id:'edge',source:'a',target:'b'}],context=makeContext(nodes,['a','b'],edges);
 const options={canvasId:'canvas',createId:()=> 'e2',makeEdge:(s:ReturnType<typeof node>,t:ReturnType<typeof node>,id:string)=>({id,source:s.id,target:t.id})};
 assert.equal(editCanvasAgentGraph(context,nodes,edges,[{op:'move',nodeId:'a',x:1,y:2}],options).edges.length,1);
 assert.throws(()=>editCanvasAgentGraph(context,nodes,[],[{op:'move',nodeId:'a',x:1,y:2}],options),/stale/);
});
test('R6 production executor reconciles all receipt paths and detects async mixed snapshots',()=>{
 const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 assert.match(source,/agentContextWorkingSet\(nodesRef\.current,ids,action\.context\?\.nodes/);
 assert.match(source,/agentContextWorkingSet\(nodesRef\.current,edited\.changedIds,action\.context\.nodes/);
 assert.match(source,/agentContextWorkingSet\(nodesRef\.current,execution\.steps\.map/);
 assert.match(source,/agentGraphRevision\(nodesRef\.current,edgesRef\.current\)!==snapshotRevision/);
 assert.match(source,/offset>0&&!action\.expectedRevision/);
 assert.match(source,/action\.expectedRevision!==context\.snapshotRevision/);
});
