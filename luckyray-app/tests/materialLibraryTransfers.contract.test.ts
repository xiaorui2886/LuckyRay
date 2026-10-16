import assert from "node:assert/strict";
import test from "node:test";
import { MaterialLibraryTransfers, type MaterialTransferTask } from "../src/core/services/materialLibraryTransfers.ts";

const task = (taskId: string, sourceLibraryId = "A", phase = "running"): MaterialTransferTask => ({ taskId, sourceLibraryId, phase, kind: "copy", targetLibraryId: "B", sourceName: "源库", targetName: "目标库", currentFile: null, currentBytes: 0, currentTotalBytes: 0, total: 1, completed: 0, copied: 0, skipped: 0, failed: 0, items: [], error: null, outputPath: null, retryable: phase !== "completed" });
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("start freezes owner/target/selected IDs before later UI changes and deduplicates only the same request", async () => {
  const result = deferred<MaterialTransferTask>(); const calls: unknown[] = [];
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>, libraryId: string) => { calls.push([structuredClone(action), libraryId]); return await result.promise as T; });
  const action = { op: "transferCopy", targetLibraryId: "B", selection: { assetIds: ["original"] } };
  const first = service.start("A", action, "same");
  assert.equal(service.start("A", action, "same"), first);
  action.targetLibraryId = "C"; action.selection.assetIds[0] = "changed";
  await assert.rejects(service.start("A", action, "same"), /另一请求/);
  assert.deepEqual(calls, [[{ op: "transferCopy", targetLibraryId: "B", selection: { assetIds: ["original"] }, requestId: "same" }, "A"]]);
  result.resolve(task("same")); await first;
  assert.equal(service.getSnapshot().tasks[0].targetLibraryId, "B");
});

test("late poll and list responses cannot undo a cancel ACK or a newer retry", async () => {
  const poll = deferred<MaterialTransferTask>(); const list = deferred<MaterialTransferTask[]>(); const calls: [string, string][] = [];
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>, libraryId: string) => {
    calls.push([String(action.op), libraryId]);
    if (action.op === "transferList") return await list.promise as T;
    if (action.op === "transferStatus") return await poll.promise as T;
    return task("one", "A", action.op === "transferCancel" ? "cancelled" : "running") as T;
  });
  await service.start("A", { op: "transferCopy" }, "one");
  const refresh = service.refresh(); const load = service.load("A");
  await service.cancel(service.getSnapshot().tasks[0]);
  poll.resolve(task("one")); list.resolve([task("one")]); await Promise.all([refresh, load]);
  assert.equal(service.getSnapshot().tasks[0].phase, "cancelled");
  await service.retry(service.getSnapshot().tasks[0]);
  assert.equal(service.getSnapshot().tasks[0].phase, "running");
  assert.ok(calls.every(([, id]) => id === "A"));
});

test("poll keeps stable task ordering and preserves another task's transport error", async () => {
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>, libraryId: string) => {
    if (action.op === "transferStatus" && action.taskId === "two") throw new Error("second connection lost");
    return task(String(action.requestId ?? action.taskId), libraryId) as T;
  });
  await service.start("A", { op: "transferCopy" }, "one"); await service.start("B", { op: "transferCopy" }, "two");
  await service.refresh();
  assert.deepEqual(service.getSnapshot().tasks.map(t => t.taskId), ["two", "one"]);
  assert.match(service.getSnapshot().error!, /second connection lost/);
});

test("native responses with foreign owner or request IDs never enter the visible tasks", async () => {
  const service = new MaterialLibraryTransfers(async <T,>() => task("wrong", "foreign") as T);
  await assert.rejects(service.start("A", { op: "transferCopy" }, "one"), /身份不匹配/);
  assert.deepEqual(service.getSnapshot().tasks, []);
});

test("switching to 20 completed tasks retains A's running and retryable tasks and their owner", async () => {
  const calls: [string, string][] = [];
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>, owner: string) => {
    calls.push([String(action.op), owner]);
    if (action.op === "transferList") return Array.from({ length: 20 }, (_, i) => task(`history-${i}`, owner, "completed")) as T;
    return task(String(action.requestId ?? action.taskId), owner, action.op === "transferCancel" ? "cancelled" : "running") as T;
  });
  await service.start("A", { op: "transferCopy" }, "live-A");
  await service.start("A", { op: "transferCopy" }, "retry-A");
  await service.cancel(service.getSnapshot().tasks.find(t => t.taskId === "retry-A")!);
  await service.load("B");
  assert.equal(service.getSnapshot().tasks.filter(t => t.phase === "completed").length, 16);
  assert.deepEqual(service.getSnapshot().tasks.filter(t => t.phase !== "completed").map(t => t.taskId), ["retry-A", "live-A"]);
  await service.refresh();
  await service.cancel(service.getSnapshot().tasks.find(t => t.taskId === "live-A")!);
  await service.retry(service.getSnapshot().tasks.find(t => t.taskId === "retry-A")!);
  assert.deepEqual(calls, [["transferCopy", "A"], ["transferCopy", "A"], ["transferCancel", "A"], ["transferList", "B"], ["transferStatus", "A"], ["transferCancel", "A"], ["transferRetry", "A"]]);
});

