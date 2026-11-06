import {canvasGenerationProfile,canvasProfileModelIds} from "../src/core/canvas/apiModelLibrary.ts";
import {resolveCanvasTextSelection} from "../src/core/services/canvasMediaProfiles.ts";
import {mediaGenerationReadiness} from "../src/core/canvas/mediaGenerationReadiness.ts";
import {mergeImageResults} from "../src/core/canvas/imageResults.ts";
import {validateReferenceMentions} from "../src/core/canvas/referenceMentions.ts";
import {hasLiveGenerationTask} from "../src/core/canvas/generationIteration.ts";
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
import {createCanvasGenerationTask,canCancelCanvasGenerationTask} from '../src/core/canvas/generationTasks.ts';import {normalizeCanvasNodeCapabilityData} from '../src/core/canvas/nodeCapabilities.ts';import {createCanvasReferencePlan,duplicatesConnectedReference} from '../src/core/canvas/referencePlan.ts';
const require=createRequire(import.meta.url),{transformSync}=createRequire(require.resolve('vite'))('esbuild'),source=readFileSync('src/CanvasSpike.tsx','utf8');const code=transformSync(source.slice(source.indexOf('  const submitGenerationFromNode = useCallback('),source.indexOf('  const cancelGenerationTask = useCallback(')),{loader:'ts',target:'es2022'}).code;
function setup(status='succeeded'){
 const request={kind:'image',prompt:'New request',model:'gpt-image-1',references:[{id:'asset:input',kind:'image',role:'reference',label:'Input',mediaUrl:'/input.png'}]};const oldTask={...createCanvasGenerationTask({id:'old',sourceNodeId:'src',resultNodeId:'src',request,createdAt:'2026-10-17'}),status};
 const nodesRef={current:[{id:'src',type:'spike',position:{x:10,y:20},selected:true,data:{kind:'generator',label:'Original',generationKind:'image',generationTask:oldTask,resultMediaUrl:'/original.png',generationPrompt:'New request'}},{id:'other',type:'spike',position:{x:400,y:500},data:{kind:'text',label:'Other'}}]};const edgesRef={current:[] as any[]},history:any[]=[],records:any[]=[],errors:any[]=[];let seq=0,dirty=0;
 const profile={id:'p',name:'Connection A',imageModel:'gpt-image-1',videoModel:'',revision:1,apiKeyConfigured:true,imageProtocol:'openai-image',videoProtocol:'disabled'};
 const env={comfyConfig:null,canvasGenerationProfile,canvasProfileModelIds,resolveCanvasTextSelection,legacyTextConfigRef:{current:{model:"text",models:["text"],providerLabel:"Legacy"}},mediaGenerationReadiness,validateReferenceMentions,nodesRef,edgesRef,hasLiveGenerationTask,runningGenerationTaskIdsRef:{current:new Set<string>()},useCallback:(fn:any)=>fn,uiSettings:{noteReferenceIncludeTitle:false},aiRuntimeConfig:{ready:true,model:'text',models:['text'],imageModels:['gpt-image-1'],imageModel:'gpt-image-1',videoModels:[],videoModel:''},activeMediaProfile:profile,mediaProfiles:{activeProfileId:'p',profiles:[profile]},generationTaskSnapshotsRef:{current:new Map()},getIncomingGenerationInputs:()=>[{edgeId:'input',sourceNodeId:'input',role:'reference',reference:request.references[0]}],resolveStoredCanvasReferences:()=>[],inferGenerationKind:()=> 'image',createCanvasReferencePlan,createGenerationRequestSnapshot:()=>structuredClone(request),createCanvasGenerationTask,canCancelCanvasGenerationTask,duplicatesConnectedReference,normalizeCanvasNodeCapabilityData,textNodeSize:()=>({width:200,height:120}),getViewportCreatePosition:()=>({x:100,y:100}),reactFlowInstance:{getNodesBounds:()=>({x:10,y:20,width:300,height:200})},genId:()=>`n${++seq}`,genEdgeId:()=>`e${++seq}`,commitHistory:()=>history.push(structuredClone({nodes:nodesRef.current,edges:edgesRef.current})),markDirty:()=>dirty++,recordGenerationTask:(t:any)=>records.push(t),setNodes:(n:any)=>nodesRef.current=n,setEdges:(e:any)=>edgesRef.current=e,setSelectedNodeIds:()=>{},setComposerNodeId:()=>{},setInspectorNodeId:()=>{},setNodeContextMenu:()=>{},setConnectDropMenu:()=>{},cancelledGenerationTaskIdsRef:{current:new Set()},generationTaskCanvasIdsRef:{current:new Map()},currentCanvasIdRef:{current:'c'},setSaveError:(e:any)=>errors.push(e),setSaveStatus:()=>{},locale:'zh-CN',t:(s:string)=>s};
 const submit=Function('env',`const {${Object.keys(env).join(',')}}=env;${code};return submitGenerationFromNode;`)(env);return {env,submit,history,records,errors,get dirty(){return dirty;}};
}
test('completed composer generates on the same node and retains displayed results',()=>{const h=setup(),before=structuredClone(h.env.nodesRef.current[0]);h.submit('src');assert.equal(h.env.nodesRef.current.length,2);const next=h.env.nodesRef.current[0];assert.equal(next.id,before.id);assert.deepEqual(next.position,before.position);assert.equal(next.data.resultMediaUrl,'/original.png');assert.equal(h.records[0].parentTaskId,'old');assert.equal(h.records[0].sourceNodeId,'src');assert.equal(h.records[0].resultNodeId,'src');assert.equal(next.data.generationReferences?.length,0);assert.deepEqual(h.env.edgesRef.current,[]);assert.equal(h.history.length,1);assert.equal(h.history[0].nodes[0].data.generationTask.id,'old');assert.equal(h.dirty,1);});
test('failed task retry uses its existing slot and original pinned request',()=>{const h=setup('failed');const request={kind:'image',prompt:'Original pinned',model:'old-model',mediaProfileId:'old-p',mediaProfileRevision:7,references:[]};h.submit('src',{request,attempt:2,parentTaskId:'old'});assert.equal(h.env.nodesRef.current.length,2);assert.equal(h.records[0].sourceNodeId,'src');assert.equal(h.records[0].request.prompt,'Original pinned');assert.equal(h.records[0].request.mediaProfileRevision,7);});
test('busy source never forks or queues duplicate generation',()=>{const h=setup('running');h.submit('src');assert.equal(h.env.nodesRef.current.length,2);assert.equal(h.history.length,0);assert.equal(h.records.length,0);assert.ok(h.errors.length);});
test('completion mutation path contains no selection or viewport actions',()=>{const start=source.indexOf('function applyGenerationTaskToNodes('),end=source.indexOf('function migrateLegacyCanvasNode(',start);assert.doesNotMatch(source.slice(start,end),/setCenter|fitView|setSelected|selected:\s*true/);const a=source.indexOf('  const applyGenerationTaskUpdate ='),b=source.indexOf('  const executeGenerationTask =',a);assert.doesNotMatch(source.slice(a,b),/setCenter|fitView|setSelected|setComposer/);});
test('double-clicking completed source cannot enqueue duplicate same-node jobs',()=>{const h=setup();h.submit('src');h.submit('src');assert.equal(h.env.nodesRef.current.length,2);assert.equal(h.records.length,1);assert.equal(h.history.length,1);assert.ok(h.errors.length);});
test('cancelled queued task does not permanently block its node',()=>{const h=setup();h.submit('src');h.env.nodesRef.current[0].data.generationTask!.status='cancelled';h.submit('src');assert.equal(h.records.length,2);assert.equal(h.env.nodesRef.current.length,2);});
test('undoing queued task ignores stale snapshot but running worker still blocks',()=>{const h=setup();const initial=structuredClone(h.env.nodesRef.current);h.submit('src');const taskId=h.records[0].id;h.env.nodesRef.current=initial;h.env.runningGenerationTaskIdsRef.current.add(taskId);h.submit('src');assert.equal(h.records.length,1);h.env.runningGenerationTaskIdsRef.current.delete(taskId);h.submit('src');assert.equal(h.records.length,2);});

