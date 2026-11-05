// Host-side contracts only: these do not substitute for a Darwin run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createRealVaultDocumentSource, KnowledgeSourceError } from "../src/features/notes/documentSource.ts";

const vault = { id: "synthetic", name: "Synthetic", rootPath: "/synthetic/vault", mode: "vault-bound",
  createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
const node = { kind: "folder" as const, name: "Folder", relativePath: "Folder", absolutePath: "/synthetic/vault/Folder",
  children: [], mtime: null, size: 0 };

async function withPlatform<T>(platform: string, work: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true });
  try { return await work(); }
  finally { if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete (globalThis as any).navigator; }
}

function fixture() {
  const calls: unknown[] = [];
  const active = { mode: "real-vault" as const, vaultId: vault.id, rootPath: vault.rootPath };
  const source = createRealVaultDocumentSource({ vault, bridge: {
    renameNotesVaultFolder: async input => { calls.push(["rename", input]); return node; },
    moveNotesVaultFolder: async input => { calls.push(["move", input]); return node; },
    deleteNotesVaultEmptyFolder: async input => { calls.push(["delete", input]); return {
      relativePath: "Folder", absolutePath: node.absolutePath, deleted: true, message: "deleted" }; },
    createNotesVaultFolder: async input => { calls.push(["create", input]); return node; },
  }, readSource: () => active,
    ensureSource: async () => ({ vaultId: vault.id, sourceEpoch: 17 }) });
  return { source, calls };
}

test("Mac folder entry points require a protected selection before mutation and never use the legacy bridge", async () => withPlatform("MacIntel", async () => {
  const { source, calls } = fixture();
  for (const action of [() => source.renameFolder("Folder", "Renamed"),
    () => source.moveFolder("Folder", "Target"), () => source.deleteFolder("Folder")]) {
    await assert.rejects(action(), error => error instanceof KnowledgeSourceError && error.code === "knowledge-folder-selection-required");
  }
  assert.deepEqual(calls, []);
  await source.createFolder("", "Folder");
  assert.deepEqual(calls, [["create", { vault, parentRelativePath: "", name: "Folder", sourceEpoch: 17 }]]);
}));

test("Mac desktop folder creation binds the original active source epoch", async () => withPlatform("MacIntel", async () => {
  const { source, calls } = fixture();
  const folder = await source.createFolder("Parent", "Folder");
  assert.equal(folder.relativePath, "Folder");
  assert.deepEqual(calls, [["create", { vault, parentRelativePath: "Parent", name: "Folder", sourceEpoch: 17 }]]);
}));

test("Mac desktop folder creation rejects a source change before activation returns", async () => withPlatform("MacIntel", async () => {
  let active = { mode: "real-vault" as const, vaultId: vault.id, rootPath: vault.rootPath };
  const activation = Promise.withResolvers<{ vaultId: string; sourceEpoch: number }>();
  const calls: unknown[] = [];
  const source = createRealVaultDocumentSource({ vault, readSource: () => active,
    ensureSource: () => activation.promise,
    bridge: { createNotesVaultFolder: async input => { calls.push(input); return node; } } });
  const result = source.createFolder("", "Folder");
  // Even a new session for the same ID must retire the old request.
  active = { ...active };
  activation.resolve({ vaultId: vault.id, sourceEpoch: 17 });
  await assert.rejects(result, error => error instanceof KnowledgeSourceError && error.code === "knowledge-source-inactive");
  assert.deepEqual(calls, []);
}));

test("Mac desktop folder creation rejects a different active root for the same vault ID", async () => withPlatform("MacIntel", async () => {
  const calls: unknown[] = [];
  const source = createRealVaultDocumentSource({ vault,
    readSource: () => ({ mode: "real-vault", vaultId: vault.id, rootPath: "/different/vault" }),
    ensureSource: async () => ({ vaultId: vault.id, sourceEpoch: 17 }),
    bridge: { createNotesVaultFolder: async input => { calls.push(input); return node; } } });
  await assert.rejects(source.createFolder("", "Folder"), error => error instanceof KnowledgeSourceError && error.code === "knowledge-source-inactive");
  assert.deepEqual(calls, []);
}));

test("Mac desktop folder creation reports a source change after dispatch as unconfirmed", async () => withPlatform("MacIntel", async () => {
  let active = { mode: "real-vault" as const, vaultId: vault.id, rootPath: vault.rootPath };
  const completed = Promise.withResolvers<typeof node>();
  const calls: unknown[] = [];
  const source = createRealVaultDocumentSource({ vault, readSource: () => active,
    ensureSource: async () => ({ vaultId: vault.id, sourceEpoch: 17 }),
    bridge: { createNotesVaultFolder: input => { calls.push(input); return completed.promise; } } });
  const result = source.createFolder("", "Folder");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  active = { ...active };
  completed.resolve(node);
  await assert.rejects(result, error => error instanceof KnowledgeSourceError && error.code === "knowledge-create-unconfirmed");
}));

