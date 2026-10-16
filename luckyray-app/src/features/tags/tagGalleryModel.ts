import { parseKnowledgeTagIdentity } from "../../core/services/knowledge";
import { getTagSourceCounts } from "./useTags";
import type { BridgeTag } from "./useTags";

export type TagGalleryFilter = "all" | "mixed" | "materials" | "knowledge";
export type TagGallerySort = "linked" | "name";
export type TagDetailFilter = "all" | "materials" | "knowledge";

export type TagFocusResolution =
  | { status: "matched"; tag: BridgeTag }
  | { status: "not-found" | "stale-vault" | "invalid"; tag: null };

export function resolveTagFocusForActiveVault(
  tags: BridgeTag[],
  focusId: string,
  activeVaultId: string | null,
): TagFocusResolution {
  const knowledgeIdentity = parseKnowledgeTagIdentity(focusId);
  if (focusId.startsWith("real-vault-tag:") && !knowledgeIdentity) {
    return { status: "invalid", tag: null };
  }
  if (knowledgeIdentity) {
    if (!activeVaultId || knowledgeIdentity.vaultId !== activeVaultId) {
      return { status: "stale-vault", tag: null };
    }
    const tag = tags.find((candidate) => (
      candidate.id === focusId || candidate.realVaultAliases?.includes(focusId)
    ));
    return tag ? { status: "matched", tag } : { status: "not-found", tag: null };
  }
  const tag = tags.find((candidate) => candidate.id === focusId);
  return tag ? { status: "matched", tag } : { status: "not-found", tag: null };
}

export function summarizeTagGallery(tags: BridgeTag[]) {
  return tags.reduce((summary, tag) => {
    const counts = getTagSourceCounts(tag);
    summary.materials += counts.assetCount;
    summary.knowledge += counts.realVaultDocumentCount;
    return summary;
  }, { tags: tags.length, materials: 0, knowledge: 0 });
}

export function filterAndSortTagGallery(
  tags: BridgeTag[],
  input: { query: string; filter: TagGalleryFilter; sort: TagGallerySort },
): BridgeTag[] {
  const query = input.query.trim().toLocaleLowerCase();
  return tags
    .filter((tag) => {
      const counts = getTagSourceCounts(tag);
      if (query && !tag.name.toLocaleLowerCase().includes(query)) return false;
      if (input.filter === "mixed") return counts.assetCount > 0 && counts.realVaultDocumentCount > 0;
      if (input.filter === "materials") return counts.assetCount > 0;
      if (input.filter === "knowledge") return counts.realVaultDocumentCount > 0;
      return true;
    })
    .sort((left, right) => {
      if (input.sort === "name") return left.name.localeCompare(right.name, "zh", { sensitivity: "base" });
      const countDelta = getTagSourceCounts(right).total - getTagSourceCounts(left).total;
      return countDelta || left.name.localeCompare(right.name, "zh", { sensitivity: "base" });
    });
}
