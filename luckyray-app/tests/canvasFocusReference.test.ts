import test from "node:test";
import assert from "node:assert/strict";
import { applyFocusReference, resolvePinnedFocusReference, type FocusReferenceNode, type FocusReferenceEdge } from "../src/core/canvas/focusReference.ts";
import { encodeReferenceMention, encodeFocusReferenceMention, parseReferenceMentions, ReferenceMentionError } from "../src/core/canvas/referenceMentions.ts";
import { normalizeCanvasEdgeSemantics } from "../src/core/canvas/edgeSemantics.ts";
import { createCanvasReferencePlan } from "../src/core/canvas/referencePlan.ts";
const image = (id = "source"): FocusReferenceNode => ({ id, data: { kind: "image", label: "Image", refMediaUrl: "/first.png", refThumbnailUrl: "/first-thumb.png", resultMediaItems: [{ url: "/first.png", thumbnailUrl: "/first-thumb.png" }, { url: "/second.png", thumbnailUrl: "/second-thumb.png" }] } });
const target = (): FocusReferenceNode => ({ id: "target", data: { kind: "generator", generationKind: "image", generationPrompt: "Keep this" } });
const input = (nodes = [image(), target()], edges: FocusReferenceEdge[] = []) => ({ nodes, edges, targetId: "target", sourceNodeId: "source", sourceMediaUrl: "/first.png", phrase: "猫", point: { x: .2, y: .3 }, newEdgeId: "focus-edge" });

test("focus transaction creates exact pinned reference and canonical token without mutating input", () => {
  const request = input(); const before = structuredClone(request);
  const output = applyFocusReference(request);
  assert.deepEqual(request, before); assert.equal(output.createdEdge, true);
  assert.equal(output.edges[0].data?.referenceMediaUrl, "/first.png");
  assert.equal(output.edges[0].data?.role, "reference");
  assert.equal(output.nodes[1].data.generationPrompt, `Keep this ${encodeFocusReferenceMention("focus-edge", { label: "猫", x: .2, y: .3 })}`);
  assert.deepEqual(output.nodes[1].data.generationInputOrder, ["focus-edge"]);
});

test("repeated focus reuses and pins matching edge; another result adds independent image edge", () => {
  const edges: FocusReferenceEdge[] = [{ id: "old", source: "source", target: "target", data: { role: "reference", order: 0 } }];
  const first = applyFocusReference(input(undefined, edges));
  assert.equal(first.createdEdge, false); assert.equal(first.edgeId, "old");
  const second = applyFocusReference({ ...input(first.nodes, first.edges), newEdgeId: "unused", phrase: "狗" });
  assert.equal(second.edges.length, 1);
  const third = applyFocusReference({ ...input(second.nodes, second.edges), sourceMediaUrl: "/second.png", newEdgeId: "second" });
  assert.equal(third.edges.length, 2); assert.deepEqual(third.nodes[1].data.generationInputOrder, ["old", "second"]);
  assert.deepEqual(parseReferenceMentions(third.nodes[1].data.generationPrompt!).filter(p => p.type === "reference").map(p => p.key), ["old", "old", "second"]);
  assert.deepEqual(normalizeCanvasEdgeSemantics(third.nodes, third.edges).map(e => e.data.referenceMediaUrl), ["/first.png", "/second.png"]);
});

test("pin resolves live exact result and rejects removed media instead of drifting to primary", () => {
  const source = image();
  const base = { id: "asset", kind: "image", label: "Image", mediaUrl: "/first.png" };
  const pinned = resolvePinnedFocusReference(source, base, "/second.png");
  assert.equal(pinned.mediaUrl, "/second.png"); assert.equal(pinned.thumbnailUrl, "/second-thumb.png");
  source.data.resultMediaItems = [{ url: "/first.png" }];
  const missing = resolvePinnedFocusReference(source, base, "/second.png");
  assert.equal(missing.issue, "missing-media"); assert.equal(missing.mediaUrl, undefined);
});

test("stored exact image migrates tokens and order while same-source other media stays distinct", () => {
  const t = target();
  t.data.generationPrompt = `${encodeReferenceMention("stored-one")} + ${encodeReferenceMention("stored-two")}`;
  t.data.generationInputOrder = ["stored-two", "stored-one"];
  t.data.generationReferences = [
    { id: "node:source", sourceNodeId: "source", mentionKey: "stored-one", label: "one", kind: "image", mediaUrl: "/first.png", role: "reference" },
    { id: "node:source", sourceNodeId: "source", mentionKey: "stored-two", label: "two", kind: "image", mediaUrl: "/second.png", role: "reference" },
  ];
  const result = applyFocusReference(input([image(), t]));
  const updated = result.nodes[1].data;
  assert.equal(updated.generationReferences?.length, 1); assert.equal(updated.generationReferences?.[0].mentionKey, "stored-two");
  assert.deepEqual(updated.generationInputOrder, ["stored-two", "focus-edge"]);
  assert.deepEqual(parseReferenceMentions(updated.generationPrompt!).filter(p => p.type === "reference").map(p => p.key), ["focus-edge", "stored-two", "focus-edge"]);
  const plan = createCanvasReferencePlan("image", [{ edgeId: "focus-edge", sourceNodeId: "source", role: "reference", reference: { id: "node:source", label: "one", kind: "image", mediaUrl: "/first.png" } }], updated.generationReferences!);
  assert.equal(plan.length, 2);
});

