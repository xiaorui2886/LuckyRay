// Mac Note Move Lifecycle, AST link scope, file identity binding, and vault boundary tests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { posix, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRealVaultDocumentSource } from "../src/features/notes/documentSource.ts";
import { advanceNotesSavedReadProof } from "../src/features/notes/notesNativeViewRegistry.ts";
import { reconcileMovedNoteContent, rebaseMarkdownContent } from "../src/features/notes/reconcileMovedNote.ts";

const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
const native = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const flow = await readFile(new URL("../src-tauri/src/macos_note_flow.rs", import.meta.url), "utf8");
const extract = (text: string, start: string, end: string) => {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert(a >= 0 && b > a, `missing production block: ${start}`);
  return text.slice(a, b);
};
const movingNative = extract(native, "fn move_notes_vault_markdown_file(", "#[tauri::command]\nfn move_notes_vault_folder(");
const movedGate = extract(flow, "    fn moved(&self)", "    fn final_files(");
assert.match(movingNative, /std::fs::rename\(&source, &target\)/);
assert(!movingNative.includes("move_document_with_services"));
assert(movedGate.includes('../attachments/note-flow.png'));
assert(movedGate.includes('MARKER'));

const mapping = extract(page, "  const moveRealVaultRuntimeEntry = useCallback(", "  const rewriteRealVaultFolderRuntimePaths = useCallback(");
const move = extract(page, "  const moveNote = useCallback(", "  const commitFilename = useCallback(");
const compiled = stripTypeScriptTypes(`${mapping}\n${move}\n;({ moveNote, renameMacNote });`, { mode: "strip" });
const saveMoveGuard = extract(page, "    const moving = realVaultMoveInFlightRef.current.get(noteId);", "    setSaving(true);");
const originalId = "real-vault:Synthetic.md", movedId = "real-vault:Moved/Synthetic.md";
const original = "# Synthetic\n\n![fixture](attachments/note-flow.png)\n\nSaved by the native note flow.\n";
const desired = original.replace("](attachments/", "](../attachments/");
const validProof = "note-source-v1:" + "a".repeat(64);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function harness(
  moveDocument: (...args: string[]) => Promise<unknown>,
  options?: {
    vaultId?: string;
    loadRealVaultTree?: () => Promise<void>;
    renameDocument?: (...args: any[]) => Promise<unknown>;
  }
) {
  const vaultId = options?.vaultId ?? "synthetic";
  let sessionGeneration = 1;
  const currentVault = { id: vaultId, rootPath: "/synthetic" };
  let activeSource: { mode: "real-vault"; vaultId: string; sourceEpoch: number } | null = {
    mode: "real-vault",
    vaultId: currentVault.id,
    sourceEpoch: 1,
  };
  const saved = new Map([[originalId, original]]), latest = new Map([[originalId, original]]);
  const dirty = new Set<string>(), statuses: string[] = [];
  const saveCalls: Array<{ patch: { contentText?: string }; noteId: string }> = [];
  const readProofs = new Map<string, { generation?: number; source?: object; revision: string; fileIdentity?: string; workspaceSourceId: string; content: string }>([
    [originalId, { generation: 1, source: activeSource, revision: sha256(original), fileIdentity: "dev-1-ino-1001", workspaceSourceId: validProof, content: original }],
  ]);
  const selectedNoteIdRef = { current: originalId }, selectedNoteRef = { current: null as unknown }, noteLoadRequestRef = { current: 0 };
  const allNotes: Array<{ id: string; title: string; contentText: string; relativePath?: string }> = [
    { id: originalId, title: "Synthetic", contentText: original, relativePath: "Synthetic.md" },
  ];

  const vaultSessionRef = {
    current: {
      latest: () => sessionGeneration,
      isCurrent: (gen: number, vId?: string) => gen === sessionGeneration && (!vId || vId === currentVault.id),
      begin: (nextVaultId: string) => {
        sessionGeneration += 1;
        currentVault.id = nextVaultId;
        activeSource = { mode: "real-vault", vaultId: nextVaultId, sourceEpoch: sessionGeneration };
      },
    },
  };

  const context: Record<string, unknown> = {
    useCallback: (fn: unknown) => fn,
    realVaultSavedContentRef: { current: saved }, realVaultLatestContentRef: { current: latest }, realVaultUserDirtyRef: { current: dirty },
    realVaultReadProofRef: { current: readProofs },
    realVaultMoveInFlightRef: { current: new Map() }, realVaultSaveInFlightRef: { current: new Set() },
    pendingPatchRef: { current: {} }, pendingPatchNoteIdRef: { current: null }, saveTimerRef: { current: null },
    clearTimeout, isMacPlatform: () => true,
    savePatch: async (patch: { contentText?: string }, noteId: string) => { saveCalls.push({ patch, noteId }); },
    realVaultKeepEditingAfterConflictRef: { current: new Set() },
    commitCurrentEditorDraftRef: { current: () => {} },
    flushPendingSaveRef: { current: () => {} },
    setRealVaultExternalConflict: (_: unknown) => {}, liveEditorRef: { current: null }, notesViewRefsRef: { current: new Map() },
    notesNativeViews: { notifyViews() {} },
    notesPaneViewsRef: { current: { renameDocument() {} } }, setNamingNoteId: (_: unknown) => {}, setOpenTabs: (_: unknown) => {},
    notes: allNotes,
    setNotes: (updater: unknown) => {
      if (typeof updater === "function") {
        const next = (updater as (cur: typeof allNotes) => typeof allNotes)(allNotes);
        allNotes.length = 0;
        allNotes.push(...next);
      }
    },
    selectedNoteIdRef, selectedNoteRef, noteLoadRequestRef, setSelectedNoteId: (id: string) => { selectedNoteIdRef.current = id; },
    setSelectedNote: (note: unknown) => { selectedNoteRef.current = note; }, setEditTitle: (_: unknown) => {}, editContent: original,
    setEditContent: (value: string) => { context.editContent = value; }, setSourceContentDraft: (_: unknown) => {},
    noteFromKnowledgeDocument: (doc: { relativePath?: string; id?: string; contentText: string; title?: string }) => {
      const rel = doc.relativePath || doc.id || "";
      return { id: `real-vault:${rel}`, title: doc.title || "Synthetic", contentText: doc.contentText, relativePath: rel };
    },
    t: (value: string) => value, setStatus: (value: string) => statuses.push(value),
    isRealVaultNoteId: (id: string) => id.startsWith("real-vault:"),
    realVaultRelativePathFromNoteId: (id: string) => id.slice("real-vault:".length),
    blockRealVaultDocumentOperationIfDirty: (id: string) => dirty.has(id),
    setMoveModal: (_: unknown) => {}, realVaultDocumentSource: { moveDocument, renameDocument: options?.renameDocument },
    loadRealVaultTree: options?.loadRealVaultTree ?? (async () => {}),
    selectNote: async () => {}, selectedNoteId: originalId,
    bridge: null, loadNotes: async () => {}, updateNoteLocal: () => {},
    currentVault,
    vaultSessionRef,
    readActiveKnowledgeWriteSource: () => activeSource,
    reconcileMovedNoteContent,
  };

  const actions = vm.runInNewContext(compiled, context) as {
    moveNote: (id: string, folder: string) => Promise<void>;
    renameMacNote: (id: string, name: string, selectAfter: boolean) => Promise<string>;
  };
  return {
    invokeMove: actions.moveNote, invokeRename: actions.renameMacNote,
    saved, latest, dirty, readProofs, statuses, context, currentVault, vaultSessionRef, allNotes, saveCalls,
  };
}

