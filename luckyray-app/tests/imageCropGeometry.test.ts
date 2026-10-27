import test from "node:test";
import assert from "node:assert/strict";
import {
  clampCropRect,
  cropNudgeDelta,
  moveCropRect,
  resizeCropRect,
} from "../src/core/canvas/imageCropGeometry.ts";
import type {
  CropArrowKey,
  CropDelta,
  CropHandle,
  CropRect,
  CropSourceSize,
} from "../src/core/canvas/imageCropGeometry.ts";
import { centeredCrop, imageEditWithCrop, validateImageEdit } from "../src/core/canvas/imageEditing.ts";
import type { ImageEdit } from "../src/core/canvas/imageEditing.ts";

const handles: CropHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const arrows: CropArrowKey[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
const landscape = { width: 4000, height: 3000 };
const original = { x: 0.2, y: 0.25, width: 0.4, height: 0.3 };
const epsilon = 1e-12;

function near(actual: number, expected: number, label = "") {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} ≠ ${expected}`);
}

function nearRect(actual: CropRect, expected: CropRect) {
  for (const key of ["x", "y", "width", "height"] as const) near(actual[key], expected[key], key);
}

function assertValid(rect: CropRect, source: CropSourceSize, ratio?: number) {
  assert.ok(Object.values(rect).every(Number.isFinite), `nonfinite crop ${JSON.stringify(rect)}`);
  assert.ok(rect.x >= 0 && rect.y >= 0, `negative origin ${JSON.stringify(rect)}`);
  assert.ok(rect.x + rect.width <= 1 + epsilon, `right outside source ${JSON.stringify(rect)}`);
  assert.ok(rect.y + rect.height <= 1 + epsilon, `bottom outside source ${JSON.stringify(rect)}`);
  assert.ok(rect.width * source.width >= 1 - 1e-8, `width below one pixel: ${rect.width * source.width}`);
  assert.ok(rect.height * source.height >= 1 - 1e-8, `height below one pixel: ${rect.height * source.height}`);
  if (ratio !== undefined) {
    const actualRatio = (rect.width * source.width) / (rect.height * source.height);
    assert.ok(Math.abs(actualRatio / ratio - 1) < 1e-10, `pixel ratio ${actualRatio} ≠ ${ratio}`);
  }
}

function assertAnchors(before: CropRect, after: CropRect, handle: CropHandle) {
  if (handle.includes("w")) near(after.x + after.width, before.x + before.width, `${handle} right anchor`);
  else if (handle.includes("e")) near(after.x, before.x, `${handle} left anchor`);
  else near(after.x + after.width / 2, before.x + before.width / 2, `${handle} x center`);
  if (handle.includes("n")) near(after.y + after.height, before.y + before.height, `${handle} bottom anchor`);
  else if (handle.includes("s")) near(after.y, before.y, `${handle} top anchor`);
  else near(after.y + after.height / 2, before.y + before.height / 2, `${handle} y center`);
}

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("clamp fits legal outside rectangles and enforces a one-source-pixel floor", () => {
  assert.deepEqual(clampCropRect({ x: -3, y: 7, width: 0.5, height: 0.25 }, landscape), {
    x: 0, y: 0.75, width: 0.5, height: 0.25,
  });
  assert.deepEqual(clampCropRect({ x: 2, y: -1, width: 2, height: 3 }, landscape), {
    x: 0, y: 0, width: 1, height: 1,
  });
  assert.deepEqual(clampCropRect({ x: 1, y: 1, width: 1e-20, height: 1e-20 }, landscape), {
    x: 1 - 1 / 4000, y: 1 - 1 / 3000, width: 1 / 4000, height: 1 / 3000,
  });
  assert.deepEqual(clampCropRect(original, { width: 1, height: 1 }), {
    x: 0, y: 0, width: 1, height: 1,
  });
});

test("movement saturates every boundary without shrinking or mutating the crop", () => {
  const crop = Object.freeze({ ...original });
  const source = Object.freeze({ ...landscape });
  const delta = Object.freeze({ x: 0.1, y: -0.1 });
  nearRect(moveCropRect(crop, delta, source), { ...crop, x: 0.3, y: 0.15 });
  for (const x of [-Number.MAX_VALUE, -2, 0, 2, Number.MAX_VALUE]) {
    for (const y of [-Number.MAX_VALUE, -2, 0, 2, Number.MAX_VALUE]) {
      const moved = moveCropRect(crop, { x, y }, source);
      assertValid(moved, source);
      assert.equal(moved.width, crop.width);
      assert.equal(moved.height, crop.height);
      assert.notEqual(moved, crop);
      near(moved.x, Math.max(0, Math.min(1 - crop.width, crop.x + x)));
      near(moved.y, Math.max(0, Math.min(1 - crop.height, crop.y + y)));
    }
  }
  assert.deepEqual(crop, original);
  assert.deepEqual(delta, { x: 0.1, y: -0.1 });
  assert.deepEqual(source, landscape);
});

test("all eight free handles change only their intended edges", () => {
  const delta = { x: 0.05, y: 0.05 };
  for (const handle of handles) {
    const resized = resizeCropRect(original, handle, delta, landscape);
    assertValid(resized, landscape);
    assertAnchors(original, resized, handle);
    near(resized.width, original.width + (handle.includes("w") ? -delta.x : handle.includes("e") ? delta.x : 0));
    near(resized.height, original.height + (handle.includes("n") ? -delta.y : handle.includes("s") ? delta.y : 0));
    near(resized.x, original.x + (handle.includes("w") ? delta.x : 0));
    near(resized.y, original.y + (handle.includes("n") ? delta.y : 0));
    nearRect(resizeCropRect(original, handle, { x: 0, y: 0 }, landscape), original);
  }
});

test("free resize crossing the opposite anchor stops at one pixel and never flips", () => {
  for (const handle of handles) {
    const collapse = {
      x: handle.includes("w") ? 20 : -20,
      y: handle.includes("n") ? 20 : -20,
    };
    const shrunk = resizeCropRect(original, handle, collapse, landscape);
    assertValid(shrunk, landscape);
    assertAnchors(original, shrunk, handle);
    near(shrunk.width, handle.includes("w") || handle.includes("e") ? 1 / landscape.width : original.width);
    near(shrunk.height, handle.includes("n") || handle.includes("s") ? 1 / landscape.height : original.height);
    const expanded = resizeCropRect(original, handle, { x: -collapse.x, y: -collapse.y }, landscape);
    assertValid(expanded, landscape);
    assertAnchors(original, expanded, handle);
    if (handle.includes("w")) near(expanded.x, 0);
    if (handle.includes("e")) near(expanded.x + expanded.width, 1);
    if (handle.includes("n")) near(expanded.y, 0);
    if (handle.includes("s")) near(expanded.y + expanded.height, 1);
  }
});

test("locked ratios use oriented source pixels, not normalized or CSS-preview dimensions", () => {
  for (const source of [landscape, { width: 3000, height: 4000 }]) {
    const initial = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 * source.width / source.height };
    const square = resizeCropRect(initial, "se", { x: 0.05, y: 0 }, source, 1);
    assertValid(square, source, 1);
    assertAnchors(initial, square, "se");
    near(square.width, 0.35);
    near(square.height, 0.35 * source.width / source.height);
    assert.notEqual(square.width, square.height);
  }
});

test("fixed corners choose the larger relative edge change; vertical drag and horizontal ties work", () => {
  const source = { width: 1600, height: 900 };
  const initial = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };
  // Same normalized sides have a 16:9 pixel ratio on this source.
  nearRect(resizeCropRect(initial, "se", { x: 0, y: 0.1 }, source, 16 / 9), {
    ...initial, width: 0.4, height: 0.4,
  });
  nearRect(resizeCropRect(initial, "se", { x: -0.1, y: 0.1 }, source, 16 / 9), {
    ...initial, width: 0.2, height: 0.2,
  });
  nearRect(resizeCropRect(initial, "se", { x: -0.01, y: 0.1 }, source, 16 / 9), {
    ...initial, width: 0.4, height: 0.4,
  });
  const squareSource = { width: 1000, height: 1000 };
  const wide = { x: 0.2, y: 0.2, width: 0.4, height: 0.2 };
  // 0.06 / 0.2 > 0.1 / 0.4: vertical wins despite its smaller absolute delta.
  nearRect(resizeCropRect(wide, "se", { x: 0.1, y: 0.06 }, squareSource, 2), {
    ...wide, width: 0.52, height: 0.26,
  });
});

test("fixed edge resizing keeps perpendicular center and limits growth there instead of shifting", () => {
  const source = { width: 1000, height: 1000 };
  const nearTop = { x: 0.3, y: 0.02, width: 0.2, height: 0.2 };
  const right = resizeCropRect(nearTop, "e", { x: 10, y: 10 }, source, 1);
  nearRect(right, { x: 0.3, y: 0, width: 0.24, height: 0.24 });
  const left = resizeCropRect(nearTop, "w", { x: -10, y: -10 }, source, 1);
  nearRect(left, { x: 0.26, y: 0, width: 0.24, height: 0.24 });
  const nearLeft = { x: 0.02, y: 0.3, width: 0.2, height: 0.2 };
  const down = resizeCropRect(nearLeft, "s", { x: 10, y: 10 }, source, 1);
  nearRect(down, { x: 0, y: 0.3, width: 0.24, height: 0.24 });
  const up = resizeCropRect(nearLeft, "n", { x: -10, y: -10 }, source, 1);
  nearRect(up, { x: 0, y: 0.26, width: 0.24, height: 0.24 });
  for (const [before, after, handle] of [
    [nearTop, right, "e"], [nearTop, left, "w"], [nearLeft, down, "s"], [nearLeft, up, "n"],
  ] as const) {
    assertValid(after, source, 1);
    assertAnchors(before, after, handle);
  }
  nearRect(resizeCropRect(nearTop, "e", { x: 0, y: 20 }, source, 1), nearTop);
  nearRect(resizeCropRect(nearLeft, "n", { x: 20, y: 0 }, source, 1), nearLeft);
});

test("locked shrinking retains both pixel minima without independently clamping width and height", () => {
  const source = { width: 1200, height: 800 };
  for (const ratio of [1, 16 / 9, 9 / 16, 0.01, 100]) {
    const full = centeredCrop(source.width, source.height, ratio);
    const initial = { ...full, width: full.width / 2, height: full.height / 2 };
    for (const handle of handles) {
      const collapsed = resizeCropRect(initial, handle, {
        x: handle.includes("w") ? 10 : -10,
        y: handle.includes("n") ? 10 : -10,
      }, source, ratio);
      assertValid(collapsed, source, ratio);
      assertAnchors(initial, collapsed, handle);
      near(collapsed.width * source.width, Math.max(1, ratio));
      near(collapsed.height * source.height, Math.max(1, 1 / ratio));
    }
  }
});

test("keyboard nudges are exactly one or ten oriented source pixels, independent of preview scale", () => {
  for (const source of [landscape, { width: 3000, height: 4000 }, { width: 1, height: 1 }]) {
    for (const shift of [false, true]) {
      const step = shift ? 10 : 1;
      for (const key of arrows) {
        const delta = cropNudgeDelta(key, source, shift);
        near(delta.x * source.width, key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0);
        near(delta.y * source.height, key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0);
        assertValid(moveCropRect(original, delta, source), source);
      }
    }
  }
  const source = { width: 1600, height: 900 };
  const square = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 * 1600 / 900 };
  for (const shift of [false, true]) {
    const step = shift ? 10 : 1;
    const horizontal = resizeCropRect(square, "se", cropNudgeDelta("ArrowRight", source, shift), source, 1);
    const vertical = resizeCropRect(square, "se", cropNudgeDelta("ArrowDown", source, shift), source, 1);
    near((horizontal.width - square.width) * source.width, step);
    near((vertical.height - square.height) * source.height, step);
    assertValid(horizontal, source, 1);
    assertValid(vertical, source, 1);
  }
});

test("resize rejects a ratio that cannot fit its anchor/center without moving that anchor", () => {
  const source = { width: 100, height: 100 };
  const tiny = { x: 0, y: 0, width: 0.01, height: 0.01 };
  assert.throws(() => resizeCropRect(tiny, "nw", { x: 0, y: 0 }, source, 2), /crop-aspect-does-not-fit/);
  assert.throws(() => resizeCropRect(tiny, "e", { x: 1, y: 0 }, source, 0.5), /crop-aspect-does-not-fit/);
  assert.throws(() => resizeCropRect(original, "se", { x: 0, y: 0 }, source, 0.001), /crop-aspect-does-not-fit/);
  assert.throws(() => resizeCropRect(original, "se", { x: 0, y: 0 }, source, 101), /crop-aspect-does-not-fit/);
  // A mismatched starting ratio may be fitted if the same anchors have room.
  const fitted = resizeCropRect(original, "se", { x: 0, y: 0 }, source, 1);
  assertValid(fitted, source, 1);
  assertAnchors(original, fitted, "se");
});

test("malformed rectangles, deltas, handles, aspect ratios, keys and source sizes fail closed", () => {
  const badSources = [
    null, {}, { width: 0, height: 1 }, { width: 1, height: -1 }, { width: 1.1, height: 2 },
    { width: NaN, height: 1 }, { width: 1, height: Infinity }, { width: 8001, height: 8000 },
    { width: Number.MAX_SAFE_INTEGER + 1, height: 1 }, { width: "100", height: 100 },
  ] as unknown as CropSourceSize[];
  for (const source of badSources) {
    assert.throws(() => clampCropRect(original, source), /invalid-crop-source/);
    assert.throws(() => moveCropRect(original, { x: 0, y: 0 }, source), /invalid-crop-source/);
    assert.throws(() => resizeCropRect(original, "e", { x: 0, y: 0 }, source), /invalid-crop-source/);
    assert.throws(() => cropNudgeDelta("ArrowUp", source), /invalid-crop-source/);
  }
  const badRects = [null, {}, { ...original, width: 0 }, { ...original, height: -1 }];
  for (const key of ["x", "y", "width", "height"]) {
    for (const value of [NaN, Infinity, -Infinity, "0.5", undefined]) badRects.push({ ...original, [key]: value });
  }
  for (const rect of badRects as unknown as CropRect[]) {
    assert.throws(() => clampCropRect(rect, landscape), /invalid-crop-rect/);
    assert.throws(() => moveCropRect(rect, { x: 0, y: 0 }, landscape), /invalid-crop-rect/);
    assert.throws(() => resizeCropRect(rect, "e", { x: 0, y: 0 }, landscape), /invalid-crop-rect/);
  }
  for (const delta of [null, {}, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: "1", y: 0 }] as unknown as CropDelta[]) {
    assert.throws(() => moveCropRect(original, delta, landscape), /invalid-crop-delta/);
    assert.throws(() => resizeCropRect(original, "e", delta, landscape), /invalid-crop-delta/);
  }
  for (const ratio of [0, -1, NaN, Infinity, -Infinity, null, "1"] as number[]) {
    assert.throws(() => resizeCropRect(original, "e", { x: 0, y: 0 }, landscape, ratio), /invalid-crop-aspect/);
  }
  for (const handle of ["", "north", "move", null, undefined] as unknown as CropHandle[]) {
    assert.throws(() => resizeCropRect(original, handle, { x: 0, y: 0 }, landscape), /invalid-crop-handle/);
  }
  for (const key of ["", "Enter", null, undefined] as unknown as CropArrowKey[]) {
    assert.throws(() => cropNudgeDelta(key, landscape), /invalid-crop-nudge/);
  }
  assert.throws(() => cropNudgeDelta("ArrowUp", landscape, "true" as unknown as boolean), /invalid-crop-nudge/);
});

test("deterministic free-geometry invariants cover all handles, orientations, limits and extreme finite deltas", () => {
  const random = randomGenerator(0xC0FFEE);
  const sources = [
    landscape, { width: 3000, height: 4000 }, { width: 2048, height: 1024 },
    { width: 1024, height: 2048 }, { width: 3, height: 2 }, { width: 2, height: 3 },
    { width: 1, height: 1 }, { width: 1, height: 8192 }, { width: 8192, height: 1 },
    { width: 64_000_000, height: 1 }, { width: 1, height: 64_000_000 },
  ];
  for (const source of sources) {
    for (let iteration = 0; iteration < 100; iteration++) {
      const width = 1 / source.width + random() * (1 - 1 / source.width);
      const height = 1 / source.height + random() * (1 - 1 / source.height);
      const crop = Object.freeze({ x: random() * (1 - width), y: random() * (1 - height), width, height });
      const delta = iteration < 4
        ? { x: (iteration % 2 ? 1 : -1) * Number.MAX_VALUE, y: (iteration < 2 ? 1 : -1) * Number.MAX_VALUE }
        : { x: random() * 4 - 2, y: random() * 4 - 2 };
      const moved = moveCropRect(crop, delta, source);
      assertValid(moved, source);
      near(moved.width, width);
      near(moved.height, height);
      for (const handle of handles) {
        const resized = resizeCropRect(crop, handle, delta, source);
        assertValid(resized, source);
        assertAnchors(crop, resized, handle);
      }
    }
  }
});

test("deterministic locked-geometry invariants preserve ratio, minimum and anchors in landscape/portrait/rotated sources", () => {
  const random = randomGenerator(0xCA7707);
  const sources = [
    landscape, { width: 3000, height: 4000 }, { width: 1920, height: 1080 },
    { width: 1080, height: 1920 }, { width: 3, height: 2 }, { width: 2, height: 3 },
    { width: 1, height: 1 }, { width: 1, height: 8192 }, { width: 8192, height: 1 },
    { width: 64_000_000, height: 1 }, { width: 1, height: 64_000_000 },
  ];
  for (const source of sources) {
    const ratios = [1, 16 / 9, 9 / 16, 4 / 3, 3 / 4, source.width / source.height, 1 / source.height, source.width]
      .filter(ratio => ratio >= 1 / source.height && ratio <= source.width);
    for (const ratio of ratios) {
      const normalizedRatio = ratio * source.height / source.width;
      const minWidth = Math.max(1 / source.width, normalizedRatio / source.height);
      const maxWidth = Math.min(1, normalizedRatio);
      for (let iteration = 0; iteration < 60; iteration++) {
        const width = minWidth + random() * (maxWidth - minWidth);
        const height = width / normalizedRatio;
        const crop = Object.freeze({ x: random() * (1 - width), y: random() * (1 - height), width, height });
        const delta = iteration < 4
          ? { x: (iteration % 2 ? 1 : -1) * Number.MAX_VALUE, y: (iteration < 2 ? 1 : -1) * Number.MAX_VALUE }
          : { x: random() * 4 - 2, y: random() * 4 - 2 };
        for (const handle of handles) {
          const resized = resizeCropRect(crop, handle, delta, source, ratio);
          assertValid(resized, source, ratio);
          assertAnchors(crop, resized, handle);
          nearRect(resizeCropRect(crop, handle, { x: 0, y: 0 }, source, ratio), crop);
        }
      }
    }
  }
});

test("the exact normalized result feeds imageEditWithCrop across all four rotations", () => {
  for (const turns of [0, 1, 2, 3]) {
    const source = turns % 2 ? { width: 3000, height: 4000 } : landscape;
    const initial: ImageEdit = {
      turns, flipX: true, flipY: false,
      crop: centeredCrop(source.width, source.height, 16 / 9), width: 1000, height: 1000,
    };
    const resized = resizeCropRect(initial.crop, "nw", { x: 0.08, y: 0.1 }, source, 16 / 9);
    const moved = moveCropRect(resized, cropNudgeDelta("ArrowRight", source, true), source);
    const edit = imageEditWithCrop(initial, moved, landscape.width, landscape.height);
    assert.equal(edit.crop, moved);
    assert.equal(edit.turns, turns);
    assert.equal(edit.flipX, true);
    assert.equal(edit.flipY, false);
    const rendered = validateImageEdit(edit, landscape.width, landscape.height);
    assert.equal(rendered.width, source.width);
    assert.equal(rendered.height, source.height);
    assertValid(edit.crop, source, 16 / 9);
    assert.ok(rendered.crop.width >= 1 && rendered.crop.height >= 1);
    assert.ok(rendered.crop.x + rendered.crop.width <= source.width);
    assert.ok(rendered.crop.y + rendered.crop.height <= source.height);
  }
});
