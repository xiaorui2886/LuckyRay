import { validateCreationOpen } from './creationContract';
import type { CreationOpenRequest } from './creationTypes';
import { isStoryboard } from '../storyboard';
import { getCanvasNodeContentKind } from '../nodeCapabilities';
import { creationRevision, type CreationState } from './creationEngine';
/** Resolve identifiers against the active graph, never accept file paths/URLs.
 * This prepares an explicit user handoff. It is NOT an export or pixel edit receipt. */
export function prepareCreationHandoff(state: CreationState, value: CreationOpenRequest) {
  const request = validateCreationOpen(value);
  if(request.expectedRevision!==creationRevision(state))throw Error('canvas-agent-context-stale');
  const selected = request.nodeIds || [];
  if (selected.some(id => !state.nodes.some(n => n.id === id))) throw Error('canvas-agent-context-stale');
  if (request.panel === 'imageTools') {
    if (selected.length !== 1) throw Error('canvas-agent-creation-select-image');
    const node = state.nodes.find(n => n.id === selected[0])!;
    if (getCanvasNodeContentKind(node.data) !== 'image' || !(node.data.resultMediaUrl || node.data.refMediaUrl)) throw Error('canvas-agent-creation-select-image');
  }
  if (request.panel === 'delivery' && (!selected.length || selected.some(id => {
    const n = state.nodes.find(n => n.id === id)!;
    return !['image','video'].includes(getCanvasNodeContentKind(n.data)) || !(n.data.resultMediaUrl || n.data.refMediaUrl);
  }))) throw Error('canvas-agent-creation-select-media');
  if (request.panel === 'templateExport' && !selected.length) throw Error('canvas-agent-creation-select-nodes');
  if (request.panel === 'storyboardExport' && !state.nodes.some(n => n.id === request.objectId && isStoryboard(n))) throw Error('canvas-agent-creation-missing-board');
  return { panel: request.panel === 'imageTools' ? 'editImage' as const : request.panel === 'delivery' ? 'export' as const : request.panel === 'storyboardExport' ? 'storyboard' as const : 'workflows' as const,
    selectedIds: [...selected], boardId: request.panel === 'storyboardExport' ? request.objectId : undefined,
    imageEdit: request.imageEdit, imageIndex: request.imageIndex, completion: 'awaiting-user' as const,
    summary: 'The requested creation panel is prepared for user review. No file was imported or exported and no image edit was saved. Await the user before continuing this operation.' };
}
