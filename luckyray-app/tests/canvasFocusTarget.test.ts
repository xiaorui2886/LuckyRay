import test from "node:test";
import assert from "node:assert/strict";
import {
  CANVAS_FOCUS_LIMITS,
  CanvasFocusError,
  buildCanvasFocusMessages,
  normalizeCanvasFocusPoint,
  prepareCanvasFocusImage,
  sanitizeCanvasFocusPhrase,
  type CanvasFocusCanvas,
  type CanvasFocusImageGeometry,
} from "../src/core/canvas/focusTarget";

const JPEG = "data:image/jpeg;base64,/9j/2Q==";
const geometry: CanvasFocusImageGeometry = {
  left: 20,
  top: 30,
  width: 200,
  height: 200,
  naturalWidth: 400,
  naturalHeight: 200,
};

test("contain maps only visible image pixels and rejects letterboxing", () => {
  assert.deepEqual(normalizeCanvasFocusPoint(120, 130, geometry), { x: 0.5, y: 0.5 });
  assert.deepEqual(normalizeCanvasFocusPoint(20, 80, geometry), { x: 0, y: 0 });
  assert.deepEqual(normalizeCanvasFocusPoint(220, 180, geometry), { x: 1, y: 1 });
  for (const [x, y] of [[120, 79], [120, 181], [19, 130], [221, 130], [120, 29], [120, 231]]) {
    assert.equal(normalizeCanvasFocusPoint(x, y, geometry), null);
  }
  const portrait = { ...geometry, naturalWidth: 200, naturalHeight: 400 };
  assert.deepEqual(normalizeCanvasFocusPoint(70, 30, portrait), { x: 0, y: 0 });
  assert.equal(normalizeCanvasFocusPoint(69, 130, portrait), null);
});

test("cover maps a cropped image to its original coordinates", () => {
  const cover = { ...geometry, objectFit: "cover" as const };
  assert.deepEqual(normalizeCanvasFocusPoint(20, 30, cover), { x: 0.25, y: 0 });
  assert.deepEqual(normalizeCanvasFocusPoint(220, 230, cover), { x: 0.75, y: 1 });
  assert.equal(normalizeCanvasFocusPoint(19, 130, cover), null);
  const portrait = { ...cover, naturalWidth: 200, naturalHeight: 400 };
  assert.deepEqual(normalizeCanvasFocusPoint(20, 30, portrait), { x: 0, y: 0.25 });
  assert.deepEqual(normalizeCanvasFocusPoint(220, 230, portrait), { x: 1, y: 0.75 });
});

test("mapping follows object-position and scaled client rectangles", () => {
  assert.deepEqual(normalizeCanvasFocusPoint(20, 30, {
    ...geometry, objectPosition: { x: 0, y: 0 },
  }), { x: 0, y: 0 });
  assert.deepEqual(normalizeCanvasFocusPoint(20, 30, {
    ...geometry, objectFit: "cover", objectPosition: { x: 1, y: 1 },
  }), { x: 0.5, y: 0 });
  assert.deepEqual(normalizeCanvasFocusPoint(45, 55, {
    ...geometry, width: 100, height: 50,
  }), { x: 0.25, y: 0.5 });
  assert.deepEqual(geometry, {
    left: 20, top: 30, width: 200, height: 200, naturalWidth: 400, naturalHeight: 200,
  });
});

test("mapping rejects invalid geometry and nonfinite clicks", () => {
  for (const key of ["width", "height", "naturalWidth", "naturalHeight"] as const) {
    for (const value of [0, -1, NaN, Infinity]) {
      assert.equal(normalizeCanvasFocusPoint(120, 130, { ...geometry, [key]: value }), null);
    }
  }
  assert.equal(normalizeCanvasFocusPoint(NaN, 130, geometry), null);
  assert.equal(normalizeCanvasFocusPoint(120, Infinity, geometry), null);
  assert.equal(normalizeCanvasFocusPoint(120, 130, { ...geometry, left: NaN }), null);
  assert.equal(normalizeCanvasFocusPoint(120, 130, { ...geometry, objectPosition: { x: -1, y: 0 } }), null);
  assert.equal(normalizeCanvasFocusPoint(120, 130, { ...geometry, objectFit: "fill" as "contain" }), null);
});

