import type { CanvasGenerationHistoryEntry } from './generationHistory';

/** Local-only retrieval. Never search credentials, raw errors or signed URLs. */
export function matchesGenerationHistory(entry: Pick<CanvasGenerationHistoryEntry,'prompt'|'model'|'outputText'>, query: string): boolean {
  const terms=query.trim().slice(0,200).normalize('NFC').toLowerCase().split(/\s+/u).filter(Boolean);
  if(!terms.length)return true;
  const text=[entry.prompt,entry.model,entry.outputText||''].join('\n').normalize('NFC').toLowerCase();
  return terms.every(term=>text.includes(term));
}

export type PromptStarterKind='image'|'video';
export const PROMPT_STARTERS = [
 {id:'product',kind:'image',zh:'产品主图',en:'Product shot',
  promptZh:'突出产品主体，背景简洁，柔和棚拍光。保持参考产品的形状、颜色与标识，避免添加不存在的文字或配件。',
  promptEn:'Emphasize the product against a clean background with soft studio lighting. Preserve the reference product shape, colors and markings; do not invent text or accessories.'},
 {id:'poster',kind:'image',zh:'海报留白',en:'Poster composition',
  promptZh:'主体清晰、视觉层级明确，为后续排版预留干净留白区域。不要自动加入文字、水印或标志。',
  promptEn:'Use a clear subject and visual hierarchy, with clean negative space for later typesetting. Do not add text, watermarks or logos.'},
 {id:'preserve',kind:'image',zh:'局部调整约束',en:'Preserve unchanged areas',
  promptZh:'只调整我明确描述的部分；尽量保持参考图中其余主体、构图、比例和光照不变。',
  promptEn:'Change only the parts I explicitly describe. Preserve the other subjects, composition, proportions and lighting of the reference image as closely as possible.'},
 {id:'steady',kind:'video',zh:'稳定镜头',en:'Steady shot',
  promptZh:'使用稳定镜头和自然、克制的运动。保持主体外观一致，避免突然切镜、闪烁和形变。',
  promptEn:'Use a steady camera and natural, restrained motion. Keep the subject appearance consistent; avoid abrupt cuts, flicker and distortion.'},
 {id:'push',kind:'video',zh:'缓慢推进',en:'Slow push-in',
  promptZh:'镜头缓慢向主体推进，运动平滑，保持主体居中和场景连续。不要突然切换视角或添加新主体。',
  promptEn:'Slowly push the camera toward the subject with smooth movement and scene continuity. Do not abruptly change viewpoint or introduce new subjects.'},
] as const;

/** Appends editable guidance only. Never overwrites text, changes references,
 * submits a generation, or silently truncates the user's prompt. */
export type PromptStarterInsertion = { prompt:string; status:'inserted'|'already-present'|'too-long'|'unavailable' };
export function preparePromptStarter(prompt:string,id:string,kind:PromptStarterKind,english=false):PromptStarterInsertion {
 const starter=PROMPT_STARTERS.find(item=>item.id===id&&item.kind===kind);
 if(!starter)return {prompt,status:'unavailable'};
 const addition=english?starter.promptEn:starter.promptZh;
 if(prompt.includes(addition))return {prompt,status:'already-present'};
 const result=prompt+(prompt.trim()?'\n\n':'')+addition;
 return new TextEncoder().encode(result).length<=64*1024
  ? {prompt:result,status:'inserted'} : {prompt,status:'too-long'};
}
export function appendPromptStarter(prompt:string,id:string,kind:PromptStarterKind,english=false):string {
 return preparePromptStarter(prompt,id,kind,english).prompt;
}
