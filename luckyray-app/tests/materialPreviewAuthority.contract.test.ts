import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const repoUrl = new URL("../", import.meta.url);

const source = (path: string) => readFile(new URL(path, repoUrl), "utf8");

test("resolveMaterialPreviewTarget prefers persisted image posters and falls back to first-frame video", async () => {
  const { resolveMaterialPreviewTarget } = await import("../src/core/services/materialCatalog");

  // Video with a persisted image poster: the poster is the canonical card art.
  assert.deepEqual(
    resolveMaterialPreviewTarget({
      kind: "video",
      thumbnailUrl: "http://asset.localhost/thumbs/abc.jpg",
      previewUrl: "http://asset.localhost/managed/abc.mp4",
    }),
    { kind: "image", url: "http://asset.localhost/thumbs/abc.jpg" },
  );
  assert.deepEqual(
    resolveMaterialPreviewTarget({
      kind: "video",
      thumbnailUrl: "data:image/jpeg;base64,abc",
      previewUrl: "http://asset.localhost/managed/abc.mp4",
    }),
    { kind: "image", url: "data:image/jpeg;base64,abc" },
  );

  // Legacy video without a persisted poster: honest first-frame playback URL,
  // never a reimport and never a Tags/LSH-only thumbnail store.
  assert.deepEqual(
    resolveMaterialPreviewTarget({
      kind: "video",
      thumbnailUrl: "http://asset.localhost/managed/legacy.mp4",
      previewUrl: "http://asset.localhost/managed/legacy.mp4",
    }),
    { kind: "video-frame", url: "http://asset.localhost/managed/legacy.mp4#t=0.1" },
  );
  assert.deepEqual(
    resolveMaterialPreviewTarget({ kind: "video", thumbnailUrl: "", previewUrl: "http://asset.localhost/managed/legacy.mp4" }),
    { kind: "video-frame", url: "http://asset.localhost/managed/legacy.mp4#t=0.1" },
  );

  // Images render through the same authority either way.
  assert.deepEqual(
    resolveMaterialPreviewTarget({ kind: "image", thumbnailUrl: "http://asset.localhost/pic.jpg", previewUrl: "http://asset.localhost/pic.jpg" }),
    { kind: "image", url: "http://asset.localhost/pic.jpg" },
  );
  assert.deepEqual(
    resolveMaterialPreviewTarget({ kind: "image", thumbnailUrl: "", previewUrl: "http://asset.localhost/pic.png" }),
    { kind: "image", url: "http://asset.localhost/pic.png" },
  );

  // Nothing resolvable: honest empty fallback.
  assert.equal(resolveMaterialPreviewTarget({ kind: "other", thumbnailUrl: "", previewUrl: "" }), null);
  assert.equal(resolveMaterialPreviewTarget({ kind: "video", thumbnailUrl: "", previewUrl: "" }), null);
});

test("tag detail renders previews through the shared resolver instead of <video src={thumbnailUrl}>", async () => {
  const [page, model] = await Promise.all([
    source("src/features/tags/TagDetail.tsx"),
    source("src/features/tags/tagDetailModel.ts"),
  ]);

  assert.match(page, /import \{ resolveMaterialPreviewTarget \} from "\.\.\/\.\.\/core\/services\/materialCatalog";/);
  // The old black-card render fed the poster (or a bare video URL) to <video>.
  assert.doesNotMatch(page, /<video\s[^>]*src=\{asset\.thumbnailUrl\}/);
  assert.match(page, /previewTarget\?\.kind === "video-frame"/);
  assert.match(page, /previewTarget\?\.kind === "image"/);

  // The playable preview URL travels with the asset item.
  assert.match(model, /previewUrl: string;/);
  assert.match(model, /previewUrl: asset\.previewUrl \|\| "",/);
});

test("the LightSeek material sidebar resolves video previews through the same authority", async () => {
  const browser = await source("src/features/ai/LightSeekContentBrowser.tsx");

  assert.match(browser, /import \{ resolveMaterialPreviewTarget \} from "\.\.\/\.\.\/core\/services\/materialCatalog";/);
  assert.doesNotMatch(browser, /asset\.previewUrl \|\| asset\.thumbnailUrl/);
  assert.match(browser, /previewTarget\?\.kind === "video-frame"/);
});
