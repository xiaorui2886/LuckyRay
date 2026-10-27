import { resolvePinnedFocusReference } from "../src/core/canvas/focusReference.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  createCanvasReferencePlan,
  canvasReferenceSnapshots,
  duplicatesConnectedReference,
  referenceSourceId,
} from "../src/core/canvas/referencePlan.ts";
import { getCanvasNodeCapabilities } from "../src/core/canvas/nodeCapabilities.ts";
import { planReferenceReorder } from "../src/core/canvas/referenceReorder.ts";
import {
  encodeReferenceMention,
  resolveReferenceMentions,
} from "../src/core/canvas/referenceMentions.ts";
import { hasInvalidCanvasReference } from "../src/core/canvas/referenceIdentity.ts";
const require = createRequire(import.meta.url),
  { transformSync } = createRequire(require.resolve("vite"))("esbuild");
const source = readFileSync(
  new URL("../src/CanvasSpike.tsx", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");
function setup() {
  const stored = [
    {
      id: "asset:a",
      label: "A",
      kind: "image",
      role: "firstFrame",
      mediaUrl: "/a",
    },
    {
      id: "asset:c",
      label: "C",
      kind: "image",
      role: "lastFrame",
      mediaUrl: "/c",
    },
  ];
  const nodesRef: { current: any[] } = {
    current: [
      {
        id: "a",
        data: {
          kind: "image",
          label: "A",
          payload: "asset:a",
          refMediaUrl: "/a",
        },
      },
      {
        id: "b",
        data: {
          kind: "image",
          label: "B",
          payload: "asset:b",
          refMediaUrl: "/b",
        },
      },
      {
        id: "v",
        data: {
          kind: "generator",
          generationKind: "video",
          label: "V",
          generationReferences: stored,
        },
      },
    ],
  };
  const edgesRef: { current: any[] } = {
    current: [
      {
        id: "ea",
        source: "a",
        target: "v",
        data: { role: "firstFrame", order: 0 },
      },
    ],
  };
  let dirty = 0;
  const history: any[] = [];
  const env = {
    nodesRef,
    edgesRef,
    locale: "zh-CN",
    useCallback: (fn: any) => fn,
    commitHistory: () =>
      history.push(
        structuredClone({ nodes: nodesRef.current, edges: edgesRef.current }),
      ),
    markDirty: () => dirty++,
    setNodes: (n: any) => (nodesRef.current = n),
    setEdges: (e: any) => (edgesRef.current = e),
    getCanvasNodeCapabilities,
    resolvePinnedFocusReference,
    hasInvalidCanvasReference,
    TEXT_NODE_PLACEHOLDER_LABELS: new Set(["新文本节点"]),
    createCanvasReferencePlan,
    planReferenceReorder,
    duplicatesConnectedReference,
    referenceSourceId,
    inferGenerationKind: (n: any) => n.data.generationKind || n.data.kind,
  };
  const helper = source.slice(
    source.indexOf("function referenceForCanvasNode("),
    source.indexOf("function resolveCanvasConnectionData("),
  );
  const callbacks = source.slice(
    source.indexOf("  const getIncomingGenerationInputs = useCallback("),
    source.indexOf("  const getCanvasReferenceCandidates = useCallback("),
  );
  const api = Function(
    "env",
    `const {${Object.keys(env).join(",")}}=env;${transformSync(helper + callbacks, { loader: "ts", target: "es2022" }).code};return {getIncomingGenerationInputs,removeIncomingEdge,updateIncomingEdgeRole,reorderCanvasReferences,resolveStoredCanvasReferences};`,
  )(env);
  return {
    api,
    env,
    history,
    get dirty() {
      return dirty;
    },
  };
}
test("disconnect atomically removes shadow reference without deleting source and is one undo", () => {
  const h = setup();
  h.api.removeIncomingEdge("ea");
  assert.equal(h.env.edgesRef.current.length, 0);
  assert.deepEqual(
    h.env.nodesRef.current[2].data.generationReferences?.map((r) => r.id),
    ["asset:c"],
  );
  assert.equal(h.env.nodesRef.current.length, 3);
  assert.equal(h.history.length, 1);
  assert.equal(h.dirty, 1);
  assert.equal(h.history[0].edges.length, 1);
  assert.equal(h.history[0].nodes[2].data.generationReferences.length, 2);
  h.api.removeIncomingEdge("ea");
  assert.equal(h.history.length, 1);
});
test("role change removes old shadow rather than resurfacing it", () => {
  const h = setup();
  h.api.updateIncomingEdgeRole("ea", "reference");
  assert.equal(h.env.edgesRef.current[0].data.role, "reference");
  assert.deepEqual(
    h.env.nodesRef.current[2].data.generationReferences?.map((r) => r.id),
    ["asset:c"],
  );
  assert.equal(h.history.length, 1);
});
test("occupied stored frame prevents ambiguous role change without history writes", () => {
  const h = setup();
  h.api.updateIncomingEdgeRole("ea", "lastFrame");
  assert.equal(h.env.edgesRef.current[0].data.role, "firstFrame");
  assert.equal(h.history.length, 0);
  assert.equal(h.dirty, 0);
});
function targetPlan(h: ReturnType<typeof setup>) {
  const target = h.env.nodesRef.current.find((node) => node.id === "v")!;
  return createCanvasReferencePlan(
    target.data.generationKind,
    h.api.getIncomingGenerationInputs("v"),
    h.api.resolveStoredCanvasReferences(target, h.env.nodesRef.current),
    undefined,
    target.data.generationInputOrder,
  );
}
test("production drag ordering ignores provenance and persists the same visible/request order", () => {
  const h = setup();
  h.env.nodesRef.current[2].data.generationReferences = [];
  h.env.edgesRef.current = [
    {
      id: "ea",
      source: "a",
      target: "v",
      data: { role: "reference", order: 0 },
    },
    {
      id: "derived",
      source: "a",
      target: "v",
      data: { role: "reference", order: 1, relation: "derivation" },
    },
    {
      id: "eb",
      source: "b",
      target: "v",
      data: { role: "reference", order: 2 },
    },
  ];
  const before = structuredClone(h.env.edgesRef.current);
  h.api.reorderCanvasReferences("v", "ea", "eb");
  assert.deepEqual(
    targetPlan(h).map((entry) => entry.key),
    ["eb", "ea"],
  );
  assert.deepEqual(
    canvasReferenceSnapshots(targetPlan(h)).map((ref) => ref.id),
    ["asset:b", "asset:a"],
  );
  assert.deepEqual(
    h.env.edgesRef.current,
    before,
    "same-role drag preserves edge records and provenance",
  );
  assert.deepEqual(h.env.nodesRef.current[2].data.generationInputOrder, [
    "eb",
    "ea",
  ]);
  assert.equal(h.history.length, 1);
  assert.equal(h.dirty, 1);
});
test("production drag crosses stored/connected boundaries within a role and preserves snapshots", () => {
  const h = setup();
  h.env.edgesRef.current[0].data.role = "reference";
  h.env.nodesRef.current[2].data.generationReferences = [
    {
      id: "asset:a",
      label: "Shadow",
      kind: "image",
      role: "reference",
      mediaUrl: "/a",
    },
    {
      id: "asset:c",
      label: "C",
      kind: "image",
      role: "reference",
      mediaUrl: "/c",
    },
  ];
  const initial = targetPlan(h);
  const storedKey = initial.find((entry) => entry.source === "stored")!.key;
  const oldRequest = canvasReferenceSnapshots(initial);
  h.api.reorderCanvasReferences("v", storedKey, "ea");
  assert.deepEqual(
    targetPlan(h).map((entry) => entry.key),
    [storedKey, "ea"],
  );
  assert.deepEqual(
    canvasReferenceSnapshots(targetPlan(h)).map((ref) => ref.id),
    ["asset:c", "asset:a"],
  );
  assert.deepEqual(
    oldRequest.map((ref) => ref.id),
    ["asset:a", "asset:c"],
  );
  assert.equal(
    h.env.nodesRef.current[2].data.generationReferences.length,
    2,
    "hidden same-role shadow is not collateral deletion",
  );
  assert.equal(h.history.length, 1);
});
test("mixed stored/connected first-last drag swaps roles atomically with one undo", () => {
  const h = setup();
  const before = structuredClone({
    nodes: h.env.nodesRef.current,
    edges: h.env.edgesRef.current,
  });
  const tailKey = targetPlan(h).find(
    (entry) => entry.role === "lastFrame",
  )!.key;
  h.api.reorderCanvasReferences("v", "ea", tailKey);
  assert.equal(h.env.edgesRef.current[0].data.role, "lastFrame");
  assert.deepEqual(
    h.env.nodesRef.current[2].data.generationReferences.map((ref: any) => [
      ref.id,
      ref.role,
    ]),
    [["asset:c", "firstFrame"]],
  );
  assert.deepEqual(
    targetPlan(h).map((entry) => [entry.reference.id, entry.role]),
    [
      ["asset:c", "firstFrame"],
      ["asset:a", "lastFrame"],
    ],
  );
  assert.ok(targetPlan(h).every((entry) => !entry.issue));
  assert.equal(h.history.length, 1);
  assert.equal(h.dirty, 1);
  assert.deepEqual(h.history[0], before);
  assert.deepEqual(
    h.env.nodesRef.current.slice(0, 2),
    before.nodes.slice(0, 2),
  );
  h.env.nodesRef.current = h.history[0].nodes;
  h.env.edgesRef.current = h.history[0].edges;
  assert.deepEqual(
    targetPlan(h).map((entry) => entry.role),
    ["firstFrame", "lastFrame"],
  );
});
test("invalid drag targets and unrelated roles do not mutate state or history", () => {
  const h = setup();
  h.env.nodesRef.current[2].data.generationReferences.push({
    id: "text",
    label: "Context",
    kind: "text",
    role: "promptContext",
    text: "Body",
  });
  const textKey = targetPlan(h).find(
    (entry) => entry.role === "promptContext",
  )!.key;
  const before = structuredClone({
    nodes: h.env.nodesRef.current,
    edges: h.env.edgesRef.current,
  });
  for (const [node, from, to] of [
    ["v", "ea", textKey],
    ["v", "ea", "ea"],
    ["v", "ea", "missing"],
    ["missing", "ea", textKey],
  ])
    h.api.reorderCanvasReferences(node, from, to);
  assert.deepEqual(
    { nodes: h.env.nodesRef.current, edges: h.env.edgesRef.current },
    before,
  );
  assert.equal(h.history.length, 0);
  assert.equal(h.dirty, 0);
});
test("stored repeated-source keys survive a frame swap without rebinding a prompt token", () => {
  const h = setup();
  h.env.edgesRef.current = [];
  h.env.nodesRef.current[2].data.generationReferences = [
    {
      id: "asset:repeat",
      label: "First occurrence",
      kind: "image",
      role: "firstFrame",
      mediaUrl: "/first",
    },
    {
      id: "asset:repeat",
      label: "Second occurrence",
      kind: "image",
      role: "lastFrame",
      mediaUrl: "/second",
    },
  ];
  const initial = targetPlan(h),
    token = encodeReferenceMention(initial[1].key);
  h.api.reorderCanvasReferences("v", initial[0].key, initial[1].key);
  const moved = targetPlan(h),
    resolved = resolveReferenceMentions(token, moved);
  assert.equal(resolved.mentions[0].entry.reference.mediaUrl, "/second");
  assert.equal(resolved.mentions[0].entry.role, "firstFrame");
  assert.deepEqual(
    h.env.nodesRef.current[2].data.generationReferences.map(
      (ref: any) => ref.mentionKey,
    ),
    initial.map((entry) => entry.key),
  );
  assert.equal(h.history.length, 1);
});
test("missing source input survives reader for recovery and provenance stays out", () => {
  const h = setup();
  h.env.nodesRef.current = h.env.nodesRef.current.filter((n) => n.id !== "a");
  const refs = h.api.getIncomingGenerationInputs("v");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].issue, "missing-source");
  assert.equal(refs[0].edgeId, "ea");
});
function submitData(
  request: any,
  inputs: any[],
  inputPlan: any[],
  context: { retry?: unknown; source?: any } = {},
) {
  const start = source.indexOf(
    "    const generationData: Partial<SpikeNodeData> = {",
  );
  const end = source.indexOf("\n\n    commitHistory();", start);
  assert.ok(
    start >= 0 && end > start,
    "production generationData extraction anchors exist",
  );
  const body = transformSync(source.slice(start, end), {
    loader: "ts",
    target: "es2022",
  }).code;
  const env = {
    request,
    retry: context.retry,
    source: context.source || { data: {} },
    task: {request},
    nodeId: "v",
    inputPlan,
    getIncomingGenerationInputs: () => inputs,
    duplicatesConnectedReference,
  };
  return Function(
    "env",
    `const {${Object.keys(env).join(",")}}=env;${body};return generationData;`,
  )(env);
}
test("production submit retains intentional same-asset different-role stored reference", () => {
  const first = {
    id: "asset:a",
    label: "A",
    kind: "image",
    role: "firstFrame",
    mediaUrl: "/a",
    sourceNodeId: "a",
  };
  const last = { ...first, role: "lastFrame" };
  const inputs = [
    { edgeId: "ea", sourceNodeId: "a", role: "firstFrame", reference: first },
  ];
  const inputPlan = createCanvasReferencePlan(
    "video",
    inputs as any,
    [last] as any,
  );
  const result = submitData(
    { kind: "video", references: [first, last] },
    inputs,
    inputPlan,
  );
  assert.deepEqual(
    result.generationReferences.map((ref: any) => ref.role),
    ["lastFrame"],
  );
  assert.equal(result.generationReferences[0].sourceNodeId, "a");
});
test("production submit preserves stable stored mention identity across canonical reordering", () => {
  const stored = [
    {
      id: "asset:repeated",
      label: "Original first",
      kind: "image",
      role: "lastFrame" as const,
      mediaUrl: "/first",
      mentionKey: "persisted:first",
    },
    {
      id: "asset:repeated",
      label: "Original second",
      kind: "image",
      role: "firstFrame" as const,
      mediaUrl: "/second",
      mentionKey: "persisted:second",
    },
  ];
  const inputPlan = createCanvasReferencePlan("video", [], stored);
  const request = {
    kind: "video",
    references: canvasReferenceSnapshots(inputPlan),
  };
  const result = submitData(request, [], inputPlan);
  assert.deepEqual(
    result.generationReferences.map((ref: any) => ref.mentionKey),
    ["persisted:second", "persisted:first"],
  );
  const next = createCanvasReferencePlan(
    "video",
    [],
    result.generationReferences,
  );
  assert.equal(
    resolveReferenceMentions(encodeReferenceMention("persisted:second"), next)
      .mentions[0].entry.reference.mediaUrl,
    "/second",
  );
});
test("same-node generation preserves connected mention identity without duplicating stored inputs", () => {
  const inputs = [{edgeId:"original-edge",sourceNodeId:"a",role:"reference" as const,
    reference:{id:"asset:a",label:"A",kind:"image",mediaUrl:"/a"}}];
  const inputPlan = createCanvasReferencePlan("image", inputs, []);
  const request = {kind:"image",references:canvasReferenceSnapshots(inputPlan)};
  const before = structuredClone({inputs,request});
  const result = submitData(request, inputs, inputPlan);
  assert.deepEqual(result.generationReferences, [], "existing edge remains the one live reference");
  assert.deepEqual(result.generationTask.request, before.request, "immutable task snapshot retains resolved input");
  assert.equal(result.generationTask.request.references[0].sourceNodeId, "a");
  assert.equal(result.generationTask.request.references[0].mediaUrl, "/a");
  const next = createCanvasReferencePlan("image", inputs, result.generationReferences);
  assert.equal(next.length,1);
  assert.equal(next[0].key,"original-edge");
  assert.equal(resolveReferenceMentions(encodeReferenceMention("original-edge"),next).mentions[0].entry.reference.id,"asset:a");
  assert.deepEqual({inputs,request},before,"same-node submission does not mutate the edge or task inputs");
});
test("connected role mutation preserves explicitly different-role same-asset token identity", () => {
  const h = setup();
  h.env.nodesRef.current[2].data.generationReferences = [
    {
      id: "asset:a",
      label: "Shadow",
      kind: "image",
      role: "firstFrame",
      mediaUrl: "/a",
    },
    {
      id: "asset:a",
      label: "Tail",
      kind: "image",
      role: "lastFrame",
      mediaUrl: "/tail",
      mentionKey: "stable:tail",
    },
  ];
  h.api.updateIncomingEdgeRole("ea", "reference");
  const plan = targetPlan(h),
    match = resolveReferenceMentions(
      encodeReferenceMention("stable:tail"),
      plan,
    ).mentions[0].entry;
  assert.equal(match.role, "lastFrame");
  assert.equal(match.reference.mediaUrl, "/tail");
  assert.equal(h.history.length, 1);
  assert.equal(h.env.nodesRef.current[2].data.generationReferences.length, 1);
});

