import {useEffect, useMemo, useRef, useState} from "react";
import {parseComfyWorkflow, summarizeComfyWorkflow, type ComfyGenerationMode, getComfyWorkflowDefaults, COMFY_ASPECTS, COMFY_WORKFLOW_LIMITS, comfyModeForImageCount} from "../../core/canvas/comfyWorkflow";
import {buildWorkFisherVideo,readWorkFisherVideo,buildWorkFisherImage,readWorkFisherImage,isWorkFisherImagePreset,WORK_FISHER_VIDEO_NAME,type WorkFisherImagePreset} from "../../core/canvas/workFisherPreset";
import {canvasComfyUiClient, type CanvasComfyUiConfig} from "../../core/services/canvasComfyUi";
import type {ComfySeedMode} from '../../core/canvas/comfySeed';
import {applyComfyLoras, readComfyLoras, type ComfyLoraValues} from '../../core/canvas/comfyLora';
import {ComfyOptionRow, ComfyPopover, ComfyPopoverGroup} from './CanvasComfyPopover';
import {CanvasAspectGlyph, CanvasAspectOptions, COMFY_IMAGE_SIZES} from "./CanvasAspectOptions";
import "./canvasComfyUi.css";

export type CanvasComfyUiValues = {source?: "online" | "comfyui"; preset?: 'configured'|'work-fisher-video'|WorkFisherImagePreset; mode?: ComfyGenerationMode; referenceModel?: string; refImageSize?: "max" | "match"; duration?: number; seed?: number; seedMode?: ComfySeedMode; aspect?: string; megapixels?: number; width?:number; height?:number;sizePreset?:string;loras?:ComfyLoraValues;upscale?:boolean;upscaleResolution?:number;videoSteps?: number; audioSteps?: number; turbo?: boolean; mystic?: boolean; solAttention?: boolean};
export const comfyPresetMatchesResult=(preset:CanvasComfyUiValues['preset'],lockedKind?:'image'|'video')=>!lockedKind || (isWorkFisherImagePreset(preset)?'image':'video')===lockedKind;
const presetChoices=(english:boolean,lockedKind?:'image'|'video')=><><option disabled={!comfyPresetMatchesResult('configured',lockedKind)} value="configured">{english?'General H3':'通用 H3'}</option><option disabled={!comfyPresetMatchesResult('work-fisher-video',lockedKind)} value="work-fisher-video">{english?'Short drama · Video':'短剧 · 有声视频'}</option><option disabled={!comfyPresetMatchesResult('work-fisher-character',lockedKind)} value="work-fisher-character">{english?'Short drama · Character':'短剧 · 角色图'}</option><option disabled={!comfyPresetMatchesResult('work-fisher-scene',lockedKind)} value="work-fisher-scene">{english?'Short drama · Scene':'短剧 · 场景图'}</option><option disabled={!comfyPresetMatchesResult('work-fisher-three-view',lockedKind)} value="work-fisher-three-view">{english?'Short drama · Character views':'短剧 · 三视图'}</option></>;
const resetPreset=(preset:CanvasComfyUiValues['preset']):Partial<CanvasComfyUiValues>=>({preset,referenceModel:undefined,refImageSize:undefined,duration:undefined,seed:undefined,seedMode:'randomize',aspect:undefined,megapixels:undefined,width:undefined,height:undefined,sizePreset:undefined,loras:undefined,upscale:isWorkFisherImagePreset(preset),upscaleResolution:undefined,videoSteps:undefined,audioSteps:undefined,turbo:undefined,mystic:undefined,solAttention:undefined});
function AspectControl({value, disabled, english, onChange}: {value: string; disabled?: boolean; english: boolean; onChange: (aspect: string) => void}) {
  return <ComfyPopover label={english?'Aspect ratio':'画面比例'} summary={value.split(' ')[0]} disabled={disabled} english={english}>
    <div className="canvas-composer-setting"><CanvasAspectOptions options={COMFY_ASPECTS.map(aspect=>aspect.split(' ')[0])} value={value.split(' ')[0]} label={english?'Aspect ratio':'画面比例'} onChange={ratio=>onChange(COMFY_ASPECTS.find(aspect=>aspect.split(' ')[0]===ratio)!)} /></div>
  </ComfyPopover>;
}
function NumberField({label, value, min, max, step = 1, disabled, onChange, compact = false, accessibleLabel}: {label: string; accessibleLabel?: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (value: number) => void; compact?: boolean}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const number = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(number) && number >= min && number <= max && (step !== 1 || Number.isSafeInteger(number));
  return <label className={compact ? "canvas-comfy-chip canvas-comfy-number-chip" : "canvas-cinema-field"}><span>{label}</span><input type="number" aria-label={accessibleLabel || label} value={draft} min={min} max={max} step={step} disabled={disabled} aria-invalid={!valid} onChange={event => setDraft(event.target.value)} onBlur={() => {if (valid) onChange(number); else setDraft(String(value));}} onKeyDown={event => {if (event.key === "Enter" && !event.nativeEvent.isComposing) {event.preventDefault(); event.currentTarget.blur();}}}/></label>;
}

