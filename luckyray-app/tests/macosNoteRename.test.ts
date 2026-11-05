// Adapter and page contracts. Native filesystem behavior still requires Mac tests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createRealVaultDocumentSource } from "../src/features/notes/documentSource.ts";

const vault = { id: "synthetic", name: "Synthetic", rootPath: "/synthetic/vault", mode: "vault-bound",
  createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
const original = { documentRef: { vaultId: vault.id, relativePath: "Folder/Before.md" }, title: "Before",
  content: "synthetic", revision: "a".repeat(64), fileIdentity: "1:2", modifiedAt: null, size: 9 };
const renamed = { ...original, documentRef: { vaultId: vault.id, relativePath: "Folder/After.md" }, title: "After", fileIdentity: "1:3" };

async function withPlatform<T>(platform: string, work: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true });
  try { return await work(); }
  finally { if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete (globalThis as any).navigator; }
}

test("Mac rename uses the observed revision and identity in its existing directory", async () => withPlatform("MacIntel", async () => {
  const calls: unknown[] = [], active = { mode: "real-vault", vaultId: vault.id };
  const source = createRealVaultDocumentSource({ vault, readSource: () => active as any,
    bridge: { renameNotesVaultMarkdownFile: async () => { throw new Error("unsafe legacy rename"); } },
    documents: { read: async ref => { calls.push(["read", ref]); return original; },
      replace: async () => { throw new Error("unexpected save"); },
      move: async (...args: any[]) => { calls.push(["move", ...args]); return renamed; } } as any });
  const result = await source.renameDocument("Folder/Before.md", "After");
  assert.equal(result.relativePath, "Folder/After.md");
  assert.deepEqual(calls, [["read", original.documentRef],
    ["move", original.documentRef, "After", original.revision, "Folder", original.fileIdentity]]);
}));

test("Mac rename keeps an explicit older observation together and refuses an unprotected fallback", async () => withPlatform("MacIntel", async () => {
  const calls: unknown[] = [], active = { mode: "real-vault", vaultId: vault.id };
  const source = createRealVaultDocumentSource({ vault, readSource: () => active as any,
    bridge: { renameNotesVaultMarkdownFile: async () => { calls.push("legacy"); throw new Error("unsafe"); } },
    documents: { read: async () => original, replace: async () => { throw new Error("unexpected save"); },
      move: async (...args: any[]) => { calls.push(args); return renamed; } } as any });
  await source.openDocument("Folder/Before.md");
  await source.renameDocument({ relativePath: "Folder/Before.md", vaultId: vault.id, revision: "old", fileIdentity: "8:9" }, "After");
  assert.deepEqual(calls, [[original.documentRef, "After", "old", "Folder", "8:9"]]);
  const unavailable = createRealVaultDocumentSource({ vault, readSource: () => active as any,
    bridge: { renameNotesVaultMarkdownFile: async () => { calls.push("legacy"); throw new Error("unsafe"); } },
    documents: { read: async () => original, replace: async () => { throw new Error("unexpected save"); } } });
  await assert.rejects(unavailable.renameDocument("Folder/Before.md", "After"), /protected note move is unavailable/i);
  assert(!calls.includes("legacy"));
}));

test("Mac rename stops if the vault session changes during the identity read", async () => withPlatform("MacIntel", async () => {
  let active = { mode: "real-vault", vaultId: vault.id }, moves = 0;
  const source = createRealVaultDocumentSource({ vault, bridge: null, readSource: () => active as any,
    documents: { read: async () => { active = { ...active }; return original; },
      replace: async () => { throw new Error("unexpected save"); }, move: async () => { moves++; return renamed; } } as any });
  await assert.rejects(source.renameDocument("Folder/Before.md", "After"), /vault changed/i);
  assert.equal(moves, 0);
}));

test("an identity-less object reference is freshly read rather than using an older cached file object", async () => withPlatform("MacIntel", async () => {
  let identity = "old", reads = 0;
  const calls: unknown[] = [], active = { mode: "real-vault", vaultId: vault.id };
  const source = createRealVaultDocumentSource({ vault, bridge: null, readSource: () => active as any,
    documents: { read: async () => { reads++; return { ...original, fileIdentity: identity }; },
      replace: async () => { throw new Error("unexpected save"); },
      move: async (...args: any[]) => { calls.push(args); return renamed; } } as any });
  await source.openDocument("Folder/Before.md");
  identity = "new";
  await source.renameDocument({ relativePath: "Folder/Before.md", vaultId: vault.id }, "After");
  assert.equal(reads, 2);
  assert.equal((calls[0] as unknown[])[4], "new");
}));