test('production completion keeps earlier images and cancellation/failure never discards them',()=>{
 const start=source.indexOf('function applyGenerationTaskToNodes('),end=source.indexOf('function migrateLegacyCanvasNode(',start);
 const compiled=transformSync(source.slice(start,end),{loader:'ts',target:'es2022'}).code;
 const apply=Function('mergeImageResults',compiled+';return applyGenerationTaskToNodes;')(mergeImageResults);
 const task={id:'new',status:'succeeded'},original=[{id:'src',position:{x:10,y:20},data:{generationTask:task,resultMediaUrl:'/old.png'}}];
 const updated=apply(original,task,{kind:'image',mediaItems:[{url:'/new.png'},{url:'/batch.png'}]});
 assert.equal(updated.length,1);assert.equal(updated[0].id,'src');assert.deepEqual(updated[0].position,original[0].position);
 assert.deepEqual(updated[0].data.resultMediaItems.map((i:any)=>i.url),['/new.png','/batch.png','/old.png']);assert.equal(updated[0].data.resultMediaUrl,'/new.png');
 assert.equal(original[0].data.resultMediaUrl,'/old.png');
 for(const status of ['failed','cancelled']){const stopped=apply(updated,{...task,status});assert.deepEqual(stopped[0].data.resultMediaItems,updated[0].data.resultMediaItems);}
 assert.deepEqual(apply(updated,{id:'stale',status:'succeeded'},{kind:'image',mediaUrl:'/stale.png'}),updated);
});

