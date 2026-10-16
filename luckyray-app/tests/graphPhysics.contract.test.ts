import assert from 'node:assert/strict';
import test from 'node:test';
import {stepGraphPhysics, stepGraphPhysicsMutable, createGraphPhysicsRuntime, type GraphPhysicsInput} from '../src/features/graph/graphPhysics.ts';
import {graphSeedPositions, graphScreenRadius, graphEdgeDetail} from '../src/features/graph/graphSpatial.ts';

function input(count: number, edges: [number,number][]): GraphPhysicsInput {
  const ids=Array.from({length:count},(_,id)=>({id,key:`note-${id}`}));
  const positions=graphSeedPositions(ids,edges,1280,800);
  return {nodes:ids.map(n=>({...n,...positions.get(n.id)!,vx:0,vy:0,r:4})),edges:edges.map(([sourceId,targetId])=>({sourceId,targetId})),activeNodeIds:null,draggedNodeId:null,width:1280,height:800,alpha:1,repulsion:100,attraction:1,restLength:180,centerPull:.02,collisionGap:14,damping:.6,alphaDecay:1-Math.pow(.001,1/300)};
}

test('real edges, node identities and immutable caller state survive simulation',()=>{
  const initial=input(30,Array.from({length:29},(_,i)=>[i,i+1]));
  const saved=structuredClone(initial);
  const next=stepGraphPhysics(initial);
  assert.deepEqual(initial,saved);
  assert.deepEqual(next.nodes.map(n=>n.id),initial.nodes.map(n=>n.id));
  assert.ok(next.nodes.every(n=>[n.x,n.y,n.vx,n.vy].every(Number.isFinite)));
});

test('local focus computes forces using only its active topology',()=>{
  const all=input(30,Array.from({length:29},(_,i)=>[0,i+1]));
  all.activeNodeIds=new Int32Array([0,1,2]);
  const local={...all,nodes:structuredClone(all.nodes.slice(0,3)),edges:all.edges.slice(0,2),activeNodeIds:null};
  const subset=stepGraphPhysics(local),result=stepGraphPhysics(all);
  assert.deepEqual(result.nodes.slice(0,3),subset.nodes);
  assert.deepEqual(result.nodes.slice(3),all.nodes.slice(3));
});

test('dragging keeps the grabbed position fixed, missing/self edges do not change forces',()=>{
  const initial=input(6,[[0,1],[1,2],[2,3],[3,4],[4,5]]);
  initial.draggedNodeId=2;
  const result=stepGraphPhysics(initial);
  assert.equal(result.nodes[2].x,initial.nodes[2].x);
  assert.equal(result.nodes[2].y,initial.nodes[2].y);
  assert.deepEqual(stepGraphPhysics({...initial,edges:[...initial.edges,{sourceId:0,targetId:0},{sourceId:0,targetId:999}]}).nodes,result.nodes);
});

test('worker mutable and fallback immutable paths remain numerically identical',()=>{
  const a=input(220,Array.from({length:219},(_,i)=>[i+1,Math.floor(i/5)]));
  let immutable=structuredClone(a);const runtime=createGraphPhysicsRuntime(a.nodes);
  for(let step=0;step<25;step++){
    const next=stepGraphPhysicsMutable(a,runtime);a.alpha=next.alpha;
    const fallback=stepGraphPhysics(immutable);immutable={...immutable,nodes:fallback.nodes,alpha:fallback.alpha};
  }
  assert.deepEqual(a.nodes,immutable.nodes);
});

test('reciprocal and duplicate references do not multiply spring weight',()=>{
  const a=input(6,[[0,1],[1,2],[2,3],[3,4],[4,5]]);
  const b={...a,edges:[...a.edges,...a.edges.map(e=>({sourceId:e.targetId,targetId:e.sourceId})),...a.edges]};
  assert.deepEqual(stepGraphPhysics(a).nodes,stepGraphPhysics(b).nodes);
});

test('release followed by topology refresh cannot resurrect an old drag pin',()=>{
  const a=input(6,[[0,1],[1,2],[2,3],[3,4],[4,5]]);
  const runtime=createGraphPhysicsRuntime(a.nodes);
  a.draggedNodeId=2;
  stepGraphPhysicsMutable(a,runtime);
  a.nodes[2].x=1234;a.nodes[2].y=567;
  a.draggedNodeId=null;a.edges=[...a.edges];
  const expected=stepGraphPhysics({...a,nodes:a.nodes.map(n=>({...n,fx:undefined,fy:undefined}))});
  const actual=stepGraphPhysicsMutable(a,runtime);
  assert.deepEqual(actual.nodes,expected.nodes);
  assert.equal(actual.nodes[2].fx,undefined);
  assert.ok(actual.nodes[2].x>1000,'released node starts from the current pointer position');
});

test('hub topology settles with bounded link lengths and velocities',()=>{
  const a=input(41,Array.from({length:40},(_,i)=>[0,i+1]));const runtime=createGraphPhysicsRuntime(a.nodes);
  while(a.alpha>=.001)a.alpha=stepGraphPhysicsMutable(a,runtime).alpha;
  const hub=a.nodes[0],lengths=a.nodes.slice(1).map(n=>Math.hypot(n.x-hub.x,n.y-hub.y));
  assert.ok(Math.max(...lengths)<a.restLength*1.6);
  for (const node of a.nodes) for (const other of a.nodes) if(node.id!==other.id)
    assert.ok(Math.hypot(node.x-other.x,node.y-other.y)>=node.r+other.r,'nodes remain distinguishable');
  assert.ok(a.nodes.every(n=>Math.hypot(n.vx,n.vy)<.05));
});

test('strongest controls remain finite in a dense hub graph',()=>{
  const a=input(220,Array.from({length:219},(_,i)=>[0,i+1]));
  a.attraction*=4.6;a.repulsion*=5;a.centerPull*=4.2;const runtime=createGraphPhysicsRuntime(a.nodes);
  for(let i=0;i<180;i++){a.alpha=stepGraphPhysicsMutable(a,runtime).alpha;assert.ok(a.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)&&Number.isFinite(n.vx)&&Number.isFinite(n.vy)));}
});

test('overview retains visible points and modest hub size, fine lines and bounded zoom sizes',()=>{
  assert.ok(graphScreenRadius(3.6,.06)>=1.2);
  assert.ok(graphScreenRadius(7,.06)>graphScreenRadius(3.6,.06));
  assert.ok(graphScreenRadius(7,12)<=10);
  for(const scale of [.025,.1,1,12]){const line=graphEdgeDetail(scale);assert.ok(line.alpha>=.32&&line.alpha<=.7&&line.width>=.6&&line.width<=1);}
});
