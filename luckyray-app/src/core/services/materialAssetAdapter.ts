import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

/** Catalog paths remain physical paths; only presentation fields become WebView URLs. */
export type MaterialMedia = {
  kind: string;
  storageMode?: string;
  originalPath?: string | null;
  libraryPath?: string | null;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
};

type MediaRuntime = { native: boolean; fileUrl: (path: string) => string };
const runtime = (): MediaRuntime => ({ native: isTauri(), fileUrl: convertFileSrc });
const isMediaUrl = (value: string) => /^(?:https?:\/\/|asset:|blob:|data:)/i.test(value);

type MaterialFilePaths = Pick<MaterialMedia, "storageMode" | "originalPath" | "libraryPath">;

export function materialAssetPhysicalPath(asset: MaterialFilePaths): string | null {
  return (asset.storageMode === "linked" ? asset.originalPath : asset.libraryPath || asset.originalPath) || null;
}

export function derivePreviewUrl(
  kind: string,
  libraryPath: string | null | undefined,
  thumbnailUrl: string | null | undefined,
  environment: MediaRuntime = runtime(),
): string {
  const path = thumbnailUrl || libraryPath;
  if (!path) return "";
  if (isMediaUrl(path)) return path;
  if (!environment.native) return thumbnailUrl || "";
  return kind === "image" || kind === "video" ? environment.fileUrl(path) : "";
}

export function adaptMaterialAssetMedia<T extends MaterialMedia>(asset: T, environment: MediaRuntime = runtime()): T & { thumbnailUrl: string; previewUrl: string } {
  const physicalPath = materialAssetPhysicalPath(asset);
  return {
    ...asset,
    // A video file is playable media, never an image thumbnail.
    thumbnailUrl: derivePreviewUrl(asset.kind, asset.kind === "image" ? physicalPath : null, asset.thumbnailUrl, environment),
    previewUrl: derivePreviewUrl(asset.kind, physicalPath, asset.previewUrl, environment),
  };
}
