/** Portable, declarative workflow bindings. No expressions or executable adapters. */
export type TemplateScalar = string | number | boolean;
export type TemplateGraph = Record<string,{class_type:string; inputs:Record<string,TemplateScalar | [string,number]>; _meta?:{title?:string}}>;
export type TemplateBinding = {nodeId:string; input:string};
export type TemplateParameter = TemplateBinding & {label:string};
export type ComfyTemplate = {
  format:'luckyray.comfy-template'; version:1; id:string; name:string;
  graph:TemplateGraph; prompt:TemplateBinding | null; images:string[];
  parameters:TemplateParameter[]; output:{nodeId:string; kind:'image'|'video'};
};
export type TemplateExecution = {format:'luckyray.comfy-execution'; version:1; graph:TemplateGraph; images:string[]; output:ComfyTemplate['output']};
export const TEMPLATE_MAX_BYTES=1024*1024;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const bad=(message:string):never=>{throw Error(message);};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-9]{1,12}$/.test(v);
const key=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160&&!/[\u0000-\u001f]/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const scalar=(v:unknown):v is TemplateScalar=>typeof v==='boolean'||typeof v==='string'&&v.length<=20000&&!v.includes('\0')||typeof v==='number'&&Number.isFinite(v);
const relative=(v:string)=>!!v&&!/^(?:[a-z]+:|[/\\])/i.test(v)&&!v.split(/[/\\]/).some(p=>p==='..'||p==='.')&&!/[\u0000-\u001f]/.test(v);
function checkPortableValue(field:string,value:TemplateScalar){
  if(typeof value!=='string'||!value)return;
  if(/api_key|password|secret|^token$|^authorization$/i.test(field)||/^(?:file:|\\\\|[a-z]:)/i.test(value))bad('模板包含凭据字段或本机绝对路径，请先在 ComfyUI 移除后重新导出。');
  if((field==='filename_prefix'||/(?:^|_)(?:model|ckpt|vae|clip|lora|unet)_name$/.test(field))&&!relative(value))bad('输出目录或模型名称必须是安全的相对名称。');
}
export const isTemplateExecution=(v:unknown):v is TemplateExecution=>object(v)&&v.format==='luckyray.comfy-execution';
export function readTemplateGraph(raw:unknown):TemplateGraph {
  if(typeof raw==='string'){if(new TextEncoder().encode(raw).length>TEMPLATE_MAX_BYTES)bad('工作流超过 1 MB。');try{raw=JSON.parse(raw);}catch{bad('无法读取工作流 JSON。');}}
  if(!object(raw)||Array.isArray(raw.nodes)||'links' in raw)bad('请选择 ComfyUI 导出的 API JSON，普通画布 JSON 暂不支持。');
  if(new TextEncoder().encode(JSON.stringify(raw)).length>TEMPLATE_MAX_BYTES)bad('工作流超过 1 MB。');
  const entries=Object.entries(raw as Record<string,unknown>);if(!entries.length||entries.length>512)bad('工作流节点数量无效。');
  const graph:TemplateGraph=Object.create(null);
  for(const [nodeId,node] of entries){
    if(!id(nodeId)||!object(node)||!key(node.class_type)||!object(node.inputs))bad('工作流节点格式无效。');
    const n=node as {class_type:string;inputs:Record<string,unknown>;_meta?:{title?:unknown}};
    const inputs:TemplateGraph[string]['inputs']=Object.create(null);
    for(const [field,value] of Object.entries(n.inputs)){
      if(!key(field))bad('工作流参数名称无效。');
      if(Array.isArray(value)){if(value.length!==2||!id(value[0])||!(value[0] in (raw as object))||!Number.isSafeInteger(value[1])||value[1]<0||value[1]>255)bad('工作流连线无效。');inputs[field]=[value[0],value[1]];}
      else if(scalar(value)){checkPortableValue(field,value);inputs[field]=value;}else bad('暂不支持复杂对象参数，请使用普通 API 输入。');
    }
    graph[nodeId]={class_type:n.class_type,inputs,...(typeof n._meta?.title==='string'?{_meta:{title:n._meta.title.slice(0,160)}}:{})};
  }
  // A valid API graph must be acyclic, including nodes not chosen as output.
  const visiting=new Set<string>(),done=new Set<string>();
  const visit=(n:string)=>{if(visiting.has(n))bad('工作流包含循环连线。');if(done.has(n))return;visiting.add(n);for(const v of Object.values(graph[n].inputs))if(Array.isArray(v))visit(v[0]);visiting.delete(n);done.add(n);};
  Object.keys(graph).forEach(visit);return graph;
}
export function templateBranch(graph:TemplateGraph,output:string):TemplateGraph {
  if(!graph[output])bad('请选择最终输出节点。');
  const branch:TemplateGraph=Object.create(null);
  const visit=(nodeId:string)=>{if(branch[nodeId])return;branch[nodeId]=structuredClone(graph[nodeId]);for(const value of Object.values(graph[nodeId].inputs))if(Array.isArray(value))visit(value[0]);};visit(output);return branch;
}
export function bindingKey(binding:TemplateBinding){return `${binding.nodeId}:${binding.input}`;}
export function templateFields(graph:TemplateGraph){return Object.entries(graph).flatMap(([nodeId,node])=>Object.entries(node.inputs).filter(([,value])=>scalar(value)).map(([input,value])=>({nodeId,input,value,label:`${node._meta?.title||node.class_type} · ${input} (${nodeId})` })));}
export function readComfyTemplate(raw:unknown):ComfyTemplate {
  if(typeof raw==='string'){if(new TextEncoder().encode(raw).length>TEMPLATE_MAX_BYTES)bad('模板超过 1 MB。');try{raw=JSON.parse(raw);}catch{bad('无法读取模板。');}}
  if(!object(raw)||raw.format!=='luckyray.comfy-template'||raw.version!==1||typeof raw.id!=='string'||!/^tpl-[a-zA-Z0-9-]{1,80}$/.test(raw.id)||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>80)bad('模板信息无效。');
  const t=raw as unknown as ComfyTemplate,graph=readTemplateGraph(t.graph);
  if(!object(t.output)||!id(t.output.nodeId)||!['image','video'].includes(t.output.kind))bad('请选择图片或视频输出。');
  const branch=templateBranch(graph,t.output.nodeId),output=branch[t.output.nodeId];
  if(t.output.kind==='image'&&output.class_type!=='SaveImage'||t.output.kind==='video'&&output.class_type!=='VHS_VideoCombine')bad('当前支持 SaveImage 图片和 VHS_VideoCombine MP4 输出。');
  if(t.output.kind==='video'&&(output.inputs.save_output!==true||!String(output.inputs.format).endsWith('-mp4')))bad('视频输出需要保存为 MP4。');
  const field=(b:TemplateBinding)=>{if(!object(b)||!id(b.nodeId)||!key(b.input)||!branch[b.nodeId]||!scalar(branch[b.nodeId].inputs[b.input]))bad('参数必须绑定当前输出分支中的普通字段。');return branch[b.nodeId].inputs[b.input] as TemplateScalar;};
  if(t.prompt!==null&&typeof field(t.prompt)!=='string')bad('提示词必须绑定文本字段。');
  if(!Array.isArray(t.images)||t.images.length>9||new Set(t.images).size!==t.images.length||t.images.some(n=>!id(n)||branch[n]?.class_type!=='LoadImage'))bad('参考图需要绑定不同的 LoadImage 节点，最多 9 张。');
  const loaders=Object.keys(branch).filter(n=>branch[n].class_type==='LoadImage');
  if(loaders.length!==t.images.length||loaders.some(n=>!t.images.includes(n)))bad('请绑定输出分支的全部参考图，避免使用作者电脑上的旧图片。');
  if(t.prompt&&t.images.includes(t.prompt.nodeId)&&t.prompt.input==='image')bad('提示词不能绑定参考图上传字段。');
  if(!Array.isArray(t.parameters)||t.parameters.length>24)bad('最多显示 24 个常用参数。');
  const used=new Set(t.prompt?[bindingKey(t.prompt)]:[]);
  for(const p of t.parameters){field(p);const k=bindingKey(p);if(typeof p.label!=='string'||!p.label.trim()||p.label.length>40||used.has(k)||t.images.includes(p.nodeId)&&p.input==='image')bad('参数名称无效或重复绑定。');used.add(k);}
  // Uploaded references replace these values. Do not carry the author's old filenames.
  t.images.forEach((nodeId,index)=>{branch[nodeId].inputs.image=`luckyray-ref-${index}.png`;});
  return {format:t.format,version:1,id:t.id,name:t.name.trim(),graph:branch,prompt:t.prompt?{...t.prompt}:null,images:[...t.images],parameters:t.parameters.map(p=>({...p})),output:{...t.output}};
}
export function compileComfyTemplate(template:ComfyTemplate,prompt:string,referenceCount:number,values:Record<string,TemplateScalar>={}):TemplateExecution {
  const t=readComfyTemplate(template),graph=structuredClone(t.graph);
  if(referenceCount!==t.images.length)bad(`这个模板需要 ${t.images.length} 张参考图，当前连接 ${referenceCount} 张。请调整连线或选择对应模板。`);
  if(t.prompt){if(!prompt.trim()||prompt.length>20000||prompt.includes('\0'))bad('请填写提示词。');checkPortableValue(t.prompt.input,prompt);graph[t.prompt.nodeId].inputs[t.prompt.input]=prompt;}
  for(const p of t.parameters){const v=values[bindingKey(p)];if(v===undefined)continue;const original=graph[p.nodeId].inputs[p.input];if(!scalar(v)||typeof v!==typeof original)bad(`参数「${p.label}」格式不正确。`);checkPortableValue(p.input,v);graph[p.nodeId].inputs[p.input]=v;}
  t.images.forEach((n,i)=>{graph[n].inputs.image=`luckyray-ref-${i}.png`;});
  return {format:'luckyray.comfy-execution',version:1,graph,images:t.images,output:t.output};
}
export function validateTemplateExecution(value:unknown):TemplateExecution {
  if(!isTemplateExecution(value)||value.version!==1)return bad('工作流模板执行快照无效。');
  const t=readComfyTemplate({format:'luckyray.comfy-template',version:1,id:'tpl-runtime',name:'运行快照',graph:value.graph,prompt:null,images:value.images,parameters:[],output:value.output});
  if(Object.keys(t.graph).length!==Object.keys(value.graph).length)bad('执行快照包含未选中的分支。');
  return value;
}
export function suggestComfyTemplate(raw:unknown,name:string):ComfyTemplate {
  const graph=readTemplateGraph(raw),outputs=Object.keys(graph).filter(n=>['SaveImage','VHS_VideoCombine'].includes(graph[n].class_type));
  const nodeId=outputs.length===1?outputs[0]:'';const branch=nodeId?templateBranch(graph,nodeId):graph;
  const prompts=templateFields(branch).filter(f=>typeof f.value==='string'&&/^(text|prompt)$/.test(f.input)&&!/negative/i.test(branch[f.nodeId]._meta?.title||''));
  return {format:'luckyray.comfy-template',version:1,id:`tpl-${crypto.randomUUID()}`,name:name.slice(0,80),graph,prompt:prompts.length===1?{nodeId:prompts[0].nodeId,input:prompts[0].input}:null,images:Object.keys(branch).filter(n=>branch[n].class_type==='LoadImage'),parameters:[],output:{nodeId,kind:graph[nodeId]?.class_type==='VHS_VideoCombine'?'video':'image'}};
}
