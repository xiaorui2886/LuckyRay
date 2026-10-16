import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPARE_BASE_MAX_MULTIPLIER,
  COMPARE_VISIBLE_FRACTION,
  clampCompareMultiplierToBounds,
  clampComparePanOffset,
  reclampCompareStateAfterResize,
  resolveCompareFitScale,
  resolveCompareGridColumns,
  resolveCompareMultiplierBounds,
  resolveOneToOneMultiplier,
  safeCompareDimensions,
  zoomCompareSlot,
} from "../src/features/materials/materialCompareGeometry.ts";
import {
  MATERIAL_WORK_VIEW_DEFAULTS,
  MATERIAL_WORK_VIEW_STORAGE_KEY,
  recordMaterialWorkViewAdjustment,
  resolveMaterialWorkViewSnapshot,
  sanitizeMaterialWorkViewPreferences,
  switchMaterialWorkViewPreset,
} from "../src/features/materials/materialWorkViewPresets.ts";

test("fit scale uses contain semantics and guards degenerate sizes", () => {
  const cell = { width: 400, height: 300 };
  assert.equal(resolveCompareFitScale(cell, { width: 800, height: 600 }), 0.5);
  assert.equal(resolveCompareFitScale(cell, { width: 200, height: 600 }), 0.5);
  assert.equal(resolveCompareFitScale(cell, { width: 0, height: 10 }), 1);
  assert.equal(resolveCompareFitScale({ width: 0, height: 0 }, { width: 10, height: 10 }), 1);
  assert.equal(safeCompareDimensions({ width: NaN, height: 10 }), null);
  assert.equal(safeCompareDimensions({ width: 10, height: -1 }), null);
});

test("100% multiplier is ABSOLUTE: rendering scale becomes exactly 1 CSS px per image px", () => {
  const cell = { width: 800, height: 600 };
  // Image SMALLER than the cell (fit=2 upscales): true 1:1 must be BELOW fit
  // and reachable — the rendered width equals the natural width.
  const small = resolveOneToOneMultiplier(cell, { width: 400, height: 300 });
  const smallFit = resolveCompareFitScale(cell, { width: 400, height: 300 });
  assert.ok(Math.abs(small * smallFit - 1) < 1e-9, "small image at 1:1 renders 400 CSS px wide");
  // Image larger than the cell: 1:1 is above fit.
  const large = resolveOneToOneMultiplier(cell, { width: 1600, height: 1200 });
  assert.ok(Math.abs(large * resolveCompareFitScale(cell, { width: 1600, height: 1200 }) - 1) < 1e-9);
  assert.ok(Math.abs(large - 2) < 1e-9);
  // Mixed aspect: 1:1 depends only on the contain axis.
  const mixed = resolveOneToOneMultiplier(cell, { width: 3200, height: 600 });
  assert.ok(Math.abs(mixed - 4) < 1e-9);
});

test("wheel zoom anchors the cursor's normalized focal point", () => {
  const cell = { width: 400, height: 400 };
  const image = { width: 800, height: 800 };
  const state = { multiplier: 1, offset: { x: 0, y: 0 } };
  // Fit scale = 0.5 → projected 400×400 exactly fills the cell at m=1.
  const zoomed = zoomCompareSlot(state, 2, { x: 300, y: 100 }, cell, image);
  // Anchor point (300,100) must stay at the same normalized position:
  // fx = 300/400 = 0.75, fy = 100/400 = 0.25 over the new 800×800 box.
  assert.ok(Math.abs(zoomed.offset.x - (300 - 0.75 * 800)) < 1e-9);
  assert.ok(Math.abs(zoomed.offset.y - (100 - 0.25 * 800)) < 1e-9);
  assert.equal(zoomed.multiplier, 2);
});

test("per-slot multiplier bounds keep ABSOLUTE 1:1 always reachable (R2)", () => {
  // Small image (fit > 1): bounds must extend BELOW 1 so 1/fit is reachable.
  const smallBounds = resolveCompareMultiplierBounds(6.5); // e.g. 80px image in a 521px stage
  assert.ok(smallBounds.lower <= 1 / 6.5 + 1e-9, "1:1 below fit must be allowed");
  assert.ok(smallBounds.lower < 1, "small images can zoom out below fit to 1:1");
  // Huge image (fit < 1): bounds must extend ABOVE 16 if 1/fit exceeds it.
  const hugeBounds = resolveCompareMultiplierBounds(0.05); // 16000px image
  assert.ok(hugeBounds.upper >= 1 / 0.05, "1:1 above the base ceiling must be allowed");
  assert.ok(hugeBounds.upper >= COMPARE_BASE_MAX_MULTIPLIER);
  // Typical image: [1,16].
  const typical = resolveCompareMultiplierBounds(0.5);
  assert.deepEqual(typical, { lower: 1, upper: 16 });
  // NaN-safe clamping against bounds.
  assert.equal(clampCompareMultiplierToBounds(Number.NaN, typical), typical.lower);
  assert.equal(clampCompareMultiplierToBounds(99, typical), typical.upper);
  // The 1:1 target is always within its own bounds.
  const cell = { width: 521, height: 553 };
  assert.ok(Math.abs(resolveOneToOneMultiplier(cell, { width: 80, height: 80 }) - 1 / (521 / 80)) < 1e-9);
});