test('ordinary generation from a material image retains its ID and original media without creating edges',()=>{
 const h=setup();const source=h.env.nodesRef.current[0];source.data={kind:'image',label:'Input',refMediaUrl:'/input.png',refThumbnailUrl:'/thumb.png',payload:'asset:input',generationPrompt:'Edit'} as any;
 h.submit('src');const next=h.env.nodesRef.current[0];assert.equal(next.id,'src');assert.equal(next.data.kind,'generator');assert.equal(next.data.resultMediaUrl,'/input.png');assert.equal(next.data.refMediaUrl,undefined);assert.equal(h.env.edgesRef.current.length,0);assert.equal(h.records[0].request.references[0].mediaUrl,'/input.png');
});


test('retired Doubao profiles block new generation and preserve existing result',()=>{
 const h=setup();h.env.mediaProfiles.profiles[0].id='doubao-default';h.env.mediaProfiles.activeProfileId='doubao-default';h.env.mediaProfiles.profiles[0].imageProtocol='doubao-image';
 const before=structuredClone(h.env.nodesRef.current);
 h.submit('src');assert.equal(h.records.length,0);assert.match(h.errors[0],/豆包连接器已移除/);
 assert.equal(h.history.length,0);assert.deepEqual(h.env.nodesRef.current,before);
});

test('API profiles still require real key, and mismatched built-in identity cannot bypass it',()=>{
 for(const change of [{apiKeyConfigured:false},{id:'doubao-default',apiKeyConfigured:false},{imageProtocol:'doubao-image',apiKeyConfigured:true}]){
 const h=setup();Object.assign(h.env.mediaProfiles.profiles[0],change);h.env.mediaProfiles.activeProfileId=h.env.mediaProfiles.profiles[0].id;h.submit('src');assert.equal(h.records.length,0);assert.equal(h.history.length,0);
 }
});

test('submission reuses its current validated reference plan for the request snapshot', () => {
 let planCalls=0, snapshotPlan:any;
 const h=setup();
 const plan=createCanvasReferencePlan('image',h.env.getIncomingGenerationInputs(),[]);
 h.env.createCanvasReferencePlan=(...args:any[])=>{planCalls++;return plan;};
 h.env.createGenerationRequestSnapshot=(...args:any[])=>{snapshotPlan=args[11];return {kind:'image',prompt:'Current',model:'gpt-image-1',references:[]};};
 // Recreate the callback so the extracted function captures the new test dependencies.
 const submit=Function('env',`const {${Object.keys(h.env).join(',')}}=env;${code};return submitGenerationFromNode;`)(h.env);
 submit('src');
 assert.equal(planCalls,1);
 assert.equal(snapshotPlan,plan);
 assert.equal(h.records.length,1);
});

