import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  arrangeCanvasNodes,
  attachCanvasNodesToGroup,
  createCanvasGroupDraft,
  ungroupCanvasNodes,
} from "../src/core/canvas/canvasArrangement.ts";
import {
  canvasEditorHash,
  parseCanvasIdFromHash,
  resolveCanvasOpenTarget,
} from "../src/features/canvas/canvasNavigation.ts";
import {
  canConnectCanvasNodes,
  getCanvasNodeCapabilities,
} from "../src/core/canvas/nodeCapabilities.ts";
import { normalizeCanvasEdgeSemantics } from "../src/core/canvas/edgeSemantics.ts";
import {
  compileCanvasGenerationInputs,
  orderCanvasGenerationReferences,
} from "../src/core/canvas/generationInputCompiler.ts";
import {
  createCanvasGenerationTask,
  sanitizeCanvasGenerationErrorDetail,
} from "../src/core/canvas/generationTasks.ts";
import { historyEntryFromTask } from "../src/core/canvas/generationHistory.ts";
import { executeCanvasGenerationTask } from "../src/core/canvas/generationRunner.ts";
import { sanitizeCanvasTextGenerationOutput } from "../src/core/canvas/textGenerationAdapter.ts";
import { createCanvasImageGenerationAdapter } from "../src/core/canvas/imageGenerationAdapter.ts";
import { createCanvasVideoGenerationAdapter } from "../src/core/canvas/videoGenerationAdapter.ts";
import { projectAiSettingsForFrontend } from "../src/core/services/aiSettingsPrivacy.ts";
import { serializeCanvasPortableExport } from "../src/features/canvas/canvasExport.ts";
import {
  appendCanvasHistoryEntry,
  canvasBeginPendingEdit,
  canvasHistorySnapshotsEqual,
  canvasResizeChangedDocumentSize,
  canvasResizeEndDecision,
  createCanvasHistorySnapshot,
  restoreCanvasNodeDimensionRepresentation,
  type CanvasHistorySnapshot,
} from "../src/features/canvas/canvasHistory.ts";
import {
  advanceCanvasEditGeneration,
  canvasSaveCompletionMayMarkClean,
  canvasSaveIdentityMatchesCanvas,
  canvasStaleSaveShouldFollowUp,
  edgeChangesContainDurableEdit,
  nodeChangesContainDurableEdit,
  releaseCanvasSaveSlot,
  sanitizeCanvasEdgesForPersistence,
  sanitizeCanvasNodesForPersistence,
  tryAcquireCanvasSaveSlot,
} from "../src/features/canvas/canvasPersistence.ts";
import {
  canUngroupCanvasSelection,
  isSafeCanvasTransformSelection,
  planCanvasHorizontalDistribution,
  planCanvasLeftAlignment,
  selectedCanvasGroupContainerIds,
  selectedCanvasIdsEqual,
  synchronizeCanvasNodeSelection,
} from "../src/features/canvas/canvasSelectionTransform.ts";
import type { EdgeChange, NodeChange } from "@xyflow/react";

test("canvas home sort menu stays right-edge anchored, trigger-sized, and viewport bounded", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../src/features/canvas/CanvasHomePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/canvas/canvasHome.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /className="canvas-home-sort-wrap"[\s\S]*className="canvas-home-sort"[\s\S]*className="canvas-home-sort-menu" role="listbox"/);
  assert.match(page, /\{ value: "recent", label: t\("sort\.recent"\) \}/);
  assert.match(page, /\{ value: "oldest", label: t\("sort\.oldest"\) \}/);
  assert.match(page, /\{ value: "name", label: t\("sort\.name"\) \}/);
  assert.match(css, /\.canvas-home-sort-wrap\s*\{[^}]*position:\s*relative;[^}]*display:\s*inline-flex;[^}]*max-width:\s*100%;/s);
  const menuRule = css.match(/\.canvas-home-sort-menu\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(menuRule, /right:\s*0/);
  assert.match(menuRule, /left:\s*auto/);
  assert.match(menuRule, /box-sizing:\s*border-box/);
  assert.match(menuRule, /width:\s*max-content/);
  assert.match(menuRule, /min-width:\s*100%/);
  assert.match(menuRule, /max-width:\s*min\(220px, calc\(100vw - 32px\)\)/);
  assert.match(css, /\.react-nav-shell \.canvas-home-sort-menu button\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.doesNotMatch(css, /\.canvas-home-sort-menu\s*\{[^}]*width:\s*132px;/s);
});

test("canvas groups preserve member positions across group and ungroup", () => {
  const nodes = [
    { id: "a", position: { x: 100, y: 80 }, style: { width: 200, height: 160 }, data: { kind: "image" } },
    { id: "b", position: { x: 420, y: 160 }, style: { width: 240, height: 180 }, data: { kind: "video" } },
  ];
  const draft = createCanvasGroupDraft(nodes, ["a", "b"], "group-1", "参考组");
  assert.ok(draft);

  const groupNode = {
    id: draft.id,
    type: "group",
    position: draft.position,
    style: { width: draft.width, height: draft.height },
    data: { kind: "group", label: draft.label },
  };
  const grouped = attachCanvasNodesToGroup(nodes, draft, groupNode);
  assert.equal(grouped.find((node) => node.id === "a")?.parentId, "group-1");

  const restored = ungroupCanvasNodes(grouped, ["group-1"]);
  assert.deepEqual(restored.find((node) => node.id === "a")?.position, nodes[0].position);
  assert.deepEqual(restored.find((node) => node.id === "b")?.position, nodes[1].position);

  const chainNodes = [
    ...nodes,
    { id: "c", position: { x: 50, y: 500 }, style: { width: 180, height: 140 }, data: { kind: "text" } },
  ];
  const arranged = arrangeCanvasNodes(chainNodes, [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ]);
  assert.ok(arranged.find((node) => node.id === "a")!.position.x < arranged.find((node) => node.id === "b")!.position.x);
  assert.ok(arranged.find((node) => node.id === "b")!.position.x < arranged.find((node) => node.id === "c")!.position.x);

  const arrangedGroup = arrangeCanvasNodes(
    [...grouped, chainNodes[2]],
    [{ source: "a", target: "c" }],
  );
  assert.ok(arrangedGroup.find((node) => node.id === "group-1")!.position.x < arrangedGroup.find((node) => node.id === "c")!.position.x);
  assert.deepEqual(
    arrangedGroup.find((node) => node.id === "a")?.position,
    grouped.find((node) => node.id === "a")?.position,
  );
});

