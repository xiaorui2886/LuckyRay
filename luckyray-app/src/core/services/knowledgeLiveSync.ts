import { invoke, isTauri } from "@tauri-apps/api/core";
import { ensureActiveKnowledgeUiSource, parseKnowledgeDocumentNoteId } from "./knowledge";
import { readActiveKnowledgeWriteSource } from "./knowledgeSource";

export type KnowledgeCommittedChange = { vaultId: string; relativePaths: string[] };

/** Cheap process-incarnation wake-up marker; never a durable content cursor. */
export async function readKnowledgeCommittedCheckpoint(vaultId: string): Promise<string | null> {
  if (!isTauri()) return null;
  const source = readActiveKnowledgeWriteSource();
  if (!source || source.vaultId !== vaultId) return null;
  const activation = await ensureActiveKnowledgeUiSource();
  if (source !== readActiveKnowledgeWriteSource()) return null;
  const result = await invoke<{ vaultId: string; checkpoint: string }>("knowledge_companion_committed_checkpoint", { vaultId, sourceEpoch: activation.sourceEpoch });
  if (source !== readActiveKnowledgeWriteSource() || result.vaultId !== vaultId
      || typeof result.checkpoint !== "string" || !/^[a-f0-9]{32}:\d{1,20}$/.test(result.checkpoint)) return null;
  return `${activation.sourceEpoch}:${result.checkpoint}`;
}

/** A commit event only wakes an authoritative reread in its current Vault. */
export function knowledgeCommittedPaths(payload: unknown, vaultId: string): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const change = payload as KnowledgeCommittedChange;
  if (change.vaultId !== vaultId || !Array.isArray(change.relativePaths)
      || change.relativePaths.length === 0 || change.relativePaths.length > 100) return null;
  if (!change.relativePaths.every(path => typeof path === "string" && path.length <= 1024
      && !path.startsWith("/") && !path.includes("\\") && !path.includes(":")
      && !/[\u0000-\u001f]/.test(path) && /\.md$/i.test(path)
      && !path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".luckyray"))) return null;
  return [...new Set(change.relativePaths)];
}

export async function readKnowledgeMobileEditing(noteId: string): Promise<boolean> {
  if (!isTauri()) return false;
  const source = readActiveKnowledgeWriteSource();
  const documentRef = parseKnowledgeDocumentNoteId(noteId);
  if (!source || !documentRef || documentRef.vaultId !== source.vaultId) return false;
  const activation = await ensureActiveKnowledgeUiSource();
  if (source !== readActiveKnowledgeWriteSource()) return false;
  const result = await invoke<{ mobileEditing: boolean }>("knowledge_companion_editing_status", { documentRef, sourceEpoch: activation.sourceEpoch });
  return source === readActiveKnowledgeWriteSource() && result.mobileEditing === true;
}