test("Mac page rename queues input made during the protected mutation for the new path", async () => {
  let finish!: (value: unknown) => void;
  const calls: unknown[] = [];
  const pending = new Promise(resolve => { finish = resolve; });
  const state = harness(async () => { throw new Error("unexpected move"); }, {
    renameDocument: async (...args: unknown[]) => { calls.push(args); return pending; },
  });
  const result = state.invokeRename(originalId, "Renamed", false);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  const proof = calls[0] as [{ revision: string; fileIdentity: string; relativePath: string }, string];
  assert.equal(proof[0].revision, sha256(original));
  assert.equal(proof[0].fileIdentity, "dev-1-ino-1001");
  assert.equal(proof[0].relativePath, "Synthetic.md");
  assert.equal(proof[1], "Renamed");
  const draft = original + "\nInput during rename.\n";
  state.latest.set(originalId, draft); state.dirty.add(originalId);
  (state.context.pendingPatchNoteIdRef as { current: string | null }).current = originalId;
  (state.context.pendingPatchRef as { current: object }).current = { contentText: draft };
  finish({ id: "Renamed.md", relativePath: "Renamed.md", title: "Renamed", contentText: original,
    revision: sha256(original), fileIdentity: "dev-1-ino-renamed", workspaceSourceId: validProof });
  assert.equal(await result, "real-vault:Renamed.md");
  assert.equal(state.latest.get("real-vault:Renamed.md"), draft);
  assert.equal(state.readProofs.has(originalId), false);
  assert.equal(state.readProofs.get("real-vault:Renamed.md")?.fileIdentity, "dev-1-ino-renamed");
  assert.equal(state.saveCalls.length, 1);
  assert.equal(state.saveCalls[0].noteId, "real-vault:Renamed.md");
  assert.equal(state.saveCalls[0].patch.contentText, draft);
  assert.equal((state.context.pendingPatchNoteIdRef as { current: string | null }).current, null);
});

test("Mac page rename discards a completion from a retired vault session", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const state = harness(async () => { throw new Error("unexpected move"); }, { renameDocument: async () => pending });
  const result = state.invokeRename(originalId, "Renamed", false);
  await Promise.resolve();
  state.vaultSessionRef.current.begin("synthetic");
  finish({ id: "Renamed.md", relativePath: "Renamed.md", title: "Renamed", contentText: original });
  await assert.rejects(result, /sourceChangedRetry/);
  assert.equal(state.allNotes[0].id, originalId);
  assert.equal(state.saveCalls.length, 0);
});

test("Mac page rename keeps an in-flight draft when the protected mutation fails", async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise((_, reject) => { fail = reject; });
  const state = harness(async () => { throw new Error("unexpected move"); }, { renameDocument: async () => pending });
  const result = state.invokeRename(originalId, "Renamed", false);
  await Promise.resolve();
  const draft = original + "\nUnsaved input.\n";
  state.latest.set(originalId, draft); state.dirty.add(originalId);
  fail(new Error("identity changed"));
  await assert.rejects(result, /identity changed/);
  assert.equal(state.latest.get(originalId), draft);
  assert(state.dirty.has(originalId));
  assert.equal(state.saveCalls.length, 0);
});

test("Mac path changes never carry a retired session's proof to a replacement path", async () => {
  let requested: any;
  const state = harness(async ref => {
    requested = ref;
    return { id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired,
      revision: sha256(desired), fileIdentity: "new-inode", workspaceSourceId: validProof };
  });
  state.vaultSessionRef.current.begin("synthetic");
  state.context.selectedNoteIdRef.current = "real-vault:Another.md";
  await state.invokeMove(originalId, "Moved");
  assert.equal(requested.revision, undefined);
  assert.equal(requested.fileIdentity, undefined);
  assert.equal(state.readProofs.has(originalId), false);
  assert.equal(state.readProofs.has(movedId), false);
});

test("Mac selected notes cannot move or rename without a current read proof", async () => {
  let mutations = 0;
  const state = harness(async () => { mutations++; return {}; }, { renameDocument: async () => { mutations++; return {}; } });
  state.vaultSessionRef.current.begin("synthetic");
  await state.invokeMove(originalId, "Moved");
  assert(state.statuses.includes("editor.notes.status.reopenBeforeMove"));
  await assert.rejects(state.invokeRename(originalId, "Renamed", false), /reopenBeforeMove/);
  assert.equal(mutations, 0);
});

test("Mac rename drops an old-path proof when the returned vault authority differs", async () => {
  const state = harness(async () => { throw new Error("unexpected move"); }, {
    renameDocument: async () => ({ id: "Renamed.md", relativePath: "Renamed.md", title: "Renamed", contentText: original,
      revision: sha256(original), fileIdentity: "new-inode", workspaceSourceId: `note-source-v1:${"b".repeat(64)}` }),
  });
  await state.invokeRename(originalId, "Renamed", false);
  assert.equal(state.readProofs.has(originalId), false);
  assert.equal(state.readProofs.has("real-vault:Renamed.md"), false);
});

async function renamedFixture() {
  const root = await mkdtemp(join(tmpdir(), "luckyray-move-chain-"));
  await mkdir(join(root, "Moved"));
  await mkdir(join(root, "attachments"));
  await writeFile(join(root, "Synthetic.md"), original);
  await writeFile(join(root, "attachments", "note-flow.png"), "FAKE_PNG_BYTES");
  const vault = { id: "synthetic", name: "Synthetic", rootPath: root, mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
  const calls: unknown[] = [];
  const fileIdentities = new Map<string, string>([["Synthetic.md", "dev-1-ino-1001"]]);

  const bridge = {
    // This is an OS-level simulation of the inspected native rename, not Rust.
    async moveNotesVaultMarkdownFile(input: { relativePath: string; targetParentRelativePath: string }) {
      calls.push(input);
      const destination = posix.join(input.targetParentRelativePath, input.relativePath);
      await rename(join(root, input.relativePath), join(root, destination));
      const contentText = await readFile(join(root, destination), "utf8");
      return { name: "Synthetic.md", relativePath: destination, absolutePath: join(root, destination),
        contentText, mtime: null, size: Buffer.byteLength(contentText) };
    },
  };
  const documents = {
    read: async (input: { relativePath: string }) => {
      const content = await readFile(join(root, input.relativePath), "utf8");
      return {
        documentRef: { vaultId: vault.id, relativePath: input.relativePath },
        relativePath: input.relativePath,
        title: "Synthetic",
        content,
        revision: sha256(content),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(content),
        workspaceSourceId: validProof,
        fileIdentity: fileIdentities.get(input.relativePath) ?? "dev-1-ino-1001",
      };
    },
    replace: async (target: { vaultId: string; relativePath: string }, content: string, expectedRevision?: string) => {
      const targetPath = join(root, target.relativePath);
      const currentOnDisk = await readFile(targetPath, "utf8");
      if (expectedRevision && sha256(currentOnDisk) !== expectedRevision) {
        throw new Error("knowledge-revision-conflict: Document changed on disk");
      }
      await writeFile(targetPath, content, "utf8");
      const rev = sha256(content);
      return {
        document: {
          documentRef: { vaultId: vault.id, relativePath: target.relativePath },
          relativePath: target.relativePath,
          title: "Synthetic",
          content,
          revision: rev,
          modifiedAt: "2026-11-03",
          size: Buffer.byteLength(content),
          workspaceSourceId: validProof,
          fileIdentity: fileIdentities.get(target.relativePath) ?? "dev-1-ino-1001",
        },
      };
    },
    async move(
      documentRef: { vaultId: string; relativePath: string; fileIdentity?: string },
      title: string,
      expectedRevision: string,
      parentRelativePath?: string | null,
      expectedFileIdentity?: string | null,
    ) {
      calls.push({ documentRef, title, expectedRevision, parentRelativePath, expectedFileIdentity });
      const sourcePath = join(root, documentRef.relativePath);
      const sourceContent = await readFile(sourcePath, "utf8");
      if (expectedRevision && sha256(sourceContent) !== expectedRevision) {
        throw new Error("knowledge-revision-conflict: Stale expected revision");
      }
      const actualIdentity = fileIdentities.get(documentRef.relativePath);
      if (expectedFileIdentity && actualIdentity && actualIdentity !== expectedFileIdentity) {
        throw new Error("knowledge-document-identity-mismatch: File object was replaced since read");
      }
      const destination = posix.join(parentRelativePath || "", documentRef.relativePath);
      const movedContent = rebaseMarkdownContent(documentRef.relativePath, destination, sourceContent);
      await rm(sourcePath);
      await writeFile(join(root, destination), movedContent, "utf8");
      const rev = sha256(movedContent);
      fileIdentities.delete(documentRef.relativePath);
      fileIdentities.set(destination, actualIdentity ?? "dev-1-ino-1001");
      return {
        documentRef: { vaultId: vault.id, relativePath: destination },
        relativePath: destination,
        title: "Synthetic",
        content: movedContent,
        revision: rev,
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(movedContent),
        workspaceSourceId: validProof,
        fileIdentity: actualIdentity ?? "dev-1-ino-1001",
      };
    },
  };
  const prevPlatform = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });
  try {
    const source = createRealVaultDocumentSource({
      vault,
      documents,
      bridge,
    });
    const h = harness((path, folder) => source.moveDocument(path, folder));
    await h.invokeMove(originalId, "Moved");
    const result = await readFile(join(root, "Moved", "Synthetic.md"), "utf8");
    return { root, calls, result, h, source, documents, fileIdentities };
  } finally {
    if (prevPlatform) Object.defineProperty(globalThis, "navigator", prevPlatform);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
}

