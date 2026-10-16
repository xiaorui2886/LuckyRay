import type { LiveAsset, LiveNoteEmbed } from "./types";
import { splitMarkdownEmbedTarget } from "../../../core/markdown/embedTargets";

export type ParsedAssetEmbed = {
  target: string;
  display: string;
  width: number | null;
  height?: number | null;
};

export type ResolvedAssetEmbed = {
  asset: LiveAsset | null;
  target: string;
  display: string;
  width: number | null;
  height?: number | null;
  missing: boolean;
  resolutionStatus?: string;
};

function normalizeLookup(value: string | null | undefined) {
  return (value || "").normalize("NFC").toLowerCase();
}

function filenameFromPath(value: string | null | undefined) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function assetKindLabel(kind?: string) {
  if (kind === "image") return "图片";
  if (kind === "video") return "视频";
  if (kind === "audio") return "音频";
  if (kind === "document") return "文档";
  return "素材";
}

export function parseAssetEmbedTarget(raw: string): ParsedAssetEmbed {
  const { target, alias } = splitMarkdownEmbedTarget(raw);
  const widthMatch = /^(\d{2,4})(?:x\d{2,4})?$/.exec(alias);
  const width = widthMatch ? Number(widthMatch[1]) : null;
  return {
    target,
    display: width ? target : alias || target,
    width,
  };
}
export function buildAssetLookup(assets: LiveAsset[]) {
  const byId = new Map<string, LiveAsset>();
  const byName = new Map<string, LiveAsset | null>();
  const byFileName = new Map<string, LiveAsset | null>();
  const remember = (map: Map<string, LiveAsset | null>, key: string, asset: LiveAsset) => {
    if (!map.has(key)) map.set(key, asset);
    else if (map.get(key)?.id !== asset.id) map.set(key, null);
  };

  for (const asset of assets) {
    byId.set(asset.id, asset);
    remember(byName, normalizeLookup(asset.name), asset);
    const originalName = filenameFromPath(asset.originalPath);
    const libraryName = filenameFromPath(asset.libraryPath);
    if (originalName) remember(byFileName, normalizeLookup(originalName), asset);
    if (libraryName) remember(byFileName, normalizeLookup(libraryName), asset);
  }

  return { byId, byName, byFileName };
}

export function resolveAssetEmbed(
  rawTarget: string,
  noteEmbeds: LiveNoteEmbed[],
  assets: LiveAsset[],
  syntax: "wiki" | "markdown" = "wiki",
): ResolvedAssetEmbed {
  const parsed = parseAssetEmbedTarget(rawTarget);
  const lookup = buildAssetLookup(assets);
  const key = normalizeLookup(parsed.target);
  const rawKey = syntax === "markdown" ? `md:${rawTarget}` : rawTarget.split("|")[0].trim();
  const exactEmbeds = noteEmbeds.filter((embed) => embed.targetName === rawKey);
  const matchingEmbeds = exactEmbeds.length ? exactEmbeds : noteEmbeds.filter((embed) => !embed.targetName.startsWith("md:") && normalizeLookup(parseAssetEmbedTarget(embed.targetName).target) === key);
  const explicitIds = new Set(matchingEmbeds.filter((embed) => embed.assetId).map((embed) => embed.assetId));
  const explicit = explicitIds.size === 1 ? lookup.byId.get(Array.from(explicitIds)[0]!) : null;
  const named = lookup.byName.get(key);
  const filename = lookup.byFileName.get(key);
  const unresolved = matchingEmbeds.some((embed) => embed.isMissing !== 0 && !embed.assetId);
  const ambiguous = explicitIds.size > 1 || unresolved || named === null || filename === null || (named && filename && named.id !== filename.id);
  const asset = unresolved ? null : explicit || lookup.byId.get(parsed.target) || (ambiguous ? null : named || filename) || null;

  return {
    asset,
    target: parsed.target,
    display: parsed.display,
    width: parsed.width,
    missing: !asset,
    resolutionStatus: asset ? "resolved" : matchingEmbeds.find(embed => embed.resolutionStatus)?.resolutionStatus || (ambiguous ? "ambiguous" : "missing"),
  };
}
