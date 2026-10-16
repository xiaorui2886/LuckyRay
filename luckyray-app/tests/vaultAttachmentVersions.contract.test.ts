import test from "node:test";
import assert from "node:assert/strict";
import { createAttachmentVersionPoller } from "../src/core/services/vaultAttachmentVersions.ts";
test("registered version changes, missing and new paths invalidate once; baseline is quiet", async () => {
  const source = {};
  let versions = [{ path: "a", version: "1" as string | null }];
  const changes: string[][] = [];
  const poller = createAttachmentVersionPoller({
    source,
    current: () => source,
    read: async () => ({ versions }),
    changed: (paths) => changes.push(paths),
  });
  await poller.poll();
  await poller.poll();
  assert.deepEqual(changes, []);
  versions = [
    { path: "a", version: null },
    { path: "b", version: "1" },
  ];
  await poller.poll();
  assert.deepEqual(changes, [["a", "b"]]);
  await poller.poll();
  assert.equal(changes.length, 1);
  versions = [{ path: "a", version: "2" }];
  await poller.poll();
  assert.deepEqual(changes[1], ["a", "b"]);
});
test("inflight reply after source identity change or dispose is ignored", async () => {
  const source = {};
  let current: object = source;
  let resolve!: (value: {
    versions: { path: string; version: string }[];
  }) => void;
  let changed = false;
  const poller = createAttachmentVersionPoller({
    source,
    current: () => current,
    read: () => new Promise((r) => (resolve = r)),
    changed: () => {
      changed = true;
    },
  });
  const flight = poller.poll();
  current = {};
  poller.dispose();
  resolve({ versions: [{ path: "a", version: "2" }] });
  await flight;
  assert.equal(changed, false);
});