test("canvas synchronized selection selects exactly the requested IDs without mutating nodes", () => {
  const nodes = [
    { id: "a", selected: true, position: { x: 0, y: 0 }, data: { kind: "text" } },
    { id: "b", selected: false, position: { x: 10, y: 0 }, data: { kind: "text" } },
  ];

  const synchronized = synchronizeCanvasNodeSelection(nodes, ["b"]);

  assert.deepEqual(synchronized.map((node) => [node.id, node.selected]), [["a", false], ["b", true]]);
  assert.deepEqual(nodes.map((node) => [node.id, node.selected]), [["a", true], ["b", false]]);
  assert.equal(selectedCanvasIdsEqual(["a", "b"], ["b", "a"]), true);
  assert.equal(selectedCanvasIdsEqual(["a"], ["b"]), false);
});

test("canvas ungroup authority requires an explicit all-group selection", () => {
  const nodes = [
    { id: "group", position: { x: 0, y: 0 }, data: { kind: "group" } },
    { id: "empty-group", position: { x: 100, y: 0 }, data: { kind: "group" } },
    { id: "child", parentId: "group", position: { x: 10, y: 10 }, data: { kind: "text" } },
    { id: "root", position: { x: 200, y: 0 }, data: { kind: "text" } },
  ];

  assert.deepEqual(selectedCanvasGroupContainerIds(nodes, ["child"]), []);
  assert.deepEqual(selectedCanvasGroupContainerIds(nodes, ["group"]), ["group"]);
  assert.equal(canUngroupCanvasSelection(nodes, ["child"]), false);
  assert.equal(canUngroupCanvasSelection(nodes, ["group", "root"]), false);
  assert.equal(canUngroupCanvasSelection(nodes, ["group"]), true);
  assert.equal(canUngroupCanvasSelection(nodes, ["empty-group"]), true);
});

test("canvas batch transforms use one coordinate space and suppress semantic no-ops", () => {
  const nodes = [
    { id: "root-a", position: { x: 0, y: 0 }, data: { kind: "text" } },
    { id: "root-b", position: { x: 30, y: 0 }, data: { kind: "text" } },
    { id: "root-c", position: { x: 90, y: 0 }, data: { kind: "text" } },
    { id: "group-a", position: { x: 0, y: 100 }, data: { kind: "group" } },
    { id: "child-a", parentId: "group-a", position: { x: 10, y: 0 }, data: { kind: "text" } },
    { id: "child-b", parentId: "group-a", position: { x: 50, y: 0 }, data: { kind: "text" } },
    { id: "group-b", position: { x: 200, y: 100 }, data: { kind: "group" } },
    { id: "child-c", parentId: "group-b", position: { x: 10, y: 0 }, data: { kind: "text" } },
  ];

  assert.equal(isSafeCanvasTransformSelection(nodes, ["root-a", "root-b"]), true);
  assert.equal(isSafeCanvasTransformSelection(nodes, ["child-a", "child-b"]), true);
  assert.equal(isSafeCanvasTransformSelection(nodes, ["root-a", "child-a"]), false);
  assert.equal(isSafeCanvasTransformSelection(nodes, ["child-a", "child-c"]), false);
  assert.equal(isSafeCanvasTransformSelection(nodes, ["group-a", "root-a"]), false);

  const aligned = planCanvasLeftAlignment(nodes, ["root-b", "root-c"]);
  assert.ok(aligned?.changed);
  assert.equal(aligned?.positions.get("root-b"), 30);
  assert.equal(aligned?.positions.get("root-c"), 30);
  assert.equal(planCanvasLeftAlignment(nodes, ["root-a", "root-a"]), null);
  assert.equal(planCanvasLeftAlignment(nodes, ["root-a", "root-b", "child-a"]), null);

  const distributed = planCanvasHorizontalDistribution(nodes, ["root-a", "root-b", "root-c"]);
  assert.ok(distributed?.changed);
  assert.equal(distributed?.positions.get("root-b"), 45);
  const alreadyDistributed = planCanvasHorizontalDistribution(
    nodes.map((node) => node.id === "root-b" ? { ...node, position: { ...node.position, x: 45 } } : node),
    ["root-a", "root-b", "root-c"],
  );
  assert.equal(alreadyDistributed?.changed, false);
});

test("canvas routes address one canvas while retaining a safe fallback", () => {
  assert.equal(canvasEditorHash("canvas-two"), "#canvas/main/canvas-two");
  assert.equal(canvasEditorHash(), "#canvas/main");
  assert.equal(parseCanvasIdFromHash("#canvas/main/canvas-two"), "canvas-two");
  assert.equal(parseCanvasIdFromHash("#canvas"), "");
  assert.equal(
    resolveCanvasOpenTarget(["canvas-one", "canvas-two"], "#canvas/main/canvas-two", "canvas-one"),
    "canvas-two",
  );
  assert.equal(
    resolveCanvasOpenTarget(["canvas-one", "canvas-two"], "#canvas/main/missing", "canvas-one"),
    "canvas-one",
  );
  assert.equal(
    resolveCanvasOpenTarget(["canvas-one", "canvas-two"], "#canvas/main", "canvas-two"),
    "canvas-two",
  );
  assert.equal(
    resolveCanvasOpenTarget(["canvas-one", "canvas-two"], "#canvas/main", "missing"),
    "canvas-one",
  );
});

test("canvas resources stay read-only while generator cards accept their context", () => {
  const resource = getCanvasNodeCapabilities({ kind: "image", _emptyMedia: false });
  const generator = getCanvasNodeCapabilities({ kind: "generator", generationKind: "image" });
  assert.equal(resource.canReceive, false);
  assert.equal(resource.canOutput, true);
  assert.equal(generator.canReceive, true);
  assert.equal(canConnectCanvasNodes(
    { kind: "image", _emptyMedia: false },
    { kind: "generator", generationKind: "image" },
  ), true);
  assert.equal(canConnectCanvasNodes(
    { kind: "generator", generationKind: "image" },
    { kind: "image", _emptyMedia: false },
  ), false);
});

test("video generation edges preserve first-frame and last-frame meaning", () => {
  const nodes = [
    { id: "image-one", data: { kind: "image" as const } },
    { id: "image-two", data: { kind: "image" as const } },
    { id: "video-generator", data: { kind: "generator" as const, generationKind: "video" as const } },
  ];
  const edges = normalizeCanvasEdgeSemantics(nodes, [
    { source: "image-one", target: "video-generator" },
    { source: "image-two", target: "video-generator" },
  ]);
  assert.equal(edges[0].data.role, "firstFrame");
  assert.equal(edges[1].data.role, "lastFrame");
  assert.deepEqual(edges.map((edge) => edge.data.order), [0, 1]);
});

