import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canvasAgentExecutionNodeIds, navigateCanvasAgentExecution } from '../src/features/canvas/canvasAgentResultNavigation.ts';
import { synchronizeCanvasNodeSelection } from '../src/features/canvas/canvasSelectionTransform.ts';
import type { CanvasAgentExecution, CanvasAgentExecutionOwner } from '../src/core/canvas/agent/types.ts';

const owner = {canvasId:'canvas-a',loadEpoch:3};
const execution:CanvasAgentExecution = {planId:'applied-plan',owner,status:'completed',steps:[
  {id:'s1',nodeId:'created',kind:'image',title:'Created draft',status:'draft'},
  {id:'s2',nodeId:'edited',kind:'text',title:'Edited node',status:'succeeded'},
  {id:'s3',nodeId:'created',kind:'image',title:'Same real node',status:'succeeded'},
  {id:'s4',nodeId:'deleted',kind:'video',title:'Removed result',status:'succeeded'},
  {id:'s5',nodeId:'',kind:'text',title:'No node',status:'draft'},
]};
const nodes = [
  {id:'created',selected:false,position:{x:100,y:200},data:{label:'Draft'}},
  {id:'edited',selected:false,position:{x:600,y:700},data:{label:'Real edit without a plan marker'}},
  {id:'unrelated',selected:true,position:{x:1,y:2},data:{label:'Unrelated'}},
];
const bounds = {x:100,y:200,width:800,height:700};

function harness() {
  let current:{owner:CanvasAgentExecutionOwner|null;execution:CanvasAgentExecution|null;nodes:typeof nodes}={owner,execution,nodes};
  const effects:unknown[]=[], queries:string[][]=[];
  const ports={readCurrent:()=>current,getBounds:(ids:string[])=>{queries.push(ids);return bounds;},apply:(value:unknown)=>{effects.push(value);}};
  return {ports,effects,queries,set:(patch:Partial<typeof current>)=>{current={...current,...patch};}};
}

test('deduplicates actual created drafts and edited nodes, ignores removed or empty IDs without requiring plan markers',()=>{
  assert.deepEqual(canvasAgentExecutionNodeIds(execution,owner,nodes),['created','edited']);
  assert.deepEqual(canvasAgentExecutionNodeIds(null,owner,nodes),[]);
});
test('select-all contains only current real results; locating one never implies select-all',()=>{
  const h=harness();
  assert.equal(navigateCanvasAgentExecution(execution,undefined,h.ports),true);
  assert.deepEqual(h.effects,[{nodeIds:['created','edited'],bounds,selectAll:true}]);
  assert.equal(navigateCanvasAgentExecution(execution,'edited',h.ports),true);
  assert.deepEqual(h.effects[1],{nodeIds:['edited'],bounds,selectAll:false});
  assert.equal(navigateCanvasAgentExecution(execution,'unrelated',h.ports),false);
  assert.equal(h.queries.length,3,'bounds are checked per node, never for an unrelated or planned-only ID');
});
test('partial deletion keeps remaining results; all-deleted leaves selection and camera untouched',()=>{
  const h=harness();h.set({nodes:nodes.filter(node=>node.id!=='created')});
  assert.equal(navigateCanvasAgentExecution(execution,undefined,h.ports),true);
  assert.deepEqual(h.queries,[['edited']]);
  h.set({nodes:nodes.filter(node=>node.id==='unrelated')});
  assert.equal(navigateCanvasAgentExecution(execution,undefined,h.ports),false);
  assert.equal(navigateCanvasAgentExecution(execution,'deleted',h.ports),false);
  assert.equal(h.queries.length,1);assert.equal(h.effects.length,1);
});
test('old callbacks fail closed across canvas switches, same-canvas reloads, loading and newer execution',()=>{
  for(const patch of [{owner:{...owner,canvasId:'canvas-b'}},{owner:{...owner,loadEpoch:4}},{owner:null},{execution:{...execution,planId:'newer-plan'}}]) {
    const h=harness();h.set(patch);
    assert.equal(navigateCanvasAgentExecution(execution,undefined,h.ports),false);
    assert.deepEqual(h.queries,[]);assert.deepEqual(h.effects,[]);
  }
  assert.deepEqual(canvasAgentExecutionNodeIds({...execution,owner:undefined},owner,nodes),[]);
});
test('zero, negative and nonfinite bounds never move the viewport or clear selection',()=>{
  for(const bad of [{x:0,y:0,width:0,height:0},{...bounds,width:-1},{...bounds,height:0},{...bounds,x:NaN},{...bounds,y:Infinity}]) {
    const h=harness();h.ports.getBounds=()=>bad;
    assert.equal(navigateCanvasAgentExecution(execution,undefined,h.ports),false);
    assert.deepEqual(h.effects,[]);
  }
});
test('rechecks deletion and owner changes at the last effect boundary',()=>{
  for(const patch of [{nodes:[]},{owner:{...owner,canvasId:'canvas-b'}},{owner:{...owner,loadEpoch:4}},{execution:{...execution}}]) {
    const h=harness();h.ports.getBounds=()=>{h.set(patch);return bounds;};
    assert.equal(navigateCanvasAgentExecution(execution,undefined,h.ports),false);
    assert.deepEqual(h.effects,[]);
  }
});
test('selection-only updates preserve node content, positions and originals',()=>{
  const frozen=nodes.map(node=>Object.freeze({...node,data:Object.freeze(node.data),position:Object.freeze(node.position)}));
  const before=JSON.stringify(frozen), history=Object.freeze([{snapshot:'unchanged'}]);
  const h=harness();let selected=nodes;
  h.ports.apply=(value)=>{const target=value as {nodeIds:string[]};selected=synchronizeCanvasNodeSelection(frozen,target.nodeIds);};
  navigateCanvasAgentExecution(execution,undefined,h.ports);
  assert.deepEqual(selected.map(node=>node.selected),[true,true,false]);
  selected.forEach((node,index)=>{assert.equal(node.data,frozen[index].data);assert.equal(node.position,frozen[index].position);});
  assert.equal(JSON.stringify(frozen),before);assert.deepEqual(history,[{snapshot:'unchanged'}]);
});
test('integration uses navigation-only effects and trustworthy operation/recovery sources',()=>{
  const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
  const callback=source.slice(source.indexOf('  const locateCanvasAgentExecution ='),source.indexOf('  const canvasAgentChips ='));
  assert.doesNotMatch(callback,/commitHistory|markDirty|persistCurrentCanvas|setEdges|\.data\s*=|requestAnimationFrame|setTimeout|submitGeneration|canvasAgent\.send/);
  assert.match(callback,/synchronizeCanvasNodeSelection\(nodes,nodeIds\)/);
  assert.match(callback,/canvasAgentSelectionRef\.current=nodeIds/);
  assert.match(callback,/duration:0/);
  assert.match(source,/planId:plan\.id,owner,status:'draft',steps:result\.steps/);
  assert.match(source,/const changedIds=new Set\(edited\.changedIds\)/);
  assert.match(source,/planId:action\.actionId,owner:\{canvasId,loadEpoch:epoch\}/);
  assert.match(source,/canvasAgentOrigin as \{planId\?:string;stepId\?:string\}/);
  assert.match(source,/if\(!isCurrent\(\)\)return;[\s\S]*setCanvasAgentExecution\(\{\.\.\.execution,owner\}\)/);
});


