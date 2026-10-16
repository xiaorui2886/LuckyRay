// Issue 118 — media first-open pipeline behavior tests.
//
// These drive the REAL production pieces: the progressive resolver (a slow
// target must not hold back resolved ones), the bounded prefetch scheduler
// (current-note images only, session gate, queue replacement), and the vault
// presentation keeping a catalog thumbnail as the video cover. The per-target
// resolver is injected through the production seam — no second resolver and no
// bridge required.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function resolved(match: { relativePath: string; materialAssetId?: string }) {
  return {
    status: "resolved",
    candidates: [match.relativePath],
    relative_path: match.relativePath,
    absolute_path: `C:/v/${match.relativePath}`,
    fragment: "",
    version: "1-1",
    material_asset_id: match.materialAssetId ?? null,
  };
}

test("progressive resolver publishes each result without waiting for the slowest target", async () => {
  const { resolveAttachmentBatchProgressive } = await import(
    "../src/core/services/vaultAttachmentResolution.ts"
  );
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((r) => { releaseSlow = r; });
  const resolveOne = async (_vaultId: string, lookup: { key: string }) => {
    if (lookup.key === "slow") await slowGate;
    return resolved({ relativePath: `${lookup.key}.png` });
  };

  const batches: Array<string[]> = [];
  const done = resolveAttachmentBatchProgressive(
    "vault",
    [
      { key: "fast", noteRelativePath: "N.md", target: "fast.png", wiki: true },
      { key: "slow", noteRelativePath: "N.md", target: "slow.png", wiki: true },
    ],
    (partial) => { batches.push(partial.entries.map(([key]) => key)); },
    resolveOne as never,
  );

  await new Promise((r) => setTimeout(r, 25));
  assert.ok(
    batches.some((keys) => keys.length === 1 && keys[0] === "fast"),
    "the resolved target publishes as soon as it is ready, before the slowest finishes",
  );
  assert.ok(
    batches.every((keys) => keys.length === 1),
    "each partial batch carries only its own delta, not a growing copy of every settled entry",
  );
  releaseSlow();
  const final = await done;
  assert.deepEqual(final.entries.map(([key]) => key).sort(), ["fast", "slow"]);
  assert.deepEqual(final.keys, ["fast", "slow"]);
  assert.deepEqual(final.errors, []);
});

test("folding delta batches reaches the same state as one full merge", async () => {
  const mod = await import("../src/core/services/vaultAttachmentResolution.ts");
  const lookups = ["a", "b", "c"].map((key) => ({
    key, noteRelativePath: "N.md", target: `${key}.png`, wiki: true,
  }));
  const resolveOne = async (_vaultId: string, lookup: { key: string }) => {
    await new Promise((r) => setTimeout(r, lookup.key === "b" ? 20 : 0));
    return resolved({ relativePath: `${lookup.key}.png` });
  };
  const deltas: Array<Parameters<typeof mod.mergeAttachmentBatch>[1]> = [];
  const final = await mod.resolveAttachmentBatchProgressive(
    "vault", lookups, (partial) => deltas.push(partial), resolveOne as never,
  );
  assert.equal(deltas.length, 3);
  assert.ok(deltas.every((batch) => batch.entries.length === 1), "one entry per completed target");
  let folded: Record<string, readonly mod.AttachmentMatch[]> = {};
  for (const batch of deltas) folded = mod.mergeAttachmentBatch(folded, batch);
  const once = mod.mergeAttachmentBatch({}, final);
  assert.deepEqual(Object.keys(folded).sort(), ["a", "b", "c"]);
  assert.deepEqual(
    Object.entries(once).sort(([a], [b]) => a.localeCompare(b)).map(([key, matches]) =>
      [key, matches.map((match) => match.relativePath)]),
    [["a", ["a.png"]], ["b", ["b.png"]], ["c", ["c.png"]]],
    "settled keys are retained across delta merges exactly as a one-shot merge",
  );
  for (const key of ["a", "b", "c"]) {
    assert.deepEqual(folded[key].map((match) => match.relativePath), [`${key}.png`]);
  }
});