test("focus preserves prior edges and implicit order; video targets infer first and last frame", () => {
  const t = target(); t.data.generationKind = "video";
  const e: FocusReferenceEdge = { id: "prior", source: "other", target: "target", data: { role: "firstFrame", order: 4 } };
  const result = applyFocusReference(input([image(), t], [e]));
  assert.equal(result.edges[0], e); assert.equal(result.edges[1].data?.role, "lastFrame");
  assert.deepEqual(result.nodes[1].data.generationInputOrder, ["prior", "focus-edge"]);
});

test("focus rejects text, resource target, absent media, self edge and ID collisions atomically", () => {
  for (const kind of ["text", "image"] as const) {
    const t = target(); t.data.kind = kind;
    assert.throws(() => applyFocusReference(input([image(), t])), ReferenceMentionError);
  }
  assert.throws(() => applyFocusReference({ ...input(), sourceMediaUrl: "/foreign.png" }), ReferenceMentionError);
  assert.throws(() => applyFocusReference({ ...input(), sourceNodeId: "target" }), ReferenceMentionError);
  assert.throws(() => applyFocusReference({ ...input(), point: { x: 2, y: 0 } }), ReferenceMentionError);
  assert.throws(() => applyFocusReference(input(undefined, [{ id: "focus-edge", source: "other", target: "other" }])), ReferenceMentionError);
});

test("non-primary focus without its own thumbnail uses exact image, never primary thumbnail", () => {
  const source = image();
  source.data.resultMediaUrl = "/first.png";
  source.data.resultThumbnailUrl = "/first-result-thumb.png";
  source.data.resultMediaItems = [{ url: "/first.png" }, { url: "/second.png" }];
  const ref = resolvePinnedFocusReference(source, { id: "source", kind: "image", label: "Image", thumbnailUrl: "/first-thumb.png" }, "/second.png");
  assert.equal(ref.mediaUrl, "/second.png");
  assert.equal(ref.thumbnailUrl, "/second.png");
});

test("stale stored identity is retained instead of rebound to a newly focused image", () => {
  const t = target();
  t.data.generationPrompt = encodeReferenceMention("old-stored");
  t.data.generationReferences = [{ id: "node:source", sourceNodeId: "source", mentionKey: "old-stored", kind: "image", label: "Old", mediaUrl: "/old.png", role: "reference" }];
  const result = applyFocusReference(input([image(), t]));
  assert.deepEqual(result.nodes[1].data.generationReferences, t.data.generationReferences);
  assert.deepEqual(parseReferenceMentions(result.nodes[1].data.generationPrompt!).filter(p => p.type === "reference").map(p => p.key), ["old-stored", "focus-edge"]);
});

test("video focus reserves stored frame roles and migrates same-image frame without duplication", () => {
  const t = target(); t.data.generationKind = "video";
  t.data.generationReferences = [{ id: "other", kind: "image", label: "First", mediaUrl: "/other.png", role: "firstFrame" }];
  const result = applyFocusReference(input([image(), t]));
  assert.equal(result.edges[0].data?.role, "lastFrame");
  assert.deepEqual(result.nodes[1].data.generationReferences, t.data.generationReferences);
  t.data.generationReferences.push({ id: "last", kind: "image", label: "Last", mediaUrl: "/last.png", role: "lastFrame" });
  assert.equal(applyFocusReference(input([image(), t])).edges[0].data?.role, "reference");
  t.data.generationReferences = [{ id: "node:source", sourceNodeId: "source", mentionKey: "stored-frame", kind: "image", label: "First", mediaUrl: "/first.png", role: "firstFrame" }];
  t.data.generationPrompt = encodeReferenceMention("stored-frame");
  const migrated = applyFocusReference(input([image(), t]));
  assert.equal(migrated.edges[0].data?.role, "firstFrame");
  assert.deepEqual(migrated.nodes[1].data.generationReferences, []);
  assert.deepEqual(parseReferenceMentions(migrated.nodes[1].data.generationPrompt!).filter(p => p.type === "reference").map(p => p.key), ["focus-edge", "focus-edge"]);
});
