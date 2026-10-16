import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

import { loadKnowledgeStoreData } from "../src/core/services/knowledgeStore.ts";
import { KnowledgeServiceError, knowledgeDocumentNoteId, knowledgeTagIdentity, type KnowledgeDocumentSnapshot, type KnowledgeIndexSnapshot } from "../src/core/services/knowledge.ts";
import { createKnowledgeLegacyBridgeAdapter, knowledgeFolderIdentity, parseKnowledgeFolderIdentity } from "../src/core/services/knowledgeLegacyBridge.ts";
import { buildAiSkillCommands } from "../src/core/services/aiCapabilities.ts";
import {
  applyCapabilitySchemaOverrides,
  isCapabilityAvailable,
  isCapabilityRunnable,
  type LocalCapability,
} from "../src/core/services/capabilities.ts";

async function loadNotesPageModule() {
  const server = await createServer({ appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    return await server.ssrLoadModule("/src/features/notes/NotesPage.tsx") as typeof import("../src/features/notes/NotesPage.tsx");
  } finally {
    await server.close();
  }
}

async function loadAppModule() {
  const server = await createServer({ appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    return await server.ssrLoadModule("/src/App.tsx") as typeof import("../src/App.tsx");
  } finally {
    await server.close();
  }
}

test("cold start without a Vault never reads legacy DB notes", async () => {
  let dbNoteReads = 0;
  const result = await loadKnowledgeStoreData({
    getCurrentNotesVault: async () => null,
    listNotesVaultFiles: async () => { throw new Error("no Vault tree should load"); },
    listNotes: async () => {
      dbNoteReads += 1;
      throw new Error("legacy DB note access");
    },
    getNotesVaultMarkdownIndex: async () => { throw new Error("no preview index should load"); },
  } as never);

  assert.equal(dbNoteReads, 0);
  assert.deepEqual(result, { mode: "vault-required", vault: null });
});

test("production fallback migration preserves material data without reading or writing retired DB notes", async () => {
  const { migrateLegacyNonKnowledgeDataToDb } = await loadAppModule();
  const values = new Map<string, string>([
    ["luckyray.folders", JSON.stringify([
      { id: "asset-folder", scope: "materials", name: "Assets" },
      { id: "legacy-note-folder", scope: "notes", name: "Notes" },
    ])],
    ["luckyray.notes", JSON.stringify([{ id: "legacy-note", title: "Legacy", contentText: "body" }])],
    ["luckyray.noteTags", JSON.stringify({ "legacy-note": ["tag-a"] })],
  ]);
  const previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  const selects: string[] = [];
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    select: async (sql: string) => {
      selects.push(sql);
      return [{ count: 0 }];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      return { rowsAffected: 1 };
    },
  };
  try {
    await migrateLegacyNonKnowledgeDataToDb(db as never);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousStorage });
  }

  const normalizedSql = [...selects, ...writes.map((write) => write.sql)].join("\n").toLowerCase();
  assert.doesNotMatch(normalizedSql, /\bnote(?:_search|_link|_asset_embed|_ai)?\b/);
  assert.equal(writes.some((write) => write.sql.includes("item_tag") && write.params.includes("legacy-note")), false);
  assert.equal(writes.some((write) => write.sql.includes("insert or ignore into folder") && write.params[1] === "materials"), true);
  assert.equal(writes.some((write) => write.sql.includes("insert or ignore into folder") && write.params[1] === "notes"), false);
});

test("Notes Vault UI exposes onboarding without any database-mode action", async () => {
  const { buildNotesVaultUiModel } = await loadNotesPageModule();
  const model = buildNotesVaultUiModel(null, {
    unopenedTitle: "No vault",
    unopenedSubtitle: "Open a vault",
  });
  assert.equal(model.source, "vault");
  assert.equal(model.dbNoteMode, false);
  assert.deepEqual(model.actions, ["create-vault", "open-vault"]);
  assert.equal(model.actions.some((action) => action.includes("db")), false);
});

