import test from "node:test";
import { resolvePinnedFocusReference } from "../src/core/canvas/focusReference.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createCanvasReferencePlan, referenceSourceId } from "../src/core/canvas/referencePlan.ts";
import { encodeFocusReferenceMention, encodeReferenceMention, remapReferenceMentions, resolveReferenceMentions, compileMentionedPrompt, validateReferenceMentions } from "../src/core/canvas/referenceMentions.ts";
import { getCanvasNodeCapabilities } from "../src/core/canvas/nodeCapabilities.ts";
import { hasInvalidCanvasReference } from "../src/core/canvas/referenceIdentity.ts";
import { canCancelCanvasGenerationTask, createCanvasGenerationTask } from "../src/core/canvas/generationTasks.ts";
import { compileCanvasGenerationInputs } from "../src/core/canvas/generationInputCompiler.ts";

const require = createRequire(import.meta.url);
const { transformSync } = createRequire(require.resolve("vite"))("esbuild");
const source = readFileSync(new URL("../src/CanvasSpike.tsx", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
function block(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Production callback boundary exists: ${start}`);
  return source.slice(a, b);
}
const code = transformSync([
  block("function inferGenerationKind(", "function resolveTextGenerationPrompt("),
  block("function referenceForCanvasNode(", "function resolveCanvasConnectionData("),
  block("  const getIncomingGenerationInputs = useCallback(", "  const updateIncomingEdgeRole = useCallback("),
  block("  const duplicateNodeById = useCallback(", "  const [materialNameRequest,"),
  block("  const copySelected = useCallback(", "  const duplicateSelected = useCallback("),
].join("\n"), { loader: "ts", target: "es2022" }).code;

function image(id: string, url = `/${id}.png`) {
  return { id, type: "spike", position: { x: 10, y: 20 }, data: { kind: "image", label: id, refMediaUrl: url } };
}
function text(id: string, body = `${id} body`) {
  return { id, type: "spike", position: { x: 80, y: 90 }, data: { kind: "text", label: body } };
}
function generator(id: string, keys: string[] = [], data: any = {}) {
  return { id, type: "spike", position: { x: 400, y: 200 }, selected: true, data: { kind: "generator", generationKind: "image", label: id, generationPrompt: keys.map(encodeReferenceMention).join(" + "), generationInputOrder: keys, ...data } };
}
function edge(id: string, from: string, to: string, role = "reference", order = 0, extra: any = {}) {
  return { id, source: from, target: to, sourceHandle: "s-right", targetHandle: "t-left", data: { role, order, ...extra } };
}
function task(status: string) {
  return { ...createCanvasGenerationTask({ id: "task-original", sourceNodeId: "g", resultNodeId: "g", request: { kind: "image", prompt: "P", model: "model", references: [] }, createdAt: "2026-10-17" }), status };
}
function setup(nodes: any[], edges: any[] = [], selected: string[] = ["g"]) {
  const nodesRef = { current: structuredClone(nodes) }, edgesRef = { current: structuredClone(edges) };
  const clipboardRef = { current: null as any };
  const history: any[] = [];
  let seq = 0, dirty = 0, selectedIds = [...selected];
  const env: any = {
    nodesRef, edgesRef, clipboardRef,
    nodes: nodesRef.current, edges: edgesRef.current, selectedNodeIds: selectedIds,
    locale: "en-US", useCallback: (fn: any) => fn,
    createCanvasReferencePlan, referenceSourceId, remapReferenceMentions, resolvePinnedFocusReference,
    getCanvasNodeCapabilities, hasInvalidCanvasReference, canCancelCanvasGenerationTask,
    TEXT_NODE_PLACEHOLDER_LABELS: new Set(["Double-click to edit..."]),
    genId: () => `clone-${++seq}`, genEdgeId: () => `edge-clone-${++seq}`,
    commitHistory: () => history.push(structuredClone({ nodes: nodesRef.current, edges: edgesRef.current })),
    markDirty: () => dirty++,
    setNodes: (update: any) => { nodesRef.current = typeof update === "function" ? update(nodesRef.current) : update; },
    setEdges: (update: any) => { edgesRef.current = typeof update === "function" ? update(edgesRef.current) : update; },
    setSelectedNodeIds: (ids: string[]) => { selectedIds = ids; },
    setComposerNodeId: () => {}, setInspectorNodeId: () => {}, setNodeContextMenu: () => {},
  };
  function api() {
    env.nodes = nodesRef.current; env.edges = edgesRef.current; env.selectedNodeIds = selectedIds;
    return Function("env", `const {${Object.keys(env).join(",")}}=env;${code};return {duplicateNodeById,copySelected,pasteFromClipboard,getIncomingGenerationInputs,resolveStoredCanvasReferences,inferGenerationKind};`)(env);
  }
  function plan(id: string) {
    const a = api(), node = nodesRef.current.find(n => n.id === id);
    return createCanvasReferencePlan(a.inferGenerationKind(node), a.getIncomingGenerationInputs(id), a.resolveStoredCanvasReferences(node, nodesRef.current), undefined, node.data.generationInputOrder);
  }
  return { env, api, plan, history, get selected() { return selectedIds; }, get dirty() { return dirty; } };
}

test("single-card duplicate clones incoming semantic inputs and remaps tokens without mutating originals", () => {
  const h = setup([image("a"), text("t"), image("ancestor"), generator("g", ["et", "ea"]), text("downstream")], [edge("ea", "a", "g"), edge("et", "t", "g", "promptContext", 1), edge("derive", "ancestor", "g", "generic", 0, { relation: "derivation" }), edge("out", "g", "downstream")]);
  const before = structuredClone({ nodes: h.env.nodesRef.current, edges: h.env.edgesRef.current });
  h.api().duplicateNodeById("g");
  const clone = h.env.nodesRef.current.at(-1), inputs = h.env.edgesRef.current.filter((e: any) => e.target === clone.id);
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map((e: any) => [e.source, e.data.role, e.data.order]), [["a", "reference", 0], ["t", "promptContext", 1]]);
  assert.ok(inputs.every((e: any) => e.id !== "ea" && e.id !== "et"));
  assert.deepEqual(resolveReferenceMentions(clone.data.generationPrompt, h.plan(clone.id)).mentions.map(m => m.entry.sourceNodeId), ["t", "a"]);
  assert.deepEqual(clone.data.generationInputOrder, [inputs.find((e: any) => e.source === "t").id, inputs.find((e: any) => e.source === "a").id]);
  assert.deepEqual(h.env.nodesRef.current.find((n: any) => n.id === "g").data, before.nodes.find(n => n.id === "g")!.data);
  assert.deepEqual(h.env.edgesRef.current.slice(0, before.edges.length), before.edges);
  assert.equal(h.history.length, 1); assert.equal(h.dirty, 1);
  assert.deepEqual(h.history[0], before);
});

test("single-card duplicate keeps stored aliases and source identities distinct from edge aliases", () => {
  const stored = { id: "node:b", sourceNodeId: "b", kind: "image", label: "B", mediaUrl: "/stale.png", role: "reference", mentionKey: "stored-stable-b" };
  const h = setup([image("a"), image("b"), generator("g", ["stored-stable-b", "ea"], { generationReferences: [stored] })], [edge("ea", "a", "g")]);
  h.api().duplicateNodeById("g");
  const clone = h.env.nodesRef.current.at(-1), result = resolveReferenceMentions(clone.data.generationPrompt, h.plan(clone.id));
  assert.deepEqual(result.mentions.map(m => m.entry.reference.mediaUrl), ["/b.png", "/a.png"]);
  assert.equal(result.mentions[0].key, "stored-stable-b");
  assert.equal(clone.data.generationReferences[0].sourceNodeId, "b");
});

for (const status of ["queued", "running"]) {
  test(`single-card duplicate removes ${status} task but preserves source execution identity`, () => {
    const h = setup([generator("g", [], { generationTask: task(status) })]);
    const before = structuredClone(h.env.nodesRef.current[0].data);
    h.api().duplicateNodeById("g");
    assert.equal(h.env.nodesRef.current.at(-1).data.generationTask, undefined);
    assert.deepEqual(h.env.nodesRef.current[0].data, before);
  });
}

test("copy and paste a connected selection remaps edges, aliases, and live internal sources together", () => {
  const h = setup([image("a"), text("t"), generator("g", ["et", "ea"], { generationTask: task("running") })], [edge("ea", "a", "g"), edge("et", "t", "g", "promptContext", 1)], ["a", "t", "g"]);
  const before = structuredClone(h.env.nodesRef.current);
  h.api().copySelected();
  assert.equal(h.dirty, 0); assert.equal(h.history.length, 0);
  h.api().pasteFromClipboard();
  const clones = h.env.nodesRef.current.slice(3), target = clones.find((n: any) => n.data.kind === "generator"), copiedImage = clones.find((n: any) => n.data.kind === "image"), copiedText = clones.find((n: any) => n.data.kind === "text");
  const refs = resolveReferenceMentions(target.data.generationPrompt, h.plan(target.id)).mentions;
  assert.deepEqual(refs.map(m => m.entry.sourceNodeId), [copiedText.id, copiedImage.id]);
  assert.equal(target.data.generationTask, undefined);
  assert.ok(h.env.edgesRef.current.slice(2).every((e: any) => h.selected.includes(e.source) && h.selected.includes(e.target)));
  copiedImage.data = { ...copiedImage.data, refMediaUrl: "/new-internal.png" };
  copiedText.data = { ...copiedText.data, label: "new internal body" };
  const fresh = resolveReferenceMentions(target.data.generationPrompt, h.plan(target.id)).mentions;
  assert.equal(fresh[0].entry.reference.text, "new internal body"); assert.equal(fresh[1].entry.reference.mediaUrl, "/new-internal.png");
  assert.deepEqual(h.env.nodesRef.current.slice(0, 3).map((n: any) => n.data), before.map(n => n.data));
});

test("cross-canvas paste freezes external connected and stored bodies, including same-ID collisions", () => {
  const stored = { id: "node:b", sourceNodeId: "b", kind: "image", label: "B", role: "reference", mediaUrl: "/stale-b.png", mentionKey: "stored-b" };
  const h = setup([image("a"), image("b"), text("t", "Original external text"), generator("g", ["ea", "stored-b", "et"], { generationReferences: [stored] })], [edge("ea", "a", "g"), edge("et", "t", "g", "promptContext", 1)]);
  h.api().copySelected();
  const clip = structuredClone(h.env.clipboardRef.current);
  assert.equal(clip.edges.length, 0); assert.equal(clip.nodes[0].data.generationReferences.length, 3);
  assert.ok(clip.nodes[0].data.generationReferences.every((r: any) => r.id.startsWith("copied:") && !referenceSourceId(r)));
  h.env.nodesRef.current = [image("a", "/wrong-a.png"), image("b", "/wrong-b.png"), text("t", "Wrong destination body")]; h.env.edgesRef.current = [];
  h.api().pasteFromClipboard();
  const pasted = h.env.nodesRef.current.at(-1), result = resolveReferenceMentions(pasted.data.generationPrompt, h.plan(pasted.id));
  assert.deepEqual(result.mentions.map(m => m.entry.reference.mediaUrl || m.entry.reference.text), ["/a.png", "/b.png", "Original external text"]);
  assert.deepEqual(result.mentions.map(m => m.key), ["ea", "stored-b", "et"]);
  assert.equal(h.env.edgesRef.current.length, 0); assert.deepEqual(h.env.clipboardRef.current, clip);
  const compiled = compileMentionedPrompt(pasted.data.generationPrompt, h.plan(pasted.id), { kind: "image" });
  assert.deepEqual(compiled.references.filter(r => r.kind === "image").map(r => r.mediaUrl), ["/a.png", "/b.png"]);
  assert.match(compiled.prompt, /第1张图片/); assert.match(compiled.prompt, /第2张图片/);
  const request = compileCanvasGenerationInputs({ kind: "image", prompt: compiled.prompt, references: compiled.references, referenceAliases: compiled.referenceAliases });
  assert.match(request.prompt, /【@文本1】\nOriginal external text/);
  assert.doesNotMatch(request.prompt, /Wrong destination body|wrong-a|wrong-b|lr-ref:/);
});

test("frozen external note preserves body-only context under its exact compiled text alias", () => {
  const note = { id: "note", position: { x: 0, y: 0 }, data: { kind: "noteRef", label: "Private note title", payload: "note:document", refContextText: "Original note body" } };
  const h = setup([note, generator("g", ["en"])], [edge("en", "note", "g", "promptContext")]);
  h.api().copySelected(); h.env.nodesRef.current = []; h.env.edgesRef.current = []; h.api().pasteFromClipboard();
  const pasted = h.env.nodesRef.current[0], compiled = compileMentionedPrompt(pasted.data.generationPrompt, h.plan(pasted.id), { kind: "image", includeNoteTitles: false });
  const request = compileCanvasGenerationInputs({ kind: "image", prompt: compiled.prompt, references: compiled.references, referenceAliases: compiled.referenceAliases, includeNoteTitles: false });
  assert.match(request.prompt, /【@文本1】\nOriginal note body/);
  assert.doesNotMatch(request.prompt, /Private note title/);
  assert.equal(request.references[0].label, "笔记正文");
});

test("stored internal source-node IDs remap while persisted mention keys remain stable", () => {
  const ref = { id: "node:a:reference", sourceNodeId: "a", role: "reference", kind: "image", label: "A", mediaUrl: "/stale.png", mentionKey: "stable-stored-a" };
  const h = setup([image("a"), generator("g", ["stable-stored-a"], { generationReferences: [ref] })], [], ["a", "g"]);
  h.api().copySelected(); h.api().pasteFromClipboard();
  const imageClone = h.env.nodesRef.current.at(-2), target = h.env.nodesRef.current.at(-1), saved = target.data.generationReferences[0];
  assert.equal(saved.sourceNodeId, imageClone.id); assert.equal(saved.id, `node:${imageClone.id}:reference`); assert.equal(saved.mentionKey, "stable-stored-a");
  const result = resolveReferenceMentions(target.data.generationPrompt, h.plan(target.id));
  assert.equal(result.mentions[0].entry.sourceNodeId, imageClone.id); assert.equal(result.mentions[0].entry.reference.mediaUrl, "/a.png");
});

test("repeated pastes create independent connected identities and never rewrite clipboard aliases", () => {
  const h = setup([image("a"), generator("g", ["ea"], { generationTask: task("queued") })], [edge("ea", "a", "g")], ["a", "g"]);
  h.api().copySelected(); const clip = structuredClone(h.env.clipboardRef.current);
  h.api().pasteFromClipboard(); const first = [...h.selected];
  h.api().pasteFromClipboard(); const second = [...h.selected];
  assert.equal(new Set([...first, ...second]).size, 4);
  for (const ids of [first, second]) {
    const target = h.env.nodesRef.current.find((n: any) => ids.includes(n.id) && n.data.kind === "generator");
    assert.equal(target.data.generationTask, undefined);
    const mention = resolveReferenceMentions(target.data.generationPrompt, h.plan(target.id)).mentions[0];
    assert.ok(ids.includes(mention.entry.sourceNodeId!));
  }
  assert.deepEqual(h.env.clipboardRef.current, clip);
});

test("copying a missing external edge does not turn its invalid token into a valid frozen reference", () => {
  const h = setup([generator("g", ["missing-edge"])], [edge("missing-edge", "gone", "g")]);
  assert.ok(validateReferenceMentions(h.env.nodesRef.current[0].data.generationPrompt, h.plan("g")));
  h.api().copySelected(); h.env.nodesRef.current = []; h.env.edgesRef.current = []; h.api().pasteFromClipboard();
  const pasted = h.env.nodesRef.current[0];
  assert.ok(validateReferenceMentions(pasted.data.generationPrompt, h.plan(pasted.id)), "Missing external reference must remain blocked after copy/paste");
});

test("copying a group preserves membership and remaps only internal graph identities", () => {
  const parent = { id: "group", type: "group", position: { x: 600, y: 500 }, data: { kind: "group", label: "Group" } };
  const a = { ...image("a"), parentId: "group", extent: "parent" }, g = { ...generator("g", ["ea"]), parentId: "group", extent: "parent" };
  const h = setup([parent, a, g], [edge("ea", "a", "g")], ["group"]);
  h.api().copySelected(); h.api().pasteFromClipboard();
  const clones = h.env.nodesRef.current.slice(3), group = clones.find((n: any) => n.type === "group"), target = clones.find((n: any) => n.data.kind === "generator");
  assert.equal(clones.length, 3); assert.deepEqual(group.position, { x: 632, y: 532 });
  for (const child of clones.filter((n: any) => n.id !== group.id)) assert.equal(child.parentId, group.id);
  assert.deepEqual(target.position, g.position); assert.equal(validateReferenceMentions(target.data.generationPrompt, h.plan(target.id)), null);
});

 test("duplicate and group paste retain focus objects while remapping exact image source", () => {
  const focus = { label: "左侧人物", x: 0.15, y: 0.65 };
  const h = setup([image("a"), generator("g", ["ea"], { generationPrompt: encodeFocusReferenceMention("ea", focus) })], [edge("ea", "a", "g")], ["a", "g"]);
  h.api().duplicateNodeById("g");
  const clone = h.env.nodesRef.current.at(-1);
  const duplicate = resolveReferenceMentions(clone.data.generationPrompt, h.plan(clone.id)).mentions[0];
  assert.deepEqual(duplicate.focus, focus); assert.notEqual(duplicate.key, "ea"); assert.equal(duplicate.entry.sourceNodeId, "a");
  const group = setup([image("a"), generator("g", ["ea"], { generationPrompt: encodeFocusReferenceMention("ea", focus) })], [edge("ea", "a", "g")], ["a", "g"]);
  group.api().copySelected(); group.api().pasteFromClipboard();
  const pasted = group.env.nodesRef.current.at(-1);
  const mention = resolveReferenceMentions(pasted.data.generationPrompt, group.plan(pasted.id)).mentions[0];
  assert.deepEqual(mention.focus, focus); assert.notEqual(mention.key, "ea");
  assert.equal(mention.entry.sourceNodeId, group.env.nodesRef.current.at(-2).id);
 });

test("non-primary focused result stays pinned through duplicate, group paste and external snapshot", () => {
  const focus = { label: "第二张猫", x: .2, y: .4 };
  const source = image("a");
  Object.assign(source.data, { resultMediaItems: [{ url: "/a.png" }, { url: "/second.png", thumbnailUrl: "/second-thumb.png" }] });
  const make = (selected: string[]) => setup([source, generator("g", ["ea"], { generationPrompt: encodeFocusReferenceMention("ea", focus) })], [edge("ea", "a", "g", "reference", 0, { referenceMediaUrl: "/second.png" })], selected);
  const h = make(["g"]);
  h.api().duplicateNodeById("g");
  const clone = h.env.nodesRef.current.at(-1);
  assert.equal(resolveReferenceMentions(clone.data.generationPrompt, h.plan(clone.id)).mentions[0].entry.reference.mediaUrl, "/second.png");
  const group = make(["a", "g"]); group.api().copySelected(); group.api().pasteFromClipboard();
  const pasted = group.env.nodesRef.current.at(-1);
  assert.equal(resolveReferenceMentions(pasted.data.generationPrompt, group.plan(pasted.id)).mentions[0].entry.reference.mediaUrl, "/second.png");
  const external = make(["g"]); external.api().copySelected(); external.env.nodesRef.current = []; external.env.edgesRef.current = []; external.api().pasteFromClipboard();
  const frozen = external.env.nodesRef.current[0];
  const mention = resolveReferenceMentions(frozen.data.generationPrompt, external.plan(frozen.id)).mentions[0];
  assert.equal(mention.entry.reference.mediaUrl, "/second.png"); assert.deepEqual(mention.focus, focus);
});
