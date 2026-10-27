import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const { createCanvas } = createRequire(import.meta.url)(process.env.LR_CANVAS_MODULE || "@napi-rs/canvas");
import { compileCanvasGenerationInputs } from "../src/core/canvas/generationInputCompiler";
import {
  notePreviewText,
  noteBodyText,
  hydrateNotePreviews,
} from "../src/core/canvas/notePreview";
import {
  renderImageEdit,
  validateImageEdit,
  rotateImageEdit,
  imageEditWithCrop,
  type ImageEdit,
} from "../src/core/canvas/imageEditing";
import {
  buildMediaZip,
  crc32,
  prepareMediaDelivery,
  readMediaBytes,
  safeDeliveryName,
} from "../src/core/canvas/mediaDelivery";
import { selectedCanvasMedia } from "../src/core/canvas/mediaSelection";
import {
  captureWorkflow,
  builtinWorkflows,
  instantiateWorkflow,
} from "../src/core/canvas/workflowTemplates";
const pause = () => new Promise((r) => setTimeout(r, 5));
const note = {
  id: "note:1",
  label: "未命名测试标题",
  kind: "note",
  role: "promptContext" as const,
  text: "使用青色，正文中的 2026 年日期保留",
  updatedAt: "TIME-METADATA",
  createdAt: "CREATED-METADATA",
};
test("note default excludes title and metadata from prompt AND outbound references", () => {
  const r = compileCanvasGenerationInputs({
    kind: "image",
    prompt: "作画",
    references: [note],
  });
  const wire = JSON.stringify(r);
  for (const unwanted of [
    "未命名测试标题",
    "TIME-METADATA",
    "CREATED-METADATA",
    "updatedAt",
    "createdAt",
  ])
    assert.ok(!wire.includes(unwanted), unwanted);
  assert.match(r.prompt, /2026/);
  assert.match(r.prompt, /使用青色/);
  assert.equal(note.label, "未命名测试标题");
});
test("note title opt-in keeps only title/body, empty notes do not become titles", () => {
  const r = compileCanvasGenerationInputs({
    kind: "video",
    prompt: "影片",
    references: [note],
    includeNoteTitles: true,
  });
  assert.match(r.prompt, /未命名测试标题/);
  assert.ok(!JSON.stringify(r).includes("TIME-METADATA"));
  const empty = compileCanvasGenerationInputs({
    kind: "text",
    prompt: "问候",
    references: [{ ...note, text: "" }],
  });
  assert.equal(empty.prompt, "问候");
  assert.ok(!JSON.stringify(empty).includes(note.label));
});
test("note body truncation is bounded and independent of the 600-character card preview", () => {
  assert.equal(notePreviewText({ contentText: "x".repeat(10000) }).length, 600);
  assert.equal(
    notePreviewText({ contentText: "x".repeat(10000) }, 8000).length,
    8000,
  );
  const r = compileCanvasGenerationInputs({
    kind: "text",
    prompt: "p",
    references: [{ ...note, text: "a".repeat(9000) }],
  });
  assert.equal(r.references[0].text?.length, 8000);
  assert.equal(
    notePreviewText({
      contentJson: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ text: "hello" }] }],
      }),
    }),
    "hello",
  );
});
test("note hydration reads two at a time and ignores results after cancellation", async () => {
  let active = 0,
    max = 0;
  const accepted: string[] = [],
    resolvers: Array<() => void> = [];
  const cancel = hydrateNotePreviews(
    ["a", "b", "c"],
    (id) =>
      new Promise((resolve) => {
        active++;
        max = Math.max(max, active);
        resolvers.push(() => {
          active--;
          resolve({ contentText: id });
        });
      }),
    (id) => accepted.push(id),
  );
  assert.equal(max, 2);
  resolvers[0]();
  await pause();
  assert.deepEqual(accepted, ["a"]);
  assert.equal(resolvers.length, 3);
  cancel();
  resolvers[1]();
  resolvers[2]();
  await pause();
  assert.deepEqual(accepted, ["a"]);
});
const edit: ImageEdit = {
  turns: 0,
  flipX: false,
  flipY: false,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  width: 4,
  height: 2,
};
function source() {
  const c = createCanvas(4, 2),
    ctx = c.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 2, 2);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(2, 0, 2, 2);
  return c;
}
function render(e: ImageEdit) {
  return renderImageEdit(source() as any, 4, 2, e, createCanvas as any) as any;
}
function pixel(c: any, x: number, y: number) {
  return [...c.getContext("2d").getImageData(x, y, 1, 1).data];
}
test("production image transform preserves original pixels, flips and rotates correctly", () => {
  assert.deepEqual(pixel(render(edit), 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(
    pixel(render({ ...edit, flipX: true }), 0, 0),
    [0, 0, 255, 255],
  );
  const rotated = render(rotateImageEdit(edit));
  assert.equal(rotated.width, 2);
  assert.equal(rotated.height, 4);
  assert.deepEqual(pixel(rotated, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(rotated, 0, 3), [0, 0, 255, 255]);
  assert.deepEqual(pixel(source(), 0, 0), [255, 0, 0, 255]);
});
test("cropped region survives rotation, output proportions match crop", () => {
  const cropped = imageEditWithCrop(
    edit,
    { x: 0, y: 0, width: 0.5, height: 1 },
    4,
    2,
  );
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  const rotated = render(rotateImageEdit(cropped));
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++)
      assert.deepEqual(pixel(rotated, x, y), [255, 0, 0, 255]);
  let roundtrip = cropped;
  for (let i = 0; i < 4; i++) roundtrip = rotateImageEdit(roundtrip);
  assert.deepEqual(roundtrip, cropped);
});
test("invalid crop, resolution and source limits reject before rendering", () => {
  for (const e of [
    { ...edit, width: 0 },
    { ...edit, width: 9000 },
    { ...edit, width: 8192, height: 8192 },
    { ...edit, crop: { x: 0.9, y: 0, width: 0.5, height: 1 } },
    { ...edit, turns: NaN },
  ])
    assert.throws(() => validateImageEdit(e, 4, 2));
  assert.throws(() => validateImageEdit(edit, 10000, 10000));
});
test("ZIP is accepted by an independent parser, original PNG bytes and UTF-8 names preserved", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const image = render(edit).toBuffer("image/png");
  const dir = mkdtempSync(join(tmpdir(), "r4-zip-"));
  try {
    const name = "001-中文 图片.png";
    writeFileSync(join(dir, "original.png"), image);
    writeFileSync(
      join(dir, "result.zip"),
      buildMediaZip([
        { name, bytes: image },
        {
          name: "manifest.json",
          bytes: new TextEncoder().encode('{"version":1}'),
        },
      ]),
    );
    const result = execFileSync(
      "python",
      [
        "-c",
        'import sys,zipfile,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p/"result.zip"); assert z.testzip() is None; assert z.read("001-中文 图片.png")== (p/"original.png").read_bytes(); print("PASS")',
        dir,
      ],
      { encoding: "utf8" },
    );
    assert.match(result, /PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() =>
    buildMediaZip([{ name: "../x", bytes: new Uint8Array(1) }]),
  );
  assert.throws(() =>
    buildMediaZip([{ name: "..", bytes: new Uint8Array(1) }]),
  );
  assert.ok(!safeDeliveryName("../a\\b", 0, "png").includes("/"));
});
test("real fetch data fixture exports only originals and omits source URLs from manifest", async () => {
  const bytes = render(edit).toBuffer("image/png");
  const source = "data:image/png;base64," + bytes.toString("base64");
  let progress = 0;
  const zip = await prepareMediaDelivery(
    [{ id: "n", label: "图", kind: "image", source }],
    new AbortController().signal,
    (n) => {
      progress = n;
    },
  );
  assert.equal(progress, 1);
  assert.ok(zip.length > bytes.length);
  assert.ok(!new TextDecoder().decode(zip).includes("data:image"));
  await assert.rejects(
    () => readMediaBytes(source, new AbortController().signal, 1),
    /too-large/,
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(() =>
    prepareMediaDelivery(
      [{ id: "n", label: "图", kind: "image", source }],
      c.signal,
      () => {},
    ),
  );
  await assert.rejects(
    () => readMediaBytes("data:,", new AbortController().signal),
    /empty-media/,
  );
});
test("group selection includes descendants and preserves result-card lineage", () => {
  const result = selectedCanvasMedia(
    [
      { id: "g", data: { kind: "group" } },
      {
        id: "a",
        parentId: "g",
        data: {
          kind: "image",
          label: "A",
          refMediaUrl: "original",
          refThumbnailUrl: "thumb",
        },
      },
      {
        id: "b",
        parentId: "g",
        data: {
          kind: "generator",
          generationKind: "image",
          resultMediaItems: [{ url: "batch" }],
        },
      },
    ],
    ["g"],
    (s) => s,
  );
  assert.deepEqual(
    result.map((r) => [r.nodeId, r.source]),
    [
      ["a", "original"],
      ["b", "batch"],
    ],
  );
});
test("template export uses current edited text and default product template needs only one generator", () => {
  const t = captureWorkflow(
    [
      {
        id: "a",
        position: { x: 0, y: 0 },
        data: { kind: "text", label: "Edited", result: "Stale" },
      },
    ],
    [],
    ["a"],
    "edited",
  );
  assert.equal(t.template.nodes[0].label, "Edited");
  let i = 0;
  const built = instantiateWorkflow(
    builtinWorkflows(false)[0],
    { x: 0, y: 0 },
    () => String(++i),
  );
  assert.equal(built.nodes.length, 1);
  assert.equal(built.nodes[0].data.kind, "generator");
});
test("root wiring fences reloads, rehydrates duplicate note nodes, and stores title preference", () => {
  const s = readFileSync("src/CanvasSpike.tsx", "utf8");
  assert.match(s, /canvasLoadEpochRef.current!==expectedEpoch/);
  assert.match(s, /map\(r=>\[r.nodeId,r.reference!.id\]\)/);
  assert.match(s, /noteReferenceIncludeTitle: false/);
  assert.match(s, /includeNoteTitles,/);
});

test("body-only replay policy blocks title-bearing histories before rebuilding a card", () => {
  const s = readFileSync("src/CanvasSpike.tsx", "utf8");
  const history = s.slice(
    s.indexOf("  const rerunGenerationHistoryEntry ="),
    s.indexOf("  const cancelGenerationHistoryEntry ="),
  );
  assert.ok(
    history.indexOf("!uiSettings.noteReferenceIncludeTitle") <
      history.indexOf("createGenerationDraft(entry,'parameters',0,false)"),
  );
  assert.match(history, /setGenerationHistoryNotice/);
  const submit = s.slice(
    s.indexOf("  const submitGenerationFromNode ="),
    s.indexOf("  const cancelGeneration ="),
  );
  const replayPolicy = submit.indexOf("retry && !uiSettings.noteReferenceIncludeTitle");
  const compileRequest = submit.indexOf("request = retry?.request || createGenerationRequestSnapshot(");
  assert.ok(replayPolicy >= 0 && compileRequest > replayPolicy,
    "body-only replay policy must run before either historical reuse or fresh request compilation");
});

test("note body keeps literal code and dates but omits frontmatter metadata", () => {
  assert.equal(
    noteBodyText({
      contentText:
        "---\ntitle: Meta title\ndate: 2026-10-09\n---\n# 计划\na_b = 2026\n下一行",
    }),
    "# 计划\na_b = 2026\n下一行",
  );
});