test("late list and status reads cannot resurrect a task after a newer completed ACK", async () => {
  for (const first of ["list", "poll"]) {
    const poll = deferred<MaterialTransferTask>(); const list = deferred<MaterialTransferTask[]>();
    const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>) => {
      if (action.op === "transferList") return await list.promise as T;
      if (action.op === "transferStatus") return await poll.promise as T;
      return task("one") as T;
    });
    await service.start("A", { op: "transferCopy" }, "one");
    const loading = service.load("A"); const refreshing = service.refresh();
    if (first === "list") { list.resolve([task("one", "A", "completed")]); await loading; poll.resolve(task("one")); }
    else { poll.resolve(task("one", "A", "completed")); await refreshing; list.resolve([task("one")]); }
    await Promise.all([loading, refreshing]);
    assert.equal(service.getSnapshot().tasks[0].phase, "completed", first);
  }
});

test("a superseded library list preserves unresolved owners without replacing current completed history", async () => {
  const old = deferred<MaterialTransferTask[]>();
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>, owner: string) => owner === "A" ? await old.promise as T : Array.from({ length: 16 }, (_, i) => task(`B-${i}`, "B", "completed")) as T);
  const loading = service.load("A"); await service.load("B");
  old.resolve([task("A-recover", "A", "interrupted"), ...Array.from({ length: 16 }, (_, i) => task(`A-${i}`, "A", "completed"))]); await loading;
  assert.equal(service.getSnapshot().tasks.find(t => t.taskId === "A-recover")?.phase, "interrupted");
  assert.deepEqual(service.getSnapshot().tasks.filter(t => t.phase === "completed").map(t => t.taskId), Array.from({ length: 16 }, (_, i) => `B-${i}`));
});

test("restart loads another owner's unresolved tasks without admitting its completed history", async () => {
  const calls: unknown[] = [];
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>, owner: string) => {
    calls.push([action, owner]);
    return owner === "B" ? [task("B-history", "B", "completed")] as T : [task("offline-A", "A", "interrupted"), task("A-history", "A", "completed")] as T;
  });
  await service.load("B"); await service.load("A", true);
  assert.deepEqual(service.getSnapshot().tasks.map(t => t.taskId), ["offline-A", "B-history"]);
  assert.deepEqual(calls[1], [{ op: "transferList", unresolvedOnly: true }, "A"]);
});

test("partial retry refreshes the frozen target again even when the retry completes before React renders", async () => {
  const notifications: [string, string, string | null][] = []; let phase = "partial";
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>) => {
    if (action.op === "transferList") return [task("one", "A", phase)] as T;
    return task("one", "A", phase) as T;
  }, committed => { notifications.push([committed.taskId, committed.phase, committed.targetLibraryId]); });
  await service.start("A", { op: "transferCopy" }, "one"); await service.load("A");
  assert.equal(notifications.length, 1);
  await service.retry(service.getSnapshot().tasks[0]);
  phase = "completed"; await service.retry(service.getSnapshot().tasks[0]); await service.load("A");
  assert.deepEqual(notifications, [["one", "partial", "B"], ["one", "partial", "B"], ["one", "completed", "B"]]);
});

test("a list issued while cancel is pending cannot displace its eventual ACK", async () => {
  const cancel = deferred<MaterialTransferTask>();
  const service = new MaterialLibraryTransfers(async <T,>(action: Record<string, unknown>) => {
    if (action.op === "transferCancel") return await cancel.promise as T;
    if (action.op === "transferList") return [task("one")] as T;
    return task("one") as T;
  });
  await service.start("A", { op: "transferCopy" }, "one");
  const cancelling = service.cancel(service.getSnapshot().tasks[0]); await service.load("A");
  cancel.resolve(task("one", "A", "cancelled")); await cancelling;
  assert.equal(service.getSnapshot().tasks[0].phase, "cancelled");
});