test("Mac rename rejects ambiguous paths and names before mutation", async () => withPlatform("MacIntel", async () => {
  let moves = 0;
  const active = { mode: "real-vault", vaultId: vault.id };
  const source = createRealVaultDocumentSource({ vault, bridge: null, readSource: () => active as any,
    documents: { read: async () => original, replace: async () => { throw new Error("unexpected save"); },
      move: async () => { moves++; return renamed; } } as any });
  for (const name of ["", ".md", "../Other", "Other\\Name", "Other:Name", "bad\u0001name"])
    await assert.rejects(source.renameDocument("Folder/Before.md", name));
  await assert.rejects(source.renameDocument("Folder\\Before.md", "After"), /ambiguous/i);
  assert.equal(moves, 0);
}));

test("Windows rename retains the original bridge and argument shape", async () => withPlatform("Win32", async () => {
  const calls: unknown[] = [];
  const source = createRealVaultDocumentSource({ vault,
    bridge: { renameNotesVaultMarkdownFile: async input => { calls.push(input); return {
      name: "After.md", relativePath: "Folder/After.md", absolutePath: "C:\\vault\\Folder\\After.md",
      contentText: "synthetic", mtime: null, size: 9 }; } },
    documents: { read: async () => original, replace: async () => { throw new Error("unexpected save"); },
      move: async () => { throw new Error("Windows must keep its rename bridge"); } } as any });
  const result = await source.renameDocument("Folder/Before.md", "After");
  assert.deepEqual(calls, [{ vault, relativePath: "Folder/Before.md", newName: "After" }]);
  assert.equal(result.relativePath, "Folder/After.md");
}));

test("Mac legacy file commands fail before their unchecked filesystem writes", async () => {
  const native = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const [name, operation] of [["write_notes_vault_markdown_file", "std::fs::write"],
    ["rename_notes_vault_markdown_file", "std::fs::rename"], ["move_notes_vault_markdown_file", "std::fs::rename"]]) {
    const start = native.indexOf(`fn ${name}(`), end = native.indexOf("#[tauri::command]", start);
    assert(start >= 0 && end > start);
    const block = native.slice(start, end);
    assert(block.indexOf('if cfg!(target_os = "macos")') < block.indexOf(operation));
    assert.match(block, /revision-required/);
  }
});

test("Mac legacy vault path parsing rejects ambiguous components before normalization", async () => {
  const native = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const name of ["safe_vault_relative_markdown_path", "safe_vault_relative_directory_path"]) {
    const start = native.indexOf(`fn ${name}(`), end = native.indexOf("\n}", start);
    assert(start >= 0 && end > start);
    const block = native.slice(start, end);
    assert.match(block, /#\[cfg\(target_os = "macos"\)\]\s*reject_ambiguous_macos_vault_path\(relative_path\)\?/);
    assert(block.indexOf("reject_ambiguous_macos_vault_path") < block.indexOf(".trim()"));
  }
});

test("both Mac rename entry points use the protected page path while Windows keeps the legacy path", async () => {
  const page = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
  const start = page.indexOf("  const commitFilename = useCallback("), end = page.indexOf("  const renameFolderFromTree = useCallback(", start);
  assert(start >= 0 && end > start);
  const compiled = stripTypeScriptTypes(`${page.slice(start, end)}\n;({ commitFilename, renameDocumentFromTree });`, { mode: "strip" });
  for (const mac of [true, false]) {
    const calls: string[] = [], source = { mode: "real-vault", vaultId: vault.id };
    const context = {
      useCallback: (fn: unknown) => fn, isMacPlatform: () => mac, isRealVaultNoteId: () => true,
      t: (value: string) => value, renamingNoteRef: { current: null }, setRenamingNoteId: () => {},
      selectedNoteIdRef: { current: "another-note" }, commitCurrentEditorDraftRef: { current: () => {} },
      flushPendingSave: () => {}, saveAffectedAttachmentNotes: async () => {}, blockRealVaultDocumentOperationIfDirty: () => false,
      readActiveKnowledgeWriteSource: () => source, realVaultRelativePathFromNoteId: () => "Folder/Before.md",
      renameMacNote: async (_id: string, _name: string, selectAfter: boolean) => { calls.push(`protected:${selectAfter}`); return "real-vault:Folder/After.md"; },
      realVaultDocumentSource: { renameDocument: async () => { calls.push("legacy"); return {}; } },
      applyRealVaultDocumentPathChange: () => "real-vault:Folder/After.md", loadRealVaultTree: async () => {},
      selectNote: async () => {}, setStatus: () => {}, console,
    };
    const actions = vm.runInNewContext(compiled, context) as {
      commitFilename: (id: string, name: string) => Promise<string>;
      renameDocumentFromTree: (id: string, name: string) => Promise<void>;
    };
    assert.equal(await actions.commitFilename("real-vault:Folder/Before.md", "After"), "real-vault:Folder/After.md");
    await actions.renameDocumentFromTree("real-vault:Folder/Before.md", "After");
    assert.deepEqual(calls, mac ? ["protected:false", "protected:true"] : ["legacy", "legacy"]);
  }
});
