import { normalizeGenerationEditorSnapshot } from "./generationEditorSnapshot";
import type { CanvasGenerationRequestSnapshot, CanvasGenerationReferenceSnapshot } from './generationTasks';
import { CANVAS_GENERATION_HISTORY_VERSION, type CanvasGenerationHistoryEntry } from './generationHistory';

/** Portable generation evidence only. Provider profiles, credentials and live tasks never cross this boundary. */
export type MaterialGenerationProvenance = {
  version: 1; historyId: string; taskId: string; createdAt: string; kind: 'image' | 'video';
  request: CanvasGenerationRequestSnapshot;
};
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Signed URLs are not portable references; omit rather than persist their credentials or alter their identity. */
function safeMedia(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || /^(blob|javascript|vbscript):/i.test(value)) return undefined;
  if (/^https?:/i.test(value)) {
    try { const url = new URL(value); if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|key|signature|credential|authorization|secret|^sig$|^auth$|^x-amz-|^x-goog-/i.test(key)) || /(?:token|key|signature|credential|authorization|secret|(?:^|[?&;])sig|(?:^|[?&;])auth)=/i.test(decodeURIComponent(url.hash.slice(1)))) return undefined; } catch { return undefined; }
  }
  return value;
}
export function normalizeMaterialGenerationProvenance(value: unknown): MaterialGenerationProvenance | undefined {
  const item = object(value), raw = object(item?.request);
  if (!item || item.version !== 1 || !raw || !['image', 'video'].includes(String(item.kind)) || raw.kind !== item.kind
    || typeof item.historyId !== 'string' || !item.historyId || typeof item.taskId !== 'string' || !item.taskId
    || typeof item.createdAt !== 'string' || typeof raw.prompt !== 'string' || typeof raw.model !== 'string' || !Array.isArray(raw.references)) return undefined;
  const request: CanvasGenerationRequestSnapshot = { kind: item.kind as 'image' | 'video', prompt: raw.prompt, model: raw.model, references: [] };
  for (const key of ['aspect', 'quality', 'resolution', 'sourcePrompt'] as const) if (typeof raw[key] === 'string') Object.assign(request, {[key]: raw[key]});
  for (const key of ['duration', 'count', 'cameraStrength'] as const) if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) request[key] = raw[key];
  if (typeof raw.sound === 'boolean') request.sound = raw.sound;
  for (const value of raw.references) {
    const ref = object(value); if (!ref || typeof ref.id !== 'string' || typeof ref.label !== 'string' || typeof ref.kind !== 'string' || !['firstFrame','lastFrame','reference','videoReference','promptContext','generic'].includes(String(ref.role))) continue;
    const reference: CanvasGenerationReferenceSnapshot = {id:ref.id,label:ref.label,kind:ref.kind,role:ref.role as CanvasGenerationReferenceSnapshot['role']};
    if (typeof ref.sourceNodeId === 'string') reference.sourceNodeId = ref.sourceNodeId;
    if (typeof ref.text === 'string') reference.text = ref.text;
    reference.mediaUrl = safeMedia(ref.mediaUrl); reference.thumbnailUrl = safeMedia(ref.thumbnailUrl);
    request.references.push(reference);
  }
  request.editor = request.references.length === raw.references.length ? normalizeGenerationEditorSnapshot(raw.editor, request.references.length) : undefined;
  return {version:1,historyId:item.historyId,taskId:item.taskId,createdAt:item.createdAt,kind:item.kind as 'image'|'video',request};
}
export function materialProvenanceFromHistory(entry: CanvasGenerationHistoryEntry): MaterialGenerationProvenance | undefined {
  if (entry.status !== 'succeeded') return undefined;
  return normalizeMaterialGenerationProvenance({version:1,historyId:entry.id,taskId:entry.taskId,createdAt:entry.createdAt,kind:entry.kind,request:entry.request});
}
export function materialProvenanceHistory(provenance: MaterialGenerationProvenance, nodeId: string, mediaUrl: string, thumbnailUrl?: string | null): CanvasGenerationHistoryEntry {
  const { request } = provenance;
  return {version:CANVAS_GENERATION_HISTORY_VERSION,id:`material:${nodeId}:${provenance.historyId}`,taskId:`material:${nodeId}:${provenance.taskId}`,parentTaskId:provenance.taskId,
    sourceNodeId:nodeId,resultNodeId:nodeId,kind:provenance.kind,status:'succeeded',request:structuredClone(request),attempt:1,prompt:request.prompt,model:request.model,
    aspect:request.aspect,quality:request.quality,resolution:request.resolution,duration:request.duration,createdAt:provenance.createdAt,updatedAt:provenance.createdAt,
    outputMediaUrl:mediaUrl,outputThumbnailUrl:thumbnailUrl||undefined,outputMediaItems:provenance.kind==='image'?[{url:mediaUrl,thumbnailUrl}]:undefined};
}
export type ProvenanceAssetIdentity = { id: string; originalPath?: string; libraryPath?: string | null; contentHash?: string | null };
export function materialProvenanceKey(libraryId: string, asset: ProvenanceAssetIdentity): string {
  return JSON.stringify([libraryId,asset.id,asset.contentHash ? '' : asset.libraryPath || asset.originalPath || '',asset.contentHash || '']);
}
