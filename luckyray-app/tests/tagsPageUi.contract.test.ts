import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const repoUrl = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, repoUrl), "utf8");
}

test("Tags defaults to a calm searchable gallery instead of dense pills or auto-open detail", async () => {
  const page = await source("src/features/tags/TagsPage.tsx");

  assert.match(page, /<h1>\{t\("header\.title"\)\}<\/h1>/);
  assert.match(page, /<p>\{t\("header\.subtitle"\)\}<\/p>/);
  assert.match(page, /className="tag-create-button editorial-primary-action"[\s\S]*t\("action\.create"\)[\s\S]*<\/button>/);
  assert.match(page, /placeholder=\{t\("search"\)\}/);
  assert.match(page, /\[\["all", t\("filter\.all"\)\], \["mixed", t\("filter\.mixed"\)\], \["materials", t\("filter\.materials"\)\], \["knowledge", t\("filter\.knowledge"\)\]\]/);
  assert.match(page, /plural\(summary\.tags, \{ one: "summary\.tags\.one", other: "summary\.tags\.other" \}\)/);
  assert.match(page, /plural\(summary\.materials, \{ one: "summary\.materials\.one", other: "summary\.materials\.other" \}\)/);
  assert.match(page, /plural\(summary\.knowledge, \{ one: "summary\.knowledge\.one", other: "summary\.knowledge\.other" \}\)/);
  assert.match(page, /className="tag-gallery-grid"/);
  assert.match(page, /className="tag-gallery-card"/);
  assert.match(page, /className="tag-gallery-toolbar"/);
  assert.match(page, /className="tag-card-preview"/);
  assert.match(page, /galleryAssets/);
  const galleryCard = page.slice(page.indexOf("function TagGalleryCard"), page.indexOf("function TagFocusView"));
  assert.doesNotMatch(galleryCard, /<TagGlyph/);
  assert.doesNotMatch(page, /高频标签|其他标签|hotTags\[0\]|tag-pill|tag-color-dot/);
});

