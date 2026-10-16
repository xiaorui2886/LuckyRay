// Bounded attachment prefetch for the notes editor (Issue 118).
//
// Once an embed's URL is resolved, its bytes are fetched and decoded through
// the SAME shared pool the mounted widget uses (`warmRecentImage`), so the
// widget's `takeRecentImage` finds an already-decoded element and paints with
// no visible loading state. There is no second read/decode pipeline.
//
// Bounds (per current note):
//   - only image-kind URLs (video originals are never prefetched; a catalog
//     thumbnail is itself an image and may be warmed),
//   - at most MAX_QUEUE per schedule call, in the caller's priority order,
//   - at most MAX_INFLIGHT concurrent decodes,
//   - a new schedule call replaces the queue: fast note switching leaves the
//     old note's work behind, and each item re-validates `isCurrent` before
//     starting, so stale sessions (vault switch, note switch) stop early.
// The pool itself additionally evicts by element count and decoded pixels.

export type AttachmentPrefetchEntry = {
  url: string;
  kind: string;
};

export type AttachmentPrefetchGate = () => boolean;

const MAX_QUEUE = 12;
const MAX_INFLIGHT = 4;

let queue: AttachmentPrefetchEntry[] = [];
let inflight = 0;
const inflightUrls = new Set<string>();
let gate: AttachmentPrefetchGate = () => true;
let generation = 0;

export type AttachmentWarm = (url: string) => Promise<boolean>;

const poolWarm: AttachmentWarm = async (url) => {
  const { warmRecentImage } = await import("./noteImageResources");
  return warmRecentImage(url);
};

let warmImpl: AttachmentWarm = poolWarm;

/** Test/production seam for the shared decoded-image pool. */
export function setAttachmentWarmFunction(next: AttachmentWarm): void {
  warmImpl = next;
}

export function scheduleAttachmentPrefetch(
  entries: AttachmentPrefetchEntry[],
  isCurrent: AttachmentPrefetchGate,
): void {
  // The newest note owns the scheduler: replace pending work and the gate.
  generation += 1;
  gate = isCurrent;
  queue = entries
    .filter((entry) => entry.url && entry.kind.toLowerCase() === "image")
    .filter((entry, index, all) => !inflightUrls.has(entry.url) && all.findIndex((item) => item.url === entry.url) === index)
    .slice(0, MAX_QUEUE);
  pump();
}

function pump(): void {
  while (inflight < MAX_INFLIGHT && queue.length) {
    const entry = queue.shift();
    if (!entry) break;
    if (!gate()) { queue = []; return; }
    inflight += 1;
    inflightUrls.add(entry.url);
    const ticket = generation;
    void warm(entry, ticket);
  }
}

async function warm(entry: AttachmentPrefetchEntry, ticket: number): Promise<void> {
  try {
    if (ticket === generation && gate()) {
      await warmImpl(entry.url);
    }
  } catch {
    // Prefetch is best effort: a failed warm leaves nothing pooled and the
    // widget falls back to its normal load path.
  } finally {
    inflight = Math.max(0, inflight - 1);
    inflightUrls.delete(entry.url);
    // A slot belongs to the scheduler, not to the generation that occupied it.
    // pump reads only the current queue/gate; obsolete work cannot revive itself.
    pump();
  }
}
