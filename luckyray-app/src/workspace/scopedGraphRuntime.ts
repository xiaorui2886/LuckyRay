import {
  buildRealVaultGraphSeed, type GraphSeed, type GraphSeedNode,
  type GraphRelationResult, type RealVaultGraphEmbedResolution,
} from '../core/services/graph';
import { knowledgeDocumentNoteId, knowledgeTagIdentity } from '../core/services/knowledge';
import type { BridgeNotesVaultMarkdownIndexDocument, BridgeNotesVaultMarkdownIndex } from '../core/bridge/bridgeTypes';
import type { GraphNodeAction, GraphRuntime, GraphRuntimeFeature, GraphRuntimeCapability, GraphRuntimeContext, GraphScreenshotResult } from '../features/graph/GraphRuntime';

export type ScopedGraphDocument = Pick<BridgeNotesVaultMarkdownIndexDocument,
  'relativePath' | 'fileName' | 'title' | 'revision' | 'wikiLinks' | 'embeds' | 'frontmatterTags' | 'mtime'>;
export type ScopedGraphGrant =
  | { kind: 'document'; token: string; relativePath: string }
  | { kind: 'missing-document'; token: string; sourceRelativePath: string; relativePath: string; title: string }
  | { kind: 'tag'; token: string; tag: string }
  | { kind: 'library-asset'; token: string; assetId: string }
  | { kind: 'vault-asset'; token: string; relativePath: string };
export type ScopedGraphSnapshot = {
  snapshotId: string;
  /** Captured backend source incarnation, required by native production. */
  sourceId?: string;
  revision: string;
  vaultId: string;
  version: number;
  generatedAt: string;
  documents: ScopedGraphDocument[];
  embeds: Array<{ sourceRelativePath: string; resolutions: RealVaultGraphEmbedResolution[] }>;
  grants: ScopedGraphGrant[];
  completeness: { complete: boolean; missing: string[] };
};
export type ScopedGraphRequest =
  | { op: 'graphRead'; viewId: string; refresh: boolean }
  | { op: 'graphMutateTag'; viewId: string; snapshotId: string; sourceToken: string; targetToken: string; mode: 'connect' | 'disconnect' }
  | { op: 'graphNodeAction'; viewId: string; snapshotId: string; nodeToken: string; action: GraphNodeAction; requestId:number };
export type ScopedGraphTransport = {
  request<T>(request: ScopedGraphRequest): Promise<T>;
  subscribe?(viewId: string, listener: () => void): () => void;
  /** Explicit scoped services, independent of read/node-navigation transport. */
  mutateTag?(request: Extract<ScopedGraphRequest, { op: 'graphMutateTag' }>): Promise<GraphRelationResult>;
  exportScreenshot?(image: Blob): Promise<GraphScreenshotResult>;
  /** Advertised only after the parent has installed a verified ticket consumer. */
  actions: Partial<Record<GraphNodeAction, true>>;
  /** Exact consumers installed by the parent for each ticket class. */
  nodeActions?: Partial<Record<ScopedGraphGrant['kind'], readonly GraphNodeAction[]>>;
};

const MISSING_ROUTE = 'This action needs a verified parent route for this graph.';
function grantKey(vaultId: string, grant: ScopedGraphGrant): string {
  switch (grant.kind) {
    case 'document': return `note:${knowledgeDocumentNoteId({ vaultId, relativePath: grant.relativePath })}`;
    case 'missing-document': return `note:missing-real-vault:${encodeURIComponent(grant.sourceRelativePath.toLocaleLowerCase())}:${encodeURIComponent(grant.relativePath.toLocaleLowerCase())}`;
    case 'tag': return `tag:${knowledgeTagIdentity(vaultId, grant.tag)}`;
    case 'library-asset': return `material:${grant.assetId}`;
    case 'vault-asset': return `material:real-vault-asset:${grant.relativePath}`;
  }
}

/** Uses the exact production topology builder. Empty private/absolute fields are
 * adapter placeholders, never authority or substitute content. */
export function buildScopedGraphSeed(snapshot: ScopedGraphSnapshot): GraphSeed {
  if (!snapshot.completeness.complete || snapshot.completeness.missing.length) throw new Error(`workspace-graph-incomplete:${snapshot.completeness.missing.join(',')}`);
  const index: BridgeNotesVaultMarkdownIndex = {
    vaultId: snapshot.vaultId, rootPath: '', generatedAt: snapshot.generatedAt,
    version: snapshot.version, changedPaths: [], removedPaths: [], errors: [],
    documents: snapshot.documents.map(document => ({ ...document,
      absolutePath: '', headings: [], tags: document.frontmatterTags, inlineTags: [],
      plainText: '', excerpt: '', contentLength: 0, size: 0,
    })),
  };
  return buildRealVaultGraphSeed(index, new Map(snapshot.embeds.map(entry => [entry.sourceRelativePath, entry.resolutions])));
}

