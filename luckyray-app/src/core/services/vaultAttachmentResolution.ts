import {
  type AttachmentResolution,
  resolveVaultAttachment,
} from "./vaultAttachments";
import { attachmentErrorMessage } from "./vaultAttachmentErrors";
import {
  attachmentPresentationVersion,
  mergeRecentAttachmentResolutions,
} from "../markdown/realVaultEmbeds";
import type { VaultFileChangeBatch } from "./vaultFileChanges";
import { readActiveKnowledgeWriteSource } from "./knowledgeSource";

export type AttachmentMatch = {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  isFile: boolean;
  matchKind: string;
  version?: string | null;
  materialAssetId?: string | null;
};
export type AttachmentLookup = {
  key: string;
  noteRelativePath: string;
  target: string;
  wiki: boolean;
};
export type AttachmentResolutionBatch = {
  entries: (readonly [string, AttachmentMatch[]])[];
  errors: string[];
  keys: string[];
};

export function attachmentResolutionMatches(
  result: AttachmentResolution,
): AttachmentMatch[] {
  const matches: AttachmentMatch[] = result.candidates.map((relativePath) => ({
    relativePath,
    absolutePath:
      result.relativePath === relativePath ? result.absolutePath || "" : "",
    exists: true,
    isFile: true,
    matchKind: result.status,
    version: result.version,
    materialAssetId: result.status === "resolved" && result.relativePath === relativePath
      ? result.materialAssetId ?? null : null,
  }));
  if (
    result.absolutePath &&
    result.status === "resolved" &&
    !matches.some((match) => match.absolutePath)
  ) {
    matches.splice(0, matches.length, {
      relativePath: result.relativePath || result.absolutePath,
      absolutePath: result.absolutePath,
      exists: true,
      isFile: true,
      matchKind: result.status,
      version: result.version,
      materialAssetId: result.materialAssetId ?? null,
    });
  }
  if (!matches.length && result.status !== "missing")
    matches.push({
      relativePath: "",
      absolutePath: "",
      exists: false,
      isFile: false,
      matchKind: result.status,
    });
  return matches;
}

/** An unavailable read is not a missing attachment and must never replace a
 * successful cache entry. Native identity checks remain the resolution authority. */
export async function resolveAttachmentBatch(
  vaultId: string,
  lookups: AttachmentLookup[],
): Promise<AttachmentResolutionBatch> {
  const results = await Promise.all(
    lookups.map(async (lookup) => {
      try {
        const result = await resolveVaultAttachment(
          { vaultId, relativePath: lookup.noteRelativePath },
          lookup.target,
          lookup.wiki,
        );
        const matches = attachmentResolutionMatches(result);
        return { entry: [lookup.key, matches] as const };
      } catch (cause) {
        return { error: `${lookup.noteRelativePath} · ${lookup.target}: ${attachmentErrorMessage(cause)}` };
      }
    }),
  );
  return {
    keys: lookups.map((lookup) => lookup.key),
    entries: results.flatMap((result) => (result.entry ? [result.entry] : [])),
    errors: [
      ...new Set(
        results.flatMap((result) => (result.error ? [result.error] : [])),
      ),
    ],
  };
}

/**
 * Resolve every lookup, publishing results as they become ready instead of
 * waiting for the slowest target. Each completed lookup is handed to `onBatch`
 * as a delta batch — only that lookup's entry, with `keys` naming the whole
 * batch so `mergeAttachmentBatch` retains already-settled keys from the
 * previous state. Errors are still aggregated once at the end, so a slow
 * failing target cannot flicker partial errors.
 */
export type AttachmentResolver = (
  vaultId: string,
  lookup: AttachmentLookup,
) => Promise<import("./vaultAttachments").AttachmentResolution>;

let resolvingSource = readActiveKnowledgeWriteSource();
const resolving = new Map<string, Promise<AttachmentResolution>>();
export function clearAttachmentResolutionReads() { resolving.clear(); }
const bridgeResolver: AttachmentResolver = (vaultId, lookup) => {
  const source = readActiveKnowledgeWriteSource();
  if (source !== resolvingSource) { resolving.clear(); resolvingSource = source; }
  const key = JSON.stringify([vaultId, lookup.noteRelativePath, lookup.target, lookup.wiki]);
  const existing = resolving.get(key);
  if (existing) return existing;
  const pending = resolveVaultAttachment(
    { vaultId, relativePath: lookup.noteRelativePath },
    lookup.target,
    lookup.wiki,
  ).finally(() => { if (resolving.get(key) === pending) resolving.delete(key); });
  resolving.set(key, pending);
  return pending;
};

export async function resolveAttachmentBatchProgressive(
  vaultId: string,
  lookups: AttachmentLookup[],
  onBatch: (partial: AttachmentResolutionBatch) => void,
  resolveOne: AttachmentResolver = bridgeResolver,
): Promise<AttachmentResolutionBatch> {
  const errors: string[] = [];
  const entries: (readonly [string, AttachmentMatch[]])[] = [];
  const keys = lookups.map((lookup) => lookup.key);
  await Promise.all(lookups.map(async (lookup) => {
    try {
      const result = await resolveOne(vaultId, lookup);
      const matches = attachmentResolutionMatches(result);
      entries.push([lookup.key, matches] as const);
      onBatch({ keys, entries: [[lookup.key, matches] as const], errors: [] });
    } catch (cause) {
      errors.push(`${lookup.noteRelativePath} · ${lookup.target}: ${attachmentErrorMessage(cause)}`);
    }
  }));
  return {
    keys,
    entries,
    errors: [...new Set(errors)],
  };
}

export function mergeAttachmentBatch(
  previous: Record<string, readonly AttachmentMatch[]>,
  result: AttachmentResolutionBatch,
  batch?: VaultFileChangeBatch | null,
) {
  const successful = new Set(result.entries.map(([key]) => key));
  const retained = result.keys
    .filter(
      (key) =>
        !successful.has(key) &&
        Object.prototype.hasOwnProperty.call(previous, key),
    )
    .map((key) => [key, previous[key]] as const);
  return mergeRecentAttachmentResolutions(previous, [
    ...retained,
    ...result.entries.map(
      ([key, matches]) =>
        [
          key,
          matches.map((match) => ({
            ...match,
            version: attachmentPresentationVersion(
              match.version,
              previous[key]?.find(
                (old) => old.relativePath === match.relativePath,
              )?.version,
              match.relativePath,
              batch,
            ),
          })),
        ] as const,
    ),
  ]);
}
