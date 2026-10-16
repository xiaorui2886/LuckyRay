import { normalizeMarkdownEmbedTarget } from "./embedTargets";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { normalizeVaultRelativePath, normalizeWikiLinkKey, parseWikiReferenceTarget } from "./wikiTargets";

export type RealVaultLibraryAssetLike = {
  id: string;
  name: string;
  originalPath?: string | null;
  libraryPath?: string | null;
};

export type StandardMarkdownReference = { from: number; to: number; target: string; label: string; embedded: boolean; local: boolean; width: number | null; height?: number | null };

/** Vault publication writes videos as portable file links; standalone videos retain their media card. */
export function isStandaloneVideoReference(source: string, reference: StandardMarkdownReference) {
  if (!reference.local || reference.embedded || !/\.(mp4|mov|avi|mkv|webm)(?:[#?]|$)/i.test(reference.target)) return false;
  const start = source.lastIndexOf("\n", reference.from - 1) + 1;
  const nextBreak = source.indexOf("\n", reference.to);
  const end = nextBreak < 0 ? source.length : nextBreak;
  return !source.slice(start, reference.from).trim() && !source.slice(reference.to, end).trim();
}

/** Display-only source ranges from the existing editor parser. Rust remains the
 * authority for URI decoding, file resolution and any source mutation. */
export function standardMarkdownReferences(source: string): StandardMarkdownReference[] {
  const references: StandardMarkdownReference[] = [];
  markdownLanguage.parser.parse(source).iterate({ enter(node) {
    if (node.name !== "Image" && node.name !== "Link") return;
    const url = node.node.getChild("URL");
    if (!url) return false; // Shared reference definitions are left as authored.
    const embedded = node.name === "Image";
    const marks = node.node.getChildren("LinkMark");
    const close = marks.find((mark) => source.slice(mark.from, mark.to) === "]");
    const label = source.slice(node.from + (embedded ? 2 : 1), close?.from ?? node.from);
    let target = source.slice(url.from, url.to);
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    const titleNode = node.node.getChild("LinkTitle");
    const title = titleNode ? source.slice(titleNode.from + 1, titleNode.to - 1) : "";
    const dimensions = /^width=([1-9]\d{0,5})(?: height=([1-9]\d{0,5}))?$/.exec(title);
    const validDimensions = dimensions && Number(dimensions[1]) <= 100000 && (!dimensions[2] || Number(dimensions[2]) <= 100000) ? dimensions : null;
    const widthMatch = /\|(\d{1,4})(?:x\d{1,4})?$/.exec(label);
    // This classifies display candidates only. Native resolution still validates
    // exact registered files before any local or external path can be read.
    const localFile = /^file:\/\//i.test(target) || /^[a-z]:[\\/]/i.test(target);
    const local = Boolean(target) && (localFile || !/^(?:[a-z][a-z0-9+.-]*:|#|~)/i.test(target)) && !/\.md(?:#|$)/i.test(target);
    references.push({ from: node.from, to: node.to, target, label, embedded, local, width: widthMatch ? Number(widthMatch[1]) : local && embedded && validDimensions ? Number(validDimensions[1]) : null, height: local && embedded && validDimensions?.[2] ? Number(validDimensions[2]) : null });
    return false;
  } });
  return references;
}

function realVaultParentPath(relativePath?: string | null) {
  const normalized = normalizeVaultRelativePath(relativePath);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : "";
}

export function isSafeRealVaultAssetRelativePath(value?: string | null) {
  const normalized = normalizeVaultRelativePath(value);
  if (!normalized || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//")) return false;
  return normalized.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".luckyray");
}

export function decodeRealVaultEmbedTarget(target: string) {
  return normalizeMarkdownEmbedTarget(target);
}

export function realVaultEmbedAssetLookupKey(currentRelativePath: string, target: string) {
  return `${normalizeVaultRelativePath(currentRelativePath)}::${decodeRealVaultEmbedTarget(target)}`;
}

export function realVaultAssetFileName(relativePath?: string | null) {
  return normalizeVaultRelativePath(relativePath).split("/").pop() || relativePath || "素材";
}

function realVaultAssetPathFileName(value?: string | null) {
  const normalized = normalizeMarkdownEmbedTarget(value).replace(/\\/g, "/").trim();
  if (!normalized) return "";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function realVaultAssetMatchesPath(value: string | null | undefined, targetPathKey: string) {
  const normalized = normalizeWikiLinkKey(normalizeVaultRelativePath(value));
  return Boolean(normalized && targetPathKey && normalized === targetPathKey);
}

/** Keeps graph and editor embed matching on one real-vault lookup path. */
export function createRealVaultLibraryAssetResolver<T extends RealVaultLibraryAssetLike>(assets: readonly T[]) {
  const directMatches = new Map<string, Set<T>>();
  const pathEntries: Array<{ asset: T; originalPath: string; libraryPath: string }> = [];
  const remember = (key: string, asset: T) => {
    const normalized = normalizeWikiLinkKey(key);
    if (!normalized) return;
    const matches = directMatches.get(normalized) || new Set<T>();
    matches.add(asset);
    directMatches.set(normalized, matches);
  };

  for (const asset of assets) {
    const originalPath = normalizeVaultRelativePath(asset.originalPath);
    const libraryPath = normalizeVaultRelativePath(asset.libraryPath);
    remember(asset.id, asset);
    remember(asset.name, asset);
    remember(realVaultAssetPathFileName(asset.originalPath), asset);
    remember(realVaultAssetPathFileName(asset.libraryPath), asset);
    remember(originalPath, asset);
    remember(libraryPath, asset);
    pathEntries.push({ asset, originalPath, libraryPath });
  }

  return (target: string): T | null => {
    const parsed = parseWikiReferenceTarget(target);
    const decodedTarget = decodeRealVaultEmbedTarget(parsed.targetTitle || target);
    const targetKey = normalizeWikiLinkKey(decodedTarget);
    const targetPathKey = normalizeWikiLinkKey(normalizeVaultRelativePath(decodedTarget));
    const targetFileKey = normalizeWikiLinkKey(realVaultAssetPathFileName(decodedTarget));
    if (!targetKey) return null;
    const explicitId = assets.find((asset) => asset.id === decodedTarget);
    if (explicitId) return explicitId;

    const matches = new Set<T>();
    const keys = decodedTarget.includes("/") || decodedTarget.includes("\\") ? [targetKey, targetPathKey] : [targetKey, targetPathKey, targetFileKey];
    for (const key of keys) {
      for (const asset of directMatches.get(key) || []) matches.add(asset);
    }
    for (const { asset, originalPath, libraryPath } of pathEntries) {
      if (realVaultAssetMatchesPath(originalPath, targetPathKey)
        || realVaultAssetMatchesPath(libraryPath, targetPathKey)) {
        matches.add(asset);
      }
    }
    return matches.size === 1 ? Array.from(matches)[0] : null;
  };
}

export function resolveRealVaultEmbedAssetRelativePath(target: string, currentRelativePath: string) {
  const parsed = parseWikiReferenceTarget(target);
  const decodedTarget = decodeRealVaultEmbedTarget(parsed.targetTitle || target).replace(/^\.\//, "");
  if (!decodedTarget || /^(?:[A-Za-z]:|[\\/]+|~)/.test(decodedTarget)) return null;
  const rawTarget = normalizeVaultRelativePath(decodedTarget);
  if (!rawTarget) return null;
  const parentPath = realVaultParentPath(currentRelativePath);
  const targetRelativePath = rawTarget.includes("/")
    ? rawTarget
    : normalizeVaultRelativePath([parentPath, rawTarget].filter(Boolean).join("/"));
  return isSafeRealVaultAssetRelativePath(targetRelativePath) ? targetRelativePath : null;
}

/** Bounded recent resolution results: keep returning notes stable while their
 * current native resolution is revalidated. Keys include Vault/root identity. */
export function mergeRecentAttachmentResolutions<T>(previous: Record<string, T>, entries: readonly (readonly [string, T])[], limit = 128): Record<string, T> {
  const next = new Map(Object.entries(previous));
  for (const [key, value] of entries) { next.delete(key); next.set(key, value); }
  // The active batch is the current document's working set, not history.
  // Never evict an image that is still displayed merely to cap old results.
  const capacity = Math.max(limit, new Set(entries.map(([key]) => key)).size);
  while (next.size > capacity) next.delete(next.keys().next().value!);
  return Object.fromEntries(next);
}

/** Watch freshness is separate from file identity. Unrelated events retain the
 * existing URL, including after a same-size write with preserved timestamps. */
export function attachmentPresentationVersion(
  nativeVersion: string | null | undefined,
  previousVersion: string | null | undefined,
  relativePath: string,
  batch?: import('../services/vaultFileChanges').VaultFileChangeBatch | null,
) {
  const base = nativeVersion || '';
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/$/, '').toLocaleLowerCase();
  const path = normalize(relativePath);
  const root = batch ? normalize(batch.rootPath) : '';
  const affected = batch && (batch.reconcileRequired || batch.observations.some(event => event.paths.some(value => {
    let changed = normalize(value);
    if (changed === root) return true;
    if (changed.startsWith(root + '/')) changed = changed.slice(root.length + 1);
    return changed === path || path.startsWith(changed + '/');
  })));
  if (affected) return `${base}~watch:${batch.session}:${batch.generation}`;
  return previousVersion?.split('~watch:')[0] === base ? previousVersion : base;
}

export function refreshRecentAttachmentVersions<T extends {relativePath: string; version?: string | null}>(
  previous: Record<string, readonly T[]>, batch: import('../services/vaultFileChanges').VaultFileChangeBatch,
): Record<string, readonly T[]> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(previous).map(([key, matches]) => [key, matches.map(match => {
    const version = attachmentPresentationVersion(match.version?.split('~watch:')[0], match.version, match.relativePath, batch);
    if (version === match.version) return match;
    changed = true;
    return {...match, version};
  })]));
  return changed ? next : previous;
}
