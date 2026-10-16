import assert from "node:assert/strict";
import test from "node:test";
import {
  clearMaterialsToolbarFilters,
  countActiveMaterialsFilters,
  countActiveStandardMaterialsFilters,
  normalizeStandardMaterialsFilters,
} from "../src/features/materials/materialsToolbarProtocol";

const defaults = {
  kinds: [],
  tagIds: [],
  recentOnly: false,
  storageMode: "all" as const,
  folderId: null,
  color: null,
  dateFrom: "",
  dateTo: "",
  ratingMin: null,
};

test("default material filters do not contribute to the toolbar count", () => {
  assert.equal(countActiveMaterialsFilters(defaults), 0);
});

test("every canonical material filter dimension contributes exactly once", () => {
  assert.equal(countActiveMaterialsFilters({
    kinds: ["image", "video"],
    tagIds: ["tag-a", "tag-b"],
    recentOnly: true,
    storageMode: "managed",
    folderId: "folder-a",
    color: "#ffaa00",
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    ratingMin: 4,
  }), 9);
});

test("the standard materials panel counts only format, primary color, and rating", () => {
  assert.equal(countActiveStandardMaterialsFilters({
    kinds: ["image", "video"],
    tagIds: ["tag-a", "tag-b"],
    recentOnly: true,
    storageMode: "managed",
    folderId: "folder-a",
    color: "#ffaa00",
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    ratingMin: 4,
  }), 3);
});

test("standard materials state neutralizes legacy hidden filters without weakening the canonical shape", () => {
  const normalized = normalizeStandardMaterialsFilters({
    kinds: ["image"],
    tagIds: ["tag-a"],
    recentOnly: true,
    storageMode: "source",
    folderId: "folder-a",
    color: "#ffaa00",
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    ratingMin: 4,
  });

  assert.deepEqual(normalized, {
    kinds: ["image"],
    tagIds: [],
    recentOnly: false,
    storageMode: "all",
    folderId: null,
    color: "#ffaa00",
    dateFrom: "",
    dateTo: "",
    ratingMin: 4,
  });
  assert.equal(countActiveMaterialsFilters(normalized), 3);
});

test("clearing toolbar filters preserves the folder sidebar selection", () => {
  const cleared = clearMaterialsToolbarFilters({
    kinds: ["image"],
    tagIds: ["tag-a"],
    recentOnly: true,
    storageMode: "managed",
    folderId: "filter-folder",
    color: "#ffaa00",
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    ratingMin: 4,
    selectedFolderId: "sidebar-folder",
  });

  assert.equal(countActiveMaterialsFilters(cleared), 0);
  assert.equal(cleared.selectedFolderId, "sidebar-folder");
});
