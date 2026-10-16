import type { FavoriteItem, FavoriteItemType } from "../../core/services/favorites";
import { knowledgeDocumentNoteId } from "../../core/services/knowledge";
import { knowledgeStore } from "../../core/services/knowledgeStore";
import { materialStore } from "../../core/services/materialStore";
import { createRealVaultLibraryAssetResolver } from "../../core/markdown/realVaultEmbeds";
import type { MaterialAsset } from "../../core/services/materials";
import { getLuckyRayBridge } from "../../core/bridge/luckyRayBridge";
import { focusEntity } from "../../core/services/context";
import { focusNote } from "../../core/services/notes";
import { openCanvasById } from "../canvas/canvasNavigation";
import { selectFavoriteSourcesById, type FavoriteShelfEntry } from "./favoriteShelfModel";
import { resolveFavoriteNoteIdentity } from "./favoriteNoteIdentity";
import { loadMaterialFavoriteTags, projectKnowledgeFavoriteTags } from "./favoriteTagProjection";
import type { LuckyRayBridge } from "../../core/bridge/luckyRayBridge";

type CanvasSource = Awaited<ReturnType<LuckyRayBridge["listCanvases"]>>[number];

export type FavoriteSourceCopy = {
  untitledNote: string;
  untitledMaterial: string;
  untitledCanvas: string;
  canvasSummary: (nodes: number, edges: number) => string;
  missingName: string;
  missingSummary: string;
};

export async function hydrateFavoriteSources(
  itemType: FavoriteItemType,
  favorites: FavoriteItem[],
  publishCore: ((entries: FavoriteShelfEntry[]) => void) | undefined,
  copy: FavoriteSourceCopy,
): Promise<FavoriteShelfEntry[]> {
  if (itemType === "material") return hydrateMaterials(favorites, copy);
  if (itemType === "note") return hydrateNotes(favorites, publishCore, copy);
  return hydrateCanvases(favorites, copy);
}

async function hydrateMaterials(favorites: FavoriteItem[], copy: FavoriteSourceCopy) {
  if (!favorites.length) return [];
  const favoriteIds = favorites.map((favorite) => favorite.itemId);
  const [materialSnapshot, tagsByAssetId] = await Promise.all([
    materialStore.ensureSnapshot({ reason: "favorite-material-shelf" }),
    loadMaterialFavoriteTags(favoriteIds),
  ]);
  const sources = materialSnapshot.allAssets;
  return selectFavoriteSourcesById(favorites, sources)
    .map(({ favorite, source }) => materialEntry(favorite, source, tagsByAssetId[favorite.itemId] || [], copy));
}

async function hydrateNotes(
  favorites: FavoriteItem[],
  publishCore: ((entries: FavoriteShelfEntry[]) => void) | undefined,
  copy: FavoriteSourceCopy,
) {
  if (!favorites.length) return [];
  const snapshot = await knowledgeStore.ensureSnapshot({ reason: "favorite-note-shelf" });
  const vaultId = snapshot.markdownIndex?.vaultId || "";
  const documentById = new Map((snapshot.markdownIndex?.documents || []).map((document) => [
    knowledgeDocumentNoteId({ vaultId, relativePath: document.relativePath }),
    document,
  ]));
  const resolvedFavorites = favorites.map((favorite) => {
    const canonicalIdentity = resolveFavoriteNoteIdentity(favorite.itemId, vaultId);
    const legacyCandidate = canonicalIdentity ? null : resolveFavoriteNoteIdentity(
      favorite.itemId,
      vaultId,
      { allowCurrentVaultLegacy: true },
    );
    const identity = canonicalIdentity || legacyCandidate;
    return {
      favorite,
      identity,
      document: identity ? documentById.get(identity.canonicalId) || null : null,
      sourceConfirmation: legacyCandidate ? "legacy-current-vault" as const : null,
    };
  });
  const coreEntries = resolvedFavorites.map(({ favorite, identity, document, sourceConfirmation }) => {
    if (!identity || !document) return missingEntry(favorite, copy);
    return noteEntry(favorite, identity.canonicalId, vaultId, document, sourceConfirmation, null, copy);
  });
  const hasEmbeds = resolvedFavorites.some(({ document }) => Boolean(document?.embeds.length));
  if (!hasEmbeds) return coreEntries;

  publishCore?.(coreEntries);
  const assets = (await materialStore.ensureSnapshot({ reason: "favorite-note-cover" })).allAssets;
  const resolveAsset = createRealVaultLibraryAssetResolver(assets);

  return resolvedFavorites.map(({ favorite, identity, document, sourceConfirmation }) => {
    if (!identity || !document) return missingEntry(favorite, copy);
    const cover = document.embeds
      .map((embed) => resolveAsset(embed.target || embed.raw || ""))
      .find((asset) => asset?.thumbnailUrl) || null;
    return noteEntry(favorite, identity.canonicalId, vaultId, document, sourceConfirmation, cover?.thumbnailUrl || null, copy);
  });
}

