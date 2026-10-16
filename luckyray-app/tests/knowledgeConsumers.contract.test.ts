import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

import type { BridgeNotesVaultMarkdownIndex } from "../src/App.tsx";
import { createRealVaultLibraryAssetResolver } from "../src/core/markdown/realVaultEmbeds.ts";
import {
  buildRealVaultGraphSeed,
  updateRealVaultGraphTagRelation,
} from "../src/core/services/graph.ts";
import {
  knowledgeDocumentNoteId,
  knowledgeMutationSuccessStatus,
  knowledgeTagIdentity,
  parseKnowledgeTagIdentity,
  parseKnowledgeDocumentNoteId,
  type KnowledgeIndexSnapshot,
  type KnowledgeMutationResult,
} from "../src/core/services/knowledge.ts";
import { adaptKnowledgeIndexToLegacy, attachmentIndexSignature, hasUsableKnowledgeSnapshot, KnowledgeStore, loadKnowledgeStoreData, type KnowledgeStoreLoadResult } from "../src/core/services/knowledgeStore.ts";
import {
  insertMaterialAssetIntoCurrentKnowledge,
  resolveMaterialKnowledgeLinkedNotes,
} from "../src/core/services/materials.ts";
import {
  buildRealVaultTagsFromKnowledge,
  createCoalescedTagRefresh,
  groupKnowledgeIndexTags,
  mergeTagSources,
  removeKnowledgeTagFromDocument,
  reuseSemanticallyEqualTags,
} from "../src/features/tags/useTags.ts";

function indexSnapshot(vaultId = "vault-a"): KnowledgeIndexSnapshot {
  return {
    vaultId,
    generation: 7,
    builtAt: "2026-07-15T00:00:00.000Z",
    version: 11,
    changedPaths: ["Inbox/A.md"],
    removedPaths: [],
    stale: false,
    refreshError: null,
    errors: [],
    documents: [{
      documentRef: { vaultId, relativePath: "Inbox/A.md" },
      relativePath: "Inbox/A.md",
      fileName: "A.md",
      title: "A",
      revision: "rev-a",
      headings: [],
      wikiLinks: [{ raw: "[[B]]", target: "B", alias: null, line: 1 }],
      embeds: [{ raw: "![[hero.png]]", target: "hero.png", kind: null, line: 2 }],
      tags: ["alpha"],
      frontmatterTags: ["alpha"],
      inlineTags: [],
      plainText: "A",
      excerpt: "A excerpt",
      contentLength: 1,
      modifiedAt: "2026-07-15T00:00:00.000Z",
      size: 1,
    }],
  };
}

test("Knowledge bootstrap blocks only until the store has usable data", () => {
  assert.equal(hasUsableKnowledgeSnapshot({ loaded: false }), false);
  assert.equal(hasUsableKnowledgeSnapshot({ loaded: true }), true);

  for (const status of ["refreshing", "error"] as const) {
    const cachedSnapshot = { loaded: true, status };
    assert.equal(hasUsableKnowledgeSnapshot(cachedSnapshot), true, `cached ${status} content remains usable`);
  }
});

