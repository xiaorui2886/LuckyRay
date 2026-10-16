import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";

import {
  browserPreviewKnowledgeAdapter,
  commitKnowledgeDocumentTags,
  createActiveKnowledgeUiClient,
  createKnowledgeClient,
  knowledgeDocumentNoteId,
  knowledgeErrorMessage,
  knowledgeMutationSuccessStatus,
  KnowledgeServiceError,
  parseKnowledgeDocumentNoteId,
  resolveKnowledgeNoteNavigation,
} from "../src/core/services/knowledge.ts";
import { createCurrentNoteContextPublisher, publishCurrentNoteContext, resolveKnowledgeDocumentRef } from "../src/core/services/context.ts";
import { clearActiveKnowledgeSource, readActiveKnowledgeSource, setActiveKnowledgeSource } from "../src/core/services/knowledgeSource.ts";

type KnowledgeIdentityVectors = {
  positive: Array<{
    name: string;
    documentRef: { vaultId: string; relativePath: string };
    noteId: string;
  }>;
  negative: Array<{ name: string; noteId: string }>;
};

async function loadNotesTagMutationSeam() {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    return await server.ssrLoadModule("/src/features/notes/NotesPage.tsx");
  } finally {
    await server.close();
  }
}

async function readKnowledgeIdentityVectors(): Promise<KnowledgeIdentityVectors> {
  return JSON.parse(await readFile(
    new URL("./fixtures/knowledgeDocumentRef.vectors.json", import.meta.url),
    "utf8",
  )) as KnowledgeIdentityVectors;
}

test("Knowledge note identity binds the complete Vault ref and matches the backend protocol vector", async () => {
  const vectors = await readKnowledgeIdentityVectors();
  const [vector] = vectors.positive;
  assert.ok(vector);
  assert.equal(knowledgeDocumentNoteId(vector.documentRef), vector.noteId);
  assert.notEqual(
    knowledgeDocumentNoteId(vector.documentRef),
    knowledgeDocumentNoteId({ ...vector.documentRef, vaultId: "vault-b" }),
  );
});

test("Knowledge note identity decode is reversible and fails closed for malformed or unsafe refs", async () => {
  const vectors = await readKnowledgeIdentityVectors();
  for (const vector of vectors.positive) {
    assert.equal(knowledgeDocumentNoteId(vector.documentRef), vector.noteId, vector.name);
    assert.deepEqual(parseKnowledgeDocumentNoteId(vector.noteId), vector.documentRef, vector.name);
  }
  for (const vector of vectors.negative) {
    assert.equal(parseKnowledgeDocumentNoteId(vector.noteId), null, vector.name);
  }

  const encodedJson = (value: unknown) => `kdoc-${Buffer.from(JSON.stringify(value), "utf8").toString("hex")}`;
  const encodedText = (value: string) => `kdoc-${Buffer.from(value, "utf8").toString("hex")}`;
  for (const invalid of [
    "legacy-db-note-id",
    "real-vault:Inbox/Result.md",
    "kdoc-",
    "kdoc-0",
    "kdoc-gg",
    "kdoc-ff",
    encodedJson({ relativePath: "Inbox/Result.md" }),
    encodedJson({ vaultId: "vault-a" }),
    encodedJson({ vaultId: "vault-a", relativePath: "Inbox/Result.md", extra: true }),
    encodedJson({ vaultId: "", relativePath: "Inbox/Result.md" }),
    encodedJson({ vaultId: "vault-a", relativePath: "../Result.md" }),
    encodedJson({ vaultId: "vault-a", relativePath: "/Inbox/Result.md" }),
    encodedJson({ vaultId: "vault-a", relativePath: "C:/Result.md" }),
    encodedJson({ vaultId: "vault-a", relativePath: "Inbox\\Result.md" }),
    encodedJson({ vaultId: "vault-a", relativePath: "Inbox/Result.txt" }),
    encodedText('{"vaultId":"vault-a","vaultId":"vault-b","relativePath":"Inbox/Result.md"}'),
    encodedText('{"relativePath":"Inbox/Result.md","vaultId":"vault-a"}'),
  ]) {
    assert.equal(parseKnowledgeDocumentNoteId(invalid), null, invalid);
  }
});