async function inputDuringMove() {
  let release!: (value: unknown) => void;
  const deferred = new Promise(resolve => { release = resolve; });
  const h = harness(() => deferred);
  const pending = h.invokeMove(originalId, "Moved");
  const typed = original + "User input while the move is pending.\n";
  h.latest.set(originalId, typed);
  h.dirty.add(originalId);
  // Backend move returns the dynamically moved content
  release({ id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired });
  await pending;
  const expectedReconciled = desired + "User input while the move is pending.\n";
  return { ...h, typed, expectedReconciled };
}

test("desired: moving a note preserves its attachment target", async () => {
  const x = await renamedFixture();
  try {
    assert.equal(x.calls.length, 1);
    assert.equal(x.result, desired);
    assert(x.result.includes("../attachments/note-flow.png"));
    assert.equal(x.h.context.selectedNoteIdRef.current, movedId);
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

test("desired: input arriving during a move remains an unsaved draft with rebased links", async () => {
  const x = await inputDuringMove();
  assert.equal(x.dirty.has(movedId), true);
  // Both user draft AND rewritten relative link must be present in latestContent
  assert.equal(x.latest.get(movedId), x.expectedReconciled);
  assert.equal(x.context.editContent, x.expectedReconciled);
  assert(x.context.editContent.includes("../attachments/note-flow.png"));
  assert(x.context.editContent.includes("User input while the move is pending."));
  assert.notEqual(x.typed, desired);
});

test("the production page retains Windows mapping and uses Mac reconciliation on Mac", async () => {
  for (const mac of [false, true]) {
    let release!: (value: unknown) => void;
    const deferred = new Promise(resolve => { release = resolve; });
    const h = harness(() => deferred);
    h.context.isMacPlatform = () => mac;
    const pending = h.invokeMove(originalId, "Moved");
    h.latest.set(originalId, original + "![external](../outside.png)\n");
    h.dirty.add(originalId);
    release({ id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired });
    await pending;
    assert.equal(h.latest.get(movedId), mac ? desired + "![external](../../outside.png)\n" : desired);
    assert.equal(h.dirty.has(movedId), mac);
  }
});

test("the Windows move route retains the released string argument and dirty veto", async () => {
  const calls: unknown[] = [];
  const h = harness(async (ref, folder) => {
    calls.push({ ref, folder });
    return { id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired };
  });
  h.context.isMacPlatform = () => false;
  h.context.commitCurrentEditorDraftRef = { current: () => { throw new Error("Windows must not run the Mac draft hook"); } };
  h.context.flushPendingSaveRef = { current: () => { throw new Error("Windows must not run the Mac save hook"); } };
  h.dirty.add(originalId);
  await h.invokeMove(originalId, "Moved");
  assert.equal(calls.length, 0);
  h.dirty.clear();
  await h.invokeMove(originalId, "Moved");
  assert.deepEqual(calls, [{ ref: "Synthetic.md", folder: "Moved" }]);
  assert.equal(h.latest.get(movedId), desired);
});

test("the Windows background-note mapping retains the prior runtime draft", async () => {
  let release!: (value: unknown) => void;
  const deferred = new Promise(resolve => { release = resolve; });
  const h = harness(() => deferred);
  h.context.isMacPlatform = () => false;
  h.context.selectedNoteIdRef.current = "real-vault:Another.md";
  const pending = h.invokeMove(originalId, "Moved");
  const typed = original + "Background input.\n";
  h.latest.set(originalId, typed);
  h.dirty.add(originalId);
  release({ id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired });
  await pending;
  assert.equal(h.latest.get(movedId), typed);
  assert.equal(h.saved.get(movedId), original);
  assert.equal(h.dirty.has(movedId), true);
  assert.equal(h.context.selectedNoteIdRef.current, "real-vault:Another.md");
});

test("full end-to-end lifecycle: move, in-flight input, save, reopen and verify attachment target", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-e2e-move-"));
  await mkdir(join(root, "Moved"));
  await mkdir(join(root, "attachments"));
  await writeFile(join(root, "Synthetic.md"), original);
  await writeFile(join(root, "attachments", "note-flow.png"), "REAL_PNG_DATA");
  const vault = { id: "synthetic", name: "Synthetic", rootPath: root, mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
  const fileIdentities = new Map<string, string>([["Synthetic.md", "dev-1-ino-5001"]]);

  const documents = {
    read: async (input: { relativePath: string }) => {
      const content = await readFile(join(root, input.relativePath), "utf8");
      return {
        documentRef: { vaultId: vault.id, relativePath: input.relativePath },
        relativePath: input.relativePath,
        title: "Synthetic",
        content,
        revision: sha256(content),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(content),
        workspaceSourceId: validProof,
        fileIdentity: fileIdentities.get(input.relativePath) ?? "dev-1-ino-5001",
      };
    },
    replace: async (target: { vaultId: string; relativePath: string }, content: string, expectedRevision?: string) => {
      const targetPath = join(root, target.relativePath);
      const currentOnDisk = await readFile(targetPath, "utf8");
      if (expectedRevision && sha256(currentOnDisk) !== expectedRevision) {
        throw new Error("knowledge-revision-conflict: Document changed on disk");
      }
      await writeFile(targetPath, content, "utf8");
      const rev = sha256(content);
      return {
        document: {
          documentRef: { vaultId: vault.id, relativePath: target.relativePath },
          relativePath: target.relativePath,
          title: "Synthetic",
          content,
          revision: rev,
          modifiedAt: "2026-11-03",
          size: Buffer.byteLength(content),
          workspaceSourceId: validProof,
          fileIdentity: fileIdentities.get(target.relativePath) ?? "dev-1-ino-5001",
        },
      };
    },
    async move(
      documentRef: { vaultId: string; relativePath: string; fileIdentity?: string },
      title: string,
      expectedRevision: string,
      parentRelativePath?: string | null,
      expectedFileIdentity?: string | null,
    ) {
      const sourcePath = join(root, documentRef.relativePath);
      const sourceContent = await readFile(sourcePath, "utf8");
      const actualIdentity = fileIdentities.get(documentRef.relativePath);
      if (expectedFileIdentity && actualIdentity && actualIdentity !== expectedFileIdentity) {
        throw new Error("knowledge-document-identity-mismatch: File object replaced");
      }
      const destination = posix.join(parentRelativePath || "", documentRef.relativePath);
      const movedContent = rebaseMarkdownContent(documentRef.relativePath, destination, sourceContent);
      await rm(sourcePath);
      await writeFile(join(root, destination), movedContent, "utf8");
      const rev = sha256(movedContent);
      fileIdentities.delete(documentRef.relativePath);
      fileIdentities.set(destination, actualIdentity ?? "dev-1-ino-5001");
      return {
        documentRef: { vaultId: vault.id, relativePath: destination },
        relativePath: destination,
        title: "Synthetic",
        content: movedContent,
        revision: rev,
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(movedContent),
        workspaceSourceId: validProof,
        fileIdentity: actualIdentity ?? "dev-1-ino-5001",
      };
    },
  };

  const prevPlatform = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });

  try {
    const source = createRealVaultDocumentSource({ vault, documents });
    // First open the document to seed openedRevisions and openedFileIdentities
    await source.openDocument("Synthetic.md");

    // 1. Start move, simulating async delay
    let resolveMove!: () => void;
    const moveGate = new Promise<void>(res => { resolveMove = res; });
    const h = harness(async (path, folder) => {
      await moveGate;
      return await source.moveDocument(path, folder);
    });
    h.readProofs.set(originalId, {
      generation: 1,
      source: h.context.readActiveKnowledgeWriteSource() as any,
      revision: sha256(original),
      fileIdentity: "dev-1-ino-5001",
      workspaceSourceId: validProof,
      content: original,
    });

    const pendingMove = h.invokeMove(originalId, "Moved");

    // 2. User types in editor while move is in flight
    const typedDuringMove = original + "Added crucial observation during move.\n";
    h.latest.set(originalId, typedDuringMove);
    h.dirty.add(originalId);

    // Let move finish
    resolveMove();
    await pendingMove;

    // 3. Assert draft and links are reconciled in UI state
    assert.equal(h.dirty.has(movedId), true);
    const reconciledContent = h.context.editContent as string;
    assert(reconciledContent.includes("../attachments/note-flow.png"));
    assert(reconciledContent.includes("Added crucial observation during move."));
    assert(!reconciledContent.includes("![fixture](attachments/note-flow.png)"));

    // 4. Save the document to disk
    await source.saveDocument("Moved/Synthetic.md", reconciledContent);

    // 5. Reopen the document from disk and verify
    const reopened = await source.openDocument("Moved/Synthetic.md");
    assert(reopened.contentText.includes("Added crucial observation during move."));
    assert(reopened.contentText.includes("../attachments/note-flow.png"));
    assert(!reopened.contentText.includes("![fixture](attachments/note-flow.png)"));

    // 6. Verify relative attachment resolves to the actual file
    const attachmentRelative = "../attachments/note-flow.png";
    const resolvedPathInVault = posix.normalize(posix.join("Moved", attachmentRelative));
    assert.equal(resolvedPathInVault, "attachments/note-flow.png");
    const attachmentBytes = await readFile(join(root, resolvedPathInVault), "utf8");
    assert.equal(attachmentBytes, "REAL_PNG_DATA");
  } finally {
    if (prevPlatform) Object.defineProperty(globalThis, "navigator", prevPlatform);
    else delete (globalThis as Record<string, unknown>).navigator;
    await rm(root, { recursive: true, force: true });
  }
});

test("vault session guard: switching vaults during move drops late-arriving result and protects new vault", async () => {
  let releaseMove!: (value: unknown) => void;
  const movePromise = new Promise(resolve => { releaseMove = resolve; });
  const h = harness(() => movePromise, { vaultId: "vault-A" });

  // Start move in vault-A
  const pending = h.invokeMove(originalId, "Moved");

  // User switches to vault-B while move is in flight
  h.vaultSessionRef.current.begin("vault-B");

  // Move in vault-A completes late
  releaseMove({ id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired });
  await pending;

  // Assert: vault-B was NOT polluted!
  assert.equal(h.saved.has(movedId), false);
  assert.equal(h.latest.has(movedId), false);
  assert.equal(h.dirty.has(movedId), false);
});

test("note switching guard: switching note during move updates background runtime without interrupting active note", async () => {
  let releaseMove!: (value: unknown) => void;
  const movePromise = new Promise(resolve => { releaseMove = resolve; });
  const h = harness(() => movePromise);

  const otherNoteId = "real-vault:OtherNote.md";
  h.saved.set(otherNoteId, "# Other Note\nActive content\n");
  h.latest.set(otherNoteId, "# Other Note\nActive content\n");

  // Start move of originalId
  const pending = h.invokeMove(originalId, "Moved");

  // User clicks otherNoteId: selectedNoteIdRef.current changes to otherNoteId
  (h.context.selectedNoteIdRef as { current: string }).current = otherNoteId;
  h.context.editContent = "# Other Note\nActive content\n";

  // Move of originalId completes
  releaseMove({ id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired });
  await pending;

  // Assert: active editor still displays otherNoteId, not interrupted!
  assert.equal((h.context.selectedNoteIdRef as { current: string }).current, otherNoteId);
  assert.equal(h.context.editContent, "# Other Note\nActive content\n");

  // Background runtime for moved note was updated
  assert.equal(h.saved.has(movedId), true);
  assert.equal(h.latest.has(movedId), true);
});

test("object identity guard: replacing file object at same path with same content hash prevents move", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-identity-"));
  await mkdir(join(root, "Moved"));
  await writeFile(join(root, "Synthetic.md"), original);
  const vault = { id: "synthetic", name: "Synthetic", rootPath: root, mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };

  let currentFileIdentity = "dev-1-ino-1001";
  const documents = {
    read: async (input: { relativePath: string }) => {
      const content = await readFile(join(root, input.relativePath), "utf8");
      return {
        documentRef: { vaultId: vault.id, relativePath: input.relativePath },
        relativePath: input.relativePath,
        title: "Synthetic",
        content,
        revision: sha256(content),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(content),
        workspaceSourceId: validProof,
        fileIdentity: currentFileIdentity,
      };
    },
    async move(
      documentRef: { vaultId: string; relativePath: string },
      _title: string,
      _expectedRevision: string,
      _parentRelativePath?: string | null,
      expectedFileIdentity?: string | null,
    ) {
      if (expectedFileIdentity && currentFileIdentity !== expectedFileIdentity) {
        throw new Error("knowledge-document-identity-mismatch: File object was replaced since read");
      }
      assert.fail("the replaced object must never reach a successful move");
    },
  };

  const prevPlatform = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });

  try {
    const source = createRealVaultDocumentSource({ vault, documents: documents as any });
    // 1. Open document: records fileIdentity = "dev-1-ino-1001"
    const doc = await source.openDocument("Synthetic.md");
    assert.equal(doc.fileIdentity, "dev-1-ino-1001");

    // 2. File object replaced behind the scenes (same path, same content hash, different inode/object)
    currentFileIdentity = "dev-1-ino-2002";

    // 3. Move must be rejected because file identity does not match
    await assert.rejects(
      async () => {
        await source.moveDocument("Synthetic.md", "Moved");
      },
      (err: Error) => err.message.includes("knowledge-document-identity-mismatch")
    );
  } finally {
    if (prevPlatform) Object.defineProperty(globalThis, "navigator", prevPlatform);
    else delete (globalThis as Record<string, unknown>).navigator;
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: open note -> edit and save (atomic replace with new file identity) -> move succeeds with updated identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-lifecycle-save-move-"));
  await mkdir(join(root, "Moved"));
  await writeFile(join(root, "Synthetic.md"), original);
  const vault = { id: "synthetic", name: "Synthetic", rootPath: root, mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };

  let currentFileIdentity = "dev-1-ino-1001";
  const documents = {
    read: async (input: { relativePath: string }) => {
      const content = await readFile(join(root, input.relativePath), "utf8");
      return {
        documentRef: { vaultId: vault.id, relativePath: input.relativePath },
        relativePath: input.relativePath,
        title: "Synthetic",
        content,
        revision: sha256(content),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(content),
        workspaceSourceId: validProof,
        fileIdentity: currentFileIdentity,
      };
    },
    replace: async (target: { vaultId: string; relativePath: string }, content: string, expectedRevision?: string) => {
      const targetPath = join(root, target.relativePath);
      const currentOnDisk = await readFile(targetPath, "utf8");
      if (expectedRevision && sha256(currentOnDisk) !== expectedRevision) {
        throw new Error("knowledge-revision-conflict: Document changed on disk");
      }
      // Simulate an atomic replacement as well as a new identity.
      currentFileIdentity = "dev-1-ino-2002";
      const temporaryPath = `${targetPath}.synthetic-save`;
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, targetPath);
      const rev = sha256(content);
      return {
        document: {
          documentRef: { vaultId: vault.id, relativePath: target.relativePath },
          relativePath: target.relativePath,
          title: "Synthetic",
          content,
          revision: rev,
          modifiedAt: "2026-11-03",
          size: Buffer.byteLength(content),
          workspaceSourceId: validProof,
          fileIdentity: currentFileIdentity,
        },
      };
    },
    async move(
      documentRef: { vaultId: string; relativePath: string },
      _title: string,
      expectedRevision: string,
      _parentRelativePath?: string | null,
      expectedFileIdentity?: string | null,
    ) {
      if (expectedFileIdentity && currentFileIdentity !== expectedFileIdentity) {
        throw new Error(`knowledge-document-identity-mismatch: expected ${expectedFileIdentity}, got ${currentFileIdentity}`);
      }
      assert.equal(expectedFileIdentity, "dev-1-ino-2002");
      const sourcePath = join(root, documentRef.relativePath);
      const sourceContent = await readFile(sourcePath, "utf8");
      assert.equal(expectedRevision, sha256(sourceContent));
      const movedContent = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", sourceContent);
      await writeFile(join(root, "Moved", "Synthetic.md"), movedContent, "utf8");
      await rm(sourcePath);
      currentFileIdentity = "dev-1-ino-2003";
      return {
        documentRef: { vaultId: vault.id, relativePath: "Moved/Synthetic.md" },
        relativePath: "Moved/Synthetic.md",
        title: "Synthetic",
        content: movedContent,
        revision: sha256(movedContent),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(movedContent),
        workspaceSourceId: validProof,
        fileIdentity: currentFileIdentity,
      };
    },
  };

  const prevPlatform = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });

  try {
    const source = createRealVaultDocumentSource({ vault, documents: documents as any });
    // 1. Open document: records fileIdentity = "dev-1-ino-1001"
    const doc = await source.openDocument("Synthetic.md");
    assert.equal(doc.fileIdentity, "dev-1-ino-1001");

    // 2. Edit and save: atomic replace updates fileIdentity to "dev-1-ino-2002"
    const editedContent = original + "\nUser edit before save.";
    const savedDoc = await source.saveDocument(doc, editedContent);
    assert.equal(savedDoc.fileIdentity, "dev-1-ino-2002");

    // 3. Move document: must succeed using updated file identity "dev-1-ino-2002"
    const movedDoc = await source.moveDocument("Synthetic.md", "Moved");
    assert.equal(movedDoc.relativePath, "Moved/Synthetic.md");
    assert.equal(movedDoc.fileIdentity, "dev-1-ino-2003");
    const movedOnDisk = await readFile(join(root, "Moved", "Synthetic.md"), "utf8");
    assert.equal(movedDoc.contentText, movedOnDisk);
    assert.equal(movedDoc.revision, sha256(movedOnDisk));
    assert(movedOnDisk.includes("User edit before save."));
  } finally {
    if (prevPlatform) Object.defineProperty(globalThis, "navigator", prevPlatform);
    else delete (globalThis as Record<string, unknown>).navigator;
    await rm(root, { recursive: true, force: true });
  }
});

