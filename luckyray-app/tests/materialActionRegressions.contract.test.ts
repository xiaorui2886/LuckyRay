import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const folders = [
  {
    id: "root-a",
    name: "Root A",
    parentId: null,
    open: false,
    children: [{
      id: "child-b",
      name: "Child B",
      parentId: "root-a",
      open: false,
      children: [{ id: "leaf-c", name: "Leaf C", parentId: "child-b", open: false, children: [] }],
    }],
  },
];

test("folder reveal resolves a real folder and every ancestor without inventing missing nodes", async () => {
  const { buildMaterialFolderRevealRequest } = await import("../src/features/materials/materialActionRegressions");

  assert.deepEqual(buildMaterialFolderRevealRequest(folders, "leaf-c", 7), {
    folderId: "leaf-c",
    ancestorIds: ["root-a", "child-b"],
    nonce: 7,
    status: "folder",
  });
  assert.deepEqual(buildMaterialFolderRevealRequest(folders, "root-a", 8), {
    folderId: "root-a",
    ancestorIds: [],
    nonce: 8,
    status: "folder",
  });
  assert.deepEqual(buildMaterialFolderRevealRequest(folders, null, 9), {
    folderId: null,
    ancestorIds: [],
    nonce: 9,
    status: "all",
  });
  assert.deepEqual(buildMaterialFolderRevealRequest(folders, "deleted-folder", 10), {
    folderId: null,
    ancestorIds: [],
    nonce: 10,
    status: "missing",
  });
});

test("folder reveal resolves a moved asset at action time and deleted assets change nothing", async () => {
  const { resolveCurrentMaterialFolderReveal } = await import("../src/features/materials/materialActionRegressions");
  const movedFolders = [
    ...folders,
    { id: "moved-root", name: "Moved", parentId: null, open: false, children: [] },
  ];
  const menuSnapshot = { id: "asset-a", folderId: "leaf-c" };
  const currentAssets = [{ id: "asset-a", folderId: "moved-root" }];

  assert.deepEqual(resolveCurrentMaterialFolderReveal(currentAssets, movedFolders, menuSnapshot.id, 11), {
    asset: currentAssets[0],
    request: { folderId: "moved-root", ancestorIds: [], nonce: 11, status: "folder" },
  });
  assert.equal(resolveCurrentMaterialFolderReveal([], movedFolders, menuSnapshot.id, 12), null);
  assert.deepEqual(resolveCurrentMaterialFolderReveal(
    [{ id: "asset-a", folderId: "deleted-folder" }],
    movedFolders,
    menuSnapshot.id,
    13,
  ), {
    asset: { id: "asset-a", folderId: "deleted-folder" },
    request: { folderId: null, ancestorIds: [], nonce: 13, status: "missing" },
  });

  const page = await source("src/features/materials/MaterialsPage.tsx");
  assert.match(page, /materialStore\.getSnapshot\(\)[\s\S]*resolveCurrentMaterialFolderReveal/u);
  assert.match(page, /if \(!resolution\)[\s\S]*assetUnavailable[\s\S]*return;/u);
  assert.match(page, /if \(revealRequest\.status === "missing"\)[\s\S]*folderMissing[\s\S]*return;/u);
});