test("Knowledge navigation opens only the matching current Vault and rejects delayed or legacy identities", () => {
  const ref = { vaultId: "vault-a", relativePath: "Inbox/Result.md" };
  const noteId = knowledgeDocumentNoteId(ref);
  assert.deepEqual(resolveKnowledgeNoteNavigation(noteId, "vault-a"), {
    ok: true,
    documentRef: ref,
    internalNoteId: "real-vault:Inbox/Result.md",
  });
  assert.deepEqual(resolveKnowledgeNoteNavigation(noteId, "vault-b"), {
    ok: false,
    code: "knowledge-note-vault-mismatch",
  });
  assert.deepEqual(resolveKnowledgeNoteNavigation(noteId, null), {
    ok: false,
    code: "knowledge-vault-required",
  });
  for (const invalid of ["real-vault:Inbox/Result.md", "legacy-db-note-id", "kdoc-not-hex"]) {
    assert.deepEqual(resolveKnowledgeNoteNavigation(invalid, "vault-a"), {
      ok: false,
      code: "knowledge-note-id-invalid",
    });
  }
});

test("Tauri knowledge failures stay fail-closed instead of falling back to preview storage", async () => {
  let previewCalls = 0;
  const client = createKnowledgeClient({
    isTauri: () => true,
    invoke: async () => {
      throw new Error("knowledge-vault-required");
    },
    preview: {
      listDocuments: async () => {
        previewCalls += 1;
        return [];
      },
    },
  });

  await assert.rejects(client.listDocuments(), /knowledge-vault-required/);
  assert.equal(previewCalls, 0);
});

test("canonical KnowledgeDocumentRef is preserved across Tauri list, create, append and current-context calls", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const documentRef = { vaultId: "vault-a", relativePath: "Inbox/Answer.md" };
  const snapshot = {
    documentRef,
    title: "Answer",
    relativePath: "Inbox/Answer.md",
    modifiedAt: "2026-07-15T00:00:00Z",
    size: 7,
    content: "initial",
    revision: "rev-1",
  };
  const client = createKnowledgeClient({
    isTauri: () => true,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "knowledge_list_documents") return [snapshot];
      if (command === "knowledge_create_document") return snapshot;
      if (command === "knowledge_append_document") return { document: snapshot, position: "append" };
      if (command === "knowledge_insert_document") return { document: snapshot, position: "cursor" };
      if (command === "knowledge_begin_current_context_session") return { sessionId: "webview-a", sessionEpoch: 7 };
      return null;
    },
    preview: { listDocuments: async () => [] },
  });

  assert.equal((await client.listDocuments())[0]?.documentRef, documentRef);
  await client.createDocument({ title: "Answer", content: "initial", parentRelativePath: "Inbox" }, 11);
  await client.appendDocument(documentRef, "more", "rev-1", 11);
  await client.insertDocument(documentRef, 3, "inserted", "rev-1", 11);
  const session = await client.beginCurrentContextSession("webview-a", 11);
  await client.setCurrentContext({ ...session, sourceEpoch: 11, generation: 1, documentRef, cursorOffset: 3, selection: null, expectedRevision: "rev-1" });

  assert.deepEqual(calls, [
    { command: "knowledge_list_documents", args: {} },
    { command: "knowledge_create_document", args: { input: { title: "Answer", content: "initial", parentRelativePath: "Inbox" }, sourceEpoch: 11 } },
    { command: "knowledge_append_document", args: { input: { documentRef, content: "more", expectedRevision: "rev-1" }, sourceEpoch: 11 } },
    { command: "knowledge_insert_document", args: { input: { documentRef, offset: 3, text: "inserted", expectedRevision: "rev-1" }, sourceEpoch: 11 } },
    { command: "knowledge_begin_current_context_session", args: { sessionId: "webview-a", sourceEpoch: 11 } },
    { command: "knowledge_set_current_context", args: { input: { sessionId: "webview-a", sessionEpoch: 7, sourceEpoch: 11, generation: 1, documentRef, cursorOffset: 3, selection: null, expectedRevision: "rev-1" } } },
  ]);
});

