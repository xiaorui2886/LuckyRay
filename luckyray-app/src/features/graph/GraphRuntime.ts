import type { GraphRelationResult, GraphSeed, GraphSeedNode } from '../../core/services/graph';

export type GraphNodeAction = 'open' | 'createMissing' | 'openDefault' | 'reveal' | 'askAi';
export type GraphRuntimeFeature = 'read' | 'tagRelation' | 'bodyRelation' | 'screenshot' | GraphNodeAction;
export type GraphScreenshotResult = 'copied' | 'saved';
export type GraphRuntimeCapability = { available: true } | { available: false; reason: string };
export type GraphRuntimeCompleteness = { complete: boolean; missing: string[] };
export type GraphDataProof = { kind: 'graph'; snapshotId: string; revision: string; sourceId?: string };
export type GraphRuntimeContext = { nodeId: string; nodeType: string; label: string } | null;

/** All effects of a native graph must cross this boundary. Absence of a runtime
 * means the existing Main implementation; a supplied runtime never falls back. */
export interface GraphRuntime {
  readonly kind: 'scoped';
  /** Child CSP forbids workers; use the existing same-thread physics engine. */
  readonly allowWorker: false;
  readonly vaultId: string;
  readSeed(options?: { refresh?: boolean }): Promise<GraphSeed>;
  subscribe(listener: () => void): () => void;
  subscribeReadiness?(listener: () => void): () => void;
  capability(feature: GraphRuntimeFeature, node?: GraphSeedNode): GraphRuntimeCapability;
  completeness(): GraphRuntimeCompleteness;
  renderedRevision(): string | null;
  /** Loaded content proof; a supplied seed must be the currently cached object.
   * The host acknowledges this proof only after that scene has painted. */
  dataProof(seed?: GraphSeed): GraphDataProof | null;
  mutateRelation(kind: 'tag' | 'body', mode: 'connect' | 'disconnect', source: GraphSeedNode, target: GraphSeedNode): Promise<GraphRelationResult>;
  act(action: GraphNodeAction, node: GraphSeedNode): Promise<void>;
  /** Explicit child host service; never falls back to document downloads. */
  exportScreenshot?(image: Blob): Promise<GraphScreenshotResult>;
  flush?(): Promise<boolean>;
  setFrozen?(frozen: boolean): void;
  contextNodeKey(): string | null;
  publishContext(context: GraphRuntimeContext): void;
}

/** A loaded proof is authority only while the exact snapshot and every required
 * action route remain live. This does not itself establish canvas readiness. */
export function isCurrentGraphDataProof(runtime: GraphRuntime, proof: GraphDataProof | null, seed?: GraphSeed): proof is GraphDataProof {
  if (!proof || proof.kind !== 'graph' || !proof.snapshotId || !proof.revision) return false;
  const current = runtime.dataProof(seed);
  const completeness = runtime.completeness();
  return completeness.complete && completeness.missing.length === 0
    && current?.kind === 'graph' && current.snapshotId === proof.snapshotId
    && current.revision === proof.revision && current.sourceId === proof.sourceId && runtime.renderedRevision() === proof.revision
    // Body relations are deliberately unavailable for real-vault graphs in Main.
    // Every supported effect must have an explicit scoped route before ready.
    && typeof runtime.exportScreenshot === 'function'
    && (['read', 'tagRelation', 'screenshot', 'open', 'openDefault', 'reveal', 'askAi', 'createMissing'] as const)
      .every(feature => runtime.capability(feature).available);
}