test("production retry preserves editable duplicate identities and its frozen request", () => {
  const stored = [
    {
      id: "asset:repeated",
      label: "First use",
      kind: "image",
      role: "reference" as const,
      mediaUrl: "/same",
      mentionKey: "persisted:first",
    },
    {
      id: "asset:repeated",
      label: "Second use",
      kind: "image",
      role: "reference" as const,
      mediaUrl: "/same",
      mentionKey: "persisted:second",
    },
  ];
  const inputPlan = createCanvasReferencePlan("image", [], stored);
  const request = {
    kind: "image",
    references: canvasReferenceSnapshots(inputPlan),
  };
  const source = {
    data: {
      generationReferences: stored,
      generationPrompt: encodeReferenceMention("persisted:second"),
      generationInputOrder: ["persisted:second", "persisted:first"],
    },
  };
  const before = structuredClone({ request, source });
  const result = submitData(request, [], inputPlan, {
    retry: { attempt: 2 },
    source,
  });
  assert.equal(
    Object.hasOwn(result, "generationReferences"),
    false,
    "retry does not rewrite editable references",
  );
  assert.deepEqual(
    { request, source },
    before,
    "retry preserves current editable identities and immutable request",
  );
  const next = { ...source.data, ...result };
  assert.equal(next.generationReferences, stored);
  assert.equal(
    resolveReferenceMentions(
      next.generationPrompt,
      createCanvasReferencePlan(
        "image",
        [],
        next.generationReferences,
        undefined,
        next.generationInputOrder,
      ),
    ).mentions[0].entry.reference.label,
    "Second use",
  );
});