function noteEntry(
  favorite: FavoriteItem,
  sourceId: string,
  vaultId: string,
  document: NonNullable<Awaited<ReturnType<typeof knowledgeStore.ensureSnapshot>>["markdownIndex"]>["documents"][number],
  sourceConfirmation: FavoriteShelfEntry["sourceConfirmation"],
  previewUrl: string | null,
  copy: FavoriteSourceCopy,
): FavoriteShelfEntry {
  return {
    favorite,
    sourceId,
    sourceConfirmation,
    missing: false,
    name: document.title || document.fileName || copy.untitledNote,
    summary: document.excerpt || document.plainText.slice(0, 180),
    sourceUpdatedAt: document.mtime,
    previewKind: "document",
    previewUrl,
    previewPoster: null,
    tags: projectKnowledgeFavoriteTags(vaultId, document.tags),
  };
}

async function hydrateCanvases(favorites: FavoriteItem[], copy: FavoriteSourceCopy) {
  const sources = await (await getLuckyRayBridge()).listCanvases();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return favorites.map((favorite) => canvasEntry(favorite, sourceById.get(favorite.itemId) || null, copy));
}

function materialEntry(
  favorite: FavoriteItem,
  source: MaterialAsset | null,
  tags: FavoriteShelfEntry["tags"],
  copy: FavoriteSourceCopy,
): FavoriteShelfEntry {
  if (!source) return missingEntry(favorite, copy);
  const kind = source.kind.toLocaleLowerCase();
  return {
    favorite,
    sourceId: source.id,
    sourceConfirmation: null,
    missing: false,
    name: source.name || copy.untitledMaterial,
    summary: source.description || "",
    sourceUpdatedAt: source.updatedAt || source.importedAt,
    previewKind: kind === "image" ? "image" : kind === "video" ? "video" : kind === "audio" ? "audio" : "other",
    previewUrl: source.thumbnailUrl || source.previewUrl || null,
    previewPoster: null,
    materialKind: source.kind,
    tags,
  };
}

function canvasEntry(favorite: FavoriteItem, source: CanvasSource | null, copy: FavoriteSourceCopy): FavoriteShelfEntry {
  if (!source) return missingEntry(favorite, copy);
  return {
    favorite,
    sourceId: source.id,
    sourceConfirmation: null,
    missing: false,
    name: source.name || copy.untitledCanvas,
    summary: copy.canvasSummary(source.nodeCount, source.edgeCount),
    sourceUpdatedAt: source.updatedAt,
    previewKind: "canvas",
    previewUrl: source.coverUrl || null,
    previewPoster: source.coverPoster || null,
    tags: [],
  };
}

function missingEntry(favorite: FavoriteItem, copy: FavoriteSourceCopy): FavoriteShelfEntry {
  return {
    favorite,
    sourceId: null,
    sourceConfirmation: null,
    missing: true,
    name: copy.missingName,
    summary: copy.missingSummary,
    sourceUpdatedAt: null,
    previewKind: "other",
    previewUrl: null,
    previewPoster: null,
    tags: [],
  };
}

export function openFavoriteSource(entry: FavoriteShelfEntry, legacyConfirmation: string) {
  if (entry.missing) return;
  if (entry.sourceConfirmation === "legacy-current-vault" && !window.confirm(
    legacyConfirmation,
  )) return;
  if (entry.favorite.itemType === "material") {
    if (!entry.sourceId) return;
    focusEntity("asset", entry.sourceId, { action: "detail", source: "favorites" });
    window.location.hash = "#materials";
    return;
  }
  if (entry.favorite.itemType === "note") {
    if (!entry.sourceId) return;
    focusNote(entry.sourceId);
    return;
  }
  if (entry.sourceId) openCanvasById(entry.sourceId);
}
