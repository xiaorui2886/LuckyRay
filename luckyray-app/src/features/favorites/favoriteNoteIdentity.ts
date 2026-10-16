import {
  knowledgeDocumentNoteId,
  parseKnowledgeDocumentNoteId,
  type KnowledgeDocumentRef,
} from "../../core/services/knowledge";

const REAL_VAULT_NOTE_PREFIX = "real-vault:";

export type FavoriteNoteIdentity = {
  canonicalId: string;
  aliases: string[];
  documentRef: KnowledgeDocumentRef;
};

export function resolveFavoriteNoteIdentity(
  noteId: string,
  currentVaultId: string | null | undefined,
  options: { allowCurrentVaultLegacy?: boolean } = {},
): FavoriteNoteIdentity | null {
  const canonical = parseKnowledgeDocumentNoteId(noteId);
  if (canonical) {
    return { canonicalId: noteId, aliases: [noteId], documentRef: canonical };
  }
  if (!options.allowCurrentVaultLegacy
    || !currentVaultId
    || currentVaultId.trim() !== currentVaultId
    || !noteId.startsWith(REAL_VAULT_NOTE_PREFIX)) {
    return null;
  }
  const relativePath = noteId.slice(REAL_VAULT_NOTE_PREFIX.length);
  try {
    const documentRef = { vaultId: currentVaultId, relativePath };
    const canonicalId = knowledgeDocumentNoteId(documentRef);
    return { canonicalId, aliases: [noteId, canonicalId], documentRef };
  } catch {
    return null;
  }
}
