import type { GraphNodeAction, GraphRuntime, GraphScreenshotResult } from '../features/graph/GraphRuntime';
import type { GraphRelationResult } from '../core/services/graph';
import { createScopedGraphRuntime, type ScopedGraphGrant, type ScopedGraphRequest, type ScopedGraphSnapshot } from './scopedGraphRuntime';
import { createGraphCapabilityLease, type GraphCapabilitySnapshot } from './graphCapabilityLease';
import { validateGraphViewIdentity, type GraphViewIdentity } from './graphViewPresentation';

export type NativeGraphNodeRequest = Extract<ScopedGraphRequest, { op: 'graphNodeAction' }> & { sourceId: string };
export type NativeGraphScreenshotRequest = GraphViewIdentity & { snapshotId: string; revision: string; requestId: number; image: Blob };
export type NativeGraphRuntimeServices = {
  command: (request: Extract<ScopedGraphRequest, { op: 'graphRead' }>) => Promise<unknown>;
  /** Backend graphCapabilities: current mounted Main handler lease only. */
  capabilities?: () => Promise<GraphCapabilitySnapshot>;
  subscribe?: (viewId: string, invalidate: () => void) => () => void;
  mutateTag?: (request: Extract<ScopedGraphRequest, { op: 'graphMutateTag' }>) => Promise<GraphRelationResult>;
  /** Resolve only after Main's exact action receipt reports performed. */
  nodeAction?: (request: NativeGraphNodeRequest) => Promise<void>;
  exportScreenshot?: (request: NativeGraphScreenshotRequest) => Promise<GraphScreenshotResult>;
  actions?: readonly GraphNodeAction[];
  nodeActions?: Partial<Record<ScopedGraphGrant['kind'], readonly GraphNodeAction[]>>;
};
export type NativeGraphRuntime = GraphRuntime & {
  readonly identity: Readonly<GraphViewIdentity>;
  readonly viewId: string;
  refreshCapabilities: () => Promise<void>;
  subscribeReadiness: (listener: () => void) => () => void;
  dispose: () => void;
};
const sourceId = (value: unknown): value is string => typeof value === 'string' && /^graph-source-v1:[a-f0-9]{64}$/.test(value);
function snapshot(value: unknown, identity: GraphViewIdentity): ScopedGraphSnapshot {
  const dto = value as ScopedGraphSnapshot;
  if (!dto || dto.vaultId !== identity.vaultId || dto.sourceId !== identity.sourceId || !sourceId(dto.sourceId)
    || typeof dto.snapshotId !== 'string' || !dto.snapshotId || dto.snapshotId.length > 256
    || typeof dto.revision !== 'string' || !dto.revision || dto.revision.length > 256
    || !Number.isSafeInteger(dto.version) || dto.version < 0 || typeof dto.generatedAt !== 'string'
    || !Array.isArray(dto.documents) || dto.documents.length > 100_000 || !Array.isArray(dto.grants) || dto.grants.length > 100_000
    || !Array.isArray(dto.embeds) || dto.embeds.length > 100_000 || !dto.completeness || typeof dto.completeness.complete !== 'boolean'
    || !Array.isArray(dto.completeness.missing) || dto.completeness.missing.some(value => typeof value !== 'string')) throw Error('workspace-graph-native-scope-mismatch');
  return dto;
}
/** Native production uses captured backend DTOs and explicit Main services only. */
export function createNativeGraphRuntime(identity: GraphViewIdentity, services: NativeGraphRuntimeServices, initial?: ScopedGraphSnapshot): NativeGraphRuntime {
  if (!validateGraphViewIdentity(identity) || !sourceId(identity.sourceId)) throw Error('workspace-graph-native-scope-mismatch');
  const authority = Object.freeze({ ...identity });
  let active = true, epoch = 0, requestSequence = 0, first = initial ? snapshot(initial, authority) : null;
  const releases = new Set<() => void>();
  const check = (expected = epoch) => { if (!active || expected !== epoch) throw Error('workspace-graph-native-view-closed'); };
  const call = async <T>(operation: () => Promise<T>) => { check(); const current = epoch; const result = await operation(); check(current); return result; };
  const lease = createGraphCapabilityLease(() => services.capabilities ? call(services.capabilities) : Promise.resolve({ kinds: [], expiresInMs: 0 }));
  const actionAvailable = (action: GraphNodeAction) => !!services.nodeAction && (!services.actions || services.actions.includes(action)) && (
    action === 'open' ? lease.has('openDocument') && lease.has('openTag') && lease.has('openCatalogAsset') && lease.has('fileOperation')
      : action === 'createMissing' ? lease.has('createMissing') : action === 'askAi' ? lease.has('composeAi') : lease.has('fileOperation'));
  const allowed = (kind: ScopedGraphGrant['kind'], action: GraphNodeAction) => !services.nodeActions || !!services.nodeActions[kind]?.includes(action);
  const ticketActions = (kind: ScopedGraphGrant['kind']): GraphNodeAction[] => {
    if (!services.nodeAction) return [];
    const offered: GraphNodeAction[] = [];
    if (kind === 'missing-document') { if (lease.has('createMissing')) offered.push('createMissing'); }
    else {
      const openKind = kind === 'document' ? 'openDocument' : kind === 'tag' ? 'openTag' : kind === 'library-asset' ? 'openCatalogAsset' : 'fileOperation';
      if (lease.has(openKind)) offered.push('open');
      if (lease.has('composeAi')) offered.push('askAi');
      if (kind !== 'tag' && lease.has('fileOperation')) offered.push('openDefault', 'reveal');
    }
    return offered.filter(action => allowed(kind, action));
  };
  let runtime: GraphRuntime;
  const screenshot = services.exportScreenshot ? async (image: Blob) => {
    check(); const proof = runtime.dataProof();
    if (!lease.has('screenshot')) throw Error('workspace-graph-screenshot-route-unavailable');
    if (!proof || proof.sourceId !== authority.sourceId || image.type !== 'image/png' || image.size <= 0 || image.size > 32 * 1024 * 1024) throw Error('workspace-graph-native-screenshot-invalid');
    return call(() => services.exportScreenshot!({ ...authority, snapshotId: proof.snapshotId, revision: proof.revision, requestId: ++requestSequence, image }));
  } : undefined;
  runtime = createScopedGraphRuntime(authority.viewId, authority.vaultId, {
    get actions() { return Object.fromEntries((['open', 'createMissing', 'openDefault', 'reveal', 'askAi'] as const).filter(actionAvailable).map(action => [action, true])); },
    get nodeActions() { return Object.fromEntries((['document', 'tag', 'missing-document', 'library-asset', 'vault-asset'] as const).map(kind => [kind, ticketActions(kind)])); },
    request: async <T>(request: ScopedGraphRequest): Promise<T> => {
      check(); if (request.viewId !== authority.viewId) throw Error('workspace-graph-native-scope-mismatch');
      if (request.op === 'graphRead') {
        const held = !request.refresh ? first : null; first = null;
        return snapshot(held || await call(() => services.command(request)), authority) as T;
      }
      if (request.op !== 'graphNodeAction' || !services.nodeAction) throw Error('workspace-graph-native-action-unavailable');
      await call(() => services.nodeAction!({ ...request, sourceId: authority.sourceId, requestId: ++requestSequence })); return undefined as T;
    },
    mutateTag: services.mutateTag ? request => call(() => services.mutateTag!(request)) : undefined,
    get exportScreenshot() { return lease.has('screenshot') ? screenshot : undefined; },
    subscribe: services.subscribe ? (viewId, invalidate) => {
      check(); const release = services.subscribe!(viewId, () => { if (active) invalidate(); });
      releases.add(release); return () => { releases.delete(release); release(); };
    } : undefined,
  });
  const originalCompleteness = runtime.completeness;
  return Object.freeze({ ...runtime, identity: authority, viewId: authority.viewId,
    readSeed: async (options?: { refresh?: boolean }) => { check(); return runtime.readSeed(options); },
    refreshCapabilities: () => lease.refresh(),
    subscribeReadiness: (listener: () => void) => lease.subscribe(listener),
    completeness: () => active ? originalCompleteness() : { complete: false, missing: ['view-closed'] },
    dataProof: (seed?: Parameters<GraphRuntime['dataProof']>[0]) => active ? runtime.dataProof(seed) : null,
    dispose: () => { if (!active) return; active = false; epoch++; lease.dispose(); first = null; for (const release of releases) release(); releases.clear(); },
  });
}
export async function loadNativeGraphRuntime(viewId: string, vaultId: string, generation: number, services: NativeGraphRuntimeServices): Promise<NativeGraphRuntime> {
  const dto = await services.command({ op: 'graphRead', viewId, refresh: false }) as ScopedGraphSnapshot;
  const identity = { viewId, vaultId, generation, sourceId: dto?.sourceId || '' };
  const runtime = createNativeGraphRuntime(identity, services, snapshot(dto, identity));
  try { await runtime.refreshCapabilities(); return runtime; } catch (error) { runtime.dispose(); throw error; }
}
