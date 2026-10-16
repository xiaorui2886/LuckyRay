export function shouldDismissMaterialViewerFromBlank(
  mode: "preview" | "detail",
  currentTarget: unknown,
  target: unknown,
) {
  return mode === "detail" && currentTarget === target;
}

export type MaterialMediaDimensions = {
  width: number;
  height: number;
};

export function resolveContainedMaterialMediaRect(
  available: MaterialMediaDimensions,
  intrinsic: MaterialMediaDimensions,
): MaterialMediaDimensions {
  if (available.width <= 0 || available.height <= 0 || intrinsic.width <= 0 || intrinsic.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(available.width / intrinsic.width, available.height / intrinsic.height);
  return { width: intrinsic.width * scale, height: intrinsic.height * scale };
}

export type MaterialMediaDimensionsSnapshot = MaterialMediaDimensions & {
  assetId: string;
  sourceUrl: string;
  sourceIdentity: string;
};

export type MaterialVideoSourceSnapshot = {
  assetId: string;
  sourceIdentity: string;
  url: string;
};

export type MaterialVideoPlaybackCandidate = {
  libraryPath?: string | null;
  originalPath?: string | null;
};

export function resolveMaterialVideoPlaybackPath(asset: MaterialVideoPlaybackCandidate): string {
  const libraryPath = asset.libraryPath?.trim();
  if (libraryPath) return libraryPath;
  return asset.originalPath?.trim() || "";
}

export function resolveMaterialMediaDimensions(
  snapshot: MaterialMediaDimensionsSnapshot | null,
  assetId: string,
  sourceUrl: string,
  sourceIdentity: string,
): MaterialMediaDimensions | null {
  if (
    !snapshot
    || snapshot.assetId !== assetId
    || snapshot.sourceUrl !== sourceUrl
    || snapshot.sourceIdentity !== sourceIdentity
  ) return null;
  return { width: snapshot.width, height: snapshot.height };
}

export function resolveMaterialVideoSource(
  snapshot: MaterialVideoSourceSnapshot | null,
  assetId: string,
  sourceIdentity: string,
): string {
  if (!snapshot || snapshot.assetId !== assetId || snapshot.sourceIdentity !== sourceIdentity) return "";
  return snapshot.url;
}