test("backend-owned index queries and revision-safe tag writes use the typed production commands", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const documentRef = { vaultId: "vault-a", relativePath: "Inbox/Tagged.md" };
  const mutation = {
    document: {
      documentRef,
      title: "Tagged",
      relativePath: documentRef.relativePath,
      modifiedAt: "2026-07-15T00:00:00Z",
      size: 12,
      content: "# Tagged\n",
      revision: "next-revision",
    },
    position: "tags",
  };
  const client = createKnowledgeClient({
    isTauri: () => true,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "knowledge_refresh_index") return { vaultId: "vault-a", documents: [] };
      if (command === "knowledge_document_relations") return { documentRef, headings: [], wikiLinks: [], embeds: [], tags: [] };
      if (command === "knowledge_set_document_tags") return mutation;
      return [];
    },
    preview: { listDocuments: async () => [] },
  });

  await client.refreshIndex();
  await client.documentRelations(documentRef);
  await client.backlinks(documentRef);
  await client.tagSummary();
  await client.documentsForTag("project");
  await client.documentsReferencingEmbed("asset.png");
  await client.setDocumentTags(documentRef, "old-revision", ["project"], 41);

  assert.deepEqual(calls, [
    { command: "knowledge_refresh_index", args: undefined },
    { command: "knowledge_document_relations", args: { documentRef } },
    { command: "knowledge_backlinks", args: { documentRef } },
    { command: "knowledge_tag_summary", args: undefined },
    { command: "knowledge_documents_for_tag", args: { tag: "project" } },
    { command: "knowledge_documents_referencing_embed", args: { target: "asset.png" } },
    { command: "knowledge_set_document_tags", args: { input: { documentRef, expectedRevision: "old-revision", tags: ["project"] }, sourceEpoch: 41 } },
  ]);
});

test("Notes tag commit seam rejects dirty editor content and delegates clean updates without rewriting Markdown", async () => {
  const documentRef = { vaultId: "vault-a", relativePath: "Inbox/Tagged.md" };
  let writes = 0;
  const writer = async (actualRef: typeof documentRef, revision: string, tags: string[]) => {
    writes += 1;
    assert.deepEqual(actualRef, documentRef);
    assert.equal(revision, "revision-1");
    assert.deepEqual(tags, ["Project"]);
    return {
      document: {
        documentRef,
        title: "Tagged",
        relativePath: documentRef.relativePath,
        modifiedAt: null,
        size: 25,
        content: "---\ntags: [Project]\n---\nBody\n",
        revision: "revision-2",
      },
      position: "tags",
    };
  };
  await assert.rejects(
    commitKnowledgeDocumentTags({
      documentRef,
      expectedRevision: "revision-1",
      tags: ["Project"],
      editorContent: "dirty",
      savedContent: "saved",
    }, writer),
    (error: unknown) => error instanceof KnowledgeServiceError && error.code === "knowledge-editor-dirty",
  );
  assert.equal(writes, 0);

  const result = await commitKnowledgeDocumentTags({
    documentRef,
    expectedRevision: "revision-1",
    tags: ["Project"],
    editorContent: "\uFEFFBody\r\n",
    savedContent: "Body\n",
  }, writer);
  assert.equal(writes, 1);
  assert.equal(result.document.revision, "revision-2");
});

test("committed tag mutations remain success while surfacing a stable index warning", () => {
  const documentRef = { vaultId: "vault-a", relativePath: "Inbox/Tagged.md" };
  const committed = {
    document: {
      documentRef,
      title: "Tagged",
      relativePath: documentRef.relativePath,
      modifiedAt: null,
      size: 25,
      content: "---\ntags: [Project]\n---\nBody\n",
      revision: "revision-2",
    },
    position: "tags",
  };
  assert.equal(
    knowledgeMutationSuccessStatus(committed, "标签已写入 Markdown"),
    "标签已写入 Markdown",
  );
  assert.equal(
    knowledgeMutationSuccessStatus(
      {
        ...committed,
        indexWarning: {
          code: "knowledge-index-refresh-failed",
          message: "Knowledge index refresh failed",
        },
        indexStale: true,
      },
      "标签已写入 Markdown",
    ),
    "标签已写入 Markdown，索引刷新稍后重试",
  );
});

