import assert from "node:assert/strict";
import test from "node:test";
import { buildAssetLookup, resolveAssetEmbed } from "../src/features/notes/editor/noteAssetResolver.ts";
import { createRealVaultLibraryAssetResolver, standardMarkdownReferences } from "../src/core/markdown/realVaultEmbeds.ts";
import { parseNoteInline } from "../src/core/services/noteRenderer.ts";
import { createServer } from "vite";
import { EditorState } from "@codemirror/state";

test("duplicate names and physical filenames never silently select an asset", () => {
  const assets = [{ id: "one", name: "图片.png", kind: "image", originalPath: "C:/one/图片.png" }, { id: "two", name: "图片.png", kind: "image", originalPath: "C:/two/图片.png" }];
  assert.equal(buildAssetLookup(assets).byName.get("图片.png"), null);
  assert.equal(resolveAssetEmbed("图片.png", [], assets).asset, null);
  assert.equal(resolveAssetEmbed("one", [], assets).asset?.id, "one");
});

test("unique backend-resolved Vault binding takes precedence over legacy name matches", () => {
  const assets = [{ id: "vault", name: "图片.png", kind: "image" }, { id: "legacy", name: "图片.png", kind: "image" }];
  assert.equal(resolveAssetEmbed("图片.png|300", [{ targetName: "图片.png", assetId: "vault" }], assets).asset?.id, "vault");
  assert.equal(resolveAssetEmbed("图片.png|300", [{ targetName: "图片.png", assetId: "vault" }], assets).width, 300);
});

test("encoded literal percent filenames are decoded once for a resolved embed", () => {
  const assets = [{ id: "vault", name: "a%20b.png", kind: "image" }];
  assert.equal(resolveAssetEmbed("a%2520b.png", [{ targetName: "a%2520b.png", assetId: "vault" }], assets).asset?.id, "vault");
  assert.equal(buildAssetLookup(assets).byName.get("a%20b.png")?.id, "vault");
});

test("conflicting explicit embed bindings stay unresolved", () => {
  const assets = [{ id: "one", name: "one.png", kind: "image" }, { id: "two", name: "two.png", kind: "image" }];
  assert.equal(resolveAssetEmbed("target.png", [{ targetName: "target.png", assetId: "one" }, { targetName: "target.png", assetId: "two" }], assets).asset, null);
});

test("an unresolved Vault result cannot fall through to a same-name global material", () => {
  assert.equal(resolveAssetEmbed("a.png", [{ targetName: "a.png", assetId: null, isMissing: 1 }], [{ id: "legacy", name: "a.png", kind: "image" }]).asset, null);
});

test("explicit Vault-relative paths cannot bind to a same-basename global file", () => {
  const resolver = createRealVaultLibraryAssetResolver([{ id: "id", name: "photo.png", originalPath: "C:/global/photo.png" }]);
  assert.equal(resolver("attachments/photo.png"), null);
  assert.equal(resolver("../attachments/photo.png"), null);
  assert.equal(resolver("photo.png")?.id, "id");
});

test("reading preview emits image assets while preserving ordinary local and remote links", () => {
  const tokens = parseNoteInline("![图片|300](../attachments/a%20b.png) [PDF](./manual.pdf) [web](https://example.com) `![code](x.png)`");
  const assets = tokens.filter((token) => token.type === "asset");
  assert.equal(assets.length, 1);
  assert.equal(assets[0].target, "../attachments/a%20b.png");
  assert.equal(assets[0].width, 300);
  assert.equal(assets[0].markdown, true);
  assert.deepEqual(tokens.filter((token) => token.type === "url").map((token) => token.href), ["./manual.pdf", "https://example.com"]);
  assert.equal(standardMarkdownReferences("`![no](x.png)`\n\n```md\n![no](x.png)\n```\n\\![escaped](x.png)").filter((reference) => reference.embedded).length, 0);
});

test("Wiki literal percent and Markdown URL percent bindings remain distinct", () => {
  const assets = [{ id: "literal", name: "a%20b.png", kind: "image" }, { id: "space", name: "a b.png", kind: "image" }];
  const embeds = [{ targetName: "a%20b.png", assetId: "literal", isMissing: 0 }, { targetName: "md:a%20b.png", assetId: "space", isMissing: 0 }];
  assert.equal(resolveAssetEmbed("a%20b.png", embeds, assets).asset?.id, "literal");
  assert.equal(resolveAssetEmbed("a%20b.png", embeds, assets, "markdown").asset?.id, "space");
});

test("live editor creates existing image widget and a link widget without rendering code as attachments", async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  try {
    const { liveMarkdownPreview } = await server.ssrLoadModule("/src/features/notes/editor/liveMarkdownExtensions.ts");
    const assets = [{ id: "image", name: "a.png", kind: "image", previewUrl: "fixture://image" }, { id: "pdf", name: "a.pdf", kind: "document" }];
    const field = liveMarkdownPreview({ assets, notes: [], tags: [], noteLinks: [], noteEmbeds: [{ targetName: "md:./a.png", assetId: "image", isMissing: 0 }, { targetName: "md:./a.pdf", assetId: "pdf", isMissing: 0 }] });
    const source = "Intro\n\n![image](./a.png)\n\n[pdf](./a.pdf)\n\n`![code](./a.png)`";
    const state = EditorState.create({ doc: source, extensions: [field] });
    const widgets: string[] = [];
    state.field(field).between(0, source.length, (_from: number, _to: number, decoration: { spec: { widget?: { constructor: { name: string } } } }) => {
      const widget = decoration.spec.widget;
      if (widget) widgets.push(widget.constructor.name);
    });
    assert.equal(widgets.filter((name) => name === "AssetEmbedWidget").length, 1);
    assert.equal(widgets.filter((name) => name === "VaultAttachmentLinkWidget").length, 1);
  } finally { await server.close(); }
});