test('snapshot reuses a supplied plan but rebuilds current inputs for independent previews', () => {
 const snapshotCode=transformSync(source.slice(source.indexOf('function createGenerationRequestSnapshot('),source.indexOf('function MaterialCompactComposer(')),{loader:'ts',target:'es2022'}).code;
 let builds=0;
 const supplied:any[]=[];
 const rebuilt:any[]=[];
 const env={inferGenerationKind:()=> 'text',createCanvasReferencePlan:()=>{builds++;return rebuilt;},compileMentionedPrompt:()=>({prompt:'P',referenceAliases:[]}),canvasReferenceSnapshots:(plan:any)=>plan,captureGenerationEditorSnapshot:()=>undefined,resolveTextGenerationPrompt:()=> 'P',compileCanvasGenerationInputs:({prompt,references}:any)=>({prompt,references})};
 const snapshot=Function('env',`const {${Object.keys(env).join(',')}}=env;${snapshotCode};return createGenerationRequestSnapshot;`)(env);
 const node={data:{kind:'text',generationPrompt:'P'}};
 const args=[node,[],['m'],'m',[], '', [], '',null,false,[]];
 assert.equal(snapshot(...args,supplied).references,supplied);
 assert.equal(builds,0);
 assert.equal(snapshot(...args).references,rebuilt);
 assert.equal(builds,1);
});


test('API card selection pins the chosen connection and revision without activating it globally',()=>{
 const h=setup();const other:any={...h.env.activeMediaProfile,id:'b',name:'Connection B',revision:9,imageModel:'image-b'};
 h.env.mediaProfiles.profiles.push(other);h.env.nodesRef.current[0].data.generationProfileId='b';h.env.nodesRef.current[0].data.generationModel='image-b';
 let args:any[]=[];h.env.createGenerationRequestSnapshot=(...values:any[])=>{args=values;return {kind:'image',prompt:'Synthetic',model:values[5],references:[]};};
 const submit=Function('env',`const {${Object.keys(h.env).join(',')}}=env;${code};return submitGenerationFromNode;`)(h.env);
 submit('src');assert.equal(h.records.length,1);assert.deepEqual(args[4],['image-b']);assert.equal(args[8],other);
 assert.equal(h.records[0].request.mediaProfileId,'b');assert.equal(h.records[0].request.mediaProfileRevision,9);
 assert.equal(h.env.mediaProfiles.activeProfileId,'p');assert.equal(h.env.nodesRef.current[0].data.generationProfileId,'b');
});
test('request compiler rejects removed connection/model instead of silently using the active default',()=>{
 const snapshotCode=transformSync(source.slice(source.indexOf('function createGenerationRequestSnapshot('),source.indexOf('function MaterialCompactComposer(')),{loader:'ts',target:'es2022'}).code;
 const env={inferGenerationKind:()=> 'image',createCanvasReferencePlan:()=>[],compileMentionedPrompt:()=>({prompt:'P'}),canvasReferenceSnapshots:()=>[],captureGenerationEditorSnapshot:()=>undefined};
 const compile=Function('env',`const {${Object.keys(env).join(',')}}=env;${snapshotCode};return createGenerationRequestSnapshot;`)(env);
 const node={data:{kind:'generator',generationKind:'image',generationPrompt:'P',generationModel:'same-model',generationProfileId:'b'}};
 assert.throws(()=>compile(node,[],[],'',['same-model'],'same-model',[],'',{id:'a'}),/historical-model-unavailable/);
 assert.throws(()=>compile(node,[],[],'',['another-model'],'another-model',[],'',{id:'b'}),/historical-model-unavailable/);
});