test("manual and AI tag writes publish exactly one final status from the committed mutation", async () => {
  const { runKnowledgeTagMutationForStatus } = await loadNotesTagMutationSeam();
  let writes = 0;
  const statuses: string[] = [];
  const mutation = (warning: boolean) => ({
    mutation: {
      document: {
        documentRef: { vaultId: "vault-a", relativePath: "Inbox/Tagged.md" },
        title: "Tagged",
        relativePath: "Inbox/Tagged.md",
        modifiedAt: null,
        size: 25,
        content: "---\ntags: [Project]\n---\nBody\n",
        revision: "revision-2",
      },
      position: "tags",
      ...(warning ? {
        indexWarning: {
          code: "knowledge-index-refresh-failed",
          message: "Knowledge index refresh failed",
        },
        indexStale: true,
      } : {}),
    },
  });
  const run = (warning: boolean, successMessage: string) => runKnowledgeTagMutationForStatus(
    async () => {
      writes += 1;
      return mutation(warning);
    },
    successMessage,
    (status: string) => statuses.push(status),
  );

  await run(false, "标签已写入 Markdown");
  await run(true, "标签已写入 Markdown");
  await run(false, "AI 标签已写入 Markdown");
  const aiWarning = await run(true, "AI 标签已写入 Markdown");

  assert.equal(writes, 4);
  assert.deepEqual(statuses, [
    "标签已写入 Markdown",
    "标签已写入 Markdown，索引刷新稍后重试",
    "AI 标签已写入 Markdown",
    "AI 标签已写入 Markdown，索引刷新稍后重试",
  ]);
  assert.equal(aiWarning.status, statuses[statuses.length - 1]);

  await assert.rejects(
    runKnowledgeTagMutationForStatus(
      async () => {
        writes += 1;
        throw new Error("revision conflict");
      },
      "AI 标签已写入 Markdown",
      (status: string) => statuses.push(status),
    ),
    /revision conflict/,
  );
  assert.equal(writes, 5);
  assert.equal(statuses.length, 4);
});

test("AI and Collection write adapter blocks legacy DB mode and rechecks source after async selection", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let source: { mode: "db" | "real-vault"; vaultId?: string | null } | null = { mode: "db" };
  let nextEpoch = 40;
  const snapshotFor = (vaultId: string) => ({
    documentRef: { vaultId, relativePath: "Inbox/Result.md" },
    title: "Result",
    relativePath: "Inbox/Result.md",
    modifiedAt: "2026-07-15T00:00:00Z",
    size: 6,
    content: "result",
    revision: `rev-${vaultId}`,
  });
  const client = createKnowledgeClient({
    isTauri: () => true,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "knowledge_activate_ui_source") {
        nextEpoch += 1;
        return { vaultId: String(args?.vaultId), sourceEpoch: nextEpoch };
      }
      if (command === "knowledge_deactivate_ui_source") return null;
      const input = args?.input as { documentRef?: { vaultId: string } } | undefined;
      const vaultId = input?.documentRef?.vaultId || String(source?.vaultId || "vault-a");
      if (command === "knowledge_create_document") return snapshotFor(vaultId);
      if (command === "knowledge_append_document" || command === "knowledge_insert_current") {
        return { document: snapshotFor(vaultId), position: "append" };
      }
      return null;
    },
    preview: { listDocuments: async () => [] },
  });
  const ui = createActiveKnowledgeUiClient(client, () => (
    source?.mode === "real-vault" && source.vaultId
      ? source as { mode:"real-vault"; vaultId:string }
      : null
  ));

  await assert.rejects(
    ui.createDocument({ title: "Blocked" }),
    (error: unknown) => error instanceof KnowledgeServiceError && error.code === "knowledge-source-inactive",
  );
  const blockedBatch = await Promise.allSettled([
    ui.createDocument({ title: "Blocked batch one" }),
    ui.createDocument({ title: "Blocked batch two" }),
    ui.insertIntoCurrent({ text: "blocked current insert" }),
  ]);
  assert.ok(blockedBatch.every((result) => result.status === "rejected"
    && result.reason instanceof KnowledgeServiceError
    && result.reason.code === "knowledge-source-inactive"));
  assert.equal(calls.length, 0);

  source = { mode: "real-vault", vaultId: "vault-a" };
  await ui.createDocument({ title: "Allowed" });
  assert.deepEqual(calls.map((call) => call.command), ["knowledge_activate_ui_source", "knowledge_create_document"]);

  let releaseSelection!: () => void;
  const selector = new Promise<void>((resolve) => { releaseSelection = resolve; });
  const pendingWrite = (async () => {
    await selector;
    return ui.appendDocument({ vaultId: "vault-a", relativePath: "Inbox/Result.md" }, "late");
  })();
  source = { mode: "db" };
  releaseSelection();
  await assert.rejects(
    pendingWrite,
    (error: unknown) => error instanceof KnowledgeServiceError && error.code === "knowledge-source-inactive",
  );
  assert.equal(calls.filter((call) => call.command === "knowledge_append_document").length, 0);

  await ui.deactivate();
  source = { mode: "real-vault", vaultId: "vault-b" };
  await assert.rejects(
    ui.appendDocument({ vaultId: "vault-a", relativePath: "Inbox/Result.md" }, "wrong vault"),
    (error: unknown) => error instanceof KnowledgeServiceError && error.code === "knowledge-source-inactive",
  );
  assert.equal(calls.filter((call) => call.command === "knowledge_append_document").length, 0);
  await ui.appendDocument({ vaultId: "vault-b", relativePath: "Inbox/Result.md" }, "right vault");
  assert.equal(calls.filter((call) => call.command === "knowledge_append_document").length, 1);
  await ui.insertIntoCurrent({ text: "right current document" });
  assert.equal(calls.filter((call) => call.command === "knowledge_insert_current").length, 1);
});