/** A private instance per retained content session. No bridge/current-vault,
 * material store, global context, filesystem or SQL fallback is permitted. */
export function createScopedGraphRuntime(viewId: string, vaultId: string, transport: ScopedGraphTransport): GraphRuntime {
  let snapshot: ScopedGraphSnapshot | null = null;
  let grants = new Map<string, string>();
  let grantKinds = new Map<string, ScopedGraphGrant['kind']>();
  let frozen = false;
  const operations = new Set<Promise<unknown>>();
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    if (frozen) throw Error('workspace-graph-view-frozen');
    const operation = work(); operations.add(operation);
    try { return await operation; } finally { operations.delete(operation); }
  };
  let nodes = new Map<string, GraphSeedNode>();
  let context: GraphRuntimeContext = null;
  let sequence = 0;
  let actionSequence = 0;
  let pending: Promise<GraphSeed> | null = null;
  let cached: GraphSeed | null = null;
  const listeners = new Set<() => void>();
  const invalidate = () => { sequence++; pending = null; cached = null; for (const listener of listeners) listener(); };
  const requireNode = (node: GraphSeedNode) => {
    const held = nodes.get(node.key);
    const token = grants.get(node.key);
    if (!cached || !snapshot || !held || !token || held.id !== node.id || held.type !== node.type || held.entityId !== node.entityId) {
      throw new Error('workspace-graph-node-not-granted');
    }
    return { snapshotId: snapshot.snapshotId, token };
  };
  const capability = (feature: GraphRuntimeFeature, node?: GraphSeedNode): GraphRuntimeCapability => {
    if (feature === 'read') return snapshot && !snapshot.completeness.complete
      ? { available: false, reason: snapshot.completeness.missing.join(', ') } : { available: true };
    if (feature === 'bodyRelation') return { available: false, reason: 'Edit real-vault body links in the document, as in Main.' };
    if (feature === 'screenshot') return typeof transport.exportScreenshot === 'function'
      ? { available: true } : { available: false, reason: 'Screenshot export needs a verified child host service.' };
    if (feature === 'tagRelation' && typeof transport.mutateTag !== 'function') return { available: false, reason: 'Tag editing needs a verified scoped mutation service.' };
    if (feature === 'tagRelation') return !node || (cached && grants.has(node.key) && (node.type === 'note' || node.type === 'tag'))
      ? { available: true } : { available: false, reason: 'Only granted document/tag pairs can be changed.' };
    if (feature === 'createMissing' && node && (node.status !== 'missing' || !grants.has(node.key))) return { available: false, reason: 'Missing-note creation requires a separate validated target ticket.' };
    const kind = node ? grantKinds.get(node.key) : undefined;
    if (node?.type === 'material' && (!kind || !transport.nodeActions?.[kind]?.includes(feature as GraphNodeAction))) return { available: false, reason: 'This asset requires an exact parent-owned item adapter.' };
    if (kind && transport.nodeActions && !transport.nodeActions[kind]?.includes(feature as GraphNodeAction)) return { available: false, reason: MISSING_ROUTE };
    if (node?.status === 'missing' && feature !== 'createMissing') return { available: false, reason: 'Create this missing document explicitly before using document actions.' };
    if (node && (feature === 'openDefault' || feature === 'reveal') && node.type !== 'note' && node.type !== 'material') return { available: false, reason: 'This node has no local file action.' };
    if (!transport.actions[feature]) return { available: false, reason: MISSING_ROUTE };
    if (node && !grants.has(node.key)) return { available: false, reason: 'This node has no action grant.' };
    return { available: true };
  };
  return {
    kind: 'scoped', allowWorker: false, vaultId,
    capability,
    completeness: () => {
      const missing = [...(snapshot?.completeness.missing || [])];
      if (!cached || !snapshot?.completeness.complete) missing.push(snapshot ? 'graph-not-ready' : 'graph-not-loaded');
      if (typeof transport.mutateTag !== 'function') missing.push('parent-route:tagRelation');
      if (typeof transport.exportScreenshot !== 'function') missing.push('parent-route:screenshot');
      for (const action of ['open', 'openDefault', 'reveal', 'askAi', 'createMissing'] as const) {
        if (!transport.actions[action]) missing.push(`parent-route:${action}`);
      }
      for (const node of nodes.values()) {
        if (!grants.has(node.key)) missing.push(`node-ticket:${node.key}`);
      }
      if ([...nodes.values()].some(node => node.status === 'missing' && !grants.has(node.key))) missing.push('missing-target-ticket:createMissing');
      for (const node of nodes.values()) {
        const required: GraphNodeAction[] = node.status === 'missing' ? ['createMissing'] : node.type === 'tag' ? ['open', 'askAi'] : ['open', 'openDefault', 'reveal', 'askAi'];
        for (const action of required) if (!capability(action, node).available) missing.push(`node-route:${node.key}:${action}`);
      }
      if ([...nodes.values()].some(node => node.type === 'material' && !capability('open', node).available)) missing.push('asset-parent-item-adapter');
      return { complete: missing.length === 0, missing };
    },
    renderedRevision: () => cached && snapshot?.completeness.complete ? snapshot.revision : null,
    dataProof: seed => cached && (!seed || seed === cached) && snapshot?.completeness.complete ? { kind: 'graph', snapshotId: snapshot.snapshotId, revision: snapshot.revision, ...(snapshot.sourceId ? { sourceId: snapshot.sourceId } : {}) } : null,
    contextNodeKey: () => context ? `${context.nodeType}:${context.nodeId}` : null,
    publishContext: value => { context = value; },
    subscribe(listener) {
      listeners.add(listener);
      const release = transport.subscribe?.(viewId, invalidate);
      return () => { listeners.delete(listener); release?.(); };
    },
    readSeed(options) {
      if (cached && !options?.refresh) return Promise.resolve(cached);
      if (pending && !options?.refresh) return pending;
      cached = null;
      const requestSequence = ++sequence;
      const request = transport.request<ScopedGraphSnapshot>({ op: 'graphRead', viewId, refresh: options?.refresh === true }).then(next => {
        if (requestSequence !== sequence) throw new Error('workspace-graph-read-superseded');
        if (next.vaultId !== vaultId || !next.snapshotId || !next.revision) throw new Error('workspace-graph-scope-mismatch');
        snapshot = next;
        cached = null;
        grants = new Map(); grantKinds = new Map(); nodes = new Map();
        const seed = buildScopedGraphSeed(next);
        const nextNodes = new Map(seed.nodes.map(node => [node.key, node]));
        const tokens = new Set<string>();
        for (const grant of next.grants) {
          const key = grantKey(vaultId, grant);
          if (!grant.token || tokens.has(grant.token) || grants.has(key) || !nextNodes.has(key)) throw new Error('workspace-graph-invalid-grant');
          tokens.add(grant.token);
          grants.set(key, grant.token); grantKinds.set(key, grant.kind);
        }
        nodes = nextNodes;
        cached = seed;
        return seed;
      }).finally(() => { if (pending === request) pending = null; });
      pending = request;
      return request;
    },
    async mutateRelation(kind, mode, source, target) {
      if (kind !== 'tag') throw new Error('workspace-graph-body-edit-in-document');
      if (typeof transport.mutateTag !== 'function') throw new Error('workspace-graph-tag-route-unavailable');
      const a = requireNode(source), b = requireNode(target);
      if (source.key === target.key || !((source.type === 'note' && target.type === 'tag') || (source.type === 'tag' && target.type === 'note'))) {
        throw new Error('workspace-graph-invalid-relation');
      }
      const result = await track(() => transport.mutateTag!({ op: 'graphMutateTag', viewId, snapshotId: a.snapshotId, sourceToken: a.token, targetToken: b.token, mode }));
      if (result.changed) invalidate();
      return result;
    },
    async exportScreenshot(image) {
      if (typeof transport.exportScreenshot !== 'function') throw new Error('workspace-graph-screenshot-route-unavailable');
      const result = await track(() => transport.exportScreenshot!(image));
      if (result !== 'copied' && result !== 'saved') throw new Error('workspace-graph-screenshot-unconfirmed');
      return result;
    },
    setFrozen(value) { frozen = value; },
    async flush() {
      const results = await Promise.allSettled([...operations]);
      return results.every(result => result.status === 'fulfilled') && !!cached && !!snapshot?.completeness.complete;
    },
    async act(action, node) {
      const supported = capability(action, node);
      if (!supported.available) throw new Error(supported.reason);
      const granted = requireNode(node);
      await track(() => transport.request<void>({ op: 'graphNodeAction', viewId, snapshotId: granted.snapshotId, nodeToken: granted.token, action, requestId:++actionSequence }));
    },
  };
}
