import { remapReferenceMentions } from './referenceMentions';
import { validShot } from './storyboard';

/** Duplicate planning inputs, never an execution, generated output, or adopted result. */
export function duplicateStoryboardData<T extends Record<string, unknown>>(
  data: T, order: number, edgeIds: ReadonlyMap<string, string>,
): T {
  if (!validShot(data.storyboardShot) || !Number.isSafeInteger(order) || order < 0) throw Error('invalid-shot');
  const copy: Record<string, unknown> = { ...data,
    storyboardShot: { ...data.storyboardShot, order, chosenResult: undefined },
    generationPrompt: remapReferenceMentions(typeof data.generationPrompt === 'string' ? data.generationPrompt : '', edgeIds),
    generationInputOrder: Array.isArray(data.generationInputOrder)
      ? data.generationInputOrder.map(key => typeof key === 'string' ? edgeIds.get(key) || key : key) : undefined,
    generationReferences: Array.isArray(data.generationReferences)
      ? data.generationReferences.map(ref => ({ ...ref })) : undefined,
    _newHighlight: false,
  };
  for (const key of ['generationTask', 'result', 'resultKind', 'resultMediaUrl', 'resultThumbnailUrl',
    'resultMediaItems', 'sourceGenerationTaskId', 'sourceGenerationHistoryId', 'sourceGenerationMediaUrl',
    'materialGenerationProvenance', 'canvasAgentOrigin', 'derivedFromNodeId', 'gridSlice', 'imageEdit']) delete copy[key];
  return copy as T;
}
