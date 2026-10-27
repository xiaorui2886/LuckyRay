import { resolvePinnedFocusReference } from "../src/core/canvas/focusReference.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {equalGrid,gridCells,moveGridLine,renderGridCell,splitImageSource,stageGridOutputs,placeGridGroup,planGridNodes,restoreGridSliceInteraction} from '../src/core/canvas/imageGrid';
import {sanitizeCanvasNodesForPersistence} from '../src/features/canvas/canvasPersistence';
import {createCanvasHistorySnapshot,appendCanvasHistoryEntry} from '../src/features/canvas/canvasHistory';
import {canvasNodeLibraryCandidates} from '../src/core/canvas/nodeSaving';
const {createCanvas}=createRequire(import.meta.url)(process.env.LR_CANVAS_MODULE || '@napi-rs/canvas');
const png='data:image/png;base64,YQ==';
test('presets/custom reject invalid axes, single cell and nonfinite values',()=>{
 for(const [r,c] of [[0,3],[3,7],[1,1],[2.5,3],[NaN,2]])assert.throws(()=>equalGrid(r,c));
 for(let r=1;r<=6;r++)for(let c=1;c<=6;c++){if(r*c===1)continue;assert.equal(gridCells(127,93,equalGrid(r,c)).length,r*c);}
});
test('odd dimensions cover every pixel exactly once across all supported grids',()=>{
 for(let rows=1;rows<=6;rows++)for(let cols=1;cols<=6;cols++){
  if(rows*cols===1)continue;const seen=new Uint8Array(127*93);
  for(const cell of gridCells(127,93,equalGrid(rows,cols)))for(let y=cell.y;y<cell.y+cell.height;y++)for(let x=cell.x;x<cell.x+cell.width;x++)seen[y*127+x]++;
  assert.ok(seen.every(n=>n===1));
 }
});
test('manual boundaries retain coverage, clamp without crossing and validate source dimensions',()=>{
 const spec=moveGridLine(equalGrid(3,3),'x',1,.17,127);
 assert.equal(gridCells(127,93,spec).reduce((a,c)=>a+c.width*c.height,0),127*93);
 assert.ok(moveGridLine(spec,'x',1,9,127).x[1]<spec.x[2]);
 assert.throws(()=>gridCells(1,1,equalGrid(3,3)));assert.throws(()=>gridCells(9000,9000,spec));
 assert.throws(()=>gridCells(20,20,{x:[0,.7,.2,1],y:[0,1]}));
});
test('actual raster crops preserve source RGBA without resampling including odd pixels',()=>{
 const source=createCanvas(127,93),ctx=source.getContext('2d'),data=ctx.createImageData(127,93);
 for(let y=0;y<93;y++)for(let x=0;x<127;x++){const i=(y*127+x)*4;data.data.set([x,y,(x+y)%256,255],i);}ctx.putImageData(data,0,0);
 const spec=moveGridLine(equalGrid(3,3),'y',1,.28,93);
 for(const cell of gridCells(127,93,spec)){
  const output=renderGridCell(source,cell,createCanvas as any);
  assert.equal(output.width,cell.width);assert.equal(output.height,cell.height);
  assert.deepEqual([...output.getContext('2d')!.getImageData(0,0,cell.width,cell.height).data],[...ctx.getImageData(cell.x,cell.y,cell.width,cell.height).data]);
 }
});
test('toolbar eligibility rejects empty/video/active jobs and selects actual primary image, never thumbnail',()=>{
 assert.equal(splitImageSource({kind:'image',refThumbnailUrl:'thumbnail'}),null);
 assert.equal(splitImageSource({kind:'image',refMediaUrl:'a',_emptyMedia:true}),null);
 assert.equal(splitImageSource({kind:'video',refMediaUrl:'video'}),null);
 assert.equal(splitImageSource({kind:'generator',generationKind:'image',resultMediaUrl:'old',generationTask:{status:'running'}}),null);
 assert.equal(splitImageSource({kind:'image',refMediaUrl:'original'}),'original');
 assert.equal(splitImageSource({kind:'generator',generationKind:'image',resultMediaItems:[{url:'first'},{url:'second'}]}),'first');
});
const outputs=()=>gridCells(127,93,equalGrid(3,3)).filter(c=>c.index!==4).map(cell=>({cell,png}));
test('all files staged before publish, preserves selected order and requires durable paths',async()=>{
 let writes=0;const staged=await stageGridOutputs(outputs(),async()=>`C:/generated-images/${++writes}.png`,()=>true);
 assert.equal(writes,8);assert.deepEqual(staged.map(s=>s.cell.index),[0,1,2,3,5,6,7,8]);
 await assert.rejects(()=>stageGridOutputs(outputs(),async()=> 'blob:temporary',()=>true));
 await assert.rejects(()=>stageGridOutputs([],async()=>'',()=>true));
});
test('mid-write failure or cancelled/deleted/replaced canvas prevents any published result',async()=>{
 for(const failAt of [1,4,8]){
  let calls=0,published=false;
  await assert.rejects(async()=>{await stageGridOutputs(outputs(),async()=>{if(++calls===failAt)throw Error('disk-full');return '/generated/'+calls;},()=>true);published=true;});
  assert.equal(published,false);assert.equal(calls,failAt);
 }
 let valid=true,calls=0;
 await assert.rejects(()=>stageGridOutputs(outputs(),async()=>{calls++;valid=false;return '/generated/1';},()=>valid));assert.equal(calls,1);
});
test('group avoids occupied rectangles, outputs retain row-major positions and no generation history',async()=>{
 const staged=await stageGridOutputs(outputs(),async()=>'/generated/slice.png',()=>true);let i=0;
 const plan=planGridNodes({sourceId:'source',label:'story',source:{x:0,y:0,width:300,height:300},occupied:[{x:380,y:0,width:2000,height:700}],staged,spec:equalGrid(3,3),id:()=>String(++i)});
 assert.ok(plan.group.position.y>=740);assert.equal(plan.children.length,8);assert.equal(plan.edges.length,8);assert.ok(plan.edges.every((edge,i)=>edge.source==='source'&&edge.target===plan.children[i].id&&edge.data.role==='generic'&&edge.data.relation==='derivation'));assert.equal(new Set(plan.edges.map(e=>e.id)).size,8);
 assert.equal(plan.children[0].position.y,plan.children[2].position.y);
 assert.ok(plan.children[3].position.y>plan.children[0].position.y);
 for(const n of plan.children){assert.equal(n.parentId,plan.group.id);assert.equal(n.data.derivedFromNodeId,'source');assert.equal('generationTask' in n.data,false);assert.ok(n.position.x+n.style.width<=plan.group.style.width);assert.ok(n.position.y+n.style.height<=plan.group.style.height);}
});
test('durable serialization and history snapshots preserve cuts, groups, paths and original independently',async()=>{
 const staged=await stageGridOutputs(outputs(),async()=>'/generated/slice.png',()=>true);let i=0;
 const original={id:'source',type:'spike',position:{x:0,y:0},data:{kind:'image',label:'source',refMediaUrl:'/source.png'}};
 const before=createCanvasHistorySnapshot({canvasId:'canvas',nodes:[original],edges:[],generationHistory:[]});
 const plan=planGridNodes({sourceId:'source',label:'story',source:{x:0,y:0,width:300,height:300},occupied:[],staged,spec:equalGrid(3,3),id:()=>String(++i)});
 const after=createCanvasHistorySnapshot({canvasId:'canvas',nodes:[original,plan.group,...plan.children],edges:plan.edges,generationHistory:[]});
 const history=appendCanvasHistoryEntry([],before);
 const saved=JSON.parse(JSON.stringify(sanitizeCanvasNodesForPersistence(after.nodes)));
 assert.deepEqual(saved[0],original);assert.equal(saved.length,10);assert.equal(saved[2].data.gridSlice.cell.index,0);assert.equal(saved[2].data.refMediaUrl,'/generated/slice.png');
 assert.equal(history.at(-1)!.nodes.length,1);assert.equal(after.nodes.length,10);assert.equal(after.edges.length,8);assert.equal(history.at(-1)!.edges.length,0); // one undo restores source only; redo restores entire batch
 assert.equal(canvasNodeLibraryCandidates(plan.children[0].data,[])[0].mediaUrl,'/generated/slice.png');
});
test('large blocked destination moves monotonically and no collisions remain',()=>{
 const occupied=Array.from({length:30},(_,i)=>({x:400,y:i*200,width:600,height:220}));
 const p=placeGridGroup({x:0,y:0,width:300,height:200},occupied,500,500);assert.ok(p.y>6000);
});

