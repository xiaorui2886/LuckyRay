import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("MaterialsPage wires the preset switcher, compare entry, and keyboard gates", async () => {
  const page = await readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
  // The single preset control lives in the titlebar; the page owns execution.
  assert.doesNotMatch(page, /<MaterialWorkViewSwitcher/u);
  assert.match(page, /case "cycle-workview":/u);
  // Applying a preset only changes presentation: viewMode + zoom channel.
  assert.match(page, /const applyWorkViewPreset = useCallback/u);
  assert.match(page, /switchMaterialWorkViewPreset\(/u);
  // Compare entry in the batch bar with an honest disabled reason.
  assert.match(page, /compareDisabled=\{compareDisabledReason !== null\}/u);
  assert.match(page, /compareReasonKey=\{compareDisabledReason\}/u);
  // Only exactly two supported images open compare.
  assert.match(page, /Array\.from\(selectedIds\)\.every\(\(id\) => \{/u);
  assert.match(page, /return asset \? isImageAsset\(asset\) : false;/u);
  assert.match(page, /selectedIds\.size < 2 \? "materials\.compare\.reason\.tooFew"/u);
  assert.match(page, /selectedIds\.size > 2 \? "materials\.compare\.reason\.tooMany"/u);
  // The modal renders inside the materials module with focus return.
  assert.match(page, /<MaterialCompareModal/u);
  assert.match(page, /compareEntryRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  // Keyboard gates on both window-level handlers.
  const gates = page.match(/compareOpenRef\.current/g) ?? [];
  assert.ok(gates.length >= 4, "both Escape/nav and material-shortcut handlers must gate on compare");
  // Manual presentation changes are recorded into the ACTIVE preset only.
  assert.match(page, /recordMaterialWorkViewAdjustment\(prefs, prefs\.active/u);
  // 通用 with no saved snapshot changes nothing (no forced overwrite).
  assert.match(page, /通用 with no saved target changes nothing at all/u);
});

test("sort is inside the filter surface, while the titlebar cycles work views and projects the folder", async () => {
  const page = await readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
  const sidebar = await readFile(new URL("../src/app/AppSidebar.tsx", import.meta.url), "utf8");
  assert.match(page, /materials\.filter\.sort/u);
  assert.match(page, /onChangeSort=\{setSortBy\}/u);
  assert.match(page, /folderName: selectedFolderId \? findFolderNode\(folders, selectedFolderId\)\?\.name \?\? null : null/u);
  assert.doesNotMatch(page, /<MaterialWorkViewSwitcher/u);
  assert.match(sidebar, /type: "cycle-workview"/u);
  assert.match(sidebar, /materialsToolbarState\.folderName/u);
  assert.doesNotMatch(sidebar, /className="sort-control"/u);
});

test("batch compare entry is honest about the disable reason", async () => {
  const page = await readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /materials\.compare\.reason\.mixedSelection/u);
  assert.match(page, /materials\.compare\.reason\.tooFew/u);
  assert.match(page, /materials\.compare\.reason\.tooMany/u);
});

test("compare modal never builds filesystem paths or bypasses preview services", async () => {
  const modal = await readFile(new URL("../src/features/materials/MaterialCompareModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /asset\.previewUrl \|\| asset\.thumbnailUrl/u);
  assert.doesNotMatch(modal, /convertFileSrc|localhost:|invoke\(|readFile\(|fs\./u);
  // Full keyboard trap on the dialog root.
  assert.match(modal, /event\.stopPropagation\(\);/u);
  // Late identity guard: onLoad/onError commit only on matching identity.
  assert.match(modal, /SLOT_IDENTITY\(assetsById\.get\(asset\.id\) \?\? asset\) !== identity\) return current;/u);
  // No object URLs created or revoked by the modal (uses given URLs only).
  assert.doesNotMatch(modal, /createObjectURL/u);
});
