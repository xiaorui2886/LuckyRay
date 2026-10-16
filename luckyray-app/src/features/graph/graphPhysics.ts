import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY, type Simulation, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force';

export type GraphPhysicsNode = SimulationNodeDatum & {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};

export type GraphPhysicsEdge = {
  sourceId: number;
  targetId: number;
};

export type GraphPhysicsInput = {
  nodes: GraphPhysicsNode[];
  edges: GraphPhysicsEdge[];
  activeNodeIds: ArrayLike<number> | null;
  draggedNodeId: number | null;
  width: number;
  height: number;
  alpha: number;
  repulsion: number;
  attraction: number;
  restLength: number;
  centerPull: number;
  collisionGap: number;
  damping: number;
  alphaDecay: number;
};

export type GraphPhysicsOutput = {
  nodes: GraphPhysicsNode[];
  alpha: number;
  workTime: number;
};

type Link = SimulationLinkDatum<GraphPhysicsNode>;
export type GraphPhysicsRuntime = {
  simulation: Simulation<GraphPhysicsNode, Link>;
  activeKey: string;
  edges: GraphPhysicsEdge[] | null;
  options: string;
};

export const GRAPH_PHYSICS_STATE_STRIDE = 4;

export type GraphPhysicsStepParameters = Omit<
  GraphPhysicsInput,
  "nodes" | "edges" | "activeNodeIds"
>;

export type GraphPhysicsTopologyPayload = {
  revision: number;
  nodeIds: Int32Array;
  radii: Float64Array;
  edgePairs: Int32Array;
};

export type GraphPhysicsStepRequest = {
  type: "step";
  requestId: number;
  generation: number;
  mutationRevision: number;
  topologyRevision: number;
  topology: GraphPhysicsTopologyPayload | null;
  state: Float64Array;
  activeNodeIds: Int32Array | null;
  parameters: GraphPhysicsStepParameters;
};

export type GraphPhysicsStepResponse = {
  type: "step-result";
  requestId: number;
  generation: number;
  mutationRevision: number;
  topologyRevision: number;
  state: Float64Array;
  alpha: number;
  workTime: number;
};

export function packGraphPhysicsState(
  nodes: ReadonlyArray<GraphPhysicsNode>,
  reusableState?: Float64Array | null,
) {
  const requiredLength = nodes.length * GRAPH_PHYSICS_STATE_STRIDE;
  const state = reusableState?.length === requiredLength
    ? reusableState
    : new Float64Array(requiredLength);
  for (let index = 0; index < nodes.length; index++) {
    const offset = index * GRAPH_PHYSICS_STATE_STRIDE;
    const node = nodes[index];
    state[offset] = node.x;
    state[offset + 1] = node.y;
    state[offset + 2] = node.vx;
    state[offset + 3] = node.vy;
  }
  return state;
}

export function updateGraphPhysicsState(
  nodes: ReadonlyArray<GraphPhysicsNode>,
  state: Float64Array,
) {
  if (state.length !== nodes.length * GRAPH_PHYSICS_STATE_STRIDE) {
    throw new Error("Invalid graph physics state buffer");
  }
  for (let index = 0; index < nodes.length; index++) {
    const offset = index * GRAPH_PHYSICS_STATE_STRIDE;
    const node = nodes[index];
    node.x = state[offset];
    node.y = state[offset + 1];
    node.vx = state[offset + 2];
    node.vy = state[offset + 3];
  }
}

export function unpackGraphPhysicsState(
  nodeIds: Int32Array,
  radii: Float64Array,
  state: Float64Array,
) {
  if (nodeIds.length !== radii.length || state.length !== nodeIds.length * GRAPH_PHYSICS_STATE_STRIDE) {
    throw new Error("Invalid graph physics state buffer");
  }
  const nodes: GraphPhysicsNode[] = new Array(nodeIds.length);
  for (let index = 0; index < nodeIds.length; index++) {
    const offset = index * GRAPH_PHYSICS_STATE_STRIDE;
    nodes[index] = {
      id: nodeIds[index],
      x: state[offset],
      y: state[offset + 1],
      vx: state[offset + 2],
      vy: state[offset + 3],
      r: radii[index],
    };
  }
  return nodes;
}

