import assert from "node:assert/strict";
import test from "node:test";
import {
  MATERIAL_COLOR_MATCH_THRESHOLDS,
  createMaterialHueFilter,
  materialColorFilterSample,
  materialPaletteMatchesStandardColor,
  normalizeStandardMaterialColorFilter,
} from "../src/features/materials/materialColorSimilarity";

test("perceptual hue matching wraps cleanly across zero and rejects distant hues", () => {
  const nearZero = createMaterialHueFilter(358);
  const wrappedSample = materialColorFilterSample(createMaterialHueFilter(2));
  const distantSample = materialColorFilterSample(createMaterialHueFilter(180));

  assert.equal(materialPaletteMatchesStandardColor(wrappedSample, nearZero), true);
  assert.equal(materialPaletteMatchesStandardColor(distantSample, nearZero), false);
  assert.equal(MATERIAL_COLOR_MATCH_THRESHOLDS.hueDegrees < 45, true);
});

test("any matching color in a multi-color material palette admits the asset", () => {
  const selected = createMaterialHueFilter(245);
  const near = materialColorFilterSample(createMaterialHueFilter(250));
  const far = materialColorFilterSample(createMaterialHueFilter(80));

  assert.equal(materialPaletteMatchesStandardColor(`${far},${near}`, selected), true);
  assert.equal(materialPaletteMatchesStandardColor(`${far},#invalid`, selected), false);
});

test("black, gray, and white are bounded neutral categories", () => {
  assert.equal(materialPaletteMatchesStandardColor("#050505", "neutral:black"), true);
  assert.equal(materialPaletteMatchesStandardColor("#777777", "neutral:gray"), true);
  assert.equal(materialPaletteMatchesStandardColor("#f8f8f8", "neutral:white"), true);
  assert.equal(materialPaletteMatchesStandardColor("#f8f8f8", "neutral:black"), false);
  assert.equal(materialPaletteMatchesStandardColor("#f02b36", "neutral:gray"), false);
});

test("missing and malformed palettes fail closed while legacy hex selections migrate", () => {
  assert.equal(materialPaletteMatchesStandardColor(null, createMaterialHueFilter(120)), false);
  assert.equal(materialPaletteMatchesStandardColor("not-a-palette", createMaterialHueFilter(120)), false);
  assert.match(normalizeStandardMaterialColorFilter("#ff0000") || "", /^hue:\d+$/u);
  assert.equal(normalizeStandardMaterialColorFilter("bad-selection"), null);
});