test("page move chain: background read cache refresh does NOT override caller's explicit snapshot A (move rejected)", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-page-identity-stale-"));
  await mkdir(join(root, "Moved"));
  await writeFile(join(root, "Synthetic.md"), original);
  const vault = { id: "synthetic", name: "Synthetic", rootPath: root, mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };

  let currentFileIdentity = "dev-1-ino-1001";
  const documents = {
    read: async (input: { relativePath: string }) => {
      const content = await readFile(join(root, input.relativePath), "utf8");
      return {
        documentRef: { vaultId: vault.id, relativePath: input.relativePath },
        relativePath: input.relativePath,
        title: "Synthetic",
        content,
        revision: sha256(content),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(content),
        workspaceSourceId: validProof,
        fileIdentity: currentFileIdentity,
      };
    },
    async move(
      documentRef: { vaultId: string; relativePath: string },
      _title: string,
      _expectedRevision: string,
      _parentRelativePath?: string | null,
      expectedFileIdentity?: string | null,
    ) {
      if (expectedFileIdentity && currentFileIdentity !== expectedFileIdentity) {
        throw new Error(`knowledge-document-identity-mismatch: expected ${expectedFileIdentity}, got ${currentFileIdentity}`);
      }
      assert.fail("the stale editor snapshot must never reach a successful move");
    },
  };

  const prevPlatform = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });

  try {
    const source = createRealVaultDocumentSource({ vault, documents: documents as any });
    // 1. Initial read: records fileIdentity = "dev-1-ino-1001" (Snapshot A)
    const docA = await source.openDocument("Synthetic.md");
    assert.equal(docA.fileIdentity, "dev-1-ino-1001");

    // Harness initialized with page holding snapshot A
    const h = harness((docRef, folder) => source.moveDocument(docRef, folder));
    h.readProofs.set(originalId, {
      generation: 1,
      source: h.context.readActiveKnowledgeWriteSource() as any,
      revision: sha256(original),
      fileIdentity: "dev-1-ino-1001",
      workspaceSourceId: validProof,
      content: original,
    });

    // 2. File object replaced on disk behind the scenes with B (same path, same content hash)
    currentFileIdentity = "dev-1-ino-2002";

    // 3. Background read occurs (e.g. indexing or another component), updating adapter cache to B
    const bgDoc = await source.openDocument("Synthetic.md");
    assert.equal(bgDoc.fileIdentity, "dev-1-ino-2002");

    // 4. Page attempts move using its existing editor snapshot A.
    // Caller's explicit snapshot A MUST take priority over adapter's background-refreshed cache!
    // Since expected (A: dev-1-ino-1001) !== on-disk (B: dev-1-ino-2002), the move MUST be rejected!
    await h.invokeMove(originalId, "Moved");

    // 4. Directly calling moveDocument with caller's explicit snapshot A MUST be rejected
    // because caller's snapshot A takes priority over adapter's background-refreshed cache B!
    const callerDocRef = {
      id: "Synthetic.md",
      relativePath: "Synthetic.md",
      revision: h.readProofs.get(originalId)?.revision,
      fileIdentity: h.readProofs.get(originalId)?.fileIdentity,
      vaultId: "synthetic",
    };
    await assert.rejects(
      async () => {
        await source.moveDocument(callerDocRef, "Moved");
      },
      (err: Error) => err.message.includes("knowledge-document-identity-mismatch")
    );

    // 5. Page attempts move using its existing editor snapshot A.
    // The page move operation must fail and report failure status:
    await h.invokeMove(originalId, "Moved");
    assert.equal(h.statuses.includes("editor.notes.status.markdownMoveFailed"), true);
    assert.equal(h.statuses.includes("editor.notes.status.markdownMoved"), false);
    // Destination file must NOT exist
    await assert.rejects(async () => readFile(join(root, "Moved", "Synthetic.md"), "utf8"));
  } finally {
    if (prevPlatform) Object.defineProperty(globalThis, "navigator", prevPlatform);
    else delete (globalThis as Record<string, unknown>).navigator;
    await rm(root, { recursive: true, force: true });
  }
});