test("AI command discovery includes migrated enabled Knowledge capabilities", () => {
  const migrated = {
    id: "skill.summary",
    type: "skill",
    name: "Vault summary",
    enabled: true,
    available: true,
    parameters: [{ key: "style", label: "Style", type: "select", options: [{ label: "Short", value: "short" }] }],
    resultActions: ["record", "copy"],
  } as LocalCapability;
  assert.equal(isCapabilityAvailable(migrated), true);
  assert.equal(isCapabilityRunnable(migrated), true);
  assert.deepEqual(applyCapabilitySchemaOverrides([migrated])[0], migrated);
  const commands = buildAiSkillCommands([migrated], []);
  assert.deepEqual(commands.map((command) => command.key), ["skill.summary"]);
});

function document(relativePath: string, content = "body", revision = "rev-1"): KnowledgeDocumentSnapshot {
  const title = relativePath.split("/").pop()!.replace(/\.md$/i, "");
  return {
    documentRef: { vaultId: "vault-a", relativePath },
    relativePath,
    title,
    content,
    revision,
    modifiedAt: "2026-07-15T00:00:00.000Z",
    size: new TextEncoder().encode(content).byteLength,
  };
}

test("legacy note bridge delegates list/get/create/update/delete to Knowledge and only emits kdoc ids", async () => {
  const rows = new Map<string, KnowledgeDocumentSnapshot>([["Inbox/A.md", document("Inbox/A.md")]]);
  const calls: string[] = [];
  const adapter = createKnowledgeLegacyBridgeAdapter({
    listDocuments: async () => [...rows.values()],
    readDocument: async (ref) => {
      calls.push(`read:${ref.relativePath}`);
      const value = rows.get(ref.relativePath);
      if (!value) throw new Error("knowledge-not-found");
      return value;
    },
    createDocument: async (input) => {
      calls.push(`create:${input.parentRelativePath || ""}`);
      const value = document(`${input.parentRelativePath ? `${input.parentRelativePath}/` : ""}${input.title}.md`, input.content || "", "rev-created");
      rows.set(value.relativePath, value);
      return value;
    },
    replaceDocument: async (ref, content, expectedRevision) => {
      calls.push(`replace:${expectedRevision}`);
      const value = document(ref.relativePath, content, "rev-replaced");
      rows.set(ref.relativePath, value);
      return { document: value, position: "replace" };
    },
    moveDocument: async (ref, title, expectedRevision) => {
      calls.push(`move:${title}:${expectedRevision}`);
      rows.delete(ref.relativePath);
      const value = document(`Inbox/${title}.md`, "next", "rev-moved");
      rows.set(value.relativePath, value);
      return value;
    },
    deleteDocument: async (ref, expectedRevision) => {
      calls.push(`delete:${expectedRevision}`);
      rows.delete(ref.relativePath);
    },
    indexSnapshot: async () => ({
      vaultId: "vault-a", generation: 1, builtAt: "now", version: 1, changedPaths: [], removedPaths: [], stale: false, refreshError: null, errors: [], documents: [],
    }),
    setDocumentTags: async () => { throw new Error("unused"); },
  });

  const listed = await adapter.listNotes();
  assert.equal(listed[0].id, knowledgeDocumentNoteId({ vaultId: "vault-a", relativePath: "Inbox/A.md" }));
  assert.equal((await adapter.getNote(listed[0].id))?.contentText, "body");
  const created = await adapter.createNote({ title: "Created", contentText: "created" });
  assert.equal(created.id, knowledgeDocumentNoteId({ vaultId: "vault-a", relativePath: "Created.md" }));
  const updated = await adapter.updateNote(listed[0].id, { contentText: "next" });
  assert.equal(updated?.contentText, "next");
  await adapter.deleteNote(created.id);
  assert.deepEqual(calls, ["read:Inbox/A.md", "create:", "read:Inbox/A.md", "replace:rev-1", "read:Created.md", "delete:rev-created"]);
});