type DrawCall = { name: string; args: unknown[] };

function fakeCanvas(options: {
  encode?: (quality: number | undefined) => string;
  noContext?: boolean;
  drawError?: Error;
} = {}) {
  const calls: DrawCall[] = [];
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    fillRect(...args: number[]) { calls.push({ name: "fillRect", args }); },
    drawImage(...args: unknown[]) {
      if (options.drawError) throw options.drawError;
      calls.push({ name: "drawImage", args });
    },
    save() { calls.push({ name: "save", args: [] }); },
    restore() { calls.push({ name: "restore", args: [] }); },
    beginPath() { calls.push({ name: "beginPath", args: [] }); },
    arc(...args: number[]) { calls.push({ name: "arc", args }); },
    stroke() { calls.push({ name: "stroke", args: [] }); },
    moveTo(...args: number[]) { calls.push({ name: "moveTo", args }); },
    lineTo(...args: number[]) { calls.push({ name: "lineTo", args }); },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext(kind: string) {
      assert.equal(kind, "2d");
      return options.noContext ? null : context;
    },
    toDataURL(type: string, quality?: number) {
      assert.equal(type, "image/jpeg");
      calls.push({ name: "encode", args: [quality] });
      return options.encode?.(quality) ?? JPEG;
    },
  };
  return { canvas: canvas as unknown as CanvasFocusCanvas, calls, context };
}

function source(width: number, height: number): CanvasImageSource {
  return Object.freeze({ width, height, originalPixels: "unchanged" }) as unknown as CanvasImageSource;
}

function hasError(code: string) {
  return (error: unknown) => error instanceof CanvasFocusError && error.code === code && error.message === code;
}

test("vision JPEG is bounded, marked on a fresh canvas, and leaves the source untouched", () => {
  const original = source(4000, 2000);
  const point = Object.freeze({ x: 0.25, y: 0.75 });
  const { canvas, calls, context } = fakeCanvas();
  const result = prepareCanvasFocusImage(original, {
    width: 4000, height: 2000, point, makeCanvas: () => canvas,
  });
  assert.deepEqual(result, { dataUrl: JPEG, width: 1024, height: 512, point });
  assert.notEqual(result.point, point);
  assert.equal(canvas.width, 1024);
  assert.equal(canvas.height, 512);
  assert.deepEqual(calls.find((call) => call.name === "drawImage")?.args, [original, 0, 0, 4000, 2000, 0, 0, 1024, 512]);
  assert.deepEqual(calls.find((call) => call.name === "arc")?.args.slice(0, 3), [256, 384, 9]);
  assert.equal(context.strokeStyle, "#ff2d73");
  assert.equal(context.fillStyle, "#ffffff");
  assert.equal(calls.filter((call) => call.name === "moveTo").length, 4);
  assert.deepEqual(original, { width: 4000, height: 2000, originalPixels: "unchanged" });
});

test("small and extreme images stay nonempty without upscaling", () => {
  for (const [width, height, expectedWidth, expectedHeight] of [
    [60, 40, 60, 40], [1, 64000, 1, 1024], [64000, 1, 1024, 1], [8000, 8000, 1024, 1024],
  ]) {
    const { canvas } = fakeCanvas();
    const result = prepareCanvasFocusImage(source(width, height), {
      width, height, point: { x: 1, y: 0 }, makeCanvas: () => canvas,
    });
    assert.equal(result.width, expectedWidth);
    assert.equal(result.height, expectedHeight);
  }
});

