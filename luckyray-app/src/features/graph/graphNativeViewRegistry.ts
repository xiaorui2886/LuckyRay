import type { BridgeVaultMetadata } from '../../core/bridge/bridgeTypes';
import type { GraphSeed, GraphSeedProvenance } from '../../core/services/graph';
import { buildScopedGraphSeed, type ScopedGraphSnapshot } from '../../workspace/scopedGraphRuntime';
import type { GraphViewApplyAck, GraphViewIdentity, GraphViewPresentation } from '../../workspace/graphViewPresentation';

export const GRAPH_NATIVE_VIEWS_CHANGED_EVENT = 'luckyray:graph-native-views-changed';
export const GRAPH_NATIVE_DETACH_EVENT = 'luckyray:graph-native-detach';
export type GraphNativeViewBinding = { viewId: string; vaultId: string; title: string; generation: number; sourceId?: string; materialLibraryId: string | null; materialLibraryGeneration: number; materialSourceVersion: number | null; vault: BridgeVaultMetadata };
export type GraphNativeIncomingView = { viewId: string; vaultId: string; sourceId: string; title: string };
export interface GraphNativeViewAdapter {
  binding(): GraphNativeViewBinding;
  freeze(): void;
  flush(): Promise<boolean>;
  capture(expected: ScopedGraphSnapshot): Promise<GraphViewPresentation>;
  restore(expected: ScopedGraphSnapshot, snapshot: GraphViewPresentation, expectedSource: GraphViewIdentity, presentationHash?: string): Promise<GraphViewApplyAck>;
  release(): Promise<void>;
  commitRelease(): Promise<void>;
  activate(): Promise<void>;
  abort(): Promise<void>;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
/** Full topology, labels, relation kinds, directions, timestamps and missing
 * target metadata must agree; comparing counts or keys alone is insufficient. */
export function sameNativeGraphSeed(seed: GraphSeed, expected: ScopedGraphSnapshot): boolean {
  try { return JSON.stringify(canonical(seed)) === JSON.stringify(canonical(buildScopedGraphSeed(expected))); } catch { return false; }
}
export function isNativeGraphAdmission(seed: GraphSeed, provenance: GraphSeedProvenance, expected: ScopedGraphSnapshot) {
  return expected.vaultId === provenance.vault.id && /^graph-source-v1:[a-f0-9]{64}$/.test(expected.sourceId || '')
    && sameNativeGraphSeed(seed, expected) && JSON.stringify(provenance.documentRevisions)
      === JSON.stringify(expected.documents.map(document => ({ relativePath: document.relativePath, revision: document.revision })));
}
export function graphNativeIdentity(binding: GraphNativeViewBinding): GraphViewIdentity {
  if (!binding.sourceId) throw Error('workspace-graph-main-source-unverified');
  return { viewId: binding.viewId, vaultId: binding.vaultId, sourceId: binding.sourceId, generation: binding.generation };
}
export class GraphNativeViewRegistry {
  private views = new Map<string, GraphNativeViewAdapter>();
  private frozen = new Set<string>();
  private listeners = new Set<() => void>();
  private unregisterListeners=new Set<(viewId:string,adapter:GraphNativeViewAdapter)=>void>();
  onUnregister(listener:(viewId:string,adapter:GraphNativeViewAdapter)=>void){this.unregisterListeners.add(listener);return()=>{this.unregisterListeners.delete(listener);};}
  hasFrozenViews = () => this.frozen.size > 0 || this.incoming.size > 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); if (typeof window !== 'undefined') window.dispatchEvent(new Event(GRAPH_NATIVE_VIEWS_CHANGED_EVENT)); }
  private setFrozen(viewId: string, frozen: boolean) {
    if (this.frozen.has(viewId) === frozen) return;
    if (frozen) this.frozen.add(viewId); else this.frozen.delete(viewId); this.changed();
  }
  private verifier: ((binding: GraphNativeViewBinding) => Promise<ScopedGraphSnapshot>) | null = null;
  private receivers = new Set<() => void>();
  private receiver: ((incoming: GraphNativeIncomingView) => Promise<GraphNativeViewAdapter>) | null = null;
  private incoming = new Set<string>();
  registerReceiver(receiver: (incoming: GraphNativeIncomingView) => Promise<GraphNativeViewAdapter>) {
    if (this.receiver) throw Error('workspace-graph-main-receiver-already-mounted');
    this.receiver = receiver; return () => { if (this.receiver === receiver) this.receiver = null; };
  }
  async prepareIncoming(incoming: GraphNativeIncomingView) {
    if (!this.receiver || this.incoming.has(incoming.viewId)) throw Error('workspace-graph-main-receiver-unavailable');
    this.incoming.add(incoming.viewId); this.changed();
    try { return await this.receiver(incoming); } finally { this.incoming.delete(incoming.viewId); this.changed(); }
  }
  isIncoming(viewId: string) { return this.incoming.has(viewId); }
  installSourceVerifier(verifier: (binding: GraphNativeViewBinding) => Promise<ScopedGraphSnapshot>) {
    if (this.verifier) throw Error('workspace-graph-main-verifier-already-installed');
    this.verifier = verifier; for (const listener of this.receivers) listener();
    return () => { if (this.verifier === verifier) this.verifier = null; };
  }
  onVerifierInstalled(listener: () => void) { this.receivers.add(listener); return () => { this.receivers.delete(listener); }; }
  async verifySource(binding: GraphNativeViewBinding) {
    const verifier = this.verifier;
    if (!verifier) throw Error('workspace-graph-main-verifier-unavailable');
    const dto = await verifier({ ...binding, vault: { ...binding.vault } });
    if (this.verifier !== verifier || dto.vaultId !== binding.vaultId || !/^graph-source-v1:[a-f0-9]{64}$/.test(dto.sourceId || '')) throw Error('workspace-graph-main-source-mismatch');
    return dto;
  }
  register(viewId: string, adapter: GraphNativeViewAdapter) {
    if (!viewId || this.views.has(viewId)) throw Error('workspace-graph-main-view-already-registered');
    const held: GraphNativeViewAdapter = {
      ...adapter,
      freeze: () => { adapter.freeze(); this.setFrozen(viewId, true); },
      restore: (...args) => { this.setFrozen(viewId, true); return adapter.restore(...args); },
      release: async () => { await adapter.release(); this.setFrozen(viewId, true); },
      commitRelease: async () => { await adapter.commitRelease(); this.setFrozen(viewId, false); },
      activate: async () => { await adapter.activate(); this.setFrozen(viewId, false); },
      abort: async () => { await adapter.abort(); this.setFrozen(viewId, false); },
    };
    this.views.set(viewId, held);
    return () => { if (this.views.get(viewId) === held) { this.views.delete(viewId); this.setFrozen(viewId, false);for(const listener of this.unregisterListeners)listener(viewId,held); } };
  }
  registered(viewId:string){return this.views.get(viewId);}
  get(viewId: string) { const adapter = this.views.get(viewId); if (!adapter || adapter.binding().viewId !== viewId) throw Error('workspace-graph-main-view-not-mounted'); return adapter; }
  list() { return [...this.views.values()].flatMap(view => { try { return [view.binding()]; } catch { return []; } }); }
}
export const graphNativeViews = new GraphNativeViewRegistry();
/** UI supplies one selected stable ID. Binding and scope come from its adapter. */
export function requestGraphNativeDetach(viewId: string, move = false) {
  if (typeof move !== 'boolean') throw Error('workspace-graph-detach-mode-invalid');
  graphNativeViews.get(viewId);
  window.dispatchEvent(new CustomEvent(GRAPH_NATIVE_DETACH_EVENT, { detail: { viewId, move } }));
}
