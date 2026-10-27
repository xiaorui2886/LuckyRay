import test from "node:test";
import assert from "node:assert/strict";
import {
  createCanvasReferencePlan,
  canvasReferenceSnapshots,
  duplicatesConnectedReference,
} from "../src/core/canvas/referencePlan.ts";
import {
  compileCanvasGenerationInputs,
  canvasReferenceText,
} from "../src/core/canvas/generationInputCompiler.ts";
import { resolveCanvasEdgeSemanticData } from "../src/core/canvas/edgeSemantics.ts";
import {
  captureWorkflow,
  instantiateWorkflow,
} from "../src/core/canvas/workflowTemplates.ts";
const media = (id: string, role?: any) => ({
  id,
  label: id,
  kind: "image",
  role,
  mediaUrl: "https://fixture.invalid/" + id + ".png",
});
const connected = (id: string, role: any = "reference") => ({
  edgeId: "e" + id,
  sourceNodeId: id,
  role,
  reference: media("node:" + id),
});
test("display and immutable request use one canonical role order", () => {
  const plan = createCanvasReferencePlan(
    "video",
    [connected("last", "lastFrame"), connected("first", "firstFrame")],
    [media("ref", "reference")],
  );
  assert.deepEqual(
    plan.map((e) => e.role),
    ["firstFrame", "lastFrame", "reference"],
  );
  assert.deepEqual(
    canvasReferenceSnapshots(plan).map((r) => r.id),
    plan.map((e) => e.reference.id),
  );
});
test("existing duplicate frame remains visible and explicitly blocks instead of reordering around last frame", () => {
  const plan = createCanvasReferencePlan(
    "video",
    [
      connected("a", "firstFrame"),
      connected("b", "firstFrame"),
      connected("c", "lastFrame"),
    ],
    [],
  );
  assert.deepEqual(
    plan.map((e) => e.sourceNodeId),
    ["a", "b", "c"],
  );
  assert.equal(plan[1].issue, "duplicate-frame");
  assert.equal(canvasReferenceSnapshots(plan).length, 2);
});
test("stored roles infer from only existing active roles and retain original indexes", () => {
  const plan = createCanvasReferencePlan(
    "video",
    [connected("a", "firstFrame")],
    [media("node:a"), media("b"), media("c")],
  );
  assert.deepEqual(
    plan.map((e) => [e.reference.id, e.role, e.storedIndex]),
    [
      ["node:a", "firstFrame", undefined],
      ["b", "lastFrame", 1],
      ["c", "reference", 2],
    ],
  );
});
test("node-picked and connected copies deduplicate by source identity with role preserved", () => {
  assert.equal(
    duplicatesConnectedReference(
      { ...media("node:a:reference", "reference"), mediaUrl: media("node:a").mediaUrl },
      connected("a"),
    ),
    true,
  );
  assert.equal(
    duplicatesConnectedReference(
      media("node:a:lastFrame", "lastFrame"),
      connected("a", "firstFrame"),
    ),
    false,
  );
});
test("same-source different selected media remain distinct references", () => {
  const input = connected("a");
  const selected = { ...media("node:a:reference", "reference"), mediaUrl: "https://fixture.invalid/second.png" };
  assert.equal(duplicatesConnectedReference(selected, input), false);
  const plan = createCanvasReferencePlan("image", [input], [selected]);
  assert.equal(plan.length, 2);
  assert.deepEqual(canvasReferenceSnapshots(plan).map(ref => ref.mediaUrl), [input.reference.mediaUrl, selected.mediaUrl]);
});
test("missing node is visible and removable but never sent", () => {
  const plan = createCanvasReferencePlan(
    "image",
    [{ ...connected("gone"), issue: "missing-source" }],
    [],
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].edgeId, "egone");
  assert.deepEqual(canvasReferenceSnapshots(plan), []);
});
test("thumbnail success is not proof of a usable original", () => {
  const plan = createCanvasReferencePlan(
    "image",
    [],
    [
      {
        id: "a",
        label: "A",
        kind: "image",
        thumbnailUrl: "https://fixture.invalid/thumb.png",
      },
    ],
  );
  assert.equal(plan[0].issue, "missing-media");
  assert.deepEqual(canvasReferenceSnapshots(plan), []);
});
test("snapshot strips UI-only issue and preserves immutable copies", () => {
  const ref = media("a");
  const plan = createCanvasReferencePlan("image", [], [ref]);
  const snap = canvasReferenceSnapshots(plan);
  ref.label = "changed";
  assert.equal(snap[0].label, "a");
  assert.equal("issue" in snap[0], false);
});
test("empty text does not silently become a title", () => {
  const ref = {
    id: "n",
    label: "TITLE MUST NOT BE SENT",
    kind: "note",
    text: " ",
    role: "promptContext" as const,
  };
  assert.equal(canvasReferenceText(ref), "");
  assert.equal(
    compileCanvasGenerationInputs({
      kind: "image",
      prompt: "draw",
      references: [ref],
    }).prompt,
    "draw",
  );
});
test("long body preview equals compiled body and respects title preference", () => {
  const text = "x".repeat(9000),
    ref = {
      id: "n",
      label: "Note title",
      kind: "note",
      text,
      role: "promptContext" as const,
    };
  assert.equal(canvasReferenceText(ref).length, 8000);
  const body = compileCanvasGenerationInputs({
    kind: "image",
    prompt: "draw",
    references: [ref],
  });
  assert.ok(body.prompt.endsWith(canvasReferenceText(ref)));
  assert.ok(!body.prompt.includes("Note title"));
  const title = compileCanvasGenerationInputs({
    kind: "image",
    prompt: "draw",
    references: [ref],
    includeNoteTitles: true,
  });
  assert.ok(title.prompt.includes("Note title"));
});
test("another generator and derivation links cannot occupy frame roles", () => {
  const edge = resolveCanvasEdgeSemanticData(
    { kind: "image" },
    { kind: "generator", generationKind: "video" },
    "new",
    [
      { source: "a", target: "other", data: { role: "firstFrame" } },
      { source: "b", target: "other", data: { role: "lastFrame" } },
      {
        source: "c",
        target: "new",
        data: { role: "firstFrame", relation: "derivation" },
      },
    ],
  );
  assert.equal(edge.role, "firstFrame");
  assert.equal(edge.order, 0);
});
test("workflow roundtrip cannot convert derivation into a generation input", () => {
  const nodes = [
    {
      id: "a",
      position: { x: 0, y: 0 },
      data: { kind: "image" as const, label: "Original" },
    },
    {
      id: "b",
      position: { x: 400, y: 0 },
      data: { kind: "image" as const, label: "Slice" },
    },
  ];
  const result = captureWorkflow(
    nodes,
    [
      {
        source: "a",
        target: "b",
        data: { role: "generic", relation: "derivation" },
      },
    ],
    ["a", "b"],
    "Grid",
  );
  assert.equal(result.template.edges.length, 0);
  assert.equal(result.omittedEdges, 1);
  let n = 0;
  assert.equal(
    instantiateWorkflow(result.template, { x: 0, y: 0 }, () => `new-${++n}`)
      .edges.length,
    0,
  );
});
test("primary missing-source status is not overwritten by frame collision", () => {
  const plan = createCanvasReferencePlan(
    "video",
    [
      connected("a", "firstFrame"),
      { ...connected("gone", "firstFrame"), issue: "missing-source" },
    ],
    [],
  );
  assert.equal(plan[1].issue, "missing-source");
});
test("whitespace original does not become a usable reference", () => {
  assert.equal(
    createCanvasReferencePlan(
      "image",
      [],
      [{ ...media("a"), mediaUrl: "  " }],
    )[0].issue,
    "missing-media",
  );
});
test("current media bridge explicitly rejects video inputs before dispatch", () => {
  for (const kind of ["image", "video"] as const) {
    const p = createCanvasReferencePlan(
      kind,
      [],
      [{ ...media("a"), kind: "video" }],
    );
    assert.equal(p[0].issue, "unsupported-video");
  }
});
test("Agnes video never silently drops third image; openai-video guards tail/multiple", () => {
  const refs = [
    media("a", "firstFrame"),
    media("b", "lastFrame"),
    media("c", "reference"),
  ];
  assert.equal(
    createCanvasReferencePlan("video", [], refs, "agnes")[2].issue,
    "image-limit",
  );
  assert.equal(
    createCanvasReferencePlan("video", [], [refs[1]], "openai-video")[0].issue,
    "unsupported-frame",
  );
  assert.equal(
    createCanvasReferencePlan(
      "video",
      [],
      [refs[0], media("c", "reference")],
      "openai-video",
    )[1].issue,
    "image-limit",
  );
});
test("text channel labels media-only references accurately without claiming visual input", () => {
  const plan = createCanvasReferencePlan(
    "text",
    [],
    [{ id: "a", label: "Image name", kind: "image" }],
  );
  assert.equal(plan[0].usage, "label-only");
  assert.equal(plan[0].issue, undefined);
});
test("same asset intentionally used for distinct frame roles is not deduplicated", () => {
  const input = {
    ...connected("a", "firstFrame"),
    reference: media("asset:a"),
  };
  assert.equal(
    duplicatesConnectedReference(media("asset:a", "lastFrame"), input),
    false,
  );
  assert.equal(
    createCanvasReferencePlan("video", [input], [media("asset:a", "lastFrame")])
      .length,
    2,
  );
});
test("Agnes ordinary reference remains accepted and discloses positional frame mapping", () => {
  const plan = createCanvasReferencePlan(
    "video",
    [],
    [media("a", "reference"), media("b", "reference")],
    "agnes",
  );
  assert.ok(plan.every((e) => !e.issue));
  assert.deepEqual(
    plan.map((e) => e.effectiveRole),
    ["firstFrame", "lastFrame"],
  );
  assert.deepEqual(
    canvasReferenceSnapshots(plan).map((e) => e.role),
    ["reference", "reference"],
  );
});

