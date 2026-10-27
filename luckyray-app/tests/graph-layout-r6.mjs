// Identical synthetic topologies: R5 vs standard d3-force, with cold and old seeds.
import {forceSimulation,forceManyBody,forceCenter,forceLink,forceCollide,forceX,forceY} from 'd3-force';
import {stripTypeScriptTypes} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {graphSeedPositions as currentSeed} from '../src/features/graph/graphSpatial.ts';
import {createGraphPhysicsRuntime,stepGraphPhysicsMutable} from '../src/features/graph/graphPhysics.ts';
const oldSpatial=execFileSync('git',['show','42377ca:luckyray-app/src/features/graph/graphSpatial.ts'],{encoding:'utf8'});
const {graphSeedPositions}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(oldSpatial)).toString('base64'));
const out='output/playwright/graph-r6';mkdirSync(out,{recursive:true});
const oldSource=execFileSync('git',['show','42377ca:luckyray-app/src/features/graph/graphPhysics.ts'],{encoding:'utf8'});
const old=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(oldSource)).toString('base64'));
const fixtures=[];
for(const [name,count,connected] of [['sparse',900,180],['dense',240,240],['large',1800,900]]){
 const nodes=Array.from({length:count},(_,id)=>({id,key:'reference-'+id,r:4})),edges=[];
 for(let i=1;i<connected;i++){edges.push([i,Math.floor((i-1)/5)]);if(i%7===0)edges.push([i,Math.max(0,i-5)]);if(name==='dense')for(let k=1;k<5;k++)edges.push([i,Math.max(0,i-k*3)]);}
 fixtures.push({name,nodes,edges});
}
const results=[];
for(const f of fixtures) for(const variant of ['R5','d3-old-seed','d3-cold','d3-unbiased','d3-bounded','quartz-standard','R6-production']){
 const seeds=graphSeedPositions(f.nodes,f.edges,1280,800);
 let nodes=f.nodes.map(n=>({...n,...(['R5','d3-old-seed'].includes(variant)?seeds.get(n.id):{}),vx:0,vy:0}));
 const start=performance.now();
 if(variant==='R6-production'){
 const positions=currentSeed(f.nodes,f.edges,1280,800);nodes=f.nodes.map(n=>({...n,...positions.get(n.id),vx:0,vy:0}));
 const input={nodes,edges:f.edges.map(([sourceId,targetId])=>({sourceId,targetId})),activeNodeIds:null,draggedNodeId:null,width:1280,height:800,alpha:1,repulsion:100,attraction:1,restLength:132,centerPull:.02,collisionGap:14,damping:.6,alphaDecay:1-Math.pow(.001,1/300)},runtime=createGraphPhysicsRuntime(nodes);
 while(input.alpha>=.001)input.alpha=stepGraphPhysicsMutable(input,runtime).alpha;
 }else if(variant==='R5'){
 const input={nodes,edges:f.edges.map(([sourceId,targetId])=>({sourceId,targetId})),activeNodeIds:null,draggedNodeId:null,width:1280,height:800,alpha:1,repulsion:6400,attraction:.006,restLength:132,centerPull:.0008,collisionGap:14,maxVelocity:16,damping:.85,alphaDecay:.982},runtime=old.createGraphPhysicsRuntime(nodes);
 while(input.alpha>=.001)input.alpha=old.stepGraphPhysicsMutable(input,runtime).alpha;
 }else{
 const quartz=variant==='quartz-standard';
 if(['d3-unbiased','d3-bounded'].includes(variant)) nodes.sort((a,b)=>hash(a.key)-hash(b.key));
 const sim=forceSimulation(nodes).stop().force('charge',forceManyBody().strength(quartz?-50:-100))
 .force('center',forceCenter(640,400).strength(.2))
 .force('link',forceLink(f.edges.map(([source,target])=>({source,target}))).id(n=>n.id).distance(quartz?30:132))
 .force('collide',forceCollide(n=>n.r+(quartz?0:7)).iterations(3));
 if(variant==='d3-bounded') sim.force('x',forceX(640).strength(.02)).force('y',forceY(400).strength(.02));
 while(sim.alpha()>=sim.alphaMin())sim.tick();
 }
 const ms=performance.now()-start;
 const ids=new Set(f.edges.flat()),cn=nodes.filter(n=>ids.has(n.id));
 const bounds=ns=>({x:Math.min(...ns.map(n=>n.x)),y:Math.min(...ns.map(n=>n.y)),w:Math.max(...ns.map(n=>n.x))-Math.min(...ns.map(n=>n.x)),h:Math.max(...ns.map(n=>n.y))-Math.min(...ns.map(n=>n.y))});
 const map=new Map(nodes.map(n=>[n.id,n]));
 const whole=bounds(nodes),group=bounds(cn),lengths=f.edges.map(([a,b])=>Math.hypot(map.get(a).x-map.get(b).x,map.get(a).y-map.get(b).y)).sort((a,b)=>a-b);
 const result={fixture:f.name,variant,ms,whole,group,connectedArea:group.w*group.h/(whole.w*whole.h),median:lengths[Math.floor(lengths.length/2)],p95:lengths[Math.floor(lengths.length*.95)],max:lengths.at(-1)};results.push(result);
 writeFileSync(`${out}/${f.name}-${variant}.json`,JSON.stringify({result,nodes,edges:f.edges}));
}
writeFileSync(out+'/layout-comparison.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
function hash(key){let h=2166136261;for(const c of key)h=Math.imul(h^c.charCodeAt(0),16777619);h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;return h>>>0;}
