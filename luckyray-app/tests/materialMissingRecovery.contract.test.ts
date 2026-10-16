import assert from "node:assert/strict";
import test from "node:test";

import {
  attachMaterialMissingScanTriggers,
  closeCurrentConfirmDialog,
  createMaterialMissingScanCoordinator,
  notifyMaterialMissingCount,
  recoverMissingMaterialAsset,
  replaceCurrentConfirmDialog,
  resolveMaterialPathAction,
  runMaterialRelocationWithConfirmation,
} from "../src/features/materials/materialMissingRecovery.ts";
import {
  performMaterialExternalActionWithTransport,
} from "../src/core/services/materials.ts";
import {
  getMaterialCatalogErrorCode,
  MATERIAL_CATALOG_ERROR_PREFIX,
  MaterialCatalogError,
  SOURCE_RELOCATE_CONTENT_MISMATCH_CODE,
  toMaterialCatalogError,
} from "../src/core/services/materialCatalog.ts";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("material relocate errors preserve a stable code and typed confirmation hash", () => {
  const encoded = `${MATERIAL_CATALOG_ERROR_PREFIX}${JSON.stringify({
    code: SOURCE_RELOCATE_CONTENT_MISMATCH_CODE,
    message: "localized text may change",
    details: { actualContentHash: "a".repeat(64) },
  })}`;

  const error = toMaterialCatalogError(encoded);

  assert.equal(getMaterialCatalogErrorCode(error), SOURCE_RELOCATE_CONTENT_MISMATCH_CODE);
  assert.deepEqual(error.details, { actualContentHash: "a".repeat(64) });
});

test("source relocation mismatch cancellation keeps the first selected target unchanged", async () => {
  const calls: Array<{ id: string; path: string; allow?: boolean }> = [];
  const confirmedHash = "b".repeat(64);
  const result = await runMaterialRelocationWithConfirmation({
    assetId: "source-a",
    selectPath: async () => "C:/selected-source.png",
    relocate: async (id, path, options) => {
      calls.push({ id, path, allow: options?.allowSourceContentChange });
      throw new MaterialCatalogError(
        SOURCE_RELOCATE_CONTENT_MISMATCH_CODE,
        "localized mismatch",
        { actualContentHash: confirmedHash },
      );
    },
    confirmSourceContentChange: async (actualHash) => {
      assert.equal(actualHash, confirmedHash);
      return false;
    },
  });

  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, [{ id: "source-a", path: "C:/selected-source.png", allow: undefined }]);
});

test("source relocation confirmation Escape cancels once while the positive action never calls onCancel", async () => {
  const mismatchHash = "e".repeat(64);
  const relocationCalls: Array<{ allow?: boolean }> = [];
  const confirmationReady = deferred<void>();
  let cancelCalls = 0;
  let clearCalls = 0;
  let busy = true;
  const closeOrder: string[] = [];
  const dialogRef: {
    current: { onCancel?: () => void; confirm?: () => void } | null;
  } = { current: null };

  const flow = runMaterialRelocationWithConfirmation({
    assetId: "source-escape",
    selectPath: async () => "C:/edited-source.png",
    relocate: async (_id, _path, options) => {
      relocationCalls.push({ allow: options?.allowSourceContentChange });
      throw new MaterialCatalogError(
        SOURCE_RELOCATE_CONTENT_MISMATCH_CODE,
        "localized mismatch",
        { actualContentHash: mismatchHash },
      );
    },
    confirmSourceContentChange: () => new Promise<boolean>((resolve) => {
      dialogRef.current = {
        onCancel: () => {
          cancelCalls += 1;
          closeOrder.push("cancel");
          resolve(false);
        },
      };
      confirmationReady.resolve();
    }),
  }).finally(() => {
    busy = false;
  });

  await confirmationReady.promise;
  assert.equal(busy, true);
  assert.equal(closeCurrentConfirmDialog(dialogRef, () => {
    clearCalls += 1;
    closeOrder.push("clear");
  }, "cancel"), true);
  assert.equal(closeCurrentConfirmDialog(dialogRef, () => { clearCalls += 1; }, "cancel"), false);
  assert.equal((await flow).status, "cancelled");
  assert.deepEqual(relocationCalls, [{ allow: undefined }]);
  assert.equal(cancelCalls, 1);
  assert.equal(clearCalls, 1);
  assert.deepEqual(closeOrder, ["cancel", "clear"]);
  assert.equal(busy, false);

  let positiveCancelCalls = 0;
  let positiveConfirmCalls = 0;
  dialogRef.current = {
    onCancel: () => { positiveCancelCalls += 1; },
    confirm: () => { positiveConfirmCalls += 1; },
  };
  const confirmedDialog = closeCurrentConfirmDialog(dialogRef, () => { clearCalls += 1; }, "action");
  assert.ok(confirmedDialog);
  if (confirmedDialog) confirmedDialog.confirm?.();
  assert.equal(positiveConfirmCalls, 1);
  assert.equal(positiveCancelCalls, 0);
});