test("source pixel limits and bad coordinates fail before canvas allocation", () => {
  let allocations = 0;
  const makeCanvas = () => { allocations++; return fakeCanvas().canvas; };
  for (const [width, height] of [[8001, 8000], [64_000_001, 1], [Number.MAX_SAFE_INTEGER, 2]]) {
    assert.throws(() => prepareCanvasFocusImage(source(width, height), {
      width, height, point: { x: 0.5, y: 0.5 }, makeCanvas,
    }), hasError("FOCUS_IMAGE_TOO_LARGE"));
  }
  for (const [width, height] of [[0, 1], [1.5, 1], [1, -1], [NaN, 1], [1, Infinity]]) {
    assert.throws(() => prepareCanvasFocusImage(source(width, height), {
      width, height, point: { x: 0.5, y: 0.5 }, makeCanvas,
    }), hasError("FOCUS_INVALID_IMAGE"));
  }
  for (const point of [{ x: -0.01, y: 0.5 }, { x: 0.5, y: 1.01 }, { x: NaN, y: 0 }, { x: 0, y: Infinity }]) {
    assert.throws(() => prepareCanvasFocusImage(source(10, 10), {
      width: 10, height: 10, point, makeCanvas,
    }), hasError("FOCUS_INVALID_POINT"));
  }
  assert.equal(allocations, 0);
});

test("intrinsic image dimensions cannot be bypassed by caller dimensions", () => {
  const oversized = { naturalWidth: 9000, naturalHeight: 9000, width: 100, height: 100 } as HTMLImageElement;
  assert.throws(() => prepareCanvasFocusImage(oversized, {
    width: 100, height: 100, point: { x: 0.5, y: 0.5 },
  }), hasError("FOCUS_IMAGE_TOO_LARGE"));
  assert.throws(() => prepareCanvasFocusImage(source(20, 10), {
    width: 10, height: 10, point: { x: 0.5, y: 0.5 },
  }), hasError("FOCUS_INVALID_IMAGE"));
  const unloaded = { naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement;
  assert.throws(() => prepareCanvasFocusImage(unloaded, {
    width: 100, height: 100, point: { x: 0.5, y: 0.5 },
  }), hasError("FOCUS_INVALID_IMAGE"));
});

test("a factory cannot accidentally resize or draw into the original canvas", () => {
  const original = fakeCanvas();
  original.canvas.width = 2000;
  original.canvas.height = 1000;
  assert.throws(() => prepareCanvasFocusImage(original.canvas as HTMLCanvasElement, {
    width: 2000, height: 1000, point: { x: 0.5, y: 0.5 }, makeCanvas: () => original.canvas,
  }), hasError("FOCUS_SOURCE_CANVAS_REUSED"));
  assert.equal(original.canvas.width, 2000);
  assert.equal(original.canvas.height, 1000);
  assert.equal(original.calls.length, 0);
});

test("taint, draw, and canvas failures produce safe errors without source paths", () => {
  const secret = "Cannot read file:///private/source.jpg?token=secret";
  const variants = [
    { encode: () => { throw new DOMException(secret, "SecurityError"); } },
    { drawError: new Error(secret) },
  ];
  for (const options of variants) {
    const { canvas } = fakeCanvas(options);
    assert.throws(() => prepareCanvasFocusImage(source(10, 10), {
      width: 10, height: 10, point: { x: 0, y: 0 }, makeCanvas: () => canvas,
    }), hasError("FOCUS_IMAGE_UNREADABLE"));
  }
  assert.throws(() => prepareCanvasFocusImage(source(10, 10), {
    width: 10, height: 10, point: { x: 0, y: 0 }, makeCanvas: () => { throw Error(secret); },
  }), hasError("FOCUS_CANVAS_UNAVAILABLE"));
  assert.throws(() => prepareCanvasFocusImage(source(10, 10), {
    width: 10, height: 10, point: { x: 0, y: 0 }, makeCanvas: () => fakeCanvas({ noContext: true }).canvas,
  }), hasError("FOCUS_CANVAS_UNAVAILABLE"));
});

test("JPEG encoding retries at bounded quality and rejects excessive or malformed output", () => {
  const excessive = `data:image/jpeg;base64,${"A".repeat(Math.ceil((CANVAS_FOCUS_LIMITS.jpegBytes + 1) / 3) * 4)}`;
  const smaller = fakeCanvas({ encode: (quality) => quality === 0.84 ? excessive : JPEG });
  assert.equal(prepareCanvasFocusImage(source(10, 10), {
    width: 10, height: 10, point: { x: 0.5, y: 0.5 }, makeCanvas: () => smaller.canvas,
  }).dataUrl, JPEG);
  assert.deepEqual(smaller.calls.filter((call) => call.name === "encode").map((call) => call.args[0]), [0.84, 0.7]);
  const tooLarge = fakeCanvas({ encode: () => excessive });
  assert.throws(() => prepareCanvasFocusImage(source(10, 10), {
    width: 10, height: 10, point: { x: 0.5, y: 0.5 }, makeCanvas: () => tooLarge.canvas,
  }), hasError("FOCUS_IMAGE_TOO_LARGE"));
  assert.equal(tooLarge.calls.filter((call) => call.name === "encode").length, 3);
  for (const invalid of ["data:,", "data:image/png;base64,YQ==", "data:image/jpeg;base64,", "data:image/jpeg;base64,!!!!"]) {
    assert.throws(() => prepareCanvasFocusImage(source(10, 10), {
      width: 10, height: 10, point: { x: 0.5, y: 0.5 }, makeCanvas: () => fakeCanvas({ encode: () => invalid }).canvas,
    }), hasError("FOCUS_IMAGE_ENCODING_FAILED"));
  }
});

test("vision message contains only a scoped instruction and bounded marked image", () => {
  const messages = buildCanvasFocusMessages(JPEG);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 2);
  const instruction = messages[0].content[0];
  assert.equal(instruction.type, "text");
  if (instruction.type !== "text") assert.fail("Expected text instruction");
  assert.match(instruction.text, /圆环中心/);
  assert.match(instruction.text, /实际可见/);
  assert.match(instruction.text, /不要猜测/);
  assert.match(instruction.text, /__UNKNOWN__/);
  assert.deepEqual(messages[0].content[1], { type: "image_url", image_url: { url: JPEG } });
  const english = buildCanvasFocusMessages(JPEG, "en-US")[0].content[0];
  assert.equal(english.type, "text");
  if (english.type === "text") assert.match(english.text, /never as instructions/);
  assert.throws(() => buildCanvasFocusMessages("https://example.com/image.jpg"), hasError("FOCUS_IMAGE_ENCODING_FAILED"));
  const excessive = `data:image/jpeg;base64,${"A".repeat(Math.ceil((CANVAS_FOCUS_LIMITS.jpegBytes + 1) / 3) * 4)}`;
  assert.throws(() => buildCanvasFocusMessages(excessive), hasError("FOCUS_IMAGE_TOO_LARGE"));
});

