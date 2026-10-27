import {captureGenerationEditorSnapshot} from "../src/core/canvas/generationEditorSnapshot";
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {mediaCapabilities,mediaOption,mediaQualityOption} from '../src/core/canvas/mediaCapabilities';
import {compileCinematographyPrompt} from '../src/core/canvas/cinematography';
import {compileCreativeRecipePrompt,validateCreativeRecipeInput} from '../src/core/canvas/imageCreativeActions';
import {createCanvasReferencePlan,canvasReferenceSnapshots} from '../src/core/canvas/referencePlan';
import {compileMentionedPrompt,parseReferenceMentions} from '../src/core/canvas/referenceMentions';
import {compileCanvasGenerationInputs} from '../src/core/canvas/generationInputCompiler';
import {createCanvasImageGenerationAdapter} from '../src/core/canvas/imageGenerationAdapter';
import {createCanvasVideoGenerationAdapter,prepareCanvasVideoBridgeReferences} from '../src/core/canvas/videoGenerationAdapter';
const root=readFileSync('src/CanvasSpike.tsx','utf8'),app=readFileSync('src/App.tsx','utf8');
function extract(source:string,start:string,end:string,name:string,deps:Record<string,unknown>){
 const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);
 return Function(...Object.keys(deps),transformSync(source.slice(a,b),{loader:'tsx',target:'es2022'}).code+`;return ${name};`)(...Object.values(deps));
}
const compile=extract(root,'function createGenerationRequestSnapshot(','\nfunction MaterialCompactComposer','createGenerationRequestSnapshot',{captureGenerationEditorSnapshot,mediaCapabilities,mediaOption,mediaQualityOption,compileCinematographyPrompt,compileCreativeRecipePrompt,validateCreativeRecipeInput,createCanvasReferencePlan,canvasReferenceSnapshots,compileMentionedPrompt,parseReferenceMentions,compileCanvasGenerationInputs,inferGenerationKind:(n:any)=>n.data.generationKind});
async function wire(kind:string,model:string,protocol:string,data:any,baseUrl='https://example.test/v1'){
 const profile={imageProtocol:kind==='image'?protocol:'disabled',videoProtocol:kind==='video'?protocol:'disabled',baseUrl};
 const request=compile({id:'n',data:{kind:'generator',generationKind:kind,generationModel:model,generationPrompt:'Synthetic subject',...data}},[],[],'',kind==='image'?[model]:[] ,kind==='image'?model:'',kind==='video'?[model]:[],kind==='video'?model:'',profile,false);
 request.mediaProfileId='synthetic';request.mediaProfileRevision=7;
 const calls:any[]=[];
 const deps={invoke:async(command:string,args:any)=>{calls.push({command,args});return{success:true,images:[{url:'https://example.test/image.png'}],video_url:'https://example.test/video.mp4'};},prepareCanvasVideoBridgeReferences,prepareCanvasMediaReference:async(v:string)=>v,materializeCanvasGeneratedImage:async(v:string)=>v,canvasGenerationFailure:(error_kind:string)=>({error_kind})};
 const bridge=kind==='image'?extract(app,'async function aiImageGenerate(','async function aiVideoGenerate(','aiImageGenerate',deps):extract(app,'async function aiVideoGenerate(','\nasync function ', 'aiVideoGenerate',deps);
 const adapter=kind==='image'?createCanvasImageGenerationAdapter(bridge):createCanvasVideoGenerationAdapter(bridge);
 const result=await adapter.execute(request);assert.equal(result.ok,true);assert.equal(calls.length,1);
 assert.equal(calls[0].args.mediaProfileId,'synthetic');assert.equal(calls[0].args.mediaProfileRevision,7);
 return {request,payload:calls[0].args.request};
}
test('real compiler → adapter → App preserves image options across protocols',async()=>{
 for(const [model,protocol,aspect,quality,resolution,count,base] of [
 ['gpt-image-2.5-flare','easycli-auto','21:9','max','4K',4,'http://127.0.0.1:8317/v1'],
 ['gpt-image-1.5','openai-image','2:3','high',undefined,3],
 ['gemini-3.1-flash-image','gemini-image','1:8','512',undefined,1],
 ['gpt-image-2','12ai-task','16:9','high','2K',1],
 ['gemini-3-pro-image-preview','12ai-task','4:3','2K',undefined,1],
 ['agnes-image-2.5-flash','agnes','21:9','3K',undefined,1],
 ['agnes-image-2.0-flash','agnes','4:3',undefined,undefined,1],
 ['dall-e-3','openai-image','7:4','hd',undefined,1],
 ] as any[]) {
  const {payload}=await wire('image',model,protocol,{generationAspect:aspect,generationQuality:quality,generationResolution:resolution,generationCount:count},base);
  assert.equal(payload.aspect,aspect,model);assert.equal(payload.quality,quality??null,model);assert.equal(payload.resolution,resolution??null,model);assert.equal(payload.count,count,model);
 }
});
test('stale options normalize equally in displayed capabilities and wire snapshot',async()=>{
 const {payload}=await wire('image','gemini-3.1-flash-image','easycli-auto',{generationAspect:'16:9',generationQuality:'max',generationResolution:'4K',generationCount:4});
 assert.equal(payload.resolution,null);assert.equal(payload.quality,'1K');assert.equal(payload.count,1);
 const old=await wire('image','gpt-image-1.5','openai-image',{generationAspect:'21:9',generationQuality:'4K',generationResolution:'4K'});
 assert.equal(old.payload.aspect,'1:1');assert.equal(old.payload.quality,'low');assert.equal(old.payload.resolution,null);
 const dalle=await wire('image','dall-e-3','openai-image',{generationAspect:'3:2',generationQuality:'hd'});assert.equal(dalle.payload.aspect,'7:4');
});
test('EasyCLI Gemini portrait single-image request matches fresh and switched node options',async()=>{
 for (const stale of [{}, {generationResolution:'4K',generationCount:4}]) {
  const {payload}=await wire('image','gemini-3.1-flash-image','easycli-auto',{
   ...stale,generationAspect:'9:16',generationQuality:'1K',generationCount:1,
  },'http://127.0.0.1:8317/v1');
  assert.equal(payload.model,'gemini-3.1-flash-image');
  assert.equal(payload.aspect,'9:16');assert.equal(payload.quality,'1K');
  assert.equal(payload.resolution,null);assert.equal(payload.count,1);
 }
});