test("page save and move chain: normal save updates page read proof with new identity, subsequent move succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-page-save-move-"));
  await mkdir(join(root, "Moved"));
  await writeFile(join(root, "Synthetic.md"), original);
  const vault = { id: "synthetic", name: "Synthetic", rootPath: root, mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };

  let currentFileIdentity = "dev-1-ino-1001";
  const documents = {
    read: async (input: { relativePath: string }) => {
      const content = await readFile(join(root, input.relativePath), "utf8");
      return {
        documentRef: { vaultId: vault.id, relativePath: input.relativePath },
        relativePath: input.relativePath,
        title: "Synthetic",
        content,
        revision: sha256(content),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(content),
        workspaceSourceId: validProof,
        fileIdentity: currentFileIdentity,
      };
    },
    replace: async (target: { vaultId: string; relativePath: string }, content: string, expectedRevision?: string) => {
      const targetPath = join(root, target.relativePath);
      const currentOnDisk = await readFile(targetPath, "utf8");
      if (expectedRevision && sha256(currentOnDisk) !== expectedRevision) {
        throw new Error("knowledge-revision-conflict: Document changed on disk");
      }
      // Simulate an atomic replacement as well as a new identity.
      currentFileIdentity = "dev-1-ino-3003";
      const temporaryPath = `${targetPath}.synthetic-save`;
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, targetPath);
      const rev = sha256(content);
      return {
        document: {
          documentRef: { vaultId: vault.id, relativePath: target.relativePath },
          relativePath: target.relativePath,
          title: "Synthetic",
          content,
          revision: rev,
          modifiedAt: "2026-11-03",
          size: Buffer.byteLength(content),
          workspaceSourceId: validProof,
          fileIdentity: currentFileIdentity,
        },
      };
    },
    async move(
      documentRef: { vaultId: string; relativePath: string },
      _title: string,
      expectedRevision: string,
      _parentRelativePath?: string | null,
      expectedFileIdentity?: string | null,
    ) {
      if (expectedFileIdentity && currentFileIdentity !== expectedFileIdentity) {
        throw new Error(`knowledge-document-identity-mismatch: expected ${expectedFileIdentity}, got ${currentFileIdentity}`);
      }
      const sourcePath = join(root, "Synthetic.md");
      const sourceContent = await readFile(sourcePath, "utf8");
      assert.equal(expectedRevision, sha256(sourceContent));
      const movedContent = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", sourceContent);
      const destPath = join(root, "Moved", "Synthetic.md");
      await writeFile(destPath, movedContent, "utf8");
      await rm(sourcePath);
      currentFileIdentity = "dev-1-ino-3004";
      return {
        documentRef: { vaultId: vault.id, relativePath: "Moved/Synthetic.md" },
        relativePath: "Moved/Synthetic.md",
        title: "Synthetic",
        content: movedContent,
        revision: sha256(movedContent),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(movedContent),
        workspaceSourceId: validProof,
        fileIdentity: currentFileIdentity,
      };
    },
  };

  const prevPlatform = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });

  try {
    const source = createRealVaultDocumentSource({ vault, documents: documents as any });
    // 1. Initial read: records fileIdentity = "dev-1-ino-1001"
    const doc = await source.openDocument("Synthetic.md");
    assert.equal(doc.fileIdentity, "dev-1-ino-1001");

    // Harness initialized with page holding snapshot A
    const h = harness((docRef, folder) => source.moveDocument(docRef, folder));
    h.readProofs.set(originalId, {
      generation: 1,
      source: h.context.readActiveKnowledgeWriteSource() as any,
      revision: sha256(original),
      fileIdentity: "dev-1-ino-1001",
      workspaceSourceId: validProof,
      content: original,
    });

    // 2. User edits and saves through the page's save chain
    const editedContent = original + "\nSaved through real page save chain.";
    const origin = { source: h.context.readActiveKnowledgeWriteSource() as any, generation: h.vaultSessionRef.current.latest() };
    const saved = await source.saveDocument(doc, editedContent);
    assert.equal(saved.fileIdentity, "dev-1-ino-3003");

    // Page updates read proof via advanceNotesSavedReadProof (exact logic in NotesPage.tsx)
    const prevProof = h.readProofs.get(originalId);
    const nextProof = advanceNotesSavedReadProof(prevProof, { content: saved.contentText, revision: saved.revision!, fileIdentity: saved.fileIdentity }, origin);
    assert(nextProof);
    h.readProofs.set(originalId, nextProof);
    assert.equal(h.readProofs.get(originalId)?.fileIdentity, "dev-1-ino-3003");

    // 3. User invokes move in the page
    await h.invokeMove(originalId, "Moved");

    // Move must succeed!
    assert.equal(h.statuses.includes("editor.notes.status.markdownMoved"), true);
    const movedOnDisk = await readFile(join(root, "Moved", "Synthetic.md"), "utf8");
    assert(movedOnDisk.includes("Saved through real page save chain."));
    assert.equal(h.saved.get(movedId), movedOnDisk);
    assert.equal(h.latest.get(movedId), movedOnDisk);
  } finally {
    if (prevPlatform) Object.defineProperty(globalThis, "navigator", prevPlatform);
    else delete (globalThis as Record<string, unknown>).navigator;
    await rm(root, { recursive: true, force: true });
  }
});

