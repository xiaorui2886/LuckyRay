import assert from "node:assert/strict";
import test from "node:test";

import { createSerialAttachmentInserts } from "../src/features/notes/editor/serialAttachmentInserts.ts";
import { readableAttachmentReference } from "../src/features/notes/editor/attachmentReferenceLabel.ts";

test("two fast inserts publish and commit in order, and a failure never poisons the queue", async () => {
  const enqueue = createSerialAttachmentInserts();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = enqueue(() => true, async (queued) => {
    assert.equal(queued, false);
    events.push("first:publish");
    await firstGate;
    events.push("first:commit");
  });
  const second = enqueue(() => true, async (queued) => {
    assert.equal(queued, true);
    events.push("second:publish");
    events.push("second:commit");
  });
  await Promise.resolve();
  assert.deepEqual(events, ["first:publish"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:publish", "first:commit", "second:publish", "second:commit"]);

  await assert.rejects(enqueue(() => true, async () => { throw new Error("publish failed"); }), /publish failed/);
  await enqueue(() => true, async () => { events.push("after failure"); });
  assert.equal(events[events.length - 1], "after failure");
});

test("a queued operation rejects on source switch before copying or writing", async () => {
  const enqueue = createSerialAttachmentInserts();
  let source = "vault-a";
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = enqueue(() => source === "vault-a", async () => { await firstGate; });
  await Promise.resolve();
  let attempted = false;
  const second = enqueue(() => source === "vault-a", async () => { attempted = true; });
  source = "vault-b";
  releaseFirst();
  await first;
  await assert.rejects(second, /知识库或笔记已切换/);
  assert.equal(attempted, false);
});

test("long and encoded references expose a readable label without changing the target", () => {
  const target = "file:///C:/Knowledge/%E6%B5%8B%E8%AF%95%20Vault/%E5%9B%BE%E5%83%8F%20(1).png";
  assert.deepEqual(readableAttachmentReference(target), {
    name: "图像 (1).png",
    directory: "C:/Knowledge/测试 Vault",
  });
  assert.deepEqual(readableAttachmentReference("assets\\2026\\same.png", "图库预览.png"), {
    name: "图库预览.png",
    directory: "assets/2026",
  });
  assert.equal(target, "file:///C:/Knowledge/%E6%B5%8B%E8%AF%95%20Vault/%E5%9B%BE%E5%83%8F%20(1).png");
});
