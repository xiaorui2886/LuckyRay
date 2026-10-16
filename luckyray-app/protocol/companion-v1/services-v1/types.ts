/** Canonical new Services V1 DTOs. Old Content V1 DTOs are not widened here. */
import type { Mutation as ContentMutation, Note as ContentNote } from "../content-v1/types";
export type GrantClass = "content.read" | "content.write" | "ingest.write" | "desktop.open" | "lsh.remote";
export type OperationState = "implemented" | "notGranted" | "temporarilyUnavailable" | "unsupported";
export type ServiceDomain = "materials" | "knowledge" | "ingest" | "search" | "changes" | "presentation" | "lsh";

export interface OperationStatus {
  state: OperationState;
  capability: string;
  grant: GrantClass | null;
  scope: "pairedDevice" | "device" | "catalog" | "asset" | "currentVault" | "currentVaultNote" |
    "registeredVaults" | "registeredVault" | "registeredVaultNote" | "targetCatalogOrVault" |
    "ownedJob" | "visibleCatalogAndVaults" | "typedAssetOrVaultNote";
}

export interface ServiceSummary {
  version: number;
  available: boolean;
  granted: boolean;
}

export interface ServiceCatalog {
  catalogVersion: 1;
  bundleRevision: string;
  desktopInstanceId: string;
  gatewayGeneration: number;
  permissionRevision: number;
  services: Record<ServiceDomain, ServiceSummary>;
  operations: Record<string, OperationStatus>;
  limits: {
    pageSize: number;
    batchItems: number;
    noteBytes: number;
    uploadBytes: number;
    uploadChunkBytes: number;
    concurrentUploads: number;
    searchResults: number;
  };
}

export interface SafeSource {
  captureKind: "web" | "import" | "clipboard" | "unknown";
  pageKind?: "work-page" | "capture-page";
  pageUrl?: string;
  siteOrigin?: string;
  capturedAt?: string;
}
export interface MaterialDetail {
  assetId: string;
  name: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  revision: string;
  description?: string | null;
  source?: SafeSource;
}
export interface MaterialPatch {
  opId: string;
  expectedRevision: string;
  name?: string;
  description?: string | null;
}
export interface MaterialRemove {
  opId: string;
  expectedRevision: string;
  mode: "removeRecord";
}
export interface MaterialReceipt {
  opId: string;
  assetId: string;
  revision: string;
  disposition: "updated" | "removed";
}
export interface MaterialChange {
  cursor: string;
  assetId: string;
  revision: string;
  kind: "created" | "updated" | "moved" | "tagged" | "favorited" | "removed";
  tombstone: boolean;
}
export interface MaterialChangePage {
  items: MaterialChange[];
  snapshotCursor: string;
  nextCursor: string;
  hasMore: boolean;
}

export interface VaultDescriptor {
  vaultId: string;
  displayName: string;
  activeInDesktop: boolean;
  readGranted: boolean;
  writeGranted: boolean;
  revision: string;
}
export interface VaultPage { items: VaultDescriptor[] }
export interface KnowledgeNoteSummary {
  vaultId: string;
  noteId: string;
  title: string;
  revision: string;
  parentRelativePath: string;
}
export interface KnowledgeNotePage { items: KnowledgeNoteSummary[]; hasMore: boolean; nextAfterId: string | null }
export interface KnowledgeMove {
  opId: string;
  vaultId: string;
  expectedRevision: string;
  parentRelativePath: string;
}
export interface KnowledgeMoveReceipt {
  opId: string;
  vaultId: string;
  noteId: string;
  revision: string;
  parentRelativePath: string;
}
export interface KnowledgeChange {
  cursor: string;
  vaultId: string;
  noteId: string;
  revision: string;
  deleted: boolean;
}
export interface KnowledgeChangePage {
  items: KnowledgeChange[];
  snapshotCursor: string;
  nextCursor: string;
  hasMore: boolean;
}

/** Preserve the exact originally prepared Content payload; retries never switch routes. */
export type KnowledgeUniqueCreate = Omit<ContentMutation, "kind" | "expectedRevision"> & {
  kind: "create";
  expectedRevision?: "" | null;
};
export interface KnowledgeUniqueReceipt { opId: string; document: ContentNote }
export interface KnowledgeEditingStatus {
  vaultId: string; noteId: string; desktopEditing: boolean; mobileEditing: boolean; leaseMs: 15000;
}
/** Ephemeral, non-idempotent inert reservation; never placed in the durable outbox. */
export interface KnowledgeEditingOpen { vaultId: string }
export interface KnowledgeEditingSet {
  vaultId: string; sessionId: string; generation: number; editing: boolean;
}
export interface KnowledgeEditingLease extends KnowledgeEditingSet { noteId: string; leaseMs: 15000 }
export interface KnowledgeDirectoryPage {
  vaultId: string; items: { parentRelativePath: string }[]; nextAfterPath: string | null; hasMore: boolean;
}
export type KnowledgeRelation =
  | { kind: "wikiLink"; target: string; line: number; status: "resolved" | "ambiguous" | "unresolved"; noteIds: string[] }
  | { kind: "backlink"; sourceNoteId: string; target: string; line: number; status: "resolved" | "ambiguous" | "unresolved"; noteIds: string[] }
  | { kind: "material"; assetId: string; target: string };
export interface KnowledgeRelationPage {
  vaultId: string; noteId: string; revision: string; items: KnowledgeRelation[]; nextAfter: string | null; hasMore: boolean;
}
export interface KnowledgeMaterialReferencePage {
  vaultId: string; assetId: string; items: { noteId: string; target: string }[]; nextAfter: string | null; hasMore: boolean;
}

export type IngestTarget =
  | { domain: "materials"; folderId?: string | null }
  | { domain: "knowledge"; vaultId: string; parentRelativePath: string };
export interface IngestBegin {
  opId: string;
  kind: "text" | "url" | "image" | "video" | "file" | "clipboard";
  target: IngestTarget;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  text?: string;
  source?: SafeSource;
}
export interface IngestReceipt {
  domain: "materials" | "knowledge";
  assetId?: string;
  vaultId?: string;
  noteId?: string;
  revision: string;
}
export interface IngestJob {
  jobId: string;
  opId: string;
  state: "staging" | "completed" | "cancelled";
  committedBytes: number;
  receipt?: IngestReceipt;
}

export type SearchHit =
  | { domain: "materials"; assetId: string; title: string; subtitle?: string; resource?: ResourceDescriptor }
  | { domain: "knowledge"; vaultId: string; noteId: string; title: string; path?: string; snippet?: string };
export interface SearchPage { items: SearchHit[]; nextCursor?: string | null }
export interface ResourceDescriptor { domain: "materials" | "knowledge"; resourceId: string; version: string; mimeType: string; length: number }

export type PresentationTarget = { domain: "materials"; assetId: string } |
  { domain: "knowledge"; vaultId: string; noteId: string };
export interface PresentationOpen { opId: string; target: PresentationTarget }
export interface PresentationReceipt {
  opId: string;
  state: "accepted" | "handoffStarted" | "queued" | "displayed" | "refused";
  reason?: "busy" | "dirtyDraft" | "targetUnavailable";
}

export type EventHint =
  | { kind: "servicesChanged"; permissionRevision: number }
  | { kind: "materialChanged"; cursor: string }
  | { kind: "knowledgeChanged"; vaultId: string; cursor: string }
  | { kind: "ingestChanged"; jobId: string }
  | { kind: "lshStateChanged" };
export interface ServiceError { code: string }