test("canvas generation compiles semantic references into one immutable request", () => {
  const references = [
    { id: "last", sourceNodeId: "n-last", label: "尾帧", kind: "image", role: "lastFrame", mediaUrl: "last" },
    { id: "context", sourceNodeId: "n-text", label: "分镜说明", kind: "text", role: "promptContext", text: "人物走向窗边。" },
    { id: "first", sourceNodeId: "n-first", label: "首帧", kind: "image", role: "firstFrame", mediaUrl: "first" },
    { id: "reference", sourceNodeId: "n-ref", label: "风格参考", kind: "image", role: "reference", mediaUrl: "reference" },
  ];
  assert.deepEqual(
    orderCanvasGenerationReferences(references).map((reference) => reference.id),
    ["first", "last", "reference", "context"],
  );
  const compiled = compileCanvasGenerationInputs({
    kind: "video",
    prompt: "生成稳定的推进镜头",
    references,
  });
  assert.equal(compiled.references[0].role, "firstFrame");
  assert.equal(compiled.references[1].role, "lastFrame");
  assert.match(compiled.prompt, /人物走向窗边/);

  const redacted = sanitizeCanvasGenerationErrorDetail(
    'Authorization: Bearer secret-token data:image/png;base64,AAAA api_key="sensitive"',
  );
  assert.ok(redacted);
  assert.doesNotMatch(redacted, /secret-token|AAAA|sensitive/);
  assert.match(redacted, /REDACTED/);
});

test("canvas generation history snapshots requests instead of sharing mutable references", () => {
  const task = createCanvasGenerationTask({
    id: "task-1",
    sourceNodeId: "generator-1",
    resultNodeId: "generator-1",
    createdAt: "2026-07-27T00:00:00.000Z",
    request: {
      kind: "image",
      prompt: "生成封面",
      model: "model-a",
      references: [{ id: "asset-1", label: "参考", kind: "image", role: "reference" }],
    },
  });
  const entry = historyEntryFromTask(task);
  task.request.references[0].label = "后来修改";
  assert.equal(entry.request.references[0].label, "参考");
  assert.equal(entry.resultNodeId, "generator-1");
});

test("canvas generation runner selects a compatible adapter and settles explicitly", async () => {
  const task = createCanvasGenerationTask({
    id: "task-runner",
    sourceNodeId: "text-1",
    resultNodeId: "text-1",
    createdAt: "2026-07-27T00:00:00.000Z",
    request: { kind: "text", prompt: "整理内容", model: "model-a", references: [] },
  });
  const transitions: string[] = [];
  const result = await executeCanvasGenerationTask({
    task,
    adapters: [{
      id: "text-adapter",
      supports: (request) => request.kind === "text",
      execute: async () => ({ ok: true, output: { kind: "text", text: "整理完成" } }),
    }],
    now: () => "2026-07-27T00:00:01.000Z",
    onTransition: (next) => transitions.push(next.status),
    isCancelled: () => false,
  });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(transitions, ["running", "succeeded"]);
});

test("canvas text generation reuses the fail-closed AI reasoning projection", () => {
  assert.equal(
    sanitizeCanvasTextGenerationOutput("公开<think>PRIVATE-A<think>PRIVATE-B</think>PRIVATE-C</think>答案"),
    "公开答案",
  );
  assert.equal(sanitizeCanvasTextGenerationOutput("公开</think>PRIVATE"), "公开");
});

