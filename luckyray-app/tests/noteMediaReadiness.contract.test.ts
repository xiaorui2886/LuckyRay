// Shared media geometry and version-safe decoded-image reuse.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  applyRememberedMediaGeometry,
  isSessionReusableMediaUrl,
  readDecodedMediaGeometry,
  rememberDecodedMediaGeometry,
} from "../src/features/notes/media/noteMediaReadyCache.ts";

function fakeRoot() {
  const styles = new Map<string, string>();
  return {
    style: {
      setProperty: (key: string, value: string) => styles.set(key, value),
    },
    read: (key: string) => styles.get(key),
  } as unknown as HTMLElement;
}

test("the reuse gate accepts the URLs the app actually produces", () => {
  // convertFileSrc output (Tauri asset protocol) — the shape the old gate
  // rejected, killing the pool.
  assert.equal(isSessionReusableMediaUrl("http://asset.localhost/D%3A/vault/img.png"), false);
  assert.equal(isSessionReusableMediaUrl("asset://localhost/x/img.jpg"), false);
  assert.ok(isSessionReusableMediaUrl("http://asset.localhost/C%3A%5Ccache%5C" + "a".repeat(64) + ".png"));
  assert.ok(isSessionReusableMediaUrl("data:image/png;base64,AAAA"));
  assert.ok(isSessionReusableMediaUrl("blob:https://x/uuid"));
  assert.ok(isSessionReusableMediaUrl("https://x/img.png?vault=a&v=3"));
  // Non-media or unstable references stay out.
  assert.equal(isSessionReusableMediaUrl(""), false);
  assert.equal(isSessionReusableMediaUrl("note-relative.md"), false);
  assert.equal(isSessionReusableMediaUrl("https://x/img.png"), false);
});

test("remembered geometry reserves the exact shape and refreshes recency", () => {
  const root = fakeRoot();
  assert.equal(applyRememberedMediaGeometry(root, "asset://a.png"), false, "unknown source applies nothing");
  assert.equal(root.read("--note-media-ratio"), undefined);

  rememberDecodedMediaGeometry("asset://a.png", 1600, 900);
  assert.equal(applyRememberedMediaGeometry(root, "asset://a.png"), true);
  assert.equal(root.read("--note-media-ratio"), String(1600 / 900));
  assert.equal(root.read("--note-media-intrinsic-width"), "1600px");
  assert.equal(root.read("--asset-aspect"), "1600 / 900");

  // A re-measure overwrites the entry (same-path replacement self-corrects).
  rememberDecodedMediaGeometry("asset://a.png", 800, 600);
  const second = fakeRoot();
  applyRememberedMediaGeometry(second, "asset://a.png");
  assert.equal(second.read("--note-media-ratio"), String(800 / 600));

  // Invalid geometry is ignored, never stored.
  rememberDecodedMediaGeometry("asset://bad.png", 0, 10);
  assert.equal(readDecodedMediaGeometry("asset://bad.png"), null);
});

test("version refresh retains numeric layout only within the same vault/file", () => {
  const source = "http://asset.localhost/C%3A/vault/a.png?vault=one&v=old";
  rememberDecodedMediaGeometry(source, 720, 980);
  const fresh = source.replace("v=old", "v=new");
  assert.deepEqual(readDecodedMediaGeometry(fresh), { width: 720, height: 980 });
  assert.equal(readDecodedMediaGeometry(fresh.replace("vault=one", "vault=two")), null);
  assert.equal(readDecodedMediaGeometry(fresh.replace("a.png", "b.png")), null);
  rememberDecodedMediaGeometry(fresh, 640, 480);
  assert.deepEqual(readDecodedMediaGeometry(fresh), { width: 640, height: 480 });
  // Geometry reuse does not turn a mutable non-versioned URL into a pixel lease.
  assert.equal(isSessionReusableMediaUrl(source.split("?")[0]), false);
});

test("the geometry memory is bounded", () => {
  // Fill past the bound with distinct sources.
  for (let i = 0; i < 200; i += 1) rememberDecodedMediaGeometry(`asset://f${i}.png`, 100 + i, 100);
  // Early entries were evicted; recent ones survive. (Recency from the read
  // in the previous tests keeps old keys at the front of eviction.)
  const surviving = [];
  for (let i = 0; i < 200; i += 1) {
    if (readDecodedMediaGeometry(`asset://f${i}.png`)) surviving.push(i);
  }
  assert.ok(surviving.length > 0 && surviving.length <= 96, `bounded, got ${surviving.length}`);
  assert.ok(Math.max(...surviving) > 190, "the most recent entries are kept");
});

test("live and reading media use the shared image lifecycle", async () => {
  const [widgets, reading, images] = await Promise.all([
    readFile(new URL("../src/features/notes/editor/assetEmbedWidgets.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/features/notes/media/NoteMedia.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/notes/media/noteImageResources.ts", import.meta.url), "utf8"),
  ]);
  assert.match(widgets, /attachNoteImage/);
  assert.match(reading, /attachNoteImage/);
  assert.match(images, /isSessionReusableMediaUrl\(url\)/);
});