test('new slices allow image-body dragging beyond the group without losing provenance',()=>{
 let id=0;const spec=equalGrid(2,2);
 const plan=planGridNodes({sourceId:'source',label:'grid',source:{x:0,y:0,width:300,height:200},occupied:[],spec,id:()=>String(++id),staged:gridCells(600,400,spec).map(cell=>({cell,png,path:'/slice.png'}))});
 for(const child of plan.children){assert.equal(child.dragHandle,undefined);assert.equal(child.extent,undefined);assert.equal(child.parentId,plan.group.id);}
 assert.equal(plan.edges.length,4);assert.ok(plan.edges.every(edge=>edge.data.relation==='derivation'));
});

test('saved legacy slices and their undo snapshots recover free dragging without touching other nodes',()=>{
 const legacy={id:'slice',parentId:'group',position:{x:32,y:56},dragHandle:'.canvas-node-drag-handle',extent:'parent',data:{kind:'image',refMediaUrl:'/slice.png',gridSlice:{version:1,sourceNodeId:'source',cell:{width:300,height:200}}}};
 const restored=restoreGridSliceInteraction(legacy);
 assert.equal(legacy.dragHandle,'.canvas-node-drag-handle');assert.equal(legacy.extent,'parent');
 assert.equal(restored.dragHandle,undefined);assert.equal(restored.extent,undefined);assert.equal(restored.parentId,'group');assert.equal(restored.data,legacy.data);
 const moved={...restored,position:{x:-180,y:-70}};
 const snapshot=createCanvasHistorySnapshot({canvasId:'canvas',nodes:[moved],edges:[{id:'origin',source:'source',target:'slice',data:{relation:'derivation'}}],generationHistory:[]});
 const reopened=JSON.parse(JSON.stringify(snapshot));
 assert.deepEqual(reopened.nodes[0].position,moved.position);assert.equal(reopened.nodes[0].parentId,'group');assert.equal(reopened.edges[0].data.relation,'derivation');
 assert.deepEqual(restoreGridSliceInteraction(legacy).position,legacy.position);assert.equal(restoreGridSliceInteraction(restored),restored);
 const shot={data:{kind:'generator'},dragHandle:'.canvas-node-drag-handle',extent:'parent'};
 assert.equal(restoreGridSliceInteraction(shot),shot);
});

