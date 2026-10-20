import type { CanvasAgentExecution, CanvasAgentExecutionOwner } from '../../core/canvas/agent/types';

type ResultNode = { id: string; position?: {x:number;y:number}; parentId?:string; hidden?:boolean };
export type CanvasAgentResultBounds = { x: number; y: number; width: number; height: number };
type NavigationState = {
  owner: CanvasAgentExecutionOwner | null;
  execution: CanvasAgentExecution | null;
  nodes: readonly ResultNode[];
};

export function canvasAgentExecutionOwnerMatches(
  execution: CanvasAgentExecution | null,
  owner: CanvasAgentExecutionOwner | null,
): boolean {
  return !!owner && !!execution?.owner && execution.owner.canvasId === owner.canvasId
    && execution.owner.loadEpoch === owner.loadEpoch;
}

function hasNavigablePosition(node:ResultNode, nodes:ReadonlyMap<string,ResultNode>):boolean {
  const seen=new Set<string>();
  let current:ResultNode|undefined=node;
  while(current){
    if(seen.has(current.id)||current.hidden||!Number.isFinite(current.position?.x)||!Number.isFinite(current.position?.y))return false;
    seen.add(current.id);
    if(!current.parentId)return true;
    current=nodes.get(current.parentId);
  }
  return false;
}

/** Only completed edits and created drafts, never planned IDs or unfinished media results. */
export function canvasAgentExecutionNodeIds(
  execution: CanvasAgentExecution | null,
  owner: CanvasAgentExecutionOwner | null,
  nodes: readonly ResultNode[],
): string[] {
  if (!canvasAgentExecutionOwnerMatches(execution, owner)) return [];
  const liveNodes = new Map(nodes.map(node => [node.id,node]));
  return [...new Set(execution!.steps.filter(step=>step.status==='draft'||step.status==='succeeded').map(step => step.nodeId).filter(id => {
    const node=liveNodes.get(id);
    return !!id&&!!node&&hasNavigablePosition(node,liveNodes);
  }))];
}

const validBounds=(bounds:CanvasAgentResultBounds)=>[bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)&&bounds.width>0&&bounds.height>0;

/** Synchronous, fail-closed navigation. Ports expose no content, history or runtime writes. */
export function navigateCanvasAgentExecution(
  execution: CanvasAgentExecution,
  nodeId: string | undefined,
  ports: {
    readCurrent: () => NavigationState;
    getBounds: (ids: string[]) => CanvasAgentResultBounds;
    apply: (target: { nodeIds: string[]; bounds: CanvasAgentResultBounds; selectAll: boolean }) => void;
  },
): boolean {
  const readIds = () => {
    const current = ports.readCurrent();
    if (current.execution !== execution) return [];
    const ids = canvasAgentExecutionNodeIds(execution, current.owner, current.nodes);
    return nodeId === undefined ? ids : ids.includes(nodeId) ? [nodeId] : [];
  };
  const candidates = readIds();
  if (!candidates.length) return false;
  // A missing measurement or malformed node must not spoil the other real results.
  const measured=candidates.flatMap(id=>{
    const bounds=ports.getBounds([id]);
    return validBounds(bounds)?[{id,bounds}]:[];
  });
  if(!measured.length)return false;
  const ids=measured.map(node=>node.id);
  const x=Math.min(...measured.map(node=>node.bounds.x)),y=Math.min(...measured.map(node=>node.bounds.y));
  const bounds={x,y,width:Math.max(...measured.map(node=>node.bounds.x+node.bounds.width))-x,height:Math.max(...measured.map(node=>node.bounds.y+node.bounds.height))-y};
  if(!validBounds(bounds))return false;
  // Recheck at the effect boundary, including deletion or reload while resolving bounds.
  const currentIds = readIds();
  if (currentIds.length !== candidates.length || candidates.some((id, index) => id !== currentIds[index])) return false;
  ports.apply({ nodeIds: ids, bounds, selectAll: nodeId === undefined });
  return true;
}