test("current-note action reads the Backend-owned identity instead of a stale renderer context", async () => {
  const calls: string[] = [];
  const client = createKnowledgeClient({
    isTauri: () => true,
    invoke: async (command) => {
      calls.push(command);
      if (command === "knowledge_get_current_context") {
        return {
          documentRef: { vaultId: "vault-current", relativePath: "Inbox/Current.md" },
          cursorOffset: 4,
          selection: null,
          expectedRevision: "rev-current",
          updatedAt: "2026-08-02T00:00:00Z",
        };
      }
      return null;
    },
    preview: { listDocuments: async () => [] },
  });
  const current = await client.getCurrentContext();
  assert.equal(current?.documentRef.vaultId, "vault-current");
  assert.deepEqual(calls, ["knowledge_get_current_context"]);
});

test("stable backend error codes remain machine-readable and never become preview success", async () => {
  const client = createKnowledgeClient({
    isTauri: () => true,
    invoke: async () => {
      throw new Error(JSON.stringify({ code: "knowledge-vault-required", message: "Open a Vault" }));
    },
    preview: browserPreviewKnowledgeAdapter,
  });

  await assert.rejects(
    client.createDocument({ title: "Must fail", content: "not persisted" }),
    (error: unknown) => error instanceof KnowledgeServiceError
      && error.code === "knowledge-vault-required"
      && error.message === "Open a Vault",
  );
  assert.equal(
    knowledgeErrorMessage(new Error('{"code":"knowledge-vault-required","message":"Open a Vault"}'), "保存失败"),
    "请先建立或打开知识库",
  );
});

test("browser preview remains an independent document adapter", async () => {
  let invokeCalls = 0;
  const client = createKnowledgeClient({
    isTauri: () => false,
    invoke: async () => {
      invokeCalls += 1;
      throw new Error("Rust must not be used by preview");
    },
    preview: browserPreviewKnowledgeAdapter,
  });
  const title = `Preview ${Date.now()}`;
  const created = await client.createDocument({ title, content: "preview body" });
  const listed = await client.listDocuments();
  const read = await client.readDocument(created.documentRef);

  assert.equal(invokeCalls, 0);
  assert.ok(listed.some((row) => row.documentRef.relativePath === created.documentRef.relativePath));
  assert.equal(read.content, "preview body");
  assert.equal(created.documentRef.vaultId, "browser-preview");
});

test("current editor context derives a canonical ref only from the active real Vault", () => {
  setActiveKnowledgeSource({ mode: "real-vault", vaultId: "vault-current" });
  assert.deepEqual(
    resolveKnowledgeDocumentRef({ id: "real-vault:Folder/Note.md", title: "Note" }),
    { vaultId: "vault-current", relativePath: "Folder/Note.md" },
  );

  clearActiveKnowledgeSource();
  assert.equal(resolveKnowledgeDocumentRef({ id: "legacy-db-id", title: "Legacy" }), null);
});

test("persisted legacy database source state is ignored instead of activating note storage", () => {
  setActiveKnowledgeSource({ mode: "db", vaultId: "legacy" } as never);
  assert.equal(readActiveKnowledgeSource(), null);
});

