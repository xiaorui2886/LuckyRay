// Native offers name a real desktop scope, not a phone-visible opaque key.
// Read these snapshots synchronously at the final focus/navigation boundary.
export type PresentationScopeSnapshot = {
  material: { libraryId: string | null; status: string; generation: number };
  knowledge: { vaultId: string | null; status: string; loaded: boolean; source: object | null; transitionGeneration: number; transitioning: boolean; confirmedVaultId: string | null };
};
export type PresentationScopeOffer = {
  expectedMaterialLibraryId?: unknown;
  expectedKnowledgeVaultId?: unknown;
};

export function canApplyCompanionPresentationScope(
  domain: "materials" | "knowledge",
  offer: PresentationScopeOffer,
  before: PresentationScopeSnapshot,
  current: PresentationScopeSnapshot,
): boolean {
  if (domain === "materials") {
    const expected = offer.expectedMaterialLibraryId;
    return typeof expected === "string" && expected.length > 0
      && before.material.status === "ready" && current.material.status === "ready"
      && before.material.libraryId === expected && current.material.libraryId === expected
      && before.material.generation === current.material.generation;
  }
  const expected = offer.expectedKnowledgeVaultId;
  return typeof expected === "string" && expected.length > 0
    && !before.knowledge.transitioning && !current.knowledge.transitioning
    && before.knowledge.transitionGeneration === current.knowledge.transitionGeneration
    && before.knowledge.confirmedVaultId === expected && current.knowledge.confirmedVaultId === expected
    && before.knowledge.loaded && current.knowledge.loaded
    && before.knowledge.status === "ready" && current.knowledge.status === "ready"
    && before.knowledge.vaultId === expected && current.knowledge.vaultId === expected
    && before.knowledge.source !== null && before.knowledge.source === current.knowledge.source;
}
