/** Explicit local H3 recipes. No arbitrary expression execution or unrelated output nodes. */
import {buildWorkFisherVideo,isWorkFisherVideo,readWorkFisherVideo,summarizeWorkFisherVideo} from './workFisherPreset';
import {applyComfyLoras, type ComfyLoraValues} from './comfyLora';
// Legacy editor labels remain readable; new requests derive their mode from references.
export const COMFY_MAX_REFERENCE_IMAGES = 9; // T8 ref_images Autogrow protocol limit, not a VRAM guarantee.
export function comfyModeForImageCount(count: number): ComfyGenerationMode { return count === 0 ? "text" : count === 1 ? "single-image" : "multi-image"; }
export type ComfyGenerationMode = "text" | "single-image" | "multi-image";
export type ComfyApiValue = string | number | boolean | [string, number];
export type ComfyApiNode = { class_type: string; inputs: Record<string, ComfyApiValue> };
export type ComfyApiPrompt = Record<string, ComfyApiNode>;
export type ComfyBinding = { nodeId: string; input: string };
export type ComfyWorkflowBindings = {
  images: ComfyBinding[]; conditioningNodeId: string; modelNodeId: string;
  prompt: ComfyBinding; duration: ComfyBinding; seed: ComfyBinding;
  aspect: ComfyBinding; megapixels: ComfyBinding; videoSteps: ComfyBinding; audioSteps: ComfyBinding; outputNodeId: string;
};
export type ComfyWorkflowSummary = {
  model: string; width: number; height: number; frames: number; fps: number;
  durationSeconds: number; videoSteps: number; audioSteps: number;
};
export type ComfyWorkflow = {
  family?: 'work-fisher-video';
  mode: ComfyGenerationMode;
  version: 1; id: string; name: string; prompt: ComfyApiPrompt;
  bindings: ComfyWorkflowBindings; summary: ComfyWorkflowSummary;
};
export type ComfyWorkflowEdits = {
  mode?: ComfyGenerationMode; referenceModel?: string; refImageSize?: "max" | "match";
  turbo?: boolean; mystic?: boolean; solAttention?: boolean; loras?: ComfyLoraValues;
  prompt: string; duration?: number; seed?: number; aspect?: string; megapixels?: number; videoSteps?: number; audioSteps?: number;
  references?: readonly { kind: string; mediaUrl?: string | null }[];
};
export type ComfyWorkflowDefaults = { refImageSize: "max" | "match"; prompt: string; duration: number; seed: number; aspect: string; megapixels: number; videoSteps: number; audioSteps: number };
export const COMFY_WORKFLOW_LIMITS = { bytes: 256 * 1024, prompt: 20000, durationMin: 2, durationMax: 15, megapixelsMin: 0.1, megapixelsMax: 2, stepsMin: 1, stepsMax: 100 } as const;
export const COMFY_ASPECTS = [
  '1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Photo)', '3:4 (Portrait Standard)',
  '4:3 (Standard)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '21:9 (Ultrawide)',
] as const;
export const COMFY_H3_EXPRESSION = 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17';
export class ComfyWorkflowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ComfyWorkflowError'; this.code = code; }
}
function fail(code: string, message: string): never { throw new ComfyWorkflowError(code, message); }
function invalid(detail = ''): never { return fail('COMFY_WORKFLOW_UNSUPPORTED', `这个工作流不符合当前 MiniMax H3 接入格式${detail ? `：${detail}` : ''}`); }
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysOnly = (v: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(v).some(k => !keys.includes(k))) invalid('包含不支持的字段');
};
const numeric = (v: unknown, min: number, max: number, integer = false): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isSafeInteger(v));
const cleanString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const modelName = (v: unknown) => cleanString(v, 300) && !/^(?:[a-z]+:|[/\\])/i.test(v) && !v.includes(':') && !v.split(/[/\\]/).some(p => p === '..' || p === '.');
const fields: Record<string, readonly string[]> = {
  LoadImage: ['image'],
  VAELoader: ['vae_name'], UNETLoader: ['unet_name', 'weight_dtype'],
  PrimitiveStringMultiline: ['value'], ResolutionSelector: ['aspect_ratio', 'megapixels', 'multiple'],
  PrimitiveFloat: ['value'], CLIPLoader: ['clip_name', 'type', 'device'],
  ReservedVRAMSetter: ['reserved', 'mode', 'seed', 'auto_max_reserved', 'clean_gpu_before', 'anything'],
  MiniMaxH3MemoryEfficientSageAttentionPatch: ['model'], MiniMaxH3AVDecodeT8: ['av_latent', 'video_vae', 'audio_vae'],
  SamplerCustomAdvanced: ['noise', 'guider', 'sampler', 'sigmas', 'latent_image'],
  VHS_VideoCombine: ['frame_rate', 'loop_count', 'filename_prefix', 'format', 'pix_fmt', 'crf', 'save_metadata', 'trim_to_audio', 'pingpong', 'save_output', 'images', 'audio'],
  MiniMaxH3MultiRateSamplerEXPT8: ['video_steps', 'audio_steps', 'shift_video', 'shift_audio', 'model', 'av_latent'],
  BasicGuider: ['model', 'conditioning'], RandomNoise: ['noise_seed'],
  MiniMaxH3AudioConditioningT8: ['prompt', 'width', 'height', 'length', 'task_type', 'audio_mode', 'audio_denoise_strength', 'add_source_as_reference', 'prompt_primary_audio_ordinal', 'strict_prompt_tags', 'ref_image_size', 'reference_video_policy', 'clip', 'video_vae', 'audio_vae'],
  ComfyMathExpression: ['expression', 'values.a'], UniBlockSwap: ['num_blocks'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model', 'model'],
};

function inspectGraph(input: unknown): { prompt: ComfyApiPrompt; bindings: ComfyWorkflowBindings } {
  if (!record(input)) invalid('文件不是 JSON 对象');
  if (Array.isArray(input.nodes) || own(input, 'links')) fail('COMFY_API_EXPORT_REQUIRED', '请在 ComfyUI 选择“导出（API）”，普通工作流文件不能用于生成。');
  const entries = Object.entries(input);
  if (entries.length < 18 || entries.length > 19 + COMFY_MAX_REFERENCE_IMAGES) invalid('节点数量不匹配');
  const prompt: ComfyApiPrompt = Object.create(null);
  const classes = new Map<string, string[]>();
  for (const [id, raw] of entries) {
    if (!/^[0-9]{1,12}$/.test(id) || !record(raw) || typeof raw.class_type !== 'string' || !own(fields, raw.class_type) || !record(raw.inputs)) invalid('节点类型不受支持');
    keysOnly(raw, ['inputs', 'class_type', '_meta']);
    const required = fields[raw.class_type];
    const allowed = raw.class_type === 'MiniMaxH3AudioConditioningT8'
      ? [...required, ...Array.from({length:COMFY_MAX_REFERENCE_IMAGES},(_,i)=>`ref_images.ref_image_${i}`)] : required;
    keysOnly(raw.inputs, allowed);
    if (required.some(k => !own(raw.inputs as object, k))) invalid('节点参数缺失');
    const inputs: Record<string, ComfyApiValue> = Object.create(null);
    for (const [key, value] of Object.entries(raw.inputs)) {
      if (Array.isArray(value)) {
        if (value.length !== 2 || typeof value[0] !== 'string' || !own(input, value[0]) || !numeric(value[1], 0, 8, true)) invalid('节点连线无效');
        inputs[key] = [value[0], value[1]];
      } else if (typeof value === 'string' && value.length <= COMFY_WORKFLOW_LIMITS.prompt && !value.includes('\0')) inputs[key] = value;
      else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) inputs[key] = value;
      else invalid('节点参数无效');
    }
    prompt[id] = { class_type: raw.class_type, inputs };
    classes.set(raw.class_type, [...(classes.get(raw.class_type) ?? []), id]);
  }
  const one = (type: string): string => {
    const ids = classes.get(type); if (!ids || ids.length !== 1) invalid(`需要唯一 ${type} 节点`); return ids[0];
  };
  const link = (id: string, field: string, target: string, port: number) => {
    const v = prompt[id].inputs[field]; if (!Array.isArray(v) || v[0] !== target || v[1] !== port) invalid('连线与支持的音视频流程不一致');
  };
  const output = one('VHS_VideoCombine'), decode = one('MiniMaxH3AVDecodeT8'), sampler = one('SamplerCustomAdvanced');
  const cond = one('MiniMaxH3AudioConditioningT8'), guide = one('BasicGuider'), rate = one('MiniMaxH3MultiRateSamplerEXPT8');
  const text = one('PrimitiveStringMultiline'), resolution = one('ResolutionSelector'), seconds = one('PrimitiveFloat'), noise = one('RandomNoise');
  const math = one('ComfyMathExpression'), clip = one('CLIPLoader'), unet = one('UNETLoader'), reserved = one('ReservedVRAMSetter');
  const attention = one('MiniMaxH3MemoryEfficientSageAttentionPatch'), lora = one('LoraLoaderModelOnly');
  const vaes = classes.get('VAELoader'); if (!vaes || vaes.length !== 2) invalid('需要音频与视频 VAE');
  const videoLink = prompt[cond].inputs.video_vae, audioLink = prompt[cond].inputs.audio_vae;
  if (!Array.isArray(videoLink) || !Array.isArray(audioLink) || videoLink[0] === audioLink[0] || !vaes.includes(videoLink[0]) || !vaes.includes(audioLink[0])) invalid('VAE 连线无效');
  for (const [id, field, target, port] of [
    [output,'images',decode,0],[output,'audio',decode,1],[decode,'av_latent',sampler,0],
    [decode,'video_vae',videoLink[0],0],[decode,'audio_vae',audioLink[0],0],
    [cond,'video_vae',videoLink[0],0],[cond,'audio_vae',audioLink[0],0],
    [sampler,'noise',noise,0],[sampler,'guider',guide,0],[sampler,'sampler',rate,1],[sampler,'sigmas',rate,2],[sampler,'latent_image',cond,1],
    [guide,'model',rate,0],[guide,'conditioning',cond,0],[rate,'av_latent',cond,1],[rate,'model',lora,0],
    [lora,'model',attention,0],[attention,'model',reserved,0],[reserved,'anything',unet,0],
    [cond,'prompt',text,0],[cond,'width',resolution,0],[cond,'height',resolution,1],[cond,'length',math,1],[cond,'clip',clip,0],[math,'values.a',seconds,0],
  ] as [string,string,string,number][]) link(id,field,target,port);
  const c = prompt[cond].inputs, o = prompt[output].inputs, r = prompt[resolution].inputs;
  const imageIds = classes.get('LoadImage') ?? [];
  const imageBindings: ComfyBinding[] = [];
  if (c.task_type === 'T2VA' || (c.task_type === 'auto' && imageIds.length === 0)) {
    if (imageIds.length || Object.keys(c).some(k => k.startsWith('ref_images.')) || c.ref_image_size !== 'max') invalid('文生视频不能包含图片分支');
  } else if (c.task_type === 'Ref2VA' || c.task_type === 'auto') {
    if (imageIds.length < 1 || imageIds.length > COMFY_MAX_REFERENCE_IMAGES || !['max','match'].includes(String(c.ref_image_size))) invalid('参考图数量或处理尺寸无效');
    for (let i=0;i<COMFY_MAX_REFERENCE_IMAGES;i++) {
      const value=c[`ref_images.ref_image_${i}`];
      if(i>=imageIds.length) { if(value!==undefined) invalid('参考图连线不连续'); continue; }
      if(!Array.isArray(value) || value[1]!==0 || !imageIds.includes(value[0]) || imageBindings.some(b=>b.nodeId===value[0])) invalid('参考图连线无效');
      const image=prompt[value[0]].inputs.image;
      if(!modelName(image) || /[\\/]/.test(String(image))) invalid('参考图必须使用上传后的文件名');
      imageBindings.push({nodeId:value[0],input:'image'});
    }
  } else invalid('仅支持文生视频与参考图生成');
  if (c.audio_mode !== 'native' || c.add_source_as_reference !== false || c.prompt_primary_audio_ordinal !== 0 || c.audio_denoise_strength !== 1 || typeof c.strict_prompt_tags !== 'boolean' || c.reference_video_policy !== 'official_2_to_15s') invalid('仅支持原生音频分支');
  if(entries.length !== 18 + imageIds.length + (classes.get('UniBlockSwap')?.length ?? 0)) invalid('包含非当前分支的节点');
  if (o.frame_rate !== 24 || o.loop_count !== 0 || o.format !== 'video/h264-mp4' || o.pix_fmt !== 'yuv420p' || o.save_output !== true || o.trim_to_audio !== false || o.pingpong !== false || typeof o.save_metadata !== 'boolean' || !numeric(o.crf, 0, 51, true) || !modelName(o.filename_prefix)) invalid('输出必须是本地保存的 H.264 MP4');
  if (typeof prompt[math].inputs.expression !== 'string' || (prompt[math].inputs.expression as string).replace(/\s/g,'') !== COMFY_H3_EXPRESSION.replace(/\s/g,'')) invalid('时长表达式不受支持');
  if (!COMFY_ASPECTS.includes(r.aspect_ratio as typeof COMFY_ASPECTS[number]) || !numeric(r.megapixels,0.1,2) || r.multiple !== 32) invalid('分辨率参数不受支持');
  if (!numeric(prompt[seconds].inputs.value,2,15) || !numeric(prompt[noise].inputs.noise_seed,0,Number.MAX_SAFE_INTEGER,true)) invalid('时长或种子无效');
  if (typeof prompt[text].inputs.value !== 'string') invalid('提示词无效');
  const rr = prompt[reserved].inputs;
  if (!numeric(rr.reserved,0,24) || rr.mode !== 'manual' || !numeric(rr.seed,0,Number.MAX_SAFE_INTEGER,true) || !numeric(rr.auto_max_reserved,0,24) || typeof rr.clean_gpu_before !== 'boolean') invalid('显存保留参数无效');
  const rates = prompt[rate].inputs;
  if (!numeric(rates.video_steps,COMFY_WORKFLOW_LIMITS.stepsMin,COMFY_WORKFLOW_LIMITS.stepsMax,true) || !numeric(rates.audio_steps,COMFY_WORKFLOW_LIMITS.stepsMin,COMFY_WORKFLOW_LIMITS.stepsMax,true) || !numeric(rates.shift_video,0,100) || !numeric(rates.shift_audio,0,100)) invalid('采样参数无效');
  if (!modelName(prompt[unet].inputs.unet_name) || prompt[unet].inputs.weight_dtype !== 'default' || !modelName(prompt[clip].inputs.clip_name) || prompt[clip].inputs.type !== 'minimax' || !['default','cpu'].includes(String(prompt[clip].inputs.device)) || vaes.some(id => !modelName(prompt[id].inputs.vae_name)) || !modelName(prompt[lora].inputs.lora_name) || !numeric(prompt[lora].inputs.strength_model,-10,10)) invalid('模型参数无效');
  const swaps = classes.get('UniBlockSwap') ?? [];
  if (swaps.length > 1 || swaps.some(id => prompt[id].inputs.num_blocks !== -1)) invalid('换块节点与原流程不一致');
  return { prompt, bindings: { images:imageBindings, conditioningNodeId:cond, modelNodeId:unet, prompt:{nodeId:text,input:'value'}, duration:{nodeId:seconds,input:'value'}, seed:{nodeId:noise,input:'noise_seed'}, aspect:{nodeId:resolution,input:'aspect_ratio'}, megapixels:{nodeId:resolution,input:'megapixels'}, videoSteps:{nodeId:rate,input:'video_steps'}, audioSteps:{nodeId:rate,input:'audio_steps'}, outputNodeId:output } };
}