test("folder reveal remains repeatable, temporarily exposes a collapsed tree, and focuses the row", async () => {
  const [sidebar, tree] = await Promise.all([
    source("src/app/AppSidebar.tsx"),
    source("src/features/folders/FolderTree.tsx"),
  ]);

  assert.match(sidebar, /folderRevealExpanded/);
  assert.match(sidebar, /effectiveCollapsed\s*=\s*folderRevealExpanded\s*\?\s*false/);
  assert.match(sidebar, /revealRequest=\{folderRevealRequest\}/);
  assert.match(sidebar, /setFolderRevealExpanded\(true\)/);
  assert.match(sidebar, /detail\.status !== "missing"/);
  assert.match(tree, /revealRequest\?\.nonce/);
  assert.match(tree, /revealRequest\.ancestorIds/);
  assert.match(tree, /scrollIntoView\(\{\s*block:\s*"nearest",\s*inline:\s*"nearest"/s);
  assert.match(tree, /focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(tree, /tabIndex=\{-1\}/);
});

test("insert-current-note freezes the context-menu asset but drains to the execution-time current note", async () => {
  const { insertMaterialAssetIntoCurrentKnowledge } = await import("../src/core/services/materials");
  let releaseContext!: () => void;
  const contextReady = new Promise<void>((resolve) => { releaseContext = resolve; });
  let currentNote: { documentRef: { vaultId: string; relativePath: string } } | null = {
    documentRef: { vaultId: "vault", relativePath: "note-a.md" },
  };
  const writes: Array<{ text: string; notePath: string }> = [];
  const menuAsset = { id: "asset-a", name: "asset-a.png" };
  const liveSelection = { id: "asset-b", name: "asset-b.png" };

  const operation = insertMaterialAssetIntoCurrentKnowledge(menuAsset, {
    awaitCurrentNoteReady: () => contextReady,
    writer: async (input) => {
      if (!currentNote) throw Object.assign(new Error("No current note"), { code: "knowledge-current-context-required" });
      writes.push({ text: input.text, notePath: currentNote!.documentRef.relativePath });
      return {
        document: {
          documentRef: currentNote!.documentRef,
          title: "Current",
          relativePath: currentNote!.documentRef.relativePath,
          modifiedAt: "2026-08-31T00:00:00.000Z",
          size: 1,
          content: input.text,
          revision: "r1",
        },
        position: "cursor",
      };
    },
  });

  assert.equal(writes.length, 0, "a pending current-note publication must gate insertion");
  currentNote = { documentRef: { vaultId: "vault", relativePath: "note-b.md" } };
  releaseContext();
  const result = await operation;

  assert.equal(liveSelection.id, "asset-b", "the live selection changed while the menu was open");
  assert.deepEqual(writes, [{ text: "![[asset-a|asset-a.png]]", notePath: "note-b.md" }]);
  assert.match(result.noteId, /^kdoc-/);
  assert.equal(result.position, "cursor");
});

test("different context-menu target assets insert distinct matching material references into the same current note", async () => {
  const { freezeMaterialContextAsset } = await import("../src/features/materials/materialActionRegressions");
  const { insertMaterialAssetIntoCurrentKnowledge } = await import("../src/core/services/materials");
  const { resolveAssetEmbed } = await import("../src/features/notes/editor/noteAssetResolver");
  const selectedAsset = { id: "selected-unchanged", name: "selected.jpeg" };
  const contextTargets = [
    { id: "asset-a", name: "download.jpeg" },
    { id: "asset-b", name: "download.jpeg" },
    { id: "asset-c", name: "download.jpeg" },
  ];
  const writes: string[] = [];
  const writer = async (input: { text: string }) => {
    writes.push(input.text);
    return {
      document: {
        documentRef: { vaultId: "vault", relativePath: "same-current-note.md" },
        title: "Same current note",
        relativePath: "same-current-note.md",
        modifiedAt: "2026-08-31T00:00:00.000Z",
        size: input.text.length,
        content: input.text,
        revision: `r${writes.length}`,
      },
      position: "cursor",
    };
  };

  for (const target of contextTargets) {
    const contextSessionAsset = freezeMaterialContextAsset(target);
    await insertMaterialAssetIntoCurrentKnowledge(contextSessionAsset, {
      awaitCurrentNoteReady: async () => undefined,
      writer,
    });
  }

  assert.equal(selectedAsset.id, "selected-unchanged", "page selection is not the context action authority");
  assert.deepEqual(writes, [
    "![[asset-a|download.jpeg]]",
    "![[asset-b|download.jpeg]]",
    "![[asset-c|download.jpeg]]",
  ]);
  assert.deepEqual(
    writes.map((markdown) => resolveAssetEmbed(markdown.slice(3, -2), [], contextTargets).asset?.id),
    ["asset-a", "asset-b", "asset-c"],
    "the inserted references must resolve back to the exact context-menu targets",
  );
});

test("reopening the context menu retires prior root and submenu asset sessions", async () => {
  const { createMaterialContextActionAuthority } = await import("../src/features/materials/materialActionRegressions");
  const authority = createMaterialContextActionAuthority();
  const pageSelection = { id: "selected-unchanged", name: "selected.jpeg" };
  let currentAssets = [
    { id: "asset-a", name: "same.jpeg" },
    { id: "asset-b", name: "same.jpeg" },
    { id: "asset-c", name: "same.jpeg" },
  ];

  const sessionA = authority.begin(currentAssets[0]);
  const staleRootAction = () => authority.resolve(sessionA.sessionId, currentAssets);
  const staleHoveredSubmenuAction = () => authority.resolve(sessionA.sessionId, currentAssets);
  assert.equal(authority.resolve(sessionA.sessionId, currentAssets)?.id, "asset-a");

  const sessionB = authority.begin(currentAssets[1]);
  assert.equal(staleRootAction(), null, "a reopened menu retires the prior root action");
  assert.equal(staleHoveredSubmenuAction(), null, "a reopened menu retires the prior hovered submenu action");
  assert.equal(authority.resolve(sessionB.sessionId, currentAssets)?.id, "asset-b");
  assert.equal(authority.resolve(sessionB.sessionId, currentAssets)?.id, "asset-b", "repeated hover keeps the active session stable");

  const sessionC = authority.begin(currentAssets[2]);
  assert.equal(authority.resolve(sessionB.sessionId, currentAssets), null, "neighboring context targets cannot reuse the previous session");
  assert.equal(authority.resolve(sessionC.sessionId, currentAssets)?.id, "asset-c");
  currentAssets = currentAssets.filter((asset) => asset.id !== "asset-c");
  assert.equal(authority.resolve(sessionC.sessionId, currentAssets), null, "a deleted context target never falls back to another asset");
  assert.equal(pageSelection.id, "selected-unchanged");
});

test("insert-current-note refuses to write when there is no legal focused note", async () => {
  const { insertMaterialAssetIntoCurrentKnowledge } = await import("../src/core/services/materials");
  let writes = 0;

  await assert.rejects(
    insertMaterialAssetIntoCurrentKnowledge({ id: "asset-a", name: "asset-a.png" }, {
      awaitCurrentNoteReady: async () => undefined,
      writer: async () => {
        throw Object.assign(new Error("No current note"), { code: "knowledge-current-context-required" });
      },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "knowledge-current-context-required",
  );
  assert.equal(writes, 0);
});

test("all three material views route context actions through the same session-bound asset authority", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  assert.match(page, /createMaterialContextActionAuthority\(\)/);
  assert.match(page, /const session = contextActionAuthorityRef\.current\.begin\(asset\)/);
  assert.match(page, /<AssetContextMenu[\s\S]*key=\{contextMenu\.sessionId\}/u);
  assert.match(page, /materialStore\.getSnapshot\(\)[\s\S]*contextActionAuthorityRef\.current\.resolve\(contextMenu\.sessionId, currentAssets\)/u);
  assert.match(page, /if \(viewMode === "grid"\)[\s\S]*<GridAssetCard/u);
  assert.match(page, /if \(viewMode === "list"\)[\s\S]*<ListAssetRow/u);
  assert.match(page, /className=\{`masonry\$\{[\s\S]*<AssetCard/u);
});