test("replacing a source relocation confirmation cancels its flow before the next dialog acts", async () => {
  const mismatchHash = "f".repeat(64);
  const confirmationReady = deferred<void>();
  const relocationCalls: Array<{ allow?: boolean }> = [];
  let sourceCancelCalls = 0;
  let deleteActionCalls = 0;
  let busy = true;
  type Dialog = { kind: "source" | "delete"; onCancel?: () => void; action?: () => void };
  const dialogRef: { current: Dialog | null } = { current: null };
  let renderedDialog: Dialog | null = null;
  const installDialog = (dialog: Dialog) => { renderedDialog = dialog; };

  const flow = runMaterialRelocationWithConfirmation({
    assetId: "source-replaced",
    selectPath: async () => "C:/edited-source.png",
    relocate: async (_id, _path, options) => {
      relocationCalls.push({ allow: options?.allowSourceContentChange });
      throw new MaterialCatalogError(
        SOURCE_RELOCATE_CONTENT_MISMATCH_CODE,
        "localized mismatch",
        { actualContentHash: mismatchHash },
      );
    },
    confirmSourceContentChange: () => new Promise<boolean>((resolve) => {
      replaceCurrentConfirmDialog(dialogRef, installDialog, {
        kind: "source",
        onCancel: () => {
          sourceCancelCalls += 1;
          resolve(false);
        },
      });
      confirmationReady.resolve();
    }),
  }).finally(() => {
    busy = false;
  });

  await confirmationReady.promise;
  const deleteDialog: Dialog = {
    kind: "delete",
    action: () => { deleteActionCalls += 1; },
  };
  replaceCurrentConfirmDialog(dialogRef, installDialog, deleteDialog);

  assert.equal(dialogRef.current, deleteDialog);
  assert.equal(renderedDialog, deleteDialog);
  assert.equal(sourceCancelCalls, 1);
  assert.equal((await flow).status, "cancelled");
  assert.deepEqual(relocationCalls, [{ allow: undefined }]);
  assert.equal(busy, false);

  const claimedDialog = closeCurrentConfirmDialog(dialogRef, () => { renderedDialog = null; }, "action");
  assert.equal(claimedDialog, deleteDialog);
  if (claimedDialog) claimedDialog.action?.();
  assert.equal(deleteActionCalls, 1);
  assert.equal(sourceCancelCalls, 1);
});

test("same-tick confirm replacements cancel every superseded dialog once and keep the latest", () => {
  type Dialog = { id: "a" | "b" | "c"; onCancel?: () => void };
  const dialogRef: { current: Dialog | null } = { current: null };
  const installed: Dialog[] = [];
  const cancelled: string[] = [];
  const a: Dialog = { id: "a", onCancel: () => { cancelled.push("a"); } };
  const b: Dialog = { id: "b", onCancel: () => { cancelled.push("b"); } };
  const c: Dialog = { id: "c", onCancel: () => { cancelled.push("c"); } };

  replaceCurrentConfirmDialog(dialogRef, (dialog) => { installed.push(dialog); }, a);
  replaceCurrentConfirmDialog(dialogRef, (dialog) => { installed.push(dialog); }, b);
  replaceCurrentConfirmDialog(dialogRef, (dialog) => { installed.push(dialog); }, c);
  const sameIdentity = replaceCurrentConfirmDialog(dialogRef, (dialog) => { installed.push(dialog); }, c);

  assert.deepEqual(cancelled, ["a", "b"]);
  assert.deepEqual(installed, [a, b, c]);
  assert.equal(dialogRef.current, c);
  assert.deepEqual(sameIdentity, { installed: false });
});

test("a throwing superseded onCancel is collected without blocking the next confirm", () => {
  const cancelError = new Error("cancel failed after settling");
  let previousSettled = false;
  const previous = {
    onCancel: () => {
      previousSettled = true;
      throw cancelError;
    },
  };
  const next = {};
  const dialogRef: { current: typeof previous | typeof next | null } = { current: previous };
  let rendered: typeof previous | typeof next | null = previous;

  const result = replaceCurrentConfirmDialog(dialogRef, (dialog) => { rendered = dialog; }, next);

  assert.equal(previousSettled, true);
  assert.equal(dialogRef.current, next);
  assert.equal(rendered, next);
  assert.deepEqual(result, { installed: true, cancelError });
});