test('only draft and succeeded steps can navigate; other execution states fail closed',()=>{
  for(const status of ['draft','succeeded','queued','running','failed','cancelled'] as const){
    const value={...execution,steps:[{...execution.steps[0],status}]};
    assert.deepEqual(canvasAgentExecutionNodeIds(value,owner,nodes),status==='draft'||status==='succeeded'?['created']:[]);
  }
});
test('hidden, invalid-position and invalid-parent-chain nodes never enter navigation bounds',()=>{
  const invalid=[
    {id:'created',hidden:true,position:{x:1,y:2}},
    {id:'created',position:{x:NaN,y:2}},
    {id:'created',position:{x:1,y:Infinity}},
    {id:'created'},
    {id:'created',parentId:'missing',position:{x:1,y:2}},
    {id:'created',parentId:'created',position:{x:1,y:2}},
  ];
  for(const node of invalid)assert.deepEqual(canvasAgentExecutionNodeIds(execution,owner,[node,nodes[1]]),['edited']);
  for(const parent of [{id:'parent',hidden:true,position:{x:1,y:2}},{id:'parent',position:{x:NaN,y:2}},{id:'parent',parentId:'created',position:{x:1,y:2}}]){
    assert.deepEqual(canvasAgentExecutionNodeIds(execution,owner,[{...nodes[0],parentId:'parent'},parent,nodes[1]]),['edited']);
  }
  assert.deepEqual(canvasAgentExecutionNodeIds(execution,owner,[{...nodes[0],parentId:'parent'},{id:'parent',position:{x:1,y:2}},nodes[1]]),['created','edited']);
});
test('per-node invalid bounds are omitted while good results still select and locate',()=>{
  const h=harness();
  h.ports.getBounds=ids=>ids[0]==='created'?{x:NaN,y:0,width:0,height:0}:bounds;
  assert.equal(navigateCanvasAgentExecution(execution,undefined,h.ports),true);
  assert.deepEqual(h.effects,[{nodeIds:['edited'],bounds,selectAll:true}]);
  assert.equal(navigateCanvasAgentExecution(execution,'created',h.ports),false);
  assert.equal(h.effects.length,1);
});
test('individual positive finite bounds merge into a complete result frame',()=>{
  const h=harness();
  h.ports.getBounds=ids=>ids[0]==='created'?{x:-100,y:50,width:200,height:100}:{x:500,y:300,width:100,height:200};
  assert.equal(navigateCanvasAgentExecution(execution,undefined,h.ports),true);
  assert.deepEqual(h.effects,[{nodeIds:['created','edited'],bounds:{x:-100,y:50,width:700,height:450},selectAll:true}]);
});