test('production split handler commits exactly once and supports undo snapshot for complete batch',async()=>{
 const {readFileSync}=await import('node:fs');const {transformSync}=createRequire(import.meta.url)('esbuild');
 const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  const splitGrid=useCallback'),source.indexOf('  const commitStoryboardNodes ='));
 const js=transformSync(body,{loader:'ts',target:'es2022'}).code;
 const make=(failAt=0,changeAt=0)=>{
  const original:any={id:'source',data:{kind:'image',label:'original',refMediaUrl:'/original.png'},position:{x:0,y:0}};
  const nodesRef={current:[original]},edgesRef={current:[] as any[]},currentCanvasIdRef={current:'c'},canvasLoadEpochRef={current:1};
  const session={canvasId:'c',epoch:1,item:{nodeId:'source'},raw:'/original.png'};
  let writes=0,commits=0,dirty=0,selected:any=[],id=0,before:any;
  const env={gridSession:session,gridSessionRef:{current:session},gridSaving:{current:false},bridge:{storeCanvasImageSlice:async()=>{writes++;if(writes===failAt)throw Error('disk');if(writes===changeAt)currentCanvasIdRef.current='other';return '/generated/'+writes+'.png';}},currentCanvasIdRef,canvasLoadEpochRef,nodesRef,edgesRef,setEdges:(next:any)=>{edgesRef.current=next;},splitImageSource,stageGridOutputs,planGridNodes,genId:()=>String(++id),locale:'zh-CN',uiSettings:{reduceMotion:true},reducedCameraMotion:true,cancelViewportMotion:{current:()=>{}},reactFlowInstance:{getNodesBounds:()=>({x:0,y:0,width:300,height:200}),fitView:()=>{}},normalizeCanvasNodeCapabilityData:(x:any)=>x,commitHistory:()=>{commits++;before=createCanvasHistorySnapshot({canvasId:'c',nodes:nodesRef.current,edges:edgesRef.current,generationHistory:[]});},markDirty:()=>{dirty++;},setNodes:(nodes:any)=>{nodesRef.current=nodes;},setSelectedNodeIds:(ids:any)=>{selected=ids;},requestAnimationFrame:(f:()=>void)=>f(),useCallback:(f:any)=>f};
  const run=Function('env',`const {${Object.keys(env).join(',')}}=env;${js};return splitGrid;`)(env);
  return {env,run,stats:()=>({writes,commits,dirty,selected,before})};
 };
 const happy=make();await happy.run(outputs(),equalGrid(3,3),new AbortController().signal);
 assert.equal(happy.stats().commits,1);assert.equal(happy.stats().dirty,1);assert.equal(happy.env.edgesRef.current.length,8);assert.equal(happy.stats().before.edges.length,0);assert.equal(happy.stats().before.nodes.length,1);assert.equal(happy.env.nodesRef.current.length,10);assert.equal(happy.env.nodesRef.current[0].data.refMediaUrl,'/original.png');
 for(const [failure,change] of [[4,0],[0,4]]){const h=make(failure,change);await assert.rejects(()=>h.run(outputs(),equalGrid(3,3),new AbortController().signal));assert.equal(h.stats().commits,0);assert.equal(h.env.nodesRef.current.length,1);assert.equal(h.env.edgesRef.current.length,0);}
 const duplicate=make();const first=duplicate.run(outputs(),equalGrid(3,3),new AbortController().signal);await assert.rejects(()=>duplicate.run(outputs(),equalGrid(3,3),new AbortController().signal));await first;assert.equal(duplicate.stats().commits,1);
 const cancelled=make(),abort=new AbortController();abort.abort();await assert.rejects(()=>cancelled.run(outputs(),equalGrid(3,3),abort.signal));assert.equal(cancelled.stats().writes,0);
});