test("targeted: move and save preserves external link target, rebases wrapped local image, and retains edited content on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-targeted-move-save-"));
  await mkdir(join(root, "Moved"));
  await mkdir(join(root, "attachments"));

  const initialNote = `# System Architecture

Documentation portal:
[![Architecture Overview](attachments/architecture.png)](https\\://example.com/system-overview)

Initial baseline notes.
`;
  await writeFile(join(root, "Synthetic.md"), initialNote, "utf8");
  await writeFile(join(root, "attachments", "architecture.png"), "PNG_BYTES_ARCHITECTURE_DATA", "utf8");

  const vault = { id: "synthetic", name: "Synthetic", rootPath: root, mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };

  let currentFileIdentity = "dev-1-ino-1001";
  const fileIdentities = new Map<string, string>([["Synthetic.md", "dev-1-ino-1001"]]);

  const documents = {
    read: async (input: { relativePath: string }) => {
      const content = await readFile(join(root, input.relativePath), "utf8");
      return {
        documentRef: { vaultId: vault.id, relativePath: input.relativePath },
        relativePath: input.relativePath,
        title: "Synthetic",
        content,
        revision: sha256(content),
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(content),
        workspaceSourceId: validProof,
        fileIdentity: fileIdentities.get(input.relativePath) ?? currentFileIdentity,
      };
    },
    replace: async (target: { vaultId: string; relativePath: string }, content: string, expectedRevision?: string) => {
      const targetPath = join(root, target.relativePath);
      const currentOnDisk = await readFile(targetPath, "utf8");
      if (expectedRevision && sha256(currentOnDisk) !== expectedRevision) {
        throw new Error("knowledge-revision-conflict: Document changed on disk");
      }
      currentFileIdentity = "dev-1-ino-4004";
      fileIdentities.set(target.relativePath, currentFileIdentity);
      await writeFile(targetPath, content, "utf8");
      const rev = sha256(content);
      return {
        document: {
          documentRef: { vaultId: vault.id, relativePath: target.relativePath },
          relativePath: target.relativePath,
          title: "Synthetic",
          content,
          revision: rev,
          modifiedAt: "2026-11-03",
          size: Buffer.byteLength(content),
          workspaceSourceId: validProof,
          fileIdentity: currentFileIdentity,
        },
      };
    },
    async move(
      documentRef: { vaultId: string; relativePath: string },
      _title: string,
      expectedRevision: string,
      parentRelativePath?: string | null,
      expectedFileIdentity?: string | null,
    ) {
      const actualIdentity = fileIdentities.get(documentRef.relativePath) ?? currentFileIdentity;
      if (expectedFileIdentity && actualIdentity !== expectedFileIdentity) {
        throw new Error(`knowledge-document-identity-mismatch: expected ${expectedFileIdentity}, got ${actualIdentity}`);
      }
      const sourcePath = join(root, documentRef.relativePath);
      const sourceContent = await readFile(sourcePath, "utf8");
      if (expectedRevision && sha256(sourceContent) !== expectedRevision) {
        throw new Error("knowledge-revision-conflict: Stale expected revision");
      }
      const destination = posix.join(parentRelativePath || "", documentRef.relativePath);
      const movedContent = rebaseMarkdownContent(documentRef.relativePath, destination, sourceContent);
      await rm(sourcePath);
      await writeFile(join(root, destination), movedContent, "utf8");
      const rev = sha256(movedContent);
      fileIdentities.delete(documentRef.relativePath);
      fileIdentities.set(destination, actualIdentity);
      return {
        documentRef: { vaultId: vault.id, relativePath: destination },
        relativePath: destination,
        title: "Synthetic",
        content: movedContent,
        revision: rev,
        modifiedAt: "2026-11-03",
        size: Buffer.byteLength(movedContent),
        workspaceSourceId: validProof,
        fileIdentity: actualIdentity,
      };
    },
  };

  const prevPlatform = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });

  try {
    const source = createRealVaultDocumentSource({ vault, documents: documents as any });

    // 1. Initial read: establishes snapshot A with identity dev-1-ino-1001
    const doc = await source.openDocument("Synthetic.md");
    assert.equal(doc.fileIdentity, "dev-1-ino-1001");

    // Deferred promise to simulate in-flight asynchronous move operation
    let releaseMoveBackend!: (val: unknown) => void;
    const moveDeferred = new Promise(resolve => { releaseMoveBackend = resolve; });

    // Initialize harness with page context
    const h = harness(() => moveDeferred);
    h.readProofs.set(originalId, {
      generation: 1,
      source: h.context.readActiveKnowledgeWriteSource() as any,
      revision: doc.revision!,
      fileIdentity: "dev-1-ino-1001",
      workspaceSourceId: validProof,
      content: initialNote,
    });
    h.saved.set(originalId, initialNote);

    // 2. User starts move operation in page
    const pendingMove = h.invokeMove(originalId, "Moved");

    // 3. While move is pending in background, user types live edit in the editor
    const liveEditedDraft = `${initialNote}User live edit typed during move operation: verification of editor draft retention.\n`;
    h.latest.set(originalId, liveEditedDraft);
    h.dirty.add(originalId);

    // 4. Backend move completes: moves physical file and returns rebased baseline
    const backendMovedDoc = await source.moveDocument({ relativePath: "Synthetic.md", revision: doc.revision!, fileIdentity: "dev-1-ino-1001" }, "Moved");
    releaseMoveBackend({
      id: "Moved/Synthetic.md",
      relativePath: "Moved/Synthetic.md",
      contentText: backendMovedDoc.contentText,
      revision: backendMovedDoc.revision,
      fileIdentity: backendMovedDoc.fileIdentity,
      workspaceSourceId: backendMovedDoc.workspaceSourceId,
    });
    await pendingMove;

    assert.equal(h.statuses.includes("editor.notes.status.markdownMoved"), true);

    // 4. Moved note in runtime must have draft text and rebased relative link
    const movedRuntimeContent = h.latest.get(movedId);
    assert(movedRuntimeContent);
    assert(movedRuntimeContent.includes("User live edit typed during move operation: verification of editor draft retention."));
    assert(movedRuntimeContent.includes("[![Architecture Overview](../attachments/architecture.png)](https\\://example.com/system-overview)"));

    // 5. User saves the moved note through the page save chain
    const origin = { source: h.context.readActiveKnowledgeWriteSource() as any, generation: h.vaultSessionRef.current.latest() };
    const savedDoc = await source.saveDocument({ relativePath: "Moved/Synthetic.md", revision: sha256(rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", initialNote)) }, movedRuntimeContent);
    assert.equal(savedDoc.fileIdentity, "dev-1-ino-4004");

    const prevProof = h.readProofs.get(movedId) ?? h.readProofs.get(originalId);
    const nextProof = advanceNotesSavedReadProof(prevProof, { content: savedDoc.contentText, revision: savedDoc.revision!, fileIdentity: savedDoc.fileIdentity }, origin);
    assert(nextProof);
    h.readProofs.set(movedId, nextProof);
    assert.equal(h.readProofs.get(movedId)?.fileIdentity, "dev-1-ino-4004");

    // 6. Direct disk assertions: verify disk content strictly retains edited content and proper link targets
    const savedOnDisk = await readFile(join(root, "Moved", "Synthetic.md"), "utf8");

    // Must strictly retain newly edited text (not just non-empty!)
    assert(savedOnDisk.includes("User live edit typed during move operation: verification of editor draft retention."));

    // External link target with escaped colon MUST remain verbatim
    assert(savedOnDisk.includes("(https\\://example.com/system-overview)"));
    assert(!savedOnDisk.includes("../https"));

    // Wrapped local image MUST be rebased to new relative path
    assert(savedOnDisk.includes("[![Architecture Overview](../attachments/architecture.png)]"));
    assert(!savedOnDisk.includes("](attachments/architecture.png)"));

    // Rebased relative path resolves to physical attachment on disk with exact bytes
    const resolvedAttachmentPath = posix.normalize(posix.join("Moved", "../attachments/architecture.png"));
    assert.equal(resolvedAttachmentPath, "attachments/architecture.png");
    const attachmentDiskBytes = await readFile(join(root, resolvedAttachmentPath), "utf8");
    assert.equal(attachmentDiskBytes, "PNG_BYTES_ARCHITECTURE_DATA");
  } finally {
    if (prevPlatform) Object.defineProperty(globalThis, "navigator", prevPlatform);
    else delete (globalThis as Record<string, unknown>).navigator;
    await rm(root, { recursive: true, force: true });
  }
});

test("directory load guard: switching vault while loadRealVaultTree is in flight drops selection and status update", async () => {
  let releaseTree!: () => void;
  const treeGate = new Promise<void>(res => { releaseTree = res; });
  const h = harness(
    async () => ({ id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired }),
    {
      vaultId: "vault-A",
      loadRealVaultTree: async () => {
        await treeGate;
      },
    }
  );

  // Start move in vault-A
  const pending = h.invokeMove(originalId, "Moved");

  // Move completes and awaits loadRealVaultTree
  // While loadRealVaultTree is suspended, user switches to vault-B
  await new Promise(res => setTimeout(res, 20));
  h.vaultSessionRef.current.begin("vault-B");
  (h.context.selectedNoteIdRef as { current: string }).current = "real-vault:VaultB_Note.md";

  // Tree finishes loading late
  releaseTree();
  await pending;

  // Selected note ID in vault-B must NOT be changed by late result to movedId from vault-A
  assert.equal(h.context.selectedNoteIdRef.current, "real-vault:VaultB_Note.md");
  // Status message for vault-A must NOT be displayed in vault-B
  assert.equal(h.statuses.includes("editor.notes.status.markdownMoved"), false);
});

test("move error guard: error during move does not leak status message into new vault", async () => {
  let rejectMove!: (err: Error) => void;
  const movePromise = new Promise((_, rej) => { rejectMove = rej; });
  const h = harness(() => movePromise, { vaultId: "vault-A" });

  const pending = h.invokeMove(originalId, "Moved");

  // User switches to vault-B while move is in flight
  h.vaultSessionRef.current.begin("vault-B");

  // Move fails in vault-A
  rejectMove(new Error("Disk error in vault-A"));
  await pending;

  // Statuses must not contain the error message because session is not current
  assert.equal(h.statuses.length, 0);
});

test("a draft typed during a move is queued for the new path and the old pending save is retired", async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(() => gate);
  const pending = h.invokeMove(originalId, "Moved");
  assert.equal(h.context.realVaultMoveInFlightRef.current.has(originalId), true);
  const draft = `${original}Typed while moving.\n`;
  h.latest.set(originalId, draft);
  h.dirty.add(originalId);
  h.context.pendingPatchNoteIdRef.current = originalId;
  h.context.pendingPatchRef.current = { contentText: draft };
  assert.equal(h.saveCalls.length, 0);
  release({ id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired });
  await pending;
  assert.equal(h.context.realVaultMoveInFlightRef.current.has(originalId), false);
  assert.equal(h.context.pendingPatchNoteIdRef.current, null);
  assert.equal(h.saveCalls.length, 1);
  assert.equal(h.saveCalls[0].noteId, movedId);
  assert.equal(h.saveCalls[0].patch.contentText, h.latest.get(movedId));
  assert(h.saveCalls[0].patch.contentText?.includes("../attachments/note-flow.png"));
  assert(h.saveCalls[0].patch.contentText?.includes("Typed while moving."));
});

