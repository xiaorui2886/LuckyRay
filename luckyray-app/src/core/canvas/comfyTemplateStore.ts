import {readComfyTemplate,type ComfyTemplate} from './comfyTemplate';
const KEY='luckyray.canvas.comfy-templates.v1',EVENT='luckyray:comfy-templates';
export function loadComfyTemplates():ComfyTemplate[]{
  const raw=localStorage.getItem(KEY);if(!raw)return [];
  const data=JSON.parse(raw);if(!Array.isArray(data)||data.length>40)throw Error('模板列表无法读取，请保留原数据后重试。');
  return data.map(readComfyTemplate);
}
export function saveComfyTemplate(template:ComfyTemplate){
  const value=readComfyTemplate(template),items=loadComfyTemplates();
  // Imports always get a new ID in the manager; editing is explicit.
  const next=items.filter(t=>t.id!==value.id).concat(value);if(next.length>40)throw Error('最多保存 40 个工作流模板。');
  const raw=JSON.stringify(next);if(new TextEncoder().encode(raw).length>4*1024*1024)throw Error('模板列表超过本地容量，请先导出并移除不再使用的模板。');
  localStorage.setItem(KEY,raw);window.dispatchEvent(new Event(EVENT));
}
export function removeComfyTemplate(id:string){localStorage.setItem(KEY,JSON.stringify(loadComfyTemplates().filter(t=>t.id!==id)));window.dispatchEvent(new Event(EVENT));}
export function subscribeComfyTemplates(listener:()=>void){window.addEventListener(EVENT,listener);window.addEventListener('storage',listener);return()=>{window.removeEventListener(EVENT,listener);window.removeEventListener('storage',listener);};}
