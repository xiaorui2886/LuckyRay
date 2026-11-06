import data from './workFisherData.json' with {type:'json'};
import upscaleData from './workFisherUpscaleData.json' with {type:'json'};
import {applyComfyLoras, readComfyLoras, type ComfyLoraValues} from './comfyLora';
import type {ComfyApiPrompt, ComfyWorkflowSummary} from './comfyWorkflow';

// This fixed mapping is derived from the user's verified UI-format attachment
// (SHA-256 b9e7f7cc0a0666df6d48701262acc516b0e3b2b4c4b51f505d3576a0feb7c658).
// It is intentionally separate from the existing T8 recipe and never executes
// the UI file. RAM/VRAM cleanup and the author's cached media are omitted.
export const WORK_FISHER_VIDEO_NAME = 'Work-Fisher · 短剧有声视频';
export const WORK_FISHER_TRANSPORT_LIMIT = 9; // current LuckyRay image transport limit, not a model limit
export type WorkFisherVideoOptions = {
  prompt: string; referenceCount: number; aspect?: string; megapixels?: number;
  duration?: number; seed?: number; steps?: number; refImageSize?: 'max'|'match';
  referenceModel?: string; turbo?: boolean; mystic?: boolean; solAttention?: boolean; loras?: ComfyLoraValues;
};
export const WORK_FISHER_ASPECTS:readonly string[] = ['1:1 (Square)','2:3 (Portrait Photo)','3:2 (Photo)','3:4 (Portrait Standard)','4:3 (Standard)','9:16 (Portrait Widescreen)','16:9 (Widescreen)','21:9 (Ultrawide)'];
/** Visible, editable starting text; never replace any existing draft. */
export function suggestedWorkFisherPrompt(preset:unknown,current:string|undefined,english=false):string|undefined {
  if(preset!=='work-fisher-three-view'||(current!==undefined&&current!==''))return undefined;
  return english?'Use the connected character image as reference. Keep the same face, hair, body and clothing. Show complete front, side and back views side by side on a plain white background, at consistent scale, without overlap, text or watermarks.':'请参考连接的角色图，保持同一人物的面部、发型、体型和服装一致。在纯白背景中并排展示正面、侧面和背面全身视图，比例一致、头脚完整且不重叠，不添加文字或水印。';
}
function bad(message:string):never { throw Error(message); }
function num(v:unknown,min:number,max:number,integer=false): v is number {return typeof v==='number' && Number.isFinite(v) && v>=min && v<=max && (!integer || Number.isSafeInteger(v));}
function safeModel(value:unknown):value is string {return typeof value==='string' && value.length>0 && value.length<=300 && !/[\u0000-\u001f\u007f:\\?#]/.test(value) && !value.startsWith('/') && value.split('/').every(p=>!!p&&p!=='.'&&p!=='..');}
function copyVideo():ComfyApiPrompt {return structuredClone(data.video) as unknown as ComfyApiPrompt;}
export function buildWorkFisherVideo(options:WorkFisherVideoOptions):ComfyApiPrompt {
  const {prompt,referenceCount}=options;
  // The attachment demonstrates references, but does not demonstrate zero-image use.
  if(!num(referenceCount,1,WORK_FISHER_TRANSPORT_LIMIT,true)) bad('短剧工作流请连接至少一张参考图；当前画布最多传入 9 张，请以本机节点检查为准。');
  if(typeof prompt!=='string'||prompt.length>20000||prompt.includes('\0')) bad('提示词无效。');
  const aspect=options.aspect??'16:9 (Widescreen)',mp=options.megapixels??0.6,seconds=options.duration??8,seed=options.seed??0,steps=options.steps??12;
  if(!WORK_FISHER_ASPECTS.includes(aspect)||!num(mp,.1,2)||!num(seconds,2,15)||!num(seed,0,Number.MAX_SAFE_INTEGER,true)||!num(steps,1,100,true)) bad('短剧工作流参数超出支持范围。');
  const size=options.refImageSize??'match';if(size!=='match'&&size!=='max')bad('参考图尺寸无效。');
  if(options.referenceModel!==undefined&&!safeModel(options.referenceModel))bad('模型名称无效。');
  for(const option of [options.turbo,options.mystic,options.solAttention])if(option!==undefined&&typeof option!=='boolean')bad('加速选项无效。');
  const g=copyVideo();
  delete g['137'];
  const c=g['136'].inputs;
  delete c['ref_images.ref_image_0'];
  for(let i=0;i<referenceCount;i++) {const id=String(9000+i);g[id]={class_type:'LoadImage',inputs:{image:`luckyray-ref-${i}.png`}};c[`ref_images.ref_image_${i}`]=[id,0];}
  c.ref_image_size=size;g['138'].inputs.value=prompt;g['115'].inputs.aspect_ratio=aspect;g['115'].inputs.megapixels=mp;
  g['132'].inputs.value=seconds;g['129'].inputs.noise_seed=seed;g['163'].inputs.value=steps;
  if(options.referenceModel!==undefined)g['157'].inputs.unet_name=options.referenceModel;
  const sol=options.solAttention??true,mystic=options.loras?.['288']?.enabled??options.mystic??false,turbo=options.loras?.['151']?.enabled??options.turbo??true;
  if(!sol) delete g['155'];
  if(!mystic) delete g['288'];
  if(!turbo) delete g['151'];
  let model=sol?'155':'153';
  if(mystic){g['288'].inputs.model=[model,0];model='288';}
  if(turbo){g['151'].inputs.model=[model,0];model='151';}
  g['124'].inputs.model=[model,0];g['126'].inputs.model=[model,0];
  applyComfyLoras(g,options.loras,['151','288']);
  return g;
}
function same(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
}
export function isWorkFisherVideo(value:unknown):boolean {
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&(value as ComfyApiPrompt)['136']?.class_type==='MiniMaxH3ReferenceToVideo';
}
/** Reconstruct and compare the complete graph before trusting a saved task. */
export function readWorkFisherVideo(value:unknown):{prompt:ComfyApiPrompt; options:WorkFisherVideoOptions} {
  if(!isWorkFisherVideo(value))return bad('短剧工作流格式无效。');
  const g=value as ComfyApiPrompt,c=g['136']?.inputs;
  try {
    const count=Object.keys(c).filter(k=>k.startsWith('ref_images.ref_image_')).length;
    const opts:WorkFisherVideoOptions={prompt:g['138'].inputs.value as string,referenceCount:count,aspect:g['115'].inputs.aspect_ratio as string,
      megapixels:g['115'].inputs.megapixels as number,duration:g['132'].inputs.value as number,seed:g['129'].inputs.noise_seed as number,
      steps:g['163'].inputs.value as number,refImageSize:c.ref_image_size as 'max'|'match',referenceModel:g['157'].inputs.unet_name as string,
      turbo:!!g['151'],mystic:!!g['288'],solAttention:!!g['155'],loras:{...readComfyLoras(copyVideo()),...readComfyLoras(g)}};
    opts.loras!['151'].enabled=!!g['151'];opts.loras!['288'].enabled=!!g['288'];
    const checked=buildWorkFisherVideo(opts);
    if(!same(g,checked))bad('短剧工作流连线或参数不受支持。');
    return {prompt:checked,options:opts};
  } catch {return bad('短剧工作流连线或参数不受支持。');}
}
const pyRound=(n:number)=>{const lo=Math.floor(n);return n-lo===.5?(lo%2?lo+1:lo):Math.round(n);};
export function summarizeWorkFisherVideo(options:WorkFisherVideoOptions):ComfyWorkflowSummary {
  const g=buildWorkFisherVideo(options),[w,h]=String(g['115'].inputs.aspect_ratio).split(' ')[0].split(':').map(Number);
  const scale=Math.sqrt(Number(g['115'].inputs.megapixels)*1024*1024/(w*h));
  const requested=Math.max(5,pyRound(Number(g['132'].inputs.value)*24));
  const frames=requested+((5-(requested%17))%17+17)%17;
  return {model:String(g['157'].inputs.unet_name),width:pyRound(w*scale/32)*32,height:pyRound(h*scale/32)*32,frames,fps:24,durationSeconds:frames/24,videoSteps:Number(g['163'].inputs.value),audioSteps:Number(g['163'].inputs.value)};
}

export type WorkFisherImagePreset='work-fisher-character'|'work-fisher-scene'|'work-fisher-three-view';
export type WorkFisherImageOptions={preset:WorkFisherImagePreset;prompt:string;referenceCount:number;seed?:number;width?:number;height?:number;aspect?:string;megapixels?:number;loras?:ComfyLoraValues;upscale?:boolean;upscaleResolution?:number};
const IMAGE_MAP={
  'work-fisher-character':{key:'character',out:'241',text:'248',seed:'235',width:'251',height:'252'},
  'work-fisher-scene':{key:'scene',out:'267',text:'277',seed:'261',width:'275',height:'276'},
  'work-fisher-three-view':{key:'threeView',out:'212',text:'214',seed:'211',width:'',height:''},
} as const;
export function isWorkFisherImagePreset(value:unknown):value is WorkFisherImagePreset {return typeof value==='string'&&Object.prototype.hasOwnProperty.call(IMAGE_MAP,value);}
export function buildWorkFisherImage(options:WorkFisherImageOptions):ComfyApiPrompt {
  const {preset,prompt,referenceCount}=options;
  if(!isWorkFisherImagePreset(preset))return bad('图片工作流无效。');
  if(typeof prompt!=='string'||prompt.length>20000||prompt.includes('\0'))return bad('提示词无效。');
  const config=IMAGE_MAP[preset],three=preset==='work-fisher-three-view';
  if(referenceCount!==(three?1:0))return bad(three?'三视图请连接一张角色参考图。':'文字生图不使用参考图，请移除图片或切换到视频、三视图。');
  const seed=options.seed??0;if(!num(seed,0,Number.MAX_SAFE_INTEGER,true))return bad('种子无效。');
  const g=structuredClone(data[config.key]) as unknown as ComfyApiPrompt;
  g[config.text].inputs[three?'prompt':'text']=prompt;g[config.seed].inputs.seed=seed;
  if(three){
    const aspect=options.aspect??'16:9 (Widescreen)',mp=options.megapixels??2;
    if(!WORK_FISHER_ASPECTS.includes(aspect)||!num(mp,.1,2))return bad('三视图尺寸无效。');
    g['213'].inputs.aspect_ratio=aspect;g['213'].inputs.megapixels=mp;
    delete g['215'];g['9000']={class_type:'LoadImage',inputs:{image:'luckyray-ref-0.png'}};
    g['206'].inputs['images.image_1']=['9000',0];
  } else {
    const width=options.width??Number(g[config.width].inputs.value),height=options.height??Number(g[config.height].inputs.value);
    if(!num(width,256,2048,true)||!num(height,256,2048,true)||width%8||height%8)return bad('图片宽高需为 256 至 2048，且是 8 的倍数。');
    g[config.width].inputs.value=width;g[config.height].inputs.value=height;
  }
  applyComfyLoras(g,options.loras);
  if(options.upscale!==undefined&&typeof options.upscale!=='boolean')return bad('放大选项无效。');
  if(options.upscale){
    const resolution=options.upscaleResolution??2560;
    if(!num(resolution,512,4096,true)||resolution%2)return bad('放大短边需为 512 至 4096 的偶数。');
    const extra=structuredClone(upscaleData) as unknown as ComfyApiPrompt;
    // Same image-only SeedVR2 chain as the local Work-Fisher graph. The old
    // export's cache_model string is replaced with the installed BOOL default.
    extra['234'].inputs.image=[three?'202':preset==='work-fisher-character'?'236':'262',0];
    extra['231'].inputs.seed=seed%4294967296;extra['237'].inputs.value=resolution;
    Object.assign(g,extra);g[config.out].inputs.images=['231',0];
  }
  return g;
}
export function isWorkFisherImage(value:unknown):boolean {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const g=value as ComfyApiPrompt;
  return Object.values(IMAGE_MAP).some(v=>g[v.out]?.class_type==='SaveImage');
}
export function readWorkFisherImage(value:unknown):{prompt:ComfyApiPrompt;options:WorkFisherImageOptions;outputNodeId:string;imageNodeIds:string[]} {
  if(!isWorkFisherImage(value))return bad('图片工作流格式无效。');
  const g=value as ComfyApiPrompt;
  try {
    const entries=(Object.entries(IMAGE_MAP) as [WorkFisherImagePreset,typeof IMAGE_MAP[WorkFisherImagePreset]][]).filter(([,c])=>g[c.out]?.class_type==='SaveImage');
    if(entries.length!==1)return bad('图片工作流输出无效。');
    const [preset,c]=entries[0],three=preset==='work-fisher-three-view';
    const options:WorkFisherImageOptions={preset,prompt:g[c.text].inputs[three?'prompt':'text'] as string,referenceCount:three?1:0,seed:g[c.seed].inputs.seed as number,loras:readComfyLoras(g),upscale:!!g['231'],...(g['231']?{upscaleResolution:g['237']?.inputs.value as number}:{}),
      ...(three?{aspect:g['213'].inputs.aspect_ratio as string,megapixels:g['213'].inputs.megapixels as number}:{width:g[c.width].inputs.value as number,height:g[c.height].inputs.value as number})};
    const checked=buildWorkFisherImage(options);
    if(!same(g,checked))return bad('图片工作流连线或参数不受支持。');
    return {prompt:checked,options,outputNodeId:c.out,imageNodeIds:three?['9000']:[]};
  } catch {return bad('图片工作流连线或参数不受支持。');}
}
