import type { Folder } from "../folders/useFolders";

export type MaterialFolderRevealRequest = {
  folderId: string | null;
  ancestorIds: string[];
  nonce: number;
  status: "folder" | "all" | "missing";
};

function findFolderPath(folders: readonly Folder[], targetId: string, ancestors: string[] = []): string[] | null {
  for (const folder of folders) {
    if (folder.id === targetId) return [...ancestors, folder.id];
    const nested = findFolderPath(folder.children || [], targetId, [...ancestors, folder.id]);
    if (nested) return nested;
  }
  return null;
}

export function buildMaterialFolderRevealRequest(
  folders: readonly Folder[],
  assetFolderId: string | null | undefined,
  nonce: number,
): MaterialFolderRevealRequest {
  if (!assetFolderId) return { folderId: null, ancestorIds: [], nonce, status: "all" };
  const path = findFolderPath(folders, assetFolderId);
  if (!path) return { folderId: null, ancestorIds: [], nonce, status: "missing" };
  return { folderId: assetFolderId, ancestorIds: path.slice(0, -1), nonce, status: "folder" };
}

export function resolveCurrentMaterialFolderReveal<T extends { id: string; folderId?: string | null }>(
  assets: readonly T[],
  folders: readonly Folder[],
  assetId: string,
  nonce: number,
): { asset: T; request: MaterialFolderRevealRequest } | null {
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (!asset) return null;
  return {
    asset,
    request: buildMaterialFolderRevealRequest(folders, asset.folderId, nonce),
  };
}

export function freezeMaterialContextAsset<T extends object>(asset: T): T {
  return Object.freeze({ ...asset }) as T;
}

export type MaterialContextActionSession<T extends { id: string }> = Readonly<{
  sessionId: number;
  assetId: string;
  asset: T;
}>;

export function createMaterialContextActionAuthority() {
  let nextSessionId = 0;
  let activeSessionId: number | null = null;
  let activeAssetId: string | null = null;

  return {
    begin<T extends { id: string }>(asset: T): MaterialContextActionSession<T> {
      nextSessionId += 1;
      activeSessionId = nextSessionId;
      const frozenAsset = freezeMaterialContextAsset(asset);
      activeAssetId = frozenAsset.id;
      return Object.freeze({
        sessionId: nextSessionId,
        assetId: frozenAsset.id,
        asset: frozenAsset,
      });
    },
    resolve<T extends { id: string }>(sessionId: number, assets: readonly T[]): T | null {
      if (sessionId !== activeSessionId || !activeAssetId) return null;
      return assets.find((asset) => asset.id === activeAssetId) || null;
    },
    isActive(sessionId: number): boolean {
      return sessionId === activeSessionId;
    },
    retire(sessionId: number): void {
      if (sessionId === activeSessionId) {
        activeSessionId = null;
        activeAssetId = null;
      }
    },
  };
}
