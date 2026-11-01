import assert from "node:assert/strict";
import test from "node:test";
import { graphVaultsMatch } from "../src/core/services/graph.ts";
import { createRealVaultDocumentSource } from "../src/features/notes/documentSource.ts";

test("macOS note references retain literal paths and graph checks preserve vault distinctions", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
    const vault = { id: "v1", rootPath: "/Users/测试 User/Notes\\one", name: "Notes", mode: "vault-bound", createdAt: "", lastOpenedAt: "", schemaVersion: 1 };
    const documentRef = { vaultId: vault.id, relativePath: "资料/New note.md" };
    const source = createRealVaultDocumentSource({ vault, bridge: null, documents: {
      read: async () => ({ documentRef, relativePath: documentRef.relativePath, title: "New note", content: "synthetic", revision: "r1", modifiedAt: "", size: 9 }),
      replace: async () => { throw Error("not used"); },
    } });
    const opened = await source.openDocument(documentRef.relativePath);
    assert.equal(opened.absolutePath, "/Users/测试 User/Notes\\one/资料/New note.md");
    assert.equal(graphVaultsMatch(vault, { id: "v1", rootPath: vault.rootPath + "/" }), true);
    assert.equal(graphVaultsMatch(vault, { id: "v1", rootPath: "/Users/测试 User/notes\\one" }), false);
    assert.equal(graphVaultsMatch(vault, { id: "v2", rootPath: vault.rootPath }), false);

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "Win32" } });
    assert.equal(graphVaultsMatch({ id: "v1", rootPath: "C:\\Notes" }, { id: "v1", rootPath: "c:/notes/" }), true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