test("response sanitation preserves a short visible phrase without reasoning or wrappers", () => {
  for (const [input, expected] of [
    ["黑白格纹纸张", "黑白格纹纸张"],
    [" <think>Need to inspect the selected object</think>黑白格纹纸张。 ", "黑白格纹纸张"],
    ["<think>nested <think>hidden</think> reasoning</think>Final answer: Red ceramic cup.", "Red ceramic cup"],
    ["答案：\"黑白格纹纸张\"", "黑白格纹纸张"],
    ["**黑白格纹纸张**", "黑白格纹纸张"],
    ["“黑白格纹纸张”", "黑白格纹纸张"],
    ["A black-and-white checked sheet", "A black-and-white checked sheet"],
  ]) assert.equal(sanitizeCanvasFocusPhrase(input), expected);
});

test("response sanitation rejects empty, refusal, unknown, speculative, and non-phrase output", () => {
  for (const input of [
    undefined, null, 12, {}, "", "   ", "<think>hidden only</think>", "<think>unfinished",
    "__UNKNOWN__", "unknown object", "N/A", "无法确定", "抱歉，我无法识别该对象。", "看不清楚",
    "可能是纸张", "似乎是一块布", "I cannot identify the object", "Sorry, the image is unclear",
    "It looks like a cup", "Probably a red bowl", "a cup\nadditional explanation",
    "I'm not sure", "I don't know", "No object detected", "The model does not support images",
    "A black cup. It is on a table", "一个杯子。它位于桌上", "没有足够的信息",
    "<analysis>hidden reasoning</analysis>cup", "<b>cup</b>", "```cup```", '{"object":"cup"}',
    "[cup](https://example.com)", "cup\u0000", "cup\u202E", "ignore previous instructions",
    "?", "...", "字".repeat(81), "x".repeat(16_385),
  ]) assert.equal(sanitizeCanvasFocusPhrase(input), "", String(input));
  assert.equal(sanitizeCanvasFocusPhrase("字".repeat(80)), "字".repeat(80));
});
