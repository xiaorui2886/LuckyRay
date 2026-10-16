import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("changing the catalog view retires an open immersive viewer first", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  assert.match(page, /case "set-view":\s*closeMaterialViewer\(\);\s*setViewMode\(command\.viewMode\);/u);
});

test("grid media uses one responsive 4:3 frame for images, video, and placeholders", async () => {
  const css = await source("src/features/materials/materials.css");
  assert.match(css, /\.grid-item-react \.grid-thumb\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*3;[^}]*height:\s*auto;/s);
  assert.match(css, /\.grid-item-react \.grid-thumb-placeholder\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*3;[^}]*height:\s*auto;/s);
  assert.match(css, /\.grid-thumb\.hover-video-wrap-react\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*3;/s);
});

test("grid and list cards render the same bounded palette used by the inspector", async () => {
  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);
  assert.match(page, /function AssetColorPalette\(/u);
  assert.equal((page.match(/<AssetColorPalette color=\{asset\.dominantColor\}/g) || []).length, 2);
  assert.match(page, /getMaterialPalette\(color, 5\)/u);
  assert.match(css, /\.asset-mini-palette-react\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*3px;/s);
});

test("the shared zoom truth scales list thumbnails instead of only grid and masonry", async () => {
  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);
  assert.match(page, /--materials-list-thumb-size/);
  assert.match(css, /\.list-item-react \.list-thumb\s*\{[^}]*width:\s*var\(--materials-list-thumb-size,\s*72px\);[^}]*height:\s*var\(--materials-list-thumb-size,\s*72px\);/s);
});

test("the materials toolbar uses calm rounded line icons and an aligned sort surface", async () => {
  const [sidebar, css] = await Promise.all([
    source("src/app/AppSidebar.tsx"),
    source("src/app/appShell.css"),
  ]);
  assert.match(sidebar, /viewMode === "list"[\s\S]*<path d="M2\.5 4\.25h11M2\.5 8h11M2\.5 11\.75h11"/u);
  assert.match(sidebar, /materials-filter-trigger[\s\S]*M2\.5 3\.5h11L9\.5 8v3\.2l-3 1\.4V8Z/u);
  assert.match(sidebar, /materials-missing-trigger[\s\S]*M8 2\.2c\.45 0 \.83\.23 1\.06\.63l5\.35 9\.25/u);
  assert.match(sidebar, /title=\{t\("titlebar\.materials\.importFolder"\)\}[\s\S]*M8 7\.5v5M5\.8 10\.3 8 12\.5l2\.2-2\.2/u);
  assert.doesNotMatch(css, /\.materials-titlebar \.sort-control\s*\{[^}]*inline-size:\s*116px;/s);
  assert.doesNotMatch(css, /\.sort-btn\s*\{[^}]*width:\s*100%;/s);
  assert.doesNotMatch(sidebar, /className="sort-control"/u);
  assert.match(sidebar, /className="workview-cycle"[\s\S]*type: "cycle-workview"/u);
  assert.match(css, /\.materials-titlebar \.view-cycle svg,[\s\S]*\.materials-titlebar \.zoom-slider svg\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*stroke-width:\s*1\.8;/s);
  assert.match(css, /\.materials-titlebar \.zoom-slider\s*\{[^}]*margin-inline-end:\s*6px;/s);
});

test("the standard materials panel presents sort plus exactly three filter criteria", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  const panel = page.slice(
    page.indexOf("function MaterialsFilterPanel("),
    page.indexOf("// ========== D110: 失效素材面板"),
  );
  const labels = [...panel.matchAll(/className="filter-panel-label-react">\{t\("([^"]+)"\)\}/gu)].map((match) => match[1]);

  assert.deepEqual(labels, ["materials.filter.sort", "materials.filter.format", "materials.filter.color", "materials.filter.rating"]);
  assert.match(panel, /MATERIALS_SORT_OPTIONS\.map/u);
  assert.doesNotMatch(panel, /materials-filter-(?:tags|folders|storage|quick|date)-label/u);
  assert.doesNotMatch(panel, />高级条件<|>最近导入<|>存储<|>文件夹<|>标签</u);
});

test("legacy persisted and warm-cache filters are projected before the standard materials route uses them", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  assert.match(
    page,
    /normalizeStandardMaterialsFilters\(initialViewCache\?\.filter \|\| loadFilterState\(\)\)/u,
  );
});

test("the standard color filter is a continuous accessible spectrum with bounded neutral choices", async () => {
  const [page, css] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);
  const panel = page.slice(
    page.indexOf("function MaterialsFilterPanel("),
    page.indexOf("// ========== D110: 失效素材面板"),
  );

  assert.match(panel, /type="range"[\s\S]*min=\{0\}[\s\S]*max=\{359\}/u);
  assert.match(panel, /t\("materials\.filter\.unlimited"\)/u);
  assert.match(panel, /t\("materials\.filter\.neutralBlack"\)[\s\S]*t\("materials\.filter\.neutralGray"\)[\s\S]*t\("materials\.filter\.neutralWhite"\)/u);
  assert.doesNotMatch(panel, /filter-color-dot-react/u);
  assert.match(panel, /requestAnimationFrame\(/u);
  assert.doesNotMatch(panel, /setTimeout|setInterval|ResizeObserver/u);
  assert.match(css, /\.filter-hue-range-react[\s\S]*linear-gradient\([^}]*oklch/u);
});

test("rating uses five FavoriteGlyph threshold radios instead of text chips", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  const panel = page.slice(
    page.indexOf("function MaterialsFilterPanel("),
    page.indexOf("// ========== D110: 失效素材面板"),
  );

  assert.match(panel, /role="radiogroup"[\s\S]*aria-label=\{t\("materials\.filter\.rating"\)\}/u);
  assert.match(panel, /role="radio"[\s\S]*aria-checked=\{ratingMin === rating\}/u);
  assert.match(panel, /aria-label=\{plural\(rating, \{ one: "materials\.filter\.atLeastStars\.one", other: "materials\.filter\.atLeastStars\.other" \}\)\}/u);
  assert.match(panel, /rating <= previewRating \? " filled" : ""/u);
  assert.match(panel, /<FavoriteGlyph filled=\{rating <= previewRating\}/u);
  assert.match(await source("src/features/materials/materials.css"), /\.filter-rating-option-react\.filled\s*,[\s\S]*color:\s*var\(--accent\);/u);
  assert.doesNotMatch(panel, /\{rating\}星\+/u);
  assert.match(page, /onChangeRatingMin=\{\(rating\) => setFilterRatingMin\(\(current\) => current === rating \? null : rating\)\}/u);
});

test("similar color projection uses the complete allAssets palette and never sends exact color to the backend", async () => {
  const page = await source("src/features/materials/MaterialsPage.tsx");
  const query = page.slice(page.indexOf("const serverFilterKey"), page.indexOf("const revalidateMaterials"));

  assert.match(page, /colorMatchedAssetIds[\s\S]*allAssets\.filter\(\(asset\) => materialPaletteMatchesStandardColor/u);
  assert.match(page, /colorMatchedAssetIds[\s\S]*filtered = filtered\.filter\(\(asset\) => colorMatchedAssetIds\.has\(asset\.id\)\)/u);
  assert.doesNotMatch(query, /dominantColor|filterColor/u);
});
