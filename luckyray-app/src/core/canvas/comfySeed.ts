import {isTemplateExecution} from './comfyTemplate';
import {getComfyWorkflowDefaults, parseComfyWorkflow} from './comfyWorkflow';
import {readWorkFisherImage, buildWorkFisherImage} from './workFisherPreset';

export const COMFY_SEED_MODES = ['fixed', 'randomize', 'increment', 'decrement'] as const;
export type ComfySeedMode = typeof COMFY_SEED_MODES[number];
export const isComfySeedMode = (value: unknown): value is ComfySeedMode => COMFY_SEED_MODES.includes(value as ComfySeedMode);

function randomSeed(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (words[0] & 0x1fffff) * 0x100000000 + words[1];
}

/** Update the next editable value after a NEW task is queued. The immutable
 * request keeps its submitted seed; retries/recovery must not call this. */
export function nextComfySeed(seed: number, mode: ComfySeedMode, random = randomSeed): number {
  if (!Number.isSafeInteger(seed) || seed < 0 || !isComfySeedMode(mode)) throw Error('种子或种子模式无效。');
  if (mode === 'increment') return seed === Number.MAX_SAFE_INTEGER ? 0 : seed + 1;
  if (mode === 'decrement') return seed === 0 ? Number.MAX_SAFE_INTEGER : seed - 1;
  if (mode === 'randomize') {
    const value = random();
    if (!Number.isSafeInteger(value) || value < 0) throw Error('随机种子无效。');
    return value;
  }
  return seed;
}

/** Read the actual compiled graph, including frozen history, not a guessed
 * default. Never mutates that graph or a task's request. */
export function comfySeedAfterQueued(kind: string, graph: Record<string, unknown>, mode: ComfySeedMode = 'randomize'): number | undefined {
  if (isTemplateExecution(graph) || mode === 'fixed') return undefined;
  const seed = kind === 'image' ? readWorkFisherImage(graph).options.seed
    : kind === 'video' ? getComfyWorkflowDefaults(parseComfyWorkflow(graph, {id: 'queued', name: 'Queued workflow'})).seed
    : undefined;
  return nextComfySeed(seed!, mode);
}

/** New random tasks get fresh entropy before the request is frozen, including
 * the first generation. Historical retry/resume never enters this function. */
export function comfySeedForNewTask(kind: string, graph: Record<string, unknown>, mode: ComfySeedMode = 'randomize'): Record<string, unknown> {
  if (isTemplateExecution(graph) || mode !== 'randomize') return graph;
  const seed=nextComfySeed(0,'randomize');
  if(kind==='image') return buildWorkFisherImage({...readWorkFisherImage(graph).options,seed});
  const workflow=parseComfyWorkflow(graph,{id:'seed',name:'Seed binding'}),copy=structuredClone(workflow.prompt),binding=workflow.bindings.seed;
  copy[binding.nodeId].inputs[binding.input]=seed;
  return copy;
}