function SeedControl({seed, mode = 'randomize', disabled, english, onChange}: {seed: number; mode?: ComfySeedMode; disabled?: boolean; english: boolean; onChange: (patch: Partial<CanvasComfyUiValues>) => void}) {
  const copy = (zh: string, en: string) => english ? en : zh;
  return <div className="canvas-comfy-seed-control">
    <NumberField label={copy('种子', 'Seed')} value={seed} min={0} max={Number.MAX_SAFE_INTEGER} disabled={disabled} onChange={seed => onChange({seed})}/>
    <label className="canvas-cinema-field canvas-comfy-seed-mode"><span>{copy('生成后', 'After generation')}</span>
      <select aria-label={copy('生成后种子', 'Seed after generation')} title={copy('新任务按模式更新种子，重试沿用原种子。', 'New tasks follow the selected seed policy. Retries retain the original seed.')} value={mode} disabled={disabled} onChange={event => onChange({seedMode: event.target.value as ComfySeedMode})}>
        <option value="fixed">{copy('固定', 'Fixed')}</option><option value="randomize">{copy('随机', 'Randomize')}</option><option value="increment">{copy('递增', 'Increment')}</option><option value="decrement">{copy('递减', 'Decrement')}</option>
      </select>
    </label>
  </div>;
}

