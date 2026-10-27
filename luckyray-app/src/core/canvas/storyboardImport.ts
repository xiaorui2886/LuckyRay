import { defaultShot, storyboardShots, type StoryboardNode } from './storyboard';
/** Only the untouched initial draft is reused; any content, result or edge preserves it. */
export function reusableStoryboardDraft(nodes: readonly StoryboardNode[], edges: readonly {source:string;target:string}[], boardId: string): string | undefined {
  const shots=storyboardShots(nodes,boardId);
  if(shots.length!==1) return;
  const node=shots[0], shot=node.data.storyboardShot!, blank=defaultShot(0), data=node.data as StoryboardNode['data'] & {payload?:string;generationReferences?:unknown[];result?:string};
  if(data.kind!=='generator'||data.generationTask||data.generationPrompt?.trim()||data.payload||data.result||data.refMediaUrl||data.resultMediaUrl||data.resultThumbnailUrl||data.refThumbnailUrl||data.resultMediaItems?.length||data.generationReferences?.length||shot.chosenResult||shot.title.trim()||shot.description?.trim()||shot.lighting?.trim()||shot.sound?.trim()||shot.cameraMovement?.trim()||shot.action.trim()||shot.dialogue.trim()||shot.framing!==blank.framing||shot.durationSeconds!==blank.durationSeconds||edges.some(edge=>edge.source===node.id||edge.target===node.id))return;
  return node.id;
}
