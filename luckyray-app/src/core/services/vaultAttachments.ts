import { createAttachmentWorkflow } from "./vaultAttachmentWorkflow";
import { invoke } from "@tauri-apps/api/core";
import { ensureActiveKnowledgeUiSource, type KnowledgeDocumentRef, type KnowledgeDocumentSnapshot, type KnowledgeUiSourceActivation } from "./knowledge";
import { readActiveKnowledgeWriteSource } from "./knowledgeSource";

export type AttachmentPublication = { relativePath: string; markdown: string; sha256: string; bytes: number; reused: boolean };
export type AttachmentLinkUpdatePolicy = "ask" | "always";
export type AttachmentHandlingPolicy = "reference" | "copy";
export const getAttachmentHandlingPolicy = (vaultId: string) => invoke<AttachmentHandlingPolicy>("knowledge_get_attachment_handling_policy", { vaultId });
export const setAttachmentHandlingPolicy = (vaultId: string, sourceEpoch: number, policy: AttachmentHandlingPolicy) => invoke<AttachmentHandlingPolicy>("knowledge_set_attachment_handling_policy", { vaultId, sourceEpoch, policy });
export const getAttachmentLinkUpdatePolicy = (vaultId: string) => invoke<AttachmentLinkUpdatePolicy>("knowledge_get_attachment_link_update_policy", { vaultId });
export const setAttachmentLinkUpdatePolicy = (vaultId: string, sourceEpoch: number, policy: AttachmentLinkUpdatePolicy) => invoke<AttachmentLinkUpdatePolicy>("knowledge_set_attachment_link_update_policy", { vaultId, sourceEpoch, policy });
export type AttachmentResolution = { status: string; candidates: string[]; relativePath: string | null; absolutePath: string | null; fragment: string; version?: string | null; materialAssetId?: string | null };
export type AttachmentContext = { documentRef: KnowledgeDocumentRef; sourceEpoch: number; expectedRevision: string; savedContent: string };

export function attachmentContextIsCurrent(context: AttachmentContext) {
  return readActiveKnowledgeWriteSource()?.vaultId === context.documentRef.vaultId;
}

export async function captureAttachmentContext(relativePath: string): Promise<AttachmentContext> {
  const source = readActiveKnowledgeWriteSource();
  if (!source?.vaultId) throw new Error("请先打开知识库");
  const documentRef = { vaultId: source.vaultId, relativePath };
  const [active, document] = await invoke<[KnowledgeUiSourceActivation, KnowledgeDocumentSnapshot]>("knowledge_attachment_context", { documentRef });
  if (readActiveKnowledgeWriteSource()?.vaultId !== documentRef.vaultId || active.vaultId !== documentRef.vaultId) throw new Error("知识库已切换，请重试");
  return { documentRef, sourceEpoch: active.sourceEpoch, expectedRevision: document.revision, savedContent: document.content };
}

export async function publishVaultAttachment(context: AttachmentContext, source: { name: string; bytes?: number[]; sourcePath?: string; materialId?: string }) {
  if (readActiveKnowledgeWriteSource()?.vaultId !== context.documentRef.vaultId) throw new Error("知识库已切换，请重试");
  const handlingPolicy = source.bytes ? "copy" : await getAttachmentHandlingPolicy(context.documentRef.vaultId);
  if (!attachmentContextIsCurrent(context)) throw new Error("知识库已切换，请重试");
  return invoke<AttachmentPublication>("knowledge_publish_attachment", { input: { documentRef: context.documentRef, sourceEpoch: context.sourceEpoch, expectedRevision: context.expectedRevision, handlingPolicy, ...source } });
}

export function invalidateKnowledgeAttachmentInventory(vaultId: string) {
  return invoke<void>("knowledge_invalidate_attachment_inventory", { vaultId });
}

export function resolveVaultAttachment(documentRef: KnowledgeDocumentRef, destination: string, wiki: boolean) {
  return invoke<AttachmentResolution>("knowledge_resolve_attachment", { documentRef, destination, wiki });
}

