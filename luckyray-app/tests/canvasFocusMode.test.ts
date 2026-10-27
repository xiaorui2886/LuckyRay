import { applyFocusReference, resolvePinnedFocusReference } from "../src/core/canvas/focusReference";
import { createCanvasReferencePlan } from "../src/core/canvas/referencePlan";
import { parseReferenceMentions } from "../src/core/canvas/referenceMentions";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { buildCanvasFocusMessages, normalizeCanvasFocusPoint, sanitizeCanvasFocusPhrase } from "../src/core/canvas/focusTarget";
import { getCanvasNodeCapabilities } from "../src/core/canvas/nodeCapabilities";
import { splitImageSource } from "../src/core/canvas/imageGrid";

const require = createRequire(import.meta.url);
const { transformSync } = createRequire(require.resolve("vite"))("esbuild");
const source = readFileSync(new URL("../src/CanvasSpike.tsx", import.meta.url), "utf8");
const stopStart = source.indexOf("  const stopCanvasFocus = useCallback(");
const stop = source.slice(stopStart, source.indexOf("  useEffect(", stopStart));
const commands = source.slice(
  source.indexOf("  // Focus mode pins the composer"),
  source.indexOf("  // End focus-mode commands."),
);
assert.ok(stopStart > 0 && commands.includes("const recognizeCanvasFocusPoint"));
const code = transformSync(stop + commands, { loader: "ts", target: "es2022" }).code;
const JPEG = "data:image/jpeg;base64,/9j/2Q==";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: { legacy?: boolean; response?: Promise<any>; readError?: boolean; unconfigured?: boolean } = {}) {
  const events: any[] = [];
  const requests: any[] = [];
  const timers = new Map<number, () => void>();
  let sequence = 0;
  const env: any = {
    currentCanvasId: "canvas",
    currentCanvasIdRef: { current: "canvas" },
    canvasLoadEpochRef: { current: 2 },
    loadingCanvas: false,
    activeMediaProfile: {
      id: "vision", revision: 8, textProtocol: options.legacy ? "legacy" : "openai-chat",
      apiKeyConfigured: !options.unconfigured,
    },
    aiRuntimeConfig: { ready: true, model: "vision-model" },
    focusTextBindingKey: "binding",
    focusTextBindingRef: { current: "binding" },
    focusSession: null,
    focusSessionRef: { current: null },
    focusBusyRef: { current: false },
    focusRequestRef: { current: 0 },
    focusAbortRef: { current: null },
    focusPointerRef: { current: null },
    selectedNodeId: "target",
    composerNodeId: "target",
    nodesRef: { current: [
      { id: "target", selected: true, data: { kind: "generator", generationKind: "image", generationPrompt: "原有提示词", label: "Target" } },
      { id: "source", selected: false, data: { kind: "image", refMediaUrl: "/source.png", label: "Source" } },
    ] },
    getCanvasNodeCapabilities,
    inferGenerationKind: (node: any) => node.data.generationKind || node.data.kind,
    applyFocusReference, resolvePinnedFocusReference, createCanvasReferencePlan,
    referenceForCanvasNode: (node: any) => ({id:`node:${node.id}`,sourceNodeId:node.id,kind:node.data.generationKind || node.data.kind,label:node.data.label,mediaUrl:node.data.refMediaUrl || node.data.resultMediaUrl,thumbnailUrl:node.data.refThumbnailUrl || node.data.resultThumbnailUrl}),
    resolveStoredCanvasReferences: (node: any) => node.data.generationReferences || [],
    edgesRef: {current: []},
    genEdgeId: () => 'focus-edge-' + (++sequence),
    setEdges: (edges: any[]) => { env.edgesRef.current = edges; },
    splitImageSource,
    normalizeCanvasFocusPoint,
    buildCanvasFocusMessages,
    sanitizeCanvasFocusPhrase,
    locale: "zh-CN",
    useCallback: (fn: Function) => fn,
    useEffect: () => {},
    setFocusSession: (session: any) => events.push(["session", session]),
    setFocusBusy: (busy: boolean) => events.push(["busy", busy]),
    setFocusStatus: (status: string) => events.push(["status", status]),
    setNodeSaveNotice: (notice: string) => events.push(["notice", notice]),
    setInspectorNodeId: () => {},
    setNodeContextMenu: () => {},
    setSelectionContextMenu: () => {},
    setQuickAddMenu: () => {},
    setConnectDropMenu: () => {},
    setInlineEditingNodeId: () => {},
    setComposerNodeId: (id: string) => events.push(["composer", id]),
    selectSingleNode: (id: string) => events.push(["selected", id]),
    commitHistory: () => events.push(["history", structuredClone(env.nodesRef.current)]),
    markDirty: () => events.push(["dirty"]),
    setNodes: (nodes: any[]) => { env.nodesRef.current = nodes; },
    resolveCanvasMediaUrl: (url: string) => url,
    readMediaBytes: async (url: string, signal: AbortSignal, max: number) => {
      events.push(["read", url, signal, max]);
      if (options.readError) throw Error("private local path /secret/token");
      return new Uint8Array([1, 2, 3]);
    },
    prepareCanvasFocusImage: (image: any, options: any) => {
      events.push(["prepared", image, options]);
      return { dataUrl: JPEG, width: 400, height: 200, point: options.point };
    },
    URL: {
      createObjectURL: () => "blob:focus-test",
      revokeObjectURL: (url: string) => events.push(["revoke", url]),
    },
    Image: class {
      naturalWidth = 400;
      naturalHeight = 200;
      src = "";
      async decode() {}
    },
    window: {
      getComputedStyle: () => ({ objectFit: "contain", objectPosition: "50% 50%" }),
      setTimeout: (fn: () => void) => { timers.set(++sequence, fn); return sequence; },
      clearTimeout: (id: number) => timers.delete(id),
    },
  };
  env.nodes = env.nodesRef.current;
  env.completeCanvasProfileText = (id: string, revision: number, messages: unknown[], requestOptions: any) => {
    requests.push({ id, revision, messages, options: requestOptions, channel: "profile" });
    return options.response ?? Promise.resolve({ success: true, content: "黑白格纹纸张" });
  };
  env.bridge = {
    aiChatComplete: (messages: unknown[], requestOptions: any) => {
      requests.push({ messages, options: requestOptions, channel: "legacy" });
      return options.response ?? Promise.resolve({ success: true, content: "黑白格纹纸张" });
    },
  };
  const api = Function("env", `const {${Object.keys(env).join(",")}} = env; ${code}; return {toggleCanvasFocus, recognizeCanvasFocusPoint, stopCanvasFocus};`)(env);
  const image = {
    complete: true, naturalWidth: 400, naturalHeight: 200,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
  };
  return {
    env, api, events, requests, timers, image,
    click: (nodeId = "source", event = { clientX: 100, clientY: 50 }, index = 0) => api.recognizeCanvasFocusPoint(event, nodeId, image, index),
    start: () => api.toggleCanvasFocus("target"),
    target: () => env.nodesRef.current.find((node: any) => node.id === "target"),
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("focus pins the target and performs a marked-image vision request without generation", async () => {
  const h = setup();
  h.start();
  assert.equal(h.env.focusSessionRef.current.targetId, "target");
  assert.ok(h.events.some(([name, id]) => name === "selected" && id === "target"));
  assert.ok(h.events.some(([name, id]) => name === "composer" && id === "target"));
  await h.click();
  assert.equal(h.requests.length, 1);
  assert.deepEqual([h.requests[0].id, h.requests[0].revision, h.requests[0].options.model], ["vision", 8, "vision-model"]);
  assert.equal(h.requests[0].messages[0].content[1].image_url.url, JPEG);
  assert.deepEqual(h.events.find(([name]) => name === "prepared")[2].point, { x: 0.5, y: 0.5 });
  assert.equal(parseReferenceMentions(h.target().data.generationPrompt)[0].type, "text");
  const focusPart = parseReferenceMentions(h.target().data.generationPrompt)[1];
  assert.ok(focusPart.type === "reference" && focusPart.focus?.label === "黑白格纹纸张");
  assert.equal(h.env.edgesRef.current.length, 1);
  assert.equal(h.env.edgesRef.current[0].data.referenceMediaUrl, "/source.png");
  assert.equal(h.target().data.generationTask, undefined);
  assert.equal(h.events.filter(([name]) => name === "history").length, 1);
  assert.equal(h.env.nodesRef.current[1].data.refMediaUrl, "/source.png");
  assert.equal(h.env.focusBusyRef.current, false);
  assert.ok(h.events.some(([name]) => name === "revoke"));
  assert.equal(h.timers.size, 0);
});

test("legacy bridge receives actual multimodal content and the pinned text model", async () => {
  const h = setup({ legacy: true });
  h.start();
  await h.click();
  assert.equal(h.requests[0].channel, "legacy");
  assert.equal(h.requests[0].messages[0].content[1].type, "image_url");
  assert.equal(h.requests[0].options.model, "vision-model");
});

test("typing during recognition is preserved and duplicate busy clicks are ignored", async () => {
  const response = deferred<any>();
  const h = setup({ response: response.promise });
  h.start();
  const first = h.click();
  await tick();
  await h.click();
  assert.equal(h.requests.length, 1);
  h.target().data.generationPrompt = "用户刚刚输入的内容 ";
  response.resolve({ success: true, content: "黑白格纹纸张" });
  await first;
  assert.ok(h.target().data.generationPrompt.startsWith("用户刚刚输入的内容 "));
  const focusPart = parseReferenceMentions(h.target().data.generationPrompt)[1];
  assert.ok(focusPart.type === "reference" && focusPart.focus?.label === "黑白格纹纸张");
});

test("own target clicks and letterboxed areas never read or send an image", async () => {
  const h = setup();
  h.start();
  await h.click("target");
  h.image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  await h.click("source", { clientX: 100, clientY: 20 });
  assert.equal(h.requests.length, 0);
  assert.equal(h.events.filter(([name]) => name === "read").length, 0);
  assert.equal(h.target().data.generationPrompt, "原有提示词");
});

test("Escape/exit invalidates an in-flight result without changing the prompt", async () => {
  const response = deferred<any>();
  const h = setup({ response: response.promise });
  h.start();
  const pending = h.click();
  await tick();
  const controller = h.env.focusAbortRef.current;
  h.api.stopCanvasFocus();
  assert.equal(controller.signal.aborted, true);
  response.resolve({ success: true, content: "黑白格纹纸张" });
  await pending;
  assert.equal(h.env.focusSessionRef.current, null);
  assert.equal(h.target().data.generationPrompt, "原有提示词");
  assert.equal(h.events.filter(([name]) => name === "history").length, 0);
});

test("navigation, source replacement/deletion, target deletion and config changes suppress stale results", async () => {
  const mutations = [
    (h: ReturnType<typeof setup>) => { h.env.currentCanvasIdRef.current = "another-canvas"; },
    (h: ReturnType<typeof setup>) => { h.env.canvasLoadEpochRef.current++; },
    (h: ReturnType<typeof setup>) => { h.env.focusTextBindingRef.current = "new-binding"; },
    (h: ReturnType<typeof setup>) => { h.env.nodesRef.current[1].data.refMediaUrl = "/replacement.png"; },
    (h: ReturnType<typeof setup>) => { h.env.nodesRef.current = h.env.nodesRef.current.filter((node: any) => node.id !== "source"); },
    (h: ReturnType<typeof setup>) => { h.env.nodesRef.current = h.env.nodesRef.current.filter((node: any) => node.id !== "target"); },
    (h: ReturnType<typeof setup>) => { h.target().data.generationTask = { status: "running" }; },
  ];
  for (const mutate of mutations) {
    const response = deferred<any>();
    const h = setup({ response: response.promise });
    h.start();
    const pending = h.click();
    await tick();
    mutate(h);
    response.resolve({ success: true, content: "黑白格纹纸张" });
    await pending;
    assert.equal(h.events.filter(([name]) => name === "history").length, 0);
    assert.equal(h.events.filter(([name]) => name === "dirty").length, 0);
    assert.equal(h.env.focusBusyRef.current, false);
  }
});

test("closing and re-entering focus cannot let an earlier request append to the new session", async () => {
  const response = deferred<any>();
  const h = setup({ response: response.promise });
  h.start();
  const first = h.click();
  await tick();
  h.api.stopCanvasFocus();
  h.start();
  const second = h.click();
  await tick();
  response.resolve({ success: true, content: "黑白格纹纸张" });
  await Promise.all([first, second]);
  assert.equal(parseReferenceMentions(h.target().data.generationPrompt)[0].type, "text");
  const focusPart = parseReferenceMentions(h.target().data.generationPrompt)[1];
  assert.ok(focusPart.type === "reference" && focusPart.focus?.label === "黑白格纹纸张");
  assert.equal(h.env.edgesRef.current.length, 1);
  assert.equal(h.env.edgesRef.current[0].data.referenceMediaUrl, "/source.png");
  assert.equal(h.events.filter(([name]) => name === "history").length, 1);
});

test("gallery clicks use the exact selected image rather than always the first result", async () => {
  const h = setup();
  h.env.nodesRef.current[1].data = {
    kind: "generator", generationKind: "image", resultMediaItems: [{ url: "/first.png" }, { url: "/second.png" }],
  };
  h.start();
  await h.click("source", { clientX: 100, clientY: 50 }, 1);
  assert.equal(h.events.find(([name]) => name === "read")[1], "/second.png");
});

test("unknown/refusal/provider errors and unreadable images never insert invented labels", async () => {
  for (const options of [
    { response: Promise.resolve({ success: true, content: "__UNKNOWN__" }) },
    { response: Promise.resolve({ success: true, content: "无法识别" }) },
    { response: Promise.resolve({ success: false, error_kind: "api_error", error_message: "private provider secret" }) },
    { readError: true },
  ]) {
    const h = setup(options);
    h.start();
    await h.click();
    assert.equal(h.target().data.generationPrompt, "原有提示词");
    assert.equal(h.events.filter(([name]) => name === "history").length, 0);
    assert.equal(h.env.focusBusyRef.current, false);
    assert.equal(h.events.some(([name, value]) => name === "status" && /secret|token/.test(value)), false);
  }
});

test("bounded recognition timeout clears busy state and does not write late results", async () => {
  const response = deferred<any>();
  const h = setup({ response: response.promise });
  h.start();
  const pending = h.click();
  await tick();
  [...h.timers.values()][0]();
  await pending;
  assert.equal(h.env.focusBusyRef.current, false);
  assert.ok(h.events.some(([name, value]) => name === "status" && value.includes("超时")));
  response.resolve({ success: true, content: "黑白格纹纸张" });
  await tick();
  assert.equal(h.target().data.generationPrompt, "原有提示词");
});

test("unconfigured vision text connection does not enter focus or send an image", () => {
  const h = setup({ unconfigured: true });
  h.start();
  assert.equal(h.env.focusSessionRef.current, null);
  assert.equal(h.requests.length, 0);
  assert.ok(h.events.some(([name, value]) => name === "notice" && value.includes("文本模型")));
});

test("production wiring pins selection, exits on Escape and retains a visible exit control", () => {
  assert.match(source, /if \(focusSessionRef\.current\) changes = changes\.filter\(\(change\) => change\.type !== "select"\)/);
  assert.match(source, /onSelectionChange=\{\(\{ nodes: selNodes \}\) => \{\s+if \(focusSessionRef\.current\) return;/);
  assert.match(source, /onPaneClick=\{\(\) => \{\s+if \(focusSessionRef\.current\) return;/);
  assert.match(source, /event\.key !== "Escape".*focusSessionRef\.current/);
  assert.match(source, /elementsSelectable=\{!focusSession\}/);
  assert.match(source, /nodesDraggable=\{!focusSession\}/);
  assert.match(source, /<CanvasFocusStatus host=\{editorBodyRef\}/);
  const statusSource = readFileSync(new URL("../src/features/canvas/CanvasFocusStatus.tsx", import.meta.url), "utf8");
  assert.match(statusSource, /role="status"/);
  assert.match(statusSource, /getBoundingClientRect\(\).bottom - body.getBoundingClientRect\(\).top \+ 12/);
  assert.match(statusSource, /onClick=\{onExit\}/);
  assert.match(source, /onToggleFocus=\{\(\) => toggleCanvasFocus\(selectedNode\.id\)\}/);
  assert.equal(commands.includes("submitGenerationFromNode"), false);
  const css = readFileSync(new URL("../src/features/canvas/canvasFocusMode.css", import.meta.url), "utf8");
  assert.match(css, /canvas-focus-target\s*\{\s*opacity: 0?\.38/);
  assert.match(css, /cursor: crosshair/);
  assert.match(css, /var\(--theme-glass-bg/);
});

function stageHandler(name: string, env: Record<string, unknown>) {
  const stage = source.indexOf('className="canvas-editor-stage"');
  const start = source.indexOf(`${name}={(event) => {`, stage) + name.length + 2;
  assert.ok(start > stage);
  const open = source.indexOf("{", start);
  let depth = 1;
  let end = open + 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  const callback = transformSync(`const callback = ${source.slice(start, end)};`, { loader: "ts", target: "es2022" }).code;
  return Function("env", `const {${Object.keys(env).join(",")}} = env; ${callback}; return callback;`)(env);
}

test("focus image taps ignore drags over five pixels, including a drag back to its start", () => {
  const recognized: unknown[] = [];
  class FakeElement {
    dataset = { id: "source" };
    closest(selector: string) {
      return selector === ".react-flow__node" || selector === "img" ? this : null;
    }
    contains() { return true; }
  }
  const env = {
    Element: FakeElement,
    focusSessionRef: { current: {} },
    focusPointerRef: { current: null as any },
    recognizeCanvasFocusPoint: (...args: unknown[]) => recognized.push(args),
    setGroupDragging: () => {},
  };
  const down = stageHandler("onPointerDownCapture", env);
  const move = stageHandler("onPointerMoveCapture", env);
  const click = stageHandler("onClickCapture", env);
  const event = (x: number, y: number) => ({
    pointerId: 1, clientX: x, clientY: y, button: 0, detail: 1,
    target: new FakeElement(), preventDefault() {}, stopPropagation() {},
  });
  down(event(100, 50));
  move(event(110, 50));
  click(event(110, 50));
  assert.equal(recognized.length, 0);
  down(event(100, 50));
  move(event(120, 50));
  move(event(100, 50));
  click(event(100, 50));
  assert.equal(recognized.length, 0);
  down(event(100, 50));
  click(event(103, 52));
  assert.equal(recognized.length, 1);
  down(event(100, 50));
  click(event(106, 50));
  assert.equal(recognized.length, 1);
});

test("focus capture leaves keyboard activation and outside-stage controls alone", () => {
  let prevented = 0;
  class FakeElement {
    closest() { return null; }
  }
  const env = {
    Element: FakeElement,
    focusSessionRef: { current: {} },
    focusPointerRef: { current: null },
    recognizeCanvasFocusPoint: () => assert.fail("Unexpected image recognition"),
    setGroupDragging: () => {},
  };
  const click = stageHandler("onClickCapture", env);
  const down = stageHandler("onPointerDownCapture", env);
  const event = {
    pointerId: 1, clientX: 0, clientY: 0, button: 0, detail: 0,
    target: new FakeElement(), preventDefault() { prevented++; }, stopPropagation() {},
  };
  click(event);
  down(event);
  click({ ...event, detail: 1 });
  assert.equal(prevented, 0);
});