test("retry after a frame swap preserves current role, prompt and input order identities", () => {
  const original = [
    {
      id: "asset:repeated",
      label: "First image",
      kind: "image",
      role: "firstFrame" as const,
      mediaUrl: "/first",
      mentionKey: "persisted:first",
    },
    {
      id: "asset:repeated",
      label: "Second image",
      kind: "image",
      role: "lastFrame" as const,
      mediaUrl: "/second",
      mentionKey: "persisted:second",
    },
  ];
  const request = {
    kind: "video",
    references: canvasReferenceSnapshots(
      createCanvasReferencePlan("video", [], original),
    ),
  };
  const current = [
    { ...original[0], role: "lastFrame" as const },
    { ...original[1], role: "firstFrame" as const },
  ];
  const source = {
    data: {
      generationReferences: current,
      generationPrompt: encodeReferenceMention("persisted:second"),
      generationInputOrder: ["persisted:second", "persisted:first"],
    },
  };
  const inputPlan = createCanvasReferencePlan(
    "video",
    [],
    current,
    undefined,
    source.data.generationInputOrder,
  );
  const before = structuredClone({ request, source });
  const result = submitData(request, [], inputPlan, {
    retry: { attempt: 2 },
    source,
  });
  for (const field of [
    "generationReferences",
    "generationInputOrder",
    "generationPrompt",
  ])
    assert.equal(
      Object.hasOwn(result, field),
      false,
      `retry must preserve editable ${field}`,
    );
  const next = { ...source.data, ...result };
  const mention = resolveReferenceMentions(
    next.generationPrompt,
    createCanvasReferencePlan(
      "video",
      [],
      next.generationReferences,
      undefined,
      next.generationInputOrder,
    ),
  ).mentions[0].entry;
  assert.equal(mention.reference.mediaUrl, "/second");
  assert.equal(mention.role, "firstFrame");
  assert.deepEqual({ request, source }, before);
});