test("material relocation succeeds directly or cancels before calling the adapter", async () => {
  const updated = { id: "asset-a", libraryPath: "C:/same-content.png" };
  const direct = await runMaterialRelocationWithConfirmation({
    assetId: "asset-a",
    selectPath: async () => "C:/same-content.png",
    relocate: async (_id, _path, options) => {
      assert.equal(options, undefined);
      return updated;
    },
    confirmSourceContentChange: async () => assert.fail("matching content must not confirm"),
  });
  assert.equal(direct.status, "succeeded");
  assert.equal(direct.status === "succeeded" && direct.asset, updated);

  const cancelled = await runMaterialRelocationWithConfirmation({
    assetId: "asset-a",
    selectPath: async () => null,
    relocate: async () => assert.fail("cancel must not relocate"),
    confirmSourceContentChange: async () => assert.fail("cancel must not confirm"),
  });
  assert.equal(cancelled.status, "cancelled");
});

test("source relocation mismatch confirms once and retries the same path with its hash token", async () => {
  const confirmedHash = "c".repeat(64);
  const calls: Array<{ path: string; options?: { allowSourceContentChange?: boolean; expectedSourceContentHash?: string } }> = [];
  const updated = { id: "source-a", libraryPath: "C:/edited-source.png" };
  const result = await runMaterialRelocationWithConfirmation({
    assetId: "source-a",
    selectPath: async () => "C:/edited-source.png",
    relocate: async (_id, path, options) => {
      calls.push({ path, options });
      if (!options?.allowSourceContentChange) {
        throw new MaterialCatalogError(
          SOURCE_RELOCATE_CONTENT_MISMATCH_CODE,
          "localized mismatch",
          { actualContentHash: confirmedHash },
        );
      }
      return updated;
    },
    confirmSourceContentChange: async () => true,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.status === "succeeded" && result.asset, updated);
  assert.deepEqual(calls, [
    { path: "C:/edited-source.png", options: undefined },
    {
      path: "C:/edited-source.png",
      options: {
        allowSourceContentChange: true,
        expectedSourceContentHash: confirmedHash,
      },
    },
  ]);
});

test("source relocation override failure is final and does not loop confirmation", async () => {
  const confirmedHash = "d".repeat(64);
  const overrideError = new MaterialCatalogError("physical-path-owned", "target became occupied");
  let confirmations = 0;
  let attempts = 0;
  const result = await runMaterialRelocationWithConfirmation({
    assetId: "source-a",
    selectPath: async () => "C:/selected-source.png",
    relocate: async (_id, _path, options) => {
      attempts += 1;
      if (!options?.allowSourceContentChange) {
        throw new MaterialCatalogError(
          SOURCE_RELOCATE_CONTENT_MISMATCH_CODE,
          "localized mismatch",
          { actualContentHash: confirmedHash },
        );
      }
      throw overrideError;
    },
    confirmSourceContentChange: async () => {
      confirmations += 1;
      return true;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.error, overrideError);
  assert.equal(confirmations, 1);
  assert.equal(attempts, 2);
});

test("managed content mismatch never enters the source confirmation flow", async () => {
  const managedError = new MaterialCatalogError("physical-content-mismatch", "wrong managed file");
  let confirmations = 0;
  let attempts = 0;
  const result = await runMaterialRelocationWithConfirmation({
    assetId: "managed-a",
    selectPath: async () => "C:/wrong-managed.png",
    relocate: async () => {
      attempts += 1;
      throw managedError;
    },
    confirmSourceContentChange: async () => {
      confirmations += 1;
      return true;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.error, managedError);
  assert.equal(confirmations, 0);
  assert.equal(attempts, 1);
});

test("initial focus visible and data-change triggers are wired and cleaned up", () => {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  let visibility: "visible" | "hidden" = "visible";
  const reasons: string[] = [];
  const detach = attachMaterialMissingScanTriggers({
    windowTarget,
    documentTarget,
    getVisibilityState: () => visibility,
    schedule: (reason) => reasons.push(reason),
  });

  windowTarget.dispatchEvent(new Event("focus"));
  visibility = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  visibility = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  windowTarget.dispatchEvent(new Event("luckyray:materials-data-changed"));

  assert.deepEqual(reasons, ["initial", "focus", "visibility", "data-change"]);
  detach();
  windowTarget.dispatchEvent(new Event("focus"));
  assert.deepEqual(reasons, ["initial", "focus", "visibility", "data-change"]);
});

test("scan coordinator runs one scan at a time and drains only the latest queued request", async () => {
  const scans: Array<ReturnType<typeof deferred<string[]>>> = [];
  const applied: string[][] = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = createMaterialMissingScanCoordinator<string>({
    debounceMs: 0,
    scan: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const pending = deferred<string[]>();
      scans.push(pending);
      try {
        return await pending.promise;
      } finally {
        active -= 1;
      }
    },
    onResult: (items) => applied.push(items),
    onError: () => assert.fail("unexpected scan error"),
  });

  coordinator.schedule("focus", 0);
  await sleep(0);
  assert.equal(scans.length, 1);
  coordinator.schedule("visibility", 0);
  const manual = Promise.all([coordinator.scanNow(), coordinator.scanNow()]);
  coordinator.schedule("data-change", 0);
  await sleep(0);
  assert.equal(scans.length, 1);

  scans[0].resolve(["stale"]);
  await sleep(0);
  assert.equal(scans.length, 2);
  assert.deepEqual(applied, []);

  scans[1].resolve(["latest"]);
  await manual;
  assert.deepEqual(applied, [["latest"]]);
  assert.equal(maxActive, 1);

  coordinator.dispose();
});

test("a stale rejected scan drains the queued latest request and reports only the latest error", async () => {
  const scans: Array<ReturnType<typeof deferred<string[]>>> = [];
  const errors: unknown[] = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = createMaterialMissingScanCoordinator<string>({
    debounceMs: 0,
    scan: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const pending = deferred<string[]>();
      scans.push(pending);
      try {
        return await pending.promise;
      } finally {
        active -= 1;
      }
    },
    onResult: () => assert.fail("unexpected scan result"),
    onError: (error) => errors.push(error),
  });

  coordinator.schedule("focus", 0);
  await sleep(0);
  const manual = coordinator.scanNow();
  const staleError = new Error("stale failure");
  scans[0].reject(staleError);
  await sleep(0);
  assert.equal(scans.length, 2);
  assert.deepEqual(errors, []);

  const latestError = new Error("latest failure");
  scans[1].reject(latestError);
  await manual;
  assert.deepEqual(errors, [latestError]);
  assert.equal(maxActive, 1);
  coordinator.dispose();
});

test("manual scan waits when a later scheduled generation supersedes it", async () => {
  const scans: Array<ReturnType<typeof deferred<string[]>>> = [];
  const applied: string[][] = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = createMaterialMissingScanCoordinator<string>({
    debounceMs: 0,
    scan: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const pending = deferred<string[]>();
      scans.push(pending);
      try {
        return await pending.promise;
      } finally {
        active -= 1;
      }
    },
    onResult: (items) => applied.push(items),
    onError: () => assert.fail("unexpected scan error"),
  });

  let manualSettled = false;
  const manual = coordinator.scanNow().then(() => { manualSettled = true; });
  await sleep(0);
  coordinator.schedule("focus", 0);
  await sleep(0);
  scans[0].resolve(["manual-stale"]);
  await sleep(0);
  assert.equal(scans.length, 2);
  assert.equal(manualSettled, false);
  assert.deepEqual(applied, []);

  scans[1].resolve(["focus-latest"]);
  await manual;
  assert.equal(manualSettled, true);
  assert.deepEqual(applied, [["focus-latest"]]);
  assert.equal(maxActive, 1);
  coordinator.dispose();
});

test("dispose cancels queued work suppresses callbacks and releases every manual waiter", async () => {
  const scans: Array<ReturnType<typeof deferred<string[]>>> = [];
  const applied: string[][] = [];
  const errors: unknown[] = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = createMaterialMissingScanCoordinator<string>({
    debounceMs: 0,
    scan: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const pending = deferred<string[]>();
      scans.push(pending);
      try {
        return await pending.promise;
      } finally {
        active -= 1;
      }
    },
    onResult: (items) => applied.push(items),
    onError: (error) => errors.push(error),
  });

  const firstManual = coordinator.scanNow();
  await sleep(0);
  const secondManual = coordinator.scanNow();
  coordinator.schedule("focus", 10);
  coordinator.dispose();
  await Promise.all([firstManual, secondManual]);
  assert.equal(scans.length, 1);

  scans[0].resolve(["after-dispose"]);
  await sleep(15);
  coordinator.schedule("data-change", 0);
  await sleep(0);
  assert.equal(scans.length, 1);
  assert.deepEqual(applied, []);
  assert.deepEqual(errors, []);
  assert.equal(maxActive, 1);
});

test("debounce coalesces requests before scanning and preserves single-flight", async () => {
  const scans: Array<ReturnType<typeof deferred<string[]>>> = [];
  const applied: string[][] = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = createMaterialMissingScanCoordinator<string>({
    debounceMs: 12,
    scan: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const pending = deferred<string[]>();
      scans.push(pending);
      try {
        return await pending.promise;
      } finally {
        active -= 1;
      }
    },
    onResult: (items) => applied.push(items),
    onError: () => assert.fail("unexpected scan error"),
  });

  coordinator.schedule("focus");
  coordinator.schedule("visibility");
  coordinator.schedule("data-change");
  await sleep(5);
  assert.equal(scans.length, 0);
  await sleep(15);
  assert.equal(scans.length, 1);
  scans[0].resolve(["coalesced"]);
  await sleep(0);
  assert.deepEqual(applied, [["coalesced"]]);
  assert.equal(maxActive, 1);
  coordinator.dispose();
});

