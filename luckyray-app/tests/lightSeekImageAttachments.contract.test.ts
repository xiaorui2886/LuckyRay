import assert from "node:assert/strict";
import test from "node:test";
import { resolveMaterialLightSeekAttachmentsWithTransport } from "../src/core/services/materials.ts";
import { resolveKnowledgeDocumentAbsolutePath } from "../src/core/services/knowledgeStore.ts";

test("material handoff uses image drafts for supported images and file drafts for other formats", async () => {
  const assets = [
    { id: "image-png", kind: "image", mimeType: "image/png", name: "reference.png" },
    { id: "image-png-no-mime", kind: "image", mimeType: "", name: "legacy-reference.png" },
    { id: "video-mp4", kind: "video", mimeType: "video/mp4", name: "clip.mp4" },
    { id: "image-svg", kind: "image", mimeType: "image/svg+xml", name: "vector.svg" },
  ];
  const resources = await resolveMaterialLightSeekAttachmentsWithTransport(
    assets,
    async (_command, args) => (args.assetIds as string[]).map((id) => ({
      "image-png": "C:\\Library\\reference.png",
      "image-png-no-mime": "C:\\Library\\legacy-reference.png",
      "video-mp4": "C:\\Library\\clip.mp4",
      "image-svg": "C:\\Library\\vector.svg",
    })[id]),
  );
  assert.deepEqual(resources.map((resource) => [resource.assetId, resource.delivery]), [
    ["image-png", "image-attachment"],
    ["image-png-no-mime", "image-attachment"],
    ["video-mp4", "file-attachment"],
    ["image-svg", "file-attachment"],
  ]);
});

test("note handoff resolves the canonical Markdown file itself instead of projecting embedded materials", () => {
  const snapshot = {
    mode: "real-vault" as const,
    vault: { id: "vault-one" },
    tree: [{
      id: "folder",
      kind: "folder" as const,
      title: "Folder",
      relativePath: "Folder",
      absolutePath: "C:\\Vault\\Folder",
      source: "real-vault" as const,
      children: [{
        id: "Folder/ordered.md",
        kind: "document" as const,
        title: "ordered",
        relativePath: "Folder/ordered.md",
        absolutePath: "C:\\Vault\\Folder\\ordered.md",
        source: "real-vault" as const,
      }],
    }],
  };
  assert.equal(resolveKnowledgeDocumentAbsolutePath(snapshot, {
    vaultId: "vault-one",
    relativePath: "Folder\\ordered.md",
  }), "C:\\Vault\\Folder\\ordered.md");
  assert.equal(resolveKnowledgeDocumentAbsolutePath(snapshot, {
    vaultId: "another-vault",
    relativePath: "Folder/ordered.md",
  }), null);
});
