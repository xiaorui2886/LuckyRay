import type { GraphSeed } from '../core/services/graph';
import { isCurrentGraphDataProof, type GraphDataProof, type GraphRuntime } from '../features/graph/GraphRuntime';
import { sameGraphSessionSnapshot, validateGraphSessionSnapshot, type GraphSessionSnapshot } from '../features/graph/graphSessionStore';
import { assertGraphPlaybackScene } from '../features/graph/graphPlaybackSession';

/** Backend-issued captured source identity; generation belongs to the view lease. */
export type GraphViewIdentity = { viewId: string; vaultId: string; sourceId: string; generation: number };
export type GraphViewPresentation = {
  version: 1; kind: 'graph'; captureId: string; source: GraphViewIdentity;
  proof: GraphDataProof; state: GraphSessionSnapshot;
};
export type GraphViewApplyAck = {
  kind: 'graph'; captureId: string; source: GraphViewIdentity; target: GraphViewIdentity;
  sourceProof: GraphDataProof; proof: GraphDataProof; presentationHash?: string;
};
export type GraphViewPresentationPort = {
  scene: () => { seed: GraphSeed; proof: GraphDataProof } | null;
  capture: () => GraphSessionSnapshot;
  restore: (state: GraphSessionSnapshot) => void;
  flush: () => boolean | Promise<boolean>;
  freeze: (frozen: boolean) => void;
  requestPaint: () => void;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
export function validateGraphViewIdentity(value: unknown): value is GraphViewIdentity {
  return object(value) && only(value, ['viewId', 'vaultId', 'sourceId', 'generation']) && text(value.viewId, 128)
    && text(value.vaultId) && text(value.sourceId) && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0;
}
export function sameGraphViewIdentity(a: GraphViewIdentity, b: GraphViewIdentity) {
  return a.viewId === b.viewId && a.vaultId === b.vaultId && a.sourceId === b.sourceId && a.generation === b.generation;
}
const validProof = (value: unknown): value is GraphDataProof => object(value) && only(value, ['kind', 'snapshotId', 'revision', 'sourceId'])
  && value.kind === 'graph' && text(value.snapshotId) && text(value.revision) && (value.sourceId === undefined || text(value.sourceId));
export function validateGraphViewPresentation(value: unknown): value is GraphViewPresentation {
  return object(value) && only(value, ['version', 'kind', 'captureId', 'source', 'proof', 'state'])
    && value.version === 1 && value.kind === 'graph' && text(value.captureId)
    && validateGraphViewIdentity(value.source) && validProof(value.proof) && validateGraphSessionSnapshot(value.state);
}
export function assertGraphPresentationSceneState(state: GraphSessionSnapshot, seed: GraphSeed) {
  const keys = new Set(seed.nodes.map(node => node.key));
  if (state.positions.length !== keys.size || state.positions.some(node => !keys.has(node.key))
    || [state.focusedKey, state.relationSourceKey].some(key => key != null && !keys.has(key))
    || state.searchScope?.nodeKeys.some(key => !keys.has(key))) throw Error('workspace-graph-presentation-node-mismatch');
  if (state.playback) assertGraphPlaybackScene(state.playback, seed);
}

/** Presentation state is never source authority. A host must supply the original
 * source identity from its verified transfer, separately from the renderer blob.
 * The target ACK is emitted only for the exact seed after restoration and paint. */
export function createGraphViewPresentation(identity: GraphViewIdentity, runtime: GraphRuntime) {
  if (!validateGraphViewIdentity(identity) || identity.vaultId !== runtime.vaultId) throw Error('workspace-graph-presentation-scope-mismatch');
  const source = Object.freeze({ ...identity });
  let port: GraphViewPresentationPort | null = null;
  let disposed = false, frozen = false, sequence = 0, attachment = 0;
  let pending: { presentation: GraphViewPresentation; seed: GraphSeed; proof: GraphDataProof; attachment: number; presentationHash?: string;
    resolve: (ack: GraphViewApplyAck) => void; reject: (error: Error) => void } | null = null;
  const requirePort = () => { if (disposed || !port) throw Error('workspace-graph-view-unavailable'); return port; };
  const scene = () => {
    const value = requirePort().scene();
    if (!value || value.proof.sourceId !== source.sourceId || !isCurrentGraphDataProof(runtime, value.proof, value.seed)) throw Error('workspace-graph-presentation-not-ready');
    return value;
  };
  const rejectPending = (reason: string) => { const held = pending; pending = null; held?.reject(Error(reason)); };
  const setFrozen = (value: boolean) => { if (disposed) throw Error('workspace-graph-view-unavailable'); frozen = value; port?.freeze(value); };
  const controller = {
    identity: source,
    attach(next: GraphViewPresentationPort) {
      if (disposed || port) throw Error('workspace-graph-presentation-already-attached');
      port = next; attachment++; next.freeze(frozen);
      return () => { if (port !== next) return; rejectPending('workspace-graph-view-detached'); port = null; attachment++; };
    },
    async flush() {
      const current = requirePort(), generation = attachment;
      if (!await current.flush()) return false;
      if (disposed || port !== current || attachment !== generation) return false;
      scene(); return true;
    },
    capture(expectedProof: GraphDataProof): GraphViewPresentation {
      if (pending) throw Error('workspace-graph-presentation-applying');
      const current = scene();
      if (!validProof(expectedProof) || expectedProof.sourceId !== source.sourceId || expectedProof.snapshotId !== current.proof.snapshotId || expectedProof.revision !== current.proof.revision) throw Error('workspace-graph-presentation-proof-mismatch');
      const state = clone(requirePort().capture());
      if (!validateGraphSessionSnapshot(state)) throw Error('workspace-graph-presentation-invalid');
      assertGraphPresentationSceneState(state, current.seed);
      const checked = scene();
      if (checked.seed !== current.seed || checked.proof.snapshotId !== current.proof.snapshotId || checked.proof.revision !== current.proof.revision) throw Error('workspace-graph-presentation-source-changed');
      return { version: 1, kind: 'graph', captureId: `${source.viewId}:${source.generation}:${++sequence}`,
        source: { ...source }, proof: { ...current.proof }, state };
    },
    apply(value: unknown, expectedSource: GraphViewIdentity, presentationHash?: string): Promise<GraphViewApplyAck> {
      if (!validateGraphViewPresentation(value) || !validateGraphViewIdentity(expectedSource)
        || !sameGraphViewIdentity(value.source, expectedSource) || (presentationHash !== undefined && !text(presentationHash))
        || value.source.vaultId !== source.vaultId || value.source.sourceId !== source.sourceId) return Promise.reject(Error('workspace-graph-presentation-scope-mismatch'));
      let current: ReturnType<typeof scene>;
      try { current = scene(); assertGraphPresentationSceneState(value.state, current.seed); } catch (error) { return Promise.reject(error); }
      if (value.proof.sourceId !== source.sourceId || value.proof.revision !== current.proof.revision) return Promise.reject(Error('workspace-graph-presentation-revision-mismatch'));
      if (pending) return Promise.reject(Error('workspace-graph-presentation-busy'));
      const presentation = clone(value);
      setFrozen(true);
      try { requirePort().restore(clone(presentation.state)); } catch (error) { setFrozen(false); return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        pending = { presentation, seed: current.seed, proof: current.proof, attachment, presentationHash, resolve, reject };
        requirePort().requestPaint();
      });
    },
    painted(seed: GraphSeed, proof: GraphDataProof) {
      const held = pending;
      if (!held || disposed || !port || held.attachment !== attachment || held.seed !== seed
        || held.proof.snapshotId !== proof.snapshotId || held.proof.revision !== proof.revision
        || !isCurrentGraphDataProof(runtime, proof, seed)) return false;
      // Freeze prevents physics/input changes until the host accepts this ACK.
      const state = port.capture();
      if (!sameGraphSessionSnapshot(state, held.presentation.state)) { rejectPending('workspace-graph-presentation-apply-mismatch'); return false; }
      pending = null;
      held.resolve({ kind: 'graph', captureId: held.presentation.captureId, source: { ...held.presentation.source }, target: { ...source },
        sourceProof: { ...held.presentation.proof }, proof: { ...proof }, ...(held.presentationHash ? { presentationHash: held.presentationHash } : {}) });
      return true;
    },
    freeze() { setFrozen(true); },
    release() { rejectPending('workspace-graph-presentation-released'); setFrozen(false); },
    abort() { rejectPending('workspace-graph-presentation-aborted'); if (!disposed) setFrozen(false); },
    invalidate() { rejectPending('workspace-graph-presentation-invalidated'); },
    dispose() { rejectPending('workspace-graph-view-closed'); disposed = true; port = null; attachment++; },
    isFrozen: () => frozen,
  };
  return controller;
}
export type GraphViewPresentationController = ReturnType<typeof createGraphViewPresentation>;

/** Main holds explicit adapters by stable viewId. No current-tab/vault lookup. */
export function createGraphViewPresentationRegistry() {
  const views = new Map<string, GraphViewPresentationController>();
  const selected = (viewId: string) => { const view = views.get(viewId); if (!view) throw Error('workspace-graph-view-not-registered'); return view; };
  return {
    register(view: GraphViewPresentationController) { const id = view.identity.viewId; if (views.has(id)) throw Error('workspace-graph-view-already-registered'); views.set(id, view); return () => { if (views.get(id) === view) { view.abort(); views.delete(id); } }; },
    get: selected,
    flush: (viewId: string) => selected(viewId).flush(),
    capture: (viewId: string, expectedProof: GraphDataProof) => selected(viewId).capture(expectedProof),
    freeze: (viewId: string) => selected(viewId).freeze(),
    release: (viewId: string) => selected(viewId).release(),
    abort: (viewId: string) => selected(viewId).abort(),
  };
}
