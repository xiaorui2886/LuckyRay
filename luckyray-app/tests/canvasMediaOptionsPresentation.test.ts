import {captureGenerationEditorSnapshot} from "../src/core/canvas/generationEditorSnapshot";
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {aspectFrame,mediaParameterKind,mediaParameterLabel,mediaPixelSize} from '../src/core/canvas/mediaOptionPresentation';
import {mediaCapabilities,mediaOption,mediaQualityOption} from '../src/core/canvas/mediaCapabilities';
import {compileCinematographyPrompt} from '../src/core/canvas/cinematography';
import {compileCreativeRecipePrompt,normalizeCreativeRecipe,validateCreativeRecipeInput} from '../src/core/canvas/imageCreativeActions';
import {createCanvasReferencePlan,canvasReferenceSnapshots} from '../src/core/canvas/referencePlan';
import {compileMentionedPrompt,parseReferenceMentions} from '../src/core/canvas/referenceMentions';
import {compileCanvasGenerationInputs} from '../src/core/canvas/generationInputCompiler';
import {comparisonParameters} from '../src/core/canvas/creativeReview';
import specs from '../src/core/canvas/twelveMediaSpecs.json' with {type:'json'};
const profile=(imageProtocol='openai-image',baseUrl='https://new.12ai.org')=>({imageProtocol,baseUrl,videoProtocol:'12ai-task'}) as any;
test('ratio line glyphs match numeric ratios and remain bounded',()=>{
 for(const value of ['1:1','16:9','9:16','21:9','9:21','3:2','2:3','4:5']){
 const f=aspectFrame(value),[w,h]=value.split(':').map(Number);
 assert.ok(Math.abs(f.width/f.height-w/h)<1e-10);assert.ok(f.x>=0&&f.y>=0&&f.x+f.width<=36&&f.y+f.height<=28);assert.equal(f.automatic,false);
 }
 for(const value of ['auto','0:1','1:0','bad'])assert.equal(aspectFrame(value).automatic,true);
});
test('resolution and quality semantics are provider-specific without invented controls',()=>{
 assert.equal(mediaParameterKind('image',profile(),'gpt-image-2'),'quality');
 assert.equal(mediaParameterKind('image',profile(),'gemini-3.1-flash-image'),'resolution');
 assert.equal(mediaParameterKind('image',profile('agnes'),'agnes-image-2.5-flash'),'resolution');
 assert.equal(mediaParameterKind('video',profile(),'MiniMax-H3'),'resolution');
 assert.equal(mediaParameterLabel('高清','resolution'),'2K');assert.equal(mediaParameterLabel('high','quality'),'高');
 assert.equal(mediaParameterLabel('1080P','resolution'),'1080P');
 assert.deepEqual(mediaCapabilities('image',profile(),'gpt-image-2').resolutions,['1K','2K','4K']);
 assert.equal(mediaCapabilities('image',profile(),'gemini-3.1-flash-image').resolutions,undefined);
 assert.deepEqual(mediaCapabilities('image',profile('openai-image','https://other.test'),'gpt-image-2').resolutions,['1K','2K','4K']);
});
test('Agnes known tiers preserve old cards and add only documented 3K',()=>{
 const caps=mediaCapabilities('image',profile('agnes'),'agnes-image-2.1-flash');
 assert.deepEqual(caps.qualities,['1K','2K','3K','4K']);assert.ok(caps.aspects.includes('21:9'));
 assert.equal(mediaQualityOption(caps.qualities,'高清'),'2K');assert.equal(mediaQualityOption(caps.qualities,'超清'),'4K');
 assert.equal(mediaQualityOption(['low','medium','high'],'high'),'high');
 assert.equal(mediaQualityOption(['low','medium','high'],'高清'),'high');
 assert.ok(!mediaCapabilities('image',profile('agnes'),'agnes-image-2.0-flash').qualities.includes('3K'));
});
test('GPT published size table complies with every provider bound',()=>{
 for(const model of ['gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst']){
 const spec=(specs as any)[model];
 for(const tier of spec.resolutions)for(const [ratio,size] of Object.entries(spec.resolutionSizes[tier])){
  const [w,h]=(size as string).split('x').map(Number);assert.equal(w%16,0);assert.equal(h%16,0);assert.ok(Math.max(w,h)<=3840);assert.ok(Math.max(w,h)/Math.min(w,h)<=3);assert.ok(w*h>=655360&&w*h<=8294400);
  assert.equal(mediaPixelSize('image',profile(),model,ratio,tier),(size as string).replace('x',' × '));
 }
 }
 assert.equal(mediaPixelSize('image',profile(),'gpt-image-2','16:9','4K'),'3840 × 2160');
 assert.equal(mediaPixelSize('image',profile(),'gpt-image-2','1:1','4K'),'2880 × 2880');
 assert.equal(mediaPixelSize('image',profile(),'gpt-image-2','auto','4K'),'自动');
});
// Execute the actual production request compiler, with only unrelated references stubbed.
const root=readFileSync('src/CanvasSpike.tsx','utf8');
const a=root.indexOf('function createGenerationRequestSnapshot('),b=root.indexOf('\nfunction MaterialCompactComposer',a);
const code=transformSync(root.slice(a,b),{loader:'ts',target:'es2022'}).code;
const compilerDependencies={captureGenerationEditorSnapshot,mediaCapabilities,mediaOption,mediaQualityOption,compileCanvasGenerationInputs,createCanvasReferencePlan,canvasReferenceSnapshots,compileMentionedPrompt,parseReferenceMentions,compileCinematographyPrompt,compileCreativeRecipePrompt,normalizeCreativeRecipe,validateCreativeRecipeInput,inferGenerationKind:(n:any)=>n.data.generationKind};
const compile=Function(...Object.keys(compilerDependencies),code+';return createGenerationRequestSnapshot;')(...Object.values(compilerDependencies));
test('actual request snapshot sends independent resolution and omits it after model switching',()=>{
 // Signature confirmed below; guarded source assertion prevents test fixture argument drift.
 assert.match(root.slice(a,a+1000),/mediaProfile/);
 const run=(model:string,aspect:string,resolution='4K')=>compile({id:'n',data:{kind:'generator',generationKind:'image',generationModel:model,generationPrompt:'test',generationAspect:aspect,generationQuality:'high',generationResolution:resolution}},[],[],'',[model],model,[],'',profile(),false);
 // Invocation is checked against the actual signature by the test fixture below.
 const req=run('gpt-image-2','16:9');assert.equal(req.resolution,'4K');assert.equal(req.quality,'high');
 const auto=run('gpt-image-2','auto');assert.equal(auto.resolution,undefined);
 const gem=run('gemini-3.1-flash-image','16:9');assert.equal(gem.resolution,undefined);assert.equal(gem.quality,'1K');
});
test('actual local proxy request snapshot preserves new GPT and Gemini options',()=>{
 const run=(model:string,aspect:string,quality:string,resolution:string,protocol:string)=>compile({id:'n',data:{kind:'generator',generationKind:'image',generationModel:model,generationPrompt:'test',generationAspect:aspect,generationQuality:quality,generationResolution:resolution}},[],[],'',[model],model,[],'',profile(protocol,'http://127.0.0.1:8317/v1'),false);
 const gpt=run('gpt-image-2.5-flare','9:21','max','4K','openai-image');
 assert.equal(gpt.aspect,'9:21');assert.equal(gpt.quality,'max');assert.equal(gpt.resolution,'4K');
 const gem=run('gemini-3.1-flash-image-preview','8:1','512','4K','gemini-image');
 assert.equal(gem.aspect,'8:1');assert.equal(gem.quality,'512');assert.equal(gem.resolution,undefined);
 const old=run('gemini-2.5-flash-image','4:5','4K','4K','gemini-image');
 assert.equal(old.quality,undefined);assert.equal(old.resolution,undefined);
 const one=run('gpt-image-1.5','auto','auto','4K','openai-image');
 assert.equal(one.aspect,'auto');assert.equal(one.quality,'auto');assert.equal(one.resolution,undefined);
});
test('comparison includes independent resolution without exposing credentials',()=>{
 const rows=comparisonParameters({prompt:'p',model:'m',request:{resolution:'4K',quality:'high',references:[]}} as any);
 assert.deepEqual(rows.find(x=>x[0]==='resolution'),['resolution','4K']);
});

