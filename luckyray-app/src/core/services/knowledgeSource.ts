export type ActiveKnowledgeSourceMode = "real-vault";

export const KNOWLEDGE_SOURCE_CHANGED_EVENT = "luckyray:knowledge-source-changed";

export type ActiveKnowledgeSource = {
  mode: ActiveKnowledgeSourceMode;
  vaultId?: string | null;
  rootPath?: string | null;
};

let activeKnowledgeSource: ActiveKnowledgeSource | null = null;
let knowledgeWritesSuspended = false;

export function readActiveKnowledgeSource() {
  return activeKnowledgeSource;
}

export function readActiveKnowledgeWriteSource() {
  if (knowledgeWritesSuspended || activeKnowledgeSource?.mode !== "real-vault" || !activeKnowledgeSource.vaultId) return null;
  return activeKnowledgeSource;
}

export function activateKnowledgeWritesForVault(source: ActiveKnowledgeSource) {
  setActiveKnowledgeSource({ ...source, mode: "real-vault" }, true);
}

export function setActiveKnowledgeSource(source: ActiveKnowledgeSource, newSession = false) {
  if ((source as { mode: string }).mode !== "real-vault" || !source.vaultId) {
    clearActiveKnowledgeSource();
    return;
  }
  const next: ActiveKnowledgeSource = {
    mode: "real-vault",
    vaultId: source.vaultId,
    rootPath: source.rootPath || null,
  };
  const current = activeKnowledgeSource;
  // Index revalidation must not manufacture a new editing session. Explicit
  // activation still replaces this identity, including reopening the same Vault.
  if (!newSession && !knowledgeWritesSuspended && current?.mode === next.mode && current.vaultId === next.vaultId && current.rootPath === next.rootPath) return;
  knowledgeWritesSuspended = false;
  activeKnowledgeSource = next;
  if (typeof window === "undefined") return;
  if (current?.mode === next.mode && current.vaultId === next.vaultId && current.rootPath === next.rootPath) return;
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_SOURCE_CHANGED_EVENT, { detail: next }));
}

export function clearActiveKnowledgeSource() {
  const current = activeKnowledgeSource;
  activeKnowledgeSource = null;
  knowledgeWritesSuspended = true;
  if (typeof window === "undefined" || current === null) return;
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_SOURCE_CHANGED_EVENT, { detail: null }));
}