function ImageSizeControl({value,width,height,defaultWidth,defaultHeight,disabled,english,onChange}:{value:CanvasComfyUiValues;width:number;height:number;defaultWidth:number;defaultHeight:number;disabled?:boolean;english:boolean;onChange:(p:Partial<CanvasComfyUiValues>)=>void}) {
  const sizes=[['workflow',english?'Workflow default':'工作流默认',defaultWidth,defaultHeight] as const,...COMFY_IMAGE_SIZES];
  const selected=value.sizePreset==='custom'?'custom':sizes.find(([id,,w,h])=>id===value.sizePreset&&w===width&&h===height)?.[0]??sizes.find(([, ,w,h])=>w===width&&h===height)?.[0]??'custom';
  return <ComfyPopover label={english?'Image size':'图片尺寸'} summary={<><CanvasAspectGlyph value={`${width}:${height}`}/><span>{width} × {height}</span></>} disabled={disabled} className="canvas-comfy-size" english={english}>
    <div className="canvas-composer-setting"><div className="canvas-aspect-options canvas-comfy-size-grid">{sizes.map(([id,label,w,h])=><button type="button" key={id} aria-label={`${label} · ${w} × ${h}`} className={selected===id?'is-selected is-active':''} aria-pressed={selected===id} onClick={()=>onChange({sizePreset:id,width:w,height:h})}><CanvasAspectGlyph value={`${w}:${h}`}/><span>{label}</span></button>)}
      <button type="button" className={selected==='custom'?'is-selected is-active':''} aria-pressed={selected==='custom'} onClick={()=>onChange({sizePreset:'custom'})}><CanvasAspectGlyph value="auto"/><span>{english?'Custom':'自定义尺寸'}</span></button>
    </div></div>
    {selected==='custom'?<div className="canvas-comfy-step-fields"><NumberField label={english?'Width':'宽'} value={width} min={256} max={2048} step={8} disabled={disabled} onChange={width=>onChange({width})}/><NumberField label={english?'Height':'高'} value={height} min={256} max={2048} step={8} disabled={disabled} onChange={height=>onChange({height})}/></div>:null}
    <div className="canvas-comfy-size-readout"><span>{english?'Base size':'基础尺寸'}</span><strong>{width} × {height}</strong></div>
  </ComfyPopover>;
}
function LoraControls({defaults,value,installed,disabled,english,onChange,onRead,loading}:{defaults:ComfyLoraValues;value?:ComfyLoraValues;installed:string[];disabled?:boolean;english:boolean;onChange:(p:Partial<CanvasComfyUiValues>)=>void;onRead:()=>void;loading:boolean}) {
  if(!Object.keys(defaults).length)return null;
  const update=(id:string,patch:ComfyLoraValues[string])=>onChange({loras:{...value,[id]:{...defaults[id],...value?.[id],...patch}}});
  return <ComfyPopover label="LoRA" icon="lora" disabled={disabled} english={english}><div className="canvas-comfy-lora-list">
    {Object.entries(defaults).map(([id,base],index)=>{const selected={...base,...value?.[id]},enabled=selected.enabled!==false;
      return <div className="canvas-comfy-lora-row" key={id}>
        <label className="canvas-cinema-enable"><input type="checkbox" aria-label={`${english?'Enable':'启用'} LoRA ${index+1}`} checked={enabled} disabled={disabled} onChange={event=>update(id,{enabled:event.target.checked,...(event.target.checked&&selected.strength===0?{strength:base.strength||1}:{})})}/><span>LoRA {index+1}</span></label>
        <label className="canvas-cinema-field canvas-comfy-lora-model"><select aria-label={`${english?'LoRA model':'LoRA模型'} ${id}`} title={selected.name} value={selected.name} disabled={disabled||!enabled} onChange={event=>update(id,{name:event.target.value})}>{[...new Set([selected.name||'',...installed])].filter(Boolean).map(name=><option key={name} value={name}>{name.replace(/\.(safetensors|gguf)$/i,'')}</option>)}</select></label>
        <NumberField label={english?'Strength':'强度'} accessibleLabel={`${english?'LoRA strength':'LoRA强度'} ${id}`} value={selected.strength??1} min={-10} max={10} step={.05} disabled={disabled||!enabled} onChange={strength=>update(id,{strength})}/>
      </div>;})}
    <button type="button" className="canvas-cinema-reset canvas-comfy-check-button" disabled={disabled||loading} onClick={onRead}>{loading?(english?'Reading…':'读取中…'):(english?'Read installed LoRAs':'读取已安装 LoRA')}</button>
  </div></ComfyPopover>;
}

