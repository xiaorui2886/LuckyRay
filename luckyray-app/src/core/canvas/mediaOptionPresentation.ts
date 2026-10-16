import { effectiveCanvasImageProtocol, isTwelveMediaHost, twelveModelSpec } from './mediaCapabilities';
import type { MediaCapabilities } from './mediaCapabilities';
import type { CanvasMediaProfile } from '../services/canvasMediaProfiles';

/** UI semantics only: never convert a quality tier into a resolution or change wire values. */
export function mediaParameterKind(kind: 'image' | 'video', profile?: CanvasMediaProfile | null, model = ''): 'resolution' | 'quality' {
  if (kind === 'video') return 'resolution';
  const protocol = effectiveCanvasImageProtocol(profile?.baseUrl || '', model, profile?.imageProtocol);
  if ((!protocol && model.startsWith("agnes-image-")) || protocol === 'agnes' || protocol === 'gemini-image') return 'resolution';
  if (protocol === '12ai-task' && twelveModelSpec(model)?.family === 'gemini') return 'resolution';
  return 'quality';
}

export function mediaParameterLabel(value: string, parameter: 'resolution' | 'quality'): string {
  if (parameter === 'resolution') {
    // These are the exact existing Agnes native size mappings. Persisted values stay unchanged.
    return ({ '标准': '1K', '高清': '2K', '超清': '4K' } as Record<string,string>)[value] || value;
  }
  return ({low:'低',medium:'标准',high:'高',auto:'自动',xhigh:'更高',max:'最高',standard:'标准',hd:'高'} as Record<string,string>)[value] || value;
}

/** Pixel readout for existing fixed-size GPT/DALL-E request mappings, not a fabricated K selector. */
export function mediaPixelSize(kind: 'image' | 'video', profile: CanvasMediaProfile | null | undefined, model: string, aspect: string, resolution?:string): string | undefined {
  if (kind !== 'image') return undefined;
  const protocol = effectiveCanvasImageProtocol(profile?.baseUrl || '', model, profile?.imageProtocol);
  const spec = twelveModelSpec(model);
  if (spec?.family === 'gpt' && (protocol === '12ai-task' || isTwelveMediaHost(profile?.baseUrl || '') && protocol === 'openai-image')) {
    if (aspect === 'auto') return '自动';
    return (resolution ? spec.resolutionSizes?.[resolution]?.[aspect] : spec.sizes?.[aspect])?.replace('x',' × ');
  }
  if (protocol !== 'openai-image') return undefined;
  if (model.includes('dall-e-2')) return '1024 × 1024';
  const horizontal = model.includes('dall-e-3') ? '1792 × 1024' : '1536 × 1024';
  const vertical = model.includes('dall-e-3') ? '1024 × 1792' : '1024 × 1536';
  return ['3:2','16:9','4:3'].includes(aspect) ? horizontal : ['2:3','9:16','3:4'].includes(aspect) ? vertical : '1024 × 1024';
}

export function aspectFrame(value: string): {width:number;height:number;x:number;y:number;automatic:boolean} {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  const ratio = match ? Number(match[1])/Number(match[2]) : NaN;
  if (!Number.isFinite(ratio) || ratio <= 0) return {width:18,height:18,x:9,y:5,automatic:true};
  const width = ratio >= 1 ? Math.min(28,20*ratio) : 20*ratio;
  const height = width/ratio;
  return {width,height,x:(36-width)/2,y:(28-height)/2,automatic:false};
}

export function parameterOptions(capabilities: MediaCapabilities, kind: 'image'|'video', profile?:CanvasMediaProfile|null, model='') {
  const parameter = mediaParameterKind(kind,profile,model);
  return {parameter,options:capabilities.qualities.map(value=>({value,label:mediaParameterLabel(value,parameter)}))};
}
