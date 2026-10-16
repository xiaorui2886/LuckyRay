import { useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import {
  mergeAttachmentBatch,
  resolveAttachmentBatchProgressive,
  type AttachmentLookup,
  type AttachmentMatch,
} from "../../core/services/vaultAttachmentResolution";
import { markdownContentChanges, type VaultFileChangeBatch } from "../../core/services/vaultFileChanges";
import { attachmentErrorMessage } from "../../core/services/vaultAttachmentErrors";

export function useVaultAttachmentResolution(options: {
  vault: { id: string; rootPath: string } | null;
  lookups: AttachmentLookup[];
  batch?: VaultFileChangeBatch | null;
  recheck: number;
  setMatches: Dispatch<SetStateAction<Record<string, readonly AttachmentMatch[]>>>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const { vault, lookups, batch, recheck, setMatches, setError } = options;
  const source = readActiveKnowledgeWriteSource();
  const vaultId = vault?.id, rootPath = vault?.rootPath;
  // Index snapshots contain new objects (and different line numbers) after a
  // save. Resolution depends on destination semantics, not those identities.
  const lookupKey = JSON.stringify([...new Map(lookups.map(item => [item.key, item])).values()]
    .map(({ key, noteRelativePath, target, wiki }) => ({ key, noteRelativePath, target, wiki }))
    .sort((a, b) => a.key.localeCompare(b.key)));
  const stableLookups: AttachmentLookup[] = useMemo(() => JSON.parse(lookupKey), [lookupKey]);
  const observations = useRef<{ source: typeof source; seen: typeof batch; relevant: typeof batch; revision: number }>({ source, seen: null, relevant: null, revision: 0 });
  if (observations.current.source !== source) observations.current = { source, seen: null, relevant: null, revision: 0 };
  if (batch !== observations.current.seen) {
    observations.current.seen = batch;
    if (batch && batch.vaultId === vaultId && batch.rootPath === rootPath
      && (!markdownContentChanges(batch) || stableLookups.some(item => /\.md(?:#|$)/i.test(item.target)))) {
      observations.current.relevant = batch;
      observations.current.revision++;
    }
  }
  const revision = observations.current.revision;
  useEffect(() => { setMatches({}); setError(""); }, [source, vaultId, rootPath, setMatches, setError]);
  useEffect(() => {
    if (!vaultId || !source || source.vaultId !== vaultId) return;
    if (!stableLookups.length) { setError(""); return; }
    let cancelled = false;
    const relevantBatch = observations.current.relevant;
    // Progressive publishing: every resolved target becomes visible in its own
    // coalesced merge, so one slow or stuck target cannot hold back the rest
    // of the note. Deltas landing in the same tick are buffered (never
    // dropped), and state flushes are spaced at least FLUSH_MIN_INTERVAL_MS
    // apart — a resolution burst must not recompute the presentation once per
    // animation frame while the user is dragging. The final result below
    // bypasses the interval, so the completed state always lands immediately.
    const FLUSH_MIN_INTERVAL_MS = 64;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    let pending: Parameters<typeof mergeAttachmentBatch>[1] | null = null;
    let lastFlush = 0;
    const commit = () => {
      frame = 0;
      timer = 0;
      if (cancelled || source !== readActiveKnowledgeWriteSource()) { pending = null; return; }
      if (!pending) return;
      const batch = pending;
      pending = null;
      lastFlush = Date.now();
      setMatches(previous => mergeAttachmentBatch(previous, batch, relevantBatch));
    };
    const flush = (partial: Parameters<typeof mergeAttachmentBatch>[1]) => {
      if (cancelled || source !== readActiveKnowledgeWriteSource()) return;
      pending = pending
        ? { keys: partial.keys, entries: [...pending.entries, ...partial.entries], errors: [] }
        : partial;
      if (frame || timer) return;
      const wait = FLUSH_MIN_INTERVAL_MS - (Date.now() - lastFlush);
      if (wait > 0) timer = setTimeout(() => { timer = 0; frame = requestAnimationFrame(commit); }, wait);
      else frame = requestAnimationFrame(commit);
    };
    const cancelScheduled = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (timer) { clearTimeout(timer); timer = 0; }
      pending = null;
    };
    void resolveAttachmentBatchProgressive(vaultId, stableLookups, flush).then(result => {
      cancelScheduled();
      if (cancelled || source !== readActiveKnowledgeWriteSource()) return;
      setError(result.errors.join(" "));
      setMatches(previous => mergeAttachmentBatch(previous, result, relevantBatch));
    }).catch(cause => {
      cancelScheduled();
      if (!cancelled && source === readActiveKnowledgeWriteSource()) setError(attachmentErrorMessage(cause));
    });
    return () => {
      cancelled = true;
      cancelScheduled();
    };
  }, [source, vaultId, rootPath, stableLookups, revision, recheck, setMatches, setError]);
}
