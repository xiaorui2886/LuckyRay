import { getLuckyRayBridge } from "../../core/bridge/luckyRayBridge";
import { listFavoriteItems } from "../../core/services/favorites";
import { knowledgeStore } from "../../core/services/knowledgeStore";
import { materialStore } from "../../core/services/materialStore";
import { listItemTagMap } from "../../core/services/tags";
import type { SmartFolderDefinition } from "../../core/services/smartFolders";
import {
  filterCanvasSmartFolder,
  filterMaterialSmartFolder,
  filterNoteSmartFolder,
  type BuiltInSmartFolderDefinition,
  type SmartFolderResultEntry,
  type SmartFolderResultCopy,
} from "./smartFolderModel";

export async function readSmartFolderResults(
  definition: SmartFolderDefinition | BuiltInSmartFolderDefinition,
  copy?: SmartFolderResultCopy,
): Promise<SmartFolderResultEntry[]> {
  if (definition.source === "material") return readMaterialResults(definition, copy);
  if (definition.source === "note") return readNoteResults(definition, copy);
  return readCanvasResults(definition, copy);
}

async function readMaterialResults(
  definition: SmartFolderDefinition | BuiltInSmartFolderDefinition,
  copy?: SmartFolderResultCopy,
) {
  if (definition.criteria.source !== "material") return [];
  const snapshot = await materialStore.ensureSnapshot({ reason: `smart-folder:${definition.id}` });
  const ids = snapshot.allAssets.map((asset) => asset.id);
  const [tagMap, favorites] = await Promise.all([
    ids.length ? listItemTagMap("asset", ids, { batchOnly: true }) : Promise.resolve({}),
    definition.criteria.favorite === null
      ? Promise.resolve([])
      : listFavoriteItems("material"),
  ]);
  const items = filterMaterialSmartFolder(definition.criteria, definition.sort, snapshot.allAssets, {
    tagMap,
    favoriteIds: new Set(favorites.map((item) => item.itemId)),
    untagged: builtInMode(definition) === "untagged",
    copy,
  });
  return builtInMode(definition) === "recent" ? items.slice(0, 120) : items;
}

async function readNoteResults(
  definition: SmartFolderDefinition | BuiltInSmartFolderDefinition,
  copy?: SmartFolderResultCopy,
) {
  if (definition.criteria.source !== "note") return [];
  const snapshot = await knowledgeStore.ensureSnapshot({ reason: `smart-folder:${definition.id}` });
  if (!snapshot.vault || !snapshot.markdownIndex) return [];
  const favorites = definition.criteria.favorite === null
    ? []
    : await listFavoriteItems("note");
  const items = filterNoteSmartFolder(
    definition.criteria,
    definition.sort,
    snapshot.vault.id,
    snapshot.markdownIndex.documents,
    {
      favoriteIds: new Set(favorites.map((item) => item.itemId)),
      untagged: builtInMode(definition) === "untagged",
      copy,
    },
  );
  return builtInMode(definition) === "recent" ? items.slice(0, 120) : items;
}

async function readCanvasResults(
  definition: SmartFolderDefinition | BuiltInSmartFolderDefinition,
  copy?: SmartFolderResultCopy,
) {
  if (definition.criteria.source !== "canvas") return [];
  const bridge = await getLuckyRayBridge();
  const [canvases, favorites] = await Promise.all([
    bridge.listCanvases(),
    definition.criteria.favorite === null ? Promise.resolve([]) : listFavoriteItems("canvas"),
  ]);
  const items = filterCanvasSmartFolder(definition.criteria, definition.sort, canvases, {
    favoriteIds: new Set(favorites.map((item) => item.itemId)),
    copy,
  });
  return builtInMode(definition) === "recent" ? items.slice(0, 120) : items;
}

function builtInMode(definition: SmartFolderDefinition | BuiltInSmartFolderDefinition) {
  return "builtIn" in definition ? definition.builtInMode : null;
}