/** Local-only composer controls. Opening these never submits or tests a connection. */
export function CanvasComfyUiControls({config, value, onChange, disabled, onOpenSettings, imageCount = 0, english = false, workflowPinned = false, lockedKind, floating = false, owner, footer, onOpenOptions}: {config: CanvasComfyUiConfig | null; value: CanvasComfyUiValues; onChange: (patch: Partial<CanvasComfyUiValues>) => void; disabled?: boolean; onOpenSettings?: () => void; imageCount?: number; english?: boolean; workflowPinned?:boolean;lockedKind?:'image'|'video';floating?:boolean;owner?:string;footer?:HTMLElement|null;onOpenOptions?:()=>void}) {
  // Locale is supplied by the existing composer, not inferred from browser language.
  const copy = (zh: string, en: string) => english ? en : zh;
  const workflow = useMemo(() => {
    if(!workflowPinned && value.preset==='work-fisher-video') return parseComfyWorkflow(buildWorkFisherVideo({prompt:'',referenceCount:1}), {id:'work-fisher-video',name:WORK_FISHER_VIDEO_NAME});
    if (!config?.workflowJson) return null;
    try {return parseComfyWorkflow(config.workflowJson, {id: "configured", name: config.workflowName || "MiniMax-H3"});} catch {return null;}
  }, [config?.workflowJson, config?.workflowName, value.preset, workflowPinned]);
  const isWorkFisher=workflow?.family==='work-fisher-video';
  const workFisherDefaults=isWorkFisher?readWorkFisherVideo(workflow.prompt).options:null;
  const mode=comfyModeForImageCount(imageCount);
  const defaults = workflow ? getComfyWorkflowDefaults(workflow,mode) : null;
  const parameters = defaults ? {prompt: defaults.prompt || "Preview", duration: value.duration ?? defaults.duration, seed: value.seed ?? defaults.seed, aspect: value.aspect ?? defaults.aspect, megapixels: value.megapixels ?? defaults.megapixels, videoSteps: value.videoSteps ?? defaults.videoSteps, audioSteps: value.audioSteps ?? defaults.audioSteps} : null;
  const compiled = useMemo(() => {
    if (!workflow || !parameters) return null;
    try {return {summary:summarizeComfyWorkflow(workflow, {...parameters,mode})};} catch {return null;}
  }, [workflow, mode, parameters?.duration, parameters?.seed, parameters?.aspect, parameters?.megapixels, parameters?.videoSteps, parameters?.audioSteps]);
  const [installedModels,setInstalledModels]=useState<string[]>([]);
  const [installedLoras,setInstalledLoras]=useState<string[]>([]);
  const [modelsLoading,setModelsLoading]=useState(false);
  const [modelsError,setModelsError]=useState("");
  const modelEpoch=useRef(0);
  useEffect(()=>{modelEpoch.current++;setInstalledModels([]);setInstalledLoras([]);setModelsError("");setModelsLoading(false);return()=>{modelEpoch.current++;};},[config?.baseUrl,config?.workflowJson,value.preset,workflowPinned]);
  const readModels=async()=>{
    if(!config||!workflow||modelsLoading)return;
    const epoch=++modelEpoch.current;setModelsLoading(true);setModelsError("");
    try {
      const sample=workFisherDefaults?buildWorkFisherVideo({...workFisherDefaults,referenceCount:Math.max(1,imageCount),prompt:'预检',referenceModel:value.referenceModel??workFisherDefaults.referenceModel,turbo:value.turbo??workFisherDefaults.turbo,mystic:value.mystic??workFisherDefaults.mystic,solAttention:value.solAttention??workFisherDefaults.solAttention,loras:value.loras}):structuredClone(workflow.prompt);
      if(!workFisherDefaults)applyComfyLoras(sample,value.loras);
      const result=await canvasComfyUiClient.preflight(config.baseUrl,sample);if(epoch!==modelEpoch.current)return;setInstalledModels(result.installedUnetModels ?? []);setInstalledLoras(result.installedLoraModels??[]);
      if(workFisherDefaults){const issues=[...(result.missingClasses??[]),...(result.missingModels??[]),...(result.invalidInputs??[])];setModelsError(issues.length?copy(`本机依赖或输入尚未匹配：${issues.slice(0,8).join('、')}`,`Local dependencies or inputs need attention: ${issues.slice(0,8).join(', ')}`):copy('环境检查通过','Environment check passed'));}
      else if(!result.installedUnetModels?.length)setModelsError(copy("未读到已安装模型，请检查 ComfyUI 连接。","No installed models found. Check ComfyUI."));
    }
    catch {if(epoch===modelEpoch.current)setModelsError(copy("读取模型失败，请检查 ComfyUI 连接。","Could not read installed models. Check ComfyUI."));}
    finally {if(epoch===modelEpoch.current)setModelsLoading(false);}
  };
  const output = compiled
    ? `${compiled.summary.width} × ${compiled.summary.height} · ${compiled.summary.durationSeconds.toLocaleString(english ? "en-US" : "zh-CN", {maximumFractionDigits: 3, useGrouping: false})}${copy("秒", "s")} · ${compiled.summary.fps} fps`
    : copy("参数超出工作流支持范围", "Parameters are outside the workflow range");
  return <ComfyPopoverGroup key={`${config?.baseUrl}:${config?.workflowJson}:${value.preset}:${workflowPinned}`} owner={owner} floating={floating} onOpen={onOpenOptions}><div className="canvas-comfy-controls nodrag nopan nowheel"
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    >
    <div className="canvas-comfy-toolbar">
    <label className="canvas-comfy-preset canvas-cinema-field"><span className="canvas-comfy-sr-only">{copy("工作流","Workflow")}</span><select aria-label={copy("工作流预设","Workflow preset")} disabled={disabled||workflowPinned} value={isWorkFisher?'work-fisher-video':'configured'} onChange={event=>{const next=event.target.value as CanvasComfyUiValues['preset'];if(comfyPresetMatchesResult(next,lockedKind))onChange(resetPreset(next));}}>
      {presetChoices(english,lockedKind)}
    </select></label>

    {workflow && parameters ? <>
        <AspectControl value={parameters.aspect} disabled={disabled} english={english} onChange={aspect=>onChange({aspect})}/>
        <NumberField compact accessibleLabel={copy("时长（秒）", "Duration (seconds)")} label={copy("秒", "s")} value={parameters.duration} min={COMFY_WORKFLOW_LIMITS.durationMin} max={COMFY_WORKFLOW_LIMITS.durationMax} step={0.1} disabled={disabled} onChange={duration => onChange({duration})}/>
        <NumberField compact accessibleLabel={copy("画面像素量（MP）", "Megapixels (MP)")} label="MP" value={parameters.megapixels} min={COMFY_WORKFLOW_LIMITS.megapixelsMin} max={COMFY_WORKFLOW_LIMITS.megapixelsMax} step={0.1} disabled={disabled} onChange={megapixels => onChange({megapixels})}/>
    </> : null}</div>
    {workflow && parameters ? <>
      <div className="canvas-comfy-meta">
        <span className={compiled ? "canvas-comfy-output-readout" : "canvas-comfy-output-readout is-error"} title={copy("预计输出：", "Expected output: ") + output} aria-live="polite">{output}</span>
      </div>
      <ComfyOptionRow target={footer}><ComfyPopover label={copy("调整", "Adjust")} icon="adjust" disabled={disabled} english={english}>
        <div className="canvas-comfy-adjust-fields">
          {imageCount > 0 ? <label className="canvas-cinema-field"><span>{copy("参考图精度","Reference detail")}</span><select aria-label={copy("参考图精度","Reference detail")} disabled={disabled} value={value.refImageSize ?? defaults!.refImageSize} onChange={event=>onChange({refImageSize:event.target.value as 'max'|'match'})}>
            <option value="max">{copy("原图精度 · 更占内存","Original detail · More memory")}</option><option value="match">{copy("匹配画面","Match output")}</option>
          </select></label> : null}
          <SeedControl seed={parameters.seed} mode={value.seedMode} disabled={disabled} english={english} onChange={onChange}/>
          <div className="canvas-comfy-step-fields">
            <NumberField label={isWorkFisher?copy("采样步数","Sampling steps"):copy("视频步数", "Video steps")} value={parameters.videoSteps} min={1} max={100} disabled={disabled} onChange={videoSteps => onChange({videoSteps})}/>
            {!isWorkFisher?<NumberField label={copy("音频步数", "Audio steps")} value={parameters.audioSteps} min={1} max={100} disabled={disabled} onChange={audioSteps => onChange({audioSteps})}/>:null}
          </div>
          {workFisherDefaults?<div className="canvas-comfy-toggles"><label><input type="checkbox" disabled={disabled} checked={value.solAttention??workFisherDefaults.solAttention} onChange={event=>onChange({solAttention:event.target.checked})}/>{copy('注意力加速','Attention acceleration')}</label></div>:null}
          <button type="button" className="canvas-cinema-reset" disabled={disabled} onClick={() => onChange({duration: defaults!.duration, seed: defaults!.seed, seedMode: 'randomize',loras:undefined, aspect: defaults!.aspect, megapixels: defaults!.megapixels, videoSteps: defaults!.videoSteps, audioSteps: defaults!.audioSteps, refImageSize:defaults!.refImageSize,...(workFisherDefaults?{turbo:workFisherDefaults.turbo,mystic:workFisherDefaults.mystic,solAttention:workFisherDefaults.solAttention}:{})})}>{copy("恢复默认", "Reset")}</button>
        </div>
      </ComfyPopover>
      <LoraControls defaults={workFisherDefaults?{...workFisherDefaults.loras,'151':{...workFisherDefaults.loras?.['151'],enabled:value.turbo??workFisherDefaults.turbo},'288':{...workFisherDefaults.loras?.['288'],enabled:value.mystic??workFisherDefaults.mystic}}:readComfyLoras(workflow.prompt)} value={value.loras} installed={installedLoras} disabled={disabled} english={english} onChange={onChange} onRead={()=>void readModels()} loading={modelsLoading}/>
      <ComfyPopover label={copy("模型与连接", "Model & connection")} icon="connection" disabled={disabled} english={english}><div className="canvas-comfy-reference-settings">
          <label className="canvas-cinema-field"><span>{copy("模型","Model")}</span><select aria-label={copy("模型","Model")} disabled={disabled||modelsLoading} value={value.referenceModel || workflow.summary.model} onChange={event=>onChange({referenceModel:event.target.value})}>
            {[...new Set([value.referenceModel || workflow.summary.model,...installedModels])].map(name=><option key={name} value={name}>{name}</option>)}
          </select></label>
          <button type="button" className="canvas-cinema-reset" disabled={disabled||modelsLoading} onClick={()=>void readModels()}>{modelsLoading?copy("读取中…","Reading…"):isWorkFisher?copy("检查环境","Check environment"):copy("读取已安装模型","Read installed models")}</button>
          {modelsError?<small role="status">{modelsError}</small>:null}
          {onOpenSettings?<button type="button" className="canvas-cinema-reset" disabled={disabled} onClick={onOpenSettings}>{copy("连接设置", "Connection settings")}</button>:null}
        </div></ComfyPopover></ComfyOptionRow>
    </> : <div className="canvas-comfy-inline-empty"><p>{copy("先导入你的 MiniMax-H3 API 工作流。", "Import your MiniMax-H3 API workflow first.")}</p>{onOpenSettings ? <button type="button" className="canvas-cinema-reset" disabled={disabled} onClick={onOpenSettings}>{copy("打开连接设置", "Open connection settings")}</button> : null}</div>}
  </div></ComfyPopoverGroup>;
}

