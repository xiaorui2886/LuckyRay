import test from "node:test";
import assert from "node:assert/strict";
import { planReferenceReorder } from "../src/core/canvas/referenceReorder.ts";
import {
  createCanvasReferencePlan,
  canvasReferenceSnapshots,
  type ReferenceEntry,
} from "../src/core/canvas/referencePlan.ts";
const entry = (
  key: string,
  role: ReferenceEntry["role"] = "reference",
  source: ReferenceEntry["source"] = "connected",
): ReferenceEntry => ({
  key,
  source,
  role,
  reference: { id: key, label: key, kind: "image", role, mediaUrl: `/${key}` },
  ...(source === "connected"
    ? { edgeId: key, sourceNodeId: key }
    : { storedIndex: 0 }),
});

test("same-role native drag moves across connected/stored boundaries without changing role", () => {
  const entries = [entry("a"), entry("b", "reference", "stored"), entry("c")];
  const before = structuredClone(entries),
    plan = planReferenceReorder(entries, "a", "c")!;
  assert.deepEqual(plan.order, ["b", "c", "a"]);
  assert.equal(plan.roles.size, 0);
  assert.deepEqual(entries, before);
  assert.deepEqual(planReferenceReorder(entries, "c", "a")!.order, [
    "c",
    "a",
    "b",
  ]);
});
test("first/last frame drag swaps semantic roles for mixed storage in either direction", () => {
  const entries = [
    entry("first", "firstFrame"),
    entry("last", "lastFrame", "stored"),
    entry("other"),
  ];
  for (const [from, to] of [
    ["first", "last"],
    ["last", "first"],
  ]) {
    const plan = planReferenceReorder(entries, from, to)!;
    assert.deepEqual(plan.order, ["last", "first", "other"]);
    assert.equal(plan.roles.get("first"), "lastFrame");
    assert.equal(plan.roles.get("last"), "firstFrame");
    assert.equal(plan.roles.size, 2);
  }
});
test("drag planner refuses self, stale endpoints and all unrelated-role crossings", () => {
  const entries = [
    entry("first", "firstFrame"),
    entry("last", "lastFrame"),
    entry("ordinary"),
    entry("text", "promptContext"),
    entry("generic", "generic"),
    entry("video", "videoReference"),
  ];
  for (const row of entries) {
    assert.equal(planReferenceReorder(entries, row.key, row.key), null);
    assert.equal(planReferenceReorder(entries, row.key, "gone"), null);
  }
  assert.equal(planReferenceReorder(entries, "gone", "ordinary"), null);
  for (const from of entries)
    for (const to of entries) {
      if (
        from.role === to.role ||
        [from.role, to.role].every(
          (role) => role === "firstFrame" || role === "lastFrame",
        )
      )
        continue;
      assert.equal(
        planReferenceReorder(entries, from.key, to.key),
        null,
        `${from.role} -> ${to.role}`,
      );
    }
});
test("same-role reorder leaves context and other semantic groups in place", () => {
  const entries = [
    entry("first", "firstFrame"),
    entry("a"),
    entry("b"),
    entry("text", "promptContext"),
  ];
  assert.deepEqual(planReferenceReorder(entries, "b", "a")!.order, [
    "first",
    "b",
    "a",
    "text",
  ]);
});
test("reordered canonical plan is exactly the next immutable reference sequence", () => {
  const inputs = [
    {
      edgeId: "edge",
      sourceNodeId: "a",
      role: "reference" as const,
      reference: { id: "a", label: "A", kind: "image", mediaUrl: "/a" },
    },
  ];
  const stored = [
    {
      id: "b",
      label: "B",
      kind: "image",
      role: "reference" as const,
      mediaUrl: "/b",
    },
  ];
  const old = createCanvasReferencePlan("image", inputs, stored),
    oldSnapshot = canvasReferenceSnapshots(old),
    plan = planReferenceReorder(old, old[1].key, old[0].key)!;
  const next = createCanvasReferencePlan(
    "image",
    inputs,
    stored,
    undefined,
    plan.order,
  );
  assert.deepEqual(
    next.map((entry) => entry.key),
    plan.order,
  );
  assert.deepEqual(
    canvasReferenceSnapshots(next).map((ref) => ref.id),
    ["b", "a"],
  );
  assert.deepEqual(
    oldSnapshot.map((ref) => ref.id),
    ["a", "b"],
  );
});