test("progressive resolver aggregates errors once at the end", async () => {
  const { resolveAttachmentBatchProgressive } = await import(
    "../src/core/services/vaultAttachmentResolution.ts"
  );
  const resolveOne = async (_vaultId: string, lookup: { key: string }) => {
    if (lookup.key === "bad") throw new Error("bridge unavailable");
    return resolved({ relativePath: "ok.png" });
  };
  const batches: Array<string[]> = [];
  const final = await resolveAttachmentBatchProgressive(
    "vault",
    [
      { key: "bad", noteRelativePath: "N.md", target: "x.png", wiki: true },
      { key: "ok", noteRelativePath: "N.md", target: "ok.png", wiki: true },
    ],
    (partial) => { batches.push(partial.entries.map(([key]) => key)); },
    resolveOne as never,
  );
  assert.equal(final.entries.length, 1, "the healthy target still resolves");
  assert.equal(final.errors.length, 1);
  assert.equal(final.errors.length, 1, "the failed target reports exactly one aggregated error");
  assert.ok(batches.every((keys) => keys.length <= 1), "no partial batch claims the failed key");
});

test("the prefetch scheduler is bounded, image-only and replaced by the newest note", async () => {
  const mod = await import("../src/features/notes/media/attachmentPrefetch.ts");
  const warmed: string[] = [];
  mod.setAttachmentWarmFunction(async (url: string) => {
    warmed.push(url);
    return true;
  });

  const gated: Array<{ url: string; kind: string }>[] = [];
  let current = true;
  const gateOf = () => current;
  void gated;
  mod.scheduleAttachmentPrefetch(
    [
      ...Array.from({ length: 40 }, (_, i) => ({ url: `asset://n1/i${i}.png`, kind: "image" })),
      { url: "asset://n1/v.mp4", kind: "video" },
      { url: "", kind: "image" },
    ],
    gateOf,
  );
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(
    warmed.every((url) => url.startsWith("asset://n1/i")),
    "videos and empty URLs are never warmed",
  );
  assert.ok(warmed.length <= 12, "the queue is capped");
  const firstWave = warmed.length;
  assert.ok(firstWave > 0, "work starts while the gate holds");

  // A newer schedule replaces the queue entirely.
  warmed.length = 0;
  mod.scheduleAttachmentPrefetch([{ url: "asset://n2/only.png", kind: "image" }], gateOf);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(warmed, ["asset://n2/only.png"], "the newest schedule replaces pending work");

  // The gate stops further warms when the session is stale.
  warmed.length = 0;
  current = false;
  mod.scheduleAttachmentPrefetch(
    Array.from({ length: 5 }, (_, i) => ({ url: `asset://n3/x${i}.png`, kind: "image" })),
    gateOf,
  );
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(warmed.length, 0, "a stale session warms nothing");
});

test("NotesPage wires prefetch, progressive resolution and catalog video covers", async () => {
  const notesPage = await read("src/features/notes/NotesPage.tsx");
  assert.ok(
    notesPage.includes("scheduleAttachmentPrefetch("),
    "the current note's assets are scheduled for prefetch",
  );
  assert.ok(
    notesPage.includes("prepareNoteMediaRef.current(realNoteId)") && notesPage.includes("lookups.slice(0, 12)"),
    "selection prepares a bounded batch from the selected note",
  );
  assert.ok(
    notesPage.includes("vaultSessionRef.current.isCurrent(session)"),
    "prefetch stops when the vault session becomes stale",
  );
  assert.ok(
    notesPage.includes("thumbnailUrl: libraryAsset?.thumbnailUrl || publishedAsset?.thumbnailUrl || previewUrl"),
    "a catalog thumbnail survives as the video cover instead of being overwritten",
  );

  const hook = await read("src/features/notes/useVaultAttachmentResolution.ts");
  assert.ok(
    hook.includes("resolveAttachmentBatchProgressive("),
    "attachment resolution publishes progressively",
  );
  assert.ok(
    !hook.includes("Promise.all("),
    "no Promise.all barrier holds resolved targets behind the slowest one",
  );
});