test("Mac desktop folder creation surfaces an unconfirmed native result", async () => withPlatform("MacIntel", async () => {
  const active = { mode: "real-vault" as const, vaultId: vault.id, rootPath: vault.rootPath };
  const source = createRealVaultDocumentSource({ vault, readSource: () => active,
    ensureSource: async () => ({ vaultId: vault.id, sourceEpoch: 17 }),
    bridge: { createNotesVaultFolder: async () => { throw "knowledge-create-unconfirmed: fixture"; } } });
  await assert.rejects(source.createFolder("", "Folder"), error => error instanceof KnowledgeSourceError
    && error.code === "knowledge-create-unconfirmed" && error.message.includes("检查原知识库"));
}));

test("Windows desktop folder creation keeps its legacy arguments", async () => withPlatform("Win32", async () => {
  const { source, calls } = fixture();
  await source.createFolder("Parent", "Folder");
  assert.deepEqual(calls, [["create", { vault, parentRelativePath: "Parent", name: "Folder" }]]);
}));

test("Windows folder actions retain their original bridge arguments", async () => withPlatform("Win32", async () => {
  const { source, calls } = fixture();
  await source.renameFolder("Folder", "Renamed");
  await source.moveFolder("Folder", "Target");
  await source.deleteFolder("Folder");
  assert.deepEqual(calls, [
    ["rename", { vault, relativePath: "Folder", newName: "Renamed" }],
    ["move", { vault, relativePath: "Folder", targetParentRelativePath: "Target" }],
    ["delete", { vault, relativePath: "Folder" }],
  ]);
}));

test("the actual folder page callbacks enter the Mac product coordinator and retain the Windows adapter", async () => {
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
  const start = page.indexOf("  const renameFolderFromTree = useCallback("), end = page.indexOf("  const saveRealVaultTagNames = useCallback(", start);
  assert(start >= 0 && end > start);
  const compiled = stripTypeScriptTypes(`${page.slice(start, end)}\n;({ renameFolderFromTree, moveFolderFromTree, deleteFolderFromTree });`, { mode: "strip" });
  for (const mac of [true, false]) {
    const calls: string[] = [];
    const context = { useCallback: (fn: unknown) => fn, isMacPlatform: () => mac, t: (key: string) => key,
      setStatus: (status: string) => calls.push(`status:${status}`),
      realVaultDocumentSource: { renameFolder: async () => { calls.push("rename"); return node; },
        moveFolder: async () => { calls.push("move"); return node; },
        deleteFolder: async () => { calls.push("delete"); } },
      normalizeVaultRelativePath: (path: string) => path, rewriteRealVaultFolderRuntimePaths: () => null,
      runMacFolderOperation: async (_path: string, operation: string) => { calls.push(`mac:${operation}`); },
      loadRealVaultTree: async () => {}, selectNote: async () => {}, setSelectedFolderId: () => {}, console };
    const actions = vm.runInNewContext(compiled, context) as {
      renameFolderFromTree: (id: string, name: string) => Promise<void>;
      moveFolderFromTree: (id: string, target: string) => Promise<void>;
      deleteFolderFromTree: (id: string) => Promise<void>;
    };
    await actions.renameFolderFromTree("Folder", "Renamed");
    await actions.moveFolderFromTree("Folder", "Target");
    await actions.deleteFolderFromTree("Folder");
    if (mac) assert.deepEqual(calls, ["mac:rename", "mac:move", "mac:delete"]);
    else assert.deepEqual(calls.filter(call => !call.startsWith("status:")), ["rename", "move", "delete"]);
  }
});

test("native legacy commands guard before inspecting or modifying vault paths", async () => {
  const native = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const name of ["rename_notes_vault_folder", "move_notes_vault_folder", "delete_notes_vault_empty_folder"]) {
    const start = native.indexOf(`fn ${name}(`), body = native.indexOf(" {", start), end = native.indexOf("#[tauri::command]", body);
    assert(start >= 0 && body > start && end > body, name);
    const statement = native.slice(body + 2, end).trimStart();
    assert(statement.startsWith('folder_mutation_guard::require_safe_platform(cfg!(target_os = "macos"))?;'), name);
  }
});
