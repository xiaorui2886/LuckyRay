import test from "node:test";
import assert from "node:assert/strict";
import { captureWorkflow, instantiateWorkflow, WorkflowError } from "../src/core/canvas/workflowTemplates.ts";
import { encodeFocusReferenceMention, encodeReferenceMention, parseReferenceMentions } from "../src/core/canvas/referenceMentions.ts";
const nodes = [
  { id: "source", position: { x: 0, y: 0 }, data: { kind: "image" as const, label: "Image", payload: "asset-source" } },
  { id: "target", position: { x: 100, y: 0 }, data: { kind: "generator" as const, label: "Output", generationKind: "image" as const, generationPrompt: `Use ${encodeReferenceMention("old-edge")} twice ${encodeReferenceMention("old-edge")}` } },
];
const edges = [{ id: "old-edge", source: "source", target: "target", data: { role: "reference" as const, order: 0 } }];
test("portable workflows rewrite edge mentions on export and again on instantiate", () => {
  const { template } = captureWorkflow(nodes, edges, ["source", "target"], "Mentions");
  const prompt = template.nodes.find(n => n.kind === "generator")!.prompt!;
  assert.ok(!prompt.includes("old-edge"));
  assert.equal(parseReferenceMentions(prompt).filter(p => p.type === "reference")[0].key, "workflow-edge:n1:n2");
  let next = 0;
  const inserted = instantiateWorkflow(JSON.parse(JSON.stringify(template)), { x: 0, y: 0 }, () => `new-${++next}`);
  const actual = inserted.nodes.find(n => n.id === inserted.edges[0].target)!;
  const mentions = parseReferenceMentions(String(actual.data.generationPrompt)).filter(p => p.type === "reference");
  assert.deepEqual(mentions.map(p => p.key), [inserted.edges[0].id, inserted.edges[0].id]);
});
test("portable workflows refuse omitted and dangling mention identities", () => {
  assert.throws(() => captureWorkflow(nodes, edges, ["target"], "Missing"), (e: unknown) => e instanceof WorkflowError && e.code === "stored-references");
  const { template } = captureWorkflow(nodes, edges, ["source", "target"], "Valid");
  template.nodes.find(n => n.kind === "generator")!.prompt = encodeReferenceMention("workflow-edge:unknown:n2");
  let next = 0;
  assert.throws(() => instantiateWorkflow(template, { x: 0, y: 0 }, () => `new-${++next}`), (e: unknown) => e instanceof WorkflowError && e.code === "stored-references");
});
test("portable workflows map persistent stored mention keys only to matching internal sources", () => {
  const storedNodes = nodes.map(n => n.id !== "target" ? n : ({ ...n, data: { ...n.data, generationPrompt: encodeReferenceMention("stable-stored"), generationReferences: [{ id: "node:source", mentionKey: "stable-stored", kind: "image", role: "reference" }] } }));
  const { template } = captureWorkflow(storedNodes, edges, ["source", "target"], "Stored");
  assert.equal(template.nodes.find(n => n.kind === "generator")!.prompt, encodeReferenceMention("workflow-edge:n1:n2"));
});

test("workflow export retains target drag order and mention identity across two images", () => {
  const graphNodes = [
    nodes[0],
    { ...nodes[0], id: "second", data: { ...nodes[0].data, payload: "second-image" } },
    { ...nodes[1], data: { ...nodes[1].data, generationInputOrder: ["second-edge", "old-edge"] } },
  ];
  const graphEdges = [...edges, { id: "second-edge", source: "second", target: "target", data: { role: "reference" as const, order: 1 } }];
  const { template } = captureWorkflow(graphNodes, graphEdges, ["source", "second", "target"], "Ordered");
  assert.deepEqual(template.edges.map(edge => edge.order), [1, 0]);
  let id = 0;
  const inserted = instantiateWorkflow(template, { x: 0, y: 0 }, () => `drag-${++id}`);
  const ordered = [...inserted.edges].sort((a, b) => a.data.order - b.data.order);
  assert.equal(ordered[0].source, inserted.nodes[1].id);
  assert.equal(ordered[1].source, inserted.nodes[0].id);
  const prompt = String(inserted.nodes.find(node => node.id === ordered[1].target)!.data.generationPrompt);
  assert.deepEqual(parseReferenceMentions(prompt).filter(part => part.type === "reference").map(part => part.key), [ordered[1].id, ordered[1].id]);
});

 test("focus object metadata survives workflow export and insertion with fresh edge identity", () => {
  const focus = { label: '猫 "蓝"', x: 0.2, y: 0.7 };
  const focused = nodes.map(n => n.id === "target" ? { ...n, data: { ...n.data, generationPrompt: encodeFocusReferenceMention("old-edge", focus) } } : n);
  const { template } = captureWorkflow(focused, edges, ["source", "target"], "Focus");
  let next = 0;
  const inserted = instantiateWorkflow(JSON.parse(JSON.stringify(template)), { x: 0, y: 0 }, () => `focus-${++next}`);
  const actual = inserted.nodes.find(n => n.id === inserted.edges[0].target)!;
  const parts = parseReferenceMentions(String(actual.data.generationPrompt));
  assert.deepEqual(parts, [{ type: "reference", key: inserted.edges[0].id, focus, raw: encodeFocusReferenceMention(inserted.edges[0].id, focus) }]);
 });

 test("portable workflow refuses exact-media focus pins instead of exporting URLs or dropping identity", () => {
  const pinned = edges.map(edge => ({ ...edge, data: { ...edge.data, referenceMediaUrl: "file:///private/second.png" } }));
  assert.throws(() => captureWorkflow(nodes, pinned, ["source", "target"], "Pinned"), (error: unknown) => error instanceof WorkflowError && error.code === "stored-references");
  assert.throws(() => captureWorkflow(nodes, pinned, ["target"], "Pinned external"), (error: unknown) => error instanceof WorkflowError && error.code === "stored-references");
 });