test("persisted drag order interleaves stored and connected inputs identically in snapshots", () => {
  const inputs = [connected("a"), connected("b")];
  const stored = [media("direct", "reference")];
  const initial = createCanvasReferencePlan("image", inputs, stored);
  const key = initial.find((entry) => entry.source === "stored")!.key;
  const order = [key, "eb", "ea"];
  const plan = createCanvasReferencePlan(
    "image",
    inputs,
    stored,
    undefined,
    order,
  );
  assert.deepEqual(
    plan.map((entry) => entry.key),
    order,
  );
  assert.deepEqual(
    canvasReferenceSnapshots(plan).map((ref) => ref.id),
    ["direct", "node:b", "node:a"],
  );
  const saved = JSON.parse(JSON.stringify({ inputs, stored, order }));
  assert.deepEqual(
    createCanvasReferencePlan(
      "image",
      saved.inputs,
      saved.stored,
      undefined,
      saved.order,
    ).map((entry) => entry.key),
    order,
  );
});
test("drag order cannot move ordinary inputs ahead of semantic frames or lose newly added inputs", () => {
  const inputs = [
    connected("frame", "firstFrame"),
    connected("a"),
    connected("b"),
  ];
  const plan = createCanvasReferencePlan("video", inputs, [], undefined, [
    "stale-key",
    "eb",
    "ea",
    "eframe",
  ]);
  assert.deepEqual(
    plan.map((entry) => entry.key),
    ["eframe", "eb", "ea"],
  );
  const next = createCanvasReferencePlan(
    "video",
    [...inputs, connected("new")],
    [],
    undefined,
    ["eb", "ea", "eframe"],
  );
  assert.deepEqual(
    next.map((entry) => entry.key),
    ["eframe", "eb", "ea", "enew"],
  );
});
test("persisted duplicate-source mention keys survive removal, reorder and role changes", () => {
  const stored = [
    {
      ...media("same", "firstFrame"),
      mentionKey: "stable:first",
      mediaUrl: "/first",
    },
    {
      ...media("same", "lastFrame"),
      mentionKey: "stable:last",
      mediaUrl: "/last",
    },
  ];
  const plan = createCanvasReferencePlan("video", [], stored);
  assert.deepEqual(
    plan.map((entry) => entry.key),
    ["stable:first", "stable:last"],
  );
  const remaining = createCanvasReferencePlan(
    "video",
    [],
    [{ ...stored[1], role: "firstFrame" }],
  );
  assert.equal(remaining[0].key, "stable:last");
  assert.equal(remaining[0].reference.mediaUrl, "/last");
  assert.equal(remaining[0].storedIndex, 0);
});
test("text label-only validation clears only missing media while preserving actual invalid identity", () => {
  const base = {
    ...connected("a"),
    reference: {
      ...media("node:a"),
      mediaUrl: undefined,
      issue: "missing-media" as const,
    },
    issue: "missing-media" as const,
  };
  assert.equal(
    createCanvasReferencePlan("text", [base], [])[0].issue,
    undefined,
  );
  assert.equal(base.issue, "missing-media");
  for (const issue of ["missing-source", "invalid-source"] as const)
    assert.equal(
      createCanvasReferencePlan("text", [{ ...base, issue }], [])[0].issue,
      issue,
    );
});