async function loadCommunityModule() {
  const server = await createServer({ appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    return await server.ssrLoadModule("/src/features/community/CommunityPage.tsx") as typeof import("../src/features/community/CommunityPage.tsx");
  } finally {
    await server.close();
  }
}

async function loadTagDetailModel() {
  const server = await createServer({ appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    return await server.ssrLoadModule("/src/features/tags/tagDetailModel.ts") as typeof import("../src/features/tags/tagDetailModel.ts");
  } finally {
    await server.close();
  }
}

async function loadTagGalleryModel() {
  const server = await createServer({ appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    return await server.ssrLoadModule("/src/features/tags/tagGalleryModel.ts") as typeof import("../src/features/tags/tagGalleryModel.ts");
  } finally {
    await server.close();
  }
}

test("Knowledge index adapter preserves backend identity, freshness, and document metadata", () => {
  const adapted = adaptKnowledgeIndexToLegacy(indexSnapshot(), "C:/trusted/vault");
  assert.equal(adapted.vaultId, "vault-a");
  assert.equal(adapted.generation, 7);
  assert.equal(adapted.stale, false);
  assert.equal(adapted.documents[0].revision, "rev-a");
  assert.deepEqual(adapted.documents[0].frontmatterTags, ["alpha"]);
  assert.deepEqual(adapted.changedPaths, ["Inbox/A.md"]);
});

test("Tags coalesces overlapping refresh I/O and derives every tag group from one index snapshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let refreshCalls = 0;
  let revision = "vault-a:1";
  const refresh = createCoalescedTagRefresh(async (requested) => {
    refreshCalls += 1;
    const startedRevision = revision;
    await gate;
    return { revision: startedRevision, explicitEpoch: requested.explicitEpoch };
  }, () => revision);

  const first = refresh();
  const duplicate = refresh();
  assert.equal(first, duplicate);
  assert.equal(refreshCalls, 1);
  revision = "vault-b:2";
  const sourceChanged = refresh();
  assert.equal(first, sourceChanged);
  release();
  await Promise.all([first, duplicate, sourceChanged]);
  assert.equal(refreshCalls, 2);
  await refresh({ explicit: true });
  assert.equal(refreshCalls, 3);

  let retryCalls = 0;
  const retryable = createCoalescedTagRefresh(async (requested) => {
    retryCalls += 1;
    if (retryCalls === 1) throw new Error("fixture-refresh-failed");
    return requested;
  }, () => "vault-a:retry");
  await assert.rejects(retryable(), /fixture-refresh-failed/);
  await retryable();
  assert.equal(retryCalls, 2);

  let stalledCalls = 0;
  const stalled = createCoalescedTagRefresh(async () => {
    stalledCalls += 1;
    return null;
  }, () => "vault-a:stalled");
  await assert.rejects(stalled(), /tags-refresh-not-converged/);
  assert.equal(stalledCalls, 3);
  await assert.rejects(stalled(), /tags-refresh-not-converged/);
  assert.equal(stalledCalls, 6);

  const snapshot = indexSnapshot();
  snapshot.documents.push({
    ...snapshot.documents[0],
    documentRef: { vaultId: snapshot.vaultId, relativePath: "Inbox/B.md" },
    relativePath: "Inbox/B.md",
    fileName: "B.md",
    title: "B",
    revision: "rev-b",
    tags: ["Alpha", "beta", "beta"],
    frontmatterTags: ["Alpha", "beta"],
  });
  const grouped = groupKnowledgeIndexTags(snapshot);
  assert.deepEqual(grouped.summaries, [
    { name: "alpha", documentCount: 2 },
    { name: "beta", documentCount: 1 },
  ]);
  assert.deepEqual(
    grouped.documentsByTag.get("alpha")?.map((document) => document.relativePath),
    ["Inbox/A.md", "Inbox/B.md"],
  );
  assert.deepEqual(
    grouped.documentsByTag.get("beta")?.map((document) => document.relativePath),
    ["Inbox/B.md"],
  );
});

test("real Vault store loading invokes the backend Knowledge index and never the legacy WebView index", async () => {
  let knowledgeCalls = 0;
  let legacyIndexCalls = 0;
  const bridge = {
    getCurrentNotesVault: async () => ({ id: "vault-a", name: "A", rootPath: "C:/trusted/vault", openedAt: "now" }),
    listNotesVaultFiles: async () => ({ name: "A", relativePath: "", absolutePath: "C:/trusted/vault", kind: "folder", children: [] }),
    listNotes: async () => { throw new Error("DB notes must not load"); },
    getNotesVaultMarkdownIndex: async () => { legacyIndexCalls += 1; throw new Error("legacy index must not load"); },
  };
  const loaded = await loadKnowledgeStoreData(bridge as never, async () => {
    knowledgeCalls += 1;
    return indexSnapshot();
  }, () => true);
  assert.equal(loaded.mode, "real-vault");
  assert.equal(knowledgeCalls, 1);
  assert.equal(legacyIndexCalls, 0);
});

test("browser preview keeps its explicit index adapter without masquerading as the Tauri backend", async () => {
  let previewCalls = 0;
  let knowledgeCalls = 0;
  const previewIndex = adaptKnowledgeIndexToLegacy(indexSnapshot(), "preview:/vault");
  const bridge = {
    getCurrentNotesVault: async () => ({ id: "vault-a", name: "A", rootPath: "preview:/vault", openedAt: "now" }),
    listNotesVaultFiles: async () => ({ name: "A", relativePath: "", absolutePath: "preview:/vault", kind: "folder", children: [] }),
    listNotes: async () => [],
    getNotesVaultMarkdownIndex: async () => { previewCalls += 1; return previewIndex; },
  };
  const loaded = await loadKnowledgeStoreData(bridge as never, async () => {
    knowledgeCalls += 1;
    return indexSnapshot();
  }, () => false);
  assert.equal(loaded.mode, "real-vault");
  assert.equal(previewCalls, 1);
  assert.equal(knowledgeCalls, 0);
});

test("KnowledgeStore publishes only the latest Vault when an older refresh settles late", async () => {
  const pending: Array<{ resolve(value: KnowledgeStoreLoadResult): void }> = [];
  const bridge = {} as never;
  const store = new KnowledgeStore(
    () => new Promise((resolve) => pending.push({ resolve })),
    () => bridge,
  );
  const first = store.revalidate({ reason: "vault-a", force: true });
  const second = store.revalidate({ reason: "vault-b", force: true });
  const realResult = (vaultId: string): KnowledgeStoreLoadResult => ({
    mode: "real-vault",
    vault: { id: vaultId, name: vaultId, rootPath: `C:/${vaultId}`, openedAt: "now" },
    root: { name: vaultId, relativePath: "", absolutePath: `C:/${vaultId}`, kind: "folder", children: [] },
    markdownIndex: adaptKnowledgeIndexToLegacy(indexSnapshot(vaultId), `C:/${vaultId}`),
  });
  pending[1].resolve(realResult("vault-b"));
  await second;
  assert.equal(store.getSnapshot().vault?.id, "vault-b");
  pending[0].resolve(realResult("vault-a"));
  await first;
  assert.equal(store.getSnapshot().vault?.id, "vault-b");
});

test('invalidation waits for the newest requested batch even if the previous load settles first', async () => {
  const pending: Array<(result: KnowledgeStoreLoadResult) => void> = [];
  const store = new KnowledgeStore(() => new Promise(resolve => pending.push(resolve)), () => ({} as never));
  const result: KnowledgeStoreLoadResult = {mode:'real-vault',vault:{id:'vault-a',name:'A',rootPath:'C:/a',openedAt:'now'},root:{name:'a',relativePath:'',absolutePath:'C:/a',kind:'folder',children:[]},markdownIndex:adaptKnowledgeIndexToLegacy(indexSnapshot(),'C:/a')};
  const waitForLoad = async (count: number) => {
    const deadline = Date.now()+2000;
    while(pending.length<count && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(pending.length,count);
  };
  let settled=false;
  const first=store.invalidate({reason:'watch'});
  void first.then(()=>{settled=true;});
  await waitForLoad(1);
  const latest=store.invalidate({reason:'reference-readback'});
  assert.equal(first,latest);
  pending[0](result);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(settled,false);
  await waitForLoad(2);
  assert.equal(settled,false);
  pending[1](result);
  assert.equal((await latest).status,'ready');
  assert.equal(settled,true);
});

test("known document saves and watch echoes refresh documents without enumerating the tree", async () => {
  let loads = 0; const partialCalls: string[][] = [];
  const initial = indexSnapshot();
  let refreshed = initial;
  const result: KnowledgeStoreLoadResult = { mode:'real-vault', vault:{id:'vault-a',name:'A',rootPath:'C:/a',openedAt:'now'}, root:{name:'a',relativePath:'',absolutePath:'C:/a',kind:'folder',children:[]}, markdownIndex:adaptKnowledgeIndexToLegacy(initial,'C:/a') };
  const store = new KnowledgeStore(async()=>{loads++;return result;},()=>({} as never),async paths=>{partialCalls.push(paths);return refreshed;});
  await store.revalidate({reason:'initial'});
  const index = store.getSnapshot().markdownIndex;
  const version = store.getSnapshot().version;
  const path = initial.documents[0].relativePath;
  await store.invalidate({reason:'notes-save',modifiedPaths:[path]});
  await store.invalidate({reason:'vault-watch',modifiedPaths:[path]});
  assert.equal(loads,1);assert.deepEqual(partialCalls,[[path],[path]]);
  assert.equal(store.getSnapshot().markdownIndex,index,'unchanged index preserves consumer identity');
  assert.equal(store.getSnapshot().version,version,'unchanged echo does not reapply the UI tree');
  await store.invalidate({reason:'rename-or-unknown'});assert.equal(loads,2);
  refreshed = structuredClone(initial);
  refreshed.version++;
  refreshed.documents.push({...refreshed.documents[0],relativePath:'discovered.md'});
  await store.invalidate({reason:'native-fallback-discovered-file',modifiedPaths:[path]});
  assert.equal(loads,3,'native fallback discovery also rebuilds the visible tree');
  const a=adaptKnowledgeIndexToLegacy(initial,'C:/a');
  const b=structuredClone(a);b.documents[0].plainText='new ordinary text';b.documents[0].embeds.forEach(e=>e.line++);
  assert.equal(attachmentIndexSignature(a),attachmentIndexSignature(b));
  b.documents[0].embeds.push({target:'new.png',raw:'![](new.png)',kind:'image',line:3});
  assert.notEqual(attachmentIndexSignature(a),attachmentIndexSignature(b));
});

test("real Vault graph nodes use kdoc identity and tag writes use Knowledge once", async () => {
  const adapted = adaptKnowledgeIndexToLegacy(indexSnapshot(), "C:/trusted/vault");
  const seed = buildRealVaultGraphSeed(adapted);
  const note = seed.nodes.find((node) => node.type === "note" && node.status !== "missing");
  const tag = seed.nodes.find((node) => node.type === "tag");
  assert.ok(note?.entityId);
  assert.deepEqual(parseKnowledgeDocumentNoteId(note.entityId), {
    vaultId: "vault-a",
    relativePath: "Inbox/A.md",
  });
  assert.ok(tag);
  const otherVaultNote = buildRealVaultGraphSeed(adaptKnowledgeIndexToLegacy(indexSnapshot("vault-b"), "C:/trusted/b"))
    .nodes.find((node) => node.type === "note" && node.status !== "missing");
  assert.notEqual(otherVaultNote?.entityId, note.entityId);

  const calls: Array<{ expectedRevision: string; tags: string[] }> = [];
  let refreshes = 0;
  const result = await updateRealVaultGraphTagRelation(note, tag, "disconnect", {
    readIndex: async () => adapted,
    writeTags: async (_ref, expectedRevision, tags) => {
      calls.push({ expectedRevision, tags });
      return { document: { documentRef: { vaultId: "vault-a", relativePath: "Inbox/A.md" }, title: "A", relativePath: "Inbox/A.md", modifiedAt: null, size: 1, content: "A", revision: "rev-b" }, position: "replace" };
    },
    refresh: async () => { refreshes += 1; return adapted; },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(calls, [{ expectedRevision: "rev-a", tags: [] }]);
  assert.equal(refreshes, 1);
  assert.equal(result.mutation?.document.revision, "rev-b");
  assert.equal(result.message, `已断开 ${note.label} 与 ${tag.label}`);
});

test("Graph tag edits preserve committed Knowledge index warnings as the final operation status", async () => {
  const snapshot = indexSnapshot();
  const adapted = adaptKnowledgeIndexToLegacy(snapshot, "C:/trusted/vault");
  const seed = buildRealVaultGraphSeed(adapted);
  const note = seed.nodes.find((node) => node.type === "note" && node.status !== "missing")!;
  const tag = seed.nodes.find((node) => node.type === "tag")!;
  let writes = 0;
  let refreshes = 0;
  const mutation = {
    document: {
      documentRef: snapshot.documents[0].documentRef,
      title: "A",
      relativePath: "Inbox/A.md",
      modifiedAt: null,
      size: 1,
      content: "A",
      revision: "rev-b",
    },
    position: "replace",
    indexWarning: { code: "knowledge-index-refresh-failed", message: "Index refresh failed" },
    indexStale: true,
  } satisfies KnowledgeMutationResult;

  const result = await updateRealVaultGraphTagRelation(note, tag, "disconnect", {
    readIndex: async () => adapted,
    writeTags: async () => {
      writes += 1;
      return mutation;
    },
    refresh: async () => { refreshes += 1; },
  });

  assert.equal(writes, 1);
  assert.equal(refreshes, 0);
  assert.equal(result.mutation, mutation);
  assert.equal(result.message, knowledgeMutationSuccessStatus(mutation, `已断开 ${note.label} 与 ${tag.label}`));
});

test("Graph tag write failures remain failures without refresh or a success result", async () => {
  const adapted = adaptKnowledgeIndexToLegacy(indexSnapshot(), "C:/trusted/vault");
  const seed = buildRealVaultGraphSeed(adapted);
  const note = seed.nodes.find((node) => node.type === "note" && node.status !== "missing")!;
  const tag = seed.nodes.find((node) => node.type === "tag")!;
  let writes = 0;
  let refreshes = 0;

  await assert.rejects(() => updateRealVaultGraphTagRelation(note, tag, "disconnect", {
    readIndex: async () => adapted,
    writeTags: async () => {
      writes += 1;
      throw new Error("knowledge-revision-conflict");
    },
    refresh: async () => { refreshes += 1; },
  }), /knowledge-revision-conflict/);
  assert.equal(writes, 1);
  assert.equal(refreshes, 0);
});

test("Graph and Tags share one vault-bound identity without changing tag display case", () => {
  const snapshot = indexSnapshot();
  snapshot.documents[0] = {
    ...snapshot.documents[0],
    tags: ["ProjectX"],
    frontmatterTags: ["ProjectX"],
  };
  const graphTag = buildRealVaultGraphSeed(adaptKnowledgeIndexToLegacy(snapshot, "C:/trusted/vault"))
    .nodes.find((node) => node.type === "tag");
  const tags = buildRealVaultTagsFromKnowledge(
    [{ name: "ProjectX", documentCount: 1 }],
    new Map([["ProjectX", [{
      documentRef: snapshot.documents[0].documentRef,
      title: "A",
      relativePath: "Inbox/A.md",
      modifiedAt: snapshot.documents[0].modifiedAt,
      size: 1,
    }]]]),
    snapshot,
  );

  assert.equal(graphTag?.entityId, tags[0].id);
  assert.equal(tags[0].name, "ProjectX");
});

test("merged catalog and Knowledge tags retain strict vault aliases with locale-independent Unicode keys", () => {
  const realAlias = knowledgeTagIdentity("vault-a", "ProjectX");
  const merged = mergeTagSources(
    [{ id: "db-project-x", name: "projectx", color: null, assetCount: 2, noteCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", source: "catalog" }],
    [{ id: realAlias, name: "ProjectX", color: null, assetCount: 0, noteCount: 1, createdAt: "2026-01-02", updatedAt: "2026-01-02", source: "real-vault" }],
  );

  assert.equal(merged[0].id, "db-project-x");
  assert.equal(merged[0].name, "ProjectX");
  assert.deepEqual(merged[0].realVaultAliases, [realAlias]);
  assert.notEqual(knowledgeTagIdentity("vault-a", "ProjectX"), knowledgeTagIdentity("vault-b", "ProjectX"));
  assert.equal(knowledgeTagIdentity("vault-a", "Cafe\u0301 / \u0130"), knowledgeTagIdentity("vault-a", "CAF\u00c9 / i\u0307"));
  assert.deepEqual(parseKnowledgeTagIdentity(knowledgeTagIdentity("vault:a", "Road/Map #1")), {
    vaultId: "vault:a",
    key: "road/map #1",
  });
  assert.equal(parseKnowledgeTagIdentity("real-vault-tag:vault-a:ProjectX"), null);
  assert.equal(parseKnowledgeTagIdentity("ProjectX"), null);
});

test("Tags focus resolves real aliases only for the active Vault and never falls back to a bare name", async () => {
  const { resolveTagFocusForActiveVault } = await loadTagGalleryModel();
  const aliasA = knowledgeTagIdentity("vault-a", "ProjectX");
  const aliasB = knowledgeTagIdentity("vault-b", "ProjectX");
  const merged = mergeTagSources(
    [{ id: "db-project-x", name: "ProjectX", color: null, assetCount: 1, noteCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", source: "catalog" }],
    [{ id: aliasA, name: "ProjectX", color: null, assetCount: 0, noteCount: 1, createdAt: "2026-01-02", updatedAt: "2026-01-02", source: "real-vault", realVaultAliases: [aliasA] }],
  );

  assert.equal(resolveTagFocusForActiveVault(merged, aliasA, "vault-a").tag?.id, "db-project-x");
  assert.equal(resolveTagFocusForActiveVault(merged, aliasA, "vault-b").status, "stale-vault");
  assert.equal(resolveTagFocusForActiveVault(merged, aliasB, "vault-a").status, "stale-vault");
  assert.equal(resolveTagFocusForActiveVault(merged, "ProjectX", "vault-a").status, "not-found");
  assert.equal(resolveTagFocusForActiveVault(merged, "db-project-x", "vault-a").tag?.id, "db-project-x");
});

test("Tags gallery summarizes, filters, and sorts mixed sources without a second data model", async () => {
  const { filterAndSortTagGallery, summarizeTagGallery } = await loadTagGalleryModel();
  const tags = [
    { id: "tag-material", name: "素材灵感", color: null, assetCount: 3, noteCount: 0, realVaultDocumentCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", source: "catalog" },
    { id: "tag-mixed", name: "项目 Alpha", color: null, assetCount: 2, noteCount: 1, realVaultDocumentCount: 4, createdAt: "2026-01-01", updatedAt: "2026-01-02", source: "mixed" },
    { id: "tag-knowledge", name: "参考资料", color: null, assetCount: 0, noteCount: 2, realVaultDocumentCount: 2, createdAt: "2026-01-01", updatedAt: "2026-01-03", source: "real-vault" },
  ] satisfies import("../src/features/tags/useTags.ts").BridgeTag[];

  assert.deepEqual(summarizeTagGallery(tags), { tags: 3, materials: 5, knowledge: 6 });
  assert.deepEqual(
    filterAndSortTagGallery(tags, { query: "", filter: "mixed", sort: "linked" }).map((tag) => tag.id),
    ["tag-mixed"],
  );
  assert.deepEqual(
    filterAndSortTagGallery(tags, { query: "", filter: "materials", sort: "linked" }).map((tag) => tag.id),
    ["tag-mixed", "tag-material"],
  );
  assert.deepEqual(
    filterAndSortTagGallery(tags, { query: "资料", filter: "knowledge", sort: "name" }).map((tag) => tag.id),
    ["tag-knowledge"],
  );
  assert.deepEqual(
    filterAndSortTagGallery(tags, { query: "", filter: "all", sort: "linked" }).map((tag) => tag.id),
    ["tag-mixed", "tag-material", "tag-knowledge"],
  );
});

test("Tags gallery previews use one bounded mapping read and one asset batch without per-card queries", async () => {
  const {
    buildTagGalleryPreviewPlan,
    hydrateTagGalleryPreviews,
    TAG_GALLERY_PREVIEW_ASSET_LIMIT,
    TAG_GALLERY_PREVIEW_PER_TAG,
  } = await import("../src/features/tags/useTags.ts");
  const tags = Array.from({ length: 30 }, (_, index) => ({
    id: `tag-${index}`,
    name: `Tag ${index}`,
    color: null,
    assetCount: 4,
    noteCount: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    source: "catalog" as const,
  }));
  const mapping = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [
    `asset-${index}`,
    [`tag-${index % tags.length}`],
  ]));
  const plan = buildTagGalleryPreviewPlan(tags, mapping);
  assert.equal(TAG_GALLERY_PREVIEW_PER_TAG, 3);
  assert.equal(TAG_GALLERY_PREVIEW_ASSET_LIMIT, 64);
  assert.ok(plan.assetIds.length <= 64);
  assert.ok(Object.values(plan.assetIdsByTag).every((ids) => ids.length <= 3));

  let mappingReads = 0;
  let assetBatches = 0;
  const hydrated = await hydrateTagGalleryPreviews(tags, {
    async listItemTagMap(itemType: "asset", itemIds?: string[]) {
      mappingReads += 1;
      assert.equal(itemType, "asset");
      assert.equal(itemIds, undefined, "the batch seam reads the existing full relation map once");
      return mapping;
    },
    async getAssetsByIds(assetIds: string[]) {
      assetBatches += 1;
      assert.deepEqual(assetIds, plan.assetIds);
      return assetIds.map((id) => ({ id, name: id, kind: "image", thumbnailUrl: `asset://${id}.png` }));
    },
  });
  assert.equal(mappingReads, 1);
  assert.equal(assetBatches, 1);
  assert.deepEqual(hydrated[0].galleryAssets?.map((asset) => asset.id), plan.assetIdsByTag["tag-0"]);
  assert.equal(hydrated[0].galleryAssets?.[0].thumbnailUrl.startsWith("asset://"), true);

  const withoutCapability = await hydrateTagGalleryPreviews(tags, {});
  assert.equal(withoutCapability, tags, "optional preview capability never blocks the existing gallery data");

  const previousTags = tags.map((tag, index) => index === 0 ? {
    ...tag,
    galleryAssets: [{ id: "stale-asset", name: "stale", kind: "image", thumbnailUrl: "asset://stale.png" }],
  } : tag);
  const refreshedCoreTags = tags.map((tag, index) => index === 0 ? { ...tag, assetCount: 5 } : tag);
  const mappingFailure = await hydrateTagGalleryPreviews(refreshedCoreTags, {
    async listItemTagMap() {
      throw new Error("preview-map-unavailable");
    },
    async getAssetsByIds() {
      assert.fail("asset batch must not run after mapping failure");
    },
  }, previousTags);
  assert.equal(mappingFailure[0].assetCount, 5, "core tag semantics still publish after preview failure");
  assert.equal(mappingFailure[0].galleryAssets?.[0].id, "stale-asset", "same-tag preview remains stale instead of flickering away");

  const assetFailure = await hydrateTagGalleryPreviews(refreshedCoreTags, {
    async listItemTagMap() {
      return { "new-asset": ["tag-0"] };
    },
    async getAssetsByIds() {
      throw new Error("preview-assets-unavailable");
    },
  }, previousTags);
  assert.equal(assetFailure[0].assetCount, 5);
  assert.equal(assetFailure[0].galleryAssets?.[0].id, "stale-asset");
});

test("tag query adapter keeps kdoc refs and real tag removal writes one revision-guarded mutation", async () => {
  const snapshot = indexSnapshot();
  const tags = buildRealVaultTagsFromKnowledge(
    [{ name: "alpha", documentCount: 1 }],
    new Map([["alpha", [{ documentRef: snapshot.documents[0].documentRef, title: "A", relativePath: "Inbox/A.md", modifiedAt: snapshot.documents[0].modifiedAt, size: 1 }]]]),
    snapshot,
  );
  assert.equal(tags[0].documents?.[0].id, knowledgeDocumentNoteId(snapshot.documents[0].documentRef));
  const snapshotB = indexSnapshot("vault-b");
  const tagsB = buildRealVaultTagsFromKnowledge(
    [{ name: "alpha", documentCount: 1 }],
    new Map([["alpha", [{ documentRef: snapshotB.documents[0].documentRef, title: "A", relativePath: "Inbox/A.md", modifiedAt: snapshotB.documents[0].modifiedAt, size: 1 }]]]),
    snapshotB,
  );
  assert.notEqual(tagsB[0].id, tags[0].id);
  assert.notEqual(tagsB[0].documents?.[0].id, tags[0].documents?.[0].id);

  let writes = 0;
  const mutation = await removeKnowledgeTagFromDocument(tags[0].documents![0], "alpha", async (_ref, revision, nextTags) => {
    writes += 1;
    assert.equal(revision, "rev-a");
    assert.deepEqual(nextTags, []);
    return { document: { documentRef: snapshot.documents[0].documentRef, title: "A", relativePath: "Inbox/A.md", modifiedAt: null, size: 1, content: "A", revision: "rev-b" }, position: "replace" };
  });
  assert.equal(writes, 1);
  assert.equal(mutation.document.revision, "rev-b");
});

test("TagDetail preserves a committed Knowledge index warning as its only final success status", async () => {
  const { removeKnowledgeTagDocumentForStatus } = await loadTagDetailModel();
  const snapshot = indexSnapshot();
  const document = {
    id: knowledgeDocumentNoteId(snapshot.documents[0].documentRef),
    documentRef: snapshot.documents[0].documentRef,
    title: "A",
    relativePath: "Inbox/A.md",
    excerpt: "A",
    updatedAt: null,
    revision: "rev-a",
    tags: ["alpha"],
  };
  let writes = 0;
  let refreshes = 0;
  const mutation = {
    document: {
      documentRef: snapshot.documents[0].documentRef,
      title: "A",
      relativePath: "Inbox/A.md",
      modifiedAt: null,
      size: 1,
      content: "A",
      revision: "rev-b",
    },
    position: "replace",
    indexWarning: { code: "knowledge-index-refresh-failed", message: "Index refresh failed" },
    indexStale: true,
  } satisfies KnowledgeMutationResult;

  const result = await removeKnowledgeTagDocumentForStatus(document, "alpha", {
    write: async () => {
      writes += 1;
      return mutation;
    },
    refresh: async () => { refreshes += 1; },
  });

  assert.equal(writes, 1);
  assert.equal(refreshes, 0);
  assert.equal(result.mutation, mutation);
  assert.equal(result.status, knowledgeMutationSuccessStatus(mutation, "已从知识库文档移除标签"));
});

test("TagDetail normal success refreshes once while write failure publishes no success", async () => {
  const { removeKnowledgeTagDocumentForStatus } = await loadTagDetailModel();
  const snapshot = indexSnapshot();
  const document = {
    id: knowledgeDocumentNoteId(snapshot.documents[0].documentRef),
    documentRef: snapshot.documents[0].documentRef,
    title: "A",
    relativePath: "Inbox/A.md",
    excerpt: "A",
    updatedAt: null,
    revision: "rev-a",
    tags: ["alpha"],
  };
  const mutation = {
    document: {
      documentRef: snapshot.documents[0].documentRef,
      title: "A",
      relativePath: "Inbox/A.md",
      modifiedAt: null,
      size: 1,
      content: "A",
      revision: "rev-b",
    },
    position: "replace",
  } satisfies KnowledgeMutationResult;
  let writes = 0;
  let refreshes = 0;
  const succeeded = await removeKnowledgeTagDocumentForStatus(document, "alpha", {
    write: async () => { writes += 1; return mutation; },
    refresh: async () => { refreshes += 1; },
  });
  assert.equal(writes, 1);
  assert.equal(refreshes, 1);
  assert.equal(succeeded.status, "已从知识库文档移除标签");

  await assert.rejects(() => removeKnowledgeTagDocumentForStatus(document, "alpha", {
    write: async () => { writes += 1; throw new Error("knowledge-revision-conflict"); },
    refresh: async () => { refreshes += 1; },
  }), /knowledge-revision-conflict/);
  assert.equal(writes, 2);
  assert.equal(refreshes, 1);
});

test("material backlinks resolve only unique Knowledge embeds and return kdoc identity", () => {
  const snapshot = indexSnapshot();
  const assets = [
    { id: "asset-a", name: "hero.png", originalPath: "C:/a/hero.png", libraryPath: "C:/library/a.png" },
    { id: "asset-b", name: "hero.png", originalPath: "C:/b/hero.png", libraryPath: "C:/library/b.png" },
  ];
  assert.equal(createRealVaultLibraryAssetResolver(assets)("hero.png"), null);
  assert.deepEqual(resolveMaterialKnowledgeLinkedNotes("asset-a", assets, snapshot), []);

  const uniqueAssets = [assets[0]];
  const linked = resolveMaterialKnowledgeLinkedNotes("asset-a", uniqueAssets, snapshot);
  assert.equal(linked.length, 1);
  assert.deepEqual(parseKnowledgeDocumentNoteId(linked[0].id), snapshot.documents[0].documentRef);
});

test("a refreshed Knowledge snapshot removes stale Graph, tag, and material relations without DB fallback", () => {
  const refreshed = indexSnapshot();
  refreshed.version += 1;
  refreshed.changedPaths = ["Inbox/A.md"];
  refreshed.documents = refreshed.documents.map((document) => ({
    ...document,
    title: "A edited",
    embeds: [],
    tags: [],
    frontmatterTags: [],
  }));
  const adapted = adaptKnowledgeIndexToLegacy(refreshed, "C:/trusted/vault");
  const seed = buildRealVaultGraphSeed(adapted);
  assert.equal(seed.nodes.some((node) => node.type === "tag" || node.type === "material"), false);
  assert.equal(seed.nodes.find((node) => node.type === "note")?.label, "A edited");
  assert.deepEqual(buildRealVaultTagsFromKnowledge([], new Map(), refreshed), []);
  assert.deepEqual(resolveMaterialKnowledgeLinkedNotes(
    "asset-a",
    [{ id: "asset-a", name: "hero.png", originalPath: null, libraryPath: "C:/library/a.png" }],
    refreshed,
  ), []);

  const deleted = { ...refreshed, version: refreshed.version + 1, documents: [], changedPaths: [], removedPaths: ["Inbox/A.md"] };
  assert.deepEqual(buildRealVaultGraphSeed(adaptKnowledgeIndexToLegacy(deleted, "C:/trusted/vault")).nodes, []);
});

test("material current insert uses the active Knowledge context and canonical result identity", async () => {
  const snapshot = indexSnapshot();
  let calls = 0;
  const result = await insertMaterialAssetIntoCurrentKnowledge({ id: "asset-a", name: "hero.png" }, {
    awaitCurrentNoteReady: async () => undefined,
    writer: async (input) => {
      calls += 1;
      assert.deepEqual(input, { text: "![[asset-a|hero.png]]", appendIfNoCursor: true });
      return {
        document: {
          documentRef: snapshot.documents[0].documentRef,
          title: "A",
          relativePath: "Inbox/A.md",
          modifiedAt: null,
          size: 1,
          content: "![[asset-a|hero.png]]",
          revision: "rev-b",
        },
        position: "cursor",
      } satisfies KnowledgeMutationResult;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.noteId, knowledgeDocumentNoteId(snapshot.documents[0].documentRef));
  assert.equal(result.position, "cursor");
});

test("Community create and current insert share the active Knowledge client and focus kdoc identity", async () => {
  const { createCommunityKnowledgeActions } = await loadCommunityModule();
  const snapshot = indexSnapshot();
  const calls: string[] = [];
  const focused: string[] = [];
  const actions = createCommunityKnowledgeActions({
    async create(input) {
      calls.push(`create:${input.title}:${input.content}`);
      return {
        documentRef: snapshot.documents[0].documentRef,
        title: input.title,
        relativePath: "Inbox/A.md",
        modifiedAt: null,
        size: 1,
        content: input.content || "",
        revision: "rev-a",
      };
    },
    async insertCurrent(input) {
      calls.push(`insert:${input.text}:${input.appendIfNoCursor}`);
      return {
        document: {
          documentRef: snapshot.documents[0].documentRef,
          title: "A",
          relativePath: "Inbox/A.md",
          modifiedAt: null,
          size: 1,
          content: input.text,
          revision: "rev-b",
        },
        position: "cursor",
      };
    },
    focus(noteId) { focused.push(noteId); },
  });
  await actions.insertCurrent("result");
  await actions.createAndFocus("Result", "body");
  assert.deepEqual(calls, ["insert:result:true", "create:Result:body"]);
  assert.deepEqual(focused.map(parseKnowledgeDocumentNoteId), [snapshot.documents[0].documentRef]);
});

test("tag detail exposes only asset tags alongside Knowledge documents", async () => {
  const {
    loadTagDetailItemsForSource,
    loadTagDetailItemsFromActiveBridge,
    removeAssetTagRelationsAndRefresh,
  } = await loadTagDetailModel();
  let assetMapCalls = 0;
  const requestedTags: string[] = [];
  const dependencies = {
    listAssetsForTag: async (tagId: string) => {
      requestedTags.push(tagId);
      return [{ id: "asset-a", name: "Hero", kind: "image", thumbnailUrl: null }];
    },
    listTagMap: async (itemType: "asset", itemIds: string[]) => {
      assert.equal(itemType, "asset");
      assert.deepEqual(itemIds, ["asset-a"]);
      assetMapCalls += 1;
      return { "asset-a": ["tag-a"] };
    },
  };
  const realItems = await loadTagDetailItemsForSource("tag-a", dependencies);
  assert.deepEqual(realItems.map((item) => item.type), ["asset"]);
  assert.deepEqual(requestedTags, ["tag-a"]);
  assert.equal(assetMapCalls, 1);

  const emptyItems = await loadTagDetailItemsForSource("tag-empty", {
    listAssetsForTag: async () => [],
    listTagMap: async () => {
      assetMapCalls += 1;
      return {};
    },
  });
  assert.deepEqual(emptyItems, []);
  assert.equal(assetMapCalls, 1);

  await assert.rejects(
    loadTagDetailItemsFromActiveBridge("tag-a", { listAssetsFiltered: async () => [] }, {
      listAssetsForTag: async () => { throw new Error("fixture-asset-query-failed"); },
      listTagMap: async () => ({}),
    }),
    /fixture-asset-query-failed/,
  );
  await assert.rejects(
    loadTagDetailItemsFromActiveBridge("tag-a", {}, dependencies),
    /tag-detail-asset-query-unavailable/,
  );

  const relationWrites: Array<{ id: string; tagIds: string[] }> = [];
  let refreshes = 0;
  await removeAssetTagRelationsAndRefresh("tag-a", [
    { id: "asset-a", tagIds: ["tag-a", "tag-b"] },
    { id: "asset-b", tagIds: ["tag-a"] },
  ], {
    setTags: async (id, tagIds) => { relationWrites.push({ id, tagIds }); },
    refresh: async () => { refreshes += 1; },
  });
  assert.deepEqual(relationWrites, [
    { id: "asset-a", tagIds: ["tag-b"] },
    { id: "asset-b", tagIds: [] },
  ]);
  assert.equal(refreshes, 1, "one explicit relation mutation triggers exactly one parent refresh");
});

test("Tags reuses semantically equal refresh results and replaces only meaningful changes", () => {
  const current = [{
    id: "tag-a",
    name: "Alpha",
    color: "#7c8aff",
    assetCount: 2,
    noteCount: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    source: "mixed" as const,
    realVaultDocuments: [{
      id: "doc-a",
      documentRef: { vaultId: "vault-a", relativePath: "Inbox/A.md" },
      title: "A",
      relativePath: "Inbox/A.md",
      excerpt: "A excerpt",
      updatedAt: "2026-01-02",
      revision: "rev-a",
      tags: ["Alpha"],
    }],
  }];
  const equalRefresh = structuredClone(current);
  const reused = reuseSemanticallyEqualTags(current, equalRefresh);
  assert.equal(reused, current);
  assert.equal(reused[0], current[0]);

  const changed = structuredClone(current);
  changed[0].realVaultDocuments![0].revision = "rev-b";
  const replaced = reuseSemanticallyEqualTags(current, changed);
  assert.notEqual(replaced, current);
  assert.deepEqual(replaced, changed);
});

test("tag detail keeps same-tag content during revalidation while tag switches stay latest-only", async () => {
  const { createLatestTagDetailLoader, getTagDetailLoadKey, getTagDetailLoadMode } = await loadTagDetailModel();
  const resolvers = new Map<string, (items: string[]) => void>();
  const rejectors = new Map<string, (error: Error) => void>();
  const published: string[][] = [];
  const errors: string[] = [];
  let loading = false;
  let visible = ["asset-from-previous-tag"];
  let selectionActive = true;
  const loader = createLatestTagDetailLoader<string[]>({
    load: (tagId: string) => new Promise((resolve, reject) => {
      resolvers.set(tagId, resolve);
      rejectors.set(tagId, reject);
    }),
    onStart: ({ mode }) => {
      loading = true;
      if (mode === "initial") {
        visible = [];
        selectionActive = false;
      }
    },
    onResult: (items: string[]) => {
      visible = items;
      published.push(items);
    },
    onError: (error, { mode }) => {
      errors.push((error as Error).message);
      if (mode === "initial") visible = [];
    },
    onSettled: () => { loading = false; },
  });
  const older = loader.run("tag-a", { mode: "initial" });
  const latest = loader.run("tag-b", { mode: "initial" });
  assert.deepEqual(visible, [], "a new tag query clears stale actions and presentation immediately");
  assert.equal(selectionActive, false);
  resolvers.get("tag-b")?.(["asset-b"]);
  assert.equal(await latest, true);
  assert.deepEqual(visible, ["asset-b"]);
  assert.equal(loading, false);
  resolvers.get("tag-a")?.(["asset-a"]);
  assert.equal(await older, false);
  assert.deepEqual(published, [["asset-b"]]);
  assert.equal(loading, false, "the stale query cannot reopen or clear the latest loading state");

  selectionActive = true;
  const background = loader.run("tag-b-refresh", { mode: "background" });
  assert.deepEqual(visible, ["asset-b"], "same-tag revalidation keeps stale content mounted");
  assert.equal(selectionActive, true, "same-tag revalidation keeps selection and scroll-owning DOM mounted");
  rejectors.get("tag-b-refresh")?.(new Error("refresh failed"));
  assert.equal(await background, false);
  assert.deepEqual(visible, ["asset-b"], "background failure keeps the previous detail content");
  assert.deepEqual(errors, ["refresh failed"]);

  const baseTag = {
    id: "tag-b",
    name: "Beta",
    color: "#7c8aff",
    assetCount: 1,
    noteCount: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    catalogRevision: "catalog-r1",
    source: "mixed" as const,
  };
  assert.equal(getTagDetailLoadMode("tag-b", "tag-b"), "background");
  assert.equal(getTagDetailLoadMode("tag-a", "tag-b"), "initial");
  assert.equal(getTagDetailLoadKey(baseTag), getTagDetailLoadKey({ ...baseTag, name: "Beta renamed", noteCount: 2 }));
  assert.notEqual(getTagDetailLoadKey(baseTag), getTagDetailLoadKey({ ...baseTag, assetCount: 2 }));
  assert.notEqual(getTagDetailLoadKey(baseTag), getTagDetailLoadKey({ ...baseTag, catalogRevision: "catalog-r2" }));
  assert.equal(getTagDetailLoadKey({ ...baseTag, source: "real-vault" }), null);
});
