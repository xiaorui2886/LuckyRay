import type {ComfyApiPrompt} from './comfyWorkflow';

export type ComfyLoraValue = {enabled?: boolean; name?: string; strength?: number};
export type ComfyLoraValues = Record<string, ComfyLoraValue>;
const classes = ['LoraLoaderModelOnly', 'LoraLoaderBypassModelOnly'];
export const safeLoraName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\u0000-\u001f\u007f:\\?#]/.test(v) && !v.startsWith('/') && v.split('/').every(p => !!p && p !== '.' && p !== '..');
export function readComfyLoras(graph: ComfyApiPrompt): ComfyLoraValues {
  return Object.fromEntries(Object.entries(graph).filter(([,n]) => classes.includes(n.class_type)).map(([id,n]) => [id, {enabled:n.inputs.strength_model !== 0,name:String(n.inputs.lora_name),strength:Number(n.inputs.strength_model)}]));
}
/** Only existing, explicitly allowed model-only slots can be edited. A zero
 * strength is ComfyUI's built-in bypass; no alternate nodes or model guesses. */
export function applyComfyLoras(graph: ComfyApiPrompt, edits: ComfyLoraValues | undefined, slots = Object.keys(readComfyLoras(graph))): void {
  if (edits === undefined) return;
  if (!edits || typeof edits !== 'object' || Array.isArray(edits) || Object.keys(edits).some(id => !slots.includes(id))) throw Error('LoRA 选项无效。');
  for (const [id,value] of Object.entries(edits)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['enabled','name','strength'].includes(k))
      || (value.enabled !== undefined && typeof value.enabled !== 'boolean') || (value.name !== undefined && !safeLoraName(value.name))
      || (value.strength !== undefined && (!Number.isFinite(value.strength) || value.strength < -10 || value.strength > 10))) throw Error('LoRA 选项无效。');
    const node=graph[id];
    if (!node) {if (value.enabled === false) continue;throw Error('当前工作流没有这个 LoRA 槽位。');}
    if (!classes.includes(node.class_type)) throw Error('LoRA 槽位无效。');
    if (value.name !== undefined) node.inputs.lora_name=value.name;
    if (value.enabled === false) node.inputs.strength_model=0;
    else if (value.strength !== undefined) node.inputs.strength_model=value.strength;
  }
}