test("scan failure reports diagnostics without replacing the last known list", async () => {
  const known = ["known-missing"];
  let current = known;
  let reported: unknown;
  const coordinator = createMaterialMissingScanCoordinator<string>({
    debounceMs: 0,
    scan: async () => { throw new Error("scan unavailable"); },
    onResult: (items) => { current = items; },
    onError: (error) => { reported = error; },
  });

  await coordinator.scanNow();

  assert.equal(current, known);
  assert.match(String(reported), /scan unavailable/);
  coordinator.dispose();
});

test("missing count publishes both nonzero and zero", () => {
  const counts: number[] = [];
  notifyMaterialMissingCount((count) => counts.push(count), 4);
  notifyMaterialMissingCount((count) => counts.push(count), 0);
  assert.deepEqual(counts, [4, 0]);
});

test("missing relocation changes state only after a canonical success", async () => {
  const list = [{ id: "asset-a", name: "A", libraryPath: "C:/missing-a.png" }];
  const cancelled = await recoverMissingMaterialAsset({
    item: list[0],
    list,
    selectPath: async () => null,
    relocate: async () => assert.fail("cancel must not relocate"),
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.list, list);

  const failure = new Error("occupied");
  const failed = await recoverMissingMaterialAsset({
    item: list[0],
    list,
    selectPath: async () => "C:/occupied.png",
    relocate: async () => { throw failure; },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.list, list);
  assert.equal(failed.error, failure);

  const updated = { id: "asset-a", libraryPath: "C:/restored.png" };
  const succeeded = await recoverMissingMaterialAsset({
    item: list[0],
    list,
    selectPath: async () => "C:/restored.png",
    relocate: async () => updated,
  });
  assert.equal(succeeded.status, "succeeded");
  assert.deepEqual(succeeded.list, []);
  assert.equal(succeeded.asset, updated);
});

test("open and reveal send only material identity to the native boundary and failures are classified", async () => {
  const calls: unknown[] = [];
  const transport = async (command: string, args: Record<string, unknown>) => { calls.push([command, args]); };
  assert.equal(await performMaterialExternalActionWithTransport("asset-a", "open", transport), true);
  assert.equal(await performMaterialExternalActionWithTransport("asset-a", "reveal", transport), true);
  assert.deepEqual(calls, [
    ["material_catalog_shell_action", { request: { assetId: "asset-a", action: "open" } }],
    ["material_catalog_shell_action", { request: { assetId: "asset-a", action: "reveal" } }],
  ]);
  await assert.rejects(performMaterialExternalActionWithTransport("asset-a", "reveal", async () => { throw new Error("native resolve failed"); }), /native resolve failed/);

  let scans = 0;
  const missing = await resolveMaterialPathAction({
    assetId: "asset-a",
    attempt: async () => false,
    scanMissing: async () => {
      scans += 1;
      return [{ id: "asset-a", name: "A", libraryPath: "C:/missing.png" }];
    },
  });
  assert.equal(missing.status, "missing");
  assert.equal(scans, 1);

  const failed = await resolveMaterialPathAction({
    assetId: "asset-b",
    attempt: async () => false,
    scanMissing: async () => [],
  });
  assert.equal(failed.status, "failed");

  const scanFailed = await resolveMaterialPathAction({
    assetId: "asset-c",
    attempt: async () => false,
    scanMissing: async () => { throw new Error("scan failed"); },
  });
  assert.equal(scanFailed.status, "failed");
  assert.equal(scanFailed.scanFailed, true);
});
