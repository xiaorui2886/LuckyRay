import { invoke } from "@tauri-apps/api/core";
import { ensureActiveKnowledgeUiSource } from "./knowledge";
import { readActiveKnowledgeWriteSource } from "./knowledgeSource";

export type NoteRecoveryVersion = { slot: string; revision: string; bytes: number; preview: string | null; changedSinceRecord: boolean };
export type NoteRecoveryItem = { recordPath: string; originalPath: string; kind: string; pending: boolean; token: string; canRestore: boolean; versions: NoteRecoveryVersion[]; unavailableVersions: number };
export type NoteRecoverySnapshot = { supported: boolean; startupBlocked: boolean; records: NoteRecoveryItem[]; issues: { recordPath: string; code: string }[]; scanIncomplete: boolean };
export const readNoteRecovery = (vaultId: string, summaryOnly = false) => invoke<NoteRecoverySnapshot>("knowledge_note_recovery_snapshot", { vaultId, summaryOnly });

export async function recoverNoteVersion(vaultId: string, item: NoteRecoveryItem, slot: string, destination: string | null, restoreOriginal: boolean) {
  const source = readActiveKnowledgeWriteSource();
  const active = await ensureActiveKnowledgeUiSource();
  if (!source || readActiveKnowledgeWriteSource() !== source || active.vaultId !== vaultId) throw new Error("知识库已切换，请重新读取恢复记录");
  return invoke<string>("knowledge_recover_note_version", { sourceEpoch: active.sourceEpoch, vaultId, recordPath: item.recordPath, token: item.token, slot, destination, restoreOriginal });
}

export function recoveryCopyName(path: string) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? `${path.slice(0, dot)} (恢复副本)${path.slice(dot)}` : `${path} (恢复副本)`;
}