export type AttachmentOperationIssue = { document: string; target: string; status: string };
export type AttachmentOperationPlan = {
  version: number; vaultId: string; targetIdentity: string; kind: string;
  attachmentDependencies: [string, string][];
  files: { relativePath: string; before: string | null; after: string | null; beforeRevision: string | null; afterRevision: string | null }[];
  issues: AttachmentOperationIssue[]; documentCount: number; attachmentCount: number; copyBytes: number; backupBytes: number;
};
export type AttachmentOperationResult = { operationId: string; status: string; completedFiles: number; totalFiles: number; issues: AttachmentOperationIssue[]; recoveryPath: string };
export const previewAttachmentConversion = (documentRef: KnowledgeDocumentRef) => invoke<AttachmentOperationPlan>("knowledge_preview_attachment_conversion", { documentRefs: [documentRef] });
export const previewAttachmentRename = (vaultId: string, oldPath: string, newPath: string) => invoke<AttachmentOperationPlan>("knowledge_preview_attachment_rename", { vaultId, oldPath, newPath });
export const previewAttachmentImport = async (vaultId: string, sourceRoot: string, sourceNotes: string[], targetParent: string) => invoke<AttachmentOperationPlan>("knowledge_preview_attachment_import", { vaultId, sourceRoot, sourceNotes, targetParent, handlingPolicy: await getAttachmentHandlingPolicy(vaultId) });
export const executeAttachmentOperation = (sourceEpoch: number, plan: AttachmentOperationPlan, requestId: string) => invoke<AttachmentOperationResult>("knowledge_execute_attachment_operation", { sourceEpoch, plan, requestId });
export const recoverAttachmentOperation = (sourceEpoch: number, vaultId: string, operationId: string, rollback: boolean, requestId: string) => invoke<AttachmentOperationResult>("knowledge_recover_attachment_operation", { sourceEpoch, vaultId, operationId, rollback, requestId });
export const cancelAttachmentOperation = (vaultId: string, requestId: string) => invoke<void>("knowledge_cancel_attachment_operation", { vaultId, requestId });
export const listAttachmentOperations = (vaultId: string) => invoke<string[]>("knowledge_list_attachment_operations", { vaultId });

// Operation state is scoped to a Vault and survives a settings component closing.
// It is transient UI state; native files and durable receipts remain authoritative.
const attachmentWorkflows = new Map<string, ReturnType<typeof createAttachmentWorkflow>>();
export function getVaultAttachmentWorkflow(vaultId: string) {
  const existing = attachmentWorkflows.get(vaultId);
  if (existing) return existing;
  const requireCurrent = () => {
    if (readActiveKnowledgeWriteSource()?.vaultId !== vaultId) throw new Error("知识库已切换，请在原知识库继续操作");
  };
  const workflow = createAttachmentWorkflow({
    capture: async () => {
      requireCurrent();
      const source = readActiveKnowledgeWriteSource();
      const active = await ensureActiveKnowledgeUiSource();
      requireCurrent();
      if (readActiveKnowledgeWriteSource() !== source || active.vaultId !== vaultId) throw new Error("知识库已切换，请重试");
      return active.sourceEpoch;
    },
    collect: (paths) => { requireCurrent(); return invoke<AttachmentOperationPlan>("knowledge_preview_attachment_conversion", { documentRefs: paths.map(relativePath => ({ vaultId, relativePath })) }); },
    rename: (oldPath, newPath) => { requireCurrent(); return previewAttachmentRename(vaultId, oldPath, newPath); },
    execute: (epoch, plan, requestId) => { requireCurrent(); return executeAttachmentOperation(epoch, plan, requestId); },
    recover: (epoch, id, rollback, requestId) => { requireCurrent(); return recoverAttachmentOperation(epoch, vaultId, id, rollback, requestId); },
    cancel: (requestId) => cancelAttachmentOperation(vaultId, requestId),
  });
  attachmentWorkflows.set(vaultId, workflow);
  return workflow;
}

export type ExternalAttachmentUpdate = { sourceEpoch: number; plan: AttachmentOperationPlan | null; referenceCount: number; changedPaths: string[]; uncertainCount: number };
export const previewExternalAttachmentChanges = (vaultId: string, paths: string[], incomplete: boolean) => invoke<ExternalAttachmentUpdate>("knowledge_preview_external_attachment_changes", { vaultId, paths, incomplete });

export type AttachmentAuditEntry = { document: string; target: string; line: number; scope: string; status: string; absolutePath: string | null; candidates: string[]; bytes: number; migrationAvailable: boolean };
export type AttachmentAudit = { vaultId: string; documentCount: number; entries: AttachmentAuditEntry[]; migrationFileCount: number; migrationCopyBytes: number };
export type AttachmentExportResult = { vaultId: string; destination: string; status: string; documentCount: number; attachmentCount: number; writtenBytes: number; issues: AttachmentOperationIssue[] };
export const auditAttachmentPortability = (vaultId: string) => invoke<AttachmentAudit>("knowledge_audit_attachment_portability", { vaultId, documentRefs: [] });
export const exportStandaloneVault = (vaultId: string, targetRoot: string, sourceEpoch: number) => invoke<AttachmentExportResult>("knowledge_export_standalone_vault", { vaultId, targetRoot, sourceEpoch });
export const previewAttachmentRelink = (vaultId: string, assetId: string, newPath: string) => invoke<AttachmentOperationPlan>("knowledge_preview_attachment_relink", { vaultId, assetId, newPath });

export const previewMaterialFileMove = (vaultId: string, assetId: string, destinationPath: string) => invoke<AttachmentOperationPlan>("knowledge_preview_material_file_move", { vaultId, assetId, destinationPath });

export type DiscoveredAttachmentMove = { assetId: string; previousPath: string; newPath: string };
export const discoverAttachmentMoves = (vaultId: string) => invoke<DiscoveredAttachmentMove[]>("knowledge_discover_attachment_moves", { vaultId });