test("legacy note bridge rejects retired DB and path-only identities before any Knowledge call", async () => {
  let calls = 0;
  const adapter = createKnowledgeLegacyBridgeAdapter({
    listDocuments: async () => [],
    readDocument: async () => { calls += 1; return document("Never.md"); },
    createDocument: async () => { calls += 1; return document("Never.md"); },
    replaceDocument: async () => { calls += 1; return { document: document("Never.md"), position: "replace" }; },
    moveDocument: async () => { calls += 1; return document("Never.md"); },
    deleteDocument: async () => { calls += 1; },
    indexSnapshot: async () => { calls += 1; throw new Error("unused"); },
    setDocumentTags: async () => { calls += 1; throw new Error("unused"); },
  });

  const hasCode = (code: string) => (error: unknown) => error instanceof KnowledgeServiceError && error.code === code;
  await assert.rejects(() => adapter.getNote("db-note-1"), hasCode("legacy-db-note-retired"));
  await assert.rejects(() => adapter.updateNote("real-vault:Inbox\/A.md", { contentText: "x" }), hasCode("legacy-db-note-retired"));
  await assert.rejects(() => adapter.deleteNote("kdoc-bad"), hasCode("knowledge-document-id-invalid"));
  assert.equal(calls, 0);
});

test("legacy relation, tag, and material backlink shapes come only from the Knowledge index", async () => {
  const snapshot: KnowledgeIndexSnapshot = {
    vaultId: "vault-a",
    generation: 1,
    builtAt: "now",
    version: 1,
    changedPaths: [],
    removedPaths: [],
    stale: false,
    refreshError: null,
    errors: [],
    documents: [
      {
        documentRef: { vaultId: "vault-a", relativePath: "Inbox/A.md" },
        relativePath: "Inbox/A.md",
        fileName: "A.md",
        title: "A",
        revision: "rev-a",
        headings: [],
        wikiLinks: [{ raw: "[[B]]", target: "B", alias: null, line: 1 }],
        embeds: [{ raw: "![[hero.png]]", target: "hero.png", kind: null, line: 2 }],
        tags: ["ProjectX"],
        frontmatterTags: ["ProjectX"],
        inlineTags: [],
        plainText: "A body",
        excerpt: "A body",
        contentLength: 6,
        modifiedAt: "now",
        size: 6,
      },
      {
        documentRef: { vaultId: "vault-a", relativePath: "B.md" },
        relativePath: "B.md",
        fileName: "B.md",
        title: "B",
        revision: "rev-b",
        headings: [], wikiLinks: [], embeds: [], tags: [], frontmatterTags: [], inlineTags: [],
        plainText: "B", excerpt: "B", contentLength: 1, modifiedAt: "now", size: 1,
      },
    ],
  };
  const tagWrites: string[][] = [];
  const adapter = createKnowledgeLegacyBridgeAdapter({
    listDocuments: async () => snapshot.documents,
    readDocument: async (ref) => document(ref.relativePath, "A body", ref.relativePath === "B.md" ? "rev-b" : "rev-a"),
    createDocument: async () => { throw new Error("unused"); },
    replaceDocument: async () => { throw new Error("unused"); },
    moveDocument: async () => { throw new Error("unused"); },
    deleteDocument: async () => { throw new Error("unused"); },
    indexSnapshot: async () => snapshot,
    setDocumentTags: async (ref, _revision, tags) => {
      tagWrites.push(tags);
      return { document: document(ref.relativePath, "A body", "rev-next"), position: "tags" };
    },
    listAssets: async () => [{ id: "asset-hero", name: "hero.png", originalPath: "C:/assets/hero.png", libraryPath: null }],
  });

  const aId = knowledgeDocumentNoteId({ vaultId: "vault-a", relativePath: "Inbox/A.md" });
  const bId = knowledgeDocumentNoteId({ vaultId: "vault-a", relativePath: "B.md" });
  assert.deepEqual(await adapter.getNoteTags(aId), [knowledgeTagIdentity("vault-a", "ProjectX")]);
  assert.deepEqual(await adapter.setNoteTags(aId, [knowledgeTagIdentity("vault-a", "Next")]), [knowledgeTagIdentity("vault-a", "next")]);
  assert.deepEqual((await adapter.listKnowledgeTags()).map((tag) => [tag.id, tag.name, tag.noteCount]), [
    [knowledgeTagIdentity("vault-a", "ProjectX"), "ProjectX", 1],
  ]);
  assert.equal((await adapter.createKnowledgeTag({ name: "NewTag" })).id, knowledgeTagIdentity("vault-a", "NewTag"));
  await adapter.addKnowledgeTag(aId, "AnotherTag");
  await adapter.removeKnowledgeTag(aId, knowledgeTagIdentity("vault-a", "ProjectX"));
  assert.deepEqual(tagWrites, [["next"], ["ProjectX", "AnotherTag"], []]);
  assert.equal((await adapter.getNoteLinks(aId))[0].toNoteId, bId);
  assert.equal((await adapter.getNoteEmbeds(aId))[0].assetId, "asset-hero");
  assert.deepEqual((await adapter.getNotesForAsset("asset-hero")).map((note) => note.id), [aId]);
  assert.deepEqual((await adapter.getAssetsForNote(aId)).map((asset) => asset.id), ["asset-hero"]);
  assert.deepEqual((await adapter.getNotesLinkingToNote(bId)).map((note) => note.id), [aId]);
});

