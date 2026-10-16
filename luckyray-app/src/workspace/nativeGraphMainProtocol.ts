import type { MaterialAsset } from '../core/services/materialCatalog';
import type { NativeViewGrant } from './nativeClient';
export type GraphMainAction =
  | { kind: 'openDocument'; vaultId: string; title: string }
  | { kind: 'createMissing'; vaultId: string; title: string; relativePath: string }
  | { kind: 'openTag'; vaultId: string; name: string }
  | { kind: 'openCatalogAsset'; libraryId: string; asset: MaterialAsset; assetRevision: string }
  | { kind: 'composeAi'; source: 'graph'; text: string }
  | { kind: 'fileOperation'; mode: 'open' | 'reveal'; label: string }
  | { kind: 'screenshot'; mime: 'image/png'; bytes: number[] };
export type GraphMainClaim = { id: string; claimToken: string; remainingMs: number; action: GraphMainAction };
export type GraphMainCompletion = { kind: 'acknowledged' } | { kind: 'screenshot'; result: 'copied' | 'saved' }
  | { kind: 'cancelled' } | { kind: 'failed'; code: string };
export type GraphMainExecution = { kind: 'acknowledged' } | { kind: 'openView'; view: NativeViewGrant }
  | { kind: 'openedInOrigin'; viewId: string } | { kind: 'screenshot'; result: 'saved' | 'cancelled' };
export const GRAPH_MAIN_HANDLER_KINDS = Object.freeze(['openDocument', 'createMissing', 'openTag', 'openCatalogAsset', 'composeAi', 'fileOperation', 'screenshot'] as const);
export function validateGraphMainClaim(value: GraphMainClaim) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.id) || !/^[a-f0-9]{64}$/.test(value.claimToken)
    || !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > 180000 || !GRAPH_MAIN_HANDLER_KINDS.includes(value.action?.kind)) throw Error('workspace-graph-main-invalid-claim');
  const action = value.action;
  if (action.kind === 'screenshot' && (action.mime !== 'image/png' || !Array.isArray(action.bytes) || action.bytes.length < 8 || action.bytes.length > 32 * 1024 * 1024
    || action.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
    || [137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => action.bytes[index] !== byte))) throw Error('workspace-graph-main-invalid-screenshot');
  if (action.kind === 'openCatalogAsset' && (!action.libraryId || !action.asset?.id || !action.assetRevision)) throw Error('workspace-graph-main-invalid-asset');
  if (action.kind === 'composeAi' && (action.source !== 'graph' || typeof action.text !== 'string' || !action.text || new TextEncoder().encode(action.text).byteLength > 12 * 1024)) throw Error('workspace-graph-main-invalid-context');
}