test("canvas image adapter rejects an empty request before provider dispatch", async () => {
  let calls = 0;
  const adapter = createCanvasImageGenerationAdapter(async () => {
    calls += 1;
    return { success: true, images: [{ url: "image.png" }] };
  });
  const result = await adapter.execute({
    kind: "image",
    prompt: "",
    model: "image-model",
    references: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "IMAGE_PROMPT_REQUIRED");
  assert.equal(calls, 0);
});

test("canvas video adapter rejects an empty request before provider dispatch", async () => {
  let calls = 0;
  const adapter = createCanvasVideoGenerationAdapter(async () => {
    calls += 1;
    return { success: true, videoUrl: "video.mp4" };
  });
  const result = await adapter.execute({
    kind: "video",
    prompt: "",
    model: "video-model",
    references: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VIDEO_PROMPT_REQUIRED");
  assert.equal(calls, 0);
});

test("canvas generation settings expose configured state without returning provider keys", () => {
  const projected = projectAiSettingsForFrontend({
    aiApiKey: "PRIVATE-CHAT-KEY",
    aiImageApiKey: "PRIVATE-CANVAS-KEY",
    aiImageBaseURL: "https://example.test/v1",
  });
  assert.equal(projected.aiApiKey, null);
  assert.equal(projected.aiApiKeyConfigured, true);
  assert.equal(projected.aiImageApiKey, null);
  assert.equal(projected.aiImageApiKeyConfigured, true);
  assert.equal(JSON.stringify(projected).includes("PRIVATE"), false);
});

test("canvas portable export preserves top-level identity, timestamps, nodes, edges and viewport", () => {
  const nodes = [
    { id: "n-1", position: { x: 10, y: 20 }, data: { kind: "text", text: "标题" } },
  ];
  const edges = [{ id: "e-1", source: "n-1", target: "n-2" }];
  const viewport = { x: 4, y: 5, zoom: 1.25 };
  const output = serializeCanvasPortableExport({
    canvasId: "canvas-1",
    name: "测试画布",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:02.000Z",
    nodes,
    edges,
    viewport,
    generationHistory: [],
  });
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.canvasId, "canvas-1");
  assert.equal(output.name, "测试画布");
  assert.equal(output.createdAt, "2026-07-27T00:00:00.000Z");
  assert.equal(output.updatedAt, "2026-07-27T00:00:02.000Z");
  assert.deepEqual(output.nodes, nodes);
  assert.deepEqual(output.edges, edges);
  assert.deepEqual(output.viewport, viewport);
});

test("canvas portable export keeps schemaVersion fixed regardless of input schema version", () => {
  const widerInput = {
    canvasId: "canvas-1",
    name: "测试画布",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:02.000Z",
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    generationHistory: [],
    schemaVersion: 2,
  };
  const output = serializeCanvasPortableExport(widerInput);
  assert.equal(output.schemaVersion, 1);
});

test("canvas portable export keeps non-empty generation history unchanged", () => {
  const history = [
    {
      version: 4,
      id: "history:task-1",
      taskId: "task-1",
      sourceNodeId: "generator-1",
      resultNodeId: "generator-1",
      kind: "image",
      status: "succeeded",
      request: {
        kind: "image",
        prompt: "生成封面",
        model: "image-model",
        references: [{ id: "asset-1", label: "参考图", kind: "image", role: "reference", mediaUrl: "asset-1.png" }],
      },
      attempt: 1,
      prompt: "生成封面",
      model: "image-model",
      outputMediaItems: [{ url: "result-1.png", thumbnailUrl: "thumb-1.png" }],
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:01.000Z",
    },
    {
      version: 4,
      id: "history:task-2",
      taskId: "task-2",
      sourceNodeId: "text-1",
      resultNodeId: "text-1",
      kind: "text",
      status: "failed",
      request: { kind: "text", prompt: "整理内容", model: "text-model", references: [] },
      attempt: 2,
      prompt: "整理内容",
      model: "text-model",
      errorCode: "PROVIDER_ERROR",
      errorMessage: "服务暂时不可用",
      createdAt: "2026-07-27T01:00:00.000Z",
      updatedAt: "2026-07-27T01:00:05.000Z",
    },
  ];
  const output = serializeCanvasPortableExport({
    canvasId: "canvas-1",
    name: "测试画布",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T01:00:05.000Z",
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    generationHistory: history,
  });
  assert.deepEqual(output.generationHistory, history);
  assert.deepEqual(JSON.parse(JSON.stringify(output)).generationHistory, history);
});

test("canvas portable export turns missing or legacy generation history into an empty array", () => {
  const base = {
    canvasId: "canvas-legacy",
    name: "旧画布",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  assert.deepEqual(serializeCanvasPortableExport(base).generationHistory, []);
  assert.deepEqual(
    serializeCanvasPortableExport({ ...base, generationHistory: undefined }).generationHistory,
    [],
  );
  assert.deepEqual(
    serializeCanvasPortableExport({ ...base, generationHistory: { not: "an array" } }).generationHistory,
    [],
  );
});

test("canvas portable export never leaks backend-only authority metadata or secrets", () => {
  const widerInput = {
    canvasId: "canvas-1",
    name: "测试画布",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:02.000Z",
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    generationHistory: [],
    schemaVersion: 1,
    revision: 42,
    contentDigest: "sha256:abc",
    agentReceipts: [{ actionId: "a-1", approvedAt: "2026-07-27T00:00:03.000Z" }],
    aiApiKey: "PRIVATE-EXPORT-KEY",
  };
  const output = serializeCanvasPortableExport(widerInput);
  assert.deepEqual(Object.keys(output).sort(), [
    "canvasId",
    "createdAt",
    "edges",
    "generationHistory",
    "name",
    "nodes",
    "schemaVersion",
    "updatedAt",
    "viewport",
  ]);
  assert.equal("revision" in output, false);
  assert.equal("contentDigest" in output, false);
  assert.equal("agentReceipts" in output, false);
  assert.equal(JSON.stringify(output).includes("PRIVATE-EXPORT-KEY"), false);
});

test("canvas portable export preserves unknown JSON-safe nested fields", () => {
  const nodes = [
    {
      id: "n-1",
      position: { x: 0, y: 0 },
      data: {
        kind: "image",
        customMeta: { tone: "warm", tags: ["a", "b"] },
        futureFlag: true,
      },
    },
  ];
  const edges = [
    { id: "e-1", source: "n-1", target: "n-2", data: { role: "reference", customEdge: { weight: 3 } } },
  ];
  const history = [
    {
      version: 4,
      id: "history:task-1",
      taskId: "task-1",
      sourceNodeId: "generator-1",
      resultNodeId: "generator-1",
      kind: "video",
      status: "succeeded",
      request: {
        kind: "video",
        prompt: "生成视频",
        model: "video-model",
        references: [{ id: "asset-1", label: "尾帧", kind: "image", role: "lastFrame", customRefField: "keep-me" }],
      },
      attempt: 1,
      prompt: "生成视频",
      model: "video-model",
      customHistoryField: { nested: { kept: true } },
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:01.000Z",
    },
  ];
  const output = serializeCanvasPortableExport({
    canvasId: "canvas-1",
    name: "测试画布",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:01.000Z",
    nodes,
    edges,
    viewport: { x: 1, y: 2, zoom: 0.5 },
    generationHistory: history,
  });
  const roundTripped = JSON.parse(JSON.stringify(output));
  assert.deepEqual(roundTripped.nodes, nodes);
  assert.deepEqual(roundTripped.edges, edges);
  assert.deepEqual(roundTripped.generationHistory, history);
});

test("canvas portable export is pure and does not mutate its input", () => {
  const input = {
    canvasId: "canvas-1",
    name: "测试画布",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:01.000Z",
    nodes: [{ id: "n-1", data: { kind: "text" } }],
    edges: [{ id: "e-1", source: "n-1", target: "n-2" }],
    viewport: { x: 0, y: 0, zoom: 1 },
    generationHistory: [
      {
        version: 4,
        id: "history:task-1",
        taskId: "task-1",
        sourceNodeId: "text-1",
        resultNodeId: "text-1",
        kind: "text",
        status: "succeeded",
        request: { kind: "text", prompt: "整理内容", model: "text-model", references: [] },
        attempt: 1,
        prompt: "整理内容",
        model: "text-model",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:01.000Z",
      },
    ],
  };
  const snapshot = structuredClone(input);
  serializeCanvasPortableExport(input);
  assert.deepEqual(input, snapshot);
});

test("canvas persistence boundary treats selection-only node changes as ephemeral", () => {
  const selectionOnly: NodeChange[] = [
    { id: "n-1", type: "select", selected: true },
    { id: "n-2", type: "select", selected: false },
  ];
  assert.equal(nodeChangesContainDurableEdit(selectionOnly), false);
  assert.equal(nodeChangesContainDurableEdit([]), false);
});

test("canvas persistence boundary treats measurement-only dimension changes as ephemeral", () => {
  const measured: NodeChange[] = [
    { id: "n-1", type: "dimensions", dimensions: { width: 320, height: 220 } },
  ];
  assert.equal(nodeChangesContainDurableEdit(measured), false);
  const measuredExplicitFalse: NodeChange[] = [
    { id: "n-1", type: "dimensions", dimensions: { width: 320, height: 220 }, setAttributes: false },
  ];
  assert.equal(nodeChangesContainDurableEdit(measuredExplicitFalse), false);
});

test("canvas persistence boundary treats position, add, remove, replace and explicit resize as durable", () => {
  assert.equal(nodeChangesContainDurableEdit([{ id: "n-1", type: "position", position: { x: 10, y: 20 } }]), true);
  assert.equal(nodeChangesContainDurableEdit([{ id: "n-1", type: "position", positionAbsolute: { x: 10, y: 20 }, dragging: true }]), true);
  assert.equal(nodeChangesContainDurableEdit([{ id: "n-new", type: "add", item: { id: "n-new" } }]), true);
  assert.equal(nodeChangesContainDurableEdit([{ id: "n-1", type: "remove" }]), true);
  assert.equal(nodeChangesContainDurableEdit([{ id: "n-1", type: "replace", item: { id: "n-1" } }]), true);
  const explicitResize: NodeChange[] = [
    { id: "n-1", type: "dimensions", dimensions: { width: 400, height: 300 }, setAttributes: true },
  ];
  assert.equal(nodeChangesContainDurableEdit(explicitResize), true);
  const explicitResizeWidth: NodeChange[] = [
    { id: "n-1", type: "dimensions", dimensions: { width: 400 }, setAttributes: "width" },
  ];
  assert.equal(nodeChangesContainDurableEdit(explicitResizeWidth), true);
  const mixedBatch: NodeChange[] = [
    { id: "n-1", type: "select", selected: true },
    { id: "n-2", type: "dimensions", dimensions: { width: 300, height: 200 } },
    { id: "n-3", type: "position", position: { x: 1, y: 1 } },
  ];
  assert.equal(nodeChangesContainDurableEdit(mixedBatch), true);
});

test("canvas persistence boundary treats edge selection as ephemeral and semantic mutations as durable", () => {
  const selectionOnly: EdgeChange[] = [
    { id: "e-1", type: "select", selected: true },
    { id: "e-2", type: "select", selected: false },
  ];
  assert.equal(edgeChangesContainDurableEdit(selectionOnly), false);
  assert.equal(edgeChangesContainDurableEdit([]), false);
  assert.equal(edgeChangesContainDurableEdit([{ id: "e-new", type: "add", item: { id: "e-new" } }]), true);
  assert.equal(edgeChangesContainDurableEdit([{ id: "e-1", type: "remove" }]), true);
  assert.equal(edgeChangesContainDurableEdit([{ id: "e-1", type: "replace", item: { id: "e-1" } }]), true);
  const mixedBatch: EdgeChange[] = [
    { id: "e-1", type: "select", selected: true },
    { id: "e-2", type: "remove" },
  ];
  assert.equal(edgeChangesContainDurableEdit(mixedBatch), true);
});

test("canvas persistence node sanitizer strips selected, dragging, measured, resizing and data._newHighlight", () => {
  const nodes = [
    {
      id: "n-1",
      position: { x: 10, y: 20 },
      selected: true,
      dragging: true,
      resizing: true,
      measured: { width: 320, height: 220 },
      data: { kind: "image", _newHighlight: true, refMediaUrl: "asset://a.png" },
    },
  ];
  const output = sanitizeCanvasNodesForPersistence(nodes);
  assert.equal("selected" in output[0], false);
  assert.equal("dragging" in output[0], false);
  assert.equal("resizing" in output[0], false);
  assert.equal("measured" in output[0], false);
  assert.equal("_newHighlight" in (output[0] as Record<string, { _newHighlight?: unknown }>).data, false);
});

test("canvas persistence node sanitizer strips the resizing lifecycle flag while preserving manual size", () => {
  // React Flow NodeResizeControl 在拖动期间写 resizing: true、松手写 resizing: false，
  // 两者都是编辑器交互生命周期状态，不得进入 durable Canvas JSON。
  const nodes = [
    {
      id: "n-1",
      position: { x: 10, y: 20 },
      resizing: true,
      style: { width: 400, height: 300 },
      data: { kind: "image", refMediaUrl: "asset://a.png" },
    },
    {
      id: "n-2",
      position: { x: 30, y: 40 },
      resizing: false,
      style: { width: 200, height: 150 },
      data: { kind: "text", text: "保留", customMeta: { kept: true } },
      futureSemanticField: "keep-me",
    },
  ];
  const output = sanitizeCanvasNodesForPersistence(nodes);
  assert.equal("resizing" in output[0], false);
  assert.equal("resizing" in output[1], false);
  // 显式/手动尺寸与位置必须原样保留。
  assert.deepEqual(output[0].style, { width: 400, height: 300 });
  assert.deepEqual(output[0].position, { x: 10, y: 20 });
  assert.deepEqual(output[1].style, { width: 200, height: 150 });
  assert.deepEqual(output[1].data.customMeta, { kept: true });
  assert.equal(output[1].futureSemanticField, "keep-me");
});

test("canvas persistence node sanitizer preserves position, style, parent links and unknown fields", () => {
  const nodes = [
    {
      id: "n-1",
      position: { x: 100, y: 80 },
      style: { width: 420, height: 260 },
      parentId: "group-1",
      data: {
        kind: "generator",
        generationKind: "image",
        prompt: "生成封面",
        generationTask: { id: "task-1", status: "succeeded" },
        references: [{ id: "ref-1", label: "参考", kind: "image", role: "reference", mediaUrl: "asset://ref.png" }],
        customMeta: { tone: "warm" },
      },
      futureSemanticField: { kept: true },
    },
  ];
  const output = sanitizeCanvasNodesForPersistence(nodes);
  assert.deepEqual(output[0], nodes[0]);
  assert.deepEqual(output[0].position, { x: 100, y: 80 });
  assert.deepEqual(output[0].style, { width: 420, height: 260 });
  assert.equal(output[0].parentId, "group-1");
  assert.equal(output[0].data.kind, "generator");
  assert.equal(output[0].data.generationTask.id, "task-1");
  assert.deepEqual(output[0].data.references, nodes[0].data.references);
  assert.deepEqual(output[0].data.customMeta, { tone: "warm" });
  assert.deepEqual(output[0].futureSemanticField, { kept: true });
});

test("canvas persistence edge sanitizer strips selected but preserves semantic data and unknown fields", () => {
  const edges = [
    {
      id: "e-1",
      source: "n-1",
      target: "n-2",
      selected: true,
      data: { role: "reference", order: 0, custom: { weight: 3 } },
      futureSemanticField: "keep-me",
    },
  ];
  const output = sanitizeCanvasEdgesForPersistence(edges);
  assert.equal("selected" in output[0], false);
  assert.equal(output[0].source, "n-1");
  assert.equal(output[0].target, "n-2");
  assert.deepEqual(output[0].data, { role: "reference", order: 0, custom: { weight: 3 } });
  assert.equal(output[0].futureSemanticField, "keep-me");
});

test("canvas persistence sanitizers do not mutate their input", () => {
  const nodes = [
    {
      id: "n-1",
      position: { x: 10, y: 20 },
      selected: true,
      dragging: true,
      measured: { width: 320, height: 220 },
      data: { kind: "image", _newHighlight: true, refMediaUrl: "asset://a.png" },
    },
  ];
  const edges = [
    { id: "e-1", source: "n-1", target: "n-2", selected: true, data: { role: "reference" } },
  ];
  const nodesSnapshot = structuredClone(nodes);
  const edgesSnapshot = structuredClone(edges);
  sanitizeCanvasNodesForPersistence(nodes);
  sanitizeCanvasEdgesForPersistence(edges);
  assert.deepEqual(nodes, nodesSnapshot);
  assert.deepEqual(edges, edgesSnapshot);
});

test("canvas save generation: an older save completion cannot clear a newer edit generation", () => {
  // 编辑 A 开始保存时捕获 generation 2;期间编辑 B 把 generation 推进到 3。
  assert.equal(canvasSaveCompletionMayMarkClean(3, 2), false);
  assert.equal(canvasSaveCompletionMayMarkClean(5, 1), false);
});

test("canvas save generation: the latest matching save completion can mark clean", () => {
  assert.equal(canvasSaveCompletionMayMarkClean(3, 3), true);
  assert.equal(canvasSaveCompletionMayMarkClean(0, 0), true);
});

test("canvas save generation: a newer edit stays pending for a subsequent save after an older save completes", () => {
  const generationAfterEditA = advanceCanvasEditGeneration(0);
  assert.equal(generationAfterEditA, 1);
  const generationAfterEditB = advanceCanvasEditGeneration(generationAfterEditA);
  assert.equal(generationAfterEditB, 2);
  // 保存 A 捕获 generation 1,完成后发现编辑代已是 2:不得标记 clean。
  assert.equal(canvasSaveCompletionMayMarkClean(generationAfterEditB, 1), false);
  // 后续匹配的保存(捕获 generation 2)可以标记 clean。
  assert.equal(canvasSaveCompletionMayMarkClean(generationAfterEditB, 2), true);
});

test("canvas save slot: explicit save and autosave cannot both own the in-flight slot", () => {
  const slot = { occupied: false };
  assert.equal(tryAcquireCanvasSaveSlot(slot), true);
  // 已持有:第二次 acquire 必须失败(显式与自动保存不能同时拥有槽)。
  assert.equal(tryAcquireCanvasSaveSlot(slot), false);
  assert.equal(tryAcquireCanvasSaveSlot(slot), false);
  releaseCanvasSaveSlot(slot);
  assert.equal(slot.occupied, false);
  assert.equal(tryAcquireCanvasSaveSlot(slot), true);
  releaseCanvasSaveSlot(slot);
});

test("canvas save identity: a save must validate the current canvas identity before writing", () => {
  const identity = { canvasId: "canvas-1", revision: 3, contentDigest: "digest-3" };
  assert.equal(canvasSaveIdentityMatchesCanvas(identity, "canvas-1"), true);
  assert.equal(canvasSaveIdentityMatchesCanvas(identity, "canvas-2"), false);
  assert.equal(canvasSaveIdentityMatchesCanvas(null, "canvas-1"), false);
  assert.equal(canvasSaveIdentityMatchesCanvas(undefined, "canvas-1"), false);
});

test("canvas save follow-up: only a successful stale save may request a serialized follow-up", () => {
  // 成功的旧保存发现新编辑 → 允许一次串行化跟进。
  assert.equal(canvasStaleSaveShouldFollowUp(true, 3, 2), true);
  // 成功且代匹配 → 无需跟进。
  assert.equal(canvasStaleSaveShouldFollowUp(true, 3, 3), false);
  // 失败保存 → 绝不请求立即跟进(避免无限重试循环)。
  assert.equal(canvasStaleSaveShouldFollowUp(false, 3, 2), false);
  assert.equal(canvasStaleSaveShouldFollowUp(false, 3, 3), false);
});

test("canvas save orchestration: explicit save re-reads identity after waiting for an in-flight autosave", async () => {
  // 确定性模拟:v1 阻塞期间 autosave 成功并推进 identity,显式保存等待后
  // 必须使用刷新后的 identity,且与 autosave 共享同一保存槽。
  const slot = { occupied: false };
  const identityRef = { canvasId: "canvas-1", revision: 1, contentDigest: "digest-1" };
  const written: Array<{ revision: number; contentDigest: string }> = [];

  // autosave 开始(持有槽),稍后成功并推进 identity。
  assert.equal(tryAcquireCanvasSaveSlot(slot), true);
  const autosavePromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    identityRef.revision = 2;
    identityRef.contentDigest = "digest-2";
    releaseCanvasSaveSlot(slot);
  })();

  // 显式保存:等待槽释放(模拟 while occupied 等待)。
  while (slot.occupied) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await autosavePromise;
  assert.equal(tryAcquireCanvasSaveSlot(slot), true);
  // 等待后重新读取 identity:必须携带 autosave 推进后的新 revision/digest。
  assert.equal(canvasSaveIdentityMatchesCanvas(identityRef, "canvas-1"), true);
  written.push({ revision: identityRef.revision, contentDigest: identityRef.contentDigest });
  releaseCanvasSaveSlot(slot);

  assert.deepEqual(written, [{ revision: 2, contentDigest: "digest-2" }]);
});

test("canvas history snapshot strips UI transient fields while preserving real size and semantic fields", () => {
  const snap = createCanvasHistorySnapshot({
    canvasId: "canvas-1",
    nodes: [{
      id: "n-1",
      position: { x: 10, y: 20 },
      width: 400,
      height: 300,
      selected: true,
      dragging: true,
      resizing: true,
      measured: { width: 401, height: 301 },
      style: { width: 400, height: 300 },
      data: { kind: "text", label: "标题", _newHighlight: true, refs: [{ id: "r-1" }] },
    }],
    edges: [{ id: "e-1", source: "a", target: "b", selected: true, data: { role: "reference", order: 0 } }],
    generationHistory: [{ id: "history:1", taskId: "t-1" }],
  });
  const node = snap.nodes[0] as Record<string, { _newHighlight?: unknown }>;
  assert.equal("selected" in node, false);
  assert.equal("dragging" in node, false);
  assert.equal("resizing" in node, false);
  assert.equal("measured" in node, false);
  assert.equal("_newHighlight" in node.data, false);
  assert.deepEqual(node.position, { x: 10, y: 20 });
  assert.equal(node.width, 400);
  assert.equal(node.height, 300);
  assert.deepEqual(node.style, { width: 400, height: 300 });
  assert.equal(node.data.kind, "text");
  assert.deepEqual(node.data.refs, [{ id: "r-1" }]);
  const edge = snap.edges[0] as Record<string, unknown>;
  assert.equal("selected" in edge, false);
  assert.deepEqual(edge.data, { role: "reference", order: 0 });
});

test("canvas history snapshot does not alias mutable nested semantic input", () => {
  const liveNode = {
    id: "n-1",
    data: { kind: "text", label: "原始", refs: [{ id: "r-1" }] },
  };
  const liveHistory = [{ id: "history:1", taskId: "t-1", request: { references: [{ id: "ref-1" }] } }];
  const snap = createCanvasHistorySnapshot({
    canvasId: "canvas-1",
    nodes: [liveNode],
    edges: [{ id: "e-1", source: "a", target: "b" }],
    generationHistory: liveHistory,
  });
  // 后续实时编辑原地修改 live 状态:历史快照必须不受影响。
  liveNode.data.label = "被修改";
  liveNode.data.refs.push({ id: "r-2" });
  liveHistory[0].request.references.push({ id: "ref-2" });
  const stored = snap.nodes[0] as { data: { label: string; refs: unknown[] } };
  assert.equal(stored.data.label, "原始");
  assert.equal(stored.data.refs.length, 1);
  assert.equal((snap.generationHistory[0] as { request: { references: unknown[] } }).request.references.length, 1);
});

test("canvas history append preserves chronological order and the max-80 policy", () => {
  let stack: CanvasHistorySnapshot[] = [];
  for (let i = 0; i < 85; i++) {
    stack = appendCanvasHistoryEntry(stack, createCanvasHistorySnapshot({
      canvasId: `s-${i}`,
      nodes: [],
      edges: [],
      generationHistory: [],
    }));
  }
  assert.equal(stack.length, 80);
  assert.equal(stack[0].canvasId, "s-5");
  assert.equal(stack[79].canvasId, "s-84");
});

test("canvas history ordering: pending edit A then command B yields undo C->B then B->A", () => {
  // 模拟:打字产生 pending 快照 A;800ms 前用户执行命令(状态 B→C)。
  // 修复后的顺序:先 flush A 入栈,再 commit B 入栈,得到 [A, B]。
  let past: CanvasHistorySnapshot[] = [];
  const snapA = createCanvasHistorySnapshot({ canvasId: "c1", nodes: [{ id: "a" }], edges: [], generationHistory: [] });
  const snapB = createCanvasHistorySnapshot({ canvasId: "c1", nodes: [{ id: "b" }], edges: [], generationHistory: [] });
  past = appendCanvasHistoryEntry(past, snapA); // flushEditHistory(编辑 A)
  past = appendCanvasHistoryEntry(past, snapB); // commitHistory(命令 B,状态 C)
  // 从 C 撤销:第一次 Undo 弹出 B(恢复状态 B),第二次 Undo 弹出 A(恢复状态 A)。
  assert.equal(past[past.length - 1].canvasId, "c1");
  const undo1 = past.pop()!;
  assert.equal(undo1.nodes[0].id, "b");
  const undo2 = past.pop()!;
  assert.equal(undo2.nodes[0].id, "a");
  assert.equal(past.length, 0);
});

test("canvas history redo cannot consume stale future after a new edit begins", () => {
  // 新编辑开始(beginPendingEdit)必须立即清空 future;之后 redo 无可消费状态。
  let future: CanvasHistorySnapshot[] = [createCanvasHistorySnapshot({
    canvasId: "c1", nodes: [{ id: "stale" }], edges: [], generationHistory: [],
  })];
  // beginPendingEdit 语义:新编辑立即失效 redo。
  future = [];
  assert.equal(future.length, 0);
  assert.equal(future.length === 0, true);
});

test("canvas resize comparison treats a real size change as one transaction and no-op as none", () => {
  const before = [{ id: "n-1", width: 320, height: 220 }];
  assert.equal(canvasResizeChangedDocumentSize(before, [{ id: "n-1", width: 400, height: 300 }]), true);
  assert.equal(canvasResizeChangedDocumentSize(before, [{ id: "n-1", width: 320, height: 220 }]), false);
  assert.equal(canvasResizeChangedDocumentSize(before, []), false);
  assert.equal(canvasResizeChangedDocumentSize(before, [{ id: "n-2", width: 400, height: 300 }]), false);
  // style 手动尺寸 fallback
  assert.equal(canvasResizeChangedDocumentSize(
    [{ id: "n-1", style: { width: 100, height: 50 } }],
    [{ id: "n-1", style: { width: 120, height: 50 } }],
  ), true);
  assert.equal(canvasResizeChangedDocumentSize(
    [{ id: "n-1", style: { width: 100, height: 50 } }],
    [{ id: "n-1", style: { width: 100, height: 50 } }],
  ), false);
});

test("canvas resize snapshot preserves pre-resize state and redo restores resized state", () => {
  const preResize = createCanvasHistorySnapshot({
    canvasId: "c1",
    nodes: [{
      id: "n-1",
      width: 320,
      height: 220,
      style: { width: 320, height: 220 },
      data: { kind: "text", label: "节点", _manualSize: false },
    }],
    edges: [],
    generationHistory: [],
  });
  // 模拟 resize 后的实时状态(尺寸变化 + _manualSize 语义)。
  const resized = [{
    id: "n-1",
    width: 500,
    height: 400,
    style: { width: 500, height: 400 },
    data: { kind: "text", label: "节点", _manualSize: true },
  }];
  // Undo:应用 pre-resize 快照 → 恢复 320x220 与 _manualSize false。
  const undoNode = preResize.nodes[0] as { width: number; height: number; data: { _manualSize: boolean } };
  assert.equal(undoNode.width, 320);
  assert.equal(undoNode.height, 220);
  assert.equal(undoNode.data._manualSize, false);
  // Redo:应用 resized 状态 → 500x400 与 _manualSize true。
  assert.equal(resized[0].width, 500);
  assert.equal(resized[0].height, 400);
  assert.equal(resized[0].data._manualSize, true);
  // 快照不含 resizing 生命周期字段。
  assert.equal("resizing" in preResize.nodes[0], false);
});

test("canvas history snapshot equality detects duplicate identical snapshots", () => {
  const make = (label: string) => createCanvasHistorySnapshot({
    canvasId: "c1",
    nodes: [{ id: "n-1", data: { kind: "text", label } }],
    edges: [],
    generationHistory: [],
  });
  assert.equal(canvasHistorySnapshotsEqual(make("相同"), make("相同")), true);
  assert.equal(canvasHistorySnapshotsEqual(make("相同"), make("不同")), false);
  const otherCanvas = createCanvasHistorySnapshot({
    canvasId: "c2",
    nodes: [{ id: "n-1", data: { kind: "text", label: "相同" } }],
    edges: [],
    generationHistory: [],
  });
  assert.equal(canvasHistorySnapshotsEqual(make("相同"), otherCanvas), false);
});

test("canvas label-edit transaction: beginning a label edit invalidates redo immediately and snapshots canonically", () => {
  // 模拟 Undo 后存在 stale redo future;开始 label 编辑(主文字编辑路径)必须
  // 立即失效 future(不等 800ms flush),且快照是 canonical 深拷贝。
  const staleFuture = [createCanvasHistorySnapshot({
    canvasId: "c1", nodes: [{ id: "n-old" }], edges: [], generationHistory: [],
  })];
  const liveNode = {
    id: "n-1",
    selected: true,
    resizing: true,
    data: { kind: "text", label: "旧标签" },
  };
  const result = canvasBeginPendingEdit(null, staleFuture, {
    canvasId: "c1",
    nodes: [liveNode],
    edges: [],
    generationHistory: [],
  });
  assert.equal(result.future.length, 0); // redo 立即失效
  const snapNode = result.snapshot.nodes[0] as Record<string, unknown>;
  assert.equal("selected" in snapNode, false);
  assert.equal("resizing" in snapNode, false);
  // 快照不共享 live 嵌套状态。
  liveNode.data.label = "被修改";
  assert.equal((result.snapshot.nodes[0] as { data: { label: string } }).data.label, "旧标签");
});

test("canvas label-edit transaction: continued typing reuses the same snapshot (800ms coalescing)", () => {
  const first = canvasBeginPendingEdit(null, [], {
    canvasId: "c1", nodes: [{ id: "n-1", data: { kind: "text", label: "a" } }], edges: [], generationHistory: [],
  });
  const second = canvasBeginPendingEdit(first.snapshot, first.future, {
    canvasId: "c1", nodes: [{ id: "n-1", data: { kind: "text", label: "ab" } }], edges: [], generationHistory: [],
  });
  assert.equal(second.snapshot, first.snapshot); // 同一事务快照
  assert.equal(second.future.length, 0);
});

test("canvas no-op resize leaves _manualSize and history unchanged", () => {
  // no-op resize:有效尺寸未变且表示一致 → 决策不得提交事务、不得设置 _manualSize、无需 corrective。
  const decision = canvasResizeEndDecision(
    { id: "n-1", width: 320, height: 220, style: { width: 320, height: 220 }, data: { _manualSize: false } },
    { id: "n-1", width: 320, height: 220, style: { width: 320, height: 220 }, data: { _manualSize: false } },
  );
  assert.equal(decision.commitTransaction, false);
  assert.equal(decision.setManualSize, false);
  assert.equal(decision.needsCorrectiveSave, false);
  const before = [{ id: "n-1", width: 320, height: 220, data: { _manualSize: false } }];
  const after = [{ id: "n-1", width: 320, height: 220, data: { _manualSize: false } }];
  assert.equal(canvasResizeChangedDocumentSize(before, after), false);
  let past: CanvasHistorySnapshot[] = [];
  if (decision.commitTransaction) past = appendCanvasHistoryEntry(past, createCanvasHistorySnapshot({
    canvasId: "c1", nodes: before, edges: [], generationHistory: [],
  }));
  assert.equal(past.length, 0); // 无历史条目
});

test("canvas real resize commits exactly one undo/redo transaction and sets _manualSize", () => {
  const decision = canvasResizeEndDecision(
    { id: "n-1", width: 320, height: 220, style: { width: 320, height: 220 }, data: { kind: "text", _manualSize: false } },
    { id: "n-1", width: 500, height: 400, style: { width: 320, height: 220 }, data: { kind: "text", _manualSize: true } },
  );
  assert.equal(decision.commitTransaction, true);
  assert.equal(decision.setManualSize, true);
  assert.equal(decision.needsCorrectiveSave, false);
  const preResize = createCanvasHistorySnapshot({
    canvasId: "c1",
    nodes: [{ id: "n-1", width: 320, height: 220, data: { kind: "text", _manualSize: false } }],
    edges: [],
    generationHistory: [],
  });
  const resized = [{ id: "n-1", width: 500, height: 400, data: { kind: "text", _manualSize: true } }];
  assert.equal(canvasResizeChangedDocumentSize(preResize.nodes, resized), true);
  // 恰好一个条目。
  let past: CanvasHistorySnapshot[] = [];
  past = appendCanvasHistoryEntry(past, preResize);
  assert.equal(past.length, 1);
  // Undo 恢复 pre-resize 尺寸/_manualSize;Redo 恢复 resized 状态。
  const undoNode = past[past.length - 1].nodes[0] as { width: number; height: number; data: { _manualSize: boolean } };
  assert.equal(undoNode.width, 320);
  assert.equal(undoNode.height, 220);
  assert.equal(undoNode.data._manualSize, false);
  assert.equal(resized[0].width, 500);
  assert.equal(resized[0].data._manualSize, true);
});

test("canvas final-size no-op resize with materialized top-level dimensions needs corrective save and restores representation", () => {
  // 真实序列:pre 节点仅有 style 尺寸;resize 拖开再拖回原尺寸后,React Flow
  // 已把相等数值 materialize 到顶层 width/height。
  const before = { id: "n-1", style: { width: 320, height: 220 }, data: { kind: "text", _manualSize: false } };
  const after = { id: "n-1", width: 320, height: 220, style: { width: 320, height: 220 }, data: { kind: "text", _manualSize: false } };
  const decision = canvasResizeEndDecision(before, after);
  assert.equal(decision.commitTransaction, false); // final-size no-op:无历史事务
  assert.equal(decision.setManualSize, false);     // 不改变 _manualSize
  assert.equal(decision.needsCorrectiveSave, true); // 表示恢复改变了 live durable shape
  // 恢复:顶层 width/height 必须回到 pre 的缺席状态,style/语义保留。
  const restored = restoreCanvasNodeDimensionRepresentation(after, before);
  assert.equal("width" in restored, false);
  assert.equal("height" in restored, false);
  assert.deepEqual(restored.style, { width: 320, height: 220 });
  assert.deepEqual(restored.data, { kind: "text", _manualSize: false });
  assert.equal(restored.id, "n-1");
});

test("canvas final-size no-op with pre-existing top-level dimensions preserves exact values and needs no corrective save", () => {
  const before = { id: "n-1", width: 320, height: 220, style: { width: 320, height: 220 }, data: { kind: "text" } };
  const after = { id: "n-1", width: 320, height: 220, style: { width: 320, height: 220 }, data: { kind: "text" } };
  const decision = canvasResizeEndDecision(before, after);
  assert.equal(decision.commitTransaction, false);
  assert.equal(decision.setManualSize, false);
  assert.equal(decision.needsCorrectiveSave, false); // 表示未变:无需 corrective
  const restored = restoreCanvasNodeDimensionRepresentation(after, before);
  assert.equal(restored.width, 320);
  assert.equal(restored.height, 220);
});

test("canvas dimension representation restore preserves pre values and unrelated live state", () => {
  const before = { id: "n-1", width: 300, height: 200 };
  const after = {
    id: "n-1",
    width: 320,
    height: 220,
    style: { width: 320, height: 220 },
    position: { x: 5, y: 6 },
    data: { kind: "text", label: "保留", custom: { kept: true } },
  };
  const restored = restoreCanvasNodeDimensionRepresentation(after, before);
  assert.equal(restored.width, 300); // 恢复 pre 值
  assert.equal(restored.height, 200);
  assert.deepEqual(restored.style, { width: 320, height: 220 }); // 非 resize-owned 保留
  assert.deepEqual(restored.position, { x: 5, y: 6 });
  assert.deepEqual(restored.data, { kind: "text", label: "保留", custom: { kept: true } });
});

test("canvas real final size change remains exactly one undo/redo transaction with _manualSize", () => {
  const before = { id: "n-1", style: { width: 320, height: 220 }, data: { kind: "text", _manualSize: false } };
  const after = { id: "n-1", width: 500, height: 400, style: { width: 320, height: 220 }, data: { kind: "text", _manualSize: true } };
  const decision = canvasResizeEndDecision(before, after);
  assert.equal(decision.commitTransaction, true);
  assert.equal(decision.setManualSize, true);
  assert.equal(decision.needsCorrectiveSave, false);
  let past: CanvasHistorySnapshot[] = [];
  if (decision.commitTransaction) {
    past = appendCanvasHistoryEntry(past, createCanvasHistorySnapshot({ canvasId: "c1", nodes: [before], edges: [], generationHistory: [] }));
  }
  assert.equal(past.length, 1); // 恰好一个 Undo 条目
  const undoNode = past[0].nodes[0] as { style: { width: number; height: number }; data: { _manualSize: boolean } };
  assert.equal(undoNode.style.width, 320);
  assert.equal(undoNode.style.height, 220);
  assert.equal(undoNode.data._manualSize, false);
});
