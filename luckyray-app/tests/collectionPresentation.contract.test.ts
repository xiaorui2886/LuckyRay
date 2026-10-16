import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Collection uses the approved Tags page geometry and a quiet inline summary", async () => {
  const [page, css] = await Promise.all([
    source("src/features/collection/CollectionPage.tsx"),
    source("src/features/collection/collection.css"),
  ]);
  assert.match(page, /className="collection-page-content"/u);
  assert.match(page, /className="collection-summary"/u);
  assert.match(css, /\.collection-page\s*\{[^}]*padding:\s*clamp\(24px,\s*3vw,\s*44px\);/s);
  assert.match(css, /\.collection-page-content\s*\{[^}]*width:\s*min\(1480px,\s*100%\);[^}]*margin:\s*0 auto;/s);
  assert.match(css, /\.collection-hero h1\s*\{[^}]*font-size:\s*clamp\(25px,\s*2\.6vw,\s*34px\);/s);
  assert.doesNotMatch(css, /\.collection-stats div\s*\{/u);
});

test("Collection titles and URLs are bounded by their card and detail columns", async () => {
  const css = await source("src/features/collection/collection.css");
  assert.match(css, /\.collection-card h3,\s*\.collection-detail h2\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(css, /\.collection-detail\s*\{[^}]*min-width:\s*0;/s);
  assert.match(css, /\.collection-detail pre,[\s\S]*overflow-wrap:\s*anywhere;/s);
});