test("Mac moves preserve a valid uppercase Markdown extension", async () => {
  const vault = { id: "synthetic", name: "Synthetic", rootPath: "/synthetic", mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
  const snapshot = (relativePath: string) => ({ documentRef: { vaultId: vault.id, relativePath }, relativePath,
    title: "Title", content: original, revision: sha256(original), modifiedAt: null,
    size: Buffer.byteLength(original), fileIdentity: "device:original" });
  let passedTitle = "";
  const documents = { read: async () => snapshot("Title.MD"), replace: async () => ({ document: snapshot("Title.MD") }),
    move: async (_ref: unknown, title: string) => { passedTitle = title; return snapshot("Moved/Title.MD"); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });
  try {
    const source = createRealVaultDocumentSource({ vault, documents: documents as any });
    const opened = await source.openDocument("Title.MD");
    const moved = await source.moveDocument(opened, "Moved");
    assert.equal(passedTitle, "Title.MD");
    assert.equal(moved.relativePath, "Moved/Title.MD");
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
});

test("a failed or partial move retains its draft without scheduling a write to an uncertain path", async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise((_, fail) => { reject = fail; });
  const h = harness(() => gate);
  const pending = h.invokeMove(originalId, "Moved");
  const draft = `${original}Keep this draft.\n`;
  h.latest.set(originalId, draft);
  h.dirty.add(originalId);
  h.context.pendingPatchNoteIdRef.current = originalId;
  h.context.pendingPatchRef.current = { contentText: draft };
  reject(new Error("move requires recovery"));
  await pending;
  assert.equal(h.latest.get(originalId), draft);
  assert.equal(h.dirty.has(originalId), true);
  assert.equal(h.context.pendingPatchNoteIdRef.current, null);
  assert.equal(h.saveCalls.length, 0);
});

test("autosave waits for the same vault's in-flight move but does not block a later session", () => {
  const source = {}, authority = { current: { isCurrent: (generation: number) => generation === 1 } };
  const refs = { current: new Map([[originalId, { source, generation: 1 }]]) };
  const guard = vm.runInNewContext(`(noteId, source) => { ${saveMoveGuard} return true; }`,
    { realVaultMoveInFlightRef: refs, vaultSessionRef: authority });
  assert.equal(guard(originalId, source), undefined);
  assert.equal(guard(originalId, {}), true);
  authority.current.isCurrent = () => false;
  assert.equal(guard(originalId, source), true);
});

test("completion from an old vault leaves the new vault's same-path pending draft intact", async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(() => gate, { vaultId: "vault-A" });
  const pending = h.invokeMove(originalId, "Moved");
  h.vaultSessionRef.current.begin("vault-B");
  h.context.pendingPatchNoteIdRef.current = originalId;
  h.context.pendingPatchRef.current = { contentText: "Draft in vault B" };
  release({ id: "Moved/Synthetic.md", relativePath: "Moved/Synthetic.md", contentText: desired });
  await pending;
  assert.equal(h.context.pendingPatchNoteIdRef.current, originalId);
  assert.equal(h.context.pendingPatchRef.current.contentText, "Draft in vault B");
  assert.equal(h.saveCalls.length, 0);
});