test("legacy folder compatibility accepts only vault-bound folder identities", async () => {
  const folderId = knowledgeFolderIdentity("vault-a", "Projects/Active");
  assert.deepEqual(parseKnowledgeFolderIdentity(folderId), { vaultId: "vault-a", relativePath: "Projects/Active" });
  assert.equal(parseKnowledgeFolderIdentity("db-folder"), null);
  const creates: Array<string | null | undefined> = [];
  const moves: Array<string | null | undefined> = [];
  const adapter = createKnowledgeLegacyBridgeAdapter({
    listDocuments: async () => [{ documentRef: { vaultId: "vault-a", relativePath: "Projects/Active/A.md" }, title: "A", relativePath: "Projects/Active/A.md", modifiedAt: null, size: 1 }],
    readDocument: async () => document("Projects/Active/A.md"),
    createDocument: async (input) => {
      creates.push(input.parentRelativePath);
      return document(`${input.parentRelativePath}/Created.md`);
    },
    replaceDocument: async () => { throw new Error("unused"); },
    moveDocument: async (_ref, _title, _revision, parentRelativePath) => {
      moves.push(parentRelativePath);
      return document(`${parentRelativePath}/A.md`, "body", "rev-moved");
    },
    deleteDocument: async () => { throw new Error("unused"); },
    indexSnapshot: async () => ({ vaultId: "vault-a", generation: 1, builtAt: "now", version: 1, changedPaths: [], removedPaths: [], stale: false, refreshError: null, errors: [], documents: [] }),
    setDocumentTags: async () => { throw new Error("unused"); },
  });

  await adapter.createNote({ title: "Created", folderId });
  await adapter.moveNoteToFolder({
    noteId: knowledgeDocumentNoteId({ vaultId: "vault-a", relativePath: "Projects/Active/A.md" }),
    folderId,
  });
  assert.deepEqual(creates, ["Projects/Active"]);
  assert.deepEqual(moves, ["Projects/Active"]);
  assert.equal((await adapter.listNoteFolders())[0].id, knowledgeFolderIdentity("vault-a", "Projects"));
  await assert.rejects(() => adapter.createNote({ title: "No", folderId: "db-folder" }), /Legacy database note folders are retired/);
  await assert.rejects(
    () => adapter.createNote({ title: "No", folderId: knowledgeFolderIdentity("vault-b", "Projects") }),
    /another Vault/,
  );
});