/** Matches Python round (ties to even), used by ComfyUI v0.31.1 ResolutionSelector. */
function pythonRound(v: number): number { const lo = Math.floor(v), fraction = v-lo; return fraction === .5 ? (lo % 2 === 0 ? lo : lo+1) : Math.round(v); }
function summaryOf(prompt: ComfyApiPrompt, b: ComfyWorkflowBindings): ComfyWorkflowSummary {
  const aspect = String(prompt[b.aspect.nodeId].inputs[b.aspect.input]);
  const [w,h] = aspect.split(' ')[0].split(':').map(Number);
  const mp = Number(prompt[b.megapixels.nodeId].inputs[b.megapixels.input]);
  const scale = Math.sqrt(mp * 1024 * 1024 / (w*h));
  const requested = Math.max(5, pythonRound(Number(prompt[b.duration.nodeId].inputs[b.duration.input]) * 24));
  const frames = requested + ((5 - (requested % 17)) % 17 + 17) % 17;
  const values = Object.values(prompt), rate = values.find(n=>n.class_type==='MiniMaxH3MultiRateSamplerEXPT8')!;
  return { model:String(values.find(n=>n.class_type==='UNETLoader')!.inputs.unet_name), width:pythonRound(w*scale/32)*32, height:pythonRound(h*scale/32)*32, frames, fps:24, durationSeconds:frames/24, videoSteps:Number(rate.inputs.video_steps), audioSteps:Number(rate.inputs.audio_steps) };
}
export function parseComfyWorkflow(source: string | unknown, identity: {id:string;name:string}): ComfyWorkflow {
  if (!cleanString(identity.id,100) || !cleanString(identity.name,160)) fail('COMFY_WORKFLOW_NAME_INVALID','工作流名称无效');
  let input: unknown = source;
  let encoded: string;
  try { encoded = typeof source === 'string' ? source : JSON.stringify(source); } catch { return invalid('JSON 无效'); }
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).length > COMFY_WORKFLOW_LIMITS.bytes) fail('COMFY_WORKFLOW_TOO_LARGE','工作流文件过大，请只导出当前启用的文生音视频流程。');
  try { input = JSON.parse(encoded); } catch { return fail('COMFY_WORKFLOW_JSON_INVALID','无法读取 JSON，请重新导出 API 工作流。'); }
  if(isWorkFisherVideo(input)) {
    const {prompt,options}=readWorkFisherVideo(input);
    const bindings:ComfyWorkflowBindings={images:Array.from({length:options.referenceCount},(_,i)=>({nodeId:String(9000+i),input:'image'})),conditioningNodeId:'136',modelNodeId:'157',prompt:{nodeId:'138',input:'value'},duration:{nodeId:'132',input:'value'},seed:{nodeId:'129',input:'noise_seed'},aspect:{nodeId:'115',input:'aspect_ratio'},megapixels:{nodeId:'115',input:'megapixels'},videoSteps:{nodeId:'163',input:'value'},audioSteps:{nodeId:'163',input:'value'},outputNodeId:'156'};
    return {family:'work-fisher-video',mode:options.referenceCount===1?'single-image':'multi-image',version:1,id:identity.id,name:identity.name.trim(),prompt,bindings,summary:summarizeWorkFisherVideo(options)};
  }
  const {prompt,bindings} = inspectGraph(input);
  return {mode:bindings.images.length ? (bindings.images.length===1?'single-image':'multi-image'):'text',version:1,id:identity.id,name:identity.name.trim(),prompt,bindings,summary:summaryOf(prompt,bindings)};
}
export function getComfyWorkflowDefaults(workflow: ComfyWorkflow, mode: ComfyGenerationMode = workflow.mode): ComfyWorkflowDefaults {
  if(isWorkFisherVideo(workflow.prompt)) {
    const {options:o}=readWorkFisherVideo(workflow.prompt);
    return {refImageSize:o.refImageSize!,prompt:o.prompt,duration:o.duration!,seed:o.seed!,aspect:o.aspect!,megapixels:o.megapixels!,videoSteps:o.steps!,audioSteps:o.steps!};
  }
  const {prompt:p,bindings:b}=inspectGraph(workflow.prompt);
  return {refImageSize:mode===workflow.mode?p[b.conditioningNodeId].inputs.ref_image_size as 'max'|'match':mode==='multi-image'?'match':'max',prompt:String(p[b.prompt.nodeId].inputs[b.prompt.input]),duration:Number(p[b.duration.nodeId].inputs[b.duration.input]),seed:Number(p[b.seed.nodeId].inputs[b.seed.input]),aspect:String(p[b.aspect.nodeId].inputs[b.aspect.input]),megapixels:Number(p[b.megapixels.nodeId].inputs[b.megapixels.input]),videoSteps:Number(p[b.videoSteps.nodeId].inputs[b.videoSteps.input]),audioSteps:Number(p[b.audioSteps.nodeId].inputs[b.audioSteps.input])};
}
export function compileComfyWorkflow(workflow: ComfyWorkflow, edits: ComfyWorkflowEdits): {prompt:ComfyApiPrompt;summary:ComfyWorkflowSummary} {
  // Ignore legacy manual tabs for new submissions. Frozen accepted jobs bypass this compiler.
  const images=(edits.references ?? []).filter(r=>r.kind==='image');
  const mode=comfyModeForImageCount(images.length);
  if (edits.references?.some(r=>!['text','note','image'].includes(r.kind))) fail('COMFY_REFERENCE_UNSUPPORTED','当前工作流不支持视频或音频参考，请移除不支持的引用。');
  if(images.length > COMFY_MAX_REFERENCE_IMAGES) fail('COMFY_IMAGE_COUNT_INVALID',isWorkFisherVideo(workflow.prompt)?`当前画布最多传入 ${COMFY_MAX_REFERENCE_IMAGES} 张参考图；本机节点实际容量还需检查。`:`当前 T8 工作流最多支持 ${COMFY_MAX_REFERENCE_IMAGES} 张参考图，请移除多余图片后生成。`);
  if(images.some(r=>!r.mediaUrl?.trim())) fail('COMFY_IMAGE_MISSING','参考图尚无可用原图，请重新选择。');
  if (typeof edits.prompt !== 'string' || !edits.prompt.trim() || edits.prompt.length > COMFY_WORKFLOW_LIMITS.prompt || edits.prompt.includes('\0')) fail('COMFY_PROMPT_REQUIRED','请输入有效的视频提示词。');
  if (/<(?:填写主体、动作、场景和镜头|填写环境与动作声音|填写配乐，或 N\/A|Describe the subject, action, scene and camera|Describe ambient and action sounds|Describe music, or N\/A)>/.test(edits.prompt)) fail('COMFY_PROMPT_TEMPLATE_INCOMPLETE','请先填写提示词模板中的占位内容 / Complete the prompt template before generating.');
  if(isWorkFisherVideo(workflow.prompt)) {
    const {options:base}=readWorkFisherVideo(workflow.prompt);
    const options={...base,prompt:edits.prompt,referenceCount:images.length,...(edits.referenceModel!==undefined?{referenceModel:edits.referenceModel}:{}),...(edits.refImageSize!==undefined?{refImageSize:edits.refImageSize}:{}),...(edits.duration!==undefined?{duration:edits.duration}:{}),...(edits.seed!==undefined?{seed:edits.seed}:{}),...(edits.aspect!==undefined?{aspect:edits.aspect}:{}),...(edits.megapixels!==undefined?{megapixels:edits.megapixels}:{}),...(edits.videoSteps!==undefined?{steps:edits.videoSteps}:{}),...(edits.turbo!==undefined?{turbo:edits.turbo}:{}),...(edits.mystic!==undefined?{mystic:edits.mystic}:{}),...(edits.solAttention!==undefined?{solAttention:edits.solAttention}:{})};
    const loras={...base.loras,...edits.loras};
    for(const [id,flag] of [['151','turbo'],['288','mystic']] as const)loras[id]={...base.loras?.[id],...edits.loras?.[id],enabled:edits.loras?.[id]?.enabled??edits[flag]??base[flag]};
    return {prompt:buildWorkFisherVideo({...options,loras}),summary:summarizeWorkFisherVideo(options)};
  }
  const {prompt,bindings:b}=inspectGraph(workflow.prompt);
  // Build one output branch only; image node identifiers never come from reference data.
  for(const image of b.images) delete prompt[image.nodeId];
  const condition=prompt[b.conditioningNodeId].inputs;
  for(let i=0;i<COMFY_MAX_REFERENCE_IMAGES;i++) delete condition[`ref_images.ref_image_${i}`];
  condition.task_type='auto'; // T8 resolves 0 refs to T2VA and reference ports to Ref2VA.
  condition.ref_image_size=mode==='text'?'max':edits.refImageSize ?? (workflow.mode===mode ? condition.ref_image_size : mode==='single-image'?'max':'match');
  // Names are not a capability contract. Preserve the user's working model unless explicitly changed;
  // native preflight validates the actual compiled graph against this ComfyUI installation.
  if(edits.referenceModel!==undefined) prompt[b.modelNodeId].inputs.unet_name=edits.referenceModel;
  if(mode!=='text') {
    for(const [id,node] of Object.entries(prompt))if(node.class_type==='UniBlockSwap')delete prompt[id];
    let next=Math.max(...Object.keys(prompt).map(Number))+1;
    images.forEach((_image,index)=>{const id=String(next++);prompt[id]={class_type:'LoadImage',inputs:{image:`luckyray-ref-${index}.png`}};condition[`ref_images.ref_image_${index}`]=[id,0];});
    // Adding references changes conditioning only, never output size, duration or sampler steps.
  }
  prompt[b.prompt.nodeId].inputs[b.prompt.input]=edits.prompt;
  const editsByKey = [['duration',b.duration],['seed',b.seed],['aspect',b.aspect],['megapixels',b.megapixels],['videoSteps',b.videoSteps],['audioSteps',b.audioSteps]] as const;
  for(const [key,binding] of editsByKey) if(edits[key] !== undefined) prompt[binding.nodeId].inputs[binding.input]=edits[key]!;
  applyComfyLoras(prompt,edits.loras);
  const checked=inspectGraph(prompt);
  return {prompt:checked.prompt,summary:summaryOf(checked.prompt,checked.bindings)};
}
export function summarizeComfyWorkflow(workflow: ComfyWorkflow, edits?: Partial<ComfyWorkflowEdits>): ComfyWorkflowSummary {
  if(isWorkFisherVideo(workflow.prompt)) {
    const {options:base}=readWorkFisherVideo(workflow.prompt);
    return summarizeWorkFisherVideo({...base,prompt:edits?.prompt??base.prompt,duration:edits?.duration??base.duration,seed:edits?.seed??base.seed,aspect:edits?.aspect??base.aspect,megapixels:edits?.megapixels??base.megapixels,steps:edits?.videoSteps??base.steps});
  }
  const {prompt,bindings:b}=inspectGraph(workflow.prompt);
  const defaults=getComfyWorkflowDefaults(workflow,edits?.mode ?? workflow.mode);
  const values={...defaults,...edits};
  for(const [key,binding] of [['duration',b.duration],['seed',b.seed],['aspect',b.aspect],['megapixels',b.megapixels],['videoSteps',b.videoSteps],['audioSteps',b.audioSteps]] as const) prompt[binding.nodeId].inputs[binding.input]=values[key]!;
  inspectGraph(prompt);
  return summaryOf(prompt,b);
}
export type ComfyDependencyResult = {ready:boolean;missingNodes:string[];missingModels:{nodeId:string;input:string;name:string}[];unverifiedModels:string[]};
/** A read-only preflight, not proof that generation will fit available memory. */
export function checkComfyWorkflowDependencies(workflow: ComfyWorkflow, objectInfo: unknown): ComfyDependencyResult {
  if(isWorkFisherVideo(workflow.prompt)) fail('COMFY_PREFLIGHT_REQUIRED','请使用工作流卡片中的本机节点与模型检查，再提交生成。');
  const {prompt}=inspectGraph(workflow.prompt);
  if(!record(objectInfo)) fail('COMFY_DEPENDENCY_RESPONSE_INVALID','无法读取 ComfyUI 节点信息。');
  const result:ComfyDependencyResult={ready:false,missingNodes:[],missingModels:[],unverifiedModels:[]};
  const modelFields:Record<string,string>={UNETLoader:'unet_name',CLIPLoader:'clip_name',VAELoader:'vae_name',LoraLoaderModelOnly:'lora_name'};
  for(const [nodeId,node] of Object.entries(prompt)) {
    if(node.class_type==='UniBlockSwap')continue; // Disconnected, never part of the executed output.
    const info=objectInfo[node.class_type];
    if(!record(info)){if(!result.missingNodes.includes(node.class_type))result.missingNodes.push(node.class_type);continue;}
    const input=modelFields[node.class_type];if(!input)continue;
    const required=record(info.input)&&record(info.input.required)?info.input.required:null;
    const entry=required?.[input];const options=Array.isArray(entry)&&Array.isArray(entry[0])?entry[0]:null;
    const name=String(node.inputs[input]);
    if(!options)result.unverifiedModels.push(name);
    else if(!options.includes(name))result.missingModels.push({nodeId,input,name});
  }
  result.ready=!result.missingNodes.length&&!result.missingModels.length&&!result.unverifiedModels.length;
  return result;
}