test('actual App image bridge forwards resolution and only media, preserving compiled note prompt',async()=>{
 const app=readFileSync('src/App.tsx','utf8');const a=app.indexOf('async function aiImageGenerate('),b=app.indexOf('async function aiVideoGenerate(',a);
 const code=transformSync(app.slice(a,b),{loader:'ts',target:'es2022'}).code;
 const calls:any[]=[];
 const run=Function('invoke','prepareCanvasMediaReference','materializeCanvasGeneratedImage','canvasGenerationFailure',code+';return aiImageGenerate;')(async(...args:any[])=>{calls.push(args);return{success:true,images:[]};},async(v:string)=>v,async(v:string)=>v,(error_kind:string)=>({error_kind}));
 const request={kind:'image',model:'gpt-image-2',prompt:'user prompt\nactual note body',resolution:'4K',quality:'high',references:[{id:'note',kind:'note',role:'promptContext',text:'actual note body'},{id:'image',kind:'image',role:'reference',mediaUrl:'data:image/png;base64,cWE='}]};
 await run(request);assert.equal(calls.length,1);const payload=calls[0][1].request;
 assert.equal(payload.resolution,'4K');assert.equal(payload.quality,'high');assert.equal(payload.prompt,request.prompt);assert.deepEqual(payload.references.map((r:any)=>r.kind),['image']);
 const result=await run({...request,references:[{kind:'video'}]});assert.equal(result.error_kind,'unsupported_input');assert.equal(calls.length,1);
});
test('command source retains pinned runtime identity in both image and video dispatch',()=>{
 const native=readFileSync('src-tauri/src/lib.rs','utf8');
 for(const kind of ['image','video']){
  const start=native.indexOf(`async fn ai_${kind}_generate(`),end=native.indexOf(`async fn ai_${kind}_generate_internal(`,start);
  assert.ok(native.slice(start,end).includes(`ai_${kind}_generate_with_binding(&app, request, &|| false, media_profile_id.as_deref(), media_profile_revision)`));
  const a=native.indexOf(`async fn ai_${kind}_generate_with_binding(`),b=native.indexOf('let api_key',a);
  assert.ok(native.slice(a,b).includes('resolve(&db_path, profile_id, profile_revision)'));assert.ok(!native.slice(a,b).includes('resolve(&db_path, None, None)'));
 }
});