/** Image outputs use their own fixed ComfyUI graphs and the same task ledger. */
export function CanvasComfyUiImageControls({config,preset,value,onChange,disabled,imageCount,english,workflow,lockedKind,floating=false,owner,footer,onOpenOptions}:{config:CanvasComfyUiConfig|null;preset:WorkFisherImagePreset;value:CanvasComfyUiValues;onChange:(patch:Partial<CanvasComfyUiValues>)=>void;disabled?:boolean;imageCount:number;english:boolean;workflow?:Record<string,unknown>;lockedKind?:'image'|'video';floating?:boolean;owner?:string;footer?:HTMLElement|null;onOpenOptions?:()=>void}) {
  const copy=(zh:string,en:string)=>english?en:zh;
  const pinned=!!workflow, defaults=workflow?readWorkFisherImage(workflow).options:readWorkFisherImage(buildWorkFisherImage({preset,prompt:'',referenceCount:preset==='work-fisher-three-view'?1:0})).options;
  const three=preset==='work-fisher-three-view';
  const upscale=value.upscale??(pinned?defaults.upscale??false:true),upscaleResolution=value.upscaleResolution??defaults.upscaleResolution??2560;
  const [installedLoras,setInstalledLoras]=useState<string[]>([]);
  const [message,setMessage]=useState('');const [loading,setLoading]=useState(false);
  useEffect(()=>setMessage(''),[preset,config?.baseUrl,imageCount]);
  const check=async()=>{
    if(!config||loading)return;setLoading(true);setMessage('');
    try {
      const candidate=buildWorkFisherImage({...defaults,prompt:'预检',seed:value.seed??defaults.seed,width:value.width??defaults.width,height:value.height??defaults.height,aspect:value.aspect??defaults.aspect,megapixels:value.megapixels??defaults.megapixels,loras:value.loras??defaults.loras,upscale,upscaleResolution});
      const result=await canvasComfyUiClient.preflight(config.baseUrl,candidate),issues=[...(result.missingClasses??[]),...(result.missingModels??[]),...(result.invalidInputs??[])];
      setInstalledLoras(result.installedLoraModels??[]);
      setMessage(issues.length?copy(`本机依赖或输入尚未匹配：${issues.slice(0,8).join('、')}`,`Local dependencies or inputs need attention: ${issues.slice(0,8).join(', ')}`):copy('环境检查通过','Environment check passed'));
    } catch {setMessage(copy('读取本机节点失败，请检查 ComfyUI 连接。','Could not inspect local nodes. Check ComfyUI.'));} finally {setLoading(false);}
  };
  return <ComfyPopoverGroup key={`${preset}:${pinned}:${config?.baseUrl}`} owner={owner} floating={floating} onOpen={onOpenOptions}><div className="canvas-comfy-controls nodrag nopan nowheel" onPointerDown={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()}>
    <div className="canvas-comfy-toolbar"><label className="canvas-comfy-preset canvas-cinema-field"><span className="canvas-comfy-sr-only">{copy('工作流','Workflow')}</span><select aria-label={copy('工作流预设','Workflow preset')} disabled={disabled||pinned} value={preset} onChange={event=>{const next=event.target.value as CanvasComfyUiValues['preset'];if(comfyPresetMatchesResult(next,lockedKind))onChange(resetPreset(next));}}>{presetChoices(english,lockedKind)}</select></label>

    {three?<><AspectControl value={value.aspect??defaults.aspect!} disabled={disabled} english={english} onChange={aspect=>onChange({aspect})}/><NumberField compact label="MP" value={value.megapixels??defaults.megapixels!} min={.1} max={2} step={.1} disabled={disabled} onChange={megapixels=>onChange({megapixels})}/></>
      :<ImageSizeControl value={value} width={value.width??defaults.width!} height={value.height??defaults.height!} defaultWidth={defaults.width!} defaultHeight={defaults.height!} disabled={disabled} english={english} onChange={onChange}/>}</div>

    <ComfyOptionRow target={footer}><ComfyPopover label={copy('调整','Adjust')} icon="adjust" disabled={disabled} english={english}><div className="canvas-comfy-adjust-fields">
      <SeedControl seed={value.seed??defaults.seed!} mode={value.seedMode} disabled={disabled} english={english} onChange={onChange}/>
      <div className="canvas-comfy-upscale-options"><label className="canvas-cinema-enable"><input type="checkbox" aria-label={copy('SeedVR2 放大','SeedVR2 upscale')} checked={upscale} disabled={disabled} onChange={event=>onChange({upscale:event.target.checked})}/><span>{copy('SeedVR2 放大','SeedVR2 upscale')}</span></label><label className="canvas-cinema-field"><span>{copy('放大短边','Upscale short edge')}</span><select aria-label={copy('放大短边','Upscale short edge')} value={upscaleResolution} disabled={disabled||!upscale} onChange={event=>onChange({upscaleResolution:Number(event.target.value)})}>{[...new Set([1024,1536,2048,2560,4096,upscaleResolution])].sort((a,b)=>a-b).map(size=><option key={size} value={size}>{copy('短边','Short edge')} {size} px</option>)}</select></label></div>
    </div></ComfyPopover>
      <LoraControls defaults={defaults.loras??{}} value={value.loras} installed={installedLoras} disabled={disabled} english={english} onChange={onChange} onRead={()=>void check()} loading={loading}/>
      <ComfyPopover label={copy('模型与连接','Model & connection')} icon="connection" disabled={disabled} english={english}>
        <button className="canvas-cinema-reset canvas-comfy-check-button" type="button" disabled={disabled||loading||!config} onClick={()=>void check()}>{loading?copy('检查中…','Checking…'):copy('检查环境','Check environment')}</button>{message?<p role="status">{message}</p>:null}
      </ComfyPopover>
    </ComfyOptionRow>
  </div></ComfyPopoverGroup>;
}
