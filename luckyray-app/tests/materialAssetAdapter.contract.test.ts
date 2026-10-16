import test from "node:test";
import assert from "node:assert/strict";
import { adaptMaterialAssetMedia, derivePreviewUrl } from "../src/core/services/materialAssetAdapter.ts";

const calls: string[] = [];
const native = { native: true, fileUrl: (path: string) => { calls.push(path); return `http://asset.localhost/${encodeURIComponent(path)}`; } };
const originalPath = String.raw`C:\原图\a 100% #1.png`;
const libraryPath = String.raw`D:\素材\a%20b.png`;

for (const storageMode of ["managed", "linked", "source"]) {
  test(`${storageMode} maps the actual physical image path without changing catalog identity`, () => {
    const asset = { id: "same-id", kind: "image", storageMode, originalPath, libraryPath, thumbnailUrl: "" };
    const result = adaptMaterialAssetMedia(asset, native);
    const expectedPath = storageMode === "linked" ? originalPath : libraryPath;
    assert.equal(result.thumbnailUrl, `http://asset.localhost/${encodeURIComponent(expectedPath)}`);
    assert.equal(result.previewUrl, result.thumbnailUrl);
    assert.equal(result.originalPath, originalPath);
    assert.equal(result.libraryPath, libraryPath);
    assert.equal(result.id, asset.id);
    assert.equal(asset.thumbnailUrl, "");
  });
}

test("raw Windows thumbnail is encoded once and adapting again is idempotent", () => {
  calls.length = 0;
  const first = adaptMaterialAssetMedia({ kind: "image", originalPath, storageMode: "source", thumbnailUrl: libraryPath }, native);
  assert.deepEqual(calls, [libraryPath, originalPath]);
  const second = adaptMaterialAssetMedia(first, native);
  assert.deepEqual(second, first);
  assert.deepEqual(calls, [libraryPath, originalPath]);
  assert.ok(first.thumbnailUrl.includes("a%2520b.png")); // literal %20 filename, not a space
});

test("video original remains playable while thumbnail stays a distinct image", () => {
  const video = String.raw`D:\素材\片段.mp4`;
  const poster = String.raw`C:\缓存\首帧.jpg`;
  const missing = adaptMaterialAssetMedia({ kind: "video", storageMode: "source", libraryPath: video }, native);
  assert.equal(missing.thumbnailUrl, "");
  assert.equal(missing.previewUrl, native.fileUrl(video));
  const ready = adaptMaterialAssetMedia({ ...missing, thumbnailUrl: poster }, native);
  assert.equal(ready.thumbnailUrl, native.fileUrl(poster));
  assert.equal(ready.previewUrl, missing.previewUrl);
});

test("existing browser media URLs survive without another conversion", () => {
  for (const url of ["asset://localhost/file", "http://asset.localhost/a%2520b", "https://example.test/image.png", "blob:test", "data:image/png;base64,AA=="]) {
    assert.equal(derivePreviewUrl("image", null, url, native), url);
  }
});

test("ordinary files do not acquire fake media previews and browser fallback needs no native bridge", () => {
  assert.equal(adaptMaterialAssetMedia({ kind: "document", libraryPath }, native).thumbnailUrl, "");
  assert.equal(adaptMaterialAssetMedia({ kind: "document", libraryPath }, native).previewUrl, "");
  const web = { native: false, fileUrl: () => { throw new Error("must not invoke native conversion"); } };
  assert.equal(adaptMaterialAssetMedia({ kind: "image", originalPath }, web).previewUrl, "");
  assert.equal(adaptMaterialAssetMedia({ kind: "image", thumbnailUrl: "blob:preview" }, web).thumbnailUrl, "blob:preview");
});


test("attachment scope and promote responses cross the same WebView adapter", async () => {
  const { listFilteredMaterialAssets, promoteMaterialAttachment } = await import("../src/core/services/materials.ts");
  const raw = { id: "attachment", kind: "image", storageMode: "source", originalPath, libraryPath, thumbnailUrl: libraryPath };
  const invoked: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNative = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: {
      convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
      invoke: async (command: string) => {
        invoked.push(command);
        return command === "material_catalog_list_note_attachments" ? [raw] : raw;
      },
    },
  } });
  try {
    const [listed] = await listFilteredMaterialAssets({ scope: "note-attachments", vaultId: "fixture" });
    const promoted = await promoteMaterialAttachment("attachment");
    assert.equal(listed.thumbnailUrl, `http://asset.localhost/${encodeURIComponent(libraryPath)}`);
    assert.deepEqual(promoted, listed);
    assert.deepEqual(invoked, ["material_catalog_list_note_attachments", "material_catalog_promote_note_attachment"]);
    assert.equal(raw.thumbnailUrl, libraryPath);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousNative) Object.defineProperty(globalThis, "isTauri", previousNative);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});