test("move never combines an explicit older revision with a later cached file identity", async () => {
  const vault = { id: "synthetic", name: "Synthetic", rootPath: "/synthetic", mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
  let identity: string | undefined = "device:original";
  let moves = 0;
  const snapshot = () => ({ documentRef: { vaultId: vault.id, relativePath: "Synthetic.md" }, relativePath: "Synthetic.md",
    title: "Synthetic", content: original, revision: sha256(original), modifiedAt: null,
    size: Buffer.byteLength(original), fileIdentity: identity });
  const documents = { read: async () => snapshot(), replace: async () => ({ document: snapshot() }),
    move: async () => { moves++; return snapshot(); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });
  try {
    const source = createRealVaultDocumentSource({ vault, documents: documents as any });
    const old = await source.openDocument("Synthetic.md");
    identity = "device:replacement";
    await source.openDocument("Synthetic.md");
    await assert.rejects(() => source.moveDocument({ relativePath: "Synthetic.md", revision: old.revision }, "Moved"),
      (error: any) => error.code === "knowledge-identity-unavailable");
    assert.equal(moves, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
});

test("a saved snapshot without file identity clears the old move authority", async () => {
  const vault = { id: "synthetic", name: "Synthetic", rootPath: "/synthetic", mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
  let identity: string | undefined = "device:original";
  let moves = 0;
  const snapshot = () => ({ documentRef: { vaultId: vault.id, relativePath: "Synthetic.md" }, relativePath: "Synthetic.md",
    title: "Synthetic", content: original, revision: sha256(original), modifiedAt: null,
    size: Buffer.byteLength(original), fileIdentity: identity });
  const documents = { read: async () => snapshot(), replace: async () => ({ document: snapshot() }),
    move: async () => { moves++; return snapshot(); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true });
  try {
    const source = createRealVaultDocumentSource({ vault, documents: documents as any });
    const opened = await source.openDocument("Synthetic.md");
    identity = undefined;
    const saved = await source.saveDocument(opened, original);
    assert.equal(saved.fileIdentity, undefined);
    await assert.rejects(() => source.moveDocument("Synthetic.md", "Moved"),
      (error: any) => error.code === "knowledge-identity-unavailable");
    assert.equal(moves, 0);
    const origin = { source: {}, generation: 1 };
    const proof = { ...origin, workspaceSourceId: validProof, revision: opened.revision!, content: original, fileIdentity: "device:original" };
    assert.equal(advanceNotesSavedReadProof(proof, { content: original, revision: saved.revision! }, origin)?.fileIdentity, undefined);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
});

test("advancing an existing Windows proof does not add a Mac identity field", () => {
  const origin = { source: {}, generation: 1 };
  const proof = { ...origin, workspaceSourceId: validProof, revision: "old", content: "old" };
  const advanced = advanceNotesSavedReadProof(proof, { content: "new", revision: "new" }, origin);
  assert.deepEqual(advanced, { ...proof, content: "new", revision: "new" });
  assert.equal(Object.hasOwn(advanced!, "fileIdentity"), false);
});