test("Collection and Notes production entry points no longer invoke legacy DB note adapters", async () => {
  const [collection, compatibility, notesPage] = await Promise.all([
    readFile(new URL("../src/features/collection/CollectionPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/core/services/notes.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(collection, /insertIntoCurrentKnowledgeDocument/);
  assert.match(collection, /createKnowledgeDocument/);
  assert.doesNotMatch(collection, /services\/notes|collectionSingleToNote|collectionBatchToNote/);
  assert.doesNotMatch(compatibility, /getLuckyRayBridgeSync|localApiFetch/);
  assert.ok((collection.match(/knowledgeDocumentNoteId\(/g) || []).length >= 3);
  assert.match(notesPage, /resolveKnowledgeNoteNavigation\(pendingFocus\.id, currentVault\?\.id\)/);

  const processedRef = { vaultId: "vault-processed", relativePath: "Inbox/Processed.md" };
  const processedNoteId = knowledgeDocumentNoteId(processedRef);
  assert.deepEqual(parseKnowledgeDocumentNoteId(processedNoteId), processedRef);
  assert.equal(processedNoteId.startsWith("real-vault:"), false);
});

test("Knowledge fixed index edges share the main sidebar motion timeline", async () => {
  const [shellCss, notesCss] = await Promise.all([
    readFile(new URL("../src/app/appShell.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/notes/notes.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    shellCss,
    /\.react-nav-shell \.sidebar\s*\{[^}]*transition:\s*width var\(--transition\), min-width var\(--transition\), transform var\(--transition\);/u,
    "the main navigation owns the existing shared motion timeline",
  );
  assert.match(
    notesCss,
    /\.note-backlinks\s*\{[^}]*transition:[^;]*left var\(--transition\)[^;]*;/u,
    "the fixed Knowledge index must move with the main navigation",
  );
  assert.match(
    notesCss,
    /\.notes-index-resize-handle\s*\{[^}]*transition:[^;]*left var\(--transition\)[^;]*;/u,
    "the coupled fixed resize edge must move on the same timeline",
  );
  assert.match(
    notesCss,
    /\.react-nav-shell\[data-route="notes"\] \.sidebar\.collapsed ~ \.main \.note-backlinks\.open\s*\{\s*left:\s*60px;/u,
  );
  assert.match(
    notesCss,
    /\.react-nav-shell\[data-route="notes"\] \.sidebar\.collapsed ~ \.main \.notes-index-resize-handle\s*\{\s*left:\s*calc\(60px \+ var\(--notes-index-width\) - 3px\);/u,
  );
  assert.match(
    notesCss,
    /\.notes-index-resizing \.editor-row,\s*\.notes-index-resizing \.note-backlinks,\s*\.notes-index-resizing \.notes-index-resize-handle,\s*\.notes-index-resizing \.react-nav-shell \.titlebar-tabs\s*\{\s*transition:\s*none !important;/u,
    "live custom-width dragging must remain immediate",
  );
  assert.match(
    shellCss,
    /:root\[data-animations="off"\] \.react-nav-shell \*[\s\S]*transition-duration:\s*0\.01ms !important;/u,
    "the existing animations-off setting still disables the synchronized motion",
  );
});

test("publisher dispose keeps the Backend current note across route detach; explicit clear drops it", async () => {
  setActiveKnowledgeSource({ mode: "real-vault", vaultId: "browser-preview", rootPath: "/tmp/vault" });
  const knowledge = await import("../src/core/services/knowledge.ts");
  const publisher = createCurrentNoteContextPublisher();
  // Preview adapter requires the target document to exist before the editor
  // context can be set against it.
  await knowledge.createKnowledgeDocument({
    title: "A",
    content: "# A",
    parentRelativePath: "Inbox",
  });

  const writePromise = publisher.write({
    noteId: "real-vault:Inbox/A.md",
    documentRef: { vaultId: "browser-preview", relativePath: "Inbox/A.md" },
    expectedRevision: null,
    cursorOffset: 0,
    selection: null,
  });
  await writePromise.catch((error: unknown) => {
    assert.fail(`publisher.write failed: ${String(error)}`);
  });
  const before = await knowledge.getCurrentKnowledgeContext();
  assert.equal(before?.documentRef.relativePath, "Inbox/A.md");

  // Simulate NotesPage route detach / Activity hidden: dispose must NOT clear.
  publisher.dispose();
  const after = await knowledge.getCurrentKnowledgeContext();
  assert.equal(after?.documentRef.relativePath, "Inbox/A.md", "route detach must keep the Backend current note");

  // Explicit close/delete/Vault switch still clears. The current (visible)
  // editor uses a fresh publisher; the retired one cannot write anymore.
  const { clearCurrentNoteContext } = await import("../src/core/services/context.ts");
  const livePublisher = createCurrentNoteContextPublisher();
  clearCurrentNoteContext(livePublisher);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cleared = await knowledge.getCurrentKnowledgeContext();
  assert.equal(cleared, null, "explicit clear must drop the Backend current note");

  clearActiveKnowledgeSource();
});
