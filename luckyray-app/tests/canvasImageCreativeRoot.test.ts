import {captureGenerationEditorSnapshot} from "../src/core/canvas/generationEditorSnapshot";
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as recipes from '../src/core/canvas/imageCreativeActions';
import * as cinema from '../src/core/canvas/cinematography';
import {splitImageSource} from '../src/core/canvas/imageGrid';
import {normalizeCanvasNodeCapabilityData} from '../src/core/canvas/nodeCapabilities';
import {mediaCapabilities,mediaOption,mediaQualityOption} from '../src/core/canvas/mediaCapabilities';
import {compileCanvasGenerationInputs} from '../src/core/canvas/generationInputCompiler';
import {createCanvasReferencePlan,canvasReferenceSnapshots} from '../src/core/canvas/referencePlan';
import {compileMentionedPrompt,parseReferenceMentions} from '../src/core/canvas/referenceMentions';
const root=readFileSync('src/CanvasSpike.tsx','utf8');
function extract(start:string,end:string){const a=root.indexOf(start),b=root.indexOf(end,a);assert.ok(a>=0&&b>a);return transformSync(root.slice(a,b),{loader:'ts',target:'es2022'}).code;}
function run(code:string,env:any,result:string){return Function(...Object.keys(env),code+';return '+result)(...Object.values(env));}
const directions={...cinema.createDefaultCinematographySettings(),enabled:true,camera:'arri-alexa-35',lens:'canon-k35',focalLength:'35',framing:'close-up',angle:'low',movement:'dolly-in'};
function draftHarness(){
 let seed=0,dirty=0; const history:any[]=[];
 const source={id:'source',selected:true,position:{x:20,y:30},data:{kind:'generator',generationKind:'image',generationModel:'gpt-image-2',generationPrompt:'Original prompt',generationCount:4,resultMediaUrl:'https://example.test/original.png',resultMediaItems:[{url:'https://example.test/original.png'}],generationTask:{id:'old',status:'succeeded'},generationCinematography:directions}};
 const env:any={...recipes,...cinema,splitImageSource,normalizeCanvasNodeCapabilityData,useCallback:(fn:any)=>fn,currentCanvasIdRef:{current:'c'},canvasLoadEpochRef:{current:1},loadingCanvas:false,nodesRef:{current:[source]},edgesRef:{current:[]},reactFlowInstance:{getNodesBounds:()=>({x:20,y:30,width:300}),getZoom:()=>1},getViewportCreatePosition:()=>({x:1,y:2}),genId:()=>`n${++seed}`,genEdgeId:()=>`e${++seed}`,commitHistory:()=>history.push(structuredClone({nodes:env.nodesRef.current,edges:env.edgesRef.current})),markDirty:()=>dirty++,setNodes:()=>{},setEdges:()=>{},setSelectedNodeIds:()=>{},setComposerNodeId:()=>{},setInspectorNodeId:()=>{},setNodeContextMenu:()=>{},requestAnimationFrame:()=>{},centerNodeByAbsoluteBounds:()=>{},submitGenerationFromNode:()=>{throw Error('must-not-generate');}};
 const action=()=>run(extract('  const createImageCreativeDraft = useCallback(','\n  const getIncomingGenerationInputs'),env,'createImageCreativeDraft');
 return {env,action,source,history,dirty:()=>dirty};
}
const compiler=run(extract('function createGenerationRequestSnapshot(','\nfunction MaterialCompactComposer'),{captureGenerationEditorSnapshot,...recipes,...cinema,mediaCapabilities,mediaOption,mediaQualityOption,compileCanvasGenerationInputs,createCanvasReferencePlan,canvasReferenceSnapshots,compileMentionedPrompt,parseReferenceMentions,inferGenerationKind:(n:any)=>n.data.generationKind||'text',resolveTextGenerationPrompt:(n:any)=>n.data.generationPrompt||n.data.label||''},'createGenerationRequestSnapshot');
const imageReference={id:'node:source',kind:'image',label:'Original',mediaUrl:'https://example.test/original.png',role:'reference'};
function request(data:any,connectedInputs:any[]=[]){return compiler({id:'draft',data:{kind:'generator',generationKind:'image',generationPrompt:'User instruction',generationModel:'gpt-image-2',generationCount:1,...data}},connectedInputs,['text-model'],'text-model',['gpt-image-2'],'gpt-image-2',['video-model'],'video-model',{imageProtocol:'openai-image',videoProtocol:'12ai-task',baseUrl:'https://new.12ai.org'},false);}
test('actual creative draft creates one atomic pinned linked generator, preserves source and does not generate',()=>{
 const h=draftHarness(),before=structuredClone(h.source);
 h.action()('source',before.data.resultMediaUrl,recipes.createCreativeRecipe('story-grid',{grid:'3x3'}));
 assert.equal(h.history.length,1);assert.equal(h.dirty(),1);assert.equal(h.env.nodesRef.current.length,2);assert.equal(h.env.edgesRef.current.length,1);
 const draft=h.env.nodesRef.current[1],edge=h.env.edgesRef.current[0];
 assert.deepEqual(h.env.nodesRef.current[0],{...before,selected:false});
 assert.equal(draft.data.generationCount,1);assert.equal(draft.data.generationPrompt,'');assert.equal(draft.data.resultMediaUrl,undefined);assert.equal(draft.data.generationTask,undefined);
 assert.equal(draft.data.derivedFromNodeId,'source');assert.equal(draft.data.sourceGenerationTaskId,'old');
 assert.equal(edge.source,'source');assert.equal(edge.target,draft.id);assert.equal(edge.data.role,'reference');assert.equal(edge.data.referenceMediaUrl,before.data.resultMediaUrl);
 assert.deepEqual(draft.position,{x:400,y:30});assert.equal(draft.data.generationCinematography.framing,'auto');assert.equal(draft.data.generationCinematography.angle,'auto');assert.equal(draft.data.generationCinematography.movement,'auto');assert.equal(draft.data.generationCinematography.camera,'arri-alexa-35');
 assert.deepEqual(h.history[0],{nodes:[before],edges:[]});
});
test('actual creative draft rejects stale/missing source, bad recipe and loading canvas without mutation',()=>{
 for(const scenario of ['stale','missing','recipe','loading','canvas']){
  const h=draftHarness(),before=structuredClone(h.env.nodesRef.current);
  if(scenario==='loading')h.env.loadingCanvas=true;if(scenario==='canvas')h.env.currentCanvasIdRef.current=null;
  h.action()(scenario==='missing'?'missing':'source',scenario==='stale'?'other.png':h.source.data.resultMediaUrl,scenario==='recipe'?{version:1,id:'invalid',options:{}}:recipes.createCreativeRecipe('relight'));
  assert.deepEqual(h.env.nodesRef.current,before);assert.deepEqual(h.env.edgesRef.current,[]);assert.equal(h.history.length,0);assert.equal(h.dirty(),0);
 }
});
test('actual recipe and camera compile into immutable request while disabled directions and removed recipe disappear',()=>{
 const data:any={generationReferences:[imageReference],generationCreativeRecipe:recipes.createCreativeRecipe('story-grid',{grid:'3x3'}),generationCinematography:directions};const before=structuredClone(data);
 const compiled=request(data);assert.match(compiled.prompt,/3x3/);assert.match(compiled.prompt,/ARRI Alexa 35/);assert.match(compiled.prompt,/Canon K35/);assert.match(compiled.prompt,/35 mm/);assert.match(compiled.prompt,/User instruction/);assert.doesNotMatch(compiled.prompt,/Camera movement/);
 assert.equal(compiled.count,1);assert.equal(compiled.references[0].mediaUrl,imageReference.mediaUrl);assert.deepEqual(data,before);assert.equal(request(data).prompt,compiled.prompt);
 const cleared=request({...data,generationCreativeRecipe:undefined,generationCinematography:{...directions,enabled:false}});
 assert.equal(cleared.prompt,'User instruction');assert.doesNotMatch(cleared.prompt,/图像创意预设|Camera direction/);assert.match(compiled.prompt,/3x3/);
});
test('actual recipe compiler fails visibly without image or with invalid recipe',()=>{
 assert.throws(()=>request({generationCreativeRecipe:recipes.createCreativeRecipe('relight')}),/creative-reference-required/);
 assert.throws(()=>request({generationReferences:[imageReference],generationCreativeRecipe:{version:1,id:'bad',options:{}}}),/invalid-creative-recipe/);
 assert.throws(()=>request({generationKind:'video',generationReferences:[imageReference],generationCreativeRecipe:recipes.createCreativeRecipe('relight')}),/invalid-creative-recipe/);
});
test('actual compiler supports all six text-first recipes without inventing an image reference',()=>{
 for(const action of recipes.IMAGE_CREATIVE_ACTIONS.filter(action=>!action.requiresImage)){
  const data={generationPrompt:'A blue-coated traveler in a glass greenhouse',generationCreativeRecipe:recipes.createCreativeRecipe(action.id)};
  const before=structuredClone(data),compiled=request(data);
  assert.match(compiled.prompt,/A blue-coated traveler in a glass greenhouse/);
  assert.match(compiled.prompt,/根据用户提供的文字描述创作/);
  assert.doesNotMatch(compiled.prompt,/原始参考图|以参考原图/);
  assert.deepEqual(compiled.references,[]);assert.deepEqual(data,before);
 }
});
test('actual compiler accepts real connected text and note bodies for all six text-first recipes',()=>{
 for(const action of recipes.IMAGE_CREATIVE_ACTIONS.filter(action=>!action.requiresImage))for(const kind of ['text','note']){
  const data={generationPrompt:'',generationCreativeRecipe:recipes.createCreativeRecipe(action.id)};
  const input={edgeId:'context-edge',sourceNodeId:'context',role:'promptContext',reference:{id:'node:context',kind,label:'Private note title',text:'A copper robot tending a rooftop garden'}};
  const before=structuredClone(input),compiled=request(data,[input]);
  assert.match(compiled.prompt,/A copper robot tending a rooftop garden/);
  assert.match(compiled.prompt,/根据用户提供的文字描述创作/);
  assert.equal(compiled.prompt.split('A copper robot tending a rooftop garden').length-1,1,'connected body is included exactly once');
  assert.equal(compiled.references.length,1);assert.equal(compiled.references[0].kind,kind);
  if(kind==='note')assert.doesNotMatch(JSON.stringify(compiled),/Private note title/);
  assert.deepEqual(input,before);
 }
});
test('actual compiler never treats a preset, camera direction or empty note title as the subject',()=>{
 for(const action of recipes.IMAGE_CREATIVE_ACTIONS.filter(action=>!action.requiresImage)){
  const data={generationPrompt:' \n\t',generationCreativeRecipe:recipes.createCreativeRecipe(action.id),generationCinematography:directions};
  assert.throws(()=>request(data),/creative-prompt-required/);
  for(const kind of ['text','note']){
   const empty={edgeId:'empty',sourceNodeId:'empty',role:'promptContext',reference:{id:'node:empty',kind,label:'Title alone must not unlock Generate',text:' \n\t'}};
   assert.throws(()=>request(data,[empty]),/creative-prompt-required/);
   assert.throws(()=>request({...data,generationPrompt:' [[lr-ref:empty]] '},[empty]),/creative-prompt-required/,'a reference alias without a body is not a subject');
  }
 }
});
test('actual compiler requires image input only for image-edit recipes and accepts a linked image for every recipe',()=>{
 for(const action of recipes.IMAGE_CREATIVE_ACTIONS){
  const data={generationPrompt:'',generationCreativeRecipe:recipes.createCreativeRecipe(action.id)};
  const input={edgeId:'source-edge',sourceNodeId:'source',role:'reference',reference:imageReference};
  const compiled=request(data,[input]);
  assert.match(compiled.prompt,/原始参考图/);assert.equal(compiled.references[0].mediaUrl,imageReference.mediaUrl);
  if(action.requiresImage){
   assert.throws(()=>request({...data,generationPrompt:'A sufficiently detailed text description'}),/creative-reference-required/);
   assert.throws(()=>request({...data,generationReferences:[{...imageReference,mediaUrl:'  '}]}),/creative-reference-required/);
  }
 }
});
test('actual video request contains movement direction, while text ignores camera and recipe',()=>{
 const video=request({generationKind:'video',generationModel:'video-model',generationCinematography:directions});assert.match(video.prompt,/Camera movement: Dolly in/);assert.match(video.prompt,/ARRI Alexa 35/);
 const text=request({generationKind:'text',generationModel:'text-model',generationCinematography:directions,generationCreativeRecipe:{version:999,id:'bad'}});assert.equal(text.kind,'text');assert.equal(text.prompt,'User instruction');assert.equal(text.count,undefined);assert.equal(text.cameraStrength,undefined);
});
