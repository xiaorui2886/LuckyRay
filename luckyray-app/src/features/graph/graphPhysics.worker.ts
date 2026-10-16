/// <reference lib="webworker" />

import {
  createGraphPhysicsRuntime,
  packGraphPhysicsState,
  stepGraphPhysicsMutable,
  unpackGraphPhysicsEdges,
  unpackGraphPhysicsState,
  updateGraphPhysicsState,
  type GraphPhysicsEdge,
  type GraphPhysicsNode,
  type GraphPhysicsRuntime,
  type GraphPhysicsStepRequest,
  type GraphPhysicsStepResponse,
} from "./graphPhysics";

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
let topologyRevision = -1;
let topologyNodeIds = new Int32Array();
let topologyRadii = new Float64Array();
let topologyEdges: GraphPhysicsEdge[] = [];
let topologyNodes: GraphPhysicsNode[] = [];
let topologyRuntime: GraphPhysicsRuntime | null = null;

workerScope.onmessage = (event: MessageEvent<GraphPhysicsStepRequest>) => {
  const request = event.data;
  if (request.type !== "step") return;
  if (request.topology) {
    if (request.topology.revision !== request.topologyRevision) {
      throw new Error("Graph physics topology revision mismatch");
    }
    topologyRevision = request.topology.revision;
    topologyNodeIds = request.topology.nodeIds;
    topologyRadii = request.topology.radii;
    topologyEdges = unpackGraphPhysicsEdges(request.topology.edgePairs);
    topologyNodes = unpackGraphPhysicsState(topologyNodeIds, topologyRadii, request.state);
    topologyRuntime = createGraphPhysicsRuntime(topologyNodes);
  }
  if (topologyRevision !== request.topologyRevision || !topologyRuntime) {
    throw new Error("Graph physics topology is unavailable");
  }

  const startedAt = performance.now();
  if (!request.topology) updateGraphPhysicsState(topologyNodes, request.state);

  const output = stepGraphPhysicsMutable({
    ...request.parameters,
    nodes: topologyNodes,
    edges: topologyEdges,
    activeNodeIds: request.activeNodeIds,
  }, topologyRuntime);
  const state = packGraphPhysicsState(output.nodes, request.state);
  const response: GraphPhysicsStepResponse = {
    type: "step-result",
    requestId: request.requestId,
    generation: request.generation,
    mutationRevision: request.mutationRevision,
    topologyRevision,
    state,
    alpha: output.alpha,
    workTime: performance.now() - startedAt,
  };
  workerScope.postMessage(response, [state.buffer]);
};

export {};