export function unpackGraphPhysicsEdges(edgePairs: Int32Array) {
  if (edgePairs.length % 2 !== 0) throw new Error("Invalid graph physics edge buffer");
  const edges: GraphPhysicsEdge[] = new Array(edgePairs.length / 2);
  for (let index = 0; index < edges.length; index++) {
    edges[index] = {
      sourceId: edgePairs[index * 2],
      targetId: edgePairs[index * 2 + 1],
    };
  }
  return edges;
}

/** Manual ticks only: the viewport/worker owns scheduling and can fully sleep. */
export function createGraphPhysicsRuntime(_nodes: ReadonlyArray<GraphPhysicsNode>): GraphPhysicsRuntime {
  return {simulation: forceSimulation<GraphPhysicsNode>([]).stop(), activeKey: '', edges: null, options: ''};
}

export function stepGraphPhysicsMutable(input: GraphPhysicsInput, runtime: GraphPhysicsRuntime): GraphPhysicsOutput {
  const startedAt = performance.now();
  for(const node of input.nodes){
    if(node.id===input.draggedNodeId) { node.fx=node.x; node.fy=node.y; }
    else { delete node.fx; delete node.fy; }
  }
  const activeIds = input.activeNodeIds ? new Set(Array.from(input.activeNodeIds)) : null;
  const nodes = activeIds ? input.nodes.filter(n => activeIds.has(n.id)) : input.nodes;
  const activeKey = nodes.map(n => n.id).join(',');
  const topologyChanged = runtime.activeKey !== activeKey || runtime.edges !== input.edges;
  const options = [input.repulsion,input.attraction,input.restLength,input.centerPull,input.collisionGap,input.width,input.height].join(',');
  const simulation = runtime.simulation;
  if (topologyChanged || runtime.options !== options) {
    // d3-force mutates link endpoints, so give it disposable adapter objects.
    const ids = new Set(nodes.map(n => n.id));
    const seen = new Set<string>();
    const links: Link[] = [];
    for (const edge of input.edges) {
      const a=edge.sourceId,b=edge.targetId,key=a<b ? a+':'+b : b+':'+a;
      if(a===b || !ids.has(a) || !ids.has(b) || seen.has(key)) continue;
      seen.add(key); links.push({source:a,target:b});
    }
    // D3 applies forces in insertion order. Replacing only link would move it
    // after collision/gravity on topology refresh and change the solver result.
    for (const name of ['charge', 'center', 'link', 'collide', 'x', 'y']) simulation.force(name, null);
    simulation.nodes(nodes);
    const link = forceLink<GraphPhysicsNode, Link>(links).id(n=>n.id).distance(input.restLength);
    const defaultStrength = link.strength();
    // Scale D3's own degree-balanced accessor; do not reproduce its force law.
    link.strength((edge,index,all)=>Math.min(1,defaultStrength(edge,index,all)*input.attraction));
    simulation
      .force('charge',forceManyBody<GraphPhysicsNode>().strength(-input.repulsion))
      .force('center',forceCenter<GraphPhysicsNode>(input.width/2,input.height/2).strength(.2))
      .force('link',link)
      .force('collide',forceCollide<GraphPhysicsNode>(n=>n.r+input.collisionGap/2).iterations(3))
      // Unlinked nodes have no spring equilibrium. Standard weak position
      // forces provide the existing "向心" control without a radial target.
      .force('x',forceX<GraphPhysicsNode>(input.width/2).strength(input.centerPull))
      .force('y',forceY<GraphPhysicsNode>(input.height/2).strength(input.centerPull));
    runtime.activeKey=activeKey; runtime.edges=input.edges; runtime.options=options;
  }
  simulation.alpha(input.alpha).alphaTarget(input.draggedNodeId===null ? 0 : .3)
    .alphaDecay(input.alphaDecay).velocityDecay(1-input.damping).tick();
  return {nodes:input.nodes,alpha:simulation.alpha(),workTime:performance.now()-startedAt};
}

export function stepGraphPhysics(input: GraphPhysicsInput): GraphPhysicsOutput {
  const nodes=input.nodes.map(node=>({...node}));
  return stepGraphPhysicsMutable({...input,nodes},createGraphPhysicsRuntime(nodes));
}