test('every slice card follows exact image aspect, including uneven and extreme crops',()=>{
 for (const [w,h] of [[601,403],[20,2000],[2000,20],[1920,1080]]) {
  const spec=equalGrid(2,3);let id=0;
  const staged=gridCells(w,h,spec).map(cell=>({cell,png,path:'/slice.png'}));
  const plan=planGridNodes({sourceId:'s',label:'source',source:{x:0,y:0,width:300,height:200},occupied:[],staged,spec,id:()=>String(++id)});
  for (const n of plan.children) {
   assert.ok(Math.abs(n.style.width/n.style.height - n.data.gridSlice.cell.width/n.data.gridSlice.cell.height)<1e-9);
   assert.ok(n.style.width<=300 && n.style.height<=600);
   assert.ok(n.position.y+n.style.height<=plan.group.style.height);
  }
 }
});
test('composer removes template and merge notice without removing compiled generation inputs',async()=>{
 const {readFileSync}=await import('node:fs');const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 assert.equal(source.includes('<PromptStarterSelect'),false);
 assert.equal(source.includes('<details className="canvas-prompt-context">'),false);
 assert.ok(source.includes('const canSubmit = configured && hasContent && !busy'));
 assert.ok(source.includes('createGenerationRequestSnapshot(node, connectedInputs'));
 assert.ok(source.includes('<CanvasReferenceHover'));
 assert.equal(source.includes('<CanvasReferenceDetails'),false);
 const details=readFileSync(new URL('../src/features/canvas/CanvasReferenceHover.tsx',import.meta.url),'utf8');assert.ok(details.includes('canvasReferenceText(ref)'));assert.ok(details.includes('<pre>'));
});

test('production generation input reader ignores provenance, but keeps slice-to-generator reference',async()=>{
 const {readFileSync}=await import('node:fs');const {transformSync}=createRequire(import.meta.url)('esbuild');
 const source=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 const start=source.indexOf('  const getIncomingGenerationInputs = useCallback('),end=source.indexOf('  const updateIncomingEdgeRole',start);
 const helper=source.slice(source.indexOf('function referenceForCanvasNode('),source.indexOf('function storedCanvasReferences('));
 const body=transformSync(helper+source.slice(start,end),{loader:'ts',target:'es2022'}).code;
 const {hasInvalidCanvasReference}=await import('../src/core/canvas/referenceIdentity.ts');
 const env={edgesRef:{current:[{id:'provenance',source:'grid',target:'slice',data:{role:'generic',relation:'derivation'}},{id:'reference',source:'slice',target:'generator',data:{role:'reference'}}]},nodesRef:{current:[{id:'grid',data:{kind:'image',label:'grid',refMediaUrl:'/grid'}},{id:'slice',data:{kind:'image',label:'slice',refMediaUrl:'/slice'}}]},useCallback:(f:any)=>f,getCanvasNodeCapabilities:()=>({contentKind:'image'}),TEXT_NODE_PLACEHOLDER_LABELS:new Set(),t:()=>'',locale:'zh-CN',hasInvalidCanvasReference,resolvePinnedFocusReference};
 const read=Function('env',`const {${Object.keys(env).join(',')}}=env;${body};return getIncomingGenerationInputs;`)(env);
 assert.deepEqual(read('slice'),[]);assert.equal(read('generator').length,1);assert.equal(read('generator')[0].reference.mediaUrl,'/slice');
});