test("Tags focus view preserves browse state, handles external focus, and separates assets from documents", async () => {
  const [page, detail] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/tags/TagDetail.tsx"),
  ]);

  assert.match(page, /browseScrollTopRef/);
  assert.match(page, /restoreBrowseScrollRef/);
  assert.match(page, /useLayoutEffect\(\(\) => \{/);
  assert.match(page, /consumeNavFocus\("tag"\)/);
  assert.match(page, /t\("status\.missing"\)/);
  assert.match(page, /className="tag-back-button editorial-back-action"[\s\S]*<span>\{t\("action\.back"\)\}<\/span>/);
  assert.match(page, /aria-label=\{t\("action\.back"\)\}/);
  assert.match(page, /className="tag-back-icon editorial-back-icon"/);
  assert.match(page, /plural\(counts\.assetCount, \{ one: "detail\.materials\.one", other: "detail\.materials\.other" \}\)/);
  assert.match(page, /plural\(counts\.realVaultDocumentCount, \{ one: "detail\.knowledge\.one", other: "detail\.knowledge\.other" \}\)/);
  assert.match(page, /plural\(counts\.total, \{ one: "detail\.total\.one", other: "detail\.total\.other" \}\)/);
  assert.match(page, /\[\["all", t\("filter\.all"\)\], \["materials", t\("filter\.materials"\)\], \["knowledge", t\("filter\.knowledge"\)\]\]/);
  assert.match(page, /disabled=\{readOnly\}/);
  assert.match(page, /disabled=\{readOnly \|\| mergeCandidates\.length === 0\}/);
  assert.match(page, /editIconUrl/);
  assert.match(page, /mergeIconUrl/);
  assert.match(page, /deleteIconUrl/);
  assert.match(page, /aria-label=\{readOnly \? t\("status\.editReadonly"\) : t\("action\.edit"\)\}/);
  assert.match(page, /aria-label=\{readOnly \? t\("status\.mergeReadonly"\) : t\("action\.mergeTitle"\)\}/);
  assert.match(page, /aria-label=\{readOnly \? t\("status\.removeReadonly"\) : t\("action\.deleteTitle"\)\}/);
  assert.match(detail, /contentFilter\?: "all" \| "materials" \| "knowledge"/);
  assert.match(detail, /className="tag-detail-grid"/);
  assert.match(detail, /className="tag-document-list"/);
  assert.match(detail, /className="tag-document-row"/);
  assert.match(detail, /loadTagDetailItemsFromActiveBridge\(tagId, bridge\)/);
  assert.doesNotMatch(detail, /listFilteredMaterialAssets\([^\n]+\.catch\(\(\) => \[\]\)/);
  assert.match(detail, /removeAssetTagRelationsAndRefresh\(/);
});

test("Tags alone hides the global add control and its detail actions use audited line assets", async () => {
  const [sidebar, page, css, edit, merge, remove] = await Promise.all([
    source("src/app/AppSidebar.tsx"),
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/tags/tags.css"),
    source("src/assets/icons/lightseek-ui-v2/tag-edit-rounded.svg"),
    source("src/assets/icons/lightseek-ui-v2/tag-merge-rounded.svg"),
    source("src/assets/icons/lightseek-ui-v2/tag-delete-rounded.svg"),
  ]);
  assert.match(sidebar, /route !== "favorites" && route !== "smart" && route !== "tags" && route !== "settings"/);
  assert.match(page, /className="tag-detail-icon"[^>]*style=\{\{ "--tag-action-icon": `url\("\$\{editIconUrl\}"\)`/);
  assert.match(page, /className="tag-detail-icon"[^>]*style=\{\{ "--tag-action-icon": `url\("\$\{mergeIconUrl\}"\)`/);
  assert.match(page, /className="tag-detail-icon"[^>]*style=\{\{ "--tag-action-icon": `url\("\$\{deleteIconUrl\}"\)`/);
  assert.match(page, /tag-edit-rounded\.svg/);
  assert.match(page, /tag-merge-rounded\.svg/);
  assert.match(page, /tag-delete-rounded\.svg/);
  assert.match(css, /\.tag-detail-btn\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px/s);
  assert.match(css, /\.tag-detail-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/s);
  assert.match(css, /\.tag-detail-icon\s*\{[^}]*mask:\s*var\(--tag-action-icon\) center \/ contain no-repeat/s);
  for (const asset of [edit, merge, remove]) {
    assert.match(asset, /viewBox="0 0 24 24"/);
    assert.match(asset, /stroke="currentColor"/);
    assert.doesNotMatch(asset, /<(?:script|image|foreignObject)\b|\b(?:href|xlink:href)=/i);
  }
});

test("Tags styling reuses the controlled icon and restrained LuckyRay responsive system", async () => {
  const [page, css] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/tags/tags.css"),
  ]);

  assert.match(page, /assets\/icons\/lightseek-ui-v2\/tag\.svg/);
  assert.match(page, /className=\{`tag-glyph/);
  assert.match(css, /\.tag-gallery-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 250px\), 1fr\)\)/s);
  assert.match(css, /\.tag-gallery-card::before\s*\{[^}]*height:\s*2px;[^}]*background:\s*var\(--tag-card-color\)/s);
  assert.match(css, /\.tag-gallery-toolbar\s*\{[^}]*display:\s*grid/s);
  assert.doesNotMatch(css, /\.tag-gallery-toolbar\s*\{[^}]*(?:border|background):/s);
  assert.match(css, /\.tag-card-preview\s*\{/);
  assert.match(css, /\.tag-card-preview img\s*\{[^}]*object-fit:\s*cover/s);
  assert.match(css, /\.tag-sort-trigger\s*\{[^}]*height:\s*40px/s);
  assert.match(css, /mask:\s*var\(--tag-icon-url\)/);
  assert.match(css, /\.tag-color-swatch\s*\{[^}]*width:\s*34px;[^}]*height:\s*34px;[^}]*border-radius:\s*50%/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 1080px\)[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(`${page}\n${css}`, /tag-color-dot|tag-pill|linear-gradient|radial-gradient|box-shadow:\s*0 0 [^0]/);
});

test("Tags and Favorites use the same native select sort control without a second sort truth", async () => {
  const [page, css, sharedCss, favorites] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/tags/tags.css"),
    source("src/components/contentBrowserControls.css"),
    source("src/features/favorites/FavoritesPage.tsx"),
  ]);
  const sortMenu = page.match(/function TagSortMenu[\s\S]*?(?=\nfunction ColorSwatches)/)?.[0] || "";
  assert.match(sortMenu, /<select[\s\S]*className="tag-sort-trigger content-browser-control"[\s\S]*value=\{value\}[\s\S]*aria-label=\{t\("sort\.aria"\)\}/);
  assert.match(sortMenu, /onChange=\{\(event\) => onChange\(event\.target\.value as TagGallerySort\)\}/);
  assert.match(sortMenu, /<option key=\{option\.value\} value=\{option\.value\}>\{option\.label\}<\/option>/);
  assert.match(page, /\[\{ value: "linked", label: t\("sort\.linked"\) \}, \{ value: "name", label: t\("sort\.name"\) \}\]/);
  assert.match(favorites, /<select className="content-browser-control"[\s\S]*value=\{currentView\.sort\}/);
  assert.doesNotMatch(sortMenu, /useState|useEffect|useLayoutEffect|role="listbox"|aria-expanded|tag-sort-list|tag-sort-option|content-browser-menu|content-browser-option/);
  assert.match(css, /\.tag-sort-trigger\s*\{[^}]*height:\s*40px;[^}]*min-width:\s*106px;/s);
  assert.doesNotMatch(css, /tag-sort-list|tag-sort-option|tag-sort-check|\.tag-sort-trigger svg|aria-expanded/);
  assert.doesNotMatch(sharedCss, /content-browser-menu|content-browser-option/);
});

test("Tag create and edit share an accessible persistent color selection", async () => {
  const [page, css] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/tags/tags.css"),
  ]);
  assert.match(page, /role="radiogroup"/);
  assert.match(page, /role="radio"/);
  assert.match(page, /aria-checked=\{selected\}/);
  assert.match(page, /const tabStopIndex = selectedIndex >= 0 \? selectedIndex : 0/);
  assert.match(page, /tabIndex=\{index === tabStopIndex \? 0 : -1\}/);
  assert.match(page, /className="tag-color-check"/);
  assert.match(page, /ArrowLeft|ArrowRight/);
  assert.match(css, /\.tag-color-swatches\s*\{[^}]*grid-template-columns:\s*repeat\(8, 34px\)/s);
  assert.match(css, /\.tag-color-tone\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border-radius:\s*50%/s);
  assert.doesNotMatch(css, /\.tag-color-swatch\.active::before/);
  assert.match(css, /\.tag-color-swatch\.active \.tag-color-check/);
  assert.match(page, /<ColorSwatches value=\{createColor\} onChange=\{setCreateColor\}/);
  assert.match(page, /<ColorSwatches value=\{editColor\} onChange=\{setEditColor\}/);
});

test("Tag merge dialog presents the existing sources-to-retained-target flow", async () => {
  const page = await source("src/features/tags/TagsPage.tsx");
  assert.match(page, /className="tag-merge-flow"/);
  assert.match(page, /t\("merge\.sources"\)/);
  assert.match(page, /t\("merge\.target"\)/);
  assert.match(page, /className="tag-merge-direction"/);
  assert.match(page, /mergeAffectedCount/);
  assert.match(page, /checked=\{mergeIds\.includes\(tag\.id\)\}/);
  assert.match(page, /disabled=\{busy \|\| mergeIds\.length === 0\}/);
  assert.match(page, /dialogRole = "dialog"/);
  assert.match(page, /role=\{dialogRole\}/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /aria-label=\{t\("dialog\.close"\)\}/);
});

test("Tags component modules expose only components to the Fast Refresh boundary", async () => {
  const [page, detail] = await Promise.all([
    source("src/features/tags/TagsPage.tsx"),
    source("src/features/tags/TagDetail.tsx"),
  ]);
  assert.match(page, /from "\.\/tagGalleryModel"/);
  assert.match(detail, /from "\.\/tagDetailModel"/);
  assert.doesNotMatch(page, /export function (?:filterAndSortTagGallery|summarizeTagGallery|resolveTagFocusForActiveVault)/);
  assert.doesNotMatch(detail, /export function (?:createLatestTagDetailLoader|getTagDetailLoadKey|getTagDetailLoadMode)/);
});
