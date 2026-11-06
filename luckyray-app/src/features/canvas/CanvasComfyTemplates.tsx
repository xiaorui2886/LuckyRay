import {useEffect,useRef,useState} from 'react';
import {bindingKey,compileComfyTemplate,readComfyTemplate,suggestComfyTemplate,templateBranch,templateFields,TEMPLATE_MAX_BYTES,type ComfyTemplate,type TemplateScalar} from '../../core/canvas/comfyTemplate';
import {loadComfyTemplates,removeComfyTemplate,saveComfyTemplate,subscribeComfyTemplates} from '../../core/canvas/comfyTemplateStore';
import {canvasComfyUiClient} from '../../core/services/canvasComfyUi';
import {CanvasAspectGlyph,COMFY_IMAGE_SIZES} from './CanvasAspectOptions';
import './canvasComfyTemplates.css';
export function useComfyTemplates(){
  const [items,setItems]=useState<ComfyTemplate[]>([]),[error,setError]=useState('');
  useEffect(()=>{const read=()=>{try{setItems(loadComfyTemplates());setError('');}catch{setError('模板列表读取失败，原数据未改动。');}};read();return subscribeComfyTemplates(read);},[]);return {items,error};
}
export function CanvasComfyTemplates({baseUrl}:{baseUrl?:string}){
  const {items,error}=useComfyTemplates(),[draft,setDraft]=useState<ComfyTemplate|null>(null),[message,setMessage]=useState(''),[trusted,setTrusted]=useState(false),[checking,setChecking]=useState(false),[deleting,setDeleting]=useState<string|null>(null);
  const input=useRef<HTMLInputElement>(null),epoch=useRef(0);
  useEffect(()=>()=>{epoch.current++;},[]);
  useEffect(()=>{epoch.current++;setTrusted(false);setChecking(false);if(draft)setMessage('');},[draft]);
  const adopt=(t:ComfyTemplate|null)=>{epoch.current++;setDraft(t);setTrusted(false);setMessage('');setChecking(false);};
  const importFile=async(file:File)=>{const generation=++epoch.current;try{if(file.size>TEMPLATE_MAX_BYTES)throw Error('文件超过 1 MB。');const raw=JSON.parse(await file.text());if(generation!==epoch.current)return;const t=raw?.format==='luckyray.comfy-template'?{...readComfyTemplate(raw),id:`tpl-${crypto.randomUUID()}`} :suggestComfyTemplate(raw,file.name.replace(/\.json$/i,''));adopt(t);}catch(e){if(generation===epoch.current)setMessage(e instanceof Error?e.message:'导入失败。');}};
  let branch=draft?.graph;try{if(draft?.output.nodeId)branch=templateBranch(draft.graph,draft.output.nodeId);}catch{ /* Incomplete choice remains editable. */ }
  const fields=branch?templateFields(branch):[];
  const exportTemplate=(t:ComfyTemplate)=>{const blob=new Blob([JSON.stringify(readComfyTemplate(t),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${t.name.replace(/[\\/:*?"<>|]/g,'-')}.luckyray.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const check=async()=>{if(!draft||!baseUrl||checking)return;const generation=++epoch.current;setChecking(true);try{const t=readComfyTemplate(draft),request=compileComfyTemplate(t,t.prompt?String(t.graph[t.prompt.nodeId].inputs[t.prompt.input])||'检查': '',t.images.length);const result=await canvasComfyUiClient.preflight(baseUrl,request);if(generation===epoch.current)setMessage(result.ready?'节点与参数检查通过，未生成；实际资源和节点副作用仍由本机环境决定。':`需要处理：${[...result.missingClasses,...result.missingModels,...(result.invalidInputs||[])].join('、')}`);}catch(e){if(generation===epoch.current)setMessage(e instanceof Error?e.message:'环境检查失败。');}finally{if(generation===epoch.current)setChecking(false);}};
  return <section className="canvas-template-library"><header><div><strong>我的工作流</strong><p>导入一次，在画布里重复使用。</p></div><button type="button" onClick={()=>input.current?.click()}>导入模板</button><input ref={input} hidden type="file" accept=".json,application/json" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void importFile(f);}}/></header>
    {error?<p role="alert">{error}</p>:null}
    {items.map(t=><article key={t.id}><div><strong>{t.name}</strong><small>{t.output.kind==='image'?'图片':'视频'} · {t.images.length?`${t.images.length} 张参考图`:'无需参考图'}</small></div><button type="button" onClick={()=>adopt(t)}>编辑</button><button type="button" onClick={()=>{try{exportTemplate(t);}catch(e){setMessage(String(e));}}}>导出</button><button type="button" onClick={()=>setDeleting(t.id)}>移除</button>{deleting===t.id?<span>已有画布不受影响。<button type="button" onClick={()=>{try{removeComfyTemplate(t.id);setDeleting(null);}catch{setMessage('移除失败，原数据保留。');}}}>确认移除</button><button type="button" onClick={()=>setDeleting(null)}>取消</button></span>:null}</article>)}
    {!draft&&!items.length?<p className="canvas-template-empty">支持 API JSON 与已配置的模板文件。原通用 H3 和短剧制作保持独立。</p>:null}
    {draft?<div className="canvas-template-editor"><header><strong>配置模板</strong><button type="button" onClick={()=>adopt(null)}>关闭</button></header>
      <label>名称<input value={draft.name} maxLength={80} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <label>最终结果<select value={draft.output.nodeId} onChange={e=>{const nodeId=e.target.value,g=templateBranch(draft.graph,nodeId);setDraft({...draft,output:{nodeId,kind:draft.graph[nodeId].class_type==='SaveImage'?'image':'video'},prompt:null,parameters:[],images:Object.keys(g).filter(n=>g[n].class_type==='LoadImage')});setMessage('');}}><option value="">选择输出</option>{Object.entries(draft.graph).filter(([,n])=>['SaveImage','VHS_VideoCombine'].includes(n.class_type)).map(([id,n])=><option key={id} value={id}>{n._meta?.title||n.class_type} ({id})</option>)}</select></label>
      <small>仅运行所选结果依赖的分支；图片取首张 PNG，视频取首个 MP4。参考图按固定输入数量连接；未知动态节点不会自动改线。</small>
      <label>提示词写入<select value={draft.prompt?bindingKey(draft.prompt):''} onChange={e=>{const f=fields.find(f=>bindingKey(f)===e.target.value);setDraft({...draft,prompt:f?{nodeId:f.nodeId,input:f.input}:null});}}><option value="">沿用工作流原文</option>{fields.filter(f=>typeof f.value==='string'&&f.input!=='image').map(f=><option key={bindingKey(f)} value={bindingKey(f)}>{f.label}</option>)}</select></label>
      {draft.images.length?<div><strong>参考图顺序</strong>{draft.images.map((id,i)=><div className="canvas-template-image-slot" key={id}><span>{i+1}. {draft.graph[id]._meta?.title||`图片 ${id}`}</span><button type="button" disabled={!i} aria-label={`上移参考图 ${i+1}`} onClick={()=>{const images=[...draft.images];[images[i-1],images[i]]=[images[i],images[i-1]];setDraft({...draft,images});}}>↑</button></div>)}</div>:null}
      <details><summary>选择常用参数</summary><p>只暴露你需要的设置，其余参数保持原值。</p>{fields.filter(f=>!draft.prompt||bindingKey(f)!==bindingKey(draft.prompt)).filter(f=>!(draft.images.includes(f.nodeId)&&f.input==='image')).map(f=>{const selected=draft.parameters.find(p=>bindingKey(p)===bindingKey(f));return <div className="canvas-template-parameter" key={bindingKey(f)}><label><input type="checkbox" checked={!!selected} onChange={e=>setDraft({...draft,parameters:e.target.checked?[...draft.parameters,{nodeId:f.nodeId,input:f.input,label:f.input.slice(0,40)}]:draft.parameters.filter(p=>bindingKey(p)!==bindingKey(f))})}/>{f.label}</label>{selected?<input aria-label={`${f.label} 显示名称`} value={selected.label} maxLength={40} onChange={e=>setDraft({...draft,parameters:draft.parameters.map(p=>p===selected?{...p,label:e.target.value}:p)})}/>:null}</div>;})}</details>
      <label className="canvas-template-trust"><input type="checkbox" checked={trusted} onChange={e=>setTrusted(e.target.checked)}/><span>我确认输入与输出映射，并信任这个工作流及其本机节点。节点可能访问文件、联网或消耗资源；导入不会自动生成。导出的模板包含提示词与参数，分享前请检查内容。</span></label>
      <footer><button type="button" disabled={!baseUrl||checking} onClick={()=>void check()}>{checking?'检查中…':'检查环境'}</button><button type="button" disabled={!trusted||checking} onClick={()=>{try{saveComfyTemplate(draft);adopt(null);setMessage('模板已保存，可在 ComfyUI 生成卡片中选择。');}catch(e){setMessage(e instanceof Error?e.message:'保存失败。');}}}>保存模板</button></footer>
    </div>:null}{message?<p role="status">{message}</p>:null}
  </section>;
}
export function CanvasTemplateParameters({template,values,onChange,disabled}:{template:ComfyTemplate;values:Record<string,TemplateScalar>;onChange:(values:Record<string,TemplateScalar>)=>void;disabled?:boolean}){
  const [customSize,setCustomSize]=useState(false);
  useEffect(()=>setCustomSize(false),[template.id]);
  // Only explicit, unique author bindings become a size pair; unknown fields stay scalar inputs.
  const widths=template.parameters.filter(p=>/^(width|宽|宽度)$/i.test(p.label.trim())||p.input==='width');
  const heights=template.parameters.filter(p=>/^(height|高|高度)$/i.test(p.label.trim())||p.input==='height');
  const widthField=widths.length===1?widths[0]:undefined,heightField=heights.length===1?heights[0]:undefined;
  const widthKey=widthField?bindingKey(widthField):'',heightKey=heightField?bindingKey(heightField):'';
  const defaultWidth=widthField?template.graph[widthField.nodeId].inputs[widthField.input]:undefined,defaultHeight=heightField?template.graph[heightField.nodeId].inputs[heightField.input]:undefined;
  const width=values[widthKey]??defaultWidth,height=values[heightKey]??defaultHeight;
  const hasSize=widthKey!==heightKey&&[width,height,defaultWidth,defaultHeight].every(v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0);
  const sizes=hasSize?[['workflow','工作流默认',defaultWidth as number,defaultHeight as number] as const,...COMFY_IMAGE_SIZES]:[];
  const sizePreset=customSize?'custom':sizes.find(([, ,w,h])=>w===width&&h===height)?.[0]??'custom';
  return <div className="canvas-template-values">
    {hasSize?<div className="canvas-template-size-options"><div className="canvas-comfy-size-readout"><span>图片尺寸</span><strong>{width} × {height}</strong></div>
      <div className="canvas-composer-setting"><div className="canvas-aspect-options canvas-comfy-size-grid" role="group" aria-label="图片尺寸">{sizes.map(([id,label,w,h])=><button type="button" key={id} disabled={disabled} aria-label={`${label} · ${w} × ${h}`} className={sizePreset===id?'is-selected is-active':''} aria-pressed={sizePreset===id} onClick={()=>{setCustomSize(false);onChange({...values,[widthKey]:w,[heightKey]:h});}}><CanvasAspectGlyph value={`${w}:${h}`}/><span>{label}</span></button>)}
        <button type="button" disabled={disabled} className={sizePreset==='custom'?'is-selected is-active':''} aria-pressed={sizePreset==='custom'} onClick={()=>setCustomSize(true)}><CanvasAspectGlyph value="auto"/><span>自定义尺寸</span></button>
      </div></div>
    </div>:null}
    {template.parameters.filter(p=>!hasSize||sizePreset==='custom'||![widthKey,heightKey].includes(bindingKey(p))).map(p=>{const k=bindingKey(p),v=values[k]??template.graph[p.nodeId].inputs[p.input] as TemplateScalar;return <label key={k} className={`canvas-cinema-field ${typeof v==='boolean'?'canvas-template-boolean':''}`}><span>{p.label}</span>{typeof v==='boolean'?<input type="checkbox" checked={v} disabled={disabled} onChange={e=>onChange({...values,[k]:e.target.checked})}/>:<TemplateValueInput value={v} disabled={disabled} onChange={next=>onChange({...values,[k]:next})}/>}</label>;})}
  </div>;
}

function TemplateValueInput({value,disabled,onChange}:{value:string|number;disabled?:boolean;onChange:(value:string|number)=>void}){
  const [draft,setDraft]=useState(String(value));useEffect(()=>setDraft(String(value)),[value]);
  return <input type={typeof value==='number'?'number':'text'} value={draft} disabled={disabled} onChange={e=>setDraft(e.target.value)} onBlur={()=>{if(typeof value==='string')onChange(draft);else if(draft.trim()&&Number.isFinite(Number(draft)))onChange(Number(draft));else setDraft(String(value));}} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing)e.currentTarget.blur();}}/>;
}