test("pan clamp keeps a visible fraction of the projected image in the cell", () => {
  // Projected larger than the cell: allowed window is
  // [minVisible - projected, cell - minVisible].
  const projected = 1000;
  const cell = 400;
  const minVisible = projected * COMPARE_VISIBLE_FRACTION;
  const lower = minVisible - projected;
  const upper = cell - minVisible;
  assert.equal(clampComparePanOffset(-5000, projected, cell), lower);
  assert.equal(clampComparePanOffset(5000, projected, cell), upper);
  assert.equal(clampComparePanOffset(-300, projected, cell), -300);
  // Projected smaller than the cell: centered (cell - projected)/2.
  assert.equal(clampComparePanOffset(123, 100, 400), 150);
  // Degenerate sizes never produce NaN.
  assert.equal(clampComparePanOffset(Number.NaN, projected, cell), 0);
  assert.equal(clampComparePanOffset(0, 0, 0), 0);
});

test("resize re-clamps pan but preserves the multiplier semantics", () => {
  const image = { width: 800, height: 800 };
  const before = { width: 400, height: 400 };
  const after = { width: 200, height: 200 };
  const state = { multiplier: 4, offset: { x: -1500, y: -1500 } };
  const reclamped = reclampCompareStateAfterResize(state, after, image);
  assert.equal(reclamped.multiplier, 4);
  const projected = 800 * 4 * resolveCompareFitScale(after, image);
  const minVisible = projected * COMPARE_VISIBLE_FRACTION;
  assert.ok(reclamped.offset.x >= minVisible - projected - 1e-9);
  assert.ok(reclamped.offset.x <= after.width - minVisible + 1e-9);
  void before;
});

test("grid columns: 2 slots side by side, 3–4 in a 2x2 grid", () => {
  assert.equal(resolveCompareGridColumns(2), 2);
  assert.equal(resolveCompareGridColumns(3), 2);
  assert.equal(resolveCompareGridColumns(4), 2);
});

test("work view snapshots: general never overwrites, others use saved > default", () => {
  // 未使用预设（null）+ general → null（保持用户现状）
  assert.equal(resolveMaterialWorkViewSnapshot(null, "general"), null);
  // design 默认
  const designDefault = resolveMaterialWorkViewSnapshot(null, "design");
  assert.deepEqual(designDefault, MATERIAL_WORK_VIEW_DEFAULTS.design);
  // 已保存的调整优先于默认
  const prefs = {
    active: "design" as const,
    saved: { design: { viewMode: "list" as const, zoom: 220 } },
  };
  assert.deepEqual(resolveMaterialWorkViewSnapshot(prefs, "design"), { viewMode: "list", zoom: 220 });
  // 保存值越界时：合法 viewMode 保留、zoom 被夹回范围内（不是整体回退）
  const badPrefs = { active: "video" as const, saved: { video: { viewMode: "grid" as const, zoom: 9999 } } };
  assert.deepEqual(resolveMaterialWorkViewSnapshot(badPrefs, "video"), { viewMode: "grid", zoom: 300 });
});

test("work view persistence: sanitize rejects garbage, records round-trip", () => {
  assert.equal(sanitizeMaterialWorkViewPreferences({ active: "nope" }), null);
  assert.equal(sanitizeMaterialWorkViewPreferences("x"), null);
  const clean = sanitizeMaterialWorkViewPreferences({
    active: "general",
    saved: { general: { viewMode: "grid", zoom: 200 }, design: { viewMode: "bogus", zoom: 100 } },
  });
  assert.deepEqual(clean, { active: "general", saved: { general: { viewMode: "grid", zoom: 200 } } });
  // recording only a view change preserves the stored zoom
  const base = { active: "design" as const, saved: { design: { viewMode: "grid" as const, zoom: 240 } } };
  const next = recordMaterialWorkViewAdjustment(base, "design", { viewMode: "list", zoom: 240 });
  assert.deepEqual(next.saved.design, { viewMode: "list", zoom: 240 });
  // recording from null creates the store
  const created = recordMaterialWorkViewAdjustment(null, "video", { viewMode: "masonry", zoom: 260 });
  assert.equal(created.active, "video");
  assert.deepEqual(created.saved.video, { viewMode: "masonry", zoom: 260 });
  void MATERIAL_WORK_VIEW_STORAGE_KEY;
});
test("preset switching: first departure from general snapshots the habit, return restores it (R5)", () => {
  // User's pre-preset habit: list view at 240.
  const current = { viewMode: "list" as const, zoom: 240 };
  // general → design (first departure): general.saved captures the habit.
  const first = switchMaterialWorkViewPreset(null, "design", current);
  assert.equal(first.preferences.active, "design");
  assert.deepEqual(first.preferences.saved.general, { viewMode: "list", zoom: 240 });
  assert.deepEqual(first.target, MATERIAL_WORK_VIEW_DEFAULTS.design);
  // design → general: the snapshot restores the exact habit.
  const back = switchMaterialWorkViewPreset(first.preferences, "general", current);
  assert.equal(back.preferences.active, "general");
  assert.deepEqual(back.target, { viewMode: "list", zoom: 240 });
  // Re-entering design uses any saved design adjustments, and does NOT
  // re-snapshot general (already saved).
  const again = switchMaterialWorkViewPreset(back.preferences, "design", current);
  assert.deepEqual(again.preferences.saved.general, { viewMode: "list", zoom: 240 });
  // Same-preset switch is a no-op.
  const noop = switchMaterialWorkViewPreset(again.preferences, "design", current);
  assert.deepEqual(noop.preferences, again.preferences);
});
