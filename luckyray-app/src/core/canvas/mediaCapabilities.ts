import twelveSpecs from "./twelveMediaSpecs.json" with {type:"json"};
import type { CanvasMediaProfile } from "../services/canvasMediaProfiles";

export type MediaCapabilities = {
  resolutions?: readonly string[]; aspects: readonly string[]; qualities: readonly string[]; durations: readonly number[];
  counts: readonly number[]; sound: boolean; camera: boolean; promptOnly: boolean;
};
type TwelveMediaSpec = {kind:string;family:string;aspects:string[];taskAspects?:string[];qualities:string[];durations?:number[];sound?:boolean;aliases?:string[];sizes?:Record<string,string>;resolutions?:string[];resolutionSizes?:Record<string,Record<string,string>>};
export function twelveModelSpec(model:string):TwelveMediaSpec|undefined {
 const table=twelveSpecs as Record<string,TwelveMediaSpec>;
 return table[model]||Object.values(table).find(spec=>spec.aliases?.includes(model));
}
export function isTwelveMediaHost(base:string):boolean {
 try{return ["new.12ai.org","cdn.12ai.org"].includes(new URL(base).hostname.toLowerCase());}catch{return false;}
}
/** Provider-scoped dispatch only. Model IDs are not rewritten, and other relays
 * keep their configured protocol even when they expose similarly named models. */
export function effectiveCanvasImageProtocol(base:string,model:string,configured:string|undefined):string|undefined {
 if(!isTwelveMediaHost(base)||!configured||!["openai-image","gemini-image"].includes(configured))return configured;
 const spec=twelveModelSpec(model);
 return spec?.kind==='image' ? spec.family==='gemini'?'gemini-image':spec.family==='gpt'?'openai-image':configured : configured;
}
/** Adapter capabilities, not a claim that an account owns a particular model. */
export function mediaCapabilities(kind: "image" | "video", profile?: CanvasMediaProfile | null, model = ""): MediaCapabilities {
  const protocol = kind === "image" ? effectiveCanvasImageProtocol(profile?.baseUrl||"",model,profile?.imageProtocol) : profile?.videoProtocol;
  const legacy = { aspects:["1:1","16:9","9:16","4:3"], qualities:kind === "video" ? ["480p","720p","1080p"] : ["标准","高清","超清"], durations:[5,10,15], counts:model.startsWith("agnes-image-") ? [1] : [1,2,4], sound:!model.startsWith("agnes-video-"), camera:kind === "video", promptOnly:false };
  if (!protocol || protocol === "agnes") {
    if(kind === "image" && ["agnes-image-2.1-flash","agnes-image-2.5-flash"].includes(model)) return {...legacy,aspects:["1:1","3:4","4:3","16:9","9:16","2:3","3:2","21:9"],qualities:["1K","2K","3K","4K"]};
    return legacy;
  }
  const spec = twelveModelSpec(model);
  const twelveHost=isTwelveMediaHost(profile?.baseUrl||"");
  if(spec?.kind===kind && (protocol==='12ai-task' || twelveHost && (protocol==='openai-image' && spec.family==='gpt' || protocol==='gemini-image' && spec.family==='gemini')))return {
    aspects:protocol==='12ai-task' && spec.taskAspects ? spec.taskAspects : spec.aspects,
    resolutions:spec.family==='gpt'?spec.resolutions:undefined, qualities:spec.qualities, durations:spec.durations||[], counts:kind==='image'&&spec.family==='gpt'&&protocol==='openai-image'?[1,2,3,4]:[1],
    sound:spec.sound===true,camera:false,promptOnly:false,
  };
  if (kind === "image" && protocol === "openai-image") return {
    ...legacy, aspects:model.includes("dall-e-2") ? ["1:1"] : ["1:1","3:2","2:3"],
    qualities:model.startsWith("gpt-image") ? ["low","medium","high"] : model.includes("dall-e-3") ? ["standard","hd"] : [],
    counts:model.includes("dall-e-3") ? [1] : [1,2,3,4], sound:false, camera:false,
  };
  if (kind === "image" && protocol === "gemini-image") return {
    ...legacy, aspects:["1:1","16:9","9:16","4:3","3:4"], qualities:model.includes("gemini-2.5") ? [] : ["1K","2K","4K"], counts:[1], sound:false, camera:false,
  };
  if (kind === "video" && protocol === "openai-video") return {
    ...legacy, aspects:["16:9","9:16"], qualities:["720p"], durations:[4,8,12], counts:[1], sound:false, camera:false,
  };
  if (kind === "video" && protocol === "12ai-task" && ["seedance-2.0","seedance-2.0-fast","seedance-2.5"].includes(model)) return {
    ...legacy, aspects:["16:9","9:16","1:1","4:3","3:4","21:9"], qualities:model === "seedance-2.0" ? ["720p"] : ["720p","480p"],
    durations:model === "seedance-2.5" ? [4,5,8,10,12,15,20,30] : [4,5,8,10,12,15], counts:[1], sound:true, camera:false,
  };
  // Unknown task models share only the documented prompt envelope. Do not pretend
  // their dimensions, sound, frames or durations share another model's contract.
  return { aspects:[], qualities:[], durations:[], counts:[1], sound:false, camera:false, promptOnly:true };
}

export function mediaOption<T extends string | number>(choices: readonly T[], value: T | undefined): T | undefined {
  return value !== undefined && choices.includes(value) ? value : choices[0];
}


export function mediaQualityOption(choices: readonly string[], value: string | undefined): string | undefined {
  const legacy = ({'标准':'1K','高清':'2K','超清':'4K'} as Record<string,string>)[value || ''];
  const quality = ({"标准":"low","高清":"high","超清":"high"} as Record<string,string>)[value || ""];
  const mapped = legacy && choices.includes(legacy) ? legacy : quality && choices.includes(quality) ? quality : value;
  return mediaOption(choices, mapped);
}
