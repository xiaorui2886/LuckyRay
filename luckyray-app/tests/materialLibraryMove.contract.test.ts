import assert from "node:assert/strict";
import test from "node:test";
import { isMaterialLibraryTransferAction, materialLibraryActions } from "../src/features/materials/materialLibraryActions.ts";
import { MaterialLibraryTransfers, type MaterialTransferTask } from "../src/core/services/materialLibraryTransfers.ts";
import type { MaterialLibrary } from "../src/core/services/materialLibraryContext.ts";

const library = (rootPath: string | null): MaterialLibrary => ({ id: "library-move-0001", name: "移动库", rootPath, storageMode: "managed", state: "ready", visible: true, version: 3, preferences: {} });

test("move action is exposed only for libraries with an independent root", () => {
  const rooted = materialLibraryActions(library("D:/素材库"), "legacy", null).find(action => action.id === "moveLibrary");
  assert.equal(rooted?.group, "transfer");
  assert.equal(rooted?.disabledReason, undefined);
  const legacy = materialLibraryActions(library(null), "legacy", null).find(action => action.id === "moveLibrary");
  assert.equal(legacy?.disabledReason, "默认兼容库未登记独立根目录");
  const offline = materialLibraryActions({ ...library("D:/素材库"), state: "offline" }, "legacy", null);
  assert.equal(offline.find(action => action.id === "moveLibrary")!.disabledReason, "位置不可用");
  assert.ok(isMaterialLibraryTransferAction("moveLibrary"));
  assert.ok(!isMaterialLibraryTransferAction("relocate"));
  const merge = materialLibraryActions(library("D:/素材库"), "legacy", null).find(action => action.id === "mergeLibrary");
  assert.equal(merge?.group, "transfer");
  assert.equal(merge?.disabledReason, undefined);
  assert.ok(isMaterialLibraryTransferAction("mergeLibrary"));
  assert.equal(materialLibraryActions({ ...library(null), state: "offline" }, "legacy", null).find(action => action.id === "mergeLibrary")!.disabledReason, "位置不可用");
});

test("move tasks ride the same transfer ledger protocol as copy tasks", async () => {
  const calls: [Record<string, unknown>, string][] = [];
  const moveTask = (phase: string): MaterialTransferTask => ({ taskId: "move-1", kind: "move", phase, sourceLibraryId: "A", targetLibraryId: "A", sourceName: "设计素材", targetName: "D:/新位置", currentFile: null, currentBytes: 0, currentTotalBytes: 0, total: 2, completed: 0, copied: 0, skipped: 0, failed: 0, items: [], error: null, outputPath: null, retryable: phase !== "completed" });
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>, libraryId: string) => {
    calls.push([structuredClone(action), libraryId]);
    if (action.op === "transferStatus") return moveTask("staging") as T;
    return moveTask("running") as T;
  });
  await service.start("A", { op: "moveLibrary", root: "D:/新位置" }, "move-1");
  assert.deepEqual(calls[0], [{ op: "moveLibrary", root: "D:/新位置", requestId: "move-1" }, "A"]);
  const started = service.getSnapshot().tasks[0];
  assert.equal(started.kind, "move");
  assert.equal(started.sourceLibraryId, "A");
  await service.refresh();
  assert.equal(calls[1][0].op, "transferStatus");
  assert.equal(service.getSnapshot().tasks[0].phase, "staging");
  await service.cancel(service.getSnapshot().tasks[0]);
  assert.deepEqual(calls[2][0], { op: "transferCancel", taskId: "move-1" });
});