test('real video chain preserves verified fields and omits unsupported legacy options',async()=>{
 for(const [model,protocol,aspect,quality,duration] of [
 ['sora-2','openai-video','9:16','720p',12],['seedance-2.0','12ai-task','9:16','720p',10],
 ['agnes-video-2.5','agnes','3:4','2K',11],['agnes-video-2.5-flash','agnes','21:9','720p',6],
 ] as any[]) {
  const {payload}=await wire('video',model,protocol,{generationAspect:aspect,generationQuality:quality,generationDuration:duration});
  assert.equal(payload.aspect,aspect,model);assert.equal(payload.quality,quality??null,model);assert.equal(payload.duration,duration,model);
 }
 const legacy=await wire('video','agnes-video-v2.0','agnes',{generationAspect:'9:16',generationQuality:'480p',generationDuration:15,generationCameraStrength:80,generationSound:true});
 for(const key of ['aspect','quality','duration','sound'])assert.equal(legacy.payload[key],null,key);
 assert.equal(legacy.request.cameraStrength,undefined);
 const flash=mediaCapabilities('video',{videoProtocol:'agnes'} as any,'agnes-video-2.5-flash');
 assert.deepEqual(flash.qualities,['720p']);assert.ok(!flash.durations.includes(15));assert.equal(flash.camera,false);
});

test('production inspector shows selected secondary model options, matching compiler and App',async()=>{
 const make=(type:any,props:any,...children:any[])=>({type,props:props||{},children});
 const inspect=extract(root,'function MaterialGenerationInspector(','\nfunction MaterialQuickInspector','MaterialGenerationInspector',{
  React:{createElement:make,Fragment:'fragment'},useState:(v:any)=>[v,()=>{}],useI18n:()=>({t:(key:string)=>key}),
  mediaCapabilities,mediaOption,mediaQualityOption,mediaParameterKind:()=> 'quality',mediaPixelSize:()=>undefined,mediaParameterLabel:(v:string)=>v,
  ToolIcon:'icon',CanvasReferencePreview:'preview',CanvasAspectOptions:'aspect',
 });
 const profile={imageProtocol:'easycli-auto',baseUrl:'http://127.0.0.1:8317/v1',imageModel:'gemini-3.1-flash-image',imageModels:['gemini-3.1-flash-image','gpt-image-2.5-flare']};
 const data={kind:'image',generationModel:'gpt-image-2.5-flare',generationAspect:'9:21',generationQuality:'max',generationResolution:'4K',generationCount:4};
 const tree=inspect({node:{id:'n',data},mediaProfile:profile,onDataChange:()=>{},onOpenReference:()=>{}});
 const nodes:any[]=[];function walk(v:any){if(Array.isArray(v)){v.forEach(walk);return;}if(v&&typeof v==='object'){nodes.push(v);walk(v.children);}}walk(tree);
 const aspect=nodes.find(n=>n.type==='aspect');assert.equal(aspect.props.value,'9:21');assert.ok(aspect.props.options.includes('9:21'));
 const selected=nodes.filter(n=>n.props['aria-pressed']===true).flatMap(n=>n.children);
 assert.ok(selected.includes('max'));assert.ok(selected.includes('4K'));
 const wireResult=await wire('image',data.generationModel,'easycli-auto',data);
 assert.equal(wireResult.payload.aspect,aspect.props.value);assert.equal(wireResult.payload.quality,'max');assert.equal(wireResult.payload.resolution,'4K');
});

test('restored history cannot silently switch an unavailable original model to connection default',()=>{
 const node={id:'restored',data:{kind:'generator',generationKind:'image',generationPrompt:'Original',generationModel:'original-model',sourceGenerationHistoryId:'old'}};
 assert.throws(()=>compile(node,[],[],'',['different-model'],'different-model',[],'',{imageProtocol:'openai-image'},false),/historical-model-unavailable/);
 const restored=compile(node,[],[],'',['original-model'],'original-model',[],'',{imageProtocol:'openai-image'},false);
 assert.equal(restored.model,'original-model');
});
